import { Buffer } from "node:buffer"
import { type ChildProcess, spawn } from "node:child_process"
import { extname, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import { LIMITS } from "../constants.ts"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"
import type {
  ManagedChild,
  ManagedChildObservation,
  ProcessSupervision,
} from "../runtime/process-supervision.ts"

export interface LspServerEntry {
  ext: string // ".ts"
  command: string
  args: string[]
  env?: Record<string, string>
}

/**
 * [P13.2] Supervisor proses runtime (DI).
 *
 * Server LSP adalah anak proses milik runtime ini: ia lahir dari perintah
 * pengguna, bisa mati sendiri, dan TIDAK boleh lepas begitu saja. Registrar ini
 * menyerahkan kepemilikan ke SATU jalur ownership proses (runtime), sehingga
 * "tidak ada child yang terlepas" bisa dibuktikan, bukan diklaim.
 *
 * Tanpa pemasang (mode runtime off / tool dipakai tanpa runtime), server LSP
 * tetap jalan seperti sebelumnya — jalur legacy utuh, tanpa klaim supervisi.
 */
let processSupervision: ProcessSupervision | null = null

/** Pasang/lepas jalur ownership proses (composition root). */
export function setLspProcessSupervisor(supervisor: ProcessSupervision | null): void {
  processSupervision = supervisor
}

const LANG_ID: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".json": "json",
  ".css": "css",
  ".html": "html",
  ".md": "markdown",
}

export function languageIdFor(file: string): string {
  return LANG_ID[extname(file).toLowerCase()] ?? "plaintext"
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

class LspConnection {
  private proc: ChildProcess | null = null
  private buf: Buffer | null = null
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private seq = 0
  private started = false
  // guard anti double-spawn saat beberapa tool call paralel
  private starting?: Promise<void>
  // abort HANYA saat stop() — bukan timeout, agar server tidak mati sendiri
  private killSignal = new AbortController()
  private opened = new Map<string, { version: number; text: string; langId: string }>()
  readonly diagnostics = new Map<string, Record<string, unknown>[]>()
  private diagnosticWaiters = new Map<string, Set<() => void>>()
  /** [P13.2] true saat stop() yang kita minta → keluarannya BUKAN "tak terduga". */
  private stopping = false
  /** [P13.2] root workspace — dipakai lagi saat restart. */
  private rootPath = ""

  constructor(public entry: LspServerEntry) {}

  /** Id anak proses (stabil per ekstensi) — kunci recovery di jalur ownership. */
  private get childId(): string {
    return `lsp:${this.entry.ext}`
  }

  start(rootPath: string): Promise<void> {
    if (this.started) return Promise.resolve()
    this.rootPath = rootPath
    this.starting ??= this.doStart(rootPath)
    return this.starting
  }

  private async doStart(rootPath: string): Promise<void> {
    this.rootPath = rootPath
    this.stopping = false
    this.proc = spawn(this.entry.command, this.entry.args, {
      stdio: ["pipe", "pipe", "pipe"],
      // env kredensial di-strip; env eksplisit config server menang setelahnya
      env: sanitizeSpawnEnv(process.env, this.entry.env),
      signal: this.killSignal.signal,
    })
    this.proc.on("error", (err) => this.failAll(err))
    // [P13.2] Tulis ke server yang sudah mati menghasilkan EPIPE. Itu kondisi
    // NORMAL saat shutdown/supervisi (kita menutup lebih dulu) — dibiarkan
    // jadi event tanpa penanganan, ia bisa menjatuhkan proses CLI. Proses mati
    // dilaporkan lewat handler `exit` ✅, jadi di sini cukup diserap.
    this.proc.stdin?.on("error", () => {})
    this.proc.stdout?.on("error", () => {})
    this.proc.on("exit", (code) => {
      const wasStarted = this.started
      this.started = false
      this.starting = undefined
      if (wasStarted) this.failAll(new Error(`LSP server ${this.entry.ext} exited (${code})`))
      // [P13.2] Keluar saat kita TIDAK minta = anak hilang: serahkan ke jalur
      // proses (bounded restart / eskalasi jujur). Keluar karena stop() kita
      // sendiri bukan kegagalan.
      if (!this.stopping) {
        const supervisor = processSupervision
        if (supervisor) {
          void supervisor.notifyExit(this.childId, {
            status: code === 0 ? "exited" : "failed",
            exitCode: code,
          })
        }
      }
    })
    this.proc.stderr?.on("data", (d: Buffer) =>
      process.stderr.write(`[lsp${this.entry.ext}] ${d.toString().trim().slice(0, 500)}\n`),
    )
    this.proc.stdout!.on("data", (chunk: Buffer) => this.handleData(chunk))

    // [P13.2] Serahkan kepemilikan anak ke jalur ownership proses runtime.
    const supervisor = processSupervision
    if (supervisor) supervisor.register(this.managedChild())

    // initialize handshake
    await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileURL(resolvePath(rootPath)).href,
        capabilities: {
          workspace: { symbol: {} },
          textDocument: {
            publishDiagnostics: { relatedInformation: false },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: {},
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: false },
          },
        },
      },
      LIMITS.LSP_INIT_TIMEOUT_MS,
    )
    this.notify("initialized", {})
    this.started = true
  }

  /**
   * [P13.2] Port anak yang dikelola runtime.
   *
   * Restart server LSP TIDAK mengulang kerja pengguna — server hanya menjawab
   * permintaan, jadi restart otomatis aman (dibatasi policy M9). Untuk
   *_background command_ yang bisa mengulang efek, restartSafety-nya "unsafe"
   * dan runtime akan MENOLAK me-restart-nya.
   */
  private managedChild(): ManagedChild {
    return {
      id: this.childId,
      kind: "lsp-server",
      restartSafety: "safe",
      observe: (): ManagedChildObservation => {
        if (this.started) return { status: "running" }
        if (this.proc) return { status: "exited", exitCode: null }
        return { status: "unknown", detail: "not started" }
      },
      stop: async (): Promise<void> => {
        await this.stop()
      },
      restart: async (): Promise<void> => {
        // Diagnostics lama milik server lama → dibuang SEBELUM restart. Kalau
        // dibuang setelah, diagnostics yang baru saja dipublish server baru ikut
        // hilang (dan hasil waitForDiagnostics jadi kosong tanpa sebab).
        this.diagnostics.clear()
        await this.start(this.rootPath)
        // Server baru tak tahu dokumen yang tadi dibuka → buka ulang dengan isi
        // terakhir yang klien kirim (bukan isi basi dari disk).
        this.reopenDocuments()
      },
    }
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<unknown> {
    const id = ++this.seq
    const msg = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8")
    const stdin = this.proc?.stdin
    if (!stdin) throw new Error(`LSP ${method}: server stdin unavailable`)
    stdin.write(`Content-Length: ${msg.length}\r\n\r\n`)
    stdin.write(msg)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    if (!this.proc?.stdin) throw new Error(`LSP server ${this.entry.ext} not running`)
    const msg = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }), "utf8")
    this.proc.stdin.write(`Content-Length: ${msg.length}\r\n\r\n`)
    this.proc.stdin.write(msg)
  }

  openDocument(absPath: string, text: string): string {
    const uri = pathToFileURL(absPath).href
    const langId = languageIdFor(absPath)
    const known = this.opened.get(uri)
    if (!known) {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: langId, version: 1, text },
      })
      this.opened.set(uri, { version: 1, text, langId })
    } else {
      const v = known.version + 1
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: v },
        contentChanges: [{ text }],
      })
      this.opened.set(uri, { version: v, text, langId })
    }
    return uri
  }

  /**
   * [P13.2] Buka ulang dokumen yang masih terbuka pada server yang BARU.
   *
   * Server yang di-restart tidak tahu dokumen apa pun: isinya hilang bersama
   * prosesnya. Kalau dibiarkan, state klien (dokumen masih terbuka) dan state
   * server jadi berbeda — server jadi buta, dan hasil simbol/diagnostics
   * kosong tanpa alasan.
   *
   * Isi yang dikirim adalah TEKS TERAKHIR yang klien kirim (bukan isi file
   * dari disk): isi disk bisa sudah basi, dan mengirim basi berarti server
   * bekerja pada dokumen yang berbeda dari yang dilihat pengguna.
   *
   * Versi dokumen diteruskan apa adanya, jadi increments seterusnya tetap
   * naik dan server tak pernah melihat versi yang mundur.
   */
  private reopenDocuments(): void {
    for (const [uri, doc] of this.opened) {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: doc.langId, version: doc.version, text: doc.text },
      })
    }
  }

  async waitForDiagnostics(uri: string, timeoutMs = 5_000): Promise<Record<string, unknown>[]> {
    if (this.diagnostics.has(uri)) {
      await sleep(100) // settle window for follow-up pushes
      return this.diagnostics.get(uri) ?? []
    }
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const onDiag = () => {
        clearTimeout(timer)
        cleanup()
        setTimeout(resolve, 50)
      }
      const cleanup = () => {
        const s = this.diagnosticWaiters.get(uri)
        if (s) {
          s.delete(onDiag)
          if (s.size === 0) this.diagnosticWaiters.delete(uri)
        }
      }
      timer = setTimeout(() => {
        cleanup()
        resolve()
      }, timeoutMs)

      let s = this.diagnosticWaiters.get(uri)
      if (!s) {
        s = new Set()
        this.diagnosticWaiters.set(uri, s)
      }
      s.add(onDiag)
    })
    return this.diagnostics.get(uri) ?? []
  }

  async stop(): Promise<void> {
    if (!this.proc) return
    // [P13.2] Tandai stop yang kita minta → keluarannya tak dilaporkan sebagai
    // [P13.2] Tandai stop yang kita minta: keluarannya tak dilaporkan sebagai
    this.stopping = true
    try {
      await this.request("shutdown", {}, 2_000)
    } catch {}
    try {
      this.notify("exit")
    } catch {}
    // send didClose for all opened docs
    for (const uri of this.opened.keys()) {
      try {
        this.notify("textDocument/didClose", { textDocument: { uri } })
      } catch {}
    }
    this.opened.clear()
    this.diagnostics.clear()
    try {
      this.proc.stdin?.end()
    } catch {}
    this.killSignal.abort()
    await new Promise<void>((r) => {
      const p = this.proc!
      const t = setTimeout(() => {
        try {
          p.kill("SIGKILL")
        } catch {}
        r()
      }, 2_000)
      p.once("exit", () => {
        clearTimeout(t)
        r()
      })
    })
    this.proc = null
    this.started = false
    this.starting = undefined
    this.buf = null
  }

  private handleData(chunk: Buffer) {
    this.buf = this.buf ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      if (!this.buf) break
      const sep = this.buf.indexOf("\r\n\r\n")
      if (sep === -1) break
      const header = this.buf.slice(0, sep).toString("utf8")
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) {
        this.buf = this.buf.slice(sep + 4)
        continue
      }
      const len = Number(m[1])
      const total = sep + 4 + len
      if (this.buf.length < total) break
      const body = this.buf.slice(sep + 4, total).toString("utf8")
      this.buf = this.buf.slice(total)
      try {
        this.dispatch(JSON.parse(body))
      } catch {}
    }
  }

  private dispatch(msg: Record<string, unknown>) {
    // response to our request
    if (msg.id != null && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(msg.id as number)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(msg.id as number)
        if (msg.error)
          p.reject(new Error(String((msg.error as Record<string, unknown>).message ?? "LSP error")))
        else p.resolve(msg.result)
      }
      return
    }
    // server → client notifications
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as
        | { uri?: string; diagnostics?: Record<string, unknown>[] }
        | undefined
      if (params?.uri) {
        this.diagnostics.set(params.uri, params.diagnostics ?? [])
        const waiters = this.diagnosticWaiters.get(params.uri)
        if (waiters) {
          for (const cb of waiters) cb()
        }
      }
    }
  }

  private failAll(err: Error) {
    for (const s of this.diagnosticWaiters.values()) {
      for (const cb of s) cb()
    }
    this.diagnosticWaiters.clear()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}

// registry keyed by lowercase extension
const activeServers = new Map<string, LspConnection>()

export function configureServers(entries: LspServerEntry[]): void {
  for (const e of entries) {
    const key = e.ext.toLowerCase()
    if (!activeServers.has(key)) activeServers.set(key, new LspConnection(e))
  }
}

// Seam uji: kosongkan registry (isolasi antar test file — repomap mengambil
// jalur LSP begitu ADA server terdaftar, jadi stub uji tak boleh bocor).
export function clearLspServers(): void {
  activeServers.clear()
}

export function getConfiguredExts(): string[] {
  return [...activeServers.keys()]
}

async function getConnection(file: string, cwd?: string): Promise<LspConnection> {
  const ext = extname(file).toLowerCase()
  const conn = activeServers.get(ext)
  if (!conn) throw new Error(`no LSP configured for '${ext}' — add via minicode config lsp add`)
  // Root server = workspace sesi, BUKAN process.cwd(): tanpa ini sesi --cwd
  // beda direktori menjalankan server di direktori yang salah (simbol dan
  // diagnostics menunjuk workspace yang keliru). Default process.cwd()
  // mempertahankan pemanggil lama (verifier tanpa konteks cwd).
  await conn.start(cwd ?? process.cwd())
  return conn
}

export interface LspPositionResult {
  position: { line: number; character: number }
  text: string
}

export function findSymbolPosition(
  text: string,
  symbol: string,
): LspPositionResult["position"] | null {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // prefer word-boundary match to avoid hitting comments/import substrings; fallback to plain indexOf
  const re = new RegExp(`\\b${escaped}\\b`)
  const m = re.exec(text)
  const idx = m?.index ?? text.indexOf(symbol)
  if (idx === -1) return null
  const before = text.slice(0, idx).split("\n")
  return { line: before.length - 1, character: before[before.length - 1]!.length }
}

export async function lspDiagnostics(
  absPath: string,
  text: string,
  timeoutMs = 5_000,
  cwd?: string,
): Promise<{ uri: string; items: Record<string, unknown>[] }> {
  const conn = await getConnection(absPath, cwd)
  const uri = conn.openDocument(absPath, text)
  const items = await conn.waitForDiagnostics(uri, timeoutMs)
  return { uri, items }
}

export async function lspCall(
  absPath: string,
  text: string,
  method: string,
  params: Record<string, unknown>,
  cwd?: string,
  waitDiagsMs = 3_000,
): Promise<unknown> {
  const conn = await getConnection(absPath, cwd)
  const uri = conn.openDocument(absPath, text)
  await conn.waitForDiagnostics(uri, waitDiagsMs).catch(() => [])
  return conn.request(method, params)
}

export async function closeAllLsp(): Promise<void> {
  for (const conn of activeServers.values()) {
    try {
      await conn.stop()
    } catch {}
  }
}

export interface WorkspaceSymbol {
  name: string
  kind: number
  location: { uri: string; range?: { start?: { line?: number } } }
  containerName?: string
}

// Query workspace symbols across all configured LSP servers (best-effort).
// Returns merged, deduped symbols. Empty query "" should return top symbols
// on servers that support it; we cap and timeout per server.
export async function workspaceSymbols(
  query: string,
  timeoutMs = 4000,
  cwd?: string,
): Promise<WorkspaceSymbol[]> {
  const conns = [...activeServers.values()]
  if (conns.length === 0) return []
  const results = await Promise.all(
    conns.map(async (conn) => {
      try {
        await conn.start(cwd ?? process.cwd())
        const res = (await conn.request("workspace/symbol", { query }, timeoutMs)) as
          | WorkspaceSymbol[]
          | null
        return Array.isArray(res) ? res : []
      } catch {
        return [] as WorkspaceSymbol[]
      }
    }),
  )
  const seen = new Set<string>()
  const merged: WorkspaceSymbol[] = []
  for (const list of results) {
    for (const s of list) {
      const key = `${s.location.uri}::${s.name}::${s.kind}`
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(s)
      }
    }
  }
  return merged
}
