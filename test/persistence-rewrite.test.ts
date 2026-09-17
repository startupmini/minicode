// Hardening F-05: perubahan isi dengan panjang SAMA harus tetap durable.
// Skenario: save → kompaksi mengganti N pesan dengan N pesan berbeda → save
// → reload. Kode lama memakai messages.length sebagai proksi perubahan
// sehingga tulis kedua dilewat dan resume memuat sejarah basi.
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSession, saveSession } from "../src/session/persistence.ts"

function localCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-persist-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

const msg = (role: string, content: string) => ({ role, content })

// WAL/shm handle terkadang masih terkunci sesaat setelah close di Windows —
// retry sebelum rm (pola yang sama dipakai persistence-ttl.test.ts). Bila
// tetap terkunci, best-effort: jangan jadikan sisa tmpdir sebagai failure.
async function rmDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

test("F-05: rewrite sama-panjang durable setelah reload", async () => {
  const cwd = localCwd()
  try {
    const id = "sess-rewrite-1"
    await saveSession(id, cwd, "sys", [msg("user", "satu"), msg("user", "dua")], { t: 1 })
    // Kompaksi: 2 pesan → 2 pesan BERBEDA (summary + tail).
    await saveSession(id, cwd, "sys", [msg("user", "RINGKASAN-KOMP AKSI"), msg("user", "dua")], {
      t: 2,
    })
    const loaded = loadSession(id, cwd)
    expect(loaded).not.toBeNull()
    expect(loaded!.messages.map((m) => (m as { content: unknown }).content)).toEqual([
      "RINGKASAN-KOMP AKSI",
      "dua",
    ])
  } finally {
    await rmDir(cwd)
  }
})

test("F-05: re-save identik tidak menambah baris turn hantu", async () => {
  const cwd = localCwd()
  try {
    const id = "sess-resave-1"
    const messages = [msg("user", "satu"), msg("user", "dua")]
    await saveSession(id, cwd, "sys", messages, { t: 1 })
    await saveSession(id, cwd, "sys", messages, { t: 1 })
    const loaded = loadSession(id, cwd)
    expect(loaded).not.toBeNull()
    expect(loaded!.messages.length).toBe(2)
  } finally {
    await rmDir(cwd)
  }
})

test("F-05: append murni tetap incremental + turn tercatat", async () => {
  const cwd = localCwd()
  try {
    const id = "sess-append-1"
    await saveSession(id, cwd, "sys", [msg("user", "satu")], { t: 1 })
    await saveSession(id, cwd, "sys", [msg("user", "satu"), msg("user", "dua")], { t: 2 })
    const loaded = loadSession(id, cwd)
    expect(loaded!.messages.map((m) => (m as { content: unknown }).content)).toEqual([
      "satu",
      "dua",
    ])
  } finally {
    await rmDir(cwd)
  }
})
