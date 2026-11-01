// Fase 11 — regresi Audit #2: ketepatan tipe, ketahanan error non-instance,
// dan hot-path optimization.
//
// Setiap test mem-verifikasi perbaikan bedah yang diterapkan pasca Audit #2:
//   A.1/B.4  validasi --ratelimit/--budget selaras (exec.ts vs index.ts)
//   A.2      checkpoint clamp currentIndex luar batas (tak crash undo/redo)
//   A.3      collectOperationalState ambil evidence "verify" yang benar
//   A.4      (diverifikasi lewat tsc — tidak ada test runtime tersendiri)
//   A.8      MINICODE_KEYSTORE_FORCE_DPAPI="0"/"false" tak memaksa DPAPI
//   C.F1     open() skip DDL ulang tapi tetap recreate skema bila DB dihapus
//   C.F2     orphan cleanup digate pada gone.changes > 0 (TTL tetap benar)
//   C.F4/C.F6/C.F8  optimasi cache deterministik + output identik

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetTaskStoreHandles } from "../src/task/store.ts"
import { isolateHomeForTests } from "./helpers/hermetic-home.ts"

isolateHomeForTests()

const tmpRoots: string[] = []
function tempDir(prefix = "p23-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(d, ".minicode"), { recursive: true })
  tmpRoots.push(d)
  return d
}
afterAll(() => {
  // Windows: handle bun:sqlite baru lepas saat GC (bukan close()), jadi paksa GC
  // dulu + reset cache TaskStore agar rmSync tak kena EBUSY; best-effort.
  try {
    resetTaskStoreHandles()
  } catch {}
  Bun.gc(true)
  for (const d of tmpRoots) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

describe("p23: Audit #2 type-safety & hot-path regression", () => {
  test("A.1/B.4: validasi --ratelimit & --budget selaras (exec.ts vs index.ts)", () => {
    const exec = readFileSync(join(import.meta.dir, "..", "cli", "commands", "exec.ts"), "utf8")
    const index = readFileSync(join(import.meta.dir, "..", "cli", "index.ts"), "utf8")
    // Guard rate-limit positif (tolak NaN / <= 0) ada di KEDUA entry point.
    expect(exec).toContain("!Number.isFinite(rpm) || rpm <= 0")
    expect(index).toContain("!Number.isFinite(rpm) || rpm <= 0")
    // Warning --budget non-angka konsisten.
    expect(exec).toContain("--budget requires a USD number")
    expect(index).toContain("--budget requires a USD number")
  })

  test("A.2: manifest currentIndex luar batas / checkpoints non-array tak crash", async () => {
    const { loadCheckpointManifest, saveCheckpointManifest } = await import(
      "../src/session/checkpoint.ts"
    )
    const cwd = tempDir("p23-cp-")
    const cp = (id: string) => ({
      id,
      turn: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      description: "d",
      snapshots: [],
    })
    // currentIndex jauh melebihi checkpoints.length → clamp ke len-1
    await saveCheckpointManifest(
      { sessionId: "a", currentIndex: 99, checkpoints: [cp("cp1")] },
      cwd,
    )
    expect((await loadCheckpointManifest("a", cwd)).currentIndex).toBe(0)
    // currentIndex negatif → clamp ke -1
    await saveCheckpointManifest(
      { sessionId: "b", currentIndex: -5, checkpoints: [cp("cp1")] },
      cwd,
    )
    expect((await loadCheckpointManifest("b", cwd)).currentIndex).toBe(-1)
    // checkpoints bukan array → dinormalisasi jadi []
    await saveCheckpointManifest(
      { sessionId: "c", currentIndex: 0, checkpoints: "bukan-array" as never },
      cwd,
    )
    const c = await loadCheckpointManifest("c", cwd)
    expect(Array.isArray(c.checkpoints)).toBe(true)
    expect(c.checkpoints).toHaveLength(0)
    expect(c.currentIndex).toBe(-1)
  })

  test("A.3: collectOperationalState ambil evidence 'verify' terakhir (bukan elemen terakhir)", async () => {
    const { TaskStore } = await import("../src/task/store.ts")
    const { collectOperationalState } = await import("../src/session/runtime-header.ts")
    const dir = tempDir("p23-a3-")
    const sid = "p23-a3"
    const store = new TaskStore(dir)
    store.createTask(sid, {
      title: "verify lalu completion",
      status: "IN_PROGRESS",
      order: 0,
      provenance: { origin: "runtime", source: "p23" },
    })
    // Elemen TERAKHIR ber-kind "completion" (tanpa verdict) — bug lama akan
    // membaca elemen terakhir ini dan melaporkan verificationVerdict undefined.
    store.patchTask(sid, "t1", {
      evidence: [
        { kind: "verify", detail: JSON.stringify({ verdict: "passed" }), at: "x" },
        { kind: "completion", detail: JSON.stringify({ checkedAt: "y" }), at: "y" },
      ],
    })
    // Task kedua: detail verify KORUP — tak boleh membatalkan seluruh snapshot.
    store.createTask(sid, {
      title: "detail korup",
      status: "IN_PROGRESS",
      order: 1,
      provenance: { origin: "runtime", source: "p23" },
    })
    store.patchTask(sid, "t2", {
      evidence: [{ kind: "verify", detail: "BUKAN-JSON", at: "x" }],
    })

    const usage = {
      getSession: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }),
      getTurnCount: () => 1,
    }
    const snap = collectOperationalState(sid, dir, usage, 10)
    expect(snap).not.toBeNull()
    const t1 = snap?.activeTasks?.find((t) => t.id === "t1")
    expect(t1?.verificationVerdict).toBe("passed")
    const t2 = snap?.activeTasks?.find((t) => t.id === "t2")
    expect(t2?.verificationVerdict).toBeUndefined()
  })

  test("A.8: MINICODE_KEYSTORE_FORCE_DPAPI '0'/'false' tak memaksa DPAPI", () => {
    const p = process as { platform: string }
    const origPlatform = process.platform
    const prevForce = process.env.MINICODE_KEYSTORE_FORCE_DPAPI
    const prevDisable = process.env.MINICODE_KEYSTORE_DISABLE
    try {
      // Aktifkan jalur non-win32 (hanya di sana FORCE_DPAPI relevan).
      p.platform = "linux"
      delete process.env.MINICODE_KEYSTORE_DISABLE
      const { keystoreBackend } =
        require("../src/lib/keystore.ts") as typeof import("../src/lib/keystore.ts")
      process.env.MINICODE_KEYSTORE_FORCE_DPAPI = "0"
      expect(keystoreBackend()).toBe("plain-file")
      process.env.MINICODE_KEYSTORE_FORCE_DPAPI = "false"
      expect(keystoreBackend()).toBe("plain-file")
      process.env.MINICODE_KEYSTORE_FORCE_DPAPI = "1"
      expect(keystoreBackend()).toBe("dpapi")
    } finally {
      p.platform = origPlatform
      if (prevForce === undefined) delete process.env.MINICODE_KEYSTORE_FORCE_DPAPI
      else process.env.MINICODE_KEYSTORE_FORCE_DPAPI = prevForce
      if (prevDisable === undefined) delete process.env.MINICODE_KEYSTORE_DISABLE
      else process.env.MINICODE_KEYSTORE_DISABLE = prevDisable
    }
  })

  test("C.F1: open() skip DDL ulang tapi tetap recreate skema bila DB dihapus", () => {
    const { openSessionDb } =
      require("../src/session/persistence.ts") as typeof import("../src/session/persistence.ts")
    const cwd = tempDir("p23-f1-")
    const hasTable = (db: import("bun:sqlite").Database, name: string): boolean =>
      db
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1")
        .get(name) !== null

    const db1 = openSessionDb(cwd)
    expect(hasTable(db1, "daemon_approvals")).toBe(true)
    expect(hasTable(db1, "sessions")).toBe(true)
    db1.close()

    const db2 = openSessionDb(cwd)
    expect(hasTable(db2, "sessions")).toBe(true)
    db2.close()

    // Hapus + buka ulang: DDL tetap berjalan (tableExists gagal pada DB baru).
    // Windows: paksa GC dulu agar handle bun:sqlite benar-benar lepas dari path.
    Bun.gc(true)
    rmSync(join(cwd, ".minicode"), { recursive: true, force: true })
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    const db3 = openSessionDb(cwd)
    expect(hasTable(db3, "daemon_approvals")).toBe(true)
    db3.close()
  })

  test("C.F2: purgeExpired selalu bersihkan orphan (incl. out-of-band), bukan digate", () => {
    const { openSessionDb, purgeExpired } =
      require("../src/session/persistence.ts") as typeof import("../src/session/persistence.ts")
    const cwd = tempDir("p23-f2-")
    const db = openSessionDb(cwd)
    const old = Date.now() - 32 * 24 * 60 * 60 * 1000 // 32 hari lalu
    // 1. Tanpa sesi expired → 0; orphan OUT-OF-BAND (tanpa baris sessions) TETAP
    //    dibersihkan. Ini yang mematahkan usulan gate `gone.changes > 0` (C.F2):
    //    yatim bisa hadir walau tak ada sesi yang baru kedaluwarsa.
    db.prepare(
      "INSERT INTO presentation_events (session_id, event_seq, type, turn_id, ts, payload) VALUES ('sub_deadbeef', 1, 'notice', 0, ?, '{}')",
    ).run(Date.now())
    expect(purgeExpired(db)).toBe(0)
    const orphan = db
      .prepare("SELECT COUNT(*) AS n FROM presentation_events WHERE session_id = 'sub_deadbeef'")
      .get() as { n: number }
    expect(orphan.n).toBe(0)
    // 2. Sesi expired + baris message yatim → terhapus bersih.
    db.prepare(
      "INSERT INTO sessions (id, created_at, updated_at, writer_epoch, cwd) VALUES ('s1', ?, ?, 0, ?)",
    ).run(old, old, cwd)
    db.prepare(
      "INSERT INTO messages (session_id, seq, role, content) VALUES ('s1', 0, 'user', 'hi')",
    ).run()
    expect(purgeExpired(db)).toBe(1)
    const left = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = 's1'").get() as {
      n: number
    }
    expect(left.n).toBe(0)
    db.close()
  })

  test("C.F4: findPrice deterministik (cache urutan kunci tak mengubah hasil)", () => {
    const { findPrice } =
      require("../src/policy/pricing.ts") as typeof import("../src/policy/pricing.ts")
    expect(findPrice("gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.075 })
    expect(findPrice("openai/gpt-4o")).toEqual({ input: 2.5, output: 10, cacheRead: 1.25 })
    for (let i = 0; i < 3; i++)
      expect(findPrice("gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.075 })
    expect(findPrice("model-yang-tidak-ada")).toBeUndefined()
  })

  test("C.F6: matchAllowlist deterministik (cache RegExp tak mengubah hasil)", () => {
    const { matchAllowlist } =
      require("../src/policy/allowlist.ts") as typeof import("../src/policy/allowlist.ts")
    const call = { id: "call-1", name: "write_file", args: { path: "a.js" } }
    expect(matchAllowlist(call, ["write_file:*"])).toBe(true)
    expect(matchAllowlist(call, ["bash:*"])).toBe(false)
    expect(
      matchAllowlist({ id: "call-2", name: "bash", args: { command: "echo hi" } }, ["bash:*"]),
    ).toBe(true)
    for (let i = 0; i < 3; i++) expect(matchAllowlist(call, ["write_file:*"])).toBe(true)
  })

  test("C.F8: sweepJournal prune record ≤ maxUpto deterministik", async () => {
    const { sweepJournal } = await import("../src/session/journal.ts")
    const cwd = tempDir("p23-f8-")
    const sid = "p23-sweep"
    const path = join(cwd, ".minicode", `journal-${sid}.jsonl`)
    const rec = (seq: number, state: string, extra: Record<string, unknown> = {}) => ({
      v: 1,
      id: `${sid}:${seq}`,
      session: sid,
      seq,
      tool: "edit",
      cwd,
      state,
      ...extra,
    })
    const records = [
      rec(3, "committed"),
      rec(7, "committed"),
      rec(10, "committed", { kind: "finalize", uptoSeq: 5 }),
    ]
    writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8")

    const removed = await sweepJournal(sid, cwd)
    expect(removed).toBe(1) // hanya seq 3 (pending, ≤ maxUpto) yang dipangkas
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { seq: number })
    expect(lines.map((l) => l.seq).sort((a, b) => a - b)).toEqual([7, 10])
  })

  test("ci.yml menyertakan test/p23 pada job ci dan ci-windows", () => {
    const ci = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")
    expect(ci).toContain("test/p23-*.test.ts")
    expect(ci).toContain("ci-windows:")
  })
})
