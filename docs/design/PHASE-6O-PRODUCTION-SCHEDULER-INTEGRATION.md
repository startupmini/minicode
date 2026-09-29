# PHASE 6O — PRODUCTION SCHEDULER INTEGRATION ARCHITECTURE

Baseline: **`ec0f689`** (`audit: validate scheduler enablement readiness`) · tree CLEAN · 40 ahead · nothing pushed.

**DESIGN ONLY.** No production change, no Scheduler reachability, no feature flag, no TaskStore /
TaskGraph / Scheduler semantics change. Scheduler production construction count: **0**.

Labels: `[FACT]` observed in source/execution · `[OBSERVATION]` pattern · `[INFERENCE]` reasoned ·
`[DESIGN DECISION]` chosen here · `DECISION BLOCKED` evidence insufficient.

---

## 1. Executive summary

`[INFERENCE]` The Scheduler subsystem does not need to be redesigned. It needs to be **joined to a
runtime that has no notion of autonomous execution yet**. Four boundaries must be defined before any
production wiring is possible, and two of them are defects rather than gaps.

The four questions this design answers explicitly:

| Question | Answer |
|---|---|
| **Who owns `IN_PROGRESS`?** | Currently two writers, one column. Must become **explicitly owned and durably recorded** — see ADR-2. |
| **What is a Scheduler turn?** | Not a turn of the user session. It requires a **separate execution context** — ADR-1. |
| **Who can approve autonomous actions?** | Nobody, today. The kernel has no `DEFER`. Requires a **new approval state** — ADR-7. |
| **Who terminates autonomous work?** | Nobody, today. SIGTERM calls `process.exit()` directly — ADR-8. |

`[FACT]` The most important negative result: **the obvious fix for F1 is provably insufficient.**
I built the history that shows it (§5.2). Two histories reach a byte-identical durable row and demand
opposite reconciliation actions. No function of `(status, exec_generation, attempt_generation)` can
decide. Therefore F1 **requires a schema change**, which is the opposite of what 6N's P1 wording
implied.

`[DESIGN DECISION]` Recommended shape of the integration:

```
one long-lived user Session          (unchanged; interactive world)
one Scheduler per session lifecycle  (new; already single-session by construction)
one child execution Session
  per dispatched work item           (new; ADR-1 Model B)
a durable execution-ownership marker
  on the task row                    (new; ADR-2, F1)
a durable approval-pending state     (new; ADR-7, reuses approval.requested)
one shared deletion operation        (ADR-9, resolves F6 as a side effect)
```

`[INFERENCE]` Ten ADRs are recorded. **Three are DECISION BLOCKED** (ADR-3 partial, ADR-6, ADR-10)
because the evidence in this repository cannot settle them without a product decision.

---

## 2. Current production architecture

`[FACT]` One conversational session per process, created once at startup:

```
cli/index.ts:129   session = await createMinicodeSession(coreSpec)
  -> src/app/session.ts:48      createMinicodeSession()  (app layer; sanitises limits)
     -> vendor/minicore/.../session.ts:163  createSession(config)
```

`[FACT]` Two turn-execution call sites exist in production:

| Site | Role | Trigger |
|---|---|---|
| `cli/setup.ts:1303` `await session.run(prompt, {model, signal: ctl.signal})` | **interactive** turn | a human typed something |
| `src/tools/task.ts:319` `await session.run(String(prompt), {signal: ctx.signal})` | **delegated** turn | the model called `delegate_task` *inside* an interactive turn |

`[FACT]` `cli/commands/acp.ts:340` creates a **separate** session per ACP connection.

`[INFERENCE]` There is no third kind of turn. Every turn in this runtime is either human-initiated or
nested inside a human-initiated turn. That is the structural fact the whole design turns on.

### Interactive execution — what exists

`[FACT]` From `vendor/minicore/src/core/session.ts:215-256`:

- owns a **single running slot**: `if (impl.running) throw new AgentError("busy", …)` (line 216)
- owns **conversation context**: each turn begins from `turnStore.appendAll(store.messages)` (line 221)
- **merges its turn into shared history**: `store.replace(0, store.messages.length, turnStore.messages)` (line 245)
- owns **shared counters**: `state.turnCount`, `state.stepCount` (lines 246-247)
- has a **session-global abort**: `abort()` aborts whatever is running (lines 257-259)
- has a **per-turn timeout**: `createTimeout(impl.timeoutMs)` (line 218)
- emits `turn:completed` on the session bus (line 248)
- is **transactional in model context**: a failed/aborted/timed-out turn is discarded, not merged (lines 240-245)

`[FACT]` It may mutate task state through the model-facing path `src/task/sync.ts` →
`synchronizeCanonicalTasks` → `TaskStore.patchTask`, and the model may author any status in
`TodoStatus` (`src/tools/todo.ts:19`).

### Autonomous execution — what exists

`[FACT]` **NOT IMPLEMENTED.** There is no trigger, no policy, no scheduler-owned context, no
approval path, and no teardown path. `src/task/scheduler.ts` is imported by exactly three files, all
tests. Nothing in `src/` or `cli/` constructs a `Scheduler`; the single textual occurrence is a
comment at `scheduler.ts:29`.

`[FACT]` The only real autonomous-ish execution is the delegated sub-agent, and it is **not** an
autonomous concept: it runs *inside* an interactive turn, is triggered by a model tool call, and
inherits that turn's abort signal (`task.ts:319`, `signal: ctx.signal`).

---

## 3. Scheduler subsystem boundary

`[FACT]` What the subsystem already guarantees, and therefore does not need re-deciding:

- construction: `new Scheduler(sessionId, {store, runTurn, instruction, onEvent?, cancellation?})`
- **no owned resources**: no timers, intervals, listeners, DB handle, or self-loop
- **serial**: `cycle()` joins the in-flight cycle (`scheduler.ts:265-275`)
- **single session**: `sessionId` is fixed at construction
- **fail-closed ownership**: process-local session ownership; a competing owner blocks the instance
- **observation-only execution**: `runTurn` returns an `ExecutionObservation`; the Scheduler never
  infers success and never writes `COMPLETED`
- **durable lineage**: `exec_generation` advances only in `claimTask`; `attempt_generation` is
  written only under an `exec_generation = ?` guard
- **`STOPPED` is terminal**: `start()` after `stop()` throws
- **does not self-drive**: nothing happens without an external `cycle()`

`[INFERENCE]` The subsystem is a *policy-free* engine: it answers "what is executable, and under what
recovery rules", and delegates "how to run it" entirely. This is why the integration design is
mostly about the world around it rather than about the Scheduler.

---

## 4. Problem statement

`[FACT]` The runtime has exactly one execution context (`Session`), one conversation per process,
one running slot, and one abort channel. The Scheduler is built on the assumption that "one attempt"
is an isolated, attributable unit of execution with its own durable generation.

`[INFERENCE]` These two models are not compatible without a decision. Concretely, five collisions
exist, each traced in the sections below:

1. `IN_PROGRESS` means two different things to two different writers (§5).
2. Session deletion can strand an execution whose context has vanished (§6).
3. A turn is a conversation, not an isolated unit — so a Scheduler turn on the user session pollutes
   user context and contends for one slot (§7).
4. Contention is indistinguishable from a real attempt, so it burns a generation (§8).
5. Approval has no non-blocking decision, so unattended execution cannot obtain consent (§11).

`[DESIGN DECISION]` The integration must therefore introduce, in order: a durable execution-ownership
notion (F1), a session-deletion lifecycle contract (F2), an isolated execution context, a
contention-safe dispatch, an approval state, a shutdown contract, a shared deletion operation, and
finally an enablement surface.

---

## 5. F1 — the `IN_PROGRESS` semantic collision

### 5.1 What the two writers actually mean

`[FACT]` **Writer 1 — the Scheduler claim.** `store.ts:800-807`:

```sql
UPDATE tasks
   SET status = 'IN_PROGRESS', updated_at = ?, revision = revision + 1,
       exec_generation = exec_generation + 1
 WHERE … AND status IN ('PENDING')
```

Meaning: "an execution generation exists and is in flight". It is a **machine** fact, guarded,
monotonic, and paired with a generation counter.

`[FACT]` **Writer 2 — the agent's plan cursor.** `todo.ts:19` includes `in_progress`; `todo.ts:43-45`
maps it to the display glyph `[~]`; `todo.ts:15-17` states its purpose: *"state eksplisit untuk task
multi-langkah. Tanpa ini agent tidak punya tempat menyimpan rencana antar step, sehingga pada task
panjang ia lupa langkah yang belum dikerjakan."* It is a **human/agent** fact: "which step am I on".

`[INFERENCE]` One column carries a machine fact and a human fact. `reconcile()` reads every
`IN_PROGRESS`/`VERIFYING` with no completion marker as the first, which is why a user's plan cursor
is destroyed.

### 5.2 Mandatory discriminating analysis — and why the obvious fix fails

`[FACT]` Executed. Histories and the action each requires:

| # | History | `status` | `exec` | `att` | Required action |
|---|---|---|---|---|---|
| H1 | user turn marks `in_progress`; Scheduler never claims | `IN_PROGRESS` | 0 | NULL | **LEAVE** |
| H2 | Scheduler claims; execution crashes, no return | `IN_PROGRESS` | 1 | NULL | **REVERT** |
| H3 | Scheduler claims; model independently marks `in_progress` | `IN_PROGRESS` | 1 | NULL | **REVERT** |
| H4 | claim → return → requeue → new claim | `IN_PROGRESS` | 2 | 1 | **REVERT** |
| H5 | claim → crash → **reconciled to PENDING** → user marks `in_progress` | `IN_PROGRESS` | 1 | NULL | **LEAVE** |

`[FACT]` H2 and H5 are **byte-identical**: `status=IN_PROGRESS exec=1 att=null`. Verified by
execution. `exec_generation` is **monotonic and never reset** — measured `1 → 1 → 1` across repeated
reconciliations, because the reconcile `UPDATE` (`store.ts:1020-1027`) touches only `status`,
`updated_at`, `revision`.

> **STATE AMBIGUITY.** H2 and H5 produce the same durable row and require **opposite** actions.
> No function of `(status, exec_generation, attempt_generation)` can decide between them.

`[INFERENCE]` This is the decisive result. It disproves the obvious fix:

- **"Require `exec_generation > 0`"** separates H1 from H2/H3 (exec 0 vs 1) — but H2 and H5 both have
  `exec = 1`, so it changes nothing for the ambiguous pair. It fixes the case 6N observed and leaves
  the harder one open.
- Any similar predicate over the *existing* columns fails for the same reason: the information is not
  present, because reconcile deliberately leaves the lineage columns untouched.

`[FACT]` A second, orthogonal piece of evidence: `reconcile()`'s SQL carries **no ownership condition
whatsoever** — no `exec_generation`, no attempt-owner, nothing. And `Scheduler.reconcile()`
(`scheduler.ts:511-547`) contributes only session ownership, explicitly delegating the lineage
decision to TaskStore by design (`scheduler.ts:526-534`).

### 5.3 Options

#### Option A — reconciliation only owns proven Scheduler generations

`[DESIGN DECISION]` **REJECTED as a complete fix; retained as a necessary component.**

- *Correctness:* fixes H1 only. Leaves the H2/H5 ambiguity unresolved. `[INFERENCE]`
- *Compatibility:* excellent — no schema change, no migration, no writer change. `[FACT]`
- *Legacy tasks:* a pre-lineage row has `exec_generation = 0`, so it would never be reconciled. `[INFERENCE]`
  That silently changes recovery for every database created before 6I.
- *Sufficient forever?* **No.** Proven insufficient by §5.2.
- *Where it belongs:* it is the right **second half** of the fix, because it is the condition that
  makes the durable marker meaningful.

#### Option B — an explicit, durable execution-ownership dimension

`[DESIGN DECISION]` **SELECTED as the core of the fix.**

`[FACT]` Phase 6B already anticipated this and built half of it. `store.ts:465-477`:

> `SCHEDULER` closes that door: `IN_PROGRESS` may then be authored ONLY by `claimTask`. Model-facing
> `todo_write` therefore fails closed with `TASK_AUTHORITY_VIOLATION` instead of creating a claim.
> Activation is explicit and per-instance. There is no environment variable, no module-level flag, and
> no automatic activation on `initialize()`.

`[FACT]` Verified: `patchTask` throws `TASK_AUTHORITY_VIOLATION` under `authority: "SCHEDULER"` and
succeeds under the default `LEGACY`. Production is `LEGACY` only, so the guard never fires today.

`[INFERENCE]` **The missing half is that this guard is per-instance, not durable.** Two `TaskStore`
objects in one process legitimately hold different authority modes, so a model write through the
`LEGACY` store is invisible to the `SCHEDULER` store. The design must record ownership **in the row**,
where both writers can see it.

*Required durable fact:* **"is the current `IN_PROGRESS` a Scheduler claim that has not yet been
reconciled?"** — a single value set by `claimTask` and cleared by `reconcileIfNoCompletedAttempt`.

`[INFERENCE]` This resolves every history without ambiguity:

| # | marker | action |
|---|---|---|
| H1 | absent (never claimed) | LEAVE |
| H2 | present, never cleared | REVERT |
| H3 | present (claim in flight) | REVERT — the claim is genuinely stranded |
| H4 | present for the new generation | REVERT |
| H5 | **cleared** by the earlier reconcile | LEAVE |

*Schema impact:* one nullable column or one additional lineage field. Additive, `ALTER`-able, same
migration mechanism 6K proved (`PRAGMA table_info`, idempotent, non-destructive).
*TaskStore API impact:* `claimTask` sets it; `reconcileIfNoCompletedAttempt` clears it; no new public
method strictly required. `Scheduler.reconcile()` needs **no change** — it already delegates.
*TaskGraph/readiness impact:* none. Readiness reads `status` only; the marker is orthogonal.
*Scheduler impact:* none. `[FACT]` This is the design's most attractive property — the P1 is fixable
entirely below the Scheduler.
*Interactive runtime impact:* the model keeps the ability to write its plan cursor, so no
functional regression in `todo_write`.

*Rejected sub-variant:* "make production use `authority: 'SCHEDULER'`". `[INFERENCE]` That converts a
silent revert into a hard `TASK_AUTHORITY_VIOLATION` failure of a **legitimate** model action,
breaking the plan cursor that `todo.ts:15-17` says the agent needs. It trades a data-loss bug for a
functional regression and does not remove the ambiguity for `LEGACY` readers.

#### Option C — separate task intent from execution state

`[DESIGN DECISION]` **DEFERRED, not rejected.**

`[INFERENCE]` The deepest reading of the problem: the todo list is *simultaneously* the agent's plan
and the canonical task list. `sync.ts:19-25` documents the classification that made them one object
("mixed payload → id-bearing items are EXISTING, id-less items are genuinely NEW"). If the plan cursor
and the execution state were separate durable dimensions, the collision would be impossible by
construction rather than by a guard.

`[INFERENCE]` Cost: this is a task-state redesign, not a Scheduler fix. It touches the `TaskStatus`
union, `readiness`, `identity`, the todo tool contract, and every consumer. `[DESIGN DECISION]` Out of
scope for enabling; worth a separate design phase. Note it is strictly *more* correct than Option B,
which treats the collision locally.

### 5.4 ADR-2 conclusion

`[DESIGN DECISION]` Adopt **Option B** as the F1 fix, implemented in TaskStore, with Option A's
`exec_generation > 0` condition retained as a necessary co-condition. Record the durable ownership
fact on the row. **Column name: DECISION BLOCKED** — the mission rightly warns against premature
naming, and the choice interacts with the Option C outcome.

---

## 6. F2 — session deletion during execution

### 6.1 The exact race

`[FACT]` Reconstructed and executed:

```
1  Scheduler.start()            -> acquires process-local session ownership
2  cycle() -> claimTask        -> status=IN_PROGRESS, exec=1, att=NULL
3  runTurn starts              -> the model turn is in flight
4  session deletion            -> deleteSessionTasks() removes the row
5  runTurn returns             -> observation obtained normally
6  recordAttemptReturned(...)  -> row is gone / generation no longer current
7  -> THROWS "execution generation 1 is no longer current for 6n/t1;
    refusing to record a stale completion"
8  the throw escapes cycle()   -> the caller never receives a CycleResult
9  this.claim is never cleared -> runCycle() returns "already-dispatched" forever
10 ownership is never released -> a replacement Scheduler cannot start()
```

`[FACT]` Verified end state: `state=IDLE`, `getActiveClaim()` still returns
`{taskId:"t1", claimRevision:2, execGeneration:1}`, and a second `new Scheduler(...).start()` throws
`ownership-unavailable`.

`[INFERENCE]` Two independent harms, and only one of them is the exception. The **wedge** is worse:
the Scheduler is permanently unable to cycle and permanently holds the session, so even a
supervisor that *did* catch the throw cannot recover it without a process restart. Wrapping `cycle()`
in `try/catch` (the lazy fix) would convert a crash into a **silent permanent stall** — strictly
worse. `[DESIGN DECISION]` This is exactly why the mission's final principle is right.

### 6.2 Options

#### D1 — graceful cancellation of the running turn

`[FACT]` `Scheduler.stop()` "does NOT cancel tasks" and cannot abort an in-flight loop: the
cancellation contract is `isCancelled()` checked **before** dispatch only (`scheduler.ts:369-378`),
and the comment is explicit that aborting an in-flight agent loop "is the composition root's, not ours".

`[INFERENCE]` D1 alone is insufficient: it requires the composition root to hold a per-turn
`AbortController` (today `abort()` is session-global) and it does not help if the delete lands between
the abort and the return.

#### D2 — execution becomes orphan-safe

`[DESIGN DECISION]` **SELECTED as the core invariant.** *The returning turn must be able to discover
that its world has ceased to exist, and must do so without leaving residue.*

`[INFERENCE]` Concretely, the lineage write must be **idempotent with respect to disappearance**:
"the row I claimed is gone" is a *normal, expected* outcome of session deletion, not a persistence
failure. Today `store.ts:1047-1051` throws `TASK_PERSISTENCE_FAILURE` for one impossible lineage shape
and `recordAttemptReturned` throws for the stale-generation shape; the "row absent" case needs its own
classification instead of falling into the throwing path.

`[INFERENCE]` And the Scheduler must **release its own bookkeeping** on any terminal path, so a
lost claim cannot wedge the instance. The wedge — not the throw — is the defect.

#### D3 — dispose the Scheduler before persistent deletion completes

`[DESIGN DECISION]` **SELECTED as the ordering rule.** `[FACT]` 6K already established the correct
ordering for `deleteSession`: tasks first, session state second, with the rationale that the two
residues are not symmetric (`persistence.ts:693-706`). The missing half is that **deletion must also
stop the executor** before it deletes the executor's state.

`[INFERENCE]` Required ordering for any session deletion that could have a Scheduler:

```
1  mark the session as DELETING (in-process registry + durable marker)
2  refuse new claims; let an in-flight turn finish OR cancel it (bounded)
3  release Scheduler ownership and clear claims
4  delete TaskStore rows
5  delete session-side rows
```

#### D4 — combinations

`[DESIGN DECISION]` **D2 + D3 are both required; D1 is optional but strongly recommended.**
D1 alone leaves a window; D3 alone cannot help if the delete is not initiated in-process (TTL purge,
external `deleteSession`, second process).

`[INFERENCE]` The invariant the mission demands — *"session deletion must not leave an autonomous
execution capable of mutating a newly recreated session"* — is best served by a **durable deletion
marker** rather than by in-process coordination, because in-process coordination cannot cover the
second-process and purge cases. A late turn that returns after its session was deleted must find that
marker (or find no row at all) and **refuse to write**.

### 6.3 Per-question answers required by the mission

| Question | Answer under D2+D3 |
|---|---|
| task state | row already deleted; nothing to restore |
| `exec_generation` | never advances — a deleted row cannot be claimed |
| `attempt_generation` | not written; the write is a no-op or an explicit "session gone" result |
| active claim | **must be cleared** — this is the wedge fix |
| model returns late | sees no row / deletion marker; refuses to write; no resurrection |
| row already deleted | normal outcome, classified, not thrown as a persistence failure |
| session DB delete ok, task delete fails | 6K's existing asymmetry applies; deletion must remain retryable and the DELETING marker must persist so no executor re-attaches |
| can the Scheduler continue another cycle? | only if it is disposed; a disposed instance must refuse to restart (`STOPPED` is already terminal) |
| can a replacement start? | **yes, once ownership is released** — currently no |
| can late events mutate a recreated session? | **no**, provided the recreated session cannot be claimed by a stale claim: `claimTask` is revision-guarded and generation-guarded, and the new row starts at `exec_generation = 0` |

`[INFERENCE]` The last row is the reassuring one: a recreated session is a *new row namespace* with
`exec_generation = 0`, so a stale completion carrying generation 1 cannot satisfy any guard on it. The
threat is not data corruption on recreation; it is the **wedged instance and the leaked ownership**.

---

## 7. Turn context isolation

### 7.1 What a turn is bound to

`[FACT]` From the kernel `Session` and `createMinicodeSession`:

| Bound item | Scope | Consequence for a Scheduler turn |
|---|---|---|
| conversation history | one `ContextStore` per `Session` | a turn **merges into** it (`session.ts:245`) |
| running slot | one per `Session` (`impl.running`) | contention throws `busy` |
| abort | one `sessionAbort` per `Session` | cannot cancel one turn independently |
| turn/step counters | one per `Session` | autonomous work inflates the user's counters |
| task namespace | `session_id` in every TaskStore statement | a Scheduler is already single-session |
| journal | `sessionId` (+ optional `parentSessionId`) | independent record possible |
| provider / model | `SessionConfig` | inherited explicitly by a factory |
| cwd | `SessionConfig.cwd` | inherited explicitly by a factory |
| permission mode + tool set | `SessionConfig` / `setupToolLayer` | inherited **explicitly, with a documented reduction rule** |
| event bus | one per `Session` | needs explicit forwarding to be visible elsewhere |

### 7.2 Model A — autonomous turn on the existing session

`[DESIGN DECISION]` **REJECTED.**

- busy collision: yes — and it is silent from the user's perspective (`scheduler.ts:399-405` treats
  a non-Promise as `bridge-not-callable`, but a *rejected* promise becomes a `rejected` observation
  and burns a generation)
- context contamination: yes — the agent's next user turn would be conditioned on autonomous work
  (`turnStore.appendAll(store.messages)`, line 221)
- shared memory: yes — `write_memory` is per-session
- event interleaving: yes — `turn:completed` lands in the user's stream
- shared abort: yes — Ctrl+C during an autonomous turn aborts *it*; the user's turn is unaffected but
  the inverse is not
- approval: no decision-maker (§11)

`[INFERENCE]` Model A fails on every axis and is the configuration the current code would produce by
default if someone simply passed the user session as `runTurn`. It must be explicitly rejected in
writing so it is not "accidentally chosen".

### 7.3 Model B — a child execution session per dispatched work item

`[DESIGN DECISION]` **SELECTED**, on the strength of an existing, working precedent.

`[FACT]` `src/tools/task.ts:243-284` already builds exactly this, via an injected `sessionFactory`:

| Inherited | Rule in production code | Line |
|---|---|---|
| provider | fetched fresh per sub-agent | 245-250 |
| **tool set** | `allTools` minus `delegate_task`, `write_memory`, `forget_memory`, **`todo_write`**, `bash_output`, `bash_kill`, `git_commit`, `submit_result`; further reduced to `EXPLORE_TOOL_NAMES` when the parent is `plan`/`readonly`/`ask` | 189-209, 174 |
| **cwd** | `parentCwd` from `ToolContext` | 225, 231, 255 |
| **permission mode** | `parentMode === "allowlist" ? "allowlist" : "auto"` | 257 |
| model | read live from `ctx.state.model` so `/model` mid-session is honoured | 262-269 |
| budget | `SUB_AGENT_BUDGET_EXPLORE` / `_PLAN` cap | 176-182 |
| journal identity | `{sessionId: childId, parentSessionId: parentId}` | 283 |
| prompt fence | `systemExtra` forbids the child's memory/todo tools and fences parent text as DATA | 270-282 |
| event routing | subscribe to child `execution:*`/`provider:*`, re-emit into parent tagged `forwardedChild` so the parent journal skips double-recording | 293-316 |
| cancellation | `signal: ctx.signal` — the parent turn's signal | 319 |

`[FACT]` `todo_write` is stripped from sub-agents, with the stated reason *"Sub-agent tidak boleh
menulis state milik parent"*. `[INFERENCE]` This is a **direct precedent for ADR-2**: the repository
already decided that a non-interactive execution must not author task status. That strongly supports
Option B over the "Scheduler writes IN_PROGRESS freely" reading of F1.

`[INFERENCE]` **What Model B does not give for free**, and therefore must be designed explicitly:

1. **A child that is not inside a user turn has no `ctx` and no `ctx.signal`.** Cancellation must be
   Scheduler-owned (`Scheduler.stop()` / process shutdown), which is a *new* cancellation source.
2. **Event forwarding has no parent to forward into.** `[FACT]` `forwardedChild` tagging assumes a
   parent journal; a Scheduler turn has none. Forwarding policy is therefore genuinely undecided
   (§15).
3. **A child created per work item needs a `childId` derivation** that does not collide with real
   session ids (`cli/commands/acp.ts:334` uses `randomUUID().slice(0, 8)`).
4. **The child must be disposed.** `[FACT]` The kernel has `cleanup()` (`session.ts:278`); nothing in
   the `delegate_task` path calls it. A per-work-item child that is never cleaned is a new leak.

### 7.4 Model C — a dedicated execution context that is not a conversation

`[DESIGN DECISION]` **DEFERRED — NOT IMPLEMENTED today.**

`[FACT]` The kernel offers no such abstraction. `createSession(config)` is the only factory and it
always produces a conversation-shaped `Session` with a history, counters, and a busy slot. Reaching
Model C means either changing the frozen kernel (forbidden — `vendor/minicore` is the L3 frozen seam)
or building a parallel executor above it, which would mean reimplementing turn execution.

`[INFERENCE]` Model C is the architecturally cleanest target (an autonomous turn genuinely should not
have a conversation), but it is **out of reach within this repository's layering** and must not be
assumed. Model B is the reachable approximation, and its residual cost — an autonomous turn that
carries a private, throwaway conversation — is acceptable because that conversation is never shown to
a human and never persisted as user-visible history.

---

## 8. Interactive vs autonomous concurrency

`[FACT]` Today: `run()` has one slot per `Session` and throws `AgentError("busy")` for a second
concurrent call (`session.ts:216`). `[FACT]` In Model B the Scheduler's turn runs in a **different**
`Session`, so the busy slot is not shared — the collision disappears at the cost of **context
divergence**: the Scheduler's turn would not see the user's latest messages, and the user's turn
would not see the Scheduler's.

`[INFERENCE]` That trade is the correct one: the alternative (sharing the slot) forces a
*serialization policy* on the user, which is a user-visible latency regression, whereas divergence
costs only conversational coherence, which a background worker never needed.

`[FACT]` **The remaining U5 problem is not the busy slot** — it is that *dispatch* is attempted
during a live user turn, so work is consumed by contention. `[FACT]` Concretely, `cycle()` claims
**before** dispatch (`scheduler.ts:325`), and `runTurn` rejection is recorded as a completed attempt
(`:412-421`, `:446`). A turn that never ran still consumes one generation.

`[DESIGN DECISION]` **The claim must be preceded by a pre-dispatch capacity check, and the
check must be inside the same critical section as the claim.** `[INFERENCE]` Rationale: the mission's
key requirement is that *a contention rejection must be indistinguishable from a real attempt* — the
inverse of what happens now. The only durable place to enforce that is the claim itself, because
`exec_generation` is the unit that must not be spent on a non-attempt.

`[DESIGN DECISION]` Preferred shape: a **claim-with-precondition** in TaskStore, where the UPDATE's
`WHERE` includes a capacity predicate (e.g. "no live autonomous claim for this session"), so a
rejected claim reports `CLAIM_REJECTED_BUSY` **and does not advance `exec_generation`** — exactly the
existing rejected-claim contract (`store.ts:818-830`), which already guarantees "a rejected claim
creates NO generation".

`[INFERENCE]` This needs no lineage redesign. `[FACT]` It reuses a property the store already has and
proves in a comment: `execGeneration` is reported unchanged on rejection specifically so "a caller
can never mistake a rejection for a claim". `[DESIGN DECISION]` So the only genuinely new thing is
the capacity predicate, and the *semantics* of contention stop being a new concept.

**Policy options considered:**

| Policy | Assessment |
|---|---|
| 1. Scheduler waits | `[INFERENCE]` Rejected: holds an in-memory wait across a user turn of unknown length; needs its own timeout and cancellation. |
| 2. Scheduler skips without claiming | `[DESIGN DECISION]` **SELECTED**, implemented as the capacity predicate above. Costs nothing, cannot strand a generation. |
| 3. Claims then waits | `[DESIGN DECISION]` Rejected: reintroduces exactly the stranded-claim problem, and an abandoned claim needs the D2 cleanup path. |
| 4. Separate execution context | `[DESIGN DECISION]` SELECTED as part of ADR-1 (Model B); makes the wait unnecessary. |
| 5. Prevented while an interactive turn exists | `[DESIGN DECISION]` **PARTIALLY SELECTED.** A cheap in-process "interactive turn active" flag makes policy 2 cheap and observable, but it is an *optimisation*, not the correctness mechanism — correctness must not depend on a flag that another process or another code path can miss. |

`[INFERENCE]` **Concurrency verdict:** with ADR-1 Model B and the capacity predicate, U3/U4/U5 become
safe **without** a lock, a queue, or a scheduling policy. That is worth stating plainly, because the
naive reading of 6N was that cross-boundary concurrency needs a mutex.

---

## 9. Trigger semantics

`[FACT]` Currently **NOT IMPLEMENTED**: nothing calls `cycle()`; `start()` alone does nothing
(verified: state `RUNNING`, 250 ms elapsed, task still `PENDING`).

`[DESIGN DECISION]` **The minimum viable trigger is an explicit, user-initiated, in-band command —
not a timer and not a background service.** Justification, evidence-first:

- `[FACT]` A timer requires an owner that outlives the request. `[FACT]` `src/ui/tui/app.ts:331,337`
  shows shutdown is `process.exit()` on SIGTERM; an interval would have to be cancelled by a teardown
  path that does not exist yet (ADR-8). A timer before a shutdown contract is a leak generator.
- `[FACT]` A background service implies a second long-lived loop in a process whose architecture is
  one session, one turn, one busy slot.
- `[DESIGN DECISION]` An explicit command fits the existing surface: `[FACT]` the runtime already has
  a command router (`cli/router.ts:3 dispatch`) and in-band control precedent
  (`PermissionControl.setMode` — `session.ts:43-46`, Shift+Tab in the TUI). A command is *observable*,
  *bounded* (one cycle or one drain), *cancellable* (the user can stop waiting), and leaves no residue
  when unused.

`[DESIGN DECISION]` Trigger contract:

| Property | Decision |
|---|---|
| ownership | the composition root, not the Scheduler; the Scheduler stays policy-free |
| frequency | **at most one in-flight cycle per session** (`inFlight` already guarantees it) |
| backoff | **none required initially** — a command-driven trigger has no retry loop. `[DESIGN DECISION]` If an automatic trigger is added later, backoff belongs in the trigger owner, never in `Scheduler.cycle()`. |
| idle | no work: `cycle()` returns `no-candidates` and changes nothing |
| duplicate triggers | `[FACT]` already handled — concurrent `cycle()` calls join the in-flight cycle (`scheduler.ts:265-275`) |
| process restart | `[FACT]` already handled — lineage is durable; recovery is an explicit `reconcile()` by a new owner |
| session deletion | `[DESIGN DECISION]` the trigger must be unregistered by the deletion path (ADR-3) |
| emergency stop | `[DESIGN DECISION]` `Scheduler.stop()` is terminal and idempotent; plus ADR-10's kill switch |

`[DESIGN DECISION]` A **drain** variant (run cycles until no candidates, bounded) is the natural
second step, and is still in-band and still bounded. `[INFERENCE]` It must be explicitly bounded by a
wall-clock limit, because with Model B each cycle can start a real model turn.

---

## 10. Scheduling policy ownership

`[FACT]` Today: `Scheduler` selects `ready[0]` — the first candidate in `TaskGraph`'s deterministic
order (`scheduler.ts:303-313`) — with no queue, no priority, no fairness (stated in the module header,
lines 22). The `CycleStop` vocabulary (`no-candidates`, `already-dispatched`, `claim-rejected-stale`, …)
is a **report**, not a policy.

`[DESIGN DECISION]` **Policy must not move into the Scheduler.** Justification: the module's own
header (`scheduler.ts:15-24`) enumerates what it deliberately does not do, and the 6H lineage design
depends on the Scheduler never inventing decisions. Adding priority/retry/fairness there would put
autonomous judgement inside the component that owns crash recovery.

`[DESIGN DECISION]` Ownership split:

| Decision | Owner | Rationale |
|---|---|---|
| what is *eligible* | `ELIGIBLE_STATUSES` (`readiness.ts:77`) | already decided in 5C |
| what is *ready* | `dependencySatisfied` + blockers (`readiness.ts:90`, `computeBlockers`) | already decided; false-positive is the dangerous direction (`:83-88`) |
| which ready task *next* | currently `ready[0]`; **policy owner = the trigger owner** | `[DESIGN DECISION]` leave the Scheduler taking the graph's order; let the trigger decide whether to cycle at all |
| blocked / failed / cancelled tasks | `[FACT]` not reconcilable; `Scheduler.reconcile()` only touches `IN_PROGRESS`/`VERIFYING` (`scheduler.ts:522`) | no Scheduler policy needed |
| retry | `[DESIGN DECISION]` **none in V1.** `[INFERENCE]` Retry is the single most dangerous thing to add to a system with an unprovable-intent model and a duplicate window: a retry multiplies both. Explicitly out of scope. |
| one-at-a-time | `[FACT]` already guaranteed (`inFlight` join + one claim at a time) | no policy needed |
| user-created vs scheduler-created tasks | `[INFERENCE]` **no distinction exists and none should be invented.** `[FACT]` `TaskProvenance` (`model.ts`) records origin, so the information is *available* if a future policy needs it, but adding a scheduler/interactive task split now would be new task semantics (§7 of the mission forbids casual introduction). |

`[INFERENCE]` V1 therefore has almost no policy at all: readiness decides what is eligible, the
trigger decides when, the graph's order decides which. That is a feature — it is the smallest surface
that cannot form a policy bug.

---

## 11. Autonomous approval model

`[FACT]` The current vocabulary is closed and blocking:
- `vendor/minicore/src/core/permission.ts:12` — `Decision = "allow" | "deny"`; "Only 'deny' blocks
  execution. A handler that needs interactive approval … is expected to **block until it resolves
  the decision internally**".
- `[FACT]` the kernel "never enforces its own policy" (`permission.ts:2-3`); it delegates entirely.
- `[FACT]` `createMinicodeSession` takes an optional `ask` handler and documents the headless
  behaviour: *"tanpa ini mode interaktif menolak semua prompt — aman untuk headless/library"*
  (`session.ts:66-68`).
- `[FACT]` `ApprovalAsk` resolves `"allow" | "deny" | "always"` (`src/ui/approval/prompt.ts:24`).

`[INFERENCE]` So an unattended turn has exactly two behaviours, and **both are wrong**: it blocks
forever waiting for a human who did not initiate it, or it denies everything and the feature is
useless. The mission's instruction is right that "it blocks" is not an answer.

`[DESIGN DECISION]` **The answer must be: it must never be asked.** Autonomous execution must be
constructed so that **no tool requiring human approval is reachable**, so the question does not arise.
This is Option D, and it is preferred over Option C (a `DEFER` state) for V1.

`[FACT]` Two existing mechanisms make Option D expressible **without any new permission state**:

1. `[FACT]` `setupToolLayer(cfg, scope, permissionMode)` (`src/app/tool-layer.ts`) already reduces the
   tool set by mode: `readonly` → `EXPLORE_TOOL_NAMES`; `plan` → explore + `{todo_write,
   delegate_task, submit_result}`; and MCP tools are filtered too ("least privilege").
2. `[FACT]` `task.ts:174` already implements precisely the anti-escalation rule:
   `forcedExplore = parentMode === "plan" || parentMode === "readonly" || parentMode === "ask"`,
   with the comment *"satu approval delegate_task menjadi N aksi tak-disetujui"* — one approval
   becoming N unapproved actions. `[FACT]` `EXPLORE_TOOL_NAMES` (`task.ts:19`) is the read-only subset.

`[DESIGN DECISION]` **ADR-7: V1 autonomous execution inherits the `explore` tool scope, always, and
does not inherit the parent's writable scope.** Consequence: an autonomous task can read, search, and
reason, but cannot write files, run shell, commit, or write task state. A task needing a write becomes
`BLOCKED` and surfaces to the human, who runs it interactively.

`[INFERENCE]` This is conservative, and deliberately so: `[FACT]` the repository's own precedent
(`task.ts:170-172`) treats "one approval becomes N unapproved actions" as the threat to defend
against. A background executor that can write is strictly more dangerous than a sub-agent, because no
human is watching the approval.

**Option C (DEFER / PENDING_APPROVAL) — analysis for a later phase:**

`[FACT]` The presentation vocabulary already has durable approval events:
`approval.requested` and `approval.settled`, both `{durable: true, replayable: true}`
(`src/presentation/events.ts` `DURABILITY` table). `[FACT]` And a durable pending-intent substrate
already exists: the mutation journal with `pending | committed | failed | finalized` and
`decideRecovery` answering "sudah/belum/ambigu" (`src/session/journal.ts`).

`[INFERENCE]` So a deferred approval is architecturally *supported* — there is already a durable place
to record it and a vocabulary to render it. What is missing is: a `TaskStatus` representing
"awaiting human approval" (**STATUS MODEL GAP**, §16), an owner for the pending approval, a resume
path, and a timeout. `[DESIGN DECISION]` **Option C is the correct long-term answer and is DEFERRED**;
it should not be built before ADR-1 and ADR-2, because it needs a task-state vocabulary change and a
stable execution identity to attach the approval to.

**Option B (auto-allow within explicit policy)** `[DESIGN DECISION]` **REJECTED for V1.** It requires
trusting a static policy to bound an autonomous executor whose intent is unprovable (6L standing
limitation), and it has no precedent in this repository.

---

## 12. Shutdown contract

`[FACT]` Today: `src/ui/tui/app.ts:331,337` — SIGTERM handler calls `process.exit(code)`.
`[FACT]` Ctrl+C in raw mode does **not** raise SIGINT; it is emulated (`src/ui/input/input.ts:840-841`).
`[FACT]` `Scheduler.stop()` awaits the in-flight cycle and cannot cancel it
(`scheduler.ts:237-253`); `STOPPED` is terminal and the owner token is released.
`[FACT]` Scheduler owns no timers, listeners, or DB handles, so there is nothing to unregister beyond
the ownership token and the in-flight promise.

`[DESIGN DECISION]` The ordering the mission asks for, adapted to what actually exists:

| # | Step | Mechanism | Bounded? |
|---|---|---|---|
| 1 | stop accepting new work | trigger owner stops scheduling; Scheduler goes `STOPPING` | immediate |
| 2 | prevent new claims | `state !== RUNNING/IDLE` makes `cycle()` return `not-running` (`:278-280`) | immediate |
| 3 | signal active execution | **NOT IMPLEMENTED** — needs the per-turn `AbortController` from ADR-1/ADR-3 | must be added |
| 4 | wait, bounded | `await stop()` waits for the in-flight cycle — `[FACT]` **currently unbounded** | must be bounded |
| 5 | reconcile persistent state | `[DESIGN DECISION]` **do NOT reconcile on shutdown.** A claim left `IN_PROGRESS` with no marker is *exactly* the state `reconcile()` is designed to recover, and reconciling during shutdown would revert work whose turn may still be finishing. The crash-recovery path is the correct mechanism; shutdown should not duplicate it. |
| 6 | close persistence | `[FACT]` TaskStore handles are process-global and cached (`handles` map); `resetTaskStoreHandles()` exists **for tests only** | must be designed |
| 7 | terminate | `process.exit()` | — |

`[INFERENCE]` Step 5 is the counter-intuitive one and worth stating: **shutdown should look like a
crash to the durable state.** That is not sloppiness — it is the one state the system already knows how
to recover from, deterministically, on the next start. Adding a shutdown-time reconcile would create
a *second* recovery path with different semantics, and would risk reverting a turn that is still
in flight.

`[DESIGN DECISION]` SIGINT and SIGTERM differ in one respect that matters: SIGINT is emulated in raw
mode and reaches the TUI as a keypress, while SIGTERM arrives as a signal to a process that may have
no TUI. **The shutdown contract must be owned by the process, not by the UI**, so that a headless or
ACP session gets the same ordering. `[FACT]` `src/mcp/server.ts:608-609` already installs
`process.once` for both signals, so a precedent for process-level signal handling exists.

`[INFERENCE]` **The most important shutdown requirement is the bounded wait (step 4).** With Model B
each Scheduler turn is a real model turn with a real `timeoutMs`; an unbounded `await` on shutdown is
a hang, and `[FACT]` `process.exit()` would then never be reached.

---

## 13. TTL / purge integration (F6)

`[FACT]` Two session-teardown paths exist and only one cleans up tasks:

| Path | Deletes tasks? | Evidence |
|---|---|---|
| `deleteSession(id, cwd)` | **yes**, first, and propagates failure | `persistence.ts:711-718` (6K D4 fix) |
| `purgeExpired(db, now)` | **no** — deletes `sessions`, `messages`, `turns`, `presentation_events`, never references TaskStore | `persistence.ts:576-592` |

`[INFERENCE]` So a TTL-purged session leaves task rows **and their execution lineage** behind forever.
Impact is orphan rows plus a latent risk if an id is ever reused; session ids are
`randomUUID().slice(0, 8)` (`cli/commands/acp.ts:334`).

`[DESIGN DECISION]` **ADR-9: there must be exactly one session-deletion operation, and both paths must
use it.** `[INFERENCE]` This is the mission's "avoid creating a second deletion architecture": the
second architecture already exists and is the bug. F6 is not a separate feature — it is the absence
of a shared operation.

`[DESIGN DECISION]` Shape:

```
deleteSessionCompletely(id, cwd)  — the single operation
  1  mark DELETING (durable; see ADR-3)      <- new, protects running executors
  2  stop/dispose the session's Scheduler    <- new, ADR-3 D3
  3  TaskStore.deleteSessionTasks(id)        <- existing; MUST be first, 6K ordering
  4  delete session-side rows                <- existing
```

| Question | Answer |
|---|---|
| one operation? | yes |
| TaskStore cleanup mandatory? | yes, and it must be **first** — 6K established the asymmetry |
| ordering | DELETING marker → executor stop → tasks → session rows |
| failure handling | `[FACT]` propagate and leave retryable, as `deleteSession` already does (`persistence.ts:714-718`) |
| idempotency | required — `deleteSessionTasks` on an empty session is already a no-op (verified: `tasks=0`) |
| retry | safe, because the marker persists and every step is idempotent |
| autonomous execution already running? | the DELETING marker is what makes a late return refuse to write (ADR-3 D2) |
| replacement session? | `[FACT]` safe — a new session is a new row namespace at `exec_generation = 0` |

`[INFERENCE]` **F6 is resolved as a side effect of ADR-3/ADR-9**, which is why the mission's note that
F6 "may be included in the implementation scope if the final architecture naturally resolves it" is
satisfied. No separate F6 work is needed.

---

## 14. Security / context equivalence

`[FACT]` Mapped chain for an interactive turn: provider → tools → `PermissionHandler.check` →
executor → filesystem / network / env, with `cwd`, `permissionMode` and the tool set fixed at
`createSession` time by `setupToolLayer`.

`[FACT]` Mapped chain for a `delegate_task` child (the only existing analogue) and the mismatches:

| Aspect | Interactive | Scheduler child (Model B) | Mismatch? |
|---|---|---|---|
| credentials / provider | the session's provider | fetched per child (`task.ts:245-250`) | no, same source |
| working directory | session `cwd` | **inherited `parentCwd`** (`task.ts:225,255`) | no — and this is the correct choice |
| tool permissions | full set by mode | **reduced** to `EXPLORE_TOOL_NAMES` when parent is plan/readonly/ask | **intentional reduction** |
| environment | process env | inherited implicitly by being in-process | no |
| sandbox mode | `permissionMode` | `allowlist` preserved, else `auto` (`task.ts:257`) | **see below** |
| session ownership | user session | child session id, journal-linked | different by design |
| abort authority | the TUI | Scheduler-owned (new) | different by design |

`[INFERENCE]` The one genuine mismatch to flag is `task.ts:257`:
`parentMode === "allowlist" ? "allowlist" : "auto"`. For a **sub-agent** this is defensible because
the child's *tool set* is already reduced to read-only, so `auto` cannot write anything. For a
**Scheduler** turn the same rule would be unsafe if the tool set were ever widened, because `auto`
means "decide without asking" and the parent may have been in `ask`.

`[DESIGN DECISION]` Therefore ADR-7's rule (always-`explore` for autonomous execution) **subsumes**
this: an autonomous turn never holds a writable tool set, so the `auto` escalation has nothing to
escalate to. `[DESIGN DECISION]` Explicitly: the Scheduler must **not** inherit
`PermissionControl`/Shift+Tab mode changes, because a human changing interactive permissions must
not silently widen an unattended executor's authority mid-run.

`[INFERENCE]` **Does the Scheduler gain or lose authorization versus an equivalent interactive
execution?** As designed: it *loses* — strictly, deliberately, and by construction. That asymmetry is
the safety property, and it should be stated as a design goal rather than treated as a limitation.

---

## 15. Event / presentation contract

`[FACT]` The runtime has 25 durable/replayable `DomainEvent` types with an explicit `DURABILITY`
table (`src/presentation/events.ts`), plus a `PROPOSED_EVENT_TYPES` list for types with no producer
(`["tool.progress"]`). `[FACT]` Renderers consume semantic events; they never read task state for
display.

`[DESIGN DECISION]` Map Scheduler lifecycle onto the **existing** vocabulary rather than inventing a
new event family:

| Scheduler moment | Existing event | Durability | Note |
|---|---|---|---|
| scheduler started / stopped | *none* | — | `[DESIGN DECISION]` process-level, not session-level; do **not** emit |
| task selected | `plan.updated` | durable | the task is now the plan's focus |
| execution running | `turn.started` on the **child** session | durable | already emitted by the kernel (`:248` emits `turn:completed`; `turn.started` is in the vocabulary) |
| tool call | `tool.started` / `tool.completed` / `tool.failed` / `tool.denied` | durable | already emitted by the kernel; `tool.denied` is exactly the approval-refusal case |
| permission waiting | `approval.requested` → `approval.settled` | durable, replayable | vocabulary exists; **ADR-7 makes V1 never emit `approval.requested`** |
| execution finished | `turn.completed` / `turn.failed` / `turn.cancelled` | durable | already emitted |
| task outcome | `result.produced` / `diagnostic.raised` | durable | `diagnostic.raised` fits "blocked awaiting human" |

`[INFERENCE]` **The presentation layer can represent essentially the whole autonomous lifecycle today,
without modification.** That is a genuinely good result and it removes one risk: no renderer work is
needed before enabling.

`[DESIGN DECISION]` **Visibility policy: forward nothing by default.** The `delegate_task` precedent
forwards child events into the parent tagged `forwardedChild` (`task.ts:293-316`), but that exists so
a *user watching a turn* sees sub-agent progress. An autonomous turn has no watching user, and
forwarding would inject unsolicited content into a live TUI.

`[DESIGN DECISION]` Therefore: autonomous child events are **not** forwarded to the interactive
presentation stream. They remain durable on the child session's own journal. The user learns the
outcome through the **task row** (status/blockedReason), which is the durable, replayable,
already-rendered surface.

`[FACT]` `[DESIGN DECISION]` Open question left deliberately: whether a *notification* ("a background
task finished") is wanted. `[DECISION BLOCKED]` — that is a product/UX decision, and this repository
contains no evidence of an intended behaviour.

---

## 16. Failure taxonomy

`[DESIGN DECISION]` Do **not** add task statuses in this phase. The taxonomy below maps existing
outcomes to the existing `TaskStatus` vocabulary and flags the gaps.

| Failure | Durable marker | Status outcome | Retry? | Owner |
|---|---|---|---|---|
| **TASK FAILURE** (work impossible) | model writes it | `FAILED` (`todo.ts:41`) | no (V1) | model |
| **MODEL FAILURE** (provider error) | `attempt_generation` written; no status change | stays `IN_PROGRESS` → next reconcile reverts to `PENDING` | yes, by reconcile | recovery |
| **TOOL FAILURE** | `tool.failed` event; task status unchanged | unchanged | model decides | model |
| **PERMISSION WAIT** | *no durable marker exists* | **STATUS MODEL GAP** | — | — |
| **CONTENT/VERIFICATION FAILURE** | `verification` / `evidence` fields (`model.ts`) | unchanged | model decides | model/verifier |
| **SCHEDULER CONTENTION** | `CLAIM_REJECTED_*`, `exec_generation` unchanged | unchanged (`PENDING`) | yes, next cycle | trigger |
| **SESSION DELETION** | DELETING marker + row gone | row gone | no | deletion path |
| **PROCESS SHUTDOWN** | claim left `IN_PROGRESS`, no marker | reverted by next `reconcile()` | yes, by recovery | recovery |
| **STALE EXECUTION** | generation no longer current | **must not throw** (ADR-3 D2) | no | — |
| **INTERNAL SCHEDULER ERROR** | `SchedulerError` | unchanged | no | operator |

`[FACT]` **STATUS MODEL GAP — permission wait.** `[FACT]` The `TaskStatus` union has no state for
"awaiting human approval": `PENDING | IN_PROGRESS | VERIFYING | BLOCKED | FAILED | RETRYING |
COMPLETED | CANCELLED` (`model.ts:45-53`). `[INFERENCE]` `BLOCKED` is the closest and is already
"eligible but never ready" (`readiness.ts:95-98`) — semantically reasonable for "a human must act".

`[DESIGN DECISION]` Therefore: **[DECISION BLOCKED]** whether a dedicated `AWAITING_APPROVAL` status
is warranted. It is only needed if ADR-7's Option C is adopted. Under V1's always-`explore` rule the
gap is unreachable, so **no new status is required to enable**, and adding one now would be
unjustified surface.

`[FACT]` `RETRYING` remains declared-but-unwritable (6L I1). `[INFERENCE]` If the taxonomy above is
ever implemented, `RETRYING` is the obvious candidate home for a genuine retry state — which would
also retire a dead status. Worth noting, not worth doing now.

---

## 17. Architecture decision records

### ADR-1 — Interactive vs autonomous execution context

- **Problem.** The kernel's turn is a whole-conversation merge behind one busy slot with one
  session-global abort. A Scheduler turn needs isolation, attribution and independent cancellation.
- **Current evidence.** `session.ts:215-256`; 2 production call sites; `delegate_task` child-session
  precedent at `task.ts:243-284`.
- **Constraints.** `vendor/minicore` is the frozen L3 seam; no new kernel abstraction is available;
  the Scheduler must stay policy-free and single-session.
- **Options.** A: reuse the user session. B: child execution session per work item. C: a
  non-conversational execution context.
- **Rejected.** A — fails busy, context, events, abort and approval simultaneously, and is the option
  that would be chosen *by accident* if someone passed the user session to `runTurn`. C — no such
  abstraction exists in the kernel; would require reimplementing turn execution above the frozen seam.
- **Selected.** **B**, built on the `delegate_task` pattern, with four explicit additions the
  precedent does not cover: a Scheduler-owned cancellation source, a `childId` derivation that cannot
  collide with real session ids, an event-visibility policy (ADR §15), and disposal via the existing
  but currently-unused `session.cleanup()` (`session.ts:278`).
- **Consequences.** An autonomous turn has no user-visible conversation, which is correct. It also
  cannot see the user's latest messages — accepted, because a background worker has no use for them.
- **Migration impact.** None.
- **Test requirements.** Isolation tests: child history does not appear in parent history; parent
  `abort()` does not cancel a child; concurrent child and parent turns both succeed; child is
  disposed.
- **Unresolved.** Whether a child should inherit the parent's conversation as seed context
  (`[DECISION BLOCKED]` — no evidence either way in the repository).

### ADR-2 — F1 `IN_PROGRESS` semantic separation

- **Problem.** One column, two meanings; `reconcile()` destroys the user's plan cursor.
- **Current evidence.** STATE AMBIGUITY proven (§5.2): H2 ≡ H5 = `(IN_PROGRESS, exec=1, att=NULL)`
  with opposite required actions. `exec_generation` is monotonic and never reset. 6B's
  `TaskAuthorityMode` already exists but is **per-instance**, so it cannot see a `LEGACY` write.
- **Constraints.** Must not lose the agent's plan cursor (`todo.ts:15-17`); must not require
  redeploying history; the 6H lineage design must remain valid.
- **Options.** A: require `exec_generation > 0`. B: durable execution-ownership marker. C: separate
  task intent from execution state entirely.
- **Rejected.** A alone — **provably insufficient** (§5.2). A + SCHEDULER-authority-in-production —
  converts silent corruption into a hard failure of a legitimate model action. C — correct but a
  task-state redesign far beyond enabling.
- **Selected.** **B**, plus A's condition as a necessary co-condition. The durable fact is "is the
  current `IN_PROGRESS` a Scheduler claim not yet reconciled?", set by `claimTask` and cleared by
  `reconcileIfNoCompletedAttempt`.
- **Consequences.** F1 is fixed **entirely below the Scheduler** — `Scheduler.reconcile()` needs no
  change (`scheduler.ts:526-534` already delegates the decision). The model keeps `todo_write`'s
  cursor. Pre-6I rows behave correctly because the marker defaults to absent (= "not a claim").
- **Migration impact.** One additive column, same idempotent `PRAGMA table_info` mechanism 6K proved.
- **Test requirements.** H1–H5 as a table-driven reconciliation test; legacy-row behaviour; the
  H2/H5 pair must be asserted to differ **only** by the marker.
- **Unresolved.** Column name and whether to instead pursue Option C (`[DECISION BLOCKED]`).

### ADR-3 — F2 session-deletion lifecycle

- **Problem.** Mid-turn deletion throws out of `cycle()` and permanently wedges the instance while it
  holds session ownership.
- **Current evidence.** Executed: the throw, the retained claim, `IDLE` state, and the
  `ownership-unavailable` on replacement. `deleteSession` already orders tasks-first and propagates
  failure (`persistence.ts:693-718`).
- **Constraints.** Must cover out-of-process deletion (TTL, second process) that in-process
  coordination cannot see; must be idempotent; must not resurrect anything.
- **Options.** D1 graceful cancel. D2 orphan-safe return. D3 dispose-before-delete. D4 combinations.
- **Rejected.** D1 alone — a window remains between abort and return. D3 alone — cannot cover
  out-of-process deletion. Wrapping `cycle()` in `try/catch` — converts a crash into a **silent
  permanent stall** and does not release ownership.
- **Selected.** **D2 + D3, with a durable DELETING marker.** D2: a late return classifies "my world
  is gone" as normal and **must clear its own claim** (the wedge is the real defect, not the throw).
  D3: ordering is marker → dispose executors → tasks → session rows.
- **Consequences.** A new durable marker (migration). Session deletion gains a defined in-flight
  policy. The wedge becomes impossible.
- **Migration impact.** Additive marker; no status change.
- **Test requirements.** Delete at each of the 10 race points in §6.1; late return after delete;
  delete-during-shutdown; recreate-with-same-id after delete.
- **Unresolved.** Whether the DELETING marker is a `tasks` column, a session column, or a
  `task_meta` row (`[DECISION BLOCKED]` — placement follows from ADR-9's single-operation decision).

### ADR-4 — User/Scheduler concurrency policy

- **Problem.** U5 burns an execution generation on contention, making a non-attempt
  indistinguishable from a real attempt.
- **Current evidence.** `claimTask` precedes dispatch (`scheduler.ts:325`); a rejected turn is still
  recorded as an ended attempt (`:412-421`, `:446`); the store **already** guarantees "a rejected
  claim creates NO generation" (`store.ts:818-830`).
- **Constraints.** No locks, no queues, no scheduling policy (mission §5).
- **Options.** 1 wait. 2 skip without claiming. 3 claim-then-wait. 4 separate context. 5 prevent while interactive.
- **Rejected.** 1 — unbounded wait across an unknown-length user turn. 3 — reintroduces stranded claims.
- **Selected.** **2**, implemented as a **capacity predicate inside the claim `UPDATE`**, so a
  busy rejection reports `CLAIM_REJECTED_BUSY` and does not advance `exec_generation`. Plus **4** via
  ADR-1, which removes the shared slot entirely. **5** as a cheap optimisation only — correctness must
  not depend on a flag.
- **Consequences.** No lineage redesign needed; the store's existing rejection contract is reused
  verbatim. Contention becomes cheap and non-destructive.
- **Migration impact.** None.
- **Test requirements.** Busy rejection does not advance `exec_generation`; user turn during a
  Scheduler cycle; N concurrent cycles produce one dispatch; a rejected busy claim leaves no residue.
- **Unresolved.** Whether the capacity unit is per-session, per-cwd, or per-process
  (`[DECISION BLOCKED]` — depends on whether cross-session parallelism is wanted, which is ADR-10).

### ADR-5 — Scheduler trigger

- **Problem.** Nothing calls `cycle()`; there is no trigger, so no scheduling exists.
- **Current evidence.** `start()` alone does nothing (verified). Shutdown is `process.exit()`
  (`app.ts:331,337`). A command router and in-band control precedent already exist (`cli/router.ts:3`,
  `PermissionControl.setMode`).
- **Constraints.** No unbounded lifetime before a shutdown contract exists; local-runtime scale only.
- **Options.** startup. session creation. explicit command. background service. timer. task mutation.
- **Rejected.** Timer — an interval with no teardown path is a leak generator. Background service — a
  second long-lived loop in a one-session process. Startup — implies a scheduling policy that V1
  should not have. Task-mutation event — couples the task store to the scheduler, and task writes
  happen from the model.
- **Selected.** **Explicit in-band command**, optionally a bounded "drain" variant. Trigger owner is
  the composition root; the Scheduler stays policy-free. Duplicate triggers are already safe
  (`inFlight` join).
- **Consequences.** Nothing happens unless asked — which is the correct default for a runtime with no
  approval story. Observability is trivial.
- **Migration impact.** None.
- **Test requirements.** Command → one cycle; concurrent commands join; command with no candidates
  is a no-op; stop during command.
- **Unresolved.** Drain bound (wall-clock value) (`[DECISION BLOCKED]` — a product/ops decision).

### ADR-6 — Scheduling policy ownership

- **Problem.** Where selection, retry, priority and fairness belong.
- **Current evidence.** `ready[0]` in graph order (`scheduler.ts:303-313`); the module header
  explicitly disclaims queue/priority/fairness (`:22`); readiness is already fully decided in 5C
  (`readiness.ts:77,90`).
- **Constraints.** Do not invent task semantics; do not put autonomous judgement inside the component
  that owns crash recovery; no retry in V1.
- **Options.** policy in Scheduler. policy in trigger owner. policy in a new component.
- **Rejected.** policy in Scheduler — contradicts its own design lock and would couple recovery to
  judgement. A new component — premature; V1 needs almost no policy.
- **Selected.** **Readiness owns eligibility; the trigger owns when; the graph owns which.** V1 has
  no retry, no priority, no fairness, and **no user-vs-scheduler task distinction** — `TaskProvenance`
  makes the information available if a future policy needs it, but adding a split now would be new
  task semantics.
- **Consequences.** The smallest surface that cannot form a policy bug.
- **Migration impact.** None.
- **Test requirements.** Selection order is graph order; no fairness claim is made; retry does not exist.
- **Unresolved.** Whether a future automatic trigger needs priority/backoff — deferred with ADR-5.

### ADR-7 — Autonomous permission/approval

- **Problem.** `Decision = allow | deny`; a handler needing approval blocks. Unattended execution
  therefore either blocks forever or auto-denies.
- **Current evidence.** `permission.ts:12`; `session.ts:66-68`; the anti-escalation precedent
  `task.ts:170-175`; `setupToolLayer` mode filtering; durable `approval.requested`/`approval.settled`
  events; the durable mutation-journal `pending` substrate.
- **Constraints.** Autonomous intent is unprovable; a background executor is strictly more dangerous
  than a sub-agent because no human watches its approvals.
- **Options.** A auto-deny. B auto-allow within policy. C DEFER/PENDING_APPROVAL. D restrict the tool
  set so no approval is ever needed.
- **Rejected.** A — makes the feature useless. B — no precedent in this repository, and unsafe
  against an unprovable-intent executor. C — architecturally supported but requires a task-status
  vocabulary change and a stable execution identity; premature.
- **Selected.** **D for V1**: autonomous execution always inherits the `explore` read-only tool scope
  and never inherits `PermissionControl` mode changes. A task needing a write becomes `BLOCKED` and
  surfaces to a human. **C is the correct long-term answer and is DEFERRED.**
- **Consequences.** Autonomous work is read-only. This is deliberately less capable than an
  interactive turn, and that asymmetry is the safety property.
- **Migration impact.** None.
- **Test requirements.** An autonomous turn cannot invoke any write/bash/commit tool; cannot mutate
  task status; `todo_write` is absent from its tool set; a task needing a write ends `BLOCKED`.
- **Unresolved.** Whether write-capable autonomous work is ever wanted, and under what policy
  (`[DECISION BLOCKED]` — product decision).

### ADR-8 — Shutdown lifecycle

- **Problem.** SIGTERM calls `process.exit()` directly; no graceful async shutdown; `stop()` waits
  unboundedly.
- **Current evidence.** `app.ts:331,337`; SIGINT emulated in raw mode (`input.ts:840-841`);
  `Scheduler.stop()` awaits without bound (`scheduler.ts:237-253`); kernel `cleanup()` exists
  (`session.ts:278`) and is unused by the sub-agent path.
- **Constraints.** Must bound the wait or shutdown hangs; must work for headless/ACP; must not invent
  a second recovery path.
- **Options.** process-level ordered teardown. UI-level teardown. do nothing.
- **Rejected.** UI-level — SIGTERM can arrive with no TUI. "Do nothing" — unbounded wait.
- **Selected.** **Process-level ordered contract** owned outside the UI: stop new work → prevent new
  claims → signal active execution (new per-turn abort) → **bounded** wait → close persistence →
  exit. **Explicitly: shutdown does NOT reconcile.** A claim left `IN_PROGRESS` with no marker is
  precisely the crash state recovery already handles deterministically; reconciling at shutdown would
  create a second recovery path with different semantics and could revert a still-finishing turn.
- **Consequences.** Shutdown looks like a crash to durable state — intentional, and the reason no
  new recovery logic is needed.
- **Migration impact.** None.
- **Test requirements.** SIGTERM mid-turn; SIGINT in raw mode; bounded wait exceeded; shutdown with
  a live claim then restart and recover exactly once; no orphaned child sessions.
- **Unresolved.** The bound value and whether persistence close is needed at all given SQLite WAL
  (`[DECISION BLOCKED]`).

### ADR-9 — TTL / purge integration

- **Problem.** `purgeExpired` never touches TaskStore, so TTL-purged sessions orphan task rows and
  their lineage (F6).
- **Current evidence.** `persistence.ts:576-592` vs `persistence.ts:711-718`; verified
  `deleteSessionTasks` is idempotent; 6K's ordering rationale.
- **Constraints.** Do not create a second deletion architecture.
- **Options.** one shared operation. two operations kept in sync by convention. patch `purgeExpired`.
- **Rejected.** two operations — already exists and is the bug. Patching `purgeExpired` alone —
  leaves the structural duplication.
- **Selected.** **One operation**, `deleteSessionCompletely`, used by both `deleteSession` and
  `purgeExpired`: DELETING marker → dispose executors → TaskStore cleanup **first** → session rows.
  F6 resolves as a side effect.
- **Consequences.** A single idempotent, retryable, order-correct deletion path. No separate F6 work.
- **Migration impact.** Only the DELETING marker from ADR-3.
- **Test requirements.** purge leaves zero task rows; purge twice is a no-op; purge during a turn;
  purge failure leaves state retryable.
- **Unresolved.** Marker placement (`[DECISION BLOCKED]`, shared with ADR-3).

### ADR-10 — Enablement mechanism

- **Problem.** No flag, env var, or CLI option exists; there must be a safe way to turn this on.
- **Current evidence.** No `MINICODE_SCHEDULER`-style flag exists. A proven opt-in precedent does:
  `MINICODE_ALLOW_LOCAL_CONFIG=1` / `--allow-local-config`, default deny (`src/config.ts`,
  `normalizeConfig`). `[FACT]` 6B already anticipated a composition-root decision and required that
  "tests must assert that no production path sets this" (`store.ts:481-483`).
- **Constraints.** The mission's 10 enablement requirements; must not be weakened to pass the gate.
- **Selected.** **[DECISION BLOCKED]** — deliberately not decided here.
- **Why blocked.** Two requirements depend on decisions taken elsewhere in this document: the
  concurrency unit (ADR-4) determines what "no other live claim" means, and ADR-7 determines what
  authority an enabled Scheduler holds. Designing the flag before those would be designing it twice.
- **What is already decided** (independent of the flag):
  default **OFF**; opt-in must be explicit and per-process; activation **must not** be derived from
  task creation or from a `tasks.db` inspection; startup failure must be **loud** (a `SchedulerError`
  at `start()` already fails closed — `scheduler.ts:213-224`); emergency stop is `stop()` plus the
  flag; telemetry must distinguish autonomous turns via the child `sessionId`
  (`journal: {sessionId: childId, parentSessionId}`); a test must assert no production path sets it,
  as 6B already requires.
- **Test requirements.** Default off; explicit opt-in required; tests cannot enable accidentally;
  no implicit activation from task creation; loud startup failure; emergency disable path.

---

## 18. Migration strategy

`[DESIGN DECISION]` Only two changes alter persistent state: the **ADR-2 execution-ownership marker**
and the **ADR-3/ADR-9 DELETING marker**. Everything else is in-process wiring.

| Change | Kind | Strategy | Old DB behaviour | Repeat migration | Rollback constraint |
|---|---|---|---|---|---|
| ownership marker | new nullable column, default "no claim" | same `PRAGMA table_info` mechanism 6K proved: idempotent, `ADD COLUMN` only, no row rewrite | pre-6I and legacy rows read as "not a claim" → never reconciled, matching current `exec_generation = 0` behaviour | no-op once present | column may be dropped; semantics would revert to F1 |
| DELETING marker | new column or `task_meta` row | same mechanism; placement `[DECISION BLOCKED]` | absent ⇒ not deleting ⇒ current behaviour | no-op | dropping it reopens F2 |

`[INFERENCE]` **Can F1 be corrected without a schema change? No — and this is the evidence-based
answer the mission asked for.** §5.2 proves the required fact is absent from the existing columns, and
6B's `TaskAuthorityMode` cannot supply it because it is per-instance, not durable. Every other option
either leaves the ambiguity (A) or breaks a legitimate model action (SCHEDULER-authority in
production).

`[FACT]` `[INFERENCE]` Migration risk is low: both changes are additive, default to the *current*
behaviour, and are exercised by the same non-destructive, idempotent path 6K validated against a real
pre-6I database. `[INFERENCE]` The one behavioural change is that pre-6I `IN_PROGRESS` rows stop being
reconcilable — which is a **correctness improvement**, but must be stated as an intentional
behaviour change, not slipped in.

---

## 19. Future test architecture

`[DESIGN DECISION]` What must exist before enablement is trusted. None of this is implemented here.

**Unit** — state transitions; status semantics; reconciliation including the H1–H5 table; approval
resolution; ownership acquire/release; DELETING-marker transitions.

**Integration** — real `TaskStore` + real `TaskGraph` + real `session-ownership` + a realistic
`runTurn`; the child-session isolation assertions from ADR-1.

**Process** — separate Scheduler processes (6L's multi-process harness generalised); process restart;
session deletion; SIGTERM/SIGINT mid-turn.

**Race** — user turn vs Scheduler turn (U3/U4/U5, including that a busy rejection does **not**
advance `exec_generation`); deletion vs execution return (all 10 points of §6.1); claim vs stale
snapshot; approval vs shutdown; shutdown vs reconcile.

**Property / state-machine** — lifecycle sequences; session recreation with the same id; lineage
correctness (extend 6L's 5 910-transition collision search to include the new marker); the standing
safety properties (`TERMINAL`, `READINESS`, `NORESURRECT`, `IDENTITY`, `GENMONO`, `LINEAGE`) re-run
against the integrated system.

**Negative** — no authorization bypass (autonomous turn cannot reach a write tool); no readiness
bypass; no completion fabrication; no orphan execution; no generation spent on a non-attempt; no
state ambiguity (assert H2 and H5 differ by the marker).

`[DESIGN DECISION]` **Property testing is the load-bearing class here**, because F1 and F2 are both
*state-space* defects: 6L's exhaustive history search is precisely the technique that would have caught
F1's ambiguity, and it should be extended rather than reinvented.

---

## 20. Implementation roadmap

`[DESIGN DECISION]` Proposed sequence. Each phase is independently verifiable; **none** is authorised
by this document.

| Phase | Scope | Gate |
|---|---|---|
| **6P** | **F1.** Durable execution-ownership marker in TaskStore; reconciliation co-condition. **No Scheduler change.** | H1–H5 table test; legacy-row test; full 6L property suite re-run green |
| **6Q** | **F2 + F6.** DELETING marker; late-return classification; claim self-release; single `deleteSessionCompletely` used by both paths. | All 10 race points; purge leaves zero task rows; recreate-with-same-id safe |
| **6R** | **Autonomous execution context.** Child session per work item; `childId` derivation; Scheduler-owned cancellation; child disposal. | ADR-1 isolation suite; no parent history contamination |
| **6S** | **Approval model.** Always-`explore` tool scope for autonomous turns; `PermissionControl` non-inheritance; `BLOCKED` surfacing. | No write tool reachable; no task-status write; write-needing task ends `BLOCKED` |
| **6T** | **Trigger + concurrency.** Command trigger, bounded drain, capacity predicate in `claimTask`. | Busy rejection spends no generation; concurrent cycles → one dispatch |
| **6U** | **Enablement + shutdown.** Flag, startup-failure path, ordered process-level shutdown, event-visibility policy. | ADR-10 requirements; SIGTERM mid-turn; default-off proven |
| **6V** | **Adversarial production-integration audit.** Re-run the 6N style boundary audit with Scheduler **reachable**. | No new P0/P1 across the boundary |

`[DESIGN DECISION]` **Ordering rationale.** F1 and F2 are first because they are *defects* and they
live entirely in TaskStore, where they can be fixed and proven without touching the runtime. The
context work (6R) follows because it is the largest architectural commitment and is easier to validate
once the durable state is unambiguous. Approval (6S) precedes trigger (6T) so that nothing can be
triggered before its authority is bounded. Shutdown (6U) is last among the enabling work because a
trigger without a shutdown contract is precisely the leak ADR-8 warns about.

`[DESIGN DECISION]` 6P and 6Q are candidates for the same phase — they touch the same file and the
same migration path — but they are listed separately because each has an independent gate and a
different failure mode.

---

## 21. Unresolved decisions

`[DECISION BLOCKED]` items, with what would unblock each:

| # | Question | Unblocked by |
|---|---|---|
| 1 | ADR-2 marker column name; Option A vs Option C long-term | a task-state design decision, not an enabling decision |
| 2 | ADR-3/ADR-9 DELETING marker placement | ADR-9's single-operation decision |
| 3 | ADR-4 capacity unit (session / cwd / process) | whether cross-session parallelism is wanted (ADR-10) |
| 4 | ADR-5 drain bound (wall clock) | product/ops decision |
| 5 | ADR-7 whether write-capable autonomous work is ever wanted | product decision; a policy, not a mechanism |
| 6 | ADR-8 wait bound; whether persistence close is needed | SQLite WAL behaviour under load |
| 7 | ADR-10 the flag itself | ADRs 4 and 7 |
| 8 | ADR-1 whether a child inherits parent conversation as seed | product decision |
| 9 | §15 whether a background-completion notification is wanted | UX decision; no evidence in repo |
| 10 | §16 whether a dedicated `AWAITING_APPROVAL` status is warranted | only if ADR-7 Option C is adopted |

`[INFERENCE]` Nine of ten are **product or naming decisions, not technical unknowns**. That is itself
a finding: the technical analysis for enabling is essentially complete, and what remains is a set of
choices this repository cannot make on its own.

---

## 22. Final design readiness

`[INFERENCE]` **The design is ready to sequence into implementation; the integration is not ready to
ship.**

What this phase established, as answers rather than intentions:

| Question | Answer |
|---|---|
| Who owns `IN_PROGRESS`? | Two writers today. After ADR-2: **the durable row records which**, and the Scheduler remains unaware. |
| Who owns an execution? | The trigger owner creates the context; the child session owns the turn; the task row owns the durable generation. |
| What is a Scheduler turn? | A turn in a **private child session**, never the user's conversation (ADR-1 Model B). |
| What is an interactive turn? | Unchanged, in the user session, with the user as the approval decision-maker. |
| Which context does each inhabit? | Different sessions ⇒ no busy collision, no context contamination, no shared abort. |
| What happens when they collide? | Nothing harmful: a capacity predicate makes contention a **non-consuming** rejection. |
| Who can approve autonomous actions? | **No one is asked** — autonomous turns hold only read-only tools (ADR-7). |
| Who terminates autonomous work? | The process, via an ordered bounded contract (ADR-8); durable state is left in the crash-recoverable shape on purpose. |
| What survives restart? | Durable lineage and the ownership marker. Verified safe in 6L and unchanged here. |
| What survives session deletion? | Nothing. A late return finds no row and refuses to write (ADR-3 D2). |

`[INFERENCE]` **The NO-GO from 6N stands** and this document does not weaken it. F1 and F2 remain
unresolved *in the repository*; they are now **specified**, not solved. §18 records the non-obvious
result that **F1 cannot be fixed without a schema change** — the opposite of the cheap fix 6N's
wording suggested — and §5.2 carries the proof.

`[INFERENCE]` The most valuable single result is that **the Scheduler itself needs almost nothing**:
its store-facing changes are a capacity predicate and a reclassification of stale lineage, and its
`reconcile()` is untouched. The work is in the runtime around it, which is the correct place for it
given that the subsystem's safety properties were earned deliberately.

`[DESIGN DECISION]` Nothing in this phase implements, enables, or partially enables anything.
Scheduler production construction count remains **0**; the production diff is empty.


