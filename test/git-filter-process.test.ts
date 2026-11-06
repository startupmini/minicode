// Hardening F-04: protokol `filter.<d>.process` diutamakan git di atas
// clean/smudge — override clean/smudge saja tidak menghentikan eksekusinya.
// Plumbing internal (shadow snapshot/restore) wajib menonaktifkannya;
// git_commit harus menolak sebelum staging bila filter dikonfigurasi.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider, finish, text, toolCall } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import {
  discoverFilterDrivers,
  GIT_SAFE_BASE,
  gitFilterNeutralizers,
} from "../src/lib/git-hardening.ts"
import { resolveTrustedExecutable } from "../src/lib/trusted-exec.ts"
import { gitCommitTool } from "../src/tools/git.ts"

// Isolasi konfigurasi sistem/global agar test clean repo tidak mewarisi filter
// operator (mis. Git LFS); filter jahat tetap dikonfigurasi eksplisit di fixture.
const isolatedGitConfig = join(tmpdir(), `minicode-filter-test-config-${randomUUID()}`)
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
const originalGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM

beforeAll(async () => {
  await writeFile(isolatedGitConfig, "", "utf8")
  process.env.GIT_CONFIG_GLOBAL = isolatedGitConfig
  process.env.GIT_CONFIG_NOSYSTEM = "1"
})

afterAll(async () => {
  if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal
  if (originalGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = originalGitConfigNoSystem
  await rm(isolatedGitConfig, { force: true }).catch(() => {})
})

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

describe.skipIf(!gitAvailable)("TOOL-07: git_commit menolak custom filter sebelum staging", () => {
  test("filter process berbahaya ditolak tanpa side effect atau staging", async () => {
    const { dir, marker } = await processFilterRepo()
    try {
      await expect(
        gitCommitTool.execute(
          { message: "commit uji filter", paths: ["a.txt"], cwd: dir },
          ctxFor(dir),
        ),
      ).rejects.toThrow(/blocked before staging.*filter\.evil/)
      expect(await has(marker)).toBe(false)
      expect(git(["diff", "--cached", "--name-only"], dir).stdout.trim()).toBe("")
      expect(git(["rev-parse", "--verify", "HEAD"], dir).status).not.toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("repo tanpa filter efektif tetap dapat di-commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleanrepo-"))
    try {
      git(["init", "-q"], dir)
      git(["config", "user.email", "t@example.com"], dir)
      git(["config", "user.name", "t"], dir)
      git(["config", "commit.gpgsign", "false"], dir)
      await writeFile(join(dir, "b.txt"), "hi\n", "utf8")
      const drivers = await discoverFilterDrivers(dir)
      if (drivers.length > 0) {
        await expect(
          gitCommitTool.execute(
            { message: "commit bersih", paths: ["b.txt"], cwd: dir },
            ctxFor(dir),
          ),
        ).rejects.toThrow("filters are configured")
        return
      }
      const out = (await gitCommitTool.execute(
        { message: "commit bersih", paths: ["b.txt"], cwd: dir },
        ctxFor(dir),
      )) as string
      expect(out.trim()).not.toBe("")
      expect(git(["rev-parse", "--verify", "HEAD"], dir).status).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("dispatch produksi AUTO dan ASK tetap memblokir filter sebelum side effect", async () => {
    for (const mode of ["auto", "ask"] as const) {
      const { dir, marker } = await processFilterRepo()
      const previousTty = process.stdin.isTTY
      let approvalCount = 0
      if (mode === "ask") {
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
      }
      const provider = new FakeProvider([
        {
          events: [
            toolCall("git_commit", { message: `blocked ${mode}`, paths: ["a.txt"] }),
            finish("tool_calls"),
          ],
        },
        { events: [text("finished"), finish("stop")] },
      ])
      const session = await createMinicodeSession({
        provider,
        tools: [gitCommitTool],
        permissionMode: mode,
        cwd: dir,
        noProgress: false,
        ...(mode === "ask"
          ? {
              ask: async () => {
                approvalCount++
                return "allow" as const
              },
            }
          : {}),
      })
      const started: string[] = []
      session.events.on("execution:started", (event) => started.push(event.execution.call.name))

      try {
        const result = await session.run(`permission mode ${mode}`)
        const toolResult = result.steps.flatMap((step) => step.results)
        expect(started, mode).toEqual(["git_commit"])
        expect(toolResult, mode).toHaveLength(1)
        expect(toolResult[0]?.isError === true, mode).toBe(true)
        expect(String(toolResult[0]?.content), mode).toContain("blocked before staging")
        expect(approvalCount, mode).toBe(mode === "ask" ? 1 : 0)
        expect(await has(marker), mode).toBe(false)
        expect(git(["diff", "--cached", "--name-only"], dir).stdout.trim(), mode).toBe("")
        expect(git(["rev-parse", "--verify", "HEAD"], dir).status, mode).not.toBe(0)
      } finally {
        session.abort()
        Object.defineProperty(process.stdin, "isTTY", { value: previousTty, configurable: true })
        await rm(dir, { recursive: true, force: true })
      }
    }
  })
})
