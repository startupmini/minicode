// Fase 3 — Invariant aktivasi VERIFYING, Tiered Verification Gate, Budget
// Carry-Forward lintas resume, Kalibrasi Token, dan Detektor No-Progress /
// Oscillation (`LOOP-11`, `LOOP-12`, `CTX-03`).
//
// Ringkas apa yang dibuktikan file ini:
//
//   LOOP-INV-12 / G20 / G21  Siklus eksplisit IN_PROGRESS -> VERIFYING ->
//                            COMPLETED dengan `evidence_json` terstruktur;
//                            `requireVerified: true` menahan `unverified` di
//                            VERIFYING (tidak fail-open ke COMPLETED); gagal
//                            verifier (exitCode != 0) maupun Tier 1 conflict
//                            marker `<<<<<<<` memindahkan task ke BLOCKED.
//   LOOP-INV-11              `loadSessionUsageSummary` + `createUsageCollector`
//                            membawa akumulasi token/USD & `turnCount` lintas
//                            resume; `watchBudgetLimit` memutus begitu total
//                            gabungan lewat pagu; `maxTurns` ditegakkan keras.
//   CTX-03                   `createCalibratedEstimator` + `session.contextTokens`
//                            menyesuaikan naik saat `totalTokens`/`inputTokens`
//                            provider melampaui estimasi karakter lokal.
//   LOOP-G19 / LOOP-G27      Detektor deterministik memblokir panggilan ke-4
//                            setelah 3x error identik, menangkap osilasi file
//                            A -> B -> A -> B -> A, dan menghentikan read-only
//                            thrashing di postur aktif tanpa salah blokir pada
//                            mode explore/readonly/plan.
//
// Hermetik: direktori temp, FakeProvider lokal, tanpa jaringan.

import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EventBus, Tool } from "#minicore"
import { FakeProvider, finish, text, tool, toolCall } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import { createCalibratedEstimator, minicodeEstimator } from "../src/policy/context.ts"
import {
  canonicalArgsHash,
  computeActionErrorFingerprint,
  createNoProgressDetector,
} from "../src/policy/no-progress.ts"
import { EXPLORE_TOOL_NAMES } from "../src/policy/tool-contract.ts"
import {
  createUsageCollector,
  maxTurnsExceededError,
  watchBudgetLimit,
} from "../src/policy/usage.ts"
import { runVerify } from "../src/policy/verifier.ts"
import { appendMutationIntent, appendMutationTerminal, hashArgs } from "../src/session/journal.ts"
import { loadSessionUsageSummary, saveSession } from "../src/session/persistence.ts"
import {
  checkWorkspaceIntegrity,
  collectModifiedFilesFromJournal,
} from "../src/session/verification.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { beginSessionTasksVerification, settleSessionVerifyingTasks } from "../src/task/sync.ts"
import { allTools } from "../src/tools/index.ts"
import { readFileTool } from "../src/tools/read_file.ts"
import {
  applyCompletionPolicy,
  clearCompletionEvidence,
  loadTodos,
  setCompletionEvidence,
  todoWriteTool,
} from "../src/tools/todo.ts"
import { writeFileTool } from "../src/tools/write_file.ts"

const dirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p15f3-"))
  mkdirSync(join(d, ".minicode"), { recursive: true })
  dirs.push(d)
  return d
}

afterEach(() => {
  clearCompletionEvidence()
  resetTaskStoreHandles()
  while (dirs.length > 0) {
    const d = dirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

function makeFakeEventBus() {
  type Handler = (ev: unknown) => void
  const handlers = new Map<string, Handler[]>()
  const bus: EventBus & { emit: (type: string, ev: unknown) => void } = {
    on(type: string, handler: Handler) {
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
      return () => {
        const idx = list.indexOf(handler)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
    emit(type: string, ev: unknown) {
      for (const h of [...(handlers.get(type) ?? [])]) h(ev)
    },
  } as unknown as EventBus & { emit: (type: string, ev: unknown) => void }
  return bus
}

const todoCtx = (sessionId: string, cwd: string) =>
  ({
    signal: new AbortController().signal,
    sessionId,
    cwd,
  }) as never

// ── 1. LOOP-INV-12 / G20 / G21: VERIFYING & Tiered Verification Gate ───────

describe("LOOP-INV-12 — siklus VERIFYING & fail-closed completion gate", () => {
  test("transisi IN_PROGRESS -> VERIFYING -> COMPLETED mencatat evidence_json terstruktur", () => {
    const dir = tempDir()
    const sid = "p15f3-verify-pass"
    const store = new TaskStore(dir)
    const created = store.createTask(sid, {
      title: "implement feature",
      status: "IN_PROGRESS",
      order: 0,
      provenance: { origin: "runtime", source: "p15f3" },
    })
    expect(created.status).toBe("IN_PROGRESS")

    const verifying = store.beginTaskVerification(sid, created.id)
    expect(verifying.status).toBe("VERIFYING")
    expect(verifying.revision).toBe(created.revision + 1)

    const completed = store.completeTaskVerification(sid, created.id, {
      ok: true,
      verdict: "passed",
      exitCode: 0,
      command: "bun test",
      summary: "18 pass, 0 fail",
      integrityOk: true,
      timestamp: "2026-10-27T00:00:00.000Z",
    })
    expect(completed.status).toBe("COMPLETED")
    expect(completed.evidence.length).toBeGreaterThanOrEqual(1)
    const lastEv = completed.evidence[completed.evidence.length - 1]!
    expect(lastEv.kind).toBe("verify")
    const parsed = JSON.parse(lastEv.detail) as Record<string, unknown>
    expect(parsed).toMatchObject({
      verdict: "passed",
      ok: true,
      exitCode: 0,
      command: "bun test",
      summary: "18 pass, 0 fail",
      integrityOk: true,
      timestamp: "2026-10-27T00:00:00.000Z",
    })
  })

  test("LOOP-G20: requireVerified: true + unverified menahan task di VERIFYING (tidak COMPLETED palsu)", async () => {
    const dir = tempDir()
    const sid = "p15f3-require-verified"
    const store = new TaskStore(dir)
    const t1 = store.createTask(sid, {
      title: "harden gate",
      status: "IN_PROGRESS",
      order: 0,
      provenance: { origin: "runtime", source: "p15f3" },
    })

    // Unit murni: applyCompletionPolicy dengan requireVerified menolak completed
    const gated = applyCompletionPolicy(
      [{ taskId: t1.id, content: "harden gate", status: "completed" }],
      { verdict: "unverified" },
      { requireVerified: true },
    )
    expect(gated).not.toBeNull()
    expect(gated![0]!.status).toBe("blocked")
    expect(gated![0]!.blockedReason).toContain("verification required")

    // End-to-end lewat todo_write: klaim ditahan di VERIFYING di TaskStore,
    // lalu saat verifier lulus barulah masuk ke COMPLETED.
    setCompletionEvidence(() => ({ verdict: "unverified", requireVerified: true }))
    const out = (await todoWriteTool.execute(
      { todos: [{ taskId: t1.id, content: "harden gate", status: "completed" }] } as never,
      todoCtx(sid, dir),
    )) as string
    expect(out).toContain("held in VERIFYING")
    expect((await loadTodos(sid, dir))[0]!.status).not.toBe("completed")

    const held = store.getTask(sid, t1.id)!
    expect(held.status).toBe("VERIFYING")
    expect(held.status).not.toBe("COMPLETED")

    // Verifier jalan dan lulus → VERIFYING -> COMPLETED + evidence_json
    const settled = settleSessionVerifyingTasks(dir, sid, {
      ok: true,
      verdict: "passed",
      exitCode: 0,
      command: "bun test",
      summary: "all green",
      integrityOk: true,
    })
    expect(settled).toHaveLength(1)
    const afterPass = store.getTask(sid, t1.id)!
    expect(afterPass.status).toBe("COMPLETED")
    expect(afterPass.evidence.some((e) => e.kind === "verify")).toBe(true)
  })

  test("LOOP-G21: gagal verifier (exit code non-zero) memindahkan VERIFYING -> BLOCKED", async () => {
    const dir = tempDir()
    const sid = "p15f3-verify-fail"
    const store = new TaskStore(dir)
    const t1 = store.createTask(sid, {
      title: "broken build",
      status: "IN_PROGRESS",
      order: 0,
      provenance: { origin: "runtime", source: "p15f3" },
    })

    beginSessionTasksVerification(dir, sid, [t1.id])
    expect(store.getTask(sid, t1.id)?.status).toBe("VERIFYING")

    // Jalankan runVerify nyata yang keluar dengan kode 2
    const cmd = `${JSON.stringify(process.execPath)} -e "console.error('compile err'); process.exit(2)"`
    const res = await runVerify(cmd, dir)
    expect(res.ok).toBe(false)
    expect(res.exitCode).toBe(2)

    settleSessionVerifyingTasks(dir, sid, {
      ok: res.ok,
      verdict: "failed",
      exitCode: res.exitCode ?? 1,
      command: cmd,
      summary: res.output,
      integrityOk: true,
    })

    const blocked = store.getTask(sid, t1.id)!
    expect(blocked.status).toBe("BLOCKED")
    expect(blocked.status).not.toBe("COMPLETED")
    expect(blocked.blockedReason).toContain("compile err")
    const ev = JSON.parse(blocked.evidence[blocked.evidence.length - 1]!.detail) as {
      verdict: string
      exitCode: number
    }
    expect(ev.verdict).toBe("failed")
    expect(ev.exitCode).toBe(2)
  })

  test("Tier 1 checkWorkspaceIntegrity: conflict marker <<<<<<< menggagalkan completion ke BLOCKED", async () => {
    const dir = tempDir()
    const sid = "p15f3-conflict-marker"
    const store = new TaskStore(dir)
    const t1 = store.createTask(sid, {
      title: "resolve merge",
      status: "IN_PROGRESS",
      order: 0,
      provenance: { origin: "runtime", source: "p15f3" },
    })

    // Markdown dengan `=======` sebagai heading TIDAK boleh false-positive
    writeFileSync(join(dir, "README.md"), "Judul\n=======\nIsi bersih.\n", "utf8")
    const cleanMd = await checkWorkspaceIntegrity(["README.md"], dir)
    expect(cleanMd.ok).toBe(true)

    // File yang baru ditulis dengan sisa conflict marker Git
    writeFileSync(
      join(dir, "src.ts"),
      "export const a = 1\n<<<<<<< HEAD\nconst x = 1\n=======\nconst x = 2\n>>>>>>> feat\n",
      "utf8",
    )
    const intent = await appendMutationIntent({
      session: sid,
      turn: 1,
      tool: "write_file",
      cwd: dir,
      paths: ["src.ts"],
    })
    await appendMutationTerminal(sid, dir, intent.id, intent.seq, "write_file", "committed")

    const report = await checkWorkspaceIntegrity(["src.ts"], dir)
    expect(report.ok).toBe(false)
    expect(report.issues[0]?.reason).toBe("unresolved-conflict-marker")
    expect(report.issues[0]?.line).toBe(2)

    // Bahkan ketika verifier eksternal diklaim hijau pada turn yang mencakup
    // mutasi itu, Tier 1 menolak klaim `completed` dan mengubah TaskStore -> BLOCKED.
    setCompletionEvidence(() => ({ verdict: "passed", detail: "bun test", turn: 1 }))
    const out = (await todoWriteTool.execute(
      { todos: [{ taskId: t1.id, content: "resolve merge", status: "completed" }] } as never,
      todoCtx(sid, dir),
    )) as string
    expect(out).toContain("refused 1 completion claim")
    expect((await loadTodos(sid, dir))[0]!.status).toBe("blocked")
    const row = store.getTask(sid, t1.id)!
    expect(row.status).toBe("BLOCKED")
    expect(row.blockedReason).toContain("conflict marker")

    // Cek juga deteksi file hilang yang sebelumnya tercatat ditulis
    rmSync(join(dir, "src.ts"))
    const missingReport = await checkWorkspaceIntegrity(
      collectModifiedFilesFromJournal([intent, { ...intent, state: "committed" }]),
      dir,
    )
    expect(missingReport.ok).toBe(false)
    expect(missingReport.issues[0]?.reason).toBe("missing-written-file")
  })
})

// ── 2. LOOP-INV-11 & CTX-03: Budget Carry-Forward & Token Calibration ──────

describe("LOOP-INV-11 & CTX-03 — budget carry-forward lintas resume & kalibrasi token", () => {
  test("createUsageCollector + loadSessionUsageSummary mempertahankan biaya/token lintas resume dan memicu budget_exceeded", async () => {
    const dir = tempDir()
    const sid = "p15f3-budget-resume"

    // Simulasikan 2 turn sebelumnya yang tersimpan di SQLite (masing-masing $0.40)
    await saveSession(sid, dir, "sys", [{ role: "user", content: "turn 1" }], {
      inputTokens: 2000,
      outputTokens: 500,
      totalTokens: 2500,
      cost: 0.4,
    })
    await saveSession(
      sid,
      dir,
      "sys",
      [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "ok 1" },
        { role: "user", content: "turn 2" },
      ],
      { inputTokens: 3000, outputTokens: 500, totalTokens: 3500, cost: 0.4 },
    )

    const summary = loadSessionUsageSummary(sid, dir)
    expect(summary).toEqual({
      inputTokens: 5000,
      outputTokens: 1000,
      totalTokens: 6000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0.8,
      turnCount: 2,
    })

    // Resume sesi dengan budget $1.00: sudah terpakai $0.80 dari run sebelumnya
    const bus = makeFakeEventBus()
    const collector = createUsageCollector(bus, "gpt-4o", summary)
    expect(collector.getSession().totalTokens).toBe(6000)
    expect(collector.getSession().cost).toBeCloseTo(0.8, 6)
    expect(collector.getTurnCount()).toBe(2)

    const overEvents: { status: string; cost: number | undefined }[] = []
    const stop = watchBudgetLimit({
      bus,
      budget: 1.0,
      getCost: () => collector.getSession().cost,
      getTokens: () => collector.getSession().totalTokens,
      onOver: (status, cost) => overEvents.push({ status, cost }),
    })
    // Saat baru pasang: $0.80 <= $1.00 → belum over
    expect(overEvents).toHaveLength(0)

    // Pemakaian di run baru hanya ~$0.25 (100k input gpt-4o @ $2.5/1M = $0.25),
    // di bawah $1.00 bila dihitung sendirian, TETAPI gabungan $0.80 + $0.25 = $1.05 > $1.00!
    bus.emit("provider:extension", {
      type: "provider:extension",
      kind: "usage",
      data: { inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 },
    })
    expect(overEvents).toHaveLength(1)
    expect(overEvents[0]!.status).toBe("over")
    expect(overEvents[0]!.cost!).toBeGreaterThan(1.0)

    // `reset()` per-turn TIDAK menghapus akumulasi sesi hasil carry-forward
    collector.reset()
    expect(collector.get().totalTokens).toBe(0)
    expect(collector.getSession().totalTokens).toBe(106_000)
    expect(collector.getSession().cost!).toBeGreaterThan(1.0)
    stop()
  })

  test("batas keras maxTurns ditegakkan lintas resume dengan error budget_exceeded deterministik", async () => {
    const dir = tempDir()
    let providerCalls = 0
    const provider = {
      async *stream() {
        providerCalls += 1
        yield text("halo")
        yield finish("stop")
      },
    }

    // Resume pada turnCount=2 dengan maxTurns=3: turn ke-3 masih diizinkan,
    // turn ke-4 langsung ditolak SEBELUM provider dipanggil.
    const session = await createMinicodeSession({
      provider: provider as never,
      cwd: dir,
      permissionMode: "allow-all",
      turnCount: 2,
      maxTurns: 3,
    })

    const r3 = await session.run("turn ketiga")
    expect(r3.finalText).toBe("halo")
    expect(session.state.turnCount).toBe(3)
    expect(providerCalls).toBe(1)

    let caught: unknown = null
    try {
      await session.run("turn keempat melampaui batas")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { kind?: string }).kind).toBe("budget_exceeded")
    expect((caught as { code?: string }).code).toBe("max_turns_exceeded")
    expect((caught as Error).message).toContain("max_turns_exceeded")
    // Provider TIDAK dipanggil pada turn yang ditolak pagu
    expect(providerCalls).toBe(1)

    // Helper maxTurnsExceededError konsisten
    const sample = maxTurnsExceededError(5, 5)
    expect(sample.kind).toBe("budget_exceeded")
    expect(sample.code).toBe("max_turns_exceeded")
  })

  test("CTX-03: kalibrasi token konteks menaikkan estimasi saat provider melaporkan totalTokens lebih tinggi", async () => {
    const cal = createCalibratedEstimator()
    const sampleText = "a".repeat(400) // lokal = 100 token (400 / 4)
    expect(minicodeEstimator(sampleText)).toBe(100)
    expect(cal.estimator(sampleText)).toBe(100)

    // Provider melaporkan lebih RENDAH dari lokal → conservative max menjaga faktor = 1
    cal.observeProviderUsage({ localEstimatedTokens: 100, providerTotalTokens: 60 })
    expect(cal.snapshot().factor).toBe(1)
    expect(cal.estimator(sampleText)).toBe(100)

    // Provider melaporkan lebih TINGGI (mis. teks padat / CJK: 180 token aktual vs 100 lokal)
    const snap = cal.observeProviderUsage({
      localEstimatedTokens: 100,
      providerTotalTokens: 180,
    })
    expect(snap.factor).toBeCloseTo(1.8, 5)
    expect(snap.driftTokens).toBe(80)
    expect(cal.estimator(sampleText)).toBe(180)
    expect(cal.effectiveContextTokens(100)).toBeGreaterThanOrEqual(180)

    // Integrasi di createMinicodeSession: event usage tinggi menaikkan session.contextTokens
    const dir = tempDir()
    const provider = {
      async *stream() {
        yield {
          type: "extension" as const,
          kind: "usage",
          data: { inputTokens: 12_000, outputTokens: 200, totalTokens: 12_200 },
        }
        yield { type: "text_delta" as const, text: "calibrated" }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    }
    const session = await createMinicodeSession({
      provider: provider as never,
      cwd: dir,
      permissionMode: "allow-all",
    })
    const before = session.contextTokens
    expect(before).toBeLessThan(8_000)
    await session.run("uji kalibrasi")
    const after = session.contextTokens
    expect(after).toBeGreaterThanOrEqual(12_000)
  })
})

// ── 3. LOOP-G19 & LOOP-G27: Detektor No-Progress & Oscillation ─────────────

describe("LOOP-G19 & LOOP-G27 — detektor deterministik No-Progress & Oscillation", () => {
  test("canonicalArgsHash konsisten byte-for-byte dengan hashArgs jurnal", () => {
    const a = { b: [1, { y: "z", x: true }], a: "hello" }
    const b = { a: "hello", b: [1, { x: true, y: "z" }] }
    expect(canonicalArgsHash(a)).toBe(hashArgs(b))
    expect(computeActionErrorFingerprint("bash", a, "exit 1\ndetail")).toBe(
      computeActionErrorFingerprint("bash", b, "exit 1\nother trailing line"),
    )
  })

  test("Sinyal 1 (LOOP-G19): 3x tool call gagal identik memblokir percobaan ke-4 di runtime sesi", async () => {
    const dir = tempDir()
    let executions = 0
    const flakyTool: Tool = tool(
      "always_fails",
      async () => {
        executions += 1
        throw new Error("ECONNREFUSED 127.0.0.1:5432")
      },
      {
        type: "object",
        properties: { host: { type: "string" } },
        additionalProperties: false,
      },
    )

    const observedToolResults: string[] = []
    const session = await createMinicodeSession({
      provider: new FakeProvider([
        { events: [toolCall("always_fails", { host: "db" }, "c1"), finish("tool_calls")] },
        { events: [toolCall("always_fails", { host: "db" }, "c2"), finish("tool_calls")] },
        { events: [toolCall("always_fails", { host: "db" }, "c3"), finish("tool_calls")] },
        { events: [toolCall("always_fails", { host: "db" }, "c4"), finish("tool_calls")] },
        { events: [text("berhenti dan ubah pendekatan"), finish("stop")] },
      ]),
      tools: [flakyTool],
      cwd: dir,
      permissionMode: "allow-all",
    })
    session.events.on("execution:completed", (e) => {
      const content = (e.execution?.result as { content?: string } | undefined)?.content ?? ""
      observedToolResults.push(content)
    })

    const res = await session.run("coba konek")
    expect(res.finalText).toContain("ubah pendekatan")
    // Tiga panggilan pertama benar-benar dieksekusi; panggilan ke-4 DICEGAT
    // barrier sebelum masuk ke body tool, dan hasilnya masuk ke history model!
    expect(executions).toBe(3)
    expect(observedToolResults).toHaveLength(3)
    const toolMessages = session.state.history.filter((m) => m.role === "tool")
    expect(toolMessages).toHaveLength(4)
    expect(String(toolMessages[3]!.content)).toContain(
      "[LOOP_GUARD kind=NO_PROGRESS reason=REPEATED_ACTION_ERROR count=3]",
    )
  })

  test("Sinyal 2 (LOOP-G27): siklus edit-revert A -> B -> A -> B -> A memicu OSCILLATION", async () => {
    const det = createNoProgressDetector({ maxOscillations: 2 })
    const hA = sha256("version A")
    const hB = sha256("version B")
    const hC = sha256("version C")

    // 1x undo lalu maju ke C TIDAK boleh salah blokir
    expect(
      det.recordFileMutation({ path: "ok.ts", preTargetHash: hA, postTargetHash: hB }).allowed,
    ).toBe(true)
    expect(
      det.recordFileMutation({ path: "ok.ts", preTargetHash: hB, postTargetHash: hA }).allowed,
    ).toBe(true)
    expect(
      det.recordFileMutation({ path: "ok.ts", preTargetHash: hA, postTargetHash: hC }).allowed,
    ).toBe(true)

    // Siklus A -> B -> A -> B -> A pada `osc.ts` memicu OSCILLATION tepat di akhir siklus ke-2
    expect(
      det.recordFileMutation({ path: "osc.ts", preTargetHash: hA, postTargetHash: hB }).allowed,
    ).toBe(true)
    expect(
      det.recordFileMutation({ path: "osc.ts", preTargetHash: hB, postTargetHash: hA }).allowed,
    ).toBe(true)
    expect(
      det.recordFileMutation({ path: "osc.ts", preTargetHash: hA, postTargetHash: hB }).allowed,
    ).toBe(true)
    const v4 = det.recordFileMutation({
      path: "osc.ts",
      preTargetHash: hB,
      postTargetHash: hA,
    })
    expect(v4.allowed).toBe(false)
    if (!v4.allowed) {
      expect(v4.kind).toBe("OSCILLATION")
      expect(v4.reason).toBe("WORKSPACE_REVERT_CYCLE")
      expect(v4.message).toContain(
        "[LOOP_GUARD kind=OSCILLATION reason=WORKSPACE_REVERT_CYCLE path=osc.ts]",
      )
    }

    // Panggilan tulis berikutnya ke file itu diblokir sebelum efek...
    const blockedNext = det.evaluateBeforeCall({
      name: "write_file",
      args: { path: "osc.ts", content: "version B" },
    })
    expect(blockedNext.allowed).toBe(false)

    // ...dan direset bersih setelah verifikasi hijau tercatat.
    det.noteVerificationPassed()
    expect(
      det.evaluateBeforeCall({
        name: "write_file",
        args: { path: "osc.ts", content: "version B" },
      }).allowed,
    ).toBe(true)

    // Buktikan juga di jalur end-to-end createMinicodeSession dengan write_file nyata
    const dir = tempDir()
    writeFileSync(join(dir, "flip.txt"), "A", "utf8")
    const results: string[] = []
    const session = await createMinicodeSession({
      provider: new FakeProvider([
        {
          events: [
            toolCall("write_file", { path: "flip.txt", content: "B" }, "w1"),
            finish("tool_calls"),
          ],
        },
        {
          events: [
            toolCall("write_file", { path: "flip.txt", content: "A" }, "w2"),
            finish("tool_calls"),
          ],
        },
        {
          events: [
            toolCall("write_file", { path: "flip.txt", content: "B" }, "w3"),
            finish("tool_calls"),
          ],
        },
        {
          events: [
            toolCall("write_file", { path: "flip.txt", content: "A" }, "w4"),
            finish("tool_calls"),
          ],
        },
        {
          events: [
            toolCall("write_file", { path: "flip.txt", content: "B" }, "w5"),
            finish("tool_calls"),
          ],
        },
        { events: [text("osilasi terdeteksi"), finish("stop")] },
      ]),
      tools: [writeFileTool],
      cwd: dir,
      permissionMode: "allow-all",
    })
    session.events.on("execution:completed", (e) => {
      results.push(String((e.execution?.result as { content?: string } | undefined)?.content ?? ""))
    })
    await session.run("bolak balik")
    // Empat write pertama jalan (A->B->A->B->A), write ke-5 dicegat barrier!
    expect(results).toHaveLength(4)
    const flipToolMsgs = session.state.history.filter((m) => m.role === "tool")
    expect(flipToolMsgs).toHaveLength(5)
    expect(String(flipToolMsgs[4]!.content)).toContain(
      "[LOOP_GUARD kind=OSCILLATION reason=WORKSPACE_REVERT_CYCLE path=flip.txt]",
    )
  })

  test("Sinyal 3 (LOOP-G19): PURE_READ thrashing terpicu di mode aktif, namun TIDAK terpicu di explore/readonly", async () => {
    // (a) Mode aktif: melampaui ambang batas memicu READ_ONLY_THRASHING
    const activeDet = createNoProgressDetector({
      maxConsecutiveReadCalls: 4,
      getPosture: () => "active",
    })
    for (let i = 0; i < 4; i++) {
      expect(
        activeDet.evaluateBeforeCall({ name: "read_file", args: { path: `f${i}.ts` } }).allowed,
      ).toBe(true)
    }
    const fifth = activeDet.evaluateBeforeCall({ name: "grep", args: { pattern: "x" } })
    expect(fifth.allowed).toBe(false)
    if (!fifth.allowed) {
      expect(fifth.reason).toBe("READ_ONLY_THRASHING")
      expect(fifth.message).toContain(
        "[LOOP_GUARD kind=NO_PROGRESS reason=READ_ONLY_THRASHING count=4]",
      )
    }

    // Pembaruan rencana (`todo_write`) me-reset penghitung baca
    expect(
      activeDet.evaluateBeforeCall({ name: "read_file", args: { path: "a.ts" } }).allowed,
    ).toBe(true)
    expect(activeDet.snapshot().consecutiveReadCalls).toBe(1)
    expect(activeDet.evaluateBeforeCall({ name: "todo_write", args: { todos: [] } }).allowed).toBe(
      true,
    )
    expect(activeDet.snapshot().consecutiveReadCalls).toBe(0)

    // (b) Mode explore & readonly: 25 panggilan PURE_READ berturut-turut TIDAK diblokir
    for (const posture of ["explore", "readonly", "plan"] as const) {
      const roDet = createNoProgressDetector({
        maxConsecutiveReadCalls: 3,
        getPosture: () => posture,
      })
      for (let i = 0; i < 25; i++) {
        expect(
          roDet.evaluateBeforeCall({ name: "read_file", args: { path: `f${i}.ts` } }).allowed,
        ).toBe(true)
      }
    }

    // (c) End-to-end di createMinicodeSession: subset tool explore otomatis
    //     berpostur `explore` (tidak memblokir walaupun maxConsecutiveReadCalls=2),
    //     sedangkan sesi dengan writeFileTool berpostur `active` dan memblokir!
    const dir = tempDir()
    writeFileSync(join(dir, "a.txt"), "hello\n", "utf8")
    const exploreTools = allTools.filter((t) => EXPLORE_TOOL_NAMES.includes(t.name))
    const exploreSession = await createMinicodeSession({
      provider: new FakeProvider([
        { events: [toolCall("read_file", { path: "a.txt" }, "r1"), finish("tool_calls")] },
        { events: [toolCall("read_file", { path: "a.txt" }, "r2"), finish("tool_calls")] },
        { events: [toolCall("read_file", { path: "a.txt" }, "r3"), finish("tool_calls")] },
        { events: [toolCall("read_file", { path: "a.txt" }, "r4"), finish("tool_calls")] },
        { events: [text("explore aman"), finish("stop")] },
      ]),
      tools: exploreTools,
      cwd: dir,
      permissionMode: "auto",
      noProgress: { maxConsecutiveReadCalls: 2 },
    })
    const exploreOut = await exploreSession.run("riset mendalam")
    expect(exploreOut.finalText).toBe("explore aman")

    const activeResults: string[] = []
    const activeSession = await createMinicodeSession({
      provider: new FakeProvider([
        { events: [toolCall("read_file", { path: "a.txt" }, "a1"), finish("tool_calls")] },
        { events: [toolCall("read_file", { path: "a.txt" }, "a2"), finish("tool_calls")] },
        { events: [toolCall("read_file", { path: "a.txt" }, "a3"), finish("tool_calls")] },
        { events: [text("berhenti thrashing"), finish("stop")] },
      ]),
      tools: [readFileTool, writeFileTool],
      cwd: dir,
      permissionMode: "allow-all",
      noProgress: { maxConsecutiveReadCalls: 2 },
    })
    activeSession.events.on("execution:completed", (e) => {
      activeResults.push(
        String((e.execution?.result as { content?: string } | undefined)?.content ?? ""),
      )
    })
    await activeSession.run("baca terus")
    expect(activeResults).toHaveLength(2)
    const activeToolMsgs = activeSession.state.history.filter((m) => m.role === "tool")
    expect(activeToolMsgs).toHaveLength(3)
    expect(String(activeToolMsgs[2]!.content)).toContain(
      "[LOOP_GUARD kind=NO_PROGRESS reason=READ_ONLY_THRASHING count=2]",
    )
  })
})
