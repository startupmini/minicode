// F-04 (P5 §C3) — Kontrak semantik dispatch bersama kernel vs MCP-server.
//
// Mengunci empat kewajiban kontrak bersama di KEDUA jalur produksi: (1) nol
// eksekusi sebelum otorisasi + validasi, (2) intent mutasi durabel sebelum
// execute (MCP inline journal; kernel wrapper P2.10 diuji suite verification),
// (3) kegagalan tool = observasi isError (rethrow MCP terkonversi reply
// [error] di handler dispatch), (4) jail + bash-guard aktif di semua mode
// termasuk allow-all. Perbedaan protocol (urutan validate/permission, bentuk
// pesan deny) bersifat disengaja sesuai §C3 dan TIDAK dinormalisasi di sini.
//
// Sisi kernel memakai runCall produksi (vendor executor) + permission handler
// produksi; sisi MCP memakai server sungguhan (spawn `cli/index.ts mcp serve`
// stdio), sama seperti mcp-server.test.ts. Tool canary HANYA mencatat
// apakah execute tercapai — gerbang keputusan (permission/validate/guard)
// tetap produksi.
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Tool } from "#minicore"
import { createPermissionHandler } from "../src/policy/permission.ts"
import { writeFileTool } from "../src/tools/write_file.ts"
import { runCall } from "../vendor/minicore/src/core/executor.ts"
import type { PermissionHandler } from "../vendor/minicore/src/core/permission.ts"
import type { ToolCall } from "../vendor/minicore/src/core/types.ts"

// ── harness kernel (pola deny-reason.test.ts) ──

const bus = () => ({ emit() {} })
let kseq = 0
const kcall = (name: string, args: unknown): ToolCall => ({
  id: `f04-k-${++kseq}`,
  name,
  args,
})
function kdeps(registry: Map<string, Tool>, permissions: PermissionHandler) {
  return {
    registry,
    permissions,
    events: bus(),
    signal: new AbortController().signal,
    state: { history: [], turnCount: 0, stepCount: 0 },
    maxResultTokens: 4000,
  } as never
}
const allowAll = (root: string) => createPermissionHandler({ mode: "allow-all", root })
const autoMode = (root: string) => createPermissionHandler({ mode: "auto", root })

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-f04-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

// ── harness MCP e2e (pola mcp-server.test.ts) ──

interface RpcClient {
  send(obj: unknown): void
  next(timeoutMs?: number): Promise<Record<string, unknown>>
  kill(): void
  stderrText(): string
}

function testServerBin(): string {
  return existsSync(process.execPath) ? process.execPath : "bun"
}

async function startServer(args: string[] = []): Promise<RpcClient> {
  const bunBin = testServerBin()
  const proc = Bun.spawn([bunBin, "cli/index.ts", "mcp", "serve", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  let errBuf = ""
  ;(async () => {
    const reader = proc.stderr.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) break
      errBuf += dec.decode(value, { stream: true })
    }
  })()
  const t0 = Date.now()
  for (;;) {
    if (errBuf.includes("[mcp-server] ready")) break
    if (Date.now() - t0 > 20000) throw new Error(`server tak ready: ${errBuf.slice(0, 500)}`)
    await Bun.sleep(50)
  }
  const dec = new TextDecoder()
  let pending = ""
  const queue: Record<string, unknown>[] = []
  const waiters: ((m: Record<string, unknown>) => void)[] = []
  ;(async () => {
    const reader = proc.stdout.getReader()
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (r.done || !r.value) break
      pending += dec.decode(r.value, { stream: true })
      let idx = pending.indexOf("\n")
      while (idx >= 0) {
        const line = pending.slice(0, idx).trim()
        pending = pending.slice(idx + 1)
        if (line) {
          const msg = JSON.parse(line) as Record<string, unknown>
          const w = waiters.shift()
          if (w) w(msg)
          else queue.push(msg)
        }
        idx = pending.indexOf("\n")
      }
    }
  })()
  return {
    send(obj: unknown) {
      proc.stdin.write(`${JSON.stringify(obj)}\n`)
    },
    next(timeoutMs = 15000): Promise<Record<string, unknown>> {
      const hit = queue.shift()
      if (hit) return Promise.resolve(hit)
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("timeout menunggu respons MCP")), timeoutMs)
        waiters.push((m) => {
          clearTimeout(t)
          res(m)
        })
      })
    },
    kill() {
      try {
        proc.kill("SIGTERM")
      } catch {}
      setTimeout(() => {
        try {
          proc.kill("SIGKILL")
        } catch {}
      }, 2000).unref?.()
    },
    stderrText: () => errBuf,
  }
}

async function call(
  c: RpcClient,
  id: string | number,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  c.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } })
  return c.next()
}

function resultText(msg: Record<string, unknown>): string {
  const r = msg.result as { content?: { text?: string }[]; isError?: boolean }
  return r.content?.map((c) => c.text ?? "").join("\n") ?? ""
}

function resultIsError(msg: Record<string, unknown>): boolean {
  return (msg.result as { isError?: boolean } | undefined)?.isError === true
}

// ── A: penolakan izin → tool tak dieksekusi, tanpa efek samping ──

test("F-04A: kernel — jail deny (.env sensitif) nol eksekusi, file nihil", async () => {
  const dir = tmpRoot()
  try {
    const r = await runCall(
      kcall("write_file", { path: ".env", content: "x" }),
      kdeps(new Map([["write_file", writeFileTool]]), autoMode(dir)),
    )
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain("permission denied")
    expect(existsSync(join(dir, ".env"))).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F-04A: MCP — jail deny (.env sensitif) nol eksekusi, file nihil", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    const out = await call(c, 51, "write_file", { path: ".env", content: "x" })
    expect(resultIsError(out)).toBe(true)
    expect(resultText(out)).toMatch(/denied|jail/i)
    expect(existsSync(join(dir, ".env"))).toBe(false)
  } finally {
    c.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── B: argumen invalid → tool tak dieksekusi ──

test("F-04B: kernel — validate gagal setelah otorisasi, canary tak tersentuh", async () => {
  const dir = tmpRoot()
  let executed = 0
  const canary: Tool = {
    name: "canary_b",
    description: "canary",
    parameters: { type: "object", properties: { s: { type: "string" } }, required: ["s"] },
    async execute() {
      executed++
      return "ok"
    },
  }
  try {
    // Izin diberikan gerbang; yang diuji = gerbang validasi kernel.
    const perms: PermissionHandler = { check: async () => "allow" }
    const r = await runCall(
      kcall("canary_b", { s: 42 }),
      kdeps(new Map([["canary_b", canary]]), perms),
    )
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain("invalid arguments")
    expect(executed).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F-04B: MCP — argumen invalid [invalid arguments], file nihil", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    const out = await call(c, 52, "write_file", { content: "tanpa-path" })
    expect(resultIsError(out)).toBe(true)
    expect(resultText(out)).toContain("[invalid arguments]")
    expect(existsSync(join(dir, "tanpa-path"))).toBe(false)
  } finally {
    c.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── C: allow-all TIDAK menonaktifkan jail / bash-guard ──

test("F-04C: kernel — allow-all + rm -rf tetap kena bash-guard, canary tak jalan", async () => {
  const dir = tmpRoot()
  let executed = 0
  // Canary bernama "bash": guard membaca nama+args pemanggil; effector asli
  // (rm -rf /) TIDAK dipakai supaya kegagalan guard tak merusak mesin.
  const canaryBash: Tool = {
    name: "bash",
    description: "canary bash",
    parameters: {
      type: "object",
      properties: { cmd: { type: "string" } },
      required: ["cmd"],
    },
    async execute() {
      executed++
      return "ok"
    },
  }
  try {
    const r = await runCall(
      kcall("bash", { cmd: "rm -rf /" }),
      kdeps(new Map([["bash", canaryBash]]), allowAll(dir)),
    )
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain("bash-guard")
    expect(executed).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F-04C: MCP --allow-all — rm -rf / ditolak guard, canary dir tetap utuh", async () => {
  const dir = tmpRoot()
  const canaryDir = join(dir, "canary-f04")
  mkdirSync(canaryDir, { recursive: true })
  writeFileSync(join(canaryDir, "f.txt"), "x", "utf8")
  const c = await startServer(["--cwd", dir, "--allow-all"])
  try {
    // Target `/` = kelas RM_DANGEROUS_TARGET yang DIBLOKIR guard (rm -rf dir
    // biasa sengaja diizinkan, lihat bash-guard.ts). Bila guard BOCOR dan
    // perintah dieksekusi: GNU/BSD rm menolak `/` telanjang tanpa
    // --no-preserve-root dan Windows cmd.exe tak punya `rm` — canary dir
    // tetap utuh, tapi isError menjadi false sehingga test tetap gagal.
    // Teks deny MCP = string generik scrubbed (beda protocol diratifikasi
    // §C3: tanpa TTY/approval UI) — spesifikasinya `bash-guard:` diuji di
    // jalur kernel (describeDenial, lihat F-04C kernel + deny-reason.test.ts).
    const out = await call(c, 53, "bash", { cmd: "rm -rf /" })
    expect(resultIsError(out)).toBe(true)
    expect(resultText(out)).toContain("[denied]")
    expect(existsSync(canaryDir)).toBe(true)
  } finally {
    c.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── D: kegagalan tool = observasi isError (bukan rejection mentah) ──

test("F-04D: kernel — throw tool berubah menjadi isError result", async () => {
  const dir = tmpRoot()
  const boom: Tool = {
    name: "boom",
    description: "selalu melempar",
    parameters: { type: "object", properties: {} },
    async execute() {
      throw new Error("ledakan-f04")
    },
  }
  try {
    const perms: PermissionHandler = { check: async () => "allow" }
    const r = await runCall(kcall("boom", {}), kdeps(new Map([["boom", boom]]), perms))
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain("ledakan-f04")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F-04D: MCP — throw tool (bash_output id tak dikenal) = reply [error] isError", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    const out = await call(c, 54, "bash_output", { id: "bg_00000000" })
    expect(resultIsError(out)).toBe(true)
    expect(resultText(out)).toContain("[error]")
    expect(resultText(out)).toContain("not found")
  } finally {
    c.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── E: intent mutasi durabel SEBELUM execute (fail-closed di boundary MCP) ──

test("F-04E: MCP — jurnal rusak → intent tak durabel → execute DITOLAK, file nihil", async () => {
  const dir = tmpRoot()
  // Blokir jalur jurnal sesi MCP sebagai direktori: append intent gagal →
  // isJournalHealthy=false → persistEffectIntent durable:false → invokeTool
  // menolak execute SEBELUM tool menyentuh apa pun (fail-closed C3#2).
  mkdirSync(join(dir, ".minicode", "journal-mcp-server.jsonl"), { recursive: true })
  const c = await startServer(["--cwd", dir])
  try {
    const out = await call(c, 55, "write_file", { path: "tak-boleh.txt", content: "x" })
    expect(resultIsError(out)).toBe(true)
    expect(resultText(out)).toContain("evidence incomplete")
    expect(existsSync(join(dir, "tak-boleh.txt"))).toBe(false)
  } finally {
    c.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F-04E: MCP — mutasi sukses meninggalkan intent+terminal di jurnal ON-DISK", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    const out = await call(c, 56, "write_file", { path: "berkas-f04.txt", content: "isi" })
    expect(resultIsError(out)).toBe(false)
    expect(readFileSync(join(dir, "berkas-f04.txt"), "utf8")).toBe("isi")
    // Durability = baca jurnal dari DISK (bukan memori): intent pending +
    // terminal committed untuk write_file wajib ada.
    const raw = readFileSync(join(dir, ".minicode", "journal-mcp-server.jsonl"), "utf8")
    const recs = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { tool?: string; state?: string })
    expect(recs.some((r) => r.tool === "write_file" && r.state === "pending")).toBe(true)
    expect(recs.some((r) => r.tool === "write_file" && r.state === "committed")).toBe(true)
  } finally {
    c.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
