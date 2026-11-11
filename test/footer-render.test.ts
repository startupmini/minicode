// Footer status TUI (src/ui/footer.ts): Work Mode di kiri, Permission Mode
// cyan di kanan dekat konteks, garis hampir tak terlihat, spark pulse/redup.
// Test sengaja agnostik warna (assert via stripAnsi) agar hijau di env apa
// pun; harness fake-TTY dipakai agar columns terkontrol.
//
// Kedua lapis selalu tampil dengan label title case; default Work Mode Discuss
// dan default Permission Mode Auto terlihat tanpa konfigurasi tambahan.

import { afterEach, describe, expect, test } from "bun:test"
import {
  paintBashStrict,
  paintPermissionMode,
  paintWorkMode,
  renderFooter,
  shortenPath,
  shortModel,
} from "../src/ui/footer.ts"
import { c, stripAnsi } from "../src/ui/render/theme.ts"
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

  test("1 baris: status mode, model, cwd, konteks + spark (tanpa garis)", () => {
    tty = installFakeTty({ columns: 96 })
    const [status] = renderFooter(
      {
        mode: "auto",
        workMode: "EXECUTE",
        model: "acme::deepseek-v4-flash",
        cwd: "C:\\Users\\dokument",
        context: "14.2k",
      },
      96,
    )
    const plain = stripAnsi(status!)
    expect(plain).toContain("✦")
    expect(plain).toContain("Work Mode: Build")
    expect(plain).toContain("Permission Mode: Auto")
    expect(plain.indexOf("14.2k")).toBeLessThan(plain.indexOf("Permission Mode: Auto"))
    expect(plain).toContain("deepseek-v4-flash")
    expect(plain).toContain("C:\\Users\\dokument")
    expect(plain).toContain("14.2k")
  })

  test("activity diabaikan: footer hanya mode, model, cwd, konteks, dan spark", () => {
    tty = installFakeTty({ columns: 90 })
    const [status] = renderFooter(
      {
        mode: "auto",
        model: "m1",
        cwd: "cwd",
        context: "1k",
        activity: "Working 12s",
        sparkFrame: 2,
      },
      90,
    )
    const plain = stripAnsi(status!)
    expect(plain).toContain("Work Mode: Discuss")
    expect(plain).toContain("Permission Mode: Auto")
    expect(plain).toContain("m1")
    expect(plain).toContain("cwd")
    expect(plain).toContain("1k")
    expect(plain).not.toMatch(/Working|Thinking|Running|\d+s/)
    expect(displayWidth(plain)).toBeLessThanOrEqual(89)
  })

  test("field footer tetap stabil tanpa activity variable-width", () => {
    tty = installFakeTty({ columns: 90 })
    const states = ["Thinking 0s", "Working 10s", "Running tool-with-a-long-name"]
    const lines = states.map((activity) =>
      stripAnsi(renderFooter({ mode: "auto", model: "m1", cwd: "cwd", activity }, 90)[0]!),
    )
    const modelColumn = lines[0]!.indexOf("m1")
    const modeColumn = lines[0]!.indexOf("Work Mode: Discuss")
    for (const line of lines) {
      expect(line).toContain("m1")
      expect(line.indexOf("m1")).toBe(modelColumn)
      expect(line.indexOf("Work Mode: Discuss")).toBe(modeColumn)
      expect(line).not.toMatch(/Thinking|Working|Running|\d+s/)
      expect(displayWidth(line)).toBeLessThanOrEqual(89)
    }
  })

  test("footer tetap stabil di terminal sempit", () => {
    tty = installFakeTty({ columns: 46 })
    const lines = ["Thinking 0s", "Working 10s"].map((activity) =>
      stripAnsi(renderFooter({ mode: "auto", model: "m1", cwd: "cwd", activity }, 46)[0]!),
    )
    const modeColumn = lines[0]!.indexOf("Work: Discuss")
    const modelColumn = lines[0]!.indexOf("m1")
    for (const line of lines) {
      expect(line).toContain("Discuss")
      expect(line.indexOf("Work: Discuss")).toBe(modeColumn)
      expect(line).toContain("Permission: Auto")
      expect(line.indexOf("m1")).toBe(modelColumn)
      expect(line).not.toMatch(/Thinking|Working|Running|\d+s/)
      expect(displayWidth(line)).toBeLessThanOrEqual(45)
    }
  })

  test("timer di sebelah sparkle, separator bullet hilang, dan level warna naik", () => {
    tty = installFakeTty({ columns: 90 })
    const render = (
      timer: string,
      timerActive: boolean,
      timerHighlight?: "seconds" | "minutes" | "hours",
    ) =>
      renderFooter(
        { mode: "auto", model: "m1", cwd: "cwd", timer, timerActive, timerHighlight },
        90,
      )[0]!
    const idle = render("00.00.00", false)
    const seconds = render("00.00.42", true, "seconds")
    const minutes = render("00.01.02", true, "minutes")
    const hours = render("01.00.00", true, "hours")
    expect(stripAnsi(idle)).toMatch(/✦ {2}00\.00\.00 {2}Work Mode: Discuss +m1 +cwd/)
    expect(stripAnsi(seconds)).toMatch(/✦ {2}00\.00\.42 {2}Work Mode: Discuss +m1 +cwd/)
    expect(stripAnsi(minutes)).toMatch(/✦ {2}00\.01\.02 {2}Work Mode: Discuss +m1 +cwd/)
    expect(stripAnsi(hours)).toMatch(/✦ {2}01\.00\.00 {2}Work Mode: Discuss +m1 +cwd/)
    for (const line of [idle, seconds, minutes, hours]) expect(stripAnsi(line)).not.toContain("•")
    expect(idle).toContain("\x1b[38;2;72;72;72m00.00.00")
    expect(seconds).toContain("\x1b[37m42\x1b[39m")
    expect(minutes).toContain("\x1b[37m01\x1b[39m")
    expect(hours).toContain("\x1b[37m01\x1b[39m")
  })

  test("Work Mode stabil di kiri; Permission Mode tidak menggeser model", () => {
    tty = installFakeTty({ columns: 90 })
    const withMode = (mode: string) =>
      stripAnsi(renderFooter({ mode, workMode: "EXECUTE", model: "m1", cwd: "cwd" }, 90)[0]!)
    const auto = withMode("auto")
    const ask = withMode("ask")
    expect(auto.indexOf("m1")).toBe(ask.indexOf("m1"))
    expect(auto.indexOf("Work Mode: Build")).toBe(ask.indexOf("Work Mode: Build"))
    expect(auto.indexOf("Permission Mode: Auto")).toBeGreaterThan(auto.indexOf("cwd"))
    expect(ask.indexOf("Permission Mode: Ask")).toBeGreaterThan(ask.indexOf("cwd"))
    expect(auto).not.toContain("•")
  })

  test("konteks rata kanan: di ujung kolom target, kiri tetap utuh", () => {
    tty = installFakeTty({ columns: 90 })
    const [status] = renderFooter({ mode: "auto", model: "m1", cwd: "cwd", context: "14.2k" }, 90)
    const plain = stripAnsi(status!)
    expect(plain.endsWith("🔒")).toBe(true)
    expect(plain).toContain("Permission Mode: Auto")
    expect(plain.indexOf("14.2k")).toBeLessThan(plain.indexOf("Permission Mode: Auto"))
    expect(displayWidth(plain)).toBeLessThanOrEqual(89)
    expect(plain).toContain("Permission Mode: Auto")
    expect(plain).toContain("m1")
    expect(plain).toContain("cwd")
  })

  test("mode memakai title case dan warna Work/Permission berbeda", () => {
    tty = installFakeTty({ columns: 60 })
    const build = paintWorkMode("EXECUTE")
    const discuss = paintWorkMode("DISCUSS")
    const plan = paintWorkMode("PLAN")
    const auto = paintPermissionMode("auto")
    const ask = paintPermissionMode("ask")
    expect(stripAnsi(build).trimEnd()).toBe("Work Mode: Build")
    expect(stripAnsi(discuss).trimEnd()).toBe("Work Mode: Discuss")
    expect(stripAnsi(plan).trimEnd()).toBe("Work Mode: Plan")
    expect(stripAnsi(auto)).toBe("Permission Mode: Auto")
    expect(stripAnsi(ask)).toBe("Permission Mode: Ask")
    expect(build).toContain(c.success("Build"))
    expect(discuss).toContain(c.warning("Discuss"))
    expect(auto).toContain(c.info("Auto"))
    expect(ask).toContain(c.info("Ask"))
    expect(c.success("Build")).not.toBe(c.info("Auto"))
  })

  test("restrictBash: gembok selalu tampil (terang aktif, redup nonaktif)", () => {
    tty = installFakeTty({ columns: 80 })
    expect(stripAnsi(paintBashStrict(true))).toBe("🔒")
    expect(stripAnsi(paintBashStrict(false))).toBe("🔒")
    expect(stripAnsi(paintBashStrict(undefined))).toBe("🔒")
    // aktif = kuning/terang, nonaktif = redup.
    expect(paintBashStrict(true)).toContain(c.yellow("🔒"))
    expect(paintBashStrict(false)).toContain(c.faint("🔒"))
    const [strict] = renderFooter({ mode: "auto", strictBash: true, model: "m1", cwd: "cwd" }, 80)
    const [plain] = renderFooter({ mode: "auto", strictBash: false, model: "m1", cwd: "cwd" }, 80)
    expect(stripAnsi(strict!)).toContain("🔒")
    expect(stripAnsi(plain!)).toContain("🔒")
  })

  test("unrestricted: hanya gembok terbuka (🔓) tanpa label permission", () => {
    tty = installFakeTty({ columns: 80 })
    // Gembok jadi 🔓 (terbuka) jelas saat unrestricted aktif.
    expect(stripAnsi(paintBashStrict(false, true))).toBe("🔓")
    expect(stripAnsi(paintBashStrict(true, true))).toBe("🔓")
    expect(paintBashStrict(true, true)).toContain(c.info("🔓"))
    // Label permission disembunyikan (cukup gembok terbuka).
    expect(paintPermissionMode("unrestricted")).toBe("")
    const [line] = renderFooter({ mode: "unrestricted", model: "m1", cwd: "cwd" }, 80)
    expect(stripAnsi(line!)).not.toContain("Unrestricted")
    expect(stripAnsi(line!)).toContain("🔓")
  })

  test("terminal sempit: 1 baris visual, spark+mode kekal (cwd/model dibuang)", () => {
    tty = installFakeTty({ columns: 24 })
    const [status] = renderFooter(
      { mode: "ask", model: "acme::model-sangat-panjang-sekali", cwd: "C:\\Users\\dokument" },
      24,
    )
    expect(status).not.toContain("\n")
    expect(displayWidth(stripAnsi(status!))).toBeLessThanOrEqual(23)
    expect(stripAnsi(status!)).toContain("✦")
    const plain = stripAnsi(status!)
    expect(plain).toContain("Discuss")
    expect(plain).toContain("Ask")
  })

  test("spark: redup saat idle (frame 0), putih/abu saat busy (frame naik)", () => {
    tty = installFakeTty({ columns: 80 })
    const idle = renderFooter({ mode: "auto", model: "m1", cwd: "cwd" }, 80)[0]!
    const busy1 = renderFooter({ mode: "auto", model: "m1", cwd: "cwd", sparkFrame: 1 }, 80)[0]!
    const busy2 = renderFooter({ mode: "auto", model: "m1", cwd: "cwd", sparkFrame: 2 }, 80)[0]!
    expect(stripAnsi(idle)).toContain("✦")
    expect(stripAnsi(busy1)).toContain("✦")
    expect(stripAnsi(busy2)).toContain("✦")
    expect(busy1).not.toBe(busy2)
  })

  test("injeksi ANSI dari nama model/cwd/context dinetralkan", () => {
    tty = installFakeTty({ columns: 80 })
    const [status] = renderFooter(
      {
        mode: "auto",
        model: "evil\x1b[2Jm",
        cwd: "C:\\x\x1b[?25lh",
        context: "9k\x1b[2J",
        activity: "Working\x1b[2Jnow",
      },
      80,
    )
    expect(status!).not.toContain("[2J")
    expect(status!).not.toContain("[?25l")
    expect(stripAnsi(status!)).toContain("evilm")
  })

  test("newline di model/cwd/context/mode jadi spasi, tetap 1 baris", () => {
    tty = installFakeTty({ columns: 90 })
    const [status] = renderFooter(
      { mode: "au\nto", model: "m\n1", cwd: "a\nb", context: "9\nk" },
      90,
    )
    expect(status!).not.toContain("\n")
    const plain = stripAnsi(status!)
    expect(plain).toContain("Work Mode: Discuss")
    expect(plain).toContain("Permission Mode: Au To")
    expect(plain).toContain("m 1")
    expect(plain).toContain("a b")
    expect(plain).toContain("9 k")
    expect(displayWidth(plain)).toBeLessThanOrEqual(89)
  })

  test("shortenPath memperpendek segmen direktori", () => {
    expect(shortenPath("d:\\git\\minicode\\src\\ui")).toBe("...\\src\\ui")
    expect(shortenPath("/home/user/projects/minicode/src")).toBe(".../minicode/src")
    expect(shortenPath("/short/path")).toBe("/short/path")
    expect(shortenPath("")).toBe("")
  })

  test("terminal sedang: menggunakan shortened cwd sebelum dibuang total", () => {
    tty = installFakeTty({ columns: 70 })
    const longCwd = "D:\\very\\long\\nested\\workspace\\directory\\for\\testing\\repo"
    const [status] = renderFooter(
      { mode: "auto", model: "gpt-4o", cwd: longCwd, context: "10k" },
      70,
    )
    const plain = stripAnsi(status!)
    expect(plain).toContain("...\\testing\\repo")
    expect(plain).not.toContain("D:\\very\\long")
    expect(displayWidth(plain)).toBeLessThanOrEqual(69)
  })

  test("cache footer: env tema berubah dirender ulang, array hasil tetap baru", () => {
    tty = installFakeTty({ columns: 80 })
    const args = { mode: "auto", model: "m1", cwd: "cwd" } as const
    const colored = renderFooter(args, 80)[0]!
    expect(colored).toContain("\x1b[")
    // Mutasi hasil panggilan tidak boleh meracuni cache.
    const mutable = renderFooter(args, 80)
    mutable[0] = "rusak"
    expect(renderFooter(args, 80)[0]).toBe(colored)
    // NO_COLOR mengubah kapabilitas: cache lama (berwarna) tak boleh dipakai.
    process.env.NO_COLOR = "1"
    const plain = renderFooter(args, 80)[0]!
    expect(plain).not.toContain("\x1b[")
    delete process.env.NO_COLOR
    expect(renderFooter(args, 80)[0]).toBe(colored)
  })
})
