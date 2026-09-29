# PHASE 6Q — SESSION DELETION & EXECUTION LIFETIME

Baseline: **`f77d2f6`** (`feat: establish durable task execution ownership`) · tree CLEAN · 42 ahead · nothing pushed.

Resolves **F2** and **F6**. Does not implement 6R (autonomous child-session context), trigger, approval, shutdown, or enablement. Scheduler production construction count: **0** (still only the comment at `scheduler.ts:29`).

Labels: `[FACT]` · `[OBSERVATION]` · `[INFERENCE]` · `[DESIGN DECISION]`.

---

## 1. F2 reproduction (recorded BEFORE any change)

`[FACT]` At `f77d2f6`, the 6N reproduction produced:

```
(inside runTurn) session deleted          tasks=0
cycle() outcome    THREW: execution generation 1 is no longer current for 6n/t1;
                   refusing to record a stale completion
scheduler state    IDLE
active claim       {"taskId":"t1","claimRevision":2,"execGeneration":1}
post-delete cycle  THREW: session 6n is already owned in this process
```

`[INFERENCE]` Two independent harms, and the mission's final principle is right that the
exception is the lesser one. The **wedge** is the real defect: the claim is cleared on one
line *after* the lineage write, so any failure in between leaves it set, and `runCycle`
returns `already-dispatched` whenever a claim exists. Ownership is then never released, so
no replacement can start. Wrapping `cycle()` in `try/catch` would have converted a crash
into a **silent permanent stall**.

---

## 2. F6 reproduction (BEFORE any change)

`[FACT]` `src/session/persistence.ts` had two session-teardown paths:

| Path | Task cleanup? | Evidence |
|---|---|---|
| `deleteSession` | **yes**, first, propagating failure | 6K D4 fix |
| `purgeExpired` | **no** — deletes `sessions`/`messages`/`turns`/`presentation_events`, never references TaskStore | pre-6Q source |

`[INFERENCE]` A TTL-purged session therefore orphaned its task rows **and** their execution
lineage — and after 6P those rows carry durable `execution_owner` markers naming generations
that can never be reconciled, because nothing will ever reconcile them.

---

## 3. The lifetime state machine

`[DESIGN DECISION]` Session axis: `ALIVE → DELETE_REQUESTED → TEARDOWN → DELETED`, realised
durably by a **session incarnation counter** (§4). Execution axis: `IDLE → CLAIMED → TURN
RUNNING → TURN RETURNED | TURN FAILED → RECONCILING → STOPPED`.

`[FACT]` Every state in the required A–G cross-product, with the answers:

| State | new claim? | execution continues? | late completion writes? | reconcile? | claim cleared? | replacement starts? | recreated session affected? |
|---|---|---|---|---|---|---|---|
| **A** deleted before claim | no (no rows) | n/a | n/a | no-op | n/a | yes | no |
| **B** deleted after claim, before `runTurn` | no | no (store returns `TASK_GONE`) | **no** | no-op | **yes** | **yes** | no |
| **C** deleted **during** `runTurn` | no | yes (harmless) | **no** (`TASK_GONE`) | no-op | **yes** | **yes** | no |
| **D** deleted after return, before write | no | already ended | **no** (`TASK_GONE`) | no-op | **yes** | **yes** | no |
| **E** deleted after the write | n/a | ended | already recorded | row gone | **yes** | **yes** | no |
| **F** deletion fails halfway | 6K residue | yes | **no** (incarnation already moved) | visible | **yes** | **yes** | no |
| **G** recreated while old execution returns | yes (new row) | old yes | **no** (`SESSION_SUPERSEDED`) | new row recoverable | **yes** | **yes** | **no** |

`[INFERENCE]` The single durable fact that makes all seven work is the incarnation. Without
it, G is not merely unsafe — it is **undecidable**, and §9 shows the collision is exact.

---

## 4. Durable design: session incarnation

`[FACT]` `taskId` is allocated **per session and restarts at `t1`** (verified in B1/A4 and by
the P2 process test). So a deleted-and-recreated session has task ids *identical* to the
deleted ones, and a fresh claim starts at `exec_generation = 1` again.

`[FACT]` Measured collision (process P2, separate OS processes):

```
A claims in the OLD session      {"id":"t1","gen":1,"inc":1}
C recreates + claims             {"id":"t1","gen":1,"inc":2}
same taskId? true    same execGeneration? true
```

`[INFERENCE]` The lineage guard `WHERE exec_generation = ?` **matches the recreated row**.
A late completion would stamp `attempt_generation` on it, and that new claim would be treated
as already completed and never recovered. The existing columns cannot distinguish these.

`[DESIGN DECISION]` Therefore a durable per-session **incarnation** counter, in `task_meta` in
`tasks.db` (same persistence domain as the rows it protects):

| Operation | Effect |
|---|---|
| `getSessionIncarnation(id)` | current value; absent ⇒ `1` |
| `bumpSessionIncarnation(id)` | `+1`; called by the canonical deletion **before** any row removal |
| `claimTask` | returns the current incarnation |
| `recordAttemptReturned(..., inc)` | **refuses** the write if the incarnation moved |

`[DESIGN DECISION]` It is not a lease, lock, heartbeat, priority or completion claim. It grants
no authority; it only lets a late writer recognise that it is late. It deliberately
**survives** the session's own deletion, because remembering the deletion is its whole job.

### The guard must precede the write — found by the test, not by inspection

`[FACT]` The first implementation checked the incarnation **after** the guarded `UPDATE`. Test
A4 caught it: it returned `RECORDED` and stamped the recreated row. Checking afterwards is not
a weaker check, it is a **wrong** one, because the write has already landed.

`[DESIGN DECISION]` The check and the write now share one `db.transaction`, so no other process
can bump the incarnation between them. Mutation **M6** re-introduces the after-the-write
ordering and is killed with 6 failures.

---

## 5. Late-return contract

`[FACT]` `recordAttemptReturned` was `void` and **threw** whenever the guarded `UPDATE` matched
no row. It now returns a classified outcome and never throws for an ordinary non-match:

| Outcome | Meaning | Threw before? |
|---|---|---|
| `RECORDED` | marker written | no |
| `TASK_GONE` | the row is gone — the session was deleted under this execution | **yes** |
| `SUPERSEDED` | row exists, this generation is not current | **yes** |
| `SESSION_SUPERSEDED` | the session was deleted/recreated since the claim | (misreported) |

`[DESIGN DECISION]` 6I's protection is preserved **exactly**: nothing is written on any
non-`RECORDED` path, so an outcome is never misattributed. What changes is that the caller is
*told* instead of being destroyed by it. Genuine SQL errors still throw.

`[FACT]` E3 in `phase6f` previously asserted the throw. It now asserts the classification **and**
that `attemptGeneration` did not move — the load-bearing property, tested directly rather than
through an exception.

`[INFERENCE]` A late return therefore cannot crash the Scheduler, resurrect a task, mutate a
recreated session, acquire ownership, or mark anything `COMPLETED` — and the Scheduler is
told, through `lineage` and a new `task:execution_abandoned` event, so it is reported rather
than swallowed.

---

## 6. Scheduler ownership lifecycle

`[DESIGN DECISION]` The claim is released **unconditionally** at the top of the terminal path,
before the lineage write, because the attempt *has* ended whatever the store says about
recording it:

```ts
const generation = this.claim
this.claim = null            // every terminal path, before any side effect
if (generation === null) { … return }   // refuse to guess; RETURN, not throw
const lineage = this.store.recordAttemptReturned(…, generation.sessionIncarnation)
```

`[FACT]` Cases and the release rule:

| Case | claim released? | ownership released? |
|---|---|---|
| normal completion | yes | only on `stop()` |
| `runTurn` throws / rejects | yes | only on `stop()` |
| **session deleted mid-turn** | **yes** | **yes — self-dispose** |
| cancellation (stop during turn) | no (by design) | **yes** (D4) |
| stale completion | yes | yes, if the session is gone |
| process restart | n/a (process gone) | n/a |

`[DESIGN DECISION]` `disposeSelf()` is synchronous and private. It cannot be `stop()`, which
awaits the in-flight cycle — and its only caller *is* that cycle, so awaiting would deadlock.
It releases the token and moves to `STOPPED`, which is what lets a replacement start.

`[FACT]` The `generation === null` path now **returns** instead of throwing, so an unidentified
attempt can never become a lifecycle wedge either. 6N §11 flagged three `throw` sites escaping
`cycle()`; two are now gone, and the third (`claim accepted but task unreadable`,
`scheduler.ts:343`) is left as a genuine persistence fault.

---

## 7. Canonical deletion architecture

`[DESIGN DECISION]` One operation, `deleteSessionCompletely(id, cwd)`:

```
1  bump the session incarnation   <- invalidate every in-flight execution
2  delete TaskStore rows          <- tasks.db, propagating failure
3  delete session-side rows       <- sessions.db
```

`[FACT]` `deleteSession` and `purgeExpired` both route through it. `purgeExpired` is synchronous,
so it drives the same three steps inline with the same statements and the same order — shared
semantics, one ordering rule, no duplicated cleanup logic.

`[FACT]` Step 1 is first because that is what closes F2 across process boundaries: an execution
returning after this point finds a moved incarnation and is refused, so it can never write into
a deleted session or a later recreation of it.

---

## 8. Ordering rationale (6K preserved)

`[DESIGN DECISION]` Tasks before session rows, unchanged. The two residues are not symmetric:

- **task-delete failure** → the session still exists, so the deletion is visibly incomplete and
  retryable, and nothing is orphaned. **BENIGN.** (C2, M7)
- **session-first failure** → task rows survive with no session to reconcile them: **executable
  orphans**, the dangerous residue 6K D4 was raised for.

`[FACT]` M3 reverses the ordering and is killed (3 failures) — the guard is load-bearing, not
decorative.

`[DESIGN DECISION]` **Failure injection.** C2 injects a task-store failure through
`TaskStore.prototype` (the canonical operation builds its own store, so an instance patch would
miss it) and asserts: the call rejects, the session survives, and a retry succeeds. The reverse
ordering is proved unsafe by M3 rather than asserted in prose.

---

## 9. Transaction boundaries

`[FACT]` `tasks.db` and `sessions.db` are **separate persistence domains**; no transaction spans
them, and this phase does not pretend otherwise. The requirement met is that every reachable
partial state is safe, visible and retryable:

| Failure point | Durable residue | Safe? |
|---|---|---|
| at step 1 | nothing deleted; session intact and usable | yes |
| at step 2 | incarnation **already moved**, so no execution is authorised; rows remain but the session is still there | yes — visible, retryable, **not executable by a stale claim** |
| at step 3 | tasks gone, so nothing executable survives; session rows remain | yes — visible, retryable, no autonomous work can exist |

`[DESIGN DECISION]` Step 1 being durable and *first* is what makes the step-2 residue safe. Had
the bump been last, a step-2 failure would have left live executions authorised against a
half-deleted session.

---

## 10. Active execution semantics — the selected option

`[DESIGN DECISION]` **Option D (combination), reduced to the minimum that closes F2:**

| Option | Verdict |
|---|---|
| A. cancel immediately | `[INFERENCE]` **Rejected as the mechanism.** It needs a per-turn abort handle, which the kernel does not expose per context — that is 6R/ADR-8, explicitly out of scope. It also does not help when the deletion lands between the abort and the return. |
| B. invalidate late completion | **SELECTED.** The incarnation guard. Works across processes, needs no coordination, no registry, no abort handle. |
| C. terminate Scheduler ownership before deletion | **SELECTED, but locally.** Achieved by the Scheduler learning from *durable evidence* (`TASK_GONE`/`SESSION_SUPERSEDED`) and self-disposing, rather than the deletion path needing to know a Scheduler exists. |
| D. combination | the selection above |

`[INFERENCE]` The resulting guarantee: **old execution × deleted session × recreated session =
no durable cross-generation effect** — and it holds without any of them cooperating.

`[DESIGN DECISION]` No coordination was added: no registry of live Schedulers, no lock, no
signal, no new timer. The only new durable facts are the incarnation counter and the
classification results.

---

## 11. Process-boundary results (P1–P4, genuine OS processes)

`[FACT]` Separate `bun` processes, one `tasks.db`:

| Case | Result |
|---|---|
| **P1** A owns an execution, B deletes | PASS — no claim, no dispatch, nothing to strand |
| **P2** A owns, B deletes, C recreates + claims | PASS — old return ⇒ `SESSION_SUPERSEDED`; recreated task keeps `title: "NEW SESSION WORK"`, `att: null`, `owner: scheduler` |
| **P2b** the recreated claim is still recoverable | PASS — `recovered: ["t1"]`, i.e. not protected by a foreign completion |
| **P3** A returns late after deletion | PASS — refused, nothing resurrected |
| **P4** A crashes after claim, B deletes, C opens | PASS — `stop=no-candidates`, `tasks=0`, no blocking ownership |

`[INFERENCE]` P2 is the decisive one: it is the only test that constructs the exact
`(session, taskId, execGeneration)` collision, and it shows the incarnation — not the lineage
guard — is what refuses the write.

---

## 12. Mutation results (M1–M10)

`[FACT]` 10 semantic mutants, **10 killed, 0 survivors**, all sources restored byte-identical.

| ID | Mutant | Killed by |
|---|---|---|
| M1 | canonical deletion drops the incarnation bump | C4 |
| M2 | `purgeExpired` drops TaskStore cleanup (F6 reintroduced) | F1 |
| M3 | ordering reversed (session rows first) | C2 |
| M4 | claim not released before the lineage write (the wedge) | A1 |
| M5 | lineage write ignores the incarnation guard | A4 |
| M6 | guard checked **after** the write | A4 |
| M7 | task-delete failure swallowed | C2 |
| M8 | incarnation not advanced on a repeated delete | C5 |
| M9 | Scheduler does not self-dispose | A1 |
| M10 | incarnation bumped at claim instead of at deletion | A2 |

`[DESIGN DECISION]` **M1 and M8 survived the first run and were real gaps in my own test
suite, not equivalent mutants.** M1 was unobserved because the bump was only exercised through
`purgeExpired` and the store helper, never through the canonical `deleteSession` entry point;
M8 because repeated deletion was tested only on a session that was never re-claimed. Both were
closed by adding **C4** and **C5** — new assertions, not weakened ones. This is reported
rather than hidden, because a surviving mutant is a statement about the suite.

---

## 13. Property / state-machine results

`[FACT]` 300 seeds (`60601…60900`) over 11 operation kinds — create, claim, return, delete,
**recreate**, reconcile, interactive cursor, complete, requeue, restart, unrelated session —
plus 50 explicit idempotency sweeps: **7 758 assertions, 0 violations**.

`P4_NO_WEDGE` · `P5_NO_RESURRECT` · `P7_UNRELATED_INTACT` · `P8_IDEMPOTENT` ·
`P9_OWNERSHIP_ATOMIC` · `P9_COMPLETION`

---

## 14. Phase 6P regression check

`[FACT]` E1–E4 in the 6Q suite assert 6P still holds after a deletion: no executable task and
no orphan ownership remain; reconciliation cannot recover a task whose session was deleted; a
recreated task inherits **no** ownership and **no** lineage; and the **H1/H5 distinction is
unchanged**.

`[FACT]` The full 6P suite (31 tests) and the whole task/Scheduler set pass unchanged:
`325 pass / 0 fail` across 9 files, and `3101 pass / 23 skip / 3 fail` for the full suite — the
same 3 verified pre-existing failures. tsc `28` and biome `src/task` `7` are both exactly
baseline.

`[FACT]` Completion authority is intact: the Scheduler still writes only `IN_PROGRESS`
(claim) and `PENDING` (reconcile / dispatch-failure release).

---

## 15. Residual limitations

1. `[FACT]` **6R is still required.** The kernel's turn is a whole-conversation merge behind one
   `busy` slot with a session-global `abort`. 6Q makes a *deleted* session's execution harmless;
   it does not give an autonomous turn its own context. Nothing here assumes 6R exists.
2. `[DESIGN DECISION]` **A live session's execution is not cancelled by deletion until it
   returns.** The incarnation makes its *write* harmless; the work itself still runs to
   completion. Killing it needs a per-turn abort handle (ADR-8), out of scope here.
3. `[FACT]` `purgeExpired` resolves the session's `cwd` from its session rows to locate
   `tasks.db`. Sessions whose `cwd` is absent fall back to the process cwd; a session created
   in a different workspace would therefore be purged from the wrong task store. **This is a
   pre-existing property of how `purgeExpired` was already scoped** (it received an open `db`
   and no cwd), and 6Q preserves it rather than changing it — but it is now load-bearing for
   task cleanup, so it is recorded as a **P3 follow-up** for 6R/6T.
4. `[DESIGN DECISION]` `session_incarnation` rows accumulate one per deleted session id in
   `task_meta`. Bounded by session count, never read except by a late writer, and required to
   outlive deletion.
5. `[FACT]` F6 is closed **for the explicit and TTL paths**. Any future third teardown path must
   route through `deleteSessionCompletely`; the report and the single definition are the guard.
6. `[FACT]` Unchanged standing limits: the duplicate crash window, unprovable model intent, no
   verifier, no attempt history, and D5′ cross-process live-task recovery.

---

## 16. Verdict

# GREEN

| Criterion | Status |
|---|---|
| F2 no longer wedges the Scheduler | **YES** — claim released on every terminal path |
| deleted sessions cannot retain executable autonomous work | **YES** — rows removed, incarnation moved |
| late execution cannot mutate recreated sessions | **YES** — `SESSION_SUPERSEDED`, proven cross-process (P2) |
| a replacement Scheduler can start | **YES** — `disposeSelf()` releases ownership; A1 |
| F6 closed through canonical deletion semantics | **YES** — `purgeExpired` routes through it |
| deletion ordering remains safe | **YES** — 6K tasks-first preserved; M3 killed |
| partial failures are safe/retryable | **YES** — C2 + failure matrix in §9 |
| process-boundary evidence exists | **YES** — P1–P4, four genuine process cases |
| normal / error / cancellation paths covered | **YES** — D1–D4 |
| no new P0/P1 | **YES** |
| Phase 6P remains correct | **YES** — 31/31, 325/0 across the task set |
| completion authority intact | **YES** — Scheduler still writes only IN_PROGRESS/PENDING |
| tsc / lint | **28 / 7** — exactly baseline |
| full suite | **3101 pass / 23 skip / 3 fail** — the same 3 pre-existing |
| Scheduler production construction | **0** |
| tree CLEAN | **YES** |

`[INFERENCE]` The two halves of F2 needed different fixes, and only one of them was the
exception. The wedge came from **ordering inside `dispatch()`** — a single statement that
cleared bookkeeping after a side effect. The cross-generation danger came from a fact that
**did not exist in the schema at all**, and 6O had predicted exactly that: `taskId` restarting
per session makes a recreated session indistinguishable by id, so a late completion could land
on it. Fixing F2 without the incarnation would have closed the symptom and left the data model
unable to express the difference.

`[DESIGN DECISION]` Not fixed here, by instruction: 6R context isolation, approval, trigger,
shutdown contract, and enablement. This phase closed the lifetime boundary only.
