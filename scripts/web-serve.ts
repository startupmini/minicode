// Server preview lokal untuk site/ (bukan untuk produksi).
// Mengapa file sendiri: `bun --hot` butuh entry yang serve folder site/
// dengan fallback .html rapi + header no-cache agar edit CSS langsung terlihat.
import { join, relative, sep } from "node:path"

const repoRoot = join(import.meta.dir, "..")
const siteDir = join(repoRoot, "site")
const port = Number(process.env.PORT ?? 3000)

/** Tolak path yang lolos dari site/ (`/../`, encoded `..`) — 404, bukan baca.
 * Diekspor untuk test (pola repo: pure/diekspor-untuk-test). Catatan jujur:
 * URL WHATWG sudah menormalkan `..` (termasuk `%2e`) sebelum sampai ke sini,
 * jadi guard ini defense-in-depth untuk client non-konforman / perubahan stack. */
export function isPathWithinSite(p: string): boolean {
  const norm = join(siteDir, p)
  const rel = relative(siteDir, norm)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith("../"))
}

export default {
  port,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    let path = decodeURIComponent(url.pathname)
    if (path.endsWith("/")) path += "index.html"
    if (!isPathWithinSite(path)) return new Response("not found", { status: 404 })
    const file = Bun.file(join(siteDir, path))
    if (await file.exists()) {
      return new Response(file, { headers: { "Cache-Control": "no-store" } })
    }
    // Fallback rapi: /docs/cli -> /docs/cli.html ; sisanya 404.html.
    const withHtml = Bun.file(join(siteDir, `${path}.html`))
    if (await withHtml.exists()) return new Response(withHtml)
    const notFound = Bun.file(join(siteDir, "404.html"))
    return new Response(notFound, { status: 404 })
  },
}
console.log(`[web-serve] http://localhost:${port} <- site/`)
