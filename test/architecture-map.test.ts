// Penjaga peta arsitektur aktif. Peta ringkas ada di docs/architecture.md;
// manifest source kernel tetap kanonik di vendor/minicore/VENDOR.md.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = process.cwd()

describe("peta arsitektur aktif (docs/architecture.md)", () => {
  test("mencatat boundary lapisan dan jalur produksi utama", () => {
    const markdown = readFileSync(join(repoRoot, "docs/architecture.md"), "utf8")
    for (const path of [
      "cli/index.ts",
      "cli/setup.ts",
      "src/ui/contract.ts",
      "src/providers/provision.ts",
      "src/session/persistence.ts",
      "src/daemon/",
      "vendor/minicore",
    ]) {
      expect(markdown).toContain(path)
    }
  })

  test("pin kernel di peta sinkron dengan manifest vendor", () => {
    const vendor = readFileSync(join(repoRoot, "vendor/minicore/VENDOR.md"), "utf8")
    const short = /source commit: `([0-9a-f]{7})/.exec(vendor)?.[1]
    expect(short).toBeTruthy()
    const markdown = readFileSync(join(repoRoot, "docs/architecture.md"), "utf8")
    expect(markdown).toContain(`\`${short}\``)
  })
})
