// Changelog publik dari PLAN.md: section "Status eksekusi" (baris `- ✅|⏳
// Judul (tanggal): teks...` + baris lanjutan ter-indent) diparse jadi entri
// halaman /docs/changelog.html. Satu sumber status: maintainer update PLAN.md,
// website ikut saat build — tanpa digest statis yang pernah stale.
import { formatBlogDate } from "./blog.ts"
import { escAttr } from "./fm.ts"
import { escHtml, inlineMd, mdToHtml } from "./md.ts"

export type ChangelogEntry = {
  title: string
  date: string // ISO atau "" bila head tanpa tanggal
  prose: string // markdown satu blok (baris lanjutan digabung)
}

export function parsePlanStatus(src: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let cur: ChangelogEntry | null = null
  const flush = () => {
    if (cur) entries.push(cur)
    cur = null
  }
  for (const raw of src.split(/\r?\n/)) {
    const item = /^- (?:✅|⏳) (.+)$/.exec(raw)
    if (item) {
      flush()
      const head = item[1]!
      // Titik dua pemisah judul:teks = yang PERTAMA di luar kurung — entri
      // PLAN ada yang memakai ':' di dalam paren (`(… — detail: `docs/…`)`).
      let ci = -1
      let depth = 0
      for (let i = 0; i < head.length; i++) {
        const c = head[i]
        if (c === "(") depth++
        else if (c === ")") depth = Math.max(0, depth - 1)
        else if (c === ":" && depth === 0) {
          ci = i
          break
        }
      }
      cur = {
        // Parenthetical tanggal/"uncommitted" di ekor judul = jargon internal +
        // duplikat <time> di halaman publik — dibuang; paren lain (commit,
        // skor) dipertahankan. inlineMd: backtick dsb. dirender, bukan mentah.
        title: inlineMd(
          (ci >= 0 ? head.slice(0, ci) : head)
            .trim()
            .replace(/\s*\((?:uncommitted[^)]*|\d{4}-\d{2}-\d{2}[^)]*)\)$/, ""),
        ),
        date: /\b(\d{4}-\d{2}-\d{2})\b/.exec(head)?.[1] ?? "",
        prose: ci >= 0 ? head.slice(ci + 1).trim() : "",
      }
      continue
    }
    if (!cur) continue
    // Baris indentasi = lanjutan teks entri; baris kosong / non-indent = batas.
    if (/^ {2,}\S/.test(raw)) {
      cur.prose += `\n${raw.trim()}`
      continue
    }
    flush()
  }
  flush()
  return entries
}

export function changelogPageHtml(entries: ChangelogEntry[]): string {
  return (
    `<p class="lede">Riwayat rilis dan status eksekusi — dibangkitkan dari PLAN.md saat build.</p>` +
    entries
      .map((e) => {
        const d = /^\d{4}-\d{2}-\d{2}$/.test(e.date)
          ? ` <time datetime="${escAttr(e.date)}">${escHtml(formatBlogDate(e.date))}</time>`
          : ""
        return (
          `<section class="cl-item"><h2>${e.title}${d}</h2>` +
          `<div class="cl-body">${mdToHtml(e.prose)}</div></section>`
        )
      })
      .join("")
  )
}
