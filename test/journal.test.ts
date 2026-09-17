// Mutation intent journal (AUDIT #01C): pure decision + wiring + corruption.
// Hermetic: tmp cwd, file jurnal lokal, tanpa kernel/network.

import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendFinalize,
  appendMutationIntent,
  appendMutationTerminal,
  appendUndoMarker,
  attachMutationJournal,
  classifyTool,
  decideRecovery,
  deleteJournalFile,
  finalizeJournal,
  hashArgs,
  isJournalHealthy,
  isMutationTool,
  type JournalRecord,
  journalPath,
  loadJournal,
  planRecoveryForSession,
  resolvePending,
  sweepJournal,
  verifyPaths,
} from "../src/session/journal.ts"
import { allTools } from "../src/tools/index.ts"

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "mc-journal-"))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

function readLines(session: string, cwd: string): JournalRecord[] {
  return readFileSync(journalPath(session, cwd), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as JournalRecord)
}

// Tunggu file mencapai N baris (I/O jurnal async pasca-event; sleep tetap
// membuat test flaky saat mesin berat — polling deterministik).
async function waitLines(
  session: string,
  cwd: string,
  n: number,
  timeoutMs = 5000,
): Promise<JournalRecord[]> {
  const t0 = Date.now()
  for (;;) {
    let recs: JournalRecord[] = []
    try {
      recs = readLines(session, cwd)
    } catch {}
    if (recs.length >= n) return recs
    if (Date.now() - t0 > timeoutMs) return recs
    await Bun.sleep(25)
  }
}

function mkrec(
  part: Partial<JournalRecord> & { id: string; seq: number; tool: string },
): JournalRecord {
  return {
    v: 1,
    session: "s",
    cwd: "/w",
    ts: 1,
    ...part,
  } as JournalRecord
}

// Bus fake: meniru session.events kernel (cukup untuk attach).
function fakeBus() {
  const handlers = new Map<string, ((e: never) => void)[]>()
  return {
    events: {
      on: (t: string, h: (e: never) => void) => {
        const l = handlers.get(t) ?? []
        l.push(h)
        handlers.set(t, l)
        return () => {}
      },
    },
    state: { turnCount: 7 },
    fire: (t: string, e: unknown) => {
      for (const h of handlers.get(t) ?? []) h(e as never)
    },
  }
}

const started = (name: string, args: unknown, id = "c1") => ({
  execution: { call: { name, args, id }, result: { content: "" } },
})
const completed = (name: string, args: unknown, id = "c1", isError = false) => ({
  execution: { call: { name, args, id }, result: { content: "ok", isError } },
})

// ── 1. Closed-set classifier vs registry 37 tool ──

test("journal: seluruh 37 tool terklasifikasi; unknown fail-loud di test", () => {
  expect(allTools.map((t) => t.name).sort()).toHaveLength(37)
  for (const t of allTools) {
    const c = classifyTool(t.name)
    if (c === "unknown") throw new Error(`tool belum diklasifikasikan: ${t.name}`)
  }
  expect(classifyTool("future_tool_xyz")).toBe("unknown")
  expect(classifyTool("srv.tool")).toBe("mutation") // MCP runtime ≡ mcp_call
  expect(classifyTool("write_file")).toBe("mutation")
  expect(classifyTool("todo_write")).toBe("none") // full-replace idempoten
  expect(classifyTool("submit_result")).toBe("none") // memori-proses
  expect(classifyTool("ask_user")).toBe("none")
  expect(classifyTool("read_file")).toBe("none")
})

test("journal: unknown fail-closed → terjurnal sebagai mutasi (F-14)", () => {
  // classifyTool tetap "unknown" (taksonomi), TETAPI isMutationTool true:
  // tool masa depan yang lupa didaftarkan tetap punya intent/terminal,
  // bukan recovery buta. Guard test-time di atas tetap menangkapnya agar
  // didaftarkan eksplisit.
  expect(classifyTool("future_tool_xyz")).toBe("unknown")
  expect(isMutationTool("future_tool_xyz")).toBe(true)
  expect(isMutationTool("read_file")).toBe(false)
  expect(isMutationTool("write_file")).toBe(true)
})

test("journal: daftar MUTATION persis 12 + dotted", () => {
  const names = allTools
    .map((t) => t.name)
    .filter((n) => isMutationTool(n))
    .sort()
  expect(names).toEqual(
    [
      "bash",
      "code_run",
      "delete_file",
      "delegate_task",
      "edit",
      "apply_patch",
      "forget_memory",
      "git_commit",
      "mcp_call",
      "move_file",
      "write_file",
      "write_memory",
    ].sort(),
  )
})

// ── 2. Hash & paths tanpa rahasia ──

test("journal: argsHash deterministik + order-insensitive + sensitif-nilai", () => {
  expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }))
  expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }))
  expect(hashArgs({ k: "sk-secret-xyz" })).not.toContain("sk-secret")
})

test("journal: paths relatif-dalam-root saja", () => {
  const dir = tmpRoot()
  try {
    expect(verifyPaths("write_file", { path: "a/b.txt" }, dir)).toEqual(["a/b.txt"])
    expect(verifyPaths("write_file", { path: "/etc/passwd" }, dir)).toEqual([])
    expect(verifyPaths("write_file", { path: "../luar.txt" }, dir)).toEqual([])
    expect(verifyPaths("move_file", { from: "a", to: "sub/b" }, dir)).toEqual(["a", "sub/b"])
    expect(verifyPaths("move_file", { from: "a", to: "/luar" }, dir)).toEqual(["a"])
    expect(verifyPaths("git_commit", { message: "m", paths: ["a", "/x"] }, dir)).toEqual(["a"])
    // git paths di-cap 20 agar record bounded.
    const many = Array.from({ length: 25 }, (_, i) => `f${i}.ts`)
    expect(verifyPaths("git_commit", { message: "m", paths: many }, dir)).toHaveLength(20)
    expect(verifyPaths("bash", { cmd: "rm -rf /" }, dir)).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 3. Wiring event: pending → committed/failed; non-mutasi dilewati ──

test("journal wiring: mutation started→pending, completed→committed", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal(bus, { sessionId: "w1", cwd: dir })
    bus.fire("execution:started", started("write_file", { path: "a.txt", content: "x" }))
    let recs = await waitLines("w1", dir, 1)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ tool: "write_file", state: "pending", turn: 7 })
    expect(recs[0]!.id).toBe("w1:0")
    expect(recs[0]!.paths).toEqual(["a.txt"])
    bus.fire("execution:completed", completed("write_file", { path: "a.txt" }))
    recs = await waitLines("w1", dir, 2)
    expect(recs).toHaveLength(2)
    expect(recs[1]).toMatchObject({ id: "w1:0", state: "committed" })
  } finally {
    await cleanup(dir)
  }
})

test("journal wiring: error → failed; non-mutasi/delegate dilewati, unknown terjurnal (F-14)", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal(bus, { sessionId: "w2", cwd: dir })
    bus.fire("execution:started", started("bash", { cmd: "echo hi" }, "b1"))
    bus.fire("execution:completed", completed("bash", { cmd: "echo hi" }, "b1", true))
    bus.fire("execution:started", started("read_file", { path: "a" }, "r1"))
    bus.fire("execution:completed", completed("read_file", { path: "a" }, "r1"))
    bus.fire("execution:started", started("nope_tool", {}, "n1"))
    bus.fire("execution:completed", completed("nope_tool", {}, "n1"))
    bus.fire("execution:started", started("delegate_task", { prompt: "x" }, "d1"))
    bus.fire("execution:completed", completed("delegate_task", { prompt: "x" }, "d1"))
    const recs = await waitLines("w2", dir, 4)
    // bash: pending + failed. read/delegate = nol baris. nope_tool (unknown)
    // kini ikut terjurnal fail-closed: pending + committed.
    expect(recs.map((r) => `${r.tool}:${r.state}`)).toEqual([
      "bash:pending",
      "nope_tool:pending",
      "bash:failed",
      "nope_tool:committed",
    ])
  } finally {
    await cleanup(dir)
  }
})

test("journal wiring: MCP dotted = remote + turn tercatat", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal(bus, { sessionId: "w3", cwd: dir })
    bus.fire("execution:started", started("srv.tool", { x: 1 }, "m1"))
    const recs = await waitLines("w3", dir, 1)
    expect(recs[0]).toMatchObject({ tool: "srv.tool", remote: true, state: "pending", turn: 7 })
  } finally {
    await cleanup(dir)
  }
})

test("journal: tanpa secret di file (args hanya hash)", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal(bus, { sessionId: "w4", cwd: dir })
    bus.fire(
      "execution:started",
      started("write_file", { path: "a.txt", content: "TOKEN-sk-RAHASIA-123" }, "s1"),
    )
    await waitLines("w4", dir, 1)
    const raw = readFileSync(journalPath("w4", dir), "utf8")
    expect(raw).not.toContain("RAHASIA")
    expect(raw).not.toContain("content")
    expect(raw).toContain("argsHash")
  } finally {
    await cleanup(dir)
  }
})

// ── 4. decideRecovery murni ──

test("decide: pending → direktif ambigu berisi tool+paths, tanpa redo", () => {
  const plan = decideRecovery(
    [mkrec({ id: "s:0", seq: 0, tool: "write_file", state: "pending", paths: ["a.txt"] })],
    [],
  )
  expect(plan.clean).toBe(false)
  expect(plan.directive).toContain("write_file")
  expect(plan.directive).toContain("a.txt")
  expect(plan.directive).toContain("DILARANG redo buta")
  expect(plan.attention).toHaveLength(1)
})

test("decide: committed + turn durable → clean; turn hilang → stitch tanpa replay", () => {
  const rec = mkrec({ id: "s:0", seq: 0, tool: "edit", state: "committed", turn: 3, paths: ["a"] })
  expect(decideRecovery([rec], [1, 2, 3]).clean).toBe(true)
  const miss = decideRecovery([rec], [1, 2])
  expect(miss.clean).toBe(false)
  expect(miss.directive).toContain("JANGAN")
  expect(miss.stitched).toHaveLength(1)
  // Stitch bukan blokir-redo-ambigu: tak ada attention item.
  expect(miss.attention).toHaveLength(0)
})

test("decide: remote committed → wajib baca-balik", () => {
  const plan = decideRecovery(
    [mkrec({ id: "s:0", seq: 0, tool: "srv.tool", state: "committed", remote: true })],
    [0],
  )
  expect(plan.clean).toBe(false)
  expect(plan.directive).toContain("baca-balik")
})

test("decide: multi-pending seq-order + bounded", () => {
  const recs = Array.from({ length: 12 }, (_, i) =>
    mkrec({ id: `s:${i}`, seq: i, tool: "bash", state: "pending" }),
  )
  const plan = decideRecovery(recs, [])
  expect(plan.attention.map((a) => a.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  expect(plan.directive).toContain("+2 lagi")
  expect(plan.directive).toContain("minta keputusan user")
})

test("decide: duplikat terminal + transisi mustahil → warn, terminal pertama menang", () => {
  const plan = decideRecovery(
    [
      mkrec({ id: "s:0", seq: 0, tool: "edit", state: "pending", paths: ["a"], turn: 5 }),
      mkrec({ id: "s:0", seq: 0, tool: "edit", state: "committed", paths: ["a"], turn: 5 }),
      mkrec({ id: "s:0", seq: 0, tool: "edit", state: "failed", paths: ["a"], turn: 5 }),
      mkrec({ id: "s:0", seq: 0, tool: "edit", state: "pending", paths: ["a"], turn: 5 }),
    ],
    [5],
  )
  // committed tertutup turn durable → clean; warning duplikat tetap ada.
  expect(plan.clean).toBe(true)
  expect(plan.warnings.some((w) => w.includes("duplikat"))).toBe(true)
})

test("decide: seq gap → warn; marker-only → clean", () => {
  const gap = decideRecovery(
    [
      mkrec({ id: "s:0", seq: 0, tool: "edit", state: "committed", turn: 1 }),
      mkrec({ id: "s:5", seq: 5, tool: "edit", state: "committed", turn: 2 }),
    ],
    [1, 2],
  )
  expect(gap.warnings.some((w) => w.includes("gap"))).toBe(true)
  const markers = decideRecovery(
    [
      mkrec({ id: "s:9", seq: 9, tool: "", kind: "undo", targetTurn: 2 }),
      mkrec({ id: "s:10", seq: 10, tool: "", kind: "finalize", uptoSeq: 9 }),
    ],
    [],
  )
  expect(markers.clean).toBe(true)
  expect(markers.stats.markers).toBe(1)
})

test("decide: superseded pending tidak menagih", () => {
  const plan = decideRecovery(
    [
      mkrec({ id: "s:0", seq: 0, tool: "edit", state: "pending", paths: ["a.txt"] }),
      mkrec({ id: "s:1", seq: 1, tool: "edit", state: "committed", paths: ["a.txt"], turn: 9 }),
    ],
    [],
  )
  // seq0 tersupersede seq1; seq1 committed tanpa turn durable → stitch saja.
  expect(plan.attention).toHaveLength(0)
  expect(plan.stitched).toHaveLength(1)
})

// ── 5. Korupsi file ──

test("load: ekor terpotong dibuang, prefix otoritatif", async () => {
  const dir = tmpRoot()
  try {
    const sid = "kor1"
    await appendMutationIntent({ session: sid, tool: "edit", cwd: dir, paths: ["a"] })
    await writeFile(
      journalPath(sid, dir),
      `${readFileSync(journalPath(sid, dir), "utf8")}{"v":1,"seq":9,`,
    )
    const loaded = await loadJournal(sid, dir)
    expect(loaded.truncatedTail).toBe(true)
    expect(loaded.records).toHaveLength(1)
    expect(loaded.warnings.length).toBeGreaterThan(0)
  } finally {
    await cleanup(dir)
  }
})

test("load: tengah korup → quarantine + prefix live", async () => {
  const dir = tmpRoot()
  try {
    const sid = "kor2"
    await appendMutationIntent({ session: sid, tool: "edit", cwd: dir, paths: ["a"] })
    await appendMutationTerminal(sid, dir, `${sid}:0`, 0, "edit", "committed")
    const lines = readFileSync(journalPath(sid, dir), "utf8").split("\n").filter(Boolean)
    await writeFile(journalPath(sid, dir), `${lines[0]}\nBUKAN-JSON\n${lines[1]}\n`)
    const loaded = await loadJournal(sid, dir)
    expect(loaded.quarantined).toBe(true)
    expect(loaded.records).toHaveLength(1) // prefix valid dipertahankan
    // Live ditulis ulang hanya dengan prefix.
    const live = readFileSync(journalPath(sid, dir), "utf8").split("\n").filter(Boolean)
    expect(live).toHaveLength(1)
  } finally {
    await cleanup(dir)
  }
})

// ── 6. Finalize + sweep + resolvePending ──

test("sweep: hanya finalized yang dibersihkan; pending bertahan", async () => {
  const dir = tmpRoot()
  try {
    const sid = "sw1"
    const r0 = await appendMutationIntent({ session: sid, tool: "edit", cwd: dir, paths: ["a"] })
    await appendMutationTerminal(sid, dir, r0.id, r0.seq, "edit", "committed")
    const r1 = await appendMutationIntent({ session: sid, tool: "bash", cwd: dir })
    expect(r1.seq).toBe(1)
    await appendFinalize(sid, dir, 1) // cover seq 0..1
    const dropped = await sweepJournal(sid, dir)
    expect(dropped).toBeGreaterThan(0)
    const rest = await loadJournal(sid, dir)
    // committed seq0 + pending pasangannya terbuang; pending bash (tanpa
    // pasangan, tanpa paths) bertahan walau ter-cover.
    expect(rest.records.some((r) => r.state === "committed")).toBe(false)
    expect(rest.records.some((r) => r.state === "pending" && r.tool === "bash")).toBe(true)
  } finally {
    await cleanup(dir)
  }
})

test("resolvePending: applied/absent + tolak ganda", async () => {
  const dir = tmpRoot()
  try {
    const sid = "rs1"
    const r = await appendMutationIntent({ session: sid, tool: "edit", cwd: dir, paths: ["a"] })
    expect(await resolvePending(sid, dir, r.seq, "absent", "cek manual")).toBe(true)
    expect(await resolvePending(sid, dir, r.seq, "applied")).toBe(false) // terminal menang
    expect(await resolvePending(sid, dir, 999, "applied")).toBe(false) // tak ada
    const plan = decideRecovery((await loadJournal(sid, dir)).records, [])
    // failed + turn null → attention (verifikasi sudah dilakukan manusia,
    // tetapi catatan tetap jujur: turn tak-durable).
    expect(plan.attention.some((a) => a.tool === "edit")).toBe(true)
  } finally {
    await cleanup(dir)
  }
})

test("finalizeJournal: marker + sweep sekali jalan", async () => {
  const dir = tmpRoot()
  try {
    const sid = "fz1"
    const r = await appendMutationIntent({ session: sid, tool: "edit", cwd: dir, paths: ["a"] })
    await appendMutationTerminal(sid, dir, r.id, r.seq, "edit", "committed")
    await finalizeJournal(sid, dir)
    const rest = await loadJournal(sid, dir)
    // committed ter-cover → tersapu; marker finalize terakhir bertahan.
    expect(rest.records.some((x) => x.state === "committed")).toBe(false)
    expect(rest.records.some((x) => x.kind === "finalize")).toBe(true)
  } finally {
    await cleanup(dir)
  }
})

// ── 7. Degraded: tulis gagal tak melempar ──

test("journal degraded-loud saat direktori tak bisa ditulis", async () => {
  const dir = tmpRoot()
  try {
    // .minicode sebagai FILE → mkdir/append gagal.
    writeFileSync(join(dir, ".minicode"), "bukan-direktori")
    const bus = fakeBus()
    attachMutationJournal(bus, { sessionId: "dg1", cwd: dir })
    bus.fire("execution:started", started("write_file", { path: "a" }, "c9"))
    // Polling hingga flag unhealthy terlihat (handler async; tanpa ini flaky).
    const t0 = Date.now()
    while (isJournalHealthy("dg1", dir) && Date.now() - t0 < 5000) await Bun.sleep(25)
    // Tak melempar (turn tak boleh mati karena log), tetapi unhealthy + tanpa file.
    expect(isJournalHealthy("dg1", dir)).toBe(false)
    expect(existsSync(journalPath("dg1", dir))).toBe(false)
  } finally {
    await cleanup(dir)
  }
})

// ── 8. Undo marker + planRecovery parent-anak ──

test("undo marker tercatat dan terbaca resume", async () => {
  const dir = tmpRoot()
  try {
    await appendUndoMarker("um1", dir, "undo", 4)
    const loaded = await loadJournal("um1", dir)
    expect(loaded.records[0]).toMatchObject({ kind: "undo", targetTurn: 4 })
    const plan = decideRecovery(loaded.records, [])
    expect(plan.clean).toBe(true)
    expect(plan.stats.markers).toBe(1)
  } finally {
    await cleanup(dir)
  }
})

test("planRecovery: parent + jurnal anak dirujuk", async () => {
  const dir = tmpRoot()
  try {
    const p = await appendMutationIntent({
      session: "ps",
      tool: "delegate_task",
      cwd: dir,
      childSessionId: "cs9",
    })
    await appendMutationTerminal("ps", dir, p.id, p.seq, "delegate_task", "committed", {
      note: "cs9",
    })
    const c = await appendMutationIntent({ session: "cs9", tool: "bash", cwd: dir, childOf: "ps" })
    // Anak pending → direktif menyebut keduanya.
    const plan = await planRecoveryForSession("ps", dir, { persistedTurns: [] })
    expect(plan.clean).toBe(false)
    expect(plan.directive).toContain("delegate_task")
    expect(plan.directive).toContain("bash")
    expect(c.childOf).toBe("ps")
  } finally {
    await cleanup(dir)
  }
})

test("deleteJournalFile menghapus siklus hidup", async () => {
  const dir = tmpRoot()
  try {
    await appendMutationIntent({ session: "del1", tool: "edit", cwd: dir })
    expect(existsSync(journalPath("del1", dir))).toBe(true)
    deleteJournalFile("del1", dir)
    const t1 = Date.now()
    while (existsSync(journalPath("del1", dir)) && Date.now() - t1 < 5000) await Bun.sleep(25)
    expect(existsSync(journalPath("del1", dir))).toBe(false)
  } finally {
    await cleanup(dir)
  }
})
