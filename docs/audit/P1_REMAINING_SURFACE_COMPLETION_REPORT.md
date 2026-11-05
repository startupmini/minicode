# P1 — Remaining Surface Completion Report (PROMPT 05)

**Branch:** `main` · **Baseline:** `cb60212` (verified `HEAD`; tidak digeser)
**Version:** `0.13.1`
**Date:** 2026-11-03
**Scope:** Penutup temuan yang masih terbuka dari defer pile PROMPT 03/04 —
`F-AGENT-1`, `F-TASK-1`, `F-DAEMON-1`, `F-APPROVAL-1`, `F-ENV-1`, `F-MEM-1` —
plus validasi TUI berbasis PTY.

> **Status integrasi.** `ROADMAP.md` tidak tersentuh. Seluruh perubahan adalah
> **working-tree yang belum di-commit** (tidak ada commit/push/tag/reset/clean).
> `HEAD` tetap `cb60212`. Klaim hasil di bawah **stage-scoped** — hanya scope
> yang benar-benar dieksekusi dan diuji; ini **bukan** klaim "seluruh repository
> hijau" dan **bukan** klaim release-readiness.

---

## 1. Executive summary

PROMPT 04 menyelesaikan kosakata event (PROMPT 03 §6) tetapi **secara jujur
menyisakan dua temuan permukaan**: `F-AGENT-1` (render slot sub-agent per
`runId`) dan `F-DAEMON-1` (badge transisi REPLAY→LIVE di server daemon).
PROMPT 05 menutup keduanya plus reaffirm-butuh-bukti dua temuan lintas-surface
yang sudah dikerjakan di PROMPT 02 (`F-ENV-1`, `F-MEM-1`), dan menambahkan
validasi TUI via PTY nyata.

| Temuan | Status PROMPT 05 | Bukti inti |
|---|---|---|
| `F-AGENT-1` sub-agent pool slot tak keyed `runId` | ✅ **resolved** | `childRunId` (runtime) → `ChildSessionLink.runId` → `ActivityEntry.runId` → `UiPresentationActivity` → baris per-run `↳ run_<8>`/`sub_<8>` di TUI + renderer linear |
| `F-TASK-1` status/DAG task tak dirender | ✅ **resolved (permukaan)** | event `task.status` → `SystemEntry` notice + baris ledger TUI `t<n> <status> parent=… dependsOn=[…] r<rev>` |
| `F-DAEMON-1` badge transisi REPLAY→LIVE | ✅ **resolved** | latch fase **per-`Subscription`** + `tail_marker.phase: "live"`; kosakata wire (UPPERCASE) ≠ kosakata tampilan (lowercase) |
| `F-APPROVAL-1` approval tanpa risk tier + diff | ✅ **resolved** | `buildDiffPreview` (per-tool, ter-scrub) + `riskTier` dari kontrak tool, diteruskan ke view yang sama |
| `F-ENV-1` UI state menulis `process.env` | ✅ **verified (re-affirm)** | state module-local di `collapse`/`detail`/`reasoning`; setter tak pernah menulis env |
| `F-MEM-1` memori stale bocor setelah supersession | ✅ **verified + diperbaiki (Risk A)** | tombstone **seluruh chunk** entri lama (`WHERE id = ? OR parent = ?`) di tiga jalur |
| Validasi TUI via PTY | ✅ **dijalankan** | `test/pty.test.ts` + `test/pty-sgr-capability.test.ts` — byte stream nyata (skip platform-dependent di Windows ConPTY, **bukan** hijau palsu) |

**Tidak ada** mode ke-4, **tidak ada** pelemahan ceiling WorkMode, **tidak ada**
penurunan approval demi kosmetik UX, **tidak ada** ringkasan palsu pada kartu
approval, **tidak ada** event/kosakata yang ditulis ulang, dan **tidak ada**
logrus bisnis di renderer.

---

## 2. Batas yang dijaga (tidak dilanggar)

- **`D-1..D-7`, `K-1`, I35, kontrak terminal, `INV-WM1/WM4`** utuh.
  `docs/TERMINAL_CONTRACT.md` **diperbarui** untuk perilaku render baru (§3.1)
  beserta peta test proteksinya — sesuai aturan "perubahan perilaku wajib
  update dokumen + test peta proteksinya".
- **WorkMode ⊥ PermissionMode** tetap independen; `EXECUTE ≤ PermissionMode`;
  DISCUSS read-only; PLAN no-implement; tanpa self-escalation.
- **Replay/reconstruction compat** — `DURABILITY` event lama tak berubah; event
  baru (PROMPT 04) hanya menambah baris; `context.window` tetap non-durable.
- **Lapisan (`ui-boundary`)** tak dilanggar: `src/ui` tak mengimpor
  `src/` non-ui; `scrubSecrets` hanya dipanggil di `src/policy`; view hanya
  `sanitizeAnsiLine` + i18n.
- **Secret protection** — pratinjau diff approval di-scrub di policy; teks model/
  tool/berkas tetap lewat `sanitizeAnsi`.
- **Fail-closed** — `supersedes_id` tak dikenal → error actionable + rollback
  (bukan tombstone no-op); approval tetap menolak tanpa view.

---

## 3. Perubahan per deliverable

### 3.1 `F-AGENT-1` — identitas run anak dari runtime sampai permukaan

**Inti:** `runId` (identitas eksekusi), `childSessionId` (identitas session
anak), dan `parentToolCallId` (taut ke pemanggil) adalah **tiga makna
berbeda**. Temuan aslinya: "3 anak paralel tampil sebagai count saja".

Alur data yang kini tertutup penuh:

| Tahap | Berkas | Yang dibawa |
|---|---|---|
| Runtime | `src/tools/task.ts` | `delegate_task` menandai event forward dengan `childRunId` (id Run kanonik anak) selain `forwardedChild` |
| Kosakata | `src/presentation/events.ts` | `ChildSessionLink.runId?: string` (opsional — jalur lama tetap sah) |
| Adaptor | `src/presentation/adapter.ts` | `extractForwardRunId` + `resolveChildLink(childId, runId)` (backfill idempoten) |
| State | `src/presentation/reducer.ts`, `model.ts` | `ActivityEntry.childSessionId?` + `ActivityEntry.runId?` |
| Kontrak UI | `src/ui/contract.ts` | `UiPresentationActivity.childSessionId?` + `runId?` |
| Snapshot | `cli/setup.ts` | kedua field diteruskan ke `UiPresentationActivity` |
| Renderer TUI | `src/ui/tui/transcript.ts` | `runMarker()` (`run_<8>`/`sub_<8>`) + `childLedger()` + baris running per-run |
| Renderer linear | `src/ui/assistant/simple.ts` | baris `↳ <marker> <tool> <target>` di scrollback non-TTY |

**Keputusan semantik yang dijaga (penting):** baris per-run **hanya** untuk
anak yang punya identitas run (`childSessionId`/`runId`). Anak yang **hanya**
punya `parentToolCallId` (jalur grouping legacy) tetap ditelan sebagai
hitungan induk `n child tools` — persis kontrak P5 "grup anak tetap satu baris
ledger induk" (`test/presentation-projections.test.ts`). Tanpa pemisahan ini,
`parentToolCallId` (taut) akan disamakan dengan identitas run (fakta) dan
kontrak ledger yang sudah ada rusak.

Dokumen kontrak terminal diperbarui (klausul 17 + ringkasan "Projection V2" +
peta test) untuk perilaku ini.

### 3.2 `F-TASK-1` — status task kanonik + DAG di permukaan

Event `task.status` (durable) sudah ada dari PROMPT 04; PROMPT 05 menutup
**permukaannya**:

- `src/ui/tui/transcript.ts` — `taskStatusLedger()` merender baris
  `▪ <taskId> <status> parent=<id> dependsOn=[a,b] r<rev>`; event
  `task.status` ditangani **sebelum** cabang `tool.*` sehingga tak pernah
  ditelan jadi "phantom activity".
- `cli/setup.ts` — `noteTaskStatus` dipanggil setelah
  `settleSessionVerifyingTasks`, jadi id/status/DAG/revisi datang dari
  **TaskStore nyata**, bukan ditebak renderer.
- `src/presentation/reducer.ts` — `task.status` → `SystemEntry`
  (`systemKind: "notice"`) tetap dipertahankan (regresi PROMPT 04 tak
  dibatalkan).

### 3.3 `F-DAEMON-1` — badge fase REPLAY→LIVE per konsumen

- `src/daemon/protocol.ts` — tipe baru `DaemonStreamPhase = "replay" | "live"`;
  `tail_marker` kini membawa `phase: DaemonStreamPhase` (selalu `"live"` —
  `tail_marker` **adalah** titik transisi).
- `src/daemon/subscription.ts` — `Subscription.phase` (latch **per
  subscription**, bukan flag global daemon) + `markLive()` idempoten; fase awal
  `replay` hanya bila memang ada event durable untuk dibaca
  (`fromSeq <= head`), selain itu `live` sejak awal.
- `src/daemon/server.ts` — mengirim `tail_marker` lalu `sub.markLive()`.
- **Dua kosakata sengaja terpisah:** kosakata **wire** (`Provenance` =
  `LIVE|REPLAY|RECONSTRUCTED|UNKNOWN`, UPPERCASE) menjelaskan *dari mana event
  dibaca*; kosakata **tampilan** (`live|replay|reconstructed|unknown`, lowercase
  di `src/presentation/projection.ts`) menjelaskan status rebuild baris
  transcript. Keduanya tak pernah dibandingkan tanpa mapping eksplisit —
  hal ini dicatat di documen protocol.

### 3.4 `F-APPROVAL-1` — risk tier + diff preview pada kartu approval

- `src/policy/permission.ts` — `buildDiffPreview(name, args)` membentuk
  pratinjau **per-tool** yang menggambarkan operasi nyata (bash → `$ <cmd>`,
  tulis → `→ <path> · <isi>`, edit → `→ <path> -<lama> +<baru>`, patch,
  hapus, pindah, commit → `commit <pesan>`); fallback generic hanya menampilkan
  key=value terpilih — **bukan** JSON mentah. Semua keluaran melewati
  `scrubSecrets` **sekali di policy** (satu-satunya lapisan yang boleh).
- `riskTier` berasal dari **kontrak tool**
  (`contractForTool(name)?.sideEffectTier ?? "UNKNOWN"`) — bukan tebakan.
- `gatedPrompt` memancarkan `riskTier` + `diffPreview` pada event
  `approval.requested` **dan** meneruskan keduanya ke `ask(call)` dengan
  `args` yang **objek sama** dengan call yang akan dieksekusi (tak ada salinan
  yang bisa menyimpang).
- `src/ui/approval/prompt.ts` — kartu approval menampilkan tier + diff
  (fallback `actionSummary` bila preview absen, perilaku lama utuh); view hanya
  `sanitizeAnsiLine` + i18n (`appr.risk`, `appr.diff`, `appr.tier.*` di `en`+`id`).
- **Tidak ada** jalur yang mengonversi failure menjadi approval, dan **tidak
  ada** ringkasan pendek fiktif yang menggantikan diff.

### 3.5 `F-ENV-1` — isolasi state UI antar instance/renderer

- `src/ui/render/collapse.ts`, `detail.ts`, `reasoning.ts` — state
  **module-local**, di-bootstrap **satu kali** dari env saat import; setter
  **tidak pernah** menulis `process.env`.
- Batas isolasi yang dijaga: pilihan tampilan adalah state **proses ini**;
  karena env tak ditulis, renderer kedua/sub-proses (yang mewarisi `process.env`)
  tak melihat toggle tersebut — dan dua instance dalam satu proses tak saling
  menimpa.
- Getter tetap dibaca saat dipakai (toggle runtime langsung berlaku tanpa
  re-import) — jebakan "nilai beku di module scope" tak diulang.

### 3.6 `F-MEM-1` — tak ada memori stale/superseded yang bocor

**Risk A (baru, ditemukan saat verifikasi):** entri memori panjang dipecah
menjadi beberapa chunk yang **berbagi `parent = idBaris0`**. Tombstone lama
hanya men-flag `WHERE id = <chunk0>`, sehingga **chunk 1..N tetap hidup** dan
bocor sebagai memori stale setelah supersession.

- `src/memory/vector.ts` — **tiga** jalur tombstone kini memakai
  `UPDATE memory SET superseded_by = ? WHERE id = ? OR parent = ?`:
  `addMemory({supersedesId})`, `supersedeMemory`, `supersedeMemoryByIds`.
- Recall default (tanpa `includeSuperseded`) sudah mengecualikan baris
  bertombstone; `includeSuperseded` tetap tersedia untuk forensik.
- Jalur transaksi tunggal + validasi `supersedes_id` (PROMPT 02 §7.5) tetap
  utuh: id tak dikenal → error actionable, tak ada baris baru, tak ada split-brain.

---

## 4. Validasi TUI via PTY (byte stream nyata)

Dijalankan: `bun test test/pty.test.ts test/pty-sgr-capability.test.ts`.

| Item | Hasil |
|---|---|
| Total | **26 pass · 3 skip · 0 fail** (29 test, 2 file) |
| Yang dieksekusi | boot TUI (alt-screen + mouse tracking), turn penuh (submit → jawaban model → idle timer), tabel pipe → grid, `exec --json` tetap JSON satu baris tanpa cursor-control, resize, probe SGR mouse nyata, klasifikasi & gate SGR (murni + transport) |
| Yang **skip** (bukan hijau palsu) | verifikasi exit code anak via PTY interaktif — Windows ConPTY/node-pty tak melaporkan kode; 1 test SGR end-to-end + 1 test sinyal POSIX (ConPTY tak menyampaikan sinyal POSIX) |

Catatan jujur: hasil ini **platform-dependent**. Di Windows ConPTY, test exit
code & jalur sinyal di-skip **dengan alasan eksplisit** (nama test memuat
alasan skip; runner mencetak `(skip)`). Di **CI Linux** KEWAJIBAN berlaku:
`test/pty.test.ts` asserting `ptyAvailable === true` dan probe SGR
`"supported"` — tanpa PTY, audit runtime jadi no-op dan itu **gagal**, bukan
skip. Jadi angka di atas **tidak boleh** dibaca sebagai "audit PTY linux hijau".

---

## 5. Test yang ditambah / diperbarui

| Berkas | Yang dijaga |
|---|---|
| `test/presentation-projections.test.ts` (diperluas) | `F-AGENT-1`: baris per-run `↳ run_<8>`/`sub_<8>`; marker jatuh ke `childSessionId` bila `runId` absen; tiga anak paralel = tiga baris (bukan count); **anak tanpa identitas run tetap satu baris ledger induk** (regresi P5 dicek); `F-TASK-1`: baris ledger task + status tanpa parent/deps; renderer linear: baris `↳ run_<8>` di scrollback |
| `test/presentation-observability.test.ts` (diperluas) | `F-AGENT-1`: `childRunId` (event forward) → `parentLink.runId` → `ActivityEntry.runId/childSessionId` |
| `test/p2-daemon.test.ts` (diperluas) | `F-DAEMON-1`: fase per-langganan `replay→live` idempoten, fase awal `live` bila tak ada replay, dua langganan tak saling menimpa; `tail_marker.phase === "live"` + event sebelum penanda = `REPLAY` |
| `test/presentation-events.test.ts` (PROMPT 04/05) | `F-APPROVAL-1`: `riskTier` dari kontrak, diff ter-scrub (`[REDACTED]`, token mentah absen), preview generic tool tak dikenal, preview bash ter-scrub |
| `test/approval-tui.test.ts` (diperluas) | kartu approval menampilkan tier + diff; fallback `actionSummary` tetap berlaku |
| `test/p20-phase8-supersession-mcp-pin-and-tasksync.test.ts` (diperluas) | `F-MEM-1` Risk A: chunk tail entri lama **tidak** bocor di recall default (tetap ada di `includeSuperseded`); `supersedeMemory` menombstone seluruh chunk; `supersedesId` tak dikenal → rollback utuh |
| `test/tui-format.test.ts` (diperluas) | `F-ENV-1`: `reasoning`/`detail`/`collapse` **tidak** menulis `process.env` |
| `test/sanitize-render.test.ts`, `test/terminal-contract.test.ts`, `test/collapse.test.ts` (diperbarui) | reset state collapse lewat setter (module-local), bukan hapus env |

---

## 6. Temuan/regresi yang ditemukan & diperbaiki selama verifikasi

| Temuan | Perbaikan |
|---|---|
| Implementasi F-AGENT-1 sempat **merusak** kontrak P5 "grup anak = satu baris ledger induk" (regresi nyata di `bun test` penuh: 1 fail) | pemisahan tegas: baris per-run hanya bila ada identitas run (`childSessionId`/`runId`); `parentToolCallId` saja → roll-up seperti semula. Test penjaga ditambahkan untuk kedua cabang |
| Renderer linear menyisakan spasi ganda saat marker kosong | prefiks dirakit dari marker opsional (`↳ ` / `↳ <marker> `) |

---

## 7. Hasil gate (stage-scoped, satu kandidat final)

> Semua angka di bawah berasal dari **satu working tree final** (HEAD `cb60212`
> + seluruh perubahan PROMPT 02–05 yang belum di-commit). Berkas laporan ini
> dibuat **setelah** gate dan tidak memengaruhi kode/test mana pun.

_(angka gate ada di tabel di bawah — gate final sudah dijalankan)_

Perintah (urutan persis gate `AGENTS.md` / `bun run gate:fast`):

```bash
bun x tsc --noEmit
bun run lint
bun test
bun run gate:coverage
bun run gate:pack
bun run gate:bash
bun run bench:smoke
bun run audit:harness
```

| Gate | Hasil |
|---|---|
| `bun x tsc --noEmit` | ✅ bersih (tanpa error) |
| `bun run lint` | ✅ **650 file, 0 error** (biome `check src cli test bench scripts`) |
| `bun test` | ✅ **5372 pass · 19 skip · 0 fail** (5391 test, 361 file, 387157 `expect()`) |
| `bun run gate:coverage` | ✅ funcs **88.47%** (min 87) · lines **89.12%** (min 86) · **19/19** modul kritis hijau |
| `bun run gate:pack` | ✅ **pass 23 · fail 0** · ukuran unpacked **3792 KB** (< budget **3840 KiB / 3,75 MiB**, sumber tunggal `scripts/pack-budget.ts`) |
| `bun run gate:bash` | ✅ bypass **0/62** · over-block **0/24** (mode auto **dan** allowlist) |
| `bun run bench:smoke` | ✅ **resolve rate 13/13 (1)** (bench `--fake`) |
| `bun run audit:harness` | ✅ **60 pass · 0 fail**, 2 advisories (hasil `bench --fake` yang memang advisory + `swebench_results.json` belum ada — bukan failure) |

Semua angka di atas berasal dari **satu kandidat final** (working tree yang
sama; `HEAD` tetap `cb60212`). Tidak ada gate yang diturunkan ambangnya, dan
tidak ada gate yang dilewati.

---

## 8. Tidak dijalankan / di luar scope (jujur)

- `gate:slow` / `experiments/extreme-*` **tidak** dijalankan.
- Smoke build/package penuh dan pemeriksaan CI **tidak** dijalankan di sini —
  laporan ini **tidak** mengklaim release-readiness.
- Angka §7 bersifat **stage-scoped** untuk working-tree ini; tidak ada klaim
  "seluruh repository hijau" di luar gate yang benar-benar dieksekusi.
- PTY: hasil di §4 adalah hasil platform Windows (ConPTY) — jalur CI Linux
  (wajib PTY + SGR `supported`) **belum** dijalankan di lingkungan ini dan
  tak boleh diklaim hijau.

---

## 9. Artefak & kebersihan

| Item | Status |
|---|---|
| Git | ✅ tidak ada commit/push/tag/reset/clean; perubahan = working-tree |
| `HEAD` | `cb60212` (baseline; tidak digeser) |
| `ROADMAP.md` | ✅ tidak tersentuh (status fase tetap milik owner) |
| Rahasia | ✅ tidak ada tulis rahasia |
| Dump root (`t.log.txt`, `t.xml`, `t2.log.txt`, `t3.log.txt`, `t.log.xml`) | ✅ tidak dihapus/di-debug (artefak pengguna) |
| File repo baru | `docs/audit/P1_REMAINING_SURFACE_COMPLETION_REPORT.md` (laporan ini) |
