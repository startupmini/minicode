// Fase 1 — tool fundamental: read_file paging, grep engine, todo, bash background.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import type { ToolContext } from "#minicore"
import { LIMITS } from "../src/constants.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"
import {
  bashKillTool,
  bashOutputTool,
  bashTool,
  killAllBackgroundJobs,
  listBackgroundJobs,
} from "../src/tools/bash.ts"
import { grepTool, normalizeRgLine } from "../src/tools/grep.ts"
import { formatLines, readFileTool } from "../src/tools/read_file.ts"
import {
  loadTodos,
  normalizeTodos,
  renderTodos,
  saveTodos,
  todoReadTool,
  todoSession,
  todoWriteTool,
} from "../src/tools/todo.ts"

const ctx = { signal: new AbortController().signal, emit() {} } as unknown as ToolContext
const tmp = ".tmp-phase1-test"

afterEach(async () => {
  killAllBackgroundJobs()
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
})

describe("read_file: paging + nomor baris", () => {
  test("formatLines memberi nomor 1-indexed dan sejajar", () => {
    const { text, totalLines } = formatLines("a\nb\nc")
    expect(totalLines).toBe(3)
    expect(text).toBe("1: a\n2: b\n3: c")
  })

  test("trailing newline tidak menghasilkan baris kosong palsu", () => {
    expect(formatLines("a\nb\n").totalLines).toBe(2)
  })

  test("offset/limit memotong rentang dan menunjukkan sisa", () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")
    const { text, from, to } = formatLines(raw, { offset: 4, limit: 3 })
    expect(from).toBe(4)
    expect(to).toBe(6)
    expect(text).toContain("4: line4")
    expect(text).toContain("6: line6")
    expect(text).not.toContain("line7")
    expect(text).toContain("offset=7")
  })

  test("offset melewati akhir file memberi pesan jelas, bukan string kosong", () => {
    expect(formatLines("a\nb", { offset: 99 }).text).toContain("past the end of the file")
  })

  test("offset 0 / negatif dinormalisasi ke 1", () => {
    expect(formatLines("a\nb", { offset: 0 }).from).toBe(1)
    expect(formatLines("a\nb", { offset: -5 }).from).toBe(1)
  })

  test("limit di atas batas di-clamp", () => {
    const raw = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n")
    const r = formatLines(raw, { limit: 999_999 })
    expect(r.to).toBe(20)
  })

  test("baris sangat panjang dipotong per baris", () => {
    const long = "x".repeat(LIMITS.READ_FILE_MAX_LINE_CHARS + 500)
    expect(formatLines(long).text).toContain("[line truncated]")
  })

  test("file besar bisa dibaca per bagian, tanpa offset tetap ditolak", async () => {
    await mkdir(tmp, { recursive: true })
    const p = `${tmp}/big.txt`
    // > READ_FILE_MAX_BYTES
    const line = `${"y".repeat(99)}\n`
    await writeFile(p, line.repeat(Math.ceil(LIMITS.READ_FILE_MAX_BYTES / 100) + 50))

    await expect(readFileTool.execute({ path: p }, ctx)).rejects.toThrow(/too large/)
    const paged = (await readFileTool.execute({ path: p, offset: 10, limit: 3 }, ctx)) as string
    expect(paged.split("\n")[0]).toStartWith("10: ")
    expect(paged.split("\n").filter((l) => /^\s*\d+: /.test(l)).length).toBe(3)
  })

  test("direktori ditolak dengan pesan spesifik", async () => {
    await mkdir(tmp, { recursive: true })
    await expect(readFileTool.execute({ path: tmp }, ctx)).rejects.toThrow(/is a directory/)
  })
})

describe("grep: engine ripgrep + fallback", () => {
  test("normalizeRgLine mengubah path:line:col:text ke format walker", () => {
    expect(normalizeRgLine("src/a.ts:12:5:const x = 1", process.cwd())).toBe(
      "src/a.ts:12: const x = 1",
    )
  })

  test("normalizeRgLine membuang path sensitif (jail defense-in-depth)", () => {
    expect(normalizeRgLine(".env:1:1:SECRET=x", process.cwd())).toBeNull()
    expect(normalizeRgLine("node_modules/x/i.js:1:1:a", process.cwd())).toBeNull()
  })

  test("normalizeRgLine menolak baris tak terparse", () => {
    expect(normalizeRgLine("bukan format rg", process.cwd())).toBeNull()
  })

  test("kedua engine memberi hasil identik pada fixture yang sama", async () => {
    await mkdir(`${tmp}/sub`, { recursive: true })
    await writeFile(`${tmp}/sub/a.ts`, "export function alpha() {}\nconst z = 1\n")
    await writeFile(`${tmp}/sub/b.ts`, "export function beta() {}\n")
    const prev = process.env.MINICODE_GREP_ENGINE
    try {
      process.env.MINICODE_GREP_ENGINE = "js"
      const js = (await grepTool.execute(
        { pattern: "export function", cwd: tmp, limit: 50 },
        ctx,
      )) as string
      process.env.MINICODE_GREP_ENGINE = ""
      const auto = (await grepTool.execute(
        { pattern: "export function", cwd: tmp, limit: 50 },
        ctx,
      )) as string
      const norm = (s: string) => s.split("\n").sort().join("\n")
      expect(norm(auto)).toBe(norm(js))
      expect(js).toContain("sub/a.ts:1:")
    } finally {
      if (prev === undefined) delete process.env.MINICODE_GREP_ENGINE
      else process.env.MINICODE_GREP_ENGINE = prev
    }
  })

  test("regex invalid ditolak sebelum menyentuh engine mana pun", async () => {
    await expect(grepTool.execute({ pattern: "([", cwd: ".", limit: 5 }, ctx)).rejects.toThrow(
      /invalid regex/,
    )
  })

  test("tanpa match memberi pesan, bukan string kosong", async () => {
    await mkdir(tmp, { recursive: true })
    await writeFile(`${tmp}/c.txt`, "nothing here\n")
    const r = (await grepTool.execute(
      { pattern: "zzz_tidak_ada_qqq", cwd: tmp, limit: 5 },
      ctx,
    )) as string
    expect(r).toContain("no matches")
  })
})

describe("todo_write / todo_read", () => {
  test("normalizeTodos memangkas, memberi default status, dan menolak kosong", () => {
    const r = normalizeTodos([
      { content: "  satu  ", status: "completed" },
      { content: "dua" },
      { content: "" },
      { status: "pending" },
    ])
    expect(r).toEqual([
      { content: "satu", status: "completed" },
      { content: "dua", status: "pending" },
    ])
    expect(() => normalizeTodos([])).toThrow(/empty/)
    expect(() => normalizeTodos("bukan array" as never)).toThrow(/array/)
  })

  test("hanya satu in_progress yang dipertahankan", () => {
    const r = normalizeTodos([
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "in_progress" },
    ])
    expect(r.filter((t) => t.status === "in_progress").length).toBe(1)
    expect(r[0]!.status).toBe("in_progress")
  })

  test("status tak dikenal jatuh ke pending", () => {
    expect(normalizeTodos([{ content: "a", status: "wat" }])[0]!.status).toBe("pending")
  })

  test("jumlah item dan panjang content di-cap", () => {
    const many = Array.from({ length: LIMITS.TODO_MAX_ITEMS + 20 }, (_, i) => ({
      content: `t${i}`,
      status: "pending" as const,
    }))
    expect(normalizeTodos(many).length).toBe(LIMITS.TODO_MAX_ITEMS)
    const long = normalizeTodos([{ content: "z".repeat(500), status: "pending" }])
    expect(long[0]!.content.length).toBe(LIMITS.TODO_CONTENT_MAX_CHARS)
  })

  test("renderTodos menampilkan progres dan item aktif", () => {
    const out = renderTodos([
      { content: "selesai", status: "completed" },
      { content: "sedang", status: "in_progress" },
      { content: "nanti", status: "pending" },
    ])
    expect(out).toContain("todos 1/3")
    expect(out).toContain("sekarang: sedang")
    expect(out).toContain("[x] selesai")
    expect(out).toContain("[~] sedang")
    expect(out).toContain("[ ] nanti")
  })

  test("roundtrip tool: write lalu read mengembalikan daftar yang sama", async () => {
    await mkdir(tmp, { recursive: true })
    const prev = { id: todoSession.id, cwd: todoSession.cwd }
    todoSession.id = "sesi-uji"
    todoSession.cwd = tmp
    try {
      const written = (await todoWriteTool.execute(
        { todos: [{ content: "langkah satu", status: "in_progress" }] },
        ctx,
      )) as string
      expect(written).toContain("[~] langkah satu")
      const read = (await todoReadTool.execute({}, ctx)) as string
      expect(read).toContain("langkah satu")
      expect(await loadTodos("sesi-uji", tmp)).toEqual([
        { content: "langkah satu", status: "in_progress" },
      ])
    } finally {
      todoSession.id = prev.id
      todoSession.cwd = prev.cwd
    }
  })

  test("todo_read tanpa data memberi petunjuk, bukan error", async () => {
    const prev = { id: todoSession.id, cwd: todoSession.cwd }
    todoSession.id = "sesi-belum-ada"
    todoSession.cwd = tmp
    try {
      expect((await todoReadTool.execute({}, ctx)) as string).toContain("no todos yet")
    } finally {
      todoSession.id = prev.id
      todoSession.cwd = prev.cwd
    }
  })

  test("file todo korup tidak melempar, dianggap kosong", async () => {
    await mkdir(`${tmp}/.minicode/todos`, { recursive: true })
    await writeFile(`${tmp}/.minicode/todos/rusak.json`, "{bukan json")
    expect(await loadTodos("rusak", tmp)).toEqual([])
  })

  test("saveTodos membuat direktori bila belum ada", async () => {
    await saveTodos("baru", [{ content: "x", status: "pending" }], tmp)
    expect(await loadTodos("baru", tmp)).toHaveLength(1)
  })
})

describe("bash background", () => {
  const isWin = process.platform === "win32"
  const echoCmd = "echo halo-bg"
  const sleepCmd = isWin ? "ping -n 30 127.0.0.1" : "sleep 30"

  // Polling dengan deadline generous: mesin CI bisa lambat menjadwalkan proses
  // anak. Test ini menguji *mekanisme* (output baru vs sudah dibaca), bukan
  // kecepatan spawn — jadi jangan biarkan jitter penjadwalan bikin flaky.
  async function waitUntil(cond: () => boolean, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (cond()) return true
      await Bun.sleep(25)
    }
    return cond()
  }

  const startBg = async (cmd: string): Promise<string> => {
    const r = (await bashTool.execute({ cmd, background: true }, ctx)) as string
    const id = /(bg_[0-9a-f]+)/.exec(r)?.[1]
    if (!id) throw new Error(`job id tidak ada di output: ${r}`)
    return id
  }

  test("background:true mengembalikan job id tanpa menunggu", async () => {
    const r = (await bashTool.execute({ cmd: sleepCmd, background: true }, ctx)) as string
    const id = /(bg_[0-9a-f]+)/.exec(r)?.[1]
    expect(id).toBeTruthy()
    expect(r).toContain("bash_output")
    expect(listBackgroundJobs().some((j) => j.id === id)).toBe(true)
  })

  test("bash_output mengembalikan output baru lalu tidak mengulanginya", async () => {
    const id = await startBg(echoCmd)
    const ok = await waitUntil(() => listBackgroundJobs().find((j) => j.id === id)?.done === true)
    expect(ok).toBe(true)
    const first = (await bashOutputTool.execute({ id }, ctx)) as string
    expect(first).toContain("halo-bg")
    const second = (await bashOutputTool.execute({ id }, ctx)) as string
    expect(second).toContain("no new output yet")
  })

  test("bash_output pada id tak dikenal melempar dengan daftar job", async () => {
    await expect(bashOutputTool.execute({ id: "bg_tidakada" }, ctx)).rejects.toThrow(/not found/)
  })

  test("bash_kill menghentikan job yang berjalan", async () => {
    const id = await startBg(sleepCmd)
    expect((await bashKillTool.execute({ id }, ctx)) as string).toContain("stopped")
  })

  test("background ditolak saat sandbox aktif (janji isolasi tak bisa dipenuhi)", async () => {
    const prev = process.env.MINICODE_SANDBOX
    process.env.MINICODE_SANDBOX = "docker"
    try {
      await expect(bashTool.execute({ cmd: "echo x", background: true }, ctx)).rejects.toThrow(
        /--sandbox/,
      )
    } finally {
      if (prev === undefined) delete process.env.MINICODE_SANDBOX
      else process.env.MINICODE_SANDBOX = prev
    }
  })

  test("jumlah job hidup dibatasi", async () => {
    // pakai command berumur panjang supaya slot benar-benar terisi saat dicek
    for (let i = 0; i < LIMITS.BASH_BACKGROUND_MAX_JOBS; i++) await startBg(sleepCmd)
    await expect(bashTool.execute({ cmd: sleepCmd, background: true }, ctx)).rejects.toThrow(
      /too many background jobs/,
    )
  })

  test("killAllBackgroundJobs mengosongkan registry", async () => {
    await startBg(sleepCmd)
    expect(listBackgroundJobs().length).toBeGreaterThan(0)
    killAllBackgroundJobs()
    expect(listBackgroundJobs().length).toBe(0)
  })

  test("bash foreground memancarkan progres inkremental", async () => {
    const chunks: string[] = []
    const emitCtx = {
      signal: new AbortController().signal,
      emit(e: { kind?: string; data?: unknown }) {
        if (e.kind === "bash-output") chunks.push(String((e.data as { text?: string }).text ?? ""))
      },
    } as unknown as ToolContext
    const p = bashTool.execute({ cmd: echoCmd }, emitCtx)
    // Proses super-cepat (echo) di runner CI berbeban bisa resolve sebelum
    // engine mengirim event 'data' ke listener — esensi yang diuji = emit
    // path bekerja dan membawa isi, BUKAN sinkronitas engine. Tunggu dengan
    // deadline (pola waitUntil yang sama seperti test background di atas);
    // emit path rusak (regresi) tetap gagal lewat deadline, bukan terselamatkan.
    const ok = await waitUntil(() => chunks.join("").includes("halo-bg"))
    await p
    expect(ok).toBe(true)
    expect(chunks.join("")).toContain("halo-bg")
  })
})

describe("permission: tool Fase 1", () => {
  const h = createPermissionHandler({ mode: "auto", root: process.cwd() }) as ReturnType<
    typeof createPermissionHandler
  > & { __setMode(m: "auto" | "plan" | "readonly" | "allowlist"): void }
  const check = (name: string, args: Record<string, unknown> = {}) =>
    h.check({ id: "1", name, args } as never, {} as never)

  test("auto mengizinkan todo_write/todo_read/bash_output/bash_kill", async () => {
    for (const n of ["todo_write", "todo_read", "bash_output", "bash_kill"]) {
      expect(await check(n)).toBe("allow")
    }
  })

  test("plan mengizinkan todo_read dan todo_write (artefak rencana)", async () => {
    h.__setMode("plan")
    expect(await check("todo_read")).toBe("allow")
    expect(await check("todo_write")).toBe("allow")
    expect(await check("delegate_task")).toBe("allow")
    h.__setMode("auto")
  })

  test("readonly menolak semua tool tulis Fase 1", async () => {
    h.__setMode("readonly")
    for (const n of ["todo_write", "bash_output", "bash_kill"]) {
      expect(await check(n)).toBe("deny")
    }
    h.__setMode("auto")
  })
})
