# Minicode — Dokumentasi

Minicode adalah coding agent CLI berbahasa Indonesia. Ia membantu Anda bekerja dengan kode — membaca, menulis, mencari, dan menjalankan perintah — dengan menerima perintah dalam bahasa Indonesia atau Inggris.

Minicode dibangun di atas kernel kecil bernama MiniCore. Kernel inilah yang mengurus pekerjaan inti: menerima permintaan, memilih langkah, menjalankan alat, dan melaporkan hasilnya.

## Apa itu Minicode?

Singkatnya: Minicode adalah asisten yang bekerja di terminal. Anda memberinya tugas dalam bahasa Indonesia atau Inggris, dan ia melakukan pekerjaan tersebut langkah demi langkah, sambil menunjukkan apa yang sedang dilakukan.

Di balik layar, ada dua bagian utama:

- **MiniCore** — bagian inti yang dibekukan. Ia mengurus alur kerja dasar: menerima permintaan, memilih tindakan, menjalankan alat, dan melaporkan hasil. Bagian ini sengaja dibuat kecil dan stabil. Versi Minicode berikutnya tidak akan mengubah inti ini, kecuali untuk tambahan kecil yang tidak mengganggu fungsi aslinya.

- **Minicode** — bagian yang Anda gunakan. Ia bekerja di terminal, menerima perintah dalam bahasa Indonesia atau Inggris, dan menggunakan berbagai alat untuk menyelesaikan tugas Anda. Alat-alat yang tersedia antara lain: membaca dan menulis file, menjalankan perintah, mencari di kode, terhubung ke penyedia Kecerdasan Buatan (AI), serta beberapa alat bantu lain.

## Struktur singkat

Berikut adalah gambaran singkat tentang apa yang ada di dalam Minicode. Ini bukan informasi wajib untuk penggunaan umum, tetapi bisa membantu Anda memahami biaya dan cara kerjanya.

- **Komponen inti** (`vendor/minicore`) — kernel yang dibekukan, tidak bergantung pada paket lain.
- **Alat-alat** — untuk membaca dan menulis file, menjalankan perintah, dan bekerja dengan kode.
- **Penanganan tugas** — dapat membagi pekerjaan ke agen lain yang bekerja secara terpisah.
- **Kebijakan keamanan** — membatasi apa yang boleh dijalankan, sehingga pekerjaan tetap terkendali.
- **Penyedia Kecerdasan Buatan** — terhubung ke layanan AI yang Anda pilih.
- **Alat bantu eksternal** — bisa terhubung ke layanan MCP dan LSP untuk fungsi tambahan.
- **Memori & sesi** — mencatat riwayat pekerjaan dan menyimpan ringkasan yang relevan.
- **Kemampuan khusus** — seperti membaca struktur kode, menyimpan dan melanjutkan sesi, serta pemeriksaan otomatis.

## Privasi & kejujuran

Beberapa hal penting yang perlu Anda tahu:

- **Tidak ada data yang dikirim tanpa sepengetahuan Anda.** Konfigurasi Anda tersimpan di komputer Anda sendiri. Token akses disimpan dengan aman dan tidak disebarkan.
- **Kegagalan dilaporkan apa adanya.** Jika ada masalah, Minicode akan memberitahu secara langsung, tanpa disamarkan.
- **Informasi kuantitatif tidak ditulis secara permanen di sini.** Jika Anda ingin tahu jumlah test, cakupan, atau jumlah alat yang tersedia, jalankan perintah `bun test`, `bun run gate:coverage`, atau lihat hasil di layanan continuous integration (CI). Informasi seperti ini bisa berubah sewaktu-waktu.
- **Riwayat perubahan** tercatat di `CHANGELOG.md` di direktori utama repo.

## Mulai dalam 5 menit

Yang Anda butuhkan: Bun versi 1.0 ke atas. Tidak perlu instalasi lain.

```bash
# Salin repo ke komputer Anda
git clone https://github.com/startupmini/minicode && cd minicode

# Pasang ketergantungan
bun install && bun link
```

Selanjutnya, coba perintah-perintah ini untuk melihat bagaimana Minicode bekerja:

```bash
minicode                # Mulai Minicode — akan muncul panduan jika ini pertama kalinya
minicode "buat http server" --verbose
minicode auth login     # OAuth device-code bila provider mendukung; lainnya via API key
minicode providers      # Lihat daftar penyedia yang tersedia
minicode doctor         # Cek kondisi jika ada yang tidak beres
```

Untuk langkah selanjutnya — mulai dari awal sampai membuat prompt pertama yang terverifikasi — baca [Quickstart](quickstart.md). Jika Anda ingin tahu tentang instalasi di sistem operasi berbeda, atau cara memperbarui dan menghapus Minicode, baca [Instalasi](getting-started.md).

## Mulai di sini

Anda baru dan tak mau menebak urutan baca? Ikuti jalur ini (total ±15 menit):

0. **Apa Minicode?** — [Konsep & Desain](concepts.md) (3 menit): apa, kenapa, dan apa yang sengaja tidak ada.
1. **Install** — [Instalasi](getting-started.md) (5 menit): Bun, clone, `doctor`.
2. **Prompt pertama** — [Quickstart](quickstart.md) (5 menit): wizard/API key atau OAuth, prompt ter-verify pertama.
3. **Pilih mode** — [Memilih Mode](choosing-mode.md) (2 menit): baca, ubah, approve, atau plan.
4. **Workflow pertama** — [CLI](cli.md) + [TUI — Slash & Keyboard](repl.md): flag harian dan slash command sesuai kebutuhan.

Habis itu, baca sesuai kebutuhan lewat tabel Navigasi di bawah — tak perlu berurutan.

## Navigasi

| Anda ingin... | Baca... |
|---|---|
| Mengerti apa itu Minicode dan alasan dibaliknya | [Konsep & Desain](concepts.md) |
| Cara menginstall, memperbarui, atau menghapusnya | [Instalasi](getting-started.md) |
| Mulai dari nol sampai membuat prompt pertama yang terverifikasi | [Quickstart](quickstart.md) |
| Arti istilah-istilah yang dipakai di sini | [Glosarium](glossary.md) |
| Semua perintah CLI dan flag yang tersedia | [CLI](cli.md) |
| Perintah khusus di dalam Minicode dan tombol pintas | [TUI — Slash & Keyboard](repl.md) |
| Cara menjalankan Minicode tanpa interaksi (otomatis / di CI) | [Otomasi & CI](exec.md) |
| Cara menyimpan pengaturan dan di mana data tersimpan | [Config](config.md) |
| Cara menambah penyedia AI dan mengelola akses | [Config & Provider](config-providers.md) |
| Cara memperkirakan biaya dan membatasi pengeluaran | [Pricing & Budget](pricing-budget.md) |
| Semua variabel lingkungan yang tersedia | [Environment Variables](environment.md) |
| Cara membuat perintah khusus (skill) dan skrip terbatas | [Skills & Hooks](skills.md) |
| Sub-agent `delegate_task`, mode explore/plan, recovery | [Sub-Agents & Tasks](agents.md) |
| MCP stdio/HTTP, LSP, `mcp serve` | [MCP & LSP](mcp-lsp.md) |
| Memory RAG, sessions, undo/redo, recovery journal | [Memory & Sessions](memory-sessions.md) |
| Auto-verify, benchmark, SWE-bench Lite, harness audit | [Verify & Benchmark](verify-benchmark.md) |
| Permission mode, bash-guard, jail, sandbox | [Policy & Sandbox](policy-sandbox.md) |
| Threat model, prompt injection, supply chain | [Keamanan](security.md) |
| Error umum + `doctor` | [Troubleshooting](troubleshooting.md) |
| Peta lapisan, alur satu prompt | [Arsitektur](architecture.md) |
| Kontrak stdout/stderr FROZEN, invariant I1–I31 | [Kontrak Terminal](terminal.md) |
| Kontrak internal kontributor: terminal FROZEN, control-plane, pipeline render | [Internal & Arsitektur](TERMINAL_CONTRACT.md) (grup di sidebar) |
| Ikut kontribusi, gate, batas lapisan | [Contributing](contributing.md) |
| Perubahan per versi | [Changelog](changelog.md) |
| Arsip panduan monolit lama (baca hanya bila perlu) | `USAGE.md` (file pendamping, status legacy) |

## Konvensi dokumen ini

- Bahasa: **Indonesia**, istilah teknis tetap English (`provider`, `checkpoint`, `sandbox`).
- Komentar kode di repo juga Indonesia (menjelaskan *mengapa*, bukan *apa*).
- Setiap klaim perilaku merujuk ke `file:line` agar bisa diverifikasi dengan `read_file` + `offset`/`limit`.
- Encoding UTF-8 tanpa BOM. Jangan commit rahasia (API key, token OAuth).
