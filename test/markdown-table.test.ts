import { afterEach, describe, expect, test } from "bun:test"
import { runAcpSession } from "../cli/commands/acp.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import {
  MarkdownTableStream,
  parseMarkdownBlocks,
  parseMarkdownTable,
} from "../src/ui/render/markdown-table.ts"
import { renderTable } from "../src/ui/render/table.ts"
import { renderGridTable } from "../src/ui/render/table-grid.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined

afterEach(() => {
  tty?.restore()
  tty = undefined
})

const nl = "\n"
const tick = String.fromCharCode(96)

describe("markdown table parser", () => {
  test("optional outer pipes, escape, code span run, alignment", () => {
    const source = [
      `A | B | ${tick}literal|inside${tick}`,
      ":--- | ---: | :---:",
      `one \\| two | ${tick.repeat(2)}code|span${tick.repeat(2)} | three`,
    ].join(nl)
    const table = parseMarkdownTable(source)
    expect(table?.headers).toEqual(["A", "B", `${tick}literal|inside${tick}`])
    expect(table?.rows).toEqual([
      ["one | two", `${tick.repeat(2)}code|span${tick.repeat(2)}`, "three"],
    ])
    expect(table?.aligns).toEqual(["left", "right", "center"])
  })

  test("malformed delimiter and prose are not tables", () => {
    expect(parseMarkdownTable(["A | B", "-- | x", "one | two"].join(nl))).toBeNull()
    expect(parseMarkdownTable("ordinary prose | without delimiter")).toBeNull()
    expect(parseMarkdownTable(["    | A | B |", "    | --- | --- |"].join(nl))).toBeNull()
    const blocks = parseMarkdownBlocks(["A | B", "-- | x", "one | two"].join(nl))
    expect(blocks.every((block) => block.type === "text")).toBe(true)
  })

  test("fence content is excluded even when it looks like a table", () => {
    const source = [
      `${tick.repeat(3)}ts`,
      "| a | b |",
      "| --- | ---: |",
      "| code | row |",
      `${tick.repeat(3)}`,
      "| real | table |",
      "| --- | --- |",
      "| yes | ok |",
    ].join(nl)
    const tables = parseMarkdownBlocks(source)
      .filter((block) => block.type === "table")
      .map((block) => block.table)
    expect(tables).toHaveLength(1)
    expect(tables[0]?.headers).toEqual(["real", "table"])
  })

  test("stream fallback preserves malformed candidate lines", () => {
    const stream = new MarkdownTableStream()
    const events = [
      ...stream.push("prosa | kali\n"),
      ...stream.push("bukan delimiter\n"),
      ...stream.flush(),
    ]
    expect(events).toEqual([
      { type: "text", text: "prosa | kali\n" },
      { type: "text", text: "bukan delimiter\n" },
    ])
  })

  test("stream fence state excludes code rows", () => {
    const source = [
      `${tick.repeat(3)}`,
      "| code | row |",
      "| --- | --- |",
      `${tick.repeat(3)}`,
      "| real | table |",
      "| --- | --- |",
    ].join("\r\n")
    const stream = new MarkdownTableStream()
    const events = [...source].flatMap((part) => stream.push(part)).concat(stream.flush())
    const tables = events.filter((event) => event.type === "table")
    expect(tables).toHaveLength(1)
    expect(tables[0]?.type === "table" ? tables[0].table.headers : []).toEqual(["real", "table"])
  })

  test("stream chunks at every byte produce the same table", () => {
    const esc = String.fromCharCode(27)
    const source = [
      `| ${tick}head|ing${tick} | B |`,
      `| :--- | ---: |`,
      `| 中文 | ${esc}[36mvalue${esc}[0m |`,
      `| a \\| b | ${tick.repeat(2)}x|y${tick.repeat(2)} |`,
    ].join("\r\n")
    const stream = new MarkdownTableStream()
    const events = [...source].flatMap((part) => stream.push(part)).concat(stream.flush())
    const table = events.find((event) => event.type === "table")?.table
    const whole = parseMarkdownTable(source)
    expect(table?.headers).toEqual(whole?.headers)
    expect(table?.rows).toEqual(whole?.rows)
    expect(table?.aligns).toEqual(whole?.aligns)
    expect(table?.source).toBe(whole?.source)
  })
})

describe("grid renderer", () => {
  test("uses column width, alignment, ANSI, and terminal budget", () => {
    const esc = String.fromCharCode(27)
    const output = stripAnsi(
      renderGridTable(
        {
          headers: ["名称", "Right"],
          rows: [
            [`${esc}[36m中文${esc}[0m`, "7"],
            ["abcd", "1234"],
          ],
          aligns: ["left", "right"],
        },
        { width: 32, styleHeader: true },
      ),
    )
    for (const line of output.split(nl)) expect(displayWidth(line)).toBeLessThanOrEqual(32)
    expect(output).toContain("名称")
    expect(output).toContain("1234")
    expect(output).toContain("中文")
  })

  test("narrow fallback is vertical and has no broken pipe row", () => {
    const output = renderGridTable(
      {
        headers: ["A", "B", "C", "D"],
        rows: [["one", "two", "three", "four"]],
      },
      { width: 20, styleHeader: false },
    )
    for (const line of stripAnsi(output).split(nl)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(20)
      expect(line.trimEnd().endsWith("|")).toBe(false)
    }
    expect(output).toContain("A:")
  })

  test("renderTable is a budgeted wrapper", () => {
    const previous = process.stdout.columns
    Object.defineProperty(process.stdout, "columns", { value: 20, configurable: true })
    try {
      const output = stripAnsi(
        renderTable(
          [
            { header: "A", key: "a" },
            { header: "B", key: "b" },
            { header: "C", key: "c" },
            { header: "D", key: "d" },
          ],
          [{ a: "one", b: "two", c: "three", d: "four" }],
        ),
      )
      for (const line of output.split(nl)) expect(displayWidth(line)).toBeLessThanOrEqual(20)
      expect(output).toContain("A: one")
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: previous, configurable: true })
    }
  })
})

describe("linear table streaming", () => {
  test("TTY renders a semantic table and never justifies its cells", () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const bus = createFakeBus()
    const detach = attachSimpleLogger(bus as never, {})
    const source = [
      "before",
      "| Name | Value |",
      "| :--- | ---: |",
      `| ${tick}code|x${tick} | 中文 |`,
      "after",
      "",
    ].join(nl)
    bus.emit("turn:started", { turn: 1 })
    for (const part of source) bus.emit("provider:text", { text: part })
    bus.emit("turn:completed", {})
    const output = stripAnsi(tty.all())
    detach()
    expect(output).toContain("before")
    expect(output).toContain("Name")
    expect(output).toContain("中文")
    expect(output).toContain("after")
    expect(output).not.toContain("`code")
    expect(output).not.toContain("**")
    expect(output).not.toContain("| :--- |")
    for (const line of output.split(nl).filter(Boolean)) {
      if (line.includes("Name") || line.includes("code") || line.includes("after")) continue
      expect(displayWidth(line)).toBeLessThanOrEqual(80)
    }
  })

  test("non-TTY keeps sanitized Markdown source", () => {
    tty = installFakeTty({ columns: 80, rows: 24, isTTY: false, color: false })
    const bus = createFakeBus()
    const detach = attachSimpleLogger(bus as never, {})
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:text", { text: "| A | B |\n| --- | --- |\n| one | two |\n" })
    bus.emit("turn:completed", {})
    const output = tty.all()
    detach()
    expect(output).toContain("| A | B |")
    expect(output).toContain("| one | two |")
    expect(output).not.toContain("───")
    expect(output).not.toContain(String.fromCharCode(27))
  })

  test("abort/detach flushes a table that has no trailing blank line", () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const bus = createFakeBus()
    const detach = attachSimpleLogger(bus as never, {})
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:text", { text: "| A | B |\n| --- | --- |\n| one | two |" })
    detach()
    expect(stripAnsi(tty.all())).toContain("one")
  })
})

describe("machine output policy", () => {
  test("ACP provider delta tetap source Markdown mentah", async () => {
    const source = ["| A | B |", "| --- | --- |", "| one | two |"].join(nl)
    let raw: ((event: unknown) => void) | undefined
    const session = {
      session: {
        events: {
          on(type: string, handler: (event: unknown) => void) {
            if (type === "*") raw = handler
            return () => {}
          },
        },
        state: { stepCount: 1, turnCount: 1 },
      },
      usage: {
        getSession: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      },
      modelRef: { current: "fake::model" },
      runPromptWithVerify: async () => {
        raw?.({ type: "provider:text", text: source })
      },
      close: async () => {},
    }
    const output: string[] = []
    await runAcpSession(
      1,
      { prompt: "x" },
      {
        write: (line) => output.push(line),
        onDone: () => {},
        startFlight: () => {},
        shouldExit: () => false,
        exit: () => {},
        createSession: (async () => session) as never,
      },
    )
    const delta = output
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((note) => note.type === "text")
    expect(delta?.delta).toBe(source)
  })
})

describe("TUI table transcript", () => {
  test("stores semantic table and re-renders at paint width", () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const bus = createFakeBus()
    const transcript = new Transcript(bus as never)
    const source = [
      "| Long header | Another |",
      "| :--- | ---: |",
      "| value-long-long-long | 右值 |",
    ].join(nl)
    for (const part of source) bus.emit("provider:text", { text: part })
    bus.emit("turn:completed", {})
    const wide = transcript.view(80, 8, 0).map(stripAnsi)
    const narrow = transcript.view(30, 8, 0).map(stripAnsi)
    const wideTable = wide.filter(
      (line) => line.includes("Long header") || line.includes("value-long"),
    )
    const narrowTable = narrow.filter(
      (line) => line.includes("Long header") || line.includes("value-long"),
    )
    expect(wideTable.length).toBe(2)
    expect(narrowTable.length).toBe(2)
    expect(narrow.some((line) => line.includes("…"))).toBe(true)
    for (const line of narrow.filter(Boolean)) expect(displayWidth(line)).toBeLessThanOrEqual(30)
    expect(transcript.view(80, 8, 0).map(stripAnsi)).toEqual(wide)
  })

  test("pushInfo table became semantic block", () => {
    const bus = createFakeBus()
    const transcript = new Transcript(bus as never)
    transcript.pushInfo(["| A | B |", "| --- | --- |", "| one | two |"])
    const output = transcript.view(80, 8, 0).map(stripAnsi)
    expect(output.some((line) => line.includes("one"))).toBe(true)
    expect(output.some((line) => line.includes("| A | B |"))).toBe(false)
  })

  test("fence table is not turned into a grid in TUI", () => {
    const bus = createFakeBus()
    const transcript = new Transcript(bus as never)
    const source = [`${tick.repeat(3)}`, "| a | b |", "| --- | --- |", `${tick.repeat(3)}`].join(nl)
    for (const part of source) bus.emit("provider:text", { text: part })
    bus.emit("turn:completed", {})
    expect(transcript.view(80, 10, 0).map(stripAnsi)).toContain("| a | b |")
  })
})
