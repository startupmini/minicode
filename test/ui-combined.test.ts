// Verifikasi konsolidasi: F1 + F2-TTY + chrome reconcile sebagai SATU sistem.
// Satu stdout mock, satu sesi: teks model terfragmentasi per-byte + tool +
// resize + present. Invarian gabungan: teks model faithful, footer tunggal
// per geometri, nol korupsi literal — dalam kondisi TTY (SGR dipertahankan).
import { afterEach, describe, expect, test } from "bun:test"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { createFooterChrome } from "../src/ui/runtime/chrome.ts"
import { installFakeTty } from "./helpers/tui-harness.ts"

const ESC = "\x1b"
const prevFooter = process.env.MINICODE_FOOTER

let tty: ReturnType<typeof installFakeTty> | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
  if (prevFooter === undefined) delete process.env.MINICODE_FOOTER
  else process.env.MINICODE_FOOTER = prevFooter
})

function makeBus(): {
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

const cup = (out: string, row: number): number => out.split(`${ESC}[${row};1H`).length - 1

describe("konsolidasi UI: stream terfragmentasi + tool + resize + footer", () => {
  test("satu sistem: teks faithful, SGR utuh, footer tunggal", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 80 })
    const t = tty
    const status = () => ({ mode: "auto", model: "m", cwd: "w" })
    const ch = createFooterChrome({ enabled: true, status })
    const bus = makeBus()
    const detachLogger = attachSimpleLogger(bus, {})

    ch.present()
    bus.fire("turn:started", { turn: 0 })
    // SGR dibelah PER-BYTE di tengah turn aktif ber-footer.
    const frag = `${ESC}[32mHijau${ESC}[0m\n`
    for (const ch2 of frag) bus.fire("provider:text", { text: ch2 })
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
    bus.fire("turn:completed", {})
    const phase1 = t.chunks().join("")
    const errPhase1 = t.allErr()
    t.clear()

    // Resize + idle berikutnya: footer lama boleh yatim-scrollback, tetapi
    // frame hidup tepat satu dan teks turn tak tersentuh.
    t.resize(80, 20)
    ch.present()
    const phase2 = t.chunks().join("")
    t.clear()

    detachLogger()
    ch.detach()
    // Bersihkan state global modul (turn:started me-reset ketiganya).
    const bus2 = makeBus()
    const d2 = attachSimpleLogger(bus2, {})
    bus2.fire("turn:started", { turn: 99 })
    d2()

    // F1+F2-TTY: SGR tersambung utuh (bukan literal), teks tepat-1x.
    expect(phase1).toContain(`${ESC}[32mHijau`)
    expect(stripAnsi(phase1).split("Hijau").length - 1).toBe(1)
    // Ledger tool di stderr (kontrak I2: stdout/stderr terpisah).
    expect(errPhase1).toContain("›")
    // Chrome: susut 30→20 tanpa byte ke baris yatim; resize + present
    // masing-masing tepat 1 paint di 19/20 (paint ulang identik, tanpa erase).
    expect(cup(phase2, 29)).toBe(0)
    expect(cup(phase2, 30)).toBe(0)
    expect(cup(phase2, 19)).toBe(2)
    expect(cup(phase2, 20)).toBe(2)
  })
})
