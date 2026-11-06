import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { GIT_SAFE_BASE } from "../src/lib/git-hardening.ts"
import { resolveTrustedExecutable } from "../src/lib/trusted-exec.ts"
import { gitCommitTool } from "../src/tools/git.ts"

// Git for Windows may define LFS filters in system/global config. Positive
// commit tests isolate those operator-wide filters so they exercise clean repos.
const isolatedGitConfig = join(tmpdir(), `minicode-git-test-config-${randomUUID()}`)
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

const gitAvailable =
  spawnSync("git", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0

function git(cwd: string, args: string[]): string {
  const result = spawnSync(resolveTrustedExecutable("git"), [...GIT_SAFE_BASE, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
  return result.stdout.trim()
}

async function repo(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "minicode-git-index-"))
  git(cwd, ["init", "-q"])
  git(cwd, ["config", "user.email", "minicode-test@example.invalid"])
  git(cwd, ["config", "user.name", "MiniCode Test"])
  git(cwd, ["config", "commit.gpgsign", "false"])
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(cwd, dirname(path)), { recursive: true })
    await writeFile(join(cwd, path), contents, "utf8")
  }
  git(cwd, ["add", "--all"])
  git(cwd, ["commit", "-qm", "initial"])
  return cwd
}

async function commit(
  cwd: string,
  args: { message: string; paths?: string[]; all?: boolean; subdir?: string },
): Promise<string> {
  return (await gitCommitTool.execute(
    {
      message: args.message,
      ...(args.paths ? { paths: args.paths } : {}),
      ...(args.all ? { all: true } : {}),
      ...(args.subdir ? { cwd: args.subdir } : {}),
    },
    { cwd, signal: new AbortController().signal } as never,
  )) as string
}

test.skipIf(!gitAvailable)(
  "git_commit scoped index excludes pre-staged unrelated and secret paths",
  async () => {
    const cwd = await repo({ "A.txt": "a1\n", "B.txt": "b1\n", ".env": "old-secret\n" })
    try {
      await writeFile(join(cwd, "A.txt"), "a2\n", "utf8")
      await writeFile(join(cwd, "B.txt"), "b2\n", "utf8")
      await writeFile(join(cwd, ".env"), "new-secret\n", "utf8")
      git(cwd, ["add", "--", "B.txt", ".env"])

      await commit(cwd, { message: "scoped A", paths: ["A.txt"] })

      expect(git(cwd, ["show", "--pretty=format:", "--name-only", "HEAD"]).split(/\r?\n/)).toEqual([
        "A.txt",
      ])
      expect(git(cwd, ["diff", "--cached", "--name-only"]).split(/\r?\n/).sort()).toEqual([
        ".env",
        "B.txt",
      ])
      expect(await readFile(join(cwd, ".env"), "utf8")).toBe("new-secret\n")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  },
)

test.skipIf(!gitAvailable)(
  "git_commit all:true includes tracked worktree changes, not staged untracked files",
  async () => {
    const cwd = await repo({ "A.txt": "a1\n", "B.txt": "b1\n" })
    try {
      await writeFile(join(cwd, "A.txt"), "a2\n", "utf8")
      await writeFile(join(cwd, "B.txt"), "b2\n", "utf8")
      await writeFile(join(cwd, "untracked.txt"), "not part of -a\n", "utf8")
      git(cwd, ["add", "--", "untracked.txt"])

      await commit(cwd, { message: "all tracked", all: true })

      expect(
        git(cwd, ["show", "--pretty=format:", "--name-only", "HEAD"]).split(/\r?\n/).sort(),
      ).toEqual(["A.txt", "B.txt"])
      expect(git(cwd, ["diff", "--cached", "--name-only"])).toBe("untracked.txt")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  },
)

test.skipIf(!gitAvailable)(
  "git_commit isolated index works from a workspace subdirectory",
  async () => {
    const cwd = await repo({ "sub/A.txt": "a1\n" })
    try {
      await writeFile(join(cwd, "sub", "A.txt"), "a2\n", "utf8")
      await commit(cwd, { message: "subdirectory commit", paths: ["A.txt"], subdir: "sub" })
      expect(git(cwd, ["show", "--pretty=format:", "--name-only", "HEAD"])).toBe("sub/A.txt")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  },
)

test.skipIf(!gitAvailable)(
  "parallel git_commit calls serialize and retain both authorized commits",
  async () => {
    const cwd = await repo({ "A.txt": "a1\n", "B.txt": "b1\n" })
    try {
      await writeFile(join(cwd, "A.txt"), "a2\n", "utf8")
      await writeFile(join(cwd, "B.txt"), "b2\n", "utf8")
      await Promise.all([
        commit(cwd, { message: "commit A", paths: ["A.txt"] }),
        commit(cwd, { message: "commit B", paths: ["B.txt"] }),
      ])
      expect(git(cwd, ["rev-list", "--count", "HEAD"])).toBe("3")
      const names = git(cwd, ["log", "-2", "--pretty=format:", "--name-only"])
        .split(/\r?\n/)
        .filter(Boolean)
        .sort()
      expect(names).toEqual(["A.txt", "B.txt"])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  },
)
