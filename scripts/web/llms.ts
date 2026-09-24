// llms.txt (llmstxt.org): peta markdown untuk AI-crawler — kanal discovery
// 2026 di samping sitemap (riset SEO 2026-09-17). Digenerate saat build dari
// SUMBER yang sama dengan sitemap & meta description halaman (SUMMARY.md +
// DOC_META, fallback firstPara) agar tidak stale.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { firstPara } from "./fm.ts"
import { docMeta, readDocNav } from "./nav.ts"

export function buildLlmsTxt(repoRoot: string, base: string, version: string): string {
  const lines: string[] = [
    "# Minicode",
    "",
    `> Coding agent CLI: jalur non-interaktif shell-first (kerja terlihat di scrollback), interaktif TUI fullscreen; tiap aksi sensitif lewat izin Anda. MIT, zero-dep, di atas kernel MiniCore. v${version}.`,
    "",
    "## Docs",
    "",
  ]
  for (const e of readDocNav(repoRoot)) {
    const raw = readFileSync(join(repoRoot, "docs", e.file), "utf8")
    // Audit SEO LLMS-01 (2026-09-24): utamakan deskripsi kurasi DOC_META —
    // sumber yang SAMA dengan meta description halaman, jadi AI-crawler dan
    // SERP melihat ringkasan yang konsisten. Cuplikan firstPara mentah sering
    // berupa detail teknis terselak (baris tabel "Gateway > …") atau terpotong
    // di tengah kata saat di-slice. firstPara tetap fallback untuk slug yang
    // belum dikurasi (generic `Dokumentasi Minicode: <slug>.`).
    const curated = docMeta(e.slug).desc
    const desc = (curated === `Dokumentasi Minicode: ${e.slug}.` ? firstPara(raw) : curated).trim()
    const href = e.slug === "readme" ? `${base}/docs/` : `${base}/docs/${e.slug}.html`
    lines.push(`- [${e.title}](${href})${desc ? `: ${desc}` : ""}`)
  }
  lines.push(
    "",
    "## Blog",
    "",
    `- [Blog](${base}/blog/): tulisan pendek soal desain coding agent yang bekerja di terminal.`,
    "",
    "## Changelog",
    "",
    `- [Changelog](${base}/docs/changelog.html): riwayat rilis dan status eksekusi, digenerate dari PLAN.md.`,
    "",
  )
  return lines.join("\n")
}
