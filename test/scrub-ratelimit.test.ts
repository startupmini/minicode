import { expect, test } from "bun:test"
import { createRateLimiter, RateLimiter } from "../src/policy/ratelimit.ts"
import { scrubSecrets } from "../src/policy/scrub.ts"

test("scrub: OpenAI-style key redacted", () => {
  expect(scrubSecrets("key is sk-abc123XYZ987abc123XYZ987abc123")).toContain("[REDACTED]")
  expect(scrubSecrets("key is sk-abc123XYZ987abc123XYZ987abc123")).not.toContain("sk-abc123")
})

test("scrub: private key block redacted", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"
  expect(scrubSecrets(`secret:\n${pem}`)).toContain("[REDACTED]")
  expect(scrubSecrets(`secret:\n${pem}`)).not.toContain("BEGIN RSA")
})

test("scrub: Bearer token and JWT redacted", () => {
  const txt = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789"
  expect(scrubSecrets(txt)).toContain("[REDACTED]")
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
  expect(scrubSecrets(jwt)).toContain("[REDACTED]")
})

test("scrub: api_key=value redacted, normal text unchanged", () => {
  expect(scrubSecrets('const api_key = "abcdefghijklmnopqrstuvwxyz123456"')).toContain("[REDACTED]")
  expect(scrubSecrets("just normal code: const x = 1;")).toBe("just normal code: const x = 1;")
})

test("scrub: no test/example/mock whitelist bypass (C5)", () => {
  // secret yang mengandung kata whitelist tidak boleh lolos redaksi
  expect(scrubSecrets('password = "test12345678901234"')).toContain("[REDACTED]")
  expect(scrubSecrets("key is sk-test123456789012345678")).toContain("[REDACTED]")
  expect(scrubSecrets("Bearer mockabcdefghijklmnopqrstu")).toContain("[REDACTED]")
})

test("scrub: env reference (process.env.X) NOT redacted", () => {
  const txt = "const key = process.env.OPENAI_API_KEY;"
  expect(scrubSecrets(txt)).toBe(txt)
})

test("scrub: gateway tokens thk_live_* dan hf_* redacted", () => {
  // Temuan red-team: kunci TokenHarbor/HuggingFace lolos pola umum.
  expect(scrubSecrets("token thk_live_abc123XYZ987abc123XYZ987")).toContain("[REDACTED]")
  expect(scrubSecrets("token thk_live_abc123XYZ987abc123XYZ987")).not.toContain("thk_live_")
  expect(scrubSecrets("hf_abcdefghijklmnopqrstuvwxyz1234567890")).toContain("[REDACTED]")
  // Prosa biasa tanpa pola kunci tidak tersentuh.
  expect(scrubSecrets("the chef cooks")).toBe("the chef cooks")
})

test("ratelimit: burst up to capacity then throttles", async () => {
  const rl = new RateLimiter(2, 10 / 1000) // cap 2, refill 10 token/s
  const t0 = Date.now()
  await rl.acquire()
  await rl.acquire()
  await rl.acquire() // bucket kosong → tunggu ~100ms
  const elapsed = Date.now() - t0
  expect(elapsed).toBeGreaterThanOrEqual(50)
})

test("ratelimit: createRateLimiter info reflects rpm", async () => {
  const rl = createRateLimiter(60)
  const info = rl.info()
  expect(info.rpm).toBe(60)
  expect(info.available).toBeLessThanOrEqual(10) // burst cap 10
})
