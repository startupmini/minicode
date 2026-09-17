// llms-full.txt (llmstxt.org): KORPUS PENUH markdown — komplemen llms.txt
// (peta). llms.txt memandu model memilih halaman; llms-full.txt memuat semua
// isi sekaligus untuk agent yang lebih suka satu fetch daripada berkali-kali
// (dokumentasi ≈ 150 KB — murah untuk satu konteks agent).
//
// Kontrak anti-stale: digenerate saat build dari SUMBER yang sama dengan
// sitemap (SUMMARY.md → readDocNav + body markdown apa adanya). Judul tiap
// bagian = entri SUMMARY + slug, dan URL kanonik HTML ditulis di tiap bagian
// supaya agent bisa mengutip/mengunjungi versi web. Status eksekusi
// (PLAN.md) dan blog ikut — dua konten hidup yang paling sering ditanya.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { readDocNav } from "./nav.ts"
import { mdLinksAbsolute } from "./page.ts"

export function buildLlmsFullTxt(repoRoot: string, base: string, version: string): string {
  const out: string[] = [
    "# Minicode",
    "",
    `> Coding agent CLI shell-native: semua kerja terlihat di scrollback, tiap aksi sensitif lewat izin Anda. MIT, zero-dep, di atas kernel MiniCore. v${version}.`,
    "",
    `Install: npm install -g minicode-ai · Repo: https://github.com/startupmini/minicode · Situs: ${base}/`,
    "",
    "Dokumen ini adalah seluruh dokumentasi dalam satu file markdown (llms-full.txt).",
    "Versi per halaman: lihat llms.txt. Sumber HTML kanonik: minicode.fun.",
    "",
  ]
  for (const e of readDocNav(repoRoot)) {
    const raw = readFileSync(join(repoRoot, "docs", e.file), "utf8")
    const href = e.slug === "readme" ? `${base}/docs/` : `${base}/docs/${e.slug}.html`
    out.push(
      `---`,
      "",
      `# ${e.title}`,
      "",
      `> Sumber HTML: ${href}`,
      "",
      mdLinksAbsolute(raw.trim(), base),
      "",
    )
  }
  // Status eksekusi (digenerate jadi /docs/changelog.html) — bagian hidup.
  const plan = readFileSync(join(repoRoot, "PLAN.md"), "utf8")
  const status = plan.split("## Status eksekusi")[1]
  if (status) {
    const body = mdLinksAbsolute(status.trim(), base)
    out.push(
      "---",
      "",
      "# Status eksekusi & changelog",
      "",
      `> Sumber HTML: ${base}/docs/changelog.html`,
      "",
      body,
      "",
    )
  }
  return out.join("\n")
}
