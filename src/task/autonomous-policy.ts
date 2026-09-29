// PHASE 6S — AUTONOMOUS PERMISSION & TOOL POLICY.
//
// 6R restricted the tool SET at context creation. That is a fail-fast check on
// configuration, and this phase adds the missing half: a check on every
// INVOCATION, at the boundary the kernel itself guarantees it consults.
//
// ── WHY A SECOND GATE IS NECESSARY, NOT REDUNDANT ────────────────────────────
//
// `withMcpTools()` (src/tools/index.ts) appends MCP tools to a tool list at
// RUNTIME, named `serverid.toolname`, and nothing constrains what an MCP server
// exposes. A name allow-list evaluated once at context creation therefore proves
// nothing about a tool added afterwards, and nothing about a tool reached by a
// path the creation-time check never saw.
//
// The kernel closes this for us: `vendor/minicore/src/core/permission.ts:1-2`
// states it "commits to consulting this handler before every tool execution".
// That is the narrowest authoritative boundary available, and this module
// installs an autonomous handler there. Both gates are retained deliberately:
//
//   creation-time (6R)  fails fast on a misconfigured context, before any turn
//   invocation-time    is authoritative, per-call, and survives a growing registry
//
// Neither alone is sufficient; together the second catches everything the first
// cannot see.
//
// ── THE POLICY ───────────────────────────────────────────────────────────────
//
//   AUTONOMOUS -> READ-ONLY EXPLORATION -> NO HUMAN APPROVAL EVER REQUESTED
//
// [DESIGN DECISION] The kernel's vocabulary is `allow | deny` and a handler that
// wants human input is expected to BLOCK until it resolves
// (`permission.ts:12`). An unattended executor must therefore never reach that
// branch: this handler answers `deny` IMMEDIATELY and SYNCHRONOUSLY, always. It
// never calls an approval callback, never waits, and cannot hang.
//
// The safe default is UNKNOWN -> DENY. A tool absent from the matrix is denied,
// so adding a new tool to the registry is deny-by-default rather than
// accidentally-permitted.

import type { ToolCall } from "#minicore"

// ── capability classification ────────────────────────────────────────────────

export type ToolCapability =
  /** Reads the workspace, confined to it. No external effect. */
  | "READ_ONLY"
  /** Changes local state. */
  | "MUTATING"
  /** Runs a program or shell. */
  | "EXECUTION"
  /** Touches git history, identity, or the machine's authority surface. */
  | "PRIVILEGED"
  /** Reaches outside the machine (network, MCP server, package registry). */
  | "EXTERNAL_SIDE_EFFECT"
  /** Not in the matrix. DENY by default. */
  | "UNKNOWN"

export interface ToolClassification {
  readonly name: string
  readonly capability: ToolCapability
  /** Whether an unattended, unapproved execution may use it. */
  readonly autonomous: boolean
  /** Why the classification is what it is - the evidence, not the conclusion. */
  readonly evidence: string
}

/**
 * [PHASE 6S] The single source of truth for tool behaviour.
 *
 * `VERIFIED` rows were read in this repository's own source. `UNVERIFIED` rows
 * are marked and therefore DENIED - uncertainty is never resolved in favour of
 * permission, which is the whole point of the default.
 *
 * NOT every row is a judgement call. `read_file`, for example, is VERIFIED
 * read-only because it routes every access through `safeOpenRead`
 * (`src/lib/safe-open.ts`), which does a fresh `realpath` per call (TOCTOU-safe),
 * opens with `O_NOFOLLOW` so a symlink cannot be swapped in, and applies
 * `isPathOutsideRoot` / `isSensitive` from `src/policy/jail.ts`. It is confined
 * to the workspace and cannot be talked into following a link out of it.
 */
export const TOOL_CAPABILITIES: readonly ToolClassification[] = [
  // ── filesystem read ──
  {
    name: "read_file",
    capability: "READ_ONLY",
    autonomous: true,
    evidence:
      "VERIFIED: routes through safeOpenRead - fresh realpath per call, O_NOFOLLOW, isPathOutsideRoot + isSensitive jail.",
  },
  {
    name: "read_image",
    capability: "READ_ONLY",
    autonomous: true,
    evidence:
      "VERIFIED (bounded): reads an image from the workspace via the same confined open path; it decodes bytes, it does not fetch them.",
  },
  {
    name: "glob",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: directory enumeration, no write path, no network.",
  },
  {
    name: "grep",
    capability: "READ_ONLY",
    autonomous: true,
    evidence:
      "VERIFIED: spawns ripgrep over the workspace. It is a process, so classified READ_ONLY only because grep has no write mode here; noted in §12.",
  },

  // ── filesystem write ──
  {
    name: "write_file",
    capability: "MUTATING",
    autonomous: false,
    evidence: "creates or overwrites a file.",
  },
  {
    name: "edit",
    capability: "MUTATING",
    autonomous: false,
    evidence: "rewrites file content in place.",
  },
  {
    name: "apply_patch",
    capability: "MUTATING",
    autonomous: false,
    evidence: "applies a diff to the working tree.",
  },
  {
    name: "move_file",
    capability: "MUTATING",
    autonomous: false,
    evidence: "renames or moves a file.",
  },
  { name: "delete_file", capability: "MUTATING", autonomous: false, evidence: "unlinks a file." },

  // ── shell / execution ──
  {
    name: "bash",
    capability: "EXECUTION",
    autonomous: false,
    evidence: "runs an arbitrary command; everything is reachable through it.",
  },
  {
    name: "bash_output",
    capability: "READ_ONLY",
    autonomous: false,
    evidence:
      "reads a background job's stdout. Reading a job id is only meaningful beside bash, so the job is not startable autonomously.",
  },
  { name: "bash_kill", capability: "EXECUTION", autonomous: false, evidence: "signals a process." },
  {
    name: "code_run",
    capability: "EXECUTION",
    autonomous: false,
    evidence:
      "VERIFIED: runs python/node snippets. Its own comment records that it no longer claims to be 'sandboxed' in the weak sense - execution is exactly the capability an unattended agent must not have.",
  },

  // ── git ──
  {
    name: "git_status",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: `git status` - reports the working tree, writes nothing.",
  },
  {
    name: "git_diff",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: `git diff` - reads the index and objects.",
  },
  {
    name: "git_log",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: `git log` - reads history only.",
  },
  {
    name: "git_commit",
    capability: "PRIVILEGED",
    autonomous: false,
    evidence:
      "VERIFIED: writes history and identity. The existing sub-agent layer strips it for the same reason (src/tools/task.ts:189-199).",
  },

  // ── memory (session state) ──
  {
    name: "read_memory",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: reads stored memory.",
  },
  {
    name: "write_memory",
    capability: "MUTATING",
    autonomous: false,
    evidence: "persists memory that outlives the turn.",
  },
  {
    name: "forget_memory",
    capability: "MUTATING",
    autonomous: false,
    evidence: "destroys persisted memory.",
  },

  // ── task / plan ──
  {
    name: "todo_read",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: reads the todo list.",
  },
  {
    name: "todo_write",
    capability: "MUTATING",
    autonomous: false,
    evidence:
      "VERIFIED as a task-ownership hazard, not merely a write: todo_write can author TaskStatus, and under 6P `IN_PROGRESS` is a Scheduler-owned execution state. Letting an autonomous model write it would let a model fabricate a claim the lineage would then treat as real. The existing sub-agent layer strips it for the same reason (src/tools/task.ts:189-199).",
  },
  {
    name: "submit_result",
    capability: "MUTATING",
    autonomous: false,
    evidence: "concludes a delegated unit of work; the sub-agent layer strips it.",
  },
  {
    name: "delegate_task",
    capability: "PRIVILEGED",
    autonomous: false,
    evidence:
      "Escalation vector: it creates a child with its OWN permission mode (src/tools/task.ts:257), so a restricted parent could in principle produce a less-restricted child. Stripped from sub-agents for exactly this reason. Autonomous context has no sessionFactory for delegation at all (6R), so nesting is NOT IMPLEMENTED and cannot occur.",
  },

  // ── network / external ──
  {
    name: "web_fetch",
    capability: "EXTERNAL_SIDE_EFFECT",
    autonomous: false,
    evidence:
      "UNVERIFIED as read-only: an HTTP GET to an operator-supplied URL is not merely a read - it discloses the request to a third party, and the response becomes model input.",
  },
  {
    name: "web_search",
    capability: "EXTERNAL_SIDE_EFFECT",
    autonomous: false,
    evidence: "UNVERIFIED: external service call with the same disclosure property.",
  },

  // ── MCP ──
  {
    name: "mcp_list",
    capability: "READ_ONLY",
    autonomous: true,
    evidence:
      "VERIFIED: enumerates configured servers; discloses configuration but changes nothing.",
  },
  {
    name: "mcp_read",
    capability: "EXTERNAL_SIDE_EFFECT",
    autonomous: false,
    evidence:
      "UNVERIFIED: reads from an external server process whose behaviour is not ours to bound.",
  },
  {
    name: "mcp_prompt",
    capability: "EXTERNAL_SIDE_EFFECT",
    autonomous: false,
    evidence: "UNVERIFIED: retrieves a prompt from an external server.",
  },
  {
    name: "mcp_call",
    capability: "EXTERNAL_SIDE_EFFECT",
    autonomous: false,
    evidence:
      "UNVERIFIED and unbounded: invokes an arbitrary tool on an arbitrary server. The exposed capability is defined by the server, not by this repository, so it cannot be classified and is denied.",
  },

  // ── LSP ──
  {
    name: "lsp_diagnostics",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: asks the language server for diagnostics.",
  },
  {
    name: "lsp_definition",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: goto-definition.",
  },
  {
    name: "lsp_references",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: find-references.",
  },
  {
    name: "lsp_hover",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: hover information.",
  },
  {
    name: "lsp_symbols",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: document symbols.",
  },
  {
    name: "lsp_workspace_symbols",
    capability: "READ_ONLY",
    autonomous: true,
    evidence: "VERIFIED: workspace symbols.",
  },

  // ── human interaction ──
  {
    name: "ask_user",
    capability: "PRIVILEGED",
    autonomous: false,
    evidence:
      "The forbidden case: it blocks a turn on a human who is not present. 6R's prompt tells the model not to call it; this policy makes that structural, because a request is DENIED rather than waiting forever.",
  },
]

const BY_NAME = new Map(TOOL_CAPABILITIES.map((t) => [t.name, t]))

/** Classify a tool name. Anything unrecognised is UNKNOWN and therefore denied. */
export function classifyTool(name: string): ToolClassification {
  return (
    BY_NAME.get(name) ?? {
      name,
      capability: "UNKNOWN",
      autonomous: false,
      evidence: "not present in the matrix - denied by default",
    }
  )
}

/** True only for a tool the matrix marks autonomous. UNKNOWN is never autonomous. */
export function isAutonomousTool(name: string): boolean {
  return classifyTool(name).autonomous
}

/**
 * [PHASE 6S] The allow-list, derived FROM the matrix rather than written
 * separately.
 *
 * [DESIGN DECISION] 6R carried its own hand-written list, which meant the
 * creation-time gate and the classification could drift apart - two sources of
 * truth for one policy. Deriving it removes the possibility: a tool is autonomous
 * if and only if the matrix says so.
 */
export const AUTONOMOUS_TOOL_NAMES: readonly string[] = TOOL_CAPABILITIES.filter(
  (t) => t.autonomous,
).map((t) => t.name)

// ── the ledger ───────────────────────────────────────────────────────────────

export type AutonomousDenialReason = "OUT_OF_SCOPE" | "UNKNOWN_TOOL" | "NOT_AUTONOMOUS"

/**
 * [PHASE 6S] Per-execution record of every denial.
 *
 * One ledger per autonomous context. It exists so the context can turn "the model
 * asked for something it may not have" into the deterministic `permission-denied`
 * outcome that 6R declared but could not produce: the handler sees the call, but
 * the turn's return value alone does not say WHY it failed.
 *
 * [DESIGN DECISION] Owned by the execution, not module-global, so two concurrent
 * contexts cannot read each other's denials.
 */
export class AutonomousPolicyLedger {
  private readonly denials: { tool: string; reason: AutonomousDenialReason }[] = []
  private readonly allowances: string[] = []

  deny(tool: string, reason: AutonomousDenialReason): void {
    this.denials.push({ tool, reason })
  }

  allow(tool: string): void {
    this.allowances.push(tool)
  }

  get denials_(): readonly { tool: string; reason: AutonomousDenialReason }[] {
    return this.denials
  }

  get allowedTools(): readonly string[] {
    return this.allowances
  }

  /** True when at least one call was refused. Drives the `permission-denied` outcome. */
  get denied(): boolean {
    return this.denials.length > 0
  }

  summary(): string {
    return this.denials.map((d) => `${d.tool} (${d.reason})`).join(", ")
  }
}

// ── the invocation-time gate ─────────────────────────────────────────────────

/**
 * Structurally the kernel's `PermissionHandler`; declared here to avoid a kernel
 * type import.
 *
 * [PHASE 6S] The second parameter is `deps` (`ExecutorDeps`), which the kernel
 * passes and this policy deliberately IGNORES. The interactive handler uses it to
 * read the turn's `AbortSignal` and to race a late approval against cancellation;
 * an autonomous decision needs neither, because it never waits for anything. The
 * parameter exists so this type is assignable to the kernel's `PermissionHandler`
 * without a cast — a cast would hide exactly the structural mismatch that would
 * otherwise break the composition root.
 */
export interface AutonomousPermissionHandler {
  check(call: ToolCall, deps?: unknown): Promise<"allow" | "deny">
  describeDenial?(call: ToolCall): string | undefined
}

/**
 * [PHASE 6S] THE AUTONOMOUS PERMISSION HANDLER.
 *
 * [DESIGN DECISION] Answers `deny` synchronously and immediately for anything
 * outside the matrix. It never consults an approval callback, never awaits
 * anything a human must answer, and therefore cannot block. That is the whole
 * reason the kernel's `allow | deny` vocabulary is SUFFICIENT here despite having
 * no DEFER state: the autonomy policy never needs to defer, because it never
 * asks.
 *
 * The decision is data, not control flow: `classifyTool` is a table lookup, so
 * the same input always yields the same decision, and a tool added to the
 * registry later is denied until someone classifies it.
 */
export function createAutonomousPermissionHandler(
  ledger: AutonomousPolicyLedger,
): AutonomousPermissionHandler {
  return {
    check(call: ToolCall, _deps?: unknown): Promise<"allow" | "deny"> {
      const c = classifyTool(call.name)
      if (c.autonomous) {
        ledger.allow(call.name)
        return Promise.resolve("allow")
      }
      const reason: AutonomousDenialReason =
        c.capability === "UNKNOWN" ? "UNKNOWN_TOOL" : "NOT_AUTONOMOUS"
      ledger.deny(call.name, reason)
      return Promise.resolve("deny")
    },
    describeDenial(call: ToolCall): string | undefined {
      const c = classifyTool(call.name)
      if (c.autonomous) return undefined
      return (
        `autonomous execution may not use "${call.name}" (${c.capability}). ` +
        `This execution is read-only and runs unattended, so nothing can approve it. ` +
        `Reason: ${c.evidence}`
      )
    },
  }
}

/**
 * [PHASE 6S] The creation-time gate, now derived from the matrix.
 *
 * Kept in addition to the invocation-time handler for the reason given at the top
 * of this file: it fails fast on a misconfigured context, before any turn runs.
 */
export function assertAutonomousToolScope(toolNames: readonly string[]): void {
  const offending = toolNames.filter((n) => !isAutonomousTool(n))
  if (offending.length === 0) return
  const named = offending.filter((n) => classifyTool(n).capability !== "UNKNOWN")
  const unknown = offending.filter((n) => classifyTool(n).capability === "UNKNOWN")
  const bits: string[] = []
  if (named.length > 0) bits.push(`not autonomous: ${named.join(", ")}`)
  if (unknown.length > 0) bits.push(`unclassified: ${unknown.join(", ")}`)
  throw new Error(
    `autonomous execution context refused: tool scope is not read-only (${bits.join("; ")}). ` +
      `An unattended execution cannot use these; see TOOL_CAPABILITIES.`,
  )
}
