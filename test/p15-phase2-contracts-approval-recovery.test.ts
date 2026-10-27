// Fase 2 — Invariant kontrak tool, semantik UNKNOWN, rekonsiliasi hash,
// pengikatan approval, dan eskalasi SIGTERM POSIX.
//
// Ringkas apa yang dibuktikan file ini:
//
//   TOOL-01 / LOOP-INV-04  SATU registry kontrak tool = sumber tunggal seluruh
//                           daftar klasifikasi; tidak ada daftar manual yang
//                           bisa menyimpang.
//   LOOP-INV-07             Timeout bash → tag [TOOL_OUTCOME state=UNKNOWN …]
//                           (isError), terminal jurnal `unknown` + outcome
//                           ambigu, dan `isRedispatchAllowed` menolak
//                           auto-redispatch.
//   LOOP-G06/G07            `preflightIntent` merekam preTargetHash;
//                           `reconcileWorkspaceMutationIntent` membedakan
//                           CONFIRMED_NOT_EXECUTED / CONFIRMED_EXECUTED /
//                           UNKNOWN.
//   LOOP-INV-08             Approval menyimpan args_hash + invocation_id;
//                           mismatch (termasuk baris legacy tanpa hash) ditolak
//                           fail-closed; migrasi skema DB lama mulus.
//   LOOP-INV-10             Cabang non-Windows mengirim SIGTERM ke SELURUH
//                           process group (-pid) sebelum fallback.
//
// Hermetik: direktori temp, DB sqlite lokal, tanpa jaringan.

import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApprovalBroker, verifyApprovalBinding } from "../src/daemon/approvals.ts"
import { createApproval, getApproval } from "../src/daemon/store.ts"
import {
  AUTONOMOUS_TOOL_NAMES,
  contractForTool,
  EXCLUSIVE_TOOLS,
  EXPLORE_TOOL_NAMES,
  GATED_TOOLS,
  TOOL_CONTRACTS,
  WRITE_TOOLS,
} from "../src/policy/tool-contract.ts"
import { isRedispatchAllowed, type RedispatchSafety } from "../src/runtime/recovery-safety.ts"
import {
  attachMutationJournal,
  classifyTool,
  decideRecovery,
  hashArgs,
  isTerminalJournalState,
  journalPath,
  loadJournal,
  type MutationJournalHandle,
  parseToolOutcomeTag,
  reconcileWorkspaceMutationIntent,
} from "../src/session/journal.ts"
import { openSessionDb } from "../src/session/persistence.ts"
import { AUTONOMOUS_TOOL_NAMES as AUTO_FROM_POLICY } from "../src/task/autonomous-context.ts"
import {
  classifyTool as classifyAutonomous,
  TOOL_CAPABILITIES,
} from "../src/task/autonomous-policy.ts"
import { bashTool, signalProcessGroupGraceful } from "../src/tools/bash.ts"
import { allTools } from "../src/tools/index.ts"
import { EXPLORE_TOOL_NAMES as TASK_EXPLORE_REEXPORT } from "../src/tools/task.ts"

const dirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p15f2-"))
  // `.minicode` wajib agar DB sesi jatuh di dalam direktori test (hermetic),
  // bukan ~/.minicode global.
  mkdirSync(join(d, ".minicode"), { recursive: true })
  dirs.push(d)
  return d
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

const setOf = (xs: readonly string[]) => new Set(xs)

// ── 1. TOOL-01 / LOOP-INV-04: satu sumber kebenaran kontrak tool ──────────

describe("TOOL-01/LOOP-INV-04 — registry kontrak tool = sumber tunggal", () => {
  const TIERS = ["PURE_READ", "WORKSPACE_MUTATION", "LOCAL_ENV_MUTATION", "EXTERNAL_IRREVERSIBLE"]

  test("semua 37 tool terdaftar dengan tier valid, tanpa duplikat", () => {
    expect(TOOL_CONTRACTS).toHaveLength(allTools.length)
    const names = TOOL_CONTRACTS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    expect(setOf(names)).toEqual(new Set(allTools.map((t) => t.name)))
    for (const c of TOOL_CONTRACTS) {
      expect(TIERS).toContain(c.sideEffectTier)
      expect(["parallel-read", "path-serialized-write", "exclusive"]).toContain(c.concurrencyClass)
    }
  })

  test("tool MCP bertitik mewarisi kelas mcp_call; nama tak dikenal undefined (fail-closed)", () => {
    expect(contractForTool("srv.tool")?.name).toBe("mcp_call")
    expect(contractForTool("nonexistent_tool")).toBeUndefined()
    expect(classifyTool("nonexistent_tool")).toBe("unknown")
    expect(classifyTool("srv.tool")).toBe("mutation")
    expect(classifyTool("read_file")).toBe("none")
    expect(classifyTool("write_file")).toBe("mutation")
  })

  test("derivation identik dengan nilai kontrak yang diharapkan konsumen", () => {
    // WRITE_TOOLS = path-serialized-write (tool tulis file dengan lock path)
    expect(setOf([...WRITE_TOOLS])).toEqual(
      new Set(["write_file", "edit", "apply_patch", "move_file", "delete_file"]),
    )
    // EXCLUSIVE_TOOLS = tanpa path tunggal → batch penuh sekuensial
    expect(setOf([...EXCLUSIVE_TOOLS])).toEqual(
      new Set(["bash", "write_memory", "forget_memory", "todo_write"]),
    )
    // GATED_TOOLS = di-gate approval secara default
    expect(setOf([...GATED_TOOLS])).toEqual(
      new Set(["delegate_task", "mcp_call", "mcp_read", "mcp_prompt", "git_commit", "ask_user"]),
    )
    // EXPLORE_TOOL_NAMES = subset read-only sub-agen explore
    expect(setOf(EXPLORE_TOOL_NAMES)).toEqual(
      new Set([
        "read_file",
        "glob",
        "grep",
        "read_memory",
        "todo_read",
        "git_status",
        "git_log",
        "lsp_diagnostics",
        "lsp_definition",
        "lsp_hover",
        "lsp_workspace_symbols",
        "mcp_list",
      ]),
    )
    // Re-export di task.ts TIDAK menyalin daftar (import langsung dari registry)
    expect(TASK_EXPLORE_REEXPORT).toBe(EXPLORE_TOOL_NAMES)
  })

  test("cermin matriks kapabilitas otonom tetap sinkron dengan registry", () => {
    // Kolom `autonomous` di TOOL_CAPABILITIES kini CERMIN (bukan sumber):
    // bila dua hal ini menyimpang, salah satunya bohong dan policy bisa
    // melebar tanpa sengaja. Test ini membuat perbedaan terlihat.
    const fromMatrix = new Set(TOOL_CAPABILITIES.filter((t) => t.autonomous).map((t) => t.name))
    expect(setOf(AUTONOMOUS_TOOL_NAMES)).toEqual(fromMatrix)
    expect(setOf(AUTO_FROM_POLICY)).toEqual(fromMatrix)
    // Sanity: kebijakan lama tetap berlaku — tool eksekusi tidak pernah otonom.
    for (const banned of ["bash", "write_file", "web_fetch", "delegate_task"]) {
      expect(AUTONOMOUS_TOOL_NAMES).not.toContain(banned)
      expect(classifyAutonomous(banned).autonomous).toBe(false)
    }
  })

  test("invarian lintas-field registry (konsistensi internal)", () => {
    for (const c of TOOL_CONTRACTS) {
      // Tool read murni tidak pernah butuh jurnal mutasi maupun lock tulis.
      if (c.sideEffectTier === "PURE_READ") {
        expect({ name: c.name, journalMutation: c.journalMutation }).toEqual({
          name: c.name,
          journalMutation: false,
        })
        expect(c.concurrencyClass).not.toBe("path-serialized-write")
      }
      // Lock path tulis hanya untuk mutasi workspace.
      if (c.concurrencyClass === "path-serialized-write") {
        expect(c.sideEffectTier).toBe("WORKSPACE_MUTATION")
      }
      // Eksekusi otonom hanya untuk tier read murni (kebijakan 6S).
      if (c.allowedInAutonomous) expect(c.sideEffectTier).toBe("PURE_READ")
    }
  })
})

// ── 2. LOOP-INV-07: timeout → UNKNOWN ─────────────────────────────────────

describe("LOOP-INV-07 — timeout tool menghasilkan outcome UNKNOWN end-to-end", () => {
  test("bash timeout melempar tag deterministik (isError) + parser membacanya", async () => {
    const ctx = { signal: new AbortController().signal } as never
    const cmd = `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`
    let message = ""
    try {
      await bashTool.execute({ cmd, timeoutMs: 400 }, ctx)
      throw new Error("seharusnya melempar saat timeout")
    } catch (e) {
      message = String((e as Error).message)
    }
    expect(message).toContain(
      "[TOOL_OUTCOME state=UNKNOWN reason=TIMEOUT side_effect_tier=LOCAL_ENV_MUTATION",
    )
    expect(message).toContain("timeout_ms=400")
    expect(message).toContain("Do NOT re-run")

    const tag = parseToolOutcomeTag(message)
    expect(tag).not.toBeNull()
    expect(tag!.state).toBe("UNKNOWN")
    expect(tag!.reason).toBe("TIMEOUT")
    expect(tag!.sideEffectTier).toBe("LOCAL_ENV_MUTATION")
    expect(tag!.timeoutMs).toBe(400)
    expect(tag!.durationMs).not.toBeNull()

    // Parser tidak salah tangkap hasil normal.
    expect(parseToolOutcomeTag("exit 1\nboom")).toBeNull()
    expect(parseToolOutcomeTag("done")).toBeNull()
  }, 20_000)

  test("terminal jurnal dari hasil ber-tag = state unknown (bukan failed biasa)", async () => {
    const dir = tempDir()
    const sid = "p15f2-unknown-terminal"
    type Handler = (e: never) => void
    const handlers = new Map<string, Handler[]>()
    const bus = {
      events: {
        on: (t: string, h: Handler) => {
          const l = handlers.get(t) ?? []
          l.push(h)
          handlers.set(t, l)
          return () => {}
        },
      },
      state: { turnCount: 1 },
      fire: (t: string, e: unknown) => {
        for (const h of handlers.get(t) ?? []) h(e as never)
      },
    }
    const handle: MutationJournalHandle = attachMutationJournal(bus as never, {
      sessionId: sid,
      cwd: dir,
      evidenceMode: "events",
    })
    bus.fire("execution:started", {
      execution: { call: { name: "bash", args: { cmd: "x" }, id: "call-u1" } },
    })
    bus.fire("execution:completed", {
      execution: {
        call: { name: "bash", args: { cmd: "x" }, id: "call-u1" },
        result: {
          isError: true,
          content:
            "[TOOL_OUTCOME state=UNKNOWN reason=TIMEOUT side_effect_tier=LOCAL_ENV_MUTATION duration_ms=402 timeout_ms=400]\npartial",
        },
      },
    })
    await handle.flushPending()

    const raw = readFileSync(journalPath(sid, dir), "utf8")
    expect(raw).toContain('"state":"unknown"')
    expect(raw).toContain('"uncertainty":"ambiguous-effect"')
    expect(raw).toContain('"timeout":true')
    // Bukan kesalahan klasifikasi: terminal failed tidak muncul untuk call ini.
    expect(raw).not.toContain('"state":"failed"')

    const loaded = await loadJournal(sid, dir)
    const plan = decideRecovery(loaded.records, [])
    expect(plan.stats.unknown).toBe(1)
    expect(plan.attention.map((a) => a.state)).toEqual(["unknown"])
    // Terminal unknown SELALU masuk blok attention (header + label state)…
    expect(plan.directive).toContain("unknown")
    expect(plan.directive).toContain("DILARANG redo buta")
    // …dan meninggalkan warning eksplisit soal efek yang belum pasti.
    expect(plan.warnings.join("\n")).toContain("UNKNOWN")
    expect(plan.clean).toBe(false)
    expect(isTerminalJournalState("unknown")).toBe(true)
    expect(isTerminalJournalState("pending")).toBe(false)
  })

  test("isRedispatchAllowed menolak UNKNOWN bahkan bila 'not started' diklaim", () => {
    const base: RedispatchSafety = {
      authorityHeld: true,
      budgetRemaining: 1000,
      deadlineRemainingMs: 1000,
      effectDefinitelyNotStarted: true,
      idempotent: true,
      dedupeKeyPresent: true,
      dedupeCheckPass: true,
      verifierConfirmedNotExecuted: true,
      evidenceRecorded: true,
    }
    // Tanpa sinyal UNKNOWN: predicate tetap mengizinkan (perilaku lama utuh).
    expect(isRedispatchAllowed(base)).toBe(true)
    // Dengan hasil tool UNKNOWN: SELURUH disjunct izin kalah (fail-closed).
    expect(isRedispatchAllowed({ ...base, unknownToolOutcome: true })).toBe(false)
    // Termasuk saat bukti not-started TIDAK tersedia + idempotensi lemah.
    expect(
      isRedispatchAllowed({
        ...base,
        effectDefinitelyNotStarted: false,
        unknownToolOutcome: true,
      }),
    ).toBe(false)
  })
})

// ── 3. LOOP-G06/G07: hash pra/pasca + rekonsiliasi ──────────────────────────

describe("LOOP-G06/G07 — rekonsiliasi mutasi workspace via hash", () => {
  test("preflightIntent merekam preTargetHash + postTargetHash yang dapat diturunkan", async () => {
    const dir = tempDir()
    const sid = "p15f2-preflight-hash"
    writeFileSync(join(dir, "a.txt"), "pre-content")
    type Handler = (e: never) => void
    const handlers = new Map<string, Handler[]>()
    const handle = attachMutationJournal(
      {
        events: {
          on: (t: string, h: Handler) => {
            const l = handlers.get(t) ?? []
            l.push(h)
            handlers.set(t, l)
            return () => {}
          },
        },
        state: { turnCount: 1 },
      } as never,
      { sessionId: sid, cwd: dir, evidenceMode: "events" },
    )
    await handle.preflightIntent({
      id: "call-w1",
      name: "write_file",
      args: { path: "a.txt", content: "post-content" },
    })
    const raw = readFileSync(journalPath(sid, dir), "utf8")
    expect(raw).toContain(sha256("pre-content"))
    expect(raw).toContain(sha256("post-content"))
  })

  test("reconcileWorkspaceMutationIntent membedakan tiga kondisi pasca-crash", async () => {
    const dir = tempDir()
    const file = join(dir, "a.txt")
    const pre = sha256("pre")
    const post = sha256("post")

    // (a) File belum tersentuh: isi == pre → CONFIRMED_NOT_EXECUTED.
    writeFileSync(file, "pre")
    const untouched = await reconcileWorkspaceMutationIntent(
      { paths: ["a.txt"], preTargetHash: pre, postTargetHash: post },
      dir,
    )
    expect(untouched.verdict).toBe("CONFIRMED_NOT_EXECUTED")
    expect(untouched.reason).toBe("content-matches-pre")

    // (b) File selesai ditulis: isi == post → CONFIRMED_EXECUTED.
    writeFileSync(file, "post")
    const done = await reconcileWorkspaceMutationIntent(
      { paths: ["a.txt"], preTargetHash: pre, postTargetHash: post },
      dir,
    )
    expect(done.verdict).toBe("CONFIRMED_EXECUTED")

    // (c) Setengah tertulis: berubah dari pre tapi bukan post → UNKNOWN.
    writeFileSync(file, "half-written")
    const corrupt = await reconcileWorkspaceMutationIntent(
      { paths: ["a.txt"], preTargetHash: pre, postTargetHash: post },
      dir,
    )
    expect(corrupt.verdict).toBe("UNKNOWN")
    expect(corrupt.reason).toBe("content-differs-from-known-states")

    // (d) edit/apply_patch: post tidak diketahui → isi berubah = UNKNOWN.
    const unknownPost = await reconcileWorkspaceMutationIntent(
      { paths: ["a.txt"], preTargetHash: pre },
      dir,
    )
    expect(unknownPost.verdict).toBe("UNKNOWN")

    // (e) Record legacy tanpa pre-hash → UNKNOWN (tidak mengarang bukti).
    const legacy = await reconcileWorkspaceMutationIntent({ paths: ["a.txt"] }, dir)
    expect(legacy.verdict).toBe("UNKNOWN")
    expect(legacy.reason).toBe("no-pre-target-hash")

    // (f) delete_file: post = null (target harus HILANG).
    writeFileSync(file, "pre")
    const delNotRun = await reconcileWorkspaceMutationIntent(
      { paths: ["a.txt"], preTargetHash: pre, postTargetHash: null },
      dir,
    )
    expect(delNotRun.verdict).toBe("CONFIRMED_NOT_EXECUTED")
    rmSync(file)
    const delDone = await reconcileWorkspaceMutationIntent(
      { paths: ["a.txt"], preTargetHash: pre, postTargetHash: null },
      dir,
    )
    expect(delDone.verdict).toBe("CONFIRMED_EXECUTED")

    // (g) Path di luar root = UNKNOWN (tidak pernah dijadikan bukti).
    const outside = await reconcileWorkspaceMutationIntent(
      { paths: ["../x.txt"], preTargetHash: pre, postTargetHash: post },
      dir,
    )
    expect(outside.verdict).toBe("UNKNOWN")
    expect(outside.reason).toBe("path-outside-root")
  })
})

// ── 4. LOOP-INV-08: pengikatan approval ────────────────────────────────────

describe("LOOP-INV-08 — approval terikat argsHash + invocationId (fail-closed)", () => {
  const baseRow = {
    approvalId: "apr_x1",
    sid: "s1",
    runId: null,
    tool: "bash",
    summary: "echo hi",
    requestedAt: 1_000,
    expiresAt: 60_000,
    incarnation: "inc_a",
  }

  test("createApproval menyimpan args_hash + invocation_id dan getApproval membacanya", () => {
    const dir = tempDir()
    createApproval({ ...baseRow, argsHash: "deadbeef", invocationId: "call-1" }, dir)
    const row = getApproval("apr_x1", dir)
    expect(row?.argsHash).toBe("deadbeef")
    expect(row?.invocationId).toBe("call-1")
    // Legacy (tanpa pengikat) tetap terbaca sebagai null, bukan error.
    createApproval({ ...baseRow, approvalId: "apr_x2" }, dir)
    expect(getApproval("apr_x2", dir)?.argsHash).toBeNull()
    expect(getApproval("apr_x2", dir)?.invocationId).toBeNull()
  })

  test("verifyApprovalBinding: mismatch apa pun ditolak; legacy tanpa hash tidak dianggap cocok", () => {
    const row = { tool: "bash", argsHash: "h1", invocationId: "call-1" }
    expect(
      verifyApprovalBinding(row, { tool: "bash", argsHash: "h1", invocationId: "call-1" }),
    ).toEqual({
      ok: true,
    })
    // Argumen dimodifikasi sekecil apa pun → hash beda → tolak.
    expect(
      verifyApprovalBinding(row, { tool: "bash", argsHash: "h2", invocationId: "call-1" }),
    ).toEqual({ ok: false, reason: "args-hash-mismatch" })
    // Tool ditukar → tolak.
    expect(
      verifyApprovalBinding(row, { tool: "write_file", argsHash: "h1", invocationId: "call-1" }),
    ).toEqual({ ok: false, reason: "tool-mismatch" })
    // Pemanggilan ditukar → tolak (satu approval = satu invokasi).
    expect(
      verifyApprovalBinding(row, { tool: "bash", argsHash: "h1", invocationId: "call-2" }),
    ).toEqual({ ok: false, reason: "invocation-mismatch" })
    // Baris legacy NULL vs eksekusi ber-hash → mismatch (bukan izin bebas).
    expect(
      verifyApprovalBinding(
        { tool: "bash", argsHash: null, invocationId: null },
        { tool: "bash", argsHash: "h1", invocationId: "call-1" },
      ),
    ).toEqual({ ok: false, reason: "args-hash-mismatch" })
    // Dua-duanya tanpa pengikat = jalur lama yang tetap kompatibel.
    expect(
      verifyApprovalBinding(
        { tool: "bash", argsHash: null, invocationId: null },
        { tool: "bash", argsHash: null, invocationId: null },
      ),
    ).toEqual({ ok: true })
  })

  test("broker: keputusan accept dengan binding yang cocok → allow; baris dirusak → deny", async () => {
    const dir = tempDir()
    const warns: string[] = []
    let broker!: ApprovalBroker
    let approvalId = ""

    // (a) Baris dirusak SETELAH permintaan dicatat (simulasi tamper/legacy):
    //     keputusan konsumen "accept" tidak boleh menjadi izin.
    broker = new ApprovalBroker({
      incarnation: "inc_a",
      cwd: dir,
      propose: (view) => {
        approvalId = view.approvalId
        const db = openSessionDb(dir)
        try {
          db.prepare(
            "UPDATE daemon_approvals SET args_hash = 'deadbeef' WHERE approval_id = ?",
          ).run(view.approvalId)
        } finally {
          db.close()
        }
        broker.decide(view.approvalId, "accept")
      },
      warn: (m) => warns.push(m),
    })
    const tampered = await broker.request({
      sid: "s1",
      tool: "bash",
      argsHash: hashArgs({ cmd: "echo hi" }),
      invocationId: "call-1",
    })
    expect(tampered).toBe("deny")
    expect(warns.join("\n")).toContain("args-hash-mismatch")

    // (b) Alur normal: binding cocok → allow, dan baris DB membawa pengikat.
    const dir2 = tempDir()
    const broker2 = new ApprovalBroker({
      incarnation: "inc_a",
      cwd: dir2,
      propose: (view) => {
        approvalId = view.approvalId
        broker2.decide(view.approvalId, "accept")
      },
    })
    const decision = await broker2.request({
      sid: "s1",
      tool: "bash",
      argsHash: hashArgs({ cmd: "echo hi" }),
      invocationId: "call-1",
    })
    expect(decision).toBe("allow")
    const row = getApproval(approvalId, dir2)
    expect(row?.argsHash).toBe(hashArgs({ cmd: "echo hi" }))
    expect(row?.invocationId).toBe("call-1")
    // Konsumsi ulang pengikat yang sama untuk argumen BERBEDA → ditolak.
    expect(
      verifyApprovalBinding(row!, {
        tool: "bash",
        argsHash: hashArgs({ cmd: "echo TAMPERED" }),
        invocationId: "call-1",
      }),
    ).toEqual({ ok: false, reason: "args-hash-mismatch" })
  })

  test("asPermissionAsk mengikat tiap permintaan ke hash argumen + id tool call", async () => {
    const dir = tempDir()
    let broker!: ApprovalBroker
    let approvalId = ""
    broker = new ApprovalBroker({
      incarnation: "inc_a",
      cwd: dir,
      propose: (view) => {
        approvalId = view.approvalId
        broker.decide(view.approvalId, "accept")
      },
    })
    const ask = broker.asPermissionAsk({ sid: () => "s1" })
    const args = { cmd: "echo hi" }
    const ans = await ask({ id: "call-9", name: "bash", args })
    expect(ans).toBe("allow")
    const row = getApproval(approvalId, dir)
    expect(row?.argsHash).toBe(hashArgs(args))
    expect(row?.invocationId).toBe("call-9")
    expect(row?.tool).toBe("bash")
  })

  test("migrasi DB lama: kolom pengikat ditambahkan idempoten tanpa merusak baris", () => {
    const dir = tempDir()
    // Buka sekali (skema baru), lalu turunkan ke bentuk pra-Fase 2.
    const db = openSessionDb(dir)
    db.exec("ALTER TABLE daemon_approvals DROP COLUMN args_hash")
    db.exec("ALTER TABLE daemon_approvals DROP COLUMN invocation_id")
    db.close()

    // Buka ulang: migrasi PRAGMA table_info + ALTER TABLE harus menambahkan
    // kembali kedua kolom, dan idempoten pada open berikutnya.
    const db2 = openSessionDb(dir)
    const cols = () =>
      (db2.prepare("PRAGMA table_info(daemon_approvals)").all() as { name: string }[]).map(
        (c) => c.name,
      )
    expect(cols()).toContain("args_hash")
    expect(cols()).toContain("invocation_id")
    // Banyaknya kolom stabil (tidak dobel-tambah saat open ulang).
    const once = cols().length
    db2.close()
    const db3 = openSessionDb(dir)
    expect(
      db3.prepare("PRAGMA table_info(daemon_approvals)").all() as { name: string }[],
    ).toHaveLength(once)
    db3.close()
  })
})

// ── 5. LOOP-INV-10: SIGTERM process group di POSIX ─────────────────────────

describe("LOOP-INV-10 — eskalasi awal POSIX: SIGTERM ke process group", () => {
  test("non-Windows: process.kill(-pid, SIGTERM) dipanggil sebelum fallback", () => {
    const calls: string[] = []
    const fallback = {
      kill: (s?: NodeJS.Signals | number) => {
        calls.push(`fallback:${String(s)}`)
        return true
      },
    }
    const out = signalProcessGroupGraceful(4242, fallback, {
      platform: "linux",
      killGroup: (pid, signal) => {
        calls.push(`group:${pid}:${signal}`)
        return true
      },
    })
    expect(out).toBe("group")
    expect(calls).toEqual(["group:-4242:SIGTERM"]) // grup dulu, tanpa fallback
  })

  test("grup hilang (ESRCH) → fallback SIGTERM proses tunggal", () => {
    const calls: string[] = []
    const fallback = {
      kill: (s?: NodeJS.Signals | number) => {
        calls.push(`fallback:${String(s)}`)
        return true
      },
    }
    const out = signalProcessGroupGraceful(4242, fallback, {
      platform: "linux",
      killGroup: () => {
        throw new Error("ESRCH")
      },
    })
    expect(out).toBe("fallback")
    expect(calls).toEqual(["fallback:SIGTERM"])
  })

  test("Windows tidak pernah memakai group-kill SIGTERM (jalur taskkill tetap)", () => {
    const calls: string[] = []
    const fallback = {
      kill: (s?: NodeJS.Signals | number) => {
        calls.push(`fallback:${String(s)}`)
        return true
      },
    }
    const out = signalProcessGroupGraceful(4242, fallback, {
      platform: "win32",
      killGroup: (pid, signal) => {
        calls.push(`group:${pid}:${signal}`)
        return true
      },
    })
    expect(out).toBe("fallback")
    expect(calls).toEqual(["fallback:SIGTERM"])
  })
})
