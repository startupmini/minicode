---
title: "Rename paket npm: minicode-ai"
date: 2026-09-17
tags: [release, npm]
desc: "Rilis Minicode yang tertahan sejak 0.9.21 akhirnya terbit sebagai minicode-ai. Kenapa nama berubah, apa yang tidak berubah, dan cara migrasi satu perintah."
---

Sejak 0.9.21, rilis Minicode tidak pernah sampai ke npm — publish selalu gagal, dan beberapa bulan terakhir kita tahu penyebabnya bukan bug. Hari ini masalahnya selesai: paket terbit dengan nama baru.

```bash
npm install -g minicode-ai
```

## Kenapa nama paket berubah

Cerita pendek dengan tiga kegagalan yang saling menggantikan:

1. **Scope `@miniroom` mati.** Rilis 0.9.24 dan 0.9.25 gagal dengan 404 saat publish: registry npm tidak lagi menerima paket baru di scope `@miniroom`. Tanpa itu, tidak ada versi baru yang bisa terbit — apapun isi changelognya.
2. **`minicode-cli` milik orang lain.** Nama itu sudah dipakai paket lain sejak lama, jadi bukan pilihan.
3. **Nama bare `minicode` ditolak registry.** Aturan anti-typosquatting npm menolak nama yang hanya berbeda tanda hubung dari paket yang sudah ada (`mini-code`) — publish ditolak 403 "Package name too similar". Blok ini permanen, bukan masalah yang bisa diurusi dengan tiket.

Nama final: **`minicode-ai`**. Nama produk, perintah, dan repo tidak berubah — hanya alamat paketnya di npm.

## Yang tidak berubah

- Perintah di terminal tetap `minicode` (bin tidak disentuh).
- Config dan state tetap di `~/.minicode/` — sesi, memori, dan checkpoint Anda aman.
- Lisensi MIT, repo GitHub, dan semua dokumentasi tetap sama.

## Migrasi

Pengguna versi lama (0.9.20 atau lebih):

```bash
npm uninstall -g @miniroom/minicode && npm install -g minicode-ai
```

Pengguna baru cukup:

```bash
npm install -g minicode-ai
```

Satu catatan jujur: auto-update di 0.9.20 masih mengarah ke nama paket lama yang mati, jadi migrasi pertama harus manual — blog post ini dan [halaman install](/docs/getting-started.html) yang bisa Anda bagikan ke siapa pun yang perlu. Setelah pindah, auto-update bekerja normal lagi ke paket baru.

## Isi 0.9.26

Karena 0.9.21–0.9.25 tidak pernah terbit di npm, versi ini membawa seluruh lompatan yang tertahan: hardening pasca-audit independen (bash-guard, budget mid-turn, sanitasi render ANSI), arsitektur control plane yang bisa diamati, dan rombak besar situs dokumentasi — termasuk hub [dokumentasi baru](/docs/) di minicode.fun. Daftar lengkapnya ada di [changelog](/docs/changelog.html).
