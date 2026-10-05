// P2.9 FINAL FORENSIC REMEDIATION — kanonisasi Sub-Agent TANPA degradasi.
//
// Invarian yang dibuktikan (§16 matriks A–N):
//   A/N  delegate_task → sesi anak kanonik + Thread + Run dalam SATU file DB
//   B    baris parent hilang → dimaterialisasikan, anak tetap kanonik
//   C    cwd dengan .minicode (lokal) → anak di DB lokal itu
//   D    cwd TANPA .minicode (jatuh global) → pin menstabilkan ke lokal;
//        rumah global tak pernah menerima baris sub_*
//   E    dua saudara konkuren → keduanya kanonik, parent_session_id terisi
//   F    presentation_events anak selamat dari purge (ada baris sessions)
//   G    crash parent → listChildSessions menemukan anak; sweep → INTERRUPTED/UNKNOWN
//   H    parent terminal + anak RUNNING → anak tak tertinggal RUNNING
//   I    parent terminal + anak COMPLETED (konkuren) → anak TAK pernah diturunkan
//   L    sesi legacy tetap bisa membangun anak kanonik
//   M    TIDAK ADA anak P2.9 yang hanya ada di jurnal (sub_ ↔ baris sessions)
//
// Gagal di sini = ada Sub-Agent yang hanya `sub_*` di jurnal tanpa baris
// `sessions` — persis pelanggaran yang dilarang P2.9.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { resolveDbPath, resolveLocalDbPath } from "../src/lib/db-path.ts"
import { acquireSessionWriter } from "../src/session/authority.ts"
import {
  completeRun,
  createChildSession,
  createRun,
  DEFAULT_THREAD_ID,
  getRun,
  listChildSessions,
  listSessionRuns,
  loadSession,
  purgeExpired,
  readWriterEpoch,
  saveSession,
  terminalizeChildRuns,
  tombstoneOrphanChildRuns,
  transitionRun,
} from "../src/session/persistence.ts"
import { resetTaskStoreHandles } from "../src/task/store.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  type SubAgentSpec,
  setSubAgentParentRunId,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

// TaskStore men-cache handle DB di module scope (dipakai acquireSessionWriter);
// tanpa reset, file tasks.db tetap terbuka di Windows dan rm EBUSY.
function cleanup(...dirs: string[]): void {
  try {
    resetTaskStoreHandles()
  } catch {}
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
}

// ── harness (pola delegate-audit) ────────────────────────────────────────────

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

const ctxFor = (cwd: string) =>
  ({ signal: new AbortController().signal, emit: () => {}, cwd, permissionMode: "auto" }) as never

function fakeFactory(seen: SubAgentSpec[]) {
  return async (spec: SubAgentSpec) => {
    seen.push(spec)
    return {
      events: { on: () => () => {} },
      run: async () => ({ finalText: "ringkasan anak", usage: { steps: 2 } }),
    }
  }
}

function ws(withLocal = true): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p29f-"))
  if (withLocal) mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

async function seedParent(cwd: string, sid: string, n = 2): Promise<void> {
  await saveSession(
    sid,
    cwd,
    undefined,
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `p${i}`,
    })),
    { t: 1 },
  )
}

/** Jalankan SATU delegasi dengan parent id yang ditentukan. */
async function delegateOnce(dir: string, parentId: string): Promise<string> {
  const prev = todoSession.id
  todoSession.id = parentId
  const restore = providerEnv()
  try {
    await delegateTaskTool.execute({ prompt: "x" }, ctxFor(dir))
  } finally {
    todoSession.id = prev
    restore()
  }
  const kids = listChildSessions(parentId, dir)
  expect(kids.length).toBe(1)
  return kids[0]!
}

/** Bukti mekanis: sesi+thread+run anak ADA di file DB yang sama. */
function coexists(
  dir: string,
  parentId: string,
  childId: string,
): {
  sessionsChild: number
  threadsChild: number
  runsChild: number
  sessionsParent: number
} {
  const db = new Database(join(dir, ".minicode", "sessions.db"), { readonly: true })
  try {
    const one = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM sessions WHERE id = ?) AS sc,
          (SELECT COUNT(*) FROM threads WHERE session_id = ?) AS tc,
          (SELECT COUNT(*) FROM runs WHERE session_id = ?) AS rc,
          (SELECT COUNT(*) FROM sessions WHERE id = ?) AS sp`,
      )
      .get(childId, childId, childId, parentId) as {
      sc: number
      tc: number
      rc: number
      sp: number
    }
    return {
      sessionsChild: one.sc,
      threadsChild: one.tc,
      runsChild: one.rc,
      sessionsParent: one.sp,
    }
  } finally {
    db.close()
  }
}

function orphanChildEvents(dir: string): number {
  const db = new Database(join(dir, ".minicode", "sessions.db"), { readonly: true })
  try {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM presentation_events WHERE session_id LIKE 'sub_%' AND session_id NOT IN (SELECT id FROM sessions)",
        )
        .get() as { n: number }
    ).n
  } finally {
    db.close()
  }
}

function runningChildren(dir: string, parentId: string): number {
  const db = new Database(join(dir, ".minicode", "sessions.db"), { readonly: true })
  try {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.parent_session_id = ? AND r.status = 'RUNNING'",
        )
        .get(parentId) as { n: number }
    ).n
  } finally {
    db.close()
  }
}

// ── A/N: kanonisasi penuh lewat jalur delegate_task yang sebenarnya ─────────

test("A/N: delegate_task → Session + Thread + Run anak kanonik dalam satu DB", async () => {
  const dir = ws()
  const seen: SubAgentSpec[] = []
  setSubAgentSessionFactory(fakeFactory(seen))
  const restore = providerEnv()
  try {
    await seedParent(dir, "p-a")
    const parentRun = createRun("p-a", DEFAULT_THREAD_ID, dir)
    setSubAgentParentRunId(() => parentRun.run_id)
    const childId = await delegateOnce(dir, "p-a")

    expect(childId.startsWith("sub_")).toBe(true)
    expect(loadSession(childId, dir)).not.toBeNull()

    const link = listChildSessions("p-a", dir)
    expect(link).toEqual([childId])
    const db = new Database(join(dir, ".minicode", "sessions.db"), { readonly: true })
    try {
      const row = db
        .prepare("SELECT parent_session_id, parent_run_id FROM sessions WHERE id = ?")
        .get(childId) as { parent_session_id: string; parent_run_id: string }
      expect(row.parent_session_id).toBe("p-a")
      expect(row.parent_run_id).toBe(parentRun.run_id)
    } finally {
      db.close()
    }

    const rows = coexists(dir, "p-a", childId)
    expect(rows.sessionsChild).toBe(1)
    expect(rows.threadsChild).toBeGreaterThanOrEqual(1)
    expect(rows.runsChild).toBe(1)
    expect(rows.sessionsParent).toBe(1)

    // Run anak milik SESI ANAK, bukan terdaftar di parent.
    const childRuns = listSessionRuns(childId, dir)
    expect(childRuns).toHaveLength(1)
    expect(listSessionRuns("p-a", dir).map((r) => r.run_id)).not.toContain(childRuns[0]!.run_id)
    expect(getRun(childRuns[0]!.run_id, dir)!.session_id).toBe(childId)

    // Epoch anak independen (nilai epoch terbaca dari baris anak sendiri).
    expect(readWriterEpoch(childId, dir)).toBe(0)
    expect(readWriterEpoch("p-a", dir)).toBe(0)

    // Tak ada anak yatim di namespace presentasi.
    expect(orphanChildEvents(dir)).toBe(0)
  } finally {
    setSubAgentParentRunId(() => null)
    clearSubAgentSessionFactory()
    restore()
    cleanup(dir)
  }
})

// ── B: baris parent hilang → MATERIALISASI (bukan degradasi) ────────────────

test("B: parent tak punya baris → dimaterialisasikan, anak TETAP kanonik", async () => {
  const dir = ws()
  const seen: SubAgentSpec[] = []
  setSubAgentSessionFactory(fakeFactory(seen))
  const restore = providerEnv()
  try {
    // Prakondisi: parent memang tak pernah persist.
    expect(loadSession("p-never-persisted", dir)).toBeNull()

    const prevTodo = todoSession.id
    todoSession.id = "p-never-persisted"
    let out: string
    try {
      out = (await delegateTaskTool.execute({ prompt: "x" }, ctxFor(dir))) as unknown as string
    } finally {
      todoSession.id = prevTodo
    }
    // Dulu jalur ini diam-diam jatuh ke jurnal-hantu. Sekarang: kanonik.
    expect(out).not.toContain("REFUSED_CHILD_SESSION_PERSISTENCE")

    const childId = listChildSessions("p-never-persisted", dir)[0]!
    // Parent DIMATERIALISASIKAN (pola saveSession/ensureDefaultThreadInTxn).
    expect(loadSession("p-never-persisted", dir)).not.toBeNull()
    // Anak tetap kanonik, lineage penuh.
    expect(loadSession(childId, dir)).not.toBeNull()
    const rows = coexists(dir, "p-never-persisted", childId)
    expect(rows.sessionsChild).toBe(1)
    expect(rows.threadsChild).toBeGreaterThanOrEqual(1)
    expect(rows.runsChild).toBe(1)
    expect(rows.sessionsParent).toBe(1)
    const db = new Database(join(dir, ".minicode", "sessions.db"), { readonly: true })
    try {
      expect(
        (
          db.prepare("SELECT parent_session_id FROM sessions WHERE id = ?").get(childId) as {
            parent_session_id: string
          }
        ).parent_session_id,
      ).toBe("p-never-persisted")
    } finally {
      db.close()
    }
    expect(orphanChildEvents(dir)).toBe(0)
  } finally {
    clearSubAgentSessionFactory()
    restore()
    cleanup(dir)
  }
})

// ── C: DB lokal sudah ada → anak di DB lokal itu ─────────────────────────────

test("C: cwd dengan .minicode → parent+anak+thread+run di DB lokal itu", async () => {
  const dir = ws(true)
  setSubAgentSessionFactory(fakeFactory([]))
  const restore = providerEnv()
  try {
    await seedParent(dir, "p-local")
    const childId = await delegateOnce(dir, "p-local")
    const local = resolveDbPath("sessions.db", dir)
    expect(local).toBe(join(dir, ".minicode", "sessions.db"))
    const rows = coexists(dir, "p-local", childId)
    expect(rows).toEqual({ sessionsChild: 1, threadsChild: 1, runsChild: 1, sessionsParent: 1 })
  } finally {
    clearSubAgentSessionFactory()
    restore()
    cleanup(dir)
  }
})

// ── D: cwd TANPA .minicode → pin menstabilkan, rumah global tak tersentuh ───

test("D: cwd tanpa .minicode → anak di DB yang sama, rumah global tanpa sub_", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-p29h-"))
  const dir = mkdtempSync(join(tmpdir(), "mc-p29g-")) // TANPA .minicode
  const savedHome = process.env.MINICODE_HOME
  process.env.MINICODE_HOME = home
  setSubAgentSessionFactory(fakeFactory([]))
  const restore = providerEnv()
  try {
    // Prakondisi: tanpa pin, resolusi jatuh ke rumah global.
    expect(existsSync(join(dir, ".minicode"))).toBe(false)
    expect(resolveDbPath("sessions.db", dir)).toBe(join(home, ".minicode", "sessions.db"))

    const childId = await delegateOnce(dir, "p-global")

    // Semua entitas kanonik dalam SATU file (yang di-pin), bukan lintas DB.
    const local = resolveDbPath("sessions.db", dir)
    expect(local).toBe(join(dir, ".minicode", "sessions.db"))
    const rows = coexists(dir, "p-global", childId)
    expect(rows).toEqual({ sessionsChild: 1, threadsChild: 1, runsChild: 1, sessionsParent: 1 })

    // Rumah global TIDAK pernah menerima baris anak.
    const homeDb = join(home, ".minicode", "sessions.db")
    if (existsSync(homeDb)) {
      const db = new Database(homeDb, { readonly: true })
      try {
        expect(
          (
            db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'sub_%'").get() as {
              n: number
            }
          ).n,
        ).toBe(0)
        expect(
          (
            db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get("p-global") as {
              n: number
            }
          ).n,
        ).toBe(0)
      } finally {
        db.close()
      }
    }
  } finally {
    clearSubAgentSessionFactory()
    restore()
    if (savedHome === undefined) delete process.env.MINICODE_HOME
    else process.env.MINICODE_HOME = savedHome
    cleanup(dir)
    cleanup(home)
  }
})

// ── E: dua saudara konkuren → keduanya kanonik ───────────────────────────────

test("E: dua saudara konkuren → keduanya kanonik + parent_session_id", async () => {
  const dir = ws()
  setSubAgentSessionFactory(fakeFactory([]))
  const restore = providerEnv()
  try {
    await seedParent(dir, "p-sib")
    const prev = todoSession.id
    todoSession.id = "p-sib"
    const a = delegateTaskTool.execute({ prompt: "a" }, ctxFor(dir))
    const b = delegateTaskTool.execute({ prompt: "b" }, ctxFor(dir))
    await Promise.all([a, b])
    todoSession.id = prev

    const kids = listChildSessions("p-sib", dir)
    expect(kids).toHaveLength(2)
    expect(new Set(kids).size).toBe(2)
    for (const c of kids) {
      expect(loadSession(c, dir)).not.toBeNull()
      const rows = coexists(dir, "p-sib", c)
      expect(rows).toEqual({ sessionsChild: 1, threadsChild: 1, runsChild: 1, sessionsParent: 1 })
    }
    // Tak ada anak yang tertinggal RUNNING, tak ada yatim presentasi.
    expect(runningChildren(dir, "p-sib")).toBe(0)
    expect(orphanChildEvents(dir)).toBe(0)
  } finally {
    clearSubAgentSessionFactory()
    restore()
    cleanup(dir)
  }
})

// ── F: presentation anak selamat dari purge ─────────────────────────────────

test("F: presentation_events anak selamat purge; yatim sub_* tetap dibersihkan", async () => {
  const dir = ws()
  setSubAgentSessionFactory(fakeFactory([]))
  const restore = providerEnv()
  try {
    const childId = await delegateOnce(dir, "p-purge")
    const db = new Database(join(dir, ".minicode", "sessions.db"))
    try {
      db.prepare(
        "INSERT INTO presentation_events (session_id, event_seq, type, turn_id, ts, payload) VALUES (?, 1, 'notice', 0, ?, '{}')",
      ).run(childId, Date.now())
      // Bukti mekanis §8: setiap event presentasi anak P2.9 punya baris sessions.
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM presentation_events WHERE session_id LIKE 'sub_%' AND session_id NOT IN (SELECT id FROM sessions)",
            )
            .get() as { n: number }
        ).n,
      ).toBe(0)
      purgeExpired(db, Date.now())
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM presentation_events WHERE session_id = ?")
            .get(childId) as { n: number }
        ).n,
      ).toBe(1)
      // Kontrol: event TANPA baris sessions memang dihapus (orphan nyata).
      db.prepare(
        "INSERT INTO presentation_events (session_id, event_seq, type, turn_id, ts, payload) VALUES ('sub_0000000000000000000000000000dead', 1, 'notice', 0, ?, '{}')",
      ).run(Date.now())
      purgeExpired(db, Date.now())
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM presentation_events WHERE session_id LIKE 'sub_%' AND session_id NOT IN (SELECT id FROM sessions)",
            )
            .get() as { n: number }
        ).n,
      ).toBe(0)
    } finally {
      db.close()
    }
  } finally {
    clearSubAgentSessionFactory()
    restore()
    cleanup(dir)
  }
})

// ── G: penemuan orphan setelah crash parent ─────────────────────────────────

test("G: anak RUNNING saat parent crash → ditemukan, lalu tombstoned", async () => {
  const dir = ws()
  try {
    await seedParent(dir, "p-crash")
    // Delegasi terputus: anak kanonik + Run RUNNING, parent tak sempat menutup.
    const childId = listChildSessions("p-crash", dir)
    expect(childId).toEqual([])
    const child = createChildSession({ parentSessionId: "p-crash", cwd: dir })
    transitionRun(child.runId, "RUNNING", dir)

    // §9: pemulihan parent MENEMUKAN anak (bukan hanya jurnal).
    const found = listChildSessions("p-crash", dir)
    expect(found).toEqual([child.sessionId])
    expect(getRun(child.runId, dir)!.status).toBe("RUNNING")

    const swept = tombstoneOrphanChildRuns("p-crash", dir)
    expect(swept).toEqual([child.runId])
    const t = getRun(child.runId, dir)!
    expect(t.status).toBe("INTERRUPTED")
    expect(t.recovery_status).toBe("UNKNOWN")
    expect(runningChildren(dir, "p-crash")).toBe(0)
    // Idempoten.
    expect(tombstoneOrphanChildRuns("p-crash", dir)).toEqual([])
  } finally {
    cleanup(dir)
  }
})

// ── H: parent terminal + anak RUNNING ───────────────────────────────────────

test("H: parent terminal + anak RUNNING → anak ikut terminal, tanpa sisa RUNNING", async () => {
  const dir = ws()
  try {
    await seedParent(dir, "p-term")
    const child = createChildSession({ parentSessionId: "p-term", cwd: dir })
    transitionRun(child.runId, "RUNNING", dir)
    expect(runningChildren(dir, "p-term")).toBe(1)

    terminalizeChildRuns("p-term", dir)
    expect(getRun(child.runId, dir)!.status).toBe("INTERRUPTED")
    // Invarian §11: parent terminal ⇒ TIDAK ADA anak yang tersisa RUNNING.
    expect(runningChildren(dir, "p-term")).toBe(0)
  } finally {
    cleanup(dir)
  }
})

// ── I: parent terminal + anak COMPLETED (konkuren) ───────────────────────────

test("I: anak COMPLETED menang atas terminalisasi parent (tak pernah diturunkan)", async () => {
  const dir = ws()
  try {
    await seedParent(dir, "p-race")
    const child = createChildSession({ parentSessionId: "p-race", cwd: dir })
    transitionRun(child.runId, "RUNNING", dir)

    // Jalur 1: anak selesai DULU → terminalisasi parent tak menyentuhnya.
    completeRun(child.runId, dir)
    terminalizeChildRuns("p-race", dir)
    expect(getRun(child.runId, dir)!.status).toBe("COMPLETED")
    expect(runningChildren(dir, "p-race")).toBe(0)
  } finally {
    cleanup(dir)
  }
})

test("I2: balapan konkuren anak-completed vs parent-terminal → selalu terminal, tak pernah RUNNING", async () => {
  const dir = ws()
  try {
    await seedParent(dir, "p-race2")
    const child = createChildSession({ parentSessionId: "p-race2", cwd: dir })
    transitionRun(child.runId, "RUNNING", dir)

    // Kedua sisi dijalankan konkuren (scheduling diatur runtime).
    let childErr: unknown = null
    await Promise.all([
      (async () => {
        try {
          completeRun(child.runId, dir)
        } catch (e) {
          childErr = e
        }
      })(),
      (async () => terminalizeChildRuns("p-race2", dir))(),
    ])

    const st = getRun(child.runId, dir)!
    // Kondisi APAPUN yang menang: terminal, dan tidak pernah RUNNING.
    expect(["COMPLETED", "INTERRUPTED"]).toContain(st.status)
    expect(st.status).not.toBe("RUNNING")
    expect(runningChildren(dir, "p-race2")).toBe(0)
    // Bila terminalisasi menang lebih dulu, klaim COMPLETED anak DITOLAK
    // (terminal beku) — bukan ditimpa diam-diam.
    if (st.status === "INTERRUPTED") {
      expect(childErr).not.toBeNull()
      expect(st.recovery_status).toBe("UNKNOWN")
    }
  } finally {
    cleanup(dir)
  }
})

test("I3: sweep TIDAK menurunkan anak yang sudah COMPLETED (conditional UPDATE)", async () => {
  const dir = ws()
  try {
    await seedParent(dir, "p-race3")
    const child = createChildSession({ parentSessionId: "p-race3", cwd: dir })
    transitionRun(child.runId, "RUNNING", dir)
    completeRun(child.runId, dir)
    expect(tombstoneOrphanChildRuns("p-race3", dir)).toEqual([])
    const st = getRun(child.runId, dir)!
    expect(st.status).toBe("COMPLETED")
    expect(st.recovery_status).toBe("NONE")
    expect(st.ended_at).not.toBeNull()
  } finally {
    cleanup(dir)
  }
})

// ── L: sesi legacy tetap bisa membangun anak kanonik ────────────────────────

test("L: sesi legacy (kolom parent NULL) membangun anak kanonik", async () => {
  const dir = ws()
  // Buat skema dulu (pola open()+migrasi), lalu tanam baris gaya pra-P2.9:
  // baris root dengan parent_session_id/parent_run_id NULL (data historis
  // TETAP legacy — tak di-rewrite).
  expect(loadSession("legacy", dir)).toBeNull()
  const p = join(dir, ".minicode", "sessions.db")
  const raw = new Database(p)
  try {
    raw
      .prepare(
        "INSERT INTO sessions (id, created_at, updated_at, cwd, system, writer_epoch) VALUES ('legacy', 1, 1, '', '', 0)",
      )
      .run()
  } finally {
    raw.close()
  }
  setSubAgentSessionFactory(fakeFactory([]))
  const restore = providerEnv()
  try {
    const childId = await delegateOnce(dir, "legacy")
    expect(loadSession(childId, dir)).not.toBeNull()
    const rows = coexists(dir, "legacy", childId)
    expect(rows).toEqual({ sessionsChild: 1, threadsChild: 1, runsChild: 1, sessionsParent: 1 })
    // Induk legacy TIDAK di-rewrite jadi anak (root tetap root).
    const db = new Database(p, { readonly: true })
    try {
      const row = db
        .prepare("SELECT parent_session_id, parent_run_id FROM sessions WHERE id = 'legacy'")
        .get() as { parent_session_id: string | null; parent_run_id: string | null }
      expect(row.parent_session_id).toBeNull()
      expect(row.parent_run_id).toBeNull()
    } finally {
      db.close()
    }
  } finally {
    clearSubAgentSessionFactory()
    restore()
    cleanup(dir)
  }
})

// ── M: TIDAK ADA anak P2.9 yang hanya ada di jurnal ─────────────────────────

test("M: setiap childSessionId di jurnal punya baris sessions (tanpa hantu)", async () => {
  const dir = ws()
  setSubAgentSessionFactory(fakeFactory([]))
  const restore = providerEnv()
  try {
    const prev = todoSession.id
    todoSession.id = "p-journal"
    await delegateTaskTool.execute({ prompt: "a" }, ctxFor(dir))
    await delegateTaskTool.execute({ prompt: "b" }, ctxFor(dir))
    todoSession.id = prev

    const journal = join(dir, ".minicode", "journal-p-journal.jsonl")
    expect(existsSync(journal)).toBe(true)
    const ids = readFileSync(journal, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { childSessionId?: unknown })
      .filter((r) => typeof r.childSessionId === "string")
      .map((r) => r.childSessionId as string)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(2)

    const db = new Database(join(dir, ".minicode", "sessions.db"), { readonly: true })
    try {
      for (const cid of ids) {
        expect(
          (
            db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(cid) as {
              n: number
            }
          ).n,
        ).toBe(1)
        expect(
          (
            db.prepare("SELECT parent_session_id FROM sessions WHERE id = ?").get(cid) as {
              parent_session_id: string
            }
          ).parent_session_id,
        ).toBe("p-journal")
      }
      // Sebaliknya: tak ada baris sub_ tanpa Thread + Run (ko-kanonisasi).
      const rows = db
        .prepare(
          `SELECT s.id,
                  (SELECT COUNT(*) FROM threads t WHERE t.session_id = s.id) AS th,
                  (SELECT COUNT(*) FROM runs r WHERE r.session_id = s.id) AS rn
           FROM sessions s WHERE s.id LIKE 'sub_%'`,
        )
        .all() as { id: string; th: number; rn: number }[]
      expect(rows.length).toBe(2)
      for (const r of rows) {
        expect(r.th).toBeGreaterThanOrEqual(1)
        expect(r.rn).toBe(1)
      }
    } finally {
      db.close()
    }
    expect(orphanChildEvents(dir)).toBe(0)
  } finally {
    clearSubAgentSessionFactory()
    restore()
    cleanup(dir)
  }
})

// ── ROOT CAUSE: resolusi DB bergeser di tengah satu siklus anak ─────────────
//
// Bukti forensik bahwa "mixed DB path" itu NYATA dan persis mengapa task.ts
// HARUS memin domain sebelum createChildSession.

test("ROOT-CAUSE: resolveDbPath bergeser setelah .minicode dibuat", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-p29i-"))
  const dir = mkdtempSync(join(tmpdir(), "mc-p29j-")) // ada, TANPA .minicode
  const saved = process.env.MINICODE_HOME
  process.env.MINICODE_HOME = home
  try {
    // Sebelum pin: tanpa .minicode → resolusi jatuh ke DB global.
    const before = resolveDbPath("sessions.db", dir)
    expect(before).toBe(join(home, ".minicode", "sessions.db"))
    expect(existsSync(join(dir, ".minicode"))).toBe(false)
    // acquireSessionWriter → new TaskStore → resolveLocalDbPath = SELALU lokal
    // dan membuat <dir>/.minicode (pola native yang dipakai pin di task.ts).
    resolveLocalDbPath("tasks.db", dir)
    expect(existsSync(join(dir, ".minicode"))).toBe(true)
    const after = resolveDbPath("sessions.db", dir)
    expect(after).toBe(join(dir, ".minicode", "sessions.db"))
    // INI dia mixed path: dua resolusi berbeda untuk satu siklus.
    expect(after).not.toBe(before)
  } finally {
    if (saved === undefined) delete process.env.MINICODE_HOME
    else process.env.MINICODE_HOME = saved
    cleanup(home, dir)
  }
})

test("ROOT-CAUSE: tanpa pin, Run dibuat di DB A lalu dibaca di DB B", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-p29k-"))
  const dir = mkdtempSync(join(tmpdir(), "mc-p29l-")) // ada, TANPA .minicode
  const saved = process.env.MINICODE_HOME
  process.env.MINICODE_HOME = home
  try {
    // 1. createChildSession → open(cwd) → .minicode belum ada → DB GLOBAL.
    const child = createChildSession({ parentSessionId: "p-flip", cwd: dir })
    expect(existsSync(join(home, ".minicode", "sessions.db"))).toBe(true)
    // 2. acquireSessionWriter → TaskStore membuat <dir>/.minicode (lokal).
    const ad = acquireSessionWriter({ sessionId: child.sessionId, cwd: dir, bootId: "probe" })
    expect(ad.ok).toBe(true)
    // 3. transitionRun kini resolve ke DB LOKAL yang tak punya baris Run.
    expect(() => transitionRun(child.runId, "RUNNING", dir)).toThrow(/run not found/)
    // Baris sesi anak MEMANG tertinggal di DB global (polusi) — itulah
    // alasan task.ts harus memin domain SEBELUM createChildSession.
    const db = new Database(join(home, ".minicode", "sessions.db"), { readonly: true })
    try {
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(child.sessionId) as {
            n: number
          }
        ).n,
      ).toBe(1)
    } finally {
      db.close()
    }
  } finally {
    if (saved === undefined) delete process.env.MINICODE_HOME
    else process.env.MINICODE_HOME = saved
    cleanup(home, dir)
  }
})

// ── §20 FORENSIC PROOF: seluruh siklus anak = SATU domain otoritatif ────────

test("DOMAIN: sesi/thread/run/epoch/presentasi anak = satu file DB", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-p29m-"))
  const dir = mkdtempSync(join(tmpdir(), "mc-p29n-")) // kasus terburuk: tanpa .minicode
  const saved = process.env.MINICODE_HOME
  process.env.MINICODE_HOME = home
  setSubAgentSessionFactory(fakeFactory([]))
  const restore = providerEnv()
  try {
    const childId = await delegateOnce(dir, "p-domain")

    // Domain yang dipin = domain lokal TaskStore (lease) — direktori sama.
    const file = resolveDbPath("sessions.db", dir)
    expect(file).toBe(join(dir, ".minicode", "sessions.db"))
    expect(dirname(resolveLocalDbPath("tasks.db", dir))).toBe(dirname(file))

    // SATU file berisi seluruh entitas siklus anak.
    const db = new Database(file)
    try {
      const row = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE id = ?) AS sc,
             (SELECT COUNT(*) FROM threads WHERE session_id = ?) AS tc,
             (SELECT writer_epoch FROM sessions WHERE id = ?) AS ep,
             (SELECT parent_session_id FROM sessions WHERE id = ?) AS pps,
             (SELECT COUNT(*) FROM runs WHERE session_id = ?) AS allRuns`,
        )
        .get(childId, childId, childId, childId, childId) as {
        sc: number
        tc: number
        ep: number
        pps: string
        allRuns: number
      }
      expect(row.sc).toBe(1) // sesi anak kanonik
      expect(row.tc).toBeGreaterThanOrEqual(1) // thread anak kanonik
      expect(row.allRuns).toBe(1) // run anak kanonik, milik sesi anak
      expect(row.pps).toBe("p-domain") // lineage parent Session durable
      expect(typeof row.ep).toBe("number") // epoch dibaca dari file yang sama
      // Epoch yang dibaca API == epoch yang tersimpan di file ini
      // (bukti: writer epoch DB identity == child Session DB identity).
      expect(readWriterEpoch(childId, dir)).toBe(row.ep)

      // Presentasi anak di file yang SAMA (bukan DB lain).
      db.prepare(
        "INSERT INTO presentation_events (session_id, event_seq, type, turn_id, ts, payload) VALUES (?, 1, 'notice', 0, ?, '{}')",
      ).run(childId, Date.now())
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM presentation_events WHERE session_id = ?")
            .get(childId) as { n: number }
        ).n,
      ).toBe(1)
    } finally {
      db.close()
    }

    // Nol polusi global: rumah tak pernah menerima baris apa pun.
    const homeDb = join(home, ".minicode", "sessions.db")
    if (existsSync(homeDb)) {
      const hdb = new Database(homeDb, { readonly: true })
      try {
        expect((hdb.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0)
        expect(
          (hdb.prepare("SELECT COUNT(*) AS n FROM presentation_events").get() as { n: number }).n,
        ).toBe(0)
      } finally {
        hdb.close()
      }
    }
    expect(orphanChildEvents(dir)).toBe(0)
  } finally {
    clearSubAgentSessionFactory()
    restore()
    if (saved === undefined) delete process.env.MINICODE_HOME
    else process.env.MINICODE_HOME = saved
    cleanup(home, dir)
  }
})
