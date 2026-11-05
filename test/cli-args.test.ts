import { expect, test } from "bun:test"
import { flagsAfterPromptBoundary, getArg, promptFromArgs } from "../cli/args.ts"

test("getArg returns value after flag", () => {
  expect(getArg(["--cwd", "src", "refactor"], "--cwd")).toBe("src")
  expect(getArg(["refactor", "--cwd", "src"], "--cwd")).toBeUndefined()
  expect(getArg(["refactor", "--cwd"], "--cwd")).toBeUndefined()
  expect(getArg(["refactor"], "--cwd")).toBeUndefined()
})

test("promptFromArgs removes boolean flags", () => {
  expect(promptFromArgs(["--verbose", "refactor", "src"])).toBe("refactor src")
  expect(promptFromArgs(["--allow-all", "--plan", "refactor"])).toBe("refactor")
  expect(promptFromArgs(["refactor", "src", "--verbose"])).toBe("refactor src --verbose")
  expect(promptFromArgs(["refactor", "--allow-all"])).toBe("refactor --allow-all")
  expect(promptFromArgs([])).toBe("")
})

// `--tui` dan `--ui` dihapus: keduanya diparse dan diteruskan tapi tidak pernah
// dibaca. Flag tak dikenal dibiarkan sebagai kata prompt (perilaku lama).
// getArg sengaja tetap generik — ia mencari nama apa pun, bukan hanya yang dikenal.
test("flag yang sudah dihapus tidak lagi disaring dari prompt", () => {
  expect(promptFromArgs(["refactor", "--tui"])).toBe("refactor --tui")
  expect(promptFromArgs(["refactor", "--ui", "full"])).toBe("refactor --ui full")
})

test("-v/--version dikenali sebagai flag, bukan prompt", () => {
  expect(promptFromArgs(["--version"])).toBe("")
  expect(promptFromArgs(["-v"])).toBe("")
})

test("promptFromArgs removes value flags + their values", () => {
  expect(promptFromArgs(["--cwd", "src", "refactor", "help"])).toBe("refactor help")
  expect(promptFromArgs(["--model", "gpt-4o-mini", "--timeout", "1000", "build"])).toBe("build")
  expect(promptFromArgs(["refactor", "--max-steps", "5"])).toBe("refactor --max-steps 5")
  expect(promptFromArgs(["--max-steps", "5", "refactor"])).toBe("refactor")
})

test("promptFromArgs keeps prompt words resembling negative numbers", () => {
  expect(promptFromArgs(["-123", "x"])).toBe("-123 x")
})

// ── C12 regressions ──────────────────────────────────────────────────────────

test("--verify is a known boolean flag, not prompt text", () => {
  expect(promptFromArgs(["fix bugs", "--verify"])).toBe("fix bugs --verify")
  expect(promptFromArgs(["--verify", "fix bugs"])).toBe("fix bugs")
})

test("supports --flag=value form in prompt filtering", () => {
  expect(promptFromArgs(["hi", "--model=gpt-4o", "--cwd=src"])).toBe("hi --model=gpt-4o --cwd=src")
  expect(promptFromArgs(["--model=gpt-4o", "--cwd=src", "hi"])).toBe("hi")
})

test("getArg supports --flag=value form", () => {
  expect(getArg(["--model=gpt-4o", "run"], "--model")).toBe("gpt-4o")
  expect(getArg(["--budget=5", "run"], "--budget")).toBe("5")
  expect(getArg(["run", "--model=gpt-4o"], "--model")).toBeUndefined()
  expect(getArg(["run", "--model="], "--model")).toBeUndefined()
})

test("repeated value flags are all filtered from the prompt", () => {
  expect(promptFromArgs(["--cwd", "a", "--cwd", "b", "do it"])).toBe("do it")
  expect(promptFromArgs(["do it", "--cwd", "a"])).toBe("do it --cwd a")
  // last occurrence wins (konsisten dgn getArg baru)
  expect(getArg(["--cwd", "a", "--cwd", "b"], "--cwd")).toBe("b")
  expect(getArg(["do it", "--cwd", "a"], "--cwd")).toBeUndefined()
})

// Regresi: `exec` dulu menyaring prompt dengan `a !== getArg("--model")`, yang
// hanya membuang NILAI dari dua flag. Nilai flag lain ikut terkirim ke model:
// `exec "tes" --provider gorouter --timeout 60000` benar-benar mengirim
// "tes gorouter 60000", dan model membalas menebak-nebak soal "gorouter".
test("nilai SEMUA value flag dibuang dari prompt, bukan hanya --model/--cwd", () => {
  expect(
    promptFromArgs([
      "--provider",
      "gorouter",
      "--session",
      "uji",
      "--timeout",
      "60000",
      "--ratelimit",
      "10",
      "--budget",
      "5",
      "--sandbox",
      "docker",
      "--max-steps",
      "3",
      "--context-window",
      "8000",
      "--resume",
      "abc",
      "ulangi",
      "persis",
    ]),
  ).toBe("ulangi persis")
  expect(promptFromArgs(["ulangi", "persis", "--provider", "gorouter", "--timeout", "60000"])).toBe(
    "ulangi persis --provider gorouter --timeout 60000",
  )
})

test("flag khusus exec (--json, --output-format, --prompt) tidak masuk prompt", () => {
  expect(promptFromArgs(["--json", "tes"])).toBe("tes")
  expect(promptFromArgs(["tes", "--json"])).toBe("tes --json")
  expect(promptFromArgs(["--output-format", "json", "tes"])).toBe("tes")
  expect(promptFromArgs(["tes", "--output-format", "json"])).toBe("tes --output-format json")
  expect(promptFromArgs(["tes", "--output-format=json"])).toBe("tes --output-format=json")
  expect(promptFromArgs(["--prompt", "dari-flag"])).toBe("")
  expect(promptFromArgs(["--output-format=json", "tes"])).toBe("tes")
})

test("bentuk --flag=value juga dibuang untuk semua value flag", () => {
  expect(promptFromArgs(["--provider=gorouter", "--timeout=1000", "kerjakan"])).toBe("kerjakan")
  expect(promptFromArgs(["kerjakan", "--provider=gorouter", "--timeout=1000"])).toBe(
    "kerjakan --provider=gorouter --timeout=1000",
  )
})

// ── [Live Hardening 0.13.x §8.3] flags after prompt boundary ──────────────────

test("flagsAfterPromptBoundary mendeteksi flag dikenal setelah kata prompt pertama", () => {
  // Kasus stage5: prompt paling depan, flag runtime setelahnya → dibuang diam-diam.
  expect(flagsAfterPromptBoundary(["self-repair", "--resume", "minipulse-a4"])).toEqual([
    "--resume",
  ])
  expect(
    flagsAfterPromptBoundary(["self-repair", "--cwd", "src", "--allow-all", "--timeout", "60"]),
  ).toEqual(["--cwd", "--allow-all", "--timeout"])
  expect(flagsAfterPromptBoundary(["self-repair", "--work-mode", "PLAN"])).toEqual(["--work-mode"])
})

test("flagsAfterPromptBoundary kosong bila flag sebelum prompt", () => {
  expect(flagsAfterPromptBoundary(["--resume", "minipulse-a4"])).toEqual([])
  expect(flagsAfterPromptBoundary(["--cwd", "src", "--allow-all", "kerjakan"])).toEqual([])
  expect(flagsAfterPromptBoundary([])).toEqual([])
})

test("flagsAfterPromptBoundary menghargai separator --", () => {
  expect(flagsAfterPromptBoundary(["--work-mode", "PLAN", "--", "--model", "x"])).toEqual([
    "--model",
  ])
})

test("flagsAfterPromptBoundary melewati nilai flag bentuk --flag=value dan dedupe", () => {
  // value flag setelah boundary: nilai berikutnya bukan flag dikenal.
  expect(flagsAfterPromptBoundary(["p", "--model", "gpt-4o"])).toEqual(["--model"])
  // bentuk =value dinormalisasi ke nama flag.
  expect(flagsAfterPromptBoundary(["p", "--model=gpt-4o"])).toEqual(["--model"])
  // flag berulang di-dedupe menjaga urutan.
  expect(
    flagsAfterPromptBoundary(["p", "--model", "x", "--model", "y", "--work-mode", "PLAN"]),
  ).toEqual(["--model", "--work-mode"])
})
