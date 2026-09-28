# PHASE 4A.5 — ALL-ID-LESS CANONICAL PAYLOAD REJECTION REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `e5eee0a` · Commit message: `fix: reject idless canonical task payloads`

**NEW ARCHITECTURE.** Not a recovery.

---

## 1. Canonical-state predicate

```ts
hasCanonicalTasks(cwd, sessionId) =
  new TaskStore(cwd).listTasks(sessionId).length > 0
```

Derived from the source, not assumed:

- **Authority is TaskStore.** The legacy JSON is deliberately *not* consulted. A
  JSON file exists for every session that has ever written a todo, canonical or
  not, so its presence proves nothing (test **P** writes legacy JSON only and the
  predicate still answers `false`). Conversely a canonical session's JSON can be
  rewritten, so it is a poor predictor in the other direction too. The thing being
  protected is duplicate *durable tasks*, so the store that holds them must answer.
- **Status is deliberately ignored.** Every row counts, whatever its status. A
  session whose tasks are all `COMPLETED`, `CANCELLED` or `BLOCKED` still has
  canonical identity: ids are allocated and orders are meaningful. Filtering by
  status would silently reopen the duplication bug the moment a todo list
  finished. Test **P** pins `COMPLETED`/`CANCELLED`/`BLOCKED` as canonical.
- **TaskStore with zero rows → legacy**, whether or not the db file exists.
- **`task_meta` is not consulted.** I verified the migration substrate from Phase
  0C/1 (`setMeta`, `migrationStamp`) has **no production caller** — it is dormant,
  and bootstrap/migration are explicitly out of scope.
  *Forward hazard, stated plainly:* this guard is row-based, so a future bootstrap
  must **create tasks**, not merely write a `migrated:<session>` stamp. A
  stamp-only bootstrap would be invisible here and would reopen the duplication.
- If the store cannot be opened, the predicate fails open to LEGACY and the legacy
  path behaves exactly as it always has; a `TaskError` (e.g. an in-transaction
  guard) is rethrown rather than swallowed.

## 2. Rejection boundary

In `todo_write.execute`, **before `await saveTodos(...)`**:

```
if (list.length > 0 && !hasCanonicalIdentity(list) && hasCanonicalTasks(cwd, sessionId))
  throw new TaskError("TASK_IDENTITY_REQUIRED", …)
```

Placing it before the JSON write makes a rejected write a **complete no-op**: no
JSON replacement, no TaskStore mutation, no id allocation, no plan. Rejecting
after the JSON write would leave the legacy file describing a state TaskStore
never accepted.

## 3. Pre-mutation proof

Test **J/K** seeds `t1,t2,t3`, writes valid canonical JSON, snapshots the file,
then attempts the all-id-less reorder and asserts: rows still exactly
`t1,t2,t3`; the JSON file byte-identical to before; `nextId` still `t4`, so
**nothing was consumed**. Test **C** additionally pins `revision === 1` on every
row — no write of any kind occurred. No `t4`, `t5` or `t6` can appear.

## 4. Legacy behavior

Unchanged. Test **A**: with no canonical identity, an all-id-less payload writes
legacy JSON, emits no assignment, and creates **zero** tasks. No adoption, no
manifest, no digest, no migration metadata, no historical identity touched.

## 5. Mixed behavior

Test **E**: `[t3=C, id-less D]` is **not** rejected. `t3` is updated in place, `D`
is created as `t4`, and the 4A.4A assignment path delivers
`[t3(existing), t4(new)]` in the same operation. Canonical order after D7 is
`t3, t4, t1, t2` — the two declared items lead, retained ones follow.

## 6. Retry behavior

Test **D** repeats the same rejected payload three times. Each throws, and the
row snapshot (`id:title:revision`) is byte-identical afterwards: **3 rows, no
duplicates, no id consumption**. A retry can never be reinterpreted as
"all new", because the predicate is re-evaluated and still true — that is exactly
mutation **R2**, which is killed.

## 7. Empty payload

**Documented from the existing code, not invented.** `todos: []` was *already* an
error before this phase: `normalizeTodos` throws `"todos is empty — provide at
least one item with content"` (a plain `Error`, no `TaskError` code), and it runs
**before** the canonical guard, so an empty declaration never reaches 4A.5. It is
therefore not equivalent to an all-id-less payload, and it deletes nothing —
canonical tasks are untouched (test **I**).

The guard cannot be laundered through it: canonical rows survive, so the *next*
all-id-less write is still rejected.

## 8. JSON ordering

The 4A.4 ordering (JSON durable write → canonical sync → plan) is **unchanged**;
the guard sits in front of all of it. For a rejected payload nothing is written
at all, so there is no JSON/TaskStore divergence and no need for any distributed
rollback. Documented rather than invented: for the accepted paths the two stores
are still not one transaction, exactly as 4A.4 recorded.

## 9. Plan behavior

Test **L**: a rejected write produces no `plan.updated` at all, because the throw
makes the tool result an error and the adapter already gates publication on
`!result.isError`. The 3B rule is untouched: `payloadVersion: 2` still only on
complete identity resolution.

## 10. MCP

Test **M**: context A has canonical tasks → all-id-less **rejected**, A still
holds exactly 3 rows. Context B has none → **legacy**, accepted, and it created
no canonical state and no file in A's namespace. No cross-session leakage. MCP
namespace logic was not touched.

## 11. CLI / resume

Test **N**: after re-binding the same durable namespace (what a process restart
does), the identical payload is **still rejected**, rows unchanged, `nextId`
still `t4`. Canonical identity is durable, so the rule survives a resume and
mints nothing.

## 12. Error surface

New code `TASK_IDENTITY_REQUIRED`, added to the `TaskErrorCode` union.

Not `TASK_INVALID_ID`: no id was malformed — the payload simply lacks the
information needed. Overloading it would have hidden the actual problem. The
message is model-visible and actionable, naming the remedy and the tool that
provides it:

> this task already has 3 canonical task(s), so this full declaration must identify
> them. Call todo_read and re-send every item with its taskId (e.g.
> {"taskId":"t1", …}); omit taskId only on items that are genuinely new. Nothing
> was written: the todo list and canonical tasks are unchanged.

Thrown as a real `Error` subclass, so existing `(e as Error).message` sites work.

## 13. Regression evidence

`debc295` was **not deleted and not rewritten**. It still passes its 19 assertions
and still reproduces the duplication.

It passes because it drives `synchronizeIdentities` — the Phase 3A applier —
directly, and 4A.5 deliberately did not change that layer. An id-less item at that
layer genuinely *is* new work; the applier mints identity and has no business
deciding whether its caller was allowed to send ambiguous input. What changed is
that `todo_write` can no longer *feed* it ambiguity.

I added a header to that file marking it **historical evidence** and pointing at
the new live guard, so nobody later mistakes it for a stale passing test.

The new permanent guard against the real duplication is
`test/phase4a5-idless-rejection.test.ts` cases **C** and **D**: canonical A/B/C
followed by all-id-less C/A/B is rejected and the store still holds exactly three
rows.

## 14. Tests

`test/phase4a5-idless-rejection.test.ts` — **15 tests, 60 assertions.**
A legacy preserved · B reject · C reorder/zero duplicates · D retry ·
E mixed still works · F unknown id · G duplicate id · H malformed id ·
I empty payload · J/K pre-mutation, no allocation, no JSON write · L no plan ·
M MCP isolation · N resume · O actionable code · P predicate semantics.

### One prior test needed a fixture correction

4A.4A's test **L** ("all-id-less stays legacy") seeded canonical tasks and then
wrote an all-id-less payload into that same session — precisely the case 4A.5 now
rejects. Its *intent* (the legacy path is unchanged) is preserved by using a
session with **no** canonical identity, which is what LEGACY means; the
complementary case is proven in the 4A.5 suite. While fixing it I also corrected a
latent no-op assertion in that test: it read `.minicore/todos-<id>.json` (wrong
path, wrong shape) behind a `.catch(() => "")`, so it could never fail. It now
asserts against the real `.minicode/todos/<id>.json` and checks the stored
`sessionId` and item list.

## 15. Mutation — 9 killed, 1 equivalent, 0 needle miss

| # | mutant | result |
|---|---|---|
| R1 | remove the canonical-state check | KILLED |
| R2 | treat all-id-less as NEW after canonical tasks exist | KILLED |
| R3 | move the rejection after the canonical sync | KILLED |
| R4 | allow a single id-less item (off-by-one) | KILLED |
| R5 | bypass the guard on a reorder (order loophole) | KILLED |
| R6 | allocate a new id instead of rejecting | KILLED |
| R7 | suppress the error and continue as legacy | KILLED |
| R8 | "publish a plan after a rejected write" | **EQUIVALENT — my construction** |
| R9 | use legacy JSON presence instead of TaskStore | KILLED |
| R10 | share the predicate across sessions | KILLED |

**R8 is equivalent because I built it wrong, and I am reporting that rather than
re-rolling it.** I inserted a duplicate check that throws and catches its own
error *before* the real guard, so the real guard still throws and behaviour is
unchanged. The behaviour R8 was meant to probe — a plan appearing after a
rejected write — is only reachable if the tool does not error, which is exactly
mutation **R7**, and R7 is killed. So the property is covered; my mutant was a
no-op.

The harness carried the 4A.4A/4A.4B hardening: SHA gate, both output streams,
`(fail)`-or-summary counting, byte-exact restore verified after every mutant, and
CRLF-tolerant needles.

## 16. Validation

| check | result |
|---|---|
| PARSE | **VERIFIED** — 3 changed sources |
| RUNTIME (4A.5) | **VERIFIED** — 15/15, 60 assertions |
| RUNTIME (focused, 9 phase files) | **VERIFIED** — 114 pass / 0 fail / 1011 assertions |
| RUNTIME (MCP + todo/plan) | **VERIFIED** — 39 pass / 0 fail |
| REGRESSION (debc295) | **VERIFIED** — still reproduces, 19 assertions |
| MUTATION | **VERIFIED** — 9 killed, 1 equivalent |
| BROAD (20 files) | **VERIFIED** — 476 pass / 2 fail, matching baseline |
| TYPECHECK | **DEFERRED** — `node_modules` absent |
| FULL SUITE | **DEFERRED** |

**Baseline flake, investigated rather than assumed.** The baseline worktree run
showed a *third* failure — `cli: --timeout …` at 5002 ms, i.e. it hit its 5 s
limit under sweep load — which did **not** appear in my run. Isolated re-runs:
3/3 pass on the baseline and 3/3 on mine. It is a pre-existing timing-sensitive
flake, not attributable to this change. Both trees share the same 2 purity-audit
failures.

## 17. Safety audit

No new violations. Verified individually: no second allocator (my `model.ts` diff
is only the error code; the sole `t${…}` remains `model.ts:81 taskIdFromIndex`),
no positional identity, no content-based identity, no automatic bootstrap, no
manifest, no digest, no raw SQL outside TaskStore, no new global mutable session,
no MCP shared namespace, no `TaskGraph`, no `Scheduler`. The two `bootstrap`/
`manifest` grep hits in `sync.ts` are comments — one pre-existing, one of mine
documenting the forward hazard in §1.

## 18. Files changed

| file | change |
|---|---|
| `src/task/model.ts` | `TASK_IDENTITY_REQUIRED` added to the code union |
| `src/task/sync.ts` | `hasCanonicalTasks` predicate |
| `src/tools/todo.ts` | the guard, before `saveTodos` |
| `test/phase4a5-idless-rejection.test.ts` | **new** — 15 tests |
| `test/phase4a4a-canonical-assignment.test.ts` | fixture correction + dead assertion (§14) |
| `test/phase3c-identity-duplication.known-bad.test.ts` | historical-evidence header only |

`src/task/store.ts`, `src/task/identity.ts`, `src/presentation/adapter.ts` and
`src/task/assignment.ts` are **unchanged** — the identity applier, the
transaction boundary, the plan pipeline and the assignment channel are all
untouched, as the scope required.

## 19. Commit

`fix: reject idless canonical task payloads`. SHA not self-cited — committing this
report changes it. Verify with `git log -1 --pretty=format:'%h %s'`. Tree CLEAN
after commit. **Not pushed.** Specimen at `D:\git\minicode` untouched; every test
run used an explicit redirected `cwd`.

## 20. Explicit non-scope

Not implemented, per the stop condition: operator bootstrap, legacy migration,
digest/manifest, deletion semantics, TaskGraph, Scheduler, MCP namespace
redesign, TaskStore transaction redesign, task-identity protocol changes,
assignment propagation changes, plan pipeline redesign, restart/reorder/crash E2E.

**Open by design:** the row-based predicate cannot see a stamp-only migration
(§1); `src/tools/task.ts:226` still reads the same `todoSession` singleton before
its first `await`; TYPECHECK and FULL SUITE remain deferred.
