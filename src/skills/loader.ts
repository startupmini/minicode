import type { Dirent } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { isRealPathOutsideRoot } from "../policy/jail.ts"

export interface Skill {
  name: string
  description: string
  body: string // prompt template
  path: string
  /** F4.1: frontmatter `disable-model-invocation: true` — skill HANYA via
   * `/nama` eksplisit, tak masuk katalog auto-pick system prompt. Untuk
   * workflow yang tak boleh dipicu model sendiri (deploy/rilis). */
  manualOnly: boolean
  /** F4.1: aset opsional gaya Zed — folder sibling `<nama>/` berisi
   * `scripts/` dan `references/` (daftar nama berkas, hanya info agar model
   * bisa membacanya via read_file; TIDAK dieksekusi otomatis). */
  assets: { scripts: string[]; references: string[] }
}

const GLOBAL_SKILLS = join(homedir(), ".minicode", "skills")
const LOCAL_SKILLS = ".minicode/skills"

function parseFrontmatter(txt: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {}
  let body = txt
  if (txt.startsWith("---")) {
    // find closing --- at start of line (avoid body "---" hr)
    const end = txt.indexOf("\n---", 3)
    if (end !== -1) {
      const closeEnd = end + 4 // \n--- + \n?
      for (const line of txt.slice(3, end).split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const idx = trimmed.indexOf(":")
        if (idx > 0) {
          const key = trimmed.slice(0, idx).trim()
          let val = trimmed.slice(idx + 1).trim()
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1)
          }
          meta[key] = val
        }
      }
      body = txt.slice(closeEnd).trim()
      // strip leading --- line leftover
      if (body.startsWith("---")) body = body.slice(3).trim()
    }
  }
  return { meta, body }
}

async function loadDir(dir: string, out: Skill[], root: string = dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const full = join(dir, e.name)
    // Symlink escape (temuan audit #06): readdir+readFile mengikuti symlink,
    // sehingga skill/dir link keluar workspace ikut dimuat. Tolak yang
    // realpath-nya di luar root kepercayaannya (global vs proyek).
    if (isRealPathOutsideRoot(full, root)) continue
    if (e.isDirectory()) {
      // F4.1: folder aset sibling (<skill>/scripts|references) BUKAN wadah
      // skill — tanpa ini references/guide.md ikut dimuat sebagai skill
      // "guide" dan mengotori katalog. Terdeteksi via <skill>.md di parent.
      if ((e.name === "scripts" || e.name === "references") && (await isAssetDir(dir))) continue
      // recursive 1-level deep for nested skills
      await loadDir(full, out, root)
      continue
    }
    if (!e.isFile() || !e.name.endsWith(".md")) continue
    const txt = await readFile(full, "utf8").catch(() => "")
    if (!txt.trim()) continue
    const { meta, body } = parseFrontmatter(txt)
    const rawName = meta.name ?? e.name.replace(/\.md$/, "")
    const name = rawName
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
    // F4.1: nilai truthy longgar ("true"/"1"/"yes", case-insensitive) —
    // frontmatter YAML-ish ditulis manusia, bukan mesin.
    const manualOnly = /^(true|1|yes)$/i.test((meta["disable-model-invocation"] ?? "").trim())
    out.push({
      name: name || rawName,
      description: meta.description ?? body.split("\n")[0]?.slice(0, 100) ?? "",
      body,
      path: full,
      manualOnly,
      assets: await loadSkillAssets(dir, e.name.replace(/\.md$/, ""), root),
    })
  }
}

/** F4.1: true bila `dir` adalah folder aset skill — yaitu `<base>/scripts`
 * atau `<base>/references` dengan `<base>.md` di parent-nya. Hanya dua nama
 * itu yang istimewa; folder skill biasa (mis. `deploy/`) tetap direkursi. */
async function isAssetDir(dir: string): Promise<boolean> {
  const base = basename(dir)
  try {
    await stat(join(dirname(dir), `${base}.md`))
    return true
  } catch {
    return false
  }
}
async function loadSkillAssets(
  dir: string,
  base: string,
  root: string,
): Promise<{ scripts: string[]; references: string[] }> {
  const empty = { scripts: [], references: [] }
  // base dari nama berkas .md sendiri (sudah lewat slug) — tanpa separator
  // path, jadi join aman; tetap lewat guard realpath per entri di bawah.
  if (base.includes("/") || base.includes("\\") || base === "" || base === "." || base === "..")
    return empty
  const out: { scripts: string[]; references: string[] } = { scripts: [], references: [] }
  for (const [key, sub] of [
    ["scripts", "scripts"],
    ["references", "references"],
  ] as const) {
    const subdir = join(dir, base, sub)
    let entries: Dirent[]
    try {
      entries = await readdir(subdir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const en of entries) {
      if (out[key].length >= 20) break
      if (!en.isFile() || en.name.startsWith(".")) continue
      const full = join(subdir, en.name)
      if (isRealPathOutsideRoot(full, root)) continue
      out[key].push(en.name)
    }
  }
  return out
}

let skillsCache: { cwd: string; at: number; skills: Skill[] } | undefined
const SKILLS_CACHE_TTL_MS = 5 * 60 * 1000

export async function loadSkills(cwd = process.cwd()): Promise<Skill[]> {
  // cache in-memory 5 menit — loadSkills dipanggil berulang (setup, REPL, one-shot)
  const now = Date.now()
  const key = resolve(cwd)
  if (skillsCache && skillsCache.cwd === key && now - skillsCache.at < SKILLS_CACHE_TTL_MS) {
    return skillsCache.skills
  }
  const skills: Skill[] = []
  await loadDir(GLOBAL_SKILLS, skills)
  await loadDir(resolve(cwd, LOCAL_SKILLS), skills)
  // local overrides global by name
  const map = new Map<string, Skill>()
  for (const s of skills) map.set(s.name, s)
  skillsCache = { cwd: key, at: now, skills: [...map.values()] }
  return skillsCache.skills
}

export function invalidateSkillCache(): void {
  skillsCache = undefined
}

export async function renderSkill(skill: Skill, args: string): Promise<string> {
  return skill.body.replace(/\{\{args\}\}/g, args).replace(/\$ARGUMENTS/g, args)
}

export async function findSkill(name: string, cwd = process.cwd()): Promise<Skill | undefined> {
  const all = await loadSkills(cwd)
  return all.find((s) => s.name === name || s.name === name.replace(/^\//, ""))
}

export function skillsToSystemPrompt(skills: Skill[]): string {
  // F4.1: manualOnly TAK masuk katalog auto-pick — model tak boleh memicu
  // workflow berbahaya sendiri; user memanggil eksplisit via /nama (findSkill
  // tetap menemukannya). Aset dicantumkan sebagai petunjuk baca, bukan
  // eksekusi: model memakai read_file bila perlu.
  const auto = skills.filter((s) => !s.manualOnly)
  if (auto.length === 0) return ""
  const line = (s: Skill): string => {
    const hints: string[] = []
    if (s.assets.scripts.length > 0) hints.push(`scripts: ${s.assets.scripts.join(", ")}`)
    if (s.assets.references.length > 0) hints.push(`refs: ${s.assets.references.join(", ")}`)
    return `- /${s.name}: ${s.description}${hints.length ? ` (${hints.join("; ")})` : ""}`
  }
  return `\n# Available skills (use via /name or ask)\n${auto.map(line).join("\n")}`
}
