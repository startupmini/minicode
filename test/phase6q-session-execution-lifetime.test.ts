// PHASE 6Q - session deletion & autonomous execution lifetime.
//
// F2 (6N): deleting a session mid-turn threw out of cycle(), left the active
// claim set, and kept session ownership - so the instance was permanently wedged
// AND no replacement could start.
//
// F6 (6N): purgeExpired deleted session-side rows but never touched tasks.db, so a
// TTL-purged session orphaned its task rows and execution lineage.

import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Task } from "../src/task/model.ts"
import { type ExecutionObservation, Scheduler, type SchedulerEvent } from "../src/task/scheduler.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { type AttemptRecordOutcome, resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

let dir: string
let store: TaskStore
let legacy: TaskStore

const S = "6q"
const prov = { origin: "model", source: "6q" } as const
const OK: ExecutionObservation = { kind: "returned", ok: true }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6q-"))
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  legacy = new TaskStore(dir)
  resetSessionOwnershipForTests()
})
afterEach(async () => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

const add = (order = 1): Task =>
  store.createTask(S, { title: `t${order}`, status: "PENDING", order, provenance: prov })
const claim = (t: Task, session = S) => {
  const r = store.claimTask(session, t.id, t.revision)
  if (r.outcome !== "CLAIM_ACCEPTED") throw new Error(`claim rejected: ${r.outcome}`)
  return r
}
const mk = (
  runTurn: (w: { taskId: string }) => Promise<ExecutionObservation> | ExecutionObservation,
) => new Scheduler(S, { store, runTurn, instruction: "x" })

// ═══ A. F2 CORE: the wedge ══════════════════════════════════════════════════

describe("A. F2: mid-turn deletion no longer wedges the Scheduler", () => {
  test("A1. deletion during the turn: claim released, instance STOPPED, replacement starts", async () => {
    add()
    let deletedInside = false
    const sc = mk(() => {
      // the session is deleted while this execution is still running
      store.deleteSessionTasks(S)
      deletedInside = true
      return OK
    })
    sc.start()
    // the claim must exist while the turn runs
    const events: SchedulerEvent[] = []
    const sc2 = new Scheduler(S, {
      store,
      runTurn: () => OK,
      instruction: "x",
      onEvent: (e) => events.push(e),
    })
    void sc2
    sc.start()

    const res = await sc.cycle()
    expect(deletedInside).toBe(true)

    // the cycle RETURNS rather than throwing
    expect(res.dispatched?.lineage).toBe("TASK_GONE")
    expect(res.dispatched?.released).toBe(true)
    // the claim is gone - this is the wedge
    expect(sc.getActiveClaim()).toBeNull()
    // the instance disposed itself, releasing ownership
    expect(sc.getLifecycle()).toBe("STOPPED")
    // ...so a REPLACEMENT can start
    const replacement = mk(() => OK)
    expect(() => replacement.start()).not.toThrow()
    expect((await replacement.cycle()).stop).toBe("no-candidates")
    await replacement.stop()
  })

  test("A2. deletion AFTER the turn returns but BEFORE the lineage write", async () => {
    const t = add()
    claim(t)
    // the execution finished, then the session vanished before the marker landed
    store.deleteSessionTasks(S)
    expect(store.recordAttemptReturned(S, t.id, 1, 1)).toBe("TASK_GONE")
    // nothing was written
    expect(store.getTask(S, t.id)).toBeNull()
  })

  test("A3. deletion BEFORE the claim: nothing is claimed, nothing to release", async () => {
    add()
    store.deleteSessionTasks(S)
    const sc = mk(() => OK)
    sc.start()
    expect((await sc.cycle()).stop).toBe("no-candidates")
    expect(sc.getActiveClaim()).toBeNull()
    await sc.stop()
  })

  test("A4. a superseded session is refused even when the row still matches", async () => {
    const t = add()
    const c = claim(t)
    // session deleted and RECREATED; a new row exists with the same id and the
    // same exec_generation, so the lineage guard alone cannot refuse this
    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    const fresh = store.createTask(S, {
      title: "recreated",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    expect(fresh.id).toBe(t.id) // per-session ids restart at t1
    const c2 = store.claimTask(S, fresh.id, fresh.revision)
    expect(c2.execGeneration).toBe(1) // and so does the generation

    // the OLD execution returns with (t1, gen 1) - indistinguishable without the
    // incarnation, and it MUST NOT stamp the new row
    const outcome: AttemptRecordOutcome = store.recordAttemptReturned(
      S,
      t.id,
      c.execGeneration,
      c.sessionIncarnation,
    )
    expect(outcome).toBe("SESSION_SUPERSEDED")
    expect(store.getExecutionLineage(S, fresh.id)!.attemptGeneration).toBeNull()
    expect(store.getExecutionOwnership(S, fresh.id)!.executionOwner).toBe("scheduler")
  })

  test("A5. an unidentified attempt returns instead of throwing", async () => {
    // no claim at all -> nothing to record, but the instance stays usable
    expect(store.recordAttemptReturned(S, "t1", 1, 1)).toBe("TASK_GONE")
  })
})

// ═══ B. NO CROSS-GENERATION EFFECT ═══════════════════════════════════════════

describe("B. a recreated session is unreachable from the old execution", () => {
  test("B1. the full delete -> recreate -> late-return chain mutates nothing", async () => {
    // S1: session exists, claimed, execution in flight
    const t = add()
    const c = claim(t)

    // session deleted, then RECREATED with a new task under the same id
    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    const recreated = store.createTask(S, {
      title: "NEW SESSION WORK",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    expect(recreated.id).toBe(t.id)
    const c2 = store.claimTask(S, recreated.id, recreated.revision)

    // the OLD execution returns, carrying unique data that must land nowhere
    const outcome = store.recordAttemptReturned(S, t.id, c.execGeneration, c.sessionIncarnation)
    expect(outcome).toBe("SESSION_SUPERSEDED")

    // NOTHING about the recreated session changed
    const lin = store.getExecutionLineage(S, recreated.id)!
    expect(lin.execGeneration).toBe(c2.execGeneration)
    expect(lin.attemptGeneration).toBeNull() // not marked complete
    expect(store.getTask(S, recreated.id)!.title).toBe("NEW SESSION WORK")
    expect(store.getTask(S, recreated.id)!.status).toBe("IN_PROGRESS")
    // and the recreated claim is still fully recoverable, i.e. not protected by a
    // foreign completion
    const sc = mk(() => OK)
    sc.start()
    expect(sc.reconcile()).toEqual([recreated.id])
    await sc.stop()
  })

  test("B2. a live session is unaffected by another session's deletion", () => {
    const a = store.createTask("other", {
      title: "a",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    const b = store.createTask("third", {
      title: "b",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    claim(a, "other")
    claim(b, "third")
    store.bumpSessionIncarnation("other")
    store.deleteSessionTasks("other")
    // the untouched session keeps everything
    expect(store.getTask("third", b.id)!.status).toBe("IN_PROGRESS")
    expect(store.getExecutionOwnership("third", b.id)!.executionOwner).toBe("scheduler")
    expect(store.getExecutionLineage("third", b.id)!.attemptGeneration).toBeNull()
  })
})

// ═══ C. CANONICAL DELETION + ORDERING ═══════════════════════════════════════

describe("C. canonical deletion and the 6K ordering", () => {
  test("C1. deletion is idempotent", () => {
    const t = add()
    claim(t)
    for (let i = 0; i < 3; i++) {
      store.bumpSessionIncarnation(S)
      store.deleteSessionTasks(S)
    }
    expect(store.listTasks(S)).toEqual([])
  })

  test("C2. a task-delete failure leaves the session intact and retryable", async () => {
    const t = add()
    claim(t)
    // The canonical operation constructs its OWN TaskStore, so the fault has to be
    // injected on the prototype rather than on one instance.
    const proto = TaskStore.prototype as unknown as { deleteSessionTasks: (id: string) => void }
    const realDelete = proto.deleteSessionTasks
    let call = 0
    proto.deleteSessionTasks = function (id: string) {
      call++
      if (call === 1) throw new Error("injected task-store failure")
      return realDelete.call(this, id)
    }
    const { deleteSession } = await import("../src/session/persistence.ts")
    try {
      await expect(deleteSession(S, dir)).rejects.toThrow(/task store cleanup failed/)
      // the residue is the SAFE one: the session still exists, so the delete is
      // visibly incomplete and nothing is orphaned
      expect(store.getTask(S, t.id)).not.toBeNull()
    } finally {
      proto.deleteSessionTasks = realDelete
    }
    // and it is retryable
    await deleteSession(S, dir)
    expect(store.listTasks(S)).toEqual([])
  })

  test("C3. the incarnation is bumped BEFORE rows are removed", () => {
    const t = add()
    const c = claim(t)
    // order matters: invalidate first, so a concurrent/late execution is already
    // refused even if the row removal is what it observes
    const before = store.getSessionIncarnation(S)
    store.bumpSessionIncarnation(S)
    expect(store.getSessionIncarnation(S)).toBe(before + 1)
    store.deleteSessionTasks(S)
    expect(store.recordAttemptReturned(S, t.id, c.execGeneration, c.sessionIncarnation)).toBe(
      "SESSION_SUPERSEDED",
    )
  })

  test("C4. the CANONICAL path (deleteSession) itself invalidates in-flight executions", async () => {
    // [6Q mutation M1] The bump must live in the canonical operation, not only in
    // the store helper. Exercised through the real public entry point, so a
    // deletion that skipped the bump would leave live executions authorised.
    const t = add()
    const c = claim(t)
    const { deleteSession } = await import("../src/session/persistence.ts")
    await deleteSession(S, dir)
    expect(store.listTasks(S)).toEqual([])
    // the in-flight execution is refused by the deletion itself
    expect(store.recordAttemptReturned(S, t.id, c.execGeneration, c.sessionIncarnation)).toBe(
      "SESSION_SUPERSEDED",
    )
  })

  test("C5. deleting TWICE still invalidates a RE-CLAIMED second generation", async () => {
    // [6Q mutation M8] Idempotency is not the same as "advance only once". A
    // session that is deleted, RECREATED, re-claimed and then deleted again has a
    // second population of live executions, and the second deletion must
    // invalidate those too.
    const first = add()
    const c1 = claim(first)
    const { deleteSession } = await import("../src/session/persistence.ts")
    await deleteSession(S, dir)

    // recreate + re-claim
    const second = store.createTask(S, {
      title: "gen2",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    const c2 = claim(second)
    expect(c2.sessionIncarnation).toBe(c1.sessionIncarnation + 1)

    // delete again
    await deleteSession(S, dir)
    // the SECOND population is refused as well
    expect(
      store.recordAttemptReturned(S, second.id, c2.execGeneration, c2.sessionIncarnation),
    ).toBe("SESSION_SUPERSEDED")
    expect(store.listTasks(S)).toEqual([])
  })
})

// ═══ D. NORMAL / ERROR / CANCELLATION MATRIX ════════════════════════════════

describe("D. normal, error and cancellation paths after deletion", () => {
  const run = async (
    behaviour: () => Promise<ExecutionObservation> | ExecutionObservation,
    name: string,
  ) => {
    add()
    let deleted = false
    const sc = mk(async () => {
      if (!deleted) {
        deleted = true
        store.deleteSessionTasks(S)
        store.bumpSessionIncarnation(S)
      }
      return behaviour()
    })
    sc.start()
    const res = await sc.cycle()
    // none of these may wedge, resurrect, or complete
    expect(sc.getActiveClaim()).toBeNull()
    expect(sc.getLifecycle()).toBe("STOPPED")
    expect(store.listTasks(S)).toEqual([])
    expect(res.dispatched?.released).toBe(true)
    expect(res.dispatched?.lineage).not.toBe("RECORDED")
    return { name, ok: res.dispatched?.ok }
  }

  test("D1. normal return after deletion", async () => {
    const r = await run(() => OK, "normal")
    expect(r.ok).toBe(true)
  })

  test("D2. throw after deletion", async () => {
    const r = await run(() => {
      throw new Error("model exploded")
    }, "throw")
    expect(r.ok).toBe(false)
  })

  test("D3. rejection after deletion", async () => {
    const r = await run(() => Promise.reject(new Error("provider died")), "reject")
    expect(r.ok).toBe(false)
  })

  test("D4. a stop() during the turn still yields a usable instance", async () => {
    add()
    let sc!: Scheduler
    sc = mk(async () => {
      await sc.stop().catch(() => {})
      return OK
    })
    sc.start()
    const res = await sc.cycle()
    // stop() does not clear the claim (by design), but it does release ownership,
    // so a replacement can start - which is the property that matters.
    expect(store.listTasks(S).length).toBe(1)
    const replacement = mk(() => OK)
    expect(() => replacement.start()).not.toThrow()
    await replacement.stop()
    void res
  })
})

// ═══ E. 6P OWNERSHIP REGRESSION ═════════════════════════════════════════════

describe("E. Phase 6P ownership semantics still hold", () => {
  test("E1. deletion leaves no executable task and no orphan ownership", () => {
    const t = add()
    claim(t)
    expect(store.getExecutionOwnership(S, t.id)!.executionOwner).toBe("scheduler")
    store.bumpSessionIncarnation(S)
    store.deleteSessionTasks(S)
    expect(store.getTask(S, t.id)).toBeNull()
    expect(store.listTasks(S)).toEqual([])
  })

  test("E2. reconciliation cannot recover a task whose session was deleted", async () => {
    const t = add()
    const c = claim(t)
    store.bumpSessionIncarnation(S)
    store.deleteSessionTasks(S)
    const sc = mk(() => OK)
    sc.start()
    expect(sc.reconcile()).toEqual([])
    await sc.stop()
    void c
  })

  test("E3. a recreated task does NOT inherit ownership or lineage", () => {
    const t = add()
    claim(t)
    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    const fresh = store.createTask(S, {
      title: "fresh",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    expect(store.getExecutionOwnership(S, fresh.id)!.executionOwner).toBeNull()
    expect(store.getExecutionLineage(S, fresh.id)).toEqual({
      execGeneration: 0,
      attemptGeneration: null,
    })
  })

  test("E4. the H1/H5 distinction is untouched by 6Q", async () => {
    // H1: interactive IN_PROGRESS, never claimed -> left alone
    const h1 = add(1)
    legacy.patchTask(S, h1.id, { status: "IN_PROGRESS" })
    // H5: claim -> reconcile -> user IN_PROGRESS -> left alone
    const h5 = add(2)
    claim(h5)
    const sc = mk(() => OK)
    sc.start()
    expect(sc.reconcile()).toEqual([h5.id])
    legacy.patchTask(S, h5.id, { status: "IN_PROGRESS" })
    expect(sc.reconcile()).toEqual([])
    expect(store.getTask(S, h1.id)!.status).toBe("IN_PROGRESS")
    expect(store.getTask(S, h5.id)!.status).toBe("IN_PROGRESS")
    await sc.stop()
  })
})

// ═══ F. F6: purgeExpired gains the same semantics ═══════════════════════════

describe("F. F6: purgeExpired has the same cleanup semantics as explicit deletion", () => {
  /** A real sessions.db with one expired and one fresh session. */
  const seed = async (): Promise<{ db: Database; oldId: string; newId: string }> => {
    await mkdir(join(dir, ".minicode"), { recursive: true })
    const db = new Database(resolve(dir, ".minicode", "sessions.db"))
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER, cwd TEXT, system TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, ts INTEGER, PRIMARY KEY(session_id, seq));
      CREATE TABLE IF NOT EXISTS turns (session_id TEXT, turn_idx INTEGER, usage TEXT, ts INTEGER, PRIMARY KEY(session_id, turn_idx));
      CREATE TABLE IF NOT EXISTS presentation_events (session_id TEXT NOT NULL, event_seq INTEGER NOT NULL, type TEXT NOT NULL, turn_id INTEGER NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id, event_seq));
    `)
    const now = Date.now()
    const old = 40 * 86400000
    db.prepare(
      "INSERT INTO sessions (id, created_at, cwd, system, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(S, now - old, dir, "", now - old)
    db.prepare(
      "INSERT INTO sessions (id, created_at, cwd, system, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("fresh-sess", now, dir, "", now)
    return { db, oldId: S, newId: "fresh-sess" }
  }

  test("F1. an expired session leaves NO executable task rows (the F6 fix)", async () => {
    const { purgeExpired } = await import("../src/session/persistence.ts")
    const prevTtl = process.env.MINICODE_SESSION_TTL_DAYS
    process.env.MINICODE_SESSION_TTL_DAYS = "30"
    try {
      const { db } = await seed()
      // the expired session owns a CLAIMED task: executable autonomous work
      const t = store.createTask(S, {
        title: "orphaned work",
        status: "PENDING",
        order: 1,
        provenance: prov,
      })
      const c = claim(t)
      expect(store.getExecutionOwnership(S, t.id)!.executionOwner).toBe("scheduler")

      const gone = purgeExpired(db)
      expect(gone).toBe(1)

      // the task row AND its lineage are gone, not merely unreachable
      expect(store.listTasks(S)).toEqual([])
      expect(store.getTask(S, t.id)).toBeNull()
      // and a late execution of it is refused
      expect(store.recordAttemptReturned(S, t.id, c.execGeneration, c.sessionIncarnation)).toBe(
        "SESSION_SUPERSEDED",
      )
      db.close()
    } finally {
      if (prevTtl === undefined) delete process.env.MINICODE_SESSION_TTL_DAYS
      else process.env.MINICODE_SESSION_TTL_DAYS = prevTtl
    }
  })

  test("F2. a NON-expired session's tasks are untouched", async () => {
    const { purgeExpired } = await import("../src/session/persistence.ts")
    const prevTtl = process.env.MINICODE_SESSION_TTL_DAYS
    process.env.MINICODE_SESSION_TTL_DAYS = "30"
    try {
      const { db, newId } = await seed()
      // a claimed task on the FRESH session
      const other = store.createTask(newId, {
        title: "live work",
        status: "PENDING",
        order: 1,
        provenance: prov,
      })
      claim(other, newId)
      purgeExpired(db)
      // untouched
      expect(store.getTask(newId, other.id)!.status).toBe("IN_PROGRESS")
      expect(store.getExecutionOwnership(newId, other.id)!.executionOwner).toBe("scheduler")
      expect(store.getExecutionLineage(newId, other.id)!.attemptGeneration).toBeNull()
      db.close()
    } finally {
      if (prevTtl === undefined) delete process.env.MINICODE_SESSION_TTL_DAYS
      else process.env.MINICODE_SESSION_TTL_DAYS = prevTtl
    }
  })

  test("F3. repeated purge is idempotent and safe", async () => {
    const { purgeExpired } = await import("../src/session/persistence.ts")
    const prevTtl = process.env.MINICODE_SESSION_TTL_DAYS
    process.env.MINICODE_SESSION_TTL_DAYS = "30"
    try {
      const { db } = await seed()
      add()
      claim(store.listTasks(S)[0]!)
      expect(purgeExpired(db)).toBe(1)
      expect(purgeExpired(db)).toBe(0)
      expect(purgeExpired(db)).toBe(0)
      expect(store.listTasks(S)).toEqual([])
      db.close()
    } finally {
      if (prevTtl === undefined) delete process.env.MINICODE_SESSION_TTL_DAYS
      else process.env.MINICODE_SESSION_TTL_DAYS = prevTtl
    }
  })
})
