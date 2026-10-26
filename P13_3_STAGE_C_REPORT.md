# P13.3 Stage C — Laporan Implementasi & Validasi (stage-scoped)

**Tanggal:** 2026-10-22
**Workspace:** `D:/Github/minicode`
**Branch / HEAD:** `main` / `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`
**Status perubahan:** seluruh kerja P13.3 (Stage A–C) **belum di-commit**.

> **Verdict:** Stage C selesai. **Gate final hijau pada working tree yang
> sama** (tsc, lint, full suite, coverage, pack, gate:bash, bench:smoke,
> audit:harness), dan tidak ada berkas yang berubah selama run. P13.3
> (Stage A–C) memenuhi syarat gate final; pembaruan status di `ROADMAP.md`
> tetap otoritas pemilik.

---

## 1. Ruang lingkup

Hanya Big Phase **P13.3 Stage C**: kontinuitas task durable yang aman setelah
disconnect/restart. P13.4–P13.6 dan P14 tidak disentuh. Tidak ada task kind,
queue, endpoint, task store, atau protokol baru.

Kebijakan yang dipertahankan:

- Sumber otoritas tetap `TaskStore`; lineage/generation/revision/authority/
  incarnation/`evaluateResume` yang sudah ada dipakai ulang.
- Hanya `SAFE_TO_RETRY` yang boleh kembali otomatis ke claim/dispatch.
- `background` **tidak** dianggap idempotent. Retry safety hanya boleh
  disimpulkan dari bukti cakupan tool, bukan dari “background” atau dari
  ketiadaan completion marker.
- Attempt pemulihan selalu **generation baru**, bukan replay instruksi tool
  dari jurnal lama.
- Completion marker / outcome `UNKNOWN` tetap HOLD atau menunggu verifier
  sesuai bukti yang ada.
- Daemon hanya menyalakan scheduler pada `--runtime owned`; `off` dan
  `constructed` tetap inert.
- Tidak ada perubahan pada `vendor/minicore/**`.

---

## 2. Berkas yang berubah

### Implementasi

| Berkas | Perubahan |
|---|---|
| `src/task/continuity.ts` **(baru)** | Kebijakan kontinuitas murni tanpa I/O: `RetrySafety`, `ContinuityClass`, `hasCompletionMarker`, `retrySafetyForToolScope`, `classifyContinuity`, `ContinuityGate`. |
| `src/task/scheduler.ts` | Gate kontinuitas per-kandidat (default HOLD), event `task:continuity_held`, re-cek authority/incarnation tepat sebelum setiap mutasi reconcile dan setelah reconcile sebelum claim/dispatch. Invariant `attempt > exec` tetap melempar `TaskError`. |
| `src/task/production-scheduler.ts` | Meneruskan opsi `continuity` dari composition root ke `Scheduler`; absennya = HOLD. |
| `cli/setup.ts` | Gate produksi nyata: `observeProductionRuntime` + `deriveRuntimeView` + `evaluateResume`, admission `background`, probe `store.getSnapshot` + `journal.integrityCheck()`, dan `retrySafetyForToolScope` dari 16 tool otonom 6S yang benar-benar dipasang. |
| `cli/commands/daemon.ts` | `schedulerEnabledForDaemon(mode) => mode === "owned"`, diteruskan ke `createCliSession`. |

### Test

| Berkas | Perubahan |
|---|---|
| `test/p13-task-continuity.test.ts` **(baru)** | 23 tes crash/recovery + bukti baris database; termasuk dua tes balapan baru: authority hilang dan incarnation berubah **saat evidence dibaca**, tepat sebelum mutasi. |
| `test/helpers/continuity.ts` **(baru)** | Gate uji eksplisit `PROVEN_READ_ONLY_CONTINUITY` untuk tes mekanika scheduler (bukan gate produksi). |
| `test/p13-daemon-lifecycle.test.ts` **(baru)** | 13 tes lifecycle daemon; termasuk `--runtime owned` menyalakan scheduler, shutdown menutupnya setelah sesi, dan gate produksi nyata merekonsiliasi crash-after-claim. |
| `test/phase6c`, `6f`, `6k`, `6p`, `6q`, `6r`, `6t`, `6x` (authority/acceptance), `6y` (production/process-lease) | Gate kontinuitas eksplisit ditambahkan pada fixture yang memang menguji reconcile mekanika, agar default HOLD tidak mengubah maksud tes lama. |
| `test/runtime-composition.test.ts` | Allowlist modul runtime ditambah `process-supervision.ts` (P13.2) dan `runtime-status-facts.ts` (P13.3 Stage A). |
| `docs/ARCHITECTURE.html` | Modul `continuity.ts` + deskripsi gate; jumlah modul `src/task` 20 dan `src/runtime` 23; deskripsi Scheduler/production-scheduler diperbarui. |

Tidak ada berkas Agent B yang disentuh.

---

## 3. Perintah dan exit code

Semua perintah dijalankan di `D:/Github/minicode` pada working tree yang sama,
tanpa perubahan berkas selama gate final berjalan.

| Perintah | Hasil | Exit |
|---|---|---|
| `bun test test/p13-task-continuity.test.ts` | 23 pass · 0 fail · 158 expect | **0** |
| `bun test test/p13-daemon-lifecycle.test.ts` | 13 pass · 0 fail · 63 expect | **0** |
| Batch 13 berkas Stage C + scheduler/lease | 350 pass · 0 fail | **0** |
| P13 runtime/contract/supervision/LSP/admission + permission/work-mode (9 berkas) | 175 pass · 0 fail | **0** |
| `phase6aa`–`phase6ad` (6 berkas) | 93 pass · 0 fail | **0** |
| `phase6u`, `phase6v`, `phase6y-property`, `phase6z` ×3 (6 berkas) | 103 pass · 0 fail | **0** |
| `p1-hygiene`, `stage-d-validation`, `cli-subcommands` | 66 pass · 0 fail | **0** |
| Arsitektur/import/boundary (7 berkas) | 104 pass · 0 fail | **0** |
| **`bun test` (full suite final)** | **5011 pass · 19 skip · 0 fail**; 5030 tes / 338 berkas; 1286,92 dtk | **0** |
| **`bun run gate:coverage`** | funcs **87,83%** (min 86) · lines **88,83%** (min 86); lantai per-berkas **19/19** hijau | **0** |
| `bun x tsc --noEmit` | bersih | **0** |
| `bun run lint` | 616 berkas; 0 error, 3 info (`test/session-id-portability.test.ts`, milik Agent B) | **0** |
| `bun run gate:pack` | 23 pass · 0 fail; 283 berkas; 3349 KB unpacked (budget 3584 KiB) | **0** |
| `bun run gate:bash` | bypass **0/62** · over-block **0/24** | **0** |
| `bun run bench:smoke` | seluruh skenario PASS | **0** |
| `bun run audit:harness` | **60 pass · 0 fail · 2 advisory** (fake bench results, non-blocking) | **0** |
| `git diff --check` | bersih | **0** |
| `bunx biome check` pada 22 berkas yang disentuh | bersih | **0** |

Batch 13 berkas: `p13-task-continuity`, `p13-daemon-lifecycle`, `phase6c`,
`phase6f`, `phase6k`, `phase6p`, `phase6q`, `phase6r`, `phase6t`,
`phase6x-cross-process-authority`, `phase6x-cross-process-acceptance`,
`phase6y-production-and-lifecycle`, `phase6y-process-lease`.

### Catatan provenance: run yang dibuang

Sebelum Agent B selesai, pernah ada run full suite yang berbarengan dengan
editornya: `5008 pass · 19 skip · 3 fail`. Tiga kegagalan itu adalah
`cli-subcommands` timeout 5 dtk saat spawn beruntun, hitungan modul
`docs/ARCHITECTURE.html` yang basi (16 vs 23), dan fixture
`stage-d-validation` D14 yang belum menyatakan TaskStore/scheduler. Ketiganya
sudah diperbaiki dan diuji ulang; **run tersebut tidak dipakai sebagai gate**
karena kandidatnya tidak stabil. Gate final di atas adalah run bersih setelah
Agent B selesai dan tidak ada berkas berubah selama run.

---

## 4. Bukti state database

Semua bukti di bawah membaca **baris SQLite** (bukan log/event), dari
`test/p13-task-continuity.test.ts`, kecuali butir 9–10 dari
`test/p13-daemon-lifecycle.test.ts`.

| # | Skenario | State durable |
|---|---|---|
| 1 | Crash setelah claim, sebelum dispatch | `IN_PROGRESS / exec=1 / attempt=null / owner=scheduler` → reconcile: `PENDING / owner=null / exec=1 / attempt=null / revision+1` → cycle: `IN_PROGRESS / exec=2 / attempt=2 / revision+2`. Satu `runTurn` baru; bukan replay. |
| 2 | Kerja sudah mulai, tanpa marker, scope tidak terbukti | Reconcile `[]`; baris tetap `IN_PROGRESS / exec=1 / attempt=null / owner=scheduler`; event `REQUIRES_VERIFIER / retry-safety-unproven`; nol claim/dispatch. |
| 3 | Completion marker ada | `attempt=1 / exec=1`; reconcile `[]`; baris **identik** sebelum/sesudah; nol dispatch. |
| 4 | `VERIFYING` tanpa marker + bukti tidak ada | Baris tidak berubah; HOLD; nol dispatch. |
| 5 | `VERIFYING` dengan marker | Tetap `VERIFYING`; HOLD; baris utuh. |
| 6 | Revision bergerak setelah snapshot | `REJECTED_STALE`; hanya revision tulisan luar yang berubah; exec/attempt/owner tidak berubah; nol dispatch. |
| 7 | Sesi superseded | Task baru `PENDING / exec=0 / attempt=null / owner=null` tidak disentuh; cycle instance lama `session-superseded`. |
| 8 | Lease kedaluwarsa + takeover | `renewSessionAuthority(oldToken)` → `AUTHORITY_LOST`; `releaseSessionAuthority(oldToken)` → `false`; owner baru tetap ada; cycle lama `authority-lost`; nol dispatch. |
| 9 | Authority hilang **saat evidence dibaca** | Reconcile `[]`; baris utuh; scheduler `STOPPED`; owner baru tetap; `stop()` tidak menghapus lease pengganti. |
| 10 | Incarnation berubah **saat evidence dibaca** | Reconcile `[]`; baris utuh; scheduler `STOPPED`. |
| 11 | Gate produksi `--runtime owned` (nyata) | Claim `t1` → `productionScheduler.getScheduler().reconcile() === ["t1"]` → `PENDING / owner=null / exec=1 / attempt=null`. Ini membuktikan gate di `cli/setup.ts` benar-benar mengizinkan `SAFE_TO_RETRY` pada runtime owned, bukan selalu HOLD. |
| 12 | Daemon `--runtime owned` | Scheduler `enabled/constructed/active`; runtime journal ada; shutdown → scheduler inactive, `shutdownResult()` ada, `shutdownSteps` memuat `close-hosted-session`. |

---

## 5. Klasifikasi per jenis kerja

| Jenis | Record TaskStore? | Jalur | Klasifikasi / tindakan |
|---|---|---|---|
| `background` | Ya | Scheduler + autonomous bridge 6S (16 tool) | **SAFE_TO_RETRY** hanya bila resume 4-bukti, admission `ALLOW`, jurnal/store terbaca, dan **seluruh** scope tool `READ_ONLY`. Selain itu HOLD / `REQUIRES_VERIFIER`. |
| `child` | Tidak | Sub-agent, bukan kerja durable TaskStore | Bukan kandidat kontinuitas; tidak pernah masuk gate reconcile. |
| `turn` | Tidak | Turn biasa, bukan kerja durable TaskStore | Bukan kandidat kontinuitas. |
| `task` / kind tak terpetakan | Tidak | Admission P13.3 Stage A | `REFUSE` (tanpa peta eksplisit); bila mencapai gate → HOLD. |
| Marker completion ada | Ya | Apa pun | **HOLD** (verifier/operator); tidak boleh retry otomatis. |
| Outcome `UNKNOWN`, tanpa marker | Ya | Apa pun | Hanya boleh retry bila seluruh bukti (termasuk read-only tool scope) terbukti; jika tidak → `REQUIRES_VERIFIER` / HOLD. |

Bukti 16 tool otonom: `AUTONOMOUS_TOOL_NAMES` diuji satu per satu dengan
`classifyTool(name).autonomous === true` dan `capability === "READ_ONLY"`.
Satu tool writable/UNKNOWN, atau daftar kosong, menghasilkan `UNPROVEN`.

---

## 6. Limitasi dan pekerjaan yang masih terbuka

1. **Gate final hijau pada working tree ini**, bukan pada commit. Tidak ada
   commit/push; pembaruan status `ROADMAP.md` tetap otoritas pemilik.
2. **Kompatibilitas klien eksternal** (di luar repo) belum diverifikasi.
3. **Balapan mid-pass** sudah dipersempit: authority/incarnation dicek ulang
   tepat sebelum setiap mutasi dan setelah reconcile + sebelum claim/dispatch.
   Tidak ada transaksi yang mengunci evidence→mutasi; jendela tersisa dijaga
   oleh predikat revision/ownership TaskStore dan pengecekan ulang. Task yang
   dibuat ulang dengan id sama aman karena revision-nya mulai dari 1, sedangkan
   record lama yang layak reconcile memiliki revision lebih tinggi.
4. **Jurnal null:** `storageUsable` mengizinkan `journal === null` hanya bila
   admission `ALLOW`. Pada produksi `--runtime owned`, jurnal selalu ada; mode
   legacy tanpa runtime tetap HOLD karena admission `REFUSE`.
5. **P13.4–P13.6 dan P14 tidak disentuh.** Tidak ada adopsi task lintas sesi.
6. Tidak ada commit/push/staging; seluruh perubahan tetap di working tree.

---

## 7. Ownership overlap

- Agent B: `src/lib/keystore.ts`, `src/lib/session-id.ts`,
  `test/session-id-portability.test.ts`, `test/keystore-*.test.ts`,
  `cli/commands/config.ts`, dan berkas terkait. Tidak ada yang diedit oleh
  Stage C.
- Perubahan Stage C pada berkas tes lama hanya berupa fixture gate eksplisit,
  allowlist modul, timeout subprocess (assertion tetap), dan perbaikan hitungan
  modul dokumentasi. Tidak ada assertion yang dilonggarkan.
- `bun run lint` saat ini 0 error; 3 info pada
  `test/session-id-portability.test.ts` adalah milik Agent B dan tidak
  memblokir exit code.
