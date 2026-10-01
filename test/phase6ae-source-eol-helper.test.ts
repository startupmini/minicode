// Test helper `normalizeSourceEol` sendiri.
//
// [FASE 6AE] Helper normalisasi EOL adalah generational: kalau ia diam-diam
// salah, setiap test semantic yang memakainya ikut salah secara serempak dan
// suite tetap hijau. Jadi helper ini diuji langsung, termasuk invarian
//))))

import { describe, expect, test } from "bun:test"
import { normalizeSourceEol } from "./helpers/source-eol.ts"

describe("6AE normalizeSourceEol - helper for semantic source assertions", () => {
  // ── THE INVARIANT THIS HELPER EXISTS TO PROVIDE ────────────────────────────
  //
  // [DESIGN DECISION] These are the primary tests, not a secondary detail.
  // Every other test here checks a specific input; this pair checks the
  // property that makes CRLF checkouts survivable at all. If it ever fails,
  // stop and fix the helper before touching any test that uses it.
  test("an LF source and its CRLF twin normalize to the same text", () => {
    const lf = "const a = 1\nif (a) {\n  b()\n}\n"
    const crlf = "const a = 1\r\nif (a) {\r\n  b()\r\n}\r\n"
    expect(normalizeSourceEol(crlf)).toBe(normalizeSourceEol(lf))
    expect(normalizeSourceEol(crlf)).toBe(lf)
  })

  test("a bare-CR source (classic Mac) normalizes to the same text as LF", () => {
    const lf = "one\ntwo\nthree\n"
    const cr = "one\rtwo\rthree\r"
    expect(normalizeSourceEol(cr)).toBe(normalizeSourceEol(lf))
  })

  test("mixed EOLs in one source all collapse to LF", () => {
    const mixed = "a\r\nb\nc\rd\r\n"
    expect(normalizeSourceEol(mixed)).toBe("a\nb\nc\nd\n")
  })

  // ── WHAT IT MUST NOT CHANGE ───────────────────────────────────────────────
  //
  // [DESIGN DECISION] A normalizer that also "helpfully" trims or reformats
  // would quietly weaken every assertion downstream. These pin the blast
  // radius to line-ending representation ONLY.
  test("indentation is preserved exactly, including deep nesting", () => {
    const src = "function f() {\n\t\tif (x) {\n\t\t\treturn 1\n\t\t}\n}\n"
    expect(normalizeSourceEol(src)).toBe(src)
    expect(normalizeSourceEol(src.replace(/\n/g, "\r\n"))).toBe(src)
  })

  test("trailing whitespace is preserved, not trimmed", () => {
    const src = "const a = 1   \nconst b = 2\t\n"
    expect(normalizeSourceEol(src)).toBe(src)
    expect(normalizeSourceEol(src.replace(/\n/g, "\r\n"))).toBe(src)
  })

  test("leading and trailing blank lines survive normalization", () => {
    const src = "\n\nconst a = 1\n\n"
    expect(normalizeSourceEol(src)).toBe(src)
    expect(normalizeSourceEol(src.replace(/\n/g, "\r\n"))).toBe(src)
  })

  test("tabs and spaces are never conflated", () => {
    const tabs = "\tindented\n"
    const spaces = "    indented\n"
    expect(normalizeSourceEol(tabs)).toBe(tabs)
    expect(normalizeSourceEol(spaces)).toBe(spaces)
    expect(normalizeSourceEol(tabs)).not.toBe(normalizeSourceEol(spaces))
  })

  // [DESIGN DECISION] Non-ASCII must pass through byte-for-byte. A
  // normalizer that "fixed" smart quotes or normalized Unicode would make a
  // source assertion pass on one machine and fail on another, which is the
  // exact disease this helper is here to cure. (This project is Indonesian-
  // commented and carries CJK fixtures.)
  test("non-ASCII characters are untouched", () => {
    const src = '// undiagnosed: "kutip" - em-dash, 日本語, emoji ✅\nconst a = "nilai"\n'
    expect(normalizeSourceEol(src)).toBe(src)
    expect(normalizeSourceEol(src.replace(/\n/g, "\r\n"))).toBe(src)
  })

  test("a CR that is NOT a line ending is not silently invented into one", () => {
    // A lone CR inside a string literal in source text is data. Our rule is
    // deliberately simple (CR -> LF), and this test documents that choice
    // rather than hiding it, so nobody is surprised by it later.
    const src = 'const s = "a\rb"\n'
    expect(normalizeSourceEol(src)).toBe('const s = "a\nb"\n')
  })

  // ── EDGE CASES THAT MUST NOT THROW ─────────────────────────────────────────
  test("empty and EOL-only inputs are handled without throwing", () => {
    expect(normalizeSourceEol("")).toBe("")
    expect(normalizeSourceEol("\n")).toBe("\n")
    expect(normalizeSourceEol("\r\n")).toBe("\n")
    expect(normalizeSourceEol("\r")).toBe("\n")
    // [PHASE 6AE] This case is asserted from the RULE, and the first version of
    // it was simply wrong. It expected "\r\r\n\n\r" (3 CR + 2 LF) to become
    // "\n\n\n" - three newlines. It becomes FOUR, and four is correct: the
    // string contains four line-ending SEQUENCES, namely `\r`, `\r\n`, `\n`,
    // `\r`. Counting the two forms and summing them (3+2=5) is the mistake;
    // `\r\n` is one ending, not two.
    //
    // Worth stating plainly, because the failure mode here is uncomfortable:
    // the tempting move is to "fix" the helper until the wrong expectation
    // holds. That would have made the helper lose a real CRLF sequence and
    // broken CRLF handling everywhere, on the authority of a bad sum in a
    // test. The helper was right; the arithmetic was not.
    expect(normalizeSourceEol("\r\r\n\n\r")).toBe("\n\n\n\n")
    // Spelled out by sequence, so the expectation is auditable rather than
    // merely asserted.
    expect(normalizeSourceEol("\r\n")).toBe("\n")
    expect(normalizeSourceEol("\n\r")).toBe("\n\n")
  })

  // ── IDEMPOTENCE ───────────────────────────────────────────────────────────
  test("normalizing twice equals normalizing once", () => {
    const lf = "a\nb\nc\n"
    const once = normalizeSourceEol(lf.replace(/\n/g, "\r\n"))
    expect(normalizeSourceEol(once)).toBe(once)
  })

  // ── THE SEMANTIC USE CASE THAT BROUGHT THIS HELPER INTO EXISTENCE ─────────
  //
  // [DESIGN DECISION] This is a miniature of the real 6AB S13 assertion. If
  // the pattern below ever stops matching, the production fix it guards is no
  // longer detected - which is the regression this whole phase exists to avoid
  // re-introducing.
  test("the 6AB S13-style pattern matches under both LF and CRLF", () => {
    const lf = [
      "async function main() {",
      "  const session = await createCliSession({",
      "    cwd,",
      "    model,",
      "    resumeId,",
      "  })",
      "}",
      "",
    ].join("\n")
    const crlf = lf.replace(/\n/g, "\r\n")
    const pattern = /createCliSession\(\{[\s\S]{0,400}?\n {4}resumeId,\n/
    expect(normalizeSourceEol(lf)).toMatch(pattern)
    expect(normalizeSourceEol(crlf)).toMatch(pattern)
  })

  // [DESIGN DECISION] ...and the same pattern must still REJECT the regression
  // it was written for, under both line endings. A normalizer that made the
  // pattern match everything would be a way to lose the assertion while
  // keeping the test green.
  test("the 6AB S13-style pattern still rejects the regression it guards", () => {
    const missing = [
      "async function main() {",
      "  const s = await createCliSession({",
      "    cwd,",
      "  })",
      "}",
      "",
    ].join("\n")
    const pattern = /createCliSession\(\{[\s\S]{0,400}?\n {4}resumeId,\n/
    expect(normalizeSourceEol(missing)).not.toMatch(pattern)
    expect(normalizeSourceEol(missing.replace(/\n/g, "\r\n"))).not.toMatch(pattern)
  })
})
