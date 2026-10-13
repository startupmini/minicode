// P9.1 — Batas kontrak admission (ADR M7: MODE-SPECIFIC CONTRACTS, REUSE ONLY
// EQUIVALENT RULES). Test ini memakuk kontrak yang DIPUTUSKAN owner:
// - Delegate & autonomous = DUA kontrak admission, sengaja berbeda.
// - Aturan yang ekuivalen eksak: cap fallback delegate == cap mode M7
//   (keduanya membaca konstanta yang sama). Cabang eksplisit delegate TIDAK
//   diklamp mode (≠ M7) — itu perbedaan yang disengaja.
// - Autonomous TIDAK mengonsumsi M7: mode-less readonly + default 8 tak
//   representable tanpa mengarang mode/grant/korelasi.
// - Tidak ada artefak otorisasi yang difabrikasi.
// - Backend eksekusi tetap dormant (R1 gate): tak ada pemanggil start produksi.
//
// Jalur delegate diuji lewat BATAS PRODUKSI nyata (delegateTaskTool.execute +
// setSubAgentSessionFactory), bukan mock paralel. Guard lain memindai sumber
// dengan pola yang sama seperti test M7/M16 repo ini.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LIMITS } from "../src/constants.ts"
import { createGrant } from "../src/runtime/capability.ts"
import { admitChild } from "../src/runtime/child-execution.ts"
import { createRootCorrelation } from "../src/runtime/execution-id.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  EXPLORE_TOOL_NAMES,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p91-"))
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

const ctxFor = (cwd: string, permissionMode?: string) =>
  ({
    signal: new AbortController().signal,
    emit: () => {},
    cwd,
    ...(permissionMode ? { permissionMode } : {}),
  }) as never

/** Factory nyata yang merekam spec anak (spec = input yang mengalir ke sesi anak). */
function recordingFactory(seen: SubAgentSpec[]) {
  return async (spec: SubAgentSpec) => {
    seen.push(spec)
    return {
      events: { on: () => () => {} },
      run: async () => ({ finalText: "ringkasan anak", usage: { steps: 2 } }),
    }
  }
}

async function delegate(
  dir: string,
  args: Record<string, unknown>,
  permissionMode = "auto",
): Promise<SubAgentSpec> {
  const seen: SubAgentSpec[] = []
  setSubAgentSessionFactory(recordingFactory(seen))
  await delegateTaskTool.execute(args as never, ctxFor(dir, permissionMode))
  clearSubAgentSessionFactory()
  if (seen.length === 0) throw new Error("factory anak tidak dipanggil")
  return seen[0]!
}

const read = (p: string) => Bun.file(p).text()

/** Kode tanpa komentar (// baris + /* blok) — agar penyebutan di komentar
 * dokumentasi tak dianggap pemakaian kode. Kenapa: task.ts menyebut
 * `saveSession` di komentar §4 dan child-execution.ts menyebut `tools/task`
 * di header ADR — bisher beide keine Code-Nutzung sind. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
}

/** Spesifier import statis + dynamic (tanpa komentar) — batas arsitektur
 * menilai dependensi modul, bukan penyebutan dokumentasi. */
function importSpecifiers(src: string): string[] {
  const code = codeOnly(src)
  const out: string[] = []
  for (const m of code.matchAll(/from\s+["']([^"']+)["']/g)) out.push(m[1]!)
  for (const m of code.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!)
  return out
}

/** Fixture admission M7 yang valid (M1 + M6 asli, bukan rakitan string):
 * parent via allocator M1, grant via createGrant M6. */
function validAdmissionFixture(mode: "explore" | "plan") {
  const ownerId = "sess-p91"
  const parent = createRootCorrelation("turn", ownerId)
  const parentGrant = createGrant({
    executionId: parent.executionId,
    ownerId,
    capabilities: [{ operation: "read", resource: { kind: "fs", path: "/repo" } }],
    provenance: { requestedBy: "test", authorizedBy: "policy:test", reason: "p91-equivalence" },
  })
  return {
    kind: "child" as const,
    ownerId,
    parent,
    parentGrant,
    mode,
    requestedCapabilities: [],
    workspaceCwd: "/repo",
    parentWorkspaceCwd: "/repo",
  }
}

// ── A. Otoritas admission independen ─────────────────────────────────────────
// Invarian: delegate tetap butuh intent durabel + lease anak; autonomous tetap
// butuh claim atomik. M7 TIDAK mengganti salah satunya.
test("A1 delegate: intent durabel + lease anak + lineage tetap ada di jalur produksi", async () => {
  const src = await read("src/tools/task.ts")
  // Mekanisme otorisasi/ownership eksis di jalur delegate (bukan dialihkan ke M7).
  for (const required of [
    "persistEffectIntent",
    "persistEffectReceipt",
    "acquireSessionWriter",
    "createChildSession",
    "releaseSessionWriter",
    "REFUSED_VERIFICATION_EVIDENCE",
    "REFUSED_CHILD_SESSION_PERSISTENCE",
  ]) {
    expect(src.includes(required), required).toBe(true)
  }
  // M7 bukan gerbang admission delegate: tak diimpor/dipanggil di task.ts.
  expect(src.includes("child-execution")).toBe(false)
  expect(src.includes("admitChild")).toBe(false)
})

test("A2 autonomous: claim atomik TaskStore tetap ada; M7 tidak dipakai", async () => {
  const scheduler = await read("src/task/scheduler.ts")
  const autonomous = await read("src/task/autonomous-context.ts")
  const adapter = await read("src/task/autonomous-adapter.ts")
  expect(scheduler.includes("claimTask(")).toBe(true)
  expect(scheduler.includes("recordAttemptReturned")).toBe(true)
  for (const [name, src] of [
    ["scheduler.ts", scheduler],
    ["autonomous-context.ts", autonomous],
    ["autonomous-adapter.ts", adapter],
  ] as const) {
    expect(src.includes("child-execution"), `${name} → child-execution`).toBe(false)
    expect(src.includes("admitChild"), `${name} → admitChild`).toBe(false)
  }
})

// ── B. Kontrak eksekusi berbeda ──────────────────────────────────────────────
// Invarian: fallback delegate == cap mode M7 (konstanta sama); eksplisit tetap
// min(req,50); autonomous tetap readonly + default 8; tak ada M7 di autonomous.
test("B1 delegate fallback cap == konstanta mode (ekuivalen M7 modeStepCap)", async () => {
  const restore = providerEnv()
  try {
    todoSession.id = "p91-b1"
    const explore = await delegate(tmpRoot(), { prompt: "x" })
    expect(explore.maxSteps).toBe(LIMITS.SUB_AGENT_BUDGET_EXPLORE)
    const plan = await delegate(tmpRoot(), { prompt: "x", mode: "plan" })
    expect(plan.maxSteps).toBe(LIMITS.SUB_AGENT_BUDGET_PLAN)
  } finally {
    restore()
  }
})

test("B2 delegate cap eksplisit TIDAK diklamp mode (≠ M7), clamp hard-cap 50", async () => {
  const restore = providerEnv()
  try {
    todoSession.id = "p91-b2"
    // M7 untuk input ini memberi min(40, cap explore=5) = 5. Delegate memberi 40.
    // Perbedaan yang DISENGAJA — menyamakannya = perubahan perilaku (butuh ADR).
    const wide = await delegate(tmpRoot(), { prompt: "x", mode: "explore", maxSteps: 40 })
    expect(wide.maxSteps).toBe(40)
    expect(wide.maxSteps).not.toBe(LIMITS.SUB_AGENT_BUDGET_EXPLORE)
    const over = await delegate(tmpRoot(), { prompt: "x", mode: "plan", maxSteps: 999 })
    expect(over.maxSteps).toBe(LIMITS.DEFAULT_MAX_STEPS)
  } finally {
    restore()
  }
})

test("B3 delegate timeout ceiling tetap SUB_AGENT_TIMEOUT_MS", async () => {
  const restore = providerEnv()
  try {
    todoSession.id = "p91-b3"
    const spec = await delegate(tmpRoot(), { prompt: "x" })
    expect(spec.timeoutMs).toBe(LIMITS.SUB_AGENT_TIMEOUT_MS)
  } finally {
    restore()
  }
})

test("B4 paksa-explore saat parent readonly/plan/ask (mode anak = explore)", async () => {
  const restore = providerEnv()
  try {
    todoSession.id = "p91-b4"
    for (const parentMode of ["readonly", "plan", "ask"]) {
      const spec = await delegate(tmpRoot(), { prompt: "x", mode: "plan" }, parentMode)
      const names = spec.tools.map((t) => t.name).sort()
      expect(names, parentMode).toEqual([...EXPLORE_TOOL_NAMES].sort())
    }
  } finally {
    restore()
  }
})

test("B5 ekuivalensi M7: budgetSteps == konstanta mode untuk input fallback setara", () => {
  // Fixture memakai M1/M6 asli (bukan id + grant rakitan): "exec_p" mentah
  // ditolak createChildCorrelation karena bukan id alokasi valid — itu perilaku
  // M1 yang benar, bukan cacat M7. requestedCapabilities kosong = subset dari
  // grant parent (M6), workspace sama = di dalam parent (M6 isPathWithin).
  const explore = admitChild(validAdmissionFixture("explore"))
  const plan = admitChild(validAdmissionFixture("plan"))
  expect(explore.admitted).toBe(true)
  expect(plan.admitted).toBe(true)
  if (explore.admitted) expect(explore.admission.budgetSteps).toBe(LIMITS.SUB_AGENT_BUDGET_EXPLORE)
  if (plan.admitted) expect(plan.admission.budgetSteps).toBe(LIMITS.SUB_AGENT_BUDGET_PLAN)
})

test("B6 autonomous: readonly tetap, default 8, ceiling 120_000, tanpa artefak M7", async () => {
  const src = await read("src/task/autonomous-context.ts")
  expect(src.includes('permissionMode: "readonly"')).toBe(true)
  expect(src.includes("maxSteps: this.config.maxSteps ?? 8")).toBe(true)
  expect(src.includes("timeoutMs: this.config.timeoutMs ?? 120_000")).toBe(true)
  // Tak mengarang mode M7, grant, atau korelasi M1.
  for (const forbidden of ["admitChild", "parentGrant", "createGrant", "createChildCorrelation"]) {
    expect(src.includes(forbidden), forbidden).toBe(false)
  }
})

// ── C. Ownership sesi & publikasi ────────────────────────────────────────────
// Invarian: histori anak tak bisa jadi histori kanonik parent lewat penulis
// alternatif; kepemilikan parent/anak terpisah; epoch/run guard tetap.
test("C1 jalur anak TIDAK menulis histori kanonik parent (tanpa penulis alternatif)", async () => {
  // Pindai kode tanpa komentar: task.ts menyebut `saveSession` di komentar
  // arsitektur §4 (materialisasi vs melewatkan kanonisasi) — itu dokumentasi,
  // bukan pemanggilan. Yang dilarang = import/pemanggilan aktual.
  for (const p of [
    "src/tools/task.ts",
    "src/task/scheduler.ts",
    "src/task/autonomous-context.ts",
    "src/task/autonomous-adapter.ts",
  ]) {
    const code = codeOnly(await read(p))
    expect(/\bsaveSession\s*\(/.test(code), `${p} → saveSession(`).toBe(false)
    expect(/\bshrinkThreadHistory\s*\(/.test(code), `${p} → shrinkThreadHistory(`).toBe(false)
    expect(
      importSpecifiers(code).some((s) => s.includes("session/persistence")),
      `${p} → import session/persistence`,
    ).toBe(p === "src/tools/task.ts")
  }
})

test("C2 kepemilikan anak terpisah: lease anak sendiri + sid anak", async () => {
  const src = await read("src/tools/task.ts")
  expect(src.includes("allocateChildSessionId")).toBe(true)
  expect(/acquireSessionWriter\(\{[\s\S]{0,120}sessionId:\s*childId/.test(src)).toBe(true)
  // Epoch anak tidak pernah memakai epoch parent (§15.6).
  expect(src.includes("childEpoch")).toBe(true)
})

test("C3 guard epoch/run tetap berlaku di jalur publikasi kanonik", async () => {
  const src = await read("src/session/persistence.ts")
  expect(src.includes("assertWriterEpochInTxn")).toBe(true)
  expect(src.includes("StaleWriterError")).toBe(true)
  // Satu penulis kanonik: saveSession diekspor hanya di sini (guard writer-inventory
  // juga memakuk ini; assertion di sini menjaga P9.1 tak menambah penulis baru).
  expect(src.includes("export async function saveSession")).toBe(true)
})

// ── D. Invarian lifecycle ────────────────────────────────────────────────────
// Invarian: anak attached tak outlive parent; ceiling timeout tetap; cancel/
// recovery tak berubah; hasil ≠ completion bisnis; scheduler dispatch-only.
test("D1 P9.1 tak memperkenalkan detached (attached-only) di produksi", async () => {
  for (const p of [
    "src/tools/task.ts",
    "src/task/scheduler.ts",
    "src/task/autonomous-context.ts",
    "src/task/autonomous-adapter.ts",
  ]) {
    const src = await read(p)
    expect(src.includes("detached"), `${p} → detached`).toBe(false)
  }
  // M7 default = attached (cancelScope parent) bila detached tak diberikan.
  const r = admitChild(validAdmissionFixture("explore"))
  expect(r.admitted).toBe(true)
  if (r.admitted) {
    expect(r.admission.detached).toBeNull()
    expect(r.admission.cancelScope).toEqual({ kind: "parent" })
  }
})

test("D2 scheduler tetap dispatch-only: tak menulis COMPLETED / verifikasi", async () => {
  const src = await read("src/task/scheduler.ts")
  // Tak ada penulisan status COMPLETED maupun klaim verifikasi.
  expect(/"COMPLETED"/.test(src)).toBe(false)
  expect(src.includes("recordAttemptReturned")).toBe(true)
  // Kanvas otorisasi completion tetap di TaskStore (reconcile), bukan scheduler.
  expect(src.includes("never writes COMPLETED")).toBe(true)
})

test("D3 cancel/recovery tak berubah: planParentCancellation tetap milik supervisor", async () => {
  const sup = await read("src/runtime/supervisor.ts")
  expect(sup.includes("planParentCancellation")).toBe(true)
  // P9.1 tak menambah otoritas pembatalan kedua di jalur anak.
  const task = await read("src/tools/task.ts")
  expect(task.includes("planParentCancellation")).toBe(false)
})

// ── E. Batas arsitektur ──────────────────────────────────────────────────────
// Invarian: autonomous tak memakai M7; M7 bebas dari otoritas kernel/backend/
// dispatch; tak ada grant/korelasi yang difabrikasi di jalur anak.
test("E1 M7 tetap murni: tak bergantung ke kernel/backend/dispatch/tools/task", async () => {
  // Pindai spesifier import, bukan substring mentah: header ADR child-execution.ts
  // menyebut `src/tools/task.ts` + `delegate_task` sebagai konteks sejarah —
  // itu dokumentasi, bukan dependensi. Batas M7 yang mengikat = impor modul.
  const src = await read("src/runtime/child-execution.ts")
  const specs = importSpecifiers(src)
  for (const forbidden of [
    "execution-kernel",
    "execution-backend",
    "dispatch.ts",
    "tools/task",
    "task/autonomous",
    "task/scheduler",
    "task/store",
    "session/persistence",
    "session/journal",
  ]) {
    expect(
      specs.some((s) => s.includes(forbidden)),
      `import ${forbidden}`,
    ).toBe(false)
  }
  const code = codeOnly(src)
  for (const forbidden of ["saveSession", "child_process", "Bun.spawn", "spawn("]) {
    expect(code.includes(forbidden), forbidden).toBe(false)
  }
})

test("E2 tak ada fabrikasi grant/korelasi M6/M1 di jalur anak produksi", async () => {
  for (const p of [
    "src/tools/task.ts",
    "src/task/scheduler.ts",
    "src/task/autonomous-context.ts",
    "src/task/autonomous-adapter.ts",
  ]) {
    const src = await read(p)
    for (const forbidden of ["createGrant(", "createChildCorrelation(", "parentGrant:"]) {
      expect(src.includes(forbidden), `${p} → ${forbidden}`).toBe(false)
    }
  }
})

test("E3 backend eksekusi tetap dormant: nol pemanggil start produksi (R1 gate)", async () => {
  // Pemanggil backend fisik hanya bidang runtime-plane: supervisor (eskalasi)
  // + composition (disposeAll). Tak ada `backend.start` / `.start({cmd`.
  const sup = await read("src/runtime/supervisor.ts")
  expect(sup.includes("backend.cancel(")).toBe(true)
  expect(sup.includes("backend.wait(")).toBe(true)
  expect(sup.includes("backend.dispose(")).toBe(true)
  expect(sup.includes(".start(")).toBe(false)
  const comp = await read("src/runtime/composition.ts")
  expect(comp.includes("disposeAll()")).toBe(true)
  expect(comp.includes("backend.start(")).toBe(false)
})
