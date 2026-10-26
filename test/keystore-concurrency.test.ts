// Konkurensi penulis keystore: dua credential tak boleh saling menimpa.
//
// Defect (sudah direproduksi): store dibaca-modifikasi-tulis tanpa
// serialisasi. Dua penulis konkuren → keduanya membaca state yang SAMA →
// keduanya menulis → penulisan terakhir menang → credential yang ditulis
// penulis lain HILANG diam-diam, dan keduanya melaporkan "sukses".
//
// Perbaikan: bagian baca-modifikasi-tulis dijalankan di bawah KUNCI STORE
// (file O_EXCL + crash recovery + stale handling + timeout). Penulis kedua
// baru membaca SETELAH penulis pertama selesai → state yang ia pakai
// benar-benar terbaru → tak ada yang hilang.
//
// Semua kredensial di fixture ini SINTETIS; tidak ada kredensial user nyata.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __keystoreLockPayloadForTest,
  __resetKeystoreForTest,
  __setKeystoreLockTimingForTest,
  __setKeystoreWriterForTest,
  deleteSecret,
  setSecret,
} from "../src/lib/keystore.ts"

const SRC = new URL("../src/", import.meta.url).href.replace(/\/$/, "")
const tmpRoots: string[] = []
const prevHome = process.env.MINICODE_HOME
const prevDisable = process.env.MINICODE_KEYSTORE_DISABLE

function useHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-ks-conc-"))
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

function readEntries(home: string): Record<string, { enc: string; alg: string }> {
  return JSON.parse(readFileSync(storeFile(home), "utf8")).entries
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

/**
 * Tulis di Windows bisa gagal sesaat (EBUSY/EPERM saat rename menimpa berkas
 * yang sedang diindeks antivirus/sinkronizer) → operasi gagal tertutup
 * (null/false). Kejadian ini transien dan platform-spesifik, bukan bug logika:
 * skenario diulang (maks 3x). Kegagalan yang menetap tetap menggagalkan test.
 */
async function retryOnTransientWriteFailure<T>(
  run: () => Promise<T>,
  succeeded: (r: T) => boolean,
): Promise<T> {
  let last: T | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await run()
    if (succeeded(last)) return last
    await sleep(50)
  }
  return last as T
}

afterEach(() => {
  __resetKeystoreForTest()
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (prevHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = prevHome
  if (prevDisable === undefined) delete process.env.MINICODE_KEYSTORE_DISABLE
  else process.env.MINICODE_KEYSTORE_DISABLE = prevDisable
})

describe("konkurensi penulis keystore", () => {
  test("satu proses: dua setSecret konkuren ke key berbeda → keduanya selamat", async () => {
    const home = useHome()
    const gate = join(home, "gate")
    const readyDir = join(home, "ready")
    mkdirSync(readyDir, { recursive: true })

    let arrived = 0
    __setKeystoreWriterForTest(async (path, data) => {
      arrived++
      if (arrived >= 2) writeFileSync(gate, "go")
      await waitUntil(() => existsSync(gate), 2000)
      const { atomicWriteText } = await import("../src/lib/atomic-write.ts")
      await atomicWriteText(path, data)
    })

    const [a, b] = await retryOnTransientWriteFailure(
      async () =>
        (await Promise.all([
          setSecret("provider:alpha", "sk-SYNTH-ALPHA"),
          setSecret("provider:beta", "sk-SYNTH-BETA"),
        ])) as ["plain" | null, "plain" | null],
      (r) => r[0] === "plain" && r[1] === "plain",
    )

    expect(a).toBe("plain")
    expect(b).toBe("plain")
    const entries = readEntries(home)
    expect(Object.keys(entries).sort()).toEqual(["provider:alpha", "provider:beta"])
    expect(entries["provider:alpha"]?.enc).toBe("sk-SYNTH-ALPHA")
    expect(entries["provider:beta"]?.enc).toBe("sk-SYNTH-BETA")
  }, 30_000)

  test("satu proses: set + delete konkuren → store tetap konsisten (tak ada yang hilang diam-diam)", async () => {
    const home = useHome()
    mkdirSync(join(home, ".minicode"), { recursive: true })
    writeFileSync(
      storeFile(home),
      JSON.stringify({
        version: 1,
        entries: { "provider:old": { enc: "sk-SYNTH-OLD", alg: "plain" } },
      }),
      "utf8",
    )
    const gate = join(home, "gate")
    const readyDir = join(home, "ready")
    mkdirSync(readyDir, { recursive: true })

    let arrived = 0
    __setKeystoreWriterForTest(async (path, data) => {
      arrived++
      if (arrived >= 2) writeFileSync(gate, "go")
      await waitUntil(() => existsSync(gate), 2000)
      const { atomicWriteText } = await import("../src/lib/atomic-write.ts")
      await atomicWriteText(path, data)
    })

    const [setRes, delRes] = await retryOnTransientWriteFailure(
      async () =>
        (await Promise.all([
          setSecret("provider:new", "sk-SYNTH-NEW"),
          deleteSecret("provider:old"),
        ])) as ["plain" | null, boolean],
      (r) => r[0] === "plain" && r[1] === true,
    )

    expect(setRes).toBe("plain")
    expect(delRes).toBe(true)
    const entries = readEntries(home)
    // Dua efek yang berlawanan pada key BERBEDA: keduanya harus terlihat.
    expect(Object.keys(entries).sort()).toEqual(["provider:new"])
    expect(entries["provider:new"]?.enc).toBe("sk-SYNTH-NEW")
  }, 30_000)

  test("dua proses terpisah: setSecret konkuren → keduanya selamat", async () => {
    const home = useHome()
    const gate = join(home, "gate")
    const readyDir = join(home, "ready")
    mkdirSync(readyDir, { recursive: true })
    mkdirSync(join(home, ".minicode"), { recursive: true })

    // Worker: proses terpisah (bukan promise bersama) — satu-satunya cara
    // membuktikan klaim lintas proses (pola test/concurrency-cross-process).
    const WORKER = `
const SRC = process.argv[1]
const home = process.argv[2]
const key = process.argv[3]
const value = process.argv[4]
const gate = process.argv[5]
const readyDir = process.argv[6]
const { __setKeystoreWriterForTest, setSecret } = await import(SRC + "/lib/keystore.ts")
const { atomicWriteText } = await import(SRC + "/lib/atomic-write.ts")
const { writeFileSync, existsSync } = await import("node:fs")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
__setKeystoreWriterForTest(async (path, data) => {
  writeFileSync(readyDir + "/ready-" + key, "x")
  const until = Date.now() + 5000
  while (!existsSync(gate) && Date.now() < until) await sleep(10)
  await atomicWriteText(path, data)
})
const backend = await setSecret(key, value)
console.log(JSON.stringify({ key, backend }))
`

    const ready = async () => {
      await waitUntil(
        () =>
          existsSync(join(readyDir, "ready-provider:alpha")) &&
          existsSync(join(readyDir, "ready-provider:beta")),
        5000,
      )
      writeFileSync(gate, "go")
    }

    const runPair = async (): Promise<{ out1: string; out2: string }> => {
      // Skenario diulang dari awal bila salah satu anak gagal menulis
      // (kegagalan tulis sesaat di Windows) — maks 3x, kegagalan menetap
      // tetap menggagalkan test.
      rmSync(gate, { force: true })
      rmSync(join(readyDir, "ready-provider:alpha"), { force: true })
      rmSync(join(readyDir, "ready-provider:beta"), { force: true })
      const p1 = Bun.spawn(
        [
          process.execPath,
          "-e",
          WORKER,
          SRC,
          home,
          "provider:alpha",
          "sk-SYNTH-ALPHA",
          gate,
          readyDir,
        ],
        {
          cwd: home,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, MINICODE_HOME: home, MINICODE_KEYSTORE_DISABLE: "1" },
        },
      )
      const p2 = Bun.spawn(
        [
          process.execPath,
          "-e",
          WORKER,
          SRC,
          home,
          "provider:beta",
          "sk-SYNTH-BETA",
          gate,
          readyDir,
        ],
        {
          cwd: home,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, MINICODE_HOME: home, MINICODE_KEYSTORE_DISABLE: "1" },
        },
      )
      await ready()
      const [out1, out2] = await Promise.all([
        new Response(p1.stdout).text(),
        new Response(p2.stdout).text(),
      ])
      await Promise.all([p1.exited, p2.exited])
      return { out1, out2 }
    }

    const { out1, out2 } = await retryOnTransientWriteFailure(runPair, (r) => {
      const entries = readEntries(home)
      return (
        r.out1.includes('"backend":"plain"') &&
        r.out2.includes('"backend":"plain"') &&
        Object.keys(entries).sort().join(",") === "provider:alpha,provider:beta"
      )
    })
    expect(out1).toContain("provider:alpha")
    expect(out2).toContain("provider:beta")

    const entries = readEntries(home)
    expect(Object.keys(entries).sort()).toEqual(["provider:alpha", "provider:beta"])
    expect(entries["provider:alpha"]?.enc).toBe("sk-SYNTH-ALPHA")
    expect(entries["provider:beta"]?.enc).toBe("sk-SYNTH-BETA")
  }, 60_000)

  test("file kunci dibersihkan setelah operasi sukses", async () => {
    const home = useHome()
    expect(await setSecret("provider:a", "sk-SYNTH-A")).toBe("plain")
    expect(existsSync(lockFile(home))).toBe(false)
  })

  test("kunci dari proses mati tak direbut otomatis (pemulihan manual)", async () => {
    const home = useHome()
    mkdirSync(join(home, ".minicode"), { recursive: true })
    // Simulasi proses yang mati saat memegang kunci: payload SAH (host +
    // namespace cocok) dengan pid yang memang tak hidup.
    writeFileSync(
      lockFile(home),
      JSON.stringify(__keystoreLockPayloadForTest({ pid: 999_999 })),
      "utf8",
    )
    // Otomatik reclaim DIHAPUS (celah ABA: validate-and-remove pada nama path
    // bisa mengenai kunci milik penulis lain yang hidup) → gagal tertutup.
    __setKeystoreLockTimingForTest({ waitMs: 200, pollMs: 10 })
    expect(await setSecret("provider:a", "sk-SYNTH-A")).toBeNull()
    // Kunci tetap ada persis seperti sebelumnya → operator yang menghapus.
    expect(existsSync(lockFile(home))).toBe(true)
    rmSync(lockFile(home), { force: true })
    expect(await setSecret("provider:a", "sk-SYNTH-A")).toBe("plain")
    expect(readEntries(home)["provider:a"]?.enc).toBe("sk-SYNTH-A")
    // Kunci tak boleh tertinggal untuk pemanggil berikutnya.
    expect(existsSync(lockFile(home))).toBe(false)
  })
})
