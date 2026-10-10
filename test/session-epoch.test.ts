// P2.2 — Pagar penulis epoch + takeover (produksi, deterministik).
//
// Lease = admission (tasks.db), epoch = pagar mutasi (sessions.db, CAS
// in-txn). Waktu disuntik via `now` (tanpa sleep), takeover diuji termasuk
// simultan, basi, dan idempoten. Tanpa flaky timing.

import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliSession } from "../cli/setup.ts"
import type { DomainEvent } from "../src/presentation/events.ts"
import {
  acquireSessionWriter,
  checkWriterFresh,
  releaseSessionWriter,
  renewSessionWriter,
  StaleWriterError,
} from "../src/session/authority.ts"
import {
  appendPresentationEvents,
  branchSession,
  deleteSession,
  listSessionTakeovers,
  loadPresentationEvents,
  loadSession,
  readWriterEpoch,
  saveSession,
  takeoverSessionEpoch,
} from "../src/session/persistence.ts"
import { TaskStore } from "../src/task/store.ts"
import { SESSION_LEASE_MS } from "../src/task/session-authority.ts"
import { startFakeProvider } from "./helpers/fake-provider.ts"

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p22-"))
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

function ev(over: Record<string, unknown>): DomainEvent {
  return {
    type: "user.message",
    eventSeq: 1,
    ts: 1000,
    sessionId: "s",
    turnId: 1,
    text: "halo",
    promptRef: "p",
    ...over,
  } as DomainEvent
}

const T0 = 1_700_000_000_000
const LEASE = 300_000

test("P2.2: epoch awal 0, save biasa tak memajukan, restart mempertahankannya", async () => {
  const cwd = ws()
  expect(readWriterEpoch("e1", cwd)).toBe(0)
  await saveSession("e1", cwd, undefined, [{ role: "user", content: "a" }], { t: 1 })
  expect(readWriterEpoch("e1", cwd)).toBe(0)
  await saveSession("e1", cwd, undefined, [{ role: "user", content: "a" }], { t: 1 })
  expect(readWriterEpoch("e1", cwd)).toBe(0)
  // Fenced save dengan ekspektasi benar juga tak memajukan.
  await saveSession(
    "e1",
    cwd,
    undefined,
    [{ role: "user", content: "a" }],
    { t: 1 },
    { expectedEpoch: 0 },
  )
  expect(readWriterEpoch("e1", cwd)).toBe(0)
})

test("P2.2: skenario kanonik §8 — A basi ditolak, B sukses, tanpa last-writer-wins", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [{ role: "user", content: "awal" }], { t: 1 })
  // A admission di T0.
  const a = acquireSessionWriter({ sessionId: "s", cwd, bootId: "bootA", now: T0 })
  expect(a.ok).toBe(true)
  if (!a.ok) throw new Error("admission A gagal")
  expect(a.admission.epoch).toBe(0)
  // B terlalu dini → ditolak lease (Failure B).
  const tooEarly = acquireSessionWriter({ sessionId: "s", cwd, bootId: "bootB", now: T0 + 1000 })
  expect(tooEarly.ok).toBe(false)
  // B setelah expiry → takeover + bump 0→1.
  const b = acquireSessionWriter({ sessionId: "s", cwd, bootId: "bootB", now: T0 + LEASE + 1 })
  expect(b.ok).toBe(true)
  if (!b.ok) throw new Error("takeover B gagal")
  expect(b.admission.tookOver).toBe(true)
  expect(b.admission.epoch).toBe(1)
  expect(readWriterEpoch("s", cwd)).toBe(1)
  expect(listSessionTakeovers("s", cwd).length).toBe(1)
  // A menulis dengan epoch 5→0 basi: DITOLAK + tanpa tulis parsial.
  await expect(
    saveSession(
      "s",
      cwd,
      undefined,
      [{ role: "user", content: "jahat-A" }],
      { t: 2 },
      { expectedEpoch: 0 },
    ),
  ).rejects.toThrow(StaleWriterError)
  expect(loadSession("s", cwd)!.messages.length).toBe(1)
  expect(String((loadSession("s", cwd)!.messages[0] as { content: unknown }).content)).toContain(
    "awal",
  )
  // B menulis dengan epoch 1: SUKSES.
  await saveSession(
    "s",
    cwd,
    undefined,
    [
      { role: "user", content: "awal" },
      { role: "user", content: "milik-B" },
    ],
    { t: 2 },
    { expectedEpoch: 1 },
  )
  expect(loadSession("s", cwd)!.messages.length).toBe(2)
})

test("P2.2: takeover idempoten — replay prior sama tak menaikkan lagi (Failure D)", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [], undefined)
  expect(takeoverSessionEpoch("s", 0, "uji", "bootB", cwd)).toEqual({
    outcome: "advanced",
    epoch: 1,
  })
  expect(takeoverSessionEpoch("s", 0, "uji", "bootB", cwd)).toEqual({
    outcome: "already-applied",
    epoch: 1,
  })
  expect(readWriterEpoch("s", cwd)).toBe(1)
  expect(listSessionTakeovers("s", cwd).length).toBe(1)
})

test("P2.2: takeover simultan — tepat satu pemenang (UNIQUE, bukan Date.now)", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [], undefined)
  // Dua contender melihat prior 0 yang sama; satu menang, satu mengamati.
  const first = takeoverSessionEpoch("s", 0, "B", "bootB", cwd)
  const second = takeoverSessionEpoch("s", 0, "C", "bootC", cwd)
  const outcomes = [first.outcome, second.outcome].sort()
  expect(outcomes).toEqual(["advanced", "already-applied"])
  expect(readWriterEpoch("s", cwd)).toBe(1)
})

test("P2.2: rantai takeover monoton — crash B lalu C: 6,7 tanpa reuse (Failure C)", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [], undefined)
  const t0 = T0
  const a = acquireSessionWriter({ sessionId: "s", cwd, bootId: "bootA", now: t0 })
  if (!a.ok) throw new Error("A gagal")
  const b = acquireSessionWriter({ sessionId: "s", cwd, bootId: "bootB", now: t0 + LEASE + 1 })
  if (!b.ok) throw new Error("B gagal")
  expect(b.admission.epoch).toBe(1)
  // B crash (tanpa release) → C mengambil alih setelah lease B lapse.
  const c = acquireSessionWriter({
    sessionId: "s",
    cwd,
    bootId: "bootC",
    now: t0 + 2 * (LEASE + 1),
  })
  if (!c.ok) throw new Error("C gagal")
  expect(c.admission.tookOver).toBe(true)
  expect(c.admission.epoch).toBe(2)
  expect(listSessionTakeovers("s", cwd).map((r) => r.new_epoch)).toEqual([1, 2])
})

test("P2.2: renew tak memajukan epoch; re-acquire token sendiri tak bump", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [], undefined)
  const a = acquireSessionWriter({ sessionId: "s", cwd, bootId: "bootA", now: T0 })
  if (!a.ok) throw new Error("A gagal")
  expect(renewSessionWriter("s", a.admission.token, cwd, T0 + 1000)).toBe("AUTHORITY_HELD")
  expect(readWriterEpoch("s", cwd)).toBe(0)
  // Re-acquire token sendiri setelah lapse: fresh, tanpa bump.
  const again = acquireSessionWriter({
    sessionId: "s",
    cwd,
    bootId: "bootA",
    token: a.admission.token,
    now: T0 + LEASE + 5000,
  })
  expect(again.ok).toBe(true)
  if (!again.ok) throw new Error("re-acquire gagal")
  expect(again.admission.epoch).toBe(0)
  expect(again.admission.tookOver).toBe(false)
})

test("P2.2: baris absen + ekspektasi > 0 → basi (dunia bergerak)", async () => {
  const cwd = ws()
  await expect(
    saveSession(
      "hantu",
      cwd,
      undefined,
      [{ role: "user", content: "x" }],
      { t: 1 },
      { expectedEpoch: 3 },
    ),
  ).rejects.toThrow(StaleWriterError)
  expect(loadSession("hantu", cwd)).toBeNull()
})

test("P2.2: presentation append berpagar — basi ditolak", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [], undefined)
  await appendPresentationEvents("s", cwd, [ev({ sessionId: "s" })], { expectedEpoch: 0 })
  expect(loadPresentationEvents("s", cwd).length).toBe(1)
  expect(takeoverSessionEpoch("s", 0, "uji", "bootB", cwd).outcome).toBe("advanced")
  await expect(
    appendPresentationEvents("s", cwd, [ev({ sessionId: "s", eventSeq: 2 })], { expectedEpoch: 0 }),
  ).rejects.toThrow(StaleWriterError)
  expect(loadPresentationEvents("s", cwd).length).toBe(1)
})

test("P2.2: checkWriterFresh — cocok+renew vs mismatch vs lost", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [], undefined)
  const a = acquireSessionWriter({ sessionId: "s", cwd, bootId: "bootA", now: T0 })
  if (!a.ok) throw new Error("A gagal")
  expect(checkWriterFresh("s", a.admission.token, 0, cwd, T0 + 10)).toEqual({
    fresh: true,
    epoch: 0,
    renewed: true,
  })
  expect(takeoverSessionEpoch("s", 0, "uji", "bootB", cwd).outcome).toBe("advanced")
  const stale = checkWriterFresh("s", a.admission.token, 0, cwd, T0 + 20)
  expect(stale.fresh).toBe(false)
  expect(stale.epoch).toBe(1)
})

test("P2.2: cabang mulai epoch 0 (garis otoritas baru)", async () => {
  const cwd = ws()
  await saveSession("induk", cwd, undefined, [{ role: "user", content: "h" }], { t: 1 })
  expect(takeoverSessionEpoch("induk", 0, "uji", "bootB", cwd).outcome).toBe("advanced")
  expect(readWriterEpoch("induk", cwd)).toBe(1)
  await branchSession("induk", "anak", cwd)
  expect(readWriterEpoch("anak", cwd)).toBe(0)
  expect(listSessionTakeovers("anak", cwd).length).toBe(0)
})

test("P2.2: delete/recreate — epoch restart 0, inkarnasi tetap bump (sumbu berbeda)", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [], undefined)
  expect(takeoverSessionEpoch("s", 0, "uji", "bootB", cwd).outcome).toBe("advanced")
  const store = new TaskStore(cwd)
  const incBefore = store.getSessionIncarnation("s")
  await deleteSession("s", cwd)
  expect(listSessionTakeovers("s", cwd).length).toBe(0)
  await saveSession("s", cwd, undefined, [], undefined)
  expect(readWriterEpoch("s", cwd)).toBe(0)
  expect(store.getSessionIncarnation("s")).toBe(incBefore + 1)
})

test("P2.2: komposisi — penulis kedua konkuren DITOLAK; sekuensial setelah close OK", async () => {
  const cwd = ws()
  const first = await createCliSession(baseOpts(cwd, { sessionId: "duel" }))
  expect(first.writerEpoch).toBe(0)
  expect(first.isWriterStale()).toBe(false)
  await expect(createCliSession(baseOpts(cwd, { sessionId: "duel" }))).rejects.toThrow(
    /actively owned by another writer/,
  )
  await first.close()
  const second = await createCliSession(baseOpts(cwd, { sessionId: "duel" }))
  expect(second.sessionId).toBe("duel")
  await second.persistCurrent({ totalTokens: 1 })
  await second.close()
})

test("P2.2: alias memakai pagar yang sama (tanpa namespace epoch sendiri)", async () => {
  const cwd = ws()
  const c = await createCliSession(baseOpts(cwd, { sessionId: "kanon" }))
  await c.persistCurrent({ totalTokens: 1 })
  await c.close()
  // Resolve via alias mentah → sid kanonik → admission membaca epoch sama.
  const { resolveSessionIdentity } = await import("../src/session/identity.ts")
  const { tryRecordSessionAlias } = await import("../src/session/persistence.ts")
  expect(tryRecordSessionAlias("sebutan", "sebutan", "kanon", "uji", cwd)).toEqual({
    ok: true,
    created: true,
  })
  const id = resolveSessionIdentity({ resumeFlag: "sebutan", cwd, bootId: "bootZ" })
  expect(id.sid).toBe("kanon")
  const adm = acquireSessionWriter({ sessionId: id.sid, cwd, bootId: "bootZ" })
  expect(adm.ok).toBe(true)
  if (!adm.ok) throw new Error("admission alias gagal")
  expect(adm.admission.epoch).toBe(readWriterEpoch("kanon", cwd))
  expect(releaseSessionWriter("kanon", adm.admission.token, cwd)).toBe(true)
})

/** Tulis ulang config provider palsu ke baseUrl server tiruan yang hidup. */
function pointConfigAt(cwd: string, baseUrl: string): void {
  writeFileSync(
    join(cwd, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl, apiKey: "sk-test", models: ["m"] }],
    }),
    "utf8",
  )
}

/** Isi kanonik ter-decode (urutan seq) untuk satu sesi. */
function messageContents(cwd: string, sid: string): unknown[] {
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

/** Jumlah baris Run durable untuk satu sesi (bukti ada/tidaknya Run baru). */
function countRuns(cwd: string, sid: string): number {
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE session_id = ?").get(sid) as {
      n: number
    }
    return row.n
  } finally {
    db.close()
  }
}

// P4-E04 — pagar pra-turn menolak penulis basi SEBELUM provider dibelanjakan.
// Jalur produksi penuh: runPromptWithVerify (bukan ensureWriterFresh saja).
// Kontrak: nol request provider, tanpa Run baru, histori kernel utuh, dan
// penolakan dilaporkan jujur lewat flag basi (bukan sukses diam-diam). Sengaja
// TIDAK menuntut notice turn-level baru — itu keputusan owner terpisah.
test("P4-E04: turn basi ditolak pra-provider — nol spend, tanpa run baru", async () => {
  const cwd = ws()
  const sid = "e04-basi"
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
  const provider = startFakeProvider([{ kind: "text", text: "TAK-BOLEH-MUNCUL" }])
  pointConfigAt(cwd, provider.baseUrl)
  const cli = await createCliSession(baseOpts(cwd, { resumeId: sid }))
  const historyBefore = cli.session.state.history.length
  const runsBefore = countRuns(cwd, sid)
  try {
    expect(cli.writerEpoch).toBe(0)
    // Penulis asing take-over setelah lease kedaluwarsa → epoch pindah 0→1.
    const other = acquireSessionWriter({
      sessionId: sid,
      cwd,
      bootId: "penulis-asing",
      now: Date.now() + SESSION_LEASE_MS + 1_000,
    })
    expect(other.ok).toBe(true)
    // Act: turn yang wajib ditolak pagar pra-turn (tak melempar — aman loop TUI).
    await cli.runPromptWithVerify("turn basi — harus ditolak sebelum provider")
    // Penolakan jujur: flag basi + alasan pra-turn, bukan sukses diam-diam.
    expect(cli.isWriterStale()).toBe(true)
    expect(cli.writerStaleNote()).toContain("pre-turn epoch mismatch")
    expect(cli.writerEpoch).toBe(0)
    // Provider NOL spend: tak satu pun request /chat/completions masuk.
    expect(provider.requestCount()).toBe(0)
    // Tanpa Run baru untuk turn yang ditolak.
    expect(countRuns(cwd, sid)).toBe(runsBefore)
    // Histori kernel utuh (turn tak pernah mencapai loop).
    expect(cli.session.state.history.length).toBe(historyBefore)
  } finally {
    provider.close()
    await cli.close()
  }
})

// P03-A — one-shot: persist yang ditolak guard typed (StaleWriterError)
// dilaporkan jujur di ekor one-shot, kanonik utuh, tanpa retry buta.
//
// Jalur: turn nyata (satu spend) → penulis pesaing take-over → persistCurrent
// nyata (StaleWriterError → flag basi) → ekor one-shot cli/index.ts:539-543
// (basi → throw `[writer] stale writer, history NOT durable`, lalu catch
// :581-617 menutup sesi dengan process.exit(1)). Ekor 5 baris itu
// direplikasi persis di sini karena cli/index.ts adalah skrip top-level
// (process.exit) yang tak bisa diimpor; pemetaan throw→exit(1) generik sudah
// dibuktikan spawn (mis. cli-session.test.ts:982 tanpa-provider, :344 budget).
test("P03-A: one-shot — persist ditolak jujur, kanonik utuh, tanpa retry buta", async () => {
  const cwd = ws()
  const sid = "p03a-oneshot"
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
  const provider = startFakeProvider([{ kind: "text", text: "C" }])
  pointConfigAt(cwd, provider.baseUrl)
  const cli = await createCliSession(baseOpts(cwd, { resumeId: sid }))
  try {
    // Turn berjalan normal: tepat satu spend provider.
    await cli.runPromptWithVerify("D")
    expect(provider.requestCount()).toBe(1)
    // Penulis pesaing take-over di antara turn dan persist (epoch 0→1).
    const other = acquireSessionWriter({
      sessionId: sid,
      cwd,
      bootId: "penulis-asing",
      now: Date.now() + SESSION_LEASE_MS + 1_000,
    })
    expect(other.ok).toBe(true)
    // Persist nyata → StaleWriterError typed → flag basi (persistCurrent).
    // Catatan: pagar presentation-flush (setup.ts:1119-1129) menyala DULUAN
    // (sebelum saveSession:922) — keduanya berpagar epoch yang sama, tak ada
    // tulisan dalam kedua jalur. Note pertama menang (markWriterStale once).
    const u = cli.usage.getSession(cli.modelRef.current)
    await cli.persistCurrent(u)
    expect(cli.isWriterStale()).toBe(true)
    expect(cli.writerStaleNote()).toMatch(/refused \(expected epoch 0/)
    // Ekor one-shot (index.ts:541-543, kutipan persis): basi → throw jujur.
    const oneShotTail = () => {
      if (cli.isWriterStale()) {
        throw new Error(`[writer] stale writer, history NOT durable: ${cli.writerStaleNote()}`)
      }
    }
    expect(oneShotTail).toThrow(/history NOT durable/)
    expect(oneShotTail).toThrow(/expected epoch 0/)
    // Kanonik UTUH dan JUJUR: seed utuh, turn yang ditolak TAK MUNCUL di
    // durable history (attempted turn ≠ durable publication). "D"/"C" hanya
    // hidup di buffer RAM kernel — bukan korupsi, melainkan permukaan
    // resume/retry; take-over tak menyentuh baris pesan.
    expect(messageContents(cwd, sid)).toEqual(["A", "B"])
    // Tanpa retry buta: tak ada spend tambahan, tak ada run kedua.
    expect(provider.requestCount()).toBe(1)
    expect(countRuns(cwd, sid)).toBe(1)
  } finally {
    provider.close()
    await cli.close()
  }
})
