// Render halaman: bungkus konten ke layout.html + SEO tags + JSON-LD.
// Token {{..}} di layout diisi di sini agar tiap halaman punya title,
// description, canonical, dan structured data sendiri (syarat SEO).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { escAttr } from "./fm.ts"

export interface PageOpts {
  title: string
  desc: string
  canon: string
  body: string
  bodyClass?: string
  ogType?: string
  jsonld: string
  version: string
}

let layoutCache = ""
let layoutCachePath = ""

export function renderPage(webDir: string, opts: PageOpts): string {
  // Cache per-path (audit web: cache lama global per-proses — test yang
  // memakai webDir berbeda dalam satu proses bisa membaca layout stale).
  if (!layoutCache || layoutCachePath !== webDir) {
    layoutCache = readFileSync(join(webDir, "layout.html"), "utf8")
    layoutCachePath = webDir
  }
  return layoutCache
    .replaceAll("{{TITLE}}", escAttr(opts.title))
    .replaceAll("{{DESC}}", escAttr(opts.desc))
    .replaceAll("{{CANON}}", opts.canon)
    .replaceAll("{{OGTYPE}}", opts.ogType ?? "website")
    .replaceAll("{{BODYCLASS}}", opts.bodyClass ?? "")
    .replaceAll("{{JSONLD}}", opts.jsonld)
    .replaceAll("{{CONTENT}}", opts.body)
    .replaceAll("{{VERSION}}", `v${escAttr(opts.version)}`)
}

/**
 * Satu pemilik konvensi tautan antar-dokumen (2026-09-17): `nama.md` yang
 * ditulis di sumber dipetakan ke rute situs — slug `readme` = index docs,
 * `PLAN.md` (disebut docs/README.md & PLAN.md) = halaman changelog (file
 * repo tak ikut di-deploy) — bentuk `../PLAN.md` dari docs/changelog.md
 * masuk juga. Dipakai dua mapper: `mdLinksToHtml` (pipeline HTML) dan
 * `mdLinksAbsolute` (llms-full.txt, markdown mentah).
 */
export function resolveDocLink(file: string, base: string): string {
  const slug = file
    .replace(/\.md$/, "")
    .replace(/^\.\.\//, "")
    .toLowerCase()
  if (slug === "plan") return `${base}/docs/changelog.html`
  if (slug === "readme") return `${base}/docs/`
  return `${base}/docs/${slug}.html`
}

/** Tautan antar-docs di pipeline HTML (hasil `mdToHtml`): href="x.md". */
export function mdLinksToHtml(html: string, base = ""): string {
  // Nama file kapital/underscore sah sejak grup "Internal & Arsitektur"
  // (TERMINAL_CONTRACT.md dll.) masuk SUMMARY — resolveDocLink men-lowercase.
  return html.replace(
    /href="([A-Za-z0-9_-]+|\.\.\/(?:PLAN|CHANGELOG))\.md(#[^"]*)?"/g,
    (_, f: string, h: string) => {
      return `href="${resolveDocLink(f, base)}${h ?? ""}"`
    },
  )
}

/** Sama untuk markdown mentah (llms-full.txt): ](x.md) → ](URL absolut). */
export function mdLinksAbsolute(body: string, base: string): string {
  return body.replace(
    /\]\(([A-Za-z0-9_-]+|\.\.\/(?:PLAN|CHANGELOG))\.md(#[^)\s]*)?\)/g,
    (_, f: string, h: string) => {
      return `](${resolveDocLink(f, base)}${h ?? ""})`
    },
  )
}

export function softwareJsonld(version: string): string {
  // Audit website: JANGAN escAttr() di sini — hasilnya masuk BODY <script>,
  // bukan atribut; entity `&quot;` tidak di-decode di sana sehingga JSON-LD
  // invalid (crawler gagal parse). `</` di-escape agar `</script>` di dalam
  // string tak bisa menutup tag (JSON tetap valid).
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Minicode",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Windows, Linux, macOS",
    softwareVersion: version,
    license: "https://opensource.org/licenses/MIT",
    offers: { "@type": "Offer", price: "0" },
  }).replaceAll("</", "<\\/")
}

/**
 * Node BreadcrumbList untuk @graph halaman. Satu pemilik dua konvensi:
 * (1) `Beranda` selalu position 1 — helper yang menambahkannya, (2) elemen
 * terakhir TANPA `item` (rekomendasi Google) — ditegakkan di sini meski
 * pemanggil mengirimnya. Kembalikan objek; stringify+escape di call site.
 */
/**
 * JSON-LD Organization untuk homepage (audit SEO SERP-01 2026-09-24): entitas
 * brand resmi + sameAs (GitHub, npm) agar mesin pencari bisa mengikat "Minicode"
 * ke situs ini — sebelumnya SERP brand didominasi proyek GitHub tak terkait dan
 * minicode.fun sama sekali absen. @id stabil agar node lain (Article.publisher)
 * boleh merujuk tanpa menduplikasi definisi lintas halaman.
 */
export function organizationJsonld(base: string): Record<string, unknown> {
  return {
    "@type": "Organization",
    "@id": `${base}/#organization`,
    name: "Minicode",
    url: `${base}/`,
    // Logo pakai og-image.png (PNG, 1200×630): format PNG aman untuk semua
    // crawler/rich result — SVG belum tentu diterima, dan file ini sudah
    // di-generate tiap build (bukan asset tambahan).
    logo: { "@type": "ImageObject", url: `${base}/og-image.png`, width: 1200, height: 630 },
    sameAs: [
      "https://github.com/startupmini/minicode",
      "https://www.npmjs.com/package/minicode-ai",
    ],
  }
}

export function breadcrumbJsonld(
  base: string,
  trail: { name: string; item?: string }[],
): Record<string, unknown> {
  const items = [
    { "@type": "ListItem", position: 1, name: "Beranda", item: `${base}/` },
    ...trail.map((t, i) => ({ "@type": "ListItem", position: i + 2, ...t })),
  ]
  delete items[items.length - 1]!.item
  return { "@type": "BreadcrumbList", itemListElement: items }
}
