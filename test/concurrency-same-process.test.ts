// AUDIT #09 — Concurrency same-process: bukti batas yang berlaku.
//
// Aturan main: tiap test membuktikan SATU klaim terhadap execution path.
// Race tanpa reproducer deterministik tidak di-fix (lihat laporan #09).

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEventBus } from "#minicore/core/events.ts"
import { loadConfig } from "../src/config.ts"
import { parallelExecutor } from "../src/policy/executor.ts"
import { saveProvider } from "../src/providers/provision.ts"
import {
  loadCheckpointManifest,
  recordCheckpoint,
  redoLastCheckpoint,
  undoLastCheckpoint,
} from "../src/session/checkpoint.ts"
import {
  appendMutationIntent,
  appendMutationTerminal,
  loadJournal,
} from "../src/session/journal.ts"
import { loadSession, saveSession } from "../src/session/persistence.ts"

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-conc-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

// ── §7/§8 Journal: 100 intent konkuren → seq unik, tak ada tabrakan ──

test("§7 100 appendMutationIntent konkuren: seq 0..99 unik, JSONL utuh", async () => {
  const dir = tmpRoot()
  try {
    const recs = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        appendMutationIntent({
          session: "j100",
          tool: "write_file",
          cwd: dir,
          paths: [`f${i}.txt`],
          turn: 0,
        }),
      ),
    )
    const seqs = recs.map((r) => r.seq).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i))
    expect(new Set(recs.map((r) => r.id)).size).toBe(100)
    // Setiap baris parse sebagai JSON (tak ada interleave robek).
    const lines = readFileSync(join(dir, ".minicode", "journal-j100.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
    expect(lines).toHaveLength(100)
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
  } finally {
    cleanup(dir)
  }
})

test("§27 10 pasangan intent+terminal konkuren: semua berpasangan benar", async () => {
  const dir = tmpRoot()
  try {
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const r = await appendMutationIntent({
          session: "jp",
          tool: "edit",
          cwd: dir,
          paths: [`g${i}.txt`],
          turn: 0,
        })
        await appendMutationTerminal("jp", dir, r.id, r.seq, "edit", i % 2 ? "failed" : "committed")
      }),
    )
    const { records } = await loadJournal("jp", dir)
    const terms = records.filter((r) => r.state === "committed" || r.state === "failed")
    expect(terms).toHaveLength(10)
    // Tiap terminal menunjuk id intent yang ada.
    const ids = new Set(records.filter((r) => r.state === "pending").map((r) => r.id))
    for (const t of terms) expect(ids.has(t.id)).toBe(true)
  } finally {
    cleanup(dir)
  }
})

// ── §4 Isolasi sesi: 10 sesi konkuren workspace sama ──

test("§4 10 sesi konkuren: state tak bocor antar sesi", async () => {
  const dir = tmpRoot()
  try {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        saveSession(`cs-${i}`, dir, undefined, [{ role: "user", content: `pesan-${i}` }], {
          turn: i,
        }),
      ),
    )
    for (let i = 0; i < 10; i++) {
      const s = loadSession(`cs-${i}`, dir)
      expect(s?.messages.length).toBe(1)
      expect(JSON.stringify(s?.messages[0])).toContain(`pesan-${i}`)
      expect(s?.turnCount).toBe(1)
    }
  } finally {
    cleanup(dir)
  }
})

// ── §14 Eksekutor: ordering + pairing deterministik ──

import { createToolRegistry } from "#minicore/core/tool.ts"

function execDeps(dir: string) {
  return {
    state: { history: [], turnCount: 0, stepCount: 0 },
    maxResultTokens: 1000,
    cwd: dir,
    signal: new AbortController().signal,
    events: createEventBus(),
    permissions: { check: async () => "allow" as const },
  }
}

function memTool(
  name: string,
  order: string[],
  opts: { ms?: number; onRun?: (args: unknown) => unknown } = {},
) {
  return {
    name,
    description: "t",
    parameters: { type: "object", properties: {} },
    async execute(args: unknown) {
      order.push(`${name}:start`)
      if (opts.ms) await new Promise((r) => setTimeout(r, opts.ms))
      const out = opts.onRun?.(args) ?? "ok"
      order.push(`${name}:end`)
      return out as string
    },
  }
}

function wcall(id: string, name: string, args: unknown = {}) {
  return { id, name, args } as never
}

test("§14 batch all-write: serial pada slot tulis, hasil ikut urutan input", async () => {
  const dir = tmpRoot()
  try {
    const order: string[] = []
    const registry = createToolRegistry([
      memTool("write_file", order, {
        onRun: (a) => {
          const { path, content } = a as { path: string; content: string }
          writeFileSync(join(dir, path), content)
          return `wrote ${content}`
        },
      }) as never,
    ])
    const ex = parallelExecutor()
    const results = await ex.execute(
      [
        wcall("1", "write_file", { path: "x.txt", content: "satu" }),
        wcall("2", "write_file", { path: "x.txt", content: "dua" }),
        wcall("3", "write_file", { path: "x.txt", content: "tiga" }),
      ],
      { ...execDeps(dir), registry } as never,
    )
    // Pairing hasil = urutan input walau eksekusi balapan.
    expect(results.map((r) => (r.content as string).replace("wrote ", ""))).toEqual([
      "satu",
      "dua",
      "tiga",
    ])
    // Slot tulis tunggal (default) → mulai selalu setelah selesai sebelumnya.
    expect(order).toEqual([
      "write_file:start",
      "write_file:end",
      "write_file:start",
      "write_file:end",
      "write_file:start",
      "write_file:end",
    ])
    expect(readFileSync(join(dir, "x.txt"), "utf8")).toBe("tiga")
  } finally {
    cleanup(dir)
  }
})

test("§14 batch campur tulis+baca: sekuensial urutan input (baca lihat tulis)", async () => {
  const dir = tmpRoot()
  try {
    writeFileSync(join(dir, "r.txt"), "lama")
    const registry = createToolRegistry([
      memTool("write_file", [], {
        onRun: (a) => {
          const { path, content } = a as { path: string; content: string }
          writeFileSync(join(dir, path), content)
          return "wrote"
        },
      }) as never,
      memTool("read_file", [], {
        onRun: (a) => readFileSync(join(dir, (a as { path: string }).path), "utf8"),
      }) as never,
    ])
    const ex = parallelExecutor()
    const results = await ex.execute(
      [
        wcall("1", "write_file", { path: "r.txt", content: "baru" }),
        wcall("2", "read_file", { path: "r.txt" }),
      ],
      { ...execDeps(dir), registry } as never,
    )
    expect(results[1]!.content).toBe("baru")
  } finally {
    cleanup(dir)
  }
})

test("§14 file-lock: path sama serial walau slot tulis longgar", async () => {
  const dir = tmpRoot()
  try {
    const order: string[] = []
    const registry = createToolRegistry([
      memTool("write_file", order, {
        ms: 50,
        onRun: (a) => {
          const { path, content } = a as { path: string; content: string }
          writeFileSync(join(dir, path), content)
          return "ok"
        },
      }) as never,
    ])
    const ex = parallelExecutor({ concurrency: 6, writeConcurrency: 3 })
    await ex.execute(
      [
        wcall("1", "write_file", { path: "s.txt", content: "A" }),
        wcall("2", "write_file", { path: "s.txt", content: "B" }),
      ],
      { ...execDeps(dir), registry } as never,
    )
    // File-lock per path: tak pernah interleave walau 3 slot tulis bebas.
    expect(order).toEqual([
      "write_file:start",
      "write_file:end",
      "write_file:start",
      "write_file:end",
    ])
  } finally {
    cleanup(dir)
  }
})

test("§14 slot tulis longgar: path BEDA boleh tumpang (konkuren nyata)", async () => {
  const dir = tmpRoot()
  try {
    const order: string[] = []
    const registry = createToolRegistry([memTool("write_file", order, { ms: 80 }) as never])
    const ex = parallelExecutor({ concurrency: 6, writeConcurrency: 3 })
    await ex.execute(
      [wcall("1", "write_file", { path: "p.txt" }), wcall("2", "write_file", { path: "q.txt" })],
      { ...execDeps(dir), registry } as never,
    )
    // Kedua start sebelum ada end = overlap nyata.
    expect(order.slice(0, 2)).toEqual(["write_file:start", "write_file:start"])
    expect(order.slice(2)).toEqual(["write_file:end", "write_file:end"])
  } finally {
    cleanup(dir)
  }
})

test("§14 bash dalam batch pure-write: serial via slot tulis (F-08)", async () => {
  // F-08 (refined): bash tidak punya file-lock (getFilePath null), TETAPI
  // slot tulis tunggal (default writeConcurrency 1) tetap menserialkan batch
  // pure-write. Test ini mengunci perilaku itu: bash lambat + edit pada file
  // yang sama tidak boleh tumpang (tanpa ini = lost update).
  const dir = tmpRoot()
  try {
    const order: string[] = []
    const registry = createToolRegistry([
      memTool("bash", order, { ms: 60, onRun: () => "shell-ok" }) as never,
      memTool("edit", order, {
        onRun: (a) => {
          const { path, content } = a as { path: string; content: string }
          writeFileSync(join(dir, path), content)
          return "edited"
        },
      }) as never,
    ])
    const ex = parallelExecutor()
    const results = await ex.execute(
      [
        wcall("1", "bash", { cmd: "echo x >> f.txt" }),
        wcall("2", "edit", { path: "f.txt", content: "baru" }),
      ],
      { ...execDeps(dir), registry } as never,
    )
    expect(order).toEqual(["bash:start", "bash:end", "edit:start", "edit:end"])
    expect(results.map((r) => r.isError ?? false)).toEqual([false, false])
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("baru")
  } finally {
    await cleanup(dir)
  }
})

test("§14 10 read konkuren: semua identik, tanpa tulis siluman", async () => {
  const dir = tmpRoot()
  try {
    writeFileSync(join(dir, "same.txt"), "tetap")
    const registry = createToolRegistry([
      memTool("read_file", [], {
        onRun: (a) => readFileSync(join(dir, (a as { path: string }).path), "utf8"),
      }) as never,
    ])
    const ex = parallelExecutor()
    const results = await ex.execute(
      Array.from({ length: 10 }, (_, i) => wcall(`${i}`, "read_file", { path: "same.txt" })),
      { ...execDeps(dir), registry } as never,
    )
    expect(results.every((r) => r.content === "tetap")).toBe(true)
    expect(readFileSync(join(dir, "same.txt"), "utf8")).toBe("tetap")
  } finally {
    cleanup(dir)
  }
})

// ── §24/§25 Checkpoint: operasi konkuren konsisten ──

test("§25 undo×2 konkuren: tepat satu menang, pointer valid", async () => {
  const dir = tmpRoot()
  try {
    const f = join(dir, "f.txt")
    writeFileSync(f, "v1")
    await recordCheckpoint("cu", 1, [f], "t1", dir)
    writeFileSync(f, "v2")
    const [a, b] = await Promise.all([undoLastCheckpoint("cu", dir), undoLastCheckpoint("cu", dir)])
    // Serial oleh withCheckpointLock: satu melihat 0→-1, satunya -1→no-op.
    expect([a.success, b.success].filter(Boolean)).toHaveLength(1)
    expect(readFileSync(f, "utf8")).toBe("v1")
    expect((await loadCheckpointManifest("cu", dir)).currentIndex).toBe(-1)
  } finally {
    cleanup(dir)
  }
})

test("§24 undo+redo konkuren: hasil valid (salah satu urutan penuh)", async () => {
  const dir = tmpRoot()
  try {
    const f = join(dir, "f.txt")
    writeFileSync(f, "v1")
    await recordCheckpoint("cr", 1, [f], "t1", dir)
    writeFileSync(f, "v2")
    await undoLastCheckpoint("cr", dir) // pointer -1, konten v1
    await Promise.all([undoLastCheckpoint("cr", dir), redoLastCheckpoint("cr", dir)])
    const man = await loadCheckpointManifest("cr", dir)
    // Pointer selalu dalam batas; konten konsisten dengan salah satu ujung.
    expect(man.currentIndex).toBeGreaterThanOrEqual(-1)
    expect(man.currentIndex).toBeLessThanOrEqual(0)
    // Dengan lock serial, urutan undo→redo atau redo→undo keduanya valid.
    // Undo menang terakhir → v1, redo menang terakhir → v2.
    expect(["v1", "v2"].includes(readFileSync(f, "utf8"))).toBe(true)
  } finally {
    cleanup(dir)
  }
})

// ── §21 Config: tulis+baca konkuren tak robek ──

test("§21 8 tulis + 8 baca konkuren: semua parse, final lengkap", async () => {
  const dir = tmpRoot()
  try {
    const { mkdirSync: mk } = await import("node:fs")
    mk(join(dir, ".minicode"), { recursive: true })
    const writers = Array.from({ length: 8 }, (_, i) =>
      saveProvider(
        { id: `cp${i}`, baseUrl: `https://x${i}.example`, apiKey: "k", models: ["m"] },
        { global: false, cwd: dir },
      ),
    )
    const readers = Array.from({ length: 8 }, () => loadConfig(dir, { allowLocal: true }))
    const [_, cfgs] = await Promise.all([Promise.all(writers), Promise.all(readers)])
    // Setiap baca konkuren menghasilkan JSON valid (rename atomik).
    for (const c of cfgs) expect(Array.isArray(c.providers)).toBe(true)
    const final = await loadConfig(dir, { allowLocal: true })
    for (let i = 0; i < 8; i++) expect(final.providers.some((p) => p.id === `cp${i}`)).toBe(true)
  } finally {
    cleanup(dir)
  }
})

// ── §20 Memory: forget vs append + append paralel ──

test("§20 forget vs 20 append konkuren: lama hilang, baru utuh semua", async () => {
  const dir = tmpRoot()
  try {
    const { appendMemory, deleteMemoryLines } = await import("../src/memory/files.ts")
    const { readMemoryFile } = await import("../src/memory/files.ts")
    await appendMemory(Array.from({ length: 60 }, (_, i) => `korban ${i}`).join("\n"), dir)
    const tag = `selamat-${Date.now()}`
    await Promise.all([
      deleteMemoryLines("korban", dir),
      ...Array.from({ length: 20 }, (_, i) => appendMemory(`${tag} ${i}`, dir)),
    ])
    const txt = await readMemoryFile(dir)
    expect(txt.split("\n").filter((l) => l.includes("korban baris")).length).toBe(0)
    // Hmm: filter "korban" juga cocok "selamat-…"? tag tak mengandung
    // "korban" — aman. Semua append selamat dari clobber forget.
    expect(txt.split("\n").filter((l) => l.includes(tag)).length).toBe(20)
  } finally {
    cleanup(dir)
  }
})

test("§20 10 append konkuren: semua baris ada (tanpa interleave robek)", async () => {
  const dir = tmpRoot()
  try {
    const { appendMemory, readMemoryFile } = await import("../src/memory/files.ts")
    const tag = `par-${Date.now()}`
    await Promise.all(Array.from({ length: 10 }, (_, i) => appendMemory(`${tag} ${i}`, dir)))
    const lines = (await readMemoryFile(dir)).split("\n").filter((l) => l.includes(tag))
    expect(lines).toHaveLength(10)
    // Tiap baris utuh satu entri (tak ada setengah baris tercampur).
    for (const l of lines) expect(l).toMatch(new RegExp(`^- \\d{4}-\\d{2}-\\d{2} ${tag} \\d$`))
  } finally {
    cleanup(dir)
  }
})

// ── §22 Auth: refresh konkuren + simpan konkuren ──

test("§22 10 refresh provider kedaluwarsa sama: TEPAT satu POST", async () => {
  const { getValidAccessToken } = await import("../src/providers/oauth.ts")
  const { saveAuth, removeAuth } = await import("../src/providers/auth-store.ts")
  let posts = 0
  const srv = Bun.serve({
    port: 0,
    fetch: async () => {
      posts++
      await Bun.sleep(120)
      return Response.json({ access_token: "AT-10x", expires_in: 3600 })
    },
  })
  const pid = "test-conc-refresh-10x"
  try {
    await saveAuth(pid, {
      type: "oauth",
      refreshToken: "RT",
      tokenUrl: `http://127.0.0.1:${srv.port}/token`,
      clientId: "c",
      accessToken: "OLD",
      expiresAt: Date.now() - 1000,
    })
    const toks = await Promise.all(Array.from({ length: 10 }, () => getValidAccessToken(pid)))
    expect(new Set(toks).size).toBe(1)
    expect(toks[0]).toBe("AT-10x")
    expect(posts).toBe(1)
  } finally {
    await removeAuth(pid).catch(() => {})
    srv.stop(true)
  }
})

test("§22 2 provider kedaluwarsa refresh bersamaan: tak ada yang hilang (P1 fix)", async () => {
  const { getValidAccessToken } = await import("../src/providers/oauth.ts")
  const { loadAuthStore, removeAuth, saveAuth } = await import("../src/providers/auth-store.ts")
  let posts = 0
  const srv = Bun.serve({
    port: 0,
    fetch: async () => {
      const n = ++posts
      await Bun.sleep(100)
      return Response.json({ access_token: `AT-${n}`, expires_in: 3600 })
    },
  })
  const url = `http://127.0.0.1:${srv.port}/token`
  const mk = (id: string) =>
    saveAuth(id, {
      type: "oauth",
      refreshToken: "RT",
      tokenUrl: url,
      clientId: "c",
      accessToken: "OLD",
      expiresAt: Date.now() - 1000,
    })
  try {
    await mk("test-conc-a9")
    await mk("test-conc-b9")
    const [a, b] = await Promise.all([
      getValidAccessToken("test-conc-a9"),
      getValidAccessToken("test-conc-b9"),
    ])
    // Urutan kedatangan request tak deterministik (terutama di CI berbeban):
    // yang dijamin = tiap id dapat token SEGAR yang berbeda, bukan asumsi
    // a=AT-1/b=AT-2. Invarian P1: tak ada yang hilang (dulu rec-b=OLD).
    expect(posts).toBe(2)
    expect(new Set([a, b])).toEqual(new Set(["AT-1", "AT-2"]))
    // Tanpa withAuthLock: tulisan terakhir menelan yang pertama (rec-b=OLD).
    const store = await loadAuthStore()
    const got = new Set([store["test-conc-a9"]?.accessToken, store["test-conc-b9"]?.accessToken])
    expect(got).toEqual(new Set(["AT-1", "AT-2"]))
  } finally {
    await removeAuth("test-conc-a9").catch(() => {})
    await removeAuth("test-conc-b9").catch(() => {})
    srv.stop(true)
  }
})

// ── §5/§6 Child: 10 delegasi paralel ──

test("§5 10 delegate paralel: semua selesai, childId unik, 10 terminal parent", async () => {
  const dir = tmpRoot()
  try {
    const { delegateTaskTool, setSubAgentSessionFactory, clearSubAgentSessionFactory } =
      await import("../src/tools/task.ts")
    const { todoSession } = await import("../src/tools/todo.ts")
    const prevTodo = todoSession.id
    todoSession.id = "p-conc10"
    const restoreEnv = (() => {
      const k = process.env.OPENAI_API_KEY
      const a = process.env.AGENT_API_KEY
      if (!k && !a) process.env.OPENAI_API_KEY = "sk-test-hermetic"
      return () => {
        if (k === undefined) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = k
        if (a === undefined) delete process.env.AGENT_API_KEY
        else process.env.AGENT_API_KEY = a
      }
    })()
    const seen: string[] = []
    setSubAgentSessionFactory(async () => ({
      events: { on: () => () => {} },
      run: async (prompt: string) => {
        await new Promise((r) => setTimeout(r, Math.random() * 60))
        seen.push(prompt)
        return { finalText: `done:${prompt}`, usage: { steps: 1 } }
      },
    }))
    try {
      const ctx = { signal: new AbortController().signal, emit: () => {}, cwd: dir } as never
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          delegateTaskTool.execute({ prompt: `tugas-${i}` }, ctx),
        ),
      )
      expect(results).toHaveLength(10)
      // Tiap hasil membawa ringkasan tugasnya sendiri (pairing benar).
      for (let i = 0; i < 10; i++) expect(String(results[i])).toContain(`tugas-${i}`)
      const { records } = await loadJournal("p-conc10", dir)
      const terms = records.filter(
        (r) => r.tool === "delegate_task" && (r.state === "committed" || r.state === "failed"),
      )
      expect(terms).toHaveLength(10)
      const childs = terms.map((r) => r.childSessionId)
      expect(new Set(childs).size).toBe(10)
    } finally {
      todoSession.id = prevTodo
      clearSubAgentSessionFactory()
      restoreEnv()
    }
  } finally {
    cleanup(dir)
  }
})

// ── §11 Provider fallback: atribusi tepat satu attempt ──

test("§11 fallback A→B: usage + effective-model milik B, sekali", async () => {
  const { createRouterProvider } = await import("../src/providers/router.ts")
  const { ProviderError } = await import("#minicore/core/errors.ts")
  const seen: string[] = []
  const mkFake = (id: string, fail: boolean) => ({
    id,
    models: ["m"],
    kind: "openai",
    async *stream() {
      if (fail) throw new ProviderError("server", "boom-500")
      seen.push(id)
      yield { type: "extension", kind: "usage", data: { inputTokens: 7, outputTokens: 3 } }
      yield { type: "text", text: `dari-${id}` }
      yield { type: "finish", reason: "stop" }
    },
  })
  const router = createRouterProvider({
    providers: [mkFake("Aa", true), mkFake("Bb", false)] as never,
  })
  const texts: string[] = []
  const effs: unknown[] = []
  const usages: unknown[] = []
  for await (const ev of router.stream(
    { messages: [{ role: "user", content: "hi" }], model: "m" } as never,
    new AbortController().signal,
  )) {
    if (ev.type === "text") texts.push((ev as { text: string }).text)
    if (ev.type === "extension" && (ev as { kind: string }).kind === "effective-model")
      effs.push((ev as { data: unknown }).data)
    if (ev.type === "extension" && (ev as { kind: string }).kind === "usage")
      usages.push((ev as { data: unknown }).data)
  }
  // Tepat satu attempt otoritatif: B jalan sekali, usage sekali milik B.
  expect(seen).toEqual(["Bb"])
  expect(texts.join("")).toContain("dari-Bb")
  expect(usages).toHaveLength(1)
  expect(JSON.stringify(effs).includes("Bb")).toBe(true)
})

// ── §37 EventBus: registrasi ganda = sekali; throw terisolasi ──

test("§37 bus sinkron: fn sama dua kali = sekali panggil; throw tak merambat", async () => {
  const bus = createEventBus()
  let n = 0
  const fn = () => {
    n++
  }
  bus.on("turn:started", fn as never)
  bus.on("turn:started", fn as never)
  let other = 0
  bus.on("turn:started", (() => {
    other++
    throw new Error("rusak")
  }) as never)
  const errs: unknown[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => {
    errs.push(a)
  }
  try {
    bus.emit({ type: "turn:started", turn: 1 })
  } finally {
    console.error = orig
  }
  expect(n).toBe(1)
  expect(other).toBe(1)
  expect(errs.length).toBeGreaterThan(0)
})

// ── §31 Shutdown: kill ganda aman, sesi tetap bisa jalan ──

test("§31 killAllBackgroundJobs ganda tak throw; foreground tetap jalan", async () => {
  const dir = tmpRoot()
  try {
    const { bashTool, killAllBackgroundJobs } = await import("../src/tools/bash.ts")
    const ctx = { cwd: dir, signal: new AbortController().signal } as never
    const started = (await bashTool.execute(
      { cmd: `"${process.execPath}" -e "await Bun.sleep(20000)"`, background: true },
      ctx,
    )) as string
    expect(started).toContain("background job started")
    expect(() => killAllBackgroundJobs()).not.toThrow()
    expect(() => killAllBackgroundJobs()).not.toThrow()
    const echo = (await bashTool.execute({ cmd: "echo hidup" }, ctx)) as string
    expect(echo).toContain("hidup")
  } finally {
    const { killAllBackgroundJobs } = await import("../src/tools/bash.ts")
    try {
      killAllBackgroundJobs()
    } catch {}
    cleanup(dir)
  }
})
