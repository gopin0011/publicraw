// // lib/pages/payment_page.dart
// import 'package:flutter/material.dart';
// import 'package:flutter/services.dart';
// import 'package:uuid/uuid.dart';
// import 'package:flutter_secure_storage/flutter_secure_storage.dart';
// import 'package:qr_flutter/qr_flutter.dart';
// import 'dart:convert';
// import 'package:http/http.dart' as http;
// import '../services/socket_service.dart';

// // --- Model untuk Saluran Pembayaran ---
// class PaymentChannel {
//   final String code;
//   final String name;
//   final String logo;

//   PaymentChannel({required this.code, required this.name, required this.logo});

//   factory PaymentChannel.fromJson(Map<String, dynamic> json) {
//     return PaymentChannel(
//       code: json['code'] as String,
//       name: json['name'] as String,
//       logo: json['logo'] as String,
//     );
//   }
// }
// // ------------------------------------

// class PaymentPage extends StatefulWidget {
//   const PaymentPage({Key? key}) : super(key: key);

//   @override
//   State<PaymentPage> createState() => _PaymentPageState();
// }

// class _PaymentPageState extends State<PaymentPage> {
//   static const MethodChannel _channel = MethodChannel(
//     "com.andro.emovies/payment",
//   );

//   final _storage = const FlutterSecureStorage();

//   String? _emailUser;
//   String? _qrisContent;
//   String? _errorMessage;
//   bool _isPaymentProcessing = false;

//   int _currentIndex = 0;

//   String? _namaUser;
//   String? _noTelepon;

//   // Data Saluran Pembayaran
//   List<PaymentChannel> _channels = [];
//   bool _isLoadingChannels = true;
//   String? _channelsError;

//   // Fokus dan Scroll
//   final FocusNode _pageFocusNode = FocusNode(debugLabel: 'PaymentPageFocus');
//   // 🔥 Tambahkan GlobalKey untuk setiap item untuk mengontrol scroll
//   final List<GlobalKey> _itemKeys = [];
//   final ScrollController _scrollController =
//       ScrollController(); // Controller untuk ListView

//   @override
//   void initState() {
//     super.initState();
//     _loadUserData();
//     _fetchPaymentChannels();
//   }

//   Future<void> _fetchPaymentChannels() async {
//     const url = 'http://aslan.web.id:8080/payment-channel';
//     try {
//       final response = await http.get(Uri.parse(url));

//       if (response.statusCode == 200) {
//         final List<dynamic> data = jsonDecode(response.body);
//         _channels = data.map((json) => PaymentChannel.fromJson(json)).toList();
//         _channelsError = null;

//         // 🔥 Inisialisasi GlobalKey setelah data didapatkan
//         _itemKeys.clear();
//         for (int i = 0; i < _channels.length; i++) {
//           _itemKeys.add(GlobalKey());
//         }
//       } else {
//         _channelsError =
//             'Gagal memuat saluran pembayaran. Status: ${response.statusCode}';
//       }
//     } catch (e) {
//       _channelsError = 'Error fetching payment channels: $e';
//     } finally {
//       setState(() {
//         _isLoadingChannels = false;
//         if (_channels.isNotEmpty) {
//           _currentIndex = 0;
//         }
//       });
//     }
//   }

//   @override
//   void dispose() {
//     _pageFocusNode.dispose();
//     _scrollController.dispose();
//     super.dispose();
//   }

//   Future<void> _loadUserData() async {
//     _namaUser = await _storage.read(key: 'nama_user');
//     _noTelepon = await _storage.read(key: 'no_telepon');
//     _emailUser = await _storage.read(key: 'user_email');
//     setState(() {});
//   }

//   void _executeAction() {
//     if (_qrisContent != null) {
//       _handleQrisCancel();
//     } else if (_channels.isNotEmpty) {
//       if (_currentIndex >= 0 && _currentIndex < _channels.length) {
//         _createPayment(_channels[_currentIndex].code);
//       }
//     }
//   }

//   void _handleQrisCancel() {
//     setState(() {
//       _qrisContent = null;
//       _currentIndex = 0;
//       _ensureScrollVisible(0); // Scroll ke item pertama setelah batal
//     });
//   }

//   Future<void> _createPayment(String methodCode) async {
//     setState(() {
//       _isPaymentProcessing = true;
//       _qrisContent = null;
//       _errorMessage = null;
//     });

//     // Simulasi create payment
//     await Future.delayed(const Duration(seconds: 2));
//     if (!mounted) return;

//     setState(() {
//       _isPaymentProcessing = false;
//       if (methodCode.contains('QRIS')) {
//         _qrisContent =
//             'SimulasiQRISPayment|INV-${const Uuid().v4().substring(0, 12)}';
//         _currentIndex = 0; // Set fokus ke tombol cancel (item ke-0)
//       } else if (methodCode.contains('VA')) {
//         _showVaInfoDialog({
//           'bank': methodCode.replaceAll('VA', ''),
//           'va_number': '1234567890',
//           'amount': 30000,
//         });
//       }
//     });
//   }

//   // 🔥 Fungsi untuk memastikan item yang aktif terlihat
//   void _ensureScrollVisible(int index) {
//     if (_qrisContent != null)
//       return; // Tidak perlu scroll saat QRIS ditampilkan

//     final key = _itemKeys[index];
//     final context = key.currentContext;

//     if (context != null) {
//       // Tunggu sebentar untuk memastikan layout sudah dihitung
//       WidgetsBinding.instance.addPostFrameCallback((_) {
//         Scrollable.ensureVisible(
//           context,
//           duration: const Duration(milliseconds: 300),
//           alignment: 0.5, // Pusatkan item di tengah (0.5)
//           curve: Curves.easeOut,
//         );
//       });
//     }
//   }

//   KeyEventResult _handleDirectionalKey(RawKeyEvent event) {
//     if (event is! RawKeyDownEvent) return KeyEventResult.ignored;

//     final key = event.logicalKey;
//     if (key == LogicalKeyboardKey.select || key == LogicalKeyboardKey.enter) {
//       _executeAction();
//       return KeyEventResult.handled;
//     }

//     if (key != LogicalKeyboardKey.arrowDown &&
//         key != LogicalKeyboardKey.arrowUp) {
//       return KeyEventResult.ignored;
//     }

//     int totalItems = _qrisContent != null ? 1 : _channels.length;
//     if (totalItems == 0) return KeyEventResult.ignored;

//     int nextIndex = _currentIndex;

//     if (key == LogicalKeyboardKey.arrowDown) {
//       nextIndex = (nextIndex + 1) % totalItems;
//     } else if (key == LogicalKeyboardKey.arrowUp) {
//       nextIndex = (nextIndex - 1 + totalItems) % totalItems;
//     }

//     if (nextIndex != _currentIndex) {
//       setState(() {
//         _currentIndex = nextIndex;
//       });
//       // 🔥 Panggil fungsi scroll setelah state diperbarui
//       if (_qrisContent == null) {
//         _ensureScrollVisible(nextIndex);
//       }
//       return KeyEventResult.handled;
//     }

//     return KeyEventResult.ignored;
//   }

//   // Fungsi dialog VA dan Error
//   void _showVaInfoDialog(Map<String, dynamic> data) {
//     showDialog(
//       context: context,
//       barrierDismissible: false,
//       builder:
//           (context) => AlertDialog(
//             title: const Text('Virtual Account Dibuat (Simulasi)'),
//             content: Column(
//               mainAxisSize: MainAxisSize.min,
//               crossAxisAlignment: CrossAxisAlignment.start,
//               children: [
//                 Text('Bank: ${data['bank'] ?? '-'}'),
//                 const SizedBox(height: 8),
//                 const Text('Nomor Virtual Account:'),
//                 SelectableText(
//                   data['va_number'] ?? 'N/A',
//                   style: const TextStyle(
//                     fontWeight: FontWeight.bold,
//                     fontSize: 16,
//                   ),
//                 ),
//               ],
//             ),
//             actions: [
//               TextButton(
//                 onPressed: () => Navigator.of(context).pop(),
//                 child: const Text('OK'),
//               ),
//             ],
//           ),
//     );
//   }

//   void _showErrorDialog(String message) {
//     showDialog(
//       context: context,
//       builder:
//           (context) => AlertDialog(
//             title: const Text('Error'),
//             content: Text(message),
//             actions: [
//               TextButton(
//                 onPressed: () => Navigator.of(context).pop(),
//                 child: const Text('OK'),
//               ),
//             ],
//           ),
//     );
//   }

//   // ----------------- BUILD -----------------
//   @override
//   Widget build(BuildContext context) {
//     return Scaffold(
//       body: SafeArea(
//         child: RawKeyboardListener(
//           autofocus: true,
//           focusNode: _pageFocusNode,
//           onKey: _handleDirectionalKey,
//           child: _buildPaymentSelectionScreen(),
//         ),
//       ),
//     );
//   }

//   Widget _buildPaymentSelectionScreen() {
//     if (_qrisContent != null) return _buildQrisDisplay();
//     if (_isLoadingChannels || _isPaymentProcessing || _namaUser == null) {
//       return const Center(child: CircularProgressIndicator());
//     }
//     if (_channelsError != null) {
//       return Center(
//         child: Text(_channelsError!, style: const TextStyle(color: Colors.red)),
//       );
//     }

//     return Padding(
//       padding: const EdgeInsets.all(32.0),
//       child: Column(
//         crossAxisAlignment: CrossAxisAlignment.start,
//         children: [
//           const Text(
//             'Pilih Metode Pembayaran',
//             style: TextStyle(
//               fontSize: 28,
//               fontWeight: FontWeight.bold,
//               color: Colors.white,
//             ),
//           ),
//           const SizedBox(height: 20),
//           Expanded(
//             child: ListView.builder(
//               // 🔥 Tambahkan scrollController
//               controller: _scrollController,
//               itemCount: _channels.length,
//               itemBuilder: (context, index) {
//                 return Padding(
//                   padding: const EdgeInsets.only(bottom: 8.0),
//                   child: PaymentChannelCard(
//                     // 🔥 Tambahkan Key untuk keperluan Scrollable.ensureVisible
//                     key: _itemKeys[index],
//                     channel: _channels[index],
//                     isFocused: _currentIndex == index,
//                     onTap: () => _createPayment(_channels[index].code),
//                   ),
//                 );
//               },
//             ),
//           ),
//         ],
//       ),
//     );
//   }

//   Widget _buildQrisDisplay() {
//     final isCancelFocused = _currentIndex == 0;

//     return Center(
//       child: SingleChildScrollView(
//         child: Column(
//           mainAxisAlignment: MainAxisAlignment.center,
//           children: [
//             const Text(
//               'Scan QRIS ini untuk membayar',
//               style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
//             ),
//             const SizedBox(height: 30),
//             QrImageView(
//               data: _qrisContent!,
//               version: QrVersions.auto,
//               size: 300,
//               backgroundColor: Colors.white,
//               padding: const EdgeInsets.all(20),
//             ),
//             const SizedBox(height: 30),
//             // Tombol Cancel (Item ke-0 di mode QRIS)
//             ElevatedButton(
//               onPressed: _handleQrisCancel,
//               style: ElevatedButton.styleFrom(
//                 minimumSize: const Size(400, 60),
//                 backgroundColor:
//                     isCancelFocused ? Colors.red : Colors.grey.shade700,
//                 foregroundColor: Colors.white,
//                 elevation: isCancelFocused ? 10 : 2,
//               ),
//               child: const Text(
//                 'Pilih Metode Pembayaran Lain',
//                 style: TextStyle(fontSize: 20),
//               ),
//             ),
//           ],
//         ),
//       ),
//     );
//   }
// }

// // ------------------------------------------------------------------
// // PaymentChannelCard
// // ------------------------------------------------------------------

// class PaymentChannelCard extends StatefulWidget {
//   final PaymentChannel channel;
//   final bool isFocused;
//   final VoidCallback? onTap;

//   const PaymentChannelCard({
//     super.key,
//     required this.channel,
//     required this.isFocused,
//     this.onTap,
//   });

//   @override
//   State<PaymentChannelCard> createState() => _PaymentChannelCardState();
// }

// class _PaymentChannelCardState extends State<PaymentChannelCard> {
//   final ScrollController _textScrollController = ScrollController();

//   @override
//   void didUpdateWidget(covariant PaymentChannelCard oldWidget) {
//     super.didUpdateWidget(oldWidget);
//     if (widget.isFocused != oldWidget.isFocused) {
//       if (widget.isFocused) {
//         WidgetsBinding.instance.addPostFrameCallback((_) {
//           if (_textScrollController.hasClients) {
//             _startMarquee();
//           }
//         });
//       } else {
//         if (_textScrollController.hasClients) {
//           _textScrollController.jumpTo(0.0);
//         }
//       }
//     }
//   }

//   void _startMarquee() {
//     if (!widget.isFocused) return;

//     if (_textScrollController.position.maxScrollExtent > 0) {
//       _textScrollController
//           .animateTo(
//             _textScrollController.position.maxScrollExtent,
//             duration: const Duration(seconds: 5),
//             curve: Curves.linear,
//           )
//           .then((_) {
//             Future.delayed(const Duration(milliseconds: 500), () {
//               if (!mounted || !widget.isFocused) return;
//               if (_textScrollController.hasClients) {
//                 _textScrollController.jumpTo(0.0);
//               }
//               _startMarquee();
//             });
//           });
//     }
//   }

//   @override
//   void dispose() {
//     _textScrollController.dispose();
//     super.dispose();
//   }

//   @override
//   Widget build(BuildContext context) {
//     return GestureDetector(
//       onTap: widget.onTap,
//       child: AnimatedContainer(
//         duration: const Duration(milliseconds: 150),
//         decoration: BoxDecoration(
//           color: widget.isFocused ? Colors.blue.shade900 : Colors.grey.shade800,
//           borderRadius: BorderRadius.circular(8),
//           border: Border.all(
//             color: widget.isFocused ? Colors.red.shade700 : Colors.transparent,
//             width: 3,
//           ),
//           boxShadow:
//               widget.isFocused
//                   ? [
//                     BoxShadow(
//                       color: Colors.red.shade700.withOpacity(0.5),
//                       blurRadius: 10,
//                       spreadRadius: 2,
//                     ),
//                   ]
//                   : [],
//         ),
//         padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
//         child: Row(
//           children: [
//             // Logo Saluran Pembayaran dengan Background Putih
//             Container(
//               width: 66, // Lebar total 50 + 8 kiri + 8 kanan
//               height: 50,
//               decoration: BoxDecoration(
//                 color: Colors.white,
//                 borderRadius: BorderRadius.circular(4),
//               ),
//               // 🔥 Padding horizontal 8.0 ditambahkan di sini
//               padding: const EdgeInsets.symmetric(horizontal: 8.0),
//               child: ClipRRect(
//                 borderRadius: BorderRadius.circular(4),
//                 child: Image.network(
//                   widget.channel.logo,
//                   fit: BoxFit.contain,
//                   width: double.infinity,
//                   height: double.infinity,
//                   errorBuilder:
//                       (context, error, stackTrace) => Container(
//                         width: double.infinity,
//                         height: double.infinity,
//                         color: Colors.white,
//                         child: const Icon(
//                           Icons.payment,
//                           color: Colors.grey,
//                           size: 30,
//                         ),
//                       ),
//                 ),
//               ),
//             ),
//             const SizedBox(width: 16),
//             // Nama Saluran Pembayaran (Marquee)
//             Expanded(
//               child: SizedBox(
//                 height: 25,
//                 child: SingleChildScrollView(
//                   controller: _textScrollController,
//                   scrollDirection: Axis.horizontal,
//                   physics: const NeverScrollableScrollPhysics(),
//                   child: Row(
//                     children: [
//                       Text(
//                         widget.channel.name,
//                         maxLines: 1,
//                         style: TextStyle(
//                           color: Colors.white,
//                           fontSize: 18,
//                           fontWeight: FontWeight.bold,
//                         ),
//                       ),
//                       if (widget.isFocused) const SizedBox(width: 20),
//                     ],
//                   ),
//                 ),
//               ),
//             ),
//             const Icon(Icons.chevron_right, color: Colors.white70),
//           ],
//         ),
//       ),
//     );
//   }
// }

// lib/pages/payment_page.dart
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:uuid/uuid.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../services/socket_service.dart'; // 🔥 Pastikan path ini benar!
import '../models/voucher.dart';

// --- Model untuk Saluran Pembayaran ---
class PaymentChannel {
  final String code;
  final String name;
  final String logo;

  PaymentChannel({required this.code, required this.name, required this.logo});

  factory PaymentChannel.fromJson(Map<String, dynamic> json) {
    return PaymentChannel(
      code: json['code'] as String,
      name: json['name'] as String,
      logo: json['logo'] as String,
    );
  }
}
// ------------------------------------

class PaymentPage extends StatefulWidget {
  final Voucher selectedVoucher;

  const PaymentPage({Key? key, required this.selectedVoucher})
    : super(key: key);

  @override
  State<PaymentPage> createState() => _PaymentPageState();
}

class _PaymentPageState extends State<PaymentPage> {
  static const MethodChannel _channel = MethodChannel(
    "com.andro.emovies/payment",
  );

  final _storage = const FlutterSecureStorage();

  String? _emailUser;
  String? _qrisContent;
  String? _errorMessage;
  bool _isPaymentProcessing = false;

  int _currentIndex = 0;

  String? _namaUser;
  String? _noTelepon;

  // Data Saluran Pembayaran
  List<PaymentChannel> _channels = [];
  bool _isLoadingChannels = true;
  String? _channelsError;

  // Fokus dan Scroll
  final FocusNode _pageFocusNode = FocusNode(debugLabel: 'PaymentPageFocus');
  final List<GlobalKey> _itemKeys = [];
  final ScrollController _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    _loadUserData();
    _fetchPaymentChannels();
    // 🔥 INISIASI SOCKET
    SocketService().connect();
    _setupSocketListeners();
  }

  @override
  void dispose() {
    // 🔥 DISPOSE SOCKET
    SocketService().disconnect();
    _pageFocusNode.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  // Fungsi yang sudah ada (tidak diubah)
  Future<void> _fetchPaymentChannels() async {
    const url = 'http://aslan.web.id:8080/payment-channel';
    try {
      final response = await http.get(Uri.parse(url));

      if (response.statusCode == 200) {
        final List<dynamic> data = jsonDecode(response.body);
        _channels = data.map((json) => PaymentChannel.fromJson(json)).toList();
        _channelsError = null;

        _itemKeys.clear();
        for (int i = 0; i < _channels.length; i++) {
          _itemKeys.add(GlobalKey());
        }
      } else {
        _channelsError =
            'Gagal memuat saluran pembayaran. Status: ${response.statusCode}';
      }
    } catch (e) {
      _channelsError = 'Error fetching payment channels: $e';
    } finally {
      setState(() {
        _isLoadingChannels = false;
        if (_channels.isNotEmpty) {
          _currentIndex = 0;
        }
      });
    }
  }

  Future<void> _loadUserData() async {
    _namaUser = await _storage.read(key: 'nama_user');
    _noTelepon = await _storage.read(key: 'no_telepon');
    _emailUser = await _storage.read(key: 'user_email');
    setState(() {});
  }

  // 🔥 FUNGSI BARU/REVISI: Setup Socket Listeners
  void _setupSocketListeners() {
    SocketService().socket.on('payment_response', (data) {
      if (!mounted) return;

      setState(() => _isPaymentProcessing = false);

      if (data['data']?['checkout_url'] != null) {
        _openWebview(data['data']['checkout_url']);
      } else if (data['qris_content'] != null) {
        setState(() {
          _qrisContent = data['qris_content'];
          _currentIndex = 0; // Set fokus ke tombol cancel QRIS
        });
      } else if (data['va_number'] != null) {
        _showVaInfoDialog(data);
      } else {
        _errorMessage = data['message'] ?? 'Unknown error from server.';
        _showErrorDialog(_errorMessage!);
      }
    });

    SocketService().socket.on('payment_error', (data) {
      if (!mounted) return;
      setState(() {
        _isPaymentProcessing = false;
        _errorMessage = data['error'] ?? 'Unknown socket error.';
      });
      _showErrorDialog(_errorMessage!);
    });
  }

  void _executeAction() {
    if (_qrisContent != null) {
      _handleQrisCancel();
    } else if (_channels.isNotEmpty) {
      if (_currentIndex >= 0 && _currentIndex < _channels.length) {
        _createPayment(_channels[_currentIndex].code);
      }
    }
  }

  void _handleQrisCancel() {
    setState(() {
      _qrisContent = null;
      _currentIndex = 0;
      _ensureScrollVisible(0);
    });
  }

  // 🔥 FUNGSI REVISI: Menggunakan SocketService.emit
  Future<void> _createPayment(String methodCode) async {
    if (!SocketService().isConnected) {
      setState(() => _errorMessage = 'Not connected to server.');
      _showErrorDialog(_errorMessage!);
      return;
    }

    setState(() {
      _isPaymentProcessing = true;
      _qrisContent = null;
      _errorMessage = null;
    });

    final merchantRef = const Uuid().v4().substring(0, 12);

    final paymentData = {
      'method': methodCode,
      'merchant_ref': 'INV-$merchantRef',
      'amount': 30000,
      'customer_name': _namaUser,
      'customer_email': _emailUser,
      'customer_phone': _noTelepon,
      'order_items': [
        {
          'sku': 'VC-30K',
          'name': 'Voucher 20 Hari',
          'price': 30000,
          'quantity': 1,
          'product_url': 'http://localhost/product/vc-25k',
          'image_url': 'http://localhost/public/product/vc-25k.jpg',
        },
      ],
    };

    debugPrint("🔄 Emit create_payment: $paymentData");
    SocketService().emit('create_payment', paymentData);
  }

  // Fungsi yang sudah ada (tidak diubah)
  Future<void> _openWebview(String url) async {
    try {
      await _channel.invokeMethod('launchPaymentWebView', {'extra_url': url});
    } on PlatformException catch (e) {
      debugPrint("❌ Failed to open webview: ${e.message}");
    }
  }

  void _ensureScrollVisible(int index) {
    if (_qrisContent != null) return;

    final key = _itemKeys[index];
    final context = key.currentContext;

    if (context != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        Scrollable.ensureVisible(
          context,
          duration: const Duration(milliseconds: 300),
          alignment: 0.5,
          curve: Curves.easeOut,
        );
      });
    }
  }

  KeyEventResult _handleDirectionalKey(RawKeyEvent event) {
    if (event is! RawKeyDownEvent) return KeyEventResult.ignored;

    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.select || key == LogicalKeyboardKey.enter) {
      _executeAction();
      return KeyEventResult.handled;
    }

    if (key != LogicalKeyboardKey.arrowDown &&
        key != LogicalKeyboardKey.arrowUp) {
      return KeyEventResult.ignored;
    }

    int totalItems = _qrisContent != null ? 1 : _channels.length;
    if (totalItems == 0) return KeyEventResult.ignored;

    int nextIndex = _currentIndex;

    if (key == LogicalKeyboardKey.arrowDown) {
      nextIndex = (nextIndex + 1) % totalItems;
    } else if (key == LogicalKeyboardKey.arrowUp) {
      nextIndex = (nextIndex - 1 + totalItems) % totalItems;
    }

    if (nextIndex != _currentIndex) {
      setState(() {
        _currentIndex = nextIndex;
      });
      if (_qrisContent == null) {
        _ensureScrollVisible(nextIndex);
      }
      return KeyEventResult.handled;
    }

    return KeyEventResult.ignored;
  }

  void _showVaInfoDialog(Map<String, dynamic> data) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder:
          (context) => AlertDialog(
            title: const Text('Virtual Account Dibuat'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Bank: ${data['bank'] ?? '-'}'),
                const SizedBox(height: 8),
                const Text('Nomor Virtual Account:'),
                SelectableText(
                  data['va_number'] ?? 'N/A',
                  style: const TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 16,
                  ),
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('OK'),
              ),
            ],
          ),
    );
  }

  void _showErrorDialog(String message) {
    showDialog(
      context: context,
      builder:
          (context) => AlertDialog(
            title: const Text('Error'),
            content: Text(message),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('OK'),
              ),
            ],
          ),
    );
  }

  // ----------------- BUILD -----------------
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: RawKeyboardListener(
          autofocus: true,
          focusNode: _pageFocusNode,
          onKey: _handleDirectionalKey,
          child: _buildPaymentSelectionScreen(),
        ),
      ),
    );
  }

  Widget _buildPaymentSelectionScreen() {
    if (_qrisContent != null) return _buildQrisDisplay();
    if (_isLoadingChannels || _isPaymentProcessing || _namaUser == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_channelsError != null) {
      return Center(
        child: Text(_channelsError!, style: const TextStyle(color: Colors.red)),
      );
    }

    return Padding(
      padding: const EdgeInsets.all(32.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Pilih Metode Pembayaran',
            style: TextStyle(
              fontSize: 28,
              fontWeight: FontWeight.bold,
              color: Colors.white,
            ),
          ),
          const SizedBox(height: 20),
          Expanded(
            child: ListView.builder(
              controller: _scrollController,
              itemCount: _channels.length,
              itemBuilder: (context, index) {
                return Padding(
                  padding: const EdgeInsets.only(bottom: 8.0),
                  child: PaymentChannelCard(
                    key: _itemKeys[index],
                    channel: _channels[index],
                    isFocused: _currentIndex == index,
                    onTap: () => _createPayment(_channels[index].code),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildQrisDisplay() {
    final isCancelFocused = _currentIndex == 0;

    return Center(
      child: SingleChildScrollView(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text(
              'Scan QRIS ini untuk membayar',
              style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 30),
            QrImageView(
              data: _qrisContent!,
              version: QrVersions.auto,
              size: 300,
              backgroundColor: Colors.white,
              padding: const EdgeInsets.all(20),
            ),
            const SizedBox(height: 30),
            ElevatedButton(
              onPressed: _handleQrisCancel,
              style: ElevatedButton.styleFrom(
                minimumSize: const Size(400, 60),
                backgroundColor:
                    isCancelFocused ? Colors.red : Colors.grey.shade700,
                foregroundColor: Colors.white,
                elevation: isCancelFocused ? 10 : 2,
              ),
              child: const Text(
                'Pilih Metode Pembayaran Lain',
                style: TextStyle(fontSize: 20),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------
// PaymentChannelCard (Tidak ada perubahan pada Card ini)
// ------------------------------------------------------------------

class PaymentChannelCard extends StatefulWidget {
  final PaymentChannel channel;
  final bool isFocused;
  final VoidCallback? onTap;

  const PaymentChannelCard({
    super.key,
    required this.channel,
    required this.isFocused,
    this.onTap,
  });

  @override
  State<PaymentChannelCard> createState() => _PaymentChannelCardState();
}

class _PaymentChannelCardState extends State<PaymentChannelCard> {
  final ScrollController _textScrollController = ScrollController();

  @override
  void didUpdateWidget(covariant PaymentChannelCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.isFocused != oldWidget.isFocused) {
      if (widget.isFocused) {
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
  }

  void _startMarquee() {
    if (!widget.isFocused) return;

    if (_textScrollController.position.maxScrollExtent > 0) {
      _textScrollController
          .animateTo(
            _textScrollController.position.maxScrollExtent,
            duration: const Duration(seconds: 5),
            curve: Curves.linear,
          )
          .then((_) {
            Future.delayed(const Duration(milliseconds: 500), () {
              if (!mounted || !widget.isFocused) return;
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
    _textScrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: widget.onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        decoration: BoxDecoration(
          color: widget.isFocused ? Colors.blue.shade900 : Colors.grey.shade800,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: widget.isFocused ? Colors.red.shade700 : Colors.transparent,
            width: 3,
          ),
          boxShadow:
              widget.isFocused
                  ? [
                    BoxShadow(
                      color: Colors.red.shade700.withOpacity(0.5),
                      blurRadius: 10,
                      spreadRadius: 2,
                    ),
                  ]
                  : [],
        ),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            // Logo Saluran Pembayaran dengan Background Putih dan Padding
            Container(
              width: 66, // 50 (logo) + 8 (padding kiri) + 8 (padding kanan)
              height: 50,
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(4),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 8.0),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: Image.network(
                  widget.channel.logo,
                  fit: BoxFit.contain,
                  width: double.infinity,
                  height: double.infinity,
                  errorBuilder:
                      (context, error, stackTrace) => Container(
                        width: double.infinity,
                        height: double.infinity,
                        color: Colors.white,
                        child: const Icon(
                          Icons.payment,
                          color: Colors.grey,
                          size: 30,
                        ),
                      ),
                ),
              ),
            ),
            const SizedBox(width: 16),
            // Nama Saluran Pembayaran (Marquee)
            Expanded(
              child: SizedBox(
                height: 25,
                child: SingleChildScrollView(
                  controller: _textScrollController,
                  scrollDirection: Axis.horizontal,
                  physics: const NeverScrollableScrollPhysics(),
                  child: Row(
                    children: [
                      Text(
                        widget.channel.name,
                        maxLines: 1,
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      if (widget.isFocused) const SizedBox(width: 20),
                    ],
                  ),
                ),
              ),
            ),
            const Icon(Icons.chevron_right, color: Colors.white70),
          ],
        ),
      ),
    );
  }
}
