import { appendFile, mkdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { LIMITS } from "../constants.ts"
import { homeDir } from "../lib/db-path.ts"
import { isRealPathOutsideRoot } from "../policy/jail.ts"
import { scrubSecrets } from "../policy/scrub.ts"

function tildePath(p: string): string {
  const home = homedir()
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

// Jalur global DIHITUNG per panggil (bukan const modul): homeDir() hormat
// MINICODE_HOME saat runtime (hermetic test + XDG-ish, sama seperti DB).
// Const modul akan membekukan home saat import pertama (audit 2026-09-16 M4).
const globalMemPath = (): string => join(homeDir(), ".minicode", "MEMORY.md")
const LOCAL_MEM = ".minicode/MEMORY.md"
const ROOT_MEM = "MEMORY.md"
// Claude-like hierarchy extensions
const CLAUDE_MEM = "CLAUDE.md"

export async function loadMemoryFiles(cwd = process.cwd()): Promise<string> {
  const parts: string[] = []
  const globalMem = globalMemPath()
  // Hierarchy: global → local → root → CLAUDE compat → rules/
  const candidates = [
    globalMem,
    resolve(cwd, LOCAL_MEM),
    resolve(cwd, ROOT_MEM),
    resolve(cwd, CLAUDE_MEM),
  ]
  for (const p of candidates) {
    try {
      // Symlink escape (temuan audit #06): kandidat fixed-name bisa berupa
      // symlink keluar workspace. globalMem (home) sengaja dikecualikan —
      // di luar cwd by design. Samakan rules/ di bawah ke realpath.
      if (p !== globalMem && isRealPathOutsideRoot(p, cwd)) continue
      const txt = await readFile(p, "utf8")
      if (txt.trim()) parts.push(`# ${tildePath(p)}\n${scrubSecrets(txt.slice(0, 6000))}`)
    } catch {}
  }
  // Load .minicode/rules/*.md (Kiro steering style)
  try {
    const { readdir } = await import("node:fs/promises")
    const rulesDir = resolve(cwd, ".minicode/rules")
    const entries = await readdir(rulesDir).catch(() => [] as string[])
    // entries may be string[] or Dirent — handle both
    const files: string[] =
      Array.isArray(entries) && typeof entries[0] === "string"
        ? (entries as string[]).filter((f) => f.endsWith(".md")).slice(0, 10)
        : (entries as unknown as import("node:fs").Dirent[])
            .filter((e) => e.isFile() && e.name.endsWith(".md"))
            .map((e) => e.name)
            .slice(0, 10)
    for (const f of files) {
      try {
        const full = join(rulesDir, f as string)
        if (isRealPathOutsideRoot(full, cwd)) continue
        const txt = await readFile(full, "utf8")
        if (txt.trim()) parts.push(`# rules/${f}\n${scrubSecrets(txt.slice(0, 3000))}`)
      } catch {}
    }
  } catch {}
  return parts.join("\n\n")
}

const MAX_MEMORY_FILE_BYTES = LIMITS.MEMORY_FILE_MAX_BYTES

// Kunci in-process per berkas (audit #09 P1): appendMemory (append +
// truncate-guard read-modify-write) dan deleteMemoryLines (read-filter-write)
// tanpa ini saling menelan — reproducer: forget vs 20 append konkuren →
// 0/20 selamat. Baca (loadMemoryFiles) sengaja tanpa lock: append O_APPEND
// atomik sehingga baca basi/robek sesaat tak berbahaya untuk retrieval.
const memLocks = new Map<string, Promise<void>>()

async function withMemLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = memLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((res) => (release = res))
  memLocks.set(
    path,
    prev.then(() => next),
  )
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (memLocks.get(path) === next) memLocks.delete(path)
  }
}

export async function appendMemory(text: string, cwd = process.cwd()): Promise<string> {
  const path = resolve(cwd, LOCAL_MEM)
  return withMemLock(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => {})
    const clean = scrubSecrets(text.trim().slice(0, 1000))
    const entry = `- ${new Date().toISOString().slice(0, 10)} ${clean}\n`
    // atomic append — no read+write race
    await appendFile(path, entry, "utf8").catch(async () => {
      // fallback if file not exists
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, entry, "utf8")
    })
    // size guard: truncate oldest if too large (keep last 150k)
    try {
      const st = await stat(path)
      if (st.size > MAX_MEMORY_FILE_BYTES) {
        const txt = await readFile(path, "utf8")
        const keep = txt.slice(-LIMITS.MEMORY_TRUNCATE_KEEP_BYTES)
        const cut = keep.indexOf("\n")
        await import("node:fs/promises").then((m) =>
          m.writeFile(path, cut >= 0 ? keep.slice(cut + 1) : keep, "utf8"),
        )
      }
    } catch {}
    return path
  })
}

export async function readMemoryFile(cwd = process.cwd()): Promise<string> {
  return await loadMemoryFiles(cwd)
}

/**
 * Hapus baris MEMORY.md lokal + global yang cocok query (temuan audit #06,
 * diperluas audit 2026-09-16 M4).
 *
 * forget_memory sebelumnya hanya menghapus baris vector — entri file
 * (sumber `file hits:` di read_memory) bertahan selamanya sehingga "lupa"
 * tidak pernah benar-benar terjadi di jalur file. Perluasan M4: read_memory
 * membaca hierarki lokal DAN global (loadMemoryFiles), jadi hapus lokal saja
 * tak tuntas — baris global yang cocok ikut dihapus. Pencocokan sama persis
 * dengan jalur baca (substring case-insensitive) agar hapus-menemukan apa
 * yang baca-temukan.
 */
export async function deleteMemoryLines(query: string, cwd = process.cwd()): Promise<number> {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  let total = 0
  for (const path of [resolve(cwd, LOCAL_MEM), globalMemPath()]) {
    total += await withMemLock(path, async () => {
      let txt: string
      try {
        txt = await readFile(path, "utf8")
      } catch {
        return 0
      }
      const kept = txt.split("\n").filter((l) => !l.toLowerCase().includes(q))
      const deleted = txt.split("\n").length - kept.length
      if (deleted === 0) return 0
      const { atomicWriteText } = await import("../lib/atomic-write.ts")
      await atomicWriteText(path, kept.join("\n"))
      return deleted
    })
  }
  return total
}
