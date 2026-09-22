// Test dialog in-flow TUI (cli/tui-dialog.ts): approval, tanya teks,
// mini line reader. Tanpa alt-screen sungguhan — deps palsu
// (append/render) + fake TTY untuk byte stdin.

import { afterEach, describe, expect, test } from "bun:test"
import { approvalSummary, readMiniLine, runTuiApproval, runTuiAskText } from "../cli/tui-dialog.ts"
import type { TuiInputBox } from "../src/ui/tui/input.ts"
import { type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
  delete process.env.MINICODE_BELL
})

interface DepsLog {
  appended: string[]
  renders: number
  boxes: (TuiInputBox | null)[]
  deps: {
    append(lines: string[]): void
    render(): void
    ensureRaw(): void
    setInputBox(b: TuiInputBox | null): void
  }
}

function deps(): DepsLog {
  const d: DepsLog = {
    appended: [],
    renders: 0,
    boxes: [],
    deps: undefined as never,
  }
  d.deps = {
    append: (lines) => {
      d.appended.push(...lines)
    },
    render: () => {
      d.renders++
    },
    ensureRaw: () => {},
    setInputBox: (b) => {
      d.boxes.push(b)
    },
  }
  return d
}

describe("approvalSummary", () => {
  test("command/path/query/json + sanitasi ANSI", () => {
    expect(approvalSummary({ command: "rm -rf /tmp/x" })).toBe("Command: rm -rf /tmp/x")
    expect(approvalSummary({ path: "a/b.ts" })).toBe("File: a/b.ts")
    expect(approvalSummary({ query: "cari todo" })).toBe("Query: cari todo")
    expect(approvalSummary({ k: 1 })).toBe('Args: {"k":1}')
    expect(approvalSummary({ command: "x\x1b[2J" })).not.toContain("[2J")
    expect(approvalSummary(undefined)).toBe("Args: {}")
  })
})

describe("runTuiApproval", () => {
  test("y → allow; blok mencantumkan tool + kunci", async () => {
    tty = installFakeTty()
    const d = deps()
    const p = runTuiApproval(d.deps, { name: "bash", args: { command: "ls" } })
    await tty.send("y")
    await expect(p).resolves.toBe("allow")
    const plain = d.appended.join("\n")
    expect(plain).toContain("Approval required")
    expect(plain).toContain("bash")
    expect(plain).toContain("[y]")
    expect(plain).toContain("→ allow")
    expect(d.renders).toBeGreaterThan(0)
  })

  test("a → always; n/Esc/Enter/lain → deny", async () => {
    for (const [key, want] of [
      ["a", "always"],
      ["A", "always"],
      ["n", "deny"],
      ["\x1b", "deny"],
      ["\r", "deny"],
      ["x", "deny"],
      ["\x03", "deny"],
    ] as const) {
      tty = installFakeTty()
      const d = deps()
      try {
        const p = runTuiApproval(d.deps, { name: "write_file", args: { path: "f" } })
        await tty.send(key)
        await expect(p).resolves.toBe(want)
      } finally {
        tty?.restore()
        tty = undefined
      }
    }
  })
})

describe("readMiniLine", () => {
  test("ketik + Enter → teks; box overlay dipasang-dilepas", async () => {
    tty = installFakeTty()
    const d = deps()
    const p = readMiniLine(d.deps, "Q> ")
    await tty.send("12\r")
    await expect(p).resolves.toBe("12")
    // Overlay dipasang saat baca, dilepas sesudahnya.
    expect(d.boxes.length).toBeGreaterThanOrEqual(2)
    expect(d.boxes[0]).not.toBeNull()
    expect(d.boxes[d.boxes.length - 1]).toBeNull()
  })

  test("Esc/Ctrl+C → null", async () => {
    for (const key of ["\x1b", "\x03"]) {
      tty = installFakeTty()
      const d = deps()
      try {
        const p = readMiniLine(d.deps, "Q> ")
        await tty.send(key)
        await expect(p).resolves.toBeNull()
      } finally {
        tty?.restore()
        tty = undefined
      }
    }
  })
})

describe("runTuiAskText", () => {
  test("blok pertanyaan + opsi; jawaban di-trim; kosong/Esc = null", async () => {
    tty = installFakeTty()
    const d = deps()
    const p = runTuiAskText(d.deps, "Lanjut?", ["ya", "tidak"])
    await tty.send("ya\r")
    await expect(p).resolves.toBe("ya")
    const plain = d.appended.join("\n")
    expect(plain).toContain("Lanjut?")
    expect(plain).toContain("ya")
    expect(plain).toContain("tidak")

    const d2 = deps()
    const p2 = runTuiAskText(d2.deps, "Lanjut?")
    await tty.send("\r")
    await expect(p2).resolves.toBeNull()
  })
})
