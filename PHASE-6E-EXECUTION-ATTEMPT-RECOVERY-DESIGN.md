# PHASE 6E — EXECUTION ATTEMPT & RECOVERY SEMANTIC REDESIGN

Base: `05935e5` (`audit: adversarially re-audit scheduler core`)
Design only. **0 production changes.** Scheduler remains production-unreachable.

---

## 1. Executive result

# DESIGN READY — one new durable concept, zero new statuses

| | |
|---|---|
| 6D livelock reproduced | **VERIFIED** — 4 runs / 4 cycles with **no** external condition |
| information gap located | **VERIFIED** — a crash and a normal return leave **byte-identical** TaskStore rows |
| root cause | the only writer who *knows* an attempt finished is the process that survived, and it never writes it down |
| selected architecture | **one durable attempt marker**, TaskStore-owned, additive |
| new `TaskStatus` values | **0** |
| agent-loop / bridge changes | **0** — `runTurn` keeps its current contract |
| TaskGraph changes | **0** |
| LEGACY impact | **provably none** — no column changes, no existing method altered |
| concepts rejected | 8 (§24), each for a named reason |
| remaining impossible | model↔task **intent** correlation (§13) — *IMPOSSIBLE WITH CURRENT CONTRACT* |

**Verdict: 6F may implement this. The design does not require a lease, a retry
counter, a heartbeat, a new status, a Scheduler database, or any frozen-surface
change.**

---

## 2. Reproduction of the 6D defect — **VERIFIED**

Independently re-derived from source, not from the 6D report:

| conditions | result |
|---|---|
| no external mutation | **4 runs / 4 cycles**, status `IN_PROGRESS`, revision 8 |
| an unrelated task created each cycle | **4 runs / 4 cycles**, revision 8 |

Required for unbounded redispatch: **nothing**. No process crash. No second
Scheduler. No stale claim. No external mutation. No model misbehaviour — the
bridge returned `ok: true` every time.

**Classification: LIVENESS FAILURE / SEMANTIC DEFECT (6D), CONFIRMED.**

---

## 3. Root cause

Not "reconciliation is too eager". Three facts, all **VERIFIED** in source:

1. `scheduler.ts:413` / `:446` — `this.claim = null` at the end of every dispatch.
   The **only** record that an attempt happened is erased.
2. `scheduler.ts:473` — `reconcile()` exempts only `this.claim?.taskId === task.id`.
   Once forgotten, the Scheduler's own completed work is indistinguishable from
   a crash.
3. The class holds **no** attempt identity. The only per-attempt field is `claim`,
   which is ephemeral by construction.

**Root cause, stated as the design problem:** *there is no durable statement that
an execution attempt reached its end.* Everything else follows.

---

## 4. Existing execution lifecycle (as implemented, 6C)

```
CLAIM (atomic, revision-guarded)
  → DISPATCH (injected runTurn)
    → RUN
      → RETURN (ok | rejected | thrown)
        → this.claim = null          ◄── correlation destroyed here
          → next cycle: reconcile() sees IN_PROGRESS, claim is null
            → revert to PENDING → select → run again
```

Durable facts written by this path: **only** the claim's `status=IN_PROGRESS` and
`revision+1`. Nothing records the attempt's existence, its start, or its end.

**VERIFIED.**

---

## 5. Correlation boundary

What survives each edge:

| information | durable? | ephemeral? | survives restart? | available to Scheduler? | available to Agent Loop? | sufficient for recovery? |
|---|---|---|---|---|---|---|
| taskId | yes | — | yes | yes | yes | no |
| task revision | yes | — | yes | yes | yes | **no** (advances on any write) |
| claim revision | yes (implicitly) | also in `claim` | yes | yes | no | no |
| Scheduler instance identity | no | yes | **no** | yes | no | no |
| **execution identity** | **no** | **no** | **no** | **no** | **no** | **no** |
| **execution start** | **no** | **no** | **no** | **no** | **no** | **no** |
| **execution end** | **no** | **no** | **no** | **no** | **no** | **no** |
| execution outcome | no | yes | **no** | yes | yes | no |
| process identity | no | yes | no | no | yes | no |
| turn identity | no | no | no | no | yes (`journal.turn`, "narrative, may be null") | no |
| task state | yes | — | yes | yes | yes | insufficient (see §6) |

**Every row in bold is absent from the entire system.** The attempt's existence,
start and end exist nowhere — not in TaskStore, not in the Scheduler, not in the
journal, not in the agent loop.

**VERIFIED**, and it is the whole problem in one table.

---

## 6. Problem decomposition

| # | problem | status after 6C |
|---|---|---|
| **A** | normal-return convergence | **UNRESOLVED** — a successful turn becomes a re-execution |
| **B** | crash recovery vs normal return | **UNRESOLVED and information-theoretically impossible** today |
| **C** | model↔task correlation | **UNRESOLVED and inherent** to prompt dispatch |
| **D** | reconciliation policy | **WRONG** — decides on status alone, with no grace period and no evidence |

### The decisive experiment

Two rows, one produced by "claim → runTurn returned → completion not persisted",
one by "claim → process crashed before the turn":

```
C (normal return): {"status":"IN_PROGRESS","revision":2, parentId:null, dependsOn:[],
                    blockedReason:null, verification:null, evidence:[], acceptance:null}
F (crash)        : {"status":"IN_PROGRESS","revision":2, parentId:null, dependsOn:[],
                    blockedReason:null, verification:null, evidence:[], acceptance:null}
```

**Byte-identical.** No `TaskStatus`, no column, no revision value distinguishes
them.

**Exact impossibility boundary (the answer to §5's I20 question):** *with only
`TaskStatus` and `revision` as durable state, a normally-completed-but-unpersisted
attempt and a crash are the same observation. I20 is unsatisfiable in V1, and no
policy, heuristic, timer or grace period can change that — only a durable write
on the normal-return path can, and it must be written by the process that
survived.*

---

## 7. Required information model

Answering §1 before choosing a mechanism.

### Which of A–J must be distinguishable?

| state | distinguishable today? | with a durable attempt marker? |
|---|---|---|
| A claim created, execution never started | no | yes — no completion marker |
| B execution started | no | yes — no completion marker (indistinguishable from A; **not required**) |
| C execution returned normally | no | **yes** |
| D execution failed | no | **yes** (marker present; outcome is ephemeral) |
| E execution aborted | no | **yes** (marker present) |
| F process crashed | no | **yes** (no marker) |
| G completed, completion not persisted | no | **yes** (marker present, task still `IN_PROGRESS`) |
| H model returned after unrelated work | no | **no — IMPOSSIBLE WITH CURRENT CONTRACT** |
| I model worked on a different task | no | **no — IMPOSSIBLE WITH CURRENT CONTRACT** |
| J task completed independently | partially (effect visible) | same — the *effect* is visible, causation is not provable |

### The single load-bearing bit

> **"An execution attempt for task T, at generation R, reached its end."**

That is the only fact 6D proved missing and the only one the design needs. Every
other cell in the table above either derives from it plus TaskStore state, or is
impossible for reasons no schema change can fix.

**H and I are stated as IMPOSSIBLE, not deferred.** A Scheduler that emits a
prompt cannot observe what the model did. Inferring it from file diffs, tool
calls, transcripts or memory would be a **second, unaccountable inference
authority**, and 6D already showed the honest answer is that dispatch is
advisory.

---

## 8. Candidate execution-attempt models

| model | restart-safe | crash detected | duplicate detected | correlation | complexity | multi-process | **verdict** |
|---|---|---|---|---|---|---|---|
| **A** none | no | no | no | none | — | — | **REJECT** — 6D's current design |
| **B** ephemeral (keep `claim` alive) | **no** | partially | partially | in-process only | ~0 | unchanged | **REJECT** — fixes only the in-memory livelock; a crash still diverges |
| **C** durable attempt marker | **yes** | **yes** | partly | execution only | **1 table, 1 write** | unchanged | **SELECTED** |
| **D** journal-correlated | no | no | no | none | high | — | **REJECT** — `journal.turn` is "narrative, may be null"; no turn lifecycle; crosses the TaskStore authority boundary |
| **E** task revision as attempt id | yes | no | no | none | 0 | unchanged | **REJECT** — revision advances on any write, including a title edit |
| **F** hybrid | yes | yes | partly | execution only | marker + lease | partially | **REJECT** — the lease half has no semantic consumer in V1 (§24) |

**B is rejected explicitly because §6 requires it:** an in-memory remembered claim
does not help when the memory dies with the process that most needs it. B would
make the same test pass while leaving restart semantics broken — *false evidence*.

**C is selected** because it is the only model that makes the missing bit durable,
and it is minimal: one additive table owned by TaskStore, one write, one read.

---

## 9. Candidate normal-return semantics

| option | fixes livelock? | model agency preserved? | model ignores task? | model completes task? | crash? | restart? | frozen surfaces? |
|---|---|---|---|---|---|---|---|
| **A** release `IN_PROGRESS`→`PENDING` | **NO** — becomes immediately ready | yes | loops | fine | reverts → re-run | loses the fact | none |
| **B** claim stays associated, no re-dispatch | in-process only | yes | stuck | fine | reverts → re-run | **loses the fact** | none |
| **C** attempt marked completed; task stays `IN_PROGRESS`; reconciliation ignores completed attempts | **YES** | yes | **IDLE** (safe) | fine | reverts → re-run | **survives** | none |
| **D** `runTurn` returns a structured disposition | yes | yes | fine | fine | fine | fine | **agent loop must change** |
| **E** agent loop explicitly acknowledges | yes | yes | fine | fine | fine | fine | **agent loop must change** |
| **F** hybrid | yes | yes | fine | fine | fine | fine | more concepts |

**A is rejected with a proof, not a preference:** releasing to `PENDING` makes the
task ready on the very next cycle, so the state is `IN_PROGRESS → PENDING →
IN_PROGRESS → …` — **6D's livelock, with an extra write**. It cannot converge.

**D and E are rejected on minimality and frozen-surface grounds:** both require the
agent loop to report something it currently does not report, for information the
Scheduler can record itself at the moment `runTurn` resolves.

**C is SELECTED.** On normal return the Scheduler writes one durable fact and
leaves the task alone.

**SELECTED NORMAL-RETURN SEMANTICS (NEW ARCHITECTURE):**

> `runTurn` resolves → Scheduler records `attempt_returned(task, postClaimRevision)`
> → Scheduler clears its in-memory claim
> → **the task's status is NOT touched.** Reconciliation must not revert a
> generation that has a completion marker. Readiness cannot re-select it because
> `IN_PROGRESS` is not eligible.

---

## 10. Structured execution bridge — **NOT REQUIRED**

§10 asks whether V2 needs `attemptId` in the work item and a structured result.

**It does not, and this is the minimality result that matters.**

| proposed | verdict |
|---|---|
| `TaskWorkItem.attemptId` | **NOT REQUIRED** — the Scheduler knows its own attempt; the bridge has no use for the id |
| `ExecutionResult.attemptId` | **NOT REQUIRED** — the Scheduler observes the promise settling; it needs no self-report |
| `runTurn` signature change | **NOT REQUIRED** — unchanged |
| agent loop change | **NOT REQUIRED** — unchanged |

**The distinction the brief insists on, honoured:** structured *correlation* ≠
structured *verification*. This design achieves correlation entirely on the
Scheduler side and therefore does **not** claim the agent loop verified anything.
`EXECUTION ≠ VERIFICATION ≠ COMPLETION` is preserved: the marker records that a
turn *ended*, never that a task is *correct*.

**FROZEN SURFACES: untouched.** TaskGraph, readiness, UI, TUI, ACP, presentation,
executor internals and `vendor/minicore` all require no change.

---

## 11. Task state vs execution state

**Kept strictly separate (NEW ARCHITECTURE).**

| | TASK STATE | EXECUTION STATE |
|---|---|---|
| lives in | `tasks` table / `TaskStatus` | a new TaskStore-owned table |
| vocabulary | the 8 real statuses, **unchanged** | `attempt_returned` fact |
| authority | authoritative for *what is durably true* | **authoritative for nothing** except "an attempt ended" |
| read by | TaskGraph, Scheduler, verifier | Scheduler reconciliation only |
| may be used as task truth? | yes | **NO** — it is not a task state and must never be read as one |

Can execution state live outside TaskStore? **No** — it must share the
transaction boundary and the crash-consistency story with the task row, or a
crash between the two writes reopens the exact gap 6D found. So it is
**TaskStore-owned but TaskStore-adjacent**: same database, same file, **not a
Scheduler database** (§8 forbids that without justification, and the justification
here is precisely crash-consistency, not convenience).

**No new `TaskStatus` is added.** Not "attempted", not "awaiting adjudication":
both would be new states in the durable model, and 6C.1's lesson is that a
semantically wrong enum is worse than a missing one.

---

## 12. Candidate crash-recovery semantics

| model | false-positive recovery | false-negative stranded | crash recovery | complexity | cross-process |
|---|---|---|---|---|---|
| **A** status-only | **HIGH** — 6D proved it | low | "works" by re-running everything | 0 | unsafe |
| **B** attempt-aware | **low** | low (a lost marker strands) | **exact** | **1 table, 1 write** | unchanged |
| **C** journal-aware | medium | medium | none | high | unsafe |
| **D** ownership + attempt | **lowest** | low | exact | 1 table + 6B ownership | 6B fail-closed |
| **E** lease-based | low | low | exact | lease + expiry + clock | **new authority** |

**D is SELECTED:** the 6B ownership check (already implemented, already
mutation-verified) plus the attempt marker.

**E is rejected: no lease is introduced automatically.** With the marker, a lease
would narrow a window that does not exist — the crash case is already handled
exactly, and a live-lease expiry policy is a *second authority* with a clock
dependency. Adding it would be infrastructure "just in case" (§19). **DEFERRED**,
with its trigger: multiple concurrent Scheduler processes for one session.

### V2 reconciliation decision rule

For each task with `status ∈ {IN_PROGRESS, VERIFYING}`, and with session ownership
positively held (else **refuse**, unchanged from 6B):

| attempt marker | decision |
|---|---|
| marker exists, `marker.attempt_revision == task.revision` | **NOT stranded** — this generation completed an attempt. Do not revert. |
| marker exists, `marker.attempt_revision < task.revision` | **NOT stranded** — a newer generation exists; do not revert. Fails safe against reverts. |
| marker exists, `marker.attempt_revision > task.revision` | data inconsistency → **throw**, not guess |
| **no marker** | **STRANDED** → revert to `PENDING` via the existing revision-guarded `reconcileStranded` |

**The rule reverts only on positive evidence of absence.** That is the whole
design principle, and it is the inverse of 6C's "revert unless proven alive".

---

## 13. Model/task correlation — **IMPOSSIBLE WITH CURRENT CONTRACT**

6D demonstrated rows 1/2/3/6 (worked on T1, worked on T2, unrelated, edited T1)
produce byte-identical Scheduler state.

| what the system can do | verdict |
|---|---|
| prove the model worked on the selected task | **CANNOT** — no signal exists |
| observe the *effect* of a turn (task rows changed) | **CAN** — but causation is not provable |
| infer intent from file diffs / tool calls / transcript | **REFUSED** — that would be a second inference authority (§7) |
| keep the bridge advisory | **YES** — and this is the honest end state |

**The marker does not change this and is not claimed to.** It correlates
*execution*, not *intent*. 6D's row 5 (model completes T1 → Scheduler advances to
T2 and strands it) is **mitigated** — with the marker, T1 converges to IDLE and
T2 is never wrongly claimed — but the underlying advisory nature is permanent.

**Recorded as a permanent property of prompt-driven scheduling, not a defect to be
engineered away.**

---

## 14. Completion ownership

§11 asks explicitly: does fixing correlation require stricter completion
ownership? **No.**

| scenario | after V2 | ownership change needed? |
|---|---|---|
| Scheduler claims T1, model completes T2 | T1 converges to IDLE (marker); T2 is `COMPLETED` and authoritative | **no** |
| Scheduler claims T1, model completes T1 | T1 `COMPLETED`; marker irrelevant; converges | **no** |
| model completes T1 **and** T2 | both authoritative; Scheduler converges | **no** |
| model does unrelated work | T1 `IN_PROGRESS` + marker → converges to IDLE | **no** |

**What remains authoritative: TaskStore, always.** The marker is a fact about an
attempt, never about correctness.

**V2 does not tighten completion ownership.** Doing so merely to simplify
implementation would be **PRODUCT SEMANTICS** change and is **NOT IMPLEMENTED
HERE** (§11). It is also not needed: 6D's T2-stranding pathology is an artefact
of the livelock, and fixing the livelock removes the pathology without
restricting the model.

---

## 15. At-least-once semantics — **redefined precisely**

**What 6C actually implemented: option C — unbounded repeated execution.**
Verified: 4 cycles, 4 executions, no bound, no convergence. That is **not**
at-least-once, and the term was a blanket justification applied without its
preconditions. **The term is withdrawn as a description of 6C.**

A legitimate at-least-once design needs all three:

| requirement | 6C | V2 |
|---|---|---|
| a defined retry/recovery trigger | none — reconciliation was automatic and unbounded | **the absence of a completion marker for the current generation** |
| bounded semantic meaning | none | **"an attempt whose completion is unrecorded"** — a closed set |
| a way to avoid normal-return livelock | **none** | **the marker** |

**V2's guarantee, stated exactly:**

> An execution is performed **at-least-once** for a task generation whose
> completion was not recorded, and **at-most-once** for a generation whose
> completion *was* recorded. Exactly-once is **not claimed and is not achievable**
> without idempotent task effects (§16).

**The one honest exception (stated, not hidden):** if the process dies *between*
`runTurn` resolving and the marker write, the attempt is indistinguishable from a
crash and one duplicate execution occurs. That window is **one durable write**,
and it is the irreducible cost of at-least-once. Anything narrower requires
transactional coupling of the agent turn to the database, which would mean
re-implementing the agent loop.

---

## 16. Multi-process implications

**The attempt marker does NOT solve ownership, and is not claimed to.**

| property | marker changes it? |
|---|---|
| two live processes, one session | **no** — both may attempt, both may reconcile |
| claim mutual exclusion | **no** — still TaskStore's revision-guarded UPDATE, still single-process only |
| stranded detection | **no** — a marker is per-task fact, not a lock |

**Cross-process same-session scheduling remains UNSUPPORTED (DEFERRED, unchanged
from 6B).** The 6B failure-closed rule still holds: a process that does not own the
session refuses to reconcile.

**Attempt identity and process ownership are conflated by neither this design nor
6B, and the confusion is explicitly rejected.**

---

## 17. Legacy compatibility

| | LEGACY | SCHEDULER |
|---|---|---|
| `tasks` table columns | **unchanged** | unchanged |
| `TaskStatus` | **unchanged** | unchanged |
| existing TaskStore methods | **behaviour unchanged** | unchanged |
| new table | created by the same additive DDL as `task_meta`; **inert** | read/written |
| new methods | never called | used by Scheduler only |
| scheduler wiring | none | none in this phase |

**Compatibility impact: none.** The marker is additive, version-free, and
unreachable in LEGACY. No migration, no data rewrite, no existing code path
branches on it. This is a direct benefit of choosing a marker over a new
`TaskStatus` — a status would have touched every switch on the status union and
every validator that consumes it.

---

## 18. Contradiction audit

| # | contradiction | real? | resolution |
|---|---|---|---|
| 1 | Scheduler owns the claim, the model owns completion, and reconciliation is automatic — so reconciliation can fight the model | **YES** (6D) | **RESOLVED** — reconciliation now requires positive evidence of *no* completed attempt, so it can never revert a completed one |
| 2 | at-least-once, but no lease | **YES** | **PARTIALLY RESOLVED** — at-least-once is now scoped to the unrecorded-attempt case with a defined trigger. The no-lease hole (two live processes) **remains and is scoped out**, not papered over |
| 3 | the attempt is correlated, yet execution is advisory | **YES** | **SCOPED** — the marker correlates *execution*, not *intent*. §13 records H/I as impossible. Not resolved, by design |
| 4 | execution is serial, yet reconciliation is automatic | **YES** | **SCOPED** — serial within a process; cross-process remains unsupported |
| 5 | a normal turn is a success, yet the task is not complete | **YES** | **RESOLVED** — these are now *different facts* in different places: the marker says the turn ended, TaskStore says the task is not complete. Neither implies the other |

No contradiction is resolved silently. 2 and 3 remain open by explicit scope.

---

## 19. Minimal architecture

Applying §19 to every candidate concept:

| concept | keep? | semantic consumer |
|---|---|---|
| attempt identity | **KEEP** | the only carrier of "an attempt ended" |
| durable marker table | **KEEP** | same fact, must survive restart and share the crash boundary |
| `attempt_revision` column | **KEEP** | prevents a stale marker suppressing recovery of a *newer* generation |
| structured work-item / result | **REMOVE** | no consumer; would touch the agent loop |
| turn identifier | **REMOVE** | agent loop unchanged; the marker is Scheduler-internal |
| lease | **REMOVE** | no consumer once the marker exists; a second authority |
| heartbeat | **REMOVE** | no consumer |
| retry counter | **REMOVE** | no consumer; V2 owns no retry policy |
| execution journal | **REMOVE** | carries no attempt lifecycle; crosses the authority boundary |
| release transition (PENDING on return) | **REMOVE** | provably causes the livelock (§9 A) |
| new `TaskStatus` | **REMOVE** | no status means "attempted, unadjudicated" |
| completion-ownership change | **REMOVE** | not a prerequisite (§14) |

**Final architecture: 1 concept, 1 table, 3 columns, 1 write, 1 read.**

---

## 20. State machine

Durable task state is unchanged. Execution state is one bit per task generation:

```
        claimTask() accepted
              │
              ▼
     ┌─────────────────┐
     │  IN_PROGRESS    │   durable task state (unchanged)
     │  revision R     │
     └─────────────────┘
              │
     runTurn resolves normally
              │  ← the ONLY durable fact this design adds
              ▼
     attempt_returned(task, R)          ┌── reconciliation: NOT stranded
              │                          └── discovery: not eligible (IN_PROGRESS)
              │                                     │
              ▼                                     ▼
        IDLE forever (until something else changes the task)


     process dies at any point before the marker write
              │
              ▼
     no marker  →  reconciliation: STRANDED  →  revert to PENDING  →  re-dispatch
```

**Note the asymmetry that fixes 6D:** after a normal return the task is *not*
made ready, and the marker stops reconciliation from touching it. The two
mechanisms agree, so the task converges to IDLE rather than oscillating.

---

## 21. Crash matrix (V2)

| # | point | task row | attempt marker | recovery | duplicate | loss | certainty |
|---|---|---|---|---|---|---|---|
| 1 | before claim | unchanged | none | n/a | no | no | certain |
| 2 | claim accepted, before `runTurn` | `IN_PROGRESS` R | none | **stranded → revert → re-run** | **yes** | no | certain |
| 3 | during execution | `IN_PROGRESS` R | none | **stranded → revert → re-run** | **yes** | **possible** (partial side effects) | certain |
| 4 | `runTurn` resolved, before marker write | `IN_PROGRESS` R | none | **stranded → revert → re-run** | **yes** | possible | **uncertain — irreducible** (§15) |
| 5 | marker written | `IN_PROGRESS` R | `RETURNED` R | **not stranded → IDLE** | no | no | certain |
| 6 | after task completion (model/verifier) | `COMPLETED` | any | terminal, not a target | no | no | certain |
| 7 | verification pending | `VERIFYING` | `RETURNED` R | **not stranded** | no | no | certain |
| 8 | restart after unrelated mutation | unchanged | matches or predates | not stranded if marker present | no | no | certain |
| 9 | restart, no marker | `IN_PROGRESS` | none | stranded → re-run | yes | no | certain |

**Rows 5, 7, 8 are the ones 6C could not distinguish from 2-4. V2 can.**
Row 4 is the honest residue, and it is one durable write wide.

---

## 22. Liveness proof

**Claim:** for any task T, if T is selected, its execution returns normally, and
no external party changes T's task state, then the Scheduler performs **exactly
one** execution of T.

**Proof.**

1. Cycle *n* claims T. `claimTask` yields post-claim revision `R`, and T's status
   becomes `IN_PROGRESS`.
2. `runTurn` resolves. The Scheduler writes `attempt_returned(T, R)`.
3. The Scheduler clears `this.claim`. Task row: `status=IN_PROGRESS, revision=R`.
4. Cycle *n+1*:
   - **Reconciliation.** T is `IN_PROGRESS`. Marker exists with
     `attempt_revision == R == T.revision` ⇒ **NOT stranded** ⇒ no revert. ∎(a)
   - **Discovery.** `new TaskGraph(snapshot).readyTasks()` excludes T, because
     `IN_PROGRESS` is not in the eligible set `{PENDING, BLOCKED}` (design lock §8,
     5C.1-verified). ∎(b)
5. No other task changed, so no candidate exists. Cycle *n+1* returns `IDLE`.
6. By induction, every cycle ≥ *n+1* takes steps 4-5 identically. T is never
   selected again. ∎

**Therefore `T → T → T → …` is unreachable.** The liveness invariant is satisfied,
and it does not depend on the model cooperating, on a clock, or on a lease.

**The other permitted outcome is also explicit:** if something *else* moves T (a
verifier, an operator, the model via `todo_write`), T becomes selectable again
under entirely new justification. That is desired, and it is the only legitimate
source of re-execution.

**Reachable by a crash:** step 2 does not complete, so step 4(a) finds no marker
and reverts. That is the *intended* at-least-once path, and it terminates because
the redispatched attempt either records a marker or the process dies again.

---

## 23. Invariants

| # | invariant | proven by |
|---|---|---|
| **I19** | A normal Scheduler turn MUST NOT, by itself, cause re-execution of the same task generation. *Refined:* the absence of an `attempt_returned` marker for the current revision is the only admissible justification for re-execution. | §22, step 4(a) |
| **I20** | Reconciliation MUST NOT classify a completed execution as stranded merely because completion was not recorded. *Satisfiable in V2 via the marker; IMPOSSIBLE in V1 — §6 gives the byte-identical-row proof.* | §6, §12 |
| **I21** | The only durable fact this design adds is "an attempt reached its end". Nothing else is inferred. | §7 |
| **I22** | Reconciliation reverts only on positive evidence of absence. | §12 |
| **I23** | The marker is never read as task state and never implies correctness. | §11, §14 |
| **I24** | `EXECUTION ≠ VERIFICATION ≠ COMPLETION` — preserved. | §10, §14 |
| **I25** | No new `TaskStatus`; no new authority; no lease; no retry counter. | §19 |
| **I26** | LEGACY behaviour is unchanged, and this is provable rather than asserted. | §17 |
| **I27** | Model↔task **intent** remains unprovable. Recorded, not solved. | §13 |

---

## 24. Rejected alternatives

| rejected | reason | class |
|---|---|---|
| release to `PENDING` on return | provably reproduces the livelock | NEW ARCHITECTURE (rejected) |
| keep the claim in memory (ephemeral) | false evidence: passes tests, breaks restart | **NEW ARCHITECTURE (rejected)** |
| lease / heartbeat | no semantic consumer; second authority with a clock | **DEFERRED** |
| new `TaskStatus` "attempted" | no status means "attempted, unadjudicated"; touches the model | NEW ARCHITECTURE (rejected) |
| structured `runTurn` result | requires the agent loop; the Scheduler can observe the promise | NEW ARCHITECTURE (rejected) |
| agent-loop acknowledgement | frozen surface; unnecessary | NEW ARCHITECTURE (rejected) |
| journal-correlated attempt | `journal.turn` is "narrative, may be null"; no lifecycle; crosses the authority boundary | NEW ARCHITECTURE (rejected) |
| infer intent from files/tools/transcript | second inference authority; 6D proved correlation is unavailable | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| separate Scheduler database | breaks crash-consistency between task row and attempt record; adds a file authority | NEW ARCHITECTURE (rejected) |
| tighten completion ownership | not a prerequisite; product-semantics change | **NEW ARCHITECTURE (deferred, not required)** |

---

## 25. New architectural decisions

| # | decision |
|---|---|
| **D1** | Execution completion is recorded as **one durable marker**, not as a task status |
| **D2** | Reconciliation reverts **only** on positive evidence of no completed attempt |
| **D3** | A normal return leaves the task's status **untouched** |
| **D4** | The marker carries the **post-claim revision**, so a stale marker cannot mask a newer generation |
| **D5** | The marker is **TaskStore-owned, same database, additive table** — not a Scheduler DB |
| **D6** | `runTurn`, the agent loop, TaskGraph and `TaskStatus` are **unchanged** |
| **D7** | "At-least-once" is **withdrawn** as a description of 6C and redefined by its trigger |
| **D8** | Cross-process scheduling remains **unsupported**; the marker is not a lock |
| **D9** | Model↔task intent is **permanently unprovable** under prompt dispatch |

## 26. Deferred decisions

| # | decision | trigger to revisit |
|---|---|---|
| **DD1** | lease / heartbeat | two concurrent Scheduler processes per session become a requirement |
| **DD2** | cross-process ownership | same |
| **DD3** | attempt history (append-only, for duplicate counting) | an operator needs to answer "how many times did this run?" |
| **DD4** | retry policy / backoff | a task legitimately needs repeated attempts |
| **DD5** | stricter completion ownership | product decision, not an engineering one |
| **DD6** | eliminating the §21-row-4 window | only by transactionally coupling the agent turn to the DB, i.e. redesigning the loop |

---

## 27. Required implementation prerequisites

None beyond 6F's own scope. Explicitly: **no** lease, **no** heartbeat, **no**
retry counter, **no** new status, **no** agent-loop change, **no** Scheduler
database, **no** TaskGraph change, **no** TaskStore column change.

---

## 28. Implementation boundary for Phase 6F

**6F may touch, and only:**

| file | permitted change |
|---|---|
| `src/task/store.ts` | one additive `CREATE TABLE IF NOT EXISTS task_attempt (...)` in the existing DDL block, mirroring `task_meta`; two new methods `recordAttemptReturned(sessionId, taskId, attemptRevision)` and `getAttemptMarker(sessionId, taskId)` |
| `src/task/scheduler.ts` | write the marker immediately after `runTurn` resolves; read it in `reconcile()` and apply the §12 decision rule |
| `test/phase6f-*.test.ts` | new tests |

**6F MUST NOT touch:** `TaskStatus`, `graph.ts`, `graph-validate.ts`,
`readiness.ts`, `model.ts`, `runTurn`'s signature, the agent loop, `todo.ts`, MCP,
UI/TUI/ACP, presentation, executor internals, `vendor/minicore`, any frozen
surface in Phase 5D's list.

**6F MUST NOT** enable the Scheduler, add production wiring, or construct a
Scheduler outside tests.

---

## 29. Acceptance criteria for 6F

1. **The 6D reproduction converges to one execution** — 4 cycles, `runs == 1`.
2. A genuine crash (no marker) **still** recovers: stranded → revert → re-dispatch.
3. `IN_PROGRESS` with a matching marker is **never** reconciled.
4. A marker with `attempt_revision < task.revision` is treated as **not stranded**.
5. `attempt_revision > task.revision` **throws** rather than guessing.
6. Ownership uncertainty still **refuses** (6B behaviour preserved).
7. `COMPLETED` / `CANCELLED` / `FAILED` / `PENDING` / `BLOCKED` remain **untouched**.
8. LEGACY: `tsc`, lint, and the full suite show **no new** errors; 6B/6C/5C suites
   stay green.
9. `PAUSED` is never introduced; no new `TaskStatus`.
10. A **new mutation** removing the marker read is **killed** by a semantic test.
11. A **new mutation** removing the marker write is **killed** by a semantic test.
12. Production reachability stays **0**.

---

## 30. Final verdict

# GREEN (design) — 6F authorised, implementation NOT yet done

Every §29 acceptance criterion is met: the livelock is reproduced and explained,
the information gap is located and proven, normal-return semantics are resolved,
crash-vs-normal-return is resolved **with its exact impossibility boundary
stated**, correlation and task/execution state are separated, the reconciliation
policy is evidence-based, at-least-once is redefined by its trigger, a
convergence proof exists, the multi-process limitation stays explicit, completion
ownership is analysed and left alone, no new authority is hidden, no historical
behaviour is invented, the architecture is minimal, rejected alternatives are
documented, 6F's boundary is exact, and there are **0 source changes**.

**Explicitly: GREEN here does not mean "the defect is fixed."** The defect is
**documented and designed around**, not repaired. The Scheduler remains
**NO-GO for enablement** until 6F lands and criterion 29.1 is demonstrated.

**The one thing this design cannot deliver, stated plainly:** it can prove an
attempt *ended*. It cannot prove the model worked on the task it was told about.
That is not a gap to be closed in 6F — it is the nature of proposing work to a
model, and pretending otherwise would require an inference authority nobody
authorised.
