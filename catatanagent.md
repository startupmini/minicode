# Catatan agent — audit UI/UX minicode (handoff)

> Ditulis: 2026-11-13, sesi agent audit UI/UX (`src/ui/`).
> Tujuan: serah-terima ke agent BERIKUTNYA. Seluruh perubahan di bawah **belum
> di-commit**. Jangan mengklaim repository hijau dari catatan ini — lihat
> [Verifikasi](#3-verifikasi-yang-sudah-dijalankan--dan-caveat-nya) untuk
> angka yang benar-benar dijalankan.

---

## 1. Status ringkas

- **Belum ada commit** dari sesi ini (permintaan awal "commit saat selesai"
  dibatalkan karena working tree tercampur dengan sesi lain yang **masih aktif
  menulis** — `git status` wajib dicek ulang sebelum commit apa pun).
- Audit UI/UX (temuan B1, A3, B3, B4, B5, D1 + pemasangan block logo) selesai
  dan terverifikasi pada tree per ±11:44. **B2 perlu dikonfirmasi** ke pemilik
  — statusnya tidak tercatat jelas di sesi ini.
- `temuan.md` (milik audit BERBEDA, sesi lain) **DIHAPUS atas instruksi pemilik**
  2026-11-13. Isinya tidak dipertahankan di mana pun.
- `gate:coverage` **belum pernah selesai** — lihat catatan sementara di
  `AGENTS.md`; berlaku penuh untuk agent ini.

## 2. Pekerjaan yang SUDAH selesai (milik sesi ini)

### Perubahan inti

| Temuan | Perubahan | File |
|---|---|---|
| **B1** hint minimalis | Helper baru `hintLine()` — format `kunci label` (kunci terang, label redup, pemisah `·`), dipasang di picker/model-manager/provider-manager | `src/ui/render/hint.ts` (baru), `src/ui/screens/{picker,model-manager,provider-manager}.ts` |
| **A3** glyph literal → jalur `glyphs` | `🔓` di teks i18n dipindah ke `glyphs.unlock` saat render; bullet `▪`/glyph verdict di transcript → `glyphs.bullet` (hunks glyph saja, lihat §5) | `cli/tui.ts`, `src/ui/tui/transcript.ts` (sebagian), `src/ui/i18n/{en,id}.ts` (sebagian) |
| **B3** lebar popup | `PROVIDER_BOX_W` 52 → **64**; `visibleRows` model/provider disesuaikan agar hint tak terpotong | `src/ui/screens/{model-manager,provider-manager}.ts` |
| **B4** Enter/Tab `/model` | **Enter = pilih satu langkah** (tanpa picker effort); **Tab = ubah effort** terpisah; Esc pada picker effort = batal effort saja (manajer tak menutup); `effort.saved` kini notice terlihat | `src/ui/screens/model-manager.ts`, i18n `effort.saved` |
| **B5** mask seragam | `glyphs.mask` (`•`, fallback `*`) sebagai satu-sumber untuk form & `askSecret` | `src/ui/render/theme.ts`, `src/ui/input/input.ts`, `src/ui/screens/form.ts` |
| **D1** lifecycle popup | `createIdleTimer()` (dua-fase, `unref`, `dispose` anti-bocor) menggantikan idle manual; `withTimeout()` di-share lewat `watchdog.ts` | `src/ui/screens/lifecycle.ts` (baru), `src/ui/screens/watchdog.ts` (baru), `{form,picker,model-manager,provider-manager,wizard}.ts` |
| **Logo** | Ganti SVG baru (CorelDRAW): grid **17 kolom × 9 baris sel** (75 polygon = 75 sel, sel seragam 495.18²). Render UTF-8 half-block = **5 baris × 17 kolom**; fallback ASCII (`MINICODE_ASCII=1`) = **9 baris × 17 kolom** `#`. `LOGO_WIDTH=17`, `LOGO_HEIGHT=9` | `src/ui/render/logo.ts` (baru), dipakai `src/ui/render/session-summary.ts` |

### Kontrak & test

- `docs/TERMINAL_CONTRACT.md` diperbarui: lebar provider 64 (invariant 20),
  format hint minimalis, Enter/Tab `/model` (invariant 25 + paragraf baru).
  **Kontrak FROZEN** — perubahan perilaku wajib begini + update peta test.
- Test diperbarui: `test/wizard.test.ts` (hint "Esc close"),
  `test/model-manager-flows.test.ts` (Enter/Tab B4),
  `test/tui-classic.test.ts` (hint provider "a add"/"Esc close").
- Insiden encoding `src/ui/screens/picker.ts` (terkorupsi CP1252 double-encode)
  sudah dibalik dan diverifikasi (tui-classic 46 pass). **Jangan pakai
  PowerShell `Get-Content -Raw` + `Set-Content` untuk file UTF-8 tanpa BOM** —
  pakai `[System.IO.File]::ReadAllText/WriteAllText` dengan `UTF8Encoding($false)`.

## 3. Verifikasi yang SUDAH dijalankan — dan caveat-nya

| Perintah | Hasil | Waktu (±) |
|---|---|---|
| `bun x tsc --noEmit` | bersih (0 error) | 11:40 |
| `bun run lint` | 696 file, 0 error (exit 0) | 11:41 |
| `bun test` (suite penuh) | **5682 pass / 26 skip / 0 fail** — 5708 test, 402 file, ~1182 dtk, exit 0 | 11:24–11:44 |
| `bun test` target (session-summary, render-audit, i18n) | 40 pass / 0 fail | 11:40 |

**CAVEAT PENTING:**

1. Suite penuh di atas berlaku untuk **tree per ±11:44**. Sesi lain menulis
   massif **11:51–13:10** (compaction/escalation/microcompact, vendor core,
   `src/config.ts`, `src/constants.ts`, i18n, `docs/environment.md`, dll.).
   **Angka di atas BASI untuk tree sekarang.** Agent berikutnya WAJIB menjalankan
   ulang `bun x tsc --noEmit && bun run lint && bun test` sebelum commit.
2. `bun run gate:pack` terakhir **23 pass / 0 fail** (313 file / 4044 KB) —
   dari state lebih awal (sebelum logo 17×9 final). Jalankan ulang.
3. `bun run gate:coverage` **TIDAK pernah selesai** di lingkungan ini. Jangan
   diklaim lulus; jangan turunkan ambang `scripts/coverage-gate.ts` atau
   naikkan budget `scripts/pack-budget.ts`.
4. Flake dikenal di bawah beban suite penuh (lulus terisolasi, jangan dikejar
   sebagai regresi): `tui-format.test.ts` (statusline),
   `recovery-side-effects.test.ts` (git subprocess),
   `supply-chain.test.ts` (`git_diff` textconv), `work-mode-cli.test.ts`
   (`exec --json --verify`), `writer-inventory.test.ts`,
   `concurrency-cross-process.test.ts` §32.
5. Laporan status wajib menyebut perintah yang benar-benar dijalankan; jangan
   menyimpulkan "repository hijau" dari run parsial.

## 4. Rencana commit (disetujui pemilik: DUA COMMIT, dipisah per-hunk)

> Pemilik memilih **"Pisah jadi dua commit"** sebelum memutuskan alih ke
> catatan ini. Agent berikutnya boleh mengeksekusi setelah tree stabil dan
> suite ulang lulus.

**Commit A — audit UI/UX (sesi ini):**

- File utuh: `cli/tui.ts`, `src/ui/input/input.ts`,
  `src/ui/render/session-summary.ts`, `src/ui/render/theme.ts`,
  `src/ui/screens/{form,model-manager,picker,provider-manager,wizard}.ts`,
  `test/{wizard,model-manager-flows,tui-classic}.test.ts`,
  untracked: `src/ui/render/{hint,logo}.ts`,
  `src/ui/screens/{lifecycle,watchdog}.ts`.
- **Per-hunk** (file tercampur — lihat §5):
  - `src/ui/i18n/en.ts` + `src/ui/i18n/id.ts`: HANYA hunk `hint.*`,
    `effort.saved`, `tui.unrestricted*`. JANGAN hunk `ts.compacted*`,
    `ts.contextWindowSource`, `ts.evictMarker`.
  - `docs/TERMINAL_CONTRACT.md`: semua hunk KECUALI perubahan teks
    `… baris awal di luar viewport` (evictMarker).
  - `src/ui/tui/transcript.ts`: HANYA hunk glyph bullet
    (`▪`/verdict → `glyphs.bullet`). JANGAN hunk `compactedLabel`.
- **Perlu konfirmasi dulu**: `src/ui/tui/app.ts` (perbaikan salin seleksi tanpa
  `.trim()`) — waktu tulisnya sama dengan berkas sesi ini (11-12 20:23) dan
  topiknya UI, tapi tidak tercatat eksplisit di ringkasan sesi. Cek diff-nya,
  kalau memang milik audit ini masukkan ke Commit A.

**Commit B — alur context-window/kompaksi (sesi LAIN):** sisanya —
`src/app/session.ts`, `src/config.ts`, `src/constants.ts`,
`src/policy/{context-window,context-budget,context-escalation,microcompact,compaction}.ts`,
`src/providers/{detect,provision}.ts`, `vendor/minicore/src/core/*`,
`cli/setup.ts`, `docs/{plan-context-window.md,environment.md}`, untracked
`src/policy/*` + `test/{context-*,microcompact,compaction-limits,control-plane,provider-audit}*`.

⚠ **Sesi lain masih aktif menulis file Commit B.** Jangan commit alur mereka
tanpa konfirmasi mereka/pemilik; kalau sesi itu sudah selesai dan meminta,
biarkan mereka commit sendiri.

## 5. Peta file CAMPURAN (wajib staging per-hunk)

| File | Hunk milik Commit A (audit UI/UX) | Hunk milik Commit B (context-window) |
|---|---|---|
| `src/ui/i18n/en.ts` | `hint.*`, `effort.saved`, `tui.unrestricted*` (hapus 🔓 dari teks) | `ts.compactedNoOp/Fixpoint/Impossible/LlmFailed`, `ts.contextWindowSource`, `ts.evictMarker` |
| `src/ui/i18n/id.ts` | sama seperti en | sama seperti en |
| `src/ui/tui/transcript.ts` | hunk glyph: consequence verdict, `context cutoff`, `context window`, `task` → `glyphs.bullet` | hunk `compactedLabel()` (jujur soal no-op/fixpoint/impossible/llm-failed) |
| `docs/TERMINAL_CONTRACT.md` | lebar provider 64, paragraf hint minimalis + Enter/Tab, invariant 20 & 25 | hunk teks evictMarker `… baris awal di luar viewport` |

Cara termudah: `git diff -- <file>` → pecah per-hunk (indeks 1-based) →
`git apply --cached` patch berisi hanya hunk Commit A. Contuh tooling pemecah
hunk dipakai sesi ini di
`C:\Users\zo\AppData\Local\Temp\opencode\split-diff.ts` (ikut hapus bila sudah
tidak perlu).

## 6. Jebakan yang PERLU diingat (semua pernah jadi bug nyata)

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
  `test/render-audit-2026-11.test.ts` (tidak ada assert lebar hard-coded saat
  ini — kalau logo diganti lagi, cek keduanya).
- Batas lapisan dijaga `test/ui-boundary.test.ts` — ubah struktur dependensi
  antarlapisan → wajib update `docs/architecture.md`.
- Komentar Indonesia, jelaskan **mengapa**. UTF-8 tanpa BOM.
- Jangan commit kecuali diminta; jangan pernah commit rahasia.

## 7. Scope klaim hasil (ringkas, dari AGENTS.md)

- Laporan stage-scoped hanya boleh mengklaim scope yang benar-benar divalidasi.
- Menutup track Quality Remediation atau mengumumkan release-readiness tetap
  mensyaratkan seluruh gate akhir lulus pada satu kandidat final yang sama.
- Angka hasil historis (termasuk tabel di §3) tetap **historical** — sebutkan
  checkpoint-nya, jangan menyebutnya sebagai hasil sekarang.
