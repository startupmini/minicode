# PHASE 6A — SCHEDULER NEW ARCHITECTURE DESIGN LOCK

Workspace: `D:\recover\minicode-20260928\reconstruction`
Audited HEAD: `99980db` (`fix: enforce TaskGraph type safety`)
Protected specimen `D:\git\minicode`: **never accessed or modified**

---

## DECISION

# SCHEDULER DESIGN READY

All fourteen gate areas have **explicit decisions** (§25). Nothing critical
remains UNKNOWN. Every statement is classified in §26.

**The contract is NEW ARCHITECTURE.** The original `scheduler.ts` is permanently
unrecoverable, exactly like `graph.ts` was. Historical artifacts are used only as
*evidence of prior thinking*, never as proof of shipped behaviour.

---

## 1. Purpose

TaskGraph answers **"what is executable right now, and why?"**
TaskStore answers **"what is durably true?"**
Scheduler answers **"what do we attempt next, under what lifecycle and recovery
rules?"**

Scheduler owns the **attempt lifecycle**: it observes the graph, picks one
candidate, claims it through TaskStore, hands it to an execution bridge, observes
the outcome, and reconciles stranded work after a crash.

### Scheduler OWNS

- discovering the candidate set from a TaskGraph
- selecting **one** candidate deterministically
- claiming that candidate (via TaskStore, never directly)
- dispatching to an execution bridge
- observing the execution outcome
- reconciling stranded `IN_PROGRESS` / `VERIFYING` work
- releasing/clearing its own claim bookkeeping
- its own lifecycle state machine

### Scheduler EXPLICITLY DOES NOT OWN

| excluded | why |
|---|---|
| task identity allocation | `TaskStore.nextId` is the sole allocator; Scheduler never mints an id |
| graph construction | TaskGraph does it, from one snapshot |
| graph mutation | TaskGraph is immutable; there is no mutator to call |
| dependency/blocker derivation | TaskGraph's exclusive job; Scheduler re-derives nothing |
| task verification / completion proof | belongs to the verifier / completion authority |
| durable persistence | every write goes through TaskStore's public methods |
| tool execution, permissions, abort, provider logic, context | the existing agent loop's authority |

## 2. Authority boundaries

```
  TaskStore.getSnapshot(sessionId)     ── read, authoritative
        │
        ▼
  new TaskGraph(snapshot)              ── READ-ONLY derivation
        │
        ▼
  Scheduler.tick()                     ── decision only
        │
        ├── claims via TaskStore.patchTask(..., { expectedRevision })
        │
        ▼
  execution bridge                     ── runs the agent turn
        │
        ▼
  outcome observed                      ── never becomes COMPLETED by Scheduler
        │
        ▼
  verifier / completion authority       ── owns COMPLETED
        │
        ▼
  TaskStore mutation                    ── sole durable writer
```

| authority | owns |
|---|---|
| **TaskStore** | all durable truth; id allocation; validation; transaction boundary |
| **TaskGraph** | read-only interpretation of one snapshot; readiness; blockers; validity |
| **Scheduler** | *this process's* attempt lifecycle and recovery. No durable authority. |
| **verifier** | completion adjudication |
| **execution bridge** | actually running work |

A Scheduler with no TaskStore write access is *observation only*. It cannot
corrupt durable state by accident; it can only fail to progress.

## 3. Execution bridge

**Verified gap: no execution bridge exists today.** Nothing in `src/` accepts a
task and runs it; `runTurn` appears **only** in the recovered `p77` artifacts
(0 occurrences in current source).

Scheduler therefore **defines a minimum bridge contract and does not implement
it** (§3 of the brief). It is an injected dependency:

```ts
interface TaskExecutionBridge {
  execute(input: TaskExecutionRequest): Promise<TaskExecutionOutcome>
}

interface TaskExecutionRequest {
  readonly taskId: string          // canonical, for correlation + logs only
  readonly sessionId: string       // LOGICAL task session, not the process
  readonly instruction: string     // title-derived work description
}

type TaskExecutionOutcome =
  | { readonly kind: "succeeded"; readonly summary: string }
  | { readonly kind: "failed"; readonly reason: string }   // rejected promise
  | { readonly kind: "dispatch-failed"; readonly reason: string } // sync throw / no bridge
```

Distinctions that matter and are therefore explicit:

- **`dispatch-failed`** — the bridge was never entered (sync throw, bridge
  `null`, bridge returned non-promise). The task was never attempted.
- **`failed`** — the bridge was entered and the attempt failed. Work may have
  happened.
- **`succeeded`** — the turn completed. **This is NOT completion** (§11).

**The bridge must not mutate TaskStore.** It receives a request and returns an
outcome; it has no store reference. Any state change flows Scheduler → TaskStore.

Scheduler must not reimplement tool execution, permissions, abort handling,
provider logic or context management. If the real bridge must change any of
those, the bridge is wrong, not Scheduler.

## 4. Candidate discovery

```
TaskStore.getSnapshot(sessionId)  →  new TaskGraph(snapshot)  →  candidates
```

| situation | behaviour |
|---|---|
| valid graph, non-empty `readyTasks()` | candidates = `readyTasks()` **in TaskGraph's order** |
| valid graph, empty `readyTasks()` | no candidates → `IDLE`, no error, no mutation |
| **invalid graph** (`validity().valid === false`) | **no candidates. Never dispatch from an invalid graph.** Log the diagnostics. |
| stale graph | see §14 — re-read before claiming |

**Ordering: TaskGraph's, unchanged.** `order` ASC then `taskId` ASC. Scheduler
adds **no** priority, score, urgency or weight. The graph's order is already
deterministic and already durable-derived; re-deriving it would be a second
source of truth for the same question.

**On the historical `ready[0]`:** `p77` shows `discover()` returning
`{ ready: string[] }` and a caller indexing it. Taking the first element is
*adequate* for V1 but the historical snippet is **not** adopted as recovered
behaviour. Decision, as NEW ARCHITECTURE: `candidates[0]` of the deterministic
graph order is the V1 selection rule (§5). It is justified independently — it is
the minimal rule that is deterministic and needs no invented priority.

## 5. Selection

**V1 = exactly one task per cycle, the first in deterministic graph order.**

Explicitly *not* designed in V1, because none is required to make progress:

| rejected for V1 | why not now |
|---|---|
| multiple concurrent tasks | needs a concurrency model, a claim-per-task invariant and a failure-containment story. None needed. |
| priority / urgency scoring | invents an ordering the durable model does not carry. |
| fairness / round-robin | needs persistent per-scheduler cursor state; contradicts determinism for no V1 benefit. |
| starvation avoidance | impossible to reach with one-task-per-cycle over a finite ready set. |
| dependency-depth preference | TaskGraph already answers "is it ready"; re-deciding is duplication. |

**V1 selection is a pure function of the snapshot.** Given identical snapshot
content, the same task is selected. That is the determinism guarantee, and it is
testable without any timing.

## 6. Claiming

**TaskStore is the sole authority. TaskGraph does not claim. Scheduler does not
write status except through TaskStore.**

```
candidate (from a graph)
      ↓  MUST revalidate against authoritative state first
TaskStore.getTask(sessionId, taskId)
      ↓  still PENDING?  graph said ready, so any other status = lost the race
TaskStore.patchTask(sessionId, taskId,
                   { status: "IN_PROGRESS" },
                   { expectedRevision: current.revision })
      ↓
claimed
```

| question | decision |
|---|---|
| exact CAS condition | `expectedRevision === current.revision`, read via `getTask` in the same claim attempt |
| revision requirement | **mandatory.** A claim without `expectedRevision` is a defect, not a fallback. |
| graph invalid | never reached — no candidates exist |
| already claimed | `getTask` returns `IN_PROGRESS` (or any non-`PENDING` status) ⇒ **abandon this candidate, do not claim, do not error** |
| stale revision | `TASK_STALE_REVISION` ⇒ abandon candidate, re-read snapshot on the next tick. **Not** a retry loop. |
| deleted task | `TASK_NOT_FOUND` ⇒ abandon candidate, do not recreate. Deletion semantics are another component's. |
| unknown task id | cannot occur from a real graph; if injected, treated as `TASK_NOT_FOUND`. |

### VERIFIED LIMITATION — the CAS is not atomic

This is the most important finding of 6A and it constrains the whole design.

**VERIFIED CURRENT SOURCE** (`src/task/store.ts`):

```
L474  const current = this.getTask(sessionId, taskId)      // READ — outside any transaction
L476  if (opts.expectedRevision !== current.revision) throw TASK_STALE_REVISION   // CHECK — outside
L495  return db.transaction(() => {                        // WRITE transaction begins here
L500    UPDATE tasks SET … revision = revision + 1
L501    WHERE session_id = ? AND task_id = ?               // NO  `AND revision = ?`
```

The revision check is a **read-then-write performed outside the write
transaction**, and the UPDATE is **not revision-guarded at the SQL level**. Also
verified: `updateTask` is a pure alias for `patchTask` (L523-530), and there is
**no public transaction starter** (`withTransaction` is absent; only
`inTransaction()`, a read-only depth query, and 4 internal `db.transaction()`
sites).

**Consequence, stated plainly:** `expectedRevision` detects *sequential*
staleness. It does **not** provide mutual exclusion between two processes. Two
claimers can both read revision `R`, both pass the check, and both write `R+1` —
the last writer wins and **both believe they claimed the task**.

**Design decision:** Scheduler V1 claims correctness for **one process, one
Scheduler instance, one session** and treats cross-process contention as an
**open, documented risk (§12)**, not as solved. It must not claim a guarantee the
substrate cannot provide.

**Prerequisite for cross-process safety (NEW ARCHITECTURE, future phase):**
TaskStore must grow an atomic claim primitive whose UPDATE is guarded by
`AND revision = ?` and reports rows-affected, so the loser gets a definitive
negative instead of a silent overwrite. That is a TaskStore change and is
**explicitly out of scope for 6A** (§31). Until it exists, S4 is satisfied
*in-process only*, and the report says so.

## 7. Crash recovery

**Chosen semantics: at-least-once.** Justified in §22.

Process death is analysed at every point:

| crash point | durable state | recovery |
|---|---|---|
| before claim | task still `PENDING` | nothing to do; next tick re-discovers it |
| **after claim, before dispatch** | `IN_PROGRESS`, never attempted | **the dangerous window** — reconciled to `PENDING`, retried |
| after dispatch started, during execution | `IN_PROGRESS`, attempt may be partially done | reconciled to `PENDING`, retried ⇒ **possible duplicate side effects** |
| after execution, before outcome observed | `IN_PROGRESS`, outcome lost | reconciled to `PENDING`, retried ⇒ work may run twice |
| after observation, before completion by verifier | `VERIFYING` or `IN_PROGRESS` | `VERIFYING`→`PENDING`; `IN_PROGRESS`→`PENDING` |

**Recovery is reachable two ways, and BOTH are required:**

1. **At startup** — the process has no memory, so the only way to learn about
   stranded work is to read durable state.
2. **In-process, on a tick** — a hung or wedged attempt leaves `IN_PROGRESS` with
   no completion event while the process is still alive.

**The P77 lesson, taken seriously.** VERIFIED HISTORICAL EVIDENCE: three tasks
stranded permanently in `IN_PROGRESS`; the scheduler "sat IDLE with zero
selectable work and no in-process path back"; only *constructing a new Scheduler*
restored liveness. Two design consequences, both normative:

- **S8: no stranded `IN_PROGRESS` may exist without a recovery path.**
- Reconciliation is therefore **also** performed periodically during normal
  operation, not only at startup. V1 reconciles on **every** `tick()`, which is
  the minimum that cannot reproduce P77.

## 8. Lease / reservation

**V1 has NO lease and NO reservation.**

A durable lease requires durable lease state — a lease owner and expiry. The
current `tasks` schema has no such columns, and inventing one is a TaskStore
migration outside 6A's scope. A lease is not introduced "because crashes exist":
at-least-once plus reconciliation already guarantees progress.

**Duplicate-execution risk is documented, not hidden:** a task may execute more
than once (§22). Where that risk is handled:

| layer | responsibility |
|---|---|
| Scheduler | **not** idempotent. It may dispatch the same task twice. By design. |
| execution bridge | must tolerate re-invocation for the same `taskId` |
| **task instruction / tools** | must be idempotent where side effects exist. **This is where idempotence belongs.** |
| verifier | must treat a second completion proof as corroboration, not corruption |
| future lease | would *narrow* the duplicate window; it would not remove it |

A lease is recorded as a **future** option, trigger condition: two or more
concurrent Scheduler instances for one session become a real requirement.

## 9. Reconciliation

**Startup *and* every tick.** Reads durable state; never consults the graph for
authority.

| `TaskStatus` | Scheduler may reconcile? | to |
|---|---|---|
| `PENDING` | **no** | — (already the resting state) |
| `BLOCKED` | **no** | — (an external cause owns it) |
| `IN_PROGRESS` | **YES** | `PENDING` |
| `VERIFYING` | **YES** | `PENDING` |
| `COMPLETED` | **NO — forbidden** | — |
| `CANCELLED` | **NO — forbidden** | — |
| `FAILED` | **NO — forbidden** | — |
| `RETRYING` | **no** | — (V1 owns no retry orchestration) |

Justification for the split: `IN_PROGRESS` and `VERIFYING` are the only states
asserting *in-flight activity* with no durable proof of liveness, so a process
that cannot prove it is still running must release them. The three terminal
states are **irreversible facts**, not in-flight claims; rewriting them would
destroy evidence and could resurrect deliberately abandoned work. `BLOCKED`
carries an external cause the Scheduler neither set nor understands.

**Reconciliation is guarded per-task by `expectedRevision`**, so a concurrent
legitimate claim is not clobbered; a `TASK_STALE_REVISION` means someone else
touched it and the Scheduler leaves it alone.

No `PAUSED` is introduced, and none may be reconciled *to*.

## 10. Retry

**Scheduler V1 owns NO retry.** Three distinct concerns, deliberately separated:

| retry kind | owner | why not Scheduler |
|---|---|---|
| transport retry (HTTP/MCP hiccup) | the existing transport layer | below Scheduler's altitude; already handled there |
| model retry (rate limit, overload) | the provider layer | likewise; re-implementing would duplicate backoff |
| **task execution retry** | **out of scope in V1** | needs a retry counter, backoff and a give-up policy. None invented. |

No retry counters, no `RETRYING` transitions, no backoff are designed here.
After a failed attempt the task is left `FAILED` and becomes ready again only if
a human or another component changes it — reconciliation does **not** touch
`FAILED`.

**If V2 adds task retry, it must add durable retry state first** (a counter the
schema does not have). Designing the policy without the substrate would produce a
contract that cannot be honoured.

## 11. Completion / verification

**Scheduler never proves completion and never writes `COMPLETED`.**

```
execution outcome
      ↓
Scheduler OBSERVES (S9)
      ↓
verifier / completion authority adjudicates
      ↓
TaskStore.patchTask(..., { status: "COMPLETED", verification, evidence })
```

VERIFIED CURRENT SOURCE: a completion gate already exists and is **not** in the
store. `src/tools/todo.ts` exports an injectable
`CompletionEvidence` / `CompletionVerdict` (`unverified | passed | failed`) via
`setCompletionEvidence`, defaulting to `unverified`, which still permits
completion. The recovered `store.orig.ts` comment says completion-with-evidence
is enforced in `normalizeTodos` and **"must not be duplicated into the store"** —
so TaskStore is deliberately not the adjudicator.

**Scheduler's permitted outcome writes** (via TaskStore, CAS-guarded):

| observation | Scheduler writes | never |
|---|---|---|
| `dispatch-failed` (never attempted) | `IN_PROGRESS` → `PENDING` | `COMPLETED` |
| `failed` (attempted, failed) | `→ FAILED` | `COMPLETED` |
| `succeeded` | `→ VERIFYING` | `COMPLETED` |

`COMPLETED` is reachable **only** through the completion authority. A successful
agent turn is evidence to be verified, not a verdict. This is invariant **S9**.

## 12. Concurrency

**V1: one active claim per Scheduler instance, and one Scheduler instance per
session per process.**

| topology | V1 behaviour | guaranteed? |
|---|---|---|
| one Scheduler, one session | one claim at a time | **yes** |
| two `tick()` calls re-entrant | serialized in-process; a tick in progress blocks the next | **yes** |
| two Scheduler instances, same session, same process | **forbidden by construction** — not a runtime lock | caller contract |
| two Scheduler instances, same session, two processes | **both may claim** (see §6) | **NO — documented risk** |
| different sessions, same process | independent; separate snapshots and claims | yes |
| different sessions, shared TaskStore DB | independent rows; SQLite serialises writes | yes |

**No global lock is designed.** A global lock would be a process-wide mutable
resource in a system whose whole design leans on per-session immutability, and it
would serialise unrelated sessions for no V1 benefit.

The cross-process row is a **known, accepted V1 limitation with a named
prerequisite** (§6), not an oversight. Scheduler must not pretend to hold an
exclusion it cannot enforce.

## 13. Session / process ownership

**Scheduler scope: per (process, logical session).** Never global, never
process-wide.

Three identities kept strictly separate:

| identity | scope | owned by |
|---|---|---|
| **logical task session** (`sessionId`) | the durable task namespace | TaskStore |
| **Scheduler instance** | one in-process object per session | this design |
| **execution process** | the agent loop / bridge | existing execution layer |

**S12: scheduler identity ≠ task identity.** A Scheduler has **no** task id of
its own. It holds a `sessionId` and, transiently, the id of the *currently
claimed* task — which is borrowed from TaskStore, never minted. Nothing in the
Scheduler may be used to derive, infer or reconstruct a task id.

A Scheduler for session A can never claim a task of session B: the session is
part of every store call, and the snapshot is per-session.

## 14. Staleness

`TaskGraph.sourceMaxRevision` is documented as a **weak hint** (5B §15), and
5D.1 re-confirmed its measured weakness: adding a task does not raise it.

**Decision: Scheduler treats it as a cheap re-read trigger only.**

| use | decision |
|---|---|
| ignore entirely | no — a free signal is worth having |
| **trigger a re-read** | **yes** — compare the graph's `sourceMaxRevision` against a fresh `getSnapshot` result; if the fresh snapshot's max revision differs, the graph is behind |
| reject a stale graph outright | no — a weak hint cannot justify refusing work |
| use as CAS / version guard | **FORBIDDEN** — the claim's authority is `getTask().revision` + `expectedRevision`, never this field |

**The claim path never trusts the graph's view of status.** It re-reads the
authoritative row with `getTask` and requires `PENDING` before writing. So a
stale graph costs at most one wasted `getTask` — it can never cause a wrong
claim. That is the whole point of S7.

## 15. Lifecycle

Scheduler lifecycle is **separate** from `TaskStatus` and never mixed with it.

```
CREATED ──start()──► RUNNING ◄──tick() has work──► IDLE
                       │  ▲                          │
            stop()     │  └──────tick() has work────┘
                       ▼
                   STOPPING ──► STOPPED
                   
  any state ──unrecoverable error──► STOPPED   (no silent self-resurrection)
```

| scheduler state | meaning | may dispatch? |
|---|---|---|
| `CREATED` | constructed, never started | no |
| `RUNNING` | started, actively cycling | yes |
| `IDLE` | started, no candidates | no |
| `STOPPING` | stop requested; in-flight attempt not awaited | no |
| `STOPPED` | terminal | no |

`RUNNING ⇄ IDLE` is a normal transition, **not** an error. A scheduler that goes
`IDLE` and stays there is behaving correctly, and that is precisely the P77
failure mode — so the *ticking* must continue (reconciling), never silently stop.

## 16. Task state transitions

Using only the eight real `TaskStatus` values. **No `READY`, no `PAUSED`.**

| from | to | owner | trigger |
|---|---|---|---|
| `PENDING` | `IN_PROGRESS` | **Scheduler** | successful claim (§6) |
| `IN_PROGRESS` | `PENDING` | **Scheduler** | `dispatch-failed`, or reconciliation |
| `IN_PROGRESS` | `VERIFYING` | **Scheduler** | outcome `succeeded` |
| `IN_PROGRESS` | `FAILED` | **Scheduler** | outcome `failed` |
| `VERIFYING` | `PENDING` | **Scheduler** | reconciliation only |
| `VERIFYING` | `COMPLETED` | **verifier / completion authority** | evidence passes |
| `VERIFYING` | `FAILED` | verifier (not Scheduler) | evidence fails |
| `COMPLETED` | — | **nobody** | terminal |
| `CANCELLED` | — | **nobody** (Scheduler) | terminal |
| `FAILED` | — | **nobody** (Scheduler) | terminal |
| `BLOCKED` | `PENDING` | **not Scheduler** | the cause is external |
| `RETRYING` | — | **not Scheduler V1** | no retry ownership |

**Scheduler owns exactly four transitions**, all in the `IN_PROGRESS` region.
Every write is CAS-guarded and reaches TaskStore only via `patchTask`.

## 17. Failure modes

Every mode has an explicit outcome. **No silent state transitions.**

| mode | behaviour |
|---|---|
| claim race (`TASK_STALE_REVISION`) | abandon candidate; **no retry loop**; re-read next tick |
| already claimed (non-`PENDING`) | abandon candidate silently; not an error |
| unknown task (`TASK_NOT_FOUND`) | abandon; never recreate; never allocate an id |
| transaction failure | propagate; task left at its prior status; Scheduler goes `STOPPED` |
| graph invalid | **zero candidates, zero dispatch**; diagnostics recorded |
| graph stale | re-read (§14); the claim revalidates authoritatively regardless |
| bridge unavailable (`null`) | treat as `dispatch-failed`; task back to `PENDING` |
| bridge sync throw | catch, convert to `dispatch-failed`; task back to `PENDING` |
| bridge promise rejection | convert to `failed`; task to `FAILED` |
| unhandled exception in `tick()` | Scheduler → `STOPPED`. **Never silently continues** in a possibly-inconsistent state. |
| session removed mid-flight | `TASK_NOT_FOUND`; abandon; do not recreate the session |

Distinguishing sync-throw from rejection is deliberate (§3): the first means
"never attempted" (retryable), the second means "attempted" (evidence-bearing).

## 18. Idempotence

| operation | repeatable? | why |
|---|---|---|
| discovery | **yes** | pure function of a snapshot; no side effects |
| selection | **yes** | deterministic; identical snapshot ⇒ identical choice |
| claim | **yes, with the same precondition** | the second attempt sees non-`PENDING` and abandons. Self-limiting. |
| reconciliation | **yes** | already-`PENDING` is a no-op; CAS protects a concurrent claim |
| **dispatch** | **NO** | the only non-idempotent step. Nothing prevents a second execution. |

**Exactly-once is not promised and cannot be** without either a lease or
transactional side-effect coupling, neither of which exists (§8).

**The duplicate-dispatch window, named precisely:**

```
claim lands IN_PROGRESS
   ├─ crash / hang  ──► reconciliation resets to PENDING ──► re-claim ──► execute
   └─ dispatch happened, outcome lost ───────────────────► execute AGAIN
```

**S14 makes this explicit rather than silent.** Consequences: a task that
appends to a file, sends a message, or spends money **may do so twice**. Only
idempotent-by-construction work is safe in V1. Where to fix it is §8's table —
primarily the task instruction and the tools it invokes, **not** the Scheduler.

## 19. Observability

Minimal, and **strictly separate from durable task state (S13)**. An observation
never changes a `TaskStatus`; a durable change is never justified by an
observation.

```ts
type SchedulerEvent =
  | { kind: "candidate-discovered"; count: number; graphValid: boolean }
  | { kind: "selected"; taskId: string }
  | { kind: "claim-succeeded"; taskId: string; revision: number }
  | { kind: "claim-failed"; taskId: string; reason: string }   // race/absent
  | { kind: "dispatched"; taskId: string }
  | { kind: "execution-returned"; taskId: string; outcome: TaskExecutionOutcome["kind"] }
  | { kind: "execution-failed"; taskId: string; reason: string }
  | { kind: "recovered"; taskIds: string[] }                  // reconciliation acted
```

Deliberately excluded: no new event bus, no re-design of the presentation
architecture, no persistence of events. A V1 emitter callback (or an injected
sink) is sufficient; if the project already has an event surface, V1 reuses it
and adds nothing.

**`claim-failed` is not an error event** — losing a race is normal operation.
Emitting it as a failure would make normal contention look like a fault.

## 20. Public API

**Minimum surface supporting the V1 lifecycle.** Internal steps are *not*
exposed; the brief warns against auto-exposing every operation, and each internal
step is a separate testable unit reached through `tick()`.

```ts
class Scheduler {
  constructor(opts: SchedulerOptions)     // sessionId, store, bridge, onEvent?
  start(): void                          // CREATED → RUNNING; runs recovery
  stop(): Promise<void>                  // RUNNING/IDLE → STOPPING → STOPPED
  tick(): Promise<TickResult>            // one full cycle; the unit of work
  getLifecycle(): SchedulerState         // read-only
  getActiveClaim(): { taskId: string; revision: number } | null
}
```

| internal step | exposed? | why |
|---|---|---|
| `discover()` | **no** | observable via `candidate-discovered`; tests reach it through `tick()` |
| `select()` | **no** | pure; not a consumer concern |
| `claim()` | **no** | must be driven by the tick to keep the one-claim invariant |
| `dispatch()` | **no** | internal to `tick()` |
| `recover()` | **no** | runs inside `start()` and every `tick()` |

`tick()` is the only way to make progress, which is what keeps
"one active claim" and "reconcile every tick" as structural properties rather
than conventions.

## 21. Scheduler state machine

Distinct namespace from `TaskStatus`; a Scheduler state can never be persisted
onto a task, and a task status can never be a Scheduler state.

| from | event | to | side effect |
|---|---|---|---|
| `CREATED` | `start()` | `RUNNING` | run reconciliation, then enter the cycle |
| `RUNNING` | `tick()`, work found | `RUNNING` | claim → dispatch → observe |
| `RUNNING` | `tick()`, no work | `IDLE` | none |
| `IDLE` | `tick()`, work found | `RUNNING` | claim → dispatch → observe |
| `IDLE` | `tick()`, no work | `IDLE` | reconciliation already ran |
| `RUNNING`/`IDLE` | `stop()` | `STOPPING` | stop accepting cycles |
| `STOPPING` | in-flight settled **or** abandoned | `STOPPED` | no further dispatch |
| any | unrecoverable error | `STOPPED` | never self-resurrect |
| `STOPPED` | `tick()` | `STOPPED` | **rejected**, not a silent no-op |

`tick()` on a `STOPPED` scheduler is a **rejected call**, not a quietly ignored
one — silent acceptance is how a stopped subsystem looks alive.

## 22. At-least-once analysis

**Chosen: at-least-once.** Not at-most-once (it would strand work, reproducing
P77), not exactly-once (unachievable without a lease or coupled side effects).

**Why at-least-once is the right V1 trade:** the alternative failure modes are
asymmetric. At-least-once can duplicate side effects; at-most-once can *lose*
work entirely and leave a task stranded with no path back. Duplicates are
visible, attributable (via `recovered` events) and mitigable by idempotent task
design. Silent loss is neither.

**The crash window, stated without hedging:**

```
  patchTask(status: IN_PROGRESS)   <-- committed
        │
        │   <-- WINDOW OPENS: task is durably claimed
        │       but no attempt has been made, and the process
        │       may die here with no outcome ever recorded
        ▼
  dispatch / execute
        │
        │   <-- attempt may have partially happened
        ▼
  outcome observed
        │
        ▼
  verification
```

Any death inside the window yields: `IN_PROGRESS` → reconcile → `PENDING` →
re-claim → **execute again**. The first attempt's side effects, if any, are
**not** undone.

**Where idempotence must live — not in the Scheduler:**

1. **Task instruction / tools** — the only place that can be made idempotent per
   effect. V1's honest contract: *only idempotent tasks are safe to schedule.*
2. **Execution bridge** — tolerate re-invocation for the same `taskId`.
3. **Verifier** — a repeated completion proof is corroboration, not corruption.
4. **Future lease** — would narrow the window, not remove it.

## 23. Graph / Scheduler interaction

```
TaskStore.getSnapshot(sessionId)     fresh, authoritative, one statement
        ↓
new TaskGraph(snapshot)              immutable, read-only
        ↓
readyTasks()                         candidates (valid graph only)
        ↓
Scheduler.tick()                     select, revalidate, claim, dispatch
```

**Scheduler MUST NOT:** resolve task identity, derive dependencies, infer
blockers, mutate a `GraphNode`, or treat a graph as durable authority. Every one
of those is TaskGraph's or TaskStore's job, and duplicating them would create a
second source of truth for the same question.

**After any TaskStore mutation, the next cycle re-reads.** A claim changes
`revision` and `status`, so the graph the tick started from is immediately stale
by construction. V1 therefore treats the graph as **per-cycle and disposable**:
one snapshot per tick, used for that tick, discarded. There is no cached graph
and no cross-tick graph reuse — which removes the entire stale-graph class of
bugs rather than managing it.

S6 (graph invalid ⇒ no execution) is enforced at the single point where
candidates are produced, so it cannot be bypassed by any other path.

## 24. Test model (design only — no tests written)

| # | category | essential assertion |
|---|---|---|
| 1 | candidate discovery | ready set is passed through unchanged, in graph order |
| 2 | deterministic selection | same snapshot ⇒ same task, across repeated ticks and instances |
| 3 | **graph invalid** | `readyTasks()` from an invalid graph ⇒ **zero dispatches** |
| 4 | empty ready set | `IDLE`, no store write, no error |
| 5 | claim CAS | `expectedRevision` always supplied; stale ⇒ abandon, no retry loop |
| 6 | claim race | two candidates, one already claimed ⇒ second abandoned silently |
| 7 | stale revision | `TASK_STALE_REVISION` ⇒ no write, no exception escaping the tick |
| 8 | dispatch success | outcome `succeeded` ⇒ `VERIFYING`, **never** `COMPLETED` |
| 9 | dispatch **synchronous** failure | sync throw ⇒ `PENDING` (never attempted) |
| 10 | dispatch **asynchronous** failure | rejection ⇒ `FAILED` (attempted) |
| 11 | recovery | stranded `IN_PROGRESS` ⇒ `PENDING`; terminal states untouched |
| 12 | **duplicate-execution window** | crash-after-claim ⇒ a second dispatch occurs; test asserts the window exists rather than hiding it |
| 13 | session isolation | Scheduler for A never touches B's tasks |
| 14 | stop / start | no dispatch in `STOPPING`/`STOPPED`; `tick()` rejected after stop |
| 15 | retry behaviour | Scheduler never writes `RETRYING`; never touches `FAILED` |
| 16 | completed exclusion | `COMPLETED` is never reconciled nor claimed |
| 17 | cancelled exclusion | `CANCELLED` is never reconciled nor claimed |
| 18 | failed exclusion | `FAILED` is never reconciled nor claimed |
| 19 | unknown / deleted task | `TASK_NOT_FOUND` ⇒ abandon, never recreate |
| 20 | P77 regression | stranded `IN_PROGRESS` **is** recovered by an in-process tick, with no new Scheduler |
| 21 | tick idempotence | a tick with no candidates performs zero writes |
| 22 | re-entrancy | concurrent `tick()` calls never produce two claims |

Test 20 is the one that would have caught P77, and it is listed as mandatory.

## 25. Invariants (normative)

| # | invariant |
|---|---|
| S1 | TaskGraph is read-only; Scheduler performs no graph mutation |
| S2 | TaskStore is the sole durable mutation authority |
| S3 | Scheduler never allocates, formats or infers a `taskId` |
| S4 | every claim supplies `expectedRevision` — **in-process** mutual exclusion; cross-process is an open, documented gap (§6) |
| S5 | only a successful TaskStore write becomes a durable transition |
| S6 | an invalid graph never produces execution |
| S7 | stale candidates are revalidated against `getTask` before every claim |
| S8 | a crash cannot leave `IN_PROGRESS` without an in-process recovery path |
| S9 | Scheduler cannot write `COMPLETED` — the completion authority does |
| S10 | no durable `READY` is ever written |
| S11 | no `PAUSED` exists or is introduced |
| S12 | scheduler identity ≠ task identity |
| S13 | observations are not durable state and never justify one |
| S14 | duplicate execution is explicit, not hidden; Scheduler is not idempotent at dispatch |
| S15 | Scheduler writes only the four transitions in §16, all CAS-guarded |
| S16 | `COMPLETED`, `CANCELLED`, `FAILED` are never reconciled |
| S17 | dispatch occurs only from a valid graph's `readyTasks()` |
| S18 | `sourceMaxRevision` is never used as a CAS or version guard |
| S19 | a graph is per-cycle and disposable; no cross-tick graph reuse |
| S20 | a `STOPPED` Scheduler rejects `tick()` rather than silently accepting it |
| S21 | Scheduler holds no global mutable state and no global lock |

## 26. Decision gate — all fourteen areas

| gate area | status | §|
|---|---|---|
| scheduler scope | **DECIDED** — per (process, session) | 13 |
| candidate discovery | **DECIDED** — `readyTasks()`, graph order, invalid ⇒ none | 4 |
| selection | **DECIDED** — one per cycle, `candidates[0]`, deterministic | 5 |
| claim semantics | **DECIDED** — CAS via `expectedRevision`, revalidate first | 6 |
| crash recovery | **DECIDED** — at-least-once, six crash points | 7, 22 |
| lease model | **DECIDED** — none in V1, with a trigger condition | 8 |
| retry ownership | **DECIDED** — Scheduler owns none | 10 |
| completion ownership | **DECIDED** — observes only; verifier owns `COMPLETED` | 11 |
| concurrency | **DECIDED** — one claim per instance; cross-process gap named | 12 |
| lifecycle | **DECIDED** — 5 states, separate from `TaskStatus` | 15, 21 |
| execution bridge | **DECIDED** — minimum contract defined, not implemented | 3 |
| public API | **DECIDED** — 6 members, internals private | 20 |
| observability | **DECIDED** — 8 events, separate from state | 19 |
| invariants | **DECIDED** — 21 normative | 25 |

**No critical semantic remains UNKNOWN. → SCHEDULER DESIGN READY.**

## 27. Forensic classification (§1)

| finding | classification |
|---|---|
| `TaskStatus` = exactly 8 values | **VERIFIED CURRENT SOURCE** |
| `patchTask`/`updateTask` accept `expectedRevision` → `TASK_STALE_REVISION` | **VERIFIED CURRENT SOURCE** |
| revision check is read-then-write **outside** the write transaction; UPDATE has no `AND revision = ?` | **VERIFIED CURRENT SOURCE** — the §6 constraint |
| `updateTask` is an alias for `patchTask` | **VERIFIED CURRENT SOURCE** |
| no public transaction starter; only `inTransaction()` + 4 internal sites | **VERIFIED CURRENT SOURCE** |
| `store.claim`, `store.enableSchedulerAuthority` **do not exist** | **VERIFIED CURRENT SOURCE** (absent) |
| TaskStore has **no general transition validator**; `TASK_INVALID_TRANSITION` is used only for "BLOCKED requires blockedReason" | **VERIFIED CURRENT SOURCE** |
| completion gate is injectable `CompletionEvidence` in `src/tools/todo.ts`, default `unverified` (still permits completion) | **VERIFIED CURRENT SOURCE** |
| `activeClaim`, `runTurn` — 0 occurrences in current source | **VERIFIED CURRENT SOURCE** (absent) |
| `new Scheduler(sessionId, {store, runTurn, instruction})`, `runCycle`, `discover() -> {ready}`, `getActiveClaim`, `getLifecycle`, `store.claim(sessionId, taskId, revision)` | **HISTORICAL DESIGN EVIDENCE** — call sites in recovered `p77-repro.ts`/`p77-verify.ts`; proves an API *shape* once existed, **not** any behaviour |
| P77: three tasks stranded in `IN_PROGRESS`, scheduler IDLE with "no in-process path back", fixed only by constructing a new Scheduler | **HISTORICAL DESIGN EVIDENCE** — a failure mode, used as a design constraint (S8) |
| `readyTasks` name | **HISTORICAL DESIGN EVIDENCE**; the implemented `readyTasks()` is NEW ARCHITECTURE |
| `canExecute`, `blockingDeps`, `topological`, `sourceRevision`, `isReady`/`frontier` | **no evidence anywhere** — not adopted |
| everything else in this document | **NEW ARCHITECTURE** |
| original `scheduler.ts` behaviour | **permanently UNKNOWN** — recovery closed, not guessed |

**False leads rejected**, as in 5A: `lease` hits are LSP/session/config leases;
`claim` hits are `reclaim`/prose; `COMPLETED`/`FAILED` counts are tool-call and
provider results; `reconcil` is the *presentation* adapter and session
checkpoint, not a task scheduler; `retry` is the verifier/provider transport
loop; `verifier.ts` `maxCycles` is auto-verifier retry, not dependency cycles.

## 28. Explicit NEW ARCHITECTURE declaration

**The Scheduler specified here is entirely NEW ARCHITECTURE.** The original
`src/task/scheduler.ts` is permanently unrecoverable — it existed only in an
unpublished local build and was never committed (5A.1, 5A.2).

The contract was derived from **verified current TaskStore and TaskGraph
semantics** plus explicit requirements. Historical artifacts informed *which
problems matter* (P77's stranding is the single most useful thing they told us)
and nothing about *how they were solved*.

No statement here is a recovery.

---

## STOP

Design only. **0 source changes, 0 test changes, 0 commits.**

Not implemented and not modified: Scheduler · TaskGraph · TaskStore · todo
protocol · MCP · execution loop · deletion semantics. Nothing pushed.

Two decisions in this document need a later phase before they can hold beyond a
single process, and both are named rather than assumed:

1. **An atomic claim primitive in TaskStore** (`AND revision = ?` on the UPDATE,
   with a rows-affected result). Until it exists, S4 holds in-process only.
2. **A durable lease**, only if concurrent Scheduler instances per session ever
   become a real requirement.
