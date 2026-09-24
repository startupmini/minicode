// Bangun blog: index + per-artikel + rss.xml dari content/blog/*.md.
// File berprefix _ di-skip sebagai draf. Bahasa Indonesia (lang id di RSS).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { escAttr, firstPara, parseFrontmatter } from "./fm.ts"
import { escHtml, mdToHtml } from "./md.ts"
import { breadcrumbJsonld, mdLinksToHtml, renderPage, softwareJsonld } from "./page.ts"

// Diekspor untuk test (guard adversarial): timeZone UTC wajib — tanpa itu
// tanggal UTC-tengah-malam tampil mundur sehari di mesin build ber-TZ negatif.
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

// Satu sumber slug (buildBlog & blogLastmod): "2026-09-17-judul.md" -> "judul".
const slugOf = (file: string): string =>
  file.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "")

// Peta URL post -> tanggal frontmatter, untuk <lastmod> sitemap. Sumber sama
// dgn buildBlog (parseFrontmatter) supaya tanggal di halaman & sitemap tak
// bisa divergen; post tanpa tanggal valid tidak ikut (sitemap builder pakai
// fallback waktu build utk URL tanpa tanggal).
export function blogLastmod(repoRoot: string, base: string): Map<string, string> {
  const dir = join(repoRoot, "content", "blog")
  const out = new Map<string, string>()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") || f.startsWith("_")) continue
    const fm = parseFrontmatter(readFileSync(join(dir, f), "utf8"), f.replace(/\.md$/, ""))
    if (Number.isFinite(Date.parse(fm.date))) out.set(`${base}/blog/${slugOf(f)}.html`, fm.date)
  }
  return out
}

// Pemilihan "Postingan terkait" untuk permalink (audit SEO 2026-09-18:
// post hanya punya 1 inbound — dari index). Utamakan post ber-tag sama;
// bila kurang, isi dengan post terbaru lain agar blok tak pernah kosong
// (post ber-tag unik seperti rename-paket dulu tanpa blok). Max 3 supaya
// daftar tak membengkak — bukan pengganti curation: saat post >12, ganti
// ke sambungan manual/semantik. Murni & diekspor agar bisa diuji.
// Urutan ambil: dari DEPAN gabungan [shared, fill] — slice(-max) lama mengambil
// kandidat paling tua dan membuang post tag-share paling relevan begitu
// kandidat >3 (terbukti di produksi 2026-09-18: post baru tak muncul di blok
// post serumpun).
export function relatedPosts<T extends { slug: string; fm: { tags: string[] } }>(
  posts: T[],
  slug: string,
  max = 3,
): T[] {
  const self = posts.find((p) => p.slug === slug)
  const others = posts.filter((r) => r.slug !== slug)
  const shared = others.filter((r) => self && r.fm.tags.some((t) => self.fm.tags.includes(t)))
  const fill = others.filter((r) => !shared.includes(r))
  return [...shared, ...fill].slice(0, max)
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
    const slug = slugOf(f)
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
      desc: "Blog coding agent CLI Minicode: catatan LLM, tooling terminal, dan praktik AI coding — dari tim pengembangnya.",
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
      `${html}${
        // Blok "Postingan terkait" (audit SEO 2026-09-18: post hanya punya 1
        // inbound link — dari index; discovery antar-post & sinyal topikal
        // lemah). Aturan sederhana satu-pemilik: tag diurutkan alfabetis,
        // arah lama→baru (pelengkap arah RSS yang baru→lama); max 3 agar
        // daftar tak membengkak. BUKAN pengganti curation: saat jumlah post
        // tumbuh (>12), ganti ke sambungan manual/semantik.
        // Blok "Postingan terkait" (lihat relatedPosts): tag-share dulu,
        // sisanya post terbaru — blok hidup untuk semua post.
        (() => {
          const related = relatedPosts(posts, p.slug)
          return related.length
            ? `<section class="related"><h2>Postingan terkait</h2><ul>${related
                .map((r) => `<li><a href="/blog/${r.slug}.html">${escHtml(r.fm.title)}</a></li>`)
                .join("")}</ul></section>`
            : ""
        })()
      }<p style="margin-top:40px"><a href="/blog/">← Semua artikel</a></p></article>`
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
          "@graph": [
            breadcrumbJsonld(base, [{ name: "Blog", item: `${base}/blog/` }, { name: p.fm.title }]),
            {
              "@type": "Article",
              headline: p.fm.title,
              datePublished: p.fm.date,
              // Pelengkap audit SEO 2026-09-18: author & inLanguage — sinyal
              // keaslian & bahasa yang sebelumnya absen di schema post.
              // Audit STRUCT-01 (2026-09-24) melengkapi field wajib Article:
              // dateModified = tanggal terbit (frontmatter tak punya field
              // "modified"; memakai tanggal terbit jujur lebih baik daripada
              // mengarang), image = og-image ≥1200px, mainEntityOfPage =
              // kanonik post, publisher = entitas brand di halaman post.
              dateModified: p.fm.date,
              image: `${base}/og-image.png`,
              mainEntityOfPage: `${base}/blog/${p.slug}.html`,
              author: { "@type": "Organization", name: "Minicode", url: `${base}/` },
              publisher: {
                "@type": "Organization",
                name: "Minicode",
                logo: {
                  "@type": "ImageObject",
                  url: `${base}/og-image.png`,
                  width: 1200,
                  height: 630,
                },
              },
              inLanguage: "id-ID",
            },
            // Sama seperti softwareJsonld: `</` di-escape agar string tak bisa
            // menutup tag script (`</script>` di judul = breakout).
          ],
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
      `<description>Blog coding agent CLI Minicode: catatan LLM, tooling terminal, dan praktik AI coding.</description><language>id-ID</language>` +
      `<lastBuildDate>${escAttr(new Date().toUTCString())}</lastBuildDate>${items}</channel></rss>`,
    "utf8",
  )
  return urls
}
