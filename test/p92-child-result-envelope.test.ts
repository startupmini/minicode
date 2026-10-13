// P9.2.1 — Amplop hasil anak delegasi (delegate child result envelope).
//
// Kontrak yang dipin: tiap terminal receipt `delegate_task` membawa observasi
// bounded + sanitasi tentang turn anak (status, ringkasan, run, langkah) di
// dalam record receipt yang SUDAH ADA — tanpa tabel baru, tanpa otoritas
// baru, tanpa mengubah string parent, state receipt, Run-terminalisasi,
// scheduler, atau histori kanonik. Batasan: ADR-25 (dua kontrak admission)
// dan R1 (backend dormant) tak tersentuh batch ini.
//
// Konvensi: batas produksi nyata (delegateTaskTool.execute + factory
// perekam + jurnal/DB asli di tmpdir), bukan mock payload. Satu parent per
// test agar jurnal terisolasi.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentError } from "#minicore/core/errors.ts"
import {
  appendFinalize,
  type ChildResultEnvelope,
  type JournalRecord,
  journalPath,
  loadJournal,
  sweepJournal,
} from "../src/session/journal.ts"
import { DEFAULT_THREAD_ID, listSessionRuns, loadSession } from "../src/session/persistence.ts"
import {
  buildChildResultEnvelope,
  CHILD_RESULT_SUMMARY_MAX,
  childStatusOutcomeFlags,
  classifyChildStatus,
  persistEffectIntent,
  persistEffectReceipt,
} from "../src/session/verification.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p92-"))
  dirs.push(d)
  return d
}
afterAll(async () => {
  clearSubAgentSessionFactory()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

/** Provider fallback agar getProvider() jalan tanpa config (pola delegate-audit). */
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

const ctxFor = (cwd: string, permissionMode = "auto", signal?: AbortSignal) =>
  ({
    signal: signal ?? new AbortController().signal,
    emit: () => {},
    cwd,
    permissionMode,
  }) as never

type RunFn = () => Promise<{ finalText?: string; usage: { steps: number } }>

/** Factory perekam: menangkap spec anak, menghitung pemanggilan run. */
function recordingFactory(seen: SubAgentSpec[], probe: { calls: number }, runImpl: RunFn) {
  return async (spec: SubAgentSpec) => {
    seen.push(spec)
    return {
      events: { on: () => () => {} },
      run: async () => {
        probe.calls++
        return runImpl()
      },
    }
  }
}

interface AttemptResult {
  out: string | null
  thrown: unknown
  spec: SubAgentSpec | null
  runCalls: number
}

/** Satu percobaan delegasi lewat batas produksi nyata. */
async function delegateAttempt(opts: {
  dir: string
  parentId: string
  args?: Record<string, unknown>
  runImpl?: RunFn
  withFactory?: boolean
  factoryThrows?: unknown
  signal?: AbortSignal
}): Promise<AttemptResult> {
  const prevTodo = todoSession.id
  todoSession.id = opts.parentId
  const seen: SubAgentSpec[] = []
  const probe = { calls: 0 }
  try {
    if (opts.withFactory === false) {
      clearSubAgentSessionFactory()
    } else if (opts.factoryThrows !== undefined) {
      const err = opts.factoryThrows
      setSubAgentSessionFactory(async () => {
        throw err
      })
    } else {
      setSubAgentSessionFactory(
        recordingFactory(
          seen,
          probe,
          opts.runImpl ?? (async () => ({ finalText: "ringkasan anak", usage: { steps: 2 } })),
        ),
      )
    }
    const out = (await delegateTaskTool.execute(
      (opts.args ?? { prompt: "kerjakan" }) as never,
      ctxFor(opts.dir, "auto", opts.signal),
    )) as string
    return { out, thrown: null, spec: seen[0] ?? null, runCalls: probe.calls }
  } catch (e) {
    return { out: null, thrown: e, spec: seen[0] ?? null, runCalls: probe.calls }
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
  }
}

/** Terminal receipt delegasi tunggal di jurnal parent (satu parent per test). */
async function delegateTerminal(parentId: string, dir: string): Promise<JournalRecord> {
  const { records } = await loadJournal(parentId, dir)
  const terms = records.filter(
    (r) => r.tool === "delegate_task" && (r.state === "committed" || r.state === "failed"),
  )
  expect(terms).toHaveLength(1)
  return terms[0]!
}

function envelopeOf(rec: JournalRecord): ChildResultEnvelope {
  const env = rec.outcome?.childResult
  expect(env).toBeDefined()
  return env!
}

// ── A. Round-trip amplop ───────────────────────────────────────────────────
test("A1 round-trip: receipt terminal memuat amplop dengan identitas benar", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const r = await delegateAttempt({ dir, parentId: "p92-a1" })
    expect(r.thrown).toBeNull()
    // String parent byte-identik dengan sebelum amplop ada.
    expect(r.out).toBe("sub-agent (explore) done: ringkasan anak [steps 2]")
    const term = await delegateTerminal("p92-a1", dir)
    // State receipt + identitas lama tak berubah.
    expect(term.state).toBe("committed")
    expect(term.tool).toBe("delegate_task")
    expect(term.session).toBe("p92-a1")
    const childId = r.spec!.journal!.sessionId
    expect(term.childSessionId).toBe(childId)
    expect(term.outcome?.note).toBe(childId)
    // Amplop: status, ringkasan persis string parent, langkah, run.
    const env = envelopeOf(term)
    expect(env.childStatus).toBe("returned")
    expect(env.resultSummary).toBe(r.out!)
    expect(env.truncated).toBe(false)
    expect(env.steps).toBe(2)
    const runs = listSessionRuns(childId, dir)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe("COMPLETED")
    expect(env.runId).toBe(runs[0]!.run_id)
  } finally {
    restore()
  }
})

// ── B. Matriks klasifikasi status ──────────────────────────────────────────
// Tiap kasus: childStatus jujur + state receipt + Run-terminalisasi + string
// parent persis seperti sebelum amplop (tak ada perilaku berubah).
test("B1 timeout terstruktur → timeout, receipt committed, Run COMPLETED", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const r = await delegateAttempt({
      dir,
      parentId: "p92-b1",
      runImpl: async () => {
        throw new AgentError("timeout", "child turn timed out")
      },
    })
    expect(r.thrown).toBeNull()
    expect(r.runCalls).toBe(1)
    expect(r.out).toBe("[sub-agent explore error] child turn timed out")
    const term = await delegateTerminal("p92-b1", dir)
    expect(term.state).toBe("committed")
    const env = envelopeOf(term)
    expect(env.childStatus).toBe("timeout")
    expect(env.resultSummary).toBe(r.out!)
    expect(env.truncated).toBe(false)
    expect(env.steps).toBeNull()
    expect(term.outcome?.timeout).toBe(true)
    const childId = r.spec!.journal!.sessionId
    expect(env.runId).toBe(listSessionRuns(childId, dir)[0]!.run_id)
    expect(listSessionRuns(childId, dir)[0]!.status).toBe("COMPLETED")
  } finally {
    restore()
  }
})

test("B2 abort terstruktur → aborted, receipt committed, Run COMPLETED", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const r = await delegateAttempt({
      dir,
      parentId: "p92-b2",
      runImpl: async () => {
        throw new AgentError("aborted", "turn aborted by operator")
      },
    })
    expect(r.thrown).toBeNull()
    expect(r.out).toBe("[sub-agent explore error] turn aborted by operator")
    const term = await delegateTerminal("p92-b2", dir)
    expect(term.state).toBe("committed")
    const env = envelopeOf(term)
    expect(env.childStatus).toBe("aborted")
    expect(env.resultSummary).toBe(r.out!)
    expect(term.outcome?.aborted).toBe(true)
    expect(term.outcome?.timeout).toBeUndefined()
    const childId = r.spec!.journal!.sessionId
    expect(listSessionRuns(childId, dir)[0]!.status).toBe("COMPLETED")
  } finally {
    restore()
  }
})

test("B3 max-step terstruktur → max_steps_exceeded, tanpa flag timeout/abort", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const r = await delegateAttempt({
      dir,
      parentId: "p92-b3",
      runImpl: async () => {
        throw new AgentError("max_steps_exceeded", "turn max steps exceeded")
      },
    })
    expect(r.thrown).toBeNull()
    expect(r.out).toBe("[sub-agent explore error] turn max steps exceeded")
    const term = await delegateTerminal("p92-b3", dir)
    expect(term.state).toBe("committed")
    const env = envelopeOf(term)
    expect(env.childStatus).toBe("max_steps_exceeded")
    expect(term.outcome?.timeout).toBeUndefined()
    expect(term.outcome?.aborted).toBeUndefined()
    const childId = r.spec!.journal!.sessionId
    expect(listSessionRuns(childId, dir)[0]!.status).toBe("COMPLETED")
  } finally {
    restore()
  }
})

test("B4 error lain (termasuk kind tak-terpetakan) → error konservatif", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    // budget_exceeded terstruktur tapi tak ada di tabel status: JANGAN tebak
    // dari maknanya — catat `error` (terlihat gagal, sebab tak terpetakan).
    const r = await delegateAttempt({
      dir,
      parentId: "p92-b4",
      runImpl: async () => {
        throw new AgentError("budget_exceeded", "turn over budget")
      },
    })
    expect(r.thrown).toBeNull()
    expect(r.out).toBe("[sub-agent explore error] turn over budget")
    const term = await delegateTerminal("p92-b4", dir)
    expect(term.state).toBe("committed")
    expect(envelopeOf(term).childStatus).toBe("error")
    // Error non-struktur juga `error`, bukan tebakan dari wording pesan —
    // walau pesannya mengandung kata "timeout", tanpa kind = error.
    const r2 = await delegateAttempt({
      dir,
      parentId: "p92-b4b",
      runImpl: async () => {
        throw new Error("timeout while reading upstream")
      },
    })
    expect(r2.thrown).toBeNull()
    const term2 = await delegateTerminal("p92-b4b", dir)
    expect(envelopeOf(term2).childStatus).toBe("error")
    expect(term2.outcome?.timeout).toBeUndefined()
  } finally {
    restore()
  }
})

test("B5 factory hilang → failed_to_start, receipt failed, Run INTERRUPTED", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const r = await delegateAttempt({ dir, parentId: "p92-b5", withFactory: false })
    expect(r.thrown).toBeNull()
    expect(r.runCalls).toBe(0)
    expect(r.out).toBe("[sub-agent error] session factory not configured")
    const term = await delegateTerminal("p92-b5", dir)
    expect(term.state).toBe("failed")
    const env = envelopeOf(term)
    expect(env.childStatus).toBe("failed_to_start")
    expect(env.resultSummary).toBe(r.out!)
    expect(env.steps).toBeNull()
    // `terminal` dibalik ke failed tepat setelah pool kembali (childRan
    // false) sehingga cabang failRun tak terjangkau di jalur ini — Run
    // ditutup INTERRUPTED seperti dulu (perilaku lama, bukan pilihan batch
    // ini; lihat finally di delegateTaskTool.execute).
    const childRuns = listSessionRuns(term.childSessionId!, dir)
    expect(childRuns).toHaveLength(1)
    expect(childRuns[0]!.status).toBe("INTERRUPTED")
    expect(env.runId).toBe(childRuns[0]!.run_id)
  } finally {
    restore()
  }
})

test("B6 factory lempar → failed_to_start, Run INTERRUPTED, execute menolak", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const r = await delegateAttempt({
      dir,
      parentId: "p92-b6",
      factoryThrows: new Error("factory exploded"),
    })
    // Jalur luar melempar ulang seperti dulu (tanpa string parent).
    expect(r.thrown).not.toBeNull()
    expect(r.runCalls).toBe(0)
    const term = await delegateTerminal("p92-b6", dir)
    expect(term.state).toBe("failed")
    const env = envelopeOf(term)
    expect(env.childStatus).toBe("failed_to_start")
    expect(env.steps).toBeNull()
    const childRuns = listSessionRuns(term.childSessionId!, dir)
    expect(childRuns).toHaveLength(1)
    expect(childRuns[0]!.status).toBe("INTERRUPTED")
    expect(env.runId).toBe(childRuns[0]!.run_id)
  } finally {
    restore()
  }
})

test("B7 pool dibatalkan sebelum jalan → failed_to_start, tanpa percobaan", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const controller = new AbortController()
    controller.abort()
    const r = await delegateAttempt({
      dir,
      parentId: "p92-b7",
      signal: controller.signal,
    })
    expect(r.thrown).not.toBeNull()
    // Factory tak pernah dipanggil: nol percobaan, apalagi dua (tanpa retry).
    expect(r.spec).toBeNull()
    expect(r.runCalls).toBe(0)
    const term = await delegateTerminal("p92-b7", dir)
    expect(term.state).toBe("failed")
    expect(envelopeOf(term).childStatus).toBe("failed_to_start")
    const childRuns = listSessionRuns(term.childSessionId!, dir)
    expect(childRuns).toHaveLength(1)
    expect(childRuns[0]!.status).toBe("INTERRUPTED")
  } finally {
    restore()
  }
})

// ── C. Batas + sanitasi ────────────────────────────────────────────────────
test("C1 teks panjang dipotong 2000 unit kode + truncated akurat", async () => {
  expect(CHILD_RESULT_SUMMARY_MAX).toBe(2_000)
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const big = "y".repeat(5_000)
    const r = await delegateAttempt({
      dir,
      parentId: "p92-c1",
      runImpl: async () => ({ finalText: big, usage: { steps: 3 } }),
    })
    expect(r.thrown).toBeNull()
    const term = await delegateTerminal("p92-c1", dir)
    const env = envelopeOf(term)
    // Batas dalam unit kode UTF-16 (length/slice JS): tak lebih dari 2000.
    expect(env.resultSummary.length).toBeLessThanOrEqual(2_000)
    expect(env.truncated).toBe(true)
    // Fixture tanpa secret: sanitasi identitas → sama dengan potongan parent.
    expect(env.resultSummary).toBe(r.out!.slice(0, 2_000))
    expect(env.steps).toBe(3)
    expect(term.outcome?.truncated).toBe(true)
  } finally {
    restore()
  }
})

test("C2 ringkasan error pendek tetap pendek + truncated salah", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const r = await delegateAttempt({
      dir,
      parentId: "p92-c2",
      runImpl: async () => {
        throw new Error("boom")
      },
    })
    expect(r.thrown).toBeNull()
    expect(r.out).toBe("[sub-agent explore error] boom")
    const env = envelopeOf(await delegateTerminal("p92-c2", dir))
    expect(env.resultSummary).toBe(r.out!)
    expect(env.resultSummary.length).toBeLessThan(2_000)
    expect(env.truncated).toBe(false)
  } finally {
    restore()
  }
})

test("C3 secret disanitasi di amplop, string parent tak berubah", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const secret1 = "hunter2-secret-value"
    const secret2 = "sk-test-abc123def456"
    const r = await delegateAttempt({
      dir,
      parentId: "p92-c3",
      runImpl: async () => ({
        finalText: `db password: ${secret1} token OPENAI_API_KEY=${secret2} end`,
        usage: { steps: 1 },
      }),
    })
    expect(r.thrown).toBeNull()
    // Parent melihat mentah (perilaku lama).
    expect(r.out).toContain(secret1)
    expect(r.out).toContain(secret2)
    // Amplop memakai primitif mapan (scrubSecrets, sama seperti ack): bocor
    // tidak, redaksi terlihat.
    const env = envelopeOf(await delegateTerminal("p92-c3", dir))
    expect(env.resultSummary).not.toContain(secret1)
    expect(env.resultSummary).not.toContain(secret2)
    expect(env.resultSummary).toContain("[REDACTED]")
    expect(env.truncated).toBe(false)
  } finally {
    restore()
  }
})

test("C4 hasil raksasa tak lolos batas; alur cleanup tetap jalan", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const r = await delegateAttempt({
      dir,
      parentId: "p92-c4",
      runImpl: async () => ({ finalText: "z".repeat(1_000_000), usage: { steps: 4 } }),
    })
    expect(r.thrown).toBeNull()
    const env = envelopeOf(await delegateTerminal("p92-c4", dir))
    expect(env.resultSummary.length).toBeLessThanOrEqual(2_000)
    expect(env.truncated).toBe(true)
    // Cleanup (tutup Run + lepas lease) tetap jalan: delegasi berikut di
    // dir yang sama tak terhalang lease anak sebelumnya.
    const r2 = await delegateAttempt({ dir, parentId: "p92-c4b" })
    expect(r2.thrown).toBeNull()
    expect(r2.out).toContain("ringkasan anak")
  } finally {
    restore()
  }
})

test("C5 tak ada transkrip penuh di record terminal", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    await delegateAttempt({
      dir,
      parentId: "p92-c5",
      runImpl: async () => ({ finalText: "w".repeat(5_000), usage: { steps: 1 } }),
    })
    const term = await delegateTerminal("p92-c5", dir)
    // Record terminal bounded: ringkasan ≤2000 + metadata kecil, bukan gema
    // 5000 char teks anak di field mana pun.
    const serialized = JSON.stringify(term)
    expect(serialized.length).toBeLessThan(20_000)
    expect(serialized).not.toContain("w".repeat(5_000))
  } finally {
    restore()
  }
})

// ── D. Duplikat + tanpa-retry ──────────────────────────────────────────────
test("D1 terminal kedua tetap ditolak; amplop tak membuka publikasi ganda", async () => {
  const dir = tmpRoot()
  const parent = "p92-d1"
  try {
    const intent = await persistEffectIntent({
      sessionId: parent,
      threadId: DEFAULT_THREAD_ID,
      tool: "delegate_task",
      cwd: dir,
      childSessionId: "sub_dup",
      args: { prompt: "x", mode: "explore" },
      specialPath: "delegate-task",
    })
    expect(intent.durable).toBe(true)
    const receiptBase = {
      sessionId: parent,
      threadId: DEFAULT_THREAD_ID,
      tool: "delegate_task",
      cwd: dir,
      invocation: intent.invocation,
      intent: {
        id: intent.record.id,
        seq: intent.record.seq,
        tool: intent.record.tool,
        session: intent.record.session,
      },
      childSessionId: "sub_dup",
      specialPath: "delegate-task" as const,
    } as const
    const first = await persistEffectReceipt({
      ...receiptBase,
      state: "committed",
      outcome: {
        note: "sub_dup",
        childResult: buildChildResultEnvelope({
          childStatus: "returned",
          summary: "ringkasan",
          runId: null,
          steps: 1,
        }),
      },
    })
    expect(first.durable).toBe(true)
    // Terminal kedua (dengan amplop berbeda sekalipun) = duplikat → tolak.
    let threw: unknown = null
    try {
      await persistEffectReceipt({
        ...receiptBase,
        state: "committed",
        outcome: {
          note: "sub_dup",
          childResult: buildChildResultEnvelope({
            childStatus: "returned",
            summary: "ringkasan lain",
            runId: null,
            steps: 2,
          }),
        },
      })
    } catch (e) {
      threw = e
    }
    expect(String((threw as Error)?.message ?? threw)).toMatch(/duplicate terminal/)
    // Hanya satu terminal untuk intent ini; amplop pertama utuh.
    const { records } = await loadJournal(parent, dir)
    const terms = records.filter(
      (r) => r.tool === "delegate_task" && (r.state === "committed" || r.state === "failed"),
    )
    expect(terms).toHaveLength(1)
    expect(terms[0]!.outcome?.childResult).toEqual({
      childStatus: "returned",
      resultSummary: "ringkasan",
      runId: null,
      steps: 1,
      truncated: false,
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test("D2 hasil tak-pasti tak dijalankan ulang: tepat satu percobaan", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    // Batal sebelum pool: nol pemanggilan factory/run (B7) — dan tak ada
    // upaya kedua yang tercatat di jurnal (satu intent + satu terminal).
    const controller = new AbortController()
    controller.abort()
    const r = await delegateAttempt({ dir, parentId: "p92-d2", signal: controller.signal })
    expect(r.thrown).not.toBeNull()
    expect(r.runCalls).toBe(0)
    const { records } = await loadJournal("p92-d2", dir)
    const ours = records.filter((rr) => rr.tool === "delegate_task")
    expect(ours.filter((rr) => rr.state === "pending")).toHaveLength(1)
    expect(ours.filter((rr) => rr.state === "failed")).toHaveLength(1)
    // Kosakata state tetap biner committed/failed — amplop tak memperkenalkan
    // status task/bisnis baru ke jurnal.
    for (const rr of ours) expect(["pending", "committed", "failed"]).toContain(rr.state!)
  } finally {
    restore()
  }
})

// ── E. Sweep + durability ──────────────────────────────────────────────────
test("E1 amplop selamat dari finalize+sweep (jalur dedup terminal)", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const r = await delegateAttempt({ dir, parentId: "p92-e1" })
    expect(r.thrown).toBeNull()
    const before = await delegateTerminal("p92-e1", dir)
    const envBefore = envelopeOf(before)
    // Finalize sampai seq terminal, lalu sweep seperti siklus hidup nyata.
    await appendFinalize("p92-e1", dir, before.seq)
    await sweepJournal("p92-e1", dir)
    const after = await delegateTerminal("p92-e1", dir)
    expect(after.id).toBe(before.id)
    expect(after.outcome?.childResult).toEqual(envBefore)
  } finally {
    restore()
  }
})

test("E2 membaca tak menulis ulang: dua bacaan identik", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    await delegateAttempt({ dir, parentId: "p92-e2" })
    const first = JSON.stringify((await loadJournal("p92-e2", dir)).records)
    const second = JSON.stringify((await loadJournal("p92-e2", dir)).records)
    expect(second).toBe(first)
  } finally {
    restore()
  }
})

test("E3 deteksi korupsi tak dilemahkan amplop", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    await delegateAttempt({ dir, parentId: "p92-e3" })
    const path = journalPath("p92-e3", dir)
    const raw = await Bun.file(path).text()
    await Bun.write(path, `${raw}\n{corrupt-json\n`)
    const loaded = await loadJournal("p92-e3", dir)
    // Pembaca tetap melaporkan korup (bukan valid) — amplop tak menutupinya.
    expect(loaded.status).not.toBe("valid")
  } finally {
    restore()
  }
})

// ── F. Isolasi histori kanonik ─────────────────────────────────────────────
test("F1 histori messages parent+anak kosong; bukti hidup di jurnal", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    expect(loadSession("p92-f1", dir)).toBeNull()
    const r = await delegateAttempt({ dir, parentId: "p92-f1" })
    expect(r.thrown).toBeNull()
    const childId = r.spec!.journal!.sessionId
    // Delegasi penuh (intent+terminal+amplop) tanpa satu baris messages.
    expect(loadSession("p92-f1", dir)?.messages.length ?? 0).toBe(0)
    expect(loadSession(childId, dir)?.messages.length ?? 0).toBe(0)
    const term = await delegateTerminal("p92-f1", dir)
    expect(envelopeOf(term).childStatus).toBe("returned")
  } finally {
    restore()
  }
})

// ── Unit helper (tanpa IO) ─────────────────────────────────────────────────
test("U1 classifyChildStatus: kind terstruktur jujur, sisanya error", () => {
  expect(classifyChildStatus(new AgentError("timeout", "t"))).toBe("timeout")
  expect(classifyChildStatus(new AgentError("aborted", "a"))).toBe("aborted")
  expect(classifyChildStatus(new AgentError("max_steps_exceeded", "m"))).toBe("max_steps_exceeded")
  // Kind dikenal tapi tak ada di tabel status → error (jangan ditebak).
  expect(classifyChildStatus(new AgentError("budget_exceeded", "b"))).toBe("error")
  expect(classifyChildStatus(new AgentError("busy", "b"))).toBe("error")
  expect(classifyChildStatus(new AgentError("provider", "p"))).toBe("error")
  // Tanpa kind (duck-type dengan kind pun dihormati).
  expect(classifyChildStatus({ kind: "timeout" })).toBe("timeout")
  expect(classifyChildStatus(new Error("timeout while reading"))).toBe("error")
  expect(classifyChildStatus("timeout")).toBe("error")
  expect(classifyChildStatus(null)).toBe("error")
  expect(classifyChildStatus(undefined)).toBe("error")
})

test("U2 buildChildResultEnvelope: batas, flag, null jujur", () => {
  const exact = "q".repeat(2_000)
  const over = "q".repeat(2_001)
  expect(
    buildChildResultEnvelope({ childStatus: "returned", summary: exact, runId: "r", steps: 0 }),
  ).toEqual({
    childStatus: "returned",
    resultSummary: exact,
    runId: "r",
    steps: 0,
    truncated: false,
  })
  const cut = buildChildResultEnvelope({
    childStatus: "returned",
    summary: over,
    runId: null,
    steps: null,
  })
  expect(cut.resultSummary.length).toBe(2_000)
  expect(cut.truncated).toBe(true)
  expect(cut.runId).toBeNull()
  // Langkah non-finite/tipe-salah → null (jangan difabrikasi).
  expect(
    buildChildResultEnvelope({ childStatus: "error", summary: "x", runId: null, steps: NaN }).steps,
  ).toBeNull()
  expect(
    buildChildResultEnvelope({
      childStatus: "error",
      summary: "x",
      runId: null,
      steps: "3" as never,
    }).steps,
  ).toBeNull()
})

test("U3 childStatusOutcomeFlags: hanya timeout/aborted", () => {
  expect(childStatusOutcomeFlags("timeout")).toEqual({ timeout: true })
  expect(childStatusOutcomeFlags("aborted")).toEqual({ aborted: true })
  expect(childStatusOutcomeFlags("returned")).toEqual({})
  expect(childStatusOutcomeFlags("error")).toEqual({})
  expect(childStatusOutcomeFlags("max_steps_exceeded")).toEqual({})
  expect(childStatusOutcomeFlags("failed_to_start")).toEqual({})
})
