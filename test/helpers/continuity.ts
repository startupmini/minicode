// P13.3 Stage C — gate kontinuitas untuk suite MEKANIKA scheduler.
//
// Bukan kebijakan produksi: produksi memasang gate dari `cli/setup.ts`, yang
// menurunkan bukti dari runtime, TaskStore, jurnal, admission, dan cakupan tool
// 6S yang nyata. Helper ini hanya menggantikan bukti itu pada tes yang memang
// menguji lineage/reconcile/ownership, supaya jalur yang diuji tetap jalur
// "aman" dan bukan berhenti lebih awal di HOLD.
//
// Tes kebijakan retry (p13-task-continuity) TIDAK memakai helper ini; ia
// membangun gate sendiri untuk tiap kombinasi bukti, termasuk yang gagal.

import type { ContinuityGate } from "../../src/task/continuity.ts"

/** Semua bukti positif + cakupan tool read-only. */
export const PROVEN_READ_ONLY_CONTINUITY: ContinuityGate = {
  evidence: () => ({
    resume: true,
    missing: [],
    admission: "ALLOW",
    retrySafety: "READ_ONLY_TOOL_SCOPE",
  }),
}
