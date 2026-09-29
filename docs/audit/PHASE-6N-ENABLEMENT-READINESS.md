# PHASE 6N — ENABLEMENT READINESS AUDIT

Baseline commit: **`ca59fa4`** (`audit: close scheduler hygiene gaps`)
Tree at start: **CLEAN**. `main`, 39 commits ahead of `origin/main`, **nothing pushed**.

**AUDIT ONLY.** No production Scheduler reachability was added. No Scheduler was
instantiated from production code. No Scheduler internals were redesigned.

Labels: `[FACT]` executed/observed · `[OBSERVATION]` pattern seen · `[INFERENCE]` reasoned ·
`[DESIGN DECISION]` intentional.
Evidence status: `VERIFIED` (executed here) · `UNVERIFIED` (read, not executed) ·
`NOT IMPLEMENTED` · `RECONSTRUCTED` · `NEW ARCHITECTURE`.

---

## 1. Executive verdict

# NO-GO — the repository is NOT ready to begin an implementation phase that introduces Scheduler into production reachability.

`[FACT]` Two **P1 integration defects** are reproducible and would corrupt user-visible
state the moment Scheduler is connected:

| ID | Finding | Class | Conf |
|---|---|---|---|
| **F1** | `reconcile()` silently reverts a **user turn's** `IN_PROGRESS`/`VERIFYING` task to `PENDING` | INTEGRATION RISK | HIGH |
| **F2** | Session deletion during an in-flight turn throws an **uncaught** exception out of `cycle()` and **permanently wedges** the Scheduler | INTEGRATION RISK | HIGH |

`[FACT]` Three **P2** gaps, all `NOT IMPLEMENTED`/DESIGN GAP rather than defects: no
autonomous trigger (F3), no enablement mechanism (F4), one-conversation context model (F5).
`[FACT]` One **P2** real defect outside the Scheduler: `purgeExpired` never deletes task
rows, so 6K's D4 protection does not cover the TTL path (F6).

`[FACT]` The proven subsystem remains intact. **No 6L runtime result is contradicted**:
0 lineage collisions, 20 774 property checks, no readiness bypass, no fabricated
completion, and correct restart/recovery all still hold, and were re-verified here
wherever they cross into integration.

`[INFERENCE]` F1 is the decisive one. It is invisible in the subsystem's own tests
because inside the Scheduler's world `IN_PROGRESS` means only "claimed by me". In
production the same status also means "the model is working on this right now". The two
meanings share one column, and `reconcile()` reads every `IN_PROGRESS` as the first.

---

## 2. Current production architecture

`[FACT]` `VERIFIED` by reading the tree at `ca59fa4`.

```
cli/index.ts:129          session = await createMinicodeSession(coreSpec)   <- ONE session
  └─ src/app/session.ts:48   createMinicodeSession() -> kernel Session
       └─ vendor/minicore/src/core/session.ts:163  createSession(config)
            run(input, {signal?, model?}): Promise<TurnResult>   (line 130)
            abort(): void                                        (line 131)
```

`[FACT]` The production turn-execution call sites are exactly two:

| Site | Role |
|---|---|
| `cli/setup.ts:1303` `await session.run(prompt, {model, signal: ctl.signal})` | the **user** turn |
| `src/tools/task.ts:319` `await session.run(String(prompt), {signal: ctx.signal})` | **sub-agent** turn (`delegate_task`) |

`[FACT]` `cli/commands/acp.ts:340` creates a **separate** session via `createSession`.
`[OBSERVATION]` There is exactly one long-lived conversational `Session` per interactive
process. That single fact drives most of what follows.

---

## 3. Intended Scheduler boundary

### CURRENT PRODUCTION PATH — `VERIFIED`

```
CLI/ACP start -> createMinicodeSession -> [user prompt] -> session.run()
   -> kernel executeTurn -> provider -> tools (permission -> executor)
   -> semantic events (session.events) -> presentation adapter -> renderer
   -> saveSession -> checkpoint/journal
   -> SIGTERM -> process.exit()   (src/ui/tui/app.ts:331,337)
```

### PROPOSED SCHEDULER ATTACHMENT POINT — `NOT IMPLEMENTED`

```
TaskStore <-- already exists, sole writer
     ^
     | claim / recordAttemptReturned / reconcile
Scheduler(sessionId, {store, runTurn, instruction})   <- NOT IMPLEMENTED anywhere
     |
     |  ?? WHO CALLS cycle() ?            <-- NOT IMPLEMENTED  (F3)
     v
session.run(...)  or  a NEW child Session  <- decision NOT MADE  (F5)
     |
     v
presentation / events                       <- routing NOT IMPLEMENTED
```

`[FACT]` The `TaskStore` half of the boundary is real and production-grade today:
`src/task/sync.ts` is the live model-facing writer.
`[FACT]` Every link marked `NOT IMPLEMENTED` is absent from the tree, not merely
undocumented. Verified in §5.

---

## 4. Construction contract

`[FACT]` `VERIFIED` from source (`src/task/scheduler.ts:100-190`), not from prior artifacts.

```ts
new Scheduler(sessionId: string, opts: {
  store: TaskStore            // REQUIRED
  runTurn: RunTurn            // REQUIRED: (work) => Promise<ExecutionObservation> | ExecutionObservation
  instruction: string         // REQUIRED
  onEvent?: (e) => void       // optional; absent = events DROPPED, not queued
  cancellation?: { isCancelled(): boolean }   // optional
})
```

| Prerequisite | Must production provide | Exists today? |
|---|---|---|
| `sessionId` | one string, fixed for the instance's life | YES |
| `TaskStore` | an instance for the right cwd | YES |
| `runTurn` | a bridge from a work item to a real turn | **NOT IMPLEMENTED** |
| `instruction` | a template | trivially; **content undefined** |
| trigger | something to call `cycle()` | **NOT IMPLEMENTED** (F3) |
| `cancellation` | an external abort source | partial — §10 |

`[FACT]` **`STOPPED` is terminal** — `start()` after `stop()` throws
`"scheduler is STOPPED and cannot be restarted"` (`scheduler.ts:208-210`).
`[FACT]` `VERIFIED` by execution.
`[INFERENCE]` **IMPLICATION:** one Scheduler instance per session *lifetime*; a resumed
or long-lived session must construct a **new** instance.

`[FACT]` Ownership: `start()` acquires **process-local** session ownership and throws
`ownership-unavailable` if another owner exists in-process (`scheduler.ts:213-224`).
`[FACT]` `VERIFIED`: a second Scheduler for the same session throws.

`[FACT]` **Scheduler owns no resources** — no timers, intervals, event listeners, DB
handle, or self-scheduling loop (full read of the 571-line module + grep for
`setTimeout|setInterval|addEventListener|new Database`).
`[FACT]` `VERIFIED`: after `start()` and a 250 ms wait with no `cycle()`, nothing happens.
**Scheduler never self-drives.**

---

## 5. Production reachability

`[FACT]` `VERIFIED` by exhaustive search of `src/`, `cli/`, `vendor/`, `bench/`,
`scripts/`, `experiments/`, `test/`.

| Path | Count | Classification |
|---|---|---|
| `new Scheduler(` in `src/`+`cli/` | 1 | **DEAD** — a comment, `scheduler.ts:29` |
| Importers of `src/task/scheduler` | **3** | **TEST ONLY** — `test/phase6c-scheduler.test.ts:25`, `test/phase6f-attempt-recovery.test.ts:39`, `test/phase6k-integration-safety.test.ts:29` |
| Production importers | **0** | — |
| `start()`/`stop()`/`cycle()`/`reconcile()` callers outside tests | **0** | NOT IMPLEMENTED |
| Config flag / env var / CLI option | **0** | NOT IMPLEMENTED (F4) |
| Startup / resume / shutdown hook referencing Scheduler | **0** | NOT IMPLEMENTED |

`[INFERENCE]` Scheduler is **EXPORTED BUT UNUSED**, reachable only from tests. Intended
state, and clean: nothing can regress production today.

---

## 6. Session ownership

`[FACT]` `VERIFIED` for each case, using real mechanisms.

| Case | Mechanism | Result |
|---|---|---|
| A. new session | fresh id, no rows | PASS — no inherited state |
| B. resumed session | same id, same DB | PASS — lineage preserved, completed generations not re-run |
| C. parallel sessions | distinct ids | PASS — ownership keyed by session id |
| D. session deletion | `deleteSessionTasks` | PASS — `tasks=0`, cycle `no-candidates`, **no autonomous work resurrected** |
| E. recreation, same id | `createTask` after delete | PASS — fresh rows, **no lineage inherited** |
| F. process restart → resume | new handles | PASS — `{exec:1,att:1}` survives; new Scheduler recovers `[]` |

`[FACT]` **F2 — deletion *during* an in-flight turn is a live defect.** Deleting the
session inside `runTurn` produced:

```
cycle() outcome   THREW: execution generation 1 is no longer current for 6n/t1;
                  refusing to record a stale completion
scheduler state   IDLE
active claim      {"taskId":"t1","claimRevision":2,"execGeneration":1}   <- never cleared
```

`[INFERENCE]` Two harms. (1) The exception escapes `cycle()` uncaught → unhandled
rejection in a composition root that does not wrap it. (2) The stale claim is never
cleared, and `runCycle` returns `already-dispatched` whenever `claim !== null`
(`scheduler.ts:287-289`), so that Scheduler is **permanently wedged** — and it still
holds session ownership, so no replacement can start.

---

## 7. runTurn contract — highest priority

`[FACT]` The production execution boundary is **a single stateful conversation, not a
reentrant turn**.

`[FACT]` `UNVERIFIED` at runtime, read from `vendor/minicore/src/core/session.ts:215-256`:

- `run()` is **guarded**: `if (impl.running) throw new AgentError("busy", ...)` (line 216).
- `run()` **merges the turn into shared history**: `store.replace(0, store.messages.length, turnStore.messages)` (line 245).
- Each turn is **conditioned on the whole prior history**: `turnStore.appendAll(store.messages)` (line 221).
- `turnCount`/`stepCount` are **shared** session state (lines 246-247).
- Every turn emits `turn:completed` onto the session bus (line 248).
- `abort()` aborts **whatever turn is running** on that Session (lines 257-259).

`[FACT]` A **precedent that already solves isolation** exists: `src/tools/task.ts`
creates a **child** Session (`journal: {sessionId: childId, parentSessionId: parentId}`),
forwards selected child events tagged `forwardedChild` (so the parent journal does not
double-record), and inherits the parent signal (line 319).

| Event | Scheduler expectation | Production reality | Risk |
|---|---|---|---|
| normal return | `returned{ok}` = attempt ended | `TurnResult`; merges history, emits `turn:completed` | MEDIUM — history pollution on a shared Session |
| throw | `rejected` = attempt ended | `run()` rejects; `busy` is a **normal** throw | MEDIUM — `busy` looks like work failure |
| cancellation | checked **before** dispatch only | `abort()` is session-global; no per-turn handle | **HIGH** — cannot cancel one turn |
| timeout | not modelled | `createTimeout(timeoutMs)` per turn | MEDIUM |
| tool failure | invisible (observation only) | via `PermissionHandler` | LOW |
| model failure | `rejected` | provider throws → rejects | LOW |
| nested event | not modelled | kernel emits mid-turn; `task.ts` proves forwarding is needed | MEDIUM |

`[INFERENCE]` **Does "turn ended" correspond to production's boundary?** Only if `runTurn`
is given its own child Session. If handed the user's Session, "turn ended" also means
"the user's conversation now contains Scheduler work", and "cancelled" cannot be
expressed per-Scheduler. **F5.**

---

## 8. Event / presentation boundary

`[FACT]` `UNVERIFIED` at runtime, read from source. The kernel emits onto a
**per-Session** `EventBus` (`session.ts:121`); `src/presentation/adapter.ts` is the single
place that turns those into semantic `DomainEvent`s consumed by renderers.

`[FACT]` A `session.run()` always emits `turn:completed` (line 248). `src/tools/task.ts`
shows the production answer for background work: a **separate child session** plus
**explicit, selective, tagged** event forwarding.

`[FACT]` `NOT IMPLEMENTED`: no Scheduler→presentation routing, no `forwardedChild`
equivalent, no decision about whether autonomous turns should be visible in the TUI.

`[INFERENCE]` A Scheduler turn on the user's Session would be **user-visible** — assistant
text, tool calls, a turn footer — at a moment the user did not ask for. No existing
mechanism suppresses it. Classify `NOT IMPLEMENTED`; do not add support in this phase.

---

## 9. User vs Scheduler concurrency — mandatory

| # | Scenario | Guarantee |
|---|---|---|
| U1 | user active, scheduler idle | **PROVEN** — today's only mode; single Session, one turn |
| U2 | user idle, scheduler active | `NOT IMPLEMENTED` — no trigger exists to start one |
| U3 | both active | **UNSAFE by default** — same Session ⇒ second `run()` throws `busy`; different Sessions ⇒ no ordering guarantee between event streams |
| U4 | user starts during a Scheduler turn | **UNSAFE** — `busy` thrown at the user; the user sees an error instead of a turn |
| U5 | Scheduler starts during a user turn | **UNSAFE** — `runTurn` throws `busy`; Scheduler records a `rejected` attempt and **burns a generation** |

`[INFERENCE]` No serialization, isolation, or mutual exclusion exists **across** the
user/Scheduler boundary. Within one Scheduler, serialisation is real and proven
(`inFlight` join, `scheduler.ts:265-275`) — but that is Scheduler-vs-Scheduler, not
Scheduler-vs-user. U5 is sharpest: a generation is consumed by a contention error that
has nothing to do with the work. **INTEGRATION RISK, P1-adjacent, HIGH.**

`[DESIGN DECISION]` No lock or scheduling policy was added. Classify the gap.

---

## 10. Cancellation / shutdown

`[FACT]` `UNVERIFIED` at runtime, read from source.

| Trigger | Production reality | Scheduler consequence |
|---|---|---|
| Ctrl+C | raw mode → **no SIGINT**; emulated (`src/ui/input/input.ts:840`) | no signal to hang a shutdown hook on |
| SIGTERM | `process.on("SIGTERM", …)` → **`process.exit(code)`** (`src/ui/tui/app.ts:331,337`) | **no graceful async cleanup runs at all** |
| model/tool cancel | `session.abort()` — session-global | cannot target a Scheduler turn (F5) |
| `Scheduler.stop()` | awaits the in-flight cycle, does **not** cancel it (`scheduler.ts:237-253`) | correct in isolation; unbounded if a turn hangs |
| crash after claim | task left `IN_PROGRESS`, no marker | recovered by the next owner's `reconcile()` — by design |

`[FACT]` `VERIFIED`: `stop()` does not release an in-flight claim and writes no durable
state. A stopped Scheduler leaves its task `IN_PROGRESS` for a legitimate authority —
documented, intentional, safe.

`[INFERENCE]` SIGTERM is the sharp edge: `process.exit()` is immediate, so an autonomous
turn dies mid-flight with no cleanup. Survivable **only** because `reconcile()` recovers
it next start — precisely the mechanism F1 corrupts.

`[FACT]` `NOT IMPLEMENTED`: no shutdown hook stops a Scheduler before process exit; no way
to cancel a Scheduler mid-turn.

---

## 11. Error propagation

`[FACT]` `VERIFIED` by source read + execution.

| Failure | Behaviour |
|---|---|
| `runTurn` throws synchronously | caught; claim **released** to PENDING; `failure: "bridge-threw"` (`:384-397`) |
| `runTurn` rejects | caught → `observation = rejected`; lineage **still recorded**; claim cleared (`:412-456`) |
| event sink throws | swallowed by design (`:549-556`) |
| ownership not held | `reconcile()` returns `[]`, emits `ownership-unavailable`, **mutates nothing** |
| `recordAttemptReturned` finds a non-current generation | **throws** — see F2 |
| claim accepted but row unreadable | throws `SchedulerError("persistence")` (`:343`) |
| attempt ends with no active claim | throws `SchedulerError("persistence")` (`:441`) |

`[FACT]` Three `throw` sites escape `cycle()`: `:343`, `:441`, and the store's lineage guard.
`[INFERENCE]` A composition root must treat `cycle()` as throwing — but nothing in the type
signature says so, since `CycleResult` has no error channel. **DESIGN GAP, P2.**

`[INFERENCE]` Errors **cannot** bypass lineage recording on the normal path: the write
happens after `await produced` and rejection is converted, not propagated. They **can**
bypass it on the F2 path, where the store refuses the write.

---

## 12. Completion authority

`[FACT]` `VERIFIED` by execution: after 5 cycles with a model that always reports `ok`,
the task is `IN_PROGRESS`, `evidence=[]`, `verification=null`. A normal return **never**
completes a task. Completing it required an explicit model `completed`
(`synchronizeCanonicalTasks`), which produced `COMPLETED`.

`[FACT]` The status-authority split holds: Scheduler writes only `IN_PROGRESS` (claim) and
`PENDING` (reconcile / dispatch-failure release). `COMPLETED`, `FAILED`, `CANCELLED`,
`BLOCKED`, `VERIFYING` are model/operator-authored.

`[INFERENCE]` **Could connecting Scheduler make a normal return look like completion?**
**No.** The Scheduler has no path that writes `COMPLETED`, and wiring `runTurn` to a
session does not change that — completion still requires the model to call `todo_write`
with `completed`. **This boundary is PROVEN SAFE; no remediation needed.**

`[FACT]` One caveat: `src/tools/todo.ts:214-219` enforces "only one `in_progress`" by
demoting others to `pending` — a **model-side** rule, unrelated to the Scheduler, but it
is the reason a user-written `IN_PROGRESS` row normally exists.

---

## 13. Task mutation during execution

`[FACT]` `VERIFIED` by execution — the highest-risk interleaving:

```
claim generation N  ->  external revision update  ->  model returns  ->  lineage write
```

Result: rev 1→3, **user title preserved** (`T edited by user`), **user order preserved** (5),
lineage recorded `{exec:1, att:1}`.

`[INFERENCE]` Stale writes cannot silently overwrite newer task state, and the external
edit does not cost the lineage record. This is exactly 6I's intent — lineage is keyed on
`exec_generation`, which an unrelated write does not advance, so the marker still lands.
**PASS.**

`[INFERENCE]` But the sibling case fails: an external write that sets status to
`IN_PROGRESS` is not merely protected — it is *reverted* by the next cycle (F1).
Mutation-during-execution is safe; mutation-as-`IN_PROGRESS` is not.

`[INFERENCE]` Also: `dispatch()`'s cancellation path deliberately does **not** release the
claim when stopping/cancelled after the claim (`scheduler.ts:369-378`). For an autonomous
system that means a cancelled Scheduler leaves work stranded until some owner reconciles —
sound, but it makes `reconcile()` load-bearing, which is exactly where F1 lives.

---

## 14. Restart / resume

`[FACT]` `VERIFIED`:

| Flow | Result |
|---|---|
| claimed + attempt returned, then process restart | lineage `{exec:1,att:1}` survives; new Scheduler recovers `[]` — **not re-executed** |
| claimed, attempt NOT recorded (crash) | next owner reverts it — the intended recovery path |
| session deleted | nothing to recover, nothing dispatched |
| session recreated same id | fresh rows, no lineage inherited |

`[INFERENCE]` **PROCESS RESTART vs EXECUTION RECOVERY — the exact boundary:**

- **Restart** = the process died. Durable rows survive. Nothing needs deciding.
- **Recovery** = a *new* owner observes `IN_PROGRESS` with no completion marker and must
  decide whether to revert. That is `reconcile()`.

Restart is passive; recovery is an active, ownership-gated decision. The two are correctly
separated in the code, and this audit confirms the first is safe. **F1 lives entirely
inside the second.**

---

## 15. Configuration / provider

`[FACT]` `UNVERIFIED` at runtime, read from source.

An autonomous turn needs provider, model selection, cwd, environment, tool registry,
sandbox config. `[FACT]` All are available in a long-lived process — the one prerequisite
set that is genuinely satisfied.

`[FACT]` **The one that is not: approvals.** `vendor/minicore/src/core/permission.ts:12`:

> `Decision = "allow" | "deny"` — "Only 'deny' blocks execution. A handler that needs
> interactive approval … is expected to **block until it resolves the decision
> internally**".

`[FACT]` The kernel enforces no policy of its own; it delegates entirely to the handler.

`[INFERENCE]` An autonomous turn therefore has exactly two possible behaviours, and both
are wrong:
- wire the interactive `ask` handler → the turn **blocks indefinitely** waiting for a
  human who did not initiate it;
- omit it → `createMinicodeSession`'s documented behaviour denies every prompt
  (`src/app/session.ts:66-68`: "tanpa ini mode interaktif menolak semua prompt — aman
  untuk headless/library"), so tools are unusable.

`[INFERENCE]` There is no "defer to a future human" decision in the kernel's vocabulary. A
Scheduler **cannot queue a task for approval**; it must block or deny. This is a hard
constraint on the whole enablement design, and it is **NOT IMPLEMENTED**. P2, HIGH, DESIGN GAP.

---

## 16. Security boundary

`[FACT]` `UNVERIFIED` at runtime, read from source. Every tool call passes
`PermissionHandler.check` before execution; the kernel does not bypass it. A Scheduler turn
therefore does **not** inherit a *different* tool boundary than a user turn — the boundary
is shared and unconditional.

`[FACT]` But §15 shows the two differ in **who can answer**: an interactive user answers
`ask`; nobody answers for an autonomous turn. So:

> **Not proven — and the answer is no in practice.** Scheduler inherits the same
> *mechanism* but not a viable *decision-maker*. Closing the gap means either auto-allow
> (a security regression: autonomous shell/filesystem/network with no human in the loop) or
> auto-deny (breaks the feature). **INTEGRATION RISK, P2, HIGH.**

`[FACT]` The `delegate_task` precedent mitigates but does not solve this: a sub-agent also
needs approvals, and it works because it runs *inside* a user turn that already has an
interactive `ask` handler. A Scheduler turn has no such parent.

`[INFERENCE]` `src/tools/task.ts:271` also fences a child from `write_memory`,
`forget_memory` and `todo_write` via `systemExtra` — prompt-level, not structural
isolation. A Scheduler turn would need an equivalent fence, or the child and the Scheduler
will fight over the same todo list — which is also F1's root.

---

## 17. Resource / lifetime

`[FACT]` `VERIFIED` by full read + grep: Scheduler allocates **no** timers, intervals,
listeners, DB handles, or provider resources. It holds only `sessionId`, the injected
`store`/`runTurn`/`instruction`, an `owner` token, and at most one `claim`.

| Lifecycle | Resources | Note |
|---|---|---|
| construct | none | pure field assignment |
| run | one in-flight promise | `inFlight` |
| idle | none | `IDLE` after a cycle; holds `owner` |
| reconcile | none | ownership-gated |
| restart | **not possible** | `STOPPED` is terminal |
| destroy | releases the owner token | `stop()` |

`[INFERENCE]` No leak and no unbounded lifetime **inside** the Scheduler. The exposure is
external: it holds a `SessionOwner` until `stop()`, and on SIGTERM nothing calls `stop()` —
harmless in-process (the process dies) but it means **no clean Scheduler teardown path is
wired to shutdown**. `NOT IMPLEMENTED`.

`[INFERENCE]` Per-cycle cost is a fresh `getSnapshot` + `new TaskGraph`, never cached
(`scheduler.ts:293-294`) — deliberate and correct, O(n+e).

---

## 18. Production-like harness

`[FACT]` Harnesses lived in `%TEMP%\opencode\` and used **real** `TaskStore`, `TaskGraph`,
`synchronizeCanonicalTasks`, `session-ownership` and `Scheduler` against **real temporary
SQLite databases**. No production file was modified; the production diff is empty (§23).

`[FACT]` Simulated: new session → task creation → model-facing status write → readiness →
Scheduler claim → realistic turn → result → persistence → reconcile → restart → session
deletion. Results are quoted inline in §6, §12, §13, §14.

`[FACT]` `NOT` done, per the mission: no `new Scheduler()` added to production startup, no
production flag added, no runtime semantics changed.

---

## 19. Enablement failure matrix

| Boundary | Proven | Unproven | Severity |
|---|---|---|---|
| construction | required args, ownership fail-closed, no owned resources | trigger, `runTurn` bridge, instruction content | P2 |
| session ownership | A–F all pass; deletion/recreation/restart safe | deletion **during** a turn (F2) | **P1** |
| runTurn | observation-only contract; no verdict inference | shared-history merge; session-global `abort`; `busy` semantics | **P1** |
| events | per-Session bus; child-session forwarding precedent | Scheduler→presentation routing; autonomy visibility | P2 |
| concurrency | Scheduler self-serialisation | U3/U4/U5 cross-boundary safety; generation burn on `busy` | **P1** |
| cancellation | `stop()` never releases live work | per-turn cancel; SIGTERM teardown | P2 |
| shutdown | stranded work recoverable by design | no shutdown hook; `process.exit()` skips cleanup | P2 |
| completion | never fabricated; model-only authority — **PROVEN SAFE** | — | — |
| persistence | lineage survives restart; no stale overwrite | `purgeExpired` orphans tasks (F6) | P2 |
| restart | restart vs recovery correctly separated | F1 lives inside recovery | **P1** |
| configuration | no flag exists; opt-in precedent exists | the flag itself | P2 |
| security | kernel boundary unconditional | no viable decision-maker for autonomous approvals | P2 |
| resources | zero owned; no leak | no wired teardown on SIGTERM | P2 |

---

## 20. Findings

**F1 — P1 / HIGH — INTEGRATION RISK — `reconcile()` reverts user task state.**
`[FACT]` `VERIFIED` by execution: an `IN_PROGRESS` task written by a **user turn** through
the production `synchronizeCanonicalTasks` is silently set to `PENDING` (rev 2→3) by a
Scheduler `cycle()` that selected a *different* task. `VERIFYING` is affected identically.
`[FACT]` Root cause at `src/task/store.ts:1020-1027`: the predicate has **no
`exec_generation > 0` term**.
`[FACT]` `VERIFIED` the rows **are** distinguishable: a model-written row is
`{exec:0, att:null}`, a genuine stranded claim is `{exec:1, att:null}`. The revert is
therefore both unnecessary and destructive.
`[INFERENCE]` Blast radius: any session where the model marks a todo `in_progress` while the
Scheduler ticks. `src/tools/todo.ts:19` shows the model may do this, and `todo.ts:214-219`
actively maintains one such task.
`[DESIGN DECISION]` Not fixed here. Two coherent fixes exist — exclude `exec_generation = 0`
from reconcile, or stop sharing one status column between "model is working" and "Scheduler
claimed" — and choosing between them is a design decision, not a hygiene fix.

**F2 — P1 / HIGH — INTEGRATION RISK — uncaught throw + permanently wedged Scheduler on mid-turn session deletion.**
`[FACT]` `VERIFIED`: `recordAttemptReturned` throws
`"execution generation 1 is no longer current … refusing to record a stale completion"`,
escaping `cycle()`. State remains `IDLE` with a permanent in-memory claim, and ownership is
never released.
`[INFERENCE]` That Scheduler can never cycle again and no replacement can take the session.
Reachable in production via `deleteSession` while autonomous work runs, and plausibly via
TTL purge interacting with F6.

**F3 — P2 / HIGH — NOT IMPLEMENTED — no autonomous trigger.**
`[FACT]` `VERIFIED` by execution that `start()` alone does nothing; nothing in the repo
calls `cycle()`. The entire "when should work happen" policy is undefined.

**F4 — P2 / HIGH — NOT IMPLEMENTED — no enablement mechanism.**
`[FACT]` No flag, env var, or CLI option exists.
`[FACT]` A proven opt-in precedent does exist — `MINICODE_ALLOW_LOCAL_CONFIG=1` /
`--allow-local-config`, default deny (`src/config.ts`, `normalizeConfig`) — so a flag would
be conventional. Not added.

**F5 — P2 / HIGH — DESIGN GAP — one conversation per Session.**
`[FACT]` `UNVERIFIED`-at-runtime: `run()` merges into shared history (line 245), is guarded
by a single `busy` slot (line 216), and `abort()` is session-global (line 257).
`[FACT]` The child-session pattern in `src/tools/task.ts` is the proven remedy, but no
decision has been made to adopt it for Scheduler.

**F6 — P2 / MEDIUM — CORRECTNESS DEFECT (pre-existing, outside Scheduler) — `purgeExpired` orphans task rows.**
`[FACT]` `UNVERIFIED`-at-runtime: `src/session/persistence.ts:576-592` deletes `sessions`,
`messages`, `turns`, `presentation_events` and **never references TaskStore**. `tasks.db`
rows for purged sessions survive with their execution lineage.
`[INFERENCE]` 6K's D4 fix covered `deleteSession` only; the sibling TTL path has the same
shape and was not covered. Impact is orphaned rows and a latent risk if an 8-hex session id
is ever reused.

**INFO — ownership fail-closed.** `VERIFIED`: a second Scheduler for a live session throws
rather than coexisting.

**INFO — no Scheduler-owned resources.** `VERIFIED`: no timers, listeners, or DB handles.

**INFO — the proven 6L/6M evidence is unaffected.** `[FACT]` No runtime property from 6L was
contradicted by this audit; 6N found integration-boundary defects, not subsystem defects.

---

## 21. Standing limitations

`[DESIGN DECISION]` Carried forward unchanged. None was addressed in 6N:

1. One duplicate crash window between a `runTurn` return and the lineage write.
2. Model/task intent remains unprovable — the Scheduler cannot know whether a turn did the work.
3. No verifier component exists.
4. Only current-attempt lineage is retained, not full attempt history.
5. **D5′** cross-process live-task recovery (6L) — a foreign process reverts a live task.
6. **F1** reconcile reverts user-authored `IN_PROGRESS`/`VERIFYING` (new, 6N).
7. **F2** mid-turn session deletion wedges the Scheduler (new, 6N).
8. `purgeExpired` orphans task rows (new, 6N, F6).
9. `RETRYING` remains declared-but-unwritable and inert (6L I1).
10. Audit-report factual claims are not machine-verified (6M K6M-3).

---

## 22. Final readiness verdict

# NO-GO

`[INFERENCE]` Answering the mission's question — *"Is the repository technically ready to
begin an implementation phase that introduces Scheduler into production reachability?"* —
**no**, for two independent reasons:

**1. Unresolved P1 integration defects (§21 of the gate).**
- **F1** is a direct hit on the gate's *"completion semantics can be corrupted"* and
  *"a production integration path would require undocumented assumptions"*. Connecting
  Scheduler to a live model would silently reset the user's in-progress task.
- **F2** is a hit on *"shutdown can leave dangerous autonomous execution"*: the Scheduler
  can be permanently wedged while holding session ownership, with an uncaught exception
  escaping `cycle()`.

**2. The runTurn contract is not merely unknown — it is structurally incompatible by
default.** The gate says NO-GO if the production runTurn contract is
*"incompatible/unknown"*. It is both: the kernel's turn is a whole-conversation merge
behind a single `busy` slot with a session-global `abort`, and the only proven isolation
pattern (`delegate_task`'s child session) is scoped to turns that run *inside* a user turn.
A Scheduler turn has no such parent.

`[FACT]` Also independently NO-GO-contributing: no autonomous trigger exists (F3), no
enablement mechanism exists (F4), and autonomous turns have no viable approval
decision-maker (§15, §16).

### What is genuinely ready

`[FACT]` The **subsystem** is in good shape and the boundary audit was worth doing:
construction contract fully understood; ownership fail-closed; **zero** production
reachability; zero owned resources; completion authority **proven safe**; no stale-write
hazard; restart and recovery correctly separated; session deletion leaves no resurrected
autonomous work.

`[INFERENCE]` The distance to enablement is not "wire one object in". It is a design
phase: decide the context-isolation model (F5), decide the trigger and its policy (F3),
decide the approval model for autonomous turns (§15/§16), fix the two P1s, and then build
the enablement flag (F4). **This verdict is not production authorisation**, and it does
not condemn the design — it says the boundary has four unresolved design decisions, two of
which are outright defects.

---

## 23. Exact evidence commands

`[FACT]` Every command was run in `D:\recover\minicode-20260928\reconstruction` at `ca59fa4`
with a clean tree. Harnesses are in `%TEMP%\opencode\`; **none** was added to the repository.

```powershell
# baseline
git status --porcelain                 # empty
git log --oneline -1                   # ca59fa4
git status -sb                         ## main...origin/main [ahead 39]

# reachability
Select-String -Path src\task\scheduler.ts -Pattern 'new Scheduler\('
Get-ChildItem -Recurse -Filter *.ts -Path src,cli,test,bench,scripts,experiments |
  Select-String 'from ".*task/scheduler'      # -> 3 hits, all test/

# enablement surface
Get-ChildItem -Recurse -Filter *.ts -Path src,cli |
  Select-String 'MINICODE_(SCHEDULER|TASK|ENABLE)|enableScheduler|--scheduler'   # -> none

# resources owned by Scheduler
Select-String -Path src\task\scheduler.ts `
  -Pattern 'setTimeout|setInterval|addEventListener|new Database'              # -> none

# F1 - reconcile reverts user task state
bun run $env:TEMP\opencode\6n-definitive.ts
#   A. user wrote in_progress  -> after cycle: status=PENDING  (rev 2->3)  CLOBBERED
#   B. model row {exec:0} vs stranded claim {exec:1}  -> DISTINGUISHABLE
#   C. VERIFYING -> PENDING                                       CLOBBERED
# underlying SQL: src\task\store.ts:1020-1027 (no exec_generation > 0 term)

# F2 - session deletion mid-turn
bun run $env:TEMP\opencode\6n-delmidturn.ts
#   cycle() THREW ... refusing to record a stale completion; claim never cleared

# boundaries: stale write, completion authority, session lifecycle, restart
bun run $env:TEMP\opencode\6n-boundaries.ts    # 1..6, all PASS

# source read for the contract
#   src\task\scheduler.ts:100-190   construction contract
#   src\task\scheduler.ts:265-275   serialisation
#   src\task\scheduler.ts:369-462   dispatch / lineage
#   vendor\minicore\src\core\session.ts:215-256  run(): busy guard, history merge, abort
#   vendor\minicore\src\core\permission.ts:12    allow|deny, must block to resolve
#   src\tools\task.ts:283-328        child-session isolation precedent
#   src\session\persistence.ts:576-592  purgeExpired never touches TaskStore

# gates (unchanged from 6M)
bun test                      # 3046 / 23 skip / 3 fail (3 verified pre-existing)
```

`[FACT]` Production Scheduler construction count at completion: **0**.

