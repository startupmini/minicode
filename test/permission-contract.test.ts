// Kontrak permission lintas-slice (P12 S1.2) — test-only, tanpa perubahan src.
//
// Empat kontrak yang dikunci di sini:
//   A. Headless/abort: jalur approval yang tak tersedia → deny TANPA prompt;
//      request yang sudah di-abort → deny tanpa approval (fail-closed).
//   B. allow-all tetap menjalankan inspeksi bash (deny + alasan + kontrol jinak).
//   C. describeDenial: baca-sekali, terikat call id, dan tak mengubah keputusan.
//   D. K-1 `always`: grant sesi in-memory + tulis repo-lokal; entri lokal inert
//      secara default (aktif hanya dengan allowLocalConfig); kunci PENUH
//      (tanpa truncation); arg >2 KB tak dipersistenkan.
//
// Kenapa subproses (kontrak D): loadAllowlist (allowlist.ts) membaca
// `homedir()/.minicode/allowlist.json` global yang path-nya DIHITUNG SAAT
// IMPORT (modul-const) dan tak punya seam injeksi. Satu-satunya cara
// hermetik tanpa mengubah src adalah menjalankan handler asli di proses
// anak dengan HOME/USERPROFILE = tmp (pola yang sama dengan
// local-config-optin.test.ts:197-209). Pada kontrak A–C, jalur yang diuji
// (gated headless, abort dini, allow-all, describeDenial) tidak menyentuh
// allowlist sehingga aman in-process.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { matchAllowlist } from "../src/policy/allowlist.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"
import type { ToolCall } from "../vendor/minicore/src/core/types.ts"
import { type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
})

let seq = 0
const call = (id: string, name: string, args: unknown): ToolCall => ({
  id: `${id}-${++seq}`,
  name,
  args,
})

// Handle describeDenial: createPermissionHandler dideklarasikan mengembalikan
// PermissionHandler polos; seam aditif diakses lewat cast (pola deny-reason).
type ReasonedHandler = {
  check(c: ToolCall, deps?: unknown): Promise<"allow" | "deny">
  describeDenial(c: ToolCall): string | undefined
}
function reasoned(opts: Parameters<typeof createPermissionHandler>[0]): ReasonedHandler {
  return createPermissionHandler(opts) as unknown as ReasonedHandler
}

function tmpRoot(tag: string): string {
  return mkdtempSync(join(tmpdir(), `mc-contract-${tag}-`))
}

const repoRoot = join(import.meta.dir, "..")
const permissionModule = JSON.stringify(join(repoRoot, "src", "policy", "permission.ts"))

// Runner terisolasi: handler ASLI di proses anak dengan home kosong. Output =
// satu baris JSON dari script; assertion tetap di proses induk.
async function runIsolated(script: string): Promise<Record<string, unknown>> {
  const home = tmpRoot("home")
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`runner terisolasi gagal (exit ${code}): ${err}`)
    const line = out.trim().split("\n").filter(Boolean).at(-1) ?? ""
    if (!line) throw new Error("runner terisolasi tanpa output")
    return JSON.parse(line) as Record<string, unknown>
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ── Contract A — headless approval & abort ──

describe("contract A — approval tak tersedia & abort", () => {
  test("A1 gated non-TTY: deny TANPA memanggil prompt walau ask tersedia", async () => {
    // TTY dipaksa false lewat harness agar deterministik di terminal dev
    // maupun CI (tanpa ini, mesin ber-TTY justru memanggil prompt).
    tty = installFakeTty({ isTTY: false })
    const root = tmpRoot("a1")
    try {
      let prompts = 0
      const h = reasoned({
        mode: "auto",
        root,
        ask: async () => {
          prompts++
          return "allow"
        },
      })
      const c = call("a1", "delegate_task", { prompt: "x" })
      expect(await h.check(c, {} as never)).toBe("deny")
      // Bukti tanpa prompt: ask capable-allow pun nol panggilan.
      expect(prompts).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("A2 request sudah aborted: deny, tanpa prompt, tanpa approval susulan", async () => {
    const root = tmpRoot("a2")
    try {
      let prompts = 0
      const h = reasoned({
        mode: "auto",
        root,
        ask: async () => {
          prompts++
          return "allow"
        },
      })
      const controller = new AbortController()
      controller.abort()
      const c = call("a2", "delegate_task", { prompt: "x" })
      expect(await h.check(c, { signal: controller.signal } as never)).toBe("deny")
      expect(prompts).toBe(0)
      // Abort dicek SEBELUM gerbang: tak ada alasan yang tercatat untuk call ini.
      expect(h.describeDenial(c)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── Contract B — allow-all tetap menginspeksi bash ──

describe("contract B — allow-all bukan bypass bash-guard", () => {
  test("B1 perintah berbahaya deny + alasan; kontrol jinak tetap allow", async () => {
    const root = tmpRoot("b1")
    try {
      const h = reasoned({ mode: "allow-all", root })
      const danger = call("b1-rm", "bash", { cmd: "rm -rf /" })
      expect(await h.check(danger, {} as never)).toBe("deny")
      // Cross-contract: keputusan deny dapat dijelaskan ke model (seam
      // describeDenial) dan berasal dari guard, bukan deny buta.
      expect(h.describeDenial(danger)).toBe("bash-guard: destructive rm")
      const benign = call("b1-echo", "bash", { cmd: "echo hi" })
      expect(await h.check(benign, {} as never)).toBe("allow")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── Contract C — describeDenial: baca-sekali, scoped, observasional ──

describe("contract C — describeDenial observability", () => {
  test("C1 baca-sekali + terikat call id; membaca tak mengubah denial", async () => {
    const root = tmpRoot("c1")
    try {
      const h = reasoned({ mode: "allow-all", root })
      const c1 = call("c1", "bash", { cmd: "rm -rf /" })
      const c2 = call("c1b", "bash", { cmd: "rm -rf /" })
      expect(await h.check(c1, {} as never)).toBe("deny")
      expect(await h.check(c2, {} as never)).toBe("deny")
      // Baca pertama memberi alasan; baca kedua undefined (hapus-saat-baca).
      expect(h.describeDenial(c1)).toBe("bash-guard: destructive rm")
      expect(h.describeDenial(c1)).toBeUndefined()
      // Alasan call lain tak bocor; id tak dikenal = tak ada alasan.
      expect(h.describeDenial(c2)).toBe("bash-guard: destructive rm")
      expect(h.describeDenial(call("c1-asing", "bash", { cmd: "rm -rf /" }))).toBeUndefined()
      // Sisi "tak membatalkan/membuka": call yang diizinkan tak punya alasan,
      // dan membaca alasan tak mengubah keputusan check berikutnya.
      const benign = call("c1-echo", "bash", { cmd: "echo hi" })
      expect(await h.check(benign, {} as never)).toBe("allow")
      expect(h.describeDenial(benign)).toBeUndefined()
      const c3 = call("c1-ulang", "bash", { cmd: "rm -rf /" })
      expect(await h.check(c3, {} as never)).toBe("deny")
      expect(h.describeDenial(c3)).toBe("bash-guard: destructive rm")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── Contract D — K-1 `always` (subproses HOME terisolasi) ──

describe("contract D — K-1 always: persistensi repo-lokal & scope kunci", () => {
  test("D1/D2 always = grant sesi + tulis <root>/.minicode/allowlist.json", async () => {
    const root = tmpRoot("d12")
    try {
      const args = { path: "p12-always.txt", content: "x" }
      const script = `
        const { createPermissionHandler } = await import(${permissionModule})
        const { existsSync, readFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        const root = ${JSON.stringify(root)}
        const args = ${JSON.stringify(args)}
        let asks = 0
        const h = createPermissionHandler({ mode: "ask", root, ask: async () => { asks++; return "always" } })
        const first = await h.check({ id: "d1-1", name: "write_file", args }, {})
        const asksAfterFirst = asks
        const second = await h.check({ id: "d1-2", name: "write_file", args }, {})
        const asksAfterSecond = asks
        const file = join(root, ".minicode", "allowlist.json")
        const allowed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).allowed : null
        console.log(JSON.stringify({ first, second, asksAfterFirst, asksAfterSecond, allowed, key: "write_file:" + JSON.stringify(args) }))
      `
      const r = await runIsolated(script)
      expect(r.first).toBe("allow")
      expect(r.asksAfterFirst).toBe(1)
      // Grant sesi in-memory: call berikutnya dengan kunci sama tidak ditanya.
      expect(r.second).toBe("allow")
      expect(r.asksAfterSecond).toBe(1)
      // K-1/M4: tujuan tulis = repo-lokal di bawah root temp (bukan global).
      expect(r.allowed).toEqual([r.key])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("D3/D4 entri lokal inert default; aktif dengan allowLocalConfig opt-in", async () => {
    const root = tmpRoot("d34")
    try {
      const args = { path: "p12-local.txt", content: "x" }
      const script = `
        const { createPermissionHandler } = await import(${permissionModule})
        const { mkdirSync, writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        const root = ${JSON.stringify(root)}
        const args = ${JSON.stringify(args)}
        const key = "write_file:" + JSON.stringify(args)
        mkdirSync(join(root, ".minicode"), { recursive: true })
        writeFileSync(join(root, ".minicode", "allowlist.json"), JSON.stringify({ allowed: [key] }))
        let askedDefault = 0
        const hDefault = createPermissionHandler({ mode: "ask", root, ask: async () => { askedDefault++; return "deny" } })
        const dDefault = await hDefault.check({ id: "d3", name: "write_file", args }, {})
        let askedOptIn = 0
        const hOptIn = createPermissionHandler({ mode: "ask", root, allowLocalConfig: true, ask: async () => { askedOptIn++; return "deny" } })
        const dOptIn = await hOptIn.check({ id: "d4", name: "write_file", args }, {})
        console.log(JSON.stringify({ dDefault, askedDefault, dOptIn, askedOptIn }))
      `
      const r = await runIsolated(script)
      // D3/M5: tanpa opt-in, entri repo-lokal TIDAK dibaca → tetap bertanya.
      expect(r.dDefault).toBe("deny")
      expect(r.askedDefault).toBe(1)
      // D4: dengan opt-in, entri lokal cocok → allow tanpa prompt.
      expect(r.dOptIn).toBe("allow")
      expect(r.askedOptIn).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("D5 kunci = nama + JSON arg PENUH (prefix 200-char ala bug lama tak cocok)", async () => {
    const root = tmpRoot("d5")
    try {
      // Reproduksi temuan audit #07: dua arg dengan 200 karakter pertama
      // identik, ekor berbeda. Matching lama (slice 0,200) menganggapnya
      // kunci yang sama → entri jinak me-allow perintah jahat.
      const pad = "A".repeat(260)
      const storedArgs = { path: "p12-prefix.txt", content: `${pad}benign` }
      const callArgs = { path: "p12-prefix.txt", content: `${pad}evil` }
      const storedKey = `write_file:${JSON.stringify(storedArgs)}`
      const callKey = `write_file:${JSON.stringify(callArgs)}`
      // Prasyarat fixture: prefix 200 char memang identik (kalau tidak,
      // test tak membuktikan apa-apa soal truncation).
      expect(storedKey.slice(0, 200)).toBe(callKey.slice(0, 200))
      // Unit-level: matchAllowlist penuh-kunci menolak kunci prefix ini.
      expect(matchAllowlist({ name: "write_file", args: callArgs } as never, [storedKey])).toBe(
        false,
      )
      const script = `
        const { createPermissionHandler } = await import(${permissionModule})
        const { mkdirSync, writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        const root = ${JSON.stringify(root)}
        const callArgs = ${JSON.stringify(callArgs)}
        mkdirSync(join(root, ".minicode"), { recursive: true })
        writeFileSync(join(root, ".minicode", "allowlist.json"), JSON.stringify({ allowed: [${JSON.stringify(storedKey)}] }))
        let asked = 0
        const h = createPermissionHandler({ mode: "ask", root, allowLocalConfig: true, ask: async () => { asked++; return "deny" } })
        const decision = await h.check({ id: "d5", name: "write_file", args: callArgs }, {})
        console.log(JSON.stringify({ decision, asked }))
      `
      const r = await runIsolated(script)
      expect(r.decision).toBe("deny")
      expect(r.asked).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("D6 arg >2 KB tidak dipersistenkan (bukan juga grant sesi)", async () => {
    const root = tmpRoot("d6")
    try {
      const bigArgs = { path: "p12-big.txt", content: "A".repeat(2500) }
      const script = `
        const { createPermissionHandler } = await import(${permissionModule})
        const { existsSync, readFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        const root = ${JSON.stringify(root)}
        const args = ${JSON.stringify(bigArgs)}
        let asks = 0
        const h = createPermissionHandler({ mode: "ask", root, ask: async () => { asks++; return "always" } })
        const first = await h.check({ id: "d6-1", name: "write_file", args }, {})
        const asksAfterFirst = asks
        const second = await h.check({ id: "d6-2", name: "write_file", args }, {})
        const asksAfterSecond = asks
        const file = join(root, ".minicode", "allowlist.json")
        const allowed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).allowed : []
        console.log(JSON.stringify({ argsLength: JSON.stringify(args).length, first, second, asksAfterFirst, asksAfterSecond, stored: allowed.includes("write_file:" + JSON.stringify(args)) }))
      `
      const r = await runIsolated(script)
      // Prasyarat fixture: arg memang melewati cap.
      expect(r.argsLength as number).toBeGreaterThan(2000)
      // "always" tetap mengizinkan operasi saat itu...
      expect(r.first).toBe("allow")
      expect(r.asksAfterFirst).toBe(1)
      // ...tapi tak jadi grant sesi maupun entri persisten (implementasi kini:
      // early-return sebelum sessionGrants) → call berikutnya ditanya lagi.
      expect(r.second).toBe("allow")
      expect(r.asksAfterSecond).toBe(2)
      expect(r.stored).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
