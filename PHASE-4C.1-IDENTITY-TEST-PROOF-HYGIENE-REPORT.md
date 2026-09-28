# PHASE 4C.1 — IDENTITY TEST PROOF HYGIENE REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `3c82d2c` · Commit message: `test: clarify identity lifecycle proof`

**TEST-ONLY CLEANUP.**

---

## 1. Original ambiguity

Phase 4C's test-quality audit flagged `test/phase4b-identity-lifecycle.test.ts:401`
as computing a `planFor(...)` result that was later discarded with `void events`,
sitting immediately above the real assertion.

**Inspecting it (STEP 1) revealed the finding was worse than "dead code".**
`planFor` hardcodes its result shape:

```ts
// test/phase4b-identity-lifecycle.test.ts:98  (inside planFor)
result: { isError: false, content: result },
```

So the discarded call

```ts
const events = planFor(dir, [{ content: "C" }], "rejected", S)
```

modelled a **SUCCESSFUL** tool result — the exact opposite of the rejected-write
case test 11 exists to prove. Read casually, `planFor(..., "rejected", ...)` suggests
"no plan is published for a rejected write", but that call *publishes* one. The
dead line was therefore actively misleading, not merely redundant.

### STEP 1 answers, established by reading rather than guessing

| question | answer |
|---|---|
| why is `planFor(...)` called? | vestigial — I kept it from an earlier draft that had two competing plan assertions |
| which result is actually asserted? | line 417: `expect(seen.filter(e => e.type === "plan.updated")).toHaveLength(0)` over the **explicit** bus at 403–409, emitting `isError: true` |
| does the discarded result have side effects? | **no** — `planFor` builds its own local `fakeBus`, adapter and `seen` array; the adapter is bound to that local bus, so nothing escapes to the real assertion |
| does removing it change behaviour? | **no** — verified empirically: identical pass *and* assertion counts before and after |

## 2. Actual assertion path

```
canonical TaskStore rows (t1=A t2=B t3=C)
  ↓  rejected id-less write, zero mutation  (asserted: idMap, revisions, row
  ↓                                          count, nextId all unchanged)
no plan for the rejected write
  ↓  real adapter + real TaskStore provider, execution:completed with
  ↓  result: { isError: true, content: "TASK_IDENTITY_REQUIRED" }
expect(seen.filter(e => e.type === "plan.updated")).toHaveLength(0)
```

The load-bearing detail is `isError: true` — the adapter publishes only on
`!result.isError`. The shared `planFor` helper **cannot** express that, which is
precisely why this assertion is inline.

## 3. Cleanup

The smallest correction (STEP 2):

- **Removed** the dead `const events = planFor(...)` and the trailing `void events`.
- **Kept** the genuine event-bus assertion exactly as it was.
- **Added** a comment stating *why* this test does not use `planFor`, so a future
  maintainer cannot "simplify" it back into the misleading form, and a second
  short note marking `isError: true` as the load-bearing part.

No assertion was added, removed, or weakened. No variable renaming was needed.
`+11 / -3`, all in one file.

## 4. Tests

| run | before | after |
|---|---|---|
| affected file | 10 pass / **110 expect** | 10 pass / **110 expect** |
| all 11 identity suites | 129 pass / 1113 expect | 129 pass / **1113 expect** |
| `debc295` evidence | unchanged, 19 | unchanged, 19 |

**Assertion counts are byte-identical**, which is the direct evidence that no
coverage was lost and no semantic result changed. The identity chain
(canonical identity → plan identity → `plan.updated`) remains proven: positively by
tests 9 and 10 through the real adapter, and negatively by test 11 here.

## 5. Mutation

A full campaign was **not** required: the cleanup changed no assertion logic — it
deleted a non-assertion and added comments.

I did run **one sanity mutant** to confirm the surviving assertion is not vacuous
(which is the whole point of this phase), rather than assume it:

| mutant | result |
|---|---|
| adapter publishes even when `result.isError` is true | **KILLED** — test 11 fails |

If that mutant had survived, the retained assertion would have been decorative and
this phase would not have achieved its objective. It did not survive.

## 6. Files changed

| file | change |
|---|---|
| `test/phase4b-identity-lifecycle.test.ts` | dead `planFor` call and `void events` removed; clarifying comments added |

## 7. Safety (STEP 6)

| check | result |
|---|---|
| `src/` files changed | **0** |
| `cli/` files changed | **0** |
| `TaskStore` unchanged | ✅ verified by `git status src/` |
| identity implementation unchanged | ✅ |
| protocol unchanged | ✅ |
| MCP unchanged | ✅ |
| prior-phase tests unchanged | ✅ only this one test file modified |
| mutation restore | `adapter.ts` restored, SHA-verified, 0 `src/` changes |

## 8. Commit

`test: clarify identity lifecycle proof`. SHA not self-cited — committing this
report changes it. Tree CLEAN after commit. **Not pushed.** Specimen untouched; all
runs used an explicit redirected `cwd`.

## 9. Statement

**No production semantics changed.**

This phase modified exactly one test file, removed a dead computation and added
clarifying comments. No assertion was added, removed or weakened; assertion counts
are identical before and after. No production code — `src/`, `cli/`, TaskStore,
identity, protocol or MCP — was touched.
