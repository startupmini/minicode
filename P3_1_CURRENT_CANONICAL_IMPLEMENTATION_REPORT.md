# P3.1 — Current Canonical Implementation Report (Retarget)

Status: **VALID (core invariant) dengan dua extended gap terdokumentasi**.
Historical FORM dinyatakan SUPERSEDED oleh arsitektur P2.7 + P3.2 current;
stash `6bcd15f` tidak disentuh (tidak pop/apply/cherry-pick); tidak ada API lama
yang dihidupkan; tidak ada store/cache/sidecar/authority baru; tidak ada berkas
legacy yang disentuh; kerja hanya di canonical. Perubahan uncommitted di working
tree (laporan ini mencatat; keputusan commit milik owner):
`cli/setup.ts` (+10), `src/session/persistence.ts` (+37/-2),
`test/p3-reconciliation-guard.test.ts` (rewrite), `docs/ARCHITECTURE.html` (+3/-1),
`P3.1_IMPLEMENTATION_REPORT.md` (header supersession).

## 1. Baseline

HEAD `ff67b47`, main, origin=GitHub in sync; baseline bersih kecuali deliverable
audit (`P3.1_CURRENT_CANONICAL_TRUTH_AUDIT.md`, untracked). P3.1 = PARTIAL per audit:
refusal append-only enforced P2.7; FORM historis hanya di stash + guard test mati di
import (0/14 executable). P3.2 live; P3.3 CAN PROCEED (tetap berlaku sesudah retarget).

## 2. Historical P3.1 vs Current P3.1

| Aspek | Historis (laporan/stash) | Current (main, sesudah retarget) |
|---|---|---|
| Putusan publikasi | pre-write gate + klasifikasi (`assessHistoryPublication`) | prefix-check + epoch/run gates di dalam txn `saveSession`; throw = tolak |
| Penolakan divergensi | `DIVERGED` + `refusePublication` + `RECONCILIATION_CONFLICT` | `RefusedHistoryRewriteError` (P2.7); kanal `diagnostic.raised` ada tanpa kategori konflik |
| Attach | `SessionAttachRefusedError` pada id berhistori | reuse melanjutkan (saveSession-level); konflik identitas ditolak (`SessionNotFoundError`/`SessionAliasError`); tanpa history-presence gate (gap) |
| Rute shrink | dihapus dari composition (klaim historis) | ada dan eksplisit: catch → terminal-mark → `shrinkThreadHistory` ber-provenance; DITAMBAH penolakan shrink-otomatis bila kanonik tumbuh (I2, temuan retarget §5) |
| Test executable | 0/14 (import mati) | 14/14 hijau, semua via production path nyata |
| Klaim `tsc 0` / `pack 22/23` historis | tidak cocok tree | `tsc` 37 → 28 (9 error guard hilang, 0 baru); pack tetap 21/23 pre-existing |

## 3. Current Contract (yang diuji)

ACCEPT: `[A,B,C]` + `[D,E]` → append, prefix utuh, event_id lama stabil, baris baru
ber-id fresh. IDEMPOTENT: publikasi identik = no-op (tanpa baris/turn/mutasi baru).
REFUSE-divergence/deletion/reorder/fold: throw SEBELUM mutasi kanonik; fingerprint
(isi+identitas+posisi) utuh. REFUSE-grown: buffer yang merupakan prefix sejati dari
kanonik yang tumbuh = TOLAK-JUJUR (flag basi + note), JANGAN shrink otomatis.
STALE-WRITER: epoch pindah → `StaleWriterError` → flag jujur + exit jujur, tanpa retry
buta. Tanpa overwrite/reconcile diam-diam; histori kanonis satu-satunya authority;
konteks runtime disposable.

## 4. Test Migration / Re-targeting

14 test guard direklasifikasi ulang (bukan diperbaiki importnya saja):

| Test | Klasifikasi | Bentuk current |
|---|---|---|
| A append + event_id | valid, dipertahankan | `saveSession` langsung |
| B divergence | rewrite P2.7 + bridge P3.2 | refusal + fingerprint + DIVERGED rentang-tumpang-tindih |
| C del/reorder/replace | rewrite P2.7 | 3 refusal + fingerprint utuh |
| C2 folded | rewrite P2.7 + bridge P3.2 | refusal + STALE (view basi tak publikasi) |
| D prefix-extension | valid, dipertahankan | `saveSession` langsung |
| E idempotent | rewrite (buang assess) + bridge P3.2 | no-op + tanpa turn hantu + EQUAL |
| F klasifikasi | rewrite P3.2 (tanpa menduplikat P2.7) | EQUAL/no-op, advance/accept, DIVERGED/refuse, UNKNOWN-deskriptif |
| G attach | rewrite ke current truth | reuse lanjut + unknown-resume ditolak + fresh boleh; gap didokumentasikan |
| G2 empty-row | rewrite (COUNT langsung) | tanpa gate; resolve tidak melempar |
| P1 folded via persist | rewrite ke current truth | shrink eksplisit ber-provenance (flags), tanpa replace mentah |
| P2 valid via persist | dipertahankan minus conflict-surface | append + tanpa throw |
| P4 grown-canonical | rewrite ke current truth + fix I2 | INTACT + flag basi (gagal sebelum fix) |
| P5 epoch take-over | dipertahankan minus conflict-surface | stale + note + kanonik utuh |
| P3 CLI probe | rewrite ke current truth | reuse = shrink eksplisit ber-flag; resume = append |

Nol referensi executable ke API basi (grep §9); dua baris komentar header menyebut
daftar superseded secara eksplisit (ditandai historis, sesuai Step 8).

## 5. P2.7 Production-Path Proof

Temuan nyata selama retarget (probe TEMP di luar repo, sebelum fix): buffer basi
`[A,B]` vs kanonik `[A,B,C-other]` → `persistCurrent` men-shrink diam-diam menjadi
`[A,B]` (baris penulis lain HANCUR, `isWriterStale=false`). Ini pelanggaran I2
("tak ada shrink otomatis") dalam bentuk baru. Fix minimal (audit-proven, 2 berkas):
`RefusedHistoryRewriteError` membawa `grewBeyondBuffer` (dihitung di titik throw
dari data yang sudah ada — kanonik lebih panjang DAN buffer = prefix sejati stored);
cabang catch di `persistCurrent` menolak-jujur (`markWriterStale` + note + return)
pada kasus itu, tanpa menyentuh hot path prefix-loop, tanpa mengubah keputusan
throw `saveSession`, tanpa mengubah `shrinkThreadHistory` eksplisit. Semantik P2.7
utuh: lipatan/divergensi (bukan prefix) tetap menempuh shrink eksplisit (dibuktikan
P1 hijau). Bukti khasiat: probe sama pasca-fix → INTACT + flag + note.

## 6. P3.2 Semantic Coverage

Test F + jembatan di B/C2/E membuktikan kesepakatan dua lapis independen:
EQUAL ⇔ no-op; advance ⇔ accept; DIVERGED ⇔ refuse; STALE ⇒ tak publikasi apa adanya.
Kasus melampaui-head yang valid-append didokumentasikan sebagai pembagian tugas yang
disengaja: P3.2 MENDESKRIPSIKAN (UNKNOWN sebagai view), P2.7 MEMUTUSKAN (prefix-check
menerima) — bukan gate ganda, bukan duplikasi enforcement. Primitif yang dipakai
(`anchorEventId`, `historyCommit`, `revision`, `ContextFrontier`) hanya yang
diekspos arsitektur current.

## 7. Attach-Path Analysis

Terbukti enforced (suite hijau existing + test G/G2 baru): resolve unknown-resume →
`SessionNotFoundError`; konflik/hijack alias → `SessionAliasError`; id fresh boleh;
reuse melanjutkan di lapis `saveSession` (append, tanpa reset). GAP eksplisit yang
tersisa: tanpa history-presence gate — reuse `--session` atas id berhistori (tanpa
`--resume`) memulai buffer fresh lalu menempuh shrink EKSPLISIT ber-provenance
(dibuktikan P3: exit 0, baris baru ada, semua baris `migrated_compacted=1`,
histori lama tergantikan). Bukan overwrite diam-diam, tetapi men-displace data
lewat jalur lawful. Subsystem attach-history baru TIDAK dibangun (mandat Step 5);
gap tetap dokumentasi-terbuka untuk keputusan owner (lanjutkan vs tolak vs
wajibkan `--resume`).

## 8. Diagnostic Analysis

Kanal durable `diagnostic.raised` ada dan dipakai (`PROVIDER_ERROR`); kategori
konflik tidak ada dan TIDAK dibuat (tidak membangkitkan yang lama hanya karena
stash memilikinya; tidak ada store/paralel-telemetri baru). Permukaan refusal
current: thrown error + stderr/exit codes + flag `isWriterStale`/`writerStaleNote`
+ jejak turn. Bukti durable konflik-spesifik: ABSENT (gap kedua, tercatat).
Jika implementasi ditunda: mekanisme = throw-gated refusal; yang dilihat operator =
error eksplisit + flag basi; bukti durable = baris kanonik utuh + flag shrink;
yang absen = kategori diagnostik konflik.

## 9. Mutation / Non-Vacuity Evidence

Tanpa mutasi repo (sesuai mandat; klaim historis tidak dipakai ulang sebagai bukti).
Bukti current: (a) 3 probe TEMP di luar tree dengan ekspektasi TERBALIK semuanya
GAGAL sebagaimana mestinya (divergen-diklaim-accept, DIVERGED-diklaim-EQUAL,
refused-diklaim-berubah) — 0/3 pass; (b) probe P4 pra-fix menghancurkan baris
vs pasca-fix mempertahankannya — fix terbukti load-bearing (tanpanya P4 merah);
(c) 14 test retarget gagal total pada tree pra-retarget (import mati) dan hijau
penuh sesudahnya — bukan hijau-vakum. `git diff --check` bersih; tidak ada residu.

## 10. Validation Results

- Guard retarget: 14/14 hijau ×3 run (67 expects; ~4 dtk/run cepat + P3 probe).
- Suite terkait (10 berkas: session-*, projection, context-identity, execution-id,
  writer-inventory, p2-guards, context-assembly): 195/195.
- Full suite: 296 berkas / 4380 test → 4348 pass / 23 skip / 9 fail / 0 error.
  Sembilan: MCP + manifest + P2.1×2 + P2.2×2 (flake beban, hijau terisolasi —
  MCP 17/17, journal/epoch 99/99, terkait 195/195), web nested-list (env),
  P3-constructor allowlist (deterministik, pre-existing, unrelated),
  ARCHITECTURE-map (pre-existing sejak migrasi P3.2 — DIPERBAIKI di sesi ini
  via 1 entri docs, kini 2/2 hijau). Guard SyntaxError HILANG (0 error).
- `tsc`: 37 → 28 (sembilan error guard musnah; 0 baru; sisa phase3/phase4 debt).
- Biome: guard-green; setup/persistence hanya item pra-eksisting di luar hunk.
- `gate:pack`: 21/23 (2 item pra-eksisting yang sama). `gate:coverage`: tak
  terevaluasi selama suite merah (by design); modul P3.2 tetap 100/100 terukur
  terpisah; refusal path tereksekusi di focused run.
- Klasifikasi: 0 introduced-by-this-work (setiap merah terbukti pra-eksisting
  via tree-bersih/isolasi, atau diperbaiki di sini dengan bukti).

## 11. Remaining Gaps

1. Attach history-presence gate: ABSENT (perilaku current terkunci + terdokumentasi;
   keputusan semantik milik owner).
2. Kategori diagnostik konflik durable: ABSENT (kanal ada; implementasi ditunda sadar).
3. Tafsir I2 vs auto-shrink eksplisit: rute catch→shrink dipertahankan untuk
   lipatan (dibuktikan P1); bacaan ketat I2 menjadi keputusan owner.
4. Debt pra-eksisting unrelated: P3-constructor allowlist, flake CLI-subproses,
   web nested-list, pack 21/23, coverage-gate terblokir, tsc phase3/4.
5. Stash `6bcd15f` tetap dangling (sengaja tidak di-restore; arsipkan/abaikan
   sesuai kebijakan owner — objek utuh untuk audit).

## 12. Final Verdict

**VALID** — untuk invarian inti append-only (accept/idempotent/divergence/deletion/
reorder/fold-refusal, stale-writer, tanpa silent overwrite, kanonik utuh saat
refusal, freshness P3.2, tanpa second truth, bukti non-vacuity, validasi hijau
atau merah-terbukti-pra-eksisting). Permukaan extended (attach-presence,
diagnostik konflik) dinyatakan eksplisit sebagai gap, bukan closure palsu.
Bentuk historis SUPERSEDED; tidak ada klaim bahwa ia hidup.

```text
P3.1 CURRENT CANONICAL IMPLEMENTATION STATUS:
VALID

Core append-only enforcement:
ENFORCED (P2.7 refusal + epoch/run gates + explicit provenanced shrink + I2 grown-case refusal)

Idempotence:
ENFORCED (identical = no-op; no ghost turns/rows/identities)

Divergence refusal:
ENFORCED (pre-write throw; canonical fingerprint intact)

Deletion/reorder refusal:
ENFORCED (all three classes throw; canonical intact)

Epoch/stale-writer protection:
ENFORCED (take-over = stale flag + honest exit; no blind retry)

P3.2 freshness integration:
COVERED (EQUAL/no-op, advance/accept, DIVERGED/refuse, UNKNOWN-documented; describe-vs-decide division)

Attach history-presence gate:
ABSENT (current reuse/unknown/fresh behavior locked + tested; gap documented, no fake closure)

Conflict diagnostics:
PARTIAL (durable channel live; conflict category absent by deferred decision)

Mutation/non-vacuity evidence:
CURRENT (3/3 inverted probes fail; pre/post-fix P4 probe; no repo mutation performed)

Stale historical APIs removed from executable tests:
DONE (zero executable references; supersession marked in test header + P3.1 report header)

Second authority introduced:
NO (no stores/caches/sidecars; P3.2 describe-only; single writer preserved)

P3.3:
CAN PROCEED (unchanged — hard deps live; attach/diagnostic gaps are layered defense)

Remaining gaps:
attach history-presence gate; durable conflict category; I2 strict-reading ruling;
pre-existing unrelated debt (P3-constructor allowlist, CLI flakes, web, pack, coverage gate, tsc phase3/4)

CONFIDENCE:
HIGH (production-path tests ×3 runs, related 195/195, full-suite classification, probe evidence, zero new diagnostics)
```
