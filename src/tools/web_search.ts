import type { Tool } from "#minicore"
import { isPrivateHost } from "../lib/net.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import { readBodyCapped } from "./web_fetch.ts"

// Penanda truncation (temuan audit #02): snippet/total yang dipotong
// diam-diam tampak lengkap. Snippet 400 char, total per-provider di-cap.
export function cutSnippet(s: string): string {
  const clean = scrubSecrets(s)
  return clean.length > 400 ? `${clean.slice(0, 400)}…` : clean
}

export function capTotal(out: string, cap: number): string {
  return out.length > cap ? `${out.slice(0, cap)}\n… [truncated: showing first ${cap} chars]` : out
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web (Google grounding-like via DuckDuckGo/Tavily). Returns top results with snippets. Uses web_fetch under the hood with SSRF guard.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "search query" },
      count: { type: "number", description: "max results (default 5, max 10)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute({ query, count }, ctx) {
    // Fail-fast saat sesi sudah dibatalkan — sebelum network apa pun.
    ctx.signal.throwIfAborted()
    const q = String(query ?? "").trim()
    if (!q) throw new Error("query required")
    const n = Math.min(Math.max(Number(count) || 5, 1), 10)
    // Prefer Tavily if key available (more reliable than scraping)
    const tavilyKey = process.env.TAVILY_API_KEY
    if (tavilyKey) {
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 8000)
        const onAbort = () => controller.abort(ctx.signal.reason)
        ctx.signal.addEventListener("abort", onAbort, { once: true })
        try {
          const res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              api_key: tavilyKey,
              query: q,
              max_results: n,
              search_depth: "basic",
            }),
            signal: controller.signal,
          })
          if (res.ok) {
            const data = (await res.json()) as {
              results?: { title: string; url: string; content: string }[]
            }
            const results = (data.results ?? []).slice(0, n)
            const out = results
              .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${cutSnippet(r.content)}`)
              .join("\n\n")
            return capTotal(`[tavily ${results.length} results for "${q}"]\n${out}`, 20000)
          }
        } finally {
          clearTimeout(t)
          ctx.signal.removeEventListener("abort", onAbort)
        }
      } catch {}
    }
    // Fallback 2: Brave Search API (gratis, JSON bersih) bila BRAVE_API_KEY ada.
    const braveKey = process.env.BRAVE_API_KEY
    if (braveKey) {
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 8000)
        // Tautkan pembatalan parent (sebelumnya hanya Tavily yang menautkan).
        const onAbort = () => controller.abort(ctx.signal.reason)
        if (ctx.signal.aborted) controller.abort(ctx.signal.reason)
        else ctx.signal.addEventListener("abort", onAbort, { once: true })
        try {
          const res = await fetch(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`,
            {
              headers: { "X-Subscription-Token": braveKey, accept: "application/json" },
              signal: controller.signal,
            },
          )
          if (res.ok) {
            const data = (await res.json()) as {
              web?: { results?: { title: string; url: string; description: string }[] }
            }
            const results = (data.web?.results ?? []).slice(0, n)
            if (results.length) {
              const out = results
                .map(
                  (r, i) =>
                    `${i + 1}. ${r.title}\n   ${r.url}\n   ${cutSnippet(r.description ?? "")}`,
                )
                .join("\n\n")
              return capTotal(`[brave ${results.length} results for "${q}"]\n${out}`, 20000)
            }
          }
        } finally {
          clearTimeout(t)
          ctx.signal.removeEventListener("abort", onAbort)
        }
      } catch {}
    }
    // Fallback 3: DuckDuckGo html lite (gratis, tanpa key).
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
    try {
      const parsed = new URL(ddgUrl)
      if (isPrivateHost(parsed.hostname)) throw new Error("blocked")
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 8000)
      const onAbort = () => controller.abort(ctx.signal.reason)
      if (ctx.signal.aborted) controller.abort(ctx.signal.reason)
      else ctx.signal.addEventListener("abort", onAbort, { once: true })
      try {
        const res = await fetch(ddgUrl, {
          signal: controller.signal,
          headers: { "user-agent": "minicode-websearch/1.0" },
        })
        // Cap streaming seperti web_fetch (bug-hunt 2026-09-19: res.text()
        // tanpa batas = transient ~2x body di heap untuk halaman raksasa).
        const html = await readBodyCapped(res, controller)
        const scrubbed = scrubSecrets(html)
        // DDG markup berubah-ubah; coba dua pola kelas umum.
        const resRe = /<a[^>]+class="result__url"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g
        const altRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g
        const results: { url: string; title: string }[] = []
        for (const m of scrubbed.matchAll(resRe)) {
          if (results.length >= n) break
          results.push({ url: m[1] ?? "", title: (m[2] ?? "").trim() })
        }
        if (results.length === 0) {
          for (const m of scrubbed.matchAll(altRe)) {
            if (results.length >= n) break
            results.push({ url: m[1] ?? "", title: (m[2] ?? "").trim() })
          }
        }
        if (results.length) {
          return capTotal(
            `[duckduckgo ${results.length} results for "${q}"]\n${results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n")}`,
            8000,
          )
        }
        return `[web_search] no structured results for "${q}" — coba set TAVILY_API_KEY atau BRAVE_API_KEY untuk hasil lebih baik.`
      } finally {
        clearTimeout(t)
        ctx.signal.removeEventListener("abort", onAbort)
      }
    } catch (e) {
      throw new Error(`web_search failed: ${(e as Error).message}`)
    }
  },
}
