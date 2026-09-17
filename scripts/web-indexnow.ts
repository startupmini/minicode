#!/usr/bin/env bun
// Submit semua URL di site/sitemap.xml ke IndexNow (Bing/Yandex/Seznam —
// ping sitemap Google/Bing sudah mati 2025: /ping 404 & 410, terbukti saat
// riset discoverability). URL yang sama boleh dikirim ulang; IndexNow
// mendebounce.
//
// Pre-req: `bun run web:build` + key file sudah LIVE di produksi (deploy
// dulu) — protokol memvalidasi GET /<key>.txt di host; mengirim dengan key
// yang belum live hanya menghasilkan pengiriman yang dibuang.
//
// Usage:
//   bun run web:indexnow            # submit ke host produksi (dari CNAME)
//   bun run web:indexnow --dry-run  # tampilkan URL & validasi, tanpa POST
import { readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..")
const siteDir = join(repoRoot, "site")
const DRY = process.argv.includes("--dry-run")

function fail(msg: string): never {
  console.error(`[web:indexnow] ${msg}`)
  process.exit(1)
}

// Host = CNAME hasil build (file yang membuat binding domain Pages) — satu
// sumber dengan deploy, bukan konstanta yang bisa beda dari site/.
let host = ""
try {
  host = readFileSync(join(siteDir, "CNAME"), "utf8").trim()
} catch {
  fail("site/CNAME tidak ada — jalankan `bun run web:build` dulu")
}
const base = `https://${host}`

const sm = readFileSync(join(siteDir, "sitemap.xml"), "utf8")
const urls = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)
if (urls.length === 0) fail("sitemap.xml tidak memuat URL — build rusak atau stale")
const asing = urls.filter((u) => !u.startsWith(`${base}/`))
if (asing.length > 0) fail(`sitemap memuat URL di luar ${base}: ${asing.slice(0, 3).join(", ")}`)

const key = readFileSync(join(repoRoot, "web", "indexnow-key.txt"), "utf8").trim()

console.log(`[web:indexnow] host ${host} · ${urls.length} URL dari sitemap · dry-run=${DRY}`)
if (DRY) {
  for (const u of urls) console.log(`  ${u}`)
  process.exit(0)
}

// Sanity pre-flight: key file yang ter-deploy harus cocok dengan sumber.
// Mismatch = build belum di-deploy — kirim sekarang hanya sia-sia.
const keyUrl = `${base}/${key}.txt`
const kf = await fetch(keyUrl)
if (!kf.ok || (await kf.text()).trim() !== key) {
  fail(`key file tidak cocok di ${keyUrl} — deploy dulu (bun run web:build + push), lalu ulangi`)
}

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host, key, urlList: urls }),
})
if (res.status === 200 || res.status === 202) {
  console.log(`[web:indexnow] OK ${res.status} — ${urls.length} URL dikirim ke IndexNow`)
} else {
  fail(`IndexNow menolak (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
}
