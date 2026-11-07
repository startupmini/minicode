// Fase 3.1 — checkpoint berbasis shadow-git.
//
// Yang diuji bukan hanya "undo bekerja", tapi juga jaminan yang membuat
// pendekatan ini aman dipakai di repo orang: index/HEAD user tak tersentuh,
// ref tidak muncul di git log, file di luar snapshot tidak dirusak.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Setiap test di sini men-spawn git beberapa kali (init+config+add+commit di
// beforeEach, lalu snapshot/restore). Terukur di Windows: satu `git init` ~1,5 s
// dan `snapshotTree` ~3 s karena setiap invokasi adalah proses baru — jadi satu
// test bisa melewati 5 s default Bun dan gagal sebagai *timeout*, bukan karena
// logikanya salah. Batas dinaikkan agar kegagalan yang muncul selalu berarti.
setDefaultTimeout(60_000)

import {
  beginTurnSnapshot,
  loadCheckpointManifest,
  recordCheckpointFromTrees,
  redoLastCheckpoint,
  undoLastCheckpoint,
} from "../src/session/checkpoint.ts"
import {
  diffTrees,
  isGitRepo,
  listShadowRefs,
  pruneSessionRefs,
  restoreTree,
  snapshotTree,
} from "../src/session/shadow-git.ts"

const root = join(tmpdir(), `minicode-sg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)

const git = (args: string[], cwd = root) =>
  spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20_000 })

const gitAvailable = (() => {
  const r = spawnSync("git", ["--version"], { stdio: "ignore", timeout: 5000 })
  return r.status === 0
})()

const w = (rel: string, content: string) => writeFile(join(root, rel), content, "utf8")
const read = (rel: string) => readFile(join(root, rel), "utf8")

beforeEach(async () => {
  await mkdir(root, { recursive: true })
  git(["init", "-q"])
  git(["config", "user.email", "t@example.com"])
  git(["config", "user.name", "t"])
  git(["config", "commit.gpgsign", "false"])
  await w(".gitignore", "ignored/\n*.log\n")
  await mkdir(join(root, "ignored"), { recursive: true })
  await w("ignored/secret.txt", "jangan-tersentuh")
  await w("a.txt", "v1")
  await mkdir(join(root, "src"), { recursive: true })
  await w("src/b.ts", "export const b = 1\n")
  git(["add", "-A"])
  git(["commit", "-qm", "init"])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

describe.skipIf(!gitAvailable)("shadow-git: primitif", () => {
  test("isGitRepo mendeteksi repo dan non-repo", async () => {
    expect(await isGitRepo(root)).toBe(true)
    const plain = join(tmpdir(), `minicode-plain-${Date.now()}`)
    await mkdir(plain, { recursive: true })
    try {
      // tmpdir bisa berada di dalam repo lain pada beberapa mesin; cukup pastikan
      // fungsinya tidak melempar dan mengembalikan boolean
      expect(typeof (await isGitRepo(plain))).toBe("boolean")
    } finally {
      await rm(plain, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("snapshotTree menghasilkan SHA tree dan mem-pin ref", async () => {
    const snap = await snapshotTree(root, "sess-a", "pre")
    expect(snap).not.toBeNull()
    expect(snap!.tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(snap!.ref).toContain("refs/minicode/sess-a/")
    const refs = await listShadowRefs(root)
    expect(refs.some((r) => r.tree === snap!.tree)).toBe(true)
  })

  test("tree tetap dapat dibaca setelah git gc --prune=now", async () => {
    const snap = await snapshotTree(root, "sess-gc", "pre")
    await w("a.txt", "berubah setelah snapshot")
    git(["gc", "--prune=now", "-q"])
    const blob = git(["cat-file", "blob", `${snap!.tree}:a.txt`])
    expect(blob.status).toBe(0)
    expect(blob.stdout).toBe("v1")
  })

  test("ref shadow tidak muncul di git log/branch user", async () => {
    await snapshotTree(root, "sess-hidden", "pre")
    const log = git(["log", "--oneline", "--all"])
    expect(log.stdout).not.toContain("minicode")
    const branch = git(["branch", "-a"])
    expect(branch.stdout).not.toContain("minicode")
  })

  test("snapshot tidak mengubah index atau HEAD user", async () => {
    const headBefore = git(["rev-parse", "HEAD"]).stdout.trim()
    const statusBefore = git(["status", "--porcelain"]).stdout
    await w("baru.txt", "belum di-stage")
    const statusWithNew = git(["status", "--porcelain"]).stdout
    await snapshotTree(root, "sess-idx", "pre")
    expect(git(["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore)
    // status tetap sama seperti sebelum snapshot (file baru masih untracked)
    expect(git(["status", "--porcelain"]).stdout).toBe(statusWithNew)
    expect(statusBefore).not.toBe(statusWithNew) // sanity: memang ada perubahan
  })

  test("diffTrees melaporkan add/modify/delete", async () => {
    const before = await snapshotTree(root, "sess-diff", "pre")
    await w("a.txt", "dimodifikasi")
    await w("c.txt", "file baru")
    await rm(join(root, "src/b.ts"))
    const after = await snapshotTree(root, "sess-diff", "post")
    const changes = await diffTrees(root, before!.tree, after!.tree)
    const byPath = new Map(changes.map((c) => [c.path, c.status]))
    expect(byPath.get("a.txt")).toBe("M")
    expect(byPath.get("c.txt")).toBe("A")
    expect(byPath.get("src/b.ts")).toBe("D")
  })

  test("file ber-.gitignore tidak masuk snapshot (disengaja)", async () => {
    const snap = await snapshotTree(root, "sess-ign", "pre")
    const ls = git(["ls-tree", "-r", "--name-only", snap!.tree])
    expect(ls.stdout).not.toContain("ignored/secret.txt")
    expect(ls.stdout).toContain("a.txt")
  })

  test("pruneSessionRefs menghapus ref sesi itu saja", async () => {
    await snapshotTree(root, "sess-x", "pre")
    await snapshotTree(root, "sess-y", "pre")
    const removed = await pruneSessionRefs(root, "sess-x")
    expect(removed).toBeGreaterThan(0)
    const refs = await listShadowRefs(root)
    expect(refs.some((r) => r.ref.includes("sess-x"))).toBe(false)
    expect(refs.some((r) => r.ref.includes("sess-y"))).toBe(true)
  })

  test("sessionId dengan karakter tak-valid untuk ref tetap aman", async () => {
    // Regresi: `sess/../..~weird:id` dulu membuat path index
    // `.git\..~weird:id-...` yang ditolak Windows (Invalid argument), sehingga
    // snapshot gagal total dan checkpoint hilang senyap.
    const snap = await snapshotTree(root, "sess/../..~weird:id", "pre")
    expect(snap).not.toBeNull()
    expect(snap!.ref).not.toContain("..")
    expect(snap!.ref).not.toContain("~")
    expect(snap!.ref).not.toContain(":")
    expect(git(["check-ref-format", snap!.ref]).status).toBe(0)
  })

  test("line ending tidak diubah oleh restore (core.autocrlf)", async () => {
    // Regresi: di Windows core.autocrlf=true secara default, sehingga
    // checkout-index menerapkan smudge filter dan memulihkan file LF sebagai
    // CRLF — restore mengubah byte yang tak diminta siapa pun.
    const lf = "baris1\nbaris2\n"
    await w("eol.txt", lf)
    const snap = await snapshotTree(root, "sess-eol", "pre")
    await w("eol.txt", "dirusak")
    await restoreTree(root, snap!.tree)
    const restored = await readFile(join(root, "eol.txt"), "utf8")
    expect(restored).toBe(lf)
    expect(restored).not.toContain("\r")
  })
})

describe.skipIf(!gitAvailable)("shadow-git: restore", () => {
  test("modifikasi dipulihkan, file baru dihapus", async () => {
    const snap = await snapshotTree(root, "sess-r1", "pre")
    await w("a.txt", "dirusak agent")
    await w("tambahan.txt", "sampah")
    const res = await restoreTree(root, snap!.tree)
    expect(await read("a.txt")).toBe("v1")
    expect(existsSync(join(root, "tambahan.txt"))).toBe(false)
    expect(res.applied.length).toBeGreaterThan(0)
  })

  test("file yang dihapus agent dipulihkan kembali", async () => {
    const snap = await snapshotTree(root, "sess-r2", "pre")
    await rm(join(root, "src/b.ts"))
    await restoreTree(root, snap!.tree)
    expect(await read("src/b.ts")).toBe("export const b = 1\n")
  })

  test("file ber-.gitignore TIDAK tersentuh restore", async () => {
    const snap = await snapshotTree(root, "sess-r3", "pre")
    await w("ignored/secret.txt", "diubah manual oleh user")
    await w("a.txt", "berubah")
    await restoreTree(root, snap!.tree)
    expect(await read("a.txt")).toBe("v1")
    // yang di-ignore bukan urusan checkpoint — harus tetap seperti apa adanya
    expect(await read("ignored/secret.txt")).toBe("diubah manual oleh user")
  })

  test("restore ke tree identik = no-op tanpa error", async () => {
    const snap = await snapshotTree(root, "sess-r4", "pre")
    const res = await restoreTree(root, snap!.tree)
    expect(res.applied).toEqual([])
    expect(res.skipped).toEqual([])
  })

  test("restore hanya menyentuh path yang berubah", async () => {
    const snap = await snapshotTree(root, "sess-r5", "pre")
    await w("a.txt", "berubah")
    const res = await restoreTree(root, snap!.tree)
    // src/b.ts tidak berubah → tidak boleh ikut disebut
    expect(res.applied.some((f) => f.includes("a.txt"))).toBe(true)
    expect(res.applied.some((f) => f.includes("src/b.ts"))).toBe(false)
  })

  test("HEAD tetap utuh setelah restore", async () => {
    const head = git(["rev-parse", "HEAD"]).stdout.trim()
    const snap = await snapshotTree(root, "sess-r6", "pre")
    await w("a.txt", "x")
    await restoreTree(root, snap!.tree)
    expect(git(["rev-parse", "HEAD"]).stdout.trim()).toBe(head)
  })
})

describe.skipIf(!gitAvailable)("checkpoint: integrasi mode git", () => {
  test("beginTurnSnapshot memilih mode git di repo", async () => {
    const pre = await beginTurnSnapshot("sess-mode", root)
    expect(pre.mode).toBe("git")
  })

  test("beginTurnSnapshot tidak memakai fallback terbatas saat snapshot repo gagal", async () => {
    git(["config", "core.bare", "true"])

    const pre = await beginTurnSnapshot("sess-snapshot-failed", root)

    expect(pre).toEqual({ mode: "unavailable", reason: "git-snapshot-failed" })
  })

  test("undo lalu redo lintas tree", async () => {
    const sess = "sess-ur"
    const pre = await beginTurnSnapshot(sess, root)
    if (pre.mode !== "git") throw new Error("harus mode git")
    await w("a.txt", "hasil kerja agent")
    await w("src/c.ts", "export const c = 2\n")
    const post = await snapshotTree(root, sess, "post")
    await recordCheckpointFromTrees(sess, 1, pre.tree, post!.tree, "turn 1", root)

    const undo = await undoLastCheckpoint(sess, root)
    expect(undo.success).toBe(true)
    expect(await read("a.txt")).toBe("v1")
    expect(existsSync(join(root, "src/c.ts"))).toBe(false)

    const redo = await redoLastCheckpoint(sess, root)
    expect(redo.success).toBe(true)
    expect(await read("a.txt")).toBe("hasil kerja agent")
    expect(await read("src/c.ts")).toBe("export const c = 2\n")
  })

  test("turn tanpa perubahan tidak membuat checkpoint", async () => {
    const sess = "sess-noop"
    const pre = await beginTurnSnapshot(sess, root)
    if (pre.mode !== "git") throw new Error("harus mode git")
    const post = await snapshotTree(root, sess, "post")
    const cp = await recordCheckpointFromTrees(sess, 1, pre.tree, post!.tree, "turn 1", root)
    expect(cp).toBeNull()
    const manifest = await loadCheckpointManifest(sess, root)
    expect(manifest.checkpoints.length).toBe(0)
  })

  test("manifest menyimpan SHA, bukan isi file", async () => {
    const sess = "sess-size"
    const pre = await beginTurnSnapshot(sess, root)
    if (pre.mode !== "git") throw new Error("harus mode git")
    // isi besar: manifest tidak boleh membengkak karenanya
    await w("besar.txt", "x".repeat(200_000))
    const post = await snapshotTree(root, sess, "post")
    await recordCheckpointFromTrees(sess, 1, pre.tree, post!.tree, "turn 1", root)
    const raw = await readFile(
      join(root, ".minicode", "checkpoints", sess, "manifest.json"),
      "utf8",
    )
    expect(raw.length).toBeLessThan(2000)
    expect(raw).not.toContain("xxxxxxxxxx")
    expect(raw).toContain(pre.tree)
  })

  test("undo bekerja untuk perubahan dari bash, bukan hanya edit tool", async () => {
    const sess = "sess-bash"
    const pre = await beginTurnSnapshot(sess, root)
    if (pre.mode !== "git") throw new Error("harus mode git")
    // simulasi: script menulis banyak file (yang dulu bisa melewati cap 200)
    for (let i = 0; i < 250; i++) await w(`gen-${i}.txt`, `file ${i}`)
    const post = await snapshotTree(root, sess, "post")
    await recordCheckpointFromTrees(sess, 1, pre.tree, post!.tree, "turn 1", root)
    const undo = await undoLastCheckpoint(sess, root)
    expect(undo.success).toBe(true)
    // SEMUA file terhapus — tidak ada cap yang menyisakan sebagian
    for (const i of [0, 99, 200, 249]) {
      expect(existsSync(join(root, `gen-${i}.txt`))).toBe(false)
    }
  })
})

describe("checkpoint: fallback non-git tetap jalan", () => {
  const plain = join(tmpdir(), `minicode-nogit-${Date.now()}`)

  test("beginTurnSnapshot memakai mode files di luar repo", async () => {
    await mkdir(plain, { recursive: true })
    await writeFile(join(plain, "a.txt"), "v1", "utf8")
    try {
      const pre = await beginTurnSnapshot("sess-plain", plain)
      // Bila tmpdir kebetulan di dalam repo git, mode bisa "git" — yang penting
      // fungsinya mengembalikan salah satu mode valid dan tidak melempar.
      expect(["git", "files"]).toContain(pre.mode)
      if (pre.mode === "files") {
        expect(pre.snapshots.some((s) => s.path === "a.txt")).toBe(true)
      }
    } finally {
      await rm(plain, { recursive: true, force: true }).catch(() => {})
    }
  })
})
