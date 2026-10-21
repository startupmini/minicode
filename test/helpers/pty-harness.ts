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

interface PtyExit {
  exitCode: number
  signal?: number
}

/** Bentuk minimum proses PTY yang dipakai harness (tanpa types lib). */
interface PtyTerm {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(cb: (d: string) => void): void
  onExit(cb: (e: PtyExit) => void): void
}
type PtySpawn = (file: string, args: string[], opts: Record<string, unknown>) => PtyTerm

function spawnWithBunTerminal(
  file: string,
  args: string[],
  opts: Record<string, unknown>,
): PtyTerm {
  let dataHandler: ((data: string) => void) | undefined
  let exitHandler: ((event: PtyExit) => void) | undefined
  let pendingData = ""
  let exitResult: PtyExit | undefined
  let exitNotified = false
  const notifyExit = () => {
    if (!exitResult || !exitHandler || exitNotified) return
    exitNotified = true
    exitHandler(exitResult)
  }
  const proc = Bun.spawn([file, ...args], {
    ...(typeof opts.cwd === "string" ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env as Record<string, string | undefined> } : {}),
    terminal: {
      ...(typeof opts.name === "string" ? { name: opts.name } : {}),
      cols: typeof opts.cols === "number" ? opts.cols : 80,
      rows: typeof opts.rows === "number" ? opts.rows : 24,
      data(_terminal, data) {
        const text = new TextDecoder().decode(data)
        if (dataHandler) dataHandler(text)
        else pendingData += text
      },
    },
    onExit(_proc, exitCode, signalCode) {
      exitResult = { exitCode: exitCode ?? 1, signal: signalCode ?? undefined }
      notifyExit()
    },
  })
  const terminal = proc.terminal
  if (!terminal) throw new Error("Bun.spawn tidak membuat terminal")
  return {
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: (signal) => {
      if (signal) proc.kill(signal as NodeJS.Signals)
      else proc.kill()
    },
    onData(cb) {
      dataHandler = cb
      if (pendingData) {
        const data = pendingData
        pendingData = ""
        cb(data)
      }
    },
    onExit(cb) {
      exitHandler = cb
      notifyExit()
    },
  }
}

let ptySpawn: PtySpawn | null | undefined
async function loadPty(): Promise<PtySpawn | null> {
  if (ptySpawn !== undefined) return ptySpawn
  if (
    process.platform !== "win32" &&
    typeof Bun !== "undefined" &&
    typeof Bun.Terminal === "function"
  ) {
    ptySpawn = spawnWithBunTerminal
    return ptySpawn
  }
  try {
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
      process.platform === "win32" ? process.execPath : "/bin/sh",
      process.platform === "win32"
        ? [
            "--eval",
            "setTimeout(() => { console.log('MINICODE-PTY-PROBE'); process.exit(0) }, 150)",
          ]
        : ["-c", "printf 'MINICODE-PTY-PROBE\\n'"],
      { name: "xterm-256color", cols: 80, rows: 24, env: cleanEnvForChild() },
    )
    let out = ""
    child.onData((d: string) => (out += d))
    const got = await new Promise<boolean>((resolveGot) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolveGot(out.includes("MINICODE-PTY-PROBE"))
      }
      child.onExit(() => setTimeout(finish, 100))
      setTimeout(finish, 6000)
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

/**
 * Hasil self-check: apakah EXIT CODE anak bisa diverifikasi di platform ini?
 *
 * [KENAPA PERLU] Di Windows ConPTY, node-pty melaporkan keluar anak yang
 * diinterupsi secara interaktif TANPA kode (`{exitCode: undefined}`), padahal
 * anak yang keluar biasa (`process.exit(0)`) dilaporkan `0` dengan benar.
 * "undefined" berarti "harness tak bisa melihat status keluar" — BUKAN
 * "berhasil" dan BUKAN "gagal". Test yang menganggapnya sukses = hijau
 * palsu; test yang menganggapnya gagal = merah palsu.
 *
 * Probe memakaijalur NYATA (CLI TUI via spawnTui + Ctrl+D), bukan probe
 * generik, karena yang diperiksa justru perilaku jalur interaktif itu.
 * Hasil di-cache per proses test.
 */
export interface PtyExitAvailability {
  ok: boolean
  reason: string
}
let exitAvailability: PtyExitAvailability | undefined

export async function ptyExitCodeVerifiable(): Promise<PtyExitAvailability> {
  if (exitAvailability) return exitAvailability
  const spawn = await loadPty()
  if (!spawn) {
    exitAvailability = { ok: false, reason: "PTY tidak tersedia" }
    return exitAvailability
  }
  let tui: TuiPtyHandle | undefined
  try {
    tui = await spawnTui({ cols: 80, rows: 24 })
    await tui.waitFor((raw) => raw.includes("00.00.00"), 20_000)
    tui.send("\x04")
    await tui.waitFor((raw) => raw.includes("\x1b[?1049l"), 10_000)
    const e = await tui.exit()
    exitAvailability =
      typeof e.exitCode === "number"
        ? { ok: true, reason: "ok" }
        : {
            ok: false,
            reason:
              "platform tak melaporkan exit code anak yang keluar via PTY interaktif " +
              "(ConPTY/node-pty) — verifikasi exit code DILEWATI, bukan dianggap sukses",
          }
  } catch (e) {
    exitAvailability = { ok: false, reason: `probe exit code gagal: ${(e as Error).message}` }
  } finally {
    try {
      tui?.dispose()
    } catch {}
  }
  return exitAvailability
}

// ── Capability: apakah transport PTY mengantar byte mouse SGR? ──
//
// [KENAPA PERLU] Jalur SGR (drag-selection → OSC52) punya dua bagian yang
// bisa gagal: (1) TRANSPORT tak mengantarkan byte mouse, (2) APLIKASI tak
// memprosesnya. Keduanya berakhir sama dari luar (test timeout tanpa OSC52),
// padahal akar masalahnya beda. Test lama memakai koordinat mouse hardcoded
// yang mendarat di luar area transcript → TUI tak pernah membuat selection →
// OSC52 tak pernah terbit; itu BUKAN kegagalan transport.
//
// Probe di sini menjawab HANYA (1): apakah byte mouse SGR yang ditulis
// benar-benar sampai ke stdin proses anak. Observasinya bukan "write() tidak
// error", tapi "anak membalas byte yang ia terima" — anak melaporkan byte
// yang ia terima (base64) supaya bisa dibandingkan dengan yang ditulis.
//
// [JEBakan yang pernah menyesatkan] Anak WAJIB membaca dalam RAW mode. Di
// mode canonical (line-buffered) byte tanpa newline tertahan di line
// discipline dan tak pernah sampai ke aplikasi: probe lama menyimpulkan
// "ConPTY membuang byte SGR" padahal itu artefak buffering, bukan transport.
// Karena itu anak mengonfirmasi raw mode, dan tanpa itu probe dinyatakan
// TIDAK KONKLUSIF (bukan "SGR tak didukung").
//
// [KENAPA TRAILER] Byte SGR ditulis bersama marker teks dalam satu write.
// Kalau marker tiba tapi byte SGR tidak, itu bukti langsung bahwa transport
// membuang SGR (bukan write-nya yang hilang seluruhnya). Kalau keduanya tak
// tiba, jalur input-nya sendiri tak hidup → TIDAK KONKLUSIF.

/** Sekuens mouse SGR yang ditulis probe (press di kolom 1, baris 1). */
const SGR_PROBE_SEQUENCE = "\x1b[<0;1;1M"
/** Marker delivery: menyertai write SGR dalam satu write. */
const SGR_PROBE_TRAILER = "MINICODE-PTY-SGR-TRAILER"
/** Marker kontrol: write terpisah, membuktikan jalur input hidup. */
const SGR_PROBE_CONTROL = "MINICODE-PTY-SGR-CONTROL"
const SGR_PROBE_READY = "MINICODE-PTY-SGR-READY"
const SGR_PROBE_GOT = "MINICODE-PTY-SGR-GOT:"

// Skrip anak probe: raw mode → aktifkan mouse reporting (cermin TUI
// MiniCode) → lapor siap → lapor setiap byte yang benar-benar diterima.
const SGR_PROBE_CHILD = `
let acc = Buffer.alloc(0)
let raw = 0
try {
  if (typeof process.stdin.setRawMode === "function") { process.stdin.setRawMode(true); raw = 1 }
} catch (e) {}
process.stdout.write("\\x1b[?1002h\\x1b[?1006h")
process.stdout.write("${SGR_PROBE_READY} raw=" + raw + "\\n")
process.stdin.on("data", (d) => {
  acc = Buffer.concat([acc, Buffer.isBuffer(d) ? d : Buffer.from(d)])
  process.stdout.write("${SGR_PROBE_GOT}" + acc.toString("base64") + "\\n")
})
setTimeout(() => process.exit(0), 20000)
`

/**
 * Parse baris READY probe dari output kumulatif.
 *
 * [KENAPA BUKAN includes] Baris READY bisa tiba sebagai beberapa chunk
 * (ConPTY menulis per write, dan baris bisa terpecah di tengah). Pencocokan
 * `out.includes("…READY")` bisa cocok pada baris yang BELUM lengkap →
 * sufiks "raw=1" belum terbaca → probe salah menyimpulkan "raw mode tak
 * aktif" (inconclusive palsu). Karena itu baris protokol hanya dianggap sah
 * setelah newline-nya terlihat.
 *
 * @returns true = raw mode aktif · false = anak siap tapi raw mode MATI ·
 *          null = baris READY belum lengkap/tak ada → JANGAN disimpulkan.
 */
export function parseSgrReadyRawMode(out: string): boolean | null {
  let from = 0
  for (;;) {
    const idx = out.indexOf(SGR_PROBE_READY, from)
    if (idx < 0) return null
    const nl = out.indexOf("\n", idx)
    // Baris belum lengkap → jangan simpulkan apa pun.
    if (nl < 0) return null
    const line = out.slice(idx, nl).replace(/\r$/, "")
    const m = /raw=([01])/.exec(line)
    if (m) return m[1] === "1"
    from = idx + SGR_PROBE_READY.length
  }
}

/**
 * Keputusan gate untuk test mouse SGR end-to-end.
 *
 * - PTY tak tersedia → SKIP beralasan (tak ada transport untuk diuji).
 * - Probe "supported" → RUN (assertion tetap utuh, tanpa diubah).
 * - Probe "unsupported" (terbukti transport tak mengantar SGR) → SKIP
 *   beralasan: inilah satu-satunya dasar sah untuk skip.
 * - Probe "inconclusive" → tak boleh disamarkan jadi "unsupported"; di luar
 *   CI → SKIP dengan alasan "tak konklusif", di CI Linux → GAGAL.
 * - CI Linux mewajibkan verdict "supported": kalau tidak, jalur SGR end-to-end
 *   wajib gagal dengan diagnosa (bukan skip senyap) — audit runtime tak boleh
 *   diam-diam berubah jadi no-op.
 */
export type SgrGateDecision = "run" | "skip" | "fail"

export function decideSgrGate(input: {
  ptyAvailable: boolean
  verdict: PtySgrVerdict
  reason: string
  ciLinux: boolean
}): { decision: SgrGateDecision; reason: string } {
  if (!input.ptyAvailable) return { decision: "skip", reason: input.reason }
  if (input.verdict === "supported") return { decision: "run", reason: input.reason }
  if (input.ciLinux) {
    return {
      decision: "fail",
      reason:
        `CI Linux mewajibkan jalur mouse SGR end-to-end terverifikasi, tapi probe capability ` +
        `memberi verdict="${input.verdict}" — ${input.reason}`,
    }
  }
  // Di luar CI: verdict "unsupported" (terbukti) atau "inconclusive" (tak
  // dapat disimpulkan) → skip beralasan, TIDAK pernah "hijau palsu".
  return { decision: "skip", reason: input.reason }
}

/** Verdict capability: "supported" | "unsupported" | "inconclusive". */
export type PtySgrVerdict = "supported" | "unsupported" | "inconclusive"

export interface PtySgrAvailability {
  /** true HANYA bila verdict === "supported" (SGR terbukti sampai ke anak). */
  ok: boolean
  /**
   * "supported" = byte SGR terbukti sampai ke stdin anak.
   * "unsupported" = terbukti TIDAK sampai (transport lain mengantar byte,
   *   byte SGR hilang) — inilah satu-satunya dasar yang sah untuk skip.
   * "inconclusive" = tak dapat disimpulkan (probe gagal/tak konklusif) —
   *   BUKAN bukti SGR tak didukung.
   */
  verdict: PtySgrVerdict
  /** Alasan yang bisa dibaca manusia; dipakai sebagai alasan skip. */
  reason: string
  /** Observasi mentah probe (byte yang benar-benar diterima anak). */
  observation?: SgrProbeObservation
}

/** Observasi mentah dari probe SGR (dipisah dari klasifikasi agar bisa diuji). */
export interface SgrProbeObservation {
  /** Anak berhasil masuk raw mode (tanpa ini observasi tak bisa dipercaya). */
  rawMode: boolean
  /** Byte yang BENAR-BENAR diterima anak; null = anak tak pernah melapor. */
  received: string | null
  /** Sekuens SGR yang ditulis probe. */
  sgrSequence: string
  /** Marker delivery yang menyertai write SGR. */
  trailer: string
  /** Marker kontrol (write terpisah, sebelum write SGR). */
  controlMarker: string
}

/**
 * Klasifikasi hasil probe SGR — MURNI (tanpa IO), supaya kedua
 * kemungkinan (SGR diterima / SGR tak diterima) bisa diuji tanpa
 * bergantung pada platform. Tak ada asumsi platform di sini.
 */
export function classifySgrProbe(o: SgrProbeObservation): PtySgrAvailability {
  const received = o.received ?? ""
  const sgrDelivered = received.includes(o.sgrSequence)
  const trailerDelivered = received.includes(o.trailer)
  const controlDelivered = received.includes(o.controlMarker)
  const base = { observation: o }
  if (!o.rawMode) {
    return {
      ...base,
      ok: false,
      verdict: "inconclusive",
      reason:
        "anak probe tak bisa masuk raw mode (input line-buffered) — kemakmuran transport " +
        "tak bisa dinilai; ini BUKAN bukti SGR tak didukung",
    }
  }
  if (sgrDelivered) {
    return { ...base, ok: true, verdict: "supported", reason: "byte mouse SGR sampai ke stdin anak" }
  }
  if (trailerDelivered) {
    return {
      ...base,
      ok: false,
      verdict: "unsupported",
      reason:
        "transport mengantar byte lain pada write yang sama, tapi byte mouse SGR hilang — " +
        "SGR tidak diantarkan transport ini",
    }
  }
  if (controlDelivered) {
    return {
      ...base,
      ok: false,
      verdict: "inconclusive",
      reason:
        "kontrol sampai (jalur input hidup) tapi write kedua tak pernah sampai — " +
        "tak dapat disimpulkan (BUKAN bukti SGR tak didukung)",
    }
  }
  return {
    ...base,
    ok: false,
    verdict: "inconclusive",
    reason:
      "jalur input PTY tak mengantar byte sama sekali — probe tidak konklusif " +
      "(BUKAN bukti SGR tak didukung)",
  }
}

let sgrAvailability: PtySgrAvailability | undefined

/**
 * Self-check: apakah transport PTY yang tersedia MENGANTARKAN byte mouse
 * SGR ke proses anak? Hasil di-cache per proses test.
 *
 * Yang diukur HANYA kemampuan transport. Kemakmuran aplikasi (parser SGR →
 * selection → OSC52) dibuktikan test lain; probe ini tak pernah menyentuh
 * assertion aplikasi, hanya memberi alasan skip yang jujur.
 */
export async function ptySgrMouseDelivered(): Promise<PtySgrAvailability> {
  if (sgrAvailability) return sgrAvailability
  const spawn = await loadPty()
  if (!spawn) {
    sgrAvailability = {
      ok: false,
      verdict: "inconclusive",
      reason: "PTY tidak tersedia (@lydell/node-pty tak terpasang) — probe tidak konklusif",
    }
    return sgrAvailability
  }
  let child: PtyTerm | undefined
  try {
    child = spawn(process.execPath, ["--eval", SGR_PROBE_CHILD], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      env: cleanEnvForChild(),
    })
    let out = ""
    child.onData((d: string) => (out += d))

    const waitFor = async (pred: () => boolean, timeoutMs: number): Promise<boolean> => {
      const start = Date.now()
      for (;;) {
        if (pred()) return true
        if (Date.now() - start > timeoutMs) return false
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    // Baris GOT terakhir yang LENGKAP (ada newline-nya) — baris yang masih
    // streaming tak boleh didekode (base64 terpotong → byte palsu).
    const lastGot = (): string | null => {
      let from = 0
      let result: string | null = null
      for (;;) {
        const idx = out.indexOf(SGR_PROBE_GOT, from)
        if (idx < 0) break
        const rest = out.slice(idx + SGR_PROBE_GOT.length)
        const nl = rest.indexOf("\n")
        if (nl >= 0) {
          const line = rest.slice(0, nl).replace(/\r$/, "")
          try {
            result = Buffer.from(line, "base64").toString("utf8")
          } catch {
            /* baris tak valid → abaikan */
          }
        }
        from = idx + SGR_PROBE_GOT.length
      }
      return result
    }

    // Readiness: hanya baris READY yang LENGKAP (newline-nya terlihat) yang
    // sah — baris terpecah antar-chunk tak boleh disimpulkan apa pun.
    const ready = await waitFor(() => parseSgrReadyRawMode(out) !== null, 10_000)
    if (!ready) {
      sgrAvailability = {
        ok: false,
        verdict: "inconclusive",
        reason: "anak probe tak pernah siap (baris READY tak lengkap) — probe tidak konklusif",
      }
      return sgrAvailability
    }
    const rawMode = parseSgrReadyRawMode(out) === true

    // Write 1 — kontrol: bukti jalur input hidup.
    child.write(`${SGR_PROBE_CONTROL}\r`)
    await waitFor(() => (lastGot() ?? "").includes(SGR_PROBE_CONTROL), 8000)

    // Write 2 — SGR + marker delivery dalam satu write.
    child.write(`${SGR_PROBE_SEQUENCE}${SGR_PROBE_TRAILER}\r`)
    await waitFor(() => (lastGot() ?? "").includes(SGR_PROBE_TRAILER), 8000)

    sgrAvailability = classifySgrProbe({
      rawMode,
      received: lastGot(),
      sgrSequence: SGR_PROBE_SEQUENCE,
      trailer: SGR_PROBE_TRAILER,
      controlMarker: SGR_PROBE_CONTROL,
    })
    return sgrAvailability
  } catch (e) {
    sgrAvailability = {
      ok: false,
      verdict: "inconclusive",
      reason: `probe SGR gagal: ${(e as Error).message} — probe tidak konklusif`,
    }
    return sgrAvailability
  } finally {
    // Anak dibunuh di semua jalur (sukses/gagal/timeout) → tak ada proses
    // nyasar yang ikut menggantung suite.
    try {
      child?.kill()
    } catch {}
  }
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
  /**
   * Resolve saat proses anak mati.
   *
   * `exitCode` MAYBE `undefined`: di Windows ConPTY, node-pty sometimes reports
   * the exit of an interactively-quit child WITHOUT a code (`{exitCode:
   * undefined}`), while a plain `process.exit(0)` child reports `0` fine. So
   * `undefined` means "the harness could not observe the exit status" — NOT
   * "success" and NOT "failure". Callers must treat it as unverifiable
   * (see `ptyExitCodeVerifiable`).
   */
  exit(): Promise<{ exitCode: number | undefined; signal?: number }>
  /** Matikan anak (bila masih hidup) + hapus workspace hermetic. */
  dispose(): void
  /** Direktori kerja hermetic sesi ini. */
  readonly cwd: string
}

export interface SpawnTuiOptions {
  cols?: number
  rows?: number
  /** Balasan fake pertama; defaultnya teks turn biasa. */
  reply?: import("./fake-provider.ts").FakeReply
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
    const fake = startFakeProvider([opts.reply ?? { kind: "text", text: "PTJ-TURN-OK" }])
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
  const exited = new Promise<{ exitCode: number | undefined; signal?: number }>((r) =>
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
