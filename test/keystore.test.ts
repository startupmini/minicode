// Keystore OS (DPAPI Windows + fallback file): hermetic via MINICODE_HOME
// tmp + runner yang di-inject. Tanpa network, tanpa powershell asli.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetKeystoreForTest,
  __setKeystoreRunnerForTest,
  deleteSecret,
  getSecret,
  keystoreBackend,
  type SecretRunner,
  setSecret,
} from "../src/lib/keystore.ts"

const tmpRoots: string[] = []
const prevHome = process.env.MINICODE_HOME
const prevForce = process.env.MINICODE_KEYSTORE_FORCE_DPAPI
const prevDisable = process.env.MINICODE_KEYSTORE_DISABLE

function useHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "minicode-ks-"))
  tmpRoots.push(dir)
  process.env.MINICODE_HOME = dir
  return dir
}

afterEach(() => {
  __resetKeystoreForTest()
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true })
  if (prevHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = prevHome
  if (prevForce === undefined) delete process.env.MINICODE_KEYSTORE_FORCE_DPAPI
  else process.env.MINICODE_KEYSTORE_FORCE_DPAPI = prevForce
  if (prevDisable === undefined) delete process.env.MINICODE_KEYSTORE_DISABLE
  else process.env.MINICODE_KEYSTORE_DISABLE = prevDisable
})

// Fake DPAPI: transform reversibel deterministik (bukan keamanan beneran —
// yang diuji orkestrasinya, bukan kripto Windows).
const fakeDpapi: SecretRunner = (cmd, _args, input) => {
  void cmd
  if (input == null) return { status: 1, stdout: "" }
  if (input.startsWith("BLOB:")) return { status: 0, stdout: `${input.slice(5)}\n` }
  return { status: 0, stdout: `BLOB:${input}\n` }
}

describe("keystore dpapi (mocked)", () => {
  test("roundtrip set/get/delete via backend dpapi", async () => {
    useHome()
    process.env.MINICODE_KEYSTORE_FORCE_DPAPI = "1"
    __setKeystoreRunnerForTest(fakeDpapi)
    expect(keystoreBackend()).toBe("dpapi")
    expect(await setSecret("provider:x", "sk-SECRET")).toBe("dpapi")
    expect(await getSecret("provider:x")).toBe("sk-SECRET")
    // Cache: get kedua tanpa runner lagi tetap dapat.
    __setKeystoreRunnerForTest(() => {
      throw new Error("must not be called (cached)")
    })
    expect(await getSecret("provider:x")).toBe("sk-SECRET")
    __setKeystoreRunnerForTest(fakeDpapi)
    await deleteSecret("provider:x")
    expect(await getSecret("provider:x")).toBeNull()
  })

  test("runner gagal → setSecret null, getSecret null (tak melempar)", async () => {
    useHome()
    process.env.MINICODE_KEYSTORE_FORCE_DPAPI = "1"
    __setKeystoreRunnerForTest(() => ({ status: 1, stdout: "" }))
    expect(await setSecret("k", "v")).toBeNull()
    expect(await getSecret("k")).toBeNull()
    expect(await getSecret("")).toBeNull()
    expect(await setSecret("", "v")).toBeNull()
  })
})

describe("keystore plain fallback", () => {
  test("tanpa DPAPI = plain roundtrip + backend jujur", async () => {
    useHome()
    process.env.MINICODE_KEYSTORE_DISABLE = "1"
    expect(keystoreBackend()).toBe("plain-file")
    expect(await setSecret("provider:y", "sk-PLAIN")).toBe("plain")
    __resetKeystoreForTest()
    expect(await getSecret("provider:y")).toBe("sk-PLAIN")
  })
})

describe("keystore di buildProviderListAsync", () => {
  test("ref keystore: di-resolve; hilang = skip dengan peringatan", async () => {
    useHome()
    // Backend plain ( deterministik lintas-OS; jalur DPAPI diuji di atas).
    process.env.MINICODE_KEYSTORE_DISABLE = "1"
    const { buildProviderListAsync } = await import("../src/providers/build.ts")
    await setSecret("provider:zk", "sk-ZED")
    __resetKeystoreForTest()
    const errs: string[] = []
    // [P12 Stage 3] Reference, bukan `.bind(process.stderr)` — lihat catatan di
    // test/config-honest.test.ts: `.bind` membungkus writer yang terpasang
    // (bisa wrapper statusline) dan restore-nya revive rantai writer menumpuk.
    const prevErr = process.stderr.write
    ;(process.stderr as unknown as { write: unknown }).write = (c: unknown) => {
      errs.push(String(c))
      return true
    }
    try {
      const list = await buildProviderListAsync({
        providers: [
          {
            id: "zk",
            baseUrl: "https://z.example/v1",
            apiKey: "keystore:provider:zk",
            models: ["m"],
          },
          {
            id: "gone",
            baseUrl: "https://g.example/v1",
            apiKey: "keystore:provider:gone",
            models: ["m"],
          },
        ],
      })
      const ids = list.map((p) => (p as unknown as { id: string }).id)
      expect(ids).toContain("zk")
      expect(ids).not.toContain("gone")
      expect(errs.join("")).toContain("gone")
    } finally {
      process.stderr.write = prevErr
    }
  })
})
