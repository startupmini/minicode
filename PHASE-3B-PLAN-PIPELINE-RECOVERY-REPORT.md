# PHASE 3B — CANONICAL TASK PLAN PIPELINE RECOVERY REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `a616ce8` (Phase 3A)
Commit message: `recovery: restore canonical task plan pipeline`

---

## THE MISSING BOUNDARY — read this first

**The pipeline could not be connected end-to-end, and that is a finding, not an
omission.**

`TaskStore` has **ZERO production consumers**: nothing outside `src/task/`
imports it, and nothing in production writes declared todos to SQLite. So the
target chain

```
TaskStore authoritative snapshot  ->  PlanStep.taskId  ->  payloadVersion=2
```

has no first half in production. The write that would create that snapshot is
the lost `synchronizeTasks` wiring, and **the surviving evidence does not say
which component owned that write, nor its ordering relative to plan
publication** (the store must be written *before* the plan is published for the
plan to carry ids, but nothing states this). Creating it would be both new
execution behaviour and fabrication.

Per the brief's own instruction, that boundary is **reported, not invented**.
What *is* implemented is everything downstream of it: the contract, the DI seam,
and the authority boundary — all provable, with production behaviour unchanged.

## 1. Forensic inventory

| Site | Classification |
|---|---|
| `planFromTodos` — adapter.ts:344, reads `args.todos` via `normalizeTodos` | **VERIFIED CURRENT SOURCE** |
| `stepId: String(i + 1)` — adapter.ts:358 | **VERIFIED CURRENT SOURCE** — purely positional identity |
| `plan.updated` emitted — adapter.ts:705 (`todo_write` success) and :1007 (`notePlanReconciled`) | **VERIFIED CURRENT SOURCE** — two sites |
| `PlanStep { stepId, title?, status }` — events.ts:257 | **VERIFIED** — no `taskId`, no `ordinal` |
| `PlanUpdatedEvent` — events.ts:263 | **VERIFIED** — no `payloadVersion` |
| `taskId` — 42 occurrences | **VERIFIED: 100% inside `src/task/`, zero in `src/presentation/`** |
| `payloadVersion` | **VERIFIED: never emitted anywhere** |
| `stepId: currentStep` on `tool.started` (adapter.ts:622/633) | **VERIFIED** — a separate numeric counter, *not* plan stepId |
| `notePlanReconciled` fed by `reconcileCompletionEvidence` (setup.ts:1390) | **VERIFIED** — also payload-based, not store-based |
| `plan.updated` consumers: reducer.ts:625, projection.ts:479, ACP | **VERIFIED** |
| `cwd` in scope at adapter construction (setup.ts:478, used at :895) | **VERIFIED** — plumbing is available |
| DI precedent `...(contentStore ? { contentStore } : {})` | **VERIFIED** — established pattern |
| `TaskIdentityProvider` | **UNKNOWN / DEFERRED** — no surviving source; designed against the DI precedent |

## 2. Current pipeline (as found)

```
model calls todo_write(args.todos)
  -> executor
  -> adapter sub("execution:completed")  [todo_write && !isError]
  -> planFromTodos(call.args)           <- tool ARGS, not TaskStore
  -> normalizeTodos()                   <- domain normaliser, no ids
  -> steps[] { stepId: String(i+1) }    <- POSITIONAL identity
  -> publish plan.updated (no payloadVersion)
```

Second, parallel path: `reconcileCompletionEvidence` -> `notePlanReconciled` ->
`planFromTodos({todos})` -> same positional plan.

## 3. Authority map

| Concern | Owner (before) | Owner (after 3B) |
|---|---|---|
| task identity allocation | nobody (positional) | **TaskStore** — unchanged, still sole allocator |
| canonical `taskId` in a plan | did not exist | **TaskStore via injected provider** |
| positional `stepId` | adapter | adapter (unchanged, documented non-canonical) |
| plan status derivation | adapter | adapter (unchanged) |
| step status mapping | adapter | adapter (unchanged) |
| resolving a plan step's identity | n/a | **provider only** — the adapter *cannot* |

The adapter contains **no `t${` sequence at all**: it is structurally incapable
of minting a task id, so positional identity cannot reappear through it. Verified
by test 2 and mutation-killed by R1/R2.

## 4. Reconstructed vs inferred vs unknown

| element | label |
|---|---|
| `PlanStep.taskId` / `.ordinal`, `PlanUpdatedEvent.payloadVersion` field shapes | **INFERRED** — additive optional fields; no surviving artifact defines them |
| `TaskIdentityProvider` signature | **INFERRED** — designed against the `contentStore?` / `turnSummaryProvider` DI precedent |
| `payloadVersion === 2` ⟺ total resolution | **INFERRED** — the design target; makes the flag truthful |
| `stepId` retained, positional, explicitly non-canonical | **INFERRED** (design-locked: "stepId = compatibility alias only") |
| who writes TaskStore in production | **UNKNOWN — NOT IMPLEMENTED** |
| plan-write ordering | **UNKNOWN — NOT IMPLEMENTED** |
| any pre-existing v2 event on disk | **UNKNOWN** — nothing emits v2 today |

## 5. Files changed

| file | change |
|---|---|
| `src/presentation/events.ts` | **+28/-0** — `PlanStep.taskId?`, `PlanStep.ordinal?`, `PlanUpdatedEvent.payloadVersion?`; all optional/additive |
| `src/presentation/adapter.ts` | **+85/-5** — `TaskIdentityProvider` type, `taskIdentityProvider?` opt, `planFromTodos` takes the owner session, canonical resolution, `payloadVersion` at both sites |
| `test/phase3b-plan-pipeline.test.ts` | **new** — 10 tests / 56 assertions |

**Additive schema note:** both new event fields are optional, so durable
`plan.updated` rows written before this change carry neither and still pass
Phase 0C's `isValidEventShape` gate (`persistence.ts:284`, which only checks
`planId`, `status` and that `steps` is an array). Replay is unaffected.

## 6. Tests — `test/phase3b-plan-pipeline.test.ts`

Hermetic fake bus, no network, no API key. 10 tests, 56 assertions, 0 fail.

| # | proves |
|---|---|
| 1 | taskId comes from a **real TaskStore**; every id is `isTaskId`-valid; the adapter mints nothing |
| 2 | no provider ⇒ no `taskId`, no `ordinal`, no `payloadVersion`; payload contains no `t<n>` at all |
| 3 | taskId stable across 3 repeated publications |
| 4 | reordering changes `ordinal` and `stepId` but **never** `taskId`; no id lost or duplicated |
| 5 | `payloadVersion: 2` **only** on total resolution; partial ⇒ no v2 and no half-attached ids |
| 6 | `stepId` is never mirrored from `taskId` (`"1"` ≠ `"t1"`) |
| 7 | wrong length / throws / `undefined` / empty strings / non-strings ⇒ legacy plan, never a lying v2 |
| 8 | empty, non-array, and blank-content declarations publish **no** plan |
| 9 | plan status derivation and step status mapping unchanged (`in_progress`→`active`, all-completed→`completed`) |
| 10 | the **second** emission site (`todo_write`) obeys the identical contract, canonical and legacy |

**Regression sweep: 161 tests across 10 dependent files, 0 fail** —
`presentation-events` 32, `presentation-store` 34, `presentation-expand` 7,
`presentation-subagent` 12, `task-invariants` 19, `phase3b` 10, `phase3a` 11,
`taskstore` 17, `phase2-addressing` 12, `persistence-rewrite` 7.

**No restart or reorder E2E is claimed here** — per the brief those belong to
Phase 3C. Test 4 reorders within one process and does not cross a persistence
boundary.

## 7. Mutation — 9/9 killed, 0 survivors, 0 equivalent

Every mutant ran against the in-repo suite; pristine bytes restored and
**SHA-verified** per mutant; children run with `cwd` = a throwaway temp dir.

| # | mutant | killed by |
|---|---|---|
| R1 | TaskStore lookup bypassed (provider never consulted) | 1 |
| R2 | identity replaced by a **positional allocator** (adapter mints `t<n>`) | 4 |
| R3 | `payloadVersion` 2 → 1 | 10 |
| R4 | `payloadVersion` always emitted (claims v2 while positional) | 10 |
| R5 | legacy `stepId` mutated **into** the canonical path (mirrored) | 4 |
| R6 | identity mapping altered (ids attached to wrong steps) | 1 |
| R7 | totality requirement dropped (partial claims v2) | 5 |
| R8 | task collection reordered after identity attached | 1 |
| R9 | length check removed (misalignment accepted) | 7 |

**Two survivors in the first run were harness bugs, not equivalent mutants.** R3
and R4 initially rewrote only the *first* of the two `payloadVersion` sites (the
`todo_write` one) because `String.replace` is not global, while my tests only
drove `notePlanReconciled`. Rather than accept them, I added test 10 to cover the
second emission site; both were then killed legitimately. No equivalent mutant
was forced.

## 8. Deferred validation

`node_modules` **absent**; no install performed.

| check | result |
|---|---|
| PARSE | **VERIFIED** — `Bun.Transpiler` on `events.ts` + `adapter.ts` |
| RUNTIME | **VERIFIED** — 10/10 new; 161/161 across 10 dependent files |
| TYPECHECK | **DEFERRED** — no `tsc` without `node_modules`. `Bun.Transpiler` parses; it does **not** typecheck. |
| FULL SUITE | **DEFERRED** — 200+ pre-existing test files not run. Focused green does **not** imply suite health. |
| MUTATION | 9/9 killed |

## 9. Compatibility behaviour

- **Default path is byte-identical to pre-3B.** No provider is injected in
  production, so plans still carry positional `stepId` and no `payloadVersion`.
  Proven by tests 2 and 10.
- **Old durable events are unaffected** — both new fields are optional.
- **`stepId` is preserved verbatim** for projection, reducer and ACP; it is
  *documented* as non-canonical rather than removed or mirrored, per the design
  lock.
- **`payloadVersion === 2` is a truthful claim** by construction: it is emitted
  only on total resolution, so a v2 event provably contains no positional
  identity. A misbehaving provider degrades to the legacy plan instead.
- **ACP semantics untouched.**

## 10. Safety audit

`rm` / `rmSync` / `fs.rm` / `unlink` / `rmdir` / `recursive` / `readdir` /
`process.cwd` / `process.chdir` / `homedir` / `homeDir` / `resolveDbPath` /
TaskGraph / Scheduler / readiness: **0 in both changed source files.** The two
hits in the test file (`TaskGraph`, `Scheduler`) are verified header comments.
No new destructive surface, no global task-state fallback, no cwd-root cleanup,
temp/mutation files removed.

## 11. Could NOT be proven

1. **Who wrote TaskStore in production, and when.** No surviving source. The
   `todo_write` → TaskStore write and its ordering relative to plan publication
   are **not implemented**.
2. **The production pipeline remains unwired** — no `taskIdentityProvider` is
   injected in `cli/setup.ts`, because doing so without the store write would
   read an empty snapshot and silently produce positional plans anyway.
3. **`TaskIdentityProvider`'s real signature** — no artifact; inferred from the
   existing DI precedent.
4. **`payloadVersion` field shape** — inferred; the design target fixes the
   value `2` but no source defines the field.
5. **Whether any pre-wipe `plan.updated` v2 event exists on disk.** Nothing emits
   v2 today; the historical `sessions.db.snapshot` was not parsed for this.
6. **The `titleKey` re-attach mechanism** — in the design docs, absent from the
   artifact's schema; not invented.
7. **Type correctness** — deferred, as above.

## 12. Deferred to Phase 3B-follow-on / 3C

1. Owning and wiring the `todo_write` → TaskStore write (needs the decision above).
2. Injecting a real `taskIdentityProvider` in `cli/setup.ts` (possible: `cwd` is
   in scope at :994).
3. Restart/reorder E2E across the persistence boundary — Phase 3C.
4. `synchronizeTasks` / `upsertTasks` D7 retain + order renormalisation
   (deferred since Phase 1).
5. `PlanStep.stepId` removal or mirroring — only once all six consumers are
   migrated.
6. ACP protocol changes — out of scope by instruction.

## 13. Git checkpoint

Commit: **`recovery: restore canonical task plan pipeline`**
(The SHA is not self-cited here: amending the commit to include this report
changes it. Verify with `git log -1 --pretty=format:'%h %s'`.)
Working tree **CLEAN** after commit. Not pushed (9 ahead of `origin/main`).
`D:\git\minicode` untouched. `repo-from-remote` unchanged at `aa76dfb`.
