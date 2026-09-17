// Parser markdown mini untuk web minicode.
// Mengapa mini, bukan library: repo berpostur zero-dep runtime dan dokumen
// sumber hanya memakai subset (heading, fence, tabel, list, link, inline
// code, bold). Cukup untuk docs + blog tanpa menambah dependensi.
export function escHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function inlineMd(s: string): string {
  // Inline code dulu agar isi `...` tidak diproses bold/link.
  // Penanda pakai string biasa (bukan NUL): biome melarang control char di regex.
  const codes: string[] = []
  let out = s.replace(/`([^`]+)`/g, (_, c: string) => {
    // translate="no": token kode/identitas tak boleh diubah auto-translate
    // browser (guideline i18n — kode yang diterjemahkan jadi tak bisa di-copy).
    codes.push(`<code translate="no">${escHtml(c)}</code>`)
    return `@@MC${codes.length - 1}@@`
  })
  out = escHtml(out)
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t: string, u: string) => {
    const url = u.trim()
    // Hanya izinkan http(s), path absolut/relatif, dan anchor.
    if (!/^(https?:\/\/|\/|#|[a-zA-Z0-9._-]+\/|[a-zA-Z0-9._-]+\.html)/.test(url)) return t
    return `<a href="${escHtml(url)}">${t}</a>`
  })
  // Ellipsis tipografis di prose (guideline): `...` → `…`. Split per-tag:
  // segmen berawalan `<` = tag (href/aria-label utuh), sisanya text node
  // termasuk teks awal/akhir paragraf. Code span masih placeholder di sini;
  // fence tak lewat jalur ini (escHtml saja).
  out = out
    .split(/(<[^>]+>)/)
    .map((seg) => (seg.startsWith("<") ? seg : seg.replaceAll("...", "…")))
    .join("")
  out = out.replace(/@@MC(\d+)@@/g, (_, i: string) => codes[Number(i)] ?? "")
  return out
}

function isTableSep(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|.-]*$/.test(line) && line.includes("-")
}

function renderTable(head: string, rows: string[]): string {
  // Pecah baris tabel TANPA memotong `|` di dalam code span atau `\|`
  // (audit website: split buta menghasilkan sel ekstra + backtick rusak di
  // separuh tabel referensi). `\|` menjadi `|` literal (escape dikonsumsi).
  const cells = (l: string): string[] => {
    const src = l.trim().replace(/^\||\|$/g, "")
    const out: string[] = []
    let cur = ""
    let inCode = false
    for (let i = 0; i < src.length; i++) {
      const ch = src[i]!
      if (ch === "`") {
        inCode = !inCode
        cur += ch
      } else if (ch === "\\" && src[i + 1] === "|") {
        cur += "|"
        i++
      } else if (ch === "|" && !inCode) {
        out.push(cur.trim())
        cur = ""
      } else {
        cur += ch
      }
    }
    out.push(cur.trim())
    return out
  }
  const th = cells(head)
    .map((c) => `<th>${inlineMd(c)}</th>`)
    .join("")
  const tr = rows
    .map(
      (r) =>
        `<tr>${cells(r)
          .map((c) => `<td>${inlineMd(c)}</td>`)
          .join("")}</tr>`,
    )
    .join("")
  const cls = "flat"
  return `<table class="${cls}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
}

/** Slug stabil untuk id heading: huruf-kecil, non-alnum jadi strip. */
export function slugifyHeading(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9\u00C0-\u024F\u1E00-\u1EFF]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "bagian"
  )
}

export interface Heading {
  level: number
  text: string
  id: string
}

/**
 * Pindai heading H1–H3 sumber markdown dengan slug+dedup yang SAMA PERSIS
 * seperti mdToHtml (satu algoritma, dipakai renderer + TOC agar id tak
 * divergen). Dipakai docs.ts untuk TOC halaman panjang.
 */
export function extractHeadings(src: string): Heading[] {
  const out: Heading[] = []
  const seen = new Map<string, number>()
  let inFence = false
  for (const rawLine of src.replaceAll("\r\n", "\n").split("\n")) {
    // Samakan dengan mdToHtml: baris `#` di dalam fence BUKAN heading.
    if (/^```(\w*)\s*$/.exec(rawLine.trim())) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const h = /^(#{1,3})\s+(.*)$/.exec(rawLine)
    if (!h) continue
    const text = h[2]!.trim()
    if (!text) continue
    const base = slugifyHeading(text.replace(/[*_`[\]()]/g, ""))
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    out.push({ level: h[1]!.length, text, id: n === 1 ? base : `${base}-${n}` })
  }
  return out
}

/** Ubah markdown subset menjadi HTML. Aman: fence di-escape penuh. */
export function mdToHtml(src: string): string {
  const headingIds = new Map<string, number>()
  // ID heading deterministik — urutan + dedup SAMA dengan extractHeadings.
  const nextId = (text: string): string => {
    const base = slugifyHeading(text.replace(/[*_`[\]()]/g, ""))
    const n = (headingIds.get(base) ?? 0) + 1
    headingIds.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  }
  const lines = src.replaceAll("\r\n", "\n").split("\n")
  const html: string[] = []
  let i = 0
  let inFence = false
  let fenceLang = ""
  let fenceBuf: string[] = []
  let listOpen = false
  let olOpen = false
  const closeList = (): void => {
    if (listOpen) {
      // Daftar bernomor dirender <ol> sungguhan (audit web P1-3): dulu `1.`
      // jatuh ke <p> sehingga semua langkah prosedural docs kehilangan
      // semantik list — screen reader membacanya sebagai kalimat, dan
      // penomoran tak ikut penataan list CSS.
      html.push(olOpen ? "</ol>" : "</ul>")
      listOpen = false
      olOpen = false
    }
  }
  const flushFence = (): void => {
    const code = escHtml(fenceBuf.join("\n"))
    const lang = fenceLang ? ` data-lang="${escHtml(fenceLang)}"` : ""
    html.push(`<pre${lang}><code translate="no">${code}</code></pre>`)
    fenceBuf = []
  }
  while (i < lines.length) {
    const line = lines[i] ?? ""
    const fence = /^```(\w*)\s*$/.exec(line.trim())
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceLang = fence[1] ?? ""
        closeList()
      } else {
        inFence = false
        flushFence()
        fenceLang = ""
      }
      i++
      continue
    }
    if (inFence) {
      fenceBuf.push(line)
      i++
      continue
    }
    if (/^\s*$/.test(line)) {
      closeList()
      i++
      continue
    }
    // Baris indentasi tepat setelah item list = LANJUTAN item (adversarial:
    // dulu jatuh ke branch paragraf → <ol> PECAH dan penomoran restart dari 1;
    // docs sungguhan security.md memakai pola ini). Blank tetap memutus list
    // (kontrak lama, dijaga test "docs tanpa nested list"). Diposisikan
    // SETELAH cek fence: fence indentasi tetap berperilaku seperti semula.
    if (
      listOpen &&
      /^\s+\S/.test(line) &&
      html.length > 0 &&
      html[html.length - 1]!.endsWith("</li>")
    ) {
      const last = html.length - 1
      html[last] = html[last]!.replace(/<\/li>$/, ` ${inlineMd(line.trim())}</li>`)
      i++
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      const lvl = h[1]!.length
      const htext = h[2]!.trim()
      const hid = nextId(htext)
      // Taut anchor hover-reveal (CSS) agar setiap section bisa di-deep-link.
      html.push(
        `<h${lvl} id="${hid}"><a class="hl" href="#${hid}" aria-label="Tautan ke bagian ini">#</a>${inlineMd(htext)}</h${lvl}>`,
      )
      i++
      continue
    }
    if (i + 1 < lines.length && isTableSep(lines[i + 1] ?? "")) {
      closeList()
      const rows: string[] = []
      i += 2
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        rows.push(lines[i]!)
        i++
      }
      html.push(renderTable(line, rows))
      continue
    }
    const li = /^[-*]\s+(.*)$/.exec(line)
    if (li) {
      if (!listOpen || olOpen) {
        closeList()
        html.push("<ul>")
        listOpen = true
        olOpen = false
      }
      html.push(`<li>${inlineMd(li[1]!.trim())}</li>`)
      i++
      continue
    }
    const ol = /^\d+\.\s+(.*)$/.exec(line)
    if (ol) {
      if (!listOpen || !olOpen) {
        closeList()
        html.push("<ol>")
        listOpen = true
        olOpen = true
      }
      html.push(`<li>${inlineMd(ol[1]!.trim())}</li>`)
      i++
      continue
    }
    if (line.trim().startsWith(">")) {
      closeList()
      html.push(`<p><em>${inlineMd(line.replace(/^>\s?/, "").trim())}</em></p>`)
      i++
      continue
    }
    closeList()
    // Gabung baris lanjutan menjadi satu paragraf.
    let para = line.trim()
    while (
      i + 1 < lines.length &&
      (lines[i + 1] ?? "").trim() !== "" &&
      !/^(#{1,3}\s|```|[-*]\s|\d+\.\s|>)/.test(lines[i + 1] ?? "") &&
      !(lines[i + 1] ?? "").includes("|")
    ) {
      para += ` ${(lines[i + 1] ?? "").trim()}`
      i++
    }
    html.push(`<p>${inlineMd(para)}</p>`)
    i++
  }
  closeList()
  if (inFence) flushFence()
  return html.join("\n")
}
