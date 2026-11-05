// Kontrak hooks WorkMode-aware (P12 S2.2, Slice 4).
//
// MASALAH: hooks (`src/hooks/run.ts`) berjalan di luar permission system —
// `shouldRunHooks` hanya mengenal permission mode plan/readonly. Jadi sesi
// WorkMode DISCUSS × permissionMode="auto" masih menjalankan hook walau
// posture-nya read-only penuh — inkonsisten dengan ceiling DISCUSS (yang
// menolak SEMUA tool tulis/eksekusi, termasuk delegate).
//
// SOLUSI: `shouldRunHooks(permissionMode, workMode?)` menahan DISCUSS. Param
// workMode opsional — pemanggil lama tanpa workMode tetap kompatibel.
// `cli/setup.ts` meneruskan workMode sesi (satu-satunya jalur pemanggilan
// hooks production lewat `runHooksGated`).

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRunHooks, shouldRunHooks } from "../src/hooks/run.ts"

const dirs: string[] = []
const savedHooks = process.env.MINICODE_HOOKS

function tmpRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mc-wm-hook-${tag}-`))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {})
  if (savedHooks === undefined) delete process.env.MINICODE_HOOKS
  else process.env.MINICODE_HOOKS = savedHooks
})

function writeMarkerHook(root: string, marker: string): void {
  mkdirSync(join(root, ".minicode", "hooks"), { recursive: true })
  writeFileSync(
    join(root, ".minicode", "hooks", "pre-probe.js"),
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "jalan");\n`,
  )
}

describe("shouldRunHooks — predicate WorkMode-aware", () => {
  test("pemanggil tanpa workMode: kompatibel dengan kontrak lama", () => {
    expect(shouldRunHooks("auto")).toBe(true)
    expect(shouldRunHooks("ask")).toBe(true)
    expect(shouldRunHooks("allow-all")).toBe(true)
    expect(shouldRunHooks("allowlist")).toBe(true)
    expect(shouldRunHooks("plan")).toBe(false)
    expect(shouldRunHooks("readonly")).toBe(false)
  })

  test("DISCUSS menahan hooks di SEMUA permission mode (termasuk auto/allow-all)", () => {
    for (const pm of ["auto", "ask", "plan", "allow-all", "allowlist", "readonly"] as const) {
      expect(shouldRunHooks(pm, "DISCUSS")).toBe(false)
    }
  })

  test("PLAN menahan hooks di SEMUA permission mode (Q3=A3)", () => {
    for (const pm of ["auto", "ask", "plan", "allow-all", "allowlist", "readonly"] as const) {
      expect(shouldRunHooks(pm, "PLAN")).toBe(false)
    }
  })

  test("EXECUTE mengikuti permission mode (auto/ask/allow-all/allowlist = jalan, plan/readonly = tahan)", () => {
    for (const pm of ["auto", "ask", "allow-all", "allowlist"] as const) {
      expect(shouldRunHooks(pm, "EXECUTE")).toBe(true)
    }
    expect(shouldRunHooks("plan", "EXECUTE")).toBe(false)
    expect(shouldRunHooks("readonly", "EXECUTE")).toBe(false)
  })
})

describe("eksekusi nyata — guard DISCUSS & PLAN mencegah runRunHooks", () => {
  // Bukti eksekusi nyata (bukan sekadar predicate): runRunHooks benar-benar
  // men-spawn hook yang menulis marker. Guard `!shouldRunHooks(...)` adalah
  // LOGIKA `runHooksGated` di cli/setup.ts — bila DISCUSS/PLAN → runRunHooks tak
  // dipanggil → marker tak dibuat.
  test("EXECUTE × auto (guard mengizinkan) → hook JALAN (marker dibuat)", async () => {
    const root = tmpRoot("exec")
    const marker = join(root, "exec-ran.txt")
    writeMarkerHook(root, marker)
    process.env.MINICODE_HOOKS = "1"
    expect(shouldRunHooks("auto", "EXECUTE")).toBe(true)
    await runRunHooks("pre", { phase: "pre", prompt: "halo", cwd: root })
    expect(readFileSync(marker, "utf8")).toBe("jalan")
  })

  test("DISCUSS × auto (guard menolak) → hook TIDAK dijalankan (marker tidak dibuat)", async () => {
    const root = tmpRoot("discuss")
    const marker = join(root, "discuss-ran.txt")
    writeMarkerHook(root, marker)
    process.env.MINICODE_HOOKS = "1"
    if (shouldRunHooks("auto", "DISCUSS")) {
      await runRunHooks("pre", { phase: "pre", prompt: "halo", cwd: root })
    }
    let ran = false
    try {
      readFileSync(marker)
      ran = true
    } catch {}
    expect(ran).toBe(false)
  })

  test("PLAN × auto & PLAN × allow-all (Q3=A3: guard menolak) → hook TIDAK dijalankan", async () => {
    const root = tmpRoot("plan")
    const marker = join(root, "plan-ran.txt")
    writeMarkerHook(root, marker)
    process.env.MINICODE_HOOKS = "1"
    for (const pm of ["auto", "allow-all"] as const) {
      if (shouldRunHooks(pm, "PLAN")) {
        await runRunHooks("pre", { phase: "pre", prompt: "halo", cwd: root })
      }
    }
    let ran = false
    try {
      readFileSync(marker)
      ran = true
    } catch {}
    expect(ran).toBe(false)
  })
})

// ── Integrasi jalur PRODUCTION (P12 S2.2 polish M2 + P0.2 Q3=A3) ─────────────
//
// Memakai jalur production sungguhan:
// `createCliSession` (composition root) → `runPromptWithVerify` → `runHooksGated`
// → `runRunHooks` → hook Node yang menulis marker.
describe("integrasi produksi — transisi WorkMode & PermissionMode menghentikan hook pada sesi yang sama", () => {
  test("EXECUTE → hook jalan; setWorkMode(PLAN) & setWorkMode(DISCUSS) → hook DILEWATI; kembali EXECUTE → jalan lagi", async () => {
    const { createCliSession } = await import("../cli/setup.ts")
    const { startFakeProvider } = await import("./helpers/fake-provider.ts")
    const cwd = tmpRoot("prod")
    const home = tmpRoot("prodhome")
    const savedHome = process.env.HOME
    const savedUserProfile = process.env.USERPROFILE
    const savedMinicodeHome = process.env.MINICODE_HOME
    const savedProbeOut = process.env.PROBE_OUT
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.MINICODE_HOME = home
    const marker = join(cwd, "hook-ran.log")
    process.env.PROBE_OUT = marker
    process.env.MINICODE_HOOKS = "1"
    mkdirSync(join(cwd, ".minicode", "hooks"), { recursive: true })
    writeFileSync(
      join(cwd, ".minicode", "hooks", "post-probe.js"),
      `import fs from "node:fs";\nfs.appendFileSync(process.env.PROBE_OUT, "x\\n");\n`,
    )
    const provider = startFakeProvider([{ kind: "text", text: "ok" }])
    writeFileSync(
      join(cwd, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["m"] }],
      }),
      "utf8",
    )
    const countRuns = (): number => {
      try {
        return readFileSync(marker, "utf8").split("\n").filter(Boolean).length
      } catch {
        return 0
      }
    }
    let ctx: Awaited<ReturnType<typeof createCliSession>> | undefined
    try {
      ctx = await createCliSession({
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
      // 1) WorkMode EXECUTE + permissionMode auto → hook post JALAN.
      await ctx.runPromptWithVerify("turn pertama")
      expect(countRuns()).toBe(1)
      // 2) Operator turunkan WorkMode ke PLAN (Q3=A3) → hook DILEWATI.
      expect(ctx.workModeControl).toBeDefined()
      ctx.workModeControl!.setWorkMode("PLAN")
      expect(ctx.workModeControl!.getWorkMode()).toBe("PLAN")
      await ctx.runPromptWithVerify("turn plan")
      expect(countRuns()).toBe(1)
      // 3) Operator turunkan WorkMode ke DISCUSS → hook tetap DILEWATI.
      ctx.workModeControl!.setWorkMode("DISCUSS")
      await ctx.runPromptWithVerify("turn discuss")
      expect(countRuns()).toBe(1)
      // 4) Kembali EXECUTE → hook jalan lagi.
      ctx.workModeControl!.setWorkMode("EXECUTE")
      await ctx.runPromptWithVerify("turn ketiga")
      expect(countRuns()).toBe(2)
      // 5) Runtime ganti PermissionMode ke readonly di bawah EXECUTE → hook DILEWATI.
      ctx.permissions!.setMode("readonly")
      await ctx.runPromptWithVerify("turn exec readonly")
      expect(countRuns()).toBe(2)
    } finally {
      if (ctx) await ctx.close().catch(() => {})
      provider.close()
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      if (savedUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedUserProfile
      if (savedMinicodeHome === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = savedMinicodeHome
      if (savedProbeOut === undefined) delete process.env.PROBE_OUT
      else process.env.PROBE_OUT = savedProbeOut
    }
  })
})
