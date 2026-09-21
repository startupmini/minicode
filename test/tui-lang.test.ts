// Integrasi /lang end-to-end (driver cli/tui.ts + TuiApp + state.json):
// ketik "/lang id" → locale sesi berubah + tersimpan; sesi berikut baca.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliSession } from "../cli/setup.ts"
import { runTui } from "../cli/tui.ts"
import { loadLang } from "../src/config.ts"
import { currentLocale, resetLocaleState } from "../src/ui/i18n/locale.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
const tmpRoots: string[] = []
let prevHome: string | undefined
let prevLang: string | undefined

beforeEach(() => {
  resetLocaleState()
  prevHome = process.env.MINICODE_HOME
  prevLang = process.env.MINICODE_LANG
  delete process.env.MINICODE_LANG
  delete process.env.LANG
  delete process.env.LC_ALL
  const home = mkdtempSync(join(tmpdir(), "minicode-lang-"))
  tmpRoots.push(home)
  process.env.MINICODE_HOME = home
})

afterEach(() => {
  tty?.restore()
  tty = null
  resetLocaleState()
  if (prevHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = prevHome
  if (prevLang === undefined) delete process.env.MINICODE_LANG
  else process.env.MINICODE_LANG = prevLang
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fakeSession() {
  const bus = createFakeBus()
  const noop = async () => {}
  return {
    session: { events: bus, contextTokens: 0 },
    cfg: { providers: [] },
    cwd: tmpdir(),
    sessionId: "lang-test",
    modelRef: {} as { current?: string },
    permissionMode: "auto",
    permissions: undefined,
    sessionTools: [],
    allLoadedSkills: [],
    allowLocalConfig: false,
    usage: {
      get: () => ({}),
      getSession: () => ({ cost: undefined, totalTokens: 0 }),
      reset: () => {},
    },
    budget: undefined,
    budgetStrict: false,
    persistCurrent: noop,
    runPromptWithVerify: noop,
    close: noop,
  } as unknown as CliSession
}

describe("/lang end-to-end", () => {
  test("/lang id ganti locale sesi + simpan permanen", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession())
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("minicode"))
    expect(currentLocale()).toBe("en")
    await tty.send("/lang id")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("lang: id"))
    expect(currentLocale()).toBe("id")
    expect(await loadLang()).toBe("id")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })
  test("/lang tanpa argumen tampilkan aktif; argumen asing ditolak", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession())
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("minicode"))
    await tty.send("/lang")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("lang: en"))
    await tty.send("/lang xx")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("unknown lang"))
    expect(currentLocale()).toBe("en")
    expect(await loadLang()).toBeUndefined()
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })
  test("/help ringkas memuat semua perintah terdaftar (satu sumber)", async () => {
    const { BUILTIN_COMMANDS } = await import("../cli/commands.ts")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession())
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("minicode"))
    await tty.send("/help")
    await tty.send(KEY.enter)
    const out = await tty.waitForOutput((o) => o.includes("Commands:"))
    for (const b of BUILTIN_COMMANDS) expect(out, b.name).toContain(`/${b.name}`)
    for (const n of ["/mode", "/lang", "/compact", "/expand", "/minimize"])
      expect(out, n).toContain(n)
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })
})
