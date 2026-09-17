// SSG web minicode (orkestrator tipis).
// Alur: landing + docs + blog -> site/ + sitemap + robots + 404 + aset.
// Tanpa dependensi: hanya node:fs/path. Output site/ di-gitignore.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildBlog } from "./web/blog.ts"
import { buildDocs } from "./web/docs.ts"
import { landingHero, landingHow, landingWhy } from "./web/landing1.ts"
import { landingFaq, landingFeatures, landingFit, landingSafety } from "./web/landing2.ts"
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

const landing =
  landingHero(version) +
  landingHow() +
  landingWhy() +
  landingFeatures() +
  landingFit() +
  landingSafety() +
  landingFaq()
write(
  "index.html",
  renderPage(webDir, {
    title: "Coding agent CLI yang menunjukkan semua kerjanya",
    desc: "Minicode untuk developer terminal: tiap langkah terlihat di scrollback, tiap aksi sensitif lewat izin Anda. MIT, zero-dep, Bun.",
    canon: `${base}/`,
    body: landing,
    version,
    jsonld: softwareJsonld(version),
  }),
)
const urls = [
  `${base}/`,
  ...buildDocs(repoRoot, webDir, base, version, write),
  ...buildBlog(repoRoot, webDir, siteDir, base, version, write),
]

write(
  "robots.txt",
  `User-agent: *\nAllow: /\nDisallow: /admin.html\nSitemap: ${base}/sitemap.xml\n`,
)
write(
  "sitemap.xml",
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    [...new Set(urls)]
      .sort()
      .map((u) => `<url><loc>${u}</loc></url>`)
      .join("") +
    `</urlset>`,
)
write(
  "404.html",
  renderPage(webDir, {
    title: "Tidak ketemu",
    desc: "Halaman tidak ditemukan.",
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
// Token {{GITHUB_*}} diisi saat copy: admin tanpa hardcode repo/branch —
// ganti repo atau branch deploy cukup di satu tempat (package.json/konstanta).
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
