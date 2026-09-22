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

/** Rute halaman docs dari slug SUMMARY — satu tempat, dipakai sidebar, grid,
 * dan prev/next (dulu helper ini disalin di dua fungsi). */
function hrefOf(e: { slug: string }): string {
  return e.slug === "readme" ? "/docs/" : `/docs/${e.slug}.html`
}

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
 * Header halaman docs: kicker (kelompok SUMMARY) + judul mono skala display,
 * opsional lede. Satu bentuk untuk semua halaman docs dan changelog supaya
 * halaman referensi terasa satu keluarga dengan landing.
 */
export function renderDocHead(group: string, title: string, lede = ""): string {
  return (
    `<header class="doc-head"><p class="kicker">${escAttr(group)}</p>` +
    `<h1>${escHtml(title)}</h1>` +
    (lede ? `<p class="lede">${lede}</p>` : "") +
    `</header>`
  )
}

/**
 * Navigasi prev/next di bawah artikel. Sejak rombak docs, tiap sisi memawa
 * judul halaman tujuan — tanpa itu pembaca harus mengklik dulu untuk tahu
 * ke mana lanjutnya (dulu cuma "‹ Prev"). Slot kosong = <span> penjaga
 * agar sisi kanan tetap menempel kanan (flex).
 */
export function renderDocNav(entries: DocEntry[], idx: number): string {
  const prev = entries[idx - 1]
  const next = entries[idx + 1]
  return (
    `<nav class="doc-nav" aria-label="Navigasi dokumentasi">` +
    (prev
      ? `<a class="prev" href="${hrefOf(prev)}"><span class="dn-k">‹ Sebelumnya</span><span class="dn-t">${escAttr(prev.title)}</span></a>`
      : `<span></span>`) +
    (next
      ? `<a class="next" href="${hrefOf(next)}"><span class="dn-k">Berikutnya ›</span><span class="dn-t">${escAttr(next.title)}</span></a>`
      : `<span></span>`) +
    `</nav>`
  )
}

/**
 * Buang satu section markdown (heading + isi sampai heading berikutnya).
 * Dipakai hub docs: tabel "Navigasi" 28 baris di README digantikan grid yang
 * digenerate dari SUMMARY — tanpa ini daftar yang sama tampil dua kali di
 * halaman yang sama. README tetap utuh untuk pembaca repo di GitHub.
 */
export function stripMdSection(md: string, heading: string): string {
  const re = new RegExp(`(?:^|\\n)## ${heading}\\s*\\n[\\s\\S]*?(?=\\n## |\\s*$)`)
  return md.replace(re, "")
}

/**
 * Grid kelompok dokumentasi (hub /docs/): semua halaman SUMMARY tanpa sidebar,
 * judul + deskripsi kurasi dari DOC_META. Halaman hub sendiri (readme)
 * dilewati — tautan ke diri sendiri tak berguna. Ini pengganti tabel Navigasi
 * README di web; sidebar disembunyikan di hub karena isinya identik.
 */
export function renderDocGrid(entries: DocEntry[]): string {
  const groups: { name: string; items: DocEntry[] }[] = []
  for (const e of entries) {
    if (e.slug === "readme") continue
    const g = groups.find((x) => x.name === e.group)
    if (g) g.items.push(e)
    else groups.push({ name: e.group, items: [e] })
  }
  const secs = groups
    .map(
      (g) =>
        `<div class="dg"><p class="ds-g">${escAttr(g.name)}</p><div class="dg-list">` +
        g.items
          .map(
            (e) =>
              `<a class="dc" href="${hrefOf(e)}"><span class="dc-t">${escAttr(e.title)}</span>` +
              `<span class="dc-d">${escAttr(docMeta(e.slug).desc)}</span></a>`,
          )
          .join("") +
        `</div></div>`,
    )
    .join("")
  return `<nav class="doc-grid" aria-label="Semua halaman dokumentasi"><h2>Jelajahi dokumentasi</h2>${secs}</nav>`
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
  // SEMUA section "Status eksekusi …" — bukan hanya yang pertama. Halaman ini
  // adalah RIWAYAT: entri lama (mis. marker guard `GUARD-CHLOG-SATU`) harus
  // tetap tampil walau maintainer menambah section status baru di atasnya;
  // mengambil section pertama saja membuat guard test changelog jadi bohong
  // begitu section kedua lahir.
  const sections = plan.split(/^## Status eksekusi.*$/m).slice(1)
  if (sections.length === 0)
    throw new Error("[web-build] PLAN.md: section 'Status eksekusi' hilang")
  const sectionBody = sections.map((s) => s.split(/^## /m)[0]!).join("\n")
  const entriesHtml = changelogPageHtml(parsePlanStatus(sectionBody))
  const canon = `${base}/docs/changelog.html`
  const body =
    `<div class="doc-layout">${renderDocSidebar(readDocNav(repoRoot), "changelog")}` +
    `<div class="doc-main">` +
    renderDocHead("Kontribusi & Arsitektur", "Changelog") +
    `<article class="doc-body">${entriesHtml}</article></div>` +
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
    const isHub = e.slug === "readme"
    // Desc: DOC_META (kurasi ~155 char) menang — potongan firstPara sering
    // terpotong di tengah kalimat dan membawa meta-pembahasan, bukan deskripsi.
    const safeDesc =
      meta.desc.length >= 20 ? meta.desc : firstPara(raw).slice(0, 160).trim() || meta.desc
    // Hub: section "Navigasi" (tabel 28 baris) dibuang untuk web — digantikan
    // grid dari SUMMARY di bawah artikel. README tetap utuh untuk GitHub.
    const src = isHub ? stripMdSection(raw, "Navigasi") : raw
    // Hapus H1 pertama dari markdown — judul halaman pakai SUMMARY (satu saja).
    // Pola toleran atribut karena heading renderer kini membawa id+anchor.
    let content = mdLinksToHtml(mdToHtml(src))
    content = content.replace(/^<h1\b[^>]*>[\s\S]*?<\/h1>\s*/, "")
    // Hub memakai paragraf pertama README sebagai lede di header — diangkat
    // dari isi supaya tidak tampil dua kali (pola yang sama seperti H1 di atas).
    let lede = ""
    if (isHub) {
      const m = /^<p>([\s\S]*?)<\/p>\s*/.exec(content)
      if (m) {
        lede = m[1]!
        content = content.slice(m[0]!.length)
      }
    }
    // TOC hanya untuk halaman panjang (audit website: halaman kecil tak butuh).
    // Ambang: ≥4 H2. ID dihitung dari sumber dengan algoritma yang sama
    // seperti renderer sehingga href selalu resolve (dijaga web-check).
    // Hub tak perlu TOC: navigasinya grid kelompok dari SUMMARY.
    const h2s = extractHeadings(src).filter((h) => h.level === 2)
    const toc =
      !isHub && h2s.length >= 4
        ? `<nav class="toc" aria-label="Daftar isi"><p>Daftar isi</p><ol>${h2s
            .map(
              (h) =>
                // Nomor bawaan heading ("1. Jalan pertama") dibuang dari LABEL:
                // penomoran sudah dipasang counter CSS di li::before — tanpa
                // ini halaman dengan heading bernomor tampil dobel.
                // Anchor tetap dari teks asli, jadi href tak berubah.
                `<li><a href="#${h.id}">${escAttr(
                  h.text.replace(/[*_`[\]()#]/g, "").replace(/^\d+\.\s+/, ""),
                )}</a></li>`,
            )
            .join("")}</ol></nav>`
        : ""
    const head = renderDocHead(isHub ? "Dokumentasi" : e.group, e.title, lede)
    const grid = isHub ? renderDocGrid(entries) : ""
    // Hub: grid DI ATAS artikel — tanpa sidebar, direktori ini satu-satunya
    // jalan menuju halaman lain, jadi tidak boleh berada di dasar halaman
    // (pembaca ponsel harus bisa langsung memilih halaman).
    const body =
      `<div class="doc-layout${isHub ? " hub" : ""}">` +
      (isHub ? "" : renderDocSidebar(entries, e.slug)) +
      `<div class="doc-main">${head}${grid}` +
      `<article class="doc-body${isHub ? " doc-hub" : ""}">${toc}${content}</article>` +
      `${renderDocNav(entries, idx)}</div>` +
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
