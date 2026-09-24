---
title: "Kenapa Minicode bekerja di terminal biasa"
date: 2026-09-10
tags: [minicode, cli, desain]
desc: "Kenapa output Minicode tetap terbaca seperti terminal: sesi interaktif TUI fullscreen dengan transkrip terlihat, non-interaktif shell-first di scrollback."
---

Minicode adalah coding agent CLI yang bekerja apa adanya di terminal Anda. Sesi interaktif memakai TUI fullscreen, tapi prinsipnya tetap sama: transkrip selalu terlihat (redup di bawah popup, bukan tersembunyi di balik panel), dan setiap langkah tetap berurutan seperti riwayat shell. Jalur non-interaktif — one-shot, pipe, redirect, CI — sepenuhnya shell-first: hasil mengalir di scrollback biasa, urut dari yang pertama sampai yang terakhir, siap di-pipe, di-grep, dan di-copy.

## Cara Minicode menangani tampilan

Ada dua jenis keluaran yang Minicode pegang secara terpisah:

- **Hasil kerja** — teks yang Anda minta, perubahan yang dilakukan, atau informasi yang Anda perlukan. Inilah yang paling penting, dan ia muncul di layar dengan jelas.
- **Informasi proses** — pesan singkat tentang apa yang sedang berjalan, seperti "sedang menyelesaikan langkah ini" atau "perhatian, ada hal yang perlu diperhatikan". Pesan ini muncul di tempat yang tidak mengganggu hasil kerja Anda.

Warna hanya digunakan jika layar Anda mendukungnya. Jika Anda mengirim hasil ke tempat lain (misalnya disimpan ke file atau diproses oleh program lain), output tetap bersih dan rapi — tidak ada karakter tambahan yang bisa mengganggu.

## Satu aturan untuk tampilan yang tidak mengganggu

Terkadang Minicode perlu menampilkan informasi sementara, misalnya garis kecil yang menunjukkan progres atau pertanyaan singkat yang harus Anda jawab. Informasi ini muncul hanya saat dibutuhkan, lalu hilang setelah selesai.

Untuk memastikan hal ini berjalan lancar, Minicode memiliki satu aturan saja: hanya satu proses yang boleh menampilkan informasi sementara pada saat yang sama. Jika ada program lain yang juga ingin menampilkan sesuatu, Minicode akan memastikan pesannya tetap muncul dengan rapi, tanpa mengganggu tampilan utama Anda.

## Kenapa begitu

Pendekatan ini membuat hasil kerja Anda tetap terlihat jelas, tidak ada yang bersembunyi, dan Anda selalu tahu apa yang sedang terjadi. Popup seperti `/model` atau `/sessions` muncul di atas transkrip yang tetap terlihat dan hilang begitu selesai — tidak ada panel yang mengganti isi layar Anda. Di luar sesi interaktif, Minicode tidak mengambil alih layar sama sekali.

Jika Anda ingin memahami lebih detail tentang bagaimana Minicode menangani tampilan ini, baca [Arsitektur](/docs/architecture.html) atau [Kontrak Terminal](/docs/terminal.html).
