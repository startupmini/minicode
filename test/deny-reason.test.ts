// Alasan deny sampai ke model (audit #14): seam kernel `describeDenial` +
// alasan app-layer per aturan. check() TETAP "deny" polos (kontrak Decision
// + 112 assertion lama utuh) — yang baru adalah observasi model:
// "permission denied: bash-guard: destructive rm" alih-alih retry buta.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionHandler } from "../src/policy/permission.ts"
import { bashTool } from "../src/tools/bash.ts"
import { runCall } from "../vendor/minicore/src/core/executor.ts"
import type { PermissionHandler } from "../vendor/minicore/src/core/permission.ts"
import type { ToolCall } from "../vendor/minicore/src/core/types.ts"
import { type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
})

const bus = () => ({ emit() {} })
// Registry WAJIB berisi tool: kernel cek registry DULU sebelum permission —
// registry kosong memberi "unknown tool", bukan jalur deny yang diuji.
const depsFor = (permissions: PermissionHandler) =>
  ({
    registry: new Map([["bash", bashTool]]),
    permissions,
    events: bus(),
    signal: new AbortController().signal,
    state: { history: [], turnCount: 0, stepCount: 0, model: "m" },
    maxResultTokens: 4000,
  }) as never
let seq = 0
const call = (name: string, args: unknown): ToolCall => ({
  id: `deny-t-${++seq}`,
  name,
  args,
})

describe("kernel describeDenial seam", () => {
  test("tanpa describeDenial → pesan polos seperti dulu (kompatibel)", async () => {
    const permissions: PermissionHandler = { check: async () => "deny" }
    const r = await runCall(call("bash", { cmd: "x" }), depsFor(permissions))
    expect(r.isError).toBe(true)
    expect(String(r.content)).toBe("permission denied")
  })

  test("dengan describeDenial → alasan menempel di observasi model", async () => {
    const permissions: PermissionHandler = {
      check: async () => "deny",
      describeDenial: () => "bash-guard: destructive rm",
    }
    const r = await runCall(call("bash", { cmd: "x" }), depsFor(permissions))
    expect(String(r.content)).toBe("permission denied: bash-guard: destructive rm")
  })

  test("describeDenial yang melempar tak menggagalkan denial", async () => {
    const permissions: PermissionHandler = {
      check: async () => "deny",
      describeDenial: () => {
        throw new Error("boom")
      },
    }
    const r = await runCall(call("bash", { cmd: "x" }), depsFor(permissions))
    expect(String(r.content)).toBe("permission denied")
  })
})

describe("app handler reasons", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-denyreason-"))
  const handler = (mode: "allow-all" | "auto" | "readonly" | "plan" | "ask" | "allowlist") =>
    createPermissionHandler({ mode, root }) as unknown as PermissionHandler & {
      describeDenial(c: ToolCall): string | undefined
    }
  const reasoned = async (
    h: PermissionHandler & { describeDenial(c: ToolCall): string | undefined },
    name: string,
    args: unknown,
  ): Promise<{ decision: string; reason: string | undefined }> => {
    const c = call(name, args)
    const decision = await h.check(c, {} as never)
    return { decision: decision as string, reason: await h.describeDenial(c) }
  }

  test("bash berbahaya → deny + bash-guard reason", async () => {
    const h = handler("allow-all")
    const { decision, reason } = await reasoned(h, "bash", { cmd: "rm -rf /" })
    expect(decision).toBe("deny")
    expect(reason).toBe("bash-guard: destructive rm")
    rmSync(root, { recursive: true, force: true })
  })

  test("jail: outside vs sensitive vs owned dibedakan", async () => {
    const h = handler("allow-all")
    const outside = await reasoned(h, "write_file", { path: join(tmpdir(), "x-out.txt") })
    expect(outside.decision).toBe("deny")
    expect(outside.reason).toBe("jail: outside workspace")
    const sens = await reasoned(h, "read_file", { path: join(root, ".env") })
    expect(sens.decision).toBe("deny")
    expect(sens.reason).toBe("jail: sensitive file")
    const owned = await reasoned(h, "write_file", { path: join(root, ".minicode", "x.txt") })
    expect(owned.decision).toBe("deny")
    expect(owned.reason).toBe("jail: owned state")
  })

  test("jail: owned state via link internal ikut deny (temuan F-CRIT)", async () => {
    // Gagal-di-kode-lama: junction/symlink → `.minicode/` lolos karena cek
    // owned-state membaca string argumen, bukan target nyata (`write_file
    // linkdir/config.json` → allow, lalu tulis mendarat di state). Kunci
    // ganda: string mentah DAN target realpath dicek (permission.ts), dengan
    // carve-out hooks/trash yang dipertahankan.
    const rootDir = mkdtempSync(join(tmpdir(), "mc-ownedlink-"))
    try {
      mkdirSync(join(rootDir, ".minicode"), { recursive: true })
      writeFileSync(join(rootDir, ".minicode", "config.json"), "{}\n")
      let linked = false
      try {
        // Junction bebas-privilege lintas-OS (Windows maupun POSIX).
        symlinkSync(join(rootDir, ".minicode"), join(rootDir, "linkdir"), "junction")
        linked = true
      } catch {
        linked = false
      }
      const h2 = createPermissionHandler({
        mode: "allow-all",
        root: rootDir,
      }) as unknown as PermissionHandler & { describeDenial(c: ToolCall): string | undefined }
      const g = async (name: string, args: unknown) => {
        const c = call(name, args)
        return {
          decision: (await h2.check(c, {} as never)) as string,
          reason: await h2.describeDenial(c),
        }
      }
      const direct = await g("write_file", { path: join(rootDir, ".minicode", "config.json") })
      expect(direct.decision).toBe("deny")
      expect(direct.reason).toBe("jail: owned state")
      if (linked) {
        // Pola serangan: argumen jinak, target nyata = state.
        const viaLink = await g("write_file", { path: join(rootDir, "linkdir", "config.json") })
        expect(viaLink.decision).toBe("deny")
        expect(viaLink.reason).toBe("jail: owned state")
        // edit/delete/move ikut jalur kunci yang sama.
        const viaEdit = await g("edit", { path: join(rootDir, "linkdir", "config.json") })
        expect(viaEdit.decision).toBe("deny")
        const viaMove = await g("move_file", {
          from: join(rootDir, "linkdir", "x"),
          to: join(rootDir, "linkdir", "y"),
        })
        expect(viaMove.decision).toBe("deny")
        // Symlink internal ke target JINAK tidak over-block (kontrak target
        // di safe-open.ts: hanya `.minicode/` yang dikunci, bukan symlink).
        // Symlink FILE butuh privilege di Windows → bila gagal, uji via
        // junction ke direktori JINAK (inti test — blokir link → state —
        // sudah diuji di atas via junction ke `.minicode/`).
        writeFileSync(join(rootDir, "ok.txt"), "x\n")
        let benignPath: string | null = null
        try {
          symlinkSync(join(rootDir, "ok.txt"), join(rootDir, "ok-link.txt"))
          benignPath = join(rootDir, "ok-link.txt")
        } catch {
          mkdirSync(join(rootDir, "okdir"), { recursive: true })
          writeFileSync(join(rootDir, "okdir", "ok.txt"), "x\n")
          try {
            symlinkSync(join(rootDir, "okdir"), join(rootDir, "okdir-link"), "junction")
            benignPath = join(rootDir, "okdir-link", "ok.txt")
          } catch {
            benignPath = null
          }
        }
        if (benignPath) {
          const benign = await g("write_file", { path: benignPath })
          expect(benign.decision).toBe("allow")
        }
        // Carve-out hooks: skrip hooks user tetap boleh ditulis lewat tool.
        const hook = await g("write_file", {
          path: join(rootDir, ".minicode", "hooks", "pre-x.js"),
        })
        expect(hook.decision).toBe("allow")
      }
      // Jalur sah non-link tetap berfungsi (mode check di bawah izin tulis).
      const normal = await g("write_file", { path: join(rootDir, "notes.txt") })
      expect(normal.decision).toBe("allow")
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test("gated headless → alasan approval, bukan deny buta", async () => {
    const h = handler("auto")
    const { decision, reason } = await reasoned(h, "delegate_task", { prompt: "x" })
    expect(decision).toBe("deny")
    expect(reason).toBe("gated approval unavailable")
  })

  test("mode readonly/plan/allowlist menyebut modenya", async () => {
    const ro = await reasoned(handler("readonly"), "write_file", { path: "a.txt" })
    expect(ro.decision).toBe("deny")
    expect(ro.reason).toBe("read-only mode")
    const pl = await reasoned(handler("plan"), "write_file", { path: "a.txt" })
    expect(pl.decision).toBe("deny")
    expect(pl.reason).toBe("plan mode")
    const al = await reasoned(handler("allowlist"), "delegate_task", { prompt: "x" })
    expect(al.decision).toBe("deny")
    expect(al.reason).toBe("allowlist: gated tool")
  })

  test("code_run tanpa sandbox menyebut syaratnya", async () => {
    const prev = process.env.MINICODE_SANDBOX
    delete process.env.MINICODE_SANDBOX
    try {
      const h = handler("auto")
      const { decision, reason } = await reasoned(h, "code_run", {})
      expect(decision).toBe("deny")
      expect(reason).toBe("code_run needs sandbox (os|docker)")
    } finally {
      if (prev === undefined) delete process.env.MINICODE_SANDBOX
      else process.env.MINICODE_SANDBOX = prev
    }
  })

  test("user decline tercatat (bukan deny anonim)", async () => {
    tty = installFakeTty()
    const h = createPermissionHandler({
      mode: "ask",
      root,
      ask: async () => "deny",
    }) as unknown as PermissionHandler & { describeDenial(c: ToolCall): string | undefined }
    const c = call("delegate_task", { prompt: "x" })
    expect(await h.check(c, {} as never)).toBe("deny")
    expect(h.describeDenial(c)).toBe("declined by user")
  })

  test("end-to-end runCall: rm -rf / membawa alasan ke observasi", async () => {
    const h = createPermissionHandler({ mode: "allow-all", root })
    const r = await runCall(call("bash", { cmd: "rm -rf /" }), depsFor(h))
    expect(r.isError).toBe(true)
    expect(String(r.content)).toBe("permission denied: bash-guard: destructive rm")
  })

  test("allowlist: `type` (padanan cat Windows) lolos, sensitif tetap ditahan guard", async () => {
    const h = handler("allowlist")
    const ok = await reasoned(h, "bash", { cmd: "type readme.txt" })
    expect(ok.decision).toBe("allow")
    const sens = await reasoned(h, "bash", { cmd: "type .env" })
    expect(sens.decision).toBe("deny")
    expect(sens.reason).toBe("bash-guard: sensitive file access")
  })

  test("allowlist miss memberi jalan keluar, bukan alasan buntu", async () => {
    const h = handler("allowlist")
    const { decision, reason } = await reasoned(h, "bash", { cmd: "mkdir subdir" })
    expect(decision).toBe("deny")
    expect(reason).toContain("allowlist: no matching pattern")
    // Model harus tahu alternatifnya: tool file untuk kerja file, eskalasi
    // mode untuk shell penuh — tanpa ini model retry buta (temuan eval).
    expect(reason).toContain("read_file/write_file/edit")
    expect(reason).toContain("--allow-all")
  })
})
