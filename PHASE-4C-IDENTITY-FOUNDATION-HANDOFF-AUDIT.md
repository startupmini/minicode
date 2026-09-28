# PHASE 4C — IDENTITY FOUNDATION FINAL AUDIT + HANDOFF GATE

Workspace: `D:\recover\minicode-20260928\reconstruction`
Audited HEAD: `3c82d2c` · Working tree: **CLEAN — no code changes, no commit**

**AUDIT PHASE.** This document is the only artefact produced.

---

## VERDICT

# IDENTITY FOUNDATION HANDOFF READY

All 14 invariants are VERIFIED or VERIFIED-WITH-DOCUMENTED-LIMITATION. No invariant
FAILED. No authority violation. One **test-hygiene weakness** was found (§11) and is
recorded as required follow-up `4C.1`; it does not weaken any proof and does not
block handoff.

---

## 1. Final architecture map

```
model
  ↓  todos[].taskId? (optional; 4A.1)          PROTOCOL BOUNDARY — validates, allocates nothing
todo_write.execute
  ↓  normalizeTodos                              content→title, blocked policy, NO id synthesis
  ↓  todoOperationContext(ctx)                   SESSION BOUNDARY — one capture, before any await
  ↓  all-id-less guard (4A.5)                    REJECTION BOUNDARY — before any write
  ↓  saveTodos                                   PERSISTENCE (legacy JSON) — durable write first
  ↓  synchronizeCanonicalTasks
  │    planTaskIdentities                        PURE PLANNER — validation only
  │    store.withTransaction(…)                  TRANSACTION OWNER — TaskStore
  │      pre-pass: every declared id exists      RESOLVE-BEFORE-MUTATE
  │      loop: patchTask | createTask            IDENTITY SOURCE = TaskStore allocator
  │      D7: retain omitted                      OMISSION ≠ DELETION
  │    → assignment (index-aligned, declared order)
  ↓  merge resolved ids + re-persist (4B.1)      IDENTITY ROUND-TRIP to the read path
  ↓  savePlanSnapshot
plan
  ↓  adapter planFromTodos(args, session, decoded assignment)
  ↓  createTaskIdentityResolver(cwd)             TASKSTORE-BACKED verification
  ↓  total resolution only → payloadVersion: 2
plan.updated                                     PRESENTATION OWNER — observation only
todo_read → renders `${taskId} — ${content}`
```

| boundary | authority |
|---|---|
| protocol | model-supplied `taskId`, validated; never allocated |
| session | `todoOperationContext` — ctx first, composition-root `todoSession` as default |
| persistence | legacy JSON (durable, non-canonical) |
| **canonical state** | **`TaskStore` — the single authority** |
| transaction | `TaskStore.withTransaction` (`fn(this)`, so `tx === store`) |
| assignment carrier | the tool's own return value, kernel-correlated per call |
| presentation | `adapter` — observation, never authority |

## 2. Invariant matrix

| # | invariant | class | evidence |
|---|---|---|---|
| I1 | one durable identity authority | **VERIFIED** | no file outside `src/task/store.ts` touches the canonical `tasks` table (static scan) |
| I2 | one allocator | **VERIFIED** | sole `t${…}` formatter is `model.ts:81 taskIdFromIndex`; `nextId` only in `store.ts`; `todo.ts`/`sync.ts`/`assignment.ts` contain **zero** `randomUUID` |
| I3 | taskId survives reorder | **VERIFIED** | 4B lifecycle 1; 4A.4 F/G; 4A.4A D |
| I4 | taskId survives restart | **VERIFIED** | 4B lifecycle 7 (real handle close + re-open) |
| I5 | existing task cannot silently become new | **VERIFIED** | 4A.4 B/H, S; 4A.5 F; 4B 16 |
| I6 | ambiguity never silently guesses | **VERIFIED** | 4A.4 E; 4A.5 B; dedicated `TASK_IDENTITY_REQUIRED` |
| I7 | logical task cannot create duplicate rows | **VERIFIED** | 4A.5 C/D; 4B 1, 16; `debc295` retained as history |
| I8 | session isolation | **VERIFIED** | 4A.4B A/B/C/D/G; 4B 13/13b/15/15b |
| I9 | legacy stepId is non-canonical | **VERIFIED** | 4A.1 E2; 3B 6 ("legacy stepId is never mirrored from taskId") |
| I10 | presentation is observational | **VERIFIED** | adapter publishes only on `!result.isError`; 4A.4 N; 4A.5 L |
| I11 | plan v2 has only resolved identities | **VERIFIED** | 4A.4A F/G (7 tamperings); 4A.4A O |
| I12 | required TaskStore writes are atomic | **VERIFIED** | 4A.2 (14 tests); **4B.2** proves the *production call site*, P9 now KILLED |
| I13 | model can read back a referenced taskId | **VERIFIED** | 4B.1 1/2/3 — the 4B defect that made this false is fixed |
| I14 | post-canonical all-id-less cannot become new | **VERIFIED** | 4A.5 B/C/D/I/M/N |

I14's predicate is `hasCanonicalTasks` — **TaskStore rows only, status-agnostic**,
never JSON presence (4A.5 P). This was a deliberate choice: a session whose tasks
are all `COMPLETED`/`CANCELLED`/`BLOCKED` still has canonical identity.

**Not upgraded on a related test's coattails.** I12 and I14 each required their own
dedicated proof; I12 needed the whole 4B.2 phase because 4A.2's store-level tests
did *not* cover the production call site.

## 3. Failure matrix

| failure | JSON | TaskStore | assignment | plan | code |
|---|---|---|---|---|---|
| JSON write fails | not written | **never touched** | — | suppressed | (4A.4 M) |
| TaskStore/validation fails | **already written** | **rolled back** | none | **suppressed** | divergence wrapper (4A.4 N, 4B.2 I) |
| mid-transaction mutation fails | — | **rolled back** (whole payload) | none | suppressed | `TASK_INVALID_TRANSITION` (4B.2 B) |
| malformed `taskId` | untouched | untouched | — | suppressed | protocol error (§9) |
| unknown `taskId` | already written | rolled back | none | suppressed | `TASK_NOT_FOUND` |
| duplicate `taskId` | already written | rolled back | none | suppressed | `TASK_DUPLICATE_ID` |
| all-id-less (canonical exists) | **not written** | untouched | none | none | `TASK_IDENTITY_REQUIRED` |
| mixed payload | written + ids merged | committed | published | v2 | — (4A.5 E) |
| retry after failure | — | idempotent | re-derived | v2 | (4B 6) |
| process restart | preserved | preserved | re-derived | v2 | (4B 7) |
| MCP restart | new namespace | new namespace | — | — | see §6 |

### ⚠ DOCUMENTED BEST-EFFORT DIVERGENCE

When the canonical sync fails, **the legacy JSON has already been written**. The
two stores are then out of step, and there is no cross-system rollback. The error
message states this explicitly (`"the todo JSON file was already written, TaskStore
rolled back - the two are now out of step"`). This is inherited from the proven 4A.4
durable-write-first ordering, which is what makes a JSON failure suppress plan
publication. Recorded, not invented away.

## 4. New-task continuity — ✅ complete path verified

`id-less in mixed → allocate → assignment → write-back → todo_read → next turn
addresses it` is verified end to end (4B 10, 4B.1 1/2/3, 4B lifecycle 1 turn 2).

The **pre-4B.1 state was a live duplicate-producing defect**, and this chain is the
reason it was caught: turn 1 created `t3=C` with no readable id, so turn 2 re-sent it
id-less and 4A.5 created `t4=C`. Fixed by the 4B.1 write-back.

**Residual, documented not fixed:** if a model ignores an id it was *shown* and
re-sends it id-less inside a **mixed** payload, 4A.5 still treats it as new
(4B.1 test 7 pins this deliberately). Detecting it would require content-based
identity, which is forbidden.

## 5. Reorder continuity

- **A. canonical** `t3,t1,t2` → same ids, changed order, same row count
  (4B lifecycle 1, 4A.4A D).
- **B. id-less after canonical** `C,A,B` → **rejected**, zero mutation (4A.5 C).
- `debc295` **retained byte-unchanged**, still reproduces (19 assertions). It
  documents the historical identity-layer behaviour; 4A.5 is the live guard.

## 6. Session audit

- **CLI:** `presentationSessionId = resumeId ?? sessionId` (`cli/setup.ts:505`),
  bound at `setup.ts:923` and injected at `1001`/`1403` — **unchanged**. Consequence
  verified: the same logical namespace re-addresses the same ids (4B lifecycle 8);
  a different namespace sees nothing.
- **MCP:** per-instance `mcp:<uuid>`; one context stable across requests, two
  contexts differ (4B 14, 14b), and the JSON-RPC request id is **not** durable
  identity.
- **MCP process restart creates a NEW context** — measured, not assumed (4B 14c):
  two namespace files, nothing migrated or adopted. There is **no durable context
  persistence**, so canonical identity does not cross an MCP restart. Per §6 this
  is **not** a defect unless the product contract requires cross-process MCP
  continuity, and no such contract exists. Recording it as a known lifecycle
  limitation.

## 7. Legacy boundary

| state | payload | outcome |
|---|---|---|
| no canonical rows | all-id-less | **LEGACY** — accepted, nothing created (4A.5 A) |
| canonical rows exist | all-id-less | **REJECT** (4A.5 B) |

**Legacy identity continuity is NOT recoverable from the existing id-less JSON
shape.** The file contains no ids, and reconstructing them would require matching
on content/title — explicitly forbidden. Legacy sessions can therefore never be
upgraded automatically; only an explicit operator bootstrap can do that, and
bootstrap is out of scope. 4A.5 and 4B 12 both assert no automatic adoption.

## 8. Deletion behaviour

**D7 RETAIN.** Omission is not deletion: an unmentioned task is kept, never
deleted, cancelled or reset (4A.4 I; retained ordering verified in 4B lifecycle 1).
Explicit deletion semantics remain a **future decision** — `deleteTask` exists on
the store but nothing in the todo path calls it. Confirmed: no hidden deletion path
was introduced in 4A.1–4B.2.

## 9. Malformed-id error surface — acceptable, better than assumed

The brief anticipated "normalize throws → read path may expose empty state".
**Measured, and that is only true for a session that has never had a list:**

```
read BEFORE malformed : "todos 0/2\n  [ ] t1 — A\n  [ ] t2 — B"
malformed write threw : todo item has a non-canonical taskId: not-an-id
read AFTER malformed  : "todos 0/2\n  [ ] t1 — A\n  [ ] t2 — B"   <- INTACT
TaskStore rows        : ["t1","t2"]
fresh session         : "(no todos yet …)"                        <- correct empty
```

`normalizeTodos` throws **before any write**, so an existing session's read path is
untouched. The error is actionable. **Not technical debt**; no redesign warranted.

## 10. Authority static audit — no violations

| probe | result |
|---|---|
| `t${` | 2 files — `model.ts:81` (the canonical allocator) and a **false positive** (`compaction.ts:302`, the substring in `"assistant${…}"`) |
| `nextId(` | `model.ts` + `store.ts` only |
| `Math.random` | `session/shadow-git.ts` only — unrelated subsystem |
| `randomUUID` | 15 files, **none** in `todo.ts` / `sync.ts` / `assignment.ts`; `task.ts:227` is a sub-agent session id, `mcp/server.ts:238` the `mcp:` namespace — neither is a task id |
| ordinal → taskId | **none** |
| content → taskId | **none** |
| global assignment map | **none** |
| global session var | 5 hits, all unrelated (telemetry, i18n, sub-agent factory, tool registry) |
| `"mcp-server"` | `mcp/server.ts` only — journal key + fail-closed guard, never a task namespace |
| raw SQL outside TaskStore | 7 files, **none touches the canonical `tasks` table** (sessions / memory_fts / presentation_events / policy DB) |
| `TaskGraph` / `Scheduler` | 1 hit each — a **comment** in `identity.ts:22` listing out-of-scope items. No such code exists. |

## 11. Test-quality audit

**Proofs run through real production seams** — not helper calls:

| seam | proof |
|---|---|
| production TaskStore sync | 4A.4 S/S2, 4A.5 (tool-level), 4B (tool-level) |
| **production transaction boundary** | 4B.2 B–H, via `synchronizeCanonicalTasks` |
| production session propagation | 4A.4B C, 4A.4B K (**real MCP server over stdio**) |
| production assignment propagation | 4A.4A (tool result), 4B 9/10 (through the adapter) |
| production plan generation | 4A.4A E/F, 4B 9/10 (real adapter + provider) |

**Vacuous-assertion scan:** `void <var>` (2), empty `catch` (12), discarded results.
- The 12 empty catches are `afterEach` cleanup and the MCP stdio line parser
  (`try { JSON.parse(line) } catch {}`) — legitimate, not swallowed assertions.
- ✅ Concrete weakness found, **mine, from 4B**:
  `test/phase4b-identity-lifecycle.test.ts:401` computes `const events = planFor(…)`
  and line 418 discards it with `void events`. It is vestigial: the real plan
  assertion in that test uses a separate explicit bus (lines 403–417) and is
  genuine. **The proof holds, but dead code sits next to it and could mislead a
  reader into thinking the discarded value is the assertion.**
- `phase4a4b:248 void savedA` — an unused restore value, not a dead assertion.

Per §11 I am **not** fixing this inline. It becomes follow-up **`4C.1` — remove the
discarded `planFor` result from 4B lifecycle test 11** (test hygiene only; no
product change). It does not block handoff.

## 12. Regression baseline

| run | result |
|---|---|
| all identity-foundation suites (11 files) | **129 pass / 0 fail**, 1113 assertions |
| `debc295` historical evidence | unchanged vs HEAD, still reproduces (19) |
| broad sweep @ `3c82d2c` | 476 pass / 2 fail |
| broad sweep, clean `3c82d2c` worktree | **476 pass / 2 fail — identical** |
| 2 purity audits (`model.ts/reducer.ts`, `projection.ts`) | **BASELINE-FLAKE** — identical on the clean baseline, not attributable |

**New failures: none. Unexplained regressions: none.** No failure was labelled
pre-existing without a baseline comparison — every claim above rests on a clean
worktree run.

## 13. Deferred validation

| check | label | blocks handoff? |
|---|---|---|
| TYPECHECK | **DEFERRED** — `node_modules` absent, install unauthorised | no |
| FULL SUITE (200+ files) | **DEFERRED** | no |
| MCP cross-process continuity | **DEFERRED** — no durable mechanism exists | no |
| operator bootstrap / legacy adoption | **DEFERRED** — out of scope, deliberately | no |

Specimen: untouched. `project-id` mtime `02:02:37`; no `todos/` or `tasks.db` in
the specimen; all runs used an explicit redirected `cwd`. (The `vector.db-shm`/
`-wal` sidecars remain from the 4A.4A diagnostic disclosed in the 4B report — not
removed, as instructed.)

## 14. Handoff decision

# IDENTITY FOUNDATION HANDOFF READY

| gate | result |
|---|---|
| no identity invariant FAILED | ✅ none |
| no authority violation | ✅ §10 |
| create / read / reorder / update / retry / restart verified | ✅ §1, §4, §5 |
| session isolation verified | ✅ §6 |
| production transaction boundary verified | ✅ 4B.2, P9 killed |
| new-task assignment propagation verified | ✅ §4, 4B.1 |
| all-id-less canonical rejection verified | ✅ §7, 4A.5 |
| no unexplained new regression | ✅ §12 |

## 15. Handoff map for the next layer

### Stable APIs
- `TaskStore` — `listTasks` / `getTask` / `createTask` / `patchTask` /
  `withTransaction` / `hasCanonicalTasks` (in `src/task/sync.ts`)
- `todos[].taskId?` protocol field; `taskIdFromIndex` (the only id formatter)
- `todoOperationContext(ctx)` — the session seam
- `encode/decodeCanonicalAssignments` — the assignment channel
- `TaskIdentityProvider` — the plan identity seam

### Stable invariants
I1–I14 above, all VERIFIED. Treat them as the contract.

### Intentional product decisions
- **omission is not deletion** (D7 retain)
- **an all-id-less payload is rejected** once canonical identity exists
- **legacy sessions stay legacy** — no automatic adoption, ever
- **MCP context is instance-scoped** unless future durable persistence is added
- **presentation is observational** — it may never become an authority
- a mixed payload's id-less items are NEW work, by definition

### Forbidden assumptions for the next layer
- ❌ Never derive a `taskId` from position, ordinal, content or title
- ❌ Never treat the legacy JSON as canonical state (only `TaskStore` is)
- ❌ Never add a second id allocator or a second transaction API
- ❌ Never read mutable global session state after an `await`
- ❌ Never assume an id-less full declaration means "re-declare existing work"
- ❌ Never assume a plan `stepId` is a `taskId` (legacy stepIds are non-canonical)
- ❌ Do not carry 4B.1's documented residual forward as "fixed"

### Next-layer prerequisites
1. Fix `4C.1` (dead assertion in 4B lifecycle test 11) before that file is read as
   evidence.
2. TaskGraph/Scheduler must treat `taskId` as the only identity and may not
   introduce a second authority.
3. Bootstrap (operator adoption of legacy sessions) is **unrecoverable from the
   current id-less JSON** — it is a separate product decision, not an implementation
   detail.
4. Deletion semantics are still an open decision; anything built now inherits D7
   retain.
5. If MCP cross-process continuity is ever required, it needs durable context
   persistence — a new decision, not a bug fix.
