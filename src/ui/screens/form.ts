// Form dalam popup — SEMUA input teks/pilihan terjadi DI DALAM kotak.
//
// Latar: popup komposit hanya bisa melukis daftar; tiap input teks memakai
// askLine warisan yang menggambar di kursor terminal (di LUAR kotak).
// Hasilnya jendela yang mengusir user keluar untuk mengetik. Form ini
// menggantikannya: field berlabel + validasi + error inline, satu kotak,
// Tab pindah field, Enter simpan, Esc batal. Secret di-mask `•`.
//
// Pemilik layar (App/popup parent) tetap di luar: form melukis regionnya via
// screen.handle sendiri (openAltScreen nested = paint-through) dan memarkir
// kursor terminal di posisi ketik. Tutup = clearRegion + close.

import { t } from "../i18n/locale.ts"
import {
  createDecoderState,
  createKeyStreamPump,
  type DecodedKey,
  type DecoderState,
  toGraphemes,
} from "../input/prompt-engine.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, stripAnsi } from "../render/theme.ts"
import { displayWidth, truncateToWidth } from "../render/width.ts"
import type { AltScreen } from "../runtime/screen.ts"
import { boxLeftPad, dialogBox } from "./dialog.ts"

export interface FormField {
  id: string
  label: string
  kind: "text" | "secret" | "select" | "confirm"
  /** Nilai awal (text/secret) atau indeks opsi (select). Confirm: boolean. */
  initial?: string | number | boolean
  /** Pilihan untuk select (min 1). Confirm memakai Ya/Tidak bawaan. */
  options?: string[]
  /** Validasi: pesan error Indonesia atau null bila sah. */
  validate?: (value: string) => string | null
}

export interface FormSpec {
  title: string
  fields: FormField[]
  footer?: string
}

export interface FormResult {
  cancelled: boolean
  values?: Record<string, string>
}

/** Validasi umum: wajib isi. */
export function validateRequired(v: string): string | null {
  return v.trim() ? null : t("form.required")
}

/** Validasi umum: URL http(s) yang sah. */
export function validateUrl(v: string): string | null {
  if (!v.trim()) return t("form.required")
  try {
    const u = new URL(v.trim())
    if (!["http:", "https:"].includes(u.protocol)) return t("form.httpOnly")
  } catch {
    return t("form.invalidUrl")
  }
  return null
}

interface FieldState {
  def: FormField
  /** Text/secret: nilai ketik. Select: indeks opsi. Confirm: boolean. */
  text: string
  cursor: number // grapheme
  selectIdx: number
  confirmed: boolean
  error: string | null
  /** Offset scroll horizontal nilai (kursor selalu terlihat). */
  viewStart: number
}

const dim = (s: string): string => c.dim(s)

/** Lebar kotak form TETAP (keputusan rasa: geometri stabil). */
const FORM_BOX_W = 64

function toState(def: FormField): FieldState {
  if (def.kind === "select") {
    const n = Math.max(1, def.options?.length ?? 1)
    const init = typeof def.initial === "number" ? def.initial : 0
    return {
      def,
      text: "",
      cursor: 0,
      selectIdx: Math.min(Math.max(0, init), n - 1),
      confirmed: false,
      error: null,
      viewStart: 0,
    }
  }
  if (def.kind === "confirm") {
    return {
      def,
      text: "",
      cursor: 0,
      selectIdx: 0,
      confirmed: typeof def.initial === "boolean" ? def.initial : false,
      error: null,
      viewStart: 0,
    }
  }
  return {
    def,
    text: typeof def.initial === "string" ? def.initial : "",
    cursor: 0,
    selectIdx: 0,
    confirmed: false,
    error: null,
    viewStart: 0,
  }
}

function fieldValue(st: FieldState): string {
  if (st.def.kind === "select") return st.def.options?.[st.selectIdx] ?? ""
  if (st.def.kind === "confirm") return st.confirmed ? "y" : "n"
  return st.text
}

/**
 * Potong deretan grapheme agar muat dalam `maxV` KOLOM (CJK/emoji = 2).
 * Dipakai jendela nilai field: slice grapheme mentah bisa meluap 2×.
 */
function sliceByWidth(pts: string[], start: number, maxV: number): string[] {
  const out: string[] = []
  let w = 0
  for (let i = start; i < pts.length; i++) {
    const cw = displayWidth(pts[i] ?? "")
    if (w + cw > maxV) break
    out.push(pts[i]!)
    w += cw
  }
  return out
}

export async function runForm(spec: FormSpec, screen: AltScreen): Promise<FormResult> {
  if (!spec.fields.length) return { cancelled: true }
  return new Promise<FormResult>((resolve) => {
    const fields = spec.fields.map(toState)
    let idx = 0
    let done = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
    }
    const resetIdle = () => {
      if (done) return
      clearIdle()
      idleTimer = setTimeout(() => finish(true), 90_000)
      try {
        ;(idleTimer as unknown as { unref?: () => void }).unref?.()
      } catch {}
    }

    // Lebar konten = lebar kotak TETAP (64) dikurangi chrome (border+padding
    // = 4) — sepakat dengan dialogBox min=max 64 (tanpa potong-ganda).
    const width = () => Math.max(20, Math.min((screen.cols || 80) - 6, FORM_BOX_W))
    const innerW = () => Math.max(8, width() - 4)

    // Baris nilai field aktif (indeks dalam body) untuk parkir kursor.
    const render = (): { activeRow: number; activeCol: number } => {
      const w = innerW()
      const cut = (s: string) => truncateToWidth(s, w)
      const body: string[] = []
      let activeRow = -1
      let activeCol = -1
      fields.forEach((st, fi) => {
        const active = fi === idx
        if (st.def.kind === "text" || st.def.kind === "secret") {
          const shown = st.def.kind === "secret" ? "•".repeat(toGraphemes(st.text).length) : st.text
          // Scroll horizontal dalam KOLOM (bukan grapheme): CJK/emoji 2 kolom,
          // jadi hitung lebar tampil, bukan jumlah unit. Gagal-di-kode-lama:
          // kursor meleset 1 per glyph lebar + scroll prematur/terlambat.
          const maxV = Math.max(8, w - displayWidth(sanitizeAnsiLine(st.def.label)) - 4)
          const pts = toGraphemes(shown)
          let start = Math.max(0, Math.min(st.viewStart, st.cursor))
          if (st.cursor < start) start = st.cursor
          while (start < st.cursor && displayWidth(pts.slice(start, st.cursor).join("")) > maxV - 1)
            start++
          st.viewStart = start
          const vis = sliceByWidth(pts, start, maxV).join("")
          const prefix = `${active ? c.accent("›") : " "} ${sanitizeAnsiLine(st.def.label)}: `
          // Kolom kursor terminal = lebar tampil prefix + lebar tampil nilai
          // sebelum kursor (BUKAN jumlah grapheme).
          if (active) {
            activeCol =
              displayWidth(stripAnsi(prefix)) +
              displayWidth(pts.slice(start, st.cursor).join("")) +
              1
          }
          body.push(cut(`${prefix}${vis}`))
          activeRow = active ? body.length - 1 : activeRow
        } else if (st.def.kind === "select") {
          const opts = st.def.options ?? []
          const cur = sanitizeAnsiLine(opts[st.selectIdx] ?? "")
          const marker = active ? c.accent("›") : " "
          if (active) activeCol = -1 // select tanpa kursor ketik
          body.push(
            cut(`${marker} ${sanitizeAnsiLine(st.def.label)}: ${dim("‹")} ${cur} ${dim("›")}`),
          )
          activeRow = active ? body.length - 1 : activeRow
        } else {
          // Confirm: Ya/Tidak toggle.
          const marker = active ? c.accent("›") : " "
          const val = st.confirmed ? c.accent(t("form.yes")) : t("form.no")
          if (active) activeCol = -1
          body.push(cut(`${marker} ${sanitizeAnsiLine(st.def.label)}: ${val}`))
          activeRow = active ? body.length - 1 : activeRow
        }
        if (st.error) body.push(cut(c.error(`  ${sanitizeAnsiLine(st.error)}`)))
      })
      const box = dialogBox(
        {
          title: spec.title,
          body,
          footer: spec.footer ?? t("form.footerDefault"),
          // Lebar TETAP (paritas picker/manager — geometri stabil, tak
          // bernapas saat error muncul/hilang).
          minWidth: FORM_BOX_W,
          maxWidth: FORM_BOX_W,
        },
        screen.cols,
        screen.rows,
      )
      screen.paintRegion(box.lines, box.topRow)
      // Parkir kursor terminal di posisi ketik field aktif (select/confirm:
      // sembunyikan di ujung baris). Kolom absolut = padding kiri + border +
      // spasi + offset konten + 1; clamp ke layar. Menghitung ulang center
      // dari lebar baris (yang sudah termasuk padding) terbukti off-by-N.
      try {
        if (activeRow >= 0) {
          const li = Math.min(box.lines.length - 1, box.bodyTop + activeRow)
          const row = box.topRow + li
          const stripped = stripAnsi(box.lines[li] ?? "")
          const leftPad = boxLeftPad(stripped)
          const contentW = displayWidth(stripped) - leftPad
          const raw = activeCol >= 0 ? leftPad + activeCol + 2 : leftPad + contentW + 1
          const col = Math.max(1, Math.min(screen.cols || 80, raw))
          process.stdout.write(`\x1b[${row};${col}H\x1b[?25h`)
        }
      } catch {}
      return { activeRow, activeCol }
    }

    const finish = (cancelled: boolean) => {
      if (done) return
      done = true
      clearIdle()
      try {
        formPump.dispose()
      } catch {}
      try {
        screen.clearRegion()
      } catch {}
      try {
        process.stdin.setRawMode(false)
      } catch {}
      if (onData) process.stdin.removeListener("data", onData)
      if (onResize) process.stdout.removeListener("resize", onResize)
      if (cancelled) resolve({ cancelled: true })
      else {
        const values: Record<string, string> = {}
        for (const st of fields) values[st.def.id] = fieldValue(st)
        resolve({ cancelled: false, values })
      }
    }

    const validateAll = (): boolean => {
      let firstBad = -1
      fields.forEach((st, fi) => {
        st.error = null
        if (st.def.kind === "text" || st.def.kind === "secret") {
          const err = st.def.validate?.(st.text) ?? null
          if (err) {
            st.error = err
            if (firstBad < 0) firstBad = fi
          }
        }
      })
      if (firstBad >= 0) {
        idx = firstBad
        render()
        return false
      }
      return true
    }

    const moveCursor = (st: FieldState, d: number) => {
      const n = toGraphemes(st.text).length
      st.cursor = Math.max(0, Math.min(n, st.cursor + d))
    }

    const insertText = (st: FieldState, ins: string) => {
      const clean = ins
        .replace(/\r\n|\r/g, " ")
        .replace(/\t/g, " ")
        // Kontrol dibuang (kecuali newline yang sudah jadi spasi).
        // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitasi input form
        .replace(/[\u0000-\u001f\u007f]/g, "")
      if (!clean) return
      const pts = toGraphemes(st.text)
      const at = Math.max(0, Math.min(st.cursor, pts.length))
      pts.splice(at, 0, ...toGraphemes(clean))
      st.text = pts.join("")
      st.cursor = at + toGraphemes(clean).length
      st.error = null
    }

    const deletePrev = (st: FieldState) => {
      const pts = toGraphemes(st.text)
      const at = Math.max(0, Math.min(st.cursor, pts.length))
      if (at === 0) return
      // Hapus satu grapheme (emoji/ZWJ/flag utuh).
      const head = pts.slice(0, at - 1)
      const tail = pts.slice(at)
      st.text = [...head, ...tail].join("")
      st.cursor = at - 1
      st.error = null
    }

    const handleKeys = (keys: DecodedKey[]): boolean => {
      if (done) return true
      resetIdle()
      const st = fields[idx]!
      for (const d of keys) {
        const k = d.key
        // Esc/Ctrl+C dua-tahap (anti-hilang draft): field kotor → kembalikan
        // ke nilai bawaan (prefill edit tak hilang sekali tekan — dulu
        // langsung dikosongkan tanpa undo); sudah bawaan/kosong → batal
        // total. Ctrl+D = batal langsung (konvensi EOF, tidak dipakai
        // menghapus).
        if (k.type === "esc" || k.type === "ctrl-c") {
          const cur = fields[idx]!
          const initial = typeof cur.def.initial === "string" ? cur.def.initial : ""
          if ((cur.def.kind === "text" || cur.def.kind === "secret") && cur.text !== initial) {
            cur.text = initial
            cur.cursor = toGraphemes(initial).length
            cur.viewStart = 0
            cur.error = null
            render()
            continue
          }
          finish(true)
          return true
        }
        if (k.type === "ctrl-d") {
          finish(true)
          return true
        }
        if (k.type === "enter") {
          if (validateAll()) finish(false)
          return false
        }
        if (k.type === "tab") {
          idx = (idx + 1) % fields.length
          continue
        }
        if (k.type === "shift-tab") {
          idx = (idx - 1 + fields.length) % fields.length
          continue
        }
        if (k.type === "up") {
          idx = (idx - 1 + fields.length) % fields.length
          continue
        }
        if (k.type === "down") {
          idx = (idx + 1) % fields.length
          continue
        }
        if (st.def.kind === "select") {
          const n = Math.max(1, st.def.options?.length ?? 1)
          if (k.type === "left") st.selectIdx = (st.selectIdx - 1 + n) % n
          else if (k.type === "right") st.selectIdx = (st.selectIdx + 1) % n
          continue
        }
        if (st.def.kind === "confirm") {
          if (k.type === "left" || k.type === "right") {
            st.confirmed = !st.confirmed
            continue
          }
          if (k.type === "char") {
            // Terima dwibahasa (label tampil per locale): y/yes/ya, n/no/tidak/t.
            const ch = k.ch.toLowerCase()
            if (ch === "y" || ch === "ya") st.confirmed = true
            else if (ch === "n" || ch === "t") st.confirmed = false
            continue
          }
          continue
        }
        // Text/secret editing.
        if (k.type === "char") insertText(st, k.ch)
        else if (k.type === "backspace") deletePrev(st)
        else if (k.type === "delete") {
          const pts = toGraphemes(st.text)
          const at = Math.max(0, Math.min(st.cursor, pts.length))
          if (at < pts.length) {
            pts.splice(at, 1)
            st.text = pts.join("")
            st.error = null
          }
        } else if (k.type === "left") moveCursor(st, -1)
        else if (k.type === "right") moveCursor(st, 1)
        else if (k.type === "home") st.cursor = 0
        else if (k.type === "end") st.cursor = toGraphemes(st.text).length
        else if (k.type === "ctrl-u") {
          st.text = ""
          st.cursor = 0
          st.viewStart = 0
          st.error = null
        } else if (k.type === "ctrl-w") {
          const pts = toGraphemes(st.text)
          const at = Math.max(0, Math.min(st.cursor, pts.length))
          const before = pts.slice(0, at).join("")
          const trimmed = before.replace(/\S+\s*$/, "")
          st.text = trimmed + pts.slice(at).join("")
          st.cursor = toGraphemes(trimmed).length
          st.error = null
        }
      }
      render()
      return false
    }

    const decoder: DecoderState = createDecoderState()
    const formPump = createKeyStreamPump({ state: decoder, onKeys: handleKeys })
    let onData!: (chunk: Buffer) => void
    let onResize!: () => void
    onData = (chunk: Buffer) => {
      resetIdle()
      try {
        formPump.push(chunk)
      } catch {
        finish(true)
      }
    }
    onResize = () => render()

    // Form berjalan di atas screen milik pemanggil (view membuka
    // openAltScreen sendiri; nested = paint-through). Listener stdin milik
    // form selama hidup — pemanggil wajib suspend dulu (pola popup komposit).
    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on("data", onData)
      process.stdout.on("resize", onResize)
      resetIdle()
      render()
    } catch {
      finish(true)
    }
  })
}
