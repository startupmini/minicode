// PHASE 3C REGRESSION EVIDENCE — a KNOWN-BAD behaviour, captured permanently.
//
// ============================================================================
// THIS IS NOT A PRODUCT-SPEC TEST. IT DOCUMENTS A MEASURED DEFECT.
//
// The behaviour asserted below is CURRENTLY WRONG. It is preserved so that a
// future identity-contract implementation cannot change it silently, and so the
// defect cannot be "discovered" again as if it were new.
//
// It is the concrete failure behind three invariants that are deliberately NOT
// satisfied today:
//
//   I3 — taskId survives reorder                      -> VIOLATED
//   I5 — existing task never silently becomes new      -> VIOLATED
//   I7 — one logical task cannot create duplicate rows -> VIOLATED
//
// WHY IT IS SKIPPED BY DEFAULT
// A passing test for wrong behaviour would make the repository assert that the
// bug is correct. Gating on MINICODE_KNOWN_BAD_EVIDENCE keeps `bun test` GREEN
// while leaving the evidence reproducible on demand:
//
//   MINICODE_KNOWN_BAD_EVIDENCE=1 bun test test/phase3c-identity-duplication.known-bad.test.ts
//
// (project-consistent with the existing env-gated idiom, e.g. `test.skipIf`
// in agent-contract.test.ts and `const it = live ? test : test.skip` in
// extreme-live.test.ts)
//
// WHAT MUST HAPPEN WHEN THE IDENTITY CONTRACT IS IMPLEMENTED
// This test must FAIL in its current form, or be rewritten to assert the new
// correct behaviour and unskipped. Either way it must not be left passing while
// the duplication still occurs. A future implementation that changes reorder
// semantics should make the "six rows" assertion fail — that failure is the
// signal, not a problem.
//
// ROOT CAUSE (for context, not for this test to assert)
// The model protocol cannot express identity: `todo_write`'s schema sets
// `additionalProperties: false` on todo items, so no `taskId` can be sent, and
// `renderTodos` never returns one. An id-less payload therefore carries no
// information with which to resolve a reference, and `applyTaskIdentities`
// treats every id-less item as a new task.
//
// SAFETY (Phase 0A discipline): one `mkdtemp(join(tmpdir(), "minicode-dup-"))`
// directory per test, removed by that exact absolute path. No `readdir(".")`, no
// pattern delete, no cwd-based cleanup.
// ============================================================================

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { synchronizeIdentities } from "../src/task/identity.ts"
import { resetTaskStoreHandles, type Task, TaskStore } from "../src/task/store.ts"

const owned: string[] = []

async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-dup-"))
  owned.push(dir)
  return dir
}

afterEach(async () => {
  resetTaskStoreHandles()
  while (owned.length) {
    const dir = owned.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

const SESSION = "duplication-session"

/** The model can only ever send id-less items, because the tool schema forbids
 *  a `taskId`. `content` is not unique, so this is genuinely ambiguous input. */
const idless = (titles: string[]) => titles.map((title) => ({ title, status: "pending" as const }))

test.skipIf(!process.env.MINICODE_KNOWN_BAD_EVIDENCE)(
  "knownBad_reorderOfIdlessPayloadDuplicatesTasks",
  async () => {
    const dir = await ownedDir()
    const store = new TaskStore(dir)

    // ---- INITIAL: A B C -------------------------------------------------
    synchronizeIdentities(store, SESSION, idless(["A", "B", "C"]))

    const first: Task[] = store.listTasks(SESSION)
    // Sanity: the premise must hold, otherwise this test proves nothing.
    expect(first.map((t) => [t.id, t.title])).toEqual([
      ["t1", "A"],
      ["t2", "B"],
      ["t3", "C"],
    ])

    // ---- THE SAME LOGICAL TASKS, REORDERED, STILL ID-LESS ---------------
    synchronizeIdentities(store, SESSION, idless(["C", "A", "B"]))

    const after: Task[] = store.listTasks(SESSION)

    // ---- THE DEFECT, ASSERTED AS OBSERVED (not as desired) ---------------

    // MUTATION A guard: the duplicate row count.
    expect(after).toHaveLength(6)

    // MUTATION B guard: it is not "only one duplicate" — every logical task is
    // duplicated, i.e. all three original identities survive AND three new ones
    // were minted for the same logical content. Ids are compared sorted, because
    // `listTasks` returns `(task_order, task_id)` order - see the exact observed
    // list asserted below.
    const byTitle = (title: string) => after.filter((t) => t.title === title)
    const idsOf = (title: string) => byTitle(title).map((t) => t.id).sort()
    expect(idsOf("A")).toEqual(["t1", "t5"])
    expect(idsOf("B")).toEqual(["t2", "t6"])
    expect(idsOf("C")).toEqual(["t3", "t4"])
    for (const title of ["A", "B", "C"]) expect(byTitle(title)).toHaveLength(2)

    // The exact observed list. Note the duplicate of C sorts BEFORE the original
    // t3: the reordered payload put C first, so its copy received order 0 while
    // the original t3 still carries order 2 from the initial payload. This is
    // why the two C rows collide on `order` rather than merely duplicating it.
    expect(after.map((t) => [t.id, t.title, t.order])).toEqual([
      ["t1", "A", 0],
      ["t4", "C", 0],
      ["t2", "B", 1],
      ["t5", "A", 1],
      ["t3", "C", 2],
      ["t6", "B", 2],
    ])

    // MUTATION C guard: the original rows are NOT removed or remapped.
    expect(after.filter((t) => ["t1", "t2", "t3"].includes(t.id))).toHaveLength(3)
    expect(store.getTask(SESSION, "t1")?.title).toBe("A")
    expect(store.getTask(SESSION, "t2")?.title).toBe("B")
    expect(store.getTask(SESSION, "t3")?.title).toBe("C")

    // MUTATION D guard: identity was DUPLICATED, not transferred. A transfer
    // would leave exactly three rows whose titles had been permuted.
    expect(after).toHaveLength(6)

    // MUTATION E guard: the reorder was NOT silently ignored. If it had been,
    // the store would still hold three rows.
    expect(after.length).toBeGreaterThan(first.length)

    // The duplicate rows collide on `order`, because each id-less payload
    // assigns `order` from its own array index (0,1,2) starting from scratch.
    const orders = after.map((t) => t.order).sort((a, b) => a - b)
    expect(orders).toEqual([0, 0, 1, 1, 2, 2])
    const distinctOrders = new Set(after.map((t) => t.order)).size
    expect(distinctOrders).toBe(3)
    expect(after).toHaveLength(6)

    // The duplicates are unrecoverable through the explicit-id path: a later
    // fully-addressed reorder addresses t1/t2/t3 and leaves t4/t5/t6 in place.
    synchronizeIdentities(store, SESSION, [
      { taskId: "t1", title: "A", status: "pending" },
      { taskId: "t2", title: "B", status: "pending" },
      { taskId: "t3", title: "C", status: "pending" },
    ])
    expect(store.listTasks(SESSION)).toHaveLength(6)
  },
)
