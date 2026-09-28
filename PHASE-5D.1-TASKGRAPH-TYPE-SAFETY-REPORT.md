# PHASE 5D.1 — TASKGRAPH TYPE SAFETY + API CONTRACT FIX

Working repository: `D:\recover\minicode-20260928\reconstruction`
Parent checkpoint: `bea0abe` (`fix: clarify TaskGraph not-ready semantics`)
Protected specimen `D:\git\minicode`: **never accessed or modified**

---

## DECISION

# TASKGRAPH TYPE GATE GREEN

**Gate A: 0 errors in TaskGraph production and tests** (was 26).
**Gate B: 28 pre-existing errors, none new.** Total `tsc --noEmit`: **54 → 28**.
**Runtime: 105 pass / 0 fail** (104 preserved, +1 new compile-sensitive regression).

**The 5C.1 type-only mutant is now COMPILER-KILLED. That survivor is closed.**

No TaskStatus change, no `PAUSED`, no TaskStore change, no semantics change, no
Scheduler. The 28 pre-existing errors were **not** touched.

---

## 1. Baseline — reproduced, not assumed

Per §1 the compiler was re-run from scratch before any edit.

```
bun install --frozen-lockfile   (already done in 5D; bun.lock SHA256 unchanged)
tsc 7.0.2 -p tsconfig.json --noEmit   ->  exit 1
```

| bucket | baseline |
|---|---|
| A. TaskGraph **production** (`graph.ts`, `graph-validate.ts`, `readiness.ts`) | **14** |
| B. TaskGraph **test** (`phase5-taskgraph.test.ts`) | **12** |
| C. **pre-existing**, out of scope (10 phase3/4 test files) | **28** |
| **total** | **54** |

Exactly matching 5D. The 28 are pre-existing: those files are byte-identical to
the pre-TaskGraph checkpoint `f378909`.

## 2. D1 — `blockers()` API type defect: FIXED

```
BEFORE  src/task/graph.ts(245): error TS2322:
          Type 'readonly string[]' is not assignable to type 'readonly Blocker[]'.
```

The signature promised `readonly Blocker[]`; the empty path returned
`EMPTY_IDS`, a `readonly string[]`. A consumer typing
`graph.blockers(id)[0]?.kind` was typing a `string` as a `Blocker`.

**Fix — a genuinely typed constant, no cast, no signature weakening:**

```ts
/** PHASE 5D.1 / defect D1. ... */
const EMPTY_BLOCKERS: readonly Blocker[] = Object.freeze([])   // L51

blockers(taskId: string): readonly Blocker[] {                 // L255
  const node = this.getNode(taskId)
  if (node === undefined) return EMPTY_BLOCKERS               // L257
  return computeBlockers(node, this.analysis.byId, this.analysis)
}
```

`Object.freeze([])` is `readonly never[]`, assignable to `readonly Blocker[]` with
**no `as` and no assertion** — so the fix is a real type, not a silenced one.
`EMPTY_IDS` remains for the five string-returning methods, where it is correct.
Both return paths are now `readonly Blocker[]`.

**Compile-sensitive regression added** (`D1: blockers() is typed as Blocker[] on
every return path`): it annotates `const kind: Blocker["kind"] | undefined =
g.blockers(id)[0]?.kind` for the absent-id path, the present-id path, and a
populated blocker, and assigns the whole array to `readonly Blocker[]`. Under the
original defect these annotations are type errors, because `string` has no
`kind`. Runtime assertions cannot catch a type defect; these can.

## 3. D2 — frame narrowing: FIXED structurally

13 × `TS18048: 'frame'/'caller' is possibly 'undefined'`, all in the iterative
Tarjan loop. `noUncheckedIndexedAccess` makes `frames[frames.length - 1]`
`Frame | undefined`, and a length check does **not** narrow an index expression.

**Fix — a control-flow pattern the compiler proves, with no assertion:**

```ts
const frame = frames.at(-1)
if (frame === undefined) break
...
const neighbour = frame.adj.at(frame.next)
if (neighbour !== undefined) { frame.next++; /* descend or lowlink */ continue }
// frame exhausted -> pop, maybe close an SCC
frames.pop()
...
const caller = frames.at(-1)
if (caller !== undefined) { /* propagate lowlink */ }
```

Three deliberate improvements beyond silencing the error:

1. **`.at(-1)` states that absence is possible**, and the `undefined` test is what
   makes the narrowing provable. No `!`, no `as`, no flag weakened.
2. **The `next < adj.length` bounds check was deleted, not translated.** It is
   subsumed by `adj.at(frame.next) === undefined`, which is exactly equivalent
   because `next` advances by 1 from 0 and `adj` never changes length. One test
   now covers both "has a neighbour" and "is exhausted".
3. **A pre-existing `as string` cast was removed.** `const neighbour =
   frame.adj[frame.next] as string` masked the *same* unchecked access as D2; the
   brief required all relevant access sites to be examined, so it went too.

Also replaced `sccStack.pop() as string` with an explicit `undefined` check.

13 errors → 0. Behaviour identical: `dependency cycle → VALID`, 20 000-node SCC
and the 100 000-deep chain both still resolve.

## 4. Test-file defects: FIXED (12 → 0)

| defect | fix |
|---|---|
| `computeBlockers` dead import (TS6133) | **removed** — verified 0 uses. It remains exported from `readiness.ts` as real public API used by `graph.ts`; only the unused *import* was deleted. Replaced by a genuinely `Blocker`-typed import for the D1 regression. |
| `.sort()` on `readonly string[]` (TS2339) | `expect([...eligible].sort())` — a defensive copy. The graph's own result is no longer mutated and its type is not weakened. `order ASC, taskId ASC` semantics untouched. |
| 3 × `test.each` `unknown` leak (10 errors) | converted to typed `for` loops over `ALL_STATUSES` |

### The `test.each` investigation (§6)

The brief asked me to investigate the three `unknown` leaks rather than paper
over them. The cause: bun types the `test.each` callback as
`(args_0: unknown, ...args: unknown[]) => void`. Annotating the parameter
`(status: TaskStatus)` does **not** work — it is not assignable, because the
framework promises to pass `unknown`:

```
error TS2345: Argument of type '(status: TaskStatus) => void' is not assignable to
  parameter of type '(args_0: unknown, ...args: unknown[]) => void | Promise<unknown>'.
```

So the choice was a cast or a different construct. I chose **typed `for` loops**,
which give real inference with **no `any`, no `as any`, and no suppression**:

```ts
for (const status of ALL_STATUSES) {
  test(`dependency with status ${status}`, () => { /* identical assertions */ })
}
```

Test **names and assertions are preserved exactly** (the `%s` becomes the
interpolated status). One bonus: the framework-level `unknown` boundary is gone
from the suite entirely.

The status matrix was also tightened: `EXPECTED` is now
`Record<TaskStatus, MatrixRow>` instead of `Record<string, …>`, so the compiler
proves the table is **complete** (a missing status is now a type error), and the
lookup uses an explicit `rowOf()` that throws on a missing row rather than
`as`-ing through `noUncheckedIndexedAccess`. `blocker` is typed
`Blocker["kind"] | ""`, which let one comparison be narrowed instead of cast.

## 5. Typecheck gate (§9)

**Gate A — TaskGraph type gate: PASS, 0 errors.**

| file | baseline | now |
|---|---|---|
| `src/task/graph.ts` | 1 | **0** |
| `src/task/graph-validate.ts` | 13 | **0** |
| `src/task/readiness.ts` | 0 | **0** |
| `test/phase5-taskgraph.test.ts` | 12 | **0** |

**Gate B — whole project: PASS, no new errors.** 28 pre-existing, unchanged.
Total **54 → 28**; exactly the 26 TaskGraph errors removed, nothing else.

The pre-existing 28 were deliberately **not** fixed, per §16. They still mean
`tsc --noEmit` does not pass project-wide and `gate:fast` cannot be green, for
reasons that predate TaskGraph.

## 6. The 5C.1 type survivor is CLOSED (§8)

The exact 5C.1 mutation, re-run on the fixed code:

| tool | result |
|---|---|
| `bun test` | **105 pass / 0 fail** — still passes, as expected for a type-only defect |
| `tsc --noEmit` | **7 TaskGraph errors**, including the decisive one: |

```
src/task/graph.ts(248,16): error TS2322:
  Type '"eligible-not-ready"' is not assignable to
  type '"blocked" | "graph-invalid" | "not-eligible" | "ready"'.
```

and, notably, `TS2367: This comparison appears to be unintentional because the
types ... have no overlap` in the test — the tests are themselves now
compile-sensitive to the union's shape.

**COMPILER-KILLED.** The 5C.1 survivor is closed. This is a **compiler** kill
and is not scored as a runtime kill.

## 7. Regression (§10, §7)

| gate | result |
|---|---|
| TaskGraph suite | **105 pass / 0 fail** (104 preserved + 1 new) |
| 17 pre-existing suites (TaskStore + Identity Foundation) | **230 pass / 0 fail — identical to baseline** |
| 10 000-deep parent chain | pass |
| 10 000-deep dependency chain | pass |
| 10 000-deep parent **cycle** | pass, detected, no overflow |
| 200-child fan-out | pass, valid, `MAX_PARENT` still unenforced |
| 1 000-node graph | pass |
| dependency cycle → VALID + permanent blocker | pass |
| parent cycle → INVALID | pass |
| diamond is not a cycle | pass |
| invalid graph never throws / no `readyTasks` | pass |
| `sourceMaxRevision` | pass |
| cycle detection is iterative (structural audit) | pass |

**Every 5C.1 assertion preserved verbatim**, including
`BLOCKED + zero blockers → eligible-not-ready`, `BLOCKED + blockers → blocked`,
`PENDING ± blockers`, the five-state union, and the
eligible⊋ready consistency test. No assertion was weakened, deleted, or rewritten
to hide anything.

## 8. Focused mutation campaign (§11)

8 targets, each scored on **both** tools. A type-only defect was not forced to be
runtime-visible.

| # | target | verdict |
|---|---|---|
| D1c | `blockers()` returns `EMPTY_IDS`, no cast (the original defect) | **COMPILER-KILLED** — exact `TS2322`; runtime survived |
| D1a | `blockers()` returns `EMPTY_IDS as never` | compiler-killed, but only by the *unused-constant* error |
| D1b | `blockers()` returns `(EMPTY_IDS as unknown) as readonly Blocker[]` | compiler-killed, but only by the *unused-constant* error |
| D2a | `frames.at(-1)` → `frames[frames.length-1]!` | **SURVIVED** |
| D2b | `adj.at(next)` → `adj[next] as string` | **SURVIVED** |
| D2c | `caller.at(-1)` → `caller = frames[len-1]!` | KILLED (runtime) |
| D3 | `eligible-not-ready` removed from the union | **COMPILER-KILLED** (7 errors); runtime survived |
| D4a | ordering by `title` | KILLED (runtime) |
| D4b | drop the `taskId` tiebreak | KILLED (runtime) |

**3 compiler-killed · 3 runtime-killed · 2 survived · 0 harness misses.**

### Two honest negatives

**D2a/D2b survived, and that matters.** Both reintroduce an *unchecked* frame
access — but disguised it with `!` or `as string`, which is exactly what
suppresses the compiler. So nothing — not the type system, not the runtime suite
— prevents a future contributor from undoing D2 that way. **D2's guarantee rests
on the code as written, not on an automated guard.** The compensating control is
the §9 static audit, which greps for `!` and unchecked-index patterns. That is a
weaker control than a test, and I am recording it as such rather than implying D2
is regression-protected.

**D1a/D1b survived as *meaningful* kills.** My first two D1 mutants were badly
chosen: they added casts the original defect did not have, and a cast is
precisely the mechanism by which TypeScript is silenced. Both were flagged only
by `EMPTY_BLOCKERS` becoming unused, not by any type relationship. The mutant
that actually represents D1 is **D1c** (no cast), and it is killed by the real
`TS2322`. Recorded because "a cast-based regression is not caught by the type
system" is a true and unavoidable property of TypeScript, not a gap in this fix.

## 9. Static safety audit (§12)

| check | production | test file |
|---|---|---|
| `any` | ZERO | ZERO |
| `@ts-ignore` | ZERO | ZERO |
| `@ts-expect-error` | ZERO | ZERO |
| `as any` | ZERO | ZERO |
| double cast (`as unknown as` / `as never`) | **ZERO** | 1 (pre-existing) |
| non-null assertion `!` | **ZERO** | 1 (pre-existing) |
| tsconfig weakened | **ZERO** | — |
| `PAUSED` | ZERO | 3 — the purity test's own forbidden-token list |
| durable `READY` | ZERO | 6 — purity/`notReadyReason` assertions |
| I/O | ZERO | 15 — the purity audit + integration test's own temp dir |
| Scheduler / executor | ZERO | ZERO |
| identity allocation | ZERO | 4 — forbidden-token list |

`tsconfig.json` **not modified** (0 changes) — `strict` and
`noUncheckedIndexedAccess` intact.

The two non-zero test entries are **pre-existing from 5C, not introduced by 5D.1**
(verified against the diff: 0 added lines match):

- `snap.tasks[0]!.title` — the immutability test mutating a known-present element.
- `(g as unknown as Record<string, unknown>)[name]` — the forbidden-methods check,
  which needs a string-keyed view of the instance. A documented, unavoidable
  boundary for asserting an *absence*.

`graph-validate.ts` retains 4 narrow `as string | number` casts on
`Map.get(...)`. Pre-existing, not part of D2, and typecheck-clean.

**Production code introduced zero `any`, zero double casts, zero non-null
assertions, zero suppressions.**

## 10. API consistency (§13)

All twelve methods plus `sourceMaxRevision` match design lock S19 exactly, and
`sessionId`/`nodeCount` are carried per S15. Exported types (`GraphNode`,
`Diagnostic`, `Blocker`, `BlockerKind`, `NotReady`, `TaskStatus`) agree with the
implementations.

`blockers()` is the member the audit was built around, and it now satisfies
`readonly Blocker[]` on **both** return paths (L257 `EMPTY_BLOCKERS`, L258
`computeBlockers`). `notReadyReason(): NotReady | undefined`,
`validity(): { valid; diagnostics }`, `readyTasks(): readonly string[]` and
`isReady(): boolean` all match the design lock.

**Runtime semantics and type semantics now describe the same contract.**

## 11. Historical evidence preserved (§14)

- **`debc295`** (`test: preserve task identity duplication regression`) — present
  and **untouched**. It was not modified, moved, or deleted.
- 5C and 5C.1 mutation results and their reports are unchanged.
- `PHASE-5D-TASKGRAPH-FINAL-HANDOFF-AUDIT.md` is **preserved unchanged** and is
  committed together with this phase, as one historical checkpoint per §16. No
  separate documentation-only commit for 5D was created.
- No old test was rewritten to hide a previous defect. The three `test.each`
  conversions preserve test names and assertions; the 5C/5C.1 suites are otherwise
  untouched.

## 12. Files changed

```
src/task/graph.ts              +EMPTY_BLOCKERS; blockers() returns it      (D1)
src/task/graph-validate.ts     Tarjan loop: .at() + explicit narrowing      (D2)
test/phase5-taskgraph.test.ts  dead import, readonly sort, 3x test.each,
                               matrix Record<TaskStatus>, +D1 regression
PHASE-5D-TASKGRAPH-FINAL-HANDOFF-AUDIT.md   (untracked from 5D -> committed)
PHASE-5D.1-TASKGRAPH-TYPE-SAFETY-REPORT.md  (this file)
```

**Untouched:** `model.ts` (`TaskStatus`), `store.ts`, `identity.ts`, `sync.ts`,
`assignment.ts`, `todo.ts`, `tsconfig.json`, `package.json`, `bun.lock`, and all
28 pre-existing failing test files.

## 13. Handoff status

Phase 5D blocked the handoff on two counts, and both are now closed:

| 5D blocker | status |
|---|---|
| D1 — public API type defect | **FIXED**, compile-sensitive regression added |
| D2 — frame narrowing unprovable | **FIXED**, no assertions; static audit is the residual control |
| 5C.1 type-only mutant | **COMPILER-KILLED — CLOSED** |
| Typecheck as a project gate | still red, but only from the 28 pre-existing errors |

**The TaskGraph handoff gate is now satisfied on the criteria 5D could not
previously meet.** I am not re-issuing `TASKGRAPH HANDOFF READY` from here: 5D
recorded the decision as BLOCKED, and declaring READY is 5D's call to make on the
strength of this evidence, not mine to overwrite. The one judgement left for you
is the D2a/D2b residual — whether an `!`/cast-based regression is acceptable
given the static audit as its only control, or whether that warrants a dedicated
lint rule.

## STOP

Runtime correctness and type correctness are now both proven for TaskGraph, by
separate tools, and neither was used to stand in for the other.

Not started: Scheduler · readiness consumer · TaskGraph production wiring ·
execution · claiming · retry orchestration · deletion redesign · bootstrap ·
MCP persistence. Nothing pushed.
