// lib/widgets/movie_search_card.dart
import 'dart:io';
import 'package:flutter/material.dart';
import '../models/movie_search.dart';
import '../channel/native_image_loader.dart';

class MovieSearchCard extends StatefulWidget {
  final MovieSearch movie;
  final bool isFocused;

  const MovieSearchCard({
    super.key,
    required this.movie,
    required this.isFocused,
  });

  @override
  State<MovieSearchCard> createState() => _MovieSearchCardState();
}

class _MovieSearchCardState extends State<MovieSearchCard> {
  String? localPath;

  @override
  void initState() {
    super.initState();
    _loadImage();
  }

  void _loadImage() async {
    final path = await NativeImageLoader.loadImage(
      widget.movie.posterImg,
      widget.movie.id,
    );
    setState(() => localPath = path);
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedScale(
      scale: widget.isFocused ? 1.05 : 1.0,
      duration: const Duration(milliseconds: 200),
      child: Container(
        decoration: BoxDecoration(
          border: widget.isFocused
              ? Border.all(color: Colors.blueAccent, width: 3)
              : null,
          borderRadius: BorderRadius.circular(10),
          boxShadow: widget.isFocused
              ? [BoxShadow(color: Colors.black26, blurRadius: 6, offset: Offset(0, 4))]
              : [],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: Stack(
            children: [
              SizedBox(
                height: MediaQuery.of(context).size.height * 0.7,
                child: localPath != null
                    ? Image.file(
                  File(localPath!),
                  width: double.infinity,
                  fit: BoxFit.cover,
                )
                    : const Center(child: CircularProgressIndicator(strokeWidth: 2)),
              ),
              if (widget.movie.rating.isNotEmpty)
                Positioned(
                  top: 8,
                  right: 8,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: Colors.green,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      widget.movie.rating,
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.bold,
                        fontSize: 17,
                      ),
                    ),
                  ),
                ),
              Positioned(
                bottom: 0,
                left: 0,
                right: 0,
                child: Container(
                  color: Colors.black54,
                  padding: const EdgeInsets.all(8),
                  child: Text(
                    widget.movie.title,
                    textAlign: TextAlign.center,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 14,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
