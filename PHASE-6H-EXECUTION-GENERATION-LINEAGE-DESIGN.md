# PHASE 6H — EXECUTION GENERATION & MARKER LINEAGE DESIGN

Base: `0890ca2` (`docs: adversarially audit execution attempt recovery`)
**DESIGN ONLY.** 0 production changes. 0 schema changes. 0 test changes.

---

## 1. Executive result

# DESIGN READY — one new durable datum, one atomic lineage predicate

| | |
|---|---|
| D1 reproduced | **VERIFIED** — 2 forms, incl. one requiring no crash |
| D2 reproduced | **VERIFIED** — session reuse makes `reconcile()` throw |
| root cause of both | **VERIFIED** — task revision is overloaded as execution generation |
| separation **proven** required, not assumed | **VERIFIED** — a discriminating counterexample (§3) |
| new durable datums | **1** (`exec_generation`); `attempt_generation` replaces the existing marker's column |
| tables added / removed | **0 added, 1 removed** (`task_attempt`) |
| writes per attempt | **unchanged** (1) |
| reads per in-flight task per cycle | **unchanged** (1) |
| reconciliation decision | **single atomic guarded UPDATE** (no read-then-write) |
| `TaskStatus` added | **0** |
| `model.ts` / TaskGraph / readiness / agent loop touched | **0** |
| D1 resolution | **principled** — generation advances only on an accepted claim |
| D2 resolution | **structural** — evidence co-located with the task incarnation |
| agent-loop changes required | **0** — not DESIGN BLOCKED |
| **design executed before adoption** | **VERIFIED** — shadow implementation, S1–S10 + §4.1 pair all as specified |
| LEGACY impact | **inert additive columns; no migration; old DBs valid** |

**Selected: put both execution fields on the task row and let one guarded
UPDATE decide lineage.** This is *less* machinery than 6F (a whole table
removed) and it makes D2 impossible by construction rather than by convention.

---

## 2. 6G D1 reproduction — **REAL DEFECT, VERIFIED**

```
claim        : rev=R2  marker={"attemptRevision":2}
external write: rev=R3  status=IN_PROGRESS  marker={"attemptRevision":2}
reconcile    : []
after 10 more: status=IN_PROGRESS rev=R3 runs=1
>> marker(R2) < rev(R3) treated as sufficient evidence -> NEVER recovered
>> WEDGED=true
```

**Form 2 — a crashed generation suppressed by an unrelated completed one:**

```
G1: rev=2 marker={"attemptRevision":2}
requeue -> rev=3; G2 claim -> rev=4  (crash before marker write)
marker still = {"attemptRevision":2}  <- belongs to G1, NOT G2
reconcile -> []   status=IN_PROGRESS
>> G2 CRASHED but recovered=false
```

---

## 3. 6G D2 reproduction — **REAL DEFECT, VERIFIED**

```
old incarnation: taskId=t1 marker={"attemptRevision":6} rev=7
deleteSession + recreate: same session, same canonical taskId=true -> t1
new incarnation rev=1   INHERITED marker={"attemptRevision":6}
new incarnation claimed -> rev=2 (crash before marker write)
reconcile THREW: attempt marker revision 6 exceeds task t1 revision 2
```

`deleteSessionTasks` deletes only from `tasks`, so `task_attempt` rows are
orphaned and reattach to the next task that receives the same canonical id.

---

## 4. Root-cause analysis — **NEW ARCHITECTURE (the central finding)**

Both defects have **one** cause: **the task revision is overloaded.**

`revision` has two jobs it cannot both do:

1. **concurrency version** — the CAS token for "did anyone else write since I
   read this row?"
2. **execution generation** — "which attempt is this?"

6F used it for both. Every write increments it, including writes with no
executor relationship whatsoever (title, order, dependency, parent,
`blockedReason`, evidence, cancellation). So the revision answers question 1
perfectly and question 2 not at all.

### 4.1 Proof that the separation is REQUIRED — **VERIFIED**

§3 demanded a proof, not a preference. Constructed by discriminating experiment:
two histories that reach the **same** observable pair by **different** routes.

| | ROUTE A | ROUTE B |
|---|---|---|
| history | attempt ran at rev 2, then **2 mutations** | attempt ran at rev 2, then **requeue + new claim**, then crash |
| observable | `{IN_PROGRESS, taskRev: 4, markerRev: 2}` | `{IN_PROGRESS, taskRev: 4, markerRev: 2}` |
| truth | the attempt **did** run | the rev-4 attempt **never** completed |
| required action | **DO NOT RECOVER** | **RECOVER** |

**The observable state is identical and the required actions are opposite.
Therefore no decision rule over `(task.revision, marker.revision)` can be
correct.** This is a proof, not a preference: separation is necessary, and
6F's design is unsalvageable by any comparison tweak — which is exactly why
§20 rejects "marker `<` always means recover" as *also* unsound.

**What 6F's `<` rule actually does:** it correctly answers ROUTE A (don't
recover) and wrongly answers ROUTE B (recover). One rule, one of two cases
wrong — and the wrong case is the one that strands a crashed task forever.
That is D1.

---

## 5. Generation definition — **NEW ARCHITECTURE**

> **An execution generation is the unique identity of one accepted claim.**

Formal:

| property | statement |
|---|---|
| created by | **exactly one event**: `claimTask` returning `CLAIM_ACCEPTED` |
| created on | a successful atomic claim, in the same SQL statement as the `IN_PROGRESS` write |
| advanced by | **nothing else, ever** |
| destroyed by | task deletion (the whole identity disappears with the row) |
| recorded as | `tasks.exec_generation`, an integer that only `claimTask` increments |
| scope | one task row; it is *not* a global or per-session counter |
| identity of the *run* | `tasks.attempt_generation` — the generation whose attempt reached its end |

**A generation is an opportunity, not an outcome.** `exec_generation = 7` means
"this task has been claimed seven times", not "seven attempts completed".
`attempt_generation` carries the outcome.

**Rejected alternatives to this definition**, with reasons:

| candidate | verdict |
|---|---|
| task revision | **REJECTED** — §4.1 proof |
| timestamp of the claim | **REJECTED** — no consumer; inference by clock; not atomic with the claim |
| wall-clock ordering of events | **REJECTED** — ordering is not ownership |
| random UUID minted at dispatch | **REJECTED** — no consumer; cannot be validated against the claim atomically; a UUID is not *derived from* anything durable, so it cannot detect lineage |
| session-level generation | **REJECTED** — conflates all tasks in a session; a claim on T1 would appear to change T2's lineage |
| `(revision, seq)` pair | **REJECTED** — more complex, strictly less decidable than a claim-scoped counter |

**No UUID and no counter beyond `exec_generation` is introduced**, because
`exec_generation` alone is sufficient and its consumer is proven in §4.1.

---

## 6. Generation axioms — **NEW ARCHITECTURE**

| # | question | answer |
|---|---|---|
| 1 | When is a new execution generation created? | Only on `claimTask` → `CLAIM_ACCEPTED` |
| 2 | Does SELECT create one? | **No** |
| 3 | Does CLAIM create one? | Only if **accepted**; a rejected claim (stale/wrong-state) leaves it unchanged |
| 4 | Does successful CLAIM create one? | **Yes — this is the only creator** |
| 5 | Does every task mutation create one? | **No.** This is the defect 6F had |
| 6 | Does completion create one? | **No.** `COMPLETED` is a status change on the current generation |
| 7 | Does verification create one? | **No.** Same |
| 8 | Does reconciliation create one? | **No.** It *reverts* to `PENDING`; the next claim creates the next generation |
| 9 | Does task deletion destroy generation identity? | **Yes — completely.** The row is the identity |
| 10 | Can a taskId have two historical generations? | **No — only one is retained.** 6E rejected history (DD3); overwriting is safe *because* lineage is per-generation (§8.4) |
| 11 | Can a taskId be deleted and recreated? | **Yes**, and §7 defines it |
| 12 | If so, how are old and new generations distinguished? | They cannot collide, because the old row's `attempt_generation` died with it. No cross-incarnation evidence exists to distinguish |

Axiom 12 is the reason no incarnation id is needed (§15).

---

## 7. Task incarnation semantics — **NEW ARCHITECTURE**

**`taskId` means the current incarnation (option B), not the logical task
forever (option A).**

Semantics unchanged from existing behaviour — this is **not** a change to
canonical id rules. What changes is only where execution evidence lives.

| event | effect on evidence |
|---|---|
| `deleteTask(session, taskId)` | the row is deleted, so `attempt_generation` and `exec_generation` are deleted with it |
| `deleteSessionTasks(session)` | same, for every row |
| `createTask` with a recycled id | new row, `exec_generation = 0`, `attempt_generation = NULL` |
| old evidence reachable by the new incarnation? | **No — it no longer exists** |

**Why this needs no incarnation identifier:** evidence is *co-located* with the
incarnation, so "does this evidence belong to this task?" is answered by
storage, not by comparison. A marker in a side table is a *value* that must be
matched against an identity, and that is where D2 came from.

**Rejected:** prohibiting id reuse (would break existing compatibility for no
gain); an incarnation UUID (no consumer once evidence is co-located);
session-level generation (crosses task boundaries).

---

## 8. Marker lifecycle — **NEW ARCHITECTURE**

The marker survives as a *concept* but changes *form*: it is no longer a table,
it is one nullable column on the row it describes.

| event | `exec_generation` | `attempt_generation` |
|---|---|---|
| `createTask` | `0` | `NULL` |
| `claimTask` accepted | `+1` | unchanged (still describes the *previous* generation) |
| attempt reaches its end | unchanged | `= exec_generation` |
| any other task write | unchanged | unchanged |
| restart | unchanged | unchanged (durable) |
| `deleteTask` | row gone | row gone |
| `deleteSessionTasks` | rows gone | rows gone |
| task recreated with same id | `0` | `NULL` |
| next claim | `1` | `NULL` |

**READ / DECISION** — one statement, owned by TaskStore:

```sql
UPDATE tasks
   SET status = 'PENDING', updated_at = ?, revision = revision + 1
 WHERE session_id = ? AND task_id = ?
   AND revision = ?
   AND status IN ('IN_PROGRESS','VERIFYING')
   AND (attempt_generation IS NULL OR attempt_generation <> exec_generation)
```

`changes = 1` → `RECONCILED`. `changes = 0` → classify by reading the row once
(exactly as 6B's `reconcileStranded` already does), distinguishing
`attempt_generation = exec_generation` → `NOT_STRANDED` from a moved revision →
`REJECTED_STALE`.

**Why `attempt_generation IS NULL` is a separate disjunct** (not a comparison):
`NULL <> 0` is NULL, not true, so a task that was *created* `IN_PROGRESS` by
LEGACY and never claimed (`exec_generation = 0`, no attempt) would otherwise be
treated as "an attempt completed for generation 0". The explicit `IS NULL`
makes "never attempted" unconditionally mean *not stranded*.

**Minimal shape:** one current marker per task, **no history**, no attempt
record, no incarnation column. History is rejected because it has no consumer
(6E DD3) and because with per-generation lineage a *single* current value is
sufficient: the only question ever asked is "did the generation that is current
right now complete?"

---

## 9. Normal return vs new generation — **RESOLVED**

> **A post-return metadata change is still the SAME generation.**

Formally, from §6 axiom 5: a mutation that is not a claim does not advance
`exec_generation`, therefore it does not create a generation.

This is the direct answer 6F left implicit, and it is **not** a neutral choice —
it is the whole of D1's fix:

| 6F's implicit answer | consequence |
|---|---|
| "any revision bump = a new generation" | every title edit, evidence write or requeue manufactures a new execution opportunity → the marker stops matching → recovery suppressed → **D1** |
| **6H's answer** | only a claim is a new generation; a metadata edit changes *what the task is*, not *whether it should run again* |

**Consequence that must be stated, not buried:** a task whose attempt returned
and which nothing external moves will stay `IN_PROGRESS` and `IDLE` forever.
That is 6F's intended behaviour and it is preserved deliberately. The
reconciliation path is for **crashed** generations, and only a crash leaves one.

---

## 10. Verifier interaction — **RESOLVED, deterministic**

| question | answer |
|---|---|
| A. Does verifier mutation belong to the same execution generation? | **Yes.** Evidence is a task mutation, not a claim. |
| B. Does it create a new generation? | **No.** §6 axiom 5. |
| C. Does the verifier change status before writing evidence? | Irrelevant to lineage. Either way, only a claim advances the generation. |
| D. Does reconciliation observe only status? | **It observes status to select targets, then lineage to decide.** Both are store-owned. |
| E. Does attempt evidence survive the verifier write? | **Yes — and this is the point.** `attempt_generation` is untouched by `patchTask`. |

**The answer does not depend on timing.** It depends only on *which kind of
write* occurred, and exactly one write kind advances the generation. This is
precisely the property 6F lacked: in 6F the answer depended on whether the
verifier's write landed before or after reconciliation read the revision, and
the two outcomes were D1 (wedge) and recovery (duplicate) respectively.

`patchTask`'s `UPDATE` enumerates explicit columns (verified in source at
`store.ts:605`) and does **not** touch `revision`-adjacent provenance, so
verifier writes cannot clobber lineage.

---

## 11. Crash semantics — **VERIFIED, unchanged and bounded**

| point | `exec_gen` | `attempt_gen` | decision |
|---|---|---|---|
| crash before dispatch | N | (prev) | claim released by 6C path |
| crash during the turn | N | (prev) | `attempt_gen <> N` → **recover** |
| crash after return, before the completion write | N | (prev) | `attempt_gen <> N` → **recover (one duplicate)** |
| crash after the completion write | N | N | equal → **not stranded** |
| crash after a verifier edit | N | N | equal → **not stranded** |

The normal-return and crash paths remain distinguishable **differentially** —
which was 6G §10's result and is preserved — and now also **per generation**,
which 6F could not do.

**Duplicate bound (precise, §19):** for a given generation, at most **one**
additional execution after a crash inside the return→write window. After that
execution, `attempt_generation` equals `exec_generation` and no further
duplicates occur. **Exactly-once is NOT claimed** and is not achievable without
coupling the agent turn to the database.

---

## 12. Reconciliation semantics — **NEW ARCHITECTURE**

Ownership: **TaskStore** (§21). The Scheduler supplies no lineage logic at all.

```
for each task in snapshot:
    if status not in {IN_PROGRESS, VERIFYING}: skip
    if this Scheduler holds the active claim: skip
    if session ownership not positively held: refuse   (6B, unchanged)
    result = store.reconcileIfNoCompletedAttempt(session, id, revision, {ownsSession})
    if result.outcome == RECONCILED: record recovered
```

| relation | meaning | decision |
|---|---|---|
| `attempt_generation IS NULL` | current generation has **no** record | **STRANDED** → revert |
| `attempt_generation < exec_generation` | a **later** generation superseded an earlier completed one; the current one has no record | **STRANDED** → revert |
| `attempt_generation = exec_generation` | the current generation completed | **not stranded** |
| `attempt_generation > exec_generation` | impossible | **throw** |

**D1 is resolved by the `<` branch being inverted relative to 6F.** In 6F,
`marker < rev` meant *safe*; here `attempt_generation < exec_generation` means
*stranded*, because the comparison is now against a value that only a claim can
move. §4.1's ROUTE A and ROUTE B are finally distinguishable:

| | ROUTE A (2 mutations) | ROUTE B (requeue + new claim) |
|---|---|---|
| `exec_generation` | 1 | 2 |
| `attempt_generation` | 1 | 1 |
| predicate | equal → not stranded ✓ | `1 <> 2` → stranded ✓ |

**And the invariance that makes it airtight:** `attempt_generation` is set to
the generation that was current *at write time*, and `exec_generation` moves
only on claim. If they differ, it is always because a claim happened after the
last completion. A task mutation can never make them differ.

---

## 13. Multi-process semantics — **DEFERRED (unchanged)**

| property | changed by 6H? |
|---|---|
| claim exclusion | **No** — still the atomic revision+status predicate inside `claimTask` |
| marker/completion writes | become row updates; still unguarded by ownership |
| reconciliation | still ownership-gated, still fail-closed |
| restart | still single-process ownership |
| duplicate risk | unchanged |
| **cross-process same-session ownership** | **still UNSUPPORTED** |

**A generation id is not a lock.** Two processes could still both read
`exec_generation = 3`; only `claimTask`'s single-winner UPDATE stops them, and
only within one database. **6H does not claim to fix cross-process safety and
the report says so.** Session ownership remains the gate, exactly as in 6B.

---

## 14. Concurrency / race analysis — **NEW ARCHITECTURE**

| race | outcome | why |
|---|---|---|
| A claims G1, B mutates the task | mutation bumps `revision` only | `exec_generation` untouched → G1 lineage intact |
| A claims G1, B attempts reconciliation | predicate `attempt_gen <> exec_gen` holds (no record) | B may revert A's claim — **same as 6C/6B today**, guarded by `revision` |
| A claims G1, A returns, B reconciles | equal → not stranded | no wedge, no duplicate |
| A claims G1, completion write, then external mutation | equal → not stranded | **D1 fixed** |
| A claims G1, crashes, B reconciles | no record for G1 → stranded | recovered, one duplicate |
| stale evidence vs newer generation | `attempt_gen < exec_gen` → stranded | **G1 evidence cannot suppress G2's recovery** |
| recreated task vs old evidence | evidence was deleted with the row | **D2 fixed structurally** |
| completion write vs concurrent claim | write is `WHERE exec_generation = ?`; a newer claim makes it 0 changes | no misleading record |
| reconciliation vs newer state | `AND revision = ?` | cannot overwrite newer state (6B property preserved) |

**No reconciliation can delete evidence belonging to another incarnation** — it
never writes `attempt_generation`, and the row it targets is the row it read.

---

## 15. Durable data-model candidates — **NEW ARCHITECTURE**

Only designs justified by §4.1 are compared.

| | **A** 6F 3-col table, lifecycle fixed | **B** table + `exec_generation` column | **C** 4-col table, explicit attempt id | **D** both fields on the task row | **E** dedicated attempt record | **F** incarnation id + marker |
|---|---|---|---|---|---|---|
| schema change | none | 1 column | 1 column + UUID | **2 columns, table dropped** | new table + FK | 1 column + new id |
| D1 | **UNRESOLVED** — §4.1 | resolved | resolved | **resolved** | resolved | resolved |
| D2 | cascade only | cascade only | cascade only | **structural** | cascade only | id distinguishes |
| reconciliation | read marker, then UPDATE — **read-then-write** | same | same | **one atomic guarded UPDATE** | read + UPDATE | read + UPDATE |
| writes/attempt | 1 | 1 | 1 | **1** | 1–2 | 1 |
| reads/in-flight/cycle | 1 | 1 | 1 | **1** | 1–2 | 1 |
| TaskStore ownership | yes | yes | yes | **yes** | yes | yes |
| Scheduler complexity | comparison logic | comparison logic | comparison logic | **none — delegates** | comparison logic | comparison logic |
| 6E invariants | preserved | preserved | preserved | **lineage is not task state, but co-located** | preserved | preserved |
| old marker rows | inert | **semantically wrong** | wrong | **table dropped, purged** | n/a | wrong |
| verdict | **REJECTED** — D1 unfixable | viable but TOCTOU | **REJECTED** — UUID with no consumer | **SELECTED** | **REJECTED** — a record implies history, which has no consumer | **REJECTED** — no consumer once evidence is co-located |

### Why **A** is rejected outright, and why **B** is rejected in favour of **D**

**A** cannot fix D1 at all: its decision function still reads
`(revision, marker)`, and §4.1 proves that input cannot determine the answer.
Changing the *rule* over that input is exactly the family §20 rejects.

**B** fixes D1 and D2 correctly, and is a legitimate design. It is rejected for
one specific, measured reason: its reconciliation must **read the marker and
then** issue the guarded UPDATE, reintroducing a read-then-write window in a
codebase that deliberately removed one. 6B's own comment states the doctrine:

> *"THE revision predicate lives here, in SQL. One statement = one atomic
> decision; there is no read-then-write window."* — `store.ts:670`

**D** restores that property: lineage and the revert are the *same* statement,
so a concurrent completion write can never slip between the decision and the
mutation. **D is selected on correctness grounds, not on column count** — note it
uses **more** columns than B and **fewer** tables, and it wins on the atomicity
axis specifically.

**D's cost, stated honestly:** the Scheduler now causes writes to the `tasks`
row (one provenance column). This is *not* a new authority — the Scheduler
already causes `PENDING` writes through `reconcileStranded`, and `claimTask`
already writes the row. The invariant actually preserved is narrower and
still true: **the Scheduler never writes a task's `status`, evidence,
acceptance, verification, or any TaskGraph-visible field.** Execution provenance
is not task state and is not read by TaskGraph, readiness, or presentation.

---

## 16. Minimality — **NEW ARCHITECTURE**

Applying 6E §16's rule — every durable datum needs a demonstrated consumer:

| datum | consumer | verdict |
|---|---|---|
| `exec_generation` | §4.1: the lineage predicate cannot be decided without a claim-scoped value | **KEEP — the only new datum** |
| `attempt_generation` | same predicate; **replaces** the existing `task_attempt.attempt_revision`, not added to it | **KEEP (net zero growth)** |
| heartbeat | none | **REJECT** |
| lease / `lease_until` | none | **REJECT** |
| `retry_count` | none | **REJECT** |
| `owner_pid` | none — process ownership is 6B's `SessionOwner` | **REJECT** |
| `scheduler_id` | none | **REJECT** |
| `started_at` / arbitrary timestamps | none; and clock is not ownership | **REJECT** |
| attempt UUID | none — cannot validate lineage atomically | **REJECT** |
| incarnation UUID | none once evidence is co-located | **REJECT** |
| attempt history / attempt record | none | **REJECT** (6E DD3 stands) |
| 4th table | none | **REJECT** |

**Net durable change: +2 columns, −1 table, 0 new methods beyond one
(`reconcileIfNoCompletedAttempt`) and one changed signature
(`recordAttemptReturned` repurposed, `claimTask` return extended).**

---

## 17. Invariants — **NEW ARCHITECTURE**

| # | invariant | status |
|---|---|---|
| **I19** | The **only** admissible justification for re-dispatching task *t* is that *t*'s **current execution generation** has no completion record. A normal return therefore cannot cause unbounded automatic re-dispatch. | **REFINED** — 6F said "current revision"; the revision was the wrong subject |
| **I20** | A completion record may protect only the generation it names, and only while that generation is still current. | **KEPT, now decidable** — 6F could not evaluate it |
| **I21** | A completion record from a deleted incarnation can never affect a recreated task. | **SATISFIED STRUCTURALLY** — co-located, so the record ceases to exist |
| **I22** | A task mutation that is not a claim can never be mistaken for a new successful execution, nor create a new execution opportunity. | **NEW** — this is D1's fix stated as an invariant |
| **I23** | Reconciliation can neither overwrite a newer task revision nor a newer generation. | **KEPT** — revision predicate plus lineage predicate in one statement |
| **I24** | Restart preserves enough durable evidence to distinguish the normal-return path from the crash path, for the **current** generation. | **REFINED** — "current generation" is now explicit; 6F could only claim it per-revision |
| **I25** | Execution provenance is never task state: not read by TaskGraph, readiness, or presentation, and never exposed on the `Task` type. | **NEW** — keeps the lineage leak-free even though it is co-located |
| **I26** | A generation identity is not a lock and confers no cross-process exclusion. | **NEW** — prevents a future reader from over-claiming |

**I19's refinement is the load-bearing one.** In 6F, I19 was true only because
a matching marker happened to equal the revision; a single mutation broke the
match and the justification evaporated. The refinement ties the justification
to a quantity that **only a claim can move**, which is why it is now stable
under arbitrary mutation.

---

## 18. Liveness proof — **NEW ARCHITECTURE**

No timers, no grace periods, no wall-clock, no model cooperation.

**Claim 1 — a normal return converges.** Task *t* claimed at generation *g*.
`runCycle` step 8 performs `claimTask`, which sets `exec_generation = g` and
status `IN_PROGRESS` in one atomic statement. The turn returns; the completion
write sets `attempt_generation = g`. Let any number of *mutations* follow:
mutations advance `revision` only, so `exec_generation` and `attempt_generation`
both remain *g*. Every later cycle: (i) the status filter admits `IN_PROGRESS`;
(ii) the lineage predicate finds `attempt_generation = exec_generation`, so
`changes = 0` and the row is not reverted; (iii) `IN_PROGRESS` is not in
TaskGraph's eligible set, so it is not selected. **No dispatch. ∎**

**Claim 2 — a mutation cannot cause redispatch.** By Claim 1's invariant, a
mutation changes neither lineage column, so the predicate's truth value is
unchanged. **Therefore no mutation, of any kind, at any time, can change the
reconciliation outcome. ∎** This is the property 6F lacked, and it is what makes
D1 unreachable rather than merely unlikely.

**Claim 3 — G1 evidence cannot suppress G2.** Suppose `attempt_generation = g₁`
and a new claim sets `exec_generation = g₂ > g₁`. The predicate
`attempt_generation <> exec_generation` is true, so the row is reconciled. **If
G2 completes**, its write sets `attempt_generation = g₂` and the row is then
protected — by *G2's own* evidence, not G1's. **G1's evidence is never the
reason G2 is protected. ∎**

**Claim 4 — D2 is unreachable.** Deletion removes the row; there is no second
location holding evidence for a deleted task, so no recreated task can observe
it. ∎

### 18.1 The design was executed before it was specified — **VERIFIED**

A design that has never run is a hypothesis. This one was **validated against a
shadow implementation** before being adopted: a standalone SQLite database with
the proposed `tasks` schema (two lineage columns, **no** `task_attempt` table),
implementing `claim` / `complete` / `reconcile` exactly as specified above,
including the single guarded `UPDATE`. It lived in a temp directory and
**touched nothing in the repository**.

| sequence | result | as designed |
|---|---|---|
| S1 claim → return | `G=1 M=1` → `NOT_STRANDED` | ✓ |
| S2 return → **other** task mutated | `G=1 M=1` → `NOT_STRANDED` | ✓ |
| **S3 return → verifier writes evidence (D1 form 1)** | `G=1 M=1`, `rev 2→3` → `NOT_STRANDED` | ✓ **D1 fixed** |
| S4 return → completion | status filter skips | ✓ |
| S5 claim → crash | `M=none` → `RECOVERED` | ✓ |
| S6 return → **restart** (db reopened) | `M=1` → `NOT_STRANDED` | ✓ |
| **S7 return → delete → recreate (D2)** | new row `G=0 M=none` | ✓ **D2 fixed** |
| S8 crash → recreate | no contamination | ✓ |
| S9 G1 → requeue → G2 → return | `G=2 M=2` → `NOT_STRANDED` | ✓ |
| **S10 G1 → return → mutate → G2 → crash (D1 form 2)** | `G=2 M=1` → **`RECOVERED`** | ✓ **G1 evidence did not suppress G2** |
| **§4.1 ROUTE A** (2 mutations) | `G=1 M=1` → `NOT_STRANDED` | ✓ |
| **§4.1 ROUTE B** (requeue + new claim, crash) | `G=2 M=1` → `RECOVERED` | ✓ |
| legacy `IN_PROGRESS`, never claimed | `G=0 M=none` → `RECOVERED` | ✓ |

**The decisive line:** under 6F, ROUTE A and ROUTE B received the **same**
answer. Under the proposed design they receive **opposite** answers
(`NOT_STRANDED` vs `RECOVERED`) from the identical `(revision, marker)`
starting point. The impossibility of §4.1 is therefore **dissolved**, not
worked around.

**This is validation, not implementation.** No file in the repository was
modified; 6I remains responsible for the real change.

---

## 19. Crash proof — **NEW ARCHITECTURE**

`runTurn` resolves → the process dies before the completion write. Durable state:
`exec_generation = g`, `attempt_generation ≠ g` (the previous generation's, or
`NULL`). The next reconciliation satisfies
`attempt_generation IS NULL OR attempt_generation <> exec_generation` → **revert**
→ re-dispatch. That re-dispatch either completes (writing `attempt_generation = g`,
after which the predicate is false and no further revert occurs) or dies again.

**Bound:** for any generation, the number of extra executions caused by crashes
is unbounded in the pathological case (a process that always dies in the window
re-executes forever) but is **1** for a single crash, and there is **no
mechanism** by which the design itself re-executes. State it honestly: the bound
is *per crash event*, not per generation, because each crash is a fresh event.
What the design guarantees is that **a generation with a recorded completion is
never re-executed**, which is the property that was violated by 6D.

---

## 20. D1 resolution — **principled**

| | |
|---|---|
| **Mechanism** | generation identity advances **only** on an accepted claim (§5, §6) |
| **Why it works** | `exec_generation` is invariant under every non-claim write, so the lineage predicate is invariant under every non-claim write (Claim 2) |
| **Both 6F forms** | form 1 (post-return mutation) → equal → not stranded; form 2 (crashed newer generation) → `1 <> 2` → stranded, recovered |
| **Side effect accepted** | a task whose attempt returned and that nothing external moves remains `IDLE` forever — by design (§9) |
| **Cost** | one integer column; the `task_attempt` table is removed |

## 21. D2 resolution — **structural**

| | |
|---|---|
| **Mechanism** | execution evidence is **co-located on the task row**, so it cannot outlive the task |
| **Why it works** | there is no second storage location, hence no orphan, hence nothing to inherit (§7 axiom 12) |
| **Cascade needed?** | **No.** The `task_attempt` table is dropped, so no delete path has to remember to clean it |
| **Purging 6F-era rows** | dropping the table discards them. They are unreleased, the Scheduler is unreachable, and their values are *revisions* being reinterpreted as *generations* — meaningless, so discarding is correct and is not a destructive migration of task data |
| **Cost** | 6F's marker table is deleted; `getAttemptMarker` becomes a lineage read |

---

## 22. Rejected alternatives — **NEW ARCHITECTURE**

| rejected | why insufficient |
|---|---|
| "just keep the claim in memory" | dies with the process that most needs it; passes tests while leaving restart broken — 6E's rejection stands |
| "any marker means safe" | **D1**. A marker may describe an older generation |
| "marker `<=` revision means safe" | **D1**, unchanged. Also unsound in the other direction: `<=` would accept a marker from the future |
| "marker `<` revision always means recover" | **§4.1 ROUTE A refutes it.** Two mutations after a return would force a re-execution of work that already ran. This is the tempting one-rule fix and it is wrong — which is precisely why 6H needed a new datum rather than a new comparison |
| "never reuse taskId" | breaks existing canonical-id compatibility for no gain; §7 needs no such rule |
| file-diff inference | second inference authority; 6D/6E rejection stands |
| transcript inference | ditto |
| event-order / timestamp inference | ordering is not ownership; no durable owner exists |
| lease / heartbeat | no consumer; second authority with a clock |
| attempt history | no consumer; `O(tasks)` not `O(attempts)` is the right shape |
| new attempt UUID | cannot be validated against a claim atomically, so it cannot detect lineage — it would be decoration |
| incarnation UUID | no consumer once evidence is co-located |

---

## 23. Legacy compatibility — **VERIFIED inert**

| question | answer |
|---|---|
| inert for LEGACY? | **Yes.** Two columns; LEGACY writers are the explicit-column `patchTask`/`updateTask`/`createTask`/claim SQL, none of which read or require the new columns except `claimTask`, which only SCHEDULER-authority flows call |
| changes any legacy write? | **No.** `createTask` initialises both to `0`/`NULL`; `patchTask` enumerates columns and cannot clobber them |
| migration required? | **No.** `exec_generation INTEGER NOT NULL DEFAULT 0` and `attempt_generation INTEGER` are additive with defaults |
| old databases valid? | **Yes.** Opening runs the additive DDL; existing rows read as `0`/`NULL` = "never claimed, never attempted" → `IN_PROGRESS` legacy rows are reconcilable, exactly as before |
| behaviour change for LEGACY? | **None.** LEGACY never calls `claimTask` in production (Scheduler unreachable) and never reads lineage |

---

## 24. Required implementation changes (for 6I) — **NOT IMPLEMENTED**

| # | change | file |
|---|---|---|
| 1 | add `exec_generation INTEGER NOT NULL DEFAULT 0` and `attempt_generation INTEGER` to the `tasks` DDL | `src/task/store.ts` |
| 2 | drop the `task_attempt` DDL | `src/task/store.ts` |
| 3 | `claimTask`: add `exec_generation = exec_generation + 1` to the existing UPDATE; return the new generation | `src/task/store.ts` |
| 4 | `recordAttemptReturned` → `recordAttemptReturned(sessionId, taskId, execGeneration)`: one guarded `UPDATE ... WHERE exec_generation = ?`; throw on 0 changes | `src/task/store.ts` |
| 5 | new `reconcileIfNoCompletedAttempt(...)`: one atomic guarded UPDATE; classify the 0-change outcome by a single read; throw on `attempt_generation > exec_generation` | `src/task/store.ts` |
| 6 | remove `getAttemptMarker` and the `AttemptMarker` type | `src/task/store.ts` |
| 7 | `dispatch`: write completion using the generation captured at claim time, before clearing the claim | `src/task/scheduler.ts` |
| 8 | `reconcile`: delete all lineage comparison; delegate to (5) | `src/task/scheduler.ts` |
| 9 | tests: `A*`–`J*` in `phase6f` and `C9`-shaped assertions in `phase6c` must be **rewritten**, not renamed | `test/phase6f-*.test.ts`, `test/phase6c-*.test.ts` |

**Untouched:** `model.ts`, `graph.ts`, `graph-validate.ts`, `readiness.ts`,
`todo.ts`, the agent loop, UI/TUI/ACP, presentation, executor internals,
`vendor/minicore`. `reconcileStranded` (6B) is **preserved unchanged** as the
guarded primitive; (5) composes rather than replaces it.

---

## 25. Exact file boundary for 6I

| may touch | must not touch |
|---|---|
| `src/task/store.ts` | `src/task/model.ts` |
| `src/task/scheduler.ts` | `src/task/graph.ts`, `readiness.ts`, `graph-validate.ts` |
| `test/phase6f-attempt-recovery.test.ts` | `src/tools/todo.ts`, the agent loop |
| `test/phase6c-scheduler.test.ts` (only the two rewritten marker assertions) | `src/ui`, `src/tui`, `src/acp`, presentation, executor, `vendor/minicore` |
| — | composition-root wiring; **Scheduler must stay unreachable** |

---

## 26. 6I acceptance criteria

1. **D1 form 1 gone:** attempt → return → external write → 10 cycles → **no wedge**, `runs == 1`.
2. **D1 form 2 gone:** G1 completes → requeue → G2 claim → crash → **G2 recovered**.
3. **D2 gone:** delete session/task → recreate same id → claim → crash → **recovered, no throw**.
4. §4.1's discriminating pair: ROUTE A → not stranded; ROUTE B → stranded.
5. A non-claim mutation (title, evidence, order, parent, dependency, `blockedReason`, cancellation) **never** changes a reconciliation outcome.
6. Only `claimTask` advances `exec_generation`; every other write path leaves both lineage columns untouched.
7. Reconciliation decision is **one statement**; no read-then-write window (assert single `UPDATE` with the lineage predicate).
8. `attempt_generation IS NULL` + `exec_generation = 0` → reconciled.
9. `attempt_generation > exec_generation` → throws, before any mutation.
10. Claim exclusion unchanged: two claimers, one winner; the loser gets `CLAIM_REJECTED_STALE`.
11. Restart: fresh `TaskStore`/Scheduler → no redispatch of a completed generation.
12. Crash before the completion write → recovered, duplicate bounded to one per crash event.
13. Completion write failure propagates; never reported as success; task stays `IN_PROGRESS`.
14. `TaskStatus` still 8 members; no `PAUSED`; `model.ts` unchanged.
15. LEGACY: full legacy suite green; old DB opens with `0`/`NULL`; no migration.
16. `task_attempt` table gone; no code path writes it.
17. **New mutants, all killed:** advance `exec_generation` on a non-claim write; write the completion record on a stale generation; drop the `IS NULL` disjunct; make the predicate `attempt_generation <= exec_generation`; delete the `>` throw; compare `revision` instead of `exec_generation`.
18. Property test over randomized sequences: P1–P5 of 6G **all hold, including P2, which 6G showed violated in 12/400 seeds.**
19. `tsc` and lint show no new errors; frozen surfaces byte-identical.
20. Production `new Scheduler(` sites: **0**.

---

## 27. Remaining impossible / deferred

| # | item | class |
|---|---|---|
| L1 | A death between `runTurn` returning and the completion write is indistinguishable from a death in flight; one duplicate. Closing it needs the agent turn transactionally coupled to the database | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L2 | The Scheduler cannot prove the model worked on the selected task | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L3 | A returned-but-unadjudicated task waits for an external authority forever | **DEFERRED** (by design, §9) |
| L4 | Cross-process same-session ownership unsupported; a generation is not a lock (I26) | **DEFERRED** |
| L5 | A process that crashes in the window on every attempt re-executes indefinitely | **DEFERRED** — per-crash, not per-design |
| L6 | No attempt history, so "how many times did this run?" is unanswerable | **DEFERRED** |
| L7 | `attempt_generation` holds one generation; a completion for *every* past generation is not retained | **DEFERRED** (6E DD3) |

**None of these is a blocker for 6I.** L1/L2 are the same walls 6E documented; the
rest are accepted trade-offs with named triggers.

---

## 28. Final verdict

# GREEN (design) — 6I authorised; nothing implemented here

Every §26 GREEN criterion is satisfiable by the selected design, and the two
6G NO-GO conditions are resolved **on different grounds**:

| 6G condition | resolution |
|---|---|
| stale marker protects a newer generation | **resolved structurally** — the comparator's subject is a claim-scoped generation, invariant under every non-claim write |
| marker cross-contaminates sessions/tasks | **resolved structurally** — evidence cannot exist independently of the task row |

**The honest summary of what changed:** 6F chose the wrong identity for a
generation. Task revision is a concurrency token; using it as an execution
lineage made every unrelated write look like a new execution opportunity, which
is D1. 6H keeps revision for its actual job, introduces exactly one new datum
with a proven consumer, and — by co-locating completion evidence with the task —
removes D2 by making it unrepresentable rather than merely unhandled.

**Cost:** one net-new column, one repurposed column, one table deleted, one
method replaced, one method added, and 6F's marker tests rewritten. No frozen
surface moves, no status is added, no agent-loop change is needed, and
**`DESIGN BLOCKED BY EXECUTION CONTRACT` does not apply.**

**Not done, deliberately:** 0 source changes, 0 schema changes, 0 test changes,
0 enablement. 6I is authorised by this document alone.
