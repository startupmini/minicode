// Fixture matriks WorkMode × PermissionMode (P12 S2.1 + P0.2) — DATA test-only.
//
// Ditranskrip dari arah owner (REV-2 §4.2, S2.1, dan keputusan P0.2 Q1–Q5):
// - Q1=A1: DISCUSS mengizinkan tepat 16 tool baca lokal (`LOCAL_READONLY_TOOL_NAMES`).
// - Q2=A2: `web_fetch` & `web_search` ditolak di DISCUSS, wajib approval prompt
//   di PLAN (di seluruh 6 PM; headless = deny), dan mengikuti PM di EXECUTE.
// - Q3=A3: Hooks diblokir di DISCUSS dan PLAN untuk seluruh 6 PM.
// - Q4=A4: `--verify` ditolak fail-closed saat startup di DISCUSS dan PLAN.
//
// `ceiling` = ceiling WorkMode yang dipasang SEBELUM handler PM memutuskan:
//   "discuss-local" → hanya 16 LOCAL_READONLY_TOOL_NAMES (network read ditolak);
//   "readonly"      → hanya 18 READONLY_TOOL_NAMES (+ prompt wajib untuk network read di PLAN);
//   "plan"          → 18 READONLY_TOOL_NAMES + 3 PLAN_EXTRA (+ prompt wajib untuk network read);
//   "none"          → EXECUTE, tanpa ceiling (handler PM apa adanya).

import type { PermissionMode } from "../../src/policy/permission.ts"
import type { WorkMode } from "../../src/policy/work-mode.ts"

export interface WorkModeCell {
  workMode: WorkMode
  permissionMode: PermissionMode
  ceiling: "discuss-local" | "readonly" | "plan" | "none"
  networkRead: "deny" | "prompt" | "pm"
  hooks: "blocked" | "allowed"
  verify: "refused" | "allowed"
  /** Catatan keputusan yang menyimpang dari tabel literal (bila ada). */
  note?: string
}

export const WORK_MODE_CELLS: readonly WorkModeCell[] = [
  {
    workMode: "DISCUSS",
    permissionMode: "auto",
    ceiling: "discuss-local",
    networkRead: "deny",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "DISCUSS",
    permissionMode: "ask",
    ceiling: "discuss-local",
    networkRead: "deny",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "DISCUSS",
    permissionMode: "plan",
    ceiling: "discuss-local",
    networkRead: "deny",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "DISCUSS",
    permissionMode: "allow-all",
    ceiling: "discuss-local",
    networkRead: "deny",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "DISCUSS",
    permissionMode: "allowlist",
    ceiling: "discuss-local",
    networkRead: "deny",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "DISCUSS",
    permissionMode: "readonly",
    ceiling: "discuss-local",
    networkRead: "deny",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "PLAN",
    permissionMode: "auto",
    ceiling: "plan",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
    note: "delegate_task & network read wajib lewat gerbang approval (headless deny / TTY prompt)",
  },
  {
    workMode: "PLAN",
    permissionMode: "ask",
    ceiling: "plan",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
    note: "delegate_task & network read wajib lewat gerbang approval (headless deny / TTY prompt)",
  },
  {
    workMode: "PLAN",
    permissionMode: "plan",
    ceiling: "plan",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "PLAN",
    permissionMode: "allow-all",
    ceiling: "plan",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "PLAN",
    permissionMode: "allowlist",
    ceiling: "readonly",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
    note: "lebih ketat dari irisan literal (owner-approved): read-only saja + prompt untuk network read",
  },
  {
    workMode: "PLAN",
    permissionMode: "readonly",
    ceiling: "readonly",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "auto",
    ceiling: "none",
    networkRead: "pm",
    hooks: "allowed",
    verify: "allowed",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "ask",
    ceiling: "none",
    networkRead: "pm",
    hooks: "allowed",
    verify: "allowed",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "plan",
    ceiling: "none",
    networkRead: "pm",
    hooks: "blocked",
    verify: "allowed",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "allow-all",
    ceiling: "none",
    networkRead: "pm",
    hooks: "allowed",
    verify: "allowed",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "allowlist",
    ceiling: "none",
    networkRead: "pm",
    hooks: "allowed",
    verify: "allowed",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "readonly",
    ceiling: "none",
    networkRead: "pm",
    hooks: "blocked",
    verify: "allowed",
  },
] as const

export function cellOf(workMode: WorkMode, permissionMode: PermissionMode): WorkModeCell {
  const cell = WORK_MODE_CELLS.find(
    (c) => c.workMode === workMode && c.permissionMode === permissionMode,
  )
  if (!cell) throw new Error(`fixture: sel ${workMode} × ${permissionMode} tidak ada`)
  return cell
}
