# PHASE 5A — TASKGRAPH SEMANTIC RECONSTRUCTION / DESIGN LOCK

Workspace: `D:\recover\minicode-20260928\reconstruction`
Audited HEAD: `2b2d648` · Working tree: **CLEAN — no code changes, no tests, no commit**

**FORENSIC RECONSTRUCTION + DESIGN VALIDATION. No TaskGraph implementation.**

---

## DECISION

# TASKGRAPH DESIGN BLOCKED

Critical semantics are **UNKNOWN**, not merely unimplemented. Specifically: the
blocker model, `canExecute`, readiness eligibility, cycle algorithm, batch/mutation
semantics, immutability and staleness have **zero surviving evidence**. Per §19,
implementing to "discover" them is explicitly forbidden.

The single most important fact of this phase: **the TaskGraph source existed and was
lost.** It is not an invention, and it is not recoverable from what remains.

---

## 1. Evidence map

### VERIFIED CURRENT SOURCE
| fact | evidence |
|---|---|
| `Task` = `id, sessionId, title, status, order, parentId, dependsOn, blockedReason, verification, evidence, acceptance, provenance, createdAt, updatedAt, revision` | `src/task/model.ts:169-190` |
| `order` is **"Display order only. Mutable; explicitly NOT identity."** | `model.ts:175-176` |
| `TaskStatus` = exactly 8: `PENDING, IN_PROGRESS, VERIFYING, BLOCKED, FAILED, RETRYING, COMPLETED, CANCELLED` — **no `READY`, no `PAUSED`** | `model.ts:55-64` |
| `MAX_DEPENDS_ON = 32` | `store.ts` |
| `dependsOn` entries must be canonical, non-self, non-duplicate **and must already exist in the session** | `store.ts` `validate()` |
| `parentId` must be canonical and non-self — **no existence check** | `store.ts` `validate()` |
| `BLOCKED` requires `blockedReason` | `store.ts` `validate()` |
| `isTaskStatus` is used **only at read**, coercing unknown statuses to `PENDING` | `store.ts:253` |
| `listTasks` orders by `task_order, task_id` | `store.ts:343` |
| No graph / readiness / cycle / topological code anywhere in `src/` or `cli/` | full-tree search |

### RECOVERED ARTIFACT — the decisive finding
`pack.json` is a pre-wipe manifest of the published package `minicode-ai@0.12.0`.
It lists, under `src/task/`:

| file | size | status |
|---|---|---|
| **`graph.ts`** | **9332 B** | **LOST in the wipe** |
| **`graph-validate.ts`** | **5180 B** | **LOST in the wipe** |
| **`readiness.ts`** | **6346 B** | **LOST in the wipe** |
| `address.ts` | 5190 B | present |
| `migrate.ts` | 8282 B | present |
| `normalize.ts` | 7255 B | present |
| `model.ts` | 6911 B | present |
| `store.ts` | 31268 B | present |

So the pre-wipe architecture was **three modules totalling ~20.8 KB**: graph,
graph validation, readiness. All three are gone. This is a *reconstruction* of a
known-lost design, not a greenfield design — and equally, it is not a recovery.

### RECOVERED ARTIFACT — `store.orig.ts` (pre-wipe TaskStore)
Corroborates the *current* store's relation validation verbatim: `dependsOn` may
contain only canonical ids that **exist in this session**, not itself, not
duplicated; `parentId` canonical and not itself; `BLOCKED` requires a reason. Its
comment is explicit that "completed needs evidence" is enforced in `normalizeTodos`
and **must not be duplicated into the store**. It contains **no** graph, readiness
or cycle logic — confirming those lived in the three lost modules.

### RECOVERED ARTIFACT — `p77-repro.ts` / `p77-verify.ts` (pre-wipe **Scheduler**)
These import `D:/git/minicode/src/task/scheduler.ts` — a file that no longer
exists. Recovered API surface:

```ts
new Scheduler(sessionId, { store, runTurn, instruction })
sc.runCycle()            -> { taskId? }
sc.discover()            -> { ready: string[] }   // READINESS, DERIVED
sc.getActiveClaim()      -> claim | null
sc.getLifecycle()        -> lifecycle string
store.enableSchedulerAuthority(sessionId)
store.initialize()
store.claim(sessionId, taskId, revision)   // revision-based claim
TaskStore.close(dir)
```

P77 incident: three tasks stranded permanently in `IN_PROGRESS`; the scheduler sat
**IDLE with zero selectable work and no in-process path back**; constructing a new
`Scheduler` for the same session ("reconciliation") restored liveness and reclaimed
the tasks. `readyTasks` appeared **only** in these two files.

### Terminology survival audit
| term | artifacts | src/cli | reports | verdict |
|---|---|---|---|---|
| `canExecute` | 0 | 0 | 0 | **no evidence anywhere** |
| `blockingDeps` | 0 | 0 | 0 | **no evidence anywhere** |
| `topological` | 0 | 0 | 0 | **no evidence anywhere** |
| `sourceRevision` | 0 | 0 | 0 | **no evidence anywhere** |
| `isReady` / `frontier` | 0 | 0 | 0 | **no evidence anywhere** |
| `readyTasks` | 3 | 0 | 0 | Scheduler layer only |
| `branch` | 11 | 10 | 30 | all **session-branching / git**, never task-graph |
| `ready` | 24 | 47 | 72 | prose ("already"), not an API |

**The blocker names in the brief — `DEP_UNMET`, `DEP_CANCELLED`, `DEP_MISSING`,
`PARENT_MISSING`, `NOT_ELIGIBLE`, `ALREADY_TERMINAL`, `ALREADY_STARTED` — have zero
occurrences in every artifact, source file and report.** They are not reconstructed
history; they are unsourced. I will not adopt them.

### False leads explicitly rejected
- `coverage-phase2.xml`'s 11 "readiness" hits are all `test/release-readiness.test.ts`
  — **release packaging hygiene**, not task readiness. Not merged.
- `src/policy/verifier.ts` `maxCycles`/`onCycle` are the **auto-verifier retry**
  loop, not dependency cycles. Not merged.
- `branch` is session fork / shadow-git, not graph branching.

## 2. Identity boundary

**TaskGraph node identity = `TaskStore.taskId`, verbatim.** RECOVERED + VERIFIED.

The Identity Foundation already guarantees what the graph depends on, and each is
independently tested (Phase 4B):

- one allocator (`model.ts:81`) — G2/G3 below rest on this;
- `taskId` survives reorder (4B lifecycle 1);
- survives restart (4B lifecycle 7);
- node identity must come from `listTasks`, never position/title/ordinal.

## 3. Node model

Evidence supports a **projection**, not a copy. Persistence-only fields that a
graph has no semantic use for: `sessionId` (fixed per snapshot), `createdAt`,
`updatedAt`, `provenance`, and the whole `verification`/`evidence`/`acceptance`
trio (which belong to the *completion* gate, explicitly out of TaskGraph scope per
"must not verify task completion").

Candidate graph node (labelled **NEW ARCHITECTURE** — the lost source is not
recoverable, so shape is a design proposal constrained by evidence):

| field | basis |
|---|---|
| `id` | **VERIFIED** — canonical identity |
| `status` | **VERIFIED** — needed for dependency satisfaction & readiness |
| `order` | **VERIFIED** — the only evidenced ordering key |
| `parentId` | **VERIFIED** — structural relation |
| `dependsOn` | **VERIFIED** — execution relation |
| `title` | only for diagnostics; **must never** participate in identity or ordering |
| `blockedReason` | optional; the store guarantees it is present when `BLOCKED` |

`revision` is deliberately **excluded from node identity** and belongs to staleness
(§13), not to the node.

## 4. Ordering

The brief's historical note — "graph order = `Task.order` ASC then `taskId` ASC" —
is **corroborated** by the only surviving ordering implementation,
`listTasks`: `ORDER BY task_order, task_id`. Classified
**RECONSTRUCTED FROM HISTORY + independently consistent with VERIFIED source**;
it is not proven to be what `graph.ts` did, so the *key* is high-confidence and the
*attribution* is inferred.

Normative: `title`/`content` **must never** be an ordering key. Ordering is total
and deterministic because `task_id` is unique. (`model.ts:175` explicitly marks
`order` as "display order only… NOT identity", so ordering must never be read as
identity.)

## 5. Parent semantics

**Structural hierarchy. Distinct from `dependsOn` and must not be collapsed (G9).**

| case | VERIFIED behaviour |
|---|---|
| parent missing | **PERMITTED AND PERSISTABLE.** No existence check exists (`store.orig.ts:323-329` and current `store.ts` agree). Empirically: `t1.parent=t99` persists with no such row. |
| parent self-reference | **REJECTED** at write: `TASK_INVALID_DEPENDENCY "task cannot be its own parent"` |
| parent cycle | **PERMITTED AND PERSISTABLE** — empirically `t1.parent=t2, t2.parent=t1`. No store-level check exists. |

**A missing parent is therefore a legitimately reachable stored state, and the
graph is the only layer that can interpret it.** Whether it makes the graph invalid
or merely blocks a node is **UNKNOWN** (the `PARENT_MISSING` blocker name is
unsourced).

## 6. Dependency semantics

**Execution dependency. Existence is enforced at write time** — this is the key
asymmetry versus `parentId`:

| case | VERIFIED behaviour |
|---|---|
| dependency non-canonical | REJECTED `TASK_INVALID_DEPENDENCY` |
| dependency self | REJECTED `"task cannot depend on itself"` |
| dependency duplicate | REJECTED `"duplicate dependency: …"` |
| > 32 dependencies | REJECTED `"dependsOn exceeds 32"` |
| **dependency missing** | **REJECTED `"unknown dependency: …"`** — a *missing dependency cannot exist in persisted data* |
| **dependency cycle** | **PERMITTED AND PERSISTABLE** — empirically `t1.deps=[t2], t2.deps=[t1]` |

**Consequence for §16: "missing dependency" is NOT a reachable invalid-graph state**
— it is already prevented at the persistence boundary. Any graph that reports a
missing dependency is observing corrupt or foreign data.

**"Dependency satisfied" is UNKNOWN.** Only `Scheduler.discover().ready` survived,
and that is the Scheduler's *selection*, not a persisted predicate. The brief's
candidate "only `COMPLETED` satisfies a dependency" is **INFERRED, not evidenced**,
and status names alone must not be used to derive it (`PAUSED` and `READY` do not
even exist in the current vocabulary). Determining it per status — including
`CANCELLED`, `FAILED`, `RETRYING` — **requires the lost `readiness.ts`**.

## 7. Readiness

**Partially recoverable, and the central blocker for this gate.**

What survives: `Scheduler.discover().ready: string[]` — a **derived list of task
ids**, not a status. So readiness is at least a *derived* concept, computed by
`readiness.ts` from a snapshot.

What is lost: the eligibility predicate itself (`eligibleForReadiness`), the
`BLOCKED → READY` transition rule, and the exact blocker effects.

**Hard conflict, resolved against the brief (§20: current Identity Foundation
wins).** The brief's candidate "`PENDING` / `READY`" cannot hold, because:

- `READY` is **not a member of `TaskStatus`** (VERIFIED, 8 values);
- `createTask({ status: "READY" })` is **accepted at write and silently coerced to
  `PENDING`** — measured: the returned task's status is `PENDING`, and it stays
  `PENDING` after re-opening the database.

So a *stored* `READY` is indistinguishable from `PENDING` after a round trip.
**Readiness must be purely derived.** A `READY` status is a category error against
the current foundation and must not be introduced by TaskGraph.

Also **UNKNOWN**: whether "eligible to become ready" and "currently executable" were
two concepts or one (§8/§9). `canExecute` has **zero occurrences anywhere**.

## 8. Can-execute semantics

**UNKNOWN — zero evidence.** `canExecute` appears in no artifact, source or report.

`ready` and `canExecute` may have been the same thing, two layers, or
`canExecute` may never have existed. The brief's sub-cases (ready-with-blocked-
dependency, stored-READY-with-blocker, completed/cancelled/missing dependency)
**cannot be answered from evidence**, and one of them (stored `READY`) is already
ruled out by §7. No boundary can be defined.

## 9. Blocker model

**UNKNOWN — no evidence. I will not invent an enum.** Every candidate name in the
brief has zero occurrences. Even the *shape* is unevidenced: nothing establishes
whether blockers were objects, codes, or derived predicates; whether several could
coexist; or what ordering they were emitted in. Adopting the brief's list would be
fabrication dressed as reconstruction.

The only defensible statement: a graph **will** need to explain why a node is not
ready (missing parent is provably reachable, §5), but the vocabulary is unrecovered.

## 10. Cycle semantics

**UNKNOWN — and this is the most consequential gap.**

- Both cycle kinds are **empirically persistable today** (parent cycle and
  dependency cycle, §5/§6). Nothing prevents them.
- The pre-wipe `graph-validate.ts` (5180 B, LOST) existed specifically to handle
  validation, so cycle handling almost certainly lived there.
- The brief mentions "candidate post-mutation cycle validation, iterative DFS" as
  *historical notes*. Those notes are **not present in any artifact I can reach**,
  and per §10 I treat them as unverified. **No algorithm is chosen.**

Unresolved: whether a cycle invalidates the whole graph, marks only the cycle
members, or is reported as a diagnostic; and whether validation happens pre- or
post-mutation. Until the lost validator's contract is recovered, TaskGraph cannot
be specified for data that the store currently accepts.

## 11. Batch / mutation semantics

**UNKNOWN.** No `batch`, batch-create or batch-mutation API for tasks survives
(`batch` hits are unrelated). The brief's candidates (existing refs, earlier-declared
refs, forward-ref rejection, atomicity) are **unsourced** — notably "forward
references are rejected" is contradicted in spirit by the store, which *requires* a
dependency to **already exist**, implying forward references are impossible rather
than "rejected by a batch rule".

The batch vocabulary should be treated as out of scope for a derived graph: TaskGraph
consumes a snapshot; batch creation is a TaskStore concern, not a graph concern.

## 12. Immutability

**UNKNOWN.** The brief's "TaskGraph = immutable derived object" is a reasonable
design position and is *consistent* with the only surviving evidence
(`discover()` computing a fresh `ready` list), but no source states it. Classified
**RECONSTRUCTED, low confidence**.

The **safety constraint is not unknown** and is binding regardless: a derived graph
must never become a second persistence authority (G4, G5). This follows from the
Identity Foundation, where `TaskStore` is the single authority.

## 13. Staleness

**UNKNOWN.** `sourceRevision` has **zero occurrences anywhere**. The brief's
description of it as a "weak staleness signal" is unsourced.

What *is* evidenced: `Task.revision` increments on every successful mutation
(`model.ts:188-189`), and the pre-wipe store had a revision-based
`claim(session, taskId, revision)` — so per-task revision existed and was used for
optimistic concurrency **in the Scheduler**, not in any graph.

Whether a graph is rejected when stale, merely flagged, or safely reusable is
**UNKNOWN**. A snapshot-level revision does not exist in the recovered
`TaskSnapshot`. Not to be designed without evidence.

## 14. Cancellation / deletion boundary

Respects the Identity Foundation: **omission ≠ deletion** (D7 retain, verified 4A.4 I).

- `CANCELLED` is a terminal `TaskStatus` (VERIFIED). A cancelled task **remains a
  node** — omission never removes anything, so the graph cannot drop it.
- A cancelled node's effect on dependents is part of "dependency satisfied"
  (**UNKNOWN**, §6) — this is precisely why dependency satisfaction cannot be
  guessed: `CANCELLED` could plausibly block, unsatisfy, or be treated as terminal.
- Explicit `deleteTask` exists on the store but **nothing in the todo path calls
  it**; deletion semantics remain an open product decision and are not redesigned
  here.

## 15. Branch semantics

**EMPTY / out of scope, on evidence.** Every surviving `branch` occurrence is
session-forking (`test/session-branch.test.ts`, `branchSession`) or git/shadow-git.
There is **no** evidence of task-graph branch or fork semantics. Do not introduce
branch-aware graph identity.

## 16. Graph validity

Provable from evidence:
- **Reachable invalid state:** parent cycle, dependency cycle, missing parent (§5/§6).
- **NOT reachable:** missing dependency (rejected at write) — so it is not a
  validity condition, it is an integrity violation if ever observed.

Unknown: which of the reachable states invalidate the whole graph versus
localise to the offending nodes; whether a graph with a cycle is "invalid" or
"valid-but-blocked" (the brief lists both as candidates). `duplicate node
identity` cannot occur (PRIMARY KEY `(session_id, task_id)`); `duplicate
relationship` is prevented by the `seen` set in `validate()`.

## 17. Representative examples

Only the rows the evidence supports are answered. Blank cells are **UNKNOWN**, not
"same as above".

| # | graph validity | readiness | blocker |
|---|---|---|---|
| 1. `B→A`, `C→B` | likely valid (no cycle) | **UNKNOWN** — is `A` ready? are `B`,`C`? | **UNKNOWN** |
| 2. `B.parent=A`, `B→C` | valid (mixed relations allowed) | **UNKNOWN** | **UNKNOWN** |
| 3. `A→B`, `B→A` | **cycle — persistable today**; validity treatment **UNKNOWN** | **UNKNOWN** | **UNKNOWN** |
| 4. `A→missing` | **not constructible** — rejected at write | n/a | n/a |
| 5. `A→cancelled` | valid (CANCELLED is a status) | **UNKNOWN** — does CANCELLED satisfy, block, or unsatisfy? | **UNKNOWN** |
| 6. `B.parent=A`, `A.parent=B` | **cycle — persistable today**; treatment **UNKNOWN** | **UNKNOWN** | **UNKNOWN** |

## 18. Invariant set (normative candidates)

| # | invariant | status |
|---|---|---|
| G1 | one node per canonical `taskId` | NEW ARCHITECTURE (sound) |
| G2 | graph never allocates a `taskId` | **VERIFIED enforceable** (one allocator) |
| G3 | graph never changes task identity | NEW ARCHITECTURE (sound) |
| G4 | graph derives from one TaskStore snapshot | NEW ARCHITECTURE (sound) |
| G5 | graph does not mutate persistence | NEW ARCHITECTURE (sound) |
| G6 | dependency direction is deterministic | NEW ARCHITECTURE (sound) |
| G7 | cycles cannot silently appear as a valid graph | **REQUIRED, unenforced today** |
| G8 | missing relations cannot silently resolve | **REQUIRED**; deps already enforced at write, parents are not |
| G9 | parent and dependency semantics stay distinct | NEW ARCHITECTURE (sound) |
| G10 | readiness is deterministic | **UNKNOWN** — no predicate recovered |
| G11 | graph ordering never uses title/content | NEW ARCHITECTURE (sound) |
| G12 | omission is not deletion | **VERIFIED** (4A.4 I) |
| G13 | graph cannot execute tasks | NEW ARCHITECTURE (sound) |
| G14 | graph cannot complete tasks | NEW ARCHITECTURE (sound) |
| G15 | graph never becomes a second persistence authority | NEW ARCHITECTURE (sound) |
| G16 | graph never derives identity from position/ordinal/counter | **VERIFIED enforceable** |

## 19. Conflicts

| # | recovered/asserted | current Identity Foundation | resolution |
|---|---|---|---|
| 1 | blocker enum (`DEP_UNMET`, `PARENT_MISSING`, …) | no basis anywhere | **REJECTED as unsourced** — Foundation wins |
| 2 | `canExecute` concept | no basis anywhere | **UNKNOWN** |
| 3 | stored `READY` status | `READY` ∉ `TaskStatus`; coerced to `PENDING` | **REJECTED** — readiness must be derived |
| 4 | `sourceRevision` staleness | no snapshot-level revision exists | **UNKNOWN** |
| 5 | `readyTasks` as the readiness API | survives only in the **Scheduler** layer | **REASSIGNED** — not a TaskGraph API |
| 6 | graph order = `order` then `taskId` | consistent with `listTasks` | **ACCEPTED**, attribution inferred |
| 7 | forward-ref rejection in batch | store requires deps to already exist | **superseded** — forward refs are impossible, not "rejected" |

## 20. Recovery / new-architecture classification

- **RECOVERED (artifact-backed):** existence and size of `graph.ts`,
  `graph-validate.ts`, `readiness.ts`; `Scheduler.discover().ready` as a derived id
  list; pre-wipe relation validation rules; per-task `revision`; revision-based
  `claim`.
- **RECONSTRUCTED:** the three-module split; readiness being derived; graph ordering
  key; immutability posture (low confidence).
- **VERIFIED CURRENT SOURCE:** everything in §1's first table.
- **NEW ARCHITECTURE (proposed, not recovered):** the node projection shape, G1–G9,
  G11, G13–G16.
- **UNKNOWN:** blocker model, `canExecute`, readiness predicate, cycle algorithm and
  outcome, batch semantics, staleness policy, branch semantics (empty).

## 21. Implementation prerequisites

Before TaskGraph can be specified, the following must be **recovered or decided by
the product owner** — not guessed:

1. **Cycle contract (highest risk).** Both cycle kinds are persistable today. Decide:
   reject at write, reject the graph, or block members? Iterative DFS is an
   implementation choice and must not be inherited from an unverifiable note.
2. **Dependency satisfaction table.** Per status, including the terminal-ambiguous
   `CANCELLED`, `FAILED`, `RETRYING`. This single table determines most of the graph.
3. **Readiness predicate.** Given §7, it must be derived; the `PENDING → ready` rule
   and blocker interaction are the substance.
4. **Blocker vocabulary.** Only if needed, and derived from 2 and 3 — not adopted
   from the brief.
5. **Whether `canExecute` exists at all** as a distinct concept, and if so its
   boundary from readiness.
6. **Missing-parent treatment** (a provably reachable state).
7. **Staleness policy** — whether a snapshot-level revision is introduced, and
   whether a stale graph is rejected or flagged.
8. **Explicit confirmation that batch/mutation is out of TaskGraph scope.**

Recovering the three lost files (npm `minicode-ai@0.12.0` tarball, VCS history, or
an older backup) would convert items 1–5 from UNKNOWN to RECOVERED and is by far
the cheapest path to a READY gate. **That search should precede any design work.**

---

## Phase discipline

- **No source changes, no tests, no commit.** Only this report was created (untracked).
- HEAD unchanged at `2b2d648`; working tree otherwise CLEAN.
- Specimen `D:\git\minicode` never accessed or modified; all probes ran in isolated
  temp directories under a redirected `cwd`.
- TaskGraph **not** implemented. Scheduler **not** started. Deletion semantics
  **not** redesigned. TaskStore **not** changed.
