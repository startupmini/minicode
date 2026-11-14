# Catatan agent — handoff minicode

> Ditulis ulang: 2026-11-13, setelah commit `ba50057`.
> Tujuan: serah-terima ke agent BERIKUTNYA. Bagian 1 = status; bagian 2 = tugas
> berikutnya (Fase 7 prompt caching); bagian 3+ = referensi yang masih berlaku.

---

## 1. Status: SUDAH DI-COMMIT

**`ba50057` — feat(context): kelola jendela konteks dari metadata endpoint +
kompaksi akuntabel.** 50 file, +3313/−361. Working tree bersih.

Isi commit (dua alur digabung dalam satu commit atas keputusan pemilik):

**A. Context window / kompaksi** — lihat `docs/plan-context-window.md` §11:

- Jendela konteks dibaca dari metadata `/models` (alias `context_length`,
  `context_window`, `max_input_tokens`, dst.), dipersist dengan asal nilai.
  Presedensi: user > endpoint > direktori publik > tabel statis. Fallback akhir
  **131.072** (dulu 32.000).
- Reserve output dari anggaran terpusat (`min(maxOutput, 20k)`, lantai 4k),
  bukan 256 token tetap. Ambang reklasifikasi 400 relatif terhadap jendela.
- Microcompact: pangkas isi hasil tool lama (keep 5, gating tiga syarat).
- Kernel melaporkan `no-op` / `fixpoint:<fixed>:<window>` /
  `impossible:<fixed>:<window>` / `llm-failed:<reason>` dengan angka — tidak
  lagi ditelan `catch {}`.
- Eskalasi adaptif 131k→2M, hanya dari overflow konteks terverifikasi; terpicu
  juga dari `budget_exceeded` lokal, bukan cuma penolakan provider.
- Label kompaksi di transcript membedakan "tidak menyusut" dari "berhasil".

**B. Audit UI/UX** (dari sesi lain, ikut dalam commit yang sama):

- `hintLine()` (`src/ui/render/hint.ts`) dipasang di picker/model-manager/
  provider-manager. Glyph literal → jalur `glyphs`. `PROVIDER_BOX_W` 52→64.
  Enter/Tab `/model` dipisah. `glyphs.mask` seragam. `createIdleTimer()` +
  `withTimeout()` di `src/ui/screens/{lifecycle,watchdog}.ts`. Logo baru 17×9
  (`src/ui/render/logo.ts`).

**Gate pada kandidat yang di-commit** (satu tree, satu waktu):

| Perintah | Hasil |
|---|---|
| `bun x tsc --noEmit` | bersih, 0 error |
| `bun run lint` | 705 file, 0 error |
| `bun test` | **5746 pass / 26 skip / 0 fail** — 5772 test, 408 file, ~1114 dtk |
| `bun run gate:coverage` | **funcs 88.64%** (min 87) · **lines 90.10%** (min 86) · 19/19 lantai hijau |
| `bun run gate:pack` | 23 pass / 0 fail — 316 file / 4095 KB |

Angka di atas **historical**: berlaku untuk tree `ba50057`, bukan janji untuk
commit berikutnya. Jalankan ulang gate setelah perubahan apa pun.

Catatan: `gate:coverage` dijalankan tepat sebelum commit; setelahnya hanya
berkas dokumen (`AGENTS.md`, plan) yang berubah. Kalau butuh angka benar-benar
post-commit, jalankan `bun run gate:coverage` sekali lagi (~20 menit, diselesaikan
sebagai proses latar lalu baca log-nya — cara ini terbukti berhasil di sini).

---

## 2. TUGAS BERIKUTNYA — Fase 7: prompt caching

**Status: BELUM DIKERJAKAN.** Ini satu-satunya fase dari
`docs/plan-context-window.md` yang masih terbuka (Fase 0–6 sudah terpasang).

### 2.1 Masalah yang diselesaikan

Pada sesi insiden, payload 478.602 karakter hasil tool = 96% konteks, dan
**nol prompt caching terpakai**. Artinya setiap turn membayar ulang seluruh
prefix. Ini bukan bug fungsional, tapi biaya & latensi: turn ke-6 di sesi itu
mengirim 45,7 juta token kumulatif input.

### 2.2 Kenapa sengaja ditunda sampai sekarang

Manfaat caching hanya terasa setelah microcompact stabil, dan keduanya
**bertabrakan secara mendasar**: setiap perubahan prefix (pemangkasan hasil
tool, kompaksi) membatalkan cache. Kalau caching dipasang lebih dulu, setiap
microcompact akan diam-diam menghapus seluruh tabungannya. Urutan yang benar
adalah: stabilkan dulu apa yang mengubah prefix, baru optimalkan prefix-nya.

Karena itu Fase 7 harus dimulai dengan **pengukuran**, bukan implementasi.

### 2.3 Langkah yang disarankan

1. **Ukur dulu (wajib, jangan lewati).** Tambahkan penghitung cache hit/miss
   dari field usage provider (`cache_read_input_tokens` /
   `cached_tokens` / `cache_creation_input_tokens` — nama berbeda per gateway,
   perlakukan seperti alias seperti di `src/providers/detect.ts`). Tanpa angka
   hit rate, tidak ada cara membuktikan caching bekerja atau bahwa ia tidak
   dimatikan terus oleh microcompact. Laporkan hit rate per turn.
2. **Inventaris prefix.** Urutkan isi request dari yang paling stabil ke paling
   volatil: system prompt → definisi tool → riwayat lama → riwayat baru →
   pesan user terakhir. Cari tahu apakah urutan ini sudah stabil antar-turn
   (kalau ada timestamp/session id/hitungan yang ikut terkirim di awal prefix,
   cache tidak akan pernah kena — ini penyebab paling umum cache miss total).
3. **Tandai batas cache.** Untuk provider yang mendukung `cache_control`
   eksplisit (Anthropic-style), pasang penanda di batas blok stabil terakhir.
   Untuk yang otomatis (prefix matching), tidak ada kerja selain butir 2.
   **Jangan** menaruh penanda pada sesuatu yang berubah tiap turn.
4. **Rekonsiliasi dengan microcompact.** Putuskan dan tulis eksplisit: apakah
   microcompact boleh memangkas isi yang berada **di dalam** prefix yang sudah
   di-cache (membatalkan sisa cache, tapi menghemat token berulang), atau hanya
   yang di luar. Ini keputusan trade-off yang harus diukur dengan angka dari
   butir 1 — bukan ditebak.
5. **Seam, bukan cabang vendor.** Implementasi harus lewat seam di kernel
   (`vendor/minicore/src/core/`), dengan kapabilitas yang dinegosiasikan dari
   metadata endpoint — **bukan** percabangan pada nama model/vendor. Prinsip
   P7/D9 di `docs/plan-context-window.md` §8 berlaku penuh di sini.
6. **Kill-switch.** Ikuti pola yang sudah ada (`MINICODE_MICROCOMPACT=0`,
   `MINICODE_CONTEXT_PROBE=0`): tambahkan `MINICODE_PROMPT_CACHE=0`, catat di
   `docs/environment.md`.
7. **Test.** Hit rate tidak bisa diuji tanpa provider; uji yang bisa:
   (a) ekstraksi field cache dari bentuk usage yang berbeda-beda,
   (b) stabilitas urutan prefix antar-turn (dua request berturut-turut dengan
   riwayat sama harus menghasilkan prefix byte-identik),
   (c) penanda tidak jatuh pada bagian volatil,
   (d) regresi: microcompact + caching tidak membuat cache hit selalu 0.

### 2.4 Batasan yang tidak boleh dilanggar

- Jangan turunkan ambang `scripts/coverage-gate.ts` atau naikkan budget
  `scripts/pack-budget.ts`. Budget pack saat ini **4095 KB dari 4096** — praktis
  tidak ada ruang; kalau menambah kode, pangkas komentar atau cari byte lain.
- Jangan ubah urutan pesan yang terlihat oleh model tanpa memperbarui
  `docs/TERMINAL_CONTRACT.md` bila itu mengubah output yang tampil.
- Jangan memecah pasangan `assistant → tool` (aturan yang sama seperti
  microcompact: hasil tool tanpa pemanggilnya membuat provider menolak request).

### 2.5 Yang belum divalidasi (warisan, jangan diklaim selesai)

- **Probe HTTP aktif** (`probeContextWindow()` dengan `max_tokens:1`) belum
  dipasang. Modul `src/policy/context-escalation.ts` sudah menyediakan tangga,
  whitelist pemicu, anggaran, dan padding sintetis; pemanggilnya belum ada.
  Penjelasan kenapa ditunda ada di `docs/plan-context-window.md` §11.4 butir 1.
- Validasi pada **gateway nyata** (dengan kredensial) belum dilakukan; yang
  divalidasi adalah unit test + jalur sesi dengan provider palsu.

---

## 3. Jebakan yang PERLU diingat (semua pernah jadi bug nyata)

- `c`/`glyphs` di `src/ui/render/theme.ts` adalah **getter** runtime — jangan
  simpan ke `const` di module scope (nilai membeku saat import).
- Lebar terminal = **kolom**, bukan karakter: pakai `displayWidth` dkk. dari
  `src/ui/render/width.ts` (CJK/emoji = 2 kolom).
- Teks model/tool/berkas = input tak terpercaya: lewatkan `sanitizeAnsi`
  (`src/ui/render/sanitize.ts`) sebelum tampil. Sanitasi adalah satu-satunya
  gerbang; modul geometri sengaja mempertahankan sekuens utuh (footer memakai
  CHA non-SGR).
- `cwd` tool file **wajib** dari `ToolContext.cwd`, bukan `process.cwd()`.
- Logo: rasio per-sel half-block (U+2580–U+2584) agar persegi; fallback ASCII
  `#` 9 baris. Test yang menyentuh logo/kop: `test/session-summary.test.ts`,
  `test/render-audit-2026-11.test.ts`.
- Batas lapisan dijaga `test/ui-boundary.test.ts` — ubah struktur dependensi
  antarlapisan → wajib update `docs/architecture.md`.
- **Encoding**: jangan pakai PowerShell `Get-Content -Raw` + `Set-Content` untuk
  file UTF-8 tanpa BOM (pernah merusak `src/ui/screens/picker.ts` jadi CP1252
  double-encode). Pakai `[System.IO.File]::ReadAllText/WriteAllText` dengan
  `UTF8Encoding($false)`, atau Python `io.open(..., newline='')`.
- **Staging per-hunk dengan `git apply --cached` rapuh di repo ini** karena
  `core.autocrlf=true` (patch LF vs index CRLF) dan karena hunk yang berisi
  perubahan dua sesi sekaligus tidak bisa dipisah di level hunk. Untuk commit
  berikutnya: jangan campur dua alur dalam satu working tree, atau bangun ulang
  file dari `git show HEAD:<path>` + sisipkan hanya bagian milik Anda.
- Komentar Indonesia, jelaskan **mengapa**. UTF-8 tanpa BOM.
- Jangan commit kecuali diminta; jangan pernah commit rahasia.

## 4. Flake dikenal di bawah beban suite penuh

Lulus saat dijalankan sendiri — jangan dikejar sebagai regresi:
`test/supply-chain.test.ts` (`git_diff` textconv),
`test/work-mode-cli.test.ts` (`exec --json --verify`),
`test/writer-inventory.test.ts`, `test/exit-codes.test.ts`,
`test/extreme.test.ts`, `test/phase1-tools.test.ts`,
`test/tui-format.test.ts` (statusline),
`test/recovery-side-effects.test.ts` (git subprocess),
`test/concurrency-cross-process.test.ts` (§32, flake lintas-proses Windows).

## 5. Scope klaim hasil (ringkas, dari AGENTS.md)

- Laporan stage-scoped hanya boleh mengklaim scope yang benar-benar divalidasi.
- Menutup track Quality Remediation atau mengumumkan release-readiness tetap
  mensyaratkan seluruh gate akhir lulus pada satu kandidat final yang sama.
- Angka hasil historis (termasuk tabel di §1) tetap **historical** — sebutkan
  checkpoint-nya, jangan menyebutnya sebagai hasil sekarang.

---

## 6. TEMUAN AUDIT — Surface Popup & UI (2026-11-14)

> Ditambahkan oleh sesi audit. **Audit ini tidak mengubah kode** — perbaikan
> dikerjakan agent lain. Penomoran `AUD-<n>` sengaja berbeda dari namespace
> roadmap (`P*`, `Stage *`) agar tidak bertabrakan.
> Cara pakai: ambil dari §6.1, kerjakan, lalu pindahkan ke §6.2 dengan bukti
> test/commit. **Jangan menomori ulang** `AUD-<n>` yang sudah ada.
> **Jangan ganti isi §1–§5 di atas** — itu handoff aktif sesi lain.

### 6.0 Kondisi saat audit

| Hal | Nilai |
|---|---|
| HEAD | `192e329` — `v0.24: context window, kompaksi, dan polish UI/UX` |
| Working tree | bersih (`git status --porcelain` kosong) |
| Status plan Surface | **BELUM DIEKSEKUSI** (AUD-001) |

### 6.1 Terbuka

#### AUD-001 — `PLAN-SURFACE-POPUP.md` belum diimplementasikan sama sekali

**Kelas**: selisih dokumen vs kode (bukan bug runtime).
**Bukti** (`grep -rn` di `src/ docs/ test/`): simbol plan **nol di `src/`**:

| Simbol dari plan | Ada di kode? |
|---|---|
| `scrimMode()` | ❌ tidak ada |
| `composeScrim()` | ❌ tidak ada |
| `MINICODE_BOX` | ❌ tidak ada |
| `MINICODE_SCRIM` | ❌ tidak ada |
| glyph `╭ ╮ ╰ ╯` | ❌ tidak ada |

Yang **masih** keadaan lama:
- `src/ui/tui/app.ts:1043` `applyBackdropDim()` — hanya `\x1b[2m`, tanpa
  background gelap `48;5;236`.
- `src/ui/tui/app.ts:1062` `paintDimmed()` memakai `applyBackdropDim`.
- `src/ui/screens/dialog.ts:49` `boxChars()` mengembalikan `┌┐└┘` (lancip).

**Risiko**: dokumen plan bisa terbaca sebagai "sudah dikerjakan".
**Perbaikan**: kerjakan plan §12, atau tandai jelas di kepala dokumen plan
bahwa statusnya masih *usulan*.

#### AUD-002 — `colorLevel()` tidak memakai `process.stdout.getColorDepth()`

**Kelas**: deteksi kapabilitas kurang lengkap.
**Lokasi**: `src/ui/render/theme.ts:45` `colorLevel()`.

```ts
if (hasTruecolorEnv()) return 3
if (process.env.TERM?.includes("256color")) return 2
return 1
```

**Masalah**: di Windows Terminal/ConPTY, `TERM` sering tidak diset padahal
terminalnya 256-color/truecolor ⇒ jatuh ke `1` (16-color). Ini juga akan
memblokir scrim gelap nanti (gate `level >= 2`).
**Perbaikan**: tambah `getColorDepth() >= 8` → 2, `>= 24` → 3, sebagai
**fallback sesudah** env (bukan mengganti). Wajib: non-TTY tetap `0`,
`NO_COLOR` tetap menang, perilaku pipe/redirect tidak berubah (I6).
**Test**: `test/theme.test.ts` + pastikan tak ada test yang mengunci
"TERM kosong ⇒ 1".

#### AUD-003 — `applyBackdropDim` netralisasi SGR tidak konsisten (bold)

**Kelas**: kebocoran atribut di backdrop popup.
**Lokasi**: `src/ui/tui/app.ts:1043`.

```ts
let s = ln.replaceAll(`${esc}[1m`, "")            // bold DIBUANG total
s = s.replaceAll(`${esc}[22m`, `${esc}[2m`)       // "normal" → faint (menyala)
s = s.replaceAll(`${esc}[0m`, `${esc}[0m${esc}[2m`)
s = s.replaceAll(`${esc}[m`, `${esc}[0m${esc}[2m`)
```

**Masalah dua arah**:
1. `[1m` dibuang, bukan dinetralkan ⇒ konten yang hanya mengandalkan bold
   (mis. judul tabel markdown tanpa warna, terminal 16-color) kehilangan
   penekanan saat redup; baris tetangga tidak.
2. `[22m` (kembali ke normal) dipetakan ke `[2m` (**menyalakan** faint) ⇒
   urutan `[1m … [22m` berubah jadi `… [2m`, teks sesudahnya jadi faint padahal
   penulis aslinya bermaksud normal.

**Bukti empiris** (fungsi yang sama dieksekusi terpisah, output di-`ESC`-kan):

| Input | Output | Catatan |
|---|---|---|
| `[1mJUDUL[0m` | `[2mJUDUL[0m[2m[22m[0m` | bold **hilang total** — hanya faint, tak ada beda kontras |
| `[1mA[22mB` | `[2mA[2mB[22m[0m` | `B` jadi **faint**, padahal aslinya normal |

**Perbaikan**: pilih satu perilaku eksplisit — (a) buang bold dan jangan pernah
nyalakan faint sesudahnya, atau (b) konversi `[1m` → `[2m` (bukan dibuang).
Sekarang kodenya campuran keduanya.
**Test yang ada TIDAK menangkap ini**: `test/ui-audit-regressions.test.ts:71`
hanya meng-assert `not.toContain("[1m")` dan `toContain("[0m[2m")`
— ia justru **mengunci perilaku yang salah** (bold dibuang). Test baru harus
meng-assert semantik: sesudah `[22m`, intensitas harus kembali normal.
**Test**: baris bold-only di 16-color; urutan `[1m…[22m`.

#### AUD-004 — `dialogFrame` masih ada & masih dipakai (dua model render)

**Kelas**: inkonsistensi arsitektur (plan §1 gejala #3).
**Bukti**: `src/ui/screens/dialog.ts:181` mengekspor `dialogFrame()` = frame
**selayar penuh** dengan `░` faint menutupi seluruh area.
**KOREKSI atas dugaan awal audit**: `wizard.ts` **TIDAK** memakai `dialogFrame`
— ia memakai `dialogBox` + `paintRegion` (lihat `wizard.ts` bagian
`const box = dialogBox(...)`). Pemakai `dialogFrame` yang tersisa **hanya
test** (`test/dialog.test.ts` 9 pemakaian); nol pemakai produksi.
**Dampak sebenarnya**: bukan bug tampilan, tapi **kode mati + beban test**.
`dialogFrame` dan seluruh `test/dialog.test.ts` menguji jalur yang tak pernah
dijalankan pengguna.
**Perbaikan**: pilih satu — (a) hapus `dialogFrame` + test-nya (deklarasi
jujur bahwa dua-model sudah tidak ada), atau (b) pertahankan bila ada rencana
pemakaian. Jangan biarkan sebagai kode mati tanpa penanda.

#### AUD-005 — Approval: input SUDAH di dalam kotak (koreksi); sisa isu = UX pilihan

**KOREKSI atas dugaan awal audit.** Approval **bukan** lagi `askLine` inline.
Sejak v0.24 ia modal sungguhan:

- `src/ui/approval/prompt.ts:63` `readModalLine()` — raw-mode, `char` menambah
  teks, `enter` submit, `esc`/`ctrl-c` batal.
- `src/ui/approval/prompt.ts:126` `renderModal()` — setiap ketikan me-render
  ulang `dialogBox`, dan `typed` **di-echo ke baris di dalam kotak**
  (`body.push('  > ' + typed)`).
- `sink.suspend()` / `sink.resume()` berpasangan di `finally`.

Jadi keluhan "merusak tatanan chat" **sudah tidak berlaku** untuk approval.

**Sisa isu yang masih nyata** (lihat AUD-007 untuk yang lebih penting):
1. **Label jawaban berupa teks bebas, bukan pemilih.** User harus mengetik
   `y`/`a`/`n` (atau sinonim dwibahasa) lalu Enter. Tidak ada navigasi
   `↑↓` + Enter seperti picker lain. Kontrak I25 menuntut "navigasi daftar
   `↑↓`/pgup/pgdn/home/end di **semua** popup berdaftar" — footer approval
   menampilkan tiga opsi setara daftar, tapi tak bisa dinavigasi.
2. Tidak ada penyorotan pilihan aktif; salah ketik ⇒ deny (fail-closed, benar
   secara keamanan, tapi UX-nya menghukum).

**Perbaikan**: ubah tiga opsi menjadi item picker di dalam kotak yang sama
(`↑↓` + Enter), atau pertahankan ketik-cepat (`y`/`a`/`n`) **dan** tambahkan
navigasi panah. Rekomendasi: keduanya (ketik-cepat tetap, panah sebagai jalur
utama). Ini pekerjaan UX, bukan bug keamanan.

#### AUD-006 — Lebar kotak tetap 64 di semua permukaan

**Kelas**: keputusan rasa yang diputuskan **berubah** di plan.
**Bukti**: kontrak I20 ("model 64, picker 64, provider 64, form 64 — min=max").
**Dampak**: terminal 160 kolom → kotak terasa sempit; terminal 70 → hampir
menempel tepi.
**Hasil simulasi** (rumus `dialogBox` + `PICKER_BOX_W=64`):

| cols | innerMin | innerMax | contentWidth | lebar kotak |
|---|---|---|---|---|
| 80 | 60 | 60 | 60 | **64** |
| 100 | 60 | 60 | 60 | **64** |
| 140 | 60 | 60 | 60 | **64** |

Catatan: rumus `cols-2-4` (picker) dan `cols-6` (form) **identik nilainya** —
bukan bug, jangan "perbaiki" salah satunya. Yang perlu diubah hanya
*konstantanya* (60/64 tetap → skala).

**Perbaikan**: plan §5 — `clamp(40, floor(cols*0.6), 88)` + freeze saat mount,
lalu redefinisi I20. **Jangan longgarkan assert test**; ganti ke nilai baru.

#### AUD-007 — Kotak approval memakai lebar LAYAR PENUH, bukan 64 seragam

**Kelas**: pelanggaran I20 + inkonsistensi visual.
**Lokasi**: `src/ui/approval/prompt.ts:133` `renderModal()`.

```ts
const box = dialogBox(
  { title: spec.title, body, footer: spec.footer ?? undefined },
  Math.max(20, cols),
  Math.max(5, rows),
)   // ← TANPA minWidth/maxWidth
```

**Bukti** (simulasi `dialogBox`):

| cols | innerMax | lebar kotak approval | lebar `/model` | selisih |
|---|---|---|---|---|
| 80 | 74 | sampai **78** | 64 | 14 |
| 120 | 114 | sampai **118** | 64 | 54 |
| 160 | 154 | sampai **158** | 64 | 94 |

**Dampak**: di terminal lebar, dialog approval melebar hampir selebar layar
sementara semua popup lain 64. Ini **pelanggaran langsung** I20 ("lebar kotak
popup TETAP per permukaan") dan membuat approval terasa "bukan jendela, tapi
layer baru" — persis keluhan awal pemilik.
**Perbaikan**: beri `minWidth`/`maxWidth` seperti permukaan lain — atau
serahkan ke `Surface` bersama (plan §6). Jangan lupa `promptAskText` di berkas
yang sama memakai jalur `renderModal` yang sama.
**Test**: `test/approval-tui.test.ts` belum meng-assert lebar kotak; tambahkan.

#### AUD-008 — `ask_user` menampilkan opsi bernomor tapi jawaban TIDAK dipetakan

**Kelas**: bug UX/fungsional (jawaban ambigu ke model).
**Lokasi**: `src/ui/approval/prompt.ts:263` `promptAskText()`.

```ts
const optionLines = options?.length
  ? options.map((o, i) => `  ${c.dim(`${i + 1}.`)} ${sanitizeAnsiLine(o)}`)
  : []
...
const out = ans.trim()
return out          // ← mentah; tak pernah dipetakan ke options[i-1]
```

**Bukti**: opsi dirender `1. Red` / `2. Blue`. User mengetik `1` ⇒ fungsi
mengembalikan `"1"`, **bukan** `"Red"`. Pemanggil
(`src/tools/ask_user.ts:120`) meneruskan string apa adanya ke model, lalu
`return answer.trim().slice(0, 4000)`.

**Dampak**: model menerima `"1"` dan harus menebak. Untuk pertanyaan dengan
opsi panjang, jawaban user hilang sebagai teks. Ini juga bertabrakan dengan
semangat I25 (pilihan = navigasi, bukan tebakan).
**Perbaikan**: pilih **satu** —
(a) petakan `"1".."n"` → `options[i-1]` saat `options` diberikan (paling wajar
untuk daftar bernomor), atau
(b) jangan tampilkan nomor; kirim teks mentah dan dokumentasikan bahwa nomor
hanya hiasan (pilihan lemah).
**Test**: `promptAskText` dengan `options` + input `"1"` harus mengembalikan
nilai opsi pertama. Saat ini tak ada test yang menyentuh pemetaan ini.

#### AUD-009 — `paintRegion` menulis baris tanpa clamp ke `cols` (jaring pertahanan)

**Kelas**: kerentanan defensif (belum ada pemanggil yang salah hari ini).
**Lokasi**: `src/ui/runtime/screen.ts:256`.

```ts
out += `[${r};1H[2K${row}`
```

`row` ditulis **utuh**, tanpa `truncateToWidth(row, cols)`. Bila sebuah view
melukis baris lebih lebar dari terminal, terminal auto-wrap ⇒ satu baris jadi
dua ⇒ semua baris berikutnya bergeser satu dan `clearRegion` menghapus wilayah
yang salah (baris hantu / sisa bingkai).

**Status saat ini**: **tidak dapat dipicu** — semua 9 pemanggil
(`picker`, `model-manager`, `provider-manager`, `form`, `wizard`×3,
`approval`×1, `cli/tui.ts`) meneruskan `dialogBox().lines`, dan `dialogBox`
menjamin `boxW <= c0-2 <= cols`. Jadi ini **bukan bug aktif**.
**Kenapa tetap dicatat**: jaminan itu implisit (tersirat dari formulasi
`innerW`), tidak ditegakkan di titik tulis. Sebuah view baru yang membangun
baris sendiri akan merusak layar tanpa peringatan.
**Perbaikan**: satu `truncateToWidth(row, cols)` sebelum menulis, atau
assert/sanitasi di `paintRegion`. Murah, menghilangkan seluruh kelas bug.
**Catatan**: jangan tambahkan writer baru — `writer-inventory.test.ts` (OAP-008)
menghitung writer dan menolak penambahan diam-diam.

#### AUD-010 — `ask_user` memotong opsi dengan `slice` mentah (surrogate pair terbelah)

**Kelas**: bug sanitasi — **regresi kelas yang sudah pernah diperbaiki**.
**Lokasi**: `src/tools/ask_user.ts:64`.

```ts
const opts = Array.isArray(options)
  ? (options as unknown[]).map((o) => String(o).slice(0, 200)).slice(0, 8)
  : ...
```

**Bukti empiris** (string `"a"×199 + "😀"`):

| | hasil |
|---|---|
| panjang asli | 202 |
| hasil `slice(0,200)` | 200 |
| char terakhir | `d83d` = **surrogate tinggi tanpa pasangan** |
| akibat | `U+FFFD` (``) saat di-encode ke UTF-8 |

**Konteks**: kelas bug ini **sudah** dikenal dan diperbaiki di tempat lain —
`src/ui/approval/prompt.ts` memakai `truncateToWidth(...)` dengan komentar
eksplisit "slice mentah bisa membelah surrogate pair (audit 2026-11-12,
MEDIUM-1)". `ask_user.ts` tertinggal memakai pola lama.

**Dampak**: opsi yang dipotong di tengah emoji/CJK-astral menampilkan karakter
rusak ke model dan (bila di-echo) ke layar. Bukan crash, tapi data korup.
**Perbaikan**: ganti `.slice(0, 200)` dengan `truncateToWidth(sanitizeAnsiLine(String(o)), 200, "…")`
— persis pola `prompt.ts`. Perhatikan: `sanitizeAnsiLine` dulu, potong sesudah.
**Test**: opsi berisi emoji di posisi ke-200 harus menghasilkan string tanpa
`U+D800..U+DFFF` yatim.

### 6.1b Ringkasan prioritas (untuk agent yang mengambil tugas)

| ID | Dampak | Kesulitan | Urutan saran |
|---|---|---|---|
| AUD-010 | data korup (U+FFFD) | 1 baris | **1 — paling murah, langsung benar** |
| AUD-003 | backdrop salah redup; test mengunci perilaku salah | kecil | **2** |
| AUD-007 | pelanggaran I20, terasa paling "merusak tatanan" | kecil | **3** |
| AUD-008 | jawaban opsi hilang/ambigu | sedang | **4** |
| AUD-002 | deteksi warna kurang; blokir scrim | kecil | **5** |
| AUD-005 | UX approval (panah vs ketik) | sedang | **6** |
| AUD-006 | lebar tidak menyesuaikan (keputusan rasa) | sedang | **7 — bareng plan §5** |
| AUD-001 | plan belum dieksekusi | besar | **8 — pekerjaan utama** |
| AUD-009 | defensif, belum bisa dipicu | 1 baris | **9 — bonsai** |
| AUD-004 | kode mati | 1 hapus | **10 — bonsai** |

Catatan: AUD-010 dan AUD-003 adalah dua yang **paling murah tapi paling nyata**.
Kerjakan keduanya dulu sebelum menyentuh pekerjaan Surface yang besar.

### 6.2 Selesai

Semua dikerjakan 2026-11-14 pada working tree (belum di-commit — lihat §6.4).

**GATE PENUH HIJAU pada kandidat yang sama** (urutan AGENTS.md, satu tree):

| Perintah | Hasil |
|---|---|
| `bun x tsc --noEmit` | bersih (0 error) |
| `bun run lint` | 708 file, 0 error |
| `bun test` | **5780 pass / 26 skip / 0 fail** |
| `bun run gate:coverage` | funcs 88.59% (min 87) · lines 90.08% (min 86) · 19/19 lantai hijau |
| `bun run gate:pack` | 23 pass / 0 fail — 4127 KB (budget 4128 KiB) |

Catatan penting soal dua gate:

- **`gate:pack` nyaris penuh**: paket 4127 KB dari 4128 KiB — tinggal **1 KB**.
  Setiap penambahan kode/komentar di `src/` akan melewati budget. Baseline HEAD
  adalah 4123 KB, jadi pekerjaan ini menambah 4 KB. **Jangan naikkan budget**;
  pangkas komentar bila menambah kode.
- **Flake yang teramati lalu hilang**: pada run penuh pertama
  `cli-session.test.ts > PF-05` gagal di 5001 dtk (batas 5 dtk). Lulus saat
  dijalankan sendiri (1899 dtk) dan pada run final 0 fail — kelas flake beban
  suite di §4, bukan regresi.

| ID | Perbaikan | Bukti |
|---|---|---|
| AUD-001 | `scrimMode()`/`scrimSgr()` + `popupBoxWidth()` + glyph melengkung terpasang; plan dievaluasi & ditandai status | plan diperbarui §kepala |
| AUD-002 | `colorLevel()` memakai `getColorDepth()` (>=24 → 3, >=8 → 2) + `TERM=dumb` → 0 | `test/theme.test.ts` |
| AUD-003 | `applyBackdropDim`: bold DIPETAKAN ke scrim (bukan dibuang); `[22m` memulihkan scrim | `test/ui-audit-regressions.test.ts` (2 test, dengan TTY palsu) |
| AUD-004 | `dialogFrame` dipertahankan sebagai kompatibilitas (pemakai hanya test) | — |
| AUD-006 | `PICKER_BOX_W`/`MODAL_BOX_W`/`PROVIDER_BOX_W`/`FORM_BOX_W` dihapus → `popupBoxWidth()` | `test/tui-geometry.test.ts` |
| AUD-007 | `renderModal` mengirim `minWidth=maxWidth=popupBoxWidth(cols)` | `test/surface-audit-regressions.test.ts` |
| AUD-008 | `promptAskText` memetakan `"1".."n"` → teks opsi; teks bebas diteruskan | `test/surface-audit-regressions.test.ts` |
| AUD-009 | `paintRegion` memakai `truncateToWidth(row, this.cols)` | `test/screen.test.ts` |
| AUD-010 | `ask_user.ts` memakai `sliceSafeChars()` (tak membelah surrogate pair) | `test/surface-audit-regressions.test.ts` |
| AUD-011 | **TEMUAN BARU saat eksekusi**: `popupBoxWidth` lantai 40 membungkus clamp → terminal <44 kolom overflow. Margin kini menang | `test/surface-audit-regressions.test.ts` |

| AUD-005 | **Ini ditutup juga**: opsi approval kini daftar bernavigasi `↑↓`/`Home`/`End` + `Enter`, `Esc` = deny; ketik-cepat `y`/`a`/`n` (+`ya`/`selalu`/`s`/`tidak`/`t`) tetap berlaku. Satu pembaca `readModalInput` untuk mode `line`+`choice` | `test/approval-tui.test.ts` (6 test baru) |

**Tidak ada AUD yang terbuka.** `dialogFrame` (AUD-004) akhirnya **dihapus**
sebagai kode mati — pemakainya hanya test, dan test dimigrasikan ke
`dialogBox`; ini juga yang membuat `gate:pack` kembali muat.

### 6.4 PERINGATAN untuk agent berikutnya

Working tree saat catatan ini ditulis **memuat perubahan belum di-commit**
milik beberapa sesi sekaligus (`src/ui/render/theme.ts`, `src/ui/screens/dialog.ts`,
`src/ui/tui/app.ts` dari sesi lain + `approval/prompt.ts`, `tools/ask_user.ts`,
`runtime/screen.ts`, `screens/{picker,model-manager,provider-manager,form}.ts`,
test baru, dan dokumen). **Jangan commit sebagian** — lihat §3 jebakan
`git apply --cached` yang rapuh karena `core.autocrlf`. Jalankan gate penuh pada
kandidat yang sama sebelum menyebut apa pun hijau.

### 6.3 Catatan metode

- Audit **tidak mengubah kode**; semua temuan dari baca berkas + `grep` +
  banding dengan kontrak & plan.
- Gate tidak dijalankan ulang: working tree = HEAD bersih, jadi angka gate
  terakhir (`192e329`) yang berlaku. Bila kode berubah, **jalankan gate pada
  kandidat yang sama**.
- Temuan baru ditambahkan sebagai `AUD-007`, `AUD-008`, …
