# P0 — Baseline & Mode Architecture Consolidation Report

**Date:** 2026-11-02
**Baseline candidate:** `cb60212` (branch `main`, ahead 1 of `origin`) on top of `57c59d3` (v0.13.1)
**Working tree at audit:** clean except two pre-existing untracked audit files
(`LIVE_UAT_HARNESS_0.13.x_REPORT_2026-11-02.md`, `UI_UX_PRESENTATION_AND_DISCUSS_MODE_DEEP_AUDIT.md`)
**Method:** read-only inspection + previously-unrun validation only. No source edits, no commits,
no new live-provider tests, no OS sandbox.

> **Report placement rationale.** Requested path style `docs/audits/…` does not exist; the repo
> convention is `docs/audit/` (singular) with SCREAMING_SNAKE_CASE names. This file is the **only**
> repository write from this consolidation.

**Evidence classification labels used throughout:**
`[PROVEN-SOURCE]` proven by direct source read · `[PROVEN-TEST]` proven by a test/benchmark/gate
run · `[PROVEN-UAT]` proven by live UAT at `cb60212` (from the UAT report) · `[DESIGN-INFER]`
design inference from contracts · `[UNVALIDATED]` unvalidated hypothesis · `[OWNER-DECISION]`
requires owner decision · `[RESOLVED]` closed · `[OPEN]` still open.

---

## 1. Baseline integrity

| Check | Result | Evidence |
|---|---|---|
| HEAD | `cb60212`, branch `main`, ahead 1 of origin | `[PROVEN-SOURCE]` git state read at session start |
| Commit content | 7 files, +105/−6, single author; fixes: calibration poisoning gate, actionable `todo_sync` error, `exec` runtime-flag forwarding, context-window error mapping | `[PROVEN-UAT]` UAT report §6 matches diff exactly |
| Working tree | clean except the two pre-existing untracked audit files listed above; no user files modified/lost | `[PROVEN-SOURCE]` `git status --porcelain` |
| Diff `57c59d3..cb60212` | exactly the 7 files +105/−6 claimed by the UAT report; no unrelated files swept in | `[PROVEN-SOURCE]` + `[PROVEN-UAT]` |
| `57c59d3` UI/UX audit baseline | audited SHA `57c59d363b3f7bafca07c050992f6ffccb227463`; its dirty-tree line anchors were preserved, never touched | `[PROVEN-SOURCE]` UI/UX audit §2.1–2.2 |

**Verdict:** baseline integrity **holds** `[RESOLVED]`. The two source audits (UAT at `cb60212`,
UI/UX at `57c59d3`) sit on a lineage where the only delta is the 7-file UAT fix commit — the UI/UX
findings therefore remain valid at `cb60212` for all files it did not touch (all of them except the
7 UAT files; none of the 7 UAT files are WorkMode/UI files).

---

## 2. Gate results

### 2.1 Gates the UAT report already reported green at `cb60212` (not re-run, per scope)

| Gate | UAT-reported result | Evidence |
|---|---|---|
| `bun x tsc --noEmit` | ✅ | `[PROVEN-UAT]` UAT report §5.3/§10 |
| `bun run lint` | ✅ | `[PROVEN-UAT]` |
| `bun run gate:coverage` | ✅ full suite 0 fail; funcs **88.44%** (min 87), lines **89.13%** (min 86), per-file floors 19/19 | `[PROVEN-UAT]` |
| `bun run gate:pack` | ✅ 23 pass / 0 fail; budget 3.584 KiB unchanged | `[PROVEN-UAT]` |
| Impact-pin tests | ✅ 72/72 + 49/49 + 36/36 | `[PROVEN-UAT]` |

These are **stage-scoped** results on candidate `cb60212`. This report does **not** upgrade them to
a repository-wide or release-readiness claim (AGENTS.md scope rule).

### 2.2 Previously-unrun validations, executed this session

| Gate | Result | Evidence |
|---|---|---|
| `bun run audit:harness` | ✅ **60 pass / 0 fail**, 2 advisories | `[PROVEN-TEST]` |
| `bun run gate:bash` | ✅ 2 modes, **62 attack patterns, 0 bypass, 0 over-block** | `[PROVEN-TEST]` |
| `bun run bench:smoke` | ✅ **13/13**, rate 1.0, delta 0.0% | `[PROVEN-TEST]` |
| CI check (`.github/workflows/*`) | **N/A — no workflow files exist in the repository** | `[PROVEN-SOURCE]` glob returned no files |
| Smoke build/package | **NOT RUN — `package.json` defines no such script** (no `build:smoke`, `pack:smoke`, or equivalent). Packaging is covered by `gate:pack` (§2.1). No command guessed or invented. | `[PROVEN-SOURCE]` full `package.json` scripts read |

### 2.3 Gate tally for this consolidation

- Run and green here: `audit:harness`, `gate:bash`, `bench:smoke`.
- Reported green at the same candidate by the UAT (not re-run): `tsc`, `lint`, `gate:coverage`,
  `gate:pack`.
- Not applicable: CI (no workflows). Not defined: smoke build/package script.
- **Total AGENTS.md chain (`tsc && lint && bun test && gate:coverage && gate:pack`)**: green on
  `cb60212` per UAT §10, plus the three extra gates green here → the `gate:fast` superset
  (`tsc, lint, bun test, gate:coverage, gate:pack, gate:bash, bench:smoke, audit:harness`) is now
  green on `cb60212` across the two reports. `[PROVEN-UAT] + [PROVEN-TEST]`

---

## 3. WorkMode vs PermissionMode architecture

The two dimensions are **independent and must stay independent** (owner decision D-1,
`OWNER APPROVED — DIRECTION` 2026-10-18; P12 `CLOSED / VERIFIED` 2026-10-22).

```
effective ceiling = WorkMode ceiling  ∧  PermissionMode decision  ∧  injected policy  ∧  sandbox/guard
```

| Dimension | Values | Role | Source |
|---|---|---|---|
| **WorkMode** (intent layer) | `DISCUSS`, `PLAN`, `EXECUTE` | thin ceiling **above** PermissionMode; never widens anything; not a second permission engine | `src/policy/work-mode.ts` `[PROVEN-SOURCE]` |
| **PermissionMode** (deny authority) | `allow`, `ask`, `plan`, `allow-all`, `allowlist`, `readonly` | the single authority that decides allow/deny/prompt | `src/policy/permission.ts` `[PROVEN-SOURCE]` |

Key mechanics proven in source:

- `composeWorkModePermissionHandler` (work-mode.ts) composes the WorkMode ceiling **around** an
  injected PermissionMode handler. Evaluation order: WorkMode ceiling first (deny ⇒ deny), then the
  composed handler. A WorkMode ceiling can only **narrow**. `[PROVEN-SOURCE]`
- `EXECUTE` is the identity: its handler is the base identity, i.e. no narrowing on top of the PM
  decision. `[PROVEN-SOURCE]`
- `src/app/session.ts` wires the handler **fail-closed**: if no handler is injected the session does
  not silently default to permissive; `onWorkMode`/`onPermissions` wiring only happens on the
  non-injected path. `[PROVEN-SOURCE]`
- Injection from the composition root (`cli/index.ts`, `cli/setup.ts`) is the only cross-layer path;
  `src/` non-ui may not import `src/ui/` (guard: `test/ui-boundary.test.ts`). `[PROVEN-TEST]`

**Security invariants (all held, all `[RESOLVED]`):**

| Invariant | Meaning | Status |
|---|---|---|
| INV-WM1 | WorkMode ceiling never widens the PM decision | held — composition only intersects `[PROVEN-SOURCE]` + `[PROVEN-TEST]` (`work-mode-contract`, real handler) |
| INV-WM4 | Policy injected restrictively cannot be weakened by any runtime toggle or inheritance | held — injected handler is opaque to WorkMode `[PROVEN-SOURCE]` |
| D-1 DISCUSS read-only | DISCUSS = read-only ceiling, enforced | held — 18-tool `READONLY_TOOLS` enforcement `[PROVEN-SOURCE]` + `[PROVEN-TEST]` |
| D-2 no auto-persist | mode never auto-persisted; resume resolves to EXECUTE | held `[PROVEN-SOURCE]`; accepted as contract, not defect `[OWNER-DECISION]` (already decided) |
| allow-always under WorkMode ceiling | `always`/allowlist grants cannot exceed the ceiling | held `[PROVEN-TEST]` (permission-matrix) |
| Sub-agent no privilege escalation | child cannot exceed parent WorkMode | held `[PROVEN-TEST]` (`work-mode-subagent`) |
| Model cannot self-raise WorkMode | no tool/route lets the model change its own WorkMode | held `[PROVEN-SOURCE]` (no setter reachable from tools) |

---

## 4. Three-mode contract (DISCUSS / PLAN / EXECUTE)

| | DISCUSS | PLAN | EXECUTE |
|---|---|---|---|
| **Intent** | read-only investigation / discussion posture | plan without executing | normal work |
| **Tool ceiling (enforced)** | 18 read-only tools (`READONLY_TOOLS`); write/bash/commit/delegation denied | read + `todo_write` (plan) + delegation forced read-only; no file/git/memory mutation | base identity — PM decides |
| **Visible to model** | 12 tools (`EXPLORE_TOOL_NAMES`) — **subset of the 18** | per tool-contract `allowedInExplore` + `todo_write` | full registry |
| **Prompt hint** | **none** (only PermissionMode `plan` gets `planHint`) — finding `F-DISCUSS-1` | `planHint` exists for PM `plan` (different dimension) | n/a |
| **Persisted?** | no (D-2); resume → EXECUTE | no (D-2) | n/a (default) |
| **Hooks** | blocked (`src/hooks/run.ts`) | allowed | allowed |
| **MCP** | blocked on non-EXECUTE | blocked on non-EXECUTE | PM decides |
| **Footer label** | `DISCUSS·<pm>` (TUI only) | `PLAN·<pm>` (TUI only) | `<pm>` only |

Evidence: `[PROVEN-SOURCE]` for all cells except prompt-hint cell also `[PROVEN-TEST]` for hooks
(`work-mode-hooks` 10/10 reported) and sub-agent inheritance; D-2 cell `[PROVEN-SOURCE]`.

**Contract gaps (not contract violations):**

- `F-DISCUSS-1` `[OPEN]` — no `discussHint`; the model is never told it is in a read-only posture,
  so denials surface as confusing "permission denied" rather than as the mode. Adding a hint is
  **`[OWNER-DECISION]`** (UI/UX audit Q2 / Option A).
- `F-DISCUSS-5` `[RESOLVED-AS-DECISION]` — non-persistence is `D-2`, owner-approved; treat as
  contract, not defect. Re-opening it (sticky DISCUSS across `--resume`) is `[OWNER-DECISION]`
  (Q5).
- Naming: the implemented DISCUSS is a **read-only ceiling (18 tools incl. network
  `web_fetch`/`web_search`)**, **not** "conversation-only, no tools". A conversation-only mode does
  not exist anywhere in the product. Whether that gap matters is `[OWNER-DECISION]` (Q1).

---

## 5. Mode path analysis, end-to-end

```
CLI --work-mode flag  >  MINICODE_WORK_MODE env  >  EXECUTE (default)     [cli/args.ts]
ACP:   params.workMode                                                  [cli/commands/acp.ts]
exec:  flag/env only (no mid-session switch)                            [cli/commands/exec.ts]
TUI:   /work-mode  +  Shift+Tab picker  +  flag/env                      [cli/tui.ts]
                ↓
        resolveWorkMode → session ceiling handler (fail-closed injection)
                ↓
        tool-layer.setWorkMode → live re-filter of visible tool array; MCP gated non-EXECUTE
                ↓
        composeWorkModePermissionHandler(ceiling, injected PM handler)
                ↓
        footer paintFooterMode(mode, workMode)  →  "DISCUSS·auto" | "PLAN·auto" | "<pm>"
```

| Path | Setter | Label shown | Denial mode | Evidence |
|---|---|---|---|---|
| One-shot / pipe | flag/env only | **none** | silent ceiling deny | `[PROVEN-SOURCE]` |
| `exec` (headless) | flag/env only | **none** | silent ceiling deny | `[PROVEN-SOURCE]` |
| Interactive TUI | `/work-mode`, Shift+Tab, flag/env | `DISCUSS·auto` footer | footer warning color | `[PROVEN-SOURCE]` |
| ACP (IDE) | `params.workMode` | machine envelope (n/a) | protocol deny | `[PROVEN-SOURCE]` |
| Resume (`--resume`) | not persisted → **EXECUTE** | — | — | `[PROVEN-SOURCE]` (D-2) |
| Sub-agent | inherits parent ceiling | — | no escalation | `[PROVEN-TEST]` (`work-mode-subagent`) |

End-to-end findings:

- `F-DISCUSS-4` `[OPEN]` — `/work-mode` and `/mode` are **TUI-only** (`handleBuiltinCommand` has no
  `work-mode`/`mode` case). One-shot/exec therefore **enforce DISCUSS silently with no label**: the
  user gets "permission denied" with no indication the mode is active. Fixing (linear label or
  startup notice) is `[OWNER-DECISION]`-lite — scope change, not an invariant change (Q4).
- `--plan` proceed-gate keys on `ctx.permissionMode === "plan"`, **not** WorkMode `PLAN`/`DISCUSS` —
  WorkMode PLAN has no interactive handoff. `[PROVEN-SOURCE]`, `[OPEN]` (design inference that this
  is undesirable: `[DESIGN-INFER]`).
- CLI precedence flag > env > EXECUTE default confirmed by pure resolver test
  (`work-mode-cli`). `[PROVEN-TEST]`
- The `DISCUSS` truth-table, contract comparison (options A–D), and root-cause classification
  (taxonomy item 8: implementation matches D-1 contract, but the label "discussion mode" carries
  semantics beyond "read-only ceiling") are in the UI/UX deep audit §4 and are adopted here
  unchanged. `[DESIGN-INFER]` for the taxonomy classification.

---

## 6. Tool visibility vs enforcement

This is the one **genuine correctness gap** found (`F-DISCUSS-3`).

| Set | Count | Members | Used for | Source |
|---|---|---|---|---|
| `READONLY_TOOLS` | **18** | enforcement read-only set | **what the ceiling allows** (gate) | `src/policy/permission.ts:33-52` `[PROVEN-SOURCE]` |
| `EXPLORE_TOOL_NAMES` (= `allowedInExplore`) | **12** | `git_log, git_status, glob, grep, lsp_definition, lsp_diagnostics, lsp_hover, lsp_workspace_symbols, mcp_list, read_file, read_memory, todo_read` | **what the model can see** (visibility) | `src/policy/tool-contract.ts` derived `[PROVEN-SOURCE]` |

Relationship: `EXPLORE_TOOL_NAMES ⊂ READONLY_TOOLS` (12 ⊂ 18), i.e. enforcement is **broader** than
visibility. `docs/choosing-mode.md` now states both numbers correctly ("gerbang mengizinkan 18 …
model hanya melihat 12"). The UI/UX audit glossary still says `EXPLORE_TOOL_NAMES (~13)` — **stale
count** `[OPEN]` (doc fix).

Consequences of the 6-tool gap (enforced-allowed but hidden):

- `web_fetch`, `web_search` (network reads), `read_image`, `git_diff`, `lsp_references`,
  `lsp_symbols` are **permitted by the DISCUSS ceiling but never shown to the model** — so DISCUSS
  silently under-delivers its own contract (and the model may not know network browsing is allowed).
  `bash_output` is hidden **and** denied. `[PROVEN-SOURCE]` + `[DESIGN-INFER]` for the under-delivery
  consequence.
- **No test reconciles the two sets.** `work-mode-tool-visibility.test.ts` only asserts the
  intersection; there is no drift test pinning `READONLY_TOOLS ⊇ EXPLORE_TOOL_NAMES`. `[OPEN]`,
  `[PROVEN-TEST]` (gap proven by reading the test's assertions).

Why this is not an architecture violation: visibility is *not* a security boundary (roadmap
invariant: "prompt/hidden tool list is not a security boundary"); enforcement is. The gap is a
correctness/expectation issue, not a leak. `[DESIGN-INFER]`

Designation: `tool-contract.ts` **is** the single source registry (Fase 2 / TOOL-01 unification);
`permission.ts` still holds its own `READONLY_TOOLS` set, which is the divergence root. Reconciling
(Option B: DRY the list, decide `web_fetch`/`web_search` in/out) is `[OWNER-DECISION]` Q3.

---

## 7. UI/UX across surfaces

Surface model (linear REPL removed; three real surfaces + ACP):

| Surface | Entry | Renderer | WorkMode label | Setter |
|---|---|---|---|---|
| One-shot / pipe | `minicode "prompt"` / pipe | `simple.ts` linear | **none** | flag/env |
| exec (headless) | `minicode exec "prompt"` | linear + JSON envelope | **none** | flag/env |
| Interactive TUI | `minicode` (TTY) / `--interactive` | `tui/app.ts` fullscreen | `DISCUSS·auto` footer | `/work-mode` + flag/env |
| ACP | `minicode acp` | machine envelope | n/a | `params.workMode` |

`[PROVEN-SOURCE]` (UI/UX audit §6, anchors verified).

Findings consolidated from the UI/UX deep audit §11 registry (stable IDs reused verbatim):

| ID | Pri | Summary | Status here |
|---|---|---|---|
| `F-DISCUSS-1` | P1 | no `discussHint` prompt for DISCUSS (contrast `planHint`) | `[OPEN]`, fix = `[OWNER-DECISION]` |
| `F-DISCUSS-2` | P1 | "DISCUSS" = read-only ceiling, not conversation-only | `[OPEN]` semantics question = `[OWNER-DECISION]` Q1 |
| `F-DISCUSS-3` | P1 | visibility (12) vs enforcement (18) list drift; no drift test | `[OPEN]`, reconcile = `[OWNER-DECISION]` Q3 |
| `F-DISCUSS-4` | P1 | WorkMode label + `/work-mode` TUI-only; one-shot/exec silent | `[OPEN]`, fix scope = `[OWNER-DECISION]` Q4 |
| `F-DISCUSS-5` | P2 | non-persistence (D-2) | `[RESOLVED]` (accepted decision, not defect) |
| `F-ENV-1` | P1 | `process.env` **writes** as UI state (`collapse.ts:55`, `detail.ts:14`, `reasoning.ts:10`) — leaks into child sub-agents/MCP | `[OPEN]` cross-cutting UX debt |
| `F-TYPE-1` | P2 | unjustified `any` at `adapter.ts:632,635`, `tui/app.ts:371,374` (2 of 5 sites justified) | `[OPEN]` |
| `F-APPROVAL-1` | P1 | approval card lacks risk tier + diff preview | `[OPEN]` |
| `F-CTRL-1/2` | P1 | ACE verdict & VERIFYING/Tamper reasons hidden (stderr only) | `[OPEN]`, defer (not DISCUSS) |
| `F-CTX-1/2` | P1/P2 | no context meter/cost in footer; mid-stream cutoff → stderr only | `[OPEN]` |
| `F-TASK-1` | P1 | canonical `taskId`/DAG/lease not rendered | `[OPEN]`, defer |
| `F-AGENT-1` | P1 | sub-agent pool slots not keyed to `runId` | `[OPEN]`, defer |
| `F-MEM-1`, `F-TOOL-1`, `F-DAEMON-1` | P2 | memory write/supersession, MCP schema-drift card, REPLAY→LIVE badge invisible | `[OPEN]`, defer |
| `F-MONO-1` | P2 | `simple.ts` (~673 loc), `TuiApp` (1416 loc) monoliths | `[OPEN]`, structural |

Render-layer `process.env` **reads** (`theme.ts` lazy getters, `app.ts` mouse selection) are
read-only config and fine. The three **writes** are cosmetic toggles, i.e. a design smell causing
cross-session bleed, **not** a currently-exploitable security boundary. `[PROVEN-SOURCE]` +
`[DESIGN-INFER]`.

Terminal contract: I35 (WorkMode invariant in `docs/TERMINAL_CONTRACT.md`) plus the frozen footer
width/padding behavior are respected by the current footer; any change to a labeled surface must
update the contract + protection map. `[DESIGN-INFER]`

---

## 8. Owner-decision compatibility

All seven owner decisions are `OWNER APPROVED — DIRECTION` (2026-10-18); P12 is
`CLOSED / VERIFIED` (owner, 2026-10-22) with residuals accepted in `P12_PHASE_CLOSURE_REPORT.md`.

| D | Approved direction | This report's compatibility |
|---|---|---|
| **D-1** | WorkMode ⊥ PermissionMode; DISCUSS/PLAN/EXECUTE; thin intent layer, no implicit escalation; DISCUSS read-only; PLAN old contract; EXECUTE follows PM; 6 PMs compatible | **compatible** — nothing proposed changes the semantics `[PROVEN-SOURCE]` |
| **D-2** | mode not auto-persisted; refactor no-behavior-change; K-1 preserved | **compatible** — non-persistence kept (`F-DISCUSS-5` closed as decision) |
| **D-3** | `readonly` outside picker; injected policy never weakened via `/mode`/Shift+Tab/sub-agent/other paths | **compatible** — ceiling only narrows, injection opaque |
| **D-4** | canonical registry anti-drift; observable decisions; replay+regression prove equivalence | **compatible**, but note: registry unified in `tool-contract.ts` while `permission.ts` keeps a parallel `READONLY_TOOLS` — this is the `F-DISCUSS-3` divergence root and is exactly the anti-drift spirit of D-4 `[OPEN]` |
| **D-5** | vendor changes only on evidence bundle (unrelated to mode) | unaffected |
| **D-6** | observability preserved first; expansion = separate decision + compat test | the deferred `F-CTRL-1/2`, `F-TASK-1`, `F-MEM-1`, `F-TOOL-1`, `F-DAEMON-1` items correctly route through D-6 |
| **D-7** | documented baseline, focused slice, stop on new unexplained failure, **no strict-green claim**, no expensive gates on doc tasks | this report honors it: stage-scoped claims only, gates scoped |

**No finding requires changing D-1…D-7 or K-1.** Every proposed behavior change in §11 is either
(a) a prompt/label/doc/test addition that leaves all seven decisions intact, or (b) explicitly
routed to the owner. `[DESIGN-INFER]`

Cross-reference: `docs/TERMINAL_CONTRACT.md` I35 is the frozen WorkMode terminal invariant; the
`F-DISCUSS-4` label fix (if approved) touches output and therefore **must** update the contract +
protection-map test. `[DESIGN-INFER]`

---

## 9. Findings — done / open / owner-decision

### 9.1 Done / resolved `[RESOLVED]`

1. Baseline integrity (`cb60212` vs `57c59d3`, 7-file delta, clean tree) — §1.
2. `audit:harness` 60/0, `gate:bash` 62/0/0, `bench:smoke` 13/13 green at `cb60212` — §2.2.
3. All seven security invariants (INV-WM1, INV-WM4, D-1 ceiling, D-2 non-persist, allow-always
   under ceiling, sub-agent no-escalation, no model self-raise) held — §3.
4. `F-DISCUSS-5` non-persistence = accepted owner decision, not a defect — §4.
5. Two-dimension model (WorkMode ⊥ PermissionMode) confirmed intact end-to-end — §3, §5.
6. CLI precedence (flag > env > EXECUTE) proven by pure resolver test — §5.

### 9.2 Open `[OPEN]`

1. `F-DISCUSS-1` no `discussHint` — model never told it is read-only → confusing denials.
2. `F-DISCUSS-3` visibility (12) vs enforcement (18) list drift; **no drift/no-drift test**;
   6 tools allowed-but-hidden (`web_fetch`, `web_search`, `read_image`, `git_diff`,
   `lsp_references`, `lsp_symbols`), `bash_output` hidden+denied.
3. `F-DISCUSS-4` `/work-mode`+label TUI-only; one-shot/exec silent enforcement with no label.
4. `--plan` proceed-gate keyed on PM `plan`, not WorkMode `PLAN` (no interactive handoff for
   WorkMode PLAN).
5. `F-ENV-1` `process.env` UI-state writes (3 sites) leaking to children.
6. `F-TYPE-1` unjustified `any` (2 of 5 event-boundary sites); `F-APPROVAL-1` approval card
   missing risk tier + diff preview.
7. Defer pile: `F-CTRL-1/2`, `F-CTX-1/2`, `F-TASK-1`, `F-AGENT-1`, `F-MEM-1`, `F-TOOL-1`,
   `F-DAEMON-1`, `F-MONO-1`.
8. Stale doc count: UI/UX audit glossary `EXPLORE_TOOL_NAMES (~13)` should be **12**
   (`docs/choosing-mode.md` already correct at 18/12).
9. CI check = N/A (no `.github/workflows`); no smoke-build/package script defined.

### 9.3 Owner decision needed `[OWNER-DECISION]`

| # | Question (UI/UX audit §15 numbering kept) | Blocks |
|---|---|---|
| Q1 | Is DISCUSS meant as **read-only investigation (18 tools, browsing allowed)** or **conversation-only (no tools)**? Code implements the former; conversation-only does not exist. | whether any code change is needed at all vs only docs/label |
| Q2 | Should DISCUSS emit a **`discussHint`** prompt (mirror `planHint`)? | `F-DISCUSS-1` fix (Option A, ~6 lines, prompt-only) |
| Q3 | Reconcile visibility + enforcement to **one** list; is `web_fetch`/`web_search` in or out? | `F-DISCUSS-3` fix (Option B) + drift test |
| Q4 | Expose `/work-mode`/label on one-shot/exec (linear "work mode: DISCUSS" notice), or is TUI-only + flag sufficient? | `F-DISCUSS-4` fix (touches terminal contract I35) |
| Q5 | Keep D-2 non-persistence, or make DISCUSS sticky across `--resume`? | `F-DISCUSS-5` stays closed unless re-opened |

None of Q1–Q5 is urgent for security; all are UX/correctness-of-expectation. Escalation only —
no owner decision is being made or implied by this report.

---

## 10. Acceptance criteria

This consolidation is **accepted** when all of the following hold (all `[PROVEN]` against
`cb60212` unless noted):

1. **Baseline**: HEAD `cb60212`, clean tree apart from the two pre-existing untracked audit files;
   7-file +105/−6 delta matches the UAT report exactly. — §1
2. **Gates, UAT-reported at same candidate**: `tsc` ✅ · `lint` ✅ · `gate:coverage` ✅ (88.44%
   funcs / 89.13% lines / 19-of-19 floors / 0 fail) · `gate:pack` ✅ (23/0). — §2.1
3. **Gates, run here**: `audit:harness` 60/0/2 · `gate:bash` 62 patterns 0 bypass 0 over-block ·
   `bench:smoke` 13/13. — §2.2
4. **Gate superset**: the `gate:fast` chain is green across the two reports on one candidate; CI
   N/A (no workflows); smoke build/package N/A (no script defined) — both recorded, not faked.
   — §2.3
5. **Architecture**: WorkMode ⊥ PermissionMode proven in source; ceiling only narrows; injected
   handler fail-closed; all 7 invariants held. — §3
6. **Three-mode contract**: DISCUSS/PLAN/EXECUTE behavior table fully evidenced; the only contract
   gap (`discussHint`) is labelled, not silently accepted. — §4
7. **End-to-end paths**: flag>env>EXECUTE, TUI, ACP, exec, resume, sub-agent, hooks, MCP gating all
   traced with source anchors; silent-enforcement surfaces named. — §5
8. **Visibility vs enforcement**: both sets enumerated (18 vs 12), subset relation stated, drift
   test gap flagged, `tool-contract.ts` designated single source. — §6
9. **UI/UX**: 4-surface model + full findings registry (stable IDs) consolidated with per-item
   status. — §7
10. **Owner-decision compatibility**: D-1…D-7 all compatible or routed; **no change to D-1/D-2/K-1
    semantics**; five open questions escalated, none self-decided. — §8
11. **Findings + recommendations**: every finding classified by evidence type and grouped; no
    strict-green/release-readiness claim made (AGENTS.md scope rule). — §9, §11

**Scope note:** this report is stage-scoped validation + architecture contract. It does **not**
close the Quality Remediation track or assert release-readiness; that still requires the full
AGENTS.md final sequence on one final candidate (plus smoke build/package and CI — the latter two
being currently N/A by absence of definition).

---

## 11. Grouped recommendations

Ordered by risk. **Nothing below is implemented**; each group states its owner-decision status.

### Group A — zero-risk, prompt-only (needs Q2)
1. Add `discussHint` to the `buildSystemPrompt` path when WorkMode = DISCUSS (`session.ts`
   ~:163-170), mirroring `planHint`. ~6 lines, prompt-only, **cannot weaken any security
   property** (prompt is not a boundary). Closes `F-DISCUSS-1`.
   → **`[OWNER-DECISION]` Q2.**

### Group B — correctness of capability expectation (needs Q3, Q4, Q1)
2. Reconcile visibility vs enforcement: DRY `READONLY_TOOLS` from the `tool-contract.ts` registry,
   decide explicitly whether `web_fetch`/`web_search` are in the DISCUSS set, and add a
   **no-drift test** asserting `EXPLORE_TOOL_NAMES ⊆ READONLY_TOOLS`. Closes `F-DISCUSS-3` and
   hardens D-4 anti-drift. → **`[OWNER-DECISION]` Q3.**
3. Surface WorkMode on linear surfaces (one-line `work mode: DISCUSS` startup notice or footer
   token) **or** document TUI-only as intended. Closes `F-DISCUSS-4`. Because this changes terminal
   output, it **must** update `docs/TERMINAL_CONTRACT.md` I35 + its protection-map test.
   → **`[OWNER-DECISION]` Q4.**
4. Resolve the DISCUSS semantics question (read-only investigation vs conversation-only) so docs,
   label, and behavior say the same thing. → **`[OWNER-DECISION]` Q1.**

### Group C — doc hygiene (no owner decision; pure fix)
5. Fix the stale `EXPLORE_TOOL_NAMES (~13)` count in the UI/UX audit glossary appendix → **12**,
   matching `docs/choosing-mode.md` (already 18/12). `[OPEN]` → doc edit only.

### Group D — cross-cutting UX/state debt (no mode-semantics impact; normal slice)
6. Replace the three `process.env` UI-state **writes** with module-level getter/setter + bootstrap
   default (`F-ENV-1`), narrowing to instance-scoped state only if/when multi-session becomes real.
7. Narrow the two unjustified `any` event-boundary sites to `UiEvent`/`DomainEvent`, keeping the
   single justified vendor-contravariance erosion at `contract.ts:70` (`F-TYPE-1`).
8. Approval card: add risk tier + diff preview (`F-APPROVAL-1`).

### Group E — defer (D-6 route: separate decision + compatibility test before any of it)
9. Frontier HUD / structured cards for ACE verdict, VERIFYING/Tamper reasons, canonical
   `taskId`/DAG, sub-agent pool slots, memory write/supersession, MCP schema-drift approve/reject,
   REPLAY→LIVE badge (`F-CTRL-1/2`, `F-CTX-1/2`, `F-TASK-1`, `F-AGENT-1`, `F-MEM-1`, `F-TOOL-1`,
   `F-DAEMON-1`). Each needs an additive `consequence.detected`-style event + contract update.
10. Structural: split `simple.ts` / `TuiApp` monoliths (`F-MONO-1`) — lowest priority.

### Group F — validation/infra gaps (record, don't invent)
11. CI: **no workflow files exist** → N/A for now; if CI is ever desired it must be added
    deliberately (owner call), not assumed.
12. Smoke build/package: **no script defined** in `package.json`; packaging is already covered by
    `gate:pack` (23/0). If a distinct smoke-build gate is wanted, define the script first, then
    run it — never guess the command.
13. Re-run the full AGENTS.md sequence on one final candidate before any release-readiness or
    Quality-Remediation-track closure claim (this report explicitly does not make one).

---

*Prepared read-only on candidate `cb60212`. Gates cited as `[PROVEN-UAT]` were reported by the UAT
at that candidate; gates `[PROVEN-TEST]` were executed for this report; historical numbers from
`ROADMAP.md` checkpoints are historical and not restated as current status.*
