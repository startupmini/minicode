// Regression Fase 0 — tiga bug yang lolos CI karena cli/ dulu di luar tsconfig
// dan tanpa test sama sekali:
//   B1 driver REPL lama — `cmdName` undefined → semua slash builtin
//      gagal senyap di TUI (ReferenceError ditelan `catch { return null }`).
//   B2 cli/commands/exec.ts — events.on(handler) 1-argumen tidak pernah
//      terpanggil → `exec --json` tidak stream apa pun.
//   B3 driver REPL lama — session.config tidak ada di kernel, jadi
//      Shift+Tab hanya mengubah label header sementara mode permission tetap.
import { describe, expect, test } from "bun:test"
import type { ModelProvider } from "#minicore/core/provider.ts"
import { handleBuiltinCommand } from "../cli/commands.ts"
import { createMinicodeSession, type PermissionControl } from "../src/app/session.ts"
import { createPermissionHandler, type PermissionMode } from "../src/policy/permission.ts"
import { captureOutput } from "./helpers/capture.ts"

const fakeProvider: ModelProvider = {
  id: "fake",
  models: ["m"],
  async *stream() {
    yield { type: "text", text: "hi" }
    yield { type: "finish", reason: "stop" }
  },
}

const commandCtx = {
  cwd: process.cwd(),
  sessionId: "regress",
  currentModel: "m",
  usage: {
    get: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    getSession: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    reset() {},
    modelUsed: () => ({}),
  },
  skills: [],
  toolsCount: 0,
  setModelOverride() {},
  // Kontrak control-plane (Phase 6): /status membedakan Context vs Usage.
  getContextTokens() {
    return 1024
  },
  budgetState() {
    return "ok"
  },
} as unknown as Parameters<typeof handleBuiltinCommand>[1]

// Cermin logika dispatch builtin di driver REPL (dulu onOverlay).
async function overlay(q: string): Promise<{ title: string; lines: string[] } | null> {
  const cmdName = q.slice(1).split(" ")[0]?.toLowerCase() ?? ""
  try {
    const { lines, value } = await captureOutput(() => handleBuiltinCommand(q, commandCtx))
    if (!value.handled) return null
    return { title: cmdName, lines }
  } catch (e) {
    return { title: cmdName, lines: [`error: ${(e as Error).message}`] }
  }
}

describe("B1 — slash builtin overlay tidak crash", () => {
  for (const cmd of ["/help", "/status", "/sessions"]) {
    test(`${cmd} menghasilkan baris output, bukan error`, async () => {
      const r = await overlay(cmd)
      expect(r).not.toBeNull()
      expect(r!.lines.length).toBeGreaterThan(0)
      expect(r!.lines[0]).not.toStartWith("error:")
      expect(r!.title).toBe(cmd.slice(1))
    })
  }

  test("perintah tak dikenal → null supaya jatuh ke skill/prompt", async () => {
    expect(await overlay("/tidakadaperintahini")).toBeNull()
  })

  test("captureOutput meneruskan nilai kembalian fn", async () => {
    const { value, lines } = await captureOutput(async () => {
      console.log("baris")
      return { handled: true as const }
    })
    expect(value.handled).toBe(true)
    expect(lines).toContain("baris")
  })
})

describe("B2 — EventBus butuh (type, handler)", () => {
  test('on("*") menerima event; on(handler) 1-argumen tidak', async () => {
    const s = await createMinicodeSession({ provider: fakeProvider, tools: [] })
    const wildcard: unknown[] = []
    const oneArg: unknown[] = []
    s.events.on("*", (ev) => wildcard.push(ev))
    // pola lama di exec.ts — didaftarkan di bawah key "function", never fires
    ;(s.events.on as unknown as (h: (e: unknown) => void) => void)((ev) => oneArg.push(ev))
    await s.run("apa saja")
    expect(wildcard.length).toBeGreaterThan(0)
    expect(oneArg.length).toBe(0)
  })
})

describe("B3 — permission mode bisa diubah saat runtime", () => {
  test("createMinicodeSession menyerahkan handle kontrol", async () => {
    let ctl: PermissionControl | undefined
    await createMinicodeSession({
      provider: fakeProvider,
      tools: [],
      permissionMode: "auto",
      onPermissions: (c) => {
        ctl = c
      },
    })
    expect(ctl).toBeDefined()
    expect(ctl!.getMode()).toBe("auto")
    ctl!.setMode("plan")
    expect(ctl!.getMode()).toBe("plan")
  })

  test("__setMode/__getMode punya implementasi nyata, bukan cast kosong", () => {
    const h = createPermissionHandler({ mode: "auto", root: process.cwd() }) as ReturnType<
      typeof createPermissionHandler
    > & { __setMode(m: PermissionMode): void; __getMode(): PermissionMode }
    expect(typeof h.__setMode).toBe("function")
    expect(typeof h.__getMode).toBe("function")
    expect(h.__getMode()).toBe("auto")
  })

  test("ganti ke plan benar-benar menolak write_file dan bash", async () => {
    const h = createPermissionHandler({ mode: "auto", root: process.cwd() }) as ReturnType<
      typeof createPermissionHandler
    > & { __setMode(m: PermissionMode): void }
    const check = (name: string, args: Record<string, unknown>) =>
      h.check({ id: "1", name, args } as never, {} as never)
    expect(await check("write_file", { path: "a.txt", content: "x" })).toBe("allow")
    expect(await check("bash", { cmd: "echo hi" })).toBe("allow")
    h.__setMode("plan")
    expect(await check("write_file", { path: "a.txt", content: "x" })).toBe("deny")
    expect(await check("bash", { cmd: "echo hi" })).toBe("deny")
    // read tetap boleh di plan mode
    expect(await check("read_file", { path: "package.json" })).toBe("allow")
  })
})
