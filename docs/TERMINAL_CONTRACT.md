# Kontrak Terminal MiniCode (TUI fullscreen — v6, 2026-09-21)

Satu-satunya tampilan interaktif adalah **TUI fullscreen**: transkrip ala
shell + status bar + popup komposit. REPL linier, footer lengket (chrome),
overlay inline, dan jendela info **DIHAPUS** — tak ada mode, tak ada flag
(`--tui` usang = no-op). Popup = satu kotak: daftar DAN input teks/pilihan
terjadi di dalamnya (form); tak ada ketikan di luar kotak. Bahasa UI
dwibahasa (en/id) via i18n nol-dependensi. Perubahan perilaku apa pun di
bawah wajib: update dokumen ini + test yang menjaganya (lihat "Peta
proteksi").

## Sifat produk

- **Interaktif (TTY mampu)**: aplikasi fullscreen alternate-screen dari start
  sampai quit. Area transkrip bergaya shell (prompt `minicode ›`, jawaban
  model, ledger `›`), status bar bawah, popup kecil di atas transkrip yang
  tetap terlihat (redup) di belakang. Keluar = buffer utama kembali persis
  (transkrip sesi tidak di-dump ke scrollback).
- **Non-interaktif** (one-shot prompt, `exec`, pipe/redirect/CI): cetak polos,
  tak pernah membuka TUI.
- Tanpa panel/sidebar; tanpa mouse; tanpa animasi.

## Contract stdout/stderr

| Stream | Isi | Catatan |
|---|---|---|
| stdout | Output PROGRAM yang bermakna: teks model, receipt perubahan (`› write_file …`), daftar/artefak perintah | Harus bersih dari cursor-control pada non-TTY |
| stderr | Human-facing progress/diagnostic: ledger tool (`› …` hijau/merah), reasoning (verbose), warning, error | Boleh transient rendering bila stderr TTY |
| keduanya | Warna hanya bila stream TTY (`stdout.isTTY`); `NO_COLOR` menang; TERM/COLORTERM env TIDAK menyalakan warna pada pipe/redirect | Lihat `src/ui/render/theme.ts` `colorLevel()` |

Non-TTY (pipe/redirect/CI/file): **0 cursor control, 0 alternate screen,
0 animasi spinner, 0 ANSI yang tidak diperlukan, output deterministic.**

## Klasifikasi writer (wajib dipatuhi)

1. **permanent user-visible output** — teks model, receipt, hasil perintah → stdout (idle non-interaktif).
2. **frame TUI** — SATU-SATUNYA penulis layar saat interaktif adalah `App`
   (`src/ui/tui/app.ts`): transkrip viewport + prompt + status bar + komposit
   popup, satu repaint sinkron per event. Modul lain DILARANG menulis
   `process.stdout` langsung saat App aktif (popup melukis regionnya via
   `paintRegion`, bukan frame penuh).
3. **diagnostic/logging** — `[warn]`, `[router]`, `[mcp]`, `[vector]`, dst. dari layer non-UI → boleh `process.stderr.write` mentah.
4. **machine-readable output** — mis. `--json`, protokol MCP server → stdout saja, tanpa apa pun yang lain.
5. **debug-only output** — guard `verbose`/env; tidak pernah default.

## Ownership

- `App` pemilik tunggal layar (alt-screen enter saat start, exit saat quit —
  selalu berpasangan, termasuk exception/SIGINT via handler `process.on("exit")`
  sinkron best-effort). Turn berjalan = indikator spark pada status bar.
- App me-repaint live mengikuti event bus (stream teks, ledger, thinking;
  coalesce 30ms) — TANPA ini layar buta selama turn. Suspend menahan repaint
  (popup melukis sendiri); quit menahan semua.
- Popup komposit (`/model`, `/provider`, `/sessions`, form, approval):
  controller/view memanggil `app.suspend()` (lepas listener stdin + redupkan
  layar), view melukis HANYA region kotak via `paintRegion` (tanpa clear —
  transkrip di belakang tetap tampil), `app.resume()` repaint penuh saat tutup.
  Tanpa suspend: byte masuk ke dua tempat (App + popup) dan frame App menimpa
  popup — dilarang.
- Saat turn berjalan SEMUA input dibekukan kecuali abort (Esc/Ctrl+C) dan
  scroll (PgUp/PgDn). Enter saat busy = sunyi (bukan antre, bukan petunjuk).

## Popup, dialog, form & i18n

- `screen.ts` = pemilik `?1049h/?1049l` + `paintRegion` (cursor-addressed,
  tanpa clear) + `clearRegion`. Refcount nested, idempoten, null-screen
  fail-closed di non-TTY/`TERM=dumb`. Siklus hidup region: render yang
  menyusut/bergeser membersihkan union lama+baru (tanpa baris hantu); tutup
  menghapus region sendiri sebelum pemilik repaint.
- Isi popup: kotak terpusat (`dialog.ts`: border, judul opsional dalam garis
  atas, TANPA bayangan) di atas konten redup; `dialogBox` untuk komposit,
  `dialogFrame` (backdrop `░` faint) hanya untuk layar yang memiliki buffer
  sendiri.
- **Lebar kotak popup TETAP** per permukaan (model 64, picker 64, provider 76,
  form 64 — min=max): geometri stabil, tak bernapas saat filter/error.
  Nama/ID di DEPAN label (truncasi memakan ekor — tanggal/konteks boleh
  hilang, id selamat).
- Form dalam popup (`form.ts`): field text/secret(mask `•`)/select/confirm,
  Tab/↑↓ pindah, ←/→ pilih atau geser kursor, Enter validasi+submit, Esc
  dua-tahap (tekan-1 bersihkan field aktif, tekan-2 batal — isi tidak pernah
  hilang sekali tekan); error validasi merah dalam box; kursor terminal
  diparkir di field aktif. Add/edit provider, delete confirm, dan wizard
  input WAJIB lewat ini (bukan askLine liar di luar kotak).
- Dropdown `/` tetap inline menempel prompt (harus mengikuti kursor ketik):
  berbingkai, terhapus di SEMUA jalur keluar.
- **Kursor diparkir di SEMUA permukaan** (picker/manager/form/App): baris
  item/field aktif — bukan ditinggal di posisi paint terakhir.
- **i18n dwibahasa** (`src/ui/i18n/`): kamus statis `en.ts`/`id.ts` (id WAJIB
  kunci = en — tsc mengawal), `t(key, params)` interpolasi `{nama}`, fallback
  kunci hilang → en. Prioritas: `/lang` (sesi) > `MINICODE_LANG` >
  state.json `lang` > locale OS (`LANG`/`LC_ALL` awalan `id`) > en. Semua
  string user-visible TUI lewat `t()` — literal Indonesia hardcode di luar
  dict dilarang (test anti-regresi). Getter runtime, bukan const beku.
- **Keybinding konsisten** (kontrak I25): `Esc` dua-tahap di semua input
  teks; `backspace`/`delete` selalu edit teks (aksi hapus-data via `d`/
  `Del` + confirm dalam popup, tercatat); navigasi daftar = `↑↓` + `pgup/
  pgdn` + `home/end` di semua popup ber-daftar; hint footer tiap permukaan
  hanya tombol yang benar-benar berlaku di sana.
- Approval tool & ask_user: blok pertanyaan + keputusan DICATAT di transkrip
  (jejak audit) dan layar di-repaint sebelum menjawab; input via askLine di
  baris kursor (aman: input App beku saat busy; Esc/Ctrl+C = abort + deny).
- Layar tak mampu (non-TTY, `rows < 10`, `TERM=dumb`): view menolak BERSUARA
  + batal (fail-closed). TAK BOLEH diam.
- `/status` & `/history` = readout ke transkrip (bukan popup); `/help` ringkas
  (≤6 baris, penuh via `/help tombol`); `/expand` membuka buffer isi tool;
  pilihan `/model` persist antar sesi + struk `model: x` di transkrip.

## Invariant (nomor dipakai di peta proteksi)

1. Satu tampilan interaktif: TUI fullscreen; frame penuh tiap repaint (tepat
   `rows` baris); scrollback utama tak tersentuh selama sesi.
2. stdout/stderr contract seperti tabel di atas (TTY & non-TTY deterministic).
3. Satu kepemilikan layar (`App`); popup satu lifecycle (`suspend`/`resume` +
   `paintRegion`).
4. Permanent output tidak bergantung pada painter TUI.
5. Tidak ada popup yatim / input bocor setelah success / failure /
   cancellation / SIGINT / session end. Tidak ada modal yatim.
6. Non-TTY: 0 cursor control / alternate screen / spinner animation / ANSI
   tak diperlukan.
7. Tool activity default compact; ledger `› nama target` satu baris.
8. Streaming tanpa duplicate output / overlap / stale status.
9. Foreign stderr writers boleh mentah di layer non-UI.
10. (Dilebur ke I3 — nomor dipertahankan agar referensi lama tak patah.)
11. Resize memakai lebar/tinggi SAAT PAINT (bukan saat event) — termasuk
    geometri popup, dialog, dan viewport TUI.
12. Long session tetap readable (cap 5000 baris, tertua dibuang).
13. Status bar: 1 baris dasar (`✦ mode • model • cwd … ctx`) dari sumber yang
    sama dengan angka sesi; spark pulse saat busy.
14. Binding TUI: PgUp/PgDn scroll; Up/Down histori; Tab/Shift+Tab mode;
    Ctrl+O/T compact/thinking; Ctrl+D baris-kosong keluar; Esc/Ctrl+C =
    batal input / abort turn (busy: SEMUA input dibekukan kecuali abort dan
    scroll — Enter pun sunyi). Baris kosong menampilkan placeholder +
    cara keluar; scroll ke atas + stream masuk = indikator `↓ N baris baru`.
15. (Dihapus bersama jendela info — nomor dipertahankan.)
16. Popup komposit: region tanpa clear + union-clear anti-hantu + clearRegion
    saat tutup + suspend/resume berpasangan; layar tak mampu = tolak bersuara
    + batal.
17. Transkrip append-only di memori (cap 5000), viewport ikut ekor otomatis;
    ketikan baru kembali ke ekor; stream turn TIDAK merampas posisi baca;
    repaint live coalesce 30ms (layar tak buta saat turn).
18. Prompt multiline (Ctrl+J newline), histori memori-sesi (tak persist ke
    berkas histori lama).
19. Dropdown `/` inline berbingkai; Enter pada menu melengkapi + kirim.
20. Lebar kotak popup TETAP per permukaan (model 64, picker 64, provider 76,
    form 64 — min=max); nama/ID di depan label; seleksi murni warna; search
    selalu tampil.
21. Form dalam popup: semua input teks/pilihan di dalam kotak (text/secret/
    select/confirm + validasi inline + kursor diparkir); tak ada ketikan di
    luar kotak.
22. Thinking terlihat: minimized = penanda `… thinking` + isi di `/expand`;
    expanded = alir redup; fase berakhir = commit (tak ada thinking yatim).
23. Approval & ask_user tercatat di transkrip (pertanyaan + keputusan) dan
    terlihat sebelum menjawab; non-TTY = deny/null fail-closed.
24. `/expand` membuka buffer isi tool (sekali ambil habis); pilihan `/model`
    persist antar sesi + struk `model: x`; `/help` ringkas (penuh via
    `/help tombol`).
25. Keybinding konsisten: Esc dua-tahap (isi tak hilang sekali tekan);
    backspace/delete edit-teks (hapus-data = confirm); navigasi daftar
    (`↑↓`, pgup/pgdn, home/end) di semua popup; hint footer akurat
    per permukaan; kursor diparkir di semua permukaan.
26. i18n dwibahasa: semua string user-visible lewat `t()`; id kunci = en
    (tsc mengawal); fallback kunci hilang → en; prioritas sesi > env >
    state.json > locale OS > en; literal Indonesia hardcode dilarang.

## Grammar (ringkas)

prompt `minicode ›` (+ placeholder & cara keluar saat kosong; dropdown `/`
berbingkai di atasnya) · status bar = 1 baris · ledger tool
`  › name target` (hijau) / merah saat error · error `✗ pesan` sekali per
kegagalan · thinking: `… thinking` / alir redup · popup: konten redup di
belakang + kotak terpusat (form di dalam) + Esc tutup · approval tercatat ·
`/status`, `/history`, `/help` ringkas & `/expand` mengalir ke transkrip ·
`Ctrl+C`/`Esc` saat turn = abort; busy = input beku total · PgUp/PgDn =
scroll + indikator `↓ N baris baru`.

## Residual risk (DISENGAJA — jangan "perbaiki" tanpa keputusan)

1. Foreign partial stderr write tanpa newline (non-interaktif).
2. `kill -9` di tengah sesi: ketik `reset` (pola standar).
3. Transkrip TUI hilang saat quit (disengaja — TUI fullscreen).
4. Terminal purba tanpa alternate screen: pesan satu baris + keluar (bukan error).
5. Approval saat user scroll ke atas: blok tercatat di ekor (tak terlihat
   sampai PgDn), tapi prompt jawaban + bell selalu terlihat di bawah.
6. Area yang dibuka kembali saat kotak menyusut = kosong (bukan transkrip
   di belakangnya) sampai popup tutup + repaint penuh.

## Peta proteksi (test → invariant)

- `test/tui-app.test.ts` — I1/I14/I17-I20 (boot/exit pairing, transcript viewport,
  scroll + indikator, prompt + placeholder, status bar, quit, suspend/resume,
  busy-freeze, live repaint).
- `test/screen-buffer.test.ts` — parser frame harness (unit).
- `test/tui-transcript.test.ts` — I7/I12/I17/I22/I24 (ledger, cap, viewport,
  thinking, buffer /expand).
- `test/tui-popup.test.ts` — I16 (komposit di atas transkrip, anti-bocor,
  anti-hantu).
- `test/form.test.ts` — I21 (field, validasi, secret, select, confirm, batal).
- `test/approval-tui.test.ts` — I23 (blok + keputusan tercatat, deny).
- `test/footer-render.test.ts` — I13.
- `test/terminal-contract.test.ts` — I2/I3/I5/I7/I8/I9/I12.
- `test/transient-arbitration.test.ts` — I3/I9.
- `test/statusline-bun-guard.test.ts` — I4/I5.
- `test/turn-status.test.ts` — I5.
- `test/tui-format.test.ts` — I2/I7/I8.
- `test/theme.test.ts` — I6.
- `test/ansi-fragmentation.test.ts` — I6/I8.
- `test/non-tty-output.test.ts` — I6.
- `test/thinking-truncation.test.ts` — I12.
- `test/ui-combined.test.ts` — DIHAPUS bersama chrome.
- `test/repl-linear.test.ts`, `test/footer-chrome.test.ts`,
  `test/info-window.test.ts` — DIHAPUS bersama REPL/chrome/jendela.
- `test/cli-commands.test.ts` — /status cetak, /sessions popup.
- `test/screen.test.ts` — I16 (pairing + paintRegion).
- `test/dialog.test.ts` — I11/I16/I20 (geometri, backdrop, box).
- `test/tui-overlay.test.ts` — I11/I16 (popup region + gate layar).
- `test/ui-boundary.test.ts` — I1/I3 (src/ui tak impor keluar).
- `test/i18n.test.ts` — I26 (resolusi, fallback, interpolasi, kelengkapan).
- `test/i18n-hardcode.test.ts` — I26 (lexer sadar-state: tanpa literal
  Indonesia di luar kamus; kontrol positif id.ts kena, negatif en.ts bersih).
- `test/tui-lang.test.ts` — I26/I24 (/lang end-to-end, /help satu sumber).
- `test/cli-help-language.test.ts` — I26/I25 (label en, kelengkapan /help).
- `test/tui-geometry.test.ts` — I20/I25 (lebar tetap per permukaan, step
  wizard, form error).
