# Output Architecture Audit

**Status:** audit selesai; Phase 1–8 remediation landed, with one ACP compatibility window. Tables and evidence marked historical describe the pre-remediation baseline.
**Tanggal:** 2026-09-25  
**Produk:** MiniCode coding agent CLI  
**Rujukan kontrak:** `docs/TERMINAL_CONTRACT.md`, `docs/UI_RENDER_PIPELINE.md`

## Scope

Audit ini mencakup output yang dihasilkan atau diturunkan oleh runtime MiniCode:

- TUI fullscreen: transkrip, composer, status bar, popup, selection, clipboard.
- Output linear/one-shot: model text, reasoning, tool ledger, error, receipt.
- `exec --json`: JSON Lines dan summary envelope.
- `acp`: JSON-RPC stdio minimal untuk IDE.
- Diagnostic, approval, spinner/status transient, setup/recovery/verify.
- Batas vendor: `vendor/minicore/**` dibaca sebagai evidence, tidak diubah.

Rancangan `AGENT_PRESENTATION_ARCHITECTURE_V2_1.md` diperlakukan sebagai target
arsitektur, bukan bukti bahwa semua fase sudah selesai. Audit ini menilai wiring
aktual terhadap rancangan tersebut.

## Phase 1–8 implementation update

Audit ini capturing baseline sebelum remediation. Current implementation status
setelah Phase 1–8:

- Phase 1: `user.message`, mapper exhaustive, `PROPOSED_EVENT_TYPES`, dan
  `unsupportedProjection` diagnostics landed.
- Phase 2: semantic collections, derived summaries, bounded retention, durable
  SQLite event log, resume rebuild, checkpoint evidence, child-session
  persistence, producer `finding.detected`, contract restart/branch/child/delete/
  TTL/resume, dan `eventSeq` unik landed.
- Phase 3–7: policy proyeksi murni, envelope machine, migrasi TUI/linear/machine,
  persist headless, dan writer inventory landed.
- Phase 8: rollback flag dan raw ledger TUI dihapus. Runtime EventBus tetap
  dipakai untuk streaming konten dan debug/trace, bukan sebagai sumber status
  user-facing kedua.
- OAP-001–OAP-010 dan OAP-012–OAP-013 closed atau documenting the compatibility
  boundary; OAP-011 tetap proposed/compatibility-only. Residual window: ACP
  legacy `type:"tool"` when canonical lifecycle is unavailable.

## Executive verdict

Audit baseline menunjukkan MiniCode memiliki fondasi terminal yang kuat:
sanitasi trust boundary, perhitungan lebar kolom, ownership alternate-screen,
coalesce repaint, source-mapped selection, OSC52, dan test proteksi yang luas.
Setelah remediation Phase 1–8, status, activity, visibility, correlation, dan
machine lifecycle mengambil keputusan dari canonical presentation policy yang
di-inject pada composition root.

```text
Agent Runtime
    ↓ MiniCore EventBus
    ↓ streaming content transport
    ├─ TUI transcript content + canonical policy ledger
    ├─ Linear content + canonical policy writer
    ├─ exec canonical lifecycle + text delta
    └─ ACP canonical lifecycle + text delta

PresentationAdapter
    ↓
DomainEvent → PresentationState (durable/replayable)
    ↓ UiPresentationEvent + PresentationPolicy
TUI / linear / exec / ACP
```

Tidak ditemukan P0. Residual risk terbatas pada live streaming dan kompatibilitas
ACP legacy `type:"tool"`; keduanya tidak menentukan status user-facing canonical.
The historical findings below remain as evidence for the pre-remediation state;
the current implementation is recorded in the Phase 1–8 update above.

## Arsitektur aktual

```text
Provider/router
  │ provider:text / provider:extension / usage
  ▼
MiniCore loop (vendor/minicore, frozen)
  │ turn:started, step:*, execution:*, provider:*, context:*
  ▼
session.events (raw EventBus; raw content streaming tetap, semantic legacy
    user-facing dihapus di Phase 8)
  ├── attachSimpleLogger() ── stdout/stderr linear (keputusan status dari policy)
  │       └── turn-status.ts ── transient stderr (label via activityFor DI)
  ├── Transcript() ── append-only visual state TUI (ledger/summary dari policy)
  │       └── TuiApp + screen.ts ── alternate screen
  ├── exec.ts ── envelope minicode.output.v1 → JSONL (+ text delta terpisah)
  ├── acp.ts ── lifecycle presentasi penuh + text delta tersanitasi
     ├── journal/checkpoint/trace
     ├── presentation_events (SQLite durable log)
     └── PresentationAdapter (cli/setup.ts)
           ├── turn/tool/model/reasoning/context/checkpoint events
           ├── approval hooks + noteRunSettled + file.changed
           └── replayable bounded PresentationState
                     ├── toPresentationEvent() compatibility bridge
                     └── projection.ts policy (di-inject ke renderer sebagai PresentationPolicy)
```

### Batas aktual yang sudah baik

- `src/ui/` tidak mengimpor `cli/`, `src/` non-UI, atau kernel; dijaga
  `test/ui-boundary.test.ts`.
- `TuiApp` adalah pemilik tunggal frame TUI; `screen.ts` memiliki pairing
  alternate-screen dan `paintRegion()`.
- `statusline.ts` meng arbitrasi transient painter dan menahan painter ketika
  interactive screen aktif.
- Sanitasi dan geometri memakai modul bersama; teks yang tidak dipercaya tidak
  boleh keluar sebagai control sequence mentah.
- Event bus mengisolasi handler yang melempar sehingga observer/UI tidak
  menggagalkan turn (`vendor/minicore/src/core/events.ts:35-71`).
- TUI, linear, ACP, dan exec sudah memiliki test output serta boundary fail-closed
  untuk machine mode.

## Historical Pipeline (pre-remediation evidence)

| Stage | Current implementation | Problem | Risk |
|---|---|---|---|
| Provider stream | `src/providers/router.ts`, `vendor/minicore/src/core/loop.ts:108-135` | Raw provider event tidak memiliki schema output bersama | Tiap consumer menafsirkan event sendiri |
| Kernel lifecycle | `vendor/minicore/src/core/events.ts:5-14`, `session.ts:234-249` | `turn:completed` hanya sukses; abort/timeout/failure tidak menjadi terminal event | Consumer harus merekonstruksi makna dari driver |
| Tool execution | `vendor/minicore/src/core/executor.ts:40-104` | Permission deny, unknown tool, dan invalid args dapat kembali tanpa `execution:*` | Denial/validation perlu dibaca dari `step.completed` |
| Semantic adapter | `src/presentation/adapter.ts:158-721` | Semua lifecycle harus direkonstruksi; beberapa event dideklarasikan tanpa producer | Risiko event hilang/duplikat/anomali |
| State/reducer | `src/presentation/{model,reducer}.ts`, wiring `cli/setup.ts:642-655` | Reducer hanya shadow; `PresentationState` belum lengkap untuk semua event | TUI/linear/ACP dapat berbeda |
| UI bridge | `cli/setup.ts:449-532`, `src/ui/contract.ts:144-174` | Hanya turn/tool/approval yang diproyeksikan; model/reasoning/file/test/context di-drop | Consumer tidak dapat memakai satu event stream |
| TUI | `src/ui/tui/{transcript,app}.ts`, `runtime/screen.ts` | Truth visual berasal dari raw bus + buffer sendiri, bukan snapshot tunggal | Status/ledger dapat berbeda dari linear |
| Linear/one-shot | `src/ui/assistant/simple.ts`, `turn-status.ts` | Menggabungkan state, sanitasi, collapse, policy, dan writes | Perubahan semantics berisiko duplication |
| Exec machine | `cli/commands/exec.ts:126-199` | Streaming raw `session.events("*")`; summary memiliki schema sendiri | Client harus memahami dua protocol |
| ACP machine | `cli/commands/acp.ts:278-349` | Menggabungkan raw text/tool stream dengan partial presentation lifecycle | IDE bisa melihat event lifecycle tidak lengkap |
| Diagnostic/policy | `cli/setup.ts`, `cli/index.ts`, `statusline.ts`, approval/popup | Banyak direct write; arbitration melindungi transient, bukan semantik | Jalur baru mudah melanggar stream contract |
| Durable state | `session/journal`, `persistence`, checkpoint, `turn-marker` | Data durable tidak ditulis sebagai `DomainEvent` yang dapat direplay ke model | `rebuildFromDurable()` belum wired di production |

## Event Inventory

| Event | Source | Current presentation | Desired semantic type |
|---|---|---|---|
| `turn:started` | MiniCore loop | TUI/linear/ACP turn marker; `turn.started` shadow | `task.started` dengan `sessionId`, `turnId`, visibility normal |
| `turn:completed` | MiniCore success | Flush transcript/answer, status, `turn.completed` shadow | `task.completed` + derived summary |
| `turn.failed` | `noteRunSettled()` | Error friendly dari driver; tidak selalu event live | `task.failed` dengan cause/severity/action |
| `turn.cancelled` | `noteRunSettled()` | Stopped/budget/timeout messages; TUI/linear/ACP bergantung driver | `task.cancelled` dengan reason user/timeout/budget |
| `model.delta` | `provider:text` | Stream text sanitized ke TUI/linear/ACP | `assistant.message.delta`, live-only |
| `model.completed` | `TurnResult.finalText` saat turn selesai | Commit transcript/answer; bridge tidak mengirim ke UI | `assistant.message.completed`, durable final |
| `reasoning.delta` | `provider:extension(kind=reasoning)` | Dots/stream/buffer sesuai surface | `assistant.reasoning.delta`, live-only |
| `reasoning.completed` | Tidak ada producer runtime saat ini | Hanya tipe dan durability; tidak tampil konsisten | `assistant.reasoning.completed`, hasil final/ref |
| `tool.started` | `execution:started` | Ledger/progress/status running | `tool.started` dengan identity/correlation |
| `tool.progress` | Tidak ada producer runtime saat ini | Hanya field `progress` bila event eksternal | `tool.progress`, live-only, optional |
| `tool.completed` | `execution:completed` success | Receipt/ledger/collapse | `tool.completed` dengan duration/evidence |
| `tool.failed` | execution result atau `step.results` | Error ringkas; klasifikasi dapat berbeda | `tool.failed` dengan cause/hint/partial state |
| `tool.denied` | Reconstructed dari permission result | Warning/deny; adapter diklasifikasi khusus | `tool.denied` dengan deny reason/outcome |
| `tool.cancelled` | Cascade saat abort/parent settle | Dibatasi/ditampilkan sebagai cancelled | `tool.cancelled` dengan cancellation reason |
| `approval.requested` | Permission/ask hook | Blok TUI/linear/headless deny | `approval.requested` |
| `approval.settled` | Permission/ask hook | Keputusan tercatat; bridge partial | `approval.settled` dengan allow/deny/cancelled |
| `file.changed` | `attachMutationJournal` → adapter | Receipt pada activity; bridge meng-drop event | `file.changed` sebagai evidence/receipt |
| `test.completed` | Tidak ada producer saat ini | Hanya tipe dan receipt join | `test.completed` sebagai evidence |
| `context.compacted` | MiniCore loop | Warning/entry system; bridge meng-drop | `context.compacted` sebagai system event |
| Diagnostic | CLI/provider/policy direct write | `[warn]`, `[recovery]`, `[verify]`, spinner | `diagnostic.raised` atau `recovery.*` dengan policy stream |

## Output Inventory

| Output | Category | Current mode | Recommended mode |
|---|---|---|---|
| TUI transcript | Human, interactive | Fullscreen frame; raw-bus-fed view | Same layout, sourced from canonical projection |
| TUI status/footer | Human, interactive | Clock/ANSI state in `TuiApp` | Semantic snapshot; renderer owns only layout |
| Linear model text | Human, append-only | Sanitized stream, collapse, markdown table | Normal/verbose projection from same state |
| Linear tool receipt | Human + operational evidence | Direct writer with status suffix | Derived activity node; evidence remains ref-backed |
| Reasoning | Human, optional | TUI/linear independently buffer/minimize | Same state, visibility policy per projection |
| Transient status/spinner | Human, ephemeral | `turn-status`/`statusline` direct writes | Derived projection of active task; output sink route |
| `exec --json` | Machine | Raw EventBus JSONL + summary | Versioned canonical JSONL + terminal summary |
| ACP | Machine/IDE | Text deltas + raw tool fallback + partial lifecycle | Canonical lifecycle notifications + text delta |
| Approval | Human or machine policy | TUI sink, inline askLine, headless deny | Approval event + surface-specific prompt/decision |
| Diagnostics | Human diagnostic | Direct stderr with varied prefixes | Typed diagnostic policy, never mixed with machine stdout |
| Clipboard | Human interaction | `/copy` + app selection OSC52 | Same; source-mapped and sanitized |
| Debug bus | Debug | Opt-in `bus-debug` raw event summaries | Debug projection from canonical events, redacted payload |

## Historical Findings (before remediation)

The original finding list below is preserved as audit evidence. Current disposition:

| Finding | Current disposition |
|---|---|
| OAP-001 | Closed for user-facing decisions; raw EventBus remains only for streaming content/debug. |
| OAP-002 | Closed at adapter/reducer seam; vendor runtime remains unchanged. |
| OAP-003 | Closed by exhaustive `toPresentationEvent()` bridge. |
| OAP-004/OAP-005 | Closed by semantic collections and evidence-derived summaries. |
| OAP-006 | Closed by versioned machine envelopes. |
| OAP-007 | Closed by production durable rebuild. |
| OAP-008/OAP-013 | Closed by writer inventory, boundary checks, and documentation updates. |
| OAP-009/OAP-010/OAP-012 | Closed by canonical policy and semantic nodes. |
| OAP-011 | Proposed events remain explicit; no fabricated producer. |


### Original finding register (historical)

| ID | Severity | Location | Problem | Recommendation |
|---|---|---|---|---|
| OAP-001 | P1 | `cli/setup.ts:642-655`, `transcript.ts:161-185`, `simple.ts:417-...`, `exec.ts:126-139` | Raw bus dan shadow presentation state adalah dua sumber kebenaran | Jadikan canonical projection satu-satunya feed renderer setelah parity gate |
| OAP-002 | P1 | `vendor/minicore/src/core/events.ts:5-14`, `executor.ts:40-74`, `session.ts:234-249` | Failure/abort/deny tidak selalu memiliki terminal event runtime | Pertahankan adapter rekonstruksi sebagai seam, tambahkan canonical settle event |
| OAP-003 | P1 | `cli/setup.ts:449-532`, `src/ui/contract.ts:144-174` | Bridge membuang model/reasoning/file/test/context events | Definisikan bridge total dengan default fail-safe dan diagnostic counter |
| OAP-004 | P1 | `src/presentation/model.ts:74-130`, `reducer.ts:391-400` | State tidak menyimpan reasoning/system/user/plan/finding secara lengkap | Tambahkan entry collections dan user/task semantic events |
| OAP-005 | P1 | `src/presentation/adapter.ts:294-302` | `turnSummary.filesChanged` selalu `0`; receipt tidak masuk summary | Hitung summary dari reducer/journal-derived state, bukan konstanta adapter |
| OAP-006 | P1 | `cli/commands/exec.ts:126-199`, `acp.ts:278-349` | Machine output bukan canonical protocol yang sama | Tambahkan schema/version/envelope dan mapper eksplisit |
| OAP-007 | P1 | `reducer.ts:441-483`, `cli/setup.ts:1029-1038` | Rebuild durable adalah helper test, belum menjadi jalur production | Simpan semantic durable log atau replay adapter dari session/journal saat resume |
| OAP-008 | P2 | `cli/index.ts`, `cli/setup.ts`, `cli/commands.ts`, `src/ui/approval/prompt.ts`, `src/ui/runtime/*` | Direct writes tersebar; policy stream tidak terpusat | Inventory writer dan routekan diagnostic/permanent output lewat sink |
| OAP-009 | P2 | `simple.ts:434-546`, `transcript.ts:183-186`, `acp.ts:260-268` | Visibility/verbose/normal state dihitung terpisah per surface | Buat policy projection bersama; renderer hanya berbeda pada layout |
| OAP-010 | P2 | `adapter.ts:125-135`, `simple.ts:597-615`, `transcript.ts:601-633` | Klasifikasi deny/fail tetap string/`isError` di beberapa jalur | Reduced satu canonical outcome, diagnostics fallback hanya di adapter |
| OAP-011 | P2 | `events.ts:164-263`, `adapter.ts:549-567` | Vocabulary punya event tanpa producer/consumer konsisten | Tandai proposed/unsupported eksplisit atau tambahkan producer/adapter |
| OAP-012 | P2 | `cli/tui.ts:675-689`, `src/ui/tui/transcript.ts:131-186` | User message, plan, dan finding tidak punya semantic event terpisah | Tambahkan `user.message`, plan nodes, evidence/finding nodes |
| OAP-013 | P2 | `docs/UI_RENDER_PIPELINE.md:112-116`, `PLAN.md:158-300` | Dokumentasi masih menyatakan tidak ada event yang diabaikan dan plan lama belum direkonsiliasi | Sinkronkan docs, plan, dan test coverage map sebelum remediation |

### Detail temuan

#### OAP-001 — P1 — Dua sumber kebenaran

**Evidence:** `cli/setup.ts:369-380` menyebut adapter dan shadow reducer;
`cli/setup.ts:642-655` menjalankan reducer dalam mode shadow. `Transcript` masih
subscribe langsung ke raw bus pada `src/ui/tui/transcript.ts:161-185`;
`attachSimpleLogger` masih memproses raw `provider:text`, `execution:*`, dan extension
pada `src/ui/assistant/simple.ts:417-763`; `exec` dan `ACP` juga menerima raw `*` pada
`cli/commands/exec.ts:131-139` dan `cli/commands/acp.ts:290-303`.

**Problem:** Presentation state direduksi sebagai pengamat, bukan authoritative
model. TUI/linear dapat memiliki buffer, status, dan urutan yang berbeda dari state.

**Impact:** Perubahan semantic event belum dapat di-push ke semua consumer
sekaligus; parity test hanya dapat membandingkan output, tidak menjamin state yang
sama.

**Recommendation:** Tetapkan fase migrasi berflag: pertahankan raw bus hanya untuk
runtime/debug, kirim semua user-facing surface melalui projection dari
`PresentationState`, lalu hapus shadow setelah golden parity.

**Update Phase 3–7:** keputusan ledger/summary/elapsed/label kini dari
`src/presentation/projection.ts` via injeksi `PresentationPolicy`
(`cli/tui.ts`, `cli/setup.ts`); parity test policy-vs-legacy hijau di
`test/presentation-projections.test.ts` dan `test/presentation-linear-acp.test.ts`.
Jalur raw ledger TUI dan rollback flag dihapus di Phase 8;
penghapusan menunggu satu rilis hijau (Phase 8).

#### OAP-002 — P1 — Lifecycle runtime tidak lengkap

**Evidence:** vendor event union hanya sembilan tipe
(`vendor/minicore/src/core/events.ts:5-14`); executor mengembalikan deny/unknown/validation
sebelum `execution:started` (`vendor/minicore/src/core/executor.ts:40-74`); session hanya
menerbitkan `turn:completed` setelah `executeTurn` sukses
(`vendor/minicore/src/core/session.ts:234-249`).

**Problem:** Deny, invalid, abort, timeout, dan failure tidak selalu memiliki
terminal event yang sama. Adapter harus membaca `step.completed`, permission hook,
dan `noteRunSettled()` untuk menutup gap.

**Impact:** Failure bisa hilang pada surface yang tidak memasang driver settle;
urutan terminal bisa berbeda antara TUI, linear, dan ACP.

**Recommendation:** Jadikan canonical event vocabulary tetap memuat task/tool
terminal states. Tambahkan seam adapter-only terlebih dahulu; kernel tidak perlu
diubah. Pastikan setiap user-visible execution memiliki tepat satu status final.

#### OAP-003 — P1 — Bridge partial

**Evidence:** `toPresentationEvent()` hanya menangani turn/tool/approval pada
`cli/setup.ts:449-532` dan mengembalikan `null` untuk model, reasoning, file,
test, context, dan diagnostic. `UiPresentationEvent` di
`src/ui/contract.ts:144-174` juga tidak mendeklarasikan event delta.

**Problem:** State shadow dapat memproses event yang tidak pernah sampai ke
consumer presentasi. TUI dan linear masih mengambil event tersebut dari raw bus.

**Impact:** `verbose`, `debug`, ACP lifecycle, resume, dan golden fixture tidak
menguji event yang sama.

**Recommendation:** Buat mapper exhaustive dengan exhaustive check dan counter
`unsupportedProjection`; mapper tidak boleh diam-diam membuang event yang
dinilai user-relevant.

#### OAP-004 — P1 — Model presentation belum lengkap

**Evidence:** `ReasoningEntry` dan `SystemEntry` dideklarasikan pada
`src/presentation/model.ts:74-97`, tetapi `PresentationState` hanya menyimpan
`conversation`, `turns`, `activities`, `approvals`, dan `order`
(`src/presentation/model.ts:119-130`). Reducer hanya menambahkan order ref untuk
reasoning/context (`src/presentation/reducer.ts:391-400`). Tidak ada user event;
user prompt masuk melalui `Transcript.pushUser()` di `cli/tui.ts:675-689`.

**Problem:** Model tidak dapat menjadi transcript semantic lengkap maupun
merepresentasikan plans/findings secara terpisah dari activity.

**Impact:** TUI, `/copy`, resume, dan machine projection harus tetap memiliki
buffer/parser tambahan.

**Recommendation:** Tambahkan `user.message`, `reasoning`, `system`, `plan`,
`finding`, dan `result` entries dengan lifecycle serta visibility. Reducer tetap
murni dan tidak menyimpan payload besar.

#### OAP-005 — P1 — Summary/receipt tidak truthful

**Evidence:** `turnSummary()` di `src/presentation/adapter.ts:294-302` selalu
mengisi `filesChanged: 0`; `file.changed` dipanggil dari
`cli/setup.ts:662-673`, tetapi `turn.completed` tidak membawa hasil agregasi
checkpoint. TUI memakai summary yang diterima melalui bridge pada
`src/ui/tui/transcript.ts:635-667`.

**Problem:** Evidence file yang sudah dijournal/checkpoint tidak masuk turn summary
yang dipakai TUI/ACP.

**Impact:** User dan IDE dapat melihat jumlah file berubah yang salah, sedangkan
receipt per activity mungkin benar.

**Recommendation:** Reducer menghitung summary setelah event file/test masuk;
adapter hanya memberikan metadata clock, bukan angka domain.

#### OAP-006 — P1 — Machine output tidak memakai satu protocol

**Evidence:** `exec --json` streaming raw `session.events("*")` pada
`cli/commands/exec.ts:126-139`; ACP juga subscribe raw pada
`cli/commands/acp.ts:290-303`, lalu menggabungkan text delta dan partial lifecycle.

**Problem:** `exec` tidak mempunyai canonical schema/version yang sama;
ACP bergantung pada keberadaan `onPresentationEvent` dan fallback legacy tool event.

**Impact:** Client harus menangani event raw, semantic event, dan summary dengan
bentuk berbeda. Perubahan internal dapat mengubah machine contract tanpa gate.

**Recommendation:** Buat mapper `machineProjection()` dari `DomainEvent`/snapshot;
exec dan ACP memakai envelope yang sama, dengan ACP JSON-RPC sebagai transport
wrapper. Tetap lakukan scrub dan test wire contract.

**Update Phase 6:** `toMachineEnvelope()` di `src/presentation/projection.ts`
menghasilkan `minicode.output.v1`; `exec --json` streaming envelope + summary
berversi + setup-failure selalu ber-envelope; ACP memetakan lifecycle penuh
(file/test/diagnostic/checkpoint/plan/finding/result/context) dengan framing
JSON-RPC yang sama. Legacy `type:"tool"` hanya bila lifecycle absen.

#### OAP-007 — P1 — Durable rebuild belum dipakai

**Evidence:** `rebuildFromDurable()` diimplementasikan pada
`src/presentation/reducer.ts:441-483` dan diuji pada
`test/presentation-reducer.test.ts:289-323`, tetapi tidak ditemukan call production;
`cli/setup.ts:1029-1038` hanya persist session messages/usage.

**Problem:** Setelah restart, presentation model tidak direkonstruksi dari semantic
lifecycle; yang ada adalah message/session persistence dan recovery text.

**Impact:** Status interrupted, approval close, summary, dan correlation historical
tidak dapat diverifikasi oleh renderer yang baru.

**Recommendation:** Pilih durable event log minimal (journal/session store),
serialize canonical events, dan rebuild saat `createCliSession`/resume. Delta tidak
perlu disimpan; final state harus.

#### OAP-008 — P2 — Direct-print policy tersebar

**Evidence:** Writes permanent/transient ada di `cli/index.ts:90-505`,
`cli/setup.ts:208-1036`, `cli/commands.ts:196-433`, approval
`src/ui/approval/prompt.ts:24-149`, `turn-status.ts`, `statusline.ts`, serta
popup/form/input modules.

**Problem:** `statusline.ts` melindungi transient owner dan interactive screen,
tetapi tidak menjadi semantic router untuk semua output.

**Impact:** Jalur setup/verify/manager baru dapat menulis ke stream yang salah atau
mencemari alt-screen/machine stream.

**Recommendation:** Buat writer registry/sink (`humanPermanent`, `humanDiagnostic`,
`machine`, `tui`) di composition root. Legacy direct writes boleh selama
diinventory dan diberi guard, tetapi tidak boleh menjadi jalur default baru.

#### OAP-009 — P2 — Visibility policy tidak seragam

**Evidence:** `simple.ts` menentukan `verbose`/answer visibility secara lokal;
`Transcript` hanya memiliki mode reasoning/minimize; `ACP` selalu meminta
`verbose: false` pada `cli/commands/acp.ts:260-268`; TUI dan linear tidak memakai
satu policy snapshot.

**Problem:** “normal”, “verbose”, “debug”, dan “machine” bukan satu konsep yang
dihasilkan dari model yang sama.

**Impact:** Tool status/receipt dapat muncul berbeda, dan debug dapat memilih
field yang tidak tersedia pada machine stream.

**Recommendation:** Definisikan `PresentationPolicy`/`ProjectionMode` bersama;
mode hanya memilih node/verbosity, bukan mengubah status runtime.

#### OAP-010 — P2 — Klasifikasi outcome masih stringly typed di beberapa jalur

**Evidence:** `adapter.ts:125-135` memakai `classifyToolResult`, `denyReasonOf`, dan
regex `mapToolFailCause`; `simple.ts:597-615` dan `transcript.ts:601-633` memakai
`result.isError`/text untuk status terminal.

**Problem:** Satu result dapat menjadi denied di adapter tetapi failed di raw sink
jika bentuk/urutan event berbeda.

**Impact:** Mode yang berbeda dapat menampilkan kategori error berbeda.

**Recommendation:** Canonical outcome hanya boleh lahir di adapter/kernel seam;
fallback string hanya diagnostics dan harus menghasilkan anomaly counter.

#### OAP-011 — P2 — Vocabulary memiliki event tanpa producer

**Evidence:** Phase 2 kini memiliki producer untuk `reasoning.completed`,
`plan.updated`, `finding.detected` dari `submit_result` terstruktur,
`result.produced`, `diagnostic.raised`, `test.completed` dari verify terstruktur,
dan `checkpoint.created`; hanya `tool.progress` yang masih ditandai proposed
karena live-only.

**Problem:** Tipe dan durability map menjanjikan event yang belum menjadi kontrak
produksi.

**Impact:** Test dapat lulus untuk event buatan sementara jalur nyata tidak pernah
menghasilkan event tersebut.

**Recommendation:** Tandai event sebagai `proposed`, `derived`, atau `runtime`; jangan
jadi aggregate bersama dengan lifecycle inti.

#### OAP-012 — P2 — User, plan, dan finding belum semantic

**Evidence:** Phase 2 kini memiliki `user.message`, plan object dari
`todo_write`, tipe `Finding` di model, dan producer `finding.detected` dari
`result.findings` eksplisit pada `submit_result`.

**Problem:** Activity, future work, dan evidence finding tidak dapat dipisahkan
sesuai prinsip output architecture.

**Impact:** Plan dapat disalahartikan sebagai replay aktivitas; normal mode tidak
tahu node mana yang actionable.

**Recommendation:** Tambahkan semantic nodes terpisah: `user.message`,
`plan.created/updated`, `finding.detected`, `result.produced`; tool tetap activity.

#### OAP-013 — P2 — Dokumentasi dan proteksi belum sinkron dengan aktual

**Evidence:** `docs/UI_RENDER_PIPELINE.md:112-116` menyatakan tidak ada event runtime
yang diabaikan UI, tetapi `cli/setup.ts:530-532` meng-drop event yang tidak
memiliki projection; `PLAN.md:158-300` masih menandai mouse selection belum
implementasikan.

**Problem:** Plan/document tidak lagi menjadi sumber status yang dapat dipercaya.

**Impact:** Agent berikutnya dapat mengulangi pekerjaan atau tidak menjalankan
remediation yang sebenarnya sudah ada.

**Recommendation:** Update plan/artifact links dan tambahkan test contract yang
memeriksa event coverage, bukan hanya output string.

## Rekomendasi arsitektur

Target yang direkomendasikan:

```text
Agent Runtime
    ↓
Semantic Event Boundary
    ├─ durable semantic events
    └─ live deltas/progress
    ↓
Pure Reducer → PresentationState + ContentRef
    ↓
Policy Projection (normal | verbose | debug | machine)
    ├─ TUI renderer
    ├─ Linear renderer
    ├─ exec JSONL projection
    ├─ ACP projection
    └─ future web/API
```

Prinsip yang dipertahankan:

- `vendor/minicore/**` tetap frozen; seam adapter cukup untuk fase awal.
- `PresentationState` menyimpan status/correlation/receipt refs, bukan terminal state
  atau payload besar.
- Renderer hanya memilih layout dan interaksi; tidak menginfer status dari teks.
- Sanitasi/depth/wrapping/ownership terminal tetap menjadi gerbang terakhir.
- Migrasi staged dan dapat dibalik dengan flag; tidak melakukan flag-day rewrite.

## Validation gate untuk audit ini

- [x] Pipeline runtime → raw bus → adapter → reducer → consumer ditelusuri.
- [x] TUI, linear, exec, ACP, approval, diagnostics, clipboard diinventaris.
- [x] Event vocabulary dan output mode dibandingkan dengan producer aktual.
- [x] Temuan memiliki severity, evidence, problem, impact, recommendation.
- [ ] Canonical projection dan remediation belum diimplementasikan pada artefak ini.
- [ ] Resume/replay production, parity test, dan golden machine fixtures masih
      menjadi pekerjaan fase berikutnya.

## Deliverable berikutnya

- Model event: `docs/OUTPUT_EVENT_MODEL.md`
- Protocol/mode/stream: `docs/OUTPUT_PROTOCOL_SPEC.md`
- Renderer boundary: `docs/OUTPUT_RENDERING_SPEC.md`
- UX grammar: `docs/OUTPUT_UX_RULES.md`
- Migration plan: `docs/OUTPUT_IMPLEMENTATION_PLAN.md`
