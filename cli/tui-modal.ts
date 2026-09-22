// Controller daftar modal TUI (I17): state interaksi untuk popup pilihan.
//
// Peran: jembatan state antara driver (`cli/repl-tui.ts`, pemilik stack +
// stdin) dan view murni (`src/ui/tui/modal.ts`, state → baris). Controller
// TAK melukis dan TAK membaca stdin — ia menerima `PromptKey` per keypress
// dan me-return baris konten untuk `TuiModalContent`. Pola sama seperti
// box input (feed → event), agar driver memompa byte sekali untuk semua.
//
// Semantik disalin dari overlay manager lama (filter substring case-
// insensitive, seleksi dijepit — bukan wrap — Enter pilih, Esc batal):
// perilaku yang berubah hanya renderer, bukan interaksi.
import type { PromptKey } from "../src/ui/input/prompt-engine.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import type { TuiModalContent } from "../src/ui/tui/modal.ts"

export interface ModalListOptions {
  title: string
  /** Item mentah (teks polos; disanitasi ulang di view, idempoten). */
  items: string[]
  footer?: string
  emptyText?: string
  /** Filter awal (dari argumen `/model foo`). */
  initialFilter?: string
  /** Seleksi awal (indeks item asli; dipakai buka-ulang). */
  initialSelected?: number
  /** Bila false, ketikan BUKAN filter (untuk daftar pendek seperti effort)
   * — karakter diabaikan kecuali navigasi/konfirmasi. */
  filterable?: boolean
}

export type ModalListEvent = "render" | "pick" | "cancel" | "noop"

export interface ModalList {
  /** Bangun konten view dari state kini (indeks = item ASLI, stabil). */
  spec(): TuiModalContent
  /** Satu keypress → aksi. "pick"/"cancel" = selesai (driver pop + resolve). */
  feed(key: PromptKey): ModalListEvent
  /** Indeks item asli yang terpilih (valid setelah "pick"). */
  picked(): number
}

export function createModalList(opts: ModalListOptions): ModalList {
  const filterable = opts.filterable ?? true
  let filter = opts.initialFilter ?? ""
  // Indeks item ASLI yang terpilih (bukan posisi tampilan — stabil walau
  // filter berubah; dijepit ke hasil saring saat render).
  let selected: number =
    opts.initialSelected != null &&
    opts.initialSelected >= 0 &&
    opts.initialSelected < opts.items.length
      ? opts.initialSelected
      : 0

  const matches = (): number[] => {
    const q = filter.trim().toLowerCase()
    const out: number[] = []
    for (let i = 0; i < opts.items.length; i++) {
      if (!q || opts.items[i]!.toLowerCase().includes(q)) out.push(i)
    }
    return out
  }
  const clampSel = (): void => {
    const m = matches()
    if (!m.length) return
    if (!m.includes(selected)) selected = m[0]!
  }

  return {
    spec(): TuiModalContent {
      clampSel()
      const m = matches()
      const pos = m.indexOf(selected)
      return {
        title: opts.title,
        rows: m.map((i) => opts.items[i]!),
        selected: pos < 0 ? 0 : pos,
        ...(opts.footer ? { footer: opts.footer } : {}),
        ...(opts.emptyText ? { emptyText: opts.emptyText } : {}),
        ...(filterable ? { filter: { value: filter, cursorCol: filter.length } } : {}),
        // Kursor parkir di kotak filter (seperti picker: ketik + panah
        // navigasi, kursor tetap di filter); tanpa filter, di baris terpilih.
        cursor: filterable
          ? { row: m.length, col: displayWidth(filter) }
          : { row: pos < 0 ? 0 : pos, col: 0 },
      }
    },
    feed(key: PromptKey): ModalListEvent {
      // Navigasi dijepit (bukan wrap) — paritas overlay manager lama.
      if (key.type === "up" || key.type === "down") {
        const m = matches()
        if (!m.length) return "noop"
        const at = m.indexOf(selected)
        const d = key.type === "up" ? -1 : 1
        selected =
          at < 0
            ? d < 0
              ? m[m.length - 1]!
              : m[0]!
            : m[Math.max(0, Math.min(m.length - 1, at + d))]!
        return "render"
      }
      switch (key.type) {
        case "enter": {
          // Daftar kosong = tak ada yang bisa dipilih → batal (jujur,
          // bukan diam). Sama seperti overlay lama (tombol tanpa baris).
          if (!matches().length) return "cancel"
          return "pick"
        }
        case "esc":
        case "ctrl-c":
        case "ctrl-d":
          return "cancel"
        case "backspace":
          if (!filterable) return "noop"
          filter = [...filter].slice(0, -1).join("")
          selected = matches()[0] ?? selected
          return "render"
        case "char":
          if (!filterable) return "noop"
          filter += key.ch
          selected = matches()[0] ?? selected
          return "render"
        default:
          return "noop"
      }
    },
    picked(): number {
      return selected
    },
  }
}
