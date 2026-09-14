import { readdir, realpath, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { isIgnored, loadIgnoreMatchers } from "../lib/ignore.ts"
import { isPathOutsideRoot, isSensitive } from "../policy/jail.ts"

async function walk(
  dir: string,
  pattern: RegExp,
  out: string[],
  root: string,
  limit: number,
  signal: AbortSignal,
  ignoreMatchers: ((rel: string) => boolean)[],
) {
  if (signal.aborted) throw new Error("aborted")
  if (out.length >= limit) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (out.length >= limit) break
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === ".git") continue
    const full = join(dir, e.name)
    const rel = relative(root, full).replace(/\\/g, "/")
    // Hormati .gitignore subset (bukan hard-coded saja).
    if (isIgnored(rel, ignoreMatchers)) continue
    if (e.isDirectory()) {
      await walk(full, pattern, out, root, limit, signal, ignoreMatchers)
    } else if (pattern.test(rel) || pattern.test(e.name)) {
      const real = await realpath(full).catch(() => full)
      if (isPathOutsideRoot(real, resolve(root)) || isSensitive(real) || isSensitive(rel)) continue
      out.push(rel)
    }
  }
}

function globToRegExp(glob: string): RegExp {
  let esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  // handle {a,b} → (a|b)
  esc = esc.replace(
    /\\\{([^}]+)\\\}/g,
    (_m, inner: string) =>
      `(${inner
        .split(",")
        .map((s) => s.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&"))
        .join("|")})`,
  )
  esc = esc.replace(/\*\*/g, "§§")
  // **/ di awal/pola rekursif harus cocok file root juga: **/* sekarang jadi
  // (.*/)?[^/]*, bukan .*/[^/]* yang butuh slash dan membuat root kosong.
  esc = esc.replace(/§§\//g, "(.*/)?")
  esc = esc.replace(/\*/g, "[^/]*")
  esc = esc.replace(/§§/g, ".*")
  esc = esc.replace(/\?/g, ".")
  return new RegExp(`^${esc}$`)
}

export const globTool: Tool = {
  name: "glob",
  description:
    "Search files with a glob pattern (e.g. **/*.ts, src/**/*.js). Returns relative paths, capped at 100 by default. Skips .git, node_modules, and dotfiles.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob pattern (e.g. **/*.ts)" },
      cwd: { type: "string", description: "root directory (default: workspace root)" },
      limit: { type: "number", description: "max results (default 100)" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute({ pattern, cwd, limit }, ctx) {
    const sessionRoot = (ctx as { cwd?: string }).cwd ?? process.cwd()
    const rawRoot = (cwd as string) ?? "."
    const root = resolve(sessionRoot, rawRoot)
    if (isPathOutsideRoot(root, sessionRoot)) throw new Error(`cwd outside workspace: ${rawRoot}`)
    const rawLim = limit as number | undefined
    const lim = Number.isFinite(rawLim)
      ? Math.min(Math.max(Math.floor(rawLim!), 1), LIMITS.SEARCH_MAX_LIMIT)
      : LIMITS.SEARCH_DEFAULT_LIMIT
    const re = globToRegExp(pattern as string)
    const ignoreMatchers = await loadIgnoreMatchers(root)
    const out: string[] = []
    await walk(root, re, out, root, lim, ctx.signal, ignoreMatchers)
    const st = await stat(root).catch(() => null)
    if (!st) return `cwd not found: ${rawRoot}`
    if (out.length === 0) return `no files match ${pattern} in ${rawRoot}`
    return out.slice(0, lim).join("\n")
  },
}
