# PHASE 4A.3 — MCP NAMESPACE IMPLEMENTATION REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `1ab0b11`
Commit message: `feat: isolate MCP task namespaces`

**NEW ARCHITECTURE** — the per-instance namespace did not exist in the
recovered code.

---

## 1. Existing MCP namespace behavior

`src/mcp/server.ts` set `todoSession.id = "mcp-server"` once, at server
construction, for the whole process. As a durable task namespace that is
unsafe: it is a **constant**, so every MCP context that ever ran against the
same `root` shares one identity space. `TASK_ARCHITECTURE_AUDIT.md` had already
flagged the underlying problem — `mcp serve` is single-tenant and concurrent
requests overwrite each other last-writer-wins.

## 2. Actual MCP lifecycle evidence

Everything below was read from the current source, not assumed:

| finding | evidence |
|---|---|
| `initialize` is a **stateless reply** — it issues no session id and stores nothing | `case "initialize":` replies and returns |
| there is **no client identity** anywhere in the protocol surface | no `clientInfo` read; `initialize` params are ignored |
| the only request identity is the **client-supplied JSON-RPC id** | `const idKey = \`req:${JSON.stringify(msg.id)}\`` |
| request ids are **not** stable logical identity — the code says so itself | *"client reconnect resets seq"*; same id + different args is a **new** operation |
| the server is **single-tenant by design** | `JOURNAL_SESSION`, and the todoSession comment scoping to the server session "P2 isolation" |
| `randomUUID` is already the repo's id convention | imported at L1, used for `toolCall.id` |

**Consequence:** a per-request id is wrong (it is not a context), and a
per-client id does not exist to use. One context per **server instance** is the
smallest identity the evidence supports.

## 3. Chosen context identity

`newMcpContextId()` → `` `mcp:${randomUUID()}` `` — one per `serveMcp`
invocation, installed by `applyMcpContext(contextId, root)`.

`applyMcpContext` was extracted from `serveMcp` so the **production wiring is
testable**: `serveMcp` requires a live stdin transport and cannot run in a unit
test, and a factory-only test would prove nothing about what actually gets
installed.

The `mcp:` prefix guarantees the value can never equal a legacy `mcp-server`
row nor be confused with a CLI `presentationSessionId`, and is greppable.

## 4. Generation mechanism

`randomUUID()` from `node:crypto` — already imported and already used in this
file. No new mechanism, no new module, no new global. The factory is a pure
function with **no module state** (test I pins that). It is **not** a TaskStore
allocator: it emits a *context* namespace, never a `taskId`.

## 5. Stability semantics

| situation | context |
|---|---|
| many requests in one context | **SAME** — the id is captured once at construction and reused |
| read after write | **SAME** |
| concurrent requests, same server | **SAME** — and that is *correct*: they are one agent with one todo list |
| reconnect to the same process | **SAME** |
| **process restart** | **NEW** — no mechanism persists the id, so prior tasks are left on disk and unreachable |
| MCP resume | not supported by this implementation (`initialize` is stateless) |

**Persistence across restart is explicitly NOT claimed** — there is no mechanism
storing this id. Nothing is deleted to hide the consequence.

## 6. Concurrency semantics

No new process-global mutation was introduced: `todoSession.id` was already a
process global, and its value changed from a shared literal to a per-instance
unique id at the same point in the lifecycle as before. Test C confirms 100
concurrently-created contexts are all distinct.

Intra-process client multiplexing is **not** isolated — because this MCP
implementation exposes no client identity to distinguish clients by. That is a
recorded limitation, not a solved problem, and not assumed away.

## 7. Legacy namespace behavior

**Provably empty, so nothing is reinterpreted.** `git grep` over `src`+`cli`
returns **zero** production imports of `task/store.ts`, so no `mcp-server` row
was ever written by this codebase. Test H proves it at runtime against real
SQLite rather than asserting it in prose. No migration is defined or needed.

## 8. Failure behavior

`applyMcpContext` **fails closed**: an empty or legacy-literal namespace throws
`mcp: refusing to serve without a unique task namespace`, and the globals are
left untouched. There is **no silent fallback to `"mcp-server"`** — test K pins
both halves. Generation cannot fail, since it is `randomUUID()` with no input.

## 9. Tests

`test/phase4a3-mcp-namespace.test.ts` — **11 tests, 478 assertions, 0 fail.**

A 200 distinct contexts · B reuse across requests · C 100 concurrent distinct ·
D independent of content · E independent of ordinal/count · F never
`mcp-server`/`default`, always prefixed · G TaskStore isolation by `session_id`
and cwd · H legacy namespace provably empty · I no module state · **J the
production wiring** installs and restores · **K fail-closed, no fallback**.

Plus an updated integration test in `test/mcp-server.test.ts` that spawns **two
servers over the same directory** and asserts two distinct `mcp-*` todo files.

### Two findings from the integration level

1. **An existing test asserted the defect.** `mcp-server: todo ter-skup
   mcp-server` asserted `.minicode/todos/mcp-server.json` exists. That is
   literally the unsafe shared namespace. It was **updated, not weakened** — it
   now additionally asserts the name is `mcp-*`, is *not* `mcp-server.json`, and
   that a second server over the same directory yields a *different* file.
2. **`:` does not survive the addressing layer.** The in-memory id is
   `mcp:<uuid>`, but the on-disk todo filename is `mcp-<uuid>.json` — Phase 2's
   `sanitizeSessionPart` maps non-`[A-Za-z0-9._-]` to `-`. My first assertion
   expected `mcp:` on disk and failed. Recorded because the two stores key on
   **different representations** of the same context (TaskStore keeps the raw
   `session_id`; the JSON file uses the sanitized stem).

## 10. Mutation results

Run against `src/mcp/server.ts`, global replacement, pristine bytes restored and
**SHA-verified** per mutant.

| # | mutant | result |
|---|---|---|
| N1 | restore the shared literal `mcp-server` | **KILLED** (A) |
| N2 | one global context for every instance (module-scope const) | **KILLED** (A) |
| N3 | context from a taskId-like counter | **KILLED** (A) |
| N4 | context derived from todo content | **KILLED** (A) |
| N5 | prefix removed | **KILLED** (B) |
| N6 | fail-closed guard removed | **KILLED** (K) |
| N7 | wiring reverted to the literal | **KILLED** (J) |
| N8 | previous globals not captured | **KILLED** (J) |

```
killed=8  survived=0  needle-misses=0
```

**Both first-run survivors were my own defects, not equivalent mutants:**
N2's replacement put the "shared" const *inside* the function, so it re-evaluated
each call and never became a global; N8 survived because test J's prior id was
the default `"default"`, so a hardcoded `prevId = "default"` matched by
coincidence. J now sets a non-default prior id, and N2 hoists to module scope.

## 11. Validation status

| check | result |
|---|---|
| PARSE | **VERIFIED** — `Bun.Transpiler` on `src/mcp/server.ts` |
| RUNTIME (new) | **VERIFIED** — 11/11, 478 assertions |
| RUNTIME (regression) | **VERIFIED** — 191 pass / 0 fail / 1 skip across 13 files |
| MUTATION | **VERIFIED** — 8/8 killed |
| TYPECHECK | **DEFERRED** — `node_modules` absent; install not authorised |
| FULL SUITE | **DEFERRED** — 200+ files not run; no broader health inferred |

The single skip is the pre-existing known-bad duplication regression.

## 12. Files changed

| file | change |
|---|---|
| `src/mcp/server.ts` | modified — `newMcpContextId()`, `applyMcpContext()`, construction now uses them; `JOURNAL_SESSION` deliberately unchanged |
| `test/phase4a3-mcp-namespace.test.ts` | **new** |
| `test/mcp-server.test.ts` | modified — one assertion block updated (see §9) |
| `PHASE-4A.3-MCP-NAMESPACE-IMPLEMENTATION-REPORT.md` | **new** |

Verified **unchanged** by hash: `src/tools/todo.ts`, `src/presentation/adapter.ts`,
`src/presentation/events.ts`, `src/task/store.ts`, `src/task/model.ts`,
`src/task/identity.ts`, `cli/setup.ts`.

Added lines contain **no** reference to `createTask`, `patchTask`, `nextId`,
`synchronizeIdentities`, `applyTaskIdentities`, `migrated:`, `bootstrap`,
`manifest`, `db.transaction`, `withTransaction`, `TaskGraph`, `Scheduler`, or any
destructive filesystem primitive.

## 13. Commit

`feat: isolate MCP task namespaces`. SHA not self-cited — committing this report
changes it. Verify with `git log -1 --pretty=format:'%h %s'`.
Working tree **CLEAN** after commit. Not pushed. Specimen untouched.

## 14. Explicit non-scope

This phase selected a namespace and nothing else. It did **not** implement:

- task creation, identity allocation, or any TaskStore write (TaskStore still has
  **zero** production consumers)
- todo synchronization, bootstrap/adoption, or the identity manifest
- the transaction API (untouched)
- `todo.ts`, `adapter.ts`, `events.ts` (byte-identical to `1ab0b11`)
- deletion semantics, all-id-less rejection
- MCP journal keying (`JOURNAL_SESSION` unchanged — an internal per-process
  record, deliberately not the durable namespace)
- TaskGraph, Scheduler, plan-pipeline or execution-loop changes

**Remaining limitation:** intra-process client multiplexing is not isolated,
because this MCP implementation has no client identity to key on. The identity
contract is still **BLOCKED** on the semantic (all-id-less), adoption, and
transaction-integration questions, and the `debc295` duplication defect is
untouched and still reproduces.
