// Helper P2.0 — scaffolding test-only untuk blueprint sesi P2 (v2).
//
// Isi file ini BUKAN implementasi produksi: hanya util deterministik,
// fixture builder, dan oracle executable (spesifikasi dalam bentuk kode)
// yang dipakai test P2.0. Oracle di sini mendefinisikan KONTRAK yang kelak
// wajib dipenuhi kode produksi; ketika P2 diimplementasikan, test akan
// dialihkan dari oracle ke implementasi nyata.

import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ── Klasifikasi test P2.0 (label dokumentasi, bukan runner) ──

export const P2_CLASS = {
  CURRENT_INVARIANT: "CURRENT-INVARIANT",
  FUTURE_CONTRACT: "P2-FUTURE-CONTRACT",
  MIGRATION: "MIGRATION",
  FAILURE_INJECTION: "FAILURE-INJECTION",
  ARCHITECTURE_GUARD: "ARCHITECTURE-GUARD",
} as const

// ── Workspace hermetic ──
// resolveDbPath memakai <cwd>/.minicode bila dir-nya ada → DB hermetic.

let p2Counter = 0

export function p2Cwd(prefix = "mc-p2"): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

export async function p2Cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

// ID deterministik (tanpa random; stabil antar run).

export function p2Id(prefix = "sess"): string {
  p2Counter += 1
  return `${prefix}-${String(p2Counter).padStart(4, "0")}`
}

export function p2ResetIds(): void {
  p2Counter = 0
}

// ── Pesan fixture ──

export interface P2Msg {
  role: string
  content: string
}

export function p2Msgs(n: number, tag = "m"): P2Msg[] {
  const out: P2Msg[] = []
  for (let i = 0; i < n; i++) {
    out.push(
      i % 2 === 0
        ? { role: "user", content: `${tag}-u${i}` }
        : { role: "assistant", content: `${tag}-a${i}` },
    )
  }
  return out
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

export function p2HistoryHash(msgs: readonly P2Msg[]): string {
  return sha256Hex(JSON.stringify(msgs.map((m) => [m.role, m.content])))
}

// ── Introspeksi SQLite test-only ──

export function p2DbPath(cwd: string, name = "sessions.db"): string {
  return join(cwd, ".minicode", name)
}

export function p2HasColumn(dbPath: string, table: string, column: string): boolean {
  const db = new Database(dbPath, { readonly: true })
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    return cols.some((c) => c.name === column)
  } finally {
    db.close()
  }
}

export function p2HasTable(dbPath: string, table: string): boolean {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { ok: number } | null
    return row !== null
  } finally {
    db.close()
  }
}

export function p2Count(
  dbPath: string,
  table: string,
  where = "",
  ...params: (string | number | null)[]
): number {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).get(...params) as {
      n: number
    }
    return row.n
  } finally {
    db.close()
  }
}

// ── Oracle pohon keputusan identitas (§5 blueprint v2, test-side) ──
// Menentukan canonical vs operator-choice vs read-only lineage dari
// deskriptor kandidat. Murni; tanpa IO.

export interface P2IdentityCandidate {
  id: string
  updatedAt: number
  historyCount: number
  historyHash: string
  taskCount: number
  incarnation: number
  fsKey: string
}

export type P2IdentityOutcome =
  | { kind: "canonical"; canonicalId: string; losersMigrated: string[] }
  | { kind: "operator_choice"; candidates: string[]; reason: string }

export function p2ResolveCanonical(cands: P2IdentityCandidate[]): P2IdentityOutcome {
  if (cands.length === 0) throw new Error("p2: tanpa kandidat")
  if (cands.length === 1)
    return { kind: "canonical", canonicalId: cands[0]!.id, losersMigrated: [] }
  // Aturan 7: kolisi kunci filesystem antar kandidat berbeda → tolak auto.
  const keys = new Set(cands.map((c) => c.fsKey))
  if (keys.size !== cands.length) {
    return {
      kind: "operator_choice",
      candidates: cands.map((c) => c.id),
      reason: "fs-key-collision",
    }
  }
  const liveTasks = cands.filter((c) => c.taskCount > 0)
  // Aturan 3: dua otoritas tugas hidup → operator.
  if (liveTasks.length >= 2) {
    return {
      kind: "operator_choice",
      candidates: liveTasks.map((c) => c.id),
      reason: "dual-task-authority",
    }
  }
  // Aturan 2/4: satu otoritas tugas menang atas kekayaan histori.
  if (liveTasks.length === 1) {
    const w = liveTasks[0]!
    return {
      kind: "canonical",
      canonicalId: w.id,
      losersMigrated: cands.filter((c) => c.id !== w.id).map((c) => c.id),
    }
  }
  // Aturan 1: duplikat byte-identik → terkecil menang.
  const hashes = new Set(cands.map((c) => c.historyHash))
  if (hashes.size === 1) {
    const sorted = [...cands].sort((a, b) => (a.id < b.id ? -1 : 1))
    return {
      kind: "canonical",
      canonicalId: sorted[0]!.id,
      losersMigrated: sorted.slice(1).map((c) => c.id),
    }
  }
  // Aturan 5: resensi (updated_at) menang; count hanya tiebreak.
  const sorted = [...cands].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.historyCount - a.historyCount,
  )
  return {
    kind: "canonical",
    canonicalId: sorted[0]!.id,
    losersMigrated: sorted.slice(1).map((c) => c.id),
  }
}

// ── Oracle lifecycle sesi (test-side, §6 blueprint v2) ──

export type P2SessionState = "CREATED" | "ACTIVE" | "INTERRUPTED" | "RESUMABLE" | "ARCHIVED"

const P2_SESSION_EDGES: Record<P2SessionState, readonly P2SessionState[]> = {
  CREATED: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["INTERRUPTED", "ARCHIVED"],
  INTERRUPTED: ["RESUMABLE", "ARCHIVED"],
  RESUMABLE: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
}

export function p2SessionTransition(from: P2SessionState, to: P2SessionState): boolean {
  return P2_SESSION_EDGES[from].includes(to)
}

// ── Oracle lifecycle Run (test-side, §8 blueprint v2) ──

export type P2RunStatus = "CREATED" | "RUNNING" | "INTERRUPTED" | "FAILED" | "COMPLETED"

const P2_RUN_EDGES: Record<P2RunStatus, readonly P2RunStatus[]> = {
  CREATED: ["RUNNING"],
  RUNNING: ["INTERRUPTED", "FAILED", "COMPLETED"],
  INTERRUPTED: ["RUNNING"],
  FAILED: [],
  COMPLETED: [],
}

export function p2RunTransition(from: P2RunStatus, to: P2RunStatus): boolean {
  return P2_RUN_EDGES[from].includes(to)
}

// ── Model epoch fence (test-side, §17 blueprint v2) ──
// Mensimulasikan CAS dalam-transaksi tanpa IO.

export interface P2EpochStore {
  epoch(): number
  mutate(expected: number): { ok: true } | { ok: false; reason: "REFUSED_STALE_EPOCH" }
  takeover(key: string): number
}

export function p2EpochStore(): P2EpochStore {
  let epoch = 0
  const seen = new Set<string>()
  return {
    epoch: () => epoch,
    mutate: (expected) =>
      expected === epoch ? { ok: true } : { ok: false, reason: "REFUSED_STALE_EPOCH" },
    takeover: (key) => {
      if (!seen.has(key)) {
        seen.add(key)
        epoch += 1
      }
      return epoch
    },
  }
}

// ── Model alokator sequence per-thread (test-side, §9 blueprint v2) ──

export interface P2Allocator {
  alloc(
    thread: string,
    eventId: string,
    payloadHash: string,
  ): { seq: number } | { dup: true } | { conflict: true }
  max(thread: string): number
}

export function p2Allocator(): P2Allocator {
  const seqs = new Map<string, number>()
  const seen = new Map<string, { thread: string; hash: string }>()
  return {
    alloc: (thread, eventId, payloadHash) => {
      const prev = seen.get(eventId)
      if (prev) {
        if (prev.thread === thread && prev.hash === payloadHash) return { dup: true }
        return { conflict: true }
      }
      const next = (seqs.get(thread) ?? -1) + 1
      seqs.set(thread, next)
      seen.set(eventId, { thread, hash: payloadHash })
      return { seq: next }
    },
    max: (thread) => seqs.get(thread) ?? -1,
  }
}

// ── Oracle validasi fork thread (test-side, §7 blueprint v2) ──

export function p2ValidateFork(
  headSeq: number,
  atSeq: number,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(atSeq) || atSeq < 0) return { ok: false, reason: "invalid-seq" }
  if (atSeq > headSeq) return { ok: false, reason: "nonexistent-seq" }
  return { ok: true }
}

// ── Rekonsiliasi kursor (test-side, §14 blueprint v2) ──

export interface P2CursorState {
  cursor: number
  runId: string
}

export function p2ReconcileCursor(
  committedMax: number,
  cursor: P2CursorState,
  ownEventSeqs: readonly number[],
): { cursor: number; note: "ok" | "cursor_clamped" | "adopted-own" } {
  if (cursor.cursor > committedMax) return { cursor: committedMax, note: "cursor_clamped" }
  if (committedMax > cursor.cursor) {
    // Adopsi HANYA event milik Run yang direkonsiliasi.
    const ownBeyond = ownEventSeqs.filter((s) => s > cursor.cursor)
    if (ownBeyond.length > 0 && Math.max(...ownBeyond) === committedMax) {
      return { cursor: committedMax, note: "adopted-own" }
    }
    return { cursor: cursor.cursor, note: "ok" }
  }
  return { cursor: cursor.cursor, note: "ok" }
}

// ── Titik failure-injection simbolik (test-side saja; tanpa hook produksi) ──

export const P2_FAIL_POINTS = [
  "FAIL_AFTER_SESSION_CREATE",
  "FAIL_AFTER_RUN_CREATE",
  "FAIL_AFTER_HISTORY_APPEND",
  "FAIL_AFTER_TOOL_INTENT",
  "FAIL_AFTER_TOOL_SIDE_EFFECT_SIMULATION",
  "FAIL_BEFORE_TOOL_RESULT_PERSIST",
  "FAIL_DURING_CHECKPOINT",
  "FAIL_AFTER_SESSION_STATE_WRITE",
  "FAIL_BEFORE_JOURNAL_FINALIZE",
  "FAIL_DURING_PROJECTION_WRITE",
  "FAIL_BETWEEN_RAM_AND_DURABLE_COMMIT",
] as const

// ── Barrier deterministik untuk interleave tanpa sleep ──

export interface P2Barrier {
  wait: () => Promise<void>
  releaseAll: () => void
}

export function p2Barrier(): P2Barrier {
  let waiting: (() => void)[] = []
  return {
    wait: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve)
      }),
    releaseAll: () => {
      const q = waiting
      waiting = []
      for (const r of q) r()
    },
  }
}
