// import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/movie_search.dart';
import '../models/movie.dart';
import '../services/api_services.dart';
import '../pages/movie_detail.dart';
import '../widgets/movie_card.dart';

class SearchPage extends StatefulWidget {
  const SearchPage({super.key});

  @override
  State<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends State<SearchPage> {
  final TextEditingController _searchController = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  final FocusNode _searchFieldFocusNode = FocusNode(debugLabel: 'SearchField');
  final FocusNode _appFocusNode = FocusNode(debugLabel: 'SearchPageApp');

  // 🎯 INISIALISASI KONSTANTA UNTUK SCROLL
  static const double _cardAspectRatio = 0.66;
  static const double _cardSpacing = 12.0;

  List<MovieSearch> _results = [];
  List<FocusNode> _resultFocusNodes = [];

  bool _isLoading = false;
  String _error = '';

  @override
  void initState() {
    super.initState();
    // 🎯 Auto focus ke search field & buka keyboard setelah halaman build
    WidgetsBinding.instance.addPostFrameCallback((_) {
      FocusScope.of(context).requestFocus(_searchFieldFocusNode);
      // Opsi: SystemChannels.textInput.invokeMethod('TextInput.show');
      // Dihilangkan karena pada Android TV, keyboard tidak selalu diperlukan otomatis
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    _scrollController.dispose();
    _searchFieldFocusNode.dispose();
    _appFocusNode.dispose();
    for (var node in _resultFocusNodes) {
      node.dispose();
    }
    super.dispose();
  }

  Future<void> _performSearch(String query) async {
    setState(() {
      _isLoading = true;
      _error = '';
      _results.clear();
      for (var node in _resultFocusNodes) {
        node.dispose();
      }
      _resultFocusNodes.clear();
    });

    try {
      final results = await ApiServices.searchMovies(query);

      setState(() {
        _results = results;
        _resultFocusNodes = List.generate(
          results.length,
          (index) => FocusNode(debugLabel: 'Result-$index'),
        );
        _isLoading = false;

        // ✅ Pindahkan fokus ke hasil pertama jika ada
        if (_resultFocusNodes.isNotEmpty) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            _resultFocusNodes[0].requestFocus();
          });
        }
      });
    } catch (e) {
      print('Error during search: $e');
      setState(() {
        _error = 'Gagal mencari film. Coba ulangi pencarian.';
        _isLoading = false;
      });
    }
  }

  // ✅ REVISI FUNGSI: Hanya memanggil Navigator.pop jika memungkinkan
  void _exitPage() {
    // Memanggil Navigator.pop() adalah cara terbaik untuk kembali menggunakan router
    if (Navigator.of(context).canPop()) {
      Navigator.of(context).pop();
    } else {
      // Jika halaman ini adalah root (tidak mungkin dalam kasus ini), keluar aplikasi
      SystemNavigator.pop();
    }
  }

  // ✅ REVISI FUNGSI: Menggunakan _exitPage
  Future<bool> _onWillPop() async {
    _exitPage();
    return false; // Mencegah WillPopScope menutup secara default
  }

  // ✅ FUNGSI _handleKey DIREVISI untuk menggunakan _exitPage
  KeyEventResult _handleKey(RawKeyEvent event) {
    if (event is! RawKeyDownEvent) return KeyEventResult.ignored;

    final key = event.logicalKey;
    final isSelectOrEnter =
        key == LogicalKeyboardKey.select || key == LogicalKeyboardKey.enter;

    // ⬇️ Pindah dari Text Field ke hasil pertama (index 0)
    if (_searchFieldFocusNode.hasFocus && key == LogicalKeyboardKey.arrowDown) {
      if (_resultFocusNodes.isNotEmpty) {
        _resultFocusNodes[0].requestFocus();
        return KeyEventResult.handled;
      }
    }

    // 🎯 LOGIKA BARU: Ketika hasil kosong atau belum ada fokus, tekan ENTER/SELECT akan fokus ke search box.
    if (isSelectOrEnter && !_searchFieldFocusNode.hasFocus) {
      // Cek apakah ada fokus di elemen lain. Jika tidak, fokuskan search field.
      if (_results.isEmpty || !_appFocusNode.hasFocus) {
        _searchFieldFocusNode.requestFocus();
        return KeyEventResult.handled;
      }
    }

    // ⬅️ Tombol Escape / GoBack memicu kembali (pop)
    if (key == LogicalKeyboardKey.escape || key == LogicalKeyboardKey.goBack) {
      _exitPage();
      return KeyEventResult.handled;
    }

    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    return WillPopScope(
      onWillPop: _onWillPop,
      child: RawKeyboardListener(
        focusNode: _appFocusNode,
        onKey: _handleKey,
        autofocus: true,
        child: Scaffold(
          backgroundColor: Colors.black,
          appBar: AppBar(
            title: const Text('Cari Film'),
            leading: IconButton(
              icon: const Icon(Icons.arrow_back),
              // ✅ Menggunakan _exitPage
              onPressed: () => _exitPage(),
            ),
          ),
          body: Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(12),
                child: TextField(
                  focusNode: _searchFieldFocusNode,
                  controller: _searchController,
                  textInputAction: TextInputAction.search,
                  cursorColor: Colors.red,
                  decoration: const InputDecoration(
                    hintText: 'Search...',
                    prefixIcon: Icon(Icons.search),
                    border: OutlineInputBorder(),
                    fillColor: Colors.white,
                    filled: true,
                  ),
                  onSubmitted: (value) {
                    final query = value.trim();
                    if (query.length >= 3) {
                      _performSearch(query);
                    }
                  },
                  style: const TextStyle(color: Colors.black),
                ),
              ),
              if (_isLoading)
                const Center(child: CircularProgressIndicator())
              else if (_error.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    _error,
                    style: const TextStyle(color: Colors.red),
                  ),
                )
              else if (_results.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(16),
                  child: Text(
                    'Tidak ada hasil.',
                    style: TextStyle(color: Colors.white),
                  ),
                )
              else
                SizedBox(
                  height: 300.0,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12.0,
                      vertical: 8.0,
                    ),
                    child: _buildHorizontalResultList(),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  // ✅ FUNGSI _buildHorizontalResultList
  Widget _buildHorizontalResultList() {
    if (_results.isEmpty) return const SizedBox.shrink();

    return ListView.builder(
      controller: _scrollController,
      scrollDirection: Axis.horizontal,
      itemCount: _results.length,
      itemBuilder: (context, index) {
        final movieSearch = _results[index];
        final FocusNode node = _resultFocusNodes[index];

        // 🎯 PENTING: Asumsi movieSearch.toMovieCompatible() ada dan mengkonversi tipe data
        final Movie movie = movieSearch.toMovieCompatible();

        void navigateToDetail() {
          Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => MovieDetailPage(movieId: movie.id),
            ),
          );
        }

        return Padding(
          padding: const EdgeInsets.only(right: _cardSpacing),
          child: AspectRatio(
            aspectRatio: _cardAspectRatio,
            child: Focus(
              focusNode: node,
              onKey: (n, event) {
                if (event is RawKeyDownEvent) {
                  final key = event.logicalKey;

                  // ⬆️ ATAS: Pindah ke Search Field
                  if (key == LogicalKeyboardKey.arrowUp) {
                    _searchFieldFocusNode.requestFocus();
                    return KeyEventResult.handled;
                  }

                  // ⬇️ BAWAH: Tidak ada aksi
                  if (key == LogicalKeyboardKey.arrowDown) {
                    return KeyEventResult.handled;
                  }

                  // ⬅️ KIRI
                  if (key == LogicalKeyboardKey.arrowLeft) {
                    final prevIndex = index - 1;
                    if (prevIndex >= 0) {
                      _resultFocusNodes[prevIndex].requestFocus();
                      Scrollable.ensureVisible(
                        _resultFocusNodes[prevIndex].context!,
                        duration: const Duration(milliseconds: 200),
                        curve: Curves.easeInOut,
                        alignment: 0.0,
                      );
                    }
                    return KeyEventResult.handled;
                  }

                  // ➡️ KANAN
                  if (key == LogicalKeyboardKey.arrowRight) {
                    final nextIndex = index + 1;
                    if (nextIndex < _resultFocusNodes.length) {
                      _resultFocusNodes[nextIndex].requestFocus();
                      Scrollable.ensureVisible(
                        _resultFocusNodes[nextIndex].context!,
                        duration: const Duration(milliseconds: 200),
                        curve: Curves.easeInOut,
                        alignment: 0.8,
                      );
                    }
                    return KeyEventResult.handled;
                  }

                  // Select (OK) / Enter
                  if (key == LogicalKeyboardKey.select ||
                      key == LogicalKeyboardKey.enter) {
                    navigateToDetail();
                    return KeyEventResult.handled;
                  }
                }
                return KeyEventResult.ignored;
              },
              child: GestureDetector(
                onTap: navigateToDetail,
                child: MovieCard(
                  movie: movie,
                  focusNode: node,
                  isMenuOpen: false,
                  onTap: navigateToDetail,
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
