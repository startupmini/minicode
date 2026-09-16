\n
## 14 preset gateway

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

> Kejujuran: device flow teruji lengkap ke server OAuth lokal (18 test: pending/slow_down/denied/expired/clamp), tapi endpoint/clientId provider belum semua terkonfirmasi live. `auth login chatgpt` fail-fast di non-TTY. Jangan baca token aplikasi desktop orang lain — itu pencurian kredensial.

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

Effort tersimpan di `ProviderEntry.reasoningEffort`, berlaku sesi berikutnya, tampil badge `[low|medium|high]`. **Default universal = omit** (tanpa param thinking): default bawaan tiap model sudah di-tune vendornya. Knob hanya dikirim ke keluarga terbukti, dalam bahasa native-nya: OpenAI reasoning (`o*`, `gpt-5/6` → `reasoning_effort`, level tervalidasi per model — pro = high saja); Claude ≤4.5 → budget `1024/2048/4096`; Claude ≥4.6/5 → adaptive + `output_config.effort`. **Selain itu tak pernah dikirimi param thinking** (DeepSeek, Gemini, Groq, Ollama, free-tier, custom). Bila model menolak param (400/500), request diulang sekali tanpa param + diingat per sesi + dicatat `[thinking]` di stderr. Picker effort hanya muncul untuk model yang mendukung; sisanya select langsung tanpa menyentuh effort tersimpan. `detectAndSave`/`auth login` mempertahankan effort (tidak reset diam-diam). Mutasi ditulis ke file scope asal (bukan hasil merge) agar tidak duplikat/shadowing.

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
