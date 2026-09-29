# Phase 6V — Adversarial Production Scheduler Integration Audit

**AUDIT ONLY. No production code was changed in this phase.**

**Verdict: NO-GO.** One P1 live defect (FINDING-02) and one P2 live defect
(FINDING-01) are confirmed, plus three P2 test-coverage gaps. `6V` is the phase
whose stated purpose is that "if 6U contains a real defect, the correct outcome is
NO-GO" — and it does.

Commit: `audit: adversarially validate production scheduler`
Baseline: `6391bc9` (Phase 6U) — clean tree, 47 commits ahead, nothing pushed.

---

## 1. Executive verdict

| | |
|---|---|
| **Verdict** | **NO-GO** |
| Live defects | **FINDING-02 (P1)**, **FINDING-01 (P2)** |
| Coverage gaps | **FINDING-03/04/05 (P2)** — real, but not live behaviour |
| Harness defects found and discarded | 3 (two would have produced phantom findings) |
| 6P–6U regressions | **414 pass / 0 fail** |
| Full suite | **3286 pass / 23 skip / 3 fail** (the 3 known pre-existing) |

`FACT` — nothing found is a design flaw in 6U's architecture. FINDING-02 is 6L
D5′ (cross-process liveness) becoming **reachable** because 6U made the Scheduler
reachable; before 6U no two processes could ever both run one. FINDING-01 is a
parser interaction 6U could not have seen from the composition root.

---

## 2. Production path reconstruction

```
cli/index.ts:248   hasFlag(args, "--enable-scheduler")        ← THE ONLY activation
   └─ :427 schedulerEnabled
      └─ cli/setup.ts:511  destructure
         └─ :1537 schedulerGateFor(schedulerEnabled)         ← the tested seam
            └─ createProductionScheduler(gate, deps)
               ├─ [OFF] inertHandle — deps() NEVER called
               └─ [ON]  await deps()  → TaskStore(cwd,{SCHEDULER})
                        → tools = real sessionTools ∩ 6S AUTONOMOUS_TOOL_NAMES
                        → new Scheduler(sessionId, { runTurn: buildAutonomousRunTurn })
                        → new TriggerCoordinator({ runCycle: scheduler.cycle })
                        → scheduler.start()  [acquireSessionOwnership]
                        → onSessionInvalidated(sessionId, → stop)
                        └─ trigger.fire("startup")
                             → scheduler.cycle()
                                → reconcile()            [owner-aware, fail-closed]
                                → snapshot → TaskGraph    [readiness]
                                → selectTask(ready, snap) [ORDER ASC → ID ASC]
                                → claimTask(..., { exclusive: true })
                                   [atomic: status, revision, exec_generation,
                                    execution_owner, capacity predicate]
                                → buildAutonomousRunTurn
                                   → AutonomousExecutionContext
                                      → sessionFactory → createMinicodeSession
                                         with permissionHandler = 6S handler
                                      → child session auto~<parent>~<task>~<gen>
                                → recordAttemptReturned(sessionId, taskId,
                                     execGeneration, sessionIncarnation)
                             → close(): productionScheduler.stop() FIRST
```

| boundary | owner | identity | session | incarnation | taskId | revision | exec_gen | attempt_gen | exec_owner | permission authority | abort authority |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CLI gate | `cli/index.ts` | — | — | — | — | — | — | — | — | — | — |
| composition | `production-scheduler.ts` | gate object | parent | captured at start | — | — | — | — | acquired | — | — |
| trigger | `TriggerCoordinator` | in-memory | parent | — | — | — | — | — | — | — | — |
| selection | `scheduling-policy.ts` | `ready[0]` | parent | — | chosen | — | — | — | — | — | — |
| claim | `TaskStore.claimTask` | SQL row | parent | not read | target | guarded | **+1** | — | `scheduler` | — | — |
| context | `AutonomousExecutionContext` | `auto~…` | parent namespace | claimed | from binding | — | from binding | — | — | 6S handler | own AbortController |
| lineage | `recordAttemptReturned` | generation | parent | **checked** | — | — | key | written | cleared on leave | — | — |

---

## 3. Default-off security — 12/14 PASS, 2 FINDING

Real OS processes, real argv, real `hasFlag`, real composition.

| id | attack | result |
|---|---|---|
| D1 | ordinary CLI | PASS — nothing constructed |
| D2 | repo config present | PASS |
| D3 | `MINICODE_ENABLE_SCHEDULER=1` | PASS |
| D4 | `MINICODE_SCHEDULER` / `MINICODE_AUTONOMOUS` | PASS |
| D5 | MCP-ish env | PASS |
| D6 | LSP-ish env | PASS |
| D7 | sub-agent-ish env (`MINICODE_PERMISSION=auto`) | PASS |
| **D8** | **`--enable-scheduler=false`** | **FINDING-01** |
| **D9** | **`--enable-scheduler=0`** | **FINDING-01** |
| D10 | repeated flag | PASS (idempotent) |
| D11 | `--enable-schedulerx` | PASS |
| D12 | `--enable-sched` | PASS |
| D13 | flag after `--` | PASS (production `hasFlag` stops at `--`) |
| D14 | the real form | PASS |

`FACT` — D3–D7 confirm §2's "cannot be accidentally inherited": no env var,
config key, MCP/LSP/sub-agent environment or malformed input activates it.

---

## 4. Enablement bypass audit

`FACT` — exhaustive source search: the gate has exactly **one** reference chain
(`cli/index.ts:248` → `schedulerEnabled` → `schedulerGateFor` →
`createProductionScheduler`), **one** production construction site
(`production-scheduler.ts:196`), and **no** env var, config key, module
side-effect, or dynamic-import path that can enable it.

`OBSERVATION` — two related observations:

- `FACT` — the two exported gate resolvers **disagree**. `resolveSchedulerGate`
  (argv-based) and `schedulerGateFor` (boolean-based) return different answers
  for `--enable-scheduler=false` and for a flag after `--`. Production uses the
  second; the first is exported and tested but unused in production. `INFERENCE` —
  an exported, tested function that disagrees with the one in use is a trap for
  the next caller.
- `FACT` — `exec.ts` and `acp.ts` are separate entry points that also call
  `createCliSession`. Neither passes `schedulerEnabled`, so both are off. That is
  correct today **by omission** rather than by an explicit statement. `INFERENCE`
  — a future edit to either that copies the option list could change it silently.

---

## 5. FINDING-01 — `--enable-scheduler=false` enables the Scheduler (P2)

`FACT` — `cli/args.ts:70`: `if (token === name || token.startsWith(\`${name}=\`)) return true`.
`hasFlag` therefore matches any `--enable-scheduler=<anything>`.

`FACT` — `cli/index.ts:248` reads the gate with `hasFlag`, not with
`resolveSchedulerGate`.

`OBSERVATION` — real process:
```
argv=["--enable-scheduler=false","hello"]  hasFlag=true  module=false  constructed=true
argv=["--enable-scheduler=0","hello"]      hasFlag=true  module=false  constructed=true
```

`INFERENCE` — a user who explicitly typed `=false` gets autonomous execution.
`DESIGN DECISION` the user did not make.

`INFERENCE` — 6U **documented and tested** the opposite: "the flag has no value
form — `--enable-scheduler=…` does not enable it" (test `A2`). The test called
`resolveSchedulerGate`, the module function. Production calls `hasFlag`. The
assertion was made about the wrong function, so it gave false assurance — which
is precisely the failure mode 6U's own `schedulerGateFor` seam was created to
prevent, one level up.

- Severity **P2** — requires the user to type a scheduler-named flag; no
  privilege escalation without user action. But it silently enables unattended
  execution against explicit intent, which is a safety defect.
- Type **INTEGRATION DEFECT**, confidence **HIGH** (real process, real parser).
- Not fixed. 6V is audit-only.

---

## 6. FINDING-02 — cross-process reconciliation reverts a LIVE execution (P1)

`FACT` — `reconcile()` is gated on `ownsSession(sessionId, owner)`, and
`session-ownership.ts` is **process-local** by design. `FACT` —
`reconcileIfNoCompletedAttempt` reverts `IN_PROGRESS` when
`attempt_generation IS NULL`.

`OBSERVATION` — two real processes, A holding a live parked turn:

```
A at claim: generation=1 attempt=null status=IN_PROGRESS   (A's turn is LIVE)
B ran one cycle; the task now reads generation=2
CONFIRMED — B advanced the execution generation of a task A was ACTIVELY executing
```

`INFERENCE` — B observed `IN_PROGRESS` with no completion marker, concluded
"stranded", reverted it, and re-claimed. `attempt_generation = null` cannot
distinguish *crashed* from *still running*; process-local ownership told B it was
entitled to revert.

`INFERENCE` — consequences: the same task executes **twice concurrently** in two
processes. 6P's "one task cannot receive two live claims" holds **within** a
process only. A's later `recordAttemptReturned` is refused as superseded, so A's
work is silently discarded rather than double-counted — the durable state stays
coherent, but real work is lost and real cost is duplicated.

`INFERENCE` — this is 6L **D5′** ("two process OS on the same session NOT
detected"), which 6L and 6N both documented. What 6U changed is reachability:
before 6U no two processes could both run a Scheduler, so D5′ was a theoretical
limit. 6U made it executable.

- Severity **P1** — duplicate autonomous execution of the same task across
  processes, with lost work.
- Type **DESIGN GAP / NOT IMPLEMENTED**, newly **REACHABLE**, confidence **HIGH**.
- Not fixed. Fixing it needs a liveness mechanism (lease, heartbeat, or
  cross-process lock) that 6O explicitly rejected — a product-level decision, not
  an audit fix.

---

## 7. Permission regression and path equivalence

| attack | result |
|---|---|
| 6S handler has `__setMode` under composition | **no** — structurally absent |
| interactive `readonly` allows `web_fetch` (control) | yes |
| autonomous denies `web_fetch` | yes |
| UNKNOWN tool `acme.brand_new_tool` | **deny** |
| runtime-added MCP `github.create_issue` | **deny** |
| `weird.0`, `UPPER.CASE` (names the matrix never saw) | **deny** |
| `mcp_list` (the one MCP tool in scope) | allow |
| `mcp_call`, `delegate_task` | deny |
| nested delegation factory present on the adapter | **NOT IMPLEMENTED** (6R removed it) |

`INFERENCE` — §5's "attempt an unknown tool" passes: deny-by-default holds for
names that did not exist when the matrix was written. The control case matters —
if interactive also denied, the test would be vacuous.

---

## 8. Real autonomous turn and composition attribution

`PASS` — through the real composition root: correct session, derived child
context (`auto~<parent>~<task>~<gen>`), correct task, correct generation,
scheduler-owned, correct cwd, real provider chain, attempt recorded on the task
that ran. `§21.1` confirms two sessions with **different cwd** never share it:
`A@dira`, `B@dir/project-b`.

`PASS` — no completion fabrication anywhere: a returned turn leaves
`IN_PROGRESS / gen 1 / attempt 1`; ten returning turns still never complete a
task (§14.2).

---

## 9. User turn × Scheduler turn

`PASS` — a user retitling the live task does not consume a generation or steal
the claim (`§7.4`: gen stays 1, attempt still records as 1).
`PASS` — a user-authored `IN_PROGRESS` does not fabricate completion.

`OBSERVATION` — **a positive result worth stating explicitly.** Three attacks
failed during construction with:

```
TaskError: IN_PROGRESS may only be authored by claimTask while Scheduler
authority is active
```

That is 6P's authority contract **working**: a user genuinely cannot forge a
Scheduler-owned status, even through the composition root. The attacks had to be
rewritten to author interactive state through a LEGACY store. Recorded because
"three of my attacks failed" is exactly the kind of thing an audit should not
quietly reclassify as either a pass or a defect.

---

## 10. Deletion × live execution, and session recreation

`PASS` — deletion during a live parked turn: abort reached the execution, the
instance went inactive, the namespace is empty, the subscription released, and
the handle is disposable. (`D1`, `§8.2`.)
`PASS` — a deleted session cannot be triggered back into execution through any of
five trigger sources (`§10`).
`PASS` — creation + deletion + recreation: incarnation `1 → 2`, monotonic; the
old handle is inactive; the new one composes (`P5`).
`PASS` — no stale-ownership wedge across processes (`P5`).

`HARNESS DEFECT, discarded` — the first session-recreation probe tried to hold two
Scheduler instances for one session inside one process and crashed on
"already owned". That is **fail-closed behaviour working**, not a defect. The
realistic case is two processes, and that is what `P5` measures.

---

## 11. Trigger audit, duplication, multi-process

`FACT` — trigger transport is **explicit** (startup evaluation + `handle.fire`).
Repeatable, coalescing, and inert after stop/deletion.

`INFERENCE` — the known gap is **INTEGRATION GAP**, not a defect: nothing
re-triggers when a task becomes ready *after* startup. §10 says do not turn this
into a defect merely because it is absent. It is absent by decision (6T ADR-11
left transport DECISION BLOCKED; 6U supplied the seam only).

`PASS` — 100 identical triggers → one claim (`gen 1, attempt 1`). Four mixed
simultaneous triggers → one claim.
`PASS` — two sessions in one process: independent lifecycles, zero leaked
subscriptions.
`PASS` — two enabled processes on one session: no generation exceeded 2 (the P1
duplicate described in §6).

---

## 12. Crash matrix (C1–C14)

Every point shares one durable answer: the only durable facts are
`status`, `revision`, `exec_generation`, `attempt_generation`,
`execution_owner` and the session incarnation, and a generation is only ever
advanced by an accepted claim.

| crash point | durable state | next behaviour |
|---|---|---|
| C1 before construction | none | nothing to recover |
| C2 after construction, before trigger | none (no claim) | next owner starts clean |
| C3 after trigger, before claim | none | task still ready |
| C4 after claim, before context | `IN_PROGRESS/gen N/attempt null` | **reconciled as stranded** — correct |
| C5–C8 during context/model/tool | same as C4 | same |
| C9 before lineage write | `IN_PROGRESS/gen N/attempt null` | same |
| C10 after lineage write | `IN_PROGRESS/gen N/attempt N` | **NOT reverted** — evidence of a real attempt |
| C11–C13 deletion/cancel/shutdown | incarnation advanced | writes refused |
| C14 after restart | as above | reconciliation decides |

`INFERENCE` — the duplicate-execution window is **exactly** C4–C9 combined with
FINDING-02: a process that dies mid-turn leaves the signature a live turn also
leaves, so the next process cannot tell them apart. This is the durable half of
the P1.

---

## 13. Reconciliation, readiness, resources, shutdown, failures

- **Reconciliation** (R1/R3/R7): a returned execution is not reverted; a
  completed-but-`IN_PROGRESS` task is not resurrected; an interactive
  `IN_PROGRESS` is never reclaimed. Evidence-based, not status-based.
- **Readiness** (§16): a `BLOCKED` task sorted first is skipped; a terminal task
  is never executed through 5 triggers; a deleted task is not executable through
  3 triggers. **No bypass found.**
- **Resources** (§17): OFF leaves 0 subscriptions across 200 fires; ON has 1
  while running and 0 after stop; no subscription outlives its handle.
- **Performance**: OFF compose+fire+stop **1.6 µs**; ON compose+stop 215.6 µs;
  trigger→claim→turn **11.57 ms** per cycle; heap **2.0 MB** after 500 cycles
  (no leak); 0 subscriptions after stop. **No pathological regression.**
- **Provider failure** (§22.1): a throwing turn records `gen 1 / attempt 1`,
  leaves `IN_PROGRESS`, and leaves the Scheduler **running** — a failure is an
  attempt, not a completion, not a wedge.
- **Shutdown**: `close()` stops the scheduler first, before presentation detach
  and before `killAllBackgroundJobs`. `DESIGN DECISION` unchanged from 6U: the TUI
  still calls `process.exit(143/129)` synchronously, so a signal-terminated
  process does **not** run that ordering. `INFERENCE` — safe, because durable
  recovery is crash-like: nothing is written on the way out, and the next owner
  reconciles. Not a defect, but it is the reason cancellation is best-effort.

---

## 14. Parent/child escape, ownership cross-product, composition security

- `§23.1` a second scheduler for one session is **refused** (fail-closed), not
  shared.
- `§23.2` a stale instance cannot release a live replacement's authority.
- `§16`/`§14` no cross-session contamination, no task-namespace confusion.
- Composition security (§25): the production session builds the autonomous child
  with the **injected** 6S handler, real tools filtered to the 6S allow-list, the
  real provider, and the derived child identity. No composition regression found
  in the current tree.

---

## 15. Mutation M1–M20 — 5 killed, 8 survived, 7 anchor drift

Run twice: once against the 6V file, then each survivor against the **full**
6P–6U suite to separate "a gap in my audit file" from "a gap in the system".

| id | mutant | 6V file | full suite | classification |
|---|---|---|---|---|
| M1 | remove the enablement gate | KILLED | — | — |
| M2 | construct deps **before** the gate | survived | **KILLED** (6U A4/A5/B1) | 6V HARNESS GAP |
| **M3** | **gate inherits `process.env`** | survived | **SURVIVES** | **FINDING-03** |
| M4 | production builds its own handler | anchor drift | — | not tested |
| **M5** | **always wire `onPermissions`** | survived | **SURVIVES** | **FINDING-04** |
| M6 | bypass the invocation gate | KILLED | — | — |
| M7 | reuse the parent session | anchor drift | — | not tested |
| M8 | share a global parent abort | survived | survives | 6V HARNESS GAP (6U J1 checks one key name) |
| M9 | share a global parent bus | survived | survives | **UNOBSERVABLE** (nothing reads it) |
| M10/M11 | drop incarnation / generation | anchor drift | — | not tested |
| M12 | bypass readiness | KILLED | — | — |
| **M13** | **claim without the capacity predicate** | survived | **SURVIVES** | **FINDING-05** |
| M14 | allow a trigger after shutdown | survived | **KILLED** (6U C4/D2) | 6V HARNESS GAP |
| M15 | compose for a deleted session | KILLED | — | — |
| M16 | old scheduler acts after recreation | KILLED | — | — |
| M17 | denial not terminal | anchor drift | — | not tested |
| M18 | every turn is a success | survived | **KILLED** (6Q) | 6V HARNESS GAP |
| M19 | ignore cancellation | anchor drift | — | not tested |
| M20 | control (unchanged) | survived | — | control |

- **FINDING-03 (P2, REAL GAP).** `schedulerGateFor` reading an env var survives
  every test. 6U's env test (`A3`) exercises `resolveSchedulerGate`, not the
  function production uses — the same wrong-function error as FINDING-01, one
  level deeper. `DESIGN DECISION` "cannot be inherited" is currently unverified
  at the seam that decides.
- **FINDING-04 (P2, REAL GAP).** Changing
  `if (onPermissions && !injected)` to `if (onPermissions)` in
  `src/app/session.ts` survives every suite. That single `!injected` is the whole
  reason an autonomous child has no Shift+Tab-revocable mode control — the hole
  6S/6U closed — and **no test defends it**. 6U G1/G2 assert the handler's
  *shape*, never the wiring decision.
- **FINDING-05 (P2, REAL GAP).** Removing `exclusive: true` from the Scheduler's
  `claimTask` call survives every suite. 6T B2 tests the *store* predicate; no
  test asserts that the *Scheduler* asks for it. Silent loss of session-level
  exclusivity under a green tree.
- **M9 UNOBSERVABLE** — a global bus nothing reads cannot be detected
  behaviourally. A test asserting it would test the mutant's shape.

`INFERENCE` — the pattern across FINDING-01/03/04/05 is one thing, not five:
**assertions were written against the function that is easiest to test rather
than the one that runs.** Every one of these would survive a green CI run.

---

## 16. Property / state machine

600 seeds total, all passing, from `test/phase6v-adversarial-audit.test.ts`:

| property | seeds | result |
|---|---|---|
| P1 OFF never executes autonomously | 250 | PASS |
| P14 shutdown creates no work | 250 | PASS |
| P16 no resource leak | 250 | PASS |
| P9 incarnation monotonic | 200 | PASS |
| P6 readiness never bypassed (5 sources) | 150 | PASS |

Long-run §28.1: **500 trigger/cycle iterations** — every one of 10 tasks ran
exactly once (`gen 1 / attempt 1`), no drift, no requeue, no wedge, subscription
count 1 during and 0 after stop, total < 60 s.

---

## 17. Reachability re-audit (§30) — no unexpected increase

| | 6U | 6V |
|---|---|---|
| production `new Scheduler(` sites | 1 | **1** |
| enablement boundary | 1 | **1** |
| autonomous execution adapters | 1 | **1** |
| direct autonomous tool invocation | 0 | **0** |
| hidden triggers | 0 | **0** |

`FACT` — no count increased. 6V added no production file; the only new file is
the audit test.

---

## 18. Regression matrix (§31)

**414 pass / 0 fail** across 15 files: 6P ownership/claim/cross-process · 6Q
deletion/incarnation/late-return · 6R context/busy/abort/child-lifecycle · 6S
permission/MCP/delegation/readonly · 6T capacity/policy/trigger/cancellation ·
6U composition/default-off/CLI-gate/injected-handler · 6C/6F/6K · taskstore ·
task-invariants · arch-map. **No previous invariant regressed.**

`tsc` **28 = baseline**. `biome` clean. Full suite **3286 / 23 / 3** — the 3 known
pre-existing (`VENDOR.md` ×2, `web ssg` nested list).

---

## 19. Findings

| id | sev | conf | type | summary |
|---|---|---|---|---|
| **FINDING-02** | **P1** | HIGH | DESIGN GAP / NOT IMPLEMENTED (6L D5′), newly REACHABLE by 6U | Cross-process reconciliation reverts a **live** in-flight execution. Same task executes twice concurrently; the first process's work is discarded. |
| **FINDING-01** | **P2** | HIGH | INTEGRATION DEFECT | `--enable-scheduler=false` and `=0` **enable** the Scheduler (`hasFlag` matches the `=` value form). Contradicts 6U's documented and tested property. |
| **FINDING-03** | P2 | HIGH | TEST COVERAGE GAP | `schedulerGateFor` can be made env-inheritable with no test failing. The "cannot be inherited" property is unverified at the deciding seam. |
| **FINDING-04** | P2 | HIGH | TEST COVERAGE GAP | The `!injected` guard in `createMinicodeSession` — the reason an autonomous child has no revocable mode control — is defended by **no** test. |
| **FINDING-05** | P2 | HIGH | TEST COVERAGE GAP | No test asserts the Scheduler passes `exclusive: true`; removing session-level exclusivity keeps the whole suite green. |
| INFO-01 | INFO | HIGH | DESIGN INCONSISTENCY | Two exported gate resolvers disagree (`resolveSchedulerGate` vs `schedulerGateFor`); the unused one is exported and tested. |
| INFO-02 | INFO | MEDIUM | NOT IMPLEMENTED | Nothing re-triggers on task readiness. Correctly recorded as an integration gap, not a defect. |
| INFO-03 | INFO | MEDIUM | NOT IMPLEMENTED | Signal handlers still `process.exit` synchronously; the `close()` ordering is best-effort. Safe only because recovery is crash-like. |

`FACT` — three **harness** defects were found, classified, and discarded rather
than reported as production findings: a deps thunk that threw unconditionally
(made 4 correct cases look like findings), a verdict reading `.g` where the store
returns `execGeneration` (printed "not reproduced" beside data proving the
opposite — a wrong verdict would have retired a real P1), and eight audit tests
built on assumptions production correctly forbids.

---

## 20. Standing limitations

1. **FINDING-02 is the blocker.** It needs a cross-process liveness mechanism —
   lease, heartbeat, or lock — that 6O explicitly rejected. That is a
   **product-level decision**, and 6U/6V are forbidden from inventing it.
2. `exec`/`acp` are off by omission, not by an explicit statement.
3. No `createCliSession`-level test exists (needs a live provider), so the
   production call site is covered only through `schedulerGateFor`.
4. Seven mutation anchors drifted, so M4/M7/M10/M11/M17/M19/M20 were **not run** —
   an honest gap in this campaign, not a clean result.
5. No adversarial run against a **real provider**; §8 uses the smallest fixture
   traversing production code, as the mission permits.
6. 6L D5′, the absent verifier, and the duplicate crash window are unchanged.

---

## 21. Exact evidence

```
bun test test/phase6v-adversarial-audit.test.ts        # 32 pass, 1168 assertions
bun test test/phase6p..6u + 6C/6F/6K + task + arch     # 414 pass / 0 fail
bunx tsc --noEmit                                      # 28 = baseline
bun test                                               # 3286 / 23 / 3
```
Harnesses under `%TEMP%\opencode`: `audit6v-gate.ts` (§3/§4, real processes),
`audit6v-core.ts` + `audit6v-xproc.ts` (§10/§11/§6, real processes),
`audit6v-mutation.ts` + `audit6v-classify.ts` (§15), `perf6v.ts` (§13).

---

## 22. GO / NO-GO

**NO-GO.**

- FINDING-02 is a P1 in a subsystem this phase's predecessor made reachable:
  two processes can now execute the same task concurrently and one discards the
  other's work. The mission's bar is "no P0/P1"; this is a P1.
- FINDING-01 is a live P2: a user who explicitly typed `=false` gets autonomous
  execution, because a documented and tested property was asserted against the
  wrong function.
- FINDING-03/04/05 are not live behaviour, but each is a security- or
  authority-relevant property that a single-line edit would remove with a fully
  green suite. `INFERENCE` — taken with FINDING-01, they describe one systematic
  weakness: **the tests were pointed at the easiest function rather than the one
  that runs.**

`INFERENCE` — the strongest result here is not "few findings". It is that every
plausible production failure path was turned into a reproducible experiment, that
FINDING-01/02/03/04/05 are real and reproduced rather than suspected, that three
harness defects were caught before they were reported as production problems, and
that 6P–6U hold 414/414 with no regression, no readiness bypass, no completion
fabrication, no context escape and no shutdown-created work.

`DESIGN DECISION` — 6U was not wrong about its architecture. It was incomplete
about two seams (`hasFlag`, `onPermissions`) and inherited one reachability
consequence (D5′). Fixing FINDING-01/03/04/05 is a contained change. Fixing
FINDING-02 is not: it requires deciding how MiniCode learns that another process
is alive, which is a product decision this audit must not make.
