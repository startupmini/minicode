import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import {
  discoverFilterDrivers,
  GIT_NO_DIFF_DRIVERS,
  GIT_SAFE_BASE,
  gitFilterNeutralizers,
} from "../lib/git-hardening.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { isCwdOutsideRoot, isPathOutsideRoot } from "../policy/jail.ts"
import { sanitizeSpawnEnv, scrubSecrets } from "../policy/scrub.ts"
import { requireToolCwd } from "./context.ts"

function runGit(
  args: string[],
  cwd: string | undefined,
  signal: AbortSignal,
  envPatch?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Audit #10 P0: SEMUA pemanggilan git lewat sini membawa netralisasi
    // repo-controlled execution (hooks/fsmonitor/pager via GIT_SAFE_BASE).
    // Executable di-resolve absolut dari PATH terpercaya karena Windows
    // mencari CWD lebih dulu: `git.bat` di repo akan dieksekusi tanpa ini.
    const p = spawn(resolveTrustedExecutable("git"), [...GIT_SAFE_BASE, ...args], {
      cwd,
      // Repo hooks (pre-commit/commit-msg/...) berjalan sebagai child dengan
      // env ini — kredensial (API_KEY/TOKEN/...) di-strip agar hook nakal tak
      // bisa memanen secret dari env. Auth tetap via credential helper / agen
      // SSH (SSH_AUTH_SOCK bukan pola secret) — lihat policy/scrub.ts.
      env: sanitizeSpawnEnv(process.env, envPatch),
      // Timeout dari LIMITS, bukan hardcode: `git_commit` menjalankan beberapa
      // operasi berurutan (rev-parse → add → commit → log), dan di mesin yang
      // sibuk (mis. CI menjalankan test dengan coverage) spawn git bisa jauh
      // lebih lambat dari batas 8s yang dulu dipakai — kegagalannya muncul
      // sebagai flake, bukan bug nyata.
      signal: AbortSignal.any([signal, AbortSignal.timeout(LIMITS.GIT_TIMEOUT_MS)]),
    })
    // F-15: cap SAAT streaming (bukan slice di akhir): `git diff`/`git log`
    // di repo raksasa bisa ratusan MB — buffer tak terbatas = OOM sebelum
    // truncate kernel sempat jalan. Satu-satunya tool tanpa cap sebelumnya.
    const cap = LIMITS.GIT_OUTPUT_MAX_CHARS
    let out = "",
      err = "",
      truncated = false
    const push = (cur: string, d: Buffer): string => {
      if (cur.length >= cap) {
        truncated = true
        return cur
      }
      const room = cap - cur.length
      const s = d.toString()
      if (s.length > room) truncated = true
      return cur + s.slice(0, Math.max(0, room))
    }
    p.stdout.on("data", (d) => (out = push(out, d)))
    p.stderr.on("data", (d) => (err = push(err, d)))
    p.on("error", reject)
    p.on("close", (code) => {
      const text = scrubSecrets((out + (err ? `\n${err}` : "")).trim())
      const marked = truncated ? `${text}\n… [git output truncated]` : text
      if (code !== 0 && !marked) reject(new Error(`git ${args.join(" ")} exit ${code}`))
      else resolve(marked || `(exit ${code})`)
    })
    signal.addEventListener("abort", () => p.kill("SIGTERM"), { once: true })
  })
}

const gitCommitLocks = new Map<string, Promise<void>>()

async function withGitCommitLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(cwd)
  const previous = gitCommitLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolvePromise) => (release = resolvePromise))
  const queued = previous.then(() => current)
  gitCommitLocks.set(key, queued)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (gitCommitLocks.get(key) === queued) gitCommitLocks.delete(key)
  }
}

/** cwd tool harus di dalam workspace — sama seperti bash/glob/grep. */
function assertCwd(cwd: string | undefined, sessionRoot: string): void {
  if (!cwd) return
  const abs = resolve(sessionRoot, cwd)
  if (isCwdOutsideRoot(abs, sessionRoot) || isPathOutsideRoot(abs, sessionRoot)) {
    throw new Error(`cwd outside workspace: ${cwd}`)
  }
}

async function isGitRepo(cwd: string, signal: AbortSignal): Promise<boolean> {
  try {
    const out = await runGit(["rev-parse", "--is-inside-work-tree"], cwd, signal)
    return out.trim() === "true"
  } catch {
    return false
  }
}

export const gitStatusTool: Tool = {
  name: "git_status",
  description:
    "git status --porcelain + diff --stat + log --oneline -10 (hardened: ignores repository hooks, filters and diff drivers — prefer over raw `git` in bash)",
  parameters: {
    type: "object",
    properties: { cwd: { type: "string" } },
    required: [],
    additionalProperties: false,
  },
  async execute({ cwd }, ctx) {
    const c = cwd as string | undefined
    const sessionRoot = requireToolCwd(ctx)
    assertCwd(c, sessionRoot)
    const resolvedCwd = c ? resolve(sessionRoot, c) : sessionRoot
    if (!(await isGitRepo(resolvedCwd, ctx.signal))) return "not a git repository"
    // Audit #10 P0: `git diff` menjalankan clean filter pada berkas dirty
    // (banding konten worktree vs index) — netralkan seperti shadow ops.
    // Efek samping: repo dengan filter konversi legitim (mis. LFS) bisa
    // menampilkan phantom diff; itu display-only dan aman.
    const neutral = await gitFilterNeutralizers(resolvedCwd)
    // Audit #13 chain 6: `git status --porcelain` pun menerapkan clean filter
    // untuk entri racy (file baru diubah vs index) — tanpa neutral, review
    // status di repo jahat mengeksekusi perintah repo (reproducer:
    // PWNED-clean.txt muncul dari git_status). Neutral ikut ke status.
    const [a, b, d] = await Promise.all([
      runGit([...neutral, "status", "--porcelain"], resolvedCwd, ctx.signal),
      // Pasangan -c WAJIB sebelum subcommand "diff" (runGit menaruh BASE di
      // depan; neutral di sini tepat setelahnya). Tanpa ini driver konten
      // repo ikut jalan saat diff membandingkan worktree.
      runGit([...neutral, "diff", ...GIT_NO_DIFF_DRIVERS, "--stat"], resolvedCwd, ctx.signal),
      runGit(["log", "--oneline", "-10"], resolvedCwd, ctx.signal),
    ])
    return `status:\n${a || "(clean)"}\n\ndiff --stat:\n${b || "(no diff)"}\n\nlog -10:\n${d || "(no log)"}`
  },
}

export const gitDiffTool: Tool = {
  name: "git_diff",
  description:
    "git diff (unstaged) or git diff --staged (hardened: ignores repository hooks, filters and diff drivers — prefer over raw `git diff` in bash)",
  parameters: {
    type: "object",
    properties: {
      cwd: { type: "string" },
      staged: { type: "boolean", description: "true = --staged" },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ cwd, staged }, ctx) {
    const sessionRoot = requireToolCwd(ctx)
    assertCwd(cwd as string | undefined, sessionRoot)
    const resolvedCwd = (cwd as string | undefined)
      ? resolve(sessionRoot, cwd as string)
      : sessionRoot
    if (!(await isGitRepo(resolvedCwd, ctx.signal))) return "not a git repository"
    // Netralisasi clean seperti git_status (lihat di atas): diff full-content
    // lebih-lebih memicu filter. -c sebelum subcommand.
    const neutral = await gitFilterNeutralizers(resolvedCwd)
    const args = staged
      ? [...neutral, "diff", ...GIT_NO_DIFF_DRIVERS, "--staged"]
      : [...neutral, "diff", ...GIT_NO_DIFF_DRIVERS]
    return await runGit(args, resolvedCwd, ctx.signal)
  },
}

export const gitLogTool: Tool = {
  name: "git_log",
  description: "git log --oneline -n (hardened: ignores repository hooks and pager)",
  parameters: {
    type: "object",
    properties: {
      cwd: { type: "string" },
      limit: { type: "number", description: "number of commits, default 20" },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ cwd, limit }, ctx) {
    const sessionRoot = requireToolCwd(ctx)
    assertCwd(cwd as string | undefined, sessionRoot)
    const resolvedCwd = (cwd as string | undefined)
      ? resolve(sessionRoot, cwd as string)
      : sessionRoot
    if (!(await isGitRepo(resolvedCwd, ctx.signal))) return "not a git repository"
    const n = String(Math.min(Math.max((limit as number) ?? 20, 1), 100))
    return await runGit(["log", "--oneline", `-${n}`], resolvedCwd, ctx.signal)
  },
}

// ── Tool tulis ──
//
// `git_commit` di-GATE di permission layer (setara `delegate_task`/`mcp_call`):
// commit mengubah riwayat yang dibagikan, jadi butuh persetujuan sekali per
// pemakaian di mode `auto`, dan ditolak di `readonly`/`plan`/`allowlist`.
//
// Yang SENGAJA tidak disediakan: `push`, `reset --hard`, `rebase`, `checkout`,
// `branch -D`, `stash drop`, dan amend. Semuanya sulit dibalikkan atau
// mempengaruhi remote/repo orang lain — agent tidak perlu itu untuk
// menyelesaikan task, dan menyediakannya memindahkan risiko besar ke tangan
// yang tidak bisa menilai konteksnya.

/** Nama file di argumen `paths` harus di dalam workspace. */
function assertPaths(paths: unknown, cwd: string | undefined, sessionRoot: string): string[] {
  if (paths == null) return []
  if (!Array.isArray(paths)) throw new Error("paths must be an array of strings")
  const root = cwd ? resolve(sessionRoot, cwd) : sessionRoot
  const out: string[] = []
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) continue
    if (isPathOutsideRoot(p, root)) throw new Error(`path outside workspace: ${p}`)
    out.push(p)
  }
  return out
}

export const gitCommitTool: Tool = {
  name: "git_commit",
  description:
    "Create a git commit. Stage specific paths (paths) or all tracked changes (all:true). Does not support push/amend/reset — that is beyond the agent's authority. Never runs repository hooks and refuses configured custom filters before staging; use manual Git only after reviewing trusted filters.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "commit message (first line = subject)" },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "files to stage; leave empty when using all",
      },
      all: {
        type: "boolean",
        description: "stage all files ALREADY tracked by git (equivalent to git commit -a)",
      },
      cwd: { type: "string" },
    },
    required: ["message"],
    additionalProperties: false,
  },
  async execute({ message, paths, all, cwd }, ctx) {
    ctx.signal.throwIfAborted()
    const c = cwd as string | undefined
    const sessionRoot = requireToolCwd(ctx)
    assertCwd(c, sessionRoot)
    const resolvedCwd = c ? resolve(sessionRoot, c) : sessionRoot
    const msg = String(message ?? "").trim()
    if (!msg) throw new Error("message is required")
    if (msg.length > 4000) throw new Error("message terlalu panjang (max 4000 char)")

    const files = assertPaths(paths, c, sessionRoot)
    if (files.length === 0 && all !== true) {
      throw new Error(
        "provide `paths` (specific files) or `all: true` — an empty commit is useless",
      )
    }

    // Repo check dulu supaya errornya jelas, bukan "exit 128".
    const inside = await runGit(
      ["rev-parse", "--is-inside-work-tree"],
      resolvedCwd,
      ctx.signal,
    ).catch(() => "")
    if (!inside.startsWith("true")) throw new Error("not a git repository (git rev-parse failed)")

    return await withGitCommitLock(resolvedCwd, async () => {
      ctx.signal.throwIfAborted()
      // Tool authority tidak mencakup eksekusi command dari filter repo.
      // Discovery juga fail-closed: kegagalan membaca config berhenti sebelum
      // temporary index dibuat atau `git add` dapat menjalankan filter.
      const drivers = await discoverFilterDrivers(resolvedCwd)
      if (drivers.length > 0) {
        const names = drivers.map((d) => `filter.${d.name}`).join(", ")
        throw new Error(
          `git_commit blocked before staging: repository Git filters are configured (${names}). ` +
            "Review .gitattributes and Git config, then perform the commit manually if the filters are trusted.",
        )
      }

      const tempIndexDir = await mkdtemp(join(tmpdir(), "minicode-git-index-"))
      const indexEnv = { GIT_INDEX_FILE: join(tempIndexDir, "index") }
      try {
        // Seed a private index from HEAD. Existing staged changes stay in the
        // user's index and can never leak into this scoped commit.
        const headRef = await runGit(
          ["rev-parse", "--verify", "HEAD"],
          resolvedCwd,
          ctx.signal,
        ).catch(() => "")
        await runGit(
          ["read-tree", headRef.trim() ? "HEAD" : "--empty"],
          resolvedCwd,
          ctx.signal,
          indexEnv,
        )
        if (files.length > 0) {
          // `--` memisahkan path dari opsi: nama file bernama `-f` tak jadi flag.
          await runGit(["add", "--", ...files], resolvedCwd, ctx.signal, indexEnv)
        }

        // `-m` satu argumen; --no-verify menonaktifkan hook yang sudah
        // dinetralkan GIT_SAFE_BASE. `-a` hanya berlaku pada index privat.
        const args = ["commit", "--no-verify", "-m", msg]
        if (files.length === 0 && all === true) args.push("-a")
        const out = await runGit(args, resolvedCwd, ctx.signal, indexEnv)
        if (/nothing to commit|no changes added/i.test(out)) {
          try {
            const subject = (
              await runGit(["log", "-1", "--format=%s"], resolvedCwd, ctx.signal).catch(() => "")
            ).trim()
            if (subject && subject === msg.split("\n")[0]?.trim()) {
              const head = await runGit(["log", "--oneline", "-1"], resolvedCwd, ctx.signal).catch(
                () => "",
              )
              return `already committed (retry aman — tanpa commit baru):\n${out}${head ? `\n\nHEAD: ${head}` : ""}`
            }
          } catch {}
          return `nothing to commit:\n${out}`
        }
        let indexWarning = ""
        const newHead = await runGit(
          ["rev-parse", "--verify", "HEAD"],
          resolvedCwd,
          ctx.signal,
        ).catch(() => "")
        if (newHead.trim() && newHead.trim() !== headRef.trim()) {
          try {
            const committedPaths = await runGit(
              [
                "--literal-pathspecs",
                "diff-tree",
                "--root",
                "--no-renames",
                "--no-commit-id",
                "--name-only",
                "-r",
                "-z",
                "HEAD",
              ],
              resolvedCwd,
              ctx.signal,
            )
            const paths = committedPaths.split("\0").filter(Boolean)
            if (paths.length > 0) {
              // Reconcile only committed entries in the shared index. This
              // leaves unrelated staged paths intact while keeping the normal
              // post-commit status clean for files this operation authorized.
              await runGit(
                ["--literal-pathspecs", "reset", "--quiet", "HEAD", "--", ...paths],
                resolvedCwd,
                ctx.signal,
              )
            }
          } catch {
            indexWarning =
              "\n\n[warn] commit succeeded, but the shared index could not be reconciled; review `git status` before the next commit."
          }
        }
        const head = await runGit(["log", "--oneline", "-1"], resolvedCwd, ctx.signal).catch(
          () => "",
        )
        return `${out}${head ? `\n\nHEAD: ${head}` : ""}${indexWarning}`
      } finally {
        await rm(tempIndexDir, { recursive: true, force: true }).catch(() => {})
      }
    })
  },
}
