import express from 'express';
import cron, { ScheduledTask } from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { executeUploadsForCompletedMerge, setYouTubeLogger } from './youtube-uploader';

const app = express();
const PORT = Number(process.env.PORT || 8585);
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
if (!process.env.SETTINGS_FILE) process.env.SETTINGS_FILE = SETTINGS_FILE;
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const SOURCE_STATUS_FILE = path.join(DATA_DIR, 'source-status.json');
const GENERATION_MARKER_NAMES = ['generation-status.json', '.generation-status.json'];
const MERGE_MARKER_NAME = 'merge-status.json';
const AUTO_CAPTION_DIR = process.env.AUTO_CAPTION_DIR || '/mnt/data/erfin/projects/auto-caption';
const DEMUCS_DIR = process.env.DEMUCS_DIR || '/mnt/data/erfin/projects/docker-facebook-demucs';
const DEMUCS_IMAGE = 'facebook-demucs-cpu';
const DEMUCS_OUTPUT_ROOT = process.env.DEMUCS_OUTPUT_ROOT ||
  '/mnt/data/erfin/projects/docker-facebook-demucs/output';

const youtubeLogs: string[] = [];

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve('public')));

export type Settings = {
  sourceDirectories: string[]; outputDirectory: string; videoAssetDirectory: string;
  scanMode: 'manual' | 'watch' | 'schedule' | 'both'; scanIntervalMinutes: number;
  dailyScheduleEnabled: boolean; dailyScheduleTime: string; timezone: string; parallelJobs: number;
  outputWidth: number; outputHeight: number; videoCodec: 'libx264' | 'libx265'; crf: number; preset: string;
  audioCodec: 'aac'; shortVideoPolicy: 'loop'; aspectPolicy: 'blur-background';
  blockWhenVideoAtLeastAudio: boolean; retryEnabled: boolean; retryLimit: number; stableFileSeconds: number;
  equalizerEnabled: boolean; equalizerStyle: 'bars'|'waveform'; equalizerPosition: 'bottom'|'center'|'top'; equalizerColor: 'white'|'cyan'|'purple'; equalizerOpacity: number; equalizerHeight: number;
  youtubeAutoUploadEnabled: boolean;
};
type JobStatus = 'ready' | 'blocked' | 'unstable' | 'queued' | 'processing' | 'completed' | 'failed';
type Job = {
  id: string; title: string; sourceRoot: string; titlePath: string; videoFiles: string[]; audioFile: string | null;
  videoDuration: number; audioDuration: number; fingerprint: string; status: JobStatus; progress: number; stage: string;
  message: string; outputFile: string; updatedAt: string; attempts: number; error: string | null;
  mergeEnabled: boolean; videoCategory: string;
  autoCaptionEnabled: boolean; autoCaptionLanguage: 'id' | 'en';
  /** Snapshot hasil scan: daftar kandidat untuk setiap kategori asset video. */
  videoFilesByCategory?: Record<string, string[]>;
  /** Total durasi kandidat per kategori, dihitung saat scan. */
  videoDurationByCategory?: Record<string, number>;
};
type UploadJob = {
  id: string;
  title: string;
  titlePath: string; // direktori sumber yang berisi merge-status.json
  outputFile: string;
  sourceFingerprint: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  error?: string | null;
};

const uploadQueue: UploadJob[] = [];
let activeUploads = 0;
const MAX_CONCURRENT_UPLOADS = 1;

async function processUploadQueue(): Promise<void> {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) return;
  const job = uploadQueue.find(j => j.status === 'queued');
  if (!job) return;

  job.status = 'processing';
  activeUploads++;
  try {
    logYouTube(`[UPLOAD-WORKER] Memulai pemeriksaan/upload: ${job.title}`);
    const result = await executeUploadsForCompletedMerge(job.titlePath);
    if (result.status === 'completed') {
      job.status = 'completed';
      job.error = null;
      logYouTube(`[UPLOAD-WORKER] Selesai: ${job.title}; semua channel completed dan uploaded=true.`);
    } else if (result.status === 'skipped') {
      job.status = 'failed';
      job.error = result.message;
      logYouTube(`[UPLOAD-WORKER] Dilewati/gagal validasi ${job.title}: ${result.message}`);
    } else {
      // Partial failure remains retryable. The uploader will skip any channel already completed.
      job.status = 'failed';
      job.error = result.message;
      job.attempts++;
      logYouTube(`[UPLOAD-WORKER] Upload belum lengkap ${job.title}: ${result.message}`);
    }
  } catch (e) {
    job.status = 'failed';
    job.error = e instanceof Error ? e.message : String(e);
    job.attempts++;
    logYouTube(`[UPLOAD-WORKER] Error ${job.title}: ${job.error}`);
  } finally {
    activeUploads--;
    // Hanya job queued berikutnya yang diproses. Job failed tidak di-loop tanpa henti;
    // scan berikutnya boleh memasukkannya kembali jika JSON masih menunjukkan channel belum lengkap.
    void processUploadQueue();
  }
}

function enqueueUpload(jobData: Omit<UploadJob, 'status' | 'attempts'>): void {
  const existingActive = uploadQueue.find(j =>
    j.titlePath === jobData.titlePath &&
    j.sourceFingerprint === jobData.sourceFingerprint &&
    (j.status === 'queued' || j.status === 'processing')
  );
  if (existingActive) return;

  // Jangan menahan retry hanya karena path yang sama pernah gagal/selesai.
  uploadQueue.push({ ...jobData, status: 'queued', attempts: 0 });
  logYouTube(`[UPLOAD-QUEUE] Ditambahkan: ${jobData.title}`);
  void processUploadQueue();
}

const defaults: Settings = {
  sourceDirectories: ['/mnt/data/media'], outputDirectory: path.resolve('output'), videoAssetDirectory: path.resolve('video'), scanMode: 'both',
  scanIntervalMinutes: 60, dailyScheduleEnabled: true, dailyScheduleTime: '02:00', timezone: 'Asia/Jakarta',
  parallelJobs: 1, outputWidth: 1920, outputHeight: 1080, videoCodec: 'libx264', crf: 20, preset: 'medium',
  audioCodec: 'aac', shortVideoPolicy: 'loop', aspectPolicy: 'blur-background', blockWhenVideoAtLeastAudio: true,
  retryEnabled: true, retryLimit: 2, stableFileSeconds: 30,
  equalizerEnabled: false, equalizerStyle: 'bars', equalizerPosition: 'bottom', equalizerColor: 'white', equalizerOpacity: 80, equalizerHeight: 22,
  youtubeAutoUploadEnabled: false
};
let settings: Settings = loadSettings();
let jobs: Record<string, Job> = loadJobs();
let intervalHandle: NodeJS.Timeout | undefined;
let dailyTask: ScheduledTask | undefined;
let running = 0;
let scanBusy = false;
let lastScanAt: string | null = null;
let lastScanSummary = 'Belum ada pemindaian.';
let logs: string[] = [];

function loadSettings(): Settings { try { return { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { return { ...defaults }; } }
function loadJobs(): Record<string, Job> {
  try {
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')) as Record<string, Job>;
    for (const j of Object.values(data)) if (j.status === 'processing' || j.status === 'queued') { j.status = 'ready'; j.progress = 0; j.stage = 'Menunggu'; j.message = 'Server restart sebelum pekerjaan selesai; perlu diproses ulang.'; }
    return data;
  } catch { return {}; }
}
function saveSettings(): void { atomicJson(SETTINGS_FILE, settings); }
function saveJobs(): void { atomicJson(JOBS_FILE, jobs); }
function saveSourceStatus(value: unknown): void { atomicJson(SOURCE_STATUS_FILE, value); }

type MergeMarker = { schemaVersion: number; title: string; status: 'pending'|'processing'|'completed'|'failed'; sourceFingerprint?: string; outputFile?: string; sourceVideoCount?: number; audioFile?: string|null; outputSizeBytes?: number; startedAt?: string; completedAt?: string; updatedAt: string; message?: string; error?: string|null };
function mergeMarkerPath(titlePath: string): string { return path.join(titlePath, MERGE_MARKER_NAME); }
function readMergeMarker(titlePath: string): MergeMarker | null {
  try { return JSON.parse(fs.readFileSync(mergeMarkerPath(titlePath), 'utf8')) as MergeMarker; } catch { return null; }
}
function writeMergeMarker(titlePath: string, value: MergeMarker): void { atomicJson(mergeMarkerPath(titlePath), value); }
async function readGenerationMarker(titlePath: string): Promise<{ exists: boolean; status: 'in_progress'|'completed'|'failed'|'unknown'; file: string|null; detail?: string }> {
  for (const name of GENERATION_MARKER_NAMES) {
    const file = path.join(titlePath, name);
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      const raw = String(parsed.status ?? parsed.generation_status ?? 'unknown').toLowerCase();
      const status = raw === 'completed' || raw === 'complete' || raw === 'done' ? 'completed' : raw === 'in_progress' || raw === 'generating' || raw === 'processing' ? 'in_progress' : raw === 'failed' || raw === 'error' ? 'failed' : 'unknown';
      return { exists: true, status, file, detail: typeof parsed.message === 'string' ? parsed.message : undefined };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { exists: true, status: 'unknown', file, detail: 'Marker JSON tidak valid atau tidak bisa dibaca.' };
    }
  }
  return { exists: false, status: 'unknown', file: null };
}
async function sourceFileReport(files: string[]): Promise<object[]> {
  const now = Date.now();
  return Promise.all(files.map(async file => {
    try {
      const st = await fs.promises.stat(file);
      const stableByAge = now - st.mtimeMs >= settings.stableFileSeconds * 1000;
      return { path: file, exists: true, sizeBytes: st.size, modifiedAt: st.mtime.toISOString(), ageSeconds: Math.floor((now-st.mtimeMs)/1000), stableByAge, state: stableByAge ? 'age_threshold_passed' : 'waiting_for_stability' };
    } catch (e) { return { path: file, exists: false, state: 'missing', error: (e as Error).message }; }
  }));
}
function atomicJson(file: string, value: unknown): void { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }
// Sumber kebenaran: merge-status.json di folder sumber, lalu youtube-upload-status.json
// di folder output video. Hanya merge completed yang boleh masuk antrean upload.
function scanAndQueuePendingUploads(): void {
  if (!settings.youtubeAutoUploadEnabled) {
    logYouTube('[UPLOAD-QUEUE] Auto-upload OFF; pemindaian antrean dilewati.');
    return;
  }
  try {
    for (const sourceRoot of settings.sourceDirectories) {
      if (!fs.existsSync(sourceRoot)) continue;
      for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const titlePath = path.join(sourceRoot, entry.name);
        const marker = readMergeMarker(titlePath);
        if (!marker || marker.status !== 'completed' || !marker.outputFile || !marker.sourceFingerprint) continue;
        const outputFile = path.resolve(marker.outputFile);
        let stat: fs.Stats;
        try { stat = fs.statSync(outputFile); } catch { continue; }
        if (!stat.isFile() || stat.size < 1024) continue;

        const statusFile = path.join(path.dirname(outputFile), 'youtube-upload-status.json');
        let summary: any = null;
        try { summary = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { /* missing/corrupt means not complete */ }
        const profiles = summary?.profiles || {};
        const isDone = (id: 'channel1' | 'channel2') => profiles[id]?.status === 'completed' && profiles[id]?.uploaded === true;
        if (isDone('channel1') && isDone('channel2')) continue;

        enqueueUpload({
          id: `scan-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
          title: marker.title || entry.name,
          titlePath,
          outputFile,
          sourceFingerprint: marker.sourceFingerprint,
        });
      }
    }
  } catch (err) {
    logYouTube(`[UPLOAD-QUEUE] Gagal memindai status upload: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function logYouTube(message: string): void {
  const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: settings.timezone });
  const formatted = `[${timestamp}] ${message}`;
  console.log(formatted);
  youtubeLogs.push(formatted);
  if (youtubeLogs.length > 200) youtubeLogs.shift();
  logs.unshift(formatted);
  logs = logs.slice(0, 150);
}
setYouTubeLogger(logYouTube);

function log(message: string): void {
  const line = `[${new Date().toLocaleString('sv-SE', {
    timeZone: settings.timezone
  })}] ${message}`;

  logs.unshift(line);
  logs = logs.slice(0, 150);

  console.log(line);
}

function validateSettings(input: any): Settings {
  const s: Settings = { ...settings, ...input };
  s.sourceDirectories = Array.isArray(input.sourceDirectories) ? [...new Set<string>(input.sourceDirectories.map((v: unknown) => String(v).trim()).filter((v: string) => Boolean(v)))] : settings.sourceDirectories;
  if (!s.sourceDirectories.length) throw new Error('Tambahkan minimal satu direktori sumber.');
  if (s.sourceDirectories.some((p: string) => !path.isAbsolute(p))) throw new Error('Semua direktori sumber harus berupa path absolut.');
  if (!path.isAbsolute(s.outputDirectory)) throw new Error('Direktori output harus berupa path absolut.');
  if (!path.isAbsolute(s.videoAssetDirectory)) throw new Error('Direktori asset video harus berupa path absolut.');
  if (!['manual','watch','schedule','both'].includes(s.scanMode)) throw new Error('Mode scan tidak valid.');
  if (!Number.isInteger(s.scanIntervalMinutes) || s.scanIntervalMinutes < 1 || s.scanIntervalMinutes > 1440) throw new Error('Interval scan harus 1–1440 menit.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.dailyScheduleTime)) throw new Error('Format jadwal harus HH:MM.');
  if (!Number.isInteger(s.parallelJobs) || s.parallelJobs < 1 || s.parallelJobs > 8) throw new Error('Jumlah proses paralel harus 1–8.');
  if (![720,1080,1440,2160].includes(Number(s.outputHeight)) || Number(s.outputWidth) !== Math.round(Number(s.outputHeight) * 16 / 9)) throw new Error('Resolusi harus menggunakan profil 16:9 yang didukung.');
  if (!Number.isInteger(s.crf) || s.crf < 16 || s.crf > 30) throw new Error('CRF harus 16–30.');
  if (!['ultrafast','veryfast','faster','fast','medium','slow','slower'].includes(s.preset)) throw new Error('Preset encoding tidak valid.');
  if (!Number.isInteger(s.retryLimit) || s.retryLimit < 0 || s.retryLimit > 10) throw new Error('Batas retry harus 0–10.');
  if (!Number.isInteger(s.stableFileSeconds) || s.stableFileSeconds < 5 || s.stableFileSeconds > 3600) throw new Error('Stabilitas file harus 5–3600 detik.');
  if (typeof s.equalizerEnabled !== 'boolean') throw new Error('Status equalizer tidak valid.');
  if (!['bars','waveform'].includes(s.equalizerStyle)) throw new Error('Jenis equalizer tidak valid.');
  if (!['bottom','center','top'].includes(s.equalizerPosition)) throw new Error('Posisi equalizer tidak valid.');
  if (!['white','cyan','purple'].includes(s.equalizerColor)) throw new Error('Warna equalizer tidak valid.');
  if (!Number.isInteger(s.equalizerOpacity) || s.equalizerOpacity < 10 || s.equalizerOpacity > 100) throw new Error('Opacity equalizer harus 10–100%.');
  if (!Number.isInteger(s.equalizerHeight) || s.equalizerHeight < 10 || s.equalizerHeight > 50) throw new Error('Tinggi equalizer harus 10–50%.');
  if (typeof s.youtubeAutoUploadEnabled !== 'boolean') {
    throw new Error('Status upload otomatis YouTube tidak valid.');
  }
  s.outputHeight = Number(s.outputHeight); s.outputWidth = Number(s.outputWidth); s.parallelJobs = Number(s.parallelJobs);
  return s;
}
const VIDEO_EXT = new Set(['.mp4','.mkv','.mov','.avi','.webm','.m4v','.mpeg','.mpg','.ts','.mts']);
const AUDIO_EXT = new Set(['.mp3','.m4a','.aac','.flac','.wav','.ogg','.opus','.wma']);
function hash(value: string): string { return crypto.createHash('sha1').update(value).digest('hex').slice(0, 20); }
function secondsText(n: number): string { const ms = Math.round(n * 1000); const h = Math.floor(ms / 3600000); const m = Math.floor(ms % 3600000 / 60000); const s = Math.floor(ms % 60000 / 1000); const milli = ms % 1000; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(milli).padStart(3,'0')}`; }
async function probeDuration(file: string): Promise<number> {
  const { stdout } = await runCommand('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file]);
  const n = Number(stdout.trim()); if (!Number.isFinite(n) || n <= 0) throw new Error(`Durasi tidak valid: ${path.basename(file)}`); return n;
}
function runCommand(
  binary: string,
  args: string[],
  onProgress?: (seconds: number) => void,
  duration?: number,
  options: { cwd?: string } = {}
): Promise<{stdout:string;stderr:string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      stdio: ['ignore','pipe','pipe']
    });
    let stdout = '', stderr = '', progressSeconds = 0;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-100_000);
      for (const line of chunk.split(/\r?\n/)) {
        const m = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) { progressSeconds = Number(m[1])*3600 + Number(m[2])*60 + Number(m[3]); if (onProgress && duration) onProgress(Math.min(1, progressSeconds/duration)); }
        const ms = line.match(/^out_time_ms=(\d+)/);
        if (ms && !m) { progressSeconds = Number(ms[1])/1_000_000; if (onProgress && duration) onProgress(Math.min(1, progressSeconds/duration)); }
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${binary} keluar dengan kode ${code}: ${stderr.slice(-1800)}`)));
  });
}

// Jalankan Demucs pada MP3 sumber, lalu AutoCaption pada video sementara
// yang memakai track vocals. Video final tetap memakai audio MP3 asli.
async function findFileRecursive(root: string, predicate: (file: string) => boolean): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && predicate(full)) return full;
    if (entry.isDirectory()) {
      const nested = await findFileRecursive(full, predicate);
      if (nested) return nested;
    }
  }
  return null;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function prepareAutoCaption(
  job: Job,
  workDir: string,
  combinedVideo: string
): Promise<string> {
  if (!job.audioFile) {
    throw new Error('AutoCaption: file audio sumber tidak ditemukan.');
  }

  const language = job.autoCaptionLanguage === 'en' ? 'en' : 'id';
  const audioDirectory = path.dirname(job.audioFile);
  const audioName = path.basename(job.audioFile);
  const audioStem = path.parse(audioName).name;

  // Lokasi hasil Demucs permanen
  const demucsTrackDirectory = path.join(
    DEMUCS_OUTPUT_ROOT,
    'htdemucs',
    audioStem
  );

  const modelsDirectory = path.join(DEMUCS_DIR, 'models');

  // Symlink hasil Demucs ke workDir
  const demucsOutput = path.join(workDir, 'demucs-output');

  await fs.promises.mkdir(DEMUCS_OUTPUT_ROOT, { recursive: true });
  await fs.promises.mkdir(modelsDirectory, { recursive: true });

  // Hapus hasil lama untuk menghindari penggunaan track yang kedaluwarsa
  await fs.promises.rm(demucsTrackDirectory, {
    recursive: true,
    force: true
  });

  updateJob(job, {
    stage: 'Memisahkan vokal dengan Demucs',
    message: `Memisahkan audio ${audioName} menggunakan Demucs.`,
    progress: 71
  });

  log(`[AUTOCAPTION] Demucs mulai: ${job.title}; input=${job.audioFile}`);

  const demucsCommand =
    `demucs --mp3 -n htdemucs -o /data/output /data/input/${shellQuote(audioName)}`;

  // Jalankan Demucs dan simpan hasil ke folder proyek Demucs
  await runCommand('docker', [
    'run', '--rm',
    '--user', '1000:1000',
    '-v', `${audioDirectory}:/data/input:ro`,
    '-v', `${DEMUCS_OUTPUT_ROOT}:/data/output`,
    '-v', `${modelsDirectory}:/data/models`,
    DEMUCS_IMAGE,
    '-c', demucsCommand
  ]);

  // Pastikan hasil vokal tersedia
  const originalVocalsFile = path.join(
    demucsTrackDirectory,
    'vocals.mp3'
  );

  if (!fs.existsSync(originalVocalsFile)) {
    throw new Error(
      `Demucs selesai tetapi vocals.mp3 tidak ditemukan: ${originalVocalsFile}`
    );
  }

  // Buat symlink hasil Demucs ke workDir
  await fs.promises.rm(demucsOutput, {
    recursive: true,
    force: true
  });

  await fs.promises.symlink(
    demucsTrackDirectory,
    demucsOutput,
    'dir'
  );

  const vocalsFile = path.join(demucsOutput, 'vocals.mp3');

  log(`[AUTOCAPTION] Hasil Demucs: ${demucsTrackDirectory}`);
  log(`[AUTOCAPTION] Symlink: ${demucsOutput}`);
  log(`[AUTOCAPTION] Track vokal siap: ${vocalsFile}`);

  const captionInput = path.join(workDir, 'caption-source.mp4');

  await fs.promises.rm(captionInput, { force: true });

  for (const ext of ['.srt', '.ass', '.ssa', '.vtt']) {
    await fs.promises.rm(
      path.join(workDir, `caption-source${ext}`),
      { force: true }
    );
  }

  updateJob(job, {
    stage: 'Menyiapkan sumber AutoCaption',
    message: 'Menggabungkan video sementara dengan track vokal Demucs.',
    progress: 73
  });

  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-stream_loop', '-1', '-i', combinedVideo,
    '-i', vocalsFile,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-t', String(job.audioDuration),
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    captionInput
  ]);

  updateJob(job, {
    stage: `Membuat subtitle AutoCaption (${language})`,
    message: 'Transkripsi berjalan; --no-burn hanya menghasilkan file subtitle.',
    progress: 74
  });

  log(
    `[AUTOCAPTION] Menjalankan bahasa=${language}, model=medium, highlight=00FF88, position=mid, no-burn=ON`
  );

  const bashScript = 'exec autocaption "$@"';

  await runCommand('bash', [
    '-lc',
    bashScript,
    'autocaption',
    captionInput,
    '--language', language,
    '--model', 'medium',
    '--highlight-color', '00FF88',
    '--position', 'mid',
    '--no-burn'
  ], undefined, undefined, { cwd: AUTO_CAPTION_DIR });

  const generatedSubtitle = await findFileRecursive(
    workDir,
    file => {
      const ext = path.extname(file).toLowerCase();

      return path.basename(file).toLowerCase().startsWith('caption-source') &&
        ['.srt', '.ass', '.ssa', '.vtt'].includes(ext);
    }
  );

  if (!generatedSubtitle) {
    throw new Error(
      'AutoCaption selesai tetapi file subtitle (.srt/.ass/.ssa/.vtt) tidak ditemukan.'
    );
  }

  const subtitleExtension = path.extname(generatedSubtitle).toLowerCase();

  const subtitleDirectory = path.join(
    path.dirname(job.outputFile),
    'subtitles'
  );

  await fs.promises.mkdir(subtitleDirectory, {
    recursive: true
  });

  const subtitleDestination = path.join(
    subtitleDirectory,
    `${path.parse(job.outputFile).name}${subtitleExtension}`
  );

  await fs.promises.copyFile(
    generatedSubtitle,
    subtitleDestination
  );

  log(`[AUTOCAPTION] Subtitle tersimpan: ${subtitleDestination}`);

  return subtitleDestination;
}

// Integrasi aligned lyrics bersifat opsional: file hilang/JSON rusak/tidak ada token valid
// tidak boleh menggagalkan merge. Format utama: <titlePath>/aligned-lyrics.json.
type AlignedLyricToken = { word: string; start_s: number; end_s: number };
type SubtitleCue = { start: number; end: number; text: string };

function stripLyricMetadata(value: string): string {
  return value
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    // Hilangkan label bagian seperti [Verse 1], [Chorus], [Instrumental Intro].
    .filter(line => line && !/^\[[^\]]*\]$/.test(line))
    .join(' ')
    // Transliteration Latin di dalam kurung tidak ditampilkan.
    .replace(/\s*\([^)]*[A-Za-z][^)]*\)/g, '')
    .replace(/[{}]/g, ch => ch === '{' ? '〔' : '〕')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAlignedTokens(parsed: any, duration: number): AlignedLyricToken[] {
  const raw: any = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.words) ? parsed.words
    : Array.isArray(parsed?.aligned_lyrics) ? parsed.aligned_lyrics
    : Array.isArray(parsed?.alignedLyrics) ? parsed.alignedLyrics
    : Array.isArray(parsed?.data) ? parsed.data
    : Array.isArray(parsed?.data?.words) ? parsed.data.words
    : null;
  if (!raw) throw new Error('Struktur JSON tidak berisi array aligned lyrics yang dikenali.');

  const tokens: AlignedLyricToken[] = [];
  for (const item of raw) {
    if (!item || typeof item.word !== 'string') continue;
    const word = stripLyricMetadata(item.word);
    const start = Number(item.start_s);
    const end = Number(item.end_s);
    if (!word || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0 || end <= start || start >= duration) continue;
    // Alignment kadang mengeluarkan rentang rusak yang membentang puluhan/delapan puluh detik.
    if (end - start > 12) continue;
    if (start > duration + 0.25) continue;
    const boundedEnd = Math.min(end, duration);
    if (boundedEnd - start < 0.025) continue;
    tokens.push({ word, start_s: start, end_s: boundedEnd });
  }
  return tokens.sort((a, b) => a.start_s - b.start_s || a.end_s - b.end_s);
}

function joinLyricTokens(tokens: AlignedLyricToken[]): string {
  let text = '';
  for (const token of tokens) {
    const word = token.word;
    if (!text) { text = word; continue; }
    const previousChars = [...text];
    const previousChar = previousChars[previousChars.length - 1] || '';
    const firstChar = [...word][0] || '';
    const punctuationOnly = /^[,.;:!?，。！？、…]+$/.test(word);
    const bothThai = /[\u0E00-\u0E7F]/.test(previousChar) && /[\u0E00-\u0E7F]/.test(firstChar);
    const needsSpace = !punctuationOnly && !bothThai && !/\s$/.test(text) && !/^['’)]/.test(word);
    text += (needsSpace ? ' ' : '') + word;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function buildSubtitleCues(tokens: AlignedLyricToken[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let group: AlignedLyricToken[] = [];
  const flush = () => {
    if (!group.length) return;
    const text = joinLyricTokens(group);
    const start = group[0].start_s;
    const end = group[group.length - 1].end_s;
    if (text && end > start) cues.push({ start, end, text });
    group = [];
  };

  for (const token of tokens) {
    if (!group.length) { group.push(token); continue; }
    const currentText = joinLyricTokens(group);
    const previous = group[group.length - 1];
    const gap = token.start_s - previous.end_s;
    const prospective = joinLyricTokens([...group, token]);
    const endsWithPunctuation = /[.!?。！？…]$/.test(currentText);
    if (gap > 0.72 || endsWithPunctuation || prospective.length > 42 || token.end_s - group[0].start_s > 5.8) {
      flush();
    }
    group.push(token);
  }
  flush();
  return cues;
}

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const centi = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(centi).padStart(2, '0')}`;
}

function assEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '〔').replace(/\}/g, '〕').replace(/\n/g, ' ');
}

function escapeFilterPath(file: string): string {
  return file.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

async function prepareAlignedLyrics(job: Job, workDir: string): Promise<string | null> {
  const audioBase = job.audioFile ? path.basename(job.audioFile, path.extname(job.audioFile)) : job.title;
  const candidates = [
    path.join(job.titlePath, 'aligned-lyrics.json'),
    path.join(job.titlePath, 'aligned_lyrics.json'),
    path.join(job.titlePath, 'alignedLyrics.json'),
    path.join(job.titlePath, `${job.title}.aligned-lyrics.json`),
    path.join(job.titlePath, 'audio', `${audioBase}.aligned-lyrics.json`),
    path.join(job.titlePath, 'audio', 'aligned-lyrics.json')
  ];

  let parsed: any = null;
  let selectedFile: string | null = null;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const raw = await fs.promises.readFile(candidate, 'utf8');
      parsed = JSON.parse(raw);
      selectedFile = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      log(`[LYRICS] JSON tidak dapat dibaca (${candidate}); akan mencoba merge tanpa subtitle jika tidak ada file valid lain.`);
    }
  }

  if (!selectedFile) {
    log(`[LYRICS] ${job.title}: aligned-lyrics.json tidak ditemukan; merge berjalan tanpa subtitle.`);
    return null;
  }

  try {
    const tokens = extractAlignedTokens(parsed, job.audioDuration);
    const cues = buildSubtitleCues(tokens);
    if (!cues.length) {
      log(`[LYRICS] ${job.title}: JSON ditemukan (${selectedFile}) tetapi tidak ada timing/teks valid; merge berjalan tanpa subtitle.`);
      return null;
    }

    // Beberapa build FFmpeg tidak menyertakan libass. Dalam kasus itu, lanjutkan
    // merge normal alih-alih menggagalkan pekerjaan hanya karena subtitle.
    try {
      const filterList = await runCommand('ffmpeg', ['-hide_banner', '-filters']);
      if (!/\bsubtitles\s+V->V/.test(`${filterList.stdout}\n${filterList.stderr}`)) {
        log(`[LYRICS] Filter subtitles/libass tidak tersedia; merge ${job.title} diteruskan tanpa subtitle.`);
        return null;
      }
    } catch (error) {
      log(`[LYRICS] Tidak bisa memeriksa dukungan subtitle FFmpeg (${error instanceof Error ? error.message : String(error)}); merge diteruskan tanpa subtitle.`);
      return null;
    }

    const assFile = path.join(workDir, 'aligned-lyrics.ass');

    const lyricsMarginV =
      settings.equalizerEnabled && settings.equalizerPosition === 'bottom'
        ? (() => {
            const visualizerHeight = Math.max(
              80,
              Math.round(
                settings.outputHeight * settings.equalizerHeight / 100 / 2
              ) * 2
            );

            // Harus sama dengan rumus posisi overlay equalizer.
            const visualizerTop =
              settings.outputHeight -
              visualizerHeight -
              settings.outputHeight * 0.06;

            // Jarak lirik dari bagian atas area equalizer.
            const gap = Math.max(
              24,
              Math.round(settings.outputHeight * 0.02)
            );

            // ASS menghitung MarginV dari bawah layar.
            return Math.round(
              settings.outputHeight - visualizerTop + gap
            );
          })()
        : Math.round(settings.outputHeight * 0.065);

    const ass = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'WrapStyle: 2',
      'ScaledBorderAndShadow: yes',
      `PlayResX: ${settings.outputWidth}`,
      `PlayResY: ${settings.outputHeight}`,
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: Lyrics,Noto Sans Thai,${Math.max(26, Math.round(settings.outputHeight * 0.038))},&H00FFFFFF,&H0000FFFF,&H00101010,&H78000000,0,0,0,0,100,100,0,0,1,2.5,0.8,2,70,70,${lyricsMarginV},1`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...cues.map(cue => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Lyrics,,0,0,0,,${assEscape(cue.text)}`),
      ''
    ].join('\n');
    await fs.promises.writeFile(assFile, ass, 'utf8');
    log(`[LYRICS] ${job.title}: ${cues.length} subtitle per baris dibuat dari ${path.basename(selectedFile)}; transliterasi dan label bagian disembunyikan.`);
    return assFile;
  } catch (error) {
    log(`[LYRICS] ${job.title}: JSON lirik rusak/tidak cocok (${error instanceof Error ? error.message : String(error)}); merge berjalan tanpa subtitle.`);
    return null;
  }
}
async function listVideoCategories(): Promise<string[]> {
  try {
    return (await fs.promises.readdir(settings.videoAssetDirectory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch {
    return [];
  }
}
async function listVideoFilesForCategory(category = 'default'): Promise<string[]> {
  const safeCategory = path.basename(category || 'default');
  const videoDir = path.join(settings.videoAssetDirectory, safeCategory);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(videoDir, { withFileTypes: true });
  } catch {
    throw new Error(`Folder asset video tidak ditemukan: ${videoDir}`);
  }
  return entries
    .filter(x => x.isFile() && VIDEO_EXT.has(path.extname(x.name).toLowerCase()))
    .map(x => path.join(videoDir, x.name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

async function listMedia(titlePath: string, category = 'default'): Promise<{videos:string[];audio:string|null}> {
  // Audio berasal dari folder judul; daftar kandidat video berasal dari folder kategori assets.
  const audioEntries = await fs.promises.readdir(titlePath, { withFileTypes: true });
  const audios = audioEntries
    .filter(x => x.isFile() && AUDIO_EXT.has(path.extname(x.name).toLowerCase()))
    .map(x => path.join(titlePath, x.name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const videos = await listVideoFilesForCategory(category);
  return { videos, audio: audios[0] || null };
}
function shuffleWithoutReplacement<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  // Keep each source path at most once in one generated sequence.
  return [...new Map(result.map(item => [String(item), item])).values()];
}
async function fileFingerprint(files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const f of files) { const s = await fs.promises.stat(f); parts.push(`${f}:${s.size}:${s.mtimeMs}`); }
  return hash(parts.join('|'));
}
async function stableFiles(files: string[]): Promise<boolean> {
  const now = Date.now();
  for (const f of files) { const st = await fs.promises.stat(f); if (now - st.mtimeMs < settings.stableFileSeconds * 1000) return false; }
  return true;
}
async function scanSources(autoQueue = false): Promise<void> {
  if (scanBusy) return;
  scanBusy = true;
  lastScanAt = new Date().toISOString();
  let roots = 0, discovered = 0, invalid = 0, blocked = 0, queuedCount = 0;

  try {
    // Scan direktori assets satu kali per pemindaian. Setiap job menyimpan snapshot
    // semua kategori agar dropdown kategori langsung bisa dipakai tanpa scan ulang.
    const availableCategories = await listVideoCategories();
    const categories = availableCategories.length
      ? availableCategories
      : (await fs.promises.stat(settings.videoAssetDirectory).catch(() => null)) ? ['default'] : [];
    const videoFilesByCategory: Record<string, string[]> = {};
    const videoDurationByCategory: Record<string, number> = {};
    const categoryErrors: Record<string, string> = {};

    for (const category of categories) {
      try {
        const videos = await listVideoFilesForCategory(category);
        videoFilesByCategory[category] = videos;
        try {
          const durations = await Promise.all(videos.map(probeDuration));
          videoDurationByCategory[category] = durations.reduce((sum, duration) => sum + duration, 0);
        } catch (error) {
          videoDurationByCategory[category] = 0;
          categoryErrors[category] = (error as Error).message;
        }
        log(`[ASSET-SCAN] Kategori "${category}": ${videos.length} video kandidat ditemukan di ${path.join(settings.videoAssetDirectory, category)}.`);
      } catch (error) {
        categoryErrors[category] = (error as Error).message;
        videoFilesByCategory[category] = [];
        videoDurationByCategory[category] = 0;
      }
    }

    for (const root of settings.sourceDirectories) {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
        roots++;
      } catch (error) {
        log(`Tidak bisa membaca sumber ${root}: ${(error as Error).message}`);
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const titlePath = path.join(root, entry.name);
        try {
          const id = hash(titlePath);
          const old = jobs[id];
          const preferredCategory = old?.videoCategory || 'default';
          const videoCategory = categories.includes(preferredCategory) && (videoFilesByCategory[preferredCategory] || []).length
            ? preferredCategory
            : categories.includes('default') && (videoFilesByCategory.default || []).length
              ? 'default'
              : (categories.find(category => (videoFilesByCategory[category] || []).length > 0) || preferredCategory || 'default');
          const videos = videoFilesByCategory[videoCategory] || [];
          const audioEntries = await fs.promises.readdir(titlePath, { withFileTypes: true });
          const audios = audioEntries
            .filter(x => x.isFile() && AUDIO_EXT.has(path.extname(x.name).toLowerCase()))
            .map(x => path.join(titlePath, x.name))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
          const audio = audios[0] || null;

          if (!videos.length || !audio) {
            invalid++;
            log(`[SCAN] Lewati "${entry.name}": ${!audio ? 'audio tidak ditemukan' : `kategori "${videoCategory}" tidak memiliki video`}.`);
            continue;
          }

          const files = [...videos, audio];
          const fingerprint = hash(`${await fileFingerprint(files)}|category:${videoCategory}`);
          const generationMarker = await readGenerationMarker(titlePath);
          let videoDuration = videoDurationByCategory[videoCategory] || 0;
          let audioDuration = 0;
          let analysisError: string | null = categoryErrors[videoCategory] || null;
          try {
            audioDuration = await probeDuration(audio);
            if (categoryErrors[videoCategory]) throw new Error(categoryErrors[videoCategory]);
          } catch (error) {
            analysisError = (error as Error).message;
          }
                    
          const changed = !old || old.fingerprint !== fingerprint;

          const outputFile = path.join(
            settings.outputDirectory,
            entry.name,
            `${entry.name}.mp4`
          );

          const mergeMarker = readMergeMarker(titlePath);
          const markerOutput = mergeMarker?.outputFile || outputFile;

          // Output dianggap selesai jika marker completed menunjuk ke output
          // yang benar dan file output masih valid.
          let markerOutputValid = false;

          try {
            const resolvedMarkerOutput = path.resolve(markerOutput);
            const resolvedExpectedOutput = path.resolve(outputFile);
            const outputStat = await fs.promises.stat(resolvedMarkerOutput);

            markerOutputValid =
              resolvedMarkerOutput === resolvedExpectedOutput &&
              outputStat.isFile() &&
              outputStat.size >= 1024;
          } catch {
            markerOutputValid = false;
          }

          const completedOutputExists = Boolean(
            mergeMarker?.status === 'completed' && markerOutputValid
          );

          const markerMatchesSource = Boolean(
            completedOutputExists &&
            mergeMarker?.sourceFingerprint === fingerprint
          );

          let status: JobStatus = 'ready';
          let message = 'Siap dianalisis dan diproses.';

          // PRIORITAS UTAMA:
          // Hasil yang sudah completed dan outputnya valid tidak boleh
          // dikembalikan ke ready hanya karena fingerprint berubah.
          if (completedOutputExists) {
            status = 'completed';

            message = markerMatchesSource
              ? 'Merge sudah selesai; output valid dan fingerprint sumber cocok. Tidak diproses ulang.'
              : 'Merge sebelumnya sudah selesai dan output masih valid. Fingerprint berubah, tetapi merge ulang otomatis dicegah.';
          } else if (
            generationMarker.exists &&
            generationMarker.status === 'in_progress'
          ) {
            status = 'unstable';
            message = 'Generator masih memproses sumber; menunggu status completed.';
          } else if (
            generationMarker.exists &&
            generationMarker.status === 'failed'
          ) {
            status = 'failed';
            message = generationMarker.detail || 'Generator menandai pembuatan sumber gagal.';
          } else if (
            generationMarker.exists &&
            generationMarker.status === 'unknown'
          ) {
            status = 'unstable';
            message = generationMarker.detail ||
              'generation-status.json tidak memiliki status yang dikenali.';
          } else if (analysisError) {
            status = 'failed';
            message = 'Gagal menganalisis media.';
          } else if (!(await stableFiles(files))) {
            status = 'unstable';
            message = 'File masih baru/berubah; menunggu stabil.';
          } else if (
            old &&
            !changed &&
            old.status === 'completed' &&
            fs.existsSync(old.outputFile) &&
            !mergeMarker
          ) {
            // Kompatibilitas untuk hasil lama yang belum memiliki marker.
            status = 'completed';
            message = 'Output lama tersedia dan sumber tidak berubah; status completed dipulihkan.';
          } else if (
            mergeMarker?.status === 'processing' &&
            !changed
          ) {
            status = 'ready';
            message = 'Proses sebelumnya terputus dan output belum terkonfirmasi selesai; perlu diproses ulang.';
          } else if (mergeMarker?.status === 'completed') {
            // Marker completed ada, tetapi output hilang/tidak valid.
            status = 'ready';
            message = 'Marker completed ditemukan, tetapi output hilang atau tidak valid; perlu dibuat ulang.';
          } else if (old && !changed && old.status === 'processing') {
            status = 'processing';
            message = old.message;
          }

          const job: Job = {
            id,
            title: entry.name,
            sourceRoot: root,
            titlePath,
            videoFiles: [...videos],
            videoFilesByCategory: Object.fromEntries(
              Object.entries(videoFilesByCategory).map(
                ([key, value]) => [key, [...value]]
              )
            ),
            videoDurationByCategory: { ...videoDurationByCategory },
            audioFile: audio,
            videoDuration,
            audioDuration,
            fingerprint,

            // Marker completed + output valid selalu menang atas status lama.
            status: completedOutputExists
              ? 'completed'
              : (
                  changed && old?.status === 'completed'
                    ? status
                    : (
                        old &&
                        !changed &&
                        ['failed', 'queued', 'processing'].includes(old.status)
                          ? old.status
                          : status
                      )
                ),

            progress: completedOutputExists
              ? 100
              : changed
                ? 0
                : (old?.progress || 0),

            stage: completedOutputExists
              ? 'Selesai'
              : changed
                ? 'Analisis selesai'
                : (old?.stage || 'Analisis selesai'),

            message: completedOutputExists
              ? message
              : changed
                ? message
                : (old?.message || message),

            outputFile,
            updatedAt: new Date().toISOString(),
            attempts: completedOutputExists
              ? (old?.attempts || 0)
              : changed
                ? 0
                : (old?.attempts || 0),
            error: completedOutputExists ? null : analysisError,
            mergeEnabled: old?.mergeEnabled === true,
            videoCategory,
            autoCaptionEnabled: old?.autoCaptionEnabled === true,
            autoCaptionLanguage: old?.autoCaptionLanguage === 'en' ? 'en' : 'id'
          };

          // Jangan mempertahankan status queued/processing jika marker dan output
          // sudah membuktikan bahwa pekerjaan tersebut selesai.
          if (
            !completedOutputExists &&
            (old?.status === 'processing' || old?.status === 'queued')
          ) {
            jobs[id] = {
              ...old,
              videoFilesByCategory: job.videoFilesByCategory,
              videoDurationByCategory: job.videoDurationByCategory
            };
          } else {
            jobs[id] = job;
          }

          const currentJob = jobs[id];

          if (currentJob.status === 'completed') {
            // Jangan mengganti fingerprint marker completed yang sudah valid.
            // Itu mencegah scan berikutnya menganggap hasil lama sebagai hasil
            // merge dari sumber yang berubah.
            if (!completedOutputExists) {
              let outputSizeBytes: number | undefined;

              try {
                outputSizeBytes = (
                  await fs.promises.stat(currentJob.outputFile)
                ).size;
              } catch {
                // Output diperiksa ulang pada scan berikutnya.
              }

              writeMergeMarker(titlePath, {
                schemaVersion: 1,
                title: entry.name,
                status: 'completed',
                sourceFingerprint: fingerprint,
                outputFile: currentJob.outputFile,
                sourceVideoCount: videos.length,
                audioFile: audio,
                outputSizeBytes,
                updatedAt: new Date().toISOString(),
                completedAt: mergeMarker?.completedAt || new Date().toISOString(),
                message: 'Output tersedia dan status completed dipulihkan.'
              });
            }
          } else if (
            !mergeMarker ||
            mergeMarker.sourceFingerprint !== fingerprint ||
            mergeMarker.status === 'completed'
          ) {
            writeMergeMarker(titlePath, {
              schemaVersion: 1,
              title: entry.name,
              status: currentJob.status === 'failed' ? 'failed' : 'pending',
              sourceFingerprint: fingerprint,
              outputFile,
              sourceVideoCount: videos.length,
              audioFile: audio,
              updatedAt: new Date().toISOString(),
              message: currentJob.message,
              error: currentJob.error
            });
          }

          discovered++;
          if (autoQueue && jobs[id].mergeEnabled && jobs[id].status === 'ready') { queueJob(id); queuedCount++; }
        } catch (error) {
          invalid++;
          log(`Lewati ${titlePath}: ${(error as Error).message}`);
        }
      }
    }

    saveJobs();
    const sourceReport = await Promise.all(Object.values(jobs).map(async job => {
      const marker = await readGenerationMarker(job.titlePath);
      const merge = readMergeMarker(job.titlePath);
      return {
        id: job.id, title: job.title, titlePath: job.titlePath, status: job.status,
        mergeEnabled: job.mergeEnabled, videoCategory: job.videoCategory, message: job.message,
        mergeStatus: merge?.status || 'pending', mergeMarker: mergeMarkerPath(job.titlePath),
        mergeSourceFingerprint: merge?.sourceFingerprint || null, generatedStatus: marker.status,
        generationMarker: marker.file, generationMarkerPresent: marker.exists, fingerprint: job.fingerprint,
        videoDurationSeconds: job.videoDuration, audioDurationSeconds: job.audioDuration,
        videoAssetCategories: Object.fromEntries(Object.entries(job.videoFilesByCategory || {}).map(([category, files]) => [category, { count: files.length, directory: path.join(settings.videoAssetDirectory, category) }])),
        files: await sourceFileReport([...(job.videoFilesByCategory?.[job.videoCategory] || job.videoFiles), ...(job.audioFile ? [job.audioFile] : [])]),
        checkedAt: new Date().toISOString()
      };
    }));
    saveSourceStatus({ schemaVersion: 1, generatedAt: new Date().toISOString(), stableFileSeconds: settings.stableFileSeconds, note: 'Scan mencatat audio dari folder sumber dan daftar video untuk seluruh kategori di direktori assets; kategori dapat diganti memakai snapshot scan terbaru.', videoAssetDirectory: settings.videoAssetDirectory, categories: Object.fromEntries(Object.entries(videoFilesByCategory).map(([category, files]) => [category, { count: files.length, directory: path.join(settings.videoAssetDirectory, category) }])), titles: sourceReport });
    lastScanSummary = `${roots} direktori sumber terbaca; ${discovered} judul terdeteksi; ${blocked} diblokir oleh aturan durasi; ${invalid} folder tidak valid; ${queuedCount} masuk antrean otomatis; ${categories.length} kategori assets dipindai.`;
    log(`Scan ${autoQueue ? 'otomatis' : 'manual'} selesai: ${lastScanSummary}`);
  } finally {
    scanBusy = false;
  }
}
function queueJob(id: string): void {
  const job = jobs[id]; if (!job || !['ready','failed'].includes(job.status)) return;
  job.status='queued'; job.progress=0; job.stage='Dalam antrean'; job.message='Menunggu slot encoding.'; job.error=null; job.updatedAt=new Date().toISOString(); saveJobs();
  void pumpQueue();
}
async function pumpQueue(): Promise<void> {
  while (running < settings.parallelJobs) {
    const job = Object.values(jobs).find(j=>j.status==='queued'); if (!job) return;
    running++; job.status='processing'; job.stage='Memulai'; job.message='Pekerjaan dimulai.'; job.updatedAt=new Date().toISOString(); saveJobs();
    void processJob(job).finally(()=>{ running--; void pumpQueue(); });
  }
}
function updateJob(job: Job, patch: Partial<Job>): void { Object.assign(job, patch, {updatedAt:new Date().toISOString()}); saveJobs(); }

interface SelectedVideo {
  file: string;
  duration: number;
}

interface VideoSelection {
  videos: SelectedVideo[];
  totalDuration: number;
  sourceCount: number;
}

/**
 * Memilih klip random tanpa duplikasi hingga
 * durasi mencukupi audio.
 *
 * Jika seluruh video sudah digunakan tetapi durasi
 * masih kurang, seluruh urutan terpilih dapat diulang
 * nantinya pada daftar concat.
 */
async function selectRandomVideosForAudio(
  videoFiles: string[],
  audioDuration: number
): Promise<VideoSelection> {
  if (!videoFiles.length) {
    throw new Error('Tidak ada video sumber.');
  }

  if (!Number.isFinite(audioDuration) || audioDuration <= 0) {
    throw new Error('Durasi audio tidak valid.');
  }

  // Acak urutan kandidat.
  const shuffled = shuffleWithoutReplacement(videoFiles);

  const selected: SelectedVideo[] = [];
  let totalDuration = 0;

  for (const file of shuffled) {
    // Sudah mencukupi durasi audio.
    if (totalDuration >= audioDuration) {
      break;
    }

    const duration = await probeDuration(file);

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(
        `Durasi video tidak valid: ${path.basename(file)}`
      );
    }

    selected.push({
      file,
      duration
    });

    totalDuration += duration;
  }

  if (!selected.length) {
    throw new Error('Tidak ada video yang dapat dipilih.');
  }

  return {
    videos: selected,
    totalDuration,
    sourceCount: videoFiles.length
  };
}

/**
 * Membuat urutan segmen untuk concat.
 *
 * - Menggunakan setiap segmen terpilih terlebih dahulu.
 * - Jika durasi belum cukup, ulangi urutan segmen.
 * - Berhenti ketika estimasi durasi memenuhi audio.
 *
 * Segmen tidak diencode ulang di tahap concat.
 */
function buildConcatSequence(
  segments: string[],
  selectedDuration: number,
  audioDuration: number
): string[] {
  if (!segments.length) {
    throw new Error('Daftar segmen kosong.');
  }

  const sequence = [...segments];
  let duration = selectedDuration;

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Durasi segmen tidak valid.');
  }

  let index = 0;

  while (duration < audioDuration) {
    sequence.push(segments[index]);

    // Durasi urutan yang diulang.
    // Durasi klip yang dipilih dihitung pada pemilihan awal.
    // Kita perlu durasi per segmen untuk akumulasi akurat.
    index++;

    if (index >= segments.length) {
      index = 0;
    }

    // Fungsi ini memerlukan durasi masing-masing segmen.
    // Karena itu gunakan overload/helper di bawah,
    // bukan implementasi ini secara langsung.
    break;
  }

  return sequence;
}

/**
 * Membuat urutan concat menggunakan durasi setiap segmen.
 */
function buildConcatSequenceWithDurations(
  segments: string[],
  durations: number[],
  audioDuration: number
): string[] {
  if (!segments.length || segments.length !== durations.length) {
    throw new Error('Daftar segmen dan durasi tidak sesuai.');
  }

  if (!Number.isFinite(audioDuration) || audioDuration <= 0) {
    throw new Error('Durasi audio tidak valid.');
  }

  if (durations.some(d => !Number.isFinite(d) || d <= 0)) {
    throw new Error('Terdapat durasi segmen yang tidak valid.');
  }

  const sequence = [...segments];
  let totalDuration = durations.reduce((sum, d) => sum + d, 0);

  let index = 0;

  while (totalDuration < audioDuration) {
    sequence.push(segments[index]);
    totalDuration += durations[index];

    index++;

    if (index >= segments.length) {
      index = 0;
    }
  }

  return sequence;
}

async function processJob(job: Job): Promise<void> {
  const workDir = path.join(DATA_DIR, 'work', job.id);
  await fs.promises.mkdir(workDir, { recursive: true });

  const outDir = path.dirname(job.outputFile);
  await fs.promises.mkdir(outDir, { recursive: true });

  const tempOutput = job.outputFile + '.partial.mp4';

  try {
    if (!job.audioFile) {
      throw new Error(`Audio tidak ditemukan pada direktori sumber: ${job.titlePath}. Jalankan scan sumber.`);
    }

    const selectedCategoryForRun = path.basename(job.videoCategory || 'default');
    let currentCategoryVideos = job.videoFilesByCategory?.[selectedCategoryForRun];
    if (!Array.isArray(currentCategoryVideos)) {
      currentCategoryVideos = await listVideoFilesForCategory(selectedCategoryForRun);
      job.videoFilesByCategory = { ...(job.videoFilesByCategory || {}), [selectedCategoryForRun]: [...currentCategoryVideos] };
    }
    if (!currentCategoryVideos.length) {
      throw new Error(`Kategori video "${selectedCategoryForRun}" tidak memiliki file video. Periksa ${path.join(settings.videoAssetDirectory, selectedCategoryForRun)} lalu jalankan scan.`);
    }
    job.videoFiles = [...currentCategoryVideos];
    job.videoDuration = job.videoDurationByCategory?.[selectedCategoryForRun] ?? job.videoDuration;

    if (!job.mergeEnabled) {
      throw new Error('Merge belum diaktifkan untuk judul ini. Centang Aktifkan merge lalu simpan pilihan judul.');
    }

    // Fingerprint memakai daftar sumber kanonis agar urutan random tidak mengubah fingerprint.
    const sourceVideoFiles = [...new Set(job.videoFiles)]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const allFiles = [...sourceVideoFiles, job.audioFile];

    if (!(await stableFiles(allFiles))) {
      throw new Error(
        'Sumber belum stabil. Tunggu hingga file selesai disalin lalu scan ulang.'
      );
    }

    // Pilih video secara acak tanpa pengembalian sampai durasi total mencukupi audio.
    // Set + helper shuffle memastikan satu path sumber hanya dipakai sekali.
    const selection = await selectRandomVideosForAudio(sourceVideoFiles, job.audioDuration);
    const selectedVideos = selection.videos;
    // job.videoFiles tetap berisi seluruh kandidat hasil scan; selectedVideos hanya lokal untuk render.

    log(
      `[MERGER] Kandidat tersedia=${selection.sourceCount}; klip unik terpilih=${selectedVideos.length}; ` +
      `durasi terpilih=${secondsText(selection.totalDuration)}; target audio=${secondsText(job.audioDuration)}`
    );

    if (selection.totalDuration < job.audioDuration) {
      log(
        `[MERGER] Durasi semua klip unik lebih pendek dari audio. ` +
        `Tidak akan menduplikasi klip; frame terakhir akan diperpanjang hingga durasi audio.`
      );
    }

    writeMergeMarker(job.titlePath, {
      schemaVersion: 1,
      title: job.title,
      status: 'processing',
      sourceFingerprint: job.fingerprint,
      outputFile: job.outputFile,
      sourceVideoCount: selectedVideos.length,
      audioFile: job.audioFile,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      message: 'Video sedang digabungkan.'
    });

    log(`[MERGER] Memulai: ${job.title}`);
    const selectedCategory = path.basename(job.videoCategory || 'default');
    const selectedAssetDirectory = path.join(settings.videoAssetDirectory, selectedCategory);

    // Bedakan jumlah semua kandidat yang terbaca dari jumlah klip yang dipakai
    // untuk memenuhi durasi audio. Angka N pada progress render adalah klip terpilih,
    // bukan jumlah seluruh file dalam folder asset.
    log(`[MERGER] Kategori video: ${selectedCategory}`);
    log(`[ASSET] Direktori asset: ${selectedAssetDirectory}`);
    log(`[ASSET] Video kandidat terbaca: ${sourceVideoFiles.length}`);
    log(`[MERGER] Klip unik terpilih untuk audio: ${selectedVideos.length} dari ${sourceVideoFiles.length} kandidat`);
    log(`[MERGER] Audio: ${job.audioFile}`);
    log(`[MERGER] Durasi target: ${secondsText(job.audioDuration)}`);
    log(
      `[MERGER] Resolusi=${settings.outputWidth}x${settings.outputHeight}, codec=${settings.videoCodec}, CRF final=${settings.crf}, preset=${settings.preset}`
    );

    const segments: string[] = [];
    const segmentDurations: number[] = [];

    const intermediateCrf = Math.min(settings.crf, 16);

    for (let i = 0; i < selectedVideos.length; i++) {
      const selected = selectedVideos[i];
      const input = selected.file;

      const segment = path.join(
        workDir,
        `segment-${String(i + 1).padStart(4, '0')}.mp4`
      );

      segments.push(segment);

      const sourceStat = await fs.promises.stat(input);

      log(
        `[VIDEO] Klip terpilih ${i + 1}/${selectedVideos.length} ` +
        `(kandidat tersedia: ${sourceVideoFiles.length}; kategori: ${selectedCategory}): ` +
        `${path.basename(input)}`
      );

      log(
        `[VIDEO] Ukuran sumber: ${(sourceStat.size / 1048576).toFixed(2)} MiB`
      );

      log(
        `[VIDEO] Intermediate CRF=${intermediateCrf}, ` +
        `preset=${settings.preset}, ` +
        `resolusi=${settings.outputWidth}x${settings.outputHeight}`
      );

      const filter =
        `[0:v:0]split=2[bgsrc][fgsrc];` +
        `[bgsrc]scale=${settings.outputWidth}:${settings.outputHeight}:force_original_aspect_ratio=increase,` +
        `crop=${settings.outputWidth}:${settings.outputHeight},boxblur=24:12[bg];` +
        `[fgsrc]scale=${settings.outputWidth}:${settings.outputHeight}:force_original_aspect_ratio=decrease[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[v]`;

      updateJob(job, {
        stage: `Menormalkan video ${i + 1}/${selectedVideos.length}`,
        message: path.basename(input),
        progress: Math.round(
          (i / selectedVideos.length) * 65
        )
      });

      await runCommand(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-y',
          '-i', input,
          '-filter_complex', filter,
          '-map', '[v]',
          '-an',
          '-c:v', settings.videoCodec,
          '-preset', settings.preset,
          '-crf', String(intermediateCrf),
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-progress', 'pipe:1',
          '-nostats',
          segment
        ],
        p => updateJob(job, {
          progress: Math.min(
            68,
            Math.round(
              (i + p) / selectedVideos.length * 65
            )
          )
        }),
        await probeDuration(input)
      );

      // Gunakan durasi aktual segmen hasil normalisasi
      // untuk menyusun urutan concat.
      const segmentDuration = await probeDuration(segment);

      if (
        !Number.isFinite(segmentDuration) ||
        segmentDuration <= 0
      ) {
        throw new Error(
          `Durasi segmen hasil normalisasi tidak valid: ${path.basename(segment)}`
        );
      }

      segmentDurations.push(segmentDuration);

      const segmentStat = await fs.promises.stat(segment);

      log(
        `[VIDEO] Segmen ${i + 1} selesai: ` +
        `${(segmentStat.size / 1048576).toFixed(2)} MiB`
      );

      log(
        `[VIDEO] Durasi segmen: ${secondsText(segmentDuration)}`
      );
    }

    // 2. Siapkan daftar concat.
    const concatFile = path.join(workDir, 'concat.txt');

    const quoteConcat = (s: string) =>
      `file '${s.replace(/'/g, "'\\''")}'`;

    await fs.promises.writeFile(
      concatFile,
      segments.map(quoteConcat).join('\n') + '\n'
    );

    // 3. Gabungkan segmen tanpa encoding ulang.
    const combined = path.join(workDir, 'combined.mp4');

    updateJob(job, {
      stage: 'Menggabungkan urutan video',
      message: 'Menggabungkan klip yang sudah dinormalisasi.',
      progress: 70
    });

    await runCommand('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      combined
    ]);

    const combinedStat = await fs.promises.stat(combined);

    log(
      `[VIDEO] Combined: ${(combinedStat.size / 1048576).toFixed(2)} MiB`
    );

    // 4. Encoding final: audio menentukan durasi output.
    updateJob(job, {
      stage: 'Menggabungkan audio dan video',
      message: 'Loop video bila perlu; audio menjadi acuan durasi akhir.',
      progress: 75
    });

    await fs.promises.rm(tempOutput, { force: true });

    const subtitleFile = job.autoCaptionEnabled
      ? await prepareAutoCaption(job, workDir, combined)
      : await prepareAlignedLyrics(job, workDir);
    const subtitleFilter = subtitleFile ? `subtitles=filename='${escapeFilterPath(subtitleFile)}'` : null;
    if (subtitleFile && job.autoCaptionEnabled) {
      log(`[AUTOCAPTION] Subtitle akan dibakar ke video final: ${subtitleFile}`);
    } else if (subtitleFile) {
      log(`[LYRICS] Subtitle akan dibakar ke video: ${subtitleFile}`);
    } else {
      log(`[SUBTITLE] Subtitle tidak digunakan untuk ${job.title}; melanjutkan encoding normal.`);
    }

    log(
      `[FFMPEG] Encoding final dimulai: ${job.title}; ` +
      `equalizer=${settings.equalizerEnabled ? 'AKTIF (' + settings.equalizerStyle + ')' : 'NONAKTIF'}`
    );

    log(
      `[FFMPEG] Codec=${settings.videoCodec}, CRF final=${settings.crf}, preset=${settings.preset}, audio=AAC 320k`
    );

    let lastLoggedPercent = -10;

    const finalArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', combined,
      '-i', job.audioFile
    ];

    if (settings.equalizerEnabled) {
      const vizW = Math.max(
        320,
        Math.round(settings.outputWidth * 0.72 / 2) * 2
      );

      const vizH = Math.max(
        80,
        Math.round(
          settings.outputHeight * settings.equalizerHeight / 100 / 2
        ) * 2
      );

      const color = ({
        white: 'white',
        cyan: 'cyan',
        purple: 'purple'
      } as const)[settings.equalizerColor];

      const gapPx = 2;
      const stepPx = 10;

      const gapFilters = Array.from(
        { length: Math.floor(vizW / stepPx) },
        (_, i) =>
          `drawbox=x=${i * stepPx}:y=0:w=${gapPx}:h=ih:color=black:t=fill`
      ).join(',');

      const vizSource = settings.equalizerStyle === 'waveform'
        ? `[1:a]showwaves=s=${vizW}x${vizH}:mode=line:rate=30:colors=${color},colorkey=black:0.12:0.08,format=rgba,colorchannelmixer=aa=${settings.equalizerOpacity / 100}[viz]`
        : `[1:a]showfreqs=s=${vizW}x${vizH}:mode=bar:ascale=log:fscale=log:win_size=2048:colors=${color},${gapFilters},colorkey=black:0.12:0.08,format=rgba,colorchannelmixer=aa=${settings.equalizerOpacity / 100}[viz]`;

      const y = settings.equalizerPosition === 'top'
        ? 'H*0.06'
        : settings.equalizerPosition === 'center'
          ? '(H-h)/2'
          : 'H-h-H*0.06';

      const videoChain = `[0:v]tpad=stop_mode=clone:stop_duration=${job.audioDuration}[base];` +
        `[base][viz]overlay=(W-w)/2:${y}:shortest=1,format=yuv420p` +
        (subtitleFilter ? `,${subtitleFilter}` : '') + `[vout]`;
      finalArgs.push(
        '-filter_complex',
        `${vizSource};${videoChain}`,
        '-map', '[vout]'
      );
        
    } else if (subtitleFilter) {
      finalArgs.push('-vf', `tpad=stop_mode=clone:stop_duration=${job.audioDuration},${subtitleFilter}`, '-map', '0:v:0');
    } else {
      finalArgs.push('-vf', `tpad=stop_mode=clone:stop_duration=${job.audioDuration}`, '-map', '0:v:0');
    }

    // Diagnostik: pastikan filter subtitle benar-benar masuk ke encoding final.
    const filterComplexIndex = finalArgs.indexOf('-filter_complex');
    const vfIndex = finalArgs.indexOf('-vf');

    if (filterComplexIndex >= 0) {
      log(`[FFMPEG] Filter final (-filter_complex): ${finalArgs[filterComplexIndex + 1]}`);
    } else if (vfIndex >= 0) {
      log(`[FFMPEG] Filter final (-vf): ${finalArgs[vfIndex + 1]}`);
    } else {
      log('[FFMPEG] PERINGATAN: encoding final tidak memakai filter video.');
    }

    log(`[FFMPEG] Subtitle aktif=${Boolean(subtitleFilter)}; equalizer=${settings.equalizerEnabled}`);


    finalArgs.push(
      '-map', '1:a:0',
      '-t', String(job.audioDuration),
      '-c:v', settings.videoCodec,
      '-preset', settings.preset,
      '-crf', String(settings.crf),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '320k',
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-nostats',
      tempOutput
    );

    await runCommand(
      'ffmpeg',
      finalArgs,
      p => {
        const percent = Math.min(100, Math.floor(p * 100));

        updateJob(job, {
          progress: 75 + Math.min(24, Math.round(p * 24)),
          stage: 'Encoding hasil akhir',
          message: `${percent}%`
        });

        if (percent >= lastLoggedPercent + 10 || percent === 100) {
          lastLoggedPercent = percent;
          log(
            `[FFMPEG] ${job.title}: progres encoding akhir ${percent}%`
          );
        }
      },
      job.audioDuration
    );

    // 5. Validasi ukuran dan stream output.
    const outStat = await fs.promises.stat(tempOutput);

    if (outStat.size < 1024) {
      throw new Error('Output terlalu kecil; dianggap tidak valid.');
    }

    const videoInfo = await runCommand('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height',
      '-of', 'csv=p=0',
      tempOutput
    ]);

    if (!videoInfo.stdout.trim()) {
      throw new Error('Output tidak memiliki stream video yang valid.');
    }

    const audioInfo = await runCommand('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      tempOutput
    ]);

    if (!audioInfo.stdout.trim()) {
      throw new Error('Output tidak memiliki stream audio yang valid.');
    }

    log(
      `[OUTPUT] Sementara: ${(outStat.size / 1048576).toFixed(2)} MiB`
    );
    log(`[OUTPUT] Video: ${videoInfo.stdout.trim()}`);
    log(`[OUTPUT] Audio: ${audioInfo.stdout.trim()}`);

    // 6. Pastikan file sumber tidak berubah saat proses berlangsung.
    const currentFingerprint = hash(`${await fileFingerprint(allFiles)}|category:${job.videoCategory || 'default'}`);

    if (currentFingerprint !== job.fingerprint) {
      throw new Error(
        'File sumber berubah saat proses merge berlangsung. Hasil dibatalkan; scan dan proses ulang sumber terbaru.'
      );
    }

    // 7. Pastikan durasi output sesuai durasi audio.
    const finalDuration = await probeDuration(tempOutput);

    if (
      Math.abs(finalDuration - job.audioDuration) >
      Math.max(0.75, job.audioDuration * 0.005)
    ) {
      throw new Error(
        `Durasi output tidak sesuai audio: output ${secondsText(finalDuration)}, audio ${secondsText(job.audioDuration)}.`
      );
    }

    // 8. Pindahkan file yang sudah lolos validasi.
    await fs.promises.rename(tempOutput, job.outputFile);

    const finalStat = await fs.promises.stat(job.outputFile);

    log(
      `[OUTPUT] Final: ${job.outputFile} | ` +
      `Size=${(finalStat.size / 1048576).toFixed(2)} MiB | ` +
      `Durasi=${secondsText(finalDuration)}`
    );

    // 9. Tandai job selesai.
    writeMergeMarker(job.titlePath, {
      schemaVersion: 1,
      title: job.title,
      status: 'completed',
      sourceFingerprint: job.fingerprint,
      outputFile: job.outputFile,
      sourceVideoCount: selectedVideos.length,
      audioFile: job.audioFile,
      outputSizeBytes: finalStat.size,
      startedAt: readMergeMarker(job.titlePath)?.startedAt,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      message: subtitleFile
        ? (job.autoCaptionEnabled
          ? 'Output berhasil dibuat dengan subtitle AutoCaption dan lolos validasi FFprobe.'
          : 'Output berhasil dibuat dengan subtitle aligned lyrics dan lolos validasi FFprobe.')
        : 'Output berhasil dibuat tanpa subtitle dan lolos validasi FFprobe.'
    });

    updateJob(job, {
      status: 'completed',
      progress: 100,
      stage: 'Selesai',
      message: subtitleFile
        ? (job.autoCaptionEnabled
          ? 'Video berhasil dibuat dengan subtitle AutoCaption dan diverifikasi; merge-status.json ditandai completed.'
          : 'Video berhasil dibuat dengan subtitle aligned lyrics dan diverifikasi; merge-status.json ditandai completed.')
        : 'Video berhasil dibuat tanpa subtitle dan diverifikasi; merge-status.json ditandai completed.',
      error: null
    });

    log(`Selesai: ${job.title} → ${job.outputFile}`);

    // --- PEMISAHAN ANTREAN UPLOAD ---
    if (settings.youtubeAutoUploadEnabled) {
      log(`[YOUTUBE-UPLOADER] Mengantrekan otomatis: ${job.title}`);
      
      // Masukkan ke antrean upload terpisah, bukan langsung dieksekusi di sini
      enqueueUpload({
        id: job.id,
        title: job.title,
        titlePath: job.titlePath,
        outputFile: job.outputFile,
        sourceFingerprint: job.fingerprint
      });
    } else {
      log(`[YOUTUBE-UPLOADER] Upload otomatis OFF; hasil merge disimpan: ${job.title}`);
    }

  } catch (e) {
    await fs.promises.rm(tempOutput, { force: true }).catch(() => {});

    const msg = (e as Error).message;

    writeMergeMarker(job.titlePath, {
      schemaVersion: 1,
      title: job.title,
      status: 'failed',
      sourceFingerprint: job.fingerprint,
      outputFile: job.outputFile,
      sourceVideoCount: job.videoFiles.length,
      audioFile: job.audioFile,
      updatedAt: new Date().toISOString(),
      message: 'Proses merge gagal.',
      error: msg
    });

    const canRetry =
      settings.retryEnabled && job.attempts < settings.retryLimit;

    if (canRetry) {
      job.attempts++;

      updateJob(job, {
        status: 'queued',
        stage: 'Menunggu retry',
        message: `Percobaan ulang ${job.attempts}/${settings.retryLimit}: ${msg}`,
        error: msg,
        progress: 0
      });
    } else {
      updateJob(job, {
        status: 'failed',
        stage: 'Gagal',
        message: msg,
        error: msg
      });
    }

    log(`${canRetry ? 'Retry dijadwalkan' : 'Gagal'}: ${job.title}: ${msg}`);
  }
}

function applyScheduler(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  if (dailyTask) { dailyTask.stop(); dailyTask=undefined; }
  const scanEnabled=settings.scanMode==='watch'||settings.scanMode==='both';
  if(scanEnabled) intervalHandle=setInterval(()=>{ void (async()=>{ await scanSources(true); scanAndQueuePendingUploads(); })(); },settings.scanIntervalMinutes*60_000);
  if(settings.dailyScheduleEnabled&&(settings.scanMode==='schedule'||settings.scanMode==='both')) {
    const [hour,minute]=settings.dailyScheduleTime.split(':');
    dailyTask=cron.schedule(`${Number(minute)} ${Number(hour)} * * *`,()=>{ void (async()=>{ await scanSources(true); scanAndQueuePendingUploads(); })(); },{timezone:settings.timezone});
  }
  log('Pengaturan scheduler diterapkan.');
}
app.get('/api/settings',(_req,res)=>res.json(settings));
app.put('/api/settings',(req,res)=>{try{settings=validateSettings(req.body);saveSettings();applyScheduler();log('Pengaturan disimpan dari dashboard.');res.json({ok:true,settings});}catch(e){res.status(400).json({ok:false,error:(e as Error).message});}});
app.post('/api/scan',async(_req,res)=>{await scanSources(false); scanAndQueuePendingUploads();res.json({ok:true,lastScanAt,lastScanSummary});});
app.get('/api/titles',(_req,res)=>res.json({jobs:Object.values(jobs).sort((a,b)=>a.title.localeCompare(b.title,undefined,{sensitivity:'base'})),running,parallelJobs:settings.parallelJobs}));
app.get('/api/video-categories', async (_req, res) => {
  const categories = await listVideoCategories();
  res.json({ categories, videoAssetDirectory: settings.videoAssetDirectory });
});

app.put('/api/title-options', async (req, res) => {
  try {
    const items = req.body?.items;

    if (!Array.isArray(items)) {
      throw new Error('Daftar pilihan judul tidak valid.');
    }

    const categories = new Set<string>(
      fs.existsSync(settings.videoAssetDirectory)
        ? fs.readdirSync(settings.videoAssetDirectory, {
            withFileTypes: true
          })
          .filter(d => d.isDirectory())
          .map(d => d.name)
        : []
    );

    for (const item of items) {
      const id = String(item?.id || '');
      const job = jobs[id];

      if (!job) continue;

      const category = path.basename(
        String(item?.videoCategory || 'default')
      );

      if (!categories.has(category)) {
        throw new Error(`Kategori video tidak ditemukan: ${category}`);
      }

      if (typeof item?.mergeEnabled !== 'boolean') {
        throw new Error(
          `Pilihan merge tidak valid untuk ${job.title}.`
        );
      }
      if (typeof item?.autoCaptionEnabled !== 'boolean') {
        throw new Error(`Pilihan AutoCaption tidak valid untuk ${job.title}.`);
      }
      const autoCaptionLanguage = String(item?.autoCaptionLanguage || 'id');
      if (!['id', 'en'].includes(autoCaptionLanguage)) {
        throw new Error(`Bahasa AutoCaption tidak valid untuk ${job.title}; gunakan id atau en.`);
      }

      // Jangan mengubah pilihan job yang sedang diproses.
      if (job.status === 'processing') continue;

      const changedCategory = job.videoCategory !== category;

      // Jika sebelumnya sudah antre dan pilihan dinonaktifkan,
      // atau kategorinya berubah, batalkan antrean.
      if (
        job.status === 'queued' &&
        (!item.mergeEnabled || changedCategory)
      ) {
        job.status = 'ready';
        job.progress = 0;
        job.stage = 'Antrean dibatalkan';
        job.message =
          'Antrean dibatalkan karena pilihan merge atau kategori diubah.';
      }

      // Simpan pilihan dan langsung gunakan daftar kategori dari snapshot scan terbaru.
      // Bila job lama belum memiliki cache (sebelum versi ini), baca kategori tersebut sekali.
      job.mergeEnabled = item.mergeEnabled;
      job.autoCaptionEnabled = item.autoCaptionEnabled;
      job.autoCaptionLanguage = autoCaptionLanguage as 'id' | 'en';
      if (changedCategory) {
        let categoryVideos = job.videoFilesByCategory?.[category];
        if (!Array.isArray(categoryVideos)) {
          categoryVideos = await listVideoFilesForCategory(category);
          job.videoFilesByCategory = { ...(job.videoFilesByCategory || {}), [category]: [...categoryVideos] };
        }
        if (!categoryVideos.length) {
          throw new Error(`Kategori "${category}" belum memiliki video. Periksa ${path.join(settings.videoAssetDirectory, category)}.`);
        }
        if (!job.audioFile || !fs.existsSync(job.audioFile)) {
          const media = await listMedia(job.titlePath, category);
          job.audioFile = media.audio;
          if (!job.audioFile) throw new Error(`Audio tidak ditemukan di ${job.titlePath}.`);
        }
        job.videoCategory = category;
        job.videoFiles = [...categoryVideos];
        job.videoDuration = job.videoDurationByCategory?.[category] ?? 0;
        job.fingerprint = hash(`${await fileFingerprint([...job.videoFiles, job.audioFile])}|category:${category}`);
        job.status = 'ready';
        job.progress = 0;
        job.stage = 'Kategori video diterapkan';
        job.message = `Kategori "${category}" aktif: ${categoryVideos.length} kandidat video tersedia dari hasil scan/cache assets. Tidak perlu scan ulang hanya untuk mengganti kategori.`;
        job.error = null;
      } else {
        job.videoCategory = category;
      }

      job.updatedAt = new Date().toISOString();
    }

    // Persist pilihan ke penyimpanan server.
    saveJobs();

    // PENTING:
    // Jangan panggil scanSources(true) atau
    // scanAndQueuePendingUploads() dari endpoint ini.
    // Endpoint ini hanya menyimpan pilihan.

    res.json({
      ok: true,
      jobs: Object.values(jobs)
    });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: (e as Error).message
    });
  }
});

app.get('/api/source-status',(_req,res)=>{try{res.json(JSON.parse(fs.readFileSync(SOURCE_STATUS_FILE,'utf8')))}catch{res.json({schemaVersion:1,generatedAt:null,titles:[]})}});
app.post('/api/process',(req,res)=>{
  const ids: unknown = req.body?.ids;
  if(!Array.isArray(ids)||!ids.length){res.status(400).json({ok:false,error:'Pilih minimal satu judul untuk diproses.'});return;}
  let queued=0, skipped=0;
  for(const raw of ids){const id=String(raw);const j=jobs[id];if(!j||!j.mergeEnabled||j.status==='blocked'||j.status==='unstable'||j.status==='completed'||j.status==='processing'||j.status==='queued'){skipped++;continue;}if(j.status==='failed'){j.status='ready';j.error=null;j.attempts=0;}queueJob(id);queued++;}
  res.json({ok:true,queued,skipped});
});


app.post('/api/process-all', (_req, res) => {
  let queued = 0;
  let skipped = 0;

  for (const job of Object.values(jobs)) {
    // Hanya job yang sudah diaktifkan dan disimpan.
    if (job.mergeEnabled !== true) {
      skipped++;
      continue;
    }

    if (job.status === 'ready' || job.status === 'failed') {
      queueJob(job.id);
      queued++;
    } else {
      skipped++;
    }
  }

  res.json({
    ok: true,
    queued,
    skipped
  });
});


// app.get('/api/status',(_req,res)=>res.json({lastScanAt,lastScanSummary,logs,scheduler:{scanMode:settings.scanMode,intervalMinutes:settings.scanIntervalMinutes,dailyScheduleEnabled:settings.dailyScheduleEnabled,dailyScheduleTime:settings.dailyScheduleTime,timezone:settings.timezone},running,counts:Object.values(jobs).reduce((a,j)=>{a[j.status]=(a[j.status]||0)+1;return a;},{} as Record<string,number>)}));
app.get('/api/status', (_req, res) => res.json({
  lastScanAt,
  lastScanSummary,
  logs,
  youtubeLogs,
  scheduler: {
    scanMode: settings.scanMode,
    intervalMinutes: settings.scanIntervalMinutes,
    dailyScheduleEnabled: settings.dailyScheduleEnabled,
    dailyScheduleTime: settings.dailyScheduleTime,
    timezone: settings.timezone
  },
  running,
  counts: Object.values(jobs).reduce((a, j) => {
    a[j.status] = (a[j.status] || 0) + 1;
    return a;
  }, {} as Record<string, number>)
}));
app.get('/api/health',async(_req,res)=>{const checks:Record<string,boolean>={};for(const b of ['ffmpeg','ffprobe']){try{await runCommand(b,['-version']);checks[b]=true;}catch{checks[b]=false;}}res.json({ok:true,checks});});

saveSettings(); saveJobs(); applyScheduler();
app.listen(PORT,'0.0.0.0',()=>{ log(`Video Merger berjalan di port ${PORT}.`); scanAndQueuePendingUploads(); });
