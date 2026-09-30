# Phase 6AB — Production trigger, observability & operator lifecycle

- Checkpoint in: `51bfc7a` (6AA), tree CLEAN, nothing pushed
- Scheduler: **still OFF by default**
- Verdict: **GREEN** — see §20

Evidence classes used throughout: `FACT` (measured or read from source),
`OBSERVATION` (reproduced behaviour), `INFERENCE` (reasoned, not executed),
`DESIGN DECISION` (chosen, with the alternatives and the reason).

---

## 1. 6AA blocker reproduction

6AA's finding, restated precisely: the enablement gate was correct, and
`--enable-scheduler` produced a real Scheduler holding a real lease — from which
production made exactly one method call.

```
[FACT] At 51bfc7a the complete set of method calls production made on the
handle was ["stop"]:
    const methods = [...setup.matchAll(/productionScheduler\s*\.\s*(\w+)/g)]
6AA asserted this as `expect(methods).toEqual(["stop"])`.
```

The blocker is reproduced here not as a claim but as an **inverted assertion**.
`test/phase6aa-enablement-readiness.test.ts` §4 is retained, inverted:

```
[FACT] production now reaches fire() from exactly ONE source, and it is the
operator command:
    const fireSites = [...commands.matchAll(/\.\s*fire\s*\(\s*"([a-z-]+)"\s*\)/g)]
    expect(fireSites).toEqual(["explicit-command"])
```

The two tests were inverted rather than deleted. A 6AA audit that simply stopped
asserting the absence of a trigger would let the same regression return
unnoticed — and the entire reason 6AA existed is that "the helper is correct" was
proven repeatedly while the product stayed inert.

`test/phase6ab-production-trigger.test.ts` §1 also records the call surface
*behaviourally*, with a `Proxy` over the real handle rather than a source scan:

```
[FACT] after `/scheduler run` the recorded production call surface contains
"fire" and does not contain "stop".
```

A `Proxy` proves the route **calls** the method. A grep proves the string
`fire` exists somewhere in the file. Only the first is evidence.

---

## 2. Selected trigger surface

**Chosen: an explicit CLI command, `/scheduler run`.** One surface, no timer.

The candidate surfaces §2 listed, and what each would have required:

| Surface | Verdict | Reason |
| --- | --- | --- |
| **Explicit CLI command** | **SELECTED** | Already exists (`handleBuiltinCommand`), already captured by the TUI into the transcript, needs no new infrastructure, and is deterministic by construction. |
| Session startup | rejected | Would fire a cycle before the operator could see a prompt, making "did it run?" unanswerable. Also indistinguishable from the accidental automatic triggering §6 forbids. |
| Task-mutation event | rejected | `FACT` (6T §2, re-verified here): `TaskStore` writes are silent. There is no event to subscribe to. Building one is a new subsystem, not a trigger. |
| Existing idle/event hook | rejected | `FACT`: the kernel bus is per-session and carries no task events. Same objection. |
| Automatic background trigger | rejected | §6 and §23 forbid it, and §25 lists it as a design decision that must not be invented. |

```
[DESIGN DECISION] 6T's TriggerSource already carried "explicit-command" -
AVAILABLE BUT UNUSED. 6AB uses the seam that was designed for this rather than
inventing a mechanism. The value "explicit-command" is now live; "startup",
"task-mutation", "interval", "event" and "manual" remain test-only.
```

One scheduling cycle per invocation. `FACT`: a second `/scheduler run` against an
already-dispatched task produces `no task was ready` and no second execution
(property 11).

---

## 3. Trigger ownership

**Chosen: the production runtime, via the `CliSession` it already returns.**

```
[FACT] cli/setup.ts:1709  productionScheduler,          <- the handle, exposed
[FACT] cli/setup.ts:1710  schedulerObservability,
[FACT] cli/setup.ts:228   productionScheduler: ProductionSchedulerHandle
```

`DESIGN DECISION`: ownership sits on the composition root's return value, which
*is* the production runtime. Explicitly **not** in TaskStore, TaskGraph, task
state or a module-level singleton — the handle holds an `AbortController`, a
lease token and a subscription, none of which are durable facts, and a global
would make the per-session scoping 6T designed for impossible to keep.

M12 proves the negative: constructing the Scheduler against a process-global
session instead of the session's own is **KILLED** (10 tests).

---

## 4. Reachability

The full production chain, executed rather than described:

```
real createCliSession({ schedulerEnabled: true })
  -> real createProductionScheduler (the ONE production construction site)
    -> real handle on the real CliSession
      -> real handleBuiltinCommand("/scheduler run")
        -> real Scheduler.cycle()
          -> real TaskStore over real SQLite
            -> real autonomous turn over real HTTP
```

`FACT` (observable result of `/scheduler run` with one ready task and one seeded
provider reply):

```
[scheduler] trigger evaluated (explicit-command)
[scheduler] selected t1
[scheduler] claimed t1 (revision 2)
[scheduler] dispatch started for t1
[scheduler] executing t1
[scheduler] execution finished for t1: ok=true
```

and the durable row moved `PENDING -> IN_PROGRESS` with
`getExecutionLineage().execGeneration > 0`, while the local provider received
exactly one real HTTP request.

### The terminal state is IN_PROGRESS, and that is correct

`DESIGN DECISION` — and the single most load-bearing assertion in the phase.
6T's scheduler "does not decide whether the work succeeded and never writes
COMPLETED". The cycle's own stop reason here is `already-dispatched`: it handed
one item to the autonomous executor and stopped. An early draft of this test
asserted `COMPLETED` and failed. Asserting it would have meant asserting
behaviour the architecture deliberately forbids, and a green test would have
hidden that. The test now asserts `IN_PROGRESS` plus recorded lineage, and says
why.

---

## 5. Trigger semantics

Every case §3 and §16 name, observed from the production route:

| Case | Outcome | Observable result |
| --- | --- | --- |
| Trigger, task ready | `EVALUATED` | cycle runs, task claimed, turn executed, `IN_PROGRESS` |
| Trigger, no ready task | `EVALUATED` + `no-candidates` | prints "no task was ready"; **0 provider calls** |
| Trigger while running | `COALESCED` | "a cycle was already running; folded into it"; no second run |
| Trigger after stop | refused | "not active"; **0 evaluations**; no silent success |
| Trigger after session deletion | refused | "not active"; 0 provider calls |
| Trigger after authority loss | `EVALUATED` then cycle stops `authority-lost` | state becomes `ON_STOPPED`; **cause is shown** |
| Trigger with lease stolen | cycle refuses at the authority check | `authority-lost`, task stays `PENDING`, 0 provider calls |
| Unknown subcommand | usage | prints usage; does not guess |

`FACT`: a refused trigger is never converted into a successful scheduling. The
one case where the handle returned `null` unexpectedly is reported as "trigger
refused for an unknown reason" rather than swallowed.

No new task states were created. `FACT`: this phase adds no status, no transition
and no field to the task model.

---

## 6. Stop semantics

`/scheduler stop` calls `handle.stop("scheduler-stopped")`, which — per 6U's
existing implementation — in order: refuses further triggers (`trigger.dispose()`),
signals the live turn (`cancelActive`), awaits the cycle to unwind
(`awaitSettled`), stops the Scheduler, and releases both the process-local
ownership and the durable session lease.

`DESIGN DECISION`: the reason is `scheduler-stopped`, not `emergency-stop`. The
latter is reserved for authority loss; an operator deliberately pressing stop is
the supported path, and the reason lands in the activity log.

No hot-toggle was added. §11 forbids one and 6U already rejected a runtime switch
as unable to stop a live turn. There is deliberately no `/scheduler start`.

**Coverage** (§10): stop→stop, stop while idle, stop after close, stop→run→stop,
stop with no active execution, stop during the run path. All no-crash, no
duplicate release, no execution after stop. `FACT`: `close()` after a manual stop
resolves and does not release twice.

---

## 7. Observability

`src/task/scheduler-observability.ts` — a new projection fed by the Scheduler's
own event stream.

`DESIGN DECISION`: **no new event type and no reinterpretation of an existing
one.** Every answer is already present in the two unions 6T defined. 6AA's
finding was that nothing was listening, not that the vocabulary was insufficient.
Adding an event would have been a semantic change to a layer §23 puts out of
scope.

`DESIGN DECISION`: the **probe is authoritative, events are a refinement.** An
operator asking "is it on?" must never be told "idle" by a stale counter while
the handle says the Scheduler is stopped. `state()` consults the handle first and
only uses the event hint to distinguish idle / executing / error.

`DESIGN DECISION`: only the two reasons 6Q/6X document as **self-disposed**
(`authority-lost`, `session-superseded`) may set the stopped hint. Inferring stop
from e.g. `ownership-unavailable` would make `/scheduler status` assert "STOPPED"
while `isActive()` said true — an operator told a falsehood by a diagnostic, which
is the one failure mode observability exists to prevent.

All nine §7 questions, and where each is answered:

| Question | Answered by |
| --- | --- |
| Is Scheduler enabled? | `state()` -> `OFF` (gate shut) |
| Did it acquire authority? | `isActive()`; `start()` throws without a lease |
| Did trigger occur? | `trigger:evaluated` / `coalesced` / `refused` |
| Which task was selected? | `task:selected` |
| Did execution start? | `task:execution_started` |
| Did execution return? | `task:execution_completed` |
| Was it cancelled? | `execution_completed{ok:false}` + cycle stop reason |
| Did authority disappear? | `cycle:stopped{reason:"authority-lost"}` |
| Did the Scheduler stop? | `noteStopped()` from the stop route |

The four operator states §7 requires, all reachable and tested:

| State | How an operator reaches it |
| --- | --- |
| `scheduler OFF` | no flag |
| `ON, idle` | flag, before any trigger |
| `ON, executing` | a cycle in flight |
| `ON but STOPPED` | `/scheduler stop`, `close()`, or lost lease |
| `last cycle failed` | `cycle:invalid_graph` / `trigger:cycle_failed` |

`FACT`: a throwing presentation sink cannot take a cycle down — the same rule 6T
applies to `Scheduler.emit` and `TriggerCoordinator.emit`, applied a third time
at the projection, so the three layers cannot disagree about who may fail.

`FACT`: diagnostics are in-memory and lost on exit. Durable task state survives;
diagnostics do not. This is stated in the operator documentation rather than
implied.

---

## 8. Event routing

`FACT`: live notices go to `transcript.pushInfo(...)`, which appends with
`kind: "system"` — a distinct transcript kind from `user`, `assistant`,
`activity` and `approval`.

That is the whole of §8: a scheduler lifecycle line is not a user turn, not
assistant prose and not tool output. Nothing here synthesises a model message,
and no tool result is duplicated — the lines originate in `Scheduler.emit` /
`TriggerCoordinator.emit` and pass through verbatim.

The sink is attached in `cli/tui.ts` **after** the Transcript exists, because
`createCliSession` is awaited before the TUI is built. `DESIGN DECISION`: events
emitted before attachment are retained in the bounded log and still reach
`/scheduler status`, so the delay loses no information — it is delayed, not lost.

---

## 9. Resume

`DESIGN DECISION` (the non-obvious finding): **`--resume` is a fork, and the
Scheduler correctly follows the LIVE session, not the resumed one.**

`FACT` (`cli/setup.ts`): `persistCurrent` writes to **both** `sessionId` and
`resumeId` when resuming. The resumed session receives a copy; a new live
`sessionId` continues. `FACT`: the Scheduler's deps use `sessionId`, so it governs
the live namespace — which is where the tasks are, and which the operator is
actually working in.

| Case | sessionId | resumeId | Scheduler governs | Result |
| --- | --- | --- | --- | --- |
| plain start | `s` | — | `s` | normal |
| resume into a new id | `s2` | `s` | `s2` | `s`'s tasks untouched; cycle finds nothing |
| resume with explicit `--session` | `s` | `s` | `s` | **trigger reaches `s`'s tasks** |

Both the fork case and the same-id case are tested, and the same-id case asserts
the earlier turn is actually in the resumed kernel history — so the test fails if
`--resume` stops working, rather than passing on the id alone.

`FACT`: `cli/index.ts` and `cli/setup.ts` were read directly; the identity
question was not assumed. Authority, incarnation and handle all follow the live
session, and M11 (`--resume` no longer forwarded) is **KILLED**.

---

## 10. CLI help

`FACT` — 6AA recorded the old text as the most misleading fact an operator would
meet. Before: *"EXPERIMENTAL: allow autonomous background task execution
(default: off)"*, for a process that could execute nothing.

```
EXPERIMENTAL: opt in to the autonomous scheduler for this session (default: off).
Runs on manual /scheduler run only - no background timer, no recurring polling.
Autonomous turns are readonly. Use /scheduler status|stop inside the session.
```

`DESIGN DECISION`: the help text states opt-in, how to enable, **that triggering
is manual**, the readonly policy, and the in-session commands. The negative list
in the §14 test is phrase-level (`runs continuously`, `recurring scheduling`,
`in the background`, …) rather than word-level, because the text legitimately
contains negations ("no recurring polling") and a bare word ban would either
fail on the truth or be trivially evaded. M10 is **KILLED**.

---

## 11. Documentation

`docs/autonomous-scheduler.md` — new, operator-facing, organised as the six
required operations: **enable, trigger, observe, stop, recover, disable.**

It does not claim continuous background scheduling. It states plainly that
scheduling is manual, that there is no polling or timer, that diagnostics are
per-process, and that a stopped scheduler cannot be restarted in place.

---

## 12. Security regression

`FACT` — four boundaries, each tested through the production route (§17):

| Boundary | Evidence |
| --- | --- |
| Session authority lease | lease handed to a rival token -> cycle refuses `authority-lost`, task stays `PENDING`, 0 provider calls |
| TaskGraph readiness | `CANCELLED` task -> "no task was ready", 0 provider calls, status unchanged |
| Autonomous permission | provider is *scripted to ask for a write*; the file is never created |
| Session identity | ready task in another session -> untouched, unclaimed |

The permission test is the strongest form available: it asks the model, through
the real provider, for a `write_file`, and asserts the file does not exist. If
the trigger route had widened the tool set, that file would exist.

Triggering grants nothing. It requests evaluation; the claim writes; the policy
selects; the adapter enforces.

### M7's first version survived, and why that mattered

`DESIGN DECISION` — the most useful single fact of the campaign.

The first M7 replaced the autonomous child's `permissionHandler` with an
allow-all. It **SURVIVED**. Investigating why produced: **that handler is not the
enforcement point.** 6S enforces the boundary earlier and twice over —
`assertAutonomousToolScope` at adapter construction, and the READ_ONLY allow-list
that produces the tool set in the first place.

A test that "proves permission is enforced" by weakening the handler proves
nothing. M7 was rewritten to ask the question that actually matters — *what if
production gave the autonomous executor the full session tool set?* — and the
answer is a **loud construction failure**. KILLED, 30 tests.

M6 was rewritten for the same reason: its first version widened the candidate
list, which `selectTask` re-checks internally, making the mutant genuinely
**equivalent** rather than undetected. It now attacks the readiness computation
itself. KILLED, 7 tests.

---

## 13. Process-boundary tests

Real `bun` processes. **No sleeps** — file barriers only, per 6Y's rule that a
sleep makes a race a coin flip and a mutant that wins half the time is a failure
dressed as a pass.

| # | Case | Result |
| --- | --- | --- |
| P1 | enabled process + trigger | **execution occurs** — 1 evaluation, 1 execution, 1 provider request, task `IN_PROGRESS` |
| P2 | disabled process, same route | **no Scheduler** — `constructed:false`, `state:OFF`, 0 evaluations, 0 provider requests, task `PENDING` |
| P3 | two enabled processes, one session | **lease excludes one** — second process exits 4 with a lease error; fail-closed, not a second scheduler |
| P4 | session deleted by another process | incarnation bumps; a second enabled process finds nothing and executes nothing |
| P5 | process restart after a crash | old lease row survives; restart **cannot** inherit it — exits 4 with a lease error |
| P6 | resume | new valid lifecycle — new session id, new token, evaluation runs, resumed session's tasks untouched |

`DESIGN DECISION`: **no process killing anywhere in the file.** Every child
terminates itself. A Bun `kill` on Windows can take down the test runner's whole
process group — which it did, twice, before this was understood. The `hold` child
uses a bounded 20s window and exits on its own.

---

## 14. Property tests

| # | Property | Evidence |
| --- | --- | --- |
| 1 | OFF has zero autonomous work | P2 + in-process: 0 provider requests, task `PENDING` |
| 2 | ON has a reachable trigger | P1 + call-surface Proxy: `fire` present |
| 3 | trigger does not bypass readiness | `CANCELLED` task never claimed; M6 KILLED |
| 4 | trigger does not bypass lease | stolen lease -> `authority-lost`; M5/M14 KILLED |
| 5 | trigger does not bypass permission | scripted write never lands; M7 KILLED |
| 6 | stop prevents further work | stop -> run -> run -> 0 provider requests |
| 7 | stopped Scheduler cannot trigger | "not active", 0 evaluations; M4 KILLED |
| 8 | deleted session cannot trigger | `notifySessionDeleted` -> refused; M13 KILLED |
| 9 | recreated session gets new authority | token differs across a close/recreate cycle |
| 10 | resume preserves session/incarnation | incarnation stable across clean close; fork identity verified |
| 11 | no duplicate execution | 4 triggers, one `execGeneration`, one execution |
| 12 | no lifecycle wedge | 3 full enable -> trigger -> stop -> restart cycles, clean |

---

## 15. Mutation campaign

`scripts/phase6ab-mutation.ts` — **14 planned, 14 executed, 14 killed, 0 survived,
0 unexecuted, no campaign failure.**

`docs/audit/PHASE-6AB-PRODUCTION-MUTATION-SUMMARY.json`

Every mutant targets the **caller**, never the helper. M1 removes the production
`fire()` call rather than breaking `TriggerCoordinator`; M5 skips lease
acquisition at the composition site rather than in the store. A campaign that
mutated helpers would have passed while the product stayed broken — which is
exactly how 6AA shipped an inert enablement flag.

| ID | Mutant | Kills | Killed by |
| --- | --- | --- | --- |
| M1 | production `fire()` call removed | 16 | trigger unreachable; the whole point |
| M2 | trigger handle dropped from the session | 33 | no route at all |
| M3 | command context given another session's identity | 1 | `/scheduler status` shows the wrong session |
| M4 | command no longer refuses a trigger after stop | 2 | post-stop trigger reported as success |
| M5 | lease acquisition failure swallowed | 2 | P3/P5 — two processes, one session |
| M6 | graph readiness ignored | 7 | `CANCELLED` task becomes claimable |
| M7 | autonomous executor given the full tool set | 30 | 6S fails closed at construction |
| M8 | production observability sinks removed | 7 | no lifecycle reaches the operator |
| M9 | shutdown stop wiring dropped | 3 | lease leaks; recreate cannot acquire |
| M10 | help claims continuous background scheduling | 1 | help-text assertion |
| M11 | `--resume` no longer forwarded | 1 | resumed history absent |
| M12 | Scheduler constructed against a process-global session | 10 | per-session scoping destroyed |
| M13 | session deletion no longer stops the scheduler | 2 | deleted session keeps scheduling |
| M14 | authority loss no longer self-disposes | 1 | scheduler continues without authority |

### Campaign safety

`DESIGN DECISION`: the campaign is crash-safe by construction. Each mutation is
backed up to `<file>.m5bak` before application and restored on every exit path
including SIGINT/SIGTERM, and `--restore` sweeps leftovers without needing the
process alive. Results **merge** into the summary by id, so a partial run cannot
erase the evidence of the ones before it.

This was not theoretical. Two earlier runs were killed mid-flight and stranded
mutants inside `production-scheduler.ts` and `cli/setup.ts` — including a
destroyed `cli/setup.ts` from a bad restore. Every case was detected and reverted,
and `git status` plus a scan for mutant markers now confirm a clean tree before
commit. A campaign that can strand a mutant in a production file is worse than
no campaign: the next test run reports green results against mutated code.

---

## 16. Lifecycle results

The intended chain, executed end to end:

```
CLI -> gate -> Scheduler -> start -> EXPLICIT TRIGGER -> TaskGraph -> policy
    -> claim -> autonomous execution -> observable result -> stop
```

`FACT`: every stage ran in a real process against real SQLite and a real HTTP
provider. No stage was mocked. The only controlled input is the provider base URL.

No automatic recurrence was introduced. `FACT`: asserted negatively —
`setInterval`/`setTimeout` within 120 chars of `fire(` appears in none of
`cli/setup.ts`, `cli/commands.ts`, `cli/tui.ts`, and `fire("explicit-command")`
appears exactly once.

---

## 17. Findings

1. **The blocker was a caller gap, not a design gap.** 6T's trigger layer was
   correct and complete. Nothing was missing except one line of wiring and one
   exposed object. `DESIGN BLOCKED` was never the answer.

2. **The autonomous permission handler is not the enforcement point.** Recorded
   in §12. 6S enforces the boundary at tool-set construction, twice. Any future
   audit that weakens the handler to "test" permission is testing nothing.

3. **A cycle's terminal state is IN_PROGRESS, by design.** The Scheduler never
   writes COMPLETED. A test asserting COMPLETED would have been green for the
   wrong reason had the assertion been loosened instead of investigated.

4. **OAP-008 caught a real regression in this phase.** The first `/scheduler`
   draft added 23 direct writers to `cli/commands.ts`; the audit failed it. The
   command now collects and emits once, and the bound moves 29 -> 30 with the
   reason declared in the inventory. Silently raising the number would have been
   the failure mode the audit exists to prevent.

5. **Resume is a fork, and the Scheduler is right to follow the live session.**
   Non-obvious, verified in source, and now covered by two tests.

6. **Two seams cannot be executed and are labelled as such.** `cli/tui.ts` is a
   fullscreen TTY driver, and `cli/index.ts` ends in `process.exit`. Both are
   covered by explicit source-anchored assertions naming what they do and do not
   prove. M11 and M3 are killed by these anchors, and the report says so rather
   than implying full execution.

---

## 18. Residual limitations

1. **No automatic scheduling.** Manual trigger only. Deliberate (§6, §23); the
   documentation says so in three places.
2. **No restart after stop.** Restarting means a new process. Deliberate.
3. **Diagnostics are per-process.** In-memory counters and a 40-entry activity
   log; lost on exit. Durable task state survives; diagnostics do not.
4. **Lease rows accumulate** across session delete/recreate. Inherited from 6Z's
   P3 classification; unchanged and still deliberate.
5. **Timing remains TIMING UNVERIFIED.** No values were tuned in this phase. One
   manual cycle is well inside every configured bound, but no measurement was
   taken, so the claim stays unverified rather than becoming an assumption.
6. **`already-dispatched` has no `cycle:stopped` event.** The successful-dispatch
   path emits no terminal cycle event, so the operator learns the outcome from the
   command's summary line and the activity log rather than a stop reason. Closing
   this means adding an emit to `Scheduler`, a semantic change §23 puts out of
   scope. Recorded rather than quietly ignored.
7. **Two unexecutable seams** (§17.6), both source-anchored and named.
8. **Historical lease rows** and the **pinned-vendor estimator crash** (6Z) are
   unchanged.

---

## 19. Exact evidence

**Gates**

| Gate | Result |
| --- | --- |
| `bunx tsc --noEmit` | **28** — identical to the 6Z/6AA baseline |
| `bunx biome check` (touched files) | **clean** |
| `bun test` (full suite) | **3479 pass / 23 skip / 3 fail** |
| pre-existing failures | 2x VENDOR.md fingerprint, 1x web-ssg nested list — the same 3 as 6AA |
| new failures introduced by 6AB | **0** |
| production diff (`src`, `cli`) | 5 files: `cli/commands.ts`, `cli/index.ts`, `cli/setup.ts`, `cli/tui.ts`, `src/ui/i18n/{en,id}.ts` |
| one Scheduler construction site | **yes** — asserted in the test suite |
| OFF mode | unchanged; `deps` thunk still never invoked |
| 6P–6Y regressions | 98 pass (6U/6V/6W/6X), 97 pass (6Y/6Z), 0 fail |
| 6AB suites | 53 pass (32 + 6 + 14 + 1) |
| mutation campaign | 14/14 killed, 0 survived, 0 unexecuted |
| nothing pushed | confirmed |

**Files**

| File | Role |
| --- | --- |
| `src/task/scheduler-observability.ts` | new — operator projection, 5 states, 9 questions |
| `cli/setup.ts` | exposes the handle + projection; wires both event sinks |
| `cli/tui.ts` | injects the control surface; routes notices to the transcript |
| `cli/commands.ts` | `/scheduler status\|run\|stop` — **the** trigger route |
| `cli/index.ts` | truthful `--help` |
| `src/ui/i18n/{en,id}.ts` | operator strings, both locales |
| `docs/autonomous-scheduler.md` | new — operator guide |
| `test/phase6ab-production-trigger.test.ts` | 32 — reachability, semantics, security, properties |
| `test/phase6ab-process-boundary.test.ts` | 6 — P1–P6 in real processes |
| `scripts/phase6ab-mutation.ts` | crash-safe campaign harness |
| `docs/audit/PHASE-6AB-PRODUCTION-MUTATION-SUMMARY.json` | campaign evidence |

**6AA test inversions** (kept, not deleted): §1 help text, §4 trigger reachability
×2 — see §1.

**Writer inventory**: `cli/commands.ts` 29 -> 30, one writer, reason declared
(§17.4).

---

## 20. Final verdict

**GREEN.** Every §25 criterion, checked:

| Criterion | Result |
| --- | --- |
| explicit ON can cause Scheduler evaluation | PASS — P1, 1 evaluation, real execution |
| production reaches `fire()` | PASS — `["explicit-command"]`, exactly one site |
| trigger uses the correct session | PASS — §12, M3, M12 KILLED |
| trigger cannot bypass authority | PASS — stolen lease refused; M5, M14 KILLED |
| trigger cannot bypass readiness | PASS — `CANCELLED` never claimed; M6 KILLED |
| trigger cannot bypass permission | PASS — scripted write never lands; M7 KILLED |
| operator can observe Scheduler state | PASS — 5 states, all reachable |
| operator can stop through a supported path | PASS — `/scheduler stop` |
| stop is idempotent | PASS — stop/stop, stop/close, stop/run/stop |
| deleted session cannot continue scheduling | PASS — P4, M13 KILLED |
| resume works correctly | PASS — both fork and same-id; M11 KILLED |
| CLI help is truthful | PASS — M10 KILLED |
| documentation is truthful | PASS — `docs/autonomous-scheduler.md` |
| production-path campaign has no survivor | PASS — 14/14 killed, 0 survived |
| 6P–6Y remain GREEN | PASS — 195 tests, 0 fail |
| Scheduler remains default OFF | PASS — unchanged, asserted |
| tree CLEAN | at commit |

**Scheduler remains OFF by default. This is not a rollout.**

The chain 6AB set out to close, measured end to end in a real process:

```
--enable-scheduler
  -> lease acquired
  -> /scheduler run
  -> trigger evaluated
  -> selected t1
  -> claimed t1
  -> executing t1
  -> execution finished
  -> /scheduler status reports ON, idle, lease held
  -> /scheduler stop releases it
```

6AA's verdict was NO-GO because an operator could turn the scheduler on and
could not make it do anything, could not see that it had not, and was told by
`--help` that it had. All three are now closed, and each is a mutation that dies
when the fix is removed.
