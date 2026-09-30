# Phase 6W — Cross-Process Execution Authority

**DESIGN ONLY. No production code was changed. Scheduler remains disabled.**

**Verdict: DECISION SELECTED** — durable session-granularity ownership with lease
expiry, checked at `start()`. F01 correction specified separately. Neither is
implemented here.

Commit: `design: establish cross-process execution authority`
Baseline: `62b0bda` (Phase 6V) — clean tree, 48 commits ahead, nothing pushed.

---

## 1. F02 reproduction (deterministic, rendezvous — not a timing race)

6V raced two processes. 6W makes the ordering explicit: A writes a readiness file
**only after its turn is inside the agent loop holding an unresolved promise**, and
B refuses to start until that file exists.

```
A's durable row before B acts : {status:IN_PROGRESS, revision:2, exec_generation:1,
                                attempt_generation:null, session_incarnation:1}
A alive?                      : true   (turn inside the agent loop, promise unresolved)
B observed                    : {identical row}
B after ONE ordinary cycle    : {status:IN_PROGRESS, revision:4, exec_generation:2,
                                attempt_generation:2, session_incarnation:1}
B reclaimed the live claim?   : true
A still running?              : true
```

`FACT` — B performed a single ordinary cycle and advanced the generation of a task
A was demonstrably executing. A's process-local `ownsSession` check passed because
that registry cannot see another OS process.

`FACT` — `execution_owner` is `"scheduler"` for the whole of that window (verified
separately via `getExecutionOwnership`; see §19 D-04). It does not discriminate:
it records *who claimed*, never *whether they are still here*.

`FACT` — H1 (live) and H2 (crash at that instant) produce a **byte-identical**
durable row on every audited field.

---

## 2. The information-theoretic problem

`FACT` — the row carries `status`, `revision`, `exec_generation`,
`attempt_generation`, `execution_owner`, and the session incarnation. None of
these is a function of liveness.

`INFERENCE` — the ambiguity is not an implementation gap; it is structural. A
watcher with only this state cannot decide, because two distinct worlds produce
it. Any mechanism that closes it must add a fact that is a function of liveness,
and *no such fact is exact*:

- a clock-based fact (`lease_expires_at`) proves "recently alive", not "alive now";
- a process fact (`pid`) proves "the OS has that pid", not "it is our pid";
- only the holder can prove liveness, and only to itself.

`INFERENCE` — so the design question is not "how do we know?" but **"at what
granularity do we accept a bounded lie, and which direction does it err?"**

---

## 3. Authority candidates, re-opened

6B §8 rejected lease/heartbeat as "explicitly out of V1 scope… a second
authority", and 6L D5′ locked the process-local registry. 6W reopens that
rejection because 6U made the situation reachable.

| | candidate | how it answers LIVE vs DEAD | can it be exact? |
|---|---|---|---|
| A | **Lease with expiration** (per task) | lease not renewed ⇒ presumed dead | no — a stalled but live process looks dead |
| B | **Heartbeat** (per task) | periodic write ⇒ alive | no — same; plus write amplification |
| C | **DB lock / active-execution row** (per task) | row held by a live owner | no — a held row is a *claim*, not *proof*; identical to A with a row instead of a column |
| D | **OS/PID liveness** | `process.kill(pid,0)` / `/proc` | nearly — PID reuse, no start-time source in Bun, Windows has no `/proc` |
| E | **Separate execution registry table** | a durable "live executions" table | no — same fundamental limit; more schema |
| F | **Cooperative execution token** | — | **no** — process-local by construction; this is the thing that cannot cross processes |
| **G** | **Session-granularity durable ownership + lease** | a second process may not `start()` for a session whose owner's lease is live | no — but the bounded lie is placed where it is CHEAP |

`FACT` — A, B, C and E are the same mechanism with different storage. Grouping
them is not evasion: their analysis, failure modes and test requirements are
identical, and the storage choice is a migration detail.

`FACT` — D is genuinely orthogonal and stronger per-query (an exact pid check is
cheaper than waiting out a lease), but unsafe alone: `tasks.db` is a plain local
file, Bun exposes no portable process start-time, and Windows has no `/proc`.
It is therefore at best a **fast path that may shorten a lease wait**, never the
authority.

---

## 4. The granularity insight (why G, not A)

`DESIGN DECISION` — the decisive question is not "which mechanism" but "**at what
granularity does a false positive land?**"

| granularity | false positive means | cost |
|---|---|---|
| **per task** (A/B/C/E) | "this live execution is dead" ⇒ **two concurrent executions of one task** | **correctness** — F02 all over again |
| **per session** (G) | "this live owner is gone" ⇒ a second scheduler takes over the session and declines nothing; the live turn's work is discarded, and the task is re-executed by one authority at a time | **availability only** |

`INFERENCE` — at session granularity the residual failure degrades from
*corruption* to *wasted work*, because the two mechanisms that made F02 possible
are separately handled:

1. **No second Scheduler** can start, so no second reconciler exists. The
   reconciler is the mechanism that caused F02; removing its co-existence removes
   the defect.
2. **A deposed authority's late write is already refused.** Once the new owner
   re-claims the task, `exec_generation` advances, and 6Q's `recordAttemptReturned`
   returns `SUPERSEDED`. `VERIFIED` in 6Q and re-confirmed by 6V §10/§13.

`INFERENCE` — so the stale-write half of F02 needs **no new mechanism at all**.
Only the "two reconcilers" half does, and that is a *start-time* question, not a
*claim-time* one. This is why the design is small.

---

## 5. Safety vs availability

| mechanism | FALSE POSITIVE (live recovered as dead) | FALSE NEGATIVE (dead stays unrecovered) |
|---|---|---|
| A/B/C/E per-task | **two concurrent executions** — unacceptable | delayed recovery, work waits |
| D pid | pid reused ⇒ live execution reverted | process died, pid gone ⇒ fast recovery |
| **G per-session** | **wasted work, never duplicated** | scheduler declines to start until lease expiry |

`DESIGN DECISION` — the mission's stated priority is *never intentionally create
two concurrent autonomous executions for the same task*, and states that delayed
recovery "may be preferable to false live-execution reclamation". G is the only
candidate whose false positive does not violate that sentence. The cost of G is
that a crashed process's scheduler cannot restart until the lease expires —
bounded, and stated, not silent.

---

## 6. Long-running execution

`DESIGN DECISION` — a session lease is renewed on **observable progress**, not on
a timer. A timer is exactly what fails when the event loop is blocked (GC, SIGSTOP,
a debugger, a synchronous provider call), and 6T found the runtime has no
background timer to reuse.

Renewal points already available without new infrastructure:

| signal | source | already exists |
|---|---|---|
| turn started / step completed | kernel bus (`turn:started`, `step:completed`) | `vendor/minicore/src/core/events.ts` |
| provider streaming | kernel bus (`provider:text`) | same |
| each scheduler cycle | the scheduler itself | — |
| shutdown / stop | the composition root | 6U |

`INFERENCE` — a **provider that does not stream** produces no mid-call signal, so a
single long model call is bounded only by the turn timeout. The lease must
therefore be sized `> max(turnTimeout, toolTimeout) * safetyFactor`, and that
sizing is an explicit parameter, not a constant someone tunes later.

Worst case accepted: a process stalled (not crashed) for longer than the lease is
taken over. It then discovers at its next write that it has been superseded and its
work is discarded. **Duplication is impossible; waste is bounded.**

---

## 7. Crash semantics

| event | durable state | who decides "dead" | uncertainty |
|---|---|---|---|
| crash, DB survives | owner row with an unexpired lease | nobody, until expiry | bounded by lease |
| restart, same session | new process sees a live-looking owner ⇒ **declines to start** | the lease | bounded |
| restart after expiry | new process takes over, reconciles, re-executes | the lease | one duplicate window, preserved |
| crash during claim | either the whole claim transaction or none of it | the SQL | none — 6P atomicity |

`INFERENCE` — "when is execution dead?" becomes **"when has its owner's lease
stopped being renewed?"**, and **"who decides?"** becomes *"the next process to
look, after a deadline it did not choose"*. Both are weaker than the current
implicit assumption, and stating them is the point of this phase.

`INFERENCE` — the one-duplicate crash window is **preserved, not eliminated**. Two
processes can still briefly overlap across a lease expiry. Eliminating it would
require an arbiter that cannot itself fail, i.e. a daemon — out of scope by §12.

---

## 8. Claim semantics (must not regress 6P)

`FACT` — `claimTask` is a single atomic `UPDATE` that sets `status`,
`revision + 1`, `exec_generation + 1`, `execution_owner` and the capacity
predicate together. A rejected claim writes none of them.

`DESIGN DECISION` — **the claim statement is not modified.** Session ownership is
acquired *before* the claim, at `start()`. A1 ("at most one live authority per
task") then holds by construction, because only one process can reach the claim
for that session. Per-task claim atomicity is untouched.

---

## 9. Reconciliation semantics

Current predicate: `scheduler-owned ∧ unfinished ⇒ recover`.
`FACT` — `unfinished` is `attempt_generation IS NULL`, which §2 proved is also
what a LIVE execution looks like.

Proposed predicate:

```
recover  ⟺  scheduler-owned
         ∧ unfinished
         ∧ NOT demonstrably live
```

`DESIGN DECISION` — with G, "demonstrably live" is **structural, not queried**:
a process holding a live session lease is the only one permitted to reconcile, so
for any other process the third disjunct is already false. `INFERENCE` — this
avoids teaching `reconcileIfNoCompletedAttempt` about liveness at all, which
keeps the TaskStore change to a single new table/row and leaves the existing
lineage predicate byte-identical.

`DESIGN DECISION` — the proof source is therefore **the session-ownership record,
consulted at `start()`**, not a per-task lease read inside reconciliation.

---

## 10. Session deletion

| case | required behaviour | satisfied by |
|---|---|---|
| A active, session deleted | A cancelled; incarnation advanced; no resurrection | 6Q + 6U `notifySessionInvalidated` (VERIFIED) |
| A active, deleted, A survives | A's lease released on `stop()`; no successor blocked | the release must run on every terminal path |
| A active, deleted, A crashes | incarnation already advanced ⇒ writes refused | 6Q incarnation (VERIFIED) |
| A live, deleted by B, session recreated | old lease must not be inherited by the new incarnation | **lease is keyed by (session_id, incarnation)** — see A6 |

`DESIGN DECISION` — the lease key includes the session incarnation. Without it a
recreated session could inherit a dead predecessor's lease and refuse to start —
6Q's deletion already had to handle exactly this class of inheritance.

---

## 11. Scheduler restart — object vs process

`FACT` — these are different and 6W must not conflate them.

| | object restart (process alive) | process crash |
|---|---|---|
| ownership | same process still holds the lease | nobody holds it |
| new `Scheduler` object | `start()` sees its own live lease → allowed (same owner identity) | `start()` sees a live-looking owner → **declines** until expiry |
| risk | none | delayed recovery only |

`DESIGN DECISION` — the lease must record an **owner identity** (process id +
boot-unique token), not merely "a lease exists", so an object restart by the same
live process is distinguished from a takeover by another.

---

## 12. Process topology

`FACT` — `tasks.db` is `<cwd>/.minicode/tasks.db`; a local file, single host.

| topology | supported? |
|---|---|
| 1 process / 1 session | yes |
| 1 process / many sessions | yes — a lease per session |
| many processes / **same** session | **declined while a lease is live** |
| many processes / different sessions | yes — separate files or separate namespaces |

`INFERENCE` — the invariant to state, per §11: **"at most one Scheduler authority
per (session, incarnation) at any instant."** No global coordination is required:
the record is scoped to the session, and different sessions never contend.

---

## 13. F01 — CLI enablement semantics (separate correction)

`FACT` — `cli/args.ts:70`: `hasFlag` matches `token === name || token.startsWith(name + "=")`.
Production reads the gate through `hasFlag`; 6U tested `resolveSchedulerGate`.

Canonical semantics to specify:

| argv | required | rationale |
|---|---|---|
| `--enable-scheduler` | ENABLE | the one enabling form |
| `--enable-scheduler=false` | **DISABLE** | explicit negation must be honoured |
| `--enable-scheduler=true` | **DISABLE** (treat as unknown) | symmetric with `=false`; a boolean gate has no value grammar |
| `--enable-scheduler=<anything>` | **DISABLE** | no value form exists |
| `--enable-schedulerx`, `--enable-sched` | DISABLE | exact match only |
| after `--` | DISABLE | `hasFlag` already stops; preserve |

`DESIGN DECISION` — the fix belongs in the **production caller**, not in
`hasFlag`. `hasFlag`'s value-form tolerance is load-bearing for every other flag
in the CLI; changing it would alter unrelated behaviour. The gate reader must
therefore stop using `hasFlag` and match the exact token itself.

`DESIGN DECISION` — the two exported resolvers should not both survive. Keeping a
tested-but-unused resolver is precisely what let FINDING-01 through, and
FINDING-03 showed the same seam failing again. §14 generalises this.

`INFERENCE` — F01 is **not** in any way related to F02. Different layer
(argument parsing vs execution authority), different fix, different test. They are
recorded and scheduled separately on purpose.

---

## 14. Production-path evidence contract

`FACT` — 6V produced four coverage gaps (FINDING-01/03/04/05) with one root
cause: **the test asserted a helper, not the production caller.**

Proposed phase-level rule:

> Every security or correctness gate must have at least one test that traverses
> the **exact production caller** — the same function, module and call site the
> product uses.

| boundary | direct unit test | production-path test | status |
|---|---|---|---|
| CLI enablement | 6U A1–A3 | 6V D1–D14 (real process) | **GAP**: `=false` form fails |
| permission injection | 6U G1/G2 (handler shape) | 6U G1 (spec carries handler) | **GAP**: the `!injected` wiring is untested |
| TaskAuthorityMode | 6P suites | 6V §9 (`IN_PROGRESS` refused) | present |
| claim exclusivity | 6T B2 (store) | none | **GAP** |
| autonomous context | 6R suite | 6U D1 (deletion) | present |
| reconciliation | 6T/6Q suites | 6V §13 (evidence-based) | present |
| Scheduler construction | 6F J7 (static) | 6V P1–P7 (real process) | present |

`INFERENCE` — four gaps, one shape. The rule is cheap to satisfy and would have
caught all four.

---

## 15. Mutation-anchor integrity

`FACT` — 6V lost 7 of 20 mutants to anchor drift (formatting or reflow), which
made "survived" indistinguishable from "never ran".

`DESIGN DECISION` — anchors must be **semantic, not textual**. Ranked:

1. **Export identity** (best): locate the symbol, mutate its body via the AST or
   by a marker the source already contains.
2. **Compile-time location**: `import.meta` / stack traces to find the emitted
   span, then mutate that span.
3. **Structural normalisation**: strip comments and collapse whitespace before
   matching (survives `biome` reflow, dies on real rename).

Anti-rules:
- a mutant whose anchor is not found must be reported **UNEXECUTED** and the run
  **FAILED** — never folded into "survived";
- every campaign records `executed + killed + survived + unexecuted`, and
  `unexecuted > 0` fails the gate;
- a **no-op mutant** (replacement text identical to the original) must be
  rejected at construction — 6V's M20 was exactly this and still counted as a run.

---

## 16. Proposed invariants

| | invariant |
|---|---|
| A1 | At most one LIVE Scheduler authority per task. |
| A2 | Claim authority is durable. |
| A3 | A live execution is never reclaimed merely because `attempt_generation IS NULL`. |
| A4 | Crash recovery remains possible. |
| A5 | Authority survives process boundaries. |
| A6 | Authority cannot be inherited by a recreated session incarnation. |
| A7 | Session deletion invalidates old authority. |
| A8 | A new execution may start only after the old authority expires or is proven dead. |
| A9 | A rejected claim creates no generation. |
| A10 | Reconciliation cannot create overlapping executions. |

`INFERENCE` — A3 and A8 are the ones F02 violates today. A1 and A10 are
consequences. A6 is a NEW obligation that G introduces and that 6Q's incarnation
already satisfies for deletion.

---

## 17. Selected design

**Durable session-ownership record with lease expiry, acquired atomically at
`Scheduler.start()`.**

```
record:  (session_id, incarnation) PRIMARY KEY
         owner_pid, owner_token, lease_expires_at, acquired_at

start(): INSERT … ON CONFLICT DO UPDATE
         WHERE existing.lease_expires_at <= now()      -- expired, or ours
           OR existing.owner_token = our_token         -- same live process
         → refuses (ownership-unavailable) otherwise
```

`DESIGN DECISION` — implementable **without redesigning** TaskGraph, TaskStore
identity, the 6P ownership model, 6Q's incarnation model, 6R context, 6S
permission policy, or 6T policy/lifecycle. The changes are: one durable record,
one acquisition check, one renewal point, one release. The claim statement,
lineage, reconciliation predicate and readiness are **untouched**.

`INFERENCE` — clock source is wall-clock, and that is safe *specifically* because
`tasks.db` is a single-host local file: both processes read the same clock, so
skew is zero. `FACT` 6P/6Q both record this path as `<cwd>/.minicode/tasks.db`.
Cross-host skew would invalidate the design and is out of scope by §12.

---

## 18. Implementation phases (not done here)

1. **F01 first** — it is one line, independent, and currently live.
2. Durable owner record + `start()` acquisition (kills F02's co-existence).
3. Renewal on progress; release on every terminal path.
4. Production-path tests for all seven boundaries in §14.
5. Mutation harness with semantic anchors (§15).
6. Only then re-run 6V's P1 probe as an acceptance test.

---

## 19. Unresolved

| id | question |
|---|---|
| U1 | Lease duration and renewal floor. Needs real model-turn latency data; a guess is a correctness risk in the *safety* direction (§6). |
| U2 | Is session granularity enough, or does per-task authority become necessary if a future product allows several schedulers per session? |
| U3 | Should D (pid liveness) be a fast path? It is portable-hostile and must never be the authority. |
| U4 | Should the owner record live in `task_meta` (6B rejected this as "a new durable authority") or a dedicated table? 6B's rejection is exactly what 6W reopens, so it must be re-argued explicitly. |
| U5 | Does `exec`/`acp` remain off by omission? 6V INFO-02 flagged it. |
| U6 | Seven 6V mutants remain unexecuted; §15 must land before that campaign is trusted. |

---

## 20. Would-be findings discarded

`FACT` — three items looked like production defects and were **not**:

| id | what it looked like | reality |
|---|---|---|
| D-01 | first F02 probe "reproduced nothing" | verdict compared `.g`; the store returns `execGeneration`. A wrong verdict beside contradictory data would have retired a P1 |
| D-02 | `execution_owner: null` throughout the F02 probe | `execution_owner` is **not a field on `Task`**; the reader is `getExecutionOwnership()`. Verified `"scheduler"` after claim — 6P intact |
| D-03 | 4 gate cases "FINDING" | the probe's deps thunk threw unconditionally, so every *correctly enabled* case crashed |

`INFERENCE` — D-02 is the one worth remembering: a plausible-looking snapshot
field that does not exist on the object would have been reported as "6P ownership
is lost", a fabricated P1.

---

## 21. Final design verdict

**DECISION SELECTED, with explicit residual limits.**

The central question — *who can prove this execution is alive?* — has no exact
answer for a local CLI with no arbiter. The selected design answers it as
**"nobody, exactly; a second process is simply not permitted to ask until the
first one's lease expires"**, and confines the resulting uncertainty to **wasted
work rather than duplicated execution**.

`FACT` — this does not restore 6V's NO-GO on its own. F02 is not fixed until
§18 is implemented and 6V's P1 probe becomes a passing acceptance test.

`DESIGN DECISION` — the deliverable of this phase is that the ambiguity is now
named, its cost quantified, and its resolution placed at the granularity where a
wrong answer is merely expensive rather than corrupting.
