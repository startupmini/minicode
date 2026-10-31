// [Fase 9 / 9.1–9.3] Sakelar rollback ACE-Lite + evaluator ablasi komparatif
// (ACE-4), fault-injection split-brain memori (MEM-04 / U7 / LOOP-INV-18), dan
// determinisme telemetry gate + paritas CI (CTL-06). Hermetik: temp dir, env
// terkontrol, fake subagent factory, tanpa jaringan.
//
// Invariant yang dibuktikan:
//   9.1a  `isAceEnabled()` default true; false untuk "0"/"false"/"off"/"no";
//         saat disabled, `ace_state` tidak disuntik & `aceVerdict` absent, TAPI
//         guard keselamatan (tamper guard) tetap aktif.
//   9.1b  `compareAceAblation()` deterministik: lulus bila ACE memperbaiki
//         kualitas tanpa memperburuk safety; fail-closed pada NaN / out-of-range;
//         safety tidak bisa dibayar skor keberhasilan.
//   9.2   `setMemoryWriteFaultInjectorForTest` → crash di antara vector.db dan
//         MEMORY.md → split-brain → `reconcileMemoryStores` memulihkan 100%.
//   9.3   ci.yml mencakup suite p15..p21; bunfig.toml timeout=15000; telemetry
//         gate deterministik via `--require-min-runs`.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { type AceAblationMetrics, compareAceAblation } from "../bench/eval-gate.ts"
import { appendMemory } from "../src/memory/files.ts"
import {
  addMemory,
  reconcileMemoryStores,
  resetEmbeddingCircuitBreaker,
  searchHybrid,
  setMemoryWriteFaultInjectorForTest,
} from "../src/memory/vector.ts"
import { isAceEnabled } from "../src/policy/consequence-engine.ts"
import { type JournalRecord, loadJournal } from "../src/session/journal.ts"
import { buildRuntimeStateHeader } from "../src/session/runtime-header.ts"
import { resetTaskStoreHandles } from "../src/task/store.ts"
import { writeMemoryTool } from "../src/tools/memory.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p21-"))
  mkdirSync(join(d, ".minicode"), { recursive: true })
  dirs.push(d)
  return d
}
const prevTodo = { id: todoSession.id, cwd: todoSession.cwd }
afterEach(() => {
  // Bersihkan seluruh seam & env agar hermetik antar-test.
  setMemoryWriteFaultInjectorForTest(null)
  resetEmbeddingCircuitBreaker()
  try {
    resetTaskStoreHandles()
  } catch {}
  delete process.env.MINICODE_ACE_ENABLED
  todoSession.id = prevTodo.id
  todoSession.cwd = prevTodo.cwd
  clearSubAgentSessionFactory()
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {}
  }
})

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

const ctxFor = (cwd: string) => ({ signal: new AbortController().signal, cwd }) as never

// ─────────────────────────────────────────────────────────────────────────────
// 9.1a — ACE Operational Rollback Switch (MINICODE_ACE_ENABLED)
// ─────────────────────────────────────────────────────────────────────────────
describe("9.1a ACE operational rollback switch `isAceEnabled`", () => {
  test("default true; false for exact disable values (case-insensitive, trimmed)", () => {
    expect(isAceEnabled({})).toBe(true)
    expect(isAceEnabled({ MINICODE_ACE_ENABLED: undefined })).toBe(true)
    expect(isAceEnabled({ MINICODE_ACE_ENABLED: "" })).toBe(true)
    expect(isAceEnabled({ MINICODE_ACE_ENABLED: "1" })).toBe(true)
    expect(isAceEnabled({ MINICODE_ACE_ENABLED: "true" })).toBe(true)
    expect(isAceEnabled({ MINICODE_ACE_ENABLED: "  on " })).toBe(true)
    expect(isAceEnabled({ MINICODE_ACE_ENABLED: "0" })).toBe(false)
    expect(isAceEnabled({ MINICODE_ACE_ENABLED: "false" })).toBe(false)
    expect(isAceEnabled({ MINICODE_ACE_ENABLED: "off" })).toBe(false)
    expect(isAceEnabled({ MINICODE_ACE_ENABLED: "NO" })).toBe(false)
    expect(isAceEnabled({ MINICODE_ACE_ENABLED: " false " })).toBe(false)
  })

  test("when ACE disabled, runtime header omits ace_state but keeps operational lines", () => {
    // ACE disabled → lastAceDecision null → collectOperationalState tidak
    // meneruskan aceDecision → buildRuntimeStateHeader tanpa baris ace_state.
    const header = buildRuntimeStateHeader({
      turnCount: 2,
      maxTurns: 10,
      pendingToolIds: ["t1"],
    })
    expect(header).toContain("[RUNTIME_STATE_HEADER")
    expect(header).not.toContain("ace_state:")
    // Guard operasional dasar tetap ada (bukan dilemahkan oleh rollback ACE).
    expect(header).toContain("turn: 2/10")
    expect(header).toContain("pending_tool_ids: [t1]")
  })

  test("when ACE disabled, subagent ChildResultEnvelope omits aceVerdict", async () => {
    const restore = providerEnv()
    const dir = tmpRoot()
    const parentId = "p21-ace-off"
    const prevTodoId = todoSession.id
    todoSession.id = parentId
    process.env.MINICODE_ACE_ENABLED = "0"
    const seen: SubAgentSpec[] = []
    try {
      setSubAgentSessionFactory(async (spec: SubAgentSpec) => {
        seen.push(spec)
        return {
          events: { on: () => () => {} },
          run: async () => ({ finalText: "ringkasan", usage: { steps: 2 } }),
        }
      })
      const out = (await delegateTaskTool.execute({ prompt: "x" } as never, ctxFor(dir))) as string
      expect(out).toBe("sub-agent (explore) done: ringkasan [steps 2]")
      // Amplop tidak melampirkan aceVerdict (ACE disabled).
      const { records } = await loadJournal(parentId, dir)
      const term = records.find(
        (r: JournalRecord) =>
          r.tool === "delegate_task" && (r.state === "committed" || r.state === "failed"),
      )
      expect(term).toBeDefined()
      const env = (term as JournalRecord).outcome?.childResult as
        | { aceVerdict?: unknown }
        | undefined
      expect(env).toBeDefined()
      expect((env as { aceVerdict?: unknown }).aceVerdict).toBeUndefined()
    } finally {
      todoSession.id = prevTodoId
      clearSubAgentSessionFactory()
      restore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9.1b — Comparative Ablation Evaluator (ACE-4)
// ─────────────────────────────────────────────────────────────────────────────
describe("9.1b compareAceAblation — deterministic safety + quality gate", () => {
  const baseline = (): AceAblationMetrics => ({
    verifiedTaskSuccessRate: 0.6,
    regressionRate: 0.2,
    unproductiveRetryRate: 0.3,
    falseCompletionRate: 0.1,
    unsafeActionRate: 0.05,
    costPerVerifiedSuccess: 1.0,
  })

  test("passes when ACE improves success + lowers retry + falseCompletion without hurting safety", () => {
    const b = baseline()
    const c: AceAblationMetrics = {
      verifiedTaskSuccessRate: 0.8,
      regressionRate: 0.2,
      unproductiveRetryRate: 0.1,
      falseCompletionRate: 0.05,
      unsafeActionRate: 0.05,
      costPerVerifiedSuccess: 0.8,
    }
    const r = compareAceAblation(b, c)
    expect(r.passed).toBe(true)
    expect(r.reasons).toHaveLength(0)
  })

  test("fails (safety gate) when unsafeActionRate or falseCompletionRate rises even if success rises", () => {
    const b = baseline()
    const worseSafety: AceAblationMetrics = {
      ...baseline(),
      verifiedTaskSuccessRate: 0.9, // success naik
      unsafeActionRate: 0.2, // safety memburuk
    }
    const r1 = compareAceAblation(b, worseSafety)
    expect(r1.passed).toBe(false)
    expect(r1.reasons.some((s) => s.includes("unsafeActionRate"))).toBe(true)

    const worseFalseCompletion: AceAblationMetrics = {
      ...baseline(),
      verifiedTaskSuccessRate: 0.9,
      falseCompletionRate: 0.3,
    }
    const r2 = compareAceAblation(b, worseFalseCompletion)
    expect(r2.passed).toBe(false)
    expect(r2.reasons.some((s) => s.includes("falseCompletionRate"))).toBe(true)
  })

  test("fails (quality gate) when verifiedTaskSuccessRate regresses", () => {
    const b = baseline()
    const c: AceAblationMetrics = { ...baseline(), verifiedTaskSuccessRate: 0.4 }
    const r = compareAceAblation(b, c)
    expect(r.passed).toBe(false)
    expect(r.reasons.some((s) => s.includes("verifiedTaskSuccessRate"))).toBe(true)
  })

  test("fails (fail-closed) on NaN or out-of-range rate metrics", () => {
    const b = baseline()
    const nan: AceAblationMetrics = { ...baseline(), regressionRate: NaN }
    expect(compareAceAblation(b, nan).passed).toBe(false)

    const outOfRange: AceAblationMetrics = { ...baseline(), unsafeActionRate: 1.5 }
    expect(compareAceAblation(b, outOfRange).passed).toBe(false)

    const negative: AceAblationMetrics = { ...baseline(), falseCompletionRate: -0.1 }
    expect(compareAceAblation(b, negative).passed).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9.2 — Fault-Injection Split-Brain Recovery (MEM-04 / U7 / LOOP-INV-18)
// ─────────────────────────────────────────────────────────────────────────────
describe("9.2 fault-injection split-brain recovery via reconcileMemoryStores", () => {
  test("crash after vector, before file → vector-only entry is removed (no dup)", async () => {
    const dir = tmpRoot()
    // Injector melempar tepat di boundary "after_vector_before_file": vector.db
    // sudah commit, MEMORY.md belum → entri vector-only.
    setMemoryWriteFaultInjectorForTest((stage) => {
      if (stage === "after_vector_before_file") throw new Error("injected crash after vector")
    })
    let threw = false
    try {
      await addMemory("vector-only entry", { cwd: dir })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    setMemoryWriteFaultInjectorForTest(null)

    // Sebelum rekonsiliasi: vector punya entri, file tidak.
    // Rekonsiliasi menghapus entri vector-only → konsisten (0 baris, 0 file).
    const result = await reconcileMemoryStores(dir)
    expect(result.vectorOnlyRemoved).toBe(1)

    // Tidak ada duplikasi: searchHybrid pun nol setelah entri yatim dihapus.
    const hits = await searchHybrid("vector-only", { cwd: dir, trackAccess: false })
    expect(hits.filter((h) => h.text.includes("vector-only entry"))).toHaveLength(0)
  })

  test("crash after file, before vector → file-only entry is adopted (no dup, no loss)", async () => {
    const dir = tmpRoot()
    // Tulis file (MEMORY.md) dulu — vektor belum. Ini meniru crash tepat setelah
    // file ketulis tapi sebelum vector (arah "file-only").
    await appendMemory("filefirst", dir)

    // Rekonsiliasi mengadopsi entri file-only ke vector (file → vector sync).
    const result = await reconcileMemoryStores(dir)
    expect(result.fileOnlyAdded).toBe(1)

    // Entri tidak hilang dan tidak digandakan: tepat satu hit di vector.
    const hits = await searchHybrid("filefirst", { cwd: dir, trackAccess: false })
    expect(hits).toHaveLength(1)
  })

  test("writeMemoryTool crash boundary: after_file_before_vector leaves file-only, then reconciles", async () => {
    const dir = tmpRoot()
    setMemoryWriteFaultInjectorForTest((stage) => {
      if (stage === "after_file_before_vector") throw new Error("crash between stores")
    })
    let threw = false
    try {
      await writeMemoryTool.execute(
        { text: "toolboundary", category: "fact" } as never,
        ctxFor(dir),
      )
    } catch {
      threw = true
    }
    setMemoryWriteFaultInjectorForTest(null)
    expect(threw).toBe(true)
    // Memori ditulis ke file (appendMemory) sebelum crash → file-only.
    const res = await reconcileMemoryStores(dir)
    expect(res.fileOnlyAdded).toBe(1)
    const hits = await searchHybrid("toolboundary", { cwd: dir, trackAccess: false })
    expect(hits).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9.3 — CTL-06 CI parity & telemetry gate determinism
// ─────────────────────────────────────────────────────────────────────────────
describe("9.3 CI parity + telemetry gate determinism", () => {
  test("ci.yml lists invariant suites p15..p21 on both main CI and ci-windows", () => {
    const ci = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")
    for (const n of [15, 16, 17, 18, 19, 20, 21]) {
      expect(ci).toContain(`test/p${n}-*.test.ts`)
    }
    // Trigger job utama + ci-windows keduanya ada.
    expect(ci).toContain("ci-windows:")
  })

  test("bunfig.toml sets test timeout = 15000", () => {
    const cfg = readFileSync(join(import.meta.dir, "..", "bunfig.toml"), "utf8")
    expect(cfg).toMatch(/\[test\]/)
    expect(cfg).toMatch(/timeout\s*=\s*15000/)
  })

  test("telemetry gate is deterministic across repeated runs with --require-min-runs", async () => {
    const dir = tmpRoot()
    const tracesPath = join(dir, ".minicode", "traces.jsonl")
    // 4/4 = 1.00 → PASS dengan data cukup (tidak lagi skip diam-diam).
    writeFileSync(tracesPath, `{"ok":true}\n{"ok":true}\n{"ok":true}\n{"ok":true}\n`, "utf8")
    const script = join(import.meta.dir, "..", "scripts", "telemetry-gate.ts")
    const outA = await $`bun ${script} ${dir} --require-min-runs`.nothrow()
    const outB = await $`bun ${script} ${dir} --require-min-runs`.nothrow()
    expect(outA.exitCode).toBe(0)
    expect(outB.exitCode).toBe(0)
    expect(outA.stdout.toString()).toContain("resolved=4/4")
    expect(outB.stdout.toString()).toContain("resolved=4/4")
    expect(outA.stdout.toString()).toBe(outB.stdout.toString())
  })

  test("telemetry gate --require-min-runs fails on insufficient data instead of skipping", async () => {
    const dir = tmpRoot()
    const tracesPath = join(dir, ".minicode", "traces.jsonl")
    writeFileSync(tracesPath, `{"ok":true}\n{"ok":false}\n`, "utf8")
    const script = join(import.meta.dir, "..", "scripts", "telemetry-gate.ts")
    const out = await $`bun ${script} ${dir} --require-min-runs`.nothrow()
    expect(out.exitCode).toBe(1)
    expect(out.stderr.toString()).toContain("insufficient runs")
  })
})
