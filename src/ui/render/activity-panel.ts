// Render panel aktivitas (Fase 2): satu baris per KELUARGA tool + state
// thinking. Murni (input → string[]), tanpa IO — pemanggil (transcript TUI /
// simple linear) yang memutuskan kapan & di mana mencetaknya.
//
// Semua teks yang datang dari model/tool (nama tool, target) adalah input
// tak-terpercaya: wajib sanitasi di sini sebelum dirender. Label keluarga
// berasal dari i18n (terpercaya).

import type { UiPresentationActivity } from "../contract.ts"
import { t } from "../i18n/locale.ts"
import { activityGroup } from "./activity-group.ts"
import { sanitizeAnsiLine, stripSgr } from "./sanitize.ts"
import { c } from "./theme.ts"
import { truncateToWidth } from "./width.ts"
/** Satu grup teragregasi (dipakai renderer + /expand buffer). */
export interface ActivityGroupView {
  kind: string
  /** Jumlah tool dalam grup. */
  count: number
  ok: number
  failed: number
  running: number
  denied: number
  /** Nama tool pertama (indikator; sudah tersanitasi & terpotong). */
  names: string[]
  /** Total nama tool unik (sebelum dibatasi 3) untuk penanda `+N`. */
  nameTotal: number
}

const MAX_PANEL_LABEL = 40

/** Agregasi activity → grup. Hanya activity yang statusnya terminal/running
 * masuk; child (parentToolCallId) dihitung ke grup orang tuanya. */
export function groupActivities(
  activities: readonly UiPresentationActivity[],
): Map<string, ActivityGroupView> {
  const groups = new Map<string, ActivityGroupView>()
  // Nama unik per grup (untuk penanda `+N` saat > 3 nama berbeda).
  const uniqueNames = new Map<string, Set<string>>()
  for (const a of activities) {
    const kind = activityGroup(a.name)
    let g = groups.get(kind)
    if (!g) {
      g = { kind, count: 0, ok: 0, failed: 0, running: 0, denied: 0, names: [], nameTotal: 0 }
      groups.set(kind, g)
      uniqueNames.set(kind, new Set())
    }
    g.count++
    const status = a.status
    if (status === "completed") g.ok++
    else if (status === "failed") g.failed++
    else if (status === "running") g.running++
    else if (status === "denied") g.denied++
    // Nama tool dari model/provider = input tak-terpercaya: buang SEMUA ANSI
    // (termasuk SGR) saat masuk — styling ditambahkan renderer sendiri.
    const cleanName = stripSgr(sanitizeAnsiLine(a.name))
    const seen = uniqueNames.get(kind)!
    seen.add(cleanName)
    g.nameTotal = seen.size
    if (g.names.length < 3 && !g.names.includes(cleanName)) g.names.push(cleanName)
  }
  return groups
}

/** Warna grup: gagal → merah, ditolak → kuning, sisanya → redup (tenang). */
function groupPaint(g: ActivityGroupView): (s: string) => string {
  if (g.failed > 0) return c.error
  if (g.denied > 0) return c.warning
  return c.muted
}

/** Satu baris grup (`+ explore · 3 tools · 2 ok · 1 failed`). */
export function groupLine(g: ActivityGroupView): string {
  // Kunci i18n literal (bukan template) — MsgKey adalah union, bukan string.
  const key:
    | "panel.group.explore"
    | "panel.group.edit"
    | "panel.group.execute"
    | "panel.group.feed"
    | "panel.group.other" = `panel.group.${g.kind}` as never
  const label = sanitizeAnsiLine(t(key))
  const parts: string[] = [`+ ${truncateToWidth(label, MAX_PANEL_LABEL, "")}`]
  parts.push(t("panel.tools", { n: g.count }))
  if (g.ok > 0) parts.push(t("panel.ok", { n: g.ok }))
  if (g.failed > 0) parts.push(t("panel.failed", { n: g.failed }))
  if (g.running > 0) parts.push(t("panel.running", { n: g.running }))
  const names = g.names.map((n) => sanitizeAnsiLine(n)).join(", ")
  const more = Math.max(0, g.nameTotal - g.names.length)
  if (names)
    parts.push(`· ${truncateToWidth(names, MAX_PANEL_LABEL, "…")}${more > 0 ? ` +${more}` : ""}`)
  return groupPaint(g)(parts.join(" "))
}

/** Baris panel lengkap (header + satu baris per grup). Kosong bila tak ada
 * activity — pemanggil boleh tak menampilkan apa pun. */
export function renderActivityPanel(
  activities: readonly UiPresentationActivity[],
  opts: { maxRows?: number } = {},
): string[] {
  const max = Math.max(1, opts.maxRows ?? 10)
  const groups = groupActivities(activities)
  const out: string[] = []
  if (groups.size === 0) return out
  for (const g of groups.values()) {
    if (out.length >= max) break
    out.push(groupLine(g))
  }
  return out
}
