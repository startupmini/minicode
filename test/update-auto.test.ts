// Auto-update interaktif: keputusan murni harus fail-closed (tak ada skenario
// yang me-restart loop, menyentuh npm dari checkout source, atau mengganggu
// mode machine/CI). Install runner di-inject agar tanpa efek samping.

import { describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  installUpdate,
  isInstalledCopy,
  isNewer,
  shouldAutoUpdate,
  UPDATE_GUARD_ENV,
  verifyInstalledVersion,
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
  test("verifikasi signature/provenance dahulu, lalu memasang versi tepat", () => {
    const seen: { args: string[]; cwd?: string }[] = []
    const ok = installUpdate("1.2.3", (cmd, args, opts) => {
      expect(cmd).toBe("npm")
      seen.push({ args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) })
      if (args[0] === "install" && opts?.cwd) {
        writeFileSync(
          join(opts.cwd, "package-lock.json"),
          JSON.stringify({ packages: { "": {}, "node_modules/minicode-ai": {} } }),
        )
      }
      return { status: 0 }
    })
    expect(ok).toBe(true)
    expect(seen).toHaveLength(3)
    expect(seen[0]?.args).toContain("minicode-ai@1.2.3")
    expect(seen[0]?.args).toContain("--ignore-scripts")
    expect(seen[1]?.args.slice(0, 2)).toEqual(["audit", "signatures"])
    expect(seen[2]?.args).toContain("-g")
    expect(seen[2]?.args).toContain("minicode-ai@1.2.3")
    expect(seen[0]?.cwd).toBeDefined()
    expect(seen[1]?.cwd).toBe(seen[0]?.cwd)
    expect(seen[0]?.cwd && existsSync(seen[0].cwd)).toBe(false)
  })

  test("signature failure blocks global install; temp verification root is cleaned", () => {
    const seen: { args: string[]; cwd?: string }[] = []
    let calls = 0
    expect(
      installUpdate("1.2.3", (cmd, args, opts) => {
        expect(cmd).toBe("npm")
        seen.push({ args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) })
        calls++
        if (args[0] === "install" && opts?.cwd) {
          writeFileSync(
            join(opts.cwd, "package-lock.json"),
            JSON.stringify({ packages: { "": {}, "node_modules/minicode-ai": {} } }),
          )
        }
        return { status: calls === 2 ? 1 : 0 }
      }),
    ).toBe(false)
    expect(seen).toHaveLength(2)
    expect(seen[0]?.cwd).toBeDefined()
    expect(seen[1]?.cwd).toBe(seen[0]?.cwd)
    expect(seen[1]?.args.slice(0, 2)).toEqual(["audit", "signatures"])
    expect(seen[0]?.cwd && existsSync(seen[0].cwd)).toBe(false)
  })

  test("unexpected runtime dependency graph blocks global install", () => {
    let calls = 0
    const roots: string[] = []
    expect(
      installUpdate("1.2.3", (_cmd, _args, opts) => {
        calls++
        if (opts?.cwd) {
          roots.push(opts.cwd)
          writeFileSync(
            join(opts.cwd, "package-lock.json"),
            JSON.stringify({
              packages: {
                "": {},
                "node_modules/minicode-ai": {},
                "node_modules/new-runtime-dependency": {},
              },
            }),
          )
        }
        return { status: 0 }
      }),
    ).toBe(false)
    expect(calls).toBe(1)
    expect(roots[0] && existsSync(roots[0])).toBe(false)
  })

  test("install exit failure or runner error returns false", () => {
    expect(installUpdate("1.2.3", () => ({ status: 1 }))).toBe(false)
    expect(
      installUpdate("1.2.3", () => {
        throw new Error("npm hilang")
      }),
    ).toBe(false)
  })

  test("global install failure is reported after successful signature verification", () => {
    let calls = 0
    expect(
      installUpdate("1.2.3", (_cmd, args, opts) => {
        calls++
        if (args[0] === "install" && opts?.cwd) {
          writeFileSync(
            join(opts.cwd, "package-lock.json"),
            JSON.stringify({ packages: { "": {}, "node_modules/minicode-ai": {} } }),
          )
        }
        return { status: calls < 3 ? 0 : 1 }
      }),
    ).toBe(false)
    expect(calls).toBe(3)
  })

  test("menolak target non-SemVer sebelum menjalankan npm", () => {
    let called = false
    expect(
      installUpdate("latest; whoami", () => {
        called = true
        return { status: 0 }
      }),
    ).toBe(false)
    expect(called).toBe(false)
  })
})

describe("verifyInstalledVersion", () => {
  test("restart hanya layak bila package.json yang dibaca cocok dengan target", () => {
    expect(verifyInstalledVersion("1.2.3", () => "1.2.3")).toBe(true)
    expect(verifyInstalledVersion("1.2.3", () => "1.2.2")).toBe(false)
    expect(
      verifyInstalledVersion("1.2.3", () => {
        throw new Error("unreadable")
      }),
    ).toBe(false)
  })
})
