// Driver TUI — komposisi: CliSession + Transcript + TuiApp. Satu-satunya
// tampilan interaktif (tanpa mode).
//
// Peran: TERJEMAHKAN dunia cli/ (budget, skill, mention, mode, clipboard)
// menjadi TuiHost, lalu jalankan App fullscreen. Semua output user-visible
// masuk Transcript (bukan console) — console.log mentah di sini akan menimpa
// frame alt-screen. Satu-satunya console yang tersisa: fallback non-mampu
// (belum start) dan error fatal.
//
// Perilaku khas TUI (kontrak I17-I24):
// - histori prompt = memori sesi (tak persist ke berkas).
// - /clear = kosongkan transkrip (bukan penanda scrollback).
// - /status, /history & /help ringkas = readout ke transkrip (bukan jendela
//   modal) — transkrip fullscreen SUDAH permukaan baca; modal untuk info
//   statis hanya menambah langkah. /model & /provider & /sessions = popup
//   komposit (butuh interaksi pilih).
// - busy = input beku total kecuali abort (Esc) dan scroll.
import { expandMentions } from "../src/app/mentions.ts"
import { budgetStatus } from "../src/policy/usage.ts"
import {
  describeActivity,
  elapsedVisible,
  matchTurnBySummary,
} from "../src/presentation/projection.ts"
import { redoLastCheckpoint, undoLastCheckpoint } from "../src/session/checkpoint.ts"
import { renderSkill } from "../src/skills/loader.ts"
import {
  getLastTurnTexts,
  MAX_COPY_TURNS,
  writeClipboardOsc52,
} from "../src/ui/assistant/simple.ts"
import type { UiBus } from "../src/ui/contract.ts"
import { t } from "../src/ui/i18n/locale.ts"
import { loadHistory } from "../src/ui/input/input.ts"
import {
  clearCollapsedSections,
  collapsedSectionsSnapshot,
  sectionMinimized,
  setSectionMinimized,
} from "../src/ui/render/collapse.ts"
import { setCompactMode } from "../src/ui/render/detail.ts"
import { formatUsd } from "../src/ui/render/money.ts"
import { setReasoningVisible } from "../src/ui/render/reasoning.ts"
import { c } from "../src/ui/render/theme.ts"
import { TuiApp, type TuiHost } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import {
  BUILTIN_COMMANDS,
  type CommandContext,
  DRIVER_HELP_COMMANDS,
  handleBuiltinCommand,
  persistModelChoice,
  suggestSimilar,
} from "./commands.ts"
import type { CliSession } from "./setup.ts"

const MODES = ["auto", "ask", "plan", "allowlist", "allow-all"] as const
// /expand [id]: tanpa arg = semua entry store; dengan id = satu tool.
const DRIVER_COMMANDS = ["/compact", "/thinking", "/expand [id]", "/minimize"]

function fmtCtx(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1000000) return `${Math.round(n / 1000)}k`
  return `${(n / 1000000).toFixed(1)}m`
}

/**
 * Tangkap console.log/error selama `fn` → baris teks (tanpa warna liar:
 * caller yang mewarnai). Dipakai membungkus handleBuiltinCommand supaya
 * readout warisan (/help, pin jendela, pesan undo) mendarat di transkrip,
 * bukan menimpa frame alt-screen. View modal menulis via stdout.write
 * langsung (bukan console) sehingga tak ikut tertangkap — layarnya tetap
 * tampil normal (nested refcount screen.ts). Baris yang sudah tercetak
 * SEBELUM fn melempar tetap dikembalikan via capturedLines (ditempel ke
 * error) — tanpa ini kegagalan di tengah readout (/sync) diam-diam
 * membuang output parsial.
 */
async function captureConsole(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
  }
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
  }
  const flush = () => lines.flatMap((l) => l.split("\n"))
  try {
    await fn()
  } catch (e) {
    ;(e as { capturedLines?: string[] }).capturedLines = flush()
    throw e
  } finally {
    console.log = origLog
    console.error = origErr
  }
  return flush()
}

export async function runTui(ctx: CliSession): Promise<void> {
  const {
    cfg,
    cwd,
    sessionId,
    modelRef,
    permissionMode,
    permissions,
    sessionTools,
    allLoadedSkills,
    allowLocalConfig,
    usage,
    budget,
    budgetStrict,
    persistCurrent,
    runPromptWithVerify,
    close,
  } = ctx
  const { session } = ctx
  const getPresentationSnapshot = () =>
    typeof ctx.getPresentationSnapshot === "function"
      ? ctx.getPresentationSnapshot()
      : { activities: [], turns: [] }

  let mode: string = permissions?.getMode() ?? permissionMode ?? "auto"
  if (process.env.MINICODE_COMPACT === undefined) setCompactMode(true)
  if (process.env.MINICODE_MINIMIZE_TOOL === undefined) setSectionMinimized("tool", true)
  let warned80 = false
  let abort: AbortController | null = null

  // Bahasa UI: state.json (sesi bisa menimpa via /lang). Gagal baca = default.
  const { setConfigLocale } = await import("../src/ui/i18n/locale.ts")
  try {
    const { loadLang } = await import("../src/config.ts")
    setConfigLocale((await loadLang().catch(() => undefined)) ?? null)
  } catch {}

  // Kebijakan proyeksi kanonik di-inject di sini (batas lapisan: src/ui
  // tidak boleh impor src/presentation).
  const transcript = new Transcript(session.events as unknown as UiBus, {
    getSnapshot: getPresentationSnapshot,
    onPresentationEvent: ctx.onPresentationEvent,
    policy: {
      describeActivity,
      matchTurn: matchTurnBySummary,
      elapsedVisible,
    },
  })

  const commandCtx: CommandContext = {
    cwd,
    sessionId,
    allowLocalConfig,
    get currentModel() {
      return modelRef.current ?? cfg.providers[0]?.models[0]
    },
    set currentModel(v) {
      modelRef.current = v
    },
    usage,
    skills: allLoadedSkills,
    toolsCount: sessionTools.length,
    providerHint: cfg.providers[0]?.providerHint,
    setModelOverride: (m) => persistModelChoice(m, modelRef),
    // Spawn anak stdio-inherit (/sessions <id>): keluar alt-screen + cooked
    // mode DULU — anak mewarisi terminal apa adanya. Tanpa ini: double-ENTER,
    // EXIT anak merobek buffer parent, stdin mentah macet. Gagal-di-kode-lama.
    onBeforeSpawn: () => app.releaseTerminal(),
    getContextTokens: () => session.contextTokens,
    budgetState: () => {
      const u = usage.getSession()
      return budgetStatus(budget, u.cost, budgetStrict ?? false, u.totalTokens)
    },
  }

  const suggestions = (line: string): string[] => {
    if (!line.startsWith("/")) return []
    const all = [
      ...BUILTIN_COMMANDS.map((b) => `/${b.name}`),
      ...DRIVER_COMMANDS,
      ...allLoadedSkills.map((s) => `/${s.name}`),
    ]
    return all.filter((t) => t.startsWith(line))
  }

  const cycleMode = (dir: 1 | -1): void => {
    const idx = (MODES as readonly string[]).indexOf(mode)
    // allow-all hanya via flag --allow-all (paritas REPL).
    let next = MODES[(idx + dir + MODES.length) % MODES.length]!
    if (next === "allow-all") next = MODES[(idx + dir * 2 + MODES.length * 2) % MODES.length]!
    mode = next
    if (permissions) permissions.setMode(mode as (typeof MODES)[number])
    else mode = permissionMode ?? mode
  }

  async function runBuiltin(
    q: string,
  ): Promise<{ lines: string[]; shouldExit: boolean; handled: boolean }> {
    let shouldExit = false
    let handled = false
    let lines: string[] = []
    try {
      lines = await captureConsole(async () => {
        const r = await handleBuiltinCommand(q, commandCtx)
        shouldExit = !!r.shouldExit
        handled = r.handled
      })
    } catch (e) {
      // Baris parsial yang sempat tercetak sebelum throw tetap tampil —
      // tanpa ini hanya pesan error generik yang keluar (data-loss diam).
      lines = (e as { capturedLines?: string[] }).capturedLines ?? []
      if (lines.length) transcript.pushInfo(lines)
      throw e
    }
    return { lines, shouldExit, handled }
  }

  async function delegateBuiltin(q: string): Promise<{ quit?: boolean }> {
    const { lines, shouldExit } = await runBuiltin(q)
    if (lines.length) transcript.pushInfo(lines)
    return shouldExit ? { quit: true } : {}
  }

  /**
   * Builtin yang membuka popup: bekukan App (input dilepas + layar redup),
   * view melukis regionnya sendiri, App repaint saat kembali. Tanpa ini
   * byte masuk ke dua tempat (App + popup) dan frame App menimpa popup.
   * Struk mutasi: model/provider yang berubah saat popup terbuka dicatat
   * ke transkrip (jejak audit — scroll ke atas selalu menunjukkan ganti).
   */
  async function popupBuiltin(q: string): Promise<{ quit?: boolean }> {
    const before = commandCtx.currentModel
    app.suspend()
    try {
      return await delegateBuiltin(q)
    } catch (e) {
      // Spawn anak gagal (terminal sudah dilepas onBeforeSpawn): hidupkan
      // kembali atau keluar bersih — jangan biarkan TUI mati tanpa layar.
      if (!app.reacquireTerminal()) app.requestQuit()
      throw e
    } finally {
      app.resume()
      const after = commandCtx.currentModel
      if (after && after !== before) transcript.pushInfo([c.muted(t("tui.modelSet", { v: after }))])
    }
  }

  async function runTurn(prompt: string): Promise<void> {
    const spent = usage.getSession(modelRef.current)
    const preStatus = budgetStatus(budget, spent.cost, budgetStrict ?? false, spent.totalTokens)
    if (preStatus === "over" && spent.cost != null && budget != null) {
      transcript.pushError(
        t("tui.budgetOver", { spent: formatUsd(spent.cost), budget: formatUsd(budget) }),
      )
      return
    }
    if (preStatus === "unknown-strict") {
      transcript.pushError(t("tui.budgetUnknown", { tokens: spent.totalTokens }))
      return
    }
    let finalPrompt = prompt
    if (prompt.includes("@")) {
      const expanded = await expandMentions(prompt, cwd ?? process.cwd())
      finalPrompt = expanded.prompt
      if (expanded.notes.length)
        transcript.pushInfo(expanded.notes.map((n) => c.muted(`  [@mention] ${n}`)))
    }
    const ctrl = new AbortController()
    abort = ctrl
    try {
      await runPromptWithVerify(finalPrompt, ctrl.signal)
      if (ctrl.signal.aborted) transcript.pushInfo([c.muted(t("tui.stopped"))])
    } finally {
      abort = null
    }
    const u = usage.get(modelRef.current)
    await persistCurrent(u)
    usage.reset()
    const sess = usage.getSession(modelRef.current)
    if (
      budget != null &&
      sess.cost != null &&
      sess.cost > budget * 0.8 &&
      sess.cost <= budget &&
      !warned80
    ) {
      warned80 = true
      transcript.pushInfo([
        c.muted(t("tui.budget80", { spent: formatUsd(sess.cost), budget: formatUsd(budget) })),
      ])
    }
  }

  /**
   * /help ringkas (≤6 baris): daftar perintah muat viewport tanpa
   * membanjiri transkrip. Detail penuh = `/help tombol` (delegasi).
   */
  function helpConcise(): void {
    // Diturunkan dari registry (BUILTIN + driver) — perintah baru tak bisa
    // hilang dari /help diam-diam (satu sumber, bukan daftar hardcode).
    const builtin = BUILTIN_COMMANDS.map((b) => `/${b.name}`).join(" ")
    const driver = [...DRIVER_COMMANDS, ...DRIVER_HELP_COMMANDS.map((b) => `/${b.name}`)].join(" ")
    transcript.pushInfo([
      t("help.cHead"),
      `  ${builtin}`,
      `  ${driver}`,
      t("help.cKeys"),
      t("help.cMore"),
    ])
  }

  function parseCopyCount(raw: string): number | null {
    if (!raw) return 1
    if (!/^\d+$/.test(raw)) return null
    const count = Number(raw)
    return count >= 1 && count <= MAX_COPY_TURNS ? count : null
  }

  async function copyLastTurn(count: number): Promise<void> {
    const turns = getLastTurnTexts(count)
      .map((turn) => turn.trim())
      .filter(Boolean)
    const txt = turns.join("\n\n").trim()
    if (!txt) {
      transcript.pushInfo([c.muted(t("tui.copyNone"))])
      return
    }
    if (writeClipboardOsc52(txt)) {
      const key = turns.length > 1 ? "tui.copyOkMany" : "tui.copyOk"
      transcript.pushInfo([c.muted(t(key, { n: txt.length, turns: turns.length }))])
    } else transcript.pushInfo([c.muted(t("tui.copyNeedTty"))])
  }

  async function submit(line: string): Promise<{ quit?: boolean } | undefined> {
    if (!line.startsWith("/")) {
      await runTurn(line)
      return
    }
    const spaceIdx = line.indexOf(" ")
    const name = (spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx)).toLowerCase()
    const args = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim()

    if (name === "") {
      helpConcise()
      return
    }
    if (name === "help" && !args) {
      helpConcise()
      return
    }
    if (name === "exit" || name === "quit") return { quit: true }
    if (name === "clear") {
      // Reset via App (bukan transcript.clear langsung) agar scrollBack dan
      // basis indikator ikut kembali ke ekor — tanpa ini viewport basi.
      app.clearView()
      return
    }
    if (name === "mode") {
      if (args) {
        if (!(MODES as readonly string[]).includes(args)) {
          transcript.pushInfo([c.muted(t("tui.unknownMode", { a: args, modes: MODES.join(", ") }))])
          return
        }
        mode = args
        permissions?.setMode(args as (typeof MODES)[number])
      } else {
        cycleMode(1)
      }
      transcript.pushInfo([c.muted(t("tui.modeLine", { m: mode }))])
      return
    }
    if (name === "lang") {
      const { currentLocale, setSessionLocale } = await import("../src/ui/i18n/locale.ts")
      if (!args) {
        transcript.pushInfo([c.muted(t("tui.langLine", { v: `${currentLocale()} (en|id)` }))])
        return
      }
      const next = args.trim().toLowerCase()
      if (next !== "en" && next !== "id") {
        transcript.pushInfo([c.muted(t("tui.langUnknown", { a: args }))])
        return
      }
      setSessionLocale(next)
      // Simpan permanen (best-effort); sesi ini langsung berlaku via session.
      try {
        const { saveLang } = await import("../src/config.ts")
        await saveLang(next)
      } catch {}
      transcript.pushInfo([c.muted(t("tui.langLine", { v: next }))])
      return
    }
    if (name === "compact") {
      const next = args === "" ? undefined : args === "on" || args === "1"
      const compact = setCompactMode(next)
      transcript.pushInfo([c.muted(t("tui.toolCall", { v: compact ? "compact" : "expanded" }))])
      return
    }
    if (name === "thinking") {
      const next = args === "" ? undefined : args === "on" || args === "1"
      const vis = setReasoningVisible(next)
      transcript.pushInfo([c.muted(t("tui.thinkingSet", { v: vis ? "expanded" : "minimized" }))])
      return
    }
    if (name === "expand") {
      const sections = args ? ctx.expandContent(args) : ctx.expandAllContent()
      const views = args ? [] : collapsedSectionsSnapshot()
      if (!args) clearCollapsedSections()
      if (!sections.length && !views.length) {
        transcript.pushInfo([c.muted(t("tui.expandEmpty"))])
        return
      }
      const lines: string[] = []
      for (const s of sections) {
        if (s.meta.source === "retention") {
          lines.push(c.muted(t("tui.expandRetention")))
          continue
        }
        const label = args ?? s.ref?.toolCallId ?? t("tui.expandContent")
        const src = s.meta.source === "durable" ? ` [${t("tui.expandDurable")}]` : ""
        lines.push(c.muted(`  ── ${label}${src} ──`))
        for (const ln of s.text.split("\n")) lines.push(`    ${ln}`)
      }
      for (const view of views) {
        lines.push(c.muted(`  ── ${view.label} ──`))
        for (const ln of view.text.split("\n")) lines.push(`    ${ln}`)
      }
      transcript.pushInfo(lines)
      return
    }
    if (name === "minimize") {
      const arg = args.trim().toLowerCase()
      let next: boolean | undefined
      if (arg === "") next = !(sectionMinimized("tool") && sectionMinimized("answer"))
      else if (arg === "on" || arg === "1") next = true
      else if (arg === "off" || arg === "0") next = false
      else {
        transcript.pushInfo([c.muted(t("tui.minUse"))])
        return
      }
      setSectionMinimized("tool", next)
      setSectionMinimized("answer", next)
      transcript.pushInfo([c.muted(t(next ? "tui.sectionsMin" : "tui.sectionsExp"))])
      return
    }
    if (name === "undo") {
      const res = await undoLastCheckpoint(sessionId, cwd)
      transcript.pushInfo([res.message, ...res.restoredFiles])
      return
    }
    if (name === "redo") {
      const res = await redoLastCheckpoint(sessionId, cwd)
      transcript.pushInfo([res.message, ...res.reappliedFiles])
      return
    }
    if (name === "copy") {
      const count = parseCopyCount(args)
      if (count === null) {
        transcript.pushInfo([c.muted(t("tui.copyInvalid", { n: args, max: MAX_COPY_TURNS }))])
        return
      }
      await copyLastTurn(count)
      return
    }
    if (name === "cost" || name === "usage") return delegateBuiltin("/status")
    if (name === "models" || name === "model")
      return popupBuiltin(`/model${args ? ` ${args}` : ""}`)
    if (name === "providers" || name === "provider") return popupBuiltin("/provider")
    if (name === "history") {
      const lines = (await loadHistory()).slice(-20)
      transcript.pushInfo(lines.length ? lines : [t("tui.historyEmpty")])
      return
    }
    if (name === "resume" && !args) return popupBuiltin("/sessions")
    if (name === "sessions" && !args) return popupBuiltin("/sessions")

    // Builtin yang bisa membuka popup (/sessions <id> = resume-spawn,
    // /model dengan filter) dibungkus suspend; yang murni cetak langsung.
    const MODAL = new Set(["model", "provider", "sessions", "resume"])
    if (MODAL.has(name)) return popupBuiltin(line)
    const { lines, shouldExit, handled } = await runBuiltin(line)
    if (shouldExit) return { quit: true }
    // handled tanpa cetakan = murni modal (tak ada yang perlu ke transkrip).
    if (handled) {
      if (lines.length) transcript.pushInfo(lines)
      return
    }
    // handleBuiltinCommand tak menangani → skill atau unknown (paritas REPL).
    const skill = allLoadedSkills.find((s) => s.name === name)
    if (!skill) {
      const hint = suggestSimilar(name, [
        ...BUILTIN_COMMANDS.map((b) => b.name),
        ...DRIVER_COMMANDS.map((d) => d.slice(1)),
        ...DRIVER_HELP_COMMANDS.map((b) => b.name),
        "cost",
        "usage",
        "resume",
        ...allLoadedSkills.map((s) => s.name),
      ])
      transcript.pushInfo([
        c.muted(
          t("tui.unknownCmd", {
            name,
            tail: hint ? t("tui.didYou", { hint }) : t("tui.tryHelp"),
          }),
        ),
      ])
      return
    }
    await runTurn(await renderSkill(skill, args))
  }

  const host: TuiHost = {
    bus: session.events as unknown as TuiHost["bus"],
    getStatus: () => {
      const status = {
        footer: {
          mode,
          model: modelRef.current ?? cfg.providers[0]?.models[0] ?? t("tui.noModel"),
          cwd: cwd ?? process.cwd(),
          context: fmtCtx(session.contextTokens),
        },
        busy: abort != null,
      }
      const activities = getPresentationSnapshot().activities

      return {
        ...status,
        pinnedActivity:
          activities.find(
            (activity) => activity.status === "running" && !activity.parentToolCallId,
          ) ?? activities.find((activity) => activity.status === "running"),
      }
    },
    listCommands: (prefix) => suggestions(prefix),
    submit,
    copySelection: (text) => writeClipboardOsc52(text),
    abort: () => {
      abort?.abort()
    },
    cycleMode: (dir) => {
      cycleMode(dir)
    },
    toggleCompact: () => {
      const compact = setCompactMode()
      transcript.pushInfo([c.muted(t("tui.toolCall", { v: compact ? "compact" : "expanded" }))])
    },
    toggleReasoning: () => {
      const vis = setReasoningVisible()
      transcript.pushInfo([c.muted(t("tui.thinkingSet", { v: vis ? "expanded" : "minimized" }))])
    },
  }

  const app = new TuiApp(transcript, host)
  // Approval sebagai warga TUI: blok pertanyaan + keputusan tercatat di
  // transkrip dan terlihat sebelum menjawab (tanpa sink = tulis langsung).
  const { setApprovalSink } = await import("../src/ui/tui/transcript.ts")
  setApprovalSink({
    pushBlock: (lines) => transcript.pushInfo(lines),
    repaint: () => app.repaint(),
    suspend: () => app.suspend(),
    resume: () => app.resume(),
  })
  const res = await app.run()
  setApprovalSink(null)
  if (!res.started) {
    // Terminal tak mampu (non-TTY/dumb/sempit): tak ada tampilan yang bisa
    // dibuka. Satu baris jujur, bukan fallback setengah (REPL dihapus).
    console.log(t("tui.noTty"))
    await close()
    return
  }
  transcript.dispose()
  await close()
}
