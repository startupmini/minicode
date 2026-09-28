// AUDIT #05 — MCP server mode: e2e lewat child process sungguhan.
// Server dijalankan sebagai `bun cli/index.ts mcp serve --cwd <tmp>` dengan
// stdio pipe; test berbicara JSON-RPC. Hermetic: tmp cwd per test.

import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { selectTools } from "../src/mcp/server.ts"

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "mc-mcpsrv-"))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

interface RpcClient {
  send(obj: unknown): void
  sendRaw(line: string): void
  next(timeoutMs?: number): Promise<Record<string, unknown>>
  kill(): void
  stderrText(): string
  exited(): Promise<number | null>
}

/** Runtime bun untuk men-spawn server: fallback PATH bila execPath tak ada
 * sebagai file (layout setup-bun di CI). */
function testServerBin(): string {
  return existsSync(process.execPath) ? process.execPath : "bun"
}

/** Perintah tidur ~20 dtk yang LOLOS bash-guard di semua OS: `X -e/-c`
 * interpreter inline DITOLAK guard (termasuk `bun -e`), jadi sleep harus
 * perintah biasa — `ping -n` di cmd Windows, `sleep` di shell POSIX. */
function testSleepCmd(): string {
  return process.platform === "win32" ? "ping -n 20 127.0.0.1 >NUL" : "sleep 20"
}

async function startServer(args: string[] = []): Promise<RpcClient> {
  // process.execPath tak selalu ada sebagai file (mis. layout setup-bun di
  // CI) — fallback ke `bun` di PATH. cwd JANGAN hardcode path mesin dev;
  // repo root = parent direktori file test ini.
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
  // Tunggu ready di stderr (bukan sleep-buta).
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
    sendRaw(line: string) {
      proc.stdin.write(`${line}\n`)
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
    exited: async () => {
      proc.stdin.end()
      return proc.exited
    },
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

// ── 1. Surface ──

test("mcp-server: selectTools kurasi vs all", () => {
  const curated = selectTools({}).map((t) => t.name)
  expect(curated).not.toContain("delegate_task")
  expect(curated).not.toContain("mcp_call")
  expect(curated).not.toContain("mcp_list")
  expect(curated).not.toContain("write_memory")
  expect(curated).toContain("write_file")
  expect(curated).toContain("bash")
  expect(curated).toContain("read_file")
  const all = selectTools({ allTools: true }).map((t) => t.name)
  expect(all).toContain("delegate_task")
  expect(all).toContain("mcp_call")
  expect(new Set(all).size).toBe(all.length)
})

test("mcp-server: tools/list + initialize + ping", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const init = await c.next()
    expect((init.result as { protocolVersion: string }).protocolVersion).toBe("2026-07-28")
    c.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    const list = (await c.next()).result as { tools: { name: string }[] }
    const names = list.tools.map((t) => t.name)
    expect(names).toContain("write_file")
    expect(names).not.toContain("delegate_task")
    c.send({ jsonrpc: "2.0", id: 3, method: "ping", params: {} })
    expect(await c.next()).toMatchObject({ id: 3 })
  } finally {
    c.kill()
    await cleanup(dir)
  }
})

test("mcp-server: unknown method/parse-error/initialized-ber-id", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    c.send({ jsonrpc: "2.0", id: 11, method: "nope/metode", params: {} })
    const unk = await c.next()
    expect((unk.error as { code: number }).code).toBe(-32601)
    // Baris mentah BUKAN JSON (tanpa stringify!) → parse error id:null.
    c.sendRaw("ini bukan json {{{")
    const perr = await c.next()
    expect(perr.id).toBeNull()
    expect((perr.error as { code: number }).code).toBe(-32700)
    // initialized BER-id wajib dibalas (jangan gantung).
    c.send({ jsonrpc: "2.0", id: 12, method: "initialized", params: {} })
    expect(await c.next()).toMatchObject({ id: 12 })
    c.send({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "tak_ada", arguments: {} },
    })
    const ut = await c.next()
    expect((ut.error as { code: number }).code).toBe(-32602)
  } finally {
    c.kill()
    await cleanup(dir)
  }
})

// ── 2. Jail/exec alignment (P0) + validate (P0) ──

test("mcp-server: jail berlaku; --cwd dipakai eksekusi (bukan process.cwd)", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    // Di luar root → tolak.
    const out = await call(c, 21, "read_file", { path: "/etc/passwd" })
    expect((out.result as { isError: boolean }).isError).toBe(true)
    expect(resultText(out)).toMatch(/denied|outside/i)
    // Tulis relatif mendarat di --cwd (bukan cwd proses server).
    const w = await call(c, 22, "write_file", { path: "dalam.txt", content: "A" })
    expect((w.result as { isError: boolean }).isError ?? false).toBe(false)
    expect(readFileSync(join(dir, "dalam.txt"), "utf8")).toBe("A")
    // Absolut di dalam root → boleh.
    const r = await call(c, 23, "read_file", { path: join(dir, "dalam.txt") })
    expect(resultText(r)).toContain("A")
  } finally {
    c.kill()
    await cleanup(dir)
  }
})

test("mcp-server: argumen invalid ditolak sebelum eksekusi", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    const w = await call(c, 31, "write_file", { path: "a.txt" })
    expect((w.result as { isError: boolean }).isError).toBe(true)
    expect(resultText(w)).toContain("[invalid arguments]")
    expect(existsSync(join(dir, "a.txt"))).toBe(false)
  } finally {
    c.kill()
    await cleanup(dir)
  }
})

test("mcp-server: allowAll tetap tolak sensitif + owned-state", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir, "--allow-all"])
  try {
    const e = await call(c, 41, "write_file", { path: ".env", content: "x" })
    expect((e.result as { isError: boolean }).isError).toBe(true)
    const o = await call(c, 42, "write_file", { path: ".minicode/sessions.db", content: "x" })
    expect((o.result as { isError: boolean }).isError).toBe(true)
    const ok = await call(c, 43, "write_file", { path: "biasa.txt", content: "ok" })
    expect((ok.result as { isError: boolean }).isError ?? false).toBe(false)
  } finally {
    c.kill()
    await cleanup(dir)
  }
})

// ── 3. Idempotency (P0) ──

test("mcp-server: duplikat konkuren = satu eksekusi", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    c.send({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: { name: "write_file", arguments: { path: "d.txt", content: "V1" } },
    })
    c.send({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: { name: "write_file", arguments: { path: "d.txt", content: "V2-BEDA" } },
    })
    const r1 = await c.next()
    const r2 = await c.next()
    // Keduanya mendapat HASIL SAMA (satu eksekusi, bukan V1+V2 campur).
    expect(JSON.stringify(r1.result)).toBe(JSON.stringify(r2.result))
    // Pemenang balapan tak deterministik di bawah beban (V1 bila handler
    // pertama mendaftar duluan) — invarian keamanan adalah SATU eksekusi
    // dengan balasan identik, bukan urutan pemenang. Audit #08.
    expect(["V1", "V2-BEDA"]).toContain(readFileSync(join(dir, "d.txt"), "utf8"))
    // Jurnal: tepat satu pasangan intent+terminal.
    const { loadJournal } = await import("../src/session/journal.ts")
    const recs = (await loadJournal("mcp-server", dir)).records.filter(
      (r) => !r.kind || r.kind === "mutation",
    )
    const terms = recs.filter((r) => r.state === "committed" || r.state === "failed")
    expect(terms).toHaveLength(1)
  } finally {
    c.kill()
    await cleanup(dir)
  }
})

test("mcp-server: retry sekuensial id sama setelah sukses = replay hasil (tanpa eksekusi ulang)", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    const r1 = await call(c, 61, "write_file", { path: "e.txt", content: "PERTAMA" })
    expect((r1.result as { isError: boolean }).isError ?? false).toBe(false)
    // Proses masih hidup → hasil selesai di-replay persis (bukan error,
    // bukan eksekusi ulang). Beda dengan retry lintas-restart (bukti jurnal
    // tanpa hasil → error eksplisit, lihat test berikutnya).
    const r2 = await call(c, 61, "write_file", { path: "e.txt", content: "KEDUA" })
    expect(JSON.stringify(r2.result)).toBe(JSON.stringify(r1.result))
    expect(readFileSync(join(dir, "e.txt"), "utf8")).toBe("PERTAMA")
  } finally {
    c.kill()
    await cleanup(dir)
  }
})

test("mcp-server: retry lintas restart = error already-executed (durable)", async () => {
  // Audit #08 P0: bukti dedup (id + hash argumen) selamat dari sweep
  // finalize, jadi retry OPERASI SAMA pasca-restart selalu ditahan —
  // deterministik, bukan balapan kill-vs-flush. Id sama + argumen BEDA =
  // operasi baru (lihat test berikut).
  const dir = tmpRoot()
  try {
    const c1 = await startServer(["--cwd", dir])
    try {
      await call(c1, 71, "write_file", { path: "f.txt", content: "R1" })
    } finally {
      c1.kill()
    }
    const c2 = await startServer(["--cwd", dir])
    try {
      const r = await call(c2, 71, "write_file", { path: "f.txt", content: "R1" })
      expect((r.error as { code: number }).code).toBe(-32603)
      expect(JSON.stringify(r.error)).toContain("already executed")
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("R1")
    } finally {
      c2.kill()
    }
  } finally {
    await cleanup(dir)
  }
})

test("mcp-server: restart + id sama argumen BEDA = operasi baru (jalan)", async () => {
  // Audit #08 P0: bukti dedup diindeks (id, argumen). Client reconnect yang
  // me-reset seq memakai id lama untuk operasi BARU — itu sah dan harus
  // jalan. Hanya (id, argumen) identik yang ditahan sebagai duplikat.
  const dir = tmpRoot()
  try {
    const c1 = await startServer(["--cwd", dir])
    try {
      await call(c1, 301, "write_file", { path: "h.txt", content: "LAMA" })
    } finally {
      c1.kill()
    }
    const c2 = await startServer(["--cwd", dir])
    try {
      const r = await call(c2, 301, "write_file", { path: "h.txt", content: "BARU" })
      expect((r.result as { isError: boolean }).isError ?? false).toBe(false)
      expect(readFileSync(join(dir, "h.txt"), "utf8")).toBe("BARU")
    } finally {
      c2.kill()
    }
  } finally {
    await cleanup(dir)
  }
})

test("mcp-server: kill tengah eksekusi → restart + id sama = status unknown (bukan replay)", async () => {
  // Timeout eksplisit: test ini mem-boot DUA server penuh + sleep 20 dtk —
  // default 5 dtk bun terlalu ketat untuk runner CI berbeban (flake timeout
  // deterministik di Linux, hijau lokal).
  // Audit #08 §5: outcome unknown ≠ failed ≠ success. Intent kini membawa
  // note sejak awal, jadi crash tanpa terminal tetap terdeteksi — retry
  // id-sama wajib verifikasi manual, bukan eksekusi ulang buta.
  const dir = tmpRoot()
  const sleepCmd = testSleepCmd()
  const args = { cmd: sleepCmd }
  try {
    const c1 = await startServer(["--cwd", dir, "--allow-all"])
    try {
      c1.send({
        jsonrpc: "2.0",
        id: 401,
        method: "tools/call",
        params: { name: "bash", arguments: args },
      })
      // Tunggu intent durable (bukti tertulis sebelum eksekusi), lalu bunuh.
      const jf = join(dir, ".minicode", "journal-mcp-server.jsonl")
      const t0 = Date.now()
      for (;;) {
        try {
          if (readFileSync(jf, "utf8").includes('"tool":"bash"')) break
        } catch {}
        if (Date.now() - t0 > 15000) throw new Error("intent tak tertulis")
        await Bun.sleep(100)
      }
    } finally {
      c1.kill()
    }
    const c2 = await startServer(["--cwd", dir, "--allow-all"])
    try {
      // Diagnostik CI: bila c2 bungkam, sertakan stderr + journal agar
      // penyebab (crash startup vs evidence miss) terbaca di log.
      const jf2 = join(dir, ".minicode", "journal-mcp-server.jsonl")
      const r = await call(c2, 401, "bash", args).catch((e) => {
        let journal = "(journal hilang)"
        try {
          journal = readFileSync(jf2, "utf8")
        } catch {}
        throw new Error(
          `c2 bungkam: ${(e as Error).message} | stderr=[${c2.stderrText().slice(-600)}] | journal=[${journal.slice(-600)}]`,
        )
      })
      expect((r.error as { code: number }).code).toBe(-32603)
      expect(JSON.stringify(r.error)).toContain("status unknown")
    } finally {
      c2.kill()
    }
  } finally {
    await cleanup(dir)
  }
}, 30000)

// ── 4. Cancel + jurnal + secrets ──

test("mcp-server: notifications/cancelled menghentikan bash panjang", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir, "--allow-all"])
  try {
    const sleepCmd = testSleepCmd()
    c.send({
      jsonrpc: "2.0",
      id: 81,
      method: "tools/call",
      params: { name: "bash", arguments: { cmd: sleepCmd } },
    })
    await Bun.sleep(500)
    c.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 81 } })
    const t0 = Date.now()
    const r = await c.next(15000)
    expect(Date.now() - t0).toBeLessThan(15000)
    // Dibatalkan → hasil error (bukan sukses palsu, bukan gantung).
    const res = r.result as { isError?: boolean } | undefined
    const err = r.error as { message?: string } | undefined
    expect(res?.isError === true || err !== undefined).toBe(true)
  } finally {
    c.kill()
    await cleanup(dir)
  }
})

test("mcp-server: jurnal mencatat mutasi; error terscrub", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    await call(c, 91, "write_file", { path: "g.txt", content: "isi" })
    const { loadJournal } = await import("../src/session/journal.ts")
    const recs = (await loadJournal("mcp-server", dir)).records.filter(
      (r) => !r.kind || r.kind === "mutation",
    )
    const terms = recs.filter((r) => r.state === "committed")
    expect(terms.length).toBeGreaterThanOrEqual(1)
    expect(terms[0]!.tool).toBe("write_file")
    // Paths hidup di intent (terminal berpasangan se-id, tanpa duplikasi).
    const intent = recs.find((r) => r.id === terms[0]!.id && r.state === "pending")
    expect(intent?.paths).toEqual(["g.txt"])
    // Error echo pola rahasia → teredaksi (pola api_key= yang dicakup scrub).
    const bad = await call(c, 92, "grep", { pattern: "([a-z]+" })
    const txt = resultText(bad)
    expect(txt).toContain("invalid regex")
    const bad2 = await call(c, 93, "bash", { cmd: "echo api_key=AKIAIOSFODNN7EXAMPLE" })
    expect(JSON.stringify(bad2)).not.toContain("AKIAIOSFODNN7EXAMPLE")
  } finally {
    c.kill()
    await cleanup(dir)
  }
})

// ── 5. Isolasi + lifecycle ──

test("mcp-server: dua cwd terpisah tak bisa silang", async () => {
  const a = tmpRoot()
  const b = tmpRoot()
  const ca = await startServer(["--cwd", a])
  try {
    await call(ca, 101, "write_file", { path: "rahasia-a.txt", content: "A" })
    // Path absolut milik B ditolak dari A.
    const r = await call(ca, 102, "read_file", { path: join(b, "x.txt") })
    expect((r.result as { isError: boolean }).isError).toBe(true)
  } finally {
    ca.kill()
    await cleanup(a)
    await cleanup(b)
  }
})

test("mcp-server: todo ter-skop namespace unik server; BUKAN 'mcp-server'", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  const c2 = await startServer(["--cwd", dir])
  try {
    const t = await call(c, 111, "todo_write", {
      todos: [{ content: "tugas-srv", status: "pending" }],
    })
    expect((t.result as { isError: boolean }).isError ?? false).toBe(false)

    // Phase 4A.3: the durable namespace is per server instance. It is NOT the
    // shared literal "mcp-server" any more, and it is still not "default".
    const names = readdirSync(join(dir, ".minicode", "todos"))
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^mcp-.+\.json$/)
    expect(names[0]).not.toBe("mcp-server.json")
    expect(existsSync(join(dir, ".minicode", "todos", "mcp-server.json"))).toBe(false)
    expect(existsSync(join(dir, ".minicode", "todos", "default.json"))).toBe(false)

    // A second server over the SAME directory is a different logical context,
    // so it must address a different durable file - this is the invariant the
    // shared literal used to violate.
    const t2 = await call(c2, 111, "todo_write", {
      todos: [{ content: "tugas-srv-2", status: "pending" }],
    })
    expect((t2.result as { isError: boolean }).isError ?? false).toBe(false)
    const after = readdirSync(join(dir, ".minicode", "todos"))
    expect(after).toHaveLength(2)
    expect(new Set(after).size).toBe(2)
    for (const n of after) expect(n).toMatch(/^mcp-.+\.json$/)
  } finally {
    const code = await c.exited().catch(() => null)
    expect([0, null]).toContain(code)
    await cleanup(dir)
  }
})

test("mcp-server: 10 request paralel berbeda id semua sukses", async () => {
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    for (let i = 0; i < 10; i++) {
      c.send({
        jsonrpc: "2.0",
        id: 200 + i,
        method: "tools/call",
        params: { name: "glob", arguments: { pattern: "*.ts" } },
      })
    }
    const got = new Set<number>()
    for (let i = 0; i < 10; i++) {
      const m = await c.next()
      got.add(m.id as number)
      expect(m.error).toBeUndefined()
    }
    expect(got.size).toBe(10)
  } finally {
    c.kill()
    await cleanup(dir)
  }
})

test("mcp-server: 10 duplikat konkuren id sama = satu eksekusi (stress §9)", async () => {
  // Audit #09: versi 10× dari test duplikat-ganda. Id sama + argumen sama
  // dari 10 pengirim serentak → tepat satu efek; semua terima hasil sama.
  const dir = tmpRoot()
  const c = await startServer(["--cwd", dir])
  try {
    for (let i = 0; i < 10; i++) {
      c.send({
        jsonrpc: "2.0",
        id: 501,
        method: "tools/call",
        params: { name: "write_file", arguments: { path: "s10.txt", content: "SATU" } },
      })
    }
    const replies: unknown[] = []
    for (let i = 0; i < 10; i++) replies.push((await c.next()).result)
    const first = JSON.stringify(replies[0])
    for (const r of replies) expect(JSON.stringify(r)).toBe(first)
    const { loadJournal } = await import("../src/session/journal.ts")
    const recs = (await loadJournal("mcp-server", dir)).records.filter(
      (r) => !r.kind || r.kind === "mutation",
    )
    const terms = recs.filter((r) => r.state === "committed" || r.state === "failed")
    expect(terms).toHaveLength(1)
  } finally {
    c.kill()
    await cleanup(dir)
  }
})
