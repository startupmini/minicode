# PHASE 4A.1 — PROTOCOL IDENTITY IMPLEMENTATION REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `debc295` (the brief said `9d7dcfe`; the regression-evidence commit
`debc295` was already on top)
Commit message: `feat: expose canonical task identity in todo protocol`

---

## 1. Current protocol before the change

| aspect | state |
|---|---|
| item schema | `todos[].{content, status}`, `required:["content","status"]`, `additionalProperties:false` at item **and** root |
| `TodoItem` type | `{content, status, blockedReason?}` — no identity field |
| `normalizeTodos` | **rebuilt** every item as a fresh object, so *all* unknown fields were discarded |
| `renderTodos` | emitted `GLYPH + content (+ blockedReason)` — **0** identity references |
| runtime schema validation | **none** — the schema is declarative only, so validation must live in the handler/normalizer |
| read-back | `todo_read` returns `renderTodos(list)`, so the model could see nothing about identity |

**Mismatch found between a prior report and current source:** none material. My
earlier reports stated the schema forbids a `taskId` and that `renderTodos` has
zero `.id` references; both were re-verified against the live file before editing.

## 2. Exact schema change

One property added to the item schema, nothing else altered:

```ts
taskId: {
  type: "string",
  description:
    "Canonical task id (e.g. t1) of an EXISTING task, as returned by todo_read. Omit for a new task. Never invent one.",
},
```

Retained exactly as before: `required: ["content","status"]`,
`additionalProperties: false` (item and root), and the `status` enum.

Because the schema is declarative and there is no runtime validator, **value**
validation lives in `normalizeTodos`, the single runtime choke point on both the
write and read paths. It uses the existing canonical guard — no second regex:

```ts
if (r.taskId !== undefined && r.taskId !== null && !isTaskId(r.taskId)) {
  throw new Error(`todo item has a non-canonical taskId: ${String(r.taskId)}`)
}
```

`isTaskId` is **imported** from `src/task/model.ts`; this file contains **0**
occurrences of `^t[`.

## 3. Exact read-back change

`renderTodos` now emits the id when present, and nothing extra when absent:

```
  [ ] t1 — First task          (id present)
  [ ] legacy item              (id absent — rendered exactly as before)
```

No second listing tool was added, and no id is synthesised for display.

## 4. Normalization path

```
model JSON
  -> declarative schema (taskId accepted, everything else still closed)
  -> normalizeTodos  ── isTaskId validation; taskId passed through unchanged
  -> TodoItem { content, status, blockedReason?, taskId? }
  -> saveTodos / JSON file
  -> loadTodos -> normalizeTodos -> renderTodos -> todo_read
```

`taskId` is the **only** identity-bearing field that survives normalization. It
is never trimmed, case-folded, renumbered, padded or coerced. Absent stays
absent — the key is not even created (`"taskId" in item === false`).

## 5. Compatibility behavior

- Legacy id-less payloads are **unaffected** — verified: all 106 pre-existing
  tests across 7 files still pass, and rendering of an id-less line is
  byte-identical to before.
- `taskId` is optional; all-id-less payloads are **not** rejected (that is a
  later semantic phase).
- A payload carrying `id`, `stepId`, `task_id` or `foo` still has them dropped —
  only `taskId` is carried.

**Known consequence, stated deliberately:** a *hand-edited or corrupted* file
containing a non-canonical `taskId` will make `normalizeTodos` throw, and
`readTodoFile` catches that and returns `null`, so `loadTodos` yields `[]` for
that session. This is fail-closed and consistent with the existing
"normalizeTodos throws" behaviour. It is unreachable today because no writer
emits `taskId` yet (no wiring in this phase).

## 6. Identity-authority proof

| check | result |
|---|---|
| literal `` t{ `` occurrences in `todo.ts` | **0** — cannot mint an id |
| `isTaskId` | **imported**, not reimplemented; local id regex count **0** |
| `Math.random` / `crypto` / counter added | **0** |
| `TaskStore` / `createTask` / `nextId` / `taskIdFromIndex` referenced in added code | **0** (one JSDoc mention only) |
| ordinal → taskId / content → taskId conversion | **none** |

The protocol transports identity; the sole allocator remains `TaskStore`.

## 7. Tests

`test/phase4a1-protocol-identity.test.ts` — **12 tests, 59 assertions, 0 fail.**

| req | test |
|---|---|
| A | schema accepts optional `taskId`; `required` and `additionalProperties:false` intact |
| A2 | `taskId` is NOT in `required` |
| B | `t1/t2/t42` accepted; `""`, `t0`, `t01`, `T1`, `foo`, `t-1`, `1` rejected |
| C | legacy id-less payloads pass unchanged, no id invented |
| D | `taskId` survives normalization alongside `blockedReason`; key absent when not supplied |
| E | `todo_read` exposes the id, on the same line as the content |
| E2 | id-less line renders exactly as before, no `t<n>` |
| F | round-trip through `saveTodos`/`loadTodos` preserves the exact value |
| F2 | round-trip through the `todo_write` tool itself |
| G | `id`/`stepId`/`task_id`/`foo` are all still dropped; only `content`,`status` survive |
| H | no id allocated when absent, across repeated normalization |
| I | supplied id passed through byte-for-byte (`t1`, `t42`, `t999999`); not re-sequenced |

Safety: one `mkdtemp(join(tmpdir(), "minicode-p4a-"))` dir per test, removed by
that exact path. No `readdir(".")`, no pattern delete.

## 8. Mutation results

Run against `src/tools/todo.ts`, global replacement, pristine bytes restored and
**SHA-verified** after every mutant.

| # | mutant | result |
|---|---|---|
| M1 | `taskId` removed from the declared schema | **KILLED** (A) |
| M2 | `taskId` made required | **KILLED** (A2) |
| M3 | value validation bypassed | **KILLED** (B) |
| M4 | `taskId` dropped during normalization | **KILLED** (B) |
| M5 | `taskId` dropped during rendering | **KILLED** (E) |
| M6 | `taskId` rewritten to a constant | **KILLED** (B) |
| M7 | `taskId` silently generated when absent | **KILLED** (C) |
| M8 | arbitrary extra properties allowed | **KILLED** (A) |

```
killed=8  survived=0  needle-misses=0
bytes restored identical: true
```

**0 equivalent, 0 survived.** Every requested mutation category was applied and
killed; none was forced.

## 9. Validation status

| check | result |
|---|---|
| PARSE | **VERIFIED** — `Bun.Transpiler` on `src/tools/todo.ts` |
| RUNTIME (new) | **VERIFIED** — 12/12, 59 assertions |
| RUNTIME (regression) | **VERIFIED** — 150 pass / 0 fail / 1 skip across 10 files |
| MUTATION | **VERIFIED** — 8/8 killed |
| TYPECHECK | **DEFERRED** — `node_modules` absent; install not authorised. `Bun.Transpiler` parses, it does not typecheck. |
| FULL SUITE | **DEFERRED** — 200+ files not run. No broader health is inferred from the 10 files above. |

The single skip is the pre-existing known-bad duplication regression
(`debc295`), correctly gated off by default.

## 10. Files changed

| file | change |
|---|---|
| `src/tools/todo.ts` | modified — `TodoItem.taskId?`, schema property, validation + preservation in `normalizeTodos`, id in `renderTodos`, one import |
| `test/phase4a1-protocol-identity.test.ts` | **new** |
| `PHASE-4A.1-PROTOCOL-IDENTITY-IMPLEMENTATION-REPORT.md` | **new** |

Verified **unchanged** by hash against `HEAD`:
`src/presentation/adapter.ts`, `src/presentation/events.ts`,
`src/task/store.ts`, `src/task/model.ts`, `src/task/identity.ts`,
`src/mcp/server.ts`, `cli/setup.ts`.

## 11. Commit

Message: `feat: expose canonical task identity in todo protocol`. The SHA is
deliberately not self-cited — committing this report changes it. Verify with
`git log -1 --pretty=format:'%h %s'`.

## 12. Working-tree status

**CLEAN** after commit. Not pushed. `D:\git\minicode` untouched.
`node_modules` still absent — no dependency installed.

## 13. What this phase does NOT implement

- **TaskStore production wiring** — no store is constructed or called from
  `todo.ts`; TaskStore still has zero production consumers.
- **Synchronization** — nothing calls `synchronizeIdentities` /
  `applyTaskIdentities` / `synchronizeTasks`.
- **Bootstrap / adoption** — untouched, and still BLOCKED.
- **Rejection of all-id-less payloads** — an id-less item is still accepted, as
  required. Semantic enforcement is a later phase.
- **Transaction API** — not added.
- **MCP namespace** — untouched (`todoSession.id` still `"mcp-server"`).
- **Deletion semantics** — unchanged.
- **Identity allocation** — none. The protocol cannot mint an id.
- **Plan pipeline, execution loop, TaskGraph, Scheduler** — untouched.

The identity contract remains **BLOCKED**. This phase removed the protocol
blocker (identity is now representable and observable) but the semantic,
namespace and atomicity blockers are unchanged. In particular, **the known
duplication defect in `debc295` is still live** — the model can now *send* an
id, but nothing yet interprets it, so the duplication regression remains
expected to reproduce.
