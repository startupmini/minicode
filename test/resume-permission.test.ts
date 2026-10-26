// P12 S1.3 — lifetime state permission di batas resume/restart (test-only).
//
// Tiga state yang TIDAK boleh dikonflasi:
//   1. mode runtime    — dihitung dari flag invokasi (cli/setup.ts:817) dan
//      menjadi state per-handler; BUKAN bagian dari state sesi yang
//      dipersistenkan;
//   2. grant runtime   — sessionGrants/allowlistCache, closure handler
//      (src/policy/permission.ts:182-186); mati bersama handler/proses;
//   3. allowlist lokal — `.minicode/allowlist.json` repo-local: satu-satunya
//      kanal yang menyeberangi proses, dan hanya aktif dengan opt-in (K-1).
//
// R1 memakai jalur `--resume` SUNGGUHAN (CLI sebagai proses + provider tiruan,
// pola test/cli-session.test.ts:685): resume memuat riwayat sesi, tetapi mode
// tetap datang dari flag invokasi. Ini detektor untuk mutasi M6 ("persist
// runtime permission mode across process restarts"): bila mode dipersistenkan
// lalu direstorasi saat resume, run B (resume tanpa flag setelah sesi plan)
// akan tetap menolak tulis → assertion berkas di bawah gagal. Handler-level
// saja tidak cukup: mutasi M6 hidup di jalur setup/resume, bukan di closure.
//
// R2 memakai handler asli di proses anak dengan HOME terisolasi (pola
// permission-contract.test.ts): grant "always" milik h1 tak terlihat oleh
// handler baru di proses yang sama maupun oleh proses baru; entri lokal yang
// ditulis "always" tetap inert sampai opt-in eksplisit diberikan.
//
// Tidak ada mutasi produksi yang dijalankan di sini — ekspektasi M4/M5/M6
// murni statis (lihat laporan slice).

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startFakeProvider } from "./helpers/fake-provider.ts"

const repoRoot = join(import.meta.dir, "..")
const cliEntry = join(repoRoot, "cli", "index.ts")
// Path absolut: skrip anak mengimpor modul ASLI lewat import dinamis, bukan
// import statis test — modul permission harus dievaluasi di proses anak yang
// HOME-nya sudah diisolasi (global allowlist dibaca dari homedir()).
const permissionModule = JSON.stringify(join(repoRoot, "src", "policy", "permission.ts"))

// ── Harness CLI (mini, pola test/cli-session.test.ts) ──

interface Workspace {
  dir: string
  home: string
}

function makeWorkspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "mc-resume-perm-"))
  const home = join(dir, "home")
  // `.minicode/` lokal wajib ada lebih dulu: resolveDbPath memilih DB lokal
  // hanya bila direktori itu ada — tanpa ini sesi jatuh ke DB global HOME dan
  // test kehilangan hermeticity.
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  mkdirSync(join(home, ".minicode"), { recursive: true })
  return { dir, home }
}

function writeProviderConfig(ws: Workspace, baseUrl: string): void {
  writeFileSync(
    join(ws.dir, ".minicode", "config.json"),
    JSON.stringify({
      providers: [
        {
          id: "fake",
          baseUrl,
          apiKey: "sk-test",
          models: ["gpt-4o-mini"],
          providerHint: "openai",
        },
      ],
    }),
    "utf8",
  )
}

async function runCli(
  ws: Workspace,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd: ws.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: ws.home,
      USERPROFILE: ws.home,
      NO_COLOR: "1",
      MINICODE_TELEMETRY: "1",
      // Flag mode dari env dinetralkan agar R1 mengukur flag argv saja
      // (MINICODE_PLAN=1 di env mesin dev tiruan tak boleh mengubah hasil).
      MINICODE_PLAN: "0",
      DEEPSEEK_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      AGENT_BASE_URL: "",
    },
  })
  const killer = setTimeout(() => proc.kill(), 60_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(killer)
  }
}

// ── Runner proses anak: handler asli, HOME kosong ──

// Output = satu baris JSON dari skrip; assertion tetap di proses induk.
// HOME/USERPROFILE per-panggilan → global allowlist tiap proses dijamin kosong
// (real ~/.minicode milik mesin ini tidak pernah dibaca maupun ditulis).
async function runIsolated(script: string): Promise<Record<string, unknown>> {
  const home = mkdtempSync(join(tmpdir(), "mc-resume-home-"))
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

describe("R1 — resume: mode dari flag invokasi, bukan state sesi (detektor M6)", () => {
  test("sesi plan → resume tanpa flag = auto; resume dengan --plan tetap plan", async () => {
    const ws = makeWorkspace()
    const sid = "s-perm-life"
    const base = ["--cwd", ws.dir, "--model", "gpt-4o-mini", "--allow-local-config"]
    try {
      // Run A — premis: sesi lahir di plan mode; tulis ditolak, berkas tak ada.
      const pA = startFakeProvider([
        { kind: "tool", name: "write_file", args: { path: "rA.txt", content: "x" } },
        { kind: "text", text: "rencana" },
      ])
      try {
        writeProviderConfig(ws, pA.baseUrl)
        const a = await runCli(ws, ["--session", sid, "--plan", ...base, "tulis rA.txt"])
        expect(a.code).toBe(0)
        expect(existsSync(join(ws.dir, "rA.txt"))).toBe(false)
      } finally {
        pA.close()
      }

      // Run B — inti M6: resume TANPA flag mode. Bila mode lama (plan)
      // direstorasi dari state sesi alih-alih dihitung ulang, write_file
      // tetap ditolak → berkas tak pernah dibuat → assertion gagal.
      const pB = startFakeProvider([
        { kind: "tool", name: "write_file", args: { path: "rB.txt", content: "x" } },
        { kind: "text", text: "selesai" },
      ])
      try {
        writeProviderConfig(ws, pB.baseUrl)
        const b = await runCli(ws, ["--resume", sid, ...base, "tulis rB.txt"])
        expect(b.code).toBe(0)
        // Premis jalur resume benar-benar aktif (bukan sesi baru senyap).
        expect(b.stderr).toContain(`resumed session ${sid}`)
        // Mode auto (default) → tulis diizinkan.
        expect(existsSync(join(ws.dir, "rB.txt"))).toBe(true)
      } finally {
        pB.close()
      }

      // Run C — kontrol arah sebaliknya: flag pada invokasi resume tetap
      // dihormati, jadi bukan "resume selalu auto" maupun carry-over run B.
      const pC = startFakeProvider([
        { kind: "tool", name: "write_file", args: { path: "rC.txt", content: "x" } },
        { kind: "text", text: "rencana" },
      ])
      try {
        writeProviderConfig(ws, pC.baseUrl)
        const c = await runCli(ws, ["--resume", sid, "--plan", ...base, "tulis rC.txt"])
        expect(c.code).toBe(0)
        expect(existsSync(join(ws.dir, "rC.txt"))).toBe(false)
      } finally {
        pC.close()
      }
    } finally {
      rmSync(ws.dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("R2 — grant & mode berumur handler/proses; lintas-proses hanya allowlist opt-in", () => {
  test("always → h1; handler/proses baru tak mewarisi; opt-in yang mengaktifkan", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-resume-grant-"))
    try {
      const args = { path: "r-grant.txt", content: "x" }
      const key = `write_file:${JSON.stringify(args)}`

      // Proses A — grant "always" hidup hanya di h1; handler baru di proses
      // yang sama tidak mewarisinya, dan mode __setMode juga tidak bocor.
      const a = await runIsolated(`
          const { createPermissionHandler } = await import(${permissionModule})
          const { existsSync, readFileSync } = await import("node:fs")
          const { join } = await import("node:path")
          const root = ${JSON.stringify(root)}
          const args = ${JSON.stringify(args)}
          let asks = 0
          const h1 = createPermissionHandler({ mode: "ask", root, ask: async () => { asks++; return "always" } })
          const first = await h1.check({ id: "ra-1", name: "write_file", args }, {})
          const asksAfterFirst = asks
          const second = await h1.check({ id: "ra-2", name: "write_file", args }, {})
          const asksAfterSecond = asks
          h1.__setMode("allow-all")
          const modeH1 = h1.__getMode()
          let asksFresh = 0
          const h2 = createPermissionHandler({ mode: "ask", root, ask: async () => { asksFresh++; return "deny" } })
          const modeH2 = h2.__getMode()
          const freshDecision = await h2.check({ id: "ra-3", name: "write_file", args }, {})
          const file = join(root, ".minicode", "allowlist.json")
          const stored = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).allowed : null
          console.log(JSON.stringify({ first, asksAfterFirst, second, asksAfterSecond, modeH1, modeH2, freshDecision, asksFresh, stored }))
        `)
      expect(a.first).toBe("allow")
      expect(a.asksAfterFirst).toBe(1)
      // Premis grant in-handler: call identik berikutnya tak ditanya lagi.
      expect(a.second).toBe("allow")
      expect(a.asksAfterSecond).toBe(1)
      // Mode = state handler: h1 benar-benar berubah ke allow-all, handler
      // baru tetap "ask" (mutasi "mode disimpan global" akan gagal di sini).
      expect(a.modeH1).toBe("allow-all")
      expect(a.modeH2).toBe("ask")
      // Grant h1 tidak bocor ke handler baru di proses yang sama.
      expect(a.freshDecision).toBe("deny")
      expect(a.asksFresh).toBe(1)
      // M4: persistensi "always" menulis ke repo-lokal <root>/.minicode/...
      expect(a.stored).toEqual([key])

      // Proses B — proses baru, tanpa opt-in: entri yang SUDAH ada di disk
      // tetap inert; grant/mode proses A tidak menyeberang (mutasi M5
      // "allowLocal default true" akan membuat deny di sini jadi allow).
      const b = await runIsolated(`
          const { createPermissionHandler } = await import(${permissionModule})
          const root = ${JSON.stringify(root)}
          const args = ${JSON.stringify(args)}
          let asked = 0
          const h = createPermissionHandler({ mode: "ask", root, ask: async () => { asked++; return "deny" } })
          const decision = await h.check({ id: "rb-1", name: "write_file", args }, {})
          const modeDefault = createPermissionHandler({ root }).__getMode()
          console.log(JSON.stringify({ decision, asked, modeDefault }))
        `)
      expect(b.decision).toBe("deny")
      expect(b.asked).toBe(1)
      // Handler segar mulai dari default konstruktor, bukan state proses lama.
      expect(b.modeDefault).toBe("auto")

      // Proses C — satunya kanal lintas-proses: allowlist repo-lokal, dan
      // hanya aktif dengan opt-in eksplisit (K-1 dipertahankan).
      const c = await runIsolated(`
          const { createPermissionHandler } = await import(${permissionModule})
          const root = ${JSON.stringify(root)}
          const args = ${JSON.stringify(args)}
          let asked = 0
          const h = createPermissionHandler({ mode: "ask", root, allowLocalConfig: true, ask: async () => { asked++; return "deny" } })
          const decision = await h.check({ id: "rc-1", name: "write_file", args }, {})
          console.log(JSON.stringify({ decision, asked }))
        `)
      expect(c.decision).toBe("allow")
      expect(c.asked).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
