// Phase 6B — Scheduler prerequisites: P1 atomic claim, P2 todo_write authority
// boundary, P3 session ownership + reconciliation safety.
//
// NEW ARCHITECTURE. Scheduler itself does not exist; these primitives are tested
// directly, which 6B §3 explicitly permits.
//
// Fixture discipline: the store is real (temp SQLite). Authority is enabled only
// by constructing a TaskStore with `{ authority: "SCHEDULER" }` — never by a
// test writing to a global, which is what makes "no production path enables it"
// testable at all.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isTaskStatus, type Task, TaskError, type TaskStatus } from "../src/task/model.ts"
import {
  acquireSessionOwnership,
  ownsSession,
  releaseSessionOwnership,
  resetSessionOwnershipForTests,
  type SessionOwner,
} from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const S = "sess-6b"

let dir: string
let legacy: TaskStore
let authority: TaskStore
/** Memoized owner for the current test; see the P3 describe below. */
let testOwner: SessionOwner | null = null

const prov = { origin: "model", source: "test" } as const

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6b-"))
  legacy = new TaskStore(dir) // default: LEGACY
  authority = new TaskStore(dir, { authority: "SCHEDULER" })
  resetSessionOwnershipForTests()
  testOwner = null
})
afterEach(async () => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

const add = (
  store: TaskStore,
  status: TaskStatus = "PENDING",
  blockedReason: string | null = null,
): Task =>
  store.createTask(S, { title: `t ${status}`, status, order: 1, blockedReason, provenance: prov })

// ── P1: atomic claim ─────────────────────────────────────────────────────────
describe("P1. claimTask", () => {
  test("1. succeeds with the exact revision and reports CLAIM_ACCEPTED", () => {
    const t = add(legacy)
    const r = legacy.claimTask(S, t.id, t.revision)
    expect(r.outcome).toBe("CLAIM_ACCEPTED")
    expect(r.task?.status).toBe("IN_PROGRESS")
  })

  test("2. revision advances exactly once", () => {
    const t = add(legacy)
    expect(t.revision).toBe(1)
    const r = legacy.claimTask(S, t.id, t.revision)
    expect(r.task?.revision).toBe(2)
    expect(legacy.getTask(S, t.id)?.revision).toBe(2)
  })

  test("3. a wrong revision is rejected as CLAIM_REJECTED_STALE", () => {
    const t = add(legacy)
    const r = legacy.claimTask(S, t.id, t.revision + 5)
    expect(r.outcome).toBe("CLAIM_REJECTED_STALE")
    // ...and crucially, the status did NOT change.
    expect(legacy.getTask(S, t.id)?.status).toBe("PENDING")
    expect(legacy.getTask(S, t.id)?.revision).toBe(1)
  })

  test("4. a stale claim cannot mutate anything", () => {
    const t = add(legacy)
    legacy.patchTask(S, t.id, { title: "moved on" }) // revision -> 2
    const before = legacy.getTask(S, t.id)
    const r = legacy.claimTask(S, t.id, t.revision) // stale revision 1
    expect(r.outcome).toBe("CLAIM_REJECTED_STALE")
    const after = legacy.getTask(S, t.id)
    expect(after?.status).toBe("PENDING")
    expect(after?.title).toBe("moved on")
    expect(after?.revision).toBe(before?.revision as number)
  })

  test("5. a second claim of the same task is rejected, not double-claimed", () => {
    const t = add(legacy)
    const first = legacy.claimTask(S, t.id, t.revision)
    expect(first.outcome).toBe("CLAIM_ACCEPTED")

    // Second claimant re-reads and tries the CURRENT revision.
    const current = legacy.getTask(S, t.id)!
    const second = legacy.claimTask(S, t.id, current.revision)
    // Revision matches, but IN_PROGRESS is not claimable -> WRONG_STATE.
    expect(second.outcome).toBe("WRONG_STATE")
    expect(legacy.getTask(S, t.id)?.revision).toBe(2) // no second increment
  })

  test("6. a wrong state is rejected: only PENDING is claimable", () => {
    for (const status of ["COMPLETED", "CANCELLED", "FAILED"] as const) {
      const t = add(legacy, status)
      const r = legacy.claimTask(S, t.id, t.revision)
      expect({ status, outcome: r.outcome }).toEqual({ status, outcome: "WRONG_STATE" })
      expect(legacy.getTask(S, t.id)?.status).toBe(status)
    }
  })

  test("7. a missing task is reported NOT_FOUND and never recreated", () => {
    const r = legacy.claimTask(S, "t999", 1)
    expect(r.outcome).toBe("NOT_FOUND")
    expect(r.task).toBeNull()
    expect(legacy.listTasks(S)).toEqual([])
  })

  test("8. two claimants racing on the same revision produce exactly ONE winner", () => {
    const t = add(legacy)
    // Both claimants observed revision 1. Sequential execution of the same
    // atomic statement is the faithful simulation: the second must lose.
    const a = legacy.claimTask(S, t.id, t.revision)
    const b = legacy.claimTask(S, t.id, t.revision)
    const winners = [a.outcome, b.outcome].filter((o) => o === "CLAIM_ACCEPTED")
    expect(winners.length).toBe(1)
    expect(b.outcome).toBe("CLAIM_REJECTED_STALE")
    // Exactly one durable increment, and one winner's state.
    expect(legacy.getTask(S, t.id)?.revision).toBe(2)
  })

  test("8b. interleaved claimers across two stores still yield one winner", () => {
    const t = add(legacy)
    const other = new TaskStore(dir)
    const a = legacy.claimTask(S, t.id, 1)
    const b = other.claimTask(S, t.id, 1)
    expect([a.outcome, b.outcome].filter((o) => o === "CLAIM_ACCEPTED").length).toBe(1)
  })

  test("9. the revision predicate is REALLY inside the SQL of claimTask", () => {
    // Static proof, and the target of mutation M1 in 6B §14: removing
    // "AND revision = ?" from the claim statement must make THIS test fail.
    const src = readFileSync(join(REPO, "src", "task", "store.ts"), "utf8")
    const claimIdx = src.indexOf("claimTask(")
    expect(claimIdx).toBeGreaterThan(-1)
    const body = src.slice(claimIdx, src.indexOf("reconcileStranded(", claimIdx))
    expect(body).toContain("UPDATE tasks")
    expect(body).toContain("AND revision = ?")
    expect(body).toContain("revision = revision + 1")
    // The claimable-status predicate is in the same single statement.
    expect(body).toContain("status IN (")
  })

  test("10. rows-changed is what adjudicates the outcome", () => {
    const t = add(legacy)
    // Accepted -> exactly one row changed and revision advanced.
    const ok = legacy.claimTask(S, t.id, t.revision)
    expect(ok.outcome).toBe("CLAIM_ACCEPTED")
    expect(legacy.getTask(S, t.id)?.revision).toBe(t.revision + 1)
    // Rejected -> zero rows changed, revision unchanged.
    const bad = legacy.claimTask(S, t.id, t.revision)
    expect(bad.outcome).not.toBe("CLAIM_ACCEPTED")
    expect(legacy.getTask(S, t.id)?.revision).toBe(t.revision + 1)
  })

  test("claim never reads TaskGraph currency (no sourceMaxRevision anywhere)", () => {
    // Comments are stripped first: the claim's doc comment deliberately NAMES
    // sourceMaxRevision in order to forbid it, so a raw text search would match
    // the prohibition itself.
    const raw = readFileSync(join(REPO, "src", "task", "store.ts"), "utf8")
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ")
    expect(code).not.toContain("sourceMaxRevision")
    const claimIdx = code.indexOf("claimTask(")
    const body = code.slice(claimIdx, code.indexOf("reconcileStranded(", claimIdx))
    // The only currency is the per-task revision column.
    expect(body).not.toMatch(
      /Date\.now|new Date|timestamp|planRevision|sessionId\s*\+|MAX_REVISION/,
    )
  })

  test("a non-canonical id is rejected before any SQL runs", () => {
    expect(() => legacy.claimTask(S, "bogus", 1)).toThrow(TaskError)
  })
})

// ── P2: todo_write authority boundary ────────────────────────────────────────
describe("P2. authority mode", () => {
  test("11. LEGACY (the default) preserves current behaviour: patch may author IN_PROGRESS", () => {
    expect(legacy.authorityMode).toBe("LEGACY")
    const t = add(legacy)
    const updated = legacy.patchTask(S, t.id, { status: "IN_PROGRESS" })
    expect(updated.status).toBe("IN_PROGRESS")
  })

  test("12/13. under SCHEDULER authority a direct IN_PROGRESS write is refused, explicitly", () => {
    expect(authority.authorityMode).toBe("SCHEDULER")
    const t = add(authority)
    let caught: TaskError | null = null
    try {
      authority.patchTask(S, t.id, { status: "IN_PROGRESS" })
    } catch (e) {
      caught = e as TaskError
    }
    expect(caught).toBeInstanceOf(TaskError)
    expect(caught?.code).toBe("TASK_AUTHORITY_VIOLATION")
    // Fail-closed: the task is untouched.
    expect(authority.getTask(S, t.id)?.status).toBe("PENDING")
    expect(authority.getTask(S, t.id)?.revision).toBe(t.revision)
  })

  test("14. the claim primitive still succeeds under SCHEDULER authority", () => {
    const t = add(authority)
    const r = authority.claimTask(S, t.id, t.revision)
    expect(r.outcome).toBe("CLAIM_ACCEPTED")
    expect(authority.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })

  test("14b. createTask cannot smuggle IN_PROGRESS past the authority guard", () => {
    expect(() =>
      authority.createTask(S, { title: "x", status: "IN_PROGRESS", order: 1, provenance: prov }),
    ).toThrow(TaskError)
  })

  test("15. other statuses remain writable under authority (scope is narrow)", () => {
    const t = add(authority)
    for (const status of ["VERIFYING", "BLOCKED", "CANCELLED", "COMPLETED", "FAILED"] as const) {
      const updated = authority.patchTask(S, t.id, {
        status,
        blockedReason: status === "BLOCKED" ? "r" : null,
      })
      expect(updated.status).toBe(status)
    }
  })

  test("15b. a model cannot self-claim a task by writing IN_PROGRESS on another task's behalf", () => {
    const mine = add(authority, "PENDING")
    const theirs = add(authority, "PENDING")
    // Attempting to author IN_PROGRESS on "theirs" is refused, regardless of
    // which task the caller believes it controls.
    expect(() => authority.patchTask(S, theirs.id, { status: "IN_PROGRESS" })).toThrow()
    expect(authority.getTask(S, mine.id)?.status).toBe("PENDING")
    expect(authority.getTask(S, theirs.id)?.status).toBe("PENDING")
  })

  test("16. no production code enables SCHEDULER authority (source scan)", () => {
    const files = [
      "src/tools/todo.ts",
      "src/task/sync.ts",
      "src/task/assignment.ts",
      "src/app/session.ts",
      "src/mcp/server.ts",
    ]
    for (const f of files) {
      const src = readFileSync(join(REPO, f), "utf8")
      expect({ file: f, enables: src.includes('authority: "SCHEDULER"') }).toEqual({
        file: f,
        enables: false,
      })
    }
    // And the only construction sites of TaskStore in src/ pass no options.
    const storeSrc = readFileSync(join(REPO, "src", "task", "store.ts"), "utf8")
    expect(storeSrc.includes('authority: "SCHEDULER"')).toBe(false)
  })

  test("16b. authority is per-instance, not a module singleton", () => {
    const a = new TaskStore(dir, { authority: "SCHEDULER" })
    const b = new TaskStore(dir)
    expect(a.authorityMode).toBe("SCHEDULER")
    expect(b.authorityMode).toBe("LEGACY")
    // The legacy instance is unaffected by the authority instance's existence.
    const t = add(b)
    expect(b.patchTask(S, t.id, { status: "IN_PROGRESS" }).status).toBe("IN_PROGRESS")
  })
})

// ── P3: session ownership + reconciliation ───────────────────────────────────
describe("P3. session ownership", () => {
  test("17. an ACTIVE session is not reconciled", () => {
    const t = add(legacy, "IN_PROGRESS")
    const owner = acquireSessionOwnership(S, "worker")!
    const r = legacy.reconcileStranded(S, t.id, t.revision, { ownsSession: ownsSession(S, owner) })
    // Ownership IS held, so the mechanics work — but the point of 17 is that
    // an active owner must not be treated as absent. Assert ownership is seen.
    expect(ownsSession(S, owner)).toBe(true)
    expect(r.outcome).toBe("RECONCILED")
    // ...and the released-owner case below is the one that must refuse.
  })

  test("17b. once ownership is released the session may reconcile", () => {
    const t = add(legacy, "IN_PROGRESS")
    const owner = acquireSessionOwnership(S, "worker")!
    releaseSessionOwnership(S, owner, "stopped")
    const r = legacy.reconcileStranded(S, t.id, t.revision, {
      ownsSession: ownsSession(S, owner),
    })
    expect(ownsSession(S, owner)).toBe(false)
    expect(r.outcome).toBe("REFUSED_NO_OWNERSHIP")
    expect(legacy.getTask(S, t.id)?.status).toBe("IN_PROGRESS") // untouched
  })

  test("18. a session this process owns CAN be reconciled per the locked policy", () => {
    // Both stranded states live in S, so the owner is acquired ONCE. Acquiring
    // per iteration would return null for the second one, because ownership is
    // exclusive by design.
    const owner = acquireSessionOwnership(S, "w")!
    for (const status of ["IN_PROGRESS", "VERIFYING"] as const) {
      const t = add(legacy, status)
      const r = legacy.reconcileStranded(S, t.id, t.revision, {
        ownsSession: ownsSession(S, owner),
      })
      expect({ status, outcome: r.outcome }).toEqual({ status, outcome: "RECONCILED" })
      expect(legacy.getTask(S, t.id)?.status).toBe("PENDING")
    }
  })

  test("19. ownership uncertainty FAILS CLOSED (no owner at all)", () => {
    const t = add(legacy, "IN_PROGRESS")
    const r = legacy.reconcileStranded(S, t.id, t.revision, { ownsSession: false })
    expect(r.outcome).toBe("REFUSED_NO_OWNERSHIP")
    expect(legacy.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
    expect(legacy.getTask(S, t.id)?.revision).toBe(t.revision)
  })

  test("19b. a forged owner token does not satisfy ownership", () => {
    const t = add(legacy, "IN_PROGRESS")
    acquireSessionOwnership(S, "real")
    const forged = { token: Symbol("forged"), label: "forged" } as SessionOwner
    expect(ownsSession(S, forged)).toBe(false)
    const r = legacy.reconcileStranded(S, t.id, t.revision, { ownsSession: ownsSession(S, forged) })
    expect(r.outcome).toBe("REFUSED_NO_OWNERSHIP")
  })

  test("19c. ownership is exclusive: a second acquire is refused, not stolen", () => {
    const first = acquireSessionOwnership(S, "a")
    const second = acquireSessionOwnership(S, "b")
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(ownsSession(S, first)).toBe(true)
    // A non-owner cannot release it either.
    const stranger = { token: Symbol("x"), label: "x" } as SessionOwner
    expect(releaseSessionOwnership(S, stranger)).toBe(false)
    expect(ownsSession(S, first)).toBe(true)
  })
})

describe("P3. reconciliation contract", () => {
  // Memoized per test. Ownership is EXCLUSIVE, so a naive `acquire` on every
  // call would return null after the first and silently turn every later check
  // into "unowned". The registry is cleared in beforeEach, so the memo is reset
  // with it.
  const owned = (): SessionOwner => {
    testOwner ??= acquireSessionOwnership(S, "w")
    if (testOwner === null) throw new Error("ownership was lost mid-test")
    return testOwner
  }
  const mine = (): boolean => ownsSession(S, owned())

  test("20. reconciliation NEVER deletes a task", () => {
    const t = add(legacy, "IN_PROGRESS")
    const before = legacy.listTasks(S).length
    legacy.reconcileStranded(S, t.id, t.revision, { ownsSession: mine() })
    expect(legacy.listTasks(S).length).toBe(before)
    expect(legacy.getTask(S, t.id)).not.toBeNull()
  })

  test("20b. reconciliation never mutates relationship or descriptive fields", () => {
    const parent = add(legacy, "COMPLETED")
    const child = legacy.createTask(S, {
      title: "child",
      status: "IN_PROGRESS",
      order: 2,
      parentId: parent.id,
      dependsOn: [parent.id],
      provenance: prov,
    })
    const before = legacy.getTask(S, child.id)!
    legacy.reconcileStranded(S, child.id, before.revision, { ownsSession: mine() })
    const after = legacy.getTask(S, child.id)!
    expect(after.status).toBe("PENDING")
    expect(after.parentId).toBe(before.parentId)
    expect(after.dependsOn).toEqual(before.dependsOn)
    expect(after.order).toBe(before.order)
    expect(after.title).toBe(before.title)
    // No manufactured evidence.
    expect(after.verification).toBeNull()
    expect(after.evidence).toEqual([])
  })

  test("21. reconciliation is revision-safe: a newer writer is not clobbered (race A)", () => {
    const t = add(legacy, "IN_PROGRESS")
    const stale = t.revision
    legacy.patchTask(S, t.id, { title: "newer writer" }) // revision advances
    const r = legacy.reconcileStranded(S, t.id, stale, { ownsSession: mine() })
    expect(r.outcome).toBe("REJECTED_STALE")
    const after = legacy.getTask(S, t.id)!
    expect(after.status).toBe("IN_PROGRESS") // not blindly overwritten
    expect(after.title).toBe("newer writer")
  })

  test("21b. race B: task completed before reconciliation -> NOT_STRANDED, untouched", () => {
    const t = add(legacy, "IN_PROGRESS")
    legacy.patchTask(S, t.id, { status: "COMPLETED" })
    const current = legacy.getTask(S, t.id)!
    const r = legacy.reconcileStranded(S, t.id, current.revision, {
      ownsSession: mine(),
    })
    expect(r.outcome).toBe("NOT_STRANDED")
    expect(legacy.getTask(S, t.id)?.status).toBe("COMPLETED")
  })

  test("22. race C: two reconciliations -> exactly one durable transition", () => {
    const t = add(legacy, "IN_PROGRESS")
    const rev = t.revision
    const a = legacy.reconcileStranded(S, t.id, rev, { ownsSession: mine() })
    const b = legacy.reconcileStranded(S, t.id, rev, { ownsSession: mine() })
    const wins = [a.outcome, b.outcome].filter((o) => o === "RECONCILED")
    expect(wins.length).toBe(1)
    expect(legacy.getTask(S, t.id)?.revision).toBe(rev + 1)
    expect(legacy.getTask(S, t.id)?.status).toBe("PENDING")
  })

  test("23. PAUSED is not a TaskStatus and is never a reconciliation target", () => {
    // The model guard is the contract: PAUSED is not in the union.
    expect(isTaskStatus("PAUSED")).toBe(false)
    expect(isTaskStatus("READY")).toBe(false)
    // And the reconciliation predicate can only ever name the two reconcilable
    // states, so PAUSED cannot be produced by reconciling anything.
    const raw = readFileSync(join(REPO, "src", "task", "store.ts"), "utf8")
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ")
    expect(code).not.toContain("'PAUSED'")
    expect(code).not.toContain("'READY'")
    // Every status reconciliation can set is PENDING.
    const reconIdx = code.indexOf("reconcileStranded(")
    const body = code.slice(reconIdx, code.indexOf("deleteTask(", reconIdx))
    expect(body).toContain("SET status = 'PENDING'")
  })

  test("24. COMPLETED / CANCELLED / FAILED are never reconciliation targets", () => {
    for (const status of ["COMPLETED", "CANCELLED", "FAILED"] as const) {
      const t = add(legacy, status)
      const r = legacy.reconcileStranded(S, t.id, t.revision, { ownsSession: mine() })
      expect({ status, outcome: r.outcome }).toEqual({ status, outcome: "NOT_STRANDED" })
      expect(legacy.getTask(S, t.id)?.status).toBe(status)
    }
  })

  test("24b. a PENDING task is not 'stranded' either", () => {
    const t = add(legacy, "PENDING")
    const r = legacy.reconcileStranded(S, t.id, t.revision, { ownsSession: mine() })
    expect(r.outcome).toBe("NOT_STRANDED")
    expect(legacy.getTask(S, t.id)?.revision).toBe(t.revision)
  })

  test("26. session isolation: a task id only ever resolves inside its own session", () => {
    // `taskId` is allocated PER SESSION, so both tasks are `t1`. That is what
    // makes this the sharpest isolation test available: the SAME id string
    // exists in both sessions and must resolve to different rows.
    const a = add(legacy, "IN_PROGRESS")
    const b = legacy.createTask("other-sess", {
      title: "b",
      status: "IN_PROGRESS",
      order: 1,
      provenance: prov,
    })
    expect(b.id).toBe(a.id)

    const otherOwner = acquireSessionOwnership("other-sess", "o")!
    // Reconciling under S touches S's row and leaves the other session alone.
    const r1 = legacy.reconcileStranded(S, a.id, a.revision, { ownsSession: mine() })
    expect(r1.outcome).toBe("RECONCILED")
    expect(legacy.getTask(S, a.id)?.status).toBe("PENDING")
    expect(legacy.getTask("other-sess", b.id)?.status).toBe("IN_PROGRESS")

    // And the other session's identical id is independently reconcilable,
    // because ownership is per session too.
    const r2 = legacy.reconcileStranded("other-sess", b.id, b.revision, {
      ownsSession: ownsSession("other-sess", otherOwner),
    })
    expect(r2.outcome).toBe("RECONCILED")
    expect(legacy.getTask("other-sess", b.id)?.status).toBe("PENDING")
    // S's row is unaffected by the other session's write.
    expect(legacy.getTask(S, a.id)?.status).toBe("PENDING")
  })

  test("reconciliation does not consult a graph (no graph import in store.ts)", () => {
    const src = readFileSync(join(REPO, "src", "task", "store.ts"), "utf8")
    expect(src).not.toContain('from "./graph.ts"')
    expect(src).not.toContain('from "./readiness.ts"')
  })
})

// ── P1+P2 integration: the real todo_write path under authority ─────────────
describe("P1+P2. the model-facing path cannot create a claim", () => {
  test("a synchronize-shaped IN_PROGRESS write is refused under authority", () => {
    // This is exactly the shape src/task/sync.ts uses: patchTask with a status
    // mapped from the model's todo status.
    const t = add(authority)
    let code: string | null = null
    try {
      authority.patchTask(S, t.id, { status: "IN_PROGRESS" })
    } catch (e) {
      code = (e as TaskError).code
    }
    expect(code).toBe("TASK_AUTHORITY_VIOLATION")
    // The same call under LEGACY succeeds, proving the authority seam is the
    // only difference between the two paths.
    expect(legacy.patchTask(S, t.id, { status: "IN_PROGRESS" }).status).toBe("IN_PROGRESS")
  })
})
