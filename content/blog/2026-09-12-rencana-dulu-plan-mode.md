---
title: "Plan mode Minicode: rencana dulu sebelum eksekusi"
date: 2026-09-12
tags: [minicode, plan-mode, tutorial]
desc: "Jalankan minicode --plan untuk membaca, mencari, dan menyusun rencana tanpa mengubah apa pun — termasuk daftar todo dan delegasi read-only."
---

Sebelum memberi agen akses tulis, ada baiknya melihat dulu apa rencananya. Mode plan (`--plan`) membuat sesi read-only: agen boleh membaca dan mencari, tetapi setiap percobaan tulis, bash, git, atau memori langsung ditolak di gerbang izin — bukan sekadar diminta tidak melakukannya.

```bash
minicode --plan "rencanakan migrasi auth ke OAuth"
```

Yang tetap boleh di mode plan: membaca file, `grep`/`glob`, menulis daftar rencana (`todo_write`, tersimpan di `.minicode/plans/`), dan mendelegasikan penelahan ke sub-agen — yang otomatis dipaksa read-only juga. Yang ditolak: `write_file`, `edit`, `bash`, `git_commit`, dan `write_memory`.

## Alur yang disarankan

1. Mulai dengan `--plan` dan minta rencana konkret per langkah.
2. Periksa daftar `todo` yang dihasilkan — ubah manual bila urutannya salah.
3. Jalankan ulang prompt yang sama **tanpa** `--plan` untuk eksekusi, atau pindah mode di REPL dengan `/mode`.

## Kapan plan mode paling berguna

- Mengerjakan repo yang belum Anda pahami (baca dulu, tulis nanti).
- Meninjau usulan perubahan sebelum menyetujui eksekusi.
- Menyiapkan delegasi: parent dalam mode plan memaksa semua anak menjadi read-only, jadi satu sesi plan tak bisa "bocor" menjadi mutasi lewat sub-agen.

Batasan yang perlu diketahui: plan mode menahan *efek*, bukan *pengetahuan* — agen tetap membaca isi repo Anda untuk menyusun rencana. Dan seperti biasa, pindah mode kapan pun dengan `/mode` atau Shift+Tab di REPL. Detail izin per mode ada di [Memilih Mode](/docs/choosing-mode.html) dan [Security Model](/docs/security-model.html).
