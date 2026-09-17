// Bangun halaman docs: konten + sidebar navigasi (dari SUMMARY.md, kelompok
// + entri, halaman aktif di-highlight). Sidebar di kiri di desktop, jadi list
// di atas di mobile via CSS. Prev/Next tetap di bawah sebagai alur linear.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { escAttr, firstPara } from "./fm.ts"
import { escHtml, extractHeadings, mdToHtml } from "./md.ts"
import { type DocEntry, docMeta, readDocNav } from "./nav.ts"
import { mdLinksToHtml, renderPage } from "./page.ts"

/**
 * Render sidebar docs: kelompok SUMMARY + entri, halaman aktif di-highlight.
 * Re-envision 2026-09-17 (nav docs = subsistem terlemah): mobile dulu men-stack
 * 27 link DI ATAS konten (dinding link sebelum isi) — bentuk yang salah untuk
 * ponsel. Kini menu = <details> collapsible: konten selalu pertama, menu
 * sticky satu tap di bawah topbar. Desktop: nav selalu terbuka (summary
 * disembunyikan CSS, `open` dari markup + sinkron app.js). Tanpa JS, mobile
 * terdegradasi ke perilaku lama (terbuka), desktop tetap utuh.
 */
export function renderDocSidebar(entries: DocEntry[], activeSlug: string): string {
  const hrefOf = (e2: { slug: string }): string =>
    e2.slug === "readme" ? "/docs/" : `/docs/${e2.slug}.html`
  const out: string[] = []
  let group = ""
  for (const e of entries) {
    if (e.group !== group) {
      group = e.group
      out.push(`<p class="ds-g">${escAttr(group)}</p>`)
    }
    const active = e.slug === activeSlug
    out.push(
      `<a class="ds-i${active ? " on" : ""}" href="${hrefOf(e)}"${active ? ' aria-current="page"' : ""}>${escAttr(e.title)}</a>`,
    )
  }
  return (
    `<aside class="doc-side" aria-label="Menu dokumentasi">` +
    `<details class="ds-fold" open><summary>Menu dokumentasi</summary>${out.join("")}</details>` +
    `</aside>`
  )
}

export function buildDocs(
  repoRoot: string,
  webDir: string,
  base: string,
  version: string,
  write: (rel: string, html: string) => void,
): string[] {
  const entries = readDocNav(repoRoot)
  const urls: string[] = []
  entries.forEach((e, idx) => {
    const raw = readFileSync(join(repoRoot, "docs", e.file), "utf8")
    const meta = docMeta(e.slug)
    const desc = (firstPara(raw).slice(0, 160) || meta.desc).trim()
    const safeDesc = desc.length >= 20 ? desc : meta.desc
    // Hapus H1 pertama dari markdown — judul halaman pakai SUMMARY (satu saja).
    // Pola toleran atribut karena heading renderer kini membawa id+anchor.
    let content = mdLinksToHtml(mdToHtml(raw))
    content = content.replace(/^<h1\b[^>]*>[\s\S]*?<\/h1>\s*/, "")
    // TOC hanya untuk halaman panjang (audit website: halaman kecil tak butuh).
    // Ambang: ≥4 H2. ID dihitung dari sumber dengan algoritma yang sama
    // seperti renderer sehingga href selalu resolve (dijaga web-check).
    const h2s = extractHeadings(raw).filter((h) => h.level === 2)
    const toc =
      h2s.length >= 4
        ? `<nav class="toc" aria-label="Daftar isi"><p>Daftar isi</p><ul>${h2s
            .map(
              (h) =>
                `<li><a href="#${h.id}">${escAttr(h.text.replace(/[*_`[\]()#]/g, ""))}</a></li>`,
            )
            .join("")}</ul></nav>`
        : ""
    const hrefOf = (e2: { slug: string }): string =>
      e2.slug === "readme" ? "/docs/" : `/docs/${e2.slug}.html`
    const prev = entries[idx - 1]
    const next = entries[idx + 1]
    const nav =
      `<nav class="doc-nav" aria-label="Navigasi dokumentasi">` +
      (prev ? `<a class="prev" href="${hrefOf(prev)}">‹ Prev</a>` : `<span></span>`) +
      (next ? `<a class="next" href="${hrefOf(next)}">Next ›</a>` : `<span></span>`) +
      `</nav>`
    const body =
      `<div class="doc-layout">${renderDocSidebar(entries, e.slug)}` +
      `<div class="doc-main">` +
      `<article class="doc-body"><h1>${escHtml(e.title)}</h1>${toc}${content}</article>${nav}</div>` +
      `</div>`
    const rel = e.slug === "readme" ? "docs/index.html" : `docs/${e.slug}.html`
    const canon = e.slug === "readme" ? `${base}/docs/` : `${base}/docs/${e.slug}.html`
    write(
      rel,
      renderPage(webDir, {
        title: e.title,
        desc: safeDesc,
        canon,
        body,
        bodyClass: "doc",
        version,
        jsonld: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "TechArticle",
          headline: e.title,
          // `</` di-escape agar judul tak bisa menutup tag script (pola sama
          // seperti softwareJsonld di page.ts).
        }).replaceAll("</", "<\\/"),
      }),
    )
    urls.push(canon)
  })
  return urls
}
