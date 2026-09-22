# Konsep & Desain

Minicode itu apa, kenapa dibangun begitu, dan kenapa beberapa hal sengaja tidak ada. Halaman ini latar belakangnya; langkah praktis ada di [Instalasi](getting-started.md).

## Dua benda, dua peran

| Nama | Apa |
|---|---|
| **MiniCore** | Kernel runtime `STATE / MODEL / ACTION / LOOP`. Inti di-freeze, zero-dependency, di-vendor ke `vendor/minicore` (19 file, ~72 KB). Bukan dependency — di-resolve lewat subpath imports `#minicore` |
| **Minicode** | Layer agencode di atasnya: tools, sub-agents, skills, hooks, policy/sandbox, providers, MCP/LSP, memory, sessions, repo-map, verifier, CLI shell-first |


## Loop ReAct

Setiap prompt berjalan sebagai loop `Thought → Action → Observation` sampai jawaban final, batas `--max-steps` (default 50), atau `--timeout` (default 15 menit). Model menerima system prompt berisi `# Environment` (cwd + platform), repo-map ringkas, dan memory yang relevan — lalu memilih tool, melihat hasilnya, dan memilih langkah berikutnya. Tidak ada grafik alur tersembunyi: apa pun yang agent lakukan tampil sebagai ledger di layar.

## Shell-first: non-interaktif polos, interaktif fullscreen

Minicode sengaja **tanpa framework TUI** (tanpa Ink/React, tanpa panel
permanen) dan membagi dua jalur secara tegas:

- **Non-interaktif** (one-shot prompt, `exec`, pipe/redirect/CI, `TERM=dumb`):
  output mengalir **append-only ke scrollback** — hasil agen adalah artefak
  terminal biasa yang bisa di-pipe, di-grep, dan tersimpan di scrollback Anda
  sendiri.
- **Interaktif** (TTY mampu): satu tampilan **TUI fullscreen** alternate-screen
  — transkrip ala shell + status bar satu baris + popup komposit; keluar =
  buffer utama kembali persis (transkrip tidak di-dump ke scrollback).
- Warna hanya saat TTY; `NO_COLOR` selalu menang; output program tetap bersih dari cursor-control saat di-pipe.

Detail lengkap + kontrak FROZEN-nya di [Kontrak Terminal](terminal.md).

## Kejujuran sebagai fitur

Beberapa keputusan desain lahir dari tidak mau berpura-pura:

- **Angka tidak ditulis permanen** di dokumentasi — jalankan `bun test` / `bun run gate:coverage` / lihat CI. Halaman yang mengklaim jumlah test akan usang begitu dipush.
- **Kegagalan dilaporkan apa adanya**: `auth login` menampilkan error server tanpa dipercantik; `--sync` jujur `{updated, failed}`; sandbox yang tidak tersedia **tidak** dilabeli aman — default turun ke `allowlist` dengan alasan dicetak sekali.
- **Ukur, bukan klaim**: bash-guard divalidasi korpus serangan + fuzz ber-seed (jalankan `bun run gate:bash` / `bun run extreme:fuzz`). Lihat [Keamanan](security.md).
- **Skor benchmark dilaporkan apa adanya** beserta batas validitasnya (lingkungan, ukuran sampel). Lihat [Verify & Benchmark](verify-benchmark.md).

## Zero-dep runtime

Runtime tanpa dependency pihak ketiga; satu-satunya kebutuhan keras adalah **Bun** (`bun:sqlite` dipakai langsung — tidak jalan di Node.js). Parser markdown web, renderer tabel/diff, dan highlight juga mini buatan sendiri, bukan library. Manfaatnya: audit permukaan lebih kecil, install cepat, dan supply-chain yang bisa dibaca sambil duduk.

## Bahasa

Dokumentasi dan komentar kode berbahasa **Indonesia** dengan istilah teknis tetap English (`provider`, `checkpoint`, `sandbox`, `jail`). Lihat [Glosarium](glossary.md) untuk daftar istilah.

## Lanjut

- [Arsitektur](architecture.md) — tiga lapisan, boundary, alur satu prompt.
- [Quickstart](quickstart.md) — dari nol ke prompt pertama yang ter-verify.
