import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { isPrivateHostWithDns } from "../lib/net.ts"
import { scrubSecrets } from "../policy/scrub.ts"

const MAX_REDIRECTS = LIMITS.WEB_FETCH_MAX_REDIRECTS
// Hard-cap pembacaan body SEBELUM slicing — cegah OOM dari response raksasa.
const BODY_HARD_CAP_CHARS = LIMITS.WEB_FETCH_BODY_HARD_CAP_CHARS

async function readBodyCapped(res: Response, controller: AbortController): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let out = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
      if (out.length > BODY_HARD_CAP_CHARS) {
        controller.abort(new Error("response exceeds body hard cap"))
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return out
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a public HTTP/HTTPS URL (GET, 10s timeout, max 50k chars). Use for browsing public web pages. Blocks private IPs and private redirect targets.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "https:// URL to fetch" },
      maxChars: { type: "number", description: "max chars to return (default 20000, max 50000)" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async execute({ url, maxChars }, ctx) {
    const u = String(url ?? "").trim()
    if (!u) throw new Error("url required")
    let parsed: URL
    try {
      parsed = new URL(u)
    } catch {
      throw new Error(`invalid url: ${u}`)
    }

    const limit = Math.min(Math.max(Number(maxChars) || 20000, 1000), 50000)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error("fetch timeout 10s")), 10_000)
    // Link parent signal — selalu pasang listener dulu, cek aborted setelahnya
    // (tutup race abort antara check dan addEventListener).
    const onParentAbort = () => controller.abort(ctx.signal.reason)
    ctx.signal.addEventListener("abort", onParentAbort, { once: true })
    if (ctx.signal.aborted) controller.abort(ctx.signal.reason)

    try {
      // Redirect ditangani MANUAL: tiap hop divalidasi ulang isPrivateHost +
      // DNS tanpa cache klien — menutup SSRF via open-redirect & rebinding
      // yang mengandalkan cache basi. SISA RESIDUAL jujur (audit 2026-09-16
      // B6): validasi-lalu-fetch = check-then-connect; resolver OS bisa
      // mengembalikan IP berbeda saat connect dibanding saat cek. Menutupnya
      // butuh pin-IP di level socket (di luar API fetch) — ditunda sadar,
      // bukan diklaim tertutup.
      let current = parsed
      if (await isPrivateHostWithDns(current.hostname)) {
        throw new Error(`blocked private host: ${current.hostname}`)
      }
      const headers = {
        "user-agent": "minicode-webfetch/1.0",
        accept: "text/html,application/json,text/*;q=0.9,*/*;q=0.8",
      }
      let res: Response | undefined
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        res = await fetch(current.toString(), {
          signal: controller.signal,
          headers,
          redirect: "manual",
        })
        if (res.status < 300 || res.status >= 400) break
        const loc = res.headers.get("location")
        if (!loc) break
        let next: URL
        try {
          next = new URL(loc, current)
        } catch {
          throw new Error(`invalid redirect location: ${loc}`)
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new Error(`redirect to disallowed protocol: ${next.protocol}`)
        }
        if (await isPrivateHostWithDns(next.hostname)) {
          throw new Error(`blocked private host (redirect target): ${next.hostname}`)
        }
        current = next
        void res.body?.cancel().catch(() => {})
      }
      if (!res) throw new Error("unreachable")
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`too many redirects (>${MAX_REDIRECTS})`)
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "")
        const snippet = scrubSecrets(body).slice(0, 1000)
        throw new Error(`fetch ${res.status} ${res.statusText}${snippet ? `: ${snippet}` : ""}`)
      }

      const contentType = res.headers.get("content-type") ?? ""
      const raw = await readBodyCapped(res, controller)
      const scrubbed = scrubSecrets(raw)
      const sliced = scrubbed.slice(0, limit)
      const truncated =
        scrubbed.length > limit ? `\n\n… truncated ${scrubbed.length - limit} chars` : ""
      const header = `[${current} ${res.status} ${contentType}]\n`
      return (header + sliced + truncated).slice(0, limit + 500)
    } finally {
      clearTimeout(timeout)
      ctx.signal.removeEventListener("abort", onParentAbort)
    }
  },
}
