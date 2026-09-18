// Checker web: link internal + kelengkapan sidebar + anti-bocor rahasia.
// Dijalankan setelah `bun run web:build` — baca hasil di site/, bukan sumber.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..")
const siteDir = join(repoRoot, "site")

let fail = 0
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok    ${name}`)
  else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function allHtml(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) allHtml(p, out)
    else if (f.endsWith(".html")) out.push(p)
  }
  return out
}

if (!statSync(siteDir, { throwIfNoEntry: false })) {
  console.error("[web-check] site/ belum ada — jalankan `bun run web:build` dulu")
  process.exit(1)
}
const files = allHtml(siteDir)
check("ada halaman HTML", files.length >= 18, `${files.length} file`)
const rel = new Set(files.map((f) => f.slice(siteDir.length).replaceAll("\\", "/")))
// Aset statis yang juga di-copy ke site/ (bukan HTML) — link ke sini valid.
// og-image.png diharapkan dari rasterisasi build; bila build dijalankan di
// env tanpa resvg, PNG absen = peringatan khusus di bawah (bukan link check).
for (const a of [
  "styles.css",
  "app.js",
  "rss.xml",
  "assets/logo-user.svg",
  "og-image.svg",
  "og-image.png",
]) {
  rel.add(`/${a}`)
}
const need = [
  "/index.html",
  "/docs/index.html",
  "/docs/tools.html",
  "/blog/index.html",
  "/admin.html",
  "/404.html",
]
for (const n of need) check(`rute ${n} ada`, rel.has(n))

// Link internal harus resolve ke file site/.
const missing: string[] = []
for (const f of files) {
  const src = readFileSync(f, "utf8")
  for (const m of src.matchAll(/href="(\/[^"#?"]+)"/g)) {
    let target = m[1]!
    if (/^\/$/.test(target)) target = "/index.html"
    else if (target.endsWith("/")) target = `${target}index.html`
    if (!rel.has(target) && !rel.has(`${target}.html`))
      missing.push(`${f.slice(siteDir.length)} -> ${m[1]}`)
  }
}
check(
  `link internal utuh (${files.length} halaman)`,
  missing.length === 0,
  missing.slice(0, 5).join("; "),
)

// Anchor #fragment harus resolve ke id di halaman yang sama atau target
// (audit website FIX#7: heading tanpa id membuat deep-link mustahil).
const idOf = (src: string): Set<string> =>
  new Set([...src.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!))
const byRel = new Map<string, string>()
for (const f of files) {
  byRel.set(f.slice(siteDir.length).replaceAll("\\", "/"), readFileSync(f, "utf8"))
}
const badAnchor: string[] = []
for (const [relPath, src] of byRel) {
  for (const m of src.matchAll(/href="([^"]*)"/g)) {
    const href = m[1]!
    const hash = href.indexOf("#")
    if (hash === -1) continue
    const frag = href.slice(hash + 1)
    if (!frag) continue // href="#" pelengkap, bukan tautan section
    let target = href.slice(0, hash)
    if (!target) target = relPath
    else if (!target.startsWith("/"))
      continue // relatif/eksternal di luar kontrak
    else if (target === "/") target = "/index.html"
    else if (target.endsWith("/")) target = `${target}index.html`
    // /docs/x -> /docs/x.html (pola sama seperti cek link).
    const candidates = [target, `${target}.html`]
    const found = candidates.find((c) => byRel.has(c))
    if (!found) continue // berkas hilang sudah dilaporkan cek link
    if (!idOf(byRel.get(found)!).has(decodeURIComponent(frag))) {
      badAnchor.push(`${relPath} -> ${href}`)
    }
  }
}
check(
  `anchor #fragment resolve (${files.length} halaman)`,
  badAnchor.length === 0,
  badAnchor.slice(0, 5).join("; "),
)
const SECRET = [
  /sk-[A-Za-z0-9]{8,}/,
  /ghp_[A-Za-z0-9]+/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /xox[bpas]-/,
  /AKIA[0-9A-Z]{16}/,
]
const leaks: string[] = []
for (const f of files) {
  // Scan konten, bukan atribut navigasi (audit docs 2026-09-18: id heading
  // dari kata "risiko-disengaja" false-positive pola sk-...). Teks nyata
  // yang membawa rahasia tetap tertangkap — id/href bukan tempat rahasia.
  const src = readFileSync(f, "utf8").replace(/\s(?:id|href)="[^"]*"/g, "")
  for (const re of SECRET) if (re.test(src)) leaks.push(`${f.slice(siteDir.length)}: ${re}`)
}
check("tanpa pola rahasia di site/", leaks.length === 0, leaks.slice(0, 3).join("; "))

// SEO: tiap halaman konten punya title + description + canonical.
const noSeo: string[] = []
for (const f of files) {
  if (f.endsWith("admin.html") || f.endsWith("404.html")) continue
  const src = readFileSync(f, "utf8")
  if (
    !/<title>[^<]{8,}<\/title>/.test(src) ||
    !/name="description" content="[^"]{20,}"/.test(src) ||
    !/rel="canonical"/.test(src)
  ) {
    noSeo.push(f.slice(siteDir.length))
  }
}
check("SEO tags lengkap", noSeo.length === 0, noSeo.slice(0, 5).join(", "))

// Title > ~65 char terpotong di SERP (audit SEO 2026-09-18: 3 judul post
// 72–77 char). Sufiks " — Minicode" (9) dihitung karena selalu ada di <title>.
const longTitle: string[] = []
for (const f of files) {
  if (f.endsWith("admin.html") || f.endsWith("404.html")) continue
  const m = /<title>([^<]*)<\/title>/.exec(readFileSync(f, "utf8"))
  if (m && m[1]!.length > 65) longTitle.push(`${f.slice(siteDir.length)} (${m[1]!.length})`)
}
check("title <= 65 char", longTitle.length === 0, longTitle.slice(0, 5).join(", "))

// Sitemap mencakup semua halaman konten (kecuali admin/404).
const sm = readFileSync(join(siteDir, "sitemap.xml"), "utf8")
const smMiss = files
  .filter((f) => !/admin\.html|404\.html/.test(f))
  .map((f) =>
    f
      .slice(siteDir.length)
      .replaceAll("\\", "/")
      .replace(/\/index\.html$/, "/")
      .replace(/^\//, ""),
  )
  .filter((p) => !sm.includes(p))
check("sitemap lengkap", smMiss.length === 0, smMiss.slice(0, 5).join(", "))

// Integritas URL di artefak non-HTML (audit 2026-09-18: ](../PLAN.md) lolos
// mapper → 404 di konteks /llms-full.txt). Semua URL absolut minicode.fun di
// llms.txt / llms-full.txt / rss.xml wajib menunjuk file site/ yang ada —
// link mati di artefak ini = janji bohong ke crawler & agent AI.
const nonHtml: string[] = []
for (const t of ["llms.txt", "llms-full.txt", "rss.xml"]) {
  const raw = readFileSync(join(siteDir, t), "utf8")
  for (const m of raw.matchAll(/https:\/\/minicode\.fun[^)"<>\s]*/g)) {
    nonHtml.push(m[0]!.replace(/[.,;:!?]+$/, ""))
  }
}
const badUrl: string[] = []
for (const raw of new Set(nonHtml)) {
  let path: string
  try {
    const u = new URL(raw)
    if (u.host !== "minicode.fun") throw new Error("host asing")
    path = u.pathname
  } catch {
    badUrl.push(raw)
    continue
  }
  const target = path === "/" ? "/index.html" : path.endsWith("/") ? `${path}index.html` : path
  if (!rel.has(target) && !rel.has(`${target}.html`)) badUrl.push(raw)
}
check(
  `URL artefak non-HTML valid (${nonHtml.length} kemunculan)`,
  badUrl.length === 0,
  badUrl.slice(0, 5).join("; "),
)

console.log(fail === 0 ? "[web-check] lolos" : `[web-check] ${fail} gagal`)
process.exit(fail === 0 ? 0 : 1)
