# Kontrak Terminal


Minicode **shell-native CLI, bukan TUI**. Tanpa alternate screen/panel/header permanen. Output append-only ke scrollback; picker/manager transient dan menghapus diri sendiri. Ini kenapa hasil agen bisa di-pipe, di-grep, dan tinggal di scrollback Anda sendiri.

## Dua stream, dua isi

| Stream | Isi |
|---|---|
| stdout | Output program: teks model (wrapped, fence 2-spasi), receipt perubahan (`› write_file …`), artefak perintah. Bersih dari cursor-control saat non-TTY |
| stderr | Progress/diagnostik: ledger tool (`› …` hijau/merah), reasoning (verbose), warning, error. Boleh transient bila TTY |

- Warna hanya bila TTY (`stdout.isTTY`); `NO_COLOR` menang; `TERM`/`COLORTERM` tidak menyalakan warna di pipe.
- Error `✗ pesan actionable` sekali per kegagalan (`takePendingError`) — bukan spam di setiap langkah.

## Lima primitif tampilan

1. Prompt `minicode <mode> ›`
2. Activity — garis transient di stderr
3. Ledger — `  › name target` hijau / `  › name: …` merah (stderr, indent 2)
4. Teks model — stdout, wrapped
5. Error actionable — sekali per kegagalan

## Arbitrasi transient

Satu-satunya arbitrator transient: `src/ui/runtime/statusline.ts` (`acquireTransientPaint` + `paintWrite`). Painter aktif (garis status turn vs spinner wizard) mutually exclusive; overlap = signal `[transient-paint]`, bukan crash. Foreign stderr writer (non-UI) boleh mentah — arbitrator mengkomitnya sebagai baris permanen bersih.

## 12 invariant

Peta lengkap 12 invariant + test proteksinya (`terminal-contract`, `transient-arbitration`, `turn-status`, `tui-format`, `theme`, `repl-linear`, `ui-boundary`) ada di `docs/TERMINAL_CONTRACT.md`. Setiap fitur terminal baru tunduk pada invariant itu — mis. tak boleh menulis cursor-control ke stdout non-TTY, tak boleh mengandalkan alternate screen.

## Aksesibilitas & konsol lawas

`MINICODE_ASCII=1` (glyph `[OK]`/`>`/`.`), `MINICODE_A11Y=1` (live-region approval polos tanpa ANSI), `MINICODE_BELL=0`, `MINICODE_DROPDOWN=0` (hint inline). Daftar lengkap di [Environment Variables](environment.md).

## Lanjut

- [Konsep & Desain](concepts.md) — kenapa shell-native dipilih.
- [REPL](repl.md) — interaksi harian di atas kontrak ini.
- [Arsitektur](architecture.md) — lapisan `src/ui/` dan boundary-nya.
