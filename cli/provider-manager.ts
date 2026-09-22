// Controller provider manager — CRUD config + deteksi model; tampilannya di
// src/ui/screens/provider-manager.ts.

import { reloadProviders } from "../src/app/provider-layer.ts"
import { loadConfig, type MinicodeConfig } from "../src/config.ts"
import { GATEWAY_PRESETS } from "../src/providers/presets.ts"
import { detectAndSave, removeProvider } from "../src/providers/provision.ts"
import { sanitizeAnsiLine } from "../src/ui/render/sanitize.ts"
import {
  type ProviderActionResult,
  type ProviderRow,
  runProviderManagerView,
} from "../src/ui/screens/provider-manager.ts"

const rowsFrom = (cfg: MinicodeConfig): ProviderRow[] =>
  cfg.providers.map((p) => ({
    id: p.id,
    baseUrl: p.baseUrl,
    models: p.models.length,
    hint: p.providerHint,
    firstModel: p.models[0],
  }))

export async function runProviderManager(opts: {
  cwd?: string
  currentModel?: string
  setModelOverride?: (m: string) => void
  /** Flag --allow-local-config sesi (default deny). */
  allowLocalConfig?: boolean
}): Promise<void> {
  if (!process.stdin.isTTY) {
    const cfg = await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })
    console.log("\nProviders:")
    // id/baseUrl dari config (lokal repo tak terpercaya) — sanitasi sebelum cetak.
    for (const p of cfg.providers)
      console.log(
        `  ${sanitizeAnsiLine(p.id)} - ${sanitizeAnsiLine(p.baseUrl)} (${p.models.length} models)`,
      )
    return
  }

  // Router runtime gagal dimuat ulang (config IO) — jangan lapor sukses palsu:
  // tanpa pesan, user mengira pilihan langsung berlaku padahal butuh restart.
  const warnReloadFail = () =>
    process.stderr.write("[warn] provider reload failed — restart to apply changes\n")

  await runProviderManagerView({
    initialRows: rowsFrom(await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })),
    presets: GATEWAY_PRESETS.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl })),
    currentModel: opts.currentModel,
    askScope: !!opts.cwd,
    onSelect: (row) => {
      if (row.firstModel && opts.setModelOverride) {
        opts.setModelOverride(`${row.id}::${row.firstModel}`)
      }
    },
    loadRows: async () =>
      rowsFrom(await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })),
    onAdd: async ({ preset, baseUrl, apiKey, scope }): Promise<ProviderActionResult> => {
      const full = preset ? GATEWAY_PRESETS.find((p) => p.id === preset.id) : undefined
      const fallbackModels = full?.fallbackModels ?? ["gpt-4o-mini"]
      try {
        const entry = await detectAndSave(baseUrl, apiKey, full?.id, {
          global: scope === "global",
          cwd: opts.cwd,
          fallbackModels,
          allowLocal: opts.allowLocalConfig,
        })
        await reloadProviders(opts.cwd, { allowLocal: opts.allowLocalConfig }).catch(warnReloadFail)
        return { ok: `Provider "${entry.id}" saved (${entry.models.length} models, ${scope}).` }
      } catch (e) {
        return { err: `Model detection failed: ${(e as Error).message.slice(0, 80)}` }
      }
    },
    onDelete: async (row): Promise<ProviderActionResult> => {
      await removeProvider(row.id, { global: true })
      if (opts.cwd) await removeProvider(row.id, { global: false, cwd: opts.cwd })
      await reloadProviders(opts.cwd, { allowLocal: opts.allowLocalConfig }).catch(() =>
        process.stderr.write("[warn] provider reload failed — restart to apply changes\n"),
      )
      return { ok: `Provider "${row.id}" deleted.` }
    },
    onEditDefaults: async (row) => {
      const cfg = await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })
      const cur = cfg.providers.find((p) => p.id === row.id)
      if (!cur) return null
      return { baseUrl: cur.baseUrl, apiKey: cur.apiKey }
    },
    onEditSave: async (row, { baseUrl, apiKey }): Promise<ProviderActionResult> => {
      const cfg = await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })
      const cur = cfg.providers.find((p) => p.id === row.id)
      if (!cur) return { err: "Provider not found" }
      try {
        await removeProvider(row.id, { global: true })
        if (opts.cwd) await removeProvider(row.id, { global: false, cwd: opts.cwd })
        const entry = await detectAndSave(baseUrl, apiKey, row.id, {
          global: true,
          cwd: opts.cwd,
          fallbackModels: cur.models,
          allowLocal: opts.allowLocalConfig,
        })
        await reloadProviders(opts.cwd, { allowLocal: opts.allowLocalConfig }).catch(warnReloadFail)
        return { ok: `Provider "${entry.id}" updated (${entry.models.length} models)` }
      } catch (e) {
        await detectAndSave(cur.baseUrl, cur.apiKey, cur.id, {
          global: true,
          cwd: opts.cwd,
          fallbackModels: cur.models,
        }).catch(() => {})
        await reloadProviders(opts.cwd, { allowLocal: opts.allowLocalConfig }).catch(warnReloadFail)
        return { err: `Update failed: ${(e as Error).message.slice(0, 80)}` }
      }
    },
  })
}
