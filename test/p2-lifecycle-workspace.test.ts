// P2.0 — Kontrak lifecycle sesi + workspace binding
// (P2-FUTURE-CONTRACT + CURRENT-INVARIANT).
//
// Mesin lifecycle dan aturan MOVED/rebind diuji via oracle; perilaku
// validateResumeWorkspace kini diasersikan sebagai baseline.

import { expect, test } from "bun:test"
import { validateResumeWorkspace } from "../src/session/checkpoint.ts"
import { P2_CLASS, p2Cleanup, p2Cwd, p2RunTransition, p2SessionTransition } from "./helpers/p2.ts"

test(`[${P2_CLASS.FUTURE_CONTRACT}] mesin sesi: jalur legal vs ilegal`, () => {
  expect(p2SessionTransition("CREATED", "ACTIVE")).toBe(true)
  expect(p2SessionTransition("ACTIVE", "INTERRUPTED")).toBe(true)
  expect(p2SessionTransition("INTERRUPTED", "RESUMABLE")).toBe(true)
  expect(p2SessionTransition("RESUMABLE", "ACTIVE")).toBe(true)
  expect(p2SessionTransition("ACTIVE", "ARCHIVED")).toBe(true)
  // Ilegal: lompat fase, keluar dari ARCHIVED, "COMPLETED" sesi tidak ada.
  expect(p2SessionTransition("CREATED", "RESUMABLE")).toBe(false)
  expect(p2SessionTransition("ARCHIVED", "ACTIVE")).toBe(false)
  expect(p2SessionTransition("INTERRUPTED", "ACTIVE")).toBe(false)
  // Expected After P2: transitionSession menegakkan graf ini + persist.
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] Run COMPLETED tidak meng-COMPLETE-kan sesi; interupsi selektif`, () => {
  // Kontrak: status Run per-baris; transisi sesi tidak bulk-update Run.
  const runs = [
    { id: "r1", status: "COMPLETED" as const },
    { id: "r2", status: "RUNNING" as const },
  ]
  const interrupted = runs.filter((r) => r.status === "RUNNING").map((r) => r.id)
  expect(interrupted).toEqual(["r2"])
  expect(p2RunTransition("COMPLETED", "RUNNING")).toBe(false)
  // Expected After P2: sesi INTERRUPTED hanya menandai r2 INTERRUPTED.
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] workspace: rebind ditolak saat RUNNING`, () => {
  // Aturan R12: rebind hanya saat quiescent/INTERRUPTED/RESUMABLE.
  const canRebind = (runStatus: string): boolean => runStatus !== "RUNNING"
  expect(canRebind("RUNNING")).toBe(false)
  expect(canRebind("INTERRUPTED")).toBe(true)
  expect(canRebind("COMPLETED")).toBe(true)
  // cwd berbeda (walau repo sama) → MOVED eksplisit, bukan adaptasi diam.
  const bindingState = (oldCwd: string, newCwd: string): string =>
    oldCwd === newCwd ? "same" : "moved"
  expect(bindingState("/a", "/b")).toBe("moved")
  expect(bindingState("/a", "/a")).toBe("same")
})

test(`[${P2_CLASS.CURRENT_INVARIANT}] baseline: workspace tanpa checkpoint = bersih, tak pernah blokir`, async () => {
  const cwd = p2Cwd("mc-p2ws")
  try {
    const res = await validateResumeWorkspace(cwd, "sesi-tanpa-checkpoint")
    expect(res).toEqual({ mode: "none", diverged: 0 })
  } finally {
    await p2Cleanup(cwd)
  }
})
