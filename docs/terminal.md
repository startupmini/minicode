# Kontrak Terminal


Kontrak ini **FROZEN**: setiap perubahan perilaku terminal wajib update dokumen
ini + test peta proteksinya. Versi lengkap (kontrak internal kontributor, peta
proteksi per invariant, residual risk yang disengaja) ada di
[Terminal Contract](TERMINAL_CONTRACT.md).

## Satu tampilan interaktif: TUI fullscreen

Sesi interaktif (`minicode` di TTY mampu) SELALU membuka TUI **alternate
screen**: transkrip ala shell + status bar satu baris + popup komposit di atas
transkrip yang tetap terlihat (redup). REPL linier, footer lengket (chrome
scroll-region), overlay inline, dan jendela info **DIHAPUS** — tak ada mode,
tak ada flag legacy (`--tui` usang = no-op). Keluar = buffer utama kembali
persis; transkrip sesi tidak di-dump ke scrollback.

Jalur **non-interaktif** (one-shot prompt, `exec`, pipe/redirect/CI,
`TERM=dumb`, layar < 10 baris) tetap shell-first: cetak polos, append-only ke
scrollback, tanpa alternate screen. Justru jalur inilah yang membuat hasil agen
bisa di-pipe, di-grep, dan tinggal di scrollback Anda sendiri.

## Dua stream, dua isi

| Stream | Isi |
|---|---|
| stdout | Output program: teks model (wrapped, fence 2-spasi), receipt perubahan (`› write_file …`), artefak perintah. Bersih dari cursor-control saat non-TTY |
| stderr | Progress/diagnostik: ledger tool (`› …` hijau/merah), reasoning (verbose), warning, error. Boleh transient bila TTY — ditahan saat layar interaktif memegang terminal |

- Warna hanya bila TTY (`stdout.isTTY`); `NO_COLOR` menang; `TERM`/`COLORTERM` tidak menyalakan warna di pipe.
- Error `✗ pesan actionable` sekali per kegagalan (`takePendingError`) — bukan spam di setiap langkah.

## Primitif tampilan

1. Transkrip fullscreen — prompt `minicode ›` + jawaban model + ledger, viewport ikut ekor otomatis
2. Status bar satu baris — `✦ mode • model • cwd … ctx` (spark pulse saat busy/redup saat idle; konteks rata kanan)
3. Popup komposit satu kotak — `/model`, `/provider`, `/sessions`, form, approval; Esc dua-tahap, kursor diparkir
4. Ledger — `  › name target` hijau / `  › name: …` merah
5. Teks model & thinking — mengalir redup (thinking), di-buffer untuk `/expand`
6. Error actionable — sekali per kegagalan

## Arbitrasi transient + hold layar interaktif

Satu-satunya arbitrator transient: `src/ui/runtime/statusline.ts`
(`acquireTransientPaint` + `paintWrite`). Painter aktif (garis status turn vs
spinner wizard) mutually exclusive; overlap = signal `[transient-paint]`, bukan
crash. Foreign stderr writer (non-UI) boleh mentah — arbitrator mengkomitnya
sebagai baris permanen bersih.

`beginInteractiveScreen()` menahan SEMUA painter transient selama layar
interaktif memegang terminal (nol byte + baris painter dibersihkan sekali;
nested + release idempoten). Pemegangnya: `askLine`/`askSecret`/`runPicker`
(raw-mode) dan setiap handle `openAltScreen` (dilepas di `close()`). Tanpa ini
tick `\r\x1b[2K` spinner menghapus baris prompt wizard (laporan "macet di
Menyiapkan sesi…").

## Invariant I1–I30

Peta lengkap 30 invariant + test proteksinya (mis. `tui-app`, `screen-buffer`,
`tui-popup`, `transient-arbitration`, `input-resize`, `exit-codes`, `acp`) ada di
[Terminal Contract](TERMINAL_CONTRACT.md). Setiap fitur terminal baru tunduk
pada invariant itu — mis. tak boleh menulis cursor-control ke stdout non-TTY,
tak boleh mengandalkan alternate screen di jalur non-interaktif.

## Aksesibilitas & konsol lawas

`MINICODE_ASCII=1` (glyph `[OK]`/`>`/`.`), `MINICODE_A11Y=1` (live-region approval polos tanpa ANSI), `MINICODE_BELL=0`, `MINICODE_DROPDOWN=0` (hint inline). Daftar lengkap di [Environment Variables](environment.md).

## Lanjut

- [Konsep & Desain](concepts.md) — kenapa interaktif pakai alt-screen, non-interaktif shell-first.
- [TUI — Slash & Keyboard](repl.md) — interaksi harian di atas kontrak ini.