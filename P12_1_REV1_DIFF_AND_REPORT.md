# MINICODE P12.1 REV-1 — LAPORAN REVISI & DIFF

**Peran:** Agent A, design-only (satu agen, tanpa sub-agen). Tidak ada
perubahan repo/commit/push/fetch; tidak ada test/gate mahal dijalankan.
Artefak: `P12_1_ARCHITECTURE_DECISION_PACKAGE_REV1.md` (paket revisi).

## 1. Verifikasi sumber (syarat sebelum melanjutkan)

- `P12_1_ARCHITECTURE_DECISION_PACKAGE.md` (23.946 B) dan
  `P12_ENTRY_GATE_AND_SCOPE_AUDIT.md` (21.317 B) **ditemukan utuh** di
  `…\Temp\opencode\p12-entry-gate\`.
- P11 **sudah ditutup** sejak baseline paket: `main == origin/main ==
  93f4179` (fast-forward `609a417 → … → 3d946bc → 93f4179`, semuanya
  dokumen-only; `P11_PHASE_CLOSURE_REPORT.md` kini ter-track dengan status
  `COMPLETE WITH DOCUMENTED LIMITATIONS (OWNER APPROVED 2026-10-18)`).
  Angka baseline D-7 (13 gagal / 28 tsc / 603 lint / gate FAIL) tetap sah
  karena `609a417..93f4179` mengubah 0 berkas non-`.md` — semua kutipan
  kode diverifikasi ulang pada HEAD ini.
- "Work Mode"/"DISCUSS" tetap **nol hasil** di `src/`+`cli/` — gap D-1 valid.

## 2. DIFF ringkas sebelum → sesudah

| Area | Baseline (P12.1) | REV-1 |
|---|---|---|
| D-1 taksonomi | Alternatif A/B/C umum; contoh intent `plan-work/explore/execute`; status PENDING | Taksonomi tetap **DISCUSS/PLAN/EXECUTE** dengan definisi ceiling + 4 invariant (INV-WM1…4); DISCUSS dipetakan ke enforcement `readonly` yang sudah ada (tanpa engine baru); status ODR (direktif A) — rumusan PENDING |
| D-5 vendor | A (tanpa edit vendor); B "hanya bila bukti P12.3" | Evaluasi eksplisit terhadap direktif B: kernel mode-agnostic (`executor.ts:25,81`), satu handler terinjeksi, semua sesi via `app/session.ts:139-169` → **B tidak dibutuhkan desain ini**; B disimpan sebagai opsi bersyarat (bukti daemon/P12.3); status ODR (direktif B) — rumusan PENDING |
| Penemuan K-1 | Klaim "`always` in-memory saja, bukan disk" | **KOREKSI:** `saveAlways` menulis persisten ke `.minicode/allowlist.json` repo-lokal (`permission.ts:272`; `allowlist.ts:41-52` default LOCAL; tak ada penulis global di kode). Inert default (butuh `--allow-local-config`) — sub-keputusan baru D-2, revisi T-3, perluasan AC-6 |
| Matriks | Tidak ada matriks WorkMode×PermissionMode | Matriks 18 sel; baris EXECUTE = identitas penuh (jangkar nol-diff); DISCUSS×* ≡ enforcement readonly; PLAN×{auto,ask,allow-all} ≡ `--plan` hari ini |
| Ancaman | T-1…T-7 | +T-8 (transisi posture implisit; INV-WM4), T-2bis (label confusion), T-3 direvisi (K-1), T-5 dipertajam sebagai gerbang D-5-B |
| Enforcement flow | Tanpa WorkMode | Intersection di composition root; predikat `shouldRunHooks` dicatat rapuh terhadap posture non-PM |
| AC | AC-1…AC-8 | +AC-9 (DISCUSS: nol tulis, nol prompt, hooks mati, nol transisi non-operator); AC-3R (matriks jadi fixture replay); AC-6R (pre-poisoned repo allowlist) |

## 3. Semantik yang diusulkan (inti)

- WorkMode = posture + ceiling; PermissionMode tetap satu-satunya kata kerja
  enforcement; otoritas efektif = irisan semua lapis (WorkMode hanya
  memperketat — INV-WM1/2).
- DISCUSS: baca-saja, tanpa approval prompt, hooks mati, **tanpa transisi
  implisit** ke PLAN/EXECUTE maupun pelonggaran mode (direktif A terpenuhi).
- Sesi injected (6S/sub-agen) tidak tersentuh pemetaan (6U/F-07 utuh).

## 4. Keputusan & status pemilik (REV-1)

D-1 **ODR (A)** rumusan PENDING · D-5 **ODR (B)** rumusan PENDING ·
D-2 PENDING (koreksi K-1 + pertanyaan berkas "always") · D-3 PENDING
(DISCUSS mewadahi readonly-pilihan) · D-4/D-6/D-7 PENDING (tak berubah).
Direktif ≠ persetujuan final; rekomendasi ≠ keputusan.

## 5. Batas kepatuhan

Design-only; repo tidak diubah; tidak ada staging/commit/push/fetch/reset/
rebase; tidak ada suite/gate dijalankan; P12 tidak ditandai dimulai; daemon
dan gap bukti lain dilaporkan apa adanya tanpa mengarang fakta.

## 6. Verdict

**`READY FOR OWNER DECISION`** — dua direktif pemilik telah diserap ke D-1
dan D-5; satu koreksi faktual (K-1) ditemukan lewat verifikasi kode; tidak
ada blocker bukti yang menggagalkan pengambilan keputusan.
