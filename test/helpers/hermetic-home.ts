// Isolasi `MINICODE_HOME` untuk seluruh file test pemanggil.
//
// Test yang memakai jalur produksi (`createCliSession`, `loadConfig`,
// `buildProviderList`) membaca config GLOBAL mesin (`~/.minicode/config.json` +
// `state.json` lastModel) bila `MINICODE_HOME` tak diset. Di mesin pengembang
// yang punya provider nyata (mis. jerouter) + verifyCommand, kebocoran ini
// membuat:
//   - test fake-provider memanggil API NYATA (lambat/timeout/D5, requestCount 0),
//   - asersi "config global bersih" (local-optin/supply) gagal,
//   - router fallback ke provider global saat provider lokal tak terjangkau
//     (P2.6 "turn gagal cepat" malah resolve).
//
// Ini BUKAN regresi kode — ini kebocoran config global ke test. Perbaikan yang
// benar adalah isolasi PER-FILE (bukan preload global: preload malah merusak
// test yang menulis via `homedir()` langsung, mis. model-manager). Setiap file
// yang membutuhkannya memanggil ini SEKALI di module scope.
import { afterAll, beforeAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function isolateHomeForTests(prefix = "minicode-hermetic-"): string {
  const prev = process.env.MINICODE_HOME
  const home = mkdtempSync(join(tmpdir(), prefix))
  beforeAll(() => {
    process.env.MINICODE_HOME = home
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.MINICODE_HOME
    else process.env.MINICODE_HOME = prev
  })
  return home
}
