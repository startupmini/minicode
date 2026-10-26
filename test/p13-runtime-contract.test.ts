// P13.1 — Tes kontrak status runtime (murni + deterministik).
//
// Milik P13.1 SAJA. Suite existing (replay/approval/incarnation daemon, P12
// work-mode, supervisor) TIDAK disentuh dan TIDAK menjadi scope P13 — invarian
// lama tetap milik lamanya. Tes integrasi P13.2/P13.3 (wiring supervisor
// produksi, fault injection, kontinuitas task lintas restart) juga BUKAN di
// sini.
//
// BATAS YANG DISANKAN PEMILIK: file ini membuktikan KONTRAK — sumbu status,
// tabel admission, legalitas kombinasi reason, bukti positive/negative, dan
// pemotongan buffer diagnostik. File ini TIDAK membuktikan cleanup proses
// produksi, recovery crash, atau tak adanya anak yatim: itu butuh integrasi
// nyata (P13.2/P13.3) dan TIDAK boleh diklaim dari sini.
//
// BATAS KLAIM KOMPATIBILITAS: yang diuji di sini adalah perilaku kode repo ini
// (klien daemon meneruskan message tak dikenal; control op tak dikenal
// ditolak; nomor protokol dicocokkan persis). Klien DI LUAR repo tidak punya
// sumber yang bisa diverifikasi di sini —perilaku placeholder kompatibilitas
// eksternal tetap TERKUALIFIKASI, dan tambahan aditif tidak menaikkan nomor
// protokol (versi dicocokkan persis, jadi bump = memutus klien lama).
//
// Hermetic: tanpa jaringan, tanpa proses anak, tanpa jam internal (jam
// disuntik), tanpa berkas repo yang disentuh.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { createServer } from "node:net"
import { join } from "node:path"
import { ApprovalBroker } from "../src/daemon/approvals.ts"
import { DaemonClient } from "../src/daemon/client.ts"
import { type ControlDeps, dispatchControl, IdempotencyStore } from "../src/daemon/control.ts"
import { assertProtocol, encodeFrame, FrameDecoder, FrameError } from "../src/daemon/framing.ts"
import { DAEMON_PROTOCOL, type HaltReason, type RefusalCode } from "../src/daemon/protocol.ts"
import { Telemetry } from "../src/daemon/telemetry.ts"
import {
  createProductionRuntime,
  observeProductionRuntime,
  RUNTIME_GATE_DISABLED,
  runtimeFactsFrom,
} from "../src/runtime/production-runtime.ts"
import {
  advertisedRuntimeCapabilities,
  capabilityAvailable,
  createRequirementMap,
  EMPTY_REQUIREMENT_MAP,
  RUNTIME_CAPABILITIES,
  type RuntimeCapability,
} from "../src/runtime/runtime-capabilities.ts"
import {
  createDiagnosticBuffer,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_RECORDS,
} from "../src/runtime/runtime-diagnostics.ts"
import {
  admitDurableWork,
  deriveRuntimeView,
  evaluateResume,
  RUNTIME_ADMISSIONS,
  RUNTIME_HEALTHS,
  RUNTIME_PHASES,
  RUNTIME_TERMINATIONS,
  RuntimeContractError,
  type RuntimeEvidence,
  type RuntimeFacts,
  type RuntimePhase,
  type RuntimeView,
  validateRuntimeFacts,
} from "../src/runtime/runtime-status.ts"
import {
  absentRuntimeView,
  currentRuntimeView,
  installRuntimeStatusProvider,
} from "../src/runtime/runtime-status-provider.ts"
import type { FailureClassification } from "../src/runtime/supervisor.ts"
import type { SchedulerState } from "../src/task/scheduler.ts"

const repoRoot = process.cwd()

// ── HelperConstruction ───────────────────────────────────────────────────────

function evidence(over: Partial<RuntimeEvidence> = {}): RuntimeEvidence {
  return {
    gateEnabled: true,
    constructed: true,
    closed: false,
    journalWritable: true,
    storeOpen: true,
    schedulerAttached: true,
    supervisorAttached: false,
    // P13.1: runtime tanpa supervisi TIDAK mengharapkan supervisi — jadi
    // statusnya boleh HEALTHY (tanpa runtime P13.2, proses memang tak
    // disupervisi). P13.2 mengaktifkan expectations ini lewat komposisi.
    supervisionExpected: false,
    pendingJournalAppends: 0,
    ...over,
  }
}

const FULL_ATTACHMENT = {
  journal: true,
  taskStore: true,
  scheduler: true,
  supervisor: false,
} as const

function facts(over: Partial<RuntimeFacts> = {}): RuntimeFacts {
  return {
    phase: "ACTIVE",
    termination: "NONE",
    evidence: evidence(),
    attachment: FULL_ATTACHMENT,
    supervisedChildren: 0,
    ...over,
  }
}

function view(over: Partial<RuntimeFacts> = {}): RuntimeView {
  return deriveRuntimeView(facts(over))
}

// ── Tipe: pemisahan kosakata (dicek saat compile) ───────────────────────────

type IsAssignable<A, B> = A extends B ? true : false

describe("P13.1 — pemisahan kosakata (dicek saat compile)", () => {
  test("RefusalCode bukan penyebab kegagalan runtime", () => {
    const ok: IsAssignable<RefusalCode, FailureClassification> = false
    expect(ok).toBe(false)
  })

  test("RefusalCode bukan HaltReason", () => {
    const ok: IsAssignable<RefusalCode, HaltReason> = false
    expect(ok).toBe(false)
  })

  test("HaltReason bukan FailureClassification", () => {
    const ok: IsAssignable<HaltReason, FailureClassification> = false
    expect(ok).toBe(false)
  })

  test("SchedulerState bukan fase runtime (tak diduplikasi)", () => {
    const ok: IsAssignable<SchedulerState, RuntimePhase> = false
    expect(ok).toBe(false)
  })

  test("empat sumbu punya kosakata terpisah", () => {
    expect(RUNTIME_PHASES).toEqual(["ABSENT", "STARTING", "ACTIVE", "STOPPING", "STOPPED"])
    expect(RUNTIME_ADMISSIONS).toEqual(["ALLOW", "SCOPED", "REFUSE"])
    expect(RUNTIME_HEALTHS).toEqual(["HEALTHY", "DEGRADED", "UNHEALTHY", "UNKNOWN"])
    // UNKNOWN = ketidakpastian bukti, BUKAN outcome terminal.
    expect(RUNTIME_TERMINATIONS).toEqual(["NONE", "REQUESTED", "HALTED", "FAILED"])
    expect(RUNTIME_TERMINATIONS).not.toContain("UNKNOWN")
    // Tak ada nilai yang dipakai dua sumbu.
    const all = [
      ...RUNTIME_PHASES,
      ...RUNTIME_ADMISSIONS,
      ...RUNTIME_HEALTHS,
      ...RUNTIME_TERMINATIONS,
    ]
    expect(new Set(all).size).toBe(all.length)
  })
})

// ── Transisi lifecycle ──────────────────────────────────────────────────────

describe("P13.1 — transisi lifecycle", () => {
  test("ABSENT: tak ada runtime → tolak semua kerja baru", () => {
    const v = view({
      phase: "ABSENT",
      evidence: evidence({
        gateEnabled: false,
        constructed: false,
        closed: true,
        journalWritable: null,
        storeOpen: null,
        schedulerAttached: null,
      }),
      attachment: { journal: false, taskStore: false, scheduler: false, supervisor: false },
    })
    expect(v.phase).toBe("ABSENT")
    expect(v.admission).toBe("REFUSE")
    expect(v.health).toBe("UNKNOWN")
    expect(v.termination).toBe("NONE")
    expect(v.advertisedCapabilities).toEqual([])
  })

  test("STARTING: belum melayani → tolak, tak boleh dijalankan", () => {
    const v = view({ phase: "STARTING" })
    expect(v.admission).toBe("REFUSE")
    expect(v.health).toBe("UNKNOWN")
  })

  test("ACTIVE + bukti lengkap: boleh menerima kerja baru", () => {
    const v = view()
    expect(v.admission).toBe("ALLOW")
    expect(v.health).toBe("HEALTHY")
    expect(v.evidenceState).toBe("COMPLETE")
    expect(v.termination).toBe("NONE")
  })

  test("STOPPING: halt DIMINTA belum selesai — bukan HALTED", () => {
    const v = view({
      phase: "STOPPING",
      termination: "REQUESTED",
      haltReason: "SHUTTING_DOWN",
    })
    expect(v.termination).toBe("REQUESTED")
    expect(v.termination).not.toBe("HALTED")
    expect(v.admission).toBe("REFUSE")
    expect(v.health).toBe("DEGRADED")
  })

  test("STOPPED: halt selesai → HALTED + alasan", () => {
    const v = view({
      phase: "STOPPED",
      termination: "HALTED",
      haltReason: "SHUTTING_DOWN",
      evidence: evidence({ closed: true }),
    })
    expect(v.termination).toBe("HALTED")
    expect(v.haltReason).toBe("SHUTTING_DOWN")
    expect(v.admission).toBe("REFUSE")
  })

  test("FAILED: kegagalan tak pulih → unhealthy + tolak", () => {
    const v = view({
      phase: "STOPPED",
      termination: "FAILED",
      failure: "backend-failure",
      evidence: evidence({ closed: true }),
    })
    expect(v.health).toBe("UNHEALTHY")
    expect(v.admission).toBe("REFUSE")
    expect(v.failure).toBe("backend-failure")
  })
})

// ── Bukti: positif, hilang, basi ────────────────────────────────────────────

describe("P13.1 — bukti readiness", () => {
  test("bukti positif lengkap → COMPLETE + ALLOW", () => {
    const v = view()
    expect(v.evidenceState).toBe("COMPLETE")
    expect(v.availableCapabilities).toEqual([
      "durable-journal",
      "durable-task-store",
      "task-scheduler",
    ])
    expect(v.unavailableCapabilities).toEqual([])
  })

  test("bukti hilang (null) → MISSING → fail closed", () => {
    const v = view({ evidence: evidence({ journalWritable: null }) })
    expect(v.evidenceState).toBe("MISSING")
    expect(v.admission).toBe("REFUSE")
    expect(v.health).toBe("UNKNOWN")
  })

  test("bukti tak diketahui untuk kapabilitas yang tak diiklankan tak merusak readiness", () => {
    // Supervisor tak diiklankan (P13.2 belum attach) → `supervisorAttached`
    // boleh null/berubah tanpa menggagalkan readiness.
    const v = view({
      evidence: evidence({ supervisorAttached: null }),
      attachment: { journal: true, taskStore: true, scheduler: true, supervisor: false },
    })
    expect(v.evidenceState).toBe("COMPLETE")
    expect(v.admission).toBe("ALLOW")
    expect(v.advertisedCapabilities).not.toContain("process-supervision")
  })

  test("bukti basi (tertutup saat masih ACTIVE) → STALE → fail closed", () => {
    const v = view({ evidence: evidence({ closed: true }) })
    expect(v.evidenceState).toBe("STALE")
    expect(v.admission).toBe("REFUSE")
    expect(v.health).toBe("UNKNOWN")
  })

  test("kapabilitas diklaim tapi tak tersedia → DEGRADED + SCOPED", () => {
    const v = view({ evidence: evidence({ journalWritable: false }) })
    expect(v.evidenceState).toBe("COMPLETE")
    expect(v.health).toBe("DEGRADED")
    expect(v.admission).toBe("SCOPED")
    expect(v.unavailableCapabilities).toEqual(["durable-journal"])
    expect(v.availableCapabilities).toEqual(["durable-task-store", "task-scheduler"])
  })
})

// ── Legalitas kombinasi status/reason ───────────────────────────────────────

describe("P13.1 — kombinasi status/reason yang sah", () => {
  test("kombinasi sah tak melempar", () => {
    expect(validateRuntimeFacts(facts({ phase: "ABSENT", termination: "NONE" }))).toEqual([])
    expect(
      validateRuntimeFacts(
        facts({ phase: "STOPPING", termination: "REQUESTED", haltReason: "SHUTTING_DOWN" }),
      ),
    ).toEqual([])
    expect(
      validateRuntimeFacts(
        facts({ phase: "STOPPED", termination: "HALTED", haltReason: "REVOKED" }),
      ),
    ).toEqual([])
    expect(
      validateRuntimeFacts(facts({ phase: "STOPPED", termination: "FAILED", failure: "timeout" })),
    ).toEqual([])
  })

  test("alasan halt tanpa terminasi halts → pelanggaran", () => {
    const violations = validateRuntimeFacts(facts({ haltReason: "SHUTTING_DOWN" }))
    expect(violations.length).toBeGreaterThan(0)
    expect(() => deriveRuntimeView(facts({ haltReason: "SHUTTING_DOWN" }))).toThrow(
      RuntimeContractError,
    )
  })

  test("kegagalan tanpa terminasi FAILED → pelanggaran", () => {
    expect(validateRuntimeFacts(facts({ failure: "timeout" })).length).toBeGreaterThan(0)
  })

  test("kedua alasan sekaligus → pelanggaran", () => {
    const violations = validateRuntimeFacts(
      facts({ phase: "STOPPED", termination: "FAILED", haltReason: "REVOKED", failure: "timeout" }),
    )
    expect(violations.length).toBeGreaterThan(0)
  })

  test("REQUESTED hanya sah di STOPPING", () => {
    expect(
      validateRuntimeFacts(
        facts({ phase: "ACTIVE", termination: "REQUESTED", haltReason: "SHUTTING_DOWN" }),
      ).length,
    ).toBeGreaterThan(0)
  })

  test("HALTED/FAILED hanya sah di STOPPED", () => {
    expect(
      validateRuntimeFacts(
        facts({ phase: "ACTIVE", termination: "HALTED", haltReason: "SHUTTING_DOWN" }),
      ).length,
    ).toBeGreaterThan(0)
    expect(
      validateRuntimeFacts(facts({ phase: "ACTIVE", termination: "FAILED", failure: "timeout" }))
        .length,
    ).toBeGreaterThan(0)
  })

  test("STOPPED tanpa terminasi → kontradiksi", () => {
    expect(validateRuntimeFacts(facts({ phase: "STOPPED" })).length).toBeGreaterThan(0)
  })

  test("ABSENT tak boleh punya terminasi", () => {
    expect(
      validateRuntimeFacts(facts({ phase: "ABSENT", termination: "FAILED", failure: "orphan" }))
        .length,
    ).toBeGreaterThan(0)
  })

  test("error kontrak memuat daftar pelanggaran", () => {
    try {
      deriveRuntimeView(facts({ phase: "ACTIVE", termination: "FAILED", failure: "timeout" }))
      throw new Error("harus melempar")
    } catch (e) {
      expect(e).toBeInstanceOf(RuntimeContractError)
      const err = e as RuntimeContractError
      expect(err.violations.length).toBeGreaterThan(0)
      expect(err.message).toContain("kontrak runtime dilanggar")
    }
  })
})

// ── Admission kerja durable (SCOPED fail-closed) ────────────────────────────

describe("P13.1 — admission kerja durable", () => {
  const reqs = createRequirementMap([
    { workKind: "uji.jurnal", requiredCapabilities: ["durable-journal"] },
    { workKind: "uji.taskstore", requiredCapabilities: ["durable-task-store"] },
  ])

  test("runtime sehat + peta eksplisit → ALLOW", () => {
    const d = admitDurableWork(view(), { workKind: "uji.jurnal", requirements: reqs })
    expect(d.admission).toBe("ALLOW")
    expect(d.missingCapabilities).toEqual([])
  })

  test("runtime degraded + kebutuhan yang masih tersedia → SCOPED", () => {
    const degraded = view({ evidence: evidence({ journalWritable: false }) })
    const d = admitDurableWork(degraded, { workKind: "uji.taskstore", requirements: reqs })
    expect(d.admission).toBe("SCOPED")
    expect(d.requiredCapabilities).toEqual(["durable-task-store"])
    expect(d.missingCapabilities).toEqual([])
  })

  test("runtime degraded + kebutuhan yang tak tersedia → REFUSE + sebut mana", () => {
    const degraded = view({ evidence: evidence({ journalWritable: false }) })
    const d = admitDurableWork(degraded, { workKind: "uji.jurnal", requirements: reqs })
    expect(d.admission).toBe("REFUSE")
    expect(d.missingCapabilities).toEqual(["durable-journal"])
    expect(d.reason).toContain("durable-journal")
  })

  test("tanpa peta eksplisit → REFUSE (nama jenis kerja bukan bukti)", () => {
    const d = admitDurableWork(view(), { workKind: "apa.saja", requirements: reqs })
    expect(d.admission).toBe("REFUSE")
    expect(d.reason).toContain("peta eksplisit")
  })

  test("runtime sehat tanpa peta → tetap REFUSE (fail-closed seragam)", () => {
    const d = admitDurableWork(view(), {
      workKind: "apa.saja",
      requirements: EMPTY_REQUIREMENT_MAP,
    })
    expect(d.admission).toBe("REFUSE")
  })

  test("runtime tak siap → REFUSE apa pun jenis kerjanya", () => {
    const stopped = view({
      phase: "STOPPED",
      termination: "HALTED",
      haltReason: "SHUTTING_DOWN",
      evidence: evidence({ closed: true }),
    })
    const d = admitDurableWork(stopped, { workKind: "uji.jurnal", requirements: reqs })
    expect(d.admission).toBe("REFUSE")
  })

  test("peta produksi P13.1 kosong — tak ada kelas kerja yang dikarang", () => {
    expect(EMPTY_REQUIREMENT_MAP.size).toBe(0)
  })
})

// ── Lanjut / resume (C2) ────────────────────────────────────────────────────

describe("P13.1 — lanjut vs tahan", () => {
  test("bukti positif lengkap → boleh lanjut", () => {
    const d = evaluateResume({
      runtimeStateCurrent: true,
      storageUsable: true,
      leaseValid: true,
      authorityCurrent: true,
    })
    expect(d.resume).toBe(true)
    expect(d.missing).toEqual([])
    expect(d.recordRetained).toBe(true)
  })

  test("salah satu bukti hilang → TAHAN, dan record tetap tersimpan", () => {
    const d = evaluateResume({
      runtimeStateCurrent: true,
      storageUsable: true,
      leaseValid: null,
      authorityCurrent: true,
    })
    expect(d.resume).toBe(false)
    expect(d.missing).toEqual(["leaseValid"])
    // Record durable bertahan walau eksekusi ditahan.
    expect(d.recordRetained).toBe(true)
  })

  test("bukti negatif (bukan sekadar tak diketahui) → TAHAN", () => {
    const d = evaluateResume({
      runtimeStateCurrent: false,
      storageUsable: true,
      leaseValid: true,
      authorityCurrent: true,
    })
    expect(d.resume).toBe(false)
    expect(d.missing).toEqual(["runtimeStateCurrent"])
    expect(d.recordRetained).toBe(true)
  })

  test("tak satu pun bukti → TAHAN + semua yang kurang disebut", () => {
    const d = evaluateResume({
      runtimeStateCurrent: null,
      storageUsable: null,
      leaseValid: null,
      authorityCurrent: null,
    })
    expect(d.resume).toBe(false)
    expect(d.missing).toEqual([
      "runtimeStateCurrent",
      "storageUsable",
      "leaseValid",
      "authorityCurrent",
    ])
  })
})

// ── Deklarasi kapabilitas ───────────────────────────────────────────────────

describe("P13.1 — deklarasi kapabilitas runtime", () => {
  test("kosakata kapabilitas bersifat kanonik dan lengkap", () => {
    expect(RUNTIME_CAPABILITIES).toEqual([
      "durable-journal",
      "durable-task-store",
      "task-scheduler",
      "process-supervision",
    ])
    // Setiap kapabilitas punya aturan ketersediaan (tak ada cabang luput).
    for (const c of RUNTIME_CAPABILITIES) {
      expect(
        capabilityAvailable(c, {
          journalWritable: true,
          storeOpen: true,
          schedulerAttached: true,
          supervisorAttached: true,
        }),
      ).toBe(true)
    }
  })

  test("supervision TAK diiklankan sebelum benar-benar terpasang", () => {
    const caps = advertisedRuntimeCapabilities({
      journal: true,
      taskStore: true,
      scheduler: true,
      supervisor: false,
    })
    expect(caps).toEqual(["durable-journal", "durable-task-store", "task-scheduler"])
    expect(caps).not.toContain("process-supervision")
  })

  test("supervision diiklankan hanya setelah terpasang (P13.2)", () => {
    const caps = advertisedRuntimeCapabilities({
      journal: true,
      taskStore: true,
      scheduler: true,
      supervisor: true,
    })
    expect(caps).toContain("process-supervision")
  })

  test("bukti tak diketahui = kapabilitas TAK tersedia (fail-closed)", () => {
    expect(
      capabilityAvailable("durable-journal", {
        journalWritable: null,
        storeOpen: true,
        schedulerAttached: true,
        supervisorAttached: null,
      }),
    ).toBe(false)
    expect(
      capabilityAvailable("durable-journal", {
        journalWritable: true,
        storeOpen: true,
        schedulerAttached: true,
        supervisorAttached: null,
      }),
    ).toBe(true)
  })

  test("kapabilitas tak pernah disimpulkan dari namanya", () => {
    // Nama kapabilitas apa pun tak otomatis jadi kapabilitas yang tersedia.
    const all: RuntimeCapability[] = ["durable-journal", "durable-task-store", "task-scheduler"]
    for (const c of all) {
      expect(
        capabilityAvailable(c, {
          journalWritable: null,
          storeOpen: null,
          schedulerAttached: null,
          supervisorAttached: null,
        }),
      ).toBe(false)
    }
  })
})

// ── Buffer diagnostik ───────────────────────────────────────────────────────

describe("P13.1 — retensi diagnostik", () => {
  test("batas rekaman 512; sisanya dibuang dan itu TERLIHAT", () => {
    const buf = createDiagnosticBuffer({ now: () => 1 })
    for (let i = 0; i < 600; i++) buf.record("uji", `r${i}`)
    const snap = buf.snapshot()
    expect(snap.records.length).toBe(MAX_DIAGNOSTIC_RECORDS)
    expect(snap.dropped).toBe(600 - MAX_DIAGNOSTIC_RECORDS)
    expect(snap.truncated).toBe(true)
    // Celah history bisa dibaca: rekaman tertua tak lagi nomor 1.
    expect(snap.sinceSeq).toBe(600 - MAX_DIAGNOSTIC_RECORDS + 1)
    expect(snap.records[0]?.seq).toBe(snap.sinceSeq)
  })

  test("batas byte 1 MiB ditegakkan lebih dulu bila record besar", () => {
    const buf = createDiagnosticBuffer({ maxBytes: 1024, now: () => 1 })
    for (let i = 0; i < 50; i++) buf.record("uji", "x".repeat(200))
    const snap = buf.snapshot()
    expect(snap.bytes).toBeLessThanOrEqual(1024)
    expect(snap.truncated).toBe(true)
    expect(snap.dropped).toBeGreaterThan(0)
  })

  test("tanpa pembuangan → truncated = false", () => {
    const buf = createDiagnosticBuffer({ now: () => 1 })
    buf.record("uji", "a")
    const snap = buf.snapshot()
    expect(snap.truncated).toBe(false)
    expect(snap.dropped).toBe(0)
    expect(snap.records.length).toBe(1)
  })

  test("batas bawaan = 512 rekaman / 1 MiB", () => {
    expect(MAX_DIAGNOSTIC_RECORDS).toBe(512)
    expect(MAX_DIAGNOSTIC_BYTES).toBe(1024 * 1024)
  })

  test("clear() mengosongkan buffer dan mereset penanda truncation", () => {
    const buf = createDiagnosticBuffer({ maxRecords: 2, now: () => 1 })
    buf.record("a")
    buf.record("b")
    buf.record("c")
    expect(buf.snapshot().truncated).toBe(true)
    buf.clear()
    const snap = buf.snapshot()
    expect(snap.records).toEqual([])
    expect(snap.dropped).toBe(0)
    expect(snap.truncated).toBe(false)
    expect(snap.bytes).toBe(0)
  })
})

// ── Jembatan handle produksi ────────────────────────────────────────────────

describe("P13.1 — jembatan handle produksi → fakta", () => {
  test("gate tertutup → fase ABSENT, tak ada yang dibangun", async () => {
    let built = false
    const handle = await createProductionRuntime(RUNTIME_GATE_DISABLED, () => {
      built = true
      throw new Error("tak boleh dipanggil saat gate tertutup")
    })
    expect(built).toBe(false)
    const factsFromHandle = observeProductionRuntime(handle)
    expect(factsFromHandle.phase).toBe("ABSENT")
    expect(factsFromHandle.termination).toBe("NONE")
    const v = deriveRuntimeView(factsFromHandle)
    expect(v.admission).toBe("REFUSE")
    expect(v.advertisedCapabilities).toEqual([])
  })

  const base = {
    enabled: true,
    constructed: true,
    closed: false,
    admissionOpen: true,
    durable: true,
    journalAppendFailures: 0,
    pendingJournalAppends: 0,
    supervisionEstablished: false,
    supervisorAttached: false,
    supervisedChildren: 0,
  } as const

  test("serving → fase ACTIVE, tak ada terminasi", () => {
    const f = runtimeFactsFrom({ ...base })
    expect(f.phase).toBe("ACTIVE")
    expect(f.termination).toBe("NONE")
    expect(f.haltReason).toBeUndefined()
    expect(f.evidence.journalWritable).toBe(true)
  })

  test("gate menyala tapi runtime belum dibangun → STARTING", () => {
    const f = runtimeFactsFrom({ ...base, constructed: false })
    expect(f.phase).toBe("STARTING")
    expect(f.termination).toBe("NONE")
  })

  test("admission tertutup tapi belum selesai → STOPPING + REQUESTED", () => {
    const f = runtimeFactsFrom({ ...base, admissionOpen: false })
    expect(f.phase).toBe("STOPPING")
    expect(f.termination).toBe("REQUESTED")
    expect(f.haltReason).toBe("SHUTTING_DOWN")
  })

  test("sudah tertutup → STOPPED + HALTED", () => {
    const f = runtimeFactsFrom({ ...base, closed: true })
    expect(f.phase).toBe("STOPPED")
    expect(f.termination).toBe("HALTED")
    expect(f.haltReason).toBe("SHUTTING_DOWN")
  })

  test("runtime non-durable → jurnal tak tersedia (bukan 'false')", () => {
    const f = runtimeFactsFrom({ ...base, durable: false })
    expect(f.evidence.journalWritable).toBeNull()
    expect(f.attachment.journal).toBe(false)
  })

  test("append jurnal gagal → jurnal TAK writable (degradasi nyata)", () => {
    const f = runtimeFactsFrom({ ...base, journalAppendFailures: 3 })
    expect(f.evidence.journalWritable).toBe(false)
  })

  test("scheduler/store tak diketahui → null (bukan 'true')", () => {
    const f = runtimeFactsFrom({ ...base })
    expect(f.evidence.schedulerAttached).toBeNull()
    expect(f.evidence.storeOpen).toBeNull()
    expect(f.evidence.supervisorAttached).toBe(false)
    // Tak ada kapabilitas task yang diklaim tanpa bukti.
    expect(f.attachment.taskStore).toBe(false)
    expect(f.attachment.scheduler).toBe(false)
    expect(f.attachment.supervisor).toBe(false)
  })
})

// ── Seam DI status ──────────────────────────────────────────────────────────

describe("P13.1 — seam status runtime", () => {
  test("tanpa penyedia → view ABSENT kanonik (bukan error, bukan tebakan)", () => {
    const v = currentRuntimeView()
    expect(v.phase).toBe("ABSENT")
    expect(v.admission).toBe("REFUSE")
    expect(v.note).toContain("tak ada runtime terpasang")
  })

  test("view ABSENT tetap valid secara kontrak", () => {
    const v = absentRuntimeView("catatan uji")
    expect(v.phase).toBe("ABSENT")
    expect(v.evidenceState).toBe("COMPLETE")
    expect(v.note).toBe("catatan uji")
  })

  test("penyedia yang terpasang dipakai consumers (seam DI)", () => {
    installRuntimeStatusProvider(() => view())
    try {
      const v = currentRuntimeView()
      expect(v.phase).toBe("ACTIVE")
      expect(v.admission).toBe("ALLOW")
    } finally {
      installRuntimeStatusProvider(null)
    }
  })

  test("penyedia yang melempar tak menjatuhkan konsumen status", () => {
    installRuntimeStatusProvider(() => {
      throw new Error("penyedia rusak")
    })
    try {
      const v = currentRuntimeView()
      expect(v.phase).toBe("ABSENT")
      expect(v.admission).toBe("REFUSE")
      expect(v.note).toContain("penyedia status runtime gagal")
    } finally {
      installRuntimeStatusProvider(null)
    }
  })
})

// ── Pemetaan ke protokol daemon (op yang sudah ada) ─────────────────────────

describe("P13.1 — status runtime masuk ke op daemon yang sudah ada", () => {
  function deps(over: Partial<ControlDeps> = {}): ControlDeps {
    return {
      incarnation: "inc_t",
      actions: null,
      approvals: new ApprovalBroker({ incarnation: "inc_t", propose: () => {} }),
      telemetry: new Telemetry(),
      storageOk: () => true,
      shuttingDown: () => false,
      ...over,
    }
  }

  test("daemon.status menyajikan view kanonik runtime", () => {
    const out = dispatchControl(
      {
        consumerId: "c",
        scopes: ["read:session"],
        op: "daemon.status",
        idem: "i1",
        args: {},
      },
      deps({ runtimeStatus: () => view() }),
      new IdempotencyStore(),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const result = out.result as { runtime?: RuntimeView }
    expect(result.runtime).toBeDefined()
    expect(result.runtime?.phase).toBe("ACTIVE")
    expect(result.runtime?.admission).toBe("ALLOW")
    expect(result.runtime?.advertisedCapabilities).toEqual([
      "durable-journal",
      "durable-task-store",
      "task-scheduler",
    ])
  })

  test("tanpa penyedia → view ABSENT, bukan status karangan", () => {
    const out = dispatchControl(
      {
        consumerId: "c",
        scopes: ["read:session"],
        op: "daemon.status",
        idem: "i2",
        args: {},
      },
      deps(),
      new IdempotencyStore(),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const result = out.result as { runtime?: RuntimeView }
    expect(result.runtime?.phase).toBe("ABSENT")
    expect(result.runtime?.admission).toBe("REFUSE")
  })
})

// ── Kompatibilitas wire (perilaku yang DIVERIFIKASI dari kode nyata) ───────
//
// CAKupan klaim: apa yang terverifikasi di sini adalah PERILAKU KODE REPO INI.
// Klien DI LUAR repo tak terverifikasi (tidak ada sumbernya) — lihat catatan
// "batas klaim" di bawah. Klaim kompatibilitas eksternal tetap TERKUALIFIKASI.

describe("P13.1 — kompatibilitas wire (perilaku terverifikasi)", () => {
  test("control op tak dikenal → penolakan per operasi (PROTOCOL_ERROR), bukan crash", () => {
    const out = dispatchControl(
      {
        consumerId: "c",
        scopes: ["admin"],
        op: "runtime.status.v2",
        idem: "i-unknown",
        args: {},
      },
      {
        incarnation: "inc_t",
        actions: null,
        approvals: new ApprovalBroker({ incarnation: "inc_t", propose: () => {} }),
        telemetry: new Telemetry(),
        storageOk: () => true,
        shuttingDown: () => false,
      },
      new IdempotencyStore(),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.refusal.code).toBe("PROTOCOL_ERROR")
    expect(out.refusal.message).toContain("operasi tak dikenal")
  })

  test("nomor protokol dicocokkan PERSIS → bump versi akan memutus klien lama", () => {
    // Bukti bahwa tambahan aditif TIDAK boleh menaikkan versi: versi yang
    // tak cocok ditolak, jadi menaikkan versi = memutus konsumen lama.
    expect(() => assertProtocol({ t: "hello", protocol: DAEMON_PROTOCOL })).not.toThrow()
    expect(() => assertProtocol({ t: "hello", protocol: DAEMON_PROTOCOL + 1 })).toThrow(FrameError)
  })

  test("klien daemon meneruskan message tak dikenal tanpa crash", async () => {
    // Perilaku terverifikasi di src/daemon/client.ts: pesan di-cast tanpa
    // validasi runtime dan SETIAP pesan diteruskan ke listener — hanya
    // `control_result` yang diproses khusus. Jadi message `t` tak dikenal
    // sampai ke consumer (tak swallowed diam-diam).
    const server = createServer((sock) => {
      const dec = new FrameDecoder()
      sock.on("data", (chunk: Buffer) => {
        for (const _ of dec.push(chunk)) {
          sock.write(
            encodeFrame({
              t: "welcome",
              protocol: DAEMON_PROTOCOL,
              incarnation: "inc_x",
              scopes: [],
              consumer: "c",
            }),
          )
          // Dikirim sedikit setelahnya supaya listener consumer sudah terpasang.
          setTimeout(() => {
            sock.write(encodeFrame({ t: "runtime_status_v2", payload: 1 }))
          }, 50)
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const addr = server.address() as AddressInfo
    const client = await DaemonClient.connect({
      target: { host: "127.0.0.1", port: addr.port },
      capability: "cap",
      consumer: "c",
    })
    const seen: string[] = []
    let closed = false
    let protocolError = false
    client.on((e) => {
      if (e.kind === "message") seen.push(e.msg.t)
      if (e.kind === "closed") closed = true
      if (e.kind === "protocol-error") protocolError = true
    })
    await Bun.sleep(200)
    expect(seen).toContain("runtime_status_v2")
    expect(closed).toBe(false)
    expect(protocolError).toBe(false)
    client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

// ── Batas eksplisit P13.1 ───────────────────────────────────────────────────

describe("P13.1 — batas yang TIDAK boleh diklaim oleh tes ini", () => {
  const p13Files = [
    "src/runtime/runtime-status.ts",
    "src/runtime/runtime-capabilities.ts",
    "src/runtime/runtime-diagnostics.ts",
    "src/runtime/runtime-status-provider.ts",
  ]

  test("modul kontrak P13.1 tak menjalankan proses apa pun", () => {
    // Guardkeeper bentuk: kalau suatu saat modul kontrak ikut menyentuh proses
    // anak, klaim "P13.1 tak membuktikan cleanup proses produksi" jadi tak
    // berlaku dan harus ditinjau ulang.
    for (const f of p13Files) {
      const src = readFileSync(join(repoRoot, f), "utf8")
      expect(src).not.toMatch(/\bspawn\(|\bspawnSync\(|Bun\.spawn\(|\bexecFile\(/)
      expect(src).not.toMatch(/child_process/)
    }
  })

  test("modul kontrak P13.1 tak menyentuh task store / durable recovery", () => {
    // Pemulihan task durable = P13.3; modul kontrak tidak boleh diam-diam
    // menjadi jalur pemulihan kedua.
    for (const f of p13Files) {
      const src = readFileSync(join(repoRoot, f), "utf8")
      expect(src).not.toMatch(/from "\.\.\/task\/store\.ts"/)
      expect(src).not.toMatch(/from "\.\.\/session\/journal\.ts"/)
    }
  })
})
