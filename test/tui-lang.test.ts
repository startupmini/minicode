// Integrasi /lang end-to-end (driver cli/tui.ts + TuiApp + state.json):
// ketik "/lang id" → locale sesi berubah + tersimpan; sesi berikut baca.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliSession } from "../cli/setup.ts"
import { createCliSession } from "../cli/setup.ts"
import { runTui } from "../cli/tui.ts"
import { acquireSessionWriter } from "../src/session/authority.ts"
import { saveSession } from "../src/session/persistence.ts"
import { SESSION_LEASE_MS } from "../src/task/session-authority.ts"
import { resetTaskStoreHandles } from "../src/task/store.ts"
import { loadLang } from "../src/config.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import { currentLocale, resetLocaleState } from "../src/ui/i18n/locale.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"
import { startFakeProvider } from "./helpers/fake-provider.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
const tmpRoots: string[] = []
let prevHome: string | undefined
let prevLang: string | undefined

beforeEach(() => {
  resetLocaleState()
  prevHome = process.env.MINICODE_HOME
  prevLang = process.env.MINICODE_LANG
  delete process.env.MINICODE_LANG
  delete process.env.LANG
  delete process.env.LC_ALL
  const home = mkdtempSync(join(tmpdir(), "minicode-lang-"))
  tmpRoots.push(home)
  process.env.MINICODE_HOME = home
})

afterEach(() => {
  tty?.restore()
  tty = null
  resetLocaleState()
  if (prevHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = prevHome
  if (prevLang === undefined) delete process.env.MINICODE_LANG
  else process.env.MINICODE_LANG = prevLang
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true })
})

type FakeSession = CliSession & { bus: ReturnType<typeof createFakeBus> }

function fakeSession(): FakeSession {
  const bus = createFakeBus()
  const noop = async () => {}
  return {
    bus,
    session: { events: bus, contextTokens: 0 },
    cfg: { providers: [] },
    cwd: tmpdir(),
    sessionId: "lang-test",
    modelRef: {} as { current?: string },
    permissionMode: "auto",
    permissions: undefined,
    sessionTools: [],
    allLoadedSkills: [],
    allowLocalConfig: false,
    usage: {
      get: () => ({}),
      getSession: () => ({ cost: undefined, totalTokens: 0 }),
      reset: () => {},
    },
    budget: undefined,
    budgetStrict: false,
    persistCurrent: noop,
    runPromptWithVerify: noop,
    close: noop,
  } as unknown as FakeSession
}

describe("/lang end-to-end", () => {
  test("/lang id ganti locale sesi + simpan permanen", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession())
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    expect(currentLocale()).toBe("en")
    await tty.send("/lang id")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("lang: id"))
    expect(currentLocale()).toBe("id")
    expect(await loadLang()).toBe("id")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })
  test("/lang tanpa argumen tampilkan aktif; argumen asing ditolak", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession())
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("/lang")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("lang: en"))
    await tty.send("/lang xx")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("unknown lang"))
    expect(currentLocale()).toBe("en")
    expect(await loadLang()).toBeUndefined()
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })
  test("/copy 2 menyalin dua turn terakhir", async () => {
    const s = fakeSession()
    const detach = attachSimpleLogger(s.bus as never, { quiet: true })
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(s)
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    s.bus.emit("turn:started", { turn: 1 })
    s.bus.emit("provider:text", { text: "jawaban satu\n" })
    s.bus.emit("turn:completed", {})
    s.bus.emit("turn:started", { turn: 2 })
    s.bus.emit("provider:text", { text: "jawaban dua\n" })
    s.bus.emit("turn:completed", {})
    await tty.send("/copy 2")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("copied 2 turns"))
    expect(tty.all()).toContain("\x1b]52;c;")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
    detach()
  })

  test("/help ringkas memuat semua perintah terdaftar (satu sumber)", async () => {
    const { BUILTIN_COMMANDS } = await import("../cli/commands.ts")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession())
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("/help")
    await tty.send(KEY.enter)
    const out = await tty.waitForOutput((o) => o.includes("Commands:"))
    for (const b of BUILTIN_COMMANDS) expect(out, b.name).toContain(`/${b.name}`)
    for (const n of ["/mode", "/lang", "/compact", "/expand", "/minimize"])
      expect(out, n).toContain(n)
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })
})

describe("P03-B: TUI stale refusal", () => {
  /** Isi kanonik ter-decode (urutan seq) untuk satu sesi. */
  function contents(cwd: string, sid: string): unknown[] {
    const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
    try {
      const rs = db
        .prepare("SELECT content FROM messages WHERE session_id = ? ORDER BY seq")
        .all(sid) as { content: string }[]
      return rs.map((r) => {
        try {
          return JSON.parse(r.content)
        } catch {
          return r.content
        }
      })
    } finally {
      db.close()
    }
  }

  /**
   * Tunggu kondisi durable-state menjadi benar (polling berbatas, bukan sleep
   * buta): hasil deterministik — sukses iff kondisi tercapai sebelum timeout.
   */
  async function waitForState(
    label: string,
    check: () => boolean,
    timeoutMs = 15_000,
  ): Promise<void> {
    const t0 = Date.now()
    for (;;) {
      let ok = false
      try {
        ok = check()
      } catch {}
      if (ok) return
      if (Date.now() - t0 > timeoutMs) throw new Error(`P03-B: timeout menunggu ${label}`)
      await Bun.sleep(50)
    }
  }

  // P03-B — TUI: persist yang ditolak guard typed dilaporkan ke transkrip,
  // loop tetap hidup, turn berikut digagalkan gate pra-turn tanpa spend.
  //
  // Jalur produksi penuh: runTui nyata (fake TTY) + CliSession nyata +
  // provider HTTP tiruan. Turn 1 normal (persist sukses); penulis pesaing
  // take-over DI ANTARA dua turn (deterministik: turn 1 sudah durable,
  // terdeteksi via poll DB); turn 2 dilewati pagar pra-turn (E04) lalu
  // persistCurrent-nya tetap dipanggil → StaleWriterError typed → error
  // transkrip `[writer] …` (tui.ts:318-320). Sengaja TANPA notice
  // turn-level baru — itu keputusan owner terpisah (§13.3 matriks).
  test("persist ditolak → error transkrip, loop lanjut, turn berikut nol spend", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minicode-p03b-"))
    // BUKAN tmpRoots bersama: handle sqlite Windows (GC bun:sqlite + peta
    // TaskStore) membuat rmSync afterEach gagal EBUSY — bersihkan sendiri
    // dengan pola retry p3-reconciliation-guard di finally di bawah.
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    const sid = "p03b"
    await saveSession(
      sid,
      cwd,
      undefined,
      [
        { role: "user", content: "A" },
        { role: "assistant", content: "B" },
      ],
      { t: 1 },
    )
    const provider = startFakeProvider([{ kind: "text", text: "jawaban-satu" }])
    writeFileSync(
      join(cwd, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["m"] }],
      }),
      "utf8",
    )
    const cli = await createCliSession({
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
      resumeId: sid,
    })
    let runP: Promise<void> | null = null
    try {
      tty = installFakeTty({ columns: 80, rows: 24 })
      runP = runTui(cli)
      await tty.ready()
      // Startup sesi nyata (komposisi scheduler + resume) lebih lambat dari
      // fixture palsu — batas eksplisit, bukan sleep buta.
      await tty.waitForOutput((o) => o.includes("00.00.00"), 20_000)
      // Turn 1 normal: provider spend tepat sekali, lalu persist sukses.
      await tty.send("pertanyaan satu")
      await tty.send(KEY.enter)
      await tty.waitForOutput((o) => o.includes("jawaban-satu"), 20_000)
      expect(provider.requestCount()).toBe(1)
      await waitForState("turn 1 durable", () =>
        contents(cwd, sid).includes("jawaban-satu"),
      )
      // Pesaing take-over di antara turn (epoch 0→1; baris pesan tak tersentuh).
      const other = acquireSessionWriter({
        sessionId: sid,
        cwd,
        bootId: "penulis-asing",
        now: Date.now() + SESSION_LEASE_MS + 1_000,
      })
      expect(other.ok).toBe(true)
      // Turn 2: gate pra-turn menolak (nol spend) → persistCurrent tetap jalan
      // → StaleWriterError → error transkrip; TUI tetap operasional.
      // Submit bisa hilang bila TUI masih finalisasi turn 1 (input belum
      // fokus) — kirim ulang berbatas hingga `[writer]` teramati. Hasil
      // deterministik: muncul = turn tersubmit + ditolak; gagal total =
      // error keras, bukan pass diam. Submit ganda pun aman (skip idempoten,
      // spend tetap nol).
      await Bun.sleep(500)
      let out = ""
      for (let attempt = 0; attempt < 3 && !out.includes("[writer]"); attempt++) {
        await tty.send("pertanyaan dua")
        await tty.send(KEY.enter)
        try {
          out = await tty.waitForOutput((o) => o.includes("[writer]"), 8000)
        } catch {}
      }
      expect(out).toContain("[writer]")
      expect(out).toContain("pre-turn epoch mismatch")
      expect(cli.isWriterStale()).toBe(true)
      // Nol spend tambahan: gate menghentikan turn 2 sebelum provider.
      expect(provider.requestCount()).toBe(1)
      // Kanonik utuh: seed + turn 1; turn yang ditolak tak meninggalkan apa pun.
      expect(contents(cwd, sid)).toEqual(["A", "B", "pertanyaan satu", "jawaban-satu"])
      await tty.send("/exit")
      await tty.send(KEY.enter)
      await runP
      runP = null
    } finally {
      // Best-effort: jangan gantung runTui bila expect di atas gagal duluan.
      if (runP !== null && tty !== null) {
        try {
          await tty.send("/exit")
          await tty.send(KEY.enter)
          await runP
        } catch {}
      }
      provider.close()
      await cli.close()
      try {
        resetTaskStoreHandles()
      } catch {}
      for (let i = 0; i < 10; i++) {
        try {
          rmSync(cwd, { recursive: true, force: true })
          break
        } catch {
          try {
            resetTaskStoreHandles()
          } catch {}
          Bun.gc(true)
          await Bun.sleep(50)
        }
      }
    }
  }, 60_000)
})
