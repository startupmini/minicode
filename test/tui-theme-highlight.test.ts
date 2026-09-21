import { expect, test } from "bun:test"
import { highlightCode } from "../src/ui/render/highlight.ts"
import { decorateMarkdown } from "../src/ui/render/markdown.ts"
import { c, glyphs, section, stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"

test("theme: stripAnsi removes escape codes cleanly", () => {
  const colored = c.info(c.bold("hello world"))
  expect(stripAnsi(colored)).toBe("hello world")
})

test("theme: glyphs contain valid characters", () => {
  expect(glyphs.check).toBeDefined()
  expect(glyphs.cross).toBeDefined()
})

test("highlight: TypeScript keywords and strings", () => {
  const code = `const greeting = "hello";\nfunction test() { return 42; }`
  const highlighted = highlightCode(code, "typescript")
  // Content must be preserved exactly (colors may be stripped in non-TTY)
  expect(stripAnsi(highlighted)).toBe(code)
})

test("highlight: Python code and comments", () => {
  const code = `def calculate():\n    # inline comment\n    return 100`
  const highlighted = highlightCode(code, "python")
  expect(stripAnsi(highlighted)).toBe(code)
})

test("highlight: JSON strings, keys and numbers", () => {
  const code = `{\n  "name": "minicode",\n  "version": 1,\n  "active": true\n}`
  const highlighted = highlightCode(code, "json")
  expect(stripAnsi(highlighted)).toBe(code)
})

test("markdown: decorates code fences with indentation", () => {
  const md = "intro\n```typescript\nconst x = 1;\n```\noutro"
  const out = decorateMarkdown(md)
  expect(out).not.toContain("```")
  // Sibling test di atas selalu stripAnsi dulu: warna aktif/nonaktif
  // tergantung terminal (gagal di env truecolor — ditemukan saat run WSL).
  expect(stripAnsi(out)).toContain("const x = 1;")
})

test("markdown: plain text without fences unchanged", () => {
  expect(decorateMarkdown("just text")).toBe("just text")
})

test("theme: section separator uses display width for CJK/emoji", () => {
  const orig = process.stdout.columns
  Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true })
  const line = stripAnsi(section("状态😀"))
  expect(displayWidth(line)).toBeGreaterThanOrEqual(40)
  Object.defineProperty(process.stdout, "columns", { value: orig, configurable: true })
})

test("theme: section() sanitasi judul tak-terpercaya satu-baris (F-04)", () => {
  const line = stripAnsi(section("a\nb\x1b[2Jc"))
  expect(line).not.toContain("\n")
  expect(line).not.toContain("\x1b[2J")
  expect(line).toContain("a b")
})

test("markdown: escape model dibuang di hulu (F-04)", () => {
  const out = decorateMarkdown("halo\x1b[2Jdunia\n```ts\nkode\x1b[?1049hx\n```")
  expect(out).not.toContain("\x1b[2J")
  expect(out).not.toContain("?1049h")
  expect(stripAnsi(out)).toContain("halodunia")
})
