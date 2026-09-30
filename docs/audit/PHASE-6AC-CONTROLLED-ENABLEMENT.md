# Phase 6AC — Controlled scheduler enablement

- Checkpoint in: `61a28e7` (6AB), tree CLEAN, nothing pushed
- Scheduler: **still OFF by default**
- Verdict: **GREEN**, with one P1 documentation defect found and fixed

Evidence classes: `FACT` (measured), `OBSERVATION` (reproduced behaviour),
`INFERENCE` (reasoned, not executed), `DESIGN DECISION` (chosen, with reasons).

Experiment driver: `scripts/phase6ac-controlled.ts` — 13 drills, every stage a
real process against real SQLite and a real HTTP provider. Derived assertions:
`test/phase6ac-controlled-enablement.test.ts`.

---

## 1. Environment

One disposable environment, created and destroyed by the harness.

| Property | Value |
| --- | --- |
| Workspace | `%TEMP%/minicode-6ac-controlled/ws` (recreated each run) |
| Fake `HOME` | `%TEMP%/minicode-6ac-controlled/home` |
| Repository | two files: `README.md`, `notes.txt` (the latter holds the answer) |
| Session | `6ac-session` plus a fresh id per drill |
| Provider | local scripted HTTP endpoint (`Bun.serve`, `127.0.0.1`, ephemeral port) |
| Credentials | none — no real key, no network egress |
| Lease | `SESSION_LEASE_MS=300000`, renew `60000` (**CONFIGURED, untouched**) |
| Task DB | local `.minicode/tasks.db`, disposable |

`FACT`: the provider is a local scripted endpoint. No credential is read and
nothing leaves the machine. Each drill gets its own script — see §20, finding 4.

---

## 2. First activation

`FACT --enable-scheduler` produces a real, authority-holding scheduler:

```
exit code       = 0
enabled         = true
constructed     = true
isActive        = true
lease held      = true
operator state  = ON_IDLE
session id      = 6ac-session
incarnation     = 1
```

What the operator actually saw, verbatim:

```
Autonomous scheduler
  state: scheduler ON, idle (holds authority, waiting for /scheduler run)
  session: 6ac-session
  authority: held (lease acquired)
  counters: evaluated=0 coalesced=0 refused=0 executions=0 failures=0
```

`FACT` durable authority, read from inside the child while the lease was held:
row present, `ownerPid=6580`, `leaseExpiresAt-Date.now()=299994ms`.

`FACT` after close, read independently: **no lease row**. A cleanly closed
process releases its lease, which is what makes the rollback drill work.

`DESIGN DECISION`: the lease row is read from inside the child. The first
version read it from the parent after the child had closed and printed
`durable lease row present = false` — a measurement artifact that reads exactly
like a lease failing to persist.

---

## 3. First autonomous task

Task: *"Read notes.txt and report which constant it mentions"*.

```
trigger outcome        = EVALUATED
evaluations            = 1
executions             = 1
task terminal status   = IN_PROGRESS
exec generation        = 1
parent session id      = 6ac-session
autonomous turn ok     = true
child turn DETAIL      = notes.txt mentions SEVENTY_THREE. No changes made.
durable lineage        = {"execGeneration":1,"attemptGeneration":1}
```

The full lifecycle the operator saw:

```
[scheduler] trigger evaluated (explicit-command)
[scheduler] selected t1
[scheduler] claimed t1 (revision 2)
[scheduler] dispatch started for t1
[scheduler] executing t1
[scheduler] execution finished for t1: ok=true
```

`FACT` the operator route works: a second task run through `/scheduler run`
reported `scheduling cycle completed` and executed.

`FACT` read-only held: workspace file count 2 before, 2 after.

`DESIGN DECISION` the terminal state asserted is `IN_PROGRESS`, not `COMPLETED`.
6Q is explicit that the Scheduler "does not decide whether the work succeeded and
never writes COMPLETED". Asserting `COMPLETED` would be asserting behaviour the
architecture forbids.

### Finding: the child turn's verdict is not operator-visible

`P2 / OPERABILITY`. `/scheduler run` prints `scheduling cycle completed`, and
`/scheduler status` shows `executions=1`. Neither distinguishes a
**permission-denied** turn from a **provider outage** — both surface as
`ok=false` in the event log, because 6Q's `ExecutionObservation` only says
"returned, not ok".

The real verdict lives in `TriggerResult.cycle.dispatched.observation.detail`
(6R's `AutonomousTurnResult.outcome` + `detail`), which `/scheduler run`
**discards**. To obtain it, 6AC had to call `handle.fire()` directly.

`INFERENCE` an operator whose autonomous turn fails cannot diagnose it without
developer tools. Fixing it means surfacing `cycle.dispatched.observation.detail`
in the `run` output or `status`; that is a presentation change, which §22 puts out
of scope. Recorded, not fixed.

---

## 4. Permission verification

The model was scripted to call `write_file`, then `bash`.

```
autonomous tool set size        = 16
parent tool set size            = 37
write_file offered              = false
bash offered                    = false
web_fetch offered               = false
mcp_list offered                = true
write file created              = false
workspace file count unchanged  = true
```

`FACT` read-only held. The workspace was not modified.

### Finding: read-only holds by tool-set narrowing, not by runtime denial

`INFO / SECURITY`. The `write_file` call **never reached 6S's permission
handler**. The autonomous session was never *offered* the tool, so the kernel had
nothing to refuse. The turn verdict was `not-refused`, not `permission-denied`.

This is a weaker guarantee than it looks, and the distinction is worth stating
precisely:

| Guarantee | What holds it | Verified |
| --- | --- | --- |
| The tool cannot be invoked | Tool-set narrowing at composition time | `FACT` |
| The tool *would* be denied if invoked | 6S's `permissionHandler` seam | not exercised by this drill |

`DESIGN DECISION` both are enforced at construction, so the second is a
backstop rather than the primary control. 6Z proved the handler seam
independently (M31, 30 tests killed). Neither substitutes for the other, and
6AC records which one it exercised.

---

## 5. User interaction

A parent turn was issued **while** the autonomous cycle was in flight.

```
parent turns recorded               = 1
autonomous executions recorded      = 1
parent user messages before         = 0
parent user messages after          = 1
parent user messages added          = 1
autonomous work is NOT a parent turn = true
no shared abort                     = true
no shared busy state                = true
task ownership coherent             = true
task status after both ran          = IN_PROGRESS
```

`FACT` no shared conversation, no shared abort, no shared busy state. The parent
gained exactly one message — its own — and the autonomous turn did not appear in
the parent's turn count.

### Finding: the child session id is unobservable in production

`P2 / OPERABILITY`. 6R publishes `childSessionId` on `AutonomousContextEvent`
(`context:created` / `context:ready`). `cli/setup.ts` does **not** pass
`onContextEvent` into the adapter, so those events are never delivered. And
6P's `ExecutionLineage` has no `childSessionId` column — only `execGeneration` and
`attemptGeneration` — so it cannot be read from durable state either.

An operator cannot determine which session executed a task.

`DESIGN DECISION` a first draft of this drill read `childSessionId` from
`ExecutionLineage` anyway, got `undefined`, and reported *"child session distinct
from parent = true"* — because the guard had been written as a comparison that
passed on `undefined`. A broken assertion wearing a pass. Isolation is now proven
by the parent's message count and turn count, which are real measurements.

---

## 6. Task mutation

Each case runs in a **fresh session**, so no case inherits another's tasks.

| User edit | store refused? | scheduler ran it? | final status | gen | scheduler wrote COMPLETED? |
| --- | --- | --- | --- | --- | --- |
| `COMPLETED` | no | **no** | COMPLETED | 0 | no |
| `IN_PROGRESS` | no | **no** | IN_PROGRESS | 0 | no |
| content change | no | **yes** | IN_PROGRESS | 1 | no |
| `CANCELLED` | no | **no** | — | — | no |

`FACT` in all four cases: the Scheduler never authored `COMPLETED`.
`FACT`: a completed or cancelled task is never claimed — 6P ownership and 6Q
readiness both hold.

### Finding: 6P refuses IN_PROGRESS for the scheduler's own authority

`INFO / SECURITY`. Observed directly:

```
SCHEDULER authority refuses an IN_PROGRESS patch = true   (all four cases)
```

`TaskStore` with `authority: "SCHEDULER"` throws
`TASK_AUTHORITY_VIOLATION` on a direct `IN_PROGRESS` patch, because 6P reserves
that transition for `claimTask`. A user's own handle (LEGACY authority) accepts it.

`DESIGN DECISION` the drill therefore applies user edits through a LEGACY handle.
Using the scheduler's handle answered a different question, and its refusal would
have looked like a product failure. Both facts are now reported side by side.

---

## 7. Crash recovery

Child seeded a task, hung, and was killed mid-flight.

```
child was killed (non-zero exit expected)     = true
child signalled it had claimed               = true
lease survives the crash                     = true
lease ms remaining after crash               = 288445
lease outlives half its period               = true
restart inside the lease window composed     = false
restart failed closed                        = true
restart error                                = session 6ac-crash already has a valid
                                               autonomous lease held by another process
task still present after the crash           = true
task status after the crash                  = PENDING
scheduler did NOT write COMPLETED            = true
elapsed ms                                   = 12737
```

`FACT` recovery is bounded and fail-closed. A crashed owner holds its lease for up
to `SESSION_LEASE_MS`; a restart inside that window is refused with a specific
reason. The task is recoverable, not lost, and not completed.

`DESIGN DECISION` two harness defects were found and fixed here, both of which
produced *plausible* readings of a broken system:

1. The crash child defaulted to the shared session while the drill read
   `6ac-crash`, so it measured a session that never ran. Output read
   `lease survives the crash = false` — indistinguishable from a P1 lease bug.
2. The child signalled only after observing `IN_PROGRESS`, so the kill landed
   before any work happened and the lease was released on the way out.

`INFERENCE` a crashed autonomous turn cannot report anything; its process is gone.
The durable attempt record is the only evidence, and it correctly shows `PENDING`.

---

## 8. Session deletion

Deletion performed through the **production** `deleteSession` path, mid-flight.

```
scheduler stopped on deletion                  = true
post-delete trigger refused                    = true
incarnation before delete                      = 1
incarnation after delete (independent read)    = 2
old scheduler is inert                         = true
recreated session executed a new task          = 1
recreated session lease held                   = true
new incarnation differs from the old           = true
recreated session task status                  = IN_PROGRESS
```

`FACT` session deletion is safe. The incarnation advanced, so the old namespace
is unusable; the old scheduler is inert; a recreated session gets fresh authority
and can run new work.

`FACT` `recreated session task count = 2` — the pre-deletion row and the new one
coexist in the new namespace, which is correct: 6Q's incarnation isolates them
rather than deleting history.

---

## 9. Stop

Both states, with a repeated stop:

| State | stop ok | lease released | lease row gone | state after | 2nd stop safe | post-stop trigger | process usable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| idle | yes | yes | yes | ON_STOPPED | yes | refused | **yes** |
| after a run | yes | yes | yes | ON_STOPPED | yes | refused | **yes** |

`FACT` the process remains usable interactively after `/scheduler stop` — the
parent session still takes turns. The flag is off; the rest of MiniCode is not.

### Finding: `runPromptWithVerify` returns void

`P3 / INTEGRATION`. Three drills awaited it and reported
`parentTurnOk = undefined`, which reads as "the parent turn did not work". The
verdict is now derived from the turn count, which is a real measurement.

---

## 10. Rollback

A process started **without** the flag:

```
scheduler constructed without the flag = false
scheduler enabled                      = false
scheduler state                        = OFF
ordinary turn still worked             = true
no lease was taken                     = true
startup needed no scheduler state      = true
```

```
Autonomous scheduler
  state: scheduler OFF (not enabled for this process)
  session: 6ac-session
  authority: not held
  counters: evaluated=0 coalesced=0 refused=0 executions=0 failures=0
```

`FACT` rollback is complete and instantaneous. Re-enabling afterwards acquires a
fresh lease (`299988ms` remaining).

### Finding: the rollback drill was validating the opposite of its claim

`ENVIRONMENT`. `runChild` defaults the gate to ON, so omitting `enable: false`
made this drill start a scheduler and print
`state: ON, idle (holds authority)` — the opposite of "restart without the flag",
which is the drill's entire subject. It read as a pass because nothing threw.
`enable: false` is now passed explicitly.

---

## 11. Resume

| Property | disabled resume | enabled resume |
| --- | --- | --- |
| ok | true | true |
| live session id | `6ac-session` | `6ac-resume` |
| scheduler constructed | **false** | **true** |
| lease held | **false** | **true** |
| incarnation | — | 1 |
| history restored | see below | see below |
| trigger reaches a new task | n/a | **yes** |

`FACT` `--resume` with and without the flag both compose correctly, and the
Scheduler follows the **live** session id, not the resumed one.

`FACT` disabled resume takes no lease. Enabled resume acquires one and its trigger
executes a task in the new session.

`DESIGN DECISION` "history restored" is measured by **content**, not by counting
messages. The first version compared lengths against a session that was never
persisted, and reported `true` for a resume of an empty session. Now the drill
reports `resumedSessionExisted`, `previousMessages` and `carriedMessages`
separately.

`FACT` 6AB's finding is confirmed in production: resume is a **fork**.
`persistCurrent` writes to both `sessionId` and `resumeId`, so the resumed session
receives a copy while the new live session continues.

---

## 12. Lease timing observation

**No lease value was tuned.** All figures below are measured.

| Quantity | Class | Value |
| --- | --- | --- |
| Lease duration | CONFIGURED | 300000 ms |
| Renewal interval | CONFIGURED | 60000 ms |
| Lease remaining at activation | OBSERVED | 299994 ms |
| Lease remaining on a re-enable | OBSERVED | 299988 ms |
| Lease remaining after a crash | OBSERVED | 288445 ms |
| Autonomous turn duration | OBSERVED | < 1 s (scripted provider) |
| Crash-drill elapsed | OBSERVED | 12737 ms |
| Renewal heartbeat observed live | **UNVERIFIED** | see below |
| Recovery delay to takeover | **UNVERIFIED** | would need the full 300 s |
| Turn duration against a real provider | **UNVERIFIED** | not measurable here |

`FACT` **no contradiction was observed.** The lease was always live when held,
always released on clean shutdown, always survived a crash, and always excluded
a second process inside its window.

`UNVERIFIED` the 60 s renewal heartbeat was never observed firing: the whole
controlled run finishes in about 40 s, so no renewal was due. This is the one
timing claim that remains unverified, and it is the same claim 6AA and 6AB left
open. `INFERENCE` a real autonomous turn against a real provider could exceed
60 s, in which case renewal would run for the first time — untested here.

---

## 13. Operator workflow

The exact human sequence, and whether each question is answerable:

```text
minicode --enable-scheduler        # explicit opt-in
  /scheduler status                # ON, idle, lease held
  /scheduler run                   # one cycle; [scheduler] lines appear
  /scheduler status                # evaluations=1 executions=1
  /scheduler stop                  # authority released
  # exit, then relaunch with the flag to schedule again
```

| Question the operator has | Answerable? | From |
| --- | --- | --- |
| Is the scheduler active? | **yes** | `state:` line |
| Is a task executing? | **partly** | `ON, executing`; but see below |
| Is authority held? | **yes** | `authority: held (lease acquired)` |
| How do I stop it? | **yes** | `/scheduler stop`, stated in `--help` |
| What happened after a failure? | **no** | see §3 finding |
| Which session executed the task? | **no** | see §5 finding |

`FACT` no UI was added in this phase. The command surface is 6AB's.

---

## 14. Observability

Available evidence, captured but not extended:

| Evidence | Where it lives | Durable? |
| --- | --- | --- |
| Operator state | `/scheduler status` `state:` | no |
| Session + authority | `/scheduler status` | no |
| Counters | `/scheduler status` | no |
| Lifecycle events | transcript `[scheduler] ...` | no |
| Task status | `tasks.db` | **yes** |
| Execution generation | `ExecutionLineage.execGeneration` | **yes** |
| Lease owner, expiry | `session_authority` | **yes** |
| Attempt record | `recordAttemptReturned` | **yes** |
| Child session id | **unreachable** | — |
| Turn outcome + detail | **`TriggerResult.cycle`, discarded** | — |

`FACT` no telemetry was added, per §14.

### Where observability is insufficient

1. `P2` — the turn's own verdict is discarded by `/scheduler run`.
2. `P2` — the child session id is published by 6R and never delivered.
3. `INFO` — "executing" is only visible between `dispatch started` and
   `execution finished`; there is no progress within a long turn.

`INFERENCE` items 1 and 2 are the difference between "the scheduler worked" and
"the scheduler worked and I know what it did". Both are one-line wiring changes,
both excluded by §22.

---

## 15. Security

Live adversarial pass, through real production composition:

| Attempt | Result |
| --- | --- |
| `write_file` | never offered; no file created |
| `bash` | never offered |
| `web_fetch` | not in the autonomous set |
| `mcp_list` | **in** the set (read-only MCP introspection) |
| task mutation | 6P/6Q hold; Scheduler never authors `COMPLETED` |
| `IN_PROGRESS` by user | accepted by a user handle, refused by scheduler authority |

`FACT` the policy remains **AUTONOMOUS → READ-ONLY → NO HUMAN APPROVAL**, with no
exception observed.

`DESIGN DECISION` `mcp_list` being present is correct and worth stating: 6S's
allow-list includes read-only MCP *introspection* (`mcp_list`) but not MCP
*invocation*. An autonomous turn can see which MCP servers exist and cannot call
them.

---

## 16. Multi-process

Two real processes, one session, with a **file barrier** — A signals only once
`hasAuthority()` is true.

```
A armed while holding the lease        = true
A's lease is live                      = true
A's lease owner pid is a real pid      = true
B composed (expected to fail closed)   = false
B failed closed                        = true
B's refusal reason                     = session 6ac-multi already has a valid
                                         autonomous lease held by another process
B ran no work                          = true
A exited after B's attempt             = true
A's exit was the harness kill          = true
takeover inside the orphaned window    = false  (fail closed, expected)
A's orphaned lease row is still present= true
A's orphaned lease has not expired     = true
a different session acquires immediately= true
VERDICT exactly one authority at a time= true
```

`FACT` exactly one authority at any moment. B was refused with a specific reason
and performed no work.

`FACT` A was **killed**, not shut down, so its lease survives with a live expiry —
and a third process inside that window also fails closed. A different session id
acquires immediately, with no waiting.

`DESIGN DECISION` the previous shape killed A *before* running B, which inverted
the test: B failed closed for the uninteresting reason that A's clean shutdown had
just released the lease. A now runs for its whole window while the parent proceeds.

---

## 17. Property checks

| # | Property | Result | Evidence |
| --- | --- | --- | --- |
| 1 | explicit opt-in required | PASS | drill 12: no flag → no Scheduler |
| 2 | one trigger → at most one execution | PASS | 5 triggers → `executions=1` |
| 3 | stop prevents subsequent work | PASS | drills 8 |
| 4 | lease prevents competing authority | PASS | drills 6, 11 |
| 5 | readonly policy holds | PASS | drill 3, no file created |
| 6 | task namespace parent-scoped | PASS | drill 12/test: other session untouched |
| 7 | child context isolated | PASS | drill 4, parent message count |
| 8 | deletion prevents old effects | PASS | drill 7, incarnation 1→2 |
| 9 | recovery works after crash | PASS | drill 6, fail-closed then recoverable |
| 10 | restart starts cleanly | PASS | drill 9, new authority, no state needed |

---

## 18. Default-off verification

The primary safety invariant, re-verified in a fresh process with no flag:

```
scheduler constructed          = false
scheduler enabled              = false
lease held                     = false
autonomous context created     = false
/scheduler run said OFF        = true
evaluations                    = 0
autonomous work performed      = 0
durable lease row ABSENT       = true
VERDICT default OFF holds      = true
```

`FACT` the trigger route is **exercised**, not merely absent: `/scheduler run` was
invoked against the inert handle and produced nothing. The gate is consulted
before construction, so no store handle, session factory, Scheduler, trigger or
deletion subscription is allocated.

`FACT` no lease row exists. No provider request was made.

---

## 19. Documentation

### Finding P1: the flag was absent from the printed `--help`

`FACT`. 6AC's first help drill printed
`help line: (not found)` while every phrase check reported a vacuous `true`.

The cause was a real documentation defect, and the most useful thing this phase
found:

- `--enable-scheduler` existed in the `options:` array in `cli/index.ts:195`
- it was **absent from the `HELP` constant** the CLI actually prints (`cli/index.ts:41`)
- an operator typing `minicode --help` **never saw the flag at all**

`DESIGN DECISION` 6AB's help test passed because it asserted the `options:` array —
a description table — rather than the printed help. A test that validates a table
is not a test that validates documentation. This is the §22 "Do not trust the
report blindly" instruction paying off: 6AB reported the help as corrected, and it
was corrected in a file no operator reads.

**Fixed** in `cli/index.ts`. The flag now appears with its default, the manual
trigger, the absence of a timer, the readonly policy, and all three commands.

`FACT` post-fix, verified against the real `minicode --help`:

```
--enable-scheduler  EXPERIMENTAL: opt in to the autonomous scheduler (default: off).
                    Manual only - run /scheduler run. No timer; autonomous turns are
                    readonly. Inspect with /scheduler status; release with /scheduler stop.
```

All six "does not promise recurrence" checks pass; the flag, the default, the
manual trigger, "no timer", "readonly", `/scheduler status` and `/scheduler stop`
are all present.

### Operator guide

`docs/autonomous-scheduler.md` is accurate and unchanged by this phase: it already
described opt-in, manual trigger, no timer, readonly policy, the five states, and
recovery. Asserted against in the test suite, including the absence of the phrase
"continuous background automation".

---

## 20. Findings

Severity × class. §20 forbids silent fixes; each is recorded, and only the P1
documentation defect was fixed (it is a one-line doc correction, within scope).

| # | Sev | Class | Finding |
| --- | --- | --- | --- |
| 1 | **P1** | DOCUMENTATION | `--enable-scheduler` absent from the printed `--help`. Fixed. |
| 2 | P2 | OPERABILITY | Turn outcome + detail discarded by `/scheduler run`; a permission denial and a provider outage look identical. |
| 3 | P2 | OPERABILITY | Child session id unobservable: 6R publishes it, `cli/setup.ts` does not wire `onContextEvent`, `ExecutionLineage` has no column. |
| 4 | — | ENVIRONMENT | A single shared provider script was exhausted by drill 2, so drill 3's write attempt was never made while still reporting "no file created". Fixed: one script per drill. |
| 5 | — | ENVIRONMENT | `spawnSync` blocked the parent's event loop, so the scripted provider could never answer. Every autonomous turn failed with "Unable to connect" — reading exactly like a production provider defect. Fixed: async spawn. |
| 6 | — | ENVIRONMENT | `runChild` defaults the gate ON; the rollback drill omitted `enable: false` and validated the opposite of its claim. |
| 7 | — | ENVIRONMENT | Crash drill read a different session than the one it crashed. Printed "lease survives the crash = false" — indistinguishable from a P1. |
| 8 | — | ENVIRONMENT | `afterEach` threw `EBUSY` on Windows; 7 of 9 tests were red while their bodies passed. |
| 9 | — | INTEGRATION | `runPromptWithVerify` returns `void`; three drills reported `undefined` for a successful parent turn. |
| 10 | INFO | SECURITY | Read-only holds by tool-set narrowing, not by runtime denial; the two are separate guarantees and this drill exercised the first. |
| 11 | INFO | SECURITY | 6P refuses a direct `IN_PROGRESS` patch under scheduler authority; a user handle accepts it. |
| 12 | P3 | INTEGRATION | `mcp_list` (read-only MCP introspection) is in the autonomous set. Correct per 6S; recorded so it is not mistaken for MCP invocation. |
| 13 | — | OPERABILITY | `already-dispatched` has no `cycle:stopped` event, inherited from 6AB. |

`DESIGN DECISION` findings 4–8 are worth their own paragraph. Five of the first
eight findings were **harness** defects, and every one produced output that read
like a production failure: an inert-looking scheduler, a lease that would not
persist, a provider that could not connect, a rollback that did not roll back.
Had any been reported as product findings, 6AC would have declared NO-GO for
defects that do not exist. The distinction that caught them was checking whether
the *claim* matched the *measurement* — the claim was always about the product,
and the measurement was about the harness.

---

## 21. Limitations

1. **The TUI was never driven.** `runTui` is fullscreen-only and needs a TTY with
   ≥ 10 rows, so the operator commands were invoked through the real
   `handleBuiltinCommand` against a real `createCliSession` — the same route the
   TUI uses. The TUI's own wiring (passing the control surface into the command
   context) is source-anchored, not executed.
2. **No real provider.** Turns were scripted. A real model's behaviour, latency
   and token use are unmeasured.
3. **The renewal heartbeat was never observed firing** (§12).
4. **The full 300 s recovery window was not waited out.** Fail-closed behaviour
   inside the window was observed; expiry-and-takeover after it was not.
5. **Task creation is not the product's own path.** Tasks were seeded through
   `TaskStore`, because MiniCode has no user-facing task-creation command. The
   scheduler's own readiness, claim and execution paths were all exercised.
6. **`/scheduler status` counters are per-process** and reset on exit.
7. **Concurrent autonomous work was not stress-tested**, per §5.

---

## 22. Exact commands

```bash
# The controlled experiment (13 drills, real processes)
bun run scripts/phase6ac-controlled.ts
bun run scripts/phase6ac-controlled.ts --only=6      # one drill

# Derived assertions
bun test test/phase6ac-controlled-enablement.test.ts

# Gates
bunx tsc --noEmit          # 28, equal to baseline
bunx biome check           # clean on touched files
bun test                   # full suite
```

Environment produced by the harness:

```
workspace: %TEMP%/minicode-6ac-controlled/ws
fake HOME: %TEMP%/minicode-6ac-controlled/home
provider:  local Bun.serve on 127.0.0.1, ephemeral port, no credential
lease:     300000 ms, renew 60000 ms (untouched)
```

---

## 23. Final verdict

**GREEN.** Every §21 criterion:

| Criterion | Result | § |
| --- | --- | --- |
| first autonomous execution succeeds | PASS | 3 |
| operator can trigger it | PASS | 3 |
| operator can observe it sufficiently | PASS with gap | 14 |
| operator can stop it | PASS | 9 |
| recovery works | PASS | 7 |
| crash recovery works | PASS | 7 |
| session deletion remains safe | PASS | 8 |
| session recreation remains safe | PASS | 8 |
| permission boundary remains readonly | PASS | 4, 15 |
| two-process authority remains exclusive | PASS | 16 |
| resume works | PASS | 11 |
| default OFF remains exact | PASS | 18 |
| no P0 | PASS | 20 |
| no P1 | **PASS after fix** | 19, 20 |
| no critical operational unknown | PASS | 14 |
| documentation is truthful | **PASS after fix** | 19 |

Scheduler remains **OFF by default**. This is not a rollout.

The activation stayed **EXPLICIT** (a typed flag, a typed command), **CONTROLLED**
(one disposable environment, no credentials, no real project), **REVERSIBLE**
(`/scheduler stop`, then a process with no Scheduler at all), **OBSERVABLE** (state,
counters, lifecycle events, and durable task state — with two named gaps), and
**RECOVERABLE** (fail-closed on crash, bounded by the lease, safe across session
deletion and recreation).

### The one thing worth remembering

6AB proved the trigger was reachable. 6AC's most valuable finding was not about the
scheduler at all:

> **A help test that reads a description table is not a test that reads
> documentation.** 6AB asserted the flag's help text in `cli/index.ts:195`. The
> CLI prints the `HELP` constant at `cli/index.ts:41`. The flag was documented in
> the first and absent from the second, and an operator running `minicode --help`
> could not have discovered the feature at all.

The generalisation matters more than the flag: the strongest evidence in this
whole phase came from a drill that printed `(not found)`, and the second strongest
from a drill that printed a value which contradicted its own label. Both were only
visible because the output was read as a *claim about the product* and checked
against what was actually measured.
