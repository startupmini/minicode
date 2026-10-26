// P13.3 Stage A — Gerbang admission per jenis kerja pada JALUR DISPATCH PRODUKSI.
//
// Milik P13.3 Stage A (kontrak + gerbang produksi). Suite P13.1 (kontrak),
// P13.2 (supervisi proses) dan P13.2 (lifecycle daemon) terpisah dan tak
// disentuh. Recovery lintas-restart / replay otomatis TIDAK ada di sini —
// itu P13.3 tahap berikutnya dan butuh desain kontinuasi tersendiri.
//
// Yang dibuktikan file ini:
//   1. Peta jenis-kerja → kapabilitas memakai KOSAKATA YANG ADA di produksi
//      (dibuktikan dari sumbernya), bukan jenis kerja yang dikarang.
//   2. Setiap jenis yang dipetakan dinilai oleh admission kanonik P13.1.
//   3. Jenis tak dipetakan/asing → REFUSE (fail-closed).
//   4. Bukti runtime yang hilang/basi tak pernah diam-diam mengizinkan dispatch.
//   5. Kontrak authority/lease yang sudah ada (M13) TETAP berlaku — gerbang
//      admission tidak menggantikannya.
//   6. Penolakan admission tak menandai task selesai dan tak menghapus record.
//   7. Jalur dispatch produksi (runner + komposisi nyata) MEMAKAI keputusan itu —
//      bukan cuma helper murni.
//
// Hermetic: workspace temp per test, TaskStore + jurnal di temp, tanpa jaringan.

import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntimeComposition, type RuntimeComposition } from "../src/runtime/composition.ts"
import { createProductionExecutionRunner } from "../src/runtime/production-execution.ts"
import {
  admitDurableWork,
  deriveRuntimeView,
  type RuntimeView,
} from "../src/runtime/runtime-status.ts"
import {
  admitTaskWork,
  MAPPED_WORK_KINDS,
  requiredCapabilitiesFor,
  TASK_WORK_REQUIREMENTS,
} from "../src/runtime/runtime-task-admission.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const dirs: string[] = []

afterEach(async () => {
  resetTaskStoreHandles()
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mc-p133-"))
  dirs.push(dir)
  return dir
}

const SESSION = "p133-sess"

/** Komposisi nyata (dengan jurnal) + fakta lapisan task yang bisa dikendalikan. */
async function compose(
  taskLayer: { schedulerAttached: boolean | null; storeOpen: boolean | null } = {
    schedulerAttached: true,
    storeOpen: true,
  },
): Promise<{ dir: string; runtime: RuntimeComposition }> {
  const dir = await tempDir()
  const runtime = createRuntimeComposition({
    sessionId: SESSION,
    workspaceCwd: dir,
    journalPath: join(dir, "journal.db"),
    taskLayerFacts: () => taskLayer,
  })
  return { dir, runtime }
}

/** View kanonik dari komposisi nyata (satu sumber: composition.statusFacts()). */
function viewOf(runtime: RuntimeComposition): RuntimeView {
  return deriveRuntimeView(runtime.statusFacts())
}

const REQUEST = {
  kind: "turn" as const,
  schedulerSource: "cli-session",
  authorityHeld: true,
  provenance: { requestedBy: "user", reason: "prompt" },
}

// ── 1. Peta memakai kosakata yang benar-benar ada ───────────────────────────

describe("P13.3 — peta jenis kerja memakai kosakata produksi", () => {
  test("jenis yang dipetakan = jenis yang punya producer nyata di repo", () => {
    // Bukti dari sumber: tiap jenis dipetakan harus punya producer di produksi.
    const autonomous = readFileSync(
      join(process.cwd(), "src", "task", "autonomous-context.ts"),
      "utf8",
    )
    const childTool = readFileSync(join(process.cwd(), "src", "tools", "task.ts"), "utf8")
    const dispatch = readFileSync(join(process.cwd(), "src", "runtime", "dispatch.ts"), "utf8")
    expect(autonomous).toContain('kind: "background"')
    expect(childTool).toContain('kind: "child"')
    expect(dispatch).toContain('?? "turn"')
    // Dan TIDAK ADA producer untuk "task" — makanya jenis itu tak dipetakan
    // (dan karena itu akan ditolak, bukan diterka).
    expect(MAPPED_WORK_KINDS).toEqual(["background", "child", "turn"])
    expect(MAPPED_WORK_KINDS).not.toContain("task")
  })

  test("kebutuhan kapabilitas per jenis mengikuti jalur kode yang menyaksikannya", () => {
    // "background": claim atomik di TaskStore + pemilik siklus scheduler.
    expect(requiredCapabilitiesFor("background")).toEqual(["durable-task-store", "task-scheduler"])
    // "turn" dan "child": bukan task otonom — tak ada claim TaskStore, tak ada
    // siklus scheduler.
    expect(requiredCapabilitiesFor("turn")).toEqual([])
    expect(requiredCapabilitiesFor("child")).toEqual([])
    // Jenis tak dipetakan: tak ada kebutuhan yang dikarang.
    expect(requiredCapabilitiesFor("task")).toEqual([])
  })
})

// ── 2 & 3. Keputusan lewat admission kanonik; tak dipetakan → REFUSE ────────

describe("P13.3 — keputusan lewat admission kanonik", () => {
  test("tiap jenis dipetakan dinilai OLEH admitDurableWork (bukan-versi sendiri)", async () => {
    const { runtime } = await compose()
    const view = viewOf(runtime)
    for (const kind of MAPPED_WORK_KINDS) {
      const viaHelper = admitTaskWork(view, kind)
      const viaCanonical = admitDurableWork(view, {
        workKind: kind,
        requirements: TASK_WORK_REQUIREMENTS,
      })
      expect(viaHelper.admission).toBe(viaCanonical.admission)
      expect(viaHelper.reason).toBe(viaCanonical.reason)
      expect(viaHelper.missingCapabilities).toEqual(viaCanonical.missingCapabilities)
    }
  })

  test("jenis tak dipetakan (task) dan jenis asing → REFUSE", async () => {
    const { runtime } = await compose()
    const view = viewOf(runtime)
    for (const kind of ["task", "ngawur", "", "BACKGROUND"]) {
      const decision = admitTaskWork(view, kind)
      expect(decision.admission).toBe("REFUSE")
      // Penolakannya karena PETANYA yang tidak ada, bukan karena satu kapabilitas
      // tertentu hilang — dan alasannya menyebut peta yang tidak ada.
      expect(decision.reason).toContain("peta eksplisit")
      expect(decision.requiredCapabilities).toEqual([])
    }
  })

  test("jenis terpetakan hanya diterima bila kapabilitas + buktinya sah", async () => {
    // Runtime sehat tapi fakta lapisan task TAK ada → kapabilitas yang dibutuhkan
    // "background" tak tersedia → REFUSE (fail-closed).
    const tanpa = await compose({ schedulerAttached: null, storeOpen: null })
    const decisionTanpa = admitTaskWork(viewOf(tanpa.runtime), "background")
    expect(decisionTanpa.admission).toBe("REFUSE")
    expect(decisionTanpa.missingCapabilities).toEqual(["durable-task-store", "task-scheduler"])

    // Fakta ada → diterima.
    const dengan = await compose()
    const decisionDengan = admitTaskWork(viewOf(dengan.runtime), "background")
    expect(decisionDengan.admission).toBe("ALLOW")
    expect(decisionDengan.missingCapabilities).toEqual([])
  })

  test("scheduler terpasang tapi TaskStore belum → tetap REFUSE (kapabilitas per butir)", async () => {
    const { runtime } = await compose({ schedulerAttached: true, storeOpen: false })
    const decision = admitTaskWork(viewOf(runtime), "background")
    expect(decision.admission).toBe("REFUSE")
    expect(decision.missingCapabilities).toEqual(["durable-task-store"])
  })
})

// ── 4. Bukti hilang/basi tak pernah diam-diam mengizinkan dispatch ───────────

describe("P13.3 — bukti runtime yang hilang atau basi", () => {
  test("bukti hilang (task-layer facts null) → tak ada admission diam-diam", async () => {
    const { runtime } = await compose({ schedulerAttached: null, storeOpen: null })
    const view = viewOf(runtime)
    // Bukti yang "null" = belum diketahui → evidence state MISSING, bukan "boleh".
    expect(view.evidence.schedulerAttached).toBeNull()
    expect(view.evidence.storeOpen).toBeNull()
    expect(admitTaskWork(view, "background").admission).toBe("REFUSE")
  })

  test("runtime yang tak_expected (basi) → tak ada admission diam-diam", async () => {
    const { runtime } = await compose()
    const view = viewOf(runtime)
    // Bukti basi: runtime AlreadyClosed tapi facts masih bilang OPEN.
    const stale = deriveRuntimeView({
      ...runtime.statusFacts(),
      evidence: { ...runtime.statusFacts().evidence, closed: true },
    })
    expect(stale.evidenceState).toBe("STALE")
    expect(admitTaskWork(stale, "background").admission).toBe("REFUSE")
    // View yang sehat tetap boleh — jadi aturan basi tidak mematikan segalanya.
    expect(admitTaskWork(view, "background").admission).toBe("ALLOW")
  })
})

// ── 5. Kontrak authority/lease yang sudah ada tetap berlaku ─────────────────

describe("P13.3 — kontrak authority yang sudah ada tetap berlaku", () => {
  test("authorityHeld=false → REJECTED oleh M13 (gerbang admission tak menggantinya)", async () => {
    const { runtime } = await compose()
    const runner = createProductionExecutionRunner({ mode: "owned", runtime })
    let caught: unknown = null
    try {
      await runner.run({ ...REQUEST, authorityHeld: false }, async () => "should not run")
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBeNull()
    const err = caught as { code?: string; message?: string }
    expect(err.code).toBe("RUNTIME_NOT_ADMITTED")
    expect(err.message).toContain("authority")
    // Tidak ada eksekusi yang admitted.
    expect(runtime.kernel.metrics().executions).toBe(0)
  })

  test("deadline yang sudah lewat → REJECTED (deadline M13 tak dilewati)", async () => {
    const { runtime } = await compose()
    const runner = createProductionExecutionRunner({ mode: "owned", runtime })
    let caught: unknown = null
    try {
      await runner.run({ ...REQUEST, deadlineAt: Date.now() - 1_000 }, async () => "no")
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBeNull()
    expect(runtime.kernel.metrics().executions).toBe(0)
  })
})

// ── 6. Record durable tetap utuh saat admission menolak ─────────────────────

describe("P13.3 — penolakan admission tak merusak record durable", () => {
  test("task yang ditolak admission: tak ditandai selesai, record tak hilang", async () => {
    const { dir, runtime } = await compose({ schedulerAttached: null, storeOpen: null })
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const created = store.createTask(SESSION, {
      title: "kerja durable",
      status: "PENDING",
      order: 1,
      provenance: { origin: "model", source: "test" },
    })
    const claimed = store.claimTask(SESSION, created.id, created.revision)
    expect(claimed.outcome).toBe("CLAIM_ACCEPTED")

    const runner = createProductionExecutionRunner({ mode: "owned", runtime })
    let caught: unknown = null
    try {
      await runner.run(
        {
          ...REQUEST,
          kind: "background",
          schedulerSource: "autonomous",
          taskId: created.id,
          provenance: { requestedBy: "scheduler", reason: `task=${created.id}` },
        },
        async () => "tidak boleh jalan",
      )
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBeNull()
    const err = caught as { code?: string; message?: string }
    expect(err.code).toBe("RUNTIME_NOT_ADMITTED")
    expect(err.message).toContain("ditolak admission")

    // Record durable: baris masih ada, dan TIDAK pernah jadi COMPLETED.
    const after = store.getTask(SESSION, created.id)
    expect(after).not.toBeNull()
    expect(after?.status).not.toBe("COMPLETED")
    // Tak ada eksekusi yang sempat jalan (jurnal tanpa intent dispatch).
    expect(runtime.kernel.metrics().executions).toBe(0)
    await runtime.shutdown()
  })
})

// ── 7 & 8. Jalur dispatch produksi MEMAKAI keputusan itu ───────────────────

describe("P13.3 — jalur dispatch produksi memakai keputusan admission", () => {
  test("runner produksi menolak 'background' saat fakta lapisan task tak ada", async () => {
    const { runtime } = await compose({ schedulerAttached: null, storeOpen: null })
    const runner = createProductionExecutionRunner({ mode: "owned", runtime })
    let caught: unknown = null
    try {
      await runner.run(
        {
          ...REQUEST,
          kind: "background",
          schedulerSource: "autonomous",
          taskId: "t-1",
          provenance: { requestedBy: "scheduler", reason: "task=t-1" },
        },
        async () => "tidak boleh jalan",
      )
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBeNull()
    const err = caught as { code?: string; message?: string }
    expect(err.code).toBe("RUNTIME_NOT_ADMITTED")
    expect(err.message).toContain("work kind background ditolak admission")
    // Fungsi kerja TIDAK pernah dipanggil (tak ada eksekusi yang diam-diam).
    expect(runtime.kernel.metrics().executions).toBe(0)
    await runtime.shutdown()
  })

  test("runner produksi menerima 'background' saat faktanya diumumkan", async () => {
    const { runtime } = await compose()
    const runner = createProductionExecutionRunner({ mode: "owned", runtime })
    let ran = false
    const outcome = await runner.run(
      {
        ...REQUEST,
        kind: "background",
        schedulerSource: "autonomous",
        taskId: "t-1",
        provenance: { requestedBy: "scheduler", reason: "task=t-1" },
      },
      async () => {
        ran = true
        return "ok"
      },
    )
    expect(ran).toBe(true)
    expect(outcome.state).toBe("COMPLETED")
    expect(runtime.kernel.metrics().executions).toBe(1)
    await runtime.shutdown()
  })

  test("runner produksi menolak jenis kerja asing (bukan cuma helper)", async () => {
    const { runtime } = await compose()
    const runner = createProductionExecutionRunner({ mode: "owned", runtime })
    let caught: unknown = null
    try {
      await runner.run(
        { ...REQUEST, kind: "ngawur" as never, taskId: "t-9" },
        async () => "tidak boleh jalan",
      )
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBeNull()
    const err = caught as { code?: string; message?: string }
    expect(err.code).toBe("RUNTIME_NOT_ADMITTED")
    expect(runtime.kernel.metrics().executions).toBe(0)
    await runtime.shutdown()
  })

  test("jurnal runtime tak menulis intent dispatch untuk kerja yang ditolak", async () => {
    const { dir, runtime } = await compose({ schedulerAttached: null, storeOpen: null })
    const runner = createProductionExecutionRunner({ mode: "owned", runtime })
    await runner
      .run(
        {
          ...REQUEST,
          kind: "background",
          schedulerSource: "autonomous",
          taskId: "t-1",
          provenance: { requestedBy: "scheduler", reason: "task=t-1" },
        },
        async () => "tidak boleh jalan",
      )
      .catch(() => undefined)
    const result = await runtime.shutdown()
    expect(result.ok).toBe(true)
    // Tidak ada intent dispatch di jurnal (tak ada jejak eksekusi yang semu).
    const { openExecutionJournal } = await import("../src/runtime/execution-journal.ts")
    const journal = openExecutionJournal(join(dir, "journal.db"))
    const intents = journal.readAll().filter((r) => r.kind === "intent")
    expect(intents).toHaveLength(0)
    journal.close()
  })
})
