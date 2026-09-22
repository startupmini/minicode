import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig, type MinicodeConfig } from "../../src/config.ts"
import { refreshProviderModels } from "../../src/providers/provision.ts"
import { sanitizeAnsiLine } from "../../src/ui/render/sanitize.ts"
import { renderTable } from "../../src/ui/render/table.ts"
import { c, glyphs } from "../../src/ui/render/theme.ts"

interface TraceRow {
  model?: string
  ok?: boolean
  error?: string
  timestamp?: string
}

// 6.3 — health tanpa jaringan: ambil dari traces.jsonl (last run per provider)
function readTraces(cwd?: string): TraceRow[] {
  try {
    return readFileSync(resolve(cwd ?? ".", ".minicode", "traces.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as TraceRow]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export function providerOfTrace(cfg: MinicodeConfig, t: TraceRow): string | undefined {
  const m = t.model ?? ""
  if (m.includes("::")) return m.slice(0, m.indexOf("::"))
  const byModel = cfg.providers.find((p) => p.models.includes(m))
  if (byModel) return byModel.id
  const byId = cfg.providers.find((p) => p.id === m)
  if (byId) return byId.id
  return undefined
}

export function healthMap(
  cfg: MinicodeConfig,
  traces: TraceRow[],
): Map<string, { ok: boolean; model: string; ts: string }> {
  const out = new Map<string, { ok: boolean; model: string; ts: string }>()
  for (const t of traces) {
    const pid = providerOfTrace(cfg, t)
    if (!pid) continue
    const prev = out.get(pid)
    if (prev && prev.ts > (t.timestamp ?? "")) continue
    out.set(pid, { ok: t.ok !== false, model: t.model ?? "-", ts: t.timestamp ?? "" })
  }
  return out
}

export async function handleProviders(
  args: string[],
  getArg: (name: string) => string | undefined,
): Promise<never> {
  const firstArg = args[0]
  if (firstArg !== "providers" && firstArg !== "models" && firstArg !== "sync") {
    process.exit(0)
  }
  const cwdArg = getArg("--cwd")
  // Audit #07: local hanya bila operator opt-in (aturan universal — sync
  // tanpa flag tak boleh menghubungi endpoint repo tak dikenal). argv
  // subcommand diawali positional sehingga pakai includes + env (gaya --local).
  const allowLocal =
    args.includes("--allow-local-config") || process.env.MINICODE_ALLOW_LOCAL_CONFIG === "1"
  const cfg = await loadConfig(cwdArg, { allowLocal })
  if (firstArg === "providers") {
    if (cfg.providers.length === 0) {
      console.log(
        "(no providers yet - run `minicode` for the wizard, `minicode auth login` (free, no API key),\nor `minicode config add --baseUrl <url> --apiKey <key>`)",
      )
      process.exit(0)
    }
    // renderTable menjaga kolom tetap berbaris untuk id sepanjang apa pun;
    // padEnd(16) manual sebelumnya rusak begitu id lebih dari 16 karakter.
    const health = healthMap(cfg, readTraces(cwdArg))
    const rows = cfg.providers.map((p) => {
      const h = health.get(p.id)
      const status = !h
        ? c.dim("not used yet")
        : `${h.ok ? c.green("ok") : c.red("ERR")} ${c.dim(
            h.ts ? new Date(h.ts).toISOString().slice(0, 10) : "-",
          )}`
      return {
        id: c.cyan(p.id),
        models: String(p.models.length),
        url: p.baseUrl,
        status,
      }
    })
    console.log(
      `\n${c.bold("LLM Providers")}\n` +
        renderTable(
          [
            { header: "ID", key: "id", width: 24 },
            { header: "Models", key: "models", width: 6, align: "right" },
            { header: "Base URL", key: "url", width: 34 },
            { header: "Status", key: "status", width: 18 },
          ],
          rows,
        ) +
        "\n",
    )
    console.log(
      `  ${c.dim("next: minicode models | minicode sync | minicode config add --baseUrl <url> --apiKey <key>")}\n`,
    )
    process.exit(0)
  }
  if (firstArg === "models") {
    const pid = args[1] && !args[1]!.startsWith("--") ? args[1] : undefined
    const matchIdx = args.indexOf("--match")
    const filter = (matchIdx >= 0 && args[matchIdx + 1] ? args[matchIdx + 1]! : "").toLowerCase()
    const match = (s: string) => (filter ? s.toLowerCase().includes(filter) : true)
    if (pid) {
      const p = cfg.providers.find((x) => x.id === pid)
      if (!p) {
        console.error(`provider "${sanitizeAnsiLine(pid)}" not found - see: minicode providers`)
        process.exit(1)
      }
      const list = p.models.filter(match)
      if (!list.length) console.log(`  (no matches for "${sanitizeAnsiLine(filter)}")`)
      for (const [i, m] of list.entries()) console.log(`  [${i}] ${sanitizeAnsiLine(m)}`)
    } else {
      if (cfg.providers.length === 0) console.log("(no providers yet)")
      let shown = 0
      for (const p of cfg.providers) {
        const list = p.models.filter(match)
        if (!list.length) continue
        // id/baseUrl dari config (lokal = input repo tak terpercaya); model dari
        // hasil probe jaringan — sanitasi sebelum masuk scrollback.
        console.log(
          `${sanitizeAnsiLine(p.id)} (${sanitizeAnsiLine(p.baseUrl)})${filter ? ` - matches "${sanitizeAnsiLine(filter)}"` : ""}`,
        )
        shown += list.length
        for (const m of list.slice(0, 10)) console.log(`  ${sanitizeAnsiLine(m)}`)
        if (filter && list.length > 10) console.log(`  … +${list.length - 10} more`)
        if (!filter && p.models.length > 10) console.log(`  … +${p.models.length - 10} more`)
      }
      // Header provider hanya bila ada yang cocok — tanpa ini filter kosong
      // mencetak judul lalu "(no matches)", dua baris untuk nol informasi.
      if (filter && shown === 0) console.log(`  (no matches for "${sanitizeAnsiLine(filter)}")`)
    }
    process.exit(0)
  }
  if (firstArg === "sync") {
    console.log("Syncing model list from providers…")
    const { updated, failed } = await refreshProviderModels({ cwd: cwdArg, allowLocal })
    for (const r of updated)
      console.log(
        `  ${c.green(glyphs.check)} ${sanitizeAnsiLine(r.id)}: ${r.from} -> ${r.to} model`,
      )
    for (const f of failed)
      console.log(
        `  ${c.red(glyphs.cross)} ${sanitizeAnsiLine(f.id)}: ${sanitizeAnsiLine(f.reason)}`,
      )
    if (!updated.length && !failed.length) {
      const cfgHere = await loadConfig(cwdArg, { allowLocal })
      if (cfgHere.providers.length === 0)
        console.log("  (no providers yet - run `minicode config add` first)")
      else console.log("  (no changes — check API key and network, then retry)")
    }
    process.exit(0)
  }
  process.exit(0)
}
