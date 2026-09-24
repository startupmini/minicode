// Fase 4 Presentasi V2.1 — query API /expand <id> (store) ≠ transcript view.
//
// Kenapa file terpisah: plan §25 — "query API ≠ transcript view"; test ini
// menguji expandContent dari CliSession (adapter → store) tanpa TUI.
//
// Yang dijaga:
// · konten completed → store (adapter put)
// · receipt file.changed join (paths+journalSeq)
// · expand buka-ulang identik (bukan sekali-habis)
// · flag OFF = path lama bit-identik (takeBufferedSections tetap)

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike } from "../src/presentation/events.ts"
import { createContentStore } from "../src/presentation/store.ts"
import {
  bufferSection,
  getBufferedSections,
  resetBufferedSections,
} from "../src/ui/render/collapse.ts"

function fakeBus(): EventBusLike & {
  emit: (type: string, payload: unknown) => void
} {
  const handlers = new Map<string, Set<(e: any) => void>>()
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<(e: any) => void>()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    emit(type, payload) {
      const set = handlers.get(type)
      if (set) for (const h of [...set]) h(payload)
    },
  }
}

let bus: ReturnType<typeof fakeBus>
let store: ReturnType<typeof createContentStore>
let adapter: ReturnType<typeof createPresentationAdapter>
let events: DomainEvent[]

beforeEach(() => {
  bus = fakeBus()
  store = createContentStore()
  adapter = createPresentationAdapter(bus, { sessionId: "s1", contentStore: store })
  events = []
  adapter.onEvent((e) => events.push(e))
  resetBufferedSections()
})

afterEach(() => {
  adapter.dispose()
  resetBufferedSections()
  delete process.env.MINICODE_PRESENTATION_V2
})

const execDone = (id: string, content: string, isError = false) => ({
  execution: {
    call: { id, name: "read_file", args: { path: "a.ts" } },
    result: { isError, content },
  },
})

describe("expand query: adapter → store", () => {
  test("tool completed → konten masuk store, expand buka-ulang identik", () => {
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", execDone("c1", ""))
    bus.emit("execution:completed", execDone("c1", "isi file utuh"))
    const first = store.expand("c1")
    const second = store.expand("c1")
    expect(first[0]!.text).toBe("isi file utuh")
    expect(first).toEqual(second)
    expect(first[0]!.meta.source).toBe("store")
  })

  test("tool failed → konten stderr masuk store", () => {
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", execDone("c1", ""))
    bus.emit("execution:completed", execDone("c1", "exit 1: gagal", true))
    const out = store.expand("c1")
    expect(out[0]!.text).toBe("exit 1: gagal")
    expect(out[0]!.meta.stream).toBe("stderr")
  })

  test("content array (MCP blocks) diekstrak ke teks", () => {
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", execDone("c1", ""))
    bus.emit("execution:completed", {
      execution: {
        call: { id: "c1", name: "mcp.srv.search", args: {} },
        result: {
          isError: false,
          content: [
            { type: "text", text: "baris1" },
            { type: "text", text: "baris2" },
          ],
        },
      },
    })
    expect(store.expand("c1")[0]!.text).toContain("baris1")
    expect(store.expand("c1")[0]!.text).toContain("baris2")
  })

  test("tanpa contentStore — adapter tetap jalan (tanpa put)", () => {
    const bare = createPresentationAdapter(bus, { sessionId: "s1" })
    const got: DomainEvent[] = []
    bare.onEvent((e) => got.push(e))
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", execDone("c1", ""))
    bus.emit("execution:completed", execDone("c1", "isi"))
    expect(got.some((e) => e.type === "tool.completed")).toBe(true)
    bare.dispose()
  })
})

describe("receipt: file.changed join", () => {
  test("noteFileChanged → event file.changed dengan paths+journalSeq", () => {
    bus.emit("turn:started", { turn: 1 })
    adapter.noteFileChanged({
      toolCallId: "c1",
      paths: ["src/a.ts"],
      journalSeq: 42,
    })
    const fc = events.find((e) => e.type === "file.changed")
    expect(fc).toBeTruthy()
    if (fc?.type === "file.changed") {
      expect(fc.toolCallId).toBe("c1")
      expect(fc.paths).toEqual(["src/a.ts"])
      expect(fc.journalSeq).toBe(42)
    }
  })

  test("noteFileChanged tanpa journalSeq — paths tetap", () => {
    adapter.noteFileChanged({ toolCallId: "c1", paths: ["b.ts"] })
    const fc = events.find((e) => e.type === "file.changed")
    expect(fc?.type === "file.changed" && fc.paths).toEqual(["b.ts"])
  })

  test("receipt join di reducer: file.changed → activity.receipt", async () => {
    const { createInitialState, activityKey } = await import("../src/presentation/model.ts")
    const { createReducerDiagnostics, reduce } = await import("../src/presentation/reducer.ts")
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", execDone("c1", ""))
    bus.emit("execution:completed", execDone("c1", "ok"))
    adapter.noteFileChanged({
      toolCallId: "c1",
      paths: ["src/a.ts"],
      journalSeq: 7,
    })
    const state = createInitialState("s1")
    const diag = createReducerDiagnostics()
    for (const e of events) reduce(state, e, diag)
    const a = state.activities.get(activityKey("s1", "c1"))
    expect(a?.receipt?.paths).toEqual(["src/a.ts"])
    expect(a?.receipt?.journalSeq).toBe(7)
    expect(a?.expandRef).toEqual({ toolCallId: "c1", idx: 0 })
  })
})

describe("flag OFF: path lama bit-identik", () => {
  test("bufferSection lama tetap hidup (takeBufferedSections)", () => {
    // Flag tidak mengubah buffer lama — hanya menambah jalur baru.
    delete process.env.MINICODE_PRESENTATION_V2
    bufferSection("read a.ts", "isi buffer", "stderr")
    const sections = getBufferedSections()
    expect(sections).toHaveLength(1)
    expect(sections[0]!.label).toBe("read a.ts")
    expect(sections[0]!.text).toBe("isi buffer")
  })

  test("presentationV2Enabled false saat unset", async () => {
    const { presentationV2Enabled } = await import("../src/presentation/store.ts")
    expect(presentationV2Enabled()).toBe(false)
    process.env.MINICODE_PRESENTATION_V2 = "1"
    expect(presentationV2Enabled()).toBe(true)
  })
})
