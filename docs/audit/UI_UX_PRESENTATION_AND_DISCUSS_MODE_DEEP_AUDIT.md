# UI/UX, Presentation Architecture & DISCUSS Mode — Deep Audit

**Audited SHA:** `57c59d363b3f7bafca07c050992f6ffccb227463` (`57c59d3`)
**Version:** `0.13.1` (`package.json`)
**Branch:** `main` · **Remote:** `origin = https://github.com/startupmini/minicode.git`
**Date:** 2026-11-01

> **Report path rationale.** The task requested `docs/audits/…`, but the
> repository maintains audits under **`docs/audit/`** (singular) with
> SCREAMING_SNAKE_CASE `.md` names (`PHASE-6AA-…`, `P1-P8_…`,
> `FINAL-RECONSTRUCTION-…`). `docs/audits/` does not exist. This report is
> therefore placed at `docs/audit/UI_UX_PRESENTATION_AND_DISCUSS_MODE_DEEP_AUDIT.md`
> to follow the established convention. It is the **only** repository write from
> this investigation.

---

## 1. Executive verdict

**DISCUSS is not absent.** It is a fully implemented, deterministically-enforced
policy layer ("intent layer" `WorkMode`), with complete activation surfaces
(CLI flag, env, TUI command, ACP param, exec param). Its apparent "absence" is a
**four-way product/UX gap**, *not* a missing-architecture gap:

1. **No model instruction.** DISCUSS changes **no system/developer prompt**
   (`src/app/session.ts:163-170` — only permission-mode `plan` gets a `planHint`;
   DISCUSS/WorkMode are never passed to `buildSystemPrompt`). The model is not
   told it is in a read-only discussion posture, so denied writes surface as
   confusing "permission denied" errors rather than as the intended mode.
2. **Name/contract mismatch.** "DISCUSS" (owner taxonomy, `P12_1_REV2_…` `D-1`)
   is implemented as **read-only investigation** (18 read-only tools including
   network `web_fetch`/`web_search`), **not** as "conversation-only, no tools".
   There is **no** conversation-only mode anywhere in the product.
3. **No persistence (intentional).** Owner decision `D-2` ("mode tidak dipersist
   otomatis") means DISCUSS is per-invocation; on resume it reverts to EXECUTE
   unless re-passed, and so appears to "disappear".
4. **Surface asymmetry.** The `DISCUSS·auto` footer is **TUI-only**
   (`src/ui/footer.ts:63-73`, `cli/tui.ts:589-591`); one-shot/`exec` linear output
   shows **no** DISCUSS label while *still enforcing* it — "silent enforcement".

Root-cause classification (per §2.5 taxonomy): **item 8 — "existing
implementation matches its contract (D-1 read-only ceiling), but the owner's
label 'discussion mode' carries semantics (prompt guidance, no-surprise
enforcement) beyond what 'read-only ceiling' documents"** — combined with a
real enforcement/visibility list-drift (finding `F-DISCUSS-3`).

The broader UI/presentation separation (headless presentation state vs terminal
rendering) is **architecturally sound**; the material debt is at the *surface*
layer (env-mutation state, `any` at event boundaries, two monoliths), not the
domain/adapter/reducer/projection core.

---

## 2. Baseline, method, commands

### 2.1 Baseline (exact)

```
branch : main
HEAD   : 57c59d363b3f7bafca07c050992f6ffccb227463 (57c59d3)
version: 0.13.1                              (package.json)
engines: {"bun": ">=1.1.13"}
bun    : 1.4.3    node: v26.13.0
remote : origin  https://github.com/startupmini/minicode.git
```

### 2.2 Pre-existing dirty working tree (untouched, preserved exactly)

```
 M cli/commands/exec.ts   | 44 ++++++++++++++++++++++++++++++++++++++++++++
 M src/policy/context.ts  | 18 ++++++++++++++++--
 M src/tools/todo.ts      | 22 +++++++++++++++++----
```

A fourth tracked file, `src/app/session.ts`, was additionally modified **during**
this investigation by the concurrently-active agent (a temporary `MINICODE_DEBUG_CALIB`
diagnostic write in the calibration observer, `+7` lines inserted after
`session.ts:364`; env-gated, unrelated to DISCUSS). It does **not** shift any
`session.ts` anchor cited here (all are at < line 365). None of the four were
authored, edited, or touched by this investigation. Line anchors for
`exec.ts`/`context.ts`/`todo.ts` reflect the working tree; all other files reflect
HEAD `57c59d3`.

### 2.3 Read-only commands used

```
git rev-parse --abbrev-ref HEAD ; git rev-parse HEAD ; git rev-parse --short HEAD
git status --porcelain=v1 ; git remote -v ; git log --oneline -20
git log --oneline --all --grep="DISCUSS" -i
git log --oneline -- src/policy/work-mode.ts ; git show --stat 0987018
grep (ripgrep) over src/**, cli/**, docs/**, test/** for:
  DISCUSS, workMode, work-mode, WorkMode, WORK_MODE, EXPLORE_TOOL_NAMES,
  READONLY_TOOLS, sideEffectTier, PURE_READ, process.env
read_file over the surfaced anchors
```

No tests run, no build run, no `git` mutation, no dependency install. All
performance/streaming claims below are **code-derived facts** (constants,
schedule choice), not measurements — unmeasured behavior is labeled UNVERIFIED.

### 2.4 Source of the prior audit

Prior "Audit Pass #4" was a **chat-only** report (no repo file), produced in the
same read-only session at the same HEAD `57c59d3`. Its validation matrix is in
§10.

---

## 3. Current UI/presentation architecture map

### 3.1 Layering (verified against `test/ui-boundary.test.ts` intent)

```
┌─ backend / domain (policy, session, task, memory, mcp, tools) ─────────────┐
│  source of truth = durable stores + kernel events (vendor/minicore)        │
│  LOOP/TOOL/MEMORY/CONTEXT/CONTROL produce state + events                  │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ UiBus (structural, src/ui/contract.ts)
┌─ presentation (src/presentation/, headless, NO terminal/ANSI/clock) ──────┐
│  adapter.ts  kernel events ─▶ DomainEvent (V2.1 vocabulary, events.ts)   │
│  reducer.ts  DomainEvent  ─▶ PresentationState (bounded 4096, model.ts)  │
│  projection.ts state ─▶ semantic nodes / marks / machine-envelope (pure)  │
│  store.ts    ContentStore (FIFO 200K/500K, durable fallback)              │
│  label.ts    single canonical tool labeler                                │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ injected via DI from cli/setup.ts (composition root)
┌─ ui (src/ui/, terminal rendering only) ───────────────────────────────────┐
│  tui/app.ts + transcript.ts   fullscreen TUI (single owner of screen)     │
│  assistant/simple.ts + turn-status.ts  linear printer + transient status  │
│  footer.ts  status bar render (pure)                                      │
│  render/*   theme/sanitize/width/diff/collapse/detail/reasoning/…         │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Ownership (who owns what — §7 detail)

| Concern | Owner | Evidence |
|---|---|---|
| Semantic event translation (kernel→DomainEvent) | `presentation/adapter.ts` (single parser) | `adapter.ts:332-647` |
| State reduction + bounded memory | `presentation/reducer.ts` (`trimState`) | `reducer.ts:291-335` |
| Node selection / marks / machine envelope | `presentation/projection.ts` (pure) | `projection.ts:334-402` |
| Content storage (large outputs) | `presentation/store.ts` (FIFO) | `store.ts:115-260` |
| UI↔outside contract | `ui/contract.ts` (structural; `any` at `:70` documented) | `contract.ts:62-71` |
| User input (TUI) | `ui/tui/app.ts` + `input/prompt-engine.ts` | `app.ts:489-654` |
| Screen/stream rendering | `ui/tui/app.ts` (30ms coalesce) + `assistant/simple.ts` | `app.ts:360-370` |
| Action dispatch (TUI) | `cli/tui.ts` (`submit` → builtin/turn) | `tui.ts:379-582` |
| WorkMode / permission / ceilings | `policy/work-mode.ts` + `policy/permission.ts` | §4 |

### 3.3 Two representative production flows

**Flow A — tool lifecycle (backend → user-visible).**
`execution:started` (kernel) → `adapter.sub("execution:started")`
(`adapter.ts:752-794`) → `tool.started` DomainEvent → `reducer` `tool.started`
(`reducer.ts:373-408`) → `PresentationState.activities` → `getPresentationSnapshot`
(`setup.ts:1429-1481`) → injected into `Transcript`/`simple.ts`
(`tui.ts:146-154`, `setup.ts:2636-2646`) → `transcript.presentationLedger`
(`transcript.ts:688-748`) → glyph/status line (user-visible).

**Flow B — DISCUSS turn (detailed in §4.3).**
`--work-mode DISCUSS` → `resolveWorkModeFlag` (`args.ts:125-137`) →
`createCliSession(workMode)` (`index.ts:519`) → `createMinicodeSession(workMode)`
(`session.ts:157,230-242`) wraps `createWorkModePermissionHandler` → ceiling
`readonly` (`work-mode.ts:118-141`) + tool-visibility filter
(`tool-layer.ts:27-32`) + sub-agent inheritance (`task.ts:327,509`) + hooks gate
(`run.ts:31`) → denied writes become `tool.denied` → rendered as warning glyph/line.

---

## 4. DISCUSS — provenance, state model, trace, truth table, root cause

### 4.1 Requirement provenance

| Evidence | File/commit | Stated behavior | Strength | Ambiguity |
|---|---|---|---|---|
| Owner direction `D-1` | `P12_1_REV2_OWNER_DECISION_REPORT.md:12` | "DISCUSS read-only; PLAN kontrak lama; EXECUTE ikut PM; WorkMode ⊥ PM" | **CONFIRMED (owner-approved)** | "DISCUSS" = read-only ceiling, not "talk only" |
| Owner direction `D-2` | same `:14` | "Mode tidak dipersist otomatis" | **CONFIRMED** | intentional non-persistence |
| Architecture decision package | `P12_1_ARCHITECTURE_DECISION_PACKAGE_REV2.md:79-89` | "DISCUSS read-only, tanpa mutasi/eksekusi berdampak implisit" | **CONFIRMED** | — |
| 18-cell matrix | same `:147-158` | DISCUSS × any PM = `readonly-set` (no prompt) | **CONFIRMED** | — |
| Terminal contract I35 | `docs/TERMINAL_CONTRACT.md:322-353` | `/work-mode`; footer `<WorkMode>·<PM>` when ≠ EXECUTE | **CONFIRMED** | — |
| CLI help | `cli/index.ts:81-82,257-258` | "DISCUSS = read-only, PLAN = plan tools only" | **CONFIRMED** | "read-only" ≠ "no tools" |
| Code (canonical) | `src/policy/work-mode.ts:16,56-59` | `DISCUSS → ceiling "readonly"` | **CONFIRMED** | — |

**Conclusion:** The original intent is recoverable and unambiguous — DISCUSS is the
owner's *label* for a **read-only investigation ceiling**, not a "conversation-only"
mode. No conversation-only contract exists in repo evidence. If the owner's
mental model of "discussion mode" is "no tool execution, just chat", that intent
**is not represented** anywhere (`grep DISCUSS` yields zero hit outside the
WorkMode enum/label).

### 4.2 Canonical mode model (independent dimensions, not conflated)

| Dimension | Canonical type | Source of truth | Runtime control |
|---|---|---|---|
| **PermissionMode** (`auto`/`ask`/`plan`/`allow-all`/`allowlist`/`readonly`) | `permission.ts` `PermissionMode` | `createPermissionHandler(...).state.mode` (in-handler, `__setMode`) | `/mode`, `Tab`/`Shift+Tab` |
| **WorkMode** (`DISCUSS`/`PLAN`/`EXECUTE`) | `work-mode.ts:16` `WorkMode` | `createWorkModePermissionHandler` mutable `wm` closure (`work-mode.ts:70,149-154`) | `/work-mode`, `--work-mode`, `MINICODE_WORK_MODE` |

These are **two separate dimensions** ("ceiling ∧ permission", INV-WM1). WorkMode
is applied *above* PermissionMode; `__getMode()` returns the underlying PM so
`ToolContext.permissionMode` metadata is not polluted (`work-mode.ts:145-148`).

**Defaults/precedence:** EXECUTE is default; flag `--work-mode` > env
`MINICODE_WORK_MODE` > default EXECUTE; invalid value → EXECUTE + warning
(`args.ts:125-137`). `--plan` (PM) is **not** aliased to WorkMode PLAN
(`index.ts:286-289`).

**Transitions (INV-WM4):** only explicit operator action can *increase*
capability (DISCUSS→PLAN/EXECUTE); never model output. Runtime transition mutates
the `wm` closure → ceiling re-evaluated per tool call (not snapshot)
(`work-mode.ts:117-141`).

**Sub-agent inheritance:** parent WorkMode read live at `delegate_task` execute
(`setup.ts:1666`), child gets `workMode: childWorkMode` (`task.ts:509`); child
visibility filtered when DISCUSS/PLAN (`task.ts:326-329`).

**Hooks:** `shouldRunHooks(permMode, workMode)` evaluated per-call with live
WorkMode; DISCUSS always suppresses (`run.ts:27-33`, `setup.ts:2329-2340`).

**NoProgress posture:** DISCUSS → `"readonly"` posture (`session.ts:261-262`),
disabling read-only-thrash detection because the posture is already read-only.

### 4.3 End-to-end DISCUSS turn trace (production symbols)

| # | Boundary | DISCUSS effect? | Evidence |
|---|---|---|---|
| 1 | User input `--work-mode DISCUSS` or `/work-mode DISCUSS` | parses to `DISCUSS` | `args.ts:112-116`, `tui.ts:426` |
| 2 | CLI/TUI input handling | `/work-mode` is **TUI-only**; one-shot only via flag | `tui.ts:420-441`; `commands.ts` switch has **no** `work-mode` case |
| 3 | WorkMode controller transition | `ctl.setWorkMode(m)` → `wm = m` (closure) + tool-visibility recompute | `session.ts:322-324`, `tool-layer.ts:134-138` |
| 4 | App/session composition | wraps base PM handler with ceiling handler | `session.ts:230-242` |
| 5 | System prompt construction | **NO CHANGE** — DISCUSS has no prompt hint (only PM `plan` does) | `session.ts:163-170`, `context.ts:183-311` (no `workMode` param) |
| 6 | Loop/orchestrator | ceiling checked per call (no-prom tool mutates) | `work-mode.ts:118-141` |
| 7 | Tool availability / permission check | visibility filtered to `EXPLORE_TOOL_NAMES`; enforcement = `READONLY_TOOLS` | `tool-layer.ts:27-32`, `permission.ts:33-52` |
| 8 | Task/plan/scheduler | ceiling applies to `todo_write`/`delegate_task` (denied in DISCUSS) | matrix `work-mode-matrix.ts:24-29` |
| 9 | Persistence and resume | **not persisted** (D-2); reverts to EXECUTE on resume | `docs/…REV2.md:171` |
| 10 | Presentation events / footer | footer label `DISCUSS·auto` (TUI only); denied writes → `tool.denied` | `footer.ts:63-73`, `tui.ts:589-591` |

### 4.4 DISCUSS contract comparison (options A–D)

| Contract | Tool classes | Model instruction | Enforce point | Match to code? |
|---|---|---|---|---|
| **A — Conversation-only** | none | "do not call tools" (hypothetical) | would reject `*` | **NOT IMPLEMENTED** |
| **B — Read-only investigation** | `READONLY_TOOLS` (18) | none (prompt unchanged) | ceiling handler `readonly` | **IMPLEMENTED** (this IS DISCUSS) |
| **C — Approval-mediated** | propose + approve | none | PM `ask`/`auto` inside ceiling | NOT DISCUSS (that is PM `ask`+PLAN) |
| **D — Intent layer** | ceiling only | none | `createWorkModePermissionHandler` | **IMPLEMENTED** (DISCUSS/PLAN = intent layer) |

DISCUSS = **B ∩ D** in practice: it is an intent-layer ceiling that resolves to
the `readonly` permission primitive, admitting 18 read-only tools (incl. network
`web_fetch`/`web_search`) and denying all mutation/exec. It does **not** alter
the model prompt, and it is **not** conversation-only.

### 4.5 Truth table (from the production handler + fixture)

Fixture `test/helpers/work-mode-matrix.ts:23-57` records every cell. Enacted by
`ceilingFor` (`work-mode.ts:56-59`):

| WorkMode \ PM | auto | ask | plan | allow-all | allowlist | readonly |
|---|---|---|---|---|---|---|
| **DISCUSS** | readonly | readonly | readonly | readonly | readonly | readonly |
| **PLAN** | plan¹ | plan¹ | plan | plan | readonly² | readonly |
| **EXECUTE** | auto | ask | plan | allow-all³ | allowlist | readonly |

¹ PLAN×auto/ask keeps the original `delegate_task` approval gate (owner decision S2.1, `work-mode-matrix.ts:34-41`).
² PLAN×allowlist/readonly intersections to readonly (owner decision S2.1, `:45-50`).
³ allow-all still subject to bash-guard/jail (`matrix.md` note; `permission-matrix` suite).

Invalid/unknown WorkMode → EXECUTE + warning (`args.ts:133-136`).

### 4.6 Root-cause classification (targeted)

Established causes for "appears absent/incomplete":

1. ✅ **Not** missing domain/architecture (implemented: `work-mode.ts`, `session.ts`, `tool-layer.ts`).
2. ✅ **Not** missing activation (flag/env/TUI/ACP/exec all routed).
3. ⚠️ **Mode set but does not change model/runtime *instruction*** — DISCUSS changes *runtime policy* but **not** the prompt (contrast PM `plan`'s `planHint`).
4. ⚠️ **Prompt/behavior softness** — no `discussHint`; denials are the only signal.
5. ⚠️ **UI exposure** — footer label TUI-only; one-shot/exec silent.
6. ⚠️ **Not persisted** — intentional (D-2), but reads as "disappears on resume".
7. ⚠️ **CLI/TUI path asymmetry** — `/work-mode` is TUI-only; `handleBuiltinCommand` has no `work-mode` case (`commands.ts:459-652`).
8. ✅ **Existing implementation matches its contract** (D-1), but the owner-facing *label* "discussion mode" is broader than the documented "read-only ceiling".

**Primary root cause:** semantic drift between the *name* ("DISCUSS / discussion")
and the delivered *contract* ("read-only ceiling"), amplified by **no prompt hint**
and **non-persistence**, producing "the mode is there but doesn't behave/feel like
a discussion mode". Plus a concrete list-drift (`F-DISCUSS-3`).

---

## 5. Capability-to-UI matrix

Legend: **FULL** / **PARTIAL** / **RAW** (stderr/log only) / **HIDDEN** (backend exists, no UI) / **INCONSISTENT** / **N/A** / **UNKNOWN**.

*"Simple CLI" = one-shot/`exec` linear printer; "TUI" = fullscreen; "REPL" does not exist as a distinct linear surface anymore (`cli/index.ts:550-554`, "REPL linier dihapus").*

### 5.1 LOOP

| Capability | Backend truth | Event/API | Adapter | Projection/state | Simple CLI | TUI | User action | Tests/gap |
|---|---|---|---|---|---|---|---|---|
| Thinking (reasoning) | provider `reasoning` ext | `reasoning.delta/completed` | `adapter.ts:950-980` | `state.reasoning` | FULL (collapse+expand) | FULL (muted stream) | Ctrl+T / `/thinking` | `collapse.test.ts` — FULL |
| Tool call start/end | executor events | `tool.started/completed` | `adapter.ts:752-943` | `state.activities` | FULL | FULL (glyph ledger) | — | `presentation-…` — FULL |
| Retry (`supersedes_db`) | reducer `deriveSupersedes` | `tool.started` | — | `activity.supersedes` | FULL | FULL (`↻ retry`) | — | `reducer.ts:397-405` — FULL |
| Timeout/Cancel | `noteRunSettled` | `turn.cancelled` | `adapter.ts:1103-1171` | `state.turns` | FULL | FULL | Esc | `adapter.ts` — FULL |
| No-progress (thrash/osc) | `no-progress.ts` | tool error `[LOOP_GUARD…]` | — | — | PARTIAL (as tool error) | PARTIAL | — | `no-progress` unit tests — **HIDDEN as dedicated warning** |
| Failure/recovery | journal + `advisor` | `tool.failed`/`turn.failed` | `adapter.ts:728-750` | `activity.error` | FULL | FULL | — | — |
| Waiting | `pinnedRunning` | `runningRows()` | — | projection | PARTIAL | FULL (spinner/clock) | — | `transcript.ts:814-844` — FULL |

### 5.2 CONTROL

| Capability | Backend truth | Event/API | Adapter | Projection/state | Simple CLI | TUI | User action | Gap |
|---|---|---|---|---|---|---|---|---|
| **WorkMode DISCUSS** | `work-mode.ts` ceiling | (none — policy) | — | — | **HIDDEN** (no label) | FULL (footer `DISCUSS·auto`) | `/work-mode` (TUI-only), `--work-mode` | `F-DISCUSS-4` |
| Permission mode | `permission.ts` | (none) | — | footer mode | FULL (prompt prefix) | FULL | `/mode`, Tab/Shift+Tab | — |
| Admission / runtime | `production-runtime` | scheduler notices | — | — | RAW | PARTIAL (`[scheduler]` lines) | `/scheduler` | §6 |
| Approval/deny | `permission.check` | `approval.requested/settled` | `adapter.ts:1006-1038` | `state.approvals` | PARTIAL (no risk tier) | PARTIAL | y/n/a | `F-APPROVAL-1` |
| **ACE verdict** | `consequence-engine.ts` | (none, stderr BLOCKED only) | — | — | **HIDDEN** | **HIDDEN** | — | `F-CTRL-1` |
| **Verification/VERIFYING/tamper** | `verification.ts` | `verification.observed` (present/absent/inconclusive) | `adapter.ts:1072-1088` | `activity.verification` | PARTIAL (`[verified]` only) | PARTIAL (`[verified]`) | — | `F-CTRL-2` |
| Degraded state | writer stale | stderr `[writer] STALE` | — | — | RAW | PARTIAL (`[writer]` line) | — | §4.4 |

### 5.3 TOOL

| Capability | Simple CLI | TUI | Gap |
|---|---|---|---|
| Risk tier (`sideEffectTier`) | HIDDEN (no badge) | HIDDEN | `F-APPROVAL-1` |
| Diff preview (`edit`/`apply_patch`) | FULL (post-hoc `renderDiffCard`) | PARTIAL (not in approval) | `F-APPROVAL-1` |
| Network effects / sandbox | RAW (`[sandbox]`) | RAW | — |
| MCP schema drift | RAW (tool error) | RAW | `F-TOOL-1` |
| Sub-agent pool (3) | PARTIAL | PARTIAL (tree via `runningRows`) | `F-AGENT-1` |

### 5.4 MEMORY

| Capability | Simple CLI | TUI | Gap |
|---|---|---|---|
| Recall (RAG + `--verbose` note) | RAW | RAW | `F-MEM-1` |
| Write (`write_memory`) | HIDDEN (generic tool line) | HIDDEN | `F-MEM-1` |
| **Supersession** (`supersedes`) | HIDDEN | HIDDEN | `F-MEM-1` |
| Provenance / trust labels | HIDDEN | HIDDEN | — |
| FTS5 fallback (circuit-breaker) | HIDDEN | HIDDEN | `F-MEM-1` |

### 5.5 CONTEXT

| Capability | Simple CLI | TUI | Gap |
|---|---|---|---|
| Token/window usage | PARTIAL (`--rich` statusline only) | PARTIAL (footer raw count) | `F-CTX-1` |
| Pressure/compaction | FULL (`context.compacted` line) | FULL | — |
| Truncation (`[truncated]`) | FULL | FULL (marker) | — |
| Mid-stream cutoff (`watchContextWindowLimit`) | RAW (`[context] stream truncated`) | RAW | `F-CTX-2` |
| Provider usage vs estimate (CTX-03) | HIDDEN | HIDDEN | `F-CTX-1` |

### 5.6 TASK

| Capability | Simple CLI | TUI | Gap |
|---|---|---|---|
| Canonical task id (`t1`, `t2`) | HIDDEN (positional `stepId` only) | HIDDEN | `F-TASK-1` |
| Plan step status | FULL | FULL | — |
| Dependency/DAG, lease, incarnation | HIDDEN | HIDDEN | `F-TASK-1` |
| Active/waiting/completed/blocked | PARTIAL | PARTIAL | `F-TASK-1` |

### 5.7 DAEMON

| Capability | Backend truth | Simple CLI | TUI | Gap |
|---|---|---|---|---|
| Disconnected/connecting | socket state | N/A | N/A | — |
| Replay/reconstructed/live | `provenance` (+`tail_marker`) | PARTIAL (`[replay]`) | PARTIAL (`[replay]`/`[reconstructed]`) | `F-DAEMON-1` |
| Stale offset | cursor validation | RAW | RAW | — |
| Backpressure (`QUEUE_OVERFLOW`) | `subscription.ts:98-123` | RAW | RAW | — |
| Reconnect | `dropConsumer` | N/A | N/A | — |
| Shutdown | `broadcastHalt` | N/A | N/A | — |

---

## 6. Simple CLI vs REPL vs TUI (corrected surface model)

**The linear "REPL" was removed.** `cli/index.ts:550-554` ("Satu-satunya tampilan
interaktif = TUI fullscreen (REPL linier dihapus)") and `cli/tui.ts:13-14`. The
three real surfaces are:

| Surface | Entry | Renderer | WorkMode label | WorkMode setter |
|---|---|---|---|---|
| **One-shot / pipe** | `minicode "prompt"` / `echo \| minicode` | `simple.ts` linear | **none** | `--work-mode` flag / env only |
| **exec (headless)** | `minicode exec "prompt"` | `simple.ts` linear + JSON envelope | **none** | `--work-mode` flag / env only |
| **Interactive TUI** | `minicode` (TTY, no prompt) / `--interactive` | `tui/app.ts` fullscreen | `DISCUSS·auto` footer (`footer.ts:64`) | `/work-mode` **and** flag/env |
| **ACP (IDE JSON-RPC)** | `minicode acp` | machine envelope | n/a | `params.workMode` (`acp.ts:96,125-135`) |

Consequences of the asymmetry (all evidence-backed):

- `/work-mode` (and `/mode`) are **TUI-only**: `handleBuiltinCommand`
  (`cli/commands.ts:459-652`) has no `work-mode`/`mode` case; both are handled
  only in `cli/tui.ts:403-441` before delegating. In one-shot/exec there is no
  mid-session mode change; WorkMode is fixed at invocation.
- One-shot/exec **enforces** DISCUSS silently (ceiling denies writes) but shows no
  label, so a user gets "permission denied" with no explanation that DISCUSS is
  active.
- The `--plan` "Proceed to execute this plan? [y/N]" flow is keyed on
  `ctx.permissionMode === "plan"` (`index.ts:674`), **not** on WorkMode PLAN or
  DISCUSS — so WorkMode PLAN/DISCUSS have no such interactive handoff.

---

## 7. State ownership & isolation

### 7.1 `process.env` reads AND writes in render layer

| File | Reads | Writes | Classification |
|---|---|---|---|
| `src/ui/render/collapse.ts:41-42,52-55` | `MINICODE_MINIMIZE_ANSWER/_TOOL` | **writes** both (`:55`) | **process-global state** (bad) |
| `src/ui/render/detail.ts:11-14` | `MINICODE_COMPACT` | **writes** (`:14`) | process-global (bad) |
| `src/ui/render/reasoning.ts:7-10` | `MINICODE_SHOW_THINKING` | **writes** (`:10`) | process-global (bad) |
| `src/ui/render/theme.ts` (lazy getters) | `NO_COLOR`/`COLORTERM`/`TERM`/`MINICODE_ASCII` | none | read-only config (fine) |
| `src/ui/tui/app.ts:91-93` | `MINICODE_MOUSE_SELECTION` | none | read-only config (fine) |

These three writes **leak UI state into the process env**; child sub-agents/MCP
inherit them (owner note `docs/ARCHITECTURE.html:991` "WorkMode parent hidup di
state modul proses"). They are a **design smell**, not a currently-exploitable
security boundary (all are benign cosmetic toggles), but they violate isolation
and cause cross-session bleed in multi-session/test/embed contexts.

### 7.2 Module-level mutables (exact inventory)

| Location | Mutable | Lifetime | Ownership |
|---|---|---|---|
| `simple.ts:62` | `lastTurnText` | process | module-global (copy buffer) |
| `simple.ts:63` | `previousTurnTexts` | process | module-global |
| `simple.ts:116` | `pendingError` | process | module-global |
| `collapse.ts:15` | `activeSection` | process | module-global |
| `collapse.ts:26` | `collapsedSectionViews` | process | module-global |
| `transcript.ts:46` | `approvalSink` | process | module-global (TUI singleton hook) |

These are **instance-owned** only in the sense of "one session per process" (owner
note: production entry points build one parent session per process). They are
**not** safe for concurrent sessions sharing a process.

### 7.3 `any` / unsafe casts at event boundaries (exact)

| Location | What | Justified? |
|---|---|---|
| `ui/contract.ts:70` | `UiBus.on(type, (event: any) => void)` | **Yes** — vendor `EventBus` generic contravariance (documented `:62-71`) |
| `presentation/events.ts:446` | `EventBusLike.on(handler: (event: any))` | Documented mirror (`:441-447`) |
| `presentation/adapter.ts:632,635` | `sub(type, fn: (e: any))`, `source.on(type, (e: any))` | Not individually justified (could narrow to `UiEvent`) |
| `ui/tui/app.ts:371,374` | `sub(type, handler?: (event: any))` | Not justified (payloads already annotated per call-site) |

*Correct fix:* keep the single purposeful erosion at `contract.ts:70`; narrow the
other three sites to generic/`UiEvent`/`DomainEvent` to restore type checking on
the hot event path.

---

## 8. Rendering / streaming / performance

**All perf figures are UNVERIFIED (no measurement run); the following are
code-fact schedules, not benchmarks.**

| Concern | Fact | Location | Verdict |
|---|---|---|---|
| TUI repaint coalescing | 30 ms single-flight `setTimeout` (unref) | `app.ts:360-370` | Present & correct pattern |
| Mouse drag repaint | 16 ms coalesce | `app.ts:1123-1132` | Present |
| Activity clock tick | 200 ms (`DOT_INTERVAL_MS`) | `app.ts:83,970-982` | Present |
| Turn-status interval | adaptive 120–320 ms | `turn-status.ts:102,301-308` | Present |
| Linear printer streaming | append-only, no repaint | `simple.ts` | Present (no flicker class) |
| Transcript memory bound | 5000 logical lines + 1 M char pending | `transcript.ts:27-28,881-916` | Bounded |
| Presentation state bound | `MAX_STATE_ENTRIES = 4096` across arrays/maps | `model.ts:19`, `reducer.ts:291-335` | Bounded |
| Content store bound | 200 K/entry, 500 K total FIFO | `store.ts:25-27,121-131` | Bounded |
| Daemon queue backpressure | `MAX_QUEUE_PER_CONN`, `QUEUE_OVERFLOW` | `subscription.ts:10,98-123` | Bounded |

**UNVERIFIED (needs measurement):** actual FPS at 30 ms coalesce under burst SSE;
CPU cost of `projectAll()` full re-wrap on resize/scroll; `process.stdout.rows`
read directly in `scrollBy`/`jumpEdge`/`tooSmall` (`app.ts:915,938,1347`) vs the
`currentScreen` instance (stale-size risk after `releaseTerminal`/`reacquire`,
class acknowledged in `app.ts:288-293`).

---

## 9. Approval safety & diff integrity

**Approval creation → effect trace** (production):

1. Request: `permission.check` reaches `ask` (`promptAsk`, injected via
   `permission.ts` `ask`). `promptAsk` (`approval/prompt.ts:24-108`) reads
   `call.name` + `call.args`, builds a **sanitized** text block (name + one-line
   arg summary), asks y/n/a.
2. Effect: decision returned to `permission.check`; on `allow` the kernel executes
   the *already-constructed* `ToolCall`. No re-parse of args between prompt and
   execution (args are captured by reference from the kernel call).

### 9.1 Findings

- **`F-APPROVAL-1` (P1):** approval card shows **no risk tier** and **no diff
  preview**. `SideEffectTier` never reaches the prompt (`prompt.ts` reads only
  `name`/`args`); `renderDiffCard` is used only *post-hoc* for successful
  `edit`/`apply_patch` (`simple.ts:684-705`), not in the approval card.
- **TOCTOU (args immutable?):** the args object is the kernel `ToolCall.args`; the
  ceiling → base decision path does **not** re-normalize args between `promptAsk`
  and execute. The *preview* is a snapshot string, but the *executed* op uses the
  same args reference — so preview and effect are the same object (no
  change-after-approval vector), but the preview is only a 100-char summary, which
  can under-disclose the operation (e.g. `write_file` content hidden).
- **"Always/Session" vs ceiling:** `allow-always` persists to `.minicode/allowlist.json`
  (repo-local, opt-in read-back; `permission.ts:272`, `docs/…REV2.md:169-173`).
  It does **not** bypass the WorkMode ceiling: ceiling is checked first and is
  never prompt-gated (`work-mode.ts:128-135`), so an always-grant for a write tool
  remains denied under DISCUSS — INV-WM1 holds.
- **Deny visibility:** denied → `tool.denied` event → warning glyph/line; audited
  in transcript via `approval.settled` (`adapter.ts:1026-1038`). FULL at the ledger
  level; the *reason* is visible only in `DenyReason` mapping (FULL for known
  reasons).

---

## 10. Validation matrix — prior Audit Pass #4 claims

| # | Pass-#4 claim | Verdict | Evidence / discrepancy |
|---|---|---|---|
| 1 | Component line counts & responsibilities | **CONFIRMED** | `app.ts`=1416, `simple.ts`=831, `adapter.ts`=1228, `projection.ts`=858, `footer.ts`=162, etc. (Pass#4 said `app.ts ≈1345`, actual 1416 — minor) |
| 2 | Health scores exist with a rubric | **REFUTED** (scores were ad-hoc) | Pass#4 scores (7–9) have **no scoring rubric**; they are editorial. Flagged here as opinion, not measurement |
| 3 | `process.env` mutations at `collapse.ts:55`, `detail.ts:14`, `reasoning.ts:10` | **CONFIRMED** | exact lines verified |
| 4 | "4 module-level mutables in `simple.ts`" | **PARTIALLY CONFIRMED** → **3** | `lastTurnText`(:62), `previousTurnTexts`(:63), `pendingError`(:116). Pass#4 over-counted by one |
| 5 | `any` locations `contract.ts:70`, `events.ts:446`, `adapter.ts:632,635`, `app.ts:371,374` | **CONFIRMED** | all six verified |
| 6 | `TuiApp`/logger boundary | **CONFIRMED** | `app.ts:191` (App), `simple.ts:150-822` (logger ≈673 lines) |
| 7 | Footer context = raw token count | **CONFIRMED** | `cli/tui.ts:594` `fmtCtx(session.contextTokens)` |
| 8 | `currentScreen` vs `process.stdout.rows` drift | **CONFIRMED** | `app.ts:915,938,1347` read `process.stdout.*` directly |
| 9 | ACE/VERIFYING not exposed to UI | **CONFIRMED** | only `[verify]`/`[ace]` stderr; no `consequence.detected` event |
| 10 | NoProgressDetector not a dedicated UI warning | **CONFIRMED** | surfaces only as `[LOOP_GUARD…]` tool-error text |
| 11 | TaskStore identity/DAG not rendered | **CONFIRMED** | plan shows positional `stepId`; `taskId`/`payloadVersion=2` ignored by UI |
| 12 | Subagent pool slots not per-runId | **CONFIRMED** | `runningRows()` uses parent/child links, not `runId` slots |
| 13 | Memory write/supersession/fallback not visible | **CONFIRMED** | no UI for `write_memory`, `supersedes`, FTS5 fallback |
| 14 | MCP schema-drift UX | **CONFIRMED** | surfaced as tool error; no approval card |
| 15 | REPLAY→RECONSTRUCTED→LIVE indicators | **CONFIRMED (partial)** | `[replay]`/`[reconstructed]` suffix only; no live/vs-replay transition badge |
| 16 | Approval diff/risk preview missing | **CONFIRMED** | `F-APPROVAL-1` |
| 17 | **"REPL" exists as a distinct surface** | **CHANGED/REFUTED** | linear REPL was removed (`index.ts:550-554`); Pass#4 used "REPL" loosely |
| 18 | DISCUSS footer label `DISCUSS·auto` | **CONFIRMED** | `footer.ts:64` |

**Corrections carried forward:** item 2 (no rubric → scores relabeled as editorial
opinion), item 4 (3 not 4 mutables), item 17 (REPL removed).

---

## 11. Findings registry (stable IDs)

| ID | Pri | Area | Finding | Evidence |
|---|---|---|---|---|
| `F-DISCUSS-1` | P1 | CONTROL | DISCUSS changes runtime policy but **no model prompt** (no `discussHint`; contrast `planHint`) | `session.ts:163-170`, `context.ts:183-311` |
| `F-DISCUSS-2` | P1 | CONTROL | "DISCUSS" = read-only ceiling, **not** conversation-only; no conversation-only mode exists | `work-mode.ts:16,56-59`; grep DISCUSS |
| `F-DISCUSS-3` | P1 | CONTROL/TOOL | **List drift:** enforcement `READONLY_TOOLS`(18) ≠ visibility `EXPLORE_TOOL_NAMES`(=PURE_READ/`allowedInExplore`, ~13). DISCUSS *allows* `web_fetch`/`web_search` (network) + `read_image`/`git_diff`/`lsp_references`/`lsp_symbols` at ceiling, but *hides* them from the model (and hides `bash_output` which the ceiling then *denies*). No test reconciles the two sets | `permission.ts:33-52` vs `tool-contract.ts:79-243,492-493`; `tool-layer.ts:116-120` |
| `F-DISCUSS-4` | P1 | CONTROL/UX | WorkMode label + `/work-mode` are **TUI-only**; one-shot/exec enforce silently | `tui.ts:420-441`; `commands.ts:459-652` (no `work-mode` case) |
| `F-DISCUSS-5` | P2 | CONTROL/UX | DISCUSS not persisted (intentional D-2); reverts to EXECUTE on resume | `docs/…REV2.md:14,171` |
| `F-CTRL-1` | P1 | CONTROL | ACE verdict/class/nextAction/`aceVerdict` child → HIDDEN (stderr BLOCKED-only) | `setup.ts:2263-2269`; no event |
| `F-CTRL-2` | P1 | CONTROL | `VERIFYING` gate + Tamper Guard reasons → HIDDEN in UI (stderr only) | `verification.ts:2161-2186,2204` |
| `F-CTX-1` | P1 | CONTEXT | No context-window meter `%` / cost in default footer or one-shot | `cli/tui.ts:594`; `simple.ts` default |
| `F-CTX-2` | P2 | CONTEXT | Mid-stream cutoff `watchContextWindowLimit` → stderr only, not transcript/HUD | `setup.ts:2462-2478` |
| `F-TASK-1` | P1 | TASK | Canonical `taskId`/DAG/lease/incarnation not rendered (only positional `stepId`) | `transcript.ts:688-748`, `contract.ts:186-196` |
| `F-AGENT-1` | P1 | TOOL | Sub-agent pool slots not keyed to `runId`; 3 parallel children shown as count only | `transcript.ts:814-844`, `task.ts` |
| `F-MEM-1` | P2 | MEMORY | Memory write/supersession/FTS5-fallback invisible | `memory/vector.ts`, `tools/memory.ts` |
| `F-TOOL-1` | P2 | TOOL | MCP schema-drift has no structured approve/reject card | `mcp/client.ts:67-92` |
| `F-DAEMON-1` | P2 | DAEMON | No REPLAY→LIVE transition badge (provenance present in data) | `server.ts:441-447`, `transcript.ts:728-734` |
| `F-APPROVAL-1` | P1 | TOOL | Approval card lacks risk tier + diff preview | `approval/prompt.ts:24-108` |
| `F-ENV-1` | P1 | ISOLATION | `process.env` writes as UI state (`collapse/detail/reasoning`) | `collapse.ts:55`, `detail.ts:14`, `reasoning.ts:10` |
| `F-TYPE-1` | P2 | TYPES | `any` at 4 event boundaries (one justified) | `contract.ts:70`, `events.ts:446`, `adapter.ts:632,635`, `app.ts:371,374` |
| `F-MONO-1` | P2 | STRUCTURE | `attachSimpleLogger` (~673 loc) + `TuiApp` (1416 loc) monoliths | `simple.ts:150`, `app.ts:191` |

---

## 12. Options comparison (DISCUSS + key cross-cutting)

### DISCUSS semantics

| Option | Behavior change | Files | P12/I35 compat | Security | UX | Complexity |
|---|---|---|---|---|---|---|
| **A — smallest correction (recommended): add a `discussHint` prompt** | append "read-only discussion posture; read only, don't attempt writes" when WorkMode=DISCUSS, mirroring `planHint` | `session.ts` (+~6 lines) | full | no weakening (prompt-only) | model no longer fumbles denied writes | trivial |
| **B — moderate: reconcile visibility vs enforcement lists** | make DISCUSS visibility and ceiling use ONE list (cleanest: DRY `READONLY_TOOLS`), resolve `web_fetch`/`web_search` network reads explicit | `tool-layer.ts` + `permission.ts`/`tool-contract.ts` | INV-WM1 intact | clarifies that DISCUSS=network-browse allowed | predictable capability | moderate |
| **C — deeper: structured Dashboard card (ACE/VERIFYING/TaskStore/HUD)** | add `consequence.detected` event + HUD `ACE/verify/task` fields | events/adapter/reducer/contract + footer/transcript | additive | — | closes `F-CTRL-1/2`, `F-TASK-1` | high (defer; not DISCUSS-specific) |

**Recommendation:** A now (zero-risk), B soon (real correctness/expectation), C
only as a dedicated slice (it is not required to make DISCUSS "work").

### State isolation / env mutation (`F-ENV-1`, `F-TYPE-1`)

| Option | Description | Risk |
|---|---|---|
| A | Replace env-writes with module-level getter/setter + bootstrap default | low, local |
| B | + narrow the three un-justified `any` sites | low |
| C | + full instance-scope DI (session-owned state registry) | defer (multi-session is not a production path today) |

---

## 13. Test coverage & missing-evidence matrix

| Area | Tests (name) | Real vs mocked | Platform gate | Assertion | Gap |
|---|---|---|---|---|---|
| WorkMode contract (ceiling) | `test/work-mode-contract.test.ts` (REAL `createPermissionHandler`) | real handler, fake TTY, tmp HOME | none | DISCUSS denies out-of-ceiling; in-ceiling allow | **no `F-DISCUSS-3` list-drift test** |
| WorkMode runtime | `test/work-mode-runtime.test.ts` | real handler, `__setWorkMode` | none | EXECUTE↔DISCUSS↔PLAN; footer label | good |
| WorkMode CLI | `test/work-mode-cli.test.ts` | pure `resolveWorkModeFlag` | none | flag>env>default | good |
| WorkMode tool-visibility | `test/work-mode-tool-visibility.test.ts` | pure `workModeVisible` | none | intersection | **gap: no cross-check vs READONLY_TOOLS** |
| WorkMode hooks | `test/work-mode-hooks.test.ts` | real `runRunHooks` | none | DISCUSS suppresses hooks | good |
| WorkMode subagent | `test/work-mode-subagent.test.ts` | — | none | child inherits; no escalation | good |
| Approval binding/TOCTOU | `delegate-audit`, `permission-*` (from REV-2 S1) | — | — | headless deny; bash-guard | **no risk-tier/diff-preview assertion** |
| UI boundary | `test/ui-boundary.test.ts` | — | — | import-direction guards | good |

**Unknowns needing experiments (never run in this audit):**
1. `bun test test/work-mode-*.test.ts` — confirm the 86-test P12 suite is green at HEAD (owner DOC audit last reported 302 pass on a subset; `REPOSITORY_DOCUMENTATION_AUDIT_2026-10-21.md:313`).
2. Diff the `READONLY_TOOLS` set vs `EXPLORE_TOOL_NAMES` set programmatically to pin `F-DISCUSS-3` exactly (lists cited above were read by hand).
3. Safe fake-provider DISCUSS run (tmp dir outside repo) to observe the *absence* of a prompt hint and the *presence* of silent denials (one-shot surface).
4. Measure TUI repaint under burst SSE (perf is UNVERIFIED).

---

## 14. Risks, uncertainties, experiments needed

- **Environment-limited:** 3 dirty files (`exec.ts`, `context.ts`, `todo.ts`) are
  uncommitted; line anchors for those reflect working tree. `context.ts` dirty
  diff includes CTX-03 calibration logic — a `F-CTX` claim may therefore be
  moving-relative-to-HEAD.
- **Hypothesis (not proven):** "DISCUSS feels absent because the prompt is
  unchanged" is *inferred* from absence of `discussHint`; not observed live (no
  live provider used).
- **Accepted decision:** non-persistence of WorkMode is `D-2` owner-approved —
  treat as contract, not defect.
- **Unverified:** all performance figures; the exact `READONLY_TOOLS` vs
  `EXPLORE_TOOL_NAMES` set difference (hand-read, not diffed).

---

## 15. Decision questions only the owner can answer

1. Is "DISCUSS / discussion mode" intended as **read-only investigation
   (18 tools, allow browsing)** or **conversation-only (no tool execution)**?
   (Code implements the former; the latter does not exist.)
2. Should DISCUSS emit a **model prompt hint** (like `planHint`)?
3. Should DISCUSS visibility + enforcement be reconciled to **one** tool list, and
   should `web_fetch`/`web_search` be in/out of that list?
4. Should `/work-mode` be made available in one-shot/exec (and a DISCUSS label
   shown in linear output), or is TUI-only + flag sufficient?
5. Is the intentional **non-persistence** of WorkMode (D-2) still desired, or
   should DISCUSS be sticky across `--resume`?

---

## 16. Prioritized, non-implemented roadmap proposal

1. **P0 (zero-risk, DISCUSS correctness of feel):** add `discussHint` to
   `buildSystemPrompt` path when WorkMode=DISCUSS (`session.ts:163-170`).
2. **P1:** reconcile visibility vs enforcement lists (`F-DISCUSS-3`); add a
   no-drift test.
3. **P1:** scope WorkMode label/`/work-mode` to linear surfaces OR add a one-line
   "work mode: DISCUSS" startup notice (`F-DISCUSS-4`).
4. **P1 (cross-cutting):** replace `process.env` UI-state writes (`F-ENV-1`) and
   narrow `any` sites (`F-TYPE-1`).
5. **P2:** approval risk-tier + diff preview (`F-APPROVAL-1`).
6. **P2 (defer):** Frontier HUD (ACE/VERIFYING/TaskStore) + REPLAY→LIVE badge +
   memory/MCP observability (`F-CTRL-1/2`, `F-TASK-1`, `F-MEM-1`, `F-TOOL-1`,
   `F-DAEMON-1`).

Nothing above is implemented here. Gate (when any is done, per `AGENTS.md`):
`bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack`.

---

## 17. Appendix

### 17.1 Key source anchors

- WorkMode canonical: `src/policy/work-mode.ts:16,56-59,117-165`
- WorkMode composition: `src/app/session.ts:157,230-242,261-265,316-325`
- Tool visibility: `src/app/tool-layer.ts:27-32,123-138`
- Hooks gate: `src/hooks/run.ts:27-33`
- CLI flag/env: `cli/args.ts:105-137`; wiring `cli/index.ts:289-291,519`
- TUI command + footer: `cli/tui.ts:420-441,589-591`; `src/ui/footer.ts:63-73`
- ACP/exec params: `cli/commands/acp.ts:96,125-135`; `cli/commands/exec.ts:110-113`
- Sub-agent inheritance: `src/tools/task.ts:326-329,509`
- Leads lists: `src/policy/permission.ts:33-52` (READONLY_TOOLS);
  `src/policy/tool-contract.ts:73-243,492-493` (EXPLORE_TOOL_NAMES = `allowedInExplore`)
- Presentation: `src/presentation/{events,adapter,reducer,projection,model,store}.ts`
- UI: `src/ui/tui/{app,transcript}.ts`, `src/ui/assistant/{simple,turn-status}.ts`, `src/ui/footer.ts`

### 17.2 Tests

`work-mode-contract/runtime/cli/tool-visibility/hooks/subagent`, `permission-matrix`,
`delegate-audit`, `ui-boundary`, `collapse`, `presentation-expand/store`,
`tui-format/lang`, `terminal-contract`, `errors-usage`, `checkpoint-lifecycle`.

### 17.3 Read-only commands (repeated for completeness)

```
git rev-parse HEAD ; git status --porcelain=v1 ; git remote -v
git log --oneline -20 ; git log --all --grep=DISCUSS -i
grep DISCUSS|workMode|EXPLORE_TOOL_NAMES|READONLY_TOOLS|sideEffectTier src cli docs test
```

### 17.4 Glossary

- **WorkMode** = intent layer (`DISCUSS`/`PLAN`/`EXECUTE`), ceiling above PermissionMode.
- **PermissionMode** = allow/ask/plan/allow-all/allowlist/readonly, the single deny authority.
- **Ceiling** = WorkMode-restrictive handler evaluated before the PM decision (never widens — INV-WM1).
- **READONLY_TOOLS** = 18-tool read-only enforcement set (`permission.ts`).
- **EXPLORE_TOOL_NAMES** = `allowedInExplore` set (~13), used for visibility only.
- **DISCUSS** = read-only ceiling (enforces `READONLY_TOOLS`), no prompt change, not persisted.