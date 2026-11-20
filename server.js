import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({limit:'30mb'}));
app.use(express.static(path.join(__dirname,'public')));
app.get(['/project/:id','/settings'],(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const configPath = path.join(__dirname,'config.json');
if (!fs.existsSync(configPath)) fs.copyFileSync(path.join(__dirname,'config.example.json'),configPath);
let cfg = JSON.parse(fs.readFileSync(configPath,'utf8'));
// Read a simple .env file without requiring an extra dependency. Existing process env wins.
function loadDotEnv(){
  const envFile=path.join(__dirname,'.env');
  if(!fs.existsSync(envFile))return;
  for(const raw of fs.readFileSync(envFile,'utf8').split(/\r?\n/)){
    const line=raw.trim();if(!line||line.startsWith('#'))continue;
    const m=line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);if(!m)continue;
    let value=m[2].trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    if(process.env[m[1]]===undefined)process.env[m[1]]=value;
  }
}
loadDotEnv();
function selectedProvider(ai={}){
  const env=String(process.env.AI_PROVIDER||'').trim().toLowerCase();
  if(env==='local'||env==='ollama')return 'ollama';
  if(['openrouter','online','remote'].includes(env))return 'openrouter';
  const configured=String(ai.provider||'openrouter').trim().toLowerCase();
  return ['local','ollama'].includes(configured)?'ollama':'openrouter';
}
const mediaRoot=()=>path.resolve(__dirname,process.env.MEDIA_ROOT||cfg.mediaDirectory||'./media');
const mediaExtensions=new Set((cfg.mediaExtensions||['.mp4','.mov','.mkv','.webm']).map(x=>String(x).toLowerCase()));
async function scanMediaLibrary(){
  const root = mediaRoot();
  const items = [];
  const dimensionIndex = loadCatalogDimensions();
  async function walk(dir){let entries;try{entries=await fs.promises.readdir(dir,{withFileTypes:true})}catch{return}
    for(const ent of entries){if(ent.name.startsWith('.'))continue;const full=path.join(dir,ent.name);
      if(ent.isDirectory())await walk(full);
      else if(ent.isFile()&&mediaExtensions.has(path.extname(ent.name).toLowerCase())){
        let seconds=0;try{seconds=await duration(full)}catch{}
        const relative=path.relative(root,full).split(path.sep).join('/');
        const category=relative.split('/')[0]||'default';
        const dimensions = dimensionIndex.get(path.resolve(full)) || {};

        items.push({
          path: full,
          relative,
          filename: ent.name,
          category,
          duration: seconds,
          bytes: (await fs.promises.stat(full)).size,
          width: dimensions.width || 0,
          height: dimensions.height || 0,
          orientation: dimensions.orientation || 'unknown'
        });
      }
    }
  }
  await walk(root);return items;
}

const mediaLibraryPath=()=>path.resolve(__dirname,process.env.MEDIA_LIBRARY_PATH||'./data/media-library.json');

function loadCatalogDimensions() {
  const index = new Map();

  try {
    const file = mediaLibraryPath();
    if (!fs.existsSync(file)) return index;

    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));

    for (const video of catalog.videos || []) {
      const filePath = video?.file?.path;
      if (!filePath) continue;

      const width = Number(video.technical?.width || 0);
      const height = Number(video.technical?.height || 0);

      index.set(path.resolve(filePath), {
        width,
        height,
        orientation: getMediaOrientation({ width, height })
      });
    }
  } catch (error) {
    console.error('Gagal membaca dimensi media catalog:', error.message);
  }

  return index;
}

function getMediaOrientation(item) {
  const width = Number(item?.width || item?.technical?.width || 0);
  const height = Number(item?.height || item?.technical?.height || 0);

  if (!width || !height) return 'unknown';

  const ratio = width / height;

  if (ratio >= 0.95 && ratio <= 1.05) return 'square';

  return height > width ? 'portrait' : 'landscape';
}


function getMediaOrientation(width, height) {
  width = Number(width || 0);
  height = Number(height || 0);

  if (!width || !height) return 'unknown';

  const ratio = width / height;

  if (ratio >= 0.95 && ratio <= 1.05) {
    return 'square';
  }

  return height > width ? 'portrait' : 'landscape';
}


function filterAssetsByOrientation(items, target) {
  const exact = [];
  const square = [];
  const unknown = [];
  const opposite = [];

  for (const item of items) {
    const orientation = item.orientation || getMediaOrientation(item);

    if (orientation === target) exact.push(item);
    else if (orientation === 'square') square.push(item);
    else if (orientation === 'unknown') unknown.push(item);
    else opposite.push(item);
  }

  // Orientasi berlawanan hanya digunakan jika tidak ada
  // stock dengan orientasi target, square, atau unknown.
  const preferred = [...exact, ...square, ...unknown];

  return preferred.length ? preferred : opposite;
}

let completedCatalogCache = {
  key: '',
  assets: []
};


function loadCompletedCatalogAssets() {
  const file = mediaLibraryPath();

  if (!exists(file)) {
    throw Error(`Media Library JSON tidak ditemukan: ${file}. Atur MEDIA_LIBRARY_PATH di .env.`);
  }

  const catalog = readJson(file);

  if (!Array.isArray(catalog.videos)) {
    throw Error('Format media-library.json tidak valid: properti videos harus berupa array.');
  }

  const root = path.resolve(mediaRoot());

  const completed = catalog.videos.filter(video =>
    video?.visual_analysis?.status === 'completed' &&
    video?.file?.path &&
    exists(video.file.path)
  )
  .filter(video =>
    mediaExtensions.has(path.extname(video.file.path).toLowerCase())
  )
  .filter(video => {
    const filePath = path.resolve(video.file.path);
    return filePath === root || filePath.startsWith(root + path.sep);
  });

  // PENTING:
  // Variabel video hanya digunakan di dalam callback map ini.
  // Jangan memindahkan video.technical ke luar callback.
  return completed.map(video => {
    const width = Number(video.technical?.width || 0);
    const height = Number(video.technical?.height || 0);

    return {
      id: String(video.id),
      path: path.resolve(video.file.path),
      relative: path.relative(
        root,
        path.resolve(video.file.path)
      ).split(path.sep).join('/'),

      filename: video.file.name || path.basename(video.file.path),
      category: (
        path.relative(root, path.resolve(video.file.path))
          .split(path.sep)[0] || 'default'
      ),

      duration: Number(video.technical?.duration_seconds || 0),

      width,
      height,
      orientation: getMediaOrientation(width, height),

      title: video.content?.title ||
        video.title ||
        video.file.name ||
        path.basename(video.file.path),

      description: video.content?.description || video.description || '',
      summary: video.content?.summary || '',

      objects: Array.isArray(video.content?.objects)
        ? video.content.objects : [],

      activities: Array.isArray(video.content?.activities)
        ? video.content.activities : [],

      environment: video.content?.environment || '',
      location_type: video.content?.location_type || '',

      mood: Array.isArray(video.content?.mood)
        ? video.content.mood : [],

      tags: Array.isArray(video.content?.tags)
        ? video.content.tags
        : Array.isArray(video.tags) ? video.tags : [],

      keywords: Array.isArray(video.content?.keywords)
        ? video.content.keywords : [],

      categories: Array.isArray(video.content?.categories)
        ? video.content.categories : [],

      story_uses: Array.isArray(video.content?.story_uses)
        ? video.content.story_uses : []
    };
  });
}

function filterAssetsByOrientation(assets, targetOrientation) {
  const exact = [];
  const square = [];
  const unknown = [];
  const opposite = [];

  for (const asset of assets) {
    const orientation = asset.orientation || 'unknown';

    if (orientation === targetOrientation) {
      exact.push(asset);
    } else if (orientation === 'square') {
      square.push(asset);
    } else if (orientation === 'unknown') {
      unknown.push(asset);
    } else {
      opposite.push(asset);
    }
  }

  // Prioritas: orientasi tepat, square, lalu unknown.
  const preferred = [...exact, ...square, ...unknown];

  // Orientasi berlawanan hanya jika tidak ada kandidat
  // dengan orientasi tepat, square, maupun unknown.
  if (preferred.length) {
    return {
      assets: preferred,
      fallback: false,
      exactCount: exact.length,
      squareCount: square.length,
      unknownCount: unknown.length
    };
  }

  return {
    assets: opposite,
    fallback: opposite.length > 0,
    exactCount: 0,
    squareCount: 0,
    unknownCount: 0
  };
}

function englishTokens(value){
  return String(value||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ')
    .split(/\s+/).filter(x=>x.length>2);
}
function rankCatalogCandidates(scene,assets,limit=20){
  const sceneText=[scene.visual,scene.narration,scene.mood,...(scene.searchKeywords||[])].join(' ');
  const tokens=new Set(englishTokens(sceneText));
  return assets.map(asset=>{
    const text=[asset.title,asset.description,asset.summary,asset.filename,asset.relative,
      asset.objects.join(' '),asset.activities.join(' '),asset.environment,asset.location_type,
      asset.mood.join(' '),asset.tags.join(' '),asset.keywords.join(' '),asset.categories.join(' '),asset.story_uses.join(' ')].join(' ');
    const words=new Set(englishTokens(text));
    let score=0;
    for(const token of tokens)if(words.has(token))score++;
    // The complete visual description is more important than a filename-only match.
    const visualTokens=new Set(englishTokens(scene.visual));
    for(const token of visualTokens)if(words.has(token))score+=0.5;
    return {asset,score};
  }).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>x.asset);
}
function parseAIJson(content){
  let text=String(content||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const start=text.indexOf('{'),end=text.lastIndexOf('}');
  if(start>=0&&end>start)text=text.slice(start,end+1);
  return JSON.parse(text);
}
async function callAutoAssignProvider(prompt,provider,model,ai){
  if(provider==='ollama'){
    const base=(cfg.ollama?.url||'http://127.0.0.1:11434').replace(/\/+$/,'');
    const response=await fetch(`${base}/api/chat`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model,stream:false,format:'json',options:{temperature:0.1,num_ctx:8192,num_predict:1200},
        messages:[{role:'system',content:'You are a visual stock-footage matching assistant. Return only valid JSON.'},{role:'user',content:prompt}]}),
      signal:AbortSignal.timeout(180000)
    });
    if(!response.ok)throw Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0,800)}`);
    const data=await response.json();
    if(!data?.message?.content)throw Error('Ollama returned empty content.');
    return data.message.content;
  }
  const apiKey=process.env[ai.apiKeyEnv||'OPENROUTER_API_KEY'];
  if(!apiKey)throw Error(`API key unavailable. Set ${ai.apiKeyEnv||'OPENROUTER_API_KEY'} in the application .env.`);
  const base=(ai.baseUrl||'https://openrouter.ai/api/v1').replace(/\/+$/,'');
  const response=await fetch(`${base}/chat/completions`,{
    method:'POST',headers:{'content-type':'application/json',Authorization:`Bearer ${apiKey}`,
      'HTTP-Referer':'http://localhost:8686','X-Title':'AI Storyboard Studio'},
    body:JSON.stringify({model,temperature:0.1,max_tokens:1200,response_format:{type:'json_object'},
      messages:[{role:'system',content:'You are an expert visual stock-footage matcher. Return only valid JSON.'},{role:'user',content:prompt}]}),
    signal:AbortSignal.timeout(180000)
  });
  const body=await response.text();
  if(!response.ok)throw Error(`OpenRouter HTTP ${response.status}: ${body.slice(0,1000)}`);
  const data=JSON.parse(body),content=data?.choices?.[0]?.message?.content;
  if(!content)throw Error('OpenRouter returned empty content.');
  return content;
}

async function aiAssignMediaToStoryboard(project) {
  const assets = loadCompletedCatalogAssets();

  if (!assets.length) {
    throw Error(
      `Tidak ada video berstatus completed yang valid di ${mediaLibraryPath()}. ` +
      'Periksa MEDIA_ROOT dan file.path pada katalog.'
    );
  }

  const ai = cfg.ai || { provider: 'openrouter' };
  const provider = selectedProvider(ai);

  if (!['openrouter', 'ollama'].includes(provider)) {
    throw Error(`Unsupported AI provider: ${provider}`);
  }

  const models = Array.isArray(ai.models) && ai.models.length
    ? ai.models
    : [ai.model || ''];

  const model = provider === 'ollama'
    ? (
        project.settings?.ollamaModel ||
        cfg.ollama?.model ||
        'llama3:latest'
      )
    : (
        models.includes(project.settings?.aiModel)
          ? project.settings.aiModel
          : (ai.model || models[0])
      );

  if (!model) {
    throw Error('AI model is not configured in config.json.');
  }

  const targetOrientation =
    project.settings?.orientation === 'portrait'
      ? 'portrait'
      : 'landscape';

  const orientationSelection = filterAssetsByOrientation(
    assets,
    targetOrientation
  );

  const orientedAssets = orientationSelection.assets;

  if (!orientedAssets.length) {
    throw Error(
      `Tidak ada kandidat stock untuk orientasi ${targetOrientation}.`
    );
  }

  const used = new Set();
  const missing = [];

  let assigned = 0;
  let reused = 0;

  const storyboard = project.storyboard || [];

  for (let index = 0; index < storyboard.length; index++) {
    const scene = storyboard[index];

    let candidates = [];

    try {
      // Langsung ranking menggunakan metadata scene.
      // Tidak perlu request AI tambahan untuk menerjemahkan scene.
      const ranked = rankCatalogCandidates(
        scene,
        orientedAssets,
        30
      );

      // Hindari penggunaan stock yang sudah dipakai.
      const unused = ranked.filter(asset => !used.has(asset.id));

      // Gunakan ulang hanya jika seluruh kandidat sudah terpakai.
      const available = unused.length ? unused : ranked;

      candidates = available.slice(0, 20);

      if (!candidates.length) {
        throw Error('Tidak ditemukan kandidat stock video.');
      }

      const candidateData = candidates.map(asset => ({
        asset_id: asset.id,
        title: asset.title,
        description: asset.description,
        summary: asset.summary,
        objects: asset.objects,
        activities: asset.activities,
        environment: asset.environment,
        location_type: asset.location_type,
        mood: asset.mood,
        tags: asset.tags,
        keywords: asset.keywords,
        categories: asset.categories,
        story_uses: asset.story_uses,
        filename: asset.filename,
        relative_path: asset.relative,
        width: asset.width,
        height: asset.height,
        orientation: asset.orientation
      }));

      const prompt = `
You are an expert stock-footage matching assistant.

Choose the most visually relevant stock video for the storyboard scene.

TARGET VIDEO ORIENTATION:
${targetOrientation}

ORIENTATION RULES:
- Prefer ${targetOrientation} videos.
- Square and unknown orientation are acceptable fallbacks.
- Opposite orientation candidates are supplied only when no preferred orientation exists.
- Do not reject a visually relevant candidate merely because its filename or folder name looks unrelated.
- Use the actual visual-analysis metadata.
- Do not invent asset IDs.

STORYBOARD SCENE:
${JSON.stringify({
  scene_id: scene.id || String(index + 1),
  narration: scene.narration || '',
  visual: scene.visual || '',
  search_keywords: scene.searchKeywords || [],
  mood: scene.mood || '',
  shot_type: scene.shotType || ''
})}

AVAILABLE COMPLETED STOCK VIDEOS:
${JSON.stringify(candidateData)}

MATCHING PRIORITY:
1. Visual subject and action.
2. Objects and environment.
3. Scene meaning and context.
4. Mood and camera perspective.
5. Orientation compatibility.

Select exactly one asset only if it is genuinely relevant.
If none is suitable, return null.

Return JSON only:
{
  "asset_id": "exact supplied asset_id or null",
  "reason": "brief explanation",
  "confidence": 0.0
}
`;

      const content = await callAutoAssignProvider(
        prompt,
        provider,
        model,
        ai
      );

      const result = parseAIJson(content);

      const chosen = candidates.find(
        asset => asset.id === String(result.asset_id || '')
      );

      const confidence = Number(result.confidence ?? 0);

      if (
        chosen &&
        Number.isFinite(confidence) &&
        confidence >= 0.35
      ) {
        const wasUsed = used.has(chosen.id);

        scene.video = null;
        delete scene.mediaFiles;
        delete scene.mediaPaths;

        scene.mediaPath = chosen.path;
        scene.mediaFile = chosen.relative;
        scene.mediaCategory = chosen.category;
        scene.mediaDuration = chosen.duration;

        scene.assetReady = true;
        scene.assetStatus = 'assigned';

        scene.assetMatchProvider = provider;
        scene.assetMatchModel = model;
        scene.assetMatchConfidence = confidence;

        scene.assetOrientation = chosen.orientation;
        scene.assetDimensions = {
          width: chosen.width,
          height: chosen.height
        };

        scene.assetReason =
          `AI match: ${String(
            result.reason || 'Visually relevant stock footage.'
          ).slice(0, 200)} ` +
          `(orientation: ${chosen.orientation}, ` +
          `${chosen.width}x${chosen.height}` +
          `${wasUsed ? ', stock reused' : ''}).`;

        scene.assetCandidates = [];

        if (wasUsed) {
          reused++;
        }

        used.add(chosen.id);
        assigned++;
      } else {
        scene.video = null;
        delete scene.mediaFiles;
        delete scene.mediaPaths;

        scene.mediaPath = null;
        scene.mediaFile = null;
        scene.assetReady = false;
        scene.assetStatus = 'missing';

        scene.assetReason = String(
          result.reason ||
          'AI found no sufficiently relevant completed stock video.'
        ).slice(0, 300);

        scene.assetCandidates = candidates.slice(0, 5).map(asset => ({
          file: asset.relative,
          title: asset.title,
          orientation: asset.orientation,
          width: asset.width,
          height: asset.height
        }));

        missing.push({
          part: scene.part || index + 1,
          scene: scene.visual || scene.narration || '',
          keywords: scene.searchKeywords || [],
          reason: scene.assetReason,
          candidates: scene.assetCandidates
        });
      }
    } catch (error) {
      scene.video = null;
      delete scene.mediaFiles;
      delete scene.mediaPaths;

      scene.mediaPath = null;
      scene.mediaFile = null;
      scene.assetReady = false;
      scene.assetStatus = 'missing';

      scene.assetReason =
        `AI matching error: ${error.message}`.slice(0, 300);

      scene.assetCandidates = candidates.slice(0, 5).map(asset => ({
        file: asset.relative,
        title: asset.title,
        orientation: asset.orientation
      }));

      missing.push({
        part: scene.part || index + 1,
        scene: scene.visual || scene.narration || '',
        keywords: scene.searchKeywords || [],
        reason: scene.assetReason,
        candidates: scene.assetCandidates
      });
    }

    // Jeda hanya antar request AI, bukan setelah scene terakhir.
    if (index < storyboard.length - 1) {
      await new Promise(resolve =>
        setTimeout(
          resolve,
          Math.max(0, Number(ai.minRequestIntervalMs ?? 500))
        )
      );
    }
  }

  project.assetReport = {
    mediaRoot: mediaRoot(),
    mediaLibrary: mediaLibraryPath(),

    orientation: targetOrientation,

    available: assets.length,
    orientationCandidates: orientedAssets.length,

    orientationBreakdown: {
      portrait: assets.filter(a => a.orientation === 'portrait').length,
      landscape: assets.filter(a => a.orientation === 'landscape').length,
      square: assets.filter(a => a.orientation === 'square').length,
      unknown: assets.filter(a => a.orientation === 'unknown').length
    },

    oppositeOrientationFallback: orientationSelection.fallback,

    assigned,
    reused,
    missingCount: missing.length,
    missing,

    provider,
    model,
    generatedAt: new Date().toISOString()
  };

  return project.assetReport;
}

// const words=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g,' ').split(/[\s-]+/).filter(x=>x.length>2);
// function chooseMediaForScene(part,items,orientation,used){
//   const portrait=orientation==='portrait';
//   const eligible=items.filter(x=>!portrait||/portrait|potrait/i.test(x.category));
//   const pool=eligible.length?eligible:items;
//   const text=[part.visual,part.narration,part.mood,...(Array.isArray(part.searchKeywords)?part.searchKeywords:[])].join(' ');
//   const tokens=[...new Set(words(text))];
//   const categoryHints={band:['band','music','musician','guitar','drum','stage','concert','perform'],protest:['protest','demonstration','crowd','march','activist'],car:['car','vehicle','road','drive','traffic'],crowded:['crowd','people','city'],demonstration:['protest','demonstration','march','crowd']};
//   const scored=pool.map(item=>{
//     const hay=words(`${item.category} ${item.filename} ${item.relative}`).join(' ');
//     let score=tokens.reduce((n,t)=>n+(hay.includes(t)?2:0),0);
//     for(const [cat,hints] of Object.entries(categoryHints))if(item.category.toLowerCase().includes(cat)&&hints.some(h=>tokens.includes(h)))score+=5;
//     if(/default|band/i.test(item.category)&&/(band|music|guitar|drum|stage|concert|perform|sing)/.test(text.toLowerCase()))score+=6;
//     if(portrait&&/portrait|potrait/i.test(item.category))score+=8;
//     if(!portrait&&!/portrait|potrait/i.test(item.category))score+=1;
//     if(used.has(item.path))score-=1000;
//     return {item,score};
//   }).sort((a,b)=>b.score-a.score);
//   let best=scored.find(x=>!used.has(x.item.path)&&x.score>=2);
//   let reused=false;
//   if(!best){
//     // Reuse a relevant clip only after the unused pool is exhausted.
//     const reusable=pool.map(item=>{const hay=words(`${item.category} ${item.filename} ${item.relative}`).join(' ');let score=tokens.reduce((n,t)=>n+(hay.includes(t)?2:0),0);if(/default|band/i.test(item.category)&&/(band|music|guitar|drum|stage|concert|perform|sing)/.test(text.toLowerCase()))score+=6;if(portrait&&/portrait|potrait/i.test(item.category))score+=8;return {item,score};}).sort((a,b)=>b.score-a.score);
//     if(reusable[0]?.score>=2){best=reusable[0];reused=true;}
//   }
//   // A zero/weak semantic score is deliberately not auto-filled with an unrelated clip.
//   if(!best)return {status:'missing',reason:portrait&&!eligible.length?'Tidak ada stock kategori portrait/potrait.':'Tidak ditemukan stock yang cukup relevan di media library.',candidates:scored.slice(0,3).map(x=>({file:x.item.relative,score:x.score}))};
//   used.add(best.item.path);
//   return {status:'assigned',item:best.item,score:best.score,reused};
// }
// function assignMediaToStoryboard(p,items){
//   const used=new Set(),orientation=p.settings?.orientation||'landscape',missing=[];
//   for(const part of p.storyboard||[]){
//     const match=chooseMediaForScene(part,items,orientation,used);
//     if(match.status==='assigned'){
//       part.video=null;delete part.mediaFiles;delete part.mediaPaths;part.mediaPath=match.item.path;part.mediaFile=match.item.relative;part.mediaCategory=match.item.category;
//       part.mediaDuration=match.item.duration;part.assetReady=true;part.assetStatus='assigned';part.assetMatchScore=match.score;part.assetReason=match.reused?'Stock relevan digunakan ulang karena klip unik sudah habis.':'Dipilih otomatis dari stock video.';
//     }else{
//       part.video=null;delete part.mediaFiles;delete part.mediaPaths;part.mediaPath=null;part.mediaFile=null;part.assetReady=false;part.assetStatus='missing';part.assetReason=match.reason;part.assetCandidates=match.candidates;missing.push({part:part.part,scene:part.visual||part.narration||'',keywords:part.searchKeywords||[],reason:match.reason,candidates:match.candidates});
//     }
//   }
//   p.assetReport={mediaRoot:mediaRoot(),orientation,available:items.length,assigned:(p.storyboard||[]).length-missing.length,missingCount:missing.length,missing,generatedAt:new Date().toISOString()};
//   return p.assetReport;
// }
const STOP = new Set('the and for with from that this into over under dari yang dan untuk dengan pada ini itu ada saat seperti video footage clip stock shot scene'.split(' '));

// Terjemahan kata Indonesia yang sering muncul ke bahasa nama file stock (Inggris).
const ID_EN = {
  jalan:'road', mobil:'car', motor:'motorcycle', kota:'city', malam:'night', hujan:'rain', laut:'sea',
  pantai:'beach', gunung:'mountain', orang:'people', kerumunan:'crowd', massa:'crowd', demo:'protest',
  panggung:'stage', gitar:'guitar', langit:'sky', api:'fire', hutan:'forest', sungai:'river',
  senja:'sunset', fajar:'sunrise', musik:'music', penyanyi:'singer', lampu:'light', awan:'cloud',
  kereta:'train', sedih:'sad', sendiri:'lonely', jendela:'window', asap:'smoke', gedung:'building'
};

// Kelompok sinonim: kata dalam satu kelompok dianggap berkaitan (bobot setengah).
const GROUPS_RAW = [
  ['band','music','musician','guitar','drum','stage','concert','perform','sing','singer','vocal'],
  ['protest','demonstration','march','crowd','activist','rally','people'],
  ['car','vehicle','drive','road','traffic','highway','motorcycle'],
  ['city','urban','street','building','skyline'],
  ['night','neon','dark','light'],
  ['nature','forest','tree','mountain','field','river','landscape'],
  ['sea','ocean','beach','wave','water'],
  ['sad','lonely','cry','rain','window'],
  ['sunset','sunrise','sky','golden','cloud'],
  ['fire','smoke','flame','explosion']
];

// "cars"->"car", "crowded"->"crowd", "driving"/"drive"->"driv"
const stem = t => t.length > 3 ? t.replace(/(ing|ed|es|s)$/, '').replace(/e$/, '') : t;
const tok = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').split(' ')
  .filter(x => x.length > 2 && !STOP.has(x) && !/^\d+$/.test(x))
  .map(x => stem(ID_EN[x] || x));

const GROUPS = GROUPS_RAW.map(g => g.map(stem));
const groupsOf = new Map();
GROUPS.forEach((g, i) => g.forEach(w => groupsOf.set(w, [...(groupsOf.get(w) || []), i])));

const isPortraitCat = c => /portrait|potrait/i.test(c);
const MIN_SCORE = 5;       // satu kata kunci cocok di nama folder (3x2=6) sudah lolos; satu kata lemah tidak
const NEAR_BEST = 0.6;     // kandidat dalam 60% skor terbaik ikut diundi, supaya hasil bervariasi

// Token per klip: folder (termasuk subfolder) dan nama file dipisah karena bobotnya beda.


// Bobot kata dari adegan: searchKeywords 3, visual 2, narration/mood 1, sinonim setengahnya.
function sceneWeights(part) {
  const w = new Map();
  const add = (list, weight) => { for (const t of list) w.set(t, Math.max(w.get(t) || 0, weight)); };
  add(tok((Array.isArray(part.searchKeywords) ? part.searchKeywords : []).join(' ')), 3);
  add(tok(part.visual), 2);
  add([...tok(part.narration), ...tok(part.mood)], 1);
  for (const [t, weight] of [...w.entries()])
    for (const gi of groupsOf.get(t) || [])
      for (const m of GROUPS[gi]) if (!w.has(m)) w.set(m, weight * 0.5);
  return w;
}

// Kecocokan kata utuh (Set), bukan substring. Setiap kata hanya dihitung sekali.
const tokCache = new WeakMap();

function itemTok(item) {
  let c=tokCache.get(item);

  if(!c){
    const parts=String(item.relative||'').split('/');
    const file=parts.pop();

    const metadata=tok([
      item.title,
      item.description,
      item.summary,
      ...(Array.isArray(item.objects)?item.objects:[item.objects]),
      ...(Array.isArray(item.activities)?item.activities:[item.activities]),
      item.environment,
      item.location_type,
      ...(Array.isArray(item.mood)?item.mood:[item.mood]),
      ...(Array.isArray(item.tags)?item.tags:[item.tags]),
      ...(Array.isArray(item.keywords)?item.keywords:[item.keywords]),
      ...(Array.isArray(item.categories)?item.categories:[item.categories]),
      ...(Array.isArray(item.story_uses)?item.story_uses:[item.story_uses])
    ].filter(Boolean).join(' '));

    c={
      folder:new Set(tok(parts.join(' '))),
      file:new Set(tok(path.parse(file).name)),
      metadata:new Set(metadata)
    };

    tokCache.set(item,c);
  }

  return c;
}

function scoreItem(item,sceneW,sceneOrientation='auto'){
  const {folder,file,metadata}=itemTok(item);

  let score=0;
  const matched=[];

  for(const [t,w] of sceneW){
    let s=0;

    if(metadata.has(t))s+=w*2.5;
    if(folder.has(t))s+=w*2;
    if(file.has(t))s+=w*1.5;

    if(s){
      score+=s;
      matched.push(t);
    }
  }

  const wanted=String(sceneOrientation||'auto').toLowerCase();
  const actual=item.orientation||'unknown';

  if(['portrait','portrait'].includes(wanted)){
    if(actual==='portrait')score+=100;
    else if(actual==='landscape')score-=100;
  }else if(['landscape'].includes(wanted)){
    if(actual==='landscape')score+=100;
    else if(actual==='portrait')score-=100;
  }

  return {item,score,matched};
}

function pickWeighted(list) {
  let r = Math.random() * list.reduce((n, x) => n + x.score, 0);
  for (const x of list) { r -= x.score; if (r <= 0) return x; }
  return list[list.length - 1];
}


function chooseMediaForScene(part, items, orientation, used, ctx = {}) {
  const target = orientation === 'portrait' ? 'portrait' : 'landscape';

  const preferred = items.filter(item => {
    const actual = item.orientation || getMediaOrientation(item);
    return actual === target || actual === 'square' || actual === 'unknown';
  });

  const opposite = items.filter(item => {
    const actual = item.orientation || getMediaOrientation(item);
    return actual !== target && actual !== 'square' && actual !== 'unknown';
  });

  const sceneW = sceneWeights(part);

  let pool = preferred.length ? preferred : opposite;
  let scored = pool
    .map(item => scoreItem(item, sceneW))
    .sort((a, b) => b.score - a.score);

  let relevant = scored.filter(x => x.score >= MIN_SCORE);
  let usedOppositeOrientation = false;

  // Jika kandidat dengan orientasi yang diutamakan tidak relevan,
  // baru coba stock dengan orientasi berlawanan.
  if (!relevant.length && preferred.length && opposite.length) {
    pool = opposite;
    scored = pool
      .map(item => scoreItem(item, sceneW))
      .sort((a, b) => b.score - a.score);

    relevant = scored.filter(x => x.score >= MIN_SCORE);
    usedOppositeOrientation = relevant.length > 0;
  }

  if (!relevant.length) {
    return {
      status: 'missing',
      reason: `Tidak ditemukan stock yang cukup relevan untuk orientasi ${target}.`,
      candidates: scored.slice(0, 3).map(x => ({
        file: x.item.relative,
        score: Number(x.score.toFixed(1)),
        orientation: x.item.orientation || getMediaOrientation(x.item)
      }))
    };
  }

  // Utamakan klip yang belum dipakai.
  const unused = relevant.filter(x => !used.has(x.item.path));
  const reused = unused.length === 0;

  let cands = unused;

  if (reused) {
    const minUses = Math.min(
      ...relevant.map(x => used.get(x.item.path) || 0)
    );

    cands = relevant.filter(
      x => (used.get(x.item.path) || 0) === minUses
    );
  }

  // Pertahankan variasi kategori seperti mekanisme sebelumnya.
  const top = Math.max(...cands.map(x => x.score));

  cands = cands.filter(x => x.score >= top * NEAR_BEST);

  const different = cands.filter(
    x => x.item.category !== ctx.lastCategory
  );

  if (different.length) cands = different;

  const best = pickWeighted(cands);
  const actualOrientation =
    best.item.orientation || getMediaOrientation(best.item);

  return {
    status: 'assigned',
    item: best.item,
    score: Number(best.score.toFixed(1)),
    matched: best.matched,
    reused,
    actualOrientation,
    usedOppositeOrientation
  };
}


function assignMediaToStoryboard(p, items) {
  const used = new Map(), orientation = p.settings?.orientation || 'landscape', missing = [];
  let lastCategory = null;
  for (const part of p.storyboard || []) {
    const match = chooseMediaForScene(part, items, orientation, used, { lastCategory });
    if (match.status === 'assigned') {
      part.video = null; delete part.mediaFiles; delete part.mediaPaths;
      part.mediaPath = match.item.path; part.mediaFile = match.item.relative; part.mediaCategory = match.item.category;
      part.mediaDuration = match.item.duration; part.assetReady = true; part.assetStatus = 'assigned';
      part.assetMatchScore = match.score; part.assetMatched = match.matched;
      const actualOrientation =
        match.item.orientation || getMediaOrientation(match.item);

      part.assetReason =
        (match.reused
          ? 'Stock relevan digunakan ulang karena klip unik sudah habis'
          : 'Dipilih otomatis dari stock video') +
        ` (orientasi: ${actualOrientation}, target: ${orientation}` +
        `${match.usedOppositeOrientation ? ', fallback orientasi berbeda' : ''}` +
        `; cocok: ${match.matched.slice(0, 6).join(', ')}).`;
      used.set(match.item.path, (used.get(match.item.path) || 0) + 1);
      lastCategory = match.item.category;
    } else {
      part.video = null; delete part.mediaFiles; delete part.mediaPaths; part.mediaPath = null; part.mediaFile = null;
      part.assetReady = false; part.assetStatus = 'missing'; part.assetReason = match.reason; part.assetCandidates = match.candidates;
      missing.push({ part: part.part, scene: part.visual || part.narration || '', keywords: part.searchKeywords || [], reason: match.reason, candidates: match.candidates });
    }
  }
  p.assetReport = { mediaRoot: mediaRoot(), orientation, available: items.length, assigned: (p.storyboard || []).length - missing.length, missingCount: missing.length, missing, generatedAt: new Date().toISOString() };
  return p.assetReport;
}
const dataRoot = path.resolve(__dirname,cfg.dataDirectory || './data');
const projectsRoot = path.join(dataRoot,'projects');
fs.mkdirSync(projectsRoot,{recursive:true});
const jobs = new Map();
const upload = multer({dest:path.join(os.tmpdir(),'storyboard-upload-'),limits:{fileSize:8*1024*1024*1024}});
const safe = s => String(s).replace(/[^\p{L}\p{N}._-]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,90) || 'project';
// Quote every interpolated value passed through the container's bash -c entrypoint.
const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const exists = p => {try{return fs.existsSync(p)}catch{return false}};
function resolveSceneMedia(part,dir){
  if(part.mediaPath&&exists(part.mediaPath)){
    const candidate=path.resolve(part.mediaPath),root=path.resolve(mediaRoot());
    if(candidate.startsWith(root+path.sep))return candidate;
  }
  if(part.mediaFile){
    const root=path.resolve(mediaRoot());
    const relative=String(part.mediaFile);
    if(!path.isAbsolute(relative)&&!relative.split(/[\\/]/).includes('..')){
      const candidate=path.resolve(root,relative);
      if(candidate.startsWith(root+path.sep)&&exists(candidate))return candidate;
    }
  }
  if(part.video){
    const candidate=path.resolve(dir,String(part.video));
    if(candidate.startsWith(path.resolve(dir)+path.sep)&&exists(candidate))return candidate;
  }
  return null;
}
function resolveSceneMediaList(part,dir){
  const root=path.resolve(mediaRoot());
  const stored=Array.isArray(part.mediaFiles)&&part.mediaFiles.length?part.mediaFiles:(part.mediaFile?[part.mediaFile]:[]);
  if(stored.length){
    const resolved=stored.map(value=>{
      const relative=String(value||'');
      if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))return null;
      const candidate=path.resolve(root,relative);
      return candidate.startsWith(root+path.sep)&&exists(candidate)?candidate:null;
    });
    return resolved.every(Boolean)?resolved:[];
  }
  const single=resolveSceneMedia(part,dir);
  return single?[single]:[];
}
const readJson = p => JSON.parse(fs.readFileSync(p,'utf8'));
const writeJson = (p,v) => {
  fs.mkdirSync(path.dirname(p),{recursive:true});
  const temp=`${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(v,null,2)+'\n');
  fs.renameSync(temp,p);
};
function projectDir(id){const p=path.resolve(projectsRoot,id);if(!p.startsWith(projectsRoot+path.sep))throw Error('Invalid project');return p}
function resolveSubtitleAsset(project,dir){
  const root=path.resolve(dir);
  const candidates=[];
  if(project.assets?.subtitle)candidates.push(path.resolve(root,String(project.assets.subtitle)));
  // Legacy projects may have the SRT on disk even when project.json has no assets.subtitle pointer.
  candidates.push(
    path.join(root,'captions','captions.srt'),
    path.join(root,'demucs','vocals.srt'),
    path.join(root,'demucs','vocals.davinci.srt'),
    path.join(root,'demucs','vocals.whisper.srt')
  );
  // Also accept renamed caption outputs in the dedicated captions folder.
  for(const folder of ['captions','demucs']){
    const folderPath=path.join(root,folder);
    try{
      for(const name of fs.readdirSync(folderPath).sort()){
        const ext=path.extname(name).toLowerCase();
        if(['.srt','.ass','.ssa'].includes(ext)&&(folder==='captions'||/^vocals/i.test(name)))candidates.push(path.join(folderPath,name));
      }
    }catch{}
  }
  for(const candidate of [...new Set(candidates)]){
    if(!candidate.startsWith(root+path.sep))continue;
    if(!exists(candidate)||!fs.statSync(candidate).isFile()||fs.statSync(candidate).size===0)continue;
    if(!['.srt','.ass','.ssa'].includes(path.extname(candidate).toLowerCase()))continue;
    return {path:candidate,relative:rel(candidate,root)};
  }
  return null;
}
function loadProject(id){const p=path.join(projectDir(id),'project.json');if(!exists(p))throw Error('Project not found');return readJson(p)}
function saveProject(p){p.updatedAt=new Date().toISOString();writeJson(path.join(projectDir(p.id),'project.json'),p)}
function run(cmd,args,opts={}){return new Promise((resolve,reject)=>{const child=spawn(cmd,args,{cwd:opts.cwd||__dirname,env:process.env});let out='',err='';child.stdout.on('data',d=>{out+=d;opts.onLog?.(d.toString())});child.stderr.on('data',d=>{err+=d;opts.onLog?.(d.toString())});child.on('error',reject);child.on('close',code=>code===0?resolve({out,err}):reject(new Error(`${cmd} exit ${code}: ${(err||out).slice(-5000)}`)))});}
function logJob(id,msg){const j=jobs.get(id);if(j){j.logs.push({at:new Date().toISOString(),message:msg});j.logs=j.logs.slice(-300);}}
function enqueue(id,fn){if(jobs.get(id)?.running)throw Error('Project sedang diproses');const j={running:true,stage:'queued',logs:[]};jobs.set(id,j);(async()=>{try{await fn(j);j.stage='completed'}catch(e){j.stage='failed';logJob(id,e.message)}finally{j.running=false;j.finishedAt=new Date().toISOString()}})();return j;}
function updateStatus(p,stage,extra={}){p.status={...(p.status||{}),[stage]:{state:'completed',at:new Date().toISOString(),...extra}};saveProject(p)}
async function duration(file){const {out}=await run('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file]);return Number(out.trim())||0}
function rel(p,base){return path.relative(base,p).split(path.sep).join('/')}
function normalizeStoryText(value){
  return String(value||'').toLowerCase().normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim().replace(/\\s+/g,' ');
}
function storyLibraryPath(){return path.join(dataRoot,'story-library.json')}
function loadStoryLibrary(){try{return readJson(storyLibraryPath())}catch{return {version:1,stories:{}}}}
function saveStoryLibrary(lib){writeJson(storyLibraryPath(),lib)}
function stableStoryKey(cuesForScene,scene){
  const lyric=(cuesForScene||[]).map(c=>normalizeStoryText(c.text)).filter(Boolean).join('|');
  const fallback=normalizeStoryText(`${scene.narration||''} ${scene.visual||''}`);
  const source=lyric.length>=18?lyric:fallback;
  return crypto.createHash('sha256').update(source).digest('hex').slice(0,20);
}

async function scan(){const found=[];const root=path.resolve(cfg.sourceDirectory);async function walk(dir){let entries;try{entries=await fs.promises.readdir(dir,{withFileTypes:true})}catch{return}for(const e of entries){if(e.name.startsWith('.'))continue;const full=path.join(dir,e.name);if(e.isDirectory())await walk(full);else if((cfg.scanExtensions||['.mp3','.mp4']).includes(path.extname(e.name).toLowerCase()))found.push(full)}}await walk(root);return found.sort()}
function createProject(source){const relative=rel(source,path.resolve(cfg.sourceDirectory));const id=safe(path.basename(source,path.extname(source)))+'-'+crypto.createHash('sha1').update(source).digest('hex').slice(0,7);const dir=projectDir(id);if(exists(path.join(dir,'project.json')))return loadProject(id);for(const d of ['source','demucs','captions','videos','render'])fs.mkdirSync(path.join(dir,d),{recursive:true});const p={schemaVersion:1,id,title:path.basename(source,path.extname(source)),source:{path:source,relative,extension:path.extname(source).toLowerCase()},settings:{language:'id',captionModel:cfg.autoCaption.model||'medium',ollamaModel:cfg.ollama.model||'llama3:latest',aiModel:cfg.ai?.model||'',orientation:'landscape',includeSubtitles:true,equalizerEnabled:false,equalizerStyle:'bars',equalizerPosition:'bottom',equalizerColor:'white',equalizerOpacity:80,equalizerHeight:20},assets:{},storyboard:[],status:{},createdAt:new Date().toISOString()};try{fs.symlinkSync(source,path.join(dir,'source',path.basename(source)))}catch{}saveProject(p);return p}
app.get('/api/config',(req,res)=>{
  const ai=cfg.ai||{},provider=selectedProvider(ai);
  const models=provider==='ollama'
    ? (Array.isArray(cfg.ollama?.models)&&cfg.ollama.models.length?cfg.ollama.models:[cfg.ollama?.model||'llama3:latest'])
    : (Array.isArray(ai.models)&&ai.models.length?ai.models:[ai.model||'nvidia/nemotron-3-ultra-550b-a55b:free']);
  res.json({sourceDirectory:cfg.sourceDirectory,mediaDirectory:cfg.mediaDirectory||'./media',ollama:cfg.ollama,ai,aiProvider:provider,models});
});
app.post('/api/config',(req,res)=>{const allowed=['sourceDirectory'];if(req.body.sourceDirectory)cfg.sourceDirectory=path.resolve(req.body.sourceDirectory);writeJson(configPath,cfg);res.json({ok:true,config:cfg})});
app.post('/api/scan',async(req,res)=>{try{const files=await scan();const projects=files.map(createProject);res.json({count:files.length,projects})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/projects',(req,res)=>{const items=fs.readdirSync(projectsRoot,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>{try{return loadProject(x.name)}catch{return null}}).filter(Boolean).sort((a,b)=>b.updatedAt?.localeCompare(a.updatedAt));res.json(items)});
app.get('/api/projects/:id',(req,res)=>{try{res.json(loadProject(req.params.id))}catch(e){res.status(404).json({error:e.message})}});
app.patch('/api/projects/:id',(req,res)=>{try{
  const p=loadProject(req.params.id),incoming={...(req.body.settings||{})};
  const provider=selectedProvider(cfg.ai||{});
  if(provider==='openrouter')delete incoming.ollamaModel;
  else delete incoming.aiModel;
  p.settings={...p.settings,...incoming};if(req.body.title)p.title=String(req.body.title).slice(0,160);if(req.body.storyboard)p.storyboard=req.body.storyboard;saveProject(p);res.json(p)}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/jobs/:id',(req,res)=>res.json(jobs.get(req.params.id)||{running:false,stage:'idle',logs:[]}));
app.post('/api/projects/:id/demucs',(req,res)=>{try{const p=loadProject(req.params.id),dir=projectDir(p.id);enqueue(p.id,async()=>{const j=jobs.get(p.id);j.stage='demucs';logJob(p.id,'Menjalankan Demucs CPU Docker');const sourceName=path.basename(p.source.path);const sourceParent=path.dirname(p.source.path);const outDir=path.join(dir,'demucs-output');fs.mkdirSync(outDir,{recursive:true});const model=cfg.demucs.model||'htdemucs';const containerInput=`/data/inputroot/${sourceName}`;const demucsCommand=`demucs --mp3 -n ${shellQuote(model)} -o ${shellQuote('/data/demucs-output')} ${shellQuote(containerInput)}`;const args=['run','--rm','-v',`${dir}:/data`,'-v',`${sourceParent}:/data/inputroot:ro`,'-v',`${path.resolve(cfg.demucs.modelsDirectory||'/tmp/models')}:/data/models`,cfg.demucs.dockerImage||'facebook-demucs-cpu','-c',demucsCommand];await run('docker',args,{cwd:dir,onLog:s=>logJob(p.id,s.trim())});const base=path.join(outDir,model,path.basename(sourceName,path.extname(sourceName)));for(const name of ['vocals.mp3','no_vocals.mp3','drums.mp3','bass.mp3','other.mp3']){const src=path.join(base,name);if(exists(src)){const dest=path.join(dir,'demucs',name);fs.copyFileSync(src,dest);p.assets[name.replace('.mp3','')]=rel(dest,dir)}}if(!p.assets.vocals)throw Error('Demucs selesai tetapi vocals.mp3 tidak ditemukan. Periksa struktur output Demucs.');delete p.assets.rvcVocals;delete p.assets.rvcAudio;delete p.assets.renderAudio;delete p.status.voiceConversion;updateStatus(p,'demucs',{output:p.assets});logJob(p.id,'Demucs selesai')});res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/projects/:id/caption',(req,res)=>{try{const p=loadProject(req.params.id),dir=projectDir(p.id);p.settings.language=['id','en'].includes(req.body.language)?req.body.language:p.settings.language;saveProject(p);enqueue(p.id,async()=>{const j=jobs.get(p.id);j.stage='caption';const audio=path.join(dir,p.assets.vocals||'demucs/vocals.mp3');if(!exists(audio))throw Error('Jalankan Demucs terlebih dahulu.');const command=cfg.autoCaption.command||'autocaption';logJob(p.id,`Autocaption ${p.settings.language}, model ${p.settings.captionModel}, no-burn`);await run(command,[audio,'--language',p.settings.language,'--model',p.settings.captionModel,'--highlight-color',cfg.autoCaption.highlightColor||'00FF88','--position',cfg.autoCaption.position||'mid','--no-burn'],{cwd:cfg.autoCaption.directory||process.cwd(),onLog:s=>logJob(p.id,s.trim())});const audioDir=path.dirname(audio);const audioStem=path.basename(audio,path.extname(audio));const candidates=[path.join(audioDir,`${audioStem}.srt`),path.join(audioDir,`${audioStem}.davinci.srt`),path.join(audioDir,`${audioStem}.whisper.srt`),path.join(audioDir,`${audioStem}.ass`)];const srt=candidates.find(x=>exists(x)&&x.toLowerCase().endsWith('.srt'));if(!srt)throw Error('Autocaption berjalan tetapi file SRT tidak ditemukan di samping vocals.mp3. Pastikan CLI --no-burn menulis SRT ke direktori input.');const dest=path.join(dir,'captions','captions.srt');fs.copyFileSync(srt,dest);p.assets.subtitle=rel(dest,dir);updateStatus(p,'caption',{subtitle:p.assets.subtitle,language:p.settings.language});logJob(p.id,'SRT berhasil dibuat (no-burn)')});res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/projects/:id/voice-convert',(req,res)=>{
  try{
    const p=loadProject(req.params.id),dir=projectDir(p.id);
    if(!p.assets?.vocals||!exists(path.resolve(dir,p.assets.vocals)))throw Error('Jalankan Demucs terlebih dahulu agar demucs/vocals.mp3 tersedia.');
    if(!p.assets?.subtitle||!exists(path.resolve(dir,p.assets.subtitle)))throw Error('Jalankan AutoCaption terlebih dahulu. RVC ditempatkan setelah AutoCaption.');
    enqueue(p.id,async()=>{
      const j=jobs.get(p.id);j.stage='voice-convert';
      const rvc=cfg.rvc||{};
      const container=String(process.env.RVC_CONTAINER_NAME||rvc.containerName||'').trim();
      if(!container)throw Error('RVC_CONTAINER_NAME belum diatur di file .env.');
      // Shared path hanya path di dalam container RVC. Jangan fs.mkdirSync() path ini dari host.
      const dockerShared=String(process.env.RVC_DOCKER_SHARED_DIR||rvc.dockerSharedDirectory||'/app/shared/temp').replace(/\/+$/,'');
      const workdir=String(process.env.RVC_WORKDIR||rvc.workdir||'/app/rvc');
      const indexPath=String(process.env.RVC_INDEX_PATH||rvc.indexPath||'/app/shared/indices/added_IVF1786_Flat_nprobe_1_arielnoah1_v2.index');
      const modelName=String(process.env.RVC_MODEL_NAME||rvc.modelName||'arielnoah1_e270_s17550.pth');
      const f0upKey=String(process.env.RVC_F0UP_KEY??rvc.f0upKey??3);
      const f0method=String(process.env.RVC_F0_METHOD||rvc.f0method||'rmvpe');
      const device=String(process.env.RVC_DEVICE||rvc.device||'cpu');
      const mixInstrumental=String(process.env.RVC_MIX_INSTRUMENTAL??'').trim()
        ? !['0','false','no','off'].includes(String(process.env.RVC_MIX_INSTRUMENTAL).trim().toLowerCase())
        : rvc.mixInstrumental!==false;
      const source=path.resolve(dir,p.assets.vocals);
      const uid=crypto.randomUUID();
      // File kerja lokal berada di folder project; docker cp memindahkannya ke volume shared RVC.
      const localTemp=path.join(dir,'demucs','rvc-tmp');
      const inputWav=path.join(localTemp,`input_${uid}.wav`);
      const outputWav=path.join(localTemp,`output_${uid}.wav`);
      const dockerInput=`${dockerShared}/input_${uid}.wav`;
      const dockerOutput=`${dockerShared}/output_${uid}.wav`;
      const converted=path.join(dir,'demucs','vocals-rvc.wav');
      const instrumental=p.assets.no_vocals?path.resolve(dir,p.assets.no_vocals):path.join(dir,'demucs','no_vocals.mp3');
      const mixed=path.join(dir,'demucs','audio-rvc.mp3');
      fs.mkdirSync(localTemp,{recursive:true});fs.mkdirSync(path.dirname(converted),{recursive:true});
      try{
        logJob(p.id,'RVC 1/4: menyiapkan vocals.mp3 menjadi WAV 40 kHz mono.');
        await run('ffmpeg',['-y','-i',source,'-ar','40000','-ac','1','-c:a','pcm_s16le',inputWav],{cwd:dir,onLog:x=>logJob(p.id,x.trim())});
        logJob(p.id,`RVC 2/5: memeriksa container ${container}, model, index, dan folder kerja.`);
        await run('docker',['exec','--workdir',workdir,container,'test','-f',`assets/weights/${modelName}`],{cwd:dir,onLog:x=>logJob(p.id,x.trim())});
        await run('docker',['exec',container,'test','-f',indexPath],{cwd:dir,onLog:x=>logJob(p.id,x.trim())});
        await run('docker',['exec',container,'mkdir','-p',dockerShared],{cwd:dir,onLog:x=>logJob(p.id,x.trim())});
        logJob(p.id,'RVC 3/5: mengirim WAV ke container dengan docker cp.');
        await run('docker',['cp',inputWav,`${container}:${dockerInput}`],{cwd:dir,onLog:x=>logJob(p.id,x.trim())});
        logJob(p.id,`RVC 4/5: inferensi suara pada container ${container}.`);
        const args=['exec','--workdir',workdir,container,'python3','tools/infer_cli.py','--f0up_key',f0upKey,'--input_path',dockerInput,'--index_path',indexPath,'--f0method',f0method,'--opt_path',dockerOutput,'--model_name',modelName,'--device',device];
        await run('docker',args,{cwd:dir,onLog:x=>logJob(p.id,x.trim())});
        logJob(p.id,'RVC 5/5: mengambil hasil WAV dari container.');
        await run('docker',['cp',`${container}:${dockerOutput}`,outputWav],{cwd:dir,onLog:x=>logJob(p.id,x.trim())});
        if(!exists(outputWav)||fs.statSync(outputWav).size<1024)throw Error('RVC selesai tetapi output WAV kosong/tidak ditemukan setelah docker cp. Periksa log infer_cli.py dan izin volume ./shared.');
        const convertedDuration=await duration(outputWav);
        const sourceDuration=await duration(inputWav);
        if(!(convertedDuration>0))throw Error('File output RVC tidak memiliki stream audio yang valid.');
        if(Math.abs(convertedDuration-sourceDuration)>Math.max(3,sourceDuration*0.05))throw Error(`Durasi output RVC berubah tidak wajar: input ${sourceDuration.toFixed(2)} detik, output ${convertedDuration.toFixed(2)} detik.`);
        fs.copyFileSync(outputWav,converted);
        let renderAudio=converted;
        if(mixInstrumental&&exists(instrumental)){
          logJob(p.id,'RVC 3/4: mencampur vocal hasil RVC dengan no_vocals.mp3 agar musik pengiring tetap ada.');
          await run('ffmpeg',['-y','-i',converted,'-i',instrumental,'-filter_complex','[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.95[a]','-map','[a]','-ar','48000','-ac','2','-c:a','libmp3lame','-b:a','192k',mixed],{cwd:dir,onLog:x=>logJob(p.id,x.trim())});
          renderAudio=mixed;
        }else{
          logJob(p.id,'no_vocals.mp3 tidak tersedia; render akan memakai vocal hasil RVC saja.');
        }
        p.assets.rvcVocals=rel(converted,dir);
        if(renderAudio===mixed)p.assets.rvcAudio=rel(mixed,dir);
        p.assets.renderAudio=rel(renderAudio,dir);
        updateStatus(p,'voiceConversion',{vocals:p.assets.rvcVocals,renderAudio:p.assets.renderAudio,mixedWithInstrumental:renderAudio===mixed,container,modelName});
        logJob(p.id,'RVC selesai. Audio render project sekarang menggunakan hasil konversi suara.');
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        logJob(p.id,`RVC gagal: ${message}`);
        throw error;
      }finally{
        // Hapus file temporer dari host dan container; file hasil project tidak ikut dihapus.
        for(const f of [inputWav,outputWav]){try{if(exists(f))fs.unlinkSync(f)}catch{}}
        try{await run('docker',['exec',container,'rm','-f',dockerInput,dockerOutput],{cwd:dir})}catch{}
        try{if(exists(localTemp)&&fs.readdirSync(localTemp).length===0)fs.rmdirSync(localTemp)}catch{}
      }
    });
    res.json({ok:true});
  }catch(e){res.status(400).json({error:e.message})}
});

function parseSrt(s){return s.replace(/\r/g,'').split(/\n\s*\n/).map(block=>{const lines=block.split('\n');const ti=lines.findIndex(x=>x.includes('-->'));if(ti<0)return null;const [a,b]=lines[ti].split('-->').map(x=>x.trim().split(' ')[0]);const sec=t=>{const m=t.match(/(\d+):(\d+):(\d+)[,.](\d+)/);return m?+m[1]*3600+ +m[2]*60+ +m[3]+ +(m[4].padEnd(3,'0').slice(0,3))/1000:0};return {start:sec(a),end:sec(b),text:lines.slice(ti+1).join(' ').replace(/<[^>]+>/g,'').trim()}}).filter(x=>x?.text)}
// Rapikan cue: potong cue instrumental yang terlalu lama, hilangkan overlap, gabungkan cue yang terlalu pendek.
function sanitizeCues(cues,{maxSeconds=7}={}){
  const sorted=cues.map(c=>({...c})).sort((a,b)=>a.start-b.start||a.end-b.end);
  for(let i=0;i<sorted.length;i++){
    const c=sorted[i],next=sorted[i+1];
    const limit=Math.max(2.5,Math.min(maxSeconds,2+0.12*c.text.length));
    if(c.end-c.start>limit)c.end=c.start+limit;
    if(next&&next.start<c.end)c.end=Math.max(c.start,next.start);
    if(next&&c.end-c.start<0.3){next.text=`${c.text} ${next.text}`;next.start=Math.min(next.start,c.start);c.drop=true}
  }
  return sorted.filter(c=>!c.drop&&c.end-c.start>=0.05);
}
function cuesToSrt(cues){
  const ts=n=>{const ms=Math.max(0,Math.round(n*1000));const p=(v,l)=>String(v).padStart(l,'0');return `${p(Math.floor(ms/3600000),2)}:${p(Math.floor(ms%3600000/60000),2)}:${p(Math.floor(ms%60000/1000),2)},${p(ms%1000,3)}`};
  return cues.map((c,i)=>`${i+1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
}
app.post('/api/projects/:id/storyboard',(req,res)=>{
  try {
    const p=loadProject(req.params.id),dir=projectDir(p.id);
    enqueue(p.id,async()=>{
      const j=jobs.get(p.id);
      j.stage='storyboard';
      logJob(p.id,'Memulai analisis storyboard');

      let captions='';
      if(p.assets.subtitle&&exists(path.join(dir,p.assets.subtitle))) captions=fs.readFileSync(path.join(dir,p.assets.subtitle),'utf8');
      else if(req.body.transcript) captions=req.body.transcript;
      else throw Error('Storyboard semantik memerlukan teks transkrip/SRT. Buat SRT dahulu.');

      const cues=sanitizeCues(parseSrt(captions),{maxSeconds:Number(cfg.render?.maxCueSeconds||7)});
      if(!cues.length) throw Error('SRT terbaca, tetapi tidak ditemukan cue subtitle yang valid.');

      const ai=cfg.ai||{provider:'openrouter'};
      const provider=selectedProvider(ai);
      const configuredModels=Array.isArray(ai.models)&&ai.models.length?ai.models:[ai.model||'nvidia/nemotron-3-ultra-550b-a55b:free'];
       const requestedRemoteModel=p.settings.aiModel;
       const model=provider==='ollama'
         ? (p.settings.ollamaModel||cfg.ollama?.model||'llama3:latest')
         : (configuredModels.includes(requestedRemoteModel)?requestedRemoteModel:(ai.model||configuredModels[0]));
      // Batch berdasarkan jendela WAKTU yang bersambung (tanpa celah), bukan sekadar jumlah cue,
      // agar bagian instrumental/jeda juga mendapat adegan. Awal = 0, akhir = durasi audio.
      let totalDuration=Math.max(...cues.map(c=>c.end));
      try{const d=await duration(p.source.path);if(d>totalDuration)totalDuration=d}catch{}
      const secondsPerScene=Math.max(3,Number(ai.secondsPerScene||6));
      const secondsPerBatch=Math.max(20,Math.min(90,Number(ai.secondsPerBatch||40)));
      const batches=[];
      for(let lo=0;lo<totalDuration-0.05;lo+=secondsPerBatch){
        const hi=Math.min(totalDuration,lo+secondsPerBatch);
        const inWin=cues.filter(c=>c.end>lo&&c.start<hi);
        batches.push({lo,hi,cues:inWin});
      }
      const allParts=[];
      const summaryParts=[];

      const stamp=n=>{
        const ms=Math.max(0,Math.round(n*1000));
        const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),f=ms%1000;
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(f).padStart(3,'0')}`;
      };

      // OpenRouter kadang menambahkan teks setelah JSON, atau membungkus JSON
      // dengan markdown. Ambil objek JSON lengkap pertama yang memiliki `parts`.
      // Scanner ini menghitung kurung kurawal dan mengabaikan karakter di dalam string.
      const parseModelJson=content=>{
        const source=(Array.isArray(content)
          ? content.map(item=>typeof item==='string'?item:(item?.text||'')).join('\n')
          : String(content??'')).replace(/^\uFEFF/,'').trim();
        if(!source)throw Error('Respons model kosong.');

        const candidates=[];
        for(let start=0;start<source.length;start++){
          if(source[start]!=='{')continue;
          let depth=0,inString=false,escaped=false;
          for(let i=start;i<source.length;i++){
            const ch=source[i];
            if(inString){
              if(escaped)escaped=false;
              else if(ch==='\\')escaped=true;
              else if(ch==='"')inString=false;
              continue;
            }
            if(ch==='"'){inString=true;continue;}
            if(ch==='{')depth++;
            else if(ch==='}'){
              depth--;
              if(depth===0){candidates.push(source.slice(start,i+1));break;}
              if(depth<0)break;
            }
          }
        }

        let lastError=null;
        for(const candidate of candidates){
          try{
            const parsed=JSON.parse(candidate);
            if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Array.isArray(parsed.parts))return parsed;
          }catch(error){lastError=error;}
        }
        if(lastError)throw Error(`JSON tidak lengkap atau rusak: ${lastError.message}`);
        throw Error('Tidak ditemukan objek JSON storyboard yang memiliki array "parts".');
      };

      const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const callOpenRouter=async(prompt,batchNumber)=>{
        const apiKey=process.env[ai.apiKeyEnv||'OPENROUTER_API_KEY'];
        if(!apiKey)throw Error(`API key belum tersedia. Atur environment variable ${ai.apiKeyEnv||'OPENROUTER_API_KEY'} pada proses PM2.`);
        const baseUrl=(ai.baseUrl||'https://openrouter.ai/api/v1').replace(/\/+$/,'');
        const maxRetries=Math.max(0,Number(ai.maxRetries??3));
        for(let attempt=0;attempt<=maxRetries;attempt++){
          let response;
          try{
            response=await fetch(`${baseUrl}/chat/completions`,{
              method:'POST',
              headers:{
                'Authorization':`Bearer ${apiKey}`,
                'Content-Type':'application/json',
                'HTTP-Referer':'http://localhost',
                'X-Title':'AI Storyboard Studio'
              },
              body:JSON.stringify({
                model,
                messages:[
                  {role:'system',content:'Kamu adalah sutradara dan storyboard artist. Jawab hanya JSON valid sesuai schema yang diminta. Jangan gunakan markdown atau teks pembuka.'},
                  {role:'user',content:prompt}
                ],
                temperature:Number(ai.temperature??0.2),
                max_tokens:Number(ai.maxTokens??4096),
                ...(ai.reasoning?{reasoning:ai.reasoning}:{}),
                stream:false
              }),
              signal:AbortSignal.timeout(Number(ai.timeoutMs||300000))
            });
          }catch(e){
            throw Error(`Koneksi OpenRouter gagal pada bagian ${batchNumber}: ${e.message}`);
          }
          if(response.ok){
            const data=await response.json();
            const choice=data?.choices?.[0];
            const content=choice?.message?.content;
            if(!content)throw Error(`OpenRouter mengembalikan content kosong pada bagian ${batchNumber}.`);
            if(choice.finish_reason==='length')throw Error(`Output OpenRouter bagian ${batchNumber} terpotong karena batas maxTokens. Naikkan ai.maxTokens di config.json.`);
            return {content,usage:data.usage||null};
          }
          const body=(await response.text()).slice(0,2000);
          if((response.status===429||response.status>=500)&&attempt<maxRetries){
            const retryHeader=Number(response.headers.get('retry-after'));
            const waitMs=Number.isFinite(retryHeader)&&retryHeader>0?retryHeader*1000:Math.min(60000,5000*(attempt+1));
            logJob(p.id,`OpenRouter HTTP ${response.status}; mencoba ulang dalam ${Math.ceil(waitMs/1000)} detik (${attempt+1}/${maxRetries})`);
            await pause(waitMs);
            continue;
          }
          throw Error(`OpenRouter HTTP ${response.status} pada bagian ${batchNumber}: ${body}`);
        }
        throw Error(`OpenRouter gagal setelah ${maxRetries+1} percobaan pada bagian ${batchNumber}.`);
      };

      const callOllama=async(prompt,batchNumber)=>{
        const baseUrl=(cfg.ollama?.url||'http://127.0.0.1:11434').replace(/\/$/,'');
        let response;
        try{
          response=await fetch(`${baseUrl}/api/chat`,{
            method:'POST',
            headers:{'content-type':'application/json'},
            body:JSON.stringify({
              model,stream:false,format:'json',
              options:{num_ctx:4096,num_predict:2048,temperature:Number(ai.temperature??0.2)},
              messages:[
                {role:'system',content:'Jawab hanya JSON valid sesuai schema. Jangan menambah markdown.'},
                {role:'user',content:prompt}
              ]
            }),
            signal:AbortSignal.timeout(600000)
          });
        }catch(e){
          const cause=e.cause?`; cause=${e.cause.code||''} ${e.cause.message||e.cause}`:'';
          throw Error(`Koneksi ke Ollama gagal pada bagian ${batchNumber}: ${e.message}${cause}`);
        }
        if(!response.ok)throw Error(`Ollama HTTP ${response.status} pada bagian ${batchNumber}: ${(await response.text()).slice(0,1500)}`);
        const data=await response.json();
        const content=data?.message?.content;
        if(!content)throw Error(`Ollama mengembalikan content kosong pada bagian ${batchNumber}`);
        return {content,usage:null};
      };

      if(!['openrouter','ollama'].includes(provider))throw Error(`Provider AI tidak dikenal: ${provider}`);
      if(!model)throw Error('Model AI belum ditentukan di config.json.');
      logJob(p.id,`${provider==='openrouter'?'OpenRouter':'Ollama'}: ${model}; ${cues.length} cue; durasi ${totalDuration.toFixed(1)} dtk; dibagi menjadi ${batches.length} bagian (±${secondsPerScene} dtk/adegan)`);

      const providerName=provider==='openrouter'?'OpenRouter':'Ollama';
      for(let bi=0;bi<batches.length;bi++){
        const {lo:batchStart,hi:batchEnd,cues:batch}=batches[bi];
        const transcript=(batch.length?batch:[{start:batchStart,end:batchEnd,text:'(instrumental / tanpa lirik)'}]).map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}`).join('\n\n');
        const targetScenes=Math.max(1,Math.round((batchEnd-batchStart)/secondsPerScene));
        const prompt=`Buat storyboard video musik BERBASIS ADEGAN VISUAL untuk jendela waktu ${batchStart.toFixed(2)}-${batchEnd.toFixed(2)} detik (${(batchEnd-batchStart).toFixed(1)} detik). Hasilkan SEKITAR ${targetScenes} adegan (boleh ${Math.max(1,targetScenes-1)}-${targetScenes+2}); tiap adegan sekitar ${secondsPerScene} detik (minimal 3, maksimal 10). Adegan HARUS menutup seluruh jendela tanpa celah: adegan pertama mulai tepat di ${batchStart.toFixed(2)}, adegan berikutnya mulai tepat di akhir adegan sebelumnya, adegan terakhir berakhir tepat di ${batchEnd.toFixed(2)}. Bagian tanpa lirik (jeda/instrumental) tetap diberi adegan atmosferik yang sesuai suasana lagu. Satukan baris lirik yang bergagasan sama, tetapi ganti adegan saat gagasan/energi musik berubah; jangan satu adegan untuk setiap baris lirik. Timestamp numerik dalam detik, berurutan, tidak overlap. Deskripsi visual konkret (1-2 kalimat) dan searchKeywords: 3-6 kata kunci stock video dalam BAHASA INGGRIS, kata tunggal yang konkret (contoh: crowd, night, street, guitarist, rain, smoke), tanpa kata umum seperti video atau footage. Keluarkan JSON valid saja: {"summary":"ringkasan","parts":[{"part":1,"start":0,"end":6,"duration":6,"narration":"inti lirik/ide","visual":"adegan visual","searchKeywords":["kata kunci stock"],"shotType":"wide|medium|close-up|detail|montage","mood":"..."}]}. Narration dan visual dalam Bahasa Indonesia. Jangan menambahkan markdown, komentar, atau teks di luar JSON.\n\nTranskrip:\n${transcript}`;
        logJob(p.id,`${providerName}: mengirim bagian ${bi+1}/${batches.length} (${batch.length} cue, ${transcript.length} karakter, ${batchStart.toFixed(0)}-${batchEnd.toFixed(0)} dtk)`);
        // OpenRouter free tier allows up to 20 requests/minute; keep a conservative gap between calls.
        if(provider==='openrouter'&&bi>0)await pause(Math.max(0,Number(ai.minRequestIntervalMs??3500)));
        const resultCall=provider==='openrouter'?await callOpenRouter(prompt,bi+1):await callOllama(prompt,bi+1);
        let result;
        try{result=parseModelJson(resultCall.content)}
        catch(e){throw Error(`JSON storyboard bagian ${bi+1} tidak valid: ${e.message}; awal respons: ${String(resultCall.content).slice(0,700)}`)}
        if(!Array.isArray(result.parts))throw Error(`Respons bagian ${bi+1} tidak memiliki array parts`);
        summaryParts.push(result.summary||'');
        allParts.push(...result.parts.map(x=>({...x,_batchIndex:bi})));
        const usage=resultCall.usage?.total_tokens?`; ${resultCall.usage.total_tokens} token`:'';
        logJob(p.id,`${providerName}: bagian ${bi+1}/${batches.length} selesai; ${result.parts.length} part${usage}`);
      }

      // Normalize model timestamps to their source batch, then merge tiny adjacent fragments.
      const normalized=[];
      for(let bi=0;bi<batches.length;bi++){
        const {lo,hi}=batches[bi];
        const batchParts=allParts.filter(x=>x._batchIndex===bi);
        for(const x of batchParts){
          let start=Math.max(lo,Number(x.start)||lo),end=Math.min(hi,Number(x.end)||hi);
          if(end<=start)continue;
          const {_batchIndex,...clean}=x;normalized.push({...clean,start,end,duration:end-start});
        }
      }
      normalized.sort((a,b)=>a.start-b.start);
      const scenes=[];
      for(const scene of normalized){
        const prev=scenes[scenes.length-1];
        if(prev&&scene.start<prev.end){scene.start=prev.end;scene.duration=scene.end-scene.start;}
        if(scene.duration<3.0&&prev&&scene.start-prev.end<1.25){
          prev.end=Math.max(prev.end,scene.end);prev.duration=prev.end-prev.start;
          prev.narration=[prev.narration,scene.narration].filter(Boolean).join(' ');
          prev.visual=[prev.visual,scene.visual].filter(Boolean).join('; ');
          prev.searchKeywords=[...new Set([...(prev.searchKeywords||[]),...(scene.searchKeywords||[])])];
        }else if(scene.duration>=1.5){scenes.push(scene)}
      }
      // Tutup celah: tiap adegan berlanjut sampai adegan berikutnya; adegan pertama mulai di 0, terakhir sampai akhir audio.
      if(scenes.length){
        scenes[0].start=0;
        for(let i=0;i<scenes.length;i++){scenes[i].end=i<scenes.length-1?scenes[i+1].start:Math.max(scenes[i].end,totalDuration);scenes[i].duration=scenes[i].end-scenes[i].start}
      }
      const storyLibrary=loadStoryLibrary();
      p.storyboard=scenes.map((x,i)=>{
        const sceneCues=cues.filter(c=>c.end>x.start&&c.start<x.end);
        const storyId=stableStoryKey(sceneCues,x);
        const cached=storyLibrary.stories[storyId];
        const scene={...x};
        if(cached){
          scene.narration=cached.narration||scene.narration;
          scene.visual=cached.visual||scene.visual;
          scene.searchKeywords=cached.searchKeywords||scene.searchKeywords;
          scene.storyReused=true;
        }else{
          storyLibrary.stories[storyId]={narration:scene.narration,visual:scene.visual,searchKeywords:scene.searchKeywords||[],createdAt:new Date().toISOString()};
          scene.storyReused=false;
        }
        return {...scene,storyId,part:i+1,id:`part-${i+1}`,duration:Number((x.end-x.start).toFixed(3)),video:null,mediaPath:null,assetReady:false,assetStatus:'pending'};
      });
      saveStoryLibrary(storyLibrary);
      const mediaItems=await scanMediaLibrary();
      const assetReport=assignMediaToStoryboard(p,mediaItems);
      p.analysis={summary:summaryParts.filter(Boolean).join(' '),model,provider,createdAt:new Date().toISOString()};
      updateStatus(p,'storyboard',{parts:p.storyboard.length,provider,model,assetsAssigned:assetReport.assigned,assetsMissing:assetReport.missingCount});
      saveProject(p);
      logJob(p.id,`Storyboard dibuat: ${p.storyboard.length} adegan dari ${cues.length} cue; stock otomatis ${assetReport.assigned}/${p.storyboard.length}, belum tersedia ${assetReport.missingCount}. Provider ${providerName}`);
    });
    res.json({ok:true});
  } catch(e) {
    console.error('[STORYBOARD] request error:',e);
    res.status(400).json({error:e.message});
  }
});

// Serve previews from the configured media library without exposing arbitrary filesystem paths.
app.get('/api/media/file',async(req,res)=>{
  try{
    const relative=String(req.query.path||'');
    if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))return res.status(400).end('Invalid media path');
    const root=await fs.promises.realpath(mediaRoot());
    const file=await fs.promises.realpath(path.resolve(root,relative));
    if(!file.startsWith(root+path.sep)||!exists(file))return res.status(404).end();
    res.sendFile(file);
  }catch{return res.status(404).end()}
});
app.patch('/api/projects/:id/parts/:partId/media',async(req,res)=>{
  try{
    const p=loadProject(req.params.id);
    const part=p.storyboard.find(x=>x.id===req.params.partId);
    if(!part)throw Error('Adegan tidak ditemukan');
    const requested=Array.isArray(req.body.relatives)?req.body.relatives:(req.body.relative?[req.body.relative]:[]);
    const relatives=[...new Set(requested.map(x=>String(x||'')))];
    if(!relatives.length)throw Error('Pilih minimal satu stock video.');
    if(relatives.length>20)throw Error('Maksimal 20 video dapat dipilih untuk satu adegan.');
    for(const relative of relatives){
      if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Path footage tidak valid.');
    }
    const items=await scanMediaLibrary();
    const selected=relatives.map(relative=>items.find(x=>x.relative===relative));
    if(selected.some(item=>!item||!exists(item.path)))throw Error('Salah satu stock tidak ditemukan di Media Library. Scan ulang media.');
    part.video=null;
    part.mediaFiles=selected.map(item=>item.relative);
    part.mediaPaths=selected.map(item=>item.path);
    part.mediaPath=selected[0].path;
    part.mediaFile=selected[0].relative; // compatibility for older UI/automation
    part.mediaCategory=[...new Set(selected.map(item=>item.category))].join(', ');
    part.mediaDuration=selected.reduce((sum,item)=>sum+Number(item.duration||0),0);
    part.assetReady=true;
    part.assetStatus='assigned';
    part.assetReason=`${selected.length} footage dipilih manual dan akan digabung berurutan.`;
    part.assetCandidates=[];
    const report=assignMediaReportOnly(p);
    saveProject(p);
    res.json({ok:true,project:p,report});
  }catch(e){res.status(400).json({error:e.message})}
});
function assignMediaReportOnly(p){
  const missing=(p.storyboard||[]).filter(x=>!resolveSceneMedia(x,projectDir(p.id)));
  const report={mediaRoot:mediaRoot(),orientation:p.settings?.orientation||'landscape',available:null,assigned:(p.storyboard||[]).length-missing.length,missingCount:missing.length,missing:missing.map(x=>({part:x.part,scene:x.visual||x.narration||'',keywords:x.searchKeywords||[],reason:x.assetReason||'Stock belum dipilih.',candidates:x.assetCandidates||[]})),generatedAt:new Date().toISOString()};
  p.assetReport=report;
  return report;
}

app.get('/api/media',async(req,res)=>{try{const items=await scanMediaLibrary();res.json({root:mediaRoot(),count:items.length,items:items.map(({path,...x})=>x)})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/projects/:id/asset-report',(req,res)=>{try{const p=loadProject(req.params.id);res.json(p.assetReport||{available:0,assigned:0,missingCount:0,missing:[]})}catch(e){res.status(404).json({error:e.message})}});
app.post('/api/projects/:id/auto-assign',async(req,res)=>{
  try{
    const p=loadProject(req.params.id);

    if(!p.storyboard?.length){
      throw Error('Storyboard is empty. Generate the storyboard first.');
    }

    const assets=loadCompletedCatalogAssets();

    if(!assets.length){
      throw Error(
        `Tidak ada video completed yang valid di ${mediaLibraryPath()}. Periksa MEDIA_ROOT dan file.path pada katalog.`
      );
    }

    // Pencocokan lokal menggunakan metadata katalog.
    const report=assignMediaToStoryboard(p,assets);

    report.mediaLibrary=mediaLibraryPath();
    report.provider='local-index';
    report.model='metadata-ranking';

    saveProject(p);

    res.json({
      ok:true,
      report,
      project:p
    });

  }catch(e){
    console.error('[AUTO ASSIGN]',e);

    res.status(400).json({
      error:e.message
    });
  }
});
app.post('/api/projects/:id/parts/:partId/video',upload.single('video'),(req,res)=>{try{if(!req.file)throw Error('File video tidak diterima');const p=loadProject(req.params.id),dir=projectDir(p.id),part=p.storyboard.find(x=>x.id===req.params.partId);if(!part)throw Error('Part tidak ditemukan');const ext=path.extname(req.file.originalname).toLowerCase();if(!['.mp4','.mov','.mkv','.webm'].includes(ext))throw Error('Format video tidak didukung');const name=`${part.id}${ext}`,dest=path.join(dir,'videos',name);fs.renameSync(req.file.path,dest);part.video=rel(dest,dir);part.mediaPath=null;part.mediaFile=null;part.assetStatus='uploaded';part.assetReady=true;saveProject(p);res.json({ok:true,project:p})}catch(e){if(req.file&&exists(req.file.path))fs.unlinkSync(req.file.path);res.status(400).json({error:e.message})}});
app.post('/api/projects/:id/render', async(req,res)=>{
  try{
    const p=loadProject(req.params.id),dir=projectDir(p.id);
    p.settings.orientation=['portrait','landscape'].includes(req.body.orientation)?req.body.orientation:p.settings.orientation;
    p.settings.includeSubtitles=req.body.includeSubtitles!==false;
    if(typeof req.body.equalizerEnabled==='boolean')p.settings.equalizerEnabled=req.body.equalizerEnabled;
    if(['bars','waveform'].includes(req.body.equalizerStyle))p.settings.equalizerStyle=req.body.equalizerStyle;
    if(['bottom','center','top'].includes(req.body.equalizerPosition))p.settings.equalizerPosition=req.body.equalizerPosition;
    if(['white','cyan','purple'].includes(req.body.equalizerColor))p.settings.equalizerColor=req.body.equalizerColor;
    if(Number.isFinite(Number(req.body.equalizerOpacity)))p.settings.equalizerOpacity=Math.max(0,Math.min(100,Number(req.body.equalizerOpacity)));
    if(Number.isFinite(Number(req.body.equalizerHeight)))p.settings.equalizerHeight=Math.max(5,Math.min(40,Number(req.body.equalizerHeight)));
    saveProject(p);
    if(!p.storyboard?.length)throw Error('Storyboard belum dibuat');
    const subtitleAsset=resolveSubtitleAsset(p,dir);
    if(p.settings.includeSubtitles){
      if(!subtitleAsset)throw Error('Subtitle diminta aktif, tetapi file SRT/ASS tidak ditemukan. Jalankan AutoCaption kembali atau periksa data/projects/<project-id>/captions/captions.srt. Render dihentikan agar video tidak diam-diam tanpa subtitle.');
      p.assets.subtitle=subtitleAsset.relative;
      saveProject(p);
      logJob(p.id,`Subtitle ditemukan: ${subtitleAsset.relative}`);
    }
    const sceneSources=p.storyboard.map(part=>({part,sourcePaths:resolveSceneMediaList(part,dir)}));
    const missing=sceneSources.filter(x=>!x.sourcePaths.length);
    if(missing.length)throw Error(`Stock video belum tersedia atau file asset hilang untuk adegan: ${missing.map(x=>`${x.part.part} (${x.part.visual||x.part.narration||'tanpa deskripsi'})`).join('; ')}.`);
    for(const entry of sceneSources){
      entry.sourceDurations=[];
      for(const sourcePath of entry.sourcePaths){
        const clipDuration=await duration(sourcePath);
        if(!(clipDuration>0))throw Error(`Asset footage tidak dapat dibaca oleh ffprobe: ${sourcePath}`);
        entry.sourceDurations.push(clipDuration);
      }
    }
    enqueue(p.id,async()=>{
      const j=jobs.get(p.id);j.stage='render';
      logJob(p.id,'Render dimulai: menyiapkan audio, footage, subtitle, dan equalizer.');
      const audioPath=p.assets?.renderAudio?path.resolve(dir,p.assets.renderAudio):p.source.path;
      if(!exists(audioPath))throw Error(`File audio untuk render tidak ditemukan: ${audioPath}`);
      const audioDuration=await duration(audioPath);
      if(!(audioDuration>0))throw Error('Durasi audio tidak dapat dibaca oleh ffprobe.');
      const w=p.settings.orientation==='portrait'?(cfg.render.widthPortrait||1080):(cfg.render.widthLandscape||1920);
      const h=p.settings.orientation==='portrait'?(cfg.render.heightPortrait||1920):(cfg.render.heightLandscape||1080);
      const fps=Number(cfg.render.fps||30);
      const sorted=[...p.storyboard].sort((a,b)=>Number(a.start||0)-Number(b.start||0));
      const sourceByPart=new Map(sceneSources.map(x=>[x.part.id,x]));
      let cursor=0;
      const scenes=[];
      for(let i=0;i<sorted.length;i++){
        const part=sorted[i];
        const nextStart=i<sorted.length-1?Number(sorted[i+1].start):audioDuration;
        const proposedStart=i===0?0:Math.max(cursor,Math.min(audioDuration,Number(part.start)||cursor));
        const end=Math.max(proposedStart,Math.min(audioDuration,nextStart>proposedStart?nextStart:audioDuration));
        const sceneDuration=end-proposedStart;
        if(sceneDuration<=0.05)continue;
        const resolved=sourceByPart.get(part.id);
        const srcs=resolved?.sourcePaths||[];
        if(!srcs.length||srcs.some(src=>!exists(src)))throw Error(`Asset footage scene ${part.part} hilang saat render dimulai.`);
        scenes.push({
          part:part.part,storyId:part.storyId||null,videoFiles:Array.isArray(part.mediaFiles)&&part.mediaFiles.length?part.mediaFiles:(part.mediaFile?[part.mediaFile]:[part.video].filter(Boolean)),
          sourcePaths:srcs,sourceDurations:resolved.sourceDurations||[],timelineStart:Number(proposedStart.toFixed(3)),
          timelineEnd:Number(end.toFixed(3)),duration:Number(sceneDuration.toFixed(3)),
          trimStart:0,loopIfShort:true
        });
        cursor=end;
      }
      if(!scenes.length)throw Error('Tidak ada scene dengan durasi render yang valid.');
      if(scenes[scenes.length-1].timelineEnd<audioDuration){
        const last=scenes[scenes.length-1];
        last.duration=Number((last.duration+(audioDuration-last.timelineEnd)).toFixed(3));
        last.timelineEnd=Number(audioDuration.toFixed(3));
      }
      // Tentukan nama output sebelum manifest dibuat karena manifest memakai path final.
      const final=path.join(dir,'render',`${safe(p.title)}-${p.settings.orientation}.mp4`);
      const manifest={
        version:1,projectId:p.id,createdAt:new Date().toISOString(),
        audio:{source:p.assets?.renderAudio||p.source.relative,path:audioPath,duration:Number(audioDuration.toFixed(3)),codec:'aac',included:true,voiceConversion:!!p.assets?.rvcVocals},
        assets:{
          subtitle:p.settings.includeSubtitles&&subtitleAsset?subtitleAsset.relative:null,
          sceneFootage:scenes.length,
          validatedBeforeRender:true
        },
        render:{orientation:p.settings.orientation,width:w,height:h,fps,totalDuration:Number(audioDuration.toFixed(3)),videoCodec:'libx264',audioCodec:'aac',audioBitrate:'320k',equalizer:{enabled:p.settings.equalizerEnabled===true,style:p.settings.equalizerStyle||'bars',position:p.settings.equalizerPosition||'bottom',color:p.settings.equalizerColor||'white',heightPercent:Number(p.settings.equalizerHeight??20),opacityPercent:Number(p.settings.equalizerOpacity??80),subtitleAvoidance:p.settings.equalizerEnabled===true&&p.settings.equalizerPosition==='bottom'}},
        outputs:{video:rel(final,dir),subtitle:p.settings.includeSubtitles&&subtitleAsset&&path.extname(subtitleAsset.path).toLowerCase()==='.srt'?rel(final.replace(/\.mp4$/i,'.srt'),dir):null},
        scenes:scenes.map(({sourcePaths,sourceDurations,...scene})=>({...scene,sourceCount:sourcePaths.length,sourceDurations}))
      };
      const manifestPath=path.join(dir,'render','render-manifest.json');
      writeJson(manifestPath,manifest);
      logJob(p.id,`Manifest render dibuat: ${scenes.length} scene; durasi audio ${audioDuration.toFixed(2)} detik.`);
      const segments=[];
      for(let i=0;i<scenes.length;i++){
        const scene=scenes[i];
        const out=path.join(dir,'render',`segment-${String(i+1).padStart(3,'0')}.mp4`);
        const dur=scene.duration;
        let sceneSource=scene.sourcePaths[0];
        if(scene.sourcePaths.length>1){
          const montage=path.join(dir,'render',`footage-scene-${String(i+1).padStart(3,'0')}.mp4`);
          const inputs=scene.sourcePaths.flatMap(src=>['-i',src]);
          const filters=scene.sourcePaths.map((src,index)=>`[${index}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[v${index}]`).join(';');
          const concatInputs=scene.sourcePaths.map((src,index)=>`[v${index}]`).join('');
          const graph=`${filters};${concatInputs}concat=n=${scene.sourcePaths.length}:v=1:a=0[vout]`;
          logJob(p.id,`Menggabungkan ${scene.sourcePaths.length} footage untuk scene ${scene.part} secara berurutan.`);
          await run('ffmpeg',['-y',...inputs,'-filter_complex',graph,'-map','[vout]','-an','-c:v','libx264','-preset',cfg.render.preset||'medium','-crf',String(cfg.render.crf||20),'-pix_fmt','yuv420p','-r',String(fps),'-movflags','+faststart',montage],{onLog:s=>logJob(p.id,s.trim())});
          sceneSource=montage;
        }
        const vf=`[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=20:10[bg];[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${fps},format=yuv420p[v]`;
        logJob(p.id,`Render scene ${i+1}/${scenes.length}: ${scene.videoFiles.length} footage, ${dur.toFixed(2)} detik.`);
        await run('ffmpeg',['-y','-stream_loop','-1','-i',sceneSource,'-t',String(dur),'-filter_complex',vf,'-map','[v]','-an','-c:v','libx264','-preset',cfg.render.preset||'medium','-crf',String(cfg.render.crf||20),'-pix_fmt','yuv420p','-r',String(fps),out],{onLog:s=>logJob(p.id,s.trim())});
        segments.push(out);
      }
      const list=path.join(dir,'render','concat.txt');
      fs.writeFileSync(list,segments.map(x=>`file '${x.replace(/'/g,"'\\\\''")}'`).join('\n'));
      let sub=subtitleAsset?.path||null;
      if(sub&&p.settings.includeSubtitles&&path.extname(sub).toLowerCase()==='.srt'){
        const cleaned=sanitizeCues(parseSrt(fs.readFileSync(sub,'utf8')),{maxSeconds:Number(cfg.render?.maxCueSeconds||7)});
        const cleanPath=path.join(dir,'render','subtitles.clean.srt');
        fs.writeFileSync(cleanPath,cuesToSrt(cleaned));
        sub=cleanPath;
        logJob(p.id,`Subtitle dirapikan: ${cleaned.length} cue (cue instrumental dipotong, overlap dihilangkan).`);
      }
      const args=['-y','-f','concat','-safe','0','-i',list,'-i',audioPath];
      const hasSubtitle=p.settings.includeSubtitles===true&&!!sub&&exists(sub);
      const escapeFilterPath=value=>path.resolve(value).replace(/\\/g,'\\\\').replace(/:/g,'\\:').replace(/'/g,"\\'").replace(/,/g,'\\,').replace(/\[/g,'\\[').replace(/\]/g,'\\]');
      const visualizerEnabled=p.settings.equalizerEnabled===true;
      if(visualizerEnabled){
        const vizHeight=Math.max(48,Math.round(h*Math.max(5,Math.min(40,Number(p.settings.equalizerHeight)||20))/100));
        const vizWidth=Math.max(160,Math.round(w*0.92));
        const vizX=Math.round((w-vizWidth)/2);
        const vizY=p.settings.equalizerPosition==='top'?0:p.settings.equalizerPosition==='center'?Math.round((h-vizHeight)/2):h-vizHeight;
        const opacity=Math.max(0,Math.min(100,Number(p.settings.equalizerOpacity??80)))/100;
        const color=({white:'white',cyan:'cyan',purple:'purple'})[p.settings.equalizerColor]||'white';
        // libass memakai PlayResY 288 untuk SRT, jadi MarginV (piksel video) harus diskalakan ke 288 agar subtitle tidak keluar layar.
        const subtitleMarginPx=vizHeight+Math.max(24,Math.round(h*0.02));
        const subtitleMargin=p.settings.equalizerPosition==='bottom'?Math.max(1,Math.min(250,Math.round(subtitleMarginPx*288/h))):undefined;
        const subtitleFilter=hasSubtitle?`subtitles=filename='${escapeFilterPath(sub)}'${subtitleMargin?`:force_style='Alignment=2,MarginV=${subtitleMargin}'`:''}`:'null';
        const visualizer=p.settings.equalizerStyle==='waveform'
          ?`showwaves=s=${vizWidth}x${vizHeight}:mode=line:rate=${fps}:colors=${color}`
          :`showfreqs=s=${vizWidth}x${vizHeight}:mode=bar:ascale=log:fscale=log:win_size=2048:colors=${color}`;
        args.push('-filter_complex',`[0:v]${subtitleFilter}[subbed];[1:a]asplit=2[aout][vizsrc];[vizsrc]${visualizer},colorkey=black:0.12:0.08,format=rgba,colorchannelmixer=aa=${opacity}[eq];[subbed][eq]overlay=${vizX}:${vizY}:format=auto[vout]`);
        args.push('-map','[vout]','-map','[aout]');
        logJob(p.id,`Equalizer aktif: ${p.settings.equalizerStyle==='waveform'?'garis':'bar'}, posisi ${p.settings.equalizerPosition}, tinggi ${vizHeight}px. Subtitle diberi jarak aman.`);
      }else{
        if(hasSubtitle)args.push('-vf',`subtitles=filename='${escapeFilterPath(sub)}'`);
        args.push('-map','0:v:0','-map','1:a:0');
      }
      args.push('-t',String(audioDuration),
        '-c:v','libx264','-preset',cfg.render.preset||'medium','-crf',String(cfg.render.crf||20),
        '-pix_fmt','yuv420p','-c:a','aac','-b:a','320k','-ar','48000','-movflags','+faststart',final);
      await run('ffmpeg',args,{onLog:s=>logJob(p.id,s.trim())});
      p.assets.renderManifest=rel(manifestPath,dir);
      p.assets.finalVideo=rel(final,dir);
      if(hasSubtitle){
        const finalSrt=final.replace(/\.mp4$/i,'.srt');
        if(['.srt'].includes(path.extname(sub).toLowerCase())){
          fs.copyFileSync(sub,finalSrt);
          p.assets.finalSubtitle=rel(finalSrt,dir);
          logJob(p.id,`File subtitle SRT disalin ke output: ${p.assets.finalSubtitle}`);
        }
      }
      updateStatus(p,'render',{file:p.assets.finalVideo,subtitle:p.assets.finalSubtitle||null,manifest:p.assets.renderManifest,orientation:p.settings.orientation,duration:audioDuration});
      logJob(p.id,`Render selesai. Durasi output mengikuti audio: ${audioDuration.toFixed(2)} detik; AAC 320 kbps.`);
    });
    res.json({ok:true,manifest:'render/render-manifest.json'});
  }catch(e){res.status(400).json({error:e.message})}
});
app.get('/api/projects/:id/file/:asset(*)',(req,res)=>{try{const dir=projectDir(req.params.id),file=path.resolve(dir,req.params.asset);if(!file.startsWith(dir+path.sep)||!exists(file))return res.status(404).end();res.sendFile(file)}catch{res.status(404).end()}});
app.get('/api/health',async(req,res)=>{
  const provider=selectedProvider(cfg.ai||{});
  let ollama=false,aiConfigured=false;
  if(provider==='ollama'){
    try{const r=await fetch(`${cfg.ollama?.url||'http://127.0.0.1:11434'}/api/tags`);ollama=r.ok;aiConfigured=ollama}catch{}
  }else if(provider==='openrouter'){
    aiConfigured=Boolean(process.env[cfg.ai?.apiKeyEnv||'OPENROUTER_API_KEY']);
  }
  res.json({ok:true,ollama,aiProvider:provider,aiConfigured,mediaRoot:mediaRoot(),hostname:os.hostname()});
});
const port=Number(process.env.PORT||8686);app.listen(port,'0.0.0.0',()=>console.log(`AI Storyboard Studio listening on :${port}`));
