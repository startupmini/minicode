# PHASE 2 — ADDRESSING DELTA MAP

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `fc00068` (Phase 1)
Primary artifact: `todo.orig.ts` (416 lines, pre-wipe uncommitted tree)

---

## 0. The boundary finding, stated first

`todo.orig.ts` was checked for the entire §3/§4 addressing vocabulary:

| token | hits in `todo.orig.ts` |
|---|---|
| `taskId` | **0** |
| `ordinal` | **0** |
| `address` | **0** |
| `resolveTask` | **0** |
| `explicit` | **0** |
| `duplicate` | **0** |
| `canonical` | **0** (as an identifier — only in prose comments) |
| `index` | **0** |
| `TaskStore` | **0** |
| `synchronizeTasks` | **0** |

Its `TodoItem` is:

```ts
export interface TodoItem {
  content: string
  status: TodoStatus
  blockedReason?: string
}
```

**There is no id field.** Therefore the §3 "addressing API" and the §4
"resolution rules" — explicit-vs-legacy task identity, duplicate taskId,
mixed-payload per-item classification, resolve-before-mutate on task payloads —
are **not in the Phase 2 artifact at all**. They lived in the lost
`src/task/normalize.ts` and in `synchronizeTasks`, which Phase 1 already
classified as **Phase 3** (`TodoItem.taskId` propagation, exactly what §2
reserves for Phase 3 and §6 forbids importing here).

**What the artifact DOES contain is canonical addressing of the session's
durable state**: one canonical filename derived from the session id, plus an
explicit legacy filename kept read-only for compatibility. That is the N2
delta, and it is recovered here in full.

Per §6 — "If required evidence is missing: DEFER. Do not fabricate the missing
type" — the taskId resolution layer is **DEFERRED**, not invented.

---

## 1. Per-change classification

| symbol | artifact evidence | baseline counterpart | caller | purpose | phase | confidence |
|---|---|---|---|---|---|---|
| `import { sanitizeSessionPart }` | `todo.orig.ts` L6 | **absent** | — | canonical id→filename mapping | 2 | **VERIFIED** |
| `sanitizeTodoId()` → `sanitizeSessionPart(id)` | L70-72 | inline regex L71 | all 4 path helpers | canonical addressing | 2 | **VERIFIED** |
| `legacySanitizeTodoId()` | L81-83, with rationale comment | *was* `sanitizeTodoId` | `legacyTodoPath`, `legacyPlanPath` | keep pre-N2 files reachable | 2 | **VERIFIED** |
| `todoPath()` canonical | L86-88, "sumber kebenaran untuk semua tulis" | L74-77 | `saveTodos`, `deleteTodoFiles`, `loadTodos` | write address | 2 | **VERIFIED** |
| `legacyTodoPath()` | L91-93, "Hanya untuk fallback BACA; tidak pernah ditulis" | *absent* | `loadTodos`, `deleteTodoFiles` | read fallback | 2 | **VERIFIED** |
| `planPath()` canonical | L95-97 | L79-82 | `savePlanSnapshot`, `deleteTodoFiles` | write address | 2 | **VERIFIED** |
| `legacyPlanPath()` | L100-102 | *absent* | `deleteTodoFiles` | clear legacy plan snapshot | 2 | **VERIFIED** |
| `deleteTodoFiles()` 2→4 paths | L107-119 + comment | L87-91 (2 paths) | `src/session/persistence.ts` `deleteSession` | no reachable residual after session delete | 2 | **VERIFIED** |
| `loadTodos()` canonical→legacy loop | L221-231 + comment | L192-204 (single path) | tools, `cli/setup.ts`, 3 test files | no silent task-list loss on upgrade | 2 | **VERIFIED** |
| `readTodoFile()` extraction | L233-245 | inlined in `loadTodos` | `loadTodos` | returns `null` so the loop can try the next address | 2 | **VERIFIED** |
| `readTodoFile` returns `null` not `[]` | L238, L244 | returned `[]` | `loadTodos` loop | distinguishes "not here" from "empty" | 2 | **VERIFIED** |

### Resolver semantics recovered from the surviving baseline

`sanitizeSessionPart` already existed in `src/lib/session-id.ts` and is used by
`checkpoint.ts`, `journal.ts`, `shadow-git.ts`, with its own tests. It was
**not** reconstructed — it was reused. Exact semantics:

| step | rule |
|---|---|
| 1 | `[^A-Za-z0-9._-]+` → `-` (so `/` becomes `-`) |
| 2 | `..+` → `-` (collapses parent refs) |
| 3 | strip leading/trailing `.` and `-` |
| 4 | `slice(0, 60)` |
| 5 | `""` → `"x"` |

**Canonical vs legacy difference** (the compatibility case the artifact's own
comment calls out: `a/b` was `a_b.json`, now `a-b.json`):

| id | canonical | legacy |
|---|---|---|
| `a/b` | `a-b` | `a_b` |
| `""` | `x` | `default` |
| cap | 60 | 64 |
| `../../etc` | `etc` | `.._.._etc` |

For any id already matching `[A-Za-z0-9._-]{1,60}` the two agree — which is why
every existing test in the repo still passes unchanged.

---

## 2. The §4 resolution rules, one by one

§4 says "Do not assume any of these unless current evidence confirms them."
Confirmed vs not:

| # | rule | evidence | verdict |
|---|---|---|---|
| 1 | explicit taskId wins | **none** — no `taskId` in the artifact | **UNKNOWN → DEFER (Phase 3)** |
| 2 | invalid explicit ID must not silently fall back | **none** | **UNKNOWN → DEFER** |
| 3 | duplicate taskId is an error | **none**; the duplicate guard that *does* exist is in `synchronizeTasks` (Phase 1 deferred) | **UNKNOWN → DEFER** |
| 4 | legacy ordinal resolution is explicit | **none** — no ordinal concept; the legacy analogue is *filename* fallback, which **is** explicit and verified | **VERIFIED (as filename fallback)** |
| 5 | mixed payloads need per-item classification | **none** | **UNKNOWN → DEFER** |
| 6 | legacy positional addressing must not collide with canonical | **CONFIRMED** for addresses: legacy is read-only and never written (test F); for ordinals, no evidence | **VERIFIED (address sense)** |
| 7 | resolution happens before mutation | **CONFIRMED** for the read path: `loadTodos` resolves an address before returning content, and a read never creates a file (test G) | **VERIFIED (address sense)** |
| 8 | canonical ordering is deterministic | **CONFIRMED**: same id → same address, repeatably (test H) | **VERIFIED (address sense)** |

Not one of these is silently reconciled. Rules 1, 2, 3, 5 have **no evidence in
this phase's artifact** and are deferred rather than approximated with a passing
test that would prove nothing.

---

## 3. No new API was invented

The artifact exports **nothing new** — every new symbol (`legacySanitizeTodoId`,
`legacyTodoPath`, `legacyPlanPath`, `readTodoFile`) is module-private, exactly as
in `todo.orig.ts`. No addressing module, no `AddressKind` type, no resolver
object, no ordinal concept. `TaskStore` is untouched and remains authoritative
for task state; this phase only addresses the **JSON/plan files**, and never
reads or writes `tasks.db`.

## 4. Phase 3 items explicitly left undone

`TodoItem.taskId`; explicit-vs-legacy task identity; duplicate taskId rejection;
mixed-payload per-item classification; `PlanStep.taskId`; taskId-aware plan
events; `synchronizeTasks`/`upsertTasks` (deferred in Phase 1); legacy-migration
importer (unrecoverable, Phase 1).
