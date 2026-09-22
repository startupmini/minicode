import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProviderError } from "#minicore/core/errors.ts"
import type { ModelProvider, ProviderEvent, StreamRequest } from "#minicore/core/provider.ts"
import type { Message } from "#minicore/core/types.ts"
import { inspectBashCommand } from "../src/policy/bash-guard.ts"
import { compactWithLlm } from "../src/policy/compaction.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"
import { pricingCachePath } from "../src/policy/pricing.ts"
import { toAnthropicMessages } from "../src/providers/anthropic.ts"
import { createRouterProvider } from "../src/providers/router.ts"
import {
  loadCheckpointManifest,
  reconcileUndoRedoPointer,
  recordCheckpointFromSnapshots,
  saveCheckpointManifest,
  undoLastCheckpoint,
} from "../src/session/checkpoint.ts"
import { allTools } from "../src/tools/index.ts"
import {
  clearSubmittedResult,
  getSubmittedResult,
  submitResultTool,
} from "../src/tools/submit_result.ts"

// ══════════════════════════════════════════════════════════════════
// 1. Checkpoint Pointer Reconciliation on Undo (newIndex >= 0)
// ══════════════════════════════════════════════════════════════════

describe("audit regresi: rekonsiliasi pointer checkpoint", () => {
  test("reconcileUndoRedoPointer memulihkan pointer undo pada newIndex >= 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-audit-cp-"))
    const sid = "audit-sess-1"
    try {
      // Buat 3 checkpoint (turn 1, 2, 3)
      writeFileSync(join(dir, "a.txt"), "1", "utf8")
      await recordCheckpointFromSnapshots(sid, 1, [{ path: "a.txt", content: null }], "t1", dir, [
        { path: "a.txt", content: "1" },
      ])
      writeFileSync(join(dir, "a.txt"), "2", "utf8")
      await recordCheckpointFromSnapshots(sid, 2, [{ path: "a.txt", content: "1" }], "t2", dir, [
        { path: "a.txt", content: "2" },
      ])
      writeFileSync(join(dir, "a.txt"), "3", "utf8")
      await recordCheckpointFromSnapshots(sid, 3, [{ path: "a.txt", content: "2" }], "t3", dir, [
        { path: "a.txt", content: "3" },
      ])

      const mInit = await loadCheckpointManifest(sid, dir)
      expect(mInit.currentIndex).toBe(2)

      // Lakukan undo: turn 3 dibatalkan, currentIndex menjadi 1
      const undoRes = await undoLastCheckpoint(sid, dir)
      expect(undoRes.success).toBe(true)

      // Simulasikan crash sebelum manifest tersimpan (pointer basi kembali ke 2)
      const mStale = await loadCheckpointManifest(sid, dir)
      mStale.currentIndex = 2
      await saveCheckpointManifest(mStale, dir)

      // Rekonsiliasi harus mencocokkan targetTurn (3) dengan checkpoint[newIndex + 1 = 2],
      // bukan checkpoint[newIndex = 1].
      const rep = await reconcileUndoRedoPointer(sid, dir)
      expect(rep).toMatchObject({
        repaired: true,
        from: 2,
        to: 1,
        kind: "undo",
      })

      const mFixed = await loadCheckpointManifest(sid, dir)
      expect(mFixed.currentIndex).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// 2. Router Fallback Mid-Stream (Anti-Duplication)
// ══════════════════════════════════════════════════════════════════

describe("audit regresi: router streaming fallback", () => {
  test("menolak fallback bila hasYieldedContent === true (cegah duplikasi teks)", async () => {
    const p1: ModelProvider = {
      id: "p1",
      models: ["model-x"],
      async *stream(_req: StreamRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: "text", text: "Sebagian respons yang sudah terkirim..." }
        throw new ProviderError("network", "koneksi putus di tengah stream")
      },
    }

    let p2Called = false
    const p2: ModelProvider = {
      id: "p2",
      models: ["model-x"],
      async *stream(_req: StreamRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        p2Called = true
        yield { type: "text", text: "Respons dari provider kedua" }
      },
    }

    const router = createRouterProvider({
      providers: [p1, p2],
      defaultProviderId: "p1",
    })

    const req: StreamRequest = {
      model: "model-x",
      messages: [{ role: "user", content: "Halo" }],
    }

    const events: ProviderEvent[] = []
    let caughtError: unknown
    try {
      for await (const ev of router.stream(req, new AbortController().signal)) {
        events.push(ev)
      }
    } catch (e) {
      caughtError = e
    }

    // Teks awal p1 sempat keluar
    expect(
      events.some((e) => e.type === "text" && (e as { text: string }).text.includes("Sebagian")),
    ).toBe(true)
    // Error dilempar keluar dan p2 TIDAK dipanggil (tidak menduplikasi jawaban dari awal)
    expect(caughtError).toBeInstanceOf(ProviderError)
    expect(p2Called).toBe(false)
  })

  test("mengizinkan fallback jika error terjadi sebelum yield konten apa pun", async () => {
    const p1: ModelProvider = {
      id: "p1",
      models: ["model-x"],
      async *stream(_req: StreamRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        if (_signal.aborted) yield { type: "text", text: "" }
        throw new ProviderError("network", "gagal koneksi awal")
      },
    }

    let p2Called = false
    const p2: ModelProvider = {
      id: "p2",
      models: ["model-x"],
      async *stream(_req: StreamRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        p2Called = true
        yield { type: "text", text: "Berhasil dari p2" }
      },
    }

    const router = createRouterProvider({
      providers: [p1, p2],
      defaultProviderId: "p1",
    })

    const req: StreamRequest = {
      model: "model-x",
      messages: [{ role: "user", content: "Halo" }],
    }

    const events: ProviderEvent[] = []
    for await (const ev of router.stream(req, new AbortController().signal)) {
      events.push(ev)
    }

    expect(p2Called).toBe(true)
    expect(
      events.some((e) => e.type === "text" && (e as { text: string }).text === "Berhasil dari p2"),
    ).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════
// 3. Permission Jail: read_image
// ══════════════════════════════════════════════════════════════════

describe("audit regresi: universal jail untuk read_image", () => {
  test("read_image di luar workspace ditolak dengan alasan jail", async () => {
    const root = mkdtempSync(join(tmpdir(), "mc-audit-perm-"))
    try {
      const handler = createPermissionHandler({ mode: "allow-all", root })
      const outsideCall = { id: "c1", name: "read_image", args: { path: "../rahasia.png" } }
      const dec1 = await handler.check(outsideCall, {} as never)
      expect(dec1).toBe("deny")
      expect(handler.describeDenial?.(outsideCall)).toBe("jail: outside workspace")

      const sensitiveCall = { id: "c2", name: "read_image", args: { path: join(root, ".env") } }
      const dec2 = await handler.check(sensitiveCall, {} as never)
      expect(dec2).toBe("deny")
      expect(handler.describeDenial?.(sensitiveCall)).toBe("jail: sensitive file")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// 4. Bash Guard: Windows / PowerShell Rules
// ══════════════════════════════════════════════════════════════════

describe("audit regresi: bash guard Windows / PowerShell", () => {
  test("mencegah referensi variabel rahasia style PowerShell ($env:KEY) dan CMD (%KEY%)", () => {
    const v1 = inspectBashCommand("Write-Output $env:OPENAI_API_KEY")
    expect(v1.denied).toBe(true)
    expect(v1.reason).toBe("credential env reference")

    const v2 = inspectBashCommand("echo %ANTHROPIC_API_KEY%")
    expect(v2.denied).toBe(true)
    expect(v2.reason).toBe("credential env reference")
  })

  test("mencegah pembacaan berkas sensitif lewat PowerShell gc", () => {
    const v = inspectBashCommand("gc .env")
    expect(v.denied).toBe(true)
    expect(v.reason).toBe("sensitive file access")
  })

  test("mencegah dump env lewat PowerShell dir env: dan Get-ChildItem env:", () => {
    const v1 = inspectBashCommand("dir env:")
    expect(v1.denied).toBe(true)
    expect(v1.reason).toBe("environment dump")

    const v2 = inspectBashCommand("Get-ChildItem env:")
    expect(v2.denied).toBe(true)
    expect(v2.reason).toBe("environment dump")
  })
})

// ══════════════════════════════════════════════════════════════════
// 5. Submit Result Isolation & Subagent Exclusion
// ══════════════════════════════════════════════════════════════════

describe("audit regresi: isolasi submit_result", () => {
  test("clearSubmittedResult mengosongkan state antar run", async () => {
    await submitResultTool.execute({ result: { status: "completed" }, summary: "Semua selesai" }, {
      signal: new AbortController().signal,
    } as never)
    expect(getSubmittedResult()).toMatchObject({
      result: { status: "completed" },
      summary: "Semua selesai",
    })

    clearSubmittedResult()
    expect(getSubmittedResult()).toBeNull()
  })

  test("subagent tidak memiliki tool submit_result", () => {
    // Sesuai filter di task.ts, submit_result dikeluarkan dari daftar base tool subagent
    const subToolNames = allTools
      .filter(
        (t) =>
          ![
            "delegate_task",
            "write_memory",
            "forget_memory",
            "todo_write",
            "bash_output",
            "bash_kill",
            "git_commit",
            "submit_result",
          ].includes(t.name),
      )
      .map((t) => t.name)

    expect(subToolNames).not.toContain("submit_result")
  })
})

// ══════════════════════════════════════════════════════════════════
// 6. Anthropic Serializer User Role Alternation
// ══════════════════════════════════════════════════════════════════

describe("audit regresi: serializer Anthropic role alternation", () => {
  test("toAnthropicMessages menyatukan pesan user berturut-turut", () => {
    const messages: Message[] = [
      { role: "user", content: "Pesan satu" },
      { role: "user", content: "Pesan dua" },
    ]
    const out = toAnthropicMessages(messages) as { role: string; content: unknown[] }[]
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe("user")
    expect(out[0]?.content).toEqual([
      { type: "text", text: "Pesan satu" },
      { type: "text", text: "Pesan dua" },
    ])
  })
})

// ══════════════════════════════════════════════════════════════════
// 7. Pricing Cache Path Respects MINICODE_HOME
// ══════════════════════════════════════════════════════════════════

describe("audit regresi: pricingCachePath menghormati MINICODE_HOME", () => {
  test("pricingCachePath mengevaluasi lokasi dinamis sesuai MINICODE_HOME", () => {
    const oldHome = process.env.MINICODE_HOME
    const custom = join(tmpdir(), "custom-minicode-home")
    try {
      process.env.MINICODE_HOME = custom
      const p = pricingCachePath()
      expect(p).toBe(join(custom, ".minicode", "pricing.json"))
    } finally {
      if (oldHome === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = oldHome
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// 8. Multi-turn Compaction Combines Prior Summary
// ══════════════════════════════════════════════════════════════════

describe("audit regresi: kompaksi multi-turn anti-drift", () => {
  test("compactWithLlm menggabungkan prior summary lama dan baru menjadi satu pesan user", async () => {
    const mockProvider: ModelProvider = {
      id: "fake-compact",
      models: ["deepseek-chat"],
      async *stream() {
        yield { type: "text", text: "Ringkasan baru turn 3-4" }
        yield { type: "finish", reason: "stop" }
      },
    }

    const messages: Message[] = [
      {
        role: "user",
        content: "Previous context (LLM summarized):\nRingkasan lama turn 1-2",
      },
      { role: "user", content: "Pertanyaan 3" },
      { role: "assistant", content: "Jawaban 3" },
      { role: "user", content: "Pertanyaan 4" },
      { role: "assistant", content: "Jawaban 4" },
      { role: "user", content: "Pertanyaan 5" },
      { role: "assistant", content: "Jawaban 5" },
    ]

    const store = { messages } as never
    const out = await compactWithLlm(store, {
      keepRecentTurns: 1,
      provider: mockProvider,
      model: "deepseek-chat",
    })

    // out[0] harus merupakan satu pesan user yang menggabungkan kedua ringkasan (tanpa penumpukan prior terpisah)
    expect(out[0]?.role).toBe("user")
    const content = String(out[0]?.content)
    expect(content).toContain("Ringkasan lama turn 1-2")
    expect(content).toContain("Ringkasan baru turn 3-4")
    // out[1] adalah pesan yang dipertahankan (Pertanyaan 5), bukan ringkasan kedua
    expect(String(out[1]?.content)).toBe("Pertanyaan 5")

    // Saat dikonversi ke format Anthropic, toAnthropicMessages menyatukan blok
    // user yang berdampingan sehingga roles strictly alternate
    const anthropicMsgs = toAnthropicMessages(out) as { role: string }[]
    for (let i = 0; i < anthropicMsgs.length - 1; i++) {
      expect(anthropicMsgs[i]?.role).not.toBe(anthropicMsgs[i + 1]?.role)
    }
  })
})
