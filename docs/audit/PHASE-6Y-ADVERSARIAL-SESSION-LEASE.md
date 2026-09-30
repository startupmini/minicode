# PHASE 6Y — ADVERSARIAL SESSION-LEASE AUDIT

Audit of the 6X session-scoped Scheduler lease. **AUDIT ONLY** — no production
code was changed except one architecture-map documentation entry (§32 lists
audit documentation as allowed).

- Checkpoint audited: `964c0b7` (tree CLEAN at start)
- Verdict: **GO**, with one open coverage finding that is *not* a lease property
- Scheduler remains **OFF by default**
- 6X's F01 and F02 both remain closed

---

## 1. F02 regression reproduction

[FACT] 6V reproduced F02 in-process with two `TaskStore` handles. That proved the
*logic* was wrong but not that the *bug* was fixed, because the original defect was
that authority was invisible across processes — and inside one process the in-memory
registry **is** shared.

[DESIGN DECISION] 6Y therefore drives the acceptance test with **real `bun`
processes** against one `tasks.db`, coordinated by file barriers and never by a
sleep. A sleep barrier would make the race probabilistic, and a mutant could
survive by being lucky.

`test/phase6y-process-lease.test.ts` — 12 real processes, 6 cold rounds:

| Property | Result |
|---|---|
| Exactly one `ACQUIRED` per round | 1 (6/6 rounds × 12 processes) |
| Exactly one owner token current | all 12 observers agree on the winner |
| No partial lease rows | every observer saw a complete, well-formed record |
| Losers never claim / cycle / recover | 11/11 losers refused at the lease |

The F02-shaped test — one winner holding a live claim, eleven others attempting a
full `Scheduler.start()` → `cycle()` — reports that **every** loser was refused with
`lease held by another process`, never reached a claim, and produced no cycle
result. The winner's live claim survived all eleven attempts.

## 2. Lease state model

[FACT] One row per `(session_id, incarnation)`:
`owner_token`, `owner_pid`, `acquired_at`, `lease_expires_at`.

- ACTIVE while `lease_expires_at > now`; EXPIRED when `<= now`.
- Acquisition is **one** `INSERT … ON CONFLICT … DO UPDATE … WHERE`.
- `holdsSessionAuthority` is the single predicate every scheduling boundary reads.
- Authority is a *claim on the right to schedule*. It is **not** a liveness proof.

## 3. Atomic acquisition

Killed by **M2** (12 tests) and **M3** (12 tests). The property "a concurrent pair
has exactly one winner" is exercised 72 times per campaign run.

## 4. Owner token integrity — primary audit

[FACT] The 6X bug (deadline and pid moved, `owner_token` left stale) is **M7**,
and it is killed by **24 tests**. The mutation removes the
`owner_token = excluded.owner_token` assignment from the takeover upsert; without
it the row keeps naming the previous owner, so their token still passes
`holdsSessionAuthority` while the new owner's does not — both processes would
believe they were authoritative.

[FACT] A displaced owner fails closed on all five boundaries, each tested on a
**separate** `Scheduler` instance:

| Boundary | Behaviour |
|---|---|
| `hasAuthority()` | false |
| `renewSessionAuthority` | `AUTHORITY_LOST`, successor's deadline unmoved |
| `releaseSessionAuthority` | `false`, successor still owner |
| `reconcile()` | `[]`, stranded claim untouched |
| `cycle()` | `authority-lost`, no dispatch, no recovery |

[DESIGN DECISION] Separate instances are required. The first refusal disposes the
instance, so a combined test would report `not-running` for the later boundaries
and prove nothing about the lease. That ordering effect is itself pinned by
`OBSERVED: once any boundary disposes the instance, later calls are not-running`.

## 5. Renewal

[FACT] `renewSessionAuthority` predicates on `owner_token` **only** — it never asks
whether the lease is still active.

- [OBSERVATION] An owner whose lease has lapsed but which nobody has taken over can
  renew it back to full and become authoritative again.
- [INFERENCE] This is **not** a split brain: the durable row is only ever one, and
  any concurrent takeover is still serialised by SQL. It is an availability
  observation, recorded because the mission asks for the boundary to be determined
  rather than assumed.

[DESIGN DECISION] Under load the database's atomic condition decides. Both
orderings are tested: A-renews-first ⇒ B refused; B-takes-over-first ⇒ A's renew
`AUTHORITY_LOST`. In both, exactly one side is authoritative afterwards.

[FACT] A real renewing process was never displaced: 20+ renewals all
`AUTHORITY_HELD`, 10 rival acquisitions all `REFUSED_LEASE_HELD`. On the owner's
clean stop the session is immediately available with no expiry wait.

## 6. Expiry

[FACT] The boundary is exactly: **active iff `expires_at > now`**, asserted at
`expires_at − 1`, `expires_at`, `expires_at + 1`. At exact equality the lease is
EXPIRED, and the acquirer side (`<= ?`) agrees at the same instant — there is no
one-millisecond window in which a lease is simultaneously free and held.

Killed by **M24** (inverted comparison, 23 tests) and **M25** (ms treated as s,
19 tests).

## 7. Stale renewal and stale release

Stale renew and stale release are both refused, and the successor's token, pid and
deadline are provably unmoved. Tested with the same process, a separate connection,
a stale `Scheduler` object, and a reused PID.

[FACT] **PID is informational.** `owner_pid` appears exactly twice in the lease
block: once as an upsert `SET` target, once as a projected column. It never appears
in a `WHERE` clause or a comparison.

## 8. Incarnation

An old token cannot acquire, renew or release the new incarnation. A new
incarnation is a different authority, not a continuation.

[OBSERVATION] **Lease rows are never deleted on session deletion.** Nothing in the
deletion path removes them, and `releaseSessionAuthority` resolves the incarnation
at *call* time — so after a bump it targets `(session, newInc, myToken)`, which
does not exist, and the old row survives. Confirmed: 4 delete/recreate cycles leave
5 rows for one session.

[INFERENCE] Not an authority defect — nothing ever reads a non-current incarnation —
but it is unbounded growth across delete/recreate cycles, and it contradicts the
`releaseSessionAuthority` doc comment claiming release "gives the lease back".
Recorded as a finding. **Not patched** (audit only).

Killed by **M12** (60 tests), **M16** (60), **M17** (7), **M23** (30).

## 9. Deletion

Deleting a session invalidates authority **at the incarnation bump**, before any
task row is removed. A live turn is cancelled, the lineage write is refused
(`TASK_GONE` / `SESSION_SUPERSEDED`), and the instance self-disposes.

Killed by **M18**.

## 10. Self-dispose

| Path | Lease released? | Recovery |
|---|---|---|
| normal `stop()` | yes, immediately | immediate |
| explicit dispose | yes | immediate |
| session delete / supersession | yes | immediate |
| shutdown | yes | immediate |
| authority lost | no-op (token-guarded) | n/a, already lost |
| **process crash** | **no** | **expiry only** |

[DESIGN DECISION] The last row is the honest one. Crash recovery is a **deadline**,
not a detection: nothing observed the crash, and `recovery_ms` is exactly
`SESSION_LEASE_MS`.

## 11. Crash recovery

[FACT] A crashed owner blocks takeover until `expires_at` (proved with a real
process that exits without releasing), then frees the session with no manual step.

## 12. Slow execution

[FACT] A live owner renewing across many intervals was never displaced in 10
rival attempts.

[OBSERVATION] A process that **stops** renewing is displaced once the lease lapses,
even though it never died. That is the intended trade, not a defect.

## 13. Timing evidence — **TIMING UNVERIFIED**

[DESERVATION, recorded plainly] The mission asks for measured model-turn
distributions. **No real provider data exists in this environment**, so the
production configuration is **TIMING UNVERIFIED**. The tuning constants are
**not** changed (§32 forbids it, and there is no evidence to justify a change).

What *was* measured is the harness with injected stub turns — reported as harness
data, explicitly not as model latency:

| Workload | n | median | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| model-only | 40 | sub-ms | sub-ms | sub-ms | sub-ms | < 5 ms |
| tool-heavy | 40 | sub-ms | sub-ms | sub-ms | sub-ms | < 5 ms |
| filesystem-heavy | 30 | sub-ms | sub-ms | sub-ms | sub-ms | < 5 ms |

[FACT] The two configuration ratios 6Y *can* verify without production data:

- `renewals_per_lease` = 5 (one lease, five chances — a single missed tick is not fatal)
- `lease / SUB_AGENT_TIMEOUT_MS` = 2.5
- `lease / BASH_DEFAULT_TIMEOUT_MS` = 10

[INFERENCE] These show the shape is coherent, not that 300 s is the right number.
Deriving it properly requires a sample of real turn durations split by workload.

## 14. Clock assumptions

[FACT] All timestamps are epoch **milliseconds** in one representation. Every
authority method takes `now` as a parameter defaulting to `Date.now()`;
`performance.now()` appears **nowhere** in `store.ts` or `session-authority.ts`, so
there is no mixed monotonic/wall comparison. A year-2100 clock produces a
safe-integer deadline with no overflow or truncation.

[FACT] Scope: **single host, local `tasks.db`**. Wall clock is shared because there
is exactly one host. **No cross-host safety is claimed.**

## 15. PID semantics

Informational, proven three ways: never in a `WHERE`, never in a comparison, and a
same-PID/different-token renewal is refused.

## 16. Authority-loss lifecycle

Every autonomous path fails closed — `start`, `runCycle`, `reconcile`, `renew`,
`release`. There is **no** path from *authority lost* to *claim then execute*: after
stealing the lease and calling all five entry points in the worst order, the claim
table was never written to, no lineage row exists, and the task is still `PENDING`
at its original revision.

Killed by **M9**, **M10**, **M11**, **M21** (the authority check moved after
scheduling begins).

## 17. Reconciliation — the direct F02 bridge

Valid lease → the authority reconciles. No lease → it may not. A stolen lease →
`reconcile()` returns `[]` and the stranded claim stays `IN_PROGRESS`. A **control**
test proves the same `reconcile()` *does* revert when authority is present, so the
guard is the reason rather than a broken function.

## 18. Task claim

The lease gates scheduling; 6O's revision-CAS still admits the claim. With
authority the cycle reaches a real claim (`RECORDED`); without it the cycle never
reaches `claimTask` at all. **No claim logic was duplicated or modified.**

## 19. Multiple sessions

Independent acquisition, renewal and expiry. Stopping one session leaves the
other's lease, pid, token and deadline untouched, and the stopped session is
immediately available.

## 20. Multiple Scheduler objects

Clearing only the in-memory registry — i.e. simulating a second process — leaves
the durable lease as the sole authority, and the second instance is refused with
`lease held by another process`. After the first stops, the second acquires
immediately.

## 21. Production composition

The executed expression in `cli/index.ts` is asserted by reading the file the
product runs, **not** by calling the resolver. This is the check 6V's F01 needed;
a test of `resolveSchedulerGate` alone would not have caught it.

| Input | Enabled | Lease acquired? |
|---|---|---|
| no flag | no | **no row created** |
| `--enable-scheduler` | yes | yes |
| `=false` / `=0` / `=true` / `=whatever` / `=` | no | no |
| `--enable-schedulerx`, `--enable-sched` | no | no |
| `hello -- --enable-scheduler` | no | no |
| `MINICODE_SCHEDULER=1` | no | no |

With the gate shut, the `deps` thunk is **never invoked** and `getScheduler()` is
`null` — disabled mode is proved inert, not merely unused. Exactly one production
`new Scheduler(` exists, counted on comment-stripped source.

Killed by **M26**, **M27**, **M28**, **M29**, **M30**.

## 22. Mutation campaign

| | |
|---|---|
| planned | 31 |
| executed | **31** |
| KILLED | **28** |
| EQUIVALENT | 2 (argued below) |
| SURVIVED | 1 |
| UNEXECUTED | **0** |
| campaign failure | **none** |

Machine-readable: `docs/audit/PHASE-6Y-MUTATION-SUMMARY.json`.

**M15 — EQUIVALENT.** "Expiry extended without limit" cannot be detected because
extending *your own* lease **is** renewal, the intended semantics. The
security-relevant variants — extending *someone else's* lease (**M5**, killed) and
a renewal that always reports success (**M22**, killed) — are both covered.

**M19 — EQUIVALENT.** `disposeSelf()`'s `releaseAuthority()` is unreachable for any
path where the lease would still be held. `disposeSelf` is called from
`loseAuthority()` (lease already lost, so a token-guarded release is a no-op) and
from the `session-superseded` path (where the 6Q incarnation bump has already
re-keyed the lease). The `TASK_GONE` path — the one where the release is
load-bearing — does **not** go through `disposeSelf`: `dispatchTracked` calls the
deleted-session handler, which releases at `scheduler.ts:530`. Verified by
stack-tracing `releaseSessionAuthority` under the mutant.

**M31 — SURVIVED (open finding).** An injected 6S permission handler no longer
suppresses `onPermissions`, and no test detects it. This **confirms 6V's unclosed
P2 coverage gap** ("untested `!injected` permission wiring"), which 6X did not
address. It is a 6S/6U property, not a lease property, so it does not gate the
lease verdict — but it is a real gap and is reported as one, not excused.

## 23. Mutation anchor integrity

Enforced per ADR-24. For each mutation: semantic target → exact-substring anchor →
**exactly one** resolution required → source actually mutated → test executed.

The first campaign run produced **5 `UNEXECUTED`** (M4, M5, M6, M16, M19) because
those anchors resolved 2× or 0× in `store.ts` / `scheduler.ts`. That was recorded
as a **campaign failure**, and the anchors were made statement-specific (the
`UPDATE` shape for renew, the `DELETE` shape for release, the projected columns for
the read) before re-running. No anchor was skipped, and no unresolved anchor was
counted as a survivor.

## 24. Property testing

550 seeds × 40 randomized steps (400 single-incarnation, 150 with deletion and
recreation interleaved), asserting after **every** step: at most one valid owner;
active lease not stealable; deadline never precedes acquisition; acquisition never
in the future; the recorded owner is replaced on takeover; the old incarnation
never authorises the new one; a non-owner can change nothing.

[DESIGN DECISION] Three first-draft invariants were themselves wrong and were
fixed in the test rather than the code — recorded because a property test that
passes for the wrong reason is worse than none:

1. Guarding on the *valid* owner instead of the *recorded* owner — releasing your
   own expired lease is legal, so the property failed on correct behaviour.
2. `leaseExpiresAt === acquiredAt + leaseMs` — a renewal moves the deadline and
   deliberately leaves `acquiredAt` alone.
3. A random clock that jumped **backwards**, which `Date.now()` cannot do.

## 25. Stress

- 300 short `start`/`stop` cycles: the lease row is asserted **absent after every
  one**, not merely at the end — a single leak would wedge the session for a full
  lease period.
- 200 acquire/expire/takeover cycles: task revision and lineage are **byte-identical**
  before and after. The lease does not touch 6O's CAS and causes no generation inflation.
- 40 concurrent store handles against one file: one winner, all 40 agree on the
  recorded owner, cross-handle release works.

## 26. Persistence / migration

A pre-6X database (lease table dropped) re-opens with the table re-created
**additively**; the pre-existing task survives and a lease can be acquired
immediately. Repeated open/migrate cycles are idempotent. No stale authority
survives deletion, and a new incarnation receives no old lease. Task lineage is
untouched.

## 27. Security

Every wrong-token / wrong-session combination fails closed: wrong token, empty
token, right token with wrong session, right session with wrong token, expired
token, reused PID.

[FACT] **No crypto is required by the current architecture.** The token is
`Date.now() + counter + 32 bits of Math.random`. It is not a secret and is not
treated as one — the attacker model is another local process on the same
`tasks.db`, which can read the row directly. Unpredictability is defence in depth,
not the boundary.

## 28. Failure injection

Injected at L1 (before acquire), L2 (after acquire), L3/L4 (renewal), L5/L6 (expiry
and takeover), L7/L8 (release), L10/L11 (self-dispose and shutdown). In every case
the durable lease ended with **exactly one** valid authority or **none**; none
produced two. The 12-process race covers the same ground concurrently.

## 29. Evidence-quality audit

The failure pattern from 6V: a *tested module* beside an *untested expression*.

| Property | Production path tested? | Unit only? | Quality |
|---|---|---|---|
| F01 CLI gate | yes — `cli/index.ts` source read | no | strong |
| Scheduler construction | yes — one real site counted | no | strong |
| OFF mode acquires no lease | yes — real composition root, `deps` uninvoked | no | strong |
| F02 cross-process | yes — 12 real `bun` processes | no | strong |
| Lease acquisition semantics | partly — store methods + 2nd connection | partly | adequate |
| Reconciliation gating | yes — real `Scheduler.reconcile()` | no | strong |
| Scheduler renewal timer | yes — real 62 s wall-clock wait | no | strong (slow) |
| `hasFlag` unchanged | yes — real helper asserted | no | strong |
| Task claim CAS | partly — 6O suite untouched + reachability | partly | adequate |
| 6S `!injected` wiring | **no** | — | **gap (M31)** |

Only the last row is deficient, and it was already known.

## 30. Findings

| # | Severity | Finding |
|---|---|---|
| F-Y1 | low | `session_authority` rows are never deleted on session deletion; growth is unbounded across delete/recreate cycles, and `releaseSessionAuthority`'s doc comment overstates what it does. Inert — no non-current incarnation is ever read. |
| F-Y2 | low | `renewSessionAuthority` has no expiry precondition, so an owner whose lease lapsed without a takeover can re-extend it. Not a split brain; an availability semantics question. |
| F-Y3 | low | `AcquireOutcome` in `session-authority.ts` declares `RENEWED_BY_SELF`, which `store.ts` never returns. Dead type. |
| F-Y4 | **P2** | M31 SURVIVED: the `!injected` permission-handler seam is untested. Confirms 6V's unclosed gap. Outside the lease surface. |
| F-Y5 | informational | The lease is safe only because every boundary re-reads it. A process suspended past its lease can briefly believe it still owns a session another process has taken; 6Q's incarnation check remains the durable backstop on the write itself. |
| F-Y6 | informational | Timing is **UNVERIFIED** for production (§13). |

## 31. Residual limitations

- **No production model-turn data**, so 300 s / 60 s is unvalidated (§13).
- **M31 survives** — a real, pre-existing, non-lease coverage gap.
- M15 and M19 are argued equivalent rather than killed; the arguments are in §22
  and M19's rests on a stack trace captured under the mutant, not on reading alone.
- Long-running-turn coverage uses a **compressed** renewal cadence. The 60 s real
  cadence is covered by two dedicated 62 s tests, but no test runs a turn that
  genuinely lasts minutes.
- The 12-process race is a cold race; there is no test of 12 processes contending
  for a session that is *already* owned.
- Single host only. Nothing here says anything about a second machine.

## 32. Exact commands

```
bunx tsc --noEmit                                    # 28 errors, == 6X baseline
bunx biome check <8 touched files>                   # clean
bun test test/phase6y-lease-core.test.ts                     # 40 pass
bun test test/phase6y-process-lease.test.ts                  # 6 pass
bun test test/phase6y-production-and-lifecycle.test.ts       # 29 pass
bun test test/phase6y-property-stress-timing.test.ts         # 7 pass
bun test                                                   # 3399 pass / 23 skip / 3 fail
bun run scripts/phase6y-mutation.ts                        # 31/31 executed
```

The 3 full-suite failures are the pre-existing ones: `VENDOR.md` fingerprint
mismatch ×2 and the `web ssg` nested-list renderer guard.

## 33. GO / NO-GO

**GO.**

| Criterion | Result |
|---|---|
| F02 remains closed | yes — 12 real processes |
| at most one valid session lease owner | yes — 550 property seeds + 72 races |
| owner token changes on takeover | yes — M7 killed by 24 tests |
| stale token cannot renew | yes — M4, M5 killed |
| stale token cannot release | yes — M6, M23 killed |
| active lease cannot be stolen | yes — M2 killed |
| expired lease can be recovered | yes — M1 killed |
| long execution retains authority | yes — real renewing process, 10 rivals refused |
| deleted session cannot retain authority | yes — M18 killed |
| recreated session cannot inherit authority | yes — M12, M16, M17 killed |
| self-dispose releases authority | yes — all paths; crash is expiry-only, as designed |
| authority loss blocks all scheduling paths | yes — M9, M10, M11, M21 killed |
| reconciliation respects authority | yes — with a control |
| task claim unchanged | yes — 6O CAS byte-identical |
| F01 correct through the real CLI path | yes — M26, M27, M28 killed |
| all critical mutations execute | yes — 31/31, **0 UNEXECUTED** |
| no unexplained critical survivor | yes — M31 explained, non-lease, pre-existing |
| production-path tests exist | yes — §21, §29 table |
| 6P–6X regressions GREEN | yes |
| tree CLEAN | yes at commit |
| Scheduler OFF by default | yes — M28, M29 killed |

**NO-GO conditions — none met.** Two processes cannot simultaneously hold valid
authority; stale authority cannot renew or release; the owner token is replaced on
takeover; a deleted or recreated session cannot inherit authority; live execution
cannot be reclaimed under a valid lease; no critical anchor is unexecuted; the
production caller is tested.

**The one honest caveat.** This is *bounded authority*, not perfect liveness
detection, and the report does not hide that. The guarantee is: while a lease is
valid, at most one process may schedule that session; when it lapses, the session
becomes available again after a delay of at most `SESSION_LEASE_MS`, whether or not
anything died. Whether 300 s is the right number is **TIMING UNVERIFIED**.
