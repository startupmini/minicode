import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { saveCheckpointManifest, validateResumeWorkspace } from "../src/session/checkpoint.ts"
import { ephemeralTree } from "../src/session/shadow-git.ts"
import { type StepTrace, summarizeStepTraces } from "../src/telemetry/trace.ts"

let dir = ""
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ""
})

const tool = (over: Partial<StepTrace> & { tool: string }): StepTrace => ({
  sessionId: "s",
  timestamp: "t",
  kind: "tool",
  step: 0,
  sandbox: "none",
  ...over,
})

// P3.1 — agregat step-trace untuk stats.
describe("harness P3.1: summarizeStepTraces", () => {
  test("kosong -> nol semua", () => {
    const s = summarizeStepTraces([])
    expect(s).toMatchObject({ tools: 0, ok: 0, denied: 0, errors: 0, denyRate: 0 })
    expect(s.topDenied).toEqual([])
    expect(s.sandboxes).toEqual([])
    expect(s.peakTotalTokens).toBe(0)
  })

  test("F1.2: peakTotalTokens = max kumulatif antar baris (bahan kurva token)", () => {
    // Gagal di kode lama: field tak ada (undefined), bukan 0/angka.
    const s = summarizeStepTraces([
      tool({ tool: "read_file", ok: true, totalTokens: 100 }),
      tool({ tool: "bash", ok: true, totalTokens: 350 }),
      {
        sessionId: "s",
        timestamp: "t",
        kind: "step",
        step: 1,
        tools: 2,
        errors: 0,
        totalTokens: 200,
      },
      tool({ tool: "write_file", ok: true }), // format lama tanpa token: diabaikan
    ])
    expect(s.peakTotalTokens).toBe(350)
  })

  test("menghitung ok/denied/error + top + sandbox", () => {
    const s = summarizeStepTraces([
      tool({ tool: "read_file", ok: true }),
      tool({ tool: "bash", ok: false, denied: true }),
      tool({ tool: "bash", ok: false, denied: true }),
      tool({ tool: "write_file", ok: false }),
      { sessionId: "s", timestamp: "t", kind: "step", step: 0, tools: 4, errors: 3 },
    ])
    expect(s.tools).toBe(4)
    expect(s.ok).toBe(1)
    expect(s.denied).toBe(2)
    expect(s.errors).toBe(1)
    expect(s.denyRate).toBe(0.5)
    expect(s.topDenied).toEqual([{ tool: "bash", n: 2 }])
    expect(s.topErrors).toEqual([{ tool: "write_file", n: 1 }])
    expect(s.sandboxes).toEqual(["none"])
  })
})

// P3.2 — validasi resume: bukan replay buta.
describe("harness P3.2: validateResumeWorkspace", () => {
  test("tanpa manifest -> none/0", async () => {
    dir = await mkdtemp(join(tmpdir(), "minicode-hp3-"))
    await expect(validateResumeWorkspace(dir, "baru")).resolves.toEqual({
      mode: "none",
      diverged: 0,
    })
  })

  test("mode files: cocok -> 0, berubah -> 1", async () => {
    dir = await mkdtemp(join(tmpdir(), "minicode-hp3-"))
    await writeFile(join(dir, "a.txt"), "hi", "utf8")
    await saveCheckpointManifest(
      {
        sessionId: "r1",
        currentIndex: 0,
        checkpoints: [
          {
            id: "c1",
            turn: 0,
            timestamp: "t",
            description: "t",
            snapshots: [],
            redoSnapshots: [{ path: "a.txt", content: "hi" }],
          },
        ],
      },
      dir,
    )
    await expect(validateResumeWorkspace(dir, "r1")).resolves.toEqual({
      mode: "files",
      diverged: 0,
    })
    await writeFile(join(dir, "a.txt"), "berubah", "utf8")
    await expect(validateResumeWorkspace(dir, "r1")).resolves.toEqual({
      mode: "files",
      diverged: 1,
    })
  })

  test("mode git: tree sama -> 0, file berubah -> >=1", async () => {
    dir = await mkdtemp(join(tmpdir(), "minicode-hp3-"))
    spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" })
    await writeFile(join(dir, "a.txt"), "hi", "utf8")
    const tree = await ephemeralTree(dir)
    expect(tree).toMatch(/^[0-9a-f]{40}/)
    await saveCheckpointManifest(
      {
        sessionId: "r2",
        currentIndex: 0,
        checkpoints: [
          {
            id: "c1",
            turn: 0,
            timestamp: "t",
            description: "t",
            snapshots: [],
            treeAfter: tree!,
          },
        ],
      },
      dir,
    )
    await expect(validateResumeWorkspace(dir, "r2")).resolves.toEqual({
      mode: "git",
      diverged: 0,
    })
    await writeFile(join(dir, "a.txt"), "berubah", "utf8")
    const after = await validateResumeWorkspace(dir, "r2")
    expect(after?.mode).toBe("git")
    expect(after!.diverged).toBeGreaterThanOrEqual(1)
  })
})
