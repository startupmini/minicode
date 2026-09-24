# MINIcode — Agent Presentation Architecture V2
## Architecture Review & Design Report (no implementation)

> Verifikasi: seluruh klaim di bawah dibaca dari implementasi, bukan dokumen. Acuan file:line adalah bukti.

---

## A. Executive Verdict

**Yang salah secara fundamental: MiniCode tidak memiliki lapisan semantik antara runtime agen dan presentasi. Yang ada adalah: event kernel yang miskin → transformasi UI-spesifik di dua sink yang divergen → transkrip `string[]`.**

Bukan "UI kurang cantik". Buktinya:

1. `vendor/minicore/src/core/events.ts:5-14` hanya 9 varian; tidak ada `turn.failed/cancelled`, `tool.progress/denied/duration`, `approval.*`, `finish/stop-reason`. `ProviderEvent{tool_call,finish}` (`provider.ts:20-24`) dikonsumsi internal `loop.ts:129-134` dan tidak pernah di-emit ulang — `finish{stop,tool_calls,length,abort,error}` hilang sebagai data.
2. `runCall` (`executor.ts:40-104`): jalur `unknown tool` (`:44`), `permission deny` (`:58-69`), `invalid args` (`:72-73`) me-return `errorResult` **tanpa emit apapun**. Komentar app sendiri mengakui: *"kernel hanya meng-emit `execution:*` untuk call yang lolos gate"* (`trace.ts:98-100`, `setup.ts:465-469`).
3. `session.run` (`session.ts:215-256`) transaksional: gagal/abort/timeout dibuang (`:240-244`), `turn:completed` hanya di-emit pada sukses (`:248`). Abort = diam di bus.
4. `src/ui/contract.ts:13-55` mendegradasi, bukan memperkaya: `UiStep` tanpa `results`, `UiExecution` tanpa `id/toolCallId/role`, `turn:completed.result?:unknown` lalu diabaikan kedua sink. Klaim "tanpa adapter" (`:9-11`) = cast `as unknown as UiBus` (`cli/tui.ts:121,459`).
5. Dua presenter divergen tanpa model bersama: `simple.ts` (647 baris, 7 cabang render per-tool, diff-card, preview adaptif `rows`) vs `transcript.ts` (291 baris, compact-only by design `:8-9`, ledger 1 baris + buffer `/expand` 10×2000 char `:19-21`, buang semua `extension` non-reasoning `:109`). Cap/marker thinking berbeda (200K+marker vs 20K slice).
6. `Transcript.lines: string[]` (`transcript.ts:62`) mencampur Conversation+Activity+Result+Diagnostics tanpa `kind/seq/id`. `/expand` sekali-habis (`:177-181`) + reset tiap turn (`simple.ts:297`). Ground truth (duration/denyReason/journal seq/checkpoint id) ada di file (`journal.ts`, `trace.ts:29-52`, checkpoint via `setup.ts:421-463`) tetapi tidak punya join key yang tampil di layar.
7. Approval bukan event: DI callback `ask: promptAsk` (`setup.ts:390`), `setAskTextFn(promptAskText)` (`setup.ts:362`); view `prompt.ts:24-150` memakai global `ApprovalSink` (`transcript.ts:39-47`) + `suspend/resume`. ACP/exec/trace tidak melihat approval sebagai data.

Renderer terminal justru aset matang (sanitasi, width kolom, transient arbitration, coalesce 30ms, resize I11/I30, non-TTY deterministik I6, approval tercatat I23, sinyal I31, PTY byte-nyata). **Jangan tulis ulang renderer. Bangun semantik sebelum rendering.**

---

## B. Current Architecture (aktual di kode)

```text
User Input (prompt-engine / askLine / popup form)
  ↓
cli/index.ts → cli/args.ts → cli/router.ts (dispatch subcommand vs TUI)
  ↓
cli/setup.ts :: createCliSession — COMPOSITION ROOT
  ├─ app/provider-layer.ts (router + setupWhenEmpty wizard)
  ├─ app/tool-layer.ts (37 tool + MCP append)
  ├─ app/rag-layer.ts, app/mentions.ts
  ├─ createMinicodeSession {ask: promptAsk} + setAskTextFn(promptAskText)
  ├─ journal (intent=execution:started, terminal=execution:completed)
  ├─ checkpoint (pre-turn snapshot + post-edit snapshot → recordCheckpoint)
  ├─ step-trace (tool+step → step-traces.jsonl; deny via klasifikasi string!)
  └─ attachUI per-turn: attachSimpleLogger{verbose,quiet} + attachTurnStatus
  ↓
MiniCore kernel (vendor/, frozen, hanya seam aditif)
  session.run (transaksional, timeout 10 mnt default :31, busy guard :217)
    → loop.executeTurn (maxSteps 50 :55; budget/compact :57-84; retry/recovery :96-192)
      → provider.stream → ProviderEvent{text,tool_call,finish,extension}
        → emit ulang HANYA text + extension (loop.ts:123,126,115)
      → step:started (loop.ts:208) → executor.execute → runCall per call
        → step:completed (loop.ts:248) → repeat / finalText → return TurnResult
      // turn:completed di-emit oleh session.ts:248 (sukses saja)
  ↓
EventBus kernel (events.ts:35-73; isolasi per-handler; wildcard "*")
  ↓ cast struktural
UiBus (contract.ts:53-55, handler any karena kontravariansi)
  ├─ simple.ts — printer linier; quiet menekan paint tapi state jalan (:122-126)
  ├─ Transcript — TUI compact-only; pending/commit; ledger; sections /expand
  ├─ App (tui/app.ts) — pemilik TUNGGAL layar; repaint coalesce 30ms
  ├─ turn-status.ts — transient stderr; grace 250ms; latch anti-strobo; endTurn manual
  ├─ exec.ts "*" mentah → stdout JSONL / ringkasan
  └─ acp.ts notifikasi lossy {text,delta}/{tool,name} + cap + scrub
  ↓
Terminal: alt-screen fullscreen (interaktif) | polos deterministik (non-TTY)
Persistensi (tak tampil): sqlite messages/turns, journal intent/terminal,
  checkpoint tree/snapshot, traces.jsonl + step-traces.jsonl (scrubbed, chmod 600)
```

Tipe kunci: `AgentEvent` (9), `ProviderEvent` (4), `UiEvent` (9, degradasi), `UiBus`, `Step{index,toolCalls,results}`, `Execution{call,result}`, `TurnResult{steps,finalText,usage}`, `JournalRecord{id,session,seq,tool,kind,state,paths,argsHash,childSessionId}`, `StepTrace{kind,step,tool,ok,denied,denyReason,durationMs,args,sandbox,totalTokens}`, `RunTrace{...}`, `ApprovalRequest{name,args}`, `ApprovalSink{pushBlock,repaint,suspend,resume}`.

State machine aktual (implisit, tersebar): `loop` (budget→compact→stream→dispatch→step→repeat), `session.run` (idle→running→commit/discard), `runCall` (resolve→permission→validate→execute→normalize/truncate), `permission` (6 mode + promptAskOr + raceAbort), `turn-status` (turnOn/textOn/textSeen latch + grace), `App` (busy freeze kecuali abort/scroll), `Transcript` (stream→pending→commit/ledger). **Tidak ada satu state machine eksplisit yang memiliki lifecycle.**

---

## C. Fundamental Problems

### P0 — Architectural (fondasi; tanpa ini semua polish sia-sia)

1. **Event lifecycle tidak lengkap.** Abort/gagal/timeout diam; deny/unknown/validate diam; `finish` reason hilang; approval bukan event. Renderer tidak bisa menampilkan yang tidak di-emit.
2. **Tidak ada Presentation Model bersama.** Dua sink menafsir event mentah sendiri-sendiri dan divergen. Setiap frontend baru (Web/API) akan mengulang divergensi.
3. **Transkrip tak bertipe (`string[]`).** Tanpa `kind/seq/id`, filter/replay/join/korelasi mustahil. `/expand` sekali-habis adalah gejala, bukan desain.
4. **Identitas & korelasi hilang di batas presentasi.** `toolCall.id` ada di kernel (`ToolCall.id`, `ToolResult.toolCallId`) tetapi dibuang di `UiExecution`; `journal.seq`, `checkpoint turn`, `trace duration/denyReason` tidak tampil. Pertanyaan "hasil ini dari tool apa, turn apa, approval apa, checkpoint apa" tidak terjawab dari layar.
5. **Akhir-turn tiga strategi.** `simple detach-flush` vs `Transcript pending-tertunda` vs `turn-status endTurn-manual` — satu kejadian (abort) ditangani tiga cara karena kernel diam.

### P1 — Structural (abstraksi hilang)

6. Kontrak degradatif + cast tanpa adapter (`contract.ts`, `tui.ts:121,459`).
7. Sanitasi dua waktu (stream vs commit); truncation di event-time berbasis `rows` (`simple.ts:100-102`) bukan render-time.
8. Tool labeling tiga versi (`toolSummary` vs `toolLabel` vs `ledgerTarget`; cap 120/80/200).
9. Progres hanya transient (hilang saat teks mengalir — latch `turn-status.ts:267-274`); tidak ada activity persisten.
10. Persist vs tampil tanpa join key; `stdout vs stderr` (kontrak I2) hilang di viewport TUI satu-frame.
11. Error satu representasi (`isError` + first-line 200 kolom) untuk 9 kelas kegagalan berbeda.

### P2 — Presentation (terpecahkan setelah P0/P1)

12. Ledger hanya `completed`; `started` hilang di compact (`simple.ts:442-447`; `transcript.ts:86-89` commit saja).
13. Result ringkas generik (first-line 80) bukan ringkasan terstruktur per jenis tool.
14. Consequence invisible (file berubah? checkpoint id? test passed/failed terstruktur?).
15. Thinking cap/marker inkonsisten antar sink; `usage/bash-output/content_filter/error` dibuang TUI.
16. Completion pada abort diam; tidak ada ringkasan turn (tools ok/fail/denied, files, checkpoint).

### P3 — Visual polish (terakhir)

17. Warna/ikon/spacing/glyph fallback, hint footer, i18n string baru. Dilarang dikerjakan sebelum P0/P1 hijau.

---

## D. Proposed Agent Presentation Architecture v2

Prinsip penentu: **satu `reduce` (event→model), banyak proyeksi (model→layar). Renderer tidak pernah melihat event mentah.**

```text
                    ┌──────────────────────┐
                    │    Agent Runtime     │
                    │ MiniCore (frozen) +  │
                    │ app-layer (policy,   │
                    │ journal, checkpoint) │
                    └──────────┬───────────┘
                               │ emit (diperkaya via seam/adaptor,
                               │       BUKAN ubah kernel membabi-buta)
                               ▼
                    ┌──────────────────────┐
                    │  Domain Events v2    │
                    │ kaya + lifecycle     │
                    │ eksplisit + ber-ID   │
                    └──────────┬───────────┘
                               │  ┌──────────────┐
                               │  │ Trace/Journal│ (durable, scrubbed)
                               │  │ Checkpoint   │ (durable, tree/snapshot)
                               │  └──────────────┘
                               ▼
                    ┌──────────────────────┐
                    │ Presentation Reducer │
                    │ murni, sinkron,      │
                    │ testable tanpa TTY   │
                    │ event-seq → model    │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │ Presentation Model   │
                    │ terstruktur, ber-ID, │
                    │ queryable, replayable│
                    │ (SATU kebenaran)     │
                    └──────┬───┬───┬───┬───┘
                           │   │   │   │
              ┌────────────┘   │   │   └────────────┐
              ▼                ▼   ▼                ▼
        ┌──────────┐    ┌──────────┐ ┌────────┐ ┌────────┐
        │TUI proj. │    │Linear    │ │ACP     │ │Web/API │
        │(compact +│    │proj.     │ │proj.   │ │/Logs   │
        │ expand q)│    │(expanded)│ │(lossy) │ │(nanti) │
        └────┬─────┘    └────┬─────┘ └───┬────┘ └───┬────┘
             │               │           │          │
             ▼               ▼           ▼          ▼
        ┌──────────────────────────────────────────────┐
        │  Renderer boundary (ASET MATANG, JANGAN UBAH) │
        │  sanitize/width/wrap/theme/transient/repaint │
        │  resize/cursor/non-TTY/approval-TUI/sinyal   │
        └──────────────────────────────────────────────┘
```

Alasan bentuk ini (bukan alternatif "percantik TUI" atau "event-sourcing enterprise"): ia menyelesaikan 5 masalah P0 dengan komponen paling sedikit — (a) event kaya menutup kebisuan, (b) reducer murni memisahkan makna dari piksel, (c) satu model menghentikan divergensi, (d) ID/korelasi menjawab join, (e) proyeksi menjelaskan TUI vs linear vs ACP tanpa duplikasi semantik. Tidak ada framework; hanya tipe + fungsi murni + adaptor tipis.

---

## E. Event Model

**Sumber kebenaran baru: Domain Events v2 adalah bahasa semantik; `AgentEvent` lama tetap di wire selama migrasi (adaptor, bukan flag-day).**

Minimal vocabulary (setiap event di bawah menutup gap evidence; tidak ada yang dekoratif):

```ts
// Identitas dilewatkan di setiap event (lihat §F).
type Base = { eventSeq: number; ts: number; sessionId: string; turnId: number };

// — Turn —
type TurnStarted     = Base & { type: "turn.started"; turnId: number; promptRef: string };
type TurnCompleted   = Base & { type: "turn.completed"; turnId: number; summary: TurnSummary };
  // summary: { toolsOk, toolsFailed, toolsDenied, filesChanged, checkpointId?, durationMs }
type TurnFailed      = Base & { type: "turn.failed"; turnId: number; error: AgentErrorInfo };
type TurnCancelled   = Base & { type: "turn.cancelled"; turnId: number; reason: "abort"|"timeout"|"budget"|"signal" };

// — Model / reasoning (ganti provider:extension generik tak bertipe) —
type ModelDelta      = Base & { type: "model.delta"; turnId: number; delta: string };
type ModelCompleted  = Base & { type: "model.completed"; turnId: number; text: string };
type ReasoningDelta  = Base & { type: "reasoning.delta"; turnId: number; delta: string };
type ReasoningCompleted = Base & { type: "reasoning.completed"; turnId: number; truncated: boolean };

// — Tool (inti coding agent) —
type ToolStarted     = Base & { type: "tool.started"; toolCallId: string; turnId: number; stepId: number;
                                name: string; argsSummary: ArgsSummary };
type ToolProgress    = Base & { type: "tool.progress"; toolCallId: string; message: string };
  // di-emit oleh tool long-run (bash/code_run/delegate_task) via ctx.emit — seam aditif
type ToolCompleted   = Base & { type: "tool.completed"; toolCallId: string; durationMs: number;
                                resultSummary: ResultSummary; expandRef: ExpandRef };
type ToolFailed      = Base & { type: "tool.failed"; toolCallId: string; durationMs: number;
                                category: "exec-error"|"validate"|"unknown"|"provider"|"timeout";
                                message: string; hint?: string; expandRef: ExpandRef };
type ToolDenied      = Base & { type: "tool.denied"; toolCallId: string; reason: DenyReason;
                                message: string };
  // DenyReason: "jail"|"sensitive"|"allowlist"|"bash-guard"|"mode"|"no-approval"|"user" (+ raw ≤80 char)
type ToolCancelled   = Base & { type: "tool.cancelled"; toolCallId: string; reason: "abort"|"timeout" };

// — Approval (menjadi DATA, bukan sekadar callback) —
type ApprovalRequested = Base & { type: "approval.requested"; approvalId: string; toolCallId: string;
                                  name: string; argsSummary: ArgsSummary };
type ApprovalResolved  = Base & { type: "approval.resolved"; approvalId: string; toolCallId: string;
                                  decision: "allow"|"deny"|"always"; by: "user"|"system" };

// — Konsekuensi & konteks —
type FileChanged     = Base & { type: "file.changed"; toolCallId: string; paths: string[];
                                checkpointId?: string; journalSeq?: number };
type TestCompleted   = Base & { type: "test.completed"; toolCallId: string; passed: number;
                                failed: number; summary: string };
type ContextCompacted = Base & { type: "context.compacted"; reason: string };

type DomainEvent = TurnStarted | TurnCompleted | TurnFailed | TurnCancelled
  | ModelDelta | ModelCompleted | ReasoningDelta | ReasoningCompleted
  | ToolStarted | ToolProgress | ToolCompleted | ToolFailed | ToolDenied | ToolCancelled
  | ApprovalRequested | ApprovalResolved | FileChanged | TestCompleted | ContextCompacted;
```

Untuk tiap event:

| Event | Emit oleh / kapan | Data | Persist? Replay? | Konsumen model | Proyeksi butuh | Bila hilang | ID/seq? |
|---|---|---|---|---|---|---|---|
| `turn.started/completed/failed/cancelled` | session wrapper (`session.ts` + adaptor app-layer yang menutup abort/timeout diam) | turnId, summary/error/reason | ya (trace) / ya | Turn panel + ringkasan | semua | abort diam (bug hari ini) | turnId+eventSeq |
| `model.delta/completed` | adaptor dari `provider:text` + `TurnResult.finalText` (yang hari ini dibuang) | delta/text utuh | delta tidak; completed ya | Conversation | TUI+Linear+ACP | finalText hilang | turnId |
| `reasoning.delta/completed` | adaptor dari `extension:reasoning` + batas turn | delta, truncated flag | ringkas ya | Thinking (L3) | TUI(/expand)+Linear(verbose) | cap inkonsisten | turnId |
| `tool.started/progress/completed/failed/denied/cancelled` | `runCall` (+ adaptor deny/validate/unknown yang hari ini diam) + `ctx.emit` untuk progress | toolCallId, name, argsSummary, durationMs, category/reason, expandRef | ya (journal+trace) / ya | Activity (inti) | semua (ACP lossy: started+completed saja) | ledger buta / lifecycle terhapus | toolCallId+stepId+turnId+eventSeq |
| `approval.requested/resolved` | permission `promptAskOr` + `promptAsk/Text` (emit di samping callback, bukan ganti callback) | approvalId, decision, by | ya (audit) / ya | Approval blok | TUI+Linear+ACP(deny-headless terlihat) | approval invisible di observability | approvalId+toolCallId |
| `file.changed` | journal `committed` + checkpoint `recordCheckpoint` (sudah ada, tinggal emit) | paths, checkpointId, journalSeq | ya / ya | Receipt | TUI(ledger badge)+Linear(receipt) | "apa berubah?" tak terjawab | toolCallId+journalSeq+checkpointId |
| `test.completed` | adaptor hasil `bash` pola test (ringkas, bukan parser universal) | passed/failed/summary | ya / ya | Receipt | TUI+Linear | test = first-line generik | toolCallId |
| `context.compacted` | sudah ada (`loop.ts:73-76,185`) | reason | ya / ya | System | semua | OK hari ini, pertahankan | turnId |

Korelasi WAJIB (`eventSeq` monotonik per sesi untuk ordering + replay; `ts` untuk duration; semua ID di §F). Tanpa korelasi, event kaya pun tetap string log.

---

## F. Identity / Correlation Model

Hanya ID yang menjawab pertanyaan korelasi. Tidak lebih (anti-over-engineering):

```text
sessionId    — sudah ada (journal.session, trace.sessionId). Pemilik: app-layer (cli/setup).
turnId       — BARU sebagai ID kelas-satu (hari ini hanya `turn: number` + `usage.turns`).
               Pemilik: session wrapper. Alasan: semua korelasi bermuara ke turn.
stepId       — sudah ada (Step.index). Pemilik: loop. Alasan: grouping tool paralel.
toolCallId   — sudah ada di kernel (ToolCall.id) tetapi DIBUANG di UiExecution.
               Pemilik: kernel (tak berubah). Aturan baru: DILARANG dibuang di batas presentasi.
approvalId   — BARU (`${turnId}:${toolCallId}` atau uuid per promptAskOr call).
               Pemilik: permission/app-layer. Alasan: requested↔resolved + audit.
checkpointId — sudah ada (turn-based recordCheckpoint). Pemilik: checkpoint.
               Alasan: file.changed → "restore apa?".
journalSeq   — sudah ada (JournalRecord.seq). Pemilik: journal.
               Alasan: file.changed → "komitmen ke berapa?".
eventSeq     — BARU (monotonik per sesi, ditetapkan adaptor/reducer).
               Alasan: ordering + replay deterministik (media: retry/recovery bisa emit ulang).
expandRef    — BARU ({toolCallId} + index konten). Pemilik: reducer.
               Alasan: /expand queryable (bukan buffer posisi).
```

Relasi eksplisit (disimpan di model, bukan disimpulkan string-match):

```text
turn (1) ──< step (n) ──< toolCall (n, toolCallId)
toolCall (1) ──< approval (0..1, approvalId)
toolCall (1) ──< result (1, expandRef) ──< fileChanged (0..n) + testCompleted (0..1)
turn (1) ──< checkpoint (0..1, checkpointId) + journalSeq range
event (n) ── seq ordering ──> replay deterministik
```

Jawaban pertanyaan korelasi: semua via `toolCallId` (hasil←tool), `turnId/stepId` (milik turn), `approvalId` (penyebab), `paths+checkpointId+journalSeq` (akibat file), `expandRef/toolCallId` (diagnostik milik eksekusi). `describeDenial` tetap seam kernel (sudah benar di `permission.ts:22`, `executor.ts:64`); yang berubah adalah deny menjadi **event** dengan `reason` terstruktur, bukan sekadar suffix string observasi model.

---

## G. Presentation Model

Satu tipe, dimiliki reducer murni. Bukan `string[]` lain.

```ts
// src/presentation/model.ts (lokasi usulan; lihat §P)
type ToolStatus = "running"|"completed"|"failed"|"denied"|"cancelled";
type TurnStatus = "running"|"completed"|"failed"|"cancelled";

interface ActivityEntry {           // SATU baris hidup per toolCall — lifecycle tak terhapus
  kind: "tool";
  seq: number; tsStart: number; tsEnd?: number; durationMs?: number;
  turnId: number; stepId: number; toolCallId: string;
  name: string; target?: string;          // path / `$ cmd` — labeler TUNGGAL (§N)
  status: ToolStatus;
  progress?: string;                       // terakhir dari tool.progress
  summary?: string;                        // ringkasan terstruktur per jenis tool
  error?: { category: string; message: string; hint?: string };
  denyReason?: DenyReason;
  approvalId?: string;
  expandRef?: ExpandRef;                   // pointer ke konten penuh (bounded)
  receipt?: ReceiptRef;                    // pointer ke file.changed/test (lihat §L)
}

interface ConversationEntry { kind: "message"; seq: number; turnId: number;
  role: "user"|"assistant"; text: string; }          // teks FINAL (bukan delta)
interface ReasoningEntry { kind: "reasoning"; seq: number; turnId: number;
  truncated: boolean; expandRef: ExpandRef; }        // L3, di belakang /expand default
interface ApprovalEntry { kind: "approval"; seq: number; turnId: number;
  approvalId: string; toolCallId: string; name: string;
  decision?: "allow"|"deny"|"always"; by?: "user"|"system"; }
interface SystemEntry { kind: "system"; seq: number; turnId: number;
  text: string; }                                    // compacted, completion, cancel
interface TurnEntry { kind: "turn"; seq: number; turnId: number;
  status: TurnStatus; summary?: TurnSummary; }

interface PresentationModel {
  sessionId: string;
  seq: number;                                   // eventSeq terakhir — basis replay
  turns: Map<number, TurnEntry>;
  activities: Map<string, ActivityEntry>;        // key toolCallId — MUTABLE (running→final)
  order: EntryRef[];                             // append-only urutan tampil
  conversation: ConversationEntry[];             // append-only
  approvals: Map<string, ApprovalEntry>;         // mutable requested→resolved
  store: ContentStore;                           // konten penuh bounded, queryable
}
```

Kepemilikan: reducer memiliki status/duration/ID/ringkasan; proyeksi memiliki layout/warna/pemotongan; renderer memiliki piksel. Append-only: conversation, order, store (dengan evict ber-marker, bukan diam-diam). Mutable: `activities` (satu entry per toolCall di-update started→final — inilah "mutable activity row" yang menyelesaikan long-run), `approvals`, `turns`. Derived: ringkasan turn (agregat activities), indikator "baru", statistik status bar. Transient: progress terakhir + spinner (proyeksi, bukan model). Persistent: semua entry + store (in-memory bounded; durable via trace/journal/checkpoint yang sudah ada). Queryable: `byToolCallId/byTurnId/byApprovalId/expand(ref)`. Replayable: `reduce(events: DomainEvent[]) → model` deterministik (tanpa clock/terminal di dalam reducer; `ts/duration` masuk sebagai data event).

---

## H. Transcript Model

Transkrip baru = **proyeksi terurut dari Presentation Model**, bukan kolektor string. Tiap baris tampil membawa identitasnya:

```ts
type TranscriptKind = "user"|"assistant"|"activity"|"approval"|"system"|"diagnostic";
interface TranscriptLine {
  seq: number; kind: TranscriptKind;
  turnId: number; toolCallId?: string; approvalId?: string;
  status?: ToolStatus | TurnStatus;
  text: string;            // SUDAH final untuk lebar saat paint (wrap saat paint tetap I11)
  expandRef?: ExpandRef;   // bila punya detail
}
```

- `ConversationEntry` → kind `user/assistant` (teks model final + prompt).
- `ActivityEntry` → kind `activity` (SATU baris per toolCall yang bermutasi `running→completed/failed/denied/cancelled` + duration; bukan dua baris started/completed terpisah yang satu dibuang).
- `ApprovalEntry` → kind `approval` (blok pertanyaan + keputusan — pertahankan perilaku I23 yang sudah benar).
- `SystemEntry` → kind `system` (compacted, turn completed/failed/cancelled + ringkasan).
- `ReasoningEntry`/diagnostik → kind `diagnostic` (tak tampil default; ada via `/expand`/flag).
- Cap 5000 (I12) dipertahankan sebagai **batas proyeksi/viewport**, bukan batas model: evict baris tampil wajib ber-marker (`… N baris awal dipadatkan — lihat log`), tidak diam-diam (`transcript.ts:287-289` hari ini diam). Store konten bounded terpisah (mis. 200K/entry, total 500K mengikuti angka `collapse.ts` yang sudah teruji — tetapi sebagai **store queryable**, bukan buffer sekali-habis).

---

## I. Tool Lifecycle

Satu entry, empat ujung. Lifecycle tidak pernah dihapus — hanya berubah status:

```text
started (ActivityEntry{status:running, tsStart})
  ├─→ progress* (update .progress — bash/code_run/delegate_task via ctx.emit)
  ├─→ completed {durationMs, summary, expandRef, receipt?}
  ├─→ failed {durationMs, category, message, hint, expandRef}
  ├─→ denied {denyReason, message}            // terminal cepat; tetap entry persisten
  └─→ cancelled {reason: abort|timeout}       // abort/timeout yang hari ini diam
```

Perilaku presentasi per transisi (TUI compact default):

- `started`: baris `› name target … running` muncul SEGERA (menutup lubang "compact tanpa baris start" `simple.ts:442-447`). Untuk tool <2s, baris ini langsung menjadi baris hasil (tanpa flicker — update in-place di model, proyeksi memutuskan repaint).
- `progress`: update baris yang sama (pesan terakhir) + elapsed hidup. Tidak menambah baris.
- `completed`: baris final `› name target · 3s` + ringkasan per jenis (read→`N baris`; edit→`+a -b path`; bash→`exit 0 · N baris`; test→`✓ 48 passed` via `test.completed`). Detail penuh di `expandRef`.
- `failed`: baris merah `› name: kategori — pesan` + hint (`coba X`) bila ada; stack di `expandRef`. Kategori tampil (`denied|validate|error|timeout`) — akhiri first-line generik.
- `denied`: baris kuning/merah `› name ⊘ denied (bash-guard: …)` — deny menjadi peristiwa kelas-satu yang terlihat, bukan observasi model yang tak sampai layar.
- `cancelled`: baris redup `› name ○ cancelled (abort)` — abort terlihat sebagai status, bukan kekosongan.

Semua transisi membawa `durationMs` (diukur adaptor dari `tsStart→tsEnd`, bukan dari spinner). Semua status final membawa `expandRef`. Tidak ada cabang render per-sink yang berbeda makna — perbedaan TUI vs linear hanya **berapa banyak** yang tampil (satu baris vs preview), bukan **apa kebenarannya**.

---

## J. Long-Running Task Model

Untuk 5/10/15+ menit (analisis repo besar, test suite, build, migrasi, install, loop debug):

1. **Activity persisten, bukan spinner transient.** Setiap tool aktif memiliki `ActivityEntry{running}` yang survive teks model mengalir (spinner `turn-status` tetap sebagai heartbeat, tetapi kebenaran ada di model). Aturan tampil: tool aktif selalu terlihat (pinned/durasi), tool selesai diringkas.
2. **Duration kelas-satu.** `elapsed` hidup untuk running (≥2s tampil, mengikuti ambang `turn-status.ts:129-134` yang sudah teruji); `durationMs` final di ledger. Tanpa duration, user tidak bisa membedakan "macet" vs "lama yang wajar".
3. **Progress untuk yang bisa progres.** `tool.progress` via `ctx.emit` (seam aditif; sukarela per tool: `bash` streaming potongan, `delegate_task` fase anak, `code_run` tahap). Proyeksi menampilkan pesan terakhir + elapsed di baris yang sama. Tool tanpa progress tetap punya heartbeat (elapsed + spinner) — tidak diam.
4. **Ringkasan turn berjalan.** Status bar / baris sistem menampilkan `turn N · tool i/n · elapsed total` dari sumber yang sama dengan angka sesi (prinsip I13). Bukan "busy" buta.
5. **Sesi panjang tetap readable.** Model bounded + evict ber-marker; ringkasan turn (`tools ok/fail/denied, files changed, checkpoint`) sebagai jangkar navigasi — user bisa kembali membaca keputusan penting tanpa scroll 5000 baris mentah. Scroll + kunci posisi baca + indikator `↓N` yang sudah benar (`app.ts:864-882`) dipertahankan; yang ditambah adalah **isi yang layak dibaca ulang** (ringkasan terstruktur, bukan dump).

Uji long-run: aktivitas 10 menit dengan 50 tool berurutan harus menghasilkan (a) setiap tool tepat satu entry final, (b) durasi terisi semua, (c) replay event menghasilkan model identik, (d) viewport TUI + linear konsisten.

---

## K. Error / Failure Model

Sembilan kelas, tiga visibilitas. Jangan pernah `error: something went wrong`.

| Kelas | Contoh | Tampil di ledger (L1) | Detail (L2/L3) |
|---|---|---|---|
| Denied (policy) | jail, sensitive, allowlist, bash-guard, mode, no-approval, user-decline | `⊘ denied (alasan)` — SELALU tampil sebagai entry | alasan ≤80 char + aturan; join ke trace denyReason |
| Validation | invalid args, unknown tool | `✗ invalid args: …` | skema yang diharapkan (L3) |
| Execution failure | tool throw, exit≠0 | `✗ failed: first-line` + hint bila ada | stack/output penuh di expandRef |
| Provider failure | auth, rate_limit, network, length, content_filter | `✗ provider (kategori): pesan ramah` (pertahankan `errors.ts` friendly+redact) | kategori + retry info (L3) |
| Timeout | turn/tool timeout (10 mnt default `session.ts:31`) | `○ timeout (Ns)` | apa yang sedang jalan saat timeout |
| Cancellation | abort user, signal | `○ cancelled (abort)` | — (bukan error) |
| Agent failure | max_steps, budget_exceeded, executor error | `✗ agent: …` + ringkasan turn | trace + journal |
| System failure | checkpoint/journal gagal tulis (degraded-loud, `journal.ts:18-21`) | warning persisten (bukan merah tool) | sesi degraded flag |
| Pending-error tengah-turn yang pulih | router fallback sukses | TIDAK tampil (pertahankan `pendingError` consume-once `simple.ts:83-93` — sudah benar) | hitung di diagnostik |

`classifyToolResult`/`denyReasonOf` (`trace.ts:101-126`, klasifikasi dari string!) diganti oleh `category/reason` terstruktur dari event — klasifikasi string hanya sebagai fallback adaptor selama migrasi, bukan kebenaran permanen.

---

## L. Consequence / Receipt Model

Setiap `tool.completed` yang bermutasi MAYA membawa receipt. Receipt menjawab *"apa yang sebenarnya terjadi karena agen berjalan?"*:

```ts
interface ReceiptRef { journalSeq?: number; checkpointId?: string; }
interface FileReceipt { paths: string[]; checkpointId: string; journalSeq: number;
  stats?: { added?: number; removed?: number }; }   // edit → +a -b (dari diff yang sudah ada)
interface TestReceipt { passed: number; failed: number; summary: string; }
interface CmdReceipt { exit?: number; durationMs: number; }
```

- Sumber: journal `committed` (sudah ada: intent→terminal, `journal.ts:9-12`) + checkpoint `recordCheckpointFromTrees/Snapshots` (`setup.ts:439-463`) + adaptor ringkas hasil `bash` pola test. Tidak ada pelacakan FS baru — hanya **emit dari kebenaran yang sudah ada**.
- Tampil: badge ringkas di baris activity (`› edit src/x.ts +14 -6 · ckpt t12`; `› bash npm test ✓ 48/0 · 12s`; `› write_file a.ts (312 chars)` — pertahankan receipt `simple.ts:490-500` yang sudah benar, tetapi sebagai data, bukan string stdout). Undo/redo (`checkpoint`) menampilkan `checkpoint restored tN` sebagai `SystemEntry` — consequence dua arah.
- Prinsip: **tidak ada aksi mutasi tanpa receipt yang bisa di-expand**. `/undo` manual hari ini (`checkpoint.ts`) menjadi navigable dari receipt (`expand(checkpointId)`).

---

## M. Projection Architecture

Satu model, empat proyeksi. Aturan pembagian yang tegas:

| Milik model bersama | Milik tiap proyeksi | DILARANG di renderer |
|---|---|---|
| status, duration, ID, ringkasan, receipt ref, error category, expandRef, ordering | berapa baris tampil, preview berapa baris, warna, wrap, layout, bahasa (i18n), interaktivitas (`/expand <id>` vs cetak penuh) | lifecycle, label semantik, truncation makna, klasifikasi error, korelasi |

- **TUI:** compact default (satu baris per activity + thinking minimized + approval blok — pertahankan grammar `›`); `expand(id)` query ke store (bisa dibuka ulang; bukan sekali-habis); pinned tool aktif + elapsed; ringkasan turn sebagai jangkar.
- **Linear (one-shot/pipe/CI):** expanded default (pertahankan transparansi shell `simple.ts`); deterministik, tanpa ANSI tak perlu (pertahankan I6); receipt + diff-card dipertahankan sebagai proyeksi, bukan logika.
- **ACP:** lossy terstruktur (pertahankan `{text,delta}/{tool,name}` + tambah `{tool.completed/failed/denied, approval.requested}` agar IDE melihat lifecycle; tetap deny-headless).
- **Web/API/Logs (masa depan):** JSON dari model langsung (tanpa parse string terminal); replay endpoint = `reduce(recorded events)`.
- Konsistensi dijamin test proyeksi: satu `model` → tiga proyeksi → semantik sama (status/ID/duration/ringkasan identik; hanya jumlah baris/warna beda).

---

## N. Renderer Boundary

**Renderer BOLEH tahu:** string final + atribut tampil (warna, redup, tebal), lebar kolom (`width.ts`), wrap (`wrap.ts`), fence/markdown dekorasi (`markdown.ts`, `highlight.ts`), kotak popup/pos (`screen.ts`, `dialog.ts`), kursor, repaint timing (coalesce 30ms), transient ownership (`statusline.ts`), i18n string, cap **tampil** per viewport.

**Renderer DILARANG tahu:** lifecycle agen (started→final), arti `isError` (deny vs fail), label semantik tool (satu labeler di reducer — akhiri `toolSummary/toolLabel/ledgerTarget` tiga versi), truncation **makna** (model simpan penuh bounded; proyeksi memotong), klasifikasi error, korelasi ID, sanitasi **keputusan** (sanitasi tetap gerbang tunggal `sanitize.ts`, tetapi dipanggil sekali di ingestion reducer — bukan dua waktu), persistensi, replay.

Labeler tunggal (arah, bukan API final):

```ts
// presentation/label.ts — SATU-SATUNYA tempat nama tool + target + ringkasan dibuat
function labelTool(name: string, args: ArgsSummary): { target?: string; summary: string };
function summarizeResult(name: string, result: unknown): string;  // per-jenis, terstruktur
```

`formatArgsPreview`, `toolSummary`, `toolLabel`, `ledgerTarget` dilebur ke sini (dengan test paritas selama migrasi).

---

## O. Migration Plan

Fase di bawah diurut agar **setiap fase hijau + rollback independen**. Tidak ada flag-day; tidak ada "delete UI".

**Fase 0 — Kunci baseline (1 hari).** Kunci gate (`tsc/lint/test/coverage/pack`) + catat metrik (jumlah test, cap, perilaku `/expand`). Rollback: tidak ada perubahan produk. File: tidak ada (hanya baseline doc).

**Fase 1 — Event kaya via adaptor (tanpa ubah kernel).** Adaptor app-layer (`src/presentation/adapter.ts` baru) subscribe `AgentEvent` lama + journal/checkpoint/trace + `TurnResult` dan memancarkan `DomainEvent` v2 ke bus baru: `tool.denied` dari `step:completed.results` yang berisi `permission denied` (menutup kebisuan tanpa sentuh `executor.ts`); `turn.failed/cancelled` dari `run()` reject/abort/timeout (menutup diam abort); `model.completed` dari `TurnResult.finalText`; `approval.requested/resolved` emit di samping `promptAsk/Text`. File: baru `src/presentation/{events.ts,adapter.ts}`; sentuh `cli/setup.ts` (wiring), `src/ui/approval/prompt.ts` (emit samping callback). Tes: event test — deny/validate/unknown/abort/timeout menghasilkan event benar. Risiko: rendah (aditif; bus lama tetap hidup). Rollback: lepas wiring adaptor.

**Fase 2 — Presentation Reducer + Model (murni, tanpa TTY).** `src/presentation/{model.ts,reducer.ts,store.ts}` + `label.ts`. Reducer: `(model, event) → model`, tanpa clock/terminal/IO. Store konten bounded (200K/entry, total 500K — angka dari `collapse.ts`, tetapi queryable). File: baru 4 file; tidak sentuh renderer. Tes: reducer test (event-seq → state) + replay test. Risiko: rendah (kode baru, belum dipakai). Rollback: hapus wiring.

**Fase 3 — Transkrip bertipe sebagai proyeksi.** Bungkus `Transcript` agar membaca dari model (adaptor `model→TranscriptLine`), pertahankan `view()`/`wrapAll`/cap/marker agar test viewport lama hijau; tambah `seq/kind/id` di belakang (tidak merusak format string). Paralel: `simple.ts` dibungkus agar label/preview dari `label.ts` (test paritas string). File: `transcript.ts`, `simple.ts` (bungkus, bukan tulis ulang), `app.ts` (baca pinned activity untuk status — kecil). Tes: proyeksi test (satu model → TUI+linear konsisten). Risiko: sedang (menyentuh dua sink; mitigasi: paritas string + PTY tetap hijau). Rollback: feature-flag `MINICODE_PRESENTATION_V2=0` kembali ke jalur langsung.

**Fase 4 — `/expand` queryable + receipt.** `expand(id)` → store/model (bisa dibuka ulang; tidak reset per turn); receipt `file.changed/test.completed` tampil di ledger + join ke checkpoint/journal. File: `cli/commands.ts` (`/expand`), `cli/tui.ts` (take→query), `transcript.ts` (sections→store view), `setup.ts` (emit file.changed). Tes: expand deterministik + receipt join. Risiko: sedang. Rollback: flag yang sama.

**Fase 5 — ACP + linear sebagai proyeksi.** ACP kirim lifecycle (`tool.completed/failed/denied`, `approval.requested`) dari model (tetap lossy + deny-headless); linear jadikan proyeksi expanded dari model (perilaku string dipertahankan via test). File: `cli/commands/{exec,acp}.ts`. Tes: ACP lifecycle + non-TTY deterministik. Risiko: rendah-sedang. Rollback: flag.

**Fase 6 — Hapus jalur usang.** Hapus buffer sekali-habis (`takeBufferedSections`), labeler ganda, klasifikasi string (`classifyToolResult` sebagai kebenaran — pertahankan sebagai fallback adaptor bila perlu), sanitasi ganda waktu. Syarat masuk fase ini: semua test baru hijau + PTY hijau + satu rilis tanpa flag dimatikan. Risiko: rendah (penghapusan setelah paritas). Rollback: revert commit (penghapusan terisolasi).

Urutan ini lebih aman karena **event dulu (Fase 1) sebelum model (Fase 2) sebelum proyeksi (Fase 3-5)** — setiap fase menghasilkan observability yang bisa diuji tanpa menunggu TUI selesai.

---

## P. Files To Change

| File | Tujuan | Risiko | Prioritas |
|---|---|---|---|
| `src/presentation/events.ts` (BARU) | `DomainEvent` v2 + ID/korelasi | rendah (baru) | P0-F1 |
| `src/presentation/adapter.ts` (BARU) | lama→v2 (deny/abort/finalText/approval emit) | rendah (aditif) | P0-F1 |
| `src/ui/approval/prompt.ts` | emit `approval.requested/resolved` di samping callback | rendah | P0-F1 |
| `cli/setup.ts` | wiring adaptor + emit `file.changed` dari journal/checkpoint | sedang (composition root) | P0-F1/F4 |
| `src/presentation/model.ts,reducer.ts,store.ts,label.ts` (BARU) | model + reducer murni + store queryable + labeler tunggal | rendah (baru) | P0-F2 |
| `src/ui/contract.ts` | perpanjang (tambah ID/korelasi; JANGAN buang field lama sampai F6) | sedang (batas lapisan) | P0-F2 |
| `src/ui/tui/transcript.ts` | proyeksi dari model; tambah kind/seq/id; evict ber-marker | sedang | P0-F3 |
| `src/ui/assistant/simple.ts` | label/preview dari `label.ts` (bungkus, bukan rewrite) | sedang | P1-F3 |
| `src/ui/tui/app.ts` | pinned activity + status dari model | rendah-sedang | P1-F3 |
| `cli/commands.ts`, `cli/tui.ts` | `/expand(id)` queryable | sedang | P1-F4 |
| `cli/commands/exec.ts,acp.ts` | proyeksi linear/ACP dari model | sedang | P1-F5 |
| `src/telemetry/trace.ts` | ganti klasifikasi string dengan category terstruktur (fallback selama migrasi) | rendah | P1-F6 |
| `src/ui/render/collapse.ts` | buffer → view atas store (F6) | rendah | P2-F6 |
| `docs/ARCHITECTURE.html`, `TERMINAL_CONTRACT.md` | update struktur + perilaku (wajib AGENTS.md) | — (dokumen) | tiap fase |

Tanpa file inventasi di luar `src/presentation/*` (4 file baru). Tidak ada "framework".

---

## Q. Files That Should NOT Be Rewritten

Aset matang — pertahankan kecuali bukti konkret menuntut perubahan (tidak ditemukan dalam audit ini):

- `src/ui/render/{sanitize,width,wrap,markdown,highlight,theme,format,errors,diff,table}.ts` — gerbang sanitasi, kolom, wrap, friendly+redact. Hanya ubah **titik panggil** (sekali di ingestion), bukan logika.
- `src/ui/runtime/{statusline,screen}.ts`, `src/ui/tui/app.ts` paint/suspend/resume/coalesce, `src/ui/input/input.ts` (I30), `src/ui/assistant/turn-status.ts` mesin transient — ownership layar, transient arbitration, resize, kursor. Hanya tambah **sumber data** (model), bukan mesin.
- `src/ui/approval/prompt.ts` lifecycle TUI (sink+suspend+repaint+fail-closed I23) — hanya tambah emit event.
- `docs/TERMINAL_CONTRACT.md` I1–I31 + peta proteksi — kontrak perilaku tetap; update dokumen bila perilaku berubah (aturan repo).
- `vendor/minicore/**` — frozen; hanya seam aditif eksplisit bila adaptor app-layer terbukti tak cukup (keputusan eksplisit + `vendor:minicore` sync; lihat `VENDOR.md`). Audit ini menemukan adaptor cukup untuk Fase 1–5.
- `src/session/journal.ts`, checkpoint wiring, `trace.ts` writer — kebenaran durable sudah benar (degraded-loud, scrub, chmod 600); hanya tambah **emit** dari kebenaran itu.
- Test matang: `pty.test.ts`, `terminal-contract`, `transient-arbitration`, `tui-app/transcript/popup`, `approval-tui`, `input-resize`, `non-tty-output`, `ui-boundary`, `exit-codes`, `exec-json-envelope`, `acp` — pertahankan + tambah kategori §R, jangan ganti.

---

## R. Test Plan

1. **Event test** (baru, `test/presentation-events.test.ts`): deny/jail/sensitive/allowlist/bash-guard → `tool.denied{reason}`; unknown/validate → `tool.failed{category}`; abort/Ctrl+C/timeout → `turn.cancelled` + `tool.cancelled`; provider length/error/abort → kategori benar; approval allow/deny/always + non-TTY→deny → `approval.requested/resolved{by}`. Setiap test wajib **gagal di kode lama** (prinsip PLAN.md #3).
2. **Reducer test** (`test/presentation-reducer.test.ts`): event-seq → model; started→progress→completed; started→denied/failed/cancelled; approval requested→resolved; file.changed join; duration terisi; labeler tunggal snapshot.
3. **Projection test** (`test/presentation-projections.test.ts`): satu model → TUI/linear/ACP — status/ID/duration/ringkasan identik; beda hanya jumlah baris/warna.
4. **Replay test** (`test/presentation-replay.test.ts`): rekam `DomainEvent[]` (termasuk retry/recovery duplikat) → `reduce` → model identik; `eventSeq` ordering deterministik.
5. **Failure test**: 9 kelas §K masing-masing minimal satu kasus + pending-error-pulih tidak tampil + degraded journal warning.
6. **Long-run test** (`test/presentation-longrun.test.ts`): 50 tool berurutan + 1 tool 10-menit-progress → satu entry per toolCall, semua duration terisi, pinned activity benar, replay identik, viewport + linear konsisten.
7. **Terminal preservation**: seluruh peta proteksi I1–I31 tetap hijau, terutama PTY byte-nyata, `input-resize`, `transient-arbitration`, `non-TTY`, `approval-tui`, `ui-boundary`. Paritas string TUI/linear selama Fase 3–5 (snapshot sebelum/sesudah).
8. **Expand/receipt test**: `expand(toolCallId)` deterministik dibuka-ulang; `file.changed→checkpointId/journalSeq` join; `test.completed` angka benar; `/expand` kosong → pesan jelas (bukan diam).

---

## S. Final Architecture Principle

> **Makna agen dulu sebagai data ber-ID; status presentasi kemudian sebagai model yang bisa di-replay; piksel terminal terakhir sebagai proyeksi yang bisa diganti.**

(Rumusan ini menggantikan "rich semantics first…" yang generik dengan tiga keputusan MiniCode-spesifik: ber-ID = korelasi menjawab join; bisa di-replay = reducer murni tanpa clock/terminal; bisa diganti = TUI/linear/ACP/Web berbagi satu model tanpa duplikasi semantik.)

---

## T. Review Rule — challenge audit sebelumnya

| Temuan audit lama | Klasifikasi | Alasan |
|---|---|---|
| "Masalah utama di presentation/event, bukan renderer" | **CONFIRMED** | Diverifikasi ulang: deny diam (`executor.ts:44,58-73`), abort diam (`session.ts:240-248`), `finish` hilang (`loop.ts:129-134`), `UiExecution` buang ID (`contract.ts:23-26`), `extension` dibuang TUI (`transcript.ts:109`), string campur (`lines: string[] :62`). Renderer justru hijau di semua race + PTY. |
| "`turn:completed` hanya sukses; abort/gagal diam" | **CONFIRMED** | `session.ts:248` dalam `try` setelah `withAbort`; `finally` hanya cleanup. `turn-status.ts:25-28` + `simple.ts:609-626` adalah kompensasi driver — bukti masalah, bukan solusi. |
| "Deny/validate/unknown tanpa `execution:*`" | **CONFIRMED** | `executor.ts:44,58-73` return tanpa emit; komentar `trace.ts:98-100` mengakui. Temuan tambahan audit ini: `describeDenial` seam sudah benar — yang hilang adalah **event**-nya, bukan alasannya. |
| "`step:completed` tanpa subscriber UI" | **CONFIRMED** dengan nuansa | Benar tak ada subscriber terminal; tetapi `setup.ts:465+` menulis `step-traces.jsonl` (deny diklasifikasi dari string). Jadi bukan "hilang total", melainkan "hanya di file, tak di layar, via klasifikasi rapuh" — memperkuat perlunya `tool.denied` terstruktur. |
| "`turn:completed.result` diabaikan" | **CONFIRMED** | `simple.ts:305-319` flush saja; `transcript.ts:82-85` commit saja; `contract.ts:35` `result?:unknown`. `finalText/steps` hilang di UI — sumber `model.completed` di desain V2. |
| "Sanitasi dua waktu" | **CONFIRMED** | `simple.ts:336` (saat stream) vs `transcript.ts:244-249` (saat commit, dari `pending` mentah `:99-105`). Jendela mentah kecil tetapi nyata; V2: sekali di ingestion. |
| "Cap/marker thinking divergen (200K+marker vs 20K)" | **CONFIRMED** | `simple.ts:153-154,387-399` vs `transcript.ts:121`. Juga `/expand` 10×2000 vs `collapse` 200K/500K — tiga angka untuk satu kebutuhan. V2: store tunggal + marker seragam. |
| "Transcript = chat+activity+terminal campur" | **PARTIALLY CONFIRMED** | Campurannya benar (`lines[]` tanpa kind), tetapi "terminal output" kurang tepat: split stdout/stderr (I2) masih dijaga di linear (`wOut` vs `wErr`), hanya hilang di viewport TUI satu-frame. V2 mempertahankan asal-stream di model (`kind` + sumber) agar proyeksi bisa memilih. |
| "TUI rugi info by-design (compact-only Fase 1)" | **SYMPTOM** (bukan akar) | Compact-only adalah keputusan proyeksi yang sah; akarnya adalah **tidak ada store queryable** sehingga compact = hilang permanen (sekali-habis + reset). V2: compact tetap, tetapi expand queryable. |
| "Overlap setengah-terbuka by design" | **CONSEQUENCE** (diterima) | `statusline.ts:228-234` kind-beda hanya warning — konsekuensi arsitektur transient satu-baris, bukan bug presentasi. V2 tidak mengubahnya (aset). |
| "Artikulasi `› read_file` cukup/tidak" | **REFINED** | Audit lama benar membedakan action/target/progress/result/error/consequence, tetapi berhenti di string. V2 menaikkan ke data: `labeler tunggal + ResultSummary + Receipt + expandRef` — ledger tetap satu baris, maknanya terstruktur. |
| Klaim implisit "rewrite TUI fullscreen sebagai tujuan" | **INCORRECT** (sebagai tujuan) | Tidak ada bukti TUI perlu ditulis ulang; semua invariant I1–I31 + PTY hijau. V2 eksplisit melarang rewrite renderer. |

**Discrepancy audit-vs-kode yang ditemukan saat verifikasi ulang:** audit lama menyebut "`UiStep` membuang results" — tepat (`contract.ts:18-21`); tetapi di kode, `step:completed` **memang membawa results penuh** di kernel (`loop.ts:241-248`) sehingga adaptor Fase 1 bisa merekonstruksi `tool.denied` tanpa ubah kernel — kabar baik yang membuat migrasi lebih aman dari yang dikesankan audit lama. Sebaliknya, audit lama kurang menekankan bahwa **`ToolCall.id` sudah ada end-to-end di kernel** (`snapshotToolCall`, `pairToolResults :275-290`) — yang membuangnya hanyalah `UiExecution` — sehingga korelasi `toolCallId` adalah perbaikan 3-baris kontrak, bukan proyek identitas besar.

---

### Evidence index (file:line kunci)

- Event bus & emit: `vendor/minicore/src/core/events.ts:5-73`, `loop.ts:34,73-76,115,123,126-134,160-164,185,208,248`, `executor.ts:44,58-73,86,102,123-139`, `session.ts:239-248`
- Kontrak degradatif: `src/ui/contract.ts:13-55`
- Dua presenter: `src/ui/assistant/simple.ts:121,206-223,260-285,289-340,343-420,423-599,609-647`, `src/ui/tui/transcript.ts:54-62,76-95,99-123,148-181,193-282,284-290`
- TUI/terminal: `src/ui/tui/app.ts:89-143,175-259,315,361-408,534-600,832-906`, `src/ui/runtime/statusline.ts:83-243`, `src/ui/runtime/screen.ts:94-222`, `src/ui/input/input.ts:195,379-387`, `src/ui/assistant/turn-status.ts:25-28,84-134,196-313`
- Render: `sanitize.ts:40-210`, `markdown.ts:23-106`, `highlight.ts:124-172`, `width.ts:40-343`, `wrap.ts:29-119`, `theme.ts:40-347`
- Tool/permission/approval: `src/tools/index.ts:59-102`, `policy/permission.ts:16,310-480,510-538`, `policy/executor.ts:64-195`, `tools/ask_user.ts:11-53`, `ui/approval/prompt.ts:24-150`, `ui/tui/transcript.ts:39-47`
- Persist vs tampil: `session/persistence.ts:115-303`, `session/journal.ts:9-12,88-199,398-474`, `telemetry/trace.ts:29-52,98-126`, `cli/setup.ts:390,407-469`
- Kontrak & proteksi: `docs/TERMINAL_CONTRACT.md:I1–I31`, `test/pty.test.ts`, `test/terminal-contract.test.ts`, `test/transient-arbitration.test.ts`, `test/approval-tui.test.ts`, `test/ui-boundary.test.ts`
