// Tabel pemetaan gate kapabilitas TUI (cli/tui-policy.ts) — murni via
// injeksi, hijau di OS apa pun. Sejak REPL linier dihapus: mampu = tui,
// tak mampu = linear (= pemanggil menolak jujur, bukan fallback diam).

import { describe, expect, test } from "bun:test"
import { isWinLegacy, resolveTuiMode, type TuiSys } from "../cli/tui-policy.ts"

const capable: TuiSys = { env: {}, isTTY: true, rows: 30, legacy: false }

describe("tui policy: gate kapabilitas", () => {
  test("mampu = tui", () => {
    expect(resolveTuiMode(capable)).toBe("tui")
    expect(resolveTuiMode({ ...capable, rows: 0 })).toBe("tui") // tak diketahui = izinkan
    expect(resolveTuiMode({ ...capable, env: { MINICODE_TUI: "never" } })).toBe("tui") // env mati: diabaikan
  })

  test("tak mampu = linear (pemanggil menolak jujur)", () => {
    expect(resolveTuiMode({ ...capable, isTTY: false })).toBe("linear")
    expect(resolveTuiMode({ ...capable, env: { TERM: "dumb" } })).toBe("linear")
    expect(resolveTuiMode({ ...capable, legacy: true })).toBe("linear")
    expect(resolveTuiMode({ ...capable, rows: 9 })).toBe("linear")
    expect(resolveTuiMode({ ...capable, rows: 1 })).toBe("linear")
  })

  test("isWinLegacy: platform + sinyal emulator", () => {
    // Nilai aktual tergantung mesin; yang diuji invariannya (boolean).
    expect(typeof isWinLegacy()).toBe("boolean")
    if (process.platform !== "win32") expect(isWinLegacy()).toBe(false)
  })
})
