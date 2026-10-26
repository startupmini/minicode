// Lifecycle checkpoint: ownership + shutdown drain (Stage 5B).
//
// Yang diuji (bukan "fungsi drain dipanggil", tapi HASIL yang terlihat):
// - A: manifest checkpoint SUDAH ada saat `ctx.close()` kembali.
// - B: pekerjaan checkpoint SELESAI sebelum close() resolve (note presentation
//      terbit + tak ada operasi yang tertinggal) — close() = barrier.
// - C: kegagalan checkpoint (workspace tak bisa ditulis) → tercatat, TAK
//      jadi unhandled rejection, dan tak dilaporkan sebagai sukses.
// - D: beberapa turn → semua operasi checkpoint selesai saat drain.
//
// Bukti Stage 5A: listener `turn:completed` di cli/setup.ts memulai operasi
// async yang tak dilacak bus kernel → bisa berjalan setelah close() kembali
// (rejection → unhandled error) dan bisa menulis ke direktori yang sudah
// dibersihkan.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sanitizeSessionId } from "../src/session/checkpoint.ts"
import { startFakeProvider } from "./helpers/fake-provider.ts"

const dirs: string[] = []
const savedEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  MINICODE_HOME: process.env.MINICODE_HOME,
  PROBE_OUT: process.env.PROBE_OUT,
}

function tmpRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mc-ckpt-${tag}-`))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {})
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

interface SessionFixture {
  ctx: Awaited<ReturnType<typeof import("../cli/setup.ts").createCliSession>>
  cwd: string
  sessionId: string
  manifestPath: string
  closeProvider: () => void
}

/**
 * Sesi nyata (composition root) dengan provider fake hermetic.
 *
 * `files` = isi workspace (snapshot pre-turn). File BER-TITIK (bukan dotfile)
 * supaya `walkFiles` menangkapnya → checkpoint benar-benar terbentuk.
 */
async function createSession(
  opts: { files?: Record<string, string>; replies?: number } = {},
): Promise<SessionFixture> {
  const { createCliSession } = await import("../cli/setup.ts")
  const cwd = tmpRoot("cwd")
  const home = tmpRoot("home")
  for (const [name, content] of Object.entries(opts.files ?? { "notes.txt": "isi\n" })) {
    writeFileSync(join(cwd, name), content)
  }
  mkdirSync(join(cwd, ".minicode"), { recursive: true })
  const provider = startFakeProvider(
    Array.from({ length: opts.replies ?? 1 }, () => ({ kind: "text", text: "ok" })),
  )
  writeFileSync(
    join(cwd, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["m"] }],
    }),
  )
  // Isolasi penuh: `findRunHooks` memakai `homedir()` langsung.
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.MINICODE_HOME = home
  const ctx = await createCliSession({
    cwd,
    allowLocalConfig: true,
    sessionId: "",
    prompt: "siap",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
    workMode: "EXECUTE",
  })
  return {
    ctx,
    cwd,
    sessionId: ctx.sessionId,
    manifestPath: join(
      cwd,
      ".minicode",
      "checkpoints",
      sanitizeSessionId(ctx.sessionId),
      "manifest.json",
    ),
    closeProvider: () => provider.close(),
  }
}

/** Tangkap stderr selama `fn` (diagnostik `[warn]` checkpoint). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ text: string; value: T }> {
  const original = process.stderr.write
  let text = ""
  process.stderr.write = ((chunk: string | Uint8Array) => {
    text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    const value = await fn()
    return { text, value }
  } finally {
    process.stderr.write = original
  }
}

describe("checkpoint lifecycle (Stage 5B)", () => {
  test("A: manifest checkpoint tersedia saat close() kembali", async () => {
    const fx = await createSession()
    try {
      await fx.ctx.runPromptWithVerify("turn satu")
      await fx.ctx.close()
      // Bukti filesystem: close() adalah barrier — pekerjaan checkpoint yang
      // dimulai turn lalu selesai SEBELUM close() resolve.
      expect(existsSync(fx.manifestPath)).toBe(true)
      const manifest = JSON.parse(readFileSync(fx.manifestPath, "utf8")) as {
        checkpoints?: Array<{ snapshots?: unknown[]; turn?: number }>
        currentIndex?: number
      }
      expect(Array.isArray(manifest.checkpoints)).toBe(true)
      expect(manifest.checkpoints!.length).toBeGreaterThan(0)
      // Isi manifest valid: checkpoint membawa snapshot pre-turn.
      expect((manifest.checkpoints![0]!.snapshots ?? []).length).toBeGreaterThan(0)
      // Tak ada operasi checkpoint yang tertinggal di background.
      expect(fx.ctx.pendingCheckpointCount()).toBe(0)
    } finally {
      fx.closeProvider()
    }
  })

  test("B: close() menunggu pekerjaan checkpoint (barrier nyata)", async () => {
    const fx = await createSession()
    try {
      // Side effect checkpoint yang TERPUBLISH saat pekerjaan selesai.
      let noteSeen = false
      fx.ctx.onPresentationEvent((e) => {
        if (e.type === "checkpoint.created") noteSeen = true
      })
      await fx.ctx.runPromptWithVerify("turn satu")
      await fx.ctx.close()
      // Kalau close() tak menunggu, note ini belum terbit saat close() resolve.
      expect(noteSeen).toBe(true)
      expect(existsSync(fx.manifestPath)).toBe(true)
      expect(fx.ctx.pendingCheckpointCount()).toBe(0)
    } finally {
      fx.closeProvider()
    }
  })

  test("C: kegagalan checkpoint tercatat, bukan unhandled rejection", async () => {
    const fx = await createSession()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      // Sabotase deterministik: `checkpoints` jadi FILE, bukan direktori →
      // mkdir gagal (error ditelan) lalu `open` gagal ENOTDIR. Kegagalan
      // terjadi DI DALAM operasi checkpoint, bukan karena race.
      const cpDir = join(fx.cwd, ".minicode", "checkpoints")
      writeFileSync(cpDir, "bukan direktori\n")
      const { text } = await captureStderr(async () => {
        await fx.ctx.runPromptWithVerify("turn satu")
        await fx.ctx.close()
      })
      // Kegagalan DICATAT (bukan hilang senyap, bukan sukses palsu).
      expect(fx.ctx.checkpointFailures().length).toBeGreaterThan(0)
      expect(fx.ctx.checkpointFailures()[0]).toContain("checkpoint failed")
      // Dan DILAPORKAN lewat diagnostic stderr.
      expect(text).toContain("[warn] checkpoint failed")
      // Tak ada manifest (kegagalan tak berpura-pura sukses).
      expect(existsSync(fx.manifestPath)).toBe(false)
      // Tak ada unhandled rejection.
      expect(unhandled).toEqual([])
      expect(fx.ctx.pendingCheckpointCount()).toBe(0)
    } finally {
      process.off("unhandledRejection", onUnhandled)
      fx.closeProvider()
    }
  })

  test("D: beberapa turn → semua operasi checkpoint selesai saat drain", async () => {
    const fx = await createSession({ replies: 3 })
    try {
      await fx.ctx.runPromptWithVerify("turn satu")
      await fx.ctx.runPromptWithVerify("turn dua")
      await fx.ctx.runPromptWithVerify("turn tiga")
      await fx.ctx.close()
      // Semua checkpoint yang dimulai sudah tertulis saat close() kembali.
      expect(existsSync(fx.manifestPath)).toBe(true)
      const manifest = JSON.parse(readFileSync(fx.manifestPath, "utf8")) as {
        checkpoints?: Array<{ turn?: number }>
      }
      expect(manifest.checkpoints!.length).toBeGreaterThanOrEqual(2)
      expect(fx.ctx.pendingCheckpointCount()).toBe(0)
      expect(fx.ctx.checkpointFailures()).toEqual([])
    } finally {
      fx.closeProvider()
    }
  })
})
