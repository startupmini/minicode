import { Database } from "bun:sqlite"
import { LIMITS } from "../constants.ts"
import { resolveDbPath } from "../lib/db-path.ts"

const dbPath = (cwd?: string) => resolveDbPath("sessions.db", cwd)

const initializedSessionPaths = new Set<string>()

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER, cwd TEXT, system TEXT);
    CREATE TABLE IF NOT EXISTS messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, ts INTEGER, PRIMARY KEY(session_id, seq));
    CREATE TABLE IF NOT EXISTS turns (session_id TEXT, turn_idx INTEGER, usage TEXT, ts INTEGER, PRIMARY KEY(session_id, turn_idx));
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
  `)
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

// SQLITE_BUSY / database-is-locked bisa muncul saat Pool(3) sub-agent menulis
// bersamaan meski WAL+busy_timeout aktif (terutama Windows). Retry singkat
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
      "INSERT INTO messages (session_id, seq, role, content, toolCalls, toolCallId, name, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    const known =
      (
        db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(id) as {
          c: number
        } | null
      )?.c ?? 0
    if (messages.length >= known) {
      // incremental append-only: cukup insert pesan baru (umumnya 1 turn)
      for (let i = known; i < messages.length; i++) {
        const m = messages[i] as {
          role: string
          content: unknown
          toolCalls?: unknown
          toolCallId?: string
          name?: string
        }
        ins.run(
          id,
          i,
          m.role,
          safeContent(m.content),
          safeContent(m.toolCalls ?? null),
          m.toolCallId ?? null,
          m.name ?? null,
          now,
        )
      }
    } else {
      // history menyusut (compaction/reset) → tulis ulang penuh agar tidak ada
      // pesan basi yang tertinggal untuk resume
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(id)
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i] as {
          role: string
          content: unknown
          toolCalls?: unknown
          toolCallId?: string
          name?: string
        }
        ins.run(
          id,
          i,
          m.role,
          safeContent(m.content),
          safeContent(m.toolCalls ?? null),
          m.toolCallId ?? null,
          m.name ?? null,
          now,
        )
      }
    }
    if (usage) {
      // Audit #08 P1 (§16): baris turns = turn SELESAI, bukan panggilan save.
      // Menyimpan ulang riwayat yang sama (retry/crash antara save dan
      // finalize) sebelumnya menambah turn_idx hantu — suppressor stitch
      // palsu di decideRecovery (turn yang tak pernah durable dikira ada).
      // Aturan: tumbuh (pesan baru) atau susut (rewrite pasca-kompaksi) =
      // turn terjadi; sama persis = re-save, bukan turn baru.
      if (messages.length !== known) {
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
  const gone = db
    .prepare("DELETE FROM sessions WHERE COALESCE(updated_at, created_at) < ?")
    .run(cutoff)
  db.prepare("DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)").run()
  db.prepare("DELETE FROM turns WHERE session_id NOT IN (SELECT id FROM sessions)").run()
  return gone.changes
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
    }[]
    const messages = rows.map((r) => ({
      role: r.role,
      content: parseContent(r.content),
      ...(r.toolCalls && r.toolCalls !== "null" ? { toolCalls: parseContent(r.toolCalls) } : {}),
      ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}),
      ...(r.name ? { name: r.name } : {}),
    }))
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

export async function deleteSession(id: string, cwd?: string) {
  const db = open(cwd)
  const txn = db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(id)
    db.prepare("DELETE FROM turns WHERE session_id = ?").run(id)
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id)
  })
  try {
    await withBusyRetry(() => txn())
  } finally {
    db.close()
  }
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
    await rm(
      joinPath(
        resolvePath(cwd ?? process.cwd()),
        ".minicode",
        "checkpoints",
        sanitizeSessionId(id),
      ),
      {
        recursive: true,
        force: true,
      },
    ).catch(() => {})
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
  })
  try {
    await withBusyRetry(() => txn())
  } finally {
    db.close()
  }
  return copied
}
