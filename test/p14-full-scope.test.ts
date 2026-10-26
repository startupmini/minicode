// P14 full-scope — kontrak intent (P14.1), ekstraksi histori berprovenance
// (P14.2), grup duplikat lintas sesi (P14.3), bidang portofolio + ekspor
// (P14.4), context pack (P14.5), dan matriks forensik (P14.6).
//
// Deterministik penuh: waktu disuntik (`NOW`/`TS`), kegagalan disimulasikan
// lewat fixture berkas/SQL, CLI lewat subprocess hermetic. Tidak ada `sleep`.
//
// Tiga hal yang DIJAGA di seluruh file ini:
//   1. Proyeksi TIDAK PERNAH menulis (revisi/ledger/lease/berkas identik).
//   2. Tidak ada fabrikasi status selesai (allow ≠ COMPLETED; klaim tanpa
//      verifikasi dilabel `unverified`).
//   3. Terminal tidak dihidupkan kembali (DECLINED/CANCELLED/COMPLETED tetap
//      keluar dari open/intent).

import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve as resolvePath } from "node:path"
import type { DomainEvent, PlanStepStatus, PlanUpdatedEvent } from "../src/presentation/events.ts"
import { projectOpenWork } from "../src/session/open-work.ts"
import {
  extractIntentCandidates,
  nextActionFor,
  planStepState,
  scopeSession,
  taskWorkState,
  type WorkRunRow,
  type WorkSessionRow,
  workPriority,
} from "../src/session/open-work-intent.ts"
import {
  appendPresentationEvents,
  createChildSession,
  createRun,
  getDefaultThread,
  saveSession,
  transitionRun,
} from "../src/session/persistence.ts"
import type { TaskStatus, TaskVerification } from "../src/task/model.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

let dir: string
let store: TaskStore

const A = "p14fs-a"
const B = "p14fs-b"
const prov = { origin: "model", source: "p14fs-test" } as const
const NOW = Date.parse("2026-10-26T09:00:00Z")
const DAY = 24 * 60 * 60 * 1000
const TS = NOW - 60_000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-p14fs-"))
  // `.minicode` HARUS ada sebelum saveSession: tanpa ini resolveDbPath
  // menjatuhkan sessions.db ke ~/.minicode GLOBAL, mencemari mesin nyata
  // dan membuat fixture tidak hermetic (pelajaran dari run pertama).
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  resetSessionOwnershipForTests()
})

afterEach(() => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ── helpers ─────────────────────────────────────────────────────────────────

const tasksDbPath = (): string => join(dir, ".minicode", "tasks.db")
const sessionsDbPath = (): string => join(dir, ".minicode", "sessions.db")

function add(sessionId: string, title: string, status: TaskStatus = "PENDING") {
  const order = store.listTasks(sessionId).length + 1
  return store.createTask(sessionId, { title, status, order, provenance: prov })
}

function planEvent(
  sessionId: string,
  seq: number,
  steps: { stepId: string; status: PlanStepStatus; taskId?: string; title?: string }[],
  turn = 1,
): PlanUpdatedEvent {
  return {
    eventSeq: seq,
    ts: TS,
    sessionId,
    turnId: turn,
    type: "plan.updated",
    planId: `plan:${sessionId}:${turn}`,
    status: "open",
    steps,
  }
}

function event(sessionId: string, seq: number, payload: Record<string, unknown>): DomainEvent {
  return {
    eventSeq: seq,
    ts: TS,
    sessionId,
    turnId: 1,
    ...payload,
  } as DomainEvent
}

async function persistEvents(sessionId: string, events: readonly DomainEvent[]): Promise<void> {
  const stats = await appendPresentationEvents(sessionId, dir, events)
  if (stats.collisions > 0) throw new Error(`test fixture collision: ${stats.collisions}`)
}

function workSession(id: string, cwd: string | null = dir): WorkSessionRow {
  return { id, createdAtMs: TS, updatedAtMs: TS, cwd, parentSessionId: null }
}

function runRow(sessionId: string, status: WorkRunRow["status"]): WorkRunRow {
  return {
    runId: `run_${sessionId}`,
    sessionId,
    status,
    startedAtMs: TS,
    endedAtMs: status === "INTERRUPTED" || status === "FAILED" ? TS : null,
    recoveryStatus: status === "INTERRUPTED" ? "UNKNOWN" : "NONE",
  }
}

/**
 * Jadikan baris sesi lokal TANPA binding cwd (simulasi warisan pra-binding).
 * saveSession(B, undefined) justru salah-tuju (DB-nya resolve ke process.cwd),
 * jadi binding dihapus SETELAH baris tertulis di sessions.db lokal.
 */
function unbindSession(id: string): void {
  const db = new Database(sessionsDbPath())
  try {
    db.prepare("UPDATE sessions SET cwd = '' WHERE id = ?").run(id)
  } finally {
    db.close()
  }
}

// ── E. P14.1 — kontrak intent murni ────────────────────────────────────────

describe("P14.1 — kontrak state/taskWorkState (murni)", () => {
  test("pemetaan mekanis per TaskStatus", () => {
    expect(taskWorkState("PENDING").state).toBe("OPEN")
    expect(taskWorkState("IN_PROGRESS").state).toBe("PARTIAL")
    expect(taskWorkState("VERIFYING").state).toBe("PARTIAL")
    expect(taskWorkState("BLOCKED").state).toBe("BLOCKED")
    expect(taskWorkState("FAILED").state).toBe("FAILED_NEEDS_FOLLOWUP")
    expect(taskWorkState("RETRYING").state).toBe("FAILED_NEEDS_FOLLOWUP")
  })

  test("override berbasis bukti: verification failed & dependensi tak tuntas", () => {
    const failedVerif: TaskVerification = {
      verdict: "failed",
      detail: "tests still red",
      checkedAt: new Date(TS).toISOString(),
    }
    expect(taskWorkState("IN_PROGRESS", { verification: failedVerif }).state).toBe(
      "FAILED_NEEDS_FOLLOWUP",
    )
    expect(taskWorkState("PENDING", { unresolvedDependency: true }).state).toBe("BLOCKED")
    // Bukti LULUS tidak menurunkan kejujuran: task tetap PARTIAL sampai
    // status kanoniknya COMPLETED — verifikasi bukan pengganti status.
    const passed: TaskVerification = { verdict: "passed", checkedAt: new Date(TS).toISOString() }
    expect(taskWorkState("IN_PROGRESS", { verification: passed }).state).toBe("PARTIAL")
  })

  test("status terminal fail-closed: tidak ada state open untuk task tertutup", () => {
    expect(() => taskWorkState("COMPLETED")).toThrow(/terminal status has no open state/)
    expect(() => taskWorkState("CANCELLED")).toThrow(/terminal status has no open state/)
  })

  test("planStepState: semua status langkah dipetakan; asing = UNKNOWN", () => {
    expect(planStepState("pending")).toBe("OPEN")
    expect(planStepState("active")).toBe("PARTIAL")
    expect(planStepState("blocked")).toBe("BLOCKED")
    expect(planStepState("completed")).toBe("COMPLETED")
    expect(planStepState("cancelled")).toBe("CANCELLED")
    expect(planStepState("weird-future-status")).toBe("UNKNOWN")
  })
})

describe("P14.1 — prioritas & next action (murni, deterministik)", () => {
  test("state menentukan tingkat; stale menaikkan SATU tingkat saja", () => {
    expect(workPriority("BLOCKED", false).level).toBe("P0")
    expect(workPriority("FAILED_NEEDS_FOLLOWUP", false).level).toBe("P0")
    expect(workPriority("WAITING_FOR_USER", false).level).toBe("P1")
    expect(workPriority("DELEGATED", false).level).toBe("P1")
    expect(workPriority("UNKNOWN", false).level).toBe("P1")
    expect(workPriority("PARTIAL", false).level).toBe("P2")
    expect(workPriority("OPEN", false).level).toBe("P3")
    // Stale boost: OPEN→P2, PARTIAL→P1; yang sudah P0 tidak melompat.
    expect(workPriority("OPEN", true).level).toBe("P2")
    expect(workPriority("PARTIAL", true).level).toBe("P1")
    expect(workPriority("BLOCKED", true).level).toBe("P0")
    expect(workPriority("OPEN", true).reason).toContain("stale")
  })

  test("next action eksplisit untuk setiap state; UNKNOWN menyebut provenance", () => {
    expect(nextActionFor("OPEN")).toContain("existing lifecycle")
    expect(nextActionFor("BLOCKED", "missing credential")).toContain("missing credential")
    expect(nextActionFor("WAITING_FOR_USER")).toContain("approval")
    expect(nextActionFor("DELEGATED")).toContain("child session")
    expect(nextActionFor("UNKNOWN")).toContain("provenance")
    // Tidak ada state open yang menjanjikan eksekusi otomatis.
    for (const state of [
      "OPEN",
      "PARTIAL",
      "BLOCKED",
      "WAITING_FOR_USER",
      "DELEGATED",
      "FAILED_NEEDS_FOLLOWUP",
      "UNKNOWN",
    ] as const) {
      const action = nextActionFor(state)
      expect(action.length).toBeGreaterThan(0)
      expect(action.toLowerCase()).not.toContain("automatic")
    }
  })
})

describe("P14.1 — scopeSession (batas cakupan pencarian)", () => {
  test("binding cwd menentukan milik workspace; trailing slash setara", () => {
    expect(scopeSession(dir, dir)).toBe("IN_SCOPE")
    expect(scopeSession(dir, `${dir}${dir.includes("\\") ? "\\" : "/"}`)).toBe("IN_SCOPE")
    expect(scopeSession(dir, `${dir}-other-project`)).toBe("FOREIGN_WORKSPACE")
    expect(scopeSession(dir, null)).toBe("UNBOUND_WORKSPACE")
    expect(scopeSession(dir, "")).toBe("UNBOUND_WORKSPACE")
  })
})

describe("P14.2 — extractIntentCandidates (murni atas baris sintetis)", () => {
  // Dibangun PER-TEST lewat fungsi: `dir` baru terisi oleh beforeEach, jadi
  // nilai di level describe akan membekap undefined (pelajaran dari run 1).
  const ws = (): WorkSessionRow[] => [workSession(A), workSession(B, `${dir}-other`)]

  test("approval tanpa jawaban = WAITING_FOR_USER; deny = DECLINED terminal; allow TIDAK jadi kandidat", () => {
    const events: DomainEvent[] = [
      event(A, 1, {
        type: "approval.requested",
        approvalId: "ap1",
        identity: { origin: "builtin", name: "bash", qualified: "bash" },
        argsSummary: { text: "rm -rf build" },
        via: "prompt",
      }),
      event(A, 2, {
        type: "approval.requested",
        approvalId: "ap2",
        identity: { origin: "builtin", name: "bash", qualified: "bash" },
        argsSummary: { text: "run tests" },
        via: "prompt",
      }),
      event(A, 3, {
        type: "approval.settled",
        approvalId: "ap2",
        outcome: { decision: "deny", by: "user", reason: "declined" },
      }),
      event(A, 4, {
        type: "approval.requested",
        approvalId: "ap3",
        identity: { origin: "builtin", name: "bash", qualified: "bash" },
        argsSummary: { text: "build" },
        via: "prompt",
      }),
      event(A, 5, {
        type: "approval.settled",
        approvalId: "ap3",
        outcome: { decision: "allow", by: "user" },
      }),
    ]
    const out = extractIntentCandidates({ workspace: dir, sessions: ws(), events, runs: [] })
    const approvals = out.filter((c) => c.source === "APPROVAL")
    expect(approvals).toHaveLength(2)
    const waiting = approvals.find((c) => c.provenance.approvalId === "ap1")
    expect(waiting).toMatchObject({ state: "WAITING_FOR_USER", terminal: false })
    const declined = approvals.find((c) => c.provenance.approvalId === "ap2")
    expect(declined).toMatchObject({ state: "DECLINED", terminal: true })
    // allow BUKAN bukti selesai: ap3 tidak boleh jadi apa pun — bukan COMPLETED.
    expect(approvals.some((c) => c.provenance.approvalId === "ap3")).toBe(false)
  })

  test("delegasi: tanpa hasil = DELEGATED open; hasil gagal = FAILED_NEEDS_FOLLOWUP; hasil selesai = COMPLETED terminal", () => {
    // Bentuk NYATA createChildSession: anak TIDAK punya binding cwd sendiri
    // (cwd=null) — cakupan diwarisi dari lineage induk, bukan ditebak.
    const sessions: WorkSessionRow[] = [
      workSession(A),
      { ...workSession("sub_done", null), parentSessionId: A },
      { ...workSession("sub_failed", null), parentSessionId: A },
      { ...workSession("sub_open", null), parentSessionId: A },
    ]
    const events: DomainEvent[] = [
      event("sub_done", 1, {
        type: "result.produced",
        resultId: "r1",
        status: "completed",
        summary: "did the thing",
      }),
      event("sub_failed", 1, { type: "turn.failed", error: { cause: "exec", message: "boom" } }),
    ]
    const out = extractIntentCandidates({ workspace: dir, sessions, events, runs: [] })
    const byId = new Map(out.map((c) => [c.sessionId, c]))
    expect(byId.get("sub_open")).toMatchObject({
      source: "DELEGATION",
      state: "DELEGATED",
      terminal: false,
    })
    expect(byId.get("sub_failed")).toMatchObject({
      state: "FAILED_NEEDS_FOLLOWUP",
      terminal: false,
    })
    expect(byId.get("sub_done")).toMatchObject({ state: "COMPLETED", terminal: true })
  })

  test("run: INTERRUPTED = open loop; RUNNING/COMPLETED/FAILED tidak melahirkan kandidat", () => {
    const out = extractIntentCandidates({
      workspace: dir,
      sessions: [workSession(A)],
      events: [],
      runs: [
        runRow(A, "INTERRUPTED"),
        { ...runRow(A, "RUNNING"), runId: "run_live" },
        { ...runRow(A, "COMPLETED"), runId: "run_done" },
        { ...runRow(A, "FAILED"), runId: "run_dead" },
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ source: "RUN", state: "FAILED_NEEDS_FOLLOWUP", terminal: false })
    expect(out[0]?.provenance.runId).toBe("run_p14fs-a")
  })

  test("pesan bebas pengguna TIDAK PERNAH menjadi kandidat — brainstorming bukan tugas", () => {
    const events: DomainEvent[] = [
      event(A, 1, {
        type: "user.message",
        text: "nanti kita harus memperbaiki login, janji!",
        promptRef: "turn:1",
      }),
      event(A, 2, {
        type: "model.completed",
        text: "Saya akan menyelesaikanya besok",
        truncated: false,
      }),
    ]
    expect(
      extractIntentCandidates({ workspace: dir, sessions: [workSession(A)], events, runs: [] }),
    ).toEqual([])
  })

  test("sesi asing (FOREIGN_WORKSPACE) tidak pernah diekstrak; maxCandidates membatasi", () => {
    const events: DomainEvent[] = [
      event(A, 1, {
        type: "approval.requested",
        approvalId: "x1",
        identity: { origin: "builtin", name: "t", qualified: "t" },
        argsSummary: { text: "a" },
        via: "prompt",
      }),
      event(B, 1, {
        type: "approval.requested",
        approvalId: "x2",
        identity: { origin: "builtin", name: "t", qualified: "t" },
        argsSummary: { text: "b" },
        via: "prompt",
      }),
    ]
    const out = extractIntentCandidates({ workspace: dir, sessions: ws(), events, runs: [] })
    expect(out).toHaveLength(1)
    expect(out[0]?.sessionId).toBe(A)
    const capped = extractIntentCandidates({
      workspace: dir,
      sessions: [workSession(A)],
      events: [
        event(A, 1, {
          type: "approval.requested",
          approvalId: "c1",
          identity: { origin: "builtin", name: "t", qualified: "t" },
          argsSummary: { text: "1" },
          via: "prompt",
        }),
        event(A, 2, {
          type: "approval.requested",
          approvalId: "c2",
          identity: { origin: "builtin", name: "t", qualified: "t" },
          argsSummary: { text: "2" },
          via: "prompt",
        }),
      ],
      runs: [],
      maxCandidates: 1,
    })
    expect(capped).toHaveLength(1)
  })

  test("snapshot plan: status terbaru menang, riwayat tidak menduplikasi kandidat", () => {
    // Satu plan yang sama diterbitkan tiga kali (setiap todo_write sukses).
    // Hanya snapshot terakhir yang boleh menjadi kandidat; versi pending/active
    // lama BUKAN open loop kedua.
    const events: DomainEvent[] = [
      planEvent(A, 1, [{ stepId: "1", status: "pending", title: "write migration guide" }]),
      planEvent(A, 2, [{ stepId: "1", status: "active", title: "write migration guide" }]),
      planEvent(A, 3, [{ stepId: "1", status: "completed", title: "write migration guide" }]),
    ]
    const out = extractIntentCandidates({
      workspace: dir,
      sessions: [workSession(A)],
      events,
      runs: [],
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: "PLAN_STEP",
      state: "COMPLETED",
      terminal: true,
      artifactStatus: "completed",
    })
    expect(out[0]?.provenance.eventSeq).toBe(3)
  })

  test("snapshot plan: active → pending = OPEN terbaru; langkah lain tetap terpisah", () => {
    const events: DomainEvent[] = [
      planEvent(A, 1, [
        { stepId: "1", status: "active", title: "step one" },
        { stepId: "2", status: "pending", title: "step two" },
      ]),
      planEvent(A, 2, [
        { stepId: "1", status: "pending", title: "step one" },
        { stepId: "2", status: "pending", title: "step two" },
      ]),
    ]
    const out = extractIntentCandidates({
      workspace: dir,
      sessions: [workSession(A)],
      events,
      runs: [],
    })
    expect(out).toHaveLength(2)
    const one = out.find((c) => c.provenance.stepId === "1")
    const two = out.find((c) => c.provenance.stepId === "2")
    expect(one).toMatchObject({ state: "OPEN", terminal: false })
    expect(one?.provenance.eventSeq).toBe(2)
    expect(two).toMatchObject({ state: "OPEN", terminal: false })
  })

  test("snapshot plan: langkah yang DIHAPUS dari snapshot terakhir tidak dihidupkan", () => {
    // Operator menghapus langkah dari todo list. Snapshot terakhir tidak lagi
    // memuatnya; menghidupkannya kembali akan menciptakan open loop hantu.
    const events: DomainEvent[] = [
      planEvent(A, 1, [
        { stepId: "1", status: "pending", title: "abandoned idea" },
        { stepId: "2", status: "pending", title: "kept step" },
      ]),
      planEvent(A, 2, [{ stepId: "1", status: "pending", title: "kept step" }]),
    ]
    const out = extractIntentCandidates({
      workspace: dir,
      sessions: [workSession(A)],
      events,
      runs: [],
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.summary).toBe("kept step")
    expect(out.some((c) => c.summary === "abandoned idea")).toBe(false)
  })

  test("snapshot plan: langkah yang sama di turn BERBEDA tidak menduplikasi kandidat", () => {
    // `planId` memuat nomor turn (`plan:<session>:<turn>`), sedangkan daftar
    // todo milik SESI. Langkah pending yang masih terbuka akan muncul lagi di
    // snapshot turn berikutnya; mengunci per-planId akan menggandakan open loop
    // yang sama. Snapshot terakhir sesi adalah kebenaran terkini.
    const events: DomainEvent[] = [
      planEvent(A, 1, [{ stepId: "1", status: "pending", title: "long running step" }], 1),
      planEvent(A, 2, [{ stepId: "1", status: "pending", title: "long running step" }], 2),
      planEvent(A, 3, [{ stepId: "1", status: "pending", title: "long running step" }], 3),
    ]
    const out = extractIntentCandidates({
      workspace: dir,
      sessions: [workSession(A)],
      events,
      runs: [],
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.provenance.planId).toBe(`plan:${A}:3`)
    expect(out[0]?.provenance.eventSeq).toBe(3)
  })

  test("snapshot plan v2: identitas kanonik taskId, bukan stepId posisional", () => {
    // payloadVersion=2 menyatakan stepId hanyalah label posisi. Saat daftar
    // berubah urutan, stepId bergeser — kolaps harus memakai taskId agar
    // langkah yang sama tidak muncul dua kali dengan status berbeda.
    const events: DomainEvent[] = [
      planEvent(A, 1, [
        { stepId: "1", status: "active", taskId: "t1", title: "first" },
        { stepId: "2", status: "pending", taskId: "t2", title: "second" },
      ]),
      planEvent(A, 2, [
        { stepId: "1", status: "pending", taskId: "t2", title: "second" },
        { stepId: "2", status: "completed", taskId: "t1", title: "first" },
      ]),
    ]
    const out = extractIntentCandidates({
      workspace: dir,
      sessions: [workSession(A)],
      events,
      runs: [],
    })
    expect(out).toHaveLength(2)
    const first = out.find((c) => c.provenance.taskId === "t1")
    const second = out.find((c) => c.provenance.taskId === "t2")
    expect(first).toMatchObject({ state: "COMPLETED", terminal: true })
    expect(second).toMatchObject({ state: "OPEN", terminal: false })
    // Provenance menunjuk snapshot terbaru, bukan event pertama.
    expect(first?.provenance.eventSeq).toBe(2)
    expect(second?.provenance.eventSeq).toBe(2)
  })
})

// ── F. P14.2 — ekstraksi histori berprovenance (integrasi proyeksi) ─────────

describe("P14.2 — proyeksi membaca histori terstruktur dengan provenance", () => {
  test("langkah plan tanpa task kanonik jadi kandidat intent berprovenance; task open tidak terduplikasi", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    await persistEvents(A, [
      planEvent(A, 1, [
        { stepId: "1", status: "pending", title: "write migration guide" },
        { stepId: "2", status: "active", taskId: "t1", title: "adopted step" },
      ]),
    ])
    // IN_PROGRESS hanya boleh lahir dari claimTask (guard P6B).
    const tracked = add(A, "adopted step")
    const before = store.getTask(A, tracked.id)!
    expect(store.claimTask(A, tracked.id, before.revision).outcome).toBe("CLAIM_ACCEPTED")

    const report = projectOpenWork({ cwd: dir, now: NOW })
    expect(report.counts.open).toBe(1)
    expect(report.counts.intent).toBe(1)

    const intentItem = report.intent[0]
    expect(intentItem).toMatchObject({
      source: "PLAN_STEP",
      state: "OPEN",
      sessionId: A,
      taskId: null,
    })
    expect(intentItem?.summary).toContain("write migration guide")
    expect(intentItem?.provenance.eventSeq).toBe(1)
    expect(intentItem?.provenance.turnId).toBe(1)
    expect(intentItem?.provenance.planId).toBe(`plan:${A}:1`)
    expect(intentItem?.provenance.stepId).toBe("1")

    // Langkah yang menunjuk task OPEN menempel sebagai BUKTI, bukan duplikat.
    const entry = report.open.find((e) => e.taskId === tracked.id)
    expect(entry?.planSteps).toHaveLength(1)
    expect(entry?.planSteps[0]).toMatchObject({ stepId: "2", claimedStatus: "active" })
    expect(report.intent.some((c) => c.summary === "adopted step")).toBe(false)
  })

  test("klaim plan non-terminal atas task TERMINAL tidak dihidupkan; masuk closure dengan konflik diungkap", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    const done = add(A, "already finished work")
    store.patchTask(A, done.id, { status: "COMPLETED" })
    await persistEvents(A, [
      planEvent(A, 1, [
        { stepId: "1", status: "active", taskId: done.id, title: "still claims active" },
      ]),
    ])

    const report = projectOpenWork({ cwd: dir, now: NOW, includeClosed: true })
    expect(report.counts.open).toBe(0)
    expect(report.counts.intent).toBe(0)
    const closed = report.closed.find((e) => e.kind === "INTENT")
    expect(closed).toMatchObject({
      sessionId: A,
      taskId: done.id,
      status: "COMPLETED",
      intentState: "COMPLETED",
      claim: "unverified",
    })
    expect(closed?.reason).toContain("supersedes plan claim")
  })

  test("verifikasi passed pada task terminal menghasilkan claim verified", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    const done = add(A, "verified finished work")
    const verif: TaskVerification = { verdict: "passed", checkedAt: new Date(TS).toISOString() }
    store.patchTask(A, done.id, { status: "COMPLETED", verification: verif })
    await persistEvents(A, [
      planEvent(A, 1, [{ stepId: "1", status: "active", taskId: done.id, title: "stale claim" }]),
    ])

    const report = projectOpenWork({ cwd: dir, now: NOW, includeClosed: true })
    expect(report.closed.find((e) => e.kind === "INTENT")?.claim).toBe("verified")
  })

  test("approval DECLINED dari histori: closure terminal, TIDAK pernah muncul lagi di open/intent", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    await persistEvents(A, [
      event(A, 1, {
        type: "approval.requested",
        approvalId: "ap-deny",
        identity: { origin: "builtin", name: "bash", qualified: "bash" },
        argsSummary: { text: "dangerous op" },
        via: "prompt",
      }),
      event(A, 2, {
        type: "approval.settled",
        approvalId: "ap-deny",
        outcome: { decision: "deny", by: "user", reason: "declined" },
      }),
    ])

    const open = projectOpenWork({ cwd: dir, now: NOW })
    expect(open.counts.intent).toBe(0)
    const closed = projectOpenWork({ cwd: dir, now: NOW, includeClosed: true })
    const entry = closed.closed.find((e) => e.kind === "INTENT")
    expect(entry).toMatchObject({ intentState: "DECLINED", claim: "not-applicable", taskId: null })
    expect(entry?.reason).toContain("denied")
  })
})

// ── G. P14.3 — grup duplikat lintas sesi (UNPROVEN, tanpa merge otomatis) ───

describe("P14.3 — dedup lintas sesi: diungkap, tidak disatukan", () => {
  test("judul sama lintas sesi = satu grup UNPROVEN; state berbeda = konflik eksplisit; nol merge lahir", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    await saveSession(B, dir, undefined, [], undefined)
    add(A, "Fix login bug")
    const blocked = add(B, "fix LOGIN bug!!")
    store.patchTask(B, blocked.id, { status: "BLOCKED", blockedReason: "missing credentials" })

    const report = projectOpenWork({ cwd: dir, now: NOW })
    expect(report.duplicateGroups).toHaveLength(1)
    const group = report.duplicateGroups[0]
    expect(group).toMatchObject({
      key: "fix login bug",
      count: 2,
      divergentStates: true,
      proven: false,
    })
    expect(group?.sessions).toEqual([A, B])
    expect(report.counts.conflicts).toBe(1)
    // Kedua entri membawa referensi grup yang sama.
    expect(report.open.every((e) => e.duplicate?.key === "fix login bug")).toBe(true)
    // Bukti tidak menyatukan apa pun: ledger merge tetap kosong.
    expect(store.listTaskMerges()).toHaveLength(0)
    expect(store.getTask(A, "t1")?.status).toBe("PENDING")
    expect(store.getTask(B, "t1")?.status).toBe("BLOCKED")
  })

  test("judul sama lintas sesi dengan state sama: grup tanpa konflik; tugas independen tidak diganggu", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    await saveSession(B, dir, undefined, [], undefined)
    add(A, "recurring review")
    add(B, "Recurring  review.")

    const report = projectOpenWork({ cwd: dir, now: NOW })
    expect(report.duplicateGroups[0]?.divergentStates).toBe(false)
    expect(report.counts.conflicts).toBe(0)
    // Tugas berulang yang sengaja independen tetap dua baris terpisah.
    expect(report.counts.open).toBe(2)
    expect(store.listTaskMerges()).toHaveLength(0)
  })

  test("grup mencakup task DAN kandidat intent (judul plan menempel ke grup)", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    await saveSession(B, dir, undefined, [], undefined)
    add(A, "port config loader")
    await persistEvents(B, [
      planEvent(B, 1, [{ stepId: "1", status: "pending", title: "Port config loader" }]),
    ])

    const report = projectOpenWork({ cwd: dir, now: NOW })
    expect(report.duplicateGroups).toHaveLength(1)
    expect(report.duplicateGroups[0]?.count).toBe(2)
    expect(report.duplicateGroups[0]?.sessions).toEqual([A, B])
  })
})

// ── H. P14.4 — bidang portofolio: blocker/dependensi/verifikasi/next ────────

describe("P14.4 — blocker, dependensi, verifikasi, dan next action", () => {
  test("blockedReason + dependensi tak tuntas = blocker eksplisit + state BLOCKED + P0", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    const blocker = add(A, "blocked by missing key")
    const dep = add(A, "dependency that stays pending")
    store.patchTask(A, blocker.id, {
      status: "BLOCKED",
      blockedReason: "API key rotated",
      dependsOn: [dep.id],
    })

    const report = projectOpenWork({ cwd: dir, now: NOW })
    const entry = report.open.find((e) => e.taskId === blocker.id)
    expect(entry).toBeDefined()
    expect(entry?.state).toBe("BLOCKED")
    expect(entry?.priority.level).toBe("P0")
    expect(
      entry?.blockers.some(
        (b) => b.kind === "TASK_BLOCKED" && b.detail.includes("API key rotated"),
      ),
    ).toBe(true)
    expect(
      entry?.blockers.some((b) => b.kind === "DEPENDENCY" && b.detail.startsWith(dep.id)),
    ).toBe(true)
    expect(entry?.dependencies[0]).toMatchObject({
      taskId: dep.id,
      status: "PENDING",
      satisfied: false,
    })
    expect(entry?.nextAction).toContain("resolve blocker")
  })

  test("dependensi COMPLETED = satisfied; task dependen tidak dianggap terblokir", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    const dep = add(A, "done dependency")
    store.patchTask(A, dep.id, { status: "COMPLETED" })
    const dependent = add(A, "dependent work")
    store.patchTask(A, dependent.id, { dependsOn: [dep.id] })

    const report = projectOpenWork({ cwd: dir, now: NOW })
    const entry = report.open.find((e) => e.taskId === dependent.id)
    expect(entry?.state).toBe("OPEN")
    expect(entry?.dependencies[0]).toMatchObject({ status: "COMPLETED", satisfied: true })
    expect(entry?.blockers).toHaveLength(0)
  })

  test("verification failed = FAILED_NEEDS_FOLLOWUP + blocker VERIFICATION", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    const t = add(A, "claimed done but broken")
    // IN_PROGRESS hanya boleh lahir dari claimTask (guard P6B) — jalur kanonik.
    const before = store.getTask(A, t.id)!
    expect(store.claimTask(A, t.id, before.revision).outcome).toBe("CLAIM_ACCEPTED")
    store.patchTask(A, t.id, {
      verification: {
        verdict: "failed",
        detail: "bun test still red",
        checkedAt: new Date(TS).toISOString(),
      },
    })

    const report = projectOpenWork({ cwd: dir, now: NOW })
    const entry = report.open[0]
    expect(entry?.state).toBe("FAILED_NEEDS_FOLLOWUP")
    expect(entry?.stateReason).toBe("verification failed")
    expect(entry?.blockers[0]).toMatchObject({ kind: "VERIFICATION", detail: "bun test still red" })
    expect(entry?.verification?.verdict).toBe("failed")
  })
})

// ── I. P14.0 — inventaris lintas sumber (read-only) ─────────────────────────

describe("P14.0 — inventaris", () => {
  test("menghitung semua sumber + mengeksklusikan sesi asing/tanpa binding dengan alasan", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    await saveSession(B, dir, undefined, [], undefined)
    unbindSession(B) // cwd kosong → UNBOUND (warisan pra-binding)
    const child = createChildSession({ parentSessionId: A, cwd: dir, childSessionId: "sub_p14" })
    await persistEvents(A, [
      planEvent(A, 1, [
        { stepId: "1", status: "pending", title: "inventory step" },
        { stepId: "2", status: "completed", title: "done step" },
      ]),
      event(A, 2, {
        type: "approval.requested",
        approvalId: "inv1",
        identity: { origin: "builtin", name: "t", qualified: "t" },
        argsSummary: { text: "op" },
        via: "prompt",
      }),
      event(A, 3, {
        type: "approval.settled",
        approvalId: "inv1",
        outcome: { decision: "allow", by: "user" },
      }),
    ])
    const t1 = add(A, "open task")
    const t2 = add(A, "closed task")
    store.patchTask(A, t2.id, { status: "COMPLETED" })
    const thread = getDefaultThread(A, dir)
    const run = createRun(A, thread?.thread_id ?? "th_default", dir)
    transitionRun(run.run_id, "INTERRUPTED", dir, { recoveryStatus: "UNKNOWN" })

    const report = projectOpenWork({ cwd: dir, now: NOW, includeInventory: true })
    const inv = report.inventory
    expect(inv).not.toBeNull()
    // Task open yang sama tetap terlihat di portofolio (inventaris konsisten).
    expect(report.open.find((e) => e.taskId === t1.id)?.title).toBe("open task")
    expect(inv?.sessions).toMatchObject({
      total: 3,
      inScope: 2,
      foreignWorkspace: 0,
      unboundWorkspace: 1,
      childSessions: 1,
    })
    expect(inv?.tasks).toEqual({ total: 2, open: 1, terminal: 1 })
    expect(inv?.plans).toMatchObject({ events: 1, openSteps: 1, closedSteps: 1 })
    expect(inv?.approvals).toMatchObject({ requested: 1, settled: 1 })
    // Dua run: run anak CREATED (aktif) + run A yang INTERRUPTED.
    expect(inv?.runs).toMatchObject({ total: 2, active: 1, interrupted: 1, terminal: 0 })
    expect(inv?.subAgents).toMatchObject({ childSessions: 1 })
    expect(inv?.excludedSessions).toEqual([{ sessionId: B, reason: "UNBOUND_WORKSPACE" }])
    expect(inv?.presentationEvents.byType["plan.updated"]).toBe(1)
    // child session ikut in-scope (cwd sama dengan workspace).
    expect(inv?.sessions.inScope).toBe(2)
    expect(child.sessionId).toBe("sub_p14")
  })

  test("manifest checkpoint korup dilabel, DAN proyeksi tidak menulis backup .corrupt", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    const cpDir = join(dir, ".minicode", "checkpoints", A)
    mkdirSync(cpDir, { recursive: true })
    writeFileSync(join(cpDir, "manifest.json"), "{ this is not json")

    const report = projectOpenWork({ cwd: dir, now: NOW, includeInventory: true })
    expect(report.inventory?.checkpoints).toMatchObject({
      sessionsWithManifest: 1,
      entries: 0,
      corrupt: 1,
    })
    // Bukti read-only: TIDAK ada berkas backup yang lahir (bandingkan dengan
    // loadCheckpointManifest jalur pemulihan yang memang menulis backup).
    expect(readdirSync(cpDir)).toEqual(["manifest.json"])
  })

  test("checkpoint sehat terhitung; sesi tanpa manifest tidak dihitung", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    const cpDir = join(dir, ".minicode", "checkpoints", A)
    mkdirSync(cpDir, { recursive: true })
    const manifest = {
      sessionId: A,
      currentIndex: 0,
      checkpoints: [
        {
          id: "cp1",
          turn: 3,
          timestamp: new Date(TS).toISOString(),
          description: "before edit",
          snapshots: [],
        },
      ],
    }
    writeFileSync(join(cpDir, "manifest.json"), JSON.stringify(manifest))

    const report = projectOpenWork({ cwd: dir, now: NOW, includeInventory: true })
    expect(report.inventory?.checkpoints).toMatchObject({
      sessionsWithManifest: 1,
      entries: 1,
      corrupt: 0,
    })
  })
})

// ── J. P14.6 — matriks forensik (scenario-based, deterministik) ─────────────

describe("P14.6 — matriks forensik", () => {
  test("restart: run INTERRUPTED tampil sebagai open loop FAILED_NEEDS_FOLLOWUP; run hidup tidak", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    const thread = getDefaultThread(A, dir)
    const dead = createRun(A, thread?.thread_id ?? "th_default", dir)
    transitionRun(dead.run_id, "INTERRUPTED", dir, { recoveryStatus: "UNKNOWN" })
    const live = createRun(A, thread?.thread_id ?? "th_default", dir)
    transitionRun(live.run_id, "RUNNING", dir)

    const report = projectOpenWork({ cwd: dir, now: NOW })
    expect(report.intent).toHaveLength(1)
    expect(report.intent[0]).toMatchObject({
      source: "RUN",
      state: "FAILED_NEEDS_FOLLOWUP",
      provenance: { runId: dead.run_id },
    })
  })

  test("sesi terputus (tanpa baris sesi): task tetap terlihat, provenance UNKNOWN jujur", () => {
    // Tidak ada saveSession — baris sesi sengaja tidak ada.
    add(A, "orphaned work")

    const report = projectOpenWork({ cwd: dir, now: NOW })
    expect(report.counts.open).toBe(1)
    expect(report.open[0]?.provenance).toBe("SESSION_MISSING")
    expect(report.counts.unknownProvenance).toBe(1)
  })

  test("pembatalan: plan step cancelled masuk closed CANCELLED not-applicable; tidak muncul di open", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    await persistEvents(A, [
      planEvent(A, 1, [{ stepId: "1", status: "cancelled", title: "cancelled step" }]),
    ])

    const open = projectOpenWork({ cwd: dir, now: NOW })
    expect(open.counts.intent).toBe(0)
    const closed = projectOpenWork({ cwd: dir, now: NOW, includeClosed: true })
    const entry = closed.closed.find((e) => e.kind === "INTENT")
    expect(entry).toMatchObject({ intentState: "CANCELLED", claim: "not-applicable" })
  })

  test("stale: item tua berflags STALE dan ter-boost prioritas (umur = sinyal, bukan bukti)", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    add(A, "ancient work")
    const db = new Database(tasksDbPath())
    try {
      db.prepare("UPDATE tasks SET updated_at = ? WHERE session_id = ? AND task_id = ?").run(
        new Date(NOW - 30 * DAY).toISOString(),
        A,
        "t1",
      )
    } finally {
      db.close()
    }

    const report = projectOpenWork({ cwd: dir, now: NOW })
    expect(report.open[0]?.stale).toBe(true)
    expect(report.counts.stale).toBe(1)
    // PENDING → OPEN = P3, stale boost → P2.
    expect(report.open[0]?.priority.level).toBe("P2")
    expect(report.open[0]?.priority.reason).toContain("stale")
  })
})

// ── K. Zero-mutasi proyeksi penuh (sumber histori ikut diuji) ───────────────

describe("P14 — zero-mutasi proyeksi penuh", () => {
  test("proyeksi + inventaris tidak mengubah tasks/ledger/lease/sessions.db dan tidak membuat berkas baru", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    const t = add(A, "tracked work")
    await persistEvents(A, [
      planEvent(A, 1, [{ stepId: "1", status: "pending", taskId: t.id, title: "tracked work" }]),
      event(A, 2, {
        type: "approval.requested",
        approvalId: "apx",
        identity: { origin: "builtin", name: "t", qualified: "t" },
        argsSummary: { text: "x" },
        via: "prompt",
      }),
    ])

    const tasksBefore = store.listTasks(A).map((x) => ({ ...x }))
    const transfersBefore = store.listTaskTransfers()
    const mergesBefore = store.listTaskMerges()
    const sessionsBefore = new Database(sessionsDbPath())
    const rowsBefore = sessionsBefore.prepare("SELECT * FROM sessions ORDER BY id").all()
    const eventsBefore = sessionsBefore
      .prepare("SELECT * FROM presentation_events ORDER BY session_id, event_seq")
      .all()
    sessionsBefore.close()

    const report = projectOpenWork({
      cwd: dir,
      now: NOW,
      includeClosed: true,
      includeInventory: true,
    })
    expect(report.counts.open).toBe(1)
    expect(report.counts.intent).toBe(1)
    expect(report.inventory).not.toBeNull()

    expect(store.listTasks(A).map((x) => ({ ...x }))).toEqual(tasksBefore)
    expect(store.listTaskTransfers()).toEqual(transfersBefore)
    expect(store.listTaskMerges()).toEqual(mergesBefore)
    const sessionsAfter = new Database(sessionsDbPath())
    expect(sessionsAfter.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(rowsBefore)
    expect(
      sessionsAfter
        .prepare("SELECT * FROM presentation_events ORDER BY session_id, event_seq")
        .all(),
    ).toEqual(eventsBefore)
    sessionsAfter.close()
  })
})

// ── L. CLI — aksi baru + filter (subprocess hermetic) ──────────────────────

describe("P14.4/P14.5 — CLI openwork full-scope", () => {
  const entry = resolvePath(import.meta.dir, "..", "cli", "index.ts")

  function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
    const home = join(dir, "home")
    mkdirSync(join(home, ".minicode"), { recursive: true })
    const r = spawnSync(process.execPath, [entry, ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        NO_COLOR: "1",
        NO_UPDATE_CHECK: "1",
        CI: "1",
        MINICODE_HOME: home,
        HOME: home,
        USERPROFILE: home,
        OPENAI_API_KEY: undefined,
        AGENT_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        TOKENHARBOR_API_KEY: undefined,
        TH_API_KEY: undefined,
      },
    })
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  }

  test("--help menampilkan bantuan subcommand dan exit 0 (bukan diam-diam menjalankan list)", () => {
    const r = runCli(["openwork", "--help"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("minicode openwork —")
    expect(r.stdout).toContain("openwork inventory")
    expect(r.stdout).toContain("openwork context")
    expect(r.stdout).toContain("openwork export")
    expect(r.stdout).toContain("openwork merge")
    // Bantuan BUKAN portofolio: tidak boleh ada header list.
    expect(r.stdout).not.toContain("TaskStore remains the sole status authority")
  })

  test("list manusia menampilkan state/priority/blockers/next + grup duplikat lintas sesi", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    const blocked = add(A, "port config loader")
    const dep = add(A, "dependency task")
    store.patchTask(A, blocked.id, {
      status: "BLOCKED",
      blockedReason: "missing env",
      dependsOn: [dep.id],
    })
    resetTaskStoreHandles()

    const r = runCli(["openwork", "--cwd", dir])
    expect(r.code).toBe(0)
    for (const expected of [
      "Open Work",
      "BLOCKED",
      "P0",
      "TASK_BLOCKED: missing env",
      `DEPENDENCY: ${dep.id} (PENDING)`,
      "depends on:",
      "next:",
      "resolve blocker",
      "TaskStore remains the sole status authority",
    ]) {
      expect(r.stdout).toContain(expected)
    }
  })

  test("--state / --priority / --blocked / --depends-on memfilter portofolio", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    add(A, "plain open work")
    const blocked = add(A, "blocked work")
    const dep = add(A, "dependency")
    store.patchTask(A, blocked.id, {
      status: "BLOCKED",
      blockedReason: "nope",
      dependsOn: [dep.id],
    })
    resetTaskStoreHandles()

    const byState = runCli(["openwork", "--cwd", dir, "--state", "BLOCKED", "--json"])
    expect(byState.code).toBe(0)
    const stateParsed = JSON.parse(byState.stdout) as { counts: { open: number } }
    expect(stateParsed.counts.open).toBe(1)

    // Tanpa filter, ketiga task terlihat — bukti filter tidak "memakan" item.
    const all = runCli(["openwork", "--cwd", dir, "--json"])
    expect((JSON.parse(all.stdout) as { counts: { open: number } }).counts.open).toBe(3)

    const byPriority = runCli(["openwork", "--cwd", dir, "--priority", "P0", "--json"])
    expect((JSON.parse(byPriority.stdout) as { counts: { open: number } }).counts.open).toBe(1)

    const blockedOnly = runCli(["openwork", "--cwd", dir, "--blocked", "--json"])
    const blockedParsed = JSON.parse(blockedOnly.stdout) as {
      open: { title: string }[]
      counts: { open: number }
    }
    expect(blockedParsed.counts.open).toBe(1)
    expect(blockedParsed.open[0]?.title).toBe("blocked work")

    const byDep = runCli(["openwork", "--cwd", dir, "--depends-on", dep.id, "--json"])
    expect((JSON.parse(byDep.stdout) as { counts: { open: number } }).counts.open).toBe(1)

    const misuse = runCli(["openwork", "--cwd", dir, "--state", "BOGUS"])
    expect(misuse.code).toBe(2)
    expect(misuse.stderr).toContain("invalid --state")
  })

  test("inventory: manusia + --json, termasuk sesi yang dikeluarkan dengan alasan", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    await saveSession(B, dir, undefined, [], undefined)
    unbindSession(B)
    add(A, "inv task")
    resetTaskStoreHandles()

    const human = runCli(["openwork", "inventory", "--cwd", dir])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("Open Work Inventory")
    expect(human.stdout).toContain("unbound")
    expect(human.stdout).toContain(B)
    expect(human.stdout).toContain("UNBOUND_WORKSPACE")
    expect(human.stdout).toContain("TaskStore remains the sole status authority")

    const asJson = runCli(["openwork", "inventory", "--cwd", dir, "--json"])
    expect(asJson.code).toBe(0)
    const parsed = JSON.parse(asJson.stdout) as {
      inventory: { sessions: { total: number; inScope: number; unboundWorkspace: number } }
      counts: { open: number }
      rejectedEvents: number
    }
    expect(parsed.inventory.sessions).toMatchObject({ total: 2, inScope: 1, unboundWorkspace: 1 })
    expect(parsed.counts.open).toBe(1)
    expect(asJson.stdout.trim().split("\n")).toHaveLength(1)
  })

  test("context: pack konteks berprovenance; task tak ada = exit 1; id cacat = exit 2", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    const t = add(A, "context target")
    await persistEvents(A, [
      planEvent(A, 1, [{ stepId: "1", status: "active", taskId: t.id, title: "context target" }]),
    ])
    resetTaskStoreHandles()

    const asJson = runCli([
      "openwork",
      "context",
      "--cwd",
      dir,
      "--session",
      A,
      "--task",
      t.id,
      "--json",
    ])
    expect(asJson.code).toBe(0)
    const pack = JSON.parse(asJson.stdout) as {
      task: { title: string; status: string; revision: number }
      portfolio: { state: string; planSteps: { stepId: string }[]; nextAction: string } | null
      checkpoint: { exists: boolean }
      resume: { autoExecute: boolean; enforcedBy: string[] }
    }
    expect(pack.task.title).toBe("context target")
    // TaskStore tetap otoritas: status PENDING → state OPEN; klaim plan "active"
    // DIBEKALI sebagai bukti bertentangan (planSteps.claimedStatus), bukan
    // dipakai menimpa state kanonik.
    expect(pack.portfolio?.state).toBe("OPEN")
    expect(pack.portfolio?.planSteps[0]).toMatchObject({ stepId: "1", claimedStatus: "active" })
    expect(pack.resume.autoExecute).toBe(false)
    expect(pack.resume.enforcedBy.join(" ")).toContain("P13.3")

    const human = runCli(["openwork", "context", "--cwd", dir, "--session", A, "--task", t.id])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("Open Work Context")
    expect(human.stdout).toContain("next:")

    const missing = runCli(["openwork", "context", "--cwd", dir, "--session", A, "--task", "t99"])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('task "t99" not found')

    const badId = runCli(["openwork", "context", "--cwd", dir, "--session", A, "--task", "nope"])
    expect(badId.code).toBe(2)
    expect(badId.stderr).toContain("invalid --task")
  })

  test("export: json + md atomik, ANSI tersapu, refuse tanpa --force, --force menimpa", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    add(A, "export title \u001b[2J hijack")
    resetTaskStoreHandles()

    const jsonPath = join(dir, "portfolio.json")
    const r1 = runCli(["openwork", "export", "--cwd", dir, "--out", jsonPath])
    expect(r1.code).toBe(0)
    expect(r1.stdout).toContain("[openwork] exported")
    const exported = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      counts: { open: number }
      inventory: { sessions: { inScope: number } } | null
    }
    expect(exported.counts.open).toBe(1)
    // Ekspor SELALU membawa inventaris P14.0.
    expect(exported.inventory?.sessions.inScope).toBe(1)

    // Menolak menimpa tanpa --force.
    const refused = runCli(["openwork", "export", "--cwd", dir, "--out", jsonPath])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("already exists")

    const forced = runCli(["openwork", "export", "--cwd", dir, "--out", jsonPath, "--force"])
    expect(forced.code).toBe(0)

    const mdPath = join(dir, "portfolio.md")
    const r2 = runCli(["openwork", "export", "--cwd", dir, "--out", mdPath, "--format", "md"])
    expect(r2.code).toBe(0)
    const md = readFileSync(mdPath, "utf8")
    expect(md).toContain("# Open Work")
    expect(md).toContain("export title")
    // Sekuens kontrol dari judul TIDAK lolos ke berkas manusia.
    expect(md).not.toContain("\u001b[2J")
    expect(md).toContain("TaskStore remains the sole status authority")

    const badFormat = runCli([
      "openwork",
      "export",
      "--cwd",
      dir,
      "--out",
      join(dir, "x"),
      "--format",
      "yaml",
    ])
    expect(badFormat.code).toBe(2)
    expect(badFormat.stderr).toContain("invalid --format")
  })

  test("export gagal menulis (induk adalah berkas) = exit 1, tanpa berkas sampah", async () => {
    await saveSession(A, dir, undefined, [], undefined)
    add(A, "some work")
    resetTaskStoreHandles()
    const blockerFile = join(dir, "blocker-file")
    writeFileSync(blockerFile, "occupied")

    const r = runCli(["openwork", "export", "--cwd", dir, "--out", join(blockerFile, "child.json")])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("export failed")
    expect(readdirSync(dir).some((f) => f.includes(".tmp."))).toBe(false)
  })
})
