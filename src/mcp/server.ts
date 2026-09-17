import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import type { ExecutorDeps, Tool, ToolContext } from "#minicore"
import { scrubSecrets } from "../policy/scrub.ts"
import {
  appendMutationIntent,
  appendMutationTerminal,
  finalizeJournal,
  hashArgs,
  isMutationTool,
  verifyPaths,
} from "../session/journal.ts"
import { allTools } from "../tools/index.ts"
import { todoSession } from "../tools/todo.ts"
import { capMcpText } from "./client.ts"

export interface McpServeOptions {
  allowAll?: boolean
  allTools?: boolean
  root?: string
}

// tool internal minicode — tidak relevan/berbahaya jika dipanggil dari agent eksternal
// write_memory/forget_memory juga di-exclude biar AI luar tidak polusi vector.db global
const INTERNAL_TOOLS = new Set([
  "delegate_task",
  "mcp_call",
  "mcp_list",
  "write_memory",
  "forget_memory",
])

const SERVER_INFO = { name: "minicode", version: "0.1.0" }
const PROTOCOL_VERSION = "2026-07-28"

interface JsonRpcMsg {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

function send(msg: JsonRpcMsg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function reply(id: string | number, result: unknown) {
  send({ jsonrpc: "2.0", id, result })
}

function replyError(id: string | number | null | undefined, code: number, message: string) {
  if (id === undefined) return // notification → no response
  send({ jsonrpc: "2.0", id, error: { code, message } }) // null id valid utk parse error
}

const CODE_METHOD_NOT_FOUND = -32601
const CODE_INVALID_PARAMS = -32602
const CODE_INTERNAL = -32603

export function selectTools(opts: McpServeOptions): Tool[] {
  const base = opts.allTools ? allTools : allTools.filter((t) => !INTERNAL_TOOLS.has(t.name))
  const seen = new Set<string>()
  return base.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)))
}

async function invokeTool(
  tool: Tool,
  args: Record<string, unknown>,
  opts: McpServeOptions,
  signal: AbortSignal,
  journal: { session: string; root: string },
  /** Kunci bukti dedup `req:<id>:<argsHash>` (dibuat pemanggil dari argumen
   * mentah) — ditulis apa adanya ke outcome.note + flag dedup. */
  noteKey?: string,
): Promise<{ content: { type: string; text: string }[]; isError: boolean }> {
  const root = journal.root
  // validateArgs KERNEL (bukan validasi ad-hoc): argumen invalid ditolak
  // SEBELUM permission/execute — sama seperti jalur REPL. Tanpa ini argumen
  // mentah mencapai execute (temuan audit #05: crash/perilaku indefinisi).
  const { validateArgs } = await import("#minicore")
  const parsed = validateArgs(tool.parameters, args ?? {})
  if (!parsed.ok) {
    return {
      content: [{ type: "text", text: `[invalid arguments] ${tool.name}: ${parsed.message}` }],
      isError: true,
    }
  }
  const validArgs = parsed.value as Record<string, unknown>
  // permission check — sandbox tetap aktif walau dipanggil dari luar.
  // SELALU jalan (bahkan allowAll): gerbang jail universal + bash-guard
  // hidup di DALAM check(), sebelum dispatch mode. Melewatkan check() sama
  // sekali (kode lama saat allowAll) berarti TANPA jail — temuan P0 audit #05.
  // allowAll hanya memilih MODE, bukan menonaktifkan pemeriksaan.
  {
    const { createPermissionHandler } = await import("../policy/permission.ts")
    const perms = createPermissionHandler({
      mode: opts.allowAll ? "allow-all" : "auto",
      root: opts.root,
    })
    const toolCall = { id: randomUUID(), name: tool.name, args: validArgs }
    const { createEventBus, createToolRegistry } = await import("#minicore")
    const deps: ExecutorDeps = {
      registry: createToolRegistry([]),
      permissions: perms,
      events: createEventBus(),
      signal,
      state: { history: [], turnCount: 0, stepCount: 0 },
      maxResultTokens: 4096,
    }
    const decision = await perms.check(toolCall, deps)
    if (decision !== "allow") {
      return {
        content: [
          { type: "text", text: `[denied] ${tool.name} blocked by minicode permission policy` },
        ],
        isError: true,
      }
    }
  }

  // Journal mutation (kelas mutasi + unknown fail-closed, F-14): intent →
  // terminal. Server mode tak punya turn/session kernel, jadi sesi jurnal
  // tetap "mcp-server".
  const mutating = isMutationTool(tool.name)
  let intent: { id: string; seq: number } | null = null
  if (mutating) {
    intent = await appendMutationIntent({
      session: journal.session,
      tool: tool.name,
      cwd: root,
      paths: verifyPaths(tool.name, validArgs, root),
      argsHash: hashArgs(validArgs),
      // Kunci idempotency sejak intent (audit #08): crash di tengah eksekusi
      // (tanpa terminal) tetap terdeteksi sebagai unknown, bukan fresh.
      ...(noteKey ? { note: noteKey } : {}),
    })
  }
  const ctx: ToolContext = {
    signal,
    state: { history: [], turnCount: 0, stepCount: 0 },
    emit: () => {},
    // P0 audit #05: root eksekusi HARUS sama dengan root jail permission.
    // Sebelumnya ctx tanpa cwd → tool jatuh ke process.cwd() sementara jail
    // memakai opts.root — divergensi jail-vs-eksekusi bila --cwd dipakai.
    cwd: root,
  }
  try {
    const out = await tool.execute(validArgs, ctx)
    const text =
      typeof out === "string" ? out : out instanceof Uint8Array ? "(binary)" : JSON.stringify(out)
    if (intent) {
      await appendMutationTerminal(
        journal.session,
        root,
        intent.id,
        intent.seq,
        tool.name,
        "committed",
        {
          note: noteKey,
        },
        undefined,
        { dedup: true },
      )
    }
    // capMcpText scrub + cap + tandai dalam satu langkah (tanpa double-scrub).
    return {
      content: [{ type: "text", text: capMcpText(text) }],
      isError: false,
    }
  } catch (e) {
    if (intent) {
      await appendMutationTerminal(
        journal.session,
        root,
        intent.id,
        intent.seq,
        tool.name,
        "failed",
        {
          note: noteKey,
        },
        undefined,
        { dedup: true },
      )
    }
    throw e
  }
}

export async function serveMcp(opts: McpServeOptions = {}): Promise<void> {
  const tools = selectTools(opts)
  const byName = new Map(tools.map((t) => [t.name, t]))
  const shutdown = new AbortController()
  // Root tunggal: jail permission, cwd eksekusi, dan jurnal memakai nilai
  // yang sama (audit #05: divergensi ketiganya = jail bypass).
  const root = opts.root ?? process.cwd()
  const JOURNAL_SESSION = "mcp-server"

  // todoSession global dipakai tool todo_*; di proses serve khusus, skop ke
  // sesi server agar tak mencemari/membaca state sesi lain (P2 isolation).
  // Default "default" bila serve dipakai sebagai library tanpa setup root.
  const prevTodo = todoSession.id
  const prevTodoCwd = todoSession.cwd
  todoSession.id = "mcp-server"
  todoSession.cwd = root

  // Idempotency request (audit #05 P0, diperkuat #08 P0): retry client
  // (atau crash-restart) tak boleh mengeksekusi ulang mutasi non-idempoten
  // secara buta.
  // - In-flight (promise map): duplikat konkuren menunggu hasil yang SAMA
  //   (satu eksekusi). Dihapus setelah reply.
  // - Completed (cache FIFO 100): replay hasil persis tanpa eksekusi ulang.
  // - Restart/crash (cache hilang): bukti jurnal durable → error eksplisit
  //   (BUKAN sukses palsu, BUKAN eksekusi ulang buta). Hasil tak disimpan di
  //   jurnal (aturan no-content), jadi retry pasca-restart harus pakai id
  //   BARU setelah verifikasi manual.
  // - Kunci bukti = id + hash argumen (audit #08): id sama + argumen SAMA =
  //   retry operasi sama (tahan); id sama + argumen BEDA = operasi baru
  //   (client reconnect me-reset seq — BOLEH jalan). Tanpa hash, salah satu
  //   sisi pasti salah: tahan-semua merusak reconnect sah, jalan-semua
  //   menduplikasi retry. Terminal bukti ditandai dedup agar selamat dari
  //   sweep finalize (tanpa ini buktinya rutin terhapus dan retry
  //   pasca-restart dieksekusi ulang buta — reproducer: note hilang
  //   setelah finalize+sweep).
  const inflight = new Map<
    string,
    Promise<{ content: { type: string; text: string }[]; isError: boolean }>
  >()
  const completedCache = new Map<
    string,
    { content: { type: string; text: string }[]; isError: boolean }
  >()
  const COMPLETED_CACHE_MAX = 100
  const rememberCompleted = (
    key: string,
    result: { content: { type: string; text: string }[]; isError: boolean },
  ): void => {
    completedCache.set(key, result)
    if (completedCache.size > COMPLETED_CACHE_MAX) {
      const oldest = completedCache.keys().next()
      if (!oldest.done) completedCache.delete(oldest.value)
    }
  }
  // Bukti durable mutasi terdahulu untuk (id, argumen) ini: "committed" |
  // "failed" | "pending" (ambigu) | null (tak ada bukti). Tanpa bukti =
  // fresh request. Cocok PERSIS pada note `req:<id>:<argsHash>`; note legacy
  // `req:<id>` (pra-hash) dicocok id-mentah secara konservatif; note ber-hash
  // lain = operasi beda (reconnect sah) → lewati, jangan vonis.
  const journalEvidence = async (
    idKey: string,
    noteKey: string,
  ): Promise<"committed" | "failed" | "pending" | null> => {
    try {
      const { loadJournal } = await import("../session/journal.ts")
      const { records } = await loadJournal(JOURNAL_SESSION, root)
      let seen: "committed" | "failed" | "pending" | null = null
      for (const r of records) {
        const n = r.outcome?.note
        if (typeof n !== "string") continue
        if (n !== noteKey && n !== idKey) continue
        if (r.state === "committed" || r.state === "failed") return r.state
        seen = "pending"
      }
      return seen
    } catch {
      return null
    }
  }
  // Abort per-request (notifications/cancelled): dibedakan dari shutdown
  // global. Tanpa ini request panjang tak bisa dibatalkan individual.
  const reqControllers = new Map<string, AbortController>()
  // Batas konkurensi: tanpa batas, client lokal nakal bisa menumpuk request
  // tak terbatas (tiap handle jalan bebas). 32 longgar untuk pemakaian sah.
  const INFLIGHT_MAX = 32
  const linkedSignal = (reqCtrl: AbortController): AbortSignal =>
    AbortSignal.any([shutdown.signal, reqCtrl.signal])

  process.stderr.write(
    `[mcp-server] ready — ${tools.length} tools (${opts.allTools ? "all" : "curated"}${opts.allowAll ? ", allow-all" : ""})\n`,
  )

  const rl = createInterface({ input: process.stdin })
  rl.on("line", (line) => {
    if (!line.trim()) return
    let msg: JsonRpcMsg
    try {
      msg = JSON.parse(line)
    } catch {
      // per JSON-RPC spec: parse error wajib dibalas dengan id:null
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
      return
    }

    void handle(msg).catch((e) => {
      if (msg.id !== undefined && msg.id !== null)
        replyError(msg.id, CODE_INTERNAL, String((e as Error).message ?? e))
    })
  })

  async function handle(msg: JsonRpcMsg): Promise<void> {
    const method = msg.method ?? ""
    // per JSON-RPC: pesan tanpa id = notification → JANGAN dibalas apa pun.
    // Pengecualian: notifications/cancelled MEMBUTUHKAN params.requestId
    // untuk abort per-request — tangani di sini sebelum early-return.
    if (method === "notifications/cancelled") {
      const rid = (msg.params as { requestId?: unknown } | undefined)?.requestId
      if (rid !== undefined && rid !== null) {
        reqControllers.get(`req:${JSON.stringify(rid)}`)?.abort()
      }
      return
    }
    if (msg.id === undefined || msg.id === null) {
      if (!method.startsWith("notifications/") && method !== "initialized") {
        process.stderr.write(`[mcp-server] ignored id-less non-notification: ${method}\n`)
      }
      return
    }
    switch (method) {
      case "server/discover":
        reply(msg.id!, {
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: SERVER_INFO,
        })
        return

      case "initialize":
        reply(msg.id!, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: SERVER_INFO,
        })
        return

      case "initialized":
      case "notifications/initialized":
        // Notifikasi murni (tanpa id) sudah kembali di pintu handle; yang
        // sampai sini membawa id → balas kosong agar client tak menggantung.
        reply(msg.id!, {})
        return

      case "ping":
        reply(msg.id!, {})
        return

      case "tools/list":
        reply(msg.id!, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
        })
        return

      case "resources/list":
        reply(msg.id!, { resources: [] })
        return

      case "resources/read": {
        replyError(msg.id, CODE_INVALID_PARAMS, "no resources exposed")
        return
      }

      case "prompts/list":
        reply(msg.id!, { prompts: [] })
        return

      case "prompts/get": {
        replyError(msg.id, CODE_INVALID_PARAMS, "no prompts exposed")
        return
      }

      case "tools/call": {
        const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
        const name = params.name ?? ""
        const tool = byName.get(name)
        if (!tool) {
          replyError(msg.id, CODE_INVALID_PARAMS, `unknown tool: ${name}`)
          return
        }
        // Kunci idempotency = id JSON-RPC apa adanya (string/number beda).
        const idKey = `req:${JSON.stringify(msg.id)}`
        // Kunci bukti durable = id + hash argumen MENTAH (pre-validasi):
        // retry operasi sama cocok persis; id sama + argumen beda (client
        // reconnect me-reset seq) = operasi baru. Hash mentah (bukan hasil
        // validasi) agar raceCheck dan invokeTool memakai nilai identik.
        const noteKey = `${idKey}:${hashArgs(params.arguments ?? {})}`
        // Cek sinkron dulu (fast path); cek ULANG setelah await di bawah
        // karena dua handler konkuren bisa sama-sama melewati titik ini
        // sebelum salah satunya mendaftarkan inflight (TOCTOU → eksekusi
        // ganda — persis yang dicegah; lihat re-check sesudah evidence).
        const raceCheck = async (): Promise<
          | {
              kind: "reply"
              result: { content: { type: string; text: string }[]; isError: boolean }
            }
          | { kind: "replyError"; code: number; message: string }
          | { kind: "proceed" }
        > => {
          const ongoing = inflight.get(idKey)
          if (ongoing) {
            try {
              return { kind: "reply", result: await ongoing }
            } catch (e) {
              return {
                kind: "reply",
                result: {
                  content: [
                    { type: "text", text: `[error] ${scrubSecrets((e as Error).message ?? e)}` },
                  ],
                  isError: true,
                },
              }
            }
          }
          // 2. Hasil selesai (proses ini): replay persis, tanpa eksekusi ulang.
          const cached = completedCache.get(idKey)
          if (cached) return { kind: "reply", result: cached }
          // 3. Bukti durable (restart/crash di tengah): jangan eksekusi ulang
          // buta dan jangan klaim sukses palsu — error eksplisit per status.
          const evidence = await journalEvidence(idKey, noteKey)
          if (evidence === "committed") {
            return {
              kind: "replyError",
              code: CODE_INTERNAL,
              message: `duplicate request id: already executed successfully — result not retained, verify state before retrying with a new id`,
            }
          }
          if (evidence === "failed") {
            return {
              kind: "replyError",
              code: CODE_INTERNAL,
              message: `duplicate request id: previous attempt failed — inspect state, then retry with a new id`,
            }
          }
          if (evidence === "pending") {
            return {
              kind: "replyError",
              code: CODE_INTERNAL,
              message: `duplicate request id: previous attempt status unknown (interrupted) — verify state before retrying with a new id`,
            }
          }
          // Re-check pasca-await: pemenang balapan sudah mendaftar sementara
          // kita menunggu evidence. Tanpa ini dua duplikat konkuren lolos
          // berdua (reproducer: dua tools/call id sama back-to-back).
          const ongoing2 = inflight.get(idKey)
          if (ongoing2) {
            try {
              return { kind: "reply", result: await ongoing2 }
            } catch (e) {
              return {
                kind: "reply",
                result: {
                  content: [
                    { type: "text", text: `[error] ${scrubSecrets((e as Error).message ?? e)}` },
                  ],
                  isError: true,
                },
              }
            }
          }
          return { kind: "proceed" }
        }
        const gated = await raceCheck()
        if (gated.kind === "reply") {
          reply(msg.id!, gated.result)
          return
        }
        if (gated.kind === "replyError") {
          replyError(msg.id, gated.code, gated.message)
          return
        }
        if (inflight.size >= INFLIGHT_MAX) {
          replyError(msg.id, CODE_INTERNAL, "server busy: too many in-flight requests")
          return
        }
        const reqCtrl = new AbortController()
        const link = () => reqCtrl.abort()
        shutdown.signal.addEventListener("abort", link, { once: true })
        reqControllers.set(idKey, reqCtrl)
        const run = (async () => {
          try {
            return await invokeTool(
              tool,
              params.arguments ?? {},
              opts,
              linkedSignal(reqCtrl),
              { session: JOURNAL_SESSION, root },
              noteKey,
            )
          } finally {
            shutdown.signal.removeEventListener("abort", link)
            reqControllers.delete(idKey)
          }
        })()
        inflight.set(idKey, run)
        try {
          const result = await run
          rememberCompleted(idKey, result)
          reply(msg.id!, result)
        } catch (e) {
          reply(msg.id!, {
            content: [{ type: "text", text: `[error] ${scrubSecrets((e as Error).message ?? e)}` }],
            isError: true,
          })
        } finally {
          inflight.delete(idKey)
          // Finalize jurnal per panggilan (tak ada turn/persist di mode ini):
          // sweep hanya membuang yang finalized — best-effort, tak blokir reply.
          void finalizeJournal(JOURNAL_SESSION, root).catch(() => {})
        }
        return
      }

      default:
        if (method.startsWith("notifications/")) return
        replyError(msg.id, CODE_METHOD_NOT_FOUND, `method not found: ${method}`)
    }
  }

  // stdin close → shutdown bersih
  await new Promise<void>((resolve) => {
    rl.on("close", resolve)
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => {
        shutdown.abort()
        resolve()
      })
    }
  })
  rl.close()
  todoSession.id = prevTodo
  todoSession.cwd = prevTodoCwd
}
