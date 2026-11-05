# P1 — Correctness, Observability & Operator UX Report (2026-11-05)

**Sesi:** P1 execution (lanjutan P0 handoff)
**Repository:** `D:/Github/minicode`
**Branch:** `main` · **Version:** `0.13.1` · `git describe`: `v0.13.1-1-gcb60212`
**HEAD:** `cb602124571d8e4638bdb47d38400c52d8fba976` (tidak berubah; tidak ada commit/push/stage)
**Platform:** Windows x64 · Bun `1.4.3`
**Sifat klaim:** **stage-scoped** pada kandidat working tree di sesi ini. Bukan klaim release-readiness.

---

## 1. Executive summary

P1 menyelesaikan enam area yang diminta. P0 handoff tervalidasi secara terbatas, tetapi ditemukan
satu ketidaksesuaian nyata: **`tsc` pada awal sesi gagal dengan 6 error** di kode ledger TUI yang
ditambahkan P0 (`event.rule`, `event.percentage`, `event.contextTokens`). Error itu diperbaiki
sebagai bagian P1.

Perubahan P1 berfokus pada hal yang belum ditutup P0:

1. **Memory integrity:** `memory reconcile` tidak lagi mengadopsi kembali fakta superseded;
   target yang sudah superseded ditolak sebelum file disentuh; baris file sisa dibersihkan;
   rollback file bila store menolak.
2. **Observability contract:** machine envelope membawa identitas session/child-run yang benar;
   `eventId` memakai session pemilik event; event durable punya versi skema `v=1`; lifecycle task
   dipancarkan pada `todo_write` (bukan hanya verify-settle).
3. **Operator UX:** TUI merender `verification.observed`, `consequence.decided`, `context.cutoff`,
   `context.window`, dan deny reason; `/status` membedakan WorkMode vs PermissionMode; approval
   tidak lagi menawarkan `always` yang no-op; task `COMPLETED` ditandai `[unverified]` bila belum
   lolos verifikasi.
4. **Context/token:** footer dan `context.window` memakai **occupancy**, bukan session spend;
   `exec --json` membawa `contextTokens`/`contextWindowTokens`; compaction diatribusikan ke model
   yang benar; cache hanya dilaporkan bila provider mengirimnya.
5. **Regression tests:** gate kalibrasi in-flight, reconcile-after-supersede, child identity,
   task lifecycle, deny reason, task verification marker, dan `always` eligibility.

**Gate akhir pada kandidat final:**

| Gate | Hasil |
|---|---|
| `bun x tsc --noEmit` | **exit 0** |
| `bun run lint` | **exit 0** (658 file) |
| `bun test` | **5.444 pass · 19 skip · 0 fail** (5.463 test, 367 file, 1.069,48 s) |
| `bun run gate:coverage` | **funcs 88,07% (min 87) · lines 89,00% (min 86) · 19/19 floor** |
| `bun run audit:harness` | **60 pass · 0 fail · 2 advisory** |
| `bun run gate:bash` | **bypass 0/62 · over-block 0/24** |
| `bun run bench:smoke` | **13/13, delta 0,0%** |
| `bun test test/pty.test.ts test/pty-sgr-capability.test.ts` | **26 pass · 3 skip · 0 fail** |
| `bun run gate:pack` | **22 pass · 1 fail** — hanya ukuran: **3.874 KB** vs budget historis 3.840 KiB |

**Verdict:** **P1 COMPLETE — STAGE-SCOPED VERIFIED (DOCUMENTED LIMITATIONS).** Tidak ada blocker
correctness/enforcement/memory/visibility yang tersisa. Kegagalan `gate:pack` murni ukuran
(0,9% di atas budget historis), tanpa kebocoran test/secret/distribusi; sesuai arahan P1, ini
dicatat sebagai temuan efisiensi, **bukan** blocker penyelesaian P1.

---

## 2. P0 handoff verification

### 2.1 Dokumen dan artefak

| Item | Hasil |
|---|---|
| `docs/audit/P0_FINAL_CLOSURE_VERIFICATION_REPORT_2026-11-04.md` | ada (14.365 byte) |
| `docs/audit/P0_FOUNDATION_HARDENING_REPORT_2026-11-04.md` | ada (59.857 byte) |
| `docs/audit/P0_CLOSURE_GATE_AND_CHECKPOINT_PLAN_2026-11-04.md` | ada (32.756 byte) |
| `docs/audit/P0_P2_BASELINE_REASSESSMENT_2026-11-04.md` | ada (74.244 byte) |
| HEAD | `cb60212` (sama dengan laporan P0) |
| Parent | `57c59d3` (= `origin/main`) |
| Staged | 0 |
| Tracked modified awal P1 | 77 (sama dengan laporan P0) |
| Untracked awal P1 | 47 (sama dengan laporan P0) |
| Proses agent/test lain | tidak ada `bun`/`minicode`; hanya node milik router/pnpm/astro di luar repo |

### 2.2 Ketidaksesuaian handoff yang ditemukan

**F-P1-HANDOFF-1 (diperbaiki).** `bun x tsc --noEmit` pada awal sesi **gagal (exit 1)** dengan 6 error
di `src/ui/tui/transcript.ts`:

- `event.rule` (2×) — field tidak ada di `UiPresentationEvent`.
- `event.percentage` (2×) — seharusnya `event.percent`.
- `event.contextTokens` (2×) — seharusnya `event.usedTokens`/`event.windowTokens`.

Ini bertentangan dengan klaim P0 “TypeScript 0 error”. Error diperbaiki sebagai bagian P1.2/P1.5;
`tsc` kini exit 0.

### 2.3 Kesimpulan handoff

Sumber P0 masih utuh, HEAD tidak bergeser, dan tidak ada perubahan pengguna yang hilang. Satu
ketidaksesuaian build ditemukan dan diperbaiki. P1 dilanjutkan dalam sesi yang sama.

---

## 3. Snapshot dan fingerprint

### 3.1 Awal P1 (handoff)

```
HEAD              cb602124571d8e4638bdb47d38400c52d8fba976
tracked modified  77
untracked         47
staged            0
diff_hash         728936541b4e59fb2cd470a12d405acf8a05c081
status_sha256     86-7A-65-0C-92-BA-95-96-70-61-2E-12-12-96-3D-A3-94-4E-32-73-12-D6-DB-1A-AC-54-C2-F6-49-09-92-CF
```

### 3.2 Akhir P1 (sebelum laporan ini)

```
HEAD              cb602124571d8e4638bdb47d38400c52d8fba976
tracked modified  81   (+4 file tracked yang sebelumnya bersih)
untracked         48   (+1 test baru: test/context-calibration.test.ts)
staged            0
diff_hash         6d82616dccf405eedb0dbf7759ec0875704dcc19
```

**File baru yang dibuat P1:** `test/context-calibration.test.ts` dan laporan ini. Tidak ada
penghapusan file, tidak ada reset/clean/stash/checkout/branch/commit/push/stage.

### 3.3 File P1 yang berubah (P1-owned hunks)

| Area | File |
|---|---|
| Memory | `src/memory/vector.ts`, `src/tools/memory.ts`, `cli/commands/memory.ts` |
| Machine contract | `src/presentation/events.ts`, `src/presentation/adapter.ts`, `src/presentation/projection.ts` |
| Composition | `cli/setup.ts` |
| Policy/context | `src/policy/permission.ts`, `src/policy/usage.ts` |
| UI | `src/ui/contract.ts`, `src/ui/approval/prompt.ts`, `src/ui/assistant/simple.ts`, `src/ui/tui/transcript.ts`, `src/ui/i18n/en.ts`, `src/ui/i18n/id.ts` |
| CLI | `cli/commands.ts`, `cli/tui.ts`, `cli/commands/exec.ts` |
| Tests | `test/memory-consistency.test.ts`, `test/presentation-observability.test.ts`, `test/presentation-bridge.test.ts`, `test/presentation-events.test.ts`, `test/cli-session.test.ts`, `test/cli-help-language.test.ts`, `test/approval-integrity.test.ts`, `test/tui-transcript.test.ts`, `test/context-calibration.test.ts` (baru) |

File-file di atas sudah berada dalam working tree P0; P1 hanya menambah hunk yang dijelaskan di
§6. Tidak ada file P0 yang dihapus atau ditimpa laporan.

---

## 4. P1 acceptance matrix

| Area | Acceptance criteria | Status | Bukti |
|---|---|---|---|
| **P1.1 Tool visibility & enforcement** | visible = callable; hidden tidak bypass; denial reason; runtime switch; child no escalation; indirect path tunduk policy | **FIXED_VERIFIED** | P0 menutup G1/G5/hooks/verify/network split; P1 mempertahankan invariant. `work-mode-*` suite lulus. TUI deny reason + child marker diuji. |
| **P1.2 UI WorkMode, approval, status** | WorkMode mudah dikenali; approval jelas; ACE/verification terlihat; task/subagent tertelusuri; context meter benar; denial reason terlihat; no false success | **FIXED_VERIFIED** (implementasi) · manual comprehension **UNVERIFIED** | `/status` WorkMode+Permission; TUI ledger consequence/verification/context/deny; task `[unverified]`; approval `always` hanya bila valid. Static + mocked + PTY mechanics. |
| **P1.3 Memory supersession** | no resurrection; no split-brain; two-sided relation; head+chunk; retrieval/prompt exclude; invalid/concurrent no partial | **FIXED_VERIFIED** | Reconcile live-only + cleanup; target validation; conditional tombstone; 3 test baru. |
| **P1.4 Context & token** | cumulative not double-counted; occupancy ≠ spend; compaction attribution; estimate vs actual; cache not fabricated; machine data; calibration regression | **FIXED_VERIFIED** · cache gateway **UNVERIFIED** | Footer/context.window occupancy; exec context fields; compaction model; 4 calibration tests. |
| **P1.5 ACE & verification** | verdict/consequence/severity/next action/tamper/unverified visible; no false PASS/COMPLETE | **FIXED_VERIFIED** | TUI consequence+verification; machine status FAIL/BLOCKED; task verification marker. |
| **P1.6 Task & subagent** | canonical id; parent/child; child session+run; DAG; status; progress; result; cancel/orphan; no eventId collision; versioning | **FIXED_VERIFIED** · claim/merge/cancel emission **PARTIAL** | Machine envelope child session/run; eventId by owner session; task.status on todo_write+verify; v=1. |

---

## 5. Findings dan prioritas

| ID | Prioritas | Temuan | Status |
|---|---|---|---|
| `F-P1-HANDOFF-1` | P0 | `tsc` gagal 6 error di ledger TUI P0 | **FIXED_VERIFIED** |
| `F-P1-MEM-1` | P1 | `reconcile` mengadopsi ulang fakta superseded ke `MEMORY.md` | **FIXED_VERIFIED** |
| `F-P1-MEM-2` | P1 | `write_memory` menerima target yang sudah superseded; file sudah berubah sebelum store menolak | **FIXED_VERIFIED** |
| `F-P1-MEM-3` | P2 | Baris file legacy ter-truncate tidak selalu exact-match dengan entri vektor | **PARTIAL** |
| `F-P1-OBS-1` | P1 | Machine envelope kehilangan identitas child; `eventId` memakai session induk | **FIXED_VERIFIED** |
| `F-P1-OBS-2` | P1 | `consequence.decided` FAIL/BLOCKED berstatus machine `completed` | **FIXED_VERIFIED** |
| `F-P1-OBS-3` | P1 | `task.status` hanya terbit setelah verify-settle | **FIXED_VERIFIED** |
| `F-P1-OBS-4` | P1 | Event durable tanpa versi skema | **FIXED_VERIFIED** |
| `F-P1-UI-1` | P1 | TUI menelan `verification.observed` sebelum ledger (dead code) | **FIXED_VERIFIED** |
| `F-P1-UI-2` | P1 | TUI menyembunyikan deny reason | **FIXED_VERIFIED** |
| `F-P1-UI-3` | P1 | Ledger context memakai field yang tidak ada (`percentage`/`contextTokens`) | **FIXED_VERIFIED** |
| `F-P1-UI-4` | P1 | `/status` tidak membedakan WorkMode vs PermissionMode | **FIXED_VERIFIED** |
| `F-P1-UI-5` | P1 | Approval menawarkan `always` yang no-op untuk args > 2 KB | **FIXED_VERIFIED** |
| `F-P1-UI-6` | P1 | Task `COMPLETED` tanpa verifikasi tampil seperti sukses | **FIXED_VERIFIED** |
| `F-P1-CTX-1` | P1 | Footer `%` memakai session spend, bukan occupancy | **FIXED_VERIFIED** |
| `F-P1-CTX-2` | P1 | `context.window` mengirim output cutoff, bukan occupancy | **FIXED_VERIFIED** |
| `F-P1-CTX-3` | P1 | Biaya compaction diatribusikan ke model utama | **FIXED_VERIFIED** |
| `F-P1-CTX-4` | P2 | Adapter OpenAI-compat mengabaikan `cached_tokens`; cache gateway tidak diketahui | **UNVERIFIED** |
| `F-P1-TASK-1` | P2 | `FAILED`/`RETRYING` tidak punya producer produksi | **PARTIAL** |
| `F-P1-TASK-2` | P2 | Claim/merge/cancel task transitions belum dipancarkan | **PARTIAL** |
| `F-P1-PACK-1` | P2 | `gate:pack` 3.874 KB vs budget historis 3.840 KiB | **NOT_FIXED** (efisiensi, non-blocker) |

---

## 6. Before/after source evidence

### 6.1 Memory reconcile (F-P1-MEM-1)

**Before:** `SELECT id, text, parent FROM memory` (semua baris) → baris superseded dianggap
“vector-only” → `appendMemory(full)` menulis ulang fakta lama ke `MEMORY.md`.

**After:** `src/memory/vector.ts:1647-1676` memilih `superseded_by`, memisahkan `vectorRows` live
dan `supersededRows`, mengelompokkan hanya baris live untuk adopsi, dan membangun
`supersededEntries` (entri utuh + chunk) untuk pembersihan file. Loop file-only
(`:1727-1760`) menghapus baris yang **exact-match** entri superseded dan tidak mengindeksnya
ulang. Return type bertambah `supersededFileRemoved` dan `supersededSkipped`.

**Test:** `test/memory-consistency.test.ts` — 3 test baru:
- reconcile setelah supersession: fakta lama hilang dari file + `searchHybrid`;
- baris file sisa superseded dibersihkan;
- target yang sudah superseded ditolak tanpa menulis fakta baru.

### 6.2 `write_memory` target validation (F-P1-MEM-2)

**Before:** `memoryRowExists` hanya cek “ada”; file ditulis sebelum store memvalidasi status.
**After:** `checkMemorySupersessionTarget` memvalidasi head/chunk, semua chunk harus live, menolak
`ALREADY_SUPERSEDED` sebelum `appendMemory`; bila store tetap menolak (race), baris file baru
ditarik kembali (`src/tools/memory.ts`).

### 6.3 Machine identity (F-P1-OBS-1)

**Before:** `toPresentationEvent` membuang `sessionId`; `toMachineEnvelope` memakai
`ctx.sessionId` (induk); payload hanya `parentToolCallId`.
**After:** `src/ui/contract.ts` menambah `sessionId`/`childSessionId`/`runId`; `cli/setup.ts`
membungkus mapper dan membawa identitas dari `event.sessionId` + `parentLink`;
`src/presentation/projection.ts` memakai session pemilik untuk `eventId`/`sessionId` dan
menambah `childSessionId`/`runId` di payload.

**Test:** `presentation-observability.test.ts` — envelope anak memakai `sub_child_1`, bukan
`parent_1`; `presentation-bridge.test.ts` — wrapper membawa `childSessionId`/`runId`.

### 6.4 Durable event version (F-P1-OBS-4)

`src/presentation/events.ts` menambah `EVENT_SCHEMA_VERSION = 1` dan `Base.v?: number`.
Adapter menstempel `v:1` pada `base`/`childBase`. Event lama tanpa `v` tetap dibaca v1.
Test `presentation-events.test.ts` meng-assert `v:1` pada event durable.

### 6.5 TUI diagnostics (F-P1-UI-1/2/3/6)

- `verification.observed` kini ditangani **sebelum** guard `tool.*` (`transcript.ts`), sehingga
  `verificationLedger` tidak lagi dead code.
- `consequenceLedger` memakai `failureClass`/`nextAction`/`message`.
- `contextLedger` memakai `usedTokens`/`windowTokens`/`percent` (bukan field yang tidak ada).
- `presentationLedger` menambahkan deny reason ke baris `denied`.
- Task `COMPLETED` menampilkan `[verified]` atau `[unverified]` dari `taskVerification`.

**Test:** `tui-transcript.test.ts` — 5 test baru (verified, consequence, context occupancy,
denied reason, unverified task).

### 6.6 `/status` WorkMode vs PermissionMode (F-P1-UI-4)

`cli/commands.ts` menambah field `workMode`/`permissionMode` ke `CommandContext` dan dua baris
`/status`; `cli/tui.ts` mengisi getter live dari `workModeControl` dan `permissions`. i18n EN/ID
ditambah. Test `cli-help-language.test.ts` meng-assert kedua label dan penjelasannya.

### 6.7 Approval `always` (F-P1-UI-5)

`src/policy/permission.ts` mengekspor `canPersistAlways` (≤ 2.000 byte JSON), dipakai oleh
`saveAlways` dan `gatedPrompt`. `src/ui/approval/prompt.ts` hanya menampilkan `always` bila
`canAlways !== false`; input `a` saat opsi disembunyikan = deny (fail-closed).
Test `approval-integrity.test.ts` mencakup args kecil, > 2 KB, dan objek circular.

### 6.8 Context occupancy (F-P1-CTX-1/2/3)

- `cli/tui.ts` `fmtUsageMetrics` memakai `ctx.session.contextTokens` (occupancy), bukan
  `usage.getSession().totalTokens` (spend).
- `cli/setup.ts` `context.window` memakai `session.contextTokens`; budget cutoff juga memakai
  occupancy.
- Usage compaction mengirim `model: "deepseek-chat"`; `src/policy/usage.ts` memakai `d.model`
  untuk segmen biaya.
- `exec --json` menambah `contextTokens`, `contextWindowTokens` (bila diset), dan cache hanya
  bila dilaporkan.

### 6.9 Task lifecycle (F-P1-OBS-3)

`cli/setup.ts` menambah `emitTaskStatuses()` sinkron yang membaca `TaskStore.listTasks(sessionId)`,
mendedupe per `(id,status,revision)`, dan dipanggil pada `execution:completed` untuk
`todo_write` serta setelah `settleSessionVerifyingTasks`. Task status event juga membawa
`verification` (P1.5).

**Test:** `cli-session.test.ts` — setelah satu run fake provider dengan `todo_write`,
`presentation_events` berisi `task.status` dengan status `IN_PROGRESS`.

### 6.10 Calibration regression (F-P1-CTX-4)

`test/context-calibration.test.ts` (baru): sampel in-flight `(5026,6413)` lalu `(5026,28024)`
tidak mengubah factor; drift sah `(100,180)` → 1.8; sampel pertama besar → cap 64; factor ≥ 1.

---

## 7. Regression / integration test evidence

| Perintah | Exit | Pass/fail/skip | Cakupan |
|---|---:|---|---|
| `bun x tsc --noEmit` | 0 | — | static |
| `bun run lint` | 0 | 658 file | static |
| `bun test` | 0 | **5.444 / 19 / 0** | full unit+integration+mocked HTTP+subprocess CLI+PTY |
| `bun run gate:coverage` | 0 | funcs **88,07%** · lines **89,00%** · **19/19** | full instrumented |
| `bun run audit:harness` | 0 | 60 / 0 / 2 advisory | policy/harness |
| `bun run gate:bash` | 0 | bypass 0/62 · over-block 0/24 | bash-guard |
| `bun run bench:smoke` | 0 | 13/13, delta 0,0% | fake provider |
| `bun test test/pty.test.ts test/pty-sgr-capability.test.ts` | 0 | **26 / 0 fail / 3 skip** | PTY byte stream |
| `bun run gate:pack` | 1 | 22 / 1 fail (size only) | packaging |

**Targeted suites dijalankan sepanjang sesi (sebelum full gate):**
- 18 file, **343 pass / 0 fail**, 2.180 expect, 19,21 s.
- 10 file, **169 pass / 0 fail**, 674 expect, 11,03 s.
- 50 test TUI/presentation, 0 fail.
- 13 test memory, 0 fail (termasuk 3 test baru).

**Catatan:** angka full suite di atas adalah hasil audit ini pada kandidat final; bukan angka
historis P0 (5.428) maupun laporan lain.

---

## 8. UI/UX surface matrix

Legenda: **FULL** / **PARTIAL** / **RAW** / **HIDDEN** / **INCONSISTENT** / **N/A** / **UNKNOWN**.
Bukti: S=static, M=mocked/unit, P=PTY, U=manual, L=live.

| Capability | One-shot | `exec` human | `exec --json` | TUI | Daemon | ACP | Bukti |
|---|---|---|---|---|---|---|---|
| WorkMode terlihat | PARTIAL (stderr non-EXECUTE) | PARTIAL | FULL (`summary.workMode`) | FULL (`footer` + `/status`) | FULL (`HostedSessionInfo`) | FULL (echo P0) | S/M |
| PermissionMode terlihat | PARTIAL | PARTIAL | PARTIAL | FULL (`footer`/`/status`) | PARTIAL | PARTIAL | S/M |
| WorkMode vs PermissionMode | PARTIAL | PARTIAL | PARTIAL | FULL | PARTIAL | PARTIAL | S/M |
| Ubah WorkMode | N/A | N/A | N/A | FULL (`/work-mode`, help/completion) | flag start | params | S/M |
| Approval: tool/target/risk/diff | PARTIAL | PARTIAL | FULL field | FULL | PARTIAL (summary) | PARTIAL (risk/diff omitted) | S/M |
| Approval options valid | FULL | FULL | N/A | FULL (`always` hanya bila valid) | PARTIAL | N/A | S/M |
| Approval TOCTOU | PARTIAL | PARTIAL | N/A | PARTIAL | FULL | N/A | S/M (P0) |
| ACE verdict/next action | RAW (stderr BLOCKED) | RAW | FULL | **FULL (new)** | N/A | N/A | S/M |
| Verification/tamper | PARTIAL | PARTIAL | FULL | **FULL (new)** | FULL event | FULL | S/M |
| Task ledger | PARTIAL | PARTIAL | FULL | FULL | PARTIAL | FULL | S/M |
| Subagent identity | PARTIAL | PARTIAL | **FULL (new)** | FULL | PARTIAL | PARTIAL | S/M |
| Context occupancy | PARTIAL | PARTIAL | **FULL (new)** | **FULL (fixed)** | PARTIAL | HIDDEN | S/M |
| Session spend | PARTIAL | PARTIAL | FULL | PARTIAL | PARTIAL | PARTIAL | S/M |
| Denial reason | PARTIAL | PARTIAL | FULL | **FULL (new)** | FULL | FULL | S/M |
| No false success | PARTIAL | PARTIAL | **FULL (fixed status)** | **FULL (`[unverified]`)** | PARTIAL | PARTIAL | S/M |
| Keyboard/resize/scroll/Unicode/ANSI | PARTIAL | PARTIAL | N/A | PARTIAL | N/A | N/A | S/P (mechanics) |

**Yang tidak diklaim:** operator comprehension manual, keyboard discoverability baru, dan
accessibility penuh **belum** diuji dengan pengguna/terminal nyata pada sesi ini.

---

## 9. PTY / manual / live UAT evidence

| Jenis | Hasil |
|---|---|
| Static inspection | seluruh perubahan UI (dibaca + typecheck) |
| Mocked/unit tests | 343+169+50 test targeted; 5 test TUI baru; 3 test memory; 4 test calibration |
| PTY (Windows ConPTY) | `26 pass · 3 skip · 0 fail` — boot alt-screen, turn penuh, tabel, resize, SGR probe |
| Manual terminal UAT | **tidak dijalankan** |
| Live provider UAT | **tidak dijalankan** (tanpa otorisasi) |

Skip PTY adalah platform-gated dan beralasan (exit code ConPTY, sinyal POSIX, probe Linux),
bukan “hijau palsu”.

---

## 10. Context/token observability findings

1. **Occupancy vs spend** — footer `%` dan `context.window` kini memakai `session.contextTokens`;
   `usage.getSession().totalTokens` tetap menjadi session spend di `/status`/`exec`.
2. **Compaction cost** — usage compaction membawa `model: "deepseek-chat"`; collector memakai
   model segmen, bukan model utama.
3. **Cache** — adapter OpenAI-compat (`vendor/minicore`) masih mengabaikan
   `prompt_tokens_details.cached_tokens`; P1 **tidak mengarang** angka cache. `exec --json`
   hanya menambahkan `cacheReadTokens`/`cacheWriteTokens` bila benar-benar ada. Status gateway
   cache: **UNVERIFIED** (butuh probe terkontrol).
4. **Cumulative SSE** — collector tetap memakai delta/overwrite (bukan penjumlahan);
   regression `p19` lulus.
5. **Calibration** — gate in-flight sekarang punya regression test; cap 64 dipertahankan;
   `effectiveContextTokens` masih memakai `lastActual` (jalur test/telemetri, bukan produksi).
6. **Machine output** — `exec --json` summary kini membawa `contextTokens`,
   `contextWindowTokens` (bila diset), dan cache hanya bila ada.

---

## 11. Memory integrity verification

**Rantai yang diverifikasi:** `write_memory → vector DB → supersession → reconcile → MEMORY.md →
retrieval → system prompt`.

| Kriteria | Hasil |
|---|---|
| Reconcile tidak menghidupkan superseded | **lulus** (test baru; file + `searchHybrid`) |
| Baris file sisa superseded dibersihkan | **lulus** (exact-match; `supersededFileRemoved`) |
| Target invalid/foreign/stale ditolak sebelum file | **lulus** (`ALREADY_SUPERSEDED`/`NOT_FOUND`) |
| Head + seluruh chunk ditombstone | **lulus** (P0 `tombstoneEntry` + test) |
| Relasi dua sisi | **lulus untuk head-id**; up-link diuji P0 |
| Atomik/rollback | **lulus** (transaksi + rollback file bila store menolak) |
| Concurrent update | **kode ada** (`WHERE superseded_by IS NULL` + `changes`), **belum ada test race** |
| Retrieval mengecualikan superseded | **lulus** (SQL filter) |
| System prompt tidak memuat fakta lama | **lulus** untuk jalur normal; legacy truncated line **PARTIAL** |
| Operator dapat memeriksa provenance | **lulus agregat** (`memory status` live/superseded); belum ada listing relasi per-id |

---

## 12. ACE / task / subagent evidence

### ACE & verification

- `consequence.decided` → adapter → reducer/projection → machine + TUI/linear.
- `machineStatus`: FAIL → `failed`, BLOCKED → `interrupted`, INCONCLUSIVE → `active`, PASS →
  `completed`; severity FAIL/BLOCKED → `error`, PASS → `info`, INCONCLUSIVE → `warning`.
- TUI `consequenceLedger` menampilkan verdict, failure class, next action, rationale.
- `verification.observed` kini benar-benar dirender (bukan dead code).
- Task `COMPLETED` membawa `taskVerification`; UI menandai `[verified]`/`[unverified]`.

### Task & subagent

- Canonical `t<n>` + DAG + revision dipancarkan pada `todo_write` dan verify-settle.
- Child `sessionId`, `runId`, `parentToolCallId` dibawa terpisah; machine envelope memakai
  session anak untuk `eventId`/`sessionId` dan menambah `childSessionId`/`runId` di payload.
- `v:1` pada event durable; event lama tanpa `v` tetap kompatibel.
- **Residual:** `FAILED`/`RETRYING` belum punya producer produksi; claim/merge/cancel transitions
  belum dipancarkan; lease/owner/attempt belum ditampilkan di UI (data tersedia di `openwork`).

---

## 13. Efficiency & dependency analysis

- **Tidak ada dependency baru.** Tidak ada package/lockfile yang diubah.
- Satu modul test baru (`test/context-calibration.test.ts`, 1.850 byte).
- `TaskStore` diimpor statis di composition root untuk emission sinkron; modul itu sudah ada di
  distribusi (sebelumnya dynamic import), jadi tidak menambah dependency.
- Perubahan source berfokus pada field observability additive + komentar “mengapa”; tidak ada
  abstraksi baru yang besar.
- Tidak ada proses background baru.
- Tidak ada fitur/invariant yang dihapus.

---

## 14. Distribution size & relative change

| Metrik | Nilai |
|---|---|
| `gate:pack` files | 295 |
| Unpacked size | **3.874 KB** |
| Budget historis | 3.840 KiB |
| Selisih | **+34 KiB (~0,9%)** |
| P0 reported size | 3.854 KB |
| Delta vs P0 | **+20 KB (~0,5%)** |
| Pemeriksaan lain | 22/23 pass; tidak ada `node_modules`/test/secret terbawa |

**Klasifikasi:** temuan efisiensi (`F-P1-PACK-1`), **bukan blocker** sesuai arahan P1. Tidak ada
penurunan budget atau manipulasi gate. Rekomendasi: pass efisiensi terpisah (rapikan komentar
panjang, audit modul terkemas, pertimbangkan lazy-load modul berat) tanpa mengorbankan fitur.

---

## 15. Remaining risks

1. **Manual TUI UAT / operator comprehension** belum dijalankan; bukti UI = static + mocked + PTY
   mechanics.
2. **Cache gateway** masih UNVERIFIED; adapter OpenAI-compat belum membaca `cached_tokens`.
3. **Task transition coverage** belum penuh (claim/merge/cancel; `FAILED`/`RETRYING`).
4. **Memory concurrency race** belum punya test; kode fail-closed sudah ada.
5. **Legacy truncated memory line** yang tidak exact-match entri vektor bisa tetap muncul di file.
6. **Pack size** 0,9% di atas budget historis.
7. **P0 handoff tsc mismatch** menunjukkan pentingnya verifikasi build saat handoff.

---

## 16. Blockers & recommendations

**Blocker correctness/enforcement/memory/visibility:** tidak ada.

**Rekomendasi berikutnya (bukan P2 implementation):**

1. Jalankan manual TUI UAT (operator comprehension) untuk approval, ACE, task, dan context.
2. Probe gateway cache terkontrol; bila didukung, tambahkan parsing cache di adapter (vendor
   seam aditif) dan metrik hit-rate.
3. Pancarkan `task.status` pada claim/merge/cancel; beri producer nyata untuk `FAILED`/`RETRYING`
   atau hapus dari vocabulary tampilan.
4. Tambah test konkurensi supersession (dua writer, `CONFLICT`).
5. Pass efisiensi paket: identifikasi komponen +20 KB, rapikan komentar/duplikasi, ukur ulang.
6. Pertimbangkan listing relasi memori per-id (`memory relations <id>`) untuk provenance penuh.

---

## 17. P1 completion verdict

**P1 COMPLETE — STAGE-SCOPED VERIFIED (DOCUMENTED LIMITATIONS).**

Alasan:

- Keenam area P1 memiliki implementasi + regression/integration test.
- `tsc`, lint, full suite, coverage, audit:harness, gate:bash, bench:smoke, dan PTY mechanics
  hijau pada kandidat yang sama.
- Tidak ada false PASS/COMPLETE yang tersisa pada jalur yang diuji: consequence FAIL/BLOCKED
  bukan `completed`, task COMPLETED tanpa verifikasi ditandai `[unverified]`.
- Memory supersession tidak dapat resurrect melalui reconcile pada jalur yang diuji.
- Machine output membawa identitas anak dan versi event.
- `gate:pack` gagal hanya pada ukuran historis, tanpa kebocoran; sesuai arahan P1 ini
  diklasifikasikan sebagai temuan efisiensi, bukan blocker.

**Yang tidak diklaim:** release-readiness, repository strict-green di luar gate yang dijalankan,
validasi manual/live provider, dan penutupan P2.

---

## Appendix A — Commands & exit codes

| # | Command | Exit | Hasil |
|---|---|---:|---|
| 1 | `bun x tsc --noEmit` (awal) | **1** | 6 error ledger TUI P0 → diperbaiki |
| 2 | `bun x tsc --noEmit` (akhir) | **0** | bersih |
| 3 | `bun run lint` | **0** | 658 file |
| 4 | `bun test` | **0** | 5.444 pass / 19 skip / 0 fail |
| 5 | `bun run gate:coverage` | **0** | 88,07% funcs / 89,00% lines / 19/19 |
| 6 | `bun run audit:harness` | **0** | 60/0/2 |
| 7 | `bun run gate:bash` | **0** | 0/62 bypass, 0/24 over-block |
| 8 | `bun run bench:smoke` | **0** | 13/13 |
| 9 | `bun test test/pty.test.ts test/pty-sgr-capability.test.ts` | **0** | 26/0/3 |
| 10 | `bun run gate:pack` | **1** | 22/1 — ukuran 3.874 KB |
| 11 | targeted suites (18 file) | **0** | 343 pass |
| 12 | targeted suites (10 file) | **0** | 169 pass |

Platform: Windows x64, Bun 1.4.3. Kandidat: HEAD `cb60212` + working tree; fingerprint di §3.

---

## Appendix B — Ringkasan test baru

| File | Test | Assertion inti |
|---|---|---|
| `test/context-calibration.test.ts` | 4 | gate in-flight, drift sah, cap 64, factor ≥ 1 |
| `test/memory-consistency.test.ts` | +3 | reconcile no-resurrection, cleanup file, stale target reject |
| `test/presentation-observability.test.ts` | +2 | child envelope identity, task verification payload, status FAIL/BLOCKED |
| `test/presentation-bridge.test.ts` | +1 assertion | wrapper membawa childSessionId/runId |
| `test/presentation-events.test.ts` | +1 assertion | durable `v:1` |
| `test/cli-session.test.ts` | +1 assertion | task.status pada todo_write |
| `test/cli-help-language.test.ts` | +1 | /status WorkMode vs Permission |
| `test/approval-integrity.test.ts` | +1 | `always` eligibility |
| `test/tui-transcript.test.ts` | +5 | verification, consequence, context occupancy, deny reason, unverified task |

---

## Appendix C — Glossary

| Istilah | Definisi |
|---|---|
| **Occupancy** | Ukuran konteks saat ini (`session.contextTokens`), bukan total belanja sesi |
| **Spend** | Akumulasi `usage.getSession().totalTokens` sepanjang sesi |
| **Child session** | Session anak (`sub_*`) — identitas sesi, bukan identitas run |
| **Run** | `run_*` — identitas eksekusi anak, bisa berbeda dari session |
| **Superseded** | Baris lama yang digantikan; `superseded_by` terisi, tidak boleh muncul sebagai fakta aktif |
| **Reconcile** | Penyelarasan `vector.db` ↔ `MEMORY.md` tanpa menghapus fakta sah |
| **Evidence type** | STATIC / MOCKED / PTY / MANUAL / LIVE |
| **Stage-scoped** | Klaim hanya untuk scope dan kandidat yang benar-benar diuji |

---

*Laporan ini dibuat setelah gate akhir. Satu-satunya tulisan P1 di repository adalah laporan ini
dan `test/context-calibration.test.ts`; tidak ada commit/push/stage/penghapusan file.*
