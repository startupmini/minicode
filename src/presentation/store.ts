// Content Store V2.1 (§16 plan / §21 architecture) — sibling model, non-otoritatif.
//
// Kenapa terpisah: PresentationState hanya menyimpan ContentRef (pointer);
// isi besar (output tool, diff, reasoning) hidup di sini dengan retensi FIFO
// yang adil untuk sesi panjang. Reducer TIDAK PERNAH membaca store untuk
// keputusan (I-A04) — store hanya dilayani expand/proyeksi.
//
// Basar angka = collapse.ts:24-25 (200K per-entry / 500K total) — dipertahankan
// sebagai awal, bukan angka magis baru. Evict = FIFO tertua + tandai dead
// (bukan hapus diam-diam): proyeksi menampilkan penanda retensi, bukan string
// kosong yang menyesatkan.
//
// Durable fallback: resolve miss → loader inject (sqlite messages, tool result
// full) bila kind=output; reasoning di luar retensi = hilang dengan penanda
// (jujur). Restart: store kosong; expandRef lama → fallback durable.
//
// Pola potong (surrogate-safe + splitTrailingEscape) DIUlang di sini (bukan
// impor src/ui — boundary src/** non-ui dilarang impor src/ui). Pola sama
// dengan collapse.ts:66-71; trigonometri escape disederhanakan untuk kasus
// tail yang mungkin terpotong.

import type { ContentRef } from "./events.ts"

/** Cap per-entry — baseline collapse.ts MAX_SECTION_CHARS. */
export const MAX_SECTION_CHARS = 200_000
/** Cap total store — baseline collapse.ts MAX_BUFFER_TOTAL. */
export const MAX_BUFFER_TOTAL = 500_000

export type ContentKind = "output" | "diff" | "reasoning" | "diagnostic"

export interface ContentMeta {
  kind: ContentKind
  /** Stream asal (kontrak Unix dipertahankan saat /expand mencetak). */
  stream: "stdout" | "stderr"
  truncated: boolean
  /** Sumber konten saat resolve: store in-memory | durable sqlite | penanda retensi. */
  source?: "store" | "durable" | "retention"
}

export interface ContentEntry {
  text: string
  meta: ContentMeta
}

export interface ContentStore {
  put(ref: ContentRef, text: string, meta: ContentMeta): void
  get(ref: ContentRef): ContentEntry | undefined
  /** Tandai ref ter-evict (dipanggil otomatis saat FIFO melepas entry). */
  markDead(ref: ContentRef): void
  isDead(ref: ContentRef): boolean
  /**
   * Ambil konten: hit store → miss + kind output → durable loader → miss →
   * penanda retensi (bila pernah dead) / undefined (tak pernah ada).
   */
  resolve(
    ref: ContentRef,
    durable?: (toolCallId: string) => string | undefined,
  ): ContentEntry | undefined
  /** Semua idx untuk satu toolCallId (urut idx), sudah di-resolve. */
  expand(toolCallId: string, durable?: (toolCallId: string) => string | undefined): ContentEntry[]
  clear(): void
  stats(): { entries: number; totalChars: number; dead: number }
}

export function contentKey(ref: ContentRef): string {
  return `${ref.toolCallId}#${ref.idx}`
}

/** Potong aman: jangan belah surrogate pair, jangan sisakan ekor escape parsial. */
function trimToCap(text: string): string {
  if (text.length <= MAX_SECTION_CHARS) return splitTrailingEscape(text).head
  let cut = text.slice(0, MAX_SECTION_CHARS)
  const last = cut.charCodeAt(cut.length - 1)
  if (cut.length > 0 && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return splitTrailingEscape(cut).head
}

/** Pola sanitize.ts splitTrailingEscape — lokal (boundary presentation). */
function splitTrailingEscape(s: string): { head: string; tail: string } {
  const idx = s.lastIndexOf("\x1b")
  if (idx === -1) return { head: s, tail: "" }
  const next = s[idx + 1]
  if (next === undefined) return { head: s.slice(0, idx), tail: s.slice(idx) }
  if (next === "[") {
    let j = idx + 2
    while (j < s.length) {
      const code = s.charCodeAt(j)
      const ok = (code >= 0x30 && code <= 0x3f) || (code >= 0x21 && code <= 0x2f)
      if (!ok) break
      j++
    }
    // CSI diakhiri byte final 0x40–0x7E; bila string habis sebelum itu → tahan.
    if (j >= s.length) return { head: s.slice(0, idx), tail: s.slice(idx) }
    return { head: s, tail: "" }
  }
  if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
    // OSC/DCS/APC/PM/SOS: lengkap bila ada terminator BEL atau ESC \.
    const rest = s.slice(idx + 2)
    const bel = String.fromCharCode(7)
    if (!rest.includes(bel) && !rest.includes("\x1b\\")) {
      return { head: s.slice(0, idx), tail: s.slice(idx) }
    }
    return { head: s, tail: "" }
  }
  return { head: s, tail: "" }
}

/**
 * Content store in-memory FIFO. Satu instance per sesi (composition root);
 * kosong saat restart (durability = sqlite, bukan store).
 */
export function createContentStore(): ContentStore {
  // Map = insertion order = urutan FIFO untuk evict tertua.
  const entries = new Map<string, ContentEntry>()
  const dead = new Set<string>()
  let totalChars = 0

  const evictIfNeeded = (): void => {
    // Buang tertua sampai total dalam budget — terbaru selalu dipertahankan.
    while (totalChars > MAX_BUFFER_TOTAL && entries.size > 0) {
      const oldestKey = entries.keys().next().value
      if (oldestKey === undefined) break
      const old = entries.get(oldestKey)
      entries.delete(oldestKey)
      if (old) totalChars -= old.text.length
      dead.add(oldestKey)
    }
  }

  return {
    put(ref, text, meta) {
      if (!text) return
      const key = contentKey(ref)
      const prev = entries.get(key)
      if (prev) totalChars -= prev.text.length
      const cut = trimToCap(text)
      entries.set(key, {
        text: cut,
        meta: { ...meta, truncated: meta.truncated || cut.length < text.length },
      })
      totalChars += cut.length
      dead.delete(key)
      evictIfNeeded()
    },
    get(ref) {
      const hit = entries.get(contentKey(ref))
      if (hit) return { text: hit.text, meta: { ...hit.meta, source: "store" } }
      return undefined
    },
    markDead(ref) {
      const key = contentKey(ref)
      const hit = entries.get(key)
      if (hit) {
        entries.delete(key)
        totalChars -= hit.text.length
      }
      dead.add(key)
    },
    isDead(ref) {
      return dead.has(contentKey(ref))
    },
    resolve(ref, durable) {
      const local = entries.get(contentKey(ref))
      if (local) return { text: local.text, meta: { ...local.meta, source: "store" } }
      // Fallback durable HANYA untuk output (reasoning di luar retensi = hilang).
      if (durable) {
        const text = durable(ref.toolCallId)
        if (text != null && text !== "") {
          return {
            text,
            meta: {
              kind: "output",
              stream: "stderr",
              truncated: false,
              source: "durable",
            },
          }
        }
      }
      if (dead.has(contentKey(ref))) {
        return {
          text: "",
          meta: {
            kind: "output",
            stream: "stderr",
            truncated: false,
            source: "retention",
          },
        }
      }
      return undefined
    },
    expand(toolCallId, durable) {
      const prefix = `${toolCallId}#`
      const keys = [...entries.keys()].filter((k) => k.startsWith(prefix)).sort()
      const out: ContentEntry[] = []
      for (const k of keys) {
        const hit = entries.get(k)
        if (hit) out.push({ text: hit.text, meta: { ...hit.meta, source: "store" } })
      }
      if (out.length > 0) return out
      // Miss total: durable → retention (bila pernah ada & ter-evict).
      if (durable) {
        const text = durable(toolCallId)
        if (text != null && text !== "") {
          return [
            {
              text,
              meta: {
                kind: "output",
                stream: "stderr",
                truncated: false,
                source: "durable",
              },
            },
          ]
        }
      }
      const anyDead = [...dead].some((k) => k.startsWith(prefix))
      if (anyDead) {
        return [
          {
            text: "",
            meta: {
              kind: "output",
              stream: "stderr",
              truncated: false,
              source: "retention",
            },
          },
        ]
      }
      return []
    },
    clear() {
      entries.clear()
      dead.clear()
      totalChars = 0
    },
    stats() {
      return { entries: entries.size, totalChars, dead: dead.size }
    },
  }
}

/**
 * Flag perilaku baru Fase 4–6 (§28): baca LAZY per panggilan dari env —
 * jangan simpan ke `const` module scope (pola getter runtime repo).
 * Unset / "0" = bit-identik lama.
 */
export function presentationV2Enabled(): boolean {
  return process.env.MINICODE_PRESENTATION_V2 === "1"
}
