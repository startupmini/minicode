// Phase 4A.2 regression protection: TaskStore-OWNED transaction boundary.
//
// THE PROBLEM THIS FIXES. A caller used to be able to open its own
// `db.transaction(...)` and call TaskStore methods inside it, and get atomicity
// that was silently FALSE. TaskStore holds its own cached `Database` handle, so
// the caller's transaction and TaskStore's writes were two different connections
// and committed independently. Measured: a forced throw rolled back nothing.
//
// Test J below is that exact regression, and it deliberately still demonstrates
// the old failure mode (a caller-side transaction remains non-atomic) alongside
// the new correct one.
//
// SAFETY (Phase 0A discipline): one `mkdtemp(join(tmpdir(), "minicode-tx-"))`
// directory per test, removed by that exact absolute path. No `readdir(".")`, no
// pattern delete, no cwd-based cleanup.

import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskError } from "../src/task/model.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-tx-"))
  owned.push(dir)
  return dir
}
afterEach(async () => {
  // guards are reset per test; these run outside any transaction
  try {
    resetTaskStoreHandles()
  } catch {}
  while (owned.length) await rm(owned.pop()!, { recursive: true, force: true }).catch(() => {})
})

const S = "tx-session"
const prov = { origin: "runtime", source: "test" } as const
const newTask = (title: string, order = 0) => ({
  title,
  status: "PENDING" as const,
  order,
  provenance: prov,
})

// A. committed task transaction persists
test("A. a committed transaction persists every task mutation", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  const made = store.withTransaction((tx) => {
    const a = tx.createTask(S, newTask("A", 0))
    const b = tx.createTask(S, newTask("B", 1))
    tx.patchTask(S, a.id, { title: "A2" })
    return [a.id, b.id]
  })
  expect(made).toEqual(["t1", "t2"])
  expect(store.listTasks(S).map((t) => [t.id, t.title])).toEqual([
    ["t1", "A2"],
    ["t2", "B"],
  ])
  // t1 was patched inside the transaction, so it advanced; t2 was only created
  expect(store.getTask(S, "t1")?.revision).toBe(2)
  expect(store.getTask(S, "t2")?.revision).toBe(1)
})

// B. thrown callback rolls back task creation
test("B. a thrown callback rolls back task creation", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S, newTask("pre-existing", 0))
  expect(() =>
    store.withTransaction((tx) => {
      tx.createTask(S, newTask("ghost-1", 1))
      tx.createTask(S, newTask("ghost-2", 2))
      throw new Error("boom")
    }),
  ).toThrow("boom")
  expect(store.listTasks(S)).toHaveLength(1)
  expect(store.getTask(S, "t1")?.title).toBe("pre-existing")
  expect(store.getTask(S, "t2")).toBeNull()
})

// C. thrown callback rolls back task update
test("C. a thrown callback rolls back a task update", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S, newTask("original", 0))
  expect(() =>
    store.withTransaction((tx) => {
      tx.patchTask(S, "t1", { title: "mutated", status: "COMPLETED" })
      throw new Error("nope")
    }),
  ).toThrow()
  const t = store.getTask(S, "t1")
  expect(t?.title).toBe("original")
  expect(t?.status).toBe("PENDING")
  expect(t?.revision).toBe(1)
})

// D. task + metadata rollback together
test("D. task mutation and metadata roll back as ONE unit", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  expect(() =>
    store.withTransaction((tx) => {
      tx.createTask(S, newTask("tx-task", 0))
      tx.setMeta("migrated:tx-session", "digest-should-not-persist")
      throw new Error("fail after both")
    }),
  ).toThrow()
  expect(store.listTasks(S)).toHaveLength(0)
  expect(store.getMeta("migrated:tx-session")).toBeNull()
})

// E. task + metadata commit together
test("E. task mutation and metadata commit as ONE unit", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.withTransaction((tx) => {
    tx.createTask(S, newTask("tx-task", 0))
    tx.setMeta("migrated:tx-session", "digest-persisted")
  })
  expect(store.listTasks(S)).toHaveLength(1)
  expect(store.getMeta("migrated:tx-session")).toBe("digest-persisted")
})

// F. allocation rollback
test("F. an allocation made inside a failed transaction leaves no durable orphan", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  expect(() =>
    store.withTransaction((tx) => {
      const t = tx.createTask(S, newTask("rolled-back", 0))
      expect(t.id).toBe("t1")
      throw new Error("abort")
    }),
  ).toThrow()
  expect(store.listTasks(S)).toHaveLength(0)
  expect(store.getTask(S, "t1")).toBeNull()
})

// G. subsequent allocation behaviour after rollback
test("G. after a rollback the next allocation reuses the freed id (max-based, no gap)", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S, newTask("keeper", 0))
  expect(store.nextId(S)).toBe("t2")
  expect(() =>
    store.withTransaction((tx) => {
      tx.createTask(S, newTask("ghost", 1))
      throw new Error("abort")
    }),
  ).toThrow()
  // t2 was never durably allocated, so the next real task takes it
  expect(store.listTasks(S)).toHaveLength(1)
  const next = store.createTask(S, newTask("real", 1))
  expect(next.id).toBe("t2")
  expect(store.listTasks(S).map((t) => t.id)).toEqual(["t1", "t2"])
})

// H. multiple mutations in one transaction
test("H. many mutations inside one transaction are all-or-nothing", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.withTransaction((tx) => {
    for (let i = 0; i < 25; i++) tx.createTask(S, newTask(`task-${i}`, i))
  })
  expect(store.listTasks(S)).toHaveLength(25)
  expect(() =>
    store.withTransaction((tx) => {
      for (let i = 0; i < 5; i++) tx.createTask(S, newTask(`more-${i}`, 100 + i))
      throw new Error("abort half way")
    }),
  ).toThrow()
  expect(store.listTasks(S)).toHaveLength(25)
})

// I. transaction error propagation
test("I. the callback's error propagates unchanged; a return value is passed through", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  class CustomError extends Error {}
  expect(() =>
    store.withTransaction(() => {
      throw new CustomError("mine")
    }),
  ).toThrow(CustomError)
  expect(store.withTransaction(() => 42)).toBe(42)
  // a TaskError from inside also propagates with its code intact
  try {
    store.withTransaction((tx) => tx.getTask(S, "not-an-id"))
    throw new Error("should have thrown")
  } catch (e) {
    expect((e as TaskError).code).toBe("TASK_INVALID_ID")
  }
})

// J. CROSS-CONNECTION REGRESSION - the core proof
test("J. a caller-side transaction is still NOT atomic, while the TaskStore one IS", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.initialize()

  // (i) OLD architecture: caller opens its own transaction on a SEPARATE
  // connection. TaskStore writes go to its own cached handle, so they commit
  // independently. This documents the bug that 4A.2 exists to fix.
  const foreign = new Database(join(dir, ".minicode", "tasks.db"))
  let caught = ""
  try {
    foreign.transaction(() => {
      store.createTask(S, newTask("escaped", 0))
      throw new Error("caller abort")
    })()
  } catch (e) {
    caught = (e as Error).message
  } finally {
    foreign.close()
  }
  expect(caught).toBe("caller abort")
  // NOT rolled back - the historical defect, proven through the public API
  expect(store.listTasks(S)).toHaveLength(1)

  // (ii) NEW architecture: TaskStore-owned transaction. Same throw, same
  // public API, but it DOES roll back.
  expect(() =>
    store.withTransaction((tx) => {
      tx.createTask(S, newTask("rolled-back-properly", 1))
      throw new Error("owner abort")
    }),
  ).toThrow("owner abort")
  expect(store.listTasks(S)).toHaveLength(1)
  expect(store.getTask(S, "t1")?.title).toBe("escaped")
  expect(store.getTask(S, "t2")).toBeNull()
})

// K. nested transaction semantics
test("K. a nested withTransaction joins the outer one rather than committing alone", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S, newTask("anchor", 0))

  // inner throw is caught by the callback; the outer must still roll back
  expect(() =>
    store.withTransaction((tx) => {
      tx.createTask(S, newTask("outer-only", 1))
      try {
        tx.withTransaction((inner) => {
          inner.createTask(S, newTask("inner-only", 2))
          throw new Error("inner abort")
        })
      } catch (e) {
        expect((e as Error).message).toBe("inner abort")
      }
      throw new Error("outer abort")
    }),
  ).toThrow("outer abort")
  expect(store.listTasks(S)).toHaveLength(1)

  // depth is restored to zero afterwards, so close() is permitted again
  expect(store.inTransaction()).toBe(false)
  store.withTransaction((tx) => {
    expect(tx.inTransaction()).toBe(true)
  })
  expect(store.inTransaction()).toBe(false)
})

// K2. the savepoint semantics that make nesting meaningful
test("K2. an inner rollback does not discard the outer transaction's work", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S, newTask("anchor", 0))

  store.withTransaction((tx) => {
    tx.createTask(S, newTask("outer-survives", 1))
    try {
      tx.withTransaction((inner) => {
        inner.createTask(S, newTask("inner-discarded", 2))
        throw new Error("inner abort only")
      })
    } catch {
      // the outer deliberately absorbs the inner failure and commits
    }
  })

  // the outer work committed...
  expect(store.getTask(S, "t2")?.title).toBe("outer-survives")
  // ...while the inner work was rolled back by the savepoint
  expect(store.getTask(S, "t3")).toBeNull()
  expect(store.listTasks(S).map((t) => t.id)).toEqual(["t1", "t2"])
})

// L. lifecycle safety: close/reset are refused while a transaction is open
test("L. close and reset are refused mid-transaction, and allowed again after", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.initialize()
  store.withTransaction((tx) => {
    expect(() => TaskStore.close(dir)).toThrow(TaskError)
    expect(() => TaskStore.close(dir)).toThrow("transaction is open")
    expect(() => resetTaskStoreHandles()).toThrow("transaction")
    tx.createTask(S, newTask("works-inside", 0))
  })
  // outside the transaction the same calls are permitted again
  expect(() => resetTaskStoreHandles()).not.toThrow()
  expect(() => TaskStore.close(dir)).not.toThrow()
  // and the data was committed
  const reopened = new TaskStore(dir)
  expect(reopened.getTask(S, "t1")?.title).toBe("works-inside")
})
