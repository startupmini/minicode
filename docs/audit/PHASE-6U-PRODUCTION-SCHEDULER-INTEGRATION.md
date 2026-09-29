# Phase 6U — Production Composition & Off-by-Default Scheduler Integration

**Verdict: GREEN.** Production integration technically works behind an explicit
OFF-by-default gate. **This is not enablement** — the Scheduler is off for every
user, and the flag is experimental.

Commit: `feat: integrate scheduler behind disabled production gate`
Baseline: `cfe7100` (Phase 6T) — clean tree, 46 commits ahead, nothing pushed.

---

## 1. Production composition root

`FACT` — eight real composition roots exist; the one that builds the actual
runtime session is `createCliSession` in `cli/setup.ts:491`, called from
`cli/index.ts:399` (one-shot) and `:456-554` (run + `close()`).

```
cli/index.ts ─ parse flags ─ createCliSession ─ kernel session ─ TUI/one-shot
                                    │
                                    ├─ [6U] createProductionScheduler(gate, deps)
                                    │     └─ Scheduler → trigger → 6R context → 6S policy
                                    └─ close() → [6U] productionScheduler.stop() FIRST
```

`DESIGN DECISION` — the policy lives in `src/task/production-scheduler.ts`, not
inlined into `cli/setup.ts`. Threading seven responsibilities through a 1500-line
file that already builds providers, MCP, LSP, RAG, presentation and shadow-git
state would bury the single thing a reviewer most needs to check: whether the
gate is consulted *before* anything is constructed. The module is small enough to
read in full; the call site is one function call.

`FACT` — nothing constructs a Scheduler from task code, TaskStore, `todo_write`,
TaskGraph or a model callback. J7 enforces exactly one construction site.

---

## 2. Construction vs activation vs trigger

Three separate things, deliberately separable:

| stage | what happens | when OFF |
|---|---|---|
| **construction** | `deps()` runs; TaskStore opened, provider referenced, Scheduler created, deletion channel subscribed | **never happens** |
| **activation** | `scheduler.start()` takes session ownership | never happens |
| **trigger** | `handle.fire(source)` requests an evaluation | returns `null` |

`DESIGN DECISION` — the gate is checked **before construction**, not after. The
alternative (build it, then refuse to activate) satisfies the letter of "inert"
while still opening a SQLite handle, subscribing a listener and allocating a
trigger on every run. The mission's zero-resources invariants and P1's "no
Scheduler construction" are only *structurally* satisfiable if nothing is built.

`DESIGN DECISION` — dependencies arrive as a **thunk**. `deps()` is not invoked
when the gate is shut, which makes "no DB handle, no provider, no subscription" a
property of control flow rather than a promise in a comment (A4, F1/200 seeds).

---

## 3. Enablement gate

`DESIGN DECISION` — **exactly one mechanism: a CLI boolean flag
`--enable-scheduler`, default OFF.**

| candidate | verdict |
|---|---|
| **CLI flag** | **SELECTED** — per-invocation, not in `process.env`, not read from any file |
| env var | **rejected** — `process.env` is inherited by sub-agents (`src/tools/task.ts`), MCP servers (`src/mcp/server.ts`) and LSP servers. A sub-agent that inherited the gate would build its own Scheduler for the same session and fail closed, leaving a stopped instance. Inheritable by construction, and that inheritance is exactly what the requirement forbids. |
| config file | **rejected** — `~/.minicode/config.json` is global (enables it for every project on the machine); `.minicode/config.json` is gated behind `--allow-local-config`, but once a user passes that for an unrelated reason a repository could ship a config that turns autonomous execution on. Unrelated configuration with a scheduling consequence. |
| runtime setting | **rejected** — no scheduler setting exists, and a mutable runtime switch could not stop a *live* turn without the polling loop 6T rejected (ADR-14). |

Requirements, each asserted rather than described:

- default OFF — `A1`, `P1` (a real process without the flag constructs nothing)
- explicit opt-in — the literal token only
- deterministic — `A6`: anything but literal `true` is off
- **not inheritable** — `A3` sets `MINICODE_ENABLE_SCHEDULER=1` and asserts the
  gate is still shut
- no value form — `A2`: `--enable-scheduler=false` does **not** enable it, and
  neither does `=true` or `=1`; the flag has one spelling
- emergency disable — omit the flag (ADR-18)
- testable — `schedulerGateFor` + `resolveSchedulerGate`, and P1/P2 vary it per
  process

`DESIGN DECISION` — `schedulerGateFor(enabled)` exists so the *call site* is a
tested one-liner. Before it, the suite covered the module while `cli/setup.ts`
contained an untested expression, and mutation M2 ("make it default-on") survived
every test. "The policy is correct" and "the product calls it correctly" are
different claims and now have the same assertion (`J2`).

---

## 4. Trigger transport

`DESIGN DECISION` — **explicit**: a startup evaluation at activation, plus a
`fire(source)` handle for whatever the integration phase wants to call.

No timer, no polling, no task-code change. `FACT` — `MiniCode` is not a
long-running server: `cli/index.ts:456-554` runs one turn and exits, so an
interval transport would be a timer with nothing to tick against. `H3` asserts no
repeating timer is ever created in either mode.

`INFERENCE` — the limitation is honest and deliberate: nothing re-triggers when a
task becomes ready *after* the startup evaluation. `handle.fire()` is the seam a
task-mutation hook would call; installing that hook is an enablement-phase
decision, so it is **DECISION BLOCKED** here, not guessed.

Dedup is inherited and proven in production shape: `E1` (four mixed triggers → one
claim), `E2` (20 sequential triggers → generation stays 1), `E3` (three triggers
landing *during* a parked turn → exactly two turns total, each task claimed once).

---

## 5. Session scope

`DESIGN DECISION` — **PER SESSION**, inherited from 6T ADR-19 and unchanged: the
Scheduler is already per-session, the task namespace is the session, and 6Q's
incarnation makes a session's tasks unusable after deletion.

| requirement | mechanism | evidence |
|---|---|---|
| no cross-session execution | per-session ownership; namespace is the session | `C3`, `H1` (two sessions in one process) |
| no duplicate authority | `acquireSessionOwnership` fails closed | `C2` (second composition for one session throws) |
| no scheduler for a deleted session | 6T incarnation check at every cycle | `C3`, `P4` |
| recreation cannot inherit | new lifetime = new incarnation | `P5` |
| full lifecycle owned by the root | `stop()` releases subscription + ownership | `C5`, `C5b` |

---

## 6. Create / resume integration

`FACT` — `schedulerEnabled` is an option on `CliSessionOptions`, threaded from
`cli/index.ts` from the flag token. It is **not** derived from `resumeId`, so a
resumed session behaves exactly like a new one: enabled iff the flag is present.

`DESIGN DECISION` — no distinction between new and resumed. `INFERENCE` — the
incarnation, not the resume, is what makes state coherent, and 6Q already keys
everything on it. A special case would be a second rule to keep correct.

---

## 7. Cancellation wiring

This closes the 6T gap: `cancelActive()` finally has a live production source.

`DESIGN DECISION` — reuse `session-ownership.ts`'s existing per-session
authority rather than adding a second registry. That module is already the
process's per-session authority and is already consulted by the Scheduler; 6Q
refused to add a registry precisely so deletion works without one. It gains
`onSessionInvalidated` / `notifySessionInvalidated` / `releaseSessionOwnershipFor`.

`DESIGN DECISION` — process-local and therefore a best-effort **optimisation, not
a correctness boundary**. A deletion in another process reaches nothing here and
must not need to: 6Q's incarnation check remains authoritative. `INFERENCE` — a
subscriber mistaken for a guarantee would be worse than none.

`FACT` — wired into the real path at `src/session/persistence.ts`
`deleteSessionCompletely`, immediately after the incarnation bump and **before**
any row is deleted. Ordering is 6Q's: invalidate durably, then signal, then
delete — so a broken subscriber cannot resurrect anything.

Order inside `stop()`: dispose the trigger → `cancelActive` → await the cycle →
`stop()` the scheduler → unsubscribe → release ownership. Cancel **before** the
await, because a turn still unwinding is exactly when the abort must have been
sent.

`EVIDENCE` — `D1` (deletion aborts a live turn, nothing resurrected), `D2`
(after stop, all five trigger sources return `null`), `D3` (subscription released,
not retained — "the GC will clean it" is explicitly not accepted), `D4` (a
throwing subscriber cannot fail a deletion), `M3`/`M6` killed.

---

## 8. Shutdown wiring

Required ordering, implemented at `cli/setup.ts` `close()`:

1. stop new triggers — `trigger.dispose()`
2. prevent new claims — scheduler `STOPPING`/`STOPPED`
3. signal active executions — `cancelActive("shutdown")`
4. bounded wait — `awaitSettled()` then `scheduler.stop()`
5. preserve durable state — nothing written; 6Q reconciliation remains authoritative
6. close runtime resources — the pre-existing flush/detach/kill sequence
7. exit

`DESIGN DECISION` — the scheduler goes **FIRST**, before presentation detach and
before `killAllBackgroundJobs`. It is the only thing here that can still start
new work; detaching UI first would leave a live turn with nothing to report to,
and killing jobs first would race a turn that might legitimately use one.

`INFERENCE` — durable recovery is unchanged. A turn that does not come back is
handled by the incarnation check and a later reconciliation, exactly as a crash
is. Cancellation is not a substitute for recovery and recovery was not removed
because cancellation exists.

`EVIDENCE` — `D2`, `D3`, `P6` (all five sources `null` after stop), `M9`
classified below.

---

## 9. Interactive concurrency

`FACT` — 6R's isolation is unchanged and inherited: the autonomous context owns
its own `AbortController`, busy domain, event sink and child session; `readonly`
is not inherited; no parent presentation sink exists.

| property | evidence |
|---|---|
| no shared busy state | 6R `C1` (a user turn and an autonomous turn do not contend) |
| no shared abort | 6R `E9`; `J1` — cancellation creates **no** abort-ish global |
| no shared presentation | 6R `E3` proves `E1` |
| no task-namespace confusion | `E4` — the child id is `auto~<parent>~<task>~<gen>`, carries the task, and the attempt lands on the task that ran |

`DESIGN DECISION` — event routing is **silent**. `INFERENCE` — autonomous events
are not injected into the user's conversation stream, do not touch TUI state and
carry their own child session id. Routing them into the presentation adapter would
require deciding how a background worker appears in a single-user transcript, and
§11 says to STOP rather than invent a renderer. Both sinks are injectable
(`onSchedulerEvent`, `onTriggerEvent`) for a later phase that has an answer.

---

## 10. Autonomous execution adapter

`FACT` — `Scheduler.runTurn → buildAutonomousRunTurn → AutonomousExecutionContext`
(6R), unchanged. The production composition root adds no execution stack of its
own.

Preserved through the production path: parent session id, session incarnation,
task id, execution generation, execution owner, cwd, provider, the 6S permission
policy, and the derived child conversation identity.

`DESIGN DECISION` — the child session is built by the **real**
`createMinicodeSession` over the **real** `router`, so autonomous work does not
run a different model or a weaker tool stack than the interactive session. Tools
are the **real** tool objects filtered to the 6S allow-list — the jailing inside
the real `read_file` is part of the security boundary, and a re-implemented tool
would be a second implementation to keep correct.

---

## 11. Security boundary

`FACT` — a real bypass risk was found and closed. `src/app/session.ts:124` builds
its own `createPermissionHandler` from `permissionMode`, and 6S proved that
handler is (a) revocable at runtime via `__setMode` and (b) admits
`web_fetch`/`web_search`. Composing for production without a seam would have
quietly reintroduced both, in a place no 6S test would have caught.

`DESIGN DECISION` — `createMinicodeSession` accepts an optional
`permissionHandler`. When supplied, `permissionMode` becomes kernel metadata
only and **`onPermissions` is not wired**, because exposing a mode control would
hand Shift+Tab the ability to widen an unattended executor — precisely the hole
6S F1 closed.

`EVIDENCE` — `G1` (the production spec carries the 6S handler; no `__setMode`),
`G2` (injected handler has no mutable mode; the interactive one does),
`G3` (the production tool set is the 6S allow-list and contains no `bash`,
`write_file`, `todo_write`, `web_fetch`, `mcp_call` or `delegate_task`), `G4`
(every dangerous class denied, the safe read class still allowed).

---

## 12. Disabled-mode invariants (the regression boundary)

| invariant | evidence |
|---|---|
| zero Scheduler construction | `A4` (thunk never invoked), `P1` (real process) |
| zero claims / generations | `B1`, `B3` |
| zero autonomous child sessions | `B1` |
| zero triggers doing work | `B1` (50 fires), `A5` |
| zero autonomous tool calls | `G3`, `G4` |
| zero background resources | `B2` (no subscription), `H1`, `H3` (no timer) |
| ordinary behaviour unchanged | `B3` — create, reorder and complete tasks freely while off |

`DESIGN DECISION` — the inert handle is inert, not broken. A caller that forgets
to check the gate gets `false`/`null`, never a throw it might swallow into "keep
going" (`A5`).

---

## 13. Production lifecycle matrix

| scenario | result |
|---|---|
| startup OFF | **EXPECTED** — nothing constructed (`P1`) |
| startup ON | **EXPECTED** — one scheduler, one subscription, released on stop (`P2`) |
| session create | **EXPECTED** — associated iff the flag is present |
| session resume | **EXPECTED** — identical; incarnation-keyed |
| two enabled sessions | **EXPECTED** — isolated; stopping one leaves the other running (`C3`, `P3`) |
| session delete | **EXPECTED** — live turn aborted, authority released, replacement allowed (`D1`, `P4`) |
| session recreate | **EXPECTED** — new authority, no stale ownership (`P5`) |
| idle → trigger → claim → run → return | **EXPECTED** (`E1`, `E4`) |
| provider failure | **EXPECTED** — rejected observation, attempt still recorded (6C) |
| tool denial | **EXPECTED** — `permission-denied`, `ok:false` (6S) |
| cancellation | **EXPECTED** (`D1`, `D2`) |
| shutdown | **EXPECTED** — no new work after stop begins (`P6`) |
| process restart | **EXPECTED** — durable state reopened by recovery, not stale in-memory ownership (`P5`, `P7`) |
| contended | **EXPECTED** — non-consuming (6T B1–B6) |
| live-cancel of a turn in *another* process | **UNSUPPORTED** — process-local by design; incarnation remains the barrier |

---

## 14. Resource lifetime

| | OFF | ON |
|---|---|---|
| deletion subscriptions | 0 (`B2`, `H1`) | 1 while running, 0 after `stop()` (`H2`, `D3`) |
| repeating timers | 0 (`H3`) | 0 (`H3`) |
| session authority | none | released on `stop()` (`C5`) |
| child sessions | 0 (`B1`) | one per dispatched turn, disposed by the adapter (6R) |

`INFERENCE` — "the garbage collector will clean it" is not accepted anywhere; the
registry is asserted directly. A leaked subscription would retain a whole
Scheduler — provider and child sessions included — for the process lifetime, so
`D3` asserts absence rather than trusting teardown order.

---

## 15. Process boundary (real OS processes) — 7 pass

| id | check | result |
|---|---|---|
| P1 | disabled process | `constructed=false scheduler=false watched=0` |
| P2 | enabled process | `constructed=true active=true watched=1 → 0 after stop` |
| P3 | two enabled sessions | `["s-a","s-b"]`; after stopping A `{a:false,b:true}` |
| P4 | session delete | `activeAfter=false watchedAfter=0 replacement=true` |
| P5 | session recreation | both processes composed; no stale-ownership wedge |
| P6 | shutdown | all five sources `null` after stop |
| P7 | restart | durable tasks seen by the new process |

**HARNESS FIX, recorded because the first version was worse than useless.** The
child originally derived the gate from its *mode*, so every mode except `"on"`
composed an inert handle — and P4/P6 then "passed" against a disabled scheduler.
The gate now comes from argv exactly as production resolves it. A vacuous pass is
not recorded as evidence.

---

## 16. Failure injection C1–C12 — 13/13 pass (12 faults + control)

Each fault injected at a named seam; the invariant is the same for all: after the
fault **and** teardown, no leaked subscription, and a recreated session composes
cleanly.

C1 deps thunk · C2 after construction · C3 before trigger · C4 after trigger ·
C5 before claim · C6 after claim · C7 before context · C8 after context ·
C9 mid-turn · C10 during cancellation · C11 during deletion · C12 during shutdown.

All 13 report `leaked=0 | recreate=clean`.

---

## 17. Mutation M1–M12 — 8 killed, 4 classified

| id | mutant | result |
|---|---|---|
| M1 | remove the OFF gate | killed (16) |
| M2 | make the scheduler default-on | killed (2) |
| M3 | skip production cancellation wiring | killed (10) |
| M4 | cancellation reaches a shared/global parent abort | killed (2) |
| M5 | leak the user conversation into the child prompt | **HARNESS GAP** |
| M6 | bypass the autonomous cancellation adapter | killed (2) |
| M7 | construct for a deleted session | killed (16) |
| M8 | release authority for any label | killed (2) |
| M9 | trigger accepted after shutdown begins | **EQUIVALENT** at the production level |
| M10 | duplicate trigger starts an overlapping cycle | killed (2) |
| M11 | drop session incarnation propagation | **HARNESS GAP** |
| M12 | drop task-id propagation | **EQUIVALENT** |

- **M5 HARNESS GAP** — killed by 6R's suite, not the 6U file. Verified by
  applying the mutant and running `phase6r-autonomous-context.test.ts`: 32 pass,
  1 fail.
- **M9 EQUIVALENT (production level)** — `handle.fire()` returns `null` after
  `stop()` because the handle's own `stopping` flag gates it, so removing
  `trigger.dispose()`'s flag changes nothing through the production path. The
  trigger-level property is killed by 6T's `A8` (verified: 52 pass, 1 fail). So
  `dispose()` is defence in depth at the production seam, not the primary guard —
  recorded rather than presented as more than it is.
- **M11 HARNESS GAP** — the 6U file does not exercise delete-then-**recreate**
  through the production binding, which is the only case where a hard-coded
  incarnation differs. 6Q covers the store. A `createCliSession`-level test is the
  fix and is the §14 harness's job.
- **M12 EQUIVALENT** — the **binding** is authoritative for task identity, by
  design: 6R made the durable claim the source of truth precisely so attribution
  cannot come from a mutable work item. Changing the work item while the binding
  still names the task correctly changes nothing observable.

No test was weakened. The two killable-by-adding gaps were addressed by *adding*
`C5b`, `J1` and `J2`.

---

## 18. Properties

`F1` 200 seeds — OFF never builds, fires, claims or subscribes; ON builds exactly
once and always ends released. `F2` 150 seeds — repeated stop is idempotent and
always terminal. Seeded LCG, so a failing seed is replayable from its number.

---

## 19. Regressions

- 6C/6F/6K/6P/6Q/6R/6S/6T + taskstore + task-invariants + task-di +
  permission-matrix + arch-map: **282 pass / 0 fail**.
- 6U: 36 pass / 660 assertions.
- Full suite: **3253 pass / 23 skip / 4 fail** — the 3 known pre-existing
  (`VENDOR.md` ×2, `web ssg` nested list) plus the 6S-documented MCP flake
  (`phase4b-isolation-lifecycle.test.ts:208` asserts a random UUID does not
  contain `"12"`; four consecutive runs were 8/0, so it recurs roughly
  intermittently). `tsc` **28 = baseline**. `biome` clean on all touched files.
- J7 (the "no production file constructs a Scheduler" guard) **changed and was
  strengthened**: it now requires exactly one construction site, names it, and
  asserts the gate precedes it in source order. Weakening it to "allow that one
  file" would have let any future file construct freely.

---

## 20. Residual limitations

1. **No automatic re-trigger.** Nothing fires when a task becomes ready after
   startup; `handle.fire()` is the seam. Installing a task-mutation hook is an
   enablement decision.
2. **No `createCliSession`-level test.** The composition module and the call
   site are both covered, but not by running the real `createCliSession` — that
   needs a live provider. M11's harness gap is the visible consequence.
3. **Live cancellation is process-local.** A deletion in another process is
   caught at the next cycle, not mid-turn. Deliberate; 6Q's incarnation is the
   boundary.
4. **Event routing is silent.** Both sinks are injectable but unwired.
5. **No verifier.** Completed tasks stay `IN_PROGRESS`; unchanged from 6N.
6. **6L D5′ cross-process liveness** unchanged.
7. **The flag is not a supported interface.** It can change without notice.

---

## 21. Exact evidence commands

```
bun test test/phase6u-production-composition.test.ts          # 36 pass
bun test test/phase6c-scheduler.test.ts test/phase6p-durable-ownership.test.ts \
         test/phase6q-session-execution-lifetime.test.ts \
         test/phase6r-autonomous-context.test.ts \
         test/phase6s-autonomous-permission-policy.test.ts \
         test/phase6t-trigger-policy-lifecycle.test.ts       # 282 pass
bunx tsc --noEmit                                            # 28 = baseline
bunx biome check <6U files>                                  # clean
bun test                                                      # 3253/23/4
```
Process boundary `P1`–`P7`, failure injection `C1`–`C12` and mutation
`M1`–`M12` are driven by harnesses under `%TEMP%\opencode`
(`process6u.ts`, `6u-injection.ts`, `evidence6u.ts`).

---

## 22. Verdict

**GREEN** — the composition root is explicit and singular; the gate is one
mechanism, default OFF, un-inheritable, and verified in real processes; trigger
transport is deterministic; session ownership is explicit and fails closed;
cancellation and shutdown are wired into the real lifecycle; disabled mode has
zero autonomous side effects; the enabled path uses real production components;
6S's policy is provably not bypassed by composing for production; process-boundary
and failure-injection evidence exists; session recreation is safe; 6P/6Q/6R/6S/6T
remain green; the tree is clean.

**This GREEN means:** "production integration technically works behind an
explicit OFF-by-default gate."

**It does NOT mean:** "the Scheduler is enabled for users." Phase 6V attacks it;
6W decides how it can safely become user-reachable.
