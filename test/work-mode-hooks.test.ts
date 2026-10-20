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

  test("DISCUSS menahan hooks di SEMUA permission mode (termasuk auto)", () => {
    for (const pm of ["auto", "ask", "plan", "allow-all", "allowlist", "readonly"] as const) {
      expect(shouldRunHooks(pm, "DISCUSS")).toBe(false)
    }
  })

  test("PLAN/EXECUTE mempertahankan perilaku permission mode (auto = jalan)", () => {
    expect(shouldRunHooks("auto", "PLAN")).toBe(true)
    expect(shouldRunHooks("auto", "EXECUTE")).toBe(true)
  })

  test("PLAN/EXECUTE × plan/readonly tetap menahan (kontrak lama)", () => {
    for (const wm of ["PLAN", "EXECUTE"] as const) {
      expect(shouldRunHooks("plan", wm)).toBe(false)
      expect(shouldRunHooks("readonly", wm)).toBe(false)
    }
  })
})

describe("eksekusi nyata — guard DISCUSS mencegah runRunHooks", () => {
  // Bukti eksekusi nyata (bukan sekadar predicate): runRunHooks benar-benar
  // men-spawn hook yang menulis marker. Guard `!shouldRunHooks(...)` adalah
  // LOGIKA `runHooksGated` di cli/setup.ts — bila DISCUSS → runRunHooks tak
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
    // Guard runHooksGated: shouldRunHooks(false) → runRunHooks tidak dipanggil.
    // Ini mereplikasi satu-satunya jalur hooks production di cli/setup.ts.
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

  test("PLAN × auto (guard mengizinkan, perilaku lama) → hook JALAN", async () => {
    const root = tmpRoot("plan")
    const marker = join(root, "plan-ran.txt")
    writeMarkerHook(root, marker)
    process.env.MINICODE_HOOKS = "1"
    expect(shouldRunHooks("auto", "PLAN")).toBe(true)
    await runRunHooks("pre", { phase: "pre", prompt: "halo", cwd: root })
    expect(readFileSync(marker, "utf8")).toBe("jalan")
  })
})

// ── Integrasi jalur PRODUCTION (P12 S2.2 polish M2) ──────────────────────────
//
// Test di atas menguji predikat + `runRunHooks` langsung, plus satu replikasi
// guard di dalam test. Yang BELUM dibuktikan: apakah `runHooksGated` di
// `cli/setup.ts` benar-benar memakai WorkMode AKTIF pada sesi yang sedang
// berjalan. Test di bawah memakai jalur production sungguhan —
// `createCliSession` (composition root) → `runPromptWithVerify` → `runHooksGated`
// → `runRunHooks` → hook Node yang menulis marker.
//
// Catatan jalur produksi: `cli/setup.ts` memanggil hook fase "post" (dua call
// site, keduanya "post"); fase "pre" tidak dipanggil dari produksi. Karena itu
// marker memakai hook "post".
describe("integrasi produksi — transisi WorkMode menghentikan hook pada sesi yang sama", () => {
  test("EXECUTE → hook jalan; setWorkMode(DISCUSS) → hook berikutnya DILEWATI", async () => {
    const { createCliSession } = await import("../cli/setup.ts")
    const { startFakeProvider } = await import("./helpers/fake-provider.ts")
    const cwd = tmpRoot("prod")
    const home = tmpRoot("prodhome")
    // Isolasi penuh: `findRunHooks` memakai `homedir()` LANGSUNG (tak
    // menghormati MINICODE_HOME), jadi home asli mesin ini harus dinetralkan
    // agar hook global tak ikut dieksekusi dan hasil tak deterministik.
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
    // Hook post: satu baris per eksekusi → jumlah baris = jumlah hook jalan.
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
      // 2) Operator turunkan WorkMode ke DISCUSS pada SESI YANG SAMA.
      expect(ctx.workModeControl).toBeDefined()
      ctx.workModeControl!.setWorkMode("DISCUSS")
      expect(ctx.workModeControl!.getWorkMode()).toBe("DISCUSS")
      // 3) Hook berikutnya harus DILEWATI (marker tak bertambah).
      await ctx.runPromptWithVerify("turn kedua")
      expect(countRuns()).toBe(1)
      // 4) Kembali EXECUTE → hook jalan lagi (bukan dimatikan selamanya).
      ctx.workModeControl!.setWorkMode("EXECUTE")
      await ctx.runPromptWithVerify("turn ketiga")
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
