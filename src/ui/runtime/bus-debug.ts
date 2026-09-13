import type { UiBus, UiEvent, UiEventType } from "../contract.ts"

// Diagnosis event bus per turn: MINICODE_DEBUG_BUS=1 mencetak satu baris
// ringkas per event bus ke stderr (`[bus] ...`). Dipakai membedakan dua
// penyebab "macet" yang gejalanya identik: (a) event yatim turn lama yang
// bocor ke sesi prompt baru (pagar turn di runPromptWithVerify seharusnya
// membuatnya hening — bila dump tetap menunjukkan event, pagarnya yang bocor),
// vs (b) stdin yang benar-benar mati (dump hening total).
//
// SENGAJA tanpa isi konten: hanya tipe, nama tool, dan PANJANG teks —
// tak ada payload model/tool yang bisa membawa secret ke log. Tanpa env =
// tanpa subscribe sama sekali (zero-cost, zero-noise).
// Dipasang sekali per sesi (bukan per turn) agar justru event yatim pun
// terlihat; dilepas di close().

const MAX_LINE = 300

function summarize(type: string, e: unknown): string {
  try {
    switch (type) {
      case "turn:started": {
        const t = (e as { turn?: unknown }).turn
        return `turn:started #${typeof t === "number" ? t : "?"}`
      }
      case "turn:completed":
        return "turn:completed"
      case "provider:text": {
        const t = (e as { text?: unknown }).text
        return `text ${typeof t === "string" ? t.length : 0}ch`
      }
      case "provider:extension": {
        const k = (e as { kind?: unknown }).kind
        const d = (e as { data?: unknown }).data as { text?: unknown } | undefined
        const n = typeof d?.text === "string" ? d.text.length : 0
        return `ext:${String(k ?? "?")} ${n}ch`
      }
      case "execution:started": {
        const c = (e as { execution?: { call?: { name?: unknown } } }).execution?.call
        return `start:${String(c?.name ?? "?")}`
      }
      case "execution:completed": {
        const x = (
          e as { execution?: { call?: { name?: unknown }; result?: { isError?: unknown } } }
        ).execution
        return `done:${String(x?.call?.name ?? "?")}${x?.result?.isError ? ":err" : ""}`
      }
      case "step:started":
        return "step:started"
      default:
        return type
    }
  } catch {
    return "?"
  }
}

const TYPES: UiEventType[] = [
  "turn:started",
  "turn:completed",
  "provider:text",
  "provider:extension",
  "execution:started",
  "execution:completed",
  "step:started",
]

export function attachBusDebug(bus: UiBus): () => void {
  if (process.env.MINICODE_DEBUG_BUS !== "1") return () => {}
  const offs = TYPES.map((t) =>
    bus.on(t, (e: UiEvent) => {
      try {
        process.stderr.write(`[bus] ${summarize(t, e).slice(0, MAX_LINE)}\n`)
      } catch {}
    }),
  )
  return () => {
    for (const off of offs) {
      try {
        off()
      } catch {}
    }
  }
}
