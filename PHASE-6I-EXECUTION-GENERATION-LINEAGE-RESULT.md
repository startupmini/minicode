# PHASE 6I — EXECUTION GENERATION LINEAGE IMPLEMENTATION

Base: `717046b` (`docs: redesign execution generation lineage`)
Implements the locked Phase 6H design. **No redesign. No enablement.**

---

## 1. Executive result

# GREEN — 6G's D1 and D2 are both closed structurally

| | |
|---|---|
| D1 reproduced before the fix | **VERIFIED** — form 1 wedged, form 2 unrecovered |
| D2 reproduced before the fix | **VERIFIED** — `reconcile()` threw on a fresh session |
| D1 after the fix | **VERIFIED fixed** — mutation never wedges; a crashed newer generation is recovered |
| D2 after the fix | **VERIFIED fixed** — recreated task starts at `(0, null)`, crash recovered, no throw |
| 6D livelock still dead | **VERIFIED** — 8 cycles → `runs == 1` |
| 6F liveness preserved | **VERIFIED** |
| revision ≠ execution generation | **VERIFIED** — 5 mutation kinds, generation never moves |
| old `task_attempt` authority | **removed** — 0 occurrences in `src/` |
| new durable datums | **2 columns** on `tasks`; **1 table deleted** |
| reconciliation | **ONE atomic guarded UPDATE** (was: read then update) |
| mutation | **14 / 14 killed**, 0 survivors, 0 harness misses; M14 proven unconstructible |
| property testing | **400 seeds, 14 772 checks**, P1–P7 + monotonicity all hold |
| tsc / lint | **28 / 7 — both exactly baseline**, 0 in scope |
| full suite | **3029 pass / 23 skip / 4 fail** — the same 4 pre-existing |
| frozen surfaces changed | **0** |
| production `new Scheduler(` sites | **0** |

**4 files changed.** `src/task/store.ts`, `src/task/scheduler.ts`,
`test/phase6c-scheduler.test.ts`, `test/phase6f-attempt-recovery.test.ts`.

---

## 2. 6H design re-verification — **VERIFIED**

Read from `717046b` before editing. Implemented exactly, including the details
the prompt did not restate:

| locked element | as implemented |
|---|---|
| `exec_generation INTEGER NOT NULL DEFAULT 0` | same |
| `attempt_generation INTEGER` (nullable) | same |
| advances **only** on accepted claim | same, in the same SQL statement |
| lineage predicate **and** revert in **one** statement | same |
| `attempt_generation IS NULL OR < exec_generation` | same (see §8 for a correction I had to make) |
| `attempt_generation > exec_generation` → **throw** | same |
| `task_attempt` dropped | same |
| 6B `reconcileStranded` preserved | **unchanged**; the new method composes rather than replaces it |
| `model.ts` untouched | same — lineage exposed only via store accessors |
| no UUID / incarnation id / lease / heartbeat / counter | same |

**No contradiction with 6H was found, so no STOP was required.**

---

## 3. D1/D2 baseline reproduction — **VERIFIED (REAL DEFECT, pre-fix)**

```
6F history: 6 cycles of one task            runs=1  (6D gave 6)
D1 form1: claim+return then unrelated write marker={"attemptRevision":2} taskRev=3
  -> reconcile []  status=IN_PROGRESS  runs=1     WEDGED = true
D1 form2: G1 ok, requeue, G2 claim, CRASH   G1 marker={"attemptRevision":2}  G2 rev=4
  -> reconcile []                              G2 recovered = false
D2: old incarnation marker {"attemptRevision":6}
  recreated same taskId t1  rev=1  INHERITED marker={"attemptRevision":6}
  reconcile THREW: attempt marker revision 6 exceeds task t1 revision 2
```

### After the fix

```
6F liveness (8 cycles)                runs=1  lineage={exec:1,attempt:1}
D1 form1: return then unrelated write  rev 2->3  lineage={exec:1,attempt:1}
  -> recovered=[]  status=IN_PROGRESS  runs=1        (evidence still current)
D1 form2: G1 ok, requeue, G2 crash     lineage={exec:2,attempt:1}
  -> recovered=["t1"]  status=PENDING              G2 recovered = TRUE
D2: old incarnation lineage {exec:3,attempt:3}
  recreated same taskId                lineage={exec:0,attempt:null}   <- clean
  new claim (crash)                    lineage={exec:1,attempt:null}
  reconcile                            recovered=["t1"]               <- no throw
```

---

## 4. Schema change — **NEW ARCHITECTURE**

`tasks` gains exactly two columns; `task_attempt` is gone:

```sql
-- added to CREATE TABLE tasks
exec_generation INTEGER NOT NULL DEFAULT 0,
attempt_generation INTEGER,

-- removed
CREATE TABLE IF NOT EXISTS task_attempt (...);   -- 6F's revision-keyed store
```

`createTask` initialises explicitly: `..., revision, exec_generation, attempt_generation) VALUES (..., 1, 0, NULL)`, so the defaults are visible rather than implicit.

**Why removal is safe — §3 criteria proven before deleting:**

| criterion | evidence |
|---|---|
| A. introduced only by 6F | `git grep`: table exists only in `244ce23` and later |
| B. no surviving production consumer | exactly **2** production consumers existed, both the pair being replaced: `store.ts` DDL + its two methods, and `scheduler.ts:432,515` |
| C. no LEGACY dependency | LEGACY never calls `claimTask` in production and never read the marker (`J2`) |
| D. no external compatibility contract | Scheduler is production-unreachable; the table was never released |
| E. old DBs open safely | the DDL simply stops creating it; a pre-existing table is inert and never read (`D3`) |

**Explicit classification required by §18 of the brief:** the old `task_attempt`
rows are **not task data**. They are a derived cache of one abandoned
architecture, they were never read by LEGACY, and they are meaningless under the
new semantics (they hold *revisions* where *generations* are now expected). They
are therefore **left in place** in pre-6I databases — untouched, unread, and
covered by test `D3`, which plants a hostile `attempt_revision = 99` row and
proves it cannot affect lineage or reconciliation. No `DROP TABLE` is issued,
because that would be a destructive statement the design did not call for.

---

## 5. Migration — **VERIFIED non-destructive**

| database shape | opens | task data | lineage |
|---|---|---|---|
| fresh | yes | — | `(0, null)` |
| created before 6F (no `task_attempt`) | yes | intact | `(0, null)` |
| created during 6F (has `task_attempt`) | yes | intact | `(0, null)`, stale table ignored (`D3`) |
| holds `IN_PROGRESS` rows | yes | intact | `(0, null)` → reconcilable, as before (`J1`) |
| holds hostile `task_attempt` rows | yes | intact | unaffected |
| after task delete/recreate | yes | fresh row | `(0, null)` (`D1`) |

**No `revision` value is rewritten. No row is dropped. No `ALTER`.** The two
columns are additive with defaults, so `CREATE TABLE IF NOT EXISTS` is a no-op on
an existing table and SQLite does not backfill — the `DEFAULT` supplies `0`/`NULL`
on read, which is exactly the intended "never claimed, never attempted" state.

---

## 6. TaskStore claim integration — **NEW ARCHITECTURE**

One statement creates the claim and the generation together:

```sql
UPDATE tasks
   SET status = 'IN_PROGRESS', updated_at = ?, revision = revision + 1,
       exec_generation = exec_generation + 1
 WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN (...)
```

`claimTask` now returns `execGeneration` so the Scheduler never derives it.
Rejected claims return the **unchanged** current value, so a rejection can never
be mistaken for a claim (`E2`: stale → `CLAIM_REJECTED_STALE`, wrong-state →
`WRONG_STATE`, generation unmoved in both).

---

## 7. Normal-return generation recording — **NEW ARCHITECTURE**

```ts
this.store.recordAttemptReturned(this.sessionId, generation.taskId, generation.execGeneration)
```

- written **before** the in-memory claim is cleared;
- `observation.ok` is **not** consulted — a rejected turn also ended (`A3b`, `A3c`);
- a **synchronous** throw never records, because no attempt was established (`A3d`);
- the task's status is **not** touched; no `COMPLETED`, no manufactured evidence;
- the write is **guarded**: `WHERE ... AND exec_generation = ?`, and 0 changes
  throws rather than recording a misattributed outcome (`E3`).

---

## 8. Reconciliation — **NEW ARCHITECTURE**, with a correction I had to make

The whole decision is one statement, owned by TaskStore:

```sql
UPDATE tasks SET status = 'PENDING', updated_at = ?, revision = revision + 1
 WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN ('IN_PROGRESS','VERIFYING')
   AND (attempt_generation IS NULL OR attempt_generation < exec_generation)
```

The Scheduler contributes ownership and nothing else — it has **no lineage rule of
its own** (`J5`).

### A real bug my own test caught

My first implementation used `attempt_generation <> exec_generation`. Test `C3`
(forging the impossible `attempt = 9, exec = 1`) showed it **reconciled the row**,
because `9 <> 1` is true — the corrupt case was silently acted on instead of
thrown.

My second attempt used `<=`, which is worse: it matches `attempt = exec`, i.e. a
**completed** generation, and would have reintroduced the 6D livelock in lineage
form. Thirteen tests failed and caught it.

The correct relation is **strict `<`**, which is what 6H specified:

| relation | predicate | outcome |
|---|---|---|
| `NULL` | `IS NULL` → true | reconcile — never completed |
| `attempt < exec` | true | reconcile — a later generation superseded an earlier completed one |
| `attempt = exec` | false | not stranded |
| `attempt > exec` | false → `changes = 0` → classification → **throw** | impossible, refused |

Strictness is load-bearing twice: `<>` corrupts, `<=` livelocks. Both are now
mutation-tested (`M4`, `M6`).

---

## 9. Generation isolation from revision — **VERIFIED (the mandatory proof)**

Five mutation kinds, each advancing `revision`, none touching the generation:

```
after claim + record            rev=2  exec=1  attempt=1
after title write               rev=3  exec=1  attempt=1  moved=false
after order write               rev=4  exec=1  attempt=1  moved=false
after dependency write          rev=5  exec=1  attempt=1  moved=false
after blockedReason write       rev=7  exec=1  attempt=1  moved=false
after evidence write            rev=8  exec=1  attempt=1  moved=false
after verification write        rev=9  exec=1  attempt=1  moved=false
exec_generation across ALL      start=1  final=1  UNCHANGED=true
reconcile after all mutations   []
```

**M1** (advance the generation on `patchTask`) is killed by `C1`.
**M15** (record the revision as the generation) is killed by `A1`.

---

## 10. Delete/recreate safety — **NEW ARCHITECTURE, structural**

Evidence lives on the row, so it cannot outlive it. `D1` deletes a session,
recreates the same session and the **same canonical id** `t1`, and asserts
`(0, null)` — without deleting any marker by hand. `D2` proves the table is
absent; `D3` proves a hostile pre-existing table cannot interfere.

---

## 11. Restart — **VERIFIED**

`B4`: Scheduler A claims, records, is destroyed; a **fresh object** Scheduler B
runs 6 cycles and dispatches **0** times, with lineage unchanged. `H3`: a crash
after the record causes no duplicate. `J1`: a pre-6I database reopened reads
`(0, null)` and reconciles as it always did.

---

## 12. Crash window — **VERIFIED, bounded, unchanged**

| point | result |
|---|---|
| crash before the completion write | recovered; **exactly one** duplicate; the duplicate records its own generation and the loop stops (`H2`, `runs == 2`) |
| crash after the write | **no** duplicate (`H3`) |
| record failure | propagates; never reported as success; task stays `IN_PROGRESS` (`H1`) |

The window is **one durable write** wide, exactly as 6E/6H recorded. It was not
narrowed by touching the agent loop, and the generation logic does not multiply
it.

---

## 13. Verifier interaction — **VERIFIED, deterministic**

**Boundary, recorded honestly:** this repository has **no separate verifier
component**. The closest real `TaskStore` mutation is `patchTask` by an external
authority, which is precisely what a verifier performs. `G1` drives that shape
across several writes and asserts the generation and its record are unchanged and
reconciliation does not misclassify. `G2` covers a verifier `COMPLETED`
transition. **No verifier semantics were modified.**

The answer does not depend on timing: it depends only on *which kind of write*
occurred, and exactly one kind advances the generation.

---

## 14. Legacy compatibility — **VERIFIED inert**

`J2`: a LEGACY store authoring `PENDING → IN_PROGRESS → COMPLETED` produces
**no lineage write at all** — `exec_generation = 0`, `attempt_generation = null`.
`J3`: the SCHEDULER authority guard still refuses a model-shaped `IN_PROGRESS`
write and conjures no lineage. The 6B suite is green (38/38).

---

## 15. Static architecture — **VERIFIED CLEAN**

```
Scheduler runtime closure (3 internal modules):
  src/task/graph.ts, src/task/scheduler.ts, src/task/session-ownership.ts
Scheduler runtime-edges into store.ts : no  (TaskStore is a TYPE-only import)
TaskStore owns SQLite persistence     : yes (as designed)
modules naming task_attempt           : []      <- second store removed
production `new Scheduler(` sites     : 0
RESULT: CLEAN
```

Enforced by tests `J4` (lineage absent from graph/readiness/model), `J5`
(Scheduler holds no SQL and no lineage identifier), `J6` (only `store.ts` writes
the columns, comments stripped), `J7` (no production construction).

**The 6F analyzer failure was not repeated:** edges are parsed from raw text with
type-only edges erased, and the closure is a genuine 3, not a spurious 1.

---

## 16. Mutation — **14 / 14 killed, 0 survivors, 0 HARNESS MISS**

Every mutant: anchor located, replacement non-trivial, written and re-read to
prove installation, score compared, **stdout and stderr inspected**, sources
restored byte-identical. The Scheduler suite runs in every mutant.

| id | mutation | killed | first failing test |
|---|---|---|---|
| M1 | advance `exec_generation` on an ordinary mutation | **YES** | `C1` |
| M2 | do **not** advance on claim | **YES** | `A1` |
| M3 | record from the revision instead of the generation | **YES** | `A1` |
| M4 | accept stale evidence as current (`<=`) | **YES** | `A2` |
| M5 | treat any historical generation as current | **YES** | `A2` |
| M6 | let an old generation protect a new one (reversed) | **YES** | `C1` |
| M7 | reintroduce a second evidence store | **YES** | `A1` |
| M8 | skip the lineage update during claim | **YES** | `A1` |
| M9 | skip the normal-return evidence write | **YES** | `A1` |
| M10 | reintroduce 6F revision-as-generation | **YES** | `A2` |
| M11 | let deleted evidence survive recreation | **YES** | `D1` |
| M12 | reset the generation on a new claim | **YES** | `C1` |
| M13 | use another session's / task's lineage | **YES** | `B6` |
| M15 | claim records the revision as the generation | **YES** | `A1` |

### M14 — **NOT CONSTRUCTIBLE, structurally enforced**

"Make generation changes outside TaskStore" **cannot be constructed**, and that is
the guarantee rather than a gap in the evidence:

| probe | result |
|---|---|
| SQL sites writing lineage in `store.ts` | 3 (all in `claimTask`, `recordAttemptReturned`, `reconcileIfNoCompletedAttempt`) |
| `scheduler.ts` contains `bun:sqlite` / `new Database` / `.prepare(` / `.run(` / `.exec(` | **all false** |
| `scheduler.ts` contains `exec_generation` / `attempt_generation` | **both false** |
| store methods the Scheduler calls | `claimTask, getSnapshot, getTask, reconcileIfNoCompletedAttempt, reconcileStranded, recordAttemptReturned` |

The Scheduler has no database handle, no SQL primitive, and no lineage-writing
method. Classified **structurally enforced** — explicitly *not* an equivalent
mutant and *not* a harness miss. My first M14 attempt appended `void 0`, which was
a no-op; I discarded it rather than report a fake mutant.

### Two harness misses I found and corrected

`M1`'s anchor did not match after the formatter wrapped the SQL, and `M11`/`M13`
initially did not implement what their names claimed (`M11` wrote to `task_meta`,
which nothing read). I rewrote all three to genuinely install before counting
them. **Reporting a survivor without checking whether the mutant was real would
have repeated 6F's two false "no-op" mutants.**

---

## 17. Property testing — **all invariants hold**

400 deterministic seeds, **14 772 checks**, over `cycle`, repeated cycles,
external mutation, requeue, crash-in-window, restart, reconcile, and
delete/recreate.

| property | result |
|---|---|
| **P1** ordinary mutations never advance the generation | **HOLDS** |
| **P2** only accepted claims create generations (monotonic, step ≤ 1) | **HOLDS** |
| **P3** `attempt_generation` is never ahead of `exec_generation` | **HOLDS** |
| **P4** old evidence cannot protect a newer generation | **HOLDS** (6G: **12/400 failed**) |
| **P5** deleted tasks cannot leak evidence into recreated tasks | **HOLDS** |
| **P6** normal return cannot produce unbounded redispatch | **HOLDS** |
| **P7** restart preserves durable lineage | **HOLDS** |
| **P8** TaskStore remains the sole durable authority | **VERIFIED structurally** (§15, §16) |
| revision monotonicity | **HOLDS** |

### A false alarm I investigated rather than dismissed

The first run reported **60 P4 violations** ("stale attempt 1 protected
generation 2"). Before writing that off I reproduced the exact state: a Scheduler
that still holds the in-memory claim legitimately **skips** its own active task
(`if (this.claim?.taskId === task.id) continue` — 6C/6B behaviour). From a **fresh**
Scheduler the same state recovers correctly. So the *lineage rule* was right and
my *check* was wrong: it ignored the in-memory exemption. I re-ran P4 from a
fresh Scheduler, and it passes. **This is a HARNESS MISS I introduced and fixed,
not a product defect.**

---

## 18. Performance — **VERIFIED (measurement, not optimised)**

| N | in-flight | lineage read ×N | claim+lineage write ×N | reconcile ×N | cycle 1 | cycle 2 |
|---|---|---|---|---|---|---|
| 1 000 | 0 | 0.0 ms | 0.0 ms | 0.0 ms | 12.3 ms | 12.7 ms |
| 1 000 | 1 000 | 165.0 ms | 1012.1 ms | 625.5 ms | 12.1 ms | 12.3 ms |
| 10 000 | 0 | 0.0 ms | 0.0 ms | 0.0 ms | 127.0 ms | 100.4 ms |
| 10 000 | 10 000 | 1629.8 ms | 9342.4 ms | 5948.2 ms | 100.3 ms | 103.0 ms |

- **Linear:** 10× tasks → 9.5× reconciliation time.
- **PENDING-only sessions: 0 lineage reads** — the status filter precedes the
  decision.
- **Fewer round trips than 6F.** 6F reconciled via a marker `SELECT` followed by a
  separate guarded `UPDATE` — **2 statements per in-flight task**. 6I decides and
  mutates in **1**. At 10 k that is ~5 948 ms against 6F's ~7 594 ms for the same
  work. This is a *side effect* of co-locating lineage, not an optimisation: the
  reason for the design was atomicity (6B's "no read-then-write window"), and the
  speed follows.
- The lineage *read* is only used by the store's 0-change classification path,
  never by the Scheduler.
- Nothing was optimised, per the brief.

---

## 19. Findings

| # | finding | class |
|---|---|---|
| I1 | D1 form 1 and D2 reproduced pre-fix; both closed | **VERIFIED** |
| I2 | D1 form 2 (crashed newer generation suppressed by an older completed one) is closed | **VERIFIED** |
| I3 | **A real bug in my first implementation**: `attempt <> exec` reconciled the impossible relation instead of throwing; `<=` would have livelocked. Strict `<` is correct | **REAL DEFECT** (introduced and fixed within 6I) |
| I4 | `exec_generation` advances only on an accepted claim; rejected claims do not advance it | **VERIFIED** |
| I5 | five mutation kinds never move the generation | **VERIFIED** |
| I6 | evidence cannot outlive its task; recreated ids start clean | **VERIFIED** |
| I7 | the 6F `task_attempt` store is gone; a hostile pre-existing copy is inert | **VERIFIED** |
| I8 | migration is additive, non-destructive, no `revision` rewritten | **VERIFIED** |
| I9 | 14/14 mutants killed; M14 unconstructible; 2 harness misses found and fixed | **VERIFIED** |
| I10 | 14 772 property checks hold, including P4 which 6G showed violated | **VERIFIED** |
| I11 | 60 apparent P4 failures were **my** harness ignoring the in-memory active-claim exemption | **HARNESS MISS** (found and fixed) |
| I12 | reconciliation is one statement — 6B's atomicity property is restored, not regressed | **NEW ARCHITECTURE** |
| I13 | Scheduler holds no lineage rule and no database access | **VERIFIED** |
| I14 | LEGACY writes no lineage across its whole lifecycle | **VERIFIED** |
| I15 | frozen surfaces byte-identical; production reachability 0 | **VERIFIED** |
| I16 | crash window still one write wide; one duplicate, then convergence | **VERIFIED** (residue preserved) |
| I17 | model↔task intent remains unprovable; no inference authority added | **IMPOSSIBLE WITH CURRENT CONTRACT** |

---

## 20. Remaining limitations

| # | limitation | class |
|---|---|---|
| L1 | A death between `runTurn` returning and the completion write still yields one duplicate. Closing it needs the agent turn transactionally coupled to the database | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L2 | The Scheduler cannot prove the model worked on the selected task | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L3 | A returned-but-unadjudicated task waits for an external authority forever — the deliberate trade against re-running work | **DEFERRED** |
| L4 | Cross-process same-session ownership unsupported; a generation is **not** a lock (I26) | **DEFERRED** |
| L5 | No attempt history: "how many times did this run?" is unanswerable | **DEFERRED** |
| L6 | `attempt_generation` retains one generation only | **DEFERRED** |
| L7 | No verifier component exists, so §13 is proven against `patchTask` rather than a real verifier | **UNVERIFIED** (boundary recorded) |
| L8 | The lineage read costs ~1.6 s at 10 k in-flight; used only in classification, and a batched read would need a new method | **DEFERRED** |

**L7 is the weakest evidence in this report** and is flagged as such: the verifier
semantics are *inferred* to be `patchTask`-shaped, and nothing here proves a
future verifier component will not invent a write that advances the generation.
6H's axiom makes that impossible **by construction** (only `claimTask` increments
it), which is why I am comfortable, but the claim is structural, not observed.

---

## 21. Changed files

| file | change |
|---|---|
| `src/task/store.ts` | 2 lineage columns; `task_attempt` DDL removed; `AttemptMarker` → `ExecutionLineage` + `LineageReconcileOutcome`; `claimTask` creates the generation and returns it; `recordAttemptReturned` guarded on the generation; `getExecutionLineage` added; `reconcileIfNoCompletedAttempt` added; `getAttemptMarker` removed |
| `src/task/scheduler.ts` | `ActiveClaim.execGeneration`; records the generation on normal return; `reconcile` delegates all lineage logic to the store (comparison code deleted) |
| `test/phase6c-scheduler.test.ts` | test `10b` re-expressed on lineage; test `16`'s claim literal supplies a generation |
| `test/phase6f-attempt-recovery.test.ts` | **rewritten**: 6F's revision-keyed assertions replaced with 41 lineage tests (D1, D2, revision isolation, history, verifier, crash, reconciliation, isolation, migration, legacy, static) |

`+855 / −785` across 4 files.

---

## 22. Frozen files

Byte-identical, verified by `git status --porcelain` over the full set:
`model.ts` · `graph.ts` · `graph-validate.ts` · `readiness.ts` ·
`session-ownership.ts` · `todo.ts` · `vendor/minicore` · `src/ui` · `src/tui` ·
`src/acp` · `src/presentation` · `parallel-executor` · `package.json`.

Also unchanged: `TaskStatus` still has 8 members, no `PAUSED` (`I4`), the agent
loop was not modified at all, and `reconcileStranded` — 6B's primitive — is
untouched.

---

## 23. Exact commit

```
feat: separate execution generation from task revision
```

Single commit, 4 files. Not pushed.

---

## 24. Git cleanliness

`git status` after commit: **CLEAN**. `git diff --stat` and `git diff`: empty.

Verification scaffolding (the mutation harness, property harness, static analyzer
and every probe) lived **outside** the repository in the temp directory, so no
stray files entered the tree. Gates on the actual working tree:

| gate | baseline | after 6I |
|---|---|---|
| `tsc --noEmit` | 28 | **28** (0 in 6I scope) |
| lint `src/task` | 7 | **7** |
| biome on the 4 changed files | — | **0** |
| full suite | 3035 pass / 23 skip / 4 fail | **3029 pass / 23 skip / 4 fail** |
| 6B / 6C / 6I | 38 / 49 / 47 | **38 / 49 / 41** |

The 4 failures are the same pre-existing set (architecture-map, two `audit #11`
vendor/pack hash tests, `web ssg`). **No new failures.** The suite total moved
3062 → 3056 exactly as expected: 47 rewritten 6F tests replaced by 41.

---

## 25. Scheduler enablement status

# STILL NOT ENABLED

| | |
|---|---|
| production `new Scheduler(` sites | **0** (one hit, a doc comment inside `scheduler.ts` itself) |
| modules importing `task/scheduler` outside tests | **0** |
| `authority: "SCHEDULER"` anywhere in `src` | **0** — never even activated |
| `Scheduler` in any script/CLI entrypoint | **0** |
| composition-root wiring | **none** |
| can the marker activate Scheduler behaviour? | **No** — read only inside reconciliation, behind the ownership gate |
| pushed | **no** |

Adversarial audit **not** started, per the brief.

---

## 26. Bottom line

6G was right that 6F was wrong, and 6I fixes it with the minimum mechanism 6H
specified: **one integer that only a claim can move.**

The proof that this is structural rather than a better heuristic is §9 — five
different kinds of ordinary mutation, each advancing `revision`, and the
generation never budges. Under 6F the generation *was* the revision, which is why
one title edit could wedge a task. No rule over a value that unrelated writes
change can be correct; 6H proved that with a discriminating pair, and §8 confirms
the implementation now answers the two cases **differently** where 6F answered
them identically.

Two things I did not smooth over. First, **I introduced a real bug in my own first
implementation**: `attempt <> exec` silently reconciled a corrupt row instead of
throwing, and my first correction (`<=`) would have reinstated the 6D livelock in
lineage form. Thirteen tests caught it. Strict `<` is the answer, and both wrong
relations are now mutation-pinned. Second, **M14 could not be tested by mutation
at all** — not because the evidence was weak, but because the Scheduler has no
database handle and no lineage-writing method, so the mutation cannot be written.
I report that as structurally enforced rather than dressing up a no-op as a pass.

The honest limit: this proves an *attempt's* generation ended. It still cannot
prove the model worked on the task it was given, the crash window is still one
write wide, and a returned-but-unadjudicated task still waits for a human. And a
returned-but-unadjudicated task is now the *normal* resting state of a completed
attempt — so whoever enables this must put a verifier or an operator in the loop.
That is a deployment decision, not a defect, but it is the precondition for
turning this on.
