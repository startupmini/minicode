# FULL LEGACY → CANONICAL MIGRATION REPORT

Status: **MIGRATION NOT COMPLETE** (all agent-executable phases done; OpenCode UI
cutover + archive/delete are owner gates — §22). No force-push, no reset, no MIR,
no `git clean`, no blob edits, no deletion performed. Legacy tree never modified
except zero writes (read-only forensics + one authorized file copy OUT of it).

## 1. Executive Summary

Code migration is complete and pushed: canonical `main` advanced
`e284298 → 4748b19 → dae5c7e`, P3.2 landed byte-identical from the legacy line, M1
proven already-canonical (not duplicated), pre-existing staged P3 program work
preserved verbatim, and `origin` cut over from the in-legacy-tree local path to
GitHub (`aa76dfb..dae5c7e`, fast-forward, verified `HEAD == origin/main ==
GitHub main`). Canonical git no longer references `D:\recover\...` anywhere.
Full suite in canonical: 4367 tests, 4336 pass / 8 fail / 1 error (run 1);
P3.2 39/39 green post-commit. The 8+1 are pre-existing debt (P3.1 guard gap,
P-runtime allowlist, env-flaky CLI classes) — zero migration-caused failures.
What remains is user-visible, not code: OpenCode Desktop still binds live sessions
to the legacy path (cutover = close legacy sessions + open `D:\git\minicode` in the
UI; profile backed up with hashes), then archive, then owner-gated deletion.

## 2. Initial State

- Canonical `D:\git\minicode`: HEAD `e284298`, main, origin = local path
  `D:\recover\minicode-20260928\repo-from-remote`, 778 tracked files, 5 staged
  additions (2793 ins, 0 del), otherwise clean. Index preserved, never reset.
- Legacy `.../reconstruction`: independent clone @ `9d79ebb` + uncommitted M1 +
  untracked P3.2/audit docs; later branched `p3.2-context-identity` (3 commits,
  pushed) — worktree clean thereafter. No legacy development run from it during
  migration (freeze honored; legacy touched only by reads + file copy OUT).
- Remote `repo-from-remote`: non-bare, HEAD `e284298`, tree clean, own origin =
  GitHub URL, 75 commits ahead of its GitHub tracking ref.
- GitHub `main`: `aa76dfb` (verified `git ls-remote`, read-only).
- OpenCode: live sessions bound to legacy (`home.selection.directory` + handoff +
  blobs updated audit-day).

## 3. Canonical State

HEAD `dae5c7e` (`feat: P3.2 ...`), parent `4748b19` (`docs: preserve P3.0/P3.1/P3.10
...`), parent `e284298`. Tree clean (`status -sb`: `## main...origin/main`, no
markers). 781 tracked files (778 + 3 P3.2). origin = GitHub; `.git/config` contains
zero legacy-path references. Full gates: §19.

## 4. Legacy State

Unchanged by migration (frozen): branch `p3.2-context-identity` @ `4d51ca7`
(= remote copy, verified), main still `9d79ebb`, worktree clean, origin still the
local path (its own cutover is archive-scope, not needed for canonical operation).
`.minicode` live traces remain as historical execution evidence. No code deleted,
moved, or rewritten.

## 5. Remote Topology

Before: `canonical → origin → repo-from-remote (inside legacy tree) → (stale) GitHub`.
`git ls-remote` GitHub main = `aa76dfb`; ancestry checks (local objects, read-only):
GitHub-SHA ancestor of canonical ✓, legacy-HEAD ancestor of canonical ✓ →
classification **CANONICAL AHEAD** (no STOP condition; push is fast-forward).
After: `canonical → origin → GitHub startupmini/minicode` @ `dae5c7e`;
`HEAD == origin/main == GitHub main` (triple-verified: rev-parse ×2 + ls-remote).
No force used. Observed (untouched, owner to confirm): GitHub also hosts branch
`cline/0dbf2` — not created by this migration.

## 6. Work Inventory

- P1-M1..M16 + P2.10–2.12: committed in canonical (102 canonical-only files). KEEP.
- M1 correlator: committed+evolved in canonical (allocator/test byte-identical;
  event/journal passthrough present with identical structure). DO NOT DUPLICATE.
- P3.2 (module+tests+report): existed only in legacy → migrated byte-identical
  (SHA 6CAED82B/6E18B747/2F94F437 prefixes match on both sides).
- 5 staged P3.x files: preserved verbatim as commit `4748b19` (provenance in message).
- P3.1 production gap: guard test expects `SessionAttachRefusedError`,
  `assessHistoryPublication`, `sessionHasHistory`, `CliSession.isReconciliationConflict`
  — none exist in tree (`src/session/identity.ts` has sibling infra only). Deterministic
  red (SyntaxError + 0/1 fail), pre-existing staged state, NOT migration-caused.
- P-runtime allowlist gap: `src/runtime/dispatch.ts: createRecoveryEngine` violates
  `m15` owners map (committed files both sides) — pre-existing canonical debt.

## 7. Migration Manifest

- CANONICAL KEEP: all of `e284298` + commit `4748b19` (P3 program artifacts).
- LEGACY MIGRATE: `src/session/context-identity.ts`, `test/context-identity.test.ts`,
  `P3.2_CONTEXT_IDENTITY_FRONTIER_REPORT.md` — DONE, hash-verified.
- CANONICAL ALREADY HAS: M1 all forms, P1/P2, closure doc — NOT copied.
- LEGACY REDUNDANT: `src/runtime/`, `test/execution-id.test.ts`, M1 hunks — retained
  in archive only.
- ARCHIVE: legacy tree as-is (post-cutover rename; retention per owner).
- DISCARD (never copy): journals, cwd history, empty sessions.db, caches,
  minicode-old, parseout/28-09 artifacts, md headers (history stays in place).
- OWNER DECISION: M0 baseline report, closure-doc copy, live session history fate,
  archive retention, deletion execution, P3.1 gap implementation, allowlist debt.

## 8. P3.2 Migration

No filename conflicts (3× Test-Path False pre-copy). `Copy-Item` legacy→canonical +
SHA-256 match on all three. Focused gates in canonical: P3.2+M1+boundary+arch-map+
writer-inventory **59/59**; tsc: 37 errors, **0 mentioning context-identity** (all
test/phase3|phase4 + staged guard — pre-existing class); biome clean (from P3.2
session, files unmodified since). Post-commit re-run: 39/39 green. Only the verified
artifacts moved — never the whole tree.

## 9. M1 Reconciliation

Per-hunk verdict: allocator + test byte-identical → already landed; events Base 5
optional fields + ADR-002 block present in canonical → already landed; journal
Record/IntentInput/terminal passthrough (15 field hits, 5 markers, live spreads at
:532/:610) → already landed. **Zero deltas migrated; legacy M1 = redundant**
(retained in archive until final gate). Journal/recovery/epoch suites green in
canonical (99/99 isolated).

## 10. Canonical Staged Work

All 5 files inspected via `git show :path` (headers reference HEAD `e284298`,
authored on the canonical P3 line). Classified: 4 docs INTENTIONAL+REQUIRED;
guard test REQUIRED but BLOCKED (production API absent → §22). None reset, none
lost, none edited — committed verbatim as `4748b19` with provenance + known-red
note in the message. Secret scan: clean. `diff --check`: clean.

## 11. Remote Cutover

Push `aa76dfb..dae5c7e main→main` to GitHub: exit 0, fast-forward, no force.
`remote set-url origin → https://github.com/startupmini/minicode.git` (config change
only after successful push). `fetch`: tracking ref updated (`e284298..dae5c7e`),
`## main...origin/main` in sync. `repo-from-remote` never written by this migration
(its HEAD/tree untouched; it simply stopped being anyone's origin).

## 12. OpenCode Session Cutover

Status: PREPARED, NOT EXECUTED (requires GUI — no blob was hand-edited, per strategy
close+reopen over re-keying). Profile backed up first (§21: 25 files + hashes at
`C:\Users\xmlze\.local\share\opencode\pre-migration-backup-2026-10-08\`; app files
unmodified). Owner steps: (1) finish/close legacy-bound sessions (or leave idle —
no new work there); (2) open `D:\git\minicode` in OpenCode Desktop; (3) confirm a new
session's tool shell reports cwd `D:\git\minicode` and git root/HEAD/origin accordingly;
(4) do not continue the legacy session for development.

## 13. Workspace Authority Cutover

Same gate as §12 (UI act). Verification criteria for the owner session:
`home.selection.directory == D:\git\minicode`, `handoff.dir` not legacy, no live
session keyed under the legacy base64 workspace key, tool shell cwd canonical.
Recorded pre-cutover values (for post comparison): home+ handoff = legacy path;
legacy blob sessions `ses_f08c93…`, `ses_eea0b5…` (muse-spark family, updated cutover-day).

## 14. Brief/Handoff Refresh

Current truth (for all future briefs): canonical workspace `D:\git\minicode`;
HEAD `dae5c7e`; branch `main`; remote = GitHub URL (in sync); legacy = frozen,
non-authoritative, pending archive. Historical reports keep old paths (no history
rewrite). This report is the refreshed handoff; stale `9d79ebb`/legacy-cwd briefs
must not be reused for new work.

## 15. Negative Tests

Pre-delete negative test (canonical works with legacy unavailable) is an owner-gate
consequence of §12–§13, not yet run (legacy still present and referenced by legacy
clone's own config only). Git-level independence already proven: canonical
fetch/push/status/ls-remote all succeed via GitHub with zero legacy-path references
in its config (§5) — the only remaining legacy dependency is the OpenCode UI binding.

## 16. Canonical-Only Verification

`git ls-files` = 781 tracked; P3.2 present; M1 single-sourced; no file exists in both
an authoritative and a duplicate-authoritative form (redundant legacy copies live
outside canonical). Layer-boundary suite green (ui-boundary 5/5 in canonical run).
No source-of-truth duplication introduced (pure additive module, zero imports from
production code — same as P3.2 session proof).

## 17. Legacy Archive

NOT EXECUTED (gated on §12–§15 owner verification + retention decision). Target form
per brief: rename to `reconstruction.ARCHIVED`, keep read-only, exclude
`parseout/`/forensic artifacts/other projects from any destructive scope. Current
state documented instead: frozen, clean, branched, pushed.

## 18. Legacy Deletion

NOT EXECUTED — separate final gate, owner-approved retention required (§22). No
deletion command issued. Pre-deletion checklist recorded in §22 (hashes, manifest,
gates, remote, UI state, negative test).

## 19. Regression Results

- Focused P3.2 (canonical, post-commit): 39/39.
- Architecture/session/identity/boundary set: 59/59 (incl. writer-inventory).
- Journal/recovery/epoch: 99/99 isolated.
- Full suite run 1 (pre-commit, final file set): 296 files / 4367 tests →
  **4336 pass / 23 skip / 8 fail / 1 error** (1156 s).
- Full suite run 2 (same tree): 4314 / 30 fail / 22 errors (load-flake storm in
  CLI-subprocess classes; zero P3.2 files in any fail list; cli/journal/epoch
  subsets re-verified green in isolation: 113/114 with the single deterministic
  P-runtime allowlist fail, plus 99/99).
- Deterministic reds (both pre-existing, none migration-caused): P3.1 guard
  (missing production API), P3-constructor allowlist (`dispatch.ts` committed).
- Env-flaky classes (same family as legacy baseline): §28.1 timeout, projection
  glyphs (ASCII fallback), web nested-list, pack (graph edge + size), import-convention
  timeout, cli --resume/--provider/--timeout/trace/--verify subprocess timing.
- `gate:coverage`: not evaluable while any test fails (by gate design) — same
  limitation as baseline; new module measured 100/100 separately.
- `gate:pack`: 21/23 both before and after (same 2 pre-existing items).
- tsc: 37 test-only errors, 0 from migrated files.

## 20. Final Authority Graph

```text
                    USER
                      │
                      ▼
              OpenCode Desktop ──► (owner gate: rebind to canonical)
                      │                    ║ legacy binding until then
                      ▼                    ║
             D:\git\minicode ◄── active after §12–§13
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
        Git         Agent       .minicode
          │        context        │
          ▼                       ▼
       GitHub                execution state
     (origin, in sync)

  D:\recover\...  = FROZEN / NON-AUTHORITATIVE / PENDING ARCHIVE
  (not part of the active graph; its own clone still self-references locally)
```

## 21. Rollback Evidence

- Canonical: HEAD `dae5c7e` ← `4748b19` ← `e284298` (full chain on GitHub; GitHub main
  == `dae5c7e` verified by ls-remote). Pre-migration snapshot: §2 + Phase-0 notes
  (5 staged, 0 unstaged/untracked-besides-P3.2, index never reset).
- GitHub previous: `aa76dfb` (ancestor — non-destructive fast-forward only).
- Legacy: branch `p3.2-context-identity` @ `4d51ca7`, mirrored on `repo-from-remote`
  (same SHA); main @ `9d79ebb` untouched; worktree clean.
- `repo-from-remote`: HEAD `e284298`, tree clean, never written by migration.
- OpenCode profile backup: `C:\Users\xmlze\.local\share\opencode\
  pre-migration-backup-2026-10-08\` (25 files: all workspace blobs + window + global,
  SHA-256 recorded, e.g. window `9A65FE3FED50`, global `DAE338AC13BF`).
- Rollback per layer (no `reset --hard`): code → GitHub chain; remote URL → one
  `set-url` (old value recorded: local path); UI state → restore backup files;
  legacy → already intact (nothing changed in it).
- Migration manifest: §7. P3.2 hashes: §8.

## 22. Remaining Owner Decisions

1. Execute §12–§13 UI cutover (close legacy sessions; open canonical; verify cwd/git).
2. Run §15 negative test + §19 fresh-session verification; confirm 0 active refs (§16).
3. Decide P3.1 production gap: implement missing guard API vs track as debt (test stays red).
4. Decide P-runtime allowlist debt (`dispatch.ts` vs owners map).
5. Archive retention period + naming; execute rename (Phase 18) only after 1–2 green.
6. Execute deletion (Phase 20) only after retention + full checklist.
7. Confirm GitHub branch `cline/0dbf2` (observed, untouched) is expected.
8. Retire/refresh any remaining stale briefs citing `9d79ebb`/legacy cwd.

## 23. Migration Verdict

Code + remote migration: DONE and pushed. Session/workspace migration: PREPARED,
awaiting owner UI acts. Archive/delete: NOT STARTED (correctly gated).

```text
MIGRATION STATUS: NOT COMPLETE

Canonical workspace: D:\git\minicode (sole code authority, tree clean)
Canonical HEAD: dae5c7e (4748b19, e284298)
Canonical remote: https://github.com/startupmini/minicode.git (in sync, fast-forward, no force)

Legacy workspace: D:\recover\minicode-20260928\reconstruction (FROZEN, clean, branched+pushed)
Legacy status: non-authoritative, pending archive (NOT deleted, NOT renamed)

P3.2: canonical (byte-identical, 39/39 green post-commit)
M1: already-canonical, not duplicated (legacy copies redundant)

OpenCode workspace: legacy-bound (live sessions) — owner cutover pending, profile backed up
OpenCode active session: legacy key (this session); canonical session to be opened by owner

Remote cutover: DONE (GitHub in sync; zero legacy refs in canonical git config)
Legacy dependency: none for canonical git ops; UI binding remains until §12–§13

Active legacy references: OpenCode UI state only (code/config/git: 0)
Legacy fallback: none in code; session-restore is the only re-entry path (closed by cutover)

Tests: full suite 4336 pass / 8 fail / 1 error (+1 flake-storm run characterized);
  deterministic reds = P3.1 gap + P-runtime allowlist (both pre-existing, owner-tracked)
Coverage: gate not evaluable with red tests (by design); P3.2 module 100/100
Pack: 21/23 (same 2 pre-existing items)

Archive: pending (gated)
Deletion: pending (separate final gate, retention TBD)

Rollback readiness: full chain on GitHub + mirrored legacy branch + profile backup + manifest

Remaining owner decisions: §22 (8 items: UI cutover, negative test, P3.1 gap,
  allowlist debt, archive retention, deletion, cline branch, brief hygiene)

Final authority: SPLIT → code+remote canonical; workspace/memory pending owner cutover
```
