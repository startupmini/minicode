// P13 P1 memori: TTL hierarkis sudah di memory-p1; di sini access_count,
// sebaran kategori di stats, dan scope+kategori di `memory status --json`.
// Hermetic: tmp cwd + .minicode/ agar vector.db lokal (resolveDbPath).

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { resolveDbPath } from "../src/lib/db-path.ts"
import { appendMemory, deleteMemoryLines, readMemoryFile } from "../src/memory/files.ts"
import {
  addMemory,
  deleteMemoryByQuery,
  getMemoryStats,
  searchHybrid,
} from "../src/memory/vector.ts"

const repoRoot = resolve(import.meta.dir, "..")

async function makeCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-mem-p13-"))
  await mkdir(join(dir, ".minicode"), { recursive: true })
  return dir
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

function accessOf(dir: string, like: string): number | null {
  const db = new Database(resolveDbPath("vector.db", dir))
  try {
    const r = db
      .prepare(`SELECT access_count as c FROM memory WHERE text LIKE ?`)
      .get(`%${like}%`) as { c: number | null } | null
    return r?.c ?? null
  } finally {
    db.close()
  }
}

test("P13 access_count: hit yang dikembalikan search menaikkan counter", async () => {
  const cwd = await makeCwd()
  try {
    const marker = `ac-${randomUUID().slice(0, 6)}`
    // Kata kunci unik + panjang agar lolos threshold keyword-only (>=0.25).
    await addMemory(`deploy pipeline checklist ${marker} rollback runbook staging`, { cwd })
    expect(accessOf(cwd, marker)).toBe(0)
    const hits = await searchHybrid(`deploy pipeline checklist ${marker} rollback`, { cwd })
    expect(hits.some((h) => h.text.includes(marker))).toBe(true)
    expect(accessOf(cwd, marker)).toBe(1)
    // Query yang tidak match tidak menyentuh counter row ini.
    await searchHybrid(`totally unrelated zebra quasar`, { cwd })
    expect(accessOf(cwd, marker)).toBe(1)
  } finally {
    await cleanup(cwd)
  }
})

test("P13 stats: sebaran kategori tampil per kategori", async () => {
  const cwd = await makeCwd()
  try {
    const m = randomUUID().slice(0, 6)
    await addMemory(`fact row ${m} alpha`, { cwd, category: "fact" })
    await addMemory(`decision row ${m} beta`, { cwd, category: "decision" })
    const s = getMemoryStats(cwd)
    const byCat = new Map(s.categories.map((c) => [c.category, c.count]))
    expect(byCat.get("fact") ?? 0).toBeGreaterThanOrEqual(1)
    expect(byCat.get("decision") ?? 0).toBeGreaterThanOrEqual(1)
  } finally {
    await cleanup(cwd)
  }
})

test("P13 memory status --json: kategori + scope tampil", async () => {
  const cwd = await makeCwd()
  try {
    const m = randomUUID().slice(0, 6)
    await addMemory(`json probe ${m} gamma`, { cwd, category: "snippet" })
    const r = spawnSync(
      process.execPath,
      [join(repoRoot, "cli", "index.ts"), "memory", "status", "--json"],
      {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, NO_COLOR: "1" },
      },
    )
    expect(r.status).toBe(0)
    const parsed = JSON.parse(String(r.stdout)) as {
      categories: { category: string; count: number }[]
      scope: string
      rows: number
    }
    expect(Array.isArray(parsed.categories)).toBe(true)
    expect(parsed.scope).toBe("cwd")
    expect(parsed.rows).toBeGreaterThanOrEqual(1)
    expect(parsed.categories.some((c) => c.category === "snippet")).toBe(true)
  } finally {
    await cleanup(cwd)
  }
})

test("P13 scope all: menggabung DB lokal + global (tanpa silent shadowing)", async () => {
  // Global = MINICODE_HOME/.minicode/vector.db — override eksplisit agar
  // hermetic lintas platform. (Sebelumnya memakai $HOME/$USERPROFILE, tapi
  // os.homedir() di POSIX mengabaikan $HOME sehingga test ini gagal di Linux
  // sekaligus mencemari home asli — ditemukan saat run WSL pertama.)
  const prevHome = process.env.MINICODE_HOME
  const fakeHome = await mkdtemp(join(tmpdir(), "minicode-memhome-"))
  const cwd = await makeCwd()
  try {
    await mkdir(join(fakeHome, ".minicode"), { recursive: true })
    process.env.MINICODE_HOME = fakeHome
    const m = randomUUID().slice(0, 6)
    // Baris "global": cwd-nya fakeHome sehingga resolveDbPath jatuh ke sana.
    await addMemory(`global recipe ${m} shared kitchen sourdough starter`, { cwd: fakeHome })
    await addMemory(`local recipe ${m} workspace deploy pipeline checklist`, { cwd })
    const all = await searchHybrid(`recipe ${m} kitchen pipeline`, { cwd, scope: "all" })
    const texts = all.map((h) => h.text).join("\n")
    expect(texts).toContain(`global recipe ${m}`)
    expect(texts).toContain(`local recipe ${m}`)
    // scope cwd saja tidak melihat baris global.
    const local = await searchHybrid(`recipe ${m} kitchen pipeline`, { cwd, scope: "cwd" })
    expect(local.map((h) => h.text).join("\n")).not.toContain(`global recipe ${m}`)
  } finally {
    if (prevHome === undefined) delete process.env.MINICODE_HOME
    else process.env.MINICODE_HOME = prevHome
    await cleanup(cwd)
    await rm(fakeHome, { recursive: true, force: true }).catch(() => {})
  }
})

test("M4 forget vector: deleteMemoryByQuery menghapus lokal + global", async () => {
  // searchHybrid scope=all menggabung dua DB — forget yang hanya menyentuh
  // satu sisi membuat data lama global tetap ditemukan (audit 2026-09-16).
  // Di kode lama hitungan = 1 (global bertahan); setelah perbaikan = 2.
  const prevHome = process.env.MINICODE_HOME
  const fakeHome = await mkdtemp(join(tmpdir(), "minicode-memhome-"))
  const cwd = await makeCwd()
  try {
    await mkdir(join(fakeHome, ".minicode"), { recursive: true })
    process.env.MINICODE_HOME = fakeHome
    const m = randomUUID().slice(0, 6)
    await addMemory(`global forgetme ${m} sourdough starter`, { cwd: fakeHome })
    await addMemory(`local forgetme ${m} deploy pipeline`, { cwd })
    const del = await deleteMemoryByQuery(`forgetme ${m}`, cwd)
    expect(del).toBe(2)
    const all = await searchHybrid(`forgetme ${m}`, { cwd, scope: "all" })
    expect(all.some((h) => h.text.includes(m))).toBe(false)
  } finally {
    if (prevHome === undefined) delete process.env.MINICODE_HOME
    else process.env.MINICODE_HOME = prevHome
    await cleanup(cwd)
    await rm(fakeHome, { recursive: true, force: true }).catch(() => {})
  }
})

test("M4 forget file: deleteMemoryLines menghapus MEMORY.md lokal + global", async () => {
  // read_memory membaca hierarki lokal DAN global — hapus lokal saja tak
  // tuntas. Di kode lama hitungan = 1 (global bertahan).
  const prevHome = process.env.MINICODE_HOME
  const fakeHome = await mkdtemp(join(tmpdir(), "minicode-memhome-"))
  const cwd = await makeCwd()
  try {
    process.env.MINICODE_HOME = fakeHome
    const m = randomUUID().slice(0, 6)
    await appendMemory(`local file forgetme ${m} deploy pipeline`, cwd)
    await mkdir(join(fakeHome, ".minicode"), { recursive: true })
    await writeFile(
      join(fakeHome, ".minicode", "MEMORY.md"),
      `- lama file forgetme ${m} sourdough\n`,
    )
    const del = await deleteMemoryLines(`forgetme ${m}`, cwd)
    expect(del).toBe(2)
    expect((await readMemoryFile(cwd)).includes(m)).toBe(false)
  } finally {
    if (prevHome === undefined) delete process.env.MINICODE_HOME
    else process.env.MINICODE_HOME = prevHome
    await cleanup(cwd)
    await rm(fakeHome, { recursive: true, force: true }).catch(() => {})
  }
})

test("B9 scope global: membaca DB global eksplisit, bukan lokal", async () => {
  // MINICODE_MEMORY_SCOPE=global didokumentasikan (docs/environment.md),
  // tapi jatuh ke resolveDbPath = lokal bila .minicode ada. Di kode lama
  // hasil memuat baris lokal dan melewatkan global.
  const prevHome = process.env.MINICODE_HOME
  const fakeHome = await mkdtemp(join(tmpdir(), "minicode-memhome-"))
  const cwd = await makeCwd()
  try {
    await mkdir(join(fakeHome, ".minicode"), { recursive: true })
    process.env.MINICODE_HOME = fakeHome
    const m = randomUUID().slice(0, 6)
    await addMemory(`global scopeprobe ${m} sourdough starter`, { cwd: fakeHome })
    await addMemory(`local scopeprobe ${m} deploy pipeline`, { cwd })
    const g = await searchHybrid(`scopeprobe ${m}`, { cwd, scope: "global" })
    const texts = g.map((h) => h.text).join("\n")
    expect(texts).toContain(`global scopeprobe ${m}`)
    expect(texts).not.toContain(`local scopeprobe ${m}`)
  } finally {
    if (prevHome === undefined) delete process.env.MINICODE_HOME
    else process.env.MINICODE_HOME = prevHome
    await cleanup(cwd)
    await rm(fakeHome, { recursive: true, force: true }).catch(() => {})
  }
})
