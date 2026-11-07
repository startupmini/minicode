---
title: "Plan mode Minicode: rencana dulu sebelum eksekusi"
date: 2026-09-12
tags: [minicode, plan-mode, tutorial]
desc: "Gunakan WorkMode PLAN untuk menganalisis repo dan menyusun artefak rencana tanpa mengubah source workspace."
---

Sebelum memberi agen akses tulis, Anda bisa meminta analisis dan rencana terlebih dahulu. WorkMode `PLAN` membatasi ruang kerja agent; ia boleh membaca dan mencari, menulis artefak rencana, serta mendelegasikan penelahan read-only, tetapi tidak mengubah source workspace.

```bash
minicode --work-mode PLAN "rencanakan migrasi auth ke OAuth"
```

Yang boleh di WorkMode PLAN: membaca file, `grep`/`glob`, membuat artefak rencana melalui `todo_write`, dan mendelegasikan penelahan read-only. Perubahan source file dan eksekusi shell ditolak oleh ceiling WorkMode. PermissionMode dan tool access policy tetap menjadi sumbu terpisah. `--plan` masih alias deprecated; gunakan `--work-mode PLAN`.

## Alur yang disarankan

1. Mulai dengan `--work-mode PLAN` dan minta rencana konkret per langkah.
2. Periksa daftar `todo` yang dihasilkan — ubah manual bila urutannya salah.
3. Jalankan ulang prompt yang sama dengan `--work-mode BUILD` untuk eksekusi, atau pindah WorkMode dengan Tab atau `/work-mode` di TUI.

## Kapan plan mode paling berguna

- Mengerjakan repo yang belum Anda pahami (baca dulu, tulis nanti).
- Meninjau usulan perubahan sebelum menyetujui eksekusi.
- Menyiapkan delegasi: parent dalam mode plan memaksa semua anak menjadi read-only, jadi satu sesi plan tak bisa "bocor" menjadi mutasi lewat sub-agen.

Batasan yang perlu diketahui: WorkMode PLAN menahan perubahan source, bukan pembacaan — agent tetap membaca isi repo Anda untuk menyusun rencana. PermissionMode diubah terpisah dengan Shift+Tab atau `/mode`. Detailnya ada di [Memilih Mode](/docs/choosing-mode.html) dan [Security Model](/docs/security-model.html).
