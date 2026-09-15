import { Database } from "bun:sqlite"
import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { LIMITS } from "../constants.ts"
import { resolveDbPath } from "../lib/db-path.ts"
import { isPrivateHostWithDns } from "../lib/net.ts"
import { scrubSecrets } from "../policy/scrub.ts"

const dbPath = (cwd?: string) => resolveDbPath("vector.db", cwd)

const initializedPaths = new Set<string>()

function open(cwd?: string): Database {
  const p = dbPath(cwd)
  const db = new Database(p)
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
    CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, text TEXT, embedding BLOB, created_at INTEGER, category TEXT DEFAULT 'fact', tags TEXT, model TEXT, dim INTEGER, parent TEXT, access_count INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_text ON memory(text);
  `)
  // P1.3: kolom model/dim untuk deteksi embedding-mismatch (best-effort migrasi)
  // P2.2: kolom parent untuk chunk entri panjang (chunk berbagi parent id)
  // P13 S2: kategori terstruktur untuk retrieval presisi
  // P13 P1: access_count untuk bukti manfaat (berapa kali row ikut jadi hit)
  try {
    const cols = db.prepare(`PRAGMA table_info(memory)`).all() as { name: string }[]
    if (!cols.some((c) => c.name === "model")) db.exec(`ALTER TABLE memory ADD COLUMN model TEXT`)
    if (!cols.some((c) => c.name === "dim")) db.exec(`ALTER TABLE memory ADD COLUMN dim INTEGER`)
    if (!cols.some((c) => c.name === "parent")) db.exec(`ALTER TABLE memory ADD COLUMN parent TEXT`)
    if (!cols.some((c) => c.name === "category"))
      db.exec(`ALTER TABLE memory ADD COLUMN category TEXT DEFAULT 'fact'`)
    if (!cols.some((c) => c.name === "tags")) db.exec(`ALTER TABLE memory ADD COLUMN tags TEXT`)
    if (!cols.some((c) => c.name === "access_count"))
      db.exec(`ALTER TABLE memory ADD COLUMN access_count INTEGER DEFAULT 0`)
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
  const db = open(cwd)
  try {
    const pattern = escapeLike(query.toLowerCase())
    // Hitung dulu: sqlite3_changes() ikut menghitung tulis trigger FTS,
    // jadi info.changes DELETE bukan jumlah baris memory yang terhapus.
    const before = db
      .prepare(
        "SELECT count(*) as c FROM memory WHERE lower(text) LIKE '%' || ? || '%' ESCAPE '\\'",
      )
      .get(pattern) as { c: number } | null
    const n = before?.c ?? 0
    if (n === 0) return 0
    await withBusyRetry(() =>
      db
        .prepare("DELETE FROM memory WHERE lower(text) LIKE '%' || ? || '%' ESCAPE '\\'")
        .run(pattern),
    )
    return n
  } finally {
    db.close()
  }
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
    for (let i = 0; i < chunks.length; i++) {
      const v = vecs?.[i]
      const embedding = v ? toBlob(v) : null
      const id = i === 0 ? parentId : randomUUID()
      const category = (opts.category as string) ?? "fact"
      const tagsJson = opts.tags ? JSON.stringify(opts.tags) : null
      await withBusyRetry(() =>
        db
          .prepare(
            "INSERT INTO memory (id, text, embedding, created_at, model, dim, parent, category, tags, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
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
          ),
      )
    }
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

type MemoryRow = {
  text: string
  embedding: Buffer | null
  dim: number | null
  model: string | null
  created_at: number
  category?: string | null
  tags?: string | null
}

export interface MemoryHit {
  text: string
  score: number
  createdAt: number
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
  } = {},
): Promise<MemoryHit[]> {
  const scope = opts.scope ?? (process.env.MINICODE_MEMORY_SCOPE as string) ?? "cwd"
  // helper untuk ambil rows dari satu DB path (dipakai untuk scope all)
  const fetchRows = (db: ReturnType<typeof open>): MemoryRow[] => {
    const keywords = query.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 5)
    const escKeywords = keywords.map((k) =>
      k.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_"),
    )
    if (keywords.length > 0) {
      const recentRows = db
        .prepare(
          `SELECT text, embedding, dim, model, created_at, category, tags FROM memory ORDER BY created_at DESC LIMIT ${LIMITS.VECTOR_RECENT_LIMIT}`,
        )
        .all() as MemoryRow[]
      let keywordRows: MemoryRow[] = []
      const ftsQ = buildFtsQuery(query)
      if (ftsQ) {
        try {
          keywordRows = db
            .prepare(
              `SELECT m.text as text, m.embedding as embedding, m.dim as dim, m.model as model, m.created_at as created_at, m.category as category, m.tags as tags FROM memory_fts f JOIN memory m ON m.rowid = f.rowid WHERE memory_fts MATCH ? ORDER BY rank LIMIT ${LIMITS.VECTOR_KEYWORD_LIMIT}`,
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
            `SELECT text, embedding, dim, model, created_at, category, tags FROM memory WHERE ${likeClauses} ORDER BY created_at DESC LIMIT ${LIMITS.VECTOR_KEYWORD_LIMIT}`,
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
          `SELECT text, embedding, dim, model, created_at, category, tags FROM memory ORDER BY created_at DESC LIMIT ${LIMITS.VECTOR_SEARCH_LIMIT}`,
        )
        .all() as MemoryRow[]
    }
  }

  let rows: MemoryRow[]
  const db = open(opts.cwd)
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
  const hits = ranked.map((h) => ({ ...h, createdAt: createdByText.get(h.text) ?? Date.now() }))
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
