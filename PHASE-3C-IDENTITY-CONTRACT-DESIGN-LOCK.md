# PHASE 3C-IDENTITY-CONTRACT — CANONICAL TASK IDENTITY SEMANTIC LOCK

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `9d7dcfe`
**Label: NEW ARCHITECTURE.** No surviving evidence defines a task identity
contract end to end. **No production code modified. No commit created.**

Prior phase **3C-IDENTITY-BOOTSTRAP is INVALIDATED** — its atomicity and digest
guarantees were measured false. This contract supersedes it.

---

## 1. Evidence map

| fact | label |
|---|---|
| `todo_write` schema: `todos[].{content,status}`, `required:[content,status]`, `additionalProperties:false` at **both** levels (`todo.ts:353-380`) | **VERIFIED CURRENT SOURCE** |
| ⇒ the model **cannot send a `taskId`**; the schema forbids unknown properties | **VERIFIED** |
| tool is documented "full todo list (replace, not delta)" — no delta, no removal primitive | **VERIFIED** |
| `renderTodos` emits only glyph + content; **0** `.id` references (`todo.ts:194-207`); `todo_read` returns exactly that (`todo.ts:406-415`) | **VERIFIED** |
| ⇒ the model can neither **send nor read** an identity | **VERIFIED** |
| `normalizeTodos` rebuilds `{content,status,blockedReason?}`, discarding all other fields; a hand-written `taskId` is dropped (MEASURED) | **VERIFIED** |
| duplicate identical content is preserved, not deduped (MEASURED) | **VERIFIED** |
| legacy identity signal = **array index only** | **VERIFIED** |
| `nextId` is `max`-based, not `count`-based; first id is `t1` | **VERIFIED** (Phase 1 + mutation) |
| `revision` starts 1, `patchTask` does `revision = revision + 1`; `expectedRevision` gate | **VERIFIED** (Phase 1) |
| `isTaskId` = `^t[1-9][0-9]*$`; `TASK_INVALID_ID` | **VERIFIED** (Phase 1/3A) |
| `TASK_DUPLICATE_ID` for a repeated id in one payload | **RECOVERED ARTIFACT** (`store.orig.ts:484-486`) + VERIFIED (Phase 3A) |
| `TASK_NOT_FOUND` for an id that does not exist — no silent fallback | **RECOVERED ARTIFACT** (`:494-496`) + VERIFIED (Phase 3A) |
| artifact mode switch: `hasAnyId = some(t => t.taskId non-empty)` (`:480`) | **RECOVERED ARTIFACT** |
| artifact LEGACY mode: `existing = before[index] ?? null` (`:493`) | **RECOVERED ARTIFACT** |
| artifact D7: unmentioned tasks retained, `order` renormalised (`:549-558`) | **RECOVERED ARTIFACT** |
| artifact admits positional matching "BUKAN derivasi identitas" | **RECOVERED ARTIFACT** |
| **MEASURED:** id-less reorder of A,B,C → C,A,B yields **6 rows** (t1,t2,t3 + t4,t5,t6), colliding `order`, duplicates unrecoverable | **VERIFIED (executed)** |
| caller-side `db.transaction` does **not** cover `createTask`/`setMeta` (separate cached handle) — MEASURED rollback failure | **VERIFIED (executed)** |
| `task_meta` has no session column; scope is per-DB-file, session encoded in the key | **VERIFIED** |
| `legacyDigest` hashes **raw text**: compact vs pretty differ; key order differs | **VERIFIED (executed)** |
| `presentationSessionId = resumeId ?? sessionId` (`setup.ts:504`); `sessionId` is random on `--resume` without `--session` | **VERIFIED** |
| MCP pins `todoSession.id = "mcp-server"` for the whole request (`mcp/server.ts:207`) | **VERIFIED** |
| `TodoItem.content` does not satisfy `DeclaredTask.title` — direct feed fails `NOT NULL` | **VERIFIED (executed)** |
| `taskIdentityProvider` seam exists in the adapter; `payloadVersion: 2` only on total resolution | **VERIFIED** (Phase 3B) |
| Who historically owned the write; whether adoption ever ran | **UNKNOWN** |

## 2. Identity authority

Candidate authorities, with what each can and cannot guarantee:

| candidate | can guarantee | cannot guarantee | invariant violated if it were canonical |
|---|---|---|---|
| **TaskStore** | single `max`-based allocator; durable row is the identity; survives restart | cannot see the model's intent; cannot express "same logical task" | — (this is the chosen authority) |
| Model payload | can state intent | **cannot mint durable ids** (schema forbids `taskId`); ids would be model-chosen → unbounded/colliding; breaks across context rotation | I1, I2 |
| Todo layer (`todo.ts`) | owns normalisation; is the write site | holds no durable identity; its `content` has no stable key; reorder-blind | I3, I7 |
| Plan layer | already carries optional `taskId` (3B); is an observation | presentation is an observation, not authority; a plan event is not a commit | I10, I11 |
| Composition root | owns `sessionId`, `cwd`, lifecycle | not a per-task allocator; has no task semantics | I1, I2 |

**Canonical rule: only TaskStore may mint a durable `taskId`.**
No other layer can. `identity.ts` contains no `t${` sequence — it is
structurally incapable of minting (VERIFIED, Phase 3B). The adapter likewise
(VERIFIED). This satisfies I1/I2 structurally, not by convention.

## 3. New-task contract

The model sends **no taskId** today (schema forbids it). So the *only* wire form
available is an item without identity.

```
model request  ->  classification  ->  TaskStore allocation  ->  durable identity
```

Classification is decided by payload shape, using the artifact's `hasAnyId`
switch:

| payload shape | interpretation | allocation |
|---|---|---|
| **mixed** — ≥1 item carries `taskId` | the author demonstrably knows about ids, so an id-less item is unambiguously NEW | `TaskStore.createTask` |
| **all id-less**, no canonical identity exists yet (pre-bootstrap) | LEGACY declaration | bootstrap rule (§8) |
| **all id-less**, canonical identity exists | **REJECT** (§6) | none |

**No second allocator:** the only id-producing statement in the repository is
`createTask`'s `INSERT … revision 1` with `task_id` taken from `nextId`
(VERIFIED). Identity's `planTaskIdentities` constructs a `NewTaskInput` and
delegates; it never formats an id (VERIFIED, Phase 3A).

## 4. Existing-task contract

| candidate | reorder safety | duplicate safety | restart safety | ambiguity | model must supply | evidence |
|---|---|---|---|---|---|---|
| **A. explicit `taskId`** | **safe** | `TASK_DUPLICATE_ID` | safe | none — ids are unique | the id | **RECOVERED ARTIFACT + VERIFIED (3A)** |
| B. ordinal / position | **unsafe** — MEASURED duplication | index unique but meaningless | unsafe across list edits | none, but wrong | nothing | **RECOVERED ARTIFACT (LEGACY mode)** — and measured harmful |
| C. content/title match | survives reorder | **fails** — duplicate content is legal and preserved (MEASURED) | survives | **unresolvable** | nothing | docs only; no `titleKey` in the recovered schema |
| D. external logical key | safe if the key is stable | depends on key | depends on key | depends on key | the key | **UNKNOWN** |
| E. store-issued opaque handle | safe | safe | safe | none | the handle | equivalent to A with a different token shape |

**Chosen: A (explicit `taskId`)**, on artifact evidence. B is measured harmful;
C is unresolvable; D and E have no evidence.

## 5. Reorder as a semantic axiom

```
Initial   A B C   ->  t1=A  t2=B  t3=C
Next      C A B   ->  must yield  t3=C  t1=A  t2=B
```

**MEASURED with the current payload shape: this is impossible.** An id-less
`C A B` produces `t1=A, t4=C, t2=B, t5=A, t3=C, t6=B` — six rows, colliding
`order`, and a later explicit-id call addresses the originals and leaves the
copies permanently.

The runtime has **no information** with which to decide `C→t3`, because the
payload carries only `content` and `status`, and content is not unique.

**Required additional information, minimal and sufficient:**

1. an **optional `taskId` on each todo item** — the single field that makes
   reorder decidable;
2. **bidirectional visibility** — the ids must be returned to the model, today
   `renderTodos` emits none (MEASURED) — so `todo_read` (or the plan
   projection) must include them.

Without (1), reorder safety is **unachievable**, not merely unimplemented.
Nothing in this contract can substitute for it: a manifest does not help,
because MEASURED, no runtime path consults one.

## 6. Missing-ID semantics

Once canonical identity exists, an id-less item is **not** interpretable as a
reference. Consequences of the tempting default "id-less = new":

| scenario | with "id-less = new" | correct semantics |
|---|---|---|
| reorder (`C A B`) | **duplicates 3 rows** (MEASURED) | reject, or require ids |
| retry of the same write | **duplicates again** | reject — the second attempt is not new information |
| partial update | silently adds tasks | reject |
| task rename | old task retained + new task | requires an id to express "rename" |
| duplicate content | indistinguishable | requires an id |

**Contract: an all-id-less payload is REJECTED once canonical identity exists**
(TASK_INVALID_ID / a dedicated rejection), with an explicit operator-facing
message. This is the only choice that cannot manufacture duplicate identities.
Pre-bootstrap, an all-id-less payload is a LEGACY declaration and follows §8.

## 7. Ambiguity matrix

| condition | behaviour | error code |
|---|---|---|
| duplicate `taskId` in one payload | **REJECT** | `TASK_DUPLICATE_ID` (VERIFIED) |
| unknown `taskId` | **REJECT** before any mutation | `TASK_NOT_FOUND` (VERIFIED) |
| malformed `taskId` (`t0`, `t01`, `T1`, `""`) | **REJECT** | `TASK_INVALID_ID` (VERIFIED) |
| duplicate content / title | **ACCEPT** — irrelevant, identity is not content-derived | — |
| missing `taskId`, mixed payload | **CREATE NEW** | — |
| missing `taskId`, all-id-less, post-bootstrap | **REJECT** | new code needed |
| conflicting `taskId` and ordinal | **STORE-DECIDES** — id wins, ordinal is display only | — |
| same logical task twice in one payload | **REJECT** — one payload may claim an id once | `TASK_DUPLICATE_ID` |
| task deleted between turns, model still cites it | **REJECT** | `TASK_NOT_FOUND` |
| stale `taskId` after restart | **REJECT** via `expectedRevision` when supplied | `TASK_STALE_REVISION` |

**No case is resolved by guessing.**

## 8. Legacy adoption

**Continuity from legacy JSON to canonical identity is NOT derivable.** The only
signal is array index (VERIFIED), and index is not identity — the artifact itself
says positional reconciliation "BUKAN derivasi identitas". Any mapping would be
an invention that happens to be stable only until the first reorder.

**Therefore adoption is: explicit, operator-triggered, one-time, positional, and
its cost is declared up front — a controlled loss.**

| aspect | outcome |
|---|---|
| identity preserved | **NO** — legacy identity was positional, never durable |
| state preserved | `status`, `blockedReason`, and `content` (as `title`), in list order |
| state regenerated | all `taskId`s, from `nextId` |
| `order` | preserved positionally (0-based index) |
| user notified | **REQUIRED** — a one-time notice naming the session and count |
| historical plan identity | remains **valid and unchanged** — plans carry their own `stepId`; 3B never rewrote them |
| trigger | **explicit operator action**, never automatic on first tool call |
| repeatability | refuses if already adopted; requires a deliberate reset path |
| pre-existing `tasks.db` | **must not be clobbered**; refuse if non-empty without an adoption record |

Rejected: automatic first-call adoption (duplicates on any reorder — MEASURED);
digest-gated auto-adoption (INVALIDATED — digest is formatting-sensitive, and
atomicity is unavailable); title-based matching (duplicate content is legal).

## 9. Session identity

| identity | value | suitability as a durable task namespace |
|---|---|---|
| `sessionId` | random on `--resume` without `--session` (VERIFIED, PF-05 note) | **UNSAFE** — would orphan tasks on resume |
| `presentationSessionId` | `resumeId ?? sessionId` (`setup.ts:504`); already the id used for `planId` and `todoSession.id` | **CORRECT** — stable across resume, already canonical in this codebase |
| `cwd` | project root | necessary second axis: the DB file is already per-`cwd` |
| MCP `todoSession.id` | `"mcp-server"` for the whole request | **UNSAFE / UNPROVEN** — every concurrent request shares one namespace |

**Required namespace: `(cwd, presentationSessionId)` — plus a per-request axis
for MCP.** The CLI case is satisfied by what already exists. The MCP case is
**not provable today** and no fix is invented here.

## 10. Transaction requirements

MEASURED: a caller-side `db.transaction` does not cover `createTask`/`setMeta`,
because TaskStore uses its own cached connection. Atomicity is therefore
**unavailable from outside**.

Required capability: **a TaskStore-owned transaction boundary** able to commit,
in one unit — N task writes + the adoption record + any metadata — on
TaskStore's own handle. Consequences:

- the required operation **cannot** be guaranteed atomic with raw SQL outside
  TaskStore without duplicating allocation logic (which would risk I2);
- therefore a **new TaskStore transactional API is a hard prerequisite**;
- it is **not implemented in this phase**.

## 11. Authority transition

| concern | LEGACY | BOOTSTRAP | CANONICAL |
|---|---|---|---|
| `taskId` | **does not exist** | TaskStore, regenerated | TaskStore — **DESIGN DECISION** |
| content/title | legacy JSON `content` | copied into TaskStore `title` | TaskStore — **DESIGN DECISION** |
| order | array index | TaskStore `task_order` = index | TaskStore `task_order` — **DESIGN DECISION** |
| status | legacy JSON | copied | TaskStore — **DESIGN DECISION** |
| deletion | n/a | **UNKNOWN** (D7 retain existed; Phase 3A does not retain) | **UNKNOWN** |
| new task creation | n/a | bootstrap only | TaskStore `createTask` — **VERIFIED** |

## 12. Model / tool protocol

Current payload expressiveness:

| intent | expressible today? |
|---|---|
| "update task t3" | **NO** — `additionalProperties:false` forbids `taskId` |
| "create a new task" | only implicitly, as an item in a full list |
| "reorder t3,t1,t2" | **NO** — no ids to reorder by |
| "rename t3" | **NO** — appears as a different item |
| "remove t2" | only as omission from a full replace; **no** explicit delete |
| "change status of t1" | **NO** — cannot name t1 |

**Minimum identity-bearing information required (and nothing more):**

1. `todos[].taskId?: string` — optional, additive; existing id-less models keep
   working and hit the §6 rejection path rather than corrupting state.
2. ids **returned** to the model (`todo_read` / plan projection), otherwise the
   model can never learn them (MEASURED: `renderTodos` emits none).
3. nothing else. No ordinal, no handle, no new tool. The existing full-replace
   shape is retained.

## 13. Invariant set

- **I1** one durable identity authority (TaskStore) — *structurally enforced*
- **I2** one durable allocator (`createTask`/`nextId`) — *structurally enforced*
- **I3** `taskId` survives reorder — **NOT SATISFIED today** (MEASURED duplication); requires §12.1
- **I4** `taskId` survives restart — *satisfied* (VERIFIED, Phase 1/3A)
- **I5** an existing task never silently becomes a new task — **NOT SATISFIED** until §6's rejection lands
- **I6** ambiguous input never silently guesses — *satisfied* for id-bearing paths (VERIFIED)
- **I7** one logical task cannot create duplicate durable rows — **NOT SATISFIED** (MEASURED)
- **I8** session isolation mandatory — **UNPROVEN for MCP** (§9)
- **I9** legacy `stepId` non-canonical — *satisfied* (VERIFIED, 3B)
- **I10** presentation events are observations — *satisfied* (VERIFIED, 3B)
- **I11** plan v2 never carries unresolved identity — *satisfied* (VERIFIED, 3B: `payloadVersion: 2` only on total resolution)
- **I12** identity writes atomic within TaskStore where required — **UNAVAILABLE** (§10)
- **I13** *(new)* the model must be able to **read back** every id it may reference, or ids are unusable
- **I14** *(new)* an all-id-less payload must never be reinterpreted as a set of new tasks once canonical identity exists

## 14. Decision gate

```
IDENTITY CONTRACT BLOCKED
```

The contract itself is now fully specified, but three of the gate's conditions
cannot be satisfied by design alone:

1. **Existing-task reference semantics** are defined, yet the **reorder axiom is
   unsatisfiable with the current payload** (MEASURED). I3, I5 and I7 are
   violated at runtime today, and only a production protocol change (§12.1–12.2)
   can fix them.
2. **Session namespace safety** is unprovable for MCP: `"mcp-server"` is a
   shared namespace and the correct id source does not exist in the code.
3. **Required atomicity** is unavailable: it needs a new TaskStore transactional
   API that does not exist.

### Smallest unresolved decisions

1. Approve the minimal protocol addition (`todos[].taskId?` + id read-back) and
   schedule it as a prerequisite; without it, no production wiring.
2. Decide the MCP namespace: a real per-request durable id, or explicit
   single-tenant acceptance with the merge risk documented.
3. Approve a TaskStore-owned transaction API (allocate + record in one unit) as a
   prerequisite.
4. Decide deletion semantics (D7 retain vs explicit delete) — currently UNKNOWN.
5. Decide the §6 rejection surface: which error code, and whether a
   migration path is offered to id-less models.

**Do not proceed toward production wiring while blocked.**

## 15. Recovery vs NEW ARCHITECTURE

**NEW ARCHITECTURE.** The identity contract's central rule — that a payload must
carry an id for reorder to be decidable, and that an all-id-less payload must be
rejected rather than treated as new — is **not recoverable**. The recovered
artifact's own text concedes that positional matching is not identity derivation,
and the artifact's LEGACY mode is the very mechanism that MEASURED-duplicates
identity. Reusing it would convert a measured defect into a design.

Recovered, and reusable as-is: the allocator, the `revision` substrate, the
validation/error codes, the `hasAnyId` classification switch, the D7 retain
intent, and the 3B provider seam. Everything else here is design.

## 16. Implementation prerequisites

1. `todos[].taskId?` in the `todo_write` schema + id read-back in `todo_read`.
2. A TaskStore-owned transaction API for allocate+record atomicity.
3. A guarded session namespace for MCP.
4. The `content → title` rename at the boundary (MEASURED: direct feed fails
   `NOT NULL`).
5. The §6 rejection path with an operator-facing message.
6. Adoption implemented as an explicit operator action, never automatic.

## 17. Unresolved unknowns

1. Whether the historical system ever gave the model ids at all.
2. Whether MCP ever wrote to the store, and under which namespace.
3. Deletion/D7 semantics in the recovered implementation.
4. Whether the pre-wipe `synchronizeTasks` was ever called in production.
5. Whether `resumeId` is stable across every resume path.
6. Replay semantics after a partial write (carried from 3C-DECISION Case G).
7. Whether an all-id-less payload should be rejected or auto-bootstrapped on
   first adoption — a product decision, not a technical one.

**NO PRODUCTION CHANGES. NO COMMIT. NOT BEGINNING 3C-2.**
