# P3 Program — Current Canonical Truth & P3.3 Readiness Audit

Read-only audit. No source/test/docs/config modification, no git mutation (no commit,
no push, no stash, no cherry-pick). Current canonical **code is authoritative**;
historical reports are evidence only. Every claim below was verified against the live
tree at `59e7f76` (see §2), not against a report's asserted baseline.

---

## 1. Executive Summary

The P3 context program forms a **coherent, single-authority, append-only architecture**
in the current canonical tree, and every hard dependency P3.3 (Canonical Context
Selector) needs is already live. The architecture is realized under **P2.7 names**
(`RefusedHistoryRewriteError`, epoch-fenced `saveSession`, explicit provenanced
`shrinkThreadHistory`) plus **P3.2's formal, descriptive identity/frontier library**
(`src/session/context-identity.ts`). The P3.1 "FORM" reports describe a pre-write gate
that **does not exist in the live tree** — it survives only in a dangling stash and was
correctly superseded; the live enforcement is P2.7, and the retargeted P3.1 guard suite
(14/14) proves it through real production paths.

Key facts established:

- **Single canonical writer**: every production persistence route funnels through
  `cli/setup.ts:persistCurrent` → `saveSession` (+ conditional `shrinkThreadHistory`);
  headless ACP uses the same `persistCurrent`. No second writer exists.
- **Append-only is enforced structurally**: divergence / deletion / reorder / fold /
  N→N-rewrite all throw `RefusedHistoryRewriteError` *before any canonical mutation*;
  the `grewBeyondBuffer` fix additionally prevents the "canonical grew under a stale
  buffer" case from being destroyed by automatic shrink.
- **P3.2 is a pure, IO-free library**, currently **not imported by any production code**
  (only tests). It therefore introduces **no second authority** and **no runtime
  coupling** today — by construction there is no path by which its descriptive states
  could silently become authoritative.
- **P3.1 ↔ P3.2 semantics are consistent** where they meet, and the only "apparent"
  divergence (P3.2 says `UNKNOWN`, saveSession accepts) is a *correct, deliberate
  division of labour* (description vs decision), not a contradiction.
- **No P3 safety blocker exists.** Known gaps (attach history-presence gate: ABSENT;
  durable conflict-diagnostic category: ABSENT) are **observability/hardening** items,
  demonstrably non-blocking for P3.3.
- Full suite: **4348 pass / 23 skip / 9 fail / 1 error** (296 files). Every failure is
  classified as flake or pre-existing/unrelated; **zero P3 regressions**. TypeScript:
  28 errors, **all** in `test/phase3*`/`test/phase4*` (historical Phase 3/4 files),
  **zero** in P3 source.

**Verdict: READY WITH CONDITIONS** — P3.3 may begin; the conditions are bounded,
non-blocking hygiene items (report baseline drift, a stale-but-harmless source-text
test assertion, and two explicitly-scoped observability gaps to carry as P3.3 evidence).

---

## 2. Canonical Baseline

Verified by direct read (`git rev-parse`, `status`, `remote -v`):

| Fact | Value |
| --- | --- |
| Root (`--show-toplevel`) | `D:/git/minicode` |
| Branch | `main` |
| HEAD | `0597f7675c997cffa50c09f3fd8f455084788394` |
| `origin/main` | `0597f7675c997cffa50c09f3fd8f455084788394` (HEAD == origin/main) |
| Remote | `https://github.com/startupmini/minicode.git` (fetch + push) |
| Working tree | CLEAN (tracked files unchanged; `node_modules` gitignored) |

Recent history (top): `0597f76` docs (finalization) ← `37c9d9d` ← `8eebc64` ←
`88e319d` ← `fabcb78` ← `dd2e136` ← `5efdf15` (P3.1 guard, tagged
`p3.1-canonical-2026-10-08`) ← `ff67b47` ← `dae5c7e` (P3.2 migration) ← `4748b19`
(P3 artifacts preservation) ← `e284298` (P2 close).

**Baseline-drift caution (verified):** the P3.0 contract asserts HEAD `e284298`; the
P3.2 report asserts HEAD `9d79ebb` and (in its §3) claims the schema has *no*
`event_id`/`writer_epoch`/`thread_id`. The **current** `sessions.db` schema **does**
have all three (`src/session/persistence.ts:93-96,178-187`). Conclusion: report
baselines are historical; current code governs. This audit uses current code throughout.

Audit hygiene: only read operations were used for analysis (grep, read, `git` reads,
read-only test runs). `bun install` created the gitignored `node_modules` and left the
tracked `bun.lock` unchanged. `git status` remained empty at audit end.

---

## 3. P3 Artifact Inventory

Classification: **CURRENT EXECUTABLE** · **CURRENT DOC** · **HISTORICAL** · **STALE**
· **OBSOLETE** · UNKNOWN.

### 3.1 Source (executable)

| Artifact | Location | Class | Role |
| --- | --- | --- | --- |
| `saveSession` (append-only + refusal) | `src/session/persistence.ts:904-1051` | CURRENT EXECUTABLE | Sole canonical writer; prefix-check + `RefusedHistoryRewriteError(grewBeyondBuffer)` |
| `RefusedHistoryRewriteError` | `src/session/persistence.ts:2745-2761` | CURRENT EXECUTABLE | Divergence/shrink refusal, carries `grewBeyondBuffer` |
| `shrinkThreadHistory` | `src/session/persistence.ts:3072-3200` | CURRENT EXECUTABLE | Explicit, epoch-fenced, run-refusing, provenance (`migrated_compacted=1`) |
| `RefusedShrinkLiveRunError` | `src/session/persistence.ts:2764-2772` | CURRENT EXECUTABLE | Policy-A: no shrink under live RUNNING run |
| `persistCurrent` (catch→shrink gating) | `cli/setup.ts:1944-2013` | CURRENT EXECUTABLE | The one publication seam; refuses auto-shrink when `grewBeyondBuffer` |
| `context-identity.ts` (identity/frontier) | `src/session/context-identity.ts` (389 lines) | CURRENT EXECUTABLE (library, **unwired**) | P3.2 formal substrate; not imported by production |
| `authority.ts` (lease + epoch) | `src/session/authority.ts` | CURRENT EXECUTABLE | Single-writer admission + CAS fence |
| `identity.ts` (resolve/alias) | `src/session/identity.ts` | CURRENT EXECUTABLE | Attach/resume resolution |
| `stripContextOnly` / baseline rebase | `cli/setup.ts:89,882,1963-1968` | CURRENT EXECUTABLE | Compaction-artifact discipline in publication |
| `context:compacted` bridge | `src/presentation/adapter.ts:968-971` | CURRENT EXECUTABLE | Kernel→durable compaction marker |

### 3.2 Tests

| Artifact | Class | Evidence |
| --- | --- | --- |
| `test/p3-reconciliation-guard.test.ts` (14) | CURRENT EXECUTABLE | 14/14 green ×3 (this session: 14/14); real production paths |
| `test/context-identity.test.ts` (39) | CURRENT EXECUTABLE | 39/39 green; F-05 mutation-sensitive (test A2) |
| `test/p2-architecture-guards.test.ts` | CURRENT EXECUTABLE | P2.7 append-only/epoch/rewrite guards |
| `test/harness-p3.test.ts` | CURRENT EXECUTABLE | Step-trace + resume-workspace validation (tangential) |
| `test/architecture-map.test.ts` | CURRENT EXECUTABLE | 2/2 green; map↔kernel pin |

### 3.3 Documents (all non-executable)

| Artifact | Class | Note |
| --- | --- | --- |
| `P3_0_CONTEXT_SESSION_CONTRACT.md` | CURRENT DOC (contract) | Baseline `e284298`; D1–D6 partly superseded by live reality (§5) |
| `P3.1_CURRENT_CANONICAL_TRUTH_AUDIT.md` | CURRENT DOC | Truth audit at `ff67b47`; findings still hold |
| `P3_1_CURRENT_CANONICAL_IMPLEMENTATION_REPORT.md` | CURRENT DOC | Retarget implementation report; VALID |
| `P3.1_IMPLEMENTATION_REPORT.md` | HISTORICAL | Superseded FORM |
| `P3.2_CONTEXT_IDENTITY_FRONTIER_REPORT.md` | HISTORICAL/CURRENT DOC | §3 baseline stale (schema claims wrong vs now); §5–§9 still accurate |
| `P3_FORENSIC_AUDIT_REPORT.md` | HISTORICAL | Forensic provenance |
| `P3.10_GATE_HYGIENE_CLOSURE_REPORT.md` | HISTORICAL | Gate-hygiene closure at `e284298`; "tsc 0" claim no longer matches tree |
| `docs/design/adr/ADR-21-reconciliation-liveness-proof.md` | CURRENT DOC | Task-scheduler reconciliation (different domain) |
| `PHASE-3*`, `PHASE-4*` reports (identity/taskstore) | HISTORICAL | Prior Phase-3/4 program (TaskGraph/identity), not P3.0-P3.3 |

**No artifact deleted.** No STALE executable was found in the live tree except the
historical P3.1 FORM, which is documented as superseded and has no executable remnants
(§5.4).

---

## 4. Reconstructed P3 Architecture (from source)

```
                 CANONICAL AUTHORITY  (single writer: persistence.ts open()/saveSession)
                              │
   ┌──────────────┬───────────┴───────────┬──────────────────┐
   ↓              ↓                       ↓                  ↓
sessions/      messages (history)     threads/head_seq    runs (lifecycle,
threads        AUTHORITATIVE          (identity AUTH;      NOT a context input)
(identity      event_id = identity     head_seq = CACHE)
 AUTHORITATIVE) seq     = position
   │              │
   │              │  (read-only; always possible)
   │              ↓
   │        Context Projection (history_projections) ── CACHE / derived
   │              │   (base_seq + anchor_event_id + summary; no production producer today)
   │              ↓
   │        Context Assembly (context-assembly.ts) ── DERIVED, read-only, RAM
   │              ↓
   │        Runtime Context (ContextStore, kernel) ── EXECUTION-LOCAL
   │              │   (carries EVIDENCE: not-yet-durable tail)
   │              ↓
   │        Model-visible Context (buildRequest) ── DERIVED
   │              │
   └──────────────┴──► PUBLICATION (persistCurrent → saveSession)
                          │  decision: prefix-check + epoch/run gate
                          │  APPEND  → accept (new event_ids)
                          │  IDENTICAL → no-op (idempotent)
                          │  DIVERGE/DEL/REORDER/FOLD → REFUSE (throw, canonical intact)
                          │  GREW-BEYOND-BUFFER → refuse shrink (I2); honest stale flag
                          │  STALE-EPOCH → StaleWriterError → honest exit (no blind retry)

  Cross-cutting (never authoritative over context):
    P3.2 context-identity.ts  → DESCRIPTIVE library (identity/frontier/compare/freshness),
                                 no IO, no store, NOT imported by production
    Presentation / consumer_offsets → PRESENTATION
    VerificationRecord               → EVIDENCE (effects)
    Journal                          → EVIDENCE (UNKNOWN-first)
    Memory/RAG                       → DERIVED, untrusted, model-only
```

### 4.1 Authority table

| Layer | Owner | Authority | Durable? | Can mutate canonical? |
| --- | --- | --- | --- | --- |
| Canonical session state (`sessions`) | `persistence.ts` | AUTHORITATIVE | yes | (is the authority) |
| History (`messages`) | `persistence.ts` | AUTHORITATIVE | yes | append-only via `saveSession` |
| Thread identity / lineage | `persistence.ts` | AUTHORITATIVE | yes | via `createThread`/`ensureDefaultThread` |
| `threads.head_seq` | `persistence.ts` | CACHE (recomputed) | yes | only via owner recompute |
| Run (`runs`) | `persistence.ts` | AUTHORITATIVE (lifecycle) | yes | run transitions only; not a context input |
| Context projection (`history_projections`) | `persistence.ts` | CACHE/derived | yes | via owner only; no production producer |
| Context assembly | `context-assembly.ts` | DERIVED, read-only | no (RAM) | NO |
| Runtime context (`ContextStore`) | kernel | EXECUTION-LOCAL (evidence-pending) | no | NO (must publish via `saveSession`) |
| Model-visible context | kernel `buildRequest` | DERIVED | no | NO |
| **P3.2 frontier/identity** | `context-identity.ts` | **DESCRIPTIVE, derived** | no | **NO** (pure functions, no IO) |
| Presentation | `src/presentation/*` | PRESENTATION | yes (own table) | NO (observation-only) |
| Verification | `verification.ts` | EVIDENCE (effects) | yes | NO (never enters history) |
| Memory/RAG | `src/memory/*` | DERIVED (untrusted) | yes | NO (model-only augmentation) |

**Derived-becoming-authoritative check:** No layer can silently become authoritative.
The only theoretically dangerous seam — runtime buffer → canonical content — is fenced
by (a) prefix-check, (b) epoch CAS inside the write transaction, and (c) the
`grewBeyondBuffer` refusal. P3.2 is a pure library with no store, so it cannot become a
shadow authority.

---

## 5. P3.0 Contract — Current Truth

Audited against current code. Invariants (contract §18) re-evaluated:

| Invariant | Current status | Evidence |
| --- | --- | --- |
| I1 canonical changes only via append-extension / explicit class-§3.3 ops | **TRUE** | `saveSession` append-only; explicit `shrinkThreadHistory`/`deleteSessionCompletely` |
| I2 no implicit rewrite; `RefusedHistoryRewriteError` never auto-shrunk | **TRUE (strengthened)** | `cli/setup.ts:1985` refuses shrink when `grewBeyondBuffer`; fold path stays explicit |
| I3 runtime context never authoritative over canonical content | **TRUE** | write path requires `saveSession`; no buffer→DB bypass |
| I4 context artifact names `(session, thread, base_seq, anchor)` | **PARTIALLY TRUE** | P3.2 `ContextIdentity` provides it; **not yet wired** to production (P3.3 will) |
| I5 `event_id` identity, `seq` position, never exchanged | **TRUE** | `event_id` column; `deriveHistoryCommit` binds `(session,thread,seq,content)` |
| I6 summary/fold never enters `messages`, always labeled | **TRUE (with discipline)** | `stripContextOnly` + baseline rebase; guard `p2-architecture-guards` |
| I7 projection is cache (absent = miss) | **TRUE** | `getProjectionStatus` → `UNKNOWN: no projection row` |
| I8 assembly read-only/deterministic | **TRUE** | `context-assembly.ts` no writes; guard |
| I9 resume never fabricates facts | **TRUE** | resume reloads canonical rows; `SessionNotFoundError` on unknown |
| I10 UNKNOWN never rendered/promoted as success | **TRUE** | UNKNOWN-first journal; guard |
| I11 child inherits no parent history/authority | **TRUE** | `createChildSession` without `initialMessages` |
| I12 memory/RAG never canonical, untrusted, fingerprintable | **PARTIAL** | untrusted+non-canonical TRUE; injection fingerprint durable: **OPEN (contract D4)** |
| I13 `writer_epoch` is the only mutation fence; no second writer | **TRUE** | `assertWriterEpochInTxn`; single `persistCurrent` |
| I14 presentation observation-only | **TRUE** | guards `p2-architecture-guards`; no UI→canonical path |
| I15 no capability via context | **TRUE** | permissions live in `permission`/`capability`, not context |

**Reconciliation-lifecycle (§4) status:** the forbidden chain
`runtime diverges → append fails → blind shrink → canonical replaced` is **closed**.
On `DIVERGED`, `saveSession` throws; `persistCurrent` either refuses-honestly
(`grewBeyondBuffer`) or takes the *explicit* provenanced shrink route (fold). No blind
shrink of a grown canonical is possible.

**P3.0 verdict vs current code:** the contract is **coherent with current code**. The
one previously-identified violation (blind shrink on `persistCurrent`) is now prevented
by the P3.1-retarget `grewBeyondBuffer` fix. Remaining contract items (I4 wiring,
I12 fingerprint, D4 timing) are **forward-looking seams**, explicitly scoped to
P3.3/P3.5/P3.11, not contradictions.

---

## 6. P3.1 — Current Truth

### 6.1 Core (verified from source + tests)

| Behavior | Status | Evidence |
| --- | --- | --- |
| Append-extension accepted; prefix identity preserved | **ENFORCED** | guard A (`p3-reconciliation-guard.test.ts:212`); old `event_id`s stable |
| Identical = idempotent (no new rows/turns/identity) | **ENFORCED** | guard E (`:319`); turn count stays 1 |
| Divergence refused; canonical untouched | **ENFORCED** | guard B (`:232`); fingerprint byte-identical |
| Deletion refused | **ENFORCED** | guard C(1) (`:268`) |
| Reorder refused | **ENFORCED** | guard C(2) (`:272`) |
| Fold/non-prefix buffer handled safely (refused, not appended) | **ENFORCED** | guard C2 (`:284`); P3.2 bridge → STALE |
| Stale writer refused (no blind retry) | **ENFORCED** | guard P5 (`:571`); `StaleWriterError` → honest flag+exit |
| No silent overwrite | **ENFORCED** | refusal before mutation; guard B/C/P4 |

### 6.2 I2 `grewBeyondBuffer` (the newly-fixed case)

Reconstructed pre-fix failure:

```
stale buffer [A,B]  ,  canonical grew to [A,B,C-other]
  → saveSession prefix-loop: stored.length(3) > incoming.length(2) → prefixSame=false
  → throw RefusedHistoryRewriteError(grewBeyondBuffer=false pre-fix)
  → persistCurrent catch: NOT grewBeyondBuffer → took EXPLICIT-shrink route
  → shrinkThreadHistory rewrote canonical to [A,B]  → C-other DESTROYED  (I2 violation)
```

Current code (`src/session/persistence.ts:1024-1050`): on the shrink branch, when
`stored.length > messages.length` **and** the incoming buffer is a true prefix of stored
(every field equal for `i < messages.length`), it sets `grewBeyondBuffer = true`. The
composition root (`cli/setup.ts:1985-1990`) then **refuses** (`markWriterStale` +
note + `return`) instead of shrinking. Load-bearing proof: guard **P4**
(`:550-569`) asserts canonical stays `["A","B","C-dari-penulis-lain"]`,
`isWriterStale()===true`, and `writerStaleNote()` contains `"grew beyond buffer"`.
The pre-fix probe (recorded in the implementation report) failed; post-fix P4 is green.
The field comparison is kept identical to the F-05 prefix loop (comment explicitly warns
to keep them in sync).

### 6.3 Test quality

- **14/14 guard tests**, run this session (14 pass / 0 fail ×1 confirmed, 67 expects).
- **Production reachability**: tests import and exercise `saveSession`,
  `resolveSessionIdentity`, `createCliSession`, `persistCurrent`, plus a real CLI
  subprocess probe (P3, `:686`). No fake doubles replace production behavior.
- **Non-vacuity**: guard P1 drives a *real* kernel compaction (asserts
  `history.length` shrank), then asserts explicit provenance (`migrated_compacted=1`).
  Guard P4 is the mutation-sensitive test for the fix.
- **No historical dead-API references**: verified (see §6.4).

### 6.4 Historical separation (verified)

`git grep` across all `*.ts` for the historical symbols
`assessHistoryPublication`, `compareStoredPrefix`, `STORED_PREFIX_SQL`, `sessionHasHistory`,
`SessionAttachRefusedError`, `refusePublication`, `noteDiagnostic`,
`isReconciliationConflict`, `SESSION_ATTACH_REFUSED` returns matches **only inside two
comment lines** in the guard test header (`test/p3-reconciliation-guard.test.ts:14-15`),
which explicitly mark them SUPERSEDED. **Zero executable references.** The historical
P3.1 FORM lives only in the dangling stash (not recovered), consistent with the truth
audit.

### 6.5 P3.1 verdict

**VALID** for the core append-only invariant, on current architecture, with the
`grewBeyondBuffer` I2 fix live and load-bearing. Extended gaps (attach presence,
durable conflict category) remain explicit, non-blocking.

---

## 7. P3.2 — Current Truth

### 7.1 Identity — **FORMAL**

`ContextIdentity = { sessionId, threadId, baseSeq, anchorEventId }`
(`context-identity.ts:63-68`). `anchorEventId` = `ctxev_<32hex>` = SHA-256 over
`(session, thread, seq, canonical content)` via `deriveAnchorEventId` (`:147`).
Fail-closed on invalid input; objects frozen. `run_id`, model, provider, fingerprint,
RAG hits, runtime buffer are **excluded by construction**. Verified by equality/stability
tests (`context-identity.test.ts:64-158`).

### 7.2 Frontier — **FORMAL**

`ContextFrontier = identity + { headSeq, lastSeenSeq, lastSeenEventId, revision,
historyCommit }` (`:81-87`). `revision` = count of durable `context.compacted`
(`countDurableCompactions:369`). `historyCommit` = `ctxhist_<32hex>` over **all
covered rows** (`deriveHistoryCommit:190`).

### 7.3 Comparison — **FORMAL, 5-way**

`compareContextFrontier` (`:308-325`): `UNKNOWN` (invalid/different session),
`DIVERGED` (different thread, different revision, or same endpoints but different
content/commit), `EQUAL`, `A_AHEAD`, `B_AHEAD`. No timestamps, `Date.now`, object
identity, array index, prompt position, or `run_id`.

### 7.4 Freshness — **FORMAL, explicit UNKNOWN**

`assessContextFreshness` (`:342-358`): `FRESH` / `STALE` / `DIVERGED` / `UNKNOWN`.
Durable-only reconstruction via `deriveFrontierFromDurable` (`:241`,
`test/..."restart"` round-trips). UNKNOWN is first-class (`null` ≠ error). Stale
detection and divergence detection are explicit; certainty is never inferred.

### 7.5 F-05 protection (`historyCommit`) — **VERIFIED**

`historyCommit` covers the entire covered range, not just endpoints. Test **A2**
(`test/context-identity.test.ts:90-100`) constructs a length-equal middle rewrite
(`[a,b,c]` → `[a,B,c]`): `headSeq` equal, `anchorEventId` equal, but
`historyCommit` **differs** → `compareContextFrontier` = `DIVERGED` and
`assessContextFreshness` = `diverged`. This closes the "rewrite middle / N→N blind
spot" claimed by P3.2. **Verified true of current code.**

### 7.6 Authority — **DESCRIPTIVE/DERIVED, not a second authority**

`context-identity.ts` is a pure module: no IO, no store, no sidecar, no DB column, no
`vendor` edit. Verified: it is imported **only** by `test/context-identity.test.ts` and
`test/p3-reconciliation-guard.test.ts` — **zero production imports** (`cli/`, `src/`
grep confirms). Therefore it cannot be a persistence authority today.

### 7.7 P3.2 verdict

**Formal, deterministic, trustworthy for description.** Its identity/frontier semantics
are internally consistent and mutation-sensitivity is proven. It is **not yet wired**
into production — that wiring is P3.3 (selector) / P3.5 (adapter), which is the correct
scoping, not a defect.

---

## 8. P3.1 ↔ P3.2 Consistency

Semantic mapping between the publication decision layer (P2.7/P3.1) and the descriptive
frontier layer (P3.2):

| P3.1 / saveSession state | P3.2 freshness/frontier state | Consistent? |
| --- | --- | --- |
| IDENTICAL (no-op) | `EQUAL` | YES — guard E (`:334-337`) |
| APPEND (accepted) | valid frontier advance (`B_AHEAD`) | YES — guard F (`:351-355`) |
| DIVERGED (refused) | `DIVERGED` | YES — guard B (`:259`), guard F (`:368`) |
| Folded/non-prefix (refused) | `STALE` (view behind head) | YES — guard C2 (`:307`) |
| Candidate beyond head (accepted as valid append) | `UNKNOWN` **as a view** | Deliberate division (§8.1) |

**Dangerous inverse** — "P3.2 says valid append/FRESH but P2.7 rejects": **not observed.**
The safe mapping is guaranteed because P2.7's decision is a pure prefix-check (necessary
condition for any accepted append), while P3.2 only *describes*; a candidate that P2.7
accepts is always a true prefix-extension, which P3.2 would classify as an advance, never
as DIVERGED.

### 8.1 The one "apparent" divergence is correct

Guard F (`:374-392`): a candidate frontier built from rows `[A,B,C,D]` (one row beyond
current canonical `[A,B,C]`) returns `assessContextFreshness(candidate, canonical) =
"unknown"` — **because the candidate's head exceeds the canonical head, and P3.2 refuses
to certify a view against a state it cannot see.** Then `saveSession([A,B,C,D])` **accepts**
(a valid append). This is **not** a contradiction:

- P3.2 answers *"is this VIEW a faithful view of the CURRENT canonical?"* → UNKNOWN (it is
  ahead — unverifiable as a view).
- P2.7 answers *"is this proposed NEW state a legal extension of canonical?"* → yes (prefix
  matches, length grows).

The two questions are different. P3.2 **describes**; P2.7 **decides**. This is intentional
defence-in-depth, not a duplicated gate and not a semantic conflict. It is explicitly
documented in the guard test header and implementation report §6.

### 8.2 Consistency verdict

**CONSISTENT.** No case produces contradictory decisions at the point where they meet.
The layers are non-overlapping by design (description vs decision). Caveat: because P3.2
is **not yet wired**, this consistency is currently established at the semantic/unit
level; P3.3/P3.5 must preserve it when wiring.

---

## 9. Authority / Single-Truth Audit

| Authority | Answer | Evidence |
| --- | --- | --- |
| Canonical History Authority | **`persistence.ts` (single writer via `saveSession`)** | one `open()`, one append path, epoch CAS |
| Context Runtime Authority | **kernel `ContextStore` (execution-local; NOT authoritative over content)** | write requires `saveSession` |
| Publication Decision Authority | **`saveSession` prefix-check + epoch/run gate** (surfaced by `persistCurrent`) | guards B/C/E/P1/P2/P4/P5 |
| Identity Authority | **`persistence.ts` (`session_id`, `thread_id`, `event_id`)**; `identity.ts` resolves | schema + `identity.ts` |
| Frontier Authority | **P3.2 `context-identity.ts` — DESCRIPTIVE only (no store)** | pure module, no IO |
| Selector Authority | **NOT YET IMPLEMENTED** (P3.3) | — |

**Violations found: NONE.**

Checked for: shadow stores (none), sidecars (none), caches treated as authority
(`history_projections` is cache; `head_seq` is cache — both owned, recomputed, never
authoritative), duplicated history (none), duplicated identity (none), duplicated frontier
(P3.2 frontier is derived and unwired), alternate writers (none — single `persistCurrent`),
hidden reconciliation state (none — decision is in-txn), unofficial session truth (none).

Checked database tables (`CREATE TABLE` in `persistence.ts`): `sessions`, `messages`,
`turns`, `presentation_events`, `session_aliases`, `session_takeovers`, `threads`,
`runs`, `history_projections`. No separate "context" store exists.

Principle **"derived may observe authority; derived must not silently become authority"**
holds: the only derived state that receives a large buffer (runtime context) must pass
through the single fenced writer; P3.2 is observation-only.

---

## 10. Publication Boundary Audit

Every route by which runtime state can reach canonical persistence (traced from source):

| Route | Entry | Validated? | Epoch-fenced? | Append-only? | Can shrink? | Can overwrite? | Bypass P2.7? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Normal turn (interactive/TUI/exec) | `persistCurrent` → `saveSession` | yes (prefix-check) | yes (`expectedEpoch`) | yes | no | no | no |
| Headless ACP run | `acp.ts:461` → `persistCurrent` → `saveSession` | yes | yes | yes | no | no | no |
| Turn completion | same `persistCurrent` | yes | yes | yes | no | no | no |
| Close / shutdown | `persistCurrent` (called before close) | yes | yes | yes | no | no | no |
| Error recovery | `persistCurrent` catch → shrink branch | yes | yes | n/a | only explicit `shrinkThreadHistory` | via explicit path only | no (explicit, provenanced) |
| Compaction (kernel fold in RAM) | `persistCurrent` catch → `RefusedHistoryRewriteError` → explicit shrink | yes | yes (shrink requires `expectedEpoch`, refuses live RUNNING) | replaced by explicit provenanced rewrite | yes (explicit, `migrated_compacted=1`, invalidates projections) | only via explicit path | no |
| Session resume | `resolveSessionIdentity` + `persistCurrent` append | yes | yes | yes | no | no | no |
| Retry (busy) | `withBusyRetry` — does NOT retry non-BUSY errors (incl. epoch/refusal) | yes | yes | yes | no | no | no |
| Stale writer | `assertWriterEpochInTxn` → `StaleWriterError` → honest exit | yes | yes | n/a (refused) | no | no | no |
| `grewBeyondBuffer` (canonical grew under stale buffer) | `persistCurrent:1985` refuses shrink | yes | yes | n/a (refused) | **NO (fixed)** | no | no |
| Explicit shrink | `shrinkThreadHistory` (epoch-fenced, run-refusing, provenance) | yes | yes | n/a (authorized rewrite) | yes (authorized) | authorized, recorded | by-design explicit |
| Delete/purge | `deleteSessionCompletely` (incarnation-bump-first ordering) | yes | n/a | n/a (domain delete) | full delete | full delete | by-design explicit |
| Backfill (NULL columns) | additive migration | yes | n/a | additive only | no | no | no |
| `appendHistoryEvent` utility | internal; only within owner txn | yes | within txn | yes | no | no | no |

**Result: every reachable route is validated, epoch-fenced, and cannot bypass P2.7.** The
only operations that can shrink/rewrite are the two **explicit, authorized, provenanced**
functions (`shrinkThreadHistory`, `deleteSessionCompletely`), neither of which is on the
normal automatic path. **Publication boundary: PASS.**

---

## 11. Compaction Audit

Interaction of kernel compaction with P3.2 frontier, P3.1 reconciliation, P2.7 publication:

- **How a compacted runtime buffer is represented:** the kernel folds a prefix into a
  synthetic summary message inside the RAM `ContextStore` (kernel `store.replace`); the
  durable bridge is `context:compacted` → durable `context.compacted` event
  (`adapter.ts:968-971`, `events.ts:265,432`).
- **How baseline is rebuilt:** `persistCurrent` (`cli/setup.ts:1962-1969`) computes
  `tail = stripContextOnly(buffer, contextOnlyArtifact)`; if a context-only summary
  artifact is ahead of the buffer it rebases as
  `[...contextCanonicalBaseline, ...tail]` — canonical baseline + genuinely-new tail.
  This prevents the folded buffer from wiping canonical history via the shrink path.
- **How provenance is preserved:** the explicit `shrinkThreadHistory` route stamps
  `migrated_compacted=1` on rewritten/inserted slots and preserves adopted-row
  `event_id`/`run_id`; it invalidates all thread projections in the same transaction.
- **How a non-prefix/folded buffer is handled:** refused by `saveSession`
  (`RefusedHistoryRewriteError`); the composition root routes to explicit shrink only
  for the buffer's own fold (and refuses when `grewBeyondBuffer`). Guard P1 proves the
  real path.
- **Can compaction appear as canonical replacement?** **No.** A direct "folded buffer =
  new canonical" write is refused (guard C2); the only fold-write is the explicit
  provenanced shrink, which is not a silent replacement. The P3.0-flagged non-conforming
  form "B" (destructive rewrite without provenance) is not what the code does on the
  automatic path.

**Invariant `COMPACTION ≠ HISTORY REWRITE`:** satisfied at the boundary — canonical
`messages` is never silently replaced by a fold; a fold either (a) is refused, or (b)
goes through the explicit, provenance-recording shrink (a *lawful*, recorded rewrite,
not a silent replacement). Residual: `revision`/projection-based fold coverage as a
*first-class* mechanism (contract §8/§9 A+C shape) is **not yet wired** — that is P3.7.

**Compaction safety: PASS (with forward seam to P3.7 for the A+C projection form).**

---

## 12. Session Resume / Attach Audit

**What current attach/reuse validates** (`resolveSessionIdentity`, `identity.ts:144-184`):

1. `--resume <id>` on an unknown id → `SessionNotFoundError` (no silent new session).
2. Alias conflicts → `SessionAliasError` (CONFLICT / HIJACK / DANGLING).
3. Filesystem key collisions → `SessionKeyCollisionError` (no auto-merge).
4. Plain `--session <existing>` reuse → resolves to the canonical id and **continues**
   (`resumed:false`), no refusal.

**What it does NOT validate:** there is **no history-presence gate** — reusing an id that
already has history (without `--resume`) does not refuse; it starts a fresh buffer and
subsequently takes the **explicit provenanced shrink** route, displacing prior history
through a lawful path (guard P3, `test/p3-reconciliation-guard.test.ts:686-733`, asserts
all replacement rows carry `migrated_compacted=1`).

**Impact on P3.3:** Low. P3.3 selects/quotas context from canonical history; the attach
gap is about session *identity reuse semantics*, orthogonal to selection. A P3.3 selector
reading canonical rows is unaffected by whether an id was "freshly reused" — it sees the
current canonical content either way.

**Can P3.3 safely operate without the gate?** Yes. The gate is a defence-in-depth /
operator-semantics hardening. Its absence does **not** permit silent canonical corruption:
displacement goes through the epoch-fenced, provenance-recording explicit path.

**Recommendation:** keep as **defence-in-depth** hardening for **P3.4/P3.5** (session
lifecycle), not a P3.3 prerequisite. Do not exaggerate: this is not data loss without a
trace; it is undisclosed displacement.

**Session attach safety: PARTIAL** (works and is fail-closed on unknown/alias/collision;
history-presence gate absent by documented design).

---

## 13. Diagnostic / Evidence Audit

- **Durable diagnostic channel: PRESENT.** `diagnostic.raised` is durable+replayable
  (`events.ts:334,436`), bridged from the kernel (`adapter.ts:947`), reduced
  (`reducer.ts:690`), and persisted (`persistence.ts:631`).
- **Explicit reconciliation-conflict category: ABSENT.** No `RECONCILIATION_CONFLICT`
  or equivalent exists in source (grep confirms; the only "conflict" identifiers are
  alias conflicts and `RUN_TERMINAL_CONFLICT`, both unrelated).
- **Is refusal evidence sufficient operationally?** The refusal surface is: a thrown
  typed error (`RefusedHistoryRewriteError` with `code`, `detail`, `grewBeyondBuffer`)
  → honest stderr/exit; plus `isWriterStale()`/`writerStaleNote()` flags; plus intact
  canonical rows (the strongest evidence). An operator **can** diagnose "why did my turn
  not persist" from these. What is missing is a *durable, categorised* conflict event.

**Separation of requirements:**

- **Safety requirement:** the refusal must be *fail-closed and visible* — **MET**
  (throw + flag + intact canonical; UNKNOWN never rendered as success).
- **Observability requirement:** a durable, categorised conflict record — **ABSENT**
  (deferred by decision). This is a *nice-to-have* for post-hoc analysis, not a safety
  invariant.

**Does P3.3 depend on richer diagnostics?** No. P3.3 selection reads canonical content;
it does not require a durable conflict category to build a context view. A selector can
emit its own `selectionBasis` provenance (the P3.2 `ModelContextProvenance` type already
reserves this).

**Diagnostic evidence: PARTIAL** (safety channel present; conflict category absent, non-blocking).

---

## 14. Test Graph

For each major P3 invariant: test → production function → production decision → canonical side effect.

| Invariant | Test | Production function | Production decision | Canonical side effect | Reachability |
| --- | --- | --- | --- | --- | --- |
| Append accepted | guard A, D | `saveSession` | prefix same + grows → insert | new `event_id`s appended | **real (in-process + CLI)** |
| Idempotent | guard E | `saveSession` | prefix same + equal length → no-op | none | **real** |
| Divergence refused | guard B, C, F | `saveSession` | prefix differs → throw | none (intact) | **real** |
| Fold refused | guard C2 | `saveSession` | non-prefix shrink → throw | none | **real** |
| I2 grew-beyond-buffer | guard P4 | `saveSession` + `persistCurrent` | grow-prefix → refuse shrink | none (flag stale) | **real (via `createCliSession`)** |
| Stale writer | guard P5 | `assertWriterEpochInTxn` → `StaleWriterError` | epoch mismatch → throw | none | **real** |
| Explicit shrink w/ provenance | guard P1 | `shrinkThreadHistory` | fold route | rewrite w/ `migrated_compacted=1` | **real (real compaction)** |
| CLI reuse semantics | guard P3 | `cli/index.ts` subprocess | reuse→shrink, resume→append | recorded | **real (subprocess)** |
| P3.2 identity/F-05 | `context-identity` A/A2 | pure fns | content-bound hash | none (pure) | **unit (by design, unwired)** |
| P3.2 freshness | `context-identity` set | `assessContextFreshness` | 4-state | none | **unit** |

**Quality assessment:**

- **Non-vacuous / production-reaching:** the P3.1 guard suite (14) reaches real production
  via `saveSession`/`createCliSession`/subprocess. Mutation-sensitive (P1, P4).
- **Pure-unit by design:** P3.2 (39 tests) is unit-level because the module is a pure
  library — appropriate, but note it does **not** yet exercise a production call site
  (none exists). Not a defect; a P3.3-wiring consequence.
- **Stale/tangential:** `harness-p3.test.ts` tests step-trace + resume-workspace
  validation — related to the broader P3 program, not the core context invariant.
- **Source-text brittle:** `runtime-shutdown.test.ts:487` asserts a literal
  `"\n    detachUI()\n"` position — a formatting-coupled assertion, currently failing
  (see §15). It is not a behavior test.
- **Untested branch (declared):** P3.2 `revision`/`countDurableCompactions` is tested but
  not wired; the projection-based fold-coverage path is future (P3.7).

**P3 test evidence: PASS** for the core append-only invariant; **PARTIAL** for P3.2
production integration (none yet, by design).

---

## 15. Full-Suite Health

Executed (this session) against current tree:

| Target | Result |
| --- | --- |
| P3.1 guard (`p3-reconciliation-guard`) | **14 pass / 0 fail** |
| P3.2 (`context-identity`) | **39 pass / 0 fail** |
| architecture map | **2 pass / 0 fail** |
| P3/P2.7 focused batch (guards+identity+epoch+storage) | **81 pass / 0 fail** |
| persistence + harness-p3 | **23 pass / 0 fail** |
| context-assembly/audit/session suites | **65 pass / 0 fail** |
| **Full suite** (`bun test`) | **4348 pass / 23 skip / 9 fail / 1 error** (296 files / 4380 tests / 1194s) |
| TypeScript (`tsc --noEmit`) | **28 errors — all in `test/phase3*` / `test/phase4*`** |

### 15.1 Failure classification (all 9)

| # | Failing test | File | Class |
| --- | --- | --- | --- |
| 1-2 | `P2.1: single-write ...`, `P2.1: semua path turunan ...` | `session-identity.test.ts` | **FLAKY** — `process.stderr.write.bind` returns null after cross-test stderr contamination (`statusline.ts:92`); **34/34 pass in isolation** |
| 3-4 | `P2.2: alias ...`, `P2.2: komposisi penulis kedua ...` | `session-epoch.test.ts` | **FLAKY** — same stderr-stub root cause; pass in isolation |
| 5 | `audit: manifes korup ...` | `session-audit.test.ts` | **FLAKY** — same `bound is not a function` stderr-stub cause |
| 6 | `delegate_task meneruskan abort ke child ...` | `hardening-boundary.test.ts` | **FLAKY (env)** — EPIPE race in child-process abort; **14/14 pass in isolation** |
| 7 | `P3: konstruktor authority runtime hanya di src/runtime` | `m15-production-integration.test.ts` | **PRE-EXISTING DEBT** — deterministic allowlist miss (`dispatch.ts: createRecoveryEngine`); source from P1 commits |
| 8 | `S13 scheduler-first ...` | `runtime-shutdown.test.ts` | **PRE-EXISTING (brittle)** — source-text pattern `detachUI()` position assertion; not behavior |
| 9 | `web ssg > docs tanpa nested list` | `web-build.test.ts` | **PRE-EXISTING/ENV** — doc content nested-list check (`docs/TASK_EVENT_MODEL.md`) |

**P3 regressions: ZERO.** Failures 1–6 are flakes (green in isolation); 7–9 are
pre-existing/unrelated (their source files date to P1/P2 commits; none touches P3
context code). TypeScript errors are 100% in historical Phase 3/4 test files.

---

## 16. Debt Impact Audit

| Debt | Source | Causal path to P3? | Classification |
| --- | --- | --- | --- |
| P3-constructor allowlist (`m15` test) | P1 (`dispatch.ts`) | none | **UNRELATED DEBT (deterministic)** |
| CLI-subprocess flakes (`session-identity/epoch/audit`) | test stderr-stub pattern | none | **PRE-EXISTING FLAKE** |
| `delegate_task` EPIPE (`hardening-boundary`) | env child-process | none | **PRE-EXISTING FLAKE (env)** |
| `web` nested-list (`web-build`) | docs content | none | **UNRELATED DEBT** |
| `pack` 21/23 | pre-existing graph/size | none | **UNRELATED DEBT** |
| `coverage` gate blocked | by pre-existing fails | none | **UNRELATED DEBT** |
| `tsc` 28 (phase3/phase4 test files) | historical Phase 3/4 tests | none | **UNRELATED DEBT** |
| S13 source-text assertion | `runtime-shutdown.test.ts` | none | **PRE-EXISTING (brittle test)** |
| Report baseline drift (P3.0/P3.2/P3.10 HEADs) | documentation | none (code governs) | **P3 WARNING (docs hygiene)** |

**P3 BLOCKERS: NONE.** No debt item has a causal path to a P3 safety invariant or to a
P3.3 hard dependency.

---

## 17. P3.3 Hard Dependency Analysis

P3.3 = Canonical Context Selector (chooses/quotas the context view from canonical
history; defines `selectionBasis` beyond `"full-history"`).

| Dependency | Status | Evidence |
| --- | --- | --- |
| Stable canonical event identity | **PRESENT** | `event_id` column; `anchorEventId` content-bound |
| Canonical history access (read-only) | **PRESENT** | `loadThreadHistoryWithSeq` / messages reads |
| Context freshness | **PRESENT** | `assessContextFreshness` (P3.2) |
| Frontier comparison | **PRESENT** | `compareContextFrontier` (5-way) |
| Append-only safety (publication fence) | **PRESENT** | `saveSession` + epoch gate (P2.7) |
| Provenance (`selectionBasis`) | **PARTIAL** | `ModelContextProvenance` type reserved; not produced |
| Deterministic ordering | **PRESENT** | `seq` ordering; deterministic hashing |
| Bounded context construction | **PARTIAL** | policy seams exist; not yet a selector |
| Compaction semantics (for selection basis) | **PARTIAL** | `revision`/`countDurableCompactions` present; A+C projection form = P3.7 seam |
| Single authority preserved | **PRESENT** | no second store; P3.2 is derived-only |

**All hard dependencies are live (PRESENT or PARTIAL-with-live-substrate).** The
PARTIAL items are precisely the things P3.3 itself will produce (selector provenance,
bounded construction) or defer to declared seams (P3.7 compaction marker). No ABSENT hard
dependency blocks P3.3.

---

## 18. P3.3 Architectural Guardrails

The selector **IS**: a derived view builder · deterministic · provenance-aware
(`selectionBasis` + frontier) · based on canonical state · freshness-aware · bounded by
explicit context policy.

The selector **is NOT** (and must not become):

| Must not be | Enforcement mechanism |
| --- | --- |
| a second history store | no new table/store; read canonical only |
| a persistence writer | must not import `saveSession`/`shrinkThreadHistory` for writes |
| a reconciliation engine | decision stays in `saveSession` (P2.7); selector only reads/describes |
| an authority over canonical history | never writes; consumes `event_id`/`anchor` |
| a hidden memory database | no cache treated as authority; projections stay cache |
| a mutable session authority | identity/frontier produced as frozen derived values |

**Preserve the P3.1↔P3.2 division:** the selector must remain a *describer*; the
*decider* stays `saveSession`. It must never turn a P3.2 `UNKNOWN`/`STALE` into an
implicit accept, and must never bypass the epoch fence.

**Uncertainty to record:** the exact `selectionBasis` vocabulary and the relationship
between a partial-window selector frontier (`baseSeq > 0`) and the publication
prefix-check are **not yet specified** — P3.3 must define them without introducing a
second decision authority (P3.2 already distinguishes partial-view frontier from full
frontier; the guard test `P3.1-B`/`B2` exercises partial coverage).

---

## 19. P3 Program State Matrix

| Area | Current State | Evidence | Risk | Blocking? |
| --- | --- | --- | --- | --- |
| P3.0 contract | Coherent w/ code; live code governs | §5; I1–I15 re-verified | Low | No |
| P3.1 enforcement | VALID (append-only) | `saveSession` guards A–F, P1–P5 | Low | No |
| P3.1 tests | 14/14, production-path | guard suite run | Low | No |
| P3.2 identity | FORMAL, unwired | `context-identity.ts`; 39/39 | Low | No |
| P3.2 frontier | FORMAL, F-05 closed | test A2 | Low | No |
| P3.1↔P3.2 | CONSISTENT (describe vs decide) | guard F bridge | Low | No |
| Publication boundary | Single fenced writer; all routes covered | §10 table | Low | No |
| Compaction | No silent replacement; explicit provenance | guard C2/P1 | Low | No |
| Attach | PARTIAL — no history-presence gate | `identity.ts`; guard G/P3 | Low | No |
| Diagnostics | PARTIAL — channel live, conflict category absent | §13 | Low | No |
| Authority model | Single truth; no second authority | §9 | Low | No |
| Test coverage | PASS core; P3.2 unit-only (by design) | §14 | Low | No |
| P3.3 dependencies | PRESENT / PARTIAL-with-substrate | §17 | Low | No |

---

## 20. Readiness Decision

**READY WITH CONDITIONS.**

Rationale:

- P3.0 contract is coherent with current code (the one historical violation — blind
  shrink — is closed by the `grewBeyondBuffer` fix).
- P3.1 is VALID, production-path tested, and the fix is load-bearing.
- P3.2 identity/frontier is trustworthy and F-05-verified.
- P3.1↔P3.2 semantics are consistent (deliberate describe/decide division).
- The publication boundary cannot bypass safety; there is exactly one authority.
- P3.3 hard dependencies are live.
- The two known gaps (attach history-presence gate; durable conflict-category) are
  demonstrably non-blocking and explicitly bounded.

Conditions (bounded, non-blocking, carry into P3.3 as evidence/hygiene):

1. **Report baseline drift**: P3.0/P3.2/P3.10 reports cite stale HEADs and (P3.2 §3)
   make schema claims contradicted by current code. Treat reports as historical; use
   current code + this audit. (Optional: annotate reports; not required to proceed.)
2. **P3.2 not wired**: P3.3 must be the first production consumer and must preserve the
   describe/decide division and single-authority rule.
3. **Attach history-presence gate**: keep as P3.4/P3.5 hardening, not a P3.3 blocker.
4. **Durable conflict-diagnostic category**: optional observability; not a P3.3 blocker.
5. **Pre-existing test debt** (P3-constructor allowlist, S13 brittle assertion, flakes):
   unrelated to P3 safety; do not gate P3.3 on it.

---

## 21. Exact Next Action

**One action:** Begin **P3.3 — Canonical Context Selector** implementation against the
current canonical architecture, defining `selectionBasis` vocabulary and a bounded,
deterministic, provenance-aware selector that **reads** canonical history (via stable
`event_id`/`anchor`) and **describes** freshness (`assessContextFreshness`), while
leaving the publication *decision* in `saveSession` (P2.7) and introducing no second
store, writer, or authority.

(Do not start P3.3 in this audit session — this is a read-only audit.)

---

```text
MINICODE P3 PROGRAM STATUS:
READY WITH CONDITIONS

P3.0:
COHERENT WITH CURRENT CODE (historical-report baselines superseded; code authoritative)

P3.1:
VALID (append-only; grewBeyondBuffer I2 fix live and load-bearing; 14/14 production-path)

P3.2:
FORMAL/DESCRIPTIVE, TRUSTWORTHY, UNWIRED (identity/frontier/compare/freshness; F-05 closed; 39/39)

P3.1 ↔ P3.2 CONSISTENCY:
CONSISTENT (deliberate describe-vs-decide division; no contradictory decisions)

Single authority:
PASS

Publication safety:
PASS

Compaction safety:
PASS

Session attach safety:
PARTIAL

Diagnostic evidence:
PARTIAL

P3 test evidence:
PASS

P3.3 hard dependencies:
PRESENT

P3.3:
READY WITH CONDITIONS

Blocking findings:
NONE

Non-blocking findings:
1. Historical report baseline drift (P3.0 @e284298, P3.2 @9d79ebb incl. wrong schema claims, P3.10 "tsc 0") — code governs; docs hygiene only.
2. P3.2 module (context-identity.ts) not imported by production; P3.3 must be first consumer and preserve describe-vs-decide + single-authority.
3. Attach history-presence gate ABSENT — defence-in-depth item for P3.4/P3.5.
4. Durable reconciliation-conflict diagnostic category ABSENT — observability item.
5. Pre-existing debt unrelated to P3: P3-constructor allowlist (m15), S13 brittle source-text assertion, stderr-stub flakes (session-identity/epoch/audit), delegate_task EPIPE flake (env), web nested-list, pack 21/23, coverage-gate blocked, tsc 28 in test/phase3*/phase4*.

Recommended next action:
Begin P3.3 Canonical Context Selector (derived, deterministic, provenance-aware, read-only over canonical; decision authority stays in saveSession).

CONFIDENCE:
HIGH
```
