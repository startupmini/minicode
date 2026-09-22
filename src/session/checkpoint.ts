import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { GIT_SAFE_BASE } from "../lib/git-hardening.ts"
import { sanitizeSessionPart } from "../lib/session-id.ts"
import { isPathOutsideRoot } from "../policy/jail.ts"
import { appendUndoMarker, loadJournal } from "./journal.ts"
import { diffTrees, ephemeralTree, restoreTree, snapshotTree } from "./shadow-git.ts"

/** Alias back-compat: satu-satunya sanitizer kini di lib/session-id.ts (F-17). */
export function sanitizeSessionId(id: string): string {
  return sanitizeSessionPart(id)
}

// In-process lock per manifest path untuk mencegah lost-update checkpoint
// saat turn paralel (mis. Pool(3) sub-agent).
const checkpointLocks = new Map<string, Promise<void>>()

async function withCheckpointLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = checkpointLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((res) => (release = res))
  checkpointLocks.set(
    path,
    prev.then(() => next),
  )
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (checkpointLocks.get(path) === next) checkpointLocks.delete(path)
  }
}

const MAX_CHECKPOINTS = 20

export interface FileSnapshot {
  path: string // relative path
  content: string | null // null means file was deleted/didn't exist
}

export interface Checkpoint {
  id: string
  turn: number
  timestamp: string
  description: string
  snapshots: FileSnapshot[] // pre-edit state (untuk /undo)
  redoSnapshots?: FileSnapshot[] // post-edit state (untuk /redo)
  /** Tree git pre-turn (mode shadow-git). Bila ada, snapshots dibiarkan kosong. */
  treeBefore?: string
  /** Tree git post-turn (mode shadow-git) untuk /redo. */
  treeAfter?: string
}

export interface CheckpointManifest {
  sessionId: string
  currentIndex: number // pointer in history
  checkpoints: Checkpoint[]
}

function getCheckpointDir(sessionId: string, cwd: string = process.cwd()): string {
  return resolve(cwd, ".minicode", "checkpoints", sanitizeSessionId(sessionId))
}

function getManifestPath(sessionId: string, cwd: string = process.cwd()): string {
  return join(getCheckpointDir(sessionId, cwd), "manifest.json")
}

export async function loadCheckpointManifest(
  sessionId: string,
  cwd?: string,
): Promise<CheckpointManifest> {
  const path = getManifestPath(sessionId, cwd)
  try {
    const raw = await readFile(path, "utf8")
    try {
      return JSON.parse(raw) as CheckpointManifest
    } catch (e) {
      if (e instanceof SyntaxError) {
        const backup = `${path}.corrupt.${Date.now()}`
        await atomicWriteText(backup, raw).catch(() => {})
        process.stderr.write(
          `[warn] checkpoint: manifest corrupt — backup to ${backup}: ${(e as Error).message} — starting empty\n`,
        )
      }
      throw e
    }
  } catch (e) {
    // manifest hilang = kondisi normal utk sesi baru; manifest KORUP sudah di-backup di atas
    // lalu akan jatuh ke sini sebagai SyntaxError — tetap return empty tapi sudah backup
    const code = (e as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && !(e instanceof SyntaxError)) {
      process.stderr.write(
        `[warn] checkpoint: manifest unreadable (${(e as Error).message}) — starting empty\n`,
      )
    }
    if (e instanceof SyntaxError) {
      // already backed up, return empty
    }
    return { sessionId: sanitizeSessionId(sessionId), currentIndex: -1, checkpoints: [] }
  }
}

export async function saveCheckpointManifest(
  manifest: CheckpointManifest,
  cwd?: string,
): Promise<void> {
  const dir = getCheckpointDir(manifest.sessionId, cwd)
  await mkdir(dir, { recursive: true }).catch(() => {})
  const path = getManifestPath(manifest.sessionId, cwd)
  await atomicWriteText(path, JSON.stringify(manifest, null, 2))
}

// P3 — validasi resume: workspace berubah sejak checkpoint terakhir?
// Bukan replay buta: mode git bandingkan treeAfter terakhir vs tree sekarang
// (tanpa pin ref baru); mode files bandingkan snapshot post (redo) vs isi
// sekarang. Best-effort: null bila tak bisa dipastikan — resume tetap jalan.
export async function validateResumeWorkspace(
  cwd: string,
  sessionId: string,
): Promise<{ mode: "git" | "files" | "none"; diverged: number } | null> {
  try {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    if (manifest.checkpoints.length === 0) return { mode: "none", diverged: 0 }
    const last =
      manifest.checkpoints[manifest.currentIndex] ??
      manifest.checkpoints[manifest.checkpoints.length - 1]!
    if (last.treeAfter) {
      const now = await ephemeralTree(cwd)
      if (!now) return null
      if (now === last.treeAfter) return { mode: "git", diverged: 0 }
      const changes = await diffTrees(cwd, last.treeAfter, now)
      // Pembukuan harness sendiri (.minicode/: manifest, trace, todos berubah
      // tiap run) bukan divergensi user — keluarkan agar resume di repo tanpa
      // gitignore .minicode tidak selalu kuning.
      const userChanges = changes.filter(
        (ch) => ch.path !== ".minicode" && !ch.path.startsWith(".minicode/"),
      )
      return { mode: "git", diverged: userChanges.length }
    }
    const refs = last.redoSnapshots?.length ? last.redoSnapshots : last.snapshots
    if (refs.length === 0) return { mode: "none", diverged: 0 }
    let diverged = 0
    for (const s of refs.slice(0, LIMITS.WORKSPACE_SNAPSHOT_LIMIT)) {
      // Jail: manifest bisa usang/rusak — jangan baca di luar workspace.
      if (isPathOutsideRoot(s.path, cwd)) {
        diverged++
        continue
      }
      let cur: string | null
      try {
        cur = await readFile(resolve(cwd, s.path), "utf8")
      } catch {
        cur = null
      }
      if (cur !== s.content) diverged++
    }
    return { mode: "files", diverged }
  } catch {
    return null
  }
}

export async function captureFileSnapshot(
  filePath: string,
  cwd: string = process.cwd(),
): Promise<FileSnapshot> {
  const rel = relative(cwd, filePath).replace(/\\/g, "/")
  const abs = resolve(cwd, filePath)
  try {
    const content = await readFile(abs, "utf8")
    return { path: rel, content }
  } catch {
    return { path: rel, content: null }
  }
}

// Snapshot seluruh workspace (maks `limit` file) — menangkap perubahan apa pun
// termasuk bash/git (bukan cuma edit/write_file). Dipakai /undo per turn.
async function walkFiles(root: string, rel: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return
  const dir = rel ? join(root, rel) : root
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (out.length >= limit) break
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === ".git") continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) await walkFiles(root, r, out, limit)
    else out.push(r)
  }
}

export async function snapshotWorkspace(
  cwd: string = process.cwd(),
  limit = 200,
): Promise<FileSnapshot[]> {
  // Try git dirty files first for efficiency on large workspaces.
  // Audit #10: status menjalankan fsmonitor repo tanpa netralisasi; git
  // di-resolve absolut agar `git.bat` repo tak dieksekusi dari cwd (Windows).
  try {
    const { spawnSync } = await import("node:child_process")
    const { resolveTrustedExecutable } = await import("../lib/trusted-exec.ts")
    const r = spawnSync(
      resolveTrustedExecutable("git"),
      [...GIT_SAFE_BASE, "status", "--porcelain"],
      {
        cwd,
        timeout: 2000,
        encoding: "utf8",
      },
    )
    if (r.status === 0 && r.stdout) {
      const dirty = r.stdout
        .split("\n")
        .map((l: string) => l.slice(3).trim())
        .filter(Boolean)
        .slice(0, limit)
      if (dirty.length > 0) {
        const snaps: FileSnapshot[] = []
        for (const f of dirty) snaps.push(await captureFileSnapshot(resolve(cwd, f), cwd))
        return snaps
      }
    }
  } catch {}
  const files: string[] = []
  await walkFiles(cwd, "", files, limit)
  const snaps: FileSnapshot[] = []
  for (const f of files) {
    snaps.push(await captureFileSnapshot(resolve(cwd, f), cwd))
  }
  return snaps
}

// ── Shadow-git: jalur utama bila cwd adalah repo git ──
//
// Menyimpan SHA tree alih-alih isi file. Biayanya O(delta) bukan
// O(ukuran workspace), tanpa cap jumlah file, dan tidak menyentuh index/HEAD
// user. Fallback ke snapshot manual di bawah tetap ada untuk non-repo.

/**
 * Ambil snapshot pre-turn. Return penanda mode yang dipakai supaya pemanggil
 * tahu apakah perlu mengumpulkan snapshot file manual.
 */
export async function beginTurnSnapshot(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<{ mode: "git"; tree: string } | { mode: "files"; snapshots: FileSnapshot[] }> {
  const shadow = await snapshotTree(cwd, sessionId, "pre")
  if (shadow) return { mode: "git", tree: shadow.tree }
  return { mode: "files", snapshots: await snapshotWorkspace(cwd, LIMITS.WORKSPACE_SNAPSHOT_LIMIT) }
}

/** Rekam checkpoint dari tree git pre/post turn. */
export async function recordCheckpointFromTrees(
  sessionId: string,
  turn: number,
  treeBefore: string,
  treeAfter: string | undefined,
  description: string,
  cwd: string = process.cwd(),
): Promise<Checkpoint | null> {
  // Tak ada perubahan → tak ada yang perlu di-undo. Ini juga mencegah manifest
  // dipenuhi checkpoint kosong dari turn yang hanya membaca.
  if (treeAfter && treeAfter === treeBefore) return null
  const manifestPath = getManifestPath(sessionId, cwd)
  return withCheckpointLock(manifestPath, async () => {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    const cp: Checkpoint = {
      id: `cp_${Date.now()}_${randomUUID().slice(0, 6)}`,
      turn,
      timestamp: new Date().toISOString(),
      description,
      snapshots: [],
      treeBefore,
      ...(treeAfter ? { treeAfter } : {}),
    }
    if (manifest.currentIndex < manifest.checkpoints.length - 1) {
      manifest.checkpoints = manifest.checkpoints.slice(0, manifest.currentIndex + 1)
    }
    manifest.checkpoints.push(cp)
    if (manifest.checkpoints.length > MAX_CHECKPOINTS) {
      manifest.checkpoints = manifest.checkpoints.slice(-MAX_CHECKPOINTS)
    }
    manifest.currentIndex = manifest.checkpoints.length - 1
    await saveCheckpointManifest(manifest, cwd)
    return cp
  })
}

export async function recordCheckpoint(
  sessionId: string,
  turn: number,
  filePaths: string[],
  description: string = "",
  cwd: string = process.cwd(),
): Promise<Checkpoint> {
  const snapshots: FileSnapshot[] = []
  for (const fp of filePaths) {
    snapshots.push(await captureFileSnapshot(fp, cwd))
  }
  const cp = await recordCheckpointFromSnapshots(sessionId, turn, snapshots, description, cwd)
  if (!cp) throw new Error("no files to checkpoint")
  return cp
}

// Rekam checkpoint dari snapshot yang SUDAH ditangkap. `snapshots` = pre-edit
// (untuk /undo); `redoSnapshots` opsional = post-edit (untuk /redo).
export async function recordCheckpointFromSnapshots(
  sessionId: string,
  turn: number,
  snapshots: FileSnapshot[],
  description: string = "",
  cwd: string = process.cwd(),
  redoSnapshots?: FileSnapshot[],
): Promise<Checkpoint | null> {
  if (snapshots.length === 0) return null
  const manifestPath = getManifestPath(sessionId, cwd)
  return withCheckpointLock(manifestPath, async () => {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    const cp: Checkpoint = {
      id: `cp_${Date.now()}_${randomUUID().slice(0, 6)}`,
      turn,
      timestamp: new Date().toISOString(),
      description,
      snapshots,
      ...(redoSnapshots?.length ? { redoSnapshots } : {}),
    }

    // Truncate any redo branches if new action is taken
    if (manifest.currentIndex < manifest.checkpoints.length - 1) {
      manifest.checkpoints = manifest.checkpoints.slice(0, manifest.currentIndex + 1)
    }

    manifest.checkpoints.push(cp)
    // Cap manifest agar tidak membengkak tanpa batas (keep N terakhir)
    if (manifest.checkpoints.length > MAX_CHECKPOINTS) {
      manifest.checkpoints = manifest.checkpoints.slice(-MAX_CHECKPOINTS)
    }
    manifest.currentIndex = manifest.checkpoints.length - 1

    await saveCheckpointManifest(manifest, cwd)
    return cp
  })
}

// Terapkan snapshot dengan jail path: path di luar workspace dilewati.
async function applySnapshots(snapshots: FileSnapshot[], cwd: string): Promise<string[]> {
  const root = resolve(cwd)
  const applied: string[] = []
  for (const snap of snapshots) {
    const absPath = resolve(root, snap.path)
    if (isPathOutsideRoot(absPath, root)) {
      applied.push(`${snap.path} (skipped: outside workspace)`)
      continue
    }
    if (snap.content === null) {
      if (existsSync(absPath)) {
        await rm(absPath, { force: true }).catch(() => {})
        applied.push(`${snap.path} (removed)`)
      }
    } else {
      await atomicWriteText(absPath, snap.content)
      applied.push(`${snap.path} (restored)`)
    }
  }
  return applied
}

/** Terapkan satu checkpoint: tree git bila ada, else snapshot file. */
async function applyCheckpoint(
  cp: Checkpoint,
  direction: "undo" | "redo",
  cwd: string,
): Promise<string[]> {
  const tree = direction === "undo" ? cp.treeBefore : (cp.treeAfter ?? cp.treeBefore)
  if (tree) {
    const res = await restoreTree(cwd, tree)
    return [...res.applied, ...res.skipped.map((s) => `${s} (skipped)`)]
  }
  const snaps = direction === "undo" ? cp.snapshots : (cp.redoSnapshots ?? cp.snapshots)
  return applySnapshots(snaps, cwd)
}

export async function undoLastCheckpoint(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<{ success: boolean; restoredFiles: string[]; message: string }> {
  const manifestPath = getManifestPath(sessionId, cwd)
  return withCheckpointLock(manifestPath, async () => {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    if (manifest.currentIndex < 0 || manifest.checkpoints.length === 0) {
      return { success: false, restoredFiles: [], message: "no checkpoints to undo" }
    }

    const targetCp = manifest.checkpoints[manifest.currentIndex]!
    const restoredFiles = await applyCheckpoint(targetCp, "undo", cwd)

    // Urutan: marker DULU (bukti durable niat+hasil apply), pointer-disk
    // TERAKHIR. Crash apply→save: marker + pointer basi → rekonsiliasi
    // mengadopsi pointer (P0-3). Marker gagal ≠ save batal (lanjut save).
    const newIndex = manifest.currentIndex - 1
    await appendUndoMarker(sessionId, cwd, "undo", targetCp.turn, {
      newIndex,
      files: restoredFiles.length,
    }).catch((e) => {
      process.stderr.write(`[warn] journal: undo marker failed: ${(e as Error).message}\n`)
    })
    manifest.currentIndex = newIndex
    await saveCheckpointManifest(manifest, cwd)

    return {
      success: true,
      restoredFiles,
      message: `undid checkpoint ${targetCp.id} (turn ${targetCp.turn})`,
    }
  })
}

export async function redoLastCheckpoint(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<{ success: boolean; reappliedFiles: string[]; message: string }> {
  const manifestPath = getManifestPath(sessionId, cwd)
  return withCheckpointLock(manifestPath, async () => {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    if (manifest.currentIndex >= manifest.checkpoints.length - 1) {
      return { success: false, reappliedFiles: [], message: "no undone checkpoints to redo" }
    }

    // Protokol UNIFORM dengan undo (P0-3): hitung target DULU tanpa mutasi
    // pointer, apply files, tulis marker, BARU persist pointer. Versi lama
    // increment pointer di memori sebelum apply — hilang saat crash dan
    // mengaburkan jendela crash (pointer-memory vs pointer-disk berbeda).
    const targetIndex = manifest.currentIndex + 1
    const targetCp = manifest.checkpoints[targetIndex]!
    const reappliedFiles = await applyCheckpoint(targetCp, "redo", cwd)

    await appendUndoMarker(sessionId, cwd, "redo", targetCp.turn, {
      newIndex: targetIndex,
      files: reappliedFiles.length,
    }).catch((e) => {
      process.stderr.write(`[warn] journal: redo marker failed: ${(e as Error).message}\n`)
    })
    manifest.currentIndex = targetIndex
    await saveCheckpointManifest(manifest, cwd)

    return {
      success: true,
      reappliedFiles,
      message: `redid checkpoint ${targetCp.id} (turn ${targetCp.turn})`,
    }
  })
}

/**
 * Rekonsiliasi pointer undo/redo pasca-crash (P0-3).
 *
 * Protokol apply → marker → save menyisakan satu jendela: marker durable,
 * pointer-disk basi. Crash di sana membuat resume melihat pointer yang
 * menunjuk TERLALU TUA sementara file sudah di-apply. Fungsi ini menutupnya
 * secara deterministik: marker undo/redo TERBARU yang valid (indeks dalam
 * batas + turn cocok dengan checkpoint pada indeks itu) diadopsi sebagai
 * pointer — metadata-only, tanpa menyentuh file (file sudah benar).
 *
 * Tanpa marker / marker cocok pointer / marker invalid → null (no-op).
 * Idempoten: pemanggilan ulang menghasilkan null setelah adopsi pertama.
 */
export async function reconcileUndoRedoPointer(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<{
  repaired: boolean
  from: number
  to: number
  kind: "undo" | "redo"
  files: number
} | null> {
  const manifestPath = getManifestPath(sessionId, cwd)
  return withCheckpointLock(manifestPath, async () => {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    if (manifest.checkpoints.length === 0) return null
    let markers: {
      kind: "undo" | "redo"
      targetTurn?: number
      newIndex?: number
      files?: number
      seq: number
    }[]
    try {
      const loaded = await loadJournal(sessionId, cwd)
      markers = loaded.records
        .filter((r) => (r.kind === "undo" || r.kind === "redo") && typeof r.seq === "number")
        .map((r) => ({
          kind: r.kind as "undo" | "redo",
          targetTurn: r.targetTurn,
          newIndex: r.newIndex,
          files: r.files,
          seq: r.seq as number,
        }))
    } catch {
      return null
    }
    if (markers.length === 0) return null
    const latest = markers.sort((a, b) => a.seq - b.seq)[markers.length - 1]!
    if (latest.newIndex === undefined) return null // marker lama tanpa pointer
    if (latest.newIndex === manifest.currentIndex) return null // konvergen
    if (latest.newIndex < -1 || latest.newIndex > manifest.checkpoints.length - 1) {
      process.stderr.write(
        `[warn] checkpoint: undo/redo marker menunjuk indeks invalid (${latest.newIndex}) — diabaikan, pointer dipertahankan\n`,
      )
      return null
    }
    // Turn harus cocok: marker untuk susunan checkpoints yang berbeda
    // (eviksi/cabang lain) tak boleh diadopsi buta.
    // Pada undo: targetCp yang dibatalkan berada di indeks newIndex + 1 (newIndex -1 → checkpoint 0).
    // Pada redo: targetCp yang diaplikasikan kembali berada tepat di latest.newIndex.
    const targetIdx = latest.kind === "undo" ? latest.newIndex + 1 : latest.newIndex
    const pointed = manifest.checkpoints[targetIdx]
    if (!pointed || (latest.targetTurn !== undefined && pointed.turn !== latest.targetTurn)) {
      const actualTurn = pointed ? ` (turn ${pointed.turn})` : " (absen)"
      process.stderr.write(
        `[warn] checkpoint: ${latest.kind} marker turn ${latest.targetTurn} tak cocok checkpoint idx ${targetIdx}${actualTurn} — diabaikan\n`,
      )
      return null
    }
    const from = manifest.currentIndex
    manifest.currentIndex = latest.newIndex
    await saveCheckpointManifest(manifest, cwd)
    process.stderr.write(
      `[recovery] checkpoint pointer dipulihkan ${from} → ${latest.newIndex} (${latest.kind} turn ${latest.targetTurn ?? "?"}, ${latest.files ?? 0} file)\n`,
    )
    return {
      repaired: true,
      from,
      to: latest.newIndex,
      kind: latest.kind,
      files: latest.files ?? 0,
    }
  })
}
