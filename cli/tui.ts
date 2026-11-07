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
import { MAX_COPY_TURNS, writeClipboardOsc52 } from "../src/ui/assistant/simple.ts"
import type { UiBus } from "../src/ui/contract.ts"
import { t } from "../src/ui/i18n/locale.ts"
import { loadHistory } from "../src/ui/input/input.ts"
import { formatUsd } from "../src/ui/render/money.ts"
import { c } from "../src/ui/render/theme.ts"
// [Area A · PROMPT 06] State UI milik SESI ini. TUI + printer linier sesi yang
// sama berbagi state (satu instance), sesi lain di proses yang sama tak
// tersentuh. Absen = instance default (fixture tes partial).
import { defaultUiState, type UiSessionState } from "../src/ui/session-state.ts"
import { TuiApp, type TuiHost } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { displayWorkMode, parseWorkModeValue } from "./args.ts"
import {
  BUILTIN_COMMANDS,
  type CommandContext,
  DRIVER_HELP_COMMANDS,
  handleBuiltinCommand,
  persistModelChoice,
  suggestSimilar,
} from "./commands.ts"
import type { CliSession } from "./setup.ts"

// [mode-architecture] Approval axis (PermissionMode) = AUTO/ASK; operating axis
// (WorkMode) = DISCUSS/PLAN/BUILD, dikelola terpisah via /work-mode. Nilai
// internal tetap lowercase (auto/ask) dan EXECUTE (identitas BUILD).
const PERMISSION_MODES = ["auto", "ask"] as const
const WORK_MODE_CYCLE = ["DISCUSS", "PLAN", "EXECUTE"] as const
// /expand [id]: tanpa arg = semua entry store; dengan id = satu tool.
const DRIVER_COMMANDS = [
  "/compact",
  "/thinking",
  "/expand [id]",
  "/minimize",
  "/mode",
  "/work-mode",
]

function fmtCtx(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1000000) return `${Math.round(n / 1000)}k`
  return `${(n / 1000000).toFixed(1)}m`
}

/**
 * F-CTX-1: metrik usage footer (biaya + window %) dari angka NYATA, tanpa
 * perkiraan. Kosong = tak ada data relevan (belum belanja / flag window tak
 * disetel) — footer tak pernah menampilkan persentase/biaya palsu.
 */
function fmtUsageMetrics(ctx: CliSession): string | undefined {
  const cost: number | undefined = ctx.usage.getSession().cost
  const windowTokens: number | undefined = ctx.getContextWindowTokens?.() ?? ctx.contextWindowTokens
  // P1.4: persentase footer = OCCUPANCY konteks saat ini, bukan total token
  // yang sudah dibelanjakan sepanjang sesi. Memakai spend membuat footer
  // mentok 100% setelah beberapa step meski konteks masih jauh di bawah window.
  const used: number = ctx.session.contextTokens
  const parts: string[] = []
  if (cost !== undefined && Number.isFinite(cost) && cost > 0) parts.push(formatUsd(cost))
  if (
    windowTokens !== undefined &&
    Number.isFinite(windowTokens) &&
    windowTokens > 0 &&
    Number.isFinite(used)
  ) {
    const pct = Math.min(100, Math.round((used / windowTokens) * 100))
    parts.push(`${pct}%`)
  }
  return parts.length ? parts.join(" ") : undefined
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
    workModeControl,
    sessionTools,
    allLoadedSkills,
    allowLocalConfig,
    usage,
    budget,
    budgetStrict,
    persistCurrent,
    runPromptWithVerify,
    close,
    productionScheduler,
    schedulerObservability,
  } = ctx
  const { session } = ctx
  // [Area A · PROMPT 06] State UI sesi. `runTui` juga dijalankan fixture tes
  // dengan CliSession parsial — absen berarti pakai instance default.
  const ui: UiSessionState = ctx.uiState ?? defaultUiState
  const getPresentationSnapshot = () =>
    typeof ctx.getPresentationSnapshot === "function"
      ? ctx.getPresentationSnapshot()
      : { activities: [], turns: [] }

  let mode: string = permissions?.getMode() ?? permissionMode ?? "auto"
  if (process.env.MINICODE_COMPACT === undefined) ui.setCompactMode(true)
  if (process.env.MINICODE_MINIMIZE_TOOL === undefined) ui.setSectionMinimized("tool", true)
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
    // [Area A · PROMPT 06] State sesi yang sama dengan printer linier.
    uiState: ui,
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
    // [P1 Hygiene F1b] Mode runtime sesi ini — diteruskan ke proses popup-resume
    // agar owned/constructed tidak turun diam-diam menjadi off.
    runtimeMode: ctx.runtimeMode,
    // [PHASE 6AB] THE operator control surface. `/scheduler` is the single
    // production-reachable path to `fire()` and to `stop()`; 6AA proved nothing
    // else could reach either. Both objects belong to THIS session, so the command
    // cannot address another session's Scheduler (section 12).
    //
    // Omitted entirely when absent, so the command reports "unavailable" - a
    // different and more honest answer than "off".
    ...(productionScheduler && schedulerObservability
      ? {
          scheduler: {
            handle: productionScheduler,
            observability: schedulerObservability,
          },
        }
      : {}),
    get currentModel() {
      return modelRef.current ?? cfg.providers[0]?.models[0]
    },
    set currentModel(v) {
      modelRef.current = v
    },
    usage,
    skills: allLoadedSkills,
    toolsCount: sessionTools.length,
    // P1.2: dua dimensi selalu terbaca live di /status — bukan snapshot boot.
    // [mode-architecture] /status memakai nilai PRODUK (BUILD/AUTO/ASK).
    get workMode() {
      return displayWorkMode(workModeControl?.getWorkMode() ?? "DISCUSS")
    },
    get permissionMode() {
      return (permissions?.getMode() ?? mode).toUpperCase()
    },
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

  // [PHASE 6AB] Live scheduler notices -> transcript as SYSTEM entries.
  //
  // [DESIGN DECISION] `pushInfo` appends with `kind: "system"`, which is a
  // distinct transcript kind from `user`/`assistant`/`activity`/`approval`. That
  // is exactly the separation §8 asks for: a scheduler lifecycle line is NOT a
  // user turn, NOT assistant prose, and NOT tool output. Nothing here synthesises
  // a model message, and no tool result is duplicated — these lines originate in
  // `Scheduler.emit`/`TriggerCoordinator.emit` and are passed through verbatim.
  //
  // [DESIGN DECISION] Attached HERE, after the Transcript exists, rather than in
  // `createCliSession`. See `SchedulerObservability.onSchedulerNotice`: anything
  // emitted before this line still reaches `/scheduler status` through the bounded
  // log, so the delay loses no information.
  //
  // [DESIGN DECISION] Guarded. `runTui` is also driven by test fixtures that build
  // a partial CliSession, and a projection that is absent must degrade to "no live
  // notices" rather than take the whole TUI down on the first scheduler event.
  schedulerObservability?.onSchedulerNotice((line) => transcript.pushInfo([`[scheduler] ${line}`]))

  const suggestions = (line: string): string[] => {
    if (!line.startsWith("/")) return []
    const all = [
      ...BUILTIN_COMMANDS.map((b) => `/${b.name}`),
      ...DRIVER_COMMANDS,
      ...allLoadedSkills.map((s) => `/${s.name}`),
    ]
    return all.filter((t) => t.startsWith(line))
  }

  // Tab: cycle WorkMode (DISCUSS → PLAN → BUILD → DISCUSS). Hanya command ini
  // (beserta /work-mode) yang menggeser operating mode — TIDAK permission mode.
  const cycleWorkMode = (dir: 1 | -1): void => {
    if (!workModeControl) return // policy terinjeksi = tanpa kontrol (fail-closed)
    const current = workModeControl.getWorkMode() ?? "DISCUSS"
    const idx = (WORK_MODE_CYCLE as readonly string[]).indexOf(current)
    if (idx === -1) return
    const next = WORK_MODE_CYCLE[(idx + dir + WORK_MODE_CYCLE.length) % WORK_MODE_CYCLE.length]!
    workModeControl.setWorkMode(next)
  }

  // Shift+Tab: toggle PermissionMode (AUTO ↔ ASK). Tidak ada privilege change
  // diam — hanya sumbu persetujuan.
  const togglePermissionMode = (): void => {
    if (!permissions) return
    const next = permissions.getMode() === "ask" ? "auto" : "ask"
    permissions.setMode(next)
    mode = next
  }

  async function runBuiltin(
    q: string,
    recordOutput = true,
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
      if (recordOutput && lines.length) transcript.pushInfo(lines)
      throw e
    }
    return { lines, shouldExit, handled }
  }

  async function delegateBuiltin(q: string, recordOutput = true): Promise<{ quit?: boolean }> {
    const { lines, shouldExit } = await runBuiltin(q, recordOutput)
    if (recordOutput && lines.length) transcript.pushInfo(lines)
    return shouldExit ? { quit: true } : {}
  }

  /**
   * Builtin yang membuka popup: bekukan App (input dilepas + layar redup),
   * view melukis regionnya sendiri, App repaint saat kembali. Tanpa ini
   * byte masuk ke dua tempat (App + popup) dan frame App menimpa popup.
   * Hasil pemilihan provider/model terlihat di footer dan daftar saat dibuka
   * kembali; transkrip tidak mengarsipkan pilihan UI yang sudah selesai.
   */
  async function popupBuiltin(q: string): Promise<{ quit?: boolean }> {
    app.suspend()
    try {
      return await delegateBuiltin(q, false)
    } catch (e) {
      // Spawn anak gagal (terminal sudah dilepas onBeforeSpawn): hidupkan
      // kembali atau keluar bersih — jangan biarkan TUI mati tanpa layar.
      if (!app.reacquireTerminal()) app.requestQuit()
      throw e
    } finally {
      app.resume()
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
    // P2.2: histori yang tak durable = error transkrip eksplisit (bukan diam).
    if (ctx.isWriterStale()) transcript.pushError(`[writer] ${ctx.writerStaleNote()}`)
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
    // Set menjaga urutan deklarasi sekaligus mencegah duplikasi saat perintah
    // driver terdaftar di completion (DRIVER_COMMANDS) dan help (DRIVER_HELP_COMMANDS).
    const builtin = BUILTIN_COMMANDS.map((b) => `/${b.name}`).join(" ")
    const driver = [
      ...new Set([...DRIVER_COMMANDS, ...DRIVER_HELP_COMMANDS.map((b) => `/${b.name}`)]),
    ].join(" ")
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
    // [Area A · PROMPT 06] Buffer /copy milik SESI ini (bukan singleton modul)
    // — sesi lain di proses yang sama tak ikut tercampur.
    const turns = ui
      .getLastTurnTexts(count)
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
    // [mode-architecture] /mode = PermissionMode (persetujuan AUTO/ASK) SAJA.
    if (name === "mode") {
      if (args) {
        const norm = args.toLowerCase()
        if (!(PERMISSION_MODES as readonly string[]).includes(norm)) {
          transcript.pushInfo([c.muted(t("tui.unknownMode", { a: args, modes: "AUTO, ASK" }))])
          return
        }
        mode = norm
        permissions?.setMode(norm as (typeof PERMISSION_MODES)[number])
      } else {
        togglePermissionMode()
      }
      return
    }
    // [mode-architecture] /work-mode = WorkMode (operating mode) SAJA.
    // Aksi operator EKSPLISIT untuk operating mode; Tab/Shift+Tab = pintasan.
    if (name === "work-mode") {
      const current = workModeControl?.getWorkMode() ?? "DISCUSS"
      const currentDisplay = displayWorkMode(current)
      if (!args) {
        transcript.pushInfo([c.muted(t("tui.workModeUsage", { m: currentDisplay }))])
        return
      }
      const next = parseWorkModeValue(args)
      if (!next) {
        transcript.pushInfo([
          c.muted(t("tui.workModeUnknown", { a: args, modes: "DISCUSS, PLAN, BUILD" })),
        ])
        return
      }
      if (!workModeControl) {
        // Sesi tanpa kontrol WorkMode (handler izin terinjeksi = policy, bukan
        // mode) - tolak, jangan diam-diam tampak berubah.
        transcript.pushInfo([c.muted(t("tui.workModeUnavailable"))])
        return
      }
      workModeControl.setWorkMode(next)
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
      return
    }
    if (name === "compact") {
      const next = args === "" ? undefined : args === "on" || args === "1"
      ui.setCompactMode(next)
      return
    }
    if (name === "thinking") {
      const next = args === "" ? undefined : args === "on" || args === "1"
      ui.setReasoningVisible(next)
      return
    }
    if (name === "expand") {
      const sections = args ? ctx.expandContent(args) : ctx.expandAllContent()
      const views = args ? [] : ui.collapsedSectionsSnapshot()
      if (!args) ui.clearCollapsedSections()
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
      if (arg === "") next = !(ui.sectionMinimized("tool") && ui.sectionMinimized("answer"))
      else if (arg === "on" || arg === "1") next = true
      else if (arg === "off" || arg === "0") next = false
      else {
        transcript.pushInfo([c.muted(t("tui.minUse"))])
        return
      }
      ui.setSectionMinimized("tool", next)
      ui.setSectionMinimized("answer", next)
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
          // P12 S2.2 Slice 5 - WorkMode LIVE (bukan snapshot boot): footer
          // mencerminkan mode aktif saat frame digambar.
          workMode: workModeControl?.getWorkMode() ?? "DISCUSS",
          model: modelRef.current ?? cfg.providers[0]?.models[0] ?? t("tui.noModel"),
          cwd: cwd ?? process.cwd(),
          context: fmtCtx(session.contextTokens),
          metrics: fmtUsageMetrics(ctx),
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
    cycleWorkMode: (dir) => {
      cycleWorkMode(dir)
    },
    togglePermissionMode: () => {
      togglePermissionMode()
    },
    toggleCompact: () => {
      const compact = ui.setCompactMode()
      transcript.pushInfo([c.muted(t("tui.toolCall", { v: compact ? "compact" : "expanded" }))])
    },
    toggleReasoning: () => {
      const vis = ui.setReasoningVisible()
      transcript.pushInfo([c.muted(t("tui.thinkingSet", { v: vis ? "expanded" : "minimized" }))])
    },
  }

  const app = new TuiApp(transcript, host)
  // Approval sebagai warga TUI: blok pertanyaan + keputusan tercatat di
  // transkrip dan terlihat sebelum menjawab (tanpa sink = tulis langsung).
  const { setApprovalSink } = await import("../src/ui/tui/transcript.ts")
  try {
    setApprovalSink({
      pushBlock: (lines) => transcript.pushInfo(lines),
      repaint: () => app.repaint(),
      suspend: () => app.suspend(),
      resume: () => app.resume(),
    })
    const res = await app.run()
    if (!res.started) {
      // Kegagalan startup adalah diagnostik, bukan keluaran program. App
      // sudah menolak membuka layar dan tidak ada fallback linear yang sah.
      process.stderr.write(`${t("tui.noTty")}\n`)
      process.exitCode = 1
      return
    }
  } finally {
    setApprovalSink(null)
    transcript.dispose()
    await close()
  }
}
