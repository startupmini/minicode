# PHASE 6P — DURABLE TASK EXECUTION OWNERSHIP

Baseline: **`9e33d19`** (`design: establish production scheduler integration architecture`) · tree CLEAN · 41 ahead · nothing pushed.

Implements **only** the 6O ADR-2 correction for **F1**. F2, autonomous context, trigger, approval,
shutdown, presentation and enablement are untouched. Scheduler production construction count: **0**
(the single occurrence remains the comment at `scheduler.ts:29`).

Labels: `[FACT]` · `[OBSERVATION]` · `[INFERENCE]` · `[DESIGN DECISION]`.

---

## 1. F1 reproduction (recorded BEFORE any production change)

`[FACT]` The 6O discriminating pair was reproduced against the unmodified store and is
byte-identical under the pre-6P schema:

| History | `status` | `exec` | `att` | Required action |
|---|---|---|---|---|
| **H2** claim → execution crash | `IN_PROGRESS` | 1 | NULL | **REVERT** |
| **H5** claim → crash → reconcile → user marks `IN_PROGRESS` | `IN_PROGRESS` | 1 | NULL | **LEAVE** |

`[FACT]` `DURABLY IDENTICAL? true`. `exec_generation` measured `1 → 1 → 1` across repeated
reconciliations — monotonic, never reset, because the reconcile `UPDATE` touched only `status`,
`updated_at` and `revision`.

`[FACT]` Also confirmed pre-change: `exec_generation > 0` separates only H1 (exec 0); `attempt_generation`
is NULL in both. `[DESIGN DECISION]` **This finding is preserved verbatim in this report and in the
source comments. `exec_generation > 0` was never a complete solution and must not be described as one.**

---

## 2. The 6O selected design

`[FACT]` 6O ADR-2: add a **fourth, separate durable fact** — "is the current `IN_PROGRESS` a Scheduler
claim that has not been reconciled?" — with Option A's `exec_generation > 0` retained as a
necessary co-condition, and the whole fix located **below** the Scheduler.

`[FACT]` Implemented as 6O chose: a nullable `execution_owner TEXT` column, `'scheduler' | NULL`.

### Rejected cheap fixes (and why)

| Fix | Why rejected |
|---|---|
| `exec_generation > 0` in the reconcile predicate | **Proven insufficient** — H2 and H5 are both `exec=1` |
| `attempt_generation` distinctions | NULL in both histories |
| status-only changes | no new information is added |
| flip production to `authority: "SCHEDULER"` | converts silent corruption into a hard `TASK_AUTHORITY_VIOLATION` on a **legitimate** model action, and does not help `LEGACY` readers |
| backfill `'scheduler'` onto pre-6P rows | **provably wrong in one direction**: a pre-6P row can already be H5 (claim → crash → 6B `reconcileStranded` → user `IN_PROGRESS`), so backfill would mark interactive work as Scheduler-owned and **reintroduce F1 on upgraded databases** |

`[FACT]` The last row is why the migration is additive-only with **no backfill**. `[INFERENCE]` The
ambiguity in legacy rows is irreducible — the fact was never recorded, and 6I's "NO INFERENCE" rule
forbids manufacturing it (inventing ownership would be the same error one column over).

---

## 3. Schema change and migration evidence

`[FACT]` One additive column: `execution_owner TEXT` (nullable, no default).

`[FACT]` `migrateExecutionOwnershipSchema(db)` — a **separate** function from 6I's lineage migration,
so the 6P change is independently reviewable and independently idempotent. Decides from
`PRAGMA table_info`, never a version stamp. `TASK_DATA_VERSION` deliberately **not** bumped.

| Test | Result |
|---|---|
| A. pre-change DB gains the column on open | PASS (E1) |
| B. current DB unaffected | PASS (E2) |
| C. repeated open idempotent (3×) | PASS (E2 — column present exactly once) |
| D. migration with existing rows | PASS (E1 — row, revision, lineage preserved) |
| E. task with lineage already populated | PASS (E1 — `exec=1/att=NULL` preserved) |
| F. task with NULL lineage | PASS (E3 — `exec=0/att=NULL`, owner `NULL`) |
| relations preserved | PASS (E4 — `parentId`, `dependsOn`) |

`[FACT]` **Lazy open discovered:** the `TaskStore` constructor does not open the database
(`store.ts:668`); the handle — and therefore the migration — opens on first use, or explicitly via
`initialize()`. This is pre-existing 6K behaviour, not a 6P change, and E1 now asserts it explicitly.

`[FACT]` `no backfill` verified in E1: after dropping and re-adding the column, an existing
`exec_generation=1` row reads `executionOwner = null`.

---

## 4. Ownership state model

`[FACT]` Four facts, deliberately **not** collapsed (6O §4):

```
status              WHAT the task is
execution_owner     WHOSE in-flight state it is
exec_generation     WHICH execution generation is current
attempt_generation  whether that generation's attempt reached its end
```

| Question | Answer |
|---|---|
| who may mutate status? | any writer, but only `claimTask` may create `IN_PROGRESS` under SCHEDULER authority (6B, pre-existing) |
| may Scheduler reconcile it? | **only** `execution_owner = 'scheduler'` |
| does a claim establish ownership? | **yes, atomically** with the generation and status |
| when does ownership change? | set by `claimTask`; cleared by reconcile, or by any write leaving `RECONCILABLE_STATUSES` |
| after execution return? | **retained** — the row is still Scheduler state awaiting a verifier |
| after crash? | retained; that is what makes recovery possible |
| after reconciliation? | **cleared** |
| user later works on the task? | depends on the resulting status — see the rule below |

`[DESIGN DECISION]` **The clearing rule, and why it is two rules rather than one:**

- status **stays** inside `RECONCILABLE_STATUSES` (`IN_PROGRESS`, `VERIFYING`) → ownership **KEPT**.
  A user writing `IN_PROGRESS` is the agent's plan cursor (`todo.ts:15-19`) laid on top of a live
  claim. It does not end the stranded execution (6O H3/H6), and only a legitimate authority may end a
  Scheduler execution. Releasing here would strand the generation forever.
- status **leaves** `RECONCILABLE_STATUSES` → ownership **CLEARED**. The row is no longer a Scheduler
  execution in flight, so leaving `scheduler` on it would be **stale** ownership a later reconcile
  could still match.
- **non-status** writes (title, order, dependsOn, evidence) never touch the column. Editing a title
  must not end an execution claim.

`[FACT]` The release is computed in SQL (`CASE WHEN ? IN (...) THEN execution_owner ELSE NULL END`),
so it stays inside the write transaction and needs no extra read — a read there would be a
read-then-write outside the mutation, exactly the hazard `expectedRevision` is documented not to be.

---

## 5. Claim semantics

`[FACT]` One statement now establishes all three facts atomically:

```sql
UPDATE tasks
   SET status = 'IN_PROGRESS', updated_at = ?, revision = revision + 1,
       exec_generation = exec_generation + 1,
       execution_owner = 'scheduler'
 WHERE … AND revision = ? AND status IN ('PENDING')
```

- no state where the generation says "Scheduler execution" while ownership says interactive/unknown,
  or the reverse
- a rejected claim writes **none** of the three (B2: stale and wrong-state rejections both leave
  `exec_generation` and ownership untouched)
- CAS protection unchanged

`[FACT]` M4 (claim sets ownership but not the generation) was killed by 14 tests, so the
"ownership without a generation" state is not reachable in practice; the `exec_generation > 0`
co-condition in reconcile is belt-and-braces for a future writer.

---

## 6. Reconciliation semantics

`[FACT]` Both reconcile paths now require ownership and release it:

```sql
… AND execution_owner = 'scheduler' AND exec_generation > 0
    AND (attempt_generation IS NULL OR attempt_generation < exec_generation)
```

`[FACT]` `reconcileStranded` (the 6B path used by `Scheduler.releaseClaim`) got the same contract —
verified in C5, which proves it can no longer revert a task whose claim was released or never ours.

`[FACT]` The Scheduler is **unchanged**: `scheduler.ts` is byte-identical to `9e33d19`. It already
delegated the lineage decision to TaskStore by design (`scheduler.ts:526-534`), which is exactly why
this fix could live below it.

---

## 7. TaskAuthorityMode interaction

`[FACT]` Both mechanisms exist and neither replaces the other:

| | `TaskAuthorityMode` (6B) | `execution_owner` (6P) |
|---|---|---|
| scope | per `TaskStore` **instance**, in memory | per **row**, durable |
| protects against | a SCHEDULER-authority store being used to author `IN_PROGRESS` | reconciliation of interactive work |
| cross-process | **no** — each process picks its own mode | **yes** — the row is shared |
| legacy writers | invisible (a `LEGACY` instance writes freely) | **visible** — ownership is not set, so reconcile refuses |

`[FACT]` F2 proves the gap concretely: a `LEGACY` writer in the same process wrote `IN_PROGRESS` onto a
Scheduler-owned row; the in-memory guard could not see it, and durable ownership made the decision
correctly. F3 proves the converse: with nothing claimed, a `LEGACY` writer is fully entitled and the
Scheduler still refuses to touch it.

`[DESIGN DECISION]` Neither was deleted or bypassed. The 6B header requirement — "tests must assert
that no production path sets this" — is unchanged and still satisfied.

---

## 8. History-collision results

`[FACT]` All histories now separate, verified by execution:

| # | History | `status/exec/att` | owner | Action | Result |
|---|---|---|---|---|---|
| H1 | interactive `IN_PROGRESS`, never claimed | `IN_PROGRESS/0/NULL` | null | LEAVE | PASS |
| H2 | claim → crash | `IN_PROGRESS/1/NULL` | scheduler | REVERT | PASS |
| H5 | claim → crash → reconcile → user `IN_PROGRESS` | `IN_PROGRESS/1/NULL` | **null** | LEAVE | PASS |
| H6 | claim → crash → user `IN_PROGRESS` (no reconcile) | `IN_PROGRESS/1/NULL` | scheduler | REVERT | PASS |
| H7 | H5 shape + Scheduler restart | `IN_PROGRESS/1/NULL` | null | LEAVE | PASS |
| H8 | claim → external `COMPLETED` → restart | `COMPLETED/1/NULL` | null | LEAVE | PASS |
| H9 | interactive `IN_PROGRESS` + restart | `IN_PROGRESS/0/NULL` | null | LEAVE | PASS |

`[FACT]` **No STATE AMBIGUITY remains.** The dedicated test *"H2 and H5 differ ONLY in ownership"*
asserts the two rows are equal on `(status, exec, att)` and differ on exactly one field, and that this
one field is what reconciliation acts on.

`[FACT]` The 6N reproduction re-run after the change now reports `recovered=[]` and
**`PRESERVED — no clobber`** (it previously reported `recovered=["t2"]`).

---

## 9. Restart results

`[FACT]` D1–D3: ownership survives a `TaskStore` reopen; a stranded owned task is recovered by a new
Scheduler after restart (and ownership is released); an interactive `IN_PROGRESS` is still left alone
after restart.

`[FACT]` **Cross-process (mandatory, genuine separate OS processes, one `tasks.db`):**

| Case | Result |
|---|---|
| A. interactive write (process 1) → reconcile (process 2) | **PASS** — `owner=null`, `IN_PROGRESS` preserved, `NOT_STRANDED` |
| B. two processes race one claim | **PASS** — one `CLAIM_ACCEPTED`, one `WRONG_STATE`, generation advanced **once**, ownership set once |
| C. ownership across a real process restart | **PASS** — process A sees `scheduler`; a fresh process `RECONCILED` and released |
| E. foreign Scheduler recovers a stranded claim | **PASS** — `recovered=["t1"]` |

`[INFERENCE]` Ownership decisions are therefore made from durable row state, never module-local state
(M8 proved the accessor is load-bearing by making it non-durable).

---

## 10. Mutation results

`[FACT]` 8 semantic mutants, **8 killed, 0 survivors**, `store.ts` restored byte-identical afterwards.

| ID | Mutant | Result | Killed by |
|---|---|---|---|
| M1 | claim omits the ownership write | KILLED (+15) | H2, H5 |
| M2 | reconcile omits the ownership condition | KILLED (+7) | **H1, H5** |
| M3 | inverted clearing (clear only when staying in-flight) | KILLED (+7) | H6, H8 |
| M4 | claim sets ownership but not the generation | KILLED (+14) | H2, H5 |
| M5 | interactive write never releases ownership | KILLED (+15) | H1, H5 |
| M6 | reconcile reverts but does not release ownership | KILLED (+6) | H2, H5 |
| M7 | ownership migration never invoked | KILLED (+2) | E1, E3 |
| M8 | accessor reports a non-durable module-local owner | KILLED (+15) | H1, H2 |

`[DESIGN DECISION]` **Audit-integrity note.** The first mutation run reported **8 survivors** — which
would have been reported as "8 semantic mutants survive". The cause was a harness defect: `bun test`
writes its results to **stderr** when spawned, and the harness read only stdout, so the baseline
itself read 0 pass / 0 fail. Fixed, re-run, and the file is now genuinely load-bearing. The lesson is
the 6M K6M-3 one again: a measurement defect looks exactly like a real result.

---

## 11. Property / state-machine results

`[FACT]` 300 seeds (`60601…60900`), 12 operation kinds (create, interactive cursor, claim, return,
stale claim, reconcile, requeue, complete, block/fail/cancel, title edit, restart), **17 821
assertions, 0 violations**:

`P1_NEVER_CLOBBER` · `P2_RECOVERABLE` · `P3_DURABLE` · `P4_ATOMIC` · `P5_STALE_CLAIM` ·
`P6_MONOTONIC` · `P7_IDENTITY` · `P8_COMPLETION`

`[FACT]` A second harness defect was caught and fixed here too: 124 `P2_RECOVERABLE` violations were
**not** a product defect. The restart operation cleared the in-process ownership token, so the
existing `Scheduler` correctly **failed closed** — and the harness misread fail-closed behaviour as
"not recoverable". A direct store call on the same row succeeded, proving the row was fine. Fixed by
rebuilding the Scheduler on restart, as a real restart does.

---

## 12. TaskGraph compatibility and completion boundary

`[FACT]` G3: ownership does not affect readiness, identity or dependencies. A task depending on a
**claimed** dependency is still `blocked`; `readyTasks()` is empty; `JSON.stringify(graph)` does not
contain `"scheduler"`.

`[FACT]` `taskId`, dependency and parent semantics, `TaskGraph`, `readiness`, `identity` and `model`
are all **byte-identical** to `9e33d19`. Ownership is execution state and never becomes graph identity.

`[FACT]` G1: a returning execution does not complete the task — `IN_PROGRESS`, `evidence=[]`,
`verification=null`; ownership survives the return and the completed generation is not reconciled.
G2: an external completion is honoured, ownership released, and the row is unrevertable.

`[FACT]` `Scheduler.reconcile()` is unchanged, so **Scheduler-owned in-flight status selection is
byte-identical** — 6L's no-revertible-terminal-state property is untouched.

---

## 13. Tests changed, and why

`[FACT]` 7 pre-existing tests failed and were corrected. `[INFERENCE]` Every one of them encoded the
pre-6P assumption that **any** `IN_PROGRESS` with no completion marker is stranded Scheduler work —
which is precisely the defect 6N F1 identified. None was weakened:

| Test | Change |
|---|---|
| `phase6f` B6, I1 | stranded fixtures now assert a **real** claim (`exec=1`) instead of a fabricated `exec=0` |
| `phase6f` I3 | switched to the plain `add` helper — it was about resting states, not stranded ones |
| `phase6f` J1 | split: J1 now proves ownership survives reopen; **J1b** pins the deliberate no-backfill consequence |
| `phase6c` 31, 32 | `addStranded` now goes through `claimTask` |
| `phase6b` 17, 18, 20b, 22, 26 | use a genuine claim; their intent (ownership gating, field preservation, races, isolation) is preserved and now also covers the ownership precondition |

`[FACT]` All three `addStranded` helpers previously planted `status: "IN_PROGRESS"` directly,
producing the **H1** shape that 6O requires to be left alone.

---

## 14. Residual issues

1. `[DESIGN DECISION]` **Pre-6P stranded claims are not auto-recovered.** A row predating
   `execution_owner` reads `owner = NULL`, so reconciliation refuses it; the task stays
   `IN_PROGRESS` and its dependents stay unready. This is a deliberate, operator-level availability
   cost, chosen over the alternative of guessing ownership and reverting interactive work (which
   would reintroduce F1). Pinned by J1b.
2. `[INFERENCE]` `RECONCILABLE_STATUSES` is now load-bearing in **three** places (both reconciles and
   the `patchTask` CASE). That is a new coupling worth noting; the constant is module-private and
   compile-time, so drift is a compile error rather than a silent bug.
3. `[FACT]` **F2 is untouched** by design. `cycle()` can still throw out of
   `recordAttemptReturned` and leave a stale claim, and `deleteSessionTasks` mid-turn still deletes a
   row an in-flight turn will write to. 6P makes the ownership state *more* precise; it does not
   change the F2 lifecycle. 6Q remains required.
4. `[FACT]` Session deletion, cancellation, shutdown, approval, trigger and enablement are all
   unchanged. `purgeExpired` (F6) is still unfixed — it belongs to 6Q/ADR-9.
5. `[INFERENCE]` The column name was `DECISION BLOCKED` in 6O; `execution_owner` is the concrete
   choice made here, and it stays compatible with a future Option C (separate intent/execution
   dimensions) because it is already orthogonal to `status`.

---

## 15. Final verdict

# GREEN

| Criterion | Status |
|---|---|
| H1/H2/H5 distinguishable | **YES** — and equal on all three previous fields |
| no history collision remains | **YES** — H1…H9 all separate; ambiguity test is a permanent fixture |
| ownership is durable | **YES** — survives reopen, process restart, and is read from the row |
| claim + ownership atomic | **YES** — one statement; M4 killed |
| cross-process ownership correct | **YES** — 4/4 genuine multi-process cases |
| restart preserves ownership | **YES** — D1–D3, C, H7/H9 |
| interactive `IN_PROGRESS` never silently reverted | **YES** — H1/H5/H9, P1, 300 seeds, M2/M5/M8 |
| Scheduler-owned stranded execution still recoverable | **YES** — H2, P2, M1 |
| TaskGraph semantics unchanged | **YES** — byte-identical |
| completion authority unchanged | **YES** — G1/G2; `Scheduler` byte-identical |
| no new P0/P1 | **YES** |
| migration safe | **YES** — additive, idempotent, no backfill, relations preserved |
| mutation campaign | **8/8 killed, 0 survivors** |
| full suite | **3078 pass / 23 skip / 3 fail** — the same 3 verified pre-existing |
| tsc / lint | **28 / 7** — both exactly baseline |
| production Scheduler construction | **0** |
| tree CLEAN | **YES** |

`[INFERENCE]` F1 is closed. The proof that matters is negative: the cheapest available fix
(`exec_generation > 0`) was tested first, found insufficient by construction, and **not** shipped.
The shipped fix adds one column, changes one SQL predicate per reconcile path, and required **no
Scheduler change at all** — which is the 6O prediction confirmed in practice.
