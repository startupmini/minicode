# Phase 6T — Trigger, Scheduling Policy & Execution Lifecycle Control

**Verdict: GO** for the policy/control layer. **NO-GO** remains correct for
enablement. Production Scheduler construction stays **0**.

Commit: `design: establish scheduler trigger and policy control`
Baseline: `e182c8c` (Phase 6S) — clean tree, 45 commits ahead, nothing pushed.

---

## 0. Two defects this phase found and fixed

Both were found by writing probes before trusting the design, and neither was
visible from reading the reports.

### D1 — 6O designed the capacity predicate; it was never built *(severity: high)*

`FACT` — 6O §5.2 selected, in these words, a "claim-with-precondition in
TaskStore, where the UPDATE's `WHERE` includes a capacity predicate … so a
rejected claim reports `CLAIM_REJECTED_BUSY` **and does not advance
`exec_generation`**".

`FACT` — before 6T, `CLAIM_REJECTED_BUSY` existed **only inside that design
document**. `claimTask`'s `WHERE` was `session_id, task_id, revision, status`, and
contention was detected *after* the claim, in `dispatch()`.

`OBSERVATION` — probe of the committed tree, a scheduler whose injected
cancellation says "busy", i.e. a turn that would never run:

```
generation before cycle : 0
cycle stop reason       : already-dispatched
generation after cycle  : 1
GENERATION CONSUMED?    : YES — BUG
task status after cycle : IN_PROGRESS
```

`INFERENCE` — 6N F1 / 6O U5 was still open. A turn that never executed spent a
generation and left the task `IN_PROGRESS`, scheduler-owned and stranded, for an
authority that does not exist (there is no verifier — 6N's standing limit) to move
it. The design was correct; it had simply never been implemented.

`ACTION` — 6T implemented it. `claimTask` takes `{ exclusive?: boolean }`, adding a
capacity predicate to the **same** statement that performs the claim.

### D2 — the capacity predicate I first wrote was wrong, and a probe caught it

`FACT` — my first predicate was "no other task in this session with
`execution_owner='scheduler' AND status='IN_PROGRESS'`".

`OBSERVATION` — it wedged the Scheduler. After every completed turn the task
*deliberately remains* `IN_PROGRESS` awaiting a verifier, so the predicate found a
"live execution" forever:

```
cycle 1: stop=already-dispatched   ran=[A]     A=IN_PROGRESS/1 B=PENDING/-
cycle 2: stop=contended            ran=[A]     A=IN_PROGRESS/1 B=PENDING/-
cycle 3: stop=contended            ran=[A]     A=IN_PROGRESS/1 B=PENDING/-
```

`INFERENCE` — `IN_PROGRESS` is **overloaded** (6P documented this): it means both
"a Scheduler execution is running" and "work is awaiting verification". Capacity
has to mean the first, not the second.

`ACTION` — live means *the current generation's attempt has not ended*:

```sql
AND (attempt_generation IS NULL OR attempt_generation < exec_generation)
```

`DESIGN DECISION` — this is exactly the condition reconciliation already uses to
separate a crashed execution (REVERT) from finished work (LEAVE). Capacity and
recovery now read **one fact** and cannot disagree. A crashed execution still
occupies capacity until a cycle reconciles it, which is correct: an execution of
unknown liveness is not free capacity, and `runCycle` reconciles before it selects.

### D3 — a deleted session's IDLE Scheduler kept its ownership and wedged every replacement *(pre-existing, severity: high)*

`FACT` — 6Q taught the Scheduler to self-dispose when a lineage write returns
`TASK_GONE`/`SESSION_SUPERSEDED`. That happens **on the claim path, while a turn
is ending**.

`OBSERVATION` — an IDLE scheduler, its session deleted, then one cycle:

```
after start:            lifecycle=RUNNING
session deleted.       incarnation now=2
after cycle:           lifecycle=IDLE stop=no-candidates
replacement start():   REFUSED -> session s is already owned in this process
==> WEDGED
```

`INFERENCE` — a scheduler that is merely idle never writes anything, never learns,
and keeps the process-local token. A recreated session cannot start, because a
dead instance still owns it. This is the second half of 6N F2, still open.

`ACTION` — 6T captures the incarnation at `start()` and compares it at the top of
every cycle; if it moved, the instance self-disposes. This **strengthens 6Q**,
reusing its own durable evidence at cycle granularity rather than inventing a
liveness mechanism. After the fix: `lifecycle=STOPPED stop=session-superseded`,
replacement `start()` OK.

---

## 1. Current trigger architecture

`FACT` — survey of `src/`, `cli/`, `vendor/minicore/`:

| candidate | status | evidence |
|---|---|---|
| process startup | **AVAILABLE BUT UNUSED** | `cli/setup.ts:950` builds the real session; nothing calls `cycle()` there |
| task mutation | **AVAILABLE BUT UNUSED** | `TaskStore.createTask/patchTask/claimTask/…` emit nothing; the only outward channel is a return value (`src/task/sync.ts:52`) |
| explicit CLI command | **AVAILABLE BUT UNUSED** | `cli/router.ts` has 13 subcommands, none task-related; `cli/commands.ts:100-126` has 15 slash commands, none task-related |
| timer / interval | **NOT IMPLEMENTED** | the only `setInterval` in `src/` paints a spinner (`src/ui/runtime/spinner.ts:74`) and a status line (`src/ui/assistant/turn-status.ts:174`). No repeating timer anywhere |
| event bus | **AVAILABLE BUT UNUSED** | `createEventBus` (`vendor/minicore/src/core/events.ts:35`) carries 9 turn/step/provider event types; **none is task-shaped** |
| idle detection | **PARTIAL** | only a TUI-local `busy` boolean, and `AgentError("busy")` thrown at `vendor/minicore/src/core/session.ts:216`. No `isBusy()` on `Session` |
| shutdown | **ASYNC, UNREACHABLE** | `cli/setup.ts:1507-1539` has a real async `close()`, but no signal handler calls it — SIGTERM/SIGHUP `process.exit(143/129)` at `src/ui/tui/app.ts:333-334` |
| feature flag | **DOES NOT EXIST** | no `features`/`flags` in `MinicodeConfig` (`src/config.ts:71-76`) or `SchedulerOptions`; ~20 ad-hoc `process.env.X === "1"` reads, no registry |

`FACT` — eight real composition roots; **none** imports `src/task/scheduler.ts` or
`src/task/autonomous-*`. The only importers are test files.

`DESIGN DECISION` — there is nothing to hook and nothing to poll. A trigger layer
built on a timer or a task-mutation event would be inventing infrastructure to
justify itself. So the trigger is a **decision**, not a mechanism: "may an
evaluation start now, and who may ask?" `runCycle` is injected, and
`TriggerCoordinator` has no store reference and no Scheduler import — the absence
is the proof that a refused trigger cannot write.

---

## 2. Trigger candidates

| | model | verdict |
|---|---|---|
| A | startup | **AVAILABLE, UNUSED.** Cheapest, but a CLI that runs one turn and exits would evaluate a scheduler for nothing. |
| B | task mutation | **BEST FIT, UNUSED.** Latency is immediate, cost is zero when idle, lifetime is bounded by the process. Requires a signal that does not exist yet. |
| C | explicit command | **AVAILABLE, UNUSED.** Most honest and most observable, but it is an *enablement* decision and out of scope. |
| D | background interval | **REJECTED.** Assumes MiniCode is a continuously running server. It is not: `cli/index.ts:456-554` runs one turn and exits. A periodic timer would also be the one candidate requiring a lifecycle to own. |
| E | queue/event driven | **REJECTED as a queue.** N rapid task mutations would become N evaluations. A single coalesced re-run subsumes them, because a cycle re-reads the whole snapshot. |
| F | hybrid | **PARTIAL.** Startup + mutation is coherent; startup alone is not worth it, and neither is reachable yet. |

`DESIGN DECISION` — **no transport is selected or implemented.** The coordinator
answers the ownership questions; *what pokes it* is deliberately undecided,
because every available answer is an enablement choice. This is recorded as
**DECISION BLOCKED** in ADR-11, not forced.

---

## 3. Policy boundary

```
TRIGGER            "evaluate now"                 no durable effect
  ↓
Scheduler cycle
  ↓
POLICY             selectTask(ready, snapshot)    ordering only
  ↓
TaskGraph          readyTasks()                   WHAT IS READY
  ↓
CLAIM              claimTask(..., {exclusive})    takes; atomically refuses
  ↓
autonomous context → 6S permission policy
```

`DESIGN DECISION` — `selectTask` receives an already-ordered ready list and
applies ordering **only**. A second readiness implementation is how a scheduler
starts disagreeing with its own graph, invisibly, until work is stranded.

**`FACT`** — 6T initially created `scheduling-policy.ts` but left the Scheduler
reading `ready[0]` inline. Mutation M9/M10 (policy picks a task that was never
ready) both **survived**, precisely because the two could not disagree: the
Scheduler did not use the policy. That is the two-sources-of-truth risk the module's
own documentation warned about, realised. Fixed by routing the Scheduler through
`selectTask`; M9/M10 then killed.

---

## 4. Selection policy

`FACT` — `graph.ts:63-67`: `compareNodes` sorts `order` ASC then `id` ASC;
`readyTasks()` walks that order. The Scheduler has always taken `ready[0]`, so
`ORDER_ASC_THEN_ID_ASC` has been the policy since 6C — unnamed.

`DESIGN DECISION` — formalise exactly that, and **nothing more**. Priority, age,
retry state, dependency depth, user-vs-autonomous and fairness were each
considered and rejected: TaskGraph already defines readiness and its order is
deterministic, and no evidence in the current model requires a second ordering
dimension. `SELECTION_POLICY` is a one-member union, so adding a policy is a type
error rather than a silent behaviour change.

`EVIDENCE` — C1/C3/C4/C6/C7 (policy is the graph's order; bridges, terminals and
blocked tasks are never selected; deterministic across repeats), and C8/C9, added
after M9/M10 survived: a task that is **not ready but sorts first** must not be
selected, and when nothing is ready a terminal task must not be substituted.

---

## 5. Contention policy

`DESIGN DECISION` — **`SKIP_CYCLE`**, rejection total: no claim, no generation, no
owner, no attempt lineage, no status write, no retry loop.

Rejected alternatives, with reasons:

| policy | why rejected |
|---|---|
| `WAIT` | an unbounded in-memory wait across a user turn of unknown length; needs its own timeout, its own cancellation, and a decision about outliving the turn |
| `RETRY_LATER` | a timer plus the lifecycle to own it — and the runtime has no periodic timer at all |
| `CLAIM_AND_DEFER` | looks attractive, and is exactly the defect 6N reported: it spends a generation on work that will not run |

Two enforcement points, both required:

- **pre-claim probe** (`isCancelled()`) — cheap, stops before reading a snapshot.
  A read, so it can be raced.
- **atomic capacity predicate** — inside the claim's own `UPDATE`. This is the half
  that actually holds, including across processes.

`reEvaluateLater: true` is what keeps skipping from becoming starvation: the next
trigger re-reads a fresh snapshot, so nothing is lost by declining to act now.

`EVIDENCE` — B1–B6, I1 (400 seeds), I2 (400 seeds), and process P2 with two
genuinely parallel OS processes.

---

## 6. Starvation

`FACT` — the mechanism is not fairness in the policy. `reconcileIfNoCompletedAttempt`
reverts `IN_PROGRESS` **only** when the generation has no completion marker:

```
attempt completed -> marker exists -> NOT reverted -> stays IN_PROGRESS
                    -> not PENDING    -> not ready     -> never re-selected
attempt never ran -> no marker       -> reverted      -> PENDING -> ready again
```

`OBSERVATION` — probe with A (order 1) and B (order 2), A returning each time:

```
cycle 1: stop=already-dispatched   ran=[A]   A=IN_PROGRESS/1 B=PENDING/-
cycle 2: stop=already-dispatched   ran=[A,B] A=IN_PROGRESS/1 B=IN_PROGRESS/1
cycle 3: stop=no-candidates        ran=[A,B]
```

`INFERENCE` — a task that repeatedly fails by *returning* does **not** starve its
successors; it leaves the ready set on its first attempt. Strict `ORDER ASC` is
starvation-free here with no fairness machinery. D1/D2 assert exactly this.

`INFERENCE` — and the honest limit: there is no verifier, so a task that returned
is also never moved on, and stays `IN_PROGRESS` forever. That is not starvation of
B; it is A being stuck. Both are true, and the distinction matters, because the fix
for "A is stuck" — a verifier that requeues it — is exactly what would
**reintroduce** starvation of B under a strict order, since a lower-ordered task
that always requeues wins every cycle.

`DESIGN DECISION` — therefore no anti-starvation machinery is built. The
requirement is recorded machine-visibly as `ANTISTARVATION_REQUIREMENT` and is a
**dependency of a future verifier**, not something to pre-solve. M13 (invert the
anti-starvation predicate) is killed by D1/D2.

---

## 7. Trigger deduplication

`FACT` — the Scheduler already serialises itself: concurrent `cycle()` calls join
the in-flight one (`scheduler.ts` `inFlight`).

`DESIGN DECISION` — the coordinator adds policy on top: refuse when not running,
**coalesce** while running (join, or record **one** pending re-run), and never
queue. A queue would turn N rapid task mutations into N evaluations, which is the
waste this is meant to prevent. One pending re-run is sufficient because a cycle
re-reads the whole snapshot and would observe every change that motivated the
intermediate requests.

`EVIDENCE` — A3 (10 simultaneous triggers, max 1 concurrent cycle, ≤2 cycles
total), A4 (5 mid-cycle triggers → exactly one re-run), and I3 (300 seeds).

---

## 8. Trigger failure semantics

`DESIGN DECISION` — **CONTINUE.** A cycle that throws is a failed *evaluation*, not
evidence the scheduler is broken. The Scheduler's contract already resolves almost
every failure into a `CycleResult`; anything reaching the coordinator is a defect in
the bridge or the store, and neither should poison the trigger.

| situation | action |
|---|---|
| cycle throws | CONTINUE, report via `onEvent`, count it |
| cycle returns an error | the cycle's own business (`CycleStop`) |
| empty queue | `no-candidates`, return to idle |
| only blocked tasks | `no-candidates` (blocked ≠ ready, per TaskGraph) |
| provider failure | `rejected` observation; attempt still recorded |
| permission denial | `permission-denied` (6S) → `rejected` observation |
| session deletion | `session-superseded`; self-dispose, release ownership |
| shutdown | `REFUSED_NOT_RUNNING`; no cycle, no state |

`EVIDENCE` — A5, A6, A7, G1, H2, H3.

---

## 9. Per-turn abort contract

`DESIGN DECISION` — `ExecutionHandle` is **not** an `AbortController`. The 6R
context already owns the real one; this is its *address*, published so a lifecycle
can reach it without holding a reference to the context — and therefore without
being able to touch anything else the context owns.

```
NEW → RUNNING → CANCEL REQUESTED → CANCELLED / RETURNED → CLEANUP
```

Required properties, each met structurally:

| requirement | how |
|---|---|
| per-execution | constructed per dispatch; never pooled |
| unique | monotonic counter, injected into the bridge as a 2nd `RunTurn` arg |
| disposable | `dispose()` drops the callback, in a `finally` — not in seven returns |
| not shared with parent | 6R's context owns its own controller; the handle holds only the callback |
| not shared between executions | held singly, replaced not stacked (V1 is serial) |
| safe to cancel repeatedly | flag + early return; **first reason wins** |

`DESIGN DECISION` — a cancel requested *before* the turn attaches is recorded and
fires on `attach`. Dropping it because the handle was not wired up yet is a race
with a silent winner. `EVIDENCE` — E2, I4 (300 seeds, both orderings).

`DESIGN DECISION` — cancelling is **not** releasing. The task stays `IN_PROGRESS`
with its generation; moving it belongs to a legitimate authority, never to the
thing that stopped the work. Writing a status here would be the scheduler
inventing a verdict, which 6C/6I forbade.

---

## 10. Session deletion cancellation

> session deletion should stop future autonomous work as early as the current
> runtime permits, while durable incarnation protection remains the final boundary

`FACT` — what 6T supplies is the **mechanism**: a reachable handle that ends a live
turn. What it deliberately does not supply is the **wiring**. 6Q reached its
decision through the lineage write, i.e. *after* a turn ended; giving the store a
way to interrupt a live turn would require a registry and a polling loop. The
composition root owns both the session lifecycle and the Scheduler, so it is the
thing that must call `cancelActive("session-deleted")`.

`INFERENCE` — and `disposeSelf()`'s own `cancelActive` is currently a **no-op**,
because `disposeSelf` runs on the lineage path *after* the turn has returned, and
the handle is disposed in the `finally`. Mutation M6 (removing that call)
**survived**, and the classification is **EQUIVALENT**: cancelling a handle whose
turn is over cannot change an outcome. E11 pins that as evidence rather than
leaving it assumed. The live-cancellation path is F1 and E9.

6Q's protection is **not** weakened: the attempt still cannot be recorded after
deletion, and nothing is resurrected (F1).

`INFERENCE` — but D3's fix means deletion is caught **without** any wiring, at
cycle granularity, from a durable fact. A composition root that forgets to
notify is still stopped (H3).

---

## 11. Scheduler lifecycle

`FACT` — states already existed: `CREATED | RUNNING | IDLE | STOPPING | STOPPED`.
6T adds no new state; it documents them against the mission's
`NEW/READY/RUNNING/STOP_REQUESTED/STOPPED` and closes the idle-deletion hole (D3).

| question | answer |
|---|---|
| can RUNNING restart? | yes, idempotent — no second loop (G3) |
| can STOPPED restart? | **no**, and it throws rather than silently no-opping (G2) |
| can two loops exist? | no — `inFlight` serialises cycles, `ownsSession` fails closed (G5) |
| active execution on stop? | `stop()` cancels, **then** awaits the cycle (G4) |
| pending cycle on stop? | awaited to completion; never half-abandoned |
| after session deletion? | self-dispose, release ownership, replacement may start (F2, G6) |
| accidental restart needed? | **no** — that was exactly D3's wedge, now fixed |

---

## 12. Shutdown

`DESIGN DECISION` — **Model D, bounded**, chosen as the minimum that is safe *and*
is already partly present:

```
stop accepting triggers  →  cancel active work  →  bounded wait  →  exit
                                                        ↓
                                        durable state remains recoverable
```

`FACT` — `cli/setup.ts:1507-1539` already does an async teardown
(`killAllBackgroundJobs`, `mcpCloseAll`, `lspCloseAll`) — and **no signal handler
calls it**; SIGTERM/SIGHUP `process.exit` synchronously at
`src/ui/tui/app.ts:333-334`.

`INFERENCE` — so the async machinery exists; what is missing is the signal
wiring. Models A (crash-like) and B (signal, don't wait) both discard an existing
capability, and A additionally means a live turn is always abandoned rather than
usually. Model D reuses `stop()`'s existing await and adds only a bound.

`DESIGN DECISION` — cancellation is an **optimisation, not a substitute for
recovery**. A cancelled turn that never returns is handled by 6Q's incarnation
check and later reconciliation, exactly as a crash is. Durable recovery is not
removed because cancellation now exists.

`DESIGN DECISION` — application-wide shutdown is **not** redesigned. The missing
signal handler is recorded as an enablement-phase dependency, not built here.

---

## 13. Emergency stop

`DESIGN DECISION` — design only, no mechanism added. Two answers, in preference
order:

1. **`scheduler.stop()`** — cancels the active turn, waits, releases ownership, and
   is not restartable. Deletes nothing, and a claimed task stays `IN_PROGRESS` for
   a legitimate authority.
2. **process shutdown** — the blunt instrument, and the only one that works when
   the scheduler is wedged in a way the operator cannot otherwise reach.

`FACT` — there is **no feature flag** to abuse: no `features`/`flags` field exists
anywhere. `INFERENCE` — inventing one would be enablement, which §26 forbids.
Session deletion is *not* an emergency stop: it destroys the task namespace.

---

## 14. Trigger scope

`DESIGN DECISION` — **PER SESSION**, inherited rather than chosen: the Scheduler is
already per-session, the task namespace is the session, and 6Q's incarnation makes
a session's tasks unusable after deletion. A per-process trigger would have to
reason about which session it meant; a per-session one has exactly one namespace
and no such question.

`DESIGN DECISION` — **per-task triggering is not expressible and not wanted**: a
task cannot ask to be run without something already knowing it exists.

| requirement | mechanism | evidence |
|---|---|---|
| no cross-session execution | per-session ownership; task namespace is the session | H1, P1, P2 |
| no duplicate ownership by accident | `acquireSessionOwnership` fails closed; atomic capacity predicate | G5, M12, I2 |
| no scheduler for a deleted session | incarnation check at every cycle | F2, P4 |
| no resurrection by recreation | new lifetime = new incarnation; old instance self-disposed | F3, P6 |
| multiple processes | durable facts only; no registry, no lock | P2, P4, P6 |

`INFERENCE` — cross-process liveness remains limited by 6L's D5′
(`session-ownership.ts` is process-local by design and says so). 6T does not
regress it and does not claim to fix it.

---

## 15. State machine

| # | state | durable mutation | owner | generation | attempt | next action |
|---|---|---|---|---|---|---|
| 1 | IDLE | none | — | — | — | await trigger |
| 2 | TRIGGERED | none | — | — | — | run cycle; refuse if not running |
| 3 | EVALUATING | none | — | — | — | read snapshot, build graph |
| 4 | pre-cancelled | **none** | — | **none** | **none** | → IDLE |
| 5 | session-superseded | none | **released** | — | — | self-dispose → STOPPED |
| 6 | NO_READY_TASK | none | — | — | — | → IDLE |
| 7 | READY_TASK_FOUND | none | — | — | — | re-read row, claim |
| 8 | contended | **none** | — | **none** | **none** | → IDLE |
| 9 | claim accepted | status IN_PROGRESS, owner=scheduler | set | **+1** | — | publish handle, dispatch |
| 10 | EXECUTING | none | held | — | — | await observation |
| 11 | RESULT | attempt recorded | — | — | recorded | release claim → IDLE |
| 12 | RESULT (deleted) | **nothing written** | released | — | refused | self-dispose → STOPPED |
| 13 | CANCELLED | none (cancelling ≠ releasing) | held | — | recorded | → IDLE / STOPPED |
| 14 | PERMISSION_DENIED | none | released | — | recorded | → IDLE |
| 15 | TASK_SUPERSEDED | **nothing written** | released | — | refused | → IDLE |
| 16 | SHUTDOWN | none | released | — | recorded | → STOPPED |
| 17 | PROVIDER_FAILURE | none | released | — | recorded | → IDLE |

Rows 4, 8 and 12 are the ones that matter: **the paths that write nothing.**

---

## 16. Evidence

### Tests — 53 pass, 5950 assertions

A trigger (7) · B contention (6) · C selection (9) · D starvation (3) ·
E cancellation (11) · F session deletion (3) · G lifecycle (6) · H scope (3) ·
I properties (5, 400+400+300+300+300 seeds).

### Mutation M1–M13 — 11 killed, 2 classified

| id | mutant | result |
|---|---|---|
| M1 | trigger bypasses readiness | killed (6) |
| M2 | drop the pre-claim capacity check | killed (2) |
| M3 | capacity rejection lets a second UPDATE land | killed (38) |
| M4 | duplicate trigger starts an overlapping cycle | killed (4) |
| M5 | STOPPED scheduler can execute | killed (8) |
| M6 | deletion does not cancel the active execution | **EQUIVALENT** — see §10 |
| M7 | handle pushed into shared global state | **UNOBSERVABLE** — see below |
| M8 | dispose does not stop the trigger | killed (2) |
| M9 | policy selects a task that was never ready | killed (8) |
| M10 | policy substitutes a terminal task | killed (6) |
| M11 | deletion/recreation lets an old trigger run | killed (8) |
| M12 | two sessions share one lifecycle | killed (8) |
| M13 | remove the anti-starvation fact | killed (4) |

**M7 — UNOBSERVABLE.** Pushing a handle into a global array changes no behaviour,
because nothing reads it. The *real* property is isolation between handles, which
is behavioural and is tested (E10: cancelling one execution reaches neither another
handle nor another session's scheduler). "No global registry exists" is a
source-inspection property; a test asserting it would be testing the mutant's
implementation rather than the system's behaviour. The restore mechanism was
deliberately in-memory rather than `git checkout` (6S F8).

**M13 anchor, first attempt.** The initial anchor matched the identical predicate
in `hasLiveSchedulerClaim` (the capacity *classifier*) rather than the one in
`reconcileIfNoCompletedAttempt`, so it changed nothing observable and "survived"
for a reason unrelated to the tests. Re-aimed via the unique trailing backtick;
killed.

**No test was weakened.** The two survivors were addressed by *adding* evidence
(E10, E11) or by proving the equivalence, never by relaxing an assertion.

### Process boundary — real OS processes, 4 pass

| id | check | result |
|---|---|---|
| P1 | two trigger sources → same task | one claim; generation = 1 |
| P2 | **two parallel processes** contending | one claimed; max generation 1; no double claim |
| P4 | deletion + **idle** scheduler | self-disposed; replacement starts |
| P6 | session recreation + late old trigger | old lifetime executed nothing |

P2's first version ran the children **sequentially and passed vacuously** — the
first process did all the work, so contention was never exercised. Rewritten with
`spawn` and `Promise.all`; a vacuous pass is not recorded as evidence.
P3 (user turn + trigger) and P5 (shutdown + live execution) are covered in-process
because both concern same-process runtime state.

### Performance sanity — no pathological behaviour

| measurement | result |
|---|---|
| idle trigger, 1→200 tasks × 200 fires | 0.006 → 0.000 ms/cycle, **flat** |
| 10 000 triggers during one cycle | 6.21 ms, **2 cycles** |
| cancellation latency, 2000 turns | p50 0.0001 ms, p99 0.0019 ms, max 0.054 ms |
| handle alloc+attach+cancel+dispose × 1e6 | 76 ms (76 ns each) |

`INFERENCE` — a trigger is cheap enough to be called from a task-mutation hook, and
the flat idle curve means the coordinator does not scan the task set.

### Gates

- 6C/6F/6K/6P/6Q/6R/6S/6T + taskstore + task-invariants + task-di + arch-map:
  **318 pass / 0 fail**.
- Full suite: **3218 pass / 23 skip / 3 fail** — the 3 known pre-existing
  (`VENDOR.md` ×2, `web ssg` nested list). `tsc` **28 = baseline**. `biome` clean on
  all 6T files.
- Production Scheduler construction: `new Scheduler(` in `src/` = 1, the comment at
  `src/task/scheduler.ts:29`. Actual constructions: **0**.
- 6P/6Q/6R/6S regressions all green.

### One 6C assertion restated

6C `25b` asserted "a refused dispatch does NOT release the claim", on a scheduler
whose cancellation was already true. 6T's pre-claim check now catches that
*earlier*, so the task is never claimed: it stays `PENDING`, no generation spent.
`25b` was rewritten to assert the better behaviour, and **6C's property was
preserved as `25c`** against the TOCTOU window it still applies to — cancellation
flipping true *after* the claim.

---

## 17. Unresolved

1. **Trigger transport: DECISION BLOCKED.** Every available answer (startup hook,
   task-mutation emitter, CLI command) is an enablement decision. Coordinator done;
   transport deliberately absent.
2. **Cross-process liveness (6L D5′)** unchanged and not fixed.
3. **No verifier.** Completed tasks stay `IN_PROGRESS` forever, and the
   anti-starvation requirement is deferred to whoever builds one.
4. **Composition-root wiring** for deletion → `cancelActive` and for signal →
   `stop()` is defined here and not built (enablement).
5. **The matrix/table drift risk** carried from 6S: the capacity predicate and the
   starvation claim are correct as long as `attempt_generation` means what 6I
   documented. Nothing enforces that correspondence at runtime.
6. **No feature flag** exists, so no runtime emergency switch is possible without
   inventing one.

---

## 18. Roadmap

1. **Integration phase** — one composition root, one trigger transport, one signal
   handler, deletion → `cancelActive` wiring. Still with a hard off switch.
2. **Verifier** — the first authority that moves work off `IN_PROGRESS`. Must
   bring `ANTISTARVATION_REQUIREMENT` with it.
3. **Observability** — surface trigger outcomes, `contended` rates and
   `session-superseded` counts; they are already emitted and currently invisible.
4. **Then, and only then**, an enablement decision.

## 19. Verdict

**GO** — trigger semantics, policy ownership, selection, contention, dedup, failure
handling, per-turn cancellation, session-deletion handling, lifecycle and shutdown
behaviour are all explicit, tested, mutation-checked and process-verified.

**NO-GO for enablement**, on unchanged grounds: D5′ cross-process recovery, the
duplicate crash window, the absent verifier, and an unchosen trigger transport.
6T makes autonomous execution *controllable*. It does not make it safe to switch on.
