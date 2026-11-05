// PROMPT 06 · Area E — konsistensi DB vector ↔ MEMORY.md.
//
// Yang dijaga (integration, bukan klaim):
// D1  Kegagalan total penulisan vector TIDAK disampaikan sebagai sukses
//     penuh: tool bilang "vector index unavailable … run memory reconcile".
// D2  Revoke by provenance memakai semantik AND (sama dengan query vector):
//     satu kriteria tidak menyapu baris provenance lain, dan baris TANPA tag
//     selalu dipertahankan (tidak bisa membuktikan provenance = fail-closed).
// D3  Reconcile MENGADOPSI entri vector-only ke MEMORY.md, bukan menghapusnya.
// D5  Fakta panjang (>1000 char) tersimpan utuh di berkas sehingga chunk vector
//     tidak pernah dianggap vector-only oleh reconcile.
// D6  Supersession menghapus baris lama dari MEMORY.md (bukan hanya menambah
//     catatan) sehingga fakta lama tak lagi disajikan jalur retrieval file.
// D8  Lupa berdasarkan query menghapus SELURUH entri multi-chunk (tidak ada
//     chunk sisihan dengan `parent` menggantung).
//
// Hermetik: temp dir, tanpa jaringan (embedding keyword-only / fetch di-stub).

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendMemory } from "../src/memory/files.ts"
import {
  addMemory,
  deleteMemoryByQuery,
  embedTexts,
  reconcileMemoryStores,
  resetEmbeddingCircuitBreaker,
  revokeByProvenance,
  searchHybrid,
} from "../src/memory/vector.ts"
import { writeMemoryTool } from "../src/tools/memory.ts"

const repoRoot = join(import.meta.dir, "..")
const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-area-e-"))
  mkdirSync(join(d, ".minicode"), { recursive: true })
  dirs.push(d)
  return d
}
const ctxFor = (cwd: string) => ({ signal: new AbortController().signal, cwd }) as never
const memoryMd = (cwd: string) => readFileSync(join(cwd, ".minicode", "MEMORY.md"), "utf8")
const rowCount = (cwd: string): number => {
  const db = new Database(join(cwd, ".minicode", "vector.db"))
  try {
    return (db.prepare("SELECT count(*) as c FROM memory").get() as { c: number }).c
  } finally {
    db.close()
  }
}
/** Baris MEMORY.md persis seperti yang ditulis `write_memory` (teks + tag JSON). */
const memoryLine = (text: string, tags: unknown[]): string =>
  `- ${new Date().toISOString().slice(0, 10)} ${text} [tags: ${JSON.stringify(tags)}]`

afterEach(() => {
  resetEmbeddingCircuitBreaker()
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {}
  }
})

describe("Area E: D1 — kegagalan vector terlihat di hasil tool", () => {
  test("vector.db tak terbuka → hasil tool menyatakan degradasi, bukan sukses penuh", async () => {
    const dir = tempDir()
    // `.minicode/vector.db` berbentuk direktori → seluruh open() gagal sementara
    // berkas MEMORY.md tetap bisa ditulis (arah split-brain yang sama).
    mkdirSync(join(dir, ".minicode", "vector.db"), { recursive: true })
    const out = (await writeMemoryTool.execute({ text: "fakta D1 unik" }, ctxFor(dir))) as string
    expect(out).toContain("saved to")
    expect(out).toContain("vector index unavailable")
    expect(out).toContain("memory reconcile")
  })

  test("hint 'run memory reconcile' benar-benar memulihkan indeks (D4)", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, ".minicode", "vector.db"), { recursive: true })
    const out = (await writeMemoryTool.execute(
      { text: "fakta D4 pending reconcile" },
      ctxFor(dir),
    )) as string
    expect(out).toContain("vector index unavailable")

    // Hapus hambatan → jalur yang disarankan pesan itu benar-benar berjalan,
    // lewat SUBCOMMAND CLI yang disebut pesan tersebut (bukan hanya fungsi
    // internal): `minicode memory reconcile --json --cwd <dir>`.
    const { rmdirSync } = await import("node:fs")
    rmdirSync(join(dir, ".minicode", "vector.db"))
    const r = spawnSync(
      process.execPath,
      [join(repoRoot, "cli", "index.ts"), "memory", "reconcile", "--json", "--cwd", dir],
      { cwd: dir, encoding: "utf8", timeout: 60_000, env: { ...process.env, NO_COLOR: "1" } },
    )
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    const res = JSON.parse(String(r.stdout)) as { fileOnlyAdded: number; reconciled: number }
    expect(res.fileOnlyAdded).toBe(1)
    expect(typeof res.reconciled).toBe("number")
    expect(rowCount(dir)).toBe(1)
    expect(memoryMd(dir)).toContain("fakta D4 pending reconcile")
  })
})

describe("Area E: D2 — revoke by provenance (AND, fail-closed)", () => {
  test("satu kriteria sessionId tidak menyapu baris provenance lain / tanpa tag", async () => {
    const dir = tempDir()
    await addMemory("fakta sesi A", { cwd: dir, sessionId: "sA", sourceKind: "agent" })
    await addMemory("fakta sesi B", { cwd: dir, sessionId: "sB", sourceKind: "user" })
    const body = [
      memoryLine("fakta sesi A", ["session:sA", "source:agent"]),
      memoryLine("fakta sesi B", ["session:sB", "source:user"]),
      // Baris manual TANPA tag: tidak bisa membuktikan provenance apa pun.
      "- 2026-01-01 baris manual tanpa tag",
    ].join("\n")
    writeFileSync(join(dir, ".minicode", "MEMORY.md"), `${body}\n`, "utf8")

    const res = await revokeByProvenance({ sessionId: "sA" }, dir)
    expect(res.vectorRows).toBe(1)
    expect(res.fileLines).toBe(1)

    const file = memoryMd(dir)
    expect(file).toContain("fakta sesi B")
    expect(file).toContain("baris manual tanpa tag")
    expect(file).not.toContain("fakta sesi A")
  })
})

describe("Area E: D3 — reconcile mengadopsi vector-only", () => {
  test("entri vector-only masuk MEMORY.md (hilang) → konsisten tanpa kehilangan", async () => {
    const dir = tempDir()
    const { setMemoryWriteFaultInjectorForTest } = await import("../src/memory/vector.ts")
    setMemoryWriteFaultInjectorForTest((stage) => {
      if (stage === "after_vector_before_file") throw new Error("crash setelah vector")
    })
    await expect(addMemory("vector-only entry D3", { cwd: dir })).rejects.toThrow()
    setMemoryWriteFaultInjectorForTest(null)

    let file = ""
    try {
      file = memoryMd(dir)
    } catch {}
    expect(file).not.toContain("vector-only entry D3")
    const res = await reconcileMemoryStores(dir)
    expect(res.vectorOnlyAdopted).toBe(1)
    expect(readFileSync(join(dir, ".minicode", "MEMORY.md"), "utf8")).toContain(
      "vector-only entry D3",
    )
    // Tidak ada baris yang dihapus.
    expect(rowCount(dir)).toBe(1)
  })
})

describe("Area E: D5 — fakta panjang utuh di berkas", () => {
  test("teks >1000 char tidak dipotong → reconcile tidak menghapus ekor chunk", async () => {
    const dir = tempDir()
    const long = `AWAL-TERATUR-${"isi data panjang ".repeat(200)}-AKHIR`
    expect(long.length).toBeGreaterThan(1_000)

    await addMemory(long, { cwd: dir })
    // addMemory tidak menyentuh berkas — replikasi jalur produsen file.
    await appendMemory(long, dir)

    const file = memoryMd(dir)
    expect(file).toContain("AWAL-TERATUR")
    expect(file).toContain("-AKHIR")

    const before = rowCount(dir)
    const res = await reconcileMemoryStores(dir)
    // Sudah sinkron: tidak ada yang diadopsi ulang & tidak ada baris hilang.
    expect(res.vectorOnlyAdopted).toBe(0)
    expect(res.fileOnlyAdded).toBe(0)
    expect(rowCount(dir)).toBe(before)
    expect(before).toBeGreaterThanOrEqual(2) // benar-benar ter-chunk
  })
})

describe("Area E: D6 — supersession menghapus baris lama", () => {
  test("supersedeMemory menarik fakta lama dari MEMORY.md", async () => {
    const dir = tempDir()
    const { supersedeMemory } = await import("../src/memory/vector.ts")
    const oldId = await addMemory("port lama adalah 3000", { cwd: dir })
    const newId = await addMemory("port baru adalah 8080", { cwd: dir })
    await appendMemory("port lama adalah 3000", dir)
    await appendMemory("port baru adalah 8080", dir)

    await supersedeMemory(oldId, newId, dir)

    const file = memoryMd(dir)
    expect(file).not.toContain("port lama adalah 3000")
    expect(file).toContain("port baru adalah 8080")
    expect(file).toContain("supersession")
  })
})

describe("P1.3 — reconcile tidak boleh menghidupkan memori superseded", () => {
  /** Head id entri yang mengandung `needle` (chunk resolve ke parent). */
  const headIdOf = (cwd: string, needle: string): string => {
    const db = new Database(join(cwd, ".minicode", "vector.db"))
    try {
      const row = db
        .prepare("SELECT COALESCE(parent, id) AS head FROM memory WHERE text LIKE ? LIMIT 1")
        .get(`%${needle}%`) as { head: string } | null
      if (!row) throw new Error(`no memory row containing ${needle}`)
      return row.head
    } finally {
      db.close()
    }
  }

  test("reconcile setelah supersession: fakta lama tetap hilang dari file + retrieval", async () => {
    const dir = tempDir()
    await writeMemoryTool.execute({ text: "PORT-LAMA-3000" }, ctxFor(dir))
    const oldId = headIdOf(dir, "PORT-LAMA-3000")
    await writeMemoryTool.execute({ text: "PORT-BARU-8080", supersedes_id: oldId }, ctxFor(dir))

    // Prasyarat: jalur tulis nyata sudah menghapus fakta lama dari file.
    expect(memoryMd(dir)).not.toContain("PORT-LAMA-3000")
    expect(memoryMd(dir)).toContain("PORT-BARU-8080")

    const res = await reconcileMemoryStores(dir)
    expect(res.supersededSkipped).toBeGreaterThan(0)
    // Inti no-resurrection: reconcile TIDAK menulis ulang fakta lama.
    expect(memoryMd(dir)).not.toContain("PORT-LAMA-3000")
    expect(memoryMd(dir)).toContain("PORT-BARU-8080")

    const hits = await searchHybrid("PORT-LAMA-3000", { cwd: dir, topK: 5 })
    expect(hits.some((h) => h.text.includes("PORT-LAMA-3000"))).toBe(false)
  })

  test("baris file sisa entri superseded dibersihkan, bukan diindeks ulang", async () => {
    const dir = tempDir()
    await writeMemoryTool.execute({ text: "WARNA-LAMA-MERAH" }, ctxFor(dir))
    const oldId = headIdOf(dir, "WARNA-LAMA-MERAH")
    await writeMemoryTool.execute({ text: "WARNA-BARU-BIRU", supersedes_id: oldId }, ctxFor(dir))
    // Simulasikan sisa file dari versi lama / crash sebelum baris terhapus.
    await appendMemory("WARNA-LAMA-MERAH", dir)
    expect(memoryMd(dir)).toContain("WARNA-LAMA-MERAH")

    const res = await reconcileMemoryStores(dir)
    expect(res.supersededFileRemoved).toBeGreaterThan(0)
    expect(memoryMd(dir)).not.toContain("WARNA-LAMA-MERAH")
    expect(memoryMd(dir)).toContain("WARNA-BARU-BIRU")
  })

  test("dua writer superseding head yang sama → tepat satu yang berhasil", async () => {
    const dir = tempDir()
    const oldId = await addMemory("FAKTA-BERSAMA", { cwd: dir })
    const results = await Promise.allSettled([
      addMemory("PENERUS-KIRI", { cwd: dir, supersedesId: oldId }),
      addMemory("PENERUS-KANAN", { cwd: dir, supersedesId: oldId }),
    ])
    const ok = results.filter((r) => r.status === "fulfilled").length
    const fail = results.filter((r) => r.status === "rejected").length
    expect(ok).toBe(1)
    expect(fail).toBe(1)
    // Tidak boleh ada dua penerus sama-sama live untuk head yang sama.
    const db = new Database(join(dir, ".minicode", "vector.db"))
    try {
      const live = db
        .prepare(
          "SELECT count(*) AS c FROM memory WHERE (superseded_by IS NULL OR superseded_by = '')",
        )
        .get() as { c: number }
      expect(live.c).toBe(1)
    } finally {
      db.close()
    }
  })

  test("baris file legacy partial-match superseded di-quarantine (tidak dihapus, tidak diindeks ulang)", async () => {
    const dir = tempDir()
    const long = `LEGACY-AWAL-${"data panjang ".repeat(200)}-LEGACY-AKHIR`
    await addMemory(long, { cwd: dir })
    const oldId = headIdOf(dir, "LEGACY-AWAL")
    await writeMemoryTool.execute({ text: "PENGGANTI-LEGACY", supersedes_id: oldId }, ctxFor(dir))
    // Simulasi baris legacy ter-truncate (prefix dari entri lama) yang tertinggal.
    const truncated = long.slice(0, 1000)
    await appendMemory(truncated, dir)
    expect(memoryMd(dir)).toContain("LEGACY-AWAL")

    const res = await reconcileMemoryStores(dir)
    expect(res.legacySuspectLines).toBeGreaterThan(0)
    // Tidak dihapus (fakta file tetap) dan TIDAK diindeks ulang ke vector.
    expect(memoryMd(dir)).toContain("LEGACY-AWAL")
    const hits = await searchHybrid(truncated.slice(0, 60), { cwd: dir, topK: 5 })
    expect(hits.some((h) => h.text.startsWith("LEGACY-AWAL"))).toBe(false)
  })

  test("target yang sudah superseded ditolak tanpa menulis fakta baru ke file", async () => {
    const dir = tempDir()
    await writeMemoryTool.execute({ text: "TARGET-SEKALI" }, ctxFor(dir))
    const oldId = headIdOf(dir, "TARGET-SEKALI")
    await writeMemoryTool.execute({ text: "PENERUS-PERTAMA", supersedes_id: oldId }, ctxFor(dir))

    await expect(
      writeMemoryTool.execute(
        { text: "PENERUS-KEDUA-TIDAK-BOLEH", supersedes_id: oldId },
        ctxFor(dir),
      ),
    ).rejects.toThrow(/ALREADY_SUPERSEDED|already superseded/i)
    expect(memoryMd(dir)).not.toContain("PENERUS-KEDUA-TIDAK-BOLEH")
  })
})

describe("Area E: D8 — lupa menghapus seluruh entri multi-chunk", () => {
  test("query mengenai SATU chunk → seluruh sibling ikut terhapus", async () => {
    const dir = tempDir()
    // > 2× chunk size (2000) → benar-benar pecah jadi ≥3 chunk; token MARKER
    // berada jauh setelah chunk pertama sehingga HANYA di chunk ketengah.
    const head = `ENTRI-${"x".repeat(2100)}-TAIL-MARKER-${"x".repeat(2100)}`
    await addMemory(head, { cwd: dir })
    expect(rowCount(dir)).toBeGreaterThanOrEqual(3)

    await deleteMemoryByQuery("TAIL-MARKER", dir)

    // Tidak ada chunk sisihan dengan `parent` menggantung.
    expect(rowCount(dir)).toBe(0)
  })
})

describe("Area E: D9 — cap menghapus entri utuh, bukan sisakan chunk", () => {
  test("melebihi MEMORY_MAX_ROWS tidak meninggalkan chunk yatim", async () => {
    const dir = tempDir()
    // Buat skema lewat jalur normal (open() menjalankan migrasi), lalu kosongkan
    // agar fixture hanya berisi entri uji.
    await addMemory("seeder", { cwd: dir })
    const db = new Database(join(dir, ".minicode", "vector.db"))
    const insert = db.prepare(
      "INSERT INTO memory (id, text, embedding, created_at, category, parent) VALUES (?, ?, NULL, ?, 'fact', ?)",
    )
    db.exec("BEGIN")
    db.prepare("DELETE FROM memory").run()
    // Entri lama: 3 chunk (created_at 0) — batas cap jatuh DI TENGAH entri ini.
    for (let i = 0; i < 3; i++) insert.run(`old-${i}`, `chunk lama ${i}`, 0, "pOld")
    // Entri baru: 4999 chunk (created_at 1) → total 5002 > cap 5000.
    for (let i = 0; i < 4999; i++) insert.run(`new-${i}`, `chunk baru ${i}`, 1, "pNew")
    db.exec("COMMIT")
    db.close()

    const { pruneTTL } = await import("../src/memory/vector.ts")
    await pruneTTL(dir, 0)

    const check = new Database(join(dir, ".minicode", "vector.db"))
    try {
      const old = (
        check.prepare("SELECT count(*) as c FROM memory WHERE parent = 'pOld'").get() as {
          c: number
        }
      ).c
      const total = (check.prepare("SELECT count(*) as c FROM memory").get() as { c: number }).c
      // Entri lama terhapus SEKALIGUS (versi lama memotong per-offset baris dan
      // meninggalkan chunk yatim), dan entri baru utuh di bawah cap.
      expect(old).toBe(0)
      expect(total).toBe(4999)
    } finally {
      check.close()
    }
  })
})

describe("Area E: D12 — validasi bentuk hasil embedding", () => {
  test("respons tanpa embedding → null (keyword-only), bukan vektor sampah", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ nope: true }] }), { status: 200 })) as never
    try {
      // IP literal lolos cek private-host tanpa jaringan.
      const bad = await embedTexts("http://8.8.8.8/v1", "k", ["dua", "input"], undefined, {
        attemptMs: 500,
        totalMs: 1_000,
      })
      expect(bad).toBeNull()
    } finally {
      globalThis.fetch = original
    }
  })

  test("jumlah vektor ≠ jumlah input → dianggap rusak (null)", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 })) as never
    try {
      const partial = await embedTexts("http://8.8.8.8/v1", "k", ["a", "b"], undefined, {
        attemptMs: 500,
        totalMs: 1_000,
      })
      expect(partial).toBeNull()
    } finally {
      globalThis.fetch = original
    }
  })
})
