// Satu sumber state "level detail tool call": expanded vs compact.
//
// Posisi Minicode = agentic Unix shell: tool call transparan di aliran output.
// Default tergantung konteks: one-shot/exec = expanded; REPL interaktif
// mengaktifkan compact saat start (lihat runRepl) kecuali env diset eksplisit.
// `MINICODE_COMPACT=1`/`0` atau `/compact` selalu menang.
//
// [F-ENV-1] State module-local di-bootstrap SATU KALI dari env saat import; setter
// TIDAK lagi menulis `process.env` (pilihan UI bukan konfigurasi yang boleh
// diwarisi sub-proses). Getter dibaca saat dipakai agar toggle runtime langsung
// berlaku — jangan simpan `detail.compact` ke const di module scope.
//
// [Area A · PROMPT 06] Delegator ke instance default `UiSessionState`; state
// sebenarnya dimiliki SESI (lihat `src/ui/session-state.ts`).
import { defaultUiState } from "../session-state.ts"

export const detail = {
  get compact(): boolean {
    return defaultUiState.compact
  },
  set compact(v: boolean) {
    defaultUiState.compact = v
  },
}

/** Set eksplisit (on/off) atau toggle bila `next` tidak diberikan. */
export function setCompactMode(next?: boolean): boolean {
  return defaultUiState.setCompactMode(next)
}
