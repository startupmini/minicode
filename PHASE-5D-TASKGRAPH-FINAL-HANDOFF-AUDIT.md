# PHASE 5D — TASKGRAPH FINAL HANDOFF AUDIT

Working repository: `D:\recover\minicode-20260928\reconstruction`
Audited HEAD: `bea0abe` (`fix: clarify TaskGraph not-ready semantics`)
Protected specimen `D:\git\minicode`: **never accessed or modified**

---

## DECISION

# TASKGRAPH HANDOFF BLOCKED

**Runtime semantics are sound: 204 audit checks, 0 failures. Type safety is not.**

Typecheck was DEFERRED in 5C and 5C.1. It is no longer deferred — the lockfile
permitted a safe frozen install, and `tsc` runs. It found **14 production type
errors, all in TaskGraph, which is the only production code in the entire project
that fails typecheck.** One of them is a genuine public-API typing defect.

Per §23 a real defect means STOP and a dedicated fix phase, not a silent patch.
No source was modified. The fix phase is specified in §22 below.

---

## 1. Typecheck — `VERIFIED` (and it is not clean)

The blocker in 5C/5C.1 was tooling, not policy, and it turned out to be solvable
safely.

| question | answer |
|---|---|
| `node_modules` present at start? | **no** |
| local `tsc`? | absent |
| `tsc` on PATH / globally? | absent |
| lockfile present? | **yes — `bun.lock`**, 14 259 bytes, `lockfileVersion: 2` |
| typescript pinned? | **yes — `typescript@7.0.2`** with a `sha512` integrity hash |
| is a safe reproducible install possible? | **yes** |

```
bun install --frozen-lockfile
  + @biomejs/biome@2.5.10   + @lydell/node-pty@1.2.0-beta.15
  + @resvg/resvg-js@2.6.2   + @types/bun@1.4.2
  + @types/node@26.6.1      + typescript@7.0.2
  12 packages installed [614ms]     exit 0
```

`bun.lock` SHA256 **unchanged** before and after — the install is exactly what the
lockfile pins, verified by integrity hash, and installs no arbitrary versions.
`node_modules/` is gitignored, so the working tree stayed clean.

**TYPECHECK: `tsc 7.0.2 -p tsconfig.json --noEmit` → exit 1, 54 errors.**

The project's strictest settings are active: `strict`,
`noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, `noEmit`. A type error is not a stylistic complaint here.

### 1.1 Error attribution — what TaskGraph is responsible for

| area | errors | attributable to TaskGraph? |
|---|---|---|
| `src/task/graph-validate.ts` | 13 | **YES** |
| `src/task/graph.ts` | 1 | **YES** |
| `test/phase5-taskgraph.test.ts` | 12 | **YES** |
| `test/phase3*`, `test/phase4*` (10 files) | 28 | no — **pre-existing** |
| `src/` outside TaskGraph | **0** | — |
| **total** | **54** | **26 introduced by TaskGraph** |

The 28 pre-existing errors are proven pre-existing, not assumed: those 10 test
files are **byte-identical to the pre-TaskGraph checkpoint `f378909`**
(`git diff --stat f378909 HEAD -- <those files>` is empty), and no TaskGraph
commit touched them.

**The material finding: `src/` outside TaskGraph has ZERO type errors. TaskGraph
is the only production code in the project that fails `tsc`.** The rest of the
production tree — hundreds of files under the strictest settings — is clean.
TaskGraph therefore introduced a measurable regression in code quality even
though every one of its 104 runtime tests passes.

### 1.2 DEFECT D1 — `blockers()` returns the wrong type (public API)

```
src/task/graph.ts(245,29): error TS2322:
  Type 'readonly string[]' is not assignable to type 'readonly Blocker[]'.
```

```ts
const EMPTY_IDS: readonly string[] = Object.freeze([])   // L39

blockers(taskId: string): readonly Blocker[] {          // L243
  const node = this.getNode(taskId)
  if (node === undefined) return EMPTY_IDS              // L245  <-- string[] as Blocker[]
  return computeBlockers(node, this.analysis.byId, this.analysis)
}
```

`EMPTY_IDS` is correct for the five string-returning methods, but it is the wrong
constant for `blockers()`. **This is a genuine API typing defect, not noise:** the
signature promises a consumer `readonly Blocker[]` and hands it a `readonly
string[]`. A caller writing `graph.blockers(id)[0]?.kind` is typing a `string` as
a `Blocker`. At runtime the array is empty so nothing crashes — which is exactly
why 104 tests missed it. The other five uses (L144, L149, L154, L187) are correct.

### 1.3 DEFECT D2 — Tarjan frame stack is not provably safe (13 errors)

`graph-validate.ts` lines 318–358, thirteen `TS18048: 'frame' is possibly
'undefined'` (and `'caller'`):

```ts
while (frames.length > 0) {
  const frame = frames[frames.length - 1]     // L316 -> T | undefined
  if (frame.next < frame.adj.length) {        // L318
```

`noUncheckedIndexedAccess` makes every index access `T | undefined`, and a length
check does not narrow an index expression. The code is **runtime-correct** — the
`while` guard is exactly the invariant — but the compiler cannot prove it, so
neither can a future reviewer, and a later refactor could break it silently.

This is a real type-safety gap: *correct today, unverified by construction*. It
is confined to one loop in `findDependencyCycles`.

### 1.4 Defects in the 5C test file (12 errors)

| code | count | nature |
|---|---|---|
| TS6133 | 1 | **`computeBlockers` is a dead import** — confirmed: 1 mention, **0 uses** after the import line |
| TS2339 | 1 | L617 `.sort()` called on a `readonly string[]` — violates the declared return type |
| TS2769 | 5 | `test.each` overload mismatch; the parameter is typed `unknown` |
| TS2322 | 4 | `unknown` not assignable to `TaskStatus \| undefined` |
| TS2538 | 1 | `unknown` used as an index type |

The dead import is a real §17 finding: the test suite claims to cover
`computeBlockers` but only ever reaches it indirectly through `graph.blockers()`.
The three `test.each` sites need an explicit `TaskStatus` annotation.

## 2. NotReady type proof — the 5C.1 survivor is RESOLVED

§3/§16 required proving that removing `eligible-not-ready` from the union is a
compile error. This is now possible. Applied in place on `src/task/readiness.ts`
(then restored from git), **same source, two tools**:

| tool | result |
|---|---|
| `bun test` (runtime) | **104 pass / 0 fail** — the mutant SURVIVES, exactly as 5C.1 reported |
| `tsc --noEmit` (compile) | **60 errors** (6 new), including the decisive one: |

```
src/task/graph.ts(236,16): error TS2322:
  Type '"eligible-not-ready"' is not assignable to
  type '"blocked" | "graph-invalid" | "not-eligible" | "ready"'.
```

**The type-only mutation is KILLED by the compiler.** 5C.1's survivor is
**RESOLVED** — the union's five variants are enforced at compile time, and the
runtime suite alone could never have shown it.

Restored immediately: `git checkout --`, working tree **CLEAN**, back to 54
errors, 104/0 tests, `eligible-not-ready` present in the union.

This is the clearest demonstration in the project of the core principle: **a
passing runtime suite is not type safety.** The same source, the same moment, one
tool blind and the other decisive.

## 3. Status universe — `VERIFIED`

`TaskStatus` is exactly eight values, confirmed against current source and by
re-deriving the array from `model.ts`:

`PENDING` `BLOCKED` `IN_PROGRESS` `VERIFYING` `RETRYING` `COMPLETED` `CANCELLED` `FAILED`

- **`READY` absent** — `isTaskStatus("READY") === false`
- **`PAUSED` absent** — `isTaskStatus("PAUSED") === false`
- lowercase `"blocked"` rejected; all eight accepted by the guard
- the status model was **not modified**

## 4. API consistency — 12 members present, 1 typing defect

All twelve methods plus the `sourceMaxRevision` property exist and behave. All
thirteen forbidden members (`addNode`, `setParent`, `setStatus`, `markReady`,
`claim`, `execute`, `retry`, `cancel`, `complete`, `delete`, `update`, `patch`,
`nextId`) are **absent** — asserted, not merely observed.

**Unknown-id handling is total and never throws:** `getNode` → `undefined`,
`parent` → `null`, `dependencies`/`dependents`/`children`/`blockers` → `[]`,
`isReady` → `false`, `notReadyReason` → `undefined`.

**Invalid-graph handling:** `readyTasks()` `[]`, `isReady` `false` even for a
clean node, `notReadyReason` → `graph-invalid` for *every* id, while
`eligibleTasks()` stays independent of validity.

**One mismatch: `blockers()`'s declared return type does not match what it
returns (D1).** Implementation, exported type and design lock agree in intent;
the emitted type is wrong for the unknown-id path.

## 5. Identity boundary — `VERIFIED`

- `GraphNode.id === TaskStore.taskId`, verbatim (`id: task.id`, graph.ts:102)
- every node id matches the canonical `^t[1-9][0-9]*$` form
- with reversed orders and titles disagreeing with ids, identity still follows the
  durable id: `getNode("t3")` returns a node whose `id` is `"t3"` and whose
  `title` is `"zzz"`
- reordering changes iteration order and **never** an id
- `isTaskId` is imported as a **validator**; `taskIdFromIndex` (the only
  formatter) is never imported
- no graph API can mutate identity — no id appears in any setter's signature

## 6. Purity — `VERIFIED`, 7/7 categories ZERO

Static audit, comments stripped: SQLite · filesystem · TaskStore writes ·
process-global state · random generation · tool invocation ·
executor/Scheduler references. **All ZERO.** The three modules import only
`./model` and each other. No `./store`.

## 7. Snapshot and immutability — `VERIFIED`

One `TaskSnapshot` in, one `TaskGraph` out. After construction, mutating the
source row's `status`, `title` and `dependsOn` array changes **nothing** in the
built graph — including the aliased array, which is copied. `nodes()`, each node,
`dependsOn` and every relation bucket are frozen. `sessionId` and `nodeCount` are
carried. No cache, no registry, no singleton, no live row reference: adjacency
maps are construction-time indices over immutable data.

## 8. Relations — `VERIFIED`, semantics unchanged

Parent and dependency remain distinct (a node may be both a child of and a
dependent on the same task, and both edges are reported independently).

**Parent is not an execution gate:** with the dependency satisfied and the parent
deliberately unfinished, the child **is** ready. The contrast is asserted: an
unfinished *dependency* does gate.

| condition | result |
|---|---|
| parent cycle | **INVALID** graph, `PARENT_CYCLE`, no `readyTasks` |
| dependency cycle | **VALID** graph, **no diagnostic**, members get a permanent `DEPENDENCY_CYCLE` blocker, no `readyTasks` |
| missing parent | **INVALID** |
| missing dependency | **INVALID** (defensive) |

## 9. Readiness — `VERIFIED` across all eight statuses

Every status checked on six axes: `eligibleTasks`, `isReady`,
`eligibleForReadiness()`, `notReadyReason().kind`, the blocker it causes on a
dependent, and `dependencySatisfied()`.

| status | eligible | ready | `notReadyReason` | blocks dependent as |
|---|---|---|---|---|
| `PENDING` | yes | yes | `ready` | `DEPENDENCY_UNSATISFIED` |
| `BLOCKED` | **yes** | **never** | **`eligible-not-ready`** | `DEPENDENCY_UNSATISFIED` |
| `IN_PROGRESS` | no | no | `not-eligible` | `DEPENDENCY_UNSATISFIED` |
| `VERIFYING` | no | no | `not-eligible` | `DEPENDENCY_UNSATISFIED` |
| `RETRYING` | no | no | `not-eligible` | `DEPENDENCY_UNSATISFIED` |
| `COMPLETED` | no | no | `not-eligible` | **satisfies** |
| `CANCELLED` | no | no | `not-eligible` | `DEPENDENCY_TERMINAL` |
| `FAILED` | no | no | `not-eligible` | `DEPENDENCY_TERMINAL` |

The 5C.1 corrections both hold: `BLOCKED` + zero blockers → `eligible-not-ready`;
`BLOCKED` + a dependency blocker → `blocked` (blockers outrank status). Terminal
set is `{CANCELLED, FAILED}`. No `PAUSED` anywhere.

## 10. Cycles and depth — `VERIFIED`

- 10 000-deep parent chain: valid, all nodes, no `RangeError`
- **100 000-deep** parent chain: valid, all nodes, no `RangeError`
- 100 000-deep dependency chain: valid, 1 blocker
- 10 000-deep parent **cycle**: detected, `PARENT_CYCLE` raised, no overflow
- **Structural iteration audit: 11 declared functions across the three modules,
  NONE self-recursive.**

The structural audit is the load-bearing evidence. A depth test cannot prove
iteration here — 5C.1 measured that recursion survives a **2 000 000-frame**
chain under bun 1.4.2, so a recursive implementation passes any depth fixture. The
design forbids recursion; the source is verified not to contain it.

## 11. Fan-out — `VERIFIED`

A parent with 200 children: all 200 accessible, graph **valid**, and 200 > 64
demonstrating `MAX_PARENT` is **not** enforced, exactly as the design lock
intends. Enforcing it would be a TaskStore change and remains out of scope.

## 12. Determinism — `VERIFIED`

The same snapshot built twice — and built from a **shuffled** input array —
produces identical node ordering, relation results, blockers, readiness,
validity diagnostics and the full node projection. Ordering is `order` ASC then
`taskId` ASC, with the id tiebreak **lexicographic** (`["t10","t2"]`), matching
SQLite BINARY collation on a TEXT column.

## 13. Staleness — `VERIFIED`, still only a weak hint

`sourceMaxRevision === max(task.revision)` across the snapshot; `0` for an empty
snapshot. It is **not** named `sourceRevision`, is not a CAS, and is not a
version guarantee. The measured weakness stands: **adding a new task does not
raise it** (a new row starts at `revision` 1), and removing the highest-revision
task can leave it unchanged. A consumer needing certainty must re-read TaskStore.

## 14. Defensive invalid data — `VERIFIED`, 9/9

Hand-built snapshots for every defensive and reachable malformed case: duplicate
node, missing parent, parent cycle, missing dependency, self parent, self
dependency, duplicate dependency, malformed parent, malformed dependency.

For all nine: **construction does not throw**, the expected diagnostic is
reported, `valid === false`, and `readyTasks()` is `[]`. `analyseRelations` also
does not throw on malformed data. Dependency cycle confirmed as the one
**valid-but-unsatisfiable** case.

## 15. Mutation review — no repeat required

No source changed during 5D (the type experiment was restored from git), so the
campaigns are not repeated.

| campaign | result |
|---|---|
| 5C | 17/18 killed · 1 equivalent · 0 harness misses |
| 5C.1 | 8/9 killed · 1 type-only survivor · 0 harness misses |
| 5C.1 survivor, re-tested under `tsc` | **KILLED by the compiler → RESOLVED** (§2 above) |

The 5C equivalent mutant remains a legitimate equivalent: `readyTasks()` and
`computeIsReady()` both refuse readiness on an invalid graph, so removing either
single guard is behaviour-preserving defence in depth.

## 16. Test quality — real weaknesses found

Checked for the defect classes named in §17:

| class | finding |
|---|---|
| dead assertions / dead code | **found** — `computeBlockers` imported and never used (TS6133) |
| type-violating calls | **found** — `.sort()` on a `readonly string[]` (TS2339, L617) |
| `unknown` leakage from `test.each` | **found** — 3 sites, 10 errors |
| swallowed exceptions | none — the `EBUSY` cleanup in 5C used `.catch(() => {})` deliberately, on a temp dir the test owns |
| wrong paths | none — 7 impurity/scheduler tokens all ZERO |
| positional comparisons | none — identity asserted from durable ids under adversarial fixtures |
| accidental default IDs | none — every fixture id is explicit and canonical |
| tests proving only helper behaviour | one instance (the dead import) |

Nothing required rewriting good tests. All three findings are in the 5C test file,
none in production.

## 17. TaskStore boundary — `VERIFIED`

TaskGraph does not import or reference TaskStore: **zero production importers of
the graph modules exist**, the only outside reference is prose in a scope comment
at `src/task/identity.ts:22`. The boundary is exactly
`TaskStore.getSnapshot()` → `new TaskGraph(snapshot)`, with no hidden persistence
lookup.

## 18. Scheduler handoff statement

**TaskGraph is not yet fit to be a Scheduler input.** Its runtime semantics are
sound and documented, but its published types are wrong in one place, so a
Scheduler compiled against today's signatures would be typed against a lie.

### Scheduler MAY assume, once 5D.1 lands

- **graph validity** — `validity().valid` and `diagnostics` are trustworthy;
  `readyTasks()` is `[]` whenever `valid === false`, never a partial answer
- **node identity** — `GraphNode.id` is the durable canonical `taskId`, never
  derived from title, content, order or position
- **derived readiness** — `eligibleTasks()`, `readyTasks()`, `isReady()` agree
  with each other and with `notReadyReason()` for all eight statuses
- **blocker explanation** — every non-readiness has a named, classified cause,
  with `permanent` distinguishing operator action from self-resolution
- **dependency structure** — execution edges are accurate; only `COMPLETED`
  satisfies; `FAILED`/`CANCELLED` block permanently
- **parent is structure, not a gate** — it must never be read as sequencing

### Scheduler MUST NOT assume

- that the graph mutates itself — it is immutable; a new snapshot yields a new
  graph
- that the graph claims, schedules or executes work — no such method exists
- that the graph persists anything — it has no write path whatsoever
- that the graph verifies completion — `COMPLETED` is read, never adjudicated
- that the graph owns task identity — **TaskStore allocates ids, exclusively**
- that `sourceMaxRevision` is a version or CAS token — it is a weak hint
- that `blockers()` on an unknown id returns `Blocker[]` — **it does not, today**
  (D1)

**TaskStore remains the sole mutation authority.** A Scheduler must derive
readiness from a TaskGraph, decide for itself, and then ask TaskStore to mutate.

## 19. Identity Foundation compatibility — `VERIFIED`

- 17 pre-existing suites: **230 pass / 0 fail** — identical to the pre-5C baseline
- 5 identity-specific suites (4A1, 4A4, 4A5, 4B, 4B1): **63 pass / 0 fail**
- no TaskGraph feature reinterprets identity; canonical task IDs, reordered task
  order and plan `taskId`s are untouched, and no TaskGraph commit modified any
  Identity Foundation test

## 20. Performance — `VERIFIED`, using existing evidence only

No new benchmark design and **no caching introduced**. Existing 5C evidence
re-confirmed on this machine:

| n | build | per node | `readyTasks()` |
|---|---|---|---|
| 5 000 | 23.80 ms | 4.76 µs | 0.47 ms |
| 10 000 | 54.13 ms | 5.41 µs | 0.73 ms |
| 20 000 | 100.71 ms | 5.04 µs | 1.91 ms |

Per-node cost is flat and size-doubling ratios settle at ~2 — **O(n + e)**
demonstrated, not asserted. One 20 000-node dependency SCC resolves in a single
Tarjan pass (110.92 ms). Blocker derivation remains O(deg) with degree ≤ 32. A
rebuild stays ~35 ms for 10 000 nodes across rounds, so a rebuild remains the
cache and none was added.

## 21. Validation matrix

| dimension | verdict | basis |
|---|---|---|
| **Runtime** | **VERIFIED** | 204 audit checks, 0 failures; 104/104 suite |
| **Typecheck** | **VERIFIED** (tooling now works) — **and it FAILED the code** | `tsc 7.0.2`, 54 errors, 26 from TaskGraph, 14 in production |
| **Mutation** | **VERIFIED** | 5C 17/18 + 1 equivalent; 5C.1 8/9; the type-only survivor now **killed by tsc** |
| **Integration** | **VERIFIED** | 10 real-TaskStore integration tests; 230/0 pre-existing suites; 63/0 identity suites |
| **Performance** | **VERIFIED** | O(n + e) re-confirmed; no cache added |
| **Safety** | **VERIFIED** | purity 7/7 ZERO; identity boundary intact; 9/9 defensive cases; no recursion |

The typecheck row is the one that decides this audit: the tooling works, and it
disagrees with the code.

## 22. Why the gate is BLOCKED, and the required fix

`TASKGRAPH HANDOFF READY` requires API/type consistency to be verified. It is
not. Two production defects and three test-file defects exist, all invisible to
104 passing runtime tests.

### Specified follow-up: **Phase 5D.1 — TaskGraph type-safety fix**

Scope, strictly:

1. **D1** — introduce `EMPTY_BLOCKERS: readonly Blocker[]` and return it from
   `blockers()`; leave `EMPTY_IDS` for the five string-returning methods.
2. **D2** — make the Tarjan frame access provably safe, by one of: a local
   non-null assertion justified by the `while` guard, a `pop()`-based loop, or an
   explicit `undefined` check that throws. Prefer the shape that removes the
   assertion entirely.
3. **Tests** — delete the dead `computeBlockers` import; stop calling `.sort()` on
   a `readonly string[]`; annotate the three `test.each` parameters as
   `TaskStatus`.
4. **Gate** — `tsc --noEmit` must report **zero** errors in
   `src/task/{graph,graph-validate,readiness}.ts` and in
   `test/phase5-taskgraph.test.ts`. Runtime suite must stay at 104/0.
5. Re-run mutation 5 to confirm it is still killed.

Out of scope for 5D.1: the 28 pre-existing errors in phase3/4 test files. Those
predate TaskGraph and belong in their own phase — but they should be recorded,
because **`tsc --noEmit` does not pass project-wide and therefore `gate:fast`
cannot be green**, for reasons that predate this subsystem.

### Not done in 5D, by instruction

No source modified. No TaskStore, protocol, MCP, identity or deletion change. No
Scheduler. No production wiring. Nothing pushed.

**Working tree: CLEAN at `bea0abe`.** The only environment change is the
gitignored `node_modules/` created by the frozen install, which §2 required and
which changed no tracked file.

---

## STOP

TaskGraph is a coherent, pure, well-tested read-only subsystem whose **runtime
semantics are verified and whose published types are not**. The correct next step
is a small, surgical type-safety fix — not a handoff, and not a redesign.

**A passing runtime suite is not type safety. A valid type is not semantic
correctness. Both must be checked separately, and only one of them has been.**
