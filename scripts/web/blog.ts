// Bangun blog: index + per-artikel + rss.xml dari content/blog/*.md.
// File berprefix _ di-skip sebagai draf. Bahasa Indonesia (lang id di RSS).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { escAttr, firstPara, parseFrontmatter } from "./fm.ts"
import { escHtml, mdToHtml } from "./md.ts"
import { mdLinksToHtml, renderPage, softwareJsonld } from "./page.ts"

// Formatter tanggal tampil — diekspor untuk test (pola repo: pure/diekspor-
// untuk-test). Guard adversarial (d): timeZone UTC wajib — dulu tanpa itu,
// "2026-01-05" (UTC tengah malam) tampil "4 Jan" di mesin build ber-TZ negatif.
export const blogDateFmt = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})
export function formatBlogDate(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? blogDateFmt.format(new Date(ms)) : iso
}

export function buildBlog(
  repoRoot: string,
  webDir: string,
  siteDir: string,
  base: string,
  version: string,
  write: (rel: string, html: string) => void,
): string[] {
  const dir = join(repoRoot, "content", "blog")
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
        .sort()
        .reverse()
    : []
  const posts = files.map((f) => {
    const raw = readFileSync(join(dir, f), "utf8")
    const fm = parseFrontmatter(raw, f.replace(/\.md$/, ""))
    const slug = f.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "")
    return { slug, fm, desc: fm.desc || firstPara(fm.body).slice(0, 160) }
  }) // Tanggal tampil: formatBlogDate (module scope, UTC — lihat komentar di
  // atas). Tanggal rusak → tampil mentah tanpa <time> (sama seperti pubDate).
  const rows = posts
    .map(
      (p) =>
        // Judul/desc/tags dari frontmatter (teks penulis) di-escape: tanpa
        // ini `<` di judul (mis. "a < b") merusak halaman (audit website).
        // Tags sebagai teks dipisah koma (pola `·` antar-span dibuang —
        // dekoratif, koma lebih jelas). Esc tetap escHtml per tag.
        // Judul pakai h2: hirarki benar di bawah h1 halaman (dulu h3 lompat).
        // <time datetime=ISO> untuk mesin; display sudah format id-ID.
        `<a class="post-row" href="/blog/${p.slug}.html">` +
        `<div class="post-date">${
          Number.isFinite(Date.parse(p.fm.date))
            ? `<time datetime="${escAttr(p.fm.date)}">${escHtml(formatBlogDate(p.fm.date))}</time>`
            : escHtml(p.fm.date || "")
        }</div><h2>${escHtml(p.fm.title)}</h2><p>${escHtml(p.desc)}</p>` +
        (p.fm.tags.length
          ? `<div class="tags">${p.fm.tags.map((t) => escHtml(t)).join(", ")}</div>`
          : "") +
        `</a>`,
    )
    .join("")
  const list =
    `<div class="blog">` +
    // Tanpa kicker "Blog" di atas h1 (label yatim — konteks sudah jelas dari
    // nav); judul menyebut nama, sub menjelaskan isi + cara mengikuti.
    `<h1>Blog Minicode.</h1>` +
    `<p class="sub">Tulisan pendek soal coding agent yang bekerja di terminal. ` +
    `Ikuti via <a href="/rss.xml">RSS</a>.</p>` +
    `<div class="post-list">${rows || "<p>Belum ada artikel.</p>"}</div></div>`
  write(
    "blog/index.html",
    renderPage(webDir, {
      title: "Blog",
      desc: "Catatan dunia AI dari tim Minicode — Indonesia.",
      canon: `${base}/blog/`,
      body: list,
      version,
      jsonld: softwareJsonld(version),
    }),
  )
  const urls = [`${base}/blog/`]
  for (const p of posts) {
    const html = mdLinksToHtml(mdToHtml(p.fm.body))
    const body =
      `<article class="article"><div class="post-date">${
        Number.isFinite(Date.parse(p.fm.date))
          ? `<time datetime="${escAttr(p.fm.date)}">${escHtml(formatBlogDate(p.fm.date))}</time>`
          : escHtml(p.fm.date || "")
      }</div><h1>${escHtml(p.fm.title)}</h1>` +
      `<p class="lede">${escHtml(p.desc)}</p>` +
      (p.fm.tags.length
        ? `<div class="tags">${p.fm.tags.map((t) => escHtml(t)).join(", ")}</div>`
        : "") +
      `${html}<p style="margin-top:40px"><a href="/blog/">← Semua artikel</a></p></article>`
    write(
      `blog/${p.slug}.html`,
      renderPage(webDir, {
        title: p.fm.title,
        desc: p.desc,
        canon: `${base}/blog/${p.slug}.html`,
        body,
        ogType: "article",
        version,
        jsonld: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Article",
          headline: p.fm.title,
          datePublished: p.fm.date,
          // Sama seperti softwareJsonld: `</` di-escape agar string tak bisa
          // menutup tag script (`</script>` di judul = breakout).
        }).replaceAll("</", "<\\/"),
      }),
    )
    urls.push(`${base}/blog/${p.slug}.html`)
  }
  const items = posts
    .map((p) => {
      // Tanggal rusak → hilangkan pubDate (bukan "Invalid Date" ke RSS).
      const ms = Date.parse(p.fm.date)
      const pub = Number.isFinite(ms)
        ? `<pubDate>${escAttr(new Date(ms).toUTCString())}</pubDate>`
        : ""
      // URL juga di-escape (audit web P0-2): slug saat ini memang buang `&`,
      // tapi `base`/slug masa depan tak boleh menggantung pada kebetulan itu —
      // `&` mentah di XML = feed gagal parse total di reader ketat.
      const link = escAttr(`${base}/blog/${p.slug}.html`)
      return (
        `<item><title>${escAttr(p.fm.title)}</title><link>${link}</link>` +
        `<guid>${link}</guid>` +
        pub +
        `<description>${escAttr(p.desc)}</description></item>`
      )
    })
    .join("")
  // lastBuildDate: reader butuh ini untuk tahu kapan feed berubah (guid saja
  // tidak semua reader pakai). Locale tag: id-ID, bukan `id` (audit web P0-2).
  writeFileSync(
    join(siteDir, "rss.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>` +
      `<title>Minicode Blog</title><link>${escAttr(`${base}/blog/`)}</link>` +
      `<description>Catatan dunia AI — Indonesia.</description><language>id-ID</language>` +
      `<lastBuildDate>${escAttr(new Date().toUTCString())}</lastBuildDate>${items}</channel></rss>`,
    "utf8",
  )
  return urls
}
