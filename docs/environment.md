# Environment Variables

Variabel yang paling menentukan perilaku (sisanya referensi di bawah):

- **Batas otonomi di mesin sendiri:** `MINICODE_SANDBOX` + `MINICODE_SANDBOX_STRICT=1` (tolak bash bila isolasi tak ada) + `MINICODE_BUDGET_STRICT=1` (cost tak dikenal = over budget).
- **Privasi/minim jejak:** `MINICODE_TELEMETRY=0` (tanpa traces), `MINICODE_AUTO_MEMORY=0` (tanpa auto-simpan memori).
- **Repo asing:** JANGAN set `MINICODE_ALLOW_LOCAL_CONFIG=1` kecuali workspace milik Anda.
- **Konsol lawas/aksesibilitas:** `MINICODE_ASCII=1`, `MINICODE_A11Y=1`, `MINICODE_BELL=0`, `NO_COLOR`.

## Runtime & limits

| Variabel | Fungsi |
|---|---|
| `MINICODE_TIMEOUT_MS` | Default timeout (ms) bila `--timeout` tidak diset; `0` = Infinity |
| `MINICODE_PLAN` | `1` → mode plan (tanpa `--plan`) |
| `MINICODE_PERMISSION` | `allowlist` → mode permission |
| `MINICODE_TOOL_SCOPE` | `explore` → subset read-only 12 tool (sama `--tool-scope explore`) |
| `MINICODE_HOOKS` | `1` → jalankan hook `pre/post-run` dari `~/.minicode/hooks/*.js` & `.minicode/hooks/*.js` (konteks di env `MINICODE_HOOK_CTX`; env hook disanitasi tanpa secret; dilewati bila sesi dibatalkan) |
| `MINICODE_SESSION_TTL_DAYS` | TTL sesi (default 30; `0` = selamanya) |
| `MINICODE_HOME` | Override home untuk DB lokal/global (sessions + vector); default `~` |
| `MINICODE_TELEMETRY` | `0`/`false`/`off` → matikan penulisan traces.jsonl |
| `MINICODE_VERIFY_CMD` | Custom verify command (ganti `detectVerifyCommand`) |
| `MINICODE_BASH_ALLOWLIST` | Kustom allowlist bash (koma-pisah, ganti DEFAULT) |

## Bahasa, diagnosis & kunci

| Variabel | Fungsi |
|---|---|
| `MINICODE_LANG` | `en`/`id` → bahasa UI (prioritas lengkap di kontrak terminal §i18n: `/lang` > env ini > state.json > locale OS > en) |
| `MINICODE_DEBUG_STARTUP` | `1` → cetak durasi tiap tahap setup sesi ke stderr (diagnosis startup lambat; diagnostik saja, bukan perilaku) |
| `MINICODE_MINIMIZE_ANSWER` | set (nilai apa pun) → JANGAN auto-minimize section jawaban model (nilai unset = minimize default) |
| `MINICODE_KEYSTORE_DISABLE` | `1` → matikan keystore OS seluruhnya (jatuh ke penyimpanan file; untuk CI/headless yang tak punya keychain/DPAPI) |
| `MINICODE_KEYSTORE_FORCE_DPAPI` | set (nilai apa pun) → paksa jalur DPAPI/Windows walau di non-Windows (khusus test portabilitas; bukan konfigurasi produksi) |
| `MINICODE_MINIMIZE_TOOL` | set (nilai apa pun) → JANGAN auto-minimize section tool di TUI (nilai unset = minimize default) |

## Sandbox

| Variabel | Fungsi |
|---|---|
| `MINICODE_SANDBOX` | `docker` \| `os` (alias `bwrap`/`seatbelt`) \| `none` |
| `MINICODE_SANDBOX_STRICT` | `1` → tak pernah fallback host (redundan dengan default fail-closed untuk request eksplisit, tetap dihormati) |
| `MINICODE_SANDBOX_ALLOW_FALLBACK` | `1` → satu-satunya jalan fallback host yang sadar bila backend tak tersedia |
| `MINICODE_SANDBOX_IMAGE` | Image Docker (default `node:22-alpine` — hanya bawa node; python butuh image sendiri) |
| `MINICODE_SANDBOX_MEMORY` | Memory cap (default `512m`) |
| `MINICODE_GREP_ENGINE` | `js` → paksa walker internal, jangan pakai ripgrep |

## Provider & memory

| Variabel | Fungsi |
|---|---|
| `MINICODE_PROVIDER_ORDER` | Urutkan provider agnostik tanpa edit config: `openai,anthropic,deepseek` |
| `MINICODE_EMBED_MODEL` | Model embedding untuk memory/vector (default `text-embedding-3-small`) |
| `MINICODE_COMPACT_KEEP_TURNS` | Override keepRecentTurns kompaksi (bilangan ≥1; invalid → default kernel + warn) |
| `MINICODE_MEMORY_SCOPE` | Scope baca memory: `cwd` (default) \| `global` \| `all` (gabung, tanpa silent shadowing) |
| `MINICODE_AUTO_MEMORY` | `0` → matikan auto-simpan summary/snippet ke memory (opt-out) |
| `MINICODE_REPOMAP` | `regex` → paksa repo-map regex (skip LSP) |
| `TAVILY_API_KEY` | API key untuk Tavily web_search (fallback DuckDuckGo bila kosong) |

## Budget & config

| Variabel | Fungsi |
|---|---|
| `MINICODE_BUDGET_STRICT` | `1` → penegasan eksplisit fail-closed (cost tak dikenal + pemakaian = over; kini juga default `--budget`) |
| `MINICODE_ALLOW_LOCAL_CONFIG` | `1` → percayai config lokal workspace (default: diabaikan) |

## Terminal & aksesibilitas

| Variabel | Fungsi |
|---|---|
| `MINICODE_ASCII` | `1` → paksa glyph ASCII (`[OK]`, `>`, `.`) untuk konsol tanpa UTF-8 |
| `MINICODE_COMPACT` | `1` → tool call ringkas, `0` → expanded. Default: compact di sesi interaktif, expanded di one-shot/exec (juga `/compact`, Ctrl+O) |
| `MINICODE_JUSTIFY` | `0` → matikan rata kanan-kiri pada keluaran teks model |
| `MINICODE_DROPDOWN` | `0` → matikan floating dropdown, pakai hint inline (konsol legacy) |
| `MINICODE_MOTION` | `0` → matikan animasi status (pulse spark saat turn berjalan jadi glyph statis) — aksesibilitas/rekaman layar/SSH lambat |
| `MINICODE_BELL` | `0` → matikan bell `\x07` saat approval (aksesibilitas) |
| `MINICODE_STATUSLINE` | `rich` → statusline turn menampilkan token kumulatif + biaya sesi (default hemat) |
| `MINICODE_A11Y` | `1` → live-region approval untuk screen reader (baris polos tanpa ANSI) |
| `MINICODE_SHOW_THINKING` | `1` → tampilkan reasoning model (`--verbose` atau env) |
| `MINICODE_THINKING` | `off` → kirim `enable_thinking:false` ke OpenAI-compat (DeepSeek) |
| `NO_COLOR` | Set apa pun selain `0` → matikan seluruh warna |

## API key fallback

| Variabel | Fungsi |
|---|---|
| `AGENT_API_KEY`, `AGENT_BASE_URL`, `AGENT_MODEL` | Fallback generik OpenAI-compat (dipakai provider-layer, memory, task) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` | Fallback API key |
| `DEEPSEEK_BASE_URL` | Base URL DeepSeek (default `https://api.deepseek.com/v1`, untuk compaction) |
| `ANTHROPIC_MODEL` | Model Anthropic bila tidak diset eksplisit |

## Lanjut

- [CLI](cli.md) — padanannya dalam bentuk flag `--`.
- [Config](config.md) — config file + lokasi data.
- [Keamanan](security.md) — env scrub subprocess.
