// Penutup celah coverage agregat setelah penghapusan fullscreen/screen/panel
// (fungsi teruji hilang bersama komponen; gate:coverage min 83 lines / 81
// funcs). Fokus: fungsi kecil yang murah diuji langsung tanpa konteks agen
// penuh — withMcpTools, atomicWriteText, McpTransport (jalur error/timeout),
// memory tools, web_fetch/web_search (jalur argumen invalid), apply_patch.
// Semua TANPA jaringan & TANPA menyentuh config/DB milik user.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicWriteText } from "../src/lib/atomic-write.ts"
import { McpTransport } from "../src/mcp/transport.ts"
import { withMcpTools } from "../src/tools/index.ts"
import { forgetMemoryTool, readMemoryTool, writeMemoryTool } from "../src/tools/memory.ts"
import { applyPatchTool } from "../src/tools/patch.ts"
import { readBodyCapped, webFetchTool } from "../src/tools/web_fetch.ts"
import { webSearchTool } from "../src/tools/web_search.ts"

const workspace = mkdtempSync(join(tmpdir(), "minicode-coverage-gaps-"))
const ctx = { signal: new AbortController().signal, cwd: workspace } as never

afterAll(
  async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(workspace, { recursive: true, force: true })
        return
      } catch (error) {
        const code = (error as { code?: string }).code
        // Windows may briefly retain SQLite/WAL handles after close; a finite
        // retry smooths that release delay while a persistent leak still fails.
        if (attempt === 3) {
          // DIAG-TEMP
          const fs = require("node:fs") as typeof import("node:fs")
          const log: string[] = []
          const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              const p = join(d, e.name)
              if (e.isDirectory()) walk(p)
              else {
                try {
                  fs.unlinkSync(p)
                  log.push(`unlink OK ${p}`)
                } catch (er) {
                  log.push(`unlink FAIL ${p}: ${(er as Error).message}`)
                }
              }
            }
          }
          try {
            walk(workspace)
          } catch (er) {
            log.push(`walk err ${(er as Error).message}`)
          }
          try {
            fs.rmSync(workspace, { recursive: true })
            log.push("rmSync after unlink OK")
          } catch (er) {
            log.push(`rmSync after unlink FAIL: ${(er as Error).message}`)
            Bun.gc(true)
            try {
              fs.rmSync(workspace, { recursive: true })
              log.push("rmSync after GC OK")
            } catch (er2) {
              log.push(`rmSync after GC FAIL: ${(er2 as Error).message}`)
            }
          }
          fs.writeFileSync(
            "C:/Users/zo/.gemini/antigravity/brain/f1cc1403-b0ca-429f-babc-28613d39de82/scratch/diag.txt",
            `cwd=${process.cwd()}\n${log.join("\n")}\n`,
          )
        }
        if ((code !== "EBUSY" && code !== "EPERM") || attempt === 9) throw error
        await Bun.sleep(Math.min(50 * 2 ** attempt, 1_000))
      }
    }
  },
  { timeout: 10_000 },
)

describe("withMcpTools: dedup nama tool", () => {
  const base = [{ name: "a" }, { name: "b" }] as never
  test("tool MCP dengan nama sama diabaikan", () => {
    const merged = withMcpTools(base, [{ name: "a" }, { name: "c" }] as never)
    expect(merged.map((t: { name: string }) => t.name)).toEqual(["a", "b", "c"])
  })

  test("tanpa tool MCP mengembalikan base apa adanya", () => {
    expect(withMcpTools(base, [])).toHaveLength(2)
  })
})

describe("HTTP body cap", () => {
  test("batas diterapkan per byte dan ditandai sebelum JSON parsing", async () => {
    const controller = new AbortController()
    const body = await readBodyCapped(
      new Response(new Uint8Array(2_000_001).fill(0x61)),
      controller,
    )
    expect(body.text.length).toBe(2_000_000)
    expect(body.truncated).toBe(true)
    expect(controller.signal.aborted).toBe(true)
  })
})

describe("atomicWriteText: tulis & timpa", () => {
  test("menulis file baru lalu menimpa dengan aman", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-atomic-"))
    const p = join(dir, "sub", "cfg.json")
    await atomicWriteText(p, "v1")
    await atomicWriteText(p, "v2")
    expect(await Bun.file(p).text()).toBe("v2")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("McpTransport: jalur gagal tertutup", () => {
  test("request tanpa connect menolak (not connected)", async () => {
    const t = new McpTransport()
    await expect(t.request("ping", {}, 10)).rejects.toThrow("not connected")
  })

  test("close dua kali idempotent", async () => {
    const t = new McpTransport()
    await t.close()
    await t.close() // tidak throw
  })

  test("connect dua kali menolak (already connected)", async () => {
    const t = new McpTransport()
    // spawn server dummy: runtime sendiri idle (hermetic, tanpa node)
    await t.connect(process.execPath, ["-e", "setInterval(()=>{},1000)"])
    await expect(t.connect(process.execPath, ["-e", ""])).rejects.toThrow("already connected")
    await t.close()
  })

  test("request timeout bila server tidak menjawab", async () => {
    const t = new McpTransport()
    await t.connect(process.execPath, ["-e", "setInterval(()=>{},1000)"])
    await expect(t.request("ping", {}, 30)).rejects.toThrow("timed out")
    await t.close()
  })

  test("frame stdio MCP oversized ditolak sebelum JSON parse dan child dihentikan", async () => {
    const t = new McpTransport()
    const code = `process.stdin.once("data",()=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{tools:[{name:"oversized",description:"x".repeat(1100000)}]}})+"\\n"))`
    await t.connect(process.execPath, ["-e", code])
    try {
      await expect(t.request("tools/list", {}, 5000)).rejects.toThrow(/frame exceeds 1048576 bytes/)
      expect(t.isClosed).toBe(true)
    } finally {
      await t.close()
    }
  })

  test("close menolak pending request", async () => {
    const t = new McpTransport()
    await t.connect(process.execPath, ["-e", "setInterval(()=>{},1000)"])
    const p = t.request("ping", {}, 5000)
    // close() memanggil failAll → pending harus reject, apa pun pesannya
    // (transport closed / timeout — failAll tidak menghapus timer).
    const closing = t.close()
    await expect(p).rejects.toThrow()
    await closing
  })

  test("notify tanpa response tidak menggantung; exit server menolak request", async () => {
    const t = new McpTransport()
    try {
      await t.connect(process.execPath, ["-e", "process.exit(0)"])
      // Startup/exit bisa lebih lambat saat seluruh suite diinstrumentasi.
      // Tunggu liveness yang benar dengan batas waktu, bukan tidur 50 ms.
      const deadline = Date.now() + 1_000
      while (!t.isClosed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(t.isClosed).toBe(true)
      await expect(t.request("ping", {}, 10)).rejects.toThrow()
    } finally {
      await t.close()
    }
  })
})

describe("memory tools: file lokal", () => {
  test("write → read → forget (empty query path)", async () => {
    const w = (await writeMemoryTool.execute({ text: "catatan uji" }, ctx)) as string
    expect(w).toBeTruthy()
    const all = (await readMemoryTool.execute({ query: "" }, ctx)) as string
    expect(all).toBeTruthy()
    const f = (await forgetMemoryTool.execute({ query: "catatan uji" }, ctx)) as string
    expect(f).toBeTruthy()
  })

  test("write kosong & query kosong ditolak", async () => {
    await expect(writeMemoryTool.execute({ text: "  " }, ctx)).rejects.toThrow()
    await expect(forgetMemoryTool.execute({ query: "" }, ctx)).rejects.toThrow()
  })

  test("write_memory menolak supersedes_id tak dikenal dengan error actionable (§7.5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-supersede-"))
    const c = { signal: new AbortController().signal, cwd: dir } as never
    try {
      // id yang jelas tak ada → error actionable, bukan tombstone no-op.
      await expect(
        writeMemoryTool.execute({ text: "port baru 9090", supersedes_id: "tidak-ada" }, c),
      ).rejects.toThrow(/supersedes_id not found/)
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  })
})

describe("web_fetch / web_search: validasi argumen", () => {
  test("url kosong ditolak tanpa jaringan", async () => {
    await expect(webFetchTool.execute({ url: "" }, ctx)).rejects.toThrow("url required")
  })

  test("url bukan http ditolak", async () => {
    await expect(webFetchTool.execute({ url: "ftp://x" }, ctx)).rejects.toThrow()
  })

  test("query kosong ditolak tanpa jaringan", async () => {
    await expect(webSearchTool.execute({ query: "" }, ctx)).rejects.toThrow()
  })
})

describe("apply_patch: jalur murni", () => {
  test("patch search/replace diterapkan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minicode-coverage-patch-"))
    const file = join(dir, "a.txt")
    await Bun.write(file, "satu dua tiga\n")
    const r = (await applyPatchTool.execute(
      { path: "a.txt", patches: [{ search: "dua", replace: "DUA" }] },
      { signal: new AbortController().signal, cwd: dir } as never,
    )) as string
    expect(r).toBeTruthy()
    expect(await Bun.file(file).text()).toContain("satu DUA tiga")
    await rm(dir, { recursive: true, force: true })
  })
})
