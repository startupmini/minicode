# Dokumentasi MiniCode

MiniCode adalah coding agent terminal yang dibangun di atas kernel MiniCore. Jalur interaktif memakai TUI fullscreen; jalur one-shot dan otomatis menulis ke scrollback atau stream mesin sesuai kontraknya.

## Mulai

1. Ikuti [instalasi](getting-started.md) dan pastikan Bun memenuhi versi minimum di `package.json`.
2. Gunakan [quickstart](quickstart.md) untuk menyiapkan provider dan menjalankan prompt pertama.
3. Baca [memilih mode](choosing-mode.md) sebelum memberi agent akses tulis atau eksekusi.

## Batas yang perlu diketahui

- Prompt dan konteks dikirim ke provider yang Anda pilih. Server MCP dan LSP yang dikonfigurasi juga dapat menerima data atau melakukan efek eksternal.
- Path jail, bash guard, WorkMode, PermissionMode, dan tool access policy membatasi eksekusi; tidak menjamin bahwa keluaran model benar.
- Batasan yang diketahui dan dokumentasi yang belum diverifikasi tercatat pada catatan rilis dan laporan audit bertanggal di repository.

## Peta dokumentasi

[SUMMARY.md](SUMMARY.md) adalah daftar navigasi halaman yang dibaca generator situs. Mulai dari sana untuk referensi CLI, TUI, provider, tools, keamanan, sesi, arsitektur, dan kontribusi. [ARCHITECTURE.html](ARCHITECTURE.html) memuat peta struktur repo yang lebih rinci.

## Pengembangan

Panduan contributor, gate, dan batas lapisan: [contributing.md](contributing.md). Aturan agent dan status fase ada di [`AGENTS.md`](../AGENTS.md); roadmap arsitektur tetap milik pemilik repo.
