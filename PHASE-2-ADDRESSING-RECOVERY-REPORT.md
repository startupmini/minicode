# PHASE 2 — CANONICAL ADDRESSING RECOVERY REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `fc00068` (Phase 1)
Artifact: `todo.orig.ts` (416 lines)
Changed source: `src/tools/todo.ts` — **the only file touched**

---

## 1. Artifact comparison

`todo.orig.ts` vs baseline `src/tools/todo.ts` is a **10-hunk** delta, all
addressing. Applied in full:

| change | baseline | artifact |
|---|---|---|
| id→filename mapping | inline regex `[^A-Za-z0-9._-]`→`_`, cap 64, `""`→`default` | `sanitizeSessionPart`, cap 60, `""`→`x` |
| legacy mapping | *absent* | `legacySanitizeTodoId` (the old regex, kept) |
| todo write path | `todoPath` | `todoPath` (canonical) + `legacyTodoPath` |
| plan write path | `planPath` | `planPath` (canonical) + `legacyPlanPath` |
| `deleteTodoFiles` | 2 files | 4 files (canonical + legacy, both kinds) |
| `loadTodos` | one path, `[]` on failure | canonical→legacy loop, `null` on failure |
| read helper | inlined | `readTodoFile` returning `TodoItem[] \| null` |

`git diff` net effect on that one file: **+50 / −9** (confirmed by
`git diff --numstat`).

`git diff --check` emits one line — `warning: in the working copy of
'src/tools/todo.ts', CRLF will be replaced by LF`. That is **pre-existing and
environmental**, not a defect introduced here: `.gitattributes` declares
`*.ts text eol=lf` while `core.autocrlf=true`, so on this Windows checkout every
edited `.ts` file warns and the blob is normalised to LF on commit. It is a
line-ending notice, not a whitespace error or a conflict marker.

## 2. Phase 2 boundary

`todo.orig.ts` contains **zero** occurrences of `taskId`, `ordinal`, `address`,
`resolveTask`, `explicit`, `duplicate`, `TaskStore`, or `synchronizeTasks`, and
its `TodoItem` is `{ content, status, blockedReason? }` with **no id field**.

So the task-identity resolution layer the brief describes in §3/§4 is **not in
this artifact**. It lived in the lost `src/task/normalize.ts` and
`synchronizeTasks` — already classified **Phase 3** in Phase 1 because it needs
`TodoItem.taskId`, which §2 reserves for Phase 3 and §6 forbids importing here.

**Recovered:** canonical *addressing* of durable session state (one canonical
filename + explicit legacy read fallback).
**Deferred:** task *identity* resolution (taskId, ordinal, duplicates, mixed
payloads).

`sanitizeSessionPart` already existed in `src/lib/session-id.ts` (with tests,
and already used by `checkpoint.ts`/`journal.ts`/`shadow-git.ts`), so the
resolver was **reused, not reconstructed**.

## 3. Addressing model

| address | function | used for |
|---|---|---|
| **canonical** | `sanitizeSessionPart(sessionId)` | all writes; first read attempt |
| **legacy** | `legacySanitizeTodoId(sessionId)` (pre-N2 regex) | read fallback + deletion only |

Canonical maps `a/b`→`a-b`, `""`→`x`, cap 60, collapses `..`, strips leading/
trailing `.`/`-`. Legacy maps `a/b`→`a_b`, `""`→`default`, cap 64. The two agree
for any id already matching `[A-Za-z0-9._-]{1,60}` — which is why no existing
test changed behaviour.

## 4. Resolution rules (verified vs deferred)

Per §4, nothing is assumed. Of the eight listed rules:

- **VERIFIED:** legacy fallback is explicit (rule 4, address sense); legacy is
  read-only and never written, so it cannot collide (6); resolution precedes any
  mutation, and a read never creates a file (7); addressing is deterministic
  (8).
- **UNKNOWN → DEFERRED to Phase 3:** explicit taskId precedence (1), no silent
  fallback from an invalid explicit ID (2), duplicate taskId rejection (3),
  per-item classification of mixed payloads (5).

`readTodoFile` returning `null` rather than `[]` is what makes the loop
meaningful: "not at this address" must be distinguishable from "an empty list",
otherwise a wrong-shaped canonical file silently masks a readable legacy one.
That distinction is now pinned by a test.

## 5. TaskStore interaction

**None.** `src/task/model.ts` and `src/task/store.ts` are byte-identical to
`fc00068` (verified with `git diff fc00068 -- src/task`, empty). This phase never
opens `tasks.db`. TaskStore remains the sole authority for task state; the
addressing layer addresses the JSON/plan files only. No scheduler claims, no
graph dependencies, no readiness, no presentation projection.

## 6. Legacy compatibility

A workspace upgraded but never rewritten keeps its pre-N2 files. Those are
still **readable** (test B) and are **cleared on session delete** (test N).
Because `deleteTodoFiles` is called from `persistence.ts::deleteSession`, the
expanded 2→4 path list means plan/todo content can no longer survive as
reachable residual after a session is deleted (Audit #13 chain 28). The reverse
is deliberately *not* done: a legacy file is never rewritten or migrated in
place.

## 7. Regression tests

`test/phase2-addressing.test.ts` — **12 tests, 46 assertions, 0 fail**. Every
category A–J is covered, plus session-delete residual and plan passivity. Each
test owns one `mkdtemp(join(tmpdir(), "minicode-addr-"))` directory and removes
only that absolute path; **0 `readdir(".")`**, no pattern deletes.

| cat | test |
|---|---|
| A | writes land on the canonical address (incl. an id where the two mappings differ) |
| B | a legacy-named file is still readable |
| C | canonical wins when both exist; legacy answers when canonical is absent |
| D | corrupt JSON **and** wrong-shaped canonical both fall through to legacy |
| E | hostile ids (`../../../etc`, `..`, `""`, `....//....`, `a/b/c`) stay inside `.minicode/todos` |
| F | a legacy-only address is never written to |
| G | a read never creates a directory or file |
| H | same id → same address, updated in place, no duplicate file |
| I | legacy state survives a fresh process-style read |
| J | distinct sessions address distinct files, never cross-read |
| — | `deleteTodoFiles` removes both addresses (todo + plan) |
| — | `loadPlan` stays passive: missing plan is `null`, not a throw |

**Regressions checked:** all 8 dependent files still pass — `taskstore` (17),
`phase1-tools` (35), `todo-plan` (2), `task-invariants` (19), `session-id` (2),
`delegate-audit` (17), `mcp-server` (17), `cli-session` (40) = **149 tests,
0 fail.**

## 8. Mutation results

**9 of 9 killed, 0 survivors, 0 needle-misses.** Each mutant ran against the
**in-repo** suite; pristine bytes restored and **SHA-verified** after every
mutant (CRLF normalised for matching, original bytes restored at the end);
children ran with `cwd` = a throwaway temp dir.

| # | mutant | killed by |
|---|---|---|
| N1 | legacy tried before canonical (precedence flipped) | C |
| N2 | legacy fallback removed | B |
| N3 | canonical collapses to the legacy mapping | C |
| N4 | todo writes redirected to legacy | C |
| N5 | plan snapshot redirected to legacy | A |
| N6 | delete leaves legacy todo behind | delete test |
| N7 | delete leaves legacy plan behind | delete test |
| N8 | wrong-shaped canonical masks readable legacy | D |
| N9 | read path never returns content | A |

### Two real test gaps my own campaign exposed

1. **N5 survived first** because the plan assertions only used ids where
   canonical == legacy (`plain-session`), so the write target was unobservable.
   Test A now uses `a/b` and asserts `a-b.md` exists while `a_b.md` does not.
2. **N6 survived first** because only the corrupt-JSON branch was covered, not
   the valid-JSON-wrong-shape branch of `readTodoFile`. Test D now plants
   `{"todos": "bukan array"}` at the canonical address.

Both were fixed in `test/`, not by weakening the mutant. Three earlier
`NEEDLE-MISS` entries were **harness bugs** (CRLF vs LF needles, and a missing
`"` in the template-literal needles) and were reported as such, never as results.

## 9. Verification limitations

`node_modules` **absent**; no install performed.

| check | status |
|---|---|
| **PARSE** | **VERIFIED** — `Bun.Transpiler` on `src/tools/todo.ts` |
| **RUNTIME** | **VERIFIED** — 12/12 new, 149/149 across 8 dependent files |
| **TYPECHECK** | **DEFERRED** — no `tsc` without `node_modules`. `Bun.Transpiler` parses; it does **not** typecheck. |
| **FULL SUITE** | **DEFERRED** — out of scope; 203 pre-existing test files not run |
| MUTATION | **9/9 killed** |

## 10. Safety audit

| check | `src/tools/todo.ts` |
|---|---|
| `rmSync` / `unlink` / `rmdir` / `readdir` / `process.chdir` / `fs.rm` | **0** |
| `rm(` sites | 1 (L117, inside `deleteTodoFiles`) |
| `recursive: true` | 2 — both `mkdir` (pre-existing), **not** deletion |
| destructible paths | 4, all `resolve(cwd, ".minicode", todos\|plans, <sanitised>)` — inside the project tree, non-recursive, `force: true` |
| new destructive surface | **none** — the change only adds 2 more paths inside the same already-bounded directory |
| cwd-root cleanup | none |

Phase 0A guard intact (`assertDeletableTarget` exported, dynamically imported,
1 call site, 0 destructive primitives in `persistence.ts`); Phase 0B
`resolveLocalDbPath` intact; Phase 0C `withBusyRetrySync` +
`loadPresentationEventsWithStats` intact; `src/task/**` unchanged.

**No Phase 3 leakage:** `taskId` occurrences in `todo.ts` = **0**;
`TaskGraph`/`Scheduler`/`readiness` = **0**. Temp/mutation files removed.
`node_modules` still absent.

## 11. Deferred Phase 3 items

1. `TodoItem.taskId` and its propagation.
2. Explicit-vs-legacy task identity resolution; explicit-ID precedence.
3. Invalid explicit ID must not fall back silently.
4. Duplicate taskId rejection.
5. Mixed-payload per-item address classification.
6. `PlanStep.taskId`; taskId-aware plan events.
7. `synchronizeTasks` / `upsertTasks` (deferred in Phase 1 — needs the lost
   `TodoItem.taskId`).
8. Legacy-migration importer (unrecoverable — no artifact).

## 12. Git checkpoint

Commit: **`recovery: restore canonical task addressing`**
Files: `src/tools/todo.ts` (modified), `test/phase2-addressing.test.ts` (new),
`PHASE-2-ADDRESSING-DELTA-MAP.md` (new), `PHASE-2-ADDRESSING-RECOVERY-REPORT.md`
(new). Working tree **CLEAN**. Not pushed (7 ahead).
`D:\git\minicode` untouched; `repo-from-remote` unchanged at `aa76dfb`.
