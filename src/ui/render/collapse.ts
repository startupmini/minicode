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

export type CollapseSection = "thinking" | "tool"

let activeSection: CollapseSection | null = null

// Buffer konten yang dikecilkan pada turn terakhir — dibuka via /expand.
export interface BufferedSection {
  label: string
  text: string
}
const MAX_SECTION_CHARS = 200_000
const MAX_BUFFER_TOTAL = 500_000
const bufferedSections: BufferedSection[] = []

export const collapse = {
  /** Section sedang dikecilkan? Thinking = invers reasoning.visible. */
  minimized(section: CollapseSection): boolean {
    return section === "thinking" ? !reasoning.visible : process.env.MINICODE_MINIMIZE_TOOL === "1"
  },
  /** Set eksplisit (nilai minimize) atau toggle bila `next` tidak diberikan.
   * Return nilai minimize terbaru. */
  setMinimized(section: CollapseSection, next?: boolean): boolean {
    if (section === "thinking") {
      const vis = setReasoningVisible(next === undefined ? undefined : !next)
      return !vis
    }
    const cur = process.env.MINICODE_MINIMIZE_TOOL === "1"
    const nxt = next ?? !cur
    process.env.MINICODE_MINIMIZE_TOOL = nxt ? "1" : "0"
    return nxt
  },
  /** Section yang sedang aktif — keputusan tombol + / - saat turn berjalan. */
  get activeSection(): CollapseSection | null {
    return activeSection
  },
  setActiveSection(k: CollapseSection | null) {
    activeSection = k
  },
}

/** Simpan isi section yang dikecilkan (cap per-entry + total). */
export function bufferSection(label: string, text: string): void {
  if (!text) return
  bufferedSections.push({ label, text: text.slice(0, MAX_SECTION_CHARS) })
  let total = 0
  for (let i = bufferedSections.length - 1; i >= 0; i--) {
    total += bufferedSections[i]!.text.length
    if (total > MAX_BUFFER_TOTAL && i > 0) bufferedSections.splice(0, i)
  }
}

export function resetBufferedSections(): void {
  bufferedSections.length = 0
}

/** Konten section yang dikecilkan pada turn terakhir (untuk /expand). */
export function getBufferedSections(): BufferedSection[] {
  return bufferedSections
}
