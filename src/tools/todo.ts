import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"

// Todo list per sesi — state eksplisit untuk task multi-langkah.
// Tanpa ini agent tidak punya tempat menyimpan rencana antar step, sehingga
// pada task panjang ia lupa langkah yang belum dikerjakan.

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface TodoItem {
  content: string
  status: TodoStatus
}

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"]

const GLYPH: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
}

function sanitizeTodoId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "default"
}

function todoPath(sessionId: string, cwd: string): string {
  const safe = sanitizeTodoId(sessionId)
  return resolve(cwd, ".minicode", "todos", `${safe}.json`)
}

function planPath(sessionId: string, cwd: string): string {
  const safe = sanitizeTodoId(sessionId)
  return resolve(cwd, ".minicode", "plans", `${safe}.md`)
}

// Audit #13 chain 28: todo + plan snapshot adalah state milik sesi —
// deleteSession wajib menghapusnya agar konten rencana tak bertahan sebagai
// residual reachable pasca-hapus. Best-effort (kegagalan tak menggagalkan hapus).
export async function deleteTodoFiles(sessionId: string, cwd: string): Promise<void> {
  const { rm } = await import("node:fs/promises")
  await rm(todoPath(sessionId, cwd), { force: true }).catch(() => {})
  await rm(planPath(sessionId, cwd), { force: true }).catch(() => {})
}

/** Sanitasi + batasi daftar. Diekspor untuk test. */
export function normalizeTodos(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) throw new Error("todos must be an array")
  const out: TodoItem[] = []
  for (const raw of input.slice(0, LIMITS.TODO_MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as { content?: unknown; status?: unknown }
    const content = String(r.content ?? "")
      .trim()
      .slice(0, LIMITS.TODO_CONTENT_MAX_CHARS)
    if (!content) continue
    const status = STATUSES.includes(r.status as TodoStatus) ? (r.status as TodoStatus) : "pending"
    out.push({ content, status })
  }
  if (out.length === 0) throw new Error("todos is empty — provide at least one item with content")
  // Satu in_progress saja: kalau model menandai beberapa, sisanya turun ke
  // pending supaya daftar tetap punya satu fokus yang jelas.
  let seenActive = false
  for (const t of out) {
    if (t.status !== "in_progress") continue
    if (seenActive) t.status = "pending"
    seenActive = true
  }
  return out
}

export function renderTodos(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === "completed").length
  const active = todos.find((t) => t.status === "in_progress")
  const head = `todos ${done}/${todos.length}${active ? ` · sekarang: ${active.content}` : ""}`
  const body = todos.map((t) => `  ${GLYPH[t.status]} ${t.content}`).join("\n")
  return `${head}\n${body}`
}

export async function loadTodos(sessionId: string, cwd = process.cwd()): Promise<TodoItem[]> {
  try {
    const raw = await readFile(todoPath(sessionId, cwd), "utf8")
    const parsed = JSON.parse(raw) as { todos?: unknown }
    return normalizeTodos(parsed.todos ?? [])
  } catch {
    return []
  }
}

export async function saveTodos(
  sessionId: string,
  todos: TodoItem[],
  cwd = process.cwd(),
): Promise<void> {
  const p = todoPath(sessionId, cwd)
  await mkdir(resolve(cwd, ".minicode", "todos"), { recursive: true }).catch(() => {})
  await atomicWriteText(p, JSON.stringify({ sessionId, updatedAt: Date.now(), todos }, null, 2))
}

/** P13 P1 — plan artifact: snapshot markdown rencana per sesi.
 * JSON todos bagus untuk mesin tapi tak bisa dibaca kilat manusia; file ini
 * dibaca model berikutnya saat resume lintas sesi tanpa memutar ulang todo.
 * Best-effort: gagal tulis tak boleh menggagalkan todo_write. */
export function renderPlan(sessionId: string, todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === "completed").length
  const lines = [
    `# Plan — ${sessionId}`,
    ``,
    `Progress: ${done}/${todos.length} completed.`,
    ``,
    ...todos.map(
      (t) =>
        `- [${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : t.status === "cancelled" ? "-" : " "}] ${t.content} (${t.status})`,
    ),
    ``,
    `_Updated: ${new Date().toISOString()}_`,
    ``,
  ]
  return lines.join("\n")
}

export async function savePlanSnapshot(
  sessionId: string,
  todos: TodoItem[],
  cwd = process.cwd(),
): Promise<string> {
  const p = planPath(sessionId, cwd)
  await mkdir(resolve(cwd, ".minicode", "plans"), { recursive: true }).catch(() => {})
  await atomicWriteText(p, renderPlan(sessionId, todos))
  return p
}

export async function loadPlan(sessionId: string, cwd = process.cwd()): Promise<string | null> {
  try {
    return await readFile(planPath(sessionId, cwd), "utf8")
  } catch {
    return null
  }
}

/** Session id aktif — di-set CLI supaya todo tersimpan per sesi. */
export const todoSession = { id: "default", cwd: undefined as string | undefined }

export const todoWriteTool: Tool = {
  name: "todo_write",
  description:
    "Write/replace the todo list for this task. Send the ENTIRE list every time (not a delta). Use for tasks with 3+ steps: keep exactly one item in_progress at a time, mark it completed as soon as it is done.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "full todo list (replace, not delta)",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "short, actionable task item" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
            },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  async execute({ todos }, ctx) {
    ctx.signal.throwIfAborted()
    const list = normalizeTodos(todos)
    // cwd sesi dari ToolContext dulu (skenario --cwd / sub-agen), lalu global
    // yang di-set composition root (cli/setup.ts, MCP serve), terakhir cwd
    // proses. Urutan lama (global-dulu) buta terhadap ctx.
    const cwd = (ctx as { cwd?: string }).cwd ?? todoSession.cwd ?? process.cwd()
    await saveTodos(todoSession.id, list, cwd)
    // Plan artifact ditulis tiap save — murah (atomik, kecil) dan membuat
    // resume lintas sesi tidak butuh memutar ulang seluruh percakapan.
    await savePlanSnapshot(todoSession.id, list, cwd).catch(() => {})
    return renderTodos(list)
  },
}

export const todoReadTool: Tool = {
  name: "todo_read",
  description: "Read the todo list for this task (the last state written by todo_write).",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    ctx.signal.throwIfAborted()
    const cwd = (ctx as { cwd?: string }).cwd ?? todoSession.cwd ?? process.cwd()
    const list = await loadTodos(todoSession.id, cwd)
    if (list.length === 0) return "(no todos yet — use todo_write to create one)"
    return renderTodos(list)
  },
}
