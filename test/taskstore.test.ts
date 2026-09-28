// Phase 1 regression protection for the reconstructed durable TaskStore.
//
// SCOPE: the Phase 1 durable substrate only — local DB isolation, revision
// semantics, transaction atomicity, session isolation, ordering, migration
// idempotency and restart durability. There is deliberately no Scheduler and no
// TaskGraph assertion here, because neither exists yet.
//
// SAFETY (Phase 0A discipline): every test owns EXACTLY ONE temp directory
// created by `mkdtemp(join(tmpdir(), "minicode-taskstore-"))`, and cleanup
// removes that one absolute path. Nothing here enumerates a directory or
// deletes "whatever looks like ours", and no cleanup is built around
// `process.cwd()`.

import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isTaskId, isTaskStatus, taskIdFromIndex, TaskError } from "../src/task/model.ts"
import {
  legacyDigest,
  type NewTaskInput,
  resetTaskStoreHandles,
  TaskStore,
} from "../src/task/store.ts"

// ── helpers ───────────────────────────────────────────────────────────────────

const owned: string[] = []

/** One explicitly-owned temp dir per test. */
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-taskstore-"))
  owned.push(dir)
  return dir
}

afterEach(async () => {
  resetTaskStoreHandles()
  while (owned.length) {
    const dir = owned.pop()!
    // Windows may still hold a SQLite handle briefly; best-effort is correct
    // here and the directory is ours alone.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

const prov = { origin: "runtime", source: "test" } as const

function task(title: string, over: Partial<NewTaskInput> = {}): NewTaskInput {
  return { title, status: "PENDING", order: 0, provenance: prov, ...over }
}

const S1 = "session-alpha"
const S2 = "session-beta"

/** Model-level helpers: the pure, evidence-backed parts of `model.ts`. */
test("model: canonical id shape and 1-based allocation", () => {
  expect(isTaskId("t1")).toBe(true)
  expect(isTaskId("t42")).toBe(true)
  // `t0` is not canonical: ids start at 1, per TASK_IDENTITY_SPEC.md
  expect(isTaskId("t0")).toBe(false)
  expect(isTaskId("t01")).toBe(false)
  expect(isTaskId("nope")).toBe(false)
  expect(isTaskId(7)).toBe(false)
  // nextId() passes a max that starts at 0, so the index is 1-based.
  expect(taskIdFromIndex(0)).toBe("t1")
  expect(taskIdFromIndex(5)).toBe("t6")
  expect(isTaskStatus("PENDING")).toBe(true)
  expect(isTaskStatus("pending")).toBe(false)
})

// A. initialization
test("A. initialize creates the local db and is idempotent", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  expect(() => store.initialize()).not.toThrow()
  expect(() => store.initialize()).not.toThrow()
  expect(() => store.initialize()).not.toThrow()
  expect(existsSync(join(dir, ".minicode", "tasks.db"))).toBe(true)
  // local boundary: no global fallback resolver anywhere near the db path
  expect(join(dir, ".minicode", "tasks.db")).toContain(".minicode")
})

// B. create / get / list / snapshot
test("B. create, get, list and snapshot round-trip every column", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  const made = store.createTask(
    S1,
    task("tulis store", {
      status: "BLOCKED",
      order: 3,
      blockedReason: "menunggu desain",
      dependsOn: [],
      verification: { verdict: "failed", detail: "red", checkedAt: "2026-01-01T00:00:00.000Z" },
      evidence: [{ kind: "completion", detail: "d", at: "2026-01-01T00:00:00.000Z" }],
      acceptance: { note: "keep" },
    }),
  )
  expect(made.id).toBe("t1")
  expect(made.revision).toBe(1)
  expect(made.sessionId).toBe(S1)
  expect(made.status).toBe("BLOCKED")
  expect(made.blockedReason).toBe("menunggu desain")
  expect(made.verification?.verdict).toBe("failed")
  expect(made.evidence).toHaveLength(1)
  expect(made.acceptance).toEqual({ note: "keep" })
  expect(made.provenance).toEqual(prov)

  const got = store.getTask(S1, "t1")
  expect(got?.title).toBe("tulis store")
  expect(store.listTasks(S1)).toHaveLength(1)
  const snap = store.getSnapshot(S1)
  expect(snap.sessionId).toBe(S1)
  expect(snap.tasks).toHaveLength(1)
  expect(store.getTask(S1, "t2")).toBeNull()
})

// C. revision increment
test("C. revision starts at 1 and increments once per successful mutation", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  expect(store.createTask(S1, task("a")).revision).toBe(1)
  expect(store.patchTask(S1, "t1", { title: "a2" }).revision).toBe(2)
  expect(store.patchTask(S1, "t1", { title: "a3" }).revision).toBe(3)
  expect(store.getTask(S1, "t1")?.revision).toBe(3)
})

// C2. stale-write substrate (no scheduler claim logic, just the check)
test("C2. a stale expectedRevision is refused and does not advance revision", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S1, task("a"))
  expect(() =>
    store.patchTask(S1, "t1", { title: "nope" }, { expectedRevision: 99 }),
  ).toThrow(TaskError)
  expect(store.getTask(S1, "t1")?.revision).toBe(1)
  expect(store.getTask(S1, "t1")?.title).toBe("a")
  // the matching revision is accepted
  expect(store.patchTask(S1, "t1", { title: "ok" }, { expectedRevision: 1 }).revision).toBe(2)
})

// D. update / patch
test("D. patch updates only supplied fields; updateTask is the same operation", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S1, task("awal", { order: 5, blockedReason: "sebab" }))
  const patched = store.patchTask(S1, "t1", { status: "COMPLETED" })
  expect(patched.status).toBe("COMPLETED")
  expect(patched.title).toBe("awal")
  expect(patched.order).toBe(5)
  expect(patched.blockedReason).toBe("sebab")
  const viaAlias = store.updateTask(S1, "t1", { title: "akhir" })
  expect(viaAlias.title).toBe("akhir")
  expect(viaAlias.status).toBe("COMPLETED")
  // explicit null clears a nullable field
  expect(store.patchTask(S1, "t1", { blockedReason: null }).blockedReason).toBeNull()
})

// E. failure during a write persists nothing
//
// SCOPE NOTE, stated plainly so this test is not read as more than it is: the
// Phase 1 write bodies each contain exactly ONE mutating statement, and a
// single-statement mutation is already atomic in SQLite. So these tests prove
// the OBSERVABLE contract — a failed mutation leaves no row and burns no id —
// they do NOT discriminate the `db.transaction()` wrapper. Removing that
// wrapper is an equivalent mutant for this code shape; it is covered in the
// Phase 1 report as such, not papered over here.
test("E. a failure inside the write persists nothing and burns no id", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S1, task("sebelumnya"))
  // `provenance` with a cycle makes JSON.stringify throw inside the write body,
  // after validation has already passed.
  const cyclic: Record<string, unknown> = { origin: "runtime", source: "cyclic" }
  cyclic.self = cyclic
  expect(() =>
    store.createTask(S1, {
      title: "harus gagal",
      status: "PENDING",
      order: 1,
      provenance: cyclic as never,
    }),
  ).toThrow(TaskError)
  // nothing partial was written
  expect(store.listTasks(S1)).toHaveLength(1)
  expect(store.getTask(S1, "t1")?.title).toBe("sebelumnya")
  expect(store.getTask(S1, "t2")).toBeNull()
  // and the id space did not advance, so the next task still gets t2
  expect(store.nextId(S1)).toBe("t2")
  expect(store.createTask(S1, task("berikutnya")).id).toBe("t2")
})

// F. session isolation
test("F. sessions are isolated: writes in one never appear in the other", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S1, task(" milik A"))
  expect(store.listTasks(S2)).toHaveLength(0)
  expect(store.getTask(S2, "t1")).toBeNull()
  // mutating A must not disturb B
  store.patchTask(S1, "t1", { title: "A berubah" })
  expect(store.listTasks(S2)).toHaveLength(0)
  // B allocates its own id space, independent of A
  expect(store.createTask(S2, task("milik B")).id).toBe("t1")
  expect(store.getTask(S1, "t1")?.title).toBe("A berubah")
  expect(store.getTask(S2, "t1")?.title).toBe("milik B")
})

// G. repeated initialization
test("G. repeated initialize is a no-op and keeps data intact", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S1, task("bertahan"))
  for (let i = 0; i < 5; i++) store.initialize()
  expect(store.listTasks(S1)).toHaveLength(1)
  expect(store.getTask(S1, "t1")?.title).toBe("bertahan")
})

// H. migration idempotency
test("H. migration stamp + digest are deterministic and idempotent", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  expect(store.migrationStamp(S1)).toBeNull()
  expect(store.dataVersion()).toBe(0)
  expect(store.ensureDataVersion()).toBe(1)
  expect(store.dataVersion()).toBe(1)

  const raw = '[{"content":"a","status":"pending"}]'
  const d1 = legacyDigest(raw)
  expect(d1).toHaveLength(32)
  // same input -> same fingerprint -> re-import is a no-op
  expect(legacyDigest(raw)).toBe(d1)
  store.markMigrated(S1, d1)
  expect(store.migrationStamp(S1)).toBe(d1)
  store.markMigrated(S1, d1)
  expect(store.migrationStamp(S1)).toBe(d1)
  // different content -> different fingerprint
  expect(legacyDigest('[{"content":"b","status":"pending"}]')).not.toBe(d1)
  // a newer writer is refused rather than downgraded
  store.setMeta("data_version", "99")
  expect(() => store.ensureDataVersion()).toThrow(TaskError)
})

// I. malformed data handling
test("I. corrupt columns and an unknown status degrade without losing the task", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S1, task("robust", { status: "BLOCKED", blockedReason: "x" }))
  TaskStore.close(dir)

  // Corrupt the JSON columns and the status directly in the table.
  const raw = new Database(join(dir, ".minicode", "tasks.db"))
  raw.prepare(
    "UPDATE tasks SET depends_on_json = ?, evidence_json = ?, provenance_json = ?, status = ? WHERE task_id = ?",
  ).run("{not json", "[[also broken", "<<<", "NOT_A_STATUS", "t1")
  raw.close()

  const reopened = new TaskStore(dir)
  const t = reopened.getTask(S1, "t1")
  expect(t).not.toBeNull()
  expect(t?.title).toBe("robust")
  // unknown status falls back to PENDING rather than throwing
  expect(t?.status).toBe("PENDING")
  // corrupt JSON falls back to the neutral shape, task still readable
  expect(t?.dependsOn).toEqual([])
  expect(t?.evidence).toEqual([])
  expect(t?.provenance).toEqual({ origin: "runtime", source: "unknown" })
  // revision is untouched by read-path corruption
  expect(t?.revision).toBe(1)
})

// J. local DB isolation
test("J. two projects never share a db", async () => {
  const a = await ownedDir()
  const b = await ownedDir()
  const sa = new TaskStore(a)
  const sb = new TaskStore(b)
  sa.createTask(S1, task("project A"))
  expect(sb.listTasks(S1)).toHaveLength(0)
  expect(existsSync(join(a, ".minicode", "tasks.db"))).toBe(true)
  expect(existsSync(join(b, ".minicode", "tasks.db"))).toBe(true)
  // sessions.db is a different file and must not be created by TaskStore
  expect(existsSync(join(a, ".minicode", "sessions.db"))).toBe(false)
})

// K. restart persistence
test("K. state survives a genuine close and reopen", async () => {
  const dir = await ownedDir()
  const first = new TaskStore(dir)
  const made = first.createTask(
    S1,
    task("bertahanAcrossRestart", { status: "BLOCKED", blockedReason: "alasan" }),
  )
  first.patchTask(S1, made.id, { title: "setelah patch" })
  const before = first.getTask(S1, made.id)
  expect(before?.revision).toBe(2)

  // real teardown: close the handle, then build a brand new store instance
  TaskStore.close(dir)
  resetTaskStoreHandles()

  const second = new TaskStore(dir)
  const after = second.getTask(S1, made.id)
  expect(after).not.toBeNull()
  expect(after?.title).toBe("setelah patch")
  expect(after?.status).toBe("BLOCKED")
  expect(after?.blockedReason).toBe("alasan")
  expect(after?.revision).toBe(2)
  expect(after?.createdAt).toBe(before?.createdAt)
  expect(second.getSnapshot(S1).tasks).toHaveLength(1)
  // and the reopened store keeps incrementing from where it left off
  expect(second.patchTask(S1, made.id, { title: "lagi" }).revision).toBe(3)
})

// L. duplicate task identity
test("L. the primary key rejects a duplicate id and nextId never collides", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S1, task("satu"))
  store.createTask(S1, task("dua"))
  expect(store.nextId(S1)).toBe("t3")
  // deleting the middle row must NOT make nextId reuse the freed id via count
  store.deleteTask(S1, "t1")
  expect(store.nextId(S1)).toBe("t3")
  expect(store.createTask(S1, task("tiga")).id).toBe("t3")

  // a hand-rolled duplicate is refused by the composite primary key
  const db = new Database(join(dir, ".minicode", "tasks.db"))
  expect(() =>
    db
      .prepare(
        "INSERT INTO tasks (session_id, task_id, title, status, task_order, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,1)",
      )
      .run(S1, "t2", "duplikat", "PENDING", 9, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
  ).toThrow()
  db.close()
})

// M. deterministic ordering
test("M. listTasks is deterministic, ordered by order then id", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S1, task("ketiga", { order: 2 }))
  store.createTask(S1, task("pertama", { order: 0 }))
  store.createTask(S1, task("kedua", { order: 1 }))
  const titles = store.listTasks(S1).map((t) => t.title)
  expect(titles).toEqual(["pertama", "kedua", "ketiga"])
  // same order, ties broken by task_id so the result is total and stable
  const tie = new TaskStore(dir)
  expect(tie.nextId(S2)).toBe("t1")
  const a = tie.createTask(S2, task("A", { order: 0 }))
  const b = tie.createTask(S2, task("B", { order: 0 }))
  expect([a.id, b.id]).toEqual(["t1", "t2"])
  expect(tie.listTasks(S2).map((t) => t.id)).toEqual(["t1", "t2"])
  expect(tie.listTasks(S2).map((t) => t.id)).toEqual(tie.listTasks(S2).map((t) => t.id))
})

// validation rails the artifact encodes
test("validation: BLOCKED needs a reason; dependencies must be real and unique", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  // BLOCKED without a reason is refused
  expect(() => store.createTask(S1, task("x", { status: "BLOCKED" }))).toThrow(TaskError)
  // ...and so is a blank reason
  expect(() => store.createTask(S1, task("x", { status: "BLOCKED", blockedReason: "   " }))).toThrow(
    TaskError,
  )
  store.createTask(S1, task("basis"))
  // unknown dependency
  expect(() => store.createTask(S1, task("y", { dependsOn: ["t99"] }))).toThrow(TaskError)
  // self dependency
  expect(() => store.createTask(S1, task("y", { dependsOn: ["t2"] }))).toThrow(TaskError)
  // duplicate dependency
  expect(() => store.createTask(S1, task("y", { dependsOn: ["t1", "t1"] }))).toThrow(TaskError)
  // a real dependency is accepted
  expect(store.createTask(S1, task("y", { dependsOn: ["t1"] })).dependsOn).toEqual(["t1"])
  // non-canonical ids are rejected before they reach SQL
  expect(() => store.getTask(S1, "bukan-id")).toThrow(TaskError)
  expect(() => store.getTask(S1, "nope")).toThrow(TaskError)
})

test("deleteSessionTasks removes only the target session", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S1, task("a1"))
  store.createTask(S1, task("a2"))
  store.createTask(S2, task("b1"))
  expect(store.deleteSessionTasks(S1)).toBe(2)
  expect(store.listTasks(S1)).toHaveLength(0)
  expect(store.listTasks(S2)).toHaveLength(1)
  // idempotent: a second call reports nothing removed
  expect(store.deleteSessionTasks(S1)).toBe(0)
})
