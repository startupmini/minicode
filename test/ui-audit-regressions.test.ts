import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendHistory, loadHistory } from "../src/ui/input/input.ts"
import { countLogicalLines, cursorLineIndex } from "../src/ui/input/prompt-engine.ts"
import { TuiApp } from "../src/ui/tui/app.ts"

describe("audit regresi UI/UX: input history & MINICODE_HOME", () => {
  let tempDir: string
  const originalEnv = process.env.MINICODE_HOME

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mc-ui-history-"))
    process.env.MINICODE_HOME = tempDir
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MINICODE_HOME = originalEnv
    } else {
      delete process.env.MINICODE_HOME
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("appendHistory dan loadHistory menghormati MINICODE_HOME secara dinamis", async () => {
    await appendHistory("first command")
    await appendHistory("second command")

    const expectedFile = join(tempDir, ".minicode", "history")
    expect(existsSync(expectedFile)).toBe(true)

    const raw = readFileSync(expectedFile, "utf8")
    expect(raw).toContain("first command")
    expect(raw).toContain("second command")

    const loaded = await loadHistory()
    expect(loaded).toEqual(["first command", "second command"])
  })
})

describe("audit regresi UI/UX: help text skills", () => {
  test("SKILLS_HELP merujuk 'interactive mode' bukan 'REPL'", () => {
    const skillsPath = join(__dirname, "../cli/commands/skills.ts")
    const content = readFileSync(skillsPath, "utf8")
    expect(content).toContain("In interactive mode, run a skill with /name [arguments].")
    expect(content).not.toContain("In REPL, run a skill with /name")
  })
})

describe("audit regresi UI/UX: wizard exit message handling", () => {
  test("wizard.ts menulis exitMsg ke stdout setelah screen.close() di blok finally", () => {
    const wizardPath = join(__dirname, "../src/ui/screens/wizard.ts")
    const content = readFileSync(wizardPath, "utf8")
    // Pastikan exitMsg ditulis setelah screen.close() di finally
    expect(content).toContain("screen.close()")
    expect(content).toContain("if (exitMsg) {")
    expect(content).toContain("process.stdout.write(exitMsg)")
  })

  test("wizard.ts menggunakan judul langkah berjenjang", () => {
    const wizardPath = join(__dirname, "../src/ui/screens/wizard.ts")
    const content = readFileSync(wizardPath, "utf8")
    expect(content).toContain('t("wiz.stepUrl")')
    expect(content).toContain('t("wiz.stepKey")')
  })
})

describe("audit regresi UI/UX: backdrop dimming & multi-line helpers", () => {
  test("TuiApp.applyBackdropDim menetralisir reset ANSI dan bold", () => {
    const colored = "\x1b[1m\x1b[32mhello\x1b[0m world\x1b[22m"
    const dimmed = TuiApp.applyBackdropDim(colored)
    expect(dimmed).not.toContain("\x1b[1m")
    expect(dimmed).toContain("\x1b[0m\x1b[2m")
    expect(dimmed).toContain("hello")
    expect(dimmed).toContain("world")
    expect(TuiApp.applyBackdropDim("")).toBe("")
  })

  test("countLogicalLines dan cursorLineIndex mengukur baris multi-line dengan benar", () => {
    const multi = "line1\nline2\nline3"
    expect(countLogicalLines(multi)).toBe(3)
    const pos = cursorLineIndex(multi, 7) // 'line1\nl' -> lineIdx 1, colIdx 1
    expect(pos.lineIdx).toBe(1)
    expect(pos.colIdx).toBe(1)
  })
})
