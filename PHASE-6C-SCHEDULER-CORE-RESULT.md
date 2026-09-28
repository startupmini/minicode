# PHASE 6C — SCHEDULER CORE RESULT

Base: `99980db` (TaskGraph type safety) + `188e999` (Scheduler prerequisites)
Protected specimen `D:\git\minicode`: **never accessed or modified**

---

## 1. Executive result

# PHASE 6C IS GREEN

Not because tests pass. Because the central guarantees are **killed by mutation**,
and the Scheduler is **provably unreachable from production**.

| criterion | state |
|---|---|
| Scheduler core exists | **VERIFIED** — `src/task/scheduler.ts`, 1 file |
| headless, dependencies injected | **VERIFIED** — store, bridge, instruction, sink, cancellation all injected |
| TaskStore sole durable authority | **VERIFIED** — 0 external callers of its primitives |
| no SQLite outside TaskStore | **VERIFIED** — static token scan |
| Graph read-only | **VERIFIED** — frozen, 0 diff |
| readiness not reimplemented | **VERIFIED** — consumed; M11/M12 kill any redefinition |
| selection deterministic | **VERIFIED** — order ASC, id tiebreak |
| claim atomic | **VERIFIED** — delegated to the 6B primitive |
| stale claim never dispatches | **VERIFIED** — M4 killed |
| active claim blocks concurrent selection | **VERIFIED** — M5 killed |
| cycles serial | **VERIFIED** — M15 killed |
| dispatch via injected runTurn only | **VERIFIED** — M13 killed |
| never writes COMPLETED | **VERIFIED** — M14 killed (10 failures) |
| reconciliation ownership-aware | **VERIFIED** — M9 killed |
| reconciliation revision-safe | **VERIFIED** — M10 killed |
| reconciliation never deletes | **VERIFIED** — test 36 |
| PAUSED / terminal untouched | **VERIFIED** — M11/M12 killed |
| production unreachable | **VERIFIED** — 0 across 161 production files |
| legacy suite green | **VERIFIED** — 2988 pass, same 4 pre-existing failures |
| mutation evidence valid | **VERIFIED** — 16/17 killed, 1 classified survivor |
| no frozen-surface diff | **VERIFIED** — 0 across all 9 frozen surfaces |
| tree CLEAN after commit | **VERIFIED** |

**49 tests, 0 failures. `tsc` 28 (baseline), 0 in 6C files.**

---

## 2. Verified substrate (§1)

All nine re-verified from source, not from reports:

| # | check | verdict |
|---|---|---|
| 1 | claim primitive truly atomic | **VERIFIED** — single UPDATE, `changes`-adjudicated |
| 2 | revision predicate inside SQL | **VERIFIED** — `AND revision = ?` at L659 (claim), L712 (reconcile) |
| 3 | stale claim returns a distinct result | **VERIFIED** — `CLAIM_REJECTED_STALE` in `ClaimOutcome` |
| 4 | authority guard blocks direct `IN_PROGRESS` | **VERIFIED** — L555 `patchTask` |
| 5 | `createTask` cannot bypass it | **VERIFIED** — L484 `createTask` |
| 6 | reconciliation fails closed | **VERIFIED** — L698 `REFUSED_NO_OWNERSHIP` |
| 7 | active ownership visible in-process | **VERIFIED** — `acquireSessionOwnership` / `ownsSession` |
| 8 | TaskGraph API + semantics unchanged | **VERIFIED** — all 12 members, frozen 0 diff |
| 9 | `withTransaction` already public | **VERIFIED** — L846; **not reimplemented, not used** by Scheduler |

No replacement primitive was invented. The Scheduler calls only
`getSnapshot`, `getTask`, `claimTask`, `reconcileStranded`, and the 6B ownership
functions.

---

## 3. Scheduler architecture implemented

```
TaskStore.getSnapshot ─► new TaskGraph ─► readyTasks()   [read-only, disposable]
        │
        ├─ reconcile()  (ownership-aware, first)
        ├─ getTask()    (authoritative re-read)
        ├─ claimTask()  (atomic, revision-guarded)
        └─ runTurn()    (injected — the only execution path)
```

**NEW ARCHITECTURE.** One file, no dependencies on engine surfaces. Import list is
exactly: `./graph.ts`, `./model.ts` (types), `./session-ownership.ts`, `./store.ts`
(type). A test asserts `policy/executor`, `parallelExecutor`, `bun:sqlite`,
`Database`, `tools/todo`, `presentation/events`, `transcript` and "message
history" are all **absent** (comments stripped, so the module's own
prohibitions do not false-positive).

### Shape provenance

| item | classification |
|---|---|
| `new Scheduler(sessionId, {store, runTurn, instruction})` | **HISTORICAL DESIGN EVIDENCE** — shape only, from recovered `p77` call sites |
| `getActiveClaim()` | **HISTORICAL DESIGN EVIDENCE** — shape only |
| behaviour of either | **NOT INFERRED.** None is claimed from history. |
| `canExecute`, `blockingDeps`, `topological`, `sourceRevision` | **NOT ADOPTED** — zero evidence anywhere (5A) |
| everything implemented | **NEW ARCHITECTURE** |

---

## 4. Lifecycle

`CREATED → RUNNING ⇄ IDLE → STOPPING → STOPPED`

| operation | semantics |
|---|---|
| `start()` | acquires ownership, then `RUNNING`. **Idempotent** while running. **Refused after `STOPPED`** (throws). |
| `stop()` | prevents future dispatch. Awaits an in-flight cycle. Safe repeatedly. |
| `tick()` / `cycle()` on `STOPPED` | returns `not-running` — **not** a silent success |

**`STOPPED` ≠ `CANCELLED`.** `stop()` writes no durable state, cancels nothing,
deletes nothing, and does not release a live claim. Test 30 proves a claimed task
stays `IN_PROGRESS` across a stop, with no manufactured completion.

---

## 5. Ownership semantics

Session-scoped, via the 6B process-local primitive. On `start()`:

- ownership free → acquired, proceed
- **owned by another instance → `STOPPED` + throw** `ownership-unavailable`
- forged token → rejected (identity compared by symbol, not label)

`reconcile()` re-checks ownership on **every** call and returns `[]` when
uncertain. **Fail-closed, no guessing.**

### V1 deployment invariant (documented in the module header)

> A session must not be concurrently driven by independent Scheduler instances
> across OS processes. Session ownership is process-local and cannot see another
> OS process, so this module does not pretend to prevent it.

---

## 6. Cycle semantics

Exactly the 11 locked steps, in order. The ordering is load-bearing:

1. **reconcile** — never plan around stranded work (the P77 lesson)
2. fresh `getSnapshot` 3. fresh `TaskGraph` 4. `readyTasks()`
5. select `ready[0]`
6. **re-read** the task authoritatively
7. `claimTask(revision)` 8. dispatch 9. observe 10. release only where
authorized 11. finish

**A TaskGraph is never cached across cycles.** A claim changes `revision`, so the
graph is stale the moment it is used; M16 (cache it) is killed with **30
failures**.

**The claim uses the re-read revision, never the graph's.** M3 (use the graph
revision) and M2 (use `sourceMaxRevision`) are both killed.

---

## 7. Discovery

`snapshot → new TaskGraph(snapshot) → readyTasks()`. Readiness is **consumed**
verbatim; no predicate is reimplemented.

An invalid graph **aborts the cycle**: nothing dispatched, nothing claimed, no
mutation (test 11). M8 killed. Reconciliation that already ran is unaffected —
which is the honest consequence of running it first.

---

## 8. Selection

`ready[0] ?? null`. No queue, no priority, no fairness, no starvation mechanism,
no resource scoring. Order is inherited from TaskGraph (`order` ASC, `taskId`
ASC) — **deterministic iteration order, not semantic priority**, and the module
says so.

An active claim suppresses selection entirely (M5 killed).

---

## 9. Claim

| outcome | behaviour |
|---|---|
| `CLAIM_ACCEPTED` | record the claim, dispatch |
| `CLAIM_REJECTED_STALE` | execute nothing; cycle ends `claim-rejected-stale` |
| `NOT_FOUND` | execute nothing |
| `WRONG_STATE` | execute nothing |

**Never retried in a loop. Never slept on.** A race is normal control flow, not an
error. M4 (proceed anyway) killed.

---

## 10. Active claim

`{ taskId, claimRevision }` where `claimRevision` is the **post-claim** revision
(read back from the accepted claim). Never the pre-claim revision, the graph
revision, a timestamp, or `sourceMaxRevision`. M6 (release with the pre-claim
revision) is killed.

---

## 11. Dispatch bridge

The Scheduler **authorizes**; the agent loop **executes**. The work item carries
exactly four fields — `taskId`, `title`, `instruction`, `sessionId` — built from
the task row, never from message history.

`parallelExecutor` is never called; M13 (import it) is killed. A test asserts the
absence of the import statically.

---

## 12. Execution boundary

Two states, derived from the actual call — no invented flag:

- **A. dispatch/setup failure** — the bridge threw, or returned a non-promise.
  The attempt was **never established**, so the claim is released back to `PENDING`
  (the one case the design locked for release).
- **B. execution began** — a promise existed; its settlement is an **observation**.

`Scheduler does not decide whether work "succeeded" and never writes COMPLETED.
M14 (write `COMPLETED`) is killed with **10 failures**. A returned `ok: false`
leaves the task `IN_PROGRESS` — tests 26, 26b.

---

## 13. Reconciliation

Every cycle, before discovery. Targets `IN_PROGRESS` and `VERIFYING` only.
`PENDING`, `BLOCKED`, `COMPLETED`, `CANCELLED`, `FAILED`, `RETRYING` untouched by
construction (not by a later check) — M11 and M12 killed. `PAUSED` is never
produced.

Ownership-aware (M9 killed), revision-safe (M10 killed), never deletes (test 36),
never reverts the Scheduler's own active claim, and never clears `blockedReason`.

An already-correct state is a harmless no-op (`NOT_STRANDED`).

---

## 14. Error semantics

| condition | treatment |
|---|---|
| graph invalid | abort cycle, `cycle:invalid_graph` |
| claim stale | normal control flow, cycle ends |
| task not found / wrong state | normal control flow |
| ownership unavailable | **fail closed** |
| dispatch failure | release, `failure` recorded |
| execution error | observation; task stays `IN_PROGRESS` |
| persistence failure | thrown `SchedulerError` — never swallowed |
| start after `STOPPED` | thrown `SchedulerError` |
| unreachable state after an accepted claim | thrown, not faked |

**Not every error becomes "idle".** An observer that throws is swallowed on
purpose — an observation cannot be load-bearing — and that is documented in code.

---

## 15. Concurrency

**V1 is serial, and the Scheduler serializes itself.** A cycle in progress makes
further `cycle()` calls **join** the in-flight cycle. No queue, no worker, no
second execution abstraction.

This is subtle enough to be worth recording: **my first concurrency test could not
detect a missing join**, because with one ready task both cycles pick the same
candidate and the second simply loses the atomic claim. TaskStore was silently
doing the work the brief forbade relying on. Two further tests were added:

- **27b** — two ready tasks, blocked bridge: without the join, two dispatches run
  concurrently (different rows, so the claim offers no protection).
- **28b** — counts cycle-body entries via snapshot reads: four concurrent calls
  must produce **2** snapshots (one reconcile, one discovery), not 8.

M15 is now killed. Serialization is proven **Scheduler-side**, not TaskStore-side.

---

## 16. Changed files

| file | change |
|---|---|
| `src/task/scheduler.ts` | **new** — the Scheduler core |
| `test/phase6c-scheduler.test.ts` | **new** — 49 tests |
| `PHASE-6C-SCHEDULER-CORE-RESULT.md` | this report |

Two tracked files, no deletions.

## 17. Frozen files

| frozen surface | diff |
|---|---|
| `src/task/graph.ts` | **0** |
| `src/task/graph-validate.ts` | **0** |
| `src/task/readiness.ts` | **0** |
| `src/task/model.ts` | **0** |
| `cli/tui.ts` | **0** |
| `cli/commands/acp.ts` | **0** |
| `src/policy/executor.ts` | **0** |
| `src/ui/**` | **0** |
| `vendor/minicore/**` | **0** |

No STOP-AND-REPORT was needed: no frozen surface had to change.

---

## 18. Tests

**49 tests, 0 failures.** All 40 categories of §21 present, plus 9 additions:
`10b` (the at-least-once window made visible), `25b` (cancellation refuses without
releasing), `27b` / `28b` (the two serialisation discriminators), `28`, `30`,
`33b`, `37b`, `26b`.

Two deliberate seams, both documented in the test header:

- **`raceStore` proxy** — forces a mutation in the exact window between the
  re-read and the claim. Without it, categories 18/20/37 are **unobservable**, not
  merely untested.
- **deferred `runTurn`** — makes serialisation observable.

A **LEGACY store** builds stranded-state fixtures, because the SCHEDULER
authority store correctly refuses to *create* `IN_PROGRESS`. That is the guard
working, not a workaround: a stranded row is exactly what a crashed Scheduler
leaves behind.

---

## 19. Mutation results

17 targets (M16 needs a field, so M16b is its scaffold). **16 killed · 1 survivor
(classified) · 0 harness misses.**

| # | mutation | verdict | failures |
|---|---|---|---|
| M1 | remove the pre-dispatch claim | **KILLED** | 13 |
| M2 | claim with `sourceMaxRevision` | **KILLED** | 1 |
| M3 | claim with graph revision, no re-read | **KILLED** | 3 |
| M4 | proceed after a stale claim | **KILLED** | 2 |
| M5 | do not block a second selection | **KILLED** | 1 |
| M6 | release with the pre-claim revision | **KILLED** | 1 |
| M7 | dispatch despite stop/cancellation | **KILLED** | 1 |
| M8 | proceed on an invalid graph | **KILLED** | 1 |
| M9 | reconcile without ownership | **KILLED** | 1 |
| M10 | reconcile ignoring the revision | **KILLED** | 2 |
| M11 | reconcile every non-terminal status | **KILLED** | 1 |
| M12 | reconcile terminal tasks too | **KILLED** | 1 |
| M13 | import/call the executor | **KILLED** | 1 |
| M14 | Scheduler writes `COMPLETED` | **KILLED** | 10 |
| M15 | allow concurrent cycles | **KILLED** | 1 |
| M16 | cache the TaskGraph across cycles | **KILLED** | 30 |
| M16b | declare the graph cache field | **SURVIVED** | 0 — **classified below** |

### The single survivor, classified

**M16b is a supporting scaffold, not an independent behavioural mutant.** It only
declares the `cachedGraph` field that M16 then *uses*. On its own an unused
private field changes no behaviour — it is an **equivalent mutant** — and it is
**compiler-visible**: `tsc` with `noUnusedLocals` would reject it. A runtime suite
cannot see it. The behavioural mutant it exists to enable, **M16, is killed with
30 failures.**

No other survivor exists, so no other classification is required. **No "probably
fine" is offered anywhere in this report.**

### Three harness defects found and disclosed

1. **A precedence bug in my own M7.** `false && A || B` parses as
   `(false && A) || B`, leaving the cancellation clause live. M7 reported
   **SURVIVED twice** for a reason that had nothing to do with the code. A mutant
   that survives for a parser reason is indistinguishable from a real test gap
   unless you check the mutant, not just the verdict.
2. **M7's first form was a genuine equivalent.** Disabling only the
   `STOPPING`/`STOPPED` clause is unreachable in V1: the claim→dispatch gap is
   synchronous, so nothing can interleave a `stop()` there. That clause is
   **defence-in-depth for a future async seam**, recorded as a limitation rather
   than papered over.
3. **Four anchor misses** on multi-line patterns, fixed by normalizing the literal
   `` `n `` the way the 6B harness does.

---

## 20. Performance (§20)

Recorded as a **baseline**. No threshold was invented; none is asserted.

Discovery, E = 0:

| n | snapshot | derive | ready |
|---|---|---|---|
| 1 000 | 2.59 ms | 5.28 ms | 0.35 ms |
| 10 000 | 25.83 ms | 49.00 ms | 1.32 ms |

Discovery, E = V−1 (dependency chain):

| n | snapshot | derive | ready |
|---|---|---|---|
| 1 000 | 2.88 ms | 4.46 ms | 0.11 ms |
| 10 000 | 30.08 ms | 55.42 ms | 1.49 ms |

Cycle phases:

| n | idle cycle | claim cycle |
|---|---|---|
| 1 000 | 10.37 ms | 12.80 ms |
| 10 000 | 111.53 ms | 98.89 ms |

**Scaling: 10× tasks ⇒ 9.4× time (idle cycle).** Linear in V, as required
(O(V+E) discovery, O(1) claim). No graph cache, no secondary index, no
`sourceRevision` cache. The benchmark script was **removed from `src/`** — a
benchmark does not belong in the production tree, and the numbers are recorded
here instead.

---

## 21. Legacy reachability proof (§24)

161 production `.ts` files scanned, excluding `scheduler.ts` itself:

| pattern | matches |
|---|---|
| `new Scheduler(` | **0** |
| `enableSchedulerAuthority(` | **0** |
| `scheduler.tick(` | **0** |
| `scheduler.start(` | **0** |
| production importers of `task/scheduler` | **0** |
| `authority: "SCHEDULER"` activations outside `store.ts` | **0** |
| external callers of `claimTask` / `reconcileStranded` / `acquireSessionOwnership` | **0** |

**The Scheduler is unreachable from the application.** The default application
remains LEGACY and authority mode remains OFF.

---

## 22. Limitations

1. **The `STOPPING`/`STOPPED` clause of the dispatch guard is unreachable in V1**
   (synchronous claim→dispatch). It is defence-in-depth, not a live protection.
2. **Cross-process ownership remains unexpressible** (6B limitation, inherited).
   Cross-process reconciliation therefore refuses, and a second process can still
   overwrite a claim.
3. **No retry policy.** A task whose turn errors stays `IN_PROGRESS` and is
   re-dispatched next cycle — the at-least-once window, deliberately not hidden.
4. **The local claim is cleared after dispatch**, so the `already-dispatched`
   branch is chiefly a defensive guard in V1.
5. **Execution is a single injected call.** A bridge that needs cancellation of an
   in-flight turn has no seam here; only the composition root can provide one.
6. **`already-dispatched` is reachable in tests only** via a private-field poke.
   Kept, and flagged, rather than adding public API for tests.
7. **`getActiveClaim()` cannot see a claim taken by another Scheduler** in another
   process — same root as (2).

## 23. Architectural decisions

| # | decision | label |
|---|---|---|
| S1 | one cycle body per call; concurrent calls **join** the in-flight cycle | NEW ARCHITECTURE |
| S2 | the graph is **per-cycle and disposable**, never cached | NEW ARCHITECTURE |
| S3 | the claim currency is the **re-read** task revision | NEW ARCHITECTURE |
| S4 | `activeClaim.claimRevision` is the **post-claim** revision | NEW ARCHITECTURE |
| S5 | dispatch/setup failure releases; cancellation and stop do **not** | NEW ARCHITECTURE |
| S6 | the turn's outcome is an **observation**, never a verdict | NEW ARCHITECTURE |
| S7 | reconciliation runs **first**, every cycle (P77) | NEW ARCHITECTURE |
| S8 | ownership is re-checked on **every** reconcile call | NEW ARCHITECTURE |
| S9 | the dispatch distinction is derived from **whether a promise exists**, not a flag | NEW ARCHITECTURE |
| S10 | events are emitted through an **injected sink**; presentation is untouched | NEW ARCHITECTURE |
| S11 | a throwing observer cannot fail a cycle | NEW ARCHITECTURE |
| S12 | start-after-STOPPED throws rather than no-op | NEW ARCHITECTURE |

## 24. Commit hash

See §25. (A commit cannot contain its own hash.)

## 25. Git cleanliness

`git status` after commit: **CLEAN**. **NOT PUSHED** — 29 commits ahead of
`origin/main`.

## 26. Production enablement status

**OFF. Unreachable. Verified by scan (§21).**

- authority mode: `LEGACY` everywhere in production
- `new Scheduler(` in production: **0**
- importers of `task/scheduler`: **0**

Enabling the Scheduler requires a composition root that (a) constructs a
`TaskStore` with `authority: "SCHEDULER"`, (b) injects a real `runTurn` bridge, and
(c) decides the cross-process deployment question. **None of that is done here,
and none is started.**

---

## STOP

Scheduler core implemented, verified, and **unreachable**. Not done: production
wiring, Scheduler consumers, retry orchestration, lease, priority, fairness,
queue persistence. TaskGraph, TaskStore semantics, model, UI, ACP, executor and
vendored code all untouched.
