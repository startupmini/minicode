// Controller model registry — CRUD config; tampilannya di
// src/ui/screens/model-manager.ts.
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  globalConfigPath,
  LOCAL,
  loadConfig,
  type MinicodeConfig,
  normalizeConfig,
  type ProviderEntry,
  writeConfigAtomic,
} from "../src/config.ts"
import { effortOptionsForModel } from "../src/providers/effort.ts"
import { sanitizeAnsiLine } from "../src/ui/render/sanitize.ts"
import { type ModelRow, runModelManagerView } from "../src/ui/screens/model-manager.ts"

/**
 * Tulis mutasi ke file scope tempat provider itu benar-benar hidup (semua
 * salinan, bukan hasil merge) — diekstrak dari closure runModelManager agar
 * alur TUI-native bisa memakai semantik tulis yang sama. Lempar bila provider
 * tak ada di scope mana pun.
 */
export async function mutateProviderInScopes(
  cwd: string | undefined,
  id: string,
  mutate: (p: ProviderEntry) => void,
): Promise<void> {
  const paths = cwd ? [resolve(cwd, LOCAL), globalConfigPath()] : [globalConfigPath()]
  let touched = false
  for (const path of paths) {
    let cfg: MinicodeConfig
    try {
      cfg = normalizeConfig(JSON.parse(await readFile(path, "utf8")))
    } catch {
      continue
    }
    const p = cfg.providers.find((x) => x.id === id)
    if (!p) continue
    mutate(p)
    await writeConfigAtomic(path, cfg)
    touched = true
  }
  if (!touched) throw new Error(`provider not found: ${id}`)
}

/**
 * Simpan reasoning effort satu model (dipakai alur TUI-native /model).
 * effort "default" = hapus tersimpan. Semantik tulis = onSetEffort view.
 */
export async function saveModelEffort(
  cwd: string | undefined,
  modelId: string,
  effort: "default" | "low" | "medium" | "high",
): Promise<void> {
  const sep = modelId.indexOf("::")
  const pid = sep === -1 ? modelId : modelId.slice(0, sep)
  await mutateProviderInScopes(cwd, pid, (p) => {
    if (effort === "default") delete (p as { reasoningEffort?: string }).reasoningEffort
    else (p as ProviderEntry).reasoningEffort = effort
  })
}

/** Minimal model registry: list, select, add, and remove. */
export async function runModelManager(opts: {
  cwd?: string
  currentModel?: string
  setModelOverride?: (model: string) => void
  /** Flag --allow-local-config sesi (default deny — daftar model tak memuat
   * endpoint repo tanpa opt-in). */
  allowLocalConfig?: boolean
  /** Filter awal daftar (dari `/model <cari>`). */
  initialFilter?: string
}): Promise<void> {
  const cfg = await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })
  if (!process.stdin.isTTY) {
    // Daftar ke scrollback: id/model dari config (lokal repo tak terpercaya)
    // dan hasil probe jaringan — sanitasi sebelum cetak.
    for (const p of cfg.providers)
      for (const model of p.models)
        console.log(`${sanitizeAnsiLine(p.id)}::${sanitizeAnsiLine(model)}`)
    return
  }

  const rowsOf = (providers: ProviderEntry[]): ModelRow[] =>
    providers.flatMap((p) =>
      p.models.map((model) => ({
        id: `${p.id}::${model}`,
        active: `${p.id}::${model}` === opts.currentModel,
        ...(p.reasoningEffort ? { effort: p.reasoningEffort } : {}),
      })),
    )
  // Tulis mutasi ke file scope tempat provider itu benar-benar hidup — BUKAN
  // hasil merge. Menyimpan entri merge ke satu file menduplikat provider ke
  // scope lain; merge lalu memprioritaskan salinan itu sehingga editan di
  // scope asal jadi tak terlihat ("balik lagi"). SEMUA salinan diupdate (bila
  // duplikat lintas file sudah terlanjur ada) agar tak ada yang menghidupkan
  // data basi. Lempar bila provider tak ada di scope mana pun — view
  // menampilkan ✗ (dulu ditelan diam-diam).
  const updateProviderInScopes = async (
    id: string,
    mutate: (p: ProviderEntry) => void,
  ): Promise<void> => mutateProviderInScopes(opts.cwd, id, mutate)

  return runModelManagerView({
    initialRows: rowsOf(cfg.providers),
    ...(opts.initialFilter ? { initialFilter: opts.initialFilter } : {}),
    // Opsi effort jujur per model: keluarga tanpa thinking hanya "default"
    // (view melewati picker dan tak menyentuh effort tersimpan).
    getEfforts: (id: string) => {
      const sep = id.indexOf("::")
      return effortOptionsForModel(sep === -1 ? id : id.slice(sep + 2))
    },
    onSelect: async (id) => {
      // Reload providers agar router langsung kenal provider baru tanpa restart
      const { reloadProviders } = await import("../src/app/provider-layer.ts")
      await reloadProviders(opts.cwd, { allowLocal: opts.allowLocalConfig }).catch(() =>
        process.stderr.write("[warn] provider reload failed — restart to apply changes\n"),
      )
      opts.setModelOverride?.(id)
    },
    loadRows: async () =>
      rowsOf((await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })).providers),
    onAdd: async (providerId, model) => {
      await updateProviderInScopes(providerId, (p) => {
        if (!p.models.includes(model)) p.models = [...p.models, model]
      })
      return rowsOf((await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })).providers)
    },
    onDelete: async (id) => {
      const sep = id.indexOf("::")
      await updateProviderInScopes(id.slice(0, sep), (p) => {
        p.models = p.models.filter((m) => m !== id.slice(sep + 2))
      })
      return rowsOf((await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })).providers)
    },
    onSetEffort: async (id, effort) => {
      const sep = id.indexOf("::")
      await updateProviderInScopes(id.slice(0, sep), (p) => {
        if (effort === "default") delete (p as { reasoningEffort?: string }).reasoningEffort
        else (p as ProviderEntry).reasoningEffort = effort
      })
      return rowsOf((await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })).providers)
    },
  })
}
