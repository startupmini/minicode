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
import { buildBlog } from "../scripts/web/blog.ts"
import { parseFrontmatter } from "../scripts/web/fm.ts"
import { mdToHtml } from "../scripts/web/md.ts"
import { readDocNav } from "../scripts/web/nav.ts"
import { softwareJsonld } from "../scripts/web/page.ts"
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
        "<td><code>foo | bar</code></td><td>baz</td>",
      ],
      // C. escaped delimiter
      ["| A | B |\n|---|---|\n| foo \\| bar | baz |\n", "<td>foo | bar</td><td>baz</td>"],
      // D+E. code span + beberapa span per sel (kasus nyata tools.md)
      [
        "| T | C |\n|---|---|\n| `code_run` | Wajib sandbox `os|docker`, `x` |\n",
        "<td>Wajib sandbox <code>os|docker</code>, <code>x</code></td>",
      ],
      // F. kasus nyata cli.md: escaped pipe dalam code
      [
        '| P | F |\n|---|---|\n| `echo "prompt" \\| minicode` | Via pipe |\n',
        "<td><code>echo &quot;prompt&quot; | minicode</code></td><td>Via pipe</td>",
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
      const doc = JSON.parse(m![1]!) as Record<string, unknown>
      expect(typeof doc["@type"]).toBe("string")
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
    // Tepat satu figure proof: SVG inline (tanpa request aset baru).
    expect(index.match(/<figure class="shot"/g)?.length ?? 0).toBe(1)
    expect(index).toContain("<svg")
    expect(index).not.toContain(".png")
    expect(index).not.toContain(".gif")
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
    // Prev/Next di bawah, teks polos, tanpa judul halaman di box.
    const docTools = readFileSync(join(site, "docs", "tools.html"), "utf8")
    expect(docTools).toContain(">‹ Prev<")
    expect(docTools).toContain("Next ›<")
    expect(docTools).not.toContain("Sebelumnya</span>")
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
    // Scrollbar minimal ada; dead selector .tbl/.prov-line tidak kembali.
    expect(code).toContain("scrollbar-width: thin")
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
    // lolos join harus tetap di dalam site/.
    expect(isPathWithinSite("/index.html")).toBe(true)
    expect(isPathWithinSite("/docs/cli.html")).toBe(true)
    expect(isPathWithinSite("/blog/")).toBe(true)
    expect(isPathWithinSite("/../package.json")).toBe(false)
    expect(isPathWithinSite("/docs/../../cli/index.ts")).toBe(false)
    expect(isPathWithinSite("..\\package.json")).toBe(false)
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
      expect((JSON.parse(ld) as { headline?: string }).headline).toBe(
        "a < b </script><script>alert(1)</script> c",
      )
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
    expect(css).toMatch(/\.js\s+\.rv\b/)
    // View transition native (progresif: browser lama abaikan aturan ini).
    expect(css).toContain("@view-transition")
    const app = readFileSync(join(repoRoot, "web", "app.js"), "utf8")
    expect(app).toContain('classList.add("js")')
    expect(app).toContain("IntersectionObserver")
    expect(app).toContain("prefers-reduced-motion")
  })
})
