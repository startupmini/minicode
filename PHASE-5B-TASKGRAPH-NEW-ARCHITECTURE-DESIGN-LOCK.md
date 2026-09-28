# PHASE 5B — TASKGRAPH NEW ARCHITECTURE DESIGN LOCK

Workspace: `D:\recover\minicode-20260928\reconstruction`
Audited HEAD: `ac53069` · **Design only: 0 source, 0 test, 0 commit changes**

## 0. Precondition deviation (flagged, non-blocking)

The brief expected "forensic recovery reports committed, working tree CLEAN".
Actual: `5A.1` and `5A.2` reports are **untracked**, HEAD is `ac53069`, tree is
**not CLEAN**. I offered to commit them at the end of 5A.1; the offer stands. It
does not affect this phase, which writes no code.

---

## DECISION

# TASKGRAPH DESIGN READY

All twelve gate areas have **explicit decisions** (§25). Nothing critical remains
UNKNOWN. Every decision is labelled in §26; the contract as a whole is
**NEW ARCHITECTURE**, not a reconstruction.

---

## AMENDMENT 5C.1 — `not-eligible` DID NOT MEAN NOT-ELIGIBLE

**Status: ACTIVE. Supersedes the four-state `NotReady` union in §9.**
Issued in Phase 5C.1 (`PHASE-5C.1-NOTREADY-SEMANTIC-CORRECTION-REPORT.md`),
before any downstream consumer existed.

**The defect.** This document locked a four-state union (§9) and, in the same
document, defined eligibility to include `BLOCKED` (§8). Those two decisions are
inconsistent for exactly one input: **a durably-`BLOCKED` task with zero derived
blockers**. That task *is* eligible — §8 says so explicitly — but it is never
ready, because §8 also requires `status === "PENDING"`. The union had no member
for it:

| candidate member | why it is wrong |
|---|---|
| `ready` | false — the task is not ready |
| `blocked` | false — `blockers` would be empty, a self-contradiction |
| `not-eligible` | false — the task IS eligible; this is the negation of §8 |

The 5C implementation was forced to answer `not-eligible`, i.e. to report a task
as ineligible while `eligibleTasks()` simultaneously listed it. **That is a
contract that lied, and the implementation was right to flag it rather than make
the enum fit.**

**The correction.** `eligible` and `ready` are distinct predicates, so the public
API now names both (§9). The union becomes five states. This is a
**NEW ARCHITECTURE correction** — not a recovery, and not a reinterpretation of
a lost original. Nothing else in this document changes.

**What is deliberately NOT amended:** `eligibleForReadiness`, `isReady`,
dependency semantics (§7), cycle semantics (§11), validity (§10), blockers
(§9), ordering (§12), immutability (§14–16) and the public API list (§19). The
fault was in the *reason vocabulary*, not in the state model.

---

## 1. Purpose

TaskGraph answers **six read-only questions** over exactly one TaskStore snapshot:

1. `Which tasks exist in this session's snapshot?`
2. `What depends on what?` (execution edges)
3. `What is nested under what?` (structural edges)
4. `Which tasks are eligible / currently ready?`
5. `Why is a task not ready?`
6. `Is this snapshot structurally valid, and if not, why?`

Deliberately excluded: claiming, executing, scheduling, verifying completion,
persisting, or choosing what to do next. Those are the Scheduler's (§17).

The graph separates three concerns that are easy to conflate:
**graph semantics** (structure) → **readiness semantics** (derived state) →
**execution semantics** (not in this component).

## 2. Evidence boundary

| I use as fact | I refuse to treat as fact |
|---|---|
| Verified TaskStore schema, statuses, ordering, revision, relation validation, `getSnapshot` | the brief's `canExecute`, `DEP_*`, `blockingDeps`, `topological`, `sourceRevision`, `eligibleForReadiness` — **zero occurrences in any artifact, source or report** (5A/5A.1) |
| Verified Identity-Foundation invariants (4A.1→4C) | "only COMPLETED satisfies" — plausible, **unevidenced**, now decided explicitly in §7 |
| The recovered `discover().ready` idea (Scheduler, 5A) — readiness is *derived* | that its rules, vocabulary or API shape are known — they are not |

**No design statement below is presented as historical recovery.** 5A/5A.1/5A.2
proved the original graph is permanently gone.

## 3. Node identity

**`GraphNode.id = TaskStore.taskId`, verbatim.** *(VERIFIED that this is sound:
one allocator, ids never reused, 4B lifecycle.)*

- Exactly one node per canonical `taskId` in the snapshot.
- Duplicate ids are **impossible** in valid data (PRIMARY KEY `(session_id,
  task_id)`); if one is ever observed the graph reports `DUPLICATE_NODE` and is
  invalid — never silently merged.
- Identity is **never** derived from title, content, order, ordinal or array
  position.

**Decision:** the constructor takes `TaskSnapshot` and keys nodes by `task.id`. A
task id absent from the snapshot has no node (and a relation pointing at it is a
*dangling* reference, §9).

## 4. Node model

A **projection**, not a row copy — the graph stores only what it reasons about.

```ts
interface GraphNode {
  id: string              // canonical taskId (identity)
  title: string           // display only; never identity, never ordering
  status: TaskStatus      // durable, from the snapshot
  order: number           // durable display/exec order; never identity
  parentId: string | null // structural edge, as stored
  dependsOn: readonly string[] // execution edges, as stored
  blockedReason: string | null   // durable; present iff status === BLOCKED
  revision: number        // for staleness hinting only (§14)
}
```

Deliberately **excluded** from the node: `sessionId` (graph is single-session by
construction), `createdAt`/`updatedAt`, `provenance`, and the whole
`verification`/`evidence`/`acceptance` trio — those belong to the *completion*
gate, which TaskGraph must not perform (§1).

**Decision:** defensive copy of the projected fields at construction. The graph
never holds a live reference to TaskStore rows.

## 5. Parent semantics — **structure, not execution**

| property | value |
|---|---|
| direction | child → parent (`node.parentId`) |
| meaning | **structural containment / hierarchy** |
| cardinality | at most one parent per node *(VERIFIED — `parentId` is a single nullable column)*. Children per parent: a constant `MAX_PARENT = 64` exists (`store.ts:53`) and is exported for tests (`store.ts:697`) but is **enforced at no call site** — an exhaustive 433-file `.ts` scan found only those two references, and the create/update validator (`store.ts:378-428`) contains no child-count check. **The child count per parent is therefore currently UNBOUNDED** *(VERIFIED)* |
| self-reference | **impossible** — rejected at write (`TASK_INVALID_DEPENDENCY "task cannot be its own parent"`) *(VERIFIED)* |
| missing target | **possible today** — no existence check on `parentId` *(VERIFIED)* |
| cycles | **possible today** *(VERIFIED by probe)* |
| display | a containment forest rooted at parentless tasks |

**Latent gap recorded, deliberately not fixed here:** `MAX_PARENT` is a dead
constant — the intended 64-children cap is not in force, so the containment forest
has no width bound. TaskGraph must therefore treat fan-out as unbounded (§21).
Enforcing it would be a **TaskStore change, which is out of scope for 5B**; it is
logged here for a future phase rather than silently patched.

**Key design decision:** `parentId` is **not an execution gate**. A task is not
made un-ready because its parent is unfinished. Parent governs *structure*
(§9 validity), dependency governs *execution* (§7 readiness). This keeps the two
relations genuinely distinct rather than two spellings of one idea.

**Behaviour per case:**

| case | decision |
|---|---|
| parent exists | normal containment edge |
| parent missing | graph **INVALID** (`DANGLING_PARENT`); the node is not eligible to be reported ready |
| parent self-reference | graph **INVALID** (`SELF_PARENT`) — defence in depth; already rejected at write |
| parent cycle | graph **INVALID** (`PARENT_CYCLE`) — containment must be a forest; the notion "outermost ancestor" is ill-defined inside a cycle |

## 6. Dependency semantics — **execution, not structure**

| property | value |
|---|---|
| direction | dependent → dependency (`node.dependsOn`) |
| meaning | "this task must not start until the dependency is done" |
| cardinality | 0..`MAX_DEPENDS_ON` (= 32) per node *(VERIFIED)* |
| self-reference | **impossible** — rejected at write *(VERIFIED)* |
| duplicates | **impossible** — rejected at write *(VERIFIED)* |
| missing target | **impossible** — rejected at write with `unknown dependency` *(VERIFIED)* |
| cycles | **possible today** *(VERIFIED by probe)* |

**Key distinction (§16):** a *valid graph* here means the relation is well-formed
and interpretable. A dependency cycle is a well-formed relation that is
**unsatisfiable**, not a malformed one — so it does **not** invalidate the graph
(§10). It makes its members permanently unready (§7).

**This is the deliberate asymmetry:** cycles are *not* all the same. A parent cycle
destroys structure; a dependency cycle creates a deadlock.

## 7. Dependency satisfaction — the core decision

`dependencySatisfied(dep) ⟺ dep.status === "COMPLETED"`

**Chosen over alternatives, with every current status analysed:**

| dep status | satisfied? | class | rationale |
|---|---|---|---|
| `COMPLETED` | **yes** | — | the only evidence of finished work |
| `PENDING` | no | temporary | will be worked |
| `IN_PROGRESS` | no | temporary | in flight |
| `VERIFYING` | no | temporary | finishing |
| `RETRYING` | no | temporary | will attempt again |
| `BLOCKED` | no | temporary | durably blocked by an external cause; may clear |
| `FAILED` | no | **terminal** | will not proceed without an explicit decision |
| `CANCELLED` | no | **terminal** | abandoned by intent |

**Why only `COMPLETED`:** the snapshot carries no verification/evidence inside the
graph (excluded in §4), so the graph has no stronger signal available; and
treating `CANCELLED`/`FAILED` as satisfying would silently claim work exists that
does not. Being stricter is safe: the cost of a false negative is a task that stays
unready, whereas a false positive executes dependent work on a false premise.

**Terminal vs temporary is load-bearing:** it is what makes a blocker
actionable (§8) — a temporary blocker may resolve itself; a terminal one requires
an operator to retry, re-scope, or remove the dependency.

**Not designed for `PAUSED`** — it is not in `TaskStatus` (5B's own text
references it; the vocabulary has no such value). **`FAILED` is designed for** — it
*is* a current, storable status.

## 8. Readiness — derived, never durable

Because `createTask(status:"READY")` is coerced to `PENDING` *(VERIFIED)*, a
durable `READY` is impossible. Readiness is therefore **computed**.

**Two distinct concepts**, as the brief invites:

```
eligibleForReadiness(n)  =  n.status ∈ { PENDING, BLOCKED }
isReady(n)               =  n.status === PENDING ∧ blockers(n) = []
```

| status | eligible? | currently ready? | `notReadyReason` (no blockers) | why |
|---|---|---|---|---|
| `PENDING` | yes | iff no blockers | `ready` | the normal ready case |
| `BLOCKED` | **yes** | **never** | **`eligible-not-ready`** | eligible, but the durable state wins — no contradiction (§13) |
| `IN_PROGRESS` | no | no | `not-eligible` | already started; readiness is about *starting* |
| `VERIFYING` | no | no | `not-eligible` | already started |
| `RETRYING` | no | no | `not-eligible` | already attempted |
| `COMPLETED` | no | no | `not-eligible` | terminal |
| `CANCELLED` | no | no | `not-eligible` | terminal |
| `FAILED` | no | no | `not-eligible` | terminal |

With blockers present, `blocked` outranks the status column above for **every**
row — including `BLOCKED` itself, so a `BLOCKED` task that also waits on a
dependency reports `blocked`, not `eligible-not-ready`.

**`BLOCKED` being eligible-but-not-ready is the key move.** It lets the graph
model "this could become ready once verification is fixed" without ever claiming a
durably-BLOCKED task is ready — precisely the contradiction §13 forbids.

**`readyTasks()` is defined only over a valid graph** (§10); an invalid graph
returns an empty list plus diagnostics, never a partial "ready" answer.

## 9. Blockers — minimum sufficient structure

```ts
type Blocker = {
  kind:
    | "DEPENDENCY_UNSATISFIED"   // relation  = dependency
    | "DEPENDENCY_TERMINAL"      // relation  = dependency, permanent = true
    | "DEPENDENCY_CYCLE"         // relation  = dependency, permanent = true
    | "DANGLING_DEPENDENCY"      // relation  = dependency  (invalid persistence)
    | "PARENT_MISSING"           // relation  = parent
    | "PARENT_CYCLE"             // relation  = parent
    | "SELF_REFERENCE"           // relation  = parent | dependency
  relation: "dependency" | "parent"
  taskId: string        // the task causing it ("" for SELF_REFERENCE on itself)
  permanent: boolean    // temporary vs permanent (§7)
  detail: string        // human-readable, non-contractual
}
```

Every category is justified by a **measured** reachable condition, not by taste:
`DEPENDENCY_*` ← §7; `DEPENDENCY_CYCLE` ← cycle probe; `PARENT_MISSING` /
`PARENT_CYCLE` ← parent probe; `DANGLING_DEPENDENCY` ← integrity violation if
ever observed; `SELF_REFERENCE` ← defence in depth.

**Deliberately not modelled as blockers:** status. A cancelled or failed task is
not "blocked", it is **not eligible**. Conflating them would produce the §13
contradiction. The public surface therefore answers *"why not ready?"* with a
discriminated union. **AMENDED by 5C.1 — FIVE states, not four:**

```ts
type NotReady =
  | { kind: "ready" }
  | { kind: "eligible-not-ready"; status: TaskStatus }   // ADDED by 5C.1
  | { kind: "not-eligible"; status: TaskStatus }
  | { kind: "blocked"; blockers: readonly Blocker[] }
  | { kind: "graph-invalid"; diagnostics: readonly Diagnostic[] }
```

`eligible-not-ready` exists for one input: a durably-`BLOCKED` task with zero
derived blockers. It is eligible (§8) and not ready (§8), and without a name for
that the union was forced to call it `not-eligible` — contradicting
`eligibleTasks()`. See AMENDMENT 5C.1 above.

For a valid graph and a known id the five are exhaustive and mutually exclusive:

| condition | state |
|---|---|
| no blockers, `PENDING` | `ready` |
| any blocker (any status) | `blocked` |
| no blockers, eligible, not `PENDING` | `eligible-not-ready` |
| no blockers, not eligible | `not-eligible` |
| graph invalid | `graph-invalid` (for every id) |

## 10. Graph validity

| condition | reachable today? | decision |
|---|---|---|
| duplicate node id | no (PK) | **INVALID** `DUPLICATE_NODE` |
| missing parent | **yes** | **INVALID** `DANGLING_PARENT` |
| parent self-cycle | no (rejected at write) | **INVALID** `SELF_PARENT` |
| parent cycle | **yes** | **INVALID** `PARENT_CYCLE` |
| dependency self-cycle | no (rejected at write) | **INVALID** `SELF_DEPENDENCY` |
| dependency cycle | **yes** | **VALID graph**, members permanently blocked |
| missing dependency | no (rejected at write) | **INVALID** `DANGLING_DEPENDENCY` (means corrupt/foreign data) |
| malformed relation (non-canonical id) | no (rejected at write) | **INVALID** `MALFORMED_RELATION` |

**Decision: the graph is always constructible — it never throws.** Invalidity is
*data*, returned as `validity` + `diagnostics`, so no consumer has to
exception-handle a corrupt session. But an invalid graph **cannot** yield
`readyTasks`, because answering "ready" on ill-defined structure would be a lie.

## 11. Cycle policy

Defined **separately**, because the two are not the same defect:

| | parent cycle | dependency cycle |
|---|---|---|
| detection | containment walk | execution-edge reachability / strongly-connected component |
| graph validity | **INVALID** | **VALID** |
| readiness effect | none directly (parent is not an execution gate); graph is invalid so no readiness is published | every member carries a **permanent** `DEPENDENCY_CYCLE` blocker |
| diagnostics | `PARENT_CYCLE` naming the member set | `DEPENDENCY_CYCLE` naming the member set |
| mutability | fixed only by a TaskStore mutation that breaks the cycle | same |
| algorithm | **not chosen here** (semantics only) | **not chosen here** |

**Why the asymmetry is right:** a containment cycle makes "what is inside what"
ill-defined, so the structure itself is unusable. A dependency cycle leaves the
structure perfectly well-defined — it simply means those tasks can never all be
satisfied. Localising the fault to the members is more useful than condemning the
whole graph.

## 12. Ordering

**`order ASC, then taskId ASC`** *(NEW ARCHITECTURE decision, independently
corroborated: it is exactly what `listTasks` already does —
`ORDER BY task_order, task_id` — so adopting it makes graph iteration agree with
every other consumer for free, and makes determinism (G5) fall out of the design.)*

- Never `title`, never `content`, never array position.
- **Ordering is not identity** (G10): a reorder changes iteration order and never
  changes a node id (4B lifecycle proves reorder preserves ids).
- Ties in `order` break on `taskId`, which is unique ⇒ total order.

## 13. Durable status vs derived state

| durable `TaskStatus` | graph-derived readiness | `notReadyReason` | dependents |
|---|---|---|---|
| `PENDING` | eligible; ready iff no blockers | `ready` / `blocked` | blocked (temporary) |
| `IN_PROGRESS` | not eligible | `not-eligible` / `blocked` | blocked (temporary) |
| `VERIFYING` | not eligible | `not-eligible` / `blocked` | blocked (temporary) |
| `BLOCKED` | eligible, **never** ready | **`eligible-not-ready`** / `blocked` | blocked (temporary) |
| `RETRYING` | not eligible | `not-eligible` / `blocked` | blocked (temporary) |
| `COMPLETED` | not eligible (terminal) | `not-eligible` / `blocked` | **satisfied** |
| `CANCELLED` | not eligible (terminal) | `not-eligible` / `blocked` | blocked (**permanent**) |
| `FAILED` | not eligible (terminal) | `not-eligible` / `blocked` | blocked (**permanent**) |

**No contradiction is constructible:** `isReady` requires `status === PENDING`, so
a durably-`BLOCKED` task can never be reported ready. The durable status is
authoritative; the graph only *adds* derived information about eligibility and
relations.

## 14. Mutability

**TaskGraph has no write API.** There is deliberately no `addNode`, no
`setParent`, no `markReady`.

The only mutation flow:

```
TaskStore.withTransaction(...)   ← the sole mutation boundary
      ↓
TaskStore.getSnapshot(sessionId) ← a fresh coherent read
      ↓
new TaskGraph(snapshot)          ← a new immutable value
```

The graph freezes its node set at construction, so a later TaskStore write cannot
alter an existing graph. **I do not build graph mutation APIs because TaskStore is
mutable** — that would create a second, conflicting way to change the truth.

## 15. Staleness

**Requirement:** a consumer must be able to tell that a graph came from an older
snapshot.

**Decision: carry an explicit, weak hint — `sourceMaxRevision` = the maximum
`revision` across the snapshot's tasks — plus `sessionId` and `nodeCount`.**

- *VERIFIED basis:* `revision` starts at 1 and increments on every successful
  mutation.
- It is a **hint, not a guarantee**: deleting the highest-revision task can leave
  it unchanged, and concurrent sessions are independent. A consumer needing a real
  guarantee must re-read `TaskStore`.
- It is sufficient because a graph is **read-only** — staleness can never cause
  incorrect behaviour *within* the graph; it only tells a consumer whether to
  re-read before acting.
- **Deliberately not named `sourceRevision`** — that term has zero provenance and
  I am not laundering an unsourced name into the contract. The *requirement* is
  locked; the *wording* is ours.

## 16. Snapshot model

- **Immutable derived value** built from exactly **one** `TaskSnapshot`
  (`{ sessionId, tasks }` — VERIFIED existing API), obtained from one
  `listTasks` call.
- **Coherence (§16 of the brief):** the snapshot is one SQLite statement, so it is
  atomically consistent. The graph therefore never mixes "task A at revision N"
  with "task B at revision N+1". *TaskStore's transaction is the mutation
  boundary; the snapshot read is the observation boundary.*
- **Lifetime:** the value is immutable; the caller owns its reference; there is no
  registry, no cache and no invalidation hook.
- **Rebuild cost:** linear, so caching is unnecessary until measured (§19).
- **Copies, not references:** nodes copy the projected fields (§4), so a mutated
  TaskStore row cannot retroactively change a built graph.

## 17. Deletion / omission boundary

The Identity Foundation's contract stands: **omission is not deletion** (4A.4 I).

| case | graph behaviour |
|---|---|
| retained (D7) task | present as a normal node; it simply was not declared this turn |
| `CANCELLED` task | present, terminal; blocks dependents permanently (§7) |
| explicitly deleted (future) | absent from the snapshot ⇒ no node; a relation to it becomes `DANGLING_*` ⇒ **INVALID** until repaired |
| missing parent | **INVALID** `DANGLING_PARENT` |
| missing dependency | **INVALID** `DANGLING_DEPENDENCY` (unreachable in valid data) |

**The graph never invents deletion** and never drops a node because it was
undeclared. Deletion mechanics are explicitly **out of scope**.

## 18. Branching

**NONE / OUT OF SCOPE.** No branch, fork or variant relation exists in the graph
model, and session-forking must never become graph identity. No new requirement
has been raised for it.

## 19. Public read API

Only what §1's six questions require:

```ts
getNode(taskId): GraphNode | undefined
nodes(): readonly GraphNode[]                  // ordered per §12
dependencies(taskId): readonly string[]        // execution edges out
dependents(taskId): readonly string[]          // execution edges in
children(taskId): readonly string[]            // structural
parent(taskId): string | null
eligibleTasks(): readonly string[]
readyTasks(): readonly string[]                // [] unless valid
isReady(taskId): boolean
notReadyReason(taskId): NotReady
blockers(taskId): readonly Blocker[]
validity(): { valid: boolean; diagnostics: readonly Diagnostic[] }
sourceMaxRevision: number
```

**Explicitly excluded:** `claim`, `execute`, `retry`, `cancel`, `complete`,
`setParent`, `setStatus`. Those belong to TaskStore and the Scheduler (§20).

## 20. Future Scheduler boundary

```
TaskGraph (read-only)  ──reads readiness, blockers, validity──▶  Scheduler
TaskStore   (sole writer)  ◀──requests mutation (claim/status)──  Scheduler
```

TaskGraph **must never**: claim work, set `IN_PROGRESS`, execute, verify, or
complete. It reports *what is eligible and why*; the Scheduler decides and then
asks TaskStore to mutate. This is a **boundary contract, not an implementation** —
and the Scheduler is not designed here.

## 21. Performance model

Complexity classes only; no benchmarks in this phase.

| operation | complexity | notes |
|---|---|---|
| construction (snapshot → graph) | **O(n + e)** | one pass, `e` = total relation edges |
| parent cycle detection | **O(n)** | memoised colouring, single pass |
| dependency cycle detection | **O(n + e)** | reachability / SCC over the dep graph |
| readiness derivation | **O(n + e)** | one pass, after cycles are known |
| blockers for one node | **O(deg)** | ≤ 32 by `MAX_DEPENDS_ON` *(verified enforced)* |
| blockers for all nodes | **O(n + e)** | |
| `readyTasks()` | **O(n + e)** | or O(1) after a precomputed pass — decide at implementation |
| `children()` for one parent | **O(children + 1)** | ⚠ fan-out is **UNBOUNDED** — `MAX_PARENT` is unenforced (§5) |

**Expected order of growth: linear in tasks.** At 10 000 tasks with the verified
32-dependency cap, `e ≤ 3.2 × 10⁵`; `O(n + e)` is comfortably tractable, and no
super-linear step is proposed. **No caching is designed** — a rebuild is the
cache, and it is cheap.

## 22. Safety

TaskGraph is a pure, in-memory, read-only control-plane value. It must **not**:
allocate identity, write TaskStore, touch the filesystem, execute commands, read
model credentials, or invoke tools. It has no I/O of any kind — its only input is
a `TaskSnapshot` value passed in by the caller.

## 23. Invariants (normative)

| # | invariant |
|---|---|
| G1 | exactly one graph node per canonical `taskId` in the snapshot |
| G2 | the graph never creates, mints or formats a `taskId` |
| G3 | the graph never changes task identity |
| G4 | the graph derives from exactly one coherent `TaskSnapshot` |
| G5 | the graph is deterministic for identical snapshot content |
| G6 | parent (structure) and dependency (execution) remain distinct relations |
| G7 | a dependency cycle can never present its members as executable/ready |
| G8 | a missing relation target is never guessed, defaulted or dropped |
| G9 | readiness is **derived**; no durable `READY` is introduced or relied upon |
| G10 | ordering never defines identity, and never uses title/content |
| G11 | omission is not deletion; the graph never drops a node |
| G12 | the graph is read-only and has no write API |
| G13 | the graph cannot execute, claim, verify or complete tasks |
| G14 | the graph never becomes a second persistence authority |
| G15 | the graph never reads a status outside `TaskStatus` (no invented `PAUSED`) |
| G16 | the graph reports invalidity rather than throwing, and refuses `readyTasks` when invalid |
| G17 | a durably-`BLOCKED` task is never reported `isReady` |
| G18 | parent relations never gate readiness |

## 24. Test model (design only — no tests written)

| category | fixture |
|---|---|
| identity preservation | snapshot with 3 tasks; assert 3 nodes, ids unchanged after a reorder |
| deterministic ordering | equal `order` values; assert `taskId` tiebreak; assert repeated builds are identical (G5) |
| parent relation | A parentOf B: `children(A)`, `parent(B)`, one parent max |
| dependency relation | B dependsOn A: `dependencies(B)`, `dependents(A)` |
| missing parent | `parentId = "t99"` (no row) → invalid, `DANGLING_PARENT` |
| missing dependency | hand-built snapshot referencing an absent id → invalid, `DANGLING_DEPENDENCY` |
| parent cycle | A→B→A → invalid, `PARENT_CYCLE` |
| dependency cycle | A→B→A → **valid**, both carry permanent `DEPENDENCY_CYCLE`, `readyTasks()` empty |
| self-reference | A dependsOn A / parentId = A → invalid |
| readiness | matrix over all 8 statuses × {no deps, satisfied dep, unsatisfied dep, terminal dep} |
| blockers | terminal vs temporary classification; `notReadyReason` union for each status |
| graph validity | one fixture per row of §10 |
| snapshot determinism | same snapshot built twice → deep-equal; mutated source → old graph unchanged (immutability) |
| status transitions | a task that becomes `COMPLETED` satisfies dependents on the **next** build, never in place |
| cancellation | `CANCELLED` dependency → permanent blocker; `readyTasks()` excludes the dependent |
| omitted / retained | D7-retained task still present as a node |
| large graph | 1 000-node synthetic chain + a wide fan-out; assert linear behaviour, no stack overflow on a 10 000-deep parent chain (iterative algorithm required) |
| unbounded fan-out | one parent with 200 children (above the unenforced `MAX_PARENT=64`, §5); assert `children()` returns all 200 and the graph stays valid |
| purity | graph construction performs no TaskStore/FS access |

## 25. Decision gate — area by area

| gate area | status | section |
|---|---|---|
| node identity | **DECIDED** | §3 |
| parent semantics | **DECIDED** | §5 |
| dependency semantics | **DECIDED** | §6 |
| dependency satisfaction | **DECIDED** | §7 |
| readiness | **DECIDED** | §8 |
| blockers | **DECIDED** (§9, **AMENDED by 5C.1**: `NotReady` now five states) | §9 |
| cycle behaviour | **DECIDED** | §11 |
| graph validity | **DECIDED** | §10 |
| snapshot model | **DECIDED** | §16 |
| mutability | **DECIDED** | §14 |
| staleness | **DECIDED** | §15 |
| public read API | **DECIDED** | §19 |

**No critical semantic remains UNKNOWN. → TASKGRAPH DESIGN READY.**

The two items deliberately deferred are *not* semantics: the cycle-detection
**algorithms** (semantics fixed in §11; choice deferred to implementation, where
an iterative form is required by the deep-chain test) and the Scheduler
(§20, out of scope).

## 26. Recovery / new-architecture classification

| item | label |
|---|---|
| TaskStore schema, statuses, ordering, revision, relation validation, `getSnapshot` | **VERIFIED CURRENT FACT** |
| `READY` is coerced to `PENDING`; missing-parent / both cycle kinds persist | **VERIFIED CURRENT FACT** (measured) |
| `MAX_DEPENDS_ON = 32` enforced on write; `MAX_PARENT = 64` declared + exported but **enforced nowhere** (child count unbounded) | **VERIFIED CURRENT FACT** (433-file scan) |
| one relation validator (`store.ts:378`) serves **both** create and update, so every "rejected at write" claim below holds for both paths | **VERIFIED CURRENT FACT** |
| identity invariants G-1..G-16 of the Identity Foundation | **VERIFIED CURRENT FACT** (Phase 4C) |
| readiness is a derived list of ids | **RECOVERED ARTIFACT** (idea only — p77 Scheduler `discover().ready`) |
| everything else in this document | **NEW ARCHITECTURE** |
| original TaskGraph semantics | **permanently UNKNOWN** — recovery closed, not guessed |

## 27. Explicit NEW ARCHITECTURE declaration

**The TaskGraph specified here is entirely NEW ARCHITECTURE.** No part of it is a
recovery. The original `graph.ts` / `graph-validate.ts` / `readiness.ts` are
permanently lost (5A.1, 5A.2: never committed, never published). This contract
was derived from the **verified TaskStore semantics** of the Identity Foundation
plus explicit requirements — never from memory of a design I cannot evidence.

## 28. Implementation prerequisites

1. Resolve this design into modules — naturally `graph.ts` (construction +
   relations), `graph-validate.ts` (validity + cycle detection), `readiness.ts`
   (eligibility + blockers). Naming matches the lost modules *coincidentally*;
   no recovered content may leak into them.
2. **Cycle detection must be iterative**, not recursive — the large-graph test
   includes a 10 000-deep parent chain.
3. Consume `TaskStore.getSnapshot` unchanged; **TaskStore must not be modified**.
4. Add the new code path to `TaskStore` only as a *caller*; no new write API.
5. The `todo` protocol, MCP and deletion semantics are **untouched** by this
   component.
6. Before wiring into any consumer, land the §24 tests — especially the cycle
   fixtures, which are the only place both currently-persistable cycle kinds get
   exercised.

## STOP

Design only. `graph.ts`, `graph-validate.ts` and `readiness.ts` are **not**
implemented. No readiness, no Scheduler, no TaskStore change, no todo-protocol
change, no MCP change, no deletion redesign.
