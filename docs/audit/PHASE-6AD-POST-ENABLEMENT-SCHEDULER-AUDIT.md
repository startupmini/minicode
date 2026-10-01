# Phase 6AD — Post-Enablement Scheduler Audit

**Verdict: GO** — no P0, no P1. The enabled production Scheduler survived every
deliberate attack, and all 18 production-path mutants are killed.

| Gate | Result |
| --- | --- |
| Full audit, pass 1 | `P0=0 P1=0 P2=3 P3=0 INFO=0` |
| Full audit, pass 2 (repeatability, §21) | `P0=0 P1=0 P2=3 P3=0 INFO=0` — identical |
| Probe validity | 68 probes accounted for = 64 self-check + 1 reason-matched refusal + 3 durable-read |
| Mutation campaign | 18/18 **killed**; 0 survived, 0 equivalent, 0 unexecuted |
| 6AD test suites | 32 pass / 0 fail (27 adversarial + 5 process authority) |
| `tsc --noEmit` | 28 errors, all pre-existing at HEAD; **0** from 6AD |
| `biome check` (6AD files) | clean |
| Production source (`src/`, `cli/`) | **unmodified** — `git diff -- src cli` empty |
| Full suite | 3518 pass / 23 skip / 5 fail — all 5 reproduce at clean HEAD |

Scope was audit-only. No production behaviour, lease timing, default state, or
architecture was changed. Every change in this phase is a test, a harness, or a
document.

---

## 1. What was actually attacked

Everything runs through the real product: real `createCliSession`, real
`/scheduler run`, real SQLite, and for §7/§12 real OS processes receiving real
signals. No probe was allowed to assert against a mock, and no probe was
allowed to report a result without first passing a validity gate.

| § | Attack | Result |
| --- | --- | --- |
| 0 | Golden path baseline | `incarnation=1`, `revision 1→2`, `PENDING→IN_PROGRESS`, `execGeneration=1`, `attemptGeneration=1`, `executionOwner=scheduler`, `triggerSource=explicit-command`, no fabricated `COMPLETED` |
| 2 | Failure semantics — 9 kinds (tool failure, permission denial, task deletion, supersession, session deletion, authority loss, provider HTTP 500, cancellation) | all failed closed; none fabricated completion |
| 3 | Permission widening through complete composition | autonomous child stayed read-only; no interactive-path access |
| 4 | Context isolation (child → parent) | parent session untouched |
| 5 | User × autonomous concurrency — 5 modes | no lost update, no double execution |
| 6 | F1/F2 regression — 4 modes | no stranding, no late execution after delete/recreate |
| 7 | Cross-process authority | B refused with `already has a valid autonomous lease held by another proc`; clean exit released the lease; a later process acquired a new one under its own pid |
| 8 | Trigger duplication ×1, ×2, ×10, after stop, after authority loss | exactly one execution; no generation inflation; not wedged |
| 9 | Lease mechanism (renew, stale release) | mechanism correct; values untouched |
| 10 | Crash/recovery at 7 named points | no P0/P1; lease survives, restarts stay blocked, no `COMPLETED` |
| 11 | Session deletion during execution | 2/2, no late write |
| 12 | Shutdown — 2 normal + 3 signalled | normal close releases the lease; signalled processes die with the lease intact, bounded recovery as in §10 |
| 13 | Readiness — no path bypasses TaskGraph → readiness → selection | 7/7 |
| 14 | Completion authority | Scheduler is never the author of `COMPLETED` |
| 15 | Operational observability | 2/2; confirmed the §6AC P2 gap is still open |
| 16 | 500-cycle long run | 500/500 evaluations and executions, 0 failures, max generation 1, no wedge, log bounded at 40, heap delta +3.1 MB, lease held |
| 18 | Property sequences (new) | 4 seeded sequences × 3–5 real ops; invariants held |
| 19 | Resource audit | 25 rounds; renewal timer released |

---

## 2. Findings

### P2 — `TIMING UNKNOWN` (§9)

The 60-second renewal and the full 300-second expiry were never observed.
Controlled runs finish in ~40 seconds, so no renewal ever came due. The
mechanism is verified; the two real values are not. Unchanged since 6AA.

*Not fixed here because changing lease timing is out of scope for an audit, and
faking a short lease to observe it would be evidence about the harness rather
than about the product.*

### P2 — `OPERABILITY GAP` (§15)

6R publishes the child `sessionId` on `AutonomousContextEvent`, but
`cli/setup.ts` passes no `onContextEvent`, and `ExecutionLineage` has no
child-session column. An operator can see that a cycle started and what the
parent session is, but cannot correlate the parent turn with the child session
that did the work. Unchanged from 6AC and unchanged by this audit.

### P2 — `INTEGRATION DEFECT` (§18) — **new in 6AD**

`Task` declares `readonly executionOwner: ExecutionOwner | null` as a required
field, but `rowToTask` in `src/task/store.ts` never populates it. Every `Task`
returned by `listTasks`, `getTask`, and `getSnapshot` therefore has
`executionOwner === undefined` rather than `null`.

**Severity rationale — why this is P2 and not P1:** `git grep '\.executionOwner'
-- src cli` matches only the declaration in `store.ts`. No production code reads
the field, so no current behaviour is wrong. The hazard is prospective: the type
promises a value, the runtime does not supply it, and the first caller who writes
`task.executionOwner === null` to mean "unowned" will get `false` for an unowned
task. That is a silent-wrong-answer bug waiting for a consumer.

This was found by the property harness, not by any hand-written scenario — the
scenarios all read fields that *are* populated.

---

## 3. Harness defects found and fixed

These matter as much as the product findings. Most of them were producing
**false confidence**, which is the specific failure mode an audit cannot tolerate.

### The mutation campaign could not be scoped

`--only` was read with `argv.indexOf("--only")`, which only matches the *space*
form. The `--only=M4` form advertised in the script's own usage comment
resolved to `-1`, so `only` stayed `null` and the script **silently ran all
eighteen mutants**. The summary was then written from a run the operator never
asked for. Both spellings are now accepted, and a flag with no value is
rejected rather than swallowed.

### One mutant had a stale anchor and was correctly reported UNEXECUTED

M2's anchor still pointed at a token-scanning gate from a pre-6AB revision; 6AB
moved flag parsing to the composition root, so the real gate is the strict
`enabled === true` identity check in `schedulerGateFor`. The anchor resolved
0× and the campaign reported `UNEXECUTED` rather than skipping it quietly. This
is the behaviour §19 requires and it is why the campaign is trustworthy. The
anchor now targets the real gate, and the mutant is the loose truthiness form —
which is the mutation that would turn a typo in flag plumbing into silent
autonomous execution.

### Four mutants survived for fixable reasons

| Mutant | Why it survived | Fix |
| --- | --- | --- |
| M4 | The test list named the 6AC/6AD suites, but 6Z's M31 composition test is what kills it. **A campaign defect, not a coverage gap** — the list did not name the killer. | Added an explicit `PERM` list naming the 6Z suite. |
| M13 | The concurrency test was **sequential** (`await` in a loop), so nothing was ever in flight and the mutant's removed in-flight check could never be exercised. | `Promise.all` over 5 concurrent triggers; assertion moved to durable state and counters. |
| M16 | The source check was **case-sensitive**, comparing `pushUser` against a mutant writing `sessionPushUser`. An earlier version also used a lazy regex group that stopped at the first `)`, capturing `onSchedulerNotice((line)` — a check that structurally *could not* fail. | Slice the source around the sink; case-insensitive sink names. |
| M17 | `run()` swaps `console.log` globally, so five concurrent calls raced on the same hook and some captured text came back empty. The empty string was then asserted on. | Assert on durable state and counters, which cannot race. |

M8, M12, and M13 were provisionally written up as `EQUIVALENT` on the reasoning
that the code was redundant. **That reasoning was wrong** — all three were killed
once the tests were built properly. The equivalence notes were deleted rather
than left in place, because an unused defence for a mutant that is in fact
killable is a claim that will outlive its own refutation.

### The campaign left production source mutated

After a killed campaign run, `src/task/production-scheduler.ts` was still
holding an M2 mutation (`token === SCHEDULER_FLAG` → `startsWith`). Had this
been committed, a mere `--enable-scheduler-*` prefix would have satisfied the
gate. Restored, and `git diff -- src cli` is now part of the verification that
every phase closes with.

### Two sections were testing the wrong thing

**§7** asserted "the orphaned lease blocks a takeover", but the `hold` child
leaves its window through a *normal* close, which releases the lease. The step
was observing a graceful release and applying the orphan rule to it, and it
emitted a false P1 because `Number(leaseAfter?.ownerPid ?? 0) === ownerPidBefore`
compared `0` to `0`. It now asserts what it actually demonstrates: a clean exit
releases the lease, and a later process acquires a new one under its own pid. It
asserts on the **child's own report** (`leaseHeld`, `leaseOwnerPid`, captured
while the lease is genuinely held) rather than on a post-exit read of a row the
child had already released. The genuine orphan case is not dropped — §10 owns it,
where a child is actually killed. Re-asserting it here with weaker evidence would
double-count a clean release as crash recovery.

**§18**'s first version treated a missing field as a wrong value and reported
**15 false P1 RUNTIME DEFECTs** on its first run. `executionOwner` was
`undefined` — absent, not wrong. Absence and disagreement are now different
outcomes with different severities, and the real finding underneath is the P2
reported in §2.

### The validity gate silently did not apply to two sections

`checkValidity` only accepted a child that emits a `selfCheck`. §7's refusing
child and §12's signalled children cannot emit one — a process that correctly
refuses has no reason to also report that it was supposed to, and a process
killed by a signal never gets the chance. Neither section counted, and the
summary printed `0/0 probes validated` for a section that had run real
experiments. A gate that silently does not apply is worse than no gate, because
the number looks like coverage.

There are three genuinely different kinds of evidence, and all three are now
accounted for with the criterion stated:

- **self-check** — the child ran to completion and asserted its own preconditions (64)
- **reason-matched refusal** — the child failed closed *and for the expected reason* (1). A refusal for a different reason — bad flag, missing provider, a crash — looks identical in `code !== 0` and would be worthless.
- **durable-read** — the child was killed, so the claim is verified by reading SQLite directly, which is stronger evidence than the child's own account (3)

---

## 4. Coverage and remaining evidence gaps

| Property | Evidence | Status |
| --- | --- | --- |
| Default OFF / exact flag gate | §0, M1, M2, 6AC | covered |
| Exactly one execution per cycle | §8, §18, M13 | covered |
| Single authority across processes | §7, 6AD process-authority suite (5) | covered |
| No fabricated completion | §10, §13, §14, §18, M12 | covered |
| Readiness never bypassed | §13, M6, M9 | covered |
| Permission containment | §3, M4, M3 | covered |
| Context isolation | §4, M7, M8 | covered |
| Incarnation / generation propagation | §6, M10, M11 | covered |
| Deletion + late execution | §2, §6, §11, M15 | covered |
| Cancellation on stop | §2, §12, M17 | covered |
| Event routing is not conversation | §15, M16 | covered |
| Production trigger is wired | M18, §0 | covered |
| **60s renewal / 300s expiry observed** | — | **NOT COVERED** (P2, values unobserved) |
| **Child sessionId correlated to parent turn** | — | **NOT COVERED** (P2, field not wired) |
| **Task.executionOwner populated** | §18 | **NOT COVERED** (P2, latent) |
| Full interactive TTY | source seam only | not covered — §3 proves containment |

## 5. Pre-existing failures, proven unrelated

`bun test` reports 5 failures. All 5 reproduce with the 6AD files removed
entirely (`git stash push --include-untracked`, re-run, restore):

- `cli: --resume > memuat riwayat sesi sebelumnya` — pre-existing
- `audit #11: pin vendor berlaku tanpa sibling` — pre-existing
- `audit #11: permukaan pack tepat` — pre-existing
- `§28.1 500 trigger/cycle iterations` — **a 5-second test timeout**, not a behavioural failure; machine-speed dependent
- `web ssg > docs tanpa nested list` — scans top-level `docs/*.md`; the 6AD report lives in `docs/audit/`, which it does not read

## 6. Reproducing

```
bun test test/phase6ad-adversarial.test.ts test/phase6ad-process-authority.test.ts
bun run scripts/phase6ad-audit.ts              # full audit
bun run scripts/phase6ad-audit.ts --only=7     # single section
bun run scripts/phase6ad-mutation.ts           # all 18 mutants
bun run scripts/phase6ad-mutation.ts --only=M2 # one mutant
bun run scripts/phase6ad-mutation.ts --restore # restore sweep after a killed run
```

Every audit section is scoped individually via `--only=<n>`, and the full audit
accepts `--repeat=<n>` for the §21 repeatability pass.
