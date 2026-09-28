# PHASE 4A.4B — TODO SESSION ISOLATION / CONCURRENCY HARDENING REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `05cf247` · Commit message: `fix: isolate todo session context`

**NEW ARCHITECTURE.** A production correctness fix, not a recovery.

---

## 1. Current race (forensic)

`todoSession` is a process-level singleton. The write path read it **after an
`await`**. Verified at `05cf247`:

| line | read | safe? |
|---|---|---|
| 432 | `saveTodos(todoSession.id, …)` | yes — read before suspension |
| 453 | `sessionId: todoSession.id` (TaskStore) | **RACE** |
| 475 | `savePlanSnapshot(todoSession.id, …)` | **RACE** |
| 484 | `encodeCanonicalAssignments(todoSession.id, …)` | **RACE** |
| 495 | `loadTodos(todoSession.id, …)` (`todo_read`) | read at call time, but the same pattern |

I reproduced the defect against a clean worktree at `05cf247` rather than
asserting it. Two outcomes, both real:

**(a) A misleading error.** When the hijacking session lacked the declared id:

```
TaskError: canonical task sync failed (declared unknown task t1)
```

The payload was valid. The operation looked `t1` up in the *wrong* namespace.

**(b) Silent corruption.** When the hijacking session happened to own a `t1`:

```
threw?                : false
rows in sess-A        : ["A"]
rows in other-session : ["A","brand-new"]
assignment stamped as: other-session
VERDICT               : SILENTLY WROTE INTO THE OTHER SESSION
```

The tool reported **success**. The JSON went to the right file (its read was
pre-`await`) while TaskStore, the plan snapshot and the assignment stamp went to
another session — leaving the two stores permanently divergent with no error
raised anywhere.

## 2. Actual call path

```
MCP: serveMcp -> mcpContextId = newMcpContextId()   (4A.3, per instance)
             -> applyMcpContext(mcpContextId, root)  (global, for legacy consumers)
             -> per request: invokeTool(..., contextId, ...)
                            -> builds ctx { signal, state, emit, cwd: root, sessionId: contextId }
                            -> tool.execute(args, ctx)

todo_write.execute:
  ctx.signal.throwIfAborted()
  const { sessionId, cwd } = todoOperationContext(ctx)   <-- SINGLE CAPTURE
  await saveTodos(sessionId, list, cwd)
  synchronizeCanonicalTasks({ sessionId, … })            // captured
  await savePlanSnapshot(sessionId, list, cwd)           // captured
  encodeCanonicalAssignments(sessionId, assignment)      // captured
```

## 3. Operation-context design

`todoOperationContext(ctx)` returns an immutable `{ sessionId, cwd }` snapshot,
resolved once at entry:

```
sessionId: ctx.sessionId → todoSession.id
cwd:       ctx.cwd       → todoSession.cwd → process.cwd()
```

Deliberately **not** a new abstraction:

- It reuses `ToolContext`, which MCP already builds **fresh per request**.
- It adds no global. `todoSession` stays the composition-root *default*
  (`cli/setup.ts:923` binds it once at startup) and is now read exactly once per
  operation.
- `ctx` preference is preserved from the original code, which already preferred
  `ctx.cwd` over the global.
- The JSON-RPC id is never used as task identity.
- MCP's namespace is threaded as an explicit **parameter** through
  `invokeTool(…, contextId, …)`, not read from a global at request time.

## 4. CLI behavior

No regression. `presentationSessionId = resumeId ?? sessionId` is untouched in
`cli/setup.ts`; the CLI simply falls through to the `todoSession` default, which
is bound once before any tool runs. Test **I** runs the exact pre-4A.4B CLI shape
(no `sessionId` on ctx) and passes. Test **H2** proves ctx wins over the global and
that an empty string is not accepted as a session id.

## 5. MCP behavior

Namespace semantics unchanged — same `newMcpContextId()` per instance, same
`applyMcpContext`, same fail-closed refusal of `"mcp-server"`. The only change is
that the id is *also* carried on each request's ctx, so the todo path no longer
depends on the global surviving an `await`.

Test **K** drives the **real server over stdio** and asserts the bytes land in a
`mcp:<uuid>` namespace, not `mcp-server.json`. That test exists because of
mutation M4 (see §11).

## 6. JSON isolation

One file per session, each stamped with its own id:
`.minicode/todos/cli-A.json` holds `sessionId: "cli-A"`,
`cli-B.json` holds `sessionId: "cli-B"`, and neither contains the other's items
(tests **A**, **K**). `todo_read` observes only its own operation's session
(test **D**).

## 7. TaskStore isolation

Unchanged behaviour; the fix only ensures the right `session_id` reaches it.
Tests **A**/**B** assert `listTasks("cli-B")` is empty in A's store and vice
versa, and that the hijacking namespace is never written.

## 8. Assignment isolation

The 4A.4A channel is reused unchanged — no second mechanism. Each operation's
assignment decodes under its own session and is refused under the other's
(tests **A**, **B**, **G**, **G2**).

## 9. Failure behavior

- **A throws, B succeeds** (test **G**): A's unknown-id rejection leaves B's
  namespace, data and assignment fully intact; A's transaction rolls back so it
  gains no new row.
- **A aborts, B continues** (test **G2**): the abort leaves no JSON for A's
  session and does not disturb B.
- Neither path can mutate another operation's session identity, because the
  identity is a captured local, not shared state.

## 10. Tests

`test/phase4a4b-session-isolation.test.ts` — **10 tests, 59 assertions.**

C session stable across await (**the core test**) · A concurrent, different
sessions · B concurrent MCP contexts · D read isolation · G failure isolation ·
G2 abort isolation · H global never consulted · H2 snapshot semantics ·
I single-operation unchanged · K real-server MCP wiring.

Test **C** is the one that matters: it starts the operation, rebinds the global
while it is suspended, and asserts it still wrote to its own session. It fails on
`05cf247` and passes here.

## 11. Mutation results — 7/7 killed, 0 survived, 0 needle miss

| # | mutant | result | killed by |
|---|---|---|---|
| M1 | restore the global read at the sync point | KILLED | C |
| M2 | move the session lookup after the first await | KILLED | C |
| M3 | ignore ctx, always use the global | KILLED | A |
| M4 | MCP threads the journal key as the task namespace | KILLED | K |
| M5 | hardcode one fixed session | KILLED | C |
| M6 | stamp the assignment with the global | KILLED | C |
| M7 | regress the read path to the global | KILLED | D |

**M4's survival found a real hole in my own tests.** My test B called
`todoWriteTool.execute` directly, which proves the tool *honours* a per-request
session but not that the server *puts one there* — so the mutant survived. The
fix was a new test (K) that drives the real server, not a weakened claim.

I also had to fix a harness bug: `server.ts` carries CRLF while a file edited in
place is LF, so a multi-line needle written with `\n` never matched. The harness
is now line-ending tolerant. Reporting it because a silent needle miss reads
exactly like a survivor.

## 12. Validation

| check | result |
|---|---|
| PARSE | **VERIFIED** — 5 sources |
| RUNTIME (new suite) | **VERIFIED** — 10/10, 59 assertions |
| RUNTIME (focused, 8 phase files) | **VERIFIED** — 99 pass / 0 fail / 949 assertions |
| RUNTIME (MCP + adjacent) | **VERIFIED** — 79 pass / 0 fail |
| RUNTIME (broad, 20 files) | **VERIFIED** — 476 pass / 2 fail, **identical to a clean `05cf247` baseline worktree** |
| MUTATION | **VERIFIED** — 7/7 killed |
| TYPECHECK | **DEFERRED** — `node_modules` absent |
| FULL SUITE | **DEFERRED** |

### A regression I introduced and caught

My first `server.ts` edit referenced `mcpContextId` inside `invokeTool`, which is a
**different function** from `serveMcp`. Result: `[error] mcpContextId is not
defined` on **every** MCP tool call — 9 MCP tests failed where the baseline
passed 37/37.

It survived `Bun.Transpiler` (which parses but does not resolve identifiers) and
my own unit tests (which never go through the server). Only the MCP integration
suite caught it. I bisected it to a single file, fixed it by threading the id as
an explicit parameter, and confirmed 37/37.

**This is the concrete cost of `TYPECHECK = DEFERRED`**, and the reason the broad
sweep was worth running rather than trusting the focused one.

## 13. Files changed

| file | change |
|---|---|
| `src/tools/todo.ts` | `todoOperationContext`; both todo tools bind once at entry |
| `src/mcp/server.ts` | capture the 4A.3 id; thread it into `invokeTool`; put it on the per-request ctx |
| `test/phase4a4b-session-isolation.test.ts` | **new** — 10 tests |

`src/task/*` and `src/presentation/adapter.ts` unchanged: the assignment mechanism
and TaskStore are untouched, as required.

## 14. Commit

`fix: isolate todo session context`. SHA not self-cited — committing this report
changes it. Verify with `git log -1 --pretty=format:'%h %s'`. Tree CLEAN after
commit. **Not pushed.**

## 15. Explicit non-scope

Not done, per the stop condition: 4A.5 all-id-less rejection, bootstrap, migration,
deletion semantics, MCP namespace redesign, new protocol fields, TaskGraph,
Scheduler, new transaction API, new identity allocator, TaskStore changes,
restart/reorder/crash E2E.

**Left open, deliberately:** `src/tools/task.ts:226` also reads
`todoSession.id`. It reads **before** its first `await` (line 228), so it is not
racy today, and task semantics were explicitly out of scope — but it is the same
singleton and deserves the same treatment in a later phase.
