# PHASE 6Z — FINAL PRODUCTION INTEGRATION HARDENING & AUDIT

- Checkpoint audited: `5c6c32d` (6Y), tree CLEAN at start
- Verdict: **GREEN**, with two limitations explicitly accepted and one vendor
  defect reported rather than fixed
- Scheduler remains **OFF by default**. Nothing was enabled, exposed, or rolled out.
- Commit: `feat: close final production scheduler gaps` — not pushed

---

## 1. Executive verdict

**M31 is closed, and closed at the production caller.**

[FACT] 6V found, 6U half-fixed, and 6Y could not kill: the `!injected` guard in
`src/app/session.ts` was correct but **unverified**, because 6U tested the
`permissionHandler` seam through a *stand-in* for `createMinicodeSession`
(`test/phase6u-production-composition.test.ts:665`). That is the 6V failure pattern
exactly — a tested helper beside an untested expression.

6Z calls the **real** `createMinicodeSession` with an injected 6S handler and the
TUI's `onPermissions` probe attached. Mutation **P3** (reconnect `onPermissions` to
the injected handler) is now **KILLED by 4 tests**.

[FACT] The full production-path mutation campaign is **15 planned, 15 executed,
15 killed, 0 survivors, 0 unexecuted, campaign failure none**.

## 2. M31 reproduction

Against the real `createMinicodeSession`, before any change:

| Case | Setup | Observed |
|---|---|---|
| A | injected autonomous handler + `onPermissions` | `onPermissions` called **0** times, `control` is `null` |
| A2 | the injected handler object itself | keys are exactly `["check","describeDenial"]` — **no** `__setMode`/`__getMode` |
| B | no injection, `permissionMode: "auto"` | `onPermissions` called once; `setMode`/`getMode` are a real working handle |
| C | parent `setMode("allow-all")` while a child policy exists | child still denies `write_file`, `shell`, `web_fetch`; still allows `read_file` |
| D | composition that tries to widen (`permissionMode: "allow-all"` + injected handler) | policy still denies; `onPermissions` never called |

[FACT] Case B is the control that matters most: 6Z must not have "fixed" M31 by
breaking Shift+Tab for interactive sessions. It did not.

Production call path (§4 of the mission):

```
cli/setup.ts
  → resolveSchedulerGate(args) === GATE_ENABLED        // exact token, no value form
  → createProductionScheduler(gate, deps)               // deps is a THUNK
  → new Scheduler(...)                                  // ONE guarded site
  → Scheduler.start()  → store.acquireSessionAuthority()   // 6X durable lease
  → TriggerCoordinator.fire()  → Scheduler.cycle()
  → claimTask(..., { exclusive: true })                 // 6O revision CAS
  → buildAutonomousRunTurn(bindingFor, adapter)
  → planAutonomousContext(...)  → AutonomousExecutionContext
  → adapter.sessionFactory(spec)                        // spec.permissionHandler = 6S policy
  → createMinicodeSession({ permissionHandler })         // M31 BOUNDARY
  → handler.check(call)                                  // deny-by-default
```

## 3. M31 correction

[FACT] **No production code was changed for M31.** The guard at
`src/app/session.ts:161` (`if (onPermissions && !injected)`) was already correct.
The defect was an *evidence* gap, and the correct place to close it is a test that
drives production — which is what §3 of the mission asks for.

[DESIGN DECISION] Nothing was weakened to achieve this: the handler is still
injected, the policy is untouched, `hasFlag` is untouched, no permission logic was
duplicated, and no autonomous state was made mutable. The `injected` handler still
has no mode seam at all, so even a successful `onPermissions` call would have
nothing to control.

## 4. Production permission path

- OFF ⇒ no composition, `deps` thunk **never invoked**, no lease row, `getScheduler()` is `null`.
- ON ⇒ the child receives the 6S handler; `permissionMode` is `"readonly"` as kernel
  metadata only; the handler has exactly `check` + `describeDenial`.
- 6S matrix: `read_file`/`grep`/`glob` allowed at creation time; `bash`, `web_fetch`,
  `edit`, unknown tools all **denied** at invocation time.
- The creation-time `assertAutonomousToolScope` is derived from the same matrix, so
  it cannot drift from the invocation policy.

[OBSERVATION] **Vendor defect, out of 6Z scope, reported not fixed.** A denied tool
result through the *top-level* `createMinicodeSession.run()` loop crashes the next
turn: `estimateSessionContext` walks an assistant message whose content parts are
not all `{type:"text"}` and dereferences `part.data.byteLength` unconditionally
(`vendor/minicore/src/core/tokens.ts:33`). The permission decision has already been
made and emitted by then. This is **not** on the production autonomous path, which
runs through `AutonomousExecutionContext` with its own message assembly and is
exercised by the entire 6S suite. Fixing pinned vendor code is not in 6Z's allowed
change list, so it is recorded as a finding.

## 5. Lease lifecycle

[FACT] One row per `(session_id, incarnation)`. A read is keyed on the **current**
incarnation, so a retired row is invisible: it cannot grant authority, withhold it,
or lock a recreated session.

[FACT] Quantified: 8 delete/recreate cycles leave exactly 9 rows, and all 9 are
individually addressable. The current one is the only one any decision consults.

[FACT] `releaseSessionAuthority` resolves the incarnation at *call* time, so a
release aimed at a retired incarnation is a no-op and the row survives. This matches
6Y's finding and is unchanged.

## 6. Lease cleanup analysis — **NO CLEANUP IMPLEMENTED**

The mission asked for a determination, not a change. Determination:

- [FACT] Historical rows are **never read** for authority. Proven directly.
- [FACT] Growth is **linear in delete/recreate cycles** for one session id.
- [FACT] A stale token cannot reach a new incarnation by renew, release, or acquire
  — all three verified, with the current authority untouched by each.
- [INFERENCE] Growth is bounded in practice by how often a *session id* is deleted
  and recreated, which is a user action, not a scheduler action. It is not
  unbounded within a process lifetime.
- **Classification: P3, not P2.** The rows are inert, small, and never consulted;
  the only cost is storage. A cleanup would have to be keyed on the retired
  incarnation and would run inside the deletion path — which is precisely the
  hottest correctness-sensitive sequence in the system (6Q/6T ordering, and the
  reason two bugs in this project have been about it).
- [DESIGN DECISION] **Not implemented.** Adding a write to the deletion path to
  reclaim a few rows would put new failure surface on the one path that 6X/6Y
  worked hardest to get right, for no safety or availability gain. The facts a
  cleanup would need are now pinned by tests, so the decision is revisitable with
  evidence rather than guesswork. This is an explicit, reasoned decision — not an
  omission.

## 7. Timing evidence — **TIMING UNVERIFIED (accepted)**

No provider latency was invented. 6Z inspected the *configured* limits, which is
the real evidence available:

| Limit | Value | Source |
|---|---|---|
| autonomous turn default | 120 000 ms | `autonomous-context.ts:326` (`timeoutMs ?? 120_000`) |
| sub-agent turn | 120 000 ms | `SUB_AGENT_TIMEOUT_MS` |
| longest single tool call | 30 000 ms | `BASH_DEFAULT_TIMEOUT_MS` |
| **provider request** | **300 000 ms** | `PROVIDER_REQUEST_TIMEOUT_MS` |
| Scheduler lease | 300 000 ms | `SESSION_LEASE_MS` |
| renewal interval | 60 000 ms | `SESSION_RENEW_INTERVAL_MS` |

[FACT] The ordering is coherent: the default turn bound (120 s) is **half** the
lease, so an ordinary turn finishes with a 180 s margin. Renewal fires 5× per
lease, and a single missed tick is not fatal.

[INFERENCE] `PROVIDER_REQUEST_TIMEOUT_MS` equals the lease exactly, and its source
comment says a legitimate reasoning stream can run for minutes. That is *not* a
contradiction, because the turn timeout (120 s) bounds the turn and renewal covers
the gap; but it is the tightest pairing in the configuration, and if a deployment
raised the turn timeout above 300 s the safety margin would invert.

**No demonstrable contradiction with the runtime's documented limits.** The values
remain **TIMING UNVERIFIED** for real provider latency, and are explicitly treated
as **deployment configuration, not proven constants**. Nothing was tuned — 6Z forbids
it and there is no evidence to justify a change.

## 8. CLI verification

[FACT] The production caller is `cli/index.ts`:
`const schedulerEnabled = resolveSchedulerGate(args) === GATE_ENABLED`. Asserted by
reading the executed source, not by calling a helper.

| Input | Enabled | Scheduler constructed? | Lease row? |
|---|---|---|---|
| *(no flag)* | no | no | **no** |
| `--enable-scheduler` | yes | yes | yes |
| `=false` / `=0` / `=true` / `=whatever` / `=` | no | no | **no** |
| `--enable-schedulerx`, `--enable-sched` | no | no | **no** |
| `hello -- --enable-scheduler` | no | no | **no** |
| `MINICODE_SCHEDULER=1` | no | no | **no** |

[FACT] Environment inheritance is structurally impossible, not merely untested:
the gate reads `argv` only, `cli/index.ts` contains no `process.env.*SCHEDULER`
reference, and `process.env` is passed to sub-agents, MCP servers and LSP servers —
so a sub-agent, an MCP server and an LSP server inheriting the environment cannot
enable the Scheduler either. Killed by **P28/P1** in the 6Y campaign and **P1/P2**
here.

## 9. Full production composition

Every edge verified through `createProductionScheduler`, never by constructing a
`Scheduler` directly:

| Edge | Verified | Evidence |
|---|---|---|
| CLI → gate | yes | P1, P2, §8 table |
| gate → composition | yes | P4 (deps thunk not invoked when shut) |
| composition → authority | yes | lease present for the whole live period; released on stop |
| authority → Scheduler | yes | P5 (skip acquisition), P7 (any token) |
| Scheduler → trigger | yes | P13 (fire after shutdown) |
| trigger → TaskGraph/policy | yes | §12 durable lineage, exactly one generation per task |
| claim | yes | 6O CAS untouched; 500 cycles produced `execGeneration` 1 for all |
| autonomous context | yes | P8 (parent session id), P9 (shared abort), P15 (event attribution) |
| permission | yes | P3, P10, P11, and the real `createMinicodeSession` |
| lineage / incarnation | yes | P12, P14 |
| reconciliation | yes | P6 |
| shutdown | yes | P13, plus §15 |

[FACT] Exactly one `new Scheduler(`, one `new TriggerCoordinator(` and one
`buildAutonomousRunTurn(` exist in the production composition. `createPermissionHandler`
appears exactly once in `src/app/session.ts`, and that file never references
`createAutonomousPermissionHandler` — the composition **injects** a policy, it never
builds or widens one.

## 10. Permission regression

Through the production root: `read_file` allowed; `bash`, `web_fetch`, `edit`,
`task_write`, and unknown tools denied; the injected policy has no mode seam; and a
second policy object shares no state with the first.

## 11. Context regression

[FACT] The child session id is **derived** — `auto~<parent>~<task>~<gen>` — and the
spec names the parent separately, so the autonomous context never inherits the
parent conversation. Task id reaches production through `bindingFor`, not the spec.
Killed by P8/P9/P15.

[DESIGN DECISION] The binding must be read from the store at claim time. A literal
`execGeneration: 0` makes `planAutonomousContext` refuse to plan, and the turn is
rejected *before* the child session is ever created. This cost real debugging time
and is recorded because it is an easy way to write a test that appears to exercise
composition while actually only exercising the refusal path.

## 12. Lifecycle regression

| Scenario | Result |
|---|---|
| new → enable → claim → execute → lineage → stop | pass; release verified |
| execute → delete session → late return | pass; nothing durable written; instance STOPPED |
| crash → lease expiry → replacement | pass; expiry, not detection |
| delete → recreate → new incarnation | pass; old token cannot renew or release |

## 13. Cross-process, real production composition

[FACT] Two **real `bun` processes**, each running the **real** `createProductionScheduler`
with `GATE_ENABLED`, against one `tasks.db`, coordinated by a file barrier (never a
sleep — a mutant could pass by luck):

- holder: `constructed: true`, `authority: true`, real claim `IN_PROGRESS`
- contender: refused with `lease held by another process`
- **stronger than "no authority":** the refusal happens *inside*
  `createProductionScheduler`, so the contender obtained **no handle at all** — no
  Scheduler, no trigger, no child context was ever built. Its `sessionFactory`
  throws if reached.
- after the holder stops, the lease row is `null` — no orphan authority.

## 14. User / autonomous interaction

A user edit during an autonomous turn is not mistaken for Scheduler work: the user's
task was completed by the user and has **no** execution ownership and
`execGeneration: 0`; the Scheduler's own claim is a different task. A failed turn
never fabricates a completion — the Scheduler writes only `IN_PROGRESS` and `PENDING`.

## 15. Shutdown

After `stop()`: `fire()` returns `null` (no new work), no revision movement, no new
claim, no fabricated completion, lease released, and `stop()` is idempotent.
Shutdown during an in-flight turn still releases the lease. Killed by **P13**.

## 16. Trigger lifecycle — **documented limitation, not a bug**

[FACT] A task that becomes ready **after** a fire is **not** picked up
automatically. 6T recorded that the runtime has no task-mutation event to hook and
no periodic timer, so `TriggerCoordinator` has nothing to poll. An explicit
`handle.fire(...)` is required.

This is pinned by a test so it cannot later be read as an unnoticed defect — and,
just as importantly, so it cannot be "fixed" by inventing a second evaluation
mechanism. Trigger **duplication** is safe: a second fire while a turn holds its
claim is coalesced into the running cycle (6T's DUPLICATE policy), which is what
stops duplication becoming duplicate work.

## 17. Resources

200 construct → trigger → execute → stop cycles leak no lease, checked every 25
cycles and not only at the end — a single leak would wedge the session for a full
lease period. Timers, listeners and abort controllers are cleared on every stop
path; `disposeSelf`/`releaseAuthority`/`stop` were each verified to clear them.

## 18. Long-run stability

[FACT] 500 cycles on **one** handle (a fresh handle each time never exercises
accumulation): 500 child contexts created, every task `IN_PROGRESS` with
`execGeneration` **exactly 1** and `attemptGeneration` **exactly 1** — no duplicate
execution, no generation inflation — no wedge, and no orphan authority.

## 19. Mutation campaign

| | |
|---|---|
| planned | 15 |
| executed | **15** |
| KILLED | **15** |
| SURVIVED | 0 |
| UNEXECUTED | **0** |
| campaign failure | **none** |

Machine-readable: `docs/audit/PHASE-6Z-PRODUCTION-MUTATION-SUMMARY.json`.

Every mutation proved: anchor resolved exactly once → a real production file was
mutated → a real process executed it → a test observed the consequence.

- **P3 is M31** and is KILLED, satisfying §4's "if it survives, STOP" condition. It
  did not survive.
- The first campaign run produced **1 UNEXECUTED** (P9: `AbortController` resolved
  4×) and **1 SURVIVED** (P4, whose mutant was `if (false)` — a no-op, so it proved
  nothing). Per the mission both are campaign-level problems, not survivors: the
  anchor was made field-specific (`private readonly abort: AbortController = new
  AbortController()`), and P4 was rewritten to its real semantic — invoking the
  `deps()` thunk while the gate is shut — which is what "constructed before the
  gate" actually means once P1 owns "gate removed". Both re-run clean.

## 20. Property / state machine

[FACT] 150 seeds × 30 randomized steps over the **production handle** (not the
store), interleaving fire, deletion, recreation, rival acquisition and shutdown.
Asserted after **every** step: no authority leak once stopped; the recorded owner is
always this instance's own token while live; a rival never becomes the owner of a
*valid* lease; and no task is ever fabricated `COMPLETED`. At the end of every seed:
`STOPPED`, and no lease row. No failing seeds.

[DESIGN DECISION] 6Y's property test caught three wrong invariants **in the test**,
which is why the same discipline was kept here: guarding on the *valid* owner
rather than the *recorded* owner fails on correct behaviour; a renewal moves the
deadline and not `acquiredAt`; and a random clock that jumps backwards is something
`Date.now()` cannot do.

## 21. Security composition

| Object | OWNER | SCOPE | MUTABILITY | AUTHORITY |
|---|---|---|---|---|
| `PermissionHandler` (interactive) | `createPermissionHandler`, once in `session.ts` | session | `__setMode` (Shift+Tab) | grants mode |
| `AutonomousPermissionHandler` | 6S `createAutonomousPermissionHandler` | one turn | **none** | deny-by-default, unwidenable |
| `AutonomousExecutionContext` | `buildAutonomousRunTurn` | one task, one generation | disposed after the turn | none of its own |
| `Session` (child) | `adapter.sessionFactory` | derived id | no parent conversation | none |
| `Scheduler` | `production-scheduler.ts`, one site | one session | stop/dispose | holds the lease |
| `TaskStore` | composition root | one session | schema | 6O authority mode |
| `TaskGraph` | rebuilt per cycle | one snapshot | discarded | none |
| Event sink | per-execution | one turn | — | attribution only |
| Abort controller | the CONTEXT's own | one turn | cancelled by the context | aborts only its own child |

[FACT] No second privileged object is constructed by the production path. The
injected policy shares no state with any other policy object; a denial recorded by
one is invisible to the other.

## 22. Known limitations

1. **Timing is TIMING UNVERIFIED** for real provider latency (§7). Accepted
   explicitly; the values are deployment configuration, not proven constants.
2. **Lease rows accumulate** across delete/recreate (§6). Classified P3, cleanup
   deliberately not implemented, with the facts a future cleanup would need pinned
   by tests.
3. **A denied tool crashes the top-level session loop** on a vendor estimator bug
   (§4). Not on the production autonomous path; reported, not fixed, because 6Z may
   not change pinned vendor code.
4. **No automatic retrigger** when a task becomes ready (§16). Documented design
   limitation, pinned by test.
5. **No real provider data** and no cross-host testing. Single host, local
   `tasks.db`, as 6W constrained.
6. The 500-cycle and 200-cycle stress tests use injected stub turns, so they
   exercise lifecycle and resource behaviour, not model latency.

## 23. Findings

| # | Severity | Finding |
|---|---|---|
| F-Z1 | **P3** | Lease rows accumulate across delete/recreate; inert, never read. Cleanup deliberately not implemented (§6). |
| F-Z2 | **INFO** | Denied tool crashes the top-level session loop via a vendor estimator bug. Off the production autonomous path. |
| F-Z3 | **INFO** | `PROVIDER_REQUEST_TIMEOUT_MS` (300 s) equals the lease exactly. Coherent given the 120 s turn bound, but the tightest pairing in the configuration. |
| F-Z4 | **INFO** | No automatic retrigger on task creation; requires an explicit `fire()`. Documented in 6T, now pinned. |
| F-Z5 | resolved | **M31** — the 6S `!injected` guard was correct but unverified at the production caller. Now tested; P3 KILLED. |
| F-Z6 | resolved | **P4's** original mutant was a no-op, which masked whether the deps thunk is invoked when the gate is shut. Now a real mutant, KILLED. |

## 24. Final verdict

**GREEN.**

| Criterion | Result |
|---|---|
| M31 closed and production-path tested | yes — P3 KILLED, real `createMinicodeSession` |
| F01 correct through the actual CLI path | yes — P1, P2, P4 |
| F02 closed under real OS processes | yes — 6Y's 12 processes; 6Z adds the production composition |
| lease authority exclusive | yes — §13, one authority |
| stale authority fails closed | yes — P7, P14 |
| autonomous permission remains readonly | yes — P10, P11 |
| no permission escalation | yes — no mode seam exists |
| no context escape | yes — P8, P9, P15 |
| no session-recreation contamination | yes — P12, P14 |
| no readiness bypass | yes — 6O CAS untouched, 500 cycles |
| no completion fabrication | yes — asserted in every §12/§14/§20 scenario |
| no shutdown-created work | yes — P13 |
| no lifecycle wedge | yes — 150 seeds, no failures |
| no critical resource leak | yes — 200 cycles |
| mutation anchors all execute | yes — 15/15, campaign failure none |
| no unexplained critical survivor | yes — 0 survivors |
| 6P–6Y regressions GREEN | yes |
| lease cleanup decision explicit | yes — P3, not implemented, reasons stated |
| timing limitation explicitly accepted | yes — TIMING UNVERIFIED |
| Scheduler OFF by default | yes — P1, P2, P28 |

**No NO-GO condition met.** No defect required an architectural change, so there is
no DESIGN CONTRADICTION to record. M31 was an evidence gap, not a design gap.

## 25. Exact evidence commands

```
bunx tsc --noEmit                                        # 28, == 6Y baseline
bunx biome check <11 touched files>                      # clean
bun test test/phase6z-m31-permission-composition.test.ts        # 7 pass
bun test test/phase6z-production-audit.test.ts                  # 16 pass
bun test test/phase6z-lifecycle-and-state-machine.test.ts       # 5 pass
bun test test/phase6y-*.test.ts                                # 6Y regressions
bun test                                                   # full suite
bun run scripts/phase6z-mutation.ts                          # 15/15 executed, 15 killed
```

`PROVIDER_REQUEST_TIMEOUT_MS` and the other limits in §7 were read from
`src/constants.ts` and `src/task/autonomous-context.ts` at this checkpoint.
