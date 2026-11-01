import { Database } from "bun:sqlite"
import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { LIMITS } from "../constants.ts"
import { resolveDbPath } from "../lib/db-path.ts"
import { isPrivateHostWithDns } from "../lib/net.ts"
import { scrubSecrets } from "../policy/scrub.ts"

const dbPath = (cwd?: string) => resolveDbPath("vector.db", cwd)

const initializedPaths = new Set<string>()

// [Fase 7 / Live #3] Circuit-breaker embedding per-endpoint.
// Gateway tanpa endpoint `/embeddings` memicu timeout 3,5 dtk (per-attempt)
// pada SETIAP operasi memori sebelum jatuh ke fallback FTS5/keyword. Ini
// membengkakkan wall-clock setiap write_memory/read_memory. Circuit-breaker
// menandai endpoint yang GAGAL (timeout/404/405/501/koneksi ditolak) dengan
// TTL cooldown 5 menit, sehingga panggilan berikutnya LANGSUNG lompat ke
// fallback keyword dalam <5ms tanpa menunggu timeout jaringan lagi.
const EMBEDDING_CIRCUIT_BREAKER_TTL_MS = 5 * 60 * 1000

export interface EmbeddingCircuitState {
  readonly brokenAt: number
  readonly reason: string
}

/** endpoint (normalized baseUrl) → state circuit-breaker. */
const embeddingCircuitBrokenByEndpoint = new Map<string, EmbeddingCircuitState>()

/** Normalisasi kunci endpoint circuit-breaker (bentuk baseUrl + model). */
function embeddingCircuitKey(baseUrl: string, model?: string): string {
  return `${baseUrl.replace(/\/+$/, "").toLowerCase()}|${model ?? "default"}`
}

/** Cek apakah endpoint dalam cooldown circuit-breaker (belum kedaluwarsa). */
function embeddingCircuitBroken(baseUrl: string, model?: string): boolean {
  const st = embeddingCircuitBrokenByEndpoint.get(embeddingCircuitKey(baseUrl, model))
  if (!st) return false
  if (Date.now() - st.brokenAt < EMBEDDING_CIRCUIT_BREAKER_TTL_MS) return true
  embeddingCircuitBrokenByEndpoint.delete(embeddingCircuitKey(baseUrl, model))
  return false
}

/** Tandai endpoint sebagai broken (masuk cooldown). */
function markEmbeddingCircuitBroken(
  baseUrl: string,
  model: string | undefined,
  reason: string,
): void {
  embeddingCircuitBrokenByEndpoint.set(embeddingCircuitKey(baseUrl, model), {
    brokenAt: Date.now(),
    reason,
  })
}

/** Seam uji: reset circuit-breaker (dan seluruh state memori global) agar test
 *  hermetik bisa memulai dari keadaan bersih. */
export function resetEmbeddingCircuitBreaker(): void {
  embeddingCircuitBrokenByEndpoint.clear()
}

/**
 * [Fase 7 / seam uji] Trip circuit-breaker EKSPLISIT untuk pengujian hermetik.
 * Production code tidak memanggil ini — hanya dipakai oleh `test/p19-*.test.ts`
 * untuk memverifikasi jalur fast-fallback (<20ms, 0 request jaringan) tanpa
 * bergantung pada kegagalan DNS/jaringan nyata yang tidak deterministik.
 */
export function tripEmbeddingCircuitForTest(
  baseUrl: string,
  model: string | undefined,
  reason: string,
): void {
  markEmbeddingCircuitBroken(baseUrl, model, reason)
}

// ── [Fase 9 / 9.2 MEM-04 / U7] Fault-Injection seam untuk split-brain memori ──
//
// Menyediakan hook uji yang mensimulasikan crash TEPAT di antara dua write
// penyimpanan memori (vector.db dan MEMORY.md). `stage` menandakan titik crash:
//   - "after_vector_before_file" : vector.db sudah ketulis, MEMORY.md belum
//   - "after_file_before_vector" : MEMORY.md sudah ketulis, vector.db belum
// Dengan begitu `reconcileMemoryStores` dapat diuji memulihkan kedua arah
// split-brain (vector-only → dihapus; file-only → ditambah ke vector) tanpa
// duplikasi dan tanpa kehilangan entri valid.
//
// Production code tidak memanggil hook ini kecuali via writeMemoryTool: saat
// injector di-set, writeMemoryTool memanggilnya di titik boundary lalu
// meneruskan exception (simulasi crash). Default = null (tak ada fault).

export type MemoryWriteFaultStage = "after_vector_before_file" | "after_file_before_vector"

let memoryWriteFaultInjector: ((stage: MemoryWriteFaultStage) => void) | null = null

/** Seam uji: pasang/lepas injector fault untuk batas write memori. */
export function setMemoryWriteFaultInjectorForTest(
  fn: ((stage: MemoryWriteFaultStage) => void) | null,
): void {
  memoryWriteFaultInjector = fn
}

/** Internal: panggil injector (bila ada) pada stage tertentu. */
export function invokeMemoryWriteFaultForTest(stage: MemoryWriteFaultStage): void {
  if (memoryWriteFaultInjector) memoryWriteFaultInjector(stage)
}

function open(cwd?: string): Database {
  return openAt(dbPath(cwd))
}

/**
 * DB global eksplisit untuk scope="global" (audit 2026-09-16 B9).
 * Sebelumnya scope global jatuh ke open(cwd) = resolveDbPath yang memilih
 * LOKAL bila .minicode ada — env MINICODE_MEMORY_SCOPE=global yang
 * didokumentasikan tak pernah dihormati. Global yang belum pernah ada
 * dilewati (fallback resolusi normal) agar baca tak membuat DB kosong.
 */
function openGlobalDb(fallbackCwd?: string): Database {
  try {
    const { join } = require("node:path") as typeof import("node:path")
    const { existsSync } = require("node:fs") as typeof import("node:fs")
    const { homeDir } = require("../lib/db-path.ts") as typeof import("../lib/db-path.ts")
    const g = join(homeDir(), ".minicode", "vector.db")
    if (existsSync(g)) return openAt(g)
  } catch {}
  return open(fallbackCwd)
}

function openAt(p: string): Database {
  const db = new Database(p)
  // [Audit #3 RL-2] Langkah pasca-konstruksi (busy_timeout + WAL + DDL/migrasi)
  // dibungkus agar kegagalan IOERR/CORRUPT menutup handle, bukan bocor. busy_timeout
  // diatur SEBELUM journal_mode (audit #09 P1 §27).
  try {
    // busy_timeout DULU seperti sessions.db (audit #09 P1 §27): pola yang sama
    // (journal_mode sebelum timeout aktif) gagal SQLITE_BUSY saat dua proses
    // membuka bersamaan.
    try {
      db.exec(`PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}`)
    } catch {}
    if (!initializedPaths.has(p)) {
      // journal_size_limit + wal_autocheckpoint: WAL tidak tumbuh tak terbatas
      db.exec(
        `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=${LIMITS.SQLITE_WAL_SIZE_LIMIT_BYTES}; PRAGMA wal_autocheckpoint=${LIMITS.SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
      )
      initializedPaths.add(p)
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS memory(id TEXT PRIMARY KEY, text TEXT, embedding BLOB, created_at INTEGER, category TEXT DEFAULT 'fact', tags TEXT, model TEXT, dim INTEGER, parent TEXT, access_count INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_text ON memory(text);
  `)
    // P1.3: kolom model/dim untuk deteksi embedding-mismatch (best-effort migrasi)
    // P2.2: kolom parent untuk chunk entri panjang (chunk berbagi parent id)
    // P13 S2: kategori terstruktur untuk retrieval presisi
    // P13 P1: access_count untuk bukti manfaat (berapa kali row ikut jadi hit)
    // MEM-01 / Fase 5A: provenance tracking (session/turn/source) untuk revokasi selektif
    try {
      const cols = db.prepare(`PRAGMA table_info(memory)`).all() as { name: string }[]
      if (!cols.some((c) => c.name === "model")) db.exec(`ALTER TABLE memory ADD COLUMN model TEXT`)
      if (!cols.some((c) => c.name === "dim")) db.exec(`ALTER TABLE memory ADD COLUMN dim INTEGER`)
      if (!cols.some((c) => c.name === "parent"))
        db.exec(`ALTER TABLE memory ADD COLUMN parent TEXT`)
      if (!cols.some((c) => c.name === "category"))
        db.exec(`ALTER TABLE memory ADD COLUMN category TEXT DEFAULT 'fact'`)
      if (!cols.some((c) => c.name === "tags")) db.exec(`ALTER TABLE memory ADD COLUMN tags TEXT`)
      if (!cols.some((c) => c.name === "access_count"))
        db.exec(`ALTER TABLE memory ADD COLUMN access_count INTEGER DEFAULT 0`)
      // MEM-01: provenance columns (idempoten — skip bila sudah ada)
      if (!cols.some((c) => c.name === "session_id"))
        db.exec(`ALTER TABLE memory ADD COLUMN session_id TEXT`)
      if (!cols.some((c) => c.name === "turn_id"))
        db.exec(`ALTER TABLE memory ADD COLUMN turn_id TEXT`)
      if (!cols.some((c) => c.name === "source_kind"))
        db.exec(`ALTER TABLE memory ADD COLUMN source_kind TEXT`)
      if (!cols.some((c) => c.name === "source_ref"))
        db.exec(`ALTER TABLE memory ADD COLUMN source_ref TEXT`)
      // [Fase 6A / ACE-03] Gate pelajaran kandidat: hanya pelajaran yang sudah
      // lolos verifikasi yang boleh muncul di retrieval default. Baris legacy
      // (NULL) diperlakukan sebagai `validated` agar perilaku lama tak berubah.
      if (!cols.some((c) => c.name === "validation_status"))
        db.exec(`ALTER TABLE memory ADD COLUMN validation_status TEXT DEFAULT 'validated'`)
      // F8.1: Supersession tracking untuk memory replacement. Idempoten — skip bila
      // sudah ada (migration dari versi sebelumnya). `superseded_by IS NOT NULL` menandai
      // baris yang telah digantikan oleh fakta/keputusan baru; recall default mengabaikan
      // baris superseded untuk prevent staleness.
      if (!cols.some((c) => c.name === "supersedes"))
        db.exec(`ALTER TABLE memory ADD COLUMN supersedes TEXT NULL`)
      if (!cols.some((c) => c.name === "superseded_by"))
        db.exec(`ALTER TABLE memory ADD COLUMN superseded_by TEXT NULL`)
      // F8.1: Index untuk query performan (filter row yang tidak superseded)
      try {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_memory_not_superseded ON memory(rowid) WHERE superseded_by IS NULL OR superseded_by = '';`,
        )
      } catch {}
      try {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_memory_supersedes ON memory(supersedes) WHERE supersedes IS NOT NULL AND supersedes != '';`,
        )
      } catch {}
    } catch {}
    // P1.1: expression index + FTS5 untuk keyword pre-filter (10-50× vs instr scan)
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_text_lower ON memory(lower(text));`)
    } catch {}
    try {
      db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, content='memory', content_rowid='rowid', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text); END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.rowid, old.text); END;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.rowid, old.text); INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text); END;
    `)
      // populate FTS untuk DB lama yang sudah ada sebelum trigger
      const cnt =
        (db.prepare(`SELECT count(*) as c FROM memory_fts`).get() as { c: number } | null)?.c ?? 0
      const total =
        (db.prepare(`SELECT count(*) as c FROM memory`).get() as { c: number } | null)?.c ?? 0
      if (cnt === 0 && total > 0) {
        db.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`)
      }
    } catch {}
    return db
  } catch (err) {
    try {
      db.close()
    } catch {}
    throw err
  }
}

function toBlob(vec: number[]): Buffer {
  // copy to avoid byteOffset alignment issues
  const f32 = new Float32Array(vec)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}
function fromBlob(blob: Buffer | Uint8Array): number[] {
  const buf = blob instanceof Uint8Array ? Buffer.from(blob) : (blob as Buffer)
  // ensure 4-byte alignment: copy if misaligned
  if (buf.byteOffset % 4 !== 0) {
    const copy = Buffer.alloc(buf.byteLength)
    buf.copy(copy)
    return Array.from(new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4))
  }
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0,
    na = 0,
    nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9)
}

function keywordScore(query: string, text: string): number {
  const q = query.toLowerCase().split(/\W+/).filter(Boolean)
  const t = text.toLowerCase()
  if (q.length === 0) return 0
  let hits = 0
  for (const w of q) if (t.includes(w)) hits++
  return hits / q.length
}

async function fetchEmbeddingsOnce(
  url: string,
  headers: Record<string, string>,
  body: string,
  parentSignal?: AbortSignal,
  attemptMs: number = LIMITS.EMBEDDING_TIMEOUT_MS,
): Promise<{ data?: { embedding: number[] }[] } | null> {
  // P1.4: redirect manual max 2 hop, tiap hop dicek SSRF strict (fail-close,
  // tanpa cache agar DNS rebinding tidak lolos via cache basi).
  let current = url
  for (let hop = 0; hop <= 2; hop++) {
    try {
      const hostname = new URL(current).hostname
      if (await isPrivateHostWithDns(hostname, { strict: true, timeoutMs: 1000, noCache: true })) {
        process.stderr.write(`[vector] private host rejected: ${hostname}\n`)
        return null
      }
    } catch {
      return null
    }
    let res: Response
    try {
      // Budget total (parent) di-race dengan timeout per-attempt: attempt
      // lambat tetap dibunuh 3,5 dtk, TAPI seluruh matriks 3×2 tak boleh
      // melewati budget total — tanpa ini setup RAG macet ~21 dtk.
      const perAttempt = AbortSignal.timeout(attemptMs)
      const attemptSignal = parentSignal ? AbortSignal.any([parentSignal, perAttempt]) : perAttempt
      res = await fetch(current, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: attemptSignal,
      })
    } catch (e) {
      // fallback keyword-only tetap berjalan, tapi jangan senyap total
      process.stderr.write(`[warn] vector: embedding attempt failed: ${(e as Error).message}\n`)
      return null
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      if (!loc || hop === 2) return null
      try {
        current = new URL(loc, current).toString()
        const proto = new URL(current).protocol
        if (proto !== "https:" && proto !== "http:") return null
        continue
      } catch {
        return null
      }
    }
    if (!res.ok) return null
    try {
      return (await res.json()) as { data?: { embedding: number[] }[] }
    } catch {
      return null
    }
  }
  return null
}

// Diekspor agar bisa diuji (budget total vs per-attempt) tanpa DB —
// pemakaian produksi lewat addMemory/query yang memakai default.
export async function embedTexts(
  baseUrl: string,
  apiKey: string,
  texts: string[],
  model?: string,
  timeouts?: { attemptMs?: number; totalMs?: number },
): Promise<number[][] | null> {
  if (!apiKey || !baseUrl) return null
  // [Fase 7 / Live #3] Circuit-breaker: endpoint yang baru saja gagal
  // (timeout/404/koneksi ditolak) langsung di-skip <5ms — tanpa menunggu
  // timeout jaringan lagi. Fallback keyword/FTS5 berjalan apa adanya.
  if (embeddingCircuitBroken(baseUrl, model)) {
    return null
  }
  try {
    const hostname = new URL(baseUrl).hostname
    if (await isPrivateHostWithDns(hostname, { strict: true, timeoutMs: 1000, noCache: true })) {
      process.stderr.write(`[vector] private host rejected: ${hostname}\n`)
      return null
    }
  } catch {
    return null
  }
  const urls = [
    `${baseUrl.replace(/\/+$/, "")}/embeddings`,
    `${baseUrl.replace(/\/+$/, "")}/v1/embeddings`,
  ]
  const headersList = [
    { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, "content-type": "application/json" },
    { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    { "x-api-key": apiKey, "content-type": "application/json" },
  ]
  const body = JSON.stringify({
    model: model ?? process.env.MINICODE_EMBED_MODEL ?? "text-embedding-3-small",
    input: texts,
  })
  // Budget total untuk seluruh matriks attempt (lihat EMBEDDING_TOTAL_TIMEOUT_MS).
  const budget = AbortSignal.timeout(timeouts?.totalMs ?? LIMITS.EMBEDDING_TOTAL_TIMEOUT_MS)
  // Jangan tahan process hidup hanya karena timer budget ini.
  try {
    ;(budget as unknown as { unref?: () => void }).unref?.()
  } catch {}
  for (const headers of headersList) {
    for (const url of urls) {
      if (budget.aborted) return null
      const json = await fetchEmbeddingsOnce(
        url,
        headers as Record<string, string>,
        body,
        budget,
        timeouts?.attemptMs,
      )
      if (json?.data && Array.isArray(json.data)) return json.data.map((d) => d.embedding)
    }
  }
  // Semua attempt gagal (timeout/404/405/501/koneksi ditolak) → tandai endpoint
  // di circuit-breaker agar panggilan berikutnya langsung fallback.
  markEmbeddingCircuitBroken(baseUrl, model, "all embedding attempts failed")
  return null
}

// Retry singkat utk SQLITE_BUSY saat beberapa sub-agent menulis bersamaan.
// P0.2: async + Bun.sleep agar tidak block event-loop (sebelumnya Atomics.wait freeze 175ms).
async function withBusyRetry<T>(fn: () => T, attempts = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) throw e
      last = e
      await Bun.sleep(25 * 2 ** i)
    }
  }
  throw last
}

// Escape nilai untuk LIKE: % _ \ jadi literal (dipakai dengan ESCAPE '\').
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

export async function deleteMemoryByQuery(query: string, cwd?: string): Promise<number> {
  // Hapus dari DB lokal DAN global (bila berkasnya beda): searchHybrid
  // scope=all menggabung keduanya, sehingga hapus satu sisi membuat "lupa"
  // tak tuntas — data lama global tetap ditemukan (temuan audit 2026-09-16
  // M4; tulisan baru selalu lokal sejak audit #10 P1, tapi data legacy
  // global masih bisa ada). Global yang belum pernah ada dilewati agar
  // forget tak membuat berkas DB kosong sebagai side-effect.
  const pattern = escapeLike(query.toLowerCase())
  const paths = [dbPath(cwd)]
  try {
    const { join } = await import("node:path")
    const { homeDir } = await import("../lib/db-path.ts")
    const { existsSync } = await import("node:fs")
    const g = join(homeDir(), ".minicode", "vector.db")
    if (g !== paths[0] && existsSync(g)) paths.push(g)
  } catch {}
  let total = 0
  for (const p of paths) {
    const db = openAt(p)
    try {
      // Hitung dulu: sqlite3_changes() ikut menghitung tulis trigger FTS,
      // jadi info.changes DELETE bukan jumlah baris memory yang terhapus.
      const before = db
        .prepare(
          "SELECT count(*) as c FROM memory WHERE lower(text) LIKE '%' || ? || '%' ESCAPE '\\'",
        )
        .get(pattern) as { c: number } | null
      const n = before?.c ?? 0
      if (n === 0) continue
      await withBusyRetry(() =>
        db
          .prepare("DELETE FROM memory WHERE lower(text) LIKE '%' || ? || '%' ESCAPE '\\'")
          .run(pattern),
      )
      total += n
    } finally {
      db.close()
    }
  }
  return total
}

export async function clearAllMemory(cwd?: string): Promise<void> {
  const db = open(cwd)
  try {
    await withBusyRetry(() => {
      db.exec("DELETE FROM memory")
      db.exec("VACUUM")
    })
  } finally {
    db.close()
  }
}

// P2.2: pecah teks panjang jadi chunk ber-overlap agar embedding mean-pool
// tidak menghilangkan detail catatan panjang. Tiap chunk satu baris DB.
export function splitMemoryChunks(text: string): string[] {
  const size = LIMITS.MEMORY_CHUNK_CHARS
  const overlap = LIMITS.MEMORY_CHUNK_OVERLAP
  if (text.length <= size) return [text]
  const out: string[] = []
  let start = 0
  while (start < text.length) {
    out.push(text.slice(start, start + size))
    if (start + size >= text.length) break
    start += size - overlap
  }
  return out
}

export async function addMemory(
  text: string,
  opts: {
    baseUrl?: string
    apiKey?: string
    cwd?: string
    embeddingModel?: string
    category?: string
    tags?: string[]
    // MEM-01 / Fase 5A: provenance tracking untuk revokasi selektif & forensik poison memory
    sessionId?: string | null
    turnId?: string | null
    sourceKind?: "user" | "tool" | "agent" | "compaction" | "manual" | "legacy" | null
    sourceRef?: string | null
    // [Fase 6A / ACE-03] Pelajaran kandidat disimpan `provisional` sampai
    // verifikasi berikutnya memutuskan promote/reject.
    validationStatus?: "validated" | "provisional" | "rejected"
    // [Fase 8 / 8.1] Id baris memory LAMA yang digantikan oleh entri baru ini
    // (supersession). Saat diisi, baris lama di-tombstone (superseded_by = newId)
    // dan baris baru ditautkan (supersedes = oldId) dalam transaksi yang sama.
    supersedesId?: string | null
  } = {},
) {
  const clean = scrubSecrets(text)
  const chunks = splitMemoryChunks(clean)
  // Audit #10 P1 (§10/§39): tulis SELALU lokal ke proyek. Tanpa ini,
  // addMemory dari cwd tanpa `.minicode/` jatuh ke DB GLOBAL bersama
  // (resolveDbPath) — memori repo jahat A terbaca di proyek B yang tak
  // terkait. Buat direktori lokal dulu agar resolusi mendarat lokal; baca
  // tetap boleh fallback global (kompatibilitas data lama).
  try {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs")
    const { resolve: resolvePath, join: joinPath } =
      require("node:path") as typeof import("node:path")
    mkdirSync(joinPath(resolvePath(opts.cwd ?? process.cwd()), ".minicode"), { recursive: true })
  } catch {}
  const embedModel =
    opts.embeddingModel ?? process.env.MINICODE_EMBED_MODEL ?? "text-embedding-3-small"
  // Satu panggilan batch untuk semua chunk — hemat round-trip embedding.
  let vecs: number[][] | null = null
  if (opts.baseUrl && opts.apiKey) {
    vecs = await embedTexts(opts.baseUrl, opts.apiKey, chunks, embedModel)
  }
  const parentId = randomUUID()
  const now = Date.now()
  const db = open(opts.cwd)
  // chmod 600 untuk vector.db (+ -wal/-shm) agar secret tidak world-readable
  try {
    const { chmodSync } = require("node:fs") as typeof import("node:fs")
    const p = dbPath(opts.cwd)
    for (const f of [p, `${p}-wal`, `${p}-shm`]) {
      try {
        chmodSync(f, 0o600)
      } catch {}
    }
  } catch {}
  try {
    // F8.1: transaksi supersession — insert baris baru + tombstone baris lama
    // (bila `supersedesId` diisi) atomik dalam satu transaksi.
    for (let i = 0; i < chunks.length; i++) {
      const v = vecs?.[i]
      const embedding = v ? toBlob(v) : null
      const id = i === 0 ? parentId : randomUUID()
      const category = (opts.category as string) ?? "fact"
      const tagsJson = opts.tags ? JSON.stringify(opts.tags) : null
      // MEM-01: insert provenance columns (nullable; legacy DBs get NULL default)
      const supersedes = i === 0 ? (opts.supersedesId ?? null) : null
      await withBusyRetry(() =>
        db
          .prepare(
            "INSERT INTO memory (id, text, embedding, created_at, model, dim, parent, category, tags, access_count, session_id, turn_id, source_kind, source_ref, validation_status, supersedes, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL)",
          )
          .run(
            id,
            chunks[i]!,
            embedding,
            now,
            embedding ? embedModel : null,
            v?.length ?? null,
            parentId,
            category,
            tagsJson,
            opts.sessionId ?? null,
            opts.turnId ?? null,
            opts.sourceKind ?? null,
            opts.sourceRef ?? null,
            opts.validationStatus ?? "validated",
            supersedes,
          ),
      )
      // Tombstone baris lama hanya pada chunk pertama (parent) — sinkronisasi
      // tombstone untuk chunk berbagi parent dilakukan di supersedeMemory.
      if (i === 0 && opts.supersedesId) {
        const oldId = opts.supersedesId as string
        await withBusyRetry(() =>
          db.prepare(`UPDATE memory SET superseded_by = ? WHERE id = ?`).run(id, oldId),
        )
      }
    }
    // [Fase 9 / 9.2] Fault-injection boundary ":after_vector_before_file":
    // vector.db sudah ter-commit (loop insert di atas selesai), but "file write"
    // (MEMORY.md) yang dalam model atomic two-store belum selesai. Injector yang
    // melempar di stage ini menyimulasikan crash persis setelah vector berhasil
    // → menghasilkan entri vector-only (split-brain arah 2). Panggil SEBELUM
    // prune agar baris vector yang baru di-commit tetap utuh saat crash.
    invokeMemoryWriteFaultForTest("after_vector_before_file")
    // P13 P1: prune TTL HIERARKIS per kategori (best-effort, jangan gagalkan write).
    // Fakta/keputusan awet 180 hari, ringkasan 90, snippet 14 — snippet basi
    // (mis. "test X lolos") menyesatkan bila dibiarkan selama fakta.
    try {
      const day = 24 * 60 * 60 * 1000
      const cuts = [
        { cats: ["snippet"], ms: LIMITS.MEMORY_TTL_SNIPPET_DAYS * day },
        { cats: ["summary"], ms: LIMITS.MEMORY_TTL_SUMMARY_DAYS * day },
        { cats: ["fact", "decision", "preference"], ms: LIMITS.MEMORY_TTL_FACT_DAYS * day },
      ]
      for (const c of cuts) {
        if (c.ms <= 0) continue
        const ph = c.cats.map(() => "?").join(",")
        // Bucket fakta juga menampung NULL (DB lama pra-S2) — jangan abadi.
        const nullCatch = c.cats.includes("fact") ? " OR category IS NULL" : ""
        await withBusyRetry(() =>
          db
            .prepare(
              `DELETE FROM memory WHERE (category IN (${ph})${nullCatch}) AND created_at < ?`,
            )
            .run(...c.cats, now - c.ms),
        )
      }
      const cnt =
        (db.prepare("SELECT count(*) as c FROM memory").get() as { c: number } | null)?.c ?? 0
      if (cnt > LIMITS.MEMORY_MAX_ROWS) {
        await withBusyRetry(() =>
          db
            .prepare(
              `DELETE FROM memory WHERE id IN (SELECT id FROM memory ORDER BY created_at DESC LIMIT -1 OFFSET ${LIMITS.MEMORY_MAX_ROWS})`,
            )
            .run(),
        )
      }
      if (cnt % 1000 === 0) {
        try {
          db.exec("VACUUM")
        } catch {}
      }
    } catch (e) {
      process.stderr.write(`[warn] vector: prune failed: ${(e as Error).message}\n`)
    }
  } finally {
    db.close()
  }
  return parentId
}

/**
 * [Fase 8 / 8.1] Supersession Memory — gantikan fakta/keputusan lama dengan
 * yang baru secara durable & idempoten.
 *
 * - `supersedeMemory(oldId, newId, cwd?)` mengisi `supersedes = oldId` pada
 *   baris baru (`newId`) dan `superseded_by = newId` pada baris lama
 *   (`oldId`), lalu memperbarui `MEMORY.md`.
 * - `addMemory(..., { supersedesId })` menerima `supersedesId` (id baris lama
 *   yang digantikan) saat insert baris baru; hubungan dua arah dicatat dalam
 *   transaksi yang sama.
 * - `topicKey(name)` menghasilkan kunci topik `key:<name>` yang bisa dipakai
 *   sebagai `category`/tag untuk mengelompokkan supersession per topik.
 */
export function topicKey(name: string): string {
  return `key:${name}`
}

export async function supersedeMemory(oldId: string, newId: string, cwd?: string): Promise<void> {
  const db = open(cwd)
  try {
    await withBusyRetry(() => {
      // Baris lama tidak boleh dihapus — hanya ditandai superseded (tombstone).
      const oldRow = db.prepare(`SELECT id FROM memory WHERE id = ?`).get(oldId) as {
        id: string
      } | null
      if (!oldRow) {
        throw new Error(`supersedeMemory: old memory id not found: ${oldId}`)
      }
      const newRow = db.prepare(`SELECT id FROM memory WHERE id = ?`).get(newId) as {
        id: string
      } | null
      if (!newRow) {
        throw new Error(`supersedeMemory: new memory id not found: ${newId}`)
      }
      // Tombstone baris lama → superseded_by = newId
      db.prepare(`UPDATE memory SET superseded_by = ? WHERE id = ?`).run(newId, oldId)
      // Tautkan baris baru → supersedes = oldId
      db.prepare(`UPDATE memory SET supersedes = ? WHERE id = ?`).run(oldId, newId)
    })
    // Perbarui MEMORY.md (best-effort — jangan gagalkan supersession)
    try {
      await syncMemoryFileToSupersession(cwd, oldId, newId)
    } catch {}
  } finally {
    db.close()
  }
}

async function syncMemoryFileToSupersession(
  cwd: string | undefined,
  oldId: string,
  newId: string,
): Promise<void> {
  // Append catatan supersession ke MEMORY.md (best-effort; appendMemory hanya
  // menerima (text, cwd?) — tanpa object opts).
  const { appendMemory } = await import("../memory/files.ts")
  await appendMemory(`[supersession] fact ${oldId} → ${newId} (superseded)`, cwd)
}

export async function supersedeMemoryByIds(
  oldIds: string[],
  newId: string,
  cwd?: string,
): Promise<number> {
  let n = 0
  const db = open(cwd)
  try {
    await withBusyRetry(() => {
      for (const oldId of oldIds) {
        const oldRow = db.prepare(`SELECT id FROM memory WHERE id = ?`).get(oldId) as {
          id: string
        } | null
        if (oldRow) {
          db.prepare(`UPDATE memory SET superseded_by = ? WHERE id = ?`).run(newId, oldId)
          n++
        }
      }
      db.prepare(`UPDATE memory SET supersedes = ? WHERE id = ?`).run(oldIds.join(","), newId)
    })
  } finally {
    db.close()
  }
  return n
}

/**
 * [Fase 8 / 8.1] Rekam pelajaran KANDIDAT (belum terverifikasi).
 * Pelajaran disimpan `provisional` sehingga retrieval default tidak akan
 * menyajikannya sebagai fakta; verifikasi berikutnya memutuskan promote/reject
 * lewat `promoteOrRejectLessonsBySession`.
 */
export async function recordCandidateLesson(
  sessionId: string,
  text: string,
  opts: {
    cwd?: string
    baseUrl?: string
    apiKey?: string
    embeddingModel?: string
    category?: string
    tags?: string[]
    turnId?: string | null
    sourceRef?: string | null
  } = {},
): Promise<string> {
  return addMemory(text, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.embeddingModel !== undefined ? { embeddingModel: opts.embeddingModel } : {}),
    category: opts.category ?? "decision",
    tags: opts.tags,
    sessionId,
    turnId: opts.turnId ?? null,
    sourceKind: "agent",
    sourceRef: opts.sourceRef ?? "candidate-lesson",
    validationStatus: "provisional",
  })
}

/**
 * [Fase 6A / ACE-03] Promote/reject seluruh pelajaran kandidat milik sesi ini.
 *
 * - `passed`  → `validated` (boleh muncul di retrieval default)
 * - `failed`  → `rejected`  (permanen disembunyikan dari retrieval)
 * - `unknown` → tidak menyentuh apa pun (bukti belum cukup = jangan mengarang)
 */
export async function promoteOrRejectLessonsBySession(
  sessionId: string,
  verdict: "passed" | "failed" | "unknown",
  cwd?: string,
): Promise<{ promoted: number; rejected: number }> {
  if (!sessionId || verdict === "unknown") return { promoted: 0, rejected: 0 }
  const db = open(cwd)
  try {
    const result = await withBusyRetry(() =>
      db
        .prepare(
          `UPDATE memory SET validation_status = ? WHERE session_id = ? AND validation_status = 'provisional'`,
        )
        .run(verdict === "passed" ? "validated" : "rejected", sessionId),
    )
    const changed = result.changes ?? 0
    return verdict === "passed"
      ? { promoted: changed, rejected: 0 }
      : { promoted: 0, rejected: changed }
  } catch {
    return { promoted: 0, rejected: 0 }
  } finally {
    db.close()
  }
}

type MemoryRow = {
  text: string
  embedding: Buffer | null
  dim: number | null
  model: string | null
  created_at: number
  category?: string | null
  tags?: string | null
  // MEM-01 / Fase 5A: provenance fields (nullable for legacy DBs)
  session_id?: string | null
  turn_id?: string | null
  source_kind?: string | null
  source_ref?: string | null
  // [Fase 6A / ACE-03] NULL legacy = validated
  validation_status?: string | null
  // F8.1: Supersession tracking (nullable — legacy rows won't have them)
  supersedes?: string | null
  superseded_by?: string | null
}

export interface MemoryHit {
  text: string
  score: number
  createdAt: number
  // MEM-01 / Fase 5A: provenance metadata untuk forensik & revokasi selektif
  provenance?: {
    sessionId?: string | null
    turnId?: string | null
    sourceKind?: string | null
    sourceRef?: string | null
    validationStatus?: string | null
  }
}

// Kemiripan teks Jaccard untuk MMR bila pasangan tanpa vektor: cegah 5 hits
// parafrase ("prefer bun over npm" ×3) menghabiskan budget prompt.
function textSim(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter(Boolean))
  const tb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const w of ta) if (tb.has(w)) inter++
  return inter / (ta.size + tb.size - inter)
}

// P2.1: buang near-duplikat (cosine > MEMORY_DEDUP_COSINE) + MMR λ untuk
// diversitas. Tanpa vektor hanya dedup teks eksak (Map) + MMR via textSim.
function mmrRerank(
  cands: { text: string; score: number; vec: number[] | null }[],
  topK: number,
): { text: string; score: number }[] {
  const lambda = LIMITS.MEMORY_MMR_LAMBDA
  // 1. near-dedup: kandidat skor-rendah yang nyaris identik dengan yang
  //    skor-lebih-tinggi dibuang (tak ada gunanya di prompt dua-duanya).
  const kept: typeof cands = []
  for (const c of cands) {
    let dup = false
    for (const k of kept) {
      if (c.vec && k.vec) {
        if (c.vec.length === k.vec.length && cosine(c.vec, k.vec) > LIMITS.MEMORY_DEDUP_COSINE) {
          dup = true
          break
        }
      } else if (c.text === k.text) {
        dup = true
        break
      }
    }
    if (!dup) kept.push(c)
  }
  // 2. MMR: tiap putaran pilih kandidat dengan λ*relevansi − (1−λ)*maxSimTerpilih.
  const selected: typeof cands = []
  const rest = [...kept]
  while (rest.length > 0 && selected.length < topK) {
    let best = 0
    let bestVal = -Infinity
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]!
      let maxSim = 0
      for (const s of selected) {
        const sim =
          c.vec && s.vec && c.vec.length === s.vec.length
            ? cosine(c.vec, s.vec)
            : textSim(c.text, s.text)
        if (sim > maxSim) maxSim = sim
      }
      const val = lambda * c.score - (1 - lambda) * maxSim
      if (val > bestVal) {
        bestVal = val
        best = i
      }
    }
    selected.push(rest.splice(best, 1)[0]!)
  }
  return selected.map(({ text, score }) => ({ text, score }))
}

// Peringatan dim-mismatch cukup sekali per dimensi agar tidak spam stderr tiap hit.
const dimMismatchWarned = new Set<string>()

// Bangun query FTS5 aman: tiap keyword di-quote ("...") agar karakter khusus
// FTS (*, :, ", -) tidak jadi operator. Return null bila tidak ada keyword valid.
function buildFtsQuery(query: string): string | null {
  const kws = query.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 5)
  if (kws.length === 0) return null
  return kws.map((k) => `"${k.replace(/"/g, '""')}"`).join(" OR ")
}

export async function searchHybrid(
  query: string,
  opts: {
    baseUrl?: string
    apiKey?: string
    cwd?: string
    topK?: number
    embeddingModel?: string
    scope?: "cwd" | "global" | "all"
    // false = jangan sentuh DB (readonly/plan: retrieval tak boleh menulis
    // access_count/WAL). Default true agar perilaku lama tidak berubah.
    trackAccess?: boolean
    /** [Fase 6A / ACE-03] default false: pelajaran `provisional`/`rejected` disembunyikan. */
    includeProvisional?: boolean
    /** [Fase 8 / 8.1] default false: baris yang sudah di-supersede disembunyikan dari recall. */
    includeSuperseded?: boolean
  } = {},
): Promise<MemoryHit[]> {
  const scope = opts.scope ?? (process.env.MINICODE_MEMORY_SCOPE as string) ?? "cwd"
  // helper untuk ambil rows dari satu DB path (dipakai untuk scope all)
  const fetchRows = (db: ReturnType<typeof open>): MemoryRow[] => {
    const keywords = query.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 5)
    const escKeywords = keywords.map((k) =>
      k.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_"),
    )
    // F8.1: recall default SENGAJA mengecualikan baris yang sudah di-supersede
    // (superseded_by IS NOT NULL AND != ''). Hanya `includeSuperseded: true`
    // yang menampilkannya kembali (untuk forensik/audit).
    const notSuperseded =
      opts.includeSuperseded === true ? `1=1` : `(superseded_by IS NULL OR superseded_by = '')`
    const cols = `text, embedding, dim, model, created_at, category, tags, session_id, turn_id, source_kind, source_ref, validation_status, supersedes, superseded_by`
    if (keywords.length > 0) {
      const recentRows = db
        .prepare(
          `SELECT ${cols} FROM memory WHERE ${notSuperseded} ORDER BY created_at DESC LIMIT ${LIMITS.VECTOR_RECENT_LIMIT}`,
        )
        .all() as MemoryRow[]
      let keywordRows: MemoryRow[] = []
      const ftsQ = buildFtsQuery(query)
      if (ftsQ) {
        try {
          keywordRows = db
            .prepare(
              `SELECT m.text as text, m.embedding as embedding, m.dim as dim, m.model as model, m.created_at as created_at, m.category as category, m.tags as tags, m.session_id as session_id, m.turn_id as turn_id, m.source_kind as source_kind, m.source_ref as source_ref, m.validation_status as validation_status, m.supersedes as supersedes, m.superseded_by as superseded_by FROM memory_fts f JOIN memory m ON m.rowid = f.rowid WHERE ${notSuperseded} AND memory_fts MATCH ? ORDER BY rank LIMIT ${LIMITS.VECTOR_KEYWORD_LIMIT}`,
            )
            .all(ftsQ) as MemoryRow[]
        } catch {
          keywordRows = []
        }
      }
      if (keywordRows.length === 0) {
        const likeClauses = keywords
          .map(() => `lower(text) LIKE '%' || lower(?) || '%' ESCAPE '\\'`)
          .join(" OR ")
        keywordRows = db
          .prepare(
            `SELECT ${cols} FROM memory WHERE ${notSuperseded} AND (${likeClauses}) ORDER BY created_at DESC LIMIT ${LIMITS.VECTOR_KEYWORD_LIMIT}`,
          )
          .all(...escKeywords) as MemoryRow[]
      }
      const merged = new Map<string, MemoryRow>()
      for (const r of [...recentRows, ...keywordRows])
        if (!merged.has(r.text)) merged.set(r.text, r)
      return [...merged.values()].slice(0, LIMITS.VECTOR_SEARCH_LIMIT)
    } else {
      return db
        .prepare(
          `SELECT ${cols} FROM memory WHERE ${notSuperseded} ORDER BY created_at DESC LIMIT ${LIMITS.VECTOR_SEARCH_LIMIT}`,
        )
        .all() as MemoryRow[]
    }
  }

  let rows: MemoryRow[]
  const db = scope === "global" ? openGlobalDb(opts.cwd) : open(opts.cwd)
  try {
    rows = fetchRows(db)
    if (scope === "all") {
      try {
        const { join } = await import("node:path")
        const { homeDir } = await import("../lib/db-path.ts")
        const { Database } = await import("bun:sqlite")
        const globalPath = join(homeDir(), ".minicode", "vector.db")
        const localPath = dbPath(opts.cwd)
        if (globalPath !== localPath) {
          const gdb = new Database(globalPath)
          try {
            const gRows = fetchRows(gdb as unknown as ReturnType<typeof open>)
            const merged = new Map<string, MemoryRow>()
            for (const r of [...rows, ...gRows]) if (!merged.has(r.text)) merged.set(r.text, r)
            rows = [...merged.values()].slice(0, LIMITS.VECTOR_SEARCH_LIMIT)
          } finally {
            gdb.close()
          }
        }
      } catch {}
    }
  } finally {
    db.close()
  }
  // [Fase 6A / ACE-03] Gate default: pelajaran kandidat (`provisional`) dan
  // yang sudah ditolak (`rejected`) TIDAK boleh tampil seolah fakta. NULL
  // legacy = validated agar DB lama tetap terbaca.
  if (opts.includeProvisional !== true) {
    rows = rows.filter((r) => (r.validation_status ?? "validated") === "validated")
  }
  if (rows.length === 0) return []

  let queryVec: number[] | null = null
  if (opts.baseUrl && opts.apiKey) {
    const vecs = await embedTexts(opts.baseUrl, opts.apiKey, [query], opts.embeddingModel)
    if (vecs?.[0]) queryVec = vecs[0]
  }

  const scored = rows.map((r) => {
    let vec: number[] | null = null
    let vecScore = 0
    if (queryVec && r.embedding) {
      vec = fromBlob(r.embedding)
      if (vec.length !== queryVec.length) {
        // P1.3: dim mismatch (ganti MINICODE_EMBED_MODEL) → vecScore 0 + warn sekali
        const key = `${r.dim ?? vec.length}->${queryVec.length}`
        if (!dimMismatchWarned.has(key)) {
          dimMismatchWarned.add(key)
          process.stderr.write(
            `[warn] vector: dim mismatch (stored ${r.dim ?? vec.length} vs query ${queryVec.length}, model ${r.model ?? "?"}) — fallback keyword-only untuk hit ini\n`,
          )
        }
        vec = null
      } else {
        vecScore = cosine(queryVec, vec)
      }
    }
    const kw = keywordScore(query, r.text)
    // hybrid 0.7 vector + 0.3 keyword, if no vector -> keyword only
    let score = queryVec ? vecScore * 0.7 + kw * 0.3 : kw
    // Recency decay (audit #14): koreksi kemarin harus mengalahkan fakta 170
    // hari dengan skor hampir sama — TTL menghapus di ujung, tapi sebelum itu
    // tak ada penurunan bertahap. Paruh-hidup 60 hari: 1 minggu ≈ 0.92×,
    // 6 bulan ≈ 0.12× (jatuh di bawah ambang relevansi, efeknya sama dengan
    // kadaluwarsa). Fakta fresh (age≈0) tidak berubah → test lama tetap hijau.
    const ageDays = (Date.now() - r.created_at) / 86_400_000
    score *= 0.5 ** (ageDays / 60)
    // P13 S2 — boost decision/preference bila query menyentuh kata kuncinya.
    // Regex kini dwibahasa (EN + ID): prompt Indonesia ("perbaiki",
    // "keputusan", "suka") tidak boleh kehilangan boost yang dinikmati versi EN.
    if (
      (r as MemoryRow).category === "decision" &&
      /fix|decide|decision|perbaiki|keputusan|selesaikan/i.test(query)
    )
      score += 0.1
    if (
      (r as MemoryRow).category === "preference" &&
      /prefer|like|preference|suka|ingin/i.test(query)
    )
      score += 0.05
    return { text: r.text, score, vec, createdAt: r.created_at }
  })
  const minScore = queryVec ? LIMITS.MEMORY_MIN_SCORE_HYBRID : LIMITS.MEMORY_MIN_SCORE_KEYWORD
  const filtered = scored.filter((s) => s.score >= minScore)
  filtered.sort((a, b) => b.score - a.score)
  // P2.1: MMR di atas kandidat teratas agar prompt tidak dipenuhi parafrase sama.
  const pool = filtered.slice(0, LIMITS.MEMORY_MMR_CANDIDATES)
  const ranked = mmrRerank(pool, opts.topK ?? 5)
  const createdByText = new Map(pool.map((p) => [p.text, p.createdAt] as const))
  const rowsByText = new Map(rows.map((r) => [r.text, r] as const))
  const hits = ranked.map((h) => {
    const row = rowsByText.get(h.text)
    return {
      ...h,
      createdAt: createdByText.get(h.text) ?? Date.now(),
      provenance: row
        ? {
            sessionId: row.session_id,
            turnId: row.turn_id,
            sourceKind: row.source_kind,
            sourceRef: row.source_ref,
            validationStatus: row.validation_status ?? "validated",
          }
        : undefined,
    }
  })
  // P13 P1 — bukti manfaat per row: hit yang dikembalikan menaikkan
  // access_count (best-effort; gagal diam — jangan rusak retrieval).
  // Hanya DB lokal yang disentuh; row global (scope all) tidak dihitung.
  // Dilewati bila trackAccess === false (mode readonly/plan).
  if (hits.length > 0 && opts.trackAccess !== false) {
    try {
      const db2 = open(opts.cwd)
      try {
        const ph = hits.map(() => "?").join(",")
        db2
          .prepare(
            `UPDATE memory SET access_count = COALESCE(access_count, 0) + 1 WHERE text IN (${ph})`,
          )
          .run(...hits.map((h) => h.text))
      } finally {
        db2.close()
      }
    } catch {}
  }
  return hits
}

// MEM-03 / Fase 5A: Prune TTL dengan virtual/injectable clock untuk deterministik testing.
// Returns jumlah baris yang terhapus. `nowMs` default Date.now() bila tidak diinjeksi.
export async function pruneTTL(cwd?: string, nowMs: number = Date.now()): Promise<number> {
  const db = open(cwd)
  try {
    let deleted = 0
    const day = 24 * 60 * 60 * 1000
    // Hierarki TTL: snippet (14d), summary (90d), fact/decision/preference (180d)
    const cuts = [
      { cats: ["snippet"], ms: LIMITS.MEMORY_TTL_SNIPPET_DAYS * day },
      { cats: ["summary"], ms: LIMITS.MEMORY_TTL_SUMMARY_DAYS * day },
      { cats: ["fact", "decision", "preference"], ms: LIMITS.MEMORY_TTL_FACT_DAYS * day },
    ]
    for (const c of cuts) {
      if (c.ms <= 0) continue
      const ph = c.cats.map(() => "?").join(",")
      const nullCatch = c.cats.includes("fact") ? " OR category IS NULL" : ""
      const result = await withBusyRetry(() =>
        db
          .prepare(`DELETE FROM memory WHERE (category IN (${ph})${nullCatch}) AND created_at < ?`)
          .run(...c.cats, nowMs - c.ms),
      )
      deleted += result.changes ?? 0
    }
    // CAP: potong ke MEMORY_MAX_rows bila melebihi batas
    const cnt =
      (db.prepare("SELECT count(*) as c FROM memory").get() as { c: number } | null)?.c ?? 0
    if (cnt > LIMITS.MEMORY_MAX_ROWS) {
      const result = await withBusyRetry(() =>
        db
          .prepare(
            `DELETE FROM memory WHERE id IN (SELECT id FROM memory ORDER BY created_at DESC LIMIT -1 OFFSET ${LIMITS.MEMORY_MAX_ROWS})`,
          )
          .run(),
      )
      deleted += result.changes ?? 0
    }
    return deleted
  } finally {
    db.close()
  }
}

// MEM-01 / Fase 5A: Revoke semua memori berdasarkan provenance (selective poisoning).
// Hapus dari vektor DB + MEMORY.md secara atomik/idempoten. Returns { vectorRows, fileLines }.
export async function revokeByProvenance(
  criteria: { sessionId?: string; turnId?: string; sourceKind?: string },
  cwd?: string,
): Promise<{ vectorRows: number; fileLines: number }> {
  const { sessionId, turnId, sourceKind } = criteria
  let vectorDeleted = 0

  // Dari vektor DB: filter sesuai kriteria provenance yang tersedia
  const conditions: string[] = []
  const values: unknown[] = []
  if (sessionId) {
    conditions.push(`session_id = ?`)
    values.push(sessionId)
  }
  if (turnId) {
    conditions.push(`turn_id = ?`)
    values.push(turnId)
  }
  if (sourceKind) {
    conditions.push(`source_kind = ?`)
    values.push(sourceKind)
  }

  if (conditions.length > 0) {
    const db = open(cwd)
    try {
      const before = db
        .prepare(`SELECT count(*) as c FROM memory WHERE ${conditions.join(" AND ")}`)
        .get(...(values as [string | null])) as { c: number } | null
      const n = before?.c ?? 0
      if (n > 0) {
        const result = await withBusyRetry(() =>
          db
            .prepare(`DELETE FROM memory WHERE ${conditions.join(" AND ")}`)
            .run(...(values as [string | null])),
        )
        vectorDeleted = result.changes ?? 0
      }
    } finally {
      db.close()
    }
  }

  // Dari MEMORY.md: hapus baris yang memuat metadata provenance (jika tersimpan sebagai tag)
  // FILE_STORE: tags JSON dalam baris → parse dan match terhadap criteria
  let fileDeleted = 0
  try {
    const { readFile, writeFile } = await import("node:fs/promises")
    const { resolve } = await import("node:path")
    const LOCAL_MEM = ".minicode/MEMORY.md"
    const path = resolve(cwd ?? process.cwd(), LOCAL_MEM)

    let txt: string
    try {
      txt = await readFile(path, "utf8")
    } catch {
      // File belum ada atau tidak bisa dibaca — ok saja
      return { vectorRows: vectorDeleted, fileLines: fileDeleted }
    }

    const lines = txt.split("\n")
    const kept: string[] = []
    let del = 0

    for (const line of lines) {
      // MEMORY.md format: `- YYYY-MM-DDTHH:MM:SS.sssZ text ... [tags: ...]`
      // Ekstrak tag jika ada, lalu cek match criteria
      const tagMatch = line.match(/\[tags:\s*([^\]]+)\]/)
      let matched = false

      if (!tagMatch) {
        // Tidak ada tag → hanya cocok bila query substring ada
        matched =
          !sessionId ||
          line.toLowerCase().includes((sessionId ?? "").toLowerCase()) ||
          !turnId ||
          line.toLowerCase().includes((turnId ?? "").toLowerCase()) ||
          !sourceKind ||
          line.toLowerCase().includes((sourceKind ?? "").toLowerCase())
      } else {
        // Parse JSON tags dan cek match
        try {
          const tags = JSON.parse(tagMatch![1] as string) as string[]
          const hasSessionId = sessionId
            ? tags.some((t: string) => t.includes(`session:${sessionId as string}`))
            : false
          const hasTurnId = turnId
            ? tags.some((t: string) => t.includes(`turn:${turnId as string}`))
            : false
          const hasSource = sourceKind
            ? tags.some((t: string) => t.includes(`source:${sourceKind as string}`))
            : false
          matched = hasSessionId || hasTurnId || hasSource
        } catch {
          // Tag corrupted / bukan JSON → skip
          kept.push(line)
          continue
        }
      }

      if (matched) {
        del++
      } else {
        kept.push(line)
      }
    }

    if (del > 0) {
      await writeFile(path, kept.join("\n"), "utf8")
      fileDeleted = del
    }
  } catch {}

  return { vectorRows: vectorDeleted, fileLines: fileDeleted }
}

// MEM-03 / Fase 5A: Helper evaluasi kualitas retrieval — precision@k & recall@k.
// retrievedIds = ID hasil retrieval, relevantIds = ID ground truth yang relevan.
export function computePrecisionAtK(
  retrievedIds: string[],
  relevantIds: string[],
  k: number,
): number {
  const topK = retrievedIds.slice(0, Math.min(k, retrievedIds.length))
  let correct = 0
  const relevantSet = new Set(relevantIds)
  for (const id of topK) {
    if (relevantSet.has(id)) correct++
  }
  return topK.length > 0 ? correct / topK.length : 0
}

export function computeRecallAtK(retrievedIds: string[], relevantIds: string[], k: number): number {
  const topK = retrievedIds.slice(0, Math.min(k, retrievedIds.length))
  let correct = 0
  const relevantSet = new Set(relevantIds)
  for (const id of topK) {
    if (relevantSet.has(id)) correct++
  }
  return relevantIds.length > 0 ? correct / relevantIds.length : 0
}

// MEM-04 / Fase 5A: Rekonsiliasi split-brain antara vektor DB & file store.
// Menyelaraskan ketidakcocokan setelah crash:
//   - Vector-only rows → hapus jika tidak ada di file (atau sebaliknya sesuai mode)
//   - File-only rows → tulis ulang ke vektor jika belum ada
// Returns { reconciled: number; vectorOnlyRemoved: number; fileOnlyAdded: number }
export async function reconcileMemoryStores(cwd?: string): Promise<{
  reconciled: number
  vectorOnlyRemoved: number
  fileOnlyAdded: number
}> {
  const db = open(cwd)
  try {
    // Ambil semua text dari vektor
    const vectorRows = db.prepare("SELECT text FROM memory").all() as { text: string }[]
    const vectorTexts = new Set(vectorRows.map((r) => r.text))

    // Baca MEMORY.md dan extract unique texts
    const { readFile } = await import("node:fs/promises")
    const { resolve } = await import("node:path")
    const LOCAL_MEM = ".minicode/MEMORY.md"
    const path = resolve(cwd ?? process.cwd(), LOCAL_MEM)

    let txt: string
    try {
      txt = await readFile(path, "utf8")
    } catch {
      // [Fase 9 / 9.2] File MEMORY.md ABSENT bukan berarti "clean slate" —
      // vector.db yang sudah punya baris (crash "after_vector_before_file")
      // berarti split-brain vector-only. Perlakukan file kosong (bukan early
      // return) agar baris vector-only tetap terdeteksi & dibersihkan.
      txt = ""
    }

    const fileLines = txt.split("\n").filter((l) => l.startsWith("- "))
    const fileTexts = new Set<string>()
    for (const line of fileLines) {
      // MEMORY.md format: `- YYYY-MM-DD text` ATAU `- YYYY-MM-DDTHH:MM:SS.sssZ text`.
      // [LF-1] Lama mensyaratkan `T` (ISO timestamp) sehingga tanggal polos
      // `YYYY-MM-DD` jatuh ke fallback rusak yang memotong teks ke kata pertama.
      const match = line.match(/^-\s+\d{4}-\d{2}-\d{2}(?:T\S+)?\s+(.+)$/)
      if (match) {
        let text = match[1]!
        // Strip tags metadata if present
        const tagMatch = text.match(/\[tags:\s*([^\]]+)\]/)
        if (tagMatch) {
          text = text.slice(0, tagMatch.index!)
        }
        fileTexts.add(text.trim())
      } else {
        // [LF-1] Fallback: buang prefix `- <date-token> ` dan pertahankan SISA TEKS
        // UTUH (bukan potong ke kata pertama seperti `split(" ", 3)` lama).
        const text = line
          .trim()
          .replace(/^-\s+\S+\s+/, "")
          .trim()
        if (text) fileTexts.add(text)
      }
    }

    let vectorOnlyRemoved = 0
    let fileOnlyAdded = 0
    let reconciled = 0

    // 1. Hapus vector-only rows (exist in DB but not in file)
    const vectorToKeep: string[] = []
    for (const text of vectorTexts) {
      const found = Array.from(fileTexts).some((ft) =>
        ft.toLowerCase().includes(text.toLowerCase()),
      )
      if (found) {
        vectorToKeep.push(text)
        reconciled++
      } else {
        // Delete from DB
        await withBusyRetry(() => db.prepare("DELETE FROM memory WHERE text = ?").run(text))
        vectorOnlyRemoved++
      }
    }

    // 2. Tambah file-only rows yang belum ada di vector
    for (const text of fileTexts) {
      if (!vectorTexts.has(text)) {
        // Insert into vector (without embedding, keyword-only fallback)
        await withBusyRetry(() =>
          db
            .prepare(
              "INSERT OR IGNORE INTO memory (id, text, embedding, created_at, category, session_id, turn_id, source_kind, source_ref) VALUES (?, ?, NULL, ?, 'manual', NULL, NULL, NULL, NULL)",
            )
            .run(randomUUID(), text, Date.now()),
        )
        fileOnlyAdded++
      }
    }

    return { reconciled, vectorOnlyRemoved, fileOnlyAdded }
  } finally {
    db.close()
  }
}

export interface MemoryStats {
  rows: number
  dbBytes: number
  walBytes: number
  shmBytes: number
  models: { model: string; count: number }[]
  dims: { dim: number; count: number }[]
  categories: { category: string; count: number }[]
  oldest: number | null
  newest: number | null
}

// P2.4: observabilitas untuk `minicode memory status` — tanpa embedding, murni SQL.
export function getMemoryStats(cwd?: string): MemoryStats {
  const db = open(cwd)
  try {
    const rows =
      (db.prepare("SELECT count(*) as c FROM memory").get() as { c: number } | null)?.c ?? 0
    const bounds = db
      .prepare("SELECT min(created_at) as oldest, max(created_at) as newest FROM memory")
      .get() as { oldest: number | null; newest: number | null } | null
    const models = db
      .prepare(
        "SELECT coalesce(model, '(keyword-only)') as model, count(*) as count FROM memory GROUP BY model ORDER BY count DESC",
      )
      .all() as { model: string; count: number }[]
    const dims = db
      .prepare(
        "SELECT coalesce(dim, 0) as dim, count(*) as count FROM memory GROUP BY dim ORDER BY count DESC",
      )
      .all() as { dim: number; count: number }[]
    const categories = db
      .prepare(
        "SELECT coalesce(category, 'fact') as category, count(*) as count FROM memory GROUP BY category ORDER BY count DESC",
      )
      .all() as { category: string; count: number }[]
    const p = dbPath(cwd)
    const sizeOf = (f: string): number => {
      try {
        return (require("node:fs") as typeof import("node:fs")).statSync(f).size
      } catch {
        return 0
      }
    }
    return {
      rows,
      dbBytes: sizeOf(p),
      walBytes: sizeOf(`${p}-wal`),
      shmBytes: sizeOf(`${p}-shm`),
      models,
      dims,
      categories,
      oldest: bounds?.oldest ?? null,
      newest: bounds?.newest ?? null,
    }
  } finally {
    db.close()
  }
}
