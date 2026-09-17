#!/usr/bin/env bun
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { createMinicodeSession } from "../src/app/session.ts"
import { createRateLimiter } from "../src/policy/ratelimit.ts"
import { resolveSandbox, sandboxRefusalReason } from "../src/policy/sandbox-policy.ts"
import { budgetStatus } from "../src/policy/usage.ts"
import { attachMutationJournal } from "../src/session/journal.ts"
import { findSkill, renderSkill } from "../src/skills/loader.ts"
import { writeTrace } from "../src/telemetry/trace.ts"
import { setSubAgentSessionFactory } from "../src/tools/task.ts"
import { formatError, takePendingError } from "../src/ui/assistant/simple.ts"
import { formatUsd } from "../src/ui/render/money.ts"
import { c, glyphs } from "../src/ui/render/theme.ts"
import {
  allowLocalConfig,
  hasFlag,
  promptFromArgs,
  getArg as rawGetArg,
  readPrompt,
} from "./args.ts"
import { dispatch } from "./router.ts"
import { createCliSession } from "./setup.ts"

/** Versi dibaca dari package.json — satu sumber, tidak di-hardcode dua tempat. */
function readVersion(): string {
  try {
    const pkgPath = resolvePath(import.meta.dir, "..", "package.json")
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

const HELP = `Minicode - coding agent on frozen MiniCore
Usage:
  minicode                        # interactive chat
  minicode "prompt" [options]     # one-shot run
  minicode exec "prompt" [--json] # headless CI mode (JSON stream)
  echo "prompt" | minicode        # via pipe
  minicode sync                   # refresh models from all providers
Options:
  -h, --help          show help
  -v, --version       show version
  --verbose           show reasoning & usage
  --cwd <dir>         workspace root (default .)
  --allow-local-config trust .minicode/config.json in workspace (default: ignore)
  --resume <id>       resume session id
  --model <name>      override model (provider::model)
  --provider <id>     force provider id
  --session <id>      session id (default random)
  --allow-all         allow all tools
  --ask               ask per tool (y/n/a)
  --plan              read-only mode (no writes, bash, or sub-agents)
  --allowlist         bash allowlist only (see MINICODE_BASH_ALLOWLIST)
  --max-steps <n>     max tool steps (default 50)
  --context-window <n> context window tokens
  --timeout <ms>      hard deadline per run (default 900000, 0 = off)
  --interactive       REPL loop
  --verify            auto-verify + self-heal (typecheck/test/tsconfig)
  --sandbox <mode>    bash sandbox: docker (ephemeral, no network)
  --ratelimit <rpm>   LLM requests per minute
  --budget <usd>      session cost limit
  --budget-strict     unknown cost + spend counts as over budget (fail-closed default)
  --tool-scope <s>    full (default) | explore (read-only subset)

REPL: /help /provider /model /sync /status /sessions /init /exit /mode /undo /redo /clear /copy /history /compact /thinking /expand /minimize
Keys: Enter submit · Tab complete (empty: cycle mode) · Up/Down history · Shift+Tab mode · Ctrl+R search · Ctrl+C stop (2x exit) · + / - expand (busy)
`

const args = process.argv.slice(2)
function getArg(name: string): string | undefined {
  return rawGetArg(args, name)
}

// Update-notifier untuk mode NON-interaktif (one-shot/pipe/subcommand):
// fire-and-forget, cache 24 jam, hormat NO_UPDATE_CHECK/CI/--json.
// REPL interaktif TIDAK lewat sini — ditangani maybeAutoUpdate (cek fresh +
// install + restart) setelah enterRepl dihitung, agar tidak ada pesan ganda.
if (
  !hasFlag(args, "--version") &&
  !args.includes("-v") &&
  !args.includes("-h") &&
  !args.includes("--help")
) {
  const likelyRepl =
    hasFlag(args, "--interactive") || (promptFromArgs(args) === "" && process.stdin.isTTY === true)
  if (!likelyRepl) {
    void (async () => {
      try {
        const ver = readVersion()
        const { checkForUpdate, formatUpdateMessage } = await import(
          "../src/policy/update-check.ts"
        )
        const latest = await checkForUpdate(ver)
        if (latest) process.stderr.write(`\n${c.yellow(formatUpdateMessage(ver, latest))}\n`)
      } catch {}
    })()
  }
}

// DI factory sesi sub-agen untuk delegate_task — dipasang di composition root
// sebelum dispatch agar semua jalur (REPL, one-shot, mcp serve) tercakup.
// Sesi anak mendapat wiring jurnal sendiri (childOf = parent) agar efek anak
// tercatat di jurnal anak, bukan disimpulkan dari finalText parent.
setSubAgentSessionFactory(async (spec) => {
  // `journal` hanya untuk wiring app-layer — jangan bocor ke config kernel.
  const { journal, ...coreSpec } = spec
  const session = await createMinicodeSession(coreSpec)
  if (journal) {
    attachMutationJournal(session, {
      sessionId: journal.sessionId,
      cwd: spec.cwd,
      childOf: journal.parentSessionId,
    })
  }
  return session
})

// dispatch subcommands via registry (handlers call process.exit internally)
await dispatch(args, getArg, HELP)

if (hasFlag(args, "--version") || args.includes("-v")) {
  console.log(readVersion())
  process.exit(0)
}

if (args.includes("-h") || args.includes("--help")) {
  if (args.includes("--json")) {
    // machine-readable help for CI (minicode --help --json)
    console.log(
      JSON.stringify({
        name: "minicode",
        version: readVersion(),
        usage: [
          "minicode",
          'minicode "prompt" [options]',
          'minicode exec "prompt" [--json]',
          "minicode providers|models|sync|config|mcp|skills|sessions|stats|memory",
        ],
        options: [
          { flag: "--version", desc: "show version" },
          { flag: "--verbose", desc: "show reasoning & usage" },
          { flag: "--cwd <dir>", desc: "workspace root" },
          {
            flag: "--allow-local-config",
            desc: "trust .minicode/config.json in workspace (default: ignore)",
          },
          { flag: "--resume <id>", desc: "resume session id" },
          { flag: "--model <name>", desc: "override model (provider::model)" },
          { flag: "--provider <id>", desc: "force provider id" },
          { flag: "--session <id>", desc: "session id" },
          { flag: "--max-steps <n>", desc: "max tool steps (default 50)" },
          { flag: "--context-window <n>", desc: "context window tokens" },
          {
            flag: "--timeout <ms>",
            desc: "hard deadline per run (default 900000 = 15min; 0 = Infinity)",
          },
          { flag: "--allow-all", desc: "allow all tools (no sandbox)" },
          { flag: "--ask", desc: "ask per tool" },
          { flag: "--plan", desc: "read-only plan mode" },
          { flag: "--allowlist", desc: "bash allowlist only" },
          { flag: "--interactive", desc: "REPL loop" },
          { flag: "--verify", desc: "auto-verify + self-heal" },
          { flag: "--sandbox <docker|os>", desc: "bash sandbox" },
          { flag: "--ratelimit <rpm>", desc: "LLM requests/min" },
          { flag: "--budget <usd>", desc: "session cost limit" },
          { flag: "--budget-strict", desc: "unknown cost + spend counts as over budget (default)" },
          { flag: "--tool-scope <full|explore>", desc: "tool subset (explore = read-only)" },
          { flag: "--json", desc: "JSON output (help/exec)" },
        ],
      }),
    )
    process.exit(0)
  }
  console.log(HELP)
  process.exit(0)
}

// -- flag parsing --
const verbose = hasFlag(args, "--verbose")
const allowAll = hasFlag(args, "--allow-all")
const ask = hasFlag(args, "--ask")
const interactive = hasFlag(args, "--interactive")
const plan = hasFlag(args, "--plan") || process.env.MINICODE_PLAN === "1"
const allowlist = hasFlag(args, "--allowlist") || process.env.MINICODE_PERMISSION === "allowlist"
const verify = hasFlag(args, "--verify")
const cwdRaw = getArg("--cwd")
const cwd = cwdRaw ? resolvePath(cwdRaw) : undefined
// Audit #07 P0: local config repo tak dipercaya kecuali operator opt-in
// eksplisit per-invokasi (flag atau env). Tanpa ini repo clone-an bisa
// men-spawn MCP server dan menyedot prompt ke endpoint penyerang.
const allowLocal = allowLocalConfig(args)
const resumeId = getArg("--resume")
  ?.replace(/[^A-Za-z0-9._-]/g, "-")
  .slice(0, 64)
const modelOverride = getArg("--model")
const providerOverride = getArg("--provider")
const rawSessionId = getArg("--session") ?? randomUUID().slice(0, 8)
const sessionId =
  rawSessionId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || randomUUID().slice(0, 8)
const maxStepsRaw = getArg("--max-steps")
let maxSteps = maxStepsRaw ? Number(maxStepsRaw) : undefined
if (maxStepsRaw && (!Number.isFinite(maxSteps) || (maxSteps as number) <= 0)) {
  process.stderr.write(`[warn] --max-steps requires a positive number, ignoring "${maxStepsRaw}"\n`)
  maxSteps = undefined
}
const ctxWindowRaw = getArg("--context-window")
let contextWindowTokens = ctxWindowRaw ? Number(ctxWindowRaw) : undefined
if (
  ctxWindowRaw &&
  (!Number.isFinite(contextWindowTokens) || (contextWindowTokens as number) <= 0)
) {
  process.stderr.write(
    `[warn] --context-window requires a positive number, ignoring "${ctxWindowRaw}"\n`,
  )
  contextWindowTokens = undefined
}
const timeoutRaw = getArg("--timeout")
let timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined
if (timeoutRaw && (!Number.isFinite(timeoutMs) || (timeoutMs as number) < 0)) {
  process.stderr.write(
    `[warn] --timeout requires a non-negative number, ignoring "${timeoutRaw}"\n`,
  )
  timeoutMs = undefined
}

// Sandbox: OS-native dipakai otomatis bila tersedia. Bila tidak ada isolasi
// nyata dan user belum memilih mode permission sendiri, default diturunkan ke
// `allowlist` — lebih baik membatasi perintah daripada menjalankan apa pun
// sambil menampilkan label aman. Lihat src/policy/sandbox-policy.ts.
const explicitPermission = allowAll || ask || plan || allowlist
const requestedSandbox = getArg("--sandbox") ?? process.env.MINICODE_SANDBOX
// F-03: permintaan sandbox EKSPLISIT tanpa backend = tolak sebelum jalan
// (fail-closed). resolveSandbox di bawah tetap menghitung downgrade allowlist
// untuk notice, tetapi proses tidak lanjut ke eksekusi host.
const sandboxRefusal = sandboxRefusalReason(requestedSandbox)
if (sandboxRefusal) {
  console.error(sandboxRefusal)
  process.exit(1)
}
const sandbox = resolveSandbox(requestedSandbox, explicitPermission)
if (sandbox.mode === "none") delete process.env.MINICODE_SANDBOX
else process.env.MINICODE_SANDBOX = sandbox.mode
// Notice sandbox hanya bila user eksplisit meminta mode (mis. daemon mati,
// mode tak dikenal). Notice rutin disembunyikan: mode terlihat di prefiks.
// Cetaknya di setup, setelah provider layer lolos.
const effectiveAllowlist = allowlist || sandbox.fallbackPermission === "allowlist"
const budgetRaw = getArg("--budget")
let budget = budgetRaw ? Number(budgetRaw) : undefined
if (budgetRaw && (!Number.isFinite(budget) || (budget as number) < 0)) {
  process.stderr.write(`[warn] --budget requires a USD number, ignoring "${budgetRaw}"\n`)
  budget = undefined
}
// Harness-P1: strict lewat flag ATAU env (simetri dengan MINICODE_SANDBOX_STRICT).
const budgetStrict = hasFlag(args, "--budget-strict") || process.env.MINICODE_BUDGET_STRICT === "1"
// Harness-P2: scope tool sesi; nilai selain explore jatuh ke full (eksplisit di bawah).
const toolScopeRaw = (getArg("--tool-scope") ?? process.env.MINICODE_TOOL_SCOPE ?? "").toLowerCase()
const toolScope = toolScopeRaw === "explore" ? ("explore" as const) : ("full" as const)
const ratelimitRaw = getArg("--ratelimit")
let rateLimiter: ReturnType<typeof createRateLimiter> | undefined
if (ratelimitRaw) {
  const rpm = Number(ratelimitRaw)
  if (!Number.isFinite(rpm) || rpm <= 0) {
    process.stderr.write(
      `[warn] --ratelimit requires a positive number, ignoring "${ratelimitRaw}"\n`,
    )
  } else {
    rateLimiter = createRateLimiter(rpm)
  }
}

const prompt = promptFromArgs(args) || (await readPrompt())
const enterRepl = interactive || (!prompt && process.stdin.isTTY)
// REPL interaktif: cek update FRESH tiap dibuka → install + restart bila ada
// versi baru (tak pernah kembali bila restart). Tampilkan spinner 1.8 dtk
// agar tidak terlihat hang — budget tetap, hanya UX.
if (enterRepl) {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 1800)
  let spin: ReturnType<typeof setInterval> | undefined
  let showTimer: ReturnType<typeof setTimeout> | undefined
  let fi = 0
  // Dipanggil auto-update SEBELUM fase panjang (install npm + respawn anak):
  // matikan spinner agar tak menulis ke stderr yang sama dengan anak selama
  // berjam-jam (stdio inherit) — itu yang terlihat sebagai hang/flicker.
  // Idempoten: aman dipanggil dua kali (sebelum install, sebelum restart).
  let longOpCleaned = false
  const stopUpdateSpin = () => {
    if (longOpCleaned) return
    longOpCleaned = true
    if (showTimer) clearTimeout(showTimer)
    showTimer = undefined
    if (spin) {
      clearInterval(spin)
      spin = undefined
      try {
        process.stderr.write("\r\x1b[2K")
      } catch {}
    }
  }
  if (process.stderr.isTTY) {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    showTimer = setTimeout(() => {
      spin = setInterval(() => {
        const f = frames[fi++ % frames.length]!
        process.stderr.write(`\r\x1b[2K${c.dim(`${f} Checking for updates…`)}`)
      }, 80)
    }, 120)
  }
  try {
    const { maybeAutoUpdate } = await import("./auto-update.ts")
    await maybeAutoUpdate(readVersion(), ctrl.signal, { onLongOp: stopUpdateSpin })
  } catch {}
  clearTimeout(to)
  if (showTimer) clearTimeout(showTimer)
  if (spin) {
    clearInterval(spin)
    process.stderr.write("\r\x1b[2K")
  }
}
if (!prompt && !enterRepl) {
  process.stderr.write('usage: minicode "prompt"  |  minicode (interactive mode)\n')
  process.exit(1)
}

// -- skills: expand /name args --
let effectivePrompt = prompt
try {
  if (prompt.startsWith("/")) {
    const spaceIdx = prompt.indexOf(" ")
    const skillName = spaceIdx === -1 ? prompt.slice(1) : prompt.slice(1, spaceIdx)
    const skillArgs = spaceIdx === -1 ? "" : prompt.slice(spaceIdx + 1)
    const skill = await findSkill(skillName, cwd)
    if (skill) {
      effectivePrompt = await renderSkill(skill, skillArgs)
      console.error(c.dim(`[loaded skill /${skill.name}]`))
    }
  }
} catch {}

// -- build session --
// Session setup (provider/RAG/MCP/session) bisa makan detik (network + spawn)
// TANPA output — user melihat kursor mati. Spinner transient TTY-only selama
// setup, dibersihkan sebelum banner REPL agar tak ada jejak.
let setupSpin: ReturnType<typeof setInterval> | undefined
if (enterRepl && process.stderr.isTTY) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  let fi = 0
  setupSpin = setInterval(() => {
    const f = frames[fi++ % frames.length]!
    process.stderr.write(`\r\x1b[2K${c.dim(`${f} Menyiapkan sesi…`)}`)
  }, 120)
}
const stopSetupSpin = () => {
  if (setupSpin) {
    clearInterval(setupSpin)
    setupSpin = undefined
    try {
      process.stderr.write("\r\x1b[2K")
    } catch {}
  }
}
// finally: createCliSession yang melempar (provider/MCP gagal) tak boleh
// membocorkan interval — tanpa ini spinner menulis ke stderr selamanya dan
// proses tak pernah exit (terlihat hang).
let ctx: Awaited<ReturnType<typeof createCliSession>>
try {
  ctx = await createCliSession({
    cwd,
    sessionId,
    resumeId,
    modelOverride,
    providerOverride,
    prompt,
    enterRepl,
    verbose,
    allowAll,
    ask,
    plan,
    allowlist: effectiveAllowlist,
    verify,
    allowLocalConfig: allowLocal,
    budget,
    budgetStrict,
    toolScope,
    maxSteps,
    contextWindowTokens,
    timeoutMs,
    rateLimiter,
    sandboxNotice: requestedSandbox ? sandbox.notice : undefined,
  })
} finally {
  stopSetupSpin()
}

if (enterRepl) {
  const { runRepl } = await import("./repl.ts")
  await runRepl(ctx)
} else {
  const {
    session,
    usage,
    modelRef,
    budget: b,
    budgetStrict: strict,
    cwd: wcwd,
    sessionId: sid,
    persistCurrent,
    runPromptWithVerify,
    close,
  } = ctx
  const t0 = Date.now()
  try {
    await runPromptWithVerify(effectivePrompt)
    // Total SESI, bukan turn: satu one-shot hanya punya satu turn, tapi
    // --verify/self-heal bisa menjalankan beberapa dan reset() di antaranya.
    const u = usage.getSession(modelRef.current)
    let overBudget = false
    const status = budgetStatus(b, u.cost, strict ?? false, u.totalTokens)
    if (status === "over" && u.cost != null && b != null) {
      process.stderr.write(
        c.red(`[budget] ${formatUsd(u.cost)} > ${formatUsd(b)} - over budget, stopping.\n`),
      )
      overBudget = true
    } else if (status === "unknown-strict" && b != null) {
      process.stderr.write(
        c.red(
          `[budget] cost unknown (model without pricing) with ${u.totalTokens} tokens spent - over budget, stopping.\n`,
        ),
      )
      overBudget = true
    } else if (b != null && u.cost != null && u.cost > b * 0.8)
      process.stderr.write(c.yellow(`[budget] ${formatUsd(u.cost)} / ${formatUsd(b)} (80% used)\n`))
    await persistCurrent(u)
    if (overBudget) {
      await close()
      process.exit(1)
    }
    const statusLine = c.muted(
      `\n  ${u.totalTokens.toLocaleString()} token${u.cost != null ? ` · ${formatUsd(u.cost)}` : ""} · ${session.state.stepCount} langkah · ${Math.round((Date.now() - t0) / 1000)}s`,
    )
    process.stderr.write(`${statusLine}`)
    const mUsed = usage.modelUsed()
    if (mUsed.effective && mUsed.effective !== modelRef.current) {
      process.stderr.write(
        c.dim(
          `  (via ${mUsed.provider ?? "?"}/${mUsed.effective} - requested ${modelRef.current})`,
        ),
      )
    }
    process.stderr.write("\n")
    // Model untuk trace: `modelRef.current` kosong bila user tidak memberi
    // --model, dan trace bermodel kosong tidak bisa diatribusikan ke provider —
    // kolom Status di `minicode providers` jadi selalu "belum dipakai" meski
    // sudah dipakai. Pakai model efektif (hasil substitusi router) bila ada.
    const traceModel = mUsed.effective ?? modelRef.current ?? ctx.effectiveInitialModel
    await writeTrace(wcwd, {
      sessionId: sid,
      timestamp: new Date().toISOString(),
      prompt: effectivePrompt,
      durationMs: Date.now() - t0,
      steps: session.state.stepCount,
      turns: session.state.turnCount,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cost: u.cost,
      model: traceModel,
      ok: true,
      memoryHits: ctx.memoryHits,
      overBudget,
    })
  } catch (e) {
    // Error provider biasanya sudah dirender ramah oleh event handler
    // (takePendingError) — cetak sekali saja, jangan dua blok ✗.
    const shown = takePendingError()
    process.stderr.write(`\n${c.red(glyphs.cross)} ${shown ?? formatError(e)}\n`)
    // Audit #04 P1: sama seperti REPL — turn gagal setelah delegasi
    // committed = efek anak tetap ada. One-shot tak punya retry loop, tapi
    // user yang menjalankan ulang manual butuh peringatan yang sama.
    try {
      const { committedDelegatesSince } = await import("../src/session/journal.ts")
      const done = await committedDelegatesSince(sid, wcwd, t0)
      for (const d of done) {
        process.stderr.write(
          c.yellow(
            `[recovery] turn failed after sub-agent ${d.childSessionId} completed — its effects stand; verify before re-delegating\n`,
          ),
        )
      }
    } catch {}
    const uErr = usage.getSession(modelRef.current)
    await writeTrace(wcwd, {
      sessionId: sid,
      timestamp: new Date().toISOString(),
      prompt: effectivePrompt,
      durationMs: Date.now() - t0,
      steps: session.state.stepCount,
      turns: session.state.turnCount,
      inputTokens: uErr.inputTokens,
      outputTokens: uErr.outputTokens,
      model: usage.modelUsed().effective ?? modelRef.current ?? ctx.effectiveInitialModel,
      ok: false,
      error: formatError(e),
      memoryHits: ctx.memoryHits,
      overBudget: b != null && uErr.cost != null && uErr.cost > b,
    })
    await close()
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 200))
  await close()

  if (ctx.permissionMode === "plan" && process.stdin.isTTY) {
    const { createInterface } = await import("node:readline")
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ans = await new Promise<string>((res) =>
      rl.question(c.yellow("\nProceed to execute this plan? [y/N] "), res),
    )
    rl.close()
    if (ans.trim().toLowerCase() === "y") {
      const { spawn } = await import("node:child_process")
      const { waitChildExit } = await import("./auto-update.ts")
      const entry = process.argv[1] ?? resolvePath(import.meta.dir, "index.ts")
      const filtered = args.filter((a) => a !== "--plan")
      const child = spawn(process.execPath, [entry, ...filtered], {
        stdio: "inherit",
        env: { ...process.env, MINICODE_PLAN: "0" },
      })
      // Tunggu via mekanisme tunggal (exit+close+error): exit saja bisa tak
      // datang bila anak menahan stdio = induk gantung tanpa prompt.
      void waitChildExit(child).then((code) => process.exit(code ?? 0))
      process.stdin.resume()
    } else {
      process.exit(0)
    }
  }
}
