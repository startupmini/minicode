// PROMPT 06 · Area A — isolasi state UI antar-instance.
//
// Yang dijaga (integration, bukan klaim):
// 1. DUA SESI PRODUKSI nyata hidup bersamaan dalam satu proses → masing-masing
//    punya `UiSessionState` sendiri; mengubah state sesi A tak mengubah B.
// 2. DUA logger linier nyata hidup bersamaan → buffer /copy, buffer /expand,
//    preferensi compact, dan visibility reasoning tak bocor antar-instance.
// 3. Buffer /copy bertahan lintas re-attach (pola produksi: `attachUI()` tiap
//    turn). Sebelumnya attach wiping buffer → `/copy [n]` untuk n>1 selalu
//    mengembalikan satu turn saja (regresi nyata, lihat TEST REGRESI).
// 4. Permukaan yang memakai state SESI tak pernah menyentuh instance default
//    modul (tak ada penulisan global tersembunyi).
//
// Bukti "dua instance" di sini bukan dua panggilan setter: dua sesi `createCliSession`
// nyata dan dua attachment `attachSimpleLogger`/`Transcript` nyata, hidup serempak.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliSession } from "../cli/setup.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import { defaultUiState, UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

const tmpRoots: string[] = []
const openSessions: { close: () => Promise<void> }[] = []

afterEach(async () => {
  for (const s of openSessions.splice(0)) {
    try {
      await s.close()
    } catch {}
  }
  for (const d of tmpRoots.splice(0)) {
    // Windows: handle SQLiteSometimes belum lepas saat close() selesai → EBUSY.
    // Best-effort: sisa temp tak boleh menggagalkan test.
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {}
  }
  // Instance default modul = fallback lama; test tak boleh meninggalkan jejak.
  defaultUiState.resetCopyBuffer()
  defaultUiState.setSectionMinimized("tool", false)
  defaultUiState.setSectionMinimized("answer", false)
  defaultUiState.setCompactMode(false)
  defaultUiState.setReasoningVisible(false)
  defaultUiState.clearCollapsedSections()
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "minicode-iso-"))
  tmpRoots.push(dir)
  mkdirSync(join(dir, ".minicode"), { recursive: true })
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

describe("Area A: dua sesi produksi nyata → state UI terisolasi", () => {
  test("dua createCliSession punya state berbeda; toggle A tak menyentuh B", async () => {
    const cwd = workspace()
    const a = await createCliSession(baseOpts(cwd, { sessionId: "iso-a" }))
    const b = await createCliSession(baseOpts(cwd, { sessionId: "iso-b" }))
    openSessions.push(a, b)

    // Dua instance nyata, dua objek state nyata.
    expect(a.uiState).toBeInstanceOf(UiSessionState)
    expect(b.uiState).toBeInstanceOf(UiSessionState)
    expect(a.uiState).not.toBe(b.uiState)

    // Defaults identik (bootstrap env sama) — yang berbeda adalah IDENTITAS.
    expect(a.uiState.sectionMinimized("tool")).toBe(b.uiState.sectionMinimized("tool"))

    // Nilai instance DEFAULT modul dicatat SEBELUM mutasi: suite lain boleh
    // saja sudah mengubahnya lewat API delegasi lama (jalur kompatibilitas),
    // jadi assertion absolut "selalu false" bergantung urutan file. Yang
    // dilarang adalah sesi ini menulis ke instance global.
    const defaultToolBefore = defaultUiState.sectionMinimized("tool")
    const defaultCompactBefore = defaultUiState.compact
    const defaultReasoningBefore = defaultUiState.reasoningVisible

    // Ubah state A (collapse + compact + reasoning).
    a.uiState.setSectionMinimized("tool", true)
    a.uiState.setSectionMinimized("answer", true)
    a.uiState.setCompactMode(true)
    a.uiState.setReasoningVisible(false)

    // B tak tersentuh.
    expect(b.uiState.sectionMinimized("tool")).toBe(false)
    expect(b.uiState.sectionMinimized("answer")).toBe(false)
    expect(b.uiState.compact).toBe(false)
    // Default reasoning kini TERLIHAT (true) — membalik toggle A ke false tak
    // boleh mengubah B yang masih memegang default-nya.
    expect(b.uiState.reasoningVisible).toBe(true)

    // Instance default modul juga tak tersentuh oleh penulisan sesi A/B.
    expect(defaultUiState.sectionMinimized("tool")).toBe(defaultToolBefore)
    expect(defaultUiState.compact).toBe(defaultCompactBefore)
    expect(defaultUiState.reasoningVisible).toBe(defaultReasoningBefore)

    // Dan perubahan di B tak sampai ke A.
    b.uiState.setCompactMode(true)
    expect(a.uiState.compact).toBe(true)
    b.uiState.setCompactMode(false)
    expect(a.uiState.compact).toBe(true)
  })
})

describe("Area A: dua logger linier + dua transcript nyata hidup bersamaan", () => {
  test("buffer /copy, buffer /expand, compact, dan reasoning tak bocor", () => {
    const stateA = new UiSessionState({ compact: false, reasoningVisible: true })
    const stateB = new UiSessionState({ compact: false, reasoningVisible: true })
    // Default singleton bisa saja sudah dimutasi suite lain (delegasi lama);
    // yang dilarang adalah penulisan sesi A/B menyentuhnya.
    const defaultReasoningBefore = defaultUiState.reasoningVisible

    const busA = createFakeBus()
    const busB = createFakeBus()
    const detachA = attachSimpleLogger(busA as never, { uiState: stateA, quiet: true })
    const detachB = attachSimpleLogger(busB as never, { uiState: stateB, quiet: true })
    const transcriptA = new Transcript(busA as never, { uiState: stateA })
    const transcriptB = new Transcript(busB as never, { uiState: stateB })

    try {
      //_bus A_ mengisi buffer miliknya; bus B diam.
      busA.emit("turn:started", { turn: 1 })
      busA.emit("provider:text", { text: "jawaban-A\n" })
      busB.emit("turn:started", { turn: 1 })
      busB.emit("provider:text", { text: "jawaban-B\n" })

      expect(stateA.getLastTurnText()).toContain("jawaban-A")
      expect(stateA.getLastTurnText()).not.toContain("jawaban-B")
      expect(stateB.getLastTurnText()).toContain("jawaban-B")
      expect(stateB.getLastTurnText()).not.toContain("jawaban-A")

      // Compact di A tak mengubah render B.
      stateA.setCompactMode(true)
      expect(stateA.compact).toBe(true)
      expect(stateB.compact).toBe(false)

      // Visibility reasoning di A tak mengubah transcript B.
      stateA.setReasoningVisible(false)
      expect(stateA.reasoningVisible).toBe(false)
      expect(stateB.reasoningVisible).toBe(true)

      // Buffer /expand milik A tak memuat isi B.
      stateA.rememberCollapsedSection("tool A", "isi-A")
      stateB.rememberCollapsedSection("tool B", "isi-B")
      const viewsA = stateA.collapsedSectionsSnapshot()
      expect(viewsA.some((v) => v.text.includes("isi-A"))).toBe(true)
      expect(viewsA.some((v) => v.text.includes("isi-B"))).toBe(false)

      // Tak ada satu pun yang menyentuh instance default modul.
      expect(defaultUiState.getLastTurnText()).toBe("")
      expect(defaultUiState.collapsedSectionsSnapshot()).toHaveLength(0)
      expect(defaultUiState.compact).toBe(false)
      expect(defaultUiState.reasoningVisible).toBe(defaultReasoningBefore)
    } finally {
      detachA()
      detachB()
      transcriptA.dispose()
      transcriptB.dispose()
    }
  })
})

describe("Area A: buffer /copy bertahan lintas re-attach (regresi /copy [n])", () => {
  test("attach ulang tiap turn tak menghapus riwayat turn sebelumnya", () => {
    // Pola produksi: `attachUI()` dipanggil tiap turn → detach + attach baru.
    const state = new UiSessionState()
    const bus = createFakeBus()

    const turn1 = attachSimpleLogger(bus as never, { uiState: state, quiet: true })
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:text", { text: "satu\n" })
    bus.emit("turn:completed", {})
    turn1()

    const turn2 = attachSimpleLogger(bus as never, { uiState: state, quiet: true })
    bus.emit("turn:started", { turn: 2 })
    bus.emit("provider:text", { text: "dua\n" })
    bus.emit("turn:completed", {})
    turn2()

    // arched: turn 1 diarsipkan saat turn 2 mulai.
    expect(state.getLastTurnTexts(2)).toEqual(["satu\n", "dua\n"])
    expect(state.getLastTurnTexts(1)).toEqual(["dua\n"])
  })

  test("re-attach tidak mengarsipkan turn yang belum selesai (tak ada turn palsu)", () => {
    const state = new UiSessionState()
    const bus = createFakeBus()
    const d1 = attachSimpleLogger(bus as never, { uiState: state, quiet: true })
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:text", { text: "satu\n" })
    d1()
    // Re-attach tanpa turn baru: isi turn berjalan TAK boleh jadi turn arsip.
    const d2 = attachSimpleLogger(bus as never, { uiState: state, quiet: true })
    expect(state.getLastTurnTexts(2)).toEqual(["satu\n"])
    expect(state.getLastTurnText()).toBe("satu\n")
    d2()
  })
})

describe("Area A: env hanya nilai awal, bukan media penyimpanan", () => {
  test("instance baru mewarisi env sebagai nilai awal; toggle tak menulis env", () => {
    const prev = process.env.MINICODE_MINIMIZE_TOOL
    process.env.MINICODE_MINIMIZE_TOOL = "1"
    try {
      const a = new UiSessionState()
      const b = new UiSessionState()
      expect(a.sectionMinimized("tool")).toBe(true)
      expect(b.sectionMinimized("tool")).toBe(true)
      a.setSectionMinimized("tool", false)
      expect(a.sectionMinimized("tool")).toBe(false)
      expect(b.sectionMinimized("tool")).toBe(true)
      expect(process.env.MINICODE_MINIMIZE_TOOL).toBe("1")
    } finally {
      if (prev === undefined) delete process.env.MINICODE_MINIMIZE_TOOL
      else process.env.MINICODE_MINIMIZE_TOOL = prev
    }
  })
})
