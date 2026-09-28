# PHASE 4A.4 — PRODUCTION TASK SYNC IMPLEMENTATION REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `3336564`
Commit message: `feat: connect canonical tasks to production`

**NEW ARCHITECTURE — this is the FIRST production consumer of TaskStore.** The
pre-wipe writer did not survive the wipe: `store.orig.ts` defined
`synchronizeTasks` but **nothing in any recovered file called it**. Nothing here
is a recovery.

---

## 1. Production write boundary

```
todo_write (src/tools/todo.ts)
   -> normalizeTodos            preserves taskId (4A.1)
   -> saveTodos                 JSON durable write      [unchanged]
   -> synchronizeCanonicalTasks TaskStore transaction   [NEW - this phase]
   -> savePlanSnapshot          plan artifact           [unchanged]
   -> (tool returns) -> adapter publishes plan.updated [unchanged]
```

The seam is inside `todoWriteTool.execute`, immediately after `saveTodos`.

**Placement rationale — a design decision, recorded explicitly.** The ordering
is the one production already proves: a durable write precedes plan
publication, so a failed durable write suppresses the plan
(`src/presentation/adapter.ts`, whose comment documents exactly that rationale).
Reusing the existing boundary is what lets a TaskStore failure suppress the
plan **for free** — the tool throws, the result is `isError`, and the adapter's
`if (!result.isError)` gate never runs. No new ordering, no new suppression
mechanism, no execution-loop change.

## 2. Session identity source

`todoSession.id`, which is already correct in **both** roots — no new session is
generated in `todo.ts`:

- **CLI**: `cli/setup.ts` sets `todoSession.id = presentationSessionId`
  (= `resumeId ?? sessionId`), the canonical id.
- **MCP**: Phase 4A.3's `applyMcpContext` sets it to the per-instance
  `mcp:<uuid>` namespace.

Test S2 asserts this end to end: a tool write lands under the caller's own
session namespace and under **no** shared literal.

## 3. Canonical payload classification

| payload | behaviour |
|---|---|
| mixed (≥1 `taskId`) | synchronized. id-bearing = EXISTING, id-less = genuinely NEW |
| all-id-less | **not synchronized.** Legacy JSON path untouched |

`hasCanonicalIdentity` mirrors the recovered `hasAnyId` switch
(`store.orig.ts:480`), including its `!== ""` rule: an empty-string `taskId` means
"I have no id" = NEW, not malformed. Positional identity is never used.

## 4. Existing-task handling

An explicit `taskId` resolves **directly through TaskStore**: malformed →
`TASK_INVALID_ID`; repeated in one payload → `TASK_DUPLICATE_ID`; valid but
absent from the session → `TASK_NOT_FOUND`. Never by ordinal, array position,
content or title. The whole payload is validated by `planTaskIdentities` and
existence-checked in a pre-pass **before the first mutation**, preserving the
Phase 3A resolve-before-mutate invariant. An unknown id is never silently
retreated as new.

## 5. New-task handling

Id-less items in a mixed payload become `TaskStore.createTask(...)`. The
canonical id comes from `createTask`/`nextId` only — `sync.ts` contains no
`` t${ `` template and no counter. `content` is mapped to `title` by the caller
(passing `content` through was measured to fail `NOT NULL`).

## 6. Reorder semantics

```
t1=A  t2=B  t3=C   then  C, A, B  ->  t3=C  t1=A  t2=B
```

Test F/G: **0 new rows, 0 new ids**, id→title bindings unchanged, only
`task_order` moves. This is the *correct* counterpart to the `debc295` known-bad
duplication case, which used an id-less payload.

## 7. D7 omission behavior

A task the model omits is **retained** — not deleted, not cancelled, not reset.
Test I pins it.

**One deliberate difference from the artifact.** The recovered D7 renumbered
survivors to `0..n-1`, which can collide with a declared item's own order.
Here retained tasks are placed *after* the declared range
(`plan.entries.length + i`), keeping `(task_order, task_id)` a total,
collision-free key. Documented at the call site.

## 8. Transaction boundary

One `todo_write` = one `store.withTransaction(...)`. Every update, creation,
order change and metadata write is inside it. No raw SQL outside TaskStore, no
caller-side SQLite transaction, no second transaction API (`withTransaction`
remains defined only in `store.ts`). Test L proves a mid-payload failure rolls
back everything: the earlier update, the newly created row, and the later item.

## 9. JSON / TaskStore / plan ordering

`JSON write → TaskStore sync → plan publication`. No distributed transaction is
claimed; `journal.ts` already states none is available.

| failure | result |
|---|---|
| JSON write fails | no TaskStore sync, no plan (test M) |
| TaskStore sync fails | transaction rolls back, tool errors, **no plan**; the JSON file **remains committed** and the two are now out of step (test N) |

That divergence is **explicit and surfaced**, not hidden: the rethrow keeps the
original error `code` machine-checkable and its message states that the JSON was
written and TaskStore rolled back.

## 10. Failure semantics

Explicit failure, no silent fallback, on: invalid id (`TASK_INVALID_ID`),
unknown id (`TASK_NOT_FOUND`), duplicate id (`TASK_DUPLICATE_ID`), mutation
validation (e.g. `BLOCKED` without a reason), transaction failure, and session
namespace problems. There is no positional fallback and no "treat an invalid id
as new" path.

## 11. Plan v2 integration

The Phase 3B seam is used, not replaced. `planFromTodos` now passes the declared
`taskId` to the resolver as a **hint**; `cli/setup.ts` injects
`createTaskIdentityResolver(cwd)`, which reports an id **only when TaskStore
actually holds that row for the session**. If resolution is not total, the hints
are **stripped** and the plan stays positional — so `payloadVersion: 2` is
emitted only on fully verified identity, and a v1 plan never advertises an
unverified id.

## 12. MCP behaviour

Unchanged beyond namespace selection. MCP builds no presentation adapter, so
**plan v2 is CLI-only**; MCP gets durable task state under its 4A.3 namespace.
No task semantics were added to MCP, no global task session, no use of
`"mcp-server"` as a namespace (it survives only as the internal journal key and
in log prefixes), and never the JSON-RPC request id.

## 13. Legacy behaviour

Unchanged and intentional. No automatic adoption, no id allocation, no manifest,
no digest, no operator migration. The `debc295` known-bad test still reproduces
(id-less reorder still duplicates) and remains skipped by default — which is
correct, because changing that is 4A.5's decision, not this one's.

## 14. Tests

`test/phase4a4-production-sync.test.ts` — **17 tests, 76 assertions, 0 fail.**
A mixed payload creates only the new item · B explicit id updated · C unknown id
atomic reject · D duplicate atomic reject · E malformed refused, empty string =
new · F/G reorder preserves identity, no new rows · H only id-less items
created · I D7 retention · J status persists · K `content`→`title` verified via
raw SQL · L mid-payload failure rolls back · M JSON failure ⇒ no sync · N
TaskStore failure ⇒ tool error, divergence recorded · S explicit ids, not
position · **S2** production path uses `todoSession.id` · L1 all-id-less not
adopted · L2 classification.

### Two pre-existing tests I had to touch, and why

1. **`test/phase4a1-protocol-identity.test.ts` F2** wrote `taskId: "t3"` through
   the tool into a *fresh* store, which 4A.4 now correctly rejects as
   `TASK_NOT_FOUND`. Its purpose — proving the protocol round-trips an id through
   the real tool — is still valid, so the id is now **seeded** rather than the
   test being removed or weakened.
2. `test/phase3c-identity-duplication.known-bad.test.ts` was **not** touched and
   still passes when unskipped.

## 15. Mutation results

**10/10 killed, 0 survived, 0 equivalent, 0 needle-misses.** Pristine bytes
restored and SHA-verified per mutant.

| # | mutant | result |
|---|---|---|
| S1 | transaction bypassed | **KILLED** |
| S2 | TaskStore bypassed, existing re-created as new | **KILLED** |
| S3 | explicit id ignored / existence pre-pass removed | **KILLED** |
| S4 | omitted tasks deleted (D7 violated) | **KILLED** |
| S5 | legacy all-id-less auto-adopted | **KILLED** |
| S6 | sync failure swallowed | **KILLED** |
| S7 | `content` not mapped to `title` | **KILLED** |
| S8 | session replaced with the shared literal | **KILLED** |
| S9 | order made positional | **KILLED** |
| S10 | sync skipped entirely | **KILLED** |

**Three first-run survivors, all mine, none forced:**
- **S3** looked equivalent to me (the transaction already rolls back), but it
  is not: removing the pre-pass moves rejection from before-the-first-mutation to
  mutation time. It is killed once test C is present.
- **S6** my replacement added `void e` but left the rethrow — a harness bug.
- **S8** exposed a **real gap**: most tests call `synchronizeCanonicalTasks`
  directly, so nothing asserted the *production* session key. Test S2 was added.

## 16. Validation

| check | result |
|---|---|
| PARSE | **VERIFIED** — `Bun.Transpiler` on all 4 changed/new sources |
| RUNTIME (new) | **VERIFIED** — 17/17, 76 assertions |
| RUNTIME (regression) | **VERIFIED** — **208 pass / 0 fail / 1 skip** across 14 files |
| MUTATION | **VERIFIED** — 10/10 killed |
| TYPECHECK | **DEFERRED** — `node_modules` absent |
| FULL SUITE | **DEFERRED** — 200+ files not run |

**A flake I saw and did not dismiss:** one sweep run reported
`phase1-tools` 34/1. It did not recur in 4 isolated runs *with* my change nor in
4 runs of the stashed baseline, so it is not attributable to this change on
available evidence — but it was observed once and I am not claiming it is
definitively unrelated.

**An error I made and recovered:** while probing mutant S7 I ran
`git checkout -- src/tools/todo.ts`, which restores to the **index**. My 4A.4
changes were unstaged, so that **discarded my own work**. I detected it
immediately, re-applied both edits, and re-verified (208 pass). Worth stating
plainly: an uncommitted phase should be committed or stashed before any
destructive git command.

## 17. Safety audit

| check | result |
|---|---|
| `` t${ `` in sync/todo/adapter/setup | **0** |
| `randomUUID` in the new sync path | **0** |
| raw SQL (`db.exec`/`db.prepare`) in changed code | **0** |
| manual `BEGIN`/`COMMIT`/`ROLLBACK` | **0** |
| second transaction API | **0** — `withTransaction` defined only in `store.ts`, called once from `sync.ts` |
| id formatting | **exactly one** place: `model.ts:81` `taskIdFromIndex` |
| `"mcp-server"` as a durable namespace | **0** (journal key + log text only) |
| global mutable MCP task session | **0** |

## 18. Files changed

| file | change |
|---|---|
| `src/task/sync.ts` | **new** — classification, transactional canonical sync, plan identity resolver |
| `src/tools/todo.ts` | modified — the production seam after `saveTodos` |
| `src/presentation/adapter.ts` | modified — declared id passed as a hint, stripped if unverified |
| `cli/setup.ts` | modified — injects the TaskStore-backed resolver |
| `test/phase4a4-production-sync.test.ts` | **new** |
| `test/phase4a1-protocol-identity.test.ts` | modified — F2 seeds its id (see §14) |

`src/task/store.ts` and `src/task/model.ts` are **unchanged**.

## 19. Commit

`feat: connect canonical tasks to production`. SHA not self-cited — committing
this report changes it. Verify with `git log -1 --pretty=format:'%h %s'`.
Working tree **CLEAN** after commit. Not pushed. Specimen untouched.

## 20. Explicit non-scope

Not implemented: all-id-less post-canonical **rejection** (4A.5), automatic
bootstrap/adoption, operator migration, deletion redesign, MCP lifecycle
redesign, TaskGraph, Scheduler, restart/reorder/crash E2E, new plan semantics,
execution-loop redesign.

**Still open:** plan `v2` is emitted only when every declared step resolves to
an existing TaskStore row. A payload that **creates** a new task has an
unresolved step, so that plan stays positional (`v1`). Resolving new-task ids
back into a plan would need an assignment channel between the sync and the
adapter; a process-global registry was rejected as race-prone, so this is left
for a later phase and is **not** claimed here.

The identity contract is no longer blocked on protocol, transaction or
namespace. The `debc295` duplication defect is still live by design.
