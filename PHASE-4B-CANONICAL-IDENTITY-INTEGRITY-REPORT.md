# PHASE 4B — END-TO-END CANONICAL TASK IDENTITY INTEGRITY REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `a594945` (plus subphase **4B.1 = `50c4aca`**, opened by this phase)
Commit message: `test: verify canonical task identity lifecycle`

**NEW ARCHITECTURE VALIDATION.** The invariant under test:

> logical task identity ≡ durable `TaskStore.taskId`, and a `taskId` must never
> change merely because order, content or status changed.

Proof is always by canonical id. Content and ordinal are used only to *describe*
what happened, never to establish correctness.

---

## 1. Headline: 4B found a real defect, and it was fixed in its own subphase

Phase 4B was scoped as verification, but §1 (create → read-back) exposed a
production defect immediately. Per §21 I **stopped**, opened subphase **4B.1**,
and checkpointed that fix (`50c4aca`) before continuing this verification.

`todo_write` persisted the *declared* payload before canonical sync, so a task the
sync was about to create had no id in the file `todo_read` reads. The model could
never learn the id of a task it had just created, re-sent it id-less, and 4A.5
classified that as new work:

```
TURN 1: [t1=A, C(new), t2=B]  -> TaskStore t3=C, but todo_read shows "[ ] C"
TURN 2: [t1=A, C(id-less), t2=B] -> t4=C created alongside t3=C
```

Full detail, root cause, fix and its own mutation evidence:
**`PHASE-4B.1-CANONICAL-ID-WRITEBACK-REPORT.md`**.

## 2. Lifecycle tested

`test/phase4b-identity-lifecycle.test.ts` (10 tests, 110 assertions) walks the
whole sequence in order against a real temporary project and real SQLite. The
narrative test is deliberately sequential — a lifecycle *is* a sequence, and an id
change is only visible at the step where it happened.

| step | result |
|---|---|
| create (A(t1) B(t2) C new) | t1, t2 existing; **t3 = C from the allocator** |
| read-back | `todo_read` shows `t1`, `t2`, `t3` — no id lost TaskStore → read |
| reorder (t3, t1, t2) | order changed; `set(ids)` identical; 3 rows; no new ids |
| update t3 | only t3 changed; **still t3**; revision advanced |
| retry (exact) | idempotent: no new ids, no duplicates |
| retry after reorder | same |
| failed op + corrected retry | zero partial mutation; no orphan; no extra allocation |
| restart | ids, content, status, order, revision all identical; no regeneration |
| resume | same logical namespace still addresses the same ids |
| plan continuity | `payloadVersion 2`; plan ids ≡ TaskStore ids; order may move |
| new-task assignment | C receives t3, exposed on the operation's own channel and in the plan |
| all-id-less regression | rejected; zero mutation; no plan |
| legacy session | accepted, no bootstrap, no canonical rows invented |

## 3. Invariants (property suite, test 16)

For every non-CREATE operation the id set is preserved and content stays attached
to the same id:

- **REORDER** `set(ids)` before == after
- **UPDATE** the target id is unchanged
- **RETRY** no unexpected row-count increase
- **D7 subset** omitted tasks retained, unchanged
- **CREATE** the only operation permitted to grow the set, and the new id comes
  from the allocator (`t4`)

## 4. Failure matrix (test 17)

Each class is recorded with its *actual* error surface — and the distinction
matters:

| failure | visible | code | mutated? | id changed? | duplicate? |
|---|---|---|---|---|---|
| unknown `taskId` | yes | `TASK_NOT_FOUND` | no | no | no |
| duplicate `taskId` | yes | `TASK_DUPLICATE_ID` | no | no | no |
| malformed `taskId` | yes | *(none — protocol boundary)* | no | no | no |
| all-id-less w/ canonical state | yes | `TASK_IDENTITY_REQUIRED` | no | no | no |

A malformed id is rejected by Phase 4A.1 protocol validation and is deliberately a
plain `Error`, not a `TaskError`. My first version of this matrix asserted every
failure was coded; that was wrong, and the matrix now records the real surface per
class instead of flattening it.

## 5. Session isolation (test 13, 13b)

`t1` in session A and `t1` in session B are different tasks bound to different
content. Reordering and updating both concurrently produced **no** cross-session
leakage: separate titles, separate statuses, and each assignment refused under the
other's session. `todo_read` never crosses a boundary, and each session gets its
own durable file.

## 6. Concurrency (tests 15, 15b)

- Two sessions, concurrent canonical writes: each new task landed only in its own
  namespace; no duplicate identity; assignment did not cross-wire; each namespace's
  `nextId` independent.
- One session, two racing payloads creating different items: the final content set
  is exactly `{A, X, Y}` with no item renamed into another and none lost, and both
  operations reported a complete, self-consistent assignment.

## 7. MCP lifecycle (tests 14, 14b, 14c, 14d)

Driven through the **real** server over stdio, not by simulating it:

- **One context is stable.** Two requests in the same server context share exactly
  one durable namespace file, named `mcp-<uuid>.json`. The JSON-RPC request ids
  (11, 12) are *not* used as durable identity — asserted explicitly.
- **Two contexts differ.** Independent server instances produce different `mcp:`
  namespaces.
- **Restart: measured, not assumed.** §14 forbids claiming persistence without a
  durable mechanism. There is none: 4A.3 mints `mcp:<uuid>` per *instance*, so a
  restarted server gets a **new** namespace. Measured: two namespace files exist,
  the first still holds only its own work, nothing was migrated or adopted, and
  TaskStore holds no canonical rows for the pre-restart context. Recorded as a
  **known lifecycle limitation**.
- **4A.5 holds per context**: canonical context rejects, non-canonical stays legacy.

## 8. Mutation — 8 killed, 1 equivalent, 1 survived (unobservable)

| # | mutant | result |
|---|---|---|
| P1 | resolve identity by ordinal instead of taskId | KILLED |
| P2 | reorder the assignment before it reaches the plan | KILLED |
| P3 | allocate a new id during an update | KILLED |
| P4 | drop assignment propagation | KILLED |
| P5 | reuse the previous operation's assignment (true module global) | KILLED |
| P6 | bypass the single-entry session capture | KILLED |
| P7 | remove the all-id-less rejection | KILLED |
| P10 | regenerate ids on restart (order-derived) | KILLED |
| P8 | ignore a single-item assignment (`length > 1`) | **EQUIVALENT** |
| P9 | mutate TaskStore outside the transaction | **SURVIVED — unobservable** |

**P8 is provably equivalent.** A single-item canonical payload is necessarily a
single *existing* id: a lone id-less item would be an all-id-less payload (rejected
or legacy), so it never syncs. For that case the provider path resolves the
declared hint to the same id, so `length > 0` and `length > 1` cannot differ.

**P9 survived, and I am not going to pretend otherwise.** It is *not* equivalent —
removing the transaction wrapper in `sync.ts` is a real weakening. It is
**unobservable**: the sync's resolve-before-mutate pre-pass means no
model-reachable input can fail *after* the first mutation, and Phase 4A.2's suite
exercises `store.withTransaction` directly rather than through `sync.ts`. I added
4A.2's suite to the mutant run specifically to try to kill it, and it still
survived. **This is a real coverage gap**: `sync.ts`'s use of the transaction is
currently unverified by any test. Flagged for a future phase rather than papered
over.

One survivor earlier in the run was my own recurring bug: P5's "global" was
declared inside `execute`, so it reset per call and was inert. Rewritten as a true
module global, it is killed.

## 9. Full regression

| suite | result |
|---|---|
| 4A.1 – 4A.5, 4B, 4B.1, 3A, 3B (12 files) | **141 pass / 0 fail**, 1204 assertions |
| `debc295` known-bad evidence | **still reproduces**, 19 assertions — not deleted, not rewritten |
| MCP suites (`mcp-server`, `mcp-resources-prompts`) | **37 pass / 0 fail** |
| broad sweep (20 files) | **476 pass / 2 fail** |
| clean baseline `a594945`, same 20 files | **476 pass / 2 fail** — identical |

The 2 broad failures are the pre-existing purity audits
(`model.ts/reducer.ts`, `projection.ts`), unchanged from baseline. 4B introduces
no regression.

## 10. Validation

| check | label |
|---|---|
| PARSE (4 sources) | **VERIFIED** |
| 4B lifecycle suite (10 tests / 110 assertions) | **VERIFIED** |
| 4B isolation suite (8 tests / 53 assertions) | **VERIFIED** |
| 4B.1 write-back suite (9 tests / 30 assertions) | **VERIFIED** |
| restart / resume | **VERIFIED** |
| concurrency | **VERIFIED** |
| MCP lifecycle | **VERIFIED** |
| mutation | **VERIFIED** (8 killed, 1 equivalent, 1 unobservable) |
| all prior phase suites | **VERIFIED** |
| known-bad evidence | **VERIFIED** |
| broad sweep vs baseline | **VERIFIED** (identical) |
| 2 purity-audit failures | **KNOWN-BASELINE-FLAKE** — present identically at `a594945` |
| TYPECHECK | **DEFERRED** — `node_modules` absent |
| FULL SUITE | **DEFERRED** |

## 11. Known limitations (measured, not assumed)

1. **MCP identity does not survive a server restart.** 4A.3 mints the context id
   per instance and nothing persists it. Fixing this is explicitly out of scope
   ("MCP persistence redesign").
2. **A model can still duplicate by ignoring an id it was shown.** 4B.1 makes the
   identity observable; deciding otherwise for a mixed payload would require
   content-based identity, which is forbidden. Pinned in 4B.1 test 7.
3. **`sync.ts`'s transaction usage is untested** (P9 above). The property holds —
   4A.2 verifies `withTransaction` — but the *call site* is unguarded.
4. **The markdown plan snapshot carries no canonical ids.** Legacy artifact;
   observable instead via `todo_read`, the tool result and `plan.updated`.
5. `src/tools/task.ts:226` still reads the `todoSession` singleton (before its
   first `await`, so not racy).

## 12. Specimen safety — including a disclosure

- No `todos/`, no `tasks.db`, no `vector.db` **created by me** in the specimen.
- Evidence file `.freebuff/project-id` untouched (mtime `02:02:37`).
- `vector.db` unmodified (mtime `11:28:35`); **not removed**, as instructed.
- Every test run in 4B used an explicit redirected `cwd`.

**Disclosure:** `vector.db-shm` and `vector.db-wal` (both timestamped `11:30:04`)
exist in the specimen and were created **by me**, during Phase 4A.4A. I opened
`vector.db` read-only to list its tables while diagnosing that phase's specimen
finding; the database is in WAL mode, so even a read-only open materialises the
`-shm`/`-wal` sidecars. I did not delete them, because removing files from the
protected specimen is itself a write and the call is yours. The forensic evidence
itself is intact.

## 13. Files changed

This phase's own commit is **tests and documentation only** — the one production
change it found was already checkpointed in 4B.1 (`50c4aca`).

| file | change |
|---|---|
| `test/phase4b-identity-lifecycle.test.ts` | **new** — 10 tests |
| `test/phase4b-isolation-lifecycle.test.ts` | **new** — 8 tests |
| `PHASE-4B-CANONICAL-IDENTITY-INTEGRITY-REPORT.md` | this report |

## 14. Commit

`test: verify canonical task identity lifecycle`. SHA not self-cited — committing
this report changes it. Tree CLEAN after commit. **Not pushed.**

## 15. Explicit non-scope

Not started, per the stop condition: TaskGraph, Scheduler, deletion redesign,
automatic bootstrap, MCP persistence redesign, unrelated refactors.
