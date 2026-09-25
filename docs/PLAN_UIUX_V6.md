# PLAN PENYEMPURNAAN UI/UX — Minicode 0.7.0 → 0.8.0

**Status:** ✅ selesai (V6), dilanjutkan uji live multi-provider (V7). Ringkasan hasil di [CHANGELOG.md](../CHANGELOG.md).

| Metrik | Target | Hasil V6 | Hasil V7 (uji live) |
|---|---|---|---|
| REPL menerima prompt | ya | ✅ | ✅ diverifikasi dengan 2 gateway nyata |
| Test | seluruhnya hijau | 859 pass | **913 pass, 0 fail** |
| Coverage agregat | ≥65% cli/ | 79,33% / 82,15% | **80,52% funcs / 83,10% lines** |
| Berkas UI di 0% coverage | ≤6 | ✅ 6 | ✅ 6 |
| Gate coverage | naik dari 69/74 | min 77/80 | min 77/80 (aktual 80,5/83,1) |
| Resolve-rate terukur | — | belum diukur | **1,00** (5/5 tugas berpemeriksa objektif) |

**Empat bug tambahan yang hanya muncul dengan provider sungguhan** (V7, detail di CHANGELOG):
`/cost` + `--budget` selalu nol setelah turn pertama; `cli/errors.ts` punya test tapi tak dipanggil sehingga body JSON provider tumpah ke layar; model `:free` dihargai seperti varian berbayar; `exec` mengirim nilai flag sebagai bagian prompt.

---

**Basis:** audit UI/UX menyeluruh — 24 temuan, diverifikasi dengan menjalankan tiap subcommand CLI, mengemudikan TUI lewat harness keystroke sintetis, dan memanggil `handleBuiltinCommand` langsung. Kondisi awal: `bun test` 637 pass / 1 fail (false positive), `tsc --noEmit` bersih, **REPL tidak bisa dipakai sama sekali**.

## Prinsip yang mengatur urutan

1. **Test dulu untuk area yang rusak, bukan sesudah.** Bug blocker (#1) lolos karena lapisan interaktif punya nol test. Menambal tanpa harness berarti bug berikutnya juga akan lolos. Fase 0 mendahului semua perbaikan.
2. **Satu perubahan struktural mengalahkan lima tambalan.** Kursor (#6, #11), tema (#3), warna transcript (#4) masing-masing punya satu akar. Perbaiki akarnya.
3. **Jangan tambah permukaan baru sebelum yang ada bekerja.** Tidak ada fitur baru di rencana ini. `--ui`/`--tui` yang menganggur (#23) dihapus, bukan diimplementasikan.
4. **Ukur klaim.** Setiap fase punya perintah verifikasi yang menghasilkan bukti, bukan "terlihat benar".

---

## Fase 0 — Harness test TUI (prasyarat, ~0,5 hari)

Tanpa ini fase 1–5 tidak bisa diverifikasi selain secara manual.

| Item | Berkas | DoD |
|---|---|---|
| Harness fake TTY: stdin injektabel + stdout tertangkap sebagai frame | `test/helpers/tui-harness.ts` (baru) | `send("/s")` → frame terakhir bisa di-assert; `columns`/`rows` bisa diatur per test |
| Test `attachFullscreenMinimal` | `test/tui-fullscreen.test.ts` (baru) | 15 skenario: dropdown, filter, panah, Tab, submit, overlay, picker, streaming, tool+diff, history, perintah tak dikenal, Shift+Tab, Ctrl+O, baris panjang, Ctrl+C ×2 |
| Test `askLine` + `runPicker` + `runPanel` + `runProviderManager` | `test/tui-classic.test.ts` (baru) | render awal, dropdown, seleksi, submit, filter kosong, Esc dua tingkat, fallback non-TTY |
| Assertion anti-regresi rekursi | `test/tui-fullscreen.test.ts` | `submit` memicu `onLine` **tepat 1×**; `unhandledRejection` tetap kosong sepanjang test |

Harness sudah terbukti bekerja saat audit — pola: `Object.defineProperty(process, "stdin", …)` dengan stub `setRawMode`/`on("data")`, `process.stdout.write` diganti kolektor, frame diambil dari chunk yang memuat `\x1b[H\x1b[2J`.

**Verifikasi:** `bun test test/tui-*.test.ts` hijau; test rekursi **gagal** pada `HEAD` saat ini (membuktikan ia menangkap #1).

---

## Fase 1 — Blocker (~0,5 hari)

| # | Masalah | Berkas | Perbaikan |
|---|---|---|---|
| 1 | Rekursi tak berbatas spinner → REPL mati bisu pada prompt pertama | `src/tui/minimal/fullscreen.ts:263` | `startSpinner` men-set `spinnerTimer = setTimeout(tickSpinner, 150)` alih-alih memanggil `tickSpinner()` langsung |
| 2 | `setRawMode is not a function` di luar TTY | `src/tui/minimal/fullscreen.ts:384` | Guard `process.stdin.isTTY`; non-TTY → jalur baca baris sederhana, bukan alternate-screen |
| — | Kegagalan bisu di masa depan | `src/tui/minimal/fullscreen.ts` | `process.on("unhandledRejection")` di driver → tampilkan sebagai item transcript `error` + restore kursor; tidak ada lagi hang tanpa pesan |

**Verifikasi:** test fase 0 hijau; `bun cli/index.ts --interactive` manual menerima prompt dan menampilkan jawaban; `echo "x" | bun cli/index.ts --interactive` tidak melempar stack trace.

---

## Fase 2 — Tema hidup & warna transcript (~1,5 hari)

Dua temuan ini membuat seluruh sistem tema dan seluruh formatting markdown/diff jadi kode mati.

### 2.1 `c` dari closure beku → getter (#3)

`src/tui/theme.ts:57-91`. Objek `c` mengevaluasi token tema saat import, jadi `applyTheme()` tidak berpengaruh. Diverifikasi: `applyTheme("light")` lalu `c.success("X")` tetap mengeluarkan warna dark.

- Setiap slot jadi `get success() { return trueWrap(tk("success")) }`.
- **Terverifikasi layak:** 181 call-site `c.<slot>(…)` di 22 berkas tidak perlu diubah, dan `const { success } = c` tetap bekerja (mengambil snapshot saat destructuring — tak ada pola begitu di repo).
- `c.red`…`c.brightCyan` (#3, bagian kedua) dipetakan ke token tema, bukan hex hardcoded. Ini yang membuat `mono` benar-benar monokrom — jalur aksesibilitas.
- Cache per-tema (`Map<ThemeName, Wrappers>`) supaya getter tidak mengalokasi closure per panggilan pada jalur render panas.

**DoD:** `applyTheme("light")` mengubah keluaran `c.success`; `applyTheme("mono")` menghasilkan nol sekuens warna selain bold; `NO_COLOR=1` tetap menang atas semua tema.

### 2.2 Transcript berhenti membuang ANSI (#4)

`src/tui/minimal/fullscreen.ts:301`. `push()` men-`strip()` semua isi, jadi diff card kehilangan hijau/merah dan `decorateMarkdown` di baris 309/311 sia-sia.

- `push` menerima baris yang sudah berwarna; truncation memakai lebar **visible** (`stripAnsi` untuk mengukur, potong tanpa memutus sekuens di tengah).
- Item `tool` yang berisi diff card dan item `agent` hasil `decorateMarkdown` diteruskan utuh.
- Helper `truncAnsi(s, w)` baru — memotong berdasarkan lebar tampak dan menutup sekuens terbuka dengan `\x1b[0m`.

**DoD:** test meng-assert frame memuat sekuens hijau untuk baris `+` dan merah untuk `-`; markdown `**tebal**` menghasilkan `\x1b[1m` di frame; baris 200 karakter pada terminal 80 kolom tidak meninggalkan sekuens ANSI terpotong.

---

## Fase 3 — Cost & budget di REPL (~0,5 hari)

`fullscreen.ts:110` menunggu `provider:extension { kind:"usage", data.cost }` yang **tidak pernah dikirim provider mana pun** — `openai-compat.ts:92` dan `anthropic.ts:137` hanya mengirim token. Cost dihitung di `usage.get()` yang tidak pernah dibaca TUI. `--budget` di-`void` (#5, `fullscreen-driver.ts:197`).

| Item | Berkas |
|---|---|
| `FullscreenMinimalOpts` menerima `usage(): Usage` alih-alih menebak dari event | `src/tui/minimal/fullscreen.ts:35` |
| Header/footer membaca `usage().cost` pada tiap render | `src/tui/minimal/fullscreen.ts:324, 375` |
| Peringatan 80% + hentikan saat lewat batas, sejajar jalur one-shot (`cli/index.ts:220-235`) | `cli/fullscreen-driver.ts` |
| Indikator budget di header: `$0.0123 / $5.00` | `src/tui/minimal/fullscreen.ts` |

**DoD:** test dengan fake usage collector meng-assert cost muncul di frame setelah `turn:completed`; melewati batas menghasilkan item transcript peringatan dan menolak submit berikutnya.

---

## Fase 4 — Kursor & editing baris (~1 hari)

`prompt-engine.ts:147` mengembalikan `none` untuk `left`/`right`; `PromptState` tidak punya posisi kursor. Diverifikasi: `abcdef` + panah kiri ×3 + `X` → `abcdefX`. `_` di footer adalah kursor palsu yang menyesatkan.

| Item | Berkas |
|---|---|
| `PromptState` + `cursor: number` (indeks code-point, bukan UTF-16 unit) | `cli/prompt-engine.ts:5` |
| `char`/`backspace` menyisip/hapus **di posisi kursor**, bukan hanya di ujung | `cli/prompt-engine.ts:65-92` |
| `left`/`right` bergerak; `home`/`end`/`ctrl-a`/`ctrl-e` ditambahkan ke `PromptKey` + `decodeKey` (`ESC[H`, `ESC[F`, `ESC[1~`, `ESC[4~`) | `cli/prompt-engine.ts:26, 201` |
| `ctrl-w`/`ctrl-u` menghormati kursor (hapus kata sebelum kursor / ke awal baris) | `cli/prompt-engine.ts:129-146` |
| Renderer memposisikan kursor sungguhan (`ESC[<n>G`) dan berhenti mencetak `_` | `src/tui/minimal/fullscreen.ts:367`, `cli/input.ts:111` |
| Tab menghormati seleksi, bukan selalu item pertama (#11) — `pickFirst` → `pickSelected ?? pickFirst` | `cli/prompt-engine.ts:109` |
| Horizontal scroll `scrollableLine` mengikuti kursor, bukan hanya ujung | `cli/input.ts:103` |

Aman untuk emoji: `backspace` sudah code-point aware (`prompt-engine.ts:80`); logika yang sama diterapkan untuk gerakan kursor. Test emoji yang ada (`prompt-engine.test.ts:219`) harus tetap hijau.

**DoD:** `abcdef` + kiri×3 + `X` → `abcXdef`; Home/End berfungsi; kursor terminal tampak di posisi logis; 2000 fuzz `test/fuzz-prompt.test.ts` hijau dengan key baru dimasukkan ke generator.

---

## Fase 5 — Overlay, picker, mouse (~1 hari)

| # | Masalah | Berkas | Perbaikan |
|---|---|---|---|
| 7 | Overlay meluber melewati tinggi terminal dan tidak bisa di-scroll — 30 baris dirender penuh di terminal 20 baris, header terguling keluar | `fullscreen.ts:287, 344` | Slice ke `overlayLines`, state `overlayScroll`, panah/PgUp/PgDn, indikator `n/total`. Pinjam logika `cli/panel.ts:64-82` yang sudah benar |
| 8 | Byte mouse bocor jadi teks (`teks` → `teks 00` saat diklik) | `screen.ts:30`, `prompt-engine.ts:225` | Decoder mengenali `ESC[M`+3 byte serta SGR `ESC[<…M/m`; klik dibuang, wheel dinormalisasi menjadi scroll transkrip, dan mouse tracking hanya aktif selama TUI |
| 9 | `/resume` di TUI hanya mencetak instruksi manual | `fullscreen-driver.ts:114` | Respawn dengan `--resume <id>` seperti jalur klasik (`commands.ts:326`) |
| 9b | Tiap slash command menembak `onPicker` → `onOverlay` → `onLine` berurutan | `fullscreen.ts:218-241` | Satu tabel dispatch: `builtin(picker) | builtin(overlay) | skill | prompt`, diputuskan sebelum eksekusi, bukan dengan mencoba tiga jalur |
| 10 | Panah atas menggabungkan history ke teks yang ada (`halo` → `halo audit dong…`) | `cli/input.ts:198` | Ganti baris, jangan gabungkan — sejajar dengan perilaku shell dan dengan jalur fullscreen |

**DoD:** overlay 50 baris di terminal 20 baris bisa di-scroll penuh dan header tetap tampak; klik mouse tidak mengubah isi baris; `/resume` benar-benar melanjutkan sesi.

---

## Fase 6 — Konsistensi CLI (~1 hari)

| # | Item | Berkas |
|---|---|---|
| 12 | `--version` / `-v` — saat ini dikirim ke LLM sebagai prompt. Versi dibaca dari `package.json`, bukan hardcode di dua tempat | `cli/index.ts:66`, hapus literal di `:72` |
| 13 | `config`, `config mcp`, `config lsp`, `mcp` tanpa argumen mencetak HELP global 45 baris dan exit 0 → help kontekstual per subcommand + exit 1, mengikuti pola `auth`/`pricing` yang sudah rapi | `cli/commands/config.ts:185,253,257`, `cli/commands/mcp.ts` |
| 14 | `stats --json` mengabaikan flag | `cli/commands/stats.ts:20` |
| 15 | `renderTable`: `width` adalah minimum, bukan maksimum → kolom melebar dan header tidak lagi berbaris (nyata di `config list` dengan ID 23 karakter) | `src/tui/table.ts:20` — `width` jadi batas keras, isi lebih panjang dipotong dengan `…` |
| 16 | Alignment `providers` rusak untuk ID panjang | `cli/commands/providers.ts:69` — pakai `renderTable` alih-alih `padEnd(16)` manual |
| 17 | Bahasa campur: `providers`/`config`/`skills`/`sessions` Inggris, `auth`/`pricing`/TUI Indonesia, dalam satu sesi user melihat keduanya | seluruh `cli/` — **pilih Indonesia** (mayoritas permukaan interaktif sudah Indonesia); pesan `usage:` tetap Inggris karena konvensi CLI |
| 18 | Notice `[sandbox]` muncul di stderr untuk **setiap** perintah di Windows, termasuk yang tak menjalankan tool | `cli/index.ts:138` — tampilkan hanya bila sesi berpotensi menjalankan bash |
| 22 | `/help` tidak menyebut Ctrl+O, Ctrl+R, Shift+Tab, Ctrl+U, Ctrl+W, Esc, `\` continuation | `cli/commands.ts:60` — bagian "Keyboard" |

**DoD:** `minicode --version` mencetak versi dari `package.json`; setiap subcommand tanpa argumen memberi help sendiri dengan exit 1; `config list` dengan ID 30 karakter tetap sejajar; satu bahasa di seluruh keluaran.

---

## Fase 7 — Kebersihan (~0,5 hari)

| # | Item | Berkas |
|---|---|---|
| 19 | `stripAnsi` terduplikasi; `ANSI_PATTERN` tidak menangkap private-mode (`ESC[?25l`, `ESC[?2026h` lolos utuh — masuk ke teks overlay via `captureOutput`) | `src/tui/theme.ts:122` perluas pola; `src/tui/wrap.ts:6` re-export |
| 20 | Justify menjustifikasi baris terakhir paragraf → "sungai" spasi (`dengan      lebar      tertentu`) | `src/tui/wrap.ts:62` — baris terakhir rata kiri; `MINICODE_JUSTIFY=0` untuk mematikan |
| 21 | `/thinking` punya dua state (`process.env` dan `showThinking.ref`) dan **nol konsumen** — melapor sukses tanpa efek | satu state di `showThinking`, dibaca `simple.ts:60` dan `fullscreen.ts` untuk event `reasoning` |
| 23 | `--ui auto|full|classic` diparse, diteruskan, tidak pernah dibaca; `--tui` juga tidak berpengaruh | hapus `--ui` dari `cli/args.ts:24` dan `cli/index.ts:146`; `--tui` didokumentasikan sebagai default REPL atau dihapus dari HELP |
| 24 | `import-convention.test.ts` false positive (mendeteksi berkas test-nya sendiri) | `test/import-convention.test.ts:43` — kecualikan berkas yang memuat pola sebagai literal |

---

## Urutan & ketergantungan

```
Fase 0 (harness)
   └─> Fase 1 (blocker)        ← tanpa ini tak ada yang bisa diuji manual
          ├─> Fase 2 (tema+warna)
          ├─> Fase 3 (cost)
          ├─> Fase 4 (kursor)   ← paling besar, paling terisolasi
          └─> Fase 5 (overlay)
Fase 6, 7 (CLI, kebersihan)     ← paralel, tak bergantung TUI
```

Fase 6 dan 7 bisa dikerjakan siapa pun kapan pun. Fase 2–5 sebaiknya berurutan karena semuanya menyentuh `fullscreen.ts`.

**Total: ~6,5 hari.** Fase 0+1 (~1 hari) sudah memulihkan produk dari "tidak bisa dipakai" menjadi "bisa dipakai".

---

## KPI

| Metrik | Sebelum | Target |
|---|---|---|
| REPL menerima prompt | **tidak** | ya |
| Test lapisan interaktif | 0 berkas | `fullscreen.ts`, `input.ts`, `picker.ts`, `panel.ts`, `provider-manager.ts` ≥70% lines |
| Coverage `cli/` | 49% lines | ≥65% |
| Berkas UI di 0% coverage | 19 | ≤6 (jalur yang butuh proses nyata: `index.ts`, `setup.ts`, `exec.ts`, `auth.ts`, `wizard.ts`, `screen.ts`) |
| `applyTheme` mengubah warna | tidak | 4 preset, terverifikasi per slot |
| Warna diff/markdown di TUI | dibuang | dipertahankan |
| Cost tampil di REPL | tidak | ya, + peringatan budget |
| Editing di tengah baris | tidak | kursor penuh + Home/End |
| Overlay > tinggi terminal | meluber | scroll + indikator |
| `bun test` | 637 pass / 1 fail | seluruhnya hijau |

**Perintah verifikasi:** `bun test`, `bun x tsc --noEmit`, `bun run lint`, `bun test --coverage`, `bun run gate:coverage`, ditambah manual `minicode --interactive` pada terminal 60×20 dan 120×40.

---

## Yang sengaja tidak dikerjakan

Agar cakupan jelas dan tidak melebar:

- **Tidak ada framework TUI baru.** Pure ANSI tetap. Ink/blessed akan membuang seluruh `fullscreen.ts` demi masalah yang perbaikannya berukuran satu baris sampai satu fungsi.
- **Tidak ada wrap/scroll transcript virtual.** `RING_MAX 60` dan `tail.slice(-bodyH)` memadai; sisa PLAN_UIUX soal virtual scroll ditunda sampai ada keluhan nyata.
- **Tidak ada mouse click-to-copy** (PLAN_UIUX P3). Mouse wheel dipakai untuk scroll transkrip; klik mouse tetap diabaikan agar tidak merusak input.
- **Tidak ada tema baru.** Empat preset yang ada dibuat bekerja lebih dulu.
- **Repo-map, OAuth live, resolve-rate, publish npm** tetap di daftar tertunda PLAN_V5 — bukan UI/UX.
