// AUDIT #08 — Recovery / Idempotency matrix: perilaku aktual, bukan asumsi.
//
// Setiap test membuktikan satu sel matriks dari spesifikasi audit terhadap
// execution path. Kecuali dinyatakan eksplisit ("mendanai perilaku"), test
// yang gagal = bug. Komentar menandai nomor seksi audit (#08 §N).

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadCheckpointManifest,
  reconcileUndoRedoPointer,
  recordCheckpoint,
  redoLastCheckpoint,
  undoLastCheckpoint,
} from "../src/session/checkpoint.ts"
import {
  appendFinalize,
  appendMutationIntent,
  appendMutationTerminal,
  appendUndoMarker,
  attachMutationJournal,
  decideRecovery,
  finalizeJournal,
  loadJournal,
  planRecoveryForSession,
  resolvePending,
  sweepJournal,
} from "../src/session/journal.ts"
import { listPersistedTurns, loadSession, saveSession } from "../src/session/persistence.ts"

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-rec08-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows menahan handle SQLite sejenak; artefak temp dibersihkan OS.
  }
}

async function intent(
  session: string,
  dir: string,
  tool = "write_file",
  extra: Record<string, unknown> = {},
) {
  return appendMutationIntent({
    session,
    tool,
    cwd: dir,
    paths: ["f.txt"],
    turn: 0,
    ...extra,
  })
}

// ── §17 Terminal-state semantics: transisi invalid tak merusak keputusan ──

test("§17 duplikat terminal: pertama menang + warning, keputusan pakai committed", async () => {
  const dir = tmpRoot()
  try {
    const r = await intent("s", dir)
    await appendMutationTerminal("s", dir, r.id, r.seq, "write_file", "committed")
    await appendMutationTerminal("s", dir, r.id, r.seq, "write_file", "failed")
    const { records } = await loadJournal("s", dir)
    const plan = decideRecovery(records, [0])
    expect(plan.warnings.some((w) => w.includes("duplikat"))).toBe(true)
    // committed pertama menang + turn durable → bersih (bukan attention).
    expect(plan.clean).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("§17 pending basi setelah terminal: diabaikan + warning", async () => {
  // Transisi invalid "committed → pending" (tulisan basi lintas proses):
  // decideRecovery murni pada array — bangun langsung tanpa file.
  const base = { v: 1 as const, session: "s", tool: "write_file", cwd: "/tmp", ts: 1 }
  const recs = [
    { ...base, id: "s:0", seq: 0, state: "committed" as const, turn: 0 },
    { ...base, id: "s:0", seq: 5, state: "pending" as const, turn: 0 },
  ]
  const plan = decideRecovery(recs, [0])
  expect(plan.warnings.some((w) => w.includes("basi") || w.includes("duplikat"))).toBe(true)
  // Terminal pertama menang → committed + durable → bersih.
  expect(plan.clean).toBe(true)
})

test("§17 pending ter-cover finalize tetap ambigu (unknown ≠ aman)", async () => {
  const dir = tmpRoot()
  try {
    await intent("s", dir)
    await appendFinalize("s", dir, 5)
    const plan = decideRecovery((await loadJournal("s", dir)).records, [])
    expect(plan.clean).toBe(false)
    expect(plan.attention.some((a) => a.state === "pending")).toBe(true)
    expect(plan.warnings.some((w) => w.includes("ambigu"))).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("§17 failed ter-cover finalize = selesai diam (bukan blokir ulang)", async () => {
  const dir = tmpRoot()
  try {
    const r = await intent("s", dir)
    await appendMutationTerminal("s", dir, r.id, r.seq, "write_file", "failed")
    await appendFinalize("s", dir, 5)
    const plan = decideRecovery((await loadJournal("s", dir)).records, [])
    expect(plan.clean).toBe(true)
    expect(plan.stats.finalized).toBeGreaterThanOrEqual(1)
  } finally {
    cleanup(dir)
  }
})

// ── §18 Recovery decision purity: deterministik lintas pemanggilan ──

test("§18 decideRecovery murni: 3× pemanggilan hasil identik", async () => {
  const dir = tmpRoot()
  try {
    const a = await intent("s", dir, "edit")
    await appendMutationTerminal("s", dir, a.id, a.seq, "edit", "committed")
    await intent("s", dir, "bash", { paths: [] })
    const records = (await loadJournal("s", dir)).records
    const p1 = decideRecovery(records, [])
    const p2 = decideRecovery(records, [])
    const p3 = decideRecovery(records, [])
    expect(p2).toEqual(p1)
    expect(p3).toEqual(p1)
    expect(p1.clean).toBe(false)
  } finally {
    cleanup(dir)
  }
})

// ── §24 Crash injection: tiap titik putus → keputusan eksplisit ──

test("§24 crash setelah intent (tanpa terminal) → attention pending", async () => {
  const dir = tmpRoot()
  try {
    await intent("s", dir)
    const plan = decideRecovery((await loadJournal("s", dir)).records, [])
    expect(plan.clean).toBe(false)
    expect(plan.directive).toContain("DILARANG redo buta")
  } finally {
    cleanup(dir)
  }
})

test("§24 crash setelah terminal committed tanpa persist → stitch (jangan ulang)", async () => {
  const dir = tmpRoot()
  try {
    const r = await intent("s", dir)
    await appendMutationTerminal("s", dir, r.id, r.seq, "write_file", "committed")
    const plan = decideRecovery((await loadJournal("s", dir)).records, [])
    expect(plan.clean).toBe(false)
    expect(plan.stitched).toHaveLength(1)
    expect(plan.directive).toContain("JANGAN dieksekusi ulang")
  } finally {
    cleanup(dir)
  }
})

test("§24 crash setelah persist (tanpa finalize) → bersih via persistedTurns", async () => {
  const dir = tmpRoot()
  try {
    const r = await intent("s", dir)
    await appendMutationTerminal("s", dir, r.id, r.seq, "write_file", "committed")
    const plan = decideRecovery((await loadJournal("s", dir)).records, [0])
    expect(plan.clean).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("§24 crash setelah finalize → bersih, sweep tak mengubah keputusan", async () => {
  const dir = tmpRoot()
  try {
    const r = await intent("s", dir)
    await appendMutationTerminal("s", dir, r.id, r.seq, "write_file", "committed")
    await finalizeJournal("s", dir)
    const before = decideRecovery((await loadJournal("s", dir)).records, [0])
    expect(before.clean).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("§5/§31 remote committed → wajib baca-balik walau turn durable", async () => {
  const dir = tmpRoot()
  try {
    const r = await appendMutationIntent({
      session: "s",
      tool: "srv.tool",
      cwd: dir,
      remote: true,
      turn: 0,
    })
    await appendMutationTerminal("s", dir, r.id, r.seq, "srv.tool", "committed")
    const plan = decideRecovery((await loadJournal("s", dir)).records, [0])
    expect(plan.clean).toBe(false)
    expect(plan.directive).toContain("baca-balik")
  } finally {
    cleanup(dir)
  }
})

// ── §20 Cleanup: bukti ambigu selamat; yang selesai boleh pergi ──

test("§20 sweep mempertahankan pending ambigu (cleanup ≠ aman-untuk-replay)", async () => {
  const dir = tmpRoot()
  try {
    await intent("s", dir)
    await finalizeJournal("s", dir)
    const swept = await sweepJournal("s", dir)
    void swept
    const { records } = await loadJournal("s", dir)
    expect(records.some((r) => r.state === "pending")).toBe(true)
    expect(decideRecovery(records, []).clean).toBe(false)
  } finally {
    cleanup(dir)
  }
})

test("§20 sweep membuang pasangan intent+terminal yang finalized", async () => {
  const dir = tmpRoot()
  try {
    const r = await intent("s", dir)
    await appendMutationTerminal("s", dir, r.id, r.seq, "write_file", "committed")
    await finalizeJournal("s", dir)
    const { records } = await loadJournal("s", dir)
    // Hanya marker finalize yang tersisa (intent+terminal finalized tersapu).
    expect(records.filter((r) => !r.kind || r.kind === "mutation")).toHaveLength(0)
    expect(records.some((r) => r.kind === "finalize")).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("§8/§20 terminal bukti dedup selamat dari sweep (tripwire P0)", async () => {
  const dir = tmpRoot()
  try {
    const r = await intent("s", dir)
    await appendMutationTerminal(
      "s",
      dir,
      r.id,
      r.seq,
      "write_file",
      "committed",
      {
        note: "req:71:hash",
      },
      undefined,
      { dedup: true },
    )
    await finalizeJournal("s", dir)
    const raw = readFileSync(join(dir, ".minicode", "journal-s.jsonl"), "utf8")
    expect(raw.includes("req:71:hash")).toBe(true)
  } finally {
    cleanup(dir)
  }
})

// ── §19 Directive: dedup, cap, tak bangkit setelah pulih ──

test("§19 directive di-cap + '+N lagi', tiap id sekali", async () => {
  const dir = tmpRoot()
  try {
    for (const s of ["s0", "s1", "s2"]) {
      await appendMutationIntent({ session: s, tool: "bash", cwd: dir, turn: 0 })
    }
    // decideRecovery murni pada array — gabung ketiga file.
    const recs: Awaited<ReturnType<typeof loadJournal>>["records"] = []
    for (const s of ["s0", "s1", "s2"]) recs.push(...(await loadJournal(s, dir)).records)
    const plan = decideRecovery(recs, [], { maxItems: 1 })
    expect(plan.directive).toContain("+2 lagi")
    expect(plan.attention).toHaveLength(3)
  } finally {
    cleanup(dir)
  }
})

test("§19/§34 resolvePending lalu finalize → directive tak bangkit", async () => {
  const dir = tmpRoot()
  try {
    const r = await intent("s", dir)
    expect(decideRecovery((await loadJournal("s", dir)).records, []).clean).toBe(false)
    expect(await resolvePending("s", dir, r.seq, "applied", "cek manual")).toBe(true)
    await finalizeJournal("s", dir)
    const plan = decideRecovery((await loadJournal("s", dir)).records, [0])
    expect(plan.clean).toBe(true)
    expect(plan.directive).toBeNull()
  } finally {
    cleanup(dir)
  }
})

// ── §15 Checkpoint/undo/redo idempoten ──

test("§15 undo dua kali: kedua = no-op aman, bukan error/crash", async () => {
  const dir = tmpRoot()
  // recordCheckpoint memakai path ABSOLUT (kontrak: lihat checkpoint.test.ts).
  const f = join(dir, "f.txt")
  try {
    writeFileSync(f, "v1")
    await recordCheckpoint("u1", 1, [f], "t1", dir)
    writeFileSync(f, "v2")
    const u1 = await undoLastCheckpoint("u1", dir)
    expect(u1.success).toBe(true)
    expect(readFileSync(f, "utf8")).toBe("v1")
    const u2 = await undoLastCheckpoint("u1", dir)
    expect(u2.success).toBe(false)
    expect(readFileSync(f, "utf8")).toBe("v1")
  } finally {
    cleanup(dir)
  }
})

test("§15 redo dua kali: kedua = no-op aman", async () => {
  const dir = tmpRoot()
  const f = join(dir, "f.txt")
  try {
    writeFileSync(f, "v1")
    await recordCheckpoint("r1", 1, [f], "t1", dir)
    writeFileSync(f, "v2")
    await undoLastCheckpoint("r1", dir)
    const d1 = await redoLastCheckpoint("r1", dir)
    expect(d1.success).toBe(true)
    const d2 = await redoLastCheckpoint("r1", dir)
    expect(d2.success).toBe(false)
  } finally {
    cleanup(dir)
  }
})

test("§15 crash pasca-apply (tanpa marker): undo berikut konvergen", async () => {
  const dir = tmpRoot()
  const f = join(dir, "f.txt")
  try {
    writeFileSync(f, "v1")
    await recordCheckpoint("c1", 1, [f], "t1", dir)
    writeFileSync(f, "v2")
    // Simulasi crash setelah apply files tetapi sebelum marker+save:
    // file sudah kembali, pointer masih basi (0).
    writeFileSync(f, "v1")
    expect((await loadCheckpointManifest("c1", dir)).currentIndex).toBe(0)
    // Undo berikut menulis ulang konten sama (idempoten) + marker + pointer.
    const u = await undoLastCheckpoint("c1", dir)
    expect(u.success).toBe(true)
    expect(readFileSync(f, "utf8")).toBe("v1")
    expect((await loadCheckpointManifest("c1", dir)).currentIndex).toBe(-1)
  } finally {
    cleanup(dir)
  }
})

test("§15 reconcile idempoten + marker basi diabaikan", async () => {
  const dir = tmpRoot()
  const f = join(dir, "f.txt")
  try {
    writeFileSync(f, "v1")
    await recordCheckpoint("m1", 1, [f], "t1", dir)
    // Marker invalid: indeks di luar batas.
    await appendUndoMarker("m1", dir, "undo", 1, { newIndex: 77, files: 1 })
    expect(await reconcileUndoRedoPointer("m1", dir)).toBeNull()
    expect((await loadCheckpointManifest("m1", dir)).currentIndex).toBe(0)
    // Marker turn tak cocok (termasuk newIndex -1 — audit #08 §15).
    await appendUndoMarker("m1", dir, "undo", 999, { newIndex: -1, files: 1 })
    expect(await reconcileUndoRedoPointer("m1", dir)).toBeNull()
    expect((await loadCheckpointManifest("m1", dir)).currentIndex).toBe(0)
  } finally {
    cleanup(dir)
  }
})

// ── §16/§28 Resume idempoten ──

test("§28 resume ×3: state sama + keputusan sama, tanpa efek ganda", async () => {
  const dir = tmpRoot()
  try {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "halo" },
    ]
    await saveSession("rs", dir, undefined, msgs, { cost: 1 })
    const first = loadSession("rs", dir)
    const d1 = await planRecoveryForSession("rs", dir, {
      persistedTurns: listPersistedTurns("rs", dir),
    })
    for (let i = 0; i < 2; i++) {
      const again = loadSession("rs", dir)
      expect(again?.messages.length).toBe(first?.messages.length)
      expect(again?.turnCount).toBe(first?.turnCount)
      const d = await planRecoveryForSession("rs", dir, {
        persistedTurns: listPersistedTurns("rs", dir),
      })
      expect(d.directive).toBe(d1.directive)
      expect(d.clean).toBe(d1.clean)
    }
    expect(d1.clean).toBe(true)
  } finally {
    cleanup(dir)
  }
})

// ── §7/§30 Provider retry: eksekusi tool tetap exactly-once ──

test("§7 stream putus setelah tool_call parsial → retry: tool jalan TEPAT sekali", async () => {
  const dir = tmpRoot()
  try {
    const { createMinicodeSession } = await import("../src/app/session.ts")
    let attempt = 0
    let execCount = 0
    const flaky = {
      id: "flaky",
      models: ["m"],
      async *stream() {
        attempt++
        if (attempt === 1) {
          // Respons parsial lalu koneksi mati SEBELUM finish: tool_call
          // paruhan ini WAJIB dibuang, bukan dieksekusi.
          yield { type: "tool_call", id: "c1", name: "hitung", args: {} }
          throw new Error("putus di tengah stream")
        }
        if (attempt === 2) {
          yield { type: "tool_call", id: "c2", name: "hitung", args: {} }
          yield { type: "finish", reason: "tool_calls" }
          return
        }
        yield { type: "text", text: "selesai" }
        yield { type: "finish", reason: "stop" }
      },
    }
    const hitung = {
      name: "hitung",
      description: "t",
      parameters: { type: "object", properties: {} },
      async execute() {
        execCount++
        return "ok"
      },
    }
    const s = await createMinicodeSession({
      provider: flaky as never,
      tools: [hitung as never],
      permissionMode: "allow-all",
      cwd: dir,
    })
    await s.run("mulai")
    // Satu retry terjadi (respons paruhan dibuang), lalu turn lanjut normal.
    expect(attempt).toBeGreaterThanOrEqual(2)
    // Inti §7: tool_call paruhan attempt-1 TAK PERNAH dieksekusi; hanya
    // panggilan utuh attempt-2 yang jalan — tepat sekali.
    expect(execCount).toBe(1)
  } finally {
    cleanup(dir)
  }
})

// ── §9 Delegate: parent retry mendeteksi anak committed ──

test("§9 delegasi pending → attention (blokir, bukan redo buta)", async () => {
  const dir = tmpRoot()
  try {
    await appendMutationIntent({
      session: "p",
      tool: "delegate_task",
      cwd: dir,
      childSessionId: "sub_aaa",
      turn: 0,
    })
    const plan = await planRecoveryForSession("p", dir, { persistedTurns: [] })
    expect(plan.clean).toBe(false)
    expect(plan.directive).toContain("DILARANG redo buta")
  } finally {
    cleanup(dir)
  }
})

test("§9 delegasi committed + finalized + anak committed → bersih", async () => {
  const dir = tmpRoot()
  try {
    const p = await appendMutationIntent({
      session: "p",
      tool: "delegate_task",
      cwd: dir,
      childSessionId: "sub_bbb",
      turn: 0,
    })
    await appendMutationTerminal(
      "p",
      dir,
      p.id,
      p.seq,
      "delegate_task",
      "committed",
      undefined,
      "sub_bbb",
    )
    await finalizeJournal("p", dir)
    const c = await appendMutationIntent({
      session: "sub_bbb",
      childOf: "p",
      tool: "write_file",
      cwd: dir,
      paths: ["k.txt"],
      turn: 0,
    })
    await appendMutationTerminal("sub_bbb", dir, c.id, c.seq, "write_file", "committed")
    const plan = await planRecoveryForSession("p", dir, { persistedTurns: [] })
    expect(plan.clean).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("§9 anak hilang padahal delegasi committed → degraded eksplisit", async () => {
  const dir = tmpRoot()
  try {
    const p = await appendMutationIntent({
      session: "p",
      tool: "delegate_task",
      cwd: dir,
      childSessionId: "sub_hilang",
      turn: 0,
    })
    await appendMutationTerminal(
      "p",
      dir,
      p.id,
      p.seq,
      "delegate_task",
      "committed",
      undefined,
      "sub_hilang",
    )
    const plan = await planRecoveryForSession("p", dir, { persistedTurns: [] })
    expect(plan.directive ?? "").toContain("BUKTI TAK-LENGKAP")
  } finally {
    cleanup(dir)
  }
})

// ── §22 Cross-session: identitas tak bocor antar sesi ──

test("§22 record sesi A tak memengaruhi keputusan sesi B", async () => {
  const dir = tmpRoot()
  try {
    await intent("A", dir)
    const planB = decideRecovery((await loadJournal("B", dir)).records, [])
    expect(planB.clean).toBe(true)
    const planA = decideRecovery((await loadJournal("A", dir)).records, [])
    expect(planA.clean).toBe(false)
  } finally {
    cleanup(dir)
  }
})

// ── §27 Duplicate/late events: arah aman ──

function fakeBus() {
  const handlers = new Map<string, ((e: never) => void)[]>()
  return {
    on(type: string, h: (e: never) => void) {
      const l = handlers.get(type) ?? []
      l.push(h)
      handlers.set(type, l)
    },
    emit(type: string, e: never) {
      for (const h of handlers.get(type) ?? []) h(e)
    },
  }
}

function startedEvent(id: string, tool = "write_file", args: unknown = { path: "f.txt" }) {
  return { execution: { call: { id, name: tool, args } } } as never
}

function completedEvent(id: string, tool = "write_file", isError = false) {
  return {
    execution: { call: { id, name: tool, args: { path: "f.txt" } }, result: { isError } },
  } as never
}

test("§27 completed ganda: terminal tunggal, kedua dibuang", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal({ events: bus, state: { turnCount: 0 } } as never, {
      sessionId: "dup",
      cwd: dir,
    })
    bus.emit("execution:started", startedEvent("k1"))
    await new Promise((r) => setTimeout(r, 200))
    bus.emit("execution:completed", completedEvent("k1", "write_file", false))
    bus.emit("execution:completed", completedEvent("k1", "write_file", true))
    await new Promise((r) => setTimeout(r, 300))
    const { records } = await loadJournal("dup", dir)
    const terms = records.filter((r) => r.state === "committed" || r.state === "failed")
    expect(terms).toHaveLength(1)
    expect(terms[0]!.state).toBe("committed")
  } finally {
    cleanup(dir)
  }
})

test("§27 started ganda + satu completed: sisa pending (ambigu aman)", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    attachMutationJournal({ events: bus, state: { turnCount: 0 } } as never, {
      sessionId: "dup2",
      cwd: dir,
    })
    bus.emit("execution:started", startedEvent("k2"))
    bus.emit("execution:started", startedEvent("k2"))
    await new Promise((r) => setTimeout(r, 500))
    bus.emit("execution:completed", completedEvent("k2", "write_file", false))
    await new Promise((r) => setTimeout(r, 800))
    const { records } = await loadJournal("dup2", dir)
    const terms = records.filter((r) => r.state === "committed" || r.state === "failed")
    const pends = records.filter((r) => r.state === "pending")
    expect(terms).toHaveLength(1)
    // Kedua record intent tak terhapus (riwayat append-only); satu tanpa
    // pasangan = pending. False-ambiguous, bukan false-safe.
    expect(pends).toHaveLength(2)
    expect(decideRecovery(records, []).clean).toBe(false)
  } finally {
    cleanup(dir)
  }
})
