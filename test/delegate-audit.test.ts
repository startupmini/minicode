// AUDIT #04 — delegate_task / multi-agent: capability inheritance,
// isolation, journal, approval, concurrency. Hermetic: factory fake,
// tmp cwd, tanpa network (kecuali git lokal bila ada).

import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LIMITS } from "../src/constants.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"
import { sanitizeSessionId } from "../src/session/checkpoint.ts"
import { appendMutationIntent, appendMutationTerminal } from "../src/session/journal.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  EXPLORE_TOOL_NAMES,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "mc-deleg-"))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

// Provider fallback agar getProvider() jalan tanpa config (pola hardening).
function providerEnv(): () => void {
  const savedKey = process.env.OPENAI_API_KEY
  const savedAgent = process.env.AGENT_API_KEY
  if (!savedKey && !savedAgent) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  return () => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
    if (savedAgent === undefined) delete process.env.AGENT_API_KEY
    else process.env.AGENT_API_KEY = savedAgent
  }
}

function cleanEnv(): () => void {
  const savedSandbox = process.env.MINICODE_SANDBOX
  const savedAllow = process.env.MINICODE_BASH_ALLOWLIST
  delete process.env.MINICODE_SANDBOX
  delete process.env.MINICODE_BASH_ALLOWLIST
  return () => {
    if (savedSandbox !== undefined) process.env.MINICODE_SANDBOX = savedSandbox
    if (savedAllow !== undefined) process.env.MINICODE_BASH_ALLOWLIST = savedAllow
  }
}

const ctxFor = (cwd: string, permissionMode?: string) =>
  ({
    signal: new AbortController().signal,
    emit: () => {},
    cwd,
    ...(permissionMode ? { permissionMode } : {}),
  }) as never

function fakeFactory(
  seen: SubAgentSpec[],
  runImpl?: (
    prompt: string,
    opts: { signal: AbortSignal },
  ) => Promise<{ finalText?: string; usage: { steps: number } }>,
) {
  return async (spec: SubAgentSpec) => {
    seen.push(spec)
    return {
      events: { on: () => () => {} },
      run: runImpl ?? (async () => ({ finalText: "ringkasan anak", usage: { steps: 2 } })),
    }
  }
}

// ── 1. Komposisi toolset anak ──

test("delegate: explore = 12 read-only tepat; plan = 30 tanpa denylist", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "p-tools"
  try {
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(fakeFactory(seen))
    await delegateTaskTool.execute({ prompt: "x" }, ctxFor(dir, "auto"))
    const exploreNames = seen[0]!.tools.map((t) => t.name).sort()
    expect(exploreNames).toEqual([...EXPLORE_TOOL_NAMES].sort())
    expect(EXPLORE_TOOL_NAMES).toHaveLength(12)
    seen.length = 0
    await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
    const planNames = new Set(seen[0]!.tools.map((t) => t.name))
    expect(planNames.size).toBe(30)
    for (const banned of [
      "delegate_task",
      "write_memory",
      "forget_memory",
      "todo_write",
      "bash_output",
      "bash_kill",
      "git_commit",
    ]) {
      expect(planNames.has(banned)).toBe(false)
    }
    // …tetapi tulis file + bash + observasi tetap ada (capability nyata anak).
    for (const kept of [
      "write_file",
      "edit",
      "bash",
      "read_file",
      "web_fetch",
      "mcp_list",
      "submit_result",
      "ask_user",
    ]) {
      expect(planNames.has(kept)).toBe(true)
    }
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
    await cleanup(dir)
  }
})

test("delegate: forced explore untuk parent plan/readonly/ask; default explore", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "p-force"
  try {
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(fakeFactory(seen))
    // Parent plan meminta plan → dipaksa explore.
    const out = (await delegateTaskTool.execute(
      { prompt: "x", mode: "plan" },
      ctxFor(dir, "plan"),
    )) as string
    expect(out).toContain("sub-agent (explore) done")
    // Parent readonly meminta plan → dipaksa explore.
    await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "readonly"))
    // F-07: parent ask meminta plan → dipaksa explore (anak auto dari parent
    // ask adalah eskalasi: satu approval menjadi N aksi tak-disetujui).
    const outAsk = (await delegateTaskTool.execute(
      { prompt: "x", mode: "plan" },
      ctxFor(dir, "ask"),
    )) as string
    expect(outAsk).toContain("sub-agent (explore) done")
    // Tanpa mode → explore.
    await delegateTaskTool.execute({ prompt: "x" }, ctxFor(dir, "auto"))
    expect(seen).toHaveLength(4)
    for (const s of seen) {
      expect(s.tools.map((t) => t.name).sort()).toEqual([...EXPLORE_TOOL_NAMES].sort())
    }
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
    await cleanup(dir)
  }
})

test("delegate: bash anak menolak background:true (anti job yatim)", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "p-nobg"
  try {
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(fakeFactory(seen))
    await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
    const childBash = seen[0]!.tools.find((t) => t.name === "bash")!
    expect(childBash).toBeTruthy()
    // Foreground diteruskan ke implementasi asli (di sini akan gagal eksekusi
    // atau jalan — yang penting BUKAN ditolak guard; pakai cmd tak-valid
    // agar deterministik tanpa spawn).
    await expect(childBash.execute({ cmd: "x", background: true }, {} as never)).rejects.toThrow(
      /not available to sub-agents/,
    )
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
    await cleanup(dir)
  }
})

test("delegate: budget/timeout/cwd/journal plumbing", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "p-plumb"
  try {
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(fakeFactory(seen))
    await delegateTaskTool.execute(
      { prompt: "x", mode: "plan", maxSteps: 100 },
      ctxFor(dir, "auto"),
    )
    const spec = seen[0]!
    expect(spec.maxSteps).toBe(LIMITS.DEFAULT_MAX_STEPS) // cap, bukan 100
    expect(spec.timeoutMs).toBe(LIMITS.SUB_AGENT_TIMEOUT_MS)
    expect(spec.cwd).toBe(dir) // cwd parent diwariskan
    expect(spec.permissionMode).toBe("auto") // SELALU auto, bukan parent
    expect(spec.journal?.parentSessionId).toBe("p-plumb")
    expect(spec.journal?.sessionId).toMatch(/^sub_[0-9a-f]{8}$/)
    // Default tanpa maxSteps: explore=5.
    seen.length = 0
    await delegateTaskTool.execute({ prompt: "x" }, ctxFor(dir, "auto"))
    expect(seen[0]!.maxSteps).toBe(LIMITS.SUB_AGENT_BUDGET_EXPLORE)
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
    await cleanup(dir)
  }
})

// ── 2. Enforcement di dalam anak (handler auto tanpa ask) ──

test("delegate: enforcement anak = kolom auto; MCP/ask mati, tulis/bash hidup", async () => {
  const restoreEnv = cleanEnv()
  const dir = tmpRoot()
  try {
    const h = createPermissionHandler({ mode: "auto", root: dir })
    const check = (name: string, args: Record<string, unknown> = {}) =>
      h.check({ name, args } as never, {} as never)
    // Mati di anak (gated tanpa ask): MCP + ask_user.
    expect(await check("mcp_call", { server: "s", tool: "t" })).toBe("deny")
    expect(await check("mcp_read", { server: "s", uri: "u" })).toBe("deny")
    expect(await check("mcp_prompt", { server: "s", name: "n" })).toBe("deny")
    expect(await check("ask_user", { question: "q?" })).toBe("deny")
    expect(await check("srv.tool", {})).toBe("deny")
    // Hidup di anak plan: tulis file + bash guard-only.
    expect(await check("write_file", { path: "a.txt", content: "x" })).toBe("allow")
    expect(await check("edit", { path: "a.txt", oldString: "a", newString: "b" })).toBe("allow")
    expect(await check("bash", { cmd: "echo hi" })).toBe("allow")
    expect(await check("bash", { cmd: "rm -rf /" })).toBe("deny")
    // code_run ikut flag global (bukan per-anak).
    expect(await check("code_run", { lang: "node", code: "1" })).toBe("deny")
    // Baca-baca: hidup.
    expect(await check("read_file", { path: "a.txt" })).toBe("allow")
    expect(await check("web_fetch", { url: "https://example.com" })).toBe("allow")
    expect(await check("read_memory", { query: "x" })).toBe("allow")
    expect(await check("submit_result", { result: {} })).toBe("allow")
  } finally {
    restoreEnv()
    await cleanup(dir)
  }
})

// ── 3. Gate parent × approval ──

test("delegate: gate parent per mode (readonly/plan/allowlist/allow-all/ask)", async () => {
  const restoreEnv = cleanEnv()
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "p-gate"
  try {
    const h = (
      mode: "auto" | "ask" | "readonly" | "plan" | "allowlist" | "allow-all",
      ask?: never,
    ) => createPermissionHandler({ mode, root: dir, ...(ask ? { ask } : {}) })
    const call = { name: "delegate_task", args: { prompt: "x" } } as never
    expect(await h("readonly").check(call, {} as never)).toBe("deny")
    expect(await h("plan").check(call, {} as never)).toBe("allow")
    expect(await h("allowlist").check(call, {} as never)).toBe("deny")
    expect(await h("allow-all").check(call, {} as never)).toBe("allow")
    expect(await h("ask").check(call, {} as never)).toBe("deny") // headless
    // Ask + TTY + user: TEPAT SATU prompt untuk delegasi (bukan per tool anak).
    // stdin.isTTY di-stub karena test jalan non-TTY (pola highlight.test.ts).
    const prevTty = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
    try {
      let prompts = 0
      const ask = (async () => {
        prompts += 1
        return "allow" as const
      }) as never
      expect(await h("ask", ask).check(call, {} as never)).toBe("allow")
      expect(prompts).toBe(1)
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: prevTty, configurable: true })
    }
  } finally {
    todoSession.id = prevTodo
    restoreEnv()
    restore()
    await cleanup(dir)
  }
})

// ── 4. Jurnal: tanpa duplikasi parent/anak + intent/terminal ──

test("delegate: event forward tak ditulis ganda di jurnal parent", async () => {
  const dir = tmpRoot()
  try {
    // Bus parent dengan wiring jurnal; event anak forward (tagged) dilewati.
    const handlers = new Map<string, ((e: never) => void)[]>()
    const parentBus = {
      events: {
        on: (t: string, h: (e: never) => void) => {
          const l = handlers.get(t) ?? []
          l.push(h)
          handlers.set(t, l)
          return () => {}
        },
      },
    }
    const { attachMutationJournal: attach } = await import("../src/session/journal.ts")
    attach(parentBus as never, { sessionId: "pj", cwd: dir })
    const fire = (t: string, e: unknown) => {
      for (const hh of handlers.get(t) ?? []) hh(e as never)
    }
    const call = { name: "write_file", args: { path: "a.txt", content: "x" }, id: "k1" }
    // Tanpa tag (event parent asli) → tercatat.
    fire("execution:started", { execution: { call } })
    // Dengan tag forward (event anak) → dilewati.
    fire("execution:started", { forwardedChild: "sub_x", execution: { call } })
    await Bun.sleep(200)
    const recs = (await (await import("../src/session/journal.ts")).loadJournal("pj", dir)).records
    expect(recs.filter((r) => r.state === "pending")).toHaveLength(1)
  } finally {
    await cleanup(dir)
  }
})

test("delegate: intent+terminal parent bertaut childSessionId", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "p-jrnl"
  try {
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(fakeFactory(seen))
    await delegateTaskTool.execute({ prompt: "kerjakan", mode: "plan" }, ctxFor(dir, "auto"))
    const childId = seen[0]!.journal!.sessionId
    const { loadJournal: lj } = await import("../src/session/journal.ts")
    const recs = (await lj("p-jrnl", dir)).records.filter((r) => r.tool === "delegate_task")
    expect(recs).toHaveLength(2) // intent + terminal
    expect(recs[0]).toMatchObject({ state: "pending", childSessionId: childId })
    expect(recs[1]).toMatchObject({ state: "committed", childSessionId: childId })
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
    await cleanup(dir)
  }
})

test("delegate: committedDelegatesSince untuk peringatan retry", async () => {
  const dir = tmpRoot()
  try {
    const { committedDelegatesSince: since } = await import("../src/session/journal.ts")
    const t0 = Date.now()
    await Bun.sleep(5)
    const p = await appendMutationIntent({
      session: "pw",
      tool: "delegate_task",
      cwd: dir,
      childSessionId: "c1",
    })
    await appendMutationTerminal("pw", dir, p.id, p.seq, "delegate_task", "committed", {
      note: "c1",
    })
    const q = await appendMutationIntent({
      session: "pw",
      tool: "delegate_task",
      cwd: dir,
      childSessionId: "c2",
    })
    await appendMutationTerminal("pw", dir, q.id, q.seq, "delegate_task", "failed")
    const got = await since("pw", dir, t0)
    // Hanya committed (c1); failed tak ikut (bukan bukti efek).
    expect(got.map((g) => g.childSessionId)).toEqual(["c1"])
    expect(await since("pw", dir, Date.now() + 10000)).toEqual([])
  } finally {
    await cleanup(dir)
  }
})

// ── 5. Owned-state guard ──

test("delegate: file tool tak boleh tulis state minicode (semua mode)", async () => {
  const restoreEnv = cleanEnv()
  const dir = tmpRoot()
  try {
    for (const mode of ["auto", "allow-all"] as const) {
      const h = createPermissionHandler({ mode, root: dir })
      const check = (name: string, args: Record<string, unknown> = {}) =>
        h.check({ name, args } as never, {} as never)
      const targets = [
        ".minicode/sessions.db",
        ".minicode/sessions.db-wal",
        ".minicode/vector.db",
        ".minicode/todos/s.json",
        ".minicode/plans/p.md",
        ".minicode/checkpoints/s/manifest.json",
        ".minicode/journal-s.jsonl",
        ".minicode/step-traces.jsonl",
        ".minicode/repomap.json",
        ".minicode/allowlist.json",
        ".minicode/config.json",
        ".minicode/turn.active.json",
      ]
      for (const t of targets) {
        if ((await check("write_file", { path: t, content: "x" })) !== "deny")
          throw new Error(`${mode} write_file ${t} tidak ditolak`)
        if ((await check("edit", { path: t, oldString: "a", newString: "b" })) !== "deny")
          throw new Error(`${mode} edit ${t} tidak ditolak`)
        if ((await check("delete_file", { path: t })) !== "deny")
          throw new Error(`${mode} delete_file ${t} tidak ditolak`)
        if ((await check("move_file", { from: "a.txt", to: t })) !== "deny")
          throw new Error(`${mode} move→ ${t} tidak ditolak`)
        if ((await check("move_file", { from: t, to: "b.txt" })) !== "deny")
          throw new Error(`${mode} move ${t}→ tidak ditolak`)
      }
      // BACA tetap boleh; file user biasa tetap bisa tulis.
      expect(await check("read_file", { path: ".minicode/todos/s.json" })).toBe("allow")
      expect(await check("write_file", { path: "MEMORY.md", content: "x" })).toBe("allow")
      expect(await check("write_file", { path: ".minicode/hooks/pre-x.js", content: "x" })).toBe(
        "allow",
      )
      expect(await check("write_file", { path: "src/a.ts", content: "x" })).toBe("allow")
    }
  } finally {
    restoreEnv()
    await cleanup(dir)
  }
})

// ── 6. Shared workspace: atomik, tanpa tear ──

test("delegate: tulis konkuren path sama = salah satu versi utuh (tanpa tear)", async () => {
  const dir = tmpRoot()
  try {
    const { writeFileTool } = await import("../src/tools/write_file.ts")
    const a = "A".repeat(5000)
    const b = "B".repeat(5000)
    await Promise.all([
      writeFileTool.execute({ path: "sama.txt", content: a }, ctxFor(dir)),
      writeFileTool.execute({ path: "sama.txt", content: b }, ctxFor(dir)),
    ])
    const final = readFileSync(join(dir, "sama.txt"), "utf8")
    // Atomic rename: hasil persis salah satu (lost update boleh, tear tidak).
    expect(final === a || final === b).toBe(true)
  } finally {
    await cleanup(dir)
  }
})

test("delegate: edit konkuren = versi utuh tanpa baris tercampur", async () => {
  const dir = tmpRoot()
  try {
    writeFileSync(join(dir, "e.txt"), "L0\n")
    const { editTool } = await import("../src/tools/edit.ts")
    await Promise.all([
      editTool.execute({ path: "e.txt", oldString: "L0", newString: "A1\nA2" }, ctxFor(dir)),
      editTool.execute({ path: "e.txt", oldString: "L0", newString: "B1\nB2" }, ctxFor(dir)),
    ])
    const final = readFileSync(join(dir, "e.txt"), "utf8")
    // Salah satu menang utuh; baris tak pernah tercampur setengah.
    const ok = final === "A1\nA2\n" || final === "B1\nB2\n" || final === "L0\n"
    expect(ok).toBe(true)
    for (const line of final.split("\n").filter(Boolean)) {
      expect(["L0", "A1", "A2", "B1", "B2"]).toContain(line)
    }
  } finally {
    await cleanup(dir)
  }
})

// ── 7. Namespace checkpoint/shadow ──

test("delegate: namespace checkpoint + shadow terisolasi per id", async () => {
  const dir = tmpRoot()
  try {
    const parent = "a1b2c3d4"
    const child = "sub_ab12cd34"
    expect(sanitizeSessionId(parent)).not.toBe(sanitizeSessionId(child))
    // Shadow ref: prefix per sesi berbeda.
    let hasGit = false
    try {
      const { spawnSync } = await import("node:child_process")
      hasGit =
        spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0 &&
        spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" }).status === 0
    } catch {}
    if (!hasGit) return
    const { snapshotTree, listShadowRefs } = await import("../src/session/shadow-git.ts")
    writeFileSync(join(dir, "f.txt"), "x\n")
    await snapshotTree(dir, parent, "pre")
    await snapshotTree(dir, child, "pre")
    const refs = (await listShadowRefs(dir)).map((r) => r.ref)
    expect(refs.some((r) => r.includes(parent))).toBe(true)
    expect(refs.some((r) => r.includes(child))).toBe(true)
    expect(new Set(refs).size).toBe(refs.length)
  } finally {
    await cleanup(dir)
  }
})

// ── 8. Timeout anak = string error, turn lanjut ──

test("delegate: child timeout = hasil error-string (turn lanjut, efek ambigu)", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "p-to"
  try {
    writeFileSync(join(dir, "marker.txt"), "HOWDY")
    setSubAgentSessionFactory(async () => ({
      events: { on: () => () => {} },
      run: async (_p: string, _o: { signal: AbortSignal }) => {
        // Simulasi anak: efek samping lalu timeout.
        writeFileSync(join(dir, "efek-anak.txt"), "dibuat\n")
        throw new Error("turn exceeded 120000ms")
      },
    }))
    const out = (await delegateTaskTool.execute({ prompt: "x" }, ctxFor(dir, "auto"))) as string
    // Bukan throw (turn lanjut), tetapi teks jelas error — bukan sukses.
    expect(out).toContain("[sub-agent explore error]")
    expect(out).toContain("turn exceeded")
    // Efek tetap ada di FS (timeout ≠ rollback).
    expect(readFileSync(join(dir, "efek-anak.txt"), "utf8")).toBe("dibuat\n")
    // Jurnal parent: committed (delegasi selesai-dengan-error), BUKAN failed.
    const { loadJournal: lj } = await import("../src/session/journal.ts")
    const terms = (await lj("p-to", dir)).records.filter(
      (r) => r.tool === "delegate_task" && (r.state === "committed" || r.state === "failed"),
    )
    expect(terms.map((r) => r.state)).toEqual(["committed"])
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
    await cleanup(dir)
  }
})

// ── 9. Sepuluh anak paralel: isolasi id ──

test("delegate: 10 anak paralel = id unik, intent lengkap", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "p10"
  try {
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(fakeFactory(seen))
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        delegateTaskTool.execute({ prompt: `tugas ${i}` }, ctxFor(dir, "auto")),
      ),
    )
    const ids = seen.map((s) => s.journal!.sessionId)
    expect(new Set(ids).size).toBe(10)
    const { loadJournal: lj } = await import("../src/session/journal.ts")
    const intents = (await lj("p10", dir)).records.filter(
      (r) => r.tool === "delegate_task" && r.state === "pending",
    )
    expect(intents).toHaveLength(10)
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
    await cleanup(dir)
  }
})

// ── 10. MCP/code_run boundary di anak + git_commit absen ──

test("delegate: child plan tanpa git_commit; MCP/code_run ikut gate global", async () => {
  const restore = providerEnv()
  const restoreEnv = cleanEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "p-mcp"
  try {
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(fakeFactory(seen))
    await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
    const names = new Set(seen[0]!.tools.map((t) => t.name))
    expect(names.has("git_commit")).toBe(false)
    expect(names.has("mcp_call")).toBe(true) // ada, tetapi gated→deny tanpa ask
    const h = createPermissionHandler({ mode: "auto", root: dir })
    const check = (name: string, args: Record<string, unknown> = {}) =>
      h.check({ name, args } as never, {} as never)
    expect(await check("mcp_call", { server: "s", tool: "t" })).toBe("deny")
    expect(await check("git_commit", { message: "m" })).toBe("deny")
    expect(await check("code_run", { lang: "node", code: "1" })).toBe("deny")
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restoreEnv()
    restore()
    await cleanup(dir)
  }
})

// ── 11. Memory isolation arah ──

test("delegate: anak baca memory boleh, tulis/lupa tidak ada", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "p-mem"
  try {
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(fakeFactory(seen))
    await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
    const names = new Set(seen[0]!.tools.map((t) => t.name))
    expect(names.has("read_memory")).toBe(true)
    expect(names.has("write_memory")).toBe(false)
    expect(names.has("forget_memory")).toBe(false)
    expect(names.has("todo_write")).toBe(false)
    expect(names.has("todo_read")).toBe(true)
    expect(names.has("bash_output")).toBe(false)
    expect(names.has("bash_kill")).toBe(false)
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
    await cleanup(dir)
  }
})
