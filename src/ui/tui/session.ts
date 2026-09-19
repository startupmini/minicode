// Slot sesi TUI aktif: jembatan driver (cli/repl-tui.ts) → konsumen yang
// dikomposisi SEBELUM driver ada (setup.ts wiring `ask`, tool `ask_user`).
//
// Mengapa holder, bukan impor langsung: `cli/setup.ts` berjalan sebelum
// `TuiScreen` dibuat driver; screen tak bisa dioper sebagai argumen.
// Pola sama seperti setAskTextFn/setSubAgentSessionFactory (DI pasca-
// komposisi). Fail-closed: absen = deny/null (tak pernah jalan buta).
// Driver mengisi sesudah create screen, mengosongkan saat dispose.
export type TuiApprovalVerdict = "allow" | "deny" | "always"

export interface TuiApprovalCall {
  name: string
  args?: unknown
}

export interface TuiSessionUi {
  approval(call: TuiApprovalCall): Promise<TuiApprovalVerdict>
  askText(question: string, options?: string[]): Promise<string | null>
}

let current: TuiSessionUi | null = null

export function setTuiSessionUi(ui: TuiSessionUi | null): void {
  current = ui
}

export function tuiSessionUi(): TuiSessionUi | null {
  return current
}
