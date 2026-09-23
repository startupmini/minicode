// Harness PTY nyata untuk audit TUI (temuan audit skill `audit-tui`: tanpa
// harness PTY, seluruh bagian adversarial runtime audit jatuh jadi INFERRED).
// Spawn CLI minicode di pseudo-terminal SUNGGUHAN, kirim byte dari sisi
// "keyboard", resize, dan assert terhadap BYTE STREAM mentah — bukan mock
// stdin/stdout seperti tui-harness.ts.
//
// Batas platform (jujur, fail-open ke SKIP dengan alasan — bukan hijau palsu):
// - Linux/macOS (openpty): penuh. CI ubuntu-latest = jalur utama.
// - Windows (ConPTY): lib bisa di-load, tapi penyampaian output anak ke
//   onData di sebagian mesin dev rusak (ditemukan saat probe: bahkan
//   `cmd /c echo` tak menghasilkan byte). `ptyAvailable()` memeriksa ini;
//   test runtime skip dengan alasan eksplisit di mesin seperti itu.
// - `@lydell/node-pty` tidak terpasang: semua test PTY skip.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** Bentuk minimum proses PTY yang dipakai harness (tanpa types lib). */
interface PtyTerm {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
}
type PtySpawn = (file: string, args: string[], opts: Record<string, unknown>) => PtyTerm

let ptySpawn: PtySpawn | null | undefined
async function loadPty(): Promise<PtySpawn | null> {
  if (ptySpawn !== undefined) return ptySpawn
  try {
    // Deps opsional: dynamic import agar suite tetap jalan tanpa dia.
    const mod = (await import("@lydell/node-pty")) as
      | { spawn: PtySpawn }
      | { default: { spawn: PtySpawn } }
    const s = "spawn" in mod ? mod.spawn : mod.default.spawn
    ptySpawn = s
  } catch {
    ptySpawn = null
  }
  return ptySpawn
}

/** Hasil self-check PTY (di-cache; probe hanya jalan sekali per proses test). */
export interface PtyAvailability {
  ok: boolean
  reason: string
}
let availability: PtyAvailability | undefined

/**
 * Self-check: PTY dianggap hidup bila byte yang ditulis ANAK sampai ke onData.
 * Tanpa ini ConPTY yang rusak menghasilkan test yang menunggu selamanya —
 * atau lebih buruk, skip/hijau palsu. Probe = anak print satu penanda lalu
 * keluar; kita tunggu penanda itu muncul di stream.
 */
export async function ptyAvailable(): Promise<PtyAvailability> {
  if (availability) return availability
  const spawn = await loadPty()
  if (!spawn) {
    availability = { ok: false, reason: "@lydell/node-pty tidak terpasang (devDependencies)" }
    return availability
  }
  try {
    const child = spawn(
      process.execPath,
      ["--eval", "setTimeout(() => { console.log('MINICODE-PTY-PROBE'); process.exit(0) }, 150)"],
      { name: "xterm-256color", cols: 80, rows: 24, env: cleanEnvForChild() },
    )
    let out = ""
    child.onData((d: string) => (out += d))
    const got = await new Promise<boolean>((resolveGot) => {
      child.onExit(() => resolveGot(out.includes("MINICODE-PTY-PROBE")))
      setTimeout(() => resolveGot(out.includes("MINICODE-PTY-PROBE")), 6000)
    })
    availability = got
      ? { ok: true, reason: "ok" }
      : { ok: false, reason: "output anak tak pernah sampai ke onData (ConPTY rusak?)" }
  } catch (e) {
    availability = { ok: false, reason: `spawn PTY gagal: ${(e as Error).message}` }
  }
  return availability
}

/**
 * Env anak yang HERMETIK (audit F1b): proses test berbagi `process.env`, dan
 * test lain men-set `MINICODE_*`/`OPENAI_*` (mis. MINICODE_HOME, MINICODE_SANDBOX,
 * MINICODE_TIMEOUT_MS, ANTHROPIC_AUTH_TOKEN, OPENAI_BASE_URL). Anak yang
 * mewarisinya menjalankan jalur kode berbeda — terbukti: test `exec --json`
 * hijau sendirian tapi GAGAL di suite penuh (env provider bocor → anak mencoba
 * jaringan, envelope tak sesuai harapan). Strip semua prefiks provider/kontrol
 * lalu isi ulang hanya yang memang dibutuhkan test.
 */
export function cleanEnvForChild(extra: Record<string, string | undefined> = {}) {
  const providerOrControlEnv =
    /^(MINICODE_|OPENAI|ANTHROPIC|DEEPSEEK|AGENT_|TOKENHARBOR|GEMINI|GROQ|MISTRAL|OPENROUTER|TAVILY|CODEX_)/
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (providerOrControlEnv.test(k)) continue
    out[k] = v
  }
  return { ...out, ...extra }
}

export interface TuiPtyHandle {
  /** Byte stream mentah sejauh ini (append-only). */
  raw(): string
  /** Kirim byte ke PTY (sisi keyboard). */
  send(data: string): void
  /** Resize terminal (geometri nyata — anak menerima SIGWINCH / reflow). */
  resize(cols: number, rows: number): void
  /** Tunggu `pred(raw)` true ATAU timeout (default 20s) → error berisi ekor stream. */
  waitFor(pred: (raw: string) => boolean, timeoutMs?: number): Promise<void>
  /** Kirim sinyal (POSIX: "SIGTERM"/"SIGKILL"; Windows: terminate). */
  kill(signal?: string): void
  /** Resolve saat proses anak mati. */
  exit(): Promise<{ exitCode: number; signal?: number }>
  /** Matikan anak (bila masih hidup) + hapus workspace hermetic. */
  dispose(): void
  /** Direktori kerja hermetic sesi ini. */
  readonly cwd: string
}

export interface SpawnTuiOptions {
  cols?: number
  rows?: number
  /** Seed provider fake ke config global (default true) → boot TUI tanpa wizard. */
  seedProvider?: boolean
  /** Env tambahan / penimpaan untuk subprocess. */
  env?: Record<string, string | undefined>
}

const repoRoot = resolve(import.meta.dir, "..", "..")
const entry = join(repoRoot, "cli", "index.ts")

/**
 * Spawn TUI minicode di PTY nyata dengan workspace + HOME hermetic.
 * Provider fake (fake-provider.ts, server HTTP 127.0.0.1) di-seed ke config
 * global via MINICODE_HOME → CLI boot masuk TUI langsung (tanpa wizard) dan
 * turn berjalan tanpa jaringan nyata.
 */
export async function spawnTui(opts: SpawnTuiOptions = {}): Promise<TuiPtyHandle> {
  const spawn = await loadPty()
  if (!spawn) throw new Error("PTY tidak tersedia — panggil ptyAvailable() dulu")

  const cols = opts.cols ?? 100
  const rows = opts.rows ?? 30

  // Workspace hermetic (pola exit-codes.test.ts): cwd + home terpisah,
  // config global ditulis ke home hermetic → mesin host tak tersentuh.
  const dir = mkdtempSync(join(tmpdir(), "minicode-pty-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  const home = join(dir, "home")
  mkdirSync(join(home, ".minicode"), { recursive: true })

  let closeFake: (() => void) | null = null
  if (opts.seedProvider !== false) {
    const { startFakeProvider } = await import("./fake-provider.ts")
    const fake = startFakeProvider([{ kind: "text", text: "PTJ-TURN-OK" }])
    writeFileSync(
      join(home, ".minicode", "config.json"),
      JSON.stringify({
        providers: [
          { id: "fake", baseUrl: fake.baseUrl, apiKey: "test-key", models: ["gpt-4o-mini"] },
        ],
      }),
    )
    closeFake = () => fake.close()
  }

  const child = spawn(process.execPath, [entry], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: dir,
    // Env hermetic (lihat cleanEnvForChild): env host tak boleh menentukan
    // jalur kode anak — kredensial provider host juga tak diwarisi.
    env: cleanEnvForChild({
      NO_COLOR: "1",
      MINICODE_HOME: home,
      HOME: home,
      USERPROFILE: home,
      ...opts.env,
    }),
  })

  let acc = ""
  child.onData((d: string) => (acc += d))
  const exited = new Promise<{ exitCode: number; signal?: number }>((r) =>
    child.onExit((e) => r(e)),
  )
  // Jangan biarkan unhandled rejection bila test tak memanggil exit().
  exited.catch(() => {})

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    closeFake?.()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }

  return {
    raw: () => acc,
    send: (data: string) => child.write(data),
    resize: (c, w) => child.resize(c, w),
    async waitFor(pred, timeoutMs = 20000) {
      const start = Date.now()
      for (;;) {
        if (pred(acc)) return
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `waitFor timeout ${timeoutMs}ms — ekor stream: ${JSON.stringify(acc.slice(-400))}`,
          )
        }
        await new Promise((r) => setTimeout(r, 50))
      }
    },
    kill: (signal) => child.kill(signal),
    exit: () => exited,
    dispose,
    cwd: dir,
  }
}
