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
import { mkdir, open, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { sanitizeSessionPart } from "../lib/session-id.ts"

export type JournalState = "pending" | "committed" | "failed"

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
  /** mutation (default) | undo | redo | finalize. Marker bukan intent. */
  kind?: "mutation" | "undo" | "redo" | "finalize"
  /** true = klaim sukses berasal dari pihak remote (MCP), bukan komit lokal. */
  remote?: true
  /** Backend code_run ("docker"|"os"|...) — alat interpretasi, bukan kontrol. */
  backend?: string
  /** Workspace root saat record ditulis (deteksi resume-beda-cwd). */
  cwd: string
  /** Path relatif-workspace untuk verification (allowlist per kelas-tool). */
  paths?: string[]
  /** SHA-256 JSON kanonisal argumen — identitas, BUKAN replay (tanpa raw args). */
  argsHash?: string
  /** Tautan delegasi: id sesi anak (parent-side record). */
  childSessionId?: string
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
  outcome?: { code?: number | null; note?: string }
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
// Nama bertitik (server.tool runtime MCP) = kelas mcp_call.
const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "apply_patch",
  "move_file",
  "delete_file",
  "bash",
  "git_commit",
  "mcp_call",
  "code_run",
  "delegate_task",
  "write_memory",
  "forget_memory",
])

const NON_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "glob",
  "grep",
  "read_image",
  "bash_output",
  "bash_kill",
  "git_status",
  "git_diff",
  "git_log",
  "lsp_diagnostics",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_symbols",
  "lsp_workspace_symbols",
  "mcp_list",
  "mcp_read",
  "mcp_prompt",
  "read_memory",
  "todo_write",
  "todo_read",
  "submit_result",
  "ask_user",
  "web_fetch",
  "web_search",
])

export function classifyTool(name: string): "mutation" | "none" | "unknown" {
  // Tool runtime MCP (server.tool) mewarisi kelas mcp_call: efek arbitrer.
  const base = name.includes(".") ? "mcp_call" : name
  if (MUTATION_TOOLS.has(base)) return "mutation"
  if (NON_MUTATION_TOOLS.has(base)) return "none"
  return "unknown"
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
  remote?: true
  backend?: string
  cwd?: string
  paths?: string[]
  argsHash?: string
  childSessionId?: string
  /**
   * Kunci idempotency (audit #08): ditulis ke outcome.note SEJAK intent agar
   * crash di tengah eksekusi tetap meninggalkan bukti yang dapat dicocokkan
   * (sebelumnya note hanya ada di terminal → bukti pending tak terlihat →
   * retry id-sama pasca-crash dieksekusi ulang buta).
   */
  note?: string
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
    const rec: JournalRecord = {
      v: 1,
      id: `${input.session}:${seq}`,
      session: input.session,
      ...(input.childOf ? { childOf: input.childOf } : {}),
      turn: input.turn ?? null,
      seq,
      tool: input.tool,
      ...(input.remote ? { remote: true as const } : {}),
      ...(input.backend ? { backend: input.backend } : {}),
      cwd: root,
      ...(input.paths?.length ? { paths: input.paths } : {}),
      ...(input.argsHash ? { argsHash: input.argsHash } : {}),
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
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
  state: "committed" | "failed",
  outcome?: { code?: number | null; note?: string },
  childSessionId?: string,
  opts: { dedup?: boolean } = {},
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
      ...(outcome ? { outcome } : {}),
      // Tautan delegasi diwariskan ke terminal agar pembaca tak perlu
      // join intent-terminal untuk mengetahui anak mana yang dirujuk.
      ...(childSessionId ? { childSessionId } : {}),
      // Bukti dedup idempotency (mis. MCP request id): dipertahankan sweep.
      ...(opts.dedup ? { dedup: true as const } : {}),
      ts: Date.now(),
    }
    const st = writers.get(key)
    if (!(await appendLine(path, rec)) && st) markDegraded(session, root, "terminal append gagal")
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
    if ((!r.kind || r.kind === "mutation") && (r.state === "committed" || r.state === "failed")) {
      paired.add(r.id)
    }
  }
  const committedKeys = committedPathsKeys(loaded.records)
  const keep = loaded.records.filter((r) => {
    if (r.kind === "finalize") return r.seq === maxFinalizeSeq(loaded.records)
    if (r.kind === "undo" || r.kind === "redo") return r.seq > maxUpto
    if (r.state === "pending" && paired.has(r.id)) return false
    if (r.state === "pending") return !isSuperseded(r, committedKeys)
    // Bukti dedup idempotency (dedup: true, mis. MCP request id) BUKAN sampah
    // finalize: menghapusnya membuat retry id-sama pasca-restart dieksekusi
    // ulang buta (audit #08 P0 — reproducer: note hilang setelah sweep).
    // Intent pasangannya tetap dibuang (aturan paired di atas); terminal ini
    // yang menjadi bukti. Batas pertumbuhan: file per sesi + purge yatim TTL.
    if (
      (!r.kind || r.kind === "mutation") &&
      (r.state === "committed" || r.state === "failed") &&
      r.dedup === true
    )
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
  if (mine.some((r) => r.state === "committed" || r.state === "failed")) return false
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
  if (typeof o.tool !== "string" || !o.tool) return false
  return o.state === "pending" || o.state === "committed" || o.state === "failed"
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
  state: "pending" | "committed" | "failed"
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
  stats: { pending: number; failed: number; committed: number; finalized: number; markers: number }
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
    const term = list.find((r) => r.state === "committed" || r.state === "failed")
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
  const stats = { pending: 0, failed: 0, committed: 0, finalized: 0, markers: undoRedoCount }
  const attention: AttentionItem[] = []
  const stitched: { id: string; tool: string; turn?: number | null }[] = []
  const remoteVerify: AttentionItem[] = []
  const supersedeKeys = committedPathsKeys(records)
  for (const [, list] of [...byId.entries()].sort((a, b) => a[1][0]!.seq - b[1][0]!.seq)) {
    const first = list[0]!
    if (list.length > 1) {
      const terminals = list.filter((r) => r.state === "committed" || r.state === "failed")
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
    const eff = list.find((r) => r.state === "committed" || r.state === "failed") ?? first
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
      "MUTASI TAK-PASTI (pending/failed) — verifikasi SEBELUM mengulang; DILARANG redo buta:",
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

function toItem(first: JournalRecord, state: "pending" | "committed" | "failed"): AttentionItem {
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
    result?: { isError?: unknown }
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
export function attachMutationJournal(
  session: SessionLike,
  opts: { sessionId: string; cwd?: string; childOf?: string },
): void {
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
  const turnOf = (): number | null => {
    try {
      const n = session.state?.turnCount
      return typeof n === "number" ? n : null
    } catch {
      return null
    }
  }
  session.events.on("execution:started", (e) => {
    const ev = e as unknown as ExecutionEvent
    // Forward dari child: ground truth ada di jurnal anak (bus asal).
    // Mencatatnya juga di sini = bukti ganda (satu efek, dua id/sesi).
    if (ev.forwardedChild != null) return
    const name = typeof ev.execution?.call?.name === "string" ? ev.execution.call.name : ""
    if (!name || NO_AUTO_JOURNAL.has(name) || !isMutationTool(name)) return
    const callId =
      typeof ev.execution?.call?.id === "string" ? (ev.execution.call.id as string) : ""
    const base = name.includes(".") ? "mcp_call" : name
    const args = (ev.execution?.call?.args ?? {}) as Record<string, unknown>
    // Daftarkan promise SEBELUM await: completed dijamin datang sesudah
    // started, dan kini pasti menunggu intent selesai dulu.
    const intentP = appendMutationIntent({
      session: opts.sessionId,
      ...(opts.childOf ? { childOf: opts.childOf } : {}),
      turn: turnOf(),
      tool: name,
      ...(base === "mcp_call" ? { remote: true as const } : {}),
      ...(base === "code_run" ? { backend: process.env.MINICODE_SANDBOX || "none" } : {}),
      cwd: root,
      paths: verifyPaths(base, args, root),
      argsHash: hashArgs(args),
    })
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
    void (async () => {
      try {
        const ev = e as unknown as ExecutionEvent
        if (ev.forwardedChild != null) return
        const name = typeof ev.execution?.call?.name === "string" ? ev.execution.call.name : ""
        if (!name || NO_AUTO_JOURNAL.has(name) || !isMutationTool(name)) return
        const callId =
          typeof ev.execution?.call?.id === "string" ? (ev.execution.call.id as string) : ""
        const q = callId ? (inflight.get(callId) ?? []) : []
        const found = q.length > 0 ? await q.shift()!.catch(() => undefined) : undefined
        if (callId && q.length === 0) inflight.delete(callId)
        // Tanpa pasangan intent (mis. intent gagal tulis / degraded): jangan
        // karang terminal yatim — biarkan absen (jalur advisory + warn).
        if (!found) return
        const failed = ev.execution?.result?.isError === true
        let note: string | undefined
        if (base_of(name) === "mcp_call") {
          const a = (ev.execution?.call?.args ?? {}) as Record<string, unknown>
          const srv = typeof a.server === "string" ? a.server : ""
          const t =
            typeof a.tool === "string"
              ? a.tool
              : name.includes(".")
                ? name.split(".").slice(1).join(".")
                : ""
          if (srv || t) note = `${srv ? `${srv}.` : ""}${t}`
        }
        await appendMutationTerminal(
          opts.sessionId,
          root,
          found.id,
          found.seq,
          found.tool,
          failed ? "failed" : "committed",
          note ? { note } : undefined,
        )
      } catch (err) {
        process.stderr.write(`[warn] journal: terminal failed: ${(err as Error).message}\n`)
      }
    })()
  })
}

function base_of(name: string): string {
  return name.includes(".") ? "mcp_call" : name
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
export async function committedDelegatesSince(
  sessionId: string,
  cwd: string | undefined,
  sinceTs: number,
): Promise<{ childSessionId: string; seq: number; ts: number }[]> {
  try {
    const { records } = await loadJournal(sessionId, cwd)
    // Tautan dari terminal, fallback ke intent se-id (jurnal lama).
    const intentChild = new Map<string, string>()
    for (const r of records) {
      if (r.tool === "delegate_task" && r.childSessionId && r.state === "pending") {
        intentChild.set(r.id, r.childSessionId)
      }
    }
    const out: { childSessionId: string; seq: number; ts: number }[] = []
    for (const r of records) {
      if (r.tool !== "delegate_task" || r.state !== "committed") continue
      const cid = r.childSessionId ?? intentChild.get(r.id)
      if (!cid) continue
      if (typeof r.ts !== "number" || r.ts < sinceTs) continue
      out.push({ childSessionId: cid, seq: r.seq, ts: r.ts })
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
      stats: { pending: 0, failed: 0, committed: 0, finalized: 0, markers: 0 },
    }
  }
}
