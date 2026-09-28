# PHASE 4B.1 — CANONICAL ID WRITE-BACK REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Opened from: **Phase 4B** (end-to-end identity integrity) · Baseline: `a594945`
Commit message: `fix: write back canonical task identities`

**NEW ARCHITECTURE.** This subphase exists because 4B found a real production
defect, and §21 requires a small named subphase with its own checkpoint rather
than a casual drive-by fix.

---

## 1. Defect

`todo_write` persisted the **declared** payload to the legacy JSON *before*
canonical synchronization. A task the sync was about to create therefore had no id
in the JSON. The id minted by TaskStore reached the plan builder (4A.4A
assignment) but never the file that `todo_read` actually reads.

**Measured on `a594945`, before the fix:**

```
seeded:      ["t1=A","t2=B"]
assignment:  ["t1:existing","t3:new","t2:existing"]
TaskStore:   ["t1=A","t3=C","t2=B"]
todo_read:   "todos 0/3\n  [ ] t1 — A\n  [ ] C\n  [ ] t2 — B"
=> does todo_read expose the NEW id t3? NO
```

## 2. Root cause

An ordering boundary, not a missing feature. The 4A.4 ordering is
`saveTodos → canonical sync → plan publication`, and the first `saveTodos`
necessarily persists the declaration, which by definition has no id for a task
that does not exist yet. Nothing ever wrote the resolved identities back.

## 3. Consequence — a reachable duplicate durable task

Because the model could not learn the id of a task it had just created, its next
turn re-sent that item id-less. 4A.5 classifies a *mixed* payload's id-less items
as new work, so a second canonical row was created:

```
TURN 1: [t1=A, C(new), t2=B]   ->  TaskStore ["t1=A","t3=C","t2=B"]
         todo_read: "[ ] C"     ->  the model cannot address C
TURN 2: [t1=A, C(id-less), t2=B] -> TaskStore ["t1=A","t4=C","t2=B","t3=C"]
=> rows titled C: 2   *** DUPLICATE DURABLE TASK ***
```

This reopened, through a different door, exactly the duplication 4A.5 closed.

## 4. Minimal fix

After a **successful** canonical sync, the ids the transaction returned are merged
into the persisted list and the file is re-written:

```ts
const merged = list.map((t, i) =>
  !t.taskId && assignment[i] ? { ...t, taskId: assignment[i]!.taskId } : t)
if (merged.some((t, i) => t.taskId !== list[i]?.taskId)) {
  current = merged
  await saveTodos(sessionId, current, cwd)
}
```

Properties, each pinned by a test:

- The merged ids are the **allocator's own**, returned by the transaction that
  committed them. Nothing is inferred from position, content or title.
- **Ordering preserved.** The first `saveTodos` still precedes the sync, so a
  durable-write failure still suppresses plan publication (4A.4), and the 4A.5
  guard still runs before anything is written (test 9).
- **Legacy untouched.** No assignment ⇒ no merge ⇒ no second write; the file
  contains no `taskId` (test 4).
- **Additive only.** A declared id is never rewritten (test 6).
- **No work, no write.** A payload that creates nothing performs no second write
  (test 5).
- `savePlanSnapshot` is now fed the resolved list, and the `todo_write` result
  renders it, so the id is visible in three places: `todo_read`, the tool result,
  and the durable file.

## 5. Scope boundary — stated honestly

This makes the identity **observable**. It does **not** make a model error
impossible. If a model re-sends a task id-less inside a *mixed* payload, 4A.5
still treats it as new work, because deciding otherwise would require
content-based identity matching, which is forbidden.

Test 7 pins that residual **deliberately** — it asserts the duplicate (`t3` and
`t4` both titled C) so the boundary of the contract is visible in code rather
than assumed. Claiming this class of duplicate is impossible would be false.

## 6. Tests

`test/phase4b1-id-writeback.test.ts` — **9 tests, 30 assertions.**

1 read-back of a created id · 2 durable file carries it · 3 the write result names
it · 4 legacy path writes no ids · 5 nothing to create ⇒ nothing added ·
6 declared ids never rewritten · 7 **documented residual** · 8 the markdown plan
snapshot is a legacy artifact · 9 the 4A.5 guard still precedes the first write.

### Two of my own test expectations were wrong, and both were informative

- **Test 8** assumed the `.minicode/plans/<session>.md` snapshot would pick up the
  resolved ids. It does not: that markdown renders `- [ ] A (pending)` and has
  never carried ids. Adding them would be a plan-pipeline change, explicitly out
  of scope, so I pinned the **current** reality and documented that canonical
  identity is observable via `todo_read`, the tool result and the `plan.updated`
  event — not via that file.
- **Test 5** asserted the JSON was byte-identical across two writes. Only
  `updatedAt` differs, because it is a wall-clock stamp that legitimately changes
  on every write. The real invariant is the persisted `todos` array, which is
  what it now asserts.

## 7. Mutation — 7 killed, 1 equivalent, 0 needle miss

| # | mutant | result |
|---|---|---|
| W1 | do not merge resolved ids (the original defect) | KILLED |
| W2 | merge a positional id instead of the allocator's | KILLED |
| W3 | merge but never re-persist | KILLED |
| W4 | rewrite a declared id instead of only adding one | **EQUIVALENT** |
| W5 | shift the assignment by one | KILLED |
| W6 | write ids back on the legacy path too | KILLED |
| W7 | drop the 4A.5 guard while touching this code | KILLED |
| W8 | render the declared list instead of the resolved one | KILLED |

**W4 is provably equivalent, and I am reporting it as such rather than re-rolling
it.** For an existing item the assignment entry is
`{ taskId: entry.taskId, kind: "existing" }` — the model's own declared id,
echoed unchanged. And a mismatched declared id is rejected upstream
(`TASK_NOT_FOUND` / `TASK_DUPLICATE_ID`) before any assignment exists. So the
overwriting variant can only ever write back the value that was already there.

## 8. Validation

| check | result |
|---|---|
| PARSE | **VERIFIED** — 4 sources |
| RUNTIME (4B.1) | **VERIFIED** — 9/9, 30 assertions |
| RUNTIME (4A.1–4A.5 + 3A/3B + 4B.1) | **VERIFIED** — 123 pass / 0 fail / 1041 assertions |
| REGRESSION (`debc295` evidence) | **VERIFIED** — still reproduces, 19 assertions |
| MUTATION | **VERIFIED** — 7 killed, 1 equivalent |
| TYPECHECK | **DEFERRED** — `node_modules` absent |
| FULL SUITE | **DEFERRED** |
| BROAD sweep | deferred to the 4B checkpoint |

## 9. Files changed

| file | change |
|---|---|
| `src/tools/todo.ts` | merge resolved ids and re-persist; render the resolved list |
| `test/phase4b1-id-writeback.test.ts` | **new** — 9 tests |
| `PHASE-4B.1-CANONICAL-ID-WRITEBACK-REPORT.md` | this report |

No change to `store.ts`, `identity.ts`, `adapter.ts`, `assignment.ts` or
`sync.ts`; no new allocator, protocol field, global or error code.

## 10. Commit

`fix: write back canonical task identities`. SHA not self-cited. Tree CLEAN after
commit. **Not pushed.** Specimen untouched; every run used an explicit redirected
`cwd`.

## 11. Known limitations

- A model that ignores an id it was shown can still duplicate work inside a mixed
  payload (§5, test 7). Closing that would require content-based identity.
- The markdown plan snapshot still carries no canonical ids (§6).
- MCP canonical identity still does not survive a server restart — 4B will
  measure and document that as a lifecycle limitation.
