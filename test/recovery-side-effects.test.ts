// AUDIT #08 — Idempotency per operasi: taksonomi terbukti (§2), bukan asumsi.
//
// Peta kelas: A inheren (read-only) · B aplikasi (deduplin eksplisit) ·
// C kondisional (aman di kondisi tertentu) · D non-idempoten ·
// E unknown (tidak diklaim). Setiap test mengunci kelas aktualnya.

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"
import { readMemoryFile } from "../src/memory/files.ts"
import { addMemory, getMemoryStats } from "../src/memory/vector.ts"
import { runVerify } from "../src/policy/verifier.ts"
import { removeProvider, saveProvider } from "../src/providers/provision.ts"
import { appendMutationIntent, decideRecovery, loadJournal } from "../src/session/journal.ts"
import { deleteFileTool } from "../src/tools/delete_file.ts"
import { editTool } from "../src/tools/edit.ts"
import { gitCommitTool } from "../src/tools/git.ts"
import { forgetMemoryTool } from "../src/tools/memory.ts"
import { moveFileTool } from "../src/tools/move_file.ts"
import { writeFileTool } from "../src/tools/write_file.ts"

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-rec08fx-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

const ctxFor = (dir: string) => ({ cwd: dir, signal: AbortSignal.timeout(20000) }) as never

// ── §12 Filesystem ──

test("§12 [B] write_file konten sama dua kali = konten sama (idempoten)", async () => {
  const dir = tmpRoot()
  try {
    const ctx = ctxFor(dir)
    await writeFileTool.execute({ path: "a.txt", content: "sama" }, ctx)
    await writeFileTool.execute({ path: "a.txt", content: "sama" }, ctx)
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("sama")
  } finally {
    cleanup(dir)
  }
})

test("§12 [C] edit sesudah sukses: retry GAGAL aman (tanpa efek ganda)", async () => {
  const dir = tmpRoot()
  try {
    const ctx = ctxFor(dir)
    writeFileSync(join(dir, "b.txt"), "v1")
    await editTool.execute({ path: "b.txt", oldString: "v1", newString: "v2" }, ctx)
    // Retry buta dengan oldString sama: oldString sudah hilang → tolak,
    // bukan tulis ganda. Ini arah aman untuk replay tak disengaja.
    await expect(
      editTool.execute({ path: "b.txt", oldString: "v1", newString: "v2" }, ctx),
    ).rejects.toThrow()
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("v2")
  } finally {
    cleanup(dir)
  }
})

test("§12 [C] move A→B lalu retry: tolak, B utuh", async () => {
  const dir = tmpRoot()
  try {
    const ctx = ctxFor(dir)
    writeFileSync(join(dir, "a.txt"), "isi")
    await moveFileTool.execute({ from: "a.txt", to: "b.txt" }, ctx)
    await expect(moveFileTool.execute({ from: "a.txt", to: "b.txt" }, ctx)).rejects.toThrow()
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("isi")
  } finally {
    cleanup(dir)
  }
})

test("§12 [C] delete lalu retry: tolak, tak ada efek baru", async () => {
  const dir = tmpRoot()
  try {
    const ctx = ctxFor(dir)
    writeFileSync(join(dir, "h.txt"), "x")
    await deleteFileTool.execute({ path: "h.txt" }, ctx)
    await expect(deleteFileTool.execute({ path: "h.txt" }, ctx)).rejects.toThrow()
    expect(existsSync(join(dir, "h.txt"))).toBe(false)
  } finally {
    cleanup(dir)
  }
})

// ── §10 Memory: identitas = UUID per tulis (D, non-idempoten) ──

test("§10 [D] write_memory sama dua kali = dua baris (pin perilaku, bukan janji)", async () => {
  const dir = tmpRoot()
  const text = `fakta-unik-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    // Jalur tulis persis seperti writeMemoryTool (file + vektor), tetapi
    // tanpa embedding jaringan (keyword-only) agar hermetic.
    const { appendMemory } = await import("../src/memory/files.ts")
    await appendMemory(text, dir)
    await addMemory(text, { cwd: dir })
    await appendMemory(text, dir)
    await addMemory(text, { cwd: dir })
    const fileHits = (await readMemoryFile(dir)).split("\n").filter((l) => l.includes(text))
    expect(fileHits).toHaveLength(2)
    // Retrieval menduplikat (MMR exact-text) sehingga ganda tak meracuni
    // baca — tetapi baris file ganda adalah fakta (retry tak didedup).
    expect(getMemoryStats(dir).rows).toBeGreaterThanOrEqual(2)
  } finally {
    cleanup(dir)
  }
})

test("§10 forget menghapus SEMUA duplikat (jalur pulih bekerja)", async () => {
  const dir = tmpRoot()
  const text = `lupa-ini-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    const { appendMemory } = await import("../src/memory/files.ts")
    await appendMemory(text, dir)
    await addMemory(text, { cwd: dir })
    await appendMemory(text, dir)
    await addMemory(text, { cwd: dir })
    const out = (await forgetMemoryTool.execute({ query: text }, ctxFor(dir))) as string
    expect(out).toMatch(/deleted [2-9]/)
    expect((await readMemoryFile(dir)).includes(text)).toBe(false)
  } finally {
    cleanup(dir)
  }
})

// ── §11 Config/auth: corrupt = backup + gagal keras (P1 fix) ──

function writeLocalConfig(dir: string, obj: unknown): string {
  const p = join(dir, ".minicode", "config.json")
  writeFileSync(p, JSON.stringify(obj), "utf8")
  return p
}

const GOOD_LOCAL = {
  providers: [
    { id: "p1", baseUrl: "https://a/v1", apiKey: "k", models: ["m"] },
    { id: "p2", baseUrl: "https://b/v1", apiKey: "k", models: ["m"] },
  ],
  mcpServers: [{ id: "s", command: "echo" }],
  verifyCommand: "bun test",
}

test("§11 saveProvider berkas korup: throw + backup + entri lain selamat", async () => {
  const dir = tmpRoot()
  try {
    const p = writeLocalConfig(dir, GOOD_LOCAL)
    writeFileSync(p, `${readFileSync(p, "utf8")}{RUSAK`, "utf8")
    await expect(
      saveProvider(
        { id: "p3", baseUrl: "https://c/v1", apiKey: "k", models: ["m"] },
        {
          global: false,
          cwd: dir,
        },
      ),
    ).rejects.toThrow(/config corrupt/)
    // Berkas asli tak ditimpa (masih korup = bukti utuh untuk operator).
    expect(readFileSync(p, "utf8")).toContain("{RUSAK")
    // Backup tersedia.
    expect(readdirSync(join(dir, ".minicode")).some((f) => f.includes(".corrupt."))).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("§11 removeProvider berkas korup: throw, tak menghapus apa pun", async () => {
  const dir = tmpRoot()
  try {
    const p = writeLocalConfig(dir, GOOD_LOCAL)
    writeFileSync(p, `${readFileSync(p, "utf8")}{RUSAK`, "utf8")
    await expect(removeProvider("p1", { global: false, cwd: dir })).rejects.toThrow(
      /config corrupt/,
    )
    expect(readFileSync(p, "utf8")).toContain("{RUSAK")
  } finally {
    cleanup(dir)
  }
})

test("§11 saveProvider tanpa berkas (ENOENT): buat baru normal", async () => {
  const dir = tmpRoot()
  try {
    await saveProvider(
      { id: "baru", baseUrl: "https://n/v1", apiKey: "k", models: ["m"] },
      {
        global: false,
        cwd: dir,
      },
    )
    const cfg = await loadConfig(dir, { allowLocal: true })
    expect(cfg.providers.some((x) => x.id === "baru")).toBe(true)
  } finally {
    cleanup(dir)
  }
})

// ── §14 Git: retry setelah sukses = bukti, bukan commit ganda (P1 fix) ──

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0

function makeGitRepo(): { repo: string; abs: string } {
  // Repo bersarang DI DALAM workspace (jail git_commit) + .tmp-*/ diabaikan
  // .gitignore — pola yang sama dengan phase4-auth-git-pricing.test.ts.
  const repo = `.tmp-rec08-git-${Math.random().toString(36).slice(2, 8)}`
  const abs = join(process.cwd(), repo)
  mkdirSync(abs, { recursive: true })
  const git = (a: string[]) => spawnSync("git", a, { cwd: abs, encoding: "utf8" })
  git(["init", "-q"])
  git(["config", "user.email", "t@e.c"])
  git(["config", "user.name", "t"])
  git(["config", "commit.gpgsign", "false"])
  writeFileSync(join(abs, "a.txt"), "v1")
  git(["add", "-A"])
  git(["commit", "-qm", "init"])
  return { repo, abs }
}

function gitLog(abs: string): string {
  return spawnSync("git", ["log", "--oneline"], { cwd: abs, encoding: "utf8" }).stdout
}

describe.skipIf(!gitAvailable)("§14 git_commit idempotency", () => {
  test("retry setelah sukses: 'already committed' + SHA, tetap 1 commit", async () => {
    const { repo, abs } = makeGitRepo()
    try {
      const ctx = ctxFor(process.cwd())
      writeFileSync(join(abs, "b.txt"), "baru")
      const r1 = (await gitCommitTool.execute(
        { message: "tambah b", paths: ["b.txt"], cwd: repo },
        ctx,
      )) as string
      expect(r1).toContain("HEAD:")
      // Retry buta (response lost): tanpa commit baru + SHA pulih.
      const r2 = (await gitCommitTool.execute(
        { message: "tambah b", paths: ["b.txt"], cwd: repo },
        ctx,
      )) as string
      expect(r2).toContain("already committed")
      expect(r2).toMatch(/[0-9a-f]{7,}/)
      expect(
        gitLog(abs)
          .split("\n")
          .filter((l) => l.includes("tambah b")),
      ).toHaveLength(1)
    } finally {
      cleanup(abs)
    }
  })

  test("pesan beda + tree bersih: tanpa klaim palsu", async () => {
    const { repo, abs } = makeGitRepo()
    try {
      const ctx = ctxFor(process.cwd())
      const r = (await gitCommitTool.execute(
        { message: "bukan ini pesannya", all: true, cwd: repo },
        ctx,
      )) as string
      expect(r).toMatch(/nothing to commit/i)
      expect(r).not.toContain("already committed")
    } finally {
      cleanup(abs)
    }
  })
})

test("§13 [D/E] bash tanpa terminal = pending ambigu (unknown ≠ gagal)", async () => {
  const dir = tmpRoot()
  try {
    // Crash/tewas setelah intent: tak ada terminal → attention, bukan
    // sukses-bisnismaupun gagal-bersih. Tak ada retry otomatis di mana pun
    // (executor tanpa retry — struktural; mekanisme ini buktinya).
    await appendMutationIntent({ session: "b", tool: "bash", cwd: dir, turn: 0 })
    const plan = decideRecovery((await loadJournal("b", dir)).records, [])
    expect(plan.clean).toBe(false)
    expect(plan.attention).toHaveLength(1)
    expect(plan.directive).toContain("DILARANG redo buta")
  } finally {
    cleanup(dir)
  }
})

// ── §29 Verify: deterministik + observasional (tanpa jurnal) ──

test("§29 verify deterministik dua kali + tak mencemari jurnal", async () => {
  const dir = tmpRoot()
  try {
    const cmd = `${process.execPath} -e "process.exit(0)"`
    const r1 = await runVerify(cmd, dir)
    const r2 = await runVerify(cmd, dir)
    expect(r1.ok).toBe(true)
    expect(r2).toEqual(r1)
    // Verify bukan tool: tak ada intent/terminal yang tercatat untuknya.
    expect(readdirSync(join(dir, ".minicode")).some((f) => f.startsWith("journal-"))).toBe(false)
  } finally {
    cleanup(dir)
  }
})

// ── §33 Transisi flag local-config eksplisit, tanpa sticky ──

test("§33 mati→nyala→mati: eksplisit tiap load, tanpa status menempel", async () => {
  const dir = tmpRoot()
  try {
    writeLocalConfig(dir, GOOD_LOCAL)
    // Tanpa flag, config lokal diabaikan — provider lokal (p1/p2) tak terbaca.
    // Global mungkin ada isinya (10 provider di mesin dev), jadi cek
    // ketidakhadiran id lokal, bukan panjang 0 yang rapuh.
    {
      const cfg = await loadConfig(dir)
      expect(cfg.providers.some((p) => p.id === "p1" || p.id === "p2")).toBe(false)
      expect((cfg.mcpServers ?? []).some((s) => s.id === "s")).toBe(false)
    }
    {
      const cfg = await loadConfig(dir, { allowLocal: true })
      expect(cfg.providers.filter((p) => p.id === "p1" || p.id === "p2")).toHaveLength(2)
    }
    // "Restart" (load segar tanpa flag) kembali bersih — flag tak sticky
    // di modul, sesi, atau berkas.
    {
      const cfg = await loadConfig(dir)
      expect(cfg.providers.some((p) => p.id === "p1" || p.id === "p2")).toBe(false)
      expect((cfg.mcpServers ?? []).some((s) => s.id === "s")).toBe(false)
    }
  } finally {
    cleanup(dir)
  }
})
