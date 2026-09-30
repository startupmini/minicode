# PHASE 6X - CROSS-PROCESS SCHEDULER AUTHORITY

Implements the design selected in 6W (ADR-20/21) and closes both 6V findings.
Verdict: **GO** for the code as committed. The Scheduler remains **OFF by default**.

## 1. What was wrong

### F02 (P1) - two processes could reconcile the same session

[FACT] 6V reproduced this: a second process reverts a first process's live
execution. The cause was structural, not a missing check. Authority lived in a
module-level in-memory registry, so it was invisible across processes, and
`reconcile()` - the one function that reverts other parties' in-flight work -
consulted only that registry. 6W confirmed no notification exists to wake a
scheduler when a peer starts, so the collision window is open, not theoretical.

### F01 (P2) - `--enable-scheduler=false` enabled the Scheduler

[FACT] `cli/index.ts` read the gate through `hasFlag`, which matches
`token.startsWith(name + "=")`. So `=false`, `=0` and even `=whatever` all
enabled autonomous execution. The gate module was already correct and unit
tested; the production caller was not using it. That is the exact shape of
6V's finding - a tested module beside an untested expression.

## 2. The fix

A durable, session-scoped lease. One row per `(session_id, incarnation)` holding
an owner token, an owner pid, an acquisition time and a lease deadline. Exactly
one Scheduler may hold it; a second process that tries to acquire while the lease
is valid fails closed.

[FACT] Acquisition is a single `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE`,
so a concurrent pair of acquirers has exactly one winner. It is deliberately not
a read-then-write, which would reintroduce the race F02 needed.

Four boundaries enforce it, all fail-closed:

| Boundary | Behaviour without authority |
|---|---|
| `start()` | throws `ownership-unavailable`, releases the token it took, STOPPED |
| `runCycle()` | returns `authority-lost`, cancels the turn, self-disposes |
| `reconcile()` | returns `[]` and touches nothing |
| `stop()` / self-dispose | hands the lease back, so a replacement is not locked out |

[DESIGN DECISION] Two distinctions are load-bearing and pinned by tests:

- **Release deletes, expiry preserves.** A clean stop is an unambiguous handover,
  so no row is left for a later reader to mistake for a live owner. A crashed
  owner's row survives, so the takeover history stays inspectable.
- **`authority-lost` means one thing only:** our lease is gone *and the session is
  still ours*. A deleted-and-recreated session also stops us holding the lease,
  because the lease is keyed by incarnation, but that is reported as
  `session-superseded` - the true cause, with the right release ordering and 6Q's
  backstop. Conflating them would misdiagnose the cause and point at the wrong
  suspect.

[DESIGN DECISION] The `runCycle()` authority check sits *after* the 6T incarnation
check for that reason, not by accident of ordering.

## 3. Two real bugs the tests caught

Recording these because both were wrong in ways review would not have shown.

**The takeover upsert never updated `owner_token`.** It refreshed the deadline and
pid but left the old token in place, so after a legitimate takeover the row still
named the previous owner: their token passed `holdsSessionAuthority` while the new
owner's did not. Both processes would have believed they were authoritative. Caught
by the expiry-takeover test asserting on the *recorded* owner, not just on the
`ACQUIRED` return value.

**A self-disposing instance retained its lease.** 6Q/6T fixed the "wedged forever"
instance by releasing process-local ownership on self-dispose. With a durable lease
the wedge came straight back, only now with a 5-minute timeout. Fixed by releasing
in `disposeSelf()` and on the supersession path, both token-guarded so a stale
instance can never evict its successor.

## 4. What this is not

- Not a liveness proof. An expired lease means nobody renewed in time, not that a
  process died. A stalled owner loses authority - 6W chose that direction
  deliberately, because at session granularity a wrong answer costs wasted work,
  while the old per-task status cost duplicate execution.
- Not a replacement for lineage. `exec_generation` / `attempt_generation` still
  answer "what happened to this execution"; the lease answers "who may schedule".
  The two layers never read each other.
- Not a task lease, a lineage redesign, a TaskGraph redesign, a daemon, or a
  distributed scheduler. Not in scope and not done.
- `hasFlag` is **unchanged**. Its value-form behaviour is correct for
  `--permission`, `--cwd` and friends. The bug was choosing it for a valueless
  flag; a source-level test pins that the call site uses the resolver and that no
  `hasFlag(args, "--enable-scheduler")` survives.

## 5. Evidence

| Gate | Result |
|---|---|
| `tsc --noEmit` | 28 errors, unchanged from the 6W baseline |
| `biome check` | clean on all 8 touched files |
| Full suite | 3315 pass, 23 skip, 4 fail |
| `test/phase6x-cross-process-authority.test.ts` | 30 pass (R1-R10 + F01) |
| `test/phase6x-cross-process-acceptance.test.ts` | 1 pass |

[FACT] The 4 failures are all pre-existing and unrelated: `VENDOR.md` fingerprint
mismatch (x2), the `web ssg` nested-list renderer guard, and a known-bad 3C
identity-duplication test. The 3 known at 6W plus the P1 guard test, which this
phase initially broke by inserting the authority block inside the
`claimTask`..`reconcileStranded` range that test slices. The block was relocated to
the end of the class rather than weakening the guard.

[FACT] The F02 acceptance test spawns **two real `bun` processes** against one
`tasks.db` with a file rendezvous, not a sleep. This is deliberate: 6V's
in-process reproduction shared the in-memory registry, so it could not have caught
a fix that only worked in one process. No mock and no shared memory.

Mutation: M1 (lease never expires - expiry clause removed) → 23 of 31 fail. Killed.

## 6. One test expectation changed, deliberately

6P H7 asserted that a fresh Scheduler can start after a restart simulated by
clearing in-memory state alone. Under 6X that is correctly impossible: a restart
must release or outlive the lease. The test now stops the first Scheduler, which is
the graceful-restart path. The crash path - no release, lease held to expiry - is
covered by the 6X expiry and takeover tests instead. This is a tightened
expectation, not a weakened one; the assertion that the H5 shape survives the
handover is unchanged.

## 7. Limits of this evidence

- The renewal interval (60s) and lease (300s) are derived from the runtime timeouts
  (`BASH_DEFAULT_TIMEOUT_MS` 30s, `SUB_AGENT_TIMEOUT_MS` 120s), **not** from measured
  turn-duration samples. A real deployment should re-derive them from observed
  distributions; a turn longer than 300s without progress would lose authority and
  waste the work.
- `INFERENCE` The lease is safe only because every boundary re-reads it. A
  long-running turn holds authority in memory between checks, so a process suspended
  past the lease can briefly believe it still owns a session another process has
  taken. 6Q's incarnation check remains the durable backstop on the write itself.
- No fault-injection test for renewal itself (a lease expiring mid-turn under real
  timer pressure); R6 covers the stolen-lease path by direct manipulation.
- Mutation coverage is one confirmed kill, not the full M1-M28 campaign 6W planned.
