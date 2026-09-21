import { afterEach, beforeEach, expect, test } from "bun:test"
import { createEventBus } from "#minicore/core/events.ts"
import { costFor, createUsageCollector } from "../src/policy/usage.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import {
  extractProviderDetail,
  friendlyError,
  friendlyFromCategory,
} from "../src/ui/render/errors.ts"
import { displayWidth } from "../src/ui/render/width.ts"

// Pesan error dwibahasa — kunci en (paritas highlight.test.ts).
beforeEach(() => setSessionLocale("en"))
afterEach(() => resetLocaleState())

test("friendlyFromCategory: auth + balance", () => {
  const f = friendlyFromCategory(
    "auth",
    'credits: {"message":"Insufficient balance. Manage billing here: https://opencode.ai/workspace/wrk_123/billing"}',
  )
  expect(f.message).toContain("balance or quota")
  expect(f.fix).toContain("/model")
})

test("friendlyFromCategory: auth tanpa saldo → pesan auth generik", () => {
  const f = friendlyFromCategory("auth", "auth failed (401): invalid api key")
  expect(f.message).toContain("rejected authentication")
})

test("friendlyFromCategory: rate_limit / server / network", () => {
  expect(friendlyFromCategory("rate_limit", "429").message).toContain("rate-limiting")
  expect(friendlyFromCategory("server", "500").message).toContain("temporarily unavailable")
  expect(friendlyFromCategory("network", "socket hang up").message).toContain(
    "Failed to reach provider",
  )
})

test("friendlyFromCategory: invalid_request & context_length", () => {
  expect(friendlyFromCategory("invalid_request", "400 model not found").message).toContain(
    "rejected by provider",
  )
  expect(friendlyFromCategory("context_length_exceeded", "").message).toContain("Context window")
})

test("friendlyFromCategory: unknown mengambil field message dari JSON", () => {
  const f = friendlyFromCategory("unknown", '{"error":{"message":"Some technical detail"}}')
  expect(f.message).toBe("Some technical detail")
  const cut = friendlyFromCategory("unknown", "x".repeat(200))
  expect(cut.message.length).toBeLessThanOrEqual(161)
})

test("friendlyFromCategory: unknown 402 dikenali sebagai saldo habis", () => {
  const f = friendlyFromCategory(
    "unknown",
    '402: {"error":{"message":"This request requires more credits, or fewer max_tokens."}}',
  )
  expect(f.message).toContain("balance or quota")
  expect(f.fix ?? "").toContain("/model")
})

test("friendlyFromCategory: unknown FreeUsageLimit dikenali sebagai limit", () => {
  const f = friendlyFromCategory(
    "unknown",
    '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}',
  )
  expect(f.message).toContain("rate-limiting")
})

test("friendlyError: string bergaya AgentError", () => {
  expect(friendlyError("timeout: run exceeded 600000ms").message).toContain("timeout")
  expect(friendlyError("max_steps_exceeded: 50 steps").message).toContain("Tool step limit")
  expect(friendlyError("budget exceeded").message.toLowerCase()).toContain("budget")
})

// ── Regresi dari uji live OpenRouter ────────────────────────────────────────
// Satu error 429 mencetak 400+ karakter berisi metadata, provider_error_code,
// limit_source, dan URL dokumentasi — di dalam frame TUI selebar 100 kolom.
// Body OpenRouter juga menyembunyikan alasan sebenarnya di metadata.raw,
// sementara field `message` hanya berbunyi "Provider returned error".

const OR_429 =
  'rate limited (429): {"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"z-ai/glm-5.2:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"Decart","is_byok":false,"provider_error_code":"upstream_429","limit_source":"upstream_provider_shared_pool","remedy_hint":"Retry shortly, add your own provider key, or route to another provider."}}}'

const OR_403 =
  'auth failed (403): {"error":{"message":"thinkingmachines/inkling:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps","code":403}}'

const OR_404_NO_TOOLS =
  '404: {"error":{"message":"No endpoints found that support tool use. Try disabling \\"read_file\\". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection","code":404}}'

const CF_502 =
  "<!DOCTYPE html><html><head><title>gorouter.app | 502: Bad gateway</title></head><body>Cloudflare</body></html>"

test("extractProviderDetail: metadata.raw dipilih di atas message generik", () => {
  const { detail, hint } = extractProviderDetail(OR_429)
  expect(detail).toContain("rate-limited upstream")
  expect(detail).not.toContain("Provider returned error")
  expect(hint).toContain("Retry shortly")
})

test("extractProviderDetail: ambil message biasa bila tidak ada metadata", () => {
  const { detail } = extractProviderDetail(OR_403)
  expect(detail).toContain("only available on agentic harnesses")
})

test("extractProviderDetail: judul HTML untuk error Cloudflare", () => {
  const { detail } = extractProviderDetail(CF_502)
  expect(detail).toBe("gorouter.app | 502: Bad gateway")
})

test("extractProviderDetail: body JSON terpotong tetap menghasilkan detail", () => {
  const truncated =
    'rate limited (429): {"error":{"message":"Provider returned error","metadata":{"raw":"model X limit tercapai'
  const { detail } = extractProviderDetail(truncated)
  expect(detail).toContain("limit tercapai")
})

test("extractProviderDetail: teks tanpa JSON/HTML tidak melempar", () => {
  expect(extractProviderDetail("socket hang up")).toEqual({})
  expect(extractProviderDetail("")).toEqual({})
})

test("429 OpenRouter: pesan ringkas, tidak menumpahkan metadata", () => {
  const f = friendlyFromCategory("rate_limit", OR_429)
  expect(f.message).toContain("rate-limited upstream")
  expect(f.message).not.toContain("metadata")
  expect(f.message).not.toContain("provider_error_code")
  expect(f.message).not.toContain("limit_source")
  // Cukup pendek untuk satu baris terminal, bukan 400 karakter.
  expect(f.message.length).toBeLessThanOrEqual(200)
  expect(f.fix).toContain("Retry shortly") // remedy_hint provider dipakai
})

test("403 OpenRouter: alasan sebenarnya tampil, bukan 'auth ditolak' saja", () => {
  const f = friendlyFromCategory("auth", OR_403)
  expect(f.message).toContain("agentic harnesses")
  expect(f.message.length).toBeLessThanOrEqual(220)
})

test("404 no-tool-support: menyebut tool, bukan JSON mentah", () => {
  const f = friendlyFromCategory("invalid_request", OR_404_NO_TOOLS)
  expect(f.message.toLowerCase()).toContain("tool")
  expect(f.message).not.toContain('\\"')
  expect(f.message).not.toContain("openrouter.ai/docs")
})

test("502 HTML Cloudflare: tidak ada tag HTML yang lolos ke pesan", () => {
  const f = friendlyFromCategory("server", CF_502)
  expect(f.message).not.toContain("<")
  expect(f.message).toContain("502")
})

test("semua kategori selalu memberi saran tindakan", () => {
  for (const cat of [
    "rate_limit",
    "auth",
    "server",
    "network",
    "invalid_request",
    "context_length_exceeded",
    "content_filter",
  ]) {
    const f = friendlyFromCategory(cat, "{}")
    expect(f.fix, cat).toBeTruthy()
  }
})

test("detail yang sama dengan pesan dasar tidak diulang dua kali", () => {
  const f = friendlyFromCategory(
    "rate_limit",
    '{"error":{"message":"Provider is rate-limiting requests"}}',
  )
  const occurrences = f.message.split("rate-limiting").length - 1
  expect(occurrences).toBe(1)
})

test("redactSecrets menutup format kunci provider + JWT + query (bug-hunt)", () => {
  // Kode lama: hanya Bearer/kv — echo proxy key konkret lolos mentah ke layar.
  const f = friendlyFromCategory(
    "unknown",
    "proxy says sk-ant-probe-1234567890abcdef and thk_live_probe12345678901234 and TOKEN",
  )
  expect(f.message).not.toContain("sk-ant-probe")
  expect(f.message).not.toContain("thk_live_probe")
  const j = friendlyError(
    "oops eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c boom",
  )
  expect(j.message).not.toContain("eyJhbGciOi")
  const q = friendlyFromCategory("unknown", "denied https://h.test/?api_key=SECRET42 rec")
  expect(q.message).not.toContain("SECRET42")
  expect(q.message).toContain("api_key=[redacted]")
})

// ── Audit TUI P1-1: pesan error provider = teks tak terpercaya ───────────────
// Proxy jahat bisa menggemakan escape (bersihkan layar, alternate screen) di
// body error yang lalu dirender writer mentah cli/. Kode lama meloloskan
// utuh; kode baru sanitize satu-baris di errors.ts.
test("friendlyFromCategory: escape di detail provider dibuang, teks kept", () => {
  const evil = '{"error":{"message":"boom\x1b[2J\x1b[H\x1b[?1049h ha"}}'
  const f = friendlyFromCategory("unknown", evil)
  expect(f.message).toContain("boom")
  expect(f.message).not.toContain("\x1b[2J")
  expect(f.message).not.toContain("1049")
  expect(f.message).not.toContain("\x1b[H")
})

test("friendlyFromCategory: judul HTML ber-ANSI tetap satu baris bersih", () => {
  const f = friendlyFromCategory(
    "server",
    "<html><head><title>down\x1b]0;pwned\x07 | 502</title></head></html>",
  )
  expect(f.message).not.toContain("\x1b]")
  expect(f.message).toContain("502")
})

test("friendlyError: potong CJK per kolom (bukan karakter)", () => {
  // 100 emoji = 200 kolom + prefix; kode lama slice 157 char (=321 kolom).
  const m = friendlyError(`gagal: ${"🔥".repeat(100)}`).message
  expect(displayWidth(m)).toBeLessThanOrEqual(160)
  expect(m.endsWith("…")).toBe(true)
})

// ── usage collector: effective model dari fallback ──
test("usage: effective-model event changes cost basis", () => {
  const bus = createEventBus()
  const collector = createUsageCollector(bus, "gpt-4o")

  // simulate substitution (router fallback): gpt-4o dipakai, tapi provider
  // hanya punya deepseek-chat → router memilih effective deepseek-chat
  bus.emit({
    type: "provider:extension",
    kind: "effective-model",
    data: { requested: "gpt-4o", effective: "deepseek-chat", provider: "fallback-x" },
  })
  bus.emit({
    type: "provider:extension",
    kind: "usage",
    data: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
  })

  const used = collector.modelUsed()
  expect(used.effective).toBe("deepseek-chat")
  expect(used.provider).toBe("fallback-x")

  const u = collector.get("gpt-4o")
  // deepseek-chat: input 0.14/m, output 0.28/m → 0.14 + 0.28 = 0.42
  expect(u.cost).toBeCloseTo(0.42, 3)
})

test("usage: reset clears effective model", () => {
  const bus = createEventBus()
  const collector = createUsageCollector(bus, "gpt-4o")
  bus.emit({
    type: "provider:extension",
    kind: "effective-model",
    data: { requested: "x", effective: "y", provider: "z" },
  })
  collector.reset()
  expect(collector.modelUsed().effective).toBeUndefined()
})

// ── C18: pricing boundary matching ──────────────────────────────────────────

test("pricing: exact and versioned model names match", () => {
  // exact — gpt-4o $2,50/M input. Tabel lama menulis $5,00 (harga peluncuran
  // Mei 2024, sudah dipotong separuh Agustus 2024), jadi estimasi biaya
  // selama ini 2× terlalu tinggi untuk model ini. Dikoreksi di Fase 4.3.
  expect(costFor("gpt-4o", 1_000_000, 0, 0, 0, false)).toBeCloseTo(2.5, 6)
  // sufiks versi (pemisah -)
  expect(costFor("gpt-4o-2024-11-20", 1_000_000, 0, 0, 0, false)).toBeCloseTo(2.5, 6)
  // prefix provider openrouter
  expect(costFor("deepseek/deepseek-chat", 1_000_000, 0, 0, 0, false)).toBeCloseTo(0.14, 6)
  // varian :free benar-benar gratis, bukan mewarisi harga varian berbayar
  expect(costFor("deepseek/deepseek-chat:free", 1_000_000, 0, 0, 0, false)).toBe(0)
  // longest-key menang: claude-sonnet-4-5, bukan claude-sonnet-4
  expect(costFor("claude-sonnet-4-5", 1_000_000, 0, 0, 0, false)).toBeCloseTo(3, 6)
})
