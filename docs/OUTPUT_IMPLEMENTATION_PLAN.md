# Output Architecture Implementation Plan

**Status:** Phase 1–8 landed; canonical presentation policy is active on all user-facing surfaces. Legacy ACP `type:"tool"` remains a compatibility window.
**Tanggal:** 2026-09-25  
**Related:** `docs/OUTPUT_ARCHITECTURE_AUDIT.md`, `docs/OUTPUT_EVENT_MODEL.md`, `docs/OUTPUT_PROTOCOL_SPEC.md`, `docs/OUTPUT_RENDERING_SPEC.md`, `docs/OUTPUT_UX_RULES.md`

## 1. Keputusan

Migrasi bersifat incremental dan dapat dibalik:

```text
raw runtime events
  → canonical semantic events
  → pure PresentationState
  → policy projection
  → TUI / linear / exec / ACP
```

Tidak melakukan rewrite `vendor/minicore/**`, tidak mengganti terminal primitives,
dan tidak menghapus jalur lama sebelum parity contract serta satu rollout flag-on
terbukti.

## 2. Baseline saat plan dibuat

- Mouse wheel/drag app-level selection, `/copy [n]`, Esc-only abort, popup lifecycle,
  sanitasi, width, and terminal ownership are already implemented in the working tree.
- Current baseline after Phase 2–8: 2587 pass, 22 skip, 0 fail; coverage 84.52% funcs /
  85.53% lines; pack 23/23; web build/check pass.
- `PresentationAdapter`/reducer drive all user-facing surfaces through the
  canonical state; raw ledger TUI and the rollback flag were removed in Phase 8.
- `rebuildFromDurable()` is production-wired from the durable presentation event
  table, with child-session event persistence and interrupted-state recovery.
- The pack size guard is 2.25 MiB: six required audit artifacts add about 80 KB;
  the guard still rejects forbidden runtime/test content and accidental dependency
  inclusion.
- OAP-001, OAP-002, OAP-004–OAP-010, OAP-012, and OAP-013 remain carried forward;
  Phase 2 closes the state/receipt/replay slice, not renderer migration.

## 3. Hasil Phase 1

- `user.message` sekarang durable di `DomainEvent` dan direduksi ke
  `ConversationEntry` tanpa menggandakan turn.
- `toPresentationEvent()` di `cli/setup.ts` memetakan seluruh 20
  `DomainEventType`, termasuk model/reasoning/file/test/context/progress.
- `PROPOSED_EVENT_TYPES` menandai `reasoning.completed`, `tool.progress`, dan
  `test.completed` sebagai event tanpa producer; mapper tidak mengarangnya.
- `unsupportedProjection` diagnostics dan fixture exhaustive menjaga bridge
  agar event baru tidak diam-diam dropped.
- Historical Phase 1 snapshot: 2581 pass / 22 skip / 0 fail. At that point the
  renderer still used the raw bus and Phase 4 had not started.

## 3.1 Hasil Phase 2 core

- `PresentationState` sekarang memiliki collection conversation, reasoning, system,
  plan, finding, result, diagnostic, serta marker eviction bounded.
- `deriveTurnSummary()` menghitung status tool, unique normalized paths, test
  aggregate, checkpoint, duration dari timestamp, dan late evidence tanpa clock/IO.
- `file.changed`/`test.completed` yang tiba sebelum atau sesudah activity terminal
  tetap masuk sebagai evidence; checkpoint callback sekarang memancarkan
  `checkpoint.created` semantic event.
- `presentation_events` SQLite table menyimpan durable event idempotent, scrubbed,
  dan TERMINAL/branch/TTL/delete-aware; setup memuat dan rebuild-nya sebelum
  adapter-seq baru dibuat.
- Historical migration detail: before Phase 8,
  `MINICODE_PRESENTATION_V2=0` disabled shadow projection/replay while the raw
  content stream remained available. Child sessions also wrote their own
  semantic event log.
- Regression tests: semantic collections, summary late evidence, cross-session
  identity, bounded eviction, persistence idempotency/scrubbing, checkpoint bridge,
  adapter provider, branch/child/delete/TTL lifecycle, dan resume rebuild.
- Setiap event terminal kini memakai `eventSeq` unik; basis bersama sebelumnya
  membuat `INSERT OR IGNORE` durable melewatkan event berikutnya.
- Phase 2 parity landed: contract restart/child/resume/branch/delete/TTL diuji;
  `finding.detected` terbit dari `result.findings` eksplisit pada
  `submit_result`; `test.completed` hanya terbit dari verify output yang memiliki
  hitungan pass/fail terstruktur.

## 3.2 Hasil Phase 3–8

- Phase 3: modul policy murni `src/presentation/projection.ts` (seleksi node per
  mode, deskripsi activity/turn, running pin + ambang elapsed, envelope
  `minicode.output.v1`, kategori error machine, digest divergensi) + 14 test
  policy tabel-driven.
- Phase 4/5: TUI dan linear memakai keputusan policy via injeksi `cli/`
  (`PresentationPolicy`); parity test policy-vs-legacy identik; label turn-status
  via `activityFor`; test inventaris writer OAP-008.
- Phase 6: `exec --json` streaming envelope kanonik + summary berversi + setup
  failure selalu ber-envelope; ACP lifecycle penuh + cancel terminal + persist
  headless; sanitasi ANSI + scrub di tepi mesin.
- Phase 7: `persistCurrent` di jalur headless exec/ACP; resume notice tetap
  stderr mesin-aman; ambang coverage naik ke 84/85.
- Phase 8: rollback flag dihapus, raw ledger TUI + `targetForFallback` dihapus
  (3 test dimigrasi ke event presentasi); legacy `type:"tool"` ACP dipertahankan
  satu jendela kompat; queue durable dibatasi, result generic diringkas, dan
  buffer/render TUI dibatasi; full gate hijau.

## 4. Fase migrasi

Every phase has a rollback boundary. A phase is complete only when its tests and
the repository gates are green.

### Phase 0 — Baseline and contract lock

**Goal:** make the current behavior measurable before changing its source.

**Files/modules:** `test/presentation-*.test.ts`, `test/tui-*.test.ts`,
`test/acp.test.ts`, `test/exec-json-envelope.test.ts`, `test/pty.test.ts`,
`docs/TERMINAL_CONTRACT.md`.

**Dependencies:** none.

**Behavior changes:** none.

**Risks:** flaky fake TTY/ConPTY tests may hide platform-specific output drift.

**Tests/gates:** capture golden fixtures for normal/verbose/exec/ACP; run full test,
coverage, pack, and web check; record skip reasons explicitly.

**Migration/rollback:** documentation/test-only; revert isolated fixture commit if
fixture is unstable.

### Phase 1 — Canonical event boundary and exhaustive projection

**Goal:** make all semantic events explicit and stop silent bridge drops.

**Files/modules:** `src/presentation/events.ts`, `src/presentation/adapter.ts`,
`src/ui/contract.ts`, `cli/setup.ts`; approval hooks in
`src/ui/approval/prompt.ts` and policy path only as needed.

**Dependencies:** OAP-002/OAP-003 decisions; preserve raw event compatibility.

**Behavior changes:** add `user.message`, `reasoning.completed`, file/test/context/
diagnostic projection where a real producer exists; retain current raw event names
during migration. Missing producer events are marked proposed, not fabricated.

**Risks:** double-emission if adapter and existing sinks both publish terminal lines;
exhaustive mapper may expose existing anomalies.

**Tests/gates:** every DomainEvent has producer-or-proposed status; every event type
has a consumer/projection test; duplicate/late/out-of-order fixtures; no throw from
mapper.

**Migration/rollback:** flag and raw TUI ledger were removed in Phase 8; the
runtime EventBus remains only for streaming content and debug/trace transport.

### Phase 2 — Complete presentation state and truthful summaries

**Status:** landed; state/reducer is replayable and renderer authority is wired.

**Goal:** make `PresentationState` a replayable semantic model, not a partial index.

**Files/modules:** `src/presentation/model.ts`, `reducer.ts`, `store.ts`,
`label.ts`, `adapter.ts`, `src/tools/submit_result.ts`, journal/checkpoint
adapters in `cli/setup.ts`, dan child wiring di `cli/index.ts`.

**Dependencies:** Phase 1; durable store format.

**Behavior changes:** add user/conversation, reasoning, system, plan, finding, result,
and diagnostic collections; compute `filesChanged`, receipts, test summary, and
checkpoint from events/journal rather than constants.

**Risks:** increased memory and migration of `/expand`/copy semantics; payload cap must
remain explicit.

**Tests/gates:** replay durable == live minus deltas; state bounded; evict marker;
receipt counts truthful; restart test from session/journal evidence; reducer purity
and no clock/IO grep.

**Migration/rollback:** keep old `getPresentationSnapshot()` output as a compatibility
adapter until all consumers pass.

### Phase 3 — Shared projection policy

**Status:** landed (`src/presentation/projection.ts` + `test/presentation-policy.test.ts` + parity harness TUI/linear).

**Goal:** one state to normal/verbose/debug/machine projections.

**Files/modules:** new pure projection module under `src/presentation/`, label/format
boundaries; no import from `src/ui` into `src/presentation`.

**Dependencies:** Phase 2; i18n keys and status vocabulary.

**Behavior changes:** visual verbosity and disclosure become policy decisions; TUI
layout, linear wrapping, and machine JSON remain different renderers but share
semantic node selection.

**Risks:** normal output becoming too sparse or verbose output becoming noisy.

**Tests/gates:** table-driven node policy tests; normal/verbose/debug/machine
snapshots; semantic parity assertions; no renderer status parsing.

**Migration/rollback:** projection ran beside the legacy path during rollout and
reported divergence; Phase 8 removed the rollout seam after parity.

### Phase 4 — TUI projection (completed rollout)

**Status:** landed (policy di-inject via `cli/tui.ts`; raw TUI ledger and its rollback path were removed in Phase 8; parity tests remain as regression protection).

**Goal:** move TUI transcript/activity/selection to canonical state without breaking
current screen ownership.

**Files/modules:** `src/ui/tui/transcript.ts`, `src/ui/tui/app.ts`,
`src/ui/runtime/screen.ts` only where lifecycle wiring needs an explicit snapshot;
`cli/tui.ts` composition.

**Dependencies:** Phases 1–3; current selection/source-map tests; frozen terminal
contract.

**Behavior changes:** canonical terminal activity, summary, error, reasoning state;
existing transcript cap, evict marker, prompt/footer geometry, popup, wheel, drag,
Ctrl+C, Esc, and busy rules remain unchanged.

**Risks:** live deltas may arrive before durable model completion; selection anchors
can be evicted; resize may re-render different text source.

**Tests/gates:** existing TUI tests plus canonical-vs-legacy fixture; stream+resize+
abort+popup+selection fuzz; PTY on POSIX; transparent ConPTY skip.

**Migration/rollback:** the rollout flag was removed in Phase 8 after the parity
  gate and release 0.12.0.

### Phase 5 — Linear/one-shot projection and writer policy

**Status:** landed (keputusan status/suffix linear dari policy; `turn-status` label via `activityFor` DI; `test/writer-inventory.test.ts` mengunci OAP-008).

**Goal:** remove semantic decisions from `simple.ts` while preserving stdout/stderr
behavior and copy contents.

**Files/modules:** `src/ui/assistant/simple.ts`, `turn-status.ts`,
`src/ui/runtime/statusline.ts`, approval/command controllers, `cli/commands.ts`.

**Dependencies:** Phase 3; stream ownership inventory; i18n/table/selection contract.

**Behavior changes:** activity, error, summary, reasoning, and table disclosure from
projection; writer category decides stdout/stderr/transient.

**Risks:** duplicate ledger lines, reasoning duplication, non-TTY SGR regression,
answer `/copy` mismatch, direct console output from builtin commands.

**Tests/gates:** normal/verbose text fixtures, `NO_COLOR`, non-TTY, split stream,
abort/EOF, copy equivalence, table parity, direct-writer guard.

**Migration/rollback:** the rollout flag was removed after the parity gate in
Phase 8; raw handlers remain only where they carry streaming content, not
semantic status decisions.

### Phase 6 — Exec and ACP machine projection

**Status:** landed (`exec --json` = envelope `minicode.output.v1` + summary berversi; ACP lifecycle penuh + cancel terminal + persist headless; legacy `type:"tool"` hanya bila lifecycle absen).

**Goal:** give CI/IDE consumers a stable semantic protocol.

**Files/modules:** `cli/commands/exec.ts`, `cli/commands/acp.ts`,
`src/ui/contract.ts`, `src/presentation/` machine mapper, `src/policy/scrub.ts` use.

**Dependencies:** Phase 1 event envelope; Phase 2 snapshots; protocol spec.

**Behavior changes:** versioned `minicode.output.v1`; canonical lifecycle in exec/ACP;
human semantic raw event output is debug-only while text deltas remain a transport;
setup failure always emits terminal machine summary; ACP cancel/shutdown guarantees
explicit terminal response.

**Risks:** breaking existing integrations; duplicate text/lifecycle records; scrub
changes alter payload shape.

**Tests/gates:** wire-level JSON/ACP fixtures, malformed input, setup failure, cancel
race, shutdown race, secret/control-byte scrub, no ANSI/stdout contamination, exit
codes 0/1/2.

**Migration/rollback:** support legacy event names for one compatibility window;
switch machine flag independently from TUI/linear only if contract tests allow.

### Phase 7 — Durable resume and legacy direct-writer migration

**Status:** landed (`persistCurrent` di jalur headless exec/ACP; setup-failure selalu ber-envelope; writer inventory test; resume notice tetap stderr mesin-aman).

**Goal:** make crash/restart observable through the same semantic model and centralize
permanent/diagnostic writer categories.

**Files/modules:** `session/persistence`, `session/journal`, `turn-marker`,
`checkpoint`, `cli/setup.ts`, CLI controllers, popup/form/input fallbacks.

**Dependencies:** Phase 2; chosen durable event format; no changes to kernel vendor.

**Behavior changes:** resume rebuilds state; interrupted/partial markers visible;
new direct writes require category/owner.

**Risks:** migration from existing session files; old sessions lack event metadata;
foreign stderr writer compatibility.

**Tests/gates:** crash marker + pending journal + resume; exit/signal cleanup; writer
inventory test; machine/non-TTY safety.

**Migration/rollback:** old session path remains fallback; disable only new writer
route, not persistence.

### Phase 8 — Shadow removal and cleanup

**Status:** landed — flag `MINICODE_PRESENTATION_V2` dihapus, raw ledger TUI dihapus (migrasi 3 test ke event presentasi), parity policy-vs-legacy tetap hijau; legacy `type:"tool"` ACP dipertahankan satu jendela kompat.

**Goal:** after rollout, eliminate duplicate truth and dead paths.

**Files/modules:** remove raw presentation subscriptions from user-facing surfaces,
retire legacy label/collapse/diagnostic classification only after usage inventory.

**Dependencies:** one release or equivalent validated rollout; all gates green.

**Behavior changes:** output remains same as canonical projection; direct diagnostic
fallback only for explicitly external writers.

**Risks:** hidden consumers or scripts relying on legacy raw output.

**Tests/gates:** full suite, PTY, protocol compatibility fixtures, `git diff --check`,
architecture/UI boundary tests, pack/web checks.

**Migration/rollback:** revert the isolated removal commit; do not combine cleanup with
semantic changes.

## 5. Finding-to-phase map

| Finding | Primary phase | Secondary gate |
|---|---:|---|
| OAP-001 dual truth | 1–4 | parity fixtures |
| OAP-002 lifecycle loss | 1 | adapter failure/cancel tests |
| OAP-003 partial bridge | 1 | exhaustive projection test |
| OAP-004 incomplete model | 2 | replay/model tests |
| OAP-005 summary/receipt | 2 | journal/checkpoint test |
| OAP-006 machine protocol | 6 | wire contract |
| OAP-007 durable rebuild | 7 | resume/crash test |
| OAP-008 direct writers | 5/7 | writer inventory |
| OAP-009 visibility | 3 | mode fixtures |
| OAP-010 classification | 1/3 | canonical outcome tests |
| OAP-011 unused vocabulary | 1 | producer inventory |
| OAP-012 user/plan/finding | 2/3 | semantic node tests |
| OAP-013 docs drift | 0/10 | docs link/protection test |

## 6. Validation scenarios

| # | Scenario | Required verification |
|---:|---|---|
| 1 | Simple coding task | one final message, no duplicate completion, machine summary |
| 2 | Multi-file edit | receipt paths, truthful file count, chronological order |
| 3 | Tool success | tool completed + duration + expand ref |
| 4 | Tool failure | failed cause/hint, no generic success |
| 5 | Permission denial | denied category/reason, headless explicit |
| 6 | Cancellation | task/tool cancelled, stream flushed/discarded once |
| 7 | Retry | new call + deterministic supersedes relation |
| 8 | Long-running task | active state, elapsed, no fake spam |
| 9 | Parallel analysis | grouped/aggregated, independent IDs |
| 10 | Large tool output | cap marker, content ref, expand behavior |
| 11 | Narrow terminal | 20/30/80 columns, no overflow, cursor safe |
| 12 | Resize | 120→30→80, transcript/source mapping stable |
| 13 | Ctrl+C | TUI copy-or-noop, Esc cancellation, raw cleanup |
| 14 | No-color/limited ANSI | status words, ASCII fallback, no meaning loss |
| 15 | Verbose | useful detail without internal dump |
| 16 | Debug | scrubbed IDs/payloads and anomaly counters |
| 17 | Machine-readable | versioned NDJSON/ACP, no human stream contamination |

For every scenario verify semantic correctness, hierarchy, scrollback, error clarity,
noise, copyability, and mode consistency.

## 7. Rollout and rollback

- The rollout is complete: policy is injected at the composition root, raw TUI
  semantic ledger and the feature flag are removed, and streaming content remains
  a transport concern.
- Before any future semantic cleanup, run the parity and writer-inventory gates;
  do not reintroduce a second status authority.
- If a protocol field is consumed, preserve compatibility aliases for one window.
- Update `docs/TERMINAL_CONTRACT.md` only when observable terminal behavior changes;
  update its test map in the same change.
- Update `docs/ARCHITECTURE.html` when structure/dependencies change.

## 8. Completion criteria

The architecture is complete only when:

- semantic events are independent from rendering;
- runtime state is not accidentally exposed as normal UI;
- normal/verbose/debug/machine projections use one model;
- findings, plans, activities, errors, and results are distinct;
- permission, cancellation, timeout, partial, and interrupted states are explicit;
- parallel work is aggregated;
- TUI scrollback, copy/paste, Windows, no-color, and resize contracts remain intact;
- machine output is structured and versioned;
- durable resume can rebuild semantic state;
- legacy direct-print paths are inventoried and removed only after parity;
- all mandatory repository gates pass.

## 9. Current next action

Phase 1–8 landed. The current follow-up is limited to documentation drift and
post-change validation; keep future cleanup isolated from semantic changes.
