// P2.0 — Baseline invariant yang P2 WAJIB pertahankan (CURRENT-INVARIANT).
//
// Setiap test membuktikan satu jaminan existing dari execution path.
// Bila salah satunya merah setelah P2.x, itu REGRESI (bukan gap).

import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSession } from "#minicore/core/index.ts"
import { allowAll, FakeProvider, finish, toolCall } from "#minicore/test/fakes.ts"
import { recordCheckpointFromSnapshots, undoLastCheckpoint } from "../src/session/checkpoint.ts"
import { listPersistedTurns, loadSession, saveSession } from "../src/session/persistence.ts"
import { P2_CLASS, p2Cleanup, p2Cwd, p2Id, p2Msgs, p2ResetIds } from "./helpers/p2.ts"

test(`[${P2_CLASS.CURRENT_INVARIANT}] tool gagal → tercatat sebagai error result, bukan crash senyap`, async () => {
  const gagal = {
    name: "gagal",
    description: "selalu melempar",
    parameters: { type: "object", properties: {} },
    async execute(): Promise<string> {
      throw new Error("alat rusak")
    },
  }
  const session = createSession({
    provider: new FakeProvider([{ events: [toolCall("gagal", {}), finish("tool_calls")] }]),
    permissions: allowAll,
    tools: [gagal] as never,
  })
  // Perilaku aktual (jujur): kegagalan alat direkam sebagai ToolResult
  // isError di dalam turn yang commit — tidak dilempar sebagai crash,
  // tidak hilang, tidak menjadi COMPLETED palsu.
  await session.run("coba")
  type Row = { role: string; isError?: boolean }
  const h = session.state.history as unknown as Row[]
  expect(h.length).toBe(4)
  expect(h[0]!.role).toBe("user")
  expect(h[2]!.role).toBe("tool")
  expect(h[2]!.isError).toBe(true)
})

test(`[${P2_CLASS.CURRENT_INVARIANT}] ghost-turn: save identik ganda tak menambah turn`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2base")
  try {
    const id = p2Id("sess")
    const msgs = p2Msgs(3, "g")
    await saveSession(id, cwd, undefined, msgs, { turns: 1 })
    await saveSession(id, cwd, undefined, msgs, { turns: 1 })
    expect(listPersistedTurns(id, cwd).length).toBe(1)
    expect(loadSession(id, cwd)!.messages.length).toBe(3)
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.CURRENT_INVARIANT}] prefix-append: prefix sama + tumbuh = append inkremental`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2base")
  try {
    const id = p2Id("sess")
    const pendek = p2Msgs(2, "p")
    const panjang = [...pendek, ...p2Msgs(2, "q")]
    await saveSession(id, cwd, undefined, pendek, { turns: 1 })
    await saveSession(id, cwd, undefined, panjang, { turns: 2 })
    expect(loadSession(id, cwd)!.messages.length).toBe(4)
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.CURRENT_INVARIANT}] checkpoint: undo kembalikan berkas tanpa menyentuh DB`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2base")
  try {
    const sid = p2Id("sess")
    const target = join(cwd, "sasaran.txt")
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    writeFileSync(target, "v1")
    await recordCheckpointFromSnapshots(
      sid,
      1,
      [{ path: "sasaran.txt", content: "v1" }],
      "uji",
      cwd,
      [{ path: "sasaran.txt", content: "v2" }],
    )
    writeFileSync(target, "v2")
    const hasil = await undoLastCheckpoint(sid, cwd)
    expect(hasil).not.toBeNull()
    expect(loadSession(sid, cwd)).toBeNull() // DB tak tersentuh checkpoint
  } finally {
    await p2Cleanup(cwd)
  }
})
