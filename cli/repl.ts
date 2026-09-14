// REPL linier — MiniCode sebagai agentic Unix shell.
//
// Loop `askLine` + printer linier (src/ui/assistant/simple.ts, dipasang di
// cli/setup.ts) + spinner turn-status. Output append-only di scrollback:
// tanpa alternate screen, tanpa redraw penuh, tanpa overlay modal. Saat agen
// bekerja terminal "dipakai" sampai selesai atau dibatalkan Ctrl+C — persis
// seperti menjalankan perintah shell.
//
// Semantik interupsi:
// - busy:  stdin tidak raw, jadi Ctrl+C menjadi SIGINT → abort turn.
//          Listener byte \x03 dipasang sebagai cadangan untuk konsol yang
//          tidak mengirim SIGINT (conhost legacy).
// - idle:  askLine menangkap Ctrl+C/Ctrl+D → null → cetak ^C; null dua kali
//          beruntun → keluar. `/exit` tetap cara utama.

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
import { appendHistory, askLine } from "../src/ui/input/input.ts"
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
import { paintWrite } from "../src/ui/runtime/statusline.ts"
import {
  BUILTIN_COMMANDS,
  type CommandContext,
  DRIVER_HELP_COMMANDS,
  handleBuiltinCommand,
} from "./commands.ts"
import type { CliSession } from "./setup.ts"

const MODES = ["auto", "ask", "plan", "allowlist", "allow-all"] as const

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
 * Diekspor untuk test. */
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
 * fire-and-forget). Diekspor untuk test. */
export function persistModelChoice(m: string, modelRef: { current?: string }): void {
  modelRef.current = m
  void saveLastModel(m).catch(() => {})
}

// Perintah REPL yang ditangani driver sendiri DAN ikut di dropdown completion.
// Yang hanya ditampilkan di /help (bukan dropdown) tinggal di commands.ts
// (DRIVER_HELP_COMMANDS) — dropdown tetap pendek. /mode pindah ke sana:
// Tab/Shift+Tab sudah memutar mode tanpa baris baru, jadi /mode tak perlu
// memenuhi dropdown. /thinking = toggle TAMPILAN reasoning (expand/minimize),
// bukan effort — effort diatur lewat picker /model (Enter).
const DRIVER_COMMANDS = ["/compact", "/thinking", "/expand", "/minimize"]

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

export async function runRepl(ctx: CliSession): Promise<void> {
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

  // Kernel tidak mengekspos `config`, jadi handle permission datang dari
  // createMinicodeSession lewat CliSession. Tanpa ini Shift+Tab hanya mengubah
  // label prompt sementara mode sebenarnya tidak berubah.
  let mode: string = permissions?.getMode() ?? permissionMode ?? "auto"
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
    setModelOverride: (m) => {
      persistModelChoice(m, modelRef)
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
  const groupOf = (text: string): string =>
    BUILTIN_COMMANDS.some((b) => `/${b.name}` === text) || DRIVER_COMMANDS.includes(text)
      ? "commands"
      : "skills"

  // Prefiks prompt memuat mode berwarna — Shift+Tab mengubahnya live karena
  // prompt berbentuk fungsi yang diselesaikan tiap render.
  const promptPrefix = (): string => {
    const paintMode = mode === "plan" ? c.warning : mode === "ask" ? c.info : c.success
    return `${c.dim("minicode")} ${paintMode(mode)} › `
  }

  // Notifikasi satu baris saat prompt masih aktif: bersihkan baris berjalan,
  // cetak, lalu askLine menggambar ulang prompt di baris bawahnya.
  const notify = (msg: string) => process.stdout.write(`\r\x1b[2K${msg}\n`)

  const cycleMode = () => {
    const idx = MODES.indexOf(mode as (typeof MODES)[number])
    // allow-all hanya via flag --allow-all, tidak di-cycle tombol
    // — mencegah aktivasi tak sengaja mode paling permisif.
    let next = MODES[(idx + 1) % MODES.length]!
    if (next === "allow-all") next = MODES[(idx + 2) % MODES.length]!
    mode = next
    if (permissions) permissions.setMode(mode as (typeof MODES)[number])
    else mode = permissionMode ?? mode // tak ada handle: jangan tampilkan label palsu
  }

  const onKey = (key: PromptKey, line: string): boolean => {
    // Ganti mode TANPA baris scrollback baru: prefiks prompt memuat mode dan
    // askLine me-render ulang baris berjalan setelah onKey (lihat input.ts).
    // notify() di sini hanya menambah histori "mode: x" tiap tekan tombol.
    // (compact di bawah tetap notify: statusnya tak ada di prefiks.)
    if (key.type === "shift-tab") {
      cycleMode()
      return true
    }
    // Tab di baris kosong = putar mode (sama seperti Shift+Tab): auto →
    // ask → plan → allowlist → auto, allow-all selalu dilewati (lihat
    // cycleMode). "Build" = mode auto (tulis); tak ada mode bernama build.
    if (key.type === "tab" && line === "") {
      cycleMode()
      return true
    }
    if (key.type === "ctrl-o") {
      const compact = setCompactMode()
      notify(c.muted(`tool call: ${compact ? "compact" : "expanded"}`))
      return true
    }
    if (key.type === "ctrl-t") {
      const vis = setReasoningVisible()
      notify(c.muted(`thinking: ${vis ? "expanded" : "minimized"}`))
      return true
    }
    return false
  }

  async function respawnWithResume(id: string): Promise<void> {
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
  }

  // `/sessions` tanpa argumen: builtin mencetak daftar bernomor, lalu satu
  // askLine linier meminta pilihan — pengganti picker modal lama.
  async function pickSession(): Promise<void> {
    await handleBuiltinCommand("/sessions", commandCtx)
    const rows = listSessions(cwd).slice(0, 25)
    if (rows.length === 0) return
    const choice = await askLine({ prompt: "resume (number/id, empty = cancel) › " })
    const pick = choice?.trim()
    if (!pick) return
    const asNum = Number(pick)
    const id =
      Number.isInteger(asNum) && asNum >= 0 && asNum < rows.length
        ? (rows[asNum]?.id ?? pick)
        : pick
    const sess = loadSession(id, cwd)
    if (!sess?.messages.length) {
      console.log(`Session "${id}" not found or empty.`)
      return
    }
    await respawnWithResume(id)
  }

  // Jalankan satu prompt user sebagai turn agen. Budget diperiksa di sini
  // (dipindah dari UI ke driver): prompt baru ditolak setelah batas terlampaui,
  // peringatan 80% dicetak sekali.
  async function runTurn(finalPrompt: string, original: string): Promise<void> {
    const spent = usage.getSession(modelRef.current)
    const preStatus = budgetStatus(budget, spent.cost, budgetStrict ?? false)
    if (preStatus === "over" && spent.cost != null && budget != null) {
      console.log(
        c.red(
          `[budget] ${formatUsd(spent.cost)} > ${formatUsd(budget)} — over budget, new prompts rejected. /exit to quit.`,
        ),
      )
      return
    }
    if (preStatus === "unknown-strict") {
      console.log(
        c.red(
          `[budget] cost unknown (model without pricing) — --budget-strict rejects new prompts. /exit to quit.`,
        ),
      )
      return
    }
    await appendHistory(original)
    let prompt = finalPrompt
    if (finalPrompt.includes("@")) {
      const expanded = await expandMentions(finalPrompt, cwd ?? process.cwd())
      prompt = expanded.prompt
      for (const n of expanded.notes) process.stderr.write(`  [@mention] ${n}\n`)
    }

    const ctrl = new AbortController()
    abort = ctrl
    // Raw mode selama turn: tombol + / - / Ctrl+T dibaca live (section
    // collapse), Ctrl+C tetap abort via byte 0x03. Di luar turn stdin tidak
    // raw — askLine mengelola mode raw sendiri. Bukan TTY (pipe/CI) = tanpa
    // raw, tanpa tombol live (perilaku lama: hanya Ctrl+C via sinyal).
    const ttyStdin = !!process.stdin.isTTY
    if (ttyStdin) {
      try {
        process.stdin.setRawMode(true)
      } catch {}
    }
    const busyFeedback = (msg: string) => {
      try {
        paintWrite(`\r\x1b[2K✦ ${msg}`)
      } catch {}
    }
    const onBusyKey = ttyStdin
      ? (chunk: Buffer) => {
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
      if (ctrl.signal.aborted) console.log(c.yellow("\n(stopped)"))
    } catch (e) {
      if (ctrl.signal.aborted) console.log(c.yellow("\n(stopped)"))
      else {
        // Audit #04 P1: turn gagal SETELAH delegasi committed = efek anak
        // tetap ada sementara riwayat bersih. Model (dan retry berikut)
        // buta terhadapnya tanpa peringatan ini — blind re-delegation =
        // duplikat side effect. Best-effort, tak pernah blokir throw.
        try {
          const { committedDelegatesSince } = await import("../src/session/journal.ts")
          const done = await committedDelegatesSince(sessionId, cwd, turnStart)
          for (const d of done) {
            console.log(
              c.yellow(
                `[recovery] turn failed after sub-agent ${d.childSessionId} completed — its effects stand; verify before re-delegating\n`,
              ),
            )
          }
        } catch {}
        throw e
      }
    } finally {
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
    const session = usage.getSession(modelRef.current)
    if (
      budget != null &&
      session.cost != null &&
      session.cost > budget * 0.8 &&
      session.cost <= budget &&
      !warned80
    ) {
      warned80 = true
      console.log(c.yellow(`[budget] ${formatUsd(session.cost)} / ${formatUsd(budget)} (80% used)`))
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
        return handleBuiltinCommand("/help", commandCtx).then((r) => !!r.shouldExit)
      }
      if (name === "mode") {
        if (args) {
          if (!(MODES as readonly string[]).includes(args)) {
            console.log(c.yellow(`unknown mode: ${args} — choices: ${MODES.join(", ")}`))
            return false
          }
          mode = args
          permissions?.setMode(args as (typeof MODES)[number])
        } else {
          cycleMode()
        }
        console.log(c.muted(`mode: ${mode}`))
        return false
      }
      if (name === "compact") {
        const next = args === "" ? undefined : args === "on" || args === "1"
        const compact = setCompactMode(next)
        console.log(c.muted(`tool call: ${compact ? "compact" : "expanded"}`))
        return false
      }
      if (name === "thinking") {
        const next = args === "" ? undefined : args === "on" || args === "1"
        const vis = setReasoningVisible(next)
        console.log(c.muted(`thinking: ${vis ? "expanded" : "minimized"}`))
        return false
      }
      if (name === "expand") {
        // Buka isi section yang dikecilkan pada turn terakhir (buffer).
        // Stream asal dipertahankan: answer → stdout, sisanya stderr.
        // Ringkasan/kontrol = stdout.
        const sections = getBufferedSections()
        if (sections.length === 0) {
          console.log(
            c.dim(
              "(nothing to expand — all sections were visible; press + during the turn to collapse)",
            ),
          )
          return false
        }
        for (const s of sections) {
          const out = s.stream === "stdout" ? process.stdout : process.stderr
          out.write(`${c.muted(`  ── ${s.label} ──`)}\n`)
          out.write(s.text.endsWith("\n") ? s.text : `${s.text}\n`)
        }
        // Sudah dibuka = selesai; cetak ulang butuh buffer baru dari turn baru.
        resetBufferedSections()
        return false
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
          console.log(c.muted("usage: /minimize [on|off]"))
          return false
        }
        setSectionMinimized("tool", next)
        setSectionMinimized("answer", next)
        console.log(
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
        console.log(res.message)
        if (res.restoredFiles.length) console.log(res.restoredFiles.join("\n"))
        return false
      }
      if (name === "redo") {
        const res = await redoLastCheckpoint(sessionId, cwd)
        console.log(res.message)
        if (res.reappliedFiles.length) console.log(res.reappliedFiles.join("\n"))
        return false
      }
      if (name === "cost" || name === "usage") {
        // Opsi A: /cost tidak punya tampilan sendiri lagi — arahkan ke /status
        // (satu-satunya sumber biaya sesi: input/output/total/cost).
        return handleBuiltinCommand("/status", commandCtx).then((r) => !!r.shouldExit)
      }
      if (name === "resume") {
        // Opsi A: /resume = pintas /sessions (daftar + picker, atau respawn <id>).
        if (!args) {
          await pickSession()
          return false
        }
        return handleBuiltinCommand(`/sessions ${args}`, commandCtx).then((r) => !!r.shouldExit)
      }
      if (name === "clear") {
        // Shell-first: scrollback adalah transcript — jangan hapus, tandai saja.
        console.log(c.dim("--- cleared (scrollback preserved) ---"))
        return false
      }
      if (name === "copy") {
        const txt = getLastTurnText().trim()
        if (!txt) {
          console.log(c.dim("(nothing to copy yet — run a prompt first)"))
          return false
        }
        // OSC 52 diblokir default di banyak terminal; sampaikan jujur.
        if (writeClipboardOsc52(txt))
          console.log(
            c.dim(
              `copied ${txt.length} chars (OSC 52 — allow clipboard access in terminal if empty)`,
            ),
          )
        else console.log(c.dim("(clipboard needs a TTY terminal)"))
        return false
      }
      if (name === "history") {
        const { loadHistory } = await import("../src/ui/input/input.ts")
        console.log((await loadHistory()).slice(-20).join("\n"))
        return false
      }
      if (name === "models")
        return handleBuiltinCommand("/model", commandCtx).then((r) => !!r.shouldExit)
      if (name === "providers")
        return handleBuiltinCommand("/provider", commandCtx).then((r) => !!r.shouldExit)
      if (name === "sessions" && !args) {
        await pickSession()
        return false
      }

      // Builtin mengalir langsung ke scrollback (console.log) — tanpa
      // penangkap output/overlay. Manajer /model & /provider transient:
      // menghapus diri sendiri dan tidak menyentuh scrollback.
      const builtin = await handleBuiltinCommand(q, commandCtx)
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
        console.log(
          c.yellow(`Unknown command: /${name}.${hint ? ` Did you mean /${hint}?` : " Try /help."}`),
        )
        return false
      }
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
      // Kirim byte Ctrl+C ke stdin agar askLine tangani sebagai null (idle) — konsisten dengan raw mode
      try {
        process.stdin.emit("data", Buffer.from([0x03]))
      } catch {}
    }
  }
  process.on("SIGINT", onSigint)
  // Satu baris konteks saat start — tanpa ini user buta: model, mode, dan
  // direktori apa yang sedang dikerjakan. Tetap satu baris (minimalis).
  console.log(
    c.dim(
      `minicode · ${modelRef.current ?? cfg.providers[0]?.models[0] ?? "no model"} · ${mode} · ${cwd ?? process.cwd()}`,
    ),
  )
  console.log(c.dim("/help for commands · Tab complete (empty: mode) · Ctrl+C 2x exit"))

  let shouldExit = false
  // Akumulasi baris yang diakhiri `\` — shell-like continuation di driver
  // (bukan di askLine) agar hanya prompt REPL yang punya, tidak semua pemanggil askLine.
  // Sesuai USAGE.md "akhiri baris dengan \ untuk menyambung".
  let pending = ""
  const contPrompt = () => c.dim("··· › ")
  try {
    for (;;) {
      let line: string | null
      try {
        const usePrompt = pending ? contPrompt : promptPrefix
        // idleMs mati DI SINI saja: prompt utama adalah home state proses —
        // null dihitung Ctrl+C (2x = exit), sehingga auto-batal akan
        // mengeluarkan user yang diam. Dialog transient (approval, add/edit,
        // wizard) tetap pakai default 90 dtk.
        line = await askLine({ prompt: usePrompt, hints: suggestions, groupOf, onKey, idleMs: 0 })
      } catch (e) {
        console.log(`${c.red(glyphs.cross)} ${formatError(e)}`)
        continue
      }
      if (line == null) {
        if (pending) {
          pending = ""
          console.log("^C")
          nullStreak = 0
          continue
        }
        // Ctrl+C/Ctrl+D saat idle: cetak ^C seperti shell; dua kali beruntun = keluar.
        nullStreak++
        console.log("^C")
        if (nullStreak >= 2) shouldExit = true
        if (shouldExit) break
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
        console.log(`${c.red(glyphs.cross)} ${shown ?? formatError(e)}`)
      }
      if (shouldExit) break
    }
  } finally {
    process.off("SIGINT", onSigint)
  }
  await close()
  process.exit(0)
}
