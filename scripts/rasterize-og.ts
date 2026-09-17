// Rasterisasi web/og-image.svg → site/og-image.png (1200×630).
// Mengapa perlu (audit web P2-10): kebanyakan crawler kartu sosial
// (Facebook/LinkedIn/WhatsApp/Slack) tidak merender SVG — og:image SVG
// menghasilkan kartu kosong. PNG statis menutup itu. Gagal render TIDAK
// membatalkan build: SVG tetap di-copy sebagai fallback (degradasi jujur).
import { readFileSync } from "node:fs"
import { join } from "node:path"

export async function rasterizeOg(webDir: string, siteDir: string): Promise<"ok" | "skip"> {
  try {
    // Import dinamis: modul native hanya dibutuhkan saat build, bukan test.
    const { Resvg } = await import("@resvg/resvg-js")
    const svg = readFileSync(join(webDir, "og-image.svg"), "utf8")
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
    const png = resvg.render().asPng()
    await Bun.write(join(siteDir, "og-image.png"), png)
    return "ok"
  } catch (e) {
    console.warn(
      `[web-build] og:image PNG dilewati (${(e as Error).message}) — SVG fallback tetap ada`,
    )
    return "skip"
  }
}
