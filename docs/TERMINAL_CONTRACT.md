# Terminal Contract MiniCode (FROZEN)

Dokumen ini membekukan kontrak terminal MiniCode setelah hardening rendering
(tahap 1–3, 2026-09-09). Tujuannya: developer berikutnya TIDAK boleh tanpa
sengaja mengembalikan pola UI noisy, state menggantung, raw ANSI pada pipe,
atau writer yang bypass ownership. Perubahan apa pun pada perilaku di bawah
wajib: update dokumen ini + test yang menjaganya (lihat "Peta proteksi").

## Sifat produk

MiniCode adalah **shell-native CLI, bukan TUI**. Tanpa alternate screen, tanpa
panel/sidebar/header permanen, tanpa layout yang di-redraw utuh. Output
append-only ke scrollback; layar interaktif (picker/manager) transient dan
menghapus diri sendiri.

## Contract stdout/stderr

| Stream | Isi | Catatan |
|---|---|---|
| stdout | Output PROGRAM yang bermakna: teks model, receipt perubahan (`✓ write_file …`), daftar/artefak perintah | Harus bersih dari cursor-control pada non-TTY |
| stderr | Human-facing progress/diagnostic: ledger tool (`✓/✗ …`), reasoning (verbose), warning, error | Boleh transient rendering bila stderr TTY |
| keduanya | Warna hanya bila stream TTY (`stdout.isTTY`); `NO_COLOR` menang; TERM/COLORTERM env TIDAK menyalakan warna pada pipe/redirect | Lihat `src/ui/render/theme.ts` `colorLevel()` |

Non-TTY (pipe/redirect/CI/file): **0 cursor control, 0 animasi spinner,
0 ANSI yang tidak diperlukan, output deterministic.**

## Klasifikasi writer (wajib dipatuhi)

1. **permanent user-visible output** — teks model, receipt, hasil perintah → stdout via `wOut`/console (idle).
2. **transient terminal rendering** — garis status turn, wizard spinner, prompt/overlay interaktif → HANYA lewat mekanisme ownership (lihat bawah).
3. **diagnostic/logging** — `[warn]`, `[router]`, `[mcp]`, `[vector]`, dst. dari layer non-UI → boleh `process.stderr.write` mentah; arbitrator terminal menjaga agar tidak hilang/merusak transient (lihat bawah).
4. **machine-readable output** — mis. `--json`, protokol MCP server → stdout saja, tanpa apa pun yang lain.
5. **debug-only output** — guard `verbose`/env; tidak pernah default.

## Ownership transient (single mechanism)

- `src/ui/runtime/statusline.ts` = SATU-SATUNYA arbitrator transient stderr.
  `acquireTransientPaint(kind)` + `paintWrite()` untuk painter; wrapper stderr
  aktif hanya saat ada owner. UI writers lain memakai `runWithoutStatus()`.
- Painter aktif: garis status turn (`kind: "turn"`) dan spinner wizard
  (`kind: "spinner"`) — secara desain mutually exclusive (fase disjoint).
  Overlap = runtime signal `[transient-paint] …`, bukan crash.
- **Foreign stderr writer (cat-3, non-UI) dibiarkan menulis mentah** — saat
  painter aktif, arbitrator mengkomit tulisannya sebagai baris permanen yang
  bersih (hapus garis transient → tulis → repaint). Tidak ada pesan yang hilang.
- Transient TIDAK boleh bocor ke scrollback; scrollback TIDAK boleh
  bergantung pada painter (permanent output selalu diakhiri newline sendiri).

## Invariant (nomor dipakai di peta proteksi)

1. Shell-native: tanpa alternate screen/panel/persistent chrome.
2. stdout/stderr contract seperti tabel di atas (TTY & non-TTY deterministic).
3. Transient rendering satu ownership mechanism (`statusline.ts`).
4. Permanent scrollback tidak bergantung pada transient painter.
5. Tidak ada transient stale setelah success / failure / cancellation /
   SIGINT / retry / detach / session end (`endTurn` di driver; kernel hanya
   emit `turn:completed` di jalur sukses — lihat lifecycle turn-status.ts).
6. Non-TTY: 0 cursor control / spinner animation / ANSI tak diperlukan.
7. Tool activity default compact; ledger compact `✓ nama target` satu baris,
   tanpa bocor isi file; isi hanya di expanded/verbose.
8. Streaming tanpa duplicate output / overlap / stale spinner-status.
9. Foreign stderr writers boleh mentah di layer non-UI; arbitrator menjaga
   output mereka (tidak hilang, tidak merusak transient).
10. Wizard spinner vs turn painter mutually exclusive (signal overlap).
11. Resize memakai lebar SAAT PAINT (bukan lebar saat event).
12. Long session tetap readable (ledger per tool = satu baris, konten tidak
    mengalir ke scrollback kecuali expanded/verbose).

## Grammar (ringkas)

prompt `minicode <mode> ›` · activity: garis transient stderr (`✦···`
putih↔abu kelip-kelip tiap tick, ·→··→··· ±300ms adaptif + `label-tool···`,
tak pernah bare; kecepatan mengikuti reasoning) · section collapse:
thinking/bash/edit/content MINIMIZED default (stderr) — satu baris
`  + label`, isi di-buffer (cap 200KB) untuk `/expand`; `+`/`-`/Ctrl+T saat
turn (raw mode) expand/minimize live, toggle menambah baris header baru
(`  − label` / `  + label`) · startup: `⠋ Checking for updates…`
(TTY, max 1.8s, hilang tanpa jejak) · `/thinking` atau Ctrl+T: toggle
reasoning expanded/minimized (`MINICODE_SHOW_THINKING`) ·
ledger tool `  › name target` (hijau) / `  › name: …` (merah, stderr, indent 2) ·
model text (stdout, wrapped per baris, fence 2-spasi) ·
error: `✗ pesan actionable` sekali per kegagalan (`takePendingError`).

## Residual risk (DISENGAJA — jangan "perbaiki" tanpa keputusan)

1. **Foreign partial stderr write tanpa newline** saat painter aktif tidak
   dipaksa menjadi line-oriented — bisa berakhir sebaris dengan label
   berikutnya. Non-destruktif; memaksa line-buffering = mengubah kontrak
   penulis non-UI.
2. **Overlap painter/spinner** adalah runtime signal (`[transient-paint] …`)
   dan harus tetap observable — bukan error tersembunyi, bukan crash.
3. **TTY-harness flake lama** (raw-mode resume antar-test di
   `model-manager-flows`) dicatat terpisah dari regresi — jangan dianggap
   kegagalan kontrak.
4. **Runtime stderr rusak (bug Bun Windows `kWriteMonkeyPatchDefense`)**:
   `stderr.write` detached melempar TypeError dari internal writeFast —
   tiap turn TTY gagal total di 0.9.8. `statusline.ts` fail-closed:
   selalu method-call (tak pernah detached), `paintWrite` tak pernah
   melempar, dan transient self-disable permanen + restore write asli
   begitu marker terlihat — agen tetap jalan tanpa spinner.

## Peta proteksi (test → invariant)

- `test/terminal-contract.test.ts` — I2/I3/I5/I7/I8/I9/I10/I12 (konsolidasi).
- `test/transient-arbitration.test.ts` — I3/I9 (foreign-write dikomit,
  repaint, overlap signal, non-TTY bebas kontrol).
- `test/statusline-bun-guard.test.ts` — I4/I5 (method-call only,
  self-disable + restore, transient tak pernah gagalkan turn).
- `test/turn-status.test.ts` — I5/I10 (lifecycle, endTurn tanpa
  `turn:completed`, resize 40→120).
- `test/tui-format.test.ts` (describe kontrak output) — I2/I7/I8 (ledger
  newline, tanpa bocor isi, stdout/stderr terpisah, 20 tool tanpa overlap).
- `test/theme.test.ts` — I6 (warna mati saat stdout non-TTY walau COLORTERM).
- `test/repl-linear.test.ts` / `tui-classic` — I5 interaksi user
  (Ctrl+C/Esc/idle).
- `test/ui-boundary.test.ts` — I1/I3 batas lapisan (ui tak impor keluar).
