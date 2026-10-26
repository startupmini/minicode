import { describe, expect, test } from "bun:test"
import { SECRET_ENV_RE, sanitizeSpawnEnv, stripSecretsEnv } from "../src/policy/scrub.ts"

describe("env sanitization (C1)", () => {
  test("stripSecretsEnv removes credential-named vars", () => {
    const env = {
      OPENAI_API_KEY: "sk-x",
      DEEPSEEK_API_KEY: "ds-x",
      AWS_SECRET_ACCESS_KEY: "aws-x",
      DATABASE_URL: "postgres://u:p@h/db",
      MY_TOKEN: "t",
      PATH: "C:\\bin",
      SystemRoot: "C:\\Windows",
      HOME: "/home/u",
    }
    const out = stripSecretsEnv(env) as Record<string, string>
    expect(out.OPENAI_API_KEY).toBeUndefined()
    expect(out.DEEPSEEK_API_KEY).toBeUndefined()
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(out.DATABASE_URL).toBeUndefined()
    expect(out.MY_TOKEN).toBeUndefined()
    // non-secret infra vars tetap ada (docker.exe/lsp butuh PATH dll)
    expect(out.PATH).toBe("C:\\bin")
    expect(out.SystemRoot).toBe("C:\\Windows")
    expect(out.HOME).toBe("/home/u")
  })

  test("sanitizeSpawnEnv strips secrets from the FINAL merge", () => {
    const base = { PATH: "/usr/bin", OPENAI_API_KEY: "sk-base" }
    const extra = { FOO: "bar" }
    const out = sanitizeSpawnEnv(base as NodeJS.ProcessEnv, extra)
    expect(out.FOO).toBe("bar")
    expect(out.PATH).toBe("/usr/bin")
    expect(out.OPENAI_API_KEY).toBeUndefined()
  })

  test("extra cannot re-introduce a secret past sanitizeSpawnEnv", () => {
    const out = sanitizeSpawnEnv({ A: "1" } as NodeJS.ProcessEnv, {
      ANTHROPIC_API_KEY: "sk-evil",
    })
    expect(out.ANTHROPIC_API_KEY).toBeUndefined()
    expect(out.A).toBe("1")
  })

  test("SECRET_ENV_RE coverage sanity", () => {
    for (const k of ["GITHUB_TOKEN", "client_secret", "privateKey", "ACCESS_KEY_ID"])
      expect(SECRET_ENV_RE.test(k)).toBe(true)
    for (const k of ["PATH", "LANG", "EDITOR", "SHELL"]) expect(SECRET_ENV_RE.test(k)).toBe(false)
  })
})

// Bug (Agent B track, 2026-10-22): aturan "kunci provider LLM" dulu cocokkan
// prefix vendor POLOS (`^OPENAI_`, `^HF_`, ...), jadi SETIAP variabel yang
// diawali vendor ikut dibuang — termasuk konfigurasi yang jelas bukan secret:
// `OPENAI_BASE_URL` (gateway kustom), `OPENAI_ORG_ID`, `OPENAI_PROJECT`,
// `HF_HOME`, `HUGGINGFACE_HUB_CACHE`. Akibatnya child process (MCP/LSP/docker)
// kehilangan konfigurasi yang dibutuhkan, termasuk env yang EKSPLISIT
// dikonfigurasi pengguna untuk MCP/LSP server (sanitizeSpawnEnv men-strip
// hasil akhir merge).
//
// Kontrak yang dimaksud modul ini (lihat komentar di atas CREDENTIAL_WORD):
// "untuk nama vendor hanya bila diikuti/didahului penanda rahasia". Bentuk
// barunya sama dengan aturan vendor lain (AWS/GCP/...): vendor + penanda
// rahasia, bukan vendor polos.
describe("env sanitization — batas prefix vendor (Agent B 2026-10-22)", () => {
  test("kredensial ber-prefix vendor LLM tetap dibuang", () => {
    for (const k of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "DEEPSEEK_API_KEY",
      "GEMINI_API_KEY",
      "MISTRAL_API_KEY",
      "GROQ_API_KEY",
      "TOGETHER_API_KEY",
      "FIREWORKS_API_KEY",
      "COHERE_API_KEY",
      "TAVILY_API_KEY",
      "OPENROUTER_API_KEY",
      "HUGGINGFACE_API_TOKEN",
      "HF_TOKEN",
    ]) {
      expect(SECRET_ENV_RE.test(k), k).toBe(true)
      expect(stripSecretsEnv({ [k]: "v" } as NodeJS.ProcessEnv)[k], k).toBeUndefined()
    }
  })

  test("konfigurasi ber-prefix vendor LLM TIDAK dibuang", () => {
    for (const k of [
      "OPENAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
      "OPENAI_ORG_ID",
      "OPENAI_PROJECT",
      "HF_HOME",
      "HUGGINGFACE_HUB_CACHE",
      "GROQ_ORG_ID",
      "MISTRAL_ORGANIZATION",
      "ANTHROPIC_MODEL",
    ]) {
      expect(SECRET_ENV_RE.test(k), k).toBe(false)
      expect(stripSecretsEnv({ [k]: "v" } as NodeJS.ProcessEnv)[k], k).toBe("v")
    }
  })

  test("aturan vendor non-LLM tak berubah", () => {
    for (const k of [
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "STRIPE_API_KEY",
      "NPM_TOKEN",
      "DOCKER_PASSWORD",
      "DATABASE_URL",
    ]) {
      expect(SECRET_ENV_RE.test(k), k).toBe(true)
    }
    for (const k of [
      "AWS_REGION",
      "AWS_PROFILE",
      "GITHUB_WORKSPACE",
      "GITHUB_REF",
      "GOOGLE_CHROME_PATH",
      "AZURE_CONFIG_DIR",
      "REDIS_HOST",
      "SUPABASE_URL",
    ]) {
      expect(SECRET_ENV_RE.test(k), k).toBe(false)
    }
  })

  test("env eksplisit untuk MCP/LSP server diteruskan, rahasianya tetap dibuang", () => {
    const out = sanitizeSpawnEnv({ PATH: "/bin" } as NodeJS.ProcessEnv, {
      OPENAI_BASE_URL: "https://gw.internal/v1",
      HF_HOME: "/cache",
      OPENAI_API_KEY: "sk-evil",
    })
    // Konfigurasi yang diminta eksplisit HARUS sampai ke child process.
    expect(out.OPENAI_BASE_URL).toBe("https://gw.internal/v1")
    expect(out.HF_HOME).toBe("/cache")
    // ...tapi rahasianya tetap tak ikut.
    expect(out.OPENAI_API_KEY).toBeUndefined()
    expect(out.PATH).toBe("/bin")
  })
})
