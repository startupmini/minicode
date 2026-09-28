# PHASE 3C-DECISION — TASKSTORE WRITE BOUNDARY: DESIGN LOCK

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `9d7dcfe` (Phase 3B)
**This is a NEW ARCHITECTURE DECISION. Nothing here is claimed as recovered.
No production code was modified. No commit was created.**

---

## 1. Evidence boundary

### Proven (surviving source, current)

| fact | evidence |
|---|---|
| JSON todo write precedes plan publication; a failed JSON write suppresses the plan | `adapter.ts:761-765`; mechanism confirmed: `atomicWriteText` throws (`atomic-write.ts:44-87`), `todoWriteTool.execute` has no catch (`todo.ts:381-392`), so the result is `isError` and the adapter's `if (!result.isError)` gate (`adapter.ts:758`) skips publication |
| **No cross-FS+DB transaction exists** | `journal.ts:14` — *"BUKAN transaksi lintas FS+DB (tak tersedia)"* |
| Persistence write failures are **fail-open** for the turn | `journal.ts:18-19` — *"kegagalan append/fsync TAK PERNAH menggagalkan turn (fail-open eksekusi) tetapi menandai sesi degraded"* |
| TaskStore has zero production consumers | `git grep 'from ".*src/task/'` over `src`+`cli` → **0** |
| Two composition roots own `todoSession` | `cli/setup.ts:922-923`; `src/mcp/server.ts:205-208` |
| MCP pins one session id for the whole request | `src/mcp/server.ts:207` — `todoSession.id = "mcp-server"`, restored at `:536-537` |
| There are **two** JSON write sites | `todo.ts:389` (`todo_write`) and `todo.ts:269` (`reconcileCompletionEvidence`, post-verify) |
| No post-tool hook seam | `src/app/tool-layer.ts`, `src/policy/executor.ts` — no `onToolComplete`/`afterTool`/`postTool` |
| `saveTodoStore` exists only in a superseded doc | 0 in source, 0 in all 5 artifacts |

### Unknown

Which component performed the write; the ordering; whether the post-verify path
also wrote; failure semantics between JSON and TaskStore; ordering against the
durable `presentation_events` append; whether MCP ever wrote to the store.

## 2. Option A — write inside the tool

```
todo_write -> saveTodos(JSON) -> synchronize TaskStore -> plan publication
```

**Dependency direction.** `src/tools/todo.ts` would import
`src/task/identity.ts` → `src/task/store.ts`. This makes a leaf tool module
depend on durable storage, which it currently does not. `src/tools/` today owns
no storage. Acceptable, but it is a new edge and it pulls `bun:sqlite` into the
tool's module graph.

**Session identity availability.** Available (`todoSession.id`, `todoSession.cwd`,
`ctx.cwd`) and already resolved in `execute`. **But** it is a mutable global, and
in MCP mode it is the constant `"mcp-server"` for the entire request. Writing
durable task identity under that id would make every concurrent MCP request share
one task identity space. `TASK_ARCHITECTURE_AUDIT.md:105-108` already flags this
global as unsafe for two sessions in one process. **Option A inherits that defect
into durable state**, converting a telemetry wart into identity corruption.

**Transaction boundary.** Two independent atomic units: one atomic file
(`atomicWriteText` = tmp+rename) and one SQLite transaction per TaskStore call.
Nothing spans them, and `journal.ts:14` says no such thing is available.

**Failure semantics.** A TaskStore throw propagates exactly like a `saveTodos`
throw → tool error → plan suppressed. This reuses the one ordering rule that is
actually proven, and requires no new mechanism.

**JSON/TaskStore divergence.** Possible and unrecoverable without a
reconciliation pass that does not exist. After Case B/D, the JSON is the only
record of the intended state, while TaskStore — the declared authority — is
missing entries.

**Must plan publication be suppressed on TaskStore failure?** Invariant 1 says
TaskStore is authoritative for durable task identity. If a plan is published as
`completed` while TaskStore lacks that identity, the authority claim is false at
runtime. So **yes**, suppression is required for coherence with invariant 1.

**TaskStore before or after JSON?** The evidence does not decide. Writing TaskStore
*first* makes it the commit point and leaves JSON as a derived export; writing it
*second* preserves today's JSON-first behaviour and makes a failure leave JSON
ahead. Since Phase 2 evidence proves the JSON file was the source at pre-wipe
time, JSON-first is the smaller change, but it makes TaskStore the *lagging*
authority — which is a real tension with invariant 1 and must be stated, not
glossed.

**New orchestration abstraction needed?** No. It is a sequential call in an
existing function.

**Second write site.** `reconcileCompletionEvidence` (`todo.ts:269`) also calls
`saveTodos`. Option A must cover it too or the post-verify path silently diverges.

## 3. Option B — composition-root orchestration

```
composition root -> Todo persistence / TaskStore / Plan pipeline
```

**Ownership.** The root already owns session lifecycle: it sets `todoSession`,
and `cwd` is in scope at `setup.ts:994`. It could hold one TaskStore per session,
which fixes the global-identity problem Option A inherits.

**Dependency injection.** Matches three existing precedents: `contentStore?`,
`turnSummaryProvider`, and the Phase 3B `taskIdentityProvider?`.

**Ordering — the decisive weakness.** There is no post-tool hook. The root would
have to subscribe to `execution:completed`, which fires *after* the tool has
already written JSON. But the **plan is also published from an
`execution:completed` handler** (the adapter's). So ordering between "root
synchronizes TaskStore" and "adapter publishes plan" would depend on **event
handler registration order** between two independent subscribers. That is not a
contract — it is incidental. Any future refactor that reorders registration
silently changes whether the plan sees synchronized identity, and because 3B
emits `payloadVersion: 2` only on *total* resolution, a reordering would silently
downgrade plans to positional identity rather than fail loudly.

**Lifecycle.** Two roots must be wired (`cli/setup.ts` and `src/mcp/server.ts`),
and MCP's request-scoped save/restore of `todoSession` would need matching
TaskStore session handling.

**`saveTodoStore`.** Not revived. It exists in no source and its architecture
(tables in `sessions.db`, `loadTodos` reading TaskStore) is contradicted by the
shipped code. Naming a new function after it would falsely signal recovery.

**Unnecessary new architecture?** Yes, relative to A: an orchestration seam
purely to obtain a write that can be a sequential call.

## 4. Failure matrix

| Case | Behaviour | Classification |
|---|---|---|
| **A** JSON write fails | `atomicWriteText` throws → tool error → plan suppressed; TaskStore untouched | **GUARANTEED BY EXISTING SYSTEM** (proven, mechanism confirmed) |
| **B** TaskStore write fails | Tool error → plan suppressed; **JSON already written** | **DESIGN DECISION REQUIRED** — chosen: fail-closed, for invariant 1 |
| **C** JSON ok, TaskStore ok, plan publication fails | TaskStore is the durable truth; plan simply missing | **GUARANTEED BY EXISTING SYSTEM** (independent writes; no rollback exists) |
| **D** JSON ok, TaskStore fails | JSON is the only record; TaskStore diverges | **DESIGN DECISION REQUIRED** — fail-closed suppresses the plan, but divergence still exists on disk with no reconciliation |
| **E** TaskStore ok, plan publication fails | Identical to C from TaskStore's perspective | **GUARANTEED BY EXISTING SYSTEM** |
| **F** crash between boundaries | Partial state; `journal.ts:14` states no cross-FS+DB transaction exists | **UNKNOWN / not solvable here** — the journal's intent/terminal/finalize protocol exists for the *journal*, not for JSON+SQLite |
| **G** retry after partial success | `nextId` uses `max`, so replayed declarations do not collide; but duplicate-identity rejection and positional legacy matching make replay semantics **unproven** | **DESIGN DECISION REQUIRED** — must be specified before implementation |

**No distributed transaction is proposed.** `journal.ts:14` is explicit that none
is available, and Cases C/E are genuinely "both written, plan missing".

## 5. Explicit trade-offs

| criterion | A (in-tool) | B (root) |
|---|---|---|
| smallest semantic change | **yes** — one sequential call in an existing function | no — new orchestration seam + two roots |
| authority clarity | clear: the tool that declares the state also commits it | ambiguous: root commits state the tool declared |
| ordering clarity | **explicit and sequential** | depends on handler registration order — not a contract |
| failure containment | contained: one failure mode (tool error) already understood | new failure surface at the root; failure after the tool already returned is harder to attribute |
| session safety | **fails** — inherits the `todoSession` global; MCP pins one id | **best** — root can hold per-session stores |
| testability | easy: drive `todoWriteTool.execute` | harder: requires the whole root lifecycle |
| dependency direction | adds tools → storage | adds root → storage (root already orchestrates) |
| consistency with current lifecycle | **yes** — mirrors the proven JSON rule exactly | diverges: adds a post-return step |
| speculative architecture | **low** | moderate — a seam that exists only for this write |
| future TaskGraph/Scheduler | acceptable — a scheduler would still need an allocation policy, not this write | slightly better positioned, since the root already owns lifecycles |

**A's one serious defect is session safety; B's one serious defect is ordering.**
Neither is dominant.

## 6. Chosen forward architecture

**Option A, fail-closed, extended to both write sites, with an explicit session
guard — and with the session guard treated as a prerequisite, not an
afterthought.**

Shape:

1. Inside `todoWriteTool.execute`, after `normalizeTodos` and after `saveTodos`,
   call the Phase 3A identity layer against a `TaskStore` for the resolved cwd,
   then let the tool return. A `TaskError` propagates as a tool error, which
   already suppresses plan publication.
2. Do the same in `reconcileCompletionEvidence` (`todo.ts:269`), so the
   post-verify path cannot diverge.
3. **Prerequisite:** do not write under the bare `todoSession.id` in MCP mode.
   Either scope the store by the request-scoped identity, or explicitly accept
   and document the shared-id limitation before enabling the write.

Chosen because: it is the smallest semantic change, it reuses the single ordering
rule that is actually proven, it needs no new abstraction, and it makes
TaskStore failure fail *closed* — which is the only behaviour consistent with
"TaskStore is authoritative for durable task identity".

B was rejected on ordering: making plan correctness depend on the relative
registration order of two independent `execution:completed` subscribers is a
latent defect, and because 3B degrades to positional identity rather than
failing, such a defect would be silent.

## 7. Why this is NEW ARCHITECTURE, not recovery

- The symbol that supposedly performed the write (`saveTodoStore`) exists in no
  source and no artifact.
- The method that certainly existed (`synchronizeTasks`) has **no caller in any
  surviving file**, and its own docstring names no owner.
- The only document naming an owner is contradicted by shipped code on storage
  location, on the read path, on the API shape, and on `stepId`.
- The chosen placement (in-tool, after JSON) is a *choice* among three
  unexcluded candidates, justified by invariant 1 and by reusing the proven
  ordering rule. No evidence places the historical write there.

Any future implementation must be labelled **NEW ARCHITECTURE**, with this
document as its rationale, and must not be described as recovering
`synchronizeTasks` wiring.

## 8. Exact implementation boundary

Would touch, and nothing else:

- `src/tools/todo.ts` — the sync call in `execute` and in
  `reconcileCompletionEvidence`.
- a new small module owning "resolve store for this cwd + session", since the
  tool must not construct a `TaskStore` per call (handle caching is module-level
  in `store.ts`, so a per-call `new TaskStore(cwd)` is actually safe — verify
  this before relying on it).
- `src/mcp/server.ts` — only if the session guard is implemented.

Would **not** touch: `src/task/store.ts`, `src/task/identity.ts`,
`src/task/model.ts` (all complete and mutation-tested), `src/presentation/**`
(the 3B seam already consumes identity), and no execution-loop code.

## 9. Exact behaviour that remains unknown

1. Whether the pre-wipe write ran before or after the JSON write.
2. Whether the post-verify path wrote to TaskStore.
3. Whether a TaskStore failure historically suppressed the plan, or was swallowed
   fail-open like journal appends.
4. Whether MCP ever wrote to the store, and under which session id.
5. Replay/retry semantics (Case G) after a partial write.
6. Crash behaviour (Case F) between the JSON rename and the SQLite commit.
7. Whether the historical design intended the JSON file to become a derived
   export (the superseded plan says yes; Phase 2 evidence says the JSON was still
   the source at pre-wipe time).

## 10. Tests required before/with implementation

- declared payload reaches TaskStore; ids match `store.listTasks`
- canonical `taskId` preserved; no second allocator (`nextId` continues the sequence)
- session isolation: two sessions in one store never share ids
- **MCP-style shared-id case**, or an explicit documented opt-out
- duplicate identity rejected before any mutation
- TaskStore failure → tool error → **no** `plan.updated` emitted
- JSON success + TaskStore failure → divergence is detected/asserted, not silent
- ordering: TaskStore write is observable before the plan event
- no positional allocator reintroduced
- both write sites covered (`todo_write` and post-verify reconcile)
- Case G replay: a repeated identical declaration does not allocate a new id
- mutation: remove the sync call; make it best-effort; make it positional;
  suppress failure; write before JSON instead of after

## 11. Migration / compatibility implications

- **Existing JSON files are unaffected.** Phase 2's canonical+legacy read path
  keeps working; TaskStore starts empty and fills on the next `todo_write`.
- **First write after upgrade is a full-replace-shaped sync.** The artifact's
  LEGACY mode matched by position; Phase 3A instead treats an id-less item as a
  new task. These differ, so the first sync will allocate fresh ids for existing
  JSON tasks. This is a **real behavioural difference that must be decided
  explicitly**, not inherited silently.
- **Plan output changes** only once a `taskIdentityProvider` is injected:
  `payloadVersion: 2` appears and `taskId` becomes present. Without injection
  plans stay positional (3B default).
- **A pre-existing `.minicode/tasks.db`** (if any workspace has one) is
  authoritative and must not be clobbered by a first-sync policy.
- **No ACP, schema, or UI contract change** follows from this decision.

**NOT BEGINNING PHASE 3C-2. No commit created; working tree left CLEAN.**
