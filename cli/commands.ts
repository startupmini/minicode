import { basename, resolve as resolvePath } from "node:path"
import { loadConfig, saveLastModel } from "../src/config.ts"
import type { Usage } from "../src/policy/usage.ts"
import { refreshProviderModels } from "../src/providers/provision.ts"
import type { RuntimeProductionMode } from "../src/runtime/production-execution.ts"
import { listSessions, loadSession } from "../src/session/persistence.ts"
import type { Skill } from "../src/skills/loader.ts"
import type { ProductionSchedulerHandle } from "../src/task/production-scheduler.ts"
import {
  describeOperatorState,
  type SchedulerObservability,
} from "../src/task/scheduler-observability.ts"
import { type MsgKey, t } from "../src/ui/i18n/locale.ts"
import { formatUsd } from "../src/ui/render/money.ts"
import { glyphs } from "../src/ui/render/theme.ts"
import { padToWidth } from "../src/ui/render/width.ts"

// SEMUA output = PLAIN TEXT tanpa ANSI.
// Readline + ANSI di Windows = karakter escape bocor jadi teks literal.

export interface CommandContext {
  cwd?: string
  sessionId: string
  /** Flag --allow-local-config sesi ini — diteruskan ke manager/refresh agar
   * konsisten dengan provider/tool yang aktif (default deny). */
  allowLocalConfig?: boolean
  currentModel?: string
  usage: {
    /** Pemakaian turn terakhir. */
    get: (model?: string) => Usage
    /** Pemakaian kumulatif seluruh sesi — yang dilaporkan `/status` (/cost = alias). */
    getSession: (model?: string) => Usage
    reset: () => void
    modelUsed: () => { effective?: string; provider?: string }
  }
  skills: Skill[]
  toolsCount: number
  providerHint?: string
  setModelOverride: (model: string) => void
  /** Dipanggil sebelum spawn anak stdio-inherit — composition root (tui.ts)
   * mengisinya (saat ini no-op; DECSTBM tak pernah dipakai lagi). Tanpa
   * injeksi tetap jalan. */
  onBeforeSpawn?: () => void
  /** Kontrak control-plane (Phase 6): angka konteks SAAT INI dari sumber
   * kebenaran kernel (estimateSessionContext) — bukan usage kumulatif.
   * Dibedakan dari Input/Output/Total (provider usage) di /status. */
  getContextTokens: () => number
  /** Status budget sesi (ok | over | unknown-strict) — keputusan terpusat
   * budgetStatus; /status menampilkannya eksplisit, bukan menyimpulkan dari
   * angka. */
  budgetState: () => "ok" | "over" | "unknown-strict"
  /**
   * [PHASE 6AB] The operator control surface for the Scheduler.
   *
   * [DESIGN DECISION] Optional and structurally narrow: it carries exactly two
   * references, both owned by the composition root that built THIS session. A
   * command handler therefore cannot reach another session's Scheduler, cannot
   * reach a process-global one, and — when absent — has no scheduler vocabulary at
   * all. `cli/router.ts`'s one-shot subcommands never set it, so `/scheduler` in a
   * piped invocation reports the truthful OFF rather than pretending.
   */
  scheduler?: SchedulerControl
  /**
   * [P1 M15] Runtime mode sesi ini — diteruskan ke proses resume agar mode
   * tidak turun diam-diam (F1b). Opsional dan narrow seperti `scheduler`:
   * absen = child default `off` (fail-closed, perilaku sebelum F1b).
   */
  runtimeMode?: RuntimeProductionMode
}

/** The two objects `/scheduler` needs, injected by the composition root. */
export interface SchedulerControl {
  readonly handle: ProductionSchedulerHandle
  readonly observability: SchedulerObservability
}

/**
 * Slash commands exposed by the interactive CLI.
 * Keep this list intentionally small: every entry is a command users can
 * discover and use, not an alias for another command.
 */
export interface BuiltinCommand {
  name: string
  args?: string
  /** Kunci kamus i18n untuk deskripsi (bukan literal — /help dwibahasa). */
  descKey: MsgKey
  hidden?: boolean
}

// Jarak edit untuk did-you-mean — cukup untuk typo 1-2 huruf (/modle,
// /sessons), cukup ketat untuk tidak menebak perintah yang memang asing.
// Pindahan dari driver REPL linier (dihapus: TUI satu-satunya tampilan).
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

/** Saran perintah terdekat untuk typo slash; undefined bila tak ada yang dekat. */
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
 * fire-and-forget). */
export function persistModelChoice(m: string, modelRef: { current?: string }): void {
  modelRef.current = m
  void saveLastModel(m).catch(() => {})
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "help", descKey: "help.desc.help" },
  { name: "provider", descKey: "help.desc.provider" },
  { name: "model", descKey: "help.desc.model" },
  { name: "sync", descKey: "help.desc.sync" },
  { name: "status", descKey: "help.desc.status" },
  { name: "sessions", descKey: "help.desc.sessions" },
  { name: "init", descKey: "help.desc.init" },
  { name: "exit", descKey: "help.desc.exit" },
]

/** Perintah yang ditangani DRIVER TUI (bukan handleBuiltinCommand) —
 * ditampilkan di /help agar bisa ditemukan, tapi sengaja TIDAK masuk dropdown
 * completion (di dropdown cukup /compact + builtin; /mode tak perlu
 * karena Tab/Shift+Tab sudah memutar mode tanpa baris baru).
 * /thinking = toggle TAMPILAN reasoning (expand/minimize), bukan effort;
 * effort diatur lewat picker /model (Enter).
 * Opsi A audit UX: undo/redo/clear/copy/history tidak punya duplikat lain. */
export const DRIVER_HELP_COMMANDS: BuiltinCommand[] = [
  { name: "mode", args: "[name]", descKey: "help.desc.mode" },
  { name: "lang", args: "[en|id]", descKey: "help.desc.lang" },
  { name: "undo", descKey: "help.desc.undo" },
  { name: "redo", descKey: "help.desc.redo" },
  { name: "clear", descKey: "help.desc.clear" },
  { name: "copy", args: "[n]", descKey: "help.desc.copy" },
  { name: "history", descKey: "help.desc.history" },
  // [PHASE 6AB] Help-only, not in the dropdown: the scheduler is off in every
  // default session, so advertising it in completion would put a command that
  // always answers "not enabled" one keystroke away. It stays fully discoverable
  // in /help, which is where an operator enabling the flag will look.
  { name: "scheduler", args: "[status|run|stop]", descKey: "help.desc.scheduler" },
]

/** Pintasan papan tombol TUI — didokumentasikan di /help, bukan hanya di kode. */
const KEYBOARD_HELP: [string, MsgKey][] = [
  ["enter", "help.k.submit"],
  ["tab / shift+tab", "help.k.cycleMode"],
  ["up / down", "help.k.history"],
  ["mouse wheel", "help.k.mouse"],
  ["pgup / pgdn", "help.k.scroll"],
  ["home / end (prompt)", "help.k.jumpTop"],
  ["left / right", "help.k.move"],
  ["home / end", "help.k.jump"],
  ["delete", "help.k.delChar"],
  ["ctrl+a / ctrl+e", "help.k.lineEnds"],
  ["ctrl+r", "help.k.histSearch"],
  ["ctrl+j", "help.k.newline"],
  ["ctrl+w", "help.k.delWord"],
  ["ctrl+u", "help.k.clearLine"],
  ["ctrl+o", "help.k.compact"],
  ["ctrl+t", "help.k.thinking"],
  ["esc", "help.k.esc"],
  ["ctrl+c", "help.k.ctrlC"],
  ["ctrl+d", "help.k.ctrlD"],
]

function pad(text: string, width: number): string {
  return padToWidth(text, width)
}

/**
 * Isi readout /status sebagai data (tanpa dekorasi cetak) — dipakai Jendela
 * info transient dan jalur cetak (non-TTY/pin) yang formatnya harus identik.
 */
function statusLines(ctx: CommandContext): string[] {
  // Kumulatif sesi, bukan turn terakhir — judulnya menjanjikan "biaya sesi".
  const u = ctx.usage.getSession(ctx.currentModel)
  // F1.1: turn terakhir tampil terpisah — tanpa ini user tak bisa membedakan
  // "turn ini boros" dari "sesi ini boros". get() = akumulator turn yang
  // di-reset tiap persistCurrent, bukan recompute.
  const last = ctx.usage.get(ctx.currentModel)
  // Kontrak control-plane (Phase 6): DUA angka berbeda, dua konsep —
  // Context = ukuran jendela saat ini (kernel, estimateSessionContext);
  // Total = pemakaian kumulatif provider (usage event). Dulu hanya Total
  // yang tampil (label "konteks" di footer menyesatkan); kini /status
  // membedakan Context vs Usage vs Cost vs Budget eksplisit.
  const pinned = ctx.currentModel?.includes("::")
    ? ctx.currentModel.slice(0, ctx.currentModel.indexOf("::"))
    : undefined
  const provider = ctx.usage.modelUsed().provider ?? pinned ?? ctx.providerHint ?? "-"
  return [
    t("st.session", { id: ctx.sessionId }),
    t("st.model", { v: ctx.currentModel ?? "default" }),
    t("st.provider", { v: provider }),
    t("st.tools", { v: ctx.toolsCount }),
    t("st.context", { v: ctx.getContextTokens().toLocaleString() }),
    t("st.turn", { v: last.totalTokens.toLocaleString() }),
    t("st.input", { v: u.inputTokens.toLocaleString() }),
    t("st.output", { v: u.outputTokens.toLocaleString() }),
    t("st.total", { v: u.totalTokens.toLocaleString() }),
    t("st.cost", { v: u.cost != null ? formatUsd(u.cost) : "N/A" }),
    t("st.budget", {
      v: ctx.budgetState(),
      extra: u.cost == null ? t("st.costUnknown") : "",
    }),
  ]
}

/** Cetak /status seperti dulu (jalur non-TTY + pin jendela). Struktur panggilan
 * dipertahankan (satu console.log per baris): helper test captureOutput
 * mencatat per panggilan, bukan per baris newline. */
function printStatus(ctx: CommandContext): void {
  console.log("")
  for (const line of statusLines(ctx)) console.log(line)
  console.log("")
}

/**
 * Penanda hasil aksi yang seragam.
 *
 * Sebelumnya bercampur: `[OK]`/`[FAIL]` ASCII di /undo dan /model, kalimat biasa
 * di /compact, tanpa penanda di /sync. `glyphs` sudah punya
 * fallback ASCII untuk konsol legacy Windows, jadi memakainya aman di semua
 * terminal.
 */
// FUNGSI, bukan konstanta: `glyphs` adalah getter yang memeriksa dukungan UTF-8
// saat dipakai. Menyimpannya ke `const` di module scope membekukan nilai pada
// saat import — kesalahan yang sama seperti objek warna `c` dan glyph di TUI.
/** Resume ke sesi by id: validasi + spawn anak stdio-inherit. Dipakai jalur
 * argumen langsung (`/sessions <id>`) dan pilihan picker popup.
 * Return true bila anak di-spawn (false = sesi tak ditemukan, tanpa jejak). */
async function resumeById(target: string, ctx: CommandContext): Promise<boolean> {
  const sess = loadSession(target, ctx.cwd)
  if (!sess?.messages.length) {
    console.log(t("sess.notFound", { id: target }))
    return false
  }
  // Anak stdio-inherit memakai terminal yang sama; App TUI sudah suspend
  // (input dilepas) oleh pemanggil popup, dan proses ini exit mengikuti anak.
  try {
    ctx.onBeforeSpawn?.()
  } catch {}
  const { spawn } = await import("node:child_process")
  const { waitChildExit } = await import("./auto-update.ts")
  const entryPath = resolvePath(import.meta.dir, "index.ts")
  const child = spawn(
    process.execPath,
    buildResumeSpawnArgs(entryPath, target, ctx.cwd, ctx.runtimeMode),
    { stdio: "inherit", env: { ...process.env, MINICODE_RESUME_NEW: "1" } },
  )
  void waitChildExit(child).then((code) => process.exit(code ?? 0))
  process.stdin.pause()
  return true
}

/**
 * [P1 Hygiene F1b] Argv untuk proses resume. Murni + diekspor untuk test.
 *
 * Mode runtime diteruskan apa adanya (`off`/`constructed`/`owned`): anak
 * mem-parse argv-nya sendiri dan default `off` bila flag absen, jadi TIDAK
 * meneruskan = diam-diam downgrade. Tidak ada derivasi dari env, tidak ada
 * upgrade diam-diam, dan identitas resume (`--resume=<target>`) tak berubah.
 */
export function buildResumeSpawnArgs(
  entryPath: string,
  target: string,
  cwd: string | undefined,
  runtimeMode: RuntimeProductionMode | undefined,
): string[] {
  return [
    entryPath,
    `--resume=${target}`,
    ...(cwd ? [`--cwd=${cwd}`] : []),
    ...(runtimeMode ? ["--runtime", runtimeMode] : []),
  ]
}

/** Petunjuk ke daftar pintasan lengkap, dipakai di /help. */

/**
 * [PHASE 6AB] `/scheduler [status|run|stop]`.
 *
 * Three subcommands, because §2 asks for the MINIMUM justified surface:
 *
 *  - `run`    - one explicit scheduling cycle. This is the trigger.
 *  - `stop`   - the operator stop §9 asked for, replacing "kill the process".
 *  - `status` (default) - the observability §7 asked for, as a readable surface.
 *
 * [DESIGN DECISION] No `start`. Once stopped, an operator restarts the process. A
 * hot-toggle would need a runtime switch 6U already rejected as unable to stop a
 * live turn, and §11 explicitly says not to introduce one.
 *
 * [DESIGN DECISION] `run` awaits the cycle, so the operator sees the outcome on the
 * same screen. That is a deliberate consequence of choosing the explicit-command
 * surface over a background timer: there is no other moment at which the answer
 * becomes available.
 */
async function handleSchedulerCommand(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().toLowerCase()
  const ctl = ctx.scheduler
  // [DESIGN DECISION] One writer, not twenty-three.
  //
  // OAP-008 (test/writer-inventory.test.ts) caps direct console writers per file and
  // refuses a silent increase. The first draft of this command emitted one line per
  // output, which added 23 writers to `cli/commands.ts` - exactly the pattern the
  // audit exists to prevent, and the audit was right to fail.
  //
  // Collecting into an array and emitting once keeps the whole command at a single
  // writer. The bound still moves, 29 -> 30, and that one step is declared in the
  // inventory with its reason rather than absorbed quietly.
  const out: string[] = []
  const emit = (): void => {
    if (out.length) console.log(out.join("\n"))
  }

  // [DESIGN DECISION] An absent control surface and an inert handle are DIFFERENT
  // failures and get different words. "OFF" is a decision the operator made;
  // "unavailable" means this command has no route at all, and conflating them
  // would hide a wiring regression behind a reassuring message.
  if (!ctl) {
    out.push(t("sched.unavailable"))
    emit()
    return
  }

  const { handle, observability } = ctl

  if (sub === "" || sub === "status") {
    schedulerStatusLines(ctx, ctl, out)
    emit()
    return
  }

  if (sub === "run") {
    if (!handle.enabled) {
      out.push(t("sched.notEnabled"))
      emit()
      return
    }
    if (!handle.isActive()) {
      // Reachable after `/scheduler stop`, after `close()`, or after the renewal
      // heartbeat observed a lost lease. Report it; do NOT silently succeed.
      out.push(t("sched.notActive"))
      schedulerStatusLines(ctx, ctl, out)
      emit()
      return
    }
    out.push(t("sched.running"))
    const result = await handle.fire("explicit-command")
    if (result === null) {
      // The handle returns null only when inactive, which was just checked;
      // reaching here means state changed underneath us. Report, never fake.
      out.push(t("sched.refusedUnknown"))
      schedulerStatusLines(ctx, ctl, out)
      emit()
      return
    }
    switch (result.outcome) {
      case "EVALUATED":
        out.push(
          observability.lastCycleStopReason === "no-candidates"
            ? t("sched.ranNothing")
            : t("sched.ranDone"),
        )
        break
      case "COALESCED":
        out.push(t("sched.coalesced"))
        break
      case "REFUSED_NOT_RUNNING":
        out.push(t("sched.refusedNotRunning"))
        break
      case "REFUSED_ALREADY_PENDING":
        out.push(t("sched.refusedPending"))
        break
    }
    schedulerStatusLines(ctx, ctl, out)
    emit()
    return
  }

  if (sub === "stop") {
    if (!handle.enabled) {
      out.push(t("sched.notEnabled"))
      emit()
      return
    }
    if (!handle.isActive()) {
      // [PHASE 6AB] Section 10 idempotency, in the operator's hands: stopping a
      // stopped scheduler is a no-op that says so, not an error.
      out.push(t("sched.alreadyStopped"))
      emit()
      return
    }
    // [DESIGN DECISION] `scheduler-stopped`, not `emergency-stop`. The latter is
    // reserved for authority loss; an operator deliberately pressing stop is the
    // supported path, and the reason lands in the activity log.
    await handle.stop("scheduler-stopped")
    observability.noteStopped("scheduler-stopped")
    out.push(t("sched.stopped"))
    emit()
    return
  }

  out.push(t("sched.usage"))
  emit()
}

function schedulerStatusLines(ctx: CommandContext, ctl: SchedulerControl, out: string[]): void {
  const { handle, observability } = ctl
  const snap = observability.status(handle)
  out.push(`\n${t("sched.title")}`)
  out.push(`  ${t("sched.state")}: ${describeOperatorState(snap.state)}`)
  out.push(`  ${t("sched.session")}: ${ctx.sessionId}`)
  out.push(`  ${t("sched.authority")}: ${handle.isActive() ? t("sched.held") : t("sched.none")}`)
  out.push(
    `  ${t("sched.counts")}: ${t("sched.cEvaluated")}=${snap.counts.evaluations} ` +
      `${t("sched.cCoalesced")}=${snap.counts.coalesced} ${t("sched.cRefused")}=${snap.counts.refused} ` +
      `${t("sched.cExec")}=${snap.counts.executions} ${t("sched.cFail")}=${snap.counts.failures}`,
  )
  if (snap.lastTaskId) out.push(`  ${t("sched.lastTask")}: ${snap.lastTaskId}`)
  if (snap.lastCycleStop) out.push(`  ${t("sched.lastStop")}: ${snap.lastCycleStop}`)
  if (snap.lastError) out.push(`  ${t("sched.lastError")}: ${snap.lastError}`)
  if (snap.recent.length > 0) {
    out.push(`\n  ${t("sched.recent")}`)
    for (const n of snap.recent.slice(-5)) out.push(`    ${n.line}`)
  }
}

export async function handleBuiltinCommand(
  rawInput: string,
  ctx: CommandContext,
): Promise<{ handled: boolean; shouldExit?: boolean }> {
  const line = rawInput.trim()
  if (!line.startsWith("/")) return { handled: false }

  const spaceIdx = line.indexOf(" ")
  const cmd = spaceIdx === -1 ? line.slice(1).toLowerCase() : line.slice(1, spaceIdx).toLowerCase()
  const args = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim()

  switch (cmd) {
    case "help": {
      // Ringkas: perintah utama + skill + pintasan yang paling sering dipakai.
      // /help penuh tidak muat di layar pendek, jadi
      // pintasan lengkap dipindah ke `/help tombol`.
      const wantKeys = /^(tombol|keys?|keyboard)$/i.test(args)
      if (wantKeys) {
        console.log(`\n${t("help.kHead")}`)
        for (const [key, keyDesc] of KEYBOARD_HELP) {
          console.log(`  ${pad(key, 22)}${t(keyDesc)}`)
        }
        console.log("")
        return { handled: true }
      }
      console.log(`\n${t("help.head")}`)
      for (const b of [...BUILTIN_COMMANDS, ...DRIVER_HELP_COMMANDS]) {
        if (b.hidden) continue
        const withArgs = b.args ? `${b.name} ${b.args}` : b.name
        console.log(`  /${pad(withArgs, 22)}${t(b.descKey)}`)
      }
      // Ringkas: perintah utama + skill + pintasan yang paling sering dipakai.
      // Panjang baris di bawah ≤80 kolom (dijaga test) dan tak boleh menyebut
      // /help tombol (juga dijaga test) — Ctrl+R satu-satunya yang paling
      // sering dicari yang muat setelah Enter/Tab/Shift+Tab.
      console.log(`\n${t("help.keysLine")}\n`)
      return { handled: true }
    }

    case "init": {
      const target = resolvePath(ctx.cwd ?? process.cwd(), "AGENTS.md")
      if (require("node:fs").existsSync(target)) {
        console.log(`\n${t("cmd.initExists")}\n`)
        return { handled: true }
      }
      const { loadRepoMap } = await import("../src/repo/repomap.ts")
      const map = await loadRepoMap(ctx.cwd ?? process.cwd())
      const body = [
        "# AGENTS.md",
        "",
        "Petunjuk untuk agent yang bekerja di repo ini.",
        "",
        "## Struktur (repo-map)",
        "```",
        map ?? "(repo-map kosong)",
        "```",
        "",
        "## Konvensi",
        "- Ikuti gaya kode existing.",
        "- Jalankan typecheck/test sebelum selesai.",
        "",
      ].join("\n")
      const { atomicWriteText } = await import("../src/lib/atomic-write.ts")
      await atomicWriteText(target, body)
      console.log(`\n${t("cmd.initCreated", { t: target })}\n`)
      return { handled: true }
    }

    case "exit":
      console.log(t("cmd.bye"))
      return { handled: true, shouldExit: true }

    case "model": {
      const { runModelManager } = await import("./model-manager.ts")
      // `/model mimo` = buka manager dengan filter awal (tanpa ini query
      // diabaikan diam-diam).
      await runModelManager({
        cwd: ctx.cwd,
        currentModel: ctx.currentModel,
        setModelOverride: ctx.setModelOverride,
        allowLocalConfig: ctx.allowLocalConfig,
        ...(args ? { initialFilter: args } : {}),
      })
      return { handled: true }
    }

    case "provider": {
      const { runProviderManager } = await import("./provider-manager.ts")
      await runProviderManager({
        cwd: ctx.cwd,
        currentModel: ctx.currentModel,
        setModelOverride: ctx.setModelOverride,
        allowLocalConfig: ctx.allowLocalConfig,
      })
      return { handled: true }
    }
    case "status": {
      // Selalu cetak: di TUI ditangkap ke transkrip (permukaan baca), di
      // one-shot/pipe ke scrollback. Jendela info dihapus bersama REPL linier
      // (satu-satunya tampilan interaktif = TUI fullscreen).
      printStatus(ctx)
      return { handled: true }
    }

    case "scheduler": {
      // [PHASE 6AB] THE production-reachable trigger. 6AA's blocker was that
      // `fire()` had no caller: the handle existed, held a lease, and was reachable
      // from nowhere. This case is that caller.
      await handleSchedulerCommand(args, ctx)
      return { handled: true }
    }

    case "sync": {
      // Re-detect model dari semua provider -> config diperbarui otomatis.
      // Meneruskan flag local sesi: tanpa opt-in /sync tak boleh menghubungi
      // endpoint dari repo tak dikenal (audit #07 P0).
      console.log(`\n${t("cmd.syncing")}`)
      const { updated, failed } = await refreshProviderModels({
        cwd: ctx.cwd,
        allowLocal: ctx.allowLocalConfig,
      })
      if (!updated.length && !failed.length) {
        // Bedakan "belum ada provider" dari "ada tapi deteksi kosong" —
        // yang kedua jangan diklaim sebagai yang pertama.
        const cfg = await loadConfig(ctx.cwd, { allowLocal: ctx.allowLocalConfig })
        if (cfg.providers.length === 0) console.log(t("cmd.noProviders"))
        else console.log(t("cmd.noChanges"))
      } else {
        for (const r of updated) {
          console.log(
            `  ${glyphs.check} ${r.id}: ${r.from} → ${r.to}${t("prov.models", { n: "" })}`,
          )
        }
        for (const f of failed) {
          console.log(`  ${glyphs.cross} ${f.id}: ${f.reason}`)
        }
        // "Restart" hanya jujur bila ADA model baru — tanpa updated, restart
        // tak mengubah apa pun (sebelumnya selalu dicetak, menyesatkan saat
        // semua provider gagal).
        if (updated.length > 0) console.log(t("cmd.restart"))
        else console.log(t("cmd.nothingUpdated"))
      }
      return { handled: true }
    }

    case "sessions": {
      const rows = listSessions(ctx.cwd).slice(0, 25)
      if (rows.length === 0) {
        console.log(`\n${t("cmd.noSessions")}`)
      } else if (!args) {
        // Picker popup bila interaktif; tabel cetak bila bukan (kontrak I6 +
        // one-shot). Pilihan picker mengalir ke resumeById yang sama dengan
        // jalur argumen langsung.
        if (process.stdin.isTTY && process.stdout.isTTY) {
          const { runPicker } = await import("../src/ui/screens/picker.ts")
          // ID di DEPAN (truncasi memakan ekor — ekor berisi tanggal/cwd,
          // id adalah info terpenting dan harus selamat).
          const shortDir = (d: string): string => basename(d) || "(cwd)"
          await runPicker({
            title: t("sess.title"),
            items: rows.map((r) => ({
              name: r.id,
              provider: `${new Date(r.created_at).toLocaleString()} · ${r.cwd ? shortDir(r.cwd) : "(cwd)"}`,
              value: r.id,
            })),
            filterable: true,
            placeholder: t("pick.placeholder"),
            onPick: (id) => {
              void resumeById(id, ctx)
            },
            onCancel: () => {},
          })
          return { handled: true }
        }
        console.log(`\n${t("sess.listHead")}`)
        rows.forEach((r, i) => {
          console.log(
            `  [${i}] ${r.id.padEnd(14)} ${new Date(r.created_at).toLocaleString().padEnd(24)} ${r.cwd || "(cwd)"}`,
          )
        })
        console.log(t("sess.listHint"))
      }
      if (rows.length > 0 && args) {
        if (await resumeById(args, ctx)) console.log("")
        return { handled: true }
      }
      console.log("")
      return { handled: true }
    }

    case "resume": {
      // Alias /sessions <id> (repl.md). Gagal-di-kode-lama: jatuh ke default
      // → handled:false → sunyi total di TUI (tidak tercatat, tidak spawn).
      if (!args) return { handled: false }
      const rows = listSessions(ctx.cwd).slice(0, 25)
      if (rows.length > 0) {
        if (await resumeById(args, ctx)) console.log("")
        return { handled: true }
      }
      console.log("")
      return { handled: true }
    }

    default:
      return { handled: false }
  }
}
