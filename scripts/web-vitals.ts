// Core Web Vitals via CrUX (PSI API, endpoint record "vitals") — fase 3
// checklist rilis web (web/README.md). Tanpa dependensi: fetch bawaan Bun.
// CrUX = data field 28 hari + ambang volume; situs kecil sering "no data" —
// skrip jatuh ke Lighthouse lab (PSI menyertakannya) dan MENANDAI sumbernya.
// Jangan dicampur: field p75 = kriteria rilis, lab = diagnostik.
//
// Pakai: MINICODE_PSI_KEY=… bun run web:vitals   (tanpa key: kuota publik)
const ORIGIN = "https://minicode.fun"
const API = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
const GOOD = { LCP: 2500, INP: 200, CLS: 0.1 } as const

type Metric = { percentile: number; source: "field" | "lab" }

function verdict(name: keyof typeof GOOD, m: Metric): string {
  const good = name === "CLS" ? m.percentile <= GOOD.CLS : m.percentile < GOOD[name]
  const poor = name === "CLS" ? m.percentile > 0.25 : m.percentile > (name === "LCP" ? 4000 : 500)
  return `${m.percentile}${name === "CLS" ? "" : " ms"} [${m.source}] ${
    good ? "GOOD" : poor ? "POOR" : "NEEDS-IMPROVEMENT"
  }`
}

async function psi(url: string): Promise<any> {
  const key = process.env.MINICODE_PSI_KEY
  const res = await fetch(
    `${API}?url=${encodeURIComponent(url)}&strategy=mobile${key ? `&key=${key}` : ""}`,
  )
  if (!res.ok) throw new Error(`PSI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

function fieldMetrics(lh: any): Metric[] | null {
  const rec = lh.loadingExperience?.metrics
  if (lh.loadingExperience?.overall_category === "NONE" || !rec?.LARGEST_CONTENTFUL_PAINT_MS)
    return null
  return [
    { percentile: rec.LARGEST_CONTENTFUL_PAINT_MS.percentile, source: "field" },
    { percentile: rec.INTERACTION_TO_NEXT_PAINT?.percentile ?? 0, source: "field" },
    { percentile: rec.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100, source: "field" },
  ]
}

function labMetrics(lh: any): Metric[] {
  const a = lh.lighthouseResult?.audits
  const num = (id: string) => Math.round(Number(a?.[id]?.numericValue ?? 0))
  return [
    { percentile: num("largest-contentful-paint"), source: "lab" },
    { percentile: num("total-blocking-time"), source: "lab" }, // lab tak punya INP — TBT proksinya
    {
      percentile: Number((a?.["cumulative-layout-shift"]?.numericValue ?? 0).toFixed(3)),
      source: "lab",
    },
  ]
}

const lh = await psi(ORIGIN).catch((e: Error) => {
  const quota = e.message.includes("429")
  console.error(
    `[web-vitals] PSI gagal: ${e.message}\n` +
      (quota
        ? "  Kuota publik anonim habis — buat API key gratis (Google Cloud → " +
          "Pagespeed Online API) lalu MINICODE_PSI_KEY=… bun run web:vitals\n" +
          "  Alternatif tanpa key: https://pagespeed.web.dev/analysis?url=" +
          encodeURIComponent(ORIGIN) +
          " (UI)"
        : "  Cek jaringan/URL, lalu ulangi."),
  )
  process.exit(1)
})
const names = ["LCP", "INP", "CLS"] as const
const field = fieldMetrics(lh)
const metrics = field ?? labMetrics(lh)
const rows = names.map((n, i) => `  ${n}: ${verdict(n, metrics[i]!)}`)
console.log(
  `${ORIGIN} — ${field ? "CrUX FIELD p75 (28 hari, kriteria rilis)" : "LAB ONLY (CrUX: belum ada data — situs baru/belum ada trafik; cek ulang setelah trafik mengalir)"}`,
)
console.log(rows.join("\n"))

export {}
