# MODE ARCHITECTURE RECONCILIATION AUDIT

## WorkMode × PermissionMode × Tool Access Policy

**Date:** 2026-11-05
**Scope:** Audit only — no implementation, no behavior change, no source/test mutation.
**Author role:** Principal Software Architect & Security Architecture Auditor.

---

## 0. Repository state captured

| Field | Value |
|---|---|
| Branch | `main` |
| HEAD | `bc9a084f64f2a4f318312947db25e35e3e8fbf0c` |
| HEAD subject | `chore: remove temporary linux debug workflow` |
| HEAD date | 2026-11-05 15:13:50 +0700 |
| Tracked modifications | none (`git status --porcelain` empty) |
| Staged files | none |
| Untracked files | none |
| Diff fingerprint | clean working tree (0 dirty entries) |

Only this report was created. No source, test, enum, flag, TUI, footer, or runtime behavior was changed.

> Note on displaced line numbers: the prompt cited `setup.ts:1148-1156`, `setup.ts:3240`, `tui.ts:50`, `permission.ts:32`, `permission.ts:410-460`. All of these were verified against the current source; the only corrections are listed inline (e.g. `readonly` scheduler-child comment now lives at `setup.ts:3227-3241`, and the decision-handler region is `permission.ts:410-503`).

---

## A. Executive verdict

**A.1 Is the current architecture conceptually coherent?**

Partially. The codebase already recognizes a *two-axis* separation and — remarkably — has already implemented one of them correctly:

- **WorkMode** (`DISCUSS` / `PLAN` / `EXECUTE`) is a separate, thin "intent ceiling" layer above the permission handler (`src/policy/work-mode.ts`). It is documented as *guidance + enforcement ceiling*, and it is explicitly *not* an approval policy.
- **PermissionMode** is a **six-value enum** that conflates at least three orthogonal concerns:
  1. **Approval policy** — `auto` and `ask`.
  2. **Capability / tool-access restriction** — `readonly` and `plan`.
  3. **Bash capability restriction** — `allowlist`.
  4. **Privileged override** — `allow-all` (which simultaneously disables approval *and* restriction).

So the two-layer idea is present, but PermissionMode is doing the work that the owner suspects it of: it is not a clean "two-value approval policy"; it is a catch-all capability-and-approval selector.

**A.2 Are WorkMode and PermissionMode responsibilities cleanly separated?**

Not cleanly, but the specific mechanics matter:

- WorkMode's ceiling is *implemented by reusing* the PermissionMode `readonly` and `plan` capability handlers as primitives (`src/policy/work-mode.ts:89-98`, `ceilingFor` at `:74-77`). That is: **WorkMode DISCUSS = "run the `readonly` permission handler as a ceiling"**, and **WorkMode PLAN = "run the `plan` permission handler as a ceiling"**.
- Consequently, `readonly` and `plan` PermissionMode values are structurally *used twice*: once as user-facing (or internal) permission modes, and once as the building blocks of the WorkMode ceiling. This is the single most important architectural finding of this audit: **`readonly` and `plan` are capability restrictions that already belong to the WorkMode/ceiling layer, but they live inside the approval enum.**

**A.3 Which PermissionMode values are redundant, misplaced, or legitimately independent?**

| Value | Verdict | Why (summary; full analysis in §E) |
|---|---|---|
| `auto` | **Legitimate — approval policy** | Autonomous approval policy: ordinary writes/bash run without prompt; only the *gated* class prompts. |
| `ask` | **Legitimate — approval policy** | Interactive approval; prompts on every non-read, non-bookkeeping action unless allowlisted/`always`. |
| `readonly` | **Misplaced — capability restriction** | Not user-facing at all (no flag, not in TUI MODES). Only used internally as a capability set (and as the WorkMode ceiling primitive). |
| `plan` | **Misplaced (partially) — capability restriction** | Duplicates WorkMode PLAN's restriction set (`readonly + todo_write/delegate_task/submit_result`). Is user-facing (`--plan`, `/mode plan`), so there is UI ambiguity with WorkMode PLAN. |
| `allowlist` | **Misplaced — capability restriction** | Bash-allowlist + gated-deny + readonly-read policy. Not an approval policy. |
| `allow-all` | **Misplaced — privileged override** | Disables both approval and restriction. Not an approval policy; it is an "unsafe combination of concerns". |

**A.4 Does BUILD + AUTO currently provide full autonomous execution?**

**No — not "full" under the owner's definition, by a narrow but real margin.**

- `EXECUTE` (the internal name whose product-facing name is `BUILD`) + `auto` already auto-allows **ordinary file writes, edits, apply_patch, move/delete, bash (after `bash-guard`), and `code_run` (when a sandbox is set)** without any prompt (`src/policy/permission.ts:483-501`).
- **What still prompts under `auto`** is the *gated* class only: `git_commit`, `delegate_task`, `mcp_call`, `mcp_read`, `mcp_prompt`, `ask_user`, and any dotted MCP tool (`isGated`, `permission.ts:338-341`; `GATED_TOOLS`, `tool-contract.ts:533-535`).

So a `BUILD`+`AUTO` agent performing end-to-end implementation work will still be interrupted by `git_commit` (shared history, external irreversible) and `delegate_task` (child escalation vector) — both of which are *routine* BUILD actions, not exotic capabilities. This is the concrete gap between the owner's "full autonomous execution end-to-end" intent and current behavior.

**A.5 What prevents full autonomy (and is it intentional)?**

Two distinct mechanisms, which must not be collapsed:

1. **The gated-tool approval gate** (`gatedByDefault` in `tool-contract.ts` + `isGated` + `promptAskOr` in `permission.ts`). This is a *deliberate, per-tool approval rule* driven by security reasoning (shared history; escalation via child session; external prompt-injection surface; unbounded human question). It is arguably part of a future **Tool Access Policy** ("privileged capabilities require approval"), not a bug to be deleted wholesale.
2. **Universal hard-denies (jail / bash-guard / owned-state)** which always run *before* `allow-all` and every handler (`permission.ts:514-631`). These are correctly already a **separate hard-security layer** and are *not* an obstacle to autonomy, because they should never be loosened by AUTO (they categorically deny out-of-workspace, sensitive-file, destructive, or owned-state operations).

The verdict is that `auto` is *substantially* autonomous but not *fully*, and the residual gap is the gated class. Whether `BUILD + AUTO` should also auto-approve `git_commit`/`delegate_task` (by moving them from "gated" into "auto" under a Tool Access Policy) is an **owner decision**, not something this audit can resolve from code alone.

---

## B. Actual architecture

### B.1 The two real layers in production

```
Composition root (cli/setup.ts)
  └─ createMinicodeSession({ permissionMode, workMode, ... })   // src/app/session.ts:115
       └─ permissions = createWorkModePermissionHandler({          // session.ts:289-304
              workMode,                                            //   ceiling layer (DISCUSS/PLAN/EXECUTE)
              base: createPermissionHandler({ mode: permissionMode })  // policy layer (6 values)
          })
       └─ withEffectBarrier = { ...permissions, check: approval-binding verify }  // session.ts:360-400
       └─ createCoreSession({ permissions: withEffectBarrier, permissionMode: livePermissionMode })
```

The kernel (`vendor/minicore/src/core/permission.ts:14-23`) commits to consulting a `PermissionHandler.check(call, deps)` before every tool execution and enforces nothing itself. **That single `check` is the authoritative enforcement boundary** for everything mode-related.

### B.2 Enforcement ordering inside `createPermissionHandler.check`

Order of checks in `src/policy/permission.ts:506-633` (authoritative, and order is security-relevant):

1. Abort signal (`:512`) → deny.
2. **Universal file-path jail** for `write_file`/`edit`/`apply_patch`/`read_file`/`read_image`/`delete_file` (`:514-528`), `move_file` (`:531-538`), `lsp_*` (`:539-543`), `cwd`-outside-root for `bash`/`glob`/`grep`/`git_*` (`:544-554`), `git_commit` paths (`:556-562`). These apply **in every mode, including `allow-all`**.
3. **Owned-state protection** (`.minicode/` write denial, symlink/junction-aware) (`:582-615`) — every mode including `allow-all`.
4. `allow-all` short-circuit (`:618-631`): returns allow, but still runs full `bash-guard` on non-empty bash commands.
5. Otherwise dispatch to the per-mode handler (`:633`).

This is the **final security enforcement point**: a categorical deny here cannot be reversed by any mode value, any WorkMode, or any approval.

### B.3 WorkMode ceiling enforcement (the second layer)

`src/policy/work-mode.ts:143-189` `check()`:

- `EXECUTE` → delegate entirely to base (`:149`).
- `DISCUSS` + network-read tool (`web_fetch`/`web_search`) → deny, never touching base (`:150-155`).
- Select ceiling = `ceilingFor(workMode, baseMode)` (`:160`, `:74-77`):
  - `DISCUSS` → `readonly` ceiling.
  - `PLAN` → `readonly` ceiling if base PM is already `allowlist`/`readonly`, else `plan` ceiling.
- **Ceiling first** (`:163-167`): anything outside the read-only ceiling is denied *before* the base can prompt.
- Inside ceiling, delegate to base (`:170`).
- `PLAN` + network-read → require explicit gated approval via `ctrl.__promptGated` (`:179-187`).

Key property (Invariant #1, tested in `test/work-mode-contract.test.ts:736`): **WorkMode never expands what PermissionMode denies** — it only narrows. This is correct and safe.

### B.4 Tool visibility (must equal callability)

`src/app/tool-layer.ts` `workModeVisible` (`:32-51`) mirrors the ceiling: DISCUSS shows only `LOCAL_READONLY_TOOL_NAMES` (16 pure-read tools, network read hidden), PLAN shows 18 read tools (+ `PLAN_EXTRA` = `todo_write`/`delegate_task`/`submit_result` unless PM is `readonly`/`allowlist`), EXECUTE defers to PM. `setupToolLayer` keeps `visible === callable` live on both `setWorkMode` and `setPermissionMode` runtime transitions (`:119-148`).

### B.5 The scheduler child is NOT enforced by `readonly`

This is the single most important thing to get right (§2.5 of the prompt):

`cli/setup.ts:3227-3241` builds the autonomous child session with **two** fields:

```ts
sessionFactory: async (spec: AutonomousSessionSpec) => {
  const child = await createMinicodeSession({
    ...
    permissionHandler: spec.permissionHandler as never,   // ← the 6S AutonomousPermissionHandler
    permissionMode: "readonly",                            // ← metadata ONLY
  })
}
```

`spec.permissionHandler` is `createAutonomousPermissionHandler(ledger)` (`src/task/autonomous-context.ts:351`, `autonomous-policy.ts:445`). In `createMinicodeSession`, when `permissionHandler` is injected, `injected === true`, `livePermissionMode` returns the *string* `"readonly"` purely as kernel metadata (`session.ts:430`), and `onPermissions` is deliberately **not** wired (`session.ts:401-414`). The actual allow/deny comes from the **AutonomousPermissionHandler**, which answers `deny` synchronously for anything outside `AUTONOMOUS_TOOL_NAMES` and never prompts.

The design comments (`session.ts:173-185`, `setup.ts:3235-3238`) state the rationale explicitly: using the *mode-derived* `readonly` handler would be (a) revocable at runtime via `__setMode` and (b) would admit `web_fetch`/`web_search` — both unacceptable for an unattended run.

**Conclusion for §6 Q3:** `readonly` is *not* the security boundary for scheduler children. The autonomous policy is. Therefore `readonly` (as a PermissionMode value) can be demoted/removed from the user-facing surface **without** weakening scheduler children — but only if the autonomous policy seam (`permissionHandler` injection) is preserved.

---

## C. Source-of-truth inventory

### C.1 Types and constants

| Concern | Symbol | Location |
|---|---|---|
| PermissionMode type (6 values) | `export type PermissionMode = "auto"\|"readonly"\|"plan"\|"allow-all"\|"ask"\|"allowlist"` | `src/policy/permission.ts:32` |
| WorkMode type (3 values) | `export type WorkMode = "DISCUSS"\|"PLAN"\|"EXECUTE"` | `src/policy/work-mode.ts:17` |
| RestrictiveWorkMode | `type RestrictiveWorkMode = Exclude<WorkMode,"EXECUTE">` | `work-mode.ts:36` |
| CLI WorkMode alias | `export type CliWorkMode = "DISCUSS"\|"PLAN"\|"EXECUTE"` | `cli/args.ts:105` |
| PermissionControl | `{ setMode(...); getMode(): ... }` (6-value union duplicated inline) | `src/app/session.ts:66-69` |
| WorkModeControl | `{ setWorkMode(m: WorkMode); getWorkMode(): WorkMode }` | `session.ts:78-81` |
| PermissionMode union (duplicated inline) | `opts.permissionMode` in `createMinicodeSession` | `session.ts:121` |
| PermissionMode union (duplicated in test helpers) | `ALL_MODES` / `MODES` arrays | `test/work-mode-contract.test.ts:41`, `test/permission-matrix.test.ts:158` |
| Tool contract registry | `TOOL_CONTRACTS`, `ToolContractMetadata`, `contractForTool` | `src/policy/tool-contract.ts:81-520` |
| Gated set | `GATED_TOOLS` (derived from `gatedByDefault`) | `tool-contract.ts:533-535` |
| Read-only set | `READONLY_TOOL_NAMES` (derived from `allowedInReadonly`) | `tool-contract.ts:554-556` |
| Local read-only set | `LOCAL_READONLY_TOOL_NAMES` (PURE_READ) | `tool-contract.ts:563-565` |
| Network read set | `NETWORK_READ_TOOL_NAMES` (`web_fetch`,`web_search`) | `tool-contract.ts:572-576` |
| Autonomous set | `AUTONOMOUS_TOOL_NAMES` | `tool-contract.ts:543-545`, re-exported `src/task/autonomous-policy.ts:365` |
| Tool capability matrix | `TOOL_CAPABILITIES`, `classifyTool`, `ToolCapability` | `src/task/autonomous-policy.ts:49-345` |

### C.2 Decision handlers and runtime call sites

| Concern | Symbol | Location |
|---|---|---|
| Per-mode decision handlers | `handlers: Record<PermissionMode, ...>` | `src/policy/permission.ts:410-503` |
| `allow-all` handler | `"allow-all": async () => "allow"` | `permission.ts:418` |
| `readonly` handler | `READONLY_TOOLS.has(name) ? allow : deny` | `permission.ts:419-420` |
| `plan` handler | `readonly + todo_write/delegate_task/submit_result` | `permission.ts:427-433` |
| `allowlist` handler | bash-allowlist + gated-deny + file/internal write + readonly read | `permission.ts:434-456` |
| `ask` handler | read allow, `NO_PROMPT` allow, allowlist match, gated prompt, else prompt | `permission.ts:457-482` |
| `auto` handler | read allow, gated prompt, file/internal write allow, code_run(sandbox), bash(guard) | `permission.ts:483-501` |
| Universal jail (pre-mode) | `check()` body | `permission.ts:506-631` |
| Runtime mode control | `__setMode` / `__getMode` | `permission.ts:638-644` |
| Denial seam | `describeDenial` | `permission.ts:648-650` |
| Forced gated prompt seam | `__promptGated` | `permission.ts:655-659` |
| WorkMode ceiling | `createWorkModePermissionHandler` / `ceilingFor` | `work-mode.ts:74-216` |
| WorkMode composition | `composeWorkModePermissionHandler` | `work-mode.ts:219-230` |
| Session composition | `createMinicodeSession` | `session.ts:115-524` |
| Injected-handler guard | `injected` branch, `onPermissions`/`onWorkMode` gating | `session.ts:305, 401-427` |
| Approval binding barrier | `withEffectBarrier` | `session.ts:360-400` |
| Autonomous handler | `createAutonomousPermissionHandler` | `autonomous-policy.ts:445-470` |

### C.3 CLI flags, parsing, defaults, normalization

| Concern | Location |
|---|---|
| Boolean flags `--allow-all --ask --plan --allowlist` | `cli/args.ts:2-20` |
| Value flag `--work-mode` | `cli/args.ts:34` |
| `--enable-scheduler`, `--allow-local-config` | `cli/args.ts:13,19` |
| WorkMode parse | `parseWorkModeValue` | `cli/args.ts:112-116` |
| WorkMode resolve (flag > env > default EXECUTE) | `resolveWorkModeFlag` | `cli/args.ts:125-143` |
| Permission resolve in `index.ts` | `allowAll`/`ask`/`plan`/`allowlist` | `cli/index.ts:275-279` |
| Sandbox fallback → allowlist | `resolveSandbox`, `effectiveAllowlist` | `cli/index.ts:393-409` |
| PermissionMode derivation | `permissionMode = allowAll ? "allow-all" : ask ? "ask" : plan ? "plan" : allowlist ? "allowlist" : "auto"` | `cli/setup.ts:1148-1156` |
| `exec` flags | `exec.ts:71-91` (derivation), `exec.ts:113-114` (workMode) | `cli/commands/exec.ts` |
| ACP `mode` (`auto\|plan` only) | `AcpRunParams.mode` | `cli/commands/acp.ts:95,120-122` |
| ACP `workMode` | `acp.ts:97,123-139` | `cli/commands/acp.ts` |
| Daemon host session (always `ask`) | `ask: true; plan: false; allowlist: false` | `cli/commands/daemon.ts:324-337` |

### C.4 TUI / UI surfaces

| Concern | Location |
|---|---|
| TUI MODES | `const MODES = ["auto","ask","plan","allowlist","allow-all"]` | `cli/tui.ts:50` |
| Driver commands | `/mode`, `/work-mode` | `cli/tui.ts:52-59` |
| Tab cycling | `cycleMode` — **skips `allow-all`** | `cli/tui.ts:266-274` |
| `/mode` selection | accepts any of `MODES`, **including `allow-all`** | `cli/tui.ts:447-459` |
| `/work-mode` selection | `parseWorkModeValue`, DISCUSS/PLAN/EXECUTE | `cli/tui.ts:464-486` |
| Footer mode paint | `paintFooterMode`, `FooterStatus.workMode` | `src/ui/footer.ts:20-28, 69-79` |
| Live footer source | `getStatus().footer.{mode, workMode}` | `cli/tui.ts:629-640` |
| `/status` readout | `st.workMode` + `st.permissionMode` | `cli/commands.ts:218-219`, strings `src/ui/i18n/{en,id}.ts:134-135` |

### C.5 Persistence and child-agent seams

| Concern | Location |
|---|---|
| Session `work_mode` column + migration | `src/session/persistence.ts` (DDL, `ALTER TABLE ... ADD COLUMN work_mode`) |
| `loadSessionWorkMode` | `persistence.ts:1458-1471` |
| `saveSessionWorkMode` | `persistence.ts:1473-1497` |
| `parseStoredWorkMode` | `persistence.ts:1453-1456` |
| Resume WorkMode restore | `setup.ts:981-983` (`persistedWorkMode`), notice `setup.ts:1266-1273` |
| Save WorkMode on transition | `setup.ts:1907-1912` (in `onWorkMode`) |
| Save WorkMode on persist | `setup.ts:3035-3039` (`saveSession(... workMode)`) |
| Sub-agent WorkMode injection | `setSubAgentWorkMode` / `subAgentWorkMode` | `src/tools/task.ts:184-197`; wired `setup.ts:1845` |
| Sub-agent PM inheritance | `permissionMode: parentMode === "allowlist" ? "allowlist" : "auto"` | `task.ts:505` |
| Sub-agent forced explore | `parentMode ∈ {plan,readonly,ask}` | `task.ts:266-268` |
| Sub-agent child WorkMode | `workMode: childWorkMode` | `task.ts:509` |
| Sub-agent tool strip | removes 8 tools (delegate/write_memory/forget/todo_write/bash_output/bash_kill/git_commit/submit_result) | `task.ts:301-313` |
| Scheduler child readonly (metadata) | `permissionMode: "readonly"` + injected handler | `setup.ts:3227-3241` |
| Hooks gate | `shouldRunHooks` | `src/hooks/run.ts:27-37` |

---

## D. Permission decision matrix

Legend: **A** = allow, **D** = deny, **P** = prompt (may require human) / gated approval, **A\*** = allow but only via approval prompt path (`promptAskOr`). "gated" = `git_commit`, `delegate_task`, `mcp_call`, `mcp_read`, `mcp_prompt`, `ask_user`, dotted MCP tools.

Action classes: READ (read_file/glob/grep/…), NETREAD (`web_fetch`/`web_search`), WRITE (write_file/edit/apply_patch/move/delete), BASH, CODERUN (`code_run`), GATED (as above), TODO (todo_write), SUBMIT (submit_result), MCP (mcp_call).

### D.1 Current PermissionMode behavior (EXECUTE WorkMode, i.e. no ceiling)

| Action | `auto` | `ask` | `readonly` | `plan` | `allowlist` | `allow-all` |
|---|---|---|---|---|---|---|
| READ (local) | A | A | A | A | A | A |
| NETREAD | A | A | A | A | A | A |
| WRITE | A | P (unless allowlist/`always`) | D | D | A | A |
| BASH | A (after guard) | P (guard first) | D | D | A only if allowlist-match + safe (guard first) | A (guard) |
| CODERUN | A only if sandbox; else D | P (guard-free; not in NO_PROMPT/GATED) | D | D | D (not readonly, not file/internal write) | A |
| GATED | P (`promptAskOr`) | P (`promptAskOr`) | D | D | D | A |
| TODO | A | A (NO_PROMPT) | D | A | A (INTERNAL_WRITE) | A |
| SUBMIT | A | A (NO_PROMPT) | D | A | A (INTERNAL_WRITE) | A |
| MCP | P (dotted → `isGated`) | P | D | D | D | A |

Notes:
- GATED under `auto`/`ask` is **not** a plain "A" — it goes through `promptAskOr`, which is deny in headless, and prompt+**allowlist/`always` grant** (persisted to `allowlist.json`) when interactive (`permission.ts:842-869`).
- Under `allow-all`, BASH still runs `bash-guard` (full `inspectBashCommand`), and the universal jail still applies. So `allow-all` is *not* literally "allow everything".
- `code_run` under `ask`: not read-only, not in `NO_PROMPT_TOOLS`, not gated, not allowlist-default, so it falls to the generic `gatedPrompt` in the `ask` handler (`permission.ts:472`) **without** passing through `requireTTY`-gated path — the inline `ask` path (`permission.ts:472`) uses `gatedPrompt(..., false)` (non-requireTTY). (This is the one action class whose `ask`-path TTY behavior differs from gated; see §G/§F.)

### D.2 WorkMode ceiling (applied on top of every PM row above)

| Parent WorkMode | Ceiling | Effect on PM row |
|---|---|---|
| `EXECUTE` | none | full PM row applies (D.1) |
| `DISCUSS` | `readonly` ceiling | only `READONLY_TOOL_NAMES` pass; **network read additionally hard-denied** (`work-mode.ts:150-155`); everything else D before base. |
| `PLAN` | `readonly` (if PM ∈ {`allowlist`,`readonly`}) else `plan` | ceiling = `plan` handler (readonly + todo/delegate/submit); network read requires gated approval (`work-mode.ts:179-187`). |

### D.3 Owner's target matrix — representability today (UNKNOWN where unverified)

| WorkMode | PermissionMode | Today's equivalent | Verdict |
|---|---|---|---|
| DISCUSS | AUTO | `workMode=DISCUSS` + `permissionMode="auto"` → ceiling `readonly`, network denied, no prompts | **Representable** (="auto" under DISCUSS ceiling). |
| DISCUSS | ASK | `workMode=DISCUSS` + `"ask"` → ceiling `readonly` (no prompts possible; ask is effectively moot) | **Representable**, but ASK adds nothing (ceiling never prompts). |
| PLAN | AUTO | `workMode=PLAN` + `"auto"` → ceiling `plan`, network read needs gated approval | **Representable**, with caveat: network read still prompts. |
| PLAN | ASK | `workMode=PLAN` + `"ask"` → ceiling `plan` | **Representable**. |
| BUILD | AUTO | `workMode=EXECUTE` (internal) + `"auto"` | **Representable**, with caveat: gated tools still prompt (§A.4). |
| BUILD | ASK | `workMode=EXECUTE` + `"ask"` | **Representable**. |

The only genuine "cannot be represented" case is the **product-facing name**: there is no `BUILD` identifier anywhere (`grep` for `"BUILD"` as a WorkMode value returns no definition; only `EXECUTE` exists). The cleanest mapping is that `BUILD` is a display/renaming concern layered over `EXECUTE`, not a new enum — see §H.

---

## E. Redundancy and responsibility analysis (all six values)

### E.1 `auto` — the intended AUTO approval policy

- **Behavior** (`permission.ts:483-501`): read always; gated → `promptAskOr`; file write allowed; internal write allowed; `code_run` requires sandbox; `bash` after `bash-guard`; everything else deny.
- **Assessment:** This *is* the intended `AUTO` approval policy ("no routine approval"). It is already autonomous for ordinary BUILD work. The only residual prompts are the gated class.
- **Overlap:** `auto` overlaps `allow-all` (both suppress routine approval) but differs on the gated class (auto still prompts; allow-all silently allows). This is a *fine-grained* and correct distinction on the approval axis, but the shared surface invites confusion.
- **Recommended target:** `PermissionMode.AUTO` (retain). **Residual question (owner):** whether `git_commit`/`delegate_task` remain gated under BUILD+AUTO, or move into "allowed-autonomously" under a Tool Access Policy.

### E.2 `ask` — the intended ASK approval policy

- **Behavior** (`permission.ts:457-482`): read always; `NO_PROMPT_TOOLS` (`todo_write`,`submit_result`,`bash_output`,`bash_kill`) allow; allowlist/`always` match allow; `bash` guard; gated → gated prompt; otherwise generic prompt (`gatedPrompt(..., requireTTY=false)`).
- **Assessment:** This is a coherent `ASK` policy and is genuinely distinct from `auto` (it prompts on file writes and bash, whereas auto does not). Independent of every capability restriction in the enum.
- **Recommended target:** `PermissionMode.ASK` (retain).

### E.3 `readonly` — a capability restriction, not an approval policy

- **Behavior** (`permission.ts:419-420`): allow iff `READONLY_TOOL_NAMES` (18 tools); deny otherwise, *never* prompts.
- **All source/runtime references:** the decision handler itself; the WorkMode ceiling (`work-mode.ts:89-98` builds a `readonly` handler); `createMinicodeSession` `livePermissionMode` default for injected handlers (`session.ts:430`); `livePosture` no-progress posture (`session.ts:319,324`); scheduler child metadata (`setup.ts:3240`); read out in `task.ts` forced-explore check (`parentMode === "readonly"`, `:267`); tests (`test/permission-matrix.test.ts`, `test/phase2-security.test.ts:417`, `test/work-mode-contract.test.ts:41`).
- **User-facing entry points:** **none.** No CLI flag (`--readonly` absent from `args.ts`), not in TUI `MODES`, not in ACP `mode`. It is reachable only through the WorkMode DISCUSS surface and internal seams.
- **Assessment:** `readonly` is *already* an internal capability restriction. It is **not** a user-facing approval policy. It is exactly the kind of value the owner wants to move into a Tool Access Policy.
- **Security implication:** It is *not* the scheduler-child security boundary (that is the injected AutonomousPermissionHandler — see §B.5). It *is* still used as the DISCUSS ceiling primitive, so removing the enum value would require the ceiling to obtain its "read-only tool set" from the Tool Access Policy/`READONLY_TOOL_NAMES` directly (already available via `tool-contract.ts`).
- **Recommended target:** Tool Access Policy ("capability set: read-only"), not PermissionMode.

### E.4 `plan` — approximate capability restriction that duplicates WorkMode PLAN

- **Behavior** (`permission.ts:427-433`): `readonly` + `todo_write` + `delegate_task` + `submit_result`.
- **All references:** decision handler; WorkMode PLAN ceiling (`work-mode.ts:74-77,92-97`); `livePosture` (`session.ts:322`); RAG `trackAccess` guard (`setup.ts:1226-1228`); verify/hooks guards (`setup.ts:2396,2827`); `task.ts:267` forced-explore; `--plan` CLI flag (`index.ts:278`), `/mode plan` (`tui.ts:50`); ACP `mode:"plan"` (`acp.ts:120-122`); planHint system prompt (`session.ts:213-214,434`).
- **Assessment:** `plan` is *both* a PermissionMode (user-facing: `--plan`, `/mode plan`, ACP `mode")` **and** the building block of WorkMode PLAN's ceiling. This is the clearest duplication in the system: **PermissionMode `plan` ≡ WorkMode PLAN's ceiling set exactly** (same `todo_write`+`delegate_task`+`submit_result` extras, same `READONLY` base — compare `permission.ts:427-433` with `tool-layer.ts:20,45` "PLAN_EXTRA").
- **Semantic tension:** `plan` is not an "approval policy". It is a "read-only + tiny-plan-artifact" capability restriction. Its presence in the approval enum is what makes the two-axis model ambiguous to users (does `--plan` mean "planning WorkMode" or "plan permission mode"?).
- **Recommended target:** capability restriction under Tool Access Policy (or fold its tool set into WorkMode PLAN only). User-facing `--plan`/`/mode plan` need a compatibility decision (§I.3).
- **Security implication:** removing the plain `plan` PermissionMode is safe *only if* the WorkMode PLAN ceiling continues to be expressed via the same tool-set (it can keep reusing a Tool-Access-Policy "plan-capable" set). PLAN correctness is *not* tied to the enum value's name.

### E.5 `allowlist` — a bash/tool capability restriction

- **Behavior** (`permission.ts:434-456`): for `bash`, `bash-guard` then `DEFAULT_BASH_ALLOWLIST`/`MINICODE_BASH_ALLOWLIST` pattern match, plus npm/npx "unsafe arg" check; gated tools deny; `FILE_WRITE_TOOLS` and `INTERNAL_WRITE_TOOLS` allow; otherwise `READONLY_TOOL_NAMES` allow.
- **Assessment:** This is a *capability/restriction* policy (restrict shell to a safe allowlist; still allow jailed file-write tools). It is not an approval policy. It is also used as the **fallback permission when no OS sandbox is available** (`index.ts:409`, `exec.ts:91`, `doctor.ts:76-80`).
- **Distinctness:** `allowlist` is also the *name of the persistent grant mechanism* (`~/.minicode/allowlist.json`, `saveAllowlist`, `matchAllowlist`), which is a **different concept** (approval `always` grants). This name collision is itself a source of confusion.
- **Recommended target:** Tool Access Policy ("bash capability: allowlist"). Note the naming conflict with the `always`-grant allowlist store must be disambiguated.

### E.6 `allow-all` — privileged override, unsafe combination of concerns

- **Behavior** (`permission.ts:418` + `:618-631`): returns allow for everything except `bash` still passes `bash-guard`, and the universal jail still runs (defense-in-depth).
- **Assessment:** `allow-all` simultaneously (a) suppresses approval, (b) suppresses capability restriction, and (c) is documented as *not* turning off hard jail/guard. As a *user-facing* "mode" it is arguably a privileged override, not an approval policy. Its name ("allow-all") misleadingly suggests total permission while the jail still denies out-of-workspace/sensitive/owned-state writes.
- **UI inconsistency:** `allow-all` is reachable via `--allow-all` **and** `/mode allow-all`, but Tab cycling explicitly **skips** it (`tui.ts:268-270`) with the comment "allow-all hanya via flag --allow-all" — which is factually inaccurate given `/mode` also accepts it. This is a concrete UI/backend naming mismatch (§G).
- **Recommended target:** retire as a PermissionMode; if a privileged override is genuinely required, isolate it as a distinct mechanism with an explicit, non-misleading label and keep the jail/guard always-on (which they already are).

---

## F. Security assessment

### F.1 Hard-deny behavior (cannot be bypassed by AUTO, ASK, allow-all, or any WorkMode)

The following are enforced **before** the `allow-all` short-circuit and every per-mode handler (`permission.ts:514-631`), and therefore cannot be bypassed by any mode value:

- File-path jail: `write_file`/`edit`/`apply_patch`/`read_file`/`read_image`/`delete_file` path must be inside root and not sensitive (`isRealPathOutsideRoot` + `isSensitive`, `:514-528`).
- `move_file` from+to both jailed (`:531-538`); `lsp_*` file jailed (`:539-543`).
- `cwd` outside root for `bash`/`glob`/`grep`/`git_*` (`:544-554`); `git_commit` staged paths jailed (`:556-562`).
- Owned-state (`.minicode/`) write protection, symlink/junction-aware (`:582-615`).
- `bash-guard` (`inspectBashCommand`) runs in `allowlist`, `ask`, `auto`, **and** `allow-all` (`:495-499`, `:465-469`, `:622-629`). Destructive commands are denied in every mode.
- The approval-binding barrier (`session.ts:360-400`) adds a second-layer fail-closed re-verification that the file target hasn't changed since approval.

**Answer to §6 Q1: No.** AUTO cannot bypass a hard-deny rule. **Q2:** allow-all bypasses mode restrictions but *does not* bypass jail/owned-state/bash-guard — it is not a blank "privilege escalation" over hard rules, though it *does* suppress the gated-approval and capability layers.

### F.2 Privileged override / privilege escalation paths

- **allow-all** is the only runtime "override", and it is obtained only by explicit operator flag/env or `/mode allow-all`. It remains bounded by jail/guard. Risk is *intentional* (operator opt-in).
- **Child escalation via `delegate_task`:** A restricted parent (`readonly`/`plan`/`ask`) force child to `explore` (`task.ts:266-268`), so no escalation. But an `allowlist` parent is **not** in the forced-explore set — it will delegate with `permissionMode: "allowlist"` (child inherits `allowlist`, `:505`), so no escalation either. The only "wider child" scenario is the documented `plan` sub-agent mode under an `auto`/`allow-all` parent — where the parent was already unrestrictive.
  - Edge case worth flagging: **`auto`/`allow-all` parent does not force explore**, and a child `mode="plan"` then receives the *full base tool set minus 8 stripped tools* (`task.ts:314-315`), i.e. the child can write files and run bash. This is not escalation (parent was already `auto`/`allow-all`), but it is an *intent coupling* worth documenting under the future Tool Access Policy.
- **`readonly` is not the scheduler boundary.** If one naively "removed readonly to reduce the enum", one must **not** touch the injected `permissionHandler` seam; see §B.5. The autonomous policy (`createAutonomousPermissionHandler`) is the real boundary and it never prompts and denies unknown tools by default (`autonomous-policy.ts:445-470`).
- **Resume over-privilege (`§6 Q8`):** PermissionMode is **not** persisted (it is re-derived from flags each invocation); WorkMode **is** persisted (`work_mode` column) and restored on `--resume` only when no explicit signal (`setup.ts:981-983`). A legacy session with `work_mode = NULL` falls back to `EXECUTE` (default), not to a more restrictive value — this is fail-open-by-default for WorkMode but is bounded by the permission mode (recital at `setup.ts:1266-1273`). No path restores an *over*-privileged **mode**; the only over-privilege risk is an operator omitting `--work-mode` on resume of a formerly-DISCUSS/PLAN session, which is surfaced with a stderr notice.
- **CLI/internal-default escalation (`§6 Q9`):** `--enable-scheduler` is flag-only (not env-inheritable, `index.ts:298-316`) precisely to avoid child/MCP inheritance enabling autonomous execution. This is correct and worth preserving in any migration.

### F.3 Final security enforcement points (ranked)

1. `PermissionHandler.check` (composed `withEffectBarrier` → `work-mode` ceiling → base `permission.ts` handlers → universal jail/guard). This is the **single authoritative boundary** the kernel consults before every tool execution (`vendor/minicore/core/permission.ts:1-23`).
2. The **approval-binding barrier** (`session.ts:360-400`) re-verifies no stale/tampered target at the execution boundary.
3. The **autonomous policy** for scheduler children (`autonomous-policy.ts`) — fail-closed, no prompt, deny-unknown.
4. The **tool layer** (`tool-layer.ts`) only controls *visibility* (which tools the model sees); it is not the enforcement boundary — but it is kept in lockstep (`visible === callable`) so the model isn't offered tools that will be denied.

**Answer to §6 Q10 (binding correctness):** approval `always` grants are persisted as `name + full JSON args` keys (`permission.ts:399-405`, `allowlist.ts:67-78`), scoped by cwd (`root`), and the approval-binding store is per-session (`session.ts:252-253`). Allowlist `always` grants are matched against the exact call (name+args), not a blanket tool grant — no cross-scope leak identified. The daemon path binds approvals via the durable `ApprovalBroker` (`daemon.ts:332-335`).

---

## G. UI and UX mismatch

1. **`BUILD` vs `EXECUTE`.** The product name `BUILD` is absent; all surfaces show `EXECUTE` (`footer.ts:28`, `tui.ts:483`, `i18n` strings, `--work-mode` help text `index.ts:260`). This is the only *hard* naming gap and can be resolved as a display-layer rename (recommended) rather than an enum migration — `parseWorkModeValue` normalizes case, so adding a `BUILD` display alias without touching the internal `EXECUTE` identity is feasible if `BUILD` is accepted as a case-insensitive alias.

2. **`readonly` is invisible.** There is no CLI flag, no `/mode` value, and no footer state named `readonly`. Users can only *observe* read-only as the WorkMode `DISCUSS` ceiling or as the internal scheduler-child posture. The `PermissionControl` type (`session.ts:66-69`) and `PermissionMode` type still advertise `readonly`, but the UI never surfaces it. This is a benign *type surface exceeds UI surface* mismatch, but it is exactly the "exposes a mode that cannot be selected" case.

3. **`allow-all` "flag-only" comment is wrong.** `tui.ts:268` says "allow-all hanya via flag --allow-all (paritas REPL)", but `/mode allow-all` (`tui.ts:447-454`) also selects it. Tab cycling skips it, so the *two* selection surfaces disagree. A user reading the documentation believes `allow-all` requires a restart with `--allow-all`, but they can silently reach it mid-session.

4. **`/mode` and `Tab` share PermissionMode; `/work-mode` is separate but visually coupled.** The footer merges them as `PLAN·auto` only when WorkMode is non-EXECUTE (`footer.ts:69-79`). This is actually well-designed, but the *presence* of `plan` in **both** `/mode` and `/work-mode` (`/mode plan` vs `/work-mode PLAN`) is a standing source of user confusion: two commands with overlapping names but different meanings.

5. **`--plan` (permission) vs `--work-mode PLAN`.** The CLI resolution comment explicitly warns "`--plan` (permission mode) TIDAK disamakan dengan WorkMode PLAN" (`index.ts:289-290`), acknowledging the ambiguity in code — but a user has no way to know the difference from the surface.

6. **`allowlist` name collision.** `/mode allowlist` and `--allowlist` select the bash capability restriction, but the *same word* is used for the persistent `always`-approval file (`~/.minicode/allowlist.json`). Two unrelated concepts share one token.

7. **Daemon always `ask`, ACP always `auto`/`plan`.** The three entry points surface *different* permission vocabularies: TUI/CLI expose 5 of 6 (all but `readonly`), ACP exposes only `auto`/`plan` (`acp.ts:95`), daemon hardcodes `ask` (`daemon.ts:325`). There is no single source of truth for "which modes a given surface can accept".

None of these are, by themselves, a security hole — but 3, 4, and 5 are genuine UX/backend coherence problems that the target two-axis model would eliminate.

---

## H. Target architecture proposal

The owner's intended architecture is **sound and supported by the evidence**; this audit does not recommend an alternative, only clarifications.

### H.1 Three concerns, three layers

| Layer | Role | Values today | Target |
|---|---|---|---|
| **WorkMode** | Operating posture / behavior boundary | `DISCUSS`/`PLAN`/`EXECUTE` | `DISCUSS`/`PLAN`/`BUILD` (`BUILD` == display name over `EXECUTE`) |
| **PermissionMode** | Approval policy | `auto`/`ask`/`readonly`/`plan`/`allowlist`/`allow-all` | `AUTO`/`ASK` only |
| **Tool Access Policy** | Capability + hard security enforcement | split across `readonly`/`plan`/`allowlist` handlers + `READONLY_TOOL_NAMES` + jail + `autonomous-policy` | single consolidated policy with: hard-deny (jail/owned-state/bash-guard), capability sets (read-only / plan-capable / bash-allowlist), privileged-gated class, session/scheduler/child inheritance |

### H.2 The concrete mapping (already 80% present)

The `Tool Access Policy` already *exists in substance*, just not as a named object:

- Hard-deny = the universal jail/guard block (`permission.ts:514-631`) — already runs before every mode.
- Capability sets = `READONLY_TOOL_NAMES`, `LOCAL_READONLY_TOOL_NAMES`, `NETWORK_READ_TOOL_NAMES`, `PLAN_EXTRA`, `DEFAULT_BASH_ALLOWLIST`, `GATED_TOOLS`, `AUTONOMOUS_TOOL_NAMES` — all already **derived from a single contract registry** (`tool-contract.ts`).
- Child/scheduler inheritance = already wired via `permissionHandler` injection + `setSubAgentWorkMode` + sub-agent tool-stripping.

The clean target does **not** require a new permission engine; it requires *re-typing* the approval axis to 2 values and *re-homing* the capability values into the Tool Access Policy.

### H.3 Why this is safe (not merely cosmetic)

1. `auto` and `ask` are already the only two *approval* behaviors; the other four are capability/override.
2. WorkMode DISCUSS/PLAN ceilings already *reuse* the `readonly`/`plan` capability handlers as primitives (`work-mode.ts:89-98`) — the capability sets already have an independent existence via `tool-contract.ts`, so the ceiling can be re-expressed against the Tool Access Policy directly.
3. The scheduler boundary is already the injected `AutonomousPermissionHandler`, *not* `readonly` (§B.5).
4. The full test matrix (6×3) already exists (`test/work-mode-contract.test.ts`, `test/permission-matrix.test.ts`, `test/work-mode-matrix.ts` helper) and can be repurposed to protect the migration.

### H.4 The one genuine behavioral gap to resolve as an owner decision

Whether **BUILD + AUTO** may auto-approve the currently-gated class (`git_commit`, `delegate_task`, and the MCP read/prompt/call tools). Evidence shows `auto` already auto-allows everything *except* these. Two consistent resolutions:

- **(a) Keep them approval-gated** under AUTO (they become "privileged capabilities" in the Tool Access Policy). Then "full autonomous" means "full autonomous *except* privileged/catalog-class actions", which is a defensible and conspicuously-safer reading of the owner's own hard-line "AUTO ≠ allow-all".
- **(b) Move `git_commit` (and optionally `delegate_task`) out of the gated class** for BUILD+AUTO only, so a BUILD task can commit without prompting.

This audit recommends **(a) as the default** (it is the current behavior and the owner's security principles already rule out "silently grant capabilities"), with (b) as an explicit opt-in — but this is an owner decision recorded in §J.

---

## I. Migration plan (ordered, not executed)

> All steps preserve backward compatibility; no old flag/enum/session is silently reinterpreted.

### I.0 Precondition — guardrail tests

Before any code change, add regression tests that pin **current** behavior and must stay green through the migration:

- 6×3 decision matrix (`test/work-mode-contract.test.ts`), `permission-matrix.test.ts` (already exist).
- New: "approval axis is 2-valued" invariant (auto vs ask) and "capability axis lives in Tool Access Policy" invariant.
- New: persisted-session interpretation — `loadSessionWorkMode(NULL)` → EXECUTE, and `--resume` without `--work-mode` restores persisted value.
- CLI/TUI surface parity: `--allow-all` and `/mode allow-all` both resolved; `readonly` not surfaced.

### I.1 Ordering

1. **Introduce a `ToolAccessPolicy` type** (no behavior change): a data object referencing `READONLY_TOOL_NAMES`/`LOCAL_READONLY_TOOL_NAMES`/`NETWORK_READ_TOOL_NAMES`/`PLAN_EXTRA`/`DEFAULT_BASH_ALLOWLIST`/`GATED_TOOLS` plus the hard-deny block. The existing `permission.ts` handlers become thin wrappers over it. This isolates the capability dimension without moving any runtime behavior.
2. **Narrow the PermissionMode approval axis to `auto`/`ask`** in *new* call sites while keeping the 6-value type as a deprecated superset for one release (type alias `PermissionMode = "auto" | "ask" | (DeprecatedPermissionMode)`). Residents:
   - `allowlist` face → Tool Access Policy "bash-allowlist" (the handler already exists; re-home only the `--allowlist`/`/mode allowlist`/ACP resolution to select the *policy* while continuing to translate it into the equivalent handler internally, so no runtime change).
   - `readonly` face → already internal; keep as an internal Tool Access Policy capability set.
   - `plan` face → re-home to WorkMode `PLAN` + a "plan-capable" capability set; keep `--plan`/`/mode plan`/ACP `mode:"plan"` as **deprecated aliases** that map to `workMode=PLAN` for one release.
   - `allow-all` face → re-home to a distinct `--privileged`/override option (rename the label, keep the `--allow-all` alias as deprecated).
3. **Add `BUILD` display alias for `EXECUTE`** (accept `--work-mode BUILD` and `/work-mode BUILD` as case-insensitive aliases that map to the internal `EXECUTE` identity), without renaming any identifier.
4. **Fix the `/mode allow-all` vs Tab discrepancy** (make the two surfaces agree — whichever way the owner chooses — and correct the `tui.ts:268` comment).
5. **Decide the gated-class question** (§H.4) and implement only if owner chooses (b).
6. **Remove deprecated values** only after one release cycle with a deprecation notice, once no persisted session or script references them.

### I.2 Affected files (referred, not touched in this audit)

- `src/policy/permission.ts`, `src/policy/work-mode.ts`, `src/policy/tool-contract.ts`, `src/app/session.ts`, `src/app/tool-layer.ts`.
- `cli/args.ts`, `cli/index.ts`, `cli/setup.ts`, `cli/tui.ts`, `cli/commands.ts`, `cli/commands/exec.ts`, `cli/commands/acp.ts`, `cli/commands/daemon.ts`.
- `src/hooks/run.ts`, `src/tools/task.ts`, `src/task/autonomous-policy.ts`, `src/session/persistence.ts`, `src/ui/footer.ts`, `src/ui/i18n/{en,id}.ts`.
- Tests: `work-mode-*`, `permission-matrix`, `phase2-security`, `agent-contract`, `cli-help-language`, `writer-inventory`.

### I.3 Compatibility implications

- **Persisted sessions:** `work_mode` column already accepts `DISCUSS/PLAN/EXECUTE`; a `BUILD` alias must be **normalized back to `EXECUTE` before persistence** (`saveSessionWorkMode`) so stored values remain stable. Old `NULL` → `EXECUTE` unchanged.
- **Config/CLI flags:** `--plan`, `--ask`, `--allow-all`, `--allowlist` must not be deleted in one step; keep as deprecated aliases for at least one release and print a one-line `[deprecated]` notice (the repo already has this pattern for `--tui`).
- **Data migration:** none required for the approval/capability split. The only data-shaped change is `BUILD`→`EXECUTE` normalization in the WorkMode column (no schema change needed; the column already stores the 3-value union).

### I.4 Security tests / regression tests

- Hard-deny still blocks in every mode including the new override (jail/owned-state/bash-guard).
- Scheduler child still uses `AutonomousPermissionHandler`, never a revocable readonly mode (assert `permissionHandler` injected; assert `web_fetch` denied).
- Child inheritance invariants unchanged: restricted/ask parent → forced explore; allowlist parent → allowlist child; no child can exceed parent ceiling.
- `BUILD+AUTO` gated-class behavior is explicitly pinned (whatever owner decides in §H.4).

### I.5 Rollback

Each step is behind a compile-time feature boundary; reverting any step returns the 6-value behavior because the handlers are unchanged under the wrapper. The one-way decision is only the final "delete deprecated values" step, which is deferred until after a release cycle with runtime deprecation warnings.

---

## J. Unresolved questions (genuine owner decisions only)

1. **`BUILD + AUTO` and the gated class:** may an autonomous BUILD agent auto-run `git_commit` and/or `delegate_task`, or do these remain permanently approval-gated as "privileged capabilities" in the Tool Access Policy? (Default recommendation: keep gated.)
2. **`EXECUTE` → `BUILD` migration depth:** is `BUILD` a *display-only* layer over the internal `EXECUTE` identity (recommended — avoids data migration), or must the internal enum be fully renamed (which would also require the `work_mode` column's stored vocabulary to change)?
3. **`allow-all` disposition:** retire entirely (with hard-deny always-on), or retain as a distinctly-labeled privileged override? If retained, what is the honest label (`--privileged`?) given the jail/guard already bound it?
4. **`--plan` future:** after the split, should `--plan` (the permission flag) become a deprecated alias for `--work-mode PLAN` (one "plan" concept), or remain an independent "read-only + plan artifacts" capability even under EXECUTE WorkMode?
5. **`allowlist` naming:** the persistent `always`-grant file and the bash-restriction concept both use "allowlist"; does the owner want the grant store renamed (`grants.json`?) to remove the collision?

(All owner decisions already stated in the prompt — the target is WorkMode DISCUSS/PLAN/BUILD, PermissionMode AUTO/ASK, Tool Access Policy separate — are taken as settled and are **not** re-asked here.)

---

## K. Final verdict

**`ARCHITECTURE_MISMATCH_CONFIRMED`**

The owner's hypothesis is confirmed by the evidence:

- WorkMode and PermissionMode are *not* cleanly separated in responsibility. WorkMode (DISCUSS/PLAN/EXECUTE, correctly 3-valued and already an "intent + ceiling" layer) is implemented by re-using the PermissionMode `readonly`/`plan` capability handlers as primitives, while PermissionMode carries a 6-value union that conflates approval policy (`auto`/`ask`), capability restriction (`readonly`/`plan`/`allowlist`), and privileged override (`allow-all`).
- `readonly` is already an internal-only capability restriction (never user-facing), `plan` duplicates WorkMode PLAN's restriction set, `allowlist` is a bash-capability policy, and `allow-all` is an override that combines two concerns. `auto` and `ask` are the only two genuine approval policies and are already behaviorally the AUTO/ASK the owner intends.
- `BUILD + AUTO` is *substantially* autonomous (ordinary writes/bash/code_run run unprompted) but is not *fully* autonomous: the gated class (`git_commit`, `delegate_task`, MCP read/prompt/call, `ask_user`) still interrupts, which is a deliberate and defensible security boundary rather than a defect — but it must be surfaced as an explicit owner decision rather than assumed.
- Hard security boundaries (jail/owned-state/bash-guard, the approval-binding barrier, and the scheduler's injected `AutonomousPermissionHandler`) are correctly *already separate* from the approval axis and would survive the migration. The one risk to avoid is mistaking `readonly` for the scheduler security boundary and removing it naively.

The migration toward the target architecture is small, evidence-backed, and does not require a new permission engine — only a re-typing of the approval axis to two values, re-homing of the capability values into a (mostly already-existing) Tool Access Policy, and a display-level `BUILD` alias for `EXECUTE`.