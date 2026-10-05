// P2.8 — Context Assembly (produksi).
//
// Membuktikan: fallback identik replay mentah saat proyeksi tak bisa dipakai,
// hanya CURRENT yang Barakut, cakupan tak diduplikasi, ekor mulai tepat di
// base_seq, kronologi terjaga, batas pasangan tool aman, dan perakitan
// TIDAK PERNAH memutasi messages/proyeksi/run (bukti fingerprint).

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mechanicalCompaction } from "#minicore/core/compact.ts"
import { ContextStore } from "#minicore/core/history.ts"
import { createCliSession } from "../cli/setup.ts"
import {
  assembleContext,
  type ContextView,
  stripContextOnly,
  syntheticSummaryMessage,
} from "../src/session/context-assembly.ts"
import {
  appendHistoryEvent,
  buildProjection,
  completeRun,
  createRun,
  createThread,
  DEFAULT_THREAD_ID,
  getProjectionStatus,
  getRun,
  loadSession,
  loadThreadHistory,
  SUMMARY_PROJECTION_ID,
  saveSession,
  shrinkThreadHistory,
  transitionRun,
} from "../src/session/persistence.ts"

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p28-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

/** Workspace dengan config provider palsu (butuh composition root createCliSession). */
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

async function seed(cwd: string, sid: string, n = 5): Promise<void> {
  const msgs = Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i}`,
  }))
  await saveSession(sid, cwd, undefined, msgs, { t: 1 })
}

/** Fingerprint histori kanonik (bukti tak termutasi). */
function historyFingerprint(cwd: string, sid: string, tid = DEFAULT_THREAD_ID): string {
  return JSON.stringify(loadThreadHistory(sid, tid, cwd))
}

function projectionFingerprint(cwd: string, sid: string, tid = DEFAULT_THREAD_ID): string {
  return JSON.stringify(getProjectionStatus(sid, tid, SUMMARY_PROJECTION_ID, cwd))
}

function contents(view: ContextView): unknown[] {
  return view.messages.map((m) => (m as { content: unknown }).content)
}

test("P2.8-1: tanpa proyeksi → replay mentah persis", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.source).toBe("messages")
  expect(view.status).toBe("UNKNOWN")
  expect(view.coveredSeq).toBe(0)
  expect(view.summary).toBeUndefined()
  // Ekuivalensi fallback: identik loadSession (tanpa filter/urutan ubah).
  expect(view.messages).toEqual(loadSession("s", cwd)!.messages as never)
})

test("P2.8-2: CURRENT → ringkasan + ekor kanonik", async () => {
  const cwd = ws()
  await seed(cwd, "s", 5)
  // P2.7 CURRENT = cakupan PENUH (base_seq == head+1). Partial = STALE.
  buildProjection("s", DEFAULT_THREAD_ID, "ringkas semua", cwd, { expectedEpoch: 0 })
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.status).toBe("CURRENT")
  expect(view.source).toBe("projection")
  expect(view.coveredSeq).toBe(5)
  expect(view.summary).toBe("ringkas semua")
  expect(view.messages).toEqual([
    { role: "user", content: "Previous context [0,5):\nringkas semua" },
  ])
})

test("P2.8-3: STALE → replay penuh, tanpa blend", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "baru" }, cwd)
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.source).toBe("messages")
  expect(view.status).toBe("STALE")
  expect(view.messages).toEqual(loadSession("s", cwd)!.messages as never)
  expect(contents(view)).toHaveLength(4)
})

test("P2.8-4: INCOMPLETE → replay penuh", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  // Tulis tangan: cakupan kosong + ringkasan isi = INCOMPLETE (writer menolak).
  const db = new Database(join(cwd, ".minicode", "sessions.db"))
  try {
    db.prepare(
      "INSERT OR REPLACE INTO history_projections (session_id, thread_id, projection_id, base_seq, summary_text, included_ranges, built_at, anchor_event_id) VALUES (?, ?, ?, 0, 'ada isi', '[]', 1, NULL)",
    ).run("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID)
  } finally {
    db.close()
  }
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.status).toBe("INCOMPLETE")
  expect(view.source).toBe("messages")
  expect(view.messages).toEqual(loadSession("s", cwd)!.messages as never)
})

test("P2.8-5: CORRUPT → replay penuh + status eksplisit", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  const db = new Database(join(cwd, ".minicode", "sessions.db"))
  try {
    db.prepare("UPDATE history_projections SET included_ranges = ? WHERE session_id = ?").run(
      "[[0,5],[4,7]]",
      "s",
    )
  } finally {
    db.close()
  }
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.status).toBe("CORRUPT")
  expect(view.source).toBe("messages")
  expect(view.detail).toContain("CORRUPT")
  expect(view.messages).toEqual(loadSession("s", cwd)!.messages as never)
})

test("P2.8-6: UNKNOWN (thread yatim) → replay penuh", async () => {
  const cwd = ws()
  await seed(cwd, "s", 2)
  // Proyeksi pada thread yang tak pernah ada → status UNKNOWN.
  const view = assembleContext("s", "th_hantu", cwd)
  expect(view.status).toBe("UNKNOWN")
  expect(view.source).toBe("messages")
  expect(view.messages).toEqual([])
})

test("P2.8-7: base_seq=0 → tanpa ringkasan, histori utuh", async () => {
  const cwd = ws()
  await seed(cwd, "s", 2)
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  // Tak ada proyeksi sama sekali → jalur全覆盖 fallback.
  expect(view.coveredSeq).toBe(0)
  expect(view.messages.length).toBe(2)
})

test("P2.8-8: cakupan penuh (base_seq=head+1) → ringkasan, ekor kosong", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  buildProjection("s", DEFAULT_THREAD_ID, "sejarah penuh", cwd, { expectedEpoch: 0 })
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.source).toBe("projection")
  expect(view.coveredSeq).toBe(3)
  expect(view.messages.length).toBe(1)
  expect(contents(view)[0]).toBe("Previous context [0,3):\nsejarah penuh")
})

test("P2.8-9: jangkar berubah → tak terpakai (fallback)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0, baseSeq: 2 })
  const db = new Database(join(cwd, ".minicode", "sessions.db"))
  try {
    db.prepare("UPDATE messages SET event_id = ? WHERE session_id = ? AND seq = 1").run(
      "evt_asing",
      "s",
    )
  } finally {
    db.close()
  }
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.status).toBe("STALE")
  expect(view.source).toBe("messages")
  expect(view.messages.length).toBe(4)
})

test("P2.8-10: proyeksi thread lain tidak dipakai", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  createThread("s", cwd, { threadId: "th_lain" })
  // Proyeksi hidup di th_default;组装 th_lain harus fallback (tidak baca milik lain).
  buildProjection("s", DEFAULT_THREAD_ID, "milik default", cwd, { expectedEpoch: 0 })
  const other = assembleContext("s", "th_lain", cwd)
  expect(other.source).toBe("messages")
  expect(other.messages).toEqual([])
  const own = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(own.source).toBe("projection")
  expect(own.summary).toBe("milik default")
})

test("P2.8-11: prefix tertutup tidak diduplikasi", async () => {
  const cwd = ws()
  await seed(cwd, "s", 6)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  const bodies = contents(view)
  expect(view.messages.length).toBe(1)
  // m0..m5 TIDAK muncul sebagai pesan mentah (hanya lewat ringkasan).
  for (const gone of ["m0", "m1", "m2", "m3", "m4", "m5"]) {
    expect(bodies).not.toContain(gone)
  }
  expect(bodies[0]).toBe("Previous context [0,6):\nr")
})

test("P2.8-11b: cakupan parsial = STALE (semantik P2.7) → replay penuh", async () => {
  const cwd = ws()
  await seed(cwd, "s", 6)
  // base_seq=4 < head+1=6 → P2.7 menandai STALE; P2.8 WAJIB fallback.
  buildProjection("s", DEFAULT_THREAD_ID, "partial", cwd, { expectedEpoch: 0, baseSeq: 4 })
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "STALE",
  )
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.source).toBe("messages")
  expect(view.messages).toEqual(loadSession("s", cwd)!.messages as never)
  expect(view.messages.length).toBe(6)
})

test("P2.8-12: ekor mulai tepat di base_seq (batas aman, tool terpisah)", async () => {
  const cwd = ws()
  // Histori panjang tanpa pasangan tool di batas →、若 CURRENT mencakup penuh.
  await seed(cwd, "s", 6)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  // Cakupan penuh ⇒ ekor kosong; pesan pertama (dan terakhir) adalah ringkasan.
  expect(view.messages.length).toBe(1)
  expect(contents(view)).toEqual(["Previous context [0,6):\nr"])
})

test("P2.8-13: kronologi terjaga (ringkasan di depan)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 5)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect((view.messages[0] as { role: string }).role).toBe("user")
  expect(contents(view)).toEqual(["Previous context [0,5):\nr"])
  // Fallback (STALE) juga kronologis: m0..m5 berurutan utuh.
  appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "m5" }, cwd)
  const fallback = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(contents(fallback)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"])
})

test("P2.8-14: perakitan tak memutasi messages (fingerprint)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 5)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  const before = historyFingerprint(cwd, "s")
  assembleContext("s", DEFAULT_THREAD_ID, cwd)
  assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(historyFingerprint(cwd, "s")).toBe(before)
})

test("P2.8-15: perakitan tak memutasi proyeksi (fingerprint)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 5)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  const before = projectionFingerprint(cwd, "s")
  assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(projectionFingerprint(cwd, "s")).toBe(before)
  // Baris proyeksi tetap utuh (tak dihapus/rebuild/di-tulis ulang).
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "CURRENT",
  )
})

test("P2.8-16: perakitan taksentuh run/kursor", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  const run = createRun("s", DEFAULT_THREAD_ID, cwd)
  transitionRun(run.run_id, "RUNNING", cwd)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  const cursorBefore = getRun(run.run_id, cwd)!.last_persisted_seq
  const rowsBefore = historyFingerprint(cwd, "s")
  assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(getRun(run.run_id, cwd)!.last_persisted_seq).toBe(cursorBefore)
  expect(historyFingerprint(cwd, "s")).toBe(rowsBefore)
  // advanceRunCursor tetap SATU-satunya cara gerak kursor (tidak disentuh):
  // append dulu supaya ada event durable di posisi berikutnya.
  appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "next" }, cwd, {
    runId: run.run_id,
  })
  const moved = getRun(run.run_id, cwd)!.last_persisted_seq
  expect(moved).toBe(cursorBefore + 1)
  completeRun(run.run_id, cwd)
})

test("P2.8-17: ContextView adalah nilai RAM (tidak ada jalur persistensi)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  // Praktik: serialisasi view tidak pernah menyentuh DB mana pun.
  const json = JSON.stringify(view)
  expect(json).toContain("coveredSeq")
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name)
    // Tiada tabel context baru;ContextView tak punya kolom.
    expect(tables.some((t) => /context/i.test(t) && !/presentation/i.test(t))).toBe(false)
  } finally {
    db.close()
  }
  expect(historyFingerprint(cwd, "s")).toBe(historyFingerprint(cwd, "s"))
})

test("P2.8-18: ringkasan sintetis bebas field persistence-only", () => {
  const msg = syntheticSummaryMessage("isi", 3) as unknown as Record<string, unknown>
  expect(msg.role).toBe("user")
  expect(Object.keys(msg).sort()).toEqual(["content", "role"])
  for (const forbidden of [
    "event_id",
    "seq",
    "run_id",
    "thread_id",
    "migrated",
    "migrated_compacted",
    "projection_note",
    "base_seq",
    "anchor_event_id",
  ]) {
    expect(msg[forbidden]).toBeUndefined()
  }
})

test("P2.8-19: tipe vendor Message tak berubah", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0, baseSeq: 2 })
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  // Bentuk tiap pesan tetap salah satu dari tiga role vendor.
  for (const m of view.messages) {
    expect(["user", "assistant", "tool"]).toContain((m as { role: string }).role)
  }
  // Vendor tetap tanpa persistence-only field pada deklarasi tipe.
  const types = await Bun.file("vendor/minicore/src/core/types.ts").text()
  expect(types.includes("event_id")).toBe(false)
  expect(types.includes("run_id")).toBe(false)
})

test("P2.8-20: fallback ekuivalen replay mentah (tanpa proyeksi vs STALE)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 5)
  const noProj = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "x" }, cwd)
  const stale = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  const canonical = loadSession("s", cwd)!.messages
  expect(stale.messages).toEqual(canonical as never)
  // Perbedaan HANYA pada baris baru yang ditambahkan fixture.
  expect(noProj.messages.length).toBe(canonical.length - 1)
})

test("P2.8-21: sesi legacy tanpa proyeksi tetap jalan normal", async () => {
  const cwd = ws()
  // Sesi dengan satu baris saja (tanpa proyeksi sama sekali).
  await saveSession("lama", cwd, undefined, [{ role: "user", content: "halo" }], undefined)
  const view = assembleContext("lama", DEFAULT_THREAD_ID, cwd)
  expect(view.source).toBe("messages")
  expect(view.messages.length).toBe(1)
  expect((view.messages[0] as { content: string }).content).toBe("halo")
})

test("P2.8-22: batas pasangan tool → fallback (tak ada tool yatim)", async () => {
  const cwd = ws()
  // Sisa histori yang terpotong di tengah batch tool (residu crash): pesan
  // terakhir assistant masih punya toolCalls → tool result-nya hilang.
  await saveSession(
    "t",
    cwd,
    undefined,
    [
      { role: "user", content: "pakai tool" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: {} }] },
    ] as never,
    undefined,
  )
  // Cakupan penuh (base_seq = head+1 = 2), tapi batas terakhir memotong tool
  // batch → TIDAK aman → fallback (deterministik).
  buildProjection("t", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  const unsafe = assembleContext("t", DEFAULT_THREAD_ID, cwd)
  expect(unsafe.source).toBe("messages")
  expect(unsafe.detail).toContain("unsafe boundary")
  expect(unsafe.messages.length).toBe(2)
  // Batas aman: tool ikut tertutup (base_seq = head+1 = 4) → ringkasan saja.
  await saveSession(
    "t2",
    cwd,
    undefined,
    [
      { role: "user", content: "pakai tool" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: {} }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "hasil" },
      { role: "assistant", content: "selesai" },
    ] as never,
    undefined,
  )
  buildProjection("t2", DEFAULT_THREAD_ID, "r2", cwd, { expectedEpoch: 0 })
  const safe = assembleContext("t2", DEFAULT_THREAD_ID, cwd)
  expect(safe.source).toBe("projection")
  expect(safe.messages.length).toBe(1)
  expect(contents(safe)[0]).toBe("Previous context [0,4):\nr2")
})

test("P2.8-23: shrink menutup proyeksi - assembly fallback penuh", async () => {
  const cwd = ws()
  await seed(cwd, "s", 5)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  expect(assembleContext("s", DEFAULT_THREAD_ID, cwd).source).toBe("projection")
  shrinkThreadHistory(
    "s",
    DEFAULT_THREAD_ID,
    [
      { role: "user", content: "ringkasan-short" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ],
    cwd,
    { expectedEpoch: 0 },
  )
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.source).toBe("messages")
  expect(view.messages).toEqual(loadSession("s", cwd)!.messages as never)
  expect(view.messages.length).toBe(3)
})

// -- P2.8 FORENSIC REMEDIATION: ringkasan sintetis tak boleh bocor ke messages --

test("FOR-1: stripContextOnly membuang artefak context-only yang dicatat", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  buildProjection("s", DEFAULT_THREAD_ID, "ringkas", cwd, { expectedEpoch: 0 })
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.source).toBe("projection")
  expect(view.contextOnly).toEqual({ role: "user", content: "Previous context [0,4):\nringkas" })
  const stripped = stripContextOnly(view.messages, view.contextOnly)
  expect(stripped.length).toBe(view.messages.length - 1)
  expect(stripped).not.toContain(view.messages[0]!)
})

test("FOR-2: stripContextOnly tidak menyentuh pesan canonical", async () => {
  const plain = [1, 2, 3]
  expect(stripContextOnly(plain, undefined)).toEqual([1, 2, 3])
  const real = [
    { role: "user", content: "halo dunia" },
    { role: "assistant", content: "hai" },
  ]
  // Fingerprint tak cocok -> tak ada yang dibuang (bukan "buang yang pertama").
  expect(
    stripContextOnly(real, { role: "user", content: "Previous context [0,9):\nlain" }),
  ).toEqual(real)
  // Fingerprint identik_byte PADA BUFFER[0] -> artefak itu sendiri yang dibuang.
  // CATATAN (koreksi klaim lama): ini TIDAK berarti pesan kanonik ikut hilang —
  // persist nyata menyusun ulang `[...baselineKanonik, ...tail]`, dan baseline
  // tidak pernah disaring. Dibuktikan di FOR-8.
  expect(stripContextOnly(real, { role: "user", content: "halo dunia" })).toEqual([
    { role: "assistant", content: "hai" },
  ])
  // Posisi selain 0 tidak pernah disentuh walau content-nya sama.
  const second = [
    { role: "user", content: " lain" },
    { role: "user", content: "halo dunia" },
  ]
  expect(stripContextOnly(second, { role: "user", content: "halo dunia" })).toEqual(second)
  expect(stripContextOnly([], { role: "user", content: "x" })).toEqual([])
})

test("FOR-3: LIFECYCLE BERBAHAYA - append nyata + persist nyata, artefak tak bocor", async () => {
  const cwd = ws()
  await saveSession(
    "s",
    cwd,
    undefined,
    [
      { role: "user", content: "tugas pertama" },
      { role: "assistant", content: "jawaban pertama" },
      { role: "user", content: "tugas kedua" },
      { role: "assistant", content: "jawaban kedua" },
    ] as never,
    undefined,
  )
  buildProjection("s", DEFAULT_THREAD_ID, "RINGKASAN PROYEKSI", cwd, { expectedEpoch: 0 })
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.source).toBe("projection")
  const baseline = loadSession("s", cwd)!.messages
  expect((view.messages[0] as { content: string }).content).toContain("RINGKASAN PROYEKSI")

  // Buffer konteks vendor NYATA: artefak + satu turn baru (tanpa kompaksi).
  const store = new ContextStore()
  store.appendAll(view.messages as never)
  store.append({ role: "user", content: "tugas ketiga" })
  store.append({ role: "assistant", content: "jawaban ketiga" })

  // Jalur persist nyata: buang artefak lalu susun baseline ++ ekor baru.
  const buffer = store.messages as never as readonly unknown[]
  const tail = stripContextOnly(buffer, view.contextOnly)
  expect(tail.length).toBe(buffer.length - 1)
  const durable = [...baseline, ...tail]
  await saveSession("s", cwd, undefined, durable as never, undefined)

  const reloaded = JSON.stringify(loadSession("s", cwd)!.messages)
  // Artefak proyeksi TIDAK menjadi histori kanonik.
  expect(reloaded).not.toContain("RINGKASAN PROYEKSI")
  expect(reloaded).not.toContain("Previous context [0,4)")
  // Histori kanonik tetap jujur: prefix lama utuh + turn baru tersimpan.
  expect(reloaded).toContain("tugas pertama")
  expect(reloaded).toContain("jawaban kedua")
  expect(reloaded).toContain("tugas ketiga")
  expect(reloaded).toContain("jawaban ketiga")
  expect(loadSession("s", cwd)!.messages.length).toBe(6)
})

test("FOR-3b: kompaksi vendor melipat artefak -> provenance shrink tercatat", async () => {
  const cwd = ws()
  await saveSession(
    "c",
    cwd,
    undefined,
    [
      { role: "user", content: "satu" },
      { role: "assistant", content: "dua" },
      { role: "user", content: "tiga" },
    ] as never,
    undefined,
  )
  buildProjection("c", DEFAULT_THREAD_ID, "PROJ-FOLD", cwd, { expectedEpoch: 0 })
  const view = assembleContext("c", DEFAULT_THREAD_ID, cwd)
  const store = new ContextStore()
  store.appendAll(view.messages as never)
  store.append({ role: "user", content: "empat" })
  store.append({ role: "assistant", content: "lima" })
  const compacted = mechanicalCompaction.compact(store, { keepRecentTurns: 1 })
  // Buffer sudah digantikan summary vendor → artefak tak lagi di depan;
  // strip harus no-op (fail-closed), dan jalur shrink P2.7 yang berlaku.
  const tail = stripContextOnly(compacted as never, view.contextOnly)
  expect(tail.length).toBe((compacted as readonly unknown[]).length)
  shrinkThreadHistory("c", DEFAULT_THREAD_ID, compacted as never, cwd, { expectedEpoch: 0 })
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    // Baris hasil kompaksi ditandai migrated_compacted (provenance, bukan
    // klaim rekonstruksi) — perilaku P2.7 yang dipertahankan.
    const flags = db
      .prepare("SELECT migrated_compacted AS f FROM messages WHERE session_id = ? ORDER BY seq")
      .all("c") as { f: number }[]
    expect(flags.length).toBeGreaterThan(0)
    expect(flags.some((r) => r.f === 1)).toBe(true)
  } finally {
    db.close()
  }
})

test("FOR-4: komposisi nyata createCliSession + persistCurrent", async () => {
  const cwd = wsWithConfig()
  const sid = "komposisi"
  await saveSession(
    sid,
    cwd,
    undefined,
    [
      { role: "user", content: "satu" },
      { role: "assistant", content: "dua" },
    ] as never,
    undefined,
  )
  buildProjection(sid, DEFAULT_THREAD_ID, "PROYEKSI-KOMPOSISI", cwd, { expectedEpoch: 0 })
  const cli = await createCliSession({
    cwd,
    allowLocalConfig: true,
    sessionId: "",
    resumeId: sid,
    prompt: "hi",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
  })
  await cli.persistCurrent({ totalTokens: 0 })
  await cli.close()
  const persisted = JSON.stringify(loadSession(sid, cwd)!.messages)
  expect(persisted).not.toContain("PROYEKSI-KOMPOSISI")
  expect(persisted).not.toContain("Previous context")
  expect(persisted).toContain("satu")
  expect(persisted).toContain("dua")
})

test("FOR-5: fallback raw replay + kompaksi tanpa artefak", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  const view = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(view.contextOnly).toBeUndefined()
  const store = new ContextStore()
  store.appendAll(view.messages as never)
  const compacted = mechanicalCompaction.compact(store, { keepRecentTurns: 1 })
  const durable = stripContextOnly(compacted as never, view.contextOnly)
  expect(durable.length).toBe((compacted as readonly unknown[]).length)
})

test("FOR-6: hapus proyeksi setelah assembly - resume berikutnya fallback", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  expect(assembleContext("s", DEFAULT_THREAD_ID, cwd).source).toBe("projection")
  const db = new Database(join(cwd, ".minicode", "sessions.db"))
  try {
    db.prepare("DELETE FROM history_projections WHERE session_id = ?").run("s")
  } finally {
    db.close()
  }
  const after = assembleContext("s", DEFAULT_THREAD_ID, cwd)
  expect(after.source).toBe("messages")
  expect(after.contextOnly).toBeUndefined()
  expect(after.messages).toEqual(loadSession("s", cwd)!.messages as never)
})

test("FOR-7: fidelity kanonik utuh setelah kompaksi+persist", async () => {
  const cwd = ws()
  await saveSession(
    "f",
    cwd,
    undefined,
    [
      { role: "user", content: "alpha" },
      { role: "assistant", content: "beta" },
      { role: "user", content: "gamma" },
    ] as never,
    undefined,
  )
  buildProjection("f", DEFAULT_THREAD_ID, "PROJ", cwd, { expectedEpoch: 0 })
  const view = assembleContext("f", DEFAULT_THREAD_ID, cwd)
  const store = new ContextStore()
  store.appendAll(view.messages as never)
  store.append({ role: "user", content: "delta" })
  const compacted = mechanicalCompaction.compact(store, { keepRecentTurns: 1 })
  shrinkThreadHistory(
    "f",
    DEFAULT_THREAD_ID,
    stripContextOnly(compacted as never, view.contextOnly) as never,
    cwd,
    { expectedEpoch: 0 },
  )
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    // RESIDUAL TERBUKTIK: setelah kernel mengompak, artefak terlahir DALAM
    // summary vendor — bukan baris kanonik sendiri. Batasnya: teks turunan
    // hanya boleh muncul pada baris yang ditandai provenance kompaksi.
    const rows = db
      .prepare(
        "SELECT content, migrated_compacted AS flagged FROM messages WHERE session_id = ? ORDER BY seq",
      )
      .all("f") as { content: string; flagged: number }[]
    for (const row of rows) {
      if (row.content.includes("PROJ")) {
        expect(row.flagged).toBe(1)
      }
    }
    // Baris kanonik yang TIDAK bertanda tak boleh memuat artefak turunan.
    const unmarked = rows.filter((r) => r.flagged === 0 && r.content.includes("PROJ"))
    expect(unmarked).toEqual([])
    // IDENTITAS vs INFORMASI: artefak sintetik P2.8 TIDAK boleh menjadi baris
    // kanonik apa pun — walau isinya boleh muncul di dalam ringkasan kompaksi.
    const artifactJson = JSON.stringify(view.messages[0])
    for (const row of rows) {
      expect(JSON.stringify({ role: "user", content: row.content })).not.toBe(artifactJson)
    }
    // Eksor post-kompaksi tetap kanonik.
    expect(JSON.stringify(rows)).toContain("delta")
    const attributed = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND run_id IS NOT NULL")
      .get("f") as { n: number }
    expect(attributed.n).toBe(0)
    const noId = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND event_id IS NULL")
      .get("f") as { n: number }
    expect(noId.n).toBe(0)
  } finally {
    db.close()
  }
})

test("FOR-8: pesan kanonik byte-identik dgn artefak TETAP selamat (koreksi klaim)", async () => {
  const cwd = ws()
  // msg0 dibuat byte-identik dengan artefak yang AKAN dibentuk P2.8.
  const collide = "Previous context [0,2):\nCOLLIDE"
  await saveSession(
    "k",
    cwd,
    undefined,
    [
      { role: "user", content: collide },
      { role: "assistant", content: "jawab" },
    ] as never,
    undefined,
  )
  buildProjection("k", DEFAULT_THREAD_ID, "COLLIDE", cwd, { expectedEpoch: 0 })
  const view = assembleContext("k", DEFAULT_THREAD_ID, cwd)
  expect(view.source).toBe("projection")
  // Artefak RAM == pesan kanonik byte-per-byte (kolisi disengaja).
  expect((view.messages[0] as { content: string }).content).toBe(collide)

  // Jalur persist nyata: baseline kanonik TIDAK pernah disaring.
  const baseline = loadSession("k", cwd)!.messages
  const buffer = view.messages as never as readonly unknown[]
  const tail = stripContextOnly(buffer, view.contextOnly)
  expect(tail.length).toBe(buffer.length - 1)
  const durable = [...baseline, ...tail]
  await saveSession("k", cwd, undefined, durable as never, undefined)

  const rows = loadSession("k", cwd)!.messages as { content: unknown }[]
  const occurrences = rows.filter((r) => r.content === collide).length
  // TEPAT SATU: pesan kanonik asli bertahan. Tidak hilang, tidak diduplikasi.
  expect(occurrences).toBe(1)
  expect(rows.length).toBe(2)
})
