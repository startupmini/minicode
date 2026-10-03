// M11 — Durable execution journal: HISTORY/EVIDENCE, bukan truth, bukan recovery.
//
// Kenapa berkas ini ada (P1 M11): Kernel (truth) + Event Plane (observasi)
// bersifat RAM-only; crash menghapusnya. Modul ini mencatat history durable
// (event + intent) ke SQLite sehingga M12 nanti dapat merekonstruksi bukti
// tanpa menebak. Arah SELALU: Kernel commit → event → journal append. TAK
// PERNAH sebaliknya.
//
// BUKAN: lifecycle authority (Kernel), recovery/replay/UNKNOWN-resolution
// (M12), scheduler bridge (M13), TaskStore/session claims, redispatch policy.
// Aturan yang dikunci (jangan dilonggarkan tanpa ADR baru):
// - Tiga sequence TERPISAH: executionVersion (Kernel) ≠ eventSequence (plane)
//   ≠ journalSequence (JURNAL INI, AUTOINCREMENT). Tak ada yang diturunkan
//   dari yang lain; monotonic ≠ gap-free (rollback dapat meninggalkan gap).
// - eventId UNIQUE → append ganda payload SAMA = satu record logis (atomic
//   dedupe); eventId SAMA + payload BEDA = IDENTITY_CONFLICT (perbandingan
//   kanonis; tak pernah overwrite; konflik tak alokasi sequence).
// - Durability jujur tiga-status: committed (transaksi SQLite) → checkpoint
//   FULL → durable-confirmed | durability-uncertain | failed. PASSIVE tak
//   dipakai (berhenti dini saat reader). confirmed = frame ter-checkpoint +
//   fsync-boundary flush (synchronous=FULL sementara); cakupan klaim = crash
//   proses + OS-crash pada storage yang menghormati fsync — BUKAN garansi
//   hardware/power-loss universal (dinyatakan eksplisit, bukan diklaim).
// - Record immutable: TANPA UPDATE/DELETE di modul ini (tak ada statementnya);
//   koreksi = event observasi baru. Hash integritas deterministik per record.
// - Intent-before-effect seam: noteIntent() untuk bukti intent durable SEBELUM
//   efek; terminal/intent/uncertain-flush TETAP DIBEDAKAN (UNKNOWN milik M12).
// - Synchronous append (caller block sampai commit/bounded-busy-fail); tanpa
//   queue tak terbatas; tanpa retry tak terbatas (3× bounded, busy-only).
// - Redaction di batas tulis (key-based, cermin scrub; jurnal lebih sensitif
//   dari RAM — enforcement penyamaran tetap scrub, ini lapis kedua).
// - Storage: bun:sqlite (fondasi existing — tanpa engine baru), WAL + NORMAL +
//   busy_timeout DULU (konvensi persistence.ts), schema_version=1 eksplisit.

import { Database, type Statement } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { LIMITS } from "../constants.ts"
import type { ExecutionEvent } from "./execution-events.ts"

/** Versi skema jurnal (bentuk/encoding) — BUKAN executionVersion. */
export const JOURNAL_SCHEMA_VERSION = 1

export type JournalErrorCode =
  | "not-open"
  | "already-closed"
  | "constraint-conflict"
  | "identity-conflict"
  | "serialization-failure"
  | "storage-failure"
  | "busy-timeout"
  | "flush-uncertain"
  | "corruption"

export interface JournalError {
  readonly code: JournalErrorCode
  readonly detail: string
}

interface JournalBase {
  readonly journalSequence: number
  readonly schemaVersion: number
  readonly kind: "event" | "intent"
  /** SHA-256 atas konten kanonis (cakupan §integrity, di bawah). */
  readonly recordHash: string
}

export interface JournalEventRecord extends JournalBase {
  readonly kind: "event"
  readonly eventId: string
  readonly eventType: string
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly lineageRootId: string
  readonly timestamp: number
  readonly eventSequence: number | null
  readonly executionVersion: number
  readonly source: string
  readonly causality?: string
  readonly reason?: string
  readonly state?: string
  readonly previousState?: string
  readonly attempt?: number
  readonly generation?: number
  readonly supersedes?: string
  readonly metadataJson: string
}

export interface JournalIntentRecord extends JournalBase {
  readonly kind: "intent"
  /** Kunci idempotency intent (mis. `intent:<exec>:<ver>:<hash>`); UNIQUE. */
  readonly intentId: string
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly lineageRootId: string
  readonly executionVersion: number
  readonly timestamp: number
  readonly reason: string
  readonly source: string
  readonly metadataJson: string
}

export type JournalRecord = JournalEventRecord | JournalIntentRecord

export interface IntentInput {
  readonly intentId: string
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly lineageRootId: string
  readonly executionVersion: number
  readonly reason: string
  readonly source: string
  readonly metadata?: Record<string, string>
  readonly timestamp?: number
}

export type AppendResult =
  | { readonly status: "appended"; readonly record: JournalRecord }
  | { readonly status: "duplicate"; readonly record: JournalRecord }
  | { readonly status: "error"; readonly error: JournalError }

export type FlushResult =
  | { readonly status: "durable-confirmed" }
  | { readonly status: "durability-uncertain"; readonly error: JournalError }
  | { readonly status: "failed"; readonly error: JournalError }

export interface CheckpointResult {
  readonly busy: boolean
  readonly mode: string
}

export interface JournalMetrics {
  readonly appendCount: number
  readonly duplicateCount: number
  readonly appendFailureCount: number
  readonly flushFailureCount: number
  readonly corruptionCount: number
  readonly bytesWritten: number
}

// ── Redaction batas-tulis (lapis kedua; enforcement milik scrub) ──

const SECRET_KEY_RE =
  /(?:API[_-]?KEYS?|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH|BEARER|SESSION[_-]?KEY)/i

function redactMetadata(input: Record<string, string> | undefined): Record<string, string> {
  if (!input) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : v
  }
  return out
}

// ── Hash integritas: SHA-256 atas JSON kanonis field immutable (tanpa seq,
// tanpa hash itu sendiri). Cakupan: identitas + isi + provenance + versi.
// Dikecualikan: journalSequence (diberikan storage), recordHash (output).
// BUKAN klaim anti-tamper absolut — bukti deteksi perubahan, terdokumentasi. ──

function canonicalJson(value: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(value).sort()) sorted[k] = value[k]
  return JSON.stringify(sorted)
}

function hashRecord(content: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(content)).digest("hex")
}

// ── Konten kanonis event/intent: SATU representasi untuk hash + equality.
// Dibandingkan: seluruh payload identitas M10 (eventId..metadata), TANPA
// metadata persistence (journalSequence, recordHash, schemaVersion — lokal
// storage dan boleh berbeda secara sah). Deterministik via canonicalJson. ──

export interface CanonicalEventContent {
  readonly [key: string]: unknown
}

export function canonicalEventContent(event: ExecutionEvent): Record<string, unknown> {
  const redacted = redactMetadata(event.metadata as Record<string, string> | undefined)
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    executionId: event.executionId,
    parentExecutionId: event.parentExecutionId ?? null,
    lineageRootId: event.lineageRootId,
    timestamp: event.timestamp,
    eventSequence: event.eventSequence,
    executionVersion: event.executionVersion,
    source: event.source,
    causality: event.causality ?? null,
    reason: event.reason ?? null,
    state: event.state ?? null,
    previousState: event.previousState ?? null,
    attempt: event.attempt ?? null,
    generation: event.generation ?? null,
    supersedes: event.supersedes ?? null,
    metadata: redacted,
  }
}

export function canonicalIntentContent(intent: IntentInput): Record<string, unknown> {
  const redacted = redactMetadata(intent.metadata)
  return {
    intentId: intent.intentId,
    executionId: intent.executionId,
    parentExecutionId: intent.parentExecutionId ?? null,
    lineageRootId: intent.lineageRootId,
    executionVersion: intent.executionVersion,
    reason: intent.reason,
    source: intent.source,
    metadata: redacted,
  }
}

/**
 * Bandingkan konten kanonis tersimpan (dari record hash-able) vs incoming.
 * Mengembalikan nama field yang berbeda (diagnostik TANPA nilai — tanpa dump
 * payload sensitif ke error). Sama = duplicate aman; beda = IDENTITY_CONFLICT.
 */
export function diffCanonicalContent(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(stored), ...Object.keys(incoming)])
  const diff: string[] = []
  for (const k of [...keys].sort()) {
    if (canonicalJson({ v: stored[k] }) !== canonicalJson({ v: incoming[k] })) diff.push(k)
  }
  return diff
}

function storedEventContent(rec: JournalEventRecord): Record<string, unknown> {
  return {
    eventId: rec.eventId,
    eventType: rec.eventType,
    executionId: rec.executionId,
    parentExecutionId: rec.parentExecutionId ?? null,
    lineageRootId: rec.lineageRootId,
    timestamp: rec.timestamp,
    eventSequence: rec.eventSequence,
    executionVersion: rec.executionVersion,
    source: rec.source,
    causality: rec.causality ?? null,
    reason: rec.reason ?? null,
    state: rec.state ?? null,
    previousState: rec.previousState ?? null,
    attempt: rec.attempt ?? null,
    generation: rec.generation ?? null,
    supersedes: rec.supersedes ?? null,
    metadata: JSON.parse(rec.metadataJson) as Record<string, unknown>,
  }
}

function storedIntentContent(rec: JournalIntentRecord): Record<string, unknown> {
  return {
    intentId: rec.intentId,
    executionId: rec.executionId,
    parentExecutionId: rec.parentExecutionId ?? null,
    lineageRootId: rec.lineageRootId,
    executionVersion: rec.executionVersion,
    reason: rec.reason,
    source: rec.source,
    metadata: JSON.parse(rec.metadataJson) as Record<string, unknown>,
  }
}

// ── Busy retry bounded (konvensi persistence.ts: 3×, busy-only, rethrow lain) ──

/** Seam uji: retry bounded generik agar dapat diuji deterministik tanpa SQLite sibuk nyata. */
export async function withJournalBusyRetry<T>(
  fn: () => T,
  opts?: { attempts?: number; sleepMs?: (attempt: number) => Promise<void> },
): Promise<T> {
  const attempts = opts?.attempts ?? 3
  const sleep = opts?.sleepMs ?? ((n: number) => Bun.sleep(Math.min(25 * 2 ** n, 200)))
  let last: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) throw e
      last = e
      if (i + 1 < attempts) await sleep(i)
    }
  }
  throw last instanceof Error ? last : new Error(`SQLITE_BUSY after ${attempts} attempts`)
}

function isBusyError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.includes("SQLITE_BUSY") || msg.includes("database is locked")
}

function isCorruptionError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return (
    msg.includes("malformed") ||
    msg.includes("not a database") ||
    msg.includes("file is not a database")
  )
}

export interface ExecutionJournal {
  appendEvent(event: ExecutionEvent): Promise<AppendResult>
  noteIntent(intent: IntentInput): Promise<AppendResult>
  readAll(): JournalRecord[]
  readAfter(journalSequence: number): JournalRecord[]
  /** History execution (BUKAN current state — konsumen menafsirkan). */
  readExecutionHistory(executionId: string): JournalRecord[]
  /** Durability boundary: checkpoint WAL; gagal = uncertain (jujur). */
  flush(): FlushResult
  /** Verifikasi hash ulang; mismatch dilaporkan, tak pernah dibuang diam-diam. */
  integrityCheck(): { checked: number; mismatched: number[] }
  metrics(): JournalMetrics
  close(): void
  isOpen(): boolean
}

export function openExecutionJournal(
  path: string,
  opts?: {
    readonly?: boolean
    /**
     * Seam injeksi checkpoint (uji deterministik boundary confirmed/uncertain).
     * Default = checkpoint FULL nyata + fsync-boundary sementara (di bawah).
     * Produksi tak mengeset ini; test memakainya untuk memaksa busy/gagal.
     */
    checkpoint?: () => CheckpointResult
  },
): ExecutionJournal {
  const checkpointFn = opts?.checkpoint
  let db: Database | null = null
  let openError: JournalError | null = null
  // Statement registry di scope fungsi (bukan blok try): semua pemakai
  // (insert/fetch/read/flush/close) berbagi; close() finalize semua agar
  // Windows file lock lepas (tanpa ini rm tmp macet EBUSY).
  const statements: Statement[] = []
  const prep = (sql: string): Statement => {
    if (!db) throw new Error("journal closed")
    const stmt = db.prepare(sql)
    statements.push(stmt)
    return stmt
  }
  try {
    if (!opts?.readonly) mkdirSync(dirname(path), { recursive: true })
    db = new Database(path, opts?.readonly ? { readonly: true } : undefined)
    // busy_timeout DULU (konvensi persistence.ts — sebelum statement lock apa pun).
    db.exec(`PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}`)
    if (!opts?.readonly) {
      db.exec(
        `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=${LIMITS.SQLITE_WAL_SIZE_LIMIT_BYTES}; PRAGMA wal_autocheckpoint=${LIMITS.SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
      )
      db.exec(`CREATE TABLE IF NOT EXISTS journal_meta(key TEXT PRIMARY KEY, value TEXT)`)
      db.exec(
        `CREATE TABLE IF NOT EXISTS journal_events(
          journal_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          schema_version INTEGER NOT NULL,
          kind TEXT NOT NULL,
          event_id TEXT UNIQUE,
          intent_id TEXT UNIQUE,
          event_type TEXT,
          execution_id TEXT NOT NULL,
          parent_execution_id TEXT,
          lineage_root_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          event_sequence INTEGER,
          execution_version INTEGER NOT NULL,
          source TEXT NOT NULL,
          causality TEXT,
          reason TEXT,
          state TEXT,
          previous_state TEXT,
          attempt INTEGER,
          generation INTEGER,
          supersedes TEXT,
          metadata_json TEXT NOT NULL,
          record_hash TEXT NOT NULL
        )`,
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_journal_execution ON journal_events(execution_id, journal_sequence)`,
      )
      const cur = prep(`SELECT value FROM journal_meta WHERE key='schema_version'`).get() as
        | { value: string }
        | undefined
      if (!cur) {
        prep(`INSERT INTO journal_meta(key, value) VALUES ('schema_version', ?)`).run(
          String(JOURNAL_SCHEMA_VERSION),
        )
      }
    }
  } catch (e) {
    // Open gagal (korupsi/storage): TUTUP handle yang sempat dibuat — tanpa
    // ini lock file bocor dan cleanup macet EBUSY (defect nyata, bukan teori).
    try {
      db?.close()
    } catch {}
    db = null
    if (isCorruptionError(e)) {
      openError = { code: "corruption", detail: (e as Error).message.slice(0, 300) }
    } else {
      openError = { code: "storage-failure", detail: (e as Error).message.slice(0, 300) }
    }
  }

  const m = {
    appendCount: 0,
    duplicateCount: 0,
    appendFailureCount: 0,
    flushFailureCount: 0,
    corruptionCount: openError?.code === "corruption" ? 1 : 0,
    bytesWritten: 0,
  }

  const fail = (code: JournalErrorCode, detail: string): AppendResult => {
    m.appendFailureCount++
    return { status: "error", error: { code, detail } }
  }

  /**
   * Checkpoint default: FULL (menunggu selesai; PASSIVE boleh berhenti dini
   * saat reader sehingga tak cocok untuk boundary) + synchronous=FULL SEMENTARA
   * agar frame ter-checkpoint ter-sync (append path tetap NORMAL). Restore
   * NORMAL di finally — penalti fsync hanya di boundary eksplisit, bukan tiap
   * append. Klaim tetap scoped (lihat flush()).
   */
  const defaultCheckpoint = (): CheckpointResult => {
    if (!db) throw new Error("journal closed")
    db.exec(`PRAGMA synchronous=FULL`)
    try {
      const res = prep(`PRAGMA wal_checkpoint(FULL)`).get() as { busy?: number } | undefined
      return { busy: (res?.busy ?? 0) !== 0, mode: "FULL+fsync" }
    } finally {
      try {
        db.exec(`PRAGMA synchronous=NORMAL`)
      } catch {}
    }
  }

  const rowToRecord = (row: Record<string, unknown>): JournalRecord => {
    const base = {
      journalSequence: row.journal_sequence as number,
      schemaVersion: row.schema_version as number,
      recordHash: row.record_hash as string,
    }
    const meta = (row.metadata_json as string) ?? "{}"
    if (row.kind === "intent") {
      const rec: JournalIntentRecord = Object.freeze({
        ...base,
        kind: "intent" as const,
        intentId: row.intent_id as string,
        executionId: row.execution_id as string,
        ...((row.parent_execution_id as string | null)
          ? { parentExecutionId: row.parent_execution_id as string }
          : {}),
        lineageRootId: row.lineage_root_id as string,
        executionVersion: row.execution_version as number,
        timestamp: row.ts as number,
        reason: (row.reason as string) ?? "",
        source: (row.source as string) ?? "",
        metadataJson: meta,
      })
      return rec
    }
    const rec: JournalEventRecord = Object.freeze({
      ...base,
      kind: "event" as const,
      eventId: row.event_id as string,
      eventType: (row.event_type as string) ?? "",
      executionId: row.execution_id as string,
      ...((row.parent_execution_id as string | null)
        ? { parentExecutionId: row.parent_execution_id as string }
        : {}),
      lineageRootId: row.lineage_root_id as string,
      timestamp: row.ts as number,
      eventSequence: (row.event_sequence as number | null) ?? null,
      executionVersion: row.execution_version as number,
      source: (row.source as string) ?? "",
      ...((row.causality as string | null) ? { causality: row.causality as string } : {}),
      ...((row.reason as string | null) ? { reason: row.reason as string } : {}),
      ...((row.state as string | null) ? { state: row.state as string } : {}),
      ...((row.previous_state as string | null)
        ? { previousState: row.previous_state as string }
        : {}),
      ...((row.attempt as number | null) !== null && row.attempt !== undefined
        ? { attempt: row.attempt as number }
        : {}),
      ...((row.generation as number | null) !== null && row.generation !== undefined
        ? { generation: row.generation as number }
        : {}),
      ...((row.supersedes as string | null) ? { supersedes: row.supersedes as string } : {}),
      metadataJson: meta,
    })
    return rec
  }

  const fetchByEventId = (eventId: string): JournalRecord | null => {
    if (!db) return null
    const row = prep(`SELECT * FROM journal_events WHERE event_id = ?`).get(eventId) as
      | Record<string, unknown>
      | undefined
    return row ? rowToRecord(row) : null
  }

  const fetchByIntentId = (intentId: string): JournalRecord | null => {
    if (!db) return null
    const row = prep(`SELECT * FROM journal_events WHERE intent_id = ?`).get(intentId) as
      | Record<string, unknown>
      | undefined
    return row ? rowToRecord(row) : null
  }

  const insertRow = (cols: Record<string, unknown>): JournalRecord => {
    if (!db) throw new Error("journal closed")
    // Atomic: single INSERT dalam transaksi implisit; UNIQUE(event_id/intent_id)
    // menjadikan retry konkuren aman (salah satu menang, lainnya konflik).
    const keys = Object.keys(cols)
    const stmt = prep(
      `INSERT INTO journal_events(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    )
    const info = stmt.run(...keys.map((k) => cols[k] as unknown)) as unknown as {
      lastInsertRowid: number | bigint
    }
    const row = prep(`SELECT * FROM journal_events WHERE journal_sequence = ?`).get(
      Number(info.lastInsertRowid),
    ) as Record<string, unknown>
    const rec = rowToRecord(row)
    m.appendCount++
    m.bytesWritten += canonicalJson(cols).length
    return rec
  }

  const api: ExecutionJournal = {
    async appendEvent(event: ExecutionEvent): Promise<AppendResult> {
      if (!db) return fail(openError?.code ?? "not-open", openError?.detail ?? "journal not open")
      // Validasi bentuk (serialization-failure, bukan throw generik).
      if (
        !event ||
        typeof event.eventId !== "string" ||
        typeof event.eventType !== "string" ||
        typeof event.executionId !== "string" ||
        typeof event.lineageRootId !== "string" ||
        typeof event.source !== "string" ||
        typeof event.executionVersion !== "number"
      ) {
        return fail("serialization-failure", "malformed ExecutionEvent (missing required fields)")
      }
      try {
        const existing = await withJournalBusyRetry(() => fetchByEventId(event.eventId)).catch(
          () => null,
        )
        const incoming = canonicalEventContent(event)
        if (existing) {
          // Sama eventId + payload SAMA = duplicate aman; BEDA = IDENTITY_CONFLICT
          // (tak pernah overwrite; konflik tak alokasi sequence).
          if (existing.kind !== "event") {
            return fail("identity-conflict", `identity-conflict ${event.eventId} fields: kind`)
          }
          const diff = diffCanonicalContent(storedEventContent(existing), incoming)
          if (diff.length === 0) {
            m.duplicateCount++
            return { status: "duplicate", record: existing }
          }
          return fail(
            "identity-conflict",
            `identity-conflict ${event.eventId} fields: ${diff.join(",")}`,
          )
        }
        const redacted = incoming.metadata as Record<string, string>
        const record = await withJournalBusyRetry(() =>
          insertRow({
            schema_version: JOURNAL_SCHEMA_VERSION,
            kind: "event",
            event_id: event.eventId,
            intent_id: null,
            event_type: event.eventType,
            execution_id: event.executionId,
            parent_execution_id: event.parentExecutionId ?? null,
            lineage_root_id: event.lineageRootId,
            ts: event.timestamp,
            event_sequence: event.eventSequence,
            execution_version: event.executionVersion,
            source: event.source,
            causality: event.causality ?? null,
            reason: event.reason ?? null,
            state: event.state ?? null,
            previous_state: event.previousState ?? null,
            attempt: event.attempt ?? null,
            generation: event.generation ?? null,
            supersedes: event.supersedes ?? null,
            metadata_json: JSON.stringify(redacted),
            record_hash: hashRecord(incoming),
          }),
        )
        return { status: "appended", record }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // Race insert konkuren: UNIQUE conflict = baca pemenang lalu bandingkan
        // kanonis (sama = duplicate; beda = IDENTITY_CONFLICT; pemenang duluan
        // yang otoritatif — race tak menentukan ulang).
        if (msg.includes("UNIQUE constraint failed")) {
          const existing = fetchByEventId(event.eventId)
          if (existing && existing.kind === "event") {
            const diff = diffCanonicalContent(
              storedEventContent(existing),
              canonicalEventContent(event),
            )
            if (diff.length === 0) {
              m.duplicateCount++
              return { status: "duplicate", record: existing }
            }
            return fail(
              "identity-conflict",
              `identity-conflict ${event.eventId} fields: ${diff.join(",")}`,
            )
          }
          if (existing) {
            m.duplicateCount++
            return { status: "duplicate", record: existing }
          }
          return fail("constraint-conflict", msg.slice(0, 300))
        }
        if (isBusyError(e)) return fail("busy-timeout", msg.slice(0, 300))
        if (isCorruptionError(e)) {
          m.corruptionCount++
          return fail("corruption", msg.slice(0, 300))
        }
        return fail("storage-failure", msg.slice(0, 300))
      }
    },

    async noteIntent(intent: IntentInput): Promise<AppendResult> {
      if (!db) return fail(openError?.code ?? "not-open", openError?.detail ?? "journal not open")
      if (
        !intent ||
        typeof intent.intentId !== "string" ||
        typeof intent.executionId !== "string" ||
        typeof intent.lineageRootId !== "string" ||
        typeof intent.reason !== "string" ||
        typeof intent.source !== "string" ||
        typeof intent.executionVersion !== "number"
      ) {
        return fail("serialization-failure", "malformed intent (missing required fields)")
      }
      try {
        const existing = await withJournalBusyRetry(() => fetchByIntentId(intent.intentId)).catch(
          () => null,
        )
        const incoming = canonicalIntentContent(intent)
        if (existing) {
          if (existing.kind !== "intent") {
            return fail("identity-conflict", `identity-conflict ${intent.intentId} fields: kind`)
          }
          const diff = diffCanonicalContent(storedIntentContent(existing), incoming)
          if (diff.length === 0) {
            m.duplicateCount++
            return { status: "duplicate", record: existing }
          }
          return fail(
            "identity-conflict",
            `identity-conflict ${intent.intentId} fields: ${diff.join(",")}`,
          )
        }
        const redacted = incoming.metadata as Record<string, string>
        const ts = intent.timestamp ?? Date.now()
        const record = await withJournalBusyRetry(() =>
          insertRow({
            schema_version: JOURNAL_SCHEMA_VERSION,
            kind: "intent",
            event_id: null,
            intent_id: intent.intentId,
            event_type: null,
            execution_id: intent.executionId,
            parent_execution_id: intent.parentExecutionId ?? null,
            lineage_root_id: intent.lineageRootId,
            ts,
            event_sequence: null,
            execution_version: intent.executionVersion,
            source: intent.source,
            causality: null,
            reason: intent.reason,
            state: null,
            previous_state: null,
            attempt: null,
            generation: null,
            supersedes: null,
            metadata_json: JSON.stringify(redacted),
            record_hash: hashRecord(incoming),
          }),
        )
        return { status: "appended", record }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes("UNIQUE constraint failed")) {
          const existing = fetchByIntentId(intent.intentId)
          if (existing && existing.kind === "intent") {
            const diff = diffCanonicalContent(
              storedIntentContent(existing),
              canonicalIntentContent(intent),
            )
            if (diff.length === 0) {
              m.duplicateCount++
              return { status: "duplicate", record: existing }
            }
            return fail(
              "identity-conflict",
              `identity-conflict ${intent.intentId} fields: ${diff.join(",")}`,
            )
          }
          if (existing) {
            m.duplicateCount++
            return { status: "duplicate", record: existing }
          }
          return fail("constraint-conflict", msg.slice(0, 300))
        }
        if (isBusyError(e)) return fail("busy-timeout", msg.slice(0, 300))
        if (isCorruptionError(e)) {
          m.corruptionCount++
          return fail("corruption", msg.slice(0, 300))
        }
        return fail("storage-failure", msg.slice(0, 300))
      }
    },

    readAll(): JournalRecord[] {
      if (!db) return []
      const rows = prep(`SELECT * FROM journal_events ORDER BY journal_sequence`).all() as Record<
        string,
        unknown
      >[]
      return rows.map((r) => rowToRecord(r))
    },

    readAfter(journalSequence: number): JournalRecord[] {
      if (!db) return []
      const rows = prep(
        `SELECT * FROM journal_events WHERE journal_sequence > ? ORDER BY journal_sequence`,
      ).all(journalSequence) as Record<string, unknown>[]
      return rows.map((r) => rowToRecord(r))
    },

    readExecutionHistory(executionId: string): JournalRecord[] {
      // History, BUKAN current state: konsumen (M12) menafsirkan urutan.
      if (!db) return []
      const rows = prep(
        `SELECT * FROM journal_events WHERE execution_id = ? ORDER BY journal_sequence`,
      ).all(executionId) as Record<string, unknown>[]
      return rows.map((r) => rowToRecord(r))
    },

    flush(): FlushResult {
      if (!db) return { status: "failed", error: { code: "not-open", detail: "journal not open" } }
      // Durability boundary eksplisit (FIX A): FULL menunggu selesai (PASSIVE
      // boleh berhenti dini saat reader → tak cocok untuk boundary), dengan
      // synchronous=FULL SEMENTARA agar frame ter-checkpoint ter-sync ke
      // storage (append path tetap NORMAL — tanpa penalti global).
      // Makna status (jujur, terdokumentasi):
      // - durable-confirmed: FULL selesai busy=0 di bawah fsync-boundary → aman
      //   crash proses + OS-crash pada storage yang menghormati fsync. BUKAN
      //   garansi hardware/power-loss universal (SQLite sendiri tak klaim itu).
      // - durability-uncertain: checkpoint sibuk/gagal → commit transaksi TETAP
      //   valid (record present), daya tahan tak terbukti.
      // - failed: jurnal mati / error tulis.
      try {
        const checkpoint = checkpointFn ?? defaultCheckpoint
        const res = checkpoint()
        if (res.busy) {
          m.flushFailureCount++
          return {
            status: "durability-uncertain",
            error: { code: "flush-uncertain", detail: `checkpoint busy (${res.mode})` },
          }
        }
        return { status: "durable-confirmed" }
      } catch (e) {
        m.flushFailureCount++
        return {
          status: "failed",
          error: { code: "flush-uncertain", detail: (e as Error).message.slice(0, 200) },
        }
      }
    },

    integrityCheck(): { checked: number; mismatched: number[] } {
      // Mismatch dilaporkan (seq list), TAK PERNAH dibuang diam-diam.
      // Reuse storedEventContent agar definisi konten tunggal (anti-drift).
      const records = api.readAll()
      const mismatched: number[] = []
      for (const rec of records) {
        if (rec.kind === "event") {
          if (hashRecord(storedEventContent(rec)) !== rec.recordHash)
            mismatched.push(rec.journalSequence)
        }
      }
      return { checked: records.length, mismatched }
    },

    metrics() {
      return { ...m }
    },

    close(): void {
      // Idempoten: ganda aman; post-close append = already-closed eksplisit.
      // Finalize statements DULU (Windows file lock), baru db.close().
      for (const stmt of statements.splice(0)) {
        try {
          stmt.finalize()
        } catch {}
      }
      if (db) {
        try {
          db.close()
        } catch {}
        db = null
      }
    },

    isOpen(): boolean {
      return db !== null
    },
  }
  return api
}

// [P1 M16] `randomEventIdForTest` dihapus: tanpa pemakai, dan kehadirannya berarti
// allocator `evt_` hidup di DUA tempat (plane emit + helper uji) — dua sumber
// untuk satu namespace. Event id tetap dicetak hanya di M10 `createEventPlane`.
