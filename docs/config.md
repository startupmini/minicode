# Config & Provider

Di mana pengaturan dan data Minicode tinggal, bagaimana file lokal yang tak tepercaya diperlakukan, dan provider mana yang bisa dipakai.

## Skema `.minicode/config.json`

```json
{
  "providers": [{
    "id": "my-provider", "baseUrl": "...", "apiKey": "...",
    "models": ["gpt-4o"], "contextWindows": { "gpt-4o": 128000, "*": 32000 }
  }],
  "mcpServers": [
    { "id": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] },
    { "id": "remote", "url": "https://mcp.example.com/mcp", "headers": { "authorization": "Bearer xxx" } }
  ],
  "lspServers": [{ "ext": ".ts", "command": "typescript-language-server", "args": ["--stdio"] }],
  "verifyCommand": "bun run typecheck",
  "bashAllowlist": ["git status*", "bun test*", "npm run build*"]
}
```

- `providers` — bisa juga diisi lewat wizard/`minicode config add`/`/provider`; lihat daftar preset di bawah.
- `providers[].contextWindows` — batas konteks dalam token per model; exact model ID menang, lalu key `"*"` menjadi fallback provider. Nilai harus integer positif. Karena gateway memakai alias model, MiniCode memakai **default konservatif 128K** untuk alias generik (`auto`/`best`/...) dan **32K** untuk model tak dikenal lainnya; jendela eksak tersedia lewat katalog built-in (keluarga umum), overlay `minicode pricing sync` (models.dev), dan **tokenizer presisi on-demand** dari HuggingFace untuk model open. `--context-window` mengalahkan nilai config selama sesi itu.
- `mcpServers` — dua bentuk: stdio (`command`+`args`) dan HTTP (`url`+opsional `headers`). Detail transport di [MCP & LSP](mcp-lsp.md).
- `verifyCommand` — dipakai `--verify` bila auto-detect tidak menemukan (urutan deteksi: `typecheck` → `test` → `tsconfig`).
- `bashAllowlist` — pola koma/pola glob perintah bash yang dianggap aman (mode `allowlist`).

## 15 preset gateway (termasuk Custom URL)

`Gateway >` hanya menampilkan `[0] Label` tanpa URL (minimalis, tanpa bocor endpoint).

| id | Label | Catatan |
|---|---|---|
| `openai` | OpenAI | gpt, o-series |
| `anthropic` | Anthropic | Claude, streaming `tool_use` |
| `openrouter` | OpenRouter | Gateway 75+ model |
| `deepseek` | DeepSeek | chat/reasoner |
| `opencode-zen` | OpenCode Zen | Gateway |
| `google` | Google Gemini | Konteks 1M, `thought_signature` pass-through |
| `ollama` | Ollama | Lokal, gratis, tanpa key |
| `qwen` | Qwen | Alibaba Qwen3-Coder (satu-satunya dengan spec OAuth terdaftar) |
| `groq` | Groq | Inferensi cepat |
| `together` | Together AI | Model terbuka |
| `fireworks` | Fireworks AI | — |
| `mistral` | Mistral AI | — |
| `cohere` | Cohere | — |
| `generic` | OpenAI-compatible umum | vLLM / LM Studio |
| `custom` | Custom URL | Pseudo-preset untuk baseUrl sendiri |

Alur: wizard & `/provider` (add `[0] OpenAI` … `[14] Custom URL`) → API key ter-masking → auto-detect models via `GET /models` timeout 4 dtk → provider otomatis pindah saat pilih model beda provider (tanpa restart, via `reloadProviders()` setelah `Gateway >2`).

## Dua jalur autentikasi

```bash
# 1. API key
minicode config add --baseUrl https://api.openai.com/v1 --apiKey sk-…

# 2. OAuth device-code (tanpa API key, tanpa kartu kredit) — RFC 8628
minicode auth list            # provider yang mendukung
minicode auth login qwen      # kode singkat → buka URL → tunggu persetujuan
minicode auth status          # kredensial + kapan kedaluwarsa
minicode auth logout qwen
```

Token di `~/.minicode/auth.json` (chmod 600), bukan `config.json`. Refresh otomatis margin 60 dtk. Provider OAuth yang belum login dibuang dari daftar dengan peringatan, bukan dikirim dengan header kosong.

> Kejujuran: device flow teruji lengkap ke server OAuth lokal (pending/slow_down/denied/expired/clamp), tapi endpoint/clientId provider belum semua terkonfirmasi live. `auth login chatgpt` fail-fast di non-TTY. Jangan baca token aplikasi desktop orang lain — itu pencurian kredensial.

## Keyring OS (ganti plaintext config)

```bash
minicode config set-key openrouter      # pindah API key ke OS store, config tinggal referensi
minicode config delete-key openrouter   # lupakan (provider nonaktif sampai di-set ulang)
```

Windows memakai DPAPI user-scope (hanya user ini yang bisa membuka); selain itu berkas chmod 600 dengan label jujur `plain-file` (bukan keyring). Referensi hilang/rusak = provider di-skip dengan peringatan (fail-closed, seperti OAuth). Matikan paksa via `MINICODE_KEYSTORE_DISABLE=1`.

## Model & thinking effort

```
/model [cari]   → picker provider::model, bisa difilter
Enter           → pilih model (+ picker effort bila modelnya mendukung)
Esc             → batal total
```

Effort tersimpan di `ProviderEntry.reasoningEffort`, berlaku sesi berikutnya, tampil badge `[low|medium|high]`. **Default universal = omit** (tanpa param thinking): default bawaan tiap model sudah di-tune vendornya. Knob hanya dikirim ke keluarga terbukti, dalam bahasa native-nya: OpenAI reasoning (`o1`/`o3`/`o4`, `gpt-5`/`gpt-6` → `reasoning_effort`, level tervalidasi per model — pro = high saja); Claude ≤4.5 → budget `1024/2048/4096`; Claude ≥4.6/5 → adaptive + `output_config.effort`. **Selain itu tak pernah dikirimi param thinking** (DeepSeek, Gemini, Groq, Ollama, free-tier, custom). Bila model menolak param (400/500), request diulang sekali tanpa param + diingat per sesi + dicatat `[thinking]` di stderr. Picker effort hanya muncul untuk model yang mendukung; sisanya select langsung tanpa menyentuh effort tersimpan. `detectAndSave`/`auth login` mempertahankan effort (tidak reset diam-diam). Mutasi ditulis ke file scope asal (bukan hasil merge) agar tidak duplikat/shadowing.

Model override sekali jalan:

```bash
minicode --model providerId::modelName "prompt"
minicode --provider openai "prompt"
minicode models --match gemini
```

`MINICODE_PROVIDER_ORDER=openai,anthropic,deepseek` mengurutkan provider agnostik tanpa edit config.

## Pin eksplisit `provider::model` (kontrak)

Model berformat `providerId::modelName` = PIN: request hanya ke provider
itu — **tanpa fallback lintas provider dan tanpa substitusi diam-diam**.
Gagal = error jujur dari provider yang dipilih (limit/saldo/error server),
user memilih model lanjutannya sendiri via `/model`. Alasan: fallback
otomatis pernah melempar user dari model gratis ke model berbayar provider
lain (tagihan tak terduga). Model bare (tanpa `::`) tetap perilaku lama
(first-match + substitusi + fallback rate_limit/server/network).

## Build & router

Build provider terpusat di `src/providers/build.ts`. Router fallback untuk rate_limit/server/network (clone-error + base64 fix + retryAfter cap). Deteksi wire dari probe path `/responses` → hint `responses`; substring host hanya fallback. `max_tokens` 8192; stop `length` = peringatan eksplisit, bukan teks sunyi.

Responses API: `/v1/responses`, `previous_response_id` chaining per model, `store:false` default.

## Global vs lokal

| File | Lokasi | Catatan |
|---|---|---|
| Global | `~/.minicode/config.json` | Berlaku semua workspace |
| Lokal | `.minicode/config.json` | Per repo; **diabaikan secara default** — aktif dengan `--allow-local-config` / `MINICODE_ALLOW_LOCAL_CONFIG=1` |

Merge dengan **prioritas lokal menang**. Mutasi (add/update provider, MCP, LSP) ditulis ke file scope asal — bukan hasil merge — agar tidak duplikat/shadowing. Semua tulis file config atomik (tmp+rename randomUUID) + chmod 600.

**Kenapa lokal default-diabaikan:** `.minicode/config.json` sering ikut ter-commit; repo yang Anda clone bisa mendaftarkan MCP server atau menyedot prompt lewat config. Percayai hanya di workspace milik Anda.

## Token OAuth bukan di config

Kredensial OAuth di `~/.minicode/auth.json` (chmod 600) — terpisah dari config karena config lokal rawan ikut ter-commit sedangkan token rahasia berumur pendek. Provider OAuth menyimpan `apiKey: ""` di config dan mengambil token saat runtime. Detail di [Config & Provider](config.md).

## Lokasi data

| Path | Isi |
|---|---|
| `~/.minicode/config.json` | Config global |
| `~/.minicode/auth.json` | Token OAuth (chmod 600) |
| `.minicode/config.json` | Config lokal (default diabaikan) |
| `.minicode/sessions.db` atau `~/.minicode/sessions.db` | Sessions SQLite (WAL, capped + busy-retry); lokasi dipilih oleh `resolveDbPath` berdasarkan keberadaan `.minicode/` workspace |
| `.minicode/vector.db` atau `~/.minicode/vector.db` | Index memory vector hybrid; memakai aturan lokasi database yang sama dengan sessions |
| `.minicode/tasks.db` | TaskGraph dan scheduler; selalu lokal pada workspace |
| `.minicode/repomap.json` | Cache repo-map (sig mtime) |
| `.minicode/traces.jsonl` | Telemetry per run (prompt di-scrub) |
| `.minicode/step-traces.jsonl` | Trace keputusan tool (sumber `minicode stats`) |
| `.minicode/checkpoints/` | Manifest checkpoint (cap 20 terbaru) |
| `.minicode/todos/<id>.json` + `.minicode/plans/<id>.md` | Todo dan artefak rencana per sesi |
| `.minicode/.trash/` | Soft-delete `delete_file` (cap 100, gitignored) |
| `.minicode/MEMORY.md` + hierarki | File memory (global → lokal → root) |

Override home untuk semua DB lokal/global: `MINICODE_HOME` (terutama agar test hermetic di POSIX, di mana `homedir()` mengabaikan `$HOME`).

## Lanjut

- [Environment Variables](environment.md) — semua `MINICODE_*`.
- [Memory & Sessions](memory-sessions.md) — isi `vector.db`, sesi, checkpoint.
- [Policy & Sandbox](policy-sandbox.md) — kenapa tulis config selalu atomik + chmod 600.
