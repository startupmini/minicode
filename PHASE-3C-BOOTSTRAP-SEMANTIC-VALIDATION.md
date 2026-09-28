# PHASE 3C-BOOTSTRAP-SEMANTIC-VALIDATION

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `9d7dcfe`
**Verdict: BLOCKED BY SEMANTIC UNKNOWN — and a CONTRADICTION was found in the
chosen design. No production code modified. No commit created.**

Every claim below marked MEASURED was produced by executing the current code
against a real SQLite database, not by reading it. All probes were deleted.

---

## 1. Digest semantics

`legacyDigest(raw) = sha256(scrubSecrets(raw)).slice(0, 32)` — it hashes the
**raw file text**, not a normalised logical list.

| condition | required behaviour | status |
|---|---|---|
| `legacyDigest == storedDigest` | no-op | **DESIGN DECISION** (sound) |
| `legacyDigest != storedDigest` | refuse, never re-derive | **DESIGN DECISION**, but see defect below |
| manifest present, digest missing | — | **UNKNOWN** — no evidence, no referential rule |
| digest present, manifest missing | — | **UNKNOWN** — inconsistent state, no defined recovery |
| manifest malformed | — | **UNKNOWN** — `task_meta` is free-form TEXT; no validation exists |
| manifest references a missing task | — | **UNKNOWN** — no foreign key, no integrity check |

### DEFECT (MEASURED): the digest is formatting-sensitive

```
compact vs pretty-printed, identical data -> digest DIFFERS
JSON key order swapped, identical data   -> digest DIFFERS
digest length                             -> 32
```

So "digest != stored → refuse" **refuses on a pure reformat** that changed no
logical task. Worse, it makes the digest a *file* identity rather than a *list*
identity. The chosen design's central idempotence gate is therefore wrong as
specified. A logical digest (over the normalised `{content,status,blockedReason}`
projection, not the raw bytes) is required — and that is a change to
`legacyDigest`'s contract, i.e. an edit to `store.ts`, which the design lock
said would not happen.

## 2. Atomicity — CONTRADICTION FOUND

The design claimed adoption is "one SQLite transaction … partial adoption is
structurally impossible". **MEASURED: false with the current API.**

| experiment | result |
|---|---|
| outer `db.transaction()` + `store.setMeta` + forced throw | meta **PERSISTED** — not rolled back |
| outer `db.transaction()` + `store.createTask` + forced throw | task **PERSISTED** — not rolled back |
| outer `db.transaction()` + **raw SQL on the same connection** + forced throw | **ROLLED BACK correctly** (0 rows, null meta) |
| flat raw INSERTs, no throw | committed correctly |

**Diagnosis.** The outer transaction works — but only for statements on *its
own* connection. `store.setMeta` and `store.createTask` execute through
`handle(this.cwd)`, TaskStore's **own cached `Database` handle**, which is a
*different* connection to the same file. Their writes commit independently of
the caller's transaction.

Consequence: the required "allocate + manifest + digest in one existing
TaskStore transaction" **cannot be expressed with the current API**. Every way
out breaks a stated constraint:

- add a TaskStore method that performs all three on TaskStore's own handle →
  a **new TaskStore API**, contradicting the design lock's "would not touch
  `store.ts`";
- do all three with raw SQL from a bootstrap module → atomic (MEASURED working)
  but **duplicates the allocation logic**, risking a second allocator and
  violating invariant 2.

Per this phase's instruction, atomicity is therefore **not guaranteed by the
current API**.

## 3. `task_meta` scope

```sql
CREATE TABLE IF NOT EXISTS task_meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL )
```

**No session column.** The table is scoped **per database file**, and the file is
per-cwd (`<cwd>/.minicode/tasks.db`). Session scope is *fabricated* by string
prefixing: `migrationStamp(s) => getMeta("migrated:" + s)`.

MEASURED: `migrated:sess-A`, `migrated:sess-B`, `migrated:mcp-server` all store
and read independently; an unset key reads `null`; `"a"` and `"a:"` produce
distinct keys. So metadata is **key-scoped, globally within the project DB**,
with session identity encoded in the key string — not a structural guarantee.

## 4. Manifest semantics

| aspect | status |
|---|---|
| ordering basis (array index vs `task_order`) | **DESIGN DECISION** — the legacy list has no order field; index is the only signal (MEASURED: `order`/`foo` are dropped on read) |
| zero- vs one-based ordinal | **DESIGN DECISION** — no evidence either way |
| duplicate ordinal | **UNKNOWN** |
| missing ordinal | **UNKNOWN** |
| extra manifest entries | **UNKNOWN** |
| missing manifest entries | **UNKNOWN** |
| task deleted after bootstrap | **UNKNOWN** — manifest would dangle; nothing consults it |
| task cancelled | **UNKNOWN** — cancellation is a status, not deletion; unrecoverable as UNKNOWN |
| new task appended after bootstrap | allocation from `nextId` (**VERIFIED**, `max`-based) |

**Additional unmapped fact (MEASURED):** the legacy field is `TodoItem.content`
but the identity layer's `DeclaredTask` field is `title`. Feeding a `TodoItem`
straight into `applyTaskIdentities` fails with
`NOT NULL constraint failed: tasks.title`. A `content → title` rename is
**required and not performed anywhere**.

## 5. Reorder analysis — MEASURED, and the answer is DUPLICATION

```
initial   A B C  ->  t1=A@0  t2=B@1  t3=C@2                [rows=3]
after C A B      ->  t1=A@0  t4=C@0  t2=B@1  t5=A@1
                    t3=C@2  t6=B@2                        [rows=6]
explicit ids t1,t2,t3 -> unchanged, duplicates remain     [rows=6]
```

Today's synchronisation does **not preserve** identity and does **not transfer**
it. It **duplicates**: every logical task now exists twice (A as `t1` and `t5`,
B as `t2` and `t6`, C as `t3` and `t4`) with **colliding `order` values**. The
subsequent explicit-id call addresses the originals and leaves the copies
**permanently**. This is precisely the split-identity hazard, and it is **live
now** in `applyTaskIdentities`.

**The manifest does not mitigate this.** MEASURED: neither `store.ts` nor
`identity.ts` contains the string `manifest` — no runtime path consults it.
Bootstrap idempotence is not identity stability, and the manifest cannot be
credited with reorder safety.

## 6. Authority transition

| concern | authority after bootstrap | classification |
|---|---|---|
| `taskId` | TaskStore | **DESIGN DECISION** |
| ordering | TaskStore `task_order`; legacy JSON order no longer consulted | **DESIGN DECISION** |
| status | TaskStore | **DESIGN DECISION** |
| content/title | TaskStore; the `content → title` rename happens at adoption | **DESIGN DECISION** |
| deletion | — | **UNKNOWN** (D7 retain existed in the artifact; Phase 3A does not retain) |
| new tasks | `nextId`, `max`-based, no collision | **VERIFIED** (Phase 1 + mutation) |
| presentation events | observational only | **VERIFIED** (invariant 5 upheld in 3B) |

## 7. MCP safety gate — NOT PROVEN SAFE

`src/mcp/server.ts:207` sets `todoSession.id = "mcp-server"` for the whole request
and restores the previous value at `:536-537`. With `task_meta` keyed only by
`"migrated:" + sessionId`:

- two unrelated MCP clients in one process would read and write the **same**
  `migrated:mcp-server` manifest and the **same** `session_id` task rows;
- one client's adoption could therefore refuse another's adoption
  ("digest differs") or, worse, be adopted into the other's task space.

Whether this is safe **cannot be established from the current code**, and it is
not solved speculatively here.

**Therefore: production TaskStore wiring MUST remain BLOCKED until the MCP
session namespace is guarded.**

## 8. Verdict

```
BLOCKED BY SEMANTIC UNKNOWN
```

A contradiction was found in the chosen design itself, so this is not merely a
list of open questions.

### Smallest unresolved decisions

1. **Atomicity** — approve either (a) a new TaskStore method performing
   allocation + manifest + digest on TaskStore's own handle, or (b) raw SQL in a
   bootstrap module with allocation delegated to `nextId`/`taskIdFromIndex` so no
   second allocator exists. Without one of these, adoption is **not atomic**.
2. **Digest definition** — replace the raw-bytes digest with a *logical* digest
   over the normalised projection, or accept that a reformat forces a refusal.
   Requires editing `legacyDigest` in `store.ts`.
3. **Reorder policy** — decide what a reorder of an id-less payload must do.
   Today it duplicates irrecoverably. Either reject it, treat the store as
   winning, or require ids from the model. **No manifest can substitute.**
4. **Manifest edge semantics** — ordinal base, duplicates, gaps, extras,
   deletion, cancellation. All currently UNKNOWN.
5. **MCP session namespace** — guard `"mcp-server"`, or explicitly accept
   shared bootstrap metadata. Until then wiring stays blocked.
6. **Deletion/D7 semantics** — whether adoption retains unmentioned tasks.
7. **`content → title` rename** — the boundary mapping, currently absent.

### What remains sound

The design lock's *reasoning* survives: one allocator (VERIFIED), `max`-based
`nextId` (VERIFIED), resolve-before-mutate (VERIFIED), no-positional-identity in
the adapter (VERIFIED), and `payloadVersion: 2` only on total resolution
(VERIFIED). What fails is the atomicity mechanism, the digest definition, and
any claim that a manifest addresses reorder.

**NO PRODUCTION CHANGES. NO COMMIT. NOT BEGINNING 3C-2.**
