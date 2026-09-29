# PHASE 6G — EXECUTION ATTEMPT ADVERSARIAL AUDIT

Base: `244ce23` (`feat: add execution attempt recovery`)
Audit only. **0 source, 0 test, 0 schema changes.** Scheduler remains disabled.

---

## 1. Executive result

# NO-GO

6F's liveness fix is **real and independently confirmed**. But the mission
question — *does the marker establish safe convergence and safe recovery across
new generations, stale markers, races and partial crashes?* — is **NO**.

**Two HIGH-severity REAL DEFECTs found, reproduced, and deliberately left unfixed.**

| id | defect | severity |
|---|---|---|
| **D1** | A **stale marker from an older generation permanently suppresses recovery and re-dispatch of the current generation.** Reachable with **no crash, no requeue, no attacker** — any write to the task row after an attempt ends. Violates the brief's own invariant **P2**, in **12 of 400** randomized seeds | **HIGH** |
| **D2** | `task_attempt` rows are **orphaned** by `deleteTask` / `deleteSessionTasks`. Reusing a session ID makes `reconcile()` **throw permanently**. Also proves 6E's "impossible" `>` relation **is reachable in normal operation** | **HIGH** |

**Why NO-GO and not CONDITIONAL:** §25 of the brief lists *"stale marker protects
newer generation"* as an explicit NO-GO condition. D1 is exactly that. D2 maps
to *"marker cross-contaminates sessions"*. The verdict follows the criteria, not
a judgement call.

| axis | verdict |
|---|---|
| 6D livelock reproduced independently | **VERIFIED** (pre-6F code from git) |
| 6F converges | **VERIFIED** (`runs == 1`) |
| marker is **causal**, not merely present | **VERIFIED** (A/B differ only in marker visibility) |
| marker survives restart | **VERIFIED** |
| revision guard prevents overwrite | **VERIFIED** |
| concurrent reconciliation safe | **VERIFIED** |
| crash before vs after marker durably distinguished | **VERIFIED** |
| session/task isolation (live) | **VERIFIED** |
| legacy unaffected | **VERIFIED** |
| mutation evidence | **14/14 + 2 extra killed, 0 survivors, 0 harness misses** |
| **generation safety** | **REAL DEFECT (D1)** |
| **session reuse / F-02** | **REAL DEFECT (D2)** |
| static closure, enablement, frozen surfaces | **VERIFIED** |

---

## 2. 6D defect reproduction — **VERIFIED** (HISTORICAL DESIGN EVIDENCE)

Not taken from any report or test. The **actual pre-6F source** was extracted
from `1d185af` into a separate git worktree and executed:

```
old scheduler.ts marker references: 0
old store.ts task_attempt DDL     : 0
old reconcile guard                : if (this.claim?.taskId === task.id) continue

PRE-6F CODE (git 1d185af, verified 0 marker refs)
  cycle 1: runs=1  status=IN_PROGRESS  rev=2
  cycle 2: runs=2  status=IN_PROGRESS  rev=4
  cycle 3: runs=3  status=IN_PROGRESS  rev=6
  cycle 4: runs=4  status=IN_PROGRESS  rev=8
  cycle 5: runs=5  status=IN_PROGRESS  rev=10
  cycle 6: runs=6  status=IN_PROGRESS  rev=12
  => runs = 6
```

Unbounded, with no external mutation, no crash, and a bridge returning
`ok: true` every time. The worktree was removed afterwards.

---

## 3. 6F convergence proof — **VERIFIED**

Same probe, current code: `runs = 1` over 6 cycles; status remains `IN_PROGRESS`;
marker pinned at revision 2. 6F's `A2` runs 8 cycles and agrees. The worktree
comparison rules out "the fix is just a different test harness".

---

## 4. Marker causality — **VERIFIED** (not presence-only)

Two runs, identical in every respect except whether `getAttemptMarker` returns
the row:

```
A  marker PRESENT   : runs=1  status=IN_PROGRESS  marker={"attemptRevision":2}
B  marker SUPPRESSED: runs=5  status=IN_PROGRESS  rev=10
                      (marker row still on disk: true)
```

B's row **physically exists** — proven by reading it back through the unproxied
store — and the livelock still returns. So the behaviour is explained by the
marker **being read**, not by its presence. This is the A/B the brief demanded
and 6F did not have.

| mutation | expected | actual |
|---|---|---|
| remove marker persistence | liveness regression fails | **fails** — `A1`, 20 tests |
| ignore marker during reconciliation | liveness regression fails | **fails** — `A1`, 24 tests |
| pure in-memory marker, per-DB key, zero DB writes | must fail | **fails** — `G6`, `J1` |

---

## 5. Restart proof — **VERIFIED** (both directions)

| | marker | result |
|---|---|---|
| A claims, returns, marker written, A destroyed | present | B: **0 dispatches** over 6 cycles, marker unchanged |
| A claims, marker write fails, A destroyed | absent | B: **recovers** → `PENDING` → re-dispatched |

B is a fresh object with no claim, no history, no reference to A. Correctness
does not depend on in-memory Scheduler state.

**Restart does not lose successful marker evidence (P5)** — property-verified.

---

## 6. Generation safety — **REAL DEFECT (D1)**

The design's three-way rule was reconstructed and each branch attacked:

| case | relation | behaviour | correct? |
|---|---|---|---|
| A | `==` | not stranded | yes |
| B | `<` (older marker) | not stranded | **NO — see D1** |
| C | `>` (newer marker) | **throws** | yes |
| D | multiple historical rows | one row per task, overwritten | see §15 |
| E | no marker | stranded | yes |
| F | marker from another session | `null` | yes |
| G | marker of another task | not visible | yes |

### D1 — stale marker permanently wedges the current generation

**Severity: HIGH. No crash, no requeue, no attacker required.**

```
step 1: attempt returned. status=IN_PROGRESS rev=2 marker={"attemptRevision":2}
step 2: external writer edits the task -> rev=3  marker={"attemptRevision":2}
        marker(2) < rev(3)
step 3: 5 more cycles -> status=IN_PROGRESS rev=3 runs=1
>>> never reverted, never re-dispatched, forever
```

The trigger is *any* write to the task row after an attempt ends: a `todo_write`,
a verifier attaching evidence, an operator renaming the task. All ordinary.

**Root cause.** The `<` branch was justified in 6E as *"a newer generation
exists; do not revert; fails safe against reverts."* But it conflates two
different situations:

- a newer generation **that ran and recorded a marker** (would be `==`, not `<`)
- a newer generation **that has not run at all**

A marker can only ever *equal* the generation that produced it. So `marker < rev`
means, unambiguously, **"the current generation has no marker of its own."**
Treating that as "not stranded" is treating *"an older generation ran"* as
*"this generation is safe"* — which is precisely the reasoning §4 of this brief
forbids: *"any marker exists → task is safe."*

**Second, worse form — a crashed generation is never recovered:**

```
G1: claim -> rev=2, marker(2)
external requeue to PENDING -> rev=3
G2: claim -> rev=4, process crashes before the marker write
marker on disk still names G1: {"attemptRevision":2}
reconcile() -> []      FINAL: status=IN_PROGRESS rev=4
>>> G2 was CRASHED. Recovered? NO -- PERMANENTLY STRANDED
```

A genuine crash is silently discarded because an unrelated *completed* attempt
happened to leave a row behind. This is the exact hole 6F's `D12` missed: `D12`
used a task with no pre-existing marker.

**Corroborated as a violated property, not a hand-built scenario** (§20): P2
fails in **12 of 400** randomized seeds, e.g. *"stale marker 5 suppressed recovery
of generation at rev 6"*.

**Not fixed.** §24 forbids silently fixing production defects.

---

## 7. Revision safety — **VERIFIED** for the claim→marker path

```
§5 rev before claim / after claim / marker : 1 / 2 / 2
§5 invariant marker == post-claim revision : true
§11 marker (claimed gen) / task rev        : {"attemptRevision":2} / 3
§11 external write preserved               : YES
§11 marker blesses newer gen?              : NO (names the generation that ran)
§4C marker > rev                           : THREW
```

The `>` throw is real, fires **before** mutating, and leaves the row untouched.
The marker never masquerades as evidence for a generation it did not run.

**But the reverse direction is the defect:** §6 D1. A marker *older* than the row
is accepted as protection. "If a marker/revision relationship is invalid, apply
the exact locked failure behavior. Never guess" — the implementation does not
guess on `>`, but it **does** guess on `<`, and guesses "safe".

---

## 8. Normal-return semantics — **VERIFIED**

```
§4A exact match (marker==rev): []  status=IN_PROGRESS     (6 cycles, runs=1)
```

`NORMAL RETURN ≠ COMPLETION` and `NORMAL RETURN ≠ AUTOMATIC RETRY` both hold.

**How does T1 ever become schedulable again?** Only via an existing external
transition. The Scheduler has **no** internal path:

- `reconcile()` → marker matches → not stranded → no revert
- discovery → `IN_PROGRESS` is not in the eligible set

Enumerated and confirmed unreachable from inside the Scheduler: `patchTask` /
`updateTask` to `COMPLETED` / `CANCELLED` / `PENDING`, or a fresh claim by
another authority. **No retry, requeue, automatic release or timeout was
invented**, and none exists in the code.

---

## 9. Correlation limitation — **VERIFIED** (IMPOSSIBLE WITH CURRENT CONTRACT)

```
§8 selected T1, model completed T2 : T1=IN_PROGRESS  T2=COMPLETED
§8 marker on T1                   : {"attemptRevision":2}
§8 T1 NOT fabricated COMPLETED    : YES
```

The marker says *"the attempt for T1 ended"* and nothing more. No evidence
written, no status inferred. No inference from tool calls, files, shell, script,
transcript, presentation, or journal — the Scheduler's runtime closure (§18)
reaches none of them, so the possibility is structurally excluded rather than
merely avoided.

---

## 10. Crash matrix — **VERIFIED**

| point | marker | recovered? | total turns | bounded? |
|---|---|---|---|---|
| crash **before** marker write | absent | **yes** | **2** | yes, converges |
| crash **after** marker write | present | no | **1** | no duplicate |

The difference is **durable** — it is the row on disk, not memory. The duplicate
is exactly one and the duplicate records its own marker, so the loop does not
repeat. This is the distinction the brief required and it holds.

---

## 11. Marker persistence failures — **VERIFIED** (NEW ARCHITECTURE)

```
§10 threw to caller         : disk gone          (not swallowed)
§10 marker exists?          : false              (no phantom marker)
§10 task status             : IN_PROGRESS        (not COMPLETED)
§10 claimed as success?     : NO
```

Distinct modes remain distinguishable: write failure (throws), absence (defined,
means stranded), `>` mismatch (throws), stale revision (`<`, not stranded — but
see D1), task-not-found and reconciliation-race (unchanged 6C behaviour),
ownership failure (unchanged 6B refusal, evaluated **before** the marker).

**No persistence failure is ever converted into success or idle.**

---

## 12. Concurrent reconciliation — **VERIFIED**

```
§12 both read marker : [null, null]
§12 A outcome        : RECONCILED     rev now 2
§12 B outcome        : REJECTED_STALE
§12 final            : status=PENDING rev=2
```

Two reconcilers, one generation: the revision guard admits exactly one. The
loser observes newer state and does **not** downgrade. No last-write-wins.

**P3 (reconciliation cannot move a revision backwards)** held across 400
randomized seeds.

---

## 13. State isolation — **VERIFIED** (live sessions)

| probe | result |
|---|---|
| session A / T1 (marked) | `{attemptRevision:5}` |
| session B / **T1** — same task id, different session | `null` |
| session A / **T2** — same session, different task | `null` |
| cross-contamination | **NONE** |

Marker lookup cannot cross session or task dimensions while both are live.
**But isolation breaks across session *deletion*** — see §16 D2.

---

## 14. PAUSED / terminal safety — **VERIFIED**

```
§14 reconciled                        : ["PENDING","PENDING"]   (IN_PROGRESS, VERIFYING only)
§14 non-in-flight states mutated      : NONE
§14 PAUSED exists as a status         : NO (cannot be created)
```

`COMPLETED`, `CANCELLED`, `FAILED`, `PENDING`, `BLOCKED` — including rows that
**carry markers** — are never touched. A marker on a `COMPLETED` task did not
cause any mutation. `PAUSED` remains non-existent; 6E's rejection of an
"attempted but unadjudicated" status still holds.

---

## 15. Multiple-generation history — **VERIFIED** with a caveat

```
§15 generations                  : [2,4,6]   final marker={"attemptRevision":6}
§15 marker advanced per gen      : YES
§15 marker is G3 only            : YES - overwritten
```

**Schema fact (not assumed):** `PRIMARY KEY (session_id, task_id)` means **one
row per task**. G1 and G2 are **overwritten**; they are *not* individually
identifiable or queryable, by design (6E rejected a history, DD3). Bounded:
`O(tasks)`, never an execution log. Harmless in isolation.

**Does overwriting break generation safety?** *Partly — and this is the mechanism
of D1.* Overwriting means a generation's evidence disappears, so the only
surviving row always describes **some** past generation. Reconciliation then has
no way to distinguish "the current generation ran" (`==`) from "an older
generation ran" (`<`). It treats both as safe. Overwriting is therefore a
**necessary precondition** for D1, and the reason D1 needs no crash to fire.

---

## 16. Marker DB failure modes — **VERIFIED**, with one REAL DEFECT (D2)

| attack | behaviour | class |
|---|---|---|
| marker row deleted | read `null` → treated as stranded (defined) | **VERIFIED** fail-safe |
| duplicate insert, same PK | `UNIQUE constraint failed` | **VERIFIED** fail-closed |
| absurd revision written directly (999999) | **THREW** on reconcile | **VERIFIED** fail-closed |
| table dropped, then reopened | table auto-recreated, row gone, `null` | **VERIFIED** |
| brand-new database | `null`, no error | **VERIFIED** |
| partially initialised DB | DDL is `IF NOT EXISTS` per statement; no destructive migration | **VERIFIED** |
| pre-6F DB (no marker table) | opens, rows intact, absence has defined semantics | **VERIFIED** |

### D2 — orphaned markers break session reuse (F-02)

**Severity: HIGH. A fresh session crashes permanently.**

`deleteTask` and `deleteSessionTasks` delete **only** from `tasks`:

```
lifetime 1: final marker = {"attemptRevision":6}
after deleteSessionTasks: orphan rows = [{"session_id":"reuse2","task_id":"t1","attempt_revision":6}]
```

Recreate the **same** session ID. The store hands out the **same canonical task
id** (`t1`) at revision 1, and the orphan is still visible:

```
VARIANT A: new claim rev = 2 (status IN_PROGRESS), orphan marker rev = 6
  THREW: attempt marker revision 6 exceeds task t1 revision 2
VARIANT B: same
  THREW: attempt marker revision 6 exceeds task t1 revision 2   <-- fresh session crashes
```

The new session did nothing wrong. It inherited a deleted session's execution
history, and **every `reconcile()` throws from then on** — the Scheduler cannot
run at all for that session.

**A second consequence, and it falsifies a 6E premise.** 6E §12 justified the `>`
throw as *"data inconsistency → throw, not guess"*, treating the relation as
unreachable through any legitimate sequence. **It is reachable**, via a
documented compatibility API. The defensive net is load-bearing in normal
operation, which means 6E's reachability analysis was wrong.

**Not fixed.** §24.

---

## 17. Legacy isolation — **VERIFIED**

| operation | result |
|---|---|
| legacy create | `PENDING` rev 1, marker `null` |
| legacy `IN_PROGRESS` (permitted in LEGACY) | `IN_PROGRESS`, marker `null` |
| legacy `COMPLETED` | `COMPLETED`, marker `null` |
| legacy title patch | rev delta **exactly 1** (its own write) |
| marker after a full legacy lifecycle | `null` — **LEGACY never writes markers** |
| restart | unchanged |
| `todo_write` | unchanged (6B authority suite green: 38/38) |

The marker table did **not** become a universal execution history. A LEGACY store
cannot write a marker as a side effect of anything. Scheduler still disabled.

---

## 18. Static architecture — **VERIFIED**

```
Scheduler runtime closure (3 internal modules):
  src/task/graph.ts
  src/task/scheduler.ts
  src/task/session-ownership.ts
Scheduler runtime-edges into store.ts : no
  (TaskStore imported as a TYPE only -> no runtime database edge)
TaskStore owns SQLite persistence     : yes (as designed)
modules naming task_attempt           : ["src/task/store.ts"]
marker confined to TaskStore          : yes
production `new Scheduler(` sites     : 0
RESULT: CLEAN
```

No `bun:sqlite`, `Database`, parallelExecutor, presentation, ACP, TUI, memory, UI
or context dependency in the closure. Edges parsed from **raw** text with
type-only edges erased — the earlier 6F analyzer's failure mode (stripping
literals before parsing, which deleted every edge and produced a false CLEAN) is
not repeated, and I re-verified the closure is a real 3, not 1.

---

## 19. Mutation re-audit — **14 / 14 killed, 0 survivors, 0 HARNESS MISS**

6F's count was not trusted. Each mutant: anchor located, replacement non-trivial,
**written to disk and re-read to prove installation**, behaviour compared,
stdout **and** stderr inspected, sources restored byte-identical.

| id | mutation | killed | first failing test |
|---|---|---|---|
| M1 | remove marker write | **YES** | `A1` |
| M2 | ignore marker during reconciliation | **YES** | `A1` |
| M3 | accept any marker regardless of generation | **YES** | `C9` |
| M4 | current task revision instead of claimed generation | **YES** | `C9b` |
| M5 | use any historical marker as valid (`DO NOTHING`) | **YES** | `C11` |
| M6 | skip generation comparison entirely | **YES** | `C9` |
| M7 | revert a marked task | **YES** | `A2` |
| **M8** | **redispatch after normal return** | **YES** | `A1` |
| M9 | marker lookup wrong **session** | **YES** | `A2` |
| M10 | marker lookup wrong **task** | **YES** | `E14b` |
| M11 | remove reconciliation revision guard | **YES** | `B6` |
| M12 | treat marker as `COMPLETED` | **YES** | `A1` |
| M13 | delete marker before reconciliation | **YES** | `A2` |
| M14 | durable marker → in-memory | **YES** | `A3d` |
| M15 | pure in-memory marker, zero DB writes | **YES** | `A3d` |
| M16 | well-behaved in-memory marker, per-DB key | **YES** | `G6`, `J1` |

`scheduler.ts` and `store.ts` byte-identical after every run.

### Two of my own mutants were defective — corrected, then killed

I am recording this because it is the same class of error as 6F's false-CLEAN
analyzer: **a mutant that does not implement its own name.**

- my **M13** only re-read the marker; it deleted nothing → a no-op, and it
  **survived**. Corrected to delete the row on read → **killed by `A2`**.
- my **M14** appended `void attemptRevision` after a real write → a no-op, and it
  **survived**. Corrected to write-then-delete plus an in-memory Map → **killed**.

Had I reported 6F's 12/12 as sufficient and stopped, two mutants would have been
counted as unkillable when they are in fact killable. **M15** is a further
caution: it was killed only *incidentally*, because a `globalThis` Map leaked
across tests sharing a session id — a **false kill** attributable to
contamination, not durability. M16 is the fair version and it is killed
legitimately by tests that read the database directly (`G6`, `J1`).

**No EQUIVALENT MUTANT. No HARNESS MISS.**

---

## 20. Property / state-machine testing — **P2 VIOLATED**

400 deterministic seeds, 7 239 invariant checks. Operations generated randomly:
cycle, repeated cycles, external mutation, requeue, crash-in-window, restart,
verifier completion, explicit reconcile.

| invariant | result |
|---|---|
| **P1** normal return cannot cause unbounded redispatch | **HOLDS** |
| **P2** historical marker cannot authorise a newer generation | **VIOLATED ×12** |
| **P3** reconciliation cannot overwrite a newer revision | **HOLDS** |
| **P4** marker absence cannot override a non-reconcilable state | **HOLDS** |
| **P5** restart does not lose successful marker evidence | **HOLDS** |
| marker revision is a positive safe integer | **HOLDS** |
| no unexpected throw | **HOLDS** |

**P2 failures, verbatim from the harness:**

```
P2 :: seed=1   op=2  stale marker 5 suppressed recovery of generation at rev 6
P2 :: seed=99  op=2  stale marker 7 suppressed recovery of generation at rev 8
P2 :: seed=124 op=2  stale marker 5 suppressed recovery of generation at rev 6
P2 :: seed=136 op=7  stale marker 4 suppressed recovery of generation at rev 5
P2 :: seed=210 op=2  stale marker 6 suppressed recovery of generation at rev 7
```

**A harness defect I found and fixed:** my first P2 check was written
`mk.attemptRevision <= after.revision || true` — **vacuous**, it could never
fail, and it made 6F look clean. Rewriting it to test the real property is what
surfaced D1 as a reproducible invariant violation rather than a hand-built
scenario. Per §24 this is a permitted correction (audit harness defect / false
evidence).

---

## 21. Performance — **VERIFIED** (measurement, not a defect)

| N | in-flight | marker read ×N | claim+write ×N | cycle 1 | cycle 2 |
|---|---|---|---|---|---|
| 1 000 | 0 | 0.0 ms | 0.0 ms | 13.6 ms | 13.0 ms |
| 1 000 | 1 000 | 157.7 ms | 785.0 ms | 164.8 ms | 171.3 ms |
| 10 000 | 0 | 0.0 ms | 0.0 ms | 110.8 ms | 101.3 ms |
| 10 000 | 10 000 | 1637.0 ms | 8428.2 ms | 1788.2 ms | 1701.7 ms |

- **Linear**: 10× tasks → 10.2× time. No O(N²).
- **Marker read vs reconciliation**, stated precisely rather than as one ratio:
  - all-**marked** in-flight (no reverts needed): reads dominate — 1637 ms of
    1788 ms ≈ **92%** of the cycle.
  - all-**stranded** in-flight (reverts needed): `reconcileStranded` writes
    dominate; marker reads are **≈26%** of that path, consistent with 6F's
    independent measurement.
  - **PENDING-only sessions: 0 marker reads** — the status filter precedes the
    read.
- No transaction amplification (single upsert, no wrapper). Nothing optimised,
  per the brief.

---

## 22. F-02 / session reuse — **REAL DEFECT (D2)**

End-to-end at **scheduler level**, as required (not merely a TaskStore test):

```
deleteSessionTasks(reused) removed 1 task row(s)
  ORPHANED marker rows remaining: [{"session_id":"reused","task_id":"t1","attempt_revision":2}]
recreate same session id
  new task id = t1   rev=1
  marker visible = {"attemptRevision":2}   <-- from the DELETED session
reconcile() -> []      cycle() -> already-dispatched
```

With the orphan revision coinciding with the new claim, this run *appeared*
benign. Driving the orphan higher exposes it (§16 D2): the new session's
`reconcile()` **throws** on a task that has done nothing.

**Old task state must not become executable — and it does not** (the old row is
gone). **But the old task's execution *evidence* does survive, and it corrupts the
new session.** F-02 is therefore **NOT safe**, in the marker dimension.

---

## 23. Production reachability — **VERIFIED**

| check | result |
|---|---|
| `new Scheduler(` in `src`/`cli`/`scripts`/`bench` | **0** (one comment mention only) |
| modules importing `task/scheduler` outside tests | **0** |
| `Scheduler` in any script/cli entrypoint | **0** |
| `authority: "SCHEDULER"` construction anywhere in `src` | **0** |
| environment-variable activation | **0** |
| can 6F's marker activate Scheduler behaviour? | **No** — the marker is read only inside `Scheduler.reconcile`; there is no flag, env, or script path to it |
| frozen surfaces changed | **0** |

Scheduler authority is never even *activated* in production.

---

## 24. Invariant matrix

| # | invariant | verdict |
|---|---|---|
| 6D livelock reproducible from pre-6F code | — | **VERIFIED** |
| 6F converges to one execution | — | **VERIFIED** |
| normal return never auto-redispatches | P1 | **VERIFIED** |
| marker is causal, not merely present | — | **VERIFIED** |
| marker survives restart | P5 | **VERIFIED** |
| marker corresponds to the claimed generation | — | **VERIFIED** |
| `>` mismatch throws, never guesses | — | **VERIFIED** |
| **`<` mismatch is not treated as protection** | P2 | **REAL DEFECT (D1)** |
| revision race does not bless the newer generation | P3 | **VERIFIED** |
| no newer state overwritten | P3 | **VERIFIED** |
| persistence failure is explicit, never success | — | **VERIFIED** |
| concurrent reconciliation is safe | — | **VERIFIED** |
| crash before/after marker durably distinguished | — | **VERIFIED** |
| live session/task isolation | — | **VERIFIED** |
| **session reuse / F-02** | — | **REAL DEFECT (D2)** |
| terminal/PAUSED states never mutated | P4 | **VERIFIED** |
| multi-generation markers are generation-specific | — | **PARTIAL** — markers advance correctly, but the single-row schema plus the `<` rule is D1's mechanism |
| model correlation not inferred | — | **VERIFIED** (IMPOSSIBLE WITH CURRENT CONTRACT) |
| legacy unaffected | — | **VERIFIED** |
| static runtime closure correct | — | **VERIFIED** |
| no Scheduler SQLite access | — | **VERIFIED** |
| cross-process not falsely claimed | — | **VERIFIED** (still unsupported) |
| mutation evidence valid | — | **VERIFIED** 16/16, 0 survivors, 0 harness misses |

---

## 25. Findings

| # | finding | class |
|---|---|---|
| G1 | 6D livelock re-reproduced on the actual pre-6F source: `runs = 1..6` | **HISTORICAL DESIGN EVIDENCE** |
| G2 | 6F converges; causality shown by A/B differing only in marker visibility | **VERIFIED** |
| G3 | **D1** — a stale marker from an older generation permanently suppresses recovery and re-dispatch; reachable with no crash; violates P2 in 12/400 seeds | **REAL DEFECT** |
| G4 | **D2** — `task_attempt` rows orphaned by task/session deletion; session reuse makes `reconcile()` throw permanently | **REAL DEFECT** |
| G5 | D2 falsifies 6E's premise that the `>` relation is unreachable through legitimate operation | **REAL DEFECT** (design premise) |
| G6 | The single-row-per-task schema is the *precondition* for D1, not an independent hazard | **VERIFIED** |
| G7 | My first P2 property check was vacuous (`\|\| true`) and masked D1 | **HARNESS MISS** (found and corrected) |
| G8 | Two of my own mutants (M13, M14) did not implement their names and initially survived; corrected, then killed | **HARNESS MISS** (found and corrected) |
| G9 | M15 was killed only by cross-test `globalThis` contamination — a false kill; M16 is the fair version and dies legitimately | **HARNESS MISS** (found and corrected) |
| G10 | Crash-before vs crash-after marker is durably distinguishable; duplicate is bounded to one and converges | **VERIFIED** |
| G11 | Revision guard prevents double mutation and downgrade under concurrent reconciliation | **VERIFIED** |
| G12 | Live session/task isolation is complete | **VERIFIED** |
| G13 | Marker write failure propagates, never becomes success | **VERIFIED** |
| G14 | LEGACY never writes markers across its whole lifecycle | **VERIFIED** |
| G15 | Scheduler production reachability is 0, including authority activation | **VERIFIED** |
| G16 | Frozen surfaces untouched; 0 production/test/schema changes by 6G | **VERIFIED** |
| G17 | Marker read is 92% of an all-marked cycle and ≈26% of an all-stranded path; linear, unoptimised | **VERIFIED** (measurement) |
| G18 | Model↔task intent remains unprovable; no inference authority exists | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| G19 | Cross-process same-session ownership remains unsupported | **DEFERRED** |
| G20 | Crash between return and marker write still costs one duplicate | **DEFERRED** (6E-accepted residue) |

---

## 26. Remaining limitations

| # | limitation | class |
|---|---|---|
| L1 | **D1 is unfixed and reachable in ordinary operation.** Any write to a task after an attempt ends wedges it permanently. Until fixed, the marker cannot be trusted for generation safety | **REAL DEFECT** |
| L2 | **D2 is unfixed.** Session deletion orphans markers; session-ID reuse crashes `reconcile()`. Any fix is a schema/cleanup decision, i.e. redesign — out of scope for an audit | **REAL DEFECT** |
| L3 | A death between `runTurn` resolving and the marker write remains indistinguishable; one duplicate | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L4 | The Scheduler cannot prove the model worked on the selected task | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L5 | A returned-but-unadjudicated task waits for an external authority; the Scheduler will not self-heal it | **DEFERRED** (by design) |
| L6 | Cross-process ownership unsupported; a marker is not a lock | **DEFERRED** |
| L7 | No attempt history, so "how many times did this run?" is unanswerable | **DEFERRED** (6E DD3) |
| L8 | The test harness cannot observe a real process restart, so durability is established by inspecting the database rather than by restarting a process | **DEFERRED** |
| L9 | N marker reads per cycle when many tasks are in flight | **DEFERRED** (measurement) |

**L1 is the blocker.** It is not an edge case: a verifier attaching evidence to a
just-executed task is the single most likely next event in the intended
lifecycle, and it wedges the task with no automatic remedy.

---

## 27. GREEN / CONDITIONAL / NO-GO

# NO-GO

Against §25, verbatim:

| NO-GO condition | present? |
|---|---|
| normal return can redispatch indefinitely | no |
| marker does not survive restart | no |
| **stale marker protects newer generation** | **YES — D1** |
| marker is not causal | no |
| reconciliation can overwrite newer state | no |
| marker failure is swallowed | no |
| **marker cross-contaminates sessions/tasks** | **YES — D2 (via session deletion)** |
| marker causes `COMPLETED` without evidence | no |
| model intent is inferred | no |
| PAUSED/terminal states are mutated | no |
| Scheduler accesses SQLite | no |
| cross-process limitation falsely claimed solved | no |
| any central mutation is a harness miss | no (0, after correcting 3 of my own) |
| production reachability changed | no |
| frozen surface changed | no |

**Two conditions are met. The verdict is NO-GO.**

**What 6G did *not* find.** No regression in the liveness fix; the marker is
genuinely causal and durable; restart, concurrency, isolation, legacy, and error
handling are all sound; mutation evidence is stronger than 6F's (16/16); static
architecture is clean and production reachability is still zero. **D1 and D2 are
holes in the *generation* dimension, not in the *liveness* dimension.** 6F
correctly killed the livelock and then shipped a marker that cannot always tell
which generation it is talking about.

**What must happen next** (6H, and **not** started here): a design decision on
the `<` relation — either the marker must be scoped to the exact generation
(so `<` means "not stranded", i.e. recover), or the design must accept that a
completed attempt can wedge a task and require an external authority to always
be present. Separately, marker cleanup must be added to `deleteTask` /
`deleteSessionTasks`, which is a schema-boundary change. Both are redesigns, so
per §24 and §32 6G stops here and reports.

---

## 28. Exact commit state

```
244ce23  feat: add execution attempt recovery        (base, unchanged by 6G)
```

6G produced **no source, test, or schema change**. The only addition is this
report. The two defects are confirmed still present in `244ce23` and were
**deliberately not fixed**:

```
D1 stale-marker rule still in source : True
D2 no marker cleanup in deleteTask   : True
```

Verification scaffolding lived outside the repository (temp directory), including
a temporary git worktree used to execute the pre-6F source; the worktree was
removed and pruned.

---

## 29. Tree cleanliness

`git status` — **CLEAN**. No `src/**`, `test/**`, or schema file touched by 6G.

Full-suite state is byte-identical to 6F's post-implementation result:

| gate | 6F | 6G |
|---|---|---|
| full suite | 3035 pass / 23 skip / 4 fail | **3035 pass / 23 skip / 4 fail** |
| failing tests | 4 pre-existing | **same 4 pre-existing** |
| task suites | 6B 38, 6C 49, 6F 47 | **unchanged** |

Scheduler remains **disabled, production-unreachable, unwired, unpushed**.

---

## 30. Bottom line

6F fixed the defect it was built to fix, and the evidence that it did is stronger
than 6F itself produced: the old code was re-executed from git to confirm the
livelock, and causality was shown by two runs differing only in whether the
marker is read.

Then 6G broke it twice.

**D1** is the serious one. The reconciliation rule reads a marker older than the
current revision as *evidence of safety* — but a marker can only ever equal the
generation that wrote it, so "older" unambiguously means **"the current
generation left no evidence"**, and treating it as safe means treating "some
earlier attempt happened" as "this task is fine". It needs no crash, no
attacker, and no requeue: one write to the task row after an attempt ends is
enough, and a verifier attaching evidence is exactly the write most likely to
come next. Twelve of four hundred randomized seeds hit it.

**D2** is quieter and arguably nastier, because it is *permanent and total*:
deleting a session orphans its markers, and reusing the session ID makes every
future `reconcile()` throw. It also disproves a premise 6E relied on — that the
impossible `>` relation could only arise from corruption, when in fact a
supported compatibility API produces it routinely.

Neither was fixed, per the audit-only constraint. Both are reported with
reproducers, and the tree is exactly as 6F left it.

The uncomfortable summary: 6F's test suite passed 47 tests, 12 mutants, and a
green type-check, and 6G still found two high-severity defects — because the
suite never combined *a completed attempt* with *a subsequent write to the same
task*, and never combined *session deletion* with *session-ID reuse*. Those are
not exotic sequences. They are the normal life of a task.
