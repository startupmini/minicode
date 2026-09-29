// Phase 6K â€” integration safety corrections (D3 / D4 / D5).

//
// NEW ARCHITECTURE (corrective, not redesign). Phase 6J found three integration
// defects around the 6H/6I lineage model. The lineage model itself is NOT
// changed here: `exec_generation` still advances only on an accepted claim,
// `attempt_generation` still names the generation that ended, and no TaskStatus,
// TaskGraph, readiness or agent-loop behaviour is touched.
//
//   D3 (HIGH)  a pre-6I `tasks` table never received the lineage columns,
//              because `CREATE TABLE IF NOT EXISTS` cannot add columns, so
//              `createTask` failed on any pre-6I installation.
//   D4 (HIGH)  production `deleteSession` never deleted TaskStore rows, so
//              session-id reuse resurrected deleted tasks AND their lineage.
//   D5 (MED)   the active-claim reconciliation exemption was untested; removing
//              it let an owning Scheduler revert its own live task.

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { deleteSession, loadSession, saveSession } from "../src/session/persistence.ts"
import {
  type ExecutionObservation,
  Scheduler,
  type SchedulerWorkItem,
} from "../src/task/scheduler.ts"
import {
  acquireSessionOwnership,
  resetSessionOwnershipForTests,
} from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const P = { origin: "model", source: "6k" } as const
const S = "6k"
const OK: ExecutionObservation = { kind: "returned", ok: true }

/**
 * [PHASE 6K] Build a database whose `tasks` table is PHYSICALLY the pre-6I
 * schema - no lineage columns - using raw SQL.
 *
 * This is mandatory. Phase 6J caught 6I's migration test giving false evidence
 * because it created the fixture with the CURRENT TaskStore, so the columns
 * always existed and the test could never have detected a missing migration.
 * The assertion `exec_generation` is absent below is what makes this a real
 * pre-migration fixture rather than a decorated current one.
 */
function preLineageDatabase(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "6k-mig-"))
  const path = join(dir, ".minicode", "tasks.db")
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  const db = new Database(path)
  db.exec(`
    CREATE TABLE tasks (
      session_id TEXT NOT NULL, task_id TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, task_order INTEGER NOT NULL, parent_id TEXT,
      depends_on_json TEXT, blocked_reason TEXT, verification_json TEXT,
      evidence_json TEXT, acceptance_json TEXT, provenance_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY (session_id, task_id)
    );
    CREATE TABLE task_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  db.close()
  return { dir, path }
}

function insertLegacyRow(
  path: string,
  sessionId: string,
  taskId: string,
  status: string,
  revision: number,
  order = 1,
): void {
  const db = new Database(path)
  db.prepare(
    `INSERT INTO tasks (session_id, task_id, title, status, task_order, parent_id, depends_on_json,
       blocked_reason, verification_json, evidence_json, acceptance_json, provenance_json,
       created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, NULL, '[]', NULL, NULL, '[]', NULL, NULL, '2026-01-01', '2026-01-01', ?)`,
  ).run(sessionId, taskId, "legacy " + taskId, status, order, revision)
  db.close()
}

function columnsOf(path: string, table = "tasks"): string[] {
  const db = new Database(path, { readonly: true })
  const names = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (r) => r.name,
  )
  db.close()
  return names
}

function rowsOf(path: string): Record<string, unknown>[] {
  const db = new Database(path, { readonly: true })
  const rows = db.prepare("SELECT * FROM tasks ORDER BY task_id").all() as Record<string, unknown>[]
  db.close()
  return rows
}

const dirs: string[] = []
function track(dir: string): string {
  dirs.push(dir)
  return dir
}

afterEach(() => {
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// D3 â€” MIGRATION
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

describe("D3. pre-6I database migration", () => {
  test("D3.1 the fixture is genuinely pre-lineage before TaskStore ever opens it", () => {
    const { dir, path } = preLineageDatabase()
    track(dir)
    // Asserted FIRST, so a later "it works" result cannot be an artefact of the
    // fixture already having the columns.
    expect(columnsOf(path)).not.toContain("exec_generation")
    expect(columnsOf(path)).not.toContain("attempt_generation")
  })

  test("D3.2 opening migrates the columns and preserves every existing field", () => {
    const { dir, path } = preLineageDatabase()
    track(dir)
    insertLegacyRow(path, "old", "t1", "PENDING", 7)
    insertLegacyRow(path, "old", "t2", "IN_PROGRESS", 4, 2)
    const before = rowsOf(path)

    resetTaskStoreHandles()
    const store = new TaskStore(dir) // LEGACY authority: the normal path
    store.initialize() // open the handle so the migration actually runs
    const cols = columnsOf(path)
    expect(cols).toContain("exec_generation")
    expect(cols).toContain("attempt_generation")

    // Nothing rewritten: only the two new columns differ, and they carry the
    // 6H defaults for a row that predates lineage.
    const after = rowsOf(path)
    expect(after.length).toBe(before.length)
    for (const b of before) {
      const a = after.find((r) => r.task_id === b.task_id)!
      expect(a.task_id).toBe(b.task_id)
      expect(a.revision).toBe(b.revision)
      expect(a.status).toBe(b.status)
      expect(a.title).toBe(b.title)
      expect(a.session_id).toBe(b.session_id)
      expect(a.exec_generation).toBe(0)
      expect(a.attempt_generation).toBeNull()
    }
    // And the API agrees, including the pre-6I IN_PROGRESS row.
    expect(store.getTask("old", "t1")?.revision).toBe(7)
    expect(store.getExecutionLineage("old", "t1")).toEqual({
      execGeneration: 0,
      attemptGeneration: null,
    })
    expect(store.getTask("old", "t2")?.status).toBe("IN_PROGRESS")
  })

  test("D3.3 LEGACY task creation works on a migrated database", () => {
    const { dir, path } = preLineageDatabase()
    track(dir)
    insertLegacyRow(path, "old", "t1", "PENDING", 3)
    resetTaskStoreHandles()
    const store = new TaskStore(dir)
    // This is the exact call that threw in 6J.
    const created = store.createTask("old", {
      title: "after migration",
      status: "PENDING",
      order: 2,
      provenance: P,
    })
    expect(created.id).not.toBe("t1")
    expect(store.getTask("old", created.id)?.status).toBe("PENDING")
    expect(store.getExecutionLineage("old", created.id)).toEqual({
      execGeneration: 0,
      attemptGeneration: null,
    })
    // The pre-existing row is untouched.
    expect(store.getTask("old", "t1")?.revision).toBe(3)
  })

  test("D3.4 the migration is idempotent: opening repeatedly changes nothing", () => {
    const { dir, path } = preLineageDatabase()
    track(dir)
    insertLegacyRow(path, "old", "t1", "COMPLETED", 9)
    resetTaskStoreHandles()
    const snapshots: string[] = []
    for (let i = 0; i < 3; i++) {
      resetTaskStoreHandles()
      const store = new TaskStore(dir)
      expect(store.getTask("old", "t1")?.revision).toBe(9)
      snapshots.push(
        JSON.stringify(
          rowsOf(path).map((r) => [r.task_id, r.revision, r.exec_generation, r.attempt_generation]),
        ),
      )
    }
    expect(new Set(snapshots).size).toBe(1)
    // Still exactly one row: the migration never rewrites or duplicates.
    expect(rowsOf(path).length).toBe(1)
  })

  test("D3.5 a PARTIALLY migrated database converges (only one column present)", () => {
    const { dir, path } = preLineageDatabase()
    track(dir)
    insertLegacyRow(path, "old", "t1", "PENDING", 2)
    // Simulate an interrupted migration: exec_generation landed, attempt did not.
    const db = new Database(path)
    db.exec("ALTER TABLE tasks ADD COLUMN exec_generation INTEGER NOT NULL DEFAULT 0")
    db.close()
    expect(columnsOf(path)).toContain("exec_generation")
    expect(columnsOf(path)).not.toContain("attempt_generation")

    resetTaskStoreHandles()
    const store = new TaskStore(dir)
    store.initialize()
    const cols = columnsOf(path)
    expect(cols).toContain("exec_generation")
    expect(cols).toContain("attempt_generation")
    expect(store.getExecutionLineage("old", "t1")).toEqual({
      execGeneration: 0,
      attemptGeneration: null,
    })
    expect(store.getTask("old", "t1")?.revision).toBe(2)
  })

  test("D3.6 a 6I-era database carrying a task_attempt table opens and ignores it", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "6k-6f-")))
    resetTaskStoreHandles()
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const t = store.createTask("s", { title: "x", status: "PENDING", order: 1, provenance: P })
    const c = store.claimTask("s", t.id, 1)
    store.recordAttemptReturned("s", t.id, c.execGeneration)
    resetTaskStoreHandles()
    // Plant the 6F table with a hostile value, as 6J did.
    const path = join(dir, ".minicode", "tasks.db")
    const db = new Database(path)
    db.exec(
      "CREATE TABLE IF NOT EXISTS task_attempt (session_id TEXT, task_id TEXT, attempt_revision INTEGER)",
    )
    db.prepare("INSERT INTO task_attempt VALUES (?,?,?)").run("s", t.id, 9999)
    db.close()

    resetTaskStoreHandles()
    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(reopened.getExecutionLineage("s", t.id)).toEqual({
      execGeneration: 1,
      attemptGeneration: 1,
    })
    expect(
      reopened.reconcileIfNoCompletedAttempt("s", t.id, reopened.getTask("s", t.id)!.revision, {
        ownsSession: true,
      }).outcome,
    ).toBe("NOT_STRANDED")
  })

  test("D3.7 a migrated database is still LEGACY: nothing manufactures execution evidence", () => {
    const { dir, path } = preLineageDatabase()
    track(dir)
    insertLegacyRow(path, "old", "t1", "PENDING", 1)
    resetTaskStoreHandles()
    const legacy = new TaskStore(dir) // LEGACY authority
    const a = legacy.createTask("old", { title: "a", status: "PENDING", order: 2, provenance: P })
    legacy.patchTask("old", a.id, { status: "IN_PROGRESS" }) // permitted in LEGACY
    legacy.patchTask("old", a.id, { status: "COMPLETED" })
    legacy.patchTask("old", a.id, { title: "edited" })
    for (const id of ["t1", a.id]) {
      expect(legacy.getExecutionLineage("old", id)).toEqual({
        execGeneration: 0,
        attemptGeneration: null,
      })
    }
  })
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// D4 â€” PRODUCTION SESSION DELETE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

describe("D4. production deleteSession", () => {
  test("D4.1 deleteSession removes task rows and their lineage (raw SQLite)", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "6k-del-")))
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const t = store.createTask("S", {
      title: "old work",
      status: "PENDING",
      order: 1,
      provenance: P,
    })
    const c = store.claimTask("S", t.id, 1)
    store.recordAttemptReturned("S", t.id, c.execGeneration)
    resetTaskStoreHandles()

    await deleteSession("S", dir)

    // Raw inspection, not an API snapshot.
    const path = join(dir, ".minicode", "tasks.db")
    expect(rowsOf(path)).toEqual([])
    expect(columnsOf(path)).toContain("exec_generation")
  })

  test("D4.2 session-id reuse yields ZERO old tasks and a clean lineage", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "6k-reuse-")))
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const legacy = new TaskStore(dir)
    const old = store.createTask("S", {
      title: "deleted work",
      status: "PENDING",
      order: 1,
      provenance: P,
    })
    const c = store.claimTask("S", old.id, 1)
    store.recordAttemptReturned("S", old.id, c.execGeneration)
    legacy.patchTask("S", old.id, { status: "PENDING" })
    resetTaskStoreHandles()

    await deleteSession("S", dir)
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()

    // Recreate the SAME session id.
    const store2 = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(store2.getSnapshot("S").tasks).toEqual([])

    const fresh = store2.createTask("S", {
      title: "new work",
      status: "PENDING",
      order: 1,
      provenance: P,
    })
    // Same canonical id as the deleted task - and still no inherited lineage.
    expect(fresh.id).toBe(old.id)
    expect(store2.getExecutionLineage("S", fresh.id)).toEqual({
      execGeneration: 0,
      attemptGeneration: null,
    })
    // And a Scheduler on the recreated session cannot select deleted work.
    const executed: string[] = []
    const sc = new Scheduler("S", {
      store: store2,
      runTurn: (w: SchedulerWorkItem) => {
        executed.push(w.taskId)
        return OK
      },
      instruction: "x",
    })
    sc.start()
    const before = executed.length
    await sc.cycle()
    // Only the NEW task may run, and it starts from generation 1.
    expect(executed.length).toBe(before + 1)
    expect(executed[executed.length - 1]).toBe(fresh.id)
    expect(store2.getExecutionLineage("S", fresh.id)).toEqual({
      execGeneration: 1,
      attemptGeneration: 1,
    })
    await sc.stop()
  })

  test("D4.3 deleting one session leaves another session's tasks and lineage untouched", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "6k-multi-")))
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    store.createTask("S1", { title: "a", status: "PENDING", order: 1, provenance: P })
    const b = store.createTask("S2", { title: "b", status: "PENDING", order: 1, provenance: P })
    const cb = store.claimTask("S2", b.id, 1)
    store.recordAttemptReturned("S2", b.id, cb.execGeneration)
    resetTaskStoreHandles()

    await deleteSession("S1", dir)
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()

    const store2 = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(store2.getSnapshot("S1").tasks).toEqual([])
    expect(store2.getSnapshot("S2").tasks.map((t) => t.id)).toEqual([b.id])
    expect(store2.getExecutionLineage("S2", b.id)).toEqual({
      execGeneration: 1,
      attemptGeneration: 1,
    })
    // S2's Scheduler still functions, and S2's own task is left alone.
    const executed: string[] = []
    const sc = new Scheduler("S2", {
      store: store2,
      runTurn: (w) => {
        executed.push(w.taskId)
        return OK
      },
      instruction: "x",
    })
    sc.start()
    await sc.cycle()
    await sc.cycle()
    // Its generation is already recorded, so it is protected, not re-run.
    expect(executed).toEqual([])
    expect(store2.getTask("S2", b.id)!.status).toBe("IN_PROGRESS")
    expect(store2.getExecutionLineage("S2", b.id)).toEqual({
      execGeneration: 1,
      attemptGeneration: 1,
    })
    await sc.stop()
  })

  test("D4.4 deleting the same session twice is safe and idempotent", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "6k-twice-")))
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const store = new TaskStore(dir)
    store.createTask("S", { title: "a", status: "PENDING", order: 1, provenance: P })
    resetTaskStoreHandles()

    await deleteSession("S", dir)
    // Second delete must not throw and must not resurrect anything.
    await deleteSession("S", dir)
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const store2 = new TaskStore(dir)
    expect(store2.getSnapshot("S").tasks).toEqual([])
  })

  test("D4.6 ordering: a task-deletion failure leaves the SESSION intact, so the delete is retryable", async () => {
    // The two databases cannot share a transaction, so the ordering is the only
    // safety mechanism. This injects a real failure into task deletion and
    // proves the residue is the BENIGN one: a session without tasks (retryable,
    // nothing orphaned) rather than tasks without a session (executable
    // orphans). A reverse-ordered implementation fails here.
    const dir = track(mkdtempSync(join(tmpdir(), "6k-fail-")))
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const store = new TaskStore(dir)
    store.createTask("S", { title: "a", status: "PENDING", order: 1, provenance: P })
    resetTaskStoreHandles()

    // A real session row, so we can observe whether it survives.
    await saveSession("S", dir, "system", [{ role: "user", content: "hi" }], null)
    expect(loadSession("S", dir)).not.toBeNull()

    // Inject the failure at the TaskStore boundary - the only seam production
    // code uses.
    const real = TaskStore.prototype.deleteSessionTasks
    TaskStore.prototype.deleteSessionTasks = () => {
      throw new Error("injected task-store failure")
    }
    let threw = ""
    try {
      await deleteSession("S", dir)
    } catch (e) {
      threw = (e as Error).message
    } finally {
      TaskStore.prototype.deleteSessionTasks = real
    }
    expect(threw).toContain("task store cleanup failed")

    // The session SURVIVED: the delete is visibly incomplete and retryable.
    expect(loadSession("S", dir)).not.toBeNull()

    // And the task rows are untouched, which is safe precisely because the
    // session they belong to still exists - no orphan is reachable by reusing
    // the id, because the id was never freed.
    resetTaskStoreHandles()
    const after = new TaskStore(dir)
    expect(after.getSnapshot("S").tasks.map((t) => t.id)).toEqual(["t1"])

    // Retrying now succeeds and converges.
    await deleteSession("S", dir)
    resetTaskStoreHandles()
    expect(loadSession("S", dir)).toBeNull()
    expect(rowsOf(join(dir, ".minicode", "tasks.db"))).toEqual([])
  })
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// D5 â€” ACTIVE-CLAIM SAFETY
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

describe("D5. active-claim reconciliation exemption", () => {
  test("D5.1 the OWNING Scheduler must NOT reconcile its own live claim", async () => {
    // The exact mutation M13 removes. G2 is claimed and its turn is in flight
    // inside a deferred bridge, so `attempt < exec` holds for a task that is
    // demonstrably ALIVE rather than stranded.
    const dir = track(mkdtempSync(join(tmpdir(), "6k-d5-")))
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const legacy = new TaskStore(dir)
    const t = store.createTask(S, { title: "T1", status: "PENDING", order: 1, provenance: P })

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let turn = 0
    const sc = new Scheduler(S, {
      store,
      // G1 returns immediately; G2 blocks, so its claim stays active.
      runTurn: async () => {
        if (++turn >= 2) await gate
        return OK
      },
      instruction: "x",
    })
    sc.start()

    await sc.cycle() // G1 completes and records
    expect(store.getExecutionLineage(S, t.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })

    legacy.patchTask(S, t.id, { status: "PENDING" })
    const inflight = sc.cycle() // G2 claims, then blocks inside the bridge
    await new Promise((r) => setTimeout(r, 30))

    // The state under test: current generation has NO record, and the task is
    // alive inside this very Scheduler.
    expect(store.getExecutionLineage(S, t.id)).toEqual({ execGeneration: 2, attemptGeneration: 1 })
    expect(store.getTask(S, t.id)!.status).toBe("IN_PROGRESS")

    // THE assertion. Without the exemption this returns ["t1"] and the task is
    // yanked to PENDING underneath the running turn.
    expect(sc.reconcile()).toEqual([])
    expect(store.getTask(S, t.id)!.status).toBe("IN_PROGRESS")
    expect(store.getExecutionLineage(S, t.id)).toEqual({ execGeneration: 2, attemptGeneration: 1 })

    release()
    await inflight
    // And the generation finishes normally afterwards.
    expect(store.getExecutionLineage(S, t.id)).toEqual({ execGeneration: 2, attemptGeneration: 2 })
    await sc.stop()
  })

  test("D5.2 the full 6J Â§4 shape: owner protected, fresh instance recovers, ownership fails closed", async () => {
    // Reproduced directly rather than deferred, so the three outcomes are
    // distinguished rather than collapsed into one IN_PROGRESS assertion.
    const dir = track(mkdtempSync(join(tmpdir(), "6k-d5b-")))
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const legacy = new TaskStore(dir)
    const t = store.createTask(S, { title: "T1", status: "PENDING", order: 1, provenance: P })
    const sc = new Scheduler(S, { store, runTurn: () => OK, instruction: "x" })
    sc.start()
    await sc.cycle() // G1 completes
    expect(store.getExecutionLineage(S, t.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })

    // G2 is claimed and NOT recorded: the "stranded" shape.
    legacy.patchTask(S, t.id, { status: "PENDING" })
    store.claimTask(S, t.id, store.getTask(S, t.id)!.revision)
    expect(store.getExecutionLineage(S, t.id)).toEqual({ execGeneration: 2, attemptGeneration: 1 })

    // (A) OWNER, holding the claim -> protected.
    sc["claim"] = {
      taskId: t.id,
      claimRevision: store.getTask(S, t.id)!.revision,
      execGeneration: 2,
    }
    expect(sc.reconcile()).toEqual([])
    expect(store.getTask(S, t.id)!.status).toBe("IN_PROGRESS")
    sc["claim"] = null

    // (B) FRESH instance -> the claim is genuinely stranded, so recovery is correct.
    await sc.stop()
    resetSessionOwnershipForTests()
    const fresh = new Scheduler(S, { store, runTurn: () => OK, instruction: "x" })
    fresh.start()
    expect(fresh.reconcile()).toEqual([t.id])
    expect(store.getTask(S, t.id)!.status).toBe("PENDING")
    await fresh.stop()

    // (C) ownership unavailable -> fail closed, even though the row is stranded.
    resetSessionOwnershipForTests()
    legacy.patchTask(S, t.id, { status: "IN_PROGRESS" })
    store.recordAttemptReturned(S, t.id, 2) // now recorded again
    acquireSessionOwnership(S, "someone-else")
    const blocked = new Scheduler(S, { store, runTurn: () => OK, instruction: "x" })
    expect(() => blocked.start()).toThrow(/already owned/i)
    expect(blocked.reconcile()).toEqual([])
  })

  test("D5.3 removing the exemption yanks the live task (the M13 damage shape)", async () => {
    // Documents the harm the exemption prevents, using the real TaskStore.
    const dir = track(mkdtempSync(join(tmpdir(), "6k-d5c-")))
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const t = store.createTask(S, { title: "T1", status: "PENDING", order: 1, provenance: P })
    store.claimTask(S, t.id, 1) // exec=1, no record
    const rev = store.getTask(S, t.id)!.revision
    // With the exemption present the OWNER is protected...
    const sc = new Scheduler(S, { store, runTurn: () => OK, instruction: "x" })
    sc.start()
    sc["claim"] = { taskId: t.id, claimRevision: rev, execGeneration: 1 }
    expect(sc.reconcile()).toEqual([])
    expect(store.getTask(S, t.id)!.status).toBe("IN_PROGRESS")
    await sc.stop()
    // ...and the ONLY thing separating that from D5.1's `["t1"]` is the single
    // `if (this.claim?.taskId === task.id) continue` line. Assert the store
    // WOULD revert without it, so the exemption is pinned to real behaviour.
    resetSessionOwnershipForTests()
    const r = store.reconcileIfNoCompletedAttempt(S, t.id, rev, { ownsSession: true })
    expect(r.outcome).toBe("RECONCILED")
  })
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Interaction + lineage regression
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

describe("interaction: migrate then delete then reuse", () => {
  test("K.1 an old database migrates, runs a generation, then session reuse is clean", async () => {
    const { dir, path } = preLineageDatabase()
    track(dir)
    insertLegacyRow(path, "S", "t1", "PENDING", 5)
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()

    // migrate + create + run a generation
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const t2 = store.createTask("S", { title: "new", status: "PENDING", order: 2, provenance: P })
    const c = store.claimTask("S", t2.id, store.getTask("S", t2.id)!.revision)
    store.recordAttemptReturned("S", t2.id, c.execGeneration)
    expect(store.getExecutionLineage("S", t2.id)).toEqual({
      execGeneration: 1,
      attemptGeneration: 1,
    })
    resetTaskStoreHandles()

    // delete the session through the REAL production path
    await deleteSession("S", dir)
    expect(rowsOf(path)).toEqual([])

    // reuse the id
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const store2 = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(store2.getSnapshot("S").tasks).toEqual([])
    const again = store2.createTask("S", {
      title: "again",
      status: "PENDING",
      order: 1,
      provenance: P,
    })
    expect(again.id).toBe("t1") // same canonical id recycled
    expect(store2.getExecutionLineage("S", again.id)).toEqual({
      execGeneration: 0,
      attemptGeneration: null,
    })
  })
})
