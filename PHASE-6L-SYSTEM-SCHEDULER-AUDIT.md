# PHASE 6L — SYSTEM SCHEDULER AUDIT

Base: `c671337` (`fix: close scheduler integration safety gaps`)
**Audit only. No production change. No enablement. No lineage redesign.**

---

## 1. Executive result

# GREEN — no P0/P1 runtime-correctness defect. Two P2 repo-integrity defects, both introduced by the Scheduler programme itself.

| | |
|---|---|
| **P0 / P1 runtime defects found** | **0** |
| **D6** architecture map omits 8 Scheduler `src/task/*` files | **P2 — OPEN, attributable to 6B/6C** |
| **D7** `test/phase6k-integration-safety.test.ts` carries a UTF-8 BOM | **P2 — OPEN, introduced by 6K itself** |
| **D8** 6K's recorded baseline (4 failures) is wrong; true count is 5 | **P3 — OPEN** |
| **I1** `RETRYING` is a declared-but-unwritable, permanently inert status | **INFO** |
| **D5′** cross-process live-owner recovery, now with a real witness | **P2 — ACCEPTED/DEFERRED (by design)** |
| line collision search (exhaustive, 5 910 transitions) | **0 collisions** |
| system property testing (500 seeds) | **20 774 checks, 0 violations** |
| production `new Scheduler(` | **0** |
| full suite at `c671337` | **3 044 pass / 23 skip / 5 fail** |

**Recommendation:** the Scheduler design is sound and safe to *continue building*. D6 and D7 must be fixed before any enablement, because the repository's own quality gates are red and were reported as green.

---

## 2. Scope and method

Phases 6A–6K were audited as a **composed system**, not as isolated units. The question is not "does each phase work" but "does the system they compose hold its invariants when the parts interact under crashes, restarts, concurrency, and adversarial scheduling."

Method, in order:

1. Reconstructed the true global state machine from source (not from artifact prose).
2. Exhaustively searched the execution-lineage state space for history collisions.
3. Ran **genuine multi-process** tests (separate OS processes, one database).
4. Probed the readiness and completion boundaries with negative cases.
5. Ran system-level property testing over randomised operation sequences.
6. Exercised persistence, restart, deletion and schema-migration paths.
7. Re-ran the full suite and audited the *baseline claim itself*.
8. Static reachability analysis of every task status.

Evidence labels: `[FACT]` observed/executed, `[OBSERVATION]` pattern seen, `[INFERENCE]` reasoned conclusion, `[DESIGN DECISION]` intentional per 6A–6K.

---

## 3. The global state machine (corrected)

`[FACT]` The real union is **eight** statuses (`src/task/model.ts:45`):
`PENDING | IN_PROGRESS | VERIFYING | BLOCKED | FAILED | RETRYING | COMPLETED | CANCELLED`.

`[FACT]` Reachability and authority, as composed:

| Status | Written by | Claimable | Reconcilable | Eligible | Ready |
|---|---|---|---|---|---|
| `PENDING` | store reconcile + model | **yes** | no | yes | if no blockers |
| `IN_PROGRESS` | **`claimTask` only** | no | **yes** | no | no |
| `VERIFYING` | model only | no | **yes** | no | no |
| `BLOCKED` | model only | no | no | **yes** | never |
| `FAILED` | model only | no | no | no | no |
| `RETRYING` | **nobody** | no | no | no | no |
| `COMPLETED` | model only | no | no | no | no |
| `CANCELLED` | model only | no | no | no | no |

`[FACT]` The Scheduler owns exactly **two** states. `src/task/model.ts:42` states it directly: *"None is ever written by the store itself; they only widen what `isTaskStatus` accepts."*

`[FACT]` Authority boundary: `IN_PROGRESS` and `PENDING` are the only statuses a Scheduler may write, and only through `claimTask` and the guarded reconcile `UPDATE`. Completion is never a Scheduler output.

`[DESIGN DECISION]` `ELIGIBLE_STATUSES = {PENDING, BLOCKED}` (`src/task/readiness.ts:77`) and `dependencySatisfied ⟺ status === "COMPLETED"` (`:90`) — `FAILED`/`CANCELLED` deliberately do **not** satisfy, because a false positive executes dependent work on a false premise.

`[OBSERVATION]` An earlier inherited assumption that `RETRYING` did not exist was **wrong**; correcting it changed the state machine from seven to eight states. See I1.

---

## 4. Findings

### D6 — P2 — Architecture map omits 8 Scheduler source files (OPEN)

**Severity P2 · Confidence HIGH**

`[FACT]` `test/architecture-map.test.ts` asserts every `src/**` file appears in `docs/ARCHITECTURE.html`. It **fails**, listing 8 missing files:

```
src/task/assignment.ts      src/task/readiness.ts
src/task/graph-validate.ts  src/task/scheduler.ts
src/task/graph.ts           src/task/session-ownership.ts
src/task/identity.ts        src/task/sync.ts
```

`[FACT]` Attribution: these were added by `188e999` (*establish scheduler prerequisites*), `08b105f` (*implement scheduler core*), `7bff3bc` (*implement TaskGraph*), `05cf247`, `73bfecf`, `a616ce8`. `docs/ARCHITECTURE.html` was last modified at `5b4b94f` — a **pre-Scheduler** context fix.

`[INFERENCE]` The Scheduler programme added runtime source files without updating the architecture map, and no phase ran or reported this gate. It is a release-hygiene failure, not a runtime defect.

### D7 — P2 — 6K's own test file carries a UTF-8 BOM (OPEN)

**Severity P2 · Confidence HIGH**

`[FACT]` `test/import-convention.test.ts` asserts all tracked text files are UTF-8 **without** BOM. It fails on exactly one file: `test/phase6k-integration-safety.test.ts`.

`[FACT]` Byte-level confirmation — first bytes `EF BB BF 2F 2F 20` (`EF BB BF` = BOM, then `// `).

`[FACT]` `git log --diff-filter=A` → added by `c671337`, Phase 6K itself.

`[FACT]` Repo-wide scan of 599 tracked files: 3 carry a BOM — `.gitattributes`, `.gitignore`, and this test file. Only the test file trips the gate.

`[INFERENCE]` Phase 6K introduced a repository-encoding violation in the very commit that added the safety tests, and did not notice because it did not run the encoding gate.

### D8 — P3 — The recorded baseline is wrong (OPEN)

**Severity P3 · Confidence HIGH**

`[FACT]` `PHASE-6K-INTEGRATION-SAFETY-CORRECTIONS.md` §1 states: *"full suite — 3045 pass / 23 skip / 4 fail — the same 4 pre-existing"*.

`[FACT]` At that identical commit (`c671337`, working tree clean) the suite yields **3 044 pass / 23 skip / 5 fail**.

`[FACT]` Of the 5: **2 are Scheduler-attributable** (D6, D7). The remaining 3 — two `VENDOR.md` fingerprint mismatches and one `web ssg` nested-list check — are genuine pre-existing failures unrelated to task execution.

`[INFERENCE]` The baseline was not re-verified at the final commit, so two self-inflicted regressions were filed as "pre-existing". This is an audit-process defect: it is precisely how a real regression gets normalised away.

### I1 — INFO — `RETRYING` is a dead, permanently inert status

**Severity INFO · Confidence HIGH**

`[FACT]` `RETRYING` appears in `src/task/` at exactly two places: the type union (`model.ts:51`) and the validation array (`model.ts:61`). It has **zero production writers**.

`[FACT]` It is not claimable (`CLAIMABLE_STATUSES = ["PENDING"]`), not reconcilable (`RECONCILABLE_STATUSES = ["IN_PROGRESS","VERIFYING"]`), and not eligible for readiness.

`[INFERENCE]` A task persisted as `RETRYING` — by a pre-existing installation, a hand-edited database, or a future writer — would be permanently inert: never dispatched, never recovered, never reported ready. It is a declared state with no transition into or out of it.

`[INFERENCE]` `model.ts:40` records the provenance: the union was widened from 5 to 8 statuses per `docs/TASK_STATE_MACHINE_SPEC.md`, and five of them "are never written by the store itself". So this is inherited from the original spec, not a Scheduler regression. Worth documenting in the state machine rather than "fixing" by deletion.

### D5′ — P2 (ACCEPTED / DEFERRED) — Cross-process recovery of a live task, now witnessed

**Severity P2 · Confidence HIGH (reproduced) · Status: accepted, by design**

`[FACT]` Session ownership is **process-local**. With two real OS processes against one `tasks.db`:

- **S1 (claim race) — PASS.** Both processes called `claimTask` on the same row. Exactly one returned `CLAIM_ACCEPTED`; the other returned `WRONG_STATE`. `exec_generation` advanced **once**. The DB revision predicate provides genuine cross-process mutual exclusion.
- **S3 (live owner vs foreign reconciler) — witnessed.** Process A claimed a task and left it `IN_PROGRESS` with a live attempt. Process B, unable to see A's in-memory claim, ran `reconcile()` and returned that task to `PENDING`.

`[INFERENCE]` B recovers a task that is demonstrably alive, because liveness is held in process memory and is not observable to another process. This is the V1 limitation documented in 6E/6H — previously an *inference*, now a **reproduced fact** with a witness.

`[DESIGN DECISION]` Retained as a known limit. The Scheduler is disabled and single-process by contract; closing it requires durable leases, which is out of scope for 6A–6K. The audit's contribution is to upgrade it from assumed-safe to measured.

---

## 5. What was proven correct

### 5.1 Lineage collision search — 0 collisions

`[FACT]` Exhaustive search, depth 4 over 6 operations, **5 910 state transitions**, 9 distinct observable states. For every reachable `(status, exec_generation, attempt_generation)` the required action is well-defined:

| State | n | ground truth |
|---|---|---|
| `IN_PROGRESS｜1｜1` | 112 | true |
| `IN_PROGRESS｜1｜null` | 345 | false |
| `IN_PROGRESS｜2｜1` | 3 | false |
| `IN_PROGRESS｜2｜2` | 2 | true |
| `IN_PROGRESS｜2｜null` | 32 | false |
| `PENDING｜0｜null` | 780 | false |
| `PENDING｜1｜1` | 52 | true |
| `PENDING｜1｜null` | 224 | false |
| `PENDING｜2｜null` | 4 | false |

`[FACT]` **0 collision groups.**

`[INFERENCE]` The 6H claim — that the `(exec_generation, attempt_generation)` pair uniquely determines the required action — **holds**. There is no reachable state in which two different histories share an observation yet demand different actions. This is the central correctness property of the lineage design.

### 5.2 System property testing — 0 violations

`[FACT]` 500 seeds (`20260929…20261428`), 12 operation kinds (cycle, model patches, crash injection, restart, reconcile, terminal transitions, deletion, lineage writes), **20 774 assertions**, **0 violations**:

`IDENTITY` · `NORESURRECT` · `GENMONO` (generation never regresses) · `LINEAGE` (`attempt ≤ exec` always) · `TERMINAL` (a `COMPLETED`/`CANCELLED`/`FAILED` task is never dispatched) · `READINESS` (a non-ready task is never selected) · `DELETE`.

### 5.3 Readiness boundary — no bypass

`[FACT]`

1. A task with an unsatisfied `dependsOn` is **not** dispatched; its dependency is. `notReadyReason` = `blocked / DEPENDENCY_UNSATISFIED`. Correct.
2. Once the dependency reaches `COMPLETED`, the dependent becomes ready and is dispatched. Correct.
3. A durably `BLOCKED` task with **zero** derived blockers is `eligible-not-ready` — eligible but never dispatched. The 5C.1 distinction is preserved.
4. An invalid graph (dangling `parentId`) **aborts the cycle**: `stop = invalid-graph`, zero dispatches. Fail-closed.
5. **Reconciliation does not bypass dependencies.** A stranded `IN_PROGRESS` task that depends on an incomplete task is recovered to `PENDING` but remains `ready = false`.

### 5.4 Completion boundary — the Scheduler never fabricates completion

`[FACT]` After 6 cycles with a model that always returns: status stays `IN_PROGRESS`, `evidence = []`, `verification = null`, `acceptance = null`. **No `COMPLETED` is ever produced.**

`[FACT]` An external (model) `COMPLETED` write is honoured, and the Scheduler leaves it `COMPLETED` — no resurrection across 3 further cycles.

### 5.5 Persistence, restart, deletion, migration

`[FACT]`

- Lineage survives a store reopen: `{1, null}` → `{1, null}`.
- `deleteSessionTasks` leaves **0** rows; recreating the same session id yields **0** tasks — the 6K D4 regression does not recur.
- A **genuine pre-6I database** (table physically built without the lineage columns) is correctly upgraded on open via the production entry point: **15 columns → 17**, existing row preserved (`exec_generation = 0`, `attempt_generation = NULL`), and a direct `SELECT` against the new columns succeeds.
- The migration is idempotent across 3 repeated opens.
- After restart, a stranded `IN_PROGRESS` task is recovered; a task depending on it correctly stays `PENDING` until its dependency completes, then re-dispatches.

### 5.6 Enablement

`[FACT]` The only occurrence of `new Scheduler(` in `src/` is a **comment** (`scheduler.ts:29`). Zero production construction. The Scheduler remains dark.

---

## 6. Audit integrity — phantom findings refuted

`[FACT]` Six candidate defects were raised during this audit and **five were refuted by the audit itself** before being reported. They are recorded because a reader must be able to judge whether the surviving findings are real or artefacts of a hostile-but-error-prone harness.

| Candidate | Why it was wrong |
|---|---|
| Lineage collision (5 groups) | Simulator reset ground truth on a *rejected* claim. Harness bug. |
| Lineage collision (2 groups) | `crashReturn` flipped truth to "incomplete" after a generation had already completed — a semantically impossible operation. Harness bug. |
| Readiness bypass (`DEFECT`) | `String(bool)` is a truthy string, so the assertion took the wrong branch while the data line read `ready=false`. Harness bug. |
| Terminal task dispatched (125×) | A *global* dispatch counter counted the other task's dispatch. Harness bug. |
| Dangling-dependency throws (129×) | The generator deleted a task another depended on; the store **correctly** refused. Fail-closed behaviour, not a violation. |
| **Pre-6I migration broken (P0)** | `require('node:sqlite')` returns `undefined` under Bun, so the column probe silently read nothing. A genuine, isolated pre-6I database proved the migration **works**. |

`[INFERENCE]` The one lesson worth carrying forward: several of these were *plausible P0s*. The discipline that caught them was requiring every claim to be executable and re-derived from a clean harness. Notably, 6K's own D3 baseline reproduction prints `columns present after open: []` — the same shape as the false positive — which shows how easily a probe defect becomes a recorded "defect".

---

## 7. GO / NO-GO

### Runtime safety — **GO**

`[INFERENCE]` The composed system satisfies every safety property this audit could construct:

- 0 lineage collisions across the full reachable state space → the lineage pair is a sound action discriminator.
- 0 property violations across 500 randomised histories, including crash injection and restart.
- No readiness bypass, including through reconciliation.
- No fabricated completion, and no resurrection of terminal tasks.
- Fail-closed on invalid graphs and on legacy-schema writes.
- Real cross-process mutual exclusion on the claim path.

The standing limits are unchanged and were **not** re-litigated here: one duplicate window between a `runTurn` return and the lineage write; model/task intent remains unprovable; cross-process ownership is unsupported (D5′); no verifier component exists; no attempt history.

### Enablement — **NO-GO** (hygiene only)

`[INFERENCE]` D6 and D7 must be closed before the Scheduler is enabled anywhere. Neither affects runtime behaviour, but the repository's own quality gates are red **because of the Scheduler programme**, and D8 shows those regressions were previously recorded as "pre-existing". Enabling on top of a knowingly-red gate would repeat exactly the failure mode 6J/6K were created to stop.

**Sequencing:** D7 (strip one BOM) and D6 (add 8 filenames to the architecture map) are both mechanical and independent. D8 closes once they are, by re-recording the true baseline.

---

## 8. Deliberately not done

- No production source was modified. D6, D7 and D8 are **reported, not fixed** — 6L is audit-only.
- No lineage redesign, no Scheduler change, no enablement.
- `src/task/scheduler.ts` untouched.
- Exact-once execution, model-intent correlation, cross-process ownership and durable liveness remain `IMPOSSIBLE WITH CURRENT CONTRACT` / `DEFERRED`, per 6E/6H. This audit found no evidence that the composition silently depends on them.
- The protected specimen `D:\git\minicode` was neither read nor modified. One shell command resolved a relative path against it while probing for a BOM; the read targeted a non-existent path, failed, and returned nothing. It was re-run with absolute paths confined to the reconstruction repository.
