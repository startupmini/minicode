# MODE ARCHITECTURE MIGRATION — RELEASE REPORT

**Release:** MiniCode v0.14.1
**Date:** 2026-11-05
**Repository:** `startupmini/minicode` (branch `main`)

## Artifacts

| Item | Value |
|---|---|
| Commit SHA | `a0b752692269d8cf1d692719d104d660a9aaeb53` |
| Tag | `v0.14.1` (points at the commit) |
| GitHub Release | https://github.com/startupmini/minicode/releases/tag/v0.14.1 |
| npm publication | **NOT published** — no npm authentication on this machine (`npm whoami` → `E401`) |
| Remote `main` | `a0b752692269d8cf1d692719d104d660a9aaeb53` (fast-forward from `bc9a084`) |

## Verification

- **Full suite:** `bun test --timeout 25000` → **5462 pass · 19 skip · 0 fail** (5481 tests across 372 files, exit code 0). The default `bun test` without a per-test timeout hangs in an unrelated stale subprocess test (`test/phase6ad-adversarial.test.ts`), so the per-test timeout was used to obtain a complete, green result.
- **Typecheck:** `bun x tsc --noEmit` — clean.
- **Lint:** `bun run lint` — clean (no fixes applied).
- **Commit diff:** 43 files, 1305 insertions / 347 deletions; secret scan of the staged diff returned nothing.
- **Working tree:** clean after commit/push; no temp artifacts (`test/phase6ab-process-child.tmp.ts` was not present/committed; scratch `*.log`/`*.txt` files removed).

## Committed documentation

The migration report (`docs/audit/MODE_ARCHITECTURE_MIGRATION_REPORT_2026-11-05.md`) and reconciliation audit (`docs/audit/MODE_ARCHITECTURE_RECONCILIATION_AUDIT_2026-11-05.md`) are committed as repository documentation.

## Remaining limitations

1. `git_commit all:true` can stage unrelated *tracked* workspace changes; task-scope precision relies on explicit `paths` + path jail, not a diff-scope tracker.
2. Legacy `--allow-all`/`--allowlist` still flow through the `permissionMode` string; a dedicated `ToolAccessProfile` type is deferred.
3. Resume stderr notice still spells the internal identity `EXECUTE` (footer/`/status`/help use `BUILD`).
4. npm publication blocked (no credentials).

## Install & smoke test

```bash
# Install from the Git tag (local, no npm needed):
git clone https://github.com/startupmini/minicode.git && cd minicode && git checkout v0.14.1
bun install

# Smoke test the new mode architecture:
bun cli/index.ts --work-mode DISCUSS "explain the repo structure"
bun cli/index.ts --work-mode PLAN "plan a refactor of src/policy"
bun cli/index.ts "implement it"   # BUILD + AUTO (default)

# Verify UI/help reflect the three-axis model:
bun cli/index.ts --help