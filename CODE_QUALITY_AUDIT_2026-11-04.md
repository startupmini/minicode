# Audit Kualitas Kode & Types — 2026-11-04 (ulangan penuh, v2)

**Cakupan:** seluruh codebase — `src/` `cli/` `test/` `bench/` `scripts/` `vendor/` (653 berkas TS, ±2.210 tepi impor)
**Mode:** read-only · **Checkpoint:** HEAD `cb60212` (v0.13.1) + working tree (64 modified, 98 untracked)
**Laporan ini menggantikan versi v1** — siklus impor diverifikasi ulang dengan algoritma SCC (Tarjan) di graf terpisah (semua-tepi vs value-only), dan ada bagian **Audit Types** baru (§3) dengan probe flag kompiler di luar `tsconfig` yang berlaku.

> Ruang lingkup klaim: audit-scoped pada working tree 2026-11-04. Bukan pernyataan release-readiness.

---

## 1. Hasil Gate (urutan AGENTS.md, dijalankan penuh pada checkpoint yang sama)

| Gate | Hasil | Angka |
|---|---|---|
| `bun x tsc --noEmit` | ✅ | 0 error |
| `bun run lint` (biome) | ✅ | 657 berkas diperiksa, 0 temuan |
| `bun test` | ⚠️ | 5409 pass · 19 skip · **2 fail** (1090,76s) — flaky under-load, lihat §2.1 |
| `bun run gate:coverage` | ✅ | funcs **88,10%** (min 87) · lines **88,92%** (min 86) · lantai per-berkas 19/19 hijau |
| `bun run gate:pack` | ✅ | 3839 KB vs budget 3840 KiB — **margin 1 KiB**, lihat §4 |
| `bun run audit:harness` | ✅ | pass |
| `bun run gate:bash` | ✅ | pass (probe bypass + mode allowlist) |
| `bun run bench:smoke` | ✅ | pass |
| `bun run vendor:check` | ✅ | vendor/minicore sinkron VENDOR.md (20 file, `c8d214bb8d5eea86`) |
| `git diff --check` | ✅ | bersih |

## 2. Temuan Fungsional

### 2.1 Dua tes flaky (satu-satunya merah)
Gagal di full-suite, **dua-duanya lulus saat dijalankan per-berkas** (diverifikasi ulang sesi ini):

1. `test/coverage-gaps.test.ts:93` — *"memory tools: write → read → forget (empty query path)"*: timeout 5076ms/5000ms. Run tunggal: seluruh berkas 966ms. → tekanan schedul full-suite (366 berkas) + I/O tmpdir Windows.
2. `test/model-manager-flows.test.ts:106` — *"lebar kotak TETAP 64…"*: assertion geometri setelah cycle effort-picker; run tunggal 24 pass/3,87s. → race `waitForOutput` vs output session writer lain / timing kunci (`enter,30ms` `esc,80ms`) terlalu ketat.

**Rekomendasi:** naikkan timeout targeted untuk (1); pada (2) ganti wait-by-duration dengan wait-for-state atau isolasikan scrollback harness. Jangan turunkan ambang gate.

### 2.2 Tes skip — legitim
19 skip seluruhnya `describe.skipIf(!gitAvailable)` (9 lokasi: shadow-git, repo-git-trust, supply-chain, dsb.) — kondisional lingkungan, bukan penghindaran. 0 `test.todo`, 0 `.skip` permanen, 0 assertion trivial `expect(true)`.

### 2.3 Hygiene working tree
±70 debris root untracked tak ter-ignore (`a*.txt`, `b*.txt`, `out-*.txt`, `gate-*.txt`, `hb*.txt`, `t.log.*`, `pack-dry.json`, `.tmp-probe.ts`, `git-status-snapshot.txt`); kandidat commit sah: `src/policy/approval-binding.ts`, `src/ui/session-state.ts`, 8 tes baru, 7 laporan `docs/audit/`.

---

## 3. Audit Types

### 3.1 Postur tsconfig — sangat ketat (kekuatan utama)
`strict` + `noUnusedLocals` + `noUnusedParameters` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `skipLibCheck`. Ini menjelaskan kenapa `as any` = 0 dan pola unknown-narrowing sehat (**`: unknown` = 510** kemunculan di src+cli).

### 3.2 Probe flag di luar postur berlaku (dijalankan read-only, BUKAN kegagalan gate)

| Flag | Hasil | Penilaian |
|---|---|---|
| `--noImplicitOverride` | **4 error TS4114** — `src/app/provider-layer.ts:16`, `src/policy/no-progress.ts:43` (override member `Error` tanpa modifier), +2 di vendor | **Worth adopting**: murah (tambah `override` di 2 lokasi src), mencegah bug rename-basis-kelas. Vendor di luar seam. |
| `--noImplicitReturns` | **2 error TS7030** — `cli/tui.ts:402` (`submit()` jalur if/else tanpa `return` eksplisit), `test/tui-app.test.ts:51` (fixture) | Latent-intent risk kecil di `tui.ts`; adopsi butuh refactor callback tes. Opsional. |
| `--noFallthroughCasesInSwitch` | 0 error (gabungan run: tidak menambah temuan sendiri) | **Gratis diadopsi** — pagar proteksi aktif tanpa biaya. |
| `--noPropertyAccessFromIndexSignature` | 1937 error TS4111 | Terlalu mahal, gaya saja — **jangan** diadopsi. |
| `exactOptionalPropertyTypes` | tidak diprobe (diprediksi ribuan; out-of-scope audit ini) | Jangka panjang. |

### 3.3 Pelarian tipe (type escape) — persis per berkas
- `as any` / `@ts-ignore` / `@ts-nocheck`: **0** di seluruh src+cli. ✅
- `@ts-expect-error`: **3** — `test/fuzz-prompt.test.ts:85`, `test/telemetry-privacy.test.ts:56`, `scripts/phase6ad-probe.ts:1151`. Semuanya di jalur tes/probe + punya pesan (benar-betul "expected"). ✅
- `as unknown as`: **66** di src+cli, tersebar 37 berkas. Konsentrasi: `src/ui/tui/app.ts` 7, `src/providers/router.ts` 5, `src/app/provider-layer.ts` 4. Pola wajar untuk cast bentuk payload provider/DOM-ish, tapi ini **kandidat penyisiran targeted berikutnya** — tiap cast = klaim tanpa bukti; tidak ada yang di-assert dengan guard runtime (§4.4).
- `as never`: **10** — `cli/setup.ts:3055-3065` (3, injeksi DI lintas lapisan), `src/policy/work-mode.ts` (3, deps privat), `src/lib/net.ts:102`, `src/session/full-history-fold.ts` (2), `src/task/sync.ts:243`, `test` (fixture). Semuanya batas lapisan/ke-butaan-tipe-API-nodes, bukan penyembunyian bug.
- `: any` eksplisit: **3** — `src/mcp/client.ts:327` (konten MCP peer, tak tepercaya), `src/presentation/events.ts:600` & `src/ui/contract.ts:70` (tipe handler event bus). Yang MCP sebaiknya dipersempit ke union bentuk konten; dua lainnya API desain.
- Non-null assertion `!`: pola ketat (`x!` menempel) = **49**; longgar (termasuk `!` di akhir akses) ≈ **145** di 54 berkas. Mayoritas `arr[i]!` yang *sudah* dibound-check (konsekuensi `noUncheckedIndexedAccess`). Titik bergantung peer/privat: `src/mcp/server.ts` `msg.id!` ×10, `src/lsp/client.ts:146` `stdout!`, `src/mcp/client.ts:184` `stdio!`, `cli/setup.ts:2985` `runtime()!`. Rendah–sedang risikonya; tidak ada `!` pada input jaringan mentah.
- `biome-ignore`: **29**, semuanya beralasan + berkomentar (fixture string serangan, regex control-char sanitasi, poke field privat). Tidak ada suppress diam-diam. ✅

### 3.4 Siklus impor — verifikasi graf penuh (Tarjan SCC), 2 graf
Graf semua tepi (2210 edges, 653 nodes): **2 SCC** —
1. `src/task/{store,sync,identity}.ts ↔ src/tools/todo.ts`
2. `src/ui/i18n/locale.ts ↔ src/ui/i18n/id.ts`

Graf **value-only** (tepi `import type` dihapus — yang terhapus saat kompilasi): **0 SCC, 0 self-loop.**

➡️ **Kesimpulan definitif:** tidak ada satu pun siklus nilai runtime — semua siklus bergantung sepenuhnya pada tepi type-only → **TDZ-saat-runtime tidak mungkin** pada build saat ini. Ini **lebih kuat** dari klaim v1 (yang menyebut `locale→id` dan `sync→identity` sebagai VALUE; setelah pemisahan per-modifier, loop lengkapnya tidak tertutup di graf nilai). Catatan rapuh tetap berlaku: satu perpindahan specifier bernilai (mis. `{ TaskStore }` menjadi impor biasa, `en/id` jadi value) dapat menutup loop — **pagar tes "cycle edges must remain type-only" tetap diusulkan** agar proteksi jadi eksplisit.

### 3.5 Batas lapisan — 0 pelanggaran
Diverifikasi pada graf impor penuh: `src/` non-ui → `src/ui/` = **0**; `src/ui/` → `cli/` = **0**. Konsisten dengan `test/ui-boundary.test.ts`. ✅

---

## 4. Temuan Kualitas Kode Non-Type

### 4.1 `catch {}` kosong: **331** (src 275 · cli 56)
Mayoritas fail-soft disengaja (teardown, best-effort fs, sanitize). Tidak ditemukan catch yang menelan error finansial/keamanan pada sampel hotspot. Terbesar: `cli/setup.ts` 28, `src/memory/vector.ts` 16, `src/runtime/execution-backend.ts` 7, `src/repo/repomap.ts` 6. **Saran standar:** satu komentar "mengapa diam" untuk catch yang bukan teardown; jangan ubah jadi lint gate dulu (bising).

### 4.2 Hotspot ukuran (jalur modul kritis coverage-gate)
`src/session/persistence.ts` 3.736 · `cli/setup.ts` 3.384 · `src/task/store.ts` 2.747 · `src/session/journal.ts` 1.981 · `src/memory/vector.ts` 1.634 · `src/session/verification.ts` 1.533 · `src/ui/tui/app.ts` 1.349. Bukan cacat; konsekuensi: perubahan di sini wajib gate penuh.

### 4.3 Pola bersih (ulang scan sesi ini)
0 `process.cwd()` di jalur tool · 0 `eval`/`new Function`/`execSync`/`spawnSync`/`execFileSync` di src+cli · 0 `require()` CommonJS · 0 `console.log` di `src/ui/` · 0 rahasia/key hardcoded · komentar `TODO/FIXME/XXX` = 7.

### 4.4 Budget paket — dokumen kontrak basi (tindakan pemilik)
`scripts/pack-budget.ts` resmi **3840 KiB** (re-baseline 3,75 MiB, disetujui owner 2026-10-31, commit `29d121f`). `AGENTS.md:85` masih tertulis **3.584 KiB** — tidak disinkron saat re-baseline → pembaca AGENTS.md akan salah vonis `gate:pack` over-budget. Aktual 3839 KB: **margin 1 KiB**, pertumbuhan fitur berikutnya hampir pasti menabrak. Tindakan: sinkronkan AGENTS.md + siapkan diskusi re-baseline sebelum over.

### 4.5 Roadmap & vendor
`ROADMAP.md` tracked (masuk `677d77d`) tapi checkpoint internalnya (`2d9e11e`) stale vs HEAD — melewati 4 commit termasuk rilis 0.13.0/0.13.1; sinkron master pemilik diperlukan sebelum klaim posisi fase. `vendor:check` hijau; fallback vendor tanpa `../minicore` sudah didokumentasikan skripnya.

---

## 5. Prioritas Tindak Lanjut (revisi v2)

| # | Aksi | Alasan | Biaya |
|---|---|---|---|
| 1 | Sinkron `AGENTS.md` → budget 3.840 KiB + rujuk `29d121f` | dokumen kontrak salah = salah-tafsir gate | 5 menit |
| 2 | Adopsi `noFallthroughCasesInSwitch` (0 error) + `noImplicitOverride` (2 titik src) | pagar tipe gratis/murah | <1 jam |
| 3 | Perbaiki 2 tes flaky §2.1 | sinyal full-suite harus bisa dipercaya | 1–2 jam |
| 4 | Pagar tes "cycle edges must remain type-only" (2 SCC §3.4) | proteksi TDZ jadi eksplisit | 1 jam |
| 5 | Bersihkan ±70 debris root sebelum commit §2.3 | hygiene riwayat | 15 menit |
| 6 | Sinkron `ROADMAP.md` ke HEAD | otoritas status fase | milik pemilik |
| 7 | (Berkala) sisir 66 `as unknown as` §3.3 + persempit `any` di `src/mcp/client.ts:327` | hapus klaim tipe tanpa guard | bertahap |
| 8 | (Berkala) komentar alasan pada `catch {}` non-teardown §4.1 | auditabilitas | bertahap |

**Vonís keseluruhan:** tipe **sehat di atas rata-rata** — postur strict penuh, nol `as any`, siklus runtime nihil (terbukti via SCC value-only), boundary nol, 1937-error index-signature justru bukti disiplin unknown-narrowing. Risiko nyata tertinggi justru **non-tipe**: margin pack 1 KiB + dokumen budget basi, dua flaky test, dan working tree 162 berkas belum commit.

*Repro: `bun x tsc --noEmit` · `bun run lint` · `bun test` · `bun run gate:coverage` · `bun run gate:pack` · `bun run audit:harness` · `bun run gate:bash` · `bun run bench:smoke` · `bun run vendor:check` · probe flag §3.2 · skrip SCC graf impor (Tarjan, value-only vs semua-tepi) · scan pola §3.3–4.3.*
