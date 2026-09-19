// Satu sumber state "level detail tool call": expanded vs compact.
//
// Posisi Minicode = agentic Unix shell: tool call transparan di aliran output.
// Default tergantung konteks: one-shot/exec = expanded; REPL interaktif
// mengaktifkan compact saat start (lihat runReplLoop) kecuali env diset eksplisit.
// `MINICODE_COMPACT=1`/`0` atau `/compact` selalu menang. Getter — jangan simpan
// `detail.compact` ke const di module scope; baca saat pakai supaya perubahan
// env (mis. /compact) langsung berlaku.
export const detail = {
  get compact(): boolean {
    return process.env.MINICODE_COMPACT === "1"
  },
  set compact(v: boolean) {
    process.env.MINICODE_COMPACT = v ? "1" : "0"
  },
}

/** Set eksplisit (on/off) atau toggle bila `next` tidak diberikan. */
export function setCompactMode(next?: boolean): boolean {
  const cur = detail.compact
  const nextVal = next ?? !cur
  detail.compact = nextVal
  return nextVal
}
