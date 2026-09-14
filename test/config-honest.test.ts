// Kejujuran provisioning + hermetic config (audit ronde 2).
// - 401/403 key salah: detect menandai authFailed; add MELEMPAR (bukan
//   "Saved" dengan fallback); sync mencatat failed (bukan diam).
// - globalConfigPath() hormat MINICODE_HOME saat runtime (bukan beku import).
// - config add default GLOBAL; override lokal tak mengubah urutan;
//   error baca non-ENOENT berisik (bukan "no providers" diam).
// - detectAndSave membuang cache dulu agar retry key langsung re-fetch.
//
// Hermetic: MINICODE_HOME selalu ke tmp; satu test yang menyentuh home asli
// (roundtrip global) mencadangkan + mengembalikan seperti sync.test.ts.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const origFetch = globalThis.fetch
const stubFetch = (status: number, body: unknown) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}
afterEach(() => {
  globalThis.fetch = origFetch
})

function hermeticHome(): { home: string; prev: string | undefined } {
  const home = mkdtempSync(join(tmpdir(), "minicode-honest-"))
  const prev = process.env.MINICODE_HOME
  process.env.MINICODE_HOME = home
  return { home, prev }
}
function unhermetic(prev: string | undefined, dirs: string[]) {
  if (prev === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = prev
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
}

describe("detect jujur soal 401", () => {
  test("401 → authFailed true, models kosong", async () => {
    const { clearDetectCache, detectModels } = await import("../src/providers/detect.ts")
    clearDetectCache()
    stubFetch(401, { error: "invalid key" })
    const r = await detectModels("https://auth401.test/v1", "salah")
    expect(r.models).toEqual([])
    expect(r.authFailed).toBe(true)
    clearDetectCache()
  })

  test("404 (tanpa endpoint ala Anthropic) → authFailed false", async () => {
    const { clearDetectCache, detectModels } = await import("../src/providers/detect.ts")
    clearDetectCache()
    stubFetch(404, { error: "not found" })
    const r = await detectModels("https://noendpoint.test/v1", "k")
    expect(r.models).toEqual([])
    expect(r.authFailed).toBe(false)
    clearDetectCache()
  })
})

describe("detectAndSave menolak key salah", () => {
  test("401 + fallback TETAP melempar unauthorized; tak ada file tertulis", async () => {
    const { clearDetectCache } = await import("../src/providers/detect.ts")
    const { detectAndSave } = await import("../src/providers/provision.ts")
    clearDetectCache()
    stubFetch(401, { error: "invalid key" })
    const cwd = mkdtempSync(join(tmpdir(), "minicode-add401-"))
    try {
      await expect(
        detectAndSave("https://add401.test/v1", "salah", "t401", {
          global: false,
          cwd,
          fallbackModels: ["fb"],
        }),
      ).rejects.toThrow(/unauthorized/)
      expect(existsSync(join(cwd, ".minicode", "config.json"))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      clearDetectCache()
    }
  })

  test("retry key terkoreksi langsung re-fetch (tanpa cache basi)", async () => {
    const { clearDetectCache } = await import("../src/providers/detect.ts")
    const { detectAndSave } = await import("../src/providers/provision.ts")
    clearDetectCache()
    const url = "https://retrykey.test/v1"
    stubFetch(200, { data: [{ id: "lama" }] })
    const cwd = mkdtempSync(join(tmpdir(), "minicode-retry-"))
    try {
      const first = await detectAndSave(url, "k1", "t6", { global: false, cwd })
      expect(first.models).toEqual(["lama"])
      stubFetch(200, { data: [{ id: "baru" }] })
      const second = await detectAndSave(url, "k2", "t6", { global: false, cwd })
      // Kode lama: cache 30 menit menyajikan ["lama"] di sini.
      expect(second.models).toEqual(["baru"])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      clearDetectCache()
    }
  })
})

describe("sync mencatat 401 sebagai failed", () => {
  test("provider 401 → failed unauthorized, updated kosong", async () => {
    const { home, prev } = hermeticHome()
    // Hermetic penuh: global di home palsu agar config mesin tak tersentuh.
    mkdirSync(join(home, ".minicode"), { recursive: true })
    writeFileSync(
      join(home, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "bad", baseUrl: "https://sync401.test/v1", apiKey: "k", models: ["m"] }],
      }),
    )
    const { clearDetectCache } = await import("../src/providers/detect.ts")
    const { refreshProviderModels } = await import("../src/providers/provision.ts")
    clearDetectCache()
    stubFetch(401, { error: "invalid key" })
    try {
      const { updated, failed } = await refreshProviderModels({})
      expect(updated).toEqual([])
      expect(failed.length).toBe(1)
      expect(failed[0]?.id).toBe("bad")
      expect(failed[0]?.reason).toMatch(/unauthorized/)
    } finally {
      clearDetectCache()
      unhermetic(prev, [home])
    }
  })
})

describe("config add default ke global", () => {
  test("tanpa --local → tertulis di global, bukan .minicode repo", async () => {
    const { home, prev } = hermeticHome()
    const { dispatch } = await import("../cli/router.ts")
    const { clearDetectCache } = await import("../src/providers/detect.ts")
    clearDetectCache()
    stubFetch(200, { data: [{ id: "m1" }] })
    const cwd = mkdtempSync(join(tmpdir(), "minicode-adddef-"))
    const args = [
      "config",
      "add",
      "--baseUrl",
      "https://adddef.test/v1",
      "--apiKey",
      "k",
      "--id",
      "tadd",
      "--cwd",
      cwd,
    ]
    const getArg = ((name: string): string | undefined => {
      const i = args.indexOf(name)
      if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1]
      const eq = args.find((a) => a.startsWith(`${name}=`))
      return eq ? eq.slice(name.length + 1) : undefined
    }) as (name: string) => string | undefined
    const origExit = process.exit
    let code = -1
    process.exit = ((c?: number) => {
      code = c ?? 0
      throw new Error(`exit:${code}`)
    }) as unknown as typeof process.exit
    try {
      await dispatch(args, getArg, "HELP").catch((e: Error) => {
        if (!String(e.message).startsWith("exit:")) throw e
      })
      expect(code).toBe(0)
      // Kode lama (default local): tertulis di repo — assertion ini gagal.
      expect(existsSync(join(cwd, ".minicode", "config.json"))).toBe(false)
      const g = JSON.parse(readFileSync(join(home, ".minicode", "config.json"), "utf8")) as {
        providers: { id: string }[]
      }
      expect(g.providers.map((p) => p.id)).toContain("tadd")
    } finally {
      process.exit = origExit
      clearDetectCache()
      unhermetic(prev, [home, cwd])
    }
  })
})

describe("globalConfigPath hermetic", () => {
  test("save/load global mengikuti MINICODE_HOME saat runtime", async () => {
    // Cadangkan home asli: kode lama mengabaikan MINICODE_HOME dan MENULIS
    // ke sini — tanpa backup test gagal-di-kode-lama merusak mesin.
    const realPath = join(homedir(), ".minicode", "config.json")
    const realBak = `${realPath}.bak-honest-test`
    const hadReal = existsSync(realPath)
    if (hadReal) {
      try {
        mkdirSync(join(homedir(), ".minicode"), { recursive: true })
      } catch {}
      writeFileSync(realBak, readFileSync(realPath))
    }
    const { home, prev } = hermeticHome()
    try {
      const { saveProvider } = await import("../src/providers/provision.ts")
      const { globalConfigPath, loadConfig } = await import("../src/config.ts")
      expect(globalConfigPath()).toBe(join(home, ".minicode", "config.json"))
      await saveProvider(
        { id: "herm", baseUrl: "https://h.test/v1", apiKey: "k", models: ["m"] },
        { global: true },
      )
      const cfg = await loadConfig(process.cwd())
      expect(cfg.providers.map((p) => p.id)).toContain("herm")
      expect(
        JSON.parse(readFileSync(join(home, ".minicode", "config.json"), "utf8")).providers,
      ).toHaveLength(1)
    } finally {
      unhermetic(prev, [home])
      try {
        if (hadReal) {
          writeFileSync(realPath, readFileSync(realBak))
          rmSync(realBak, { force: true })
        }
      } catch {}
    }
  })

  test("override lokal mengganti nilai di posisi global (tanpa flip default)", async () => {
    const { home, prev } = hermeticHome()
    mkdirSync(join(home, ".minicode"), { recursive: true })
    writeFileSync(
      join(home, ".minicode", "config.json"),
      JSON.stringify({
        providers: [
          { id: "a", baseUrl: "https://a.test/v1", apiKey: "k", models: ["ma"] },
          { id: "b", baseUrl: "https://b.test/v1", apiKey: "k", models: ["mb"] },
          { id: "c", baseUrl: "https://c.test/v1", apiKey: "k", models: ["mc"] },
        ],
      }),
    )
    const cwd = mkdtempSync(join(tmpdir(), "minicode-order-"))
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    writeFileSync(
      join(cwd, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "b", baseUrl: "https://b.test/v1", apiKey: "k", models: ["mb2"] }],
      }),
    )
    try {
      const { loadConfig } = await import("../src/config.ts")
      const cfg = await loadConfig(cwd, { allowLocal: true })
      // Kode lama: [a, c, b] — default providers[0] ikut berubah bila yang
      // di-override adalah [0]; di sini b tetap di indeks 1.
      expect(cfg.providers.map((p) => p.id)).toEqual(["a", "b", "c"])
      expect(cfg.providers[1]?.models).toEqual(["mb2"])
    } finally {
      unhermetic(prev, [home, cwd])
    }
  })

  test("config global tak terbaca (bukan ENOENT) → warn + kosong", async () => {
    const { home, prev } = hermeticHome()
    // Jadikan path config sebuah DIREKTORI: readFile → EISDIR.
    mkdirSync(join(home, ".minicode", "config.json"), { recursive: true })
    const errs: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    ;(process.stderr as unknown as { write: unknown }).write = (c: string | Uint8Array) => {
      errs.push(typeof c === "string" ? c : new TextDecoder().decode(c))
      return true
    }
    try {
      const { loadConfig } = await import("../src/config.ts")
      const cfg = await loadConfig(process.cwd())
      expect(cfg.providers).toEqual([])
      expect(errs.join("")).toMatch(/cannot read/)
    } finally {
      ;(process.stderr as unknown as { write: unknown }).write = origWrite
      unhermetic(prev, [home])
    }
  })
})
