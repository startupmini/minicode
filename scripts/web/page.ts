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

/** Tautan antar-docs ditulis *.md di sumber — petakan ke rute HTML. */
export function mdLinksToHtml(html: string): string {
  return html.replace(/href="([a-z0-9-]+\.md)(#[^"]*)?"/g, (_, f: string, h: string) => {
    const slug = String(f).replace(/\.md$/, "").toLowerCase()
    const dest = slug === "readme" ? "/docs/" : `/docs/${slug}.html`
    return `href="${dest}${h ?? ""}"`
  })
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
