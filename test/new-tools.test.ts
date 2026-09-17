import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionHandler } from "../src/policy/permission.ts"
import { codeRunTool } from "../src/tools/code_run.ts"
import { deleteFileTool } from "../src/tools/delete_file.ts"
import { moveFileTool } from "../src/tools/move_file.ts"
import { readImageTool } from "../src/tools/read_image.ts"

// Regression test 4 tool P13 P0: move_file, delete_file, read_image, code_run.
// Hermetic: tiap test memakai tmp dir sendiri; tanpa jaringan; tanpa TTY.

let dir = ""
const ctx = () => ({ cwd: dir, signal: new AbortController().signal }) as never

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minicode-newtools-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
})

afterEach(() => {
  delete process.env.MINICODE_SANDBOX
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

test("move_file: pindah + auto-mkdir parent", async () => {
  writeFileSync(join(dir, "a.txt"), "hello")
  const r = (await moveFileTool.execute({ from: "a.txt", to: "sub/b.txt" }, ctx())) as string
  expect(r).toContain("moved")
  expect(existsSync(join(dir, "sub/b.txt"))).toBe(true)
  expect(existsSync(join(dir, "a.txt"))).toBe(false)
  expect(readFileSync(join(dir, "sub/b.txt"), "utf8")).toBe("hello")
})

test("move_file: menolak keluar workspace & sensitif & tak ada", async () => {
  writeFileSync(join(dir, "a.txt"), "x")
  await expect(moveFileTool.execute({ from: "../o.txt", to: "b.txt" }, ctx())).rejects.toThrow(
    /outside/,
  )
  await expect(moveFileTool.execute({ from: "a.txt", to: ".env" }, ctx())).rejects.toThrow()
  await expect(moveFileTool.execute({ from: "nope.txt", to: "b.txt" }, ctx())).rejects.toThrow(
    /not found/,
  )
})

test("delete_file: soft-delete ke .minicode/.trash + restore via move", async () => {
  writeFileSync(join(dir, "todel.txt"), "bye")
  const r = (await deleteFileTool.execute({ path: "todel.txt" }, ctx())) as string
  expect(r).toContain("deleted")
  expect(existsSync(join(dir, "todel.txt"))).toBe(false)
  expect(existsSync(join(dir, ".minicode", ".trash"))).toBe(true)
  const m = /\.trash[\\/]([^\s)]+)/.exec(r)
  expect(m).not.toBeNull()
  await moveFileTool.execute(
    { from: join(".minicode", ".trash", m![1]!), to: "restored.txt" },
    ctx(),
  )
  expect(readFileSync(join(dir, "restored.txt"), "utf8")).toBe("bye")
})

test("move_file: dest yang ada dibackup ke trash, bukan ditimpa diam-diam", async () => {
  writeFileSync(join(dir, "a.txt"), "new")
  writeFileSync(join(dir, "b.txt"), "old")
  const r = (await moveFileTool.execute({ from: "a.txt", to: "b.txt" }, ctx())) as string
  expect(r).toContain("backed up")
  expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("new")
})

test("delete_file: menolak direktori, luar workspace, tak ada", async () => {
  mkdirSync(join(dir, "adir"))
  await expect(deleteFileTool.execute({ path: "adir" }, ctx())).rejects.toThrow(/directory/)
  await expect(deleteFileTool.execute({ path: "../o.txt" }, ctx())).rejects.toThrow(/outside/)
  await expect(deleteFileTool.execute({ path: "nope.txt" }, ctx())).rejects.toThrow(/not found/)
})

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
)

test("read_image: base64 + mime + estimasi token", async () => {
  writeFileSync(join(dir, "img.png"), PNG_1X1)
  const r = (await readImageTool.execute({ path: "img.png" }, ctx())) as string
  expect(r).toContain("data:image/png;base64,")
  expect(r).toContain("tokens")
  writeFileSync(join(dir, "img.jpg"), PNG_1X1)
  const r2 = (await readImageTool.execute({ path: "img.jpg" }, ctx())) as string
  expect(r2).toContain("image/jpeg")
})

test("read_image: menolak luar workspace & tak ada & raksasa", async () => {
  await expect(readImageTool.execute({ path: "../o.png" }, ctx())).rejects.toThrow(/outside/)
  await expect(readImageTool.execute({ path: "nope.png" }, ctx())).rejects.toThrow(/not found/)
  writeFileSync(join(dir, "big.png"), Buffer.alloc(6 * 1024 * 1024, 0))
  await expect(readImageTool.execute({ path: "big.png" }, ctx())).rejects.toThrow(/too large/)
})

test("read_image: gambar yang lolos 2MB TAPI melewati batas b64 kernel ditolak (E-1)", async () => {
  // Investigasi Phase 5: guard lama (BASH_OUTPUT×5=100k) meloloskan b64 hingga
  // 100k chars, padahal kernel truncate di 16.384 → base64 korup terkirim.
  // 32KB file → b64 ≈ 43.721 chars: lolos guard lama, kini ditolak dengan
  // alasan eksplisit (compress first), bukan gambar korup diam-diam.
  writeFileSync(join(dir, "over-b64.png"), Buffer.alloc(32 * 1024, 0))
  await expect(readImageTool.execute({ path: "over-b64.png" }, ctx())).rejects.toThrow(
    /exceeds the .*-char context limit/,
  )
  // 1×1 PNG tetap lolos (jauh di bawah batas).
  writeFileSync(join(dir, "small.png"), PNG_1X1)
  const r = (await readImageTool.execute({ path: "small.png" }, ctx())) as string
  expect(r).toContain("data:image/png;base64,")
})

test("code_run: menolak tanpa sandbox", async () => {
  delete process.env.MINICODE_SANDBOX
  await expect(
    codeRunTool.execute({ lang: "node", code: "console.log(1)" }, ctx()),
  ).rejects.toThrow(/requires MINICODE_SANDBOX/)
})

test("code_run: node echo via sandbox", async () => {
  // Eksekusi nyata butuh backend sandbox (bwrap/seatbelt/docker) — tanpa itu
  // code_run fail-closed (lihat test fail-closed di bawah + hardening-boundary).
  const { osSandboxAvailable } = await import("../src/sandbox/os.ts")
  if (!osSandboxAvailable()) return
  process.env.MINICODE_SANDBOX = "os"
  const r = (await codeRunTool.execute({ lang: "node", code: "console.log(2+3)" }, ctx())) as string
  expect(r).toContain("5")
})

test("code_run: timeout membunuh loop tak berujung (tanpa hang)", async () => {
  const { osSandboxAvailable } = await import("../src/sandbox/os.ts")
  if (!osSandboxAvailable()) return
  process.env.MINICODE_SANDBOX = "os"
  const t0 = Date.now()
  const r = (await codeRunTool.execute(
    { lang: "node", code: "while(true){}", timeout: 500 },
    ctx(),
  )) as string
  // harus kembali (bukan hang): timeout 500ms + tree-kill, toleransi CI lambat
  expect(Date.now() - t0).toBeLessThan(15000)
  expect(typeof r).toBe("string")
})

test("code_run: substitusi shell $(...) tidak dieksekusi (tanpa shell)", async () => {
  // Regresi S2: versi lama merangkai `node -e "<code>"` lewat shell:true,
  // sehingga $(...)/backtick di kode dieksekusi shell SEBELUM node.
  // Kini kode jadi satu argumen single-quoted untuk `sh -c` runner.
  const { osSandboxAvailable } = await import("../src/sandbox/os.ts")
  if (!osSandboxAvailable()) return
  process.env.MINICODE_SANDBOX = "os"
  const r = (await codeRunTool.execute(
    { lang: "node", code: 'console.log("$(echo PWNED)")' },
    ctx(),
  )) as string
  expect(r).toContain("$(")
  expect(r).not.toMatch(/^PWNED$/m)
})

test("permission: move/delete butuh tulis, read_image read-only", async () => {
  const ro = createPermissionHandler({ mode: "readonly", root: dir })
  const plan = createPermissionHandler({ mode: "plan", root: dir })
  const all = createPermissionHandler({ mode: "allow-all", root: dir })
  const deps = { signal: new AbortController().signal } as never
  const call = (name: string, args: unknown) => [{ name, args }, deps] as unknown as [never, never]
  expect(await ro.check(...call("move_file", { from: "a", to: "b" }))).toBe("deny")
  expect(await ro.check(...call("delete_file", { path: "a" }))).toBe("deny")
  expect(await ro.check(...call("read_image", { path: "a.png" }))).toBe("allow")
  expect(await plan.check(...call("move_file", { from: "a", to: "b" }))).toBe("deny")
  expect(await all.check(...call("move_file", { from: "a", to: "b" }))).toBe("allow")
  expect(await all.check(...call("delete_file", { path: "a" }))).toBe("allow")
})
