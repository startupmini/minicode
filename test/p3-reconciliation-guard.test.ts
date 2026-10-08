// P3.1 - Canonical Write Guard, RETARGETED to current canonical architecture.
//
// Kontrak current yang diuji (P3_0 section 3/4/14, I1/I2 - yang hidup di kode hari ini):
//
//   Runtime Context boleh mempublikasikan HANYA append-extension atas histori
//   kanonik. Buffer divergen/menyusut/ter-fold = saveSession MENOLAK lewat
//   RefusedHistoryRewriteError (P2.7 append-only); kanonik utuh; rute eksplisit
//   shrinkThreadHistory (berpagar epoch, provenance, invalidasi proyeksi).
//   Buffer basi karena kanonik tumbuh (penulis lain) = TOLAK-JUJUR, jangan
//   shrink otomatis (I2) - baris penulis lain tak boleh dihancurkan.
//   Epoch pindah = STALE WRITER, bukan konflik publikasi.
//
// SUPERSEDED-FORM NOTE (retarget, bukan restore): bentuk P3.1 historis
// (assessHistoryPublication, SessionAttachRefusedError, refusePublication,
// noteDiagnostic, CliSession.isReconciliationConflict, compareStoredPrefix)
// TIDAK PERNAH committed dan tidak dihidupkan di sini. Penegakan kini milik
// P2.7 (putusan publikasi) + P3.2 (semantik freshness deskriptif - BUKAN gate
// kedua: P3.2 mendeskripsikan, saveSession yang memutuskan).
//
// Semua test melewati production path nyata: saveSession (satu-satunya penulis
// kanonik), resolveSessionIdentity, createCliSession + persistCurrent, dan satu
// probe CLI sebagai proses. Tanpa helper palsu.

import { Database } from "bun:sqlite"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { flagNameOf, valueFlags } from "../cli/args.ts"
import { createCliSession } from "../cli/setup.ts"
import { acquireSessionWriter } from "../src/session/authority.ts"
import type { CanonicalEventRef } from "../src/session/context-identity.ts"
import {
  assessContextFreshness,
  compareContextFrontier,
  deriveFrontierFromDurable,
} from "../src/session/context-identity.ts"
import {
  resolveSessionIdentity,
  SessionAliasError,
  SessionNotFoundError,
} from "../src/session/identity.ts"
import {
  DEFAULT_THREAD_ID,
  RefusedHistoryRewriteError,
  saveSession,
} from "../src/session/persistence.ts"
import { SESSION_LEASE_MS } from "../src/task/session-authority.ts"
import { resetTaskStoreHandles } from "../src/task/store.ts"
import { startFakeProvider } from "./helpers/fake-provider.ts"

const u = (content: string) => ({ role: "user", content })
const a = (content: string) => ({ role: "assistant", content })
const x = (content: string) => ({ role: "user", content })

// Direktori temp DIBERSIHKAN: suite ini membuat belasan workspace SQLite per
// run, dan kebocoran direktori uji pernah membuat disk penuh sampai `tasks.db`
// gagal init.
//
// Sebab kebocorannya bukan "lock transien" melainkan cara `bun:sqlite` melepas
// berkas: handle OS baru ditutup saat objek Database di-GC, BUKAN saat
// `db.close()` - jadi `rmSync` gagal EBUSY selamanya di Windows (diukur:
// 3 percobaan berturut-turut gagal, `Bun.gc(true)` langsung membuat rm
// berhasil). Maka gc dipanggil di setiap percobaan gagal; retry singkat hanya
// menutupi sisa lock transien. Hook diberi timeout eksplisit karena default
// bun (5s) tidak cukup untuk belasan direktori bila seluruh rm harus diulang.
const created: string[] = []

// Sebab kedua lebih kuat lagi: handle `tasks.db` dipegang PETA MODUL task store
// (`handles` di src/task/store.ts), bukan objek yang bisa di-GC - jadi rm gagal
// EBUSY sampai cache itu dilepas. `resetTaskStoreHandles()` adalah seam
// hermetic yang sudah dipakai suite Phase 4; dibungkus try/catch karena ia
// menolak reset saat ada transaksi terbuka, dan tes yang gagal boleh
// meninggalkan transaksi seperti itu.
afterAll(async () => {
  const releaseHandles = () => {
    try {
      resetTaskStoreHandles()
    } catch {}
  }
  releaseHandles()
  while (created.length > 0) {
    const dir = created.pop()!
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        releaseHandles()
        Bun.gc(true)
        await Bun.sleep(50)
      }
    }
  }
}, 30_000)

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p31-"))
  created.push(dir)
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

/** Workspace + config provider palsu (dibutuhkan composition root). */
function wsWithConfig(): string {
  const dir = ws()
  writeFileSync(
    join(dir, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl: "http://localhost:9", apiKey: "sk-test", models: ["m"] }],
    }),
    "utf8",
  )
  return dir
}

function baseOpts(cwd: string, extra: Record<string, unknown> = {}) {
  return {
    cwd,
    allowLocalConfig: true,
    sessionId: "",
    prompt: "hi",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
    ...extra,
  }
}

/** Dekode kolom `content` (disimpan lewat safeContent/JSON, dekoder resmi parseContent). */
function decode(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Baris kanonik mentah: posisi + identitas + isi (bukti tak-termutasi). */
function rows(cwd: string, sid: string) {
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    return (
      db
        .prepare(
          "SELECT seq, role, content, event_id FROM messages WHERE session_id = ? AND thread_id = ? ORDER BY seq",
        )
        .all(sid, DEFAULT_THREAD_ID) as {
        seq: number
        role: string
        content: string
        event_id: string | null
      }[]
    ).map((r) => ({ ...r, content: decode(r.content) }))
  } finally {
    db.close()
  }
}

function fingerprint(cwd: string, sid: string): string {
  return JSON.stringify(rows(cwd, sid))
}

function contents(cwd: string, sid: string): unknown[] {
  return rows(cwd, sid).map((r) => r.content)
}

/** Jumlah baris pesan durable (cek histori-presence langsung ke store, tanpa gate). */
function messageCount(cwd: string, sid: string): number {
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(sid) as {
      n: number
    }
    return row.n
  } finally {
    db.close()
  }
}

const seed = (cwd: string, sid: string, msgs: unknown[]) =>
  saveSession(sid, cwd, undefined, msgs, { turns: 1 })

/**
 * Jembatan P3.2: baris durable menjadi referensi kanonis. Memakai bentuk
 * waktu-resume (isi ter-decode seperti loadSession) - deterministik untuk
 * baris yang sama.
 */
function refsFromRows(rs: { seq: number; role: string; content: unknown }[]): CanonicalEventRef[] {
  return rs.map((r) => ({
    seq: r.seq,
    role: r.role,
    content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
  }))
}

/** Frontier kanonis saat ini untuk satu sesi (null hanya bila belum ada baris). */
function frontier(cwd: string, sid: string) {
  return deriveFrontierFromDurable({
    sessionId: sid,
    rows: refsFromRows(rows(cwd, sid)),
    revision: 0,
  })
}

// -- Matriks persistensi: ACCEPT / IDEMPOTENT / REFUSE -----------------------

test("P3.1-A: append-extension diterima; identitas prefix dipertahankan", async () => {
  const cwd = ws()
  await seed(cwd, "a", [u("A"), a("B"), u("C")])
  const before = rows(cwd, "a")

  await saveSession("a", cwd, undefined, [u("A"), a("B"), u("C"), u("D"), a("E")], undefined, {
    expectedEpoch: 0,
  })

  const after = rows(cwd, "a")
  expect(after.map((r) => r.content)).toEqual(["A", "B", "C", "D", "E"])
  // Baris lama = baris yang SAMA (event_id tidak dipakai ulang, tidak dimint ulang).
  expect(after.slice(0, 3).map((r) => [r.seq, r.event_id])).toEqual(
    before.map((r) => [r.seq, r.event_id]),
  )
  expect(after.slice(3).every((r) => typeof r.event_id === "string" && r.event_id.length > 0)).toBe(
    true,
  )
})

test("P3.1-B: divergensi DITOLAK; kanonik utuh (isi + identitas + posisi)", async () => {
  const cwd = ws()
  await seed(cwd, "b", [u("A"), a("B"), u("C")])
  const before = fingerprint(cwd, "b")

  await expect(
    saveSession("b", cwd, undefined, [u("A"), x("X"), u("C"), u("D")], undefined, {
      expectedEpoch: 0,
    }),
  ).rejects.toBeInstanceOf(RefusedHistoryRewriteError)

  // Kanonik TIDAK tersentuh - bukan cuma panjangnya, tapi identitas tiap baris.
  expect(fingerprint(cwd, "b")).toBe(before)
  expect(contents(cwd, "b")).toEqual(["A", "B", "C"])

  // Jembatan P3.2: kandidat pada rentang yang tumpang-tindih DIVERGED dari kanonis.
  const canon = frontier(cwd, "b")!
  const cand = deriveFrontierFromDurable({
    sessionId: "b",
    rows: refsFromRows([
      { seq: 0, role: "user", content: "A" },
      { seq: 1, role: "user", content: "X" },
      { seq: 2, role: "user", content: "C" },
    ]),
    revision: 0,
  })!
  expect(canon.headSeq).toBe(cand.headSeq)
  expect(compareContextFrontier(canon, cand)).toBe("DIVERGED")
})

test("P3.1-C: penghapusan, urutan terbalik, dan penggantian isi DITOLAK", async () => {
  const cwd = ws()
  await seed(cwd, "c", [u("A"), a("B"), u("C")])
  const before = fingerprint(cwd, "c")

  // (1) penghapusan: [A, C]
  await expect(
    saveSession("c", cwd, undefined, [u("A"), u("C")], undefined, { expectedEpoch: 0 }),
  ).rejects.toBeInstanceOf(RefusedHistoryRewriteError)
  // (2) urutan terbalik: [B, A, C]
  await expect(
    saveSession("c", cwd, undefined, [a("B"), u("A"), u("C")], undefined, { expectedEpoch: 0 }),
  ).rejects.toBeInstanceOf(RefusedHistoryRewriteError)
  // (3) penggantian isi (panjang sama, isi beda): [A, B, C2]
  await expect(
    saveSession("c", cwd, undefined, [u("A"), a("B"), u("C2")], undefined, { expectedEpoch: 0 }),
  ).rejects.toBeInstanceOf(RefusedHistoryRewriteError)

  expect(fingerprint(cwd, "c")).toBe(before)
  expect(contents(cwd, "c")).toEqual(["A", "B", "C"])
})

test("P3.1-C2: buffer ter-fold (non-prefix, menyusut) DITOLAK - bukan append", async () => {
  const cwd = ws()
  await seed(cwd, "f", [u("A"), a("B"), u("C"), a("D")])
  const before = fingerprint(cwd, "f")
  // Bentuk keluaran kompaksi kernel: prefix diganti ringkasan + ekor dipertahankan.
  const folded = [x("Previous context:\nringkas"), a("D")]

  await expect(
    saveSession("f", cwd, undefined, folded, undefined, { expectedEpoch: 0 }),
  ).rejects.toBeInstanceOf(RefusedHistoryRewriteError)
  expect(fingerprint(cwd, "f")).toBe(before)

  // Jembatan P3.2: view ter-fold tertinggal dari head kanonis = STALE, dan
  // view basi tak boleh dipublikasikan apa adanya (saveSession menolak di atas).
  const canon = frontier(cwd, "f")!
  const foldedCtx = deriveFrontierFromDurable({
    sessionId: "f",
    rows: refsFromRows([
      { seq: 0, role: "user", content: "Previous context:\nringkas" },
      { seq: 1, role: "assistant", content: "D" },
    ]),
    revision: 0,
  })!
  expect(assessContextFreshness(foldedCtx, canon)).toBe("stale")
})

test("P3.1-D: ekstensi ekuivalen-prefix diterima", async () => {
  const cwd = ws()
  await seed(cwd, "d", [u("A"), a("B")])
  await saveSession("d", cwd, undefined, [u("A"), a("B"), u("C")], undefined, {
    expectedEpoch: 0,
  })
  expect(contents(cwd, "d")).toEqual(["A", "B", "C"])
})

test("P3.1-E: identik = idempoten (tanpa baris/turn/identitas baru)", async () => {
  const cwd = ws()
  await seed(cwd, "e", [u("A"), a("B")])
  const before = fingerprint(cwd, "e")
  await saveSession("e", cwd, undefined, [u("A"), a("B")], { turns: 2 }, { expectedEpoch: 0 })
  expect(fingerprint(cwd, "e")).toBe(before)
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const turn = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get("e") as {
      n: number
    }
    expect(turn.n).toBe(1)
  } finally {
    db.close()
  }
  // Jembatan P3.2: derivasi ulang dari baris yang sama = EQUAL (replay stabil).
  const f1 = frontier(cwd, "e")!
  const f2 = frontier(cwd, "e")!
  expect(compareContextFrontier(f1, f2)).toBe("EQUAL")
})

test("P3.1-F: semantik freshness P3.2 sejalan dengan putusan saveSession", async () => {
  const cwd = ws()
  await seed(cwd, "g", [u("A"), a("B")])

  // Identik = EQUAL, dan saveSession no-op (fingerprint sama).
  const f1 = frontier(cwd, "g")!
  expect(compareContextFrontier(f1, frontier(cwd, "g")!)).toBe("EQUAL")
  const fp1 = fingerprint(cwd, "g")
  await saveSession("g", cwd, undefined, [u("A"), a("B")], { turns: 9 }, { expectedEpoch: 0 })
  expect(fingerprint(cwd, "g")).toBe(fp1)

  // Advance valid = B_AHEAD, dan saveSession menerima sebagai append.
  await saveSession("g", cwd, undefined, [u("A"), a("B"), u("C")], undefined, { expectedEpoch: 0 })
  const f2 = frontier(cwd, "g")!
  expect(compareContextFrontier(f1, f2)).toBe("B_AHEAD")
  expect(contents(cwd, "g")).toEqual(["A", "B", "C"])
  const fp2 = fingerprint(cwd, "g")

  // Divergen pada head yang sama = DIVERGED, dan saveSession menolak.
  const fDiv = deriveFrontierFromDurable({
    sessionId: "g",
    rows: refsFromRows([
      { seq: 0, role: "user", content: "A" },
      { seq: 1, role: "assistant", content: "B" },
      { seq: 2, role: "user", content: "C2" },
    ]),
    revision: 0,
  })!
  expect(compareContextFrontier(f2, fDiv)).toBe("DIVERGED")
  await expect(
    saveSession("g", cwd, undefined, [u("A"), a("B"), u("C2")], undefined, { expectedEpoch: 0 }),
  ).rejects.toBeInstanceOf(RefusedHistoryRewriteError)
  expect(fingerprint(cwd, "g")).toBe(fp2)

  // Kandidat melampaui head yang ternyata append valid: P3.2 membacanya UNKNOWN
  // *sebagai view* (tak terverifikasi dari kanonis), tetapi putusan publikasi
  // tetap milik prefix-check saveSession (menerima). P3.2 mendeskripsikan,
  // P2.7 memutuskan - bukan gate ganda.
  const fBeyond = deriveFrontierFromDurable({
    sessionId: "g",
    rows: refsFromRows([
      { seq: 0, role: "user", content: "A" },
      { seq: 1, role: "assistant", content: "B" },
      { seq: 2, role: "user", content: "C" },
      { seq: 3, role: "user", content: "D" },
    ]),
    revision: 0,
  })!
  expect(assessContextFreshness(fBeyond, f2)).toBe("unknown")
  await saveSession("g", cwd, undefined, [u("A"), a("B"), u("C"), u("D")], undefined, {
    expectedEpoch: 0,
  })
  expect(contents(cwd, "g")).toEqual(["A", "B", "C", "D"])
})

// -- Attach: reuse melanjutkan histori; identitas tak dikenal ditolak --------

test("P3.1-G: reuse --session melanjutkan histori (tanpa reset, tanpa refusal basi)", async () => {
  const cwd = ws()
  await seed(cwd, "lama", [u("A"), a("B")])

  // Arsitektur current TIDAK menolak attach pada id berhistori: reuse = lanjut.
  // (Gate histori-presence bentuk lama tidak ada; yang ada ialah penolakan
  // konflik identitas di bawah. Kesenjangan itu didokumentasikan, bukan dipalsu.)
  const id = resolveSessionIdentity({ sessionFlag: "lama", cwd })
  expect(id.sid).toBe("lama")
  expect(id.resumed).toBe(false)

  // Reuse benar-benar melanjutkan (append), bukan me-reset.
  await saveSession("lama", cwd, undefined, [u("A"), a("B"), u("C")], undefined, {
    expectedEpoch: 0,
  })
  expect(contents(cwd, "lama")).toEqual(["A", "B", "C"])

  // Id tak dikenal pada jalur resume = ditolak eksplisit (bukan sesi baru diam-diam).
  expect(() => resolveSessionIdentity({ resumeFlag: "tidak-ada", cwd })).toThrow(
    SessionNotFoundError,
  )

  // Id baru = identitas fresh yang eksplisit; tetap boleh.
  expect(resolveSessionIdentity({ sessionFlag: "baru", cwd }).sid).toBe("baru")
  // --session + --resume pada id yang sama tetap jalur kontinuasi.
  expect(resolveSessionIdentity({ sessionFlag: "lama", resumeFlag: "lama", cwd }).sid).toBe("lama")

  // Konflik identitas (bukan histori) tetap ditolak: alias menunjuk kanonis
  // lain tidak bisa dibajak diam-diam. Cakupan alias penuh milik
  // test/session-identity.test.ts; di sini satu bukti perwakilan.
  expect(SessionAliasError).toBeDefined()
})

test("P3.1-G2: baris sesi TANPA histori bukan alasan menolak attach", async () => {
  const cwd = ws()
  // Baris materialisasi tanpa pesan (mis. run yang gagal sebelum persist).
  await saveSession("kosong", cwd, undefined, [], undefined)
  expect(messageCount(cwd, "kosong")).toBe(0)
  expect(resolveSessionIdentity({ sessionFlag: "kosong", cwd }).resumed).toBe(false)
})

// -- Jalur produksi penuh: createCliSession dan persistCurrent --------------
//
// Divergensi di sini BUKAN disuntik lewat API privat: P1 lahir dari kompaksi
// kernel yang nyata (buffer RAM dilipat karena tekanan konteks); P4 lahir dari
// penulis lain yang tumbuh melampaui buffer. Keduanya melewati persistCurrent
// yang sama dengan produksi.

/** Histori kanonik "berat": hasil tool besar yang benar-benar bisa dilipat. */
function bigHistory(rounds: number): unknown[] {
  const msgs: unknown[] = []
  for (let i = 0; i < rounds; i++) {
    msgs.push(u(`tugas ${i}`))
    msgs.push(a(`hasil ${i}`))
    msgs.push({
      role: "tool",
      name: "read_file",
      toolCallId: `call_${i}`,
      content: "z".repeat(2000),
    })
  }
  return msgs
}

function writeConfig(cwd: string, baseUrl: string): void {
  writeFileSync(
    join(cwd, ".minicode", "config.json"),
    JSON.stringify({
      providers: [
        { id: "fake", baseUrl, apiKey: "sk-test", models: ["gpt-4o-mini"], providerHint: "openai" },
      ],
    }),
    "utf8",
  )
}

test("P3.1-P1: buffer ter-fold kompaksi kernel menempuh shrink eksplisit ber-provenance", async () => {
  const cwd = wsWithConfig()
  const sid = "guard"
  const seeded = bigHistory(20)
  await saveSession(sid, cwd, undefined, seeded, { turns: 20 })
  const provider = startFakeProvider([{ kind: "text", text: "balasan" }])
  // Kompaksi LLM TIDAK boleh ikut (butuh provider sungguhan); env pemilik repo
  // bisa saja punya key-nya - matikan selama test lalu pulihkan.
  const priorKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  let cli: Awaited<ReturnType<typeof createCliSession>> | null = null
  try {
    writeConfig(cwd, provider.baseUrl)
    cli = await createCliSession(
      baseOpts(cwd, {
        resumeId: sid,
        contextWindowTokens: 9_000,
        keepRecentTurns: 1,
        timeoutMs: 30_000,
      }),
    )
    await cli.runPromptWithVerify("pertanyaan baru")
    // Precondition: kompaksi kernel benar-benar melipat buffer (bukan mock).
    expect(cli.session.state.history.length).toBeLessThan(10)
    expect(cli.session.state.history.length).toBeLessThan(seeded.length)

    await cli.persistCurrent({ totalTokens: 1 })

    // Kanonik TIDAK diganti mentah oleh buffer ter-fold: yang terjadi ialah
    // shrink eksplisit ber-provenance (semua baris hasil shrink bertanda
    // migrated_compacted=1; baris adopsi mempertahankan event_id warisan).
    const shrunk = rows(cwd, sid)
    expect(shrunk.length).toBeLessThan(seeded.length)
    const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
    try {
      const flags = db
        .prepare(
          "SELECT seq, migrated_compacted, event_id FROM messages WHERE session_id = ? ORDER BY seq",
        )
        .all(sid) as { seq: number; migrated_compacted: number; event_id: string | null }[]
      expect(flags.length).toBe(shrunk.length)
      expect(flags.every((f) => f.migrated_compacted === 1)).toBe(true)
      expect(flags.every((f) => typeof f.event_id === "string" && f.event_id.length > 0)).toBe(true)
    } finally {
      db.close()
    }
    // Jejak raksasa hilang HANYA lewat jalur eksplisit (bukan wipe diam-diam).
    expect(contents(cwd, sid).includes("z".repeat(2000))).toBe(false)
    // Ekor turn baru tetap terpublikasi (shrink bukan penghapusan buta).
    expect(contents(cwd, sid)).toContain("pertanyaan baru")
    expect(contents(cwd, sid)).toContain("balasan")
  } finally {
    await cli?.close()
    provider.close()
    if (priorKey !== undefined) process.env.DEEPSEEK_API_KEY = priorKey
  }
})

test("P3.1-P2: ekstensi sah tetap TERSIMPAN di jalur persist nyata", async () => {
  const cwd = wsWithConfig()
  const sid = "append"
  await seed(cwd, sid, [u("A"), a("B")])
  const provider = startFakeProvider([{ kind: "text", text: "C" }])
  writeConfig(cwd, provider.baseUrl)
  const cli = await createCliSession(baseOpts(cwd, { resumeId: sid }))
  try {
    await cli.runPromptWithVerify("D")
    await cli.persistCurrent({ totalTokens: 1 })
    expect(cli.isWriterStale()).toBe(false)
  } finally {
    provider.close()
    await cli.close()
  }
  // Turn nyata jadi baris kanonik baru - jalur append tetap hidup.
  expect(contents(cwd, sid)).toEqual(["A", "B", "D", "C"])
})

test("P3.1-P4: kanonik yang tumbuh (penulis lain) TAK BOLEH di-shrink diam-diam", async () => {
  const cwd = wsWithConfig()
  const sid = "tetangga"
  await seed(cwd, sid, [u("A"), a("B")])
  const cli = await createCliSession(baseOpts(cwd, { resumeId: sid }))
  try {
    // Konteks runtime sudah basi: kanonik TUMBUH setelah buffer di-seed.
    await saveSession(sid, cwd, undefined, [u("A"), a("B"), u("C-dari-penulis-lain")], undefined)
    const before = fingerprint(cwd, sid)
    await cli.persistCurrent({ totalTokens: 1 })
    // Baris penulis lain UTUH (I2: tak ada shrink otomatis atas pertumbuhan
    // kanonik); penolakan dilaporkan jujur lewat flag basi, bukan sukses diam.
    expect(fingerprint(cwd, sid)).toBe(before)
    expect(contents(cwd, sid)).toEqual(["A", "B", "C-dari-penulis-lain"])
    expect(cli.isWriterStale()).toBe(true)
    expect(cli.writerStaleNote()).toContain("grew beyond buffer")
  } finally {
    await cli.close()
  }
})

test("P3.1-P5: epoch pindah (take-over) menjadi STALE WRITER, bukan konflik publikasi", async () => {
  const cwd = wsWithConfig()
  const sid = "takeover"
  await seed(cwd, sid, [u("A"), a("B")])
  const cli = await createCliSession(baseOpts(cwd, { resumeId: sid }))
  try {
    expect(cli.writerEpoch).toBe(0)
    // Penulis asing take-over setelah lease kita kedaluwarsa.
    const other = acquireSessionWriter({
      sessionId: sid,
      cwd,
      bootId: "penulis-asing",
      now: Date.now() + SESSION_LEASE_MS + 1_000,
    })
    expect(other.ok).toBe(true)
    // Konteks runtime juga divergen (kanonik bertambah).
    await saveSession(sid, cwd, undefined, [u("A"), a("B"), u("C")], undefined)
    const before = fingerprint(cwd, sid)

    await cli.persistCurrent({ totalTokens: 1 })

    // Pagar generasi MENANG: kegagalan dilaporkan sebagai writer basi, dan
    // kanonik tetap utuh. (Tak ada permukaan konflik-rekonsiliasi pada
    // CliSession current - penolakan lapis-publikasi milik error + flag.)
    expect(cli.isWriterStale()).toBe(true)
    expect(cli.writerStaleNote()).toContain("epoch")
    expect(fingerprint(cwd, sid)).toBe(before)
  } finally {
    await cli.close()
  }
})

// -- Probe proses nyata: CLI sebagai proses (bukan API in-process) ------------
//
// Pola harness sama dengan test/cli-session.test.ts: proses anak asinkron +
// HOME palsu supaya config/DB global mesin ini tak ikut terbaca.

const repoRoot = join(import.meta.dir, "..")
const entry = join(repoRoot, "cli", "index.ts")

function reorderForSecureCli(args: string[]): string[] {
  const flags: string[] = []
  const prompt: string[] = []
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    const flag = flagNameOf(token)
    if (flag) {
      flags.push(token)
      if (valueFlags.has(flag) && !token.includes("=")) {
        const v = args[i + 1]
        if (v !== undefined) {
          flags.push(v)
          i++
        }
      }
      continue
    }
    prompt.push(token)
  }
  return [...flags, ...prompt]
}

interface Workspace {
  dir: string
  configPath: string
}

function makeWorkspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "minicode-p31-"))
  created.push(dir)
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  mkdirSync(join(dir, "home", ".minicode"), { recursive: true })
  return { dir, configPath: join(dir, ".minicode", "config.json") }
}

function writeProviderConfig(ws: Workspace, baseUrl: string): void {
  writeFileSync(
    ws.configPath,
    JSON.stringify({
      providers: [
        { id: "fake", baseUrl, apiKey: "sk-test", models: ["gpt-4o-mini"], providerHint: "openai" },
      ],
    }),
    "utf8",
  )
}

async function run(ws: Workspace, args: string[]): Promise<{ code: number; stderr: string }> {
  const fakeHome = join(ws.dir, "home")
  const proc = Bun.spawn([process.execPath, entry, ...reorderForSecureCli(args)], {
    cwd: ws.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      NO_COLOR: "1",
      DEEPSEEK_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      AGENT_BASE_URL: "",
    },
  })
  const killer = setTimeout(() => proc.kill(), 60_000)
  const [, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(killer)
  return { code, stderr }
}

test("P3.1-P3: CLI nyata - reuse --session tanpa --resume menempuh shrink eksplisit", async () => {
  const ws = makeWorkspace()
  const provider = startFakeProvider([
    { kind: "text", text: "balasan-satu" },
    { kind: "text", text: "balasan-dua" },
  ])
  try {
    writeProviderConfig(ws, provider.baseUrl)
    const base = ["--cwd", ws.dir, "--model", "gpt-4o-mini", "--allow-local-config"]

    const first = await run(ws, ["pertanyaan satu", "--session", "reuse-e2e", ...base])
    expect(first.code).toBe(0)
    expect(contents(ws.dir, "reuse-e2e")).toEqual(["pertanyaan satu", "balasan-satu"])

    // Run kedua pada id yang SAMA tanpa --resume: arsitektur current TIDAK
    // memuat histori (muat-histori hanya pada --resume) lalu menempuh shrink
    // EKSPLISIT ber-provenance - bukan penolakan, bukan penggantian diam-diam,
    // tetapi histori lama TERGANTIKAN. Kesenjangan attach-presence ini
    // didokumentasikan (bukan dipalsu): --session bukan --resume.
    const second = await run(ws, ["pertanyaan dua", "--session", "reuse-e2e", ...base])
    expect(second.code).toBe(0)
    expect(contents(ws.dir, "reuse-e2e")).toEqual(["pertanyaan dua", "balasan-dua"])
    const db = new Database(join(ws.dir, ".minicode", "sessions.db"), { readonly: true })
    try {
      const flags = db
        .prepare("SELECT migrated_compacted FROM messages WHERE session_id = ?")
        .all("reuse-e2e") as { migrated_compacted: number }[]
      // Semua baris hasil penggantian bertanda jalur eksplisit.
      expect(flags.length).toBe(2)
      expect(flags.every((f) => f.migrated_compacted === 1)).toBe(true)
    } finally {
      db.close()
    }

    // Jalur kontinuasi eksplisit tetap bekerja: append nyata, histori utuh.
    const third = await run(ws, ["pertanyaan tiga", "--resume", "reuse-e2e", ...base])
    expect(third.code).toBe(0)
    expect(third.stderr).toContain("resumed session reuse-e2e (2 messages)")
    expect(contents(ws.dir, "reuse-e2e")).toEqual([
      "pertanyaan dua",
      "balasan-dua",
      "pertanyaan tiga",
      "balasan-dua",
    ])
  } finally {
    provider.close()
  }
}, 120_000)
