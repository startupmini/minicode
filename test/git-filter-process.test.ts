// Hardening F-04: protokol `filter.<d>.process` diutamakan git di atas
// clean/smudge — override clean/smudge saja tidak menghentikan eksekusinya.
// Plumbing internal (shadow snapshot/restore) wajib menonaktifkannya;
// jalur user-index (git_commit) wajib memperingatkan, bukan diam-diam.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverFilterDrivers,
  GIT_SAFE_BASE,
  gitFilterNeutralizers,
} from "../src/lib/git-hardening.ts"
import { resolveTrustedExecutable } from "../src/lib/trusted-exec.ts"
import { gitCommitTool } from "../src/tools/git.ts"

setDefaultTimeout(60_000)

const gitAvailable =
  spawnSync("git", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0

const git = (args: string[], cwd: string) =>
  spawnSync(resolveTrustedExecutable("git"), [...GIT_SAFE_BASE, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
  })

/** Repo dengan driver `evil` berbasis protokol process yang menulis marker
 * saat DIEKSEKUSI (terbukti via probe: git men-spawn perintahnya walau
 * handshake protokol gagal — eksekusinya yang berbahaya, bukan suksesnya).
 * Marker = bukti eksekusi, mengikuti konvensi repo-git-trust.test.ts. */
async function processFilterRepo(): Promise<{ dir: string; marker: string }> {
  const dir = await mkdtemp(join(tmpdir(), "procfilter-"))
  git(["init", "-q"], dir)
  git(["config", "user.email", "t@example.com"], dir)
  git(["config", "user.name", "t"], dir)
  git(["config", "commit.gpgsign", "false"], dir)
  const marker = join(dir, "PWNED-proc.txt").replace(/\\/g, "/")
  git(["config", "filter.evil.process", `echo PROCF > "${marker}"`], dir)
  await writeFile(join(dir, ".gitattributes"), "*.txt filter=evil\n", "utf8")
  await writeFile(join(dir, "a.txt"), "hello\n", "utf8")
  return { dir, marker: join(dir, "PWNED-proc.txt") }
}

const has = async (p: string): Promise<boolean> => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

const ctxFor = (dir: string) => ({ cwd: dir, signal: AbortSignal.timeout(30000) }) as never

describe.skipIf(!gitAvailable)("F-04: filter process dinetralkan di plumbing", () => {
  test("discovery menemukan driver process", async () => {
    const { dir } = await processFilterRepo()
    try {
      const drivers = await discoverFilterDrivers(dir)
      expect(drivers.map((d) => d.name)).toContain("evil")
      expect(drivers.find((d) => d.name === "evil")?.hasProcess).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("neutralizer memuat process= kosong untuk driver process", async () => {
    const { dir } = await processFilterRepo()
    try {
      const neutral = await gitFilterNeutralizers(dir)
      expect(neutral).toContain("filter.evil.process=")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("kontrol positif: add mentah MENGEKSEKUSI filter process", async () => {
    const { dir, marker } = await processFilterRepo()
    try {
      git(["add", "--", "a.txt"], dir)
      // Marker ada = perintah repo dieksekusi (walau handshake protokolnya
      // gagal). Bila marker tak ada, platform tak bisa menjalankan payload
      // echo sehingga kontrol gugur — test ini yang akan merah duluan.
      expect(await has(marker)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("add + neutralizer: filter process tak dieksekusi, add sukses", async () => {
    const { dir, marker } = await processFilterRepo()
    try {
      const neutral = await gitFilterNeutralizers(dir)
      const r = git([...neutral, "add", "--", "a.txt"], dir)
      expect(r.status).toBe(0)
      expect(await has(marker)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!gitAvailable)("F-04: git_commit memperingatkan filter repo", () => {
  test("repo berfilter → hasil memuat peringatan eksplisit", async () => {
    const { dir } = await processFilterRepo()
    try {
      const out = (await gitCommitTool.execute(
        { message: "commit uji filter", paths: ["a.txt"], cwd: dir },
        ctxFor(dir),
      )) as string
      expect(out).toContain("custom git filters")
      expect(out).toContain("filter.evil")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("repo tanpa driver lokal → tanpa peringatan driver lokal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleanrepo-"))
    try {
      git(["init", "-q"], dir)
      git(["config", "user.email", "t@example.com"], dir)
      git(["config", "user.name", "t"], dir)
      git(["config", "commit.gpgsign", "false"], dir)
      await writeFile(join(dir, "b.txt"), "hi\n", "utf8")
      const out = (await gitCommitTool.execute(
        { message: "commit bersih", paths: ["b.txt"], cwd: dir },
        ctxFor(dir),
      )) as string
      // filter global (mis. lfs di gitconfig mesin) boleh diperingatkan —
      // itu benar (filternya memang jalan). Yang dilarang: menyebut driver
      // yang tak ada di repo ini.
      expect(out).not.toContain("filter.evil")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
