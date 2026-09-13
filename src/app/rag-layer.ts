import type { MinicodeConfig } from "../config.ts"
import { searchHybrid } from "../memory/vector.ts"
import { loadSkills, type Skill, skillsToSystemPrompt } from "../skills/loader.ts"

export async function createRagLayer(opts: {
  cfg: MinicodeConfig
  prompt: string
  cwd?: string
  // false = retrieval RAG jangan menulis access_count (mode readonly/plan).
  trackAccess?: boolean
}): Promise<{ systemExtra?: string; skills: Skill[]; memoryHits: number }> {
  let systemExtra: string | undefined
  let memoryHits = 0
  // P2.1: cantumkan skor + tanggal agar model bisa menimbang kesegaran memori.
  const fmtDate = (ts: number): string => {
    try {
      return new Date(ts).toISOString().slice(0, 10)
    } catch {
      return "?"
    }
  }
  // Prompt kosong (startup REPL) = tak ada yang perlu di-retrieve: embedding
  // query kosong tak bermakna (keywordScore("")=0) tapi tiap kandidat tetap
  // memakan panggilan network sequential (DNS tanpa cache + POST embedding).
  // Lewati total; skills di bawah tetap dimuat (dropdown butuh daftarnya).
  // Sequential-until-hits dipertahankan (bukan paralel): kasus umum hanya 1
  // panggilan cepat; paralel justru N panggilan dengan latensi = endpoint
  // terlambat. Dedup per baseUrl menutup config duplikat (beberapa provider,
  // satu gateway) agar endpoint mati tak dicoba berulang dengan kunci beda.
  const q = opts.prompt.trim()
  if (q) {
    try {
      const candidates: { baseUrl: string; apiKey: string }[] = []
      const seen = new Set<string>()
      const consider = (baseUrl: string, apiKey: string) => {
        if (!apiKey || !baseUrl || seen.has(baseUrl)) return
        seen.add(baseUrl)
        candidates.push({ baseUrl, apiKey })
      }
      for (const p of opts.cfg.providers) if (p.apiKey) consider(p.baseUrl, p.apiKey)
      if (process.env.AGENT_BASE_URL || process.env.OPENAI_API_KEY) {
        consider(
          process.env.AGENT_BASE_URL ?? "https://api.openai.com/v1",
          process.env.OPENAI_API_KEY ?? process.env.AGENT_API_KEY ?? "",
        )
      }
      if (
        candidates.length === 0 &&
        (opts.cfg.providers[0]?.apiKey || process.env.OPENAI_API_KEY)
      ) {
        consider(
          opts.cfg.providers[0]?.baseUrl ?? "https://api.openai.com/v1",
          opts.cfg.providers[0]?.apiKey ?? process.env.OPENAI_API_KEY ?? "",
        )
      }
      let hits: { text: string; score: number; createdAt: number }[] = []
      for (const c of candidates) {
        try {
          hits = await searchHybrid(q, {
            baseUrl: c.baseUrl,
            apiKey: c.apiKey,
            cwd: opts.cwd,
            topK: 5,
            trackAccess: opts.trackAccess,
          })
          if (hits.length) break
        } catch {}
      }
      if (hits.length) {
        memoryHits = hits.length
        systemExtra = `\n# Relevant memory (hybrid vector+keyword)\n${hits.map((h) => `- ${h.text.slice(0, 300)} (score ${h.score.toFixed(2)}, ${fmtDate(h.createdAt)})`).join("\n")}`
      }
      if (!hits.length && candidates.length === 0) {
        try {
          hits = await searchHybrid(q, {
            cwd: opts.cwd,
            topK: 5,
            trackAccess: opts.trackAccess,
          })
          if (hits.length) {
            memoryHits = hits.length
            systemExtra = `\n# Relevant memory (keyword)\n${hits.map((h) => `- ${h.text.slice(0, 300)} (score ${h.score.toFixed(2)}, ${fmtDate(h.createdAt)})`).join("\n")}`
          }
        } catch {}
      }
    } catch {}
  }

  const skills = await loadSkills(opts.cwd)
  try {
    const skillPrompt = skillsToSystemPrompt(skills)
    if (skillPrompt) systemExtra = (systemExtra ?? "") + skillPrompt
  } catch {}

  return { systemExtra, skills, memoryHits }
}
