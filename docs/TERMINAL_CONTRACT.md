# Terminal Contract MiniCode (FROZEN)

Dokumen ini membekukan kontrak terminal MiniCode setelah hardening rendering
(tahap 1–3, 2026-09-09). Tujuannya: developer berikutnya TIDAK boleh tanpa
sengaja mengembalikan pola UI noisy, state menggantung, raw ANSI pada pipe,
atau writer yang bypass ownership. Perubahan apa pun pada perilaku di bawah
wajib: update dokumen ini + test yang menjaganya (lihat "Peta proteksi").

## Sifat produk

MiniCode adalah **agen coding CLI dengan dua permukaan**: sesi interaktif
berjalan sebagai **TUI alternate-screen satu sesi penuh** (transkrip milik
app + status 1 baris + input, kontrak I16); semua jalur non-interaktif
(one-shot, pipe, `exec --json`, subcommand) tetap **shell-native**
append-only ke scrollback. Layar interaktif pra-sesi (wizard) dan dialog
TTY non-sesi transient dan menghapus diri sendiri. Tanpa panel/sidebar/
header permanen di luar definisi I16; tanpa layout yang di-redraw utuh
kecuali viewport TUI. **Nol byte di non-TTY** (I6) di semua mode.

## Contract stdout/stderr

| Stream | Isi | Catatan |
|---|---|---|
| stdout | Output PROGRAM yang bermakna: teks model, receipt perubahan (`› write_file …`), daftar/artefak perintah | Harus bersih dari cursor-control pada non-TTY |
| stderr | Human-facing progress/diagnostic: ledger tool (`› …` hijau/merah), reasoning (verbose), warning, error | Boleh transient rendering bila stderr TTY |
| keduanya | Warna hanya bila stream TTY (`stdout.isTTY`); `NO_COLOR` menang; TERM/COLORTERM env TIDAK menyalakan warna pada pipe/redirect | Lihat `src/ui/render/theme.ts` `colorLevel()` |

Non-TTY (pipe/redirect/CI/file): **0 cursor control, 0 animasi spinner,
0 ANSI yang tidak diperlukan, output deterministic.**

Exit codes: `0` sukses/help yang diminta; `1` gagal runtime (provider,
budget, error turn, setup gagal); `2` salah pakai (argv hilang/malformed,
subcommand asing). Lookup yang gagal (id tak dikenal) = `1`: kegagalan
operasi, bukan pemakaian.

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
- **Layar interaktif mengalahkan painter** (`beginInteractiveScreen()` di
  `statusline.ts`, dipanggil picker + `askLine`/`askSecret`): selama layar
  raw-mode hidup, `paintWrite` menulis **nol byte** dan baris painter terakhir
  dibersihkan sekali saat layar mengambil alih. Alasannya bukan estetika:
  frame `\r\x1b[2K` dari stderr menghapus baris tempat layar baru menulis
  prompt, sehingga wizard setup pertama tampak macet di `Menyiapkan sesi…`
  tanpa cara menyelesaikannya. Painter tidak perlu tahu soal layar; aturan
  ditegakkan satu tempat agar painter baru otomatis patuh.
- **Foreign stderr writer (cat-3, non-UI) dibiarkan menulis mentah** — saat
  painter aktif, arbitrator mengkomit tulisannya sebagai baris permanen yang
  bersih (hapus garis transient → tulis → repaint). Tidak ada pesan yang hilang.
- Transient TIDAK boleh bocor ke scrollback; scrollback TIDAK boleh
  bergantung pada painter (permanent output selalu diakhiri newline sendiri).

## Invariant (nomor dipakai di peta proteksi)

1. Shell-native untuk SEMUA jalur non-interaktif; sesi interaktif = TUI
   alternate screen satu sesi penuh (I16). Tanpa panel/sidebar/header
   permanen di luar I16; tanpa redraw utuh kecuali viewport TUI.
  13. Baris status TUI: hanya aktif pada stdout TTY + terminal mampu (bukan
     console legacy, bukan dumb, `rows ≥ 10`); non-TTY nol byte; leave
     `?1049l`+`?25h` dijamin pada detach/exit (normal, SIGINT,
     `process.on("exit")`); repaint memakai lebar/tinggi SAAT paint;
     resize = re-layout + redraw penuh dari state (tak ada lukisan absolut
     yang bisa basi) — dipicu listener `resize` driver (debounce 50ms +
     `invalidate()`), BUKAN menunggu keypress; repaint identik menulis NOL
     byte (dirty-check);
     larangan space-fill selebar terminal (reflow ghost — konteks rata kanan
     via CHA); mode di-repaint saat berubah (Tab/Shift-Tab) tanpa memindahkan
     kursor; `Esc` saat turn = abort (lone-ESC 50ms) tanpa teks, `Ctrl+C 1x`
     saat idle = copy (OSC 52) dan `2x` = keluar; mode pad lebar tetap,
     spark pulse saat busy/redup saat idle, konteks rata kanan.
 14. Idle binding: `Esc` / `Ctrl+C` / `Ctrl+D` resolve `null` (cancel);
     `Ctrl+C` pertama = copy teks turn terakhir, kedua beruntun = keluar;
     abort turn via lone `Esc` maupun `Ctrl+C` menghentikan spark status.
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
15. Layar interaktif (picker, `askLine`, `askSecret`) menahan SEMUA painter
    transient stderr: nol byte selama layar memegang terminal, painter hidup
    lagi setelah release terakhir (depth); release idempoten di semua jalur
    (sukses/batal/error/idle-timeout).
16. Mode TUI (alternate screen per sesi — `src/ui/tui/`, driver `cli/repl-tui.ts`):
    sesi interaktif **wajib TUI** (prompt shell-like bertumpuk + footer status
    baris-R permanen, input di bawah transkrip). Masuk `?1049h` dan keluar
    `?1049l`+`?25h` lewat SATU fungsi leave idempoten di SEMUA jalur keluar
    (normal, SIGINT/SIGTERM, crash, `process.on("exit")`); tanpa itu user
    terdampar. Resize = re-layout + redraw penuh dari state; repaint identik
    NOL byte; larangan space-fill selebar terminal (reflow ghost — CHA);
    transcript milik app (cap 5000, follow-mode) berisi **jejak prompt**
     `minicode › <teks>` + output model/ledger seperti PowerShell; keluar
     mencetak info sesi (`sesi <id> • <N> turn • lanjut: minicode --resume
     <id>`), riwayat layar dibuang. Lapisan: `src/ui/tui/` hanya impor
     `src/ui/*` + node builtin (dijaga `test/ui-boundary`). Fallback linear
     **dihapus** — terminal tak mampu = `exit 1` + pesan actionable (bukan
     diam); jalur non-interaktif tak tersentuh. Jaring sanitasi: baris
     dokumen/input disanitasi di `screen` (SGR lewat; status dikecualikan
     karena CHA tepercaya — `test/tui-screen.test.ts`). Tab diekspansi ke
     tab-stop 8 sebelum ukur/potong (terminal mengekspan; penggaris 0 salah).
     Scroll transkrip: PageUp/PageDown (PageDown di dasar = follow) +
      indikator `↑N` di status; submit kembali follow. `/model` & `/provider`
      & `/sessions` TUI-native: modal popup I17 (tanpa angka, filter live;
      CRUD provider via `minicode config`) — overlay manager & promptLine
      bernomor dilarang di dalam sesi (frame overlay tertangkap jadi sampah
      kontrol; prompt mini mencuri fokus dari daftar).
17. Modal popup TUI (`src/ui/tui/modal.ts` view murni, controller
    `cli/tui-modal.ts`, driver `cli/repl-tui.ts`): daftar TANPA nomor +
    filter live + pilih (`/model`, `/provider`, `/sessions`, effort
    thinking) tampil sebagai kotak terpusat di dalam viewport fullscreen
    (border, judul, highlight terpilih, windowing `… N more`), BUKAN
    lukisan stdout mentah. Aturan: controller TAK melukis/TAK membaca
    stdin (terima PromptKey per keypress); yang melukis hanya `screen`
    via `present({modal})` — komposit terpusat, clamp ke terminal mungil,
    dirty-check tetap berlaku; label dari jaringan/config/disk disanitasi
    di view (`renderModalBox`), idempoten; `Esc`/Ctrl+C = batal tanpa efek
    (tutup teratas bila bertumpuk); kunci masuk ke listener modal khusus
    (pompa utama sudah dilepas pasca-submit), box utama diam, sisa chunk
    pasca-pick dibuang; non-TTY = fail-closed dengan pesan actionable.
    Resize = re-layout dari state seperti frame biasa. Overlay lama
    (`screens/picker.ts`, `model-manager.ts`, `provider-manager.ts`) dan
    wizard TETAP untuk luar alt-screen (setup pertama, `handleBuiltinCommand`
    langsung, non-TUI) — yang dipensiunkan hanya pemakaiannya dari dalam
    sesi TUI (dispatch mencegat lebih dulu; lihat komentar `commands.ts`).

## Grammar (ringkas — TUI shell-like, I16)

prompt `minicode ›` di **bawah transkrip** seperti PowerShell: tiap submit
meninggalkan jejak `minicode › <teks>` di transkrip (bertumpuk ke bawah,
**tanpa duplikat** — box input di-reset sinkron saat submit agar teks yang
sama tidak tampil dua kali),
output model/ledger muncul di bawahnya, prompt baru di bawah output — status
`src/ui/footer.ts` di **baris-R paling bawah** permanen (`✦ mode • model •
cwd … 14.2k`, pad 9 anti-geser, spark pulse busy/redup idle, konteks rata
kanan `14.2k`; Tab putar mode, ↑/↓+Enter completion) — tanpa garis separator
· activity: spark di status (denyut), bukan garis terpisah · section
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

- `test/footer-render.test.ts` — I1/I6/I13 (render status, repaint
  identik, tanpa space-fill selebar terminal — konteks rata kanan via CHA).
  Badai resize cepat tanpa kehilangan state diuji `test/tui-responsive.test.ts`
  ("rapid resize … tanpa kehilangan state").
- `test/terminal-contract.test.ts` — I2/I3/I5/I7/I8/I9/I10/I12 (konsolidasi).
- `test/transient-arbitration.test.ts` — I3/I9/I15 (foreign-write dikomit,
  repaint, overlap signal, non-TTY bebas kontrol; spinner/garis status diam
  selama layar interaktif aktif + hidup lagi setelah release, nesting + release
  idempoten, opsi `delayMs`).
- `test/wizard.test.ts` — I15 jalur user nyata (spinner setup hidup + wizard:
  prompt `Base URL` terlihat, nol frame spinner selama layar, lanjut setelah
  batal).
- `test/statusline-bun-guard.test.ts` — I4/I5 (method-call only,
  self-disable + restore, transient tak pernah gagalkan turn).
- `test/turn-status.test.ts` — I5/I10 (lifecycle, endTurn tanpa
  `turn:completed`, resize 40→120).
- `test/tui-format.test.ts` (describe kontrak output) — I2/I7/I8 (ledger
  newline, tanpa bocor isi, stdout/stderr terpisah, 20 tool tanpa overlap).
- `test/exit-codes.test.ts` / `test/exec-json-envelope.test.ts` — I2/I8
  (salah pakai = 2, runtime = 1; `exec --json` gagal setup tetap bawa
  envelope summary di stdout).
- `test/theme.test.ts` — I6 (warna mati saat stdout non-TTY walau COLORTERM).
- `test/repl-core.test.ts` / `test/repl-tui.test.ts` / `test/tui-classic.test.ts`
  — I5 interaksi user (Ctrl+C/Esc/idle, journey TUI).
- `test/ui-boundary.test.ts` — I1/I3/I16 batas lapisan (ui tak impor keluar,
  mencakup berkas yang belum di-stage; `src/ui/tui/` hanya `src/ui/*` + builtin).
- `test/tui-*.test.ts` — I16 (emulator grid layar — redraw identik nol
  byte, resize re-layout benar, leave selalu kembalikan buffer + info sesi;
  terminal tak mampu DITOLAK jujur: `test/tui-policy.test.ts` mengunci
  `MINICODE_TUI`/`--no-tui` diabaikan dan gate kapabilitas; sanitasi jaring
  screen + CHA status: `test/tui-screen.test.ts`; scroll PageUp/PageDown +
   resize otomatis driver: `test/repl-tui.test.ts`; /model & /provider &
   /sessions modal-native: `test/repl-tui.test.ts`).
- `test/tui-modal.test.ts` — I17 (komposit terpusat: tengah presisi, clamp
  mungil, border utuh, highlight terpilih, stack Esc-pop, dirty-check tak
  repaint ganda; label jaringan disanitasi; non-TTY fail-closed); journey
   `/model` + effort bertumpuk, `/provider`, `/sessions`, alias `/models`,
   resize + Ctrl+C: `test/repl-tui.test.ts`; overlay luar-TUI (wizard,
   `handleBuiltinCommand` langsung): `test/wizard.test.ts`,
   `test/cli-commands.test.ts`.
