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
menghapus diri sendiri. **Satu-satunya chrome permanen yang diizinkan: footer
status lengket** (`chrome.ts`, DECSTBM scroll-region) — dibuat demi prompt
steril; wajib reset region di semua jalur keluar dan nol byte di non-TTY.

## Contract stdout/stderr

| Stream | Isi | Catatan |
|---|---|---|
| stdout | Output PROGRAM yang bermakna: teks model, receipt perubahan (`› write_file …`), daftar/artefak perintah | Harus bersih dari cursor-control pada non-TTY |
| stderr | Human-facing progress/diagnostic: ledger tool (`› …` hijau/merah), reasoning (verbose), warning, error | Boleh transient rendering bila stderr TTY |
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

1. Shell-native: tanpa alternate screen/panel/persistent chrome — KECUALI
   footer status lengket (`chrome.ts`), satu-satunya chrome permanen, dengan
   reset region wajib di semua jalur keluar.
 13. Footer lengket: hanya aktif pada stdout TTY + terminal mampu (`MINICODE_FOOTER
     ≠ off`, `rows ≥ 12`, bukan console legacy); non-TTY nol byte; reset `\x1b[r`
     dijamin pada detach/exit (normal, SIGINT, `process.on("exit")`); repaint
     memakai lebar/tinggi SAAT paint (resize listener); mode di-repaint di
     tempat saat berubah (Shift+Tab) tanpa memindahkan kursor; `Esc` saat
     turn = abort (lone-ESC 50ms) tanpa teks, `Ctrl+C 1x` saat idle = copy
     (OSC 52) dan `2x` = keluar; mode pad lebar tetap, spark pulse saat
     busy/redup saat idle, konteks rata kanan, garis `faint`.
 14. Idle binding: `Esc` / `Ctrl+C` / `Ctrl+D` resolve `null` (cancel);
     `Ctrl+C` pertama = copy teks turn terakhir, kedua beruntun = keluar;
     abort turn via lone `Esc` maupun `Ctrl+C` menghentikan spark footer.
2. stdout/stderr contract seperti tabel di atas (TTY & non-TTY deterministic).
3. Transient rendering satu ownership mechanism (`statusline.ts`).
4. Permanent scrollback tidak bergantung pada transient painter.
5. Tidak ada transient stale setelah success / failure / cancellation /
   SIGINT / retry / detach / session end (`endTurn` di driver; kernel hanya
   emit `turn:completed` di jalur sukses — lihat lifecycle turn-status.ts).
6. Non-TTY: 0 cursor control / spinner animation / ANSI tak diperlukan.
7. Tool activity default compact; ledger compact `› nama target` satu baris,
   tanpa bocor isi file; isi hanya di expanded/verbose. Section besar
   (thinking/bash/edit/content) default minimize: satu baris `  + label`,
   isi di-buffer untuk `/expand`.
8. Streaming tanpa duplicate output / overlap / stale spinner-status.
9. Foreign stderr writers boleh mentah di layer non-UI; arbitrator menjaga
   output mereka (tidak hilang, tidak merusak transient).
10. Wizard spinner vs turn painter mutually exclusive (signal overlap).
11. Resize memakai lebar SAAT PAINT (bukan lebar saat event).
12. Long session tetap readable (ledger per tool = satu baris, konten tidak
    mengalir ke scrollback kecuali expanded/verbose).

## Grammar (ringkas)

prompt `minicode ›` (steril — status pindah ke footer) · footer status
`src/ui/runtime/chrome.ts` + `src/ui/footer.ts`: 2 baris dasar lengket (DECSTBM
scroll-region) ATAU cetak fallback, berisi `✦ mode • model • cwd … 14.2k` (mode
pad lebar tetap anti-geser; spark pulse saat busy/redup saat idle; konteks
rata kanan polos `14.2k`; garis faint tipis); `MINICODE_FOOTER=off|print|
sticky|auto` (default auto = lengket bila terminal mampu, cetak bila tidak;
pipa selalu nol byte) · activity: garis transient stderr (`···`
 ·→··→··· interval 80–320ms adaptif + `label-tool···`, tak pernah bare;
kecepatan mengikuti reasoning) · section
collapse: thinking + tool (bash/edit/content) MINIMIZED default (stderr) —
satu baris `  + label`, isi di-buffer (200KB/entry, 500KB total) untuk
`/expand` (sekali pakai, lalu buffer dikosongkan); `+`/`=`/`-`/`_`/Ctrl+T
saat turn TTY (raw mode) expand/minimize live dengan feedback transient;
toggle thinking menambah baris header (`  − thinking` / `  + thinking`),
toggle tool flip mode untuk completion berikutnya; pipe/CI tanpa tombol live ·
startup: `⠋ Checking for updates…` (TTY, max 1.8s, hilang tanpa jejak) ·
`/thinking` atau Ctrl+T: toggle reasoning expanded/minimized
(`MINICODE_SHOW_THINKING`) · `/minimize`: tool minimize (thinking tak tersentuh) ·
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
5. **Footer region bocor bila proses dibunuh `kill -9`** (tanpa kesempatan
   reset `\x1b[r`): terminal hanya scroll di area atas sampai direset.
   Mitigasi: reset di semua jalur keluar + handler `process.on("exit")`
   sinkron; bila terjadi, ketik `reset` (pola standar, bukan bug baru).
6. **Footer tertimpa program anak** yang menulis kursor ke baris dasar:
   jendela basi ≤ 1 turn — chrome merepaint tiap idle (self-heal).
7. **Program anak mengubah ukuran terminal** saat region aktif: resize
   listener me-re-set region + repaint; jendela antara resize dan paint
   bisa berkedip halus di terminal tanpa dukungan `?2026` synchronized.

## Peta proteksi (test → invariant)

- `test/footer-render.test.ts` / `test/footer-chrome.test.ts` — I1/I6 (chrome
  footer: non-TTY nol byte, mode off/print/sticky/auto, region DECSTBM,
  reset-on-detach, repaint, reserve dropdown).
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
