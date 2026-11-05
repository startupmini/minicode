// P2.3 (Session 4) — authoritative TaskStore transitions reach the projection sink.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTaskTransitionSink, TaskStore, type TaskTransition } from "../src/task/store.ts"

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p23-task-"))
  dirs.push(d)
  return d
}

afterEach(() => {
  setTaskTransitionSink(null)
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {}
  }
})

describe("P2.3 task transition sink", () => {
  test("create/patch/claim memancarkan transisi authoritative setelah commit", () => {
    const dir = tempDir()
    const seen: TaskTransition[] = []
    setTaskTransitionSink((t) => seen.push(t))
    const store = new TaskStore(dir)

    const prov = { origin: "model", source: "p23" } as const
    const created = store.createTask("s1", {
      title: "a",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    store.patchTask("s1", created.id, { status: "IN_PROGRESS" })

    const claimable = store.createTask("s1", {
      title: "b",
      status: "PENDING",
      order: 2,
      provenance: prov,
    })
    const claim = store.claimTask("s1", claimable.id, claimable.revision)
    expect(claim.outcome).toBe("CLAIM_ACCEPTED")

    const kinds = seen.map((t) => t.kind)
    expect(kinds).toContain("created")
    expect(kinds).toContain("updated")
    expect(kinds).toContain("claimed")

    const updated = seen.find((t) => t.kind === "updated")
    expect(updated?.previousStatus).toBe("PENDING")
    expect(updated?.task.status).toBe("IN_PROGRESS")

    const claimed = seen.find((t) => t.kind === "claimed")
    expect(claimed?.previousStatus).toBe("PENDING")
    expect(claimed?.task.status).toBe("IN_PROGRESS")
    // Revision yang dilaporkan mencerminkan baris durable, bukan tebakan.
    expect(claim.task?.revision).toBe(claimed?.task.revision)
  })

  test("merge/cancel memancarkan transisi CANCELLED dengan revision durable", () => {
    const dir = tempDir()
    const seen: TaskTransition[] = []
    const store = new TaskStore(dir)
    const prov = { origin: "model", source: "p23" } as const
    const survivor = store.createTask("s1", {
      title: "keep",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    const duplicate = store.createTask("s1", {
      title: "dup",
      status: "PENDING",
      order: 2,
      provenance: prov,
    })
    setTaskTransitionSink((t) => seen.push(t))
    const res = store.declareTaskDuplicate({
      sessionId: "s1",
      survivorId: survivor.id,
      duplicateId: duplicate.id,
      evidence: "same unit of work",
    })
    expect(res.outcome).toBe("DECLARED")
    const cancelled = seen.find((t) => t.task.status === "CANCELLED")
    expect(cancelled).toBeDefined()
    expect(cancelled?.task.id).toBe(duplicate.id)
    expect(cancelled?.previousStatus).toBe("PENDING")
  })

  test("transisi yang ditolak tidak memancarkan event", () => {
    const dir = tempDir()
    const seen: TaskTransition[] = []
    const store = new TaskStore(dir)
    const t = store.createTask("s1", {
      title: "x",
      status: "COMPLETED",
      order: 1,
      provenance: { origin: "model", source: "p23" },
    })
    setTaskTransitionSink((e) => seen.push(e))
    // COMPLETED bersifat terminal; patch ke PENDING tanpa allowReopen ilegal.
    expect(() => store.patchTask("s1", t.id, { status: "PENDING" })).toThrow()
    expect(seen).toHaveLength(0)
  })
})
