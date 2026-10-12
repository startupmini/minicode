# P1–P8 System Audit Report — MiniCode

**Verdict: `P1–P8 AUDIT COMPLETE — READY FOR PHASE 9`**

Qualification (binding): readiness is **conditional**. Audit completion is not
approval to begin Phase 9 implementation. Phase 9 must not assume the items in
§10 without the stated evidence. No remediation was implemented during this
audit; no production code, test, or gate was modified.

This is a preservation record of the audit performed against commit `59dcbfc`.
Evidence classes are kept distinct throughout: **CONFIRMED** (source Roots or
reproduced observation), **MEASURED** (executed timing with method), **STATIC**
(code-structure analysis), **INFERENCE** (reasoned but unexecuted),
**UNKNOWN** (insufficient evidence), **ACCEPTED** (ratified limitation).

---

## 1. Repository and environment fingerprint

- Repository: `D:\git\minicode`, branch `main`.
- Audited commit: `59dcbfcad10d182ca9dc10ba3f5b309c20973734`
  (`docs: record phase 5 formal closure with evidence audit`).
- `HEAD == origin/main`, working tree clean at audit start.
- Implementation commits in scope: `0af53da` (P5 scope), `82d50c2` (F-01),
  `02beb09` (F-03), `0751222` (F-04), `bedd9cc` (F-05), `59dcbfc` (P5 closure).
- OS: Microsoft Windows NT 10.0.26300.0. CPU: Intel i7-10700T @ 2.00 GHz.
  RAM: 15.7 GB. Runtime: Bun 1.4.2 (engines require `bun >= 1.1.13`).
  Node v22.23.2, git 2.55.0.windows.1 (environment tooling only).
- Test command: `bun test` (305 test files). Quality gates in `package.json`:
  `gate:fast`, `gate:coverage` (funcs ≥ 85 / lines ≥ 86 ratchet),
  `gate:bash`, `bench:smoke`, `audit:harness`.

## 2. Phase inventory

| Phase | Implementation home | Contract / closure record |
|---|---|---|
| P1 Runtime Foundation | `src/runtime/*`, `src/sandbox/*`, `vendor/minicore` executor/loop/session | M-series tests (`runtime-*`, `execution-*`, `supervisor`, `recovery*`); no single closure doc |
| P2 Session Architecture | `src/session/*` (persistence, identity, authority, journal, checkpoint) | `P2_CLOSURE_HANDOFF.md`, `P2_FINAL_CLOSURE_FORENSIC_AUDIT.md`, P2.11/P2.12 audits |
| P3 Context ↔ Session | `src/session/context-*.ts`, composed in `cli/setup.ts:910-1026,2034-2122` | `P3_PHASE_CLOSURE_REPORT.md` (closed with documented limitations) |
| P4 Agent Loop | `vendor/minicore` loop+session; host drivers `cli/setup.ts`, `cli/tui.ts`, `cli/index.ts`, `cli/commands/exec.ts` | `P4_PHASE_CLOSURE_REPORT.md` (closed with documented limitations) |
| P5 Tool Execution | `src/policy/*`, `src/tools/*`, `src/mcp/server.ts`, `src/app/tool-layer.ts` | `P5_TOOL_EXECUTION_SCOPE.md`, `P5_PHASE_CLOSURE_REPORT.md` (closed with documented limitations) |
| P6 Task System | `src/task/{model,store,sync,identity,assignment}.ts`, `src/tools/todo.ts` | `docs/TASK_*.md`, `TASK_FOUNDATION_*` docs |
| P7 TaskGraph | `src/task/{graph,graph-validate,readiness}.ts` | `PHASE-5B/C/D*` docs (legacy program numbering) |
| P8 Scheduler | `src/task/{scheduler,trigger,scheduling-policy,production-scheduler,autonomous-*}.ts` | `PHASE-6A…6L*`, `docs/design/PHASE-6*`, `docs/audit/PHASE-6*` docs |

## 3. Correctness and integration evidence

The following were verified by direct source inspection (file:line) and by
executing the cited tests during the audit. Audit-only; nothing was changed.

### P1 — Runtime Foundation (CONFIRMED unless noted)

- Lifecycle: fail-closed composition (`src/runtime/composition.ts:317-368`),
  host FSM `CREATED→STARTING→READY→DRAINING→CLOSING→CLOSED`
  (`src/runtime/runtime-host.ts:65-71`), canonical shutdown order
  admission-latch → host → execution-drain → event-drain → journal flush/close
  (`src/runtime/composition.ts:24-58,557-700`), idempotent single-promise
  shutdown (`:779-785`). `process.exit` owned by `cli/`, never the runtime;
  teardown stops runtime, background jobs, MCP/LSP, timers
  (`cli/setup.ts:2348-2416`).
- Timeout/cancellation: vendor 10-min turn deadline, `joinSignals`/`withAbort`
  race, 7 `throwIfAborted` points in the executor, abortable loop delay;
  backend wait bounded (5 s default); drain/escalation timers bounded and
  `unref`+cleared. Guaranteed: serial kernel commit, sticky terminal,
  first-terminal-wins. Best-effort (declared): actual process termination,
  `cancel ≠ terminated ≠ proven-dead`.
- Cleanup: job registry with owner tags + process-level reaper; backend
  handle disposal; atomic temp-file writes; per-operation session DB
  open→finally-close; listener/timer release paths verified.
- Errors: executor converts all non-abort failures to `isError` results;
  kernel fail-closed throws for invalid shapes; runtime journal returns
  status triples instead of throwing (except invalid `timeoutMs` and failed
  open).
- Idle (STATIC): zero `setInterval` in `src/runtime/*`; repo-wide sweep found
  only 7 timer sites (daemon host/resource, scheduler lease, CLI writer
  renew, 3 UI paint timers), each unref'd with a clear path. No polling loop
  for tasks; scheduler wake-up is manual-only (`/scheduler run`).

### P2 — Session Architecture (CONFIRMED unless noted)

- `saveSession` (`src/session/persistence.ts:904-915`) is the canonical
  publication authority; the sole production caller passes `expectedEpoch` +
  `runId` + `durableHistory` (`cli/setup.ts:2061-2064`, arch-guard pinned).
  Epoch CAS, single-key enforcement, atomic takeover without wall-clock
  arbitration, run-cursor monotonicity with terminal freeze — verified.
- Append-only enforced (`RefusedHistoryRewriteError`, `grewBeyondBuffer`
  honest-refuse); shrink only via explicit epoch-fenced
  `shrinkThreadHistory`, refusing live runs and invalidating projections.
- Cost drivers (STATIC loop analysis): every open replays ~10 DDL batches;
  `loadSession`/`saveSession`/journal reads are full scans with per-row
  `JSON.parse`/`JSON.stringify`; no paging except `listSessions LIMIT 50`.
  Measured consequences in `docs/audit/P1-P8_PERF_BASELINE.md`.
- P05-tail preserved: non-guard persist failures stay runtime-silent by
  ratified decision (still red in the full suite — pin intact, not reopened).

### P3 — Context ↔ Session (CONFIRMED unless noted)

- Reconcile is a once-per-startup, read-only composition
  (`cli/setup.ts:910-1026`); selector/assembly/identity/fold are pure,
  import-fenced from canonical writes (negative-import proof + arch guards).
  The only durable derived write is `history_projections`, epoch-fenced.
- Per-turn cost is `persistCurrent`: `saveSession` O(N) compare +
  `produceSummaryProjection` full re-fold + journal finalize. No per-turn
  `selectContext` rebuild (INFERENCE from call-site absence).
- Stale/unknown/diverged handling is an explicit fail-closed matrix
  (validity engine + CURRENT-only assembly + consumability rules).

### P4 — Agent Loop (CONFIRMED unless noted)

- Driver `executeTurn` (`vendor/minicore/src/core/loop.ts:27-259`):
  per-step abort/max-steps/budget guards, stop-on-no-tool-calls,
  transactional turns (failure discards to private store; only success
  replaces). No kernel max-turns; host bounds (`--max-steps`→50 default,
  `--verify` ≤3 cycles, USD budget watcher).
- Kernel never persists (negative-import proof); durable effects flow
  loop→`persistCurrent`→`saveSession` from the four host call sites.

### P5 — Tool Execution (CONFIRMED)

- Gate order verified structurally and behaviorally: kernel
  registry→permission→validate→execute; MCP
  validate→permission→durable-intent(fail-closed)→execute. Jail +
  owned-state gates precede mode dispatch
  (`src/policy/permission.ts:379-480`); `allow-all` retains full bash-guard
  (`:483-496`). Protocol differences documented and asserted intentional.
- Write-concurrency boundary enforced per batch (`src/policy/executor.ts`);
  background-job ownership end to end with non-disclosing cross-session
  errors; `assertDeletableTarget` eleven-check suite green.
- Re-ran at HEAD during the audit: f01+f03+f04+f05 = 40/40.

### P6/P7/P8 — Tasks, TaskGraph, Scheduler (CONFIRMED unless noted)

- 8-status vocabulary; store enforces BLOCKED-reason + relation shape +
  SCHEDULER-authority for `IN_PROGRESS`, not a from→to matrix (see R3).
  `claimTask` is the atomic CAS; `patchTask.expectedRevision` is
  read-then-write, not CAS (code-documented; see R4). Status writes are
  revision-advancing (not idempotent); sync payload application is
  transactional all-or-nothing.
- Readiness is exact read-time derivation (PENDING + zero blockers;
  only COMPLETED satisfies; FAILED/CANCELLED permanently block).
  Dependency cycles = valid-but-unsatisfiable; parent cycles = invalid ⇒
  empty ready set; neither throws nor deadlocks. Graph is rebuild-only.
- Scheduler: 4-gate eligibility, serial cycles + trigger coalescing (no
  queue), manual-only wake-up, atomic claim + capacity predicate + lease,
  graceful idempotent stop, no task-level retry, no fairness (declared).
  End-to-end `Store→Graph→claim→readonly-turn→lineage` path exists behind
  `--enable-scheduler` + `/scheduler run`. Completion loop open by design
  (see R8).
- Static complexity: readiness-set O(n+e); construction O(n log n + e);
  per-cycle dominated by rebuild + full scans; `createTask` O(n) max-scan
  allocator; `selectTask` linear existence re-check of `ready[0]`.

## 4. Cross-phase contract observations

- Authority flows one way: kernel (transient) → `persistCurrent` →
  `saveSession` (canonical). No reverse path exists; derived state cannot
  become authoritative structurally.
- Cancellation propagates as rejection (never silent completion): vendor
  abort race → supervisor bounded escalate → scheduler `cancelActive`
  (status untouched) → host turn classification. Shutdown never invents
  terminal states; outstanding work is reported, not completed.
- The loop→Task seam (`pool.run→runChild→session.run`) and the
  schedule→execution seam (injected `runTurn` bridge) are real but narrow:
  scheduled turns return observations while rows stay `IN_PROGRESS`
  awaiting a verifier that does not exist (R8).

## 5. Regression and baseline comparison (CONFIRMED)

- Reference chain: Phase 4 closure 4463/23/13 → Batch 3 4488/23/13 →
  Batch 4 4503/23/13 (detached 1096 s run at `bedd9cc`; `59dcbfc` is
  docs-only, so the evidence carries).
- The 13 failures were compared **by name**, not count: 2 deterministic
  doc-content + 11 pollution-window, identical to the `P4_PHASE_CLOSURE_REPORT.md`
  §6 classification. Owning files re-run in isolation during the audit:
  39/39 green. Targeted robustness suites: failure-injection,
  recovery-idempotency, task-invariants (50/50); 6V adversarial (32/32);
  cross-process concurrency (5/5).
- Static envelopes: `tsc --noEmit` = 28 errors (documented pre-existing
  legacy debt); the single biome finding on Phase-5-touched files was proven
  pre-existing (byte-identical import block vs pre-Phase-5).

## 6. Findings

### Risks (credible, unconfirmed — no fix attempted)

- **R1 (low-mod):** backend `wait` timeout does not auto-`dispose`; records
  persist without a sweeper. Next: probe record growth under timeout load.
- **R2 (mod):** cross-writer append between resume reads yields a stale
  kernel seed; bounded by epoch CAS + honest-refuse, but whether a stale
  seed can still append is UNKNOWN. Next: targeted two-writer resume test.
- **R3 (mod):** task transition table is spec-only
  (`docs/TASK_STATE_MACHINE_SPEC.md:137-166`); mitigated for known writers
  by the `normalizeTodos` evidence gate, authority mode, and claim protocol.
  Next: explicitly decide store-permissive vs matrix-enforced.
- **R4 (low-mod):** `patchTask.expectedRevision` is not CAS (documented in
  code at `src/task/store.ts:641-649`). Mitigated by single-writer
  ownership + lease.
- **R5–R7 (low):** atomic-write Bun-branch orphan-tmp on rename failure;
  `bash_kill` 1 s lingering SIGKILL timer; `historyLookup` O(J) `readAll`
  per redelivery.
- **R8 (mod, by design):** scheduler completion/verifier lifecycle open;
  dispatched rows strand at `IN_PROGRESS`. Must not be assumed complete.
- **R9 (process):** one combined probe run exceeded its 10-minute budget
  with buffered output lost (audit-execution incident, cause undetermined);
  every section was re-measured individually with watchdogs — no data below
  comes from the hung run.

### Documentation defect

- **D1 (very low):** `src/task/scheduler.ts:1-3` claims "NOT wired into
  production", stale since the 6U/6AB production wiring. Comment only.

### Unknowns (explicitly unresolved)

- U1: actual line/function coverage % (see §8).
- U2: high-percentile latencies (all samples n=5; ranges only).
- U3: behavior beyond N=3000 messages / N=5000 tasks (not extrapolated).
- U4: `fs.watch` absence verified only for runtime/sandbox/executor paths.
- U5: daemon long-run behavior (static timer verification only).
- U6: production LLM-turn cost (requires provider keys; not measured).

### Accepted limitations (inherited, unchanged)

P05-tail swallow; 28 tsc errors; repo-wide lint/CRLF debt; `code_run`
abort lifetime; binary passthrough; static-analysis bash-guard; full-suite
`stderr`-wrapper pollution mechanism; doc-content U+FFFD/nested-list
failures; process-global job cap; manual-only scheduler trigger; absent
fairness; Windows+Bun drive-root diagnostic (fail-closed preserved).

## 7. Performance findings and limitations

Measured results are preserved in `docs/audit/P1-P8_PERF_BASELINE.md`.
Headline (MEASURED, n=5): CLI warm start ~92–97 ms (cold 1457 ms);
no-op dispatch 0.011 ms/call; save ≈12–18 ms for N=100–3000
(fixed-cost dominated); load 2→9 ms; re-fold ≤0.9 ms mechanical /
~7.5 ms full-history at N=3000; graph build+ready ~24 ms chain /
~38 ms dense-5 at N=5000; store ops <1.5 ms; scheduler no-candidate
cycle 2.5→21 ms for N=100→2000 (≈linear). Idle cost is STATIC
(no polling; timers unref'd). Limitations: n=5 ranges only; raw
samples unavailable; DB-open/DDL floor is a hypothesis consistent
with the flat save curve, not a profiled proof; `bench/` measures LLM
task quality, not latency.

## 8. Coverage gate finding (CONFIRMED)

`scripts/coverage-gate.ts:153-162` exits without evaluating coverage
whenever the failure count is nonzero. With 13 permanent known failures,
the gate never evaluates; the 85/86 ratchets do not prove current
compliance. **Actual coverage percentage is UNKNOWN.** No coverage value
is fabricated in this record. A separate coverage measurement or a gate
correction is required. The gate was not modified during this task.

## 9. Consistency with prior closures

This record agrees with `P3/P4/P5_PHASE_CLOSURE_REPORT.md`: same 13-fail
classification, P05-tail pinned red, `saveSession` authority, C1–C4/F-05
enforcement statements. No closed phase is reopened; no prior verdict is
altered. Deferred items (M03 batch test, `git_commit` classification,
`code_run`/binary escalation, optional composition) remain deferred.

## 10. Phase 9 readiness conditions (binding)

- **R2:** obtain targeted two-writer resume evidence before relying on
  multi-writer resume.
- **R3:** decide store-permissive vs matrix-enforced transitions.
- **R8:** do not assume the scheduler completion/verifier lifecycle.
- **C-QA:** measure coverage independently; do not cite ratchets as proof.

## 11. Commands executed and work not performed

Executed (all read-only except temp fixtures, all cleaned — zero
`mc-audit-*` dirs remain): Phase-5 suites 40/40; robustness 50/50 +
32/32 + 5/5; isolation 39/39; 5 purpose-built temp probes
(`%TEMP%\opencode\perf-probe*.ts`, uncommitted) with watchdogs;
`tsc --noEmit`; `biome check` on touched files; CLI `--help` ×3;
repo-wide `setInterval` sweep; full-suite evidence re-analyzed from the
`bedd9cc` detached log (valid: docs-only delta since).
Not performed: full-suite rerun, `bench:smoke`, coverage measurement,
LLM-turn measurement, any production/test/gate modification, any
remediation, Phase 9 work.

## 12. Final audit verdict (unchanged from source report)

**`P1–P8 AUDIT COMPLETE — READY FOR PHASE 9`** — conditional per §10;
completion is not approval to begin Phase 9.
