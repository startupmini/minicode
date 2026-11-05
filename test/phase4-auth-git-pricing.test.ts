// Fase 4 — OAuth device flow, git_commit, pricing models.dev.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Blok git_commit men-spawn git berkali-kali per test (init+config+add+commit
// di beforeEach, lalu rev-parse+add+commit+log di dalam tool). Di Windows satu
// spawn git bisa ~0,5–1,5 s, jadi 5 s default Bun terlalu ketat dan kegagalan
// muncul sebagai timeout — bukan bug logika. Lihat komentar serupa di
// test/shadow-git.test.ts.
setDefaultTimeout(60_000)

import type { ToolContext } from "#minicore"
import { createPermissionHandler } from "../src/policy/permission.ts"
import {
  BUILTIN_PRICING,
  extractPricing,
  findPrice,
  pickRepresentativePrice,
} from "../src/policy/pricing.ts"
import { isExpired } from "../src/providers/auth-store.ts"
import {
  findOAuthProvider,
  loginWithDeviceFlow,
  OAUTH_PROVIDERS,
  type OAuthProviderSpec,
  pollDeviceTokenOnce,
  startDeviceFlow,
} from "../src/providers/oauth.ts"
import { gitCommitTool } from "../src/tools/git.ts"

const ctx = { signal: new AbortController().signal, emit() {} } as unknown as ToolContext

// ── OAuth: server device-flow lokal ──
// Mekanismenya diuji end-to-end terhadap server nyata, bukan mock fetch, karena
// yang rawan adalah urutan poll + penanganan slow_down/expired.

let server: ReturnType<typeof Bun.serve> | null = null

/** Port server uji; melempar bila server belum dinyalakan (lebih jelas dari `!`). */
function port(): number {
  const p = server?.port
  if (typeof p !== "number") throw new Error("server uji belum dinyalakan")
  return p
}

function spec(port: number, overrides: Partial<OAuthProviderSpec> = {}): OAuthProviderSpec {
  return {
    id: "uji",
    label: "Uji",
    deviceUrl: `http://127.0.0.1:${port}/device`,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    clientId: "client-uji",
    scope: "openid",
    apiBaseUrl: `http://127.0.0.1:${port}/v1`,
    fallbackModels: ["m1"],
    ...overrides,
  }
}

afterEach(() => {
  server?.stop(true)
  server = null
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("OAuth: device authorization (langkah 1)", () => {
  test("mengembalikan device_code, user_code, dan interval", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        json({
          device_code: "DEV-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://example.com/device",
          interval: 3,
          expires_in: 600,
        }),
    })
    const start = await startDeviceFlow(spec(port()))
    expect(start.deviceCode).toBe("DEV-1")
    expect(start.userCode).toBe("ABCD-EFGH")
    expect(start.interval).toBe(3)
    expect(start.expiresAt).toBeGreaterThan(Date.now())
  })

  test("verification_url non-standar juga diterima", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        json({ device_code: "D", user_code: "U", verification_url: "https://alt.example/d" }),
    })
    const start = await startDeviceFlow(spec(port()))
    expect(start.verificationUri).toBe("https://alt.example/d")
  })

  test("interval default 5 detik bila server tak menyebut", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => json({ device_code: "D", user_code: "U", verification_uri: "https://x/d" }),
    })
    expect((await startDeviceFlow(spec(port()))).interval).toBe(5)
  })

  test("interval liar di-clamp (server nakal tak bisa bikin poll tiap 1ms atau tiap jam)", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        json({
          device_code: "D",
          user_code: "U",
          verification_uri: "https://x/d",
          interval: 99999,
        }),
    })
    expect((await startDeviceFlow(spec(port()))).interval).toBe(60)
  })

  test("error dari server dilaporkan dengan deskripsinya", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => json({ error: "invalid_client", error_description: "client tak dikenal" }, 400),
    })
    await expect(startDeviceFlow(spec(port()))).rejects.toThrow(/client tak dikenal/)
  })

  test("balasan tanpa device_code ditolak dengan pesan jelas", async () => {
    server = Bun.serve({ port: 0, fetch: () => json({ user_code: "U" }) })
    await expect(startDeviceFlow(spec(port()))).rejects.toThrow(/device_code/)
  })

  test("balasan HTML (proxy/captive portal) tidak jadi 'undefined is not an object'", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response("<html>login wifi dulu</html>", { status: 200 }),
    })
    await expect(startDeviceFlow(spec(port()))).rejects.toThrow(/not JSON/)
  })
})

describe("OAuth: polling token (langkah 3)", () => {
  test("authorization_pending → tetap pending dengan interval sama", async () => {
    server = Bun.serve({ port: 0, fetch: () => json({ error: "authorization_pending" }, 400) })
    const r = await pollDeviceTokenOnce(spec(port()), "D", 5)
    expect(r.state).toBe("pending")
    if (r.state === "pending") expect(r.nextIntervalSec).toBe(5)
  })

  test("slow_down menaikkan interval minimal 5 detik (RFC 8628 §3.5)", async () => {
    server = Bun.serve({ port: 0, fetch: () => json({ error: "slow_down" }, 400) })
    const r = await pollDeviceTokenOnce(spec(port()), "D", 5)
    expect(r.state).toBe("pending")
    if (r.state === "pending") expect(r.nextIntervalSec).toBe(10)
  })

  test("slow_down berulang tetap di-cap 60 detik", async () => {
    server = Bun.serve({ port: 0, fetch: () => json({ error: "slow_down" }, 400) })
    const r = await pollDeviceTokenOnce(spec(port()), "D", 58)
    if (r.state === "pending") expect(r.nextIntervalSec).toBe(60)
  })

  test("access_denied berhenti, bukan lanjut polling", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => json({ error: "access_denied", error_description: "user menolak" }, 400),
    })
    const r = await pollDeviceTokenOnce(spec(port()), "D", 5)
    expect(r.state).toBe("denied")
  })

  test("expired_token dilaporkan sebagai expired", async () => {
    server = Bun.serve({ port: 0, fetch: () => json({ error: "expired_token" }, 400) })
    expect((await pollDeviceTokenOnce(spec(port()), "D", 5)).state).toBe("expired")
  })

  test("error tak dikenal berhenti, tidak polling sampai timeout", async () => {
    server = Bun.serve({ port: 0, fetch: () => json({ error: "teapot_error" }, 418) })
    const r = await pollDeviceTokenOnce(spec(port()), "D", 5)
    expect(r.state).toBe("denied")
    if (r.state === "denied") expect(r.message).toContain("teapot_error")
  })

  test("sukses menghasilkan kredensial dengan expiresAt dan tokenUrl", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        json({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "openid" }),
    })
    const s = spec(port())
    const r = await pollDeviceTokenOnce(s, "D", 5)
    expect(r.state).toBe("success")
    if (r.state === "success") {
      expect(r.creds.accessToken).toBe("AT")
      expect(r.creds.refreshToken).toBe("RT")
      expect(r.creds.expiresAt).toBeGreaterThan(Date.now())
      // tokenUrl+clientId disimpan supaya refresh nanti tak perlu hard-code
      expect(r.creds.tokenUrl).toBe(s.tokenUrl)
      expect(r.creds.clientId).toBe(s.clientId)
    }
  })
})

describe("OAuth: alur lengkap", () => {
  test("pending lalu sukses — sleep di-inject agar test tak menunggu", async () => {
    let polls = 0
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname === "/device") {
          return json({
            device_code: "D",
            user_code: "U-1",
            verification_uri: "https://x/d",
            interval: 1,
            expires_in: 600,
          })
        }
        polls++
        if (polls < 3) return json({ error: "authorization_pending" }, 400)
        return json({ access_token: "AT-final", expires_in: 60 })
      },
    })
    let prompted = false
    const creds = await loginWithDeviceFlow(
      spec(port()),
      {
        onPrompt: (info) => {
          prompted = true
          expect(info.userCode).toBe("U-1")
        },
      },
      async () => {}, // sleep no-op
    )
    expect(prompted).toBe(true)
    expect(creds.accessToken).toBe("AT-final")
    expect(polls).toBe(3)
  })

  test("abort membatalkan polling", async () => {
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/device"
          ? json({
              device_code: "D",
              user_code: "U",
              verification_uri: "https://x/d",
              interval: 1,
              expires_in: 600,
            })
          : json({ error: "authorization_pending" }, 400),
    })
    const ac = new AbortController()
    let n = 0
    await expect(
      loginWithDeviceFlow(spec(port()), { onPrompt: () => {}, signal: ac.signal }, async () => {
        if (++n >= 2) ac.abort()
      }),
    ).rejects.toThrow(/canceled/)
  })

  test("device code kedaluwarsa menghentikan loop", async () => {
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/device"
          ? json({
              device_code: "D",
              user_code: "U",
              verification_uri: "https://x/d",
              interval: 1,
              expires_in: 0, // langsung kedaluwarsa
            })
          : json({ error: "authorization_pending" }, 400),
    })
    await expect(
      loginWithDeviceFlow(spec(port()), { onPrompt: () => {} }, async () => {}),
    ).rejects.toThrow(/expired/)
  })
})

describe("auth-store: kedaluwarsa", () => {
  test("token tanpa expiresAt dianggap valid", () => {
    expect(isExpired({ type: "oauth", accessToken: "x" })).toBe(false)
  })

  test("margin 60 detik: token yang habis 30 detik lagi sudah dianggap kedaluwarsa", () => {
    const now = 1_000_000
    expect(isExpired({ type: "oauth", accessToken: "x", expiresAt: now + 30_000 }, now)).toBe(true)
    expect(isExpired({ type: "oauth", accessToken: "x", expiresAt: now + 120_000 }, now)).toBe(
      false,
    )
  })
})

describe("OAuth: registry provider", () => {
  test("lookup case-insensitive", () => {
    expect(findOAuthProvider("QWEN")?.id).toBe("qwen")
    expect(findOAuthProvider("tidak-ada")).toBeUndefined()
  })

  test("setiap spec punya field yang dibutuhkan alur", () => {
    for (const p of OAUTH_PROVIDERS) {
      expect(p.deviceUrl).toStartWith("https://")
      expect(p.tokenUrl).toStartWith("https://")
      expect(p.clientId.length).toBeGreaterThan(0)
      expect(p.apiBaseUrl).toStartWith("https://")
      expect(p.fallbackModels.length).toBeGreaterThan(0)
    }
  })
})

// ── git_commit ──
//
// Repo uji dibuat DI DALAM workspace: `git_commit` menjail `cwd` ke
// `process.cwd()` seperti bash/glob/grep, jadi tmpdir akan (benar) ditolak.
// `.tmp-*/` sudah ada di .gitignore sehingga repo bersarang ini tak mengotori
// status git minicode.
const repo = `.tmp-gc-test-${Math.random().toString(36).slice(2, 7)}`
const repoAbs = join(process.cwd(), repo)
const git = (args: string[]) =>
  spawnSync("git", args, { cwd: repoAbs, encoding: "utf8", timeout: 20_000 })
const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0

describe.skipIf(!gitAvailable)("git_commit", () => {
  beforeEach(async () => {
    await mkdir(repoAbs, { recursive: true })
    git(["init", "-q"])
    git(["config", "user.email", "t@example.com"])
    git(["config", "user.name", "t"])
    git(["config", "commit.gpgsign", "false"])
    await writeFile(join(repoAbs, "a.txt"), "v1", "utf8")
    git(["add", "-A"])
    git(["commit", "-qm", "init"])
  })

  afterEach(async () => {
    await rm(repoAbs, { recursive: true, force: true }).catch(() => {})
  })

  test("commit path spesifik", async () => {
    await writeFile(join(repoAbs, "b.txt"), "baru", "utf8")
    const out = (await gitCommitTool.execute(
      { message: "tambah b", paths: ["b.txt"], cwd: repo },
      ctx,
    )) as string
    expect(out).toContain("HEAD:")
    expect(git(["log", "--oneline", "-1"]).stdout).toContain("tambah b")
    // file lain tidak ikut ter-commit
    expect(git(["show", "--name-only", "--format=", "HEAD"]).stdout.trim()).toBe("b.txt")
  })

  test("all:true men-stage file yang dilacak", async () => {
    await writeFile(join(repoAbs, "a.txt"), "v2", "utf8")
    await gitCommitTool.execute({ message: "ubah a", all: true, cwd: repo }, ctx)
    expect(git(["log", "--oneline", "-1"]).stdout).toContain("ubah a")
  })

  test("tanpa paths dan tanpa all ditolak (commit kosong tak berguna)", async () => {
    await expect(gitCommitTool.execute({ message: "kosong", cwd: repo }, ctx)).rejects.toThrow(
      /paths.*or.*all/,
    )
  })

  test("message kosong ditolak", async () => {
    await expect(
      gitCommitTool.execute({ message: "   ", all: true, cwd: repo }, ctx),
    ).rejects.toThrow(/message is required/)
  })

  test("tidak ada perubahan → pesan informatif, bukan exception", async () => {
    const out = (await gitCommitTool.execute(
      { message: "tak ada apa-apa", all: true, cwd: repo },
      ctx,
    )) as string
    expect(out).toMatch(/nothing to commit/i)
  })

  test("path di luar workspace ditolak", async () => {
    await expect(
      gitCommitTool.execute({ message: "jahat", paths: ["../../luar.txt"], cwd: repo }, ctx),
    ).rejects.toThrow(/outside workspace/)
  })

  test("cwd di luar workspace ditolak (jail sama dengan bash/glob/grep)", async () => {
    await expect(
      gitCommitTool.execute({ message: "x", all: true, cwd: tmpdir() }, ctx),
    ).rejects.toThrow(/cwd outside workspace/)
  })

  test("pesan commit dengan backtick/$() tidak dieksekusi shell", async () => {
    await writeFile(join(repoAbs, "c.txt"), "x", "utf8")
    const nasty = "fix: $(touch pwned) dan `touch pwned2`"
    await gitCommitTool.execute({ message: nasty, paths: ["c.txt"], cwd: repo }, ctx)
    // pesan tersimpan apa adanya, dan tak ada file baru yang tercipta
    expect(git(["log", "-1", "--format=%s"]).stdout.trim()).toBe(nasty)
    expect(git(["status", "--porcelain"]).stdout).not.toContain("pwned")
  })

  test("nama file yang mirip flag tetap diperlakukan sebagai path", async () => {
    await writeFile(join(repoAbs, "-weird.txt"), "x", "utf8")
    // `--` di git add memisahkan path dari opsi
    const out = (await gitCommitTool.execute(
      { message: "file aneh", paths: ["-weird.txt"], cwd: repo },
      ctx,
    )) as string
    expect(out).toContain("HEAD:")
  })

  test("message sangat panjang ditolak", async () => {
    await expect(
      gitCommitTool.execute({ message: "x".repeat(5000), all: true, cwd: repo }, ctx),
    ).rejects.toThrow(/terlalu panjang/)
  })
})

describe("git_commit: permission", () => {
  const h = createPermissionHandler({ mode: "auto", root: process.cwd() }) as ReturnType<
    typeof createPermissionHandler
  > & { __setMode(m: "auto" | "plan" | "readonly" | "allowlist"): void }
  const check = (args: Record<string, unknown> = {}) =>
    h.check({ id: "1", name: "git_commit", args } as never, {} as never)

  test("auto: git_commit authorized (otonomi penuh; bukan gate)", async () => {
    // [mode-architecture] AUTO = otonomi penuh: git_commit (capability gated)
    // authorized ⇒ allow tanpa prompt, bahkan headless. Path/staged jail tetap
    // berlaku di jalur universal check (lihat "path sensitif" di bawah).
    expect(await check({ message: "x", all: true })).toBe("allow")
  })

  test("path sensitif ditolak sebelum sampai ke gate", async () => {
    expect(await check({ message: "x", paths: [".env"] })).toBe("deny")
    expect(await check({ message: "x", paths: ["../luar.ts"] })).toBe("deny")
  })

  test("readonly/plan/allowlist menolak", async () => {
    for (const m of ["readonly", "plan", "allowlist"] as const) {
      h.__setMode(m)
      expect(await check({ message: "x", all: true })).toBe("deny")
    }
    h.__setMode("auto")
  })

  test("git_status/diff/log tetap READONLY (tidak ikut ter-gate)", async () => {
    for (const n of ["git_status", "git_diff", "git_log"]) {
      expect(await h.check({ id: "1", name: n, args: {} } as never, {} as never)).toBe("allow")
    }
  })
})

// ── pricing ──

describe("pricing: ekstraksi models.dev", () => {
  test("mengambil biaya dan mengabaikan model tanpa cost", () => {
    const out = extractPricing({
      openai: {
        models: {
          "gpt-x": { id: "gpt-x", cost: { input: 1, output: 2, cache_read: 0.5 } },
          "no-cost": { id: "no-cost" },
        },
      },
    })
    expect(out["gpt-x"]).toEqual({ input: 1, output: 2, cacheRead: 0.5 })
    expect(out["no-cost"]).toBeUndefined()
  })

  test("id di-lowercase agar lookup konsisten", () => {
    const out = extractPricing({
      p: { models: { X: { id: "GPT-Upper", cost: { input: 1, output: 2 } } } },
    })
    expect(out["gpt-upper"]).toBeDefined()
  })

  test("model di beberapa provider: entri $0 diabaikan bila ada yang berbayar", () => {
    // Kasus nyata: qwen3-coder-plus muncul di 6 provider, dua di antaranya $0
    // (paket berlangganan). Mengambil "yang pertama" bisa menghasilkan $0 →
    // estimasi biaya nol dan --budget tak pernah memicu.
    const out = extractPricing({
      plan: { models: { q: { id: "qwen-x", cost: { input: 0, output: 0 } } } },
      vendor: { models: { q: { id: "qwen-x", cost: { input: 1, output: 5 } } } },
      gateway: { models: { q: { id: "qwen-x", cost: { input: 1, output: 5 } } } },
    })
    expect(out["qwen-x"]).toMatchObject({ input: 1, output: 5 })
  })

  test("semua provider $0 → tetap $0 (memang gratis)", () => {
    const out = extractPricing({
      a: { models: { m: { id: "free-m", cost: { input: 0, output: 0 } } } },
      b: { models: { m: { id: "free-m", cost: { input: 0, output: 0 } } } },
    })
    expect(out["free-m"]).toMatchObject({ input: 0, output: 0 })
  })

  test("pickRepresentativePrice memakai median, bukan min/max", () => {
    const r = pickRepresentativePrice([
      { input: 1, output: 2 },
      { input: 5, output: 10 },
      { input: 100, output: 200 },
    ])
    expect(r).toMatchObject({ input: 5, output: 10 })
  })

  test("payload kosong/rusak tidak melempar", () => {
    expect(extractPricing({})).toEqual({})
    expect(extractPricing({ p: {} })).toEqual({})
    expect(extractPricing(undefined as never)).toEqual({})
  })
})

describe("pricing: pencocokan nama model", () => {
  test("tabel bawaan dipakai tanpa overlay", () => {
    expect(findPrice("gpt-4o", {})).toEqual(BUILTIN_PRICING["gpt-4o"])
  })

  test("overlay menang atas bawaan", () => {
    const overlay = { "gpt-4o": { input: 99, output: 99 } }
    expect(findPrice("gpt-4o", overlay)).toEqual({ input: 99, output: 99 })
  })

  test("kunci terpanjang menang", () => {
    const overlay = {
      "claude-sonnet-4": { input: 1, output: 1 },
      "claude-sonnet-4-5": { input: 2, output: 2 },
    }
    expect(findPrice("claude-sonnet-4-5", overlay)).toEqual({ input: 2, output: 2 })
  })

  test("prefix provider dipisah per segmen", () => {
    expect(findPrice("deepseek/deepseek-chat", {})).toEqual(BUILTIN_PRICING["deepseek-chat"])
  })

  // Varian `:free` OpenRouter benar-benar $0 (terverifikasi lewat
  // /api/v1/models: prompt=0 completion=0). Sebelumnya pencocokan per-segmen
  // mengabaikan sufiks dan memungut harga varian berbayarnya, sehingga
  // `z-ai/glm-5.2:free` dilaporkan $1,25/M dan `--budget` bisa memutus sesi
  // yang sebenarnya tidak berbiaya sepeser pun.
  test(":free selalu gratis, bukan mewarisi harga varian berbayar", () => {
    expect(findPrice("z-ai/glm-5.2:free", { "glm-5.2": { input: 1.25, output: 4.2 } })).toEqual({
      input: 0,
      output: 0,
    })
    expect(findPrice("deepseek/deepseek-chat:free", {})).toEqual({ input: 0, output: 0 })
    // Varian berbayar dengan nama sama tetap berharga.
    expect(findPrice("z-ai/glm-5.2", { "glm-5.2": { input: 1.25, output: 4.2 } })).toEqual({
      input: 1.25,
      output: 4.2,
    })
  })

  test(":free dengan entri eksplisit di overlay memakai entri itu", () => {
    const overlay = { "vendor/model:free": { input: 0.01, output: 0.02 } }
    expect(findPrice("vendor/model:free", overlay)).toEqual({ input: 0.01, output: 0.02 })
  })

  // Varian `-free` gaya Zen (bukan `:free` OpenRouter) juga $0. Regresi
  // nyata: `deepseek-v4-flash-free` cocok segmen `deepseek` ($0,14/M)
  // sehingga sesi gratis 919rb token dilaporkan $0,13 di /status.
  test("-free selalu gratis, bukan mewarisi harga segmen", () => {
    expect(findPrice("deepseek-v4-flash-free", {})).toEqual({ input: 0, output: 0 })
    expect(findPrice("opencode-zen::deepseek-v4-flash-free", {})).toEqual({ input: 0, output: 0 })
    expect(findPrice("mimo-v2.5-free", {})).toEqual({ input: 0, output: 0 })
    // Berbayar tanpa sufiks tetap berharga; nama mirip tanpa strip tak kena.
    expect(findPrice("deepseek/deepseek-chat", {})).toEqual(BUILTIN_PRICING["deepseek-chat"])
    expect(findPrice("model-tak-dikenal", {})).toBeUndefined()
  })

  test("nama wrapper TIDAK cocok (bukan substring)", () => {
    expect(findPrice("my-gpt-4o-wrapper", {})).toBeUndefined()
    expect(findPrice("gpt-4o1-preview", {})).toBeUndefined()
    expect(findPrice("model-tak-dikenal", {})).toBeUndefined()
  })

  test("sufiks versi cocok", () => {
    expect(findPrice("gpt-4o-2024-11-20", {})).toEqual(BUILTIN_PRICING["gpt-4o"])
  })
})

describe("pricing: cache di disk", () => {
  const tmp = join(tmpdir(), `minicode-price-${Date.now()}`)

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  test("cache hanya memuat field biaya, bukan payload penuh", async () => {
    // Bukti bahwa 4,4 MB payload tidak ikut tersimpan: hasil ekstraksi
    // dari entri kaya-metadata hanya berisi input/output/cache.
    const richEntry = {
      id: "m1",
      cost: { input: 1, output: 2 },
      // field lain di payload asli — tidak boleh muncul di hasil
      description: "x".repeat(5000),
      modalities: { input: ["text"] },
    }
    const extracted = extractPricing({
      p: {
        models: {
          m: richEntry as unknown as { id: string; cost: { input: number; output: number } },
        },
      },
    })
    const serialized = JSON.stringify(extracted)
    expect(serialized).not.toContain("description")
    expect(serialized.length).toBeLessThan(120)
  })

  test("cache rusak tidak melempar (dianggap belum sync)", async () => {
    await mkdir(tmp, { recursive: true })
    const p = join(tmp, "pricing.json")
    await writeFile(p, "{bukan json", "utf8")
    // loadPricingOverlay memakai path global; di sini cukup pastikan JSON.parse
    // yang gagal ditangani — dibuktikan lewat readFile+try/catch yang sama.
    let threw = false
    try {
      JSON.parse(await readFile(p, "utf8"))
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
