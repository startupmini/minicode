// View persetujuan tool — murni presentasi.
// Lapisan policy tidak mengimpor file ini; ia di-inject sebagai callback dari
// composition root (cli/setup.ts -> createMinicodeSession -> permission).
//
// Warga TUI: bila approval sink terdaftar (cli/tui.ts saat App aktif), blok
// pertanyaan dicatat ke transkrip. Sejak v0.24 prompt dirender sebagai MODAL:
// backdrop redup (App.suspend) + kotak dialog terpusat (dialogBox+paintRegion),
// input raw-mode di-echo ke kotak (bukan askLine inline yang bertabrakan dengan
// painter alt-screen). Tanpa sink (one-shot/exec) = tulis langsung warisan.

import { t } from "../i18n/locale.ts"
import { askLine } from "../input/input.ts"
import { createDecoderState, createKeyStreamPump } from "../input/prompt-engine.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { truncateToWidth } from "../render/width.ts"
import { dialogBox, popupBoxWidth } from "../screens/dialog.ts"
import { createIdleTimer } from "../screens/lifecycle.ts"
import { type ApprovalSink, getApprovalSink } from "../tui/transcript.ts"

/** Subset struktural tool call yang dibutuhkan view — tanpa tipe kernel. */
export interface ApprovalRequest {
  name: string
  args?: unknown
  /** F-APPROVAL-1: tier risiko efek samping (dari policy, sudah dikanonkan). */
  riskTier?: string
  /** F-APPROVAL-1: pratinjau diff ringkas (dari policy, sudah di-scrub secret). */
  diffPreview?: string
  /**
   * P1.2: apakah `always` benar-benar dapat dipersist untuk call ini. Policy
   * menolak menyimpan args > 2 KB (allowlist tidak boleh menjadi blanket-allow);
   * UI wajib menyembunyikan opsi yang no-op.
   */
  canAlways?: boolean
}

// F-APPROVAL-1: label tier risiko yang terlokalisasi — view TIDAK import policy,
// jadi cuma memetakan string tier kanonik → kunci i18n. Tier tak dikenal =
// undefined (tidak menebak label palsu; baris risiko dihilangkan).
function tierLabel(riskTier?: string): string | undefined {
  switch (riskTier) {
    case "PURE_READ":
      return t("appr.tier.pure")
    case "WORKSPACE_MUTATION":
      return t("appr.tier.workspace")
    case "LOCAL_ENV_MUTATION":
      return t("appr.tier.localenv")
    case "EXTERNAL_IRREVERSIBLE":
      return t("appr.tier.external")
    case "UNKNOWN":
      return t("appr.tier.unknown")
    default:
      return undefined
  }
}

// ── Modal input bersama (approval & ask_user) ──────────────────────────────
// Baca SATU baris raw-mode sambil me-render ulang kotak tiap ketikan (echo).
// Enter = submit; Esc/Ctrl+C = batal (null). Idle dua-fase (80s warn / 10s
// batal) mencegah raw-mode digenggam selamanya (segfault Bun Windows).

/** Keputusan approval. */
type Decision = "allow" | "always" | "deny"

/**
 * Baca satu jawaban dari kotak modal. `line` = teks bebas; `choice` = daftar
 * dengan `↑↓`/home/end + Enter (I25) dan ketik-cepat huruf pertama (AUD-005).
 * Satu pembaca untuk dua mode: salinan kedua pasti menyimpang (kelas AUD-003).
 */
function readModalInput<T extends "line" | "choice">(
  mode: T,
  render: (state: { sel: number; typed: string }) => void,
  opt: T extends "choice" ? { count: number; quick: Readonly<Record<string, number>> } : object,
): Promise<T extends "choice" ? number | null : string | null> {
  type R = T extends "choice" ? number | null : string | null
  return new Promise((resolve) => {
    const o = opt as { count?: number; quick?: Record<string, number> }
    const count = o.count ?? 0
    const quick = o.quick ?? {}
    let done = false
    let sel = 0
    let typed = ""
    let onData!: (chunk: Buffer) => void
    const pump = createKeyStreamPump({
      state: createDecoderState(),
      onKeys: (keys) => {
        for (const k of keys) {
          const key = k.key
          if (key.type === "enter") {
            finish((mode === "choice" ? sel : typed) as R)
            return true
          }
          if (key.type === "esc" || key.type === "ctrl-c") {
            finish(null as R)
            return true
          }
          if (mode === "choice") {
            if (key.type === "up") sel = Math.max(0, sel - 1)
            else if (key.type === "down") sel = Math.min(count - 1, sel + 1)
            else if (key.type === "home") sel = 0
            else if (key.type === "end") sel = count - 1
            else if (key.type === "char") {
              // Ketik-cepat: huruf cocok langsung submit.
              const hit = quick[key.ch.toLowerCase()]
              if (hit != null && hit < count) {
                finish(hit as R)
                return true
              }
            }
          } else if (key.type === "char") typed += key.ch
          else if (key.type === "backspace") typed = typed.slice(0, -1)
        }
        idle.reset()
        try {
          render({ sel, typed })
        } catch {}
        return false
      },
    })
    const idle = createIdleTimer({
      warnMs: 80_000,
      cancelMs: 10_000,
      onCancel: () => finish(null as R),
    })
    const finish = (v: R) => {
      if (done) return
      done = true
      try {
        pump.dispose()
      } catch {}
      idle.dispose()
      try {
        process.stdin.removeListener("data", onData)
      } catch {}
      try {
        process.stdin.setRawMode(false)
      } catch {}
      resolve(v)
    }
    onData = (chunk: Buffer) => pump.push(new Uint8Array(chunk))
    try {
      process.stdin.setRawMode(true)
    } catch {}
    process.stdin.on("data", onData)
    try {
      render({ sel: 0, typed: "" })
    } catch {}
  })
}

/** Render kotak modal + baris ekstra (echo / daftar bersorot). */
function paintModal(
  sink: ApprovalSink,
  spec: { title: string; body: string[]; footer?: string },
  extra: readonly string[],
): void {
  if (!sink.paintRegion) return
  const cols = process.stdout.columns || 80
  // Lebar popup SERAGAM (AUD-007): dulu selebar layar, melanggar I20.
  const boxW = popupBoxWidth(cols)
  const box = dialogBox(
    {
      title: spec.title,
      body: [...spec.body, ...extra],
      footer: spec.footer,
      minWidth: boxW,
      maxWidth: boxW,
    },
    Math.max(20, cols),
    Math.max(5, process.stdout.rows || 24),
  )
  sink.paintRegion(box.lines, box.topRow)
}

export async function promptAsk(call: ApprovalRequest): Promise<"allow" | "deny" | "always"> {
  if (!process.stdin.isTTY) return "deny"
  const sink = getApprovalSink()
  // Tanpa sink (one-shot/exec) + stdout pipe: prompt tak terlihat dan blok
  // mencemari stdout program → fail-closed (kontrak I23).
  if (!sink && !process.stdout.isTTY) return "deny"
  // Bell hanya bila stdout TTY: `\x07` di stdout pipe mengotori output program.
  if (process.env.MINICODE_BELL !== "0" && process.stdout.isTTY) process.stdout.write("\x07")
  // Live-region screen reader: teks polos, bukan escape mentah.
  if (process.env.MINICODE_A11Y === "1")
    process.stderr.write(`${t("appr.a11y", { name: sanitizeAnsiLine(call.name) })}\n`)

  // toolName/actionSummary dari model/MCP (tak terpercaya): `\x1b[2J` di args
  // bisa membersihkan layar saat prompt tampil → sanitasi wajib.
  const toolName = sanitizeAnsiLine(call.name)
  const args = (call.args ?? {}) as Record<string, unknown>

  // Sanitasi DULU, potong SESUDAH: `slice` mentah bisa membelah surrogate pair
  // dan memotong sekuens ANSI di tengah (audit 2026-11-12, MEDIUM-1).
  const summarize = (value: unknown, max: number): string =>
    truncateToWidth(sanitizeAnsiLine(String(value)), max, "…")
  let actionSummary = ""
  if (args.command) actionSummary = `${t("appr.cmdLabel")} ${summarize(args.command, 100)}`
  else if (args.path) actionSummary = `${t("appr.fileLabel")} ${summarize(args.path, 100)}`
  else if (args.query) actionSummary = `${t("appr.queryLabel")} ${summarize(args.query, 100)}`
  else {
    let json = ""
    try {
      json = JSON.stringify(args)
    } catch {
      json = String(args)
    }
    actionSummary = `${t("appr.argsLabel")} ${summarize(json, 100)}`
  }
  actionSummary = sanitizeAnsiLine(actionSummary)

  // F-APPROVAL-1: pratinjau diff dari policy (sudah dibasuh secret) lebih jujur
  // dari ringkasan args; jalur tanpa diff tetap memakai ringkasan args.
  const diffPreview = call.diffPreview ? sanitizeAnsiLine(call.diffPreview) : ""
  const riskText = tierLabel(call.riskTier)

  const alwaysAvailable = call.canAlways !== false
  const summary = diffPreview ? `${t("appr.diff")} ${diffPreview}` : actionSummary

  const info = [
    `${c.bold(t("appr.tool"))} ${c.info(toolName)}`,
    ...(riskText ? [`${c.dim(t("appr.risk"))} ${c.info(riskText)}`] : []),
  ]
  const summaryLine = `  ${summary}`
  const modalBody = [...info, summaryLine]
  // Transkrip menyertakan batang judul; modal memakai bar title kotak.
  const block = [``, c.warning(c.bold(t("appr.title"))), ...info.map((l) => `  ${l}`), summaryLine]

  // Daftar opsi = sumber tunggal untuk footer, sorotan, dan ketik-cepat.
  // `keys`: huruf pembeda unik agar sinonim dwibahasa panjang cukup 1 ketukan.
  const choices: { label: string; keys: string[]; value: Decision }[] = [
    { label: t("appr.allowOnce"), keys: ["y", "e"], value: "allow" },
    ...(alwaysAvailable
      ? [{ label: t("appr.always"), keys: ["a", "l"], value: "always" as const }]
      : []),
    { label: t("appr.deny"), keys: ["n", "i"], value: "deny" },
  ]
  const quickMap: Record<string, number> = {}
  for (const [i, ch] of choices.entries()) for (const k of ch.keys) quickMap[k] = i
  // `selalu`→s, `tidak`→t: tak berbagi huruf pertama dengan label.
  quickMap.s = choices.findIndex((ch) => ch.value === "always")
  quickMap.t = choices.findIndex((ch) => ch.value === "deny")

  const choiceHint = t("appr.keyHint")
  let pickedIndex: number | null = null
  if (sink) {
    sink.pushBlock(block)
    sink.repaint()
    sink.suspend()
    try {
      pickedIndex = await readModalInput(
        "choice",
        ({ sel }) => {
          const rendered = choices.map((ch, i) =>
            i === sel ? `  ${c.accent(`${glyphs.check} ${ch.label}`)}` : `    ${c.dim(ch.label)}`,
          )
          paintModal(sink, { title: t("appr.title"), body: modalBody, footer: choiceHint }, [
            "",
            ...rendered,
          ])
        },
        { count: choices.length, quick: quickMap },
      )
    } finally {
      try {
        sink.clearRegion?.()
      } catch {}
      sink.resume()
    }
  } else {
    for (const l of block) process.stdout.write(`${l}\n`)
    const labels = choices.map((ch) => c.bold(ch.label)).join("  ")
    const raw = (await askLine({ prompt: `${labels}: ` })) ?? ""
    // Non-TUI tetap ketik (tak ada panah).
    const hit = quickMap[raw.trim().toLowerCase().slice(0, 1)]
    pickedIndex = hit != null && hit >= 0 ? hit : null
  }

  // Batal/indeks di luar rentang = deny (fail-closed).
  const chosen = pickedIndex != null ? choices[pickedIndex] : undefined
  const decisionKey =
    chosen?.value === "allow"
      ? ("appr.decAllow" as const)
      : chosen?.value === "always"
        ? ("appr.decAlways" as const)
        : ("appr.decDeny" as const)
  const decision = t(decisionKey)
  // Keputusan dicatat di transkrip (jejak audit); warisan mengandalkan
  // scrollback askLine yang terhapus repaint.
  if (sink) {
    sink.pushBlock([c.muted(`  → ${decision}`)])
    sink.repaint()
  }
  return decisionKey === "appr.decAlways"
    ? "always"
    : decisionKey === "appr.decAllow"
      ? "allow"
      : "deny"
}

/** View pertanyaan ask_user — di-inject ke src/tools/ask_user.ts dari cli/setup.ts.
 * Pertanyaan dari model (tak terpercaya) disanitasi sebelum tampil. Return null
 * bila user membatalkan (Esc/Ctrl+C) atau jawaban kosong. */
export async function promptAskText(question: string, options?: string[]): Promise<string | null> {
  if (!process.stdin.isTTY) return null
  const textSink = getApprovalSink()
  // Paritas promptAsk: tanpa sink + stdout pipe = jawab tak terlihat & pipe
  // tercemar → batal fail-closed.
  if (!textSink && !process.stdout.isTTY) return null
  // Potong SESUDAH sanitasi lewat truncateToWidth (bukan `slice`): `slice`
  // bisa menyisakan `\x1b[` menggantung di ekor potongan.
  const q = truncateToWidth(sanitizeAnsiLine(question), 2000, "…")
  const optionLines = options?.length
    ? options.map((o, i) => `  ${c.dim(`${i + 1}.`)} ${sanitizeAnsiLine(o)}`)
    : []
  const block = [``, `${c.warning(c.bold(t("appr.askTitle")))}`, `  ${q}`, ...optionLines]
  const modalBody = [`  ${q}`, ...optionLines]
  const sink = textSink
  let ans: string | null = null
  if (sink) {
    sink.pushBlock(block)
    sink.repaint()
    sink.suspend()
    try {
      ans = await readModalInput(
        "line",
        ({ typed }) =>
          paintModal(sink, { title: t("appr.askTitle"), body: modalBody }, [
            `  ${c.dim(">")} ${c.info(sanitizeAnsiLine(typed))}`,
          ]),
        {},
      )
    } finally {
      try {
        sink.clearRegion?.()
      } catch {}
      sink.resume()
    }
  } else {
    for (const l of block) process.stdout.write(`${l}\n`)
    ans = await askLine({ prompt: `${c.bold(t("appr.answerPrompt"))}` })
  }
  if (ans == null || !ans.trim()) return null
  const out = ans.trim()
  // Opsi bernomor: petakan "1".."n" ke teks (AUD-008); teks bebas diteruskan.
  const pick = options?.length ? /^\s*(\d+)\s*$/.exec(out) : null
  const mapped = pick ? options?.[Number(pick[1]) - 1] : undefined
  const finalAnswer = mapped ?? out
  if (sink) {
    // Gema jawaban juga dipotong lewat truncateToWidth: `slice` bisa membelah
    // surrogate pair (emoji → U+FFFD) atau menyisakan escape menggantung.
    sink.pushBlock([c.muted(`  → ${truncateToWidth(sanitizeAnsiLine(finalAnswer), 200, "…")}`)])
    sink.repaint()
  }
  return finalAnswer
}
