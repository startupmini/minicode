import { randomUUID } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import { createInterface } from "node:readline"
import { LIMITS } from "../../src/constants.ts"
import { scrubSecrets } from "../../src/policy/scrub.ts"
import { budgetStatus } from "../../src/policy/usage.ts"
import { presentationV2Enabled } from "../../src/presentation/store.ts"
import { clearSubmittedResult, getSubmittedResult } from "../../src/tools/submit_result.ts"
import { formatError } from "../../src/ui/assistant/simple.ts"
import type { UiPresentationEvent, UiPresentationSnapshot } from "../../src/ui/contract.ts"
import { formatUsd } from "../../src/ui/render/money.ts"
import { createCliSession } from "../setup.ts"

// minicode acp — server JSON-RPC via stdio untuk IDE (Fase 5, subset minimal).
//
// BUKAN klaim kompatibel ACP penuh (Zed/JetBrains): hanya tiga method yang
// didokumentasikan di bawah. Protokol: satu JSON per baris di stdin;
// respons/notifikasi satu JSON per baris di stdout. stdout WAJIB murni
// mesin — semua diagnostik manusia ke stderr (kontrak I2/I6).
//
//   -> {"id":1,"method":"initialize","params":{"client":"zed"}}
//   <- {"id":1,"result":{"server":"minicode-acp","capabilities":{...}}}
//   -> {"id":2,"method":"run","params":{"prompt":"...","cwd":"...","model":"...","maxSteps":50,"timeoutMs":600000,"budget":0.5,"mode":"auto"|"plan"}}
//   <- {"type":"text","delta":"..."} ... (notifikasi, tanpa id)
//   <- {"type":"tool","name":"read_file"} ... (notifikasi legacy, tanpa id)
//   <- {"type":"tool.started","toolCallId":"...","name":"read_file"} ...
//   <- {"type":"tool.completed|failed|denied|cancelled",...} ...
//   <- {"type":"approval.requested|settled",...} ...
//   <- {"type":"turn.started|completed|failed|cancelled",...} ...
//   <- {"id":2,"result":{"ok":true,"tokens":123,"steps":4,"turns":1,"text":"..."}}
//   -> {"id":3,"method":"cancel"}  (menggugurkan run yang berjalan)
//   -> {"id":4,"method":"shutdown"} (keluar 0 setelah run selesai/dibatalkan)
//
// Batasan v1 yang jujur: tiap `run` = sesi BARU (tanpa thread/resume);
// approval interaktif tak ada — kebijakan headless fail-closed berlaku
// (tool gated tanpa TTY = deny, sama seperti exec/CI); hanya SATU run dalam
// terbang (run kedua ditolak dengan error, bukan antre).

export interface AcpRequest {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

/** Parse satu baris stdin: JSON valid + method string, selain itu null
 * (baris rusak diabaikan + warn ke stderr agar stream mesin tetap bersih).
 * Murni + diekspor untuk test. */
export function parseAcpLine(line: string): AcpRequest | null {
  const t = line.trim()
  if (!t) return null
  try {
    const o = JSON.parse(t) as AcpRequest
    if (o && typeof o === "object" && typeof o.method === "string") return o
    return null
  } catch {
    return null
  }
}

export function acpOk(id: number | string | undefined, result: unknown): string {
  return JSON.stringify({ id: id ?? null, result })
}

export function acpErr(id: number | string | undefined, message: string): string {
  return JSON.stringify({ id: id ?? null, error: { message } })
}

export interface AcpRunParams {
  prompt: string
  cwd?: string
  model?: string
  maxSteps?: number
  timeoutMs?: number
  budget?: number
  mode?: "auto" | "plan"
}

/** Validasi params `run`: prompt wajib non-kosong; angka harus hingga-positif;
 * mode hanya auto/plan. Murni + diekspor untuk test. */
export function parseRunParams(
  params: unknown,
): { ok: true; value: AcpRunParams } | { ok: false; error: string } {
  if (!params || typeof params !== "object") return { ok: false, error: "params must be an object" }
  const p = params as Record<string, unknown>
  const prompt = typeof p.prompt === "string" ? p.prompt.trim() : ""
  if (!prompt) return { ok: false, error: "params.prompt is required" }
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined
  if (p.maxSteps !== undefined && num(p.maxSteps) === undefined)
    return { ok: false, error: "params.maxSteps must be a positive number" }
  if (p.timeoutMs !== undefined && num(p.timeoutMs) === undefined)
    return { ok: false, error: "params.timeoutMs must be a positive number" }
  if (
    p.budget !== undefined &&
    !(typeof p.budget === "number" && Number.isFinite(p.budget) && p.budget >= 0)
  )
    return { ok: false, error: "params.budget must be a non-negative number" }
  const mode =
    p.mode === undefined || p.mode === "auto" ? "auto" : p.mode === "plan" ? "plan" : null
  if (mode === null) return { ok: false, error: 'params.mode must be "auto" or "plan"' }
  const out: AcpRunParams = { prompt, mode }
  if (typeof p.cwd === "string" && p.cwd) out.cwd = p.cwd
  if (typeof p.model === "string" && p.model) out.model = p.model
  const ms = num(p.maxSteps)
  if (ms !== undefined) out.maxSteps = Math.floor(ms)
  const to = num(p.timeoutMs)
  if (to !== undefined) out.timeoutMs = Math.floor(to)
  if (typeof p.budget === "number") out.budget = p.budget
  return { ok: true, value: out }
}

function projectAcpLifecycle(
  event: UiPresentationEvent,
  snapshot?: UiPresentationSnapshot | null,
): Record<string, unknown> | null {
  const activity = event.toolCallId
    ? snapshot?.activities.find((item) => item.toolCallId === event.toolCallId)
    : undefined
  const base = {
    type: event.type,
    ...(event.seq !== undefined ? { eventSeq: event.seq } : {}),
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
  }
  if (event.type === "turn.started") return base
  if (event.type === "turn.completed")
    return { ...base, ...(event.summary ? { summary: event.summary } : {}) }
  if (event.type === "turn.failed")
    return {
      ...base,
      ...(event.error ? { error: event.error } : {}),
      ...(event.cause ? { cause: event.cause } : {}),
    }
  if (event.type === "turn.cancelled")
    return { ...base, ...(event.reason ? { reason: event.reason } : {}) }
  if (event.type === "approval.requested")
    return {
      ...base,
      ...(event.approvalId ? { approvalId: event.approvalId } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.name ? { name: event.name } : {}),
      ...(event.qualified ? { qualified: event.qualified } : {}),
      ...(event.target ? { target: event.target } : {}),
      ...(event.via ? { via: event.via } : {}),
    }
  if (event.type === "approval.settled")
    return {
      ...base,
      ...(event.approvalId ? { approvalId: event.approvalId } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.outcome ? { outcome: event.outcome } : {}),
    }
  if (event.type === "tool.started")
    return {
      ...base,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.name ? { name: event.name } : {}),
      ...(event.qualified ? { qualified: event.qualified } : {}),
      ...(event.target ? { target: event.target } : {}),
      status: "running",
      ...(event.tsStart !== undefined ? { tsStart: event.tsStart } : {}),
    }
  if (
    event.type === "tool.completed" ||
    event.type === "tool.failed" ||
    event.type === "tool.denied" ||
    event.type === "tool.cancelled"
  ) {
    return {
      ...base,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...((event.name ?? activity?.name) ? { name: event.name ?? activity?.name } : {}),
      ...((event.qualified ?? activity?.qualified)
        ? { qualified: event.qualified ?? activity?.qualified }
        : {}),
      ...((event.target ?? activity?.target) ? { target: event.target ?? activity?.target } : {}),
      ...((event.status ?? activity?.status) ? { status: event.status ?? activity?.status } : {}),
      ...((event.durationMs ?? activity?.durationMs)
        ? { durationMs: event.durationMs ?? activity?.durationMs }
        : {}),
      ...(event.message ? { message: event.message } : {}),
      ...(event.cause ? { cause: event.cause } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.type === "tool.failed" && activity?.error ? { error: activity.error } : {}),
      ...(activity?.denyReason ? { denyReason: activity.denyReason } : {}),
      ...(activity?.receipt ? { receipt: activity.receipt } : {}),
    }
  }
  return null
}

/** Satu run dalam terbang; cancel menggugurkan via signal. Box bermethod
 * (bukan `let` telanjang): assignment terjadi di closure runAcpSession
 * sehingga narrowing TS tak melihatnya — method selalu mulai dari tipe
 * deklarasi. Diekspor agar interaksi cancel-during-run teruji utuh. */
export function createFlight(): {
  start: (a: () => void) => void
  active: () => boolean
  stop: () => boolean
  clear: () => void
} {
  let aborter: (() => void) | null = null
  return {
    start(a: () => void): void {
      aborter = a
    },
    active(): boolean {
      return aborter !== null
    },
    /** true bila ada yang digugurkan. */
    stop(): boolean {
      const a = aborter
      aborter = null
      if (a) {
        a()
        return true
      }
      return false
    },
    clear(): void {
      aborter = null
    },
  }
}

/** Dependensi satu `run` — factory sesi di-inject (default produksi) agar
 * alur teruji tanpa provider. Diekspor untuk test. */
export interface AcpSessionDeps {
  write: (line: string) => void
  /** Dipanggil di finally (sukses/gagal/batal) — pemilik membersihkan flight. */
  onDone: () => void
  startFlight: (abort: () => void) => void
  shouldExit: () => boolean
  exit: (code: number) => void
  createSession?: typeof createCliSession
}

/** Satu `run`: validasi → sesi headless → stream notifikasi → hasil/error
 * tepat sekali. Diekspor untuk test. */
export async function runAcpSession(
  id: number | string | undefined,
  rawParams: unknown,
  deps: AcpSessionDeps,
): Promise<void> {
  const { write } = deps
  // Bersihkan state submit_result dari run sebelumnya — tanpa ini, run
  // ACP berturut-turut bisa membaca hasil run lama.
  clearSubmittedResult()
  const createSession = deps.createSession ?? createCliSession
  const parsed = parseRunParams(rawParams)
  if (!parsed.ok) {
    write(acpErr(id, parsed.error))
    return
  }
  const rp = parsed.value
  const sessionId = randomUUID().slice(0, 8)
  const ac = new AbortController()
  deps.startFlight(() => ac.abort())
  const t0 = Date.now()
  let text = ""
  try {
    const ctx = await createSession({
      cwd: rp.cwd ? resolvePath(rp.cwd) : undefined,
      sessionId,
      modelOverride: rp.model,
      prompt: rp.prompt,
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: rp.mode === "plan",
      allowlist: false,
      verify: false,
      budget: rp.budget,
      budgetStrict: false,
      ...(rp.maxSteps ? { maxSteps: rp.maxSteps } : {}),
      ...(rp.timeoutMs ? { timeoutMs: rp.timeoutMs } : {}),
    })
    const projection = ctx as unknown as {
      onPresentationEvent?: (handler: (event: UiPresentationEvent) => void) => () => void
      getPresentationSnapshot?: () => UiPresentationSnapshot
    }
    const lifecycle =
      presentationV2Enabled() && typeof projection.onPresentationEvent === "function"
    let unsubPresentation = (): void => {}
    if (lifecycle) {
      unsubPresentation = projection.onPresentationEvent!((event) => {
        const note = projectAcpLifecycle(event, projection.getPresentationSnapshot?.())
        if (note) write(scrubSecrets(JSON.stringify(note)))
      })
    }
    const unsub = ctx.session.events.on("*", (ev) => {
      try {
        const e = ev as { type?: string; text?: string; execution?: { call?: { name?: string } } }
        if (e.type === "provider:text" && typeof e.text === "string" && e.text) {
          // Cap akumulasi juga (bukan hanya slice akhir): run panjang bisa
          // menumpuk megabyte di memori sebelum result dirakit.
          if (text.length < LIMITS.MCP_OUTPUT_MAX_CHARS) text += e.text
          write(scrubSecrets(JSON.stringify({ type: "text", delta: e.text })))
        } else if (e.type === "execution:started" && !lifecycle) {
          const name = e.execution?.call?.name ?? "?"
          write(JSON.stringify({ type: "tool", name }))
        }
      } catch {}
    })
    try {
      await ctx.runPromptWithVerify(rp.prompt, ac.signal)
      const ue = ctx.usage.getSession(ctx.modelRef.current)
      const bStatus = budgetStatus(rp.budget, ue.cost, false, ue.totalTokens)
      if (bStatus !== "ok") {
        const msg =
          bStatus === "over" && ue.cost != null && rp.budget != null
            ? `[budget] ${formatUsd(ue.cost)} > ${formatUsd(rp.budget)} - over budget, stopping.`
            : `[budget] cost unknown (model without pricing) with ${ue.totalTokens} tokens spent - over budget, stopping.`
        write(acpErr(id, msg))
      } else {
        const submitted = getSubmittedResult()
        // submitted verbatim seperti exec --json (pipeline tak menebak
        // batas); teks dis-scrub + di-cap (bisa megabyte).
        write(
          acpOk(id, {
            ok: true,
            sessionId,
            model: ctx.modelRef.current,
            tokens: ue.totalTokens,
            inputTokens: ue.inputTokens,
            outputTokens: ue.outputTokens,
            ...(ue.cost !== undefined ? { cost: ue.cost } : {}),
            steps: ctx.session.state.stepCount,
            turns: ctx.session.state.turnCount,
            durationMs: Date.now() - t0,
            text: scrubSecrets(text.slice(0, LIMITS.MCP_OUTPUT_MAX_CHARS)),
            ...(submitted ? { submitted: submitted.result } : {}),
          }),
        )
      }
    } finally {
      unsub()
      unsubPresentation()
      await ctx.close()
    }
  } catch (e) {
    // Respons error tepat sekali per run: setup gagal (termasuk tanpa
    // provider — koneksi tetap hidup untuk request berikut), run gagal,
    // atau dibatalkan user. formatError menutupi NoProviderError juga.
    const msg = ac.signal.aborted ? "run cancelled" : formatError(e)
    write(acpErr(id, msg))
  } finally {
    deps.onDone()
    if (deps.shouldExit()) deps.exit(0)
  }
}

/** State loop yang dibutuhkan dispatch satu baris — stdio tetap di
 * handleAcp; yang di sini murni logika pesan. Diekspor untuk test. */
export interface AcpLoop {
  write: (line: string) => void
  runOne: (id: number | string | undefined, params: unknown) => Promise<void>
  flightActive: () => boolean
  cancelFlight: () => boolean
  isShuttingDown: () => boolean
  beginShutdown: () => void
  exit: (code: number) => void
  warnMalformed: () => void
}

/** Satu baris stdin → aksi. Diekspor agar loop teruji tanpa stdio. */
export async function dispatchAcpLine(line: string, loop: AcpLoop): Promise<void> {
  const req = parseAcpLine(line)
  if (!req) {
    if (line.trim()) loop.warnMalformed()
    return
  }
  if (req.method === "initialize") {
    loop.write(
      acpOk(req.id, {
        server: "minicode-acp",
        subset: "minicode-1",
        capabilities: { run: true, streamText: true, cancel: true, approval: "deny-headless" },
        note: "Minimal subset, not full ACP. Each run = a fresh session. Gated tools are denied without TTY.",
      }),
    )
  } else if (req.method === "run") {
    if (loop.flightActive()) {
      loop.write(acpErr(req.id, "a run is already in flight (v1: one at a time)"))
      return
    }
    if (loop.isShuttingDown()) {
      loop.write(acpErr(req.id, "server is shutting down"))
      return
    }
    // Dispatch ini await runOne (satu run per pemanggilan). Konkruensi
    // cancel-while-running datang dari pemanggil (handleAcp) yang TIDAK
    // await dispatch — prefik sinkron sampai startFlight tetap berurutan.
    await loop.runOne(req.id, req.params)
  } else if (req.method === "cancel") {
    loop.write(acpOk(req.id, { cancelled: loop.cancelFlight() }))
  } else if (req.method === "shutdown") {
    loop.beginShutdown()
    if (loop.flightActive()) {
      loop.cancelFlight()
      loop.write(acpOk(req.id, { shuttingDown: true }))
      // exit(0) terjadi di finally runAcpSession via shouldExit.
    } else {
      loop.write(acpOk(req.id, { shuttingDown: true }))
      loop.exit(0)
    }
  } else {
    loop.write(acpErr(req.id, `unknown method: ${req.method}`))
  }
}

export async function handleAcp(): Promise<void> {
  const write = (line: string): void => {
    // Klien bisa mati di tengah run (pipe tertutup): tulis yang gagal
    // jangan melempar dan membunuh server dengan observasi setengah jalan.
    try {
      process.stdout.write(`${line}\n`)
    } catch {}
  }
  const flight = createFlight()
  let shuttingDown = false
  // Run sedang berjalan (termasuk antrean setup): flight.active() saja TIDAK
  // cukup — stop() mengosongkan aborter sementara run masih await, sehingga
  // close mengira tak ada run dan exit prematur (respons run hilang).
  let busy = false
  const runOne = async (id: number | string | undefined, rawParams: unknown): Promise<void> => {
    busy = true
    try {
      await runAcpSession(id, rawParams, {
        write,
        onDone: () => flight.clear(),
        startFlight: (abort) => flight.start(abort),
        shouldExit: () => shuttingDown,
        exit: (code) => process.exit(code),
      })
    } finally {
      busy = false
    }
  }
  const loop: AcpLoop = {
    write,
    runOne,
    flightActive: () => flight.active(),
    cancelFlight: () => flight.stop(),
    isShuttingDown: () => shuttingDown,
    beginShutdown: () => {
      shuttingDown = true
    },
    exit: (code) => process.exit(code),
    warnMalformed: () => process.stderr.write("[acp] ignoring malformed line\n"),
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  // Event-driven, BUKAN for-await sekuensial: `cancel`/`shutdown` harus bisa
  // menyela run yang berjalan. for-await menahan baris berikutnya sampai run
  // selesai — cancel di stdin tak pernah terbaca (fitur mati di produksi).
  // Tiap baris didispatch tanpa await; prefik sinkron dispatch (parse →
  // runOne → startFlight) tetap berurutan per event, jadi run kedua melihat
  // flight aktif dan ditolak jujur.
  let inflight: Promise<void> | null = null
  rl.on("line", (line: string) => {
    const p = dispatchAcpLine(line, loop).catch((e: unknown) => {
      // runOne tak pernah melempar (semua jalur jadi respons error), tapi
      // jangan biarkan satu baris jahat membunuh server diam-diam.
      process.stderr.write(`[acp] dispatch failed: ${(e as Error)?.message ?? e}\n`)
    })
    inflight = p
    void p.finally(() => {
      if (inflight === p) inflight = null
    })
  })
  // Klien menutup stdin (atau EOF): run yang masih berjalan digugurkan
  // lalu keluar lewat finally sesi (shouldExit); tanpa run langsung bersih.
  rl.on("close", () => {
    if (busy) {
      shuttingDown = true
      flight.stop()
    } else {
      process.exit(0)
    }
  })
  // Server hidup selama proses hidup: JANGAN pernah return — kembalinya
  // handleAcp membuat dispatch selesai dan index.ts lanjut membuat sesi
  // one-shot "acp" (NoProviderError + exit 1) yang berlomba dengan stdin.
  // Semua jalan keluar lewat process.exit di atas/di dispatch.
  await new Promise<never>(() => {})
}
