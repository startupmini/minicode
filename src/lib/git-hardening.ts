import { spawnSync } from "node:child_process"
import { resolveTrustedExecutable } from "./trusted-exec.ts"

// Hardening argv untuk SEMUA pemanggilan git minicode (audit #10 P0).
//
// Model ancaman: direktori repo yang dibuka bisa membawa `.git/config`
// (hooksPath, fsmonitor, pager, filter/diff drivers) + `.git/hooks/*` +
// `.gitattributes`. Tanpa netralisasi, operasi git rutin (bahkan read-only
// seperti `status`/`diff`) mengeksekusi perintah repo: clean/smudge filters,
// textconv/diff.external, fsmonitor, hooks commit, pager.
//
// Aturan pemakaian:
// - GIT_SAFE_BASE di semua pemanggilan (tanpa kecuali).
// - GIT_NO_DIFF_DRIVERS di diff/log yang menampilkan konten.
// - gitFilterNeutralizers HANYA untuk plumbing internal (shadow
//   snapshot/restore) yang wajib byte-exact + tanpa eksekusi — JANGAN untuk
//   index user (LFS/semantik clean milik user, lihat git.ts). Pengecualian:
//   protokol `filter.<d>.process` diutamakan git di atas clean/smudge, jadi
//   neutralizer selalu mematikannya (nilai kosong = fallback ke clean/smudge)
//   di SEMUA jalur plumbing; jalur user-index hanya diperingatkan, bukan diubah.

/** Netralisasi universal: tanpa hooks, tanpa fsmonitor, tanpa pager. */
export const GIT_SAFE_BASE: readonly string[] = [
  "--no-pager",
  "-c",
  "core.hooksPath=/nonexistent-minicode-nohooks",
  "-c",
  "core.fsmonitor=",
]

/** Netralisasi driver konten untuk diff/log (tanpa eksekusi repo). */
export const GIT_NO_DIFF_DRIVERS: readonly string[] = ["--no-ext-diff", "--no-textconv"]

const DRIVER_RE = /^filter\.([A-Za-z0-9_.-]+)\.(?:clean|smudge|process)\b/

export interface FilterDriver {
  name: string
  /** Driver memakai protokol process (long-running) — diutamakan git di atas
   * clean/smudge, sehingga override clean/smudge saja TIDAK cukup. */
  hasProcess: boolean
}

/**
 * Daftar driver filter yang TERKONFIGURASI di repo (discovery read-only via
 * `git config`, tanpa hook/filter/pager). Dipakai neutralizer plumbing DAN
 * peringatan jalur user-index (git_commit) agar eksekusi filter repo tidak
 * pernah diam-diam.
 */
export async function discoverFilterDrivers(cwd: string): Promise<FilterDriver[]> {
  try {
    const r = spawnSync(
      resolveTrustedExecutable("git"),
      ["config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"],
      { cwd, encoding: "utf8", timeout: 10_000 },
    )
    if (r.status !== 0 || !r.stdout) return []
    const drivers = new Map<string, FilterDriver>()
    for (const line of r.stdout.split("\n")) {
      const m = DRIVER_RE.exec(line.trim())
      if (!m?.[1]) continue
      const d = drivers.get(m[1]) ?? { name: m[1], hasProcess: false }
      if (line.includes(".process")) d.hasProcess = true
      drivers.set(m[1], d)
    }
    return [...drivers.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
  } catch {
    return []
  }
}

/**
 * Bangun override `-c filter.<d>.clean=cat -c filter.<d>.smudge=cat` untuk
 * semua driver clean/smudge yang TERKONFIGURASI. `cat` = identitas byte
 * (snapshot/restore tetap konsisten) tanpa mengeksekusi perintah repo.
 * Discovery via `git config` (plumbing baca murni: tanpa hook/filter/pager).
 */
export async function gitFilterNeutralizers(cwd: string): Promise<string[]> {
  const drivers = await discoverFilterDrivers(cwd)
  const out: string[] = []
  for (const d of drivers) {
    out.push("-c", `filter.${d.name}.clean=cat`, "-c", `filter.${d.name}.smudge=cat`)
    // Protokol process DIUTAMAKAN git di atas clean/smudge: tanpa override
    // ini, `git add` tetap mengeksekusi filter process repo meski clean=cat
    // (terbukti via probe diagnostik: marker process jalan, clean tidak).
    // Nilai kosong diperlakukan sebagai unset → fallback ke clean/smudge
    // (cat di jalur plumbing; milik pengguna di jalur user-index) — tanpa
    // noise error dan tanpa merusak driver clean/smudge yang sah (LFS).
    if (d.hasProcess) out.push("-c", `filter.${d.name}.process=`)
  }
  return out
}
