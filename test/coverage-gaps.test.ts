// Penutup celah coverage agregat setelah penghapusan fullscreen/screen/panel
// (fungsi teruji hilang bersama komponen; gate:coverage min 83 lines / 81
// funcs). Fokus: fungsi kecil yang murah diuji langsung tanpa konteks agen
// penuh — withMcpTools, atomicWriteText, McpTransport (jalur error/timeout),
// memory tools, web_fetch/web_search (jalur argumen invalid), apply_patch.
// Semua TANPA jaringan & TANPA menyentuh config/DB milik user.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicWriteText } from "../src/lib/atomic-write.ts"
import { McpTransport } from "../src/mcp/transport.ts"
import { withMcpTools } from "../src/tools/index.ts"
import { forgetMemoryTool, readMemoryTool, writeMemoryTool } from "../src/tools/memory.ts"
import { applyPatchTool } from "../src/tools/patch.ts"
import { webFetchTool } from "../src/tools/web_fetch.ts"
import { webSearchTool } from "../src/tools/web_search.ts"

const ctx = { signal: new AbortController().signal } as never

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
    await t.connect(process.execPath, ["-e", "process.exit(0)"])
    await new Promise((r) => setTimeout(r, 50))
    await expect(t.request("ping", {}, 10)).rejects.toThrow()
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
    // Jail mengunci path ke workspace — pakai dir relatif di dalam repo.
    const dir = ".tmp-coverage-gaps"
    await Bun.write(`${dir}/a.txt`, "satu dua tiga\n")
    const r = (await applyPatchTool.execute(
      { path: `${dir}/a.txt`, patches: [{ search: "dua", replace: "DUA" }] },
      ctx,
    )) as string
    expect(r).toBeTruthy()
    expect(await Bun.file(`${dir}/a.txt`).text()).toContain("satu DUA tiga")
    await rm(dir, { recursive: true, force: true })
  })
})
