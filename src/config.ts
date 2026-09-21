import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { atomicWriteText } from "./lib/atomic-write.ts"
import { homeDir } from "./lib/db-path.ts"

// In-process lock per path untuk mencegah lost-update saat Pool(3) sub-agent
// menulis config yang sama secara paralel. Untuk lintas proses, atomicWriteText
// sudah cegah torn write, tapi tanpa CAS tetap last-wins; lock ini menutup
// kasus 99% (same-process) dengan biaya nol.
const configLocks = new Map<string, Promise<void>>()

// Diekspor agar provisioning (saveProvider/remove/refresh) memakai kunci yang
// SAMA dengan saveMcpServer/saveLspServer — tanpa ini dua penulis paralel
// (sesi utama + sub-agen Pool) baca-modifikasi-tulis tanpa lock dan last-wins
// menelan entri lain (reproducer audit #07: 8× saveProvider paralel → 1 selamat).
export async function withConfigLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = configLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((res) => (release = res))
  configLocks.set(
    path,
    prev.then(() => next),
  )
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (configLocks.get(path) === next) configLocks.delete(path)
  }
}

export interface ProviderEntry {
  id: string
  baseUrl: string
  /** API key. Kosong bila provider memakai OAuth (`auth: "oauth"`). */
  apiKey: string
  models: string[]
  providerHint?: string
  /** Knob generik reasoning effort — dipetakan per-wire (openai reasoning_effort, anthropic thinking, gemini). */
  reasoningEffort?: "low" | "medium" | "high"
  /**
   * Sumber kredensial. `oauth` = ambil access token dari `~/.minicode/auth.json`
   * saat runtime, jangan simpan di config (config bisa ikut ter-commit).
   */
  auth?: "apikey" | "oauth"
}

export interface McpServerEntry {
  id: string
  /** stdio: perintah yang di-spawn. Kosong bila memakai `url` (HTTP). */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Streamable HTTP / SSE endpoint. Bila diisi, `command` diabaikan. */
  url?: string
  /** Header tambahan untuk transport HTTP (mis. Authorization). */
  headers?: Record<string, string>
  /** Izinkan endpoint di host privat (server MCP lokal). Default: tolak (anti-SSRF). */
  allowPrivateHost?: boolean
}

export interface LspServerEntry {
  ext: string // ".ts"
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface MinicodeConfig {
  providers: ProviderEntry[]
  mcpServers?: McpServerEntry[]
  lspServers?: LspServerEntry[]
  verifyCommand?: string
  bashAllowlist?: string[]
}

// Diekspor agar lapisan provisioning (src/providers/provision.ts) membaca dan
// menulis berkas config yang sama tanpa menduplikasi path/normalisasi.
// FUNGSI bukan const: path dibaca tiap panggil agar hormat MINICODE_HOME yang
// diset belakangan (test hermetic, CI hermetic via env) — konsisten dengan
// DB/secrets lewat homeDir(). Const beku-saat-import membuat override env
// tak berpengaruh (dulu provider "bocor" ke home asli saat MINICODE_HOME set).
export function globalConfigPath(): string {
  return join(homeDir(), ".minicode", "config.json")
}
export const LOCAL = ".minicode/config.json"

/** Path absolut config lokal untuk cwd — untuk status/doctor tanpa membacanya. */
export function localConfigPath(cwd: string): string {
  return resolve(cwd, LOCAL)
}

/** Status satu-baris saat operator mengaktifkan local config; undefined bila
 * tak ada efek (flag mati atau berkas tak ada) agar CLI tidak berbohong. */
export function localConfigNotice(cwd: string, allowLocal: boolean): string | undefined {
  if (!allowLocal) return undefined
  const p = localConfigPath(cwd)
  if (!existsSync(p)) return undefined
  return `[config] local config enabled: ${p}`
}

export function normalizeConfig(raw: unknown): MinicodeConfig {
  const cfg = raw as Record<string, unknown>
  const providers = Array.isArray(cfg?.providers)
    ? (cfg.providers as ProviderEntry[]).filter(
        (p) => p && typeof p.id === "string" && typeof p.baseUrl === "string",
      )
    : []
  // Server MCP sah bila punya `command` (stdio) ATAU `url` (HTTP). Entri tanpa
  // keduanya dibuang di sini supaya kegagalan tampak saat config dibaca, bukan
  // sebagai error misterius saat connect.
  const mcpServers = Array.isArray(cfg?.mcpServers)
    ? (cfg.mcpServers as McpServerEntry[]).filter(
        (m) =>
          m &&
          typeof m.id === "string" &&
          (typeof m.command === "string" || typeof m.url === "string"),
      )
    : undefined
  const lspServers = Array.isArray(cfg?.lspServers)
    ? (cfg.lspServers as LspServerEntry[]).filter(
        (l) => l && typeof l.ext === "string" && typeof l.command === "string",
      )
    : undefined
  const verifyCommand =
    typeof cfg?.verifyCommand === "string" ? (cfg.verifyCommand as string) : undefined
  const bashAllowlist = Array.isArray(cfg?.bashAllowlist)
    ? (cfg.bashAllowlist as string[]).filter((s) => typeof s === "string")
    : undefined
  return {
    providers,
    ...(mcpServers ? { mcpServers } : {}),
    ...(lspServers ? { lspServers } : {}),
    ...(verifyCommand ? { verifyCommand } : {}),
    ...(bashAllowlist ? { bashAllowlist } : {}),
  }
}

export async function writeConfigAtomic(path: string, cfg: MinicodeConfig): Promise<void> {
  await atomicWriteText(path, JSON.stringify(cfg, null, 2))
}

export async function loadConfig(
  cwd = process.cwd(),
  opts: { allowLocal?: boolean } = {},
): Promise<MinicodeConfig> {
  let globalCfg: MinicodeConfig = { providers: [] }
  let localCfg: MinicodeConfig = { providers: [] }
  try {
    const raw = await readFile(globalConfigPath(), "utf8")
    globalCfg = normalizeConfig(JSON.parse(raw))
  } catch (e) {
    // ENOENT (belum ada file) = mulai kosong, diam. Error LAIN (EACCES,
    // EISDIR, …) dulu ditelan menjadi "no providers" sehingga user menambah
    // duplikat tanpa tahu config globalnya tak terbaca — beri tahu.
    const code = (e as NodeJS.ErrnoException)?.code
    if (e instanceof SyntaxError)
      process.stderr.write(`[config] invalid JSON in ${globalConfigPath()}: ${e.message}\n`)
    else if (code !== "ENOENT")
      process.stderr.write(
        `[config] cannot read ${globalConfigPath()} (${code ?? "error"}) — starting empty\n`,
      )
  }
  // Local `.minicode/config.json` adalah input repo tak terpercaya (audit #07
  // P0: mcpServers langsung di-spawn, baseUrl jahat menyedot prompt,
  // verifyCommand dieksekusi). Ia HANYA dibaca bila operator opt-in eksplisit
  // (--allow-local-config / MINICODE_ALLOW_LOCAL_CONFIG=1); default = global
  // saja (fail-closed). Tulis eksplisit (--local) tak terpengaruh.
  if (opts.allowLocal) {
    try {
      const localPath = resolve(cwd, LOCAL)
      const raw = await readFile(localPath, "utf8")
      localCfg = normalizeConfig(JSON.parse(raw))
    } catch (e) {
      // Sama seperti global: SyntaxError selalu ribut; error baca non-ENOENT
      // (EACCES/…) ribut juga — reset diam-diam membuat override lokal
      // "hilang" tanpa jejak.
      const code = (e as NodeJS.ErrnoException)?.code
      if (e instanceof SyntaxError)
        process.stderr.write(
          `[config] invalid JSON in ${resolve(cwd, LOCAL)}: ${(e as Error).message}\n`,
        )
      else if (code !== "ENOENT")
        process.stderr.write(
          `[config] cannot read ${resolve(cwd, LOCAL)} (${code ?? "error"}) — ignoring local\n`,
        )
    }
  }
  // generic merge helper — deduplicate DRY
  function mergeByKey<T>(global: T[], local: T[], keyFn: (v: T) => string): T[] {
    const map = new Map<string, T>()
    for (const v of global) map.set(keyFn(v), v)
    for (const v of local) {
      const k = keyFn(v)
      // Override lokal MENGGANTI nilai di posisi global, bukan pindah ke
      // akhir: JS Map.set pada key lama mempertahankan urutan. Dulu
      // delete-then-set memindahkan provider ter-override ke ujung sehingga
      // providers[0] (default model sesi) berganti diam-diam tiap ada
      // override lokal ("default flip").
      map.set(k, v)
    }
    return [...map.values()]
  }
  const mergedProviders = mergeByKey(globalCfg.providers, localCfg.providers, (p) => p.id)
  const mergedMcp = mergeByKey(globalCfg.mcpServers ?? [], localCfg.mcpServers ?? [], (m) => m.id)
  const mergedLsp = mergeByKey(globalCfg.lspServers ?? [], localCfg.lspServers ?? [], (l) =>
    l.ext.toLowerCase(),
  )
  return {
    providers: mergedProviders,
    mcpServers: mergedMcp,
    lspServers: mergedLsp,
    ...((localCfg.verifyCommand ?? globalCfg.verifyCommand)
      ? { verifyCommand: localCfg.verifyCommand ?? globalCfg.verifyCommand }
      : {}),
    ...((localCfg.bashAllowlist ?? globalCfg.bashAllowlist)
      ? { bashAllowlist: localCfg.bashAllowlist ?? globalCfg.bashAllowlist }
      : {}),
  }
}

// Model terakhir dipakai (satu nilai global) — default sesi berikutnya bila
// tanpa --model dan modelnya masih ada di config. File kecil terpisah
// (~/.minicode/state.json, bukan config provider) agar tak ikut ter-commit
// dan tak bercampur merge global/lokal. Fire-and-forget oleh pemanggil:
// IO gagal tak boleh menggagalkan sesi.
const statePath = () => join(homeDir(), ".minicode", "state.json")

export async function loadLastModel(): Promise<string | undefined> {
  try {
    const raw = await readFile(statePath(), "utf8")
    const m = (JSON.parse(raw) as { lastModel?: unknown }).lastModel
    return typeof m === "string" && m ? m : undefined
  } catch {
    return undefined
  }
}

export async function saveLastModel(id: string): Promise<void> {
  const path = statePath()
  return withConfigLock(path, async () => {
    await mkdir(join(homeDir(), ".minicode"), { recursive: true, mode: 0o700 }).catch(() => {})
    // Merge (bukan timpa): state.json menampung preferensi lain (lang).
    // Timpa utuh menghapusnya diam-diam.
    let cur: Record<string, unknown> = {}
    try {
      cur = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    } catch {}
    await atomicWriteText(path, JSON.stringify({ ...cur, lastModel: id }))
  })
}

/** Bahasa UI ("en"|"id") dari state.json; undefined = belum memilih. */
export async function loadLang(): Promise<"en" | "id" | undefined> {
  try {
    const raw = await readFile(statePath(), "utf8")
    const l = (JSON.parse(raw) as { lang?: unknown }).lang
    return l === "en" || l === "id" ? l : undefined
  } catch {
    return undefined
  }
}

export async function saveLang(lang: "en" | "id"): Promise<void> {
  const path = statePath()
  return withConfigLock(path, async () => {
    await mkdir(join(homeDir(), ".minicode"), { recursive: true, mode: 0o700 }).catch(() => {})
    let cur: Record<string, unknown> = {}
    try {
      cur = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    } catch {}
    await atomicWriteText(path, JSON.stringify({ ...cur, lang }))
  })
}

export async function saveMcpServer(
  entry: McpServerEntry,
  opts: { global?: boolean; cwd?: string } = {},
) {
  if (!entry.id || (!entry.command && !entry.url))
    throw new Error("mcp entry needs an id + (command for stdio or url for http)")
  const path =
    (opts.global ?? true) ? globalConfigPath() : resolve(opts.cwd ?? process.cwd(), LOCAL)
  return withConfigLock(path, async () => {
    let cfg: MinicodeConfig = { providers: [] }
    let raw = ""
    try {
      raw = await readFile(path, "utf8")
      cfg = normalizeConfig(JSON.parse(raw))
    } catch (e) {
      if (e instanceof SyntaxError) {
        const backup = `${path}.corrupt.${Date.now()}`
        await atomicWriteText(backup, raw).catch(() => {})
        throw new Error(`config corrupt: ${path} — backup to ${backup}: ${e.message}`)
      }
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        cfg = { providers: [] }
      } else if ((e as Error).message?.includes("config corrupt")) {
        throw e
      } else if ((e as NodeJS.ErrnoException).code) {
        throw e
      } else {
        cfg = { providers: [] }
      }
    }
    cfg.mcpServers ??= []
    const idx = cfg.mcpServers.findIndex((m) => m.id === entry.id)
    if (idx >= 0) cfg.mcpServers[idx] = entry
    else cfg.mcpServers.push(entry)
    await writeConfigAtomic(path, cfg)
  })
}

export async function removeMcpServer(id: string, opts: { global?: boolean; cwd?: string } = {}) {
  const path =
    (opts.global ?? true) ? globalConfigPath() : resolve(opts.cwd ?? process.cwd(), LOCAL)
  return withConfigLock(path, async () => {
    let cfg: MinicodeConfig = { providers: [] }
    let raw = ""
    try {
      raw = await readFile(path, "utf8")
      cfg = normalizeConfig(JSON.parse(raw))
    } catch (e) {
      if (e instanceof SyntaxError) {
        const backup = `${path}.corrupt.${Date.now()}`
        await atomicWriteText(backup, raw).catch(() => {})
        throw new Error(`config corrupt: ${path} — backup to ${backup}: ${e.message}`)
      }
      if ((e as NodeJS.ErrnoException).code === "ENOENT") cfg = { providers: [] }
      else if ((e as Error).message?.includes("config corrupt")) throw e
      else if ((e as NodeJS.ErrnoException).code) throw e
      else cfg = { providers: [] }
    }
    cfg.mcpServers = (cfg.mcpServers ?? []).filter((m) => m.id !== id)
    await writeConfigAtomic(path, cfg)
  })
}

function normalizeExt(ext: string): string {
  return ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`
}

export async function saveLspServer(
  entry: LspServerEntry,
  opts: { global?: boolean; cwd?: string } = {},
) {
  if (!entry.ext || !entry.command) throw new Error("lsp ext/command required")
  const path =
    (opts.global ?? true) ? globalConfigPath() : resolve(opts.cwd ?? process.cwd(), LOCAL)
  return withConfigLock(path, async () => {
    let cfg: MinicodeConfig = { providers: [] }
    let raw = ""
    try {
      raw = await readFile(path, "utf8")
      cfg = normalizeConfig(JSON.parse(raw))
    } catch (e) {
      if (e instanceof SyntaxError) {
        const backup = `${path}.corrupt.${Date.now()}`
        await atomicWriteText(backup, raw).catch(() => {})
        throw new Error(`config corrupt: ${path} — backup to ${backup}: ${e.message}`)
      }
      if ((e as NodeJS.ErrnoException).code === "ENOENT") cfg = { providers: [] }
      else if ((e as Error).message?.includes("config corrupt")) throw e
      else if ((e as NodeJS.ErrnoException).code) throw e
      else cfg = { providers: [] }
    }
    cfg.lspServers ??= []
    const ext = normalizeExt(entry.ext)
    const idx = cfg.lspServers.findIndex((l) => l.ext.toLowerCase() === ext)
    if (idx >= 0) cfg.lspServers[idx] = { ...entry, ext }
    else cfg.lspServers.push({ ...entry, ext })
    await writeConfigAtomic(path, cfg)
  })
}

export async function removeLspServer(ext: string, opts: { global?: boolean; cwd?: string } = {}) {
  const path =
    (opts.global ?? true) ? globalConfigPath() : resolve(opts.cwd ?? process.cwd(), LOCAL)
  return withConfigLock(path, async () => {
    let cfg: MinicodeConfig = { providers: [] }
    let raw = ""
    try {
      raw = await readFile(path, "utf8")
      cfg = normalizeConfig(JSON.parse(raw))
    } catch (e) {
      if (e instanceof SyntaxError) {
        const backup = `${path}.corrupt.${Date.now()}`
        await atomicWriteText(backup, raw).catch(() => {})
        throw new Error(`config corrupt: ${path} — backup to ${backup}: ${e.message}`)
      }
      if ((e as NodeJS.ErrnoException).code === "ENOENT") cfg = { providers: [] }
      else if ((e as Error).message?.includes("config corrupt")) throw e
      else if ((e as NodeJS.ErrnoException).code) throw e
      else cfg = { providers: [] }
    }
    cfg.lspServers = (cfg.lspServers ?? []).filter((l) => l.ext.toLowerCase() !== normalizeExt(ext))
    await writeConfigAtomic(path, cfg)
  })
}
