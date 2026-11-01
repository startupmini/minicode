// Mutation intent journal — application-layer commitment truth.
//
// Masalah yang ditutup (AUDIT #01 P0-1/P0-2): filesystem dapat berubah
// sebelum turn commit/persist, sementara SQLite dan checkpoint ditulis dua
// penulis tak tersinkron. Setelah crash, tak ada artefak yang tahu apakah
// mutasi terakhir committed, belum, atau ambigu.
//
// Modul ini menjawab SATU pertanyaan: "status komitmen mutasi X?"
// - intent  = execution:started (terbit SETELAH permission+validate, SEBELUM
//   execute — titik D audit #01C; denied/invalid tak pernah tercatat).
// - terminal = execution:completed (!isError → committed, isError → failed).
// - finalize = turn durable di SQLite (hanya ini yang boleh di-cleanup).
//
// BUKAN transaksi lintas FS+DB (tak tersedia). BUKAN checkpoint (tak restore
// file). BUKAN penentu redo (tak pernah auto-redo; resume = verify-first).
// Kernel vendor tak tersentuh: semua lewat langganan event + API eksplisit.
//
// Model kegagalan tulis: kegagalan append/fsync TAK PERNAH menggagalkan turn
// (fail-open eksekusi) tetapi menandai sesi degraded + warn keras — resume
// lalu memperlakukan sesi itu via jalur advisory. Paling aman yang tersedia:
// menghentikan turn karena log gagal akan merusak lebih banyak daripada gap.

import { createHash } from "node:crypto"
import { mkdir, open, readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { sanitizeSessionPart } from "../lib/session-id.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import { classifyContractTool } from "../policy/tool-contract.ts"
import { isMcpToolName } from "../presentation/label.ts"

/**
 * [Fase 10 / 10.1] Otoritas penyimpanan kanonik.
 * `session/journal.ts` adalah Canonical Recovery Authority: satu-satunya
 * sumber kebenaran intent/receipt/verification untuk crash recovery.
 * `runtime/execution-journal.ts` adalah Diagnostic Audit Projection: history
 * audit yang MEREKAM, bukan memutus recovery. Matriks lengkap 7 penyimpanan
 * didefinisikan di `runtime/execution-journal.ts#STORAGE_AUTHORITY_MATRIX`
 * (diimpor balik untuk menghindari siklus impor) — konstanta ini adalah
 * penanda local authority agar tak pernah tertukar source of truth.
 */
export const SESSION_JOURNAL_AUTHORITY = "canonical_recovery_ledger" as const

// [Fase 2 / LOOP-INV-07] `unknown` = terminal AMBIGU: eksekusi berhenti tanpa
// bukti apakah efeknya terjadi (mis. timeout bash). Bukan `failed` (yang
// menyiratkan "tidak terjadi") dan bukan `pending` (yang menyiratkan "belum
// selesai"): recovery wajib memverifikasi sebelum mengulang.
export type JournalState = "pending" | "committed" | "failed" | "unknown"

/**
 * [Fase 2] SATU definisi "terminal". Sebelumnya predicate
 * `state === "committed" || state === "failed"` disalin di banyak tempat;
 * menambah `unknown` tanpa helper akan membuat record ambigu dianggap pending
 * (dan di-stitch sebagai sukses) di jalur yang terlewat.
 */
const TERMINAL_JOURNAL_STATES: ReadonlySet<string> = new Set(["committed", "failed", "unknown"])

export function isTerminalJournalState(state: JournalState | undefined): boolean {
  return state !== undefined && TERMINAL_JOURNAL_STATES.has(state)
}

export type VerificationMethod =
  | "filesystem-read-back"
  | "checkpoint-diff"
  | "git-state"
  | "external-acknowledgement"
  | "existing-verifier"
  | "human-resolution"

export type VerificationVerdict = "present" | "absent" | "inconclusive"

const VERIFICATION_METHODS: ReadonlySet<VerificationMethod> = new Set([
  "filesystem-read-back",
  "checkpoint-diff",
  "git-state",
  "external-acknowledgement",
  "existing-verifier",
  "human-resolution",
])

export function isVerificationMethod(method: string): method is VerificationMethod {
  return VERIFICATION_METHODS.has(method as VerificationMethod)
}

export interface JournalOutcome {
  code?: number | null
  note?: string
  /** Application-observed acknowledgement only; never universal effect proof. */
  ack?: string | number | boolean | null
  ackSource?: "bash-exit" | "sandbox-exit" | "git-commit" | "external-response" | "absent"
  ackAuthority?: "application-observed"
  truncated?: true
  timeout?: true
  aborted?: true
  loss?: "none" | "response" | "persistence" | "unknown"
  uncertainty?: "none" | "ambiguous-effect" | "unverified-external" | "evidence-incomplete"
  observedAt?: number
  /**
   * Bounded child-execution observation (P9.2.1, delegate-task only).
   * Dilaporkan apa yang teramati dari turn anak — BUKAN otoritas baru:
   * tak mengubah makna `committed`/`failed`, tak mempublikasikan histori,
   * tak menggantikan verifikasi/bukti lain. Opsional agar record lama tetap
   * terbaca; pembaca tak boleh menjadikannya bukti efek.
   */
  childResult?: ChildResultEnvelope
}

/**
 * Status observasi anak (P9.2.1): apa yang terlihat dari sisi pemanggil,
 * bukan rekonstruksi kausal lengkap. `returned` = runner kembali normal
 * (isi ringkasan boleh berupa teks error anak — itu observasi, bukan vonis);
 * `failed_to_start` = runner tak pernah jalan (factory/provider/pool).
 */
export type ChildStatus =
  | "returned"
  | "timeout"
  | "aborted"
  | "max_steps_exceeded"
  | "error"
  | "failed_to_start"

/**
 * Amplop hasil anak yang bounded + disanitasi (P9.2.1). `resultSummary`
 * adalah salinan sanitasi dari string yang sudah dilihat parent (batas
 * panjang sama), BUKAN transkrip anak. Absent (`null`) = data memang tak
 * tersedia di jalur itu — jangan difabrikasi.
 */
/** [Fase 7 / LOOP-INV-13/15] Verdict consequence-engine (ACE-Lite) dari hasil anak. */
export interface AceResultSnapshot {
  readonly verdict: import("../policy/consequence-engine.ts").AceVerdict
  readonly failureClass: import("../policy/consequence-engine.ts").AceFailureClass
  readonly nextAction: import("../policy/consequence-engine.ts").AceNextAction
  readonly rationale?: string
}

export interface ChildResultEnvelope {
  readonly childStatus: ChildStatus
  readonly resultSummary: string
  readonly runId: string | null
  readonly steps: number | null
  readonly truncated: boolean
  /** [Fase 7 / LOOP-INV-13/15] Hasil deterministik consequence-engine pada penyelesaian/
   * kegagalan turn anak — tersurat di amplop agar parent dan auditor bisa verifikasi
   * apakah outcome layak diterima apa adanya (PASS) atau perlu review/retry (FAIL).
   * Absent = test khusus / legacy runner yang belum hitung ACE. */
  readonly aceVerdict?: AceResultSnapshot
}

export interface JournalRecord {
  v: 1
  /** Identity utama: `${session}:${seq}` (seq monotonik per jurnal). */
  id: string
  session: string
  /** Rantai delegasi: id sesi parent (diisi wiring factory-site). */
  childOf?: string
  /** Nomor turn kernel saat intent (narrative; boleh null). */
  turn?: number | null
  seq: number
  tool: string
  /** mutation (default) | verification | undo | redo | finalize. Marker bukan intent. */
  kind?: "mutation" | "verification" | "undo" | "redo" | "finalize"
  /** true = klaim sukses berasal dari pihak remote (MCP), bukan komit lokal. */
  remote?: true
  /** Backend code_run ("docker"|"os"|...) — alat interpretasi, bukan kontrol. */
  backend?: string
  /** Workspace root saat record ditulis (deteksi resume-beda-cwd). */
  cwd: string
  /** Path relatif-workspace untuk verification (allowlist per kelas-tool). */
  paths?: string[]
  /** Canonical history thread for this intent (P2.10 invocation scope). */
  threadId?: string
  /** Application-owned invocation key (provider call identifiers are locators only). */
  invocationId?: string
  /** Provider call identifier, when available; never canonical by itself. */
  providerToolCallId?: string
  /** SHA-256 JSON kanonisal argumen — identitas, BUKAN replay (tanpa raw args). */
  argsHash?: string
  /**
   * [Fase 2 / LOOP-G06, LOOP-G07] Hash isi target SEBELUM efek (SHA-256 hex),
   * atau `null` bila file belum ada. Hanya ditulis jalur pre-flight (barrier
   * durable), karena hanya di sana waktu "sebelum efek" benar-benar dijamin.
   * Absent = record legacy / jalur fallback → rekonsiliasi wajib UNKNOWN.
   */
  preTargetHash?: string | null
  /**
   * Hash isi target yang DIHARAPKAN setelah efek sukses. `null` = target
   * diharapkan tidak ada (delete_file). Absent = tidak dapat dihitung dari
   * argumen (edit/apply_patch) → rekonsiliasi jatuh ke UNKNOWN bila isi
   * berubah dari preTargetHash.
   */
  postTargetHash?: string | null
  /** Tautan delegasi: id sesi anak (parent-side record). */
  childSessionId?: string
  // M1 correlator (ADR-002, additive-optional): korelasi execution pada intent
  // + terminal. Absent = record legacy / jalur belum wiring; recovery lama
  // (consolidate per `id` session:seq) tak berubah. Jangan jadikan pengganti
  // `id` — `id` tetap identity utama jurnal.
  //
  // [P1 M15][DEPRECATED] Lima field di bawah USED to be the staged place for
  // runtime correlation. Produksi TIDAK PERNAH mengisinya (nol caller), dan M15
  // menetapkan satu history eksekusi durable: jurnal runtime M11
  // (`src/runtime/execution-journal.ts`) yang memegang executionId/parent/
  // lineageRoot/version. Jurnal ini tetap milik domain mutation/undo (git
  // checkpoints), dan sengaja TIDAK menjadi bridge kedua ke runtime.
  //
  // Aturan: JANGAN menambah caller produksi yang mengisinya. Kalau sebuah record
  // butuh korelasi runtime, tulislah ke jurnal runtime; kalau butuh jejak
  // mutation, field ini tetap `absent`. Field tak dihapus agar record lama
  // (yang mungkin sudah tertulis) tetap terbaca — penghapusan adalah M16+ dan
  // butuh migrasi reader.
  /** Identity instance execution (allocated / derived stabil). DEPRECATED — see above. */
  executionId?: string
  /** Parent execution (absen pada root). DEPRECATED — see above. */
  parentExecutionId?: string
  /** Root forest korelasi (immutable). DEPRECATED — see above. */
  rootExecutionId?: string
  /** Kind datar M1. DEPRECATED — see above. */
  executionKind?: string
  /** Owner menurut arsitektur; bukan authority user input. DEPRECATED — see above. */
  ownerId?: string
  /** Marker finalize: semua seq ≤ ini durable. */
  uptoSeq?: number
  /** Marker undo/redo: turn target manifest. */
  targetTurn?: number
  /**
   * Marker undo/redo: nilai pointer manifest (currentIndex) SETELAH operasi.
   * Ditulis SETELAH apply files, SEBELUM save manifest — crash di antaranya
   * meninggalkan bukti durable untuk rekonsiliasi pointer (P0-3).
   */
  newIndex?: number
  /** Marker undo/redo: jumlah file yang berhasil di-apply (info, bukan janji). */
  files?: number
  /** Hanya untuk kind mutation. Terminal immutable (lihat consolidate). */
  state?: JournalState
  outcome?: JournalOutcome
  /** Hanya untuk kind verification: explicit observation method and verdict. */
  method?: VerificationMethod
  verdict?: VerificationVerdict
  /** Scrubbed, length-capped pointer to the external observation (never raw content). */
  evidenceReference?: string
  /** When the external observation occurred (may differ from append time). */
  observedAt?: number
  /**
   * Bukti dedup idempotency (audit #08 P0): terminal yang ditandai ini
   * dipertahankan sweep (lihat sweepInner) agar retry id-sama pasca-restart
   * tetap terdeteksi. Dipakai server MCP: note = `req:<id>:<argsHash>`.
   * Tanpa ini finalize+sweep rutin menghapus bukti id dan retry berikutnya
   * dieksekusi ulang buta — padahal client tak bisa tahu server restart.
   */
  dedup?: true
  ts: number
}

// ── Klasifikasi closed-set berbasis efek aktual (AUDIT #01C §2) ──
//
// MUTATION = execute() dapat menimbulkan efek eksternal durable.
// "none" = terbukti tanpa efek durable (read, kontrol, full-replace
// idempoten seperti todo_write, memori-proses seperti submit_result).
// [Fase 2 / TOOL-01] Klasifikasi diturunkan dari registry kontrak tool.
// Tool tak dikenal tetap fail-closed: `classifyContractTool` mengembalikan
// "unknown" dan `isMutationTool` memperlakukannya sebagai mutasi.

export function classifyTool(name: string): "mutation" | "none" | "unknown" {
  // Nama bertitik (server.tool) = kelas mcp_call; sudah ditangani kontrak.
  return classifyContractTool(name)
}

export function isMutationTool(name: string): boolean {
  // F-14: unknown = mutasi (fail-closed). Tool baru yang lupa didaftarkan di
  // MUTATION_TOOLS/NON_MUTATION_TOOLS tetap terjurnal + ter-recovery, bukan
  // buta. Biaya salah-klasifikasi hanya baris jurnal ekstra untuk tool baca
  // yang terlupa — jauh lebih murah daripada efek tulis yang tak tercatat.
  // classifyTool tetap mengembalikan "unknown" (taksonomi untuk test-time
  // guard `tool belum diklasifikasikan` di journal.test.ts).
  return classifyTool(name) !== "none"
}

/** P2.10 canonical coverage: plain registry tools handled by an awaited wrapper. */
export function isCanonicalEvidenceCovered(name: string): boolean {
  // Independent special paths keep their own single intent/terminal pair:
  // delegate_task writes explicitly, and dotted runtime MCP tools remain on
  // the event path while MCP server mode has its own awaited instrumentation.
  return isMutationTool(name) && !NO_AUTO_JOURNAL.has(name) && !isMcpToolName(name)
}

// delegate_task dicatat eksplisit oleh tool-nya sendiri (butuh childSessionId
// yang hanya diketahui di sana) — wiring generik melewatinya agar tak ganda.
const NO_AUTO_JOURNAL: ReadonlySet<string> = new Set(["delegate_task"])

// ── Hash & paths (tanpa rahasia di jurnal) ──

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`
}

export function hashArgs(args: unknown): string {
  return createHash("sha256")
    .update(canonicalize(args ?? {}))
    .digest("hex")
}

// ── [Fase 2 / LOOP-INV-07] Tag hasil tool yang ambigu ──────────────────────
//
// `ToolResult` kernel FROZEN hanya punya `{content, isError}`. Karena itu
// status UNKNOWN diwakili prefix deterministik di awal `content`, bukan field
// baru di kernel. Format sengaja stabil dan sempit supaya bisa diparse tanpa
// menebak isi bebas:
//
//   [TOOL_OUTCOME state=UNKNOWN reason=TIMEOUT side_effect_tier=LOCAL_ENV_MUTATION duration_ms=… timeout_ms=…]
//
// Parser mengembalikan `null` untuk hasil normal, sehingga pemanggil lama tak
// berubah perilakunya.
export interface ToolOutcomeTag {
  readonly state: "UNKNOWN"
  readonly reason: string
  readonly sideEffectTier: string
  readonly durationMs: number | null
  readonly timeoutMs: number | null
}

const TOOL_OUTCOME_RE =
  /^\[TOOL_OUTCOME state=UNKNOWN reason=([A-Z_]+) side_effect_tier=([A-Z_]+)([^\]]*)\]/

export function parseToolOutcomeTag(content: string): ToolOutcomeTag | null {
  if (typeof content !== "string") return null
  const m = TOOL_OUTCOME_RE.exec(content)
  if (!m) return null
  const numeric = (key: string): number | null => {
    const mm = new RegExp(`(?:^|\\s)${key}=(\\d+)(?:\\s|$)`).exec(m[3] ?? "")
    return mm ? Number(mm[1]) : null
  }
  return {
    state: "UNKNOWN",
    reason: m[1]!,
    sideEffectTier: m[2]!,
    durationMs: numeric("duration_ms"),
    timeoutMs: numeric("timeout_ms"),
  }
}

/** Ambil path verifikasi (relatif, di dalam root) sesuai kelas tool. */
export function verifyPaths(tool: string, args: unknown, cwd: string): string[] {
  const a = (args ?? {}) as Record<string, unknown>
  const pick = (p: unknown): string | null => {
    if (typeof p !== "string" || !p) return null
    const rel = relative(cwd, resolve(cwd, p)).replace(/\\/g, "/")
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null
    return rel
  }
  const many = (v: unknown): string[] =>
    (Array.isArray(v) ? v : [])
      .map(pick)
      .filter((x): x is string => x !== null)
      .slice(0, 20)
  switch (tool) {
    case "write_file":
    case "edit":
    case "apply_patch":
    case "delete_file": {
      const p = pick(a.path)
      return p ? [p] : []
    }
    case "move_file": {
      const out = [pick(a.from), pick(a.to)].filter((x): x is string => x !== null)
      return out
    }
    case "git_commit":
      return many(a.paths)
    default:
      return []
  }
}

// ── [Fase 2 / LOOP-G06, LOOP-G07] Hash target pra/pasca mutasi ─────────────
//
// Tujuan: setelah crash, recovery bisa membedakan "belum terjadi" dari "sudah
// selesai" dari "setengah tertulis" TANPA menjalankan ulang mutasi. Bukti ini
// hanya mungkin dikumpulkan SEBELUM efek, jadi hanya jalur pre-flight (barrier
// Fase 1) yang menulisnya. Batas ukuran mencegah barrier membaca file raksasa.

const TARGET_HASH_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "apply_patch",
  "move_file",
  "delete_file",
])

/** Batas baca hash: di atas ini bukti hash dilewati (rekonsiliasi = UNKNOWN). */
const TARGET_HASH_MAX_BYTES = 8 * 1024 * 1024

async function hashFileOrNull(
  abs: string,
): Promise<{ ok: true; hash: string | null } | { ok: false }> {
  try {
    const st = await stat(abs)
    if (!st.isFile() || st.size > TARGET_HASH_MAX_BYTES) return { ok: false }
    const bytes = await readFile(abs)
    return { ok: true, hash: createHash("sha256").update(bytes).digest("hex") }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, hash: null }
    return { ok: false }
  }
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/**
 * Hitung hash pra-efek (dan pasca-efek bila dapat diturunkan dari argumen).
 * Tak pernah melempar: kegagalan baca = bukti tidak tersedia (field absen),
 * bukan alasan menggagalkan tool.
 */
async function targetHashesFor(
  name: string,
  args: Record<string, unknown>,
  root: string,
): Promise<{ preTargetHash?: string | null; postTargetHash?: string | null }> {
  if (!TARGET_HASH_TOOLS.has(name)) return {}
  const rel = verifyPaths(name, args, root)[0]
  if (!rel) return {}
  const pre = await hashFileOrNull(resolve(root, rel))
  if (!pre.ok) return {}
  const out: { preTargetHash?: string | null; postTargetHash?: string | null } = {
    preTargetHash: pre.hash,
  }
  if (name === "write_file" && typeof args.content === "string") {
    out.postTargetHash = sha256Text(args.content)
  } else if (name === "delete_file") {
    // Field hadir dengan nilai null = "diharapkan tidak ada setelah efek".
    out.postTargetHash = null
  }
  // edit/apply_patch/move_file: isi akhir tidak dapat diturunkan dari argumen
  // tanpa menerapkan patch → postTargetHash absen (rekonsiliasi = UNKNOWN bila
  // isi berubah dari pre).
  return out
}

export type WorkspaceMutationVerdict = "CONFIRMED_NOT_EXECUTED" | "CONFIRMED_EXECUTED" | "UNKNOWN"

export interface WorkspaceReconciliation {
  readonly verdict: WorkspaceMutationVerdict
  readonly targetPath: string | null
  readonly observedHash: string | null
  readonly reason: string
}

/**
 * [Fase 2 / LOOP-G06, LOOP-G07] Rekonsiliasi deterministik satu intent mutasi
 * terhadap kondisi disk SEKARANG.
 *
 * Aturan (urutan penting):
 *   1. isi == preTargetHash DAN != postTargetHash  → CONFIRMED_NOT_EXECUTED
 *   2. postTargetHash diketahui DAN isi == post     → CONFIRMED_EXECUTED
 *   3. selain itu (berubah tapi bukan post yang diketahui, record legacy tanpa
 *      hash, path di luar root, file tak terbaca)   → UNKNOWN
 *
 * `UNKNOWN` adalah jawaban aman: pemanggil wajib memverifikasi/meminta
 * keputusan, bukan mengulang mutasi.
 */
export async function reconcileWorkspaceMutationIntent(
  record: Pick<JournalRecord, "paths" | "preTargetHash" | "postTargetHash">,
  workspaceRoot: string,
): Promise<WorkspaceReconciliation> {
  const root = resolve(workspaceRoot)
  const rel = record.paths?.[0]
  if (!rel) {
    return { verdict: "UNKNOWN", targetPath: null, observedHash: null, reason: "no-target-path" }
  }
  const abs = resolve(root, rel)
  const back = relative(root, abs).replace(/\\/g, "/")
  if (!back || back.startsWith("..") || isAbsolute(back)) {
    return { verdict: "UNKNOWN", targetPath: rel, observedHash: null, reason: "path-outside-root" }
  }
  if (record.preTargetHash === undefined) {
    return {
      verdict: "UNKNOWN",
      targetPath: rel,
      observedHash: null,
      reason: "no-pre-target-hash",
    }
  }
  const observed = await hashFileOrNull(abs)
  if (!observed.ok) {
    return { verdict: "UNKNOWN", targetPath: rel, observedHash: null, reason: "target-unreadable" }
  }
  const pre = record.preTargetHash
  const post = record.postTargetHash
  if (observed.hash === pre && post !== pre) {
    return {
      verdict: "CONFIRMED_NOT_EXECUTED",
      targetPath: rel,
      observedHash: observed.hash,
      reason: "content-matches-pre",
    }
  }
  if (post !== undefined && observed.hash === post) {
    return {
      verdict: "CONFIRMED_EXECUTED",
      targetPath: rel,
      observedHash: observed.hash,
      reason: "content-matches-post",
    }
  }
  return {
    verdict: "UNKNOWN",
    targetPath: rel,
    observedHash: observed.hash,
    reason: "content-differs-from-known-states",
  }
}

// ── Lokasi & state penulis ──

function sanitizeId(s: string): string {
  // F-17: delegasi ke sanitizer bersama (dulu duplikasi 3 baris dengan
  // pemetaan sedikit berbeda dari checkpoint/shadow).
  return sanitizeSessionPart(s)
}

export function journalPath(sessionId: string, cwd?: string): string {
  return resolve(cwd ?? process.cwd(), ".minicode", `journal-${sanitizeId(sessionId)}.jsonl`)
}

export function deleteJournalFile(sessionId: string, cwd?: string): void {
  // Lifecycle: ikut hapus sesi/TTL (best-effort, sinkron agar materai).
  void import("node:fs").then(({ unlinkSync }) => {
    try {
      unlinkSync(journalPath(sessionId, cwd))
    } catch {}
  })
}

/**
 * Temukan jurnal yatim untuk purge TTL (AUDIT #01E §6): file milik sesi yang
 * tak ada di tabel sessions DAN tak dirujuk delegasi hidup mana pun DAN
 * lebih tua dari TTL. Unreadable dilewati (tak bisa dibuktikan yatim —
 * menghapus yang tak terbaca adalah heuristik berbahaya).
 */
export async function findOrphanJournals(
  journalDir: string,
  knownSessionIds: Set<string>,
  ttlDays: number,
  nowMs = Date.now(),
): Promise<string[]> {
  const { readdir, readFile: readF, stat } = await import("node:fs/promises")
  let entries: string[]
  try {
    entries = await readdir(journalDir)
  } catch {
    return []
  }
  const files = entries.filter((f) => f.startsWith("journal-") && f.endsWith(".jsonl"))
  // Pass 1: kumpulkan referensi anak dari semua file terbaca (parent yang
  // masih hidup melindungi jurnal anaknya walau id anak asing bagi DB).
  const referenced = new Set<string>()
  const owners = new Map<string, string>() // file → owner session
  for (const f of files) {
    const full = join(journalDir, f)
    let raw: string
    try {
      raw = await readF(full, "utf8")
    } catch {
      continue // unreadable → jangan sentuh (lihat kontrak di atas)
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as { session?: unknown; childSessionId?: unknown }
        if (typeof r.session === "string" && !owners.has(f)) owners.set(f, r.session)
        if (typeof r.childSessionId === "string") referenced.add(r.childSessionId)
      } catch {
        break // baris korup: pemilik dari record valid sebelumnya (atau tak ada)
      }
    }
    if (!owners.has(f)) {
      // File kosong/penuh-sampah-terbaca: fallback stem nama (best-effort).
      owners.set(f, f.slice("journal-".length, -".jsonl".length))
    }
  }
  // Pass 2: yatim = pemilik asing + tak dirujuk + tua.
  const cutoff = nowMs - ttlDays * 24 * 60 * 60 * 1000
  const orphans: string[] = []
  for (const f of files) {
    const owner = owners.get(f)
    if (!owner || knownSessionIds.has(owner) || referenced.has(owner)) continue
    try {
      const st = await stat(join(journalDir, f))
      if (st.mtimeMs < cutoff) orphans.push(join(journalDir, f))
    } catch {}
  }
  return orphans.sort()
}

interface WriterState {
  nextSeq: number
  healthy: boolean
}

const writers = new Map<string, WriterState>()
/** File yang gagal dibuat/ditulis (di luar map writers agar tak merusak seq). */
const degradedFiles = new Set<string>()

function writerKey(session: string, cwd: string): string {
  return `${resolve(cwd)}::${session}`
}

// ── Serialisasi per-file (§F16): alokasi seq + append harus atomik terhadap
// sesama penulis. Tanpa ini dua intent konkuren membaca nextSeq sama →
// tabrakan id → konsolidasi/keputusan runtuh. Rantai janji per file; deadlock
// mustahil selama callback tak memanggil API terkunci lain (dipatuhi).
const fileLocks = new Map<string, Promise<void>>()

async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key)
  let release!: () => void
  const gate = new Promise<void>((res) => {
    release = res
  })
  fileLocks.set(key, gate)
  if (prev) {
    try {
      await prev
    } catch {}
  }
  try {
    return await fn()
  } finally {
    release()
  }
}

export function isJournalHealthy(sessionId: string, cwd?: string): boolean {
  const root = resolve(cwd ?? process.cwd())
  if (degradedFiles.has(journalPath(sessionId, root))) return false
  return writers.get(writerKey(sessionId, root))?.healthy ?? true
}

function markDegraded(sessionId: string, cwd: string, why: string): void {
  degradedFiles.add(journalPath(sessionId, cwd))
  const st = writers.get(writerKey(sessionId, cwd))
  if (st) st.healthy = false
  process.stderr.write(`[warn] journal degraded (${why})\n`)
}

// ── Tulis durabel: append → flush/fsync (§10) ──

async function appendLine(path: string, obj: JournalRecord): Promise<boolean> {
  const line = `${JSON.stringify(obj)}\n`
  // Baris kecil + O_APPEND = tulis atomik antar proses (POSIX); cukup untuk
  // satu penulis per sesi + penulis sesekali (sweep memakai file lain).
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => {})
    const h = await open(path, "a")
    try {
      await h.appendFile(line, "utf8")
      await h.sync()
    } finally {
      await h.close().catch(() => {})
    }
    return true
  } catch (e) {
    process.stderr.write(`[warn] journal: write failed (${path}): ${(e as Error).message}\n`)
    return false
  }
}

async function stateFor(path: string, key: string): Promise<WriterState> {
  let st = writers.get(key)
  if (!st) {
    st = { nextSeq: 0, healthy: true }
    // Lanjutkan seq lintas restart proses (anti tabrakan id).
    try {
      const raw = await readFile(path, "utf8")
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as { seq?: unknown }
          if (typeof r.seq === "number" && Number.isFinite(r.seq)) {
            st.nextSeq = Math.max(st.nextSeq, Math.floor(r.seq) + 1)
          }
        } catch {}
      }
    } catch {}
    writers.set(key, st)
  }
  return st
}

export interface IntentInput {
  session: string
  childOf?: string
  turn?: number | null
  tool: string
  threadId?: string
  /** Provisional or canonical application-owned invocation key. */
  invocationId?: string
  providerToolCallId?: string
  /** Allocate the canonical key from the reserved journal sequence inside the lock. */
  allocateInvocationId?: (allocationSequence: number) => string
  remote?: true
  backend?: string
  cwd?: string
  paths?: string[]
  argsHash?: string
  /** [Fase 2 / LOOP-G06] Hash isi target sebelum efek (lihat JournalRecord). */
  preTargetHash?: string | null
  /** [Fase 2 / LOOP-G07] Hash target yang diharapkan setelah efek sukses. */
  postTargetHash?: string | null
  childSessionId?: string
  /**
   * Kunci idempotency (audit #08): ditulis ke outcome.note SEJAK intent agar
   * crash di tengah eksekusi tetap meninggalkan bukti yang dapat dicocokkan
   * (sebelumnya note hanya ada di terminal → bukti pending tak terlihat →
   * retry id-sama pasca-crash dieksekusi ulang buta).
   */
  note?: string
  // M1 correlator (ADR-002, passthrough): korelasi execution opsional dari
  // pemanggil (Host M3+). Absent = jalur belum wiring — perilaku lama utuh.
  // Validasi bentuk BUKAN di sini (allocator/helper yang menjamin); jurnal
  // hanya menyalin string yang diberikan (tanpa rahasia: id/korelasi publik).
  executionId?: string
  parentExecutionId?: string
  rootExecutionId?: string
  executionKind?: string
  ownerId?: string
}

/** Tulis intent pending. Tak pernah throw (degraded-loud, lihat header). */
export async function appendMutationIntent(input: IntentInput): Promise<JournalRecord> {
  const root = resolve(input.cwd ?? process.cwd())
  const path = journalPath(input.session, root)
  const key = writerKey(input.session, root)
  return withFileLock(key, async () => {
    const st = await stateFor(path, key)
    // Alokasi seq SYNCHRONOUS di dalam lock: tanpa ini dua pemanggil konkuren
    // mendapat seq sama (tabrakan id — P0, ditemukan AUDIT #01D).
    const seq = st.nextSeq
    const invocationId = input.allocateInvocationId
      ? input.allocateInvocationId(seq)
      : input.invocationId
    const rec: JournalRecord = {
      v: 1,
      id: `${input.session}:${seq}`,
      session: input.session,
      ...(input.childOf ? { childOf: input.childOf } : {}),
      turn: input.turn ?? null,
      seq,
      tool: input.tool,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(invocationId ? { invocationId } : {}),
      ...(input.providerToolCallId ? { providerToolCallId: input.providerToolCallId } : {}),
      ...(input.remote ? { remote: true as const } : {}),
      ...(input.backend ? { backend: input.backend } : {}),
      cwd: root,
      ...(input.paths?.length ? { paths: input.paths } : {}),
      ...(input.argsHash ? { argsHash: input.argsHash } : {}),
      ...(input.preTargetHash !== undefined ? { preTargetHash: input.preTargetHash } : {}),
      ...(input.postTargetHash !== undefined ? { postTargetHash: input.postTargetHash } : {}),
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      // M1 correlator passthrough (absent = tak ada perubahan perilaku).
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}),
      ...(input.rootExecutionId ? { rootExecutionId: input.rootExecutionId } : {}),
      ...(input.executionKind ? { executionKind: input.executionKind } : {}),
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      // Kunci idempotency sejak intent (lihat IntentInput.note).
      ...(input.note ? { outcome: { note: input.note } } : {}),
      state: "pending",
      ts: Date.now(),
    }
    // Tak-pernah-throw disengaja: kegagalan jurnal tak boleh menggagalkan turn.
    // Resume memperlakukan sesi degraded via jalur advisory + warn ini.
    if (await appendLine(path, rec)) {
      st.nextSeq = seq + 1
    } else {
      markDegraded(input.session, root, "intent append gagal")
    }
    return rec
  })
}

/** Tulis terminal (committed/failed) untuk id intent. Append-only. */
export async function appendMutationTerminal(
  session: string,
  cwd: string | undefined,
  id: string,
  seq: number,
  tool: string,
  state: "committed" | "failed" | "unknown",
  outcome?: JournalOutcome,
  childSessionId?: string,
  opts: {
    dedup?: boolean
    threadId?: string
    invocationId?: string
    providerToolCallId?: string
    argsHash?: string
    receipt?: Omit<JournalOutcome, "code" | "note">
    // M1 correlator passthrough (absent = terminal legacy tanpa korelasi).
    executionId?: string
    parentExecutionId?: string
    rootExecutionId?: string
    executionKind?: string
    ownerId?: string
  } = {},
): Promise<void> {
  const root = resolve(cwd ?? process.cwd())
  const path = journalPath(session, root)
  const key = writerKey(session, root)
  return withFileLock(key, async () => {
    await stateFor(path, key)
    const rec: JournalRecord = {
      v: 1,
      id,
      session,
      seq,
      tool,
      state,
      cwd: root,
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      ...(opts.invocationId ? { invocationId: opts.invocationId } : {}),
      ...(opts.providerToolCallId ? { providerToolCallId: opts.providerToolCallId } : {}),
      ...(opts.argsHash ? { argsHash: opts.argsHash } : {}),
      ...(outcome || opts.receipt
        ? {
            outcome: {
              ...(outcome ?? {}),
              ...(opts.receipt ?? {}),
              ...(opts.receipt?.observedAt === undefined ? { observedAt: Date.now() } : {}),
            },
          }
        : {}),
      // Tautan delegasi diwariskan ke terminal agar pembaca tak perlu
      // join intent-terminal untuk mengetahui anak mana yang dirujuk.
      ...(childSessionId ? { childSessionId } : {}),
      // Bukti dedup idempotency (mis. MCP request id): dipertahankan sweep.
      ...(opts.dedup ? { dedup: true as const } : {}),
      // M1 correlator passthrough terminal (diwariskan dari intent pemanggil).
      ...(opts.executionId ? { executionId: opts.executionId } : {}),
      ...(opts.parentExecutionId ? { parentExecutionId: opts.parentExecutionId } : {}),
      ...(opts.rootExecutionId ? { rootExecutionId: opts.rootExecutionId } : {}),
      ...(opts.executionKind ? { executionKind: opts.executionKind } : {}),
      ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
      ts: Date.now(),
    }
    const st = writers.get(key)
    if (!(await appendLine(path, rec)) && st) markDegraded(session, root, "terminal append gagal")
  })
}

/** Append a standalone explicit external-effect observation (P2.10 VerificationRecord). */
export async function appendVerificationRecord(input: {
  session: string
  threadId?: string
  tool: string
  invocationId: string
  method: VerificationMethod
  verdict: VerificationVerdict
  evidenceReference: string
  observedAt?: number
  cwd?: string
  childOf?: string
  childSessionId?: string
  providerToolCallId?: string
}): Promise<{ record: JournalRecord; durable: boolean }> {
  if (!input.tool) throw new Error("verification: refusing record without tool")
  if (!input.invocationId) throw new Error("verification: refusing record without invocationId")
  if (!VERIFICATION_METHODS.has(input.method)) {
    throw new Error(`verification: unsupported method ${String(input.method)}`)
  }
  if (
    input.verdict !== "present" &&
    input.verdict !== "absent" &&
    input.verdict !== "inconclusive"
  ) {
    throw new Error(`verification: unsupported verdict ${String(input.verdict)}`)
  }
  const evidenceReference = scrubSecrets(String(input.evidenceReference ?? "")).slice(0, 1000)
  if (!evidenceReference) throw new Error("verification: refusing record without evidenceReference")
  const root = resolve(input.cwd ?? process.cwd())
  const path = journalPath(input.session, root)
  const key = writerKey(input.session, root)
  return withFileLock(key, async () => {
    const st = await stateFor(path, key)
    const seq = st.nextSeq
    const observedAt =
      typeof input.observedAt === "number" && Number.isFinite(input.observedAt)
        ? input.observedAt
        : Date.now()
    const rec: JournalRecord = {
      v: 1,
      id: `${input.session}:v${seq}`,
      session: input.session,
      seq,
      tool: input.tool,
      kind: "verification",
      ...(input.childOf ? { childOf: input.childOf } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      invocationId: input.invocationId,
      ...(input.providerToolCallId ? { providerToolCallId: input.providerToolCallId } : {}),
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      method: input.method,
      verdict: input.verdict,
      evidenceReference,
      observedAt,
      cwd: root,
      ts: Date.now(),
    }
    const durable = await appendLine(path, rec)
    if (durable) st.nextSeq = seq + 1
    else markDegraded(input.session, root, "verification append gagal")
    return { record: rec, durable }
  })
}

/** Marker finalize: semua seq ≤ uptoSeq durable (post-persistCurrent). */
export async function appendFinalize(
  session: string,
  cwd: string | undefined,
  uptoSeq: number,
): Promise<void> {
  const root = resolve(cwd ?? process.cwd())
  const path = journalPath(session, root)
  const key = writerKey(session, root)
  return withFileLock(key, async () => {
    const st = await stateFor(path, key)
    const seq = st.nextSeq
    const rec: JournalRecord = {
      v: 1,
      id: `${session}:f${seq}`,
      session,
      seq,
      tool: "",
      kind: "finalize",
      uptoSeq,
      cwd: root,
      ts: Date.now(),
    }
    if (await appendLine(path, rec)) st.nextSeq = seq + 1
    else markDegraded(session, root, "finalize append gagal")
  })
}

/** Marker undo/redo: posisi workspace pasca-operasi (DB tak ikut). */
export async function appendUndoMarker(
  session: string,
  cwd: string | undefined,
  kind: "undo" | "redo",
  targetTurn: number,
  extra?: { newIndex?: number; files?: number },
): Promise<void> {
  const root = resolve(cwd ?? process.cwd())
  const path = journalPath(session, root)
  const key = writerKey(session, root)
  return withFileLock(key, async () => {
    const st = await stateFor(path, key)
    const seq = st.nextSeq
    const rec: JournalRecord = {
      v: 1,
      id: `${session}:m${seq}`,
      session,
      seq,
      tool: "",
      kind,
      targetTurn,
      cwd: root,
      ...(extra?.newIndex !== undefined ? { newIndex: extra.newIndex } : {}),
      ...(extra?.files !== undefined ? { files: extra.files } : {}),
      ts: Date.now(),
    }
    if (await appendLine(path, rec)) st.nextSeq = seq + 1
    else markDegraded(session, root, "marker append gagal")
  })
}

/** Finalize + sweep: dipanggil setelah persistCurrent sukses. */
export async function finalizeJournal(sessionId: string, cwd?: string): Promise<void> {
  const root = resolve(cwd ?? process.cwd())
  const path = journalPath(sessionId, root)
  const key = writerKey(sessionId, root)
  const st = await stateFor(path, key)
  const maxMutation = st.nextSeq - 1
  if (maxMutation < 0) return
  await appendFinalize(sessionId, root, maxMutation)
  await sweepJournal(sessionId, root).catch((e) => {
    process.stderr.write(`[warn] journal: sweep failed: ${(e as Error).message}\n`)
  })
}

/**
 * Hapus HANYA yang finalized + marker lama. Atomic: tulis tmp → rename.
 * - committed/failed dengan seq ≤ maxUpto → finalized → buang.
 * - pending TAK PERNAH dibuang karena finalize (finalize menandai persist,
 *   bukan status mutasi) — KECUALI superseded: mutasi sama (tool+paths)
 *   berhasil di-commit belakangan = bukti operator verifikasi + jalan terus.
 *   Pending tanpa paths (bash/MCP) tak bisa disupersede — ambiguitasnya
 *   genuinely berbahaya, jadi bertahan sampai resolvePending eksplisit.
 */
export async function sweepJournal(sessionId: string, cwd?: string): Promise<number> {
  const root = resolve(cwd ?? process.cwd())
  const key = writerKey(sessionId, root)
  // Sweep vs append konkuren = lost-record: serialkan dengan penulis.
  return withFileLock(key, () => sweepInner(sessionId, root))
}

async function sweepInner(sessionId: string, root: string): Promise<number> {
  const path = journalPath(sessionId, root)
  const loaded = await loadJournal(sessionId, root)
  if (loaded.records.length === 0) return 0
  let maxUpto = -1
  for (const r of loaded.records) {
    if (r.kind === "finalize" && typeof r.uptoSeq === "number")
      maxUpto = Math.max(maxUpto, r.uptoSeq)
  }
  if (maxUpto < 0) return 0
  // Pasangan selesai: pending yang sudah punya terminal (id sama) ikut
  // dibuang — statusnya hidup di record terminal (satu semantik mutasi).
  const paired = new Set<string>()
  for (const r of loaded.records) {
    if ((!r.kind || r.kind === "mutation") && isTerminalJournalState(r.state)) {
      paired.add(r.id)
    }
  }
  const committedKeys = committedPathsKeys(loaded.records)
  // [Audit #2 C.F8] Hoist maxFinalizeSeq ke konstanta — semula dihitung ulang
  // di dalam `.filter` untuk setiap record (O(n²)). Sekali jalan = O(n).
  const maxFinalize = maxFinalizeSeq(loaded.records)
  const keep = loaded.records.filter((r) => {
    if (r.kind === "finalize") return r.seq === maxFinalize
    if (r.kind === "undo" || r.kind === "redo") return r.seq > maxUpto
    // P2.10 verification evidence is retained like dedup terminals: it may be
    // the only durable external-effect observation after finalize/sweep.
    // Bound by per-session files + orphan TTL, not by finalize.
    if (r.kind === "verification") return true
    if (r.state === "pending" && paired.has(r.id)) return false
    if (r.state === "pending") return !isSuperseded(r, committedKeys)
    // Bukti dedup idempotency (dedup: true, mis. MCP request id) BUKAN sampah
    // finalize: menghapusnya membuat retry id-sama pasca-restart dieksekusi
    // ulang buta (audit #08 P0 — reproducer: note hilang setelah sweep).
    // Intent pasangannya tetap dibuang (aturan paired di atas); terminal ini
    // yang menjadi bukti. Batas pertumbuhan: file per sesi + purge yatim TTL.
    if ((!r.kind || r.kind === "mutation") && isTerminalJournalState(r.state) && r.dedup === true)
      return true
    return (r.seq ?? 0) > maxUpto // committed/failed muda bertahan
  })
  if (keep.length === loaded.records.length) return 0
  const data = keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : "")
  await atomicWriteText(path, data)
  // Sinkronkan counter in-memory dengan file hasil sweep.
  const key = writerKey(sessionId, root)
  const st = writers.get(key)
  if (st) {
    let mx = -1
    for (const r of keep) if (typeof r.seq === "number") mx = Math.max(mx, r.seq)
    st.nextSeq = mx + 1
  }
  return loaded.records.length - keep.length
}

/** Kunci supersede: tool + paths non-kosong (bash/MCP tanpa path tak ikut). */
function pathsKey(tool: string, paths?: string[]): string | null {
  if (!paths || paths.length === 0) return null
  return `${tool}|${[...paths].sort().join(",")}`
}

function committedPathsKeys(records: JournalRecord[]): Set<string> {
  const out = new Set<string>()
  // Terminal committed per id (duplikat: terminal pertama menang — sama
  // seperti consolidate di decideRecovery).
  const seen = new Set<string>()
  for (const r of records) {
    if (r.kind && r.kind !== "mutation") continue
    if (r.state !== "committed" || seen.has(r.id)) continue
    seen.add(r.id)
    const k = pathsKey(r.tool, r.paths)
    if (k) out.add(`${k}@${r.seq}`)
  }
  return out
}

function isSuperseded(r: JournalRecord, committedKeys: Set<string>): boolean {
  const k = pathsKey(r.tool, r.paths)
  if (!k) return false
  for (const entry of committedKeys) {
    const at = entry.lastIndexOf("@")
    if (entry.slice(0, at) === k && Number(entry.slice(at + 1)) > r.seq) return true
  }
  return false
}

/**
 * Resolusi manual pending → terminal berdasar verifikasi manusia (calon
 * pemanggil: perintah /verify-ack masa depan). applied = efek ada (jangan
 * ulang); absent = efek tak ada (boleh coba lagi via gate normal).
 */
export async function resolvePending(
  sessionId: string,
  cwd: string | undefined,
  seq: number,
  verdict: "applied" | "absent",
  note?: string,
): Promise<boolean> {
  const root = resolve(cwd ?? process.cwd())
  const loaded = await loadJournal(sessionId, root)
  const mine = loaded.records.filter(
    (r) => (!r.kind || r.kind === "mutation") && r.session === sessionId && r.seq === seq,
  )
  if (mine.length === 0) return false
  if (mine.some((r) => isTerminalJournalState(r.state))) return false
  const first = mine[0]!
  await appendMutationTerminal(
    sessionId,
    root,
    first.id,
    seq,
    first.tool,
    verdict === "applied" ? "committed" : "failed",
    { note: `human-verified:${verdict}${note ? ` ${note}` : ""}` },
  )
  return true
}

function maxFinalizeSeq(records: JournalRecord[]): number {
  let mx = -1
  for (const r of records) {
    if (r.kind === "finalize" && typeof r.seq === "number") mx = Math.max(mx, r.seq)
  }
  return mx
}

// ── Baca + korupsi (§9) ──

export interface JournalLoad {
  records: JournalRecord[]
  warnings: string[]
  /** Ekor terpotong (fail-closed keputusan, fail-open sesi). */
  truncatedTail: boolean
  quarantined: boolean
  /**
   * Status file — TIDAK disamakan:
   * absent = tak pernah ada (bukan bukti apa pun);
   * empty = ada tetapi nol record (sesi terpasang, belum bermutasi);
   * valid = ≥1 record utuh; corrupt = dikarantina / ekor-rusak tanpa isi;
   * unreadable = ada tetapi tak terbaca (bukan bukti kosong).
   */
  status: "absent" | "empty" | "valid" | "corrupt" | "unreadable"
}

function isRecordShape(r: unknown): r is JournalRecord {
  if (!r || typeof r !== "object") return false
  const o = r as Record<string, unknown>
  if (o.v !== 1 || typeof o.id !== "string" || typeof o.session !== "string") return false
  if (typeof o.seq !== "number" || !Number.isFinite(o.seq)) return false
  if (o.kind === "finalize" || o.kind === "undo" || o.kind === "redo") return true
  if (o.kind === "verification") {
    return (
      typeof o.tool === "string" &&
      o.tool !== "" &&
      typeof o.invocationId === "string" &&
      o.invocationId !== "" &&
      VERIFICATION_METHODS.has(o.method as VerificationMethod) &&
      (o.verdict === "present" || o.verdict === "absent" || o.verdict === "inconclusive") &&
      typeof o.evidenceReference === "string" &&
      o.evidenceReference !== "" &&
      typeof o.observedAt === "number" &&
      Number.isFinite(o.observedAt)
    )
  }
  if (typeof o.tool !== "string" || !o.tool) return false
  return o.state === "pending" || isTerminalJournalState(o.state as JournalState)
}

export async function loadJournal(sessionId: string, cwd?: string): Promise<JournalLoad> {
  const root = resolve(cwd ?? process.cwd())
  const path = journalPath(sessionId, root)
  const warnings: string[] = []
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (e) {
    // ENOENT = memang tak ada (bukan bukti kosong). Sisanya = unreadable,
    // BUKAN empty — file yang tak terbaca tak boleh disamakan dengan bersih.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { records: [], warnings, truncatedTail: false, quarantined: false, status: "absent" }
    }
    warnings.push(`journal tak terbaca (${path}): ${(e as Error).message}`)
    return { records: [], warnings, truncatedTail: false, quarantined: false, status: "unreadable" }
  }
  const lines = raw.split("\n")
  // Baris akhir kosong = terminator normal, bukan truncasi.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const records: JournalRecord[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      const r = await handleCorrupt(
        path,
        lines,
        i,
        records,
        warnings,
        `baris ${i + 1} bukan JSON valid`,
      )
      return { ...r, status: "corrupt" }
    }
    if (!isRecordShape(parsed)) {
      const r = await handleCorrupt(
        path,
        lines,
        i,
        records,
        warnings,
        `baris ${i + 1} bentuk record invalid`,
      )
      return { ...r, status: "corrupt" }
    }
    records.push(parsed)
  }
  return {
    records,
    warnings,
    truncatedTail: false,
    quarantined: false,
    status: records.length > 0 ? "valid" : "empty",
  }
}

async function handleCorrupt(
  path: string,
  lines: string[],
  at: number,
  prefix: JournalRecord[],
  warnings: string[],
  reason: string,
): Promise<JournalLoad> {
  const isTail = at === lines.length - 1
  if (isTail) {
    // Ekor terpotong (crash mid-append): buang baris, pakai prefix.
    warnings.push(
      `journal korup di ekor (${reason}) — baris dibuang, prefix (${prefix.length} record) tetap otoritatif`,
    )
    try {
      await atomicWriteText(
        path,
        prefix.map((r) => JSON.stringify(r)).join("\n") + (prefix.length ? "\n" : ""),
      )
    } catch {}
    return { records: prefix, warnings, truncatedTail: true, quarantined: false, status: "corrupt" }
  }
  // Tengah korup: quarantine + pertahankan prefix sebagai live.
  const qpath = `${path}.corrupt.${Date.now()}`
  warnings.push(
    `journal KORUP di tengah (${reason}) — file dikarantina ke ${qpath}; prefix (${prefix.length} record) dipakai, suffix dianggap pending/ambigu`,
  )
  try {
    await atomicWriteText(qpath, lines.join("\n"))
    await atomicWriteText(
      path,
      prefix.map((r) => JSON.stringify(r)).join("\n") + (prefix.length ? "\n" : ""),
    )
  } catch {}
  return { records: prefix, warnings, truncatedTail: false, quarantined: true, status: "corrupt" }
}

// ── Keputusan resume murni: decideRecovery (tanpa I/O) ──

export interface AttentionItem {
  id: string
  seq: number
  tool: string
  state: JournalState
  remote: boolean
  paths: string[]
  childSessionId?: string
  turn?: number | null
}

export interface RecoveryPlan {
  clean: boolean
  /** SATU blok SYSTEM (blocking + stitch + remote). null bila clean. */
  directive: string | null
  warnings: string[]
  attention: AttentionItem[]
  stitched: { id: string; tool: string; turn?: number | null }[]
  stats: {
    pending: number
    failed: number
    committed: number
    /** [Fase 2 / LOOP-INV-07] Terminal ambigu: efek belum bisa dipastikan. */
    unknown: number
    finalized: number
    markers: number
  }
}

const MAX_DIRECTIVE_ITEMS = 10

export function decideRecovery(
  records: JournalRecord[],
  persistedTurns: number[],
  opts: { maxItems?: number } = {},
): RecoveryPlan {
  const warnings: string[] = []
  const maxItems = opts.maxItems ?? MAX_DIRECTIVE_ITEMS
  // Konsolidasi per id (append-only boleh punya pasangan pending→terminal).
  // Aturan: terminal pertama menang; terminal ganda / terminal→pending =
  // anomali → warn + abaikan tulisan basi.
  const byId = new Map<string, JournalRecord[]>()
  for (const r of records) {
    if (r.kind && r.kind !== "mutation") continue
    const list = byId.get(r.id) ?? []
    list.push(r)
    byId.set(r.id, list)
  }
  // Finalize scope = PER SESSION FILE (seq spaces tak sebanding antar file).
  // Global maxUpto akan mencampur namespace parent/child secara salah.
  const uptoBySession = new Map<string, number>()
  let undoRedoCount = 0
  // Marker undo/redo untuk aturan stitch (P0-3): redo mengembalikan efek
  // (stitch moot), undo mencabut efek (stitch salah → warning khusus).
  // Hanya untuk record sesi-sendiri (tanpa childOf) — namespace terisolasi.
  const redoMarks: { targetTurn: number; seq: number }[] = []
  const undoMarks: { targetTurn: number; seq: number }[] = []
  for (const r of records) {
    if (r.kind === "finalize" && typeof r.uptoSeq === "number") {
      uptoBySession.set(r.session, Math.max(uptoBySession.get(r.session) ?? -1, r.uptoSeq))
    }
    if (r.kind === "undo" || r.kind === "redo") {
      undoRedoCount += 1
      if (typeof r.targetTurn === "number" && typeof r.seq === "number") {
        ;(r.kind === "redo" ? redoMarks : undoMarks).push({ targetTurn: r.targetTurn, seq: r.seq })
      }
    }
  }
  const covered = (r: JournalRecord): boolean => r.seq <= (uptoBySession.get(r.session) ?? -1)
  // Cakupan transitif delegasi: anak ter-cover bila record delegasi parent-nya
  // terminal committed DAN finalized (skop sesi parent). Tanpa ini committed
  // anak selalu stitch karena turn anak tak ada di DB parent (false positive).
  const coveredChild = new Set<string>()
  for (const [, list] of byId) {
    const first = list[0]!
    if (first.tool !== "delegate_task" || !first.childSessionId) continue
    const term = list.find((r) => isTerminalJournalState(r.state))
    if (term?.state === "committed" && covered(term)) coveredChild.add(first.childSessionId)
  }
  // Gap seq = kemungkinan penulis ganda/hilang (peringatan, bukan blokir).
  const seqs = [...byId.values()].map((l) => l[0]!.seq).sort((a, b) => a - b)
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i]! - seqs[i - 1]! > 1) {
      warnings.push(
        `journal seq gap ${seqs[i - 1]} → ${seqs[i]} (kemungkinan tulis hilang/penulis ganda)`,
      )
      break
    }
  }
  const stats = {
    pending: 0,
    failed: 0,
    committed: 0,
    unknown: 0,
    finalized: 0,
    markers: undoRedoCount,
  }
  const attention: AttentionItem[] = []
  const stitched: { id: string; tool: string; turn?: number | null }[] = []
  const remoteVerify: AttentionItem[] = []
  const supersedeKeys = committedPathsKeys(records)
  for (const [, list] of [...byId.entries()].sort((a, b) => a[1][0]!.seq - b[1][0]!.seq)) {
    const first = list[0]!
    if (list.length > 1) {
      const terminals = list.filter((r) => isTerminalJournalState(r.state))
      if (terminals.length > 1) {
        warnings.push(
          `journal id duplikat ${first.id} (${terminals.length} terminal) — pakai yang pertama`,
        )
      }
      const stalePending = list.findIndex((r, i) => i > 0 && r.state === "pending")
      if (stalePending !== -1 || (terminals.length === 0 && list.length > 1)) {
        warnings.push(`journal id duplikat ${first.id} — abaikan tulisan basi`)
      }
    }
    const eff = list.find((r) => isTerminalJournalState(r.state)) ?? first
    if (!eff.state || eff.state === "pending") {
      // Superseded = mutasi sama berhasil belakangan = bukti verifikasi
      // implisit (sweep akan membuangnya). Jangan nagih yang sudah terjawab.
      if (isSuperseded(first, supersedeKeys)) continue
      stats.pending += 1
      if (covered(first)) {
        // Tertutup finalize tetapi tanpa terminal: finalize menandai cakupan
        // persist, BUKAN status mutasi — tetap ambigu (konservatif benar).
        warnings.push(
          `journal ${first.id} pending tetapi ter-cover finalize — tetap diperlakukan ambigu`,
        )
      }
      attention.push(toItem(first, "pending"))
      continue
    }
    if (eff.state === "unknown") {
      // [Fase 2 / LOOP-INV-07] Terminal ambigu SELALU butuh verifikasi, bahkan
      // bila sudah ter-cover finalize: finalize membuktikan record durable,
      // bukan membuktikan efek terjadi/tidak. Menyembunyikannya = auto-retry
      // buta pada perintah yang mungkin sudah setengah berjalan.
      stats.unknown += 1
      warnings.push(
        `journal ${first.id} (${first.tool}) berakhir UNKNOWN — efek belum dapat dipastikan; verifikasi sebelum mengulang`,
      )
      attention.push(toItem(first, "unknown"))
      continue
    }
    if (eff.state === "failed") {
      stats.failed += 1
      if (covered(first)) {
        stats.finalized += 1
        continue
      }
      attention.push(toItem(first, "failed"))
      continue
    }
    // committed
    if (covered(first)) {
      stats.committed += 1
      stats.finalized += 1
      continue
    }
    // Anak ter-cover transitif: delegasi parent-nya committed + finalized
    // (skop sesi parent). Tanpa ini setiap committed anak stitch spurios.
    if (first.childOf && coveredChild.has(first.session)) {
      stats.committed += 1
      continue
    }
    stats.committed += 1
    if (first.remote) {
      remoteVerify.push(toItem(first, "committed"))
      continue
    }
    // Redo yang lebih baru dan mencakup turn ini mengembalikan efeknya —
    // stitch moot. BUKAN auto-redo: redo sudah terjadi dan tercatat.
    // (Remote dikecualikan di atas: redo file tak memulihkan efek server.)
    if (!first.childOf && first.turn != null) {
      const redone = redoMarks.some((mk) => mk.seq > first.seq && mk.targetTurn >= first.turn!)
      if (redone) continue
      // Undo yang lebih baru dan mencakup turn ini MENCABUT efeknya: stitch
      // "anggap efek ada" menjadi salah — ganti warning jujur, tanpa redo.
      const undone = undoMarks.some((mk) => mk.seq > first.seq && first.turn! >= mk.targetTurn)
      if (undone) {
        warnings.push(
          `efek turn ${first.turn} (${first.tool}) di-undo sesudah commit — transkrip lebih baru dari file; JANGAN ulangi otomatis, JANGAN percaya penuh`,
        )
        continue
      }
    }
    // ISOLASI NAMESPACE TURN: turn anak tak pernah dibandingkan dengan turns
    // parent (ruang turn berbeda). Anak uncovered selalu stitch — aman dan
    // tak pernah cross-match kebetulan.
    if (!first.childOf) {
      const turn = first.turn ?? null
      if (turn !== null && persistedTurns.includes(turn)) continue // normal
    }
    stitched.push({ id: first.id, tool: first.tool, turn: first.turn ?? null })
  }
  const blocks: string[] = []
  const shown = attention.slice(0, maxItems)
  if (shown.length > 0) {
    blocks.push(
      "MUTASI TAK-PASTI (pending/failed/unknown) — verifikasi SEBELUM mengulang; DILARANG redo buta:",
      ...shown.map(
        (a) =>
          `- [seq ${a.seq}] ${a.tool} (${a.state})${a.paths.length ? ` paths: ${a.paths.join(", ")}` : " (tanpa path — diff workspace vs checkpoint)"}${a.childSessionId ? ` child: ${a.childSessionId}` : ""}`,
      ),
    )
    if (attention.length > shown.length) {
      blocks.push(
        `- ... +${attention.length - shown.length} lagi — minta keputusan user sebelum lanjut.`,
      )
    }
  }
  if (remoteVerify.length > 0) {
    const rshown = remoteVerify.slice(0, maxItems)
    blocks.push(
      "MUTASI REMOTE (external-acknowledged, BUKAN komit lokal) — wajib baca-balik sebelum membangun state di atasnya:",
      ...rshown.map((a) => `- [seq ${a.seq}] ${a.tool}`),
    )
  }
  if (stitched.length > 0) {
    blocks.push(
      "CATATAN NARASI (bukan blokir): mutasi berikut tercatat committed tetapi turn-nya tidak durable — JANGAN dieksekusi ulang; anggap efeknya ada:",
      ...stitched.map((s) => `- [${s.id}] ${s.tool}${s.turn != null ? ` (turn ${s.turn})` : ""}`),
    )
  }
  const clean = blocks.length === 0
  return {
    clean,
    directive: clean
      ? null
      : `[recovery] Sesi sebelumnya berhenti tak-sempurna. Ikuti aturan ini:\n${blocks.join("\n")}`,
    warnings,
    attention,
    stitched,
    stats,
  }
}

function toItem(first: JournalRecord, state: JournalState): AttentionItem {
  return {
    id: first.id,
    seq: first.seq,
    tool: first.tool,
    state,
    remote: first.remote === true,
    paths: first.paths ?? [],
    ...(first.childSessionId ? { childSessionId: first.childSessionId } : {}),
    turn: first.turn ?? null,
  }
}

// ── Wiring event (titik D: execution:started/completed) ──

interface EventBusLike {
  on(type: string, handler: (event: never) => void): () => void
}

interface SessionLike {
  events: EventBusLike
  state?: { turnCount?: number }
}

interface ExecutionEvent {
  execution?: {
    call?: { name?: unknown; args?: unknown; id?: unknown }
    result?: { isError?: unknown; content?: unknown }
  }
  /** Ditandai task.ts saat event child di-forward ke bus parent: catat di
   * jurnal ANAK saja (bus asal), bukan ganda di parent. Checkpoint, trace,
   * dan UI tetap mengonsumsi event forward seperti biasa. */
  forwardedChild?: unknown
}

/**
 * Pasang jurnal pada sesi apa pun (parent maupun anak). Total: kegagalan
 * I/O jurnal tak pernah melempar ke bus turn (degraded-loud).
 */
export interface MutationJournalHandle {
  /**
   * [Fase 1] Tulis record intent dan tunggu sampai durable. Dipanggil
   * SEBELUM tool dieksekusi. No-op untuk tool yang tak dijurnal (read-only,
   * NO_AUTO_JOURNAL, atau sudah dicakup jalur canonical).
   */
  preflightIntent(call: { id: string; name: string; args: unknown }): Promise<void>
  /**
   * [Fase 1] Tunggu seluruh penulisan terminal yang masih berjalan selesai.
   * Dipanggil composition root sebelum turn dinyatakan selesai, sehingga
   * "selesai" tidak pernah mendahului bukti.
   */
  flushPending(): Promise<void>
}

export function attachMutationJournal(
  session: SessionLike,
  opts: {
    sessionId: string
    cwd?: string
    childOf?: string
    /**
     * Fase 4 V2.1: kabar terminal committed (paths+journalSeq) → composition
     * root memancarkan file.changed (receipt paths+journalSeq) ke adapter.
     * Opsional — tanpa hook, jurnal tetap berjalan seperti dulu.
     */
    onCommitted?: (info: {
      toolCallId: string
      paths: string[]
      journalSeq: number
      sessionId: string
      turnId?: number
    }) => void
    /**
     * P2.10 canonical mode: registry tools covered by an awaited wrapper
     * already wrote one intent/terminal pair. Event fallback stays only for
     * special paths and uncovered tools, so production has no double evidence.
     */
    evidenceMode?: "events" | "canonical"
  },
): MutationJournalHandle {
  const root = resolve(opts.cwd ?? process.cwd())
  // Eager creation (AUDIT #01E §1): file jurnal dibuat saat wiring dipasang
  // — SEBELUM mutasi pertama — agar ABSENT vs EMPTY dapat dibedakan saat
  // resume (absent = bukti hilang; empty = sesi ada, belum bermutasi).
  // Create-if-absent ("wx"): tak menimpa file existing, tak menulis record
  // palsu; balapan dengan append pertama aman dari dua arah (append memakai
  // "a" yang juga membuat bila belum ada).
  // Fire-and-forget disengaja: attach sinkron; kegagalan → degraded-loud,
  // BUKAN sesi gagal start.
  void (async () => {
    const path = journalPath(opts.sessionId, root)
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => {})
      const h = await open(path, "wx", 0o600)
      try {
        await h.sync().catch(() => {})
      } finally {
        await h.close().catch(() => {})
      }
    } catch (e) {
      // EEXIST = file sudah ada (normal). Sisanya = degraded (bukan empty!).
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
        markDegraded(opts.sessionId, root, `eager create gagal: ${(e as Error).message}`)
      }
    }
  })()
  // toolCallId → ANTRE intent (FIFO). Started ganda id sama (retry/duplikat)
  // tak boleh saling menimpa: completed mengambil pasangan TERTUA yang belum
  // berpasangan. Map-overwrite = terminal salah pasangan = pending hantu.
  const inflight = new Map<string, Promise<JournalRecord>[]>()
  // [Fase 1 / LOOP-INV-03] toolCallId yang intent-nya sudah ditulis oleh
  // PRE-FLIGHT (jalur awaited sebelum efek). Listener `execution:started`
  // melewatkannya supaya satu efek tidak menghasilkan dua record intent.
  const preflighted = new Set<string>()
  // [Fase 1 / LOOP-INV-03] Terminal yang masih menulis. `execution:completed`
  // adalah event SINKRON, sedangkan append terminal async; tanpa daftar ini
  // turn bisa dinyatakan selesai saat bukti terminal masih di jalan.
  const pendingTerminals = new Set<Promise<void>>()
  const turnOf = (): number | null => {
    try {
      const n = session.state?.turnCount
      return typeof n === "number" ? n : null
    } catch {
      return null
    }
  }
  /**
   * [Fase 1] Satu-satunya tempat membangun input intent, dipakai bersama oleh
   * listener event (fallback) dan pre-flight (jalur utama). Duplikasi di sini
   * akan membuat dua jalur menulis bentuk record yang berbeda.
   */
  const intentInputFor = (
    name: string,
    args: Record<string, unknown>,
    hashes: { preTargetHash?: string | null; postTargetHash?: string | null } = {},
  ) => {
    const base = base_of(name)
    return {
      session: opts.sessionId,
      ...(opts.childOf ? { childOf: opts.childOf } : {}),
      turn: turnOf(),
      tool: name,
      ...(base === "mcp_call" ? { remote: true as const } : {}),
      ...(base === "code_run" ? { backend: process.env.MINICODE_SANDBOX || "none" } : {}),
      cwd: root,
      paths: verifyPaths(base, args, root),
      argsHash: hashArgs(args),
      ...(hashes.preTargetHash !== undefined ? { preTargetHash: hashes.preTargetHash } : {}),
      ...(hashes.postTargetHash !== undefined ? { postTargetHash: hashes.postTargetHash } : {}),
    }
  }
  const shouldJournal = (name: string): boolean =>
    name !== "" &&
    !NO_AUTO_JOURNAL.has(name) &&
    isMutationTool(name) &&
    !(opts.evidenceMode === "canonical" && isCanonicalEvidenceCovered(name))
  session.events.on("execution:started", (e) => {
    const ev = e as unknown as ExecutionEvent
    // Forward dari child: ground truth ada di jurnal anak (bus asal).
    // Mencatatnya juga di sini = bukti ganda (satu efek, dua id/sesi).
    if (ev.forwardedChild != null) return
    const name = typeof ev.execution?.call?.name === "string" ? ev.execution.call.name : ""
    if (!shouldJournal(name)) return
    const callId =
      typeof ev.execution?.call?.id === "string" ? (ev.execution.call.id as string) : ""
    // [Fase 1 / LOOP-INV-03] Pre-flight sudah menulis intent untuk call ini
    // SEBELUM tool dieksekusi. Menulis lagi di sini = dua record untuk satu
    // efek, dan recovery akan melihat satu intent menggantung selamanya.
    if (callId !== "" && preflighted.has(callId)) return
    const args = (ev.execution?.call?.args ?? {}) as Record<string, unknown>
    // Daftarkan promise SEBELUM await: completed dijamin datang sesudah
    // started, dan kini pasti menunggu intent selesai dulu.
    const intentP = appendMutationIntent(intentInputFor(name, args))
    if (callId) {
      const q = inflight.get(callId) ?? []
      q.push(
        intentP.catch((err) => {
          process.stderr.write(`[warn] journal: intent failed: ${(err as Error).message}\n`)
          throw err
        }),
      )
      inflight.set(callId, q)
    }
    void intentP.catch((err) => {
      process.stderr.write(`[warn] journal: intent failed: ${(err as Error).message}\n`)
    })
  })
  session.events.on("execution:completed", (e) => {
    const task = (async () => {
      try {
        const ev = e as unknown as ExecutionEvent
        if (ev.forwardedChild != null) return
        const name = typeof ev.execution?.call?.name === "string" ? ev.execution.call.name : ""
        if (!shouldJournal(name)) return
        const callId =
          typeof ev.execution?.call?.id === "string" ? (ev.execution.call.id as string) : ""
        const q = callId ? (inflight.get(callId) ?? []) : []
        const found = q.length > 0 ? await q.shift()!.catch(() => undefined) : undefined
        if (callId && q.length === 0) inflight.delete(callId)
        // Tanpa pasangan intent (mis. intent gagal tulis / degraded): jangan
        // karang terminal yatim — biarkan absen (jalur advisory + warn).
        if (!found) return
        const result = ev.execution?.result
        const failed = result?.isError === true
        // [Fase 2 / LOOP-INV-07] Hasil ber-tag UNKNOWN bukan "failed" biasa:
        // efeknya mungkin sudah terjadi. Terminal ditandai `unknown` supaya
        // recovery tidak pernah memperlakukannya sebagai aman-diulang.
        const outcomeTag = failed ? parseToolOutcomeTag(String(result?.content ?? "")) : null
        const state = outcomeTag ? "unknown" : failed ? "failed" : "committed"
        let note: string | undefined
        if (base_of(name) === "mcp_call") {
          const a = (ev.execution?.call?.args ?? {}) as Record<string, unknown>
          const srv = typeof a.server === "string" ? a.server : ""
          const t =
            typeof a.tool === "string"
              ? a.tool
              : isMcpToolName(name)
                ? name.split(".").slice(1).join(".")
                : ""
          if (srv || t) note = `${srv ? `${srv}.` : ""}${t}`
        }
        const outcome: JournalOutcome | undefined = outcomeTag
          ? {
              ...(note ? { note } : {}),
              uncertainty: "ambiguous-effect",
              ...(outcomeTag.reason === "TIMEOUT" ? { timeout: true as const } : {}),
            }
          : note
            ? { note }
            : undefined
        await appendMutationTerminal(
          opts.sessionId,
          root,
          found.id,
          found.seq,
          found.tool,
          state,
          outcome,
        )
        // Fase 4: kabar committed ke composition root (file.changed/receipt).
        // Gagal hook tak boleh menggagalkan jurnal (degraded-loud).
        if (state === "committed" && opts.onCommitted && callId) {
          try {
            opts.onCommitted({
              toolCallId: callId,
              paths: found.paths ?? [],
              journalSeq: found.seq,
              sessionId: opts.sessionId,
              ...(found.turn != null ? { turnId: found.turn } : {}),
            })
          } catch {}
        }
      } catch (err) {
        process.stderr.write(`[warn] journal: terminal failed: ${(err as Error).message}\n`)
      }
    })()
    // [Fase 1] Daftarkan supaya composition root bisa MENUNGGU terminal selesai
    // sebelum turn dinyatakan selesai. Body di atas menangkap semua error, jadi
    // promise ini tidak pernah reject; `finally` hanya membersihkan daftar.
    pendingTerminals.add(task)
    void task.finally(() => pendingTerminals.delete(task)).catch(() => {})
  })

  /**
   * [Fase 1 / LOOP-INV-03, LOOP-INV-04] Handle untuk composition root.
   *
   * `preflightIntent` menulis record intent dan MENUNGGU-nya sampai durable.
   * Pemanggil (`src/app/session.ts` lewat `beforeToolEffect`, dipasang
   * `cli/setup.ts`) menjalankannya SEBELUM tool dieksekusi, sehingga
   * "durability-before-effect" menjadi urutan yang benar-benar di-await, bukan
   * harapan pada scheduling microtask.
   *
   * Idempoten per `toolCallId`: panggilan kedua (mis. retry hook) tidak
   * menulis record kedua, dan listener `execution:started` melewatkan id yang
   * sudah di-preflight.
   */
  return {
    async flushPending(): Promise<void> {
      // Tunggu sampai TIDAK ADA terminal tertunda. Loop karena penulisan baru
      // bisa lahir selama await (batch berurutan); sekali kosong, selesai.
      while (pendingTerminals.size > 0) {
        await Promise.allSettled([...pendingTerminals])
      }
    },
    async preflightIntent(call: { id: string; name: string; args: unknown }): Promise<void> {
      const name = typeof call.name === "string" ? call.name : ""
      if (!shouldJournal(name)) return
      const callId = typeof call.id === "string" ? call.id : ""
      if (callId === "" || preflighted.has(callId)) return
      // Tandai SEBELUM await: dua preflight paralel untuk id yang sama tidak
      // boleh sama-sama menulis.
      preflighted.add(callId)
      const args = (call.args ?? {}) as Record<string, unknown>
      // [Fase 2 / LOOP-G06] Hash pra-efek dihitung SEBELUM intent ditulis,
      // sehingga record intent sudah membawa bukti yang bisa direkonsiliasi
      // setelah crash. Kegagalan baca = field absen (UNKNOWN saat reconcile).
      const hashes = await targetHashesFor(name, args, root)
      const p = appendMutationIntent(intentInputFor(name, args, hashes))
      const q = inflight.get(callId) ?? []
      q.push(p)
      inflight.set(callId, q)
      try {
        await p
      } catch (err) {
        // Durabilitas gagal: jangan biarkan efek berjalan (pemanggil akan
        // menolak tool). Bersihkan state supaya tidak ada intent hantu yang
        // ditunggu terminal yang tak akan pernah datang.
        preflighted.delete(callId)
        const idx = q.indexOf(p)
        if (idx !== -1) q.splice(idx, 1)
        if (q.length === 0) inflight.delete(callId)
        throw err
      }
    },
  }
}

function base_of(name: string): string {
  return isMcpToolName(name) ? "mcp_call" : name
}

/**
 * Record mutasi dengan turn lebih baru dari turn bukti (P10.1.1, freshness
 * bukti completion). Murni baca: tanpa tulis/ubah/compact jurnal.
 *
 * Aturan (disetujui owner): relevan = klasifikasi `isMutationTool` (tulis,
 * bash, delegasi, memori, MCP, tak-dikenal-fail-closed); record turn null
 * (legacy) DIKECUALIKAN agar sesi lama tak terkunci permanen; state record
 * (pending/committed/failed) tak membedakan — upaya mutasi yang tercatat
 * sudah cukup untuk meragukan bukti lama. Gagal baca DILEMPAR ke pemanggil
 * (konteks gate: pemanggil wajib fail-closed); bedakan dari pembaca display
 * (committedDelegatesSince) yang gagal-lembut.
 */
export async function mutationsSinceTurn(
  sessionId: string,
  cwd: string | undefined,
  evidenceTurn: number,
): Promise<readonly JournalRecord[]> {
  const loaded = await loadJournal(sessionId, cwd)
  // Jurnal tak-terbaca/korup = buktinya sendiri tak bisa diaudit: tolak
  // diam-diam BUKAN pilihan — lempar agar pemanggil (gate) fail-closed.
  // `absent` (belum ada berkas) dan `empty` aman: nol record = nol mutasi.
  if (loaded.status !== "absent" && loaded.status !== "empty" && loaded.status !== "valid") {
    throw new Error(`journal unreadable for freshness check (status: ${loaded.status})`)
  }
  const { records } = loaded
  return records.filter(
    (r) =>
      typeof r.turn === "number" &&
      r.turn > evidenceTurn &&
      typeof r.tool === "string" &&
      isMutationTool(r.tool),
  )
}

// ── Resume: muat jurnal (+anak) → putuskan ──

export interface RecoveryInput {
  directive: string | null
  warnings: string[]
  clean: boolean
}

/**
 * Delegasi committed sejak timestamp: dipakai peringatan turn-gagal ("efek
 * anak tetap ada walau riwayat bersih"). Kembalikan childSessionId + seq + ts.
 * Murni baca; tak pernah melempar (gagal baca = [] + warn stderr).
 */
export interface CommittedDelegate {
  readonly childSessionId: string
  readonly seq: number
  readonly ts: number
  /**
   * Observasi amplop anak (P9.2.2.1, display-only): disalin dari terminal
   * record yang sama — BUKAN bacaan jurnal anak baru. Absen = record
   * legacy/rusak → pemanggil wajib fallback baris legacy.
   */
  readonly childStatus?: ChildStatus
  readonly resultSummary?: string
  readonly truncated?: boolean
}

/** Status amplop yang boleh tampil (di luar ini = rusak → absen). */
const DISPLAYABLE_CHILD_STATUS: ReadonlySet<string> = new Set([
  "returned",
  "timeout",
  "aborted",
  "max_steps_exceeded",
  "error",
  "failed_to_start",
])

/**
 * Predikat bersama untuk status tampil (dipakai pembaca committedDelegatesSince
 * DAN formatter cli/recovery-warning.ts — satu sumber kebenaran agar status
 * asing tak pernah menjadi teks status menyesatkan di lapisan mana pun).
 */
export function isDisplayableChildStatus(value: unknown): value is ChildStatus {
  return typeof value === "string" && DISPLAYABLE_CHILD_STATUS.has(value)
}

export async function committedDelegatesSince(
  sessionId: string,
  cwd: string | undefined,
  sinceTs: number,
): Promise<CommittedDelegate[]> {
  try {
    const { records } = await loadJournal(sessionId, cwd)
    // Tautan dari terminal, fallback ke intent se-id (jurnal lama).
    const intentChild = new Map<string, string>()
    for (const r of records) {
      if (r.tool === "delegate_task" && r.childSessionId && r.state === "pending") {
        intentChild.set(r.id, r.childSessionId)
      }
    }
    const out: CommittedDelegate[] = []
    for (const r of records) {
      if (r.tool !== "delegate_task" || r.state !== "committed") continue
      const cid = r.childSessionId ?? intentChild.get(r.id)
      if (!cid) continue
      if (typeof r.ts !== "number" || r.ts < sinceTs) continue
      // Amplop usang/rusak = absen (fallback baris legacy di pemanggil, tak
      // pernah gagal): childStatus harus dikenal (status asing tak boleh
      // jadi teks status menyesatkan) dan ringkasan harus string.
      const env = r.outcome?.childResult
      const envelope =
        env !== null &&
        typeof env === "object" &&
        isDisplayableChildStatus(env.childStatus) &&
        typeof env.resultSummary === "string"
          ? {
              childStatus: env.childStatus as ChildStatus,
              resultSummary: env.resultSummary,
              ...(env.truncated === true ? { truncated: true as const } : {}),
            }
          : {}
      out.push({ childSessionId: cid, seq: r.seq, ts: r.ts, ...envelope })
    }
    return out.sort((a, b) => a.seq - b.seq)
  } catch (e) {
    process.stderr.write(
      `[warn] journal: committedDelegatesSince failed: ${(e as Error).message}\n`,
    )
    return []
  }
}

/**
 * Rencana recovery untuk satu sesi: jurnal sendiri + jurnal anak yang dirujuk
 * record delegasi. Murni baca; keputusan via decideRecovery (tanpa I/O).
 */
export async function planRecoveryForSession(
  sessionId: string,
  cwd?: string,
  opts: { includeChildren?: boolean; maxItems?: number; persistedTurns?: number[] } = {},
): Promise<RecoveryInput & { stats: RecoveryPlan["stats"] }> {
  const warnings: string[] = []
  try {
    const root = resolve(cwd ?? process.cwd())
    const main = await loadJournal(sessionId, root)
    warnings.push(...main.warnings)
    let records = [...main.records]
    if (main.quarantined) {
      warnings.push("journal utama dikarantina — keputusan dari prefix valid + advisory")
    }
    if (opts.includeChildren !== false) {
      const childIds = [
        ...new Set(
          main.records
            .filter((r) => r.tool === "delegate_task" && r.childSessionId)
            .map((r) => r.childSessionId as string),
        ),
      ].slice(0, 10)
      // Status terminal delegasi parent per anak: hanya committed yang
      // menjadi bukti anak "seharusnya ada" (failed/pending = anak boleh
      // tak lahir → absen adalah normal, bukan anomali). Tautan diambil
      // dari terminal, fallback ke intent se-id (jurnal lama).
      const intentChild = new Map<string, string>()
      for (const r of main.records) {
        if (r.tool === "delegate_task" && r.childSessionId && r.state === "pending") {
          intentChild.set(r.id, r.childSessionId)
        }
      }
      const delegateDone = new Set<string>()
      for (const r of main.records) {
        if (r.tool !== "delegate_task" || r.state !== "committed") continue
        const cid = r.childSessionId ?? intentChild.get(r.id)
        if (cid) delegateDone.add(cid)
      }
      const degraded: string[] = []
      for (const cid of childIds) {
        const child = await loadJournal(cid, root).catch(
          (e): JournalLoad => ({
            records: [],
            warnings: [`jurnal anak ${cid} gagal dimuat: ${(e as Error).message}`],
            truncatedTail: false,
            quarantined: false,
            status: "unreadable",
          }),
        )
        warnings.push(...child.warnings.map((w) => `child ${cid}: ${w}`))
        switch (child.status) {
          case "absent":
            // Bukti parent committed + file tak ada = bukti HILANG (degraded).
            // Parent failed/pending = anak boleh tak lahir → sunyi (normal).
            if (delegateDone.has(cid)) {
              degraded.push(
                `jurnal anak ${cid} SEHARUSNYA ADA (delegasi committed) tetapi file tak ditemukan — bukti tak-lengkap, jangan asumsikan efek anak ada/tidak-ada`,
              )
            }
            break
          case "unreadable":
            // File ada tetapi tak terbaca = anomali dalam kondisi apa pun.
            degraded.push(
              `jurnal anak ${cid} TAK TERBACA — bukti tak-lengkap, jangan asumsikan efek anak ada/tidak-ada`,
            )
            break
          case "empty":
            // Anak terpasang tetapi nol mutasi = normal, bukan anomali.
            break
          default:
            records = records.concat(child.records)
            break
        }
        if (child.quarantined) {
          warnings.push(
            `child ${cid}: journal dikarantina — keputusan dari prefix valid + advisory`,
          )
        }
      }
      // Degraded evidence = bagian direktif (non-blocking, informatif) agar
      // model tak membangun di atas ketiadaan bukti + warnings user-visible.
      if (degraded.length > 0) {
        const extra = `[recovery] BUKTI TAK-LENGKAP (degraded, bukan blokir):\n${degraded.map((d) => `- ${d}`).join("\n")}`
        warnings.push(...degraded)
        const base = decideRecovery(records, opts.persistedTurns ?? [], { maxItems: opts.maxItems })
        warnings.push(...base.warnings)
        const directive = base.directive ? `${base.directive}\n${extra}` : extra
        if (!isJournalHealthy(sessionId, root)) {
          warnings.push("journal degraded (tulis gagal sebelumnya) — anggap catatan tak-lengkap")
        }
        return { directive, warnings, clean: false, stats: base.stats }
      }
    }
    // Turn durable dipasok pemanggil (persistence.listPersistedTurns) agar
    // modul ini tak bergantung modul persistence (anti cycle-import).
    const plan = decideRecovery(records, opts.persistedTurns ?? [], { maxItems: opts.maxItems })
    warnings.push(...plan.warnings)
    if (!isJournalHealthy(sessionId, root)) {
      warnings.push("journal degraded (tulis gagal sebelumnya) — anggap catatan tak-lengkap")
    }
    return { directive: plan.directive, warnings, clean: plan.clean, stats: plan.stats }
  } catch (e) {
    return {
      directive: null,
      warnings: [`recovery journal gagal dimuat: ${(e as Error).message} — lanjut jalur advisory`],
      clean: false,
      stats: { pending: 0, failed: 0, committed: 0, unknown: 0, finalized: 0, markers: 0 },
    }
  }
}
