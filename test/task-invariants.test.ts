// Invariant task domain (agent-task-architect, INV-001/002/003/009).
//
// Yang dikunci di sini:
//  - INV-003: `completed` Butuh bukti. Bukti merah → completed DITOLAK, task
//    menjadi `blocked` beserta alasannya, dan model diberi tahu lewat hasil
//    tool (bukan hanya diam-diam tersimpan di file).
//  - Konsistensi store: `plan.updated` yang dibaca manusia/mesin harus sama
//    dengan file todo. Satu normalizer, satu cap, satu keputusan status.
//  - Integritas publish: plan event tidak boleh terbit untuk todo_write yang
//    GAGAL (sebelumnya terbit dari argumen di `execution:started`).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LIMITS } from "../src/constants.ts"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike } from "../src/presentation/events.ts"
import {
  clearCompletionEvidence,
  loadTodos,
  normalizeTodos,
  reconcileCompletionEvidence,
  renderPlan,
  renderTodos,
  setCompletionEvidence,
  todoSession,
  todoWriteTool,
} from "../src/tools/todo.ts"

const dirs: string[] = []
async function rmDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "minicode-task-inv-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  clearCompletionEvidence()
  todoSession.id = "default"
  todoSession.cwd = undefined
  for (const dir of dirs.splice(0)) await rmDir(dir)
})

// ── Fake bus (pola sama seperti test/presentation-events.test.ts) ──────────
function fakeBus(): EventBusLike & { emit: (type: string, payload: unknown) => void } {
  const handlers = new Map<string, Set<(e: unknown) => void>>()
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<(e: unknown) => void>()
      set.add(handler as (e: unknown) => void)
      handlers.set(type, set)
      return () => set.delete(handler as (e: unknown) => void)
    },
    emit(type, payload) {
      const set = handlers.get(type)
      if (set) for (const h of [...set]) h(payload)
    },
  }
}

function adapterFor() {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, { sessionId: "s" })
  const events: DomainEvent[] = []
  adapter.onEvent((e) => events.push(e))
  return { bus, events }
}

const planArgs = (todos: unknown[]) => ({ todos })

describe("INV-003 completion butuh bukti", () => {
  test("bukti merah menolak completed → blocked + alasan tercatat", () => {
    setCompletionEvidence(() => ({ verdict: "failed", detail: "tsc: 2 errors" }))
    const out = normalizeTodos([
      { content: "Buka repo", status: "completed" },
      { content: "Tulis patch", status: "in_progress" },
    ])
    expect(out[0]?.status).toBe("blocked")
    expect(out[0]?.blockedReason).toBe("tsc: 2 errors")
    // Task yang bukan `completed` tak boleh ikut turun ke blocked.
    expect(out[1]?.status).toBe("in_progress")
  })

  test("bukti hijau / tak ada bukti tetap mengizinkan completed", () => {
    clearCompletionEvidence()
    expect(normalizeTodos([{ content: "a", status: "completed" }])[0]?.status).toBe("completed")
    setCompletionEvidence(() => ({ verdict: "passed" }))
    expect(normalizeTodos([{ content: "a", status: "completed" }])[0]?.status).toBe("completed")
  })

  test("sumber bukti yang melempar tidak boleh menuntaskan task diam-diam", () => {
    setCompletionEvidence(() => {
      throw new Error("verify runner gone")
    })
    const out = normalizeTodos([{ content: "a", status: "completed" }])
    expect(out[0]?.status).toBe("blocked")
  })

  test("render menampilkan status blocked beserta alasannya", () => {
    setCompletionEvidence(() => ({ verdict: "failed", detail: "lint: 3 errors" }))
    const text = renderTodos(normalizeTodos([{ content: "a", status: "completed" }]))
    expect(text).toContain("[!]")
    expect(text).toContain("blocked")
    expect(text).toContain("lint: 3 errors")
  })

  // ── PF-04: `blocked` harus terkurung semantik ──────────────────────────────
  test("blocked tanpa alasan tidak boleh ada (PF-04)", () => {
    // Dua pagar: `blocked` tidak ada di enum model, DAN `normalizeTodos`
    // menurunkan blocker tanpa alasan ke `pending`. Pagar kedua ini yang
    // diuji di sini — file ditulis tangan / jalur argumen lain.
    const out = normalizeTodos([{ content: "Merah tanpa alasan", status: "blocked" }], {
      verdict: "unverified",
    })
    expect(out[0]?.status).toBe("pending")
    expect(out[0]?.blockedReason).toBeUndefined()
  })

  test("blocked DENGAN alasan dari file dipertahankan (PF-04 + PF-03)", () => {
    const out = normalizeTodos(
      [{ content: "Merah beralasan", status: "blocked", blockedReason: "verify: 3 errors" }],
      { verdict: "unverified" },
    )
    expect(out[0]?.status).toBe("blocked")
    expect(out[0]?.blockedReason).toBe("verify: 3 errors")
  })

  test("enum model tidak menawarkan `blocked` (PF-04)", () => {
    const schema = todoWriteTool.parameters as {
      properties: { todos: { items: { properties: { status: { enum: string[] } } } } }
    }
    const statuses = schema.properties.todos.items.properties.status.enum
    expect(statuses).not.toContain("blocked")
    expect(statuses).toContain("completed")
  })

  test("verify merah menghasilkan blocked, bukan `failed` (FDD != BLOCKED)", () => {
    // `blocked` berarti "ada yang menahan dengan bukti", bukan "percobaan
    // sudah dijalankan dan gagal" — itu status `failed` yang belum ada di
    // fondasi dan sengaja tidak ditambahkan di pass ini.
    setCompletionEvidence(() => ({ verdict: "failed", detail: "verify merah" }))
    const out = normalizeTodos([{ content: "x", status: "completed" }])
    expect(out[0]?.status).toBe("blocked")
    expect(out[0]?.status).not.toBe("failed")
  })

  test("tool memberi tahu model saat completion ditolak (bukan diam-diam)", async () => {
    const dir = workspace()
    todoSession.id = "s1"
    todoSession.cwd = dir
    setCompletionEvidence(() => ({ verdict: "failed", detail: "test gagal" }))
    const out = await todoWriteTool.execute(
      { todos: [{ content: "Tugas A", status: "completed" }] } as never,
      { signal: new AbortController().signal, cwd: dir } as never,
    )
    const text = String(out)
    expect(text).toContain("refused 1 completion claim")
    // Dan file-nya memang blocked, bukan completed.
    const persisted = await loadTodos("s1", dir)
    expect(persisted[0]?.status).toBe("blocked")
  })
})

describe("PF-02 jalur baca pasif", () => {
  test("disk `completed` + bukti merah → loadTetap `completed` (PF-02)", async () => {
    // Baca TIDAK boleh menerapkan kebijakan. Kalau iya, `todo_read` melaporkan
    // blocked sementara file tetap completed — durable != observed, dan tidak
    // ada yang menyelaraskan.
    const dir = workspace()
    todoSession.id = "s2"
    todoSession.cwd = dir
    // Tulis tanpa gate.
    setCompletionEvidence(() => ({ verdict: "unverified" }))
    await todoWriteTool.execute(
      { todos: [{ content: "Terlihat selesai", status: "completed" }] } as never,
      { signal: new AbortController().signal, cwd: dir } as never,
    )
    // Sekarang bukti berubah merah.
    setCompletionEvidence(() => ({ verdict: "failed", detail: "verify: merah" }))
    const read = await loadTodos("s2", dir)
    expect(read[0]?.status).toBe("completed")
    // Tidak ada penulisan diam-diam: file tetap sama.
    const raw = readFileSync(join(dir, ".minicode", "todos", "s2.json"), "utf8")
    expect(raw).toContain('"status": "completed"')
  })

  test("reconcileCompletionEvidence adalah operasi TULIS yang eksplisit (PF-02)", async () => {
    const dir = workspace()
    todoSession.id = "s3"
    todoSession.cwd = dir
    setCompletionEvidence(() => ({ verdict: "unverified" }))
    await todoWriteTool.execute(
      { todos: [{ content: "Awalnya selesai", status: "completed" }] } as never,
      { signal: new AbortController().signal, cwd: dir } as never,
    )
    // Baca pasif: tak berubah walau bukti merah.
    setCompletionEvidence(() => ({ verdict: "failed", detail: "verify: merah" }))
    expect((await loadTodos("s3", dir))[0]?.status).toBe("completed")

    // Rekonsiliasi eksplisit → menulis balik.
    const next = await reconcileCompletionEvidence("s3", dir, {
      verdict: "failed",
      detail: "verify: merah",
    })
    expect(next?.[0]?.status).toBe("blocked")
    expect((await loadTodos("s3", dir))[0]?.status).toBe("blocked")

    // Idempoten: jalan kedua tak mengubah apa pun.
    expect(
      await reconcileCompletionEvidence("s3", dir, { verdict: "failed", detail: "x" }),
    ).toBeNull()
  })

  test("reconcile tidak melakukan apa-apa saat bukti bukan `failed` (PF-01)", async () => {
    const dir = workspace()
    await reconcileCompletionEvidence("s4", dir, { verdict: "passed" })
    expect(await loadTodos("s4", dir)).toEqual([])
  })
})

describe("PF-03 blockedReason durable lintas proses", () => {
  test("alasan blocker bertahan: write → baca ulang → renderPlan (PF-03)", async () => {
    const dir = workspace()
    todoSession.id = "s5"
    todoSession.cwd = dir
    setCompletionEvidence(() => ({ verdict: "failed", detail: "tsc: 2 errors" }))
    await todoWriteTool.execute(
      { todos: [{ content: "Tugas gagal", status: "completed" }] } as never,
      { signal: new AbortController().signal, cwd: dir } as never,
    )
    const reread = await loadTodos("s5", dir)
    expect(reread[0]?.blockedReason).toBe("tsc: 2 errors")
    // Dan artefak plan untuk manusia ikut memuat alasannya.
    const plan = renderPlan("s5", reread)
    expect(plan).toContain("tsc: 2 errors")
    expect(plan).toContain("(blocked)")
  })
})

describe("plan.updated konsisten dengan file todo", () => {
  test("satu in_progress di file = satu active di plan (bukan dua)", async () => {
    // Regresi: adaptor dulu memetakan status sendiri, jadi 2 item
    // in_progress → 2 `active` di plan padahal file menyimpan 1.
    const { bus, events } = adapterFor()
    const args = planArgs([
      { content: "Buka repo", status: "in_progress" },
      { content: "Tulis patch", status: "in_progress" },
      { content: "Jalankan test", status: "pending" },
    ])
    bus.emit("execution:started", {
      type: "execution:started",
      execution: { call: { id: "c1", name: "todo_write", args } },
    })
    bus.emit("execution:completed", {
      type: "execution:completed",
      execution: { call: { id: "c1", name: "todo_write", args }, result: { content: "ok" } },
    })
    const plan = events.find((e) => e.type === "plan.updated")
    expect(plan).toBeDefined()
    if (plan?.type !== "plan.updated") throw new Error("unreachable")
    const active = plan.steps.filter((s) => s.status === "active")
    expect(active.length).toBe(1)
    expect(plan.steps.map((s) => s.title)).toEqual(["Buka repo", "Tulis patch", "Jalankan test"])
  })

  test("cap plan sama dengan cap file (tak ada item hanya di event)", () => {
    const many = Array.from({ length: LIMITS.TODO_MAX_ITEMS + 10 }, (_, i) => ({
      content: `item ${i}`,
      status: "pending",
    }))
    const { bus, events } = adapterFor()
    const args = planArgs(many)
    bus.emit("execution:started", {
      type: "execution:started",
      execution: { call: { id: "c1", name: "todo_write", args } },
    })
    bus.emit("execution:completed", {
      type: "execution:completed",
      execution: { call: { id: "c1", name: "todo_write", args }, result: { content: "ok" } },
    })
    const plan = events.find((e) => e.type === "plan.updated")
    if (plan?.type !== "plan.updated") throw new Error("unreachable")
    // Dulu adaptor memotong di 100 sementara file 50 → item 51-100 hanya
    // hidup di event log. Sekarang keduanya mengikuti normalizeTodos.
    expect(plan.steps.length).toBe(LIMITS.TODO_MAX_ITEMS)
  })

  test("plan mencerminkan keputusan blocked dari bukti merah", () => {
    setCompletionEvidence(() => ({ verdict: "failed", detail: "verify merah" }))
    const { bus, events } = adapterFor()
    const args = planArgs([{ content: "A", status: "completed" }])
    bus.emit("execution:started", {
      type: "execution:started",
      execution: { call: { id: "c1", name: "todo_write", args } },
    })
    bus.emit("execution:completed", {
      type: "execution:completed",
      execution: { call: { id: "c1", name: "todo_write", args }, result: { content: "ok" } },
    })
    const plan = events.find((e) => e.type === "plan.updated")
    if (plan?.type !== "plan.updated") throw new Error("unreachable")
    expect(plan.steps[0]?.status).toBe("blocked")
    // Plan tidak boleh mengklaim "completed" saat buktinya merah.
    expect(plan.status).toBe("open")
  })
})

describe("integritas publish plan", () => {
  test("todo_write GAGAL tidak boleh meninggalkan plan.updated", () => {
    // Dulu plan terbit dari argumen di `execution:started`, jadi tetap durable
    // meski `saveTodos` gagal → presentasi bilang "completed" tanpa file.
    const { bus, events } = adapterFor()
    const args = planArgs([{ content: "A", status: "completed" }])
    bus.emit("execution:started", {
      type: "execution:started",
      execution: { call: { id: "c1", name: "todo_write", args } },
    })
    // Tidak ada execution:completed — tool gagal/abort.
    expect(events.filter((e) => e.type === "plan.updated").length).toBe(0)
  })

  test("todo_write yang dipanggil saja (belum selesai) tidak menerbitkan plan", () => {
    const { bus, events } = adapterFor()
    bus.emit("execution:started", {
      type: "execution:started",
      execution: {
        call: {
          id: "c1",
          name: "todo_write",
          args: planArgs([{ content: "A", status: "completed" }]),
        },
      },
    })
    expect(events.some((e) => e.type === "plan.updated")).toBe(false)
  })

  test("tool lain tidak pernah menghasilkan plan.updated", () => {
    const { bus, events } = adapterFor()
    bus.emit("execution:started", {
      type: "execution:started",
      execution: { call: { id: "c1", name: "read_file", args: { path: "x" } } },
    })
    bus.emit("execution:completed", {
      type: "execution:completed",
      execution: {
        call: { id: "c1", name: "read_file", args: { path: "x" } },
        result: { content: "x" },
      },
    })
    expect(events.some((e) => e.type === "plan.updated")).toBe(false)
  })
})
