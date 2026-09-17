import { randomUUID } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import { createRateLimiter } from "../../src/policy/ratelimit.ts"
import { resolveSandbox, sandboxRefusalReason } from "../../src/policy/sandbox-policy.ts"
import { scrubSecrets } from "../../src/policy/scrub.ts"
import { budgetStatus } from "../../src/policy/usage.ts"
import { getSubmittedResult } from "../../src/tools/submit_result.ts"
import { formatError } from "../../src/ui/assistant/simple.ts"
import { formatUsd } from "../../src/ui/render/money.ts"
import { allowLocalConfig, hasFlag, promptFromArgs, getArg as rawGetArg } from "../args.ts"
import { createCliSession } from "../setup.ts"

export async function handleExec(
  args: string[],
  getArg: (name: string) => string | undefined,
): Promise<never> {
  // minicode exec "prompt" [--json] [--cwd <dir>] [--model <m>] [--sandbox docker|os] ...
  //
  // Prompt diambil lewat promptFromArgs() — satu implementasi yang sama dengan
  // jalur non-exec. Versi sebelumnya menyaring dengan `a !== getArg("--model")`,
  // yang hanya membuang NILAI dari dua flag (`--model`, `--cwd`); nilai flag lain
  // ikut masuk ke prompt. `exec "tes" --provider gorouter --timeout 60000` benar-
  // benar mengirim "tes gorouter 60000" ke model, dan model membalas dengan
  // menebak-nebak soal "gorouter" dan "60000".
  const prompt = promptFromArgs(args.slice(1)) || (rawGetArg(args, "--prompt") ?? "")
  const jsonMode = hasFlag(args, "--json") || rawGetArg(args, "--output-format") === "json"
  const cwdRaw = getArg("--cwd")
  const cwd = cwdRaw ? resolvePath(cwdRaw) : undefined
  const modelOverride = getArg("--model")
  const providerOverride = getArg("--provider")
  const sessionId =
    getArg("--session")
      ?.replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 64) || randomUUID().slice(0, 8)
  const allowAll = hasFlag(args, "--allow-all")
  const ask = hasFlag(args, "--ask")
  const plan = hasFlag(args, "--plan")
  const allowlistFlag = hasFlag(args, "--allowlist")
  // Sama seperti jalur interaktif: OS sandbox otomatis, dan tanpa isolasi nyata
  // permission default turun ke allowlist. Headless CI justru paling butuh ini —
  // di sana tak ada manusia yang bisa menyetujui prompt.
  const requestedSandbox = getArg("--sandbox") ?? process.env.MINICODE_SANDBOX
  // F-03: sama seperti jalur interaktif — permintaan eksplisit tanpa backend
  // = tolak sebelum jalan (fail-closed).
  const sandboxRefusal = sandboxRefusalReason(requestedSandbox)
  if (sandboxRefusal) {
    console.error(sandboxRefusal)
    process.exit(1)
  }
  const sandbox = resolveSandbox(requestedSandbox, allowAll || ask || plan || allowlistFlag)
  if (sandbox.mode === "none") delete process.env.MINICODE_SANDBOX
  else process.env.MINICODE_SANDBOX = sandbox.mode
  const allowlist = allowlistFlag || sandbox.fallbackPermission === "allowlist"
  // Audit #07 P0: local config repo tak dipercaya kecuali operator opt-in.
  const allowLocal = allowLocalConfig(args)
  const budgetRaw = getArg("--budget")
  const parsedBudget = budgetRaw ? Number(budgetRaw) : undefined
  const budget =
    parsedBudget !== undefined && Number.isFinite(parsedBudget) && parsedBudget >= 0
      ? parsedBudget
      : undefined
  // Harness-P1: sama seperti one-shot — strict fail-closed bila cost tak dikenal.
  const budgetStrict =
    hasFlag(args, "--budget-strict") || process.env.MINICODE_BUDGET_STRICT === "1"
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
    process.exit(1)
  }

  const ctx = await createCliSession({
    cwd,
    sessionId,
    modelOverride,
    providerOverride,
    prompt: effectivePrompt,
    enterRepl: false,
    verbose: false,
    allowAll,
    ask,
    plan,
    allowlist,
    verify: hasFlag(args, "--verify"),
    allowLocalConfig: allowLocal,
    budget,
    budgetStrict,
    toolScope,
    rateLimiter,
    // Notice hanya bila user eksplisit meminta mode (daemon mati / tak dikenal).
    sandboxNotice: requestedSandbox ? sandbox.notice : undefined,
  })
  const t0 = Date.now()
  const events: unknown[] = []
  // EventBus kernel butuh (type, handler). Memanggil on(handler) 1-argumen
  // mendaftarkan listener di bawah key "function" → tidak pernah terpanggil,
  // sehingga --json tidak pernah stream apa pun. "*" = semua event.
  const unsub = ctx.session.events.on("*", (ev) => {
    events.push(ev)
    if (jsonMode) {
      // stream JSON lines like Codex/Gemini — di-scrub dulu: event bisa
      // membawa tool output berisi secret ke stdout pipeline CI, sementara
      // trace file sudah di-scrub sejak awal.
      process.stdout.write(`${scrubSecrets(JSON.stringify(ev))}\n`)
    }
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
      unsub()
      await ctx.close()
      if (jsonMode)
        process.stdout.write(
          `${scrubSecrets(JSON.stringify({ type: "summary", ok: false, error: msg, prompt: effectivePrompt }))}\n`,
        )
      else process.stderr.write(`${msg}\n`)
      process.exit(1)
    }
    // Ringkasan memakai total SESI (ue), bukan turn terakhir: dengan --verify
    // (multi-turn + reset antar-siklus) angka turn mengecilkan pemakaian nyata.
    if (jsonMode) {
      // submit_result dari model (bila dipanggil) ikut verbatim — pipeline CI
      // tak perlu menebak batas JSON dari prosa turn terakhir.
      const submitted = getSubmittedResult()
      const result = {
        type: "summary" as const,
        ok: true,
        sessionId,
        model: ctx.modelRef.current,
        prompt: effectivePrompt,
        durationMs: Date.now() - t0,
        steps: ctx.session.state.stepCount,
        turns: ctx.session.state.turnCount,
        usage: ue,
        eventCount: events.length,
        ...(submitted ? { submitted: submitted.result } : {}),
      }
      // Event sudah di-stream sebagai JSONL di stdout; summary jadi baris
      // terakhir di stdout juga (bukan stderr) supaya pipeline CI bisa
      // membaca satu stream saja.
      process.stdout.write(`${scrubSecrets(JSON.stringify(result))}\n`)
    } else {
      process.stdout.write(
        `\n[exec] done model=${ctx.modelRef.current} steps=${ctx.session.state.stepCount} tokens=${ue.totalTokens} ${Date.now() - t0}ms\n`,
      )
    }
    unsub()
    await ctx.close()
    process.exit(0)
  } catch (e) {
    if (jsonMode)
      process.stdout.write(
        `${scrubSecrets(JSON.stringify({ type: "summary", ok: false, error: formatError(e), prompt: effectivePrompt }))}\n`,
      )
    else process.stderr.write(`\n${formatError(e)}\n`)
    unsub()
    await ctx.close()
    process.exit(1)
  }
}
