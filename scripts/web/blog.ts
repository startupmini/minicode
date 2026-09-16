// Bangun blog: index + per-artikel + rss.xml dari content/blog/*.md.
// File berprefix _ di-skip sebagai draf. Bahasa Indonesia (lang id di RSS).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { escAttr, firstPara, parseFrontmatter } from "./fm.ts"
import { escHtml, mdToHtml } from "./md.ts"
import { mdLinksToHtml, renderPage, softwareJsonld } from "./page.ts"

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
  })
  const rows = posts
    .map(
      (p) =>
        // Judul/desc/tags dari frontmatter (teks penulis) di-escape: tanpa
        // ini `<` di judul (mis. "a < b") merusak halaman (audit website).
        `<a class="post-row" href="/blog/${p.slug}.html">` +
        `<div class="post-date">${escHtml(p.fm.date || "")}</div><h3>${escHtml(p.fm.title)}</h3><p>${escHtml(p.desc)}</p>` +
        (p.fm.tags.length
          ? `<div class="tags">${p.fm.tags.map((t) => `<span>${escHtml(t)}</span>`).join("")}</div>`
          : "") +
        `</a>`,
    )
    .join("")
  const list =
    `<div class="blog">` +
    `<div class="kicker">Blog</div>` +
    `<h1>Catatan dunia AI.</h1>` +
    `<p class="sub">Ditulis Indonesia. Update via <code>content/blog/*.md</code> atau ` +
    `<a href="/admin.html">admin</a>. Ikuti via <a href="/rss.xml">RSS</a>.</p>` +
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
      `<article class="article"><div class="post-date">${escHtml(p.fm.date || "")}</div><h1>${escHtml(p.fm.title)}</h1>` +
      `<p class="lede">${escHtml(p.desc)}</p>` +
      (p.fm.tags.length
        ? `<div class="tags">${p.fm.tags.map((t) => `<span>${escHtml(t)}</span>`).join("")}</div>`
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
      return (
        `<item><title>${escAttr(p.fm.title)}</title><link>${base}/blog/${p.slug}.html</link>` +
        `<guid>${base}/blog/${p.slug}.html</guid>` +
        pub +
        `<description>${escAttr(p.desc)}</description></item>`
      )
    })
    .join("")
  writeFileSync(
    join(siteDir, "rss.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>` +
      `<title>Minicode Blog</title><link>${base}/blog/</link>` +
      `<description>Catatan dunia AI — Indonesia.</description><language>id</language>${items}</channel></rss>`,
    "utf8",
  )
  return urls
}
