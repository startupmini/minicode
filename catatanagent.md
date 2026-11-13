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
