// Hardening F-15: semua output eksternal bounded SEBELUM masuk memori penuh.
// - web_fetch: error body raksasa hanya dibaca sebagai snippet (stream+cancel).
// - git: diff/log raksasa di-cap saat streaming dengan marker jujur.
import { expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitDiffTool } from "../src/tools/git.ts"
import { webFetchTool } from "../src/tools/web_fetch.ts"

setDefaultTimeout(60_000)

const gitAvailable =
  spawnSync("git", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0

const ctxFor = (dir: string) => ({ cwd: dir, signal: AbortSignal.timeout(30000) }) as never

test("F-15: error body 200KB hanya jadi snippet ≤ ~1k, tanpa buffer penuh", async () => {
  // Stub fetch (pola ssrf-guard.test.ts): body 200KB dalam chunk + status
  // 500. readErrorSnippet harus berhenti di 4k dan cancel stream — pesan
  // error tetap snippet, bukan 200KB.
  const encoder = new TextEncoder()
  const chunk = "x".repeat(10_000)
  let n = 0
  let cancelled = false
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (n++ < 20) controller.enqueue(encoder.encode(chunk))
          else controller.close()
        },
        cancel() {
          cancelled = true
        },
      }),
      { status: 500, statusText: "Big Error" },
    )) as unknown as typeof fetch
  try {
    let msg = ""
    try {
      await webFetchTool.execute({ url: "https://public.example.com/boom" }, ctxFor(tmpdir()))
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain("fetch 500")
    expect(msg.length).toBeLessThan(2000)
    expect(cancelled).toBe(true)
  } finally {
    globalThis.fetch = origFetch
  }
})

test("F-15: git diff ~1MB di-cap dengan marker", async () => {
  if (!gitAvailable) return
  const dir = await mkdtemp(join(tmpdir(), "bigdiff-"))
  try {
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: dir, stdio: "ignore", timeout: 30000 })
    git(["init", "-q"])
    git(["config", "user.email", "t@example.com"])
    git(["config", "user.name", "t"])
    git(["config", "commit.gpgsign", "false"])
    const line = "isi baris diff yang cukup panjang agar output membengkak\n"
    await writeFile(join(dir, "big.txt"), line.repeat(30_000), "utf8")
    git(["add", "-A"])
    git(["commit", "-qm", "init"])
    await writeFile(join(dir, "big.txt"), line.repeat(60_000), "utf8")
    const out = (await gitDiffTool.execute({}, ctxFor(dir))) as string
    expect(out).toContain("[git output truncated]")
    expect(out.length).toBeLessThan(600_000)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
