// Update notifier — cek versi terbaru di npm, cache 24 jam, tampil sekali.
// Tanpa dependensi, tanpa blocking startup (fire-and-forget, timeout 2 dtk).
// Hormat offline: gagal fetch = diam. Hormat NO_UPDATE_CHECK=1 / CI=1.

import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const PKG_NAME = "@miniroom/minicode"
const CACHE_FILE = join(homedir(), ".minicode", "update-check.json")
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 2000

interface Cache {
  checkedAt: number
  latest: string
}

function shouldSkip(): boolean {
  if (process.env.NO_UPDATE_CHECK === "1") return true
  if (process.env.CI === "1") return true
  // Jangan ganggu JSONL pipeline
  if (process.argv.includes("--json") || process.argv.includes("--output-format")) return true
  return false
}

function semverLt(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => Number(x) || 0)
  const pb = b.split(".").map((x) => Number(x) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false
  }
  return false
}

async function readCache(): Promise<Cache | null> {
  try {
    // Lazy import — hindari top-level `node:fs/promises` bareng `bun:sqlite`
    // yang di Bun Windows nge-trigger `kWriteMonkeyPatchDefense` (lihat 0.9.7).
    const { readFile } = await import("node:fs/promises")
    const raw = await readFile(CACHE_FILE, "utf8")
    const j = JSON.parse(raw) as Cache
    if (typeof j.checkedAt === "number" && typeof j.latest === "string") return j
  } catch {}
  return null
}

async function writeCache(latest: string): Promise<void> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(join(homedir(), ".minicode"), { recursive: true })
    await writeFile(CACHE_FILE, JSON.stringify({ checkedAt: Date.now(), latest }), "utf8")
  } catch {}
}

async function fetchLatest(signal?: AbortSignal): Promise<string | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const onAbort = () => ctrl.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PKG_NAME)}/latest`, {
        signal: sig,
        headers: { accept: "application/json" },
      })
      clearTimeout(t)
      if (!res.ok) return null
      const j = (await res.json()) as { version?: string }
      return typeof j.version === "string" ? j.version : null
    } finally {
      clearTimeout(t)
      signal?.removeEventListener("abort", onAbort)
    }
  } catch {
    return null
  }
}

export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  if (shouldSkip()) return null
  const cached = await readCache()
  let latest: string | null = null
  if (cached && Date.now() - cached.checkedAt < TTL_MS) {
    latest = cached.latest
  } else {
    latest = await fetchLatest()
    if (latest) await writeCache(latest)
    else if (cached) latest = cached.latest // offline: pakai cache lama
  }
  if (!latest) return null
  if (semverLt(currentVersion, latest)) return latest
  return null
}

export function formatUpdateMessage(current: string, latest: string): string {
  return `Update tersedia ${current} → ${latest} — jalankan: npm update -g ${PKG_NAME}`
}

// ── Auto-update interaktif ──
// Saat REPL dibuka di terminal (TTY) dari salinan ter-install (global npm),
// minicode memeriksa versi terbaru, meng-install bila ada, lalu restart ke
// versi baru — tanpa update manual. Satu-satunya mutasi adalah `npm install -g`
// paket sendiri + respawn argv yang sama; gagal install = lanjut dengan versi
// lama + pesan manual (tak pernah memblokir pemakaian).

/** Guard env anti-loop restart: di-set saat respawn pasca-update. */
export const UPDATE_GUARD_ENV = "MINICODE_AUTO_UPDATE_DONE"

/** True bila kode berjalan dari salinan ter-install (bukan checkout source). */
export function isInstalledCopy(entry = process.argv[1] ?? ""): boolean {
  return entry.includes("node_modules")
}

export function isNewer(current: string, latest: string): boolean {
  return semverLt(current, latest)
}

export interface AutoUpdateDecision {
  run: boolean
  /** Alasan skip — untuk observability/test, bukan pesan user. */
  reason?: string
}

/**
 * Layak auto-update? Syarat SEMUA:
 * - stdin TTY (user membuka REPL, bukan pipe/CI)
 * - salinan ter-install (checkout source jangan disentuh npm)
 * - bukan mode machine (`exec`, `--json`) dan bukan `--help`/`--version`
 * - belum habis di-restart (guard env) dan tidak di-opt-out
 *   (`NO_UPDATE_CHECK=1`, `CI=1`, `MINICODE_AUTO_UPDATE=0`).
 */
export function shouldAutoUpdate(
  argv: string[] = process.argv.slice(2),
  opts: {
    stdinTTY?: boolean
    env?: NodeJS.ProcessEnv
    installed?: boolean
  } = {},
): AutoUpdateDecision {
  const env = opts.env ?? process.env
  if (env.NO_UPDATE_CHECK === "1") return { run: false, reason: "no-update-check" }
  if (env.CI === "1") return { run: false, reason: "ci" }
  const off = (env.MINICODE_AUTO_UPDATE ?? "").trim().toLowerCase()
  if (off === "0" || off === "false" || off === "off") return { run: false, reason: "opt-out" }
  if (env[UPDATE_GUARD_ENV] != null) return { run: false, reason: "already-restarted" }
  if (!(opts.stdinTTY ?? process.stdin.isTTY)) return { run: false, reason: "non-tty" }
  if (!(opts.installed ?? isInstalledCopy())) return { run: false, reason: "source-checkout" }
  if (argv.includes("--json") || argv.includes("--output-format"))
    return { run: false, reason: "machine-output" }
  if (argv.includes("-h") || argv.includes("--help") || argv.includes("-v"))
    return { run: false, reason: "help-version" }
  const first = argv.find((a) => !a.startsWith("-"))
  if (first === "exec") return { run: false, reason: "exec-mode" }
  return { run: true }
}

/**
 * Cek versi SELALU ke registry (abaikan cache 24 jam) khusus alur auto-update.
 * Offline/network-gagal = fallback cache lama; tetap tak ada = null.
 */
export async function checkForUpdateFresh(
  currentVersion: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const latest = await fetchLatest(signal)
  if (latest) await writeCache(latest)
  const eff = latest ?? (await readCache())?.latest ?? null
  if (!eff) return null
  return isNewer(currentVersion, eff) ? eff : null
}

export type InstallRunner = (cmd: string, args: string[]) => { status: number | null }

/** Install versi latest via npm global. Return true bila exit 0. Tak melempar. */
export function installUpdate(runner?: InstallRunner): boolean {
  try {
    const run: InstallRunner =
      runner ??
      ((cmd, args) => {
        // Windows: npm adalah .cmd → butuh shell; stdio inherit agar user
        // melihat progres install (interaktif, bukan CI).
        // Timeout 120 dtk: tanpa ini spawnSync memblokir event-loop selamanya
        // saat npm lambat (AV/UAC di Windows 15–60 dtk) — timer abort 1.8 dtk
        // dan spinner ikut beku sehingga terlihat hang. Timeout = gagal jujur
        // lalu lanjut versi lama, bukan gantung.
        const r = spawnSync(cmd, args, {
          stdio: "inherit",
          shell: process.platform === "win32",
          timeout: 120_000,
        })
        return { status: typeof r.status === "number" ? r.status : null }
      })
    return run("npm", ["install", "-g", `${PKG_NAME}@latest`]).status === 0
  } catch {
    return false
  }
}
