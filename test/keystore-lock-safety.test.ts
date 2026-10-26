// Keystore lock safety — koreksi R1..R6 hasil design review.
//
// Invariant yang dijaga: pembaruan credential konkuren tak boleh diam-diam
// menghilangkan credential yang sudah ada.
//
// Yang DIPERBAIKI (rekomendasi owner disetujui):
// - R1: kunci yang PEMILIKNYA HIDUP tak pernah digeser hanya karena umurnya.
//       Kalau kunci tak bisa didapat dalam batas waktu → fail-closed (tak ada
//       yang ditulis, cache tak disentuh).
// - R2: reclaim hanya kalau payload SAH dan identitasnya cocok (host +
//       namespace PID) DAN pid pemilik benar-benar absent. Payload korup,
//       terputus, atau format lama → ownership UNKNOWN → fail-closed.
// - R3: proteksi DPAPI (powershell, s/d 15 detik) dijalankan di luar kunci.
// - R4: payload korup/terputus tak boleh direbut; gagal tertutup dengan pesan
//       yang menyebut path kunci (tanpa nilai rahasia).
// - R5: release hanya untuk kunci yang tokennya masih milik kita.
// - R6: sisa reclaim (prefix "<nama>.lock.stale.") dibersihkan secara
//       terbatas; path kunci aktif tak pernah disentuh.
//
// Semua kredensial di fixture ini SINTETIS; home terisolasi per test.
import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __keystoreLockPayloadForTest,
  __resetKeystoreForTest,
  __setKeystoreLockTimingForTest,
  __setKeystoreWriterForTest,
  setSecret,
} from "../src/lib/keystore.ts"

const SRC = new URL("../src/", import.meta.url).href.replace(/\/$/, "")
const tmpRoots: string[] = []
const prevHome = process.env.MINICODE_HOME
const prevDisable = process.env.MINICODE_KEYSTORE_DISABLE

function useHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-ks-lock-"))
  tmpRoots.push(dir)
  process.env.MINICODE_HOME = dir
  process.env.MINICODE_KEYSTORE_DISABLE = "1"
  return dir
}

function storeFile(home: string): string {
  return join(home, ".minicode", "secrets.json")
}

function lockFile(home: string): string {
  return `${storeFile(home)}.lock`
}

function seedStore(home: string, entries: Record<string, string>): void {
  mkdirSync(join(home, ".minicode"), { recursive: true })
  const payload: Record<string, { enc: string; alg: "plain" }> = {}
  for (const [key, enc] of Object.entries(entries)) payload[key] = { enc, alg: "plain" }
  writeFileSync(storeFile(home), JSON.stringify({ version: 1, entries: payload }), "utf8")
}

function storeBytes(home: string): string {
  return readFileSync(storeFile(home), "utf8")
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitUntil(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(10)
  }
  return fn()
}

/** Kunci dengan usia dipalsukan jauh melewati ambang 30 detik yang lama. */
function ageLockFile(home: string, ms = 600_000): void {
  const old = new Date(Date.now() - ms)
  utimesSync(lockFile(home), old, old)
}

afterEach(() => {
  __resetKeystoreForTest()
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (prevHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = prevHome
  if (prevDisable === undefined) delete process.env.MINICODE_KEYSTORE_DISABLE
  else process.env.MINICODE_KEYSTORE_DISABLE = prevDisable
})

describe("keystore lock — koreksi R1..R6", () => {
  test("R1: kunci pemilik hidup tak digeser walau umurnya jauh melewati ambang lama", async () => {
    const home = useHome()
    seedStore(home, { "provider:keep": "sk-SYNTH-KEEP" })
    const before = storeBytes(home)
    // Payload SAH: host + namespace cocok, pid = proses INI (hidup).
    writeFileSync(
      lockFile(home),
      JSON.stringify(__keystoreLockPayloadForTest({ pid: process.pid })),
      "utf8",
    )
    ageLockFile(home)
    __setKeystoreLockTimingForTest({ waitMs: 300, pollMs: 10 })

    const res = await setSecret("provider:new", "sk-SYNTH-NEW")

    expect(res).toBeNull()
    // Store tak berubah — tak ada yang ditulis.
    expect(storeBytes(home)).toBe(before)
    // Kunci pemilik hidup tak dihapus/diubah.
    expect(existsSync(lockFile(home))).toBe(true)
  }, 30_000)

  test("R2/R4: payload korup, terputus, atau format lama tak pernah direbut", async () => {
    const cases: { label: string; raw: string }[] = [
      { label: "kosong", raw: "" },
      { label: "bukan json", raw: "bukan json sama sekali" },
      { label: "format lama", raw: JSON.stringify({ pid: 999_999, token: "lama", ts: 1 }) },
      {
        label: "v tak dikenal",
        raw: JSON.stringify({ v: 99, pid: 999_999, token: "x", ts: 1, host: "h", ns: "n" }),
      },
    ]
    for (const c of cases) {
      const home = useHome()
      seedStore(home, { "provider:keep": "sk-SYNTH-KEEP" })
      const before = storeBytes(home)
      writeFileSync(lockFile(home), c.raw, "utf8")
      __setKeystoreLockTimingForTest({ waitMs: 200, pollMs: 10 })

      const res = await setSecret("provider:new", "sk-SYNTH-NEW")

      expect(res).toBeNull()
      expect(storeBytes(home)).toBe(before)
      // Kunci tak disentuh (isi persis sama).
      expect(readFileSync(lockFile(home), "utf8")).toBe(c.raw)
    }
  }, 30_000)

  test("R2/ABA: kunci dari proses mati TAK direbut otomatis — path tak pernah di-rebind", async () => {
    // Kunci dari proses yang crash = pemilik mati (payload SAH: host +
    // namespace cocok, pid memang absent).
    const home = useHome()
    seedStore(home, { "provider:keep": "sk-SYNTH-KEEP" })
    const before = storeBytes(home)
    const raw = JSON.stringify(__keystoreLockPayloadForTest({ pid: 999_999 }))
    writeFileSync(lockFile(home), raw, "utf8")
    __setKeystoreLockTimingForTest({ waitMs: 200, pollMs: 10 })

    // Penulis A: gagal tertutup, kunci TIDAK dihapus dan TIDAK diganti.
    expect(await setSecret("provider:a", "sk-SYNTH-A")).toBeNull()
    expect(storeBytes(home)).toBe(before)
    expect(readFileSync(lockFile(home), "utf8")).toBe(raw)

    // Penulis B: sama — jalur reclaim tidak pernah ada, jadi path kunci tak
    // pernah di-rebind oleh selain pemiliknya. Inilah yang menutup celah ABA:
    // tanpa re-binding, validate-and-remove pada nama path tak mungkin
    // mengenai objek yang bukan milik pemeriksa.
    expect(await setSecret("provider:b", "sk-SYNTH-B")).toBeNull()
    expect(storeBytes(home)).toBe(before)
    expect(readFileSync(lockFile(home), "utf8")).toBe(raw)

    // Pemulihan bersifat manual: operator menghapus file kunci itu.
    rmSync(lockFile(home), { force: true })
    expect(await setSecret("provider:c", "sk-SYNTH-C")).toBe("plain")
    const entries = JSON.parse(storeBytes(home)).entries
    expect(Object.keys(entries).sort()).toEqual(["provider:c", "provider:keep"])
    expect(entries["provider:keep"].enc).toBe("sk-SYNTH-KEEP")
  }, 30_000)

  test("R2: host atau namespace PID berbeda — liveness tak terverifikasi, tak ada reclaim", async () => {
    const cases = [{ host: "host-lain" }, { ns: "pidns:999999999" }]
    for (const over of cases) {
      const home = useHome()
      seedStore(home, { "provider:keep": "sk-SYNTH-KEEP" })
      const before = storeBytes(home)
      const raw = JSON.stringify(__keystoreLockPayloadForTest({ pid: 999_999, ...over }))
      writeFileSync(lockFile(home), raw, "utf8")
      __setKeystoreLockTimingForTest({ waitMs: 200, pollMs: 10 })

      const res = await setSecret("provider:new", "sk-SYNTH-NEW")

      expect(res).toBeNull()
      expect(storeBytes(home)).toBe(before)
      expect(readFileSync(lockFile(home), "utf8")).toBe(raw)
    }
  }, 30_000)

  test("R1: pemilik yang dijeda (umur kunci jauh melewati ambang lama) tak digeser; saat lanjut, tak ada update yang hilang", async () => {
    const home = useHome()
    seedStore(home, { "provider:keep": "sk-SYNTH-KEEP" })
    const before = storeBytes(home)
    const gate = join(home, "gate")

    // Subprocess memegang kunci lalu MENUNGGU (simulasi proses yang macet).
    const WORKER = `
const SRC = process.argv[1]
const home = process.argv[2]
const gate = process.argv[3]
const { __setKeystoreWriterForTest, setSecret } = await import(SRC + "/lib/keystore.ts")
const { atomicWriteText } = await import(SRC + "/lib/atomic-write.ts")
const { writeFileSync, existsSync } = await import("node:fs")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
__setKeystoreWriterForTest(async (path, data) => {
  writeFileSync(gate + ".holding", "x")
  const until = Date.now() + 30000
  while (!existsSync(gate) && Date.now() < until) await sleep(10)
  await atomicWriteText(path, data)
})
const r = await setSecret("provider:child", "sk-SYNTH-CHILD")
console.log(JSON.stringify({ r }))
`
    const child = Bun.spawn([process.execPath, "-e", WORKER, SRC, home, gate], {
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MINICODE_HOME: home, MINICODE_KEYSTORE_DISABLE: "1" },
    })

    // Tunggu sampai subprocess benar-benar memegang kunci.
    expect(await waitUntil(() => existsSync(`${gate}.holding`), 20000)).toBe(true)
    // Umur kunci dipalsukan jauh melewati ambang 30 detik yang lama.
    ageLockFile(home)

    // Penulis lain: tak boleh menduduki kunci yang dipegang pemilik hidup.
    __setKeystoreLockTimingForTest({ waitMs: 300, pollMs: 10 })
    const res = await setSecret("provider:other", "sk-SYNTH-OTHER")
    expect(res).toBeNull()
    // Tak ada yang ditulis selama pemilik hidup memegang kunci.
    expect(storeBytes(home)).toBe(before)

    // Pemilik lalu lanjut → tulisannya masuk, credential lama tetap utuh.
    writeFileSync(gate, "go", "utf8")
    const out = await new Response(child.stdout).text()
    await child.exited
    expect(out).toContain('"r":"plain"')
    const entries = JSON.parse(storeBytes(home)).entries
    expect(Object.keys(entries).sort()).toEqual(["provider:child", "provider:keep"])
    expect(entries["provider:keep"].enc).toBe("sk-SYNTH-KEEP")
    expect(entries["provider:child"].enc).toBe("sk-SYNTH-CHILD")
  }, 60_000)

  test("R5: release dengan token berbeda tak menyentuh kunci milik orang lain", async () => {
    const home = useHome()
    const foreign = JSON.stringify(__keystoreLockPayloadForTest({ token: "token-orang-lain" }))
    // Seam: saat menulis (di dalam bagian kritis), isi file kunci diganti
    // payload milik orang lain → saat release, token tak cocok → kunci
    // milik orang lain tak boleh dihapus.
    __setKeystoreWriterForTest(async (path, data) => {
      writeFileSync(lockFile(home), foreign, "utf8")
      const { atomicWriteText } = await import("../src/lib/atomic-write.ts")
      await atomicWriteText(path, data)
    })

    const res = await setSecret("provider:a", "sk-SYNTH-A")

    expect(res).toBe("plain")
    expect(existsSync(lockFile(home))).toBe(true)
    expect(readFileSync(lockFile(home), "utf8")).toBe(foreign)
  }, 30_000)

  test("R6: sisa reclaim dibersihkan, path kunci aktif tak pernah disentuh", async () => {
    const home = useHome()
    seedStore(home, { "provider:keep": "sk-SYNTH-KEEP" })
    const dir = join(home, ".minicode")
    // Sisa reclaim dari crash sebelumnya + berkas lain yang tak boleh dihapus.
    writeFileSync(`${storeFile(home)}.lock.stale.abc123`, "sisa", "utf8")
    writeFileSync(join(dir, "lain.txt"), "jangan dihapus", "utf8")

    const res = await setSecret("provider:new", "sk-SYNTH-NEW")

    expect(res).toBe("plain")
    expect(existsSync(`${storeFile(home)}.lock.stale.abc123`)).toBe(false)
    expect(existsSync(join(dir, "lain.txt"))).toBe(true)
    expect(existsSync(storeFile(home))).toBe(true)
  }, 30_000)
})
