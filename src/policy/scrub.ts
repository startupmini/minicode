// Secret scrubber — redact credential/token/private key sebelum konten sampai ke LLM.
// Dipanggil dari tool read_file, bash, grep, dan memory (best-effort, defense-in-depth).

const SECRET_PATTERNS: RegExp[] = [
  // OpenAI / DeepSeek / Anthropic api keys
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
  /\b(dsk-[A-Za-z0-9_-]{20,})\b/g,
  // Gateway tokens (TokenHarbor thk_live_*, HuggingFace hf_*) — terlihat di
  // alam liar (red-team eksternal): format khas provider tanpa pola umum.
  /\b(thk_live_[A-Za-z0-9_-]{16,})\b/g,
  /\b(hf_[A-Za-z0-9]{20,})\b/g,
  // Generic OpenAI-compatible (DeepSeek may use similar)
  /\b(AIza[A-Za-z0-9_-]{35,})\b/g,
  // GitHub tokens (all variants)
  /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  // AWS access key
  /\b(AKIA[0-9A-Z]{16})\b/g,
  // Private key PEM blocks — lazy dot-all, aman karena terbatas ukuran file (2MB)
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
  // Generic api_key / secret / token = <value> — whitelist test/example/mock
  /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}["']?/gi,
  // Database connection strings with password
  /\b(?:postgresql|postgres|mysql|mongodb|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi,
  // Bearer token header
  /\bbearer\s+[A-Za-z0-9._-]{20,}\b/gi,
  // Bearer token header — BENTUK SPASI PENDEK (temuan audit #10 §11,
  // reproducer: header Authorization Bearer yang pendek lolos karena pola
  // di atas butuh 20+ char). Min 8 char agar prosa ("Bearer token") tak ikut.
  /\bbearer\s+["']?[A-Za-z0-9._~+/-]{8,}["']?/gi,
  // Cookie / session id — nilai sesi adalah bearer-equivalent (audit #10 §11).
  // Hanya bila berbentuk `key=value`/`key: value` agar prosa aman. `cookie`
  // case-insensitive; `sessionid` SENGAJA case-sensitive-lowercase (audit #11
  // §18: bentuk insensitif ikut menyamarkan identifier `sessionId`/`session`
  // di output tool — mis. `sessionId: string` — padahal itu bukan kredensial).
  // Guard nilai quoted/berdigit/panjang (audit #11 §18: SQL `session_id = ?`
  // ikut tersamarkan sebelumnya; placeholder 1-char kini lolos).
  /\bcookie\s*[:=]\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9_~+/=-]*\d[A-Za-z0-9_~+/=-]*|[A-Za-z0-9_~+/=-]{4,})/gi,
  /\bsession[-_]?id\s*[:=]\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9_~+/-]*\d[A-Za-z0-9_~+/-]*|[A-Za-z0-9_~+/-]{4,})/g,
  // Header kredensial bernilai PENDEK (audit #10 §11, reproducer:
  // header X-Api-Key bernilai pendek lolos karena pola generik butuh 16+ char).
  // Nama header eksplisit ⇒ nilai pendek pun aman disamarkan — TETAPI nilai
  // harus berbentuk kredensial (audit #11 §18: tanpa guard, anotasi TS
  // `apiKey: string` dan `apiKey = getArg(...)` ikut tersamarkan sehingga
  // model buta membaca kode sendiri). Guard nilai: quoted ATAU berdigit ATAU
  // panjang (identifier/type-word lolos; kredensial realistis kena).
  /\b(?:x-(?:api-?key|auth-?token)|api-?key)\s*[:=]\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9_~+/-]*\d[A-Za-z0-9_~+/-]*|[A-Za-z0-9_~+/-]{12,})/gi,
  // password/secret bernilai pendek. Guard nilai yang sama (audit #11 §18:
  // `secret = graphemes.join("")` di kode ikut tersamarkan sebelumnya).
  /\b(?:password|passwd|secret)\s*[:=]\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9_~+/-]*\d[A-Za-z0-9_~+/-]*|[A-Za-z0-9_~+/-]{12,})/gi,
  // Baris env-dump yang NAMANYA mengandung penanda kredensial (audit #10 §12:
  // bentuk NAME=VALUE semacam itu lolos sebelum pola ini ada).
  // Case-sensitive + ALL-CAPS agar prosa tak ikut. Nilai wajib berhuruf
  // (audit #11 §18: konstanta numerik `*_TOKENS = 128_000` ikut tersamarkan),
  // tak diawali `/` (sumber regex `PATTERN = /.../` ikut tersamarkan),
  // tanpa kurung (listing `TOKENS = {` selamat), dan total ≥4 char
  // (`NAME = new RegExp(` di kode sendiri ikut tersamarkan sebelumnya).
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWD|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIALS|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_KEY)[A-Z0-9_]*\s*=\s*(?!\/)["']?[A-Za-z0-9._~+/$-]*[A-Za-z][A-Za-z0-9._~+/$-]{3,}["']?/g,
  // Slack tokens
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  // NPM tokens
  /\b(npm_[A-Za-z0-9]{36,})\b/g,
  // JWT — any base64url payload
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
]

// Query-param kredensial di URL (audit #10 §10, reproducer: query
// api_key bernilai pendek lolos karena pola `api_key=` butuh 16+ char).
// Nama param dipertahankan untuk diagnostik, nilainya yang disamarkan —
// karena itu polanya diaplikasikan TERPISAH dengan replacement `$1[REDACTED]`.
const QUERY_PARAM_RE =
  /([?&](?:api[_-]?key|apikey|token|auth[_-]?token|access[_-]?token|secret|client[_-]?secret|password|sig(?:nature)?)=)[^&\s"'<>]*/gi

// Redact secrets dalam teks. Ganti match dengan [REDACTED].
// Tidak ada whitelist kata (test/example/mock) — secret sungguhan bisa saja
// mengandung substring itu; false-positive redaction lebih aman daripada leak.
export function scrubSecrets(text: string): string {
  if (!text) return text
  let out = text.replace(QUERY_PARAM_RE, "$1[REDACTED]")
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]")
  return out
}

// Env vars yang namanya cocok pola kredensial di-strip sebelum spawn proses
// (bash / docker / MCP server / LSP server) — kurangi permukaan exfiltration.
//
// Pola sebelumnya memuat nama vendor telanjang (`GITHUB`, `GOOGLE`, `AZURE`,
// `REDIS`, `SUPABASE`), sehingga variabel non-rahasia yang kebetulan mengandung
// nama itu juga hilang: `GITHUB_WORKSPACE`, `GITHUB_REF`, `GITHUB_SHA`,
// `GOOGLE_CHROME_PATH`, `AZURE_CONFIG_DIR`. Di CI itu memecahkan build karena
// subprocess kehilangan konteks yang dibutuhkannya.
//
// Sekarang: cocokkan berdasarkan **kata-kunci kredensial**, dan untuk nama
// vendor hanya bila diikuti/didahului penanda rahasia. Prinsipnya sama —
// jangan wariskan secret — tapi tanpa memakan variabel yang jelas bukan secret.
const CREDENTIAL_WORD =
  "(?:API[_-]?KEYS?|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|CREDENTIALS?|AUTH|BEARER|SESSION[_-]?KEY|ENCRYPTION[_-]?KEY|SIGNING[_-]?KEY|CLIENT[_-]?SECRET|REFRESH[_-]?TOKEN|DSN|CONNECTION[_-]?STRING|_PAT\\b)"

// Nama provider LLM: variabel apa pun yang diawali ini praktis selalu kunci
// (mis. `OPENAI_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `DEEPSEEK_API_KEY`).
const LLM_VENDOR =
  "(?:OPENAI|ANTHROPIC|DEEPSEEK|GEMINI|MISTRAL|GROQ|TOGETHER|FIREWORKS|COHERE|TAVILY|OPENROUTER|HUGGINGFACE|HF)"

export const SECRET_ENV_RE = new RegExp(
  [
    CREDENTIAL_WORD, // mengandung kata kredensial di mana pun
    `^${LLM_VENDOR}_`, // kunci provider LLM
    "^(?:AWS|GCP|AZURE|GITHUB|GITLAB|SUPABASE|STRIPE|TWILIO|SENDGRID|SLACK|NPM|DOCKER)_[A-Z0-9_]*" +
      `${CREDENTIAL_WORD}`, // vendor + penanda rahasia, bukan vendor telanjang
    "^(?:DATABASE|POSTGRES|POSTGRESQL|MYSQL|MONGO|MONGODB|REDIS)_(?:URL|URI|PASSWORD|DSN)$",
    "^AGENT_[A-Z_]*KEY$",
  ].join("|"),
  "i",
)

export function stripSecretsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_RE.test(k)) continue
    out[k] = v
  }
  return out
}

// Satu pintu env utk semua spawn (docker/mcp/lsp/bash): merge base+extra lalu
// strip kredensial dari HASIL AKHIR — extra tidak bisa me-reintroduce secret
// dan base tak pernah lolos tanpa filter.
export function sanitizeSpawnEnv(
  base: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): Record<string, string> {
  const merged: NodeJS.ProcessEnv = { ...base, ...(extra ?? {}) }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(stripSecretsEnv(merged))) {
    if (v !== undefined) out[k] = v
  }
  return out
}
