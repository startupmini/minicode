// Canonical task assignment — Phase 4A.4A.
//
// THIS IS NEW ARCHITECTURE.
//
// THE PROBLEM
//     `todo_write` may declare id-less items. Canonical synchronization mints real
//     TaskStore ids for them inside one transaction, so TaskStore knows the
//     identity and the plan builder does not. Phase 4A.4 therefore refused to emit
//     `payloadVersion: 2` for any payload that created a task. This module carries
//     the minted identity forward so the SAME operation that created the task can
//     deliver it to plan construction.
//
// WHY THE RETURN VALUE IS THE CHANNEL (this is the load-bearing design fact)
//     Two properties of the frozen kernel decide it, and both were verified in
//     `vendor/minicore` before this design was chosen:
//
//       1. `ToolContext` (vendor/minicore/src/core/tool.ts:22) carries
//          `signal`, `state`, `cwd`, `permissionMode` and `emit` — and NO tool-call
//          id. A tool therefore cannot name its own operation, so it cannot key any
//          channel it is handed, and a keyed map is the only thing that could keep
//          two in-flight writes apart. This is why the design is NOT a registry.
//       2. The kernel pairs `call` with `result` inside ONE `execution:completed`
//          event (vendor/minicore/src/core/executor.ts:102), and only the
//          serialized string survives (`serializeContent`).
//
//     The tool's return value is therefore the only per-operation channel the
//     kernel itself correlates. Consequence, stated plainly: the assignment travels
//     in the same string the model already receives, as one trailing line. There is
//     no hidden state, no module-level map, and no way for operation A's assignment
//     to be read by operation B — the adapter cannot see it at all except through
//     the result of that same call.
//
//     The rejected alternative was a custom executor that would see the raw
//     (non-serialized) tool return value and emit a separate structured event. That
//     would keep the model output clean, but it means re-implementing the frozen
//     kernel's `runCall` (permission checks, argument validation, abort handling,
//     snapshotting). Duplicating dispatch semantics to save one line of cosmetic
//     noise is a bad trade, so it was not done.
//
// FAIL-CLOSED, ALWAYS
//     `decode` returns `undefined` for anything it does not fully understand: a
//     missing trailer, a foreign session, a malformed id, a duplicate, a wrong
//     wire version. An incomplete assignment must never yield `payloadVersion: 2`,
//     so "I don't understand this" and "this is not canonical" are the same answer.

import { isTaskId } from "./model.ts"

/** Whether the id already existed or was minted by this operation. Kept because
 *  the plan builder must be able to tell "confirmed an existing task" from
 *  "this operation created it" — the difference is what 4A.4 could not express. */
export type CanonicalAssignmentKind = "existing" | "new"

/** One declared item's canonical identity. */
export interface CanonicalAssignment {
  taskId: string
  kind: CanonicalAssignmentKind
}

/** One entry per DECLARED item, in declaration order. Index `i` corresponds to
 *  declared item `i` — the order is the contract, so the table is never sorted,
 *  deduped or re-derived on the way out. */
export type CanonicalAssignmentTable = readonly CanonicalAssignment[]

const WIRE_VERSION = 1
const OPEN = "<!-- minicore:canonical-tasks "
const CLOSE = " -->"

/** Serialize the table as a single trailing line.
 *
 *  `JSON.stringify` never emits a raw newline, so a session id containing one is
 *  escaped rather than splitting the channel across lines. */
export function encodeCanonicalAssignments(
  sessionId: string,
  table: CanonicalAssignmentTable,
): string {
  const body = JSON.stringify({
    v: WIRE_VERSION,
    session: sessionId,
    declared: table.map((a) => ({ taskId: a.taskId, kind: a.kind })),
  })
  return `${OPEN}${body}${CLOSE}`
}

/** Recover the table, or `undefined` if anything at all is off.
 *
 *  Only the FINAL non-empty line is considered, so ordinary model-visible prose
 *  can never be mistaken for the channel. Arity is deliberately NOT checked here:
 *  this function knows nothing about the declaration, so the caller compares the
 *  returned length against the steps it is about to label. */
export function decodeCanonicalAssignments(
  content: unknown,
  opts: { sessionId: string },
): CanonicalAssignmentTable | undefined {
  if (typeof content !== "string" || content.length === 0) return undefined

  const lines = content.split("\n")
  let last = ""
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] as string).trim()
    if (t.length > 0) {
      last = t
      break
    }
  }
  if (!last.startsWith(OPEN) || !last.endsWith(CLOSE)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(last.slice(OPEN.length, last.length - CLOSE.length))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined

  const p = parsed as { v?: unknown; session?: unknown; declared?: unknown }
  if (p.v !== WIRE_VERSION) return undefined
  // The session stamp turns cross-session leakage from "argued not to happen"
  // into "detected and rejected".
  if (p.session !== opts.sessionId) return undefined
  if (!Array.isArray(p.declared) || p.declared.length === 0) return undefined

  const out: CanonicalAssignment[] = []
  const seen = new Set<string>()
  for (const entry of p.declared) {
    if (typeof entry !== "object" || entry === null) return undefined
    const c = entry as { taskId?: unknown; kind?: unknown }
    // `isTaskId` is the single owner of the id format, so the wire format cannot
    // drift away from what TaskStore would accept.
    if (!isTaskId(c.taskId)) return undefined
    if (c.kind !== "existing" && c.kind !== "new") return undefined
    if (seen.has(c.taskId)) return undefined
    seen.add(c.taskId)
    out.push({ taskId: c.taskId, kind: c.kind })
  }
  return out
}
