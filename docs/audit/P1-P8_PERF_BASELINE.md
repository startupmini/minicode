# P1–P8 Performance Baseline

Preservation record of the timings measured during the P1–P8 system audit
(commit `59dcbfc`). Nothing below was re-measured for this archival task;
regenerating measurements and presenting them as these historical results is
prohibited. See `P1-P8_SYSTEM_AUDIT_REPORT.md` §7 for interpretation.

## 1. Environment fingerprint (MEASURED context)

- Commit: `59dcbfcad10d182ca9dc10ba3f5b309c20973734` (`main`, `HEAD == origin/main`).
- OS: Microsoft Windows NT 10.0.26300.0. CPU: Intel i7-10700T @ 2.00 GHz.
  RAM: 15.7 GB.
- Runtime: Bun 1.4.2 (`package.json` engines require `bun >= 1.1.13`).
- Method: purpose-built temp scripts importing repo modules directly;
  fixtures in fresh `mkdtemp` dirs under `os.tmpdir()`, removed afterwards
  (verified: zero `mc-audit-*` dirs remain). Warm-up 1 + 5 repetitions per
  workload; reported as min/med/max over n=5.
- **Limitations (binding):** n=5 supports ranges only — no p50/p95/p99 is
  claimed. **Raw per-repetition samples were not preserved**; only the
  min/med/max values below exist. Do not invent underlying samples.
  Behavior beyond the tested sizes was not measured and must not be
  extrapolated from these tables.

## 2. CLI startup (MEASURED)

Command: `bun cli/index.ts --help` (3 separate process spawns, wall time).

| Run | Wall time |
|---|---|
| Cold (first run, includes Bun compile) | 1457 ms |
| Warm | ~97 ms |
| Warm | ~92 ms |

## 3. Kernel dispatch overhead (MEASURED)

Workload: `runCall` from `vendor/minicore/src/core/executor.ts` with a
no-op tool (`execute` returns `"ok"`), `createPermissionHandler({ mode:
"allow-all", root: <temp> })`, 1 warm-up + 200 timed iterations in-process.

| Metric | Value |
|---|---|
| Mean per call | 0.011 ms/call (n=200) |

Covers the full kernel path (registry, permission check, `validateArgs`,
events, `serializeContent`) minus any real tool work.

## 4. Session save/load vs history size (MEASURED)

Workload: `saveSession("probe", <temp-cwd>, undefined, msgs, undefined)`
then `loadSession("probe", <temp-cwd>`); messages alternate user/assistant
with ~180–200 chars of content; same payload re-saved per repetition
(1 warm-up + 5 timed). Temp `.minicode/*.db` under the fixture dir.

| N messages | save min/med/max (ms) | load min/med/max (ms) |
|---|---|---|
| 100 | 11.61 / 13.82 / 31.30 | 2.07 / 2.25 / 9.01 |
| 1000 | 11.22 / 13.46 / 16.52 | 4.19 / 4.72 / 11.23 |
| 3000 | 16.64 / 17.76 / 23.82 | 7.99 / 8.60 / 14.81 |

Observation (not proof): save is nearly flat across 30× history growth —
consistent with a per-operation fixed cost dominating (DB open + DDL/migration
replay on every open, per `src/session/persistence.ts:51-324`). This
DB-open/DDL floor is a **hypothesis consistent with the curve**, not a
profiled proof; no profiler was run.

## 5. Projection re-fold vs history size (MEASURED, pure CPU, no I/O)

Workload: synthetic histories (user text + assistant+toolCalls + tool
results with ~40-line bodies); `deriveSummaryFromCanonical(msgs, {
keepRecentTurns: 2 })` and `renderFullHistoryFold(rows)`; 1 warm-up + 5 timed.

| N messages | mechanical min/med/max (ms) | full-history min/med/max (ms) |
|---|---|---|
| 200 | 0.1 / 0.1 / 0.1 | 0.5 / 0.5 / 0.6 |
| 1000 | 0.2 / 0.3 / 0.3 | 2.2 / 2.3 / 2.7 |
| 3000 | 0.5 / 0.6 / 0.9 | 6.6 / 7.5 / 9.2 |

Both scale approximately linearly and are small relative to the save floor.

## 6. TaskGraph build + readiness (MEASURED, pure CPU, no I/O)

Workload: `new TaskGraph(snapshot)` + `readyTasks()` on synthetic snapshots
(chain: task i depends on i−1; dense-5: plus up to 4 earlier deps);
1 warm-up + 5 timed. Point query: `isReady` on the last node of the
dense-5 N=5000 graph.

| Workload | min/med/max (ms) |
|---|---|
| Chain N=200 | 0.98 / 1.05 / 1.11 |
| Chain N=1000 | 3.45 / 4.11 / 7.93 |
| Chain N=5000 | 22.02 / 23.92 / 25.61 |
| Dense-5 N=200 | 1.22 / 1.31 / 3.61 |
| Dense-5 N=1000 | 6.15 / 7.34 / 9.29 |
| Dense-5 N=5000 | 33.46 / 37.71 / 38.73 |
| Point `isReady`, dense-5 N=5000 | 0.00 / 0.00 / 0.01 |

## 7. TaskStore operations (MEASURED, temp tasks.db)

Workload: `TaskStore(<temp>, { authority: "SCHEDULER" })`; create on a DB
holding ~200 rows (3 reps); same-value `patchTask` (5 reps); single
`claimTask` (1 sample — not a distribution).

| Operation | Value |
|---|---|
| `createTask` | min 0.83 / med 0.87 / max 0.89 ms (n=3) |
| `patchTask` same-value | min 0.73 / med 0.79 / max 0.85 ms (n=5) |
| `claimTask` single | 1.39 ms (n=1) |

## 8. Scheduler no-candidate cycle vs task count (MEASURED, temp tasks.db)

Workload: real `Scheduler` (`store`, immediate `runTurn` bridge,
`onEvent` noop), `start()`, N steady `BLOCKED` rows (never dispatched,
never mutated), 1 warm-up cycle + 3 timed `cycle()` calls, `stop()`.

| N BLOCKED tasks | min/med/max (ms) |
|---|---|
| 100 | 2.4 / 2.5 / 2.8 |
| 500 | 5.5 / 6.2 / 7.3 |
| 2000 | 20.0 / 20.9 / 23.4 |

Approximately linear — consistent with the STATIC per-cycle analysis
(full snapshot + graph rebuild + ready scan per cycle).

## 9. Idle behavior (STATIC inspection, not timing)

Repo-wide `setInterval` sweep found 7 sites, each unref'd with a clear
path: `src/daemon/host.ts:141`, `src/daemon/resource.ts:144`,
`src/task/scheduler.ts:373` (60 s lease renewal), `cli/setup.ts:718`
(writer renew), 3 UI paint timers (spinner/turn-status, painting only).
Zero intervals in `src/runtime/*`; no task polling loop; scheduler
disabled ⇒ inert handle. Idle CPU cost was **not** measured with a
running process — the claim is structural, with the sites cited above.

## 10. What `bench/` is (scope note)

`bench/runner.ts` (+ `tasks.ts`, `swebench*`, `eval-gate.ts`,
`harness-audit.ts`) evaluates **LLM task quality** (resolve rate, steps,
tokens, duration per task; `--fake` smoke for CI). It is not a
latency/throughput microbenchmark harness. No pre-existing latency
microbenchmark infrastructure was found; the tables above are the first.

## 11. Reproduction

- Sections 2–3: `bun cli/index.ts --help`; `runCall` loop as described in §3
  (pattern mirrors `test/f04-dispatch-contract.test.ts:29-53,298-316`).
- Sections 4–8: reconstructible from the workload descriptions above using
  the cited functions (`saveSession`/`loadSession`,
  `deriveSummaryFromCanonical`/`renderFullHistoryFold`, `new
  TaskGraph`/`readyTasks`/`isReady`, `TaskStore` methods,
  `Scheduler.start/cycle/stop` per `test/phase6c-scheduler.test.ts:48-119`).
- **Cannot be reproduced from preserved evidence:** the exact temporary
  probe scripts (`%TEMP%\opencode\perf-probe*.ts`) were intentionally left
  uncommitted and are not part of this record. Do not present
  reconstructions as the original runs.
- One combined probe execution exceeded its budget with output lost
  (audit-process incident); all values above come from completed,
  watchdog-guarded individual runs.
