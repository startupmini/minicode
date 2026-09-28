# PHASE 3C-1 — TASKSTORE PRODUCTION WRITE BOUNDARY: FORENSIC REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `9d7dcfe` (Phase 3B)
**Result: B — INSUFFICIENT EVIDENCE. No implementation was made. The tree is
unchanged and no commit was created.**

---

## 1. Decision

**B — INSUFFICIENT EVIDENCE.** The historical production write boundary cannot
be proven, so it was **not** implemented. Per the brief's Step 6, ordering was
also not chosen, because choosing it would be the same invention one layer down.

## 2. Forensic inventory (Step 1)

Searched all of `src` + `cli` at `9d7dcfe`, plus all five `.orig.ts` artifacts.

| symbol | current source | classification |
|---|---|---|
| `todo_write` | 12 files — setup, tool-layer, executor, permission, adapter, label, journal, tools/task, tools/todo, ui/assistant | **VERIFIED CURRENT SOURCE** |
| `saveTodos` | `src/tools/todo.ts` (writer), `src/presentation/adapter.ts` (comment) | **VERIFIED CURRENT SOURCE** |
| `synchronizeTasks` | 0 call sites; 7 hits, **all in my own deferral comments** | **RECONSTRUCTED FROM HISTORY** (defined in `store.orig.ts`; never called in any survivor) |
| `synchronizeIdentities` / `applyTaskIdentities` | 1 file each (`src/task/identity.ts`, Phase 3A) | **VERIFIED CURRENT SOURCE**, zero production consumers |
| `TaskStore` outside `src/task/` | 4 hits, **all comments** (adapter ×3, events ×1) | **VERIFIED** — zero imports |
| `createTask` / `patchTask` / `listTasks` | `src/task/store.ts` only | **VERIFIED** — zero production consumers |
| `upsertTask` | 0 hits | — |
| `taskIdentityProvider` | `src/presentation/adapter.ts` (declared, never injected) | **VERIFIED** (Phase 3B seam) |
| `saveTodoStore` | **0 in source; 0 in all 5 artifacts; 1 in a doc only** | **UNKNOWN** |
| `getSnapshot` outside `src/task/` | all `getPresentationSnapshot` | **VERIFIED** — unrelated false positive |
| `nextId` outside `src/task/` | `src/ui/tui/transcript.ts` private counter | **VERIFIED** — unrelated false positive |

**Authoritative check:** `git grep -E 'from ".*src/task/'` over `src`+`cli`
returns **ZERO imports**. No production file loads the task subsystem at all.

**Artifact cross-check:** of `adapter.orig.ts`, `reducer.orig.ts`,
`todo.orig.ts`, `persistence.orig.ts`, `db-path.orig.ts` — **none** contains
`TaskStore`, `synchronizeTasks`, `upsertTasks`, `createTask`, `taskId`,
`tasks.db`, or `saveTodoStore`. `store.orig.ts` is an **island**: it defines the
write API and no surviving artifact calls it.

## 3. The actual `todo_write` lifecycle (Step 2)

```
model emits todo_write(args.todos)
  -> src/policy/executor.ts            (permission, no post-tool hook seam)
  -> src/app/tool-layer.ts             (dispatch; NO post-tool hook seam)
  -> src/tools/todo.ts todoWriteTool.execute
        cwd   = ctx.cwd ?? todoSession.cwd ?? process.cwd()
        list  = normalizeTodos(todos, currentCompletionEvidence())
        await saveTodos(todoSession.id, list, cwd)          <-- DURABLE WRITE
        await savePlanSnapshot(...).catch(() => {})         <-- best-effort
  -> execution:completed (result.isError === false only)
  -> adapter: planFromTodos(call.args, childId ?? sessionId)
  -> publish plan.updated                                    <-- PRESENTATION
```

| question | answer | label |
|---|---|---|
| 1. Which layer owns todo mutation? | `src/tools/todo.ts`, inside the tool's own `execute` | **VERIFIED** |
| 2. Which layer has session identity? | the mutable global `todoSession.id`, and `presentationSessionId` in setup.ts | **VERIFIED** — and `TASK_ARCHITECTURE_AUDIT.md:105` flags this global as a cross-session leak |
| 3. Which layer has the canonical TaskStore instance? | **none — no instance is ever constructed in production** | **VERIFIED** |
| 4. Which layer can safely synchronize atomically? | **undeterminable without choosing an owner** | **UNKNOWN** |
| 5. Sync failure behaviour | **unknown** — no precedent exists | **UNKNOWN** |
| 6. Plan published, store write failed | **cannot occur today** (no store write) | **UNKNOWN** |
| 7. Store write succeeded, plan publication failed | **cannot occur today** | **UNKNOWN** |

### The one ordering/failure fact that IS proven

`src/presentation/adapter.ts:761-765` (surviving comment, above the emission):

> "Plan event terbit DI SINI — setelah tool sukses … Previously published from the
> arguments BEFORE the tool ran, so `plan.updated` with status `completed` could
> be persisted durably even though `saveTodos` failed (disk full/EACCES):
> presentation claims finished when there is no file."

This proves, for the JSON path: **durable write precedes plan publication, and a
failed durable write suppresses the plan.** It is evidence about `saveTodos`
only. It says nothing about a TaskStore commit, because no TaskStore commit
existed in any surviving source.

## 4. Lost-architecture clues examined (Step 3)

### Clue A — `docs/CANONICAL_TASK_IMPLEMENTATION_PLAN.md:44-45`

> "`saveTodoStore` dipanggil dari `cli/setup.ts` dengan `presentationSessionId`"

This is the **only** surviving statement that names an owner. It was tested
against Step 3's warning ("do not infer implementation merely because a symbol
appeared in an old report") and it **fails**, on three independent grounds:

1. **The symbol does not exist.** `saveTodoStore`: 0 hits in current source,
   **0 hits in all five artifacts**.
2. **It contradicts the shipped code on storage.** The plan says the table goes
   in `sessions.db`; `store.orig.ts` uses a **separate `tasks.db`** and gives an
   explicit reason — `sessions.db` may fall back to the shared `~/.minicode/`,
   violating D2. The artifact's reason post-dates and overrides the plan.
3. **It contradicts the shipped code on the read path.** The plan says
   `.minicode/todos/*.json` becomes a human export and `loadTodos` reads
   TaskStore. The Phase 2 artifact `todo.orig.ts` demonstrably **still reads the
   JSON file** (canonical path plus legacy fallback) — behaviour restored and
   tested in Phase 2.

The same document also specifies an API the artifact does not have
(`load`, `save`, `nextId` vs the artifact's `getTask`/`listTasks`/`createTask`/
`patchTask`/`synchronizeTasks`), and places `stepId = task_id` in `plan.updated`
— the opposite of the Phase 3B design lock you approved. This is a **superseded
plan**, not a description of the pre-wipe implementation.

### Clue B — the `store.orig.ts` docstring (the best available evidence)

It names the *shape* of the write but never the owner:

- L443: "Synchronize the task list DECLARED by the model with TaskStore."
- L451-452: the LEGACY mode is "an old `todo_write` full-replace payload".
- L466: "ONE normalizer for ALL paths (§19): model args, legacy file, and
  **post-verify reconciliation** all go through the same `normalizeTodos`."

So three consumer *paths* are named, implying the call sat in more than one
place. But the same file contains **0** occurrences of `setup.ts`, `cli/`,
`caller`, `adapter`, `upstream`, `rebuildFromDurable`, or `notePlanReconciled`.
The two `dipanggil` ("called") hits are unrelated (`TaskStore` "called without
DI"; `initialize()` "safe to call repeatedly").

Three candidate owners remain, none excluded by evidence:
(a) inside `todoWriteTool.execute`, beside `saveTodos`;
(b) a composition-root call in `cli/setup.ts` (the doc's claim);
(c) a post-tool hook — **ruled out**: neither `src/app/tool-layer.ts` nor
`src/policy/executor.ts` has any post-tool hook seam.

## 5. The exact missing boundary

> **Which component converts the model's declared `todo_write` payload into
> TaskStore writes, and at what point relative to (i) the `saveTodos` JSON
> write, (ii) the `plan.updated` publication, and (iii) the durable
> `presentation_events` append?**

Corollaries that are equally unprovable:

- whether the TaskStore write is **required** or **best-effort** when it fails;
- whether a failed TaskStore write must **suppress** `plan.updated` (the proven
  `saveTodos` rule suggests yes, but extending it is an inference);
- whether the write happens **once** per `todo_write`, or also on the
  post-verify reconciliation path that L466 names;
- whether the JSON file remains authoritative (Phase 2 evidence says it was) or
  becomes a derived export (the superseded plan says it should);
- whether the MCP-serve path also wrote to the store — the design docs mention
  two consumers (`cli`, `mcp serve`) but no surviving code shows either.

## 6. Evidence that is PRESENT (supports the invariants, not the ownership)

1. TaskStore exists, is session-scoped, allocates ids via `max` (Phase 1).
2. Canonical identity resolution, duplicate/malformed rejection, and
   resolve-before-mutate are implemented and mutation-tested (Phase 3A).
3. Canonical addressing with legacy fallback is implemented (Phase 2).
4. The plan pipeline can consume canonical identity through an injected
   provider, and emits `payloadVersion: 2` only on total resolution (Phase 3B).
5. Proven ordering: durable todo write → plan publication; failed write
   suppresses the plan (`adapter.ts:761-765`).

Every invariant the brief listed for a future implementation is therefore
*already satisfied by the existing modules*. The only missing thing is **the call
that connects them** — and that call is exactly what the wipe destroyed.

## 7. What was NOT done, deliberately

- No TaskStore write was added to `todo_write`, setup, the executor, or the adapter.
- No ordering between a TaskStore commit and plan publication was chosen.
- No failure/transaction semantics were invented.
- No `saveTodoStore` shim was created to match the doc.
- **No commit was made.** `git status` is CLEAN at `9d7dcfe`; `git diff --stat`
  is empty. Investigation only.

## 8. Validation

| check | result |
|---|---|
| PARSE | **N/A — no code was written** |
| RUNTIME | **N/A — no code was written** |
| MUTATION | **N/A — no code was written** |
| TYPECHECK | **DEFERRED** — `node_modules` absent, install not authorised |
| FULL SUITE | **DEFERRED** — 200+ files not run; and with no code change there is nothing new to regress |
| Working tree | **VERIFIED CLEAN** at `9d7dcfe` |
| Incident specimen | **VERIFIED untouched** — `D:\git\minicode` still `.freebuff/project-id` |

No full-suite health is inferred from anything here.

## 9. Safety audit

No source file was modified, so there is no new filesystem surface. No
`rm`/`unlink`/`rmdir`/`readdir`/`process.chdir`/`homedir` usage was introduced.
No dependency was installed. No temp or mutation artifacts remain.

## 10. Recommended next step (requires a human decision, not a guess)

The smallest decision needed is a single question:

> **Should `todo_write` write to TaskStore, and must that write succeed before
> the plan is published?**

Two coherent options, both consistent with the surviving evidence but neither
*proven* by it:

- **(A) Extend the proven JSON rule.** Write TaskStore inside
  `todoWriteTool.execute` immediately after `saveTodos`; a failure surfaces as
  tool error, which already suppresses `plan.updated`. This reuses the one
  ordering invariant that *is* proven, and needs no new lifecycle.
- **(B) Compose at the root**, per the superseded plan: a `cli/setup.ts` call
  with `presentationSessionId`. `cwd` is in scope at `setup.ts:994`, so this is
  mechanically easy — but it resurrects an architecture the shipped code
  contradicts, and it needs its own ordering rule for the post-verify path.

I did not choose between these, because the evidence does not.

**STOPPING after Phase 3C-1. Not beginning 3C-2.**
