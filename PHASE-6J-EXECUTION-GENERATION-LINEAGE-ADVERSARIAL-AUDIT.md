# PHASE 6J — EXECUTION GENERATION LINEAGE ADVERSARIAL AUDIT

Base: `016efa7` (`feat: separate execution generation from task revision`)
**AUDIT ONLY. 0 source changes, 0 schema changes, 0 test changes.**

---

## 1. Executive result

# NO-GO

Phase 6I's **lineage model is sound and 6G's D1/D2 are genuinely closed**. But
6J found **two defects that 6I introduced or failed to see**, one of them
product-breaking for any existing installation.

| id | finding | severity |
|---|---|---|
| **D3** | **A pre-6I database cannot create a task at all.** `CREATE TABLE IF NOT EXISTS` cannot add columns to an existing table, so `exec_generation`/`attempt_generation` are never created — and `createTask` names them, so it throws. `createTask` is on the **LEGACY** path, so this breaks the product **with the Scheduler still disabled** | **HIGH — product-breaking** |
| **D4** | **Production `deleteSession` never deletes task rows.** `deleteSessionTasks`/`deleteTask` have **zero production callers**. Deleting a session and recreating the same ID leaves the old tasks, which a Scheduler then **selects and executes**. 6H §7's premise ("delete removes the row") is falsified | **HIGH — F-02 realized** |
| **D5** | The **active-claim exemption is untested.** Mutant M13 removes it, real harm follows (a live task is reverted to `PENDING`), and **no test in the suite notices** | **MEDIUM — coverage gap** |

**D3 and D4 each map to a 6J NO-GO condition** (§32: "old DBs remain readable",
"two-database delete failure understood"). D3 additionally contradicts 6I's own
report §5 and acceptance criterion "old DBs remain readable".

**What 6J confirmed as genuinely correct** — and this is most of the work:

| | |
|---|---|
| D1 closed, both forms | **VERIFIED** |
| D2 closed for row deletion | **VERIFIED** |
| lifecycle matches 6H exactly | **VERIFIED** against raw SQLite |
| active G2 never recovered; stranded G2 always recovered | **VERIFIED** across all 6 sub-cases |
| normal-return vs crash distinguishable **on lineage alone** | **VERIFIED** — identical status *and* revision, opposite decisions |
| revision isolation | **VERIFIED** — 5 mutation kinds, generation never moves |
| Route A/B discriminating pair | **VERIFIED** — opposite decisions from `exec`/`attempt` alone |
| reconciliation atomicity, all races | **VERIFIED** |
| mutation | **15/16 killed, 1 survivor characterised (D5)** |
| property testing | **400 seeds, 18 691 checks, all hold** |
| static closure, enablement | **CLEAN / zero reachability** |

---

## 2. Historical D1/D2 reproduction — **HISTORICAL DESIGN EVIDENCE**

Reproduced from a **throwaway git worktree at `717046b`** (pre-6I), not from a
report. Confirmed the historical source: `task_attempt` DDL present,
`exec_generation` absent (0), `getAttemptMarker` present, and the scheduler's
`marker.attemptRevision > task.revision` comparison present.

```
PRE-6I CODE (git 717046b)
  G1 claim+return   : status=IN_PROGRESS rev=2 marker={"attemptRevision":2}
  ordinary mutation : rev=3  marker still {"attemptRevision":2}
  D1 form1          : recovered=[]  final status=IN_PROGRESS  totalRuns=1
  => D1 WEDGED: true

  D2: old incarnation marker {"attemptRevision":6}
     recreated same taskId t1 (same id=true)  INHERITED marker={"attemptRevision":6}
     reconcile THREW: attempt marker revision 6 exceeds task t1 revision 2
```

Against 6I, the same sequences:

| sequence | 6I result |
|---|---|
| D1 form 1 (post-return mutation) | lineage unchanged `(1,1)`; `recovered=[]`; `runs=1`; **not** a wedge — the evidence is still *current* |
| D1 form 2 (G1 done, G2 crashed) | lineage `(2,1)`; `recovered=["t1"]` — **G2 recovered** |
| D2 (delete row, recreate same id) | recreated row `(0,null)`; no inherited evidence; crash recovered; **no throw** |

The worktree was removed and pruned.

---

## 3. Generation lifecycle — **VERIFIED against raw SQLite**

Read from `tasks.db` directly, not through the API.

| step | status | revision | exec_gen | attempt_gen | 6H says |
|---|---|---|---|---|---|
| initial | `PENDING` | 1 | 0 | NULL | R0 / 0 / NULL — **match** |
| G1 claim | `IN_PROGRESS` | 2 | 1 | NULL | R1 / 1 / NULL — **match** |
| G1 normal return | `IN_PROGRESS` | 2 | 1 | 1 | R1 / 1 / 1 — **match** |
| G2 legitimate claim | `IN_PROGRESS` | 4 | 2 | 1 | R2 / 2 / 1 — **match** |
| G2 normal return | `IN_PROGRESS` | 4 | 2 | 2 | R2 / 2 / 2 — **match** |

| column | type | notnull | default |
|---|---|---|---|
| `exec_generation` | INTEGER | 1 | 0 |
| `attempt_generation` | INTEGER | 0 | null |

Tables present: `["tasks","task_meta"]` — `task_attempt` gone.

**One documented difference:** 6H's table used abstract `R1`/`R2`. The observed
G2 revision is **4**, not 3, because the requeue (`PENDING`) is itself a mutation
that advanced 2→3 before the claim. This is exactly the point of the phase:
revision moves for reasons unrelated to execution, which is why it cannot be the
generation.

---

## 4. Active-generation semantics — **VERIFIED (all six sub-cases)**

The critical state: **G1 completed, G2 claimed, G2 not yet returned** ⇒
`exec=2, attempt=1`, so `attempt < exec`.

| # | scenario | result | verdict |
|---|---|---|---|
| A | same Scheduler, G2 actively executing (deferred bridge) | `recovered=[]`, status `IN_PROGRESS` | **active-claim exemption holds** |
| B | fresh Scheduler B, same process | `start()` **refused**, `recovered=[]` | **ownership gate holds** |
| C | predecessor **crashed**, fresh takes over | `recovered=["t1"]` | **recovery CORRECT** — G2 is genuinely stranded |
| D | store called with `ownsSession:false` | `REFUSED_NO_OWNERSHIP` | **fails closed** |
| E | `attempt == exec` (G2 returned) | `recovered=[]` | **not recovered** |
| F | after process crash | identical to C | **recovered** |

**A currently-active generation is never recovered merely because
`attempt < exec`.** The distinction is carried by two independent mechanisms:
the in-memory active claim (same process) and process liveness (across restart).
Neither is a heuristic and neither consults a clock.

**But the active-claim exemption is load-bearing and untested — see D5.**

---

## 5. Reconciliation semantics — **VERIFIED**

```
two reconcilers, same generation : A=RECONCILED  B=REJECTED_STALE
  revision 2 -> 3, single increment      : double increment avoided
reconciler acting on a stale revision     : REJECTED_STALE, exec=2 preserved
evidence then reconcile (order A)         : NOT_STRANDED
reconcile then late evidence (order B)    : RECONCILED, late write accepted,
                                            final (exec=1, attempt=1, rev=3) - self-heals
claim with stale revision after mutation  : CLAIM_REJECTED_STALE
mutation after a successful claim         : exec_generation unchanged
```

Order B deserves a note: a late completion record can land on an
already-recovered task because recovery does **not** advance `exec_generation`.
That is harmless — the record names generation 1 while the next claim creates
generation 2, so the stale record can never protect anything. Verified
self-healing, not assumed.

Two **independent TaskStore handles** over one database:

| race | result |
|---|---|
| two claims, same expected revision | `CLAIM_ACCEPTED` / `CLAIM_REJECTED_STALE`; `exec_generation = 1` (**not 2**) |
| two recoveries, same generation | `RECONCILED` / `REJECTED_STALE`; single revision increment |

---

## 6. Restart semantics — **VERIFIED (the central distinction)**

| sequence | lineage | outcome | expectation |
|---|---|---|---|
| A: G1 completed, restart | `(1,1)` | `recovered=[]` | NO recovery — **holds** |
| B: G2 claimed, destroyed before evidence | `(2,1)` | `recovered=["t1"]` | RECOVERY — **holds** |
| 3: G2 claimed, died before execution began | — | recovered, then re-ran to `(3,3)` | recovery — **holds** |
| 4: G2 returned + recorded, then died | `(2,2)` | `recovered=[]` | NO recovery — **holds** |

---

## 7. Normal return vs crash — **VERIFIED, the decisive pair**

| | CASE A (returned, recorded) | CASE B (disappeared) |
|---|---|---|
| status | `IN_PROGRESS` | `IN_PROGRESS` |
| **revision** | **4** | **4** |
| lineage | `{exec:2, attempt:2}` | `{exec:2, attempt:1}` |
| reconcile | `[]` | `["t1"]` |

**Status identical. Revision identical. Only the lineage differs — and
reconciliation makes opposite decisions.**

This is the strongest single result in the audit: the normal-return/crash
distinction is carried *entirely* by `exec`/`attempt`, with **no timing
heuristic, no revision, and no marker**. It is not merely "distinguishable" —
it is distinguishable *by the single quantity the design added*.

---

## 8. Revision isolation — **VERIFIED**

```
after claim + record        rev=2  exec=1  attempt=1
after title write           rev=3  exec=1  attempt=1  moved=false
after order write           rev=4  exec=1  attempt=1  moved=false
after dependency write      rev=5  exec=1  attempt=1  moved=false
after blockedReason write   rev=7  exec=1  attempt=1  moved=false
after evidence write        rev=8  exec=1  attempt=1  moved=false
after verification write    rev=9  exec=1  attempt=1  moved=false
reconcile after all mutations []
```

**revision ≠ execution generation.** Proven, not assumed.

---

## 9. Route A / Route B discriminating proof — **VERIFIED**

| route | lineage | reconcile | correct |
|---|---|---|---|
| A: G1 returns, then 2 ordinary mutations | `{exec:1, attempt:1}` | `NOT_STRANDED` | yes |
| B: G1 returns, requeue + new claim, crash | `{exec:2, attempt:1}` | `RECONCILED` | yes |

**The two routes are distinguished by `exec`/`attempt` alone.** Under 6F these
two histories were byte-identical to every comparator and no rule could be
correct (6H §4.1). Under 6I they are different states producing **opposite**
decisions. The impossibility is dissolved, and 6J re-ran the experiment
independently rather than trusting 6H's conclusion.

---

## 10. Multiple generation semantics — **VERIFIED**

G1 → G2 → G3 all complete: `exec=3, attempt=3`, strictly increasing. A G3 claim
left unrecorded gives `(3, 2)` and is recovered — **G2's evidence does not
protect G3**. G1's evidence does not protect G2 or G3.

**Is the single retained record sufficient?** Yes, and this is a proof, not an
intuition. The only question reconciliation ever asks is *"did the generation
that is **current right now** complete?"* That is exactly
`attempt_generation == exec_generation`. No consumer asks about any *past*
generation, so retaining one record loses nothing. No history is needed and none
was added.

---

## 11. Delete / recreate — **VERIFIED for row deletion**

| variant | result |
|---|---|
| delete task, recreate same id | `(0, null)`; no inherited evidence |
| claim + crash the recreated task | recovered, **no throw** |
| 6F-era `task_attempt` row present with a hostile value | ignored; lineage correct; reconciliation unaffected |

Inspected with **raw SQLite** before and after, per the brief.

**But this only covers deleting the ROW. Production never does — see D4.**

---

## 12. Partial delete failure — **REAL DEFECT (D4), HIGH**

### 12.1 Production `deleteSession` never touches `tasks.db`

```
$ git grep -n "deleteSessionTasks\|deleteTask(" -- src cli scripts
  src/task/store.ts:968:  deleteTask(...)        <- definition only
  src/task/store.ts:982:  deleteSessionTasks(...) <- definition only
```

**Zero production callers.** `deleteSession` in `src/session/persistence.ts`
deletes `messages`, `turns`, `presentation_events` and `sessions` from the
**session database**, then best-effort removes the journal file and checkpoints.
It never opens `tasks.db`.

`src/tools/todo.ts:124` asserts in a comment that *"deleteSession wajib
menghapusnya"* (deleteSession must delete it) — the invariant is **documented but
not implemented**. `deleteSessionTasks` is dead code with a test
(6C test 36) that only proves reconciliation never deletes.

### 12.2 End-to-end reproduction, raw SQLite

```
lineage before delete          {"execGeneration":1,"attemptGeneration":1}
deleteSession(SID) called      COMPLETED
RAW tasks.db rows after delete [{"session_id":"reuse-me","task_id":"t1","status":"IN_PROGRESS","revision":3,"exec_generation":1,"attempt_generation":1}]
task row survived?             true
```

And with tasks left `PENDING` (the realistic un-run todo):

```
tasks before delete                 t1:PENDING, t2:PENDING
  lineage of t1 (ran once)          {"execGeneration":1,"attemptGeneration":1}
  lineage of t2 (never ran)         {"execGeneration":0,"attemptGeneration":null}
deleteSession completed             yes
RAW tasks.db after delete           [{"task_id":"t1","status":"PENDING",...,"exec_generation":1,"attempt_generation":1},
                                     {"task_id":"t2","status":"PENDING",...}]
recreated session sees              2 task(s): t1:PENDING, t2:PENDING
Scheduler.cycle() on recreated      stop=already-dispatched
old tasks EXECUTED                  ["t1"]   <-- deleted work RE-RAN
lineage after                       {"execGeneration":2,"attemptGeneration":2}
```

### 12.3 Root cause and the contradiction

6H §7 reasoned: *"evidence is co-located with the incarnation, so 'does this
evidence belong to this task?' is answered by storage."* That is **correct as
stated** — and it is **conditional on the row being deleted**. Production session
deletion never deletes the row, so the storage answer is never asked: both the
task and its evidence simply persist into the next session.

This is precisely the risk §12 of the brief anticipated, and it is the known
two-database boundary: the session store and the task store are **separate
files**, so session deletion is not atomic with task deletion — and in this
codebase it does not even attempt task deletion.

| | |
|---|---|
| **Severity** | **HIGH** |
| **Impact** | a user deletes a session and reuses its ID; the Scheduler silently re-executes the deleted work |
| **Introduced by 6I?** | **No** — pre-existing in `deleteSession` |
| **Contradicts** | 6H §7 (delete destroys generation identity), 6I report §10 (delete/recreate safety) |
| **Mitigated by** | the Scheduler being unreachable — the defect is latent today and becomes live on enablement |
| **Proposed next phase** | wire `deleteSessionTasks` into `deleteSession` in the same best-effort block as the journal, and add a cross-database test. **Not fixed here** — §31 forbids it |

### 12.4 The reverse order

`deleteSessionTasks` succeeding while the session row survives is the *benign*
direction: the tasks are gone, so nothing stale can be selected. The harmful
direction is exclusively the one above.

---

## 13. Schema / migration — **REAL DEFECT (D3), HIGH, product-breaking**

### 13.1 Legacy isolation is clean — **VERIFIED**

```
raw rows after a full LEGACY lifecycle
  [{"task_id":"t1","status":"COMPLETED","revision":3,"exec_generation":0,"attempt_generation":null},
   {"task_id":"t2","status":"PENDING","revision":2,"exec_generation":0,"attempt_generation":null}]
any exec_generation advanced?    false
any attempt evidence recorded?   false
```

LEGACY authors `IN_PROGRESS` and `COMPLETED` with no lineage effect. **Columns
present ≠ activation.**

### 13.2 A pre-6I database cannot create a task — **VERIFIED**

```
open + read existing row       ok: {"id":"t1","status":"PENDING","rev":3}
existing task data preserved   true
columns present after open     []   (empty = NOT added)
CREATE TABLE IF NOT EXISTS added them?  false
createTask on a pre-6I database         THREW: table tasks has no column named exec_generatio
  -> LEGACY task creation broken?       YES - SEVERE
getExecutionLineage                     THREW: no such column: exec_generation
claimTask                                THREW: no such column: exec_generation
```

By contrast a 6I-created database handles `createTask` fine.

### 13.3 Root cause

`CREATE TABLE IF NOT EXISTS tasks (...)` is a **no-op on an existing table**.
SQLite does not add columns. So the two new columns are created only for
*brand-new* databases; any database whose `tasks` table predates 6I never gains
them, and every statement naming them throws.

**This is a regression introduced by 6I, and specifically by 6I's choice of
mechanism.** 6F's schema change added a *new table*, which `IF NOT EXISTS` does
create on an old database — so 6F's migration was genuinely additive. 6I altered
an **existing** table's shape, which `IF NOT EXISTS` cannot express. That
distinction is the whole bug.

The blast radius is wider than the Scheduler, because `createTask` is on the
**LEGACY** path (`todo_write` creates tasks):

| | |
|---|---|
| **Severity** | **HIGH — any pre-6I installation cannot create a task, with the Scheduler disabled** |
| **Root cause** | `IF NOT EXISTS` cannot migrate an existing table; no `ALTER TABLE` step |
| **Existed before?** | A mechanism *does* exist and is **never called**: `dataVersion()`, `ensureDataVersion()`, `migrationStamp()`, `markMigrated()` in `store.ts` have **zero callers**. The hook was available and unused |
| **Contradicts** | 6I report §5 *"Migration — VERIFIED non-destructive … no `ALTER`"*; 6I report §1 *"old DBs open safely"*; 6H §22 *"migration required: No … old databases remain valid: Yes"* |
| **Why 6I's tests missed it** | test `J1` created the database **with the current code**, so the columns always existed. **No test ever built a genuinely pre-6I schema.** That is false evidence in 6I's suite, and it is the same class of error as 6F's static analyzer |
| **Proposed next phase** | an idempotent `ALTER TABLE tasks ADD COLUMN` step driven by `dataVersion()`, plus a test that hand-builds a pre-6I schema. **Not fixed here** — §31 forbids it |

Data is **not** lost (rows are readable and intact) and no destructive statement
is issued — but the database becomes non-functional for writes, which is worse
than a migration error in one respect: it is silent until a task is created.

---

## 14. Model correlation — **VERIFIED (IMPOSSIBLE WITH CURRENT CONTRACT)**

```
selected T1, model completed T2 : T1=IN_PROGRESS  T2=COMPLETED
T1 lineage                      {exec:1, attempt:1}
T1 NOT fabricated complete?     YES
```

The evidence says only *"T1's execution generation returned"*. T2 becomes
`COMPLETED` because an external authority wrote it. **No lineage mechanism infers
intent** — and the Scheduler's runtime closure (§16) reaches no tool log, file,
transcript or presentation source, so the possibility is structurally excluded
rather than merely avoided.

---

## 15. State safety — **VERIFIED**

`COMPLETED`, `CANCELLED`, `FAILED`, `PENDING`, `BLOCKED` are never reconciled
(6I `I3`), a completed row carrying lineage is untouched, `PAUSED` does not
exist, and the generation does not advance without a claim. Reconciliation
reverts **only** from `{IN_PROGRESS, VERIFYING}` and never deletes.

---

## 16. Static architecture — **VERIFIED CLEAN**

```
Scheduler runtime closure (3 modules): graph.ts, scheduler.ts, session-ownership.ts
Scheduler runtime-edges into store.ts : no  (TaskStore is a TYPE-only import)
TaskStore owns SQLite persistence     : yes
modules naming task_attempt           : []      <- no second evidence store
production `new Scheduler(` sites     : 0
RESULT: CLEAN
```

The Scheduler does not mention `exec_generation` or `attempt_generation` at all,
has no `bun:sqlite`/`Database`/`.prepare(`/`.run(`/`.exec(`, and calls only six
store methods. It **cannot** bypass the TaskStore lineage methods. Edges are
parsed from raw text with type-only edges erased — the 6F analyzer failure mode
is not repeated, and the closure is a real 3, not a spurious 1.

---

## 17. In-memory vs durable — **VERIFIED, with one caveat**

Destroying the Scheduler object and resetting process-local state changes no
outcome: restart cases in §6 all behave correctly, and the normal-return/crash
distinction in §7 is decided **entirely from the database**.

**Caveat, and it is the D5 gap:** the in-memory `activeClaim` *is* load-bearing
for the case "actively executing" (§4-A). It is **not** load-bearing for any
cross-restart correctness claim — after a crash, recovery proceeds correctly. So
lineage correctness is not in-memory dependent; the exemption is a
same-process safety guard. But see D5: nothing tests it.

---

## 18. Property testing — **all invariants hold**

400 deterministic seeds, **18 691 checks** over `claim`, `return`, ordinary
mutation, reconcile, new claim, restart, delete, recreate and crash.

| | |
|---|---|
| **I1** only accepted claim advances `exec_generation` | **HOLDS** (monotonic, step ≤ 1) |
| **I2** ordinary mutation never advances it | **HOLDS** |
| **I3** `attempt_generation` never ahead of `exec_generation` | **HOLDS** |
| **I4** an active generation is not falsely recovered | **HOLDS** (checked from a fresh scheduler) |
| **I5** stale evidence cannot protect a newer generation | **HOLDS** |
| **I6** deleted lineage cannot affect a recreated task | **HOLDS** |
| **I7** normal return cannot cause unbounded dispatch | **HOLDS** |
| **I8** restart preserves lineage | **HOLDS** |
| **I9** reconciliation cannot move a task out of a terminal state | **HOLDS** |
| **I10** LEGACY cannot manufacture evidence | **VERIFIED** (§13.1, raw DB) |
| revision monotonicity | **HOLDS** |

I5 is the one 6G showed failing in 12/400 seeds. It now holds in 400.

---

## 19. Mutation re-audit — **15/16 killed, 1 survivor, 0 HARNESS MISS**

6I's count was not trusted. Every mutant: anchor located, replacement
non-trivial, written and re-read to prove installation, score compared, **stdout
and stderr inspected**, sources restored byte-identical. All three task suites
run per mutant.

| id | mutation | result | first failing test |
|---|---|---|---|
| M1 | increment `exec_generation` on a title edit | **KILLED** | `C1` |
| M2 | increment it when evidence is recorded | **KILLED** | `A1` |
| M3 | fail to increment on claim | **KILLED** | `A1` |
| M4 | record from the revision | **KILLED** | `A1` |
| M5 | `attempt <= exec` is safe | **KILLED** | `A2` |
| M6 | any non-null `attempt` is safe | **KILLED** | `C1` |
| M7 | restore revision-as-generation | **KILLED** | `A2` |
| M8 | ignore the generation relation | **KILLED** | `A2` |
| M9 | let an old generation protect a new one | **KILLED** | `C1` |
| M10 | let deleted-task evidence persist | **KILLED** | `D1` |
| M11 | a second store becomes authoritative | **KILLED** | `A1` |
| M12 | make the evidence write memory-only | **KILLED** | `A1` |
| **M13** | **drop the active-claim exemption** | **SURVIVED** | — |
| M14 | remove the atomic revision guard | **KILLED** | `A2` |
| M15 | remove restart persistence | **KILLED** | `A1` |
| M16 | let a LEGACY write manufacture evidence | **KILLED** | `D1` |

### M13 — **HARNESS MISS (D5): real harm, no coverage**

Proven harmful in a **separate process** (my first attempt was invalid: it
imported the module before mutating, so ES module caching ran pristine code
every time — a methodology error I caught and corrected rather than reporting a
false "no harm"):

```
=== PRISTINE ===
  before reconcile  status=IN_PROGRESS lineage={"execGeneration":1,"attemptGeneration":null}
  reconcile         []
  YANKED UNDER A LIVE TURN: no

=== M13 MUTANT (active-claim exemption removed) ===
  before reconcile  status=IN_PROGRESS lineage={"execGeneration":1,"attemptGeneration":null}
  reconcile         ["t1"]
  after reconcile   status=PENDING
  YANKED UNDER A LIVE TURN: YES - HARM
```

So the exemption is genuinely load-bearing, and **nothing in 6I's 41 + 49 + 38
tests detects its removal.** Reported as a coverage gap, **not** excused as
equivalent.

**Harness lessons from 6I carried forward:** three of my first-pass anchors did
not match after formatting, and two mutants (M11, M13) initially failed to
implement what their names claimed. All were corrected before scoring. I did not
count a no-op as a kill.

---

## 20. Performance — **VERIFIED (measurement, not optimised)**

| N | in-flight | lineage read ×N | claim+lineage write ×N | reconcile ×N | cycle 1 | cycle 2 |
|---|---|---|---|---|---|---|
| 1 000 | 0 | 0.0 ms | 0.0 ms | 0.0 ms | 12.3 ms | 12.7 ms |
| 1 000 | 1 000 | 165.0 ms | 1012.1 ms | 625.5 ms | 12.1 ms | 12.3 ms |
| 10 000 | 0 | 0.0 ms | 0.0 ms | 0.0 ms | 127.0 ms | 100.4 ms |
| 10 000 | 10 000 | 1629.8 ms | 9342.4 ms | 5948.2 ms | 100.3 ms | 103.0 ms |

**Linear** (10× tasks → 9.5× reconcile). **PENDING-only sessions: 0 lineage
reads** — the status filter precedes the decision. The generation predicate costs
one integer comparison on an already-indexed primary-key row; no table scan, no
extra index, no write amplification. Reconciliation remains **1 round trip per
in-flight task** (6F was 2). Nothing optimised.

---

## 21. Enablement reachability — **VERIFIED ZERO**

| check | result |
|---|---|
| `new Scheduler(` in production | **0** (one hit: a doc comment in `scheduler.ts` itself) |
| modules importing `task/scheduler` outside tests | **0** |
| `authority: "SCHEDULER"` in `src` | **0** — never activated |
| `Scheduler` in `scripts/` or `cli/` | **0** |
| environment-variable activation | **0** |
| package scripts referencing Scheduler | **none** |
| startup hook / hidden singleton | **none found** |
| test helper imported by production | **none** |

**The lineage schema does not activate the Scheduler.** The columns are inert
until a Scheduler exists, and no Scheduler can be constructed. D3 and D4 are
therefore *latent*, not live — which is the only reason this audit is NO-GO
rather than "already broken in production".

---

## 22. Invariant matrix

| invariant | verdict |
|---|---|
| D1 historical defect reproduced | **VERIFIED** (pre-6I worktree) |
| D2 historical defect reproduced | **VERIFIED** (pre-6I worktree) |
| 6I closes D1 | **VERIFIED** — both forms |
| 6I closes D2 (row deletion) | **VERIFIED** |
| revision/generation separation | **VERIFIED** — 5 mutation kinds |
| active-G2 vs stranded-G2 | **VERIFIED** — 6 sub-cases |
| restart distinction | **VERIFIED** — 4 sub-cases |
| normal-return vs crash | **VERIFIED** — lineage alone |
| G2/G3 not suppressed by old evidence | **VERIFIED** |
| single record sufficient | **VERIFIED** — proof in §10 |
| reconciliation atomicity | **VERIFIED** — one statement, 2-handle race |
| claim/reconciliation race | **VERIFIED** |
| normal-return/reconciliation race | **VERIFIED** — both orders |
| evidence failure explicit | **VERIFIED** (6I `H1`/`I1`) |
| crash duplicate bounded | **VERIFIED** (6I `H2`: `runs == 2`, converges) |
| no model-intent inference | **VERIFIED** |
| legacy uncontaminated | **VERIFIED** — raw DB |
| delete/recreate safe **for the row** | **VERIFIED** |
| **two-database delete failure** | **REAL DEFECT (D4)** |
| **old DBs remain usable** | **REAL DEFECT (D3)** — readable, not writable |
| runtime closure correct | **VERIFIED** |
| no direct SQLite from Scheduler | **VERIFIED** |
| no hidden enablement | **VERIFIED** — zero |
| mutation evidence valid | **15/16, 1 characterised survivor** |
| property testing | **18 691 checks, all hold** |
| **harness misses** | **1 (M13 — a real gap, D5)** |

---

## 23. Findings

| # | finding | class |
|---|---|---|
| J1 | D1/D2 reproduced from real pre-6I code; both closed by 6I | **HISTORICAL DESIGN EVIDENCE** / **VERIFIED** |
| J2 | Lifecycle matches 6H exactly against raw SQLite | **VERIFIED** |
| J3 | An active generation is never recovered; a stranded one always is | **VERIFIED** |
| J4 | Normal return vs crash distinguishable on lineage **alone** | **VERIFIED** |
| J5 | Route A/B now diverge on `exec`/`attempt` only | **VERIFIED** |
| J6 | A single retained record is sufficient; history has no consumer | **VERIFIED** |
| J7 | Reconciliation atomicity and all races safe, incl. two handles | **VERIFIED** |
| J8 | **D3** — pre-6I DB cannot `createTask`; `IF NOT EXISTS` cannot add columns; LEGACY path affected; introduced by 6I | **REAL DEFECT** |
| J9 | **D4** — production `deleteSession` never deletes task rows; deleted work re-executes; falsifies 6H §7 | **REAL DEFECT** |
| J10 | **D5** — active-claim exemption is load-bearing and untested (M13) | **HARNESS MISS** |
| J11 | 6I's `J1` test gave false migration evidence (never built a pre-6I schema) | **HARNESS MISS** |
| J12 | An unused migration mechanism exists (`dataVersion`, `ensureDataVersion`, zero callers) | **VERIFIED** |
| J13 | `deleteSessionTasks`/`deleteTask` are dead code; `todo.ts` documents an invariant that is not implemented | **VERIFIED** |
| J14 | 15/16 mutants killed; 0 harness misses among those; M13 characterised | **VERIFIED** |
| J15 | 18 691 property checks hold, including I5 which 6G failed | **VERIFIED** |
| J16 | My first M13 probe was invalid (module caching) — caught and corrected | **HARNESS MISS** |
| J17 | Model↔task intent unprovable; no inference authority reachable | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| J18 | Production reachability zero; D3/D4 latent only | **VERIFIED** |

---

## 24. Remaining limitations

| # | limitation | class |
|---|---|---|
| L1 | **D3 unfixed** — pre-6I installations cannot create tasks | **REAL DEFECT** |
| L2 | **D4 unfixed** — session deletion leaks tasks and their lineage | **REAL DEFECT** |
| L3 | **D5 unfixed** — active-claim exemption untested | **HARNESS MISS** |
| L4 | A death between `runTurn` returning and the completion write costs one duplicate | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L5 | The Scheduler cannot prove the model worked on the selected task | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L6 | A returned-but-unadjudicated task waits for an external authority forever | **DEFERRED** |
| L7 | Cross-process same-session ownership unsupported; a generation is not a lock | **DEFERRED** |
| L8 | No attempt history | **DEFERRED** |
| L9 | Lineage read ≈1.6 s at 10 k in-flight; classification-path only | **DEFERRED** |
| L10 | No verifier component exists, so verifier interaction is proven against `patchTask` | **UNVERIFIED** (inherited from 6I) |

---

## 25. Verdict

# NO-GO

Against §32, two conditions fail:

| §32 condition | status |
|---|---|
| old DBs remain readable | **readable but NOT WRITABLE — D3** |
| two-database delete failure understood | **understood and realised — D4** |
| mutation evidence valid | 15/16 with one characterised survivor |
| no harness misses | **one real gap — D5** |

**No critical *generation-lineage* invariant failed.** I want to be precise about
that, because it is the part that matters most: the lineage model itself is
sound. D1 and D2 are genuinely closed. The distinguishing property holds —
`attempt < exec` never strands a live generation, and a stale marker can never
protect a newer one.

The NO-GO is for **everything around the model**: a migration that breaks
existing installations, a session-delete path that resurrects deleted work, and
a safety exemption with no test.

**Proposed next phase (6K), in priority order:**

1. **D3** — idempotent `ALTER TABLE tasks ADD COLUMN` driven by the existing but
   unused `dataVersion()`; plus a test that **hand-builds a pre-6I schema**,
   since 6I's test never did and that is why it shipped.
2. **D4** — call `deleteSessionTasks` from `deleteSession`, in the same
   best-effort block as the journal and checkpoints; plus a cross-database test
   asserting no task row survives a session delete.
3. **D5** — add a test that an actively-executing generation is not reconciled,
   using a deferred bridge. M13 must then die.

**None of these is a lineage-model problem, and none should be fixed by
touching the lineage design.** The honest summary: 6I built the right
abstraction and then shipped it without a migration, in a codebase whose
session-deletion contract was never enforced. Both are integration gaps, and
both were one integration test away from being caught.

---

## 26. Exact commit

```
audit: adversarially validate generation lineage
```

Documentation only. `git status` clean, `git diff` empty, not pushed, Scheduler
not enabled, adversarial audit not started.

---

## 27. Tree cleanliness

`git status` — **CLEAN**. `git diff --stat` and `git diff` — empty.

**0 source, 0 schema, 0 test changes.** All probes, the mutation harness, the
property harness, the pre-6I worktree and the static analyzer lived outside the
repository. The worktree was removed and pruned. Task suites unchanged at
128 pass / 0 fail (6I 41, 6C 49, 6B 38).
