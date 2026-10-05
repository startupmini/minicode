// AUDIT #01 — Session/State Consistency: pembuktian perilaku aktual.
// Bukan snapshot: setiap test membuktikan satu klaim laporan audit dari
// execution path (bukan happy path). Hermetic: tmp cwd + .minicode lokal.

import { expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSession } from "#minicore/core/index.ts"
import { allowAll, FakeProvider, finish, toolCall } from "#minicore/test/fakes.ts"
import {
  loadCheckpointManifest,
  recordCheckpointFromSnapshots,
  undoLastCheckpoint,
  validateResumeWorkspace,
} from "../src/session/checkpoint.ts"
import {
  branchSession,
  DEFAULT_THREAD_ID,
  listPersistedTurns,
  loadSession,
  RefusedHistoryRewriteError,
  saveSession,
  shrinkThreadHistory,
} from "../src/session/persistence.ts"

function memCwd(): string {
  // resolveDbPath memakai <cwd>/.minicode bila dir-nya ada → DB hermetic.
  const dir = mkdtempSync(join(tmpdir(), "mc-sessaudit-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

const MSGS = [
  { role: "user", content: "satu" },
  { role: "assistant", content: "dua" },
  { role: "user", content: "tiga" },
]

// ── 1. Abort mid-tool: late result dibuang, history bersih ──

test("audit: abort saat tool berjalan → history tetap kosong (turn dibuang)", async () => {
  const slow = {
    name: "lambat",
    description: "t",
    parameters: { type: "object", properties: {} },
    // Sengaja TAK kooperatif: selesai 150ms setelah abort (late result).
    async execute() {
      await new Promise((r) => setTimeout(r, 150))
      return "terlambat"
    },
  }
  const p = new FakeProvider([{ events: [toolCall("lambat", {}), finish("tool_calls")] }])
  const s = createSession({ provider: p, permissions: allowAll, tools: [slow as never] })
  const c = new AbortController()
  const run = s.run("mulai", { signal: c.signal })
  setTimeout(() => c.abort(), 20)
  await expect(run).rejects.toMatchObject({ kind: "aborted" })
  // Tunggu jauh melewati selesainya tool: hasil telat tak boleh mendarat.
  await new Promise((r) => setTimeout(r, 300))
  expect(s.state.history.length).toBe(0)
})

// ── 2. Compaction shrink → tulis ulang penuh, tanpa pesan basi ──

test("audit: history menyusut → rewrite penuh tanpa sisa pesan lama", async () => {
  const dir = memCwd()
  try {
    await saveSession("s1", dir, undefined, MSGS, undefined)
    expect(loadSession("s1", dir)?.messages.length).toBe(3)
    // P2.7: saveSession append-only (menolak shrink); jalur eksplisit =
    // shrinkThreadHistory. Invariant audit tetap sama: tak ada pesan lama.
    await expect(saveSession("s1", dir, undefined, MSGS.slice(0, 1), undefined)).rejects.toThrow(
      RefusedHistoryRewriteError,
    )
    shrinkThreadHistory("s1", DEFAULT_THREAD_ID, MSGS.slice(0, 1), dir, { expectedEpoch: 0 })
    const loaded = loadSession("s1", dir)
    expect(loaded?.messages.length).toBe(1)
    expect((loaded!.messages[0] as { content: string }).content).toBe("satu")
  } finally {
    await cleanup(dir)
  }
})

// ── 3. Manifes korup → fail-open kosong + backup ──

test("audit: manifes korup dibackup lalu dianggap kosong (fail-open)", async () => {
  const dir = memCwd()
  const sid = "korup-1"
  const mdir = join(dir, ".minicode", "checkpoints", sid)
  try {
    mkdirSync(mdir, { recursive: true })
    writeFileSync(join(mdir, "manifest.json"), "{json rusak###", "utf8")
    const m = await loadCheckpointManifest(sid, dir)
    expect(m.currentIndex).toBe(-1)
    expect(m.checkpoints).toEqual([])
    // Bukti backup, bukan hapus diam-diam.
    expect(readdirSync(mdir).some((f) => f.includes(".corrupt."))).toBe(true)
  } finally {
    await cleanup(dir)
  }
})

// ── 4. validateResumeWorkspace mendeteksi divergensi ──

test("audit: resume validation 0 saat cocok, >0 setelah workspace diubah", async () => {
  const dir = memCwd()
  try {
    writeFileSync(join(dir, "f.txt"), "v1", "utf8")
    await recordCheckpointFromSnapshots(
      "rv-1",
      1,
      [{ path: "f.txt", content: "v1" }],
      "turn 1",
      dir,
    )
    expect(await validateResumeWorkspace(dir, "rv-1")).toEqual({ mode: "files", diverged: 0 })
    writeFileSync(join(dir, "f.txt"), "v2-manual", "utf8")
    const after = await validateResumeWorkspace(dir, "rv-1")
    expect(after?.mode).toBe("files")
    expect(after!.diverged).toBeGreaterThan(0)
  } finally {
    await cleanup(dir)
  }
})

// ── 5. Branch menyalin DB tetapi BUKAN checkpoint ──

test("audit: branchSession fork pesan tanpa fork checkpoint", async () => {
  const dir = memCwd()
  try {
    await saveSession("induk", dir, undefined, MSGS, undefined)
    await recordCheckpointFromSnapshots(
      "induk",
      1,
      [{ path: "f.txt", content: "v1" }],
      "turn 1",
      dir,
    )
    const n = await branchSession("induk", "anak", dir)
    expect(n).toBe(3)
    expect(loadSession("anak", dir)?.messages.length).toBe(3)
    // Celah fork: anak tak punya manifes — validator mengira "bersih".
    expect(existsSync(join(dir, ".minicode", "checkpoints", "anak"))).toBe(false)
    expect(await validateResumeWorkspace(dir, "anak")).toEqual({ mode: "none", diverged: 0 })
  } finally {
    await cleanup(dir)
  }
})

// ── 6. Undo mengembalikan workspace tetapi BUKAN history (divergensi sadar) ──

test("audit: undo rollback file tanpa menyentuh riwayat DB", async () => {
  const dir = memCwd()
  const sid = "undo-1"
  try {
    writeFileSync(join(dir, "f.txt"), "v2", "utf8")
    await recordCheckpointFromSnapshots(sid, 1, [{ path: "f.txt", content: "v1" }], "turn 1", dir, [
      { path: "f.txt", content: "v2" },
    ])
    await saveSession(sid, dir, undefined, MSGS, { turn: 1 })
    const undo = await undoLastCheckpoint(sid, dir)
    expect(undo.success).toBe(true)
    // Workspace kembali, pointer mundur…
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("v1")
    expect((await loadCheckpointManifest(sid, dir)).currentIndex).toBe(-1)
    // …tetapi riwayat DB tetap mengklaim turn terjadi (transkrip vs workspace).
    expect(loadSession(sid, dir)?.messages.length).toBe(3)
  } finally {
    await cleanup(dir)
  }
})

// ── 7. Baris turns hanya untuk turn selesai (audit #08 P1 §16) ──

test("audit: save usage tanpa pesan tak menambah turnCount hampa", async () => {
  const dir = memCwd()
  try {
    await saveSession("sk-1", dir, undefined, [], { turn: 0 })
    const loaded = loadSession("sk-1", dir)
    expect(loaded?.messages.length).toBe(0)
    // Audit #08: re-save tanpa pesan baru BUKAN turn baru — turnCount 0.
    // Perilaku lama (1) adalah skew akuntansi: baris turns hampa menekan
    // stitch warning decideRecovery untuk turn yang tak pernah durable.
    expect(loaded?.turnCount).toBe(0)
    expect(listPersistedTurns("sk-1", dir)).toEqual([])
  } finally {
    await cleanup(dir)
  }
})

test("audit: save ulang riwayat sama tak menambah turn hantu", async () => {
  const dir = memCwd()
  try {
    await saveSession("sk-2", dir, undefined, MSGS, { turn: 0 })
    // Retry/crash antara save dan finalize: persist yang sama sekali lagi.
    await saveSession("sk-2", dir, undefined, MSGS, { turn: 0 })
    expect(listPersistedTurns("sk-2", dir)).toEqual([0])
    expect(loadSession("sk-2", dir)?.turnCount).toBe(1)
    // Turn baru (pesan bertambah) tetap tercatat.
    await saveSession("sk-2", dir, undefined, [...MSGS, { role: "user", content: "x" }], {
      turn: 1,
    })
    expect(listPersistedTurns("sk-2", dir)).toEqual([0, 1])
  } finally {
    await cleanup(dir)
  }
})

// ── 8. Cap 20 checkpoint ──

test("audit: manifes dibatasi 20 entri (eviksi lama)", async () => {
  const dir = memCwd()
  try {
    for (let i = 1; i <= 21; i++) {
      await recordCheckpointFromSnapshots(
        "cap-1",
        i,
        [{ path: "f.txt", content: `v${i}` }],
        `turn ${i}`,
        dir,
      )
    }
    const m = await loadCheckpointManifest("cap-1", dir)
    expect(m.checkpoints.length).toBe(20)
    expect(m.currentIndex).toBe(19)
  } finally {
    await cleanup(dir)
  }
})
