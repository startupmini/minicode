// Fidelity resume: kernel Message membawa `reasoning` (thinking DeepSeek-style)
// dan `isError` (tool gagal) ke history, tapi kolomnya tak pernah ada di tabel
// `messages` — resume lama sewajarnya buta dan model kehilangan konteks gagalnya.
// Regresi ini menutup gap itu pada jalur yang SUDAH incremental (bukan tabel
// baru): perubahan HANYA pada reasoning/is_error juga harus terdeteksi prefix
// comparison, kalau tidak append Incremental melewatkannya.
import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSession, saveSession } from "../src/session/persistence.ts"

const dirs: string[] = []

// WAL/shm handle kadang masih terkunci sesaat setelah close di Windows —
// retry dulu sebelum rm (pola yang sama dipakai persistence-rewrite.test.ts).
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

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "minicode-session-fidelity-"))
  // WAJIB: tanpa `.minicode`, resolveDbPath() jatuh ke ~/.minicode global —
  // test lalu menulis ke sessions.db milik user sungguhan.
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rmDir(dir)
})

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 }

test("round-trip menyimpan reasoning dan flag isError", async () => {
  const dir = workspace()
  const messages = [
    { role: "user", content: "perbaiki bug" },
    {
      role: "assistant",
      content: "",
      reasoning: "rencana: baca test dulu",
      toolCalls: [{ id: "call-1", name: "bash", args: { cmd: "bun test" } }],
    },
    { role: "tool", name: "bash", toolCallId: "call-1", content: "gagal", isError: true },
    { role: "assistant", content: "selesai" },
  ]
  await saveSession("s1", dir, "system", messages, usage)
  const loaded = loadSession("s1", dir)
  expect(loaded?.messages).toEqual(messages)
  const asst = loaded?.messages[1] as { reasoning?: string }
  const tool = loaded?.messages[2] as { isError?: boolean }
  expect(asst.reasoning).toBe("rencana: baca test dulu")
  expect(tool.isError).toBe(true)
})

test("pesan tanpa reasoning/isError tidak gaining field palsu saat reload", async () => {
  // `isError: false` / `reasoning: ""` di setiap pesan akan mengubah bentuk
  // pesan saat kernel membandingkan — absen harus tetap absen.
  const dir = workspace()
  await saveSession("s2", dir, undefined, [{ role: "user", content: "hi" }], usage)
  const loaded = loadSession("s2", dir)
  const m = loaded?.messages[0] as Record<string, unknown>
  expect("reasoning" in m).toBe(false)
  expect("isError" in m).toBe(false)
})

test("perubahan HANYA pada reasoning/isError terdeteksi (prefix compare)", async () => {
  // Kalau norma tidak ikut dibandingkan, append incremental menganggap
  // "tak berubah" dan perubahan hilang diam-diam — kelas bug F-05.
  const dir = workspace()
  const base = [
    { role: "user", content: "satu" },
    { role: "assistant", content: "", reasoning: "versi-A" },
  ]
  await saveSession("s3", dir, undefined, base, usage)
  const next = [base[0]!, { role: "assistant", content: "", reasoning: "versi-B" }]
  await saveSession("s3", dir, undefined, next, usage)
  const loaded = loadSession("s3", dir)
  expect((loaded?.messages[1] ?? {}) as { reasoning?: string }).toMatchObject({
    reasoning: "versi-B",
  })

  const flipped = [
    base[0]!,
    { role: "assistant", content: "", reasoning: "versi-B", isError: true },
  ]
  await saveSession("s3", dir, undefined, flipped, usage)
  const loaded2 = loadSession("s3", dir)
  expect((loaded2?.messages[1] ?? {}) as { isError?: boolean }).toMatchObject({ isError: true })
})

test("DB lama (schema pra-migration) tetap resume DAN bisa ditulis lanjut", async () => {
  // Kolom reasoning/is_error ditambahkan additive. DB yang dibuat versi lama
  // harus: (1) tetap terbaca, (2) field baru absen bukan palsu, (3) bisa
  // ditulis incremental tanpa kehilangan data lamanya.
  const dir = workspace()
  const path = join(dir, ".minicode", "sessions.db")
  const old = new Database(path)
  old.exec("PRAGMA journal_mode=WAL")
  old.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, cwd TEXT, system TEXT);
    CREATE TABLE messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, ts INTEGER, PRIMARY KEY(session_id, seq));
    CREATE TABLE turns (session_id TEXT, turn_idx INTEGER, usage TEXT, ts INTEGER, PRIMARY KEY(session_id, turn_idx));
  `)
  old.exec("INSERT INTO sessions (id, created_at, cwd, system) VALUES ('lama', 1000, '/x', 'sys')")
  old.exec(
    "INSERT INTO messages (session_id, seq, role, content, toolCalls, toolCallId, name, ts) VALUES ('lama', 0, 'user', ?, 'null', NULL, NULL, 1000)",
    [JSON.stringify("pertanyaan lama")],
  )
  old.exec(
    "INSERT INTO messages (session_id, seq, role, content, toolCalls, toolCallId, name, ts) VALUES ('lama', 1, 'tool', ?, 'null', 'c1', 'bash', 1000)",
    [JSON.stringify("hasil lama")],
  )
  old.exec("INSERT INTO turns (session_id, turn_idx, usage, ts) VALUES ('lama', 0, '{}', 1000)")
  old.close()

  const loaded = loadSession("lama", dir)
  expect(loaded?.messages.length).toBe(2)
  expect(loaded?.turnCount).toBe(1)
  // Field baru harus ABSEN, bukan default palsu.
  expect("reasoning" in ((loaded?.messages[0] as object) ?? {})).toBe(false)
  expect("isError" in ((loaded?.messages[1] as object) ?? {})).toBe(false)

  // Tulis turn lanjutan ke DB yang sudah dimigrasi.
  const next = [...(loaded?.messages ?? []), { role: "user", content: "lanjut" }]
  await saveSession("lama", dir, "sys", next, usage)
  const after = loadSession("lama", dir)
  const afterMessages = (after?.messages ?? []) as { content?: unknown }[]
  expect(afterMessages.length).toBe(3)
  expect(afterMessages[2]?.content).toBe("lanjut")
  expect(afterMessages[0]?.content).toBe("pertanyaan lama")
})

test("rewrite tetap incremental: history panjang tidak ditulis ulang tiap turn", async () => {
  // Penjaga regressi untuk sidecar yang dulu O(history) per turn (62 ms encode
  // + 53 ms blob write). Jalur messages harus tetap append-only.
  const dir = workspace()
  const history = [{ role: "user", content: "seed" }]
  await saveSession("s4", dir, undefined, history, usage)
  for (let i = 0; i < 5; i++) {
    history.push({ role: "assistant", content: `jawaban ${i}` })
    await saveSession("s4", dir, undefined, history, usage)
  }
  const loaded = loadSession("s4", dir)
  expect(loaded?.messages.length).toBe(6)
  expect(loaded?.turnCount).toBe(6)
})
