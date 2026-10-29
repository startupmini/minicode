// [Fase 3 / LOOP-12, LOOP-G19, LOOP-G27] Detektor deterministik No-Progress &
// Oscillation.
//
// Menutup tiga modus macet otonom tanpa menyentuh kernel frozen:
//   1. Exact Action-Error Fingerprint (`REPEATED_ACTION_ERROR`): pemanggilan
//      tool dengan nama + argumen kanonis + headline error yang identik N kali
//      berturut-turut diblokir pada percobaan ke-(N+1).
//   2. Workspace State Oscillation (`WORKSPACE_REVERT_CYCLE`): file mengalami
//      siklus bolak-balik kembali ke hash lama sebanyak M siklus (mis.
//      H1 -> H2 -> H1 -> H2 -> H1 untuk M=2) tanpa verifikasi lulus di antaranya.
//   3. Read-Only Thrashing (`READ_ONLY_THRASHING`): pemanggilan tool murni-baca
//      (`sideEffectTier === "PURE_READ"`) berturut-turut melampaui ambang batas
//      saat sesi berada pada postur kerja aktif (bukan readonly/explore/plan)
//      tanpa pembaruan rencana (`todo_write`), mutasi, atau jawaban ke user.
//
// Modul ini berada di `src/policy/` dan hanya mengimpor `./tool-contract.ts` +
// pustaka standar Node agar batas lapisan tetap bersih.

import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { contractForTool } from "./tool-contract.ts"

export type NoProgressPosture = "active" | "readonly" | "explore" | "plan"

export type LoopGuardKind = "NO_PROGRESS" | "OSCILLATION"

export type LoopGuardReason =
  | "REPEATED_ACTION_ERROR"
  | "WORKSPACE_REVERT_CYCLE"
  | "READ_ONLY_THRASHING"

export type NoProgressVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly kind: LoopGuardKind
      readonly reason: LoopGuardReason
      readonly message: string
    }

export class NoProgressError extends Error {
  readonly name = "NoProgressError"
  readonly kind: LoopGuardKind
  readonly reason: LoopGuardReason

  constructor(kind: LoopGuardKind, reason: LoopGuardReason, message: string) {
    super(message)
    this.kind = kind
    this.reason = reason
  }
}

export interface NoProgressOptions {
  /** Maksimum kegagalan identik berturut-turut sebelum panggilan berikutnya diblokir (default 3). */
  readonly maxRepeatedErrors?: number
  /** Maksimum siklus kembali ke hash file lama tanpa verifikasi hijau (default 2). */
  readonly maxOscillations?: number
  /** Maksimum panggilan PURE_READ berturut-turut di postur aktif (default 15). */
  readonly maxConsecutiveReadCalls?: number
  /** Postur sesi saat ini; non-"active" menonaktifkan detektor read-only thrashing. */
  readonly getPosture?: () => NoProgressPosture
  /**
   * [Fase 6A / ACE-04] Maksimum retry terjustifikasi setelah bukti baru
   * (default 1). Hard cap absolut: tidak pernah menambah budget tanpa batas.
   */
  readonly maxNewEvidenceRetries?: number
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
    .join(",")}}`
}

/** Hash argumen kanonis (identik dengan `hashArgs` pada `src/session/journal.ts`). */
export function canonicalArgsHash(args: unknown): string {
  return createHash("sha256")
    .update(canonicalize(args ?? {}))
    .digest("hex")
}

/**
 * Ambil headline error yang stabil (baris pertama bermakna, menormalkan angka
 * durasi volatil agar timeout/error yang sama menghasilkan sidik jari sama).
 */
export function normalizeErrorHeadline(errorText: string): string {
  const firstLine =
    String(errorText ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "error"
  return firstLine
    .replace(/\bduration_ms=\d+/g, "duration_ms=#")
    .replace(/\s+/g, " ")
    .slice(0, 240)
}

export function computeActionErrorFingerprint(
  toolName: string,
  args: unknown,
  errorText: string,
): string {
  const payload = `${toolName}\0${canonicalArgsHash(args)}\0${normalizeErrorHeadline(errorText)}`
  return createHash("sha256").update(payload, "utf8").digest("hex")
}

const HASH_MAX_BYTES = 8 * 1024 * 1024

async function hashWorkspaceFile(
  absPath: string,
): Promise<{ ok: true; hash: string | null } | { ok: false }> {
  try {
    const st = await stat(absPath)
    if (!st.isFile() || st.size > HASH_MAX_BYTES) return { ok: false }
    const bytes = await readFile(absPath)
    return { ok: true, hash: createHash("sha256").update(bytes).digest("hex") }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, hash: null }
    return { ok: false }
  }
}

function targetRelPathForTool(
  toolName: string,
  args: unknown,
  workspaceRoot: string,
): string | null {
  const a = (args ?? {}) as Record<string, unknown>
  const raw =
    toolName === "write_file" ||
    toolName === "edit" ||
    toolName === "apply_patch" ||
    toolName === "delete_file"
      ? a.path
      : toolName === "move_file"
        ? a.to
        : undefined
  if (typeof raw !== "string" || !raw.trim()) return null
  const root = resolve(workspaceRoot)
  const rel = relative(root, resolve(root, raw)).replace(/\\/g, "/")
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null
  return rel
}

function normalizeTrackPath(rawPath: string): string {
  return rawPath.trim().replace(/\\/g, "/").replace(/^\.\//, "")
}

interface FileHashTracker {
  history: (string | null)[]
  visits: Map<string, number>
  oscillationMessage: string | null
}

const HASH_NULL_SENTINEL = "__ABSENT__"

function hashKey(h: string | null): string {
  return h === null ? HASH_NULL_SENTINEL : h
}

export interface NoProgressDetector {
  evaluateBeforeCall(call: { id?: string; name: string; args?: unknown }): NoProgressVerdict
  assertBeforeCall(call: { id?: string; name: string; args?: unknown }): void
  capturePreMutation(
    call: { id: string; name: string; args?: unknown },
    workspaceRoot: string,
  ): Promise<void>
  /**
   * [Fase 3] Titik masuk barrier async tunggal: tunggu seluruh pencatatan
   * post-mutation step sebelumnya selesai dulu (menutup race async antar-step),
   * evaluasi guard, lalu rekam hash pra-mutasi.
   */
  beforeToolEffectCheck(
    call: { id: string; name: string; args?: unknown },
    workspaceRoot: string,
  ): Promise<void>
  flushPending(): Promise<void>
  recordOutcome(input: {
    id?: string
    name: string
    args?: unknown
    isError?: boolean
    content?: string
  }): NoProgressVerdict
  recordFileMutation(input: {
    path: string
    preTargetHash: string | null
    postTargetHash: string | null
  }): NoProgressVerdict
  completePostMutation(
    call: { id: string; name: string; args?: unknown; isError?: boolean },
    workspaceRoot: string,
  ): Promise<NoProgressVerdict>
  noteVerificationPassed(): void
  noteAssistantResponse(): void
  reset(): void
  snapshot(): {
    readonly repeatedErrorStreak: number
    readonly consecutiveReadCalls: number
    readonly oscillatingPaths: readonly string[]
    /** [Fase 6A / ACE-04] Ada bukti baru sejak blokir REPEATED_ACTION_ERROR. */
    readonly newEvidenceSinceFailure: boolean
    /** [Fase 6A / ACE-04] Retry terjustifikasi yang sudah dipakai untuk blokir aktif. */
    readonly justifiedRetriesUsed: number
  }
}

export function createNoProgressDetector(options: NoProgressOptions = {}): NoProgressDetector {
  const maxRepeatedErrors =
    typeof options.maxRepeatedErrors === "number" &&
    Number.isFinite(options.maxRepeatedErrors) &&
    options.maxRepeatedErrors >= 1
      ? Math.floor(options.maxRepeatedErrors)
      : 3
  const maxOscillations =
    typeof options.maxOscillations === "number" &&
    Number.isFinite(options.maxOscillations) &&
    options.maxOscillations >= 1
      ? Math.floor(options.maxOscillations)
      : 2
  const maxConsecutiveReadCalls =
    typeof options.maxConsecutiveReadCalls === "number" &&
    Number.isFinite(options.maxConsecutiveReadCalls) &&
    options.maxConsecutiveReadCalls >= 1
      ? Math.floor(options.maxConsecutiveReadCalls)
      : 15
  const getPosture = options.getPosture ?? (() => "active" as const)
  const maxNewEvidenceRetries =
    typeof options.maxNewEvidenceRetries === "number" &&
    Number.isFinite(options.maxNewEvidenceRetries) &&
    options.maxNewEvidenceRetries >= 0
      ? Math.floor(options.maxNewEvidenceRetries)
      : 1

  let lastErrorFingerprint: string | null = null
  let lastErrorActionKey: string | null = null
  let repeatedErrorStreak = 0

  // [Fase 6A / ACE-04] Blokir REPEATED_ACTION_ERROR bersifat PERSISTEN sampai
  // ada bukti baru — sukses yang tidak relevan tidak boleh membuka jalan
  // mengulang perintah yang sama secara buta.
  let activeBlock: { fingerprint: string; actionKey: string; streak: number } | null = null
  let newEvidenceAfterBlock = false
  let justifiedRetries = 0

  let consecutiveReadCalls = 0

  const fileTrackers = new Map<string, FileHashTracker>()
  const inflightPreHash = new Map<string, { relPath: string; preHash: string | null }>()
  const pendingPost = new Set<Promise<unknown>>()

  const evaluateBeforeCall: NoProgressDetector["evaluateBeforeCall"] = (call) => {
    const name = String(call.name ?? "")
    const actionKey = `${name}\0${canonicalArgsHash(call.args)}`

    // Sinyal 1a: blokir persisten. Hanya boleh dibuka oleh SATU retry
    // terjustifikasi setelah bukti diagnostik/mutasi baru, dengan hard cap.
    if (activeBlock !== null && actionKey === activeBlock.actionKey) {
      if (newEvidenceAfterBlock && justifiedRetries < maxNewEvidenceRetries) {
        justifiedRetries += 1
        newEvidenceAfterBlock = false
        return { allowed: true }
      }
      return {
        allowed: false,
        kind: "NO_PROGRESS",
        reason: "REPEATED_ACTION_ERROR",
        message:
          `[LOOP_GUARD kind=NO_PROGRESS reason=REPEATED_ACTION_ERROR count=${activeBlock.streak}] ` +
          `Identical tool call failed ${activeBlock.streak} times consecutively with the same error. ` +
          `Read fresh diagnostic evidence or change your approach before retrying.`,
      }
    }

    // Sinyal 1b: panggilan identik yang sudah gagal N kali berturut-turut.
    if (
      repeatedErrorStreak >= maxRepeatedErrors &&
      lastErrorActionKey !== null &&
      actionKey === lastErrorActionKey
    ) {
      return {
        allowed: false,
        kind: "NO_PROGRESS",
        reason: "REPEATED_ACTION_ERROR",
        message:
          `[LOOP_GUARD kind=NO_PROGRESS reason=REPEATED_ACTION_ERROR count=${repeatedErrorStreak}] ` +
          `Identical tool call failed ${repeatedErrorStreak} times consecutively with the same error. ` +
          `Stop repeating this command and revise your approach.`,
      }
    }

    // Sinyal 2: file target sudah terdeteksi dalam siklus revert berulang.
    const contract = contractForTool(name)
    if (contract?.sideEffectTier === "WORKSPACE_MUTATION") {
      const a = (call.args ?? {}) as Record<string, unknown>
      const rawPath =
        typeof a.path === "string" ? a.path : typeof a.to === "string" ? a.to : undefined
      if (rawPath) {
        const key = normalizeTrackPath(rawPath)
        const tracker = fileTrackers.get(key)
        if (tracker?.oscillationMessage) {
          return {
            allowed: false,
            kind: "OSCILLATION",
            reason: "WORKSPACE_REVERT_CYCLE",
            message: tracker.oscillationMessage,
          }
        }
      }
    }

    // Sinyal 3: read-only thrashing di postur kerja aktif.
    const isPureRead = contract?.sideEffectTier === "PURE_READ"
    if (isPureRead) {
      if (getPosture() === "active") {
        if (consecutiveReadCalls >= maxConsecutiveReadCalls) {
          const observedCount = consecutiveReadCalls
          // Reset setelah satu intervensi supaya model menerima peringatan keras
          // sebagai tool error dan dapat langsung memanggil todo_write / bertindak.
          consecutiveReadCalls = 0
          return {
            allowed: false,
            kind: "NO_PROGRESS",
            reason: "READ_ONLY_THRASHING",
            message:
              `[LOOP_GUARD kind=NO_PROGRESS reason=READ_ONLY_THRASHING count=${observedCount}] ` +
              `Exceeded ${maxConsecutiveReadCalls} consecutive read-only tool calls without updating the plan, ` +
              `mutating workspace state, or responding to the user. Formulate a plan (todo_write) or act on what you have read.`,
          }
        }
        consecutiveReadCalls += 1
      }
    } else {
      // Pembaruan rencana (`todo_write`), mutasi file/env, delegasi, atau ask_user
      // memutus rentetan baca murni.
      consecutiveReadCalls = 0
    }

    return { allowed: true }
  }

  const recordFileMutation: NoProgressDetector["recordFileMutation"] = (input) => {
    const key = normalizeTrackPath(input.path)
    if (!key) return { allowed: true }
    // No-op write (isi tidak berubah) tidak dihitung sebagai transisi bolak-balik.
    if (input.preTargetHash === input.postTargetHash) return { allowed: true }

    let tracker = fileTrackers.get(key)
    if (!tracker) {
      const visits = new Map<string, number>()
      const preK = hashKey(input.preTargetHash)
      visits.set(preK, 1)
      tracker = {
        history: [input.preTargetHash],
        visits,
        oscillationMessage: null,
      }
      fileTrackers.set(key, tracker)
    } else if (tracker.history[tracker.history.length - 1] !== input.preTargetHash) {
      // Sinkronkan state awal bila file diubah dari luar di sela dua operasi.
      const preK = hashKey(input.preTargetHash)
      tracker.history.push(input.preTargetHash)
      tracker.visits.set(preK, (tracker.visits.get(preK) ?? 0) + 1)
    }

    const postK = hashKey(input.postTargetHash)
    tracker.history.push(input.postTargetHash)
    const count = (tracker.visits.get(postK) ?? 0) + 1
    tracker.visits.set(postK, count)

    // `count - 1` = berapa kali file kembali ke hash yang sama setelah pernah
    // meninggalkannya (H1 -> H2 -> H1 = 1 siklus; -> H2 -> H1 = 2 siklus).
    const revertCycles = count - 1
    if (revertCycles >= maxOscillations) {
      const msg =
        `[LOOP_GUARD kind=OSCILLATION reason=WORKSPACE_REVERT_CYCLE path=${key}] ` +
        `File state is oscillating between identical versions without progress.`
      tracker.oscillationMessage = msg
      return {
        allowed: false,
        kind: "OSCILLATION",
        reason: "WORKSPACE_REVERT_CYCLE",
        message: msg,
      }
    }
    return { allowed: true }
  }

  const flushPending = async (): Promise<void> => {
    while (pendingPost.size > 0) {
      await Promise.allSettled([...pendingPost])
    }
  }

  return {
    evaluateBeforeCall,
    assertBeforeCall(call) {
      const verdict = evaluateBeforeCall(call)
      if (!verdict.allowed) {
        throw new NoProgressError(verdict.kind, verdict.reason, verdict.message)
      }
    },
    async capturePreMutation(call, workspaceRoot) {
      const contract = contractForTool(call.name)
      if (contract?.sideEffectTier !== "WORKSPACE_MUTATION" || !call.id) return
      const rel = targetRelPathForTool(call.name, call.args, workspaceRoot)
      if (!rel) return
      const pre = await hashWorkspaceFile(resolve(workspaceRoot, rel))
      if (pre.ok) {
        inflightPreHash.set(call.id, { relPath: rel, preHash: pre.hash })
      }
    },
    async beforeToolEffectCheck(call, workspaceRoot) {
      await flushPending()
      const verdict = evaluateBeforeCall(call)
      if (!verdict.allowed) {
        throw new NoProgressError(verdict.kind, verdict.reason, verdict.message)
      }
      const contract = contractForTool(call.name)
      if (contract?.sideEffectTier !== "WORKSPACE_MUTATION" || !call.id) return
      const rel = targetRelPathForTool(call.name, call.args, workspaceRoot)
      if (!rel) return
      const pre = await hashWorkspaceFile(resolve(workspaceRoot, rel))
      if (pre.ok) {
        inflightPreHash.set(call.id, { relPath: rel, preHash: pre.hash })
      }
    },
    flushPending,
    recordOutcome(input) {
      const name = String(input.name ?? "")
      const content = String(input.content ?? "")
      // Jangan hitung error yang berasal dari LOOP_GUARD sendiri sebagai kegagalan tool.
      if (content.includes("[LOOP_GUARD ")) {
        return { allowed: true }
      }
      if (input.isError === true) {
        const fp = computeActionErrorFingerprint(name, input.args, content)
        const actionKey = `${name}\0${canonicalArgsHash(input.args)}`
        if (fp === lastErrorFingerprint && actionKey === lastErrorActionKey) {
          repeatedErrorStreak += 1
        } else {
          lastErrorFingerprint = fp
          lastErrorActionKey = actionKey
          repeatedErrorStreak = 1
        }
        if (repeatedErrorStreak >= maxRepeatedErrors) {
          if (activeBlock === null || activeBlock.actionKey !== actionKey) {
            // Blokir baru: buka budget retry dari nol.
            activeBlock = { fingerprint: fp, actionKey, streak: repeatedErrorStreak }
            justifiedRetries = 0
          } else {
            // Retry terjustifikasi gagal lagi: pertahankan budget yang sudah
            // terpakai (hard cap) dan cabut bukti yang sudah dikonsumsi.
            activeBlock = { ...activeBlock, streak: repeatedErrorStreak }
          }
          newEvidenceAfterBlock = false
          return {
            allowed: false,
            kind: "NO_PROGRESS",
            reason: "REPEATED_ACTION_ERROR",
            message:
              `[LOOP_GUARD kind=NO_PROGRESS reason=REPEATED_ACTION_ERROR count=${repeatedErrorStreak}] ` +
              `Identical tool call failed ${repeatedErrorStreak} times consecutively with the same error. ` +
              `Stop repeating this command and revise your approach.`,
          }
        }
        return { allowed: true }
      }
      // Eksekusi sukses memutus streak error berulang. [Fase 6A / ACE-04]
      // Sukses baca diagnostik atau mutasi workspace = bukti baru yang
      // membenarkan SATU retry; sukses lain tidak membuka blokir.
      if (activeBlock !== null) {
        const tier = contractForTool(name)?.sideEffectTier
        if (tier === "PURE_READ" || tier === "WORKSPACE_MUTATION") {
          newEvidenceAfterBlock = true
        }
      }
      lastErrorFingerprint = null
      lastErrorActionKey = null
      repeatedErrorStreak = 0
      return { allowed: true }
    },
    recordFileMutation,
    async completePostMutation(call, workspaceRoot) {
      const task = (async (): Promise<NoProgressVerdict> => {
        const entry = call.id ? inflightPreHash.get(call.id) : undefined
        if (call.id) inflightPreHash.delete(call.id)
        if (!entry || call.isError === true) return { allowed: true }
        const post = await hashWorkspaceFile(resolve(workspaceRoot, entry.relPath))
        if (!post.ok) return { allowed: true }
        return recordFileMutation({
          path: entry.relPath,
          preTargetHash: entry.preHash,
          postTargetHash: post.hash,
        })
      })()
      pendingPost.add(task)
      try {
        return await task
      } finally {
        pendingPost.delete(task)
      }
    },
    noteVerificationPassed() {
      // Verifikasi hijau menandai titik tumpu baru: bersihkan riwayat osilasi
      // masa lalu namun pertahankan hash terakhir sebagai baseline baru.
      for (const [, tracker] of fileTrackers) {
        const latest = tracker.history[tracker.history.length - 1] ?? null
        const visits = new Map<string, number>()
        visits.set(hashKey(latest), 1)
        tracker.history = [latest]
        tracker.visits = visits
        tracker.oscillationMessage = null
      }
      // [Fase 6A / ACE-04] Verifikasi hijau adalah kemajuan nyata: blokir
      // repeated-error tidak lagi relevan.
      activeBlock = null
      newEvidenceAfterBlock = false
      justifiedRetries = 0
      lastErrorFingerprint = null
      lastErrorActionKey = null
      repeatedErrorStreak = 0
    },
    noteAssistantResponse() {
      consecutiveReadCalls = 0
    },
    reset() {
      lastErrorFingerprint = null
      lastErrorActionKey = null
      repeatedErrorStreak = 0
      consecutiveReadCalls = 0
      activeBlock = null
      newEvidenceAfterBlock = false
      justifiedRetries = 0
      fileTrackers.clear()
      inflightPreHash.clear()
    },
    snapshot() {
      const oscillatingPaths: string[] = []
      for (const [p, t] of fileTrackers) {
        if (t.oscillationMessage) oscillatingPaths.push(p)
      }
      return {
        repeatedErrorStreak,
        consecutiveReadCalls,
        oscillatingPaths,
        newEvidenceSinceFailure: newEvidenceAfterBlock,
        justifiedRetriesUsed: justifiedRetries,
      }
    },
  }
}
