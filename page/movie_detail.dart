import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/movie_detail.dart';
import '../services/api_services.dart';
import '../channel/native_image_loader.dart';
import 'video_webview_page.dart';
import 'package:video_player/video_player.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import 'video_player_page.dart';

class MovieDetailPage extends StatefulWidget {
  final String movieId;

  const MovieDetailPage({super.key, required this.movieId});

  @override
  State<MovieDetailPage> createState() => _MovieDetailPageState();
}

class _MovieDetailPageState extends State<MovieDetailPage> {
  late Future<MovieDetail> _movieFuture;
  String? localPosterPath;

  @override
  void initState() {
    super.initState();
    _movieFuture = ApiServices.fetchMovieDetail(widget.movieId);
  }

  String getEmbedYouTubeUrl(String youtubeUrl) {
    final uri = Uri.parse(youtubeUrl);
    final videoId = uri.queryParameters['v'];
    return 'https://www.youtube.com/embed/$videoId?autoplay=0&enablejsapi=1';
  }

  void openInBrowser(String url) async {
    final uri = Uri.parse(url);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } else {
      throw 'Could not launch $url';
    }
  }

  void _showTrailerPopup(BuildContext context, String trailerUrl) {
    final embedUrl = getEmbedYouTubeUrl(trailerUrl);

    final controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0x00000000))
      ..loadRequest(Uri.parse(embedUrl));

    showDialog(
      context: context,
      barrierDismissible: true,
      builder: (context) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(16),
        child: AspectRatio(
          aspectRatio: 16 / 9,
          child: WebViewWidget(controller: controller),
        ),
      ),
    );
  }



  Future<void> _loadPoster(String url, String id) async {
    final path = await NativeImageLoader.loadImage(url, id);
    setState(() => localPosterPath = path);
  }

  void _openWebView(String url) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => VideoWebViewPage(url: url),
      ),
    );
  }

  void _openVideoPlayer(String hlsUrl) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => VideoPlayerPage(
          hlsUrl: hlsUrl,
          // Header kustom yang diminta
          referer: 'https://cloud.hownetwork.xyz/', 
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // ⚠️ Pertimbangkan untuk menghapus AppBar di sini untuk tampilan TV
      appBar: AppBar(
        title: const Text('Detail Movie'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: FutureBuilder<MovieDetail>(
        future: _movieFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          } else if (snapshot.hasError) {
            return Center(child: Text('Gagal memuat data: ${snapshot.error}'));
          }

          final movie = snapshot.data!;
          final hlsStreamUrl = movie.stream?.file ?? ''; // Ambil URL HLS
          
          _loadPoster(movie.posterImg, movie.id);

          return SingleChildScrollView(
            padding: const EdgeInsets.all(32), // Padding diperbesar untuk TV
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Kolom untuk Thumbnail
                Expanded(
                  flex: 1,
                  child: GestureDetector(
                    // 🔹 PANGGIL FUNGSI INI SAAT ICON PLAY DIPENCET
                    onTap: () {
                      if (hlsStreamUrl.isNotEmpty) {
                        _openVideoPlayer(hlsStreamUrl);
                      } else {
                        // Tampilkan pesan error jika URL tidak ada
                        ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('Stream URL tidak ditemukan!'))
                        );
                      }
                    },
                    child: SizedBox(
                      height: MediaQuery.of(context).size.height * 0.7,
                      child: Stack(
                        children: [
                          ClipRRect(
                            borderRadius: BorderRadius.circular(8),
                            child: localPosterPath != null
                                ? Image.file(
                                    File(localPosterPath!),
                                    width: double.infinity,
                                    height: double.infinity,
                                    fit: BoxFit.cover,
                                  )
                                : Container(
                                    width: double.infinity,
                                    height: double.infinity,
                                    color: Colors.grey[800], // Warna gelap untuk TV
                                    child: const Center(child: Text('No image', style: TextStyle(color: Colors.white))),
                                  ),
                          ),
                          // Ikon Play di tengah
                          const Center(
                            child: Icon(
                              Icons.play_circle_fill,
                              size: 96, // Ikon lebih besar untuk TV
                              color: Colors.white70,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),

                const SizedBox(width: 40), // Spasi yang lebih lebar
                // Kolom untuk Sinopsis dan Tombol
                Expanded(
                  flex: 2,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // ... (Teks Title, Synopsis, dan Tombol Watch/Browser di sini)
                      // ⚠️ PASTIKAN UKURAN FONT DI BAWAH INI DIPERBESAR
                      
                      Text(
                        movie.title,
                        style: const TextStyle(fontSize: 32, fontWeight: FontWeight.bold, color: Colors.white),
                      ),
                      const SizedBox(height: 24),
                      Text(
                        movie.synopsis,
                        style: const TextStyle(fontSize: 18, color: Colors.white70),
                      ),
                      const SizedBox(height: 36),
                      
                      // Tombol Play
                      ElevatedButton.icon(
                        onPressed: () {
                          if (hlsStreamUrl.isNotEmpty) {
                            _openVideoPlayer(hlsStreamUrl);
                          }
                        },
                        icon: const Icon(Icons.play_arrow, size: 28),
                        label: const Text('Play Stream (HLS)', style: TextStyle(fontSize: 20)),
                        style: ElevatedButton.styleFrom(
                          minimumSize: const Size(200, 60),
                          backgroundColor: Colors.red,
                        ),
                      ),
                      // ... (Tombol lainnya bisa ditambahkan)
                    ],
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
