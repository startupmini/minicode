export type PipeTableAlignment = "left" | "right" | "center"

export interface MarkdownTable {
  headers: string[]
  rows: string[][]
  aligns: PipeTableAlignment[]
  alignments: PipeTableAlignment[]
  source: string
  raw: string
  startLine: number
  endLine: number
}

export type MarkdownBlock =
  | {
      type: "text"
      kind: "text"
      text: string
      startLine: number
      endLine: number
    }
  | {
      type: "table"
      kind: "table"
      table: MarkdownTable
      startLine: number
      endLine: number
    }

export type MarkdownTableStreamEvent =
  | { type: "text"; text: string }
  | { type: "table"; table: MarkdownTable; raw: string }

interface FenceInfo {
  char: string
  len: number
}

interface SplitRow {
  cells: string[]
}

const ESC = String.fromCharCode(27)
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;:]*m`, "g")

function withoutSgr(value: string): string {
  return value.replace(SGR_PATTERN, "")
}

function fenceInfo(line: string): FenceInfo | null {
  const match = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(withoutSgr(line))
  if (!match) return null
  const marker = match[1]!
  return { char: marker[0]!, len: marker.length }
}

function isFenceClose(line: string, fence: FenceInfo): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(withoutSgr(line))
  if (!match) return false
  const marker = match[1]!
  return marker[0] === fence.char && marker.length >= fence.len
}

function isEscapedAt(text: string, index: number): boolean {
  let count = 0
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) count++
  return count % 2 === 1
}

function hasClosingRun(text: string, start: number, length: number): boolean {
  let i = start
  while (i < text.length) {
    if (text[i] !== "`" || isEscapedAt(text, i)) {
      i++
      continue
    }
    let end = i + 1
    while (text[end] === "`") end++
    if (end - i === length) return true
    i = end
  }
  return false
}

function splitPipeRowInternal(line: string, unmatchedCodeIsLiteral: boolean): SplitRow | null {
  const raw = withoutSgr(line.replace(/\r$/, ""))
  if (/^(?: {4,}|\t)/.test(raw)) return null
  const body = raw.replace(/^ {0,3}/, "").trim()
  const cells: string[] = [""]
  let i = 0
  let codeLength = 0
  let hasPipe = false
  while (i < body.length) {
    const ch = body[i]!
    if (ch === "\\" && body[i + 1] === "|" && isEscapedAt(body, i + 1)) {
      cells[cells.length - 1] += body.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === "`" && !isEscapedAt(body, i)) {
      let end = i + 1
      while (body[end] === "`") end++
      const run = body.slice(i, end)
      if (codeLength === 0) {
        if (!unmatchedCodeIsLiteral && hasClosingRun(body, end, run.length)) codeLength = run.length
      } else if (run.length === codeLength) {
        codeLength = 0
      }
      cells[cells.length - 1] += run
      i = end
      continue
    }
    if (ch === "|" && codeLength === 0) {
      hasPipe = true
      cells.push("")
      i++
      continue
    }
    cells[cells.length - 1] += ch
    i++
  }
  if (!hasPipe) return null
  if (body[0] === "|" && cells[0] === "") cells.shift()
  if (
    cells.length > 1 &&
    body.endsWith("|") &&
    cells[cells.length - 1] === "" &&
    !isEscapedAt(body, body.length - 1)
  ) {
    cells.pop()
  }
  return { cells }
}

export function splitPipeRow(line: string): string[] | null {
  return splitPipeRowInternal(line, false)?.cells ?? null
}

export const parseTableRow = splitPipeRow
export const isTableDelimiter = (line: string): boolean => parseDelimiterRow(line) !== null

function unescapeCell(cell: string): string {
  let out = ""
  let codeLength = 0
  let i = 0
  while (i < cell.length) {
    const ch = cell[i]!
    if (ch === "\\" && cell[i + 1] === "|" && isEscapedAt(cell, i + 1) && codeLength === 0) {
      out += "|"
      i += 2
      continue
    }
    if (ch === "`" && !isEscapedAt(cell, i)) {
      let end = i + 1
      while (cell[end] === "`") end++
      const run = cell.slice(i, end)
      if (codeLength === 0) {
        if (hasClosingRun(cell, end, run.length)) codeLength = run.length
      } else if (run.length === codeLength) {
        codeLength = 0
      }
      out += run
      i = end
      continue
    }
    out += ch
    i++
  }
  return out.trim()
}

export function parseDelimiterRow(line: string): PipeTableAlignment[] | null {
  const split = splitPipeRow(line)
  if (!split || split.length === 0) return null
  const aligns: PipeTableAlignment[] = []
  for (const cell of split) {
    const value = cell.trim()
    const match = /^(:)?-{3,}(:)?$/.exec(value)
    if (!match) return null
    aligns.push(match[1] && match[2] ? "center" : match[2] ? "right" : match[1] ? "left" : "left")
  }
  return aligns
}

function makeTable(lines: readonly string[], start: number): MarkdownTable | null {
  const headerSplit = splitPipeRow(lines[start] ?? "")
  if (!headerSplit || headerSplit.length === 0) return null
  const aligns = parseDelimiterRow(lines[start + 1] ?? "")
  if (!aligns || aligns.length !== headerSplit.length) return null
  const headers = headerSplit.map(unescapeCell)
  const rows: string[][] = []
  let end = start + 1
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "") break
    const split = splitPipeRow(line)
    if (!split || split.length !== headers.length) break
    rows.push(split.map(unescapeCell))
    end = i
  }
  const source = lines.slice(start, end + 1).join("\n")
  return {
    headers,
    rows,
    aligns,
    alignments: aligns,
    source,
    raw: source,
    startLine: start,
    endLine: end,
  }
}

function normalizeLines(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

function lineStarts(lines: readonly string[]): number[] {
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  return starts
}

function textBlock(text: string, startLine: number, endLine: number): MarkdownBlock {
  return { type: "text", kind: "text", text, startLine, endLine }
}

function tableBlock(table: MarkdownTable): MarkdownBlock {
  return {
    type: "table",
    kind: "table",
    table,
    startLine: table.startLine,
    endLine: table.endLine,
  }
}

export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const text = normalizeLines(input)
  if (text.length === 0) return []
  const lines = text.split("\n")
  const starts = lineStarts(lines)
  const blocks: MarkdownBlock[] = []
  let cursor = 0
  let i = 0
  let fence: FenceInfo | null = null
  const addText = (end: number, endLine: number): void => {
    if (end <= cursor) return
    const startLine = starts.indexOf(cursor)
    blocks.push(textBlock(text.slice(cursor, end), startLine < 0 ? 0 : startLine, endLine))
    cursor = end
  }
  while (i < lines.length) {
    const line = lines[i]!
    const fenceLine = fenceInfo(line)
    if (fence) {
      if (isFenceClose(line, fence)) fence = null
      i++
      continue
    }
    if (fenceLine) {
      fence = fenceLine
      i++
      continue
    }
    const table = makeTable(lines, i)
    if (table) {
      addText(starts[i]!, Math.max(0, table.startLine - 1))
      blocks.push(tableBlock(table))
      const nextLine = table.endLine + 1
      cursor = nextLine < starts.length ? starts[nextLine]! : text.length
      i = nextLine
      continue
    }
    i++
  }
  if (cursor < text.length) {
    const startLine = starts.indexOf(cursor)
    blocks.push(textBlock(text.slice(cursor), startLine < 0 ? 0 : startLine, lines.length - 1))
  }
  return blocks
}

export function parseMarkdownTable(
  input: string | readonly string[],
  ...extra: (string | number)[]
): MarkdownTable | null {
  const extraLines = extra.filter((value): value is string => typeof value === "string")
  const source = [typeof input === "string" ? input : input.join("\n"), ...extraLines].join("\n")
  return parseMarkdownBlocks(source).find((block) => block.type === "table")?.table ?? null
}

export const parsePipeTable = parseMarkdownTable
export const parseMarkdownPipeTable = parseMarkdownTable

export function parseMarkdownTables(input: string): MarkdownTable[] {
  return parseMarkdownBlocks(input)
    .filter((block): block is Extract<MarkdownBlock, { type: "table" }> => block.type === "table")
    .map((block) => block.table)
}

export class MarkdownTableStream {
  private lineBuffer = ""
  private lineNumber = 0
  private fence: FenceInfo | null = null
  private candidate: {
    line: string
    lineNumber: number
    headers: string[]
    terminated: boolean
  } | null = null
  private active: {
    headers: string[]
    rows: string[][]
    aligns: PipeTableAlignment[]
    sourceLines: string[]
    startLine: number
  } | null = null

  reset(): void {
    this.lineBuffer = ""
    this.lineNumber = 0
    this.fence = null
    this.candidate = null
    this.active = null
  }

  feed(chunk: string): MarkdownTableStreamEvent[] {
    return this.push(chunk)
  }

  push(chunk: string): MarkdownTableStreamEvent[] {
    if (!chunk) return []
    this.lineBuffer += chunk
    const events: MarkdownTableStreamEvent[] = []
    for (;;) {
      const newline = this.lineBuffer.indexOf("\n")
      if (newline < 0) break
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "")
      this.lineBuffer = this.lineBuffer.slice(newline + 1)
      this.processLine(line, true, events)
    }
    return events
  }

  finish(): MarkdownTableStreamEvent[] {
    return this.flush()
  }

  flush(): MarkdownTableStreamEvent[] {
    const events: MarkdownTableStreamEvent[] = []
    if (this.lineBuffer) {
      const line = this.lineBuffer.replace(/\r$/, "")
      this.lineBuffer = ""
      this.processLine(line, false, events)
    }
    this.finishTable(events)
    this.finishCandidate(events)
    return events
  }

  private text(line: string, terminated: boolean, events: MarkdownTableStreamEvent[]): void {
    events.push({ type: "text", text: `${line}${terminated ? "\n" : ""}` })
  }

  private finishTable(events: MarkdownTableStreamEvent[]): void {
    if (!this.active) return
    const active = this.active
    this.active = null
    const source = active.sourceLines.join("\n")
    const table: MarkdownTable = {
      headers: active.headers,
      rows: active.rows,
      aligns: active.aligns,
      alignments: active.aligns,
      source,
      raw: source,
      startLine: active.startLine,
      endLine: active.startLine + active.sourceLines.length - 1,
    }
    events.push({ type: "table", table, raw: source })
  }

  private finishCandidate(events: MarkdownTableStreamEvent[]): void {
    if (!this.candidate) return
    const candidate = this.candidate
    this.candidate = null
    this.text(candidate.line, candidate.terminated, events)
  }

  private processLine(line: string, terminated: boolean, events: MarkdownTableStreamEvent[]): void {
    const currentLine = this.lineNumber++
    if (this.fence) {
      if (isFenceClose(line, this.fence)) this.fence = null
      this.text(line, terminated, events)
      return
    }
    const opening = fenceInfo(line)
    if (opening) {
      this.finishTable(events)
      this.finishCandidate(events)
      this.fence = opening
      this.text(line, terminated, events)
      return
    }
    if (this.active) {
      const split = splitPipeRow(line)
      if (line.trim() !== "" && split && split.length === this.active.headers.length) {
        this.active.rows.push(split.map(unescapeCell))
        this.active.sourceLines.push(line)
        return
      }
      this.finishTable(events)
      this.processLine(line, terminated, events)
      return
    }
    if (this.candidate) {
      const delimiter = parseDelimiterRow(line)
      if (delimiter && delimiter.length === this.candidate.headers.length) {
        this.active = {
          headers: this.candidate.headers,
          rows: [],
          aligns: delimiter,
          sourceLines: [this.candidate.line, line],
          startLine: this.candidate.lineNumber,
        }
        this.candidate = null
        return
      }
      this.text(this.candidate.line, this.candidate.terminated, events)
      this.candidate = null
      this.processLine(line, terminated, events)
      return
    }
    if (line.trim() === "") {
      this.text(line, terminated, events)
      return
    }
    const split = splitPipeRow(line)
    if (split) {
      this.candidate = {
        line,
        lineNumber: currentLine,
        headers: split.map(unescapeCell),
        terminated,
      }
      return
    }
    this.text(line, terminated, events)
  }
}
