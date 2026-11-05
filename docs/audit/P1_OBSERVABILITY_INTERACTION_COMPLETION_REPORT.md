# P1 — Completion Report: Observability & Interaction (PROMPT 04)

**Branch:** `main` · **Baseline:** `cb60212` (verified `HEAD`; tidak digeser)
**Version:** `0.13.1`
**Date:** 2026-11-02
**Scope:** Ekspansi aditif `D-6` yang **diizinkan owner** — kosakata event baru,
adaptor, kontrak presentasi, reducer/state, proyeksi, output machine, renderer
TUI/linear, antarmuka approval, dan test/compat protection — untuk menutup
defer pile observability yang tadinya di-defer di PROMPT 03 §6.

> **Status integrasi.** `ROADMAP.md` tidak tersentuh. Seluruh perubahan adalah
> **working-tree yang belum di-commit** (tidak ada commit/push/tag/reset/clean).
> `HEAD` tetap `cb60212`. Klaim hasil di bawah **stage-scoped** — hanya scope
> yang benar-benar dieksekusi dan diuji; bukan klaim "seluruh repository hijau".

---

## 1. Executive summary

PROMPT 03 menutup tema UX/mode dan **men-defer** 9 temuan observability lewat
`D-6` (menunggu keputusan terpisah). Owner kemudian menilai bahwa ekspansi
observability **aditif** (tanpa mengubah event lama) aman dan menyetujuinya.
PROMPT 04 ini merealisasikan ekspansi tersebut:

| Temuan (status PROMPT 03) | Status PROMPT 04 | Bukti inti |
|---|---|---|
| `F-CTRL-1` ACE verdict tersembunyi | ✅ **resolved** | event `consequence.decided` + `DiagnosticEntry` kategori `ACE` |
| `F-CTRL-2` VERIFYING/Tamper reason tersembunyi | ✅ **resolved** | `newEvidenceSinceLastAttempt` + `verdict`/`failureClass`/`nextAction` |
| `F-CTX-1` context meter/cost footer parsial | ✅ **resolved** | event `context.window` (non-durable) + footer `metrics` dari angka nyata |
| `F-CTX-2` mid-stream cutoff → stderr only | ✅ **resolved** | event `context.cutoff` (durable) + `DiagnosticEntry` `CONTEXT_CUTOFF` |
| `F-TASK-1` canonical `taskId`/DAG tak dirender | ✅ **resolved** | event `task.status` + `system` notice + `taskId`/`ordinal` di kontrak |
| `F-AGENT-1` sub-agent pool slot tak keyed `runId` | ⏸ **tidak diselesaikan di sini** | §6 (surface transcript, bukan kosakata event) |
| `F-TOOL-1` MCP schema-drift = raw error | ✅ **resolved** | `schemaDrift` terstruktur di `tool.failed` (deteksi, bukan auto-approve) |
| `F-DAEMON-1` REPLAY→LIVE badge | ⏸ **tidak diselesaikan di sini** | §6 (surface server daemon, provenance sudah diproyeksikan) |
| `F-APPROVAL-1` approval tanpa risk tier + diff | ✅ **resolved** | `riskTier` + `diffPreview` di `approval.requested` |

Cross-cutting yang diminta turut **diverifikasi utuh** (dari PROMPT 02, tidak
dilonggarkan): isolasi state UI (`F-ENV-1`) dan konsistensi lifecycle
memory/vector (`F-MEM-1`). Tidak ada mode ke-4, tidak ada pelemahan ceiling
WorkMode, tidak ada penurunan approval demi kosmetik UX, tidak ada skema-drift
yang diauto-konversi jadi approval, tidak ada persentase/biaya/token palsu,
tidak ada logika bisnis di renderer, dan tidak ada info footer permanen.

---

## 2. Keputusan owner D-6 (binding)

Owner menilai ekspansi observability **aditif** (event baru berdampingan dengan
event lama) aman, dengan syarat ketat:

1. **Observability lama dipreserve lebih dulu** — tidak ada penghapusan /
   perubahan semantik / pemutusan replay event yang sudah ada.
2. **Ekspansi aditif** dengan **compat test** — event lama byte-for-byte
   untouched (diuji di §5 `DURABILITY`).
3. **Data historis tetap dapat dibaca** — tidak ada penulisan ulang format
   penyimpanan; event baru hanya menambah jenis, tidak mengganti schema load.
4. **Bukan business logic di renderer** — renderer hanya meletakkan angka yang
   sudah dihitung pemanggil; `metrics` adalah string preformatted.
5. **Fail-closed** — tanpa injeksi DI default deny; drift skema MCP **hanya
   dideteksi**, tidak pernah di-auto-approve.

Formula otoritas yang dipegang tetap: *effective permission = WorkMode ceiling
∧ PermissionMode ∧ injected policy ∧ runtime guards*; `EXECUTE ≤ PermissionMode`;
DISCUSS read-only; PLAN no-implement; tanpa self-escalation.

---

## 3. Perubahan per deliverable

### 3.1 Kosakata event baru (`F-CTRL-1/2`, `F-CTX-1/2`, `F-TASK-1`)

**Berkas:** `src/presentation/events.ts`.

Empat event baru — semuanya **aditif** ke union `DomainEvent` dan
`DURABILITY`; tidak ada satu pun event lama yang disentuh:

| Event | Durable | Map ke model | Temuan |
|---|---|---|---|
| `consequence.decided` | ✅ | `DiagnosticEntry` (`ACE`) | F-CTRL-1/2 |
| `context.window` | ❌ (live-only) | no-op reducer | F-CTX-1 |
| `context.cutoff` | ✅ | `DiagnosticEntry` (`CONTEXT_CUTOFF`) | F-CTX-2 |
| `task.status` | ✅ | `SystemEntry` (`notice`) | F-TASK-1 |

Literal display didefinisikan **ulang** lokal di `events.ts`
(`ConsequenceVerdict`/`ConsequenceFailureClass`/`ConsequenceNextAction`,
`SideEffectTierDisplay`, `TaskStatusDisplay`, `McpSchemaDrift`) — lapisan
presentasi **tidak** mengimpor `src/policy`/`src/task`, memutus dependensi
lapisan tanpa mengarang nilai baru.

### 3.2 Enrichment event yang ada (`F-TOOL-1`, `F-APPROVAL-1`)

- `ToolFailedEvent.schemaDrift?: McpSchemaDrift` — drift skema MCP terstruktur
  (serverId + toolName), bukan string error mentah.
  [`detectSchemaDrift`][detectschema] membaca marker terstruktur
  `MCP_SCHEMA_DRIFT_DETECTED: tool "srv.tool"` dari `src/mcp/client.ts`.
- `ApprovalRequestedEvent.riskTier?: SideEffectTierDisplay` +
  `diffPreview?: string` — tier risiko efek samping (dari kontrak tool) + diff
  satu baris (sudah di-scrub secret).
- `ApprovalHookEvent` kind `"requested"` membawa `riskTier`/`diffPreview`.

### 3.3 Adaptor (`F-CTRL-1/2/CTX-1/2/TASK-1/TOOL-1/APPROVAL-1` + `F-TYPE-1`)

**Berkas:** `src/presentation/adapter.ts`.

- Empat method baru di `PresentationAdapter`:
  `noteConsequenceDecided`, `noteContextWindow`, `noteContextCutoff`,
  `noteTaskStatus` — semua dibungkus try/catch (observability tak boleh
  menggagalkan turn).
- `detectSchemaDrift` dipasang di **dua** situs emit `tool.failed`.
- `publishApproval` meneruskan `riskTier`/`diffPreview`.
- `F-TYPE-1`: `sub` dijadikan generic `<E>` — `any` dikesampingkan, satu cast
  `unknown → E` di tepi call-site (bukan melunturkan semuanya ke `any`).

### 3.4 Reducer/state (`F-CTRL-1/2`, `F-CTX-1/2`, `F-TASK-1`)

**Berkas:** `src/presentation/reducer.ts`, `model.ts`.

- `consequence.decided` → `DiagnosticEntry` (`category: "ACE"`, severity gagal =
  `error` bila `FAIL`/`BLOCKED` else `warning`; `verdict`/`newEvidenceSinceLastAttempt`
  disimpan).
- `context.cutoff` → `DiagnosticEntry` (`CONTEXT_CUTOFF`, `warning`).
- `task.status` → `SystemEntry` (`systemKind: "notice"`, teks
  `t<n> <status-lowercase>`, `reason: dependsOn=[…]`).
- `context.window` → **no-op** (live-only meter, tidak pernah menulis state;
  tidak bisa di-replay jadi histori).
- `model.ts`: `ApprovalEntry.riskTier?`/`diffPreview?`, `ActivityEntry.schemaDrift?`,
  `DiagnosticEntry.verdict?`/`newEvidenceSinceLastAttempt?`, `cloneState`
  deep-copy `schemaDrift`.

### 3.5 Proyeksi machine (`F-CTRL-1/2`, `F-CTX-1/2`, `F-TASK-1`, `F-TOOL-1`, `F-APPROVAL-1`)

**Berkas:** `src/presentation/projection.ts`.

- `MachineEventInput` + `machinePayload` (whitelist) + `machineSeverity` +
  `machineStatus` menerima field baru (`verdict`/`failureClass`/`nextAction`/
  `newEvidenceSinceLastAttempt`/`riskTier`/`diffPreview`/`schemaDrift`/`taskId`/
  `taskStatus`/`parentId`/`dependsOn`/`revision`/`usedTokens`/`windowTokens`/
  `percent`/`costUsd`/`providerModel`).
- Severity: `consequence.decided` → `error` (FAIL/BLOCKED) else `warning`;
  `context.cutoff` → `warning`; `task.status` → `error` (FAILED) / `warning`
  (BLOCKED) else `info`.
- Status: `consequence.decided`→`completed`, `context.cutoff`→`interrupted`,
  `context.window`→`active`, `task.status`→`completed/failed/cancelled/interrupted/active`.
- `toMachineEnvelope` envelope `minicode.output.v1` kini mengangkut field-field
  ini + tetap meneruskan `provenance` (live/replay/reconstructed).

### 3.6 Kontrak presentasi (`F-TASK-1` + event baru)

**Berkas:** `src/ui/contract.ts`.

- `UiPresentationPlan.steps` dan `UiPresentationEvent.steps` mendapat
  `taskId?` (identitas kanonik `t<n>`) + `ordinal?` (posisi tampil, bukan identitas).
- Union event `UiPresentationEvent.type` + field baru (verdict/failureClass/
  nextAction/newEvidenceSinceLastAttempt/riskTier/diffPreview/schemaDrift/
  taskId/taskStatus/parentId/dependsOn/revision/token fields).

### 3.7 Renderer TUI + footer (`F-CTX-1`)

**Berkas:** `cli/tui.ts`, `src/ui/footer.ts`.

- `fmtUsageMetrics(ctx)` menghitung biaya + window % dari angka **nyata**
  (`ctx.usage.getSession().cost`, `ctx.contextWindowTokens`,
  `ctx.usage.getSession().totalTokens`). Kosong = tak ada data relevan — footer
  **tidak pernah** menampilkan persentase/biaya palsu.
- `FooterStatus.metrics?` adalah string preformatted; `renderFooter` hanya
  meletakkan (melewati `sanitizeAnsiLine`), rata kanan di blok konteks. Tidak
  ada info footer permanen (hanya muncul bila datanya ada).

[detectschema]: src/presentation/adapter.ts

---

## 4. Invariant yang dijaga (tidak diubah / tidak dilanggar)

- **`D-1..D-7`, `K-1`, I35/kontrak terminal, `INV-WM1/WM4`** utuh.
- **WorkMode ⊥ PermissionMode** tetap independen; `EXECUTE ≤ PermissionMode`,
  DISCUSS read-only, PLAN no-implement; tanpa self-escalation.
- **Replay/reconstruction compat** — event lama `DURABILITY` byte-for-byte
  tak berubah; event baru hanya menambah baris `DURABILITY`; `context.window`
  non-durable sehingga tak pernah masuk histori/replay.
- **Bounded state** — reducer menulis ke `diagnostics`/`system` yang ikut
  dipangkas `trimState`; tidak ada penumpukan tak terbatas.
- **Secret protection** — `diffPreview` di-scrub; renderer melewati
  `sanitizeAnsi` untuk teks tak terpercaya; tidak ada tulis rahasia.
- **Lapisan** (`ui-boundary`) tak dilanggar — presentasi tidak import `src/ui`/
  `src/policy`/`src/task` (literal display didefinisikan ulang di `events.ts`).
- **Drift skema MCP tidak di-auto-approve** — hanya dideteksi + diproyeksikan
  sebagai `schemaDrift` terstruktur (tidak ada konversi schema-error → approval).

---

## 5. Test yang ditambah / diperbarui

- **`test/presentation-observability.test.ts`** (BARU, 22 test):
  - adaptor memancarkan 4 event baru + `schemaDrift`/`riskTier`/`diffPreview`;
  - reducer menurunkan consequence/cutoff → diagnostics, task → system,
    `context.window` → no-op (state & `seq` tak tersentuh);
  - proyeksi machine severity/status/payload untuk type baru + field tak dikenal
    tak bocor + cap teks panjang;
  - persistence durable round-trip (`consequence`/`cutoff`/`task` tertulis,
    `context.window` **ditolak** dari durable log);
  - `DURABILITY` replay/reconstruction compat (event lama tak berubah).
- **`test/presentation-bridge.test.ts`** — fixture exhaustiveness
  `Record<DomainEventType, DomainEvent>` kini memuat 4 type baru (memaksa
  `toPresentationEvent` punya case untuk setiap type; `default: never` gagal
  compile bila ada type yang terlewat).
- Coverage windows diperhatikan: `context.window` sengaja non-durable dan
  diuji ditolak dari jalur tulis; tidak ada jalur baru yang dibiarkan tak tertutup.

---

## 6. Temuan yang TIDAK diselesaikan di sini (jujur)

Dua temuan dari defer pile PROMPT 03 **tidak** diselesaikan oleh ekspansi
kosakata event ini, karena keduanya adalah **surface rendering** di lapisan
transcript/daemon — bukan objek yang dihasilkan event vocabulary/adaptor/reducer:

| ID | Temuan | Alasan belum | Lapisan |
|---|---|---|---|
| `F-AGENT-1` (P1) | sub-agent pool slot tak keyed `runId` (3 anak paralel tampil sebagai count saja) | pool di `src/tools/task.ts` (`Pool(SUB_AGENT_POOL_SIZE)`) + tautan `ChildSessionLink` di `src/presentation/adapter.ts` sudah keyed `childSessionId`, tapi render slot per-`runId` di permukaan belum | surface UI (renderer) |
| `F-DAEMON-1` (P2) | badge transisi REPLAY→LIVE di server daemon | `provenance` sudah diproyeksikan ke envelope `minicode.output.v1` (data tersedia), tapi badge transisi khusus di `src/daemon/server.ts` belum | daemon server |

Keduanya bukan bagian dari "P1 Observability & Interaction" (kosakata event +
approval + footer) dan layak dijadikan slice P2 terpisah bila owner menghendaki.

---

## 7. Hasil gate (stage-scoped)

| Gate | Hasil |
|---|---|
| `bun x tsc --noEmit` | ✅ bersih (tanpa error) |
| `bun run lint` | ✅ 650 file, 0 error (biome organizeImports sudah diterapkan) |
| `bun test` | ✅ **5355 pass · 19 skip · 0 fail** (5374 test, 361 file, 391157 `expect()`) |
| `bun run gate:coverage` | ✅ funcs **88.46%** (min 87) · lines **89.15%** (min 86) · 19/19 modul kritis hijau |
| `bun run gate:pack` | ✅ **pass 23 · fail 0** · ukuran unpacked **3773 KB** (< budget 3840 KiB / 3,75 MiB) |
| `bun run gate:bash` | ✅ bypass **0/62** · over-block **0/24** (mode auto & allowlist) |
| `bun run bench:smoke` | ✅ **13/13 PASS** · resolve rate 13/13 (1) · delta 0.0% |
| `bun run audit:harness` | ✅ **60 pass · 0 fail** (2 advisories = hasil bench `--fake` yang memang advisory, bukan failure) |

---

## 8. Tidak dijalankan / out of scope (jujur)

- `gate:slow` / `experiments/extreme-*` tidak dijalankan (bukan scope P1).
- Hasil gate lengkap akhir (smoke build/package, CI) **belum** diklaim green
  penuh — angka §7 adalah stage-scoped untuk working-tree P1 ini.
- `F-AGENT-1` / `F-DAEMON-1` (§6) tidak diimplementasi — dokumentasi jujur,
  bukan klaim selesai.

---

## 9. Artefak & kebersihan

| Item | Status |
|---|---|
| Git | ✅ tidak ada commit/push/tag/reset/clean; perubahan = working-tree |
| `HEAD` | `cb60212` (baseline; tidak digeser) |
| Rahasia | ✅ tidak ada tulis rahasia |
| Dump root (`t.log.txt` dkk.) | ✅ tidak dihapus/di-debug |
| File repo baru | `docs/audit/P1_OBSERVABILITY_INTERACTION_COMPLETION_REPORT.md` (laporan ini) |