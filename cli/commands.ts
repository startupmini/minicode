import { resolve as resolvePath } from "node:path"
import { loadConfig } from "../src/config.ts"
import type { Usage } from "../src/policy/usage.ts"
import { refreshProviderModels } from "../src/providers/provision.ts"
import { listSessions, loadSession } from "../src/session/persistence.ts"
import type { Skill } from "../src/skills/loader.ts"
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
}

/**
 * Slash commands exposed by the interactive CLI.
 * Keep this list intentionally small: every entry is a command users can
 * discover and use, not an alias for another command.
 */
export interface BuiltinCommand {
  name: string
  args?: string
  desc: string
  hidden?: boolean
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "help", desc: "Show commands" },
  { name: "provider", desc: "Manage providers" },
  { name: "model", desc: "Manage and select models" },
  { name: "sync", desc: "Refresh provider models" },
  { name: "status", desc: "Show session status and usage" },
  { name: "sessions", desc: "List, inspect, and resume sessions" },
  { name: "init", desc: "Create AGENTS.md" },
  { name: "exit", desc: "Exit" },
]

/** Perintah yang ditangani DRIVER REPL (bukan handleBuiltinCommand) —
 * ditampilkan di /help agar bisa ditemukan, tapi sengaja TIDAK masuk dropdown
 * completion (di dropdown cukup /compact + builtin; /mode tak perlu
 * karena Tab/Shift+Tab sudah memutar mode tanpa baris baru).
 * /thinking = toggle TAMPILAN reasoning (expand/minimize), bukan effort;
 * effort diatur lewat picker /model (Enter).
 * Opsi A audit UX: undo/redo/clear/copy/history tidak punya duplikat lain. */
export const DRIVER_HELP_COMMANDS: BuiltinCommand[] = [
  { name: "mode", args: "[name]", desc: "Show or set permission mode" },
  { name: "undo", desc: "Revert file changes from the last turn" },
  { name: "redo", desc: "Re-apply reverted changes" },
  { name: "clear", desc: "Mark a boundary (scrollback preserved)" },
  { name: "copy", desc: "Copy last turn to clipboard (OSC 52)" },
  { name: "history", desc: "Show recent prompt history" },
]

/** Pintasan papan tombol — didokumentasikan di /help, bukan hanya di kode. */
const KEYBOARD_HELP: [string, string][] = [
  ["enter", "submit"],
  ["tab", "complete command (empty line: cycle mode)"],
  ["shift+tab", "cycle permission mode"],
  ["up / down", "history or picker navigation"],
  ["left / right", "move cursor"],
  ["home / end", "jump to line start / end"],
  ["delete", "delete character at cursor"],
  ["ctrl+a / ctrl+e", "line start / end"],
  ["ctrl+r", "reverse-i-search prompt history"],
  ["ctrl+j", "insert newline (multiline input)"],
  ["ctrl+w", "delete previous word"],
  ["ctrl+u", "clear line"],
  ["ctrl+o", "toggle compact/expanded tool output"],
  ["+ / -", "during turn: expand / minimize thinking & tool output"],
  ["ctrl+t", "toggle expand/minimize thinking output"],
  ["esc", "close dropdown / picker / cancel empty prompt"],
  ["ctrl+c", "stop turn when busy; cancel prompt when idle (2x exit)"],
  ["ctrl+d", "cancel prompt like ctrl+c"],
  ["\\ at end of line", "continue input on the next line"],
]

function pad(text: string, width: number): string {
  return padToWidth(text, width)
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
/** Petunjuk ke daftar pintasan lengkap, dipakai di /help. */

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
      // /help penuh 29 baris tidak muat di overlay terminal 24 baris, jadi
      // pintasan lengkap dipindah ke `/help tombol`.
      const wantKeys = /^(tombol|keys?|keyboard)$/i.test(args)
      if (wantKeys) {
        console.log("\nKeyboard:")
        for (const [key, desc] of KEYBOARD_HELP) {
          console.log(`  ${pad(key, 22)}${desc}`)
        }
        console.log("")
        return { handled: true }
      }
      console.log("\nCommands:")
      for (const b of [...BUILTIN_COMMANDS, ...DRIVER_HELP_COMMANDS]) {
        if (b.hidden) continue
        const withArgs = b.args ? `${b.name} ${b.args}` : b.name
        console.log(`  /${pad(withArgs, 22)}${b.desc}`)
      }
      // Ringkas: perintah utama + skill + pintasan yang paling sering dipakai.
      // Panjang baris di bawah ≤80 kolom (dijaga test) dan tak boleh menyebut
      // /help tombol (juga dijaga test) — Ctrl+R satu-satunya yang paling
      // sering dicari yang muat setelah Enter/Tab/Shift+Tab.
      console.log("\nEnter · Tab(empty:mode) · Shift+Tab mode · Ctrl+R search · Ctrl+C 2x exit\n")
      return { handled: true }
    }

    case "init": {
      const target = resolvePath(ctx.cwd ?? process.cwd(), "AGENTS.md")
      if (require("node:fs").existsSync(target)) {
        console.log(`\nAGENTS.md already exists - not overwritten.\n`)
        return { handled: true }
      }
      const { loadRepoMap } = await import("../src/repo/repomap.ts")
      const map = await loadRepoMap(ctx.cwd ?? process.cwd())
      const body = [
        "# AGENTS.md",
        "",
        "Instructions for agents working in this repo.",
        "",
        "## Struktur (repo-map)",
        "```",
        map ?? "(repo-map empty)",
        "```",
        "",
        "## Konvensi",
        "- Ikuti gaya kode existing.",
        "- Run typecheck/test before declaring done.",
        "",
      ].join("\n")
      const { atomicWriteText } = await import("../src/lib/atomic-write.ts")
      await atomicWriteText(target, body)
      console.log(`\nAGENTS.md created: ${target}\n`)
      return { handled: true }
    }

    case "exit":
      console.log("Bye.")
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
      // Kumulatif sesi, bukan turn terakhir — judulnya menjanjikan "biaya sesi".
      const u = ctx.usage.getSession(ctx.currentModel)
      // Provider EFEKTIF dulu (hasil routing/fallback), lalu id dari pin
      // `provider::model`, terakhir hint wire. Sebelumnya selalu hint wire
      // ("openai") walau yang dipakai opencode-zen — label bohong.
      const pinned = ctx.currentModel?.includes("::")
        ? ctx.currentModel.slice(0, ctx.currentModel.indexOf("::"))
        : undefined
      const provider = ctx.usage.modelUsed().provider ?? pinned ?? ctx.providerHint ?? "-"
      console.log(`\nSession ${ctx.sessionId}`)
      console.log(`  Model:    ${ctx.currentModel ?? "default"}`)
      console.log(`  Provider: ${provider}`)
      console.log(`  Tools:    ${ctx.toolsCount}`)
      console.log(`  Input:    ${u.inputTokens.toLocaleString()}`)
      console.log(`  Output:   ${u.outputTokens.toLocaleString()}`)
      console.log(`  Total:    ${u.totalTokens.toLocaleString()}`)
      console.log(`  Cost:     ${u.cost != null ? formatUsd(u.cost) : "N/A"}`)
      console.log("")
      return { handled: true }
    }

    case "sync": {
      // Re-detect model dari semua provider -> config diperbarui otomatis.
      // Meneruskan flag local sesi: tanpa opt-in /sync tak boleh menghubungi
      // endpoint dari repo tak dikenal (audit #07 P0).
      console.log("\nSyncing models…")
      const { updated, failed } = await refreshProviderModels({
        cwd: ctx.cwd,
        allowLocal: ctx.allowLocalConfig,
      })
      if (!updated.length && !failed.length) {
        // Bedakan "belum ada provider" dari "ada tapi deteksi kosong" —
        // yang kedua jangan diklaim sebagai yang pertama.
        const cfg = await loadConfig(ctx.cwd, { allowLocal: ctx.allowLocalConfig })
        if (cfg.providers.length === 0) console.log("  No providers configured.")
        else console.log("  No changes — check API key and network, then retry.")
      } else {
        for (const r of updated) {
          console.log(`  ${glyphs.check} ${r.id}: ${r.from} -> ${r.to} models`)
        }
        for (const f of failed) {
          console.log(`  ${glyphs.cross} ${f.id}: ${f.reason}`)
        }
        // "Restart" hanya jujur bila ADA model baru — tanpa updated, restart
        // tak mengubah apa pun (sebelumnya selalu dicetak, menyesatkan saat
        // semua provider gagal).
        if (updated.length > 0) console.log("  Restart to use updated models.")
        else console.log("  Nothing updated — check API keys and network above, then retry /sync.")
      }
      return { handled: true }
    }

    case "sessions": {
      const rows = listSessions(ctx.cwd).slice(0, 25)
      if (rows.length === 0) {
        console.log("\nNo sessions.")
      } else if (!args) {
        console.log("\nSessions")
        rows.forEach((r, i) => {
          console.log(
            `  [${i}] ${r.id.padEnd(14)} ${new Date(r.created_at).toLocaleString().padEnd(24)} ${r.cwd || "(cwd)"}`,
          )
        })
        console.log("  Select a session to resume.")
      }
      if (rows.length > 0 && args) {
        const target = args
        const sess = loadSession(target, ctx.cwd)
        if (!sess?.messages.length) {
          console.log(`Session "${target}" not found or empty.`)
          return { handled: true }
        }
        const { spawn } = await import("node:child_process")
        const { waitChildExit } = await import("./auto-update.ts")
        const entryPath = resolvePath(import.meta.dir, "index.ts")
        const child = spawn(
          process.execPath,
          [entryPath, `--resume=${target}`, ...(ctx.cwd ? [`--cwd=${ctx.cwd}`] : [])],
          { stdio: "inherit", env: { ...process.env, MINICODE_RESUME_NEW: "1" } },
        )
        void waitChildExit(child).then((code) => process.exit(code ?? 0))
        process.stdin.pause()
      }
      console.log("")
      return { handled: true }
    }

    default:
      return { handled: false }
  }
}
