// Phase 4B.2 regression protection: PRODUCTION SYNC TRANSACTION ATOMICITY.
//
// THIS IS TEST HARDENING. No production semantics are changed by this phase.
//
// THE GAP THIS CLOSES
//   Phase 4B mutation P9 - "remove the production withTransaction boundary" -
//   SURVIVED, because no model-reachable input could fail AFTER the first
//   mutation: the sync's resolve-before-mutate pre-pass rejects every bad id
//   before any statement runs. `TaskStore.withTransaction` had its own tests, but
//   the production call site in `sync.ts` was unguarded, so removing the wrapper
//   was invisible. Phase 4A.2's suite could not help either, because it drives
//   `store.withTransaction` directly rather than through `sync.ts`.
//
// THE FAILURE INJECTION
//   A deterministic, REAL failure that occurs after a mutation-capable step has
//   already run, inside the production transaction:
//
//     entry 0: existing t1        -> a real mutation (title + status change)
//     entry 1: NEW task BLOCKED with no reason
//                                  -> createTask -> validate() ->
//                                     TASK_INVALID_TRANSITION
//                                     "BLOCKED requires blockedReason"
//
//   That validation is genuine TaskStore production code (`store.ts:380`), reached
//   through the real API - no raw SQL, no test-only hook, no weakened validation.
//   `planTaskIdentities` accepts `status: "blocked"`, so a new entry can carry
//   BLOCKED, and the todo_write tool schema cannot express it (its enum has no
//   "blocked"), which is precisely why this is exercised at the sync seam - the
//   very seam 4B.2 is required to cover.
//
//   Measured with the wrapper REMOVED: t1 commits as "A MUTATED" at revision 2.
//   Measured with the real code: t1 is still "A" at revision 1. That difference
//   is what makes the boundary observable.
//
// SAFETY (Phase 0A discipline): one `mkdtemp(join(tmpdir(), "minicode-atomic-"))`
// per test, removed by that exact absolute path. No `readdir(".")`, no pattern
// delete, nothing resolved from process.cwd().

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { todoWriteTool } from "../src/tools/todo.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { synchronizeCanonicalTasks, type CanonicalTaskInput } from "../src/task/sync.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-atomic-"))
  owned.push(dir)
  return dir
}
afterEach(async () => {
  try {
    resetTaskStoreHandles()
  } catch {}
  while (owned.length) await rm(owned.pop()!, { recursive: true, force: true }).catch(() => {})
})

const prov = { origin: "runtime", source: "test" } as const
const S = "atomic-session"
const opCtx = (dir: string) => ({ signal: new AbortController().signal, cwd: dir, sessionId: S }) as never

const seed = (dir: string, titles: string[]) => {
  const s = new TaskStore(dir)
  titles.forEach((t, i) => s.createTask(S, { title: t, status: "PENDING", order: i, provenance: prov }))
}

/** The FULL durable snapshot. Every atomicity assertion compares against this. */
const snapshot = (dir: string) =>
  new TaskStore(dir)
    .listTasks(S)
    .map((t) => ({ id: t.id, title: t.title, status: t.status, order: t.order, revision: t.revision }))

/** The payload whose SECOND entry fails validation after the first has mutated. */
const poison = (): CanonicalTaskInput[] => [
  // entry 0 - a genuine mutation of an EXISTING task
  { taskId: "t1", title: "A MUTATED", status: "completed" },
  // entry 1 - NEW, BLOCKED with no reason => createTask -> validate() throws
  { title: "will fail", status: "blocked" as never },
]

// ---------------------------------------------------------------------------
// A. a successful sync commits atomically
// ---------------------------------------------------------------------------
test("A. a successful production sync commits every mutation together", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const r = synchronizeCanonicalTasks({
    cwd: dir,
    sessionId: S,
    declared: [
      { taskId: "t1", title: "A renamed", status: "completed" },
      { title: "C new", status: "pending" },
      { taskId: "t2", title: "B", status: "pending" },
    ],
  })
  expect(r.applied).toBe(true)
  const s = snapshot(dir)
  // The update, the creation and the untouched row are all present together.
  expect(s.find((t) => t.id === "t1")).toMatchObject({ title: "A renamed", status: "COMPLETED" })
  expect(s.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"])
  expect(s.find((t) => t.id === "t3")?.title).toBe("C new")
  // The assignment covers the whole payload.
  expect(r.assignment?.map((a) => a.taskId)).toEqual(["t1", "t3", "t2"])
})

// ---------------------------------------------------------------------------
// B. rollback after a later mutation fails  (the core proof)
// ---------------------------------------------------------------------------
test("B. a later validation failure rolls back the earlier mutation", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const S0 = snapshot(dir)

  let code: string | undefined
  try {
    synchronizeCanonicalTasks({ cwd: dir, sessionId: S, declared: poison() })
  } catch (e) {
    code = (e as { code?: string }).code
  }
  // The real production error, from the real store validation.
  expect(code).toBe("TASK_INVALID_TRANSITION")

  // THE ATOMICITY PROOF: the snapshot is byte-for-byte the pre-operation one.
  expect(snapshot(dir)).toEqual(S0)
  // And specifically: the first entry's mutation did NOT survive.
  expect(snapshot(dir).find((t) => t.id === "t1")).toMatchObject({ title: "A", status: "PENDING" })
})

// ---------------------------------------------------------------------------
// C. no partial revision changes
// ---------------------------------------------------------------------------
test("C. no task's revision advances when the payload fails midway", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B", "C"])
  const before = snapshot(dir).map((t) => `${t.id}:${t.revision}`)
  expect(() => synchronizeCanonicalTasks({ cwd: dir, sessionId: S, declared: poison() })).toThrow()
  expect(snapshot(dir).map((t) => `${t.id}:${t.revision}`)).toEqual(before)
  // Every row is still at its creation revision.
  expect(snapshot(dir).every((t) => t.revision === 1)).toBe(true)
})

// ---------------------------------------------------------------------------
// D. no partial task allocation
// ---------------------------------------------------------------------------
test("D. a failed payload allocates no id and leaves nextId untouched", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const nextBefore = new TaskStore(dir).nextId(S)
  expect(nextBefore).toBe("t3")
  expect(() => synchronizeCanonicalTasks({ cwd: dir, sessionId: S, declared: poison() })).toThrow()
  // No t3 row, and the allocator's cursor has not moved.
  expect(snapshot(dir).map((t) => t.id)).toEqual(["t1", "t2"])
  expect(new TaskStore(dir).nextId(S)).toBe("t3")
})

// ---------------------------------------------------------------------------
// E. no partial order changes
// ---------------------------------------------------------------------------
test("E. a failed payload leaves every task_order untouched", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B", "C"])
  const before = snapshot(dir).map((t) => `${t.id}:${t.order}`)
  expect(() => synchronizeCanonicalTasks({ cwd: dir, sessionId: S, declared: poison() })).toThrow()
  expect(snapshot(dir).map((t) => `${t.id}:${t.order}`)).toEqual(before)
})

// ---------------------------------------------------------------------------
// F. the production seam is what carries the transaction
// ---------------------------------------------------------------------------
test("F. the rollback is the production seam's own behaviour, not a store unit test", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const S0 = snapshot(dir)
  // Driven through `synchronizeCanonicalTasks` - the exact function todo_write
  // calls - and observed through the public TaskStore read API only.
  expect(() => synchronizeCanonicalTasks({ cwd: dir, sessionId: S, declared: poison() })).toThrow()
  expect(snapshot(dir)).toEqual(S0)
  // The failure originated in the store's own validation, proving the production
  // path really reached TaskStore and then unwound.
  let msg = ""
  try {
    synchronizeCanonicalTasks({ cwd: dir, sessionId: S, declared: poison() })
  } catch (e) {
    msg = (e as Error).message
  }
  expect(msg).toContain("BLOCKED requires blockedReason")
})

// ---------------------------------------------------------------------------
// G/H. the atomicity assertion is SENSITIVE to a partial write
// ---------------------------------------------------------------------------
// These two tests do not mutate production code. They prove the snapshots used by
// B/C/D/E can actually TELL a rolled-back operation apart from a partially
// committed one - which is exactly the property P9 and the deferred-mutation
// mutant would violate. Without these, B..E could be vacuously true.
test("G. the assertion distinguishes rollback from a partial commit (removal mutant)", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const S0 = snapshot(dir)
  // What the real production path produces:
  expect(() => synchronizeCanonicalTasks({ cwd: dir, sessionId: S, declared: poison() })).toThrow()
  const rolledBack = snapshot(dir)
  expect(rolledBack).toEqual(S0)

  // What a bypassed transaction would produce: the FIRST entry's mutation stands.
  // Applied through the same public API the sync itself uses - no raw SQL.
  new TaskStore(dir).patchTask(S, "t1", { title: "A MUTATED", status: "COMPLETED" })
  const partiallyCommitted = snapshot(dir)

  // The two outcomes are DISTINGUISHABLE, so B..E would fail under the mutant.
  expect(partiallyCommitted).not.toEqual(rolledBack)
  expect(partiallyCommitted.find((t) => t.id === "t1")).toMatchObject({
    title: "A MUTATED",
    status: "COMPLETED",
  })
  expect(partiallyCommitted.find((t) => t.id === "t1")!.revision).toBeGreaterThan(
    rolledBack.find((t) => t.id === "t1")!.revision,
  )
})

test("H. the assertion detects ONE mutation applied after the transaction", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const S0 = snapshot(dir)
  // The deferred-mutation mutant: one write happens AFTER the transaction would
  // have unwound. Only a single row differs, which is the harder case to detect.
  expect(() => synchronizeCanonicalTasks({ cwd: dir, sessionId: S, declared: poison() })).toThrow()
  const rolledBack = snapshot(dir)

  const store = new TaskStore(dir)
  store.patchTask(S, "t1", { order: 42 }) // exactly one deferred mutation
  const withDeferred = snapshot(dir)
  expect(withDeferred).not.toEqual(rolledBack)
  expect(withDeferred).not.toEqual(S0)
  // Only t1 changed - and it is the HARDEST case to spot, because changing
  // `order` also moves t1 to the end of the listTasks ordering, so rows must be
  // compared BY ID rather than by list position.
  const beforeById = new Map(rolledBack.map((t) => [t.id, t]))
  const diff = withDeferred.filter((t) => JSON.stringify(t) !== JSON.stringify(beforeById.get(t.id)))
  expect(diff).toHaveLength(1)
  expect(diff[0]!.id).toBe("t1")
  expect(diff[0]!.order).toBe(42)
  // t2 is untouched in every field.
  expect(withDeferred.find((t) => t.id === "t2")).toEqual(beforeById.get("t2"))
})

// ---------------------------------------------------------------------------
// JSON / PLAN behaviour of a production sync failure
// ---------------------------------------------------------------------------
test("I. a reachable todo_write sync failure writes JSON, rolls back, and publishes no plan", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const S0 = snapshot(dir)
  // This failure IS reachable through the tool: an unknown id. It is rejected by
  // the pre-pass, so it is the divergence case rather than the rollback case.
  await expect(
    todoWriteTool.execute(
      {
        todos: [
          { taskId: "t1", content: "A", status: "completed" },
          { taskId: "t404", content: "ghost", status: "pending" },
        ],
      } as never,
      opCtx(dir),
    ),
  ).rejects.toThrow()

  // TaskStore: rolled back / untouched.
  expect(snapshot(dir)).toEqual(S0)
  // JSON: ALREADY WRITTEN. This is the documented 4A.4 ordering - a durable write
  // precedes the canonical sync - so the legacy file describes the rejected
  // payload. Recorded, not invented away: there is no cross-system rollback.
  const raw = await readFile(join(dir, ".minicode", "todos", `${S}.json`), "utf8").catch(() => "")
  expect(raw).not.toBe("")
  // Plan: none. The throw makes the tool result an error, and the adapter
  // publishes only on !result.isError, so no plan.updated can escape.
  // (Asserted directly in phase4a5 test L; the consequence here is that no
  // canonical plan v2 is derived from the rejected state.)
})
