// Markdown decoration - Ubuntu Server style.
// Heading -> bold, bullet -> indentasi, code fence -> indentasi + syntax highlight.
// Inline: **bold**, *italic*, `code`, ~~strike~~, [text](url) -> teks accent (no underline).

import { highlightCode } from "./highlight.ts"
import { sanitizeAnsi } from "./sanitize.ts"
import { c } from "./theme.ts"

export interface FenceMatch {
  char: string
  len: number
  lang: string
}

/**
 * Parse satu baris fence markdown (``` atau ~~~) → info pembuka, atau null.
 *
 * Diekspor agar simple.ts (printer linier streaming) memakai parser yang SAMA
 * dengan decorateMarkdown — sebelumnya ia men-toggle `inFence` naif per baris
 * (`line.includes("```")`) yang tidak kenal ~~~ dan tidak cek char/panjang,
 * sehingga fence berbahasa kehilangan highlight dan state desync.
 */
export function parseFence(line: string): FenceMatch | null {
  const m = /^\s*(```+|~~~+)([A-Za-z0-9_+.-]*)\s*$/.exec(line)
  if (!m) return null
  return { char: m[1]![0]!, len: m[1]!.length, lang: m[2] ?? "" }
}

// ── Inline markdown -> ANSI ──
// Urutan replace lama: `code` diganti dulu jadi `c.brightCyan(...)`, lalu
// regex **bold** masih menemukan `**` DI DALAM hasil cyan → `` `**a**` ``
// menjadi bold+cyan ganda. Isi inline code tidak boleh di-dekorasi lagi.
const CODE_PLACEHOLDER = "\u0000"
export function renderInline(text: string): string {
  // Simpan isi `code` dulu, restore TERAKHIR supaya bold/italic/strike tidak
  // menyentuhnya. Placeholder ASCII-null tidak mungkin muncul di teks model
  // (sanitizeAnsi membuang semua C0 termasuk null).
  const codes: string[] = []
  let t = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code)
    return CODE_PLACEHOLDER
  })
  // [text](url) -> accent bold text (url hidden, no underline - terminal can't click)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string) => c.accent(c.bold(label)))
  // **bold**
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, bold: string) => c.bold(bold))
  // *italic*
  t = t.replace(
    /(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g,
    (_m, pre: string, ital: string) => `${pre}${c.italic(ital)}`,
  )
  // __bold__
  t = t.replace(/__([^_]+)__/g, (_m, bold: string) => c.bold(bold))
  // ~~strike~~
  t = t.replace(/~~([^~]+)~~/g, (_m, del: string) => c.muted(del))
  // Restore code blocks (bisa memuat * _ ~ ` → lindungi dari regex di atas).
  let ci = 0
  // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholder internal (ASCII null)
  return t.replace(/\u0000/g, () => c.brightCyan(codes[ci++] ?? ""))
}

export function decorateMarkdown(text: string): string {
  // Teks model tak-terpercaya: sanitasi SEKALI di hulu agar fence-content,
  // renderInline, dan highlight tak pernah melihat escape mentah. Urutan ini
  // juga melindungi placeholder `\u0000` (sanitize membuang null model).
  const lines = sanitizeAnsi(text).split("\n")
  const out: string[] = []
  let inFence = false
  let fenceLang = ""
  let fenceChar = ""
  let fenceLen = 0

  for (const line of lines) {
    // Code fence handling — catat char & panjang pembuka, hanya tutup bila cocok.
    const fence = parseFence(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceChar = fence.char
        fenceLen = fence.len
        fenceLang = fence.lang
      } else {
        if (fence.char === fenceChar && fence.len >= fenceLen) {
          inFence = false
          fenceChar = ""
          fenceLen = 0
          fenceLang = ""
        } else {
          // fence di dalam fence dengan char/len berbeda → anggap konten
          out.push(`  ${fenceLang ? highlightCode(line, fenceLang) : line}`)
          continue
        }
      }
      continue
    }

    // Di DALAM fence: isi kode tidak boleh disentuh markdown.
    //
    // Sebelumnya hanya fence BERBAHASA yang dilindungi (`if (inFence && fenceLang)`),
    // sehingga fence tanpa bahasa jatuh ke renderInline di bawah dan
    // `npm run build -- --flag=*value*` kehilangan bintangnya karena dianggap
    // italic. Fence tanpa bahasa justru bentuk paling umum untuk perintah shell.
    if (inFence) {
      out.push(`  ${fenceLang ? highlightCode(line, fenceLang) : line}`)
      continue
    }

    // Headings (# ## ###) -> bold with vertical spacing
    if (/^#{1,3}\s/.test(line)) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("")
      out.push(c.bold(line))
      continue
    }

    // Bullet list -> indentasi
    if (/^\s*[-*]\s/.test(line)) {
      out.push(`  ${renderInline(line.trimStart())}`)
      continue
    }

    out.push(renderInline(line))
  }
  return out.join("\n")
}
