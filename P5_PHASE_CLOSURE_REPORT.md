# P5 PHASE CLOSURE REPORT — Tool Execution

**Verdict: `PHASE 5 CLOSED WITH DOCUMENTED LIMITATIONS`.**

All ratified Phase 5 acceptance criteria are verified against current source,
tests, and committed evidence at the audited commit. No material blocker
remains. Known non-blocking limitations are explicitly recorded below
(§7). Phase 3 and Phase 4 remain closed; neither was reopened.

---

## 1. Executive verdict

Phase 5 (Tool Execution) satisfies its ratified scope
(`P5_TOOL_EXECUTION_SCOPE.md`): the write-concurrency boundary is enforced
(C1/F-01), background jobs carry explicit session ownership (C2/F-03), the
kernel/MCP dispatch contract is ratified in code comments and production-
boundary tests (C3/F-04), and `assertDeletableTarget` has a direct contract
suite covering its eleven fail-closed checks (F-05). Full-suite parity holds
(4503 pass / 23 skip / 13 fail — the 13 failures are name-identical to the
Phase 4 known set, §5). Residual items are documented limitations, not
blockers.

## 2. Actual audited commit and repository state

- Audited commit: `bedd9cc16713e5f59630f240755a3274cc366ee7`
  (`feat: add assertDeletableTarget contract suite for deletion guards
  (P5 F-05)`). Verified: `HEAD == origin/main`, working tree clean.
- Required Phase 5 commits present (all on `main`, in order):
  - `0af53da` — scope ratification (`P5_TOOL_EXECUTION_SCOPE.md`).
  - `82d50c2` — Batch 1, F-01/C1 enforcement + `test/f01-write-concurrency.test.ts`.
  - `02beb09` — Batch 2, F-03/C2 ownership + `test/f03-job-ownership.test.ts`.
  - `0751222` — Batch 3, F-04/C3 comment fix + `test/f04-dispatch-contract.test.ts`.
  - `bedd9cc` — Batch 4, F-05 suite `test/f05-deletable-target.test.ts` + scope notes.
- Files changed by Phase 5 implementation (`0af53da..bedd9cc`): exactly 11 —
  `P5_TOOL_EXECUTION_SCOPE.md`, `cli/setup.ts`, `src/app/tool-layer.ts`,
  `src/mcp/server.ts`, `src/policy/executor.ts`, `src/tools/bash.ts`,
  `test/extreme.test.ts`, and the four `test/f0*.test.ts` files.
  Untouched: `vendor/**`, `src/session/**`, `src/policy/bash-guard.ts`,
  `src/policy/jail.ts`, Task System / TaskGraph / Scheduler.
- No `P5_PHASE_CLOSURE_REPORT.md` existed before this audit; this file is it.

## 3. Ratified objectives and evidence

### F-01 / C1 — Write-concurrency safety (Batch 1, `82d50c2`)

- Enforcement verified in source: `src/policy/executor.ts:108-142` —
  admission-time per-batch classification. A batch containing any
  write-classified call without a lock path (`getLockPath`, `:28` — null for
  `EXCLUSIVE_TOOLS`, `move_file` (`from`/`to`), and `WRITE_TOOLS` without a
  valid string `args.path`) runs fully sequential with prompt-abort race
  semantics; all-path-keyed batches keep the write-slot semaphore + per-file
  lock. The mixed-batch serialization tradeoff is structural (`anyUnkeyedWrite`
  gates the whole batch) and matches the documented statement.
- Behavior, not internals, is tested: six deterministic overlap/serialization
  cases plus the preserved mechanism proof (independent paths still overlap at
  `writeConcurrency: 3`). `test/extreme.test.ts` "08" asserts serialization
  for bash batches by contract.
- Audit runs (this closure): `f01-write-concurrency` + `extreme` +
  `concurrency-same-process` + `executor-abort` = **67 pass / 0 fail**.

### F-03 / C2 — Background-job ownership (Batch 2, `02beb09`)

- Ownership verified in source: `BackgroundJob.ownerSid` (`src/tools/bash.ts:85`),
  strict-equality lookup `ownedJob` (`:94-96`), owner-scoped enumeration
  `liveOwnedIds` (`:103-104`), fail-closed `createBashJobTools` (`:458-468`).
  Foreign/unknown ids fail byte-identically as `job "…" not found`.
- Wiring verified end to end: `setupToolLayer(…, jobOwnerSid?)` rebinds by name
  after scope filters, before `withEvidence` (`src/app/tool-layer.ts:42-54`);
  `cli/setup.ts:1332-1345` passes the canonical P2.1 `sessionId` positionally;
  the MCP server rebinds `tools[i]` + `byName` with its per-instance
  `mcpContextId` (`src/mcp/server.ts:325-334`). Sub-agent strip
  (`src/tools/task.ts:262-273`) and process-exit `killAllBackgroundJobs()`
  unchanged. The process-global cap (`LIMITS.BASH_BACKGROUND_MAX_JOBS`) is
  retained and documented as a limitation.
- Audit run (this closure): `f03-job-ownership.test.ts` = **9 pass / 0 fail**
  (same-session, cross-session inspect/kill denial, own-ids-only enumeration,
  cross-owner host cleanup, default-export compatibility, fail-closed empty
  owner, tool-layer wiring, two real `createCliSession` instances).

### F-04 / C3 — Dispatch contract (Batch 3, `0751222`)

- Comment fix verified in place: `src/mcp/server.ts:83-90` states the real
  contract (both gates precede execute; order difference intentional), no
  longer the false "sama seperti jalur REPL" claim. No dispatch reordering.
- Gate order verified structurally: kernel registry → permission → validate →
  execute; MCP validate → permission (fresh handler) → durable-EffectIntent
  fail-closed → execute. Jail + `.minicode` owned-state gates run before mode
  dispatch (`src/policy/permission.ts:379-480`); the `allow-all` branch still
  applies full `bashDenyReason` to `bash` (`:483-496`). Protocol differences
  (order, denial text shape, truncation, per-request handler, inline journal)
  are documented in the scope table and asserted as intentional by tests.
- Audit run (this closure): `f04-dispatch-contract.test.ts` = **10 pass /
  0 fail** over the real boundaries (vendor `runCall` + live permission
  handlers; spawned `mcp serve` processes): jail-deny no-side-effect both
  paths, invalid-args both paths, allow-all bash-guard both paths (kernel
  `bash-guard:` reason vs MCP scrubbed `[denied]` + untouched canary),
  throw→`isError` both paths, broken-journal fail-closed + on-disk
  intent/terminal records.

### F-05 — Filesystem safety contract tests (Batch 4, `bedd9cc`)

- Suite exists and runs: `test/f05-deletable-target.test.ts`, **15 pass /
  0 fail** (audit run, this closure). It exercises the live helper
  (`src/lib/safe-open.ts:195-251`) against isolated `mkdtemp` fixtures —
  the same helper the production session-cleanup path calls
  (`src/session/persistence.ts:3370`).
- All eleven documented checks are covered in fail-closed order; checks 9 and
  11 (shadowed by 5/6/8/10 — verified against the implementation, which never
  lets their conditions survive the earlier checks) are honestly labeled as
  locked *guarantees*, not direct checks. Acceptance cases: recursive child
  in production shape (`.minicode/checkpoints/<sid>`), non-recursive child,
  missing-but-in-root target, whitespace trim, internal symlink.
- Failure classification: every rejection asserts `Error` + `delete: ` prefix
  + expected memo, separating contract failures from accidental exceptions.
- Cleanup safety verified by inspection: `rmSync` touches only test-created
  `mkdtemp` roots; `homedir()`/`tmpdir()`/drive roots are passed as *targets*
  (rejected), never deleted; `process.chdir` is restored in `finally`.
- Symlink tests follow the repo `canSymlink()` early-return skip pattern.
- No production change; no contract expansion.

## 4. Test-to-acceptance-criterion mapping

| Criterion | Test evidence (all re-run in this audit) |
|---|---|
| C1 enforcement + preserved mechanisms | `f01-write-concurrency` (6), `extreme`, `concurrency-same-process`, `executor-abort` — 67/0 |
| C2 ownership + isolation | `f03-job-ownership` (9) — 9/0 |
| C3 gates-before-execute, both paths | `f04-dispatch-contract` (10) — 10/0 |
| F-05 eleven checks | `f05-deletable-target` (15) — 15/0 |
| C4 (no turn-success-as-durability) | New suites observe helper/dispatch/journal seams only; `P05-tail` still red (pinned) |
| Full-suite parity | 4503/23/13; 13 names identical to P4 set (§5) |
| Cross-phase behavior | Session identity/epoch/audit files green in isolation 39/0 |

New-test arithmetic cross-checks: 6 + 9 + 10 + 15 = 40; baselines
4463 → 4488 (+25) → 4503 (+15). Exact.

## 5. Full-suite comparison against documented baselines

- Reference points: Phase 4 baseline 4463/23/13 → Batch 3 `0751222`
  4488/23/13 → Batch 4 `bedd9cc` 4503/23/13 (1096 s detached run at the
  audited commit, clean tree; log retained from the Batch 4 validation and
  re-analyzed here — no repo change since).
- The 13 failures are **name-identical** to the `P4_PHASE_CLOSURE_REPORT.md`
  §6 classification (not merely the same count): 2 deterministic doc-content
  (`integritas encoding berkas > tidak ada U+FFFD`, `web ssg > docs tanpa
  nested list`) + 11 pollution-window (`audit: manifes korup`, `P2.1`
  single-write, `P2.1 semua path turunan`, `P2.2 alias`, `P2.2 komposisi`,
  `P4-E04`, `P03-A`, `P03-B`, `P05-tail`, `P4-E09`, `P4-M12`).
- Pollution-window claim re-verified at this commit: the owning files
  (`session-identity`, `session-epoch`, `session-audit`) run **39 pass /
  0 fail** in isolation. `P05-tail` failing in the full suite is the *pinned
  accepted limitation*, preserved — not fixed, not reopened.
- Static envelopes: `tsc --noEmit` = **28 errors** (documented pre-existing
  legacy `test/phase3*`/`test/phase4*` debt); biome on all Phase-5-touched
  files = 1 finding (`cli/setup.ts:3:1 organizeImports`), proven pre-existing
  (import block byte-identical to pre-Phase-5 `0af53da`; Batch 2 touched only
  the call site at ~1330). Repo-wide lint/CRLF debt unchanged.

## 6. Cross-phase invariant review

- `P2.7 saveSession` canonical publication authority: no Phase 5 diff touches
  `src/session/**`; publication paths structurally untouched.
- Writer-epoch / run guards, append-only history, derived-state rules:
  untouched (same file-list evidence); the previously red `P2.1`/`P2.2`/
  epoch tests are green in isolation, unchanged from P4 classification.
- Phase 3 (`P3_PHASE_CLOSURE_REPORT.md`: CLOSED WITH DOCUMENTED LIMITATIONS)
  and Phase 4 (`P4_PHASE_CLOSURE_REPORT.md`: CLOSED WITH DOCUMENTED
  LIMITATIONS) remain in force; no reopening condition from P4 §12 is met.
- Task System / TaskGraph / Scheduler ownership: untouched.
- P05-tail disposition: unchanged and still pinned red.
- C4 (tool success ≠ durable publication): honored by every Phase 5 test.
- Scope discipline held: no new locking subsystem, no registry redesign, no
  `git_commit` reclassification, no `code_run`/binary expansion, no new
  tools/permissions/sandboxes, no `vendor/` edits, no future-phase work.

## 7. Accepted limitations and deferred work

Inherited (unchanged): P05-tail swallow; 28 tsc errors; repo-wide lint/CRLF
debt; `code_run` abort process-lifetime; `serializeContent` binary
passthrough; static-analysis bash-guard; full-suite `stderr`-wrapper
pollution mechanism; doc-content U+FFFD/nested-list failures.

Phase 5 additions (all documented in scope or tests):

- Background-job cap stays process-global (count visible, never ids/output).
- Shadowed checks 9/11 in `assertDeletableTarget` (guarantees locked by tests).
- **Windows+Bun diagnostic**: `realpath()` strips drive-root trailing
  separators (`"D:\\"` → `"D:"`, independently re-probed in this audit), so
  check 3's dedicated message never fires there; drive roots stay refused
  fail-closed via the cwd/outside-root checks. Diagnostic-order only, no
  deletion-safety hole; production unchanged by decision.

Deferred (untouched, per scope): M03 production-path multi-call batch test,
`git_commit` classification (ratified as-is), `code_run`/binary escalation,
optional composition items.

## 8. Remaining acceptance gaps

None. Every ratified criterion (§3) has direct source + test evidence verified
in this audit. The two candidate findings examined (shadowed checks 9/11;
Windows/Bun check-3 message) were determined to be non-blocking: guarantees
hold, behavior is fail-closed, and both are pinned by tests and documented.

## 9. Git and delivery status

- Branch `main`; `HEAD == origin/main` at `bedd9cc`; tree clean at audit start.
- This report is the one necessary documentation update (mission §7 requires
  it; scope criterion 8 requires the recorded implementation report). It is
  committed as a docs-only closure commit; no production or test file is
  altered by it.

## 10. Explicit closure decision

**`PHASE 5 CLOSED WITH DOCUMENTED LIMITATIONS`.**

Rationale: all nine scope acceptance criteria are met with evidence gathered
first-hand in this audit (not inherited from batch reports); the full suite
shows exact parity with the classified Phase 4 baseline; cross-phase
invariants are preserved by construction (file-list) and by behavior
(isolation re-runs); limitations are recorded, not hidden. Reopen only on a
demonstrated contract violation with reproducing evidence, or on a production
change to the touched dispatch/concurrency/ownership paths requiring
re-verification.
