// Test runCaptured: kumpulkan SEMUA jalur tulis, restore total (termasuk
// saat fn melempar), tanpa bocor ke output harness.

import { describe, expect, test } from "bun:test"
import { runCaptured } from "../src/ui/tui/capture.ts"
import { type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined
function fresh(): void {
  tty?.restore()
  tty = installFakeTty()
}

describe("runCaptured", () => {
  test("mengumpulkan console.log/error + stdout/stderr.write", async () => {
    fresh()
    try {
      const r = await runCaptured(async () => {
        console.log("satu", "dua")
        console.error("galat!")
        process.stdout.write("mentah-out")
        process.stderr.write(Buffer.from("mentah-err"))
        return 42
      })
      expect(r.value).toBe(42)
      expect(r.out).toContain("satu dua")
      expect(r.out).toContain("mentah-out")
      expect(r.err).toContain("galat!")
      expect(r.err).toContain("mentah-err")
      // Tak ada yang bocor ke output nyata.
      expect(tty!.all()).toBe("")
      expect(tty!.allErr()).toBe("")
    } finally {
      tty?.restore()
      tty = undefined
    }
  })

  test("restore saat fn melempar + error diteruskan", async () => {
    fresh()
    try {
      await expect(
        runCaptured(async () => {
          console.log("sebelum-jatuh")
          throw new Error("jatuh")
        }),
      ).rejects.toThrow("jatuh")
      // Sesudah restore: tulis kembali alami.
      console.log("sesudah-pulih")
      expect(tty!.all()).toBe("sesudah-pulih\n")
    } finally {
      tty?.restore()
      tty = undefined
    }
  })
})
