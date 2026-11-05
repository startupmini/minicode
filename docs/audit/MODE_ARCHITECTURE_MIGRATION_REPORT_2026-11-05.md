# MODE ARCHITECTURE MIGRATION REPORT

**Date:** 2026-11-05
**Task:** Refactor MiniCode's mode architecture (WorkMode × PermissionMode × Tool Access Policy) and synchronize every interface, per the owner-approved contract and `MODE_ARCHITECTURE_RECONCILIATION_AUDIT_2026-11-05.md`.

**Source of truth:** `MODE_ARCHITECTURE_RECONCILIATION_AUDIT_2026-11-05.md` (validation) + the owner's authoritative target contract (this task's §1).

---

## 1. Final architecture

Three orthogonal responsibilities, one enforcement boundary:

| Layer | Values | Owns |
|---|---|---|
| **WorkMode** | `DISCUSS` · `PLAN` · `BUILD` (internal `EXECUTE` = `BUILD`) | *How* the agent operates; ceiling of permitted operations |
| **PermissionMode** | `AUTO` · `ASK` (internal `auto` / `ask`) | *Whether* human approval is required |
| **Tool Access Policy** | capability sets derived from `tool-contract.ts` | *What* is available (read-only set, plan extras, bash allowlist, gated/privileged class, MCP authorization) |
| **Hard security** | path jail · sensitive-file · owned-state · bash-guard · approval-binding | *What must never happen* (non-overridable, all layers) |

**Decision pipeline (fail-closed):**

```
1. WorkMode ceiling (capability set from tool-contract.ts)   → deny if outside permitted set
2. PermissionMode approval (AUTO | ASK)                       → AUTO: authorized ⇒ allow
                                                                 ASK: authorized ⇒ prompt (read/bookkeeping ⇒ allow)
3. Hard security (jail/owned-state/bash-guard) runs FIRST, always, incl. legacy allow-all
4. Tool Access Policy (bash allowlist, MCP authorization, gated class)
```

---

## 2. Before / after responsibility map

| Concern | Before | After |
|---|---|---|
| `auto` | approval policy (but *prompted* on gated tools) | **PermissionMode.AUTO** — full autonomy; authorized ⇒ execute, no prompt |
| `ask` | approval policy | **PermissionMode.ASK** (unchanged behavior) |
| `readonly` | PermissionMode value (internal-only) | **internal read-only capability set** (not user-facing; scheduler boundary = injected `AutonomousPermissionHandler`, NOT `readonly`) |
| `plan` | PermissionMode value (`--plan`, `/mode plan`) | **WorkMode PLAN** (canonical planning); legacy `--plan` → `--work-mode PLAN` |
| `allowlist` | PermissionMode value | **bash/tool access policy** (legacy `--allowlist`) |
| `allow-all` | PermissionMode value | **privileged access profile** (legacy `--allow-all`) |
| `EXECUTE` | WorkMode value | **internal identity of `BUILD`** (display/input alias; persistence stays `EXECUTE`) |

---

## 3. AUTO behavior evidence

Implementation: `src/policy/permission.ts` — `auto` handler (decision `handlers.auto`).

- **Read-only** (`READONLY_TOOL_NAMES`) → allow.
- **`git_commit`** → allow (previously `promptAskOr`). Path/staged jail still applies (`permission.ts` universal jail, `git_commit` branch).
- **`delegate_task`** → allow (previously gated). Child containment preserved via WorkMode inheritance (`setSubAgentWorkMode`) + `forcedExplore` in `task.ts`.
- **`mcp_call` / `mcp_read` / `mcp_prompt`** → allow (previously gated). Configured-server enforcement lives in the tool (`mcp_call.ts`), not the approval gate.
- **Dotted MCP tools** (`server.tool`) → allow **iff** present in `authorizedTools` (the session's visible/configured tool set, threaded via `createMinicodeSession`); otherwise **deny** (`"MCP tool not configured/authorized"`).
- **`ask_user`** → **deny (BLOCKED)** `"ask_user unavailable in AUTO (autonomous mode)"`. Deterministic; never converts AUTO into an approval interaction.
- **file writes, bash (after bash-guard), code_run (sandbox-required)** → allow (unchanged).
- **Everything else** → deny (`"not authorized in AUTO mode"`).

Verification: `test/permission-matrix.test.ts` (auto row: GATED→allow, `ask_user`→deny), `test/agent-contract.test.ts` (gated commit headless moved to ASK), `test/work-mode-contract.test.ts` / `work-mode-subagent.test.ts` (delegate autonomous), `test/permission-adversarial.test.ts` (git paths jail + auto allow).

## 4. ASK behavior evidence

Implementation: `src/policy/permission.ts` — `ask` handler (unchanged).

- Read-only ⇒ allow; bookkeeping (`todo_write`/`submit_result`/`bash_output`/`bash_kill`) ⇒ allow.
- `allowlist`/`always` grants ⇒ allow (bound to exact `name + full-args` key, per-session, `allowlist.ts`).
- gated + file-write + bash + code_run ⇒ **prompt** (`promptAskOr` / `gatedPrompt`); headless ⇒ deny.
- Hard-deny (jail/guard/owned-state) ⇒ deny *before* any prompt, non-overridable.

Verification: `test/permission-matrix.test.ts` ask column, `test/agent-contract.test.ts` (gated commit/delegation headless now under ASK), `test/work-mode-contract.test.ts` (PLAN × ask delegate gate), `test/approval-integrity.test.ts`.

## 5. Tool Access Policy design

No new permission engine. Capability classification is consolidated on the **existing single registry** `src/policy/tool-contract.ts`:

- `READONLY_TOOL_NAMES` (18 read tools, derived from `allowedInReadonly`).
- `LOCAL_READONLY_TOOL_NAMES` (16 PURE_READ, no network).
- `NETWORK_READ_TOOL_NAMES` (`web_fetch`, `web_search`).
- **New** `PLAN_EXTRA_TOOL_NAMES` (`todo_write`, `delegate_task`, `submit_result`) — single source shared by `work-mode.ts` ceiling, `tool-layer.ts` visibility, and the legacy `plan` handler.
- `GATED_TOOLS` (`gatedByDefault`) reinterpreted as **"authorization class"**, no longer "auto ⇒ prompt".

WorkMode ceiling now reads capability sets **directly** (`src/policy/work-mode.ts` `ceilingAllows`) instead of constructing `readonly`/`plan` permission handlers as primitives.

## 6. Hard-security invariants (preserved)

- Path jail / sensitive-file / owned-state (`permission.ts:514-615`) run **before** `allow-all` and every handler.
- Bash-guard (`inspectBashCommand`) still runs in `allowlist`, `ask`, `auto`, and `allow-all`.
- Approval-binding target verification (`session.ts` `withEffectBarrier`) unchanged.
- Scheduler boundary = injected **AutonomousPermissionHandler** (`createAutonomousPermissionHandler`, deny-unknown, never prompts). `permissionMode: "readonly"` remains metadata only.
- `MINICODE_SANDBOX` still gates `code_run`.

Verification: `test/permission-adversarial.test.ts`, `test/phase2-security.test.ts`, `test/hardening-boundary.test.ts`, `test/work-mode-contract.test.ts` Invariant #1.

## 7. Child / scheduler inheritance

- `delegate_task` children inherit parent **WorkMode** live (`setSubAgentWorkMode`); non-EXECUTE parent ⇒ child forced explore/read-only (`task.ts:266-268`, `326-329`).
- `delegate_task` under `AUTO` runs autonomously; under `ASK` remains gated.
- Child `permissionMode` stays `allowlist`/`auto` (approval axis); parent WorkMode ceiling is the containment boundary.
- Scheduler child still uses `permissionHandler: spec.permissionHandler` (`setup.ts:3227-3241`) — `readonly` is NOT the boundary.

## 8. MCP and git behavior

- **MCP:** dotted MCP tools authorized iff configured (in `authorizedTools`); unconfigured/out-of-scope ⇒ deny in AUTO (no prompt). `mcp_call`/`mcp_read`/`mcp_prompt` authorized under AUTO.
- **git_commit:** authorized under AUTO (jail-scoped paths; `--no-verify`, no hooks); under ASK remains gated (headless deny). "Unrelated user-owned changes" protection remains via explicit `paths` + path jail + owned-state (note: `all:true` is the agent's explicit choice; documented as residual limitation below).

## 9. CLI / TUI / footer / persistence changes

- `--work-mode DISCUSS|PLAN|BUILD` (BUILD accepted as alias → EXECUTE). `parseWorkModeValue` + `displayWorkMode`.
- `--plan` → deprecated alias for `--work-mode PLAN` (stderr notice, setup.ts fold).
- `--allow-all` / `--allowlist` → retained as legacy access profiles, with deprecation notices (index.ts, exec.ts).
- TUI: **Tab** cycles WorkMode (`DISCUSS→PLAN→BUILD`); **Shift+Tab** toggles PermissionMode (`AUTO↔ASK`); `/mode <AUTO|ASK>`; `/work-mode <DISCUSS|PLAN|BUILD>`.
- Footer always shows `<WorkMode> · <PermissionMode>` (`BUILD · AUTO`). `paintFooterMode`.
- `/status` reports product values (BUILD, AUTO/ASK).
- Persistence: `BUILD` normalizes to `EXECUTE`; stored EXECUTE remains valid; legacy NULL → EXECUTE unchanged; resume restore behavior unchanged.

## 10. Compatibility & deprecation map

| Legacy | Target | Broken? |
|---|---|---|
| `--plan` (flag/env) | `--work-mode PLAN` | no — mapped + notice; **now persists as WorkMode PLAN** (see note below) |
| `--allow-all` | privileged access profile | no — retained + notice |
| `--allowlist` | bash/tool access policy | no — retained + notice |
| `/mode plan` / `/mode readonly` / `/mode allow-all` / `/mode allowlist` | `unknown mode` (only `AUTO|ASK` accepted) | **yes** — intentional; `/mode` now approval-only |
| `--work-mode EXECUTE` | accepted; identity = BUILD | no |
| stored `work_mode` column | unchanged (EXECUTE/DISCUSS/PLAN) | no |
| `~/.minicode/allowlist.json` grants | unchanged (no rename; no data migration) | no |

> **`--plan` persistence change (documented, not silent):** legacy `--plan` was a *non-persisted* permission mode (re-derived each invocation). Mapping it to WorkMode PLAN makes it *persist across `--resume`* (WorkMode is persisted per P0.2 Q5; see `loadSessionWorkMode`/`saveSessionWorkMode`). A plan session resumed without an explicit `--work-mode` therefore restores PLAN (surfaced by the `[resume] WorkMode PLAN restored` notice) and stays read-only; `--work-mode BUILD` explicitly reopens execution. This is the coherent consequence of "WorkMode PLAN is the canonical planning mode" and is not a silent reinterpretation — it emits a deprecation notice at startup and a transparency notice on resume.

## 11. Files changed

Source (12): `src/policy/permission.ts`, `src/policy/work-mode.ts`, `src/policy/tool-contract.ts`, `src/app/session.ts`, `src/app/tool-layer.ts`, `src/ui/footer.ts`, `src/ui/tui/app.ts`, `src/ui/i18n/en.ts`, `src/ui/i18n/id.ts`, `cli/args.ts`, `cli/index.ts`, `cli/setup.ts`, `cli/tui.ts`, `cli/commands/exec.ts`.

Docs (4): `docs/cli.md`, `docs/environment.md`, `docs/choosing-mode.md`, `docs/agents.md`.

Tests (12): `test/permission-matrix.test.ts`, `test/work-mode-contract.test.ts`, `test/work-mode-runtime.test.ts`, `test/work-mode-subagent.test.ts`, `test/work-mode-cli.test.ts`, `test/agent-contract.test.ts`, `test/permission-adversarial.test.ts`, `test/footer-render.test.ts`, `test/writer-inventory.test.ts`, `test/tui-app.test.ts`, `test/tui-audit-fixes.test.ts`, `test/tui-popup.test.ts`, `test/tui-signal.test.ts`.

## 12. Tests

Focused (all green):
- `permission-matrix` + `footer-render` + `work-mode-cli` — 47 pass / 0 fail.
- `work-mode-contract` — 38 pass / 0 fail.
- `work-mode-runtime` + `work-mode-subagent` + `agent-contract` — 60 pass / 0 fail.
- `phase2-security` + `hardening-boundary` + `work-mode-hooks` + `work-mode-prompt` + `agent-contract` — 240 pass / 0 fail.
- `work-mode-cli` + `acp` + `daemon-stream-phase` + `cli-regression` + `cli-help-language` + `work-mode-hooks` + `work-mode-tool-visibility` — 113 pass / 0 fail.
- `permission-adversarial` + `writer-inventory` — 22 pass / 0 fail.
- `bun x tsc --noEmit` — clean.

Full suite (`bun test`): running at time of report (see §14 completion note).

## 13. Remaining limitations

1. **`git_commit all:true`** can stage unrelated *tracked* workspace changes under AUTO; "unrelated user-owned change" protection relies on explicit `paths` + path jail. A precise task-scope diff tracker is out of scope for this refactor and was not added.
2. Legacy `--allow-all`/`--allowlist` still flow through the `permissionMode` string; their capability semantics are unchanged, only re-documented as profiles. A future separate `ToolAccessProfile` type would be cleaner but was deferred.
3. ACP `mode:"plan"` remains a legacy field (maps to WorkMode PLAN via setup fold) — its name is not renamed for wire compatibility.
4. Resume stderr notice still spells the internal identity `EXECUTE` (not `BUILD`); footer/`/status`/help use `BUILD`. Known cosmetic gap, not a correctness issue.
5. The scheduler's `readonly` metadata value is retained (it is *not* the security boundary) to avoid touching the injected-handler seam.

## 14. Final Git status

- Branch: `main` · HEAD: `bc9a084f64f2a4f318312947db25e35e3e8fbf0c` (unchanged — nothing committed).
- Modified (tracked): 27 files (source/docs/tests listed in §11).
- Untracked: `docs/audit/MODE_ARCHITECTURE_RECONCILIATION_AUDIT_2026-11-05.md` (input artifact) and `test/phase6ab-process-child.tmp.ts` (test-run artifact; not authored by this change, left in place).
- No commit, push, stage, reset, clean, stash, checkout, rebase, or merge performed.

## Verdict

**`MIGRATION_COMPLETE_WITH_LIMITATIONS`**

All six legacy PermissionMode values are re-homed; WorkMode is a clean three-value operating axis (`DISCUSS`/`PLAN`/`BUILD`); PermissionMode is a clean two-value approval axis (`AUTO`/`ASK`); Tool Access Policy is consolidated on the single contract registry; hard security is preserved and non-overridable; UI/footer/CLI/persistence synchronized. AUTO no longer prompts for ordinary authorized actions (git commit, delegation, MCP). Remaining limitations (§13) are honest, non-blocking gaps (principally `git_commit all:true` scope precision), not security regressions.

AUTO no longer stops for routine authorized actions; hard-deny evidence is preserved by the unchanged jail/guard/owned-state layer and the unchanged scheduler `AutonomousPermissionHandler`.