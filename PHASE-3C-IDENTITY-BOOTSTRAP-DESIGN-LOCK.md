# PHASE 3C-IDENTITY-BOOTSTRAP — LEGACY TODO → CANONICAL IDENTITY: DESIGN LOCK

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `9d7dcfe` (Phase 3B)
**NEW ARCHITECTURAL DECISION. Nothing here is claimed as recovered.
No production code modified. No commit created.**

---

## 1. Evidence map

| finding | label |
|---|---|
| `saveTodos` writes `{ sessionId, updatedAt, todos }` — no id, no ordinal, no migration marker (`todo.ts:289`) | **VERIFIED CURRENT SOURCE** |
| `normalizeTodos` constructs **fresh** objects from only `{content, status, blockedReason?}` (`todo.ts:158-167`), dropping every other field | **VERIFIED CURRENT SOURCE** |
| Empirically: a hand-written `taskId` in legacy JSON is **discarded on read** | **VERIFIED (measured)** |
| Empirically: duplicate identical content is **preserved** (no dedup) | **VERIFIED (measured)** |
| `blocked` without reason → `pending`; second `in_progress` → `pending` | **VERIFIED CURRENT SOURCE** |
| Empty array and missing file both yield `[]` (`normalizeTodos` throws; `readTodoFile` catches → `null`) | **VERIFIED (measured)** |
| Pre-N2 filenames remain readable | **VERIFIED (Phase 2)** |
| `tasks` table has **no** `titleKey`, **no** legacy-ordinal, **no** mapping column | **VERIFIED CURRENT SOURCE** |
| `task_meta(key, value)` exists — the only free-form metadata store | **VERIFIED CURRENT SOURCE** |
| `migrationStamp` / `markMigrated` / `legacyDigest` exist, **defined but never called** in any source | **VERIFIED** |
| Artifact `synchronizeTasks` LEGACY mode: `existing = before[index] ?? null` (`store.orig.ts:489-493`), mode switch on `hasAnyId` (`:480`) | **RECOVERED ARTIFACT** |
| Artifact D7: unmentioned tasks retained, `order` renormalised to `i` (`:549-558`) | **RECOVERED ARTIFACT** |
| Artifact's own admission that positional reconciliation "BUKAN derivasi identitas" (is NOT identity derivation) | **RECOVERED ARTIFACT** |
| Whether pre-existing JSON was ever adopted, and how | **UNKNOWN** — the importer is in no artifact (Phase 1), and no caller for the migration substrate exists in any survivor |
| `titleKey` re-attach | **UNKNOWN** — in design docs, absent from the recovered schema |

**Decisive structural fact:** the only identity signal that survives in legacy
JSON is **array position**. `normalizeTodos` destroys everything else, so no
id-bearing legacy state can exist, and a hand-written id cannot even be observed.

## 2. Legacy state model

A legacy todo list, as the system sees it, is:

```
[{ content: string(1..200), status: TodoStatus, blockedReason?: string(0..300) }, ...]
```

with:

- identity = **array index only**;
- no id, no ordinal, no provenance, no timestamp, no migration marker;
- duplicates by content legal and preserved;
- status already normalised (blocked→pending without a reason; one `in_progress` max);
- bounded at `LIMITS.TODO_MAX_ITEMS` (50) and 200 chars per title;
- possibly empty, possibly absent, possibly on a pre-N2 filename.

**Partially migrated state is impossible today** — there is nowhere in this
shape to record that an item was migrated.

## 3. Candidate analysis (trade-offs only, no ranking)

### A. Positional adoption (mirrors the artifact's LEGACY mode)

- *Identity continuity:* holds only while order is unchanged. A reorder between
  the legacy snapshot and the store makes logical task *i* inherit the identity
  previously held by a different logical task. This **is** the split-identity hazard.
- *Reorder safety:* **poor** — the mechanism is inherently order-sensitive.
- *Duplicate ambiguity:* none (indexes are unique), but the mapping is arbitrary.
- *Restart safety:* yes, once written.
- *Idempotence:* **none.** Re-running on a changed list re-maps.
- *Persistent mapping needed:* no — but then it must never be re-run.
- *Evidence:* the artifact's steady-state rule (`:493`).
- *Failure:* silent identity transfer; no error is raised.

### B. One-time migration writing canonical ids back into JSON

- *Identity continuity:* strongest, if ids could survive.
- **Blocking fact:** `normalizeTodos` **drops** `taskId` on read, so ids written
  into JSON are erased the next time the file is loaded. This candidate requires
  changing the JSON schema *and* the normaliser, and JSON is currently a human
  artefact (Phase 2 evidence). It also would not reach the plan, which is built
  from `todo_write` **arguments**, not from the JSON file.
- *Verdict:* infeasible without new architecture that contradicts Phase 2.

### C. Content/title-based adoption

- *Identity continuity:* survives reorder.
- *Duplicate ambiguity:* **real and unavoidable** — duplicate content is legal and
  preserved (measured). Invariant 5 forbids guessing, so a tie must fail, which
  means adoption fails on ordinary data.
- *Persistent mapping needed:* yes, or a `titleKey` column that the recovered
  schema does not have and the artifact dropped.
- *Evidence:* design docs only; the artifact's schema has no `titleKey`. Per this
  phase's own rule, docs uncorroborated by source are not evidence.
- *Failure:* ambiguous → must refuse.

### D. Fresh allocation for all id-less items (current Phase 3A behaviour)

- *Identity continuity:* none, by construction.
- *Idempotence:* **none.** A second run allocates a second identity for every
  logical task — the most direct route to the split-identity hazard.
- *Persistent mapping needed:* none.
- *Evidence:* this is exactly what the artifact's rule degenerates to when
  `before` is empty (`:493` → `null` → create).
- *Failure:* silent duplication.

### E. Digest-guarded single-shot adoption with a frozen manifest *(evidence-supported substrate)*

- *Identity continuity:* position is used **exactly once**, then frozen in a
  manifest, so no later reorder can re-map identity.
- *Reorder safety:* good for adoption; and because TaskStore becomes authoritative,
  a later JSON reorder cannot reassign identity at all.
- *Duplicate ambiguity:* none — indexes are unique at the instant of adoption.
- *Idempotence:* **provable** — same legacy digest + existing manifest → no-op;
  different digest with an existing manifest → refuse, never re-derive.
- *Restart safety:* yes.
- *Persistent mapping needed:* yes, but it fits the **existing** `task_meta`
  substrate — no schema change.
- *Evidence:* the substrate exists (`migrationStamp`, `markMigrated`,
  `legacyDigest`, `ensureDataVersion`); only its *use* is unproven, so the
  mechanism is a new design built on verified parts.
- *Failure:* all-or-nothing inside one SQLite transaction.

## 4. Identity-continuity risks

1. **Repeat adoption** (A/D without a guard) duplicates every identity.
2. **Reorder after adoption** — if identity is ever re-derived from position, a
   logical task silently changes id.
3. **The steady-state hazard that this phase does NOT solve:** the model still
   sends **id-less** payloads (`TodoItem` has no `taskId`). Therefore every
   ongoing sync remains positional, and a reorder while the model is still
   id-less will transfer identity. Closing that requires either the model to
   emit ids (Phase 3B's provider, fed from the store) or an explicit
   "store wins on conflict" rule.
4. **Two roots, one session id** (`src/mcp/server.ts:207` pins `"mcp-server"`):
   adoption under a shared id would merge unrelated clients' lists.
5. **Empty/absent legacy list** must adopt as a no-op, not as "zero tasks wins".

## 5. Bootstrap state machine

```
LEGACY_UNMAPPED ──adopt(one txn)──▶ CANONICAL
       │                                  │
       │ store non-empty, no manifest      │ manifest present, digest differs
       ▼                                  ▼
    FAILED (cannot prove)              FAILED (refuse re-derive)
```

- **One-time?** Yes, enforced by a persisted manifest, not by convention.
- **ADOPTING observable?** No. The whole adoption is one `db.transaction`, so it
  is a transient in-transaction state. No persisted `ADOPTING` marker is needed —
  adding one would be unnecessary state.
- **Partial adoption possible?** No, by construction (single transaction).
- **Partial adoption allowed?** No. Allowing it is what makes idempotence
  unprovable and duplicates likely.
- **Retry:** re-reads the same file, computes the same digest, finds no manifest,
  adopts once. Idempotent.
- **Idempotence proof:** the manifest key is `migrated:<sessionId>`; its value
  pins the legacy digest. Adoption runs only when no manifest exists.
- **Crash mid-adoption:** the transaction rolls back; the session stays
  `LEGACY_UNMAPPED`; nothing was written. Safe.
- **Mapping metadata required?** Yes — an explicit `ordinal → taskId` manifest
  plus the digest, in `task_meta`. Without it, adoption cannot be shown to be
  one-time.

## 6. Failure / retry matrix

| case | behaviour | classification |
|---|---|---|
| legacy file absent or empty | no-op; stay `LEGACY_UNMAPPED`; store unchanged | **DESIGN DECISION REQUIRED** |
| manifest absent, store empty | adopt | **DESIGN DECISION REQUIRED** |
| manifest absent, store **non-empty** | **FAILED** — cannot prove which tasks are adopted | **DESIGN DECISION REQUIRED** |
| manifest present, same digest | no-op | **DESIGN DECISION REQUIRED** |
| manifest present, different digest | **FAILED** — refuse; never re-derive | **DESIGN DECISION REQUIRED** |
| legacy content has duplicate titles | irrelevant — matching is by index | **GUARANTEED** (indexes unique) |
| crash mid-adoption | rollback → `LEGACY_UNMAPPED` | **GUARANTEED** (SQLite transaction) |
| retry after partial success | cannot occur — partial success impossible | **GUARANTEED** |
| reorder after adoption | ignored; TaskStore is authoritative | **DESIGN DECISION REQUIRED** |
| concurrent adoption, same session | one wins; second sees a manifest and no-ops | **GUARANTEED** (transaction + `INSERT OR REPLACE` on `task_meta`) |
| two clients under one MCP session id | **merged into one task space** | **UNKNOWN / must be guarded** |

No distributed transaction is implied; adoption touches one SQLite file only.

## 7. Design choice

**Option E — digest-guarded single-shot adoption with a frozen
`ordinal → taskId` manifest in `task_meta`.**

- *Canonical source:* TaskStore after adoption; the legacy JSON is the **input**
  to adoption and never an authority again.
- *Mapping rule:* strict index, `legacy[i] → taskId`, resolved **once**.
- *Ambiguity:* impossible by construction (indexes are unique). Any case that
  cannot be proven is `FAILED`, never guessed.
- *Persistence:* `task_meta`, key `migrated:<sessionId>`, value carrying the
  legacy digest and the manifest. **No schema change.**
- *Idempotence:* manifest presence is the gate; digest equality makes re-runs
  no-ops.
- *Retry:* safe and convergent, because partial adoption is impossible.
- *Ordering:* the adoption transaction must complete **before** any plan
  publication carrying canonical identity — the Phase 3B provider will otherwise
  resolve nothing and silently emit a positional plan.
- *Failure:* fail closed (`FAILED`), leaving the legacy list authoritative and
  unchanged. Never partially adopt.
- *Session guard:* required. Adoption must be keyed by the same session identity
  the store uses, and the MCP shared-id case must be excluded or explicitly
  accepted first.
- *Compatibility:* legacy JSON is never rewritten by adoption; the Phase 2
  canonical+legacy read path keeps working; a workspace with no legacy file
  simply never adopts.

Rejected: **B** is infeasible (`normalizeTodos` erases ids); **C** fails on
duplicate content and lacks schema support; **A** and **D** are not idempotent
and reproduce the split-identity hazard.

## 8. Why this is NEW DESIGN, not recovery

- The importer that would have performed adoption is in **no artifact** (Phase 1
  finding, reconfirmed: `migrationStamp`/`markMigrated`/`legacyDigest` have zero
  callers in every survivor).
- The artifact's LEGACY mode is a **steady-state** sync, not a bootstrap; on an
  empty store it degenerates to fresh allocation, so it does not specify
  adoption.
- The manifest is an invention. The digest and the `task_meta` substrate are
  verified; **using them this way is not**.
- Nothing surviving shows that pre-existing JSON was ever migrated, or that a
  mapping table was kept.

Any implementation must be labelled **NEW ARCHITECTURE** citing this document.

## 9. Implementation boundary (not implemented)

Would add, and nothing else:

- a new module, e.g. `src/task/bootstrap.ts`, containing the adopt/refuse
  decision and the manifest encoding;
- one call site at the boundary chosen in the 3C-DECISION design lock;
- reuse of `legacyDigest`, `migrationStamp`, `markMigrated`, `listTasks`,
  `createTask` unchanged.

Would **not** touch: `src/task/store.ts`, `identity.ts`, `model.ts`,
`src/tools/todo.ts`'s normaliser or JSON shape, `src/presentation/**`, and no
execution-loop code. **No schema change.**

## 10. Tests required before/with implementation

- absent and empty legacy list → no-op, store untouched
- single adoption maps `legacy[i] → taskId` in order
- re-running adoption with identical bytes → no-op, **no new ids** (idempotence)
- re-running with changed bytes and an existing manifest → refuses, store untouched
- store non-empty without a manifest → refuses (cannot prove)
- adoption transaction is atomic: injected failure mid-adoption leaves zero rows
  and no manifest
- crash simulation: reopen after a rolled-back adoption → still `LEGACY_UNMAPPED`
- reorder of the legacy list after adoption → identities unchanged
- duplicate legacy titles → still maps by index, one identity each
- session isolation: two sessions adopt independently, disjoint id spaces
- MCP shared-id case → explicitly guarded or explicitly documented as accepted
- adoption precedes plan publication: a v2 plan is impossible before adoption
- mutation: drop the manifest gate; ignore a digest mismatch; adopt when the
  store is non-empty; map by title instead of index; allocate twice

## 11. Unknowns that remain

1. Whether pre-wipe adoption happened at all, and how.
2. Whether a positional mapping was ever persisted.
3. Whether the historical design intended JSON to become a derived export.
4. Replay semantics after a partial write (carried over from 3C-DECISION Case G).
5. Crash behaviour between the JSON rename and the SQLite commit (Case F).
6. Whether the MCP path ever touched the store.
7. The steady-state positional hazard (risk 3) — **not solved by this design**;
   it needs the model to emit ids or an explicit "store wins" conflict rule.

**NOT IMPLEMENTING TaskStore production wiring. NOT modifying `adapter.ts` /
`events.ts`. NOT starting 3C-2. NO COMMIT CREATED.**
