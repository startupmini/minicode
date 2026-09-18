// Regresi F2 — kebijakan ANSI non-TTY.
// Kontrak: TTY → SGR dipertahankan (renderer mewarnai); non-TTY → semua ANSI
// dibuang agar pipe/CI deterministik. Cerminan colorLevel() (theme.ts) yang
// mengacu stdout.isTTY. Test ini HARUS gagal di kode lama (SGR model lolos
// mentah ke stdout non-TTY — temuan audit F2, MEDIUM).
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import { cleanUntrusted, stripSgr } from "../src/ui/render/sanitize.ts"

const ESC = "\x1b"
const repoRoot = join(import.meta.dir, "..")

function makeFakeBus(): {
  on(type: string, h: (e: never) => void): () => void
  fire(type: string, ev: unknown): void
} {
  const handlers = new Map<string, ((e: never) => void)[]>()
  return {
    on(type: string, h: (e: never) => void): () => void {
      const list = handlers.get(type) ?? []
      list.push(h)
      handlers.set(type, list)
      return () => {}
    },
    fire(type: string, ev: unknown): void {
      for (const h of handlers.get(type) ?? []) h(ev as never)
    },
  }
}

/** Bersihkan state global modul UI (lastTurnText/pendingError/buffer section).
 * Test file ini memakai bus palsu dalam proses yang sama dengan file lain;
 * tanpa ini residu menular ke test yang mengasumsikan buffer/copy kosong pada
 * turn pertama (repl-linear /expand-/copy-pertama). turn:started me-reset
 * ketiganya di handler (simple.ts). */
function resetSharedUiState(): void {
  const bus = makeFakeBus()
  const detach = attachSimpleLogger(bus, {})
  bus.fire("turn:started", { turn: 0 })
  detach()
}

describe("F2: kebijakan ANSI per stream", () => {
  test("TTY: SGR utuh dipertahankan", () => {
    expect(cleanUntrusted(`${ESC}[31mRed${ESC}[0m`, true)).toBe(`${ESC}[31mRed${ESC}[0m`)
  })

  test("non-TTY: SGR model menjadi teks polos", () => {
    expect(cleanUntrusted(`${ESC}[31mRed${ESC}[0m`, false)).toBe("Red")
  })

  test("non-TTY: non-SGR tetap dibuang (kontrak lama utuh)", () => {
    expect(cleanUntrusted(`aman${ESC}[2J${ESC}[Hjahat`, false)).toBe("amanjahat")
  })

  test("stripSgr hanya menyentuh SGR", () => {
    expect(stripSgr(`a${ESC}[1;32mb${ESC}[0mc`)).toBe("abc")
    expect(stripSgr("polos")).toBe("polos")
  })

  test("teks polos identik di kedua kebijakan", () => {
    expect(cleanUntrusted("halo dunia", true)).toBe("halo dunia")
    expect(cleanUntrusted("halo dunia", false)).toBe("halo dunia")
  })
})

describe("F2: cabang TTY tidak over-strip", () => {
  test("TTY: SGR model tetap lolos end-to-end", () => {
    const prev = process.stdout.isTTY
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    const chunks: string[] = []
    const prevWrite = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      chunks.push(String(s))
      return true
    }
    try {
      const bus = makeFakeBus()
      const detach = attachSimpleLogger(bus, {})
      bus.fire("turn:started", { turn: 0 })
      bus.fire("provider:text", { text: `${ESC}[32mHijau${ESC}[0m\n` })
      bus.fire("turn:completed", {})
      detach()
      expect(chunks.join("")).toContain(`${ESC}[32mHijau`)
    } finally {
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = prevWrite
      Object.defineProperty(process.stdout, "isTTY", { value: prev, configurable: true })
      resetSharedUiState()
    }
  })

  test("TTY: aliran campur (teks+tool+reasoning+compaction) tanpa crash", () => {
    const prev = process.stdout.isTTY
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    const prevWrite = process.stdout.write.bind(process.stdout)
    let n = 0
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = () => {
      n++
      return true
    }
    try {
      const bus = makeFakeBus()
      const detach = attachSimpleLogger(bus, {})
      bus.fire("turn:started", { turn: 0 })
      bus.fire("provider:text", { text: `${ESC}[1mJudul${ESC}[0m\n` })
      bus.fire("provider:extension", { kind: "reasoning", data: { text: "pikir\n" } })
      bus.fire("execution:started", {
        execution: {
          call: { id: "1", name: "bash", args: { cmd: "ls" } },
          result: { role: "tool", toolCallId: "1", name: "bash", content: "" },
        },
      })
      bus.fire("execution:completed", {
        execution: {
          call: { id: "1", name: "bash", args: { cmd: "ls" } },
          result: { role: "tool", toolCallId: "1", name: "bash", content: "a\n" },
        },
      })
      bus.fire("context:compacted", { reason: "pressure:high:no-op" })
      bus.fire("turn:completed", {})
      detach()
      expect(n).toBeGreaterThan(0)
    } finally {
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = prevWrite
      Object.defineProperty(process.stdout, "isTTY", { value: prev, configurable: true })
      resetSharedUiState()
    }
  })
})
describe("F2: pipe nyata (proses anak, stdout bukan TTY)", () => {
  test("stdout anak tanpa ESC[ untuk teks model ber-SGR", () => {
    // Fixture memakai attachSimpleLogger asli lalu mencetak provider:text
    // ber-SGR; stdout-nya di-pipe sehingga isTTY false di dalam anak.
    const r = spawnSync("bun", ["test/fixtures/pipe-model-render.ts"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("Red")
    expect(r.stdout).toContain("polos")
    expect(r.stdout).not.toContain(`${ESC}[`)
  })
})
