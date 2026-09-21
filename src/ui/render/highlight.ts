import { t } from "../i18n/locale.ts"
import { c } from "./theme.ts"

const TS_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "default",
  "try",
  "catch",
  "finally",
  "throw",
  "async",
  "await",
  "import",
  "export",
  "from",
  "as",
  "class",
  "extends",
  "implements",
  "interface",
  "type",
  "enum",
  "namespace",
  "new",
  "this",
  "super",
  "typeof",
  "instanceof",
  "in",
  "of",
  "yield",
  "void",
  "null",
  "undefined",
  "true",
  "false",
])

const PY_KEYWORDS = new Set([
  "def",
  "return",
  "if",
  "elif",
  "else",
  "for",
  "while",
  "break",
  "continue",
  "try",
  "except",
  "finally",
  "raise",
  "import",
  "from",
  "as",
  "class",
  "pass",
  "with",
  "async",
  "await",
  "yield",
  "lambda",
  "global",
  "nonlocal",
  "assert",
  "True",
  "False",
  "None",
  "and",
  "or",
  "not",
  "is",
  "in",
])

const SH_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "function",
  "return",
  "exit",
  "export",
  "set",
  "unset",
  "echo",
  "cd",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "cat",
  "grep",
  "find",
  "curl",
  "git",
])

export function highlightCode(code: string, lang: string = ""): string {
  const language = lang.trim().toLowerCase()
  const lines = code.split("\n")

  return lines
    .map((line) => {
      if (language === "json") return highlightJsonLine(line)
      if (language === "python" || language === "py") return highlightPythonLine(line)
      if (language === "bash" || language === "sh" || language === "zsh" || language === "shell")
        return highlightShellLine(line)
      if (language === "diff") return highlightDiffLine(line)
      // default: ts / js / tsx / jsx / generic
      return highlightTsLine(line)
    })
    .join("\n")
}

/**
 * Cari penanda komentar (`//`, `#`) di LUAR string literal.
 *
 * Sebelumnya `indexOf("//")`/`indexOf("#")` menyalahartikan
 * `const url = "https://a.com"` (semua setelah `//` dianggap komentar) dan
 * `color = "#fff"` (`#fff"` jadi komentar). Scanner di bawah melompati isi
 * string kutip tunggal/ganda/backtick termasuk escape.
 */
function findCommentIndex(line: string, marker: string): number {
  let quote: string | null = null
  let i = 0
  while (i < line.length) {
    const ch = line[i]!
    if (quote !== null) {
      if (ch === "\\") i += 2
      else if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      i++
      continue
    }
    if (line.startsWith(marker, i)) return i
    i++
  }
  return -1
}

function highlightTsLine(line: string): string {
  // Comments
  const commentIdx = findCommentIndex(line, "//")
  if (commentIdx !== -1) {
    const codePart = line.slice(0, commentIdx)
    const commentPart = line.slice(commentIdx)
    return highlightTsTokens(codePart) + c.gray(c.italic(commentPart))
  }
  return highlightTsTokens(line)
}

function highlightTsTokens(text: string): string {
  // Regex to match string literals, numbers, identifiers, operators
  const tokenRe =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b|[{}()[\];:,.<>=+\-*/%!&|^~?]+|\s+)/g
  return text.replace(tokenRe, (token) => {
    if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) {
      return c.green(token)
    }
    if (/^\d+(?:\.\d+)?$/.test(token)) {
      return c.brightYellow(token)
    }
    if (TS_KEYWORDS.has(token)) {
      return c.brightMagenta(c.bold(token))
    }
    if (/^[A-Z][A-Za-z0-9_$]*$/.test(token)) {
      // Type / Class name
      return c.brightCyan(token)
    }
    // Tidak ada cabang khusus untuk true/false/null/undefined: keempatnya sudah
    // ada di TS_KEYWORDS, jadi cabang di atas selalu menang. Cabang terpisah
    // yang pernah ada di sini tak pernah terjangkau (terlihat saat coverage
    // highlight.ts dinaikkan: satu baris mustahil dicapai test apa pun).
    return token
  })
}

function highlightPythonLine(line: string): string {
  const commentIdx = findCommentIndex(line, "#")
  if (commentIdx !== -1) {
    const codePart = line.slice(0, commentIdx)
    const commentPart = line.slice(commentIdx)
    return highlightPythonTokens(codePart) + c.gray(c.italic(commentPart))
  }
  return highlightPythonTokens(line)
}

function highlightPythonTokens(text: string): string {
  const tokenRe =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b|[{}()[\];:,.<>=+\-*/%!&|^~?]+|\s+)/g
  return text.replace(tokenRe, (token) => {
    if (token.startsWith('"') || token.startsWith("'")) {
      return c.green(token)
    }
    if (/^\d+/.test(token)) return c.brightYellow(token)
    if (PY_KEYWORDS.has(token)) return c.brightMagenta(c.bold(token))
    if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) return c.brightCyan(token)
    return token
  })
}

function highlightJsonLine(line: string): string {
  // Key vs string value vs number/bool
  return line.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|\b(-?\d+(?:\.\d+)?)\b/g,
    (match, str, colon, bool, num) => {
      if (str) {
        if (colon) return c.brightCyan(str) + colon
        return c.green(str)
      }
      if (bool) return c.yellow(bool)
      if (num) return c.brightYellow(num)
      return match
    },
  )
}

function highlightShellLine(line: string): string {
  const commentIdx = findCommentIndex(line, "#")
  if (commentIdx !== -1) {
    const codePart = line.slice(0, commentIdx)
    const commentPart = line.slice(commentIdx)
    return highlightShellTokens(codePart) + c.gray(c.italic(commentPart))
  }
  return highlightShellTokens(line)
}

function highlightShellTokens(text: string): string {
  // Alternatif flag (`-x`/`--long`) WAJIB sebelum kata: tanpa itu `-` tak pernah
  // jadi awal token (cabang yellow di bawah mati — dulu flag tampil polos).
  return text.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$[A-Za-z0-9_]+|-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*|\b[A-Za-z_][A-Za-z0-9_-]*\b|\s+)/g,
    (token) => {
      if (token.startsWith('"') || token.startsWith("'")) return c.green(token)
      if (token.startsWith("$")) return c.brightCyan(token)
      if (SH_KEYWORDS.has(token)) return c.brightMagenta(c.bold(token))
      if (token.startsWith("-")) return c.yellow(token)
      return token
    },
  )
}

function highlightDiffLine(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return c.green(line)
  if (line.startsWith("-") && !line.startsWith("---")) return c.red(line)
  if (line.startsWith("@@")) return c.cyan(line)
  return line
}

export function formatCodeBlock(code: string, lang: string = "", maxLines?: number): string {
  const highlighted = highlightCode(code, lang)
  const lines = highlighted.split("\n")
  const displayLines =
    maxLines && lines.length > maxLines
      ? [...lines.slice(0, maxLines), c.dim(t("hl.moreLines", { n: lines.length - maxLines }))]
      : lines

  const header = lang ? ` ${lang.toLowerCase()} ` : " code "
  const topBorder = c.muted(`── ${header.trim()}`)
  const bottomBorder = c.muted("──")

  const formattedLines = displayLines.map((l, i) => {
    const lineNum = c.muted(`${String(i + 1).padStart(4, " ")} `)
    return `${lineNum}${l}`
  })

  return `${topBorder}\n${formattedLines.join("\n")}\n${bottomBorder}`
}
