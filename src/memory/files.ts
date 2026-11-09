import { appendFile, mkdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { LIMITS } from "../constants.ts"
import { homeDir } from "../lib/db-path.ts"
import { safeReadFileCapped } from "../lib/safe-open.ts"
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
      const { text, truncated } = await safeReadFileCapped(
        p,
        p === globalMem ? dirname(p) : cwd,
        6000,
      )
      if (text.trim())
        parts.push(
          `# ${tildePath(p)}\n${scrubSecrets(text)}${truncated ? "\n… [truncated: showing first 6000 bytes]" : ""}`,
        )
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
        const { text, truncated } = await safeReadFileCapped(full, cwd, 3000)
        if (text.trim())
          parts.push(
            `# rules/${f}\n${scrubSecrets(text)}${truncated ? "\n… [truncated: showing first 3000 bytes]" : ""}`,
          )
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

export async function appendMemory(
  text: string,
  cwd = process.cwd(),
  tags?: readonly string[],
): Promise<string> {
  const path = resolve(cwd, LOCAL_MEM)
  return withMemLock(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => {})
    // [Area E / D5] JANGAN potong per-entri di sini. Batas 1000 karakter lama
    // membuat MEMORY.md lebih pendek daripada chunk vektor (2000) sehingga
    // reconcile menganggap chunk ekor "vector-only" dan menghapusnya. Batas
    // ukuran total berkas tetap dijaga MAX_MEMORY_FILE_BYTES di bawah.
    const clean = scrubSecrets(text.trim())
    // [Area E / D2] Provenance (MEM-01) benar-benar ditulis ke berkas — tanpa
    // tag ini jalur revoke-by-provenance tidak punya bukti di sisi file dan
    // gagal-closed (atau, pada versi lama, menghapus SEMUA baris tanpa tag).
    const meta = tags && tags.length > 0 ? ` [tags: ${JSON.stringify(tags)}]` : ""
    const entry = `- ${new Date().toISOString().slice(0, 10)} ${clean}${meta}\n`
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
        const rawKeep = txt.slice(-LIMITS.MEMORY_TRUNCATE_KEEP_BYTES)
        // Cari batas entri utuh berikutnya (diawali \n- ) agar entri pertama tak terpotong buntung
        const entryBoundary = rawKeep.indexOf("\n- ")
        const cut = entryBoundary >= 0 ? entryBoundary + 1 : rawKeep.indexOf("\n")
        const trimmed = cut >= 0 ? rawKeep.slice(cut + (entryBoundary >= 0 ? 0 : 1)) : rawKeep
        const { atomicWriteText } = await import("../lib/atomic-write.ts")
        await atomicWriteText(path, trimmed)
      }
    } catch {}
    return path
  })
}

export async function readMemoryFile(cwd = process.cwd()): Promise<string> {
  return await loadMemoryFiles(cwd)
}

/**
 * [Area E / D6] Ambil teks entri dari satu baris MEMORY.md — buang prefix
 * tanggal dan metadata `[tags: ...]`. Dipakai supersession untuk mencocokkan
 * baris lama tanpa bergantung pada posisi/urutan.
 */
export function memoryLineText(line: string): string {
  const match = line.match(/^-\s+\d{4}-\d{2}-\d{2}(?:T\S+)?\s+(.+)$/)
  const body = match
    ? match[1]!
    : line
        .trim()
        .replace(/^-\s+\S+\s+/, "")
        .trim()
  const tagMatch = body.match(/\[tags:\s*[^\]]+\]/)
  return (tagMatch ? body.slice(0, tagMatch.index!) : body).trim()
}

/**
 * [Area E / D6] Hapus SATU entri MEMORY.md lokal berdasarkan teksnya.
 *
 * `target` boleh berupa teks utuh (entri pendek) atau prefix chunk pertama
 * (entri multi-chunk yang tersimpan utuh di berkas). `startsWith` diperlukan
 * karena baris lama yang panjang tidak lagi dipotong saat append.
 *
 * Fail-closed: berkas tak ada / tak ada baris yang cocok → `false`, bukan
 * menulis ulang berkas tanpa perubahan.
 */
export async function deleteMemoryEntry(target: string, cwd = process.cwd()): Promise<boolean> {
  const needle = target.trim()
  if (!needle) return false
  const path = resolve(cwd, LOCAL_MEM)
  return withMemLock(path, async () => {
    let txt: string
    try {
      txt = await readFile(path, "utf8")
    } catch {
      return false
    }
    const lines = txt.split("\n")
    let removed = 0
    const kept = lines.filter((line) => {
      if (!line.startsWith("- ")) return true
      const text = memoryLineText(line)
      const hit = text === needle || text.startsWith(needle)
      if (hit) removed++
      return !hit
    })
    if (removed === 0) return false
    const { atomicWriteText } = await import("../lib/atomic-write.ts")
    await atomicWriteText(path, kept.join("\n"))
    return true
  })
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
