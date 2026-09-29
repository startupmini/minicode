# Phase 6S — Autonomous Permission & Tool Policy

**Verdict: GO** for the policy layer. The Scheduler remains disabled, unwired and
unreachable; nothing in this phase enables it.

Commit: `feat: establish autonomous permission policy`
Baseline: `c8fb4eb` (Phase 6R) — clean tree, 44 commits ahead of `origin/main`, nothing pushed.

---

## 1. What this phase establishes

An explicit, structural permission and tool policy for autonomous Scheduler
execution, defined as:

> **AUTONOMOUS → READ-ONLY EXPLORATION → NO HUMAN APPROVAL EVER REQUESTED**

6R built the *isolated context* (child session, own abort, own busy domain) and
restricted the tool **set**. What 6R could not do is stop a call it never saw.
This phase adds the second half: a check on every **invocation**, at the boundary
the kernel itself guarantees it consults, plus a capability matrix that justifies
every tool's verdict and produces a deterministic `permission-denied` outcome.

---

## 2. Findings

### F1 — `permissionMode` is a request, not a guarantee *(severity: high)*

`FACT` — `src/policy/permission.ts:503-508` exposes `__setMode(m)` and
`__getMode()` on the handler returned by `createPermissionHandler`, used by the
TUI for Shift+Tab permission switching.

`FACT` — `src/policy/permission.ts:287-288` — the `readonly` handler is a bare
set lookup: `READONLY_TOOLS.has(call.name) ? "allow" : deny(...)`.

`INFERENCE` — 6R's `permissionMode: "readonly"` therefore does not *guarantee*
read-only for the life of the execution. Any holder of that handler can revoke
the mode at runtime. An autonomous execution sharing it could be switched to
`allow-all` mid-turn and would have no way to know.

`EVIDENCE` — test `E4` proves this is not hypothetical: a well-formed in-workspace
`write_file` is `deny` under `readonly` and `allow` immediately after
`__setMode("allow-all")`.

`DESIGN DECISION` — the autonomous context does not receive a *mode* at all. It
receives a **handler** built from the capability matrix, which has no
`__setMode`/`__getMode` seam. The mode-mutation attack surface is closed by
absence rather than by discipline. `E4b` additionally pins the handler as
*structurally assignable* to the kernel's `PermissionHandler` (a type-level test,
deliberately) so the composition root needs no cast — a cast would hide exactly
the shape mismatch that would otherwise break the wiring.

### F2 — a creation-time allow-list cannot see tools added at runtime *(severity: high)*

`FACT` — `src/tools/index.ts` `withMcpTools()` appends MCP tools to a tool list
at runtime, named `serverid.toolname`, and nothing constrains what an MCP server
exposes.

`FACT` — `vendor/minicore/src/core/permission.ts:1-2` — the kernel "commits to
consulting this handler before every tool execution".

`INFERENCE` — 6R's gate, evaluated once at context construction, proves nothing
about a tool that appears afterwards, and nothing about a path the construction
check never traversed.

`DESIGN DECISION` — **two gates, both retained, neither considered redundant:**

| gate | when | what it is good for |
|---|---|---|
| `assertAutonomousToolScope` | context construction | fails fast on a misconfigured composition root, before any turn runs |
| `createAutonomousPermissionHandler` | every invocation | authoritative, per-call, survives a growing registry |

`EVIDENCE` — `C2`: a cold `github.create_issue` call is `deny` with reason
`UNKNOWN_TOOL`, though no creation-time list ever contained it.

### F3 — the kernel's lack of a `DEFER` decision is survivable here *(severity: informational)*

`FACT` — `vendor/minicore/src/core/permission.ts:12` — `Decision` is
`allow | deny`; a handler needing approval is expected to *block* until it
resolves.

`DESIGN DECISION` — the autonomous handler answers `deny` **synchronously and
immediately**, always. It never calls an approval callback, never awaits a human,
and therefore cannot hang. The two-state vocabulary is sufficient precisely
because the policy never needs to defer: it never asks.

`EVIDENCE` — `C4` races `check()` against a 200 ms timer and requires
`decided:deny`, not `HUNG`. `B4`/`C1` cover `ask_user`, the case where waiting
would deadlock.

### F4 — a refusal must be a terminal outcome, even when the turn "succeeds" *(severity: high)*

`INFERENCE` — the model can catch a denial, apologise in prose and return a
confident summary. `run()` then resolves normally and its exit code says nothing
about what happened.

`DESIGN DECISION` — a recorded denial makes the turn `permission-denied` with
`ok: false`, checked **before** success is reported. Reporting `returned` would
tell the Scheduler the autonomous execution SUCCEEDED, and 6P would then be free
to commit that claim while the work was never permitted, let alone done.

`DESIGN DECISION` — on the error path the policy verdict is consulted **before**
the `busy` regex heuristic: a deterministic fact outranks a guess read out of an
error message.

`EVIDENCE` — `D1` (refusal + confident summary ⇒ `permission-denied`),
`D2b` (refusal + thrown error ⇒ `permission-denied`), `D2c` (error with no
refusal ⇒ plain `error`, so `D2b` cannot be satisfied by refusing everything),
`D4` (clean turn ⇒ `returned`; the gate is not noisy).

### F5 — 6S is deliberately stricter than interactive `readonly` *(severity: medium)*

`FACT` — `src/policy/permission.ts:31-50` — the existing `READONLY_TOOLS` set
includes `web_fetch` and `web_search`.

`DESIGN DECISION` — 6S denies both. For a human typing a URL this is a read. For
an unattended executor it is an outbound request nobody asked for, whose response
becomes model input — an uncontrolled injection channel with no operator present
to notice. The divergence is asserted in `E5` so it stays deliberate rather than
drifting back.

### F6 — PRE-EXISTING 6R REGRESSION: the architecture map was never updated *(severity: medium)*

`FACT` — `test/architecture-map.test.ts:14-21` enumerates files with
`git ls-files`, so it covers tracked `src/**` only.

`FACT` — before this phase, `docs/ARCHITECTURE.html` contained no occurrence of
the string `autonomous`, while `autonomous-context.ts` and `autonomous-adapter.ts`
were tracked and committed in 6R. The guard failed.

`INFERENCE` — the 6R report records a full-suite baseline of 3 failures, so this
failure was either introduced after that run or not observed. Either way it was a
real, latent full-suite failure in the committed tree at `c8fb4eb`.

`ACTION` — all three files are now mapped (`autonomous-policy.ts`,
`autonomous-context.ts`, `autonomous-adapter.ts`). The guard is green. This is
recorded here rather than quietly fixed because the 6R baseline claim was
inaccurate.

### F7 — pre-existing flake, unrelated to 6S *(severity: low)*

`FACT` — `test/phase4b-isolation-lifecycle.test.ts:208` asserts a filename does
**not** contain `"12"`, but the filename is a random UUID
(`mcp-7bfc19af-….json`). Three runs gave 8/0, 8/0, 7/1.

`INFERENCE` — substring collision with a random UUID. Not introduced by 6S and
not fixed here, because it is outside this phase's scope and the correct fix
(scoping the assertion to a date-like pattern) belongs to its own owner.

### F8 — the first mutation harness silently destroyed the working tree *(severity: process)*

`FACT` — the initial campaign restored mutants with `git checkout -- <files>`.
`autonomous-policy.ts` is untracked, and `git checkout` errors on an unmatched
pathspec **without reverting either file**. Every mutant therefore accumulated,
and the final restore was a no-op that left ten mutants applied.

`ACTION` — the harness now snapshots both files in memory and restores by
writing. Verified: after the campaign the tree is intact and all tests pass.
Recorded because a mutation report produced by a broken harness is worse than no
report — it would have claimed kills that proved nothing.

---

## 3. The capability matrix

`FACT` — 37 tools in `allTools`; 16 classified autonomous, 21 denied. `A1` fails
if any registered tool is unclassified; `A2` fails if the matrix invents a tool
that does not exist.

| capability | tools | autonomous |
|---|---|---|
| `READ_ONLY` | read_file, read_image, glob, grep, git_status, git_diff, git_log, read_memory, todo_read, mcp_list, lsp_diagnostics, lsp_definition, lsp_references, lsp_hover, lsp_symbols, lsp_workspace_symbols | 15 of 16 |
| `MUTATING` | write_file, edit, apply_patch, move_file, delete_file, write_memory, forget_memory, todo_write, submit_result | no |
| `EXECUTION` | bash, bash_kill, code_run | no |
| `PRIVILEGED` | git_commit, delegate_task, ask_user | no |
| `EXTERNAL_SIDE_EFFECT` | web_fetch, web_search, mcp_read, mcp_prompt, mcp_call | no |

`bash_output` is the single deliberate exception: genuinely `READ_ONLY`, but
denied because a job id is only meaningful beside the `bash` that starts the job.
`A3b` asserts that set **exactly**, because iterating its members let mutation M1
survive.

### Evidence standard, not assertion

Each row carries its basis, and uncertainty resolves against permission:

- `VERIFIED` — read in this repository's own source. `read_file` routes every
  access through `safeOpenRead` (`src/lib/safe-open.ts`): a fresh `realpath` per
  call (TOCTOU-safe), `O_NOFOLLOW` so a symlink cannot be swapped in, and
  `isPathOutsideRoot`/`isSensitive` from `src/policy/jail.ts`. It is confined to
  the workspace and cannot be talked into following a link out of it.
- `VERIFIED` as a task-ownership hazard — `todo_write` can author `TaskStatus`, and
  under 6P `IN_PROGRESS` is a Scheduler-owned execution state. A model that could
  write it could manufacture the appearance of a claim the lineage would trust.
  The sub-agent layer strips it for the same reason (`src/tools/task.ts:189-199`).
- `UNVERIFIED` — `web_fetch`, `web_search`, `mcp_read`, `mcp_prompt`, `mcp_call`.
  The capability is defined by a third party, not by this repository, so it
  cannot be classified and is denied. `mcp_call` is unbounded by construction.
- `NOT IMPLEMENTED` — `delegate_task`. It would create a child with its own
  permission mode (`src/tools/task.ts:257`), a genuine escalation vector. The
  autonomous context has no delegation `sessionFactory` at all, so nesting cannot
  occur — the risk is closed by absence, and the tool is denied anyway.

`DESIGN DECISION` — `AUTONOMOUS_TOOL_NAMES` is **derived** from the matrix by
`filter`, not hand-written. 6R kept a separate hand-maintained list beside the
classification logic: two sources of truth for one policy, free to drift. `A4`
asserts the two are the same set.

`DESIGN DECISION` — `UNKNOWN → deny`. A new tool is deny-by-default until someone
classifies it, so extending the registry cannot silently extend authority.

---

## 4. Evidence

### Tests — 30 pass, 601 assertions

| group | property |
|---|---|
| A | the matrix covers the real registry, invents nothing, carries evidence, and the allow-list is derived |
| B | every mutating/execution/privileged/external tool denied; unknown denied; task-mutation and `ask_user` denied |
| C | the gate allows/denies per invocation; runtime MCP tools denied; deterministic and order-independent; cannot block; explains itself |
| D | refusal ⇒ `permission-denied` even with a confident summary; distinguishable from cancel/error/returned; attributable |
| E | per-execution ledger, no cross-talk; no mode-mutation seam; structurally assignable to `PermissionHandler`; stricter than `readonly` on egress |
| F | randomised: every real tool's verdict follows its classification; allowing ⊆ `READ_ONLY`; monotonicity |

### Mutation — M1–M12, 12 killed / 0 survived

| id | mutant | result |
|---|---|---|
| M1 | `bash_output` becomes autonomous | killed |
| M2 | `read_file` denied | killed |
| M3 | `UNKNOWN` defaults to allowed | killed |
| M4 | gate never denies | killed |
| M5 | records the denial but allows the call | killed |
| M6 | ledger stops recording | killed |
| M7 | `denied` always answers false | killed |
| M8 | drop the post-run denial check | killed |
| M9 | drop the error-path denial check | killed |
| M10 | refusal marked `ok: true` | killed |
| M11 | reintroduce the `__setMode` seam | killed |
| M12 | module-global ledger (cross-talk) | killed |

M8 and M9 initially **survived** — they had become identical mutants, which
exposed that the error-path denial check had no test at all. `D2b`/`D2c` were
added to close it, and M8 was repointed at the post-run branch.

### Process boundary — P1–P5, 5 pass

P1 all 15 mutating/execution/privileged tools denied in a **cold process**;
P2 unclassified tool ⇒ `deny`; P3 37 registered, 0 unclassified;
P4 no `let`/`var` in the policy module, so no module-level state to share;
P5 the policy module has **no runtime imports at all** (type-only), so the thing
that decides what an agent may do cannot itself reach a capability.

### Gates

- 6S suite: 30 pass / 0 fail. 6R regression: 33 pass / 0 fail.
- 6P/6Q/6R + permission + tools + task + scheduler: 219 pass / 3 skip / 0 fail.
- Full suite: **3164 pass / 23 skip / 3 fail** — the 3 known pre-existing
  (`VENDOR.md` ×2, `web ssg` nested list). `tsc` 28 = baseline, zero in new files.
  `biome` clean on all touched files.
- Scheduler reachability: `new Scheduler(` in `src/` = 1, the comment at
  `src/task/scheduler.ts:29`. Actual production constructions: **0**.

### One 6R assertion restated

`B3` asserted the literal phrase `"explicitly forbidden: bash"`. The phrase moved
when the allow-list became derived from the matrix, so the assertion was
restated as the property it protected: *every offending tool is named, whatever
the wording*, plus the unclassified case. Pinning a message string would have
held 6S to wording it is right to change.

---

## 5. Scope kept

Not touched: Scheduler, TaskGraph, lineage, session deletion, approval UI, and
any trigger or enablement path. The two files changed under `src/task` are the
6R context and the new policy module; no existing production behaviour moves.
`AutonomousSessionSpec` gains a `permissionHandler` field, and **no production
composition root consumes it yet** — deliberately, since wiring one is enablement.

---

## 6. Known limits

1. **The matrix is hand-maintained and can drift from the implementation.** `A1`
   proves coverage, not correctness. If `grep` were taught a write mode, the
   matrix would still call it `READ_ONLY` and still pass every test. Deriving
   capability from tool code is the real fix and is out of scope here.
2. **Verdicts are by tool name.** Two tools with one name and different behaviour
   would be treated identically.
3. **`grep`, `read_image` and the `lsp_*` tools spawn processes** (ripgrep, an
   image decoder, a language server). They are classed read-only because this
   repository gives them no write path, not because process spawning is read-only.
4. **No `DEFER`.** Any future autonomous execution that genuinely needs a human
   must be denied, not deferred. That is the correct failure for an unattended
   worker, but it is a limit on what the system can express.
5. **The policy is not yet reachable.** It is proven in-process and at the
   factory seam; nothing constructs an autonomous execution in production.
6. **Pre-existing failures left alone:** the 2 `VENDOR.md` fingerprint checks, the
   `web ssg` nested-list check, and the F7 UUID flake.

---

## 7. GO / NO-GO

**GO** — the autonomous permission policy is established, structural, and
evidence-backed: a justified capability matrix, deny-by-default, enforced at both
construction and invocation, producing an honest terminal outcome that 6P cannot
mistake for success.

**NO-GO** remains correct for **enablement**, on unchanged grounds: the
cross-process live-task recovery limit (D5′), the duplicate crash window, and the
absence of a verifier remain open. This phase made the permission boundary
honest; it did not make autonomous execution safe to switch on.
