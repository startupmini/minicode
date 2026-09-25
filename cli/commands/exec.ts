import { randomUUID } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import { NoProviderError } from "../../src/app/provider-layer.ts"
import { createRateLimiter } from "../../src/policy/ratelimit.ts"
import { resolveSandbox, sandboxRefusalReason } from "../../src/policy/sandbox-policy.ts"
import { scrubSecrets } from "../../src/policy/scrub.ts"
import { budgetStatus } from "../../src/policy/usage.ts"
import {
  MACHINE_SCHEMA,
  machineError,
  toMachineEnvelope,
} from "../../src/presentation/projection.ts"
import { clearSubmittedResult, getSubmittedResult } from "../../src/tools/submit_result.ts"
import { formatError } from "../../src/ui/assistant/simple.ts"
import { formatUsd } from "../../src/ui/render/money.ts"
import { cleanUntrusted } from "../../src/ui/render/sanitize.ts"
import { allowLocalConfig, hasFlag, promptFromArgs, getArg as rawGetArg } from "../args.ts"
import { createCliSession } from "../setup.ts"

/** Satu baris stdout mesin: JSON yang sudah di-scrub + tanpa ANSI apa pun. */
function writeMachineLine(line: string): void {
  process.stdout.write(`${cleanUntrusted(scrubSecrets(line), false)}\n`)
}

function machineSummary(ok: boolean, fields: Record<string, unknown>): Record<string, unknown> {
  return { schema: MACHINE_SCHEMA, type: "summary", ok, ...fields }
}

function machineFailure(prompt: string, e: unknown): Record<string, unknown> {
  return machineSummary(false, { error: machineError(e), prompt })
}

export async function handleExec(
  args: string[],
  getArg: (name: string) => string | undefined,
): Promise<never> {
  // Bersihkan state submit_result dari run sebelumnya — tanpa ini, exec
  // berturut-turut dalam proses sama bisa membaca hasil run lama.
  clearSubmittedResult()
  //
  // Prompt diambil lewat promptFromArgs() — satu implementasi yang sama dengan
  // jalur non-exec. Versi sebelumnya menyaring dengan `a !== getArg("--model")`,
  // yang hanya membuang NILAI dari dua flag (`--model`, `--cwd`); nilai flag lain
  // ikut masuk ke prompt. `exec "tes" --provider gorouter --timeout 60000` benar-
  // benar mengirim "tes gorouter 60000" ke model, dan model membalas dengan
  // menebak-nebak soal "gorouter" dan "60000".
  // Router memanggil dengan argv penuh (["exec", ...]) sementara hasFlag/
  // getArg berhenti di token subcommand (boundary anti-injeksi) — tanpa
  // slice, SEMUA flag boolean exec (--json/--verify/--ask/...) mati diam-diam
  // di CLI nyata. Pola yang sama dengan promptFromArgs di bawah.
  const subArgs = args[0] === "exec" ? args.slice(1) : args
  const prompt = promptFromArgs(subArgs) || (rawGetArg(subArgs, "--prompt") ?? "")
  const jsonMode = hasFlag(subArgs, "--json") || rawGetArg(subArgs, "--output-format") === "json"
  const cwdRaw = getArg("--cwd")
  const cwd = cwdRaw ? resolvePath(cwdRaw) : undefined
  const modelOverride = getArg("--model")
  const providerOverride = getArg("--provider")
  const sessionId =
    getArg("--session")
      ?.replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 64) || randomUUID().slice(0, 8)
  const allowAll = hasFlag(subArgs, "--allow-all")
  const ask = hasFlag(subArgs, "--ask")
  const plan = hasFlag(subArgs, "--plan")
  const allowlistFlag = hasFlag(subArgs, "--allowlist")
  // Sama seperti jalur interaktif: OS sandbox otomatis, dan tanpa isolasi nyata
  // permission default turun ke allowlist. Headless CI justru paling butuh ini —
  // di sana tak ada manusia yang bisa menyetujui prompt.
  const requestedSandbox = getArg("--sandbox") ?? process.env.MINICODE_SANDBOX
  // F-03: sama seperti jalur interaktif — permintaan eksplisit tanpa backend
  // = tolak sebelum jalan (fail-closed).
  const sandboxRefusal = sandboxRefusalReason(requestedSandbox)
  if (sandboxRefusal) {
    console.error(sandboxRefusal)
    if (jsonMode)
      writeMachineLine(JSON.stringify(machineFailure(prompt.trim(), new Error(sandboxRefusal))))
    process.exit(1)
  }
  const sandbox = resolveSandbox(requestedSandbox, allowAll || ask || plan || allowlistFlag)
  if (sandbox.mode === "none") delete process.env.MINICODE_SANDBOX
  else process.env.MINICODE_SANDBOX = sandbox.mode
  const allowlist = allowlistFlag || sandbox.fallbackPermission === "allowlist"
  // Audit #07 P0: local config repo tak dipercaya kecuali operator opt-in.
  const allowLocal = allowLocalConfig(subArgs)
  const budgetRaw = getArg("--budget")
  const parsedBudget = budgetRaw ? Number(budgetRaw) : undefined
  const budget =
    parsedBudget !== undefined && Number.isFinite(parsedBudget) && parsedBudget >= 0
      ? parsedBudget
      : undefined
  // Harness-P1: sama seperti one-shot — strict fail-closed bila cost tak dikenal.
  const budgetStrict =
    hasFlag(subArgs, "--budget-strict") || process.env.MINICODE_BUDGET_STRICT === "1"
  // Harness-P2: scope tool sesi.
  const toolScopeRaw = (
    getArg("--tool-scope") ??
    process.env.MINICODE_TOOL_SCOPE ??
    ""
  ).toLowerCase()
  const toolScope = toolScopeRaw === "explore" ? ("explore" as const) : ("full" as const)
  const ratelimitRaw = getArg("--ratelimit")
  const rateLimiter = ratelimitRaw ? createRateLimiter(Number(ratelimitRaw)) : undefined

  const effectivePrompt = prompt.trim()
  if (!effectivePrompt) {
    console.error(
      'usage: minicode exec "prompt" [--json] [--cwd <dir>] [--model <m>] [--sandbox docker|os]',
    )
    if (jsonMode)
      writeMachineLine(
        JSON.stringify(
          machineSummary(false, {
            error: { category: "USER_ERROR", message: "prompt is required" },
          }),
        ),
      )
    process.exit(2)
  }

  const ctx = await createCliSession({
    cwd,
    sessionId,
    modelOverride,
    providerOverride,
    prompt: effectivePrompt,
    enterRepl: false,
    machineOutput: jsonMode,
    verbose: false,
    allowAll,
    ask,
    plan,
    allowlist,
    verify: hasFlag(subArgs, "--verify"),
    allowLocalConfig: allowLocal,
    budget,
    budgetStrict,
    toolScope,
    rateLimiter,
    // Notice hanya bila user eksplisit meminta mode (daemon mati / tak dikenal).
    sandboxNotice: requestedSandbox ? sandbox.notice : undefined,
  }).catch((e) => {
    // Setup gagal SEBELUM envelope JSON dipasang (tanpa provider): mode
    // mesin tetap pulang membawa satu baris summary agar pipeline CI tak
    // menerima stream kosong — stderr manusia + exit 1 tidak berubah.
    if (e instanceof NoProviderError) {
      if (jsonMode) writeMachineLine(JSON.stringify(machineFailure(effectivePrompt, e)))
      console.error(e.message)
      process.exit(1)
    }
    // Setup lain yang gagal (config rusak, dsb.): mesin tetap pulang membawa
    // envelope terminal agar stream tidak kosong, lalu error asli dilempar
    // agar exit code + stderr manusia tidak berubah.
    if (jsonMode) writeMachineLine(JSON.stringify(machineFailure(effectivePrompt, e)))
    throw e
  })
  const t0 = Date.now()
  let streamed = 0
  // Lifecycle kanonik (bukan raw kernel shape): tiap UiPresentationEvent
  // dipetakan ke envelope minicode.output.v1. Teks model tetap record
  // {type:"text",delta} terpisah — delta bukan lifecycle.
  const unsubMachine = ctx.onPresentationEvent
    ? ctx.onPresentationEvent((event) => {
        const envelope = toMachineEnvelope(event, { sessionId, timestamp: Date.now() })
        if (!envelope) return
        streamed++
        if (jsonMode) writeMachineLine(JSON.stringify(envelope))
      })
    : () => {}
  const unsubText = ctx.session.events.on("provider:text", (ev) => {
    const text = (ev as { text?: unknown }).text
    if (typeof text !== "string" || !text) return
    if (!jsonMode) return
    const max = 100_000
    const delta = text.length > max ? text.slice(0, max) : text
    streamed++
    writeMachineLine(
      JSON.stringify({ type: "text", delta, ...(text.length > max ? { truncated: true } : {}) }),
    )
  })
  try {
    await ctx.runPromptWithVerify(effectivePrompt)
    // Harness-P1: exec sebelumnya mengabaikan --budget total (flag diteruskan
    // tapi tak pernah diperiksa). Samakan dengan one-shot: over → exit 1.
    const ue = ctx.usage.getSession(ctx.modelRef.current)
    const bStatus = budgetStatus(budget, ue.cost, budgetStrict, ue.totalTokens)
    if (bStatus !== "ok") {
      const msg =
        bStatus === "over" && ue.cost != null && budget != null
          ? `[budget] ${formatUsd(ue.cost)} > ${formatUsd(budget)} - over budget, stopping.`
          : `[budget] cost unknown (model without pricing) with ${ue.totalTokens} tokens spent - over budget, stopping.`
      unsubMachine()
      unsubText()
      await ctx.persistCurrent(ctx.usage.getSession(ctx.modelRef.current))
      await ctx.close()
      if (jsonMode)
        writeMachineLine(JSON.stringify(machineFailure(effectivePrompt, new Error(msg))))
      else process.stderr.write(`${msg}\n`)
      process.exit(1)
    }
    // Ringkasan memakai total SESI (ue), bukan turn terakhir: dengan --verify
    // (multi-turn + reset antar-siklus) angka turn mengecilkan pemakaian nyata.
    if (jsonMode) {
      // submit_result dari model (bila dipanggil) ikut verbatim — pipeline CI
      // tak perlu menebak batas JSON dari prosa turn terakhir.
      const submitted = getSubmittedResult()
      const result = machineSummary(true, {
        sessionId,
        model: ctx.modelRef.current,
        prompt: effectivePrompt,
        durationMs: Date.now() - t0,
        steps: ctx.session.state.stepCount,
        turns: ctx.session.state.turnCount,
        usage: ue,
        eventCount: streamed,
        ...(submitted ? { submitted: submitted.result } : {}),
      })
      // Event sudah di-stream sebagai JSONL di stdout; summary jadi baris
      // terakhir di stdout juga (bukan stderr) supaya pipeline CI bisa
      // membaca satu stream saja.
      writeMachineLine(JSON.stringify(result))
    } else {
      process.stdout.write(
        `\n[exec] done model=${ctx.modelRef.current} steps=${ctx.session.state.stepCount} tokens=${ue.totalTokens} ${Date.now() - t0}ms\n`,
      )
    }
    unsubMachine()
    unsubText()
    await ctx.persistCurrent(ue)
    await ctx.close()
    process.exit(0)
  } catch (e) {
    if (jsonMode) writeMachineLine(JSON.stringify(machineFailure(effectivePrompt, e)))
    else process.stderr.write(`\n${formatError(e)}\n`)
    unsubMachine()
    unsubText()
    try {
      await ctx.persistCurrent(ctx.usage.getSession(ctx.modelRef.current))
    } catch {}
    await ctx.close()
    process.exit(1)
  }
}
