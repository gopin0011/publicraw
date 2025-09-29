import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:video_player/video_player.dart';
import 'dart:async';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

// --- KONSTANTA & SETUP GLOBAL ---
const String adUnitId =
    'ca-app-pub-8666216779659896/1329493840'; //'ca-app-pub-3940256099942544/5224354917'; // Test Interstitial ID
const String _lastPositionKey = 'last_video_position_';
const String _nextAdKey = 'next_ad_position_';
const int _adIntervalSeconds = 40 * 60; // 40 menit (2400 detik)

class VideoPlayerPage extends StatefulWidget {
  final String hlsUrl;
  final String referer;
  final String userAgent;
  // 🎯 REVISI 1: Opsi untuk mengaktifkan/menonaktifkan AdMob
  final bool playAd;

  const VideoPlayerPage({
    super.key,
    required this.hlsUrl,
    required this.referer,
    required this.userAgent,
    this.playAd = true, // Default: AdMob aktif
  });

  @override
  State<VideoPlayerPage> createState() => _VideoPlayerPageState();
}

class _VideoPlayerPageState extends State<VideoPlayerPage> {
  late VideoPlayerController _controller;
  final FocusNode _videoFocusNode = FocusNode();

  bool _isLoading = true;
  bool _controlsVisible = true;
  Timer? _hideControlsTimer;

  final FocusNode _playPauseFocus = FocusNode();
  final FocusNode _seekBackwardFocus = FocusNode();
  final FocusNode _seekForwardFocus = FocusNode();

  InterstitialAd? _interstitialAd;
  int _nextAdPositionSeconds = _adIntervalSeconds;
  // Variabel _pendingPreRoll tidak diperlukan lagi karena Pre-Roll dihapus

  @override
  void initState() {
    super.initState();
    debugPrint('[ADMOB LOG] Initializing VideoPlayerPage...');

    // Muat AdMob hanya jika playAd=true
    if (widget.playAd) {
      _loadInterstitialAd();
    }

    _loadLastPositionAndInitialize();
    _startHideControlsTimer();
  }

  // =========================================================================
  // ## INITIALIZATION & JADWAL ADMOB (Menghapus Pre-Roll, Mengaktifkan Autoplay)
  // =========================================================================

  void _loadLastPositionAndInitialize() async {
    final Map<String, String> httpHeaders = {
      'Referer': widget.referer,
      'User-Agent': widget.userAgent,
    };

    _controller = VideoPlayerController.networkUrl(
      Uri.parse(widget.hlsUrl),
      httpHeaders: httpHeaders,
    );

    try {
      await _controller.initialize();

      final prefs = await SharedPreferences.getInstance();
      final key = _lastPositionKey + widget.hlsUrl.hashCode.toString();
      final adKey = _nextAdKey + widget.hlsUrl.hashCode.toString();

      final savedPositionSeconds = prefs.getInt(key) ?? 0;
      Duration initialPosition = Duration.zero;

      // Ambil posisi iklan tersimpan atau gunakan jadwal default (40 menit)
      _nextAdPositionSeconds = prefs.getInt(adKey) ?? _adIntervalSeconds;

      // 1. Resume Video jika ada posisi tersimpan
      if (savedPositionSeconds > 0) {
        initialPosition = Duration(seconds: savedPositionSeconds);
        await _controller.seekTo(initialPosition);

        // Hitung jadwal iklan berikutnya berdasarkan posisi absolut (kelipatan 40 menit)
        final currentSegment = savedPositionSeconds ~/ _adIntervalSeconds;
        // Jadwal iklan berikutnya adalah kelipatan 40 menit setelah segmen saat ini
        _nextAdPositionSeconds = (currentSegment + 1) * _adIntervalSeconds;

        debugPrint(
          '[ADMOB LOG] Resume pos: $savedPositionSeconds s. Next scheduled at kelipatan: $_nextAdPositionSeconds s',
        );

        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                'Melanjutkan dari ${_formatDuration(initialPosition)}',
              ),
              duration: const Duration(seconds: 3),
            ),
          );
        }
      } else {
        // Jika mulai dari 0, jadwal iklan pertama adalah 40 menit
        _nextAdPositionSeconds = _adIntervalSeconds;
      }

      _controller.addListener(_videoListener);

      if (mounted) {
        setState(() {
          _isLoading = false;
        });

        // 🎯 REVISI 3: Autoplay Video
        _controller.play();

        // Cek apakah video langsung melewati jadwal iklan (misal, resume di menit 41)
        _checkMidRollAd(_controller.value.position);

        _startHideControlsTimer();
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
      debugPrint("Video Error: $error");
    }
  }

  void _videoListener() {
    if (!_controller.value.isInitialized) return;

    final currentPosition = _controller.value.position;

    // Auto-Resume: Simpan posisi setiap 5 detik
    if (currentPosition.inSeconds > 0 && currentPosition.inSeconds % 5 == 0) {
      _saveCurrentPosition(currentPosition);
    }

    _checkMidRollAd(currentPosition);

    if (mounted) setState(() {});
  }

  Future<void> _saveCurrentPosition(Duration position) async {
    final prefs = await SharedPreferences.getInstance();
    final key = _lastPositionKey + widget.hlsUrl.hashCode.toString();
    final adKey = _nextAdKey + widget.hlsUrl.hashCode.toString();

    await prefs.setInt(key, position.inSeconds);
    await prefs.setInt(adKey, _nextAdPositionSeconds);
  }

  // =========================================================================
  // ## ADMOB LOGIC (Dipanggil hanya jika playAd=true)
  // =========================================================================

  void _loadInterstitialAd() {
    if (!widget.playAd) return; // Jangan muat jika playAd=false

    debugPrint('[ADMOB LOAD] Requesting interstitial ad...');
    InterstitialAd.load(
      adUnitId: adUnitId,
      request: const AdRequest(),
      adLoadCallback: InterstitialAdLoadCallback(
        onAdLoaded: (ad) {
          debugPrint('[ADMOB LOAD] ✅ Ad loaded successfully.');
          _interstitialAd = ad;
          _interstitialAd!
              .fullScreenContentCallback = FullScreenContentCallback(
            onAdDismissedFullScreenContent: (ad) {
              debugPrint('[ADMOB CALLBACK] Ad dismissed. Resuming playback.');
              ad.dispose();
              _interstitialAd = null;

              // Hitung jadwal berikutnya (kelipatan 40 menit)
              final currentPositionSeconds =
                  _controller.value.position.inSeconds;
              final nextSegment =
                  currentPositionSeconds ~/ _adIntervalSeconds + 1;
              _nextAdPositionSeconds = nextSegment * _adIntervalSeconds;

              debugPrint(
                '[ADMOB SCHEDULE] Next ad scheduled at kelipatan: $_nextAdPositionSeconds s.',
              );

              _controller.play();
              _loadInterstitialAd(); // Muat iklan berikutnya
            },
            onAdFailedToShowFullScreenContent: (ad, error) {
              debugPrint('[ADMOB CALLBACK] ❌ Ad failed to show: $error');
              ad.dispose();
              _interstitialAd = null;

              // Hitung jadwal berikutnya meskipun gagal (kelipatan 40 menit)
              final currentPositionSeconds =
                  _controller.value.position.inSeconds;
              final nextSegment =
                  currentPositionSeconds ~/ _adIntervalSeconds + 1;
              _nextAdPositionSeconds = nextSegment * _adIntervalSeconds;

              debugPrint(
                '[ADMOB SCHEDULE] Ad failed. Next ad scheduled at kelipatan: $_nextAdPositionSeconds s.',
              );

              _controller.play();
              _loadInterstitialAd(); // Muat iklan berikutnya
            },
            onAdShowedFullScreenContent: (ad) {
              debugPrint('[ADMOB CALLBACK] Ad shown.');
            },
          );
        },
        onAdFailedToLoad: (error) {
          debugPrint('[ADMOB LOAD] ❌ Ad failed to load: $error');
          _interstitialAd = null;
          // Tidak ada Pre-Roll, jadi tidak perlu ada logika play di sini.
        },
      ),
    );
  }

  void _checkMidRollAd(Duration currentPosition) {
    if (!widget.playAd) return; // Jangan cek jika playAd=false

    final currentSecond = currentPosition.inSeconds;

    // Logika Mid-Roll: Jika waktu mencapai jadwal KELIPATAN dan ada iklan
    if (currentSecond >= _nextAdPositionSeconds &&
        _interstitialAd != null &&
        _controller.value.isPlaying) {
      debugPrint(
        '[ADMOB TRIGGER] ✅ Mid-roll time reached! Pausing video and showing ad.',
      );
      _controller.pause();
      _showAd();
    } else if (currentSecond >= _nextAdPositionSeconds &&
        _interstitialAd == null) {
      // Jika waktu tercapai, tapi iklan belum dimuat, coba muat
      debugPrint(
        '[ADMOB TRIGGER] Mid-roll time reached, but NO AD AVAILABLE. Reloading ad...',
      );
      _loadInterstitialAd();
    }
  }

  void _showAd() {
    if (!widget.playAd) return; // Jangan tampilkan jika playAd=false

    if (_interstitialAd != null) {
      debugPrint('[ADMOB SHOW] Displaying Interstitial Ad.');
      _interstitialAd!.show();
    }
  }

  // =========================================================================
  // ## UI & VIDEO CONTROLS
  // =========================================================================

  void _startHideControlsTimer() {
    _hideControlsTimer?.cancel();
    _hideControlsTimer = Timer(const Duration(seconds: 5), () {
      if (mounted) {
        setState(() {
          _controlsVisible = false;
        });
      }
    });
  }

  void _showControls() {
    if (mounted) {
      setState(() {
        _controlsVisible = true;
        _startHideControlsTimer();
      });
    }
  }

  void _playPause() {
    _showControls();
    if (_controller.value.isPlaying) {
      _controller.pause();
    } else {
      _controller.play();
    }
  }

  void _seek(Duration duration) {
    _showControls();
    final newPosition = _controller.value.position + duration;
    _controller.seekTo(newPosition);
    // Cek Mid-Roll setelah seek
    _checkMidRollAd(_controller.value.position);
  }

  KeyEventResult _handleKey(FocusNode node, RawKeyEvent event) {
    if (event is! RawKeyDownEvent) return KeyEventResult.ignored;

    _showControls();

    final key = event.logicalKey;

    if (key == LogicalKeyboardKey.select) {
      _playPause();
      return KeyEventResult.handled;
    }

    if (key == LogicalKeyboardKey.arrowLeft) {
      _seek(const Duration(seconds: -30));
      return KeyEventResult.handled;
    }

    if (key == LogicalKeyboardKey.arrowRight) {
      _seek(const Duration(seconds: 30));
      return KeyEventResult.handled;
    }

    if (key == LogicalKeyboardKey.escape || key == LogicalKeyboardKey.goBack) {
      Navigator.pop(context);
      return KeyEventResult.handled;
    }

    return KeyEventResult.ignored;
  }

  // --- CLEANUP ---

  @override
  void dispose() {
    _hideControlsTimer?.cancel();
    if (mounted) _controller.removeListener(_videoListener);
    _controller.dispose();
    _videoFocusNode.dispose();
    _playPauseFocus.dispose();
    _seekBackwardFocus.dispose();
    _seekForwardFocus.dispose();
    _interstitialAd?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Focus(
        focusNode: _videoFocusNode,
        onKey: _handleKey,
        autofocus: true,
        child: GestureDetector(
          onTap: _showControls,
          child: Center(
            child:
                _isLoading
                    ? const CircularProgressIndicator(color: Colors.red)
                    : _controller.value.hasError ||
                        !_controller.value.isInitialized
                    ? const Text(
                      'Gagal memuat video. Periksa URL/Header.',
                      style: TextStyle(color: Colors.white, fontSize: 20),
                    )
                    : AspectRatio(
                      aspectRatio: _controller.value.aspectRatio,
                      child: Stack(
                        children: [
                          VideoPlayer(_controller),
                          AnimatedOpacity(
                            opacity: _controlsVisible ? 1.0 : 0.0,
                            duration: const Duration(milliseconds: 300),
                            child: _buildControlsOverlay(),
                          ),
                        ],
                      ),
                    ),
          ),
        ),
      ),
    );
  }

  Widget _buildControlsOverlay() {
    return Container(
      color: Colors.black38,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _buildControlIcon(
                focusNode: _seekBackwardFocus,
                icon: Icons.replay_10,
                onPressed: () => _seek(const Duration(seconds: -10)),
              ),
              const SizedBox(width: 40),
              _buildControlIcon(
                focusNode: _playPauseFocus,
                icon:
                    _controller.value.isPlaying
                        ? Icons.pause
                        : Icons.play_arrow,
                onPressed: _playPause,
                size: 80,
              ),
              const SizedBox(width: 40),
              _buildControlIcon(
                focusNode: _seekForwardFocus,
                icon: Icons.forward_10,
                onPressed: () => _seek(const Duration(seconds: 10)),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 20),
            child: Row(
              children: [
                Text(
                  _formatDuration(_controller.value.position),
                  style: const TextStyle(color: Colors.white, fontSize: 18),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    child: VideoProgressIndicator(
                      _controller,
                      allowScrubbing: true,
                      colors: const VideoProgressColors(
                        playedColor: Colors.red,
                        bufferedColor: Colors.grey,
                        backgroundColor: Colors.white24,
                      ),
                    ),
                  ),
                ),
                Text(
                  _formatDuration(_controller.value.duration),
                  style: const TextStyle(color: Colors.white, fontSize: 18),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildControlIcon({
    required IconData icon,
    required VoidCallback onPressed,
    required FocusNode focusNode,
    double size = 60,
  }) {
    return Focus(
      focusNode: focusNode,
      child: Builder(
        builder: (context) {
          final isFocused = focusNode.hasFocus;
          return IconButton(
            icon: Icon(icon),
            color: isFocused ? Colors.yellow : Colors.white,
            iconSize: isFocused ? size * 1.2 : size,
            onPressed: onPressed,
          );
        },
      ),
    );
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, "0");
    final minutes = twoDigits(duration.inMinutes.remainder(60));
    final seconds = twoDigits(duration.inSeconds.remainder(60));
    if (duration.inHours > 0) {
      final hours = twoDigits(duration.inHours);
      return "$hours:$minutes:$seconds";
    }
    return "$minutes:$seconds";
  }
}
