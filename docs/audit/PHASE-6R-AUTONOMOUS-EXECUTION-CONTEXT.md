# PHASE 6R — AUTONOMOUS EXECUTION CONTEXT

Baseline: **`bef6cf2`** (`feat: harden session deletion and execution lifetime`) · tree CLEAN · 43 ahead · nothing pushed.

**No production file was modified.** Two new modules and one test file. `scheduler.ts`, `store.ts`, `persistence.ts`, `model.ts`, `readiness.ts`, `graph.ts`, `tools/task.ts` and `app/session.ts` are all **byte-identical** to `bef6cf2`. Production Scheduler construction count: **0**.

Labels: `[FACT]` · `[OBSERVATION]` · `[INFERENCE]` · `[DESIGN DECISION]`.

---

## 1. Current turn architecture

`[FACT]` Scope map, reconstructed from source:

| Object | Scope | Consequence for an autonomous turn |
|---|---|---|
| `sessionId` | per `Session` | a child needs its own |
| conversation history (`ContextStore`) | per `Session` | **merged** into on every `run()` (`session.ts:245`) |
| busy slot (`impl.running`) | per `Session` | `throw AgentError("busy")` (`:216`) |
| abort (`sessionAbort`) | per `Session` | `abort()` kills whatever runs (`:257-259`) |
| `turnCount` / `stepCount` | per `Session` | inflated by autonomous work (`:246-247`) |
| event bus | per `Session` | feeds the interactive presentation |
| `TaskStore` rows | per `session_id` | the task is the **parent's** row |
| `ToolContext` (`tool.ts:22`) | `{signal, state, cwd?, permissionMode?, emit}` | **carries no session identity at all** |
| tool set | per session, fixed at creation | the real lever for isolation |
| `cwd`, provider, model | per `SessionConfig` | supplied explicitly |
| `session-ownership` token | **process**-local map | one owner per session id per process |

`[INFERENCE]` The load-bearing observation: `ToolContext` has **no** session identity field.
Isolation therefore cannot come from a tool's context — it must come from the *session object*
and the *tool set* the context is built with. That shaped the whole design.

---

## 2. Autonomous context design

`[DESIGN DECISION]` `AutonomousExecutionContext` in `src/task/autonomous-context.ts`.
Lifecycle: `created → initializing → ready → executing → settled → disposed`, with
`dispose()` idempotent and callable from any state.

`[FACT]` Answers to the required questions:

| Question | Answer |
|---|---|
| which session id? | the **parent** for tasks; a derived **child** for the conversation |
| which task id? | the parent's task, unchanged — never re-minted |
| which incarnation? | the parent's, captured at claim (6Q) |
| who owns it? | whoever constructed it; it holds no global state |
| how destroyed? | `dispose()` — abort own controller, abort child, `cleanup()` |
| two contexts coexist? | **yes** — G1 proves it |
| can a user turn see it? | no — separate session, no shared history/bus |
| can it mutate the user conversation? | no — the child's `ContextStore` starts empty |
| can it mutate another namespace? | no — A4/E2 fail closed |

### The central separation

`[DESIGN DECISION]` Two deliberately different namespaces:

- **TASK namespace = PARENT session.** The task being executed *is* a parent row, and every 6P/6Q
  invariant (ownership, lineage, incarnation) is expressed in those terms. Moving it would
  relocate the task and break them.
- **CONVERSATION namespace = CHILD session id.** History, busy slot, abort, event bus and
  counters all belong to it, so an autonomous turn shares **none** of them with the user.

`[INFERENCE]` A context that conflated these would either pollute the user's conversation or
lose track of which task it is executing.

---

## 3. Child session architecture

`[FACT]` The id is **derived, never allocated**:

```
auto~<parentSessionId>~<taskId>~<execGeneration>
```

`[FACT]` Production session ids are 8 hex chars (`cli/commands/acp.ts:334`,
`randomUUID().slice(0,8)`). A2 proves the autonomous shape can never collide with one, and that
different parent/task/generation triples give different ids.

`[DESIGN DECISION]` Reused the existing `SubAgentSession` structural seam
(`src/tools/task.ts:68-77`) so 6R did not become a second session system, and reused the
`SubAgentSessionFactory` DI pattern rather than importing `createMinicodeSession` directly.

`[INFERENCE]` Derived identity means two contexts for the same work are *literally the same
identity* (A3) — they cannot silently diverge, and there is nothing to allocate, leak, or free.

---

## 4. Parent/child relationship

`[DESIGN DECISION]` **Metadata only** — `parentSessionId` is passed to the factory for journal
wiring, exactly as `delegate_task` does (`task.ts:283`). No parent-child schema was added.

`[FACT]` Both required safety properties hold:

- *"Destroying the parent invalidates future autonomous work"* — the incarnation bump
  (6Q) refuses every late write, proven cross-process (P5) and by F2.
- *"Destroying a child never mutates the parent"* — a child owns only its own session object,
  its own AbortController and a tool set; it holds no reference to the parent session.

---

## 5. Busy isolation

`[FACT]` The kernel's busy slot is per `Session` **object** (`session.ts:216`), and the child is a
different object. C1 runs a concurrent "user turn" and an autonomous turn in one process and both
complete. U4: two concurrent autonomous contexts run in parallel (G1) with distinct identities,
attributions and disposal.

`[INFERENCE]` No lock was added. The busy collision 6N identified disappears because the two
turns no longer share a slot — which is the requirement, satisfied structurally rather than with
a mutex.

---

## 6. Abort isolation

`[FACT]` The context owns a private `AbortController` and passes it as `run(..., {signal})`.
`cancel()` fires it **and** the child's own `abort()`. C2 proves that cancelling a context leaves
an unrelated `AbortController` **unaborted**. C3 (cancel before start), C5 (a turn that resolves
*after* cancellation is reported `cancelled`, not success) and C4 (repeat cancel + repeat dispose
safe) complete the matrix.

`[INFERENCE]` Parent session deletion does not abort unrelated sessions: the context holds no
parent abort, and deletion is a durable fact rather than a signal.

---

## 7. ToolContext / permission boundary

`[DESIGN DECISION]` 6O ADR-7's read-only policy is enforced **structurally**, not by
convention:

- `AUTONOMOUS_TOOL_NAMES` — 12 read/search/reason tools, a subset of `EXPLORE_TOOL_NAMES`.
- `assertAutonomousToolScope()` **throws** on anything wider, and is called in **two** places:
  the adapter (construction) *and* `AutonomousExecutionContext.initialize()`.
- `permissionMode` is **fixed to `readonly`** in the factory spec and is never read from the
  interactive session, so a human changing permissions mid-session cannot widen an unattended
  executor (B4; M5).

`[FACT]` B1/B2/B3 assert the gate; **I1** proves it fires on a context built *directly*, without
the adapter. B5 proves a wider tool set is refused at adapter construction. M4/M5 confirm both
are load-bearing.

`[INFERENCE]` Because the kernel's `PermissionHandler` returns only `allow`/`deny` and expects an
approving handler to **block** (`permission.ts:12`), an unattended executor that could write
would have to either hang or be auto-approved. Restricting the tool set means the question never
arises. No `DEFER` state was added — that is 6S.

---

## 8. Task namespace

`[FACT]` E1: the child conversation id is **never** used as a task namespace — `getTask(childId,
t1)` is `null` and `listTasks(childId)` is empty. E2 and process **P2** prove the same `t1` in two
sessions stays two independent rows with independent ownership.

`[INFERENCE]` Canonical `taskId` and incarnation semantics are reused unchanged; no identity logic
was duplicated (§9 forbids it).

---

## 9. Context / memory boundary

`[FACT]` I4 asserts the system prompt contains the autonomy notice, the workspace, the task title
and the instruction — and **none** of: `conversation`, `history`, `previous user`, `earlier turn`,
`user said`, `parent`. B6 asserts the turn input carries the instruction.

`[INFERENCE]` "Child session" genuinely means an empty conversation: the child's
`ContextStore` starts empty, and the parent history is never loaded, summarised, or referenced.
This is the §10 requirement — minimum sufficient context, not a copy of the conversation.

---

## 10. cwd / environment / provider

`[DESIGN DECISION]` `cwdFor(sessionId)` is **required** and never defaulted. I3 asserts the
factory receives the task's workspace and that it is *not* `process.cwd()` (M8 killed). A silent
`process.cwd()` fallback is exactly how an executor ends up in the wrong project, so the adapter
refuses to plan without it.

`[FACT]` Provider and model are passed through the spec, sourced from the adapter config, and are
per-context rather than global. `[INFERENCE]` No provider redesign; determinism comes from the
context pinning them explicitly per execution.

---

## 11. Events / presentation

`[DESIGN DECISION]` Context events are **child-scoped and buffered to the context's own sink**.
Nothing is forwarded to the parent's presentation. I5 asserts every emitted event names the child
session and never the parent, and that the config type exposes **no** parent-presentation sink at
all.

`[INFERENCE]` This follows 6O §15 ("forward nothing by default"): an autonomous turn has no
watching user, and forwarding would inject unsolicited content into a live TUI. The user learns
the outcome through the **task row**, the durable and already-rendered surface.

---

## 12. Autonomous turn contract

`[FACT]` `AutonomousOutcome` distinguishes `returned | error | cancelled | session-superseded |
task-superseded | permission-denied`. D1–D3 cover normal, error, and the mapping onto the
Scheduler's `ExecutionObservation`. **D3 asserts cancellation is never mapped to a successful
return**, and M11 (a late execution reported as success) is killed.

`[DESIGN DECISION]` Everything is a **return value**. An unattended executor has no one to throw
to, so a throw would kill the process or be swallowed into a false "the model failed". A
planning refusal *does* throw, which the Scheduler correctly classifies as a dispatch failure
(D4) — an execution that was never planned must not be recorded as an attempt that happened.

---

## 13. Scheduler adapter

`[FACT]` `buildAutonomousRunTurn()` returns the `runTurn` the Scheduler already takes. It holds no
Scheduler state and creates no global state. F1 proves a full Scheduler → adapter → context
execution records lineage correctly and **does not** fabricate `COMPLETED`.

`[DESIGN DECISION]` Nothing constructs a `Scheduler`, and nothing here is called from production
startup. The construction count remains 0.

---

## 14. Session-deletion regression (6Q)

`[FACT]` F2 re-runs the 6Q scenario through the adapter: the parent session is deleted during an
autonomous turn; the cycle returns `SESSION_SUPERSEDED`, the claim is released, the instance
disposes, and no task is resurrected. 6Q's 23 tests and 6P's 31 tests pass unchanged
(`354 pass / 0 fail` across the 6R+6Q+6P+Scheduler+task suites).

`[INFERENCE]` 6Q needed no change. The new context did not prove a dependency on it.

---

## 15. Concurrent contexts

`[FACT]` G1: two contexts with distinct child ids run concurrently via `Promise.all`; cancelling
and disposing one leaves the other running to completion; each event set is attributed to its own
child; each disposes exactly its own session.

---

## 16. Process boundary

`[FACT]` Genuine `bun` processes, one `tasks.db`:

| Case | Result |
|---|---|
| P1 | PASS — the task is observed in the **parent** namespace from another process |
| P2 | PASS — two sessions, same `t1`, independent rows and ownership, no cross-talk |
| P4/P5 | PASS — parent deleted then recreated (incarnation 1→2), the **old** child is refused, recreated title intact and `attempt_generation` still `null` |

---

## 17. Failure injection

`[FACT]` H2 injects a factory failure: `execute()` rejects, the context disposes, and a disposed
context **refuses to run again** rather than silently re-creating. F3 proves disposal happens on
the **error** path (M10 killed). C1–C4 in the 6Q suite still cover the deletion-stage faults, and
dispose itself is proven unable to throw (its `abort`/`cleanup` calls are individually guarded).

`[INFERENCE]` The disposal path cannot leak *because* it cannot fail: every release is guarded and
idempotent, and H1 shows 20/20 contexts fully released.

---

## 18. Resources

`[FACT]` H1: 20 contexts constructed, executed and disposed → 20 sessions built, 20 aborted,
20 cleaned, every context `disposed`. The context owns exactly: one child session, one
`AbortController`, one tool set reference, one event sink. No timers, no intervals, no DB handle
of its own, no background work.

`[DESIGN DECISION]` The context is not a daemon and starts no loop; `execute()` is called by
whoever dispatches, so idle cost is zero.

---

## 19. Mutation results

`[FACT]` 12 mutants, **10 killed, 0 real gaps remaining**, sources restored byte-identical.

| ID | Mutant | Result |
|---|---|---|
| M1 | child reuses the parent session id | KILLED |
| M2 | child identity dropped | KILLED |
| M3 | shares the parent's `AbortController` | **EQUIVALENT** — see below |
| M4 | tool-scope gate removed | KILLED (by I1) |
| M5 | inherits the interactive permission mode | KILLED |
| M6 | routes events to the parent presentation | **EQUIVALENT** — see below |
| M7 | session incarnation not carried | KILLED (by I2) |
| M8 | cwd falls back to `process.cwd()` | KILLED (by I3) |
| M9 | dispose does not abort the child | KILLED |
| M10 | dispose does not clean up the child | KILLED |
| M11 | late execution reported as success | KILLED |
| M12 | turn inherits interactive context | KILLED (by I4) |

`[DESIGN DECISION]` **The first run produced 4 real gaps and 2 no-op mutants.** M4, M7, M8 and M12
were **REAL/HARNESS GAPS** — the properties were true but unobserved, because the adapter-level
tool gate masked the missing context-level one, and every test used incarnation 1 and never
asserted cwd or prompt contents. They were closed by adding **I1–I4**: new assertions, none
weakened. M3 and M6 are classified **EQUIVALENT**: my mutants referenced fields that do not
exist (`globalThis.__parentAbort`, `config.parentPresentation`), so they were no-ops rather than
real variants. The underlying properties are covered by C2 and I5 respectively.

---

## 20. Property / state-machine results

`[FACT]` 250 seeds (`60601…60850`), 8 operation kinds, **547 assertions, 0 violations**:

`P1_UNIQUE_IDENTITY` · `P2_ABORT_ISOLATED` · `P4_NAMESPACE` · `P5_INCARNATION` ·
`P6_NO_CROSS_INCARNATION` · `P9_NO_COMPLETION` · `P10_DISPOSED` · `P11_OWNERSHIP`

`[DESIGN DECISION]` P6 first reported 5 violations, and they were a **harness bug**: the check
paired an execution from one session with a task from another and asserted a write should be
refused even when the incarnation had not moved — in which case recording is *correct*. The
property was rewritten to assert the real precondition (refusal **only** when the incarnation
moved), which is what 6Q actually guarantees.

---

## 21. Security audit

`[FACT]` Every negative case fails closed:

| Attempt | Result |
|---|---|
| wrong session id | `AutonomousContextError` (A4) |
| wrong incarnation | `AutonomousContextError` (A4) |
| non-autonomous child id | refused (A5) |
| incomplete durable binding (gen 0 / inc 0 / empty parent) | adapter refuses to plan (D4) |
| wider tool set | refused at adapter **and** context (B5, I1) |
| cwd missing | refused — never falls back (I3, M8) |
| late write after parent recreated | refused (F2, P5) |

`[INFERENCE]` The identity checks are durable comparisons against TaskStore, not application-level
assertions that could be skipped.

---

## 22. Findings

**No new P0/P1.** Two implementation gaps were found and closed during this phase:

1. `[FACT]` **dispose() did not abort the child session** — it aborted only the context's own
   controller. Found by test H1, not by inspection. Fixed: dispose now aborts the child too, so a
   disposed child cannot be re-run. (M9 kills the regression.)
2. `[DESIGN DECISION]` A **useless `try/catch` that only rethrew** in the adapter — removed,
   since the behaviour it documented is the natural one.

`[OBSERVATION]` Four test gaps and two no-op mutants (§19) and one harness bug (§20) — all
reported rather than hidden, since each was initially indistinguishable from a real result.

---

## 23. Residual limitations

1. `[FACT]` **The kernel is still a conversation.** An autonomous child is a real
   `Session` with an empty history; it is not a first-class non-conversational execution context.
   6O Model C remains out of reach behind the frozen `vendor/minicore` seam.
2. `[FACT]` **A live autonomous turn is not cancelled when its parent is deleted** — its *write*
   becomes harmless (6Q), but the work runs to completion. Killing it needs a per-turn abort
   handle the kernel does not expose per context: ADR-8 / 6T.
3. `[FACT]` `permission-denied` and `task-superseded` are declared in the outcome union but are
   **not yet produced** by `execute()`: the kernel's `PermissionHandler` has no defer state, and
   the Scheduler (not the context) decides supersession. Both belong to 6S/6T.
4. `[DESIGN DECISION]` The `onEvent` sink is a plain callback with no backpressure or queueing.
   6C made the same choice for the Scheduler; consistent, and adequate for V1.
5. `[FACT]` **Not implemented, by instruction:** trigger, policy, approval, enablement, retry,
   TaskGraph, lineage. Unchanged standing limits: the duplicate crash window, unprovable model
   intent, no verifier, no attempt history, D5′ cross-process recovery.

---

## 24. Final verdict

# GREEN

| Criterion | Status |
|---|---|
| autonomous context genuinely isolated | **YES** — separate session, busy, abort, events, permissions |
| parent session not reused as the execution session | **YES** — derived child id, A2/M1 |
| busy state isolated | **YES** — C1, G1; no lock added |
| abort isolated | **YES** — C2–C5 |
| task namespace isolated | **YES** — E1, E2, P2 |
| session incarnation preserved | **YES** — I2, F2, P5 |
| recreated sessions cannot receive old execution effects | **YES** — proven cross-process |
| tool permission boundary correct | **YES** — enforced twice, I1, M4, M5 |
| provider context deterministic | **YES** — required `cwdFor`, per-context model/provider |
| events cannot corrupt interactive presentation | **YES** — I5, no parent sink exists |
| concurrent contexts cannot cross-talk | **YES** — G1 |
| resource lifecycle bounded | **YES** — H1 (20/20), H2 |
| Phase 6P invariants green | **YES** — 31/31 |
| Phase 6Q invariants green | **YES** — 23/23 |
| no new P0/P1 | **YES** |
| process-boundary evidence exists | **YES** — P1, P2, P4/P5 |
| production Scheduler construction | **0** |
| production files modified | **0** — two new modules only |
| tsc / lint | **28 / 7** — exactly baseline |
| full suite | **3134 pass / 23 skip / 3 fail** — the same 3 pre-existing |
| tree CLEAN | **YES** |

`[INFERENCE]` The Final Principle's list — identity, conversation state, busy state, abort state,
task namespace, permissions, event ownership — is now **executable and tested** for each, and the
boundary depends on no undocumented global state: the context holds only what it was constructed
with, and the only process-wide thing involved is the 6B ownership token the Scheduler already
owns.

`[DESIGN DECISION]` **Nothing was enabled.** No `new Scheduler(` in production, no trigger, no
flag, no CLI default changed. This phase makes the integration *possible*; it does not make the
Scheduler *reachable*.
