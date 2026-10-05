// M14 — Produksi runtime composition: gate default-off + wiring CLI.
// Hermetic: tmp SQLite + createCliSession nyata (gate mati = tak ada journal).

import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliSession } from "../cli/setup.ts"
import {
  createProductionRuntime,
  type ProductionRuntimeDeps,
  RUNTIME_GATE_DISABLED,
  RUNTIME_GATE_ENABLED,
  runtimeGateFor,
  runtimeJournalPath,
} from "../src/runtime/production-runtime.ts"

const created: string[] = []

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-m14p-"))
  created.push(dir)
  return dir
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()!
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        await Bun.sleep(100)
      }
    }
  }
})

// ── gate: default mati = tak ada apa pun yang dibangun ───────────────────────
test("M14 gate: runtuh sebelum konstruksi; deps tak pernah dipanggil", async () => {
  let invoked = false
  const handle = await createProductionRuntime(RUNTIME_GATE_DISABLED, () => {
    invoked = true
    throw new Error("deps must never be invoked when the gate is shut")
  })
  expect({
    invoked,
    enabled: handle.enabled,
    constructed: handle.constructed,
    runtime: handle.runtime(),
    flushed: await handle.flush(),
    isClosed: handle.isClosed(),
  }).toEqual({
    invoked: false,
    enabled: false,
    constructed: false,
    runtime: null,
    flushed: null,
    isClosed: true,
  })
  // stop() no-op dan tetap idempoten.
  await handle.stop()
  await handle.stop()
  expect(invoked).toBe(false)
})

test("M14 gate: hanya literal true yang menyalakan (undefined = mati)", () => {
  expect(runtimeGateFor(undefined)).toEqual(RUNTIME_GATE_DISABLED)
  expect(runtimeGateFor("off")).toEqual(RUNTIME_GATE_DISABLED)
  expect(runtimeGateFor("owned")).toEqual(RUNTIME_GATE_ENABLED)
})

// ── gate hidup: handle benar-benar memiliki + menutup runtime ─────────────────
test("M14 gate hidup: deps dipanggil, runtime dibangun, stop menutupnya", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, "journal.db")
  let seen: ProductionRuntimeDeps | null = null
  const handle = await createProductionRuntime(RUNTIME_GATE_ENABLED, () => {
    seen = {
      sessionId: "m14p",
      workspaceCwd: dir,
      journalPath,
    }
    return seen
  })
  expect(seen).not.toBeNull()
  expect(handle.constructed).toBe(true)
  const runtime = handle.runtime()
  expect(runtime).not.toBeNull()
  expect(runtime!.sessionId).toBe("m14p")
  expect(runtime!.journal?.isOpen()).toBe(true)
  expect(handle.isClosed()).toBe(false)

  await handle.stop()
  expect(handle.isClosed()).toBe(true)
  expect(runtime!.isClosed()).toBe(true)
  expect(runtime!.journal?.isOpen()).toBe(false)
  // Idempoten pada level handle DAN composition.
  await handle.stop()
  expect(runtime!.host.state()).toBe("CLOSED")
})

// ── fail-closed: jurnal tak bisa dibuka = start gagal, bukan runtime tanpa history
test("M14 fail-closed: jurnal rusak menahan konstruksi (tak ada runtime setengah jadi)", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, "broken.db")
  // Berkas non-SQLite: open pasti gagal (korup sqlite, bukan kondisi teoritis).
  await Bun.write(journalPath, "bukan sebuah database sqlite")
  await expect(
    createProductionRuntime(RUNTIME_GATE_ENABLED, () => ({
      sessionId: "m14p-broken",
      workspaceCwd: dir,
      journalPath,
    })),
  ).rejects.toThrow(/journal/i)
})

// ── kepemilikan path: workspace-lokal, per identitas, fail-closed ────────────
test("M14 path: jurnal milik workspace, per identitas, deterministik", () => {
  const dir = tmpDir()
  const p1 = runtimeJournalPath(dir, "sess-a")
  const p2 = runtimeJournalPath(dir, "sess-b")
  expect(p1).toBe(join(dir, ".minicode", "runtime-journal-sess-a.db"))
  expect(p2).toBe(join(dir, ".minicode", "runtime-journal-sess-b.db"))
  // Resume: identitas yang sama → path yang sama (history lama ditemukan).
  expect(runtimeJournalPath(dir, "sess-a")).toBe(p1)
  // Traversal/separator/NUL ditolak fail-closed.
  for (const bad of ["..", "a/b", "a\\b", "a\0b", ""]) {
    expect(() => runtimeJournalPath(dir, bad)).toThrow()
  }
  // Nama berkas tetap di dalam .minicode walau identitas aneh.
  const weird = runtimeJournalPath(dir, "weird id:*?")
  expect(weird.startsWith(join(dir, ".minicode"))).toBe(true)
  expect(weird).not.toContain("*")
})

// ── wiring CLI: gate mati = tak ada jejak sama sekali ────────────────────────
test("M14 wiring: createCliSession denga gate mati tidak membangun journal", async () => {
  const dir = tmpDir()
  const { createCliSession } = await import("../cli/setup.ts")
  const session = (await createCliSession({
    cwd: dir,
    sessionId: "m14p-off",
    prompt: "",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
  })) as CliSession
  try {
    expect(session.productionRuntime.constructed).toBe(false)
    expect(session.productionRuntime.runtime()).toBeNull()
    expect(existsSync(join(dir, ".minicode", "runtime-journal-m14p-off.db"))).toBe(false)
  } finally {
    await session.close()
  }
})

// ── wiring CLI: gate hidup = journal milik sesi itu, ditutup saat close() ─────
test("M14 wiring: gate hidup membangun journal di .minicode dan menutupnya di close()", async () => {
  const dir = tmpDir()
  const { createCliSession } = await import("../cli/setup.ts")
  const session = (await createCliSession({
    cwd: dir,
    sessionId: "m14p-on",
    prompt: "",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
    runtimeMode: "constructed",
  })) as CliSession
  const journalPath = join(dir, ".minicode", "runtime-journal-m14p-on.db")
  try {
    expect(session.productionRuntime.constructed).toBe(true)
    expect(session.productionRuntime.runtime()?.sessionId).toBe("m14p-on")
    expect(existsSync(journalPath)).toBe(true)
    expect(session.productionRuntime.runtime()?.journal?.isOpen()).toBe(true)
  } finally {
    await session.close()
  }
  expect(session.productionRuntime.isClosed()).toBe(true)
})

// ── wiring CLI: resume memakai identitas yang di-resume, bukan yang baru ──────
test("M14 wiring: resume memakai path jurnal sesi yang di-resume", async () => {
  const dir = tmpDir()
  const { createCliSession } = await import("../cli/setup.ts")
  const base = {
    cwd: dir,
    prompt: "",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
  }
  const first = (await createCliSession({
    ...base,
    sessionId: "m14p-orig",
    runtimeMode: "constructed",
  })) as CliSession
  const originalJournal = join(dir, ".minicode", "runtime-journal-m14p-orig.db")
  try {
    expect(existsSync(originalJournal)).toBe(true)
    // P2.1: resume butuh baris sesi durable (bukan hanya artefak runtime).
    await first.persistCurrent({})
  } finally {
    await first.close()
  }
  const resumed = (await createCliSession({
    ...base,
    sessionId: "m14p-new",
    resumeId: "m14p-orig",
    runtimeMode: "constructed",
  })) as CliSession
  try {
    // Resume menemukan jurnal LAMA; sesi tak boleh mencangkok jurnal baru.
    expect(resumed.productionRuntime.runtime()?.journalPath).toBe(originalJournal)
    expect(existsSync(join(dir, ".minicode", "runtime-journal-m14p-new.db"))).toBe(false)
  } finally {
    await resumed.close()
  }
})

// ── urutan shutdown: scheduler dulu, runtime kedua ───────────────────────────
test("M14 wiring: close() menutup runtime (tepat setelah scheduler)", async () => {
  const dir = tmpDir()
  const { createCliSession } = await import("../cli/setup.ts")
  const session = (await createCliSession({
    cwd: dir,
    sessionId: "m14p-order",
    prompt: "",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
    runtimeMode: "constructed",
  })) as CliSession
  const runtime = session.productionRuntime.runtime()
  await session.close()
  expect(session.productionRuntime.isClosed()).toBe(true)
  expect(runtime?.host.state()).toBe("CLOSED")
  expect(runtime?.journal?.isOpen()).toBe(false)
})
