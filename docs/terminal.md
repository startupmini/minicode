# Kontrak Terminal


Sesi interaktif berjalan sebagai **TUI alternate-screen** (transkrip milik app + status 1 baris di dasar + input, kontrak I16). Satu-satunya penulis piksel adalah viewport TUI via dirty-diff: resize = re-layout + redraw penuh dari state, repaint identik menulis NOL byte, tanpa space-fill selebar terminal. Terminal tak mampu (non-TTY/dumb/legacy/mungil) ditolak jujur — tidak ada fallback linier diam-diam. Jalur non-interaktif (one-shot, pipe, `exec --json`, subcommand) tetap append-only ke scrollback dan tak tersentuh.

## Dua stream, dua isi (jalur non-interaktif & log)

| Stream | Isi |
|---|---|
| stdout | Output program: teks model (wrapped, fence 2-spasi), receipt perubahan (`› write_file …`), artefak perintah. Bersih dari cursor-control saat non-TTY |
| stderr | Progress/diagnostik: ledger tool (`› …` hijau/merah), reasoning (verbose), warning, error. Boleh transient bila TTY |

- Warna hanya bila TTY (`stdout.isTTY`); `NO_COLOR` menang; `TERM`/`COLORTERM` tidak menyalakan warna di pipe.
- Error `✗ pesan actionable` sekali per kegagalan (`takePendingError`) — bukan spam di setiap langkah.

## Enam primitif tampilan (di dalam TUI)

1. Prompt `minicode ›` (steril — status pindah ke baris status)
2. Status — `✦ mode • model • cwd … 14.2k` (mode pad anti-geser; spark pulse saat busy/redup saat idle; konteks rata kanan)
3. Input — dropdown `/` dan reverse-search in-flow
4. Activity — spark denyut di status (bukan garis terpisah)
5. Ledger — `  › name target` hijau / `  › name: …` merah (indent 2)
6. Teks model — wrapped, fence 2-spasi; error actionable sekali per kegagalan

## TUI alternate screen

## TUI alternate screen

Satu-satunya penulis piksel adalah `src/ui/tui/screen.ts` (dirty-diff per baris, `?1049h/l` idempoten). Alur cetak builtin ditangkap ke dokumen; approval/ask/pick in-flow via `src/ui/tui/session.ts`. Resize = re-layout penuh; null byte bila identik. Hanya `src/ui/tui/` yang boleh impor `src/ui/*` + builtin.

## 14 invariant

Peta lengkap 16 invariant + test proteksinya (`terminal-contract`, `transient-arbitration`, `turn-status`, `tui-format`, `theme`, `tui-*`, `ui-boundary`, `footer-render`) ada di `docs/TERMINAL_CONTRACT.md`. Setiap fitur terminal baru tunduk pada invariant itu — mis. tak boleh menulis cursor-control ke stdout non-TTY, tak ada space-fill selebar terminal.

## Aksesibilitas & konsol lawas

`MINICODE_ASCII=1` (glyph `[OK]`/`>`/`.`), `MINICODE_A11Y=1` (live-region approval polos tanpa ANSI), `MINICODE_BELL=0`, `MINICODE_DROPDOWN=0` (hint inline). Daftar lengkap di [Environment Variables](environment.md).

## Lanjut

- [Konsep & Desain](concepts.md) — kenapa shell-native dipilih.
- [REPL](repl.md) — interaksi harian di atas kontrak ini.
- [Arsitektur](architecture.md) — lapisan `src/ui/` dan boundary-nya.
