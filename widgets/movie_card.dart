// lib/widgets/movie_card.dart
import 'package:flutter/material.dart';
import '../models/movie.dart';

class MovieCard extends StatefulWidget {
  final Movie movie;
  final FocusNode focusNode;
  final VoidCallback? onTap;
  final bool isMenuOpen;

  const MovieCard({
    super.key,
    required this.movie,
    required this.focusNode,
    this.onTap,
    required this.isMenuOpen,
  });

  @override
  State<MovieCard> createState() => _MovieCardState();
}

class _MovieCardState extends State<MovieCard> {
  bool _isFocused = false;
  final ScrollController _textScrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    // ✅ Listener ke FocusNode luar untuk Marquee dan UI
    widget.focusNode.addListener(_onFocusChange);
  }

  void _onFocusChange() {
    if (!mounted) return;
    setState(() => _isFocused = widget.focusNode.hasFocus);

    if (_isFocused) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_textScrollController.hasClients) {
          _startMarquee();
        }
      });
    } else {
      if (_textScrollController.hasClients) {
        _textScrollController.jumpTo(0.0);
      }
    }
  }

  void _startMarquee() {
    if (!widget.focusNode.hasFocus) return;

    if (_textScrollController.position.maxScrollExtent > 0) {
      _textScrollController
          .animateTo(
            _textScrollController.position.maxScrollExtent,
            duration: const Duration(seconds: 5),
            curve: Curves.linear,
          )
          .then((_) {
            Future.delayed(const Duration(milliseconds: 500), () {
              if (!mounted || !widget.focusNode.hasFocus) return;
              if (_textScrollController.hasClients) {
                _textScrollController.jumpTo(0.0);
              }
              _startMarquee();
            });
          });
    }
  }

  @override
  void dispose() {
    // ✅ Pelepasan listener dan controller
    widget.focusNode.removeListener(_onFocusChange);
    _textScrollController.dispose();
    super.dispose();
  }

  Widget _buildRatingBadge() {
    // Pastikan konversi dari String ke double aman
    final String rawRating = widget.movie.rating;
    final double numericRating = double.tryParse(rawRating) ?? 0.0;
    final String formattedRating = numericRating.toStringAsFixed(1);
    final rating = formattedRating;

    return Positioned(
      top: 8,
      left: 8,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          color: Colors.green.shade700,
          borderRadius: BorderRadius.circular(4),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('⭐', style: TextStyle(fontSize: 14)),
            const SizedBox(width: 4),
            Text(
              rating,
              style: const TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.bold,
                fontSize: 14,
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AbsorbPointer(
      absorbing: widget.isMenuOpen,
      child: GestureDetector(
        onTap: widget.onTap,
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            boxShadow:
                _isFocused
                    ? [
                      BoxShadow(
                        color: Colors.red.shade700.withOpacity(0.8),
                        blurRadius: 8,
                        spreadRadius: 3,
                      ),
                    ]
                    : [],
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(
                  child: Stack(
                    children: [
                      Image.network(
                        widget.movie.posterImg,
                        fit: BoxFit.cover,
                        width: double.infinity,
                        height: double.infinity,
                        errorBuilder:
                            (context, error, stackTrace) => Container(
                              color: Colors.grey.shade800,
                              child: const Center(
                                child: Icon(
                                  Icons.broken_image,
                                  color: Colors.white70,
                                ),
                              ),
                            ),
                      ),
                      _buildRatingBadge(),
                    ],
                  ),
                ),
                AnimatedContainer(
                  duration: const Duration(milliseconds: 150),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 5,
                    vertical: 3,
                  ),
                  alignment: Alignment.centerLeft,
                  color: _isFocused ? Colors.white : Colors.black,
                  child: SizedBox(
                    height: 25,
                    child: SingleChildScrollView(
                      controller: _textScrollController,
                      scrollDirection: Axis.horizontal,
                      physics: const NeverScrollableScrollPhysics(),
                      child: Row(
                        children: [
                          Text(
                            widget.movie.title,
                            maxLines: 1,
                            style: TextStyle(
                              color: _isFocused ? Colors.black : Colors.white70,
                              fontSize: 16,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          if (_isFocused) const SizedBox(width: 20),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
