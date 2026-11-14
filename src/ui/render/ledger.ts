// Satu sumber marker/status/warna untuk baris ledger tool — dipakai TUI
// (transcript.ts) dan printer linier (simple.ts) supaya glyph, kata status,
// warna, dan label run sub-agent tidak divergen. Sebelumnya logika ini
// diduplikasi di kedua berkas (dan mudah drift — kelas OAP-001).
//
// Murni & tanpa IO: hanya memetakan status → kata/glyph/warna; sanitasi dan
// pemotongan lebar tetap di sisi pemanggil.
import type { UiToolStatus } from "../contract.ts"
import { t } from "../i18n/locale.ts"
import { c } from "./theme.ts"

/** Kata status lokal ("completed"/"failed"/dst.) — fallback non-warna. */
export function statusWord(status: UiToolStatus): string {
  if (status === "completed") return t("ts.statusCompleted")
  if (status === "failed") return t("ts.statusFailed")
  if (status === "denied") return t("ts.statusDenied")
  if (status === "cancelled") return t("ts.statusCancelled")
  if (status === "interrupted") return t("ts.statusInterrupted")
  return t("ts.statusRunning")
}

/** Warna baris ledger berdasar status terminal (sukses/error/denied/lain). */
export function paintLedger(status: UiToolStatus, line: string): string {
  if (status === "failed") return c.error(line)
  if (status === "denied") return c.warning(line)
  if (status === "completed") return c.success(line)
  return c.muted(line)
}

/** Label run pendek stabil (`run_<8>` | `sub_<8>`) untuk identitas sub-agent. */
export function runMarker(
  activity: { runId?: string; childSessionId?: string } | undefined,
): string {
  const id = activity?.runId ?? activity?.childSessionId
  if (!id) return ""
  const prefix = id.startsWith("run_") ? "run_" : id.startsWith("sub_") ? "sub_" : ""
  const bare = id.slice(prefix.length).replace(/-/g, "")
  return prefix + bare.slice(0, 8)
}
