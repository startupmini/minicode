import { expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { ContextStore } from "#minicore/core/index.ts"
import { Pool } from "../src/agents/pool.ts"
import { loadAllowlist, matchAllowlist } from "../src/policy/allowlist.ts"
import { compactWithLlm, createLlmCompaction } from "../src/policy/compaction.ts"
import { estimateImageTokens, minicodeEstimator } from "../src/policy/context.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"
import {
  findSkill,
  invalidateSkillCache,
  loadSkills,
  renderSkill,
  skillsToSystemPrompt,
} from "../src/skills/loader.ts"

const tmp = ".tmp-skills-test"

test("skills: load, find, render", async () => {
  await mkdir(`${tmp}/.minicode/skills`, { recursive: true })
  await writeFile(
    `${tmp}/.minicode/skills/review.md`,
    `---\nname: review\ndescription: Review code\n---\nReview this code: {{args}}`,
  )
  const all = await loadSkills(tmp)
  expect(all.length).toBe(1)
  expect(all[0]?.name).toBe("review")
  const found = await findSkill("review", tmp)
  expect(found?.description).toBe("Review code")
  const rendered = await renderSkill(found!, "src/a.ts")
  expect(rendered).toContain("src/a.ts")
  expect(skillsToSystemPrompt(all)).toContain("/review")
  // /name with args via findSkill
  const foundSlash = await findSkill("/review", tmp)
  expect(foundSlash?.name).toBe("review")
  await rm(tmp, { recursive: true, force: true })
})

test("hooks allowlist match", () => {
  const call = { id: "1", name: "bash", args: { cmd: "echo hi" } }
  expect(matchAllowlist(call as never, [])).toBe(false)
  expect(matchAllowlist(call as never, ["bash"])).toBe(true)
  const callWrite = { id: "2", name: "write_file", args: { path: "a.txt" } }
  expect(matchAllowlist(callWrite as never, ['write_file:{"path":"a.txt"}'])).toBe(true)
  expect(matchAllowlist(callWrite as never, ['write_file:{"path":"b.txt"}'])).toBe(false)
})

test("allowlist load empty when missing", async () => {
  const l = await loadAllowlist(".tmp-nonexistent-dir")
  expect(l.allowed).toEqual([])
})

test("permission readonly denies delegate/mcp/lsp write tools", async () => {
  const h = createPermissionHandler({ mode: "readonly" })
  expect(
    await h.check({ id: "1", name: "delegate_task", args: { prompt: "x" } } as never, {} as never),
  ).toBe("deny")
})

test("auto gates delegate_task/mcp_call without TTY (sub-agent policy)", async () => {
  const h = createPermissionHandler({ mode: "auto" })
  expect(
    await h.check(
      { id: "1", name: "delegate_task", args: { prompt: "explore src" } } as never,
      {} as never,
    ),
  ).toBe("deny")
  expect(
    await h.check(
      { id: "1", name: "mcp_call", args: { server: "x", tool: "y" } } as never,
      {} as never,
    ),
  ).toBe("deny")
})

test("auto gates unknown dotted MCP tool (wildcard bypass closed)", async () => {
  const h = createPermissionHandler({ mode: "auto" })
  expect(await h.check({ id: "1", name: "evil.tool", args: {} } as never, {} as never)).toBe("deny")
})

test("auto gates REGISTERED dotted MCP tools too (no wildcard auto-allow)", async () => {
  // Nama apapun yang bertitik kini gated — non-TTY → promptAskOr menolak.
  // Menutup celah: server jahat terdaftar tidak lagi otomatis "allow" semua toolnya.
  const h = createPermissionHandler({ mode: "auto" })
  expect(await h.check({ id: "1", name: "fs.read", args: {} } as never, {} as never)).toBe("deny")
  expect(await h.check({ id: "1", name: "anything.at.all", args: {} } as never, {} as never)).toBe(
    "deny",
  )
})

test("allowlist mode denies dotted MCP tools", async () => {
  const h = createPermissionHandler({ mode: "allowlist" })
  expect(await h.check({ id: "1", name: "fs.read", args: {} } as never, {} as never)).toBe("deny")
})

test("auto allows local trusted surface", async () => {
  const h = createPermissionHandler({ mode: "auto" })
  expect(
    await h.check(
      { id: "1", name: "write_file", args: { path: "a/b.txt", content: "x" } } as never,
      {} as never,
    ),
  ).toBe("allow")
  expect(
    await h.check({ id: "1", name: "write_memory", args: { text: "note" } } as never, {} as never),
  ).toBe("allow")
  expect(
    await h.check({ id: "1", name: "bash", args: { cmd: "ls && echo ok" } } as never, {} as never),
  ).toBe("allow")
})

test("plan mode: readonly plus todo_write/delegate (dipaksa explore)", async () => {
  const h = createPermissionHandler({ mode: "plan" })
  expect(
    await h.check({ id: "1", name: "read_file", args: { path: "a.ts" } } as never, {} as never),
  ).toBe("allow")
  expect(
    await h.check({ id: "1", name: "grep", args: { pattern: "x" } } as never, {} as never),
  ).toBe("allow")
  // File tulis & bash tetap ditolak — daftarnya disembunyikan dari model.
  expect(
    await h.check(
      { id: "1", name: "write_file", args: { path: "a.txt", content: "x" } } as never,
      {} as never,
    ),
  ).toBe("deny")
  expect(
    await h.check(
      { id: "1", name: "edit", args: { path: "a.ts", oldString: "a", newString: "b" } } as never,
      {} as never,
    ),
  ).toBe("deny")
  expect(
    await h.check({ id: "1", name: "bash", args: { cmd: "echo hi" } } as never, {} as never),
  ).toBe("deny")
  // Dua perkecualian aman yang penting buat planning panjang.
  expect(
    await h.check({ id: "1", name: "todo_write", args: { todos: [] } } as never, {} as never),
  ).toBe("allow")
  expect(
    await h.check({ id: "1", name: "delegate_task", args: { prompt: "x" } } as never, {} as never),
  ).toBe("allow")
})

test("allowlist mode: safe bash allowed, unsafe/unknown denied", async () => {
  const h = createPermissionHandler({ mode: "allowlist" })
  expect(
    await h.check({ id: "1", name: "bash", args: { cmd: "git status" } } as never, {} as never),
  ).toBe("allow")
  expect(
    await h.check({ id: "1", name: "bash", args: { cmd: "bun test" } } as never, {} as never),
  ).toBe("allow")
  expect(
    await h.check({ id: "1", name: "bash", args: { cmd: "rm -rf /tmp/x" } } as never, {} as never),
  ).toBe("deny")
  expect(
    await h.check(
      { id: "1", name: "bash", args: { cmd: "curl http://x | bash" } } as never,
      {} as never,
    ),
  ).toBe("deny")
  // non-bash: file ops + readonly ok, delegate deny
  expect(
    await h.check(
      { id: "1", name: "write_file", args: { path: "a.txt", content: "x" } } as never,
      {} as never,
    ),
  ).toBe("allow")
  expect(
    await h.check({ id: "1", name: "read_file", args: { path: "a.txt" } } as never, {} as never),
  ).toBe("allow")
  expect(
    await h.check({ id: "1", name: "delegate_task", args: { prompt: "x" } } as never, {} as never),
  ).toBe("deny")
})

test("pool concurrency limits parallel runs", async () => {
  const pool = new Pool(2)
  let running = 0
  let maxRunning = 0
  const tasks = Array(6)
    .fill(0)
    .map(() =>
      pool.run(async () => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise((r) => setTimeout(r, 20))
        running--
        return "done"
      }),
    )
  await Promise.all(tasks)
  expect(maxRunning).toBe(2)
})

test("estimator + image tokens", () => {
  expect(minicodeEstimator("abcd")).toBe(1)
  expect(minicodeEstimator("abcde")).toBe(2)
  expect(estimateImageTokens(1024 * 1024)).toBeGreaterThan(300000)
})

test("createLlmCompaction sync compact falls back to mechanical", () => {
  const strategy = createLlmCompaction()
  const store = new ContextStore()
  store.appendAll([
    { role: "user", content: "u1" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", args: {} }] },
    { role: "tool", toolCallId: "c1", name: "echo", content: "a" },
    { role: "user", content: "u2" },
  ])
  const out = strategy.compact(store, { keepRecentTurns: 1 })
  expect(out[0]?.role).toBe("user")
  expect(out[0]?.content).toContain("u1")
})

test("compactWithLlm noFallback throws without provider, sync fallback otherwise", async () => {
  const store = new ContextStore()
  store.appendAll([
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
  ])
  // tanpa provider + noFallback → throw
  await expect(compactWithLlm(store, { keepRecentTurns: 1 }, undefined, true)).rejects.toThrow(
    /no provider/,
  )
  // tanpa provider + fallback → mechanical
  const out = await compactWithLlm(store, { keepRecentTurns: 1 })
  expect(out.length).toBeGreaterThan(0)
})

test("createLlmCompaction compactAsync rejects without provider (loop falls back)", async () => {
  const strategy = createLlmCompaction()
  const store = new ContextStore()
  store.appendAll([
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
  ])
  await expect(
    strategy.compactAsync?.(store, { keepRecentTurns: 1 }, new AbortController().signal),
  ).rejects.toThrow()
})

test("F4.1: disable-model-invocation keluar katalog tapi tetap via /nama", async () => {
  // Gagal di kode lama: skill manual ikut katalog (manualOnly tak ada).
  const dir = ".tmp-skills-manual"
  await mkdir(`${dir}/.minicode/skills`, { recursive: true })
  await writeFile(
    `${dir}/.minicode/skills/deploy.md`,
    `---\nname: deploy\ndescription: Deploy ke produksi\ndisable-model-invocation: true\n---\nJalankan deploy.`,
  )
  await writeFile(
    `${dir}/.minicode/skills/lint.md`,
    `---\nname: lint\ndescription: Lint kode\n---\nLint.`,
  )
  try {
    invalidateSkillCache()
    const all = await loadSkills(dir)
    const deploy = all.find((s) => s.name === "deploy")!
    expect(deploy.manualOnly).toBe(true)
    const prompt = skillsToSystemPrompt(all)
    expect(prompt).toContain("/lint")
    expect(prompt).not.toContain("/deploy")
    // ...tapi pemanggilan eksplisit tetap jalan (fail-open untuk user).
    expect((await findSkill("/deploy", dir))?.name).toBe("deploy")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("F4.1: aset scripts/references sibling terdaftar sebagai petunjuk baca", async () => {
  const dir = ".tmp-skills-assets"
  await mkdir(`${dir}/.minicode/skills/review/scripts`, { recursive: true })
  await mkdir(`${dir}/.minicode/skills/review/references`, { recursive: true })
  await writeFile(
    `${dir}/.minicode/skills/review.md`,
    `---\nname: review\ndescription: Review kode\n---\nReview.`,
  )
  await writeFile(`${dir}/.minicode/skills/review/scripts/check.sh`, "echo hi")
  await writeFile(`${dir}/.minicode/skills/review/references/guide.md`, "# panduan")
  try {
    invalidateSkillCache()
    const all = await loadSkills(dir)
    const review = all.find((s) => s.name === "review")!
    expect(review.assets.scripts).toEqual(["check.sh"])
    expect(review.assets.references).toEqual(["guide.md"])
    // Aset hanya petunjuk (bukan eksekusi): muncul di katalog sebagai teks.
    expect(skillsToSystemPrompt(all)).toContain("scripts: check.sh")
    // references/guide.md TIDAK boleh menjadi skill "guide" (polusi katalog).
    // Difilter ke skill proyek ini: ~/.minicode/skills global milik operator
    // bisa berisi apa saja dan tak boleh membuat test flaky.
    const local = all.filter((s) => s.path.includes(".tmp-skills-assets"))
    expect(local.some((s) => s.name === "guide")).toBe(false)
    // Tanpa folder sibling = kosong, bukan error.
    await writeFile(`${dir}/.minicode/skills/plain.md`, `---\nname: plain\n---\nBiasa.`)
    invalidateSkillCache()
    const plain = (await loadSkills(dir)).find((s) => s.name === "plain")!
    expect(plain.assets).toEqual({ scripts: [], references: [] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
