# PHASE 5C.1 — NOT-READY SEMANTIC CORRECTION REPORT

Working repository: `D:\recover\minicode-20260928\reconstruction`
Previous HEAD: `bcae0d4` (`docs: record TaskGraph implementation commit SHA`)
Parent of the implementation: `7bff3bc` (`feat: implement TaskGraph`)
Protected specimen `D:\git\minicode`: **never accessed or modified**

---

## DECISION

# NOT-READY SEMANTICS CORRECTED

`eligible ≠ ready` is now represented explicitly. **`NotReady` has five states.**
**104 tests, 0 failures** (was 94). **8 of 9 mutants killed, 0 harness misses.**
No production file outside the three TaskGraph modules was touched.

---

## 1. The defect, stated plainly

**The original 5B contract was internally inconsistent for `BLOCKED` + zero blockers.**

5B made two decisions that cannot both hold for that one input:

- **§8** put `BLOCKED` in the eligible set, and said so explicitly and repeatedly.
- **§8** also required `status === "PENDING"` for readiness, so `BLOCKED` is
  *never* ready.
- **§9** offered a four-state `NotReady` union, none of whose members could
  describe a task that is **eligible** yet **not ready**.

| candidate state | why it is wrong |
|---|---|
| `ready` | false — it is not ready |
| `blocked` | false — `blockers` would be `[]`, a self-contradiction |
| `not-eligible` | false — it **is** eligible; this is the literal negation of §8 |

**Phase 5C exposed the reachable state.** Any durably-`BLOCKED` task with no
relations produces it. The 5C implementation was therefore forced to emit
`{ kind: "not-eligible", status: "BLOCKED" }` — reporting a task as ineligible
while `eligibleTasks()` simultaneously listed it. **That is a contract that
contradicts itself, and the implementation was right to report it rather than
quietly make the enum fit the state model.**

This is a **NEW ARCHITECTURE correction.** It is not a recovery, not a
reinterpretation of a lost original, and not a compatibility shim. No
`TaskStatus` value was added, removed or reinterpreted.

## 2. The correction

`NotReady` is now **five** states:

```ts
type NotReady =
  | { kind: "ready" }
  | { kind: "eligible-not-ready"; status: TaskStatus }   // ADDED by 5C.1
  | { kind: "not-eligible"; status: TaskStatus }
  | { kind: "blocked"; blockers: readonly Blocker[] }
  | { kind: "graph-invalid"; diagnostics: readonly Diagnostic[] }
```

The old four-state wording was **not** preserved: §9, §8, §13 and §25 of the
design lock were all amended, and a marked `AMENDMENT 5C.1` section was added at
the top of the document so the change is auditable rather than a silent rewrite.

### Corrected status semantics

All eight real `TaskStatus` values, unchanged and unexpanded:

| status | `notReadyReason` (no blockers) | `eligibleTasks()` | `isReady()` | satisfies a dependency |
|---|---|---|---|---|
| `PENDING` | `ready` | listed | **true** | no |
| `BLOCKED` | **`eligible-not-ready`** | **listed** | false | no |
| `IN_PROGRESS` | `not-eligible` | not listed | false | no |
| `VERIFYING` | `not-eligible` | not listed | false | no |
| `RETRYING` | `not-eligible` | not listed | false | no |
| `COMPLETED` | `not-eligible` | not listed | false | **yes** |
| `CANCELLED` | `not-eligible` | not listed | false | no |
| `FAILED` | `not-eligible` | not listed | false | no |

With blockers present, `blocked` outranks the status column for **every** row,
including `BLOCKED` itself. An invalid graph returns `graph-invalid` for every
id. No `READY` and no `PAUSED` were introduced; a test re-derives `TASK_STATUSES`
from the model source to prove it is still exactly eight values.

## 3. Implementation — smallest possible surface

Two files, both inside the TaskGraph module:

- **`src/task/readiness.ts`** — added the `eligible-not-ready` variant to the
  `NotReady` union, with a comment recording why the four-state version could not
  represent the state. No logic change.
- **`src/task/graph.ts`** — `notReadyReason` gained one branch, placed between
  `ready` and `not-eligible`:

```ts
if (eligibleForReadiness(node)) {
  return { kind: "eligible-not-ready", status: node.status }
}
```

That branch tests **`eligibleForReadiness`**, not the literal `"BLOCKED"`. This
is deliberate: `eligibleTasks()` uses the same predicate, so the two cannot drift
apart if the eligible set ever changes. Hard-coding `"BLOCKED"` would have let
the classification silently disagree with `eligibleTasks()`.

**Deliberately unchanged:** `eligibleForReadiness`, `isReady`, dependency
semantics, cycle semantics, validity, blockers, ordering, immutability, the
public API list, and every other production file. TaskStore, the task protocol,
MCP, identity and synchronization were not touched.

## 4. Tests

`test/phase5-taskgraph.test.ts`: **94 → 104 tests, 0 failures.**

Focused coverage, named to the brief:

| brief | test |
|---|---|
| A | `BLOCKED` with zero blockers → `eligible-not-ready`: eligible listed, ready excluded, `isReady` false, `blockers()` empty |
| B | `BLOCKED` with a dependency blocker → `blocked` |
| C | `PENDING` with no blockers → `ready` |
| D | `PENDING` with blockers → `blocked` |
| E | all six non-eligible statuses → `not-eligible` |
| F | invalid graph → `graph-invalid`, even for a `BLOCKED` task |
| G | every status × blocker combination pinned — exhaustiveness for a valid graph |

Plus three consistency guards the amendment made necessary:

- `eligible-not-ready` is **never** emitted for a non-eligible task (no leak).
- `eligibleTasks()` minus `readyTasks()` is exactly the eligible-not-ready set.
- The status matrix gained a fifth `reason` axis, so all eight statuses assert
  their `notReadyReason` state, plus a guard that the three status-derived states
  remain reachable in the fixtures.

## 5. Mutation results

9 targets, sandbox only, the repository never mutated.

| # | mutation | verdict |
|---|---|---|
| 1 | map `BLOCKED`/no-blocker → `not-eligible` (the pre-5C.1 behaviour) | **KILLED** (5) |
| 2 | map `BLOCKED`/no-blocker → `blocked` | **KILLED** (5) |
| 3 | make `BLOCKED` ready | **KILLED** (5) |
| 4 | remove the `eligible-not-ready` branch entirely | **KILLED** (5) |
| 5 | collapse `eligible-not-ready` into `not-eligible` **(type only)** | **SURVIVED** |
| 6 | `eligibleForReadiness` drops `BLOCKED` | **KILLED** (7) |
| 7 | precedence swap — status checked before blockers | **KILLED** (3) |
| 8 | any eligible status reported as `ready` | **KILLED** (5) |
| 9 | `eligible-not-ready` returned with no `status` field | **KILLED** (3) |

**8 killed · 1 survived · 0 equivalent · 0 harness misses.**

All five mutations the brief required (1–5) are present; 1–4 are killed and 5 is
reported below rather than explained away.

### Why mutation 5 survived — and why it is not an equivalent mutant

Mutation 5 edits **only the type declaration**. A TypeScript union has no runtime
representation: the emitted JavaScript is byte-identical, so all 104 tests pass
unchanged. Verified directly — a deliberately mis-typed object
(`const x: {kind:"a"} = {kind:"b"}`) runs without complaint under bun.

It is **not** equivalent, though. With the `eligible-not-ready` variant removed
from the union, `graph.ts` returning `{ kind: "eligible-not-ready", … }` is a
**compile-time type error**. So this mutant is invisible to a runtime suite and
would be caught by `tsc` — which is **DEFERRED** in both 5C and 5C.1 because
`node_modules` is absent.

**Honest consequence:** the `NotReady` union is a *compile-time* contract only. The
runtime `kind` strings are covered by tests; the type's own shape is not verified
until typecheck runs. Closing that gap is the single highest-value follow-up, and
this mutant is the evidence for it.

## 6. Design-consistency audit

Every `not-eligible` occurrence in the implementation and tests was inspected:

| location | classification |
|---|---|
| `readiness.ts` union member | **correct** — union definition |
| `graph.ts` the single `return { kind: "not-eligible", … }` | **correct** — reached only after the `eligibleForReadiness` guard, so it is unreachable for any eligible task |
| `graph-validate.ts` | **unrelated** — zero occurrences; validity never reports eligibility |
| test names, matrix entries, comments | **test/doc** — all assert the corrected semantics |

The invariant is structural, not incidental: the only production `not-eligible`
return sits directly behind `eligibleForReadiness(node)`, so no eligible task can
reach it. Mutant 6 confirms it by removing `BLOCKED` from the eligible set, and
mutants 1/2/4 confirm the branch itself.

Cross-method agreement for all eight statuses is asserted exhaustively in test G.

## 7. Regression

| gate | result |
|---|---|
| Full 5C/5C.1 TaskGraph suite | **104 pass / 0 fail** (was 94/0) |
| 10 000-deep parent chain | pass, no `RangeError` |
| 10 000-deep dependency chain | pass, no `RangeError` |
| 10 000-deep parent **cycle** | pass, detected without overflow |
| 200-child fan-out | pass (`> MAX_PARENT`, still unenforced) |
| 1 000-node graph | pass |
| dependency cycle → VALID + permanently blocked | pass |
| parent cycle → INVALID | pass |
| diamond is not a cycle | pass |
| TaskStore + Identity Foundation (17 suites) | **230 pass / 0 fail — identical to baseline** |

### One transient failure, disclosed

A single run of the 17 pre-existing suites reported **229 pass / 1 fail**. It did
not reproduce in the immediate re-run nor in **three** subsequent consecutive
runs (all 230/0). Cause: not a 5C.1 regression. Decisive evidence — the three
TaskGraph modules have **zero production importers**; the only reference outside
their own files is prose in a scope comment at `src/task/identity.ts:22`, and the
only test file importing them is `phase5-taskgraph.test.ts`. With the graph
unwired, no other suite can be affected. Classified **BASELINE-FLAKE**.

No new performance work was done, per the brief.

## 8. Known limitations

1. **The `NotReady` type shape is unverified at compile time.** Mutation 5
   demonstrates the gap; typecheck is DEFERRED (`node_modules` absent). The
   runtime `kind` strings are fully covered.
2. **One transient flake** appeared in the pre-existing suites (§7), unreproducible
   in four runs and unreachable from 5C.1's change surface.
3. **Inherited from 5B/5C, unchanged here:** `sourceMaxRevision` is a weak hint (a
   new task does not raise it); `MAX_PARENT = 64` remains unenforced in
   `store.ts`; `notReadyReason` returns `undefined` for an unknown id;
   `docs/ARCHITECTURE.html` is not updated and its test already fails for
   pre-existing reasons.
4. **No consumer reads the new variant yet.** The Scheduler boundary is still only
   a contract, so nothing depends on the shape yet — which is precisely why now was
   the right time to correct it.

## 9. Checkpoint

Recorded in the commit that follows this report; a commit cannot contain its own
hash.

Files changed in 5C.1 (4 files, +300 / −55):

```
PHASE-5B-TASKGRAPH-NEW-ARCHITECTURE-DESIGN-LOCK.md   amended: AMENDMENT 5C.1 + S8/S9/S13/S25
src/task/readiness.ts                                 NotReady: four states -> five
src/task/graph.ts                                     notReadyReason: +1 branch
test/phase5-taskgraph.test.ts                         94 -> 104 tests
```

No production file outside `src/task/` was modified. Nothing was pushed.

---

## STOP

Corrected the semantic representation only. Not started, per the stop condition:
Scheduler · Scheduler readiness consumer · claim · execution · retry
orchestration · TaskGraph production wiring · deletion redesign.

**A task may be eligible without being ready. The public API now says so
explicitly.**
