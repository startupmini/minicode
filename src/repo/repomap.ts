import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { LIMITS, LSP_SYMBOL_KINDS } from "../constants.ts"
import { homeDir } from "../lib/db-path.ts"
import { GIT_SAFE_BASE } from "../lib/git-hardening.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { isRealPathOutsideRoot } from "../policy/jail.ts"

const execFileAsync = promisify(execFile)

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
])
const MAX_FILES = LIMITS.REPOMAP_MAX_FILES
const MAX_FILE_BYTES = LIMITS.REPOMAP_MAX_FILE_BYTES
const MAX_REPOMAP_CHARS = LIMITS.REPOMAP_MAX_CHARS
const MAX_SYMBOLS_PER_FILE = LIMITS.REPOMAP_MAX_SYMBOLS_PER_FILE

function langFor(file: string): string {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase()
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "ts"
    case ".py":
      return "py"
    case ".go":
      return "go"
    case ".rs":
      return "rs"
    case ".java":
      return "java"
    case ".c":
    case ".cpp":
    case ".h":
    case ".hpp":
      return "c"
    case ".cs":
      return "cs"
    case ".rb":
      return "rb"
    case ".php":
      return "php"
    default:
      return ""
  }
}

interface LinePattern {
  re: RegExp
  render: (m: RegExpExecArray) => string
}

const PATTERNS: Record<string, LinePattern[]> = {
  ts: [
    {
      re: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      render: (m) => `function ${m[1]}(...)`,
    },
    { re: /^export\s+class\s+([A-Za-z_$][\w$]*)/, render: (m) => `class ${m[1]}` },
    { re: /^export\s+interface\s+([A-Za-z_$][\w$]*)/, render: (m) => `interface ${m[1]}` },
    { re: /^export\s+(type|enum)\s+([A-Za-z_$][\w$]*)/, render: (m) => `${m[1]} ${m[2]}` },
    { re: /^export\s+const\s+([A-Za-z_$][\w$]*)/, render: (m) => `const ${m[1]}` },
    {
      re: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      render: (m) => `function ${m[1]}(...)`,
    },
    { re: /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, render: (m) => `class ${m[1]}` },
    { re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, render: (m) => `interface ${m[1]}` },
  ],
  py: [
    { re: /^(?:async\s+)?def\s+(\w+)\s*\(/, render: (m) => `def ${m[1]}(...)` },
    { re: /^class\s+(\w+)/, render: (m) => `class ${m[1]}` },
  ],
  go: [
    { re: /^func\s+([\w*[\]].]+)\s*\(/, render: (m) => `func ${m[1]}(...)` },
    { re: /^type\s+(\w+)\s+(?:struct|interface)\b/, render: (m) => `type ${m[1]}` },
  ],
  rs: [
    { re: /^(?:pub\s+)?fn\s+(\w+)\s*\(/, render: (m) => `fn ${m[1]}(...)` },
    { re: /^(?:pub\s+)?struct\s+(\w+)/, render: (m) => `struct ${m[1]}` },
    {
      re: /^(?:pub\s+)?(?:enum|trait)\s+(\w+)/,
      render: (m) => `${m[0].includes("trait") ? "trait" : "enum"} ${m[1]}`,
    },
    { re: /^(?:pub\s+)?impl\s+(\w+)/, render: (m) => `impl ${m[1]}` },
  ],
  java: [
    {
      re: /^(?:public|private|protected|static|final|abstract|\s)*\b(?:class|interface|enum)\s+(\w+)/,
      render: (m) => `type ${m[1]}`,
    },
    {
      re: /^\s+(?:public|private|protected)\s+(?:static\s+)?[\w<>[\],. ]+\s+(\w+)\s*\(/,
      render: (m) => `method ${m[1]}(...)`,
    },
  ],
  c: [
    { re: /^[A-Za-z_][\w\s*]*\b(\w+)\s*\([^)]*\)\s*\{/, render: (m) => `function ${m[1]}(...)` },
    {
      re: /^(?:struct|enum)\s+(\w+)/,
      render: (m) => `${m[0].startsWith("struct") ? "struct" : "enum"} ${m[1]}`,
    },
  ],
  cs: [
    {
      re: /^(?:public|private|protected|internal|static|sealed|abstract|partial|\s)*\bclass\s+(\w+)/,
      render: (m) => `class ${m[1]}`,
    },
    {
      re: /^(?:public|private|protected|internal|\s)*\binterface\s+(\w+)/,
      render: (m) => `interface ${m[1]}`,
    },
    {
      re: /^\s*(?:public|private|protected|internal|static|\s)*\b\w+\s+(\w+)\s*\(/,
      render: (m) => `method ${m[1]}(...)`,
    },
    { re: /^\s*namespace\s+([\w.]+)/, render: (m) => `namespace ${m[1]}` },
  ],
  rb: [
    { re: /^\s*class\s+(\w+)/, render: (m) => `class ${m[1]}` },
    { re: /^\s*module\s+(\w+)/, render: (m) => `module ${m[1]}` },
    { re: /^\s*def\s+(\w+)/, render: (m) => `def ${m[1]}(...)` },
  ],
  php: [
    { re: /^\s*(?:abstract|final)?\s*class\s+(\w+)/, render: (m) => `class ${m[1]}` },
    { re: /^\s*interface\s+(\w+)/, render: (m) => `interface ${m[1]}` },
    { re: /^\s*trait\s+(\w+)/, render: (m) => `trait ${m[1]}` },
    {
      re: /^\s*(?:public|private|protected|static)?\s*function\s+(\w+)\s*\(/,
      render: (m) => `function ${m[1]}(...)`,
    },
    { re: /^\s*namespace\s+([\w\\]+)/, render: (m) => `namespace ${m[1]}` },
  ],
}

// Ekstraksi simbol berbasis regex per-bahasa.
//
// Keputusan Fase 3.2 (PLAN_V4): `src/repo/tree-sitter.ts` DIHAPUS, bukan
// diimplementasikan. Alasannya diukur, bukan diasumsikan.
//
// Prototipe `web-tree-sitter` + `tree-sitter-typescript` berjalan dan cepat
// (init 89 ms, load grammar 19 ms, parse 6 ms), tapi perbandingan pada 5 file
// nyata di repo ini menunjukkan selisihnya kecil dan hampir seluruhnya berupa
// **member kelas** (`constructor`, `append`, `execute`, `check`, `__setMode`)
// dan variabel lokal — bukan simbol top-level yang berguna untuk orientasi:
//
//   file                      tree-sitter  regex  yang terlewat regex
//   src/policy/bash-guard.ts       6         5    1 (helper lokal)
//   src/session/shadow-git.ts     14        13    1 (helper lokal)
//   src/tools/bash.ts             11         9    5 (method kelas)
//   src/repo/repomap.ts           14        14    0
//   src/policy/permission.ts      12         9    3 (method)
//
// Biayanya: dua dependensi (~1,4 MB wasm per bahasa, dikali jumlah bahasa yang
// didukung), grammar terpisah untuk tiap bahasa dari sembilan yang ada, dan
// jalur async baru. Sementara repo-map sudah **mencapai cap 2.500 char** pada
// repo ini, jadi simbol tambahan tidak akan sampai ke prompt — ia justru
// menggeser simbol top-level yang lebih penting.
//
// Menyimpan stub yang selalu `return null` lebih buruk daripada keduanya: ia
// membuat pembaca (dan dokumen) percaya kemampuan yang tidak ada. Bila suatu
// saat repo-map dipisah per-file atau cap dinaikkan, tree-sitter layak
// dipertimbangkan ulang — dengan pengukuran baru, bukan asumsi.
export async function extractSymbolsAsync(content: string, lang: string): Promise<string[]> {
  return extractSymbols(content, lang)
}

// Ekstrak simbol dari konten file berdasarkan bahasa. Deterministik & cepat (regex).
export function extractSymbols(content: string, lang: string): string[] {
  const patterns = PATTERNS[lang]
  if (!patterns) return []
  const symbols: string[] = []
  const seen = new Set<string>()
  const lines = content.split("\n")
  for (const rawLine of lines) {
    const t = rawLine.trim()
    if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("/*") || t.startsWith("*"))
      continue
    for (const p of patterns) {
      const m = p.re.exec(t)
      if (m) {
        const sig = p.render(m)
        const key = sig.replace(/\s+/g, " ").trim()
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push(sig)
        }
        break
      }
    }
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break
  }
  return symbols
}

function isSourceFile(f: string): boolean {
  const dot = f.lastIndexOf(".")
  return dot !== -1 && SOURCE_EXTS.has(f.slice(dot).toLowerCase())
}

// Baca konten file sumber (async) — dipakai sekali untuk ranking + ekstraksi simbol.
async function readSourceContents(
  files: string[],
  cwd: string,
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = []
  for (const f of files) {
    try {
      const abs = resolve(cwd, f)
      const st = await stat(abs)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
      const content = await readFile(abs, "utf8")
      out.push({ path: f, content })
    } catch {}
  }
  return out
}

// Ranking sederhana ala PageRank: file yang banyak di-import file lain
// mendapat skor lebih tinggi → tampil lebih awal di repo-map (hemat token).
function rankByImport(files: { path: string; content: string }[]): string[] {
  const basenameToFiles = new Map<string, string[]>()
  for (const { path: f } of files) {
    const base = f.slice(f.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "")
    if (!base) continue
    const list = basenameToFiles.get(base) ?? []
    list.push(f)
    basenameToFiles.set(base, list)
  }
  const scores = new Map<string, number>()
  for (const { path: f } of files) scores.set(f, 0)
  for (const { path: f, content } of files) {
    for (const [base, targets] of basenameToFiles) {
      if (f === targets[0] && targets.length === 1) continue // jangan hit diri sendiri bila unik
      const importRe = new RegExp(
        `(?:import|from|require)\\s*["'\`][^"'\`]*${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"'\`]*["'\`]`,
        "i",
      )
      if (importRe.test(content)) {
        for (const t of targets) scores.set(t, (scores.get(t) ?? 0) + 1)
      }
    }
  }
  return [...files.map((f) => f.path)].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
}

async function walkForFiles(
  root: string,
  rel: string,
  out: string[],
  limit: number,
): Promise<void> {
  if (out.length >= limit) return
  const dir = rel ? join(root, rel) : root
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (out.length >= limit) break
    if (e.name.startsWith(".") || e.name === "node_modules") continue
    const r = rel ? `${rel}/${e.name}` : e.name
    // Symlink escape (temuan audit #06): walk fallback mengikuti symlink;
    // tolak yang realpath-nya keluar workspace (simbol saja yang bocor,
    // tetapi tetap data asing tanpa provenance).
    if (isRealPathOutsideRoot(join(root, r), root)) continue
    if (e.isDirectory()) await walkForFiles(root, r, out, limit)
    else if (isSourceFile(e.name)) out.push(r)
  }
}

// Daftar file sumber (git ls-files dulu → fallback walk).
async function listSourceFiles(cwd: string, limit: number): Promise<string[]> {
  try {
    // Audit #10: ls-files memicu fsmonitor repo & bisa menjalankan `git.bat`
    // repo (Windows cwd-first). Resolve absolut + netralisasi.
    const { stdout } = await execFileAsync(
      resolveTrustedExecutable("git"),
      [...GIT_SAFE_BASE, "ls-files"],
      {
        cwd,
        timeout: 3000,
        encoding: "utf8",
      },
    )
    const files = stdout
      .split("\n")
      .map((f) => f.replace(/\\/g, "/"))
      .filter(Boolean)
    if (files.length) return files.filter(isSourceFile).slice(0, limit)
  } catch {}
  const out: string[] = []
  await walkForFiles(cwd, "", out, limit)
  return out
}

function cachePath(cwd: string): string {
  // Audit #10 P1: cache di repo (.minicode/repomap.json) dapat ditulis
  // penyerang — validasi apa pun yang bisa dihitung pembaca (mtime, hash)
  // bisa dipalsukan penulis, sehingga peta BOHONG tersaji. Simpan di home
  // operator (di luar jangkauan konten repo), kunci = hash realpath cwd.
  // Sig isi tetap dipakai untuk deteksi basi (staleness), bukan trust.
  try {
    const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 32)
    return join(homeDir(), ".minicode", `repomap-${key}.json`)
  } catch {
    return resolve(cwd, ".minicode", "repomap.json")
  }
}

// Bangun repo-map compact dari daftar file.
export async function buildRepoMap(
  cwd: string = process.cwd(),
  opts: { limit?: number } = {},
): Promise<string> {
  const limit = opts.limit ?? MAX_FILES
  const files = await listSourceFiles(cwd, limit)
  // baca sekali → dipakai untuk ranking DAN simbol (tanpa double-read)
  const contents = await readSourceContents(files, cwd)
  const ranked = rankByImport(contents)
  const byPath = new Map(contents.map((c) => [c.path, c.content]))
  const parts: string[] = []
  for (const f of ranked) {
    const content = byPath.get(f)
    if (content == null) continue
    const symbols = extractSymbols(content, langFor(f))
    if (symbols.length) parts.push(`${f}:\n${symbols.map((s) => `  ${s}`).join("\n")}`)
  }
  return parts.join("\n").slice(0, MAX_REPOMAP_CHARS)
}

// Signature ISI (audit #10 P1): hash path+konten file terpilih — BUKAN
// mtime+size. Cache repomap.json tinggal di repo (dapat ditulis penyerang);
// sig mtime+size dapat dipalsukan via touch+padding sehingga peta BOHONG
// disajikan tanpa baca ulang. Dengan sig isi, cache palsu hanya cocok bila
// isinya benar-benar sama — dan bila sama, petanya pun benar. Cache lama
// (format mtime) otomatis miss → dibangun ulang sekali, tanpa migrasi.
function signature(files: string[], cwd: string): string {
  const h = createHash("sha256")
  for (const f of files.slice(0, 80)) {
    try {
      const abs = resolve(cwd, f)
      const st = statSync(abs)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
      h.update(f)
      h.update(readFileSync(abs))
    } catch {}
  }
  return `v2:${h.digest("hex")}`
}

// Coba bangun repo-map via LSP workspace/symbol (lebih akurat dari regex).
// Best-effort: timeout cepat, fallback ke regex bila LSP tak tersedia/kosong.
async function buildRepoMapLsp(cwd: string): Promise<string | null> {
  try {
    const { getConfiguredExts, workspaceSymbols } = await import("../lsp/client.ts")
    if (getConfiguredExts().length === 0) return null
    const symbols = await workspaceSymbols("", 4000, cwd)
    if (!symbols.length) return null
    const KIND = LSP_SYMBOL_KINDS
    const byFile = new Map<string, string[]>()
    for (const s of symbols.slice(0, 200)) {
      let file: string
      try {
        file = relative(cwd, fileURLToPath(s.location.uri)).replace(/\\/g, "/")
      } catch {
        continue
      }
      const kind = KIND[(s.kind ?? 1) - 1] ?? "?"
      const label = `${kind} ${s.name}${s.containerName ? ` (${s.containerName})` : ""}`
      const list = byFile.get(file) ?? []
      if (list.length < 8 && !list.includes(label)) list.push(label)
      byFile.set(file, list)
    }
    if (byFile.size === 0) return null
    const parts: string[] = []
    for (const [file, syms] of byFile)
      parts.push(`${file}:\n${syms.map((x) => `  ${x}`).join("\n")}`)
    const map = parts.join("\n").slice(0, MAX_REPOMAP_CHARS)
    return map || null
  } catch {
    return null
  }
}

// Load repo-map, pakai cache di .minicode/repomap.json bila file tak berubah.
export async function loadRepoMap(cwd: string = process.cwd()): Promise<string> {
  // Env MINICODE_REPOMAP=regex → skip LSP (paksa regex, lebih cepat)
  const forceRegex = process.env.MINICODE_REPOMAP === "regex"
  const files = await listSourceFiles(cwd, MAX_FILES)
  if (files.length === 0) return ""
  const sig = signature(files, cwd)
  const cp = cachePath(cwd)
  // Cache hit → langsung pakai (tanpa LSP, cepat)
  try {
    const cached = JSON.parse(readFileSync(cp, "utf8")) as {
      sig?: string
      map?: string
      lsp?: boolean
    }
    if (cached.sig === sig && typeof cached.map === "string") return cached.map
  } catch {}
  // Cache miss → coba LSP dulu (best-effort), fallback ke regex
  if (!forceRegex) {
    const lspMap = await buildRepoMapLsp(cwd)
    if (lspMap) {
      try {
        mkdirSync(join(homeDir(), ".minicode"), { recursive: true })
        writeFileSync(cp, JSON.stringify({ sig, map: lspMap, lsp: true }))
      } catch {}
      return lspMap
    }
  }
  const map = await buildRepoMap(cwd, { limit: MAX_FILES })
  try {
    mkdirSync(join(homeDir(), ".minicode"), { recursive: true })
    writeFileSync(cp, JSON.stringify({ sig, map, lsp: false }))
  } catch {}
  return map
}
