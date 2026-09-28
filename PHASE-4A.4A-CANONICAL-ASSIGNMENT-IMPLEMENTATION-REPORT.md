# PHASE 4A.4A — CANONICAL ASSIGNMENT PROPAGATION REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `73bfecf` · Commit message: `feat: propagate canonical task assignments`

**NEW ARCHITECTURE.** Nothing here is a recovery. The pre-wipe writer had no
surviving caller, and the propagation boundary below never existed before 4A.4.

---

## 1. Actual plan call path

Traced in the code, not assumed. The kernel pairs `call` and `result` in a single
event:

```
runCall (vendor/minicore/src/core/executor.ts:89-102)
  tool.execute(args, ctx)            -> string
  result.content = serializeContent(...)
  emit execution:completed { execution: { call, result } }   <-- ONE object

adapter.ts  execution:completed handler
  if (!result.isError)                                    :769
  if (call.name === "todo_write")                         :771
    planFromTodos(call.args, sessionId, <decode off result.content>)  :782
    publish({ type: "plan.updated", ...(canonical ? {payloadVersion: 2} : {}) })
```

**The exact propagation point is `adapter.ts:782`** — the one place where the
declared payload (`call.args`) and the operation's own outcome (`result`) are
both in scope.

### Two kernel facts that forced the design

Both verified in `vendor/minicore` **before** choosing an approach:

1. **`ToolContext` has no tool-call id** (`tool.ts:22`): only `signal`, `state`,
   `cwd`, `permissionMode`, `emit`. A tool therefore *cannot name its own
   operation*, so it cannot key any channel it is handed. A keyed map is the only
   thing that could separate two in-flight writes — which is exactly why **there
   is no registry in this design**.
2. **Only the serialized string survives** (`serializeContent`, which can
   truncate an oversized result).

So the tool's **return value** is the only per-operation channel the kernel
itself correlates. The assignment rides there, as one trailing line.

**Consequence, stated plainly:** that string is also what the model and the TUI
see. The trailer is visible. I considered and rejected hiding it from the TUI
content store, because showing the model an id while hiding it from the user is
more confusing, not less.

**Rejected alternative:** a custom executor that would see the raw (unserialized)
tool return value and emit a separate structured event. That keeps model output
clean, but it means re-implementing the frozen kernel's `runCall` (permission
checks, argument validation, abort handling, snapshotting). Duplicating dispatch
semantics to save one line of cosmetic noise is a bad trade.

## 2. Assignment result design

`src/task/assignment.ts`:

```ts
type CanonicalAssignmentKind = "existing" | "new"
interface CanonicalAssignment { taskId: string; kind: CanonicalAssignmentKind }
type CanonicalAssignmentTable = readonly CanonicalAssignment[]
```

- **One entry per declared item, index-aligned with declaration order.** The
  order *is* the contract; the table is never sorted, deduped or re-derived.
- `kind` is carried because 4A.4 could not distinguish "confirmed an existing
  task" from "this operation created it" — the distinction the phase needed.
- No DB details. No TaskStore state duplicated. `taskId` is validated through
  `isTaskId`, so the wire format cannot drift from what the store accepts.
- `decodeCanonicalAssignments` returns `undefined` for **anything** it does not
  fully understand: missing trailer, foreign session, bad wire version, malformed
  id, duplicate id. "I don't understand this" and "this is not canonical" are
  deliberately the same answer.

## 3. New-task propagation

`src/task/sync.ts` builds the table **inside the transaction**, from the id
`createTask` actually returned:

```ts
const t = tx.createTask(sessionId, entry.input as never)
assignment.push({ taskId: t.id, kind: "new" })
```

The id is captured here and now, from the allocator. It is never re-derived from
position, title or content. Test **B** proves the assigned id is a real row
carrying the new title at `revision === 1`.

## 4. Existing-task propagation

An existing id is confirmed, never rewritten. Test **A**: an existing-only
payload assigns `["t1","t2"]`, both `existing`, creating no rows. Test **D**:
reordered explicit ids keep their own identity — `["t3","t1","t2"]`, three rows,
no remapping.

## 5. Mixed payload behavior

Test **C** — declared `t3=C, id-less D, t1=A` becomes `["t3","t4","t1"]` with
kinds `[existing, new, existing]`. Declaration order is preserved and every item
carries canonical identity.

## 6. Failure semantics — fail closed everywhere

| condition | result |
|---|---|
| sync fails / rolls back | tool throws; **no result, so no assignment can exist** |
| arity ≠ declaration | assignment rejected → legacy plan, no v2 |
| declared id contradicted | assignment rejected → legacy plan, no v2 |
| foreign session stamp | decode refuses → legacy plan, no v2 |
| malformed / duplicate id | decode refuses → legacy plan, no v2 |
| result truncated by `serializeContent` | trailer unparseable → legacy plan, no v2 |

Every rejection falls through to the 4A.4 provider path, which itself refuses
partial resolution. **No failure mode in the new code can produce `v2`** — test
**G** asserts that across seven distinct tamperings.

The rollback guarantee is *structural*, not a check: the table is built inside
`withTransaction`, and a rollback throws, so no table is ever returned (test **H**).

## 7. Concurrency / lifecycle safety

There is no state between events, so there is nothing to leak. Test **I**
delivers two operations' completions interleaved, B then A, and again A then B;
each plan follows its own result. Test **O** pins the case that makes leakage
observable: a second operation with **the same arity and same declared leading
id** but no assignment of its own must not inherit the first one's.

**A pre-existing hazard I did not introduce and did not fix:**
`todoSession` is a module-level singleton (`todo.ts:451`) read *after* the first
`await`, so two genuinely concurrent `todo_write` calls with **different
sessions** race on it. My first draft of test I hit exactly that and failed. It
is out of scope here, but it is real and worth a phase.

## 8. MCP isolation

Test **J** uses the real Phase 4A.3 API (`newMcpContextId`, `applyMcpContext`).
Each context's assignment decodes under its own namespace and is **refused** under
the other's; each store sees only its own new task. No MCP namespace semantics
were changed.

## 9. Plan version behavior

`payloadVersion: 2` is emitted **only** when the current operation produced a
complete, session-matched, non-contradictory assignment. TaskStore merely
*containing* a task is not sufficient — a plan built from a store snapshot is not
a canonical plan for *this* operation.

## 10. API boundary

The assignment is an explicit return value of `synchronizeCanonicalTasks`, an
explicit parameter of `planFromTodos`, and an explicit argument to the codec.
There is no module-level state, no singleton, no lookup by title/content, and no
reconstruction by ordinal. `assignment.ts` contains **0** module-scope `let`/`var`
(asserted by test **K**), no `globalThis`, no `static`.

## 11. Tests

`test/phase4a4a-canonical-assignment.test.ts` — **15 tests, 97 assertions, 0 fail.**

A existing · B new gets canonical id · C mixed · D reordered · E plan carries the
new id · F v2 for mixed · G 7 tamperings never yield v2 · H rollback publishes
nothing · I interleaved operations don't cross-wire · J MCP contexts · K no global
state · L legacy id-less unchanged · **M §14 canonical regression** · N duplicate
titles stay distinct · O no inheritance of an earlier assignment.

Test **N** exists because of mutation S8: a re-query-by-title implementation is
indistinguishable from the correct one *unless* two items share a title.

## 12. Mutation results — 10/10 killed, 0 survived, 0 harness miss

| # | mutant | result | killed by |
|---|---|---|---|
| S1 | drop the new-task assignment | KILLED | B |
| S2 | replace canonical id with an ordinal | KILLED | E |
| S3 | omit assignment propagation | KILLED | E |
| S4 | swap assignments between items | KILLED | A |
| S5 | reuse a **stale** assignment (module global) | KILLED | L |
| S6 | cache in a **process-global**, reuse on decode failure | KILLED | O |
| S7 | emit v2 with an incomplete assignment | KILLED | G |
| S8 | re-query the created task by title | KILLED | N |
| S9 | generate a **second** id locally | KILLED | B |
| S10 | ignore the transaction result | KILLED | H |

### Four harness defects I had to fix first — the first result was a lie

My first run reported **0/10 killed**. That was entirely my harness, not the code:

1. `/(\d+) fail/` matched bun's `0 fail` line for every run → every mutant read as
   a survivor.
2. Two patches aimed at one fragment made the second a guaranteed needle miss,
   leaving a **half-applied mutant in the tree**.
3. `bun test` writes results to **stderr**; reading stdout gave an empty tail and a
   **false green baseline**.
4. The next run captured that corruption as "pristine" — so I had to repair
   `sync.ts`, `todo.ts` and `adapter.ts` by hand and re-verify via `git diff`.

The harness now gates on SHAs, verifies restore after **every** mutant, and
refuses to run if a mutation artifact is present. The same class of error bit me
in 4A.4 (`git checkout --` discarding unstaged work); the lesson generalises —
**verify the harness before trusting its verdict.**

Two survivors in the first honest run were also my fault: I wrote both "global"
mutants inside a function scope, so they reset per call and were inert. Rewritten
as true module globals, S5 and S6 are killed. S6's survival is what produced
test **O**.

## 13. Validation

| check | result |
|---|---|
| PARSE | **VERIFIED** — 4 changed/new sources |
| RUNTIME (new suite) | **VERIFIED** — 15/15, 97 assertions |
| RUNTIME (focused, 7 files) | **VERIFIED** — 76 pass / 0 fail / 837 assertions |
| RUNTIME (broad, 20 files) | **VERIFIED** — 507 pass / 3 fail, byte-identical failure set to a clean `73bfecf` baseline worktree |
| MUTATION | **VERIFIED** — 10/10 killed |
| TYPECHECK | **DEFERRED** — `node_modules` absent |
| FULL SUITE | **DEFERRED** — 200+ files |

The 3 broad-sweep failures (2 purity audits, 1 web SSG) are **pre-existing**: I
verified them against a clean `git worktree` at `73bfecf` and the failure set is
identical, so the trailer introduced no fallout.

## 14. Regression evidence

`debc295` was **not** modified — its blob is identical to `HEAD`, and unskipped it
still passes its 19 assertions (i.e. the bad behaviour is still there, which is the
point of the evidence).

The new **GREEN** canonical counterpart is test **M**: `A(t1) B(t2) C(new)` yields
a plan of `t1, t2, t3` at `payloadVersion 2`; then `C(t3) A(t1) B(t2)` stays
`t3, t1, t2` with **3 rows, not 6** — reordering is not creation.

## 15. Safety audit

No violations. Verified individually rather than pattern-matched: 0 assignment
caches (the 8 `Map`/`Set` are pre-existing, plus one function-local duplicate
check); 0 module-scope mutable state in the new file (my 3 `let`s are
function-local); 0 content-based identity; 0 ordinal identity; 0 second allocator;
0 raw SQL; 0 `TaskGraph`; 0 `Scheduler`; 0 shared MCP namespace; 0 bootstrap.
`withTransaction` still has one definition and one production call site.

## 16. Files changed

| file | change |
|---|---|
| `src/task/assignment.ts` | **new** — table type + fail-closed codec |
| `src/task/sync.ts` | returns the assignment, built in-transaction |
| `src/tools/todo.ts` | emits it on the return value |
| `src/presentation/adapter.ts` | decodes it at `execution:completed`; fail closed |
| `test/phase4a4a-canonical-assignment.test.ts` | **new** — 15 tests |

`src/task/store.ts` and `src/task/model.ts` unchanged. `cli/setup.ts` unchanged
(the provider seam from 4A.4 is untouched).

## 17. Commit

`feat: propagate canonical task assignments`. SHA not self-cited — committing this
report changes it. Verify with `git log -1 --pretty=format:'%h %s'`. Tree CLEAN
after commit. **Not pushed.**

## 18. Explicit non-scope

Not implemented: 4A.5 all-id-less rejection, bootstrap/adoption, operator
migration, deletion changes, MCP semantics, TaskGraph, Scheduler, restart/reorder/
crash E2E, custom executor, plan-format changes.

**Still open, and honestly so:** the assignment is visible in tool output; the
pre-existing `todoSession` global still races across concurrent different-session
writes; TYPECHECK and FULL SUITE remain deferred.

## 19. Specimen note — a finding, not an accusation of a clean bill of health

While verifying the specimen I found `D:\git\minicode\.minicode\vector.db`
(40 KB, created 11:14 today) which was **not** present at the end of 4A.4.

- The **forensic evidence is intact**: `.freebuff\project-id` is 37 bytes and was
  last written at 02:02:37, ~9 hours before that window.
- My code cannot produce it: TaskStore writes `tasks.db`, todos write
  `todos/*.json`. `vector.db` holds `memory`/`memory_fts` tables.
- The only mechanism in this repo that writes it is **`test/context-audit.test.ts`
  writing relative to `process.cwd()`** — a pre-existing test-hygiene defect. I
  proved this by running it under a redirected cwd, where it created the file
  there instead.
- **I did not run that test in this phase** (it was not in my sweep list), so I
  cannot attribute the file to my commands; an external indexer over that
  directory is equally consistent with the timestamps.

I did **not** delete it: removing files from the protected specimen is itself a
write, and the call on that is yours. Flagging it, plus the latent defect, is the
honest disposition.

**Process fix adopted from here on:** every `bun test` invocation is run with an
explicit `cwd`, never the session default, which is `D:\git\minicode`.
