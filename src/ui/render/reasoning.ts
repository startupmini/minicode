// Satu sumber state "tampilkan reasoning".
//
// [F-ENV-1] State module-local, di-bootstrap SATU KALI dari env saat import.
// Setter TIDAK lagi menulis `process.env`: pilihan tampilan adalah state
// instance proses, bukan konfigurasi yang boleh diwarisi sub-agent/MCP (sebelumnya
// `MINICODE_SHOW_THINKING` ditulis ke env → bocor ke anak). Getter tetap dibaca
// saat dipakai agar toggle runtime langsung berlaku tanpa re-import.
//
// [Area A · PROMPT 06] Delegator ke instance default `UiSessionState`; state
// sebenarnya dimiliki SESI (lihat `src/ui/session-state.ts`).
import { defaultUiState } from "../session-state.ts"

export const reasoning = {
  get visible(): boolean {
    return defaultUiState.reasoningVisible
  },
  set visible(v: boolean) {
    defaultUiState.reasoningVisible = v
  },
}

/** Set eksplisit (on/off) atau toggle bila `next` tidak diberikan. */
export function setReasoningVisible(next?: boolean): boolean {
  return defaultUiState.setReasoningVisible(next)
}
