// Fixture matriks WorkMode × PermissionMode (P12 S2.1) — DATA test-only.
//
// Ditranskrip dari arah owner (REV-2 §4.2) + keputusan owner S2.1: untuk
// PLAN × auto/ask, gerbang approval `delegate_task` milik PM asli dipertahankan
// (bukan diganti allow plan-mode). Fixture ini TIDAK dipakai produksi; ia
// hanya ekspektasi independen untuk memverifikasi produksi (work-mode.ts).
//
// `ceiling` = ceiling WorkMode yang dipasang SEBELUM handler PM memutuskan:
//   "readonly" → hanya READONLY_TOOLS; "plan" → readonly + 3 ekstra plan;
//   "none"     → EXECUTE, tanpa ceiling (handler PM apa adanya).

import type { PermissionMode } from "../../src/policy/permission.ts"
import type { WorkMode } from "../../src/policy/work-mode.ts"

export interface WorkModeCell {
  workMode: WorkMode
  permissionMode: PermissionMode
  ceiling: "readonly" | "plan" | "none"
  /** Catatan keputusan yang menyimpang dari tabel literal (bila ada). */
  note?: string
}

export const WORK_MODE_CELLS: readonly WorkModeCell[] = [
  { workMode: "DISCUSS", permissionMode: "auto", ceiling: "readonly" },
  { workMode: "DISCUSS", permissionMode: "ask", ceiling: "readonly" },
  { workMode: "DISCUSS", permissionMode: "plan", ceiling: "readonly" },
  { workMode: "DISCUSS", permissionMode: "allow-all", ceiling: "readonly" },
  { workMode: "DISCUSS", permissionMode: "allowlist", ceiling: "readonly" },
  { workMode: "DISCUSS", permissionMode: "readonly", ceiling: "readonly" },
  {
    workMode: "PLAN",
    permissionMode: "auto",
    ceiling: "plan",
    note: "delegate_task tetap lewat gerbang approval auto (headless deny / TTY prompt)",
  },
  {
    workMode: "PLAN",
    permissionMode: "ask",
    ceiling: "plan",
    note: "delegate_task tetap lewat gerbang approval ask (headless deny / TTY prompt)",
  },
  { workMode: "PLAN", permissionMode: "plan", ceiling: "plan" },
  { workMode: "PLAN", permissionMode: "allow-all", ceiling: "plan" },
  {
    workMode: "PLAN",
    permissionMode: "allowlist",
    ceiling: "readonly",
    note: "lebih ketat dari irisan literal (owner-approved): read-only saja",
  },
  { workMode: "PLAN", permissionMode: "readonly", ceiling: "readonly" },
  { workMode: "EXECUTE", permissionMode: "auto", ceiling: "none" },
  { workMode: "EXECUTE", permissionMode: "ask", ceiling: "none" },
  { workMode: "EXECUTE", permissionMode: "plan", ceiling: "none" },
  { workMode: "EXECUTE", permissionMode: "allow-all", ceiling: "none" },
  { workMode: "EXECUTE", permissionMode: "allowlist", ceiling: "none" },
  { workMode: "EXECUTE", permissionMode: "readonly", ceiling: "none" },
] as const

export function cellOf(workMode: WorkMode, permissionMode: PermissionMode): WorkModeCell {
  const cell = WORK_MODE_CELLS.find(
    (c) => c.workMode === workMode && c.permissionMode === permissionMode,
  )
  if (!cell) throw new Error(`fixture: sel ${workMode} × ${permissionMode} tidak ada`)
  return cell
}
