import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"

// Todo list per sesi — state eksplisit untuk task multi-langkah.
// Tanpa ini agent tidak punya tempat menyimpan rencana antar step, sehingga
// pada task panjang ia lupa langkah yang belum dikerjakan.

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "blocked"

export interface TodoItem {
  content: string
  status: TodoStatus
  /** Alasan `blocked` — WAJIB ada kalau status=blocked (INV: blocker harus
   *  bisa dijelaskan). Tidak ada di schema tool: diisi runtime dari bukti. */
  blockedReason?: string
}

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled", "blocked"]

const GLYPH: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
  blocked: "[!]",
}

// ── Completion evidence (INV-003 / INV-009) ──────────────────────────────────
// "Agent bilang selesai" BUKAN bukti. Kebijakan ini bisa disuntik: composition
// root menyuntikkan sumber bukti (di CLI: hasil verify terakhir); tanpa
// injeksi, default `unverified` — completion tetap diizinkan, tapi statusnya
// tercatat sebagai belum diverifikasi, bukan diam-diam dianggap sah.
//
// Fail-closed hanya di arah yang berbahaya: `failed` MENOLAK `completed`.
// Menolak tanpa bukti (default) akan mematikan pemakaian normal yang tidak
// menjalankan verify, jadi itu tidak dilakukan.
export type CompletionVerdict = "unverified" | "passed" | "failed"

export interface CompletionEvidence {
  verdict: CompletionVerdict
  detail?: string
}

const UNVERIFIED: CompletionEvidence = { verdict: "unverified" }
let completionEvidence: () => CompletionEvidence = () => UNVERIFIED

/** Dipanggil composition root (cli/setup.ts). Tanpa ini: `unverified`. */
export function setCompletionEvidence(fn: () => CompletionEvidence): void {
  completionEvidence = fn
}

/** Kembalikan ke default (seam uji / isolasi antar test file). */
export function clearCompletionEvidence(): void {
  completionEvidence = () => UNVERIFIED
}

export function currentCompletionEvidence(): CompletionEvidence {
  try {
    return completionEvidence() ?? UNVERIFIED
  } catch {
    // Sumber bukti yang melempar TIDAK boleh menuntaskan task diam-diam.
    return { verdict: "failed", detail: "completion evidence source failed" }
  }
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

/** Sanitasi + batasi daftar + terapkan kebijakan completion. Diekspor untuk test.
 *
 * `evidence` default = `currentCompletionEvidence()` (sumber yang disuntik
 * composition root). Pemanggil yang sudah punya bukti bisa mengoper nilainya
 * eksplisit supaya deterministik di test.
 */
/**
 * Terapkan kebijakan completion pada daftar yang sudah ternormalisasi.
 *
 * Murni (tanpa I/O) dan dipakai oleh DUA jalur agar aturan "completed butuh
 * bukti" hanya ada di satu tempat:
 *  1. `todo_write` (jalur tulis) - sebelum disimpan;
 *  2. `reconcileCompletionEvidence` (jalur rekonsiliasi) - setelah verify
 *     selesai, karena verify sebuah turn berjalan SETELAH `todo_write`.
 *
 * Mengembalikan array BARU bila ada yang berubah, `null` bila tidak -
 * pemanggil memakai ini untuk memutuskan apakah perlu menulis/menerbitkan
 * event (idempoten: tidak ada event plan palsu saat tidak ada perubahan).
 */
export function applyCompletionPolicy(
  list: readonly TodoItem[],
  evidence: CompletionEvidence,
): TodoItem[] | null {
  if (evidence.verdict !== "failed") return null
  const reason = evidence.detail?.trim().slice(0, 300) || "verification failed"
  if (!list.some((t) => t.status === "completed")) return null
  return list.map((t) =>
    t.status === "completed" ? { ...t, status: "blocked" as const, blockedReason: reason } : t,
  )
}

export function normalizeTodos(input: unknown, evidence?: CompletionEvidence): TodoItem[] {
  if (!Array.isArray(input)) throw new Error("todos must be an array")
  const ev = evidence ?? currentCompletionEvidence()
  const out: TodoItem[] = []
  for (const raw of input.slice(0, LIMITS.TODO_MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as { content?: unknown; status?: unknown; blockedReason?: unknown }
    const content = String(r.content ?? "")
      .trim()
      .slice(0, LIMITS.TODO_CONTENT_MAX_CHARS)
    if (!content) continue
    const status = STATUSES.includes(r.status as TodoStatus) ? (r.status as TodoStatus) : "pending"
    // `blockedReason` HARUS ikut dibaca: tanpanya alasan blocker hilang
    // tepat setelah restart (durable write, non-durable read).
    const reason = typeof r.blockedReason === "string" ? r.blockedReason.trim().slice(0, 300) : ""
    out.push(reason ? { content, status, blockedReason: reason } : { content, status })
  }
  if (out.length === 0) throw new Error("todos is empty — provide at least one item with content")
  // `blocked` tanpa alasan adalah state tak terjelaskan (PF-04). Selain
  // `blocked` dikeluarkan dari enum model, ada pagar kedua di sini: file yang
  // ditulis tangan atau jalur argumen lain tidak boleh menciptakan blocker
  // yang tak bisa dijelaskan. Tanpa alasan -> turun ke `pending`.
  for (const t of out) {
    if (t.status !== "blocked" || t.blockedReason) continue
    t.status = "pending"
  }
  // Bukti merah MENOLAK `completed`: task turun ke `blocked` beserta alasannya.
  // Ini yang menutup INV-003 - sebelumnya model bisa menandai "selesai" sambil
  // verify merah dan tak ada satu pun jalur kode yang mencegahnya.
  const gated = applyCompletionPolicy(out, ev)
  const final = gated ?? out
  // Satu in_progress saja: kalau model menandai beberapa, sisanya turun ke
  // pending supaya daftar tetap punya satu fokus yang jelas.
  let seenActive = false
  for (const t of final) {
    if (t.status !== "in_progress") continue
    if (seenActive) t.status = "pending"
    seenActive = true
  }
  return final
}

export function renderTodos(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === "completed").length
  const blocked = todos.filter((t) => t.status === "blocked").length
  const active = todos.find((t) => t.status === "in_progress")
  const head =
    `todos ${done}/${todos.length}` +
    (blocked > 0 ? ` · ${blocked} blocked` : "") +
    (active ? ` · sekarang: ${active.content}` : "")
  const body = todos
    .map(
      (t) => `  ${GLYPH[t.status]} ${t.content}${t.blockedReason ? ` — ${t.blockedReason}` : ""}`,
    )
    .join("\n")
  return `${head}\n${body}`
}

/**
 * Baca daftar todo dari disk. **PASIF**: tidak menerapkan kebijakan
 * completion apa pun.
 *
 * Dulu jalur baca ini melewati `normalizeTodos` tanpa argumen bukti, sehingga
 * ia memakai `currentCompletionEvidence()` - akibatnya `todo_read` melaporkan
 * `blocked` sementara file tetap `completed`. Durable dan observed berbeda, dan
 * tak ada yang menyelaraskan. Sekarang bentuk di disk adalah satu-satunya
 * kebenaran; kebijakan hanya berlaku di jalur tulis (`todo_write`) dan di
 * rekonsiliasi eksplisit (`reconcileCompletionEvidence`) yang menulis balik.
 */
export async function loadTodos(sessionId: string, cwd = process.cwd()): Promise<TodoItem[]> {
  try {
    const raw = await readFile(todoPath(sessionId, cwd), "utf8")
    const parsed = JSON.parse(raw) as { todos?: unknown }
    if (!Array.isArray(parsed.todos)) return []
    // Bentuk tersimpan sudah ternormalisasi saat ditulis. Normalisasi di sini
    // hanya untuk mem-namedai file yang ditulis tangan, dengan bukti
    // `unverified` supaya TIDAK ada kebijakan yang diam-diam berlaku saat baca.
    return normalizeTodos(parsed.todos, UNVERIFIED)
  } catch {
    return []
  }
}

/**
 * Rekonsiliasi completion SETELAH verify selesai.
 *
 * Menutup gap PF-01: `todo_write` berjalan sebelum verify sebuah turn, jadi
 * klaim `completed` bisa sudah tersimpan ketika verify turn itu berubah merah.
 * Fungsi ini menutup celah itu dari arah yang sama seperti gerbang tulis:
 * penurunan `completed` menjadi `blocked` + alasan, ditulis balik ke disk, dan
 * pemanggil menerbitkan `plan.updated` baru.
 *
 * Idempoten dan pasif-bila-tak-perlu: mengembalikan `null` bila tidak ada
 * perubahan, supaya tidak terbit event plan yang tidak mencerminkan kenyataan.
 */
export async function reconcileCompletionEvidence(
  sessionId: string,
  cwd: string,
  evidence: CompletionEvidence,
): Promise<TodoItem[] | null> {
  if (evidence.verdict !== "failed") return null
  try {
    const current = await loadTodos(sessionId, cwd)
    const next = applyCompletionPolicy(current, evidence)
    if (!next) return null
    await saveTodos(sessionId, next, cwd)
    await savePlanSnapshot(sessionId, next, cwd).catch(() => {})
    return next
  } catch (e) {
    // Best-effort: kegagalan rekonsiliasi TIDAK boleh menggagalkan turn yang
    // sudah selesai. Diagnostik ditulis di modul pemilik kegagalan, bukan di
    // pemanggil — menambah `process.stderr.write` di `cli/setup.ts` menaikkan
    // writer ke-27 dan melanggar pagu invaris OAP-008 (test/writer-inventory).
    process.stderr.write(`[warn] completion reconcile failed: ${(e as Error).message}\n`)
    return null
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
  const blocked = todos.filter((t) => t.status === "blocked").length
  const lines = [
    `# Plan — ${sessionId}`,
    ``,
    `Progress: ${done}/${todos.length} completed.${blocked ? ` · ${blocked} blocked.` : ""}`,
    ``,
    ...todos.map((t) => {
      const box =
        t.status === "completed"
          ? "x"
          : t.status === "in_progress"
            ? "~"
            : t.status === "cancelled"
              ? "-"
              : t.status === "blocked"
                ? "!"
                : " "
      // Alasan blocker WAJIB ikut: tanpa ini artefak ini tidak bisa
      // menjelaskan kenapa sebuah task tidak bisa diselesaikan.
      const why = t.blockedReason ? ` — ${t.blockedReason}` : ""
      return `- [${box}] ${t.content} (${t.status})${why}`
    }),
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
    "Write/replace the todo list for this task. Send the ENTIRE list every time (not a delta). Use for tasks with 3+ steps: keep exactly one item in_progress at a time, mark it completed as soon as it is done. Marking an item completed while verification is failing is REFUSED — it comes back as blocked with the reason, so fix the failing check first.",
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
            // `blocked` SENGAJA tidak ada di enum model: itu status yang
            // ditegakkan runtime (verifikasi merah) dan selalu membawa alasan.
            // Jika model boleh memilihnya, `blocked` berubah menjadi generic
            // non-completed state - tercampur "verify merah" dengan "agen
            // menyerah" (PF-04).
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
    const evidence = currentCompletionEvidence()
    const list = normalizeTodos(todos, evidence)
    // cwd sesi dari ToolContext dulu (skenario --cwd / sub-agen), lalu global
    // yang di-set composition root (cli/setup.ts, MCP serve), terakhir cwd
    // proses. Urutan lama (global-dulu) buta terhadap ctx.
    const cwd = (ctx as { cwd?: string }).cwd ?? todoSession.cwd ?? process.cwd()
    await saveTodos(todoSession.id, list, cwd)
    // Plan artifact ditulis tiap save — murah (atomik, kecil) dan membuat
    // resume lintas sesi tidak butuh memutar ulang seluruh percakapan.
    await savePlanSnapshot(todoSession.id, list, cwd).catch(() => {})
    // Penolakan completion harus TERLIHAT oleh model, bukan hanya tersimpan di
    // file: tanpa baris ini model mengira item-nya completed lalu mencoba
    // lanjut — persis pola "false completion" yang INV-003 larang.
    const refused = list.filter((t) => t.status === "blocked" && t.blockedReason)
    const notice =
      refused.length > 0
        ? `refused ${refused.length} completion claim(s): verification is failing, so they are blocked instead of completed. Fix the failing check first.\n`
        : ""
    return notice + renderTodos(list)
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
