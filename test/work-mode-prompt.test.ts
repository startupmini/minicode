// Guidance system-prompt ber-keyed WorkMode (P12 S2.2) — discusHint + PLAN prompt.
//
// Membuktikan:
// 1. `workModeHint` menghasilkan teks posture yang BENAR per WorkMode:
//    - DISCUSS = investigasi baca-saja berorientasi DISKUSI (bukan sekadar
//      "read-only" — refleksi D-1 owner), melarang tulis/eksekusi.
//    - PLAN = planning formal dengan prompt SENDIRI (independen dari
//      `planHint` milik PermissionMode).
//    - EXECUTE = identitas (tidak menambah apa pun).
// 2. Teks itu BENAR-BENAR mencapai wire (system prompt) lewat createMinicodeSession:
//    FakeProvider merekam StreamRequest.system, jadi hint DISCUSS/PLAN terbukti
//    terkirim — bukan hanya fungsi mati yang tak dipanggil.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider } from "#minicore/test/fakes.ts"
import { createMinicodeSession, workModeHint } from "../src/app/session.ts"
import { readFileTool } from "../src/tools/read_file.ts"

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function tmpRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `mc-wmp-${tag}-`))
  roots.push(root)
  return root
}

describe("workModeHint — teks posture per WorkMode (murni)", () => {
  test("DISCUSS = investigasi baca-saja berorientasi diskusi", () => {
    const h = workModeHint("DISCUSS")
    expect(h).toContain("DISCUSS MODE")
    expect(h).toContain("discuss")
    expect(h).toContain("Do NOT modify files")
    expect(h).toContain("Do not implement or execute")
  })

  test("PLAN = planning formal dengan prompt sendiri", () => {
    const h = workModeHint("PLAN")
    expect(h).toContain("PLAN MODE")
    expect(h).toContain("planning mode")
    expect(h).toContain("Do NOT modify files")
    expect(h).toContain("implementation plan")
  })

  test("EXECUTE = identitas (tidak menambah apa pun)", () => {
    expect(workModeHint("EXECUTE")).toBe("")
  })

  test("PLAN hint berbeda dari planHint PermissionMode (mandiri)", () => {
    // Lapisan intent ≠ lapisan permission: teks PLAN WorkMode tidak boleh
    // sekadar menyalin string planHint permission (yang berbunyi "read-only
    // planning mode ... concrete implementation plan").
    const wm = workModeHint("PLAN")
    expect(wm).toContain("investigate thoroughly")
    expect(wm).not.toContain("read-only planning mode")
  })
})

describe("createMinicodeSession — hint WorkMode mencapai wire (system prompt)", () => {
  async function systemFor(workMode: "DISCUSS" | "PLAN" | "EXECUTE"): Promise<string> {
    const dir = tmpRoot(workMode.toLowerCase())
    await mkdir(join(dir, ".minicode"), { recursive: true })
    const provider = new FakeProvider([])
    const session = await createMinicodeSession({
      provider,
      tools: [readFileTool],
      cwd: dir,
      permissionMode: "auto",
      workMode,
    })
    await session.run("helm")
    const req = provider.requests[0]
    return typeof req?.system === "string" ? req.system : ""
  }

  test("workMode DISCUSS → system prompt memuat discusHint", async () => {
    const sys = await systemFor("DISCUSS")
    expect(sys).toContain("DISCUSS MODE")
    expect(sys).toContain("discuss findings, options, and trade-offs")
  })

  test("workMode PLAN → system prompt memuat PLAN prompt sendiri", async () => {
    const sys = await systemFor("PLAN")
    expect(sys).toContain("PLAN MODE")
    expect(sys).toContain("concrete implementation plan")
  })

  test("workMode EXECUTE → system prompt TANPA hint DISCUSS/PLAN", async () => {
    const sys = await systemFor("EXECUTE")
    expect(sys).not.toContain("DISCUSS MODE")
    expect(sys).not.toContain("PLAN MODE")
  })

  test("PLAN × auto (permission BUKAN plan) tetap memuat hint PLAN intent", async () => {
    // Kunci kemandirian: hint WorkMode aktif walau planHint permission mati.
    const sys = await systemFor("PLAN")
    expect(sys).toContain("PLAN MODE")
  })

  test("transisi runtime EXECUTE → DISCUSS → PLAN → EXECUTE menyegarkan StreamRequest.system per turn (G-PROMPT-RT tertutup)", async () => {
    const dir = tmpRoot("rt-prompt")
    await mkdir(join(dir, ".minicode"), { recursive: true })
    const provider = new FakeProvider([])
    let wmCtl: { setWorkMode(m: "DISCUSS" | "PLAN" | "EXECUTE"): void } | undefined
    let pmCtl: { setMode(m: "auto" | "plan" | "readonly"): void } | undefined
    const session = await createMinicodeSession({
      provider,
      tools: [readFileTool],
      cwd: dir,
      permissionMode: "auto",
      workMode: "EXECUTE",
      onWorkMode: (ctl) => {
        wmCtl = ctl
      },
      onPermissions: (ctl) => {
        pmCtl = ctl as never
      },
    })

    // Turn 1: EXECUTE × auto → tanpa hint DISCUSS/PLAN.
    await session.run("t1")
    const sys1 = String(provider.requests[0]?.system ?? "")
    expect(sys1).not.toContain("DISCUSS MODE")
    expect(sys1).not.toContain("PLAN MODE")

    // Turn 2: pindah ke DISCUSS di tengah sesi → system prompt langsung memuat DISCUSS MODE.
    wmCtl!.setWorkMode("DISCUSS")
    await session.run("t2")
    const sys2 = String(provider.requests[1]?.system ?? "")
    expect(sys2).toContain("DISCUSS MODE")
    expect(sys2).not.toContain("PLAN MODE")

    // Turn 3: pindah ke PLAN di tengah sesi → system prompt langsung memuat PLAN MODE (WorkMode).
    wmCtl!.setWorkMode("PLAN")
    await session.run("t3")
    const sys3 = String(provider.requests[2]?.system ?? "")
    expect(sys3).toContain("PLAN MODE")
    expect(sys3).toContain("investigate thoroughly")
    expect(sys3).not.toContain("DISCUSS MODE")

    // Turn 4: kembali ke EXECUTE, lalu ganti PermissionMode ke plan → hint WorkMode PLAN hilang, planHint PermissionMode aktif.
    wmCtl!.setWorkMode("EXECUTE")
    pmCtl!.setMode("plan")
    await session.run("t4")
    const sys4 = String(provider.requests[3]?.system ?? "")
    expect(sys4).not.toContain("DISCUSS MODE")
    expect(sys4).not.toContain("investigate thoroughly")
    expect(sys4).toContain("read-only planning mode")
  })
})
