
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/movie.dart';
import '../services/api_services.dart';
import '../widgets/movie_card.dart';
import 'search_page.dart';
import 'movie_detail.dart';

class MovieGridPage extends StatefulWidget {
  const MovieGridPage({super.key});

  @override
  State<MovieGridPage> createState() => _MovieGridPageState();
}

class _MovieGridPageState extends State<MovieGridPage> {
  // --- KONSTANTA & PROPERTI ---
  final ScrollController _scrollController = ScrollController();
  final List<Movie> _movies = [];
  final List<FocusNode> _focusNodes = [];

  final FocusNode _appFocusNode = FocusNode(debugLabel: "AppFocus");
  final FocusNode _searchFocusNode = FocusNode(debugLabel: "SidebarSearch");
  final FocusNode _sidebarFocusNode = FocusNode(debugLabel: 'Sidebar');

  bool _isLoading = true;
  String? _errorMessage;
  int _currentPage = 1;

  bool _isMenuOpen = false;
  DateTime? _lastBackPressed;

  static const double _sidebarWidthOpen = 250.0;
  static const double _gridHorizontalPadding = 40.0;
  static const double _gridVerticalPadding = 40.0;
  static const double _cardSpacing = 30.0;

  final int _rows = 2;
  final int ITEMS_PER_COLUMN_VISIBLE = 6;
  static const int SCROLL_UNIT_TRIGGER = 2;

  int _focusedIndex = 0;
  int _currentPageIndex = 0; // Tambahkan kembali _currentPageIndex
  final Map<FocusNode, VoidCallback> _focusListeners = {};

  @override
  void initState() {
    super.initState();
    _fetchMovies(_currentPage);
    _scrollController.addListener(_scrollListener);

    WidgetsBinding.instance.addPostFrameCallback((_) {
      _appFocusNode.requestFocus();
    });
  }

  // ❌ HAPUS didChangeDependencies sepenuhnya karena menyebabkan error "called during build"

  @override
  void dispose() {
    _scrollController.dispose();
    for (final node in _focusNodes) {
      final listener = _focusListeners[node];
      if (listener != null) {
        node.removeListener(listener);
      }
      node.dispose();
    }
    _appFocusNode.dispose();
    _searchFocusNode.dispose();
    super.dispose();
  }

  // --- LOGIKA FETCHING & SCROLL (TIDAK BERUBAH) ---
  Future<void> _fetchMovies(int page) async {
    try {
      final List<Movie> fetched = await ApiServices.fetchMovies(page: page);
      setState(() {
        _movies.addAll(fetched);

        final startIndex = _focusNodes.length;
        for (int i = 0; i < fetched.length; i++) {
          final newIndex = startIndex + i;
          final node = FocusNode(debugLabel: 'MovieCard-$newIndex');
          final listener = () => _handleFocusChange(newIndex);
          node.addListener(listener);

          _focusNodes.add(node);
          _focusListeners[node] = listener;
        }
        _isLoading = false;

        if (page == 1 && _focusNodes.isNotEmpty) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            _focusNodes[0].requestFocus();
          });
        }
      });
    } catch (e) {
      setState(() {
        _errorMessage = e.toString();
        _isLoading = false;
      });
    }
  }

  void _scrollListener() {
    if (_scrollController.position.pixels >=
        _scrollController.position.maxScrollExtent * 0.9) {
      if (!_isLoading) {
        _isLoading = true;
        _currentPage++;
        _fetchMovies(_currentPage);
      }
    }
  }

  void _handleFocusChange(int index) {
    if (!_focusNodes[index].hasFocus) return;

    _focusedIndex = index;

    final targetPageIndex = index ~/ SCROLL_UNIT_TRIGGER;
    if (index ~/ SCROLL_UNIT_TRIGGER != _currentPageIndex) {
      _currentPageIndex = targetPageIndex;

      if (mounted) {
        final screenWidth = MediaQuery.of(context).size.width;
        final availableWidth = screenWidth - (_gridHorizontalPadding * 2);

        final totalGapSpace = (ITEMS_PER_COLUMN_VISIBLE - 1) * _cardSpacing;
        final cardWidth =
            (availableWidth - totalGapSpace) / ITEMS_PER_COLUMN_VISIBLE;

        final double scrollStepUnit = cardWidth + _cardSpacing;
        final double scrollTarget = targetPageIndex * scrollStepUnit;

        _scrollController.animateTo(
          scrollTarget,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    }
  }

  void _navigateToDetail(String movieId) {
    Navigator.push(
      context,
      MaterialPageRoute(builder: (_) => MovieDetailPage(movieId: movieId)),
    );
  }

  // --- LOGIKA NAVIGASI D-PAD & MENU ---

  KeyEventResult _handleMainKey(RawKeyEvent event) {
    if (event is! RawKeyDownEvent) return KeyEventResult.ignored;
    final key = event.logicalKey;

    if (key == LogicalKeyboardKey.arrowRight && _isMenuOpen) {
      _closeMenuFromGrid();
      return KeyEventResult.handled;
    }

    if (key == LogicalKeyboardKey.arrowLeft &&
        _focusNodes.isNotEmpty &&
        _focusedIndex == 0) {
      _openMenuFromGrid();
      return KeyEventResult.handled;
    }

    return KeyEventResult.ignored;
  }

  Future<bool> _handleWillPop() async {
    // Tombol Back/Escape
    if (!_isMenuOpen) {
      // Jika tidak terbuka (berada di grid), buka menu.
      _openMenuFromBack();
      return false; // Jangan keluar, buka menu
    }

    // Jika di menu, konfirmasi keluar.
    return await _confirmExitApp();
  }

  void _openMenuFromBack() {
    if (!_isMenuOpen) {
      setState(() => _isMenuOpen = true);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _searchFocusNode.requestFocus();
      });
    }
  }

  void _openMenuFromGrid() {
    if (!_isMenuOpen) {
      setState(() => _isMenuOpen = true);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _searchFocusNode.requestFocus();
      });
    }
  }

  // ✅ REVISI CLEAN: Fungsi ini dipanggil untuk menutup menu dari grid (Right)
  // DAN setelah kembali dari SearchPage (untuk menjamin fokus).
  void _closeMenuFromGrid() {
    if (_isMenuOpen) {
      setState(() => _isMenuOpen = false);

      // JAMINAN FOKUS ASYNCHRONOUS: Pastikan fokus kembali ke grid setelah UI selesai dibangun.
      if (_focusNodes.isNotEmpty && _focusedIndex < _focusNodes.length) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _focusNodes[_focusedIndex].requestFocus();
          // OPSI: Panggil handleFocusChange untuk memicu scroll koreksi jika diperlukan
          // _handleFocusChange(_focusedIndex);
        });
      }
    }
    // OPSI: Jika dipanggil dari then(()), dan menu sudah false (tidak mungkin jika di onTap),
    // tetapi masih diperlukan untuk memastikan fokus kembali jika ada bug fokus
    else {
      if (_focusNodes.isNotEmpty && _focusedIndex < _focusNodes.length) {
        _focusNodes[_focusedIndex].requestFocus();
      }
    }
  }

  Future<bool> _confirmExitApp() async {
    final now = DateTime.now();
    if (_lastBackPressed == null ||
        now.difference(_lastBackPressed!) > const Duration(seconds: 2)) {
      _lastBackPressed = now;

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Tekan tombol kembali sekali lagi untuk keluar',
            style: TextStyle(color: Colors.black, fontSize: 16),
          ),
          backgroundColor: Colors.white,
          duration: Duration(seconds: 2),
        ),
      );
      return false;
    }
    return true; // Keluar aplikasi
  }

  // --- WIDGET BUILDING (TIDAK BERUBAH) ---

  @override
  Widget build(BuildContext context) {
    return WillPopScope(
      onWillPop: _handleWillPop,
      child: RawKeyboardListener(
        focusNode: _appFocusNode,
        autofocus: true,
        onKey: _handleMainKey,
        child: Scaffold(
          backgroundColor: Colors.black,
          body: Row(
            children: [
              _buildSidebar(),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(
                    left: _gridHorizontalPadding,
                    top: _gridVerticalPadding,
                    right: _gridHorizontalPadding,
                  ),
                  child: _buildBodyContent(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildBodyContent() {
    if (_isLoading && _movies.isEmpty) {
      return const Center(child: CircularProgressIndicator(color: Colors.red));
    }
    if (_errorMessage != null) {
      return Center(
        child: Text(
          'Error: $_errorMessage',
          style: const TextStyle(color: Colors.white, fontSize: 24),
        ),
      );
    }
    return _buildHorizontalMovieGrid();
  }

  Widget _buildHorizontalMovieGrid() {
    if (_movies.isEmpty) return const SizedBox.shrink();
    return GridView.builder(
      controller: _scrollController,
      scrollDirection: Axis.horizontal,
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        childAspectRatio: 1.85,
        mainAxisSpacing: _cardSpacing,
        crossAxisSpacing: _cardSpacing,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 0),
      itemCount: _movies.length,
      itemBuilder: (context, index) {
        final movie = _movies[index];
        return Focus(
          focusNode: _focusNodes[index],
          onKey: (node, event) {
            if (event is RawKeyDownEvent) {
              final key = event.logicalKey;
              final int nextIndex = index + 1;
              final int prevIndex = index - 1;

              if (key == LogicalKeyboardKey.arrowLeft) {
                if (prevIndex >= 0) {
                  _focusNodes[prevIndex].requestFocus();
                  return KeyEventResult.handled;
                }
                return KeyEventResult.ignored;
              }

              if (key == LogicalKeyboardKey.arrowRight &&
                  nextIndex < _focusNodes.length) {
                _focusNodes[nextIndex].requestFocus();
                return KeyEventResult.handled;
              }

              if (key == LogicalKeyboardKey.arrowUp && index >= _rows) {
                _focusNodes[index - _rows].requestFocus();
                return KeyEventResult.handled;
              }
              if (key == LogicalKeyboardKey.arrowDown &&
                  index + _rows < _focusNodes.length) {
                _focusNodes[index + _rows].requestFocus();
                return KeyEventResult.handled;
              }

              if (key == LogicalKeyboardKey.select ||
                  key == LogicalKeyboardKey.enter) {
                _navigateToDetail(movie.id);
                return KeyEventResult.handled;
              }
            }
            return KeyEventResult.ignored;
          },
          child: MovieCard(
            movie: movie,
            focusNode: _focusNodes[index],
            isMenuOpen: _isMenuOpen,
            onTap: () => _navigateToDetail(movie.id),
          ),
        );
      },
    );
  }

  // Widget _buildSidebar() {
  //   return AnimatedContainer(
  //     duration: const Duration(milliseconds: 300),
  //     width: _isMenuOpen ? _sidebarWidthOpen : 0.0,
  //     color: Colors.grey.shade900,
  //     padding: const EdgeInsets.symmetric(vertical: 24),

  //     child: Focus(
  //       onKey: (node, event) {
  //         if (event is! RawKeyDownEvent) return KeyEventResult.ignored;
  //         final key = event.logicalKey;

  //         if (key == LogicalKeyboardKey.arrowRight) {
  //           // Event Right akan diteruskan ke RawKeyboardListener utama (_handleMainKey)
  //           return KeyEventResult.ignored;
  //         }

  //         // Semua event lain (Up/Down) diabaikan karena hanya ada satu item
  //         return KeyEventResult.ignored;
  //       },
  //       child: Column(
  //         children: [
  //           _buildSidebarItem(
  //             icon: Icons.search,
  //             label: 'Search',
  //             isOpen: _isMenuOpen,
  //             focusNode: _searchFocusNode,
  //             onTap: () {
  //               // 1. LANGSUNG NAVIGASI
  //               Navigator.push(
  //                 context,
  //                 MaterialPageRoute(builder: (_) => const SearchPage()),
  //               ).then((_) {
  //                 // 2. SETELAH KEMBALI, PANGGIL _closeMenuFromGrid().
  //                 // Fungsi ini akan menjalankan setState(false) DAN mengembalikan fokus ke grid.
  //                 _closeMenuFromGrid();
  //               });
  //             },
  //           ),
  //         ],
  //       ),
  //     ),
  //   );
  // }
  Widget _buildSidebar() {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 300),
      width: _isMenuOpen ? _sidebarWidthOpen : 0.0,
      color: Colors.grey.shade900,
      padding: const EdgeInsets.symmetric(vertical: 24),

      child: Focus(
        focusNode: _sidebarFocusNode, // ✅ Fokus utama sidebar
        onKey: (node, event) {
          if (event is! RawKeyDownEvent) return KeyEventResult.ignored;
          final key = event.logicalKey;

          if (key == LogicalKeyboardKey.arrowRight) {
            _closeMenuFromGrid();
            return KeyEventResult.handled;
          }
          return KeyEventResult.ignored;
        },
        child: Column(
          children: [
            _buildSidebarItem(
              icon: Icons.search,
              label: 'Search',
              isOpen: _isMenuOpen,
              focusNode: _searchFocusNode, // ✅ Fokus khusus tombol Search
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(builder: (_) => const SearchPage()),
                ).then((_) => _closeMenuFromGrid());
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSidebarItem({
    required IconData icon,
    required String label,
    required bool isOpen,
    required FocusNode focusNode,
    required VoidCallback onTap,
  }) {
    return Focus(
      focusNode: focusNode,
      onKey: (node, event) {
        if (event is RawKeyDownEvent) {
          final key = event.logicalKey;

          if (key == LogicalKeyboardKey.select ||
              key == LogicalKeyboardKey.enter) {
            onTap();
            return KeyEventResult.handled;
          }

          if (key == LogicalKeyboardKey.arrowRight) {
            return KeyEventResult.ignored;
          }
        }
        return KeyEventResult.ignored;
      },
      onFocusChange: (isFocused) {
        if (mounted) setState(() {});
      },
      child: Builder(
        builder: (context) {
          final isFocused = focusNode.hasFocus;
          return GestureDetector(
            onTap: onTap,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 150),
              margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 16),
              decoration: BoxDecoration(
                color: isFocused ? Colors.red.shade700 : Colors.transparent,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  Icon(
                    icon,
                    color: isFocused ? Colors.white : Colors.grey.shade400,
                    size: 30,
                  ),
                  if (isOpen) const SizedBox(width: 16),
                  if (isOpen)
                    Expanded(
                      child: Text(
                        label,
                        style: TextStyle(
                          color:
                              isFocused ? Colors.white : Colors.grey.shade400,
                          fontSize: 20,
                          fontWeight: FontWeight.w600,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}