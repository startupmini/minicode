import { Database } from "bun:sqlite"
import { LIMITS } from "../constants.ts"
import { resolveDbPath } from "../lib/db-path.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import { type DomainEvent, DURABILITY } from "../presentation/events.ts"

const dbPath = (cwd?: string) => resolveDbPath("sessions.db", cwd)

const initializedSessionPaths = new Set<string>()

/**
 * Retry sinkron untuk blok setup schema di `open()`.
 *
 * Ditemukan oleh test baseline Phase 0: `open()` menjalankan
 * `CREATE TABLE IF NOT EXISTS` TANPA pagar retry, padahal `busy_timeout` sudah
 * diset. Akibatnya satu penulis yang lock-nya ditahan membuat PEMBUKA DB
 * melempar SQLITE_BUSY — dan itu terjadi SEBELUM `withBusyRetry` di
 * `appendPresentationEvents` sempat dipanggil. Jadi jalur retry yang ada tidak
 * pernah menyelamatkan operasi yang paling butuh: DB-nya sendiri belum siap.
 *
 * `withBusyRetry` (async) tidak bisa dipakai di sini karena `open()` sinkron
 * dan dipanggil dari jalur sinkron (`loadSession`, `listSessions`, dst).
 */
export function withBusyRetrySync<T>(fn: () => T, attempts = 3): T | null {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) throw e
      last = e
      // Backoff sinkron pendek. Total ≤ 175ms; cukup untuk lock yang datang
      // dari proses lain yang sedang commit, dan jauh di bawah budget startup.
      Bun.sleepSync(25 * 2 ** i)
    }
  }
  process.stderr.write(
    `[warn] persistence: schema setup gave up after ${attempts} attempts: ${String((last as Error)?.message ?? last)}\n`,
  )
  return null
}

function open(cwd?: string): Database {
  const p = dbPath(cwd)
  const db = new Database(p)
  // busy_timeout DULU, sebelum statement apa pun yang butuh lock (audit #09
  // P1 §27: dua proses membuka DB bersamaan → PRAGMA journal_mode balapan →
  // SQLITE_BUSY padahal timeout 3000ms belum aktif — reproducer: 2×
  // loadSession konkuren lintas proses, satu gagal). Set pragma tak butuh
  // lock data sehingga aman duluan.
  try {
    db.exec(`PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}`)
  } catch {}
  if (!initializedSessionPaths.has(p)) {
    // journal_size_limit + wal_autocheckpoint: WAL tidak tumbuh tak terbatas.
    // Bungkus try/catch DENGAN retry-next-open (audit 2026-09-16): di Windows,
    // lock AV/file sesaat saat dua proses membuka bersamaan membuat setup WAL
    // gagal SQLITE_IOERR_TRUNCATE — crash di sini mematikan SELURUH operasi
    // sesi padahal mode rollback-journal tetap bisa baca. Jangan tandai
    // initialized bila gagal agar open berikutnya mencoba lagi (mode WAL
    // persisten di berkas DB, jadi sekali sukses berlaku untuk semua handle).
    try {
      db.exec(
        `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=${LIMITS.SQLITE_WAL_SIZE_LIMIT_BYTES}; PRAGMA wal_autocheckpoint=${LIMITS.SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
      )
      initializedSessionPaths.add(p)
    } catch (e) {
      process.stderr.write(
        `[warn] persistence: wal setup deferred, retry next open: ${(e as Error).message}\n`,
      )
    }
    // File DB dibuat dengan 644 default; ubah ke 600 agar history tidak world-readable
    try {
      const { chmodSync } = require("node:fs") as typeof import("node:fs")
      chmodSync(p, 0o600)
      // WAL/SHM akan dibuat dengan mode yang sama pada checkpoint berikutnya
    } catch {}
  }
  // DDL setup: `CREATE TABLE IF NOT EXISTS` butuh lock tulis bila tabel belum
  // ada. Tanpa retry di sini, DB yang sedang dikunci proses lain membuat
  // SETIAP operasi sesi gagal seketika. `null` = gagal terus; pemanggil akan
  // gagal di statement berikutnya dengan pesan yang lebih jelas.
  withBusyRetrySync(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER, cwd TEXT, system TEXT);
    CREATE TABLE IF NOT EXISTS messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, reasoning TEXT, is_error INTEGER, ts INTEGER, PRIMARY KEY(session_id, seq));
    CREATE TABLE IF NOT EXISTS turns (session_id TEXT, turn_idx INTEGER, usage TEXT, ts INTEGER, PRIMARY KEY(session_id, turn_idx));
    CREATE TABLE IF NOT EXISTS presentation_events (
      session_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      turn_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(session_id, event_seq)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_presentation_events_session ON presentation_events(session_id, event_seq);
  `)
  })
  // migration: add updated_at, toolCallId, name jika kolom lama (backward-compat)
  try {
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
    if (!cols.some((c) => c.name === "updated_at")) {
      db.exec("ALTER TABLE sessions ADD COLUMN updated_at INTEGER")
      db.exec("UPDATE sessions SET updated_at = created_at WHERE updated_at IS NULL")
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)`)
  } catch (e) {
    process.stderr.write(
      `[warn] persistence: sessions migration skipped: ${(e as Error).message}\n`,
    )
  }
  try {
    const msgCols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
    if (!msgCols.some((c) => c.name === "toolCallId")) {
      db.exec("ALTER TABLE messages ADD COLUMN toolCallId TEXT")
      db.exec("ALTER TABLE messages ADD COLUMN name TEXT")
    }
    // Fidelity resume: `reasoning` (thinking DeepSeek-style) dan `is_error`
    // (tool gagal) adalah bagian dari kernel Message dan ikut dibawa ke
    // history, tapi kolomnya tak pernah ada — resume lama sewajarnya buta dan
    // model kehilangan konteks kegagalannya. Additive, jadi DB lama tetap
    // terbaca dan turn lama (tanpa kolom ini) tetap resume dengan isError
    // diperlakukan absen.
    if (!msgCols.some((c) => c.name === "reasoning")) {
      db.exec("ALTER TABLE messages ADD COLUMN reasoning TEXT")
    }
    if (!msgCols.some((c) => c.name === "is_error")) {
      db.exec("ALTER TABLE messages ADD COLUMN is_error INTEGER")
    }
  } catch (e) {
    process.stderr.write(
      `[warn] persistence: messages migration skipped: ${(e as Error).message}\n`,
    )
  }
  return db
}

// JSON-safe serialization: konten binary (Uint8Array) jangan di-stringify jadi
// array ribuan angka — cukup placeholder agar DB tidak menggembung.
function safeContent(value: unknown): string {
  if (value instanceof Uint8Array) return `[binary: ${value.length} bytes]`
  if (Array.isArray(value)) {
    for (const p of value) {
      if (p instanceof Uint8Array) return `[binary: ${value.length} parts]`
      if (p && typeof p === "object" && (p as { data?: unknown }).data instanceof Uint8Array) {
        return `[binary: ${value.length} parts (image)]`
      }
    }
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const MAX_STORED_EVENT_CHARS = 200_000
const MAX_STORED_STRING_CHARS = 32_000

function stripAnsi(value: string): string {
  let out = ""
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 27) {
      const next = value[i + 1]
      if (next === "[") {
        i += 2
        while (i < value.length) {
          const current = value.charCodeAt(i)
          if (current >= 0x40 && current <= 0x7e) break
          i++
        }
        continue
      }
      if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
        i += 2
        while (i < value.length) {
          if (value.charCodeAt(i) === 7) break
          if (value.charCodeAt(i) === 27 && value[i + 1] === "\\") {
            i++
            break
          }
          i++
        }
        continue
      }
      continue
    }
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) continue
    out += value[i]
  }
  return out
}

function scrubStoredValue(value: unknown): unknown {
  if (typeof value === "string") {
    const clean = stripAnsi(scrubSecrets(value))
    return clean.length > MAX_STORED_STRING_CHARS
      ? `${clean.slice(0, MAX_STORED_STRING_CHARS)}…[truncated]`
      : clean
  }
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => scrubStoredValue(item))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubStoredValue(item)
    }
    return out
  }
  return value
}

function encodePresentationEvent(event: DomainEvent): string {
  const value = scrubStoredValue(event) as Record<string, unknown>
  let encoded = JSON.stringify(value)
  if (encoded.length > MAX_STORED_EVENT_CHARS) {
    for (const key of ["message", "summary", "action", "cause", "text", "content"]) {
      if (typeof value[key] === "string")
        value[key] = `[omitted: ${String(value[key]).length} chars]`
    }
    encoded = JSON.stringify(value)
  }
  if (encoded.length > MAX_STORED_EVENT_CHARS) {
    encoded = JSON.stringify({
      eventSeq: event.eventSeq,
      ts: event.ts,
      sessionId: event.sessionId,
      turnId: event.turnId,
      type: event.type,
      truncated: true,
    })
  }
  return encoded
}

function rebasePresentationPayload(payload: string, from: string, to: string): string {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>
    if (value.sessionId === from) value.sessionId = to
    return JSON.stringify(value)
  } catch {
    return payload
  }
}

/**
 * Bentuk minimum tiap tipe event durable. N4.
 *
 * Sebelumnya `decodePresentationEvent` hanya memeriksa enam field skalar lalu
 * `return value as DomainEvent` — blind cast. Akibatnya event yang lolos
 * validasi tapi bentuknya salah (payload terpotong oleh
 * `encodePresentationEvent`, atau baris yang ditulis proses versi lain) tetap
 * masuk ke `reduce`, dan `reduce` yang membaca field yang tidak ada melempar
 * TypeError. Satu event rusak itu menghapus SELURUH presentation state sesi,
 * karena `setup.ts` menangkap lemparannya di sekitar `rebuildFromDurable`.
 *
 * Aturan: lebih baik membuang satu event daripada kehilangan seluruh state.
 * Pembuangan tidak senyap — `loadPresentationEventsWithStats` menghitungnya.
 */
function isValidPlanStep(s: unknown): boolean {
  if (!s || typeof s !== "object") return false
  const step = s as { stepId?: unknown; status?: unknown }
  if (typeof step.stepId !== "string") return false
  return PLAN_STEP_STATUSES.has(step.status as string)
}

const PLAN_STEP_STATUSES = new Set(["pending", "active", "completed", "cancelled", "blocked"])
const PLAN_STATUSES = new Set(["open", "completed", "cancelled"])

function isValidEventShape(value: Record<string, unknown>): boolean {
  const isStr = (k: string): boolean => typeof value[k] === "string"
  const isNum = (k: string): boolean => typeof value[k] === "number"
  const isArr = (k: string): boolean => Array.isArray(value[k])
  switch (value.type) {
    case "plan.updated":
      return (
        isStr("planId") &&
        PLAN_STATUSES.has(value.status as string) &&
        isArr("steps") &&
        (value.steps as unknown[]).every(isValidPlanStep)
      )
    case "tool.started":
      return isStr("toolCallId") && isNum("stepId") && !!value.identity && !!value.argsSummary
    case "tool.progress":
    case "tool.completed":
    case "tool.failed":
    case "tool.denied":
    case "tool.cancelled":
    case "file.changed":
      return isStr("toolCallId") || isArr("paths")
    case "turn.completed":
      return !!value.summary
    case "turn.failed":
    case "turn.cancelled":
    case "user.message":
    case "turn.started":
    case "checkpoint.created":
      return true
    case "model.delta":
    case "reasoning.delta":
      return isStr("delta")
    case "model.completed":
    case "reasoning.completed":
      return isStr("text")
    case "approval.requested":
      return isStr("approvalId")
    case "approval.settled":
      return isStr("approvalId") && !!value.outcome
    case "test.completed":
      return isNum("passed") && isNum("failed")
    case "context.compacted":
      return isStr("reason")
    case "finding.detected":
      return isStr("findingId") && isStr("category")
    case "result.produced":
      return isStr("resultId") && !!value.status
    case "diagnostic.raised":
      return isStr("category") && isStr("message")
    default:
      return true
  }
}

function decodePresentationEvent(payload: string): DomainEvent | null {
  try {
    const value = JSON.parse(payload) as Partial<DomainEvent>
    if (
      typeof value !== "object" ||
      value === null ||
      typeof value.type !== "string" ||
      !DURABILITY[value.type]?.durable ||
      typeof value.eventSeq !== "number" ||
      typeof value.ts !== "number" ||
      typeof value.sessionId !== "string" ||
      typeof value.turnId !== "number"
    )
      return null
    // Stub hasil truncate (`encodePresentationEvent`) hanya punya Base +
    // `truncated`. Tolak eksplisit supaya tidak pernah sampai ke `reduce`.
    if ((value as { truncated?: unknown }).truncated === true) return null
    if (!isValidEventShape(value as unknown as Record<string, unknown>)) return null
    return value as DomainEvent
  } catch {
    return null
  }
}

export interface PresentationEventLoad {
  events: DomainEvent[]
  /** Baris yang dibuang `decodePresentationEvent`. N4: tidak boleh senyap. */
  rejected: number
}

export function loadPresentationEventsWithStats(id: string, cwd?: string): PresentationEventLoad {
  const db = open(cwd)
  try {
    const rows = db
      .prepare("SELECT payload FROM presentation_events WHERE session_id = ? ORDER BY event_seq")
      .all(id) as { payload: string }[]
    const events: DomainEvent[] = []
    let rejected = 0
    for (const row of rows) {
      const event = decodePresentationEvent(row.payload)
      if (event) events.push(event)
      else rejected++
    }
    return { events, rejected }
  } finally {
    db.close()
  }
}

export function loadPresentationEvents(id: string, cwd?: string): DomainEvent[] {
  return loadPresentationEventsWithStats(id, cwd).events
}

export async function appendPresentationEvents(
  id: string,
  cwd: string | undefined,
  events: readonly DomainEvent[],
): Promise<void> {
  const durable = events.filter((event) => DURABILITY[event.type]?.durable)
  if (durable.length === 0) return
  const db = open(cwd)
  const txn = db.transaction(() => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO presentation_events (session_id, event_seq, type, turn_id, ts, payload) VALUES (?, ?, ?, ?, ?, ?)",
    )
    for (const event of durable) {
      insert.run(
        id,
        event.eventSeq,
        event.type,
        event.turnId,
        event.ts,
        encodePresentationEvent(event),
      )
    }
  })
  try {
    await withBusyRetry(() => txn())
  } finally {
    db.close()
  }
}

// SQLITE_BUSY / database-is-locked bisa muncul saat Pool(3) sub-agent menulis
// bersamaan meski WAL+busy_timeout aktif (terutama Windows). Retry singkat
// P0.2: async + Bun.sleep agar tidak block event-loop (sebelumnya Atomics.wait freeze 175ms).
//
// Diekspor (seam aditif, bukan refactor) supaya jalur retry bisa diuji langsung.
// Sebelum ini tidak ada satu pun test yang menyuntik SQLITE_BUSY, sehingga
// "retry bekerja" adalah klaim tanpa bukti.
export async function withBusyRetry<T>(fn: () => T, attempts = 3): Promise<T> {
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

export async function saveSession(
  id: string,
  cwd: string | undefined,
  system: string | undefined,
  messages: readonly unknown[],
  usage: unknown,
) {
  const db = open(cwd)
  const now = Date.now()
  const txn = db.transaction(() => {
    const existing = db
      .prepare("SELECT created_at, updated_at FROM sessions WHERE id = ?")
      .get(id) as { created_at: number; updated_at: number | null } | null
    const createdAt = existing?.created_at ?? now
    db.prepare(
      "INSERT OR REPLACE INTO sessions (id, created_at, updated_at, cwd, system) VALUES (?, ?, ?, ?, ?)",
    ).run(id, createdAt, now, cwd ?? "", system ?? "")
    const ins = db.prepare(
      "INSERT INTO messages (session_id, seq, role, content, toolCalls, toolCallId, name, reasoning, is_error, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    type StoredMsg = {
      role: string
      content: unknown
      toolCalls?: unknown
      toolCallId?: string
      name?: string
      reasoning?: string
      isError?: boolean
    }
    type Norm = [string, string, string, string | null, string | null, string | null, number]
    const norm = (m: StoredMsg): Norm => [
      m.role,
      safeContent(m.content),
      safeContent(m.toolCalls ?? null),
      (m.toolCallId ?? null) as string | null,
      (m.name ?? null) as string | null,
      // reasoning & is_error WAJIB ikut prefix comparison di bawah. Kalau tidak,
      // perubahan HANYA pada kedua field itu dianggap "tak berubah" dan
      // incremental append melewatkannya — persis kelas bug F-05.
      typeof m.reasoning === "string" ? safeContent(m.reasoning) : null,
      m.isError === true ? 1 : 0,
    ]
    // F-05: JANGAN pakai messages.length sebagai proksi perubahan. Kompaksi
    // (atau replace apa pun) bisa mengganti N pesan dengan N pesan BERBEDA —
    // panjang sama, isi beda. Tanpa verifikasi prefix, tulis dilewat dan
    // resume memuat sejarah basi. Bandingkan prefix tersimpan dengan incoming:
    // sama persis = re-save (bukan turn baru, jaga guard anti turn-hantu);
    // prefix sama + tumbuh = append; selain itu = rewrite penuh.
    const stored = db
      .prepare(
        "SELECT seq, role, content, toolCalls, toolCallId, name, reasoning, is_error FROM messages WHERE session_id = ? ORDER BY seq",
      )
      .all(id) as {
      seq: number
      role: string
      content: string
      toolCalls: string
      toolCallId: string | null
      name: string | null
      reasoning: string | null
      is_error: number | null
    }[]
    const known = stored.length
    let prefixSame = stored.length <= messages.length
    if (prefixSame) {
      for (let i = 0; i < stored.length; i++) {
        const want = norm(messages[i] as StoredMsg)
        const got = stored[i]!
        if (
          got.seq !== i ||
          got.role !== want[0] ||
          got.content !== want[1] ||
          got.toolCalls !== want[2] ||
          (got.toolCallId ?? null) !== want[3] ||
          (got.name ?? null) !== want[4] ||
          (got.reasoning ?? null) !== want[5] ||
          (got.is_error ?? 0) !== want[6]
        ) {
          prefixSame = false
          break
        }
      }
    }
    const changed = !prefixSame || stored.length !== messages.length
    if (changed && prefixSame) {
      // incremental append-only: cukup insert pesan baru (umumnya 1 turn)
      for (let i = known; i < messages.length; i++) {
        const m = messages[i] as StoredMsg
        const w = norm(m)
        ins.run(id, i, w[0], w[1], w[2], w[3], w[4], w[5], w[6], now)
      }
    } else if (changed) {
      // history menyusut (compaction/reset) ATAU prefix berubah dengan panjang
      // sama (kompaksi N→N) → tulis ulang penuh agar tidak ada pesan basi
      // yang tertinggal untuk resume
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(id)
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i] as StoredMsg
        const w = norm(m)
        ins.run(id, i, w[0], w[1], w[2], w[3], w[4], w[5], w[6], now)
      }
    }
    if (usage) {
      // Audit #08 P1 (§16): baris turns = turn SELESAI, bukan panggilan save.
      // Menyimpan ulang riwayat yang sama (retry/crash antara save dan
      // finalize) sebelumnya menambah turn_idx hantu — suppressor stitch
      // palsu di decideRecovery (turn yang tak pernah durable dikira ada).
      // Aturan: tumbuh (pesan baru), susut, atau isi berubah (rewrite
      // pasca-kompaksi) = turn terjadi; sama persis = re-save, bukan turn baru.
      if (changed) {
        const maxRow = db
          .prepare("SELECT MAX(turn_idx) as m FROM turns WHERE session_id = ?")
          .get(id) as { m: number | null } | null
        const nextIdx = (maxRow?.m ?? -1) + 1
        db.prepare("INSERT INTO turns (session_id, turn_idx, usage, ts) VALUES (?, ?, ?, ?)").run(
          id,
          nextIdx,
          JSON.stringify(usage),
          now,
        )
      }
    }
    // TTL: hapus sesi basi + orphan rows (best-effort; 0 = forever)
    try {
      purgeExpired(db, now)
    } catch (e) {
      process.stderr.write(`[warn] persistence: TTL purge failed: ${(e as Error).message}\n`)
    }
  })
  try {
    await withBusyRetry(() => txn())
  } finally {
    db.close()
  }
}

// TTL default 30 hari; MINICODE_SESSION_TTL_DAYS=0 = simpan selamanya.
export function getSessionTtlDays(): number {
  const raw = process.env.MINICODE_SESSION_TTL_DAYS
  if (raw == null || raw === "") return 30
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 30
}

export function purgeExpired(db: Database, now = Date.now()): number {
  const days = getSessionTtlDays()
  if (days <= 0) return 0
  const ttlMs = days * 24 * 60 * 60 * 1000
  const cutoff = now - ttlMs
  // [PHASE 6Q] F6. Collect the expiring ids BEFORE deleting anything, then run
  // each through the CANONICAL deletion operation.
  //
  // Previously this deleted `sessions` and cascaded over the session-side tables
  // but never touched `tasks.db`, so every TTL-purged session orphaned its task
  // rows AND their execution lineage - which, after 6P, would include durable
  // `execution_owner` markers pointing at generations that can never be
  // reconciled. `deleteSession` had the right behaviour (6K D4) and this did not;
  // two deletion architectures, one of them a bug.
  //
  // `purgeExpired` is SYNC, so the canonical operation is driven synchronously
  // here: the session-side deletes are the same statements, in one transaction,
  // in the same order, with the same "tasks first" residue - see
  // `deleteSessionCompletely` for the full ordering argument. It is shared rather
  // than duplicated for exactly that reason: 6O ADR-9's rule is ONE deletion
  // architecture, so the ordering cannot drift between these two entry points.
  const expiring = db
    .prepare(`SELECT id FROM sessions WHERE COALESCE(updated_at, created_at) < ?`)
    .all(cutoff) as { id: string }[]

  const { TaskStore } = require("../task/store.ts") as typeof import("../task/store.ts")
  const cwd = sessionCwdOf(db, expiring)
  const tasks = new TaskStore(cwd)
  for (const row of expiring) {
    // 1. invalidate in-flight executions, 2. remove task rows.
    tasks.bumpSessionIncarnation(row.id)
    tasks.deleteSessionTasks(row.id)
  }

  const gone = db
    .prepare("DELETE FROM sessions WHERE COALESCE(updated_at, created_at) < ?")
    .run(cutoff)
  db.prepare("DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)").run()
  db.prepare("DELETE FROM turns WHERE session_id NOT IN (SELECT id FROM sessions)").run()
  try {
    db.prepare(
      "DELETE FROM presentation_events WHERE session_id NOT IN (SELECT id FROM sessions)",
    ).run()
  } catch {}
  return gone.changes
}

/** The workspace directory recorded on the expiring sessions, for TaskStore. */
function sessionCwdOf(db: Database, rows: { id: string }[]): string | undefined {
  for (const r of rows) {
    const row = db.prepare("SELECT cwd FROM sessions WHERE id = ?").get(r.id) as
      | { cwd: string | null }
      | null
      | undefined
    if (row && row.cwd) return row.cwd
  }
  return undefined
}

function parseContent(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s // placeholder "[binary: N bytes]" atau data yang bukan JSON
  }
}

export function loadSession(
  id: string,
  cwd?: string,
): { messages: unknown[]; system?: string; cwd?: string; turnCount?: number } | null {
  const db = open(cwd)
  try {
    const sess = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as {
      system: string
      cwd: string
    } | null
    if (!sess) {
      return null
    }
    const rows = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY seq").all(id) as {
      role: string
      content: string
      toolCalls: string
      toolCallId: string | null
      name: string | null
      reasoning: string | null
      is_error: number | null
    }[]
    // `reasoning` ditulis lewat safeContent (JSON) supaya ikut scrub + cap
    // seperti `content`, jadi dibalik simetris di sini. String kosong
    // diperlakukan absen: menyetel `reasoning: ""` / `isError: false` di setiap
    // pesan akan mengubah bentuk pesan saat kernel membandingkan.
    const readReasoning = (raw: string | null): string | undefined => {
      if (!raw) return undefined
      const parsed = parseContent(raw)
      return typeof parsed === "string" && parsed.length > 0 ? parsed : undefined
    }
    const messages = rows.map((r) => {
      const reasoning = readReasoning(r.reasoning)
      return {
        role: r.role,
        content: parseContent(r.content),
        ...(r.toolCalls && r.toolCalls !== "null" ? { toolCalls: parseContent(r.toolCalls) } : {}),
        ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}),
        ...(r.name ? { name: r.name } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(r.is_error === 1 ? { isError: true } : {}),
      }
    })
    const turnRow = db
      .prepare("SELECT MAX(turn_idx) as m FROM turns WHERE session_id = ?")
      .get(id) as { m: number | null } | null
    const turnCount = turnRow?.m != null ? turnRow.m + 1 : 0
    return { messages, system: sess.system, cwd: sess.cwd, turnCount }
  } finally {
    db.close()
  }
}

export function listPersistedTurns(id: string, cwd?: string): number[] {
  // Turn durable untuk keputusan recovery journal (baca-saja, tanpa schema).
  const db = open(cwd)
  try {
    const rows = db
      .prepare("SELECT turn_idx as t FROM turns WHERE session_id = ? ORDER BY turn_idx")
      .all(id) as { t: number }[]
    return rows.map((r) => r.t)
  } finally {
    db.close()
  }
}

export function listSessions(
  cwd?: string,
): { id: string; created_at: number; updated_at?: number; cwd: string }[] {
  const db = open(cwd)
  try {
    const rows = db
      .prepare(
        "SELECT id, created_at, updated_at, cwd FROM sessions ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50",
      )
      .all() as { id: string; created_at: number; updated_at: number | null; cwd: string }[]
    return rows.map((r) => ({ ...r, updated_at: r.updated_at ?? r.created_at }))
  } finally {
    db.close()
  }
}

/**
 * [PHASE 6Q] THE CANONICAL SESSION DELETION OPERATION.
 *
 * 6N F6 found that there were two session-teardown paths and only one of them
 * cleaned up tasks: `deleteSession` did (6K D4) and `purgeExpired` did not, so a
 * TTL-purged session orphaned its task rows AND their execution lineage forever.
 * 6O ADR-9 concluded the second deletion architecture *is* the bug.
 *
 * This is the one operation. `deleteSession` and `purgeExpired` both call it.
 *
 * ORDERING, and why it is not negotiable:
 *
 *   1  bump the session incarnation   <- invalidate every in-flight execution
 *   2  delete TaskStore rows          <- tasks.db
 *   3  delete session-side rows       <- sessions.db
 *
 * Step 1 first is what closes 6N F2 across process boundaries: an execution that
 * is still running against this session id now finds a moved incarnation and its
 * completion is REFUSED, so it can never stamp a marker onto a session that has
 * been deleted - or onto a later RECREATION of the same id, whose task ids are
 * indistinguishable from the deleted ones.
 *
 * Steps 2 and 3 preserve the 6K conclusion verbatim: tasks first, because the two
 * failure residues are not symmetric. A task-delete failure leaves the session
 * visible and the deletion visibly incomplete, so it is retryable and nothing is
 * orphaned. A session-first failure would leave task rows that are still
 * EXECUTABLE with no session to reconcile them - the dangerous residue.
 *
 * NOT ATOMIC, and deliberately not pretending to be: `tasks.db` and `sessions.db`
 * are separate persistence domains and no transaction spans them. The requirement
 * is not imaginary atomicity but that every reachable partial state is safe,
 * visible and retryable. Those residues are:
 *
 *   fail at 1  -> nothing deleted; the session is intact and still usable. Safe.
 *   fail at 2  -> incarnation already moved, so any in-flight execution is
 *                 already invalidated; task rows remain but the session is still
 *                 there. Visible, retryable, and NOT executable by a stale claim.
 *   fail at 3  -> tasks are gone (so nothing executable survives), session rows
 *                 remain. Visible, retryable, no autonomous work can exist.
 *
 * IDEMPOTENT: every step is safe to repeat, and repeating advances the
 * incarnation again, which can only ever invalidate MORE stale executions.
 */
async function deleteSessionCompletely(id: string, cwd?: string): Promise<void> {
  const { TaskStore } = await import("../task/store.ts")
  const tasks = new TaskStore(cwd)

  // 1. Invalidate in-flight executions BEFORE removing anything they could write.
  tasks.bumpSessionIncarnation(id)
  // [PHASE 6U] Tell live local executions to STOP, before their rows disappear.
  //
  // [DESIGN DECISION] The incarnation bump above is the AUTHORITATIVE barrier: it
  // is durable, cross-process, and nothing can write after it. This notification
  // is strictly an OPTIMISATION layered in front of it — it makes a running
  // autonomous turn stop now instead of running to completion against a session
  // that no longer exists.
  //
  // Ordering is deliberate and matches 6Q's: invalidate durably FIRST, then
  // signal, then delete. A subscriber that somehow still writes is refused by the
  // bump regardless of what this notification did, so a broken subscriber cannot
  // turn into a resurrected session.
  const { notifySessionInvalidated } = await import("../task/session-ownership.ts")
  notifySessionInvalidated(id)

  // 2. TaskStore rows, NOT best-effort, and still first among the deletions.
  try {
    tasks.deleteSessionTasks(id)
  } catch (e) {
    throw new Error(
      `deleteSession: task store cleanup failed for ${id}; session state left intact so the delete can be retried: ${(e as Error).message}`,
    )
  }
  // 3. Session-side rows.
  const db = open(cwd)
  const txn = db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(id)
    db.prepare("DELETE FROM turns WHERE session_id = ?").run(id)
    db.prepare("DELETE FROM presentation_events WHERE session_id = ?").run(id)
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id)
  })
  try {
    await withBusyRetry(() => txn())
  } finally {
    db.close()
  }
}

export async function deleteSession(id: string, cwd?: string) {
  // [PHASE 6K] TaskStore rows FIRST, and NOT best-effort.
  //
  // Phase 6J (D4, HIGH): this function deleted session-side state and never
  // touched `tasks.db` at all - `deleteTask`/`deleteSessionTasks` had zero
  // production callers. Deleting a session and recreating it with the same id
  // therefore resurrected the old task rows *with their execution lineage*, and
  // a Scheduler on the recreated session dispatched that deleted work.
  //
  // ORDERING (6K §8, two databases, so NOT atomic): tasks are removed BEFORE
  // session-side state. The two stores are separate files, so no single
  // transaction spans them. The ordering is chosen because the two possible
  // residues are not symmetric:
  //
  //   task delete fails first -> the session still exists, so the delete is
  //                              visibly incomplete and retryable, and nothing
  //                              is orphaned. BENIGN.
  //   session delete fails after -> the session exists with no tasks. Also
  //                              benign: a retry is a no-op for tasks and then
  //                              completes the session delete. CONVERGES.
  //
  // The reverse order would produce the dangerous residue (tasks surviving a
  // deleted session) on the first failure. That is why tasks go first.
  //
  // It is NOT swallowed: if task deletion fails we deliberately leave the
  // session intact and propagate, because continuing would delete the session
  // and leave exactly the executable orphans this fix exists to prevent.
  // [PHASE 6Q] The canonical operation owns the incarnation bump + TaskStore
  // cleanup + session-row deletion, so this function cannot drift from the
  // ordering or the failure semantics proved there. This replaces the inline
  // TaskStore block that 6K added.
  await deleteSessionCompletely(id, cwd)
  // Lifecycle: jurnal ikut hapus sesi (best-effort; tak boleh gagalkan hapus).
  try {
    const { deleteJournalFile } = await import("./journal.ts")
    deleteJournalFile(id, cwd)
  } catch {}
  // P0-3 #10: manifes checkpoint ikut hapus sesi — sesi yang dihapus lalu
  // dibuat ulang dengan id sama tak boleh mewarisi pointer basi. Best-effort.
  try {
    const { sanitizeSessionId } = await import("./checkpoint.ts")
    const { rm } = await import("node:fs/promises")
    const { resolve: resolvePath, join: joinPath } = await import("node:path")
    const { assertDeletableTarget } = await import("../lib/safe-open.ts")
    const base = resolvePath(cwd ?? process.cwd())
    const cpDir = joinPath(base, ".minicode", "checkpoints", sanitizeSessionId(id))
    // Gerbang fail-closed (Fase 0A): hapus hanya terbukti anak dari `base`.
    // Jalur ini best-effort, jadi kegagalan gerbang = LEWATI, bukan lempar keluar.
    const safeCp = await assertDeletableTarget(
      cpDir,
      { root: base, tempScoped: false },
      { recursive: true },
    ).catch(() => null)
    if (safeCp) await rm(safeCp, { recursive: true, force: true }).catch(() => {})
  } catch {}
  // Audit #10 §17: ref shadow-git (`refs/minicode/<sesi>/*`) menunjuk tree
  // berisi ISI file saat snapshot — tanpa prune, konten sesi yang dihapus
  // tetap reachable via `git cat-file`. pruneSessionRefs sudah ada & teruji,
  // tetapi tak pernah dipanggil dari sini (jalur cleanup mati). Best-effort.
  try {
    const { pruneSessionRefs } = await import("./shadow-git.ts")
    await pruneSessionRefs(cwd ?? process.cwd(), id).catch(() => {})
  } catch {}
  // Audit #10 §17: traces.jsonl/step-traces.jsonl adalah berkas bersama
  // per-workspace — baris sesi yang dihapus bertahan sebagai residual
  // (prompt/args/error mentah masih terbaca pasca-delete). Purge baris milik
  // sesi ini saja; sesi lain tak tersentuh. Best-effort.
  try {
    const { purgeSessionTraces } = await import("../telemetry/trace.ts")
    await purgeSessionTraces(id, cwd).catch(() => {})
  } catch {}
  // Audit #13 chain 28: daftar todo + snapshot rencana adalah state milik
  // sesi — tanpa purge, isi rencana (bisa memuat secret/path kerja) bertahan
  // sebagai residual reachable pasca-delete. Best-effort.
  try {
    const { deleteTodoFiles } = await import("../tools/todo.ts")
    await deleteTodoFiles(id, cwd ?? process.cwd()).catch(() => {})
  } catch {}
}

// P13 P1 — branch: fork sesi (history + turns) ke id baru tanpa menyentuh
// sumber. Butuh untuk "coba dua arah dari titik yang sama" — tanpa ini user
// harus mengulang seluruh percakapan untuk eksplorasi alternatif.
export async function branchSession(srcId: string, dstId: string, cwd?: string): Promise<number> {
  if (!dstId || !/^[\w.-]{1,64}$/.test(dstId)) throw new Error("invalid branch session id")
  const db = open(cwd)
  const now = Date.now()
  let copied = 0
  const txn = db.transaction(() => {
    const src = db.prepare("SELECT cwd, system FROM sessions WHERE id = ?").get(srcId) as {
      cwd: string
      system: string
    } | null
    if (!src) throw new Error(`session not found: ${srcId}`)
    db.prepare(
      "INSERT OR REPLACE INTO sessions (id, created_at, updated_at, cwd, system) VALUES (?, ?, ?, ?, ?)",
    ).run(dstId, now, now, src.cwd, src.system)
    const rows = db
      .prepare(
        "SELECT seq, role, content, toolCalls, toolCallId, name, ts FROM messages WHERE session_id = ? ORDER BY seq",
      )
      .all(srcId) as {
      seq: number
      role: string
      content: string
      toolCalls: string
      toolCallId: string | null
      name: string | null
      ts: number
    }[]
    const ins = db.prepare(
      "INSERT INTO messages (session_id, seq, role, content, toolCalls, toolCallId, name, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    for (const r of rows) {
      ins.run(dstId, r.seq, r.role, r.content, r.toolCalls, r.toolCallId, r.name, r.ts)
    }
    copied = rows.length
    const turns = db
      .prepare("SELECT turn_idx, usage, ts FROM turns WHERE session_id = ? ORDER BY turn_idx")
      .all(srcId) as { turn_idx: number; usage: string; ts: number }[]
    const insT = db.prepare(
      "INSERT INTO turns (session_id, turn_idx, usage, ts) VALUES (?, ?, ?, ?)",
    )
    for (const t of turns) insT.run(dstId, t.turn_idx, t.usage, t.ts)
    const events = db
      .prepare(
        "SELECT event_seq, type, turn_id, ts, payload FROM presentation_events WHERE session_id = ? ORDER BY event_seq",
      )
      .all(srcId) as {
      event_seq: number
      type: string
      turn_id: number
      ts: number
      payload: string
    }[]
    const insE = db.prepare(
      "INSERT OR IGNORE INTO presentation_events (session_id, event_seq, type, turn_id, ts, payload) VALUES (?, ?, ?, ?, ?, ?)",
    )
    for (const event of events) {
      insE.run(
        dstId,
        event.event_seq,
        event.type,
        event.turn_id,
        event.ts,
        rebasePresentationPayload(event.payload, srcId, dstId),
      )
    }
  })
  try {
    await withBusyRetry(() => txn())
  } finally {
    db.close()
  }
  return copied
}
