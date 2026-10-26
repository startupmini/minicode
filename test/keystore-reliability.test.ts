// Keystore fail-closed: credential yang SUDAH ADA tidak boleh hilang.
//
// Defect yang direproduksi (sebelum fix): `loadStore()` menelan SEMUA
// kegagalan baca (ENOENT, EACCES, EISDIR, SyntaxError) dan melanjutkan
// sebagai "store kosong". Akibatnya `setSecret()` pada store yang JSON-nya
// rusak menimpa berkas itu dengan satu key baru → seluruh credential lama
// hilang permanen, dan `setSecret()` tetap melaporkan "plain" (sukses).
// `deleteSecret()` menghapus cache lebih dulu sehingga sesi mengira key
// terhapus padahal berkasnya masih memegangnya.
//
// Kontrak store yang dipertahankan: `{version:1, entries:{key:{enc,alg}}}`,
// path `MINICODE_HOME/.minicode/secrets.json`, tulis atomik, tanpa nilai
// rahasia di pesan error.
//
// Semua kredensial di fixture ini SINTETIS; tidak ada kredensial user nyata.
import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetKeystoreForTest,
  __setKeystoreWriterForTest,
  deleteSecret,
  getSecret,
  setSecret,
} from "../src/lib/keystore.ts"

const tmpRoots: string[] = []
const prevHome = process.env.MINICODE_HOME
const prevDisable = process.env.MINICODE_KEYSTORE_DISABLE

/** MINICODE_HOME terisolasi + backend plain (deterministik lintas-OS). */
function useHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "minicode-ks-rel-"))
  tmpRoots.push(dir)
  process.env.MINICODE_HOME = dir
  process.env.MINICODE_KEYSTORE_DISABLE = "1"
  return dir
}

function storeFile(home: string): string {
  return join(home, ".minicode", "secrets.json")
}

function seedStore(home: string, entries: Record<string, string>): void {
  mkdirSync(join(home, ".minicode"), { recursive: true })
  const payload: Record<string, { enc: string; alg: "plain" }> = {}
  for (const [key, enc] of Object.entries(entries)) payload[key] = { enc, alg: "plain" }
  writeFileSync(storeFile(home), JSON.stringify({ version: 1, entries: payload }), "utf8")
}

function readStore(home: string): string {
  return readFileSync(storeFile(home), "utf8")
}

function readEntries(home: string): Record<string, { enc: string; alg: string }> {
  return JSON.parse(readStore(home)).entries
}

/** Tangkap stderr selama operasi (untuk memeriksa pesan diagnostik). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr)
  let captured = ""
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stderr.write
  try {
    const result = await fn()
    return { result, stderr: captured }
  } finally {
    process.stderr.write = original
  }
}

function writeFailure(): void {
  __setKeystoreWriterForTest(async () => {
    throw Object.assign(new Error("simulated write failure"), { code: "EACCES" })
  })
}

afterEach(() => {
  __resetKeystoreForTest()
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (prevHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = prevHome
  if (prevDisable === undefined) delete process.env.MINICODE_KEYSTORE_DISABLE
  else process.env.MINICODE_KEYSTORE_DISABLE = prevDisable
})

describe("keystore fail-closed", () => {
  test("store yang benar-benar belum ada → first-use tetap boleh membuat store", async () => {
    const home = useHome()
    expect(existsSync(storeFile(home))).toBe(false)

    const backend = await setSecret("provider:a", "sk-SYNTH-A")

    expect(backend).toBe("plain")
    const entries = readEntries(home)
    expect(Object.keys(entries)).toEqual(["provider:a"])
    expect(entries["provider:a"]?.enc).toBe("sk-SYNTH-A")
    // Format store tak berubah
    expect(JSON.parse(readStore(home)).version).toBe(1)
  })

  test("store valid: set key baru mempertahankan seluruh credential lain", async () => {
    const home = useHome()
    seedStore(home, {
      "provider:p0": "sk-SYNTH-0",
      "provider:p1": "sk-SYNTH-1",
      "provider:p2": "sk-SYNTH-2",
    })

    const backend = await setSecret("provider:new", "sk-SYNTH-NEW")

    expect(backend).toBe("plain")
    const entries = readEntries(home)
    expect(Object.keys(entries).sort()).toEqual([
      "provider:new",
      "provider:p0",
      "provider:p1",
      "provider:p2",
    ])
    expect(entries["provider:p0"]?.enc).toBe("sk-SYNTH-0")
    expect(entries["provider:p1"]?.enc).toBe("sk-SYNTH-1")
    expect(entries["provider:p2"]?.enc).toBe("sk-SYNTH-2")
    expect(entries["provider:new"]?.enc).toBe("sk-SYNTH-NEW")
  })

  test("store valid: delete satu key mempertahankan key lain", async () => {
    const home = useHome()
    seedStore(home, {
      "provider:p0": "sk-SYNTH-0",
      "provider:p1": "sk-SYNTH-1",
      "provider:p2": "sk-SYNTH-2",
    })

    const removed = await deleteSecret("provider:p1")

    expect(removed).toBe(true)
    const entries = readEntries(home)
    expect(Object.keys(entries).sort()).toEqual(["provider:p0", "provider:p2"])
    expect(entries["provider:p0"]?.enc).toBe("sk-SYNTH-0")
    expect(entries["provider:p2"]?.enc).toBe("sk-SYNTH-2")
    // key yang dihapus tak bisa dibaca lagi
    expect(await getSecret("provider:p1")).toBeNull()
  })

  test("store korup: setSecret menolak menulis dan byte asli tetap identik", async () => {
    const home = useHome()
    seedStore(home, { "provider:p0": "sk-SYNTH-0", "provider:p1": "sk-SYNTH-1" })
    const corrupt = '{"version":1,"entries":{"provider:p0":{"enc":"sk-SYNTH-TRUNCA'
    writeFileSync(storeFile(home), corrupt, "utf8")

    const { result, stderr } = await captureStderr(() => setSecret("provider:new", "sk-SYNTH-NEW"))

    expect(result).toBeNull()
    // berkas korup TAK ditimpa — byte-identik
    expect(readStore(home)).toBe(corrupt)
    expect(stderr).toContain("corrupt")
    // nilai rahasia tak boleh bocor ke pesan
    expect(stderr).not.toContain("sk-SYNTH")
  })

  test("store korup: deleteSecret menolak dan byte asli tetap identik", async () => {
    const home = useHome()
    seedStore(home, { "provider:p0": "sk-SYNTH-0", "provider:p1": "sk-SYNTH-1" })
    const corrupt = "TOTALLY-NOT-JSON"
    writeFileSync(storeFile(home), corrupt, "utf8")

    const { result, stderr } = await captureStderr(() => deleteSecret("provider:p0"))

    expect(result).toBe(false)
    expect(readStore(home)).toBe(corrupt)
    expect(stderr).toContain("corrupt")
    expect(stderr).not.toContain("sk-SYNTH")
  })

  test("store korup: deleteSecret tak boleh mengklaim key terhapus (cache utuh)", async () => {
    const home = useHome()
    seedStore(home, { "provider:p0": "sk-SYNTH-0" })
    // isi cache dulu supaya state "key ada di cache" teruji
    expect(await getSecret("provider:p0")).toBe("sk-SYNTH-0")
    const corrupt = "CORRUPT-AFTER-CACHE"
    writeFileSync(storeFile(home), corrupt, "utf8")

    const { result } = await captureStderr(() => deleteSecret("provider:p0"))

    expect(result).toBe(false)
    expect(readStore(home)).toBe(corrupt)
    // cache tak dikosongkan: sesi tetap tahu key itu masih ada
    expect(await getSecret("provider:p0")).toBe("sk-SYNTH-0")
  })

  test("store tak terbaca (path = direktori): tak boleh dianggap store kosong", async () => {
    const home = useHome()
    mkdirSync(join(home, ".minicode", "secrets.json"), { recursive: true })

    const { result, stderr } = await captureStderr(() => setSecret("provider:new", "sk-SYNTH-NEW"))

    expect(result).toBeNull()
    expect(stderr).toContain("cannot read store")
    expect(stderr).not.toContain("sk-SYNTH")
    // tak ada berkas yang dibuat di atas path direktori
    expect(statSync(storeFile(home)).isDirectory()).toBe(true)
    // nilai tak boleh tersimpan di cache padahal tak ada yang ditulis
    expect(await getSecret("provider:new")).toBeNull()
  })

  test("store dengan entries berupa array: ditolak, bukan dianggap store kosong", async () => {
    const home = useHome()
    mkdirSync(join(home, ".minicode"), { recursive: true })
    const raw = JSON.stringify({ version: 1, entries: [] })
    writeFileSync(storeFile(home), raw, "utf8")

    const { result } = await captureStderr(() => setSecret("provider:new", "sk-SYNTH-NEW"))

    expect(result).toBeNull()
    expect(readStore(home)).toBe(raw)
    // secret baru tak hilang diam-diam: tak ada di cache pun
    expect(await getSecret("provider:new")).toBeNull()
  })

  test("gagal tulis: setSecret melaporkan gagal, tak men-cache nilai palsu", async () => {
    const home = useHome()
    seedStore(home, { "provider:p0": "sk-SYNTH-0" })
    const before = readStore(home)
    writeFailure()

    const { result, stderr } = await captureStderr(() => setSecret("provider:new", "sk-SYNTH-NEW"))

    expect(result).toBeNull()
    expect(stderr).toContain("cannot write store")
    expect(stderr).not.toContain("sk-SYNTH")
    // tak ada yang berubah di disk
    expect(readStore(home)).toBe(before)
    // nilai tak boleh dianggap tersimpan
    expect(await getSecret("provider:new")).toBeNull()
  })

  test("gagal tulis: deleteSecret melaporkan gagal dan key tetap ada", async () => {
    const home = useHome()
    seedStore(home, { "provider:p0": "sk-SYNTH-0" })
    const before = readStore(home)
    writeFailure()

    const { result } = await captureStderr(() => deleteSecret("provider:p0"))

    expect(result).toBe(false)
    expect(readStore(home)).toBe(before)
    expect(await getSecret("provider:p0")).toBe("sk-SYNTH-0")
  })

  test("credential tak bocor ke stderr saat operasi gagal", async () => {
    const home = useHome()
    seedStore(home, { "provider:p0": "sk-SYNTH-SECRET-VALUE" })
    const corrupt = "NOT-JSON"
    writeFileSync(storeFile(home), corrupt, "utf8")

    const { stderr } = await captureStderr(() => setSecret("provider:x", "sk-SYNTH-SECRET-VALUE"))

    expect(stderr).not.toContain("sk-SYNTH-SECRET-VALUE")
    expect(stderr).not.toContain("NOT-JSON")
  })
})
