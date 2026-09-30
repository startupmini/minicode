# PHASE 6AA — SCHEDULER ENABLEMENT READINESS

- Checkpoint: `f0e17ed` (6Z), tree CLEAN at start
- Verdict: **NO-GO** for enablement — on one blocking item, plus three operator gaps
- Audit/documentation only. No production behaviour changed. Scheduler remains OFF.
- Commit: `audit: establish scheduler enablement readiness` — not pushed

---

## 1. Executive verdict

**NO-GO.** 6Z proved the Scheduler is *technically* integrated. 6AA asked the
operational question, and the answer is that the flag is **wired but inert**.

[FACT] `--enable-scheduler` today does exactly two things:

1. constructs the Scheduler and calls `start()`, which **acquires the session
   lease**, and
2. registers a shutdown `stop()`.

[FACT] **It never fires the trigger.** The complete set of method calls production
makes on the handle is `["stop"]` — verified by enumerating
`productionScheduler.<method>` in `cli/setup.ts`. There is no `fire()` anywhere in
`cli/`, and the handle is **not returned on the session object**, so the TUI, the
router and every command are equally unable to reach it.

[INFERENCE] So an operator who types `--enable-scheduler` today gets a process that
**holds a lease on their session and executes nothing**. The help text promises
"autonomous background task execution". That is not what happens, and a human
cannot discover the difference from the CLI.

This is a **NO-GO**, not a defect to fix here: §21 forbids adding trigger
expansion, and §24 lists "critical trigger semantics are unknown" as a NO-GO
condition. The semantics are not unknown — they are *known and unimplemented*, which
is worse, because the UI implies otherwise.

Everything else measured in 6AA is in good order: the enablement contract is exact,
OFF is completely inert, the security boundary holds, recovery works, and rollback
is clean. The gaps are the trigger, visibility, and documentation — three
operator-facing things, not three safety holes.

## 2. Enablement contract

[FACT] The executed expression in `cli/index.ts` is
`const schedulerEnabled = resolveSchedulerGate(args) === GATE_ENABLED`.

| Input | Enabled | Evidence |
|---|---|---|
| *(no flag)* | **OFF** | `schedulerGateFor(undefined)` → false |
| `--enable-scheduler=false` | **OFF** | exact-token match |
| `--enable-scheduler` | **ON** | the only enabling form |
| `--enable-scheduler=true` | **OFF** | value forms are not accepted |
| `--enable-scheduler=0` / `=1` / `=whatever` / `=` | **OFF** | same |
| `MINICODE_SCHEDULER=1` | **OFF** | no env reference exists in `cli/index.ts` |

[DESIGN DECISION] `--enable-scheduler=true` is **OFF**. The flag has no value
grammar, so "off" and "negated" are the same answer, and there is no second way to
spell ON. `hasFlag` is untouched.

## 3. Default-off proof

[FACT] With the gate shut, measured:

- `deps` thunk **never invoked** (it throws if called; it is not called)
- `constructed: false`, `isActive(): false`
- `getScheduler()` and `getTrigger()` are `null`
- `fire()` returns `null`
- **no lease row exists** → no authority, no renewal timer, no background resource
- tasks stay `PENDING`, `execGeneration: 0`, no execution ownership

[FACT] Everything that could start autonomous work — the `TaskStore` handle, the
session factory, the Scheduler, the trigger, the deletion subscription — lives
inside the `deps` thunk, which the gate short-circuits before it is touched. OFF
mode is *provably* not merely unused.

## 4. Explicit-ON semantics as built

| Question | Answer | Kind |
|---|---|---|
| When constructed? | inside `createProductionScheduler`, during `createCliSession` | FACT |
| When is the lease acquired? | **immediately at construction**, before any trigger | FACT |
| When is the first trigger? | **never** — nothing calls `fire()` | FACT |
| Which session? | the single CLI session, `d.sessionId` | FACT |
| Starts immediately or waits? | `start()` is immediate; the lease is held for the process lifetime | FACT |
| What must be ready? | a `PENDING` task the TaskGraph reports ready | FACT |
| If no task is ready? | cycle returns `no-candidates`; the handle stays active and idle | FACT |
| If authority is unavailable? | `createProductionScheduler` **throws**; the process cannot continue believing it is active | FACT |

[DESIGN DECISION] Acquiring the lease at construction (not at first trigger) is
6X's deliberate choice and is what makes a second process fail closed. Its cost is
visible here: an operator with the flag on **blocks that session for other
processes** while doing nothing.

## 5. Trigger reality — **BLOCKING**

**Classification: NOT IMPLEMENTED.**

[FACT] 6T's `TriggerCoordinator` has no transport by design: the runtime emits no
task-mutation event and has no periodic timer, so there is nothing to hook. 6Z
pinned "a task that becomes ready later is not picked up automatically".

[FACT] 6AA escalates this from *limited* to *blocking*, because the two compose:

- there is no automatic retrigger, **and**
- there is no manual one either — `fire()` is unreachable from production.

The result is a Scheduler that cannot be started by any means from the CLI. An
`explicit fire` is not merely "required" as 6T framed it; it is **impossible**.

[INFERENCE] This is a deliberate, well-reasoned scope boundary rather than an
oversight — but it means the feature is not *operationally* ready, which is exactly
the distinction this phase was asked to draw. Resolving it requires a product
decision (§4: "The readiness trigger mechanism itself is a product/operational
decision"), not a patch.

## 6. Scheduler scope — **one session, per process**

[FACT] Scope is `d.sessionId` — the single session the CLI created. There is no
multi-session scheduling, no session registry, and no background daemon.

[DESIGN DECISION] One session per process is the right scope for first enablement.
It bounds the blast radius of a mistake to exactly the session a human is already
looking at. A second process on the same session is refused by the lease.

## 7. Idle / readiness behaviour

| Situation | Behaviour | Kind |
|---|---|---|
| no ready task | `no-candidates`, stays IDLE, keeps its lease | FACT |
| all tasks blocked | same — readiness comes from TaskGraph | FACT |
| task becomes ready | **nothing happens** (no transport) | FACT |
| task completes | moved out of the ready set on the next explicit evaluation | FACT |
| task fails | attempt recorded; task left `IN_PROGRESS` for a legitimate authority | FACT |
| permission denied | terminal `permission-denied` outcome; no retry | FACT |
| session deleted | self-dispose, `session-superseded`, authority released | FACT |
| process restarts | new process must re-acquire; blocked until the old lease expires | FACT |

[INFERENCE] The Scheduler never **WAITS** for work on its own and never **FIRES
AGAIN** by itself. Between explicit evaluations it holds an idle lease. No retry
behaviour was added.

## 8. Lease readiness

[FACT] lease 300 s, renewal 60 s, five renewals per lease. Configured turn bound
120 s; `PROVIDER_REQUEST_TIMEOUT_MS` 300 s.

- **FACT:** the turn bound is half the lease, so an ordinary turn finishes with a
  180 s margin.
- **ACCEPTED OPERATIONAL ASSUMPTION:** 300 s is long enough for a legitimate
  autonomous turn, and 60 s renewal covers transient stalls.
- **TIMING UNVERIFIED:** neither value has been validated against real provider
  latency. **This report does not claim 300 s is statistically validated**, and
  nothing was tuned — 6AA forbids it and there is no evidence to justify a change.

[INFERENCE] For a controlled first enablement with a *read-only* task, the margin
is comfortable. The value to watch is `PROVIDER_REQUEST_TIMEOUT_MS`, which equals
the lease exactly.

## 9. First-enable procedure (smallest safe scenario)

Not yet runnable end-to-end, because no trigger exists. When a trigger is decided,
the smallest safe first run is:

1. A **disposable directory**, not a real project. `minicode` in a scratch dir, so
   `tasks.db` and any session state are throwaway.
2. A single known `PENDING` task, created explicitly, in that session.
3. A **read-only** task — something answerable with `read_file`/`grep` only. The 6S
   matrix makes this enforceable, not a matter of trust.
4. The explicit flag: `minicode --enable-scheduler`.
5. A **controlled provider** with a known-good credential.
6. **Observable execution**: the task moves `PENDING → IN_PROGRESS` and gains an
   `attempt_generation`. That is the only currently-observable signal (§12).
7. **Easy stop**: interrupt the process (§10).
8. **Easy recovery**: no cleanup needed; the lease is released on a clean stop, and
   an unclean stop self-heals by expiry.

[DESIGN DECISION] Never first-enable against an arbitrary user project. The
toolset is read-only, but the model still spends tokens and the session still
mutates `tasks.db`.

## 10. Emergency stop

| Mechanism | Effect | Durable residue |
|---|---|---|
| **Ctrl-C / SIGINT → process exit** | the process dies; in-flight turn lost with it | task left `IN_PROGRESS`, lease row present until it expires (**≤ 300 s**) |
| `session delete` (canonical path) | bumps incarnation, cancels the turn, self-disposes, releases | session gone; `tasks.db` rows for that session deleted |
| `stop()` on clean shutdown | cancel, settle, release | task left `IN_PROGRESS`; **lease row deleted** |
| **omit the flag on next start** | the new process never schedules | nothing |

[FACT] There is **no runtime off-switch**. The operator's reliable stop is process
termination or session deletion. A `stop` hotkey or a signal handler would be a new
control, which §21 forbids adding.

[INFERENCE] "How do I stop autonomous execution?" → **kill the process.** "What
remains?" → an `IN_PROGRESS` task and, if killed uncleanly, a lease row that blocks
that session for up to 300 s. Both are recoverable and neither is dangerous, but
the operator must be told this in advance.

## 11. Startup failures

[FACT] Measured, all explicit, none silent:

| Condition | Behaviour |
|---|---|
| lease held by another process | `createProductionScheduler` **throws** `lease held by another process`; no handle; the other owner is untouched; the user's task is untouched |
| `deps()` throws (e.g. provider chain unavailable) | **throws** with the original message; no lease row created |
| invalid session | the canonical `bumpSessionIncarnation` + `deleteSessionTasks` path; the instance reports `session-superseded` and releases |
| missing task database | schema is created on open; the same code path as any other session |
| migration failure | `TASK_DB_INIT_FAILURE` from the store, before the Scheduler exists |

[DESIGN DECISION] No fallback was introduced. A failure is loud, and the process
cannot continue believing the Scheduler is active.

## 12. User visibility — **readiness gap**

[FACT] There is **no** startup message, no status line, and no output of any kind
when the Scheduler is active, idle, stops, or loses authority.

[FACT] `cli/setup.ts` passes **no** `onSchedulerEvent` and **no** `onTriggerEvent`.
The 10+ well-defined scheduler events are constructed and discarded.

[FACT] No user-facing message mentions the scheduler anywhere in `cli/` or `src/ui/`.

[INFERENCE] The only currently-observable evidence of autonomous activity is
**durable task state**: `status` becomes `IN_PROGRESS` and `exec_generation` /
`attempt_generation` advance. That is enough for an operator who knows to look, and
not enough for one who does not.

## 13. Auditability

[FACT] What exists, without any event wiring:

| Question | Available evidence |
|---|---|
| Scheduler active? | `session_authority` row exists and `lease_expires_at > now` |
| authority acquired? | the same row, with `owner_token`, `owner_pid`, `acquired_at` |
| task claimed | task `status = IN_PROGRESS`, `exec_generation ≥ 1` |
| execution started | `exec_generation` present, `attempt_generation` null |
| execution returned | `attempt_generation ≥ 1` |
| execution cancelled | `attempt_generation` stays null; task left `IN_PROGRESS` |
| authority lost | row gone, or re-keyed to a new incarnation |
| Scheduler stopped | row **deleted** (clean stop) |
| lease takeover | row's `owner_token` changes; old `acquired_at` overwritten |

[INFERENCE] This is adequate for **operational diagnosis** — it is all durable,
inspectable, and cross-process. It is not adequate for *live* monitoring, and no
telemetry is proposed: §12 says observability, not analytics.

## 14. Data safety

[FACT] Verified against disposable databases only; no real user DB was touched.

- `tasks.db` migration is **additive** — one new table, re-created on open.
- Lease rows are harmless: inert, never read except at the current incarnation.
- Session incarnation is independent of the lease, so deletion cannot be confused
  with expiry.
- Late writes after deletion are refused by the 6Q incarnation check.
- Recovery needs **no backup**: the durable state is the task row, and the worst
  case is an `IN_PROGRESS` task that a later authority reconciles.
- 6Z's end-to-end runs used temp directories throughout.

## 15. Recovery drill

[FACT] Performed with a disposable DB.

1. Enable → claim → execute.
2. Simulate a crash: no `stop()`, process-local registry cleared.
3. Restart: the new process is **refused** while the lease is nominally live.
4. After expiry: acquisition succeeds, and the new process is the sole authority.
5. The stranded task remains `IN_PROGRESS` and is reconciled by the new authority —
   the old generation is superseded, not resurrected.
6. No duplicate live execution: the old process is gone, and its lineage write can
   no longer land.

Also drilled: **session deletion** (authority invalidated at the incarnation bump,
before any row is removed) and **recreated session** (new incarnation, new
authority, old token powerless to renew or release).

[INFERENCE] Recovery is understood and bounded: **worst case, one lease period
(≤ 300 s) before a crashed owner's session is schedulable again.** That is a
delay, not a data problem, and it is the single most important number for an
operator to know.

## 16. Rollback drill

[FACT] ENABLE → execute → `stop()` → restart **without** the flag:

- Scheduler does not restart: `constructed: false`
- no autonomous work continues: `fire()` returns `null`
- **no usable lease remains**: the row is deleted on clean stop
- ordinary interactive mode is unaffected — it never consults the scheduler

Re-enabling starts a **clean new authority lifecycle** with a new owner token.

[INFERENCE] Rollback is complete and immediate. There is no lingering state to
clean up by hand.

## 17. Compatibility matrix

| Scenario | Scheduler | Verified |
|---|---|---|
| no flag | OFF | yes |
| explicit flag | ON (inert — no trigger) | yes |
| `=false` / `=true` / other value | OFF | yes |
| existing env var | OFF | yes — no env path exists |
| MCP process | OFF | yes — the flag is CLI-argv only |
| LSP process | OFF | yes — same |
| resumed session (`--resume`) | explicit: the lease is per session id, so a resumed session must re-acquire | **PARTIAL** — not separately exercised |
| new session | explicit: acquires immediately | yes |
| deleted session | safe failure: `session-superseded` | yes |
| stale lease | safe takeover by expiry | yes |
| no ready task | explicit idle, lease held | yes |

**No undocumented combination activates the Scheduler.**

## 18. Security readiness

[FACT] All key guarantees re-verified at this checkpoint (6Z campaign P1–P15 all
killed; the relevant ones): readonly autonomous tools (P10), no `onPermissions`
control seam (P3), no environment activation (P1/P2), no parent session reuse (P8),
no shared abort (P9), no MCP bypass (6S matrix, dynamic tools re-checked at
invocation), no stale authority after recreation (P14), TaskStore authority not
downgradable (P11).

[INFERENCE] The security boundary is the strongest part of this system and is not
a readiness concern.

## 19. Resource readiness

[FACT] 6Z measured: 200 construct→trigger→execute→stop cycles leak no lease (checked
every 25 cycles); 500 cycles on one handle produced exactly 500 child contexts, no
generation inflation, no wedge, no orphan authority. Timers, listeners and abort
handles are cleared on every stop path; `stop()` and `disposeSelf()` both release
the lease.

[DESIGN DECISION] The idle lease held while the flag is on and no trigger fires is
**not** a leak — it is one row, renewed by one `unref`'d timer.

## 20. Construction count

[FACT] Exactly one `new Scheduler(` in production sources, in
`src/task/production-scheduler.ts`, and it sits **after** the gate short-circuit.
Verified by position, not just by count.

## 21. Documentation readiness — **readiness gap**

[FACT] `--help` says: `EXPERIMENTAL: allow autonomous background task execution
(default: off)`.

[FACT] There is **no** operator documentation for: what the flag actually does, the
one-session scope, the trigger requirement, the read-only policy, the recovery
model, the timing limitation, or how to stop it.

[FACT] The help text is currently **inaccurate**: it promises background task
execution, and no task is ever executed.

[DESIGN DECISION] §26 makes this phase audit/documentation only, so the help text
is **not** edited here. But the inaccuracy is the single most misleading fact an
operator would encounter, and it should be corrected in the same commit as whatever
makes the trigger real. Recording it as a blocking documentation item.

## 22. Readiness checklist

| # | Item | Status |
|---|---|---|
| 1 | explicit activation | **PASS** — exact token only |
| 2 | default OFF | **PASS** — provably inert |
| 3 | false-form cannot activate | **PASS** — `=false`/`=true` both OFF |
| 4 | no environment activation | **PASS** — no env path |
| 5 | single production construction | **PASS** — one site, behind the gate |
| 6 | authority acquisition | **PASS** — atomic, at construction |
| 7 | authority loss | **PASS** — fail-closed on all five boundaries |
| 8 | recovery | **PASS** — bounded by lease expiry, drilled |
| 9 | cancellation | **PASS** — cancel before release, ordering verified |
| 10 | shutdown | **PASS** — scheduler first, then UI, then jobs |
| 11 | security | **PASS** — readonly, unwidenable, no env path |
| 12 | context isolation | **PASS** — derived id, own abort |
| 13 | readiness | **PASS** — 6O CAS untouched |
| 14 | completion authority | **PASS** — never writes `COMPLETED` |
| 15 | session recreation | **PASS** — new incarnation, old token powerless |
| 16 | resource cleanup | **PASS** — 200/500 cycle drills |
| 17 | observability | **PARTIAL** — durable state only; no live signal |
| 18 | operator stop | **PARTIAL** — process kill / session delete; no in-app off-switch |
| 19 | rollback | **PASS** — complete and immediate |
| 20 | documentation | **FAIL** — `--help` is inaccurate; no operator docs |

Plus one item the mission did not list but §24 requires:

| — | a trigger the operator can actually invoke | **FAIL — BLOCKING** |

**Nothing was rounded up. Two PARTIALs and two FAILs are stated as they are.**

## 23. Controlled enablement plan

Deliberately **not implemented** (§23, §21). Proposed, for a future phase:

- **Stage 0 — OFF (current).** Exit: this report's blocking items resolved.
- **Stage 1 — trigger, single session.** Decide the transport (explicit command
  first; automatic retrigger is a separate, larger decision). Exit: `fire()` is
  reachable from a real user action; `--help` matches reality; one event is
  surfaced to the user.
- **Stage 2 — disposable environment.** A scratch dir, a read-only task, a
  controlled provider. Exit: a full enable→execute→observe→stop→recover cycle
  performed and recorded.
- **Stage 3 — small real-world test.** A willing user's own repo, read-only task.
  Exit: no surprises in cost, duration, or task state.
- **Stage 4 — broader opt-in.** Not before Stage 3 has real duration and cost data
  to re-derive the lease timings from, which would finally close **TIMING
  UNVERIFIED**.

[DESIGN DECISION] Stage 1 is the gate. Nothing downstream can compensate for a
flag that does nothing while appearing to.

## 24. Known limitations

1. **BLOCKING** — no trigger is reachable; `--enable-scheduler` executes nothing.
2. `--help` overstates the feature; no operator documentation exists.
3. No live observability: no startup message, no status, no events wired.
4. No runtime off-switch; stopping means killing the process.
5. Lease timing remains **TIMING UNVERIFIED**; accepted, not tuned.
6. `--resume` interaction not separately exercised (**PARTIAL**).
7. A flag-on process holds an idle session lease, blocking other processes on that
   session for as long as it runs.

## 25. Final GO / NO-GO

**NO-GO** for enablement.

The NO-GO conditions met:

- **critical trigger semantics are unusable** — not unknown, but unreachable: no
  transport exists and no manual `fire()` is exposed.
- **operator cannot rely on documentation** — `--help` states behaviour the system
  does not have.
- **observability is PARTIAL** and **operator stop is PARTIAL**; both are
  recoverable-by-knowing, not adequate for a human turning this on.

What is *not* wrong, and should not be re-litigated: the enablement contract is
exact, OFF is provably inert, the security boundary is the strongest part of the
system, recovery is bounded and demonstrated, and rollback is immediate.

[DESIGN DECISION] No design contradiction was found, so there is nothing to record
as an architectural blocker. This is a **scope** gap: the feature was built to
"integrated but inert" and the last mile — a trigger, a message, a line of docs —
was never built. The mission's final question is answered plainly:

> Can a human knowingly turn Scheduler on, understand what it will do, stop it, and
> recover from failure without relying on undocumented behaviour?

**No.** They can turn it on. They cannot make it do anything, cannot see that it did
not, and the help text will tell them it worked.

## 26. Exact evidence commands

```
bunx tsc --noEmit                                    # 28, == 6Z baseline
bunx biome check <touched files>                     # clean
bun test test/phase6aa-enablement-readiness.test.ts   # 14 pass
bun test test/phase6z-*.test.ts                       # 6Z regressions
bun test                                              # full suite
```

Production facts were read directly at `f0e17ed`, not from reports:

- `cli/index.ts:196` — the flag's help entry; `:262` — the exact gate expression
- `cli/setup.ts:1536` — `createProductionScheduler(...)`; `:1610` — the only
  operation performed on the handle
- `src/task/production-scheduler.ts` — the single construction site and the gate
- `src/constants.ts`, `src/task/autonomous-context.ts:326` — the limits in §8
