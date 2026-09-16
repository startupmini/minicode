import { isAbsolute, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import type { Tool } from "#minicore"
import { safeReadFile } from "../lib/safe-open.ts"
import {
  findSymbolPosition,
  getConfiguredExts,
  lspCall,
  lspDiagnostics,
  workspaceSymbols,
} from "../lsp/client.ts"
import { isPathOutsideRoot, isRealPathOutsideRoot, isSensitive } from "../policy/jail.ts"
import { scrubSecrets } from "../policy/scrub.ts"

const SEVERITY = ["Error", "Warn", "Info", "Hint"]

// Balapan request LSP melawan abort: server daemon tetap hidup (seperti MCP
// stdio), tetapi tool berhenti menunggu — late result tidak kembali sebagai
// success ke turn yang sudah dibatalkan.
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"))
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      signal.addEventListener("abort", () => rej(signal.reason ?? new Error("aborted")), {
        once: true,
      }),
    ),
  ])
}

function toUri(abs: string): string {
  return pathToFileURL(abs).href
}

async function readTarget(file: string, cwd: string): Promise<{ abs: string; text: string }> {
  if (isPathOutsideRoot(file, cwd)) throw new Error(`path outside workspace: ${file}`)
  if (isSensitive(file)) throw new Error(`blocked sensitive file: ${file}`)
  const abs = isAbsolute(file) ? resolvePath(file) : resolvePath(cwd, file)
  if (isRealPathOutsideRoot(abs, cwd)) throw new Error(`path outside workspace: ${file}`)
  // Baca via safeReadFile (O_NOFOLLOW + verifikasi ulang target saat open):
  // readFile biasa membuka hasil realpath LAMA sehingga swap symlink di
  // antara cek dan baca lolos + membaca target sensitif. relevan ganda di
  // jalur MCP yang permission handler-nya minim (tanpa pre-check jail).
  const text = await safeReadFile(abs, cwd)
  return { abs, text }
}

function formatPos(p: unknown): string {
  const r = p as {
    range?: { start?: { line?: number; character?: number } }
    uri?: string
    targetUri?: string
  }
  const uri = r.uri ?? r.targetUri ?? "?"
  const line =
    r.range?.start?.line != null
      ? `:${(r.range.start.line ?? 0) + 1}:${(r.range.start.character ?? 0) + 1}`
      : ""
  return `${uri}${line}`
}

interface PosArgs {
  file: string
  symbol?: string
  line?: number
  character?: number
}

async function resolvePosition(
  args: PosArgs,
  cwd: string,
): Promise<{ abs: string; text: string; position: { line: number; character: number } } | string> {
  if (getConfiguredExts().length === 0)
    return "(no LSP servers configured — add via minicode config lsp add)"
  const { abs, text } = await readTarget(args.file, cwd)
  let position: { line: number; character: number } | null = null
  if (args.line != null) position = { line: args.line, character: args.character ?? 0 }
  else if (args.symbol) position = findSymbolPosition(text, args.symbol)
  if (!position) return `[lsp] symbol '${args.symbol}' not found in ${args.file}`
  return { abs, text, position }
}

export function formatHover(result: unknown): string {
  const c = (result as { contents?: unknown })?.contents
  const txt =
    typeof c === "object" && c !== null && "value" in (c as Record<string, unknown>)
      ? String((c as Record<string, unknown>).value)
      : typeof c === "string"
        ? c
        : JSON.stringify(c)
  // Temuan audit #02: slice diam-diam tampak utuh — tandai bila dipotong.
  return txt.length > 4_000
    ? `${txt.slice(0, 4_000)}\n… [truncated: hover too long]`
    : txt || "(empty hover)"
}

// Potong daftar lokasi dengan penanda (def/refs tak boleh tampak lengkap).
// Diekspor untuk test (perilaku cap adalah kontrak audit #02).
export function capLocations(lines: string[], limit: number): string {
  if (lines.length <= limit) return lines.join("\n")
  return `${lines.slice(0, limit).join("\n")}\n… [truncated: showing first ${limit} of ${lines.length}]`
}

function posTool(
  name: string,
  method: string,
  describe: string,
  extraParams: Record<string, unknown> = {},
  limit = 50,
): Tool {
  return {
    name,
    description: describe,
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "path file relatif cwd" },
        symbol: { type: "string", description: "nama simbol di file (alternatif line/character)" },
        line: { type: "number", description: "0-based line (optional)" },
        character: { type: "number", description: "kolom 0-based (opsional)" },
      },
      required: ["file"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      ctx.signal.throwIfAborted()
      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd()
      try {
        const resolved = await resolvePosition(args as PosArgs, cwd)
        if (typeof resolved === "string") return resolved
        const { abs, text, position } = resolved
        const result = await raceAbort(
          lspCall(
            abs,
            text,
            method,
            {
              textDocument: { uri: toUri(abs) },
              position,
              ...extraParams,
            },
            cwd,
          ),
          ctx.signal,
        )
        if (!result || (Array.isArray(result) && result.length === 0)) return "(not found)"
        if (method === "textDocument/hover") return scrubSecrets(formatHover(result))
        if (Array.isArray(result)) return scrubSecrets(capLocations(result.map(formatPos), limit))
        return scrubSecrets(formatPos(result))
      } catch (e) {
        return `[lsp] ${scrubSecrets((e as Error).message)}`
      }
    },
  }
}

export const lspDiagnosticsTool: Tool = {
  name: "lsp_diagnostics",
  description:
    "LSP diagnostics for one file (errors/warnings from the language server). Requires a registered LSP server for the file extension.",
  parameters: {
    type: "object",
    properties: { file: { type: "string", description: "path file relatif cwd" } },
    required: ["file"],
    additionalProperties: false,
  },
  async execute({ file }, ctx) {
    ctx.signal.throwIfAborted()
    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd()
    try {
      const { abs, text } = await readTarget(String(file), cwd)
      const { items } = await raceAbort(lspDiagnostics(abs, text, undefined, cwd), ctx.signal)
      if (!items.length) return "(no diagnostics)"
      return scrubSecrets(
        items
          .map((d) => {
            const dd = d as {
              range?: { start?: { line?: number; character?: number } }
              severity?: number
              message?: string
              source?: string
            }
            const sev = SEVERITY[(dd.severity ?? 1) - 1] ?? "?"
            const pos = `${(dd.range?.start?.line ?? 0) + 1}:${(dd.range?.start?.character ?? 0) + 1}`
            return `${pos} [${sev}] ${dd.message}${dd.source ? ` (${dd.source})` : ""}`
          })
          .join("\n"),
      )
    } catch (e) {
      return `[lsp] ${scrubSecrets((e as Error).message)}`
    }
  },
}

export const lspDefinitionTool = posTool(
  "lsp_definition",
  "textDocument/definition",
  "Location of a symbol definition (file + line). Params: file + symbol, or line/character.",
)

export const lspReferencesTool = posTool(
  "lsp_references",
  "textDocument/references",
  "All references to a symbol in the repo (file + line). Params: file + symbol.",
  { context: { includeDeclaration: true } },
  100,
)

export const lspHoverTool = posTool(
  "lsp_hover",
  "textDocument/hover",
  "Hover info / tipe data simbol. Params: file + symbol.",
)

export const lspSymbolsTool: Tool = {
  name: "lsp_symbols",
  description: "Outline simbol dokumen (fungsi/kelas/variabel) via LSP.",
  parameters: {
    type: "object",
    properties: { file: { type: "string", description: "path file relatif cwd" } },
    required: ["file"],
    additionalProperties: false,
  },
  async execute({ file }, ctx) {
    ctx.signal.throwIfAborted()
    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd()
    try {
      const { abs, text } = await readTarget(String(file), cwd)
      const result = await raceAbort(
        lspCall(
          abs,
          text,
          "textDocument/documentSymbol",
          {
            textDocument: { uri: toUri(abs) },
          },
          cwd,
        ),
        ctx.signal,
      )
      if (!result || !Array.isArray(result) || result.length === 0) return "(no symbols)"
      const KIND = [
        "File",
        "Module",
        "Namespace",
        "Package",
        "Class",
        "Method",
        "Property",
        "Field",
        "Constructor",
        "Enum",
        "Interface",
        "Function",
        "Variable",
        "Constant",
        "String",
        "Number",
        "Boolean",
        "Array",
        "Object",
        "Key",
        "Null",
        "EnumMember",
        "Struct",
        "Event",
        "Operator",
        "TypeParameter",
      ]
      return scrubSecrets(
        result
          .map((s) => {
            const sym = s as { name?: string; kind?: number; range?: { start?: { line?: number } } }
            const kind = KIND[(sym.kind ?? 1) - 1] ?? "?"
            const line = (sym.range?.start?.line ?? 0) + 1
            return `${line}: [${kind}] ${sym.name}`
          })
          .join("\n"),
      )
    } catch (e) {
      return `[lsp] ${scrubSecrets((e as Error).message)}`
    }
  },
}

export const lspWorkspaceSymbolsTool: Tool = {
  name: "lsp_workspace_symbols",
  description:
    "Search symbols across the workspace via LSP (workspace/symbol). An empty query returns popular symbols. Requires a configured LSP server.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "symbol keyword, empty for all" } },
    required: [],
    additionalProperties: false,
  },
  async execute({ query }, ctx) {
    ctx.signal.throwIfAborted()
    if (getConfiguredExts().length === 0)
      return "(no LSP servers configured — add via minicode config lsp add)"
    try {
      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd()
      const symbols = await raceAbort(
        workspaceSymbols((query as string) ?? "", 5000, cwd),
        ctx.signal,
      )
      if (!symbols.length) return "(no symbols)"
      const KIND = [
        "File",
        "Module",
        "Namespace",
        "Package",
        "Class",
        "Method",
        "Property",
        "Field",
        "Constructor",
        "Enum",
        "Interface",
        "Function",
        "Variable",
        "Constant",
        "String",
        "Number",
        "Boolean",
        "Array",
        "Object",
        "Key",
        "Null",
        "EnumMember",
        "Struct",
        "Event",
        "Operator",
        "TypeParameter",
      ]
      const rows = symbols.map((s) => {
        const kind = KIND[(s.kind ?? 1) - 1] ?? "?"
        const uri = s.location.uri ?? "?"
        return `[${kind}] ${s.name}${s.containerName ? ` (${s.containerName})` : ""} — ${uri}`
      })
      return capLocations(rows, 50)
    } catch (e) {
      return `[lsp] ${(e as Error).message}`
    }
  },
}
