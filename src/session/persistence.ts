import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { LIMITS } from "../constants.ts"
import { resolveDbPath, resolveLocalDbPath } from "../lib/db-path.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import { type DomainEvent, DURABILITY } from "../presentation/events.ts"

// `local=true` = SELALU `<cwd>/.minicode/sessions.db`, tanpa fallback ke
// `~/.minicode` global. Fallback global itu benar untuk histori lintas-repo,
// tetapi salah untuk state per-workspace (offset konsumen & persetujuan
// daemon): proyek A yang "melanjutkan" dari progres proyek B adalah bocoran
// scope yang tak pernah bisa dilihat pemakai.
const dbPath = (cwd?: string, local = false) =>
  local ? resolveLocalDbPath("sessions.db", cwd) : resolveDbPath("sessions.db", cwd)

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

function open(cwd?: string, local = false): Database {
  const p = dbPath(cwd, local)
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
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER, cwd TEXT, system TEXT, writer_epoch INTEGER NOT NULL DEFAULT 0, default_thread_id TEXT NULL);
    CREATE TABLE IF NOT EXISTS messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, reasoning TEXT, is_error INTEGER, ts INTEGER, thread_id TEXT NULL, event_id TEXT NULL, run_id TEXT NULL, migrated INTEGER NOT NULL DEFAULT 0, migrated_compacted INTEGER NOT NULL DEFAULT 0, projection_note TEXT NULL, PRIMARY KEY(session_id, seq));
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
    // P2.9 — lineage Sub-Agent. Aditif + idempoten. NULL = sesi root (parent
    // ATAU anak legasi pra-P2.9). Sesi anak MEILIKI baris sessions sendiri;
    // ini yang menutup cacat namespace hantu (presentation_events.session_id
    // menunjuk id tanpa baris sessions → dihapus orphan-purge).
    if (!cols.some((c) => c.name === "parent_session_id")) {
      db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT NULL")
    }
    if (!cols.some((c) => c.name === "parent_run_id")) {
      db.exec("ALTER TABLE sessions ADD COLUMN parent_run_id TEXT NULL")
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)`)
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
  // P2.1 — peta alias identitas sesi: alias (input mentah eksak) → kanonik.
  // Additive: DB lama mendapat tabel kosong; tak ada baris lama yang berubah.
  // `alias` = input mentah persis (bukan hasil sanitasi) agar tabrakan
  // sanitizer (`a/b` vs `a-b`) tetap terbedakan; `fs_key` = bentuk kanonik
  // untuk deteksi tabrakan kunci filesystem.
  withBusyRetrySync(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS session_aliases (alias TEXT PRIMARY KEY, fs_key TEXT NOT NULL, canonical TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_session_aliases_fs ON session_aliases(fs_key);
    CREATE INDEX IF NOT EXISTS idx_session_aliases_canonical ON session_aliases(canonical);
  `)
  })
  // P2.2 — pagar penulis (writer fence): generasi otoritas penulis dalam
  // satu generasi identitas sesi. BEDA dari inkarnasi TaskStore (generasi
  // identitas lintas delete/recreate): epoch hanya maju lewat takeover dan
  // tak pernah diubah save biasa. Baris lama → 0 (deterministik).
  // P2.3 — slot default_thread_id (nullable transisional; P2.4 menegakkan
  // invariant) + kolom dorman messages (NULL/0 = legacy tak-berskala;
  // P2.4 backfill, P2.5 alokator + UNIQUE event_id via index).
  try {
    const sessCols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
    if (!sessCols.some((c) => c.name === "writer_epoch")) {
      db.exec("ALTER TABLE sessions ADD COLUMN writer_epoch INTEGER NOT NULL DEFAULT 0")
    }
    if (!sessCols.some((c) => c.name === "default_thread_id")) {
      db.exec("ALTER TABLE sessions ADD COLUMN default_thread_id TEXT NULL")
    }
    const msgCols2 = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
    const addMsgCol = (name: string, ddl: string): void => {
      if (!msgCols2.some((c) => c.name === name)) db.exec(`ALTER TABLE messages ADD COLUMN ${ddl}`)
    }
    addMsgCol("thread_id", "thread_id TEXT NULL")
    addMsgCol("event_id", "event_id TEXT NULL")
    addMsgCol("run_id", "run_id TEXT NULL")
    addMsgCol("migrated", "migrated INTEGER NOT NULL DEFAULT 0")
    addMsgCol("migrated_compacted", "migrated_compacted INTEGER NOT NULL DEFAULT 0")
    addMsgCol("projection_note", "projection_note TEXT NULL")
    // P2.6: takeover_epoch untuk runs (NULL = pra-P2.6; diisi saat create).
    try {
      const runCols = db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]
      if (runCols.length > 0 && !runCols.some((c) => c.name === "takeover_epoch")) {
        db.exec("ALTER TABLE runs ADD COLUMN takeover_epoch INTEGER NULL")
      }
    } catch {
      // Tabel absen (handle mentah) atau gagal — CREATE di atas yang berlaku.
    }
    // P2.7: anchor_event_id untuk history_projections (NULL = pra-P2.7 atau
    // cakupan kosong; diisi saat build bila base_seq > 0). Aditif idempoten
    // seperti kolom di atas; baris lama (bila ada) dipertahankan utuh.
    try {
      const projCols = db.prepare("PRAGMA table_info(history_projections)").all() as {
        name: string
      }[]
      if (projCols.length > 0 && !projCols.some((c) => c.name === "anchor_event_id")) {
        db.exec("ALTER TABLE history_projections ADD COLUMN anchor_event_id TEXT NULL")
      }
    } catch {
      // Tabel absen atau gagal — CREATE di bawah yang berlaku.
    }
    // Indeks di SINI (setelah ALTER): CREATE INDEX atas kolom yang belum ada
    // melempar di DB legacy bila dikerjakan sebelum migrasi kolom (temuan
    // P2.3: open() gagal total). Idempoten seperti indeks lain di atas.
    // P2.4 — identitas histori kanonik (session_id, thread_id, seq): UNIQUE
    // (menggantikan idx_messages_thread P2.3 yang salah-bentuk tanpa
    // session_id). NULL thread legacy dikecualikan SQLite secara alami.
    // P2.5 — keunikan event: UNIQUE(session_id, thread_id, event_id).
    // NULL dikecualikan (baris legacy pra-backfill tak pernah konflik);
    // komposit (bukan global) agar branch PRESERVE event_id tetap konsisten
    // (masa lalu bersama = id sama di sesi berbeda — analogi objek git).
    db.exec("DROP INDEX IF EXISTS idx_messages_thread")
    withBusyRetrySync(() => {
      db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS udx_messages_thread_seq ON messages(session_id, thread_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS udx_messages_event_id ON messages(session_id, thread_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
    `)
    })
  } catch (e) {
    process.stderr.write(
      `[warn] persistence: writer_epoch migration skipped: ${(e as Error).message}\n`,
    )
  }
  // P2.2 — rekaman takeover durable: SATU baris per (sesi, prior_epoch).
  // Keunikan inilah yang membuat takeover simultan punya tepat satu pemenang
  // (tanpa mengandalkan Date.now): pecundang menabrak constraint dan
  // mengamati hasil pemenang (idempoten), bukan menaikkan epoch lagi.
  withBusyRetrySync(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS session_takeovers (session_id TEXT NOT NULL, prior_epoch INTEGER NOT NULL, new_epoch INTEGER NOT NULL, reason TEXT NOT NULL, boot TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id, prior_epoch));
    CREATE INDEX IF NOT EXISTS idx_session_takeovers_session ON session_takeovers(session_id);
  `)
  })
  // P2.3 — kerangka penyimpanan (STORAGE ONLY, tanpa semantik aktif).
  // Ketiga tabel + kolom dorman di bawah TIDAK ditulis/dibaca runtime mana
  // pun di fase ini; P2.4 (Thread), P2.5 (Run/kursor), P2.7 (proyeksi) yang
  // mengaktifkannya. Konvensi migrasi = DDL idempoten di open() (tanpa
  // user_version: semua perubahan aditif; restart-safe via idempotence,
  // bukan via atomisitas DDL — SQLite men-commit tiap statement).
  // P2.4 — koreksi identitas Thread: komposit (session_id, thread_id).
  // Skema P2.3 memakai thread_id PK global (satu 'th_default' sedunia —
  // mustahil). Identitas kanonik menurut blueprint adalah pasangan
  // (session, thread); runs/projections sudah membawa session_id. Rebuild
  // HANYA bila bentuk lama terdeteksi (di bawah); AMAN karena tabel P2.3
  // dijamin kosong (guard netralitas + assert menolak bila ada baris —
  // tak pernah hapus data). Open berulang pada bentuk baru = no-op.
  if (threadsTableNeedsP24Rebuild(db)) {
    assertEmptyTableForRebuild(db, "threads")
    db.exec("DROP TABLE IF EXISTS threads")
  }
  if (projectionsTableNeedsP24Rebuild(db)) {
    assertEmptyTableForRebuild(db, "history_projections")
    db.exec("DROP TABLE IF EXISTS history_projections")
  }
  withBusyRetrySync(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS threads (session_id TEXT NOT NULL, thread_id TEXT NOT NULL, parent_thread_id TEXT NULL, fork_event_seq INTEGER NULL, head_seq INTEGER NOT NULL DEFAULT -1, status TEXT NOT NULL DEFAULT 'active', read_only INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(session_id, thread_id), CHECK(head_seq >= -1), CHECK(fork_event_seq IS NULL OR fork_event_seq >= 0));
    CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
    CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, thread_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'CREATED', started_at INTEGER NOT NULL, ended_at INTEGER NULL, last_persisted_seq INTEGER NOT NULL DEFAULT 0, pending_tool_ids TEXT NOT NULL DEFAULT '[]', recovery_status TEXT NULL, takeover_epoch INTEGER NULL, created_at INTEGER NOT NULL, CHECK(last_persisted_seq >= 0));
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, started_at);
    -- P2.6: ≤1 RUNNING per SESSION (partial unique index = DB-enforced,
    -- TOCTOU-safe; pelumba kedua gagal constraint, bukan tayang ganda).
    CREATE UNIQUE INDEX IF NOT EXISTS udx_runs_single_running ON runs(session_id) WHERE status = 'RUNNING';
    CREATE TABLE IF NOT EXISTS history_projections (session_id TEXT NOT NULL, thread_id TEXT NOT NULL, projection_id TEXT NOT NULL, base_seq INTEGER NOT NULL DEFAULT 0, summary_text TEXT NOT NULL DEFAULT '', included_ranges TEXT NOT NULL DEFAULT '[]', built_at INTEGER NOT NULL, anchor_event_id TEXT NULL, PRIMARY KEY(session_id, thread_id, projection_id), CHECK(base_seq >= 0));
    CREATE INDEX IF NOT EXISTS idx_projections_thread ON history_projections(session_id, thread_id);
  `)
  })
  // P2.12 — dua tabel milik daemon, DDL di sini karena `open()` SATU-SATUNYA
  // pemilik skema (setiap jalur buka DB melewati retry yang sama; DDL terpisah
  // di modul lain = dua jalur setup yang bisa berbeda urutan lock-nya).
  //
  // consumer_offsets: offset terakhir yang DIACK konsumen. TERPISAH dari
  // `runs.last_persisted_seq` (watermark penulis), `writer_epoch` (pagar
  // mutasi), dan `presentation_events.event_seq` (kepala kanonik) — empat
  // angka yang sering tertukar; kontrak melarang menggabungkannya karena
  // offset konsumen = "sudah diproses", bukan "sudah ditulis"/"punya siapa".
  //
  // daemon_approvals: mesin persetujuan durable. `state` dkk. — UI hanya
  // MENGUSULKAN keputusan; baris ini adalah otoritasnya.
  withBusyRetrySync(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS consumer_offsets (
      consumer_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_acked_seq INTEGER NOT NULL DEFAULT -1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(consumer_id, session_id),
      CHECK(last_acked_seq >= -1)
    );
    CREATE INDEX IF NOT EXISTS idx_consumer_offsets_session ON consumer_offsets(session_id);
    CREATE TABLE IF NOT EXISTS daemon_approvals (
      approval_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT NULL,
      tool TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      expires_at INTEGER NULL,
      decided_at INTEGER NULL,
      decision TEXT NULL,
      incarnation TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_daemon_approvals_session ON daemon_approvals(session_id, requested_at);
    CREATE INDEX IF NOT EXISTS idx_daemon_approvals_state ON daemon_approvals(state);
  `)
  })
  return db
}

// P2.12 — gerbang terbuka untuk pemilik skema lain (toko konsumen/persetujuan
// daemon) yang butuh handle lengkap: WAL + busy_timeout + DDL yang sama.
// Sengaja diekspos sebagai fungsi, bukan `open` sendiri, agar setiap pemanggil
// tetap melewati satu jalur setup yang sama.
export function openSessionDb(cwd?: string): Database {
  return open(cwd)
}

// P2.12 — sessions.db milik SATU workspace. Beda dari `openSessionDb` di atas:
// tak pernah jatuh ke `~/.minicode` global. Dipakai toko daemon (offset
// konsumen + persetujuan) karena keduanya menyatakan keadaan SATU workspace;
// menjatuhkannya ke DB bersama membuat konsumen workspace lain "melanjutkan"
// dari progres yang bukan miliknya — dan tak ada yang bisa membedakannya.
export function openWorkspaceSessionDb(cwd?: string): Database {
  return open(cwd, true)
}

// P2.2 — penolakan penulis basi. BEDA dari SQLITE_BUSY (masih boleh retry):
// epoch tak cocok = otoritas telah pindah; retry buta hanya menimpa penulis
// baru. Pemanggil wajib fail-closed (diagnostik eksplisit), bukan retry.
export class StaleWriterError extends Error {
  readonly code = "REFUSED_STALE_EPOCH"
  readonly sessionId: string
  readonly expectedEpoch: number
  readonly actualEpoch: number
  constructor(sessionId: string, expectedEpoch: number, actualEpoch: number) {
    super(
      `[persist] REFUSED_STALE_EPOCH sid=${sessionId} expected=${expectedEpoch} actual=${actualEpoch} — authority moved; history NOT durable`,
    )
    this.name = "StaleWriterError"
    this.sessionId = sessionId
    this.expectedEpoch = expectedEpoch
    this.actualEpoch = actualEpoch
  }
}

// P2.2 — baca pagar generasi penulis (0 bila baris belum ada: nilai awal
// deterministik untuk sesi yang belum pernah persist).
export function readWriterEpoch(id: string, cwd?: string): number {
  const db = open(cwd)
  try {
    const row = db.prepare("SELECT writer_epoch AS epoch FROM sessions WHERE id = ?").get(id) as {
      epoch: number | null
    } | null
    return row?.epoch ?? 0
  } finally {
    db.close()
  }
}

// Verifikasi pagar DI DALAM transaksi pemanggil. Melempar StaleWriterError
// (rollback oleh txn) bila: baris tak ada padahal ekspektasi > 0 (dunia
// bergerak: sesi dihapus/dibuat ulang), atau epoch tak cocok.
function assertWriterEpochInTxn(db: Database, id: string, expectedEpoch: number): void {
  const row = db.prepare("SELECT writer_epoch AS epoch FROM sessions WHERE id = ?").get(id) as {
    epoch: number | null
  } | null
  const actual = row?.epoch ?? 0
  if (row !== null && actual !== expectedEpoch) {
    throw new StaleWriterError(id, expectedEpoch, actual)
  }
  if (row === null && expectedEpoch !== 0) {
    throw new StaleWriterError(id, expectedEpoch, actual)
  }
}
// array ribuan angka — cukup placeholder agar DB tidak menggembung.
// Bentuk lama P2.3 terdeteksi dari PK: [thread_id] saja (threads) atau
// absennya kolom session_id (history_projections). Bentuk baru / tak-ada
// tabel → false (CREATE IF NOT EXISTS cukup).
function threadsTableNeedsP24Rebuild(db: Database): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(threads)").all() as { name: string; pk: number }[]
    if (cols.length === 0) return false
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
    return !(pk.length === 2 && pk[0] === "session_id" && pk[1] === "thread_id")
  } catch {
    return false
  }
}

function projectionsTableNeedsP24Rebuild(db: Database): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(history_projections)").all() as { name: string }[]
    if (cols.length === 0) return false
    return !cols.some((c) => c.name === "session_id")
  } catch {
    return false
  }
}

// P2.4 — penolak rebuild destruktif. Dipakai HANYA untuk tabel kerangka
// P2.3 yang dijamin kosong (netralitas runtime + guard): bila ada baris,
// rebuild DITOLAK loud (tak pernah hapus data diam-diam). Tabel tak-ada =
// aman (belum pernah dibuat).
function assertEmptyTableForRebuild(db: Database, table: string): void {
  let exists = false
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { ok: number } | null
    exists = row !== null
  } catch {
    return
  }
  if (!exists) return
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  if (n > 0) {
    throw new Error(
      `[persistence] refusing to rebuild non-empty table ${table} (${n} rows) — migrate, never destroy`,
    )
  }
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
    case "verification.observed":
      return (
        isStr("toolCallId") &&
        isStr("invocationId") &&
        (value.verdict === "present" ||
          value.verdict === "absent" ||
          value.verdict === "inconclusive") &&
        isStr("method") &&
        isNum("observedAt")
      )
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

// P2.12 — baca rentang untuk replay konsumen. WAJIB ada: `loadPresentationEvents`
// memuat SELURUH riwayat ke memori, dan konsumen yang attach dengan offset lama
// akan menarik seluruh sesi (ratusan ribu baris) hanya untuk 200 event terakhir
// yang belum diproses. Rentang + LIMIT membuat pemakaian memori daemon terikat
// pada apa yang benar-benar diminta, bukan pada usia sesi.
export interface PresentationEventRange {
  events: DomainEvent[]
  rejected: number
  /** Kepala kanonik sesi saat baca (untuk memastikan replay tak meleset). */
  head: number
}

export function loadPresentationEventsRange(
  id: string,
  fromSeq: number,
  limit: number,
  cwd?: string,
): PresentationEventRange {
  const db = open(cwd)
  try {
    const head = presentationHead(id, cwd, db)
    const capped = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 200, 1000))
    // Clamp ke >= 0 (bukan 1): eventSeq kanonik dimulai dari 1 pada jalur
    // produksi, tapi memotong pada 1 akan menjatuhkan baris 0 bila ada — dan
    // replay yang kehilangan SATU event pertama sudah cukup untuk merusak
    // urutan yang dijanjikan konsumen.
    const start = Number.isInteger(fromSeq) && fromSeq > 0 ? fromSeq : 0
    const rows = db
      .prepare(
        "SELECT payload FROM presentation_events WHERE session_id = ? AND event_seq >= ? ORDER BY event_seq LIMIT ?",
      )
      .all(id, start, capped) as { payload: string }[]
    const events: DomainEvent[] = []
    let rejected = 0
    for (const row of rows) {
      const event = decodePresentationEvent(row.payload)
      if (event) events.push(event)
      else rejected++
    }
    return { events, rejected, head }
  } finally {
    db.close()
  }
}

/**
 * Kepala `presentation_events` (seq tertinggi). `-1` bila belum ada event —
 * -1 = "tak ada", bukan 0 (seq mulai dari 1; 0 akan disalahartikan sebagai
 * "satu event sudah terkirim").
 */
export function presentationHead(id: string, cwd?: string, reuse?: Database): number {
  const db = reuse ?? open(cwd)
  const owned = reuse === undefined
  try {
    const row = db
      .prepare("SELECT MAX(event_seq) AS head FROM presentation_events WHERE session_id = ?")
      .get(id) as { head: number | null } | null
    return row?.head ?? -1
  } finally {
    if (owned) db.close()
  }
}

/**
 * Kepala `messages` lintas thread (bukan per-thread): frontier konsumen harus
 * mewakili seluruh sesi, dan memilih satu thread akan membuat sesi dengan fork
 * terlihat "mandek" padahal terus menulis di thread lain.
 * `-1` bila belum ada pesan (sama alasan dengan `presentationHead`).
 */
export function messageHead(id: string, cwd?: string): number {
  const db = open(cwd)
  try {
    const row = db
      .prepare("SELECT MAX(seq) AS head FROM messages WHERE session_id = ?")
      .get(id) as { head: number | null } | null
    return row?.head ?? -1
  } finally {
    db.close()
  }
}

export interface PresentationPersistStats {
  written: number
  duplicates: number
  collisions: number
}

/**
 * Representasi kanonis satu payload untuk perbandingan identitas P2.11:
 * stringify JSON dengan kunci terurut rekursif. Perbandingan string mentah
 * tidak stabil (urutan kunci sisipan bisa berbeda untuk payload yang sama),
 * jadi retransmisi identik harus dibandingkan dalam bentuk kanonis ini.
 */
export function canonicalizePresentationPayload(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalizePresentationPayload).join(",")}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizePresentationPayload(record[key])}`).join(",")}}`
}

/** Bandingkan dua payload tersimpan/ter-encode secara kanonis (tahan urutan kunci). */
function sameCanonicalPayload(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return (
      canonicalizePresentationPayload(JSON.parse(a)) ===
      canonicalizePresentationPayload(JSON.parse(b))
    )
  } catch {
    return false
  }
}

export async function appendPresentationEvents(
  id: string,
  cwd: string | undefined,
  events: readonly DomainEvent[],
  opts?: { expectedEpoch?: number },
): Promise<PresentationPersistStats> {
  const stats: PresentationPersistStats = { written: 0, duplicates: 0, collisions: 0 }
  const durable = events.filter((event) => DURABILITY[event.type]?.durable)
  if (durable.length === 0) return stats
  const db = open(cwd)
  const txn = db.transaction(() => {
    // P2.2: pagar generasi di dalam txn yang sama dengan tulis (bukan
    // check-then-write terpisah). Absennya baris sesi + ekspektasi 0 =
    // sesi pra-save pertama: diizinkan (baris dibuat oleh saveSession).
    if (opts?.expectedEpoch !== undefined) assertWriterEpochInTxn(db, id, opts.expectedEpoch)
    const existing = db.prepare(
      "SELECT payload FROM presentation_events WHERE session_id = ? AND event_seq = ?",
    )
    const insert = db.prepare(
      "INSERT OR IGNORE INTO presentation_events (session_id, event_seq, type, turn_id, ts, payload) VALUES (?, ?, ?, ?, ?, ?)",
    )
    for (const event of durable) {
      const payload = encodePresentationEvent(event)
      // P2.11: bedakan duplikat vs tabrakan pada identitas yang sama.
      // Duplikat (payload kanonis identik) = idempoten, lewati diam-diam.
      // Tabrakan (payload berbeda) = pertahankan baris existing, tolak yang
      // datang, hitung + diagnostik — jangan pernah menimpa, jangan simpulkan
      // apa pun tentang runtime dari tabrakan ini.
      const row = existing.get(id, event.eventSeq) as { payload: string } | undefined
      if (row) {
        if (sameCanonicalPayload(row.payload, payload)) {
          stats.duplicates++
        } else {
          stats.collisions++
          process.stderr.write(
            `[warn] presentation identity collision (session ${id} seq ${event.eventSeq} type ${event.type}): kept existing row, rejected incoming\n`,
          )
        }
        continue
      }
      insert.run(id, event.eventSeq, event.type, event.turnId, event.ts, payload)
      stats.written++
    }
  })
  try {
    await withBusyRetry(() => txn())
  } finally {
    db.close()
  }
  return stats
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
function norm(m: StoredMsg): Norm {
  return [
    m.role,
    safeContent(m.content),
    safeContent(m.toolCalls ?? null),
    (m.toolCallId ?? null) as string | null,
    (m.name ?? null) as string | null,
    // reasoning & is_error WAJIB ikut prefix comparison. Kalau tidak, perubahan
    // HANYA pada kedua field itu dianggap "tak berubah" dan incremental append
    // melewatkannya — persis kelas bug F-05.
    typeof m.reasoning === "string" ? safeContent(m.reasoning) : null,
    m.isError === true ? 1 : 0,
  ]
}

export async function saveSession(
  id: string,
  cwd: string | undefined,
  system: string | undefined,
  messages: readonly unknown[],
  usage: unknown,
  // P2.2: pagar mutasi. Disediakan composition root (satu penulis); pemanggil
  // legacy/test tanpa epoch memakai jalur tak-berpagar (tercatat di guard).
  // P2.6: runId opsional — baris BARU (bukan adopsi) dicap milik run ini dan
  // kursor run maju ke head dalam txn yang SAMA (atomik histori+kursor).
  opts?: { expectedEpoch?: number; runId?: string },
) {
  const db = open(cwd)
  const now = Date.now()
  const txn = db.transaction(() => {
    // P2.2: CAS generasi + mutasi = SATU transaksi. Lempar di sini → rollback
    // total (tak ada tulis parsial), dan withBusyRetry tak menyentuh error ini
    // (bukan SQLITE_BUSY) sehingga tak ada retry buta.
    if (opts?.expectedEpoch !== undefined) assertWriterEpochInTxn(db, id, opts.expectedEpoch)
    const existing = db
      .prepare("SELECT created_at, updated_at FROM sessions WHERE id = ?")
      .get(id) as { created_at: number; updated_at: number | null } | null
    const createdAt = existing?.created_at ?? now
    // P2.2: upsert MEMPERTAHANKAN writer_epoch. INSERT OR REPLACE menghapus
    // lalu menyisipkan ulang (epoch kembali 0!) — dilarang untuk baris sesi.
    db.prepare(
      "INSERT INTO sessions (id, created_at, updated_at, cwd, system, writer_epoch) VALUES (?, ?, ?, ?, ?, COALESCE((SELECT writer_epoch FROM sessions WHERE id = ?), 0)) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, cwd = excluded.cwd, system = excluded.system",
    ).run(id, createdAt, now, cwd ?? "", system ?? "", id)
    // P2.4: histori dimiliki default Thread — ensure atomik dalam txn yang
    // sama (sesi + thread tak pernah terpisah; tak ada sesi threadless yang
    // durable). Backfill NULL aditif; archived menolak tulis (dorman).
    const thread = ensureDefaultThreadInTxn(db, id, now)
    if (thread.status === "archived") throw new ThreadArchivedError(id, thread.thread_id)
    const tid = thread.thread_id
    const ins = db.prepare(
      "INSERT INTO messages (session_id, thread_id, seq, role, content, toolCalls, toolCallId, name, reasoning, is_error, ts, event_id, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    // StoredMsg/Norm/norm: modul-level (dipakai saveSession + shrinkThreadHistory).
    // F-05: JANGAN pakai messages.length sebagai proksi perubahan. Kompaksi
    // (atau replace apa pun) bisa mengganti N pesan dengan N pesan BERBEDA —
    // panjang sama, isi beda. Tanpa verifikasi prefix, tulis dilewat dan
    // resume memuat sejarah basi. Bandingkan prefix tersimpan dengan incoming:
    // sama persis = re-save (bukan turn baru, jaga guard anti turn-hantu);
    // prefix sama + tumbuh = append; selain itu = rewrite penuh.
    // P2.4: pembanding prefix dibatasi histori default Thread (inklusif NULL
    // transisional untuk baris pra-backfill; pasca-backfill tak ada NULL).
    const stored = db
      .prepare(
        "SELECT seq, role, content, toolCalls, toolCallId, name, reasoning, is_error, event_id, run_id FROM messages WHERE session_id = ? AND (thread_id = ? OR thread_id IS NULL) ORDER BY seq",
      )
      .all(id, tid) as {
      seq: number
      role: string
      content: string
      toolCalls: string
      toolCallId: string | null
      name: string | null
      reasoning: string | null
      is_error: number | null
      event_id: string | null
      run_id: string | null
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
      // incremental append-only: cukup insert pesan baru (umumnya 1 turn).
      // P2.5: tiap baris baru mendapat event_id fresh SATU KALI di sini;
      // save ulang identik = no-op (prefixSame) sehingga id stabil.
      // P2.6: baris baru dicap run_id pemanggil (bila ada).
      for (let i = known; i < messages.length; i++) {
        const m = messages[i] as StoredMsg
        const w = norm(m)
        ins.run(
          id,
          tid,
          i,
          w[0],
          w[1],
          w[2],
          w[3],
          w[4],
          w[5],
          w[6],
          now,
          allocateHistoryEventId(),
          opts?.runId ?? null,
        )
      }
    } else if (changed) {
      // P2.7: saveSession APPEND-ONLY. Riwayat menyusut ATAU prefix berubah
      // (kompaksi N→N) DITOLAK eksplisit — bukan ditulis ulang diam-diam.
      // Jalur eksplisit: shrinkThreadHistory (berpagar epoch, menolak run
      // live, mencatat provenance, menginvalidasi proyeksi, satu txn).
      // Menghapus cabang DELETE+rewrite implisit menutup jalur destruktif
      // tanpa provenance (guard P2.7 menegakkannya tetap hilang).
      // P3.1-retarget: bedakan "kanonik tumbuh melampaui buffer" dari
      // lipatan/divergensi buffer sendiri — pembedanya dibawa dalam error
      // (grewBeyondBuffer) agar composition root menolak shrink otomatis pada
      // kasus pertama. Perbandingan field IDENTIK dengan loop prefix di atas
      // (F-05); bila loop itu berubah, sinkronkan keduanya.
      let grewBeyondBuffer = false
      if (stored.length > messages.length) {
        grewBeyondBuffer = true
        for (let i = 0; i < messages.length; i++) {
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
            grewBeyondBuffer = false
            break
          }
        }
      }
      throw new RefusedHistoryRewriteError(
        id,
        tid,
        `stored=${stored.length} incoming=${messages.length} prefixSame=${prefixSame}`,
        grewBeyondBuffer,
      )
    }
    // P2.4: head cache = MAX(seq) histori thread ini (-1 bila kosong).
    const head = recomputeThreadHeadInTxn(db, id, tid)
    // P2.6: kursor run maju ke head DALAM txn yang sama (atomik histori +
    // kursor: event durable TANPA kursor basi, dan sebaliknya, tak mungkin
    // terpisah). Baris terminal dibekukan (persist-duplikat pasca-terminal
    // = no-op aman, bukan pergerakan).
    if (opts?.runId !== undefined) {
      // Kepemilikan run diverifikasi (bukan diasumsikan): run milik sesi+thread
      // lain tidak boleh "menyerap" kursor histori ini.
      const runRow = db
        .prepare("SELECT session_id, thread_id FROM runs WHERE run_id = ?")
        .get(opts.runId) as { session_id: string; thread_id: string } | null
      if (!runRow) throw new Error(`run not found: ${opts.runId}`)
      if (runRow.session_id !== id || runRow.thread_id !== tid)
        throw new Error(`run ${opts.runId} does not belong to ${id}/${tid}`)
      // Kursor = posisi histori milik run ini. Baris head yang dicap run lain
      // (atau NULL warisan) tak boleh jadi klaim kursor. Run terminal beku:
      // persist pasca-terminal = no-op kursor (histori tetap durable).
      if (head >= 0) {
        const status = db.prepare("SELECT status FROM runs WHERE run_id = ?").get(opts.runId) as {
          status: string
        }
        if (!RUN_TERMINAL.has(status.status)) advanceRunCursorInTxn(db, opts.runId, head, id)
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
  // P2.2: yatim alias/takeover ikut dibersihkan (pola orphan yang sama).
  // Best-effort seperti presentation_events di bawah: handle mentah (purge
  // CLI, fixture uji) belum tentu punya tabel baru; open() selalu membuatnya.
  // P2.4: yatim Thread + Run + proyeksi ikut pola yang sama (tabel kosong
  // hingga P2.5/2.7 menulis; nihil-op hingga saat itu).
  try {
    db.prepare("DELETE FROM session_aliases WHERE canonical NOT IN (SELECT id FROM sessions)").run()
    db.prepare(
      "DELETE FROM session_takeovers WHERE session_id NOT IN (SELECT id FROM sessions)",
    ).run()
    db.prepare("DELETE FROM threads WHERE session_id NOT IN (SELECT id FROM sessions)").run()
    db.prepare("DELETE FROM runs WHERE session_id NOT IN (SELECT id FROM sessions)").run()
    db.prepare(
      "DELETE FROM history_projections WHERE session_id NOT IN (SELECT id FROM sessions)",
    ).run()
  } catch {}
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

type StoredMessageRow = {
  seq: number
  role: string
  content: string
  toolCalls: string
  toolCallId: string | null
  name: string | null
  reasoning: string | null
  is_error: number | null
}

// P2.4: dekoder baris→pesan TUNGGAL (dipakai loadSession kompatibel +
// loadThreadHistory ketat). Satu jalur decode = tak ada divergensi bentuk.
function decodeMessageRows(rows: StoredMessageRow[]): unknown[] {
  // `reasoning` ditulis lewat safeContent (JSON) supaya ikut scrub + cap
  // seperti `content`, jadi dibalik simetris di sini. String kosong
  // diperlakukan absen: menyetel `reasoning: ""` / `isError: false` di setiap
  // pesan akan mengubah bentuk pesan saat kernel membandingkan.
  const readReasoning = (raw: string | null): string | undefined => {
    if (!raw) return undefined
    const parsed = parseContent(raw)
    return typeof parsed === "string" && parsed.length > 0 ? parsed : undefined
  }
  return rows.map((r) => {
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
      default_thread_id: string | null
    } | null
    if (!sess) {
      return null
    }
    // P2.4: histori sesi = histori default Thread (inklusif NULL transisional
    // untuk baris pra-backfill; baca kompatibel, bukan identitas ganda).
    const tid = sess.default_thread_id ?? DEFAULT_THREAD_ID
    const rows = db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? AND (thread_id = ? OR thread_id IS NULL) ORDER BY seq",
      )
      .all(id, tid) as StoredMessageRow[]
    const messages = decodeMessageRows(rows)
    const turnRow = db
      .prepare("SELECT MAX(turn_idx) as m FROM turns WHERE session_id = ?")
      .get(id) as { m: number | null } | null
    const turnCount = turnRow?.m != null ? turnRow.m + 1 : 0
    return { messages, system: sess.system, cwd: sess.cwd, turnCount }
  } finally {
    db.close()
  }
}

// P2.4: baca histori SATU thread (ketat: tanpa NULL transisional).
// Beda dari loadSession (kompatibel): di sini thread scope eksplisit.
export function loadThreadHistory(sessionId: string, threadId: string, cwd?: string): unknown[] {
  const db = open(cwd)
  try {
    const rows = db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND thread_id = ? ORDER BY seq")
      .all(sessionId, threadId) as StoredMessageRow[]
    return decodeMessageRows(rows)
  } finally {
    db.close()
  }
}

// P2.8 — pembaca histori thread YANG membawa seq. Beda dari loadThreadHistory
// (tanpa seq): konsumen komposisi konteks butuh tahu posisi persis tiap baris
// (batas [0,base_seq) vs ekor) tanpa mengira indeks = seq. Aditif, baca-saja,
// thread-scoped — tanpa ini perakitan konteks akan menebak.
export function loadThreadHistoryWithSeq(
  sessionId: string,
  threadId: string,
  cwd?: string,
): { seq: number; message: unknown }[] {
  const db = open(cwd)
  try {
    const rows = db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND thread_id = ? ORDER BY seq")
      .all(sessionId, threadId) as StoredMessageRow[]
    const decoded = decodeMessageRows(rows)
    return decoded.map((message, i) => ({ seq: rows[i]!.seq, message }))
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

// P2.1 — primitif peta alias identitas sesi (IO murni; keputusan di
// `src/session/identity.ts`). Alias = input mentah eksak; canonical &
// session row = bentuk kanonik (sudah sanitasi di pemanggil).

export interface SessionAliasRow {
  alias: string
  fs_key: string
  canonical: string
  reason: string
  created_at: number
}

export function sessionRowExists(id: string, cwd?: string): boolean {
  const db = open(cwd)
  try {
    const row = db.prepare("SELECT 1 AS ok FROM sessions WHERE id = ?").get(id) as {
      ok: number
    } | null
    return row !== null
  } finally {
    db.close()
  }
}

export function lookupSessionAlias(alias: string, cwd?: string): SessionAliasRow | null {
  const db = open(cwd)
  try {
    const row = db
      .prepare(
        "SELECT alias, fs_key, canonical, reason, created_at FROM session_aliases WHERE alias = ?",
      )
      .get(alias) as SessionAliasRow | null
    return row
  } finally {
    db.close()
  }
}

export type RecordAliasOutcome =
  | { ok: true; created: boolean }
  // Alias eksak sudah menunjuk kanonik lain → target imutabel, tolak.
  | { ok: false; reason: "alias-conflict"; existing: string }
  // fs_key alias adalah baris sesi hidup yang berbeda → tabrakan kunci.
  | { ok: false; reason: "key-hijack"; existing: string }
  // Target kanonik tak ada baris sesinya → peta menggantung, tolak.
  | { ok: false; reason: "dangling-canonical" }

export function tryRecordSessionAlias(
  alias: string,
  fsKey: string,
  canonical: string,
  reason: string,
  cwd?: string,
): RecordAliasOutcome {
  if (alias === canonical) return { ok: true, created: false }
  const db = open(cwd)
  try {
    const existing = db
      .prepare("SELECT canonical FROM session_aliases WHERE alias = ?")
      .get(alias) as { canonical: string } | null
    if (existing) {
      if (existing.canonical === canonical) return { ok: true, created: false }
      return { ok: false, reason: "alias-conflict", existing: existing.canonical }
    }
    const rowHijack = db.prepare("SELECT 1 AS ok FROM sessions WHERE id = ?").get(fsKey) as {
      ok: number
    } | null
    if (rowHijack && fsKey !== canonical)
      return { ok: false, reason: "key-hijack", existing: fsKey }
    const target = db.prepare("SELECT 1 AS ok FROM sessions WHERE id = ?").get(canonical) as {
      ok: number
    } | null
    if (!target) return { ok: false, reason: "dangling-canonical" }
    const now = Date.now()
    db.prepare(
      "INSERT INTO session_aliases (alias, fs_key, canonical, reason, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(alias, fsKey, canonical, reason, now)
    return { ok: true, created: true }
  } finally {
    db.close()
  }
}

// Kanonik lain yang berbagi fs_key: baris sesi ber-id == fsKey (bukan
// resolved) + alias lain ber-fs_key sama yang menunjuk kanonik berbeda.
export function findFsKeyConflicts(
  fsKey: string,
  resolvedCanonical: string,
  cwd?: string,
): { kind: "session-row" | "alias"; id: string; canonical: string }[] {
  const db = open(cwd)
  try {
    const out: { kind: "session-row" | "alias"; id: string; canonical: string }[] = []
    const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(fsKey) as {
      id: string
    } | null
    if (row && row.id !== resolvedCanonical) {
      out.push({ kind: "session-row", id: row.id, canonical: row.id })
    }
    const aliases = db
      .prepare("SELECT alias, canonical FROM session_aliases WHERE fs_key = ?")
      .all(fsKey) as { alias: string; canonical: string }[]
    for (const a of aliases) {
      if (a.canonical !== resolvedCanonical)
        out.push({ kind: "alias", id: a.alias, canonical: a.canonical })
    }
    return out
  } finally {
    db.close()
  }
}

export function listSessionAliases(canonical: string, cwd?: string): SessionAliasRow[] {
  const db = open(cwd)
  try {
    return db
      .prepare(
        "SELECT alias, fs_key, canonical, reason, created_at FROM session_aliases WHERE canonical = ? ORDER BY created_at",
      )
      .all(canonical) as SessionAliasRow[]
  } finally {
    db.close()
  }
}

// P2.2 — majukan generasi penulis tepat satu langkah, atomik terhadap
// pengambil-alihan simultan. Kunci: PRIMARY KEY (session_id, prior_epoch) —
// pecundang menabrak constraint dan MENGAMATI hasil pemenang (idempoten),
// bukan menaikkan epoch lagi. Tak ada ketergantungan Date.now untuk
// serialisasi; SQLite-lah arbiternya.
export type TakeoverEpochOutcome =
  | { outcome: "advanced"; epoch: number }
  | { outcome: "already-applied"; epoch: number }
  | { outcome: "epoch-moved-unexpected"; epoch: number }
  | { outcome: "nothing-to-fence"; epoch: 0 }

export function takeoverSessionEpoch(
  sessionId: string,
  priorEpoch: number,
  reason: string,
  boot: string,
  cwd?: string,
): TakeoverEpochOutcome {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      const row = db
        .prepare("SELECT writer_epoch AS epoch FROM sessions WHERE id = ?")
        .get(sessionId) as {
        epoch: number
      } | null
      if (row === null) return { outcome: "nothing-to-fence", epoch: 0 } as const
      if (row.epoch !== priorEpoch) {
        const rec = db
          .prepare(
            "SELECT new_epoch AS epoch FROM session_takeovers WHERE session_id = ? AND prior_epoch = ?",
          )
          .get(sessionId, priorEpoch) as { epoch: number } | null
        if (rec) return { outcome: "already-applied", epoch: rec.epoch } as const
        return { outcome: "epoch-moved-unexpected", epoch: row.epoch } as const
      }
      const ins = db
        .prepare(
          "INSERT OR IGNORE INTO session_takeovers (session_id, prior_epoch, new_epoch, reason, boot, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(sessionId, priorEpoch, priorEpoch + 1, reason, boot, Date.now())
      if (ins.changes === 0) {
        const cur = db
          .prepare("SELECT writer_epoch AS epoch FROM sessions WHERE id = ?")
          .get(sessionId) as {
          epoch: number
        }
        return { outcome: "already-applied", epoch: cur.epoch } as const
      }
      const upd = db
        .prepare(
          "UPDATE sessions SET writer_epoch = ?, updated_at = ? WHERE id = ? AND writer_epoch = ?",
        )
        .run(priorEpoch + 1, Date.now(), sessionId, priorEpoch)
      if (upd.changes === 0) {
        const cur = db
          .prepare("SELECT writer_epoch AS epoch FROM sessions WHERE id = ?")
          .get(sessionId) as {
          epoch: number
        }
        return { outcome: "already-applied", epoch: cur.epoch } as const
      }
      return { outcome: "advanced", epoch: priorEpoch + 1 } as const
    })()
  } finally {
    db.close()
  }
}

export function listSessionTakeovers(
  sessionId: string,
  cwd?: string,
): {
  prior_epoch: number
  new_epoch: number
  reason: string
  boot: string
  created_at: number
}[] {
  const db = open(cwd)
  try {
    return db
      .prepare(
        "SELECT prior_epoch, new_epoch, reason, boot, created_at FROM session_takeovers WHERE session_id = ? ORDER BY prior_epoch",
      )
      .all(sessionId) as {
      prior_epoch: number
      new_epoch: number
      reason: string
      boot: string
      created_at: number
    }[]
  } finally {
    db.close()
  }
}

// ── P2.5 — identitas event histori kanonik ─────────────────────────────
// seq = ordering di dalam Thread; event_id = identitas stabil event.
// Keduanya tak saling menurunkan. Kernel TAK PERNAH membawa event_id:
// snapshot vendor membangun objek baru field-demi-field (snapshotMessage,
// vendor/minicore/src/core/snapshot.ts:14-23) sehingga prop asing gugur di
// setiap batas — adopsi POSISIONAL di saveSession adalah satu-satunya jalur
// yang konsisten arsitektur. Jalur eksplisit per-event = appendHistoryEvent.

const ALLOCATED_EVENT_ID_RE =
  /^evt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DERIVED_EVENT_ID_RE = /^evt_migr_[0-9a-f]{32}$/

export function isHistoryEventId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (ALLOCATED_EVENT_ID_RE.test(value) || DERIVED_EVENT_ID_RE.test(value))
  )
}

// SATU-SATUNYA allocator produksi: CSPRNG 122-bit, tanpa input (bukan dari
// seq, bukan dari konten — tabrakan acak praktis mustahil; bila constraint
// menabrak, save GAGAL loud, tak pernah merge diam-diam).
export function allocateHistoryEventId(): string {
  return `evt_${randomUUID()}`
}

// ID deterministik untuk baris legacy (NULL): stabil lintas run (sha256
// session\0thread\0seq), idempoten by-construction, bentuk turunan.
export function deriveLegacyHistoryEventId(
  sessionId: string,
  threadId: string,
  seq: number,
): string {
  const digest = createHash("sha256")
    .update(sessionId, "utf8")
    .update(" ", "utf8")
    .update(threadId, "utf8")
    .update(" ", "utf8")
    .update(String(seq), "utf8")
    .digest("hex")
    .slice(0, 32)
  return `evt_migr_${digest}`
}

export class EventIdConflictError extends Error {
  readonly code = "REFUSED_EVENT_ID_CONFLICT"
  readonly sessionId: string
  readonly threadId: string
  readonly eventId: string
  constructor(sessionId: string, threadId: string, eventId: string) {
    super(
      `[history] REFUSED_EVENT_ID_CONFLICT ${sessionId}/${threadId} event ${eventId} — same id, different event; original is authoritative`,
    )
    this.name = "EventIdConflictError"
    this.sessionId = sessionId
    this.threadId = threadId
    this.eventId = eventId
  }
}

export class EventIdInvalidError extends Error {
  readonly code = "REFUSED_EVENT_ID_INVALID"
  constructor(value: string) {
    super(
      `[history] REFUSED_EVENT_ID_INVALID "${value}" — not an allocated or derived history event id`,
    )
    this.name = "EventIdInvalidError"
  }
}
// ── P2.4 — primitif Thread ──────────────────────────────────────────────
// Identitas komposit (session_id, thread_id): 'th_default' bermakna per
// sesi. head_seq = MAX(seq) histori thread (-1 = kosong): cache, BUKAN
// sumber kebenaran. Tak ada traversal/merge di fase ini (P3+).

export const DEFAULT_THREAD_ID = "th_default"

export interface ThreadRow {
  session_id: string
  thread_id: string
  parent_thread_id: string | null
  fork_event_seq: number | null
  head_seq: number
  status: string
  read_only: number
  created_at: number
}

export class ThreadArchivedError extends Error {
  readonly code = "THREAD_ARCHIVED"
  constructor(sessionId: string, threadId: string) {
    super(`[thread] ${sessionId}/${threadId} is archived — history mutation refused`)
    this.name = "ThreadArchivedError"
  }
}

export class ThreadParentError extends Error {
  readonly code: "THREAD_PARENT_INVALID" | "THREAD_READONLY_PARENT" | "THREAD_FORK_SEQ_INVALID"
  constructor(code: ThreadParentError["code"], sessionId: string, detail: string) {
    super(`[thread] ${sessionId}: ${detail}`)
    this.name = "ThreadParentError"
    this.code = code
  }
}

function rowToThread(row: ThreadRow): ThreadRow {
  return { ...row }
}

export function getThread(sessionId: string, threadId: string, cwd?: string): ThreadRow | null {
  const db = open(cwd)
  try {
    const row = db
      .prepare(
        "SELECT session_id, thread_id, parent_thread_id, fork_event_seq, head_seq, status, read_only, created_at FROM threads WHERE session_id = ? AND thread_id = ?",
      )
      .get(sessionId, threadId) as ThreadRow | null
    return row ? rowToThread(row) : null
  } finally {
    db.close()
  }
}

// Resolve thread default: kolom sessions.default_thread_id, fallback ke
// konvensi. Murni baca (tanpa materialisasi); null = sesi/threadless.
export function getDefaultThread(sessionId: string, cwd?: string): ThreadRow | null {
  const db = open(cwd)
  try {
    const sess = db
      .prepare("SELECT default_thread_id FROM sessions WHERE id = ?")
      .get(sessionId) as {
      default_thread_id: string | null
    } | null
    const tid = sess?.default_thread_id ?? DEFAULT_THREAD_ID
    const row = db
      .prepare(
        "SELECT session_id, thread_id, parent_thread_id, fork_event_seq, head_seq, status, read_only, created_at FROM threads WHERE session_id = ? AND thread_id = ?",
      )
      .get(sessionId, tid) as ThreadRow | null
    return row ? rowToThread(row) : null
  } finally {
    db.close()
  }
}

function recomputeThreadHeadInTxn(db: Database, sessionId: string, threadId: string): number {
  const maxRow = db
    .prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id = ? AND thread_id = ?")
    .get(sessionId, threadId) as { m: number | null } | null
  const head = maxRow?.m ?? -1
  db.prepare("UPDATE threads SET head_seq = ? WHERE session_id = ? AND thread_id = ?").run(
    head,
    sessionId,
    threadId,
  )
  return head
}

// Inti ensure (dipakai ensureDefaultThread + saveSession dalam txn yang
// sama — SATU-SATUNYA tempat baris Thread default dimaterialisasi).
function ensureDefaultThreadInTxn(db: Database, sessionId: string, now: number): ThreadRow {
  // P2.6: pasangan (sesi, thread) dijamin atomik — baris sesi dibuat bila
  // absen (turn-start pada sesi fresh; saveSession menimpanya dengan
  // cwd/system lengkap kemudian). Epoch fresh = 0, konsisten dengan upsert.
  db.prepare(
    "INSERT INTO sessions (id, created_at, updated_at, cwd, system, writer_epoch) VALUES (?, ?, ?, ?, ?, COALESCE((SELECT writer_epoch FROM sessions WHERE id = ?), 0)) ON CONFLICT(id) DO NOTHING",
  ).run(sessionId, now, now, "", "", sessionId)
  // INSERT OR IGNORE + baca ulang: dua ensure konkuren menghasilkan tepat
  // satu baris (pecundang mengamati, bukan duplikat). Tanpa sleep/retry.
  db.prepare(
    "INSERT OR IGNORE INTO threads (session_id, thread_id, parent_thread_id, fork_event_seq, head_seq, status, read_only, created_at) VALUES (?, ?, NULL, NULL, -1, 'active', 0, ?)",
  ).run(sessionId, DEFAULT_THREAD_ID, now)
  // Backfill aditif: HANYA thread_id (konten/seq/timestamp tak tersentuh).
  db.prepare("UPDATE messages SET thread_id = ? WHERE session_id = ? AND thread_id IS NULL").run(
    DEFAULT_THREAD_ID,
    sessionId,
  )
  db.prepare("UPDATE sessions SET default_thread_id = ? WHERE id = ?").run(
    DEFAULT_THREAD_ID,
    sessionId,
  )
  recomputeThreadHeadInTxn(db, sessionId, DEFAULT_THREAD_ID)
  const row = db
    .prepare(
      "SELECT session_id, thread_id, parent_thread_id, fork_event_seq, head_seq, status, read_only, created_at FROM threads WHERE session_id = ? AND thread_id = ?",
    )
    .get(sessionId, DEFAULT_THREAD_ID) as ThreadRow
  return rowToThread(row)
}

// ── P2.9 — Sub-Agent runtime (Model C) ───────────────────────────────────────
//
// Sub-Agent = entitas eksekusi TERSENDIRI yang direalisasi sebagai Session +
// Thread + Run kanonik sendiri, dengan lineage durable ke parent Session DAN
// parent Run. Alasannya BUKAN aesthetics tapi constraint repo:
//
//   udx_runs_single_running ON runs(session_id) WHERE status='RUNNING'
//
// ⇒ anak-anak TIDAK bisa RUNNING bersamaan dalam satu Session, sedangkan
// delegate_task menjalankan anak lewat Pool(SUB_AGENT_POOL_SIZE) (concurrency).
// Satu-satunya topologi yang memenuhi keduanya: satu child = satu Session.
//
// CATATAN IDENTITAS (P2.9 §2): id anak P1 lawas `sub_<8hex>` hanya 32-bit dan
// TERLALU LEMAH untuk jadi identitas durable kanonik. Alokator di bawah
// memberi 128-bit dengan prefiks sama (kompatibilitas jurnal/presentasi).
// `executionId` kind "child" (P1) TETAP identitas runtime — tidak ditukar
// dengan id sesi kanonik ini; keduanya hidup berdampingan.

export function allocateChildSessionId(): string {
  return `sub_${randomUUID().replace(/-/g, "")}`
}

export interface ChildSessionLink {
  parent_session_id: string | null
  parent_run_id: string | null
}

export interface ChildSessionRecord {
  sessionId: string
  parentSessionId: string
  parentRunId: string | null
  threadId: string
  runId: string
}

/**
 * Creates the canonical Sub-Agent namespace: sessions row + default Thread +
 * a CREATED Run, ALL in one transaction. Durable causality: nothing about the
 * child may become durable before its Session row exists (this is what closes
 * the phantom-namespace defect where child presentation_events were purged).
 *
 * NOT started here — the caller transitions to RUNNING (P2.6 state machine)
 * after holding the child writer admission, so the RUNNING record and the epoch
 * that authorises writes appear in the right order.
 */
export function createChildSession(opts: {
  parentSessionId: string
  parentRunId?: string | null
  cwd?: string
  childSessionId?: string
  expectedParentEpoch?: number
  system?: string
}): ChildSessionRecord {
  const cwd = opts.cwd
  const childSessionId = opts.childSessionId ?? allocateChildSessionId()
  if (!childSessionId.startsWith("sub_")) {
    throw new Error(`invalid child session id: ${childSessionId}`)
  }
  const db = open(cwd)
  const now = Date.now()
  try {
    // withBusyRetrySync: anak-anak paralel (Pool SUB_AGENT_POOL_SIZE) menulis
    // sessions.db bersamaan → SQLITE_BUSY yang wajar, BUKAN kegagalan durable.
    // Retry sinkron yang sudah ada (pola open() P1).
    const record = withBusyRetrySync<ChildSessionRecord>(() =>
      db.transaction(() => {
        if (!sessionRowExistsInTxn(db, opts.parentSessionId)) {
          // Parent belum punya baris (mis. tool dipanggil sebelum persist parent
          // selesai). Pola yang SAMA dengan ensureDefaultThreadInTxn P2.4 /
          // saveSession: materialisasi baris sesi, bukan menolak — lineage child
          // tetap menunjuk baris `sessions` kanonik. saveSession parent kemudian
          // menimpanya dengan cwd/system lengkap.
          db.prepare(
            "INSERT INTO sessions (id, created_at, updated_at, cwd, system, writer_epoch) VALUES (?, ?, ?, '', ?, 0) ON CONFLICT(id) DO NOTHING",
          ).run(opts.parentSessionId, now, now, opts.system ?? "")
        }
        if (opts.expectedParentEpoch !== undefined) {
          assertWriterEpochInTxn(db, opts.parentSessionId, opts.expectedParentEpoch)
        }
        // Idempotent by id: re-creating an existing child returns its record.
        const existing = db
          .prepare("SELECT parent_session_id, parent_run_id FROM sessions WHERE id = ?")
          .get(childSessionId) as ChildSessionLink | null
        if (existing) {
          if (existing.parent_session_id !== opts.parentSessionId) {
            throw new Error(
              `child session ${childSessionId} already owned by ${String(existing.parent_session_id)}`,
            )
          }
          const thread = ensureDefaultThreadInTxn(db, childSessionId, now)
          const run = db
            .prepare(
              "SELECT run_id, thread_id FROM runs WHERE session_id = ? ORDER BY created_at LIMIT 1",
            )
            .get(childSessionId) as { run_id: string; thread_id: string } | undefined
          if (run) {
            return {
              sessionId: childSessionId,
              parentSessionId: opts.parentSessionId,
              parentRunId: existing.parent_run_id,
              threadId: thread.thread_id,
              runId: run.run_id,
            }
          }
        }
        db.prepare(
          "INSERT INTO sessions (id, created_at, updated_at, cwd, system, writer_epoch, parent_session_id, parent_run_id) VALUES (?, ?, ?, '', ?, 0, ?, ?) ON CONFLICT(id) DO UPDATE SET parent_session_id = excluded.parent_session_id, parent_run_id = excluded.parent_run_id",
        ).run(
          childSessionId,
          now,
          now,
          opts.system ?? "",
          opts.parentSessionId,
          opts.parentRunId ?? null,
        )
        const thread = ensureDefaultThreadInTxn(db, childSessionId, now)
        // Durable execution record = P2 Run (P2.6 state machine, no new FSM).
        const runId = allocateRunId()
        const epochRow = db
          .prepare("SELECT writer_epoch AS epoch FROM sessions WHERE id = ?")
          .get(childSessionId) as { epoch: number }
        db.prepare(
          "INSERT INTO runs (run_id, session_id, thread_id, status, started_at, ended_at, last_persisted_seq, pending_tool_ids, recovery_status, takeover_epoch, created_at) VALUES (?, ?, ?, 'CREATED', ?, NULL, 0, '[]', 'NONE', ?, ?)",
        ).run(runId, childSessionId, thread.thread_id, now, epochRow.epoch, now)
        return {
          sessionId: childSessionId,
          parentSessionId: opts.parentSessionId,
          parentRunId: opts.parentRunId ?? null,
          threadId: thread.thread_id,
          runId,
        }
      })(),
    )
    if (record === null) throw new Error(`child session busy: ${childSessionId}`)
    return record
  } finally {
    db.close()
  }
}

/** Durable lineage of a Session (NULL fields for a root/parent Session). */
export function getChildSessionLink(sessionId: string, cwd?: string): ChildSessionLink | null {
  const db = open(cwd)
  try {
    return (
      (db
        .prepare("SELECT parent_session_id, parent_run_id FROM sessions WHERE id = ?")
        .get(sessionId) as ChildSessionLink | null) ?? null
    )
  } finally {
    db.close()
  }
}

/** Child Sessions of a parent, newest first. */
export function listChildSessions(parentSessionId: string, cwd?: string): string[] {
  const db = open(cwd)
  try {
    const rows = db
      .prepare("SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY created_at DESC")
      .all(parentSessionId) as { id: string }[]
    return rows.map((r) => r.id)
  } finally {
    db.close()
  }
}

/** True when a Session has at least one child Session (delete-safety). */
export function hasChildSessions(sessionId: string, cwd?: string): boolean {
  const db = open(cwd)
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sessions WHERE parent_session_id = ? LIMIT 1")
      .get(sessionId) as { ok: number } | null
    return row !== null
  } finally {
    db.close()
  }
}

/**
 * Orphan sweep: RUNNING child Runs whose parent is no longer live become
 * INTERRUPTED + recovery UNKNOWN (P2.6 tombstone semantics — a death is never
 * observed, so nothing may be inferred as COMPLETED). Idempotent.
 */
export function tombstoneOrphanChildRuns(
  parentSessionId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): string[] {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined) {
        assertWriterEpochInTxn(db, parentSessionId, opts.expectedEpoch)
      }
      // CREATED ikut serta: Run anak yang masih CREATED saat parent jatuh =
      // sisa dari jendela sinkron createChildSession→RUNNING yang tak pernah
      // selesai. Meninggalkannya berarti ada eksekusi durable yang tak
      // terlacak; menombaknya (INTERRUPTED/UNKNOWN) jujur — ia memang tak pernah
      // berjalan. RUNNING tetap inti aturannya; CREATED hanya memperluas
      // penutupan, tak pernah melonggarkan.
      const rows = db
        .prepare(
          "SELECT r.run_id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.parent_session_id = ? AND r.status IN ('RUNNING', 'CREATED')",
        )
        .all(parentSessionId) as { run_id: string }[]
      const out: string[] = []
      for (const row of rows) {
        db.prepare(
          "UPDATE runs SET status = 'INTERRUPTED', recovery_status = 'UNKNOWN' WHERE run_id = ? AND status IN ('RUNNING', 'CREATED')",
        ).run(row.run_id)
        out.push(row.run_id)
      }
      return out
    })()
  } finally {
    db.close()
  }
}

/**
 * Parent reached a terminal state ⇒ its children may not stay RUNNING.
 * Same rule as the orphan sweep (INTERRUPTED + UNKNOWN, ended_at NULL): we
 * cannot claim they finished, and must never leave an untracked durable
 * execution behind.
 */
export function terminalizeChildRuns(
  parentSessionId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): string[] {
  return tombstoneOrphanChildRuns(parentSessionId, cwd, opts)
}

// Materialisasi default Thread untuk sesi existing (resume/migrasi).
// Fenced bila expectedEpoch disediakan (mutasi sesi). Idempoten.
export function ensureDefaultThread(
  sessionId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): ThreadRow {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch)
      return ensureDefaultThreadInTxn(db, sessionId, Date.now())
    })()
  } finally {
    db.close()
  }
}

// Primitif create untuk P2 branching/sub-agen mendatang. Tanpa CLI/UX.
// Fenced, tanpa histori awal, tanpa traversal, tanpa copy.
export function createThread(
  sessionId: string,
  cwd?: string,
  opts?: {
    threadId?: string
    parentThreadId?: string
    forkEventSeq?: number
    expectedEpoch?: number
  },
): ThreadRow {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch)
      const hasSession = db.prepare("SELECT 1 AS ok FROM sessions WHERE id = ?").get(sessionId) as {
        ok: number
      } | null
      if (!hasSession) throw new Error(`session not found: ${sessionId}`)
      if (opts?.parentThreadId !== undefined) {
        const parent = db
          .prepare(
            "SELECT thread_id, fork_event_seq, head_seq, status, read_only FROM threads WHERE session_id = ? AND thread_id = ?",
          )
          .get(sessionId, opts.parentThreadId) as {
          thread_id: string
          fork_event_seq: number | null
          head_seq: number
          status: string
          read_only: number
        } | null
        if (!parent) {
          throw new ThreadParentError(
            "THREAD_PARENT_INVALID",
            sessionId,
            `parent thread not found: ${opts.parentThreadId}`,
          )
        }
        if (parent.read_only === 1) {
          throw new ThreadParentError(
            "THREAD_READONLY_PARENT",
            sessionId,
            `migrated lineage cannot fork: ${opts.parentThreadId}`,
          )
        }
        if (
          opts.forkEventSeq !== undefined &&
          (!Number.isInteger(opts.forkEventSeq) ||
            opts.forkEventSeq < 0 ||
            opts.forkEventSeq > parent.head_seq)
        ) {
          throw new ThreadParentError(
            "THREAD_FORK_SEQ_INVALID",
            sessionId,
            `fork seq ${opts.forkEventSeq} outside parent head ${parent.head_seq}`,
          )
        }
      }
      const now = Date.now()
      for (let attempt = 0; attempt < 3; attempt++) {
        const tid =
          opts?.threadId ??
          `th_${Math.floor(Math.random() * 0xffffffff)
            .toString(16)
            .padStart(8, "0")}`
        if (opts?.threadId && attempt > 0) {
          throw new Error(`thread already exists: ${sessionId}/${opts.threadId}`)
        }
        const ins = db
          .prepare(
            "INSERT OR IGNORE INTO threads (session_id, thread_id, parent_thread_id, fork_event_seq, head_seq, status, read_only, created_at) VALUES (?, ?, ?, ?, -1, 'active', 0, ?)",
          )
          .run(sessionId, tid, opts?.parentThreadId ?? null, opts?.forkEventSeq ?? null, now)
        if (ins.changes === 1) {
          return rowToThread({
            session_id: sessionId,
            thread_id: tid,
            parent_thread_id: opts?.parentThreadId ?? null,
            fork_event_seq: opts?.forkEventSeq ?? null,
            head_seq: -1,
            status: "active",
            read_only: 0,
            created_at: now,
          })
        }
      }
      throw new Error(`thread id allocation failed: ${sessionId}`)
    })()
  } finally {
    db.close()
  }
}

// Arsip: tetap terbaca, menolak tulis baru. Idempoten.
export function archiveThread(
  sessionId: string,
  threadId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): ThreadRow {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch)
      const row = db
        .prepare(
          "SELECT session_id, thread_id, parent_thread_id, fork_event_seq, head_seq, status, read_only, created_at FROM threads WHERE session_id = ? AND thread_id = ?",
        )
        .get(sessionId, threadId) as ThreadRow | null
      if (!row) throw new Error(`thread not found: ${sessionId}/${threadId}`)
      db.prepare(
        "UPDATE threads SET status = 'archived' WHERE session_id = ? AND thread_id = ?",
      ).run(sessionId, threadId)
      return rowToThread({ ...row, status: "archived" })
    })()
  } finally {
    db.close()
  }
}

// ── P2.5 — backfill + append eksplisit ────────────────────────────────────
// Backfill: baris legacy (event_id NULL) mendapat id TURUNAN deterministik
// + migrated=1, TANPA menyentuh konten/seq/thread/timestamp. Idempoten
// (non-NULL dilewati; derivasi sama → hasil sama). Fenced bila diminta.
// Append eksplisit: SATU-SATUNYA jalur per-event (P2.6+ akan memakainya);
// saveSession tetap satu-satunya penulis produksi volume saat ini.

export function backfillHistoryEventIds(
  sessionId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): number {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch)
      const rows = db
        .prepare(
          "SELECT seq, thread_id FROM messages WHERE session_id = ? AND event_id IS NULL ORDER BY seq",
        )
        .all(sessionId) as { seq: number; thread_id: string | null }[]
      let backfilled = 0
      const upd = db.prepare(
        "UPDATE messages SET event_id = ?, migrated = 1 WHERE session_id = ? AND seq = ? AND event_id IS NULL",
      )
      for (const r of rows) {
        // Thread derivasi: kolom thread milik ensure (P2.4); derivasi memakai
        // nilai resolved agar stabil baik sebelum maupun sesudah backfill-nya.
        const tid = r.thread_id ?? DEFAULT_THREAD_ID
        const derived = deriveLegacyHistoryEventId(sessionId, tid, r.seq)
        backfilled += upd.run(derived, sessionId, r.seq).changes
      }
      return backfilled
    })()
  } finally {
    db.close()
  }
}

export interface HistoryEventInput {
  role: string
  content: unknown
  toolCalls?: unknown
  toolCallId?: string
  name?: string
  reasoning?: string
  isError?: boolean
}

export type AppendHistoryEventOutcome =
  | { outcome: "appended"; seq: number; eventId: string }
  | { outcome: "duplicate"; seq: number; eventId: string }

// Jalur append per-event kanonik: alokasi (atau id eksplisit valid) +
// append + head, SATU txn berpagar. Duplikat identik = idempoten tanpa seq
// baru; payload beda = REFUSED_EVENT_ID_CONFLICT (asli otoritatif).
export function appendHistoryEvent(
  sessionId: string,
  threadId: string,
  event: HistoryEventInput,
  cwd?: string,
  opts?: { eventId?: string; runId?: string; expectedEpoch?: number },
): AppendHistoryEventOutcome {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch)
      const thread = db
        .prepare("SELECT status FROM threads WHERE session_id = ? AND thread_id = ?")
        .get(sessionId, threadId) as { status: string } | null
      if (!thread) throw new Error(`thread not found: ${sessionId}/${threadId}`)
      if (thread.status === "archived") throw new ThreadArchivedError(sessionId, threadId)
      let eid: string
      if (opts?.eventId !== undefined) {
        if (!isHistoryEventId(opts.eventId)) throw new EventIdInvalidError(opts.eventId)
        eid = opts.eventId
      } else {
        eid = allocateHistoryEventId()
      }
      const want = [
        event.role,
        safeContent(event.content),
        safeContent(event.toolCalls ?? null),
        (event.toolCallId ?? null) as string | null,
        (event.name ?? null) as string | null,
        typeof event.reasoning === "string" ? safeContent(event.reasoning) : null,
        event.isError === true ? 1 : 0,
      ] as const
      const existing = db
        .prepare(
          "SELECT seq, role, content, toolCalls, toolCallId, name, reasoning, is_error FROM messages WHERE session_id = ? AND thread_id = ? AND event_id = ?",
        )
        .get(sessionId, threadId, eid) as {
        seq: number
        role: string
        content: string
        toolCalls: string
        toolCallId: string | null
        name: string | null
        reasoning: string | null
        is_error: number | null
      } | null
      if (existing) {
        const same =
          existing.role === want[0] &&
          existing.content === want[1] &&
          existing.toolCalls === want[2] &&
          (existing.toolCallId ?? null) === want[3] &&
          (existing.name ?? null) === want[4] &&
          (existing.reasoning ?? null) === want[5] &&
          (existing.is_error ?? 0) === want[6]
        if (!same) throw new EventIdConflictError(sessionId, threadId, eid)
        return { outcome: "duplicate", seq: existing.seq, eventId: eid } as const
      }
      const maxRow = db
        .prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id = ? AND thread_id = ?")
        .get(sessionId, threadId) as { m: number | null } | null
      const seq = (maxRow?.m ?? -1) + 1
      const now = Date.now()
      db.prepare(
        "INSERT INTO messages (session_id, thread_id, seq, role, content, toolCalls, toolCallId, name, reasoning, is_error, ts, event_id, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        sessionId,
        threadId,
        seq,
        want[0],
        want[1],
        want[2],
        want[3],
        want[4],
        want[5],
        want[6],
        now,
        eid,
        opts?.runId ?? null,
      )
      recomputeThreadHeadInTxn(db, sessionId, threadId)
      // P2.6: event + kursor dalam SATU txn yang sama. Jalur append per-event
      // tak boleh jadi celah "event durable tapi kursor basi".
      if (opts?.runId !== undefined) {
        // Run terminal = kursor beku: event tetap durable (histori tak
        // dibuang diam-diam), tapi posisi run tak lagi bergerak.
        const st = db.prepare("SELECT status FROM runs WHERE run_id = ?").get(opts.runId) as {
          status: string
        } | null
        if (!st) throw new Error(`run not found: ${opts.runId}`)
        if (!RUN_TERMINAL.has(st.status)) advanceRunCursorInTxn(db, opts.runId, seq, sessionId)
      }
      return { outcome: "appended", seq, eventId: eid } as const
    })()
  } finally {
    db.close()
  }
}

// ── P2.6 — Run durable + kursor ───────────────────────────────────────────
// Run = SATU instans eksekusi pada (session_id, thread_id). BUKAN histori,
// BUKAN thread, BUKAN loop. Status minimal: CREATED→RUNNING→terminal
// (COMPLETED|INTERRUPTED|FAILED). Kursor = last_persisted_seq (posisi
// persistensi, bukan token/usaha). ≤1 RUNNING per SESSION ditegakkan
// partial-unique-index (ras-aman, tanpa TOCTOU). Semua mutasi berpagar epoch.

export type RunStatus = "CREATED" | "RUNNING" | "COMPLETED" | "INTERRUPTED" | "FAILED"

const RUN_TERMINAL: ReadonlySet<string> = new Set(["COMPLETED", "INTERRUPTED", "FAILED"])

export interface RunRow {
  run_id: string
  session_id: string
  thread_id: string
  status: RunStatus
  started_at: number
  ended_at: number | null
  last_persisted_seq: number
  pending_tool_ids: string
  recovery_status: string | null
  takeover_epoch: number | null
  created_at: number
}

const RUN_ID_RE = /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_RE.test(value)
}

// SATU-SATUNYA allocator RunId produksi (CSPRNG; domain sesi, berbeda dari
// exec_/dsp_/attempt — lihat keputusan §6 laporan: tak ada reuse).
export function allocateRunId(): string {
  return `run_${randomUUID()}`
}

export class RunStatusError extends Error {
  readonly code = "RUN_INVALID_TRANSITION"
  constructor(runId: string, from: string, to: string) {
    super(`[run] RUN_INVALID_TRANSITION ${runId}: ${from} → ${to} refused`)
    this.name = "RunStatusError"
  }
}

export class RunTerminalConflictError extends Error {
  readonly code = "RUN_TERMINAL_CONFLICT"
  constructor(runId: string, from: string, to: string) {
    super(
      `[run] RUN_TERMINAL_CONFLICT ${runId}: already terminal ${from}, refusing conflicting ${to} (first terminal wins)`,
    )
    this.name = "RunTerminalConflictError"
  }
}

export class RunRunningExistsError extends Error {
  readonly code = "RUNNING_EXISTS"
  constructor(sessionId: string) {
    super(`[run] RUNNING_EXISTS ${sessionId}: a RUNNING run already holds this session`)
    this.name = "RunRunningExistsError"
  }
}

export class RunCursorError extends Error {
  readonly code: "RUN_CURSOR_BACKWARD" | "RUN_CURSOR_BEYOND_HEAD" | "RUN_CURSOR_FOREIGN"
  constructor(code: RunCursorError["code"], runId: string, detail: string) {
    super(`[run] ${code} ${runId}: ${detail}`)
    this.name = "RunCursorError"
    this.code = code
  }
}

export class RunPendingError extends Error {
  readonly code = "RUN_PENDING_MALFORMED"
  constructor(detail: string) {
    super(`[run] RUN_PENDING_MALFORMED: ${detail}`)
    this.name = "RunPendingError"
  }
}

function rowToRun(row: RunRow): RunRow {
  return { ...row }
}

const RUN_COLUMNS =
  "run_id, session_id, thread_id, status, started_at, ended_at, last_persisted_seq, pending_tool_ids, recovery_status, takeover_epoch, created_at"

export function getRun(runId: string, cwd?: string): RunRow | null {
  const db = open(cwd)
  try {
    const row = db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`)
      .get(runId) as RunRow | null
    return row ? rowToRun(row) : null
  } finally {
    db.close()
  }
}

export function listSessionRuns(sessionId: string, cwd?: string): RunRow[] {
  const db = open(cwd)
  try {
    return (
      db
        .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE session_id = ? ORDER BY started_at`)
        .all(sessionId) as RunRow[]
    ).map(rowToRun)
  } finally {
    db.close()
  }
}

// RUNNING aktif sesi ini (0-atau-1 menurut partial index; defensif LIMIT 1).
export function getActiveRun(sessionId: string, cwd?: string): RunRow | null {
  const db = open(cwd)
  try {
    const row = db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE session_id = ? AND status = 'RUNNING' LIMIT 1`,
      )
      .get(sessionId) as RunRow | null
    return row ? rowToRun(row) : null
  } finally {
    db.close()
  }
}

// Penilaian pulih read-only (tak pernah memutasi): ketidakpastian TERSIMPAN
// (recovery_status UNKNOWN) atau RUNNING tanpa holder hidup = UNKNOWN;
// sisanya NONE. Persistensi resolusi milik fase mendatang; P2.6 hanya
// menombak yang mati pasti + menilainya jujur.
export function assessRunRecoveryStatus(run: RunRow): "NONE" | "UNKNOWN" {
  if (run.recovery_status === "UNKNOWN") return "UNKNOWN"
  if (run.status === "RUNNING") return "UNKNOWN"
  return "NONE"
}

function validatePendingToolIds(value: unknown): string {
  if (!Array.isArray(value)) throw new RunPendingError("pending_tool_ids must be an array")
  if (value.length > 256) throw new RunPendingError("pending_tool_ids exceeds 256 entries")
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 512) {
      throw new RunPendingError("pending_tool_ids entries must be non-empty strings ≤512 chars")
    }
  }
  return JSON.stringify(value)
}

// Satu jalur create produksi: validasi kepemilikan (thread milik sesi) +
// pagar epoch + baris CREATED (kursor = head saat ini, netral) + epoch
// takeover tercatat. Status awal SELALU CREATED; pemanggil yang
// mempromosikan ke RUNNING via transitionRun (dua langkah eksplisit).
export function createRun(
  sessionId: string,
  threadId: string,
  cwd?: string,
  opts?: { runId?: string; pendingToolIds?: unknown; expectedEpoch?: number },
): RunRow {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch)
      if (!sessionRowExistsInTxn(db, sessionId)) throw new Error(`session not found: ${sessionId}`)
      const thread = db
        .prepare("SELECT thread_id FROM threads WHERE session_id = ? AND thread_id = ?")
        .get(sessionId, threadId) as { thread_id: string } | null
      if (!thread) throw new Error(`thread not found: ${sessionId}/${threadId}`)
      const runId = opts?.runId ?? allocateRunId()
      if (!isRunId(runId)) throw new Error(`invalid run id: ${opts?.runId}`)
      const pending =
        opts?.pendingToolIds !== undefined ? validatePendingToolIds(opts.pendingToolIds) : "[]"
      const now = Date.now()
      const headRow = db
        .prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id = ? AND thread_id = ?")
        .get(sessionId, threadId) as { m: number | null } | null
      // Head thread kosong = -1, tapi kursor run punya CHECK >= 0 dan harus
      // menunjuk posisi histori yang benar-benar durable: kursor awal 0 pada
      // thread kosong berarti "belum ada event milik run ini" (bukan klaim
      // bahwa seq 0 milik run ini — kepemilikan dicek saat advance).
      const head = Math.max(headRow?.m ?? -1, 0)
      const epochRow = db
        .prepare("SELECT writer_epoch AS epoch FROM sessions WHERE id = ?")
        .get(sessionId) as {
        epoch: number
      }
      db.prepare(
        "INSERT INTO runs (run_id, session_id, thread_id, status, started_at, ended_at, last_persisted_seq, pending_tool_ids, recovery_status, takeover_epoch, created_at) VALUES (?, ?, ?, 'CREATED', ?, NULL, ?, ?, 'NONE', ?, ?)",
      ).run(runId, sessionId, threadId, now, head, pending, epochRow.epoch, now)
      return rowToRun({
        run_id: runId,
        session_id: sessionId,
        thread_id: threadId,
        status: "CREATED",
        started_at: now,
        ended_at: null,
        last_persisted_seq: head,
        pending_tool_ids: pending,
        recovery_status: "NONE",
        takeover_epoch: epochRow.epoch,
        created_at: now,
      })
    })()
  } finally {
    db.close()
  }
}

function sessionRowExistsInTxn(db: Database, sessionId: string): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM sessions WHERE id = ?").get(sessionId) as {
    ok: number
  } | null
  return row !== null
}

const RUN_EDGES: Record<RunStatus, readonly RunStatus[]> = {
  CREATED: ["RUNNING", "COMPLETED", "INTERRUPTED", "FAILED"],
  RUNNING: ["COMPLETED", "INTERRUPTED", "FAILED"],
  COMPLETED: ["COMPLETED"],
  INTERRUPTED: ["INTERRUPTED"],
  FAILED: ["FAILED"],
}

// Transisi status fenced. Terminal→sama = idempoten (ended_at pertama menang);
// terminal→beda = konflik (first terminal wins, bukan last-writer-wins).
// RUNNING kedua konkuren = constraint partial-index → RUNNING_EXISTS terstruktur.
export function transitionRun(
  runId: string,
  to: RunStatus,
  cwd?: string,
  opts?: { expectedEpoch?: number; recoveryStatus?: string },
): RunRow {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      const row = db
        .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`)
        .get(runId) as RunRow | null
      if (!row) throw new Error(`run not found: ${runId}`)
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, row.session_id, opts.expectedEpoch)
      // Terminal: dua kelas penolakan dibedakan agar diagnosis jujur —
      // terminal→terminal lain = konflik first-wins; terminal→non-terminal
      // = tepi ilegal (bukan "konflik" — tak ada klaim terminal kedua).
      if (RUN_TERMINAL.has(row.status)) {
        if (row.status === to) return rowToRun(row)
        if (RUN_TERMINAL.has(to)) throw new RunTerminalConflictError(runId, row.status, to)
        throw new RunStatusError(runId, row.status, to)
      }
      if (!RUN_EDGES[row.status].includes(to)) throw new RunStatusError(runId, row.status, to)
      const now = Date.now()
      const terminal = RUN_TERMINAL.has(to)
      const recovery = to === "INTERRUPTED" ? (opts?.recoveryStatus ?? "NONE") : "NONE"
      try {
        db.prepare(
          "UPDATE runs SET status = ?, ended_at = ?, recovery_status = ? WHERE run_id = ?",
        ).run(to, terminal ? now : null, recovery, runId)
      } catch (e) {
        if (isRunningUniquenessViolation(e)) throw new RunRunningExistsError(row.session_id)
        throw e
      }
      return rowToRun({
        ...row,
        status: to,
        ended_at: terminal ? now : row.ended_at,
        recovery_status: recovery,
      })
    })()
  } finally {
    db.close()
  }
}

function isRunningUniquenessViolation(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e)
  return msg.includes("UNIQUE constraint failed") && msg.includes("runs")
}

export function completeRun(
  runId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): RunRow {
  return transitionRun(runId, "COMPLETED", cwd, opts)
}

export function failRun(runId: string, cwd?: string, opts?: { expectedEpoch?: number }): RunRow {
  return transitionRun(runId, "FAILED", cwd, opts)
}

export function interruptRun(
  runId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number; recoveryStatus?: string },
): RunRow {
  return transitionRun(runId, "INTERRUPTED", cwd, opts)
}

// Kursor eksplisit: monoton (CAS pada nilai terbaca — tanpa lost-update),
// dalam-head, milik-run ini (NULL warisan boleh; run lain ditolak).
// Versi in-txn dipakai appendHistoryEvent supaya event+kursor satu commit.
function advanceRunCursorInTxn(
  db: Database,
  runId: string,
  seq: number,
  expectSessionId: string | undefined,
  opts?: { expectedEventId?: string },
): RunRow {
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`)
    .get(runId) as RunRow | null
  if (!row) throw new Error(`run not found: ${runId}`)
  if (expectSessionId !== undefined && row.session_id !== expectSessionId)
    throw new Error(`run ${runId} does not belong to session ${expectSessionId}`)
  if (RUN_TERMINAL.has(row.status))
    throw new RunStatusError(runId, row.status, `${row.status}+cursor`)
  if (!Number.isInteger(seq) || seq < 0)
    throw new RunCursorError("RUN_CURSOR_BEYOND_HEAD", runId, `invalid seq ${seq}`)
  const target = db
    .prepare(
      "SELECT seq, run_id, event_id FROM messages WHERE session_id = ? AND thread_id = ? AND seq = ?",
    )
    .get(row.session_id, row.thread_id, seq) as {
    seq: number
    run_id: string | null
    event_id: string | null
  } | null
  if (!target)
    throw new RunCursorError("RUN_CURSOR_BEYOND_HEAD", runId, `no durable event at seq ${seq}`)
  if (target.run_id !== null && target.run_id !== runId) {
    throw new RunCursorError(
      "RUN_CURSOR_FOREIGN",
      runId,
      `seq ${seq} belongs to run ${target.run_id}`,
    )
  }
  if (opts?.expectedEventId !== undefined && target.event_id !== opts.expectedEventId) {
    throw new RunCursorError("RUN_CURSOR_FOREIGN", runId, `seq ${seq} event mismatch`)
  }
  if (seq < row.last_persisted_seq) {
    throw new RunCursorError(
      "RUN_CURSOR_BACKWARD",
      runId,
      `${row.last_persisted_seq} → ${seq} refused (no rewind in P2.6)`,
    )
  }
  if (seq === row.last_persisted_seq) return rowToRun(row)
  const upd = db
    .prepare("UPDATE runs SET last_persisted_seq = ? WHERE run_id = ? AND last_persisted_seq = ?")
    .run(seq, runId, row.last_persisted_seq)
  if (upd.changes === 0) {
    const cur = db.prepare("SELECT last_persisted_seq FROM runs WHERE run_id = ?").get(runId) as {
      last_persisted_seq: number
    }
    throw new RunCursorError(
      "RUN_CURSOR_BACKWARD",
      runId,
      `concurrent advance observed (now ${cur.last_persisted_seq})`,
    )
  }
  return rowToRun({ ...row, last_persisted_seq: seq })
}

export function advanceRunCursor(
  runId: string,
  seq: number,
  cwd?: string,
  opts?: { expectedEpoch?: number; expectedEventId?: string },
): RunRow {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined) {
        const owner = db.prepare("SELECT session_id FROM runs WHERE run_id = ?").get(runId) as {
          session_id: string
        } | null
        if (!owner) throw new Error(`run not found: ${runId}`)
        assertWriterEpochInTxn(db, owner.session_id, opts.expectedEpoch)
      }
      return advanceRunCursorInTxn(db, runId, seq, undefined, opts)
    })()
  } finally {
    db.close()
  }
}

// Metadata pending_tool_ids (dorman P2.6): round-trip tervalidasi, fenced.
// BUKAN bukti eksekusi — tak ada semantik tool di sini.
export function setRunPendingTools(
  runId: string,
  pendingToolIds: unknown,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): RunRow {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      const row = db
        .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`)
        .get(runId) as RunRow | null
      if (!row) throw new Error(`run not found: ${runId}`)
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, row.session_id, opts.expectedEpoch)
      const pending = validatePendingToolIds(pendingToolIds)
      db.prepare("UPDATE runs SET pending_tool_ids = ? WHERE run_id = ?").run(pending, runId)
      return rowToRun({ ...row, pending_tool_ids: pending })
    })()
  } finally {
    db.close()
  }
}

// Tombstone crash-residue: SEMUA RUNNING sesi ini (tanpa holder hidup —
// admission membuktikannya) menjadi INTERRUPTED + recovery UNKNOWN dengan
// ended_at NULL (kematian tak terobservasi). Satu statement (atomik, tanpa
// TOCTOU). BUKAN auto-continue/replay: resolusi milik fase mendatang.
// Fenced; idempoten (pemanggilan kedua nihil).
export function tombstoneDeadRuns(
  sessionId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): number {
  const db = open(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch)
      const res = db
        .prepare(
          "UPDATE runs SET status = 'INTERRUPTED', recovery_status = 'UNKNOWN' WHERE session_id = ? AND status = 'RUNNING'",
        )
        .run(sessionId)
      return res.changes
    })()
  } finally {
    db.close()
  }
}

// ── P2.7 — Projection foundation ────────────────────────────────────────────
// Proyeksi = representasi TURUNAN dari messages (read-only build, rebuildable,
// tak pernah otoritatif). Satu-satunya jenis P2.7: "summary" (ringkasan prefix).
// base_seq EKSKLUSIF: base_seq = N ⟺ cakupan [0,N). Validitas TIDAK PERNAH
// memakai run_id / last_persisted_seq (amendemen P2.6: kursor = watermark
// posisional, bukan kepemilikan). Jangkar identitas = anchor_event_id.

// P2.7: satu-satunya projection_id yang diizinkan. Kosakata tetap (bukan
// alokasi): jenis baru milik fase mendatang, tak boleh berspekulasi kini.
export const SUMMARY_PROJECTION_ID = "summary"
const PROJECTION_IDS = [SUMMARY_PROJECTION_ID] as const
// Batas defensif ukuran ringkasan (murah vs budget token ringkasan LLM, namun
// menolak baris multi-MB akibat misuse API). Bukan kebijakan token/budget.
const MAX_PROJECTION_SUMMARY_CHARS = 512 * 1024

export class ProjectionValidationError extends Error {
  readonly code = "PROJECTION_INVALID"
  constructor(detail: string) {
    super(`[projection] PROJECTION_INVALID: ${detail}`)
    this.name = "ProjectionValidationError"
  }
}

// P2.7: saveSession HANYA append-only. Riwayat menyusut/berubah isi menuntut
// jalur eksplisit shrinkThreadHistory (provenance + invalidasi + pagar run).
export class RefusedHistoryRewriteError extends Error {
  readonly code = "REFUSED_HISTORY_REWRITE"
  /**
   * True bila kanonik TUMBUH melampaui buffer (buffer = prefix sejati stored):
   * penulis lain menambah baris setelah buffer dibaca. Composition root WAJIB
   * menolak shrink otomatis pada kasus ini (baris penulis lain tak boleh
   * dihancurkan) — lihat I2. Dihitung di titik throw agar tak perlu query lagi.
   */
  readonly grewBeyondBuffer: boolean
  constructor(sessionId: string, threadId: string, detail: string, grewBeyondBuffer = false) {
    super(
      `[persist] REFUSED_HISTORY_REWRITE ${sessionId}/${threadId}: ${detail} — use shrinkThreadHistory`,
    )
    this.name = "RefusedHistoryRewriteError"
    this.grewBeyondBuffer = grewBeyondBuffer
  }
}

// P2.7 Policy A: shrink dilarang selama ada RUNNING (tanpa rewind/clamp/rebase).
export class RefusedShrinkLiveRunError extends Error {
  readonly code = "REFUSED_SHRINK_LIVE_RUN"
  constructor(sessionId: string) {
    super(
      `[persist] REFUSED_SHRINK_LIVE_RUN ${sessionId}: shrink requires no live RUNNING run (terminal-mark first)`,
    )
    this.name = "RefusedShrinkLiveRunError"
  }
}

export interface ProjectionRow {
  session_id: string
  thread_id: string
  projection_id: string
  base_seq: number
  summary_text: string
  included_ranges: string
  built_at: number
  anchor_event_id: string | null
}

export type ProjectionState = "CURRENT" | "STALE" | "INCOMPLETE" | "CORRUPT" | "UNKNOWN"

export interface ProjectionStatus {
  state: ProjectionState
  detail: string
}

const PROJECTION_COLUMNS =
  "session_id, thread_id, projection_id, base_seq, summary_text, included_ranges, built_at, anchor_event_id"

function rowToProjection(row: ProjectionRow): ProjectionRow {
  return { ...row }
}

function validateProjectionId(projectionId: string): void {
  if (!(PROJECTION_IDS as readonly string[]).includes(projectionId)) {
    throw new ProjectionValidationError(
      `unknown projection_id "${projectionId}" (allowed: ${PROJECTION_IDS.join(", ")})`,
    )
  }
}

// Validasi ketat bentuk kanonik P2.7: [] atau [[0,N]]. Bukan normalisasi —
// pembaca tak pernah memperbaiki data tersimpan (temuan korupsi = CORRUPT).
function parseIncludedRangesStrict(raw: string): { ok: true; end: number } | { ok: false } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  if (!Array.isArray(parsed)) return { ok: false }
  if (parsed.length === 0) return { ok: true, end: 0 }
  if (parsed.length !== 1) return { ok: false }
  const only = parsed[0]
  if (!Array.isArray(only) || only.length !== 2) return { ok: false }
  const [start, end] = only as unknown[]
  if (!Number.isInteger(start) || !Number.isInteger(end)) return { ok: false }
  if ((start as number) !== 0 || (end as number) <= 0) return { ok: false }
  return { ok: true, end: end as number }
}

function canonicalRangesFor(baseSeq: number): string {
  return baseSeq === 0 ? "[]" : JSON.stringify([[0, baseSeq]])
}

function threadHeadInTxn(db: Database, sessionId: string, threadId: string): number {
  const row = db
    .prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id = ? AND thread_id = ?")
    .get(sessionId, threadId) as { m: number | null } | null
  return row?.m ?? -1
}

// Kepala thread (baca-saja, tanpa txn tulis). Dipakai composition root untuk
// mendeteksi shrink sebelum memilih jalur persist.
export function getThreadHead(sessionId: string, threadId: string, cwd?: string): number {
  const db = open(cwd)
  try {
    return threadHeadInTxn(db, sessionId, threadId)
  } finally {
    db.close()
  }
}

// Baca proyeksi mentah (tanpa penilaian). NULL = "tak ada proyeksi" (bukan
// histori kosong — fallback ke messages milik pemanggil, di luar otoritas ini).
export function getProjection(
  sessionId: string,
  threadId: string,
  projectionId: string,
  cwd?: string,
): ProjectionRow | null {
  validateProjectionId(projectionId)
  const db = open(cwd)
  try {
    const row = db
      .prepare(
        `SELECT ${PROJECTION_COLUMNS} FROM history_projections WHERE session_id = ? AND thread_id = ? AND projection_id = ?`,
      )
      .get(sessionId, threadId, projectionId) as ProjectionRow | null
    return row ? rowToProjection(row) : null
  } finally {
    db.close()
  }
}

// Mesin validitas deterministik (kontrak §8). Murni baca; tak pernah rebuild,
// tak pernah mutasi, tak pernah memakai run_id/kursor.
export function getProjectionStatus(
  sessionId: string,
  threadId: string,
  projectionId: string,
  cwd?: string,
): ProjectionStatus {
  validateProjectionId(projectionId)
  const db = open(cwd)
  try {
    const thread = db
      .prepare("SELECT 1 AS ok FROM threads WHERE session_id = ? AND thread_id = ?")
      .get(sessionId, threadId) as { ok: number } | null
    // 1. Thread hilang (baris yatim) → tak dapat dibuktikan → UNKNOWN.
    if (!thread) return { state: "UNKNOWN", detail: "thread row missing" }
    const row = db
      .prepare(
        `SELECT ${PROJECTION_COLUMNS} FROM history_projections WHERE session_id = ? AND thread_id = ? AND projection_id = ?`,
      )
      .get(sessionId, threadId, projectionId) as ProjectionRow | null
    // Baris absen = "tak ada proyeksi" (bukan klaim apa pun).
    if (!row) return { state: "UNKNOWN", detail: "no projection row" }
    const head = threadHeadInTxn(db, sessionId, threadId)
    // 2. Bentuk tak-kanonik → CORRUPT (pembaca tak memperbaiki data).
    const parsed = parseIncludedRangesStrict(row.included_ranges)
    if (!parsed.ok) return { state: "CORRUPT", detail: "included_ranges not canonical" }
    // 3. base_seq wajib sama dengan ujung cakupan.
    if (!Number.isInteger(row.base_seq) || row.base_seq < 0 || row.base_seq !== parsed.end) {
      return { state: "CORRUPT", detail: "base_seq != coverage end" }
    }
    // 4. Cakupan kosong + ringkasan isi → INCOMPLETE.
    if (parsed.end === 0) {
      return row.summary_text === ""
        ? { state: "CURRENT", detail: "empty coverage, empty summary" }
        : { state: "INCOMPLETE", detail: "empty coverage with summary content" }
    }
    // 5. Klaim di luar kemungkinan → CORRUPT (jalur shrink menghapus proyeksi
    // yang terdampak secara atomik, jadi yang selamat namun mustahil = rusak).
    if (row.base_seq > head + 1) {
      return { state: "CORRUPT", detail: "base_seq beyond head+1" }
    }
    // 6. Jangkar hilang padahal cakupan isi → CORRUPT (invariant penulis).
    if (row.anchor_event_id === null) {
      return { state: "CORRUPT", detail: "missing anchor_event_id" }
    }
    // 7. Baris batas hilang/berubah identitas → STALE (sumber bergerak).
    const anchor = db
      .prepare("SELECT event_id FROM messages WHERE session_id = ? AND thread_id = ? AND seq = ?")
      .get(sessionId, threadId, row.base_seq - 1) as { event_id: string | null } | null
    if (!anchor || anchor.event_id !== row.anchor_event_id) {
      return { state: "STALE", detail: "boundary event changed or gone" }
    }
    // 8. Kepala melampaui cakupan → STALE (ada baris baru tak-tercakup).
    if (head >= row.base_seq) return { state: "STALE", detail: "head advanced beyond coverage" }
    // 9. head == base_seq-1 + jangkar cocok → CURRENT.
    return { state: "CURRENT", detail: "coverage matches head, anchor holds" }
  } finally {
    db.close()
  }
}

// Inti build DALAM txn pemanggil: validasi → hapus-baris-lama → sisipkan.
// Dipakai buildProjection (mandiri) dan rebuildProjection (nama eksplisit).
// summaryText dari PEMANGGIL (seam kompaksi yang ada) — lapisan ini tak pernah
// membangkitkan teks (tanpa LLM, tanpa vendor, tanpa run/cursor).
function buildProjectionInTxn(
  db: Database,
  sessionId: string,
  threadId: string,
  projectionId: string,
  summaryText: string,
  baseSeq: number | undefined,
): ProjectionRow {
  validateProjectionId(projectionId)
  if (!sessionRowExistsInTxn(db, sessionId)) throw new Error(`session not found: ${sessionId}`)
  const thread = db
    .prepare("SELECT 1 AS ok FROM threads WHERE session_id = ? AND thread_id = ?")
    .get(sessionId, threadId) as { ok: number } | null
  if (!thread) throw new Error(`thread not found: ${sessionId}/${threadId}`)
  const head = threadHeadInTxn(db, sessionId, threadId)
  const b = baseSeq ?? head + 1
  if (!Number.isInteger(b) || b < 0 || b > head + 1) {
    throw new ProjectionValidationError(`base_seq ${String(b)} out of [0, head+1=${head + 1}]`)
  }
  if (typeof summaryText !== "string")
    throw new ProjectionValidationError("summary_text not a string")
  if (summaryText.length > MAX_PROJECTION_SUMMARY_CHARS) {
    throw new ProjectionValidationError("summary_text exceeds size cap")
  }
  // Emisi kanonik: cakupan kosong ⟺ ringkasan kosong (fail-closed di penulis;
  // baris INCOMPLETE hanya bisa datang dari tulisan tangan, dibaca jujur).
  if ((b === 0) !== (summaryText === "")) {
    throw new ProjectionValidationError("empty coverage requires empty summary and vice versa")
  }
  // Jangkar identitas batas + bukti tak ada event_id NULL dalam cakupan
  // (fail-closed: taksir tak boleh menutupi lubang identitas).
  let anchor: string | null = null
  if (b > 0) {
    const row = db
      .prepare("SELECT event_id FROM messages WHERE session_id = ? AND thread_id = ? AND seq = ?")
      .get(sessionId, threadId, b - 1) as { event_id: string | null } | null
    if (!row || row.event_id === null) {
      throw new ProjectionValidationError("boundary event missing event_id")
    }
    anchor = row.event_id
    const holes = db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND thread_id = ? AND seq < ? AND event_id IS NULL",
      )
      .get(sessionId, threadId, b) as { n: number }
    if (holes.n > 0) throw new ProjectionValidationError("covered range has NULL event_id rows")
  }
  const now = Date.now()
  const ranges = canonicalRangesFor(b)
  db.prepare(
    "DELETE FROM history_projections WHERE session_id = ? AND thread_id = ? AND projection_id = ?",
  ).run(sessionId, threadId, projectionId)
  db.prepare(
    "INSERT INTO history_projections (session_id, thread_id, projection_id, base_seq, summary_text, included_ranges, built_at, anchor_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(sessionId, threadId, projectionId, b, summaryText, ranges, now, anchor)
  return {
    session_id: sessionId,
    thread_id: threadId,
    projection_id: projectionId,
    base_seq: b,
    summary_text: summaryText,
    included_ranges: ranges,
    built_at: now,
    anchor_event_id: anchor,
  }
}

// Jalur build kanonik: baca histori komit → validasi → ganti baris, SATU txn
// berpagar. Tak menyentuh messages (baca-saja atas sumber).
export function buildProjection(
  sessionId: string,
  threadId: string,
  summaryText: string,
  cwd?: string,
  opts?: { expectedEpoch?: number; baseSeq?: number; projectionId?: string },
): ProjectionRow {
  if (opts?.expectedEpoch === undefined) {
    throw new ProjectionValidationError("expectedEpoch is required for projection mutation")
  }
  const db = open(cwd)
  try {
    return db.transaction(() => {
      assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch as number)
      return buildProjectionInTxn(
        db,
        sessionId,
        threadId,
        opts?.projectionId ?? SUMMARY_PROJECTION_ID,
        summaryText,
        opts?.baseSeq,
      )
    })()
  } finally {
    db.close()
  }
}

// Rebuild eksplisit = build ulang dari messages kanonik (semantik identik,
// nama eksplisit untuk niat). Idempoten: sumber sama → baris ekuivalen semantik
// (built_at boleh beda — stempel waktu, bukan klaim cakupan). Pagar sendiri
// (bukan delegasi) agar setiap mutator publik visibel berpagar di guard statis.
export function rebuildProjection(
  sessionId: string,
  threadId: string,
  summaryText: string,
  cwd?: string,
  opts?: { expectedEpoch?: number; baseSeq?: number; projectionId?: string },
): ProjectionRow {
  if (opts?.expectedEpoch === undefined) {
    throw new ProjectionValidationError("expectedEpoch is required for projection mutation")
  }
  const db = open(cwd)
  try {
    return db.transaction(() => {
      assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch as number)
      return buildProjectionInTxn(
        db,
        sessionId,
        threadId,
        opts?.projectionId ?? SUMMARY_PROJECTION_ID,
        summaryText,
        opts?.baseSeq,
      )
    })()
  } finally {
    db.close()
  }
}

// Jalur shrink EKSPLISIT pengganti cabang DELETE+rewrite implisit saveSession.
// Urutan kontrak: pagar → tolak run live → ukur head (transien, tak disimpan)
// → hapus proyeksi thread → ganti histori → tandai baris ringkasan → commit.
// Baris adopsi identik mempertahankan identitas+atribusi; slot baru mendapat
// event_id fresh, run_id NULL, migrated_compacted=1 (provenance, bukan klaim
// rekonstruksi). turns tak tersentuh (catatan turn ≠ posisi seq).
export function shrinkThreadHistory(
  sessionId: string,
  threadId: string,
  newMessages: readonly unknown[],
  cwd?: string,
  opts?: { expectedEpoch?: number },
): { oldHead: number; newHead: number } {
  if (opts?.expectedEpoch === undefined) {
    throw new ProjectionValidationError("expectedEpoch is required for history shrink")
  }
  const db = open(cwd)
  const now = Date.now()
  try {
    return db.transaction(() => {
      assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch as number)
      if (!sessionRowExistsInTxn(db, sessionId)) throw new Error(`session not found: ${sessionId}`)
      // Thread default dijamin ada (migrasi kolom belum mematerialisasikannya;
      // jalur shrink boleh instantiate atomik — sama seperti saveSession).
      ensureDefaultThreadInTxn(db, sessionId, now)
      const thread = db
        .prepare("SELECT status FROM threads WHERE session_id = ? AND thread_id = ?")
        .get(sessionId, threadId) as { status: string } | null
      if (!thread) throw new Error(`thread not found: ${sessionId}/${threadId}`)
      if (thread.status === "archived") throw new ThreadArchivedError(sessionId, threadId)
      // Policy A: tanpa rewind/clamp/rebase diam-diam — shrink di bawah run
      // live DITOLAK eksplisit (terminal-mark dulu di composition root).
      const live = db
        .prepare("SELECT 1 AS ok FROM runs WHERE session_id = ? AND status = 'RUNNING'")
        .get(sessionId) as { ok: number } | null
      if (live) throw new RefusedShrinkLiveRunError(sessionId)
      // Kepala pra-shrink: pengukuran transien (cakup penghapusan), tak pernah
      // disimpan sebagai provenance (kontrak: tak ada konsumen old/new head).
      const oldHead = threadHeadInTxn(db, sessionId, threadId)
      const stored = db
        .prepare(
          "SELECT seq, role, content, toolCalls, toolCallId, name, reasoning, is_error, event_id, run_id, migrated, migrated_compacted, projection_note FROM messages WHERE session_id = ? AND thread_id = ? ORDER BY seq",
        )
        .all(sessionId, threadId) as {
        seq: number
        role: string
        content: string
        toolCalls: string
        toolCallId: string | null
        name: string | null
        reasoning: string | null
        is_error: number | null
        event_id: string | null
        run_id: string | null
        migrated: number
        migrated_compacted: number
        projection_note: string | null
      }[]
      const ins = db.prepare(
        "INSERT INTO messages (session_id, thread_id, seq, role, content, toolCalls, toolCallId, name, reasoning, is_error, ts, event_id, run_id, migrated, migrated_compacted, projection_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      db.prepare("DELETE FROM messages WHERE session_id = ? AND thread_id = ?").run(
        sessionId,
        threadId,
      )
      for (let i = 0; i < newMessages.length; i++) {
        const m = newMessages[i] as StoredMsg
        const w = norm(m)
        const got = stored[i]
        const same =
          got !== undefined &&
          got.seq === i &&
          got.role === w[0] &&
          got.content === w[1] &&
          got.toolCalls === w[2] &&
          (got.toolCallId ?? null) === w[3] &&
          (got.name ?? null) === w[4] &&
          (got.reasoning ?? null) === w[5] &&
          (got.is_error ?? 0) === w[6]
        if (same) {
          // Adopsi: identitas + atribusi + flag warisan dipertahankan utuh.
          ins.run(
            sessionId,
            threadId,
            i,
            w[0],
            w[1],
            w[2],
            w[3],
            w[4],
            w[5],
            w[6],
            now,
            got.event_id ?? allocateHistoryEventId(),
            got.run_id,
            got.migrated,
            got.migrated_compacted,
            got.projection_note,
          )
        } else {
          // Slot baru/berubah: identitas fresh, tanpa atribusi run (proyeksi
          // dan validitas tak boleh membaca klaim palsu), provenance shrink.
          ins.run(
            sessionId,
            threadId,
            i,
            w[0],
            w[1],
            w[2],
            w[3],
            w[4],
            w[5],
            w[6],
            now,
            allocateHistoryEventId(),
            null,
            0,
            1,
            null,
          )
        }
      }
      // Shrink menomori ulang seq: proyeksi thread mana pun tak lagi valid —
      // hapus SEMUA dalam txn yang sama (tak ada proyeksi basi yang selamat).
      db.prepare("DELETE FROM history_projections WHERE session_id = ? AND thread_id = ?").run(
        sessionId,
        threadId,
      )
      const newHead = recomputeThreadHeadInTxn(db, sessionId, threadId)
      return { oldHead, newHead }
    })()
  } finally {
    db.close()
  }
}

/**
 * [PHASE 6Q] THE CANONICAL SESSION DELETION OPERATION.
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
    // P2.9: anak Sub-Agent milik sesi yang dihapus ikut dibersihkan (garis
    // durable yang sama). Cascade eksplisit per-sesi (tanpa FK, sesuai
    // konvensi repo) — child TIDAK boleh jadi yatim yang masih RUNNING.
    const kids = db.prepare("SELECT id FROM sessions WHERE parent_session_id = ?").all(id) as {
      id: string
    }[]
    for (const kid of kids) {
      db.prepare("DELETE FROM history_projections WHERE session_id = ?").run(kid.id)
      db.prepare("DELETE FROM runs WHERE session_id = ?").run(kid.id)
      db.prepare("DELETE FROM threads WHERE session_id = ?").run(kid.id)
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(kid.id)
      db.prepare("DELETE FROM turns WHERE session_id = ?").run(kid.id)
      db.prepare("DELETE FROM presentation_events WHERE session_id = ?").run(kid.id)
      db.prepare("DELETE FROM sessions WHERE id = ?").run(kid.id)
    }
    // P2.2: peta alias + rekaman takeover ikut terhapus (satu txn sama).
    // Alias yatim ke sesi mati akan menggantung (resolve menolak via cek
    // baris, tapi akumulasi membingungkan audit); takeover yatim mengaburkan
    // generasi. Recreate id yang sama mulai bersih di SEMUA sumbu — selaras
    // dengan bump inkarnasi TaskStore (langkah 1 di atas).
    db.prepare("DELETE FROM session_aliases WHERE canonical = ?").run(id)
    db.prepare("DELETE FROM session_takeovers WHERE session_id = ?").run(id)
    // P2.4: baris Thread sesi ini (strict: handle selalu via open()).
    db.prepare("DELETE FROM threads WHERE session_id = ?").run(id)
    // P2.6: Run sesi ini ikut mati — recreate id yang sama tak boleh
    // mewarisi residu RUNNING/UNKNOWN dari incarnasi sebelumnya.
    db.prepare("DELETE FROM runs WHERE session_id = ?").run(id)
    db.prepare("DELETE FROM history_projections WHERE session_id = ?").run(id)
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
// P2.4: salinan membawa thread_id/event_id/run_id/migrated (identitas
// thread src, cakupan komposit dst). Baris default Thread dst dipastikan ada
// (garis otoritas baru, epoch 0). Fenced bila expectedEpoch disediakan.
export async function branchSession(
  srcId: string,
  dstId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): Promise<number> {
  if (!dstId || !/^[\w.-]{1,64}$/.test(dstId)) throw new Error("invalid branch session id")
  const db = open(cwd)
  const now = Date.now()
  let copied = 0
  const txn = db.transaction(() => {
    if (opts?.expectedEpoch !== undefined) assertWriterEpochInTxn(db, dstId, opts.expectedEpoch)
    const src = db.prepare("SELECT cwd, system FROM sessions WHERE id = ?").get(srcId) as {
      cwd: string
      system: string
    } | null
    if (!src) throw new Error(`session not found: ${srcId}`)
    db.prepare(
      "INSERT OR REPLACE INTO sessions (id, created_at, updated_at, cwd, system) VALUES (?, ?, ?, ?, ?)",
    ).run(dstId, now, now, src.cwd, src.system)
    // P2.2: cabang = garis otoritas BARU. Epoch sumber tak diwarisi (0):
    // penulis cabang mulai dari generasi awal domainnya sendiri.
    db.prepare("UPDATE sessions SET writer_epoch = 0, updated_at = ? WHERE id = ?").run(now, dstId)
    // P2.4: baris default Thread dst (komposit dst/th_default) + pointer.
    db.prepare(
      "INSERT OR IGNORE INTO threads (session_id, thread_id, parent_thread_id, fork_event_seq, head_seq, status, read_only, created_at) VALUES (?, ?, NULL, NULL, -1, 'active', 0, ?)",
    ).run(dstId, DEFAULT_THREAD_ID, now)
    db.prepare("UPDATE sessions SET default_thread_id = ? WHERE id = ?").run(
      DEFAULT_THREAD_ID,
      dstId,
    )
    const rows = db
      .prepare(
        "SELECT seq, role, content, toolCalls, toolCallId, name, reasoning, is_error, ts, thread_id, event_id, run_id, migrated, migrated_compacted, projection_note FROM messages WHERE session_id = ? ORDER BY seq",
      )
      .all(srcId) as {
      seq: number
      role: string
      content: string
      toolCalls: string
      toolCallId: string | null
      name: string | null
      reasoning: string | null
      is_error: number | null
      ts: number
      thread_id: string | null
      event_id: string | null
      run_id: string | null
      migrated: number
      migrated_compacted: number
      projection_note: string | null
    }[]
    const ins = db.prepare(
      "INSERT INTO messages (session_id, thread_id, seq, role, content, toolCalls, toolCallId, name, reasoning, is_error, ts, event_id, run_id, migrated, migrated_compacted, projection_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    for (const r of rows) {
      ins.run(
        dstId,
        r.thread_id ?? DEFAULT_THREAD_ID,
        r.seq,
        r.role,
        r.content,
        r.toolCalls,
        r.toolCallId,
        r.name,
        r.reasoning,
        r.is_error,
        r.ts,
        r.event_id,
        // P2.6: run_id TIDAK diwarisi. Baris run milik sesi sumber; menyalin
        // id-nya di dst = Lien Run Palsu (menunjuk run yang tak ada di dst).
        // EventId tetap dipertahankan (id event global, bukan milik run).
        null,
        r.migrated,
        r.migrated_compacted,
        r.projection_note,
      )
    }
    copied = rows.length
    // P2.4: baris Thread ikut disalin (identitas komposit membuat lineage
    // menunjuk dalam-dst secara otomatis; read_only warisan tetap; tanpa
    // traversal/merge — data saja). Head dihitung ulang per thread.
    db.prepare(
      "INSERT OR IGNORE INTO threads (session_id, thread_id, parent_thread_id, fork_event_seq, head_seq, status, read_only, created_at) SELECT ?, thread_id, parent_thread_id, fork_event_seq, head_seq, status, read_only, created_at FROM threads WHERE session_id = ?",
    ).run(dstId, srcId)
    const dstThreads = db
      .prepare("SELECT thread_id FROM threads WHERE session_id = ?")
      .all(dstId) as { thread_id: string }[]
    for (const t of dstThreads) recomputeThreadHeadInTxn(db, dstId, t.thread_id)
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
