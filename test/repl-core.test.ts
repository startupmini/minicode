// Test unit fungsi murni orkestrasi REPL bersama (cli/repl-core.ts).
// Dipindah dari test/repl-linear.test.ts saat driver linier dihapus —
// fungsinya dipakai driver TUI, jadi testnya tetap hidup di sini.

import { describe, expect, test } from "bun:test"
import { applyBusyKey, suggestSimilar } from "../cli/repl-core.ts"

describe("repl-core: did-you-mean", () => {
  test("suggestSimilar: typo dekat disarankan, asing tidak", async () => {
    const cmds = ["help", "model", "sessions", "resume"]
    expect(suggestSimilar("modle", cmds)).toBe("model")
    expect(suggestSimilar("sessons", cmds)).toBe("sessions")
    expect(suggestSimilar("xyzabc", cmds)).toBeUndefined()
  })
})

describe("repl-core: applyBusyKey", () => {
  test("+ / - / Ctrl+T / Ctrl+C selama turn", () => {
    expect(applyBusyKey(0x03, "thinking")).toEqual({ action: "abort" })
    expect(applyBusyKey(0x2b, null)).toEqual({
      action: "toggle-section",
      kind: "tool",
      expand: true,
    })
    expect(applyBusyKey(0x3d, "thinking")).toEqual({
      action: "toggle-section",
      kind: "thinking",
      expand: true,
    })
    expect(applyBusyKey(0x2d, "tool")).toEqual({
      action: "toggle-section",
      kind: "tool",
      expand: false,
    })
    expect(applyBusyKey(0x5f, null)).toEqual({
      action: "toggle-section",
      kind: "tool",
      expand: false,
    })
    expect(applyBusyKey(0x14, "thinking")).toEqual({ action: "toggle-thinking" })
    expect(applyBusyKey(0x41, "thinking")).toBeNull()
  })
})
