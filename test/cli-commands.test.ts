import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleBuiltinCommand } from "../cli/commands.ts"
import { saveSession } from "../src/session/persistence.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

// Sebagian test tanpa harness (jalur cetak) menegaskan label Inggris.
beforeEach(() => setSessionLocale("en"))
afterEach(() => resetLocaleState())

let tty: FakeTty | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
})

function dummyCtx(extra: { setModelOverride?: (m: string) => void } = {}) {
  const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.001 }
  return {
    sessionId: "test-sess",
    currentModel: "gpt-4o",
    usage: {
      get: () => usage,
      getSession: () => usage,
      reset: () => {},
      modelUsed: () => ({ effective: undefined, provider: undefined }),
    },
    skills: [],
    toolsCount: 20,
    setModelOverride: extra.setModelOverride ?? (() => {}),
    // Kontrak control-plane (Phase 6): /status membedakan Context vs Usage vs
    // Budget — dummy menyediakan angka tetap.
    getContextTokens: () => 1024,
    budgetState: () => "ok" as const,
  }
}

test("commands: non-slash input returns handled: false", async () => {
  const res = await handleBuiltinCommand("hello world", dummyCtx())
  expect(res.handled).toBe(false)
})

test("commands: BUILTIN_COMMANDS name tidak boleh berisi placeholder args", () => {
  const { BUILTIN_COMMANDS } = require("../cli/commands.ts") as {
    BUILTIN_COMMANDS: { name: string; args?: string }[]
  }
  for (const b of BUILTIN_COMMANDS) {
    expect(b.name).not.toMatch(/[<[\s]/)
  }
})

test("commands: /model opens the model manager", async () => {
  const res = await handleBuiltinCommand("/model", dummyCtx())
  expect(res.handled).toBe(true)
})

test("commands: /help, /status, /model, /exit are handled", async () => {
  const ctx = dummyCtx()

  const resHelp = await handleBuiltinCommand("/help", ctx)
  expect(resHelp.handled).toBe(true)

  const resModel = await handleBuiltinCommand("/model", ctx)
  expect(resModel.handled).toBe(true)

  const resExit = await handleBuiltinCommand("/exit", ctx)
  expect(resExit.handled).toBe(true)
  expect(resExit.shouldExit).toBe(true)
})

test("commands: /sessions lists saved sessions with cwd", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "minicode-sess-"))
  await saveSession("sess-1", tmp, undefined, [{ role: "user", content: "hi" }], { inputTokens: 1 })
  const ctx = { ...dummyCtx(), cwd: tmp }
  const res = await handleBuiltinCommand("/sessions", ctx)
  expect(res.handled).toBe(true)
  rmSync(tmp, { recursive: true, force: true })
})

test("commands: /sessions with an unknown id fails gracefully", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "minicode-resume-"))
  const ctx = { ...dummyCtx(), cwd: tmp }
  const res = await handleBuiltinCommand("/sessions no-such-id", ctx)
  expect(res.handled).toBe(true)
  rmSync(tmp, { recursive: true, force: true })
})

test("commands: /resume <id> alias /sessions <id> (bukan sunyi)", async () => {
  // Gagal-di-kode-lama: /resume jatuh ke default → handled:false → TUI sunyi
  // total (tidak tercatat, tidak spawn).
  const tmp = mkdtempSync(join(tmpdir(), "minicode-resume2-"))
  const ctx = { ...dummyCtx(), cwd: tmp }
  const res = await handleBuiltinCommand("/resume no-such-id", ctx)
  expect(res.handled).toBe(true)
  rmSync(tmp, { recursive: true, force: true })
})

test("commands: /resume tanpa arg dikembalikan (ditangani TUI popup)", async () => {
  const ctx = dummyCtx()
  const res = await handleBuiltinCommand("/resume", ctx)
  expect(res.handled).toBe(false)
})

test("commands: /sessions TTY membuka picker overlay, Esc batal bersih", async () => {
  // Kode lama: tabel + "Select a session to resume." dicetak ke scrollback.
  // Kode baru: picker transient, batal tanpa jejak cetak dan tanpa spawn.
  // Isolasi DB lokal (mkdir .minicode) seperti repl-linear: tanpa itu daftar
  // global mesin ikut tampil; kolom lebar agar id tak terpotong.
  tty = installFakeTty({ columns: 100, rows: 24 })
  const tmp = mkdtempSync(join(tmpdir(), "minicode-sesspick-"))
  mkdirSync(join(tmp, ".minicode"), { recursive: true })
  await saveSession("sess-pick", tmp, undefined, [{ role: "user", content: "hi" }], {
    inputTokens: 1,
  })
  const ctx = { ...dummyCtx(), cwd: tmp }
  const p = handleBuiltinCommand("/sessions", ctx)
  await tty.ready()
  expect(stripAnsi(tty.all())).toContain("sess-pick")
  await tty.send(KEY.esc, 80)
  const res = await p
  expect(res.handled).toBe(true)
  // Tanpa tabel cetak versi lama.
  expect(stripAnsi(tty.all())).not.toContain("Select a session to resume.")
  // DB sqlite lokal masih terbuka di Windows (EBUSY) — biarkan OS
  // membersihkan tmp (pola yang sama di repl-linear.test.ts).
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {}
})

test("commands: /status selalu mencetak readout (tanpa jendela)", async () => {
  // Jendela info dihapus bersama REPL linier: /status mencetak langsung —
  // di TUI ditangkap ke transkrip, di one-shot ke scrollback.
  tty = installFakeTty({ rows: 24 })
  const ctx = dummyCtx()
  const res = await handleBuiltinCommand("/status", ctx)
  expect(res.handled).toBe(true)
  const out = stripAnsi(tty.all())
  expect(out).toContain("Session test-sess")
  expect(out).toContain("Model:")
})
