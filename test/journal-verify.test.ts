// AUDIT #01D — runtime verification implementasi mutation journal.
// Larangan: tidak mengubah src; hanya membuktikan semantics aktual.
// Setiap test mengunci invariant atau mendokumentasikan gap (→ laporan).

import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendMutationIntent,
  appendMutationTerminal,
  attachMutationJournal,
  decideRecovery,
  type JournalRecord,
  journalPath,
  loadJournal,
  planRecoveryForSession,
} from "../src/session/journal.ts"
import { allTools } from "../src/tools/index.ts"

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "mc-jverify-"))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

function lines(session: string, cwd: string): JournalRecord[] {
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
      recs = lines(session, cwd)
    } catch {}
    if (recs.length >= n) return recs
    if (Date.now() - t0 > timeoutMs) return recs
    await Bun.sleep(25)
  }
}

function fakeBus(turnCount = 3) {
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
    state: { turnCount },
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

function mkrec(
  part: Partial<JournalRecord> & { id: string; seq: number; tool: string },
): JournalRecord {
  return { v: 1, session: "s", cwd: "/w", ts: 1, ...part } as JournalRecord
}

// ── F1 event ordering ──

test("verify: completed tanpa started tak menghasilkan terminal yatim", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal(bus, { sessionId: "eo1", cwd: dir })
    bus.fire("execution:completed", completed("write_file", { path: "a" }, "zx"))
    // Negatif: tunggu cukup lama agar terminal liar sempat muncul bila ada.
    await Bun.sleep(300)
    // Tak ada intent → tak ada terminal. File boleh ada (eager empty) tetapi
    // HARUS kosong — tanpa ini, completed liar = committed palsu.
    if (existsSync(journalPath("eo1", dir))) {
      const { loadJournal: lj } = await import("../src/session/journal.ts")
      expect((await lj("eo1", dir)).records).toHaveLength(0)
    }
  } finally {
    await cleanup(dir)
  }
})

test("verify: started ganda id sama → dua intent (bukan satu hantu)", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal(bus, { sessionId: "eo2", cwd: dir })
    bus.fire("execution:started", started("edit", { path: "a" }, "dup"))
    bus.fire("execution:started", started("edit", { path: "a" }, "dup"))
    const recs = await waitLines("eo2", dir, 2)
    expect(recs.filter((r) => r.state === "pending")).toHaveLength(2)
    bus.fire("execution:completed", completed("edit", { path: "a" }, "dup"))
    const after = await waitLines("eo2", dir, 3)
    // Append-only: KEDUA intent bertahan; terminal berpasangan dengan yang
    // tertua. Konsolidasi (bukan penghapusan) yang menyatukannya di decide.
    expect(after.filter((r) => r.state === "pending")).toHaveLength(2)
    expect(after.filter((r) => r.state === "committed")).toHaveLength(1)
    expect(after.find((r) => r.state === "committed")!.id).toBe("eo2:0")
  } finally {
    await cleanup(dir)
  }
})

// ── F2 state machine ──

test("verify: terminal tunggal tak dapat ditimpa tulisan basi", async () => {
  const dir = tmpRoot()
  try {
    const sid = "sm1"
    const r = await appendMutationIntent({ session: sid, tool: "bash", cwd: dir })
    await appendMutationTerminal(sid, dir, r.id, r.seq, "bash", "failed")
    await appendMutationTerminal(sid, dir, r.id, r.seq, "bash", "committed")
    const plan = decideRecovery((await loadJournal(sid, dir)).records, [])
    // Terminal pertama (failed) menang; committed basi diabaikan + warn.
    expect(plan.attention.some((a) => a.state === "failed")).toBe(true)
    expect(plan.attention.some((a) => a.state === "committed")).toBe(false)
    expect(plan.warnings.some((w) => w.includes("duplikat"))).toBe(true)
  } finally {
    await cleanup(dir)
  }
})

// ── F5 crash matrix replay (A–K sintetik) ──

test("verify: crash matrix A–K vs keputusan", () => {
  // A: sebelum intent (tanpa record) → clean/advisory.
  expect(decideRecovery([], []).clean).toBe(true)
  // B–F: intent tanpa terminal (pre/post fsync tak terbedakan) → verify.
  for (const label of ["B", "C", "D", "E", "F"]) {
    const p = decideRecovery(
      [mkrec({ id: `s:${label}`, seq: 0, tool: "write_file", state: "pending", paths: ["a"] })],
      [],
    )
    if (p.clean) throw new Error(`${label} harus tidak-clean`)
    if (!p.directive!.includes("DILARANG redo buta"))
      throw new Error(`${label} tanpa larangan redo`)
  }
  // G–J: committed tanpa finalize → percaya + jahit, tanpa replay.
  const g = decideRecovery(
    [mkrec({ id: "s:0", seq: 0, tool: "edit", state: "committed", turn: 4, paths: ["a"] })],
    [1, 2],
  )
  expect(g.attention).toHaveLength(0)
  expect(g.stitched).toHaveLength(1)
  // K: finalize → clean penuh.
  const k = decideRecovery(
    [
      mkrec({ id: "s:0", seq: 0, tool: "edit", state: "committed", turn: 4, paths: ["a"] }),
      mkrec({ id: "s:1", seq: 1, tool: "", kind: "finalize", uptoSeq: 0 }),
    ],
    [4],
  )
  expect(k.clean).toBe(true)
})

// ── F7 klasifikasi via eksekusi aktual (37 tool) ──

test("verify: hanya 13 kelas mutasi yang menulis saat event aktual", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal(bus, { sessionId: "cl1", cwd: dir })
    const benign: Record<string, unknown> = {
      path: "a",
      content: "x",
      cmd: "echo hi",
      query: "x",
      file: "a.ts",
    }
    let i = 0
    for (const t of allTools) {
      const id = `k${i++}`
      bus.fire("execution:started", started(t.name, benign, id))
    }
    const recs = await waitLines("cl1", dir, 12)
    const tools = new Set(recs.map((r) => r.tool))
    expect([...tools].sort()).toEqual(
      [
        "bash",
        "code_run",
        "delete_file",
        "edit",
        "apply_patch",
        "forget_memory",
        "git_commit",
        "git_push",
        "mcp_call",
        "move_file",
        "write_file",
        "write_memory",
      ].sort(),
    )
    // delegate_task dilewati wiring generik (dicatat eksplisit oleh tool).
    expect(tools.has("delegate_task")).toBe(false)
  } finally {
    await cleanup(dir)
  }
})

// ── F9 remote: committed + turn durable TETAP wajib verifikasi ──

test("verify: remote committed tak pernah setara lokal", () => {
  const rec = mkrec({ id: "s:0", seq: 0, tool: "srv.x", state: "committed", turn: 2, remote: true })
  const plan = decideRecovery([rec], [1, 2, 3])
  expect(plan.clean).toBe(false)
  expect(plan.directive).toContain("baca-balik")
  expect(plan.attention).toHaveLength(0) // bukan pause-ambigu, melainkan verify-wajib
})

// ── F10 delegate: jurnal anak hilang = warning degraded (FIX #01E) ──

test("verify: child journal hilang di-warning degraded", async () => {
  const dir = tmpRoot()
  try {
    const p = await appendMutationIntent({
      session: "pd",
      tool: "delegate_task",
      cwd: dir,
      childSessionId: "hilang-xyz",
    })
    await appendMutationTerminal("pd", dir, p.id, p.seq, "delegate_task", "committed", {
      note: "hilang-xyz",
    })
    const plan = await planRecoveryForSession("pd", dir, { persistedTurns: [] })
    // Bukti parent committed + file absen = degraded (bukan sunyi, bukan redo).
    expect(plan.warnings.some((w) => w.includes("hilang-xyz"))).toBe(true)
    expect(plan.clean).toBe(false)
  } finally {
    await cleanup(dir)
  }
})

// ── F11 memory: dua store, tanpa konten mentah ──

test("verify: memory mutation dijurnal tanpa isi", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal(bus, { sessionId: "mm1", cwd: dir })
    bus.fire("execution:started", started("write_memory", { text: "RAHASIA-INGATAN-1" }, "w1"))
    bus.fire("execution:completed", completed("write_memory", { text: "x" }, "w1"))
    bus.fire("execution:started", started("forget_memory", { query: "q" }, "f1"))
    bus.fire("execution:completed", completed("forget_memory", { query: "q" }, "f1", true))
    const recs = await waitLines("mm1", dir, 4)
    const raw = readFileSync(journalPath("mm1", dir), "utf8")
    expect(raw).not.toContain("RAHASIA")
    // Urutan FILE tak dijamin (terminal menunggu intent-nya); yang dijamin:
    // himpunan record + pasangan per id. Otoritas urutan = seq.
    expect(recs.map((r) => `${r.tool}:${r.state}`).sort()).toEqual(
      [
        "write_memory:pending",
        "write_memory:committed",
        "forget_memory:pending",
        "forget_memory:failed",
      ].sort(),
    )
    expect(new Set(recs.map((r) => r.id)).size).toBe(2) // pasangan per id
  } finally {
    await cleanup(dir)
  }
})

// ── F12 undo pasca-mutasi: stitch basi (GAP — dokumentasikan) ──

test("verify: stitch committed mendahului marker undo (nada basi)", () => {
  const plan = decideRecovery(
    [
      mkrec({ id: "s:0", seq: 0, tool: "edit", state: "committed", paths: ["a"] }),
      mkrec({ id: "s:1", seq: 1, tool: "", kind: "undo", targetTurn: 3 }),
    ],
    [],
  )
  // Marker tak menekan stitch: narasi "anggap efek ada" basi pasca-undo,
  // tetapi arahnya aman (tak pernah menyarankan redo). Dikunci sebagai gap P2.
  expect(plan.stitched).toHaveLength(1)
  expect(plan.directive).toContain("JANGAN")
})

// ── F13 cleanup: session deletion + quarantine retained ──

test("verify: quarantine evidence dipertahankan, bukan hilang diam-diam", async () => {
  const dir = tmpRoot()
  try {
    const sid = "qq1"
    await appendMutationIntent({ session: sid, tool: "edit", cwd: dir, paths: ["a"] })
    await appendMutationTerminal(sid, dir, `${sid}:0`, 0, "edit", "committed")
    const raw = readFileSync(journalPath(sid, dir), "utf8").split("\n").filter(Boolean)
    await writeFile(journalPath(sid, dir), `${raw[0]}\nRUSAK\n${raw[1]}\n`)
    const loaded = await loadJournal(sid, dir)
    expect(loaded.quarantined).toBe(true)
    // Bukti karantina ada di disk (bukan /dev/null).
    const { readdirSync } = await import("node:fs")
    expect(readdirSync(join(dir, ".minicode")).some((f) => f.includes(".corrupt."))).toBe(true)
    expect(loaded.records).toHaveLength(1)
  } finally {
    await cleanup(dir)
  }
})

// ── F14 out-of-order file order ──

test("verify: urutan file tak menentukan kebenaran (seq yang otoritatif)", () => {
  const plan = decideRecovery(
    [
      mkrec({ id: "s:5", seq: 5, tool: "bash", state: "pending" }),
      mkrec({ id: "s:0", seq: 0, tool: "edit", state: "committed", turn: 1, paths: ["a"] }),
    ],
    [1],
  )
  expect(plan.attention.map((a) => a.seq)).toEqual([5])
  expect(plan.stitched).toHaveLength(0) // seq0 committed + turn durable
})

// ── F15 security scan menyeluruh ──

test("verify: scan rahasia lintas tool (bash/MCP/memory/prompt)", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal(bus, { sessionId: "sec1", cwd: dir })
    bus.fire(
      "execution:started",
      started("bash", { cmd: "curl -H 'Authorization: Bearer SEKRET-A' x" }, "a"),
    )
    bus.fire("execution:completed", completed("bash", { cmd: "x" }, "a"))
    bus.fire(
      "execution:started",
      started("mcp_call", { server: "s", tool: "t", args: { k: "SEKRET-B" } }, "b"),
    )
    bus.fire("execution:completed", completed("mcp_call", { server: "s", tool: "t" }, "b"))
    bus.fire("execution:started", started("delegate_task", { prompt: "SEKRET-C" }, "c"))
    await waitLines("sec1", dir, 4)
    const raw = readFileSync(journalPath("sec1", dir), "utf8")
    for (const s of ["SEKRET-A", "SEKRET-B", "Authorization", "Bearer"]) {
      if (raw.includes(s)) throw new Error(`bocor: ${s}`)
    }
    // delegate dilewati wiring generik (eksplisit oleh tool) — file hanya bash+MCP.
    expect(raw).not.toContain("delegate_task")
  } finally {
    await cleanup(dir)
  }
})

// ── F16 concurrency ──

test("verify: N intent konkuren → seq unik (atau temuan P0)", async () => {
  const dir = tmpRoot()
  const { appendMutationIntent: append } = await import("../src/session/journal.ts")
  try {
    const sid = "cc1"
    const outs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        append({ session: sid, tool: "edit", cwd: dir, paths: [`f${i}`] }),
      ),
    )
    const seqs = outs.map((r) => r.seq)
    // Jika gagal di sini = balapan seq terkonfirmasi (P0) — test adalah buktinya.
    expect(new Set(seqs).size).toBe(20)
  } finally {
    await cleanup(dir)
  }
})

test("verify: retry satu callId (gagal→sukses) berpasangan FIFO", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal(bus, { sessionId: "rt1", cwd: dir })
    bus.fire("execution:started", started("bash", { cmd: "x" }, "same"))
    bus.fire("execution:completed", completed("bash", { cmd: "x" }, "same", true))
    bus.fire("execution:started", started("bash", { cmd: "x" }, "same"))
    bus.fire("execution:completed", completed("bash", { cmd: "x" }, "same", false))
    const recs = await waitLines("rt1", dir, 4)
    // Tiap completed berpasangan dengan intent tertua tak-berpasangan;
    // record intent tak pernah dihapus (append-only) — konsolidasi di decide.
    expect(recs.filter((r) => r.state === "pending")).toHaveLength(2)
    expect(recs.filter((r) => r.state === "failed")).toHaveLength(1)
    expect(recs.filter((r) => r.state === "committed")).toHaveLength(1)
  } finally {
    await cleanup(dir)
  }
})

test("verify: dua sesi paralel terisolasi file", async () => {
  const dir = tmpRoot()
  try {
    const a = fakeBus()
    const b = fakeBus()
    attachMutationJournal(a, { sessionId: "sa", cwd: dir })
    attachMutationJournal(b, { sessionId: "sb", cwd: dir, childOf: "sa" })
    a.fire("execution:started", started("edit", { path: "a" }, "x"))
    b.fire("execution:started", started("edit", { path: "b" }, "y"))
    const ra = await waitLines("sa", dir, 1)
    const rb = await waitLines("sb", dir, 1)
    expect(ra).toHaveLength(1)
    expect(rb).toHaveLength(1)
    expect(rb[0]!.childOf).toBe("sa")
    expect(ra[0]!.childOf).toBeUndefined()
  } finally {
    await cleanup(dir)
  }
})

// ── F17 performance (ukur saja, tanpa optimasi) ──

test("verify: latensi tulis + bebanekl (observasi, bukan snapshot ketat)", async () => {
  const dir = tmpRoot()
  try {
    const sid = "perf1"
    const t0 = Date.now()
    for (let i = 0; i < 20; i++) {
      await appendMutationIntent({ session: sid, tool: "edit", cwd: dir, paths: [`f${i}`] })
    }
    const perWrite = (Date.now() - t0) / 20
    // Asumsi desain: fsync negligible vs tool/LLM (orde ms, bukan ratusan ms).
    expect(perWrite).toBeLessThan(250)
    // 1000 record sintetis: load + decide tetap interaktif.
    const big: JournalRecord[] = Array.from({ length: 1000 }, (_, i) =>
      mkrec({
        id: `s:${i}`,
        seq: i,
        tool: "edit",
        state: i % 3 === 0 ? "pending" : "committed",
        paths: [`f${i}`],
        turn: 1,
      }),
    )
    const t1 = Date.now()
    const plan = decideRecovery(big, [1])
    const dt = Date.now() - t1
    expect(dt).toBeLessThan(2000)
    expect(plan.attention.length).toBeGreaterThan(0)
    // Catat angka aktual ke stderr untuk laporan (bukan assertion ketat).
    process.stderr.write(`[perf] journal: ${perWrite.toFixed(1)}ms/tulis, decide-1000: ${dt}ms\n`)
  } finally {
    await cleanup(dir)
  }
}, 30000)
