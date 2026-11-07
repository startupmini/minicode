---
title: "Kenapa Minicode memisahkan TUI dan output shell-first"
date: 2026-09-10
tags: [minicode, cli, desain]
desc: "Sesi interaktif memakai TUI fullscreen; one-shot, pipe, dan CI memakai output shell-first yang mudah diproses."
---

MiniCode memiliki dua jalur tampilan. Saat terminal interaktif tersedia, sesi membuka TUI fullscreen agar prompt, transkrip, status, dan dialog izin bisa dipakai dalam satu ruang kerja. Hasil sesi tidak ditumpahkan ke scrollback terminal setelah layar dipulihkan.

Untuk one-shot, pipe, redirect, dan CI, MiniCode memakai keluaran append-only yang dapat dibaca atau diproses oleh program lain. `exec --json` menyediakan stream event mesin dengan kontrak tersendiri.

Pemisahan ini menjaga pengalaman interaktif tetap terarah tanpa mengorbankan otomasi. Render terminal memakai implementasi native MiniCode; tidak bergantung pada framework UI terminal eksternal.

Progress sementara dan isi transkrip memiliki lifecycle berbeda. Progress dibersihkan saat selesai, sementara pesan dan hasil tool menjadi bagian dari transkrip interaktif atau output biasa sesuai jalur yang dipakai.

Lihat [Kontrak Terminal](/docs/terminal.html) untuk aturan output dan [CLI](/docs/cli.html) untuk memilih jalur run.
