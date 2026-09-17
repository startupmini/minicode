// Bangun halaman docs: konten + sidebar navigasi (dari SUMMARY.md, kelompok
// + entri, halaman aktif di-highlight). Sidebar di kiri di desktop, jadi list
// di atas di mobile via CSS. Prev/Next tetap di bawah sebagai alur linear.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { changelogPageHtml, parsePlanStatus } from "./changelog.ts"
import { escAttr, firstPara } from "./fm.ts"
import { escHtml, extractHeadings, mdToHtml } from "./md.ts"
import { type DocEntry, docMeta, readDocNav } from "./nav.ts"
import { breadcrumbJsonld, mdLinksToHtml, renderPage } from "./page.ts"

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

/**
 * Halaman changelog: digenerate dari PLAN.md (sumber hidup); docs/changelog.md
 * hanya stub anchor SUMMARY. Dipanggil orkestrator (build-web), bukan dari
 * loop buildDocs — builder ini sumbernya PLAN, bukan file md SUMMARY.
 */
export function buildChangelog(
  repoRoot: string,
  webDir: string,
  base: string,
  version: string,
  write: (rel: string, html: string) => void,
): string {
  const plan = readFileSync(join(repoRoot, "PLAN.md"), "utf8")
  const section = plan.split("## Status eksekusi")[1]
  if (!section) throw new Error("[web-build] PLAN.md: section 'Status eksekusi' hilang")
  const sectionBody = section.split(/^## /m)[0]!
  const entriesHtml = changelogPageHtml(parsePlanStatus(sectionBody))
  const canon = `${base}/docs/changelog.html`
  const body =
    `<div class="doc-layout">${renderDocSidebar(readDocNav(repoRoot), "changelog")}` +
    `<div class="doc-main">` +
    `<article class="doc-body"><h1>Changelog</h1>${entriesHtml}</article></div>` +
    `</div>`
  write(
    "docs/changelog.html",
    renderPage(webDir, {
      title: "Changelog",
      desc: "Status eksekusi rencana minicode — rilis, audit, dan perbaikan, digenerate dari PLAN.md.",
      canon,
      body,
      bodyClass: "doc",
      version,
      jsonld: JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          breadcrumbJsonld(base, [{ name: "Docs", item: `${base}/docs/` }, { name: "Changelog" }]),
          { "@type": "WebPage", name: "Changelog" },
        ],
      }).replaceAll("</", "<\\/"),
    }),
  )
  return canon
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
    // Changelog dibangun buildChangelog (dipanggil build-web) — loop ini
    // hanya halaman md dari SUMMARY.
    if (e.slug === "changelog") return
    const raw = readFileSync(join(repoRoot, "docs", e.file), "utf8")
    const meta = docMeta(e.slug)
    // Desc: DOC_META (kurasi ~155 char) menang — potongan firstPara sering
    // terpotong di tengah kalimat dan membawa meta-pembahasan, bukan deskripsi.
    const safeDesc =
      meta.desc.length >= 20 ? meta.desc : firstPara(raw).slice(0, 160).trim() || meta.desc
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
    // BreadcrumbList: rich result hidup 2026 — Home → Docs → halaman.
    const breadcrumb = breadcrumbJsonld(base, [
      { name: "Docs", item: `${base}/docs/` },
      { name: e.title },
    ])
    const rel = e.slug === "readme" ? "docs/index.html" : `docs/${e.slug}.html`
    const canon = e.slug === "readme" ? `${base}/docs/` : `${base}/docs/${e.slug}.html`
    write(
      rel,
      renderPage(webDir, {
        title: e.title.replace(/^Minicode\s*—\s*/, ""),
        desc: safeDesc,
        canon,
        body,
        bodyClass: "doc",
        version,
        jsonld: JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            breadcrumb,
            {
              "@type": "TechArticle",
              headline: e.title,
            },
          ],
          // `</` di-escape agar judul tak bisa menutup tag script (pola sama
          // seperti softwareJsonld di page.ts).
        }).replaceAll("</", "<\\/"),
      }),
    )
    urls.push(canon)
  })
  return urls
}
