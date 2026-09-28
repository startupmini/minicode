# PHASE 3A — CANONICAL TASK IDENTITY RECOVERY REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `548529c` (Phase 2)
New file: `src/task/identity.ts`
Commit message: `recovery: restore canonical task identity`

---

## 1. Source availability — this is a RECONSTRUCTION

| source | status |
|---|---|
| `src/task/identity.ts` | **NO surviving artifact** |
| `src/task/normalize.ts` | **NO surviving artifact** |
| `todo.orig.ts` (Phase 2 artifact) | present, but contains **0** occurrences of `taskId`, `ordinal`, `address`, `resolveTask`, `explicit`, `duplicate`, `TaskStore`, `synchronizeTasks`; its `TodoItem` is `{content, status, blockedReason?}` with no id field |

**Nothing in this phase may be described as "recovered".** The rules were
reconstructed from two real sources: the current Phase 1 TaskStore, and the
`store.orig.ts` guard clauses deferred in Phase 1 (which are genuine recovered
evidence for the *rules*, even though the Phase 3 wiring is gone).

## 2. Reconstructed-vs-verified matrix

| element | label | evidence |
|---|---|---|
| TaskStore is the sole id allocator | **VERIFIED FROM CURRENT SOURCE** | `nextId` uses `max` not `count`; `createTask` inserts `revision = 1`; PK `(session_id, task_id)` |
| `isTaskId` accepts `^t[1-9][0-9]*$` | **VERIFIED FROM CURRENT SOURCE** | `model.ts`, with Phase 1 tests |
| `taskIdFromIndex(n) = "t"+(n+1)` | **VERIFIED FROM CURRENT SOURCE** | `model.ts`; reconciles with `nextId` max=0 ⇒ `t1` |
| duplicate id ⇒ `TASK_DUPLICATE_ID` | **RECONSTRUCTED FROM HISTORY** | `store.orig.ts:479-488` (`claimedInPayload` Set) |
| explicit id must exist ⇒ `TASK_NOT_FOUND`, no silent fallback | **RECONSTRUCTED FROM HISTORY** | `store.orig.ts:494-496` |
| item without id ⇒ NEW task | **RECONSTRUCTED FROM HISTORY** | `store.orig.ts:450` comment |
| `blockedReason` kept only for `BLOCKED` | **RECONSTRUCTED FROM HISTORY** | `store.orig.ts:502` |
| `order` = declared index, display only | **RECONSTRUCTED FROM HISTORY** | `store.orig.ts:522,532` (`order: index`) |
| provenance `{origin:"model", source:"todo_write"}` | **RECONSTRUCTED FROM HISTORY** | `store.orig.ts:543` |
| `todoStatusToTask` 1:1 mapping body | **INFERRED** | the CALL is in `store.orig.ts:501`; the mapping body is in no source. It is the only mapping consistent with the surviving `TaskStatus` union |
| `DeclaredTask` input contract | **INFERRED** | identity layer's own input, so `TodoItem` need not change (3B) |
| anything requiring `TodoItem.taskId` | **UNKNOWN → DEFERRED** | no evidence exists |

## 3. Canonical identity model

- **taskId** is the durable identity, `t<n>`, 1-based, monotonic per session.
- **order** is display position only and is freely mutable.
- **title** is not identity; a title change never changes an id.
- **ordinal/position** is not identity.
- **presentation/history** is not an identity authority.

All four are enforced by construction: identity lives only in the store row, and
`identity.ts` contains no `t${` string at all — it cannot mint an id.

## 4. Allocation semantics

**One allocator: `TaskStore`.** The identity layer delegates every new id to
`store.createTask` and never formats one itself. There is a second campaign
below that mutation-tests the allocator where it actually lives.

## 5. Validation semantics

| input | result | code |
|---|---|---|
| `t1`..`t999` | accepted | — |
| `t0`, `t01`, `T1`, `""`, `abc`, non-string | rejected | `TASK_INVALID_ID` |
| same id twice in one payload | rejected before any write | `TASK_DUPLICATE_ID` |
| valid id, no such task in session | rejected before any write | `TASK_NOT_FOUND` |
| no id | new task | — |

## 6. Normalization boundary

`planTaskIdentities` is **pure** — no I/O, no allocation, no clock. It maps
declared items to `IdentityPlanEntry` values and collects `requiredExisting`.
`applyTaskIdentities` then does a **pre-pass** checking every required id exists
*before the first write*, so an unknown id cannot leave a half-applied payload
(the artifact enforced this inside one loop; the pre-pass preserves the guarantee
when a plan spans several writes). `synchronizeIdentities` composes the two.

No Phase 2 address resolution was re-implemented, no plan projection, no
TaskGraph dependency. `blockedReason` is nulled for non-`BLOCKED` items per
`store.orig.ts:502`, and TaskStore still enforces the PF-04 rail on the way in.

## 7. TaskStore authority

`identity.ts` holds **no state** and opens no database. It does not duplicate
`revision` (mutations go through `patchTask`), session ownership, task records,
or migration metadata. `src/task/store.ts` and `src/task/model.ts` are
**byte-identical to `fc00068`** (verified via `git diff fc00068 -- src/task`).

## 8. Reorder invariant

A=`t1`, B=`t2`, C=`t3`; re-declared as C,A,B ⇒ `t3,t1,t2` with titles still
A→t1, B→t2, C→t3, and `order` following the new sequence. Proven by test C and
mutation-killed by P6 and P7.

## 9. Restart invariant

Test D closes the handle (`TaskStore.close` + `resetTaskStoreHandles`), builds a
**new** `TaskStore` instance, and asserts ids and revisions are unchanged, then
that the reopened store resolves an existing id and advances its revision. Not
simulated with one object.

## 10. Regression tests

`test/phase3a-identity.test.ts` — **11 tests, 70 assertions, 0 fail**. One
`mkdtemp(join(tmpdir(), "minicode-id-"))` dir per test, removed by that exact
path; no `readdir(".")`, no pattern delete.

A id validation · A2 status mapping · B stable creation identity + allocator
continuity · C reorder · D restart · E duplicate · F malformed + no partial
mutation · G session isolation · H no accidental reallocation · H2 blockedReason
semantics · I normalization purity/repeatability.

## 11. Mutation results

**14 of 15 killed, 1 equivalent, 0 fabricated.** Both campaigns ran against the
**in-repo** suite with pristine bytes restored and **SHA-verified** after every
mutant, children running with `cwd` = a throwaway temp dir.

Identity layer (`identity.ts`): P2 validation bypass **KILLED** · P3 duplicate
rail **KILLED** · P4 unknown id ignored **KILLED** · P5 pre-pass removed
**KILLED** · P6 reorder mapping **KILLED** · P7 explicit id treated as new
**KILLED** · P8 blockedReason dropped **KILLED** · P9 status mapping collapsed
**KILLED** · **P10 SURVIVED — equivalent.**

Allocator (`model.ts` / `store.ts`, where allocation actually lives): Q1
off-by-one allocator **KILLED** · Q2 count-instead-of-max **KILLED** · Q3
`isTaskId` always true **KILLED** · Q4 revision stops incrementing **KILLED** ·
Q5 session isolation lost in `getTask` **KILLED**.

**P10 is a genuine equivalent mutant.** It injects a `taskId` onto a
`kind: "new"` entry, but `applyTaskIdentities` only reads `taskId` for
`kind === "existing"`, so the field is unreachable there. Notably this is the
*structural* proof of "one canonical allocator": because the identity layer has
no way to inject an id, any "allocator changed" mutant has to target TaskStore —
which is why Q1/Q2 exist.

### Three of my own test bugs, found and fixed
1. **B** asserted `nextId === "t4"` after creating `t4` and deleting `t2`; the
   max is 4, so `t5` is correct. The code was right.
2. **C** asserted id-ordered output after reordering; the listing is
   `(order, task_id)`, so `t3,t1,t2` is correct. The code was right.
3. **H** compared the three originals via `.slice(0,3)`, but the new task takes
   `order: 0` and sorts near the top. Now checked by id.

## 12. Verification limitations

`node_modules` **absent**; no install.

| check | status |
|---|---|
| **PARSE** | **VERIFIED** — `Bun.Transpiler` on `identity.ts`, `store.ts`, `model.ts` |
| **RUNTIME** | **VERIFIED** — 11/11, 70 assertions, real SQLite |
| **TYPECHECK** | **DEFERRED** — no `tsc` without `node_modules`. `Bun.Transpiler` parses; it does **not** typecheck. |
| **FULL SUITE** | **DEFERRED** — out of scope |
| MUTATION | 14/15 killed, 1 equivalent |

## 13. Safety audit

`rm` / `rmSync` / `fs.rm` / `unlink` / `rmdir` / `recursive` / `readdir` /
`process.cwd` / `process.chdir` / `homedir` / `homeDir` in the new files:
**0 occurrences**. `resolveDbPath` (global task-state fallback): **0**. The four
regex hits in each file (`TaskGraph`, `Scheduler`, `PlanStep`,
`payloadVersion`) were each verified to be **header comments** naming what is
deliberately out of scope; `readdir(` in the test is a comment too.

## 14. Deferred Phase 3B items

1. `TodoItem.taskId` propagation (the field itself — **no evidence exists**).
2. `PlanStep.taskId` and `plan.updated` payloadVersion=2.
3. The plan pipeline: `planFromTodos` integration.
4. `synchronizeTasks` / `upsertTasks` (deferred in Phase 1; its D7 *retain*
   and order-renormalisation halves are still absent).
5. `titleKey` re-attach after context rotation — present in the design docs,
   **absent from the artifact's schema**, so deliberately not invented.
6. Legacy-migration importer (unrecoverable since Phase 1).
7. `todoStatusToTask` body confirmation if a real source ever resurfaces.

## 15. Git checkpoint

Commit: **`recovery: restore canonical task identity`**
Files: `src/task/identity.ts` (new), `test/phase3a-identity.test.ts` (new),
`PHASE-3A-CANONICAL-IDENTITY-RECOVERY-REPORT.md` (new). No existing file
modified. Working tree **CLEAN**. Not pushed (8 ahead).
`D:\git\minicode` untouched; `repo-from-remote` unchanged at `aa76dfb`.
