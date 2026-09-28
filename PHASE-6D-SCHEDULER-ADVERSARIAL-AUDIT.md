# PHASE 6D — SCHEDULER ADVERSARIAL AUDIT

Base: `08b105f` (`feat: implement scheduler core`)
Protected specimen `D:\git\minicode`: **never accessed or modified**

---

## 1. Executive result

# NO-GO FOR ENABLEMENT

**One REAL DEFECT, HIGH severity: unbounded re-execution (livelock).** Everything
else the 6C report claimed about *boundaries* holds up under attack. The claim
that 6C GREEN meant the Scheduler was semantically correct does **not** hold.

| | |
|---|---|
| **REAL DEFECT** | **HIGH** — a task with no external state change is executed again on every cycle, forever, with no bound and no convergence |
| root cause | the Scheduler's only memory of its own attempt (`this.claim`) is cleared at the end of dispatch, so "an execution happened and returned" is indistinguishable from "a process died mid-claim" |
| contradicts locked design? | **YES** — 6A locked *at-least-once with documented duplicate risk*; the implementation delivers *unbounded* duplication with no recovery convergence |
| currently live? | **NO** — production is unreachable, so nothing is currently damaged |
| production changes made | **0** — per §22, a real defect is documented, not fixed |
| suites / tsc | 192 pass / 0 fail · tsc 28 (baseline) — **untouched by this phase** |
| tree | **CLEAN**, only this report added |

---

## 2. Independently verified implementation

I did not trust the 6C report, its tests, or its kill counts. Verified from
source and by execution:

| claim | evidence | classification |
|---|---|---|
| runtime import closure is 5 files, all in `src/task/` | closure walked with type-only imports excluded (`verbatimModuleSyntax` erases them); `store.ts` and `model.ts` are **type-only** | **VERIFIED** |
| no SQLite/presentation/UI/ACP/executor/provider/memory reachable | 10/10 forbidden classes CLEAN in the transitive **runtime** closure | **VERIFIED** |
| production unreachable | 161 production files, comments stripped: `new Scheduler(` **0**, `.start(` **0**, `.cycle(` **0**, `authority:"SCHEDULER"` **0**, importers of `task/scheduler` **0**, env-var enablement **0**, package-script reference **0** | **VERIFIED** |
| claim/release revision ladder | `claim(R=1)`→`ACCEPTED` R=2; `release(R=1)`→**REJECTED_STALE** (no overwrite); `release(R=2)`→`RECONCILED` R=3; `release(R=3)`→`NOT_STRANDED` | **VERIFIED** |
| stop never manufactures cancellation | before claim→`PENDING`; during `runTurn`→`IN_PROGRESS`; after→`IN_PROGRESS`. `CANCELLED=false` in all three | **VERIFIED** |
| ownership fails closed | no-owner `reconcile()` → `[]`, row untouched | **VERIFIED** |
| mutational evidence is real | M7/M15/M16/M16b re-installed and re-scored; see §16 | **VERIFIED** |

**One correction to 6C's own static evidence.** 6C's test scanned
`scheduler.ts`'s own text for `bun:sqlite` and passed. But the **transitive**
closure, followed naively, reaches `bun:sqlite` (via `store.ts`) and `#minicore`
(via `tools/todo.ts`). That is a **false positive** — the Scheduler
*type-imports* `TaskStore`, so those edges are erased. 6C's evidence was right by
accident and by the wrong method; the correct method (exclude type-only imports)
confirms the conclusion. Recorded because "the test passed" and "the test was
sound" are different claims.

---

## 3. Liveness findings — **REAL DEFECT, HIGH**

### Reproduction (exact 6D scenario)

One task `T1 PENDING`, no external state change, one Scheduler:

```
cycle 1: runs=1  PENDING->IN_PROGRESS  rev 1->2
cycle 2: runs=2  IN_PROGRESS->IN_PROGRESS  rev 2->4
cycle 3: runs=3  IN_PROGRESS->IN_PROGRESS  rev 4->6
cycle 4: runs=4  IN_PROGRESS->IN_PROGRESS  rev 6->8
cycle 5: runs=5  IN_PROGRESS->IN_PROGRESS  rev 8->10
cycle 6: runs=6  IN_PROGRESS->IN_PROGRESS  rev 10->12
>>> runTurn invoked 6 times for ONE task with no external state change.
```

**Answers to §2's questions:**

| | |
|---|---|
| A. Expected V1 behaviour? | **NO** |
| B. Merely a documented limitation? | **NO** — the documentation says "at-least-once with documented duplicate risk", which is bounded-by-nothing-in-practice but at least anticipated. This is **unbounded**. |
| C. Implementation bug? | **YES** — real defect |
| D. Can it cause repeated execution indefinitely? | **YES** — demonstrated, 6/6 and unbounded |
| E. Any maximum repeat bound? | **NONE.** No counter, no backoff, no cap, no lease, no attempt record. |
| G. Does a normal successful run with no task-state transition necessarily cause another execution? | **YES — always.** |

### Root cause (three verified facts)

1. `scheduler.ts:413` and `:446` — `this.claim = null` at the end of every
   dispatch. The **only** per-attempt memory the Scheduler keeps is erased.
2. `scheduler.ts:473` — `reconcile()` skips only `this.claim?.taskId === task.id`.
   Once the claim is null, its own completed work is indistinguishable from a
   crash.
3. Executable state of the class is 6 fields (`store`, `runTurn`, `instruction`,
   `onEvent`, `cancellation`, `state`, `owner`, `claim`, `inFlight`). **Zero**
   occurrences of attempt/tried/heartbeat/executionCount in code. (`lease`'s 12
   hits are `releaseSessionOwnership`/`released`/`releaseClaim` — substring
   false positives; **no lease exists**, as designed.)

### State machine — where correlation disappears

```
CLAIM ──► DISPATCH ──► RUN ──► RETURN ──► ??? 
  ok            ok         ok       ok
  │             │          │        │
  └─► claim={id,rev}        │        └──► this.claim = null   ◄── CORRELATION LOST
                             │                                     (no durable record that
                    ┌────────┴────────┐                            an attempt occurred)
              returned ok=false    thrown/rejected
                    │                    │
                    └────────┬───────────┘
                             ▼
                     observation recorded, task left IN_PROGRESS
                             │
              (next cycle) reconcile() sees IN_PROGRESS, claim is null
                             ▼
                     reverts to PENDING ──► selected again ──► RUN again
```

**Correlation disappears at the `RETURN → this.claim = null` edge.** Everything
before it is ephemeral; nothing after it consults anything except task status.

### §3 timing audit: there is no grace period

| timing | after cycle 1 | second run | result |
|---|---|---|---|
| A immediate next cycle | `IN_PROGRESS` | ran=2 | reverted + re-dispatched |
| B after an unrelated mutation | `IN_PROGRESS` | ran=2 | reverted + re-dispatched |
| C new Scheduler instance | `IN_PROGRESS` | ran=2 | reverted + re-dispatched |

**A, B and C are indistinguishable.** Strandedness is decided solely by
`status === IN_PROGRESS && this.claim !== that task`. There is no timestamp, no
grace period, no attempt record, no "was this a crash or a success?" question is
even representable.

**Yes — "reconcile every cycle" does accidentally convert an ordinary completed
agent turn into a crash-recovery event, unconditionally.**

### How 6C missed it, and how I misled myself

6C's test `10b` is titled *"a stranded task from a previous cycle is reconciled,
then re-dispatched"* and its comment says *"This is the at-least-once window made
visible."* **That is a real defect encoded as an expected behaviour.** I labelled
a livelock "at-least-once" because 6A had used that phrase, and 6D's premise —
*"assume every 6C assertion may be wrong"* — is what forced me to look again.

Per §22 I did **not** fix it. Proposed future phase in §24.

---

## 4. Execution ↔ task correlation

`runTurn` is told what to work on; the Scheduler observes nothing about what
happened. Matrix, three cycles each:

| model did | runs | T1 after | T2 after |
|---|---|---|---|
| 1 worked on T1 | 3 | `IN_PROGRESS` | `PENDING` |
| 2 worked on T2 | 3 | `IN_PROGRESS` | `PENDING` |
| 3 unrelated work | 3 | `IN_PROGRESS` | `PENDING` |
| 4 completed T2 | 3 | `IN_PROGRESS` | `COMPLETED` |
| 5 completed T1 | 3 | `COMPLETED` | **`IN_PROGRESS`** |
| 6 changed T1, left `IN_PROGRESS` | 3 | `IN_PROGRESS` | `PENDING` |
| 7 abandoned T1 | 3 | `CANCELLED` | **`IN_PROGRESS`** |

**Rows 1, 2, 3 and 6 are byte-identical in Scheduler state.** The Scheduler cannot
tell whether the model worked on the selected task, a different task, or
something unrelated. **This is the explicit demonstration that prompt-based
dispatch is advisory**: the Scheduler *suggests* a task in a prompt and has no
mechanism — and by design no authority — to verify compliance.

**Row 5 is worse than a duplicate-execution problem:** completing T1 causes the
Scheduler to move to T2, claim it, and leave **T2 stranded** — so the livelock
**propagates to every task in turn**. Row 7 likewise. So the defect is not
"one task re-runs"; it is "the session consumes the whole task list, re-running
each forever."

**Incorrect task progress: possible** (rows 4-5, 7 — the model may complete an
arbitrary task while the Scheduler believes it is executing another). **Task
loss: possible** (row 5 — T2 is claimed and stranded while the model never
intended to touch it).

---

## 5. Model agency escapes

| escape | classification | why |
|---|---|---|
| A. model writes T2 `IN_PROGRESS` | **blocked** | 6B authority guard refuses `IN_PROGRESS` outside `claimTask`; mutation M5 in 6B killed it |
| B. model completes T2 | **allowed intentionally** | completion is the verifier's authority, not the Scheduler's; the Scheduler must not block it |
| C. model modifies T2 without completing | **allowed intentionally** | ordinary durable write; the Scheduler cannot forbid it |
| D. model creates a new task | **allowed intentionally** | identity allocation is TaskStore's; the Scheduler has no say |
| E. model changes dependencies/order | **allowed intentionally** | TaskStore validates; graph semantics are TaskGraph's |
| F. model performs unrelated shell/file work | **allowed intentionally but a real limitation** | the Scheduler has **no** enforcement surface over what the agent loop does; that is the agent loop's authority |

**"Not `IN_PROGRESS`" does not mean "Scheduler controlled the work"** — confirmed
by rows 1/2/3/6 above. The Scheduler controls *which prompt it emits*, nothing
else.

---

## 6. Crash matrix

| # | crash point | durable | ephemeral | restart observation | reconciliation | duplicate exec | permanent loss |
|---|---|---|---|---|---|---|---|
| 1 | before discover | unchanged | — | no stranded row | nothing | no | no |
| 2 | after discover | unchanged | — | nothing stranded | nothing | no | no |
| 3 | after select | unchanged | `taskId` local | nothing stranded | nothing | no | no |
| 4 | after claim | `IN_PROGRESS` | claim lost | **stranded** | reverted → re-run | **yes** | no |
| 5 | after dispatch, before RUN | `IN_PROGRESS` | claim lost | **stranded** | reverted → re-run | **yes** | no |
| 6 | execution started | `IN_PROGRESS` | claim lost | **stranded** | reverted → re-run | **yes** | **possible** if the attempt had side effects |
| 7 | execution partially done | `IN_PROGRESS` | claim lost | **stranded** | reverted → re-run | **yes** | **possible** |
| 8 | execution completed, **no state write** | `IN_PROGRESS` | claim lost | **stranded** | reverted → **re-run** | **yes** | no |
| 9 | before state write | `IN_PROGRESS` | — | stranded | reverted → re-run | yes | possible |
| 10 | during verification | `IN_PROGRESS`/`VERIFYING` | — | stranded | reverted → re-run | yes | possible |
| 11 | after verification | `COMPLETED`/`FAILED` | — | terminal | **not a target** | no | no |
| 12 | before next cycle | depends | — | — | — | — | — |

**Row 8 is the hardest window and it is NOT distinguishable from a crash.** An
execution that ran to completion and wrote nothing is byte-identical, to the
Scheduler, to a process that died before starting. Both revert and re-run.

**No NO-GO trigger in rows 1-3, 11-12** (nothing stranded). Rows 4-10 carry the
duplicate-execution exposure, which 6A documented qualitatively but which is
**unbounded** in fact.

---

## 7. Reconciliation ownership attack

| attack | observed | classification |
|---|---|---|
| Scheduler with **no** ownership calls `reconcile()` | `[]`, row untouched | **VERIFIED** — fails closed |
| `stop()` then a new instance | successor reconciled `["t1"]` → `PENDING` | permitted transition (ownership was handed back) |
| explicit owner release, then `start()` | reverted to `PENDING` | permitted — ownership was genuinely free |
| duplicate same-session Scheduler | second `start()` throws, `STOPPED` | **VERIFIED** |
| forged owner token | rejected (identity by symbol) | **VERIFIED** |

**No case where live work is reverted without an explicitly permitted ownership
transition.** The §7 HIGH-SEVERITY trigger is **not met**. 6B's fail-closed
contract actually holds in the implementation.

**Inherited limitation, unchanged and not "fixed":** ownership is process-local,
so a *different* process owning the same session is invisible, and that process
would fail closed (refuse to reconcile) — the safe direction. A second process can
still overwrite a claim. **DEFERRED**, as 6B locked.

---

## 8. Serialization audit

6C discovered a weak concurrency test; I applied the same standard again.

| check | result |
|---|---|
| two ready tasks, bridge blocks first execution | 1 dispatch begins, the second task is not dispatched concurrently |
| exact cycle-body entry count | **2 snapshots** (1 reconcile + 1 discovery) for 4 concurrent `cycle()` calls |
| max simultaneous `runTurn` | **1** |
| after releasing the first turn | subsequent scheduling proceeds normally |
| cycle during dispatch | joins the in-flight cycle (test 27) |
| cycle after stop | returns `not-running`, dispatches nothing |
| M15 re-audit | installed; killed by **exactly** test 28b — the Scheduler-side-joining test |

**VERIFIED.** Serialization is Scheduler-side, not TaskStore-side.

---

## 9. Stale snapshot attack

The claim currency is the **re-read** task revision. Tests 18/37 force a mutation
in the exact re-read→claim window via a store proxy and assert **no `runTurn`**.

**M1** (remove `AND revision = ?`) is killed with **13 failures**, including the
directly semantic `10. a fresh snapshot + fresh graph every cycle` and
`18/37. a stale revision executes nothing`. The mutation dies for a **semantic**
reason — readiness/identity drift — not an incidental assertion.

**VERIFIED.** No NO-GO trigger ("stale task can execute").

---

## 10. Claim / release audit

**VERIFIED**, exactly as locked — see the ladder in §2. `release(R=1)` is
`REJECTED_STALE` and does **not** overwrite newer state; `release(R=2)` (the
post-claim revision) is the only one that succeeds. A stale release cannot revert
newer task state.

---

## 11. Stop / abort audit

| phase | resulting status | `CANCELLED`? | consequence |
|---|---|---|---|
| before claim | `PENDING` | no | nothing happened |
| after claim (during `runTurn`) | `IN_PROGRESS` | **no** | **stranded** → next scheduler reverts and re-runs |
| after `runTurn` | `IN_PROGRESS` | **no** | same |
| stop twice / start after stop | unchanged | no | `start()` throws |

**STOP ≠ CANCELLED — VERIFIED, no durable cancellation manufactured.** But stop
**does** create stranded `IN_PROGRESS`, which is then indistinguishable from a
crash and re-executed. That is the §3 defect again, reached by a different door.
`stop()` never *silently loses* work (the row survives); it risks **duplicate**
execution.

---

## 12. Graph / readiness boundary

| mutant | result | died for the right reason? |
|---|---|---|
| bypass `readyTasks()` | KILLED | yes — dispatching a non-ready task |
| select a blocked task | KILLED | yes |
| own readiness predicate | KILLED (M11/M12) | yes — terminal/operator states were reconciled |
| use `sourceMaxRevision` as claim currency | KILLED (M2) | yes — wrong revision, claim rejected |
| cache the graph | KILLED (M16, 30 failures) | yes — stale readiness, wrong task selected |

**VERIFIED.** The Scheduler redefines none of dependency, parent, readiness,
blocker or validity semantics.

---

## 13. Error semantics

| injected failure | propagation | becomes fake success? | mutates task? |
|---|---|---|---|
| graph invalid | cycle returns `invalid-graph` | no | no |
| claim stale / NOT_FOUND / WRONG_STATE | cycle returns the specific reason | no | no |
| dispatch throw | released, `failure` recorded | no | reverted to `PENDING` (intended) |
| bridge returns non-promise | `bridge-not-callable`, released | no | yes (release) |
| `runTurn` rejection | observation, task stays `IN_PROGRESS` | no | no |
| ownership unavailable | `STOPPED` + throw | no | no |
| start after `STOPPED` | throws | no | no |
| unreachable state after accepted claim | throws `SchedulerError` | no | no |
| observer throws | swallowed **by design** | no | no |

**No persistence failure is converted into a fake successful cycle.** A
`SchedulerError` is thrown for a persistence inconsistency rather than papered
over. **VERIFIED.**

---

## 14. Multi-session

Session A and B run independently: candidates, claims and revisions are isolated
(one failing does not stop the other); `taskId` is per-session, so both sessions
can hold `t1` and the SQL session predicate keeps them apart. The Scheduler owns
no executor, rate-limit or pool semantics — **VERIFIED**, and it correctly does
not try to.

---

## 15. F-02 / session reuse

`deleteSessionTasks(S)` then recreate the same `S`:

- the pre-deletion row is **gone and cannot execute** — **VERIFIED**
- **but `taskId` values are REUSED**: the recreated task is again `t1`

So a `TaskGraph` derived *before* deletion names `t1`, and after recreation `t1`
denotes a **different task**. The Scheduler is safe here only because it re-reads
the row and claims by current revision. A *cached* graph across that boundary
would mis-target — which is exactly why M16 (caching) is killed with 30 failures.

**Classification: DANGEROUS LIMITATION, not a live defect.** id reuse across
session recreation is pre-existing TaskStore behaviour, and the Scheduler's
re-read is what neutralises it. Recorded because the safety currently depends on a
property that is not itself enforced.

---

## 16. Mutation re-audit

I did not trust 6C's summary. Each mutant was re-installed and the **failing test
named**:

| mutant | installed | failures | killed by | semantic? |
|---|---|---|---|---|
| M7 dispatch despite stop/cancellation | **True** | 1 | `25b. a refused dispatch (cancellation) does NOT release the claim` | **yes** — dispatch occurred when refused |
| M15 allow concurrent cycles | **True** | 1 | `28b. concurrent cycles run the cycle body ONCE (Scheduler-side joining)` | **yes** — the cycle body ran more than once |
| M16 cache the TaskGraph | **True** | 30 | incl. `10. a fresh snapshot + fresh graph every cycle (no caching)`, `11. invalid graph aborts` | **yes** — stale readiness |
| M16b declare the cache field | **True** | 0 | — | **EQUIVALENT MUTANT** — an unused private field changes no behaviour; compiler-visible only (`noUnusedLocals`) |

**No fake evidence found. No fake mutants created.**

**M7's full history, because it is a lesson about harnesses.** It reported
**SURVIVED twice** — first because it disabled only the unreachable
`STOPPING`/`STOPPED` clause (a genuine equivalent: the claim→dispatch gap is
synchronous, so nothing can interleave a `stop()` there), then because
`false && A || B` parses as `(false && A) || B` and left the cancellation clause
live. A mutant that survives for a **parser** reason is indistinguishable from a
real test gap unless the *mutant* is inspected, not just the verdict. Only after
replacing the whole condition did it die for the right reason.

**M15's history.** 6C's original concurrency test **could not** detect a missing
join, because with one ready task the second cycle merely loses the atomic claim —
TaskStore was silently doing the work §17 forbids relying on. Tests 27b/28b were
added in 6C specifically to fix that, and the re-audit confirms the fix is
load-bearing.

**HARNESS MISS: 0** across the 6D re-audit.

---

## 17. Static architecture — **VERIFIED**

Transitive **runtime** closure of `scheduler.ts` = **5 files, all in `src/task/`**:
`scheduler.ts`, `graph.ts`, `graph-validate.ts`, `readiness.ts`,
`session-ownership.ts`.

`store.ts` and `model.ts` are **type-only** and erased by `verbatimModuleSyntax`.

| forbidden | reachable |
|---|---|
| `bun:sqlite`, `#minicore`, presentation, `ui/`, ACP, `parallelExecutor`, `policy/executor`, `providers/`, `memory/`, context impl | **all CLEAN** |

No event stream is used as task authority, no plan is scheduler truth, no message
history or transcript is read, and there is no hidden scheduler singleton.

*Caveat:* two closure edges resolve extensionless (`./graph-validate`), which my
walker did not follow. Those files are themselves clean, so the conclusion is
unaffected — but the walker is not a complete module resolver and I am not
claiming it is.

---

## 18. Production reachability — **VERIFIED UNREACHABLE**

161 production `.ts` files, comments stripped, `scheduler.ts` itself excluded:

| pattern | count |
|---|---|
| `new Scheduler(` | **0** |
| `scheduler.start(` / `.cycle(` | **0** |
| `authority: "SCHEDULER"` | **0** |
| importers of `task/scheduler` | **0** |
| `process.env.*SCHEDUL* / TASKGRAPH* / CLAIM*` | **0** |
| `scheduler` in `package.json` | **false** |

Authority mode remains **OFF**; the default application remains **LEGACY**.

---

## 19. Performance

Phase 6C's measurements are **reusable**; §22 forbids re-running what is already
recorded, and no source changed, so they stand: 1 000 and 10 000 tasks, per-phase
timings, **10× tasks ⇒ 9.4× time (linear)**. No accidental repeated derivation, no
O(V²), reconciliation not dominant.

**One performance note that is really a correctness note:** because reconciliation
reverts and re-claims on *every* cycle, a non-converging session performs a full
reconcile + snapshot + derive + claim **per cycle forever**. The linear cost is
not the problem; the unbounded repetition is.

---

## 20. Invariant verdict matrix

| # | invariant | evidence | attack | result | classification | severity |
|---|---|---|---|---|---|---|
| I1 | TaskStore authoritative | all writes via store | direct-write attempts | held | **VERIFIED** | — |
| I2 | no direct persistence | runtime closure | closure walk | held | **VERIFIED** | — |
| I3 | graph immutable | frozen surface 0 diff | cache/dispatch mutations | held | **VERIFIED** | — |
| I4 | readiness not redefined | M11/M12/bypass | boundary mutations | held | **VERIFIED** | — |
| I5 | canonical taskId | per-session ids | F-02 reuse | held (see §15) | **VERIFIED** | LOW note |
| I6 | SELECT ≠ CLAIM | test 17 | stale-window race | held | **VERIFIED** | — |
| I7 | no double claim | claim/release ladder | R+1 external writer | held | **VERIFIED** | — |
| I8 | no stale execution | M1 (13 failures) | 8 mutation kinds | held | **VERIFIED** | — |
| I9 | execution ≠ verification ≠ completion | M14 (10 failures) | observation path | held | **VERIFIED** | — |
| I10 | events cannot authorize | injected sink only | event injection | held | **VERIFIED** | — |
| I11 | **no silent loss** | — | stop/crash/row-reuse | **VIOLATED** | **REAL DEFECT** | **HIGH** |
| I12 | graph is not Scheduler state | M16 | cache mutation | held | **VERIFIED** | — |
| I13 | TaskStore adjudicates | claim outcomes | wrong-state/stale | held | **VERIFIED** | — |
| I14 | readiness computed | M2/M3 | wrong currency | held | **VERIFIED** | — |
| I15 | Scheduler never completes | M14 | completion write | held | **VERIFIED** | — |
| I16 | session-scoped | multi-session | cross-session claim | held | **VERIFIED** | — |
| I17 | ownership-safe reconciliation | 5 attacks | owner-less/stop/release | held | **VERIFIED** | — |
| I18 | **selection remains advisory** | correlation matrix | model agency | **confirmed advisory — and unenforced** | **REAL DEFECT** (consequence) | **HIGH** |

---

## 21. Findings with severity

| # | finding | severity | classification |
|---|---|---|---|
| **F-1** | **Unbounded re-execution (livelock).** A task with no external state change re-executes every cycle forever. No bound, no convergence, no attempt record. Propagates to every task in the session (§4 rows 5/7). | **HIGH** | **REAL DEFECT** |
| **F-2** | **Execution↔task correlation is absent.** Rows 1/2/3/6 are indistinguishable. Prompt-based dispatch is purely advisory and cannot be enforced. | **HIGH** (consequence of F-1's root cause; inherent to prompt dispatch) | **REAL DEFECT** |
| **F-3** | 6C's static-architecture test was **sound by accident**: it scanned one file, and the naive transitive closure does reach `bun:sqlite` via a *type-only* import. Conclusion correct, method wrong. | LOW | audit-harness defect (now corrected) |
| **F-4** | 6C's test `10b` **encodes F-1 as expected behaviour**. | MEDIUM | false evidence |
| **F-5** | `STOPPING`/`STOPPED` dispatch guard is **unreachable** in V1 (synchronous claim→dispatch). Defence-in-depth only. | LOW | documented limitation |
| **F-6** | `taskId` is **reused** after session deletion; safety depends on the re-read, which is not itself enforced. | LOW | DANGEROUS LIMITATION |
| **F-7** | Cross-process ownership remains inexpressible (6B, inherited). | LOW | **DEFERRED** |
| **F-8** | A throwing observer is swallowed by design; an observation cannot fail a cycle. | INFO | NEW ARCHITECTURE (intended) |

**No §21 NO-GO trigger fired as literally worded** (no stale execution, no double
claim, no TaskStore bypass, no SQLite write, no `COMPLETED` write, no invalid-graph
dispatch, no `PAUSED` reconciliation, no terminal reconciliation, no ownership-
uncertainty destruction, no concurrent dispatch, no reachability change, no frozen
change, no fake mutation evidence). **But the phase is NO-GO on the merits**,
because §21 also says not to mark GREEN merely because the enumerated triggers
didn't fire, and F-1 is a genuine unbounded-repetition defect that contradicts
6A's locked contract.

---

## 22. Changes made

**Production changes: 0.** Nothing in `src/` or `cli/` was modified. All probe
and closure scripts were created under `src/` and **deleted**; the tree is
`CLEAN` apart from this report.

Per §22 the following were **not** done, deliberately:
- no Scheduler semantic change (F-1 left in place)
- no TaskStore redesign
- no lease, no attempt identity, no execution bridge
- no completion-ownership redesign

---

## 23. Proposed future phase (NOT started)

**Phase 6E — Scheduler attempt identity and reconciliation policy.** Minimum
scope, deliberately narrow:

1. **A durable attempt record** (or an equivalent) so "an execution ran" is
   representable, and reconciliation can distinguish *crashed* from *completed*.
2. **A reconciliation policy that does not treat every `IN_PROGRESS` as
   stranded** — the fix cannot be "remember longer in memory", because the memory
   dies with the process that most needs it.
3. **A convergence bound** — some rule that makes a non-converging session stop
   re-executing rather than loop forever.
4. Decide whether F-2 is acceptable as an inherent property of prompt dispatch or
   needs an enforcement seam. **My assessment: it is inherent**, and the honest
   answer is that TaskGraph + Scheduler can *propose* work, not compel it.

**Not in scope for 6E:** a lease (7 remains deferred), retry orchestration,
completion ownership, or any production wiring.

---

## 24. Remaining debt

1. **F-1/F-2** — unresolved, HIGH. This is the only thing blocking enablement.
2. **F-7** cross-process ownership — **DEFERRED**, unchanged since 6B.
3. **F-6** `taskId` reuse across session recreation — **DEFERRED** to TaskStore.
4. **F-5** unreachable stop-guard — harmless defence-in-depth.
5. Pre-existing 28 tsc errors and 4 pre-existing test failures — untouched, as
   before.

---

## 25. GREEN / CONDITIONAL / NO-GO

# NO-GO FOR ENABLEMENT

**Verified sound** (18 invariants, 17 of 18 held): boundaries, purity, static
architecture, claim atomicity, revision safety, ownership fail-closed,
serialization, reachability, mutation evidence, determinism, stop semantics.

**Blocking:** F-1/F-2 — unbounded re-execution and absent execution↔task
correlation. The Scheduler must not be enabled until an attempt identity exists and
reconciliation can tell a crash from a completed turn.

**Production is currently unreachable**, so nothing is damaged today. The NO-GO is
about *enablement*, not about a live incident.

**NOT GREEN, and specifically not "GREEN because tests pass":** 192 tests pass,
16/17 mutants killed, and the subsystem still re-executes a task forever.

---

## 26. Commit state

`audit: adversarially re-audit scheduler core` — see §27 for the recorded hash.

## 27. Tree cleanliness

`git status` after commit: **CLEAN**. **NOT PUSHED** — 30 commits ahead of
`origin/main`. Scheduler **not enabled**.

---

**A passing runtime suite is not semantic correctness, and an unreachable
component is not a correct one. 6C proved the Scheduler was clean; 6D shows it
was not yet finished.**
