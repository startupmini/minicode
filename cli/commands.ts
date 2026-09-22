import { basename, resolve as resolvePath } from "node:path"
import { loadConfig, saveLastModel } from "../src/config.ts"
import type { Usage } from "../src/policy/usage.ts"
import { refreshProviderModels } from "../src/providers/provision.ts"
import { listSessions, loadSession } from "../src/session/persistence.ts"
import type { Skill } from "../src/skills/loader.ts"
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
  { name: "copy", descKey: "help.desc.copy" },
  { name: "history", descKey: "help.desc.history" },
]

/** Pintasan papan tombol TUI — didokumentasikan di /help, bukan hanya di kode. */
const KEYBOARD_HELP: [string, MsgKey][] = [
  ["enter", "help.k.submit"],
  ["tab / shift+tab", "help.k.cycleMode"],
  ["up / down", "help.k.history"],
  ["pgup / pgdn", "help.k.scroll"],
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
    [entryPath, `--resume=${target}`, ...(ctx.cwd ? [`--cwd=${ctx.cwd}`] : [])],
    { stdio: "inherit", env: { ...process.env, MINICODE_RESUME_NEW: "1" } },
  )
  void waitChildExit(child).then((code) => process.exit(code ?? 0))
  process.stdin.pause()
  return true
}

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
