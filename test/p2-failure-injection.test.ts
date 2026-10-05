// P2.0 — Scaffold failure-injection + lintas-proses deterministik
// (FAILURE-INJECTION). Test-side saja: registry simbolik + interleave
// barrier; tanpa hook produksi (hook aktif milik P2.13/P2.14).

import { expect, test } from "bun:test"
import { P2_CLASS, P2_FAIL_POINTS, p2Barrier, p2EpochStore } from "./helpers/p2.ts"

test(`[${P2_CLASS.FAILURE_INJECTION}] registry titik simbolik lengkap 11 titik`, () => {
  expect(P2_FAIL_POINTS).toHaveLength(11)
  expect(new Set(P2_FAIL_POINTS).size).toBe(11)
  for (const name of [
    "FAIL_AFTER_TOOL_INTENT",
    "FAIL_BEFORE_TOOL_RESULT_PERSIST",
    "FAIL_BETWEEN_RAM_AND_DURABLE_COMMIT",
  ]) {
    expect(P2_FAIL_POINTS as readonly string[]).toContain(name)
  }
  // Expected After P2.14: setiap nama terikat ke hook env-gated
  // MINICODE_FAIL_AT yang terdokumentasi; daftar ini adalah kontraknya.
})

test(`[${P2_CLASS.FAILURE_INJECTION}] tak ada hook produksi aktif pra-P2 (fail-closed scaffolding)`, async () => {
  // Jaminan fase P2.0: menyebut nama titik TIDAK mengubah perilaku produksi.
  // saveSession normal tetap utuh tanpa env apa pun.
  const { p2Cleanup, p2Cwd, p2Id, p2Msgs } = await import("./helpers/p2.ts")
  const { loadSession, saveSession } = await import("../src/session/persistence.ts")
  const cwd = p2Cwd("mc-p2fi")
  try {
    const id = p2Id("sess")
    await saveSession(id, cwd, undefined, p2Msgs(2, "fi"), { turns: 1 })
    expect(loadSession(id, cwd)!.messages.length).toBe(2)
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.FAILURE_INJECTION}] lintas-proses: A jeda → B takeover → A commit ditolak`, async () => {
  const store = p2EpochStore()
  const gate = p2Barrier()
  const epochA = store.epoch()
  let epochB = -1
  const procB = (async () => {
    await gate.wait() // B menunggu hingga A "mati" di titik injeksi.
    epochB = store.takeover("B-after-A-stall")
  })()
  gate.releaseAll()
  await procB
  expect(epochB).toBe(epochA + 1)
  expect(store.mutate(epochA)).toEqual({ ok: false, reason: "REFUSED_STALE_EPOCH" })
  expect(store.mutate(epochB)).toEqual({ ok: true })
  // Expected After P2.14: pola barrier ini dipakai ulang dengan
  // MINICODE_FAIL_AT sungguhan + dua handle DB nyata (tanpa sleep).
})

test(`[${P2_CLASS.FAILURE_INJECTION}] alias contention mengikuti fence yang sama`, () => {
  // Kontrak R4: alias → kanonik → cek lease → CAS epoch. Alias bukan jalur
  // pintas: penulis via alias memakai epoch yang sama.
  const store = p2EpochStore()
  const epochAliasReader = store.epoch()
  store.takeover("canonical-writer")
  expect(store.mutate(epochAliasReader)).toEqual({ ok: false, reason: "REFUSED_STALE_EPOCH" })
})
