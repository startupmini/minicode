import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { globalConfigPath, loadConfig } from "../../src/config.ts"
import { getMemoryStats } from "../../src/memory/vector.ts"
import { inspectBashCommand } from "../../src/policy/bash-guard.ts"
import { isPathOutsideRoot, isSensitive } from "../../src/policy/jail.ts"
import { loadPricingOverlay, pricingOverlayMeta } from "../../src/policy/pricing.ts"
import { scrubSecrets } from "../../src/policy/scrub.ts"
import { dockerAvailable } from "../../src/sandbox/docker.ts"
import { osSandboxAvailable, osSandboxTypeName } from "../../src/sandbox/os.ts"
import { c } from "../../src/ui/render/theme.ts"

const DOCTOR_HELP = `minicode doctor — diagnosis lingkungan lokal (tanpa jaringan)

  minicode doctor [--json] [--cwd <dir>]`

interface DoctorReport {
  bun: string
  platform: string
  providers: number
  providerModels: number
  pricing: { models: number; ageH: number | null; stale: boolean }
  memoryRows: number
  sandboxOs: string
  sandboxDocker: boolean
  fallbackNote: string
  configGlobal: boolean
  configLocal: boolean
  hardening: { bashGuard: boolean; jail: boolean; scrub: boolean; perms: boolean }
}

// Agregasi status yang sebelumnya tersebar di providers/pricing/memory —
// pola `codex doctor`: satu perintah untuk "apakah mesin ini siap jalan".
// Murni baca lokal: tanpa request jaringan, tanpa LLM, tanpa tulis file.
export async function buildDoctorReport(cwd?: string): Promise<DoctorReport> {
  const cfg = await loadConfig(cwd).catch(() => ({ providers: [] }))
  const providers = cfg.providers ?? []
  await loadPricingOverlay().catch(() => {})
  const meta = pricingOverlayMeta()
  let memRows = 0
  try {
    memRows = getMemoryStats(cwd).rows
  } catch {}
  const osSandbox = osSandboxAvailable() ? osSandboxTypeName() : "none"
  const docker = dockerAvailable()
  // Hardening probes — ringan, offline, tanpa LLM/jaringan
  const bashGuard = !inspectBashCommand("echo hi").denied && inspectBashCommand("rm -rf /").denied
  const jail =
    isPathOutsideRoot("../outside", cwd ?? ".") &&
    !isPathOutsideRoot("inside.txt", cwd ?? ".") &&
    isSensitive(".env")
  const scrub = scrubSecrets("sk-123456789012345678901234567890").includes("[REDACTED]")
  let perms = true
  try {
    const p = resolve(cwd ?? ".", ".minicode", "sessions.db")
    if (existsSync(p)) {
      const mode = statSync(p).mode & 0o777
      perms = process.platform === "win32" ? true : (mode & 0o077) === 0
    }
  } catch {
    perms = true
  }
  return {
    bun: process.version,
    platform: process.platform,
    providers: providers.length,
    providerModels: providers.reduce((n, p) => n + (p.models?.length ?? 0), 0),
    pricing: {
      models: meta?.count ?? 0,
      ageH: meta ? Math.round((Date.now() - meta.fetchedAt) / 3_600_000) : null,
      stale: meta?.stale ?? true,
    },
    memoryRows: memRows,
    sandboxOs: osSandbox,
    sandboxDocker: docker,
    // Tanpa isolasi OS (semua Windows) permission default turun ke allowlist —
    // lebih baik membatasi daripada berlabel aman palsu.
    fallbackNote:
      osSandbox === "none" && !docker
        ? "no OS/docker sandbox: default permission falls back to allowlist"
        : "sandbox available",
    configGlobal: existsSync(globalConfigPath()),
    configLocal: existsSync(resolve(cwd ?? ".", ".minicode", "config.json")),
    hardening: { bashGuard, jail, scrub, perms },
  }
}

export async function handleDoctor(
  args: string[],
  getArg: (name: string) => string | undefined,
): Promise<never> {
  const sub = args[1]
  if (sub === "--help" || sub === "-h") {
    console.log(DOCTOR_HELP)
    process.exit(0)
  }
  const r = await buildDoctorReport(getArg("--cwd"))
  if (getArg("--json") !== undefined || args.includes("--json")) {
    console.log(JSON.stringify(r))
    process.exit(0)
  }
  console.log(renderDoctorText(r))
  console.log("")
  process.exit(0)
}

/** Render teks dipisah agar teruji in-process (handleDoctor sendiri
 * memanggil process.exit sehingga hanya bisa diuji via subprocess). */
export function renderDoctorText(r: DoctorReport): string {
  const ok = c.green("ok")
  const warn = c.yellow("warn")
  const hk = r.hardening
  const hardOk = hk.bashGuard && hk.jail && hk.scrub && hk.perms
  const lines = [
    `\n${c.bold("minicode doctor")}`,
    `  runtime    ${r.bun} on ${r.platform}`,
    `  providers  ${r.providers} (${r.providerModels} models) ${r.providers && r.providerModels ? ok : `${warn} ${r.providers ? "(no models — run: minicode sync)" : "(run wizard or config add)"}`}`,
    `  pricing    ${r.pricing.models} overlay models` +
      (r.pricing.ageH == null
        ? ` ${warn} (never synced — run: pricing sync)`
        : `, age ${r.pricing.ageH}h${r.pricing.stale ? ` ${warn} (stale)` : ""}`),
    `  memory     ${r.memoryRows} rows`,
    `  sandbox    os=${r.sandboxOs} docker=${r.sandboxDocker ? "yes" : "no"} — ${r.fallbackNote}`,
    `  config     global=${r.configGlobal ? "yes" : "no"} ~/.minicode/config.json local=${r.configLocal ? "yes" : "no"}`,
    `  hardening  bash-guard:${hk.bashGuard ? ok : warn} jail:${hk.jail ? ok : warn} scrub:${hk.scrub ? ok : warn} perms:${hk.perms ? ok : warn} ${hardOk ? ok : warn}`,
  ]
  return lines.join("\n")
}
