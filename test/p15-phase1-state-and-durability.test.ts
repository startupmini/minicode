// Fase 1 — Invariant state authority, CAS, lease & durability boundary.
//
// Ringkas apa yang dibuktikan file ini (masing-masing punya test sendiri):
//
//   LOOP-INV-01  patchTask = transaksi atomik + CAS (`AND revision = ?`).
//   LOOP-INV-02  TASK_EDGES: terminal tidak bangkit tanpa permit eksplisit;
//                wiring VERIFYING sah dua arah.
//   LOOP-INV-13  Lease fencing: token yang sudah tersingkir tidak boleh menulis.
//   LOOP-INV-03  Durability-before-effect: intent jurnal + pending_tool_ids
//                SUDAH ada di disk saat baris pertama tool body dieksekusi.
//   LOOP-INV-06  pending_tool_ids hidup: bertambah sebelum efek, berkurang saat
//                selesai, dan run normal berakhir dengan daftar kosong.
//   LOOP-INV-10  Daftar in-flight bertahan melewati "kematian proses" (state
//                memori di-reset) sebagai bukti forensik operasi UNKNOWN.
//
// Hermetik: direktori temp, provider palsu, tanpa jaringan.

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Tool } from "#minicore"
import { FakeProvider, finish, text, tool, toolCall } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import {
  attachMutationJournal,
  journalPath,
  type MutationJournalHandle,
} from "../src/session/journal.ts"
import {
  beginToolInFlight,
  clearPendingTools,
  endToolInFlight,
  pendingToolsSnapshot,
  resetPendingToolsForTests,
  setPendingToolsRun,
} from "../src/session/pending-tools.ts"
import {
  createRun,
  ensureDefaultThread,
  saveSession,
  transitionRun,
} from "../src/session/persistence.ts"
import { IllegalTaskTransitionError, TaskAuthorityLostError } from "../src/task/model.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const dirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p15-"))
  // `.minicode` WAJIB ada sebelum saveSession: tanpa itu DB jatuh ke
  // ~/.minicode global dan test tidak lagi hermetic.
  mkdirSync(join(d, ".minicode"), { recursive: true })
  dirs.push(d)
  return d
}

afterEach(() => {
  resetTaskStoreHandles()
  resetPendingToolsForTests()
  while (dirs.length) {
    const d = dirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const PROV = { origin: "runtime", source: "p15" } as const
const S = "p15-session"

function newStore(dir: string): TaskStore {
  return new TaskStore(dir, { authority: "SCHEDULER" })
}

/**
 * Store tanpa otoritas SCHEDULER. Dipakai test transisi: di mode SCHEDULER,
 * penulisan `IN_PROGRESS` ditolak lebih dulu oleh gerbang otoritas (perilaku
 * 6B yang benar), sehingga gerbang transisi tak pernah tercapai.
 */
function newLegacyStore(dir: string): TaskStore {
  return new TaskStore(dir)
}

function makeTask(store: TaskStore, title = "kerja"): string {
  return store.createTask(S, { title, status: "PENDING", order: 0, provenance: PROV }).id
}

/** Baca `pending_tool_ids` langsung dari SQLite (bukti durable, bukan memori). */
function pendingFromDb(dir: string, runId: string): string[] {
  const db = new Database(join(dir, ".minicode", "sessions.db"))
  try {
    const row = db.prepare("SELECT pending_tool_ids FROM runs WHERE run_id = ?").get(runId) as {
      pending_tool_ids: string
    } | null
    if (row === null) throw new Error(`run ${runId} not found`)
    return JSON.parse(row.pending_tool_ids) as string[]
  } finally {
    db.close()
  }
}

// ── LOOP-INV-01: CAS pada patchTask ─────────────────────────────────────────
describe("LOOP-INV-01 — patchTask transaksional + compare-and-swap", () => {
  test("expectedRevision cocok -> tulis sukses dan revision maju tepat satu", () => {
    const dir = tempDir()
    const store = newStore(dir)
    const id = makeTask(store)
    const base = store.getTask(S, id)!
    expect(base.revision).toBe(1)

    const next = store.patchTask(S, id, { title: "baru" }, { expectedRevision: base.revision })
    expect(next.title).toBe("baru")
    expect(next.revision).toBe(2)
  })

  test("expectedRevision basi ditolak atomik: perubahan terbaru TIDAK tertimpa", () => {
    const dir = tempDir()
    const store = newStore(dir)
    const id = makeTask(store)
    const stale = store.getTask(S, id)!.revision // 1

    // Penulis pertama menang.
    store.patchTask(S, id, { title: "pemenang" }, { expectedRevision: stale })
    // Penulis kedua memakai revision yang sama (basi) -> harus kalah.
    expect(() =>
      store.patchTask(S, id, { title: "pecundang" }, { expectedRevision: stale }),
    ).toThrow(/revision/)

    const after = store.getTask(S, id)!
    expect(after.title).toBe("pemenang")
    expect(after.revision).toBe(2)
  })

  test("tanpa expectedRevision pun penulisan tetap revision-guarded (tidak menimpa buta)", () => {
    const dir = tempDir()
    const store = newStore(dir)
    const id = makeTask(store)
    const first = store.patchTask(S, id, { title: "satu" })
    const second = store.patchTask(S, id, { title: "dua" })
    // Keduanya sukses berurutan, tetapi revision mencerminkan dua mutasi nyata:
    // tidak ada penulisan yang "lupa" menaikkan revisi.
    expect(first.revision).toBe(2)
    expect(second.revision).toBe(3)
  })
})

// ── LOOP-INV-02: TASK_EDGES & terminal resurrection guard ───────────────────
describe("LOOP-INV-02 — tabel transisi legal & larangan bangkitnya terminal", () => {
  test("COMPLETED tidak bisa kembali ke PENDING/IN_PROGRESS tanpa permit", () => {
    const dir = tempDir()
    const store = newLegacyStore(dir)
    const id = makeTask(store)
    store.patchTask(S, id, { status: "COMPLETED" })

    expect(() => store.patchTask(S, id, { status: "PENDING" })).toThrow(IllegalTaskTransitionError)
    expect(() => store.patchTask(S, id, { status: "IN_PROGRESS" })).toThrow(
      IllegalTaskTransitionError,
    )
    // Status tetap terminal: penolakan tidak menulis apa pun.
    expect(store.getTask(S, id)!.status).toBe("COMPLETED")
  })

  test("CANCELLED tidak bisa kembali ke IN_PROGRESS tanpa permit", () => {
    const dir = tempDir()
    const store = newLegacyStore(dir)
    const id = makeTask(store)
    store.patchTask(S, id, { status: "CANCELLED" })

    expect(() => store.patchTask(S, id, { status: "IN_PROGRESS" })).toThrow(
      IllegalTaskTransitionError,
    )
    expect(store.getTask(S, id)!.status).toBe("CANCELLED")
  })

  test("permit allowReopen eksplisit membuka terminal (reopen tetap mungkin, tapi tertulis)", () => {
    const dir = tempDir()
    const store = newStore(dir)
    const id = makeTask(store)
    store.patchTask(S, id, { status: "COMPLETED" })

    const reopened = store.patchTask(S, id, { status: "PENDING" }, { allowReopen: true })
    expect(reopened.status).toBe("PENDING")
  })

  test("jalur VERIFYING sah dua arah, dan self-write judul tidak memaksa pindah status", () => {
    const dir = tempDir()
    const store = newLegacyStore(dir)
    const id = makeTask(store)

    // PENDING -> VERIFYING -> COMPLETED
    expect(store.patchTask(S, id, { status: "VERIFYING" }).status).toBe("VERIFYING")
    expect(store.patchTask(S, id, { status: "COMPLETED" }).status).toBe("COMPLETED")

    const other = makeTask(store, "kedua")
    store.patchTask(S, other, { status: "VERIFYING" })
    // VERIFYING -> IN_PROGRESS (perbaikan) lalu self-write judul.
    expect(store.patchTask(S, other, { status: "IN_PROGRESS" }).status).toBe("IN_PROGRESS")
    const retitled = store.patchTask(S, other, { title: "judul baru" })
    expect(retitled.status).toBe("IN_PROGRESS")
    expect(retitled.title).toBe("judul baru")
  })
})

// ── LOOP-INV-13: lease fencing ──────────────────────────────────────────────
describe("LOOP-INV-13 — patchTask menolak penulis tanpa lease", () => {
  test("worker yang tersingkir tidak bisa menulis; pemegang lease aktif bisa", () => {
    const dir = tempDir()
    const store = newStore(dir)
    const id = makeTask(store)

    // A mengambil lease yang SUDAH kedaluwarsa (now dimundurkan) supaya B bisa
    // takeover secara deterministik tanpa sleep.
    expect(store.acquireSessionAuthority(S, "token-a", 1_000, Date.now() - 10_000)).toBe("ACQUIRED")
    // B takeover (lease A sudah lewat).
    expect(store.acquireSessionAuthority(S, "token-b", 300_000)).toBe("ACQUIRED")

    // A masih memegang token lama -> fail-closed, tidak menulis apa pun.
    expect(() =>
      store.patchTask(S, id, { title: "dari-A" }, { authorityToken: "token-a" }),
    ).toThrow(TaskAuthorityLostError)
    expect(store.getTask(S, id)!.title).toBe("kerja")

    // B pemegang sah -> boleh menulis.
    const ok = store.patchTask(S, id, { title: "dari-B" }, { authorityToken: "token-b" })
    expect(ok.title).toBe("dari-B")
  })

  test("tanpa authorityToken (jalur operator/CLI) perilaku lama tetap jalan", () => {
    const dir = tempDir()
    const store = newStore(dir)
    const id = makeTask(store)
    // Lease milik proses lain ada, tetapi pemanggil tanpa identitas lease
    // (operator interaktif satu mesin) tidak boleh tiba-tiba ditolak.
    store.acquireSessionAuthority(S, "token-lain", 300_000)
    expect(store.patchTask(S, id, { title: "operator" }).title).toBe("operator")
  })
})

// ── LOOP-INV-03 + INV-10: durability sebelum efek ───────────────────────────
describe("LOOP-INV-03/INV-10 — intent jurnal & pending_tool_ids sudah durable sebelum efek", () => {
  test("baris pertama tool body melihat intent jurnal + pending id di disk; 2 tool paralel", async () => {
    const dir = tempDir()
    await saveSession(S, dir, undefined, [], undefined)
    const thread = ensureDefaultThread(S, dir)
    const run = createRun(S, thread.thread_id, dir)
    transitionRun(run.run_id, "RUNNING", dir)
    setPendingToolsRun(run.run_id, dir)

    const atBodyStart: { pending: string[]; dbPending: string[]; journal: string }[] = []
    // Sinkronisasi: A menunggu B benar-benar mulai, supaya kedua ID pasti
    // sudah in-flight saat snapshot diambil.
    let signalB: () => void = () => {}
    const bStarted = new Promise<void>((r) => {
      signalB = r
    })

    const probeA: Tool = tool(
      "probe_a",
      async () => {
        await bStarted
        atBodyStart.push({
          pending: [...pendingToolsSnapshot()],
          dbPending: pendingFromDb(dir, run.run_id),
          journal: readFileSync(journalPath(S, dir), "utf8"),
        })
        return "a-ok"
      },
      { type: "object", additionalProperties: false },
    )
    const probeB: Tool = tool(
      "probe_b",
      async () => {
        atBodyStart.push({
          pending: [...pendingToolsSnapshot()],
          dbPending: pendingFromDb(dir, run.run_id),
          journal: readFileSync(journalPath(S, dir), "utf8"),
        })
        signalB()
        return "b-ok"
      },
      { type: "object", additionalProperties: false },
    )

    let journal: MutationJournalHandle | null = null
    const session = await createMinicodeSession({
      provider: new FakeProvider([
        {
          events: [
            toolCall("probe_a", {}, "call-A"),
            toolCall("probe_b", {}, "call-B"),
            finish("tool_calls"),
          ],
        },
        { events: [text("selesai"), finish("stop")] },
      ]),
      tools: [probeA, probeB],
      permissionMode: "allow-all",
      cwd: dir,
      beforeToolEffect: async (call) => {
        if (journal !== null) await journal.preflightIntent(call)
      },
    })
    const handle = attachMutationJournal(session, {
      sessionId: S,
      cwd: dir,
      evidenceMode: "events",
    })
    journal = handle
    session.events.on("execution:started", (e) => {
      const ev = e as unknown as { execution?: { call?: { id?: unknown } } }
      const id = typeof ev.execution?.call?.id === "string" ? ev.execution.call.id : ""
      if (id !== "") beginToolInFlight(id)
    })
    session.events.on("execution:completed", (e) => {
      const ev = e as unknown as { execution?: { call?: { id?: unknown } } }
      const id = typeof ev.execution?.call?.id === "string" ? ev.execution.call.id : ""
      if (id !== "") endToolInFlight(id)
    })

    const result = await session.run("kerjakan", {})
    expect(result.finalText).toContain("selesai")
    expect(atBodyStart).toHaveLength(2)

    for (const snapshot of atBodyStart) {
      // Setidaknya ID tool yang sedang berjalan ini sudah ada...
      expect(snapshot.dbPending.length).toBeGreaterThanOrEqual(1)
      // ...dan tepat dua operasi yang in-flight di run ini saat keduanya jalan.
      expect(snapshot.dbPending.sort()).toEqual(["call-A", "call-B"])
      // Intent durable: record intent untuk masing-masing tool sudah tertulis
      // dengan status pending. `kind` sengaja dihilangkan untuk mutasi default
      // (lihat JournalRecord.kind), jadi yang diperiksa adalah `state`.
      expect(snapshot.journal).toContain("probe_a")
      expect(snapshot.journal).toContain("probe_b")
      expect(snapshot.journal).toContain('"state":"pending"')
    }

    // Run yang selesai normal: kedua ID dilepas.
    expect(pendingFromDb(dir, run.run_id)).toEqual([])
    expect(pendingToolsSnapshot()).toEqual([])

    // [Fase 1] Terminal juga tuntas: `flushPending` menunggu append terminal
    // yang tadinya fire-and-forget, sehingga "selesai" tidak mendahului bukti.
    await handle.flushPending()
    const finalJournal = readFileSync(journalPath(S, dir), "utf8")
    expect(finalJournal).toContain('"state":"committed"')
  })
})

// ── LOOP-INV-06/INV-10: siklus hidup & bukti crash ──────────────────────────
describe("LOOP-INV-06/INV-10 — pending_tool_ids: bertambah, berkurang, bertahan saat crash", () => {
  test("dua tool in-flight tercatat; satu selesai menyisakan satu; crash menyisakan bukti", async () => {
    const dir = tempDir()
    await saveSession(S, dir, undefined, [], undefined)
    const thread = ensureDefaultThread(S, dir)
    const run = createRun(S, thread.thread_id, dir)
    transitionRun(run.run_id, "RUNNING", dir)

    setPendingToolsRun(run.run_id, dir)
    beginToolInFlight("call-1")
    beginToolInFlight("call-2")
    expect(pendingFromDb(dir, run.run_id).sort()).toEqual(["call-1", "call-2"])

    endToolInFlight("call-1")
    expect(pendingFromDb(dir, run.run_id)).toEqual(["call-2"])

    // Simulasi proses mati: state memori hilang, tetapi SQLite tetap.
    resetPendingToolsForTests()
    expect(pendingFromDb(dir, run.run_id)).toEqual(["call-2"])

    // Run yang benar-benar selesai normal membersihkan daftar.
    setPendingToolsRun(run.run_id, dir)
    clearPendingTools()
    expect(pendingFromDb(dir, run.run_id)).toEqual([])
  })

  test("tanpa run aktif modul no-op (sesi anak/legacy tidak menulis apa pun)", () => {
    resetPendingToolsForTests()
    beginToolInFlight("call-x")
    expect(pendingToolsSnapshot()).toEqual([])
    endToolInFlight("call-x")
    expect(pendingToolsSnapshot()).toEqual([])
  })
})
