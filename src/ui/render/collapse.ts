// Satu sumber state "section collapse" untuk output besar saat turn
// (thinking, bash, edit/apply_patch, content tool). Pola detail.ts/reasoning.ts:
// getter dibaca per-event dari env, jadi toggle runtime (tombol + / - saat
// busy, /expand /minimize di prompt) langsung berlaku tanpa re-import.
//
// Semantik tombol: `+` = expand (lihat isi), `-` = minimize (satu baris).
// Minimized = isi TIDAK dicetak, hanya `  + label` — isi di-buffer untuk
// /expand. Thinking memakai reasoning.visible sebagai invers dari minimize
// (expanded = visible), jadi /thinking/Ctrl+T lama tetap satu arti.
import { reasoning, setReasoningVisible } from "./reasoning.ts"
import { splitTrailingEscape } from "./sanitize.ts"

export type CollapseSection = "thinking" | "tool" | "answer"

let activeSection: CollapseSection | null = null

// Buffer konten yang dikecilkan pada turn terakhir — dibuka via /expand.
export interface BufferedSection {
  label: string
  text: string
  /** Stream asal konten (kontrak Unix dipertahankan saat /expand mencetak). */
  stream: "stdout" | "stderr"
}
const MAX_SECTION_CHARS = 200_000
const MAX_BUFFER_TOTAL = 500_000
const bufferedSections: BufferedSection[] = []

export const collapse = {
  /** Section yang sedang aktif — keputusan tombol + / - saat turn berjalan. */
  get activeSection(): CollapseSection | null {
    return activeSection
  },
  setActiveSection(k: CollapseSection | null): void {
    activeSection = k
  },
}

/** Section sedang dikecilkan? Thinking = invers reasoning.visible. */
export function sectionMinimized(section: CollapseSection): boolean {
  if (section === "thinking") return !reasoning.visible
  if (section === "answer") return process.env.MINICODE_MINIMIZE_ANSWER === "1"
  return process.env.MINICODE_MINIMIZE_TOOL === "1"
}

/** Set eksplisit (nilai minimize) atau toggle bila `next` tidak diberikan.
 * Return nilai minimize terbaru. */
export function setSectionMinimized(section: CollapseSection, next?: boolean): boolean {
  if (section === "thinking") {
    const vis = setReasoningVisible(next === undefined ? undefined : !next)
    return !vis
  }
  const key = section === "answer" ? "MINICODE_MINIMIZE_ANSWER" : "MINICODE_MINIMIZE_TOOL"
  const cur = process.env[key] === "1"
  const nxt = next ?? !cur
  process.env[key] = nxt ? "1" : "0"
  return nxt
}

/** Simpan isi section yang dikecilkan (cap per-entry + total). */
export function bufferSection(
  label: string,
  text: string,
  stream: BufferedSection["stream"] = "stderr",
): void {
  if (!text) return
  // Cap jangan belah surrogate pair (U+FFFD di /expand) dan jangan sisakan
  // ekor escape parsial (SGR gantung ikut tercetak saat /expand).
  let cut = text.length > MAX_SECTION_CHARS ? text.slice(0, MAX_SECTION_CHARS) : text
  const last = cut.charCodeAt(cut.length - 1)
  if (cut.length > 0 && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  cut = splitTrailingEscape(cut).head
  bufferedSections.push({ label, text: cut, stream })
  // Buang yang tertua sampai total dalam budget — terbaru selalu dipertahankan.
  let total = 0
  let keepFrom = bufferedSections.length
  for (let i = bufferedSections.length - 1; i >= 0; i--) {
    total += bufferedSections[i]!.text.length
    if (total > MAX_BUFFER_TOTAL) break
    keepFrom = i
  }
  if (keepFrom > 0) bufferedSections.splice(0, keepFrom)
}

export function resetBufferedSections(): void {
  bufferedSections.length = 0
}

/** Konten section yang dikecilkan pada turn terakhir (untuk /expand). */
export function getBufferedSections(): BufferedSection[] {
  return bufferedSections
}
