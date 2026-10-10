# PHASE 5 — TOOL EXECUTION
**Status: SCOPE RATIFIED — BATCH 1 (C1) IMPLEMENTED, REMAINING BATCHES PENDING**

## Purpose

Phase 5 reconciles the independent Phase 5 foundation audit (delivered against
HEAD `7eede05`) with explicit owner decisions, ratifies the missing Tool
Execution contracts, and closes only the verified correctness gaps that the
audit demonstrated. Existing functionality may satisfy a requirement without
new implementation when direct source and test evidence proves that it does.

## Authority hierarchy

- The Phase 5 foundation audit (15-section report, delivered in full before this
  registration) supplies the verified findings F-01…F-10 against HEAD `7eede05`;
  this document ratifies their disposition and is the canonical Phase 5 record.
- `P4_PHASE_CLOSURE_REPORT.md` and `P4_AGENT_LOOP_SCOPE.md` remain in force:
  Phase 4 is closed with documented limitations (incl. P05-tail); Agent Loop
  owns turn orchestration and result incorporation.
- `P3_PHASE_CLOSURE_REPORT.md` and the Session Architecture closure remain in
  force: `P2.7 saveSession` is the canonical publication authority.
- Owner decisions on this registration (verbatim substance):
  - **F-01**: do not permit write concurrency that lacks a demonstrated
    safety contract.
  - **F-03**: prioritize explicit job ownership and session isolation where
    jobs are session-owned.
  - **F-04**: establish consistent dispatch semantics across kernel and
    MCP-server paths, retaining intentional protocol-specific differences.
  - **F-09**: reconcile documentation drift before implementation.
  - Optional Phase 5 composition (audit items beyond the required set):
    deferred unless justified by concrete correctness or reliability needs.
- Current source code and production tests establish implementation reality.
- Historical phase numbering (`PHASE-5*`/`PHASE-6*` = legacy TaskGraph/Scheduler
  program) provides context only and does not override this scope.

## Ratified contracts

### C1 — Write-concurrency safety boundary (F-01)

**Meaning of `writeConcurrency`.** The semaphore capping how many
`isWrite()`-classified calls of one batch run concurrently inside
`parallelExecutor` (`src/policy/executor.ts:68,109-130`). Default is 1
(`LIMITS.EXECUTOR_WRITE_CONCURRENCY`, `src/constants.ts:71`); the session
constructor accepts any finite integer > 0 and floors it
(`src/app/session.ts:133-137`).

**Classification.** `WRITE_TOOLS` = `write_file`, `edit`, `apply_patch`,
`move_file`, `delete_file`; `EXCLUSIVE_TOOLS` = `bash`, `write_memory`,
`forget_memory`, `todo_write` (`executor.ts:9,16`). A mixed write+read step is
always fully sequential in input order (`executor.ts:77-85`) regardless of the
semaphore.

**Existing safety mechanisms (all pre-existing, no new subsystem required).**

| Mechanism | Scope | Evidence |
|---|---|---|
| Mixed write+read → sequential | every batch | `concurrency-same-process.test.ts:199` |
| Write-slot semaphore | all write-classified calls | default-1 serialization pinned at `:281` (bash+edit same file, F-08) |
| Per-file lock (normalized `args.path`) | `WRITE_TOOLS` with a single string `path` argument | same path serializes even at `writeConcurrency: 3` (`:229`); distinct paths overlap safely (`:263`) |
| Abort-aware queue + slot/lock release | all of the above | `executor-abort.test.ts:66` |

**Supported configurations (demonstrated).**

1. `writeConcurrency = 1` (production default): fully supported for every
   toolset — the slot serializes all writes, covering the two tool classes
   that have no per-file lock.
2. `writeConcurrency > 1`: supported **only** when every write-classified call
   in the batch is a single-path `WRITE_TOOL` (`write_file`/`edit`/
   `apply_patch`/`delete_file` — each declares `args.path`). Mechanism-level
   proof exists (`:229`, `:263`).

**Outside the safety boundary.** `writeConcurrency > 1` has **no** safety
contract for batches containing:

- `move_file` — arguments are `from`/`to`, so `getFilePath()` returns null and
  no per-file lock engages; two moves to one destination (or move vs write to
  the same path in a pure-write batch) can race.
- `EXCLUSIVE_TOOLS` — deliberately lockless (`executor.ts:11-15`); their
  exclusivity is the write slot itself. At `writeConcurrency > 1` two `bash`
  calls, or `bash` + `write_memory`, can overlap with no demonstrated safety.

**Required behavior when a configuration exceeds the boundary.** The boundary
must be *enforced, not merely documented*: the production session path must not
silently accept `writeConcurrency > 1` for the general toolset as if it were
safe. The minimal enforcement (clamp to 1, or refuse with a clear error) is an
implementation-batch choice; no new locking subsystem is introduced, because
the audit found no concrete production need for > 1 — only mechanism-level
tests exercise it.

**Implemented enforcement (Batch 1).** Production admission-time classification
in `parallelExecutor` (`src/policy/executor.ts`): a batch whose
write-classified calls are not all path-keyed (`getLockPath` — `WRITE_TOOLS`
with a valid string `args.path`) runs fully sequential, including the
prompt-abort race previously provided only by the write-slot waiters (an
in-flight tool may ignore the signal; `execute()` still rejects immediately).
Batches whose writes are all path-keyed keep the write-slot semaphore +
per-file lock, so the supported `writeConcurrency > 1` configuration
(distinct paths overlap, same path serializes) is preserved — the boundary is
enforced *per batch* rather than by clamping the configuration, which would
have disabled the demonstrated-safe path concurrency. Consequences:
`EXCLUSIVE_TOOLS`, `move_file` (`from`/`to`), and `WRITE_TOOL` calls without a
valid path never overlap each other or path writes at any `writeConcurrency`;
a batch mixing one unkeyed write with path writes serializes the path writes
too (coarse but contract-compliant — C1 defines support only for all-path-
keyed batches). Demonstrated by `test/f01-write-concurrency.test.ts` (six
deterministic gate-based cases, each failing against the pre-Batch-1
executor); `test/extreme.test.ts` "08" was adapted from capping a `bash` batch
at `writeConcurrency` to asserting serialization, because a bash batch is now
serialized by contract.

**Invariant (owner-decided, binding on all future work):**
*No configuration may enable write concurrency that lacks an explicit,
demonstrable safety contract.*

### C2 — Background-job ownership and lifecycle (F-03)

**Current ownership reality.** Background bash jobs live in a process-global
`Map` (`src/tools/bash.ts:81`) with no owner field
(`BackgroundJob`, `bash.ts:68-79`). `bash_output`/`bash_kill` look up by id
only (`bash.ts:367,393`); the not-found error enumerates **all** live job ids
process-wide (`bash.ts:369-372`). Both tools are `INTERNAL_WRITE_TOOLS` +
`NO_PROMPT_TOOLS` (`src/policy/permission.ts:54-61,69`).

**Intended ownership: the session.** A background job is owned by the session
whose `bash` tool spawned it. Session identity is the canonical `sid`
(`src/session/identity.ts`) threaded into the tool context by the composition
root — the same explicit-parameter mechanism the MCP server already uses for
`contextId` (`src/mcp/server.ts:157-169`); no new process-global.

**Who may inspect / wait / cancel.**

| Actor | Inspect (`bash_output`) | Cancel (`bash_kill`) |
|---|---|---|
| Owning session | yes | yes |
| Any other session | no — `job not found` | no — `job not found` |
| Sub-agent | no — tools stripped (`src/tools/task.ts:244-258`), `background:true` rejected (`task.ts:273`) — unchanged | same |
| Host at process exit | `killAllBackgroundJobs()` (`bash.ts:127`, called `cli/setup.ts:2363`) — process hygiene, not a tool surface — unchanged | same |

**Cross-session attempt semantics.** A caller from another session must fail
as `job "…" not found`, and the error must not enumerate ids the caller does
not own (today's process-wide enumeration at `bash.ts:369-372` is the leak to
close).

**Existing isolation that already holds (to preserve, not rebuild).** Current
production topologies run one interactive session per process; the daemon
hosts at most one `CliSession` (`cli/commands/daemon.ts:216-252`); sub-agents
cannot touch job tools at all. The contract makes this explicit and closes the
enumeration leak so it stays true if multi-session-per-process ever lands.

**Non-goal.** The registry is *not* redesigned — no per-session `Map` split is
mandated; an owner tag + ownership check is the required behavior.

### C3 — Dispatch semantics, kernel vs MCP-server (F-04)

**Kernel path** (`vendor/minicore/src/core/executor.ts:40-104`): abort-check →
registry lookup (unknown → error result) → **permission check** (crash →
error result; deny → optional `describeDenial` suffix) → **`validateArgs`** →
`execution:started` → `tool.execute` → `serializeContent` + head/tail
truncation → `execution:completed`.

**MCP-server path** (`src/mcp/server.ts:66-210`): **`validateArgs`** (raw
remote args rejected before anything else) → **permission check** (fresh
`createPermissionHandler` per request; jail + bash-guard live inside `check()`)
→ mutation journal (`persistEffectIntent`, fail-closed without durable intent)
→ `tool.execute` → `persistEffectReceipt` (`committed`) → `capMcpText`;
errors persist a `failed` receipt.

**Shared semantic contract (both paths must uphold).**

1. No tool execution before **both** argument validation and permission
   authorization have succeeded.
2. Mutations require a durable EffectIntent before execute (kernel: session-
   layer evidence wrapper `executeCanonicalInvocation`
   (`src/session/verification.ts:680-785`); MCP: inline journal).
3. All failures surface as `isError` observations; no raw rejection escapes
   the dispatch layer.
4. Jail + bash-guard apply in every mode, including `allow-all`
   (`src/policy/permission.ts:379-496`).

Both paths already satisfy 1–4 (audit-verified; e.g.
`mcp-server.test.ts:213,234,248`, `agent-contract.test.ts:823`).

**Intentional protocol-specific differences (retained, with rationale).**

| Difference | Rationale |
|---|---|
| Order of validate vs permission (kernel: permission-first; MCP: validate-first) | Both precede execute, so safety is identical. Kernel sees raw args for the approval prompt and `describeDenial`; MCP rejects malformed remote input before constructing any permission context. |
| MCP generic denial text vs kernel `describeDenial` | No TTY/approval UI on the MCP surface; scrubbed fixed string. |
| MCP `capMcpText` vs kernel `serializeContent` truncation | Protocol transport capping, not kernel result shaping. |
| Fresh permission handler per MCP request | Stateless server; no session approval state; jail still unconditional. |
| MCP inline journal vs kernel session-layer wrapper | MCP has no kernel turn; the same intent→receipt fail-closed rule is implemented at the only dispatch point it owns. |

**Documentation defect to fix in the implementation batch** (code comment, not
this docs-only batch): `src/mcp/server.ts:82-84` claims validate-before-
permission is "sama seperti jalur REPL" — factually wrong (the kernel does
permission before validation). The comment must state the real contract: both
orders are safe because both gates precede execute; MCP validates first by
protocol choice.

**Invariant (owner-decided):**
*Kernel and MCP-server dispatch must uphold one shared semantic contract;
protocol differences are permitted only when they cannot bypass authorization
or safety checks, and must be documented where they live.*

### C4 — Tool success is not durable publication (P05-tail constraint)

Phase 4 accepted (`P4_PHASE_CLOSURE_REPORT.md` §8, pinned by the `P05-tail`
test): a hard `persistCurrent` failure outside the writer-epoch/refusal guard
path may remain runtime-silent after tool side effects have occurred. The
mutation journal (EffectIntent → Receipt) is the recovery truth.

**Binding on every Phase 5 test and design:** success of a tool, or completion
of a turn, is never asserted as proof of durable canonical publication; tests
observe the journal or the persistence seam. Recovery/retry reasoning is
journal-first and verify-first; never auto-redo. Phase 5 does not reopen or
change P05-tail.

## Scope

Phase 5 will:

1. **Enforce the write-concurrency boundary (C1).** Make the production
   session path reject or clamp `writeConcurrency > 1` (minimal mechanism;
   executor mechanism-level tests remain valid as executor proofs, not as
   supported session configurations). Lock the enforced behavior with tests.
2. **Establish session-owned background jobs (C2).** Add explicit job
   ownership and an ownership check in `bash_output`/`bash_kill`; close the
   cross-session id-enumeration leak; pin with a two-session-same-process
   test. Preserve the sub-agent strip and host-exit cleanup unchanged.
3. **Ratify dispatch semantics in code comments and tests (C3).** Correct the
   false parity comment in `src/mcp/server.ts`; add/confirm tests that both
   dispatch paths reject invalid args and deny unauthorized calls before
   execute (existing tests already cover most rows — reuse, do not duplicate).
4. **Close the verified guard-test gap (F-05).** Add the missing unit suite
   for `assertDeletableTarget` (`src/lib/safe-open.ts:195-251`, live and
   called from `src/session/persistence.ts:3365-3374`): repo root, `""`,
   `"."`, `".."`, drive root, home, `tmpdir()` root, symlink escape, depth-0
   target — fail-closed order of the eleven checks.
5. **Honor C4 in every test written in this phase.**
6. Record an implementation report with validation evidence, limitations, and
   the final Git baseline, mirroring the Phase 3/4 convention.

### Conditional work (deferred unless a concrete need is demonstrated)

- M03 sub-gap: one production-path (`createMinicodeSession` + host executor)
  multi-call batch test (audit F-06; matrix P4 L71 acknowledges the gap).
- `git_commit` concurrency classification (audit F-02): ratified **as-is** —
  not write-classified; a concurrent `git_commit` pair fails on git's own
  `index.lock` as a contained error result. Revisit only on evidence of
  harm.
- Any escalation of `code_run` abort semantics or binary-result truncation —
  see accepted limitations.

### Accepted limitations (documented, not fixed in Phase 5)

- P05-tail persistence swallow (Phase 4 decision, pinned — C4).
- `code_run` abort may leave the sandboxed process alive until the runner
  timeout; workspace is mounted read-write (`src/tools/code_run.ts:75-90`).
- `serializeContent` passes `Uint8Array` through untruncated
  (`executor.ts:123-139`); the only binary tool (`read_image`) self-caps.
  Requirement standing: any future binary-returning tool must self-cap.
- Bash-guard is static analysis; real isolation requires OS/docker sandbox
  (`docs/security-model.md:80`).
- 28 pre-existing `tsc` errors in legacy `test/phase3*`/`test/phase4*` files;
  repo-wide CRLF vs `.gitattributes eol=lf`.

### Explicit non-goals

Phase 5 will not:

- Introduce a new locking subsystem or redesign the executor (C1 enforces a
  boundary; it does not add mechanisms).
- Redesign the background-job registry beyond ownership tagging (C2).
- Force a shared dispatch abstraction between kernel and MCP-server (C3
  documents and tests; it does not unify code paths).
- Modify `vendor/minicore/**`.
- Reopen Phase 3 or Phase 4, or change the P05-tail disposition.
- Own work belonging to Agent Loop (pairing, error taxonomy, budget,
  termination), Session Architecture (publication, writer-epoch, journal),
  Task System (delegate, todo semantics), TaskGraph, or Scheduler.
- Add tools, change permission policy modes, or activate new sandbox
  backends.
- Absorb the deferred optional composition (audit items beyond the required
  set) without separate justification.

## Invariants

* `P2.7 saveSession` remains the canonical publication decision authority;
  derived state never silently becomes authoritative.
* Writer-epoch and run guards remain untouched; canonical-history publication
  safety is preserved.
* Phase 3 closure and Phase 4 closure (including its documented limitations)
  remain in force.
* Task System, TaskGraph, and Scheduler ownership boundaries are unchanged;
  the scheduler authorizes, the agent loop executes.
* Tool success is never treated as proof of durable publication (C4).
* Write concurrency without a demonstrated safety contract is never enabled
  (C1).
* Job access is owner-checked (C2); authorization is never bypassed by
  dispatch-path choice (C3).

## Acceptance criteria

Phase 5 can be declared complete when:

1. Its canonical responsibilities and component ownership are documented and
   unambiguous (this scope document + the ratified contracts).
2. C1: the production session path enforces the write-concurrency boundary
   with tests locking both the enforcement and the preserved executor
   mechanism proofs.
3. C2: background jobs carry explicit ownership; cross-session access fails
   as `job not found` without id enumeration; a two-session-same-process test
   proves isolation; sub-agent and host-exit behaviors are unchanged.
4. C3: the false parity comment is corrected; both dispatch paths are covered
   by tests proving validation and authorization precede execute.
5. F-05: `assertDeletableTarget` has a unit suite covering its eleven
   fail-closed checks.
6. All Phase 5 tests honor C4 (journal/persistence-seam observation, never
   turn-success-as-durability).
7. Relevant existing safety invariants remain intact (full-suite parity with
   the Phase 4 baseline classification: 13 known deterministic/pollution
   failures, no new classes).
8. The implementation report records validation evidence, known limitations,
   and the final Git baseline.
9. No unrelated architecture redesign or unauthorized future-phase work is
   introduced.
