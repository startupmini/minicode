# Kontrak Terminal MiniCode (TUI fullscreen — v7.13, 2026-11-13)

Perubahan v7.13: baris status kompaksi (`context:compacted`) kini **membedakan
hasil** alih-alih mencetak `reason` mentah. Sebelumnya sesi yang konteksnya TIDAK
menyusut tampil sebagai `… dipadatkan: pressure:critical:no-op` — terbaca seolah
berhasil, padahal turn berikutnya tetap kehabisan konteks. Empat kondisi sekarang
punya label berbeda karena tindak lanjut user berbeda: `… dipadatkan: tidak ada
yang bisa dibuang (<sebab>) — konteks tidak menyusut` (no-op), `… kompaksi
berhenti: target tak tercapai meski hanya N pesan tersisa` (fixpoint), `…
kompaksi mustahil: instruksi tetap + skema tool (N) sudah melebihi ambang M`
(biaya tetap), dan `… ringkasan LLM gagal (<sebab>), memakai ringkasan
mekanikal`. Label tetap satu baris redup (`c.muted`) dan tetap melewati
`sanitizeAnsiLine` sebelum tampil — teks sebab berasal dari error provider/model
(input tak terpercaya). Sumber: `src/ui/tui/transcript.ts` (`compactedLabel`),
kunci i18n `ts.compactedNoOp`/`ts.compactedFixpoint`/`ts.compactedImpossible`/
`ts.compactedLlmFailed`, dan emisi `reason` dari `vendor/minicore/src/core/
loop.ts`. Peta proteksi: `test/tui-classic.test.ts` (kontrak render transkrip)
+ `test/compaction-limits.test.ts` (alasan `impossible:`/`fixpoint` yang
mendarat di event) + `test/control-plane.test.ts` (`llm-failed:` dilaporkan).
Nol perubahan pada lebar/geometri: label hanya teks lebih panjang pada jalur
yang sama, tetap dipotong sesuai aturan baris status yang ada.

Perubahan v7.12: footer `context` & `metrics` (window %) kini **live per step**
selama turn berjalan — kernel meng-emit estimasi konteks turn-store via event
`provider:extension` kind `context-window` SETELAH `step:completed`, dan footer
membacanya alih-alih terpaku pada `session.contextTokens` (committed store yang
hanya berubah saat `turn:completed`). Saat idle, footer kembali ke nilai
committed. Estimator sama sekali tidak berubah/berduplikasi — tetap satu sumber
(`estimateSessionContext`), hanya nilai yang dibaca saat turn aktif memakai
turn-store (yang tumbuh), bukan committed store (beku). Sumber: `vendor/minicore/
src/core/loop.ts` (emit) + `cli/tui.ts` (wiring footer).

Perubahan v7.11: thinking & jawaban di TUI dan renderer linear kini membungkus di
batas kata (`wrapByWidth`) — tidak memotong di tengah kata — dan baris diff ikut
wrap (bukan truncate ellipsis). Tabel markdown tetap kotak ber-garis + wrap
(v7.10). Thinking di renderer linear ikut di-indent 2 kolom, konsisten dengan TUI.

Perubahan v7.10: pembatas bash allow-list (fallback "no-sandbox") ditampilkan
sebagai **titik monokrom** `●` di ujung footer (setelah Permission Mode), kuning
saat aktif (mode Auto + restrictBash) dan abu saat nonaktif. Saat mode
`unrestricted` aktif, titik jadi `○` MERAH (terbuka) sebagai penanda satu-satunya.
Fallback ASCII `[LOCK]`/`[OPEN]` untuk terminal tanpa UTF-8. Sumbu persetujuan
tetap Auto/Ask; nilai Permission Mode untuk `--allow-all` sengaja ditampilkan
sebagai `Auto` (auto ≈ allow-all: otonom penuh tanpa izin) — catatan desain,
bukan bug. Angka konteks footer memakai `session.contextTokens` — estimasi
terkalibrasi yang memakai estimator yang SAMA dengan guard cutoff, sehingga
footer dan guard tidak pernah menghasilkan dua angka sumber berbeda.

Perubahan v7.9: input command slash tidak ditambahkan sebagai pesan transkrip;
aksi popup provider/model/sesi dan toggle UI tidak meninggalkan riwayat status
di transkrip. Output command yang informatif, error, dan hasil prompt model tetap
tampil. Jawaban model membuang blank line di tepi dan merapatkan jeda berulang
di luar code fence; isi code fence tetap literal.

Perubahan v7.8: sesi baru dan sesi legacy tanpa WorkMode mulai di `Discuss`;
operator hanya dapat memilih `Discuss`, `Plan`, atau `Build`. Permission Mode
awal `Auto` dan kontrolnya hanya `Auto`/`Ask`. Dropdown `/` menampilkan nama
command tanpa slash, judul, deskripsi, atau baris tambahan. Picker provider,
model, dan pilihan umum tidak memakai judul/footer; baris provider/model dibuat
ringkas.

Perubahan v7.7 (diperbarui v0.24): footer menampilkan nilai Work Mode di sisi
kiri dan nilai Permission Mode di sisi kanan dekat pemakaian konteks. Label
`Work Mode:`/`Permission Mode:` dihapus agar footer satu baris lebih lega —
pembeda sumbu tinggal warna (Work Mode semantik, Permission Mode cyan). Nilai
kedua mode memakai title case; pada terminal sempit nilai dipadatkan sebelum
mode atau konteks dihilangkan.

Perubahan v7.6: sinkronisasi kontrak WorkMode ke mode produk 0.14.1 — label
`BUILD` untuk identitas runtime `EXECUTE`, footer dua sumbu yang selalu tampil,
dan pintasan `Tab`/`Shift+Tab` untuk WorkMode/PermissionMode.

Perubahan v7.5: kepemilikan frame stdout interaktif diperjelas; cleanup `TuiApp.run()`
berpasangan melalui `finally`; gap proteksi teardown, startup, spacer, layar kecil,
dan writer ownership ditutup dengan test app/subprocess/PTY.

Perubahan v7.4 (P12 S2.2 WorkMode): invarian I35 — WorkMode runtime
`DISCUSS`/`PLAN`/`EXECUTE` terpisah dari PermissionMode. Nama produk `BUILD`
adalah alias input dan label tampilan untuk identitas runtime `EXECUTE`; nilai
persisten tetap `EXECUTE`. Command `/work-mode <DISCUSS|PLAN|BUILD>` juga
menerima `EXECUTE` sebagai alias kompatibilitas. Footer menampilkan pasangan
`<WorkMode>·<PermissionMode>`; defaultnya `BUILD · AUTO`. `Tab` memutar WorkMode,
sedangkan `Shift+Tab` dan `/mode` mengubah PermissionMode. Rincian di I35.

Perubahan v7.3 (P11 Presentation & UX): invarian baru I34 — subcommand `exec`
dan `daemon` menerima argv SCOPE dari router (flag global dikenal yang
mendahului token subcommand tetap berlaku; token subcommand tidak ikut ke
handler). Kalimat lama I28 "Flag `exec` diparse dari argv SESUDAH token
subcommand" sudah tidak lengkap sejak P11.2 menerima bentuk flag-mendahului,
diganti rujukan ke I34. Registrasi peta proteksi: `test/cli-subcommands.test.ts`
sudah ada SEBELUM P11.3 — yang ditambahkan hanya describe `cli: daemon scoped
argv (P11.3)` di dalamnya, BUKAN file baru; `test/exec-json-envelope.test.ts`
+ `test/cli-session.test.ts` melindungi kontrak exec scoping (P11.2) dan
verification summary (P11.1). Nol perubahan perilaku runtime — dokumen mengejar
kontrak yang sudah diterima + diuji.

Perubahan v7.2 (2026-09-25): mouse tracking `?1002h + ?1006h`, drag selection
app-level, `Ctrl+C` copy selection, wheel tetap scroll, popup turun ke `?1000h`,
dan `MINICODE_MOUSE_SELECTION=0` sebagai kill switch.

Perubahan v7.1 (2026-09-25): mouse wheel X10/SGR untuk scroll transkrip; klik
mouse tetap diabaikan; mouse tracking dibatasi pada lifecycle TUI; `/copy [n]`
menyalin 1–10 turn terakhir; abort turn TUI memakai Esc.

Perubahan v7 (temuan audit `audit-tui`): penanganan sinyal fatal
SIGTERM/SIGHUP (I31), navigasi transkrip Home/End + Shift+PgUp/PgDn (I14),
hint abort sekali saat busy (I14), idle guard form dua-tahap (I21), spark
statis via `MINICODE_MOTION=0` (I13), parkir kursor di dalam blok
sync-update (I25).

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
- Tanpa panel/sidebar; mouse app-level untuk wheel scroll dan drag-selection
  transkrip (bukan native terminal selection); tanpa animasi dekoratif
  (pulse spark status bar dapat dimatikan `MINICODE_MOTION=0` — I13).

## Contract stdout/stderr

| Stream | Isi | Catatan |
|---|---|---|
| stdout | Permanent output pada non-interaktif; frame TUI saat sesi interaktif | `App` satu-satunya pemilik frame interaktif; machine output tetap murni |
| stderr | Human-facing progress/diagnostic: ledger tool (`› …` hijau/merah), reasoning (default terlihat; `MINICODE_SHOW_THINKING=0` minimized), warning, error | Boleh transient rendering bila stderr TTY |
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

- `App` pemilik tunggal layar (alt-screen enter saat start, exit saat quit).
  `TuiApp.run()` melepas listener/timer/subscription, memulihkan raw mode, dan
  menutup layar lewat `finally` idempoten pada jalur sukses maupun exception.
  Hook `process.on("exit")` hanya jaring best-effort terakhir, bukan pengganti
  cleanup lifecycle. Turn berjalan = indikator spark pada status bar.
- **Sinyal fatal** (I31): saat sesi TUI hidup, `App.run()` memasang
  `process.on("SIGTERM")`/`process.on("SIGHUP")` (handler terpisah karena Bun
  tak menyampaikan nama sinyal — satu handler bersama tak bisa membedakan)
  → restore terminal (alt-screen exit + raw mode pulih) tepat satu kali walau
  handler sinyal terpanggil ulang, lalu
  `process.exit(128+n)`. Pasangan ketat: keduanya dilepas di cleanup `run()` —
  tanpa sesi TUI, sinyal TIDAK di-intercept (perilaku default proses tetap).
  Tanpa ini SIGTERM meninggalkan terminal di alt-screen + raw mode (user harus
  `reset`).
- App me-repaint live mengikuti event bus (stream teks, ledger, thinking;
  coalesce 30ms) — TANPA ini layar buta selama turn. `?1002h + ?1006h`
  mengaktifkan tracking drag; `?1000h + ?1006h` saat popup; `?1000l/?1002l/?1006l`
  pada quit/child/sinyal. Suspend menahan repaint (popup melukis sendiri);
  quit menahan semua.
- Popup komposit (`/model`, `/provider`, `/sessions`, form, approval):
  controller/view memanggil `app.suspend()` (lepas listener stdin + redupkan
  layar), view melukis HANYA region kotak via `paintRegion` (tanpa clear —
  transkrip di belakang tetap tampil), `app.resume()` repaint penuh saat tutup.
  Tanpa suspend: byte masuk ke dua tempat (App + popup) dan frame App menimpa
  popup — dilarang.
- Saat turn berjalan SEMUA input dibekukan kecuali abort (Esc) dan
  scroll (mouse wheel, PgUp/PgDn). Enter saat busy = sunyi (bukan antre, bukan petunjuk).
  Abort pertama menampilkan hint "tekan Esc lagi untuk keluar" di slot
  indikator SEKALI (anti keluar sesi tak sengaja saat double-tap "memastikan"
  — I14); abort kedua dalam 1,5 dtk = quit.
- **Checkpoint = milik lifecycle sesi.** Bus kernel memanggil handler `turn:completed`
  secara sinkron dan tak menunggu promise-nya, jadi operasi tulis checkpoint
  (async) harus DIMILIKI: operasi yang dimulai dicatat, kegagalannya
  ditangani saat lahir (bukan unhandled rejection, bukan sukses palsu) dan
  dilaporkan lewat diagnostic `[warn] checkpoint failed: …` ke stderr.
  `close()` = BARRIER: setelah ia kembali, tak ada pekerjaan checkpoint milik
  sesi itu yang masih berjalan (manifest sudah tertulis atau kegagalannya
  sudah tercatat).

## Popup, dialog, form & i18n

- `screen.ts` = pemilik `?1049h/?1049l` + `paintRegion` (cursor-addressed,
  tanpa clear) + `clearRegion`. Refcount nested, idempoten, null-screen
  fail-closed di non-TTY/`TERM=dumb`. Siklus hidup region: render yang
  menyusut/bergeser membersihkan union lama+baru (tanpa baris hantu); tutup
  menghapus region sendiri sebelum pemilik repaint.
- `screen.ts` juga pemilik bentuk kursor: DECSCUSR `6 q` (bar tegak stabil)
  dipancarkan saat caret ditampilkan (`paint`/`moveCursor`) — caret tak
  menutupi karakter di bawahnya dan lebih tenang (clean & minimal). Tetap
  TTY-only: non-TTY = 0 cursor control.
- Isi popup: kotak terpusat (`dialog.ts`: border, judul opsional dalam garis
  atas, TANPA bayangan) di atas konten redup; `dialogBox` untuk komposit,
  `dialogFrame` (backdrop `░` faint) hanya untuk layar yang memiliki buffer
  sendiri.
- **Lebar kotak popup TETAP** per permukaan (model 64, picker 64, provider 64,
  form 64 — min=max): geometri stabil, tak bernapas saat filter/error.
  Nama/ID di DEPAN label (truncasi memakan ekor — tanggal/konteks boleh
  hilang, id selamat).
- Form dalam popup (`form.ts`): field text/secret(mask `•`)/select/confirm,
  Tab/↑↓ pindah, ←/→ pilih atau geser kursor, Enter validasi+submit, Esc
  dua-tahap (tekan-1 KEMBALIKAN nilai bawaan field aktif — text/secret/select/
  confirm, tekan-2 batal — isi tidak pernah hilang sekali tekan); error
  validasi merah dalam box; kursor terminal diparkir di field aktif dan field
  aktif SELALU terlihat (jendela body digeser via `focusRow` bila kotak
  terpotong). Add/edit provider, delete confirm, dan wizard input WAJIB lewat
  ini (bukan askLine liar di luar kotak).
- Picker ber-filter: Esc-1 mengosongkan filter (= kembali ke nilai bawaan
  pencarian, analogen revert-to-default I21), Esc-2 menutup. Ctrl+U juga
  mengosongkan filter. Tidak ada draft yang hilang tanpa undo.
- Dropdown `/` tetap inline menempel prompt (harus mengikuti kursor ketik):
  berbingkai, terhapus di SEMUA jalur keluar.
- **Kursor diparkir di SEMUA permukaan** (picker/manager/form/App): baris
  item/field aktif — bukan ditinggal di posisi paint terakhir. Kursor idle App
  berada tepat setelah prompt `minicode ›` (prompt tidak lagi disembunyikan
  setelah Esc/Enter kosong — I13).
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
- **Hint aksi minimalis** (audit UI/UX 2026-11): satu baris di dasar body
  picker/manager (`src/ui/render/hint.ts`, satu sumber), format `kunci label`
  — kunci lebih terang, label redup, pemisah `·` — tanpa judul dan tanpa
  footer dekoratif di dalam kotak. `/model`: **Enter = pilih model satu
  langkah** (tanpa picker effort); **Tab = ubah thinking effort** terpisah
  (Esc pada picker effort = batal effort, kembali ke daftar — manajer tak
  pernah menutup diri di sana).
- Approval tool & ask_user: blok pertanyaan + keputusan DICATAT di transkrip
  (jejak audit) dan layar di-repaint sebelum menjawab; input via askLine di
  baris kursor (aman: input App beku saat busy; Esc/Ctrl+C = abort + deny).
- Layar tak mampu (non-TTY, `rows < 10`, `TERM=dumb`): view menolak BERSUARA
  + batal (fail-closed). TAK BOLEH diam.
- `/status` & `/history` = readout ke transkrip (bukan popup); `/help` ringkas
  (terkelompok ≤8 baris, penuh via `/help full`, pintasan via `/help keys`);
  `/expand` membuka buffer isi tool; pilihan `/model` persist antar sesi +
  struk `model: x` di transkrip.

## Invariant (nomor dipakai di peta proteksi)

1. Satu tampilan interaktif: TUI fullscreen; frame penuh tiap repaint (tepat
   `rows` baris); scrollback utama tak tersentuh selama sesi. Frame LOGIS tetap
   penuh `rows` baris (hasil layar identik), namun PENULISAN FISIK ke terminal
   boleh inkremental per SEL dan dikirim sebagai SATU `write` per frame
   (`screen.paint` memakai diff sel terhadap frame sebelumnya; repaint
   pertama/resize/perubahan jumlah kolom tetap `ESC[H`+`ESC[2J` clear penuh)
   — ini murni optimasi menghapus flicker/latensi `ESC[2J` tiap keystroke,
   bukan perubahan perilaku yang terlihat. Diff per sel menyimpan gaya sebagai
   STATE SGR ternormalisasi (urutan kanonik, bukan riwayat sekuens), sehingga
   sel yang identik secara visual tidak pernah ditulis ulang; glyph lebar
   (CJK/emoji) dilindungi sel lanjutan (`cont`) agar diff tidak memotong glyph.
   Penulisan per baris berubah: dari kolom berbeda PERTAMA sampai akhir baris
   (prefix identik dilewati), didahului EL (`ESC[0K`) — ekor dihapus-lalu-ditulis
   ulang supaya sisa glyph lebar / ekor baris lama tidak menempel. Tulis asing ke
   stderr selama alt-screen hidup (mis. `[hooks] skipped …`, warning provider)
   menandai terminal "kotor" (`statusline.consumeScreenDrift`) dan memaksa
   repaint penuh pada paint berikutnya; tanpa ini baris yang kebetulan tak
   berubah akan mempertahankan fragmen asing di atas diff inkremental.
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
12. Long session tetap readable (cap 5000 baris, tertua dibuang). Proyeksi
    presentasi mempertahankan cap yang sama dan menambahkan satu marker
    `… N baris awal di luar viewport` yang melacak
    jumlah baris yang di-evict; `total()` tetap monotonik. Buffer jawaban
    live dibatasi 1.000.000 karakter dan menampilkan marker truncasi; satu
    layout paint tidak boleh memproyeksikan transcript dua kali.

13. Status bar: 1 baris dasar (`✦ 00.00.00 Discuss  model  cwd … context  Auto`)
     dari sumber yang sama dengan angka sesi.
     Nilai `context` (dan `metrics` window %) saat turn AKTIF memakai occupancy
     LIVE turn-store yang di-emit kernel per step (event `provider:extension`
     kind `context-window`, setelah `step:completed`); saat idle kembali ke
     `session.contextTokens` (committed store). Estimator tetap satu sumber —
     hanya store yang dibaca berganti antara turn-store (tumbuh) vs committed
     (beku), tak ada duplikasi angka sumber (v7.12).
     Titik `●` mengikuti Permission Mode di ujung kanan: kuning bila bash
     allow-list aktif (restrictBash + mode `Auto`), abu bila tidak; `○` merah
     = mode `unrestricted` (fallback ASCII `[LOCK]`/`[OPEN]`). Work Mode berada
     di kiri; Permission Mode cyan berada di kanan dekat konteks (label produk
     `Work Mode:`/`Permission Mode:` dihapus pada v0.24 — nilai saja). Bila ada
     job background hidup, badge `◷ N` (jam berputar pelan, `N` = jumlah job)
     tampil di samping spark; fallback ASCII `[BG:N]`. `✦` tetap
     menjadi indikator proses hidup;
     timer `HH.MM.SS` berada tepat di sebelahnya. Idle=redup; saat aktif hanya
     detik putih, menit ikut terang setelah 60 dtk, dan jam setelah 1 jam.
     Reasoning memakai dots `...` → `..` → `.` → `..` →
     `...`, sedangkan teks `Working`/`Thinking`/`Running` tidak tampil. Bullet
     separator dihapus; field dipisahkan oleh spasi dan warna. Prompt `minicode ›`
     tampil saat boot/idle, hilang saat busy, dan kembali otomatis setelah turn
     selesai; aksi edit/histori tetap dapat membuka composer.
     `MINICODE_MOTION=0` membuat dots dan sparkle statis tetapi tidak
     menghilangkan feedback; satu baris kosong memisahkan composer dari footer.
14. Binding TUI: mouse wheel (X10/SGR) scroll transkrip; drag kiri app-level
     membuat selection transkrip dan `Ctrl+C` menyalinnya; PgUp/PgDn scroll;
     **Shift+PgUp/PgDn (ESC[5;2~/6;2, modifier 2) = setengah halaman; Home/End
     saat prompt KOSONG = lompat baris-teratas/ekor transkrip (baris berisi =
     editing awal/akhir baris; dropdown terbuka = jalur engine)**; Up/Down
     histori; Tab WorkMode / Shift+Tab PermissionMode; Ctrl+O/T compact/thinking; Ctrl+D baris-kosong
     keluar; Esc membersihkan selection lebih dulu, lalu batal input / abort
     turn (busy: SEMUA input dibekukan kecuali abort, scroll, dan selection —
     Enter pun sunyi; berlaku juga saat layar MENCIUT: abort+scroll selalu lolos
     agar turn bisa dibatalkan tanpa kill -9; abort pertama menampilkan status
     `Stopping` + hint keluar sekali, abort kedua dalam 1,5 detik menutup sesi).
     Ini adalah selection buffer TUI, bukan native terminal selection. Idle
     menampilkan timer redup di footer dan prompt `minicode ›`; prompt hilang
     saat busy, lalu otomatis muncul kembali kosong setelah turn selesai.
     Scroll ke atas + stream masuk = indikator `↓ N baris baru`.
15. (Dihapus bersama jendela info — nomor dipertahankan.)
16. Popup komposit: region tanpa clear + union-clear anti-hantu + clearRegion
    saat tutup + suspend/resume berpasangan; layar tak mampu = tolak bersuara
    + batal.
17. Transkrip append-only di memori (cap 5000), viewport ikut ekor otomatis;
     ketikan baru kembali ke ekor; stream turn TIDAK merampas posisi baca;
     repaint live coalesce 30ms dan clock activity 200ms (layar tak buta
     saat turn). Composer memakai tinggi tetap: prompt saat editing, dots saat
     reasoning, atau tool target; satu baris kosong selalu memisahkannya dari
     footer. Proyeksi presentasi: baris running di-pin dari snapshot, elapsed
     tetap pada ledger tool, status tool final memakai warna + kata
     (`completed`/`failed`/`denied`/`cancelled`/`interrupted`), retry dan grup
     anak mengikuti model, serta ringkasan turn masuk sebagai system entry.
     **Retry provider:** setiap `model.delta`/`reasoning.delta` live membawa
     `attemptId`. Bila attempt gagal setelah mengirim konten, TUI membuang
     ekor attempt yang belum di-commit dan menambah diagnostic invalidasi.
     Sink linear/pipe bersifat append-only: byte yang sudah ditulis tetap ada,
     sehingga sink wajib menulis marker invalidasi sebelum output attempt
     berikutnya. Konten attempt gagal dikeluarkan dari `/copy`, reasoning
     durable, dan jawaban akhir; usage provider tetap dihitung karena request
     tersebut sudah terjadi.
     **Grup anak (F-AGENT-1):** tool anak yang punya identitas run
     (`childSessionId`/`runId` — dari `ChildSessionLink`) tampil sebagai baris
     run sendiri, diindented `↳ <marker> <tool> <target> <status>` dengan
     marker `run_<8>`/`sub_<8>`; anak paralel tak lagi(dir) satukan jadi satu
     hitungan. Tool anak yang HANYA punya `parentToolCallId` (grouping legacy,
     tanpa identitas run) tetap ditelan sebagai hitungan induk `n child tools`
     — `parentToolCallId` = taut ke pemanggil, bukan identitas run, jadi dua
     makna itu tak boleh disamakan. Baris running anak memakai aturan yang
     sama (marker per run).

18. Prompt multiline (Ctrl+J newline), histori memori-sesi (tak persist ke
    berkas histori lama). `/copy [n]` menyalin 1–10 turn terakhir (default 1,
    oldest-to-newest) melalui OSC 52.
19. Dropdown `/` inline berbingkai; Enter pada menu melengkapi + kirim.
20. Lebar kotak popup TETAP per permukaan (model 64, picker 64, provider 64,
    form 64 — min=max); nama/ID di depan label; seleksi murni warna; search
    selalu tampil.
21. Form dalam popup: semua input teks/pilihan di dalam kotak (text/secret/
     select/confirm + validasi inline + kursor diparkir); tak ada ketikan di
     luar kotak. Esc dua-tahap: tekan-1 KEMBALIKAN nilai bawaan field
     (prefill/edit tak hilang sekali tekan), tekan-2 batal. Idle guard
     dua-tahap (temuan audit TUI-004): 80 dtk tanpa input = peringatan statis
     di footer form ("batal dalam 10 dtk" — bukan countdown hidup), 10 dtk
     berikutnya = auto-batal (cancel), total semantik 90 dtk lama; SATU
     ketikan apa pun me-reset kedua timer.
22. Thinking terlihat SECARA DEFAULT (expanded): composer memakai dots clock;
     dengan panel aktivitas ON (default TUI; `/fold`), transkrip menampilkan
     AREA thinking = blok live maks 10 baris visual terakhir (header
     `+ thinking`, penanda `… N baris lagi`), lalu saat fase berakhir diringkas
     SATU baris (`+ thinking · N baris`) dengan detail penuh tetap tersedia di
     `/expand`; dengan panel OFF, perilaku legacy = alir thinking ber-warna terbaca (`c.thinking`,
     abu-kebiruan) dan ber-indentasi 2 kolom, dipisah SATU baris kosong dari
     jawaban/ledger — bukan `dim`; minimized (`/thinking`, `MINICODE_SHOW_THINKING=0`)
     = bersih tanpa marker (`… thinking`); isi tetap tersedia di `/expand`;
     fase berakhir = commit (tak ada thinking yatim).
23. Approval & ask_user tercatat di transkrip (pertanyaan + keputusan) dan
     terlihat sebelum menjawab; non-TTY = deny/null fail-closed; stdout
     di-pipe tanpa sink TUI = deny/null (prompt tak terlihat + mencemari
     output program bila dipaksa).
24. `/expand` query Content Store (buka-ulang identik, tidak sekali-habis);
     dengan id membaca satu tool, tanpa id membaca seluruh entry store yang
     masih hidup; miss → durable sqlite → penanda retensi. Pilihan `/model`
     persist antar sesi + struk `model: x`; `/help` ringkas (penuh via
     `/help full`, pintasan via `/help keys`).
25. Keybinding konsisten: Esc dua-tahap (isi tak hilang sekali tekan);
    backspace/delete edit-teks (hapus-data = confirm); navigasi daftar
    (`↑↓`, pgup/pgdn, home/end) di semua popup; hint aksi minimalis
    (`kunci label`, kunci terang/label redup) akurat per permukaan;
    kursor diparkir di semua permukaan; Enter `/model` = pilih satu
    langkah, Tab = ubah effort.
26. i18n dwibahasa: semua string user-visible lewat `t()`; id kunci = en
     (tsc mengawal); fallback kunci hilang → en; prioritas sesi > env >
     state.json > locale OS > en (di OS: `LC_ALL` > `LANG`, string kosong
     diabaikan); literal Indonesia hardcode dilarang.
31. Sinyal fatal saat TUI hidup (SIGTERM/SIGHUP): restore terminal dulu
    (alt-screen exit + raw mode pulih + handler exit sinkron) lalu exit
    `128+n` (143/129). Pasangan ketat per-run — handler dipasang di
    `run()` dan dilepas di cleanup; tanpa sesi TUI, sinyal tak disentuh.
    (Temuan audit TUI-001: handler `exit` Node tak jalan pada SIGTERM
    default — terminal tertinggal alt-screen + raw.)
32. Proyeksi Presentasi V2.1 TUI memakai snapshot struktural dari composition
    root, bukan parser string. `view`, cap, scroll, approval, transient,
    resize, cursor, dan PTY path tetap memakai kontrak lama.
33. Proyeksi linear dan ACP memakai snapshot/event presentasi yang sama:
    linear menambahkan status/duration/receipt/retry tanpa mengubah
    stdout/stderr split, sedangkan ACP mengirim lifecycle `turn.*`, `tool.*`,
    dan `approval.*` terstruktur plus teks delta. Exit code, pipe safety, dan
    determinisme non-TTY tetap sama.

27. Painter transient stderr (spinner setup/cek-update, bar loading startup,
     garis status turn) DITAHAN selama layar interaktif memegang terminal: `beginInteractiveScreen`
     (`src/ui/runtime/statusline.ts`) membisukan `paintWrite` (nol byte + baris
     painter dibersihkan sekali saat layar mengambil alih), nested dihitung,
     release idempoten. Pemegang: `askLine`/`askSecret`/`runPicker` (raw-mode)
     dan `openAltScreen` (alt-screen, release di `close()`). Tanpa ini tick
     `\r\x1b[2K` spinner menghapus baris prompt wizard (laporan "macet di
     Menyiapkan sesi…"). Bar loading (`src/ui/runtime/loading-bar.ts`) adalah
     painter transient jenis kedua: single-line blok `▓░` + persen + label,
     digambar ulang HANYA saat `update(label, percent)` dipanggil (bukan
     interval), TTY-only (non-TTY = no-op nol byte), label disanitasi, kursor
     direstore di `exit`. Fase startup (update check/install/restart, provider,
     RAG, tool, kernel, resume) memanggil `update`; diagnostik startup
     (resume/recovery/context/dll) DITUNDA saat REPL dan di-flush ke transcript
     TUI (`ctx.startupNotices`), sedangkan non-interaktif tetap mencetak langsung.
     Output npm saat auto-update disembunyikan (`stdio: pipe` dibuang).
28. Kontrak exit code: **0** sukses/help, **1** gagal runtime/lookup, **2**
     salah pakai (argumen hilang/malformed, subcommand asing). Flag sebagai
     positional id = salah pakai (exit 2). `exec --json` yang gagal di fase
     setup (tanpa provider) TETAP memancarkan satu baris `{"type":"summary",
     "ok":false,…}` (di-scrub) di stdout — pipeline CI tak pernah menerima
     stream kosong; jalur manusia (stderr + exit 1) tidak berubah. Flag
     handler `exec`/`daemon` dibaca dari argv scope — lihat I34.
29. `minicode acp` = server JSON-RPC stdio satu-JSON-per-baris untuk IDE
     (subset: `initialize`/`run`/`cancel`/`shutdown`; BUKAN klaim ACP penuh):
     stdout murni mesin (semua di-scrub), diagnostik manusia ke stderr,
     approval `deny-headless`, satu run dalam satu waktu, shutdown/EOF = exit 0.
30. `askLine` (input inline: dropdown `/`, prompt wizard/`ask_user`)
     menginvalidasi jangkar relatifnya saat geometri terminal berubah: render
     pertama sesudah `columns`/`rows` berbeda dari geometri render TERAKHIR
     me-reset `prevRows`/`prevInputRows`/`prevCursorRow` lalu menggambar dari
     kursor saat ini (`lastGeoCols/Rows` di `src/ui/input/input.ts`). Jangkar
     basi pasca-reflow mendarat di baris salah — menimpa area output dan
     menghapus baris yang salah (temuan snap kiri/kanan). SENGAJA tanpa
     listener `resize` baru (frame basi cukup ditimpa render berikutnya), dan
     `printedW` tidak ikut di-reset — nilainya konservatif; dikosongkan justru
     membiarkan ekor lama.
34. Routing argv-scope (P11.2/P11.3): handler `exec` dan `daemon` menerima
     argv SCOPE dari router — flag global dikenal yang mendahului token
     subcommand tetap berlaku, token subcommand dibuang, urutan token
     sisanya utuh. Ditunjukkan tes: `--json exec "t"` identik dengan
     `exec --json "t"` (prompt model = teks user persis, tanpa token
     routing maupun nilai flag); `--json daemon status` mencapai aksi
     `status` alih-alih error subcommand asing; aksi/opsi yang tidak
     dikenal TETAP salah pakai sesuai I28; posisi argumen pertama
     (prompt/aksi) tidak bergeser. Hanya kedua handler itu menerima scope
     — subcommand lain menerima args mentah. Invarian ini tidak mengubah
     semantik, aksi, atau exit code masing-masing aksi; yang berubah hanya
     invokasi flag-mendahului yang dulu salah rute menjadi rute benar.
35. **WorkMode = lapis intent di ATAS permission mode (P12 S2.2 + P0.2)** — dua
    dimensi yang BERJALAN BERSAMA, bukan pengganti:
    **Nilai runtime:** `DISCUSS` (investigasi baca-saja lokal: tepat 16 tool `PURE_READ`
    lokal, network read `web_fetch`/`web_search` ditolak penuh) · `PLAN`
    (ceiling rencana: 16 tool baca lokal + `web_fetch`/`web_search` wajib lewat
    pengawasan eksplisit + ekstra rencana bila diizinkan Tool Access Policy) ·
    `EXECUTE` (tanpa ceiling tambahan). Nama produk `BUILD` memetakan ke
    identitas internal `EXECUTE`; sesi baru memakai default `DISCUSS`.
    **Gerbang penolakan & side-effect ceiling:** Tool Access Policy menentukan
    capability yang tersedia; PermissionMode menentukan pengawasan persetujuan;
    WorkMode memasang ceiling tambahan. Irisan ketiganya tidak pernah
    memperluas akses (INV-WM1), `visible === callable` terjaga lintas transisi runtime,
    hooks diblokir pada `DISCUSS` maupun `PLAN` untuk semua PM, dan `--verify`
    ditolak fail-closed saat startup bila digabung `DISCUSS`/`PLAN` (exit 2)
    serta dilewati otomatis saat mode turun ke `DISCUSS`/`PLAN` di TUI.
    **Command `/work-mode <DISCUSS|PLAN|BUILD>`:** tiga nilai produk yang dapat
    dipilih operator; `EXECUTE` hanya nama internal dan ditolak sebagai input.
    Tanpa argumen → tampilkan mode aktif + usage; nilai invalid → pesan
    kesalahan dan mode AKTIF TIDAK berubah; sesi tanpa kontrol WorkMode
    (handler izin terinjeksi = policy, bukan mode) → ditolak, bukan
    diam-diam tampak berubah. Transisi berlaku pada SESI YANG SEDANG
    BERJALAN: ceiling permission dievaluasi per pemanggilan tool, daftar tool
    dan instruksi system prompt yang dilihat model ikut turun/naik, hooks/verify
    dievaluasi terhadap WorkMode aktif, dan delegasi berikutnya mewarisi
    WorkMode parent yang aktif. WorkMode TIDAK bisa dinaikkan otomatis oleh
    model, anak, atau argumen delegasi.
    **Resume (P0.2 Q5 — menggantikan D-2):** WorkMode DIPERSIST di metadata sesi
    (`sessions.work_mode`) lintas `--resume`. Saat resume tanpa sinyal eksplisit
    (`--work-mode` / `MINICODE_WORK_MODE`), WorkMode dipulihkan dari metadata
    sesi (baris legacy tanpa `work_mode` kembali ke default `DISCUSS`; nilai
    tersimpan `EXECUTE` lama ditampilkan sebagai `BUILD`) dan
    composition root menulis SATU baris stderr human-facing
    (`[resume] WorkMode <MODE> restored from session...` atau notice override/
    legacy) agar otoritas sesi hasil resume selalu terlihat eksplisit. Baris itu
    keluar lewat stderr, BUKAN proyeksi mesin/JSON/ACP — kanal machine tetap
    terstruktur (`summary.workMode` / `result.workMode`), tanpa teks dekoratif.
    **Surfacing lintas-surface (F-DISCUSS-4):** WorkMode terlihat di TUI lewat
    footer (Work Mode kiri; Permission Mode kanan), di one-shot/exec linear
    lewat SATU baris stderr human-facing `[work-mode] <MODE> …`, dan di
    `exec --json` lewat field `summary.workMode` dengan nilai produk `DISCUSS`,
    `PLAN`, atau `BUILD` — bukan teks dekoratif. ACP memakai `params.workMode`
    (terstruktur) dan tak menambah baris
    dekoratif. WorkMode selalu dibedakan tegas dari PermissionMode (`[work-mode]`
    vs `/mode`/`--plan`) dan dari status sesi.
    **Pemisahan dari PermissionMode:** `Tab` memutar WorkMode;
    `Shift+Tab` dan `/mode` mengubah PermissionMode. PermissionMode menentukan
    pengawasan persetujuan (`AUTO`/`ASK`) dan Tool Access Policy menentukan
    capability. WorkMode memilih postur (diskusi/rencana/bebas) dan hanya
    mempersempit akses.
    **Hooks:** gate `shouldRunHooks(permissionMode, workMode)` dievaluasi
    **per pemanggilan** dengan WorkMode dan PermissionMode **AKTIF**. Hooks
    ditahan pada WorkMode `DISCUSS`/`PLAN` dan PermissionMode warisan
    `plan`/`readonly`; `Tab` mengubah WorkMode, sedangkan `Shift+Tab` mengubah
    PermissionMode AUTO/ASK.
    **Footer:** Work Mode tampil di kiri (nilai `Build`/`Plan`/`Discuss`; alias
    internal `EXECUTE` ditampilkan `Build`). Permission Mode tampil di kanan dekat
    token konteks sebagai nilai `Auto`/`Ask`. Label produk `Work Mode:` dan
    `Permission Mode:` dihapus v0.24 — nilai saja, lebih lega. Nilai Work Mode
    memakai warna semantik; nilai Permission Mode memakai cyan agar kedua sumbu
    mudah dibedakan. Titik `●` kuning = bash allow-list aktif, abu = nonaktif,
    `○` merah = unrestricted. Bila ada job background hidup, badge `◷ N` tampil
    di samping spark.

## Grammar (ringkas)

prompt `minicode ›` tampil saat boot/idle dan hilang saat busy (dropdown `/`
berbingkai di atasnya) ·
status bar `✦ 00.00.00 Discuss  model  cwd … context  Auto ●`
(timer redup idle; detik putih aktif, menit mulai terang di 60 dtk, jam di 1
jam; tanpa bullet separator; permission rata kanan dekat token konteks; label
`Work Mode:`/`Permission Mode:` dihapus; `●` kuning = bash allow-list aktif,
abu = tidak, `○` merah = unrestricted; badge `◷ N` bila job background hidup)
+ satu spacer sebelum footer · ledger tool
`  › name target` (hijau) / merah saat error · error `pesan` berwarna merah sekali per
kegagalan · pesan error TUI = formatter kanonik (`formatError`,
`src/ui/render/errors.ts`): credential di-redaksi (bearer/key/query), escape
ANSI dibuang, body provider diringkas + dipotong; `e.message` mentah tak
pernah tampil · thinking: dots clock / alir thinking terbaca · popup: konten redup di
belakang + kotak terpusat (form di dalam) + Esc tutup · approval tercatat ·
`/status`, `/history`, `/help` ringkas & `/expand` mengalir ke transkrip ·
`/mode` = permission mode · `/work-mode` = WorkMode (intent layer) ·
`/fold` = lipat aktivitas tool per turn (`MINICODE_MINIMIZE_ACTIVITY`, ON di TUI) —
baris ledger per-tool dirangkum jadi SATU baris ringkas (`n tools · nama · x ok · y gagal`),
tidak hilang diam-diam; detail dibuka via `/expand` ·
tabel markdown dirender kotak ber-garis (opencode-like) ber-`wrap` (konten panjang
tidak kepotong) + margin kiri 1 kolom; teks paragraf ber-margin kiri 1 kolom ·
Projection V2: `› name target … running`, ledger status ber-warna/kata,
retry/grup anak (anak ber-identitas run = baris `↳ run_<8>` sendiri; tanpa
identitas run = hitungan `n child tools`), ringkasan turn, dan marker evict
sesuai flag ·

`Esc` saat turn = abort (+ hint sekali); busy = input beku total ·
Mouse wheel = scroll transkrip, PgUp/PgDn = scroll, Shift+PgUp/PgDn = setengah
halaman, Home/End (prompt kosong) = lompat top/ekor · indikator `↓ N baris baru` ·
tab dihitung 8 kolom (batas atas stop
terminal — tak pernah undercount) · C1/bidi/tag dibuang dari teks
tak-terpercaya (sanitasi) · truncate/chunk hanya menyalin SGR (non-SGR
dibuang) · penanda `(aktif)` di luar budget truncasi (tak termakan URL
panjang).

## Residual risk (DISENGAJA — jangan "perbaiki" tanpa keputusan)

1. Foreign partial stderr write tanpa newline (non-interaktif).
2. `kill -9` di tengah sesi: ketik `reset` (pola standar). SIGTERM/SIGHUP
   SUDAH di-handle (I31 — restore + exit 128+n); hanya kill -9/terminal
   close yang masih menyisakan alt-screen.
3. Transkrip TUI hilang saat quit (disengaja — TUI fullscreen).
4. Terminal purba tanpa alternate screen: pesan satu baris + keluar (bukan error).
5. Approval saat user scroll ke atas: blok tercatat di ekor (tak terlihat
   sampai PgDn), tapi prompt jawaban + bell selalu terlihat di bawah.
6. Area yang dibuka kembali saat kotak menyusut = kosong (bukan transkrip
   di belakangnya) sampai popup tutup + repaint penuh.
7. Jalur end-to-end mouse SGR bergantung pada TRANSPORT PTY: kalau byte SGR
   tak sampai ke stdin anak, selection → OSC52 tak bisa diverifikasi lewat
   byte stream nyata. Pada lingkungan diagnostik Windows (ConPTY + node-pty
   1.2.0-beta.15) byte SGR terbukti sampai ke anak yang membaca dalam raw
   mode — kegagalan lama yang disangka "ConPTY membuang SGR" adalah artefak
   line buffering probe, bukan keterbatasan transport. Perilaku platform lain
   belum diuji; capability gate mengukur kemampuannya secara langsung
   (bukan asumsi platform): di luar CI Linux, SGR yang memang tak diantarkan
   → SKIP beralasan; di CI Linux jalur SGR end-to-end WAJIB terverifikasi,
   jadi probe yang verdict-nya bukan "supported" → GAGAL dengan diagnosa
   (bukan skip senyap yang menghapus coverage).

## Peta proteksi (test → invariant)

> **Cara membaca peta ini.** Setiap baris hanya boleh menyatakan perilaku yang
> **benar-benar di-assert** oleh test yang disebut. Kehadiran nama file test
> bukan bukti klaim. Baris yang hanya "nominal" (test ada, tapi assertion-nya
> tak menyentuh perilaku yang diklaim) dipindah ke bagian
> [Gap proteksi](#peta-proteksi-dan-gap-tersisa) di bawah — jangan
> dipoles dengan mengganti kata-kata.

- `test/tui-app.test.ts` — I1/I13/I14/I17-I20 (baris indikator dipotong ke
  lebar frame walau locale id 51 kolom; prompt idle bertahan setelah Esc;
  `repaint()` tak melukis saat suspended; boot/exit pairing, transcript
  viewport, mouse-wheel/drag-selection/PgUp/PgDn scroll + indikator, prompt
  editing, dots/timer, status bar, Esc-only abort, quit, suspend/resume,
  busy-freeze, live repaint; I14: Home/End jump + Shift+PgUp/PgDn + hint abort
  pertama ada di `test/tui-audit-fixes.test.ts`, bukan di file ini; I17: kunci
  posisi baca saat stream masuk; basis monotonik ada di
  `test/tui-transcript.test.ts` + `test/presentation-projections.test.ts`;
  P0: jalur error TUI meredaksi credential — sentinel bearer tak pernah tampil
  di layar).
- `test/prompt-engine.test.ts` — decoder streaming CSI/SGR/X10: wheel menjadi key scroll, klik mouse tidak masuk teks.
- `test/errors-usage.test.ts` — format error UI: `formatError` (kanonik untuk TUI/wizard/one-shot) meredaksi credential (bearer, kunci provider, query, token di batas potong 150 kolom), membuang escape ANSI, memetakan kategori/kind provider, dan menjaga pesan biasa tetap informatif.
- `test/checkpoint-lifecycle.test.ts` — checkpoint = milik lifecycle sesi: manifest tersedia saat `close()` kembali (barrier), tak ada operasi yang tertinggal, kegagalan checkpoint tercatat + dilaporkan tanpa unhandled rejection, dan semua operasi dari beberapa turn selesai saat drain.
- `test/tui-transcript.test.ts` — projection source-mapped: wrap, CJK/ANSI, user prefix, tabel TSV, selection text, cap buffer live, dan render markdown inline jawaban model (heading/bold/code; delimiter fence disembunyikan, isi fence dan gema user tetap literal).
- `test/screen-buffer.test.ts` — parser frame harness (unit).
- `test/tui-transcript.test.ts` — I7/I12/I17/I22 (ledger satu baris per tool, cap 5000 + marker evict, `total()` monotonik kebal evict, viewport, thinking minimized/expanded).
- `test/thinking-area.test.ts` — I22 area thinking: blok live maks 10 baris (header/`… N baris lagi`), ringkasan 1 baris + detail `/expand` saat turn selesai, tanpa duplikasi, dan fallback legacy saat panel OFF.
- `test/presentation-projections.test.ts` — I12/I17/I32 (projection
  snapshot, running/elapsed, status terminal, retry/child grouping, summary,
  marker evict + `total()` monotonik, dan parity flag OFF) + F-AGENT-1
  (baris per-run `↳ run_<8>`/`sub_<8>` untuk anak ber-identitas run; tiga anak
  paralel = tiga baris; anak tanpa identitas run tetap satu baris ledger induk
  `n child tools`) + F-TASK-1 (baris ledger `t<n> <status> parent=… dependsOn=[…]
  r<rev>`; jalur **linear** merender baris sama + proyeksi `normal`
  mempertahankan notice task — PROMPT 06 Area D).
- `test/presentation-linear-acp.test.ts` — I33 (linear projection
  status/duration/receipt dan lifecycle ACP terstruktur; parity policy-vs-legacy)
  + PROMPT 06 Area D (`task.status` → baris ledger linear **dan** envelope ACP
  berfield `taskId`/`status`/`parentId`/`dependsOn`/`revision`).
- `test/presentation-policy.test.ts` — I32/I33 (seleksi node per mode, envelope
  machine, digest divergensi; purity tanpa clock/IO) + PROMPT 06 Area D
  (notice `task.status` **ikut mode `normal`** dengan field terstruktur utuh).
- `test/writer-inventory.test.ts` — OAP-008 (setiap writer langsung terdaftar
  dengan owner; jumlah tak boleh naik diam-diam).
- `test/exec-json-envelope.test.ts` + `test/cli-session.test.ts` (envelope
  machine) — I28/I33/I34 (summary berversi, tanpa ANSI/secret, tanpa raw
  kernel; P11.2 scoping prompt: flag-mendahului vs `exec`-dahulu identik,
  kata `exec` milik user tetap utuh).
- PROMPT 06 Area A — `test/ui-instance-isolation.test.ts`: state renderer
  per-instans (dua sesi nyata; env = bootstrap saja).
- PROMPT 06 Area B — `test/approval-integrity.test.ts`: binding args-hash +
  fingerprint target difoto sebelum prompt dan diverifikasi di barrier efek
  (deny `"stale"` bila berubah), termasuk jalur kernel nyata.
- PROMPT 06 Area C — `test/daemon-stream-phase.test.ts`: `subscribed.phase` +
  `tail_marker.phase` dari latch per-langganan; badge `" [replay]"`.
- PROMPT 06 Area E — `test/memory-consistency.test.ts`: degradasi vector
  terlihat di hasil tool, revoke provenance AND (fail-closed), reconcile
  mengadopsi (bukan menghapus) vector-only, fakta panjang utuh, supersession
  menarik baris lama, lupa menghapus entri multi-chunk utuh, cap per-entri,
  validasi respons embedding.
- PROMPT 06 Area F — `test/ci-glob-expansion.test.ts`: `ci-windows` memakai
  `shell: bash` (pwsh tak mengekspansi glob → suite p15..p24 lolos diam-diam),
  pola mati dihapus, subset p15..p24 hadir di kedua job.

- `test/tui-popup.test.ts` — I16 (komposit di atas transkrip, anti-bocor,
  anti-hantu) + I13 (App.paintRegion/clearRegion mendelegasikan region modal ke
  screen; clock badge memutar `◷` saat idle lalu berhenti saat quit).
- `test/form.test.ts` — I21 (field, validasi, secret, select, confirm, batal;
  Esc-1 kembalikan prefill untuk text/secret DAN pilihan bawaan untuk
  select/confirm, Esc-2 batal; Tab+teks dalam satu chunk tidak menulis ke field
  lama; field aktif di luar tinggi kotak tetap terlihat).
- `test/render-audit-2026-11.test.ts` — audit renderer 2026-11-12 (proyeksi
  pending dimemo per baris → tidak O(n²); SGR majemuk diproses berurutan di
  `truncateToWidth`; indentasi `wordWrap`; SGR opak di highlight; cap input &
  guard LCS diff; lebar tabel untuk grapheme 2 kolom; kop sesi lewat i18n;
  `dialogBox` menggeser jendela ke `focusRow`) **plus penutupan kebocoran**:
  `U+2028/U+2029` jadi spasi di jalur satu-baris, dan paste composer tidak
  bisa menyelundupkan CSI C1 (`U+009B`) — buffer composer dilukis apa adanya,
  jadi gate-nya ada di `prompt-engine` sebelum buffer terbentuk. Jalur pesan
  error layar (`picker`, `model-manager`/`provider-manager` fail-open) dan
  hasil probe jaringan `cli/commands.ts` (`/sync`) memakai `cleanUntrusted` /
  `sanitizeAnsiLine`; hook `?25h` loading-bar didaftarkan lazy agar modul yang
  sekadar di-import tidak menulis byte ke alt-screen.
- `test/approval-tui.test.ts` — I23 (blok + keputusan tercatat, deny;
  stdout-pipe tanpa sink = deny) + modal v0.24 (kotak dilukis via
  `paintRegion`, `clearRegion` dipanggil saat selesai, input raw-mode di-echo
  ke kotak, Esc/Ctrl+C = batal fail-closed).
- `test/background-job-badge.test.ts` — I13 (badge `◷ N` = jumlah job hidup,
  fase berputar dari clock idle, `[BG:n]` fallback ASCII, nol byte saat 0) +
  `onBackgroundJobFinished` emit TEPAT SEKALI per job (error+close tidak dobel).
- `test/footer-render.test.ts` — I13 (nilai mode title case tanpa label produk, Work Mode kiri dan Permission Mode cyan rata kanan dekat konteks, posisi kolom stabil, fallback terminal sempit, titik `●` kuning/abu + `○` merah unrestricted, badge `◷ N`/`[BG:N]`).
- `test/e2e.test.ts` — I13 v7.12 (kernel meng-emit `provider:extension`
  kind `context-window` berisi `usedTokens`/`windowTokens` setelah
  `step:completed` — sumber live-occupancy footer; nilai > 0 terbukti).
- `test/work-mode-runtime.test.ts` — I35 (WorkMode runtime: ceiling permission
  dievaluasi per pemanggilan tool; transisi BUILD/EXECUTE↔DISCUSS↔PLAN pada sesi
  yang sama; daftar tool yang dilihat kernel ikut berubah; hooks mengikuti
  WorkMode aktif; delegasi mewarisi WorkMode parent terbaru; argumen
  delegasi tak bisa menaikkan WorkMode; `/work-mode` end-to-end lewat TUI
  termasuk nilai invalid; `/mode` + Shift+Tab tak menyentuh WorkMode; footer
  memakai label title case; Tab mengubah WorkMode dan Shift+Tab tidak).
- `test/work-mode-contract.test.ts` — I35 (ceiling handler WorkMode di atas
  handler PM: 18 sel matriks, gerbang approval `PLAN × PM` termasuk `web_fetch`/
  `web_search`, `DISCUSS` memblokir network read, `describeDenial` per pemilik
  keputusan, `always`/K-1 tetap utuh, `__setMode` tak mencabut ceiling).
- `test/work-mode-tool-visibility.test.ts` — I35 (visibilitas tool = irisan
  permission mode ∧ WorkMode; `DISCUSS` tepat 16 tool baca lokal tanpa network
  read; `PLAN × readonly/allowlist` tak memperluas di luar 18 `READONLY_TOOL_NAMES`;
  tool MCP ikut dibatasi).
- `test/work-mode-hooks.test.ts` — I35 (hooks: `DISCUSS` dan `PLAN` menahan
  semua `.minicode/hooks/*` di seluruh `PermissionMode`; hanya `EXECUTE` yang
  mengikuti permission mode; pemanggil lama tanpa WorkMode kompatibel).
- `test/work-mode-subagent.test.ts` — I35 (child mewarisi WorkMode parent;
  tak ada eskalasi lewat mode child; default tanpa WorkMode = perilaku lama).
- `test/work-mode-cli.test.ts` — I35 (`--work-mode`/env: flag > env > persisted
  resume > default DISCUSS; nilai invalid → DISCUSS + peringatan; input operator
  hanya DISCUSS/PLAN/BUILD; `--verify`
  ditolak fail-closed pada DISCUSS/PLAN; ACP `workMode` + fallback env; daemon
  `workMode` parity).
- `test/tui-app.test.ts`, `test/tui-popup.test.ts` — I13/I14/I17 (composer
  editing/busy, dots clock, timer, cursor, resize, popup; teardown saat initial,
  frame, event/timer, dan resize repaint gagal; abort/scroll saat layar menciut;
  spacer composer-footer).
- `test/markdown-table.test.ts` — I8/I11 (pipe-table parser, streaming
  parity, ANSI/CJK width, TTY/non-TTY, TUI resize, machine-output policy).
- `test/terminal-contract.test.ts` — I2/I3/I7/I8/I9 (split stdout/stderr,
  kepemilikan layar tunggal, ledger satu baris per tool, streaming tanpa
  duplikasi, foreign writer boleh mentah).
- `test/provider-retry-output.test.ts`, `test/tui-transcript.test.ts`, dan
  `test/presentation-events.test.ts` — invalidasi attempt provider gagal;
  TUI/transkrip/history/`/copy` tidak menggabungkan teks gagal dengan jawaban
  final, sementara sink linear memberi marker dan usage tetap tercatat.
- `test/transient-arbitration.test.ts` — I3/I9/I27 (hold layar interaktif:
  picker/askLine, nesting, delayMs).
- `test/loading-bar.test.ts` — I27/I6 (bar loading: non-TTY no-op nol byte,
  delay pertama, progres blok+persen+label, sanitasi label, stop idempoten,
  restore kursor, mutual exclusion transient, ditahan layar interaktif).
- `test/statusline-bun-guard.test.ts` — I4 (painter Bun/Windows: painter
  dinonaktifkan sendiri, write asli dipulihkan).
- `test/turn-status.test.ts` — garis status turn lifecycle deterministik
  (grace 250 ms, latch anti-strobe, pembersihan saat `endTurn`).
- `test/tui-format.test.ts` — I2/I7/I8 (preview arg sanitasi satu-baris;
  stdout = output program / stderr = ledger; 20 tool berurutan = 1 baris
  masing-masing tanpa overlap) + **I18** (envelope OSC52 `/copy` benar saat
  TTY, ditolak tanpa TTY, dan 1–10 turn terakhir oldest-to-newest).
- `test/theme.test.ts` — I6 (strip DCS/APC/PM/SOS + final CSI non-huruf).
- `test/ansi-fragmentation.test.ts` — I6/I8 (setiap titik split ≡ string utuh).
- `test/non-tty-output.test.ts` — I6.
- `test/thinking-truncation.test.ts` — I12 (buffer thinking >200 KB → `/expand`
  membawa marker truncasi).
- `test/collapse.test.ts`, `test/presentation-expand.test.ts`,
  `test/presentation-store.test.ts` — **I24** (semantik `/expand` pada Content
  Store: buka-ulang identik, dengan id vs tanpa id, miss → durable sqlite +
  penanda retensi).
- `test/ui-combined.test.ts` — DIHAPUS bersama chrome.
- `test/repl-linear.test.ts`, `test/footer-chrome.test.ts`,
  `test/info-window.test.ts` — DIHAPUS bersama REPL/chrome/jendela.
- `test/cli-commands.test.ts` — /status cetak, /sessions popup.
- `test/screen.test.ts` — I16 (pairing + paintRegion; open/paint writer failure
  mencoba memulihkan alt-screen dan reset region) + I1 (satu `write` per frame;
  repaint penuh saat frame pertama / drift stderr / perubahan kolom, dan diff
  inkremental per sel pada paint berikutnya yang setara — bukan clear `ESC[2J`
  tiap keystroke).
- `test/cells.test.ts` — I1 (tokenizer sel grapheme + diff "tulis-ulang ekor":
  prefix identik nol byte, dari kolom berbeda pertama sampai akhir baris ditulis
  ulang setelah EL `ESC[0K`; start mundur ke sel pembawa glyph agar EL tak
  membelah glyph lebar; state SGR ternormalisasi urutan kanonik — `ESC[39m`
  membatalkan bukan menumpuk, `38;5;n`/`38;2;r;g;b` utuh, glyph lebar dilindungi
  `cont`; fuzz 500 kasus paritas output vs referensi).
- `test/composer-wrap.test.ts` — I1 (wrap composer inkremental paritas dengan
  `chunkByWidth` penuh untuk append/backspace di ujung, CJK lebar, multiline;
  pola tak didukung → fallback).
- `test/screen-buffer.test.ts` — parser grid ANSI/CUP dengan pengukuran grapheme
  yang sama dengan renderer (termasuk emoji ZWJ dua kolom).
- `test/tui-startup-failure.test.ts` — UI-COMPAT-01 (CLI subprocess non-TTY:
  diagnostik stderr, stdout kosong, exit 1, provider tidak dipanggil).
- `test/dialog.test.ts` — I11/I16/I20 (geometri, backdrop, box).
- `test/tui-overlay.test.ts` — I11/I16 (popup region + gate layar).
- `test/ui-boundary.test.ts` — I1/I3 (src/ui tak impor keluar).
- `test/i18n.test.ts` — I26 (resolusi, fallback, interpolasi, kelengkapan;
  LC_ALL > LANG, string kosong diabaikan).
- `test/i18n-hardcode.test.ts` — I26 (lexer sadar-state: tanpa literal
  Indonesia di luar kamus; kontrol positif id.ts kena, negatif en.ts bersih).
- `test/tui-lang.test.ts` — I26 (locale sesi `/lang` end-to-end + persisten;
  nilai tak dikenal ditolak) + I24 (`/help` satu sumber; `/copy 2` menyalin dua
  turn terakhir).
- `test/cli-help-language.test.ts` — I26/I25 (label en, kelengkapan /help).
- `test/tui-geometry.test.ts` — I20/I25 (lebar tetap per permukaan, step
  wizard, form error).
- `test/sanitize.test.ts` — I2 (C1/bidi/tag dibuang, ZWJ dipertahankan;
  NO_COLOR menang di cleanUntrusted).
- `test/width.test.ts` — I2/I7 + UI-RENDER-01 (VS16, skin tone, ZWJ, regional
  indicator, keycap, combining mark; truncate/chunk tidak memecah grapheme;
  tab 8 kolom; hanya-SGR + auto-reset; chunk(0) kosong).
- `test/exit-codes.test.ts` — I28 (0/1/2 di semua handler; lookup tetap 1;
  hermetic subprocess).
- `test/exec-json-envelope.test.ts` — I28 (summary ok:false di stdout saat
  setup gagal; jalur manusia tak berubah).
- `test/cli-subcommands.test.ts` — I34 (daemon scoped argv: `--json daemon
  status` mencapai aksi `status`, bukan exit 2 palsu; bentuk `daemon`-dahulu
  tidak berubah; aksi asing tetap exit 2; HOME hermetik, exit 3 not-alive
  mengikuti kontrak daemon yang sudah ada — bukan klaim baru I34).
- `test/acp.test.ts` — I29 (parser/framing/params + smoke spawn stdio:
  initialize→shutdown exit 0, tanpa provider).
- `test/input-resize.test.ts` — I30 (gagal di kode lama: CUP `\x1b[1A` ke
  jangkar basi sesudah resize; multiline, dropdown terbuka, resize ganda,
  resize cepat ×10 → nilai submit utuh).
- `test/tui-diff.test.ts` — I2/I7 (path & isi disanitasi).
- `test/highlight.test.ts` — I2/I8 (CR dibuang; escape dibuang di hulu).
- `test/tui-theme-highlight.test.ts` — I2 (section satu-baris; markdown
  buang escape di hulu).
- `test/provider-manager-flows.test.ts` — I21 (Ctrl+C dua-tahap revert
  prefill; penanda aktif anti-truncasi).
- `test/tui-signal.test.ts` — I31 (SIGTERM→143, SIGHUP→129: alt-screen exit
  + raw mode pulih; handler dilepas saat quit — pasangan ketat; tanpa
  `run()` sinyal tak di-intercept).
- `test/tui-audit-fixes.test.ts` — I14 (Home/End jump top/tail saat prompt
  kosong + baris berisi tetap editing; Shift+PgUp/PgDn half-page + dekode
  ESC[5;2~; hint abort pertama), I13 (MINICODE_MOTION=0: spark statis,
  env dibaca saat dipakai), I25 (kursor CUP parkir di dalam blok ?2026 yang
  sama), I21 (konstanta idle form 80+10 dtk + teks peringatan).
- `test/pty.test.ts` — I13/I17/I31/I28 + UI-RENDER-01 via BYTE STREAM NYATA
  (harness PTY `test/helpers/pty-harness.ts`, CLI di pseudo-terminal
  sesungguhan + provider fake hermetic): boot → ?1049h + timer idle, terminal
  terlalu kecil menolak alt-screen, turn penuh, teks Unicode kompleks pada
  frame produksi, drag-selection mouse SGR → Ctrl+C → OSC52 (koordinat mouse
  dihitung dari LAYAR NYATA, bukan hardcoded), resize → repaint, SIGTERM →
  restore + exit 143 (POSIX). *Klausa "exec --json bersih tanpa ANSI" di test ini berjalan
  sebagai proses biasa tanpa PTY (lihat komentar di berkasnya) — jadi ia
  bukan bukti byte stream; bukti envelope ada di `test/exec-json-envelope.test.ts`.*
  Platform tak mampu (ConPTY rusak) = SKIP beralasan, bukan hijau palsu.
  Verifikasi **exit code** (I28) hanya dijalankan di POSIX: Windows ConPTY
  terbukti kadang melaporkan `exitCode: undefined` untuk anak yang keluar via
  PTY interaktif (satu probe sukses TIDAK menjamin run berikutnya), sehingga
  test di-SKIP beralasan di Windows — bukan diluluskan dan bukan dianggap
  "berhasil".
  Jalur mouse SGR punya capability gate (`ptySgrMouseDelivered()`): transport
  yang TAK mengantarkan byte SGR → SKIP beralasan; probe tak konklusif → SKIP
  dengan alasan "tak konklusif" (BUKAN bukti SGR tak didukung); di CI Linux
  verdict WAJIB "supported" — selain itu test SGR GAGAL dengan diagnosa, bukan
  skip senyap. Parser SGR dan selection SGR tetap terverifikasi terpisah di
  `test/prompt-engine.test.ts` dan `test/tui-app.test.ts` (fake TTY).

### Peta proteksi dan gap tersisa

Baris berstatus "ditutup" menunjukkan bukti yang tersedia saat ini. Gap tersisa
tetap UNVERIFIED; keberadaan implementasi saja bukan bukti UAT.

| Klaim | Status implementasi | Yang hilang |
|---|---|---|
| I14 — "berlaku juga saat layar MENCIUT: abort+scroll selalu lolos" | Terimplementasi (`src/ui/tui/app.ts`: PgUp/PgDn dan Esc diintercept sebelum `tooSmall()`) | Ditutup: `test/tui-app.test.ts` membuktikan scroll posisi baca bertahan saat layar dipulihkan dan Esc memanggil abort; `Ctrl+D` tetap jalan keluar terakhir. |
| I13/I17 — "satu baris kosong memisahkan composer dari footer" | Terimplementasi (`src/ui/tui/app.ts` merender satu spacer per frame) | Ditutup: `test/tui-app.test.ts` meng-assert baris spacer dalam frame penuh 14 baris. |
| I20 — lebar kotak popup tetap per permukaan | Terimplementasi | `test/tui-app.test.ts` menandai salah satu test-nya sebagai `(I20)`, padahal test itu milik I13 (status bar). Lebar popup diverifikasi di `test/tui-geometry.test.ts` + `test/dialog.test.ts`; label di `tui-app` menyesatkan. |
| I5 — tak ada popup yatim / input bocor setelah success/failure/cancel/SIGINT/session end | Tak terverifikasi | `test/turn-status.test.ts` dan `test/statusline-bun-guard.test.ts` tidak meng-assert apa pun soal popup yatim atau kebocoran input. |
| I26 pada jalur presentasi | i18n ada dan dijaga terpisah | `test/presentation-projections.test.ts` mengunci locale `en` di setiap test dan tak pernah menguji locale `id`; klaim i18n dijaga `test/i18n.test.ts` + `test/i18n-hardcode.test.ts`. |
| I2/I6/I28 pada proyeksi linear/ACP | Alur linear/ACP ada | `test/presentation-linear-acp.test.ts` tak meng-assert split stdout/stderr, absence cursor-control, maupun exit code secara langsung. |
| I3 — kepemilikan frame tunggal selama alternate-screen | `App` merender frame ke stdout; `simple` quiet dan transient stderr ditahan selama layar dimiliki TUI | Ditutup untuk jalur yang diuji: `test/terminal-contract.test.ts` memastikan printer linear quiet tetap tidak menulis, `test/pty.test.ts` mengamati frame produksi, dan `test/writer-inventory.test.ts` mengunci daftar writer. Suite PTY berjalan pada CI Linux; Windows ConPTY tidak menjalankan seluruh kasus PTY. |
| UI-COMPAT-01 — startup TUI gagal | Non-TTY/terminal tak mampu menolak fullscreen tanpa fallback linear; diagnostik stderr dan exit 1 | Ditutup: `test/tui-startup-failure.test.ts` menguji CLI produksi via subprocess; `test/pty.test.ts` menguji terminal di bawah minimum tanpa `?1049h`. Exit code PTY hanya diklaim jika platform mengembalikan angka. |
| UI-RENDER-02 — exception render melewati teardown | `TuiApp.run()` melakukan cleanup idempoten di `finally`; write frame melempar ke owner | Ditutup untuk initial paint, writer frame, dan event repaint: `test/tui-app.test.ts` + `test/screen.test.ts` memverifikasi alt-screen, raw mode, listener, subscription, timer dan sync-update. Sinyal POSIX diperiksa terpisah; Windows melewati test sinyal POSIX. |
