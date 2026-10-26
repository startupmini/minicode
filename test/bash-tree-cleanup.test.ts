// Pembersihan proses background: bunuh TREE, bukan cuma wrapper shell.
//
// Defect (sudah direproduksi): `killAllBackgroundJobs()` (dipanggil saat CLI
// keluar) dan `bash_kill` sama-sama memakai `proc.kill()`. Di Windows itu
// hanya menebas cmd.exe — cucu (dev server, watcher, `node -e`) tetap hidup,
// menahan pipe stdio sehingga event `close` tak pernah datang (job
// menggantung selamanya) dan prosesnya jadi yatim. Modul ini sudah punya
// killTree() (taskkill /T /F di Windows, kill(-pgid) di POSIX) — kedua jalur
// ini tak memakainya.
//
// Pohon proses yang diuji:
//
//   proses test  →  shell wrapper (cmd.exe / sh)  →  anak (bun -e)
//
// "Cucu" di sini = anak dari shell wrapper, relatif terhadap proses CLI.
// Penanda ditulis ke tmp dir; tidak ada kredensial nyata.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bashKillTool,
  bashTool,
  killAllBackgroundJobs,
  listBackgroundJobs,
} from "../src/tools/bash.ts"

const ctx = { signal: new AbortController().signal } as never
// Interpreter = runtime sendiri (bun) agar hermetic: `node` tak ada di image
// minimal (pola yang sama dipakai test/bash-cap.test.ts).
const rt = JSON.stringify(process.execPath)

const tmpRoots: string[] = []

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitUntil(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(50)
  }
  return fn()
}

/**
 * Job background yang anak shell-wrapper-nya menandai "started" lalu
 * "alive" (1 detik kemudian). Kalau hanya wrapper yang dibunuh, anak tetap
 * hidup dan menulis "alive" → bukti proses yatim.
 */
async function startMarkerJob(): Promise<{ id: string; alive: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mc-tree-"))
  tmpRoots.push(dir)
  const started = join(dir, "started")
  const alive = join(dir, "alive")
  const script =
    `require('fs').writeFileSync(${JSON.stringify(started)}, 'x'); ` +
    `setTimeout(function(){ require('fs').writeFileSync(${JSON.stringify(alive)}, 'x') }, 1000)`
  const res = (await bashTool.execute(
    { cmd: `${rt} -e ${JSON.stringify(script)}`, background: true },
    ctx,
  )) as string
  const id = /(bg_[0-9a-f]+)/.exec(res)?.[1]
  if (!id) throw new Error(`job id tak ada di output: ${res}`)
  // Tunggu sampai anak benar-benar hidup — kalau tidak, "tak ada penanda
  // 'alive'" bisa berarti "tak pernah jalan", bukan "berhasil dibunuh".
  expect(await waitUntil(() => existsSync(started), 15_000)).toBe(true)
  return { id, alive }
}

afterEach(() => {
  killAllBackgroundJobs()
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("cleanup tree proses background", () => {
  test("CLI shutdown: killAllBackgroundJobs menutup SELURUH tree (tak ada cucu yatim)", async () => {
    const { alive } = await startMarkerJob()

    killAllBackgroundJobs()

    await sleep(2500)
    expect(existsSync(alive)).toBe(false)
  }, 40_000)

  test("bash_kill: menutup SELURUH tree (tak ada cucu yatim)", async () => {
    const { id, alive } = await startMarkerJob()

    const out = await bashKillTool.execute({ id }, ctx)
    expect(String(out)).toContain("stopped")

    await sleep(2500)
    expect(existsSync(alive)).toBe(false)
  }, 40_000)

  test("bash_kill: job jadi selesai (tak menggantung) — pipe tak dipegang cucu", async () => {
    const { id } = await startMarkerJob()

    await bashKillTool.execute({ id }, ctx)

    const done = await waitUntil(
      () => listBackgroundJobs().find((j) => j.id === id)?.done === true,
      10_000,
    )
    expect(done).toBe(true)
  }, 40_000)

  test("killAllBackgroundJobs tetap mengosongkan registry", async () => {
    await startMarkerJob()
    expect(listBackgroundJobs().length).toBeGreaterThan(0)

    killAllBackgroundJobs()

    expect(listBackgroundJobs().length).toBe(0)
  }, 40_000)
})
