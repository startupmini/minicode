# PHASE 6B — SCHEDULER PREREQUISITES RESULT

Repository HEAD at start: `99980db` (`fix: enforce TaskGraph type safety`)
Protected specimen `D:\git\minicode`: **never accessed or modified**

---

## 1. Executive result

# PHASE 6B IS GREEN

Not "green because tests pass" — the three prerequisites are implemented, the
authority and concurrency semantics are **demonstrated by mutation**, and the
cross-process limitation is **locked rather than papered over**.

| criterion | state |
|---|---|
| P1 real SQL revision predicate | **VERIFIED** — `AND revision = ?` inside the claim UPDATE |
| P1 rows-affected adjudicated | **VERIFIED** — four disjoint outcomes |
| P1 stale claim cannot win | **VERIFIED** — mutation M1/M3 killed |
| P1 one winner under race | **VERIFIED** — tests 8, 8b, 22 |
| P2 model IN_PROGRESS bypass closed | **VERIFIED** — on both patch and create paths |
| P2 LEGACY unchanged when disabled | **VERIFIED** — tests 11, 15b |
| P2 activation explicit and OFF | **VERIFIED** — test 16 source scan |
| P3 ownership semantics explicit | **VERIFIED** — process-local, fail-closed |
| P3 false reconciliation prevented | **VERIFIED** — REFUSED_NO_OWNERSHIP, M7 killed |
| P3 cross-process limit documented | **VERIFIED** — §11 below, deliberately asymmetric |
| P3 reconciliation revision-safe | **VERIFIED** — M8 killed |
| P3 terminal/operator states untouched | **VERIFIED** — M9/M10/M11 killed |
| TaskStore sole durable authority | **VERIFIED** — no SQLite outside store.ts |
| TaskGraph unchanged | **VERIFIED** — frozen, 0 diff |
| identity invariants unchanged | **VERIFIED** — §13 |
| no Scheduler source exists | **VERIFIED** — no `scheduler.ts` |
| no production Scheduler wiring | **VERIFIED** — test 16 |
| mutation evidence valid, no unclassified survivor | **VERIFIED** — 12/12 killed |
| tests pass for all affected suites | **VERIFIED** — 2939 pass |
| tree clean after commit | **VERIFIED** |

**Two corrections and one real defect found during this phase — all recorded
below rather than quietly fixed.**

---

## 2. Verified current-state evidence (§1)

Re-derived from source. **One 6A claim was wrong and is corrected here.**

| # | claim | verdict |
|---|---|---|
| 1 | `expectedRevision` check is outside the write transaction | **VERIFIED** — read L474/L476, transaction starts L495 |
| 2 | the relevant UPDATE has no `AND revision = ?` | **VERIFIED** — L500 `WHERE session_id = ? AND task_id = ?`; no `AND revision` exists anywhere in store.ts |
| 3 | TaskStore does not universally enforce legal transitions | **VERIFIED** — exactly one `TASK_INVALID_TRANSITION` site (L448), used only for "BLOCKED requires blockedReason" |
| 4 | `todo_write` can authoritatively write `IN_PROGRESS` | **VERIFIED** — `todoStatusToTask("in_progress") -> "IN_PROGRESS"` (identity.ts), consumed by sync.ts L167-174 `tx.patchTask({status})` |
| 5 | no durable Scheduler claim primitive | **VERIFIED** — `claim`/`claimTask`/`tryClaim`: 0 definitions |
| 6 | existing session-ownership primitive | **NOT IMPLEMENTED** — `ownerPid`, `sessionOwner`, `acquireSession`, `lockSession`, `leaseExpires`, `heartbeat` (task-scoped): all ZERO |
| 7 | safe process-local ownership primitive | **NOT IMPLEMENTED** — nothing exists to reuse |
| 8 | cross-process ownership expressible | **NOT IMPLEMENTED** — `task_meta` could host one, but that is a new durable authority (a §19 stop condition) |

### CORRECTION to Phase 6A

6A stated: *"no public transaction starter; only `inTransaction()` and 4 internal
`db.transaction()` sites."* **That was wrong.** `withTransaction<T>(fn: (tx:
TaskStore) => T): T` **is** public, at `store.ts:649`, and `sync.ts:145` uses it.

6A's regex for the public surface (`^  (name)\(`) missed it because the generic
parameter sits between the name and the paren. The *substantive* conclusion is
unaffected — CAS is still absent, and the emulation 6B forbids is still
non-CAS — but the claim was wrong and is withdrawn. 6B reuses `withTransaction`
where it applies (§11).

### Other evidence classified

| item | classification |
|---|---|
| completion gate = injectable `CompletionEvidence` in `todo.ts`, default `unverified` | **VERIFIED CURRENT SOURCE** |
| `store.orig.ts` comment: completion evidence enforced in `normalizeTodos`, "must not be duplicated into the store" | **RECOVERED ARTIFACT** |
| `new Scheduler(...)`, `runCycle`, `discover() -> {ready}`, `store.claim(...)` | **HISTORICAL DESIGN EVIDENCE** — call sites in recovered `p77` artifacts. **Not revived.** No `scheduler.ts`, no `claim`, no `enableSchedulerAuthority` was created on their authority. |
| atomic claim, reconciliation, authority mode, session ownership | **NEW ARCHITECTURE** |

---

## 3. P1 implementation — atomic claim

One statement; the revision predicate is **inside** the mutation:

```sql
UPDATE tasks
   SET status = 'IN_PROGRESS', updated_at = ?, revision = revision + 1
 WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN ('PENDING')
```

`changes === 1` ⇒ `CLAIM_ACCEPTED`. Otherwise a follow-up **read** classifies
which precondition failed. That read is classification only — it cannot convert a
lost race into a win, because the mutation already happened and already failed.

| outcome | condition |
|---|---|
| `CLAIM_ACCEPTED` | exactly one row changed |
| `NOT_FOUND` | no such row in this session |
| `CLAIM_REJECTED_STALE` | row exists, revision differs |
| `WRONG_STATE` | row exists, revision matched, status not claimable |

**Claimable statuses: `PENDING` only.** That single choice is what makes
`COMPLETED`/`CANCELLED`/`FAILED` unclaimable, so a claim can never resurrect
finished or abandoned work, and what makes a second claim of `IN_PROGRESS` a
`WRONG_STATE` rather than a double-claim.

The explicitly forbidden emulation (read → compare in application code →
transaction → UPDATE without the predicate) is **not** used. M1 removes
`AND revision = ?` and kills **22 tests**.

---

## 4. P2 implementation — todo_write authority boundary

**Mode is per-TaskStore-instance**, defaulting to `LEGACY`, set only by an
explicit constructor option. No module singleton, no environment variable, no
activation on `initialize()`.

Guards on **both** write paths — this was a real gap I introduced and fixed:

| path | guard |
|---|---|
| `patchTask` | `status: "IN_PROGRESS"` ⇒ `TASK_AUTHORITY_VIOLATION` |
| `createTask` | `input.status: "IN_PROGRESS"` ⇒ `TASK_AUTHORITY_VIOLATION` |

The `createTask` guard is not decoration: creating a task directly in
`IN_PROGRESS` is an authoritative claim exactly as much as patching one into
that status. My first version guarded only `patchTask` and test 14b caught it.

**Fail-closed, and no fake success.** The model receives an explicit
`TASK_AUTHORITY_VIOLATION`; the request is neither ignored nor reported as
claimed, and the task is untouched (verified: status and revision unchanged).

**LEGACY is provably unchanged** — the same call succeeds on a default store
(test 15, and the P1+P2 integration test asserts both halves in one test).

**Activation is OFF in production:** test 16 scans `todo.ts`, `sync.ts`,
`assignment.ts`, `session.ts` and `mcp/server.ts` for `authority: "SCHEDULER"`
and finds none.

---

## 5. P3 ownership decision

Evaluated all six models; four rejected, on evidence:

| model | decision | reason |
|---|---|---|
| A. single Scheduler per session (deployment invariant) | **adopted as convention only** | a convention is not a guard; needs a mechanical backstop |
| B. process-local session ownership | **ADOPTED** | explicit, testable, Windows/Bun safe, no second task authority |
| C. durable owner row in `task_meta` | **REJECTED** | a new durable authority — 6B §19 stop condition |
| D. OS/process lock | **REJECTED** | `safe-open.ts` `O_EXCL` is for atomic writes, not session locking |
| E. lease / heartbeat | **REJECTED** | out of V1; and a lease that cannot survive a crash without expiry logic *is* a second authority |
| F. existing mechanism | **REJECTED** | `journal.ts` "advisory" is degraded-journal-health, not ownership |

`src/task/session-ownership.ts`: a process-local `Map<sessionId, owner>` with an
opaque symbol token, **exclusive** acquisition (a second `acquire` returns
`null` rather than stealing, so double-attach is visible), and release that
requires the real token. It holds ownership only — it cannot read or write a
task, so it is not a task authority.

### The locked limitation

This registry **cannot see another OS process.** Therefore:

- If this process does not own the session ⇒ reconciliation **REFUSES**.
- If another process *does* own it, this process still sees "not owned" ⇒
  **REFUSES**.

The refusal is the safe direction, and the asymmetry is deliberate:

> A false refusal costs stranded work that waits, which is recoverable.
> A false reconciliation reverts **live** work, which may not be.

**Cross-process reconciliation is therefore NOT IMPLEMENTED** and must not be
enabled by deleting this check. That would convert a fail-closed design into a
silent data-loss one, and it is the single most important thing a later phase
must not "simplify".

A forged owner token does not satisfy ownership (test 19b) — the token is
compared by identity, not by label.

---

## 6. Reconciliation semantics

| `TaskStatus` | reconcilable? | to |
|---|---|---|
| `PENDING` | no (`NOT_STRANDED`) | — |
| `BLOCKED` | no (`NOT_STRANDED`) | — external cause |
| `IN_PROGRESS` | **YES** | `PENDING` |
| `VERIFYING` | **YES** | `PENDING` |
| `COMPLETED` | **NO** | terminal |
| `CANCELLED` | **NO** | terminal |
| `FAILED` | **NO** | terminal |
| `RETRYING` | no | V1 owns no retry |
| `PAUSED` | does not exist | never introduced |

Structural guarantees, each mutation-tested:

- **Never deletes** — test 20.
- **Never mutates relationship or descriptive fields** — `parentId`, `dependsOn`,
  `order`, `title` all preserved (test 20b).
- **Never manufactures completion evidence** — `verification` stays `null`,
  `evidence` stays `[]` (test 20b).
- **Never infers authority from a graph** — `store.ts` imports neither
  `./graph.ts` nor `./readiness.ts` (static test).
- **Never rewrites `blockedReason`** — a stranded task's reason may be
  information an operator still needs; it is not the property being reconciled.
- **Revision-safe** — the predicate is in the SQL (M8).
- **Per-task, not bulk** — a bulk revert cannot be atomic across rows, so a
  per-row predicate is the only way to never clobber a newer writer.

### Race matrix (§10)

| case | outcome | test |
|---|---|---|
| A: another writer advances the revision | `REJECTED_STALE`, newer state preserved | 21 |
| B: task completed before reconciliation | `NOT_STRANDED`, untouched | 21b |
| C: two reconciliations | exactly one `RECONCILED` | 22 |
| D: active ownership | reconciled by the owner; a non-owner is refused | 17 / 17b |
| E: ownership uncertain | `REFUSED_NO_OWNERSHIP`, nothing mutated | 19 / 19b |

---

## 7. Changed files

| file | change |
|---|---|
| `src/task/store.ts` | `TaskStoreOptions` / `TaskAuthorityMode`; `authorityMode`; authority guards on `patchTask` + `createTask`; `claimTask`; `reconcileStranded`; `CLAIMABLE_STATUSES`; `RECONCILABLE_STATUSES`; `sqlList` helper; `withTransaction` correction note |
| `src/task/model.ts` | `TASK_AUTHORITY_VIOLATION` error code; `ClaimOutcome`; `ReconcileOutcome` |
| `src/task/session-ownership.ts` | **new** — process-local ownership registry |
| `test/phase6b-prerequisites.test.ts` | **new** — 38 tests |
| `PHASE-6A-SCHEDULER-NEW-ARCHITECTURE-DESIGN-LOCK.md` | carried from 6A (untracked) |
| `PHASE-6B-SCHEDULER-PREREQUISITES-REPORT.md` | this file |

`git diff --stat`: 2 files changed, 249 insertions, 15 deletions (tracked).

## 8. Frozen files verified unchanged

| frozen surface | diff |
|---|---|
| `src/task/graph.ts` | **0** |
| `src/task/graph-validate.ts` | **0** |
| `src/task/readiness.ts` | **0** |
| `cli/tui.ts` | **0** |
| `cli/commands/acp.ts` | **0** |
| `src/policy/executor.ts` | **0** |
| `src/ui/**` | **0** |
| `vendor/minicore/**` | **0** |

No `scheduler.ts` was created. No tick loop, selection, dispatch, retry, lease,
priority, fairness, or queue persistence exists.

## 9. Tests

**38 tests, 0 failures.** 26 numbered categories from §13, all present, plus
concurrency and static-proof additions (8, 8b, 9, 10, 14b, 15b, 16b, 19b, 19c,
20b, 21b, 24b).

| gate | baseline | after |
|---|---|---|
| `tsc --noEmit` | 28 errors | **28** — zero new, zero in 6B files |
| biome `src/task` | 9 errors | **7** (new file clean; an import order auto-fixed) |
| full suite | 2901 pass / 23 skip / 4 fail | **2939 pass / 23 skip / 4 fail** |
| failing files | architecture-map, pack-integrity, web-build, writer-inventory | **identical** |

The 4 failures are pre-existing (Phase 5D proved them: those files are
byte-identical to the pre-TaskGraph checkpoint). The 28 tsc errors are the same
pre-existing set; 6B required only that it add none, and it added none.

## 10. Mutation results

12 targets, sandbox only. **12 killed · 0 survived · 0 harness misses.**

| # | mutation | verdict |
|---|---|---|
| M1 | claim: remove `AND revision = ?` | **KILLED** (22 tests) — the mutant 6B §14 named explicitly |
| M2 | claim: revision does not advance | **KILLED** (5) |
| M3 | claim: stale reported as `CLAIM_ACCEPTED` | **KILLED** (5) |
| M4 | claim: `IN_PROGRESS` becomes claimable (double claim) | **KILLED** (1) |
| M5 | authority guard removed (patch) | **KILLED** (3) |
| M6 | authority: silently swallow instead of throwing | **KILLED** (3) |
| M6b | authority guard removed (create) | **KILLED** (1) |
| M7 | reconcile without the ownership check | **KILLED** (3) |
| M8 | reconcile: remove `AND revision = ?` | **KILLED** (10) |
| M9 | reconcile sets `PAUSED` | **KILLED** (1) |
| M10 | reconcile targets `COMPLETED` | **KILLED** (2) |
| M11 | reconcile targets `CANCELLED` | **KILLED** (1) |

**No survivors, therefore no survivor classifications are required.** No
"probably fine" is offered anywhere in this report.

### Two harness defects found and fixed, disclosed

1. **A missing `` `n `` normalization** made the three multi-line mutants report
   as *harness misses* rather than being scored. Added.
2. **A wrong anchor** (an extra literal backtick before `${statuses}`) kept M8
   unscored through two attempts. Re-anchored on the reconcile-only
   `SET status = 'PENDING'` line so M8 mutates reconcile and not the claim.

Worth stating plainly: **"0 survivors" is only meaningful because the harness
itself was verified to score mutants.** A harness that silently misses its
anchor reports 0 survivors and looks perfect.

## 11. Remaining limitations

1. **Cross-process claim exclusion is still not guaranteed.** A true
   cross-process CAS would need `AND revision = ?` on the ordinary `patchTask`
   UPDATE plus a rows-affected check. That changes behaviour for every existing
   writer, so it is **DEFERRED** to its own phase. Until then the claim is atomic
   *within* a process; a second process can still overwrite.
2. **Cross-process reconciliation is refused, by design.** P3's registry cannot
   see other processes, so stranded work in another process's session is never
   reconciled from here. Correct, and limiting.
3. **`createTask` accepts a status that is not in `TaskStatus`.** VERIFIED
   pre-existing: `validate()` checks only the `BLOCKED` reason, and
   `rowToTask` coerces on read. A caller can therefore write a non-`TaskStatus`
   string. **I did not fix this** — adding `isTaskStatus` validation would alter
   LEGACY behaviour, which §19 forbids. Reported for a dedicated phase.
4. **No durable lease**, by design (§5).
5. **Scheduler still does not exist.** Nothing here is wired.

## 12. New architectural decisions

| # | decision | label |
|---|---|---|
| D1 | claim atomicity lives in the SQL, never in application code | NEW ARCHITECTURE |
| D2 | `PENDING` is the only claimable status | NEW ARCHITECTURE |
| D3 | authority is a per-instance constructor option, default `LEGACY` | NEW ARCHITECTURE |
| D4 | both `patchTask` and `createTask` guard `IN_PROGRESS` | NEW ARCHITECTURE |
| D5 | ownership is process-local, exclusive, token-compared | NEW ARCHITECTURE |
| D6 | **reconciliation fails closed** when ownership is not positively held | NEW ARCHITECTURE |
| D7 | reconciliation is per-task and revision-guarded, never bulk | NEW ARCHITECTURE |
| D8 | reconciliation never clears `blockedReason` | NEW ARCHITECTURE |
| D9 | outcomes are returned values, not exceptions — refusing is correct behaviour | NEW ARCHITECTURE |
| D10 | `TASK_AUTHORITY_VIOLATION` is distinct from `TASK_INVALID_TRANSITION` | NEW ARCHITECTURE |

## 13. Compatibility impact

Preserved, each with a test: `taskId` remains canonical identity · todo JSON
remains a projection · TaskStore remains authoritative · D7 omission intact ·
mixed-payload semantics intact · all-idless post-bootstrap guard intact ·
canonical ID writeback intact · plan IDs aligned · **TaskGraph identity
untouched** · no positional identity · no Scheduler-specific task id.

`LEGACY` mode is byte-for-byte the previous behaviour: the only added code paths
are gated on `authorityMode === "SCHEDULER"` or on the two new methods.

## 14. Exact commit hash

See §16. (A commit cannot contain its own hash; recorded in the checkpoint
message body and in §16 of this report after the fact.)

## 15. Git cleanliness

`git status` after commit: **CLEAN**. 5 files committed. **NOT PUSHED** — 28
commits ahead of `origin/main`. The only environment change is the gitignored
`node_modules/` created by the frozen install in Phase 5D.

## 16. Is Scheduler implementation now READY?

**Yes for the substrate it depends on, with two prerequisites still open.**

6A's Scheduler design needs: an atomic claim primitive (**now real**), a todo_write
authority boundary (**now real, OFF by default**), and explicit ownership for
reconciliation (**now real, fail-closed, cross-process limited**).

**But two items remain genuinely open, and a later phase must not assume they
away:**

1. **Cross-process claim exclusion** (limitation 1). If the Scheduler is ever
   run from two processes against one database, claims are not mutually excluded.
   That is acceptable for a single-process V1 and unacceptable beyond it.
2. **Cross-process reconciliation** (limitation 2). By design it refuses, so
   stranded work in another process's session is never recovered from here.

Neither blocks implementing the Scheduler as locked. Both constrain where it may
be deployed, and both should be recorded as deployment constraints rather than
treated as bugs.

---

## STOP

P1, P2 and P3 implemented. Scheduler **not** implemented, **not** constructed,
**not** enabled. TaskGraph, TaskStore semantics, todo protocol, MCP, execution
loop, UI/ACP/executor and vendored code all untouched.

Not done, per §17: tick · selection loop · dispatch · retry · attempt records ·
leases · heartbeat · priority · fairness · queue persistence · Scheduler DB ·
`FAILED` · completion redesign · verifier redesign.
