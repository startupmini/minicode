// Regresi bug Bun Windows: `stderr.write` yang dipanggil detached
// (bukan method-call) melempar
// `TypeError: undefined is not an object (evaluating 'kWriteMonkeyPatchDefense')`
// dari internal writeFast — di produksi tiap turn REPL/TTY gagal total
// padahal one-shot non-TTY hijau (repro: repro-tty.ts, stack paintWrite).
// Kontrak: transient best-effort (I4) — painter tak boleh menggagalkan turn.

import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetTransientForTest,
  acquireTransientPaint,
  isTransientDisabled,
  isTransientPainting,
  paintWrite,
} from "../src/ui/runtime/statusline.ts"

const MARKER = "undefined is not an object (evaluating 'kWriteMonkeyPatchDefense')"

const realWrite = process.stderr.write.bind(process.stderr)

afterEach(() => {
  try {
    process.stderr.write = realWrite as typeof process.stderr.write
  } catch {}
  __resetTransientForTest()
})

/** Fake ala Bun Windows rusak: detached (this !== stderr) langsung melempar. */
function installDetachedThrowingFake(recorded: string[]): void {
  __resetTransientForTest()
  function fake(this: unknown, chunk: string | Uint8Array): boolean {
    if (this !== process.stderr) throw new TypeError(MARKER)
    recorded.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }
  process.stderr.write = fake as typeof process.stderr.write
}

describe("statusline bun-windows guard", () => {
  test("paintWrite tanpa owner pakai method-call — tidak melempar di stderr rusak", () => {
    const recorded: string[] = []
    installDetachedThrowingFake(recorded)
    // Jalur persis repro produksi: stopPaint→paintWrite SEBELUM acquire apa pun
    // (ourWrite null → dulu `cur(s)` detached → TypeError tiap turn).
    expect(() => paintWrite("\r\x1b[2K")).not.toThrow()
    expect(recorded.join("")).toContain("\x1b[2K")
    expect(isTransientDisabled()).toBe(false)
  })

  test("lifecycle painter penuh (acquire→paint→release) tanpa throw di stderr rusak", () => {
    const recorded: string[] = []
    installDetachedThrowingFake(recorded)
    const t = acquireTransientPaint("turn", () => {})
    expect(isTransientPainting()).toBe(true)
    expect(() => paintWrite("\r✦")).not.toThrow()
    // Tulis asing saat painter aktif (jalur wrapper) juga tidak melempar.
    expect(() => process.stderr.write("[warn] x\n")).not.toThrow()
    expect(() => t.release()).not.toThrow()
    expect(recorded.join("")).toContain("✦")
    expect(isTransientDisabled()).toBe(false)
  })

  test("stderr yang rusak total → transient self-disable, write asli di-restore", () => {
    const recorded: string[] = []
    __resetTransientForTest()
    function alwaysBroken(this: unknown, _chunk: string | Uint8Array): boolean {
      void _chunk
      throw new TypeError(MARKER)
    }
    process.stderr.write = alwaysBroken as typeof process.stderr.write
    // Tak boleh melempar walau sink mati total.
    expect(() => paintWrite("x")).not.toThrow()
    expect(isTransientDisabled()).toBe(true)
    expect(isTransientPainting()).toBe(false)
    // Klaim berikutnya jadi no-op (painter "jalan" tanpa byte).
    const t = acquireTransientPaint("turn", () => {
      throw new Error("must never paint when disabled")
    })
    expect(() => t.release()).not.toThrow()
    // Write asli (fake rusak) dikembalikan — bukan wrapper yatim.
    expect((process.stderr.write as unknown) === alwaysBroken).toBe(true)
    expect(recorded).toEqual([])
  })
})
