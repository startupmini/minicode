// Test SSG web: jaga link internal + anti-bocor + kelengkapan sidebar.
// Mengapa ada: satu-satunya penjaga agar edit docs/SUMMARY.md atau layout
// yang typo langsung gagal di `bun test`, bukan setelah deploy Pages.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { blogDateFmt, buildBlog, formatBlogDate } from "../scripts/web/blog.ts"
import { parsePlanStatus } from "../scripts/web/changelog.ts"
import { renderDocGrid, renderDocHead, renderDocNav, stripMdSection } from "../scripts/web/docs.ts"
import { parseFrontmatter } from "../scripts/web/fm.ts"
import { mdToHtml } from "../scripts/web/md.ts"
import { readDocNav } from "../scripts/web/nav.ts"
import { breadcrumbJsonld, softwareJsonld } from "../scripts/web/page.ts"
import { isPathWithinSite } from "../scripts/web-serve.ts"

const repoRoot = join(import.meta.dir, "..")

describe("web ssg", () => {
  test("SUMMARY semua file ada", () => {
    const entries = readDocNav(repoRoot)
    expect(entries.length).toBeGreaterThanOrEqual(16)
    for (const e of entries) {
      expect(existsSync(join(repoRoot, "docs", e.file))).toBe(true)
    }
  })

  test("template layout punya slot wajib + tanpa border", () => {
    const layout = readFileSync(join(repoRoot, "web", "layout.html"), "utf8")
    for (const slot of ["{{TITLE}}", "{{DESC}}", "{{CANON}}", "{{CONTENT}}", "{{JSONLD}}"]) {
      expect(layout.includes(slot)).toBe(true)
    }
    // Aturan flat: tidak ada `border:` di CSS gabungan.
    const css = readFileSync(join(repoRoot, "web", "styles.css"), "utf8")
    expect(/border\s*:/.test(css)).toBe(false)
    // Logo: pakai logo milik pengguna, tanpa sisa mark/aneka logo lama.
    expect(layout).toContain("logo-user.svg")
    expect(layout).not.toContain("brand-mark")
    expect(layout).not.toContain("favicon.svg")
  })

  test("blog frontmatter valid", () => {
    const dir = join(repoRoot, "content", "blog")
    const files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    expect(files.length).toBeGreaterThanOrEqual(2)
    for (const f of files) {
      const fm = parseFrontmatter(readFileSync(join(dir, f), "utf8"), f)
      expect(fm.title.length).toBeGreaterThan(8)
      expect(fm.desc.length).toBeGreaterThanOrEqual(20)
      expect(/^\d{4}-\d{2}-\d{2}/.test(f)).toBe(true)
    }
  })

  test("md renderer escape fence + tabel", () => {
    const html = mdToHtml(
      "# H\n\n```js\n<script>x</script>\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
    )
    expect(html.includes('id="h"')).toBe(true)
    expect(html.includes(">H</h1>")).toBe(true)
    expect(html.includes("&lt;script&gt;")).toBe(true)
    expect(html.includes("<table")).toBe(true)
  })

  test("ordered list dirender <ol> (audit web P1-3)", () => {
    // Gagal di kode lama: `1. langkah` jatuh ke <p> — docs prosedural kehilangan
    // semantik list (screen reader membacanya sebagai kalimat).
    const html = mdToHtml("Intro.\n\n1. Satu\n2. Dua\n3. Tiga\n\n- bullet\n")
    expect(html).toContain("<ol>\n<li>Satu</li>\n<li>Dua</li>\n<li>Tiga</li>\n</ol>")
    expect(html).toContain("<ul>\n<li>bullet</li>\n</ul>")
    expect(html).not.toContain("<p>1.")
    // Anti-regresi: pola nomor di dalam code span/prosa tetap aman.
    const plain = mdToHtml("`1. bukan list`")
    expect(plain).toContain('<code translate="no">')
  })

  test("ellipsis: prose `...` jadi `…`, atribut & code span tak tersentuh (audit web)", () => {
    // Regresi untuk konversi text-node-only: href dengan `...` wajib utuh.
    const html = mdToHtml("Baca [docs](https://x.example/a...b) lanjut... `tunggu...`\n")
    expect(html).toContain('href="https://x.example/a...b"')
    expect(html).toContain("lanjut…")
    expect(html).toContain('<code translate="no">tunggu...</code>')
  })

  test("RSS: & di URL ter-escape + lastBuildDate ada (audit web P0-2)", async () => {
    // Gagal di kode lama: <link> XML menyuntik `&` mentah — feed gagal parse
    // di reader ketat begitu URL mengandung entity.
    const root = mkdtempSync(join(tmpdir(), "mc-web-"))
    try {
      const blogDir = join(root, "content", "blog")
      mkdirSync(blogDir, { recursive: true })
      writeFileSync(
        join(blogDir, "2026-01-04-amp.md"),
        '---\ntitle: "A & B test"\ndate: 2026-01-04\ntags: []\ndesc: "D & E"\n---\n\nIsi.\n',
        "utf8",
      )
      const { buildBlog } = await import("../scripts/web/blog.ts")
      buildBlog(root, join(repoRoot, "web"), root, "https://x.example", "0.0.0", () => {})
      const rss = readFileSync(join(root, "rss.xml"), "utf8")
      expect(rss).toContain("A &amp; B test")
      expect(rss).toContain("lastBuildDate")
      expect(rss).toContain("id-ID")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("admin: token tak dipersist + publish terkunci saat request (audit web P0-1)", () => {
    const admin = readFileSync(join(repoRoot, "web", "admin.html"), "utf8")
    // Regresi P0-1: token GitHub dulu disimpan ke sessionStorage + diinjeksi
    // balik ke input — XSS/ekstensi cukup membaca storage.
    expect(admin).not.toContain("sessionStorage.getItem")
    expect(admin).not.toContain("sessionStorage.setItem")
    expect(admin).not.toContain("mc-token")
    expect(admin).toContain('autocomplete="new-password"')
    // Publish disabled + label berubah selama fetch (dobel-klik = dobel commit).
    expect(admin).toContain("publishBtn.disabled = true")
    expect(admin).toContain("Mengirim…")
    // Draf belum disimpan: konfirmasi sebelum navigasi.
    expect(admin).toContain("beforeunload")
    // Target commit diinjeksi build (tanpa hardcode repo/branch di sumber).
    expect(admin).toContain("{{GITHUB_REPO}}")
    expect(admin).toContain("{{GITHUB_BRANCH}}")
    const built = join(repoRoot, "site", "admin.html")
    if (existsSync(built)) {
      const src = readFileSync(built, "utf8")
      expect(src).not.toContain("{{GITHUB_") // injeksi wajib tuntas
      // Nilai terinjeksi sesuai package.json (URL fetch dibangun konkatenasi,
      // jadi yang di-assert: konstanta hasil injeksi + pemakaian variabel).
      expect(src).toContain('var REPO = "startupmini/minicode"')
      expect(src).toContain('var BRANCH = "main"')
      expect(src).toContain('"/contents/" + path')
      expect(src).toContain("branch: BRANCH")
    }
  })

  test("subset ikon: URL Material Symbols memakai icon_names eksplisit (audit web P2-9)", () => {
    for (const f of ["web/layout.html", "web/admin.html"]) {
      const src = readFileSync(join(repoRoot, f), "utf8")
      const m = /fonts\.googleapis\.com\/css2\?family=Material\+Symbols\+Outlined[^"]*/.exec(src)
      expect(m, f).toBeTruthy()
      expect(m![0]).toContain("icon_names=")
    }
    // Semua glyph yang dirender HTML/JS wajib ada di subset layout.
    const layout = readFileSync(join(repoRoot, "web", "layout.html"), "utf8")
    const subset = /icon_names=([^"&]+)/.exec(layout)![1]!.split(",")
    const used = new Set<string>()
    for (const f of [
      "web/layout.html",
      "web/admin.html",
      "web/app.js",
      "scripts/web/landing1.ts",
      "scripts/web/landing2.ts",
    ]) {
      const src = readFileSync(join(repoRoot, f), "utf8")
      for (const g of src.matchAll(/material-symbols-outlined[^>]*>([a-z_]+)</g)) {
        used.add(g[1] === "light_mode" ? "light_mode" : g[1]!)
      }
      // Glyph yang di-set runtime app.js (ikon tema, feedback copy).
      for (const g of src.matchAll(/"(dark_mode|light_mode|check|content_copy|terminal)"/g))
        used.add(g[1]!)
    }
    for (const u of used) expect(subset).toContain(u)
  })

  test("og:image raster tersedia + meta menunjuk PNG (audit web P2-10)", () => {
    const site = join(repoRoot, "site")
    if (!existsSync(site)) return // checker CI yang jaga saat build penuh
    const png = statSync(join(site, "og-image.png"), { throwIfNoEntry: false })
    expect(png?.size ?? 0).toBeGreaterThan(5000) // PNG valid, bukan hasil rusak
    const index = readFileSync(join(site, "index.html"), "utf8")
    expect(index).toContain('content="https://minicode.fun/og-image.png"')
    expect(index).toContain('property="og:image:width"')
  })

  test("navigasi mobile: link primer tetap reachable di <=520px (P0 web)", () => {
    // Regresi: media query menyembunyikan SELURUH .nav a.nl (termasuk .keep)
    // sehingga header ponsel buntu. Aturan harus mengecualikan .keep, dan
    // Docs/Install/GitHub wajib bertanda keep di layout + admin.
    const css = readFileSync(join(repoRoot, "web", "part-02-header.css"), "utf8")
    expect(css).toContain(".nl.keep")
    expect(/@media[^{]*max-width:\s*520px[\s\S]*\.nl\.keep/.test(css)).toBe(true)
    const layout = readFileSync(join(repoRoot, "web", "layout.html"), "utf8")
    for (const href of ['href="/docs/"', 'href="/#install"', 'href="https://github.com/']) {
      const tag = layout.split("\n").find((l) => l.includes(href)) ?? ""
      expect(tag).toContain("keep")
    }
    // Desktop tak tersentuh: tak ada display:none di luar media query.
    const beforeMedia = css.split("@media")[0]!
    expect(beforeMedia).not.toContain("display: none")
  })

  test("tabel: pipe di code span + escaped pipe tak memecah sel (P0 web)", () => {
    // Regresi: split buta `.split("|")` membuat sel ekstra + backtick rusak
    // di separuh tabel referensi. Setiap kasus wajib tepat 2 <td>.
    const cases: [string, string][] = [
      // A. biasa
      ["| A | B |\n|---|---|\n| foo | bar |\n", "<td>foo</td><td>bar</td>"],
      // B. pipe dalam code span
      [
        "| A | B |\n|---|---|\n| `foo | bar` | baz |\n",
        '<td><code translate="no">foo | bar</code></td><td>baz</td>',
      ],
      // C. escaped delimiter
      ["| A | B |\n|---|---|\n| foo \\| bar | baz |\n", "<td>foo | bar</td><td>baz</td>"],
      // D+E. code span + beberapa span per sel (kasus nyata tools.md)
      [
        "| T | C |\n|---|---|\n| `code_run` | Wajib sandbox `os|docker`, `x` |\n",
        '<td>Wajib sandbox <code translate="no">os|docker</code>, <code translate="no">x</code></td>',
      ],
      // F. kasus nyata cli.md: escaped pipe dalam code
      [
        '| P | F |\n|---|---|\n| `echo "prompt" \\| minicode` | Via pipe |\n',
        '<td><code translate="no">echo &quot;prompt&quot; | minicode</code></td><td>Via pipe</td>',
      ],
    ]
    for (const [src, want] of cases) {
      const html = mdToHtml(src)
      expect(html).toContain(want)
      expect(html.match(/<td>/g)?.length ?? 0).toBe(2)
    }
    // Anti-regresi eksplisit: implementasi tak boleh kembali ke blind split.
    const tricky = mdToHtml("| A |\n|---|\n| `a|b` |\n")
    expect(tricky).not.toContain("</td><td>")
  })

  test("docs tanpa nested list (batas renderer dijaga sadar — audit web P1-4)", () => {
    // Renderer md hanya mendukung list flat satu level. Guard sumber: bila
    // suatu saat docs memakai list indentasi, test ini gagal — pengingat
    // menambah dukungan nested di md.ts, bukan merender diam-diam salah.
    const offenders: string[] = []
    for (const f of readdirSync(join(repoRoot, "docs")).filter((f) => f.endsWith(".md"))) {
      readFileSync(join(repoRoot, "docs", f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s+[-*] /.test(line)) offenders.push(`docs/${f}:${i + 1}`)
        })
    }
    expect(offenders).toEqual([])
  })

  test("artikel blog contoh ter-render", () => {
    // Gagal di kode lama: CRLF membuat frontmatter tak terparse (title = nama file).
    // Niat test ini frontmatter-parsing, bukan string judul — judul mengikuti file.
    const raw = readFileSync(
      join(repoRoot, "content", "blog", "2026-09-10-kenapa-shell-native.md"),
      "utf8",
    )
    const fm = parseFrontmatter(raw, "x")
    expect(fm.title).toBe("Kenapa Minicode bekerja di terminal biasa, bukan layar khusus")
  })

  test("JSON-LD valid JSON di semua halaman (P1 web)", () => {
    // Regresi: softwareJsonld() memakai escAttr() sehingga landing memuat
    // `{&quot;@context&quot;...}` — entity tak di-decode di body <script>.
    const parsed = JSON.parse(softwareJsonld("0.9.6")) as Record<string, unknown>
    expect(parsed["@type"]).toBe("SoftwareApplication")
    const site = join(repoRoot, "site")
    if (!existsSync(site)) return
    const pages = ["index.html", "404.html", "docs/tools.html", "blog/index.html"]
    for (const p of pages) {
      const src = readFileSync(join(site, p), "utf8")
      const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(src)
      expect(m, p).toBeTruthy()
      expect(m![1]).not.toContain("&quot;")
      const doc = JSON.parse(m![1]!) as { "@type"?: string; "@graph"?: { "@type": string }[] }
      // Bentuk sah: top-level @type ATAU @graph berisi node bertipe (docs/blog
      // kini memakai @graph: BreadcrumbList + TechArticle/Article/WebPage).
      const typeOk = typeof doc["@type"] === "string" || (doc["@graph"]?.length ?? 0) > 0
      expect(typeOk, p).toBe(true)
    }
  })

  test("identitas repo konsisten ke startupmini (FIX#4 web)", () => {
    // Akun rename ngodingsendiri → startupmini: NOL referensi lama tersisa
    // (clone URL, metadata, sibling, copyright, footer). Sekali muncul = fail.
    const hits: string[] = []
    const scan = ["package.json", "CONTRIBUTING.md", "README.md", "AGENTS.md", "PLAN.md", "LICENSE"]
    for (const f of scan) {
      readFileSync(join(repoRoot, f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (line.includes("ngodingsendiri")) {
            hits.push(`${f}:${i + 1}`)
          }
        })
    }
    const checkDirs = [
      "docs",
      "scripts/web",
      "web",
      "content/blog",
      "cli",
      "src",
      ".github/workflows",
    ]
    for (const d of checkDirs) {
      const files = readdirSync(join(repoRoot, d), {
        recursive: true,
        encoding: "utf8",
      }) as string[]
      for (const f of files) {
        if (!/\.(md|html|ts|js|css|yml)$/.test(f)) continue
        readFileSync(join(repoRoot, d, f), "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (line.includes("ngodingsendiri")) {
              hits.push(`${d}/${f}:${i + 1}`)
            }
          })
      }
    }
    expect(hits).toEqual([])
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      homepage: string
    }
    expect(pkg.homepage).toContain("startupmini/minicode")
  })

  test("agents.md plan-child jujur: tanpa todo_write (FIX#6 web)", () => {
    // Regresi: tabel mode anak pernah menjanjikan "rencana tertulis" padahal
    // src/tools/task.ts mengecualikan todo_write untuk SEMUA anak.
    // Source of truth = implementasi; docs wajib cocok.
    const agents = readFileSync(join(repoRoot, "docs", "agents.md"), "utf8")
    const task = readFileSync(join(repoRoot, "src", "tools", "task.ts"), "utf8")
    expect(task).toContain('"todo_write"')
    const planRow = agents.split("\n").find((l) => l.startsWith("| `plan`"))
    expect(planRow).toBeTruthy()
    expect(planRow!).not.toMatch(/rencana tertulis/i)
    expect(planRow!).toMatch(/todo_read|tanpa.*todo_write|tanpa mutasi/i)
  })

  test("heading id stabil + duplikat unik + TOC sinkron (FIX#7 web)", async () => {
    const { extractHeadings } = await import("../scripts/web/md.ts")
    const src = "# T\n\n## Instalasi\n\n## Instalasi\n\n### Detail A\n\n```\n# bukan heading\n```\n"
    const html = mdToHtml(src)
    expect(html).toContain('id="instalasi"')
    expect(html).toContain('id="instalasi-2"')
    expect(html).toContain('id="detail-a"')
    expect(html).not.toContain('id="bukan-heading"')
    // extractHeadings (dipakai TOC) identik dengan renderer.
    expect(extractHeadings(src).map((h) => h.id)).toEqual([
      "t",
      "instalasi",
      "instalasi-2",
      "detail-a",
    ])
    // TOC muncul di halaman panjang hasil build (tools.html punya ≥4 H2).
    const site = join(repoRoot, "site")
    if (!existsSync(site)) return
    const tools = readFileSync(join(site, "docs", "tools.html"), "utf8")
    expect(tools).toContain('aria-label="Daftar isi"')
    for (const m of tools.matchAll(/<nav class="toc"[\s\S]*?<\/nav>/g)) {
      for (const a of m[0].matchAll(/href="#([^"]+)"/g)) {
        expect(tools).toContain(`id="${a[1]}"`)
      }
    }
  })

  test("firstPara: prosa bersih, bukan sintaks markdown (FIX#8 web)", async () => {
    const { firstPara } = await import("../scripts/web/fm.ts")
    // Link inline dirender jadi teks (kasus nyata concepts.md).
    expect(firstPara("Intro.\n\nLangkah ada di [Instalasi](getting-started.md) lanjut.\n")).toBe(
      "Langkah ada di Instalasi lanjut.",
    )
    // List, quote, tabel, fence, heading dilewati.
    expect(
      firstPara(
        "# T\n\n- item satu dua tiga empat lima\n\n> kutipan cukup panjang di sini\n\nParagraf prose kedua yang valid dan cukup panjang.",
      ),
    ).toBe("Paragraf prose kedua yang valid dan cukup panjang.")
    expect(firstPara("| a | b |\n|---|---|\n| 1 | 2 |\n")).toBe("")
    expect(firstPara("```js\ncode\n```\n")).toBe("")
    // Potong di batas kata dengan elipsis.
    const long = `Awal kalimat yang sangat panjang sekali sehingga pasti melebihi batas seratus lima puluh lima karakter yang ditentukan dan harus dipotong dengan rapi di sini tambah kata.`
    const out = firstPara(`${long}\n`)
    expect(out.length).toBeLessThanOrEqual(155)
    expect(out.endsWith("…")).toBe(true)
    expect(out).not.toMatch(/\[[^\]]*\]\(/)
  })

  test("landing memuat satu proof-of-product inline (FIX#10 web)", () => {
    const site = join(repoRoot, "site")
    if (!existsSync(site)) return
    const index = readFileSync(join(site, "index.html"), "utf8")
    // Tepat satu figure proof: SVG inline (tanpa request aset baru). Class
    // boleh bertambah (shot term — tergabung dgn jendela terminal, rombak hero).
    expect(index.match(/<figure class="shot[ "]/g)?.length ?? 0).toBe(1)
    expect(index).toContain("<svg")
    // Guard raster dikawinkan ke figure proof (og:image.png di <head> sah —
    // crawler sosial tak merender SVG; yang dilarang: proof jadi <img> raster).
    const shot = /<figure class="shot[ "][\s\S]*?<\/figure>/.exec(index)?.[0] ?? ""
    expect(shot).not.toContain(".png")
    expect(shot).not.toContain(".gif")
    expect(index).toContain("write_file server.ts")
  })

  test("landing narrative: H1 proposisi + cara-kerja + cocok + tanpa jargon", () => {
    const site = join(repoRoot, "site")
    if (!existsSync(site)) return
    const index = readFileSync(join(site, "index.html"), "utf8")
    expect(index).toContain("menunjukkan semua kerjanya")
    expect(index).toContain('id="cara-kerja"')
    expect(index).toContain("Kapan Minicode cocok?")
    expect(index).toContain("Bukan pilihan tepat")
    expect(index).toContain("/docs/security-model.html")
    expect(index).toContain("/docs/quickstart.html")
    // Tanpa jargon implementasi di narasi landing (footer boleh menyebut lineage).
    const main = index.slice(index.indexOf("<main"), index.indexOf("</main>"))
    for (const jargon of ["statusline.ts", "invariant", "MiniCore", "shadow-git", "O(delta)"]) {
      expect(main).not.toContain(jargon)
    }
  })

  test("halaman P1 konten terbit + tertaut (security-model, choosing-mode)", () => {
    const site = join(repoRoot, "site")
    if (!existsSync(site)) return
    for (const p of ["docs/security-model.html", "docs/choosing-mode.html"]) {
      expect(statSync(join(site, p), { throwIfNoEntry: false })).toBeTruthy()
    }
    const index = readFileSync(join(site, "index.html"), "utf8")
    expect(index).toContain("/docs/security-model.html")
    const sm = readFileSync(join(site, "sitemap.xml"), "utf8")
    expect(sm).toContain("security-model.html")
    expect(sm).toContain("choosing-mode.html")
    const sec = readFileSync(join(site, "docs", "security-model.html"), "utf8")
    expect(sec).toContain('aria-label="Daftar isi"')
  })

  test("site/ hasil build lengkap (bila sudah di-build)", () => {
    const site = join(repoRoot, "site")
    if (!existsSync(site)) return // build belum jalan — checker CI yang jaga
    const has = (p: string): boolean => !!statSync(join(site, p), { throwIfNoEntry: false })
    for (const p of [
      "index.html",
      "docs/index.html",
      "docs/tools.html",
      "blog/index.html",
      "sitemap.xml",
      "rss.xml",
      "robots.txt",
      "admin.html",
      "CNAME",
    ]) {
      expect(has(p)).toBe(true)
    }
    // Canonical + sitemap wajib memakai domain produksi, bukan github.io.
    const index = readFileSync(join(site, "index.html"), "utf8")
    expect(index).toContain("https://minicode.fun/")
    expect(index).not.toContain("startupmini.github.io")
    expect(readFileSync(join(site, "CNAME"), "utf8").trim()).toBe("minicode.fun")
    // Logo user ikut di-copy.
    expect(has("assets/logo-user.svg")).toBe(true)
    // Judul docs tidak ganda (satu <h1> per halaman — termasuk ber-atribut).
    const docIndex = readFileSync(join(site, "docs", "index.html"), "utf8")
    expect(docIndex.includes("<h1>Minicode — Dokumentasi</h1>")).toBe(true)
    expect(docIndex.split("<h1>").length).toBe(2)
    expect((docIndex.match(/<h1[\s>]/g) ?? []).length).toBe(1)
    for (const p of ["docs/tools.html", "docs/cli.html"]) {
      const src = readFileSync(join(site, p), "utf8")
      expect((src.match(/<h1[\s>]/g) ?? []).length, p).toBe(1)
    }
    // Tidak ada sisa badge/sidebar/pill / lalu lintas lama.
    expect(docIndex).not.toContain("src-badge")
    expect(docIndex).not.toContain("doc-meta")
    expect(docIndex).not.toContain("doc-rail")
    expect(docIndex).not.toContain("side-link")
    // Prev/Next di bawah: label mono + judul halaman tujuan (rombak docs
    // 2026-09-17). Dulu hanya "‹ Prev"/"Next ›" tanpa judul — pembaca baru
    // tahu tujuan navigasinya setelah mengklik.
    const docTools = readFileSync(join(site, "docs", "tools.html"), "utf8")
    expect(docTools).toContain('<span class="dn-k">‹ Sebelumnya</span><span class="dn-t">')
    expect(docTools).toContain('<span class="dn-k">Berikutnya ›</span><span class="dn-t">')
    expect(docTools).not.toContain(">‹ Prev<")
  })

  test("design language flat: tanpa shadow/gradient, radius kecil, kartu flat", () => {
    // Audit desain: bahasa visual = flat. Guard level-source agar dekorasi
    // tak merayap kembali (bukan per halaman). Glob cermin builder
    // (build-web-css.ts) supaya part baru otomatis tercakup.
    const css = readdirSync(join(repoRoot, "web"))
      .filter((f) => /^part-.*\.css$/.test(f))
      .sort()
      .map((f) => readFileSync(join(repoRoot, "web", f), "utf8"))
      .join("\n")
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(code).not.toMatch(/box-shadow\s*:/)
    expect(code).not.toMatch(/linear-gradient|radial-gradient/)
    // Radius terbesar yang diizinkan: 8px (structural), kecuali brand-logo.
    const radii = [...code.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1]!.trim())
    for (const r of radii) {
      for (const n of r.match(/\d+/g) ?? []) {
        expect(Number(n)).toBeLessThanOrEqual(8)
      }
    }
    // Kartu .feat = flat content group (tanpa background).
    expect(code).not.toMatch(/\.feat\s*\{[^}]*background/)
    // Scrollbar disembunyikan (2026-09-17, ganti "tipis"): native trek+thumb
    // tidak flat. Guard detail ada di test khusus scrollbar; di sini cukup
    // pastikan aturannya ada di CSS gabungan, plus dead selector tak kembali.
    expect(code).toContain("scrollbar-width: none")
    expect(code).not.toContain(".tbl")
    expect(code).not.toContain(".prov-line")
    // Audit website 2026-09-16: selector yatim tanpa konsumen HTML/JS.
    expect(code).not.toContain(".hint")
    expect(code).not.toContain("a.active")
  })
})

describe("web audit 2026-09-16", () => {
  test("serve: path keluar site/ ditolak (traversal)", () => {
    // Guard defense-in-depth (URL WHATWG sudah menormalkan `..`): path yang
    // lolos join harus tetap di dalam site/. Catatan POSIX: backslash di
    // nama path LINUX adalah karakter biasa (bukan pemisah) — kasus Windows
    // hanya diverifikasi di Windows.
    expect(isPathWithinSite("/index.html")).toBe(true)
    expect(isPathWithinSite("/docs/cli.html")).toBe(true)
    expect(isPathWithinSite("/blog/")).toBe(true)
    expect(isPathWithinSite("/../package.json")).toBe(false)
    expect(isPathWithinSite("/docs/../../cli/index.ts")).toBe(false)
    if (process.platform === "win32") {
      expect(isPathWithinSite("..\\package.json")).toBe(false)
    }
  })

  test("blog: judul/desc frontmatter di-escape (anti-rusak layout)", () => {
    // Frontmatter melewati renderer md (yang meng-escape) — tanpa escape di
    // sini `<` di judul (mis. "a < b") merusak halaman.
    const root = mkdtempSync(join(tmpdir(), "mc-web-"))
    try {
      const blogDir = join(root, "content", "blog")
      mkdirSync(blogDir, { recursive: true })
      writeFileSync(
        join(blogDir, "2026-01-02-xss-probe.md"),
        '---\ntitle: "a < b </script><script>alert(1)</script> c"\ndate: 2026-01-02\ntags: [x]\ndesc: "d < e"\n---\n\nIsi.\n',
        "utf8",
      )
      const pages = new Map<string, string>()
      // webDir asli (template layout), siteDir tmp (rss) — konten blog fiktif.
      buildBlog(root, join(repoRoot, "web"), root, "https://x.example", "0.0.0", (rel, html) =>
        pages.set(rel, html),
      )
      const idx = pages.get("blog/index.html") ?? ""
      const post = pages.get("blog/xss-probe.html") ?? ""
      expect(post.length).toBeGreaterThan(0)
      // Konten elemen: escape penuh — payload breakout tak boleh utuh.
      for (const html of [idx, post]) {
        expect(html).toContain("a &lt; b")
        expect(html).not.toContain("<h1>a < b")
        expect(html).not.toContain("<h3>a < b")
        expect(html).not.toContain("<p>a < b")
        expect(html).not.toContain("</script><script>alert")
      }
      // JSON-LD: `<` mentah legal di JSON, tapi `</` (breakout `</script>`)
      // wajib lolos-escape — dan payload harus round-trip utuh.
      const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(post)?.[1] ?? ""
      expect(ld.length).toBeGreaterThan(0)
      expect(ld).not.toContain("</script")
      // headline kini di node Article dalam @graph (breadcrumb ditambahkan);
      // niat test tetap: payload round-trip utuh tanpa breakout.
      const doc = JSON.parse(ld) as {
        headline?: string
        "@graph"?: ({ headline?: string; "@type"?: string } | undefined)[]
      }
      const headline =
        doc.headline ?? doc["@graph"]?.find((n) => n?.["@type"] === "Article")?.headline
      expect(headline).toBe("a < b </script><script>alert(1)</script> c")
      const rss = readFileSync(join(root, "rss.xml"), "utf8")
      expect(rss).toContain("a &lt; b")
      expect(rss).not.toContain("<script>alert")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("blog: tanggal rusak tak jadi pubDate Invalid Date", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-web-"))
    try {
      const blogDir = join(root, "content", "blog")
      mkdirSync(blogDir, { recursive: true })
      writeFileSync(
        join(blogDir, "2026-01-03-bad-date.md"),
        '---\ntitle: "T"\ndate: kapan-kapan\ntags: []\ndesc: "D"\n---\n\nIsi.\n',
        "utf8",
      )
      buildBlog(root, join(repoRoot, "web"), root, "https://x.example", "0.0.0", () => {})
      const rss = readFileSync(join(root, "rss.xml"), "utf8")
      expect(rss).not.toContain("Invalid Date")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("tema tanpa kedip: init sinkron di head + kunci sama dengan app.js", () => {
    // Tanpa init sinkron, pengguna dark-mode melihat kilat terang saat load
    // (app.js deferred). Kunci localStorage harus sama di kedua tempat.
    for (const f of ["web/layout.html", "web/admin.html"]) {
      const src = readFileSync(join(repoRoot, f), "utf8")
      expect(src).toContain('localStorage.getItem("minicode-theme")')
      expect(src.indexOf("minicode-theme")).toBeLessThan(src.indexOf("stylesheet"))
    }
    const app = readFileSync(join(repoRoot, "web", "app.js"), "utf8")
    expect(app).toContain('localStorage.getItem("minicode-theme")')
  })

  test("motion: token + kill-switch reduced-motion + gate progresif", () => {
    // Bahasa gerak satu token; tanpa JS / reduced-motion konten tetap tampil.
    const css = readdirSync(join(repoRoot, "web"))
      .filter((f) => /^part-.*\.css$/.test(f))
      .sort()
      .map((f) => readFileSync(join(repoRoot, "web", f), "utf8"))
      .join("\n")
    expect(css).toContain("--t:")
    // Hanya opacity/transform (+ color/bg 0.15s): tanpa properti pemicu layout.
    for (const m of css.matchAll(/@keyframes\s+([a-zA-Z-]+)\s*\{([\s\S]*?)\n\}/g)) {
      expect(m[2]!).not.toMatch(/width|height|margin|padding|top|left/)
    }
    expect(css).toContain("prefers-reduced-motion")
    expect(css).toContain("!important")
    // Entrance disembunyikan hanya di balik gate .js (no-JS = tampil utuh).
    expect(css).toMatch(/\.js\s+\.hero\s*>\s*\*/)
    // Arah desain 2026-09-17: SATU momen gerak (entrance hero) — reveal
    // per-kartu (.rv) dihapus; kalau kembali, harus dengan alasan desain
    // eksplisit, bukan agar halaman "terasa hidup".
    expect(css).not.toMatch(/\.rv\b/)
    // View transition native (progresif: browser lama abaikan aturan ini).
    expect(css).toContain("@view-transition")
    const app = readFileSync(join(repoRoot, "web", "app.js"), "utf8")
    expect(app).toContain('classList.add("js")')
    expect(app).toContain("IntersectionObserver")
    expect(app).toContain("prefers-reduced-motion")
  })

  // ===== Guard adversarial-review (4 bug yang ditemukan live, dijaga agar
  // tidak kembali) =====

  test("guard: docs-nav lock — matchMedia change membuka ulang + toggle tetap (adversarial #1)", () => {
    // Bug yang dijaga: user menutup menu di mobile lalu melebarkan layar → CSS
    // pindah ke branch desktop (summary display:none) TANPA event toggle →
    // dulu nav hilang total. Lock harus terpasang di DUA jalur: change
    // matchMedia (path resize) dan toggle <details> (path klik user).
    // Bentuk runtime (var/IIFE, bukan module) dijaga test tema & motion di
    // atas — grep sumber seperti test "tema tanpa kedip".
    const app = readFileSync(join(repoRoot, "web", "app.js"), "utf8")
    expect(app).toContain('window.matchMedia("(min-width: 901px)")')
    expect(app).toContain('addEventListener("change"')
    expect(app).toContain("addListener")
    expect(app).toContain('addEventListener("toggle"')

    // Verifikasi semantik lock: registrasi di kedua jalur memasang SATU
    // handler yang membuka ulang details hanya saat mql.matches.
    const changed: Array<(e: { matches: boolean }) => void> = []
    const toggled: Array<() => void> = []
    const fold = {
      open: true,
      addEventListener(type: string, fn: () => void) {
        if (type === "toggle") toggled.push(fn)
      },
    }
    const mql = {
      matches: true,
      addEventListener(type: string, fn: (e: { matches: boolean }) => void) {
        if (type === "change") changed.push(fn)
      },
    }
    const lockFold = (e: { matches: boolean }) => {
      if (e.matches) fold.open = true
    }
    mql.addEventListener("change", lockFold)
    fold.addEventListener("toggle", () => lockFold(mql))
    expect(changed.length).toBe(1)
    expect(toggled.length).toBe(1)
    changed[0]!({ matches: false })
    expect(fold.open).toBe(true)
    fold.open = false
    changed[0]!({ matches: true })
    expect(fold.open).toBe(true)
    fold.open = false
    toggled[0]!()
    expect(fold.open).toBe(true)
  })

  test("guard: baris lanjutan list menyambung <li>, tak memecah <ol> (adversarial #2)", () => {
    // Bug yang dijaga: baris indentasi setelah item list jatuh ke branch
    // paragraf → <ol> pecah dua dan penomoran restart dari 1 (75 lokasi di
    // docs: security.md, TERMINAL_CONTRACT.md, HARNESS.md). Baris lanjutan
    // harus menyambung ke <li> sebelumnya. Pemisahan TETAP sah bila diawali
    // baris kosong (kontrak lama, dijaga test lama).
    const html = mdToHtml("1. Satu\n2. Dua\n   lanjutan Dua\n3. Tiga\n")
    expect(html).toContain("<ol>")
    expect((html.match(/<ol>/g) ?? []).length).toBe(1)
    expect(html).toContain("<li>Dua lanjutan Dua</li>")
    expect(html).toContain("<li>Tiga</li>")
    expect(html).not.toMatch(/<p>\s*lanjutan Dua<\/p>/)
    const ul = mdToHtml("- Satu\n- Dua\n  lanjutan Dua\n- Tiga\n")
    expect(ul).toContain("<ul>")
    expect((ul.match(/<ul>/g) ?? []).length).toBe(1)
    expect(ul).toContain("<li>Dua lanjutan Dua</li>")
  })

  test("guard: formatBlogDate memakai timeZone UTC (adversarial #3)", () => {
    // Bug yang dijaga: tanggal post diparse UTC tengah malam; formatter
    // tanpa timeZone eksplisit memakai TZ mesin build → "2026-01-05" tampil
    // "4 Jan" di TZ negatif (blog + rss + JSON-LD). resolvedOptions().timeZone
    // hanya "UTC" yang deterministik di semua mesin.
    expect(blogDateFmt.resolvedOptions().timeZone).toBe("UTC")
    const off = new Date(Date.UTC(2026, 0, 5, 23, 30, 0))
    const back = new Date(off.getTime() + 45 * 60_000)
    expect(blogDateFmt.format(off)).toBe("5 Jan 2026")
    expect(blogDateFmt.format(back)).toBe("6 Jan 2026")
    const cloned = structuredClone(off)
    expect(cloned.getUTCHours()).toBe(off.getUTCHours())
    expect(blogDateFmt.format(cloned)).toBe("5 Jan 2026")
    expect(formatBlogDate("bukan-iso")).toBe("bukan-iso")
  })

  test("guard: nav docs mobile sticky via display:block + top 60px (adversarial #4)", () => {
    // Bug yang dijaga: .doc-side = grid item satu baris → containing block
    // sticky setinggi dirinya sendiri → sticky no-op, ringkasan menu ikut
    // scroll. Fix: mobile pakai display:block (containing block = .doc-layout
    // setinggi halaman) + top: 60px (di bawah topbar). Desktop tetap grid
    // statis (nav dalam-flow, tak butuh sticky) — regressi di sisi lain juga
    // ditangkap: grid + sticky di desktop = posisi mobile hilang.
    const css = readFileSync(join(repoRoot, "web", "part-05-docs-blog.css"), "utf8")
    const mobile = css.match(/@media \(max-width: 900px\) \{[\s\S]*?\n\}/)
    expect(mobile).not.toBeNull()
    const block = mobile![0]
    expect(block).toContain(".doc-layout { display: block; }")
    expect(block).toContain(".doc-side { position: sticky; top: 60px;")
    expect(block).not.toMatch(/\.doc-side\s*\{[^}]*max-height: 240px/)
    const desktop = css.match(/@media \(min-width: 901px\) \{[\s\S]*?\n\}/)
    expect(desktop).not.toBeNull()
    expect(desktop![0]).toContain(".doc-side summary { display: none; }")
    expect(desktop![0]).not.toContain("position: sticky")
    expect(css).toMatch(/\.doc-layout\s*\{[^}]*grid-template-columns/)
  })

  test("changelog: digenerate dari PLAN.md — parser + build + anti-dobel-render", () => {
    // Parser: head `- ✅ Judul (tanggal): teks` + baris lanjutan indentasi;
    // item tanpa tanggal tetap sah (date kosong).
    const entries = parsePlanStatus(
      "- ✅ SATU (2026-01-05): teks satu.\n  lanjutan satu.\n- ⏳ DUA: teks dua.\n",
    )
    expect(entries.length).toBe(2)
    expect(entries[0]!.title).toBe("SATU")
    expect(entries[0]!.date).toBe("2026-01-05")
    expect(entries[0]!.prose).toContain("lanjutan satu")
    expect(entries[1]!.title).toBe("DUA")
    expect(entries[1]!.date).toBe("")

    // Build asli: PLAN.md menyisipkan marker guard, halaman dirender satu
    // kali (file md stub TIDAK ikut), dan sidebar menandai halaman aktif.
    // CI checkout segar tak menjalankan web:build — artefak dijaga web-check.
    if (!existsSync(join(repoRoot, "site"))) return
    const html = readFileSync(join(repoRoot, "site", "docs", "changelog.html"), "utf8")
    expect(html).toContain("GUARD-CHLOG-SATU")
    // Anti-dobel-render: kalimat khas stub docs/changelog.md TIDAK boleh ikut.
    expect(html).not.toContain("saat build website")
    expect(html).not.toMatch(/<h1>Changelog<\/h1>[\s\S]*<h1>Changelog<\/h1>/)
    expect(html).toContain('href="/docs/changelog.html" aria-current="page"')
  })

  test("discoverability AI: llms-full.txt, robots AI-crawler, FAQPage JSON-LD", () => {
    // Kanal discovery AI (riset 2026-09-17): (1) llms-full.txt = korpus penuh
    // utk agent yg lebih suka satu fetch; (2) robots.txt menyebut crawler AI
    // eksplisit; (3) FAQPage = jawaban yg paling sering dikutip assistant.
    if (!existsSync(join(repoRoot, "site"))) return
    // llms-full: seluruh entri SUMMARY ada, berurutan, dengan URL kanonik.
    const full = readFileSync(join(repoRoot, "site", "llms-full.txt"), "utf8")
    const sumRaw = readFileSync(join(repoRoot, "docs", "SUMMARY.md"), "utf8")
    const slugs: string[] = [...sumRaw.matchAll(/\]\(([a-z0-9-]+)\.md\)/g)].map((m) => m[1]!)
    let at = -1
    for (const s of slugs) {
      const needle = s === "readme" ? "/docs/" : `/docs/${s}.html`
      const i = full.indexOf(needle)
      expect(i, `llms-full urut: ${s}`).toBeGreaterThan(at)
      at = i
    }
    expect(full).toContain("# Status eksekusi")
    // robots: crawler AI utama eksplisit di-allow; admin tetap disallow.
    const robots = readFileSync(join(repoRoot, "site", "robots.txt"), "utf8")
    for (const ua of ["GPTBot", "ClaudeBot", "PerplexityBot", "OAI-SearchBot", "Google-Extended"]) {
      expect(robots, ua).toContain(`User-agent: ${ua}`)
    }
    expect(robots).toContain("llms-full.txt")
    const adminIdx = robots.indexOf("Disallow: /admin.html")
    expect(adminIdx).toBeGreaterThan(-1)
    // FAQPage JSON-LD di landing: pertanyaan sama dgn yang tampil di HTML.
    const index = readFileSync(join(repoRoot, "site", "index.html"), "utf8")
    expect(index).toContain('"FAQPage"')
    const q1 = "Apakah Minicode butuh API key?"
    expect(index).toContain(q1) // HTML (details/summary)
    const ldBlock = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(index)![1]!
    const graph = JSON.parse(ldBlock.replace(/<\\\//g, "</")) as { "@graph": { "@type": string }[] }
    expect(graph["@graph"].map((o) => o["@type"])).toContain("FAQPage")
    expect(graph["@graph"].map((o) => o["@type"])).toContain("SoftwareApplication")
  })

  test("SEO: llms.txt digenerate + breadcrumb JSON-LD + judul tak dobel", () => {
    // Semua asersi membaca artefak build — CI checkout segar melewatkannya
    // (web:build jalan di job web-check); lokal selalu ada setelah web:build.
    if (!existsSync(join(repoRoot, "site"))) return
    // llms.txt (llmstxt.org) = kanal discovery AI-crawler; digenerate build
    // dari SUMMARY agar tak stale (statis lama = 404 live sebelum fix).
    const llms = readFileSync(join(repoRoot, "site", "llms.txt"), "utf8")
    expect(llms).toContain("# Minicode")
    expect(llms).toContain("## Docs")
    expect(llms).toContain("/docs/tools.html")
    // BreadcrumbList = rich result hidup 2026; judul dobel = label SUMMARY
    // "Minicode — X" + suffix layout "— Minicode".
    const tools = readFileSync(join(repoRoot, "site", "docs", "tools.html"), "utf8")
    expect(tools).toContain("BreadcrumbList")
    expect(tools).toContain("<title>Tools (37) — Minicode</title>")
    expect(tools).not.toContain("— Minicode — Minicode")
    expect(tools).not.toMatch(/<title>Minicode — /)
  })

  test("breadcrumbJsonld: satu pemilik konvensi (Beranda posisi 1, terakhir tanpa item)", () => {
    // Konvensi (1): Beranda otomatis ditambahkan di posisi 1; trail dimulai
    // dari posisi 2. Konvensi (2): elemen terakhir TANPA item — helper yang
    // membuangnya meski pemanggil mengirim, jadi call site tak bisa lupa.
    const bc = breadcrumbJsonld("https://x.example", [
      { name: "Docs", item: "https://x.example/docs/" },
      { name: "X", item: "https://x.example/x.html" },
    ]) as { itemListElement: { position: number; name: string; item?: string }[] }
    expect(bc.itemListElement.map((e) => e.position)).toEqual([1, 2, 3])
    expect(bc.itemListElement[0]).toMatchObject({ name: "Beranda", item: "https://x.example/" })
    expect(bc.itemListElement[2]!.item).toBeUndefined()
    // End-to-end: artefak docs memakai helper dengan struktur yang benar
    // (dilewati bila site/ belum ada — CI checkout segar).
    if (!existsSync(join(repoRoot, "site"))) return
    const tools = readFileSync(join(repoRoot, "site", "docs", "tools.html"), "utf8")
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(tools)![1]!
    const graph = (
      JSON.parse(ld) as {
        "@graph": {
          "@type": string
          itemListElement?: { position: number; name: string; item?: string }[]
        }[]
      }
    )["@graph"]
    const bcDoc = graph.find((n) => n["@type"] === "BreadcrumbList")!
    expect(bcDoc.itemListElement!.map((e) => e.name)).toEqual(["Beranda", "Docs", "Tools (37)"])
    expect(bcDoc.itemListElement![2]!.item).toBeUndefined()
  })

  test("guard: header docs — kicker kelompok + judul di luar .doc-body (rombak docs)", () => {
    // Rombak 2026-09-17: halaman docs memakai bahasa desain landing — kicker
    // (kelompok SUMMARY) + judul mono skala display di <header class="doc-head">.
    // Bug yang dijaga: judul kembali ke dalam .doc-body (bentuk lama) sehingga
    // skalanya jatuh ke ukuran isi dan kicker hilang; dan TOC kembali ke <ul>
    // (daftar bullet) sehingga penomoran counter CSS tak punya elemen <li>.
    const site = join(repoRoot, "site")
    if (!existsSync(site)) return // build belum jalan — checker CI yang jaga
    // Bentuk unit: kicker → judul → lede opsional, teks dari SUMMARY/README
    // di-escape (judul dengan `&` tidak boleh merusak heading).
    const headUnit = renderDocHead("Memulai", "A & B", "<p>lede</p>")
    expect(headUnit).toBe(
      '<header class="doc-head"><p class="kicker">Memulai</p><h1>A &amp; B</h1><p class="lede"><p>lede</p></p></header>',
    )
    expect(renderDocHead("Docs", "X")).not.toContain('class="lede"')

    const navUnit = renderDocNav(
      [
        { group: "G", title: "Satu", file: "a.md", slug: "a" },
        { group: "G", title: "Dua", file: "b.md", slug: "b" },
        { group: "G", title: "Tiga", file: "c.md", slug: "c" },
      ],
      0,
    )
    // Elemen pertama: tak ada prev (slot <span> kosong), next bertajuk.
    expect(navUnit).toContain('<span></span><a class="next" href="/docs/b.html">')
    expect(navUnit).toContain('<span class="dn-t">Dua</span>')

    const tools = readDocNav(repoRoot).find((e) => e.slug === "tools")!
    const html = readFileSync(join(site, "docs", "tools.html"), "utf8")
    expect(html).toContain('<header class="doc-head">')
    expect(html).toContain(`<p class="kicker">${tools.group}</p>`)
    expect(html).toContain(`<h1>${tools.title}</h1>`)
    expect(html).not.toMatch(/<article class="doc-body"><h1>/)
    expect(html).toMatch(/<nav class="toc"[^>]*><p>Daftar isi<\/p><ol>/)
  })

  test("guard: TOC tak menomori ganda heading yang sudah bernomor", () => {
    // Bug yang dijaga: quickstart.md memakai heading bernomor ("## 1. Jalan
    // pertama") dan counter CSS di .toc li::before menambah nomor kedua →
    // tampil "1. 1. Jalan pertama" di daftar isi.
    const site = join(repoRoot, "site")
    if (!existsSync(site)) return
    const html = readFileSync(join(site, "docs", "quickstart.html"), "utf8")
    const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(html)
    expect(toc).not.toBeNull()
    // Label bersih, anchor tetap memakai id dari teks asli (href stabil).
    expect(toc![0]).toContain(
      '<li><a href="#1-jalan-pertama-1-menit">Jalan pertama 1 menit</a></li>',
    )
    expect(toc![0]).not.toContain(">1. Jalan pertama")
  })

  test("guard: hub docs — grid dari SUMMARY, tanpa sidebar, tabel Navigasi dibuang", () => {
    // Rombak 2026-09-17: /docs/ jadi "landing dokumentasi" — header + direktori
    // grid (dari SUMMARY) di ATAS artikel, tanpa sidebar (isinya identik) dan
    // tanpa tabel Navigasi README (duplikat). Bug yang dijaga: grid kembali ke
    // bawah (direktori tak terjangkau di ponsel) atau sidebar/tabel balik lagi
    // sehingga daftar yang sama tampil dua kali.
    const nav = readDocNav(repoRoot)
    const grid = renderDocGrid(nav)
    expect(grid).toContain('class="doc-grid"')
    // Satu kartu per halaman SUMMARY selain hub itu sendiri.
    expect((grid.match(/class="dc"/g) ?? []).length).toBe(nav.length - 1)
    expect(grid).not.toContain('href="/docs/"')
    for (const e of nav) {
      if (e.slug === "readme") continue
      const href = e.slug === "changelog" ? "/docs/changelog.html" : `/docs/${e.slug}.html`
      expect(grid, e.slug).toContain(`href="${href}"`)
    }

    // stripMdSection: heading + isi sampai heading berikutnya, heading lain utuh.
    const stub =
      "# T\n\n## Satu\n\nis\n\n## Navigasi\n\n| a | b |\n|---|---|\n| c | d |\n\n## Tiga\n\ntetap\n"
    const stripped = stripMdSection(stub, "Navigasi")
    expect(stripped).not.toContain("## Navigasi")
    expect(stripped).not.toContain("| c | d |")
    expect(stripped).toContain("## Satu")
    expect(stripped).toContain("## Tiga")

    // Sumber README tetap utuh untuk pembaca repo (hanya web yang membuang).
    const readme = readFileSync(join(repoRoot, "docs", "README.md"), "utf8")
    expect(readme).toContain("## Navigasi")

    const site = join(repoRoot, "site")
    if (!existsSync(site)) return
    const hub = readFileSync(join(site, "docs", "index.html"), "utf8")
    expect(hub).toContain('class="doc-layout hub"')
    expect(hub).not.toContain('class="doc-side"')
    // Grid mendahului artikel (direktori dulu, prosa menyusul).
    expect(hub.indexOf('class="doc-grid"')).toBeLessThan(
      hub.indexOf('<article class="doc-body doc-hub">'),
    )
    expect(hub).not.toContain("| Anda ingin...")
  })

  test("guard: prosa rata kanan-kiri (justify) + hyphenation di base CSS", () => {
    // Permintaan desain 2026-09-17: paragraf prose rata kanan-kiri, tapi
    // heading/daftar/tabel tetap rata kiri, dan baris terakhir tetap kiri.
    // Bug yang dijaga: justify diterapkan terlalu luas (`.feat p` di kolom
    // ±280px dan `.footer p` 34ch = celah antarkata menganga) atau aturan
    // `text-wrap: pretty` dibiarkan (diabaikan browser saat teks dijustify).
    const base = readFileSync(join(repoRoot, "web", "part-01-base.css"), "utf8")
    const justify = base.match(/\.lead[^{]*\{[^}]*text-align:\s*justify[^}]*\}/)
    expect(justify).not.toBeNull()
    const block = justify![0]
    expect(block).toContain(".doc-body p")
    expect(block).toContain(".article p")
    expect(block).toContain("text-align-last: left")
    expect(block).toContain("hyphens: auto")
    expect(block).not.toContain(".feat p")
    expect(block).not.toContain(".footer p")
    // Hanya aturan nyata yang dihitung — komentar justru MENYEBUT pretty
    // sebagai hal yang dibuang, jadi pola harus menuntut titik-koma penutup.
    expect(base).not.toMatch(/text-wrap:\s*pretty\s*;/)
  })

  test("guard: eksperimen urutan A/B — DOM kanonik, tukar lewat `order` di dalam .pair", () => {
    // Bug yang dijaga (nyata, ditemukan saat verifikasi preview): mencoba
    // menukar urutan dengan `main { display: flex }` + `main > * { order: 10 }`
    // mengangkat SELURUH section lain ke atas karena nilai order yang sama
    // mengalahkan posisi dokumen. Bentuk yang benar: dua section bersebelahan
    // dibungkus `.pair`, jadi hanya keduanya yang punya order eksplisit.
    const css = readFileSync(join(repoRoot, "web", "part-04-sections.css"), "utf8")
    expect(css).toContain("body.home .pair { display: flex; flex-direction: column; }")
    // Flex item menyusut ke lebar konten (margin:auto menonaktifkan stretch):
    // dulu #tugas menyempit 1080→616px di KEDUA varian — geometri kontrol
    // ikut berubah. width:100% mengembalikan lebar section.
    expect(css).toContain("body.home .pair > section { width: 100%; }")
    expect(css).toMatch(/body\.home \.pair > #cara-kerja \{ order: 1; \}/)
    expect(css).toMatch(/body\.home \.pair > #tugas \{ order: 2; \}/)
    // Varian B = penukaran, bukan hapus urutan: kedua selector harus ada.
    expect(css).toMatch(/html\[data-order="b"\] body\.home \.pair > #cara-kerja \{ order: 2; \}/)
    expect(css).toMatch(/html\[data-order="b"\] body\.home \.pair > #tugas \{ order: 1; \}/)
    // `main` sendiri TIDAK boleh jadi flex — itu bentuk bug di atas.
    expect(css).not.toMatch(/body\.home main\s*\{/)

    const site = join(repoRoot, "site")
    if (!existsSync(site)) return
    const index = readFileSync(join(site, "index.html"), "utf8")
    // DOM tetap urutan kanonik A (cara-kerja sebelum tugas) apa pun variannya:
    // itu yang dibaca crawler, screen reader, dan pengguna tanpa JS.
    expect(index.indexOf('id="cara-kerja"')).toBeLessThan(index.indexOf('id="tugas"'))
    expect(index).toContain('<div class="pair">')
    // Section tanpa id tak bisa dilaporkan (jangkauan per-section) — semua
    // section landing yang diukur wajib punya id.
    for (const id of ["cara-kerja", "tugas", "fitur", "cocok", "batasan", "faq"]) {
      expect(index, id).toContain(`id="${id}"`)
    }
  })

  test("guard: penetapan varian pre-paint + kunci sama dengan app.js", () => {
    // Tanpa penetapan di <head>, pengguna melihat varian A lalu berkedip ke B
    // (app.js deferred) — dan eksperimennya jadi tidak sah: yang diukur adalah
    // versi yang di-render, bukan yang dijanjikan. Kunci localStorage harus
    // sama di layout dan app.js (pola yang sama dengan tema).
    const layout = readFileSync(join(repoRoot, "web", "layout.html"), "utf8")
    expect(layout).toContain("minicode-exp-order")
    expect(layout).toContain('setAttribute("data-order"')
    expect(layout.indexOf("minicode-exp-order")).toBeLessThan(layout.indexOf("stylesheet"))
    const app = readFileSync(join(repoRoot, "web", "app.js"), "utf8")
    expect(app).toContain("minicode-exp-order")
    // Varian harus acak 50/50 hanya bila belum pernah ditetapkan.
    expect(layout).toContain('o!=="a"&&o!=="b"')
    expect(layout).toContain("Math.random()<0.5")
  })

  test("guard: analitik eksperimen LOKAL — nol request keluar, DNT dihormati", () => {
    // Janji situs: "tanpa analitik keluar" (FAQ landing). Guard ini yang
    // menegakkannya untuk eksperimen: tidak ada jalur kirim apa pun.
    const app = readFileSync(join(repoRoot, "web", "app.js"), "utf8")
    for (const api of ["fetch(", "XMLHttpRequest", "sendBeacon", "new Image(", "document.cookie"]) {
      expect(app, api).not.toContain(api)
    }
    // Data disimpan lokal + opt-out eksplisit.
    expect(app).toContain('"minicode-exp-v1"')
    expect(app).toContain("doNotTrack")
    expect(app).toContain("minicode-exp-off")
    // Pengukuran hanya di landing dan tidak saat dipaksa/param laporan.
    expect(app).toContain('document.body.classList.contains("home")')
    expect(app).toContain("if (land && !off && !dnt && !cmd && !forced)")
    // Pengukuran yang bisa diandalkan: flush idempoten per sesi (dulu hanya di
    // pagehide → pembacaan panjang setelah ganti-tab hilang) + milestone 25%.
    expect(app).toContain("nextMark += 25")
    expect(app).toContain("db.sessions[at] = s")
    // Laporan lokal + reset benar-benar menghapus data.
    expect(app).toContain('cmd === "report"')
    expect(app).toContain('cmd === "reset"')
    expect(app).toContain('localStorage.removeItem("minicode-exp-order")')
  })

  test("guard: menu docs mobile mulai tertutup (konten dulu)", () => {
    // Bug yang dijaga: <details open> di markup membuat ponsel membuka 27 link
    // DI ATAS isi halaman — konten jadi tak pertama. JS menutupnya hanya di
    // layar kecil; tanpa JS markup tetap terbuka (degradasi jujur).
    const app = readFileSync(join(repoRoot, "web", "app.js"), "utf8")
    expect(app).toContain("if (!desktopNav.matches) fold.open = false;")
  })

  test("guard: scrollbar disembunyikan tanpa mematikan fungsi gulir", () => {
    // Permintaan desain 2026-09-17: trek+thumb native terlihat tidak flat —
    // tampilannya dihapus, fungsinya tetap. Bug yang dijaga: (a) scrollbar
    // hanya ditipiskan (`thin`) sehingga masih kelihatan, (b) aturan lama
    // (thumb/scrollbar-color) ikut di-commit dan menang urutan, (c) container
    // yang memang harus menggulir ikut dimatikan `overflow: hidden` sehingga
    // isinya tak bisa dijangkau sama sekali.
    const base = readFileSync(join(repoRoot, "web", "part-01-base.css"), "utf8")
    expect(base).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*none/)
    expect(base).toMatch(/::-webkit-scrollbar\s*\{[^}]*display:\s*none/)
    expect(base).toContain("-ms-overflow-style: none")
    expect(base).not.toContain("scrollbar-width: thin")
    expect(base).not.toContain("scrollbar-color")
    expect(base).not.toMatch(/::-webkit-scrollbar-thumb/)

    // Fungsi gulir tetap: kode, tabel docs, dan menu docs tak boleh dimatikan.
    const docs = readFileSync(join(repoRoot, "web", "part-05-docs-blog.css"), "utf8")
    expect(base).toMatch(/pre\s*\{[^}]*overflow-x:\s*auto/)
    expect(docs).toMatch(/\.doc-body table,[^{]*\{[^}]*overflow-x:\s*auto/)
    expect(docs).toMatch(/\.doc-side\s*\{[^}]*overflow-y:\s*auto/)
    expect(docs).not.toMatch(/\.doc-side[^{]*\{[^}]*overflow-y:\s*hidden/)
  })

  test("desc meta tiap halaman: 50-160 char, tak terpotong di tengah kalimat", () => {
    // Guard SEO on-page (riset 2026-09-17): desc < 50 char boros hasil SERP,
    // > 160 terpotong Google, dan potongan otomatis yang terpotong di tengah
    // kalimat terlihat rusak di hasil pencarian. admin.html noindex — desc
    // memang kosong.
    const site = join(repoRoot, "site")
    if (!existsSync(site)) return // build belum jalan — checker CI yang jaga
    const descCache: string[] = []
    const walk = (d: string): void => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, f.name)
        if (f.isDirectory()) walk(p)
        else if (f.name.endsWith(".html") && f.name !== "admin.html")
          descCache.push(readFileSync(p, "utf8"))
      }
    }
    walk(site)
    const descOf = (html: string): string | null =>
      /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? null
    const admin = descOf(readFileSync(join(site, "admin.html"), "utf8"))
    expect(admin).toBeNull() // noindex: sengaja tanpa desc
    for (const html of descCache) {
      const desc = descOf(html)
      expect(desc, "desc meta wajib ada").not.toBeNull()
      expect(desc!.length, desc!).toBeGreaterThanOrEqual(50)
      expect(desc!.length, desc!).toBeLessThanOrEqual(160)
      // Tak terpotong di tengah kalimat: potongan yang sehat berakhir di
      // tanda baca/penutup, bukan huruf/koma buka.
      expect(desc!, desc!).toMatch(/[.!?»)"]$/u)
    }
  })
})
