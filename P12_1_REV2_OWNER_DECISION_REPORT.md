# MINICODE P12.1 REV-2 — LAPORAN KEPUTUSAN PEMILIK

**Peran:** Agent A (satu agen, tanpa delegasi). Design-only di direktori
review temporer; repository tidak berubah (diverifikasi `git status`
bersih, HEAD `93f4179`). Artefak:
`P12_1_ARCHITECTURE_DECISION_PACKAGE_REV2.md`; REV-1 + laporan diff-nya
dipertahankan tanpa overwrite.

## 1. Persetujuan arah pemilik D-1…D-7 (2026-10-18, `OWNER APPROVED — DIRECTION`)

| ID | Arah yang disetujui (ringkas) |
|---|---|
| D-1 | WorkMode ⊥ PermissionMode; awal DISCUSS/PLAN/EXECUTE; lapis intent tipis (bukan engine duplikat); tanpa eskalasi implisit; DISCUSS read-only; PLAN kontrak lama; EXECUTE ikut PM; kompat 6 PM; matriks REV-1 = baseline arah |
| D-2 | Mode tidak dipersist otomatis; refactor tanpa perubahan perilaku; K-1 wajib dipertahankan |
| D-3 | `readonly` di luar picker; policy terinjeksi tak lemah via `/mode`/Shift+Tab/sub-agen/jalur lain; WorkMode tak mencabut restriksi policy |
| D-4 | Registry kanonik anti-drift; keputusan observable terjaga; boundary tetap; replay + regression membuktikan setara |
| D-5 | Vendor boleh diubah **bila bukti mengharuskan** (bukan demi kerapian); prasyarat: bukti app-layer tak memadai + kontrak interface + tes boundary |
| D-6 | Observability eksisting dipertahankan dulu; perluasan = keputusan + tes kompatibilitas terpisah |
| D-7 | Rencana di atas baseline terdokumentasi; focused baseline per slice; berhenti pada kegagalan baru tak terjelaskan; tanpa klaim strict-green; tanpa full suite/gate mahal di tugas dokumen |

## 2. Detail PENDING dan BLOCKED

**PENDING — IMPLEMENTATION DETAIL:** validasi replay 18 sel matriks;
permukaan WorkMode (flag/env/picker/label/transisi eksplisit); semantik
`always` (masa berlaku/cakupan/lokasi); tes bypass D-3; bentuk final
registry + suite replay; patch vendor spesifik; perluasan event denial/UI;
kriteria berhenti konkret per slice.

**BLOCKED:** implementasi WorkMode (sampai S1 siap); refactor registry
(sampai S1 hijau + desain no-behavior-change); setiap edit
`vendor/minicore` (sampai bundle bukti D-5; pemicu kandidat: temuan S3 di
`src/daemon/**` yang belum diverifikasi); perubahan persistensi/`always`;
perubahan kontrak observability; menandai P12 "started".

## 3. Koreksi K-1 & semantik persistensi `always`

`always` = sessionGrants in-memory **PLUS** tulis persisten ke
`.minicode/allowlist.json` repo-lokal (`permission.ts:272`;
`allowlist.ts:41-52`, default LOCAL; satu-satunya caller). Global
`~/.minicode/allowlist.json` tanpa penulis kode (manual). Read-back lokal
hanya dengan `--allow-local-config` — entri repo-lokal inert secara default.
Pemisahan tiga state (mode runtime tanpa persist / grant-cache runtime mati
bersama proses / penyimpanan persisten) dipertahankan; refactor tanpa
perubahan perilaku wajib menjaga semantik eksisting; perubahan semantik
`always` = keputusan terpisah, tetap PENDING.

## 4. Perubahan REV-1 → REV-2

1. Status semua D-1…D-7: PENDING/ODR → **OWNER APPROVED — DIRECTION**
   (arah), dengan detail implementasi dipisah ke PENDING.
2. Model status tiga lapis diperkenalkan + ledger diperinci (§3 paket).
3. Tabel keputusan diformat 5 kolom (ID / arah / status arah / detail
   tersisa / menghalangi apa).
4. Aturan konflik matriks ditambahkan (sel benturan kontrak lama →
   dilaporkan, tidak diubah diam-diam).
5. Rencana S1 diuraikan penuh (berkas diperluas/baru, kondisi awal,
   expected behavior, detektor mutasi, perintah fokus) — tanpa implementasi.
6. S3 (parity, daemon prioritas) dan S4 (registry bersyarat) dirumuskan
   sebagai tindak lanjut terjadwal.
7. Tanpa perubahan semantik: matriks, invariant INV-WM1…4, dan K-1 tetap
   identik REV-1.

## 5. Rencana S1 (contract tests — TIDAK diimplementasikan)

| # | Berkas | Jenis | Inti | Detektor mutasi (harness `scripts/p12-mutation.ts`, gaya `phase6z-mutation.ts`) | Perintah fokus |
|---|---|---|---|---|---|
| 1 | `test/permission-matrix.test.ts` (eksisting, 9 test) | Perluasan | Kasus tepi jail di matriks 6×37; anchor 37-nama tetap (ganti = S4) | M1 jail-mendahului-mode dilepas; M2 bash-guard allow-all dilepas; M3 ekstra plan dihapus | `bun test test/permission-matrix.test.ts` |
| 2 | `test/delegate-audit.test.ts` (eksisting, 17 test) | Perluasan | Parent `ask` → anak forced-explore eksplisit; mapping `:449` | Hapus cabang `ask` di `forcedExplore` → merah | `bun test test/delegate-audit.test.ts` |
| 3 | `test/permission-contract.test.ts` | Baru (usulan) | Headless deny; abort→deny; allow-all bash-guard; `describeDenial` baca-sekali; perekaman K-1 (tulis repo-lokal, inert default, aktif dengan opt-in); kunci allowlist penuh | M4 tulis diarahkan ke global → merah; M5 default `allowLocal:true` → merah | `bun test test/permission-contract.test.ts` |
| 4 | `test/resume-permission.test.ts` | Baru (usulan) | Mode dihitung ulang saat resume; grant mati bersama proses; satu-satunya lintas-proses = berkas allowlist | M6 persist mode (hipotetis) → merah | `bun test test/resume-permission.test.ts` |

Disiplin D-7: focused baseline sebelum/sesudah; `bun x tsc --noEmit` pada
berkas terdampak; berhenti pada kegagalan baru tak terjelaskan; full
suite/gate mahal tidak dijalankan di tugas ini maupun dicatat sebagai
syarat S1.

## 6. Risiko, gap bukti, dan verdict

- Matriks 18 sel design-verified, belum replay-proven (S1/S2) — aturan
  konflik mengikat.
- `src/daemon/**` unverified — gerbang keputusan patch vendor D-5.
- Fakta QA dipertahankan: `gate:pack` FAIL, `gate:coverage` FAIL (13 gagal;
  lantai kritis 19/19 hijau), pemeriksaan NOT RUN, selisih 14 vs 13
  kegagalan belum direkonsiliasi — tanpa klaim strict-green.
- Niat "IDE auto tanpa ask" (ACP) butuh konfirmasi pemilik.
- ADR historis hanya komentar kode (S0 opsional).

**Verdict: `READY FOR NEXT IMPLEMENTATION REVIEW`**
