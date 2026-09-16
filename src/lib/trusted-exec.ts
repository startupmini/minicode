import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

// Resolusi executable TERPERCAYA (audit #10 P0).
//
// Masalah: `spawn("git", …, { cwd: workspace })` di Windows memakai urutan
// pencarian CreateProcess yang mencari DIREKTORI CWD lebih dulu daripada PATH.
// Repo yang dibuka cukup menaruh `git.bat`/`git.cmd`/`git.exe` → operasi git
// otomatis minicode (mis. `git ls-files` saat membangun system prompt setiap
// sesi) menjalankan kode repo TANPA persetujuan. Mengubah PATH child TIDAK
// menolong (cwd tetap menang), jadi resolusi harus absolut.
//
// Solusi: cari nama di entri PATH yang VALID (absolut, bukan ""/"."), memakai
// PATHEXT di Windows, TANPA pernah melihat cwd. Bila tak ketemu → kembalikan
// nama telanjang (perilaku lama) supaya kegagalan tetap fail-open seperti
// semula, tetapi kasus umum (git terpasang di PATH) jadi aman dari hijack.

const isWin = process.platform === "win32"

function validPathEntries(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? ""
  const out: string[] = []
  for (const entry of raw.split(delimiter)) {
    if (!entry) continue // "" = direktori kerja (bahaya)
    if (!isAbsolute(entry)) continue // relatif = tak dapat dipercaya
    out.push(entry)
  }
  return out
}

function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p)
    if (!st.isFile()) return false
    if (isWin) return true
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const cache = new Map<string, string>()

/**
 * Kembalikan path absolut terpercaya untuk `name`, atau `name` itu sendiri
 * bila tak ditemukan (fail-open, sama seperti perilaku spawn bawaan).
 * Hasil di-cache per proses.
 */
export function resolveTrustedExecutable(name: string): string {
  const cached = cache.get(name)
  if (cached) return cached
  const resolved = resolveUncached(name)
  cache.set(name, resolved)
  return resolved
}

function resolveUncached(name: string): string {
  // Nama yang sudah absolut atau memuat pemisah path (mis. "./scripts/x",
  // "tools\\run.exe") adalah pilihan eksplisit pemanggil — jangan diubah.
  if (isAbsolute(name)) return name
  if (name.includes("/") || name.includes("\\")) return name
  const exts = isWin
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((e) => e.trim())
        .filter(Boolean)
    : [""]
  for (const dir of validPathEntries()) {
    if (isWin) {
      for (const ext of exts) {
        const candidate = join(dir, name.endsWith(ext.toLowerCase()) ? name : name + ext)
        if (isExecutableFile(candidate)) return candidate
      }
    } else {
      const candidate = join(dir, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return name
}
