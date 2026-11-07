// Hardening F-23: resolusi executable terpercaya (anti hijack CWD Windows)
// dipakai di semua spawn host; seam sandbox fail-closed.
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { resolveTrustedExecutable } from "../src/lib/trusted-exec.ts"
import { osSandboxAvailable, runInOsSandbox } from "../src/sandbox/os.ts"

const gitAvailable =
  spawnSync("git", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0

test("F-23: biner di PATH ter-resolve absolut, bukan nama telanjang", () => {
  if (!gitAvailable) return
  const r = resolveTrustedExecutable("git")
  expect(isAbsolute(r)).toBe(true)
})

test("F-23: CWD tak pernah dikonsultasikan", () => {
  // Berkas/executable di direktori kerja dengan nama yang sama TIDAK boleh
  // memengaruhi resolusi (inilah hijack CWD Windows: cwd menang atas PATH).
  const dir = mkdtempSync(join(tmpdir(), "mc-hijack-"))
  try {
    writeFileSync(join(dir, "minicode-probe-bintidakada-xyz"), "x")
    writeFileSync(join(dir, "minicode-probe-bintidakada-xyz.bat"), "x")
    const r = resolveTrustedExecutable("minicode-probe-bintidakada-xyz")
    expect(r).toBe("minicode-probe-bintidakada-xyz")
    expect(isAbsolute(r)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F-23: PATHEXT Windows diuji juga di host non-Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-trusted-win-"))
  const name = `minicode-win-probe-${process.pid}-${Date.now()}`
  const executable = join(dir, `${name}.EXE`)
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
  const originalPath = process.env.PATH
  const originalPathExt = process.env.PATHEXT
  writeFileSync(executable, "probe")
  try {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" })
    process.env.PATH = dir
    process.env.PATHEXT = ".EXE;.CMD"
    expect(resolveTrustedExecutable(name)).toBe(executable)
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalPathExt === undefined) delete process.env.PATHEXT
    else process.env.PATHEXT = originalPathExt
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F-23: nama absolut / ber-separator diteruskan apa adanya", () => {
  expect(resolveTrustedExecutable("/usr/bin/git")).toBe("/usr/bin/git")
  expect(resolveTrustedExecutable("./scripts/x")).toBe("./scripts/x")
})

test("F-23: runInOsSandbox tanpa backend menolak (fail-closed seam)", async () => {
  if (osSandboxAvailable()) return
  await expect(runInOsSandbox("echo hi", tmpdir())).rejects.toThrow(/not available/)
})
