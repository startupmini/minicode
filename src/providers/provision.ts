// Provisioning provider: deteksi model, simpan/hapus/sinkron entri provider.
// Dipisah dari src/config.ts supaya lapisan config murni IO (baca/tulis/validasi
// berkas) dan tidak bergantung ke providers/ — arah dependensi jadi satu arah:
// providers → config.
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  globalConfigPath,
  LOCAL,
  loadConfig,
  type MinicodeConfig,
  normalizeConfig,
  type ProviderEntry,
  withConfigLock,
  writeConfigAtomic,
} from "../config.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { getSecret } from "../lib/keystore.ts"
import { clearDetectCache, type DetectResult, detectModels } from "./detect.ts"
import { GATEWAY_PRESETS } from "./presets.ts"

/**
 * Selesaikan apiKey untuk deteksi model: referensi `keystore:<nama>` menjadi
 * secret OS, sisanya lewat apa adanya. Return null bila entri keystore
 * hilang/tak terbaca — pemanggil harus mencatat failed yang actionable,
 * JANGAN mengirim literal "keystore:..." sebagai Bearer (401 diam-diam).
 */
export async function resolveDetectApiKey(apiKey: string): Promise<string | null> {
  if (!apiKey.startsWith("keystore:")) return apiKey
  return getSecret(apiKey.slice("keystore:".length)).catch(() => null)
}

export async function saveProvider(
  entry: ProviderEntry,
  opts: { global?: boolean; cwd?: string } = {},
) {
  // Provider OAuth sengaja TIDAK butuh apiKey: tokennya hidup di auth.json.
  const needsKey = entry.auth !== "oauth"
  if (!entry.id || !entry.baseUrl || (needsKey && !entry.apiKey))
    throw new Error("provider id/baseUrl/apiKey required")
  // A provider may temporarily have no models: `/model` can remove the last
  // entry before `/sync` discovers a new one.
  const path =
    (opts.global ?? true) ? globalConfigPath() : resolve(opts.cwd ?? process.cwd(), LOCAL)
  // Kunci per-path SAMA dengan saveMcpServer/saveLspServer (audit #07):
  // tanpa ini baca-modifikasi-tulis paralel last-wins dan menelan entri.
  return withConfigLock(path, async () => {
    let cfg: MinicodeConfig = { providers: [] }
    try {
      cfg = normalizeConfig(JSON.parse(await readFile(path, "utf8")))
    } catch (e) {
      // Audit #08 P1: reset diam-diam saat berkas korup MENGHAPUS semua
      // provider + MCP/LSP/verify/allowlist lain saat tulis berikutnya.
      // ENOENT (belum ada file) = mulai kosong; korup = backup + gagal keras
      // seperti saveMcpServer; error lain (EACCES/…) = teruskan, jangan timpa.
      if (e instanceof SyntaxError) {
        const raw = await readFile(path, "utf8").catch(() => "")
        const backup = `${path}.corrupt.${Date.now()}`
        await atomicWriteText(backup, raw).catch(() => {})
        throw new Error(`config corrupt: ${path} — backup to ${backup}: ${e.message}`)
      }
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    }
    const idx = cfg.providers.findIndex((p) => p.id === entry.id)
    if (idx >= 0) cfg.providers[idx] = entry
    else cfg.providers.push(entry)
    await writeConfigAtomic(path, cfg)
  })
}

// 5.1 — id ramah: pakai id preset (openrouter/deepseek/generic/...) atau slug
// baseUrl; dedupe dengan indeks numerik, BUKAN hash acak.
export function deriveProviderId(baseUrl: string, existingIds: string[], id?: string): string {
  let baseId: string
  if (id) {
    baseId = id
  } else {
    const norm = baseUrl.replace(/\/+$/, "")
    const preset = GATEWAY_PRESETS.find((p) => p.baseUrl.replace(/\/+$/, "") === norm)
    baseId =
      (preset?.id ??
        norm
          .replace(/\/v1$/i, "") // OpenAI-compatible gateways: buang akhiran /v1
          .replace(/https?:\/\//, "")
          .replace(/[^a-z0-9]/gi, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 24)) ||
      "gateway"
  }
  let uniqId = baseId.slice(0, 30)
  if (!id) {
    let n = 2
    while (existingIds.includes(uniqId)) {
      uniqId = `${baseId}-${n}`.slice(0, 30)
      n++
    }
  }
  return uniqId
}

export async function detectAndSave(
  baseUrl: string,
  apiKey: string,
  id?: string,
  opts: { global?: boolean; cwd?: string; fallbackModels?: string[]; allowLocal?: boolean } = {},
): Promise<ProviderEntry> {
  // Fallback model dipakai bila provider tidak punya endpoint GET /models
  // (mis. Anthropic) atau deteksi gagal karena JARINGAN — agar wizard tetap
  // berhasil. Key SALAH (401/403) bukan alasan fallback: menyimpannya dengan
  // daftar palsu membuat auth gagal baru ketahuan saat inferensi.
  // Cache 30 menit juga dibuang dulu: retry add dengan key terkoreksi harus
  // re-fetch, bukan menyajikan daftar basi dari percobaan sebelumnya.
  clearDetectCache()
  let detected: DetectResult
  try {
    detected = await detectModels(baseUrl, apiKey)
    if (detected.models.length === 0 && !detected.authFailed && opts.fallbackModels?.length) {
      detected = {
        models: opts.fallbackModels,
        providerHint: detected.providerHint,
        authFailed: false,
      }
    }
  } catch (e) {
    if (!opts.fallbackModels) throw e
    const hint = baseUrl.includes("anthropic")
      ? "anthropic"
      : baseUrl.includes("deepseek")
        ? "unknown"
        : "unknown"
    detected = {
      models: opts.fallbackModels,
      providerHint: hint as "openai" | "anthropic" | "responses" | "unknown",
      authFailed: false,
    }
  }
  // Key ditolak server (401/403): gagal keras dengan pesan actionable.
  // Menyimpan dengan fallback di sini = "Saved (3 models)" palsu yang baru
  // ketahuan saat inferensi — temuan audit yang sedang diperbaiki.
  if (detected.models.length === 0 && detected.authFailed) {
    throw new Error(
      `unauthorized: ${baseUrl} menolak API key (401/403) — periksa key, provider tidak disimpan`,
    )
  }
  // dedup id: id ramah via preset/slug, tanpa hash acak (lihat deriveProviderId)
  const prevCfg = await loadConfig(opts.cwd, { allowLocal: opts.allowLocal })
  const existing = prevCfg.providers.map((p) => p.id)
  const uniqId = deriveProviderId(baseUrl, existing, id)
  // Pertahankan knob user (thinking effort) bila provider sudah ada — tanpa
  // ini tiap add/edit me-reset effort ke default diam-diam ("hilang").
  const prevEffort = prevCfg.providers.find((p) => p.id === uniqId)?.reasoningEffort
  const entry: ProviderEntry = {
    id: uniqId,
    baseUrl,
    apiKey,
    models: detected.models,
    providerHint: detected.providerHint,
    ...(prevEffort ? { reasoningEffort: prevEffort } : {}),
  }
  await saveProvider(entry, opts)
  return entry
}

export async function removeProvider(id: string, opts: { global?: boolean; cwd?: string } = {}) {
  const path =
    (opts.global ?? true) ? globalConfigPath() : resolve(opts.cwd ?? process.cwd(), LOCAL)
  return withConfigLock(path, async () => {
    let cfg: MinicodeConfig = { providers: [] }
    try {
      cfg = normalizeConfig(JSON.parse(await readFile(path, "utf8")))
    } catch (e) {
      // Sama seperti saveProvider (audit #08 P1): korup = backup + gagal
      // keras, bukan reset diam-diam yang menghapus seluruh config.
      if (e instanceof SyntaxError) {
        const raw = await readFile(path, "utf8").catch(() => "")
        const backup = `${path}.corrupt.${Date.now()}`
        await atomicWriteText(backup, raw).catch(() => {})
        throw new Error(`config corrupt: ${path} — backup to ${backup}: ${e.message}`)
      }
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    }
    cfg.providers = cfg.providers.filter((p) => p.id !== id)
    await writeConfigAtomic(path, cfg)
  })
}

// Re-detect models untuk provider yang ada (model baru otomatis tersinkron).
// Tidak menyentuh apiKey/baseUrl — hanya memperbarui daftar models.
// Membaca MERGED config (local prioritas atas global) dan menulis kembali ke
// KEDUA file tempat provider ternyata disimpan — mirip perilaku loadConfig,
// sehingga `/sync` bekerja walau provider disimpan di local (bukan global).
export interface SyncResult {
  updated: { id: string; from: number; to: number }[]
  /** Provider yang gagal total (network/timeout) — bedakan dari "tak ada
   * perubahan" agar /sync jujur. Catatan: 401/403 dari /models ditelan
   * detectModels sebagai "kosong" (Anthropic memang tak punya endpoint itu),
   * jadi daftar ini hanya untuk kegagalan transport dan keystore yang hilang
   * (keduanya butuh aksi operator), bukan vonis auth. */
  failed: { id: string; reason: string }[]
}

export async function refreshProviderModels(
  opts: { global?: boolean; cwd?: string; allowLocal?: boolean } = {},
): Promise<SyncResult> {
  // /sync harus benar-benar re-fetch — tanpa ini detectModels menyajikan cache
  // 30 menit dan /sync menjadi no-op ("from == to") padahal provider punya
  // model baru.
  clearDetectCache()
  const merged = await loadConfig(opts.cwd, { allowLocal: opts.allowLocal })
  const providers: ProviderEntry[] = merged.providers
  if (providers.length === 0 && (opts.global ?? true)) {
    // tidak ada provider di merge — coba file global secara eksplisit
    const g = await readFile(globalConfigPath(), "utf8")
      .then((raw) => normalizeConfig(JSON.parse(raw)).providers)
      .catch(() => [])
    providers.push(...g)
  }
  if (providers.length === 0) return { updated: [], failed: [] }

  const updated = new Map<string, ProviderEntry>()
  const failed: { id: string; reason: string }[] = []
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i]!
    if (!p.apiKey || !p.baseUrl) continue
    // Selesaikan referensi keystore SEBELUM deteksi (sama seperti
    // buildProviderListAsync): tanpa ini literal "keystore:..." terkirim
    // sebagai Bearer → 401 → [] → sync diam-diam no-op selamanya — tak masuk
    // updated maupun failed, dan daftar model tak pernah tersinkron.
    const apiKey = await resolveDetectApiKey(p.apiKey)
    if (apiKey == null) {
      failed.push({
        id: p.id,
        reason: `keystore entry missing/unreadable — run: minicode config set-key ${p.id}`.slice(
          0,
          120,
        ),
      })
      continue
    }
    try {
      const detected = await detectModels(p.baseUrl, apiKey)
      if (detected.models.length) {
        updated.set(p.id, { ...p, models: detected.models, providerHint: detected.providerHint })
      } else if (detected.authFailed) {
        // Key ditolak (401/403): bedakan dari provider tanpa endpoint
        // (Anthropic-style, tetap diam) — operator harus periksa key-nya.
        failed.push({ id: p.id, reason: "unauthorized (401/403) — periksa API key" })
      }
    } catch (e) {
      // provider offline/timeout — catat, jangan diam. Daftar lama dibiarkan.
      failed.push({ id: p.id, reason: String((e as Error)?.message ?? e).slice(0, 120) })
    }
  }

  // Tulis kembali ke setiap file yang memuat provider yang diupdate — dalam
  // format yang sudah ada di file tersebut (global dan/atau local).
  const results: { id: string; from: number; to: number }[] = []
  // check existence via direct read attempt (no TOCTOU pre-check).
  // Berkas lokal hanya disentuh bila operator opt-in (default deny — /sync
  // tanpa flag tak boleh menghubungi endpoint repo tak dikenal).
  const paths = new Set<string>()
  const checkPaths = opts.allowLocal
    ? [globalConfigPath(), resolve(opts.cwd ?? process.cwd(), LOCAL)]
    : [globalConfigPath()]
  for (const p of checkPaths) {
    try {
      await readFile(p, "utf8")
      paths.add(p)
    } catch {}
  }
  for (const path of paths) {
    // Kunci per-file (audit #07): /sync + saveProvider paralel tanpa ini
    // last-wins dan menelan update satu sama lain.
    await withConfigLock(path, async () => {
      try {
        const cfg: MinicodeConfig = normalizeConfig(JSON.parse(await readFile(path, "utf8")))
        let changed = false
        for (const p of cfg.providers) {
          const nu = updated.get(p.id)
          if (nu) {
            p.models = nu.models
            p.providerHint = nu.providerHint
            changed = true
          }
        }
        if (changed) await writeConfigAtomic(path, cfg)
      } catch {
        // file corrupt/unreadable — lewati
      }
    })
  }
  for (const [id, nu] of updated) {
    const orig = providers.find((p) => p.id === id)!
    results.push({ id, from: orig.models.length, to: nu.models.length })
  }
  return { updated: results, failed }
}
