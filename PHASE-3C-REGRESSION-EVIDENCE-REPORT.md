# PHASE 3C-REGRESSION-EVIDENCE REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `9d7dcfe`
Commit message: `test: preserve task identity duplication regression`

**No production semantics were changed.**

---

## 1. Exact reproduction scenario

```
INITIAL declaration (id-less, as the model can only send)
  A
  B
  C

after synchronizeIdentities  ->  t1 = A   t2 = B   t3 = C

SECOND declaration: the SAME logical tasks, REORDERED, still id-less
  C
  A
  B
```

The second payload is the exact scenario from the identity contract's reorder
axiom. The runtime has no information with which to decide `C → t3`, because
the tool schema sets `additionalProperties: false` on todo items (no `taskId`
can be sent) and `renderTodos` never returns one. `applyTaskIdentities`
therefore treats all three items as new tasks.

## 2. Observed result

```
t1 = A  order 0        t4 = C  order 0
t2 = B  order 1        t5 = A  order 1
t3 = C  order 2        t6 = B  order 2
                        ---- 6 rows total
```

- `A` exists as **t1 and t5**; `B` as **t2 and t6**; `C` as **t3 and t4**
- the original rows t1/t2/t3 are **still present and unmoved**
- `order` **collides**: three distinct values across six rows
- note the duplicate of `C` (t4) sorts *before* the original `t3`, because the
  reordered payload put `C` first and gave its copy `order 0` while `t3` still
  carries `order 2` from the initial payload
- a later fully-addressed write (`taskId: t1/t2/t3`) addresses the originals and
  leaves t4/t5/t6 in place — the duplicates are **unrecoverable** through the
  explicit-id path

## 3. Why this is known-bad

It is the concrete failure behind three invariants that are deliberately **not**
satisfied today:

| invariant | status |
|---|---|
| I3 — `taskId` survives reorder | VIOLATED — reorder duplicates instead of preserving |
| I5 — an existing task never silently becomes a new task | VIOLATED — A/B/C each became new tasks |
| I7 — one logical task cannot create duplicate durable rows | VIOLATED — 3 logical tasks, 6 rows |

It also directly invalidates the "positional adoption" candidate from the
bootstrap design lock: adopting by position does not merely *transfer* identity
on reorder, it **duplicates** it, and the duplicates cannot be cleaned up
afterwards.

**This test does not assert that this behaviour is correct.** It documents what
the system does today so the defect cannot be silently changed or silently
rediscovered.

## 4. Test location

`test/phase3c-identity-duplication.known-bad.test.ts`

Test name: `knownBad_reorderOfIdlessPayloadDuplicatesTasks`

Harness reused from `test/phase3a-identity.test.ts`: `bun:test`,
`mkdtemp(join(tmpdir(), "minicode-dup-"))` per test, `resetTaskStoreHandles()` +
removal of that one absolute path in `afterEach`. Real `TaskStore` on a real
SQLite file. No external dependencies. No second test framework.

## 5. Default skip behaviour

Gated with `test.skipIf(!process.env.MINICODE_KNOWN_BAD_EVIDENCE)` — the
project-consistent env-gated idiom (cf. `test.skipIf` in
`agent-contract.test.ts`, `const it = live ? test : test.skip` in
`extreme-live.test.ts`).

```
$ bun test test/phase3c-identity-duplication.known-bad.test.ts
  (skip) knownBad_reorderOfIdlessPayloadDuplicatesTasks
  0 pass
  1 skip
  0 fail
```

**The repository stays GREEN by default.** A passing test for wrong behaviour
would make the suite assert that the bug is correct.

## 6. Manual execution result

```
$ MINICODE_KNOWN_BAD_EVIDENCE=1 bun test test/phase3c-identity-duplication.known-bad.test.ts
  (pass) knownBad_reorderOfIdlessPayloadDuplicatesTasks
  19 expect() calls
  Ran 1 test across 1 file.
```

This is the **six-row reproduction proven**, with 19 assertions covering: the
premise (`t1=A,t2=B,t3=C`), the row count, per-title duplication, survival of
the originals, the exact observed list including order values, the order
collision, and the unrecoverability through the explicit-id path.

**FUTURE OBLIGATION.** When the identity contract is implemented, this test must
**fail in its current form**, or be rewritten to assert the new correct
behaviour and unskipped. It must not be left passing while duplication still
occurs.

## 7. Mutation results

Run against `src/task/identity.ts`, with the gate env var set on each child
(otherwise the test is skipped and proves nothing). Pristine bytes restored and
**SHA-verified** after every mutant.

| id | mutant | result |
|---|---|---|
| A | duplicate row count changes — id-less items not written at all | **KILLED** |
| B | only one duplicate created (deduped by title) | **KILLED** |
| C | originals disappear — session cleared before re-creating | **KILLED** |
| D | one logical task remapped instead of duplicated (positional patch) | **KILLED** |
| E | reorder silently ignored (all-id-less plan is a no-op) | **KILLED** |

```
killed=5  survived=0  equivalent=0  needle-misses=0
bytes restored identical: true
```

All five requested behaviours are covered by at least one killed mutant. No
mutant was forced; no result was invented.

## 8. Files changed

| file | change |
|---|---|
| `test/phase3c-identity-duplication.known-bad.test.ts` | **new** — the regression evidence |
| `PHASE-3C-REGRESSION-EVIDENCE-REPORT.md` | **new** — this report |

**Zero** production files modified. Verified by hash against `HEAD`:

```
MATCH  src/presentation/adapter.ts
MATCH  src/presentation/events.ts
MATCH  src/task/store.ts
MATCH  src/task/model.ts
MATCH  src/task/identity.ts
MATCH  src/tools/todo.ts
```

No existing test modified. No schema change. No task identity behaviour change.
No TaskStore change. No protocol change. No transaction API. No MCP change. No
deletion-semantics decision. No bootstrap-semantics change.

## 9. Commit

Message: `test: preserve task identity duplication regression`

The SHA is deliberately **not** self-cited: committing this report changes it.
Verify with `git log -1 --pretty=format:'%h %s'`.

## 10. Working-tree status

**CLEAN** after commit. Not pushed.

Incident specimen `D:\git\minicode` untouched. `repo-from-remote` unchanged.
`node_modules` still absent — no dependency was installed.

## 11. Explicit statement

**No production semantics were changed.**

This phase added one skipped-by-default test that documents a measured defect.
It defines nothing about what the system should do tomorrow.

**Not decided here:** any identity-contract question; the `taskId` protocol
change; the transaction API; MCP naming; deletion semantics; all-id-less
semantics. Production TaskStore wiring remains BLOCKED and untouched.
