# PHASE 6F — EXECUTION ATTEMPT & RECOVERY IMPLEMENTATION RESULT

Base: `1d185af` (`docs: redesign scheduler execution recovery semantics`)
Implementation of the design locked in
`PHASE-6E-EXECUTION-ATTEMPT-RECOVERY-DESIGN.md`. No redesign. No enablement.

---

## 1. Executive result

# GREEN — the Phase 6D livelock is fixed and proven fixed

| | |
|---|---|
| 6D livelock reproduced before the fix | **VERIFIED** — `runs = 1, 2, 3, 4` for one task |
| after the fix, 6 cycles of one task | **VERIFIED** — `runs == 1`, status correctly `IN_PROGRESS` |
| normal return converges | **VERIFIED** — 8-cycle liveness regression `A2` |
| marker durable across restart | **VERIFIED** — `B4`, fresh Scheduler reconstructs from TaskStore |
| reconciliation uses positive evidence | **VERIFIED** — reverts only when no marker exists |
| crash-before-marker still recovers | **VERIFIED** — `B6`, `D10`, `D12` |
| crash residue one write wide | **VERIFIED** — `D12` executes the duplicate, then converges |
| generation semantics | **VERIFIED** — `==`/`<` not stranded, `>` throws, `C7`–`C11` |
| mutation | **12 / 12 killed, 0 survivors, 0 harness misses** |
| M11 (restores the 6D livelock) | **KILLED by `A2`** — the regression the brief called primary |
| tsc | **28 = baseline**, 0 new (verified by file-level distribution) |
| lint `src/task` | **7 = baseline**, 0 new |
| full suite | **3035 pass / 23 skip / 4 fail** — all 4 pre-existing |
| new `TaskStatus` | **0** |
| frozen surfaces changed | **0** |
| production `new Scheduler(` sites | **0** |

**Files changed: 4.** `src/task/store.ts`, `src/task/scheduler.ts`,
`test/phase6c-scheduler.test.ts`, `test/phase6f-attempt-recovery.test.ts`.

---

## 2. Phase 6E design re-verification — **VERIFIED**

Read from the committed artifact before any source edit. Extracted exactly, not
reconstructed:

| locked element | artifact | implemented |
|---|---|---|
| table | `task_attempt` | same |
| columns | `session_id`, `task_id`, `attempt_revision` — **3, no extras** | same |
| methods | `recordAttemptReturned`, `getAttemptMarker` — **exactly two** | same |
| write timing | immediately after `runTurn` resolves, before the claim is cleared | same |
| generation | the **POST-CLAIM** revision, captured at claim time | same |
| `==` | NOT stranded | same |
| `<` | NOT stranded (fails safe) | same |
| `>` | **throw**, do not guess | same |
| no marker | STRANDED → revert | same |
| crash residue | accepted, one duplicate | preserved |
| reconciliation base | ownership still required (6B) | preserved |

**No contradiction with the artifact was found, so no STOP was required.**

One clarification the artifact left open and I resolved explicitly: 6E §7 treats
a *failed* or *aborted* turn as an attempt that "ended", same as a successful
one. The write is therefore placed after the `try/catch` that normalises a thrown
promise into a `rejected` observation, so it covers returned-ok, returned-failed
and rejected. It is **not** placed after a *synchronous* throw, because that
means the attempt was never established — see §6 and test `A3d`.

---

## 3. Old livelock reproduction — **VERIFIED BASELINE DEFECT**

Inspected behaviour directly, not by trusting any existing test name:

```
scenario: 1 task, 1 scheduler, no external mutation, no crash
  cycle 1: runs=1  status=IN_PROGRESS  revision=2
  cycle 2: runs=2  status=IN_PROGRESS  revision=4
  cycle 3: runs=3  status=IN_PROGRESS  revision=6
  cycle 4: runs=4  status=IN_PROGRESS  revision=8
```

After the fix, same probe, 6 cycles:

```
  cycle 1: runs=1  status=IN_PROGRESS  rev=2  marker=2
  cycle 2: runs=1  status=IN_PROGRESS  rev=2  marker=2  stop=no-candidates
  ...through cycle 6: runs=1
```

`runs == 1`, and the task remains `IN_PROGRESS` — **not** `COMPLETED`, because a
returned turn is not a verdict.

---

## 4. Root cause — **REAL DEFECT (6D), unchanged and now addressed**

Three facts, all **VERIFIED** in source:

1. `dispatch()` cleared `this.claim` after every dispatch — the only record that
   an attempt happened.
2. `reconcile()` exempted only `this.claim?.taskId`, so once forgotten, the
   Scheduler's own completed work looked exactly like a crash.
3. No attempt identity existed anywhere, so reconciliation had no evidence to
   consult and reverted on status alone.

**6F did not change the diagnosis. It supplied the missing evidence.**

---

## 5. Marker schema — **NEW ARCHITECTURE**

Added to the existing additive DDL block in `src/task/store.ts`, beside
`task_meta`:

```sql
CREATE TABLE IF NOT EXISTS task_attempt (
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_revision INTEGER NOT NULL,
  PRIMARY KEY (session_id, task_id)
);
```

| property | value |
|---|---|
| ownership | **TaskStore**; the Scheduler never executes SQL |
| columns | **3**, exactly as locked |
| rejected extras | `heartbeat`, `lease_until`, `owner_pid`, `retry count`, `execution count`, `timeout`, `priority`, `scheduler state` — **none added** |
| marker existence means | "an attempt for this generation reached its end" |
| does **not** mean | a task status, a completion, a lock, a queue, a counter, a history |
| index | the primary key covers the read; **no extra index added** |

Verified by `H5`: `task_attempt` is named in **exactly one** module,
`src/task/store.ts`.

---

## 6. Marker lifecycle — **NEW ARCHITECTURE**

| situation | marker | source of the fact |
|---|---|---|
| claim accepted, turn never established (sync throw, cancellation, non-callable bridge) | **absent** | the attempt did not exist; 6C's release path is correct and kept |
| `runTurn` resolves `returned` ok | written | the turn ended |
| `runTurn` resolves `returned` not-ok | written | the turn ended |
| `runTurn` rejects (async) | written | the turn ended |
| process dies at any point before the write | **absent** | nothing survived to write |
| new claim for the same task | **overwritten** (upsert) | the new generation replaces the old fact |

The upsert is what makes a historical marker unable to mask a newer generation
(§9, `C11`).

---

## 7. Normal-return semantics — **NEW ARCHITECTURE**

```
runTurn resolves
  -> recordAttemptReturned(sessionId, claimedTaskId, postClaimRevision)
  -> this.claim = null
  -> task status UNTOUCHED
```

| rule | status |
|---|---|
| release to `PENDING` | **not done** (would reproduce the livelock) |
| write `COMPLETED` | **not done** |
| manufacture `CompletionEvidence` | **not done** |
| infer success from promise resolution | **not done** — the marker's presence is independent of `ok` |
| write the marker even when the claim vanished mid-flight | **not done** — throws rather than fabricate a generation |

Asserted by `A1`, `A3`, `A3b`, `A3c`, `A3d`, `A4`–`A7` and mutant **M12**
(killed by `A1`).

**One correction to my own first draft (VERIFIED):** I initially asserted that a
*thrown* turn records a marker. That was wrong, and the test caught it. A
**synchronous** throw means `runTurn` never produced a promise, so the attempt
was never established; recording a marker would assert an execution that never
happened and would strand the task forever. `A3d` now pins the correct split:
sync throw → dispatch failure, claim released, no marker; async rejection →
marker written.

---

## 8. Reconciliation semantics — **NEW ARCHITECTURE**

Status filter first, then the ownership gate, then evidence:

```
for each task in snapshot:
  if status not in {IN_PROGRESS, VERIFYING}: skip      # terminal/operator states
  if this.claim?.taskId === task.id:      skip        # actively executing
  marker = getAttemptMarker(task)
  if marker is null:                      RECONCILE    # the only revert path
  if marker.attemptRevision > revision:   THROW
  otherwise:                              skip          # == or <
```

The principle, inverted from 6C: **revert only on positive evidence of absence.**

Verified: `B5` (marker suppresses), `B6`/`E14` (absence permits), `C9` (`>`
throws, and throws *before* mutating), `E13`–`E18`, and mutants **M2, M3, M6, M8,
M11** (all killed).

No timer, no grace period, no clock, no event history, no file inspection. The
implementation contains none of them and the brief's prohibition is honoured by
construction rather than by convention.

---

## 9. Generation/revision semantics — **NEW ARCHITECTURE**

The generation is the **post-claim revision** captured at claim time, read from
`this.claim` — never from `TaskGraph.sourceRevision`, never a timestamp, never a
Scheduler instance id, never re-read from mutable task state.

| relation | decision | rationale |
|---|---|---|
| `marker.attemptRevision == task.revision` | NOT stranded | this generation recorded completion |
| `marker.attemptRevision < task.revision` | NOT stranded | a newer generation exists; reverting would fight a legitimate newer writer |
| `marker.attemptRevision > task.revision` | **throw** | impossible sequence; guessing strands live work or re-runs finished work |
| no marker | STRANDED | positive evidence of absence |

| test | scenario |
|---|---|
| `C7` | a G1 marker does not protect a G2 row |
| `C8` | `<` is not stranded |
| `C9` | `>` throws, and mutates nothing |
| `C9b` | **revision race**: an external write between claim and marker write; the marker still names the claimed generation `2`, the external write to `3` is not clobbered, and reconciliation resolves on the locked rule |
| `C11` | a new claim after a completed attempt moves the marker to a new generation (built only from existing transitions — a LEGACY `patchTask` to `PENDING`; no requeue mechanism invented) |
| `M4` | writing the current revision instead of the claimed generation — **killed by `C9b`** |
| `M5` | keeping the stale marker on a new generation (`DO NOTHING`) — **killed by `C11`** |

### Operator-visible consequence, stated rather than hidden

The locked `<` rule means that if an external writer mutates a task *after* its
attempt ended, the resulting newer generation is **not** recovered and **not**
re-dispatched. The task waits for an external authority. This is the design's
deliberate "fail safe toward leaving work alone" choice, not an oversight, and
`C7`/`C8` pin it as behaviour. It is recorded in §24 as a **DEFERRED**
operator-visibility item, not fixed in 6F — doing so would be a redesign.

---

## 10. Crash window — **VERIFIED, residue preserved**

The 6E §21 row-4 window is preserved exactly and is now **executable** rather
than a prose caveat:

| point | marker | outcome |
|---|---|---|
| dies before the turn | absent | recovered, re-dispatched |
| dies during the turn | absent | recovered, re-dispatched (possible duplicate side effects) |
| dies after the turn resolved, before the write | absent | **one duplicate** — `D12` executes it |
| dies after the write | present | no duplicate — `D11` |

`D12` proves the residue is **bounded**: the duplicate occurs, records its own
marker, and then the system converges. That is the difference between
at-least-once and the 6D livelock.

Not eliminated, and not attempted to be. No journal-only marker, no timer, no
"wait" heuristic, no uptime read, no heartbeat, no lease was added.

---

## 11. Restart behavior — **VERIFIED (the causal proof)**

`B4` is the decisive test and it is a real restart, not a reset:

- Scheduler A claims, the turn returns, the marker is persisted.
- A is destroyed (`stop()` releases the only in-process state a successor could
  inherit).
- Scheduler B is a **fresh object** over the same session and database. It has no
  claim, no history, no remembered turn, and no reference to A.
- B runs 6 cycles: **0 dispatches**, status still `IN_PROGRESS`, marker
  unchanged.

The in-process guard was explicitly **not** the fix. `scheduler.ts` retains no
`completedClaim` field, and no test can be passed by remembering anything in
memory — a fresh instance has nothing to remember. Mutants **M9** (no
persistence) and **M10** (write then delete) are both killed, which is what
proves the marker is genuinely causal rather than incidentally present.

---

## 12. Task/execution state separation — **NEW ARCHITECTURE**

| | task state | execution state |
|---|---|---|
| lives in | `tasks` / `TaskStatus` (8 values, unchanged) | `task_attempt` |
| read by | TaskGraph, Scheduler, verifier | Scheduler reconciliation only |
| may be read as task truth | yes | **no** |

Verified by `J1` (one row per task regardless of attempt count), `J2` (the
marker grants no exclusion — the second claim is refused by **status**, not by
the marker), `J3` (a marked `IN_PROGRESS` task is still not schedulable), `E15`
(no `PAUSED`/`AWAITING`/`ATTEMPTED`/`STARTED` status exists) and `H4` (the marker
does not appear in `graph.ts`, `readiness.ts` or `model.ts`).

**`EXECUTION ≠ VERIFICATION ≠ COMPLETION` is preserved and asserted** by `A3`
(returns normally, task not completed, no evidence manufactured).

---

## 13. Model correlation limitation — **IMPOSSIBLE WITH CURRENT CONTRACT**

Preserved exactly as 6E concluded, with no new inference authority.

`F1`: the Scheduler selects T1; the model completes **T2** instead; the turn
returns normally.

| assertion | result |
|---|---|
| T1's marker exists (its attempt ended) | yes |
| T1 is `COMPLETED` | **no** — nothing inferred |
| T1 converges instead of looping | yes, 6 cycles, 1 dispatch |
| T2's `COMPLETED` is authoritative | yes, an external authority wrote it |

No inference from file modifications, shell commands, tool-call contents,
transcript, presentation events, journal narrative or memory. The Scheduler
reaches none of those at runtime — proved by the closure in §18.

---

## 14. Updated 6C test 10b — and a second one the brief did not flag

`test/phase6c-scheduler.test.ts:219` was replaced, not renamed. It previously
asserted `expect(seen).toEqual([a.id, a.id])`, satisfiable only by re-running a
task whose turn had already returned. It now asserts the new contract: one
marker at the post-claim revision, 4 cycles, `seen.length === 1`, task still
`IN_PROGRESS`, marker still matching.

### **REAL DEFECT (in the test suite, not the product) — second livelock encoding**

**`test 28` encoded the same livelock a second time** and the 6F brief did not
mention it. It read:

```ts
test("28. a second cycle after the first completes may dispatch again", ...)
  await sc.cycle(); await sc.cycle()
  expect(calls).toBe(2)          // one task, one returned turn
```

That is the defect, asserted as a requirement. It could not be distinguished
from the livelock it depended on: "not permanently wedged" and "re-run forever"
are the same observable until you supply a *new* scheduling justification.

Replaced with a test that preserves the real intent honestly: one task, one
completed attempt, second cycle changes nothing (`bridge.seen.length === 1`),
then an external authority completes T1 and a new task becomes ready — and only
then does the Scheduler dispatch again (`[a, b.id]`).

**Both old tests were encoding the behaviour 6D identified as a liveness
failure.** Had only 10b been corrected, the suite would have kept a green test
demanding the livelock.

---

## 15. Liveness proof — **VERIFIED empirically**

Claim: for a task whose turn returns normally, with no external mutation, the
Scheduler executes it **exactly once**, for any number of cycles.

`A2` runs 8 plain `cycle()` calls — no sleep, no clock, no wall-clock
dependency, no model cooperation — and asserts `seen.length === 1`, the task
`IN_PROGRESS`, and the marker equal to the current revision. The trace in §3
shows the same over 6 cycles with the marker pinned at `2`.

Supporting: `A3` (no completion manufactured), `D12` (bounded after a crash),
`B4` (holds across restart).

The `>` throw is also a liveness protection: an impossible marker relation
surfaces loudly instead of silently reverting or silently stranding.

---

## 16. Database migration safety — **VERIFIED**

| requirement | result |
|---|---|
| initialisation idempotent | **VERIFIED** — `G5`, DDL is `IF NOT EXISTS` and re-runs on every open |
| existing databases open | **VERIFIED** — `G6` |
| LEGACY data readable | **VERIFIED** — `G6`, `G7` |
| absence of markers for old rows has defined semantics | **VERIFIED** — no marker = no recorded completion, so the row is reconcilable exactly as a pre-6F stranded row was |
| schema init does not alter existing task rows | **VERIFIED** — `G6` asserts status, revision and title identical across reopen |
| no destructive migration | **VERIFIED** — additive `CREATE TABLE` only; no `ALTER`, no `DROP`, no data rewrite |
| no existing revision changed | **VERIFIED** — `G5`, `G6` assert exact revision equality |

`G6` goes further: it **drops the `task_attempt` table** to emulate a genuine
pre-6F database, reopens, and shows the marker is absent with defined semantics,
the task row is untouched, and the row is still reconcilable. The additive DDL
recreates the table without operator action.

---

## 17. Legacy compatibility — **VERIFIED**

| check | result |
|---|---|
| LEGACY todo/task behaviour unchanged | **VERIFIED** — `G7`; only the patch's own revision movement |
| LEGACY never writes a marker | **VERIFIED** — `G7`, marker still `null` after a LEGACY write |
| marker is not a universal execution history | **VERIFIED** — `J1`; one row per task |
| no Scheduler constructed in LEGACY/production | **VERIFIED** — §18, 0 sites |
| authority boundary intact | **VERIFIED** — `G8`; `IN_PROGRESS` still authorable only by `claimTask`, and a refused write conjures no marker |
| no `tasks` column changed | **VERIFIED** — DDL diff is additive only |
| no existing store method altered | **VERIFIED** — only two methods added |

LEGACY acquires no new behaviour from the table merely existing. That is the
direct payoff of choosing a marker over a new `TaskStatus`, which would have
touched every switch on the status union.

---

## 18. Static architecture — **VERIFIED**

Transitive runtime-import analysis, type-only edges treated as erased:

```
Scheduler runtime closure (3 internal modules):
  src/task/graph.ts
  src/task/scheduler.ts
  src/task/session-ownership.ts

Scheduler runtime-edges into store.ts : no
  (TaskStore is imported as a TYPE only, so no runtime database edge exists)
TaskStore owns SQLite persistence     : yes (as designed)
modules naming task_attempt           : ["src/task/store.ts"]
production `new Scheduler(` sites     : 0 (Scheduler remains unreachable)
RESULT: CLEAN
```

No `bun:sqlite`, no `Database`, no parallelExecutor, presentation, ACP, TUI,
memory, UI or context dependency anywhere in the Scheduler's runtime closure.
Asserted independently by `H1`–`H5`.

### Methodology finding — my first analyzer was wrong in the dangerous direction

The first pass stripped string literals *before* parsing imports, which deleted
the import specifiers. Every edge vanished and the Scheduler's closure reported
**1 module (itself)** — a spuriously perfect result that would have hidden a real
database edge. This is the same class of error the brief warned about, inverted:
instead of a false runtime dependency I produced a **false clean**.

Fixed by parsing edges from raw text and preserving import specifier strings
while stripping all other literals and comments. A second error in the same pass:
I applied one banned list to both the Scheduler and TaskStore, flagging TaskStore
for owning SQLite — which is its job. The database rule is now **asymmetric**:
asserted in both directions (Scheduler must not reach it; TaskStore must).

**I am recording this because the corrected result is only trustworthy *because*
the first one was wrong.**

---

## 19. Error semantics — **NEW ARCHITECTURE**

| failure | behaviour | test |
|---|---|---|
| marker **write** failure | **propagates**; task stays `IN_PROGRESS`; never reported as success | `I1`, `I2` |
| marker **missing** | not an error; the sole positive evidence of a stranded generation | `B6`, `E14` |
| **generation mismatch** (`>`) | throws with a specific message, before any mutation | `C9`, `I3` |
| **stale revision** | `<` is not stranded, fails safe toward leaving work alone | `C7`, `C8` |
| **task not found** | unchanged 6C classification | 6C suite |
| **reconciliation race** | unchanged; the revision-guarded UPDATE still governs | 6C test 35 |
| **ownership failure** | unchanged 6B refusal, runs *before* the marker is consulted | `E18`, `E18b` |

A failed marker write is **never** converted into "execution succeeded"
(`I1`) and never into a silent release to `PENDING` (`I2`): the turn did run, and
pretending otherwise would lose that fact. The in-memory claim is deliberately
left set after a marker-write failure, so the process does not spin; a successor
recovers the task. **DEFERRED:** 6E did not specify marker-write-failure policy,
so the choice here is documented rather than claimed as locked.

---

## 20. Performance — **VERIFIED, with one honest cost**

| N tasks | in-flight | cycle 1 | cycle 2 | runs |
|---|---|---|---|---|
| 1 000 | 0 | 13.4 ms | 12.3 ms | 2 |
| 1 000 | 1 000 | 602.0 ms | 14.3 ms | 2 |
| 10 000 | 0 | 118.4 ms | 106.0 ms | 2 |
| 10 000 | 10 000 | 6167.1 ms | 106.3 ms | 2 |

Marginal cost isolated at N = 10 000:

| operation | cost |
|---|---|
| marker **read** × N (6F marginal) | 1563.6 ms |
| marker **write** × N (once per turn) | 2367.5 ms |
| `reconcileStranded` × N (6C pre-existing) | 5956.9 ms |

| concern | result |
|---|---|
| O(N²) marker lookup | **no** — 10× tasks → 10.2× time, linear |
| marker query on the PENDING path | **none** — the status filter runs first, so a PENDING-only session does **0** marker reads |
| transaction amplification | **none** — a single upsert, no wrapper, no per-attempt transaction |
| repeated reads | **one point read per in-flight task per cycle** |
| premature optimisation | avoided; findings recorded, not tuned |

**Finding reported rather than silently fixed (DEFERRED):** 10 000 simultaneously
in-flight tasks cost ~1.56 s of marker reads per cycle, ~26% of that
reconciliation's 5.96 s. A single batched read would replace N point reads, but
**6E locked exactly two store methods** and a third would contradict the
artifact, so I did not add one. The dominant cost remains 6C's deliberate
per-task revision-guarded write, which the store documents as intentional for
atomicity.

---

## 21. Tests — **VERIFIED**

`test/phase6f-attempt-recovery.test.ts` — **47 pass / 0 fail**, 170 assertions.

| group | tests |
|---|---|
| A normal return | `A1`–`A3d` (marker written; liveness; no completion; rejected/async-reject/sync-throw split) |
| B restart | `B4`–`B6b` (restart proof, suppression, recovery, crashed-across-restart) |
| C generation | `C7`–`C11` (stale marker, `<`, `>`, revision race, new generation) |
| D crash | `D10`–`D12` (before write, after write, bounded residue) |
| E reconciliation | `E13`–`E18b` (marked, unmarked, per-task, cross-session, PAUSED, terminal, no delete, ownership) |
| F correlation | `F1` (model worked on another task) |
| G store/DB/legacy | `G1`–`G8` (idempotence, unknown task, validation, scoping, reopen, migration, LEGACY, authority) |
| H static | `H1`–`H5` (closure, no status write, no production construction, no leak, single-owner table) |
| I errors | `I1`–`I3` (write failure, no silent release, distinct modes) |
| J not a queue/lock/history | `J1`–`J3` |

Plus `test/phase6c-scheduler.test.ts` — **49 pass**, including the two rewritten
tests (§14).

Gates:

| gate | baseline | after 6F |
|---|---|---|
| `tsc --noEmit` | 28 | **28** (file-level distribution identical; 0 in `src/task`, 0 in `phase6f`) |
| lint `src/task` | 7 | **7** |
| biome on the 4 changed files | — | **0 errors** |
| full suite | 2984 pass / 23 skip / **8 fail** | **3035 pass / 23 skip / 4 fail** |
| 6B prerequisites | 38 pass | **38 pass** |

The 4 remaining failures are all in the baseline set: `peta struktur hidup`
(ARCHITECTURE.html), two `audit #11` vendor/pack hash tests, and `web ssg`. The
other 4 baseline failures (MCP context, PTY exec, `§19` directive cap, message
reload) were **5–18 s timing-dependent flakes** that passed this run. **No new
failures.** No new `src/**` file was added, so the architecture-map test is
unchanged from baseline.

I also had to fix **24 type errors and 4 formatting errors in my own new test
file** — bun does not typecheck, so the suite was green while `tsc` was not.
Both are now clean.

---

## 22. Mutation results — **12 / 12 killed, 0 survivors, 0 HARNESS MISS**

Harness ran the 6F **and** 6C suites together, so a mutant caught only by the
older suite would still count. Sources restored byte-identical after every run
(verified programmatically).

| id | mutation | killed | first killing test |
|---|---|---|---|
| M1 | remove the marker write on normal return | **YES** | `A1` |
| M2 | ignore the marker during reconciliation | **YES** | `A1` |
| M3 | accept **any** marker regardless of generation | **YES** | `C9` |
| M4 | write current task revision instead of claimed generation | **YES** | `C9b` |
| M5 | keep the stale marker on a new generation (`DO NOTHING`) | **YES** | `C11` |
| M6 | revert a marked normal-return task | **YES** | `A2` |
| M7 | re-dispatch after normal return (release to `PENDING`) | **YES** | `A1` |
| M8 | suppress recovery when **any** marker exists in the session | **YES** | `E14b` |
| M9 | remove restart persistence (no-op write) | **YES** | `A1` |
| M10 | clear marker state without leaving it durable | **YES** | `A1` |
| **M11** | **restore the Phase 6D status-only reconciliation** | **YES** | **`A2`** |
| M12 | treat execution return as `COMPLETED` | **YES** | `A1` |

**M11 is the one the brief called most important, and it dies to `A2`** — the
liveness regression. Not to a hand-poked internal, not to a timing artefact.

### **A survivor, honestly reported**

The first run was **11 / 12**: **M8 survived**. I did not classify it
equivalent and did not move on. The cause was a genuine gap in my tests: no test
had one task with a marker *and* a second, unmarked, stranded task, so a
session-wide "something is marked, so nothing is stranded" rule was
undetectable. I added `E14b` (per-task recovery) and `E14c` (cross-session
isolation), and M8 is now killed. **A mutant that survives is a hole in the
suite, not an inconvenient result.**

No **EQUIVALENT MUTANT** was recorded, because none survived. No **HARNESS
MISS** occurred: every replacement applied and changed behaviour.

---

## 23. Findings

| # | finding | class |
|---|---|---|
| F1 | The 6D livelock is fixed; 8-cycle regression and a 6-cycle trace both give `runs == 1` | **VERIFIED** |
| F2 | The marker is the causal mechanism, not a cache: M9/M10 killed, `B4` restarts a fresh instance | **VERIFIED** |
| F3 | **6C test 28 encoded the livelock a second time** and was not flagged by the brief; both old tests demanded the defect | **REAL DEFECT** (test suite) |
| F4 | A *synchronous* throw is a dispatch failure with no marker; only async rejection records one. My first draft had this wrong and the test caught it | **VERIFIED** |
| F5 | My first static analyzer erased import specifiers and reported a false CLEAN | **VERIFIED** (methodology) |
| F6 | 24 type + 4 format errors existed in my new test file while the suite was green | **VERIFIED**, fixed |
| F7 | M8 initially survived, exposing a missing per-task recovery test | **VERIFIED**, fixed (`E14b`, `E14c`) |
| F8 | Marker reads cost ~26% of worst-case reconciliation at 10k in-flight; a batched read would help but a 3rd method would contradict 6E | **DEFERRED** |
| F9 | The locked `<` rule leaves an externally-mutated newer generation unrecovered, awaiting an external authority | **DEFERRED** (by design) |
| F10 | 6E specified no marker-write-failure policy; propagating and keeping the claim is a documented choice | **NEW ARCHITECTURE** |
| F11 | Production Scheduler reachability remains 0 | **VERIFIED** |
| F12 | Model↔task intent remains unprovable; no inference authority added | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| F13 | Crash-between-return-and-write remains one duplicate wide | **VERIFIED**, residue preserved |
| F14 | Cross-process same-session ownership remains unsupported; the marker is not a lock | **DEFERRED** (unchanged from 6B) |

---

## 24. Remaining limitations

| # | limitation | class |
|---|---|---|
| L1 | A death between `runTurn` resolving and the marker write is indistinguishable from a crash in flight; one duplicate may occur. Closing it needs the agent turn transactionally coupled to the database, i.e. a loop redesign | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L2 | The Scheduler cannot prove the model worked on the selected task. Closing it needs a second inference authority nobody authorised | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L3 | Two processes may still attempt the same session. Attempt identity is not ownership | **DEFERRED** (6B) |
| L4 | An external mutation after a completed attempt leaves the newer generation unrecovered | **DEFERRED** (locked rule, §9) |
| L5 | Marker-write-failure policy is a 6F decision, not a 6E-locked one | **NEW ARCHITECTURE** |
| L6 | N marker reads per cycle in the all-in-flight case | **DEFERRED** (§20) |
| L7 | No attempt history: "how many times did this run?" is unanswerable. 6E rejected a counter | **DEFERRED** (6E DD3) |
| L8 | A scheduler sitting on a completed-but-unadjudicated task goes IDLE indefinitely until an external authority acts. Correct per the design; a real operational consideration | **DEFERRED** |

**L8 deserves emphasis for whoever enables this:** a returned attempt with no
verifier response leaves the task `IN_PROGRESS` and the Scheduler `IDLE`. That is
the designed outcome and it is the *right* trade against re-running work
forever, but it means **the Scheduler will not self-heal a task that a model
returned without completing.** Enabling it requires a verifier or operator in
the loop. This is a deployment concern, not a defect.

---

## 25. Exact changed files

| file | change | lines |
|---|---|---|
| `src/task/store.ts` | `task_attempt` DDL; `AttemptMarker` type; `recordAttemptReturned`; `getAttemptMarker` | +83 |
| `src/task/scheduler.ts` | marker write on the normal-return path; positive-evidence reconciliation with the `>` throw | +66 |
| `test/phase6c-scheduler.test.ts` | test `10b` replaced; test `28` replaced (§14) | +45 / −16 |
| `test/phase6f-attempt-recovery.test.ts` | **new**, 47 tests | +1015 |

Nothing else. No new `src/**` file.

---

## 26. Frozen files verification — **VERIFIED UNCHANGED**

`git status --porcelain` over the full frozen set returned **empty**:

`model.ts` (TaskStatus) · `graph.ts` (TaskGraph) · `graph-validate.ts` ·
`readiness.ts` · `session-ownership.ts` · `todo.ts` · `vendor/minicore` ·
`src/ui` · `src/tui` · `src/acp` · `src/presentation` ·
`parallel-executor`

Also unchanged and asserted by tests: `runTurn`'s signature (`H1`), the agent
loop (**not modified at all**), TaskGraph semantics (`H4`), the `TaskStatus`
union (`E15`), and the 6B authority boundary (`G8`, `E18`).

`TaskStatus` still has exactly 8 members. **No new status. No structured bridge.
No lease, heartbeat, counter, or Scheduler DB.** The design was implementable
without touching a single frozen surface, so §32's STOP condition never applied.

---

## 27. Exact commit

```
feat: add execution attempt recovery
```

Single commit containing all 4 files. The hash is the commit that contains this
report; see `git log -1` for the value. **Not pushed.**

---

## 28. Git cleanliness

`git status` after commit: **CLEAN**. `git diff --stat` and `git diff`: empty.
Branch `main`, ahead of `origin/main`, not pushed.

Verification scaffolding (the mutation and architecture harnesses) was written
**outside** the repository, in the temp directory, so no stray files entered the
tree. Both temporary probes (`src/e6probe.ts`, `src/e6c.ts` from Phase 6E) were
confirmed absent.

---

## 29. Scheduler enablement status

# **STILL NOT ENABLED — and 6F was never a request to enable it**

| | |
|---|---|
| production `new Scheduler(` sites | **0** |
| `Scheduler` constructed outside tests | **0** |
| production wiring added | **none** |
| composition-root integration | **not started**, per the brief |
| authority mode | unchanged; LEGACY behaviour verified identical |
| pushed | **no** |

### Phase 6E's 12 acceptance criteria

| # | criterion | result |
|---|---|---|
| 1 | the 6D reproduction converges — `runs == 1` | **MET** — `A2`, 8 cycles |
| 2 | a genuine crash still recovers | **MET** — `B6`, `D10`, `D12` |
| 3 | `IN_PROGRESS` with a matching marker is never reconciled | **MET** — `B5`, `E13` |
| 4 | marker `<` revision is not stranded | **MET** — `C8` |
| 5 | marker `>` revision throws | **MET** — `C9` |
| 6 | ownership uncertainty still refuses | **MET** — `E18`, `E18b` |
| 7 | `COMPLETED`/`CANCELLED`/`FAILED`/`PENDING`/`BLOCKED` untouched | **MET** — `E16` |
| 8 | LEGACY: tsc, lint, full suite show no new errors; 6B/6C/5C green | **MET** — 28/28, 7/7, 4 pre-existing fails, 6B 38, 6C 49 |
| 9 | no `PAUSED`, no new `TaskStatus` | **MET** — `E15`, 8 statuses unchanged |
| 10 | a mutation removing the marker **read** is killed | **MET** — M2 |
| 11 | a mutation removing the marker **write** is killed | **MET** — M1 |
| 12 | production reachability stays 0 | **MET** — §18, §29 |

### 6F's own NO-GO conditions (§31)

None triggered. Specifically verified: normal return cannot redispatch
indefinitely (`A2`); the marker is not in memory (`M9`/`M10`/`B4`); a stale
marker cannot protect a newer generation (`C7`, `M5`); reconciliation does not
rely on status alone (`M11` killed); marker persistence failure is not swallowed
(`I1`); the Scheduler never writes `COMPLETED` (`H2`, `M12`); no intent is
inferred from tools/files/history (§13, `F1`); cross-process safety is **not**
claimed (§16, L3); no frozen surface changed (§26); LEGACY is unchanged (§17);
mutation evidence is valid with 0 survivors and 0 harness misses (§22); the old
6D livelock is killed (M11).

**Passing unit tests alone was not treated as sufficient:** the claim rests on
the killed-M11 evidence, the restart proof, and the crash matrix.

---

## 30. Bottom line

The liveness defect is fixed with the minimum mechanism Phase 6E locked, and the
fix is proven causal rather than incidentally present: the mutant that restores
6D's behaviour is killed by a plain liveness regression, the mutant that removes
persistence is killed, and a fresh Scheduler with no memory declines to
re-dispatch.

Two things I did not smooth over: **6C test 28 encoded the same livelock as 10b**
and the brief only named 10b — correcting only the named test would have left a
green test demanding the defect. And my **first static analyzer reported a false
CLEAN** by erasing the very import specifiers it needed to find edges.

What remains is stated, not hidden: the marker proves an attempt *ended*, never
that the model worked on the task it was given; a crash in the one-write window
still costs a duplicate; and a returned-but-unadjudicated task now waits for a
verifier or operator instead of being re-run forever. **The Scheduler stays
disabled.** Enabling it needs a composition root and a decision about who
verifies completed work — neither of which 6F was asked to do, and the second of
which is the real precondition for turning this on.
