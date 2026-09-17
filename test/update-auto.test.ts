// Auto-update interaktif: keputusan murni harus fail-closed (tak ada skenario
// yang me-restart loop, menyentuh npm dari checkout source, atau mengganggu
// mode machine/CI). Install runner di-inject agar tanpa efek samping.

import { describe, expect, test } from "bun:test"
import {
  installUpdate,
  isInstalledCopy,
  isNewer,
  shouldAutoUpdate,
  UPDATE_GUARD_ENV,
} from "../src/policy/update-check.ts"

const BASE_ENV = {
  PATH: "/usr/bin",
}

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: Record<string, string | undefined> = { ...BASE_ENV }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete e[k]
    else e[k] = v
  }
  return e as NodeJS.ProcessEnv
}

const HAPPY = { stdinTTY: true, env: env(), installed: true }

describe("shouldAutoUpdate", () => {
  test("REPL TTY ter-install = jalan", () => {
    expect(shouldAutoUpdate([], HAPPY)).toEqual({ run: true })
  })

  test("opt-out env selalu menang", () => {
    for (const e of [
      env({ NO_UPDATE_CHECK: "1" }),
      env({ CI: "1" }),
      env({ MINICODE_AUTO_UPDATE: "0" }),
      env({ MINICODE_AUTO_UPDATE: "off" }),
    ]) {
      expect(shouldAutoUpdate([], { ...HAPPY, env: e }).run).toBe(false)
    }
  })

  test("guard restart mencegah loop", () => {
    const d = shouldAutoUpdate([], { ...HAPPY, env: env({ [UPDATE_GUARD_ENV]: "1" }) })
    expect(d).toEqual({ run: false, reason: "already-restarted" })
  })

  test("non-TTY / checkout source / mode machine = skip", () => {
    expect(shouldAutoUpdate([], { ...HAPPY, stdinTTY: false }).run).toBe(false)
    expect(shouldAutoUpdate([], { ...HAPPY, installed: false }).run).toBe(false)
    expect(shouldAutoUpdate(["exec", "x", "--json"], HAPPY).run).toBe(false)
    expect(shouldAutoUpdate(["--json"], HAPPY).run).toBe(false)
    expect(shouldAutoUpdate(["--help"], HAPPY).run).toBe(false)
    expect(shouldAutoUpdate(["-v"], HAPPY).run).toBe(false)
  })

  test("prompt one-shot biasa tetap layak (REPL gate di driver, bukan di sini)", () => {
    // shouldAutoUpdate tidak membedakan REPL vs one-shot — pemanggil
    // (cli/index.ts) hanya memanggilnya di jalur enterRepl.
    expect(shouldAutoUpdate(["kerjakan x"], HAPPY)).toEqual({ run: true })
  })
})

describe("isNewer", () => {
  test("semver 3 segmen", () => {
    expect(isNewer("0.9.8", "0.9.9")).toBe(true)
    expect(isNewer("0.9.9", "0.9.9")).toBe(false)
    expect(isNewer("0.10.0", "0.9.9")).toBe(false)
    expect(isNewer("1.0.0", "0.99.99")).toBe(false)
  })
})

describe("isInstalledCopy", () => {
  test("path node_modules = ter-install; path source = bukan", () => {
    expect(isInstalledCopy("/x/node_modules/minicode/cli/index.ts")).toBe(true)
    expect(isInstalledCopy("C:\\npm\\node_modules\\@miniroom\\minicode\\cli\\index.ts")).toBe(true)
    expect(isInstalledCopy("/repo/minicode/cli/index.ts")).toBe(false)
    expect(isInstalledCopy("")).toBe(false)
  })
})

describe("installUpdate", () => {
  test("pakai npm install -g @latest; true hanya bila exit 0", () => {
    const seen: string[][] = []
    const ok = installUpdate((cmd, args) => {
      seen.push([cmd, ...args])
      return { status: 0 }
    })
    expect(ok).toBe(true)
    expect(seen).toEqual([["npm", "install", "-g", "minicode-ai@latest"]])
    expect(installUpdate(() => ({ status: 1 }))).toBe(false)
    expect(
      installUpdate(() => {
        throw new Error("npm hilang")
      }),
    ).toBe(false)
  })
})
