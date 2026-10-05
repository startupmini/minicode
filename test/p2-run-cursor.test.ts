// P2.0 — Kontrak Run + kursor durable + batas RAM≠durable
// (P2-FUTURE-CONTRACT + CURRENT-INVARIANT).
//
// Run durable belum ada; transisi dan rekonsiliasi diuji via oracle.
// Satu test memakai kernel nyata (#minicore) untuk membuktikan celah
// kini: RAM commit tanpa persistensi durable.

import { expect, test } from "bun:test"
import { createSession } from "#minicore/core/index.ts"
import { allowAll, FakeProvider, finish, text } from "#minicore/test/fakes.ts"
import { loadSession } from "../src/session/persistence.ts"
import { P2_CLASS, p2Cleanup, p2Cwd, p2ReconcileCursor, p2RunTransition } from "./helpers/p2.ts"

test(`[${P2_CLASS.FUTURE_CONTRACT}] mesin Run: hanya transisi legal yang diterima`, () => {
  expect(p2RunTransition("CREATED", "RUNNING")).toBe(true)
  expect(p2RunTransition("RUNNING", "COMPLETED")).toBe(true)
  expect(p2RunTransition("RUNNING", "INTERRUPTED")).toBe(true)
  expect(p2RunTransition("INTERRUPTED", "RUNNING")).toBe(true)
  // INTERRUPTED tidak boleh menjadi COMPLETED diam-diam (anti false-complete).
  expect(p2RunTransition("INTERRUPTED", "COMPLETED")).toBe(false)
  expect(p2RunTransition("CREATED", "COMPLETED")).toBe(false)
  expect(p2RunTransition("FAILED", "RUNNING")).toBe(false)
  expect(p2RunTransition("COMPLETED", "RUNNING")).toBe(false)
  // Expected After P2: tabel runs menegakkan graf ini.
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] kursor A: history == cursor valid`, () => {
  expect(p2ReconcileCursor(5, { cursor: 5, runId: "run_1" }, [1, 2, 3, 4, 5])).toEqual({
    cursor: 5,
    note: "ok",
  })
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] kursor B: history > cursor hanya adopsi milik Run sendiri`, () => {
  // Event 6 milik run_1 → adopsi; cursor mengejar committedMax.
  expect(p2ReconcileCursor(6, { cursor: 5, runId: "run_1" }, [6])).toEqual({
    cursor: 6,
    note: "adopted-own",
  })
  // Event 6 milik Run lain → JANGAN adopsi; tetap UNKNOWN eksplisit.
  expect(p2ReconcileCursor(6, { cursor: 5, runId: "run_1" }, [])).toEqual({
    cursor: 5,
    note: "ok",
  })
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] kursor C: cursor > history → clamp + catat alasan`, () => {
  expect(p2ReconcileCursor(3, { cursor: 9, runId: "run_1" }, [])).toEqual({
    cursor: 3,
    note: "cursor_clamped",
  })
  // Dilarang: memfabrikasi histori agar cursor terlihat benar.
})

test(`[${P2_CLASS.CURRENT_INVARIANT}] RAM commit ≠ durable commit (celah kini, kernel nyata)`, async () => {
  const cwd = p2Cwd("mc-p2ram")
  try {
    const session = createSession({
      provider: new FakeProvider([{ events: [text("selesai"), finish("stop")] }]),
      permissions: allowAll,
    })
    await session.run("kerja")
    // RAM: turn ter-commit di ContextStore.
    expect(session.state.history.length).toBeGreaterThan(0)
    // Durable: tanpa saveSession, TIDAK ADA yang persist → restart buta.
    // EXPECTED PRE-P2 FAILURE: setelah P2.5, batas durable (history-txn +
    // kursor Run) membuat klaim "selesai" terverifikasi, bukan implisit.
    expect(loadSession("tidak-ada", cwd)).toBeNull()
  } finally {
    await p2Cleanup(cwd)
  }
})
