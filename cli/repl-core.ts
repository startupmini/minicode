// Inti REPL bersama (dipakai driver linier `cli/repl.ts` DAN driver TUI
// `cli/repl-tui.ts`). Diekstrak verbatim dari runRepl agar orkestrasi
// (loop, dispatch slash, turn, budget, recovery) TUNGGAL — driver hanya
// memasok primitif UI lewat ReplUi. Perilaku linier byte-identik; TUI
// mengimplementasi primitif yang sama di atas screen/box.
//
// Aturan: modul ini BOLEH impor src/* (logika+UI, seperti repl.ts dulu).
// Tak ada lukisan langsung di sini kecuali lewat hooks — SEMUA teks
// user-visible mengalir via hooks agar driver TUI bisa mengarahkannya ke
// dokumen (I16) dan driver linier ke scrollback (I2/I4).
import { resolve as resolvePath } from "node:path"
import { expandMentions } from "../src/app/mentions.ts"
import { saveLastModel } from "../src/config.ts"
import { budgetStatus } from "../src/policy/usage.ts"
import { redoLastCheckpoint, undoLastCheckpoint } from "../src/session/checkpoint.ts"
import { listSessions, loadSession } from "../src/session/persistence.ts"
import { renderSkill } from "../src/skills/loader.ts"
import {
  formatError,
  getLastTurnText,
  takePendingError,
  writeClipboardOsc52,
} from "../src/ui/assistant/simple.ts"
import { appendHistory } from "../src/ui/input/input.ts"
import type { PromptKey } from "../src/ui/input/prompt-engine.ts"
import {
  type CollapseSection,
  collapse,
  getBufferedSections,
  resetBufferedSections,
  sectionMinimized,
  setSectionMinimized,
} from "../src/ui/render/collapse.ts"
import { setCompactMode } from "../src/ui/render/detail.ts"
import { formatUsd } from "../src/ui/render/money.ts"
import { setReasoningVisible } from "../src/ui/render/reasoning.ts"
import { c, glyphs } from "../src/ui/render/theme.ts"
import {
  BUILTIN_COMMANDS,
  type CommandContext,
  DRIVER_HELP_COMMANDS,
  handleBuiltinCommand,
} from "./commands.ts"
import type { CliSession } from "./setup.ts"

export const MODES = ["auto", "ask", "plan", "allowlist", "allow-all"] as const

// Perintah REPL yang ditangani driver sendiri DAN ikut di dropdown completion.
// Yang hanya ditampilkan di /help (bukan dropdown) tinggal di commands.ts
// (DRIVER_HELP_COMMANDS) — dropdown tetap pendek. /mode pindah ke sana:
// Tab/Shift+Tab sudah memutar mode tanpa baris baru, jadi /mode tak perlu
// memenuhi dropdown. /thinking = toggle TAMPILAN reasoning (expand/minimize),
// bukan effort — effort diatur lewat picker /model (Enter).
export const DRIVER_COMMANDS = ["/compact", "/thinking", "/expand", "/minimize"]

// Jarak edit untuk did-you-mean — cukup untuk typo 1-2 huruf (/modle,
// /sessons), cukup ketat untuk tidak menebak perintah yang memang asing.
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i)
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]!
    dp[0] = j
    for (let i = 1; i <= a.length; i++) {
      const cur = dp[i]!
      dp[i] = Math.min(dp[i]! + 1, dp[i - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return dp[a.length]!
}

/** Saran perintah terdekat untuk typo slash; undefined bila tak ada yang dekat.
 * Diekspor untuk test (via repl.ts re-export). */
export function suggestSimilar(name: string, candidates: string[]): string | undefined {
  let best: string | undefined
  let bestD = 3 // ambang: >2 dianggap perintah asing, bukan typo
  for (const cand of candidates) {
    if (cand === name) return cand
    const d = editDistance(name.toLowerCase(), cand.toLowerCase())
    if (d < bestD) {
      bestD = d
      best = cand
    }
  }
  return best
}

/** Terapkan pilihan model + ingat untuk sesi berikutnya (global,
 * fire-and-forget). Diekspor untuk test (via repl.ts re-export). */
export function persistModelChoice(m: string, modelRef: { current?: string }): void {
  modelRef.current = m
  void saveLastModel(m).catch(() => {})
}

// Pemetaan byte tombol yang ditangkap SELAMA turn (raw mode). Dipisah agar
// bisa di-unit-test murni. `+`/`=` expand section aktif, `-`/`_` minimize,
// Ctrl+T toggle thinking, Ctrl+C abort.
export type BusyKeyAction =
  | { action: "abort" }
  | { action: "toggle-section"; kind: CollapseSection; expand: boolean }
  | { action: "toggle-thinking" }
  | null

export function applyBusyKey(byte: number, active: CollapseSection | null): BusyKeyAction {
  if (byte === 0x03) return { action: "abort" }
  if (byte === 0x2b || byte === 0x3d)
    return { action: "toggle-section", kind: active ?? "tool", expand: true }
  if (byte === 0x2d || byte === 0x5f)
    return { action: "toggle-section", kind: active ?? "tool", expand: false }
  if (byte === 0x14) return { action: "toggle-thinking" }
  return null
}

/** Langkah mode berikutnya (murni): allow-all hanya via flag --allow-all,
 * tidak di-cycle tombol — mencegah aktivasi tak sengaja mode paling permisif. */
export function cycleModeValue(mode: string): string {
  const idx = MODES.indexOf(mode as (typeof MODES)[number])
  let next = MODES[(idx + 1) % MODES.length]!
  if (next === "allow-all") next = MODES[(idx + 2) % MODES.length]!
  return next
}

// Primitif UI yang disediakan driver (linier vs TUI). Semua teks
// user-visible mengalir lewat sini — inti tak pernah menyentuh stdout,
// stdin, atau escape sequence langsung.
export interface ReplUi {
  /** Lukis idle (footer.present / TUI present status+input). */
  presentIdle(): void
  /** Baca satu baris prompt (askLine / pompa box TUI). */
  readPrompt(prompt: string): Promise<string | null>
  printOut(msg: string): void
  printErr(msg: string): void
  /** Notifikasi satu baris (linier: baris scrollback; TUI: baris dokumen). */
  notify(msg: string): void
  /** Umpan balik tombol busy (linier: transient; TUI: baris dokumen). */
  busyFeedback(msg: string): void
  setBusy(busy: boolean): void
  refresh(): void
  /** Jalankan fn sambil menangkap tulisannya ke dokumen (linier: teruskan
   * langsung — perilaku byte-identik; TUI: capture stdout/stderr/console,
   * wrap, append, repaint — TANPA leave alt-screen). Dipakai SEMUA alur
   * cetak builtin (/help, tabel, /expand). */
  suspend<T>(fn: () => Promise<T>): Promise<T>
  /** Baca satu baris teks in-flow (follow-up pickSession): linier askLine,
   * TUI mini-reader (box sementara, tanpa history/dropdown). */
  promptLine(prompt: string): Promise<string | null>
  /** Buka modal popup pilihan (I17): daftar + filter live + pilih.
   * Resolve indeks item asli (bukan posisi tampilan — stabil walau filter
   * berubah) atau null bila batal. Tumpuk aman (modal di atas modal). */
  pickFromList(opts: {
    title: string
    items: string[]
    footer?: string
    emptyText?: string
    initialFilter?: string
    initialSelected?: number
    filterable?: boolean
  }): Promise<number | null>
  /** Lepas chrome/region (respawn path). */
  detachUi(): void
  /** Pompa input driver aktif/nonaktif selama turn (linier: noop — askLine
   * mengelola listener sendiri; TUI: lepas/pasang listener box). */
  setInputActive(on: boolean): void
  /** Suntik batal saat idle (ke box bila pompa hidup; teruskan ke stdin
   * bila dialog yang memegangnya). */
  injectCancel(): void
  /** Bersihkan transkrip (linier: penanda scrollback; TUI: reset dokumen). */
  clearTranscript(): void
  /** Finalisasi visual sebelum close+exit (footer.detach / leave+info). */
  finish(): void
}

// State mode milik loop inti; driver membaca/menulis lewat handle ini
// (status/footer TUI maupun linier selalu konsisten).
export interface ReplShared {
  getMode(): string
  /** Set eksplisit (dipakai `/mode <nama>`); cycle via cycleMode(). */
  setMode(m: string): void
  cycleMode(): void
}

// Ganti mode TANPA baris scrollback baru (dipakai Tab/Shift-Tab baik linier
// maupun TUI): mode baru terlihat di footer/status pada repaint berikutnya.
// compact tetap notify (statusnya tak ada di prefiks).
export function handlePromptKey(
  key: PromptKey,
  ctl: { shared: ReplShared; notify(msg: string): void; refresh(): void },
): boolean {
  if (key.type === "shift-tab") {
    ctl.shared.cycleMode()
    ctl.refresh()
    return true
  }
  // Tab SELALU putar mode (keputusan user: tanpa peduli baris kosong/isi).
  // Completion dropdown tidak lagi pakai Tab — user pilih via ↑/↓ lalu
  // Enter. Tanpa ini Tab saat mengetik tidak bisa ganti mode (keluhan nyata).
  if (key.type === "tab") {
    ctl.shared.cycleMode()
    ctl.refresh()
    return true
  }
  if (key.type === "ctrl-o") {
    const compact = setCompactMode()
    ctl.notify(c.muted(`tool call: ${compact ? "compact" : "expanded"}`))
    return true
  }
  if (key.type === "ctrl-t") {
    const vis = setReasoningVisible()
    ctl.notify(c.muted(`thinking: ${vis ? "expanded" : "minimized"}`))
    return true
  }
  return false
}

/** Angka konteks ringkas untuk status (`14.2k`): dipakai footer linier DAN
 * status TUI — satu sumber, bukan dua duplikat yang bisa drift. */
export function formatContextCount(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1000000) return `${Math.round(n / 1000)}k`
  return `${(n / 1000000).toFixed(1)}m`
}

/** Prompt steril: tanpa status apa pun (mode/model/cwd pindah ke footer/
 * status TUI). Dipakai askLine linier maupun box TUI. */
export function promptPrefix(): string {
  return `${c.dim("minicode")} › `
}

/** Prompt lanjutan `\`-continuation (driver-level, bukan askLine). */
export function contPrompt(): string {
  return c.dim("··· › ")
}

export function buildSuggestions(ctx: CliSession): (line: string) => string[] {
  return (line: string): string[] => {
    if (!line.startsWith("/")) return []
    const all = [
      ...BUILTIN_COMMANDS.map((b) => `/${b.name}`),
      ...DRIVER_COMMANDS,
      ...ctx.allLoadedSkills.map((s) => `/${s.name}`),
    ]
    return all.filter((t) => t.startsWith(line))
  }
}

export function buildGroupOf(): (text: string) => string {
  return (text: string): string =>
    BUILTIN_COMMANDS.some((b) => `/${b.name}` === text) || DRIVER_COMMANDS.includes(text)
      ? "commands"
      : "skills"
}

function buildCommandCtx(ctx: CliSession, setModelOverride: (m: string) => void): CommandContext {
  const {
    cfg,
    cwd,
    sessionId,
    modelRef,
    usage,
    sessionTools,
    allowLocalConfig,
    budget,
    budgetStrict,
  } = ctx
  return {
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
    skills: ctx.allLoadedSkills,
    toolsCount: sessionTools.length,
    providerHint: cfg.providers[0]?.providerHint,
    setModelOverride,
    // Kontrak control-plane (Phase 6): angka konteks dari sumber kebenaran
    // kernel (estimateSessionContext) — bukan usage kumulatif.
    getContextTokens: () => ctx.session.contextTokens,
    budgetState: () => {
      const u = usage.getSession()
      return budgetStatus(budget, u.cost, budgetStrict ?? false, u.totalTokens)
    },
  }
}

export async function runReplLoop(
  ctx: CliSession,
  createUi: (shared: ReplShared) => ReplUi,
): Promise<void> {
  const {
    cwd,
    sessionId,
    modelRef,
    permissionMode,
    permissions,
    allLoadedSkills,
    usage,
    budget,
    budgetStrict,
    persistCurrent,
    runPromptWithVerify,
    close,
  } = ctx

  // Kernel tidak mengekspos `config`, jadi handle permission datang dari
  // createMinicodeSession lewat CliSession. Tanpa ini Shift+Tab hanya mengubah
  // label prompt sementara mode sebenarnya tidak berubah.
  let mode: string = permissions?.getMode() ?? permissionMode ?? "auto"
  // Satu-satunya penulis mode (+ penerus ke permission handle): dipakai
  // set eksplisit (/mode) maupun cycle (Tab). Semantik disalin persis dari
  // kode lama (set var dulu, lalu teruskan / fallback tanpa label palsu).
  const applyMode = (m: string): void => {
    mode = m
    if (permissions) permissions.setMode(m as (typeof MODES)[number])
    else mode = permissionMode ?? m
  }
  const shared: ReplShared = {
    getMode: () => mode,
    setMode: (m: string): void => {
      applyMode(m)
    },
    cycleMode: () => {
      applyMode(cycleModeValue(mode))
    },
  }
  const ui = createUi(shared)

  // REPL default ringkas (minimize): output tool minimize, bisa di-expand via
  // /compact atau Ctrl+O. Env eksplisit selalu menang; one-shot/exec/CI tak
  // tersentuh (tetap expanded). Lihat detail.compact.
  if (process.env.MINICODE_COMPACT === undefined) setCompactMode(true)
  // Section collapse default MINIMIZE untuk tool: bash/edit/content jadi
  // satu baris `  + label`, isi di-buffer. `+`/`-` saat turn atau /expand
  // membuka. Jawaban model SENGAJA default expanded (streaming penuh) —
  // minimize-default membuatnya "bisu" tanpa off-switch; yang mau rapi
  // tinggal /minimize. Env eksplisit selalu menang untuk keduanya.
  if (process.env.MINICODE_MINIMIZE_TOOL === undefined) setSectionMinimized("tool", true)
  let nullStreak = 0
  let warned80 = false
  // Non-null selama turn berjalan — target abort SIGINT/Ctrl+C.
  let abort: AbortController | null = null

  const commandCtx: CommandContext = buildCommandCtx(ctx, (m) => {
    persistModelChoice(m, modelRef)
  })

  async function respawnWithResume(id: string): Promise<void> {
    // Lepas chrome/region sebelum spawn anak stdio-inherit — anak tidak boleh
    // mewarisi terminal yang terkunci milik parent.
    ui.detachUi()
    await close()
    const { spawn } = await import("node:child_process")
    const { waitChildExit } = await import("./auto-update.ts")
    const entry = resolvePath(import.meta.dir, "index.ts")
    const child = spawn(
      process.execPath,
      [entry, `--resume=${id}`, ...(cwd ? [`--cwd=${cwd}`] : [])],
      { stdio: "inherit", env: { ...process.env, MINICODE_RESUME_NEW: "1" } },
    )
    void waitChildExit(child).then((code) => process.exit(code ?? 0))
    process.stdin.resume()
  }

  // `/sessions` tanpa argumen: modal popup bernomor + filter live (I17) —
  // TANPA daftar cetak + prompt mini. Filter substring cocok id/tanggal/cwd,
  // jadi id mentah tetap bisa diketik lalu Enter (paritas parseSessionPick).
  async function pickSession(): Promise<void> {
    const rows = listSessions(cwd).slice(0, 25)
    if (rows.length === 0) {
      ui.printOut(c.dim("(no sessions yet — run a prompt first)"))
      return
    }
    const n = await ui.pickFromList({
      title: "Sessions",
      items: rows.map((r) => {
        const ts = new Date(r.updated_at ?? r.created_at)
          .toISOString()
          .slice(0, 16)
          .replace("T", " ")
        return `${r.id}  ${ts}  ${r.cwd}`
      }),
      footer: "↑↓ pilih · Enter resume · Esc batal · ketik filter",
      emptyText: "(no sessions match)",
    })
    const picked = n == null ? undefined : rows[n]
    if (!picked) return
    const sess = loadSession(picked.id, cwd)
    if (!sess?.messages.length) {
      const { sanitizeAnsiLine } = await import("../src/ui/render/sanitize.ts")
      ui.printOut(`Session "${sanitizeAnsiLine(picked.id)}" not found or empty.`)
      return
    }
    await respawnWithResume(picked.id)
  }

  // `/model` & `/provider` TUI-native: modal popup bernomor + filter live
  // (I17) — TANPA overlay manager. Overlay (runModelManagerView/runPicker)
  // menulis stdout mentah + membaca stdin mentah: di dalam suspend TUI
  // frame-nya ditangkap lalu disuntik ke dokumen sebagai sampah kontrol,
  // dan layar beku selama manager hidup. CRUD provider tetap lewat
  // `minicode config` (diumumkan di daftar).
  async function pickModelNative(filter: string): Promise<boolean> {
    const { loadConfig } = await import("../src/config.ts")
    const { sanitizeAnsiLine } = await import("../src/ui/render/sanitize.ts")
    const { effortOptionsForModel } = await import("../src/providers/effort.ts")
    const { saveModelEffort } = await import("./model-manager.ts")
    const cfg = await loadConfig(cwd, { allowLocal: ctx.allowLocalConfig })
    const q = filter.trim().toLowerCase()
    const rows = cfg.providers
      .flatMap((p) =>
        p.models.map((m) => ({
          id: `${p.id}::${m}`,
          active: `${p.id}::${m}` === commandCtx.currentModel,
        })),
      )
      .filter((r) => !q || r.id.toLowerCase().includes(q))
    if (!rows.length) {
      ui.printOut(c.dim(q ? "(no models match)" : "(no models configured)"))
      return false
    }
    const n = await ui.pickFromList({
      title: "Model",
      items: rows.map((r) => `${r.id}${r.active ? "  active" : ""}`),
      footer: "↑↓ pilih · Enter ✓ · Esc batal · ketik filter",
      emptyText: q ? "(no models match)" : "(no models configured)",
      initialFilter: filter.trim(),
    })
    const row = n == null ? undefined : rows[n]
    if (n == null) return false
    if (!row) {
      ui.printOut(c.yellow("unknown selection — daftar berubah saat memilih, coba lagi"))
      return false
    }
    // Paritas onSelect overlay: reload agar router kenal provider tanpa restart.
    const { reloadProviders } = await import("../src/app/provider-layer.ts")
    await reloadProviders(cwd, { allowLocal: ctx.allowLocalConfig }).catch(() =>
      ui.printOut("[warn] provider reload failed — restart to apply changes"),
    )
    commandCtx.setModelOverride(row.id)
    ui.printOut(c.muted(`model: ${sanitizeAnsiLine(row.id)}`))
    // Paritas picker effort overlay: hanya keluarga thinking; batal = keep.
    // Dibuka SETELAH modal model tutup (berurutan; modal bertumpuk didukung
    // stack driver bila alur masa depan membutuhkannya).
    const mName = row.id.includes("::") ? row.id.slice(row.id.indexOf("::") + 2) : row.id
    const options = effortOptionsForModel(mName)
    if (options.length > 1) {
      const cur =
        cfg.providers
          .flatMap((p) =>
            p.id === row.id.slice(0, row.id.indexOf("::")) ? [p.reasoningEffort ?? "default"] : [],
          )
          .at(0) ?? "default"
      const en = await ui.pickFromList({
        title: "Thinking effort",
        items: options.map((o) => `${o}${o === cur ? " (current)" : ""}`),
        footer: "↑↓ pilih · Enter ✓ · Esc keep",
        emptyText: "(no options)",
        filterable: false,
      })
      const effort = en == null ? undefined : options[en]
      if (effort !== undefined) {
        await saveModelEffort(cwd, row.id, effort).catch((e: unknown) =>
          ui.printOut(`${c.red(glyphs.cross)} ${sanitizeAnsiLine((e as Error).message)}`),
        )
      }
    }
    return false
  }

  async function pickProviderNative(): Promise<boolean> {
    const { loadConfig } = await import("../src/config.ts")
    const { sanitizeAnsiLine } = await import("../src/ui/render/sanitize.ts")
    const cfg = await loadConfig(cwd, { allowLocal: ctx.allowLocalConfig })
    if (!cfg.providers.length) {
      ui.printOut(c.dim("(no providers configured)"))
      return false
    }
    ui.printOut(c.dim("add/edit/delete via minicode config (outside session)"))
    const n = await ui.pickFromList({
      title: "Provider",
      items: cfg.providers.map((p) => {
        const active = commandCtx.currentModel?.startsWith(`${p.id}::`) ? "  active" : ""
        return `${p.id} (${p.models.length} models)  ${p.baseUrl}${active}`
      }),
      footer: "↑↓ pilih · Enter ✓ · Esc batal · ketik filter",
      emptyText: "(no providers configured)",
    })
    const p = n == null ? undefined : cfg.providers[n]
    if (n == null) return false
    if (!p) {
      ui.printOut(c.yellow("unknown selection — daftar berubah saat memilih, coba lagi"))
      return false
    }
    const first = p.models[0]
    if (!first) {
      const { sanitizeAnsiLine } = await import("../src/ui/render/sanitize.ts")
      ui.printOut(c.dim(`(${sanitizeAnsiLine(p.id)} has no models — add via minicode config)`))
      return false
    }
    // Paritas onSelect overlay provider: pakai model pertama provider itu
    // (tanpa reload — sama seperti overlay).
    commandCtx.setModelOverride(`${p.id}::${first}`)
    ui.printOut(c.muted(`model: ${sanitizeAnsiLine(p.id)}::${sanitizeAnsiLine(first)}`))
    return false
  }

  // Salin teks turn terakhir ke clipboard (OSC 52). Dipakai /copy DAN Ctrl+C
  // sekali saat idle. Mengembalikan true bila ada yang disalin.
  function copyLastTurn(): boolean {
    const txt = getLastTurnText().trim()
    if (!txt) {
      ui.printOut(c.dim("(nothing to copy yet — run a prompt first)"))
      return false
    }
    // OSC 52 diblokir default di banyak terminal; sampaikan jujur.
    if (writeClipboardOsc52(txt))
      ui.printOut(
        c.dim(`copied ${txt.length} chars (OSC 52 — allow clipboard access in terminal if empty)`),
      )
    else ui.printOut(c.dim("(clipboard needs a TTY terminal)"))
    return true
  }

  // Jalankan satu prompt user sebagai turn agen. Budget diperiksa di sini
  // (dipindah dari UI ke driver): prompt baru ditolak setelah batas terlampaui,
  // peringatan 80% dicetak sekali.
  async function runTurn(finalPrompt: string, original: string): Promise<void> {
    const spent = usage.getSession(modelRef.current)
    const preStatus = budgetStatus(budget, spent.cost, budgetStrict ?? false, spent.totalTokens)
    if (preStatus === "over" && spent.cost != null && budget != null) {
      ui.printOut(
        c.red(
          `[budget] ${formatUsd(spent.cost)} > ${formatUsd(budget)} — over budget, new prompts rejected. /exit to quit.`,
        ),
      )
      return
    }
    if (preStatus === "unknown-strict") {
      ui.printOut(
        c.red(
          `[budget] cost unknown (model without pricing) with ${spent.totalTokens} tokens spent — over budget, new prompts rejected. /exit to quit.`,
        ),
      )
      return
    }
    await appendHistory(original)
    let prompt = finalPrompt
    if (finalPrompt.includes("@")) {
      const expanded = await expandMentions(finalPrompt, cwd ?? process.cwd())
      prompt = expanded.prompt
      for (const n of expanded.notes) ui.printErr(`  [@mention] ${n}\n`)
    }

    ui.setBusy(true)
    ui.setInputActive(false)
    const ctrl = new AbortController()
    abort = ctrl
    // Raw mode selama turn: tombol + / - / Ctrl+T dibaca live (section
    // collapse), Ctrl+C tetap abort via byte 0x03. Di luar turn stdin tidak
    // raw — prompt mengelolanya sendiri. Bukan TTY (pipe/CI) = tanpa
    // raw, tanpa tombol live (perilaku lama: hanya Ctrl+C via sinyal).
    const ttyStdin = !!process.stdin.isTTY
    if (ttyStdin) {
      try {
        process.stdin.setRawMode(true)
      } catch {}
    }
    const busyFeedback = (msg: string) => {
      ui.busyFeedback(msg)
    }
    // Esc sendirian = abort. 0x1b juga awal SEMUA escape sequence (panah,
    // F-key, mouse), jadi kita tunggu ~50ms: kalau ada byte lanjutan, itu
    // sekuens — bukan Esc; kalau tidak ada, Esc asli → abort.
    let escTimer: ReturnType<typeof setTimeout> | undefined
    const armEsc = (): void => {
      if (escTimer) clearTimeout(escTimer)
      escTimer = setTimeout(() => {
        escTimer = undefined
        ctrl.abort()
      }, 50)
    }
    const onBusyKey = ttyStdin
      ? (chunk: Buffer) => {
          if (chunk.length === 1 && chunk[0] === 0x1b) {
            armEsc()
            return
          }
          if (escTimer) {
            clearTimeout(escTimer)
            escTimer = undefined
          }
          for (const b of chunk) {
            const act = applyBusyKey(b, collapse.activeSection)
            if (!act) continue
            if (act.action === "abort") {
              ctrl.abort()
              continue
            }
            if (act.action === "toggle-thinking") {
              busyFeedback(
                `thinking: ${setSectionMinimized("thinking") ? "minimized" : "expanded"}`,
              )
              continue
            }
            const minimized = setSectionMinimized(act.kind, !act.expand)
            busyFeedback(`${act.kind}: ${minimized ? "minimized" : "expanded"}`)
          }
        }
      : // Pipe/CI: input bisa berisi byte + / - apa pun — jangan sentuh state.
        // Perilaku lama: hanya abort via Ctrl+C (sinyal maupun byte).
        (chunk: Buffer) => {
          if (chunk.includes(0x03)) ctrl.abort()
        }
    process.stdin.resume()
    process.stdin.on("data", onBusyKey)
    const turnStart = Date.now()
    try {
      await runPromptWithVerify(prompt, ctrl.signal)
      if (ctrl.signal.aborted) ui.printOut(c.yellow("\n(stopped)"))
    } catch (e) {
      if (ctrl.signal.aborted) ui.printOut(c.yellow("\n(stopped)"))
      else {
        // Audit #04 P1: turn gagal SETELAH delegasi committed = efek anak
        // tetap ada sementara riwayat bersih. Model (dan retry berikut)
        // buta terhadapnya tanpa peringatan ini — blind re-delegation =
        // duplikat side effect. Best-effort, tak pernah blokir throw.
        try {
          const { committedDelegatesSince } = await import("../src/session/journal.ts")
          const done = await committedDelegatesSince(sessionId, cwd, turnStart)
          for (const d of done) {
            ui.printOut(
              c.yellow(
                `[recovery] turn failed after sub-agent ${d.childSessionId} completed — its effects stand; verify before re-delegating\n`,
              ),
            )
          }
        } catch {}
        throw e
      }
    } finally {
      ui.setBusy(false)
      ui.setInputActive(true)
      if (escTimer) {
        clearTimeout(escTimer)
        escTimer = undefined
      }
      process.stdin.removeListener("data", onBusyKey)
      // Tanpa pause — stdin mengalir seumur proses (lihat cleanup askLine);
      // pause→resume berulang mematikan 'data' selamanya di Bun Windows.
      if (ttyStdin) {
        try {
          process.stdin.setRawMode(false)
        } catch {}
      }
      abort = null
    }

    const u = usage.get(modelRef.current)
    await persistCurrent(u)
    usage.reset()
    const sessionUsage = usage.getSession(modelRef.current)
    if (
      budget != null &&
      sessionUsage.cost != null &&
      sessionUsage.cost > budget * 0.8 &&
      sessionUsage.cost <= budget &&
      !warned80
    ) {
      warned80 = true
      ui.printOut(
        c.yellow(`[budget] ${formatUsd(sessionUsage.cost)} / ${formatUsd(budget)} (80% used)`),
      )
    }
  }

  // true = minta keluar (loop berhenti, lalu close + exit).
  async function dispatchLine(q: string): Promise<boolean> {
    if (q.startsWith("/")) {
      const spaceIdx = q.indexOf(" ")
      const name = (spaceIdx === -1 ? q.slice(1) : q.slice(1, spaceIdx)).toLowerCase()
      const args = spaceIdx === -1 ? "" : q.slice(spaceIdx + 1).trim()

      // Slash sendirian = minta daftar perintah, bukan unknown command.
      if (name === "") {
        return ui
          .suspend(() => handleBuiltinCommand("/help", commandCtx))
          .then((r) => !!r.shouldExit)
      }
      if (name === "mode") {
        if (args) {
          if (!(MODES as readonly string[]).includes(args)) {
            ui.printOut(c.yellow(`unknown mode: ${args} — choices: ${MODES.join(", ")}`))
            return false
          }
          shared.setMode(args)
        } else {
          shared.cycleMode()
        }
        ui.printOut(c.muted(`mode: ${shared.getMode()}`))
        return false
      }
      if (name === "compact") {
        const next = args === "" ? undefined : args === "on" || args === "1"
        const compact = setCompactMode(next)
        ui.printOut(c.muted(`tool call: ${compact ? "compact" : "expanded"}`))
        return false
      }
      if (name === "thinking") {
        const next = args === "" ? undefined : args === "on" || args === "1"
        const vis = setReasoningVisible(next)
        ui.printOut(c.muted(`thinking: ${vis ? "expanded" : "minimized"}`))
        return false
      }
      if (name === "expand") {
        // Buka isi section yang dikecilkan pada turn terakhir (buffer).
        // Stream asal dipertahankan: answer → stdout, sisanya stderr.
        // Ringkasan/kontrol = stdout.
        const sections = getBufferedSections()
        if (sections.length === 0) {
          ui.printOut(
            c.dim(
              "(nothing to expand — all sections were visible; press + during the turn to collapse)",
            ),
          )
          return false
        }
        return ui.suspend(async () => {
          for (const s of sections) {
            const out = s.stream === "stdout" ? process.stdout : process.stderr
            out.write(`${c.muted(`  ── ${s.label} ──`)}\n`)
            out.write(s.text.endsWith("\n") ? s.text : `${s.text}\n`)
          }
          // Sudah dibuka = selesai; cetak ulang butuh buffer baru dari turn baru.
          resetBufferedSections()
          return false
        })
      }
      if (name === "minimize") {
        // Saklar tunggal "rapi ⇄ penuh" seperti /compact dan /thinking:
        // bare = flip (keduanya minimize → expand keduanya; selain itu →
        // minimize keduanya); on|1 / off|0 = set eksplisit keduanya.
        const arg = args.trim().toLowerCase()
        let next: boolean | undefined
        if (arg === "") next = !(sectionMinimized("tool") && sectionMinimized("answer"))
        else if (arg === "on" || arg === "1") next = true
        else if (arg === "off" || arg === "0") next = false
        else {
          ui.printOut(c.muted("usage: /minimize [on|off]"))
          return false
        }
        setSectionMinimized("tool", next)
        setSectionMinimized("answer", next)
        ui.printOut(
          c.muted(
            next
              ? "sections: minimized (press + / - during the turn to expand/collapse)"
              : "sections: expanded",
          ),
        )
        return false
      }
      if (name === "undo") {
        const res = await undoLastCheckpoint(sessionId, cwd)
        ui.printOut(res.message)
        if (res.restoredFiles.length) ui.printOut(res.restoredFiles.join("\n"))
        return false
      }
      if (name === "redo") {
        const res = await redoLastCheckpoint(sessionId, cwd)
        ui.printOut(res.message)
        if (res.reappliedFiles.length) ui.printOut(res.reappliedFiles.join("\n"))
        return false
      }
      if (name === "cost" || name === "usage") {
        // Opsi A: /cost tidak punya tampilan sendiri lagi — arahkan ke /status
        // (satu-satunya sumber biaya sesi: input/output/total/cost).
        return ui
          .suspend(() => handleBuiltinCommand("/status", commandCtx))
          .then((r) => !!r.shouldExit)
      }
      if (name === "resume") {
        // Opsi A: /resume = pintas /sessions (daftar + picker, atau respawn <id>).
        if (!args) {
          await pickSession()
          return false
        }
        return ui
          .suspend(() => handleBuiltinCommand(`/sessions ${args}`, commandCtx))
          .then((r) => !!r.shouldExit)
      }
      if (name === "clear") {
        ui.clearTranscript()
        return false
      }
      if (name === "copy") {
        copyLastTurn()
        return false
      }
      if (name === "history") {
        const { loadHistory } = await import("../src/ui/input/input.ts")
        ui.printOut((await loadHistory()).slice(-20).join("\n"))
        return false
      }
      if (name === "models" || name === "model") return pickModelNative(args)
      if (name === "providers" || name === "provider") return pickProviderNative()
      if (name === "sessions" && !args) {
        await pickSession()
        return false
      }

      // Builtin cetak-di-tempat mengalir langsung (console.log) — tanpa
      // penangkap output/overlay. /model & /provider TIDAK lewat sini: alur
      // TUI-native (pickModelNative/pickProviderNative) di atas, karena
      // overlay manager menulis stdout mentah yang tak boleh masuk capture.
      const builtin = await ui.suspend(() => handleBuiltinCommand(q, commandCtx))
      if (builtin.handled) return !!builtin.shouldExit

      const skill = allLoadedSkills.find((s) => s.name === name)
      if (!skill) {
        const hint = suggestSimilar(name, [
          ...BUILTIN_COMMANDS.map((b) => b.name),
          ...DRIVER_COMMANDS.map((d) => d.slice(1)),
          // Alias yang diarahkan ke perintah lain tetap dikenali sebagai typo
          // (mis. /cst → /cost → /status), walau tak muncul di dropdown.
          ...DRIVER_HELP_COMMANDS.map((b) => b.name),
          "cost",
          "usage",
          "resume",
          ...allLoadedSkills.map((s) => s.name),
        ])
        ui.printOut(
          c.yellow(`Unknown command: /${name}.${hint ? ` Did you mean /${hint}?` : " Try /help."}`),
        )
        return false
      }
      // Turn skill: TANPA suspend. suspend menangkap stdout/stderr — dan
      // selama turn, driver TUI melukis setiap render ke stdout yang sama,
      // sehingga seluruh frame layar tertimbun ke dokumen sebagai sampah
      // kontrol sementara layar beku. Turn biasa tak pernah di-suspend.
      await runTurn(await renderSkill(skill, args), q)
      return false
    }
    await runTurn(q, q)
    return false
  }

  const onSigint = () => {
    if (abort) abort.abort()
    else {
      // Idle: jangan biarkan SIGINT bocor ke PowerShell batch (Terminate batch job)
      // Serahkan ke prompt aktif via adapter (linier: byte Ctrl+C ke stdin).
      try {
        ui.injectCancel()
      } catch {}
    }
  }
  process.on("SIGINT", onSigint)
  // Baris konteks startup (model/mode/dir + hint) dihapus: status kini milik
  // footer yang dicetak fresh tiap idle — startup tetap steril seperti prompt.

  let shouldExit = false
  // Akumulasi baris yang diakhiri `\` — shell-like continuation di driver
  // (bukan di askLine) agar hanya prompt REPL yang punya, tidak semua pemanggil askLine.
  let pending = ""
  try {
    for (;;) {
      let line: string | null
      try {
        const usePrompt = pending ? contPrompt() : promptPrefix()
        // Footer di-print/repaint tepat sebelum prompt idle: sticky → pastikan
        // region + posisikan kursor di baris input; print → baris scrollback.
        ui.presentIdle()
        // idleMs mati DI SINI saja: prompt utama adalah home state proses —
        // null dihitung Ctrl+C (2x = exit), sehingga auto-batal akan
        // mengeluarkan user yang diam. Dialog transient (approval, add/edit,
        // wizard) tetap pakai default 90 dtk.
        line = await ui.readPrompt(usePrompt)
      } catch (e) {
        ui.printOut(`${c.red(glyphs.cross)} ${formatError(e)}`)
        continue
      }
      if (line == null) {
        if (pending) {
          pending = ""
          ui.printOut("^C")
          nullStreak = 0
          continue
        }
        // Ctrl+C sekali saat idle = SALIN teks turn terakhir (keputusan user);
        // dua kali beruntun = keluar. Esc/Ctrl+D juga resolve null — diperlakukan
        // sama: tekan pertama copy, kedua keluar.
        nullStreak++
        if (nullStreak >= 2) {
          shouldExit = true
          break
        }
        copyLastTurn()
        continue
      }
      nullStreak = 0
      // Baris berakhir `\` → sambung, tanpa dispatch.
      if (line.endsWith("\\")) {
        pending += `${line.slice(0, -1)}\n`
        continue
      }
      const full = pending ? `${pending}${line}` : line
      pending = ""
      const q = full.trim()
      if (!q) continue
      try {
        shouldExit = await dispatchLine(q)
      } catch (e) {
        const shown = takePendingError()
        ui.printOut(`${c.red(glyphs.cross)} ${shown ?? formatError(e)}`)
      }
      if (shouldExit) break
    }
  } finally {
    process.off("SIGINT", onSigint)
  }
  // Reset region + cetak footer terakhir SEBELUM process.exit — jalur keluar
  // normal; jalur crash dilindungi handler on("exit") di atas (idempotent).
  ui.finish()
  await close()
  process.exit(0)
}
