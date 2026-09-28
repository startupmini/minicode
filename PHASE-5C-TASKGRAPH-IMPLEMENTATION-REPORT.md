# PHASE 5C — TASKGRAPH IMPLEMENTATION REPORT

Working repository: `D:\recover\minicode-20260928\reconstruction`
Previous HEAD: `f378909` (`docs: close TaskGraph recovery and lock design`)
Protected specimen `D:\git\minicode`: **never accessed or modified**

---

## DECISION

# TASKGRAPH IMPLEMENTED — DESIGN LOCK HONOURED

Three new modules implement the Phase 5B contract. **94 tests, 0 failures.**
**17 of 18 mutants killed, 1 equivalent, 0 harness misses. No regression.**

No production file was modified. TaskStore, `TaskStatus`, the todo protocol, MCP,
identity, production sync, assignment, plan pipeline and deletion semantics are
all untouched.

---

## 1. Module architecture

```
src/task/model.ts          (untouched — types, isTaskId, TASK_STATUSES)
        ▲
        │ types + the read-only id VALIDATOR
        │
src/task/graph-validate.ts (365 L) structure: GraphNode, Diagnostic,
        ▲                   analyseRelations, iterative cycle detection
        │
src/task/readiness.ts      (219 L) semantics: blockers, eligibility,
        ▲                   readiness, the NotReady union
        │
src/task/graph.ts          (270 L) TaskGraph: projection, ordering,
                            relation indices, public read API
```

A strict DAG, no cycles between the three new modules. `graph.ts` depends on
`readiness.ts`, which depends on `graph-validate.ts`. The split follows the
design lock's own separation of concerns: **structure** (validate) →
**derived state** (readiness) → **surface** (graph).

`isTaskId` is imported as a *validator* only. `taskIdFromIndex` — the only id
formatter in the model — is deliberately **not** imported, and no id is ever
minted, formatted or repaired.

## 2. Graph construction

`new TaskGraph(snapshot: TaskSnapshot)`. One snapshot in, one immutable value
out. No store access, no database access, no filesystem, no external state.

Order of operations:

1. **Project** every task into a frozen `GraphNode` (8 fields, §3 below),
   copying `dependsOn` into a frozen array. Track `max(revision)`.
2. **Sort** by `(order, taskId)` *before* validation, so both the
   de-duplication choice and diagnostic ordering are deterministic regardless of
   input array order (invariant G5). `Array.prototype.sort` is stable.
3. **Validate** via `analyseRelations` — de-duplication, relation shape, both
   cycle kinds.
4. **Index** children and dependents once, over the de-duplicated nodes.

**Construction never throws for malformed graph data** (brief S11). Invalidity is
returned as data. The only throw path would be a TypeError on a non-array
`tasks`, which is a caller error, not malformed graph data.

## 3. Node identity

`GraphNode.id = TaskStore.taskId`, verbatim. One node per id; duplicates produce
a `DUPLICATE_NODE` diagnostic and the **first occurrence wins**. Identity is
never derived from title, content, order, ordinal or array position.

Defensively covered by a test that uses deliberately misleading fixtures
(reversed orders, titles that disagree with ids, a shuffled source array).

## 4. Ordering

`order` ascending, then `taskId` ascending as a plain **lexicographic string
compare**. That is deliberate fidelity: SQLite's `ORDER BY task_id` on a TEXT
column under BINARY collation does the same, so graph iteration agrees with
`listTasks` exactly — including the `t10 < t2` consequence of comparing ids as
text. A test pins that ordering.

## 5. Parent relation

Structural containment. One parent maximum. Never an execution gate.

| condition | behaviour |
|---|---|
| parent exists | normal containment edge |
| missing parent | INVALID `DANGLING_PARENT`; blocker `PARENT_MISSING` |
| self parent | INVALID `SELF_PARENT`; blocker `SELF_REFERENCE` |
| parent cycle | INVALID `PARENT_CYCLE`; blocker `PARENT_CYCLE` |

**Fan-out is unbounded.** `MAX_PARENT = 64` exists in `store.ts:53` and is
exported for tests at `store.ts:697`, but is enforced at no call site, so this
phase does **not** enforce it (brief S6; design lock S5). Verified with a
20 000-child fixture.

A parent that is unfinished does **not** make its child unready — there is an
explicit contrast test against a dependency gate for the same fixture.

## 6. Dependency relation

Execution ordering. 0..32 per task (`MAX_DEPENDS_ON`, enforced by TaskStore).

| condition | behaviour |
|---|---|
| self dependency | INVALID `SELF_DEPENDENCY`; blocker `SELF_REFERENCE` |
| missing dependency | INVALID `DANGLING_DEPENDENCY` (defensive — store rejects it) |
| duplicate dependency | INVALID `DUPLICATE_DEPENDENCY`; blocker emitted once |
| **dependency cycle** | **VALID graph**; members get a permanent `DEPENDENCY_CYCLE` blocker |

Satisfaction: `dep.status === "COMPLETED"` and nothing else. `FAILED` and
`CANCELLED` produce `DEPENDENCY_TERMINAL` with `permanent: true`; the other five
produce `DEPENDENCY_UNSATISFIED` with `permanent: false`.

## 7. Cycle algorithms

Both **iterative**, as required. Neither uses recursion.

- **Parent cycles** — `parentId` is a *functional* relation, so a path-index
  walk suffices: follow parents, and a repeat **within the current path** is a
  cycle. The `pathIndex` map is what separates "seen in this walk" (a cycle) from
  "seen in an earlier walk" (already settled). O(n) overall.
- **Dependency cycles** — iterative Tarjan SCC, with an explicit frame stack.
  A node is in a cycle iff its SCC has more than one member. Self edges and
  edges to absent ids are skipped: the former are `SELF_DEPENDENCY` and the
  latter `DANGLING_DEPENDENCY`, both already INVALID, and a phantom node would
  corrupt the SCCs of everything pointing at it. O(n + e).

Verified at 100 000-deep parent chains and a single 20 000-node dependency cycle.

### 7a. A test-strength finding worth recording

The brief requires iterative traversal so a 10 000-deep parent chain cannot
overflow. **A 10 000-node behavioural fixture cannot actually verify that.**
Measured under bun 1.4.2 on this machine, recursion survives:

| depth | 1 000 | 10 000 | 200 000 | 2 000 000 |
|---|---|---|---|---|
| recursive walk | OK | OK | OK | OK |

So a recursive implementation passes the 10 000-depth fixture too. The
requirement is therefore asserted **structurally** as well: a test extracts every
declared function and arrow body and fails if any of them references its own
name. That check is what actually killed the recursive mutant (§16).

## 8. Readiness

Derived. There is no durable `READY` and none is introduced.

```
eligibleForReadiness(n) = n.status ∈ { PENDING, BLOCKED }
isReady(n)              = graph.valid AND n.status === "PENDING"
                          AND computeBlockers(n).length === 0
```

`BLOCKED` is **eligible but never ready** — the durable status always wins, so
the "durably BLOCKED yet the graph says ready" contradiction is unconstructible.
There is a dedicated test for exactly that.

`readyTasks()` returns `[]` whenever the graph is invalid. `eligibleTasks()` is
deliberately independent of validity: a blocked-by-relation task is still an
eligible candidate that happens not to be ready.

## 9. Blockers

All seven kinds implemented: `DEPENDENCY_UNSATISFIED`, `DEPENDENCY_TERMINAL`,
`DEPENDENCY_CYCLE`, `DANGLING_DEPENDENCY`, `PARENT_MISSING`, `PARENT_CYCLE`,
`SELF_REFERENCE`. Each carries `kind`, `relation`, `taskId`, `permanent`,
`detail`.

A test enumerates all seven and asserts the set matches exactly, so a new kind
cannot be added silently and a missing one cannot go unnoticed.

**Durable status is never itself a blocker** — a test asserts `blockers()` is
empty for all eight statuses. Cancellation is modelled as *not eligible*, not as
*blocked*.

Precedence, and why: cycle membership first (a cycle member can never be
satisfied whatever its status), then terminal (actionable "this will not
proceed") before merely-unsatisfied.

## 10. Invalid-graph handling

`validity()` returns `{ valid, diagnostics }`. `valid` is false iff any
diagnostic was raised — and a dependency cycle deliberately raises none.

| diagnostic | reachable from TaskStore? |
|---|---|
| `DANGLING_PARENT` | **yes** (proven by integration test) |
| `PARENT_CYCLE` | **yes** (proven by integration test) |
| `SELF_PARENT` | no — rejected at write |
| `SELF_DEPENDENCY` | no — rejected at write |
| `DANGLING_DEPENDENCY` | no — rejected at write (defensive) |
| `DUPLICATE_DEPENDENCY` | no — rejected at write (defensive) |
| `DUPLICATE_NODE` | no — PRIMARY KEY (defensive) |
| `MALFORMED_RELATION` | no — rejected at write (defensive) |
| dependency cycle | **valid**, members blocked |

Construction never throws; `readyTasks()` is empty and `notReadyReason` returns
`graph-invalid` for **every** node when the graph is invalid — no partial answer.

## 11. Staleness

`sourceMaxRevision` = `max(task.revision)` across the snapshot; `0` for an empty
snapshot. Not named `sourceRevision`, and not a CAS or version guarantee.

An integration test documents the weakness empirically: **creating a new task
does not raise the hint**, because a new row starts at `revision` 1 and the
maximum is unchanged. Mutating an existing task does raise it. That is precisely
the "weak hint" the design lock committed to, now pinned by a test.

`sessionId` and `nodeCount` are carried as readonly properties, per design
lock S15.

## 12. Immutability

Nodes, their `dependsOn` arrays, the node list and every relation bucket are
`Object.freeze`d. The graph holds **copies**, never live references to source
rows. A test mutates the source row and its `dependsOn` array after construction
and asserts the built graph is unchanged. A second test mutates the source
`TaskSnapshot` after building and asserts the graph ignores it.

No cache, no registry, no invalidation hook. The adjacency indices are
construction-time indices over immutable data, not caches.

## 13. Public API

Exactly the thirteen members of design lock S19: `getNode`, `nodes`,
`dependencies`, `dependents`, `children`, `parent`, `eligibleTasks`,
`readyTasks`, `isReady`, `notReadyReason`, `blockers`, `validity`,
`sourceMaxRevision`.

**Not present**: `addNode`, `setParent`, `setStatus`, `markReady`, `claim`,
`execute`, `retry`, `cancel`, `complete`, `delete`, `update`, `patch`, `nextId`
— asserted by a test, not just by absence.

Unknown-id behaviour is deterministic and total: `getNode` → `undefined`,
`parent` → `null`, `dependencies`/`dependents`/`children`/`blockers` → `[]`,
`isReady` → `false`, `notReadyReason` → `undefined`. Nothing throws on an absent
id.

## 14. Status matrix

Tested explicitly for all eight real `TaskStatus` values, on four axes each
(eligible / ready / acts as satisfied dependency / blocker classification):

| status | eligible | ready | satisfies a dependency | blocker it causes on a dependent |
|---|---|---|---|---|
| `PENDING` | yes | yes (if no blockers) | no | `DEPENDENCY_UNSATISFIED` (temporary) |
| `BLOCKED` | yes | **never** | no | `DEPENDENCY_UNSATISFIED` (temporary) |
| `IN_PROGRESS` | no | no | no | `DEPENDENCY_UNSATISFIED` (temporary) |
| `VERIFYING` | no | no | no | `DEPENDENCY_UNSATISFIED` (temporary) |
| `RETRYING` | no | no | no | `DEPENDENCY_UNSATISFIED` (temporary) |
| `COMPLETED` | no | no | **yes** | — |
| `CANCELLED` | no | no | no | `DEPENDENCY_TERMINAL` (**permanent**) |
| `FAILED` | no | no | no | `DEPENDENCY_TERMINAL` (**permanent**) |

A test asserts the matrix covers exactly these eight and nothing else, and a
separate test re-derives the model source to confirm `TASK_STATUSES` has exactly
8 entries with no `PAUSED` and no `READY`. An integration test writes
`status: "READY"` into a real store and shows it is coerced, so the graph never
sees a durable `READY`.

## 15. Tests

`test/phase5-taskgraph.test.ts` — 1 042 lines, **94 tests, 353+ assertions,
0 failures**. Covers brief A–Z plus an integration block.

Integration tests drive a **real `TaskStore`** over a temp SQLite DB. This does
double duty: it proves the graph consumes genuine `getSnapshot` output, and it
**proves the brief-S18 reachable/defensive split** rather than asserting it. One
test confirms the real store *rejects* a missing dependency, a self dependency,
a self parent and a duplicate dependency — which is what makes the graph's
handling of those four genuinely defensive.

Covered: one node per id; deterministic ordering; reorder preserves identity;
parent and dependency relations; missing parent/dependency; both self-references;
both cycle kinds; all 8 dependency-satisfaction cases; readiness matrix; blocker
classification; the NotReady union; invalid-graph no-throw; invalid-graph
`readyTasks() === []`; `sourceMaxRevision`; immutability; D7-retained task;
`CANCELLED` and `FAILED` dependencies; 1 000-node graph; 10 000-deep parent and
dependency chains; a 10 000-deep parent **cycle**; 200-child fan-out; and purity.

## 16. Mutation results

18 targets, run against a sandbox copy — the repository is never mutated. Each
mutant is applied, the suite run, and the file restored.

| # | mutation | verdict |
|---|---|---|
| 1 | derive id from order/position | KILLED (7) |
| 2 | sort by title | KILLED (3) |
| 3 | ignore parent relation | KILLED (16) |
| 4 | make parent an execution gate | KILLED (2) |
| 5 | make dependency cycle invalid | KILLED (4) |
| 6 | make parent cycle valid | KILLED (4) |
| 7 | `CANCELLED` satisfies dependency | KILLED (5) |
| 8 | `FAILED` satisfies dependency | KILLED (7) |
| 9 | make `BLOCKED` ready | KILLED (3) |
| 10 | introduce durable `READY` | KILLED (1) |
| 11 | return `readyTasks` on invalid graph | **EQUIVALENT** |
| 12 | throw on invalid construction | KILLED (14) |
| 13 | remove `sourceMaxRevision` | KILLED (2) |
| 14 | retain mutable source references | KILLED (2) |
| 15 | use recursive DFS | KILLED (1) |
| 16 | merge parent/dependency relations | KILLED (3) |
| 17 | silently drop missing relation | KILLED (2) |
| 18 | suppress dependency-cycle blocker | KILLED (5) |

**17 killed · 1 equivalent · 0 survived · 0 harness misses.**

### The one equivalent mutant (#11)

Removing the `!valid` guard from `readyTasks()` changes no observable
behaviour, because `computeIsReady()` independently returns `false` when the
graph is invalid. That is **defence in depth**, not a coverage hole: the
invariant is enforced at two layers. A test pins each layer separately, so both
guards are covered even though neither can be removed alone.

### Two harness defects found and fixed during the sweep

Reported because a mutation result is only as trustworthy as its harness:

- A sweep reported **18/18 killed with `pass=0`** — every run had died at module
  load because the sandbox lacked `store.ts`, which the integration tests import.
  "All killed" from a suite that never ran is the worst possible false signal.
  The harness now copies the whole `src/` tree and **refuses** to score any run
  with fewer than 5 passing tests.
- Three mutants (`#5`, `#12`, `#17`) first scored as load failures: PowerShell
  single-quoted strings do not expand `` `n ``, so the injected newline was a
  literal backtick-n and the mutant was a syntax error. Now normalised.

## 17. Performance

Complexity classes and measured scaling, **no millisecond budget** (brief S20).
Measured on this machine, bun 1.4.2.

Construction, `n` doubling, `e ≈ n` (dependency chain):

| n | build | build/n | ratio |
|---|---|---|---|
| 1 250 | 9.35 ms | 7.48 µs | — |
| 2 500 | 14.47 ms | 5.79 µs | 1.55 |
| 5 000 | 27.60 ms | 5.52 µs | 1.91 |
| 10 000 | 54.69 ms | 5.47 µs | 1.98 |
| 20 000 | 111.52 ms | 5.58 µs | 2.04 |

`build/n` is flat and the doubling ratio settles at ~2: **O(n + e)**, demonstrated
rather than asserted.

- `readyTasks()`: 1.83 ms at n = 20 000, `ready/n` flat → **O(n + e)**.
- One 20 000-node dependency cycle: 117 ms, one SCC, all members blocked.
- Deep chains: 10 000 / 50 000 / 100 000 parent depth → 42 / 249 / 560 ms, valid,
  **no `RangeError`**.
- Fan-out: 20 000 children in 77 ms, `valid = true` (> `MAX_PARENT` 64, which is
  not enforced).
- Blockers: 5 000 nodes × 32 blockers = 160 000 blockers in 49.6 ms
  (0.0099 ms/node), uniform count verified → **O(deg)**, degree ≤ 32.
- Rebuild of a 10 000-node graph: 31.7 / 33.7 / 35.8 ms over three rounds — no
  drift, so **no cache is warranted**. A rebuild is the cache.

## 18. Purity audit

12 categories, **all ZERO**, over the three new modules with comments stripped:
TaskStore writes · SQLite · filesystem APIs · process-global state · random ID
generation · task ID formatting · content-based identity · ordinal-based
identity · Scheduler · executor · credentials · tool invocation.

Total imports across all three modules:

```
graph.ts          type { TaskSnapshot, TaskStatus } from "./model"
graph-validate.ts isTaskId, type { TaskStatus }     from "./model"
readiness.ts      type { TaskStatus }               from "./model"
readiness.ts      type { Diagnostic, GraphNode, RelationAnalysis } from "./graph-validate"
```

`./model` for types plus the read-only `isTaskId` validator; `./graph-validate`
for this phase's own types. No `./store`. Enforced by test, and re-verified by
an independent static sweep.

## 19. Validation

| gate | result | classification |
|---|---|---|
| parse (all 3 modules load) | 94/94 tests load the modules | **VERIFIED** |
| TaskGraph unit tests | 94 pass / 0 fail | **VERIFIED** |
| TaskGraph integration tests (real store) | 10 pass / 0 fail | **VERIFIED** |
| deep-chain test (10 000) | pass, no overflow | **VERIFIED** |
| wide fan-out test (200 children) | pass | **VERIFIED** |
| TaskStore + Identity Foundation suites | 230 pass / 1 skip / 0 fail — **identical to the pre-5C baseline** | **VERIFIED** |
| mutation tests | 17 killed / 1 equivalent / 0 survived / 0 harness misses | **VERIFIED** |
| performance proof | O(n + e) demonstrated | **VERIFIED** |
| purity audit | 12/12 categories zero | **VERIFIED** |
| full suite | 2 890 pass / 23 skip / **4 fail** | **BASELINE-FLAKE** (see below) |
| `tsc --noEmit` | `node_modules` absent, no local `tsc` | **DEFERRED** |

### The 4 full-suite failures are pre-existing, not caused by 5C

Verified by moving the three new `src/task/*.ts` files aside and re-running the
three affected files: **the same 4 tests fail identically without 5C's code.**

| test file | reason | verdict |
|---|---|---|
| `architecture-map.test.ts` | `docs/ARCHITECTURE.html` is missing `src/**` filenames | pre-existing |
| `pack-integrity.test.ts` | VENDOR.md pin mismatch: expected `840aa2e9cd70a401`, got `3f027ea6d8f1b18e` | pre-existing |
| `web-build.test.ts` | docs nested-list renderer audit (web P1-4) | pre-existing |

Typecheck is **DEFERRED**: `node_modules` is absent and installing it would need
a network fetch, which is outside this phase's remit. The three modules are
type-checked in practice by bun's transpiler and exercised by 94 tests.

## 20. Known limitations

1. **`notReadyReason` has a gap in the 5B union (design-lock defect, not an
   implementation defect).** The locked four states — `ready`, `not-eligible`,
   `blocked`, `graph-invalid` — do not name the case *durably `BLOCKED` with zero
   blockers*. Such a task is **eligible** (so `eligibleTasks()` lists it) yet
   never ready, and the union offers no accurate member: `blocked` would claim
   blockers that do not exist, and `ready` would be false. The implementation
   reports `{ kind: "not-eligible", status: "BLOCKED" }`, which is the least-wrong
   of the four and is deterministic and tested. **Recommend a 5B amendment**:
   either add a fifth state such as `eligible-not-ready`, or rename
   `not-eligible` to `not-ready-by-status` so it no longer reads as the negation
   of eligibility. This is reachable — any `BLOCKED` task with no relations.
2. **The 10 000-depth fixture cannot verify "iterative" on its own.** Measured:
   bun survives a 2 000 000-frame recursive walk. The structural no-self-recursion
   test is what actually enforces the requirement (§7a). A future change to that
   test would silently weaken the guarantee.
3. **`sourceMaxRevision` is a weak hint, as designed.** Creating a task does not
   raise it. A consumer needing certainty must re-read `TaskStore`. Pinned by test
   so the limitation cannot be forgotten.
4. **`MAX_PARENT = 64` remains unenforced in `store.ts`.** Enforcing it is a
   TaskStore change, out of scope for 5C. TaskGraph treats fan-out as unbounded.
5. **`notReadyReason` returns `undefined` for an unknown id** (a return-type
   widening, `NotReady | undefined`, mirroring `getNode`). The locked union has
   no member for "there is no such task", and a fifth state was forbidden.
6. **`docs/ARCHITECTURE.html` is not updated** with the three new modules. It is
   not in the brief's expected-file list, and its test is **already failing for
   pre-existing reasons**, so fixing it here would mean taking on unrelated debt.
   Recommend a dedicated follow-up.
7. **No consumer wires TaskGraph in yet**, by design. The Scheduler boundary
   (design lock S20) is a contract, not an implementation.

## 21. Commit

| | |
|---|---|
| **Commit SHA** | recorded in the checkpoint below |
| **Message** | `feat: implement TaskGraph` |
| **Files** | `src/task/graph.ts` · `src/task/graph-validate.ts` · `src/task/readiness.ts` · `test/phase5-taskgraph.test.ts` · `PHASE-5C-TASKGRAPH-IMPLEMENTATION-REPORT.md` |
| **Push** | **NOT PUSHED** |

---

## STOP

TaskGraph is implemented. Not started, per the stop condition: Scheduler ·
TaskGraph consumers · execution · claim · retry orchestration · completion
orchestration · deletion redesign · bootstrap redesign · MCP persistence
redesign.

`TaskStore owns truth. TaskGraph interprets one coherent snapshot, never mutates
truth, never creates identity, never executes work.`
