// P3.1 — Canonical Write Guard (Reconciliation Guard), produksi + proses nyata.
//
// Invarian yang dijaga (P3_0_CONTEXT_SESSION_CONTRACT §3/§4/§14, I1/I2):
//
//   Runtime Context boleh mempublikasikan HANYA append-extension atas histori
//   kanonik. Apa pun yang lain = RECONCILIATION_CONFLICT → DITOLAK, kanonik
//   utuh, bukti + jalur recovery eksplisit. Rantai lama
//   `divergen → append gagal → shrink buta → kanonik diganti` DILARANG.
//
// Test ini tidak menguji helper privat: kasus persistensi memakai `saveSession`
// (satu-satunya penulis kanonik), kasus komposisi memakai `createCliSession` +
// `persistCurrent` nyata, dan satu probe menjalankan CLI sebagai PROSES.

import { Database } from "bun:sqlite"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { flagNameOf, valueFlags } from "../cli/args.ts"
import { createCliSession } from "../cli/setup.ts"
import { acquireSessionWriter } from "../src/session/authority.ts"
import { resolveSessionIdentity, SessionAttachRefusedError } from "../src/session/identity.ts"
import {
  assessHistoryPublication,
  DEFAULT_THREAD_ID,
  RefusedHistoryRewriteError,
  saveSession,
  sessionHasHistory,
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
// `db.close()` — jadi `rmSync` gagal EBUSY selamanya di Windows (diukur:
// 3 percobaan berturut-turut gagal, `Bun.gc(true)` langsung membuat rm
// berhasil). Maka gc dipanggil di setiap percobaan gagal; retry singkat hanya
// menutupi sisa lock transien. Hook diberi timeout eksplisit karena default
// bun (5s) tidak cukup untuk belasan direktori bila seluruh rm harus diulang.
const created: string[] = []

// Sebab kedua lebih kuat lagi: handle `tasks.db` dipegang PETA MODUL task store
// (`handles` di src/task/store.ts), bukan objek yang bisa di-GC — jadi rm gagal
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

const seed = (cwd: string, sid: string, msgs: unknown[]) =>
  saveSession(sid, cwd, undefined, msgs, { turns: 1 })

// ── Matriks persistensi (kasus A–E dari permintaan P3.1) ─────────────────────

test("P3.1-A: append-extension diterima; identitas prefix dipertahankan", async () => {
  const cwd = ws()
  await seed(cwd, "a", [u("A"), a("B"), u("C")])
  const before = rows(cwd, "a")

  await saveSession("a", cwd, undefined, [u("A"), a("B"), u("C"), u("D"), a("E")], undefined, {
    expectedEpoch: 0,
  })

  const after = rows(cwd, "a")
  expect(after.map((r) => r.content)).toEqual(["A", "B", "C", "D", "E"])
  // Baris lama = baris yang SAMA (event_id bukan dipakai ulang, bukan dimint ulang).
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

  // Kanonik TIDAK tersentuh — bukan cuma panjangnya, tapi identitas tiap baris.
  expect(fingerprint(cwd, "b")).toBe(before)
  expect(contents(cwd, "b")).toEqual(["A", "B", "C"])

  const verdict = assessHistoryPublication("b", [u("A"), x("X"), u("C"), u("D")], cwd)
  expect(verdict.kind).toBe("DIVERGED")
  expect(verdict.storedCount).toBe(3)
  expect(verdict.incomingCount).toBe(4)
  expect(verdict.firstDivergenceSeq).toBe(1)
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
  // Ketiganya bukan append: klasifikasi eksplisit, bukan tebakan.
  expect(assessHistoryPublication("c", [u("A"), u("C")], cwd).kind).toBe("DIVERGED")
  expect(assessHistoryPublication("c", [a("B"), u("A"), u("C")], cwd).kind).toBe("DIVERGED")
  expect(assessHistoryPublication("c", [u("A"), a("B"), u("C2")], cwd).kind).toBe("DIVERGED")
})

test("P3.1-C2: buffer ter-fold (non-prefix, menyusut) DITOLAK — bukan append", async () => {
  const cwd = ws()
  await seed(cwd, "f", [u("A"), a("B"), u("C"), a("D")])
  const before = fingerprint(cwd, "f")
  // Bentuk keluaran kompaksi kernel: prefix diganti ringkasan + ekor dipertahankan.
  const folded = [x("Previous context:\nringkas"), a("D")]

  await expect(
    saveSession("f", cwd, undefined, folded, undefined, { expectedEpoch: 0 }),
  ).rejects.toBeInstanceOf(RefusedHistoryRewriteError)
  expect(fingerprint(cwd, "f")).toBe(before)

  const verdict = assessHistoryPublication("f", folded, cwd)
  expect(verdict.kind).toBe("DIVERGED")
  expect(verdict.storedCount).toBe(4)
  expect(verdict.incomingCount).toBe(2)
  // "Menyusut" adalah sinyal fold/kompaksi — dilaporkan apa adanya, bukan
  // disimpulkan lalu ditulis ulang.
  expect(verdict.detail).toContain("shrink")
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
  expect(assessHistoryPublication("e", [u("A"), a("B")], cwd).kind).toBe("IDENTICAL")
})

test("P3.1-F: klasifikasi read-only setara keputusan saveSession", async () => {
  const cwd = ws()
  await seed(cwd, "g", [u("A"), a("B")])
  const identical = assessHistoryPublication("g", [u("A"), a("B")], cwd)
  const append = assessHistoryPublication("g", [u("A"), a("B"), u("C")], cwd)
  const diverged = assessHistoryPublication("g", [u("A"), a("B2")], cwd)
  expect([identical.kind, append.kind, diverged.kind]).toEqual(["IDENTICAL", "APPEND", "DIVERGED"])
  expect(append.appendedCount).toBe(1)
  expect(diverged.firstDivergenceSeq).toBe(1)
  // Sesi tanpa histori = incoming apa pun adalah append murni (fresh).
  const fresh = assessHistoryPublication("belum-ada", [u("A")], cwd)
  expect([fresh.kind, fresh.storedCount, fresh.appendedCount]).toEqual(["APPEND", 0, 1])
})

// ── STEP 7: pemakaian ulang id sesi tidak boleh jadi reset implisit ──────────

test("P3.1-G: --session pada id BERHISTORI ditolak (fail-fast, bukan reset)", async () => {
  const cwd = ws()
  await seed(cwd, "lama", [u("A"), a("B")])
  expect(sessionHasHistory("lama", cwd)).toBe(true)

  const err = (() => {
    try {
      resolveSessionIdentity({ sessionFlag: "lama", cwd })
      return null
    } catch (e) {
      return e as SessionAttachRefusedError
    }
  })()
  expect(err).toBeInstanceOf(SessionAttachRefusedError)
  expect(err?.code).toBe("SESSION_ATTACH_REFUSED")
  // Pesan menyebut jalur eksplisit (bukan "not found"), jadi operator tak
  // menyimpulkan sesi hilang/harus direset.
  expect(err?.message).toContain("--resume lama")

  // Id baru = identitas fresh yang eksplisit; tetap boleh.
  expect(resolveSessionIdentity({ sessionFlag: "baru", cwd }).sid).toBe("baru")
  // --session + --resume pada id yang sama tetap jalur kontinuasi.
  expect(resolveSessionIdentity({ sessionFlag: "lama", resumeFlag: "lama", cwd }).sid).toBe("lama")
})

test("P3.1-G2: baris sesi TANPA histori bukan alasan menolak attach", async () => {
  const cwd = ws()
  // Baris materialisasi tanpa pesan (mis. run yang gagal sebelum persist).
  await saveSession("kosong", cwd, undefined, [], undefined)
  expect(sessionHasHistory("kosong", cwd)).toBe(false)
  expect(resolveSessionIdentity({ sessionFlag: "kosong", cwd }).resumed).toBe(false)
})

// ── Jalur produksi penuh: createCliSession → session.run → persistCurrent ───
//
// Divergensi di sini BUKAN disuntik lewat API privat: ia lahir dari kompaksi
// kernel yang nyata (STEP 6) — buffer RAM dilipat karena tekanan konteks,
// lalu publikasi diminta. Itu penyebab residual yang tetap hidup setelah
// guard attach menutup jalur `--session <id>` bekas.

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

test("P3.1-P1: buffer yang ter-fold kompaksi kernel DITOLAK di jalur persist nyata", async () => {
  const cwd = wsWithConfig()
  const sid = "guard"
  const seeded = bigHistory(20)
  await saveSession(sid, cwd, undefined, seeded, { turns: 20 })
  const canonicalBefore = fingerprint(cwd, sid)
  const provider = startFakeProvider([{ kind: "text", text: "balasan" }])
  // Kompaksi LLM TIDAK boleh ikut (butuh provider sungguhan); env pemilik repo
  // bisa saja punya key-nya — matikan selama test lalu pulihkan.
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
    // Precondition: kompaksi benar-benar terjadi (buffer menyusut tajam).
    expect(cli.session.state.history.length).toBeLessThan(10)
    expect(cli.session.state.history.length).toBeLessThan(seeded.length)

    await cli.persistCurrent({ totalTokens: 1 })

    // 1. Kanonik TIDAK berubah — nol shrink, nol rewrite (rantai lama mati).
    expect(fingerprint(cwd, sid)).toBe(canonicalBefore)
    expect(contents(cwd, sid)).toContain("z".repeat(2000))
    // 2. Kegagalan DILAPORKAN (mesin + manusia), bukan exit 0 diam.
    expect(cli.isReconciliationConflict()).toBe(true)
    expect(cli.reconciliationConflictNote()).toContain("RECONCILIATION_CONFLICT")
    expect(cli.reconciliationConflictNote()).toContain("shrink")
    expect(cli.isWriterStale()).toBe(false)
  } finally {
    await cli?.close()
    provider.close()
    if (priorKey !== undefined) process.env.DEEPSEEK_API_KEY = priorKey
  }

  // 3. Bukti durable lewat jalur diagnostik yang sudah ada.
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const events = db
      .prepare(
        "SELECT payload FROM presentation_events WHERE session_id = ? AND type = 'diagnostic.raised'",
      )
      .all(sid) as { payload: string }[]
    const diagnostics = events.map(
      (e) => JSON.parse(e.payload) as { category?: string; message?: string; action?: string },
    )
    const hit = diagnostics.find((d) => d.category === "RECONCILIATION_CONFLICT")
    expect(hit).toBeTruthy()
    expect(hit?.message).toContain("NOT published")
    expect(hit?.action).toBeTruthy()
  } finally {
    db.close()
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
    expect(cli.isReconciliationConflict()).toBe(false)
  } finally {
    provider.close()
    await cli.close()
  }
  // Turn nyata jadi baris kanonik baru — jalur append tetap hidup.
  expect(contents(cwd, sid)).toEqual(["A", "B", "D", "C"])
})

test("P3.1-P4: penulis lain menambah kanonik → DITOLAK, baris mereka tidak ditimpa", async () => {
  const cwd = wsWithConfig()
  const sid = "tetangga"
  await seed(cwd, sid, [u("A"), a("B")])
  const cli = await createCliSession(baseOpts(cwd, { resumeId: sid }))
  try {
    // Konteks runtime sudah basi: kanonik TUMBUH setelah buffer di-seed.
    await saveSession(sid, cwd, undefined, [u("A"), a("B"), u("C-dari-penulis-lain")], undefined)
    const before = fingerprint(cwd, sid)
    await cli.persistCurrent({ totalTokens: 1 })
    // Konteks basi tak boleh menyusutkan/menimpa baris yang tak dikenalinya.
    expect(fingerprint(cwd, sid)).toBe(before)
    expect(contents(cwd, sid)).toEqual(["A", "B", "C-dari-penulis-lain"])
    expect(cli.isReconciliationConflict()).toBe(true)
    expect(cli.isWriterStale()).toBe(false)
  } finally {
    await cli.close()
  }
})

test("P3.1-P5: epoch pindah (take-over) → STALE WRITER, bukan konflik rekonsiliasi", async () => {
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
    // Konteks runtime juga divergen (kanonik bertambah) — supaya gate P3.1
    // benar-benar dievaluasi dan urutannya diuji.
    await saveSession(sid, cwd, undefined, [u("A"), a("B"), u("C")], undefined)
    const before = fingerprint(cwd, sid)

    await cli.persistCurrent({ totalTokens: 1 })

    // P2.2 fence MENANG: kegagalan dilaporkan sebagai writer basi (bukan
    // konflik rekonsiliasi), dan kanonik tetap utuh.
    expect(cli.isWriterStale()).toBe(true)
    expect(cli.writerStaleNote()).toContain("epoch")
    expect(cli.isReconciliationConflict()).toBe(false)
    expect(fingerprint(cwd, sid)).toBe(before)
  } finally {
    await cli.close()
  }
})

// ── Probe proses nyata: CLI sebagai proses (bukan API in-process) ────────────
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

test("P3.1-P3: CLI nyata — reuse --session <id> berhistori ditolak sebelum belanja provider", async () => {
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
    const spent = provider.requestCount()

    // Run kedua pada id yang SAMA tanpa --resume: dulu ini menghancurkan
    // histori run pertama lewat shrink implisit. Kini ditolak fail-fast.
    const second = await run(ws, ["pertanyaan dua", "--session", "reuse-e2e", ...base])
    expect(second.code).toBe(1)
    expect(second.stderr).toContain("SESSION_ATTACH_REFUSED")
    expect(second.stderr).toContain("reuse-e2e")
    expect(contents(ws.dir, "reuse-e2e")).toEqual(["pertanyaan satu", "balasan-satu"])
    expect(provider.requestCount()).toBe(spent)

    // Jalur kontinuasi eksplisit tetap bekerja: append nyata, histori utuh.
    const third = await run(ws, ["pertanyaan tiga", "--resume", "reuse-e2e", ...base])
    expect(third.code).toBe(0)
    expect(third.stderr).toContain("resumed session reuse-e2e (2 messages)")
    expect(contents(ws.dir, "reuse-e2e")).toEqual([
      "pertanyaan satu",
      "balasan-satu",
      "pertanyaan tiga",
      "balasan-dua",
    ])
  } finally {
    provider.close()
  }
})
