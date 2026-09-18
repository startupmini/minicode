// SSG web minicode (orkestrator tipis).
// Alur: landing + docs + blog -> site/ + sitemap + robots + 404 + aset.
// Tanpa dependensi: hanya node:fs/path. Output site/ di-gitignore.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { blogLastmod, buildBlog } from "./web/blog.ts"
import { buildChangelog, buildDocs } from "./web/docs.ts"
import { landingHero, landingHow, landingTasks } from "./web/landing1.ts"
import {
  faqPageJsonld,
  landingFaq,
  landingFeatures,
  landingFit,
  landingSafety,
} from "./web/landing2.ts"
import { buildLlmsTxt } from "./web/llms.ts"
import { buildLlmsFullTxt } from "./web/llms-full.ts"
import { renderPage, softwareJsonld } from "./web/page.ts"

const repoRoot = join(import.meta.dir, "..")
const webDir = join(repoRoot, "web")
const siteDir = join(repoRoot, "site")
// Domain custom produksi. Mengapa konstanta, bukan argumen: canonical,
// sitemap, robots, dan RSS harus satu sumber agar tidak divergen diam-diam.
const base = "https://minicode.fun"
const customDomain = "minicode.fun"

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  version: string
  repository: { url: string }
}
const version = pkg.version
// Identitas target commit admin ({{GITHUB_*}}): dari repository.url package.json
// — satu sumber identitas (dijaga test FIX#4), jadi rename repo tidak merusak
// Publish diam-diam. Branch = trigger deploy web.yml (hanya push main).
const gh = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(pkg.repository.url)
if (!gh) throw new Error(`[web-build] repository.url tak bisa diparse: ${pkg.repository.url}`)
const ghRepo = `${gh[1]}/${gh[2]}`
const ghBranch = "main"

// Bersihkan site/ dulu: aset lama (favorit lama, logo lama) tidak boleh
// tertinggal dan membuat tautan mati di halaman baru.
rmSync(siteDir, { recursive: true, force: true })

function write(rel: string, content: string): void {
  const dest = join(siteDir, rel)
  mkdirSync(join(dest, ".."), { recursive: true })
  writeFileSync(dest, content, "utf8")
}

// Dua section yang dipertukarkan eksperimen A/B dibungkus `.pair`: keduanya
// memang bersebelahan, jadi pembungkus ini satu-satunya perubahan struktur
// yang dibutuhkan CSS `order` (tanpa memindahkan DOM — lihat part-04).
const landing =
  landingHero(version) +
  `<div class="pair">${landingHow()}${landingTasks()}</div>` +
  landingFeatures() +
  landingFit() +
  landingSafety() +
  landingFaq()
write(
  "index.html",
  renderPage(webDir, {
    title: "Coding agent CLI yang menunjukkan semua kerjanya",
    desc: "Minicode — coding agent CLI open source untuk terminal: tiap langkah terlihat di scrollback, tiap aksi sensitif lewat izin Anda. MIT, zero-dep, Bun.",
    canon: `${base}/`,
    body: landing,
    // body.home: penanda landing — eksperimen urutan A/B (`body.home main`
    // jadi flex column + `order`) hanya boleh menyentuh halaman ini.
    bodyClass: "home",
    version,
    // FAQPage + SoftwareApplication dalam satu @graph: jawaban FAQ = konten
    // yang paling sering dikutip AI-assistant & rich result Google (riset
    // discoverability 2026-09-17).
    jsonld: JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [JSON.parse(softwareJsonld(version)), JSON.parse(faqPageJsonld(base))],
    }).replaceAll("</", "<\\/"),
  }),
)
const urls = [
  `${base}/`,
  buildChangelog(repoRoot, webDir, base, version, write),
  ...buildDocs(repoRoot, webDir, base, version, write),
  ...buildBlog(repoRoot, webDir, siteDir, base, version, write),
]
// Tanggal lastmod sitemap: post blog dari frontmatter, lainnya stempel build.
const blogLastmods = blogLastmod(repoRoot, base)
const buildStamp = new Date().toISOString().slice(0, 10)

write("llms.txt", buildLlmsTxt(repoRoot, base, version))
write("llms-full.txt", buildLlmsFullTxt(repoRoot, base, version))
// IndexNow (Bing/Yandex/Seznam — ping sitemap sudah mati): protokol mensyaratkan
// GET /<key>.txt mengembalikan isi key. Key BUKAN rahasia — publik by design;
// yang dibuktikan adalah kontrol atas host. Satu sumber: web/indexnow-key.txt.
const indexNowKey = readFileSync(join(webDir, "indexnow-key.txt"), "utf8").trim()
write(`${indexNowKey}.txt`, indexNowKey)
write(
  "robots.txt",
  // AI-crawler eksplisit (riset discoverability 2026-09-17): semua di-ALLOW.
  // `User-agent: *` saja cukup secara mekanis, tapi sektor eksplisit membuat
  // kebijakan situs terbaca sendiri oleh tiap bot — dan jadi tempat
  // dokumentasi bila suatu hari ada crawler yang mau diblokir.
  [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin.html",
    "",
    "# AI crawlers — dokumentasi minicode.fun bebas dibaca & dikutip",
    ...[
      "GPTBot",
      "OAI-SearchBot",
      "ChatGPT-User",
      "ClaudeBot",
      "Claude-SearchBot",
      "Claude-User",
      "PerplexityBot",
      "Perplexity-User",
      "Google-Extended",
      "Applebot-Extended",
      "Bytespider",
      "CCBot",
      "meta-externalagent",
      "Amazonbot",
    ].map((ua) => `User-agent: ${ua}\nAllow: /\nDisallow: /admin.html`),
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
    "# Peta markdown untuk AI/agent: llms.txt (indeks) & llms-full.txt (korpus penuh)",
    `# IndexNow: kirim URL ke api.indexnow.org/indexnow dgn key ${indexNowKey}`,
  ].join("\n") + "\n",
)
write(
  "sitemap.xml",
  // <lastmod> (format W3CDate YYYY-MM-DD, protokol sitemap 0.9): sinyal
  // kesegaran utk crawler. Post blog = tanggal frontmatter (sumber sama dgn
  // buildBlog via blogLastmod); halaman lain = waktu build — kontennya
  // statis antar-build, jadi berubah hanya saat build baru mendeploy.
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    [...new Set(urls)]
      .sort()
      .map((u) => {
        const lastmod = blogLastmods.get(u) ?? buildStamp
        return `<url><loc>${u}</loc><lastmod>${lastmod}</lastmod></url>`
      })
      .join("") +
    `</urlset>`,
)
write(
  "404.html",
  renderPage(webDir, {
    title: "Tidak ketemu",
    desc: "Halaman tidak ditemukan di minicode.fun — buka dokumentasi atau blog untuk melanjutkan.",
    canon: `${base}/404.html`,
    body: `<div class="wrap" style="padding:90px 24px;max-width:600px"><div class="kicker">404</div><h1 style="font-size:clamp(24px,3.5vw,34px)">Halaman tidak ketemu.</h1><p class="sub" style="margin-top:14px">Coba <a href="/docs/">dokumentasi</a> atau <a href="/blog/">blog</a>.</p></div>`,
    version,
    jsonld: softwareJsonld(version),
  }),
)
for (const f of ["styles.css", "app.js"]) {
  write(f, readFileSync(join(webDir, f), "utf8"))
}
// Logo milik pengguna: satu sumber di content/logo-user.svg (mudah diganti),
// di-copy saat build agar layout <img> selalu merujuk file yang ada.
cpSync(join(repoRoot, "content", "logo-user.svg"), join(siteDir, "assets", "logo-user.svg"))
// Kartu sosial untuk og:image: PNG hasil rasterisasi (crawler sosial umumnya
// tak merender SVG — audit web P2-10), SVG tetap di-copy sebagai fallback.
cpSync(join(webDir, "og-image.svg"), join(siteDir, "og-image.svg"))
const { rasterizeOg } = await import("./rasterize-og.ts")
await rasterizeOg(webDir, siteDir)
// admin: repo/branch target diinjeksi (gh*/ghBranch di atas).
write(
  "admin.html",
  readFileSync(join(webDir, "admin.html"), "utf8")
    .replaceAll("{{GITHUB_REPO}}", ghRepo)
    .replaceAll("{{GITHUB_BRANCH}}", ghBranch),
)
// File CNAME membuat binding custom domain persisten — deploy artifact
// tanpa file ini bisa melepas domain di Settings → Pages.
write("CNAME", `${customDomain}\n`)
write(".nojekyll", "")
console.log(`[web-build] ${urls.length} halaman -> site/`)
