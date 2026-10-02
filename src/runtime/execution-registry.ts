// M2 — Read-only execution registry: RAM metadata index, BUKAN authority.
//
// Kenapa berkas ini ada (P1 ADR-001/010, FINAL QA P2/P5): runtime butuh satu
// tempat observasi untuk menemukan + menginspeksi execution yang hidup/barusan
// terminal, tanpa menjadikannya source of truth kedua. Sebelum M2, observasi
// tersebar (adapter maps, journal inflight, job table) dan tak ada yang bisa
// menjawab "execution apa yang dikenal host saat ini" tanpa menebak.
//
// BUKAN: source of truth, durable store, lifecycle authority, scheduler/task
// authority, cancellation controller, terminal writer, persistence. Aturan yang
// dikunci (jangan dilonggarkan tanpa ADR baru):
// - Key = executionId M1 (tak pernah dibuat di sini; tak pernah ganti domain IDs).
// - Satu-satunya jalur tulis = observe() (sink observasi internal). TIDAK ADA
//   complete()/fail()/cancel()/setState() — API semacam itu DILARANG eksis di
//   modul ini (negative authority tests menjaganya).
// - Snapshot defensif: yang disimpan frozen-copy; yang dikembalikan frozen-copy.
//   Mutasi hasil inspect TAK PERNAH menyentuh internal.
// - Retensi terkontestasi (BUKAN arbitrasi — FINAL QA P2): bila dua observasi
//   terminal BERBEDA tiba untuk satu id, registry TIDAK TAHU mana yang commit
//   duluan (otoritas serialisasi = Kernel M8, belum ada). Yang disimpan adalah
//   observasi pertama (retensi deterministik anti-flap) + flag `contested:true`
//   yang menyatakan "butuh kernel truth untuk resolve — JANGAN baca snapshot
//   ini sebagai keputusan lifecycle". Observasi non-terminal sesudah terminal
//   ditolak sebagai basi (terminal absorbing di semua model lifecycle — ini
//   properti retensi, bukan klaim authority).
//   Prinsip: Kernel decides. Registry observes.
// - RAM-only: restart = kosong (normal, bukan kehilangan data — truth durable
//   direkonstruksi milestone persistence/recovery, bukan di sini).
// - Bounded: cap entries + TTL snapshot terminal; evict terhitung (observable).

import { type ExecutionKind, isExecutionId } from "./execution-id.ts"

/**
 * Status observasi — LABEL snapshot, bukan taksonomi otoritatif (itu M8).
 * Registry tidak memvalidasi makna; ia hanya menyimpan string yang dilaporkan
 * lifecycle integration dan menandai terminalitas via TERMINAL_SNAPSHOT.
 */
export type ExecutionStateSnapshot = string

/** Label yang dianggap terminal untuk kebijakan retensi + TTL + cleanup.
 * Heuristik observasi (absorbing-label), BUKAN otoritas lifecycle. */
export const TERMINAL_SNAPSHOT: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "BUDGET_EXCEEDED",
  "AUTHORITY_LOST",
  "RESOURCE_EXCEEDED",
])

export function isTerminalSnapshot(state: unknown): boolean {
  return typeof state === "string" && TERMINAL_SNAPSHOT.has(state)
}

/** Metadata kontrol per execution — TANPA prompt/history/output/secret. */
export interface RegistryEntryInput {
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly rootExecutionId: string
  readonly kind: ExecutionKind
  readonly ownerId: string
  /** Snapshot observasi (label; kebenaran milik Kernel, bukan registry). */
  readonly stateSnapshot: ExecutionStateSnapshot
  /** Referensi opaque (sisa deadline; bukan deadline authority). */
  readonly deadlineRef?: number
  /** Referensi opaque (handle budget; bukan budget authority). */
  readonly budgetRef?: string
  /** Referensi opaque (handle backend; BUKAN kill/terminate/wait/dispose). */
  readonly backendRef?: string
}

/** Snapshot yang dikembalikan ke caller — selalu frozen copy. */
export interface ExecutionSnapshot {
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly rootExecutionId: string
  readonly kind: ExecutionKind
  readonly ownerId: string
  readonly stateSnapshot: ExecutionStateSnapshot
  readonly deadlineRef?: number
  readonly budgetRef?: string
  readonly backendRef?: string
  readonly createdAt: number
  readonly updatedAt: number
  /**
   * True bila ≥2 observasi terminal BERBEDA pernah tiba untuk id ini.
   * Artinya: snapshot yang tersimpan adalah retensi observasi pertama,
   * BUKAN keputusan pemenang race — resolve via kernel truth (M8).
   * Absent = tak ada kontestasi teramati.
   */
  readonly contested?: true
}

/** Ringkasan ringan untuk list() — tanpa detail refs. */
export interface ExecutionSummary {
  readonly executionId: string
  readonly kind: ExecutionKind
  readonly ownerId: string
  readonly stateSnapshot: ExecutionStateSnapshot
  readonly updatedAt: number
  readonly contested?: true
}

export interface RegistryMetrics {
  registered: number
  lookupHit: number
  lookupMiss: number
  terminalCleanup: number
  staleObservation: number
  /** Observasi terminal konflik (label beda, id sama) — butuh kernel truth. */
  conflictingTerminal: number
  evicted: number
  evictedLive: number
  entryCount: number
}

export interface RegistryOptions {
  /** Batas total entries (default 1000). Evict: terminal tertua dulu. */
  readonly maxEntries?: number
  /** Retensi snapshot terminal ms (default 1 jam). BUKAN lifecycle policy. */
  readonly terminalTtlMs?: number
}

const DEFAULT_MAX_ENTRIES = 1000
const DEFAULT_TERMINAL_TTL_MS = 3_600_000

interface Stored {
  snapshot: ExecutionSnapshot
  terminalAt: number | null
}

function freezeSnapshot(s: ExecutionSnapshot): ExecutionSnapshot {
  return Object.freeze({ ...s })
}

function assertInput(input: RegistryEntryInput): void {
  if (!input || !isExecutionId(input.executionId))
    throw new Error("registry.observe: valid M1 executionId is required (registry never mints ids)")
  if (!isExecutionId(input.rootExecutionId))
    throw new Error("registry.observe: valid rootExecutionId is required")
  if (input.parentExecutionId !== undefined && !isExecutionId(input.parentExecutionId))
    throw new Error("registry.observe: invalid parentExecutionId (no guessing)")
  if (!input.kind || !input.ownerId)
    throw new Error("registry.observe: kind and ownerId are required metadata")
  if (typeof input.stateSnapshot !== "string" || input.stateSnapshot.length === 0)
    throw new Error("registry.observe: non-empty stateSnapshot label is required")
}

export interface ExecutionRegistry {
  /** Sink observasi internal SATU-SATUNYA. Bukan mutation authority. */
  observe(input: RegistryEntryInput, now?: number): void
  /** Lookup → frozen copy atau undefined (miss terhitung). */
  find(executionId: string): ExecutionSnapshot | undefined
  /** Inspeksi detail → frozen copy atau undefined (miss terhitung). */
  inspect(executionId: string): ExecutionSnapshot | undefined
  /** Daftar ringkasan terurut updatedAt menaik. */
  list(): ExecutionSummary[]
  /** Hapus snapshot terminal kedaluwarsa TTL; kembalikan jumlah terhapus. */
  sweep(now?: number): number
  /** Metrik observasi (copy). */
  metrics(): RegistryMetrics
  /** Jumlah entries saat ini. */
  size(): number
}

/**
 * Registry observasi RAM-only. Single-threaded JS: operasi Map atomik;
 * tak ada torn object (simpan frozen-copy, upsert = replace, tak pernah
 * mutasi in-place). Tanpa clock bisnis: `now` injectable untuk determinisme.
 */
export function createExecutionRegistry(opts: RegistryOptions = {}): ExecutionRegistry {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  const terminalTtlMs = opts.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS
  const store = new Map<string, Stored>()
  const m = {
    registered: 0,
    lookupHit: 0,
    lookupMiss: 0,
    terminalCleanup: 0,
    staleObservation: 0,
    conflictingTerminal: 0,
    evicted: 0,
    evictedLive: 0,
    entryCount: 0,
  }

  const copyOut = (stored: Stored): ExecutionSnapshot => freezeSnapshot({ ...stored.snapshot })

  const enforceBound = (): void => {
    while (store.size > maxEntries) {
      // Evict terminal tertua dulu; live hanya bila tak ada pilihan.
      let victim: string | null = null
      let victimTs = Infinity
      for (const [id, st] of store) {
        if (st.terminalAt !== null && st.snapshot.updatedAt < victimTs) {
          victim = id
          victimTs = st.snapshot.updatedAt
        }
      }
      if (victim === null) {
        for (const [id, st] of store) {
          if (st.snapshot.updatedAt < victimTs) {
            victim = id
            victimTs = st.snapshot.updatedAt
          }
        }
        if (victim !== null) m.evictedLive++
      }
      if (victim === null) break
      store.delete(victim)
      m.evicted++
      m.entryCount = store.size
    }
  }

  return {
    observe(input: RegistryEntryInput, now: number = Date.now()): void {
      assertInput(input)
      const prev = store.get(input.executionId)
      if (prev) {
        const prevTerminal = prev.terminalAt !== null
        const nextTerminal = isTerminalSnapshot(input.stateSnapshot)
        if (prevTerminal) {
          if (prev.snapshot.stateSnapshot === input.stateSnapshot) {
            // Refresh updatedAt terminal yang sama (bukan overwrite makna).
            store.set(input.executionId, freezeStored({ ...prev.snapshot, updatedAt: now }))
            return
          }
          if (!nextTerminal) {
            // Event basi non-terminal tiba sesudah terminal: stale, ditolak.
            // Terminal absorbing di semua model lifecycle — properti retensi,
            // bukan klaim authority atas race terminal-vs-terminal.
            m.staleObservation++
            return
          }
          // KONTESTASI terminal (BUKAN arbitrasi): registry tak tahu mana yang
          // commit duluan — otoritas serialisasi milik Kernel (M8). Simpan
          // observasi pertama (retensi deterministik anti-flap) + tandai
          // contested agar TAK ADA pembaca yang menjadikannya keputusan
          // lifecycle. Urutan observasi ≠ authority.
          m.conflictingTerminal++
          store.set(
            input.executionId,
            freezeStored({ ...prev.snapshot, contested: true as const, updatedAt: now }),
          )
          return
        }
        if (!nextTerminal || prev.snapshot.stateSnapshot === input.stateSnapshot) {
          store.set(
            input.executionId,
            freezeStored({
              ...prev.snapshot,
              ...stripUndefined(input),
              updatedAt: now,
            }),
          )
          return
        }
        // Transisi non-terminal → terminal: catat terminalAt (retensi TTL).
        const terminalSnapshot = freezeSnapshot({
          ...prev.snapshot,
          ...stripUndefined(input),
          updatedAt: now,
        })
        store.set(input.executionId, { snapshot: terminalSnapshot, terminalAt: now })
        return
      }
      const snapshot = freezeSnapshot({
        executionId: input.executionId,
        ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}),
        rootExecutionId: input.rootExecutionId,
        kind: input.kind,
        ownerId: input.ownerId,
        stateSnapshot: input.stateSnapshot,
        ...(input.deadlineRef !== undefined ? { deadlineRef: input.deadlineRef } : {}),
        ...(input.budgetRef !== undefined ? { budgetRef: input.budgetRef } : {}),
        ...(input.backendRef !== undefined ? { backendRef: input.backendRef } : {}),
        createdAt: now,
        updatedAt: now,
      })
      store.set(input.executionId, {
        snapshot,
        terminalAt: isTerminalSnapshot(input.stateSnapshot) ? now : null,
      })
      m.registered++
      m.entryCount = store.size
      enforceBound()
    },

    find(executionId: string): ExecutionSnapshot | undefined {
      const stored = store.get(executionId)
      if (!stored) {
        m.lookupMiss++
        return undefined
      }
      m.lookupHit++
      return copyOut(stored)
    },

    inspect(executionId: string): ExecutionSnapshot | undefined {
      const stored = store.get(executionId)
      if (!stored) {
        m.lookupMiss++
        return undefined
      }
      m.lookupHit++
      return copyOut(stored)
    },

    list(): ExecutionSummary[] {
      return [...store.values()]
        .map((st) => st.snapshot)
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .map((s) =>
          Object.freeze({
            executionId: s.executionId,
            kind: s.kind,
            ownerId: s.ownerId,
            stateSnapshot: s.stateSnapshot,
            updatedAt: s.updatedAt,
            ...(s.contested === true ? { contested: true as const } : {}),
          }),
        )
    },

    sweep(now: number = Date.now()): number {
      let removed = 0
      for (const [id, st] of store) {
        if (st.terminalAt !== null && now - st.terminalAt >= terminalTtlMs) {
          store.delete(id)
          removed++
        }
      }
      if (removed > 0) {
        m.terminalCleanup += removed
        m.entryCount = store.size
      }
      return removed
    },

    metrics(): RegistryMetrics {
      return { ...m, entryCount: store.size }
    },

    size(): number {
      return store.size
    },
  }
}

function stripUndefined(input: RegistryEntryInput): {
  stateSnapshot: ExecutionStateSnapshot
  kind: ExecutionKind
  ownerId: string
  rootExecutionId: string
  parentExecutionId?: string
  deadlineRef?: number
  budgetRef?: string
  backendRef?: string
} {
  return {
    stateSnapshot: input.stateSnapshot,
    kind: input.kind,
    ownerId: input.ownerId,
    rootExecutionId: input.rootExecutionId,
    ...(input.parentExecutionId !== undefined
      ? { parentExecutionId: input.parentExecutionId }
      : {}),
    ...(input.deadlineRef !== undefined ? { deadlineRef: input.deadlineRef } : {}),
    ...(input.budgetRef !== undefined ? { budgetRef: input.budgetRef } : {}),
    ...(input.backendRef !== undefined ? { backendRef: input.backendRef } : {}),
  }
}

function freezeStored(snapshot: ExecutionSnapshot): Stored {
  const terminalAt = isTerminalSnapshot(snapshot.stateSnapshot) ? snapshot.updatedAt : null
  return { snapshot: freezeSnapshot(snapshot), terminalAt }
}
