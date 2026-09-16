// Footer status REPL (src/ui/footer.ts): 2 baris, mode satu-satunya yang
// berwarna, garis hampir tak terlihat, konteks rata kanan, spark pulse/redup.
// Test sengaja agnostik warna (assert via stripAnsi) agar hijau di env apa
// pun; harness fake-TTY dipakai agar columns terkontrol.

import { afterEach, describe, expect, test } from "bun:test"
import { paintFooterMode, renderFooter, shortModel } from "../src/ui/footer.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { installFakeTty } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
})

describe("footer render", () => {
  test("shortModel membuang prefix provider", () => {
    expect(shortModel("acme::deepseek-v4-flash")).toBe("deepseek-v4-flash")
    expect(shortModel("deepseek-v4-flash")).toBe("deepseek-v4-flash")
    expect(shortModel("")).toBe("")
  })

  test("2 baris: garis tipis + status 4 field + spark", () => {
    tty = installFakeTty({ columns: 80 })
    const [rule, status] = renderFooter(
      {
        mode: "allowlist",
        model: "acme::deepseek-v4-flash",
        cwd: "C:\\Users\\dokument",
        context: "14.2k",
      },
      80,
    )
    expect(stripAnsi(rule!)).toBe("─".repeat(80))
    const plain = stripAnsi(status!)
    expect(plain).toContain("✦")
    expect(plain).toContain("allowlist")
    expect(plain).toContain("deepseek-v4-flash")
    expect(plain).toContain("C:\\Users\\dokument")
    expect(plain).toContain("14.2k")
  })

  test("mode di-pad lebar tetap agar teks kanan tak bergeser saat ganti mode", () => {
    tty = installFakeTty({ columns: 80 })
    const withMode = (mode: string) =>
      stripAnsi(renderFooter({ mode, model: "m1", cwd: "cwd" }, 80)[1]!)
    const auto = withMode("auto")
    const allowlist = withMode("allowlist")
    // Posisi model (`m1`) identik walau nama mode beda panjang — kolom mode
    // di-pad ke lebar tetap (9 = "allowlist"/"allow-all").
    expect(auto.indexOf("m1")).toBe(allowlist.indexOf("m1"))
    expect(auto.indexOf("•")).toBe(allowlist.indexOf("•"))
  })

  test("konteks rata kanan: di ujung kolom target, kiri tetap utuh", () => {
    tty = installFakeTty({ columns: 80 })
    const [rule, status] = renderFooter(
      { mode: "auto", model: "m1", cwd: "cwd", context: "14.2k" },
      80,
    )
    expect(displayWidth(stripAnsi(rule!))).toBe(80)
    const plain = stripAnsi(status!)
    // Konteks di posisi paling kanan (dekat kolom 79), bukan menempel kiri.
    expect(plain.endsWith("14.2k")).toBe(true)
    expect(displayWidth(plain)).toBeLessThanOrEqual(79)
    expect(plain).toContain("auto")
    expect(plain).toContain("m1")
    expect(plain).toContain("cwd")
  })

  test("mode diwarnai per mapping prompt lama; padding tak mengubah warna", () => {
    tty = installFakeTty({ columns: 60 })
    // Mapping: plan=kuning, ask=biru, sisanya=hijau — konten polosnya = mode
    // + padding (bukan mode mentah lagi).
    for (const m of ["auto", "ask", "plan", "allowlist", "allow-all"])
      expect(stripAnsi(paintFooterMode(m)).trimEnd()).toBe(m)
    // SGR depan (warna) hijau sama untuk auto & allowlist, beda dari ask/plan.
    const sgrOf = (s: string) => s.slice(0, s.indexOf("m") + 1)
    expect(sgrOf(paintFooterMode("auto"))).toBe(sgrOf(paintFooterMode("allowlist")))
    expect(sgrOf(paintFooterMode("auto"))).not.toBe(sgrOf(paintFooterMode("ask")))
    expect(sgrOf(paintFooterMode("auto"))).not.toBe(sgrOf(paintFooterMode("plan")))
  })

  test("terminal sempit: 1 baris visual, spark+mode kekal (cwd/model dibuang)", () => {
    tty = installFakeTty({ columns: 24 })
    const [rule, status] = renderFooter(
      { mode: "allowlist", model: "acme::model-sangat-panjang-sekali", cwd: "C:\\Users\\dokument" },
      24,
    )
    expect(displayWidth(stripAnsi(rule!))).toBe(24)
    expect(status).not.toContain("\n")
    expect(displayWidth(stripAnsi(status!))).toBeLessThanOrEqual(23)
    // Yang kekal: spark + mode. Model/cwd panjang dibuang duluan.
    expect(stripAnsi(status!)).toContain("✦")
    expect(stripAnsi(status!)).toContain("allowlist")
  })

  test("spark: redup saat idle (frame 0), putih/abu saat busy (frame naik)", () => {
    tty = installFakeTty({ columns: 80 })
    const idle = renderFooter({ mode: "auto", model: "m1", cwd: "cwd" }, 80)[1]!
    const busy1 = renderFooter({ mode: "auto", model: "m1", cwd: "cwd", sparkFrame: 1 }, 80)[1]!
    const busy2 = renderFooter({ mode: "auto", model: "m1", cwd: "cwd", sparkFrame: 2 }, 80)[1]!
    // Spark selalu ada; beda warnanya (SGR), bukan kehadirannya.
    expect(stripAnsi(idle)).toContain("✦")
    expect(stripAnsi(busy1)).toContain("✦")
    expect(stripAnsi(busy2)).toContain("✦")
    // Frame genap vs ganjil memakai warna berbeda (pulse).
    expect(busy1).not.toBe(busy2)
  })

  test("injeksi ANSI dari nama model/cwd/context dinetralkan", () => {
    tty = installFakeTty({ columns: 80 })
    const [, status] = renderFooter(
      { mode: "auto", model: "evil\x1b[2Jm", cwd: "C:\\x\x1b[?25lh", context: "9k\x1b[2J" },
      80,
    )
    expect(status).not.toContain("[2J")
    expect(status).not.toContain("[?25l")
    expect(stripAnsi(status!)).toContain("evilm")
  })
})
