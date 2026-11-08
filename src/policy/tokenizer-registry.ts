import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { type BpeTokenizer, loadBpeTokenizer } from "./bpe.ts"

// Pemetaan keluarga model -> repo HuggingFace yang mempublikasikan tokenizer.json.
// Hanya model OPEN (bukan gated): repo meta-llama (Llama) di-bypass karena butuh
// auth. Bisa diperluas; sumber eksplisit bisa ditimpa lewat config di masa depan.
const TOKENIZER_REPOS: Array<{ family: string; repo: string }> = [
  { family: "deepseek", repo: "deepseek-ai/DeepSeek-V3" },
  { family: "qwen", repo: "Qwen/Qwen2.5-7B" },
  { family: "mistral", repo: "mistralai/Mistral-7B-v0.1" },
  { family: "gemma", repo: "google/gemma-2-2b" },
  { family: "phi", repo: "microsoft/phi-2" },
]

const memoryCache = new Map<string, BpeTokenizer>()

/** Unduh tokenizer presisi on-demand hanya bila tidak dimatikan eksplisit. */
function tokenizersEnabled(): boolean {
  const v = process.env.MINICODE_TOKENIZERS
  return !(v === "0" || v === "false" || v === "off" || v === "no")
}

/** Reset cache memori — untuk test hermetic (pola `__reset*` repo). */
export function __resetTokenizerCache(): void {
  memoryCache.clear()
}

function cacheDir(): string {
  return join(process.env.MINICODE_HOME ?? homedir(), ".minicode", "tokenizers")
}

function cachePath(repo: string): string {
  const safe = repo.replace(/[^a-zA-Z0-9._-]/g, "_")
  return join(cacheDir(), `${safe}.json`)
}

/** Cari repo tokenizer untuk id model (hanya keluarga open yang dikenal). */
export function findTokenizerRepo(modelId: string): string | undefined {
  const m = modelId.toLowerCase()
  for (const { family, repo } of TOKENIZER_REPOS) if (m.includes(family)) return repo
  return undefined
}

/** Ambil tokenizer dari cache memori/disk (sinkron, tanpa jaringan). */
export function getCachedTokenizer(modelId: string): BpeTokenizer | null {
  if (!tokenizersEnabled()) return null
  const repo = findTokenizerRepo(modelId)
  if (!repo) return null
  const key = repo
  const hit = memoryCache.get(key)
  if (hit) return hit
  const path = cachePath(repo)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      vocab?: Record<string, number>
      merges?: string[]
    }
    if (!raw.vocab || !raw.merges) return null
    const tok = loadBpeTokenizer({ vocab: raw.vocab, merges: raw.merges })
    memoryCache.set(key, tok)
    return tok
  } catch {
    return null
  }
}

/**
 * Muat tokenizer untuk model: cache -> disk -> unduh dari HuggingFace. Idempoten
 * + fire-and-forget: gagal jaringan = null (fallback estimator densitas/usage).
 */
export async function loadTokenizer(modelId: string): Promise<BpeTokenizer | null> {
  const cached = getCachedTokenizer(modelId)
  if (cached) return cached
  const repo = findTokenizerRepo(modelId)
  if (!repo) return null
  const url = `https://huggingface.co/${repo}/resolve/main/tokenizer.json`
  let data: { vocab: Record<string, number>; merges: string[] }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    const parsed = (await res.json()) as {
      model?: { vocab?: Record<string, number>; merges?: string[] }
    }
    const vocab = parsed.model?.vocab
    const merges = parsed.model?.merges
    if (!vocab || !merges) return null
    data = { vocab, merges }
  } catch {
    return null
  }
  const tok = loadBpeTokenizer(data)
  memoryCache.set(repo, tok)
  try {
    mkdirSync(cacheDir(), { recursive: true })
    writeFileSync(cachePath(repo), JSON.stringify(data))
  } catch {
    // cache disk gagal = non-fatal; tokenizer tetap aktif di memori sesi ini
  }
  return tok
}
