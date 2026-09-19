# Otomasi & CI

## Tiga mode non-interaktif

| Bentuk | Kapan dipakai |
|---|---|
| `minicode "prompt"` | Sekali jalan; output teks model + ledger ke terminal |
| `echo "prompt" \| minicode` | Prompt datang dari pipeline/another tool |
| `minicode exec "prompt" --json` | CI: event JSONL di stdout + baris terakhir `{"type":"summary"}` |

`exec --json` memancarkan satu JSON per event (langkah tool, output, error) dan **summary** terstruktur di akhir — cukup untuk diparse pipeline tanpa screen-scraping. Kegagalan *setup* (mis. tanpa provider) pun membawa satu baris `{"type":"summary","ok":false,…}` di stdout — stream tak pernah kosong; pesan manusia tetap di stderr, exit `1`.

## Hasil terstruktur: `submit_result`

Tool `submit_result` menghasilkan JSON akhir terstruktur, dipanggil paling banyak 1× per run, dengan mode `NO_PROMPT` (tidak minta konfirmasi). Di `exec --json`, isi hasil diteruskan **verbatim** — pengganti `response_format` ala API. Cocok untuk tugas yang hasilnya dikonsumsi program lain, bukan manusia.

## Klarifikasi mid-run: `ask_user`

`ask_user` menanyakan manusia di tengah run. Gated + dirender lewat injeksi `promptAskText`; **fail-closed di non-TTY** — di CI tanpa TTY, pertanyaan tidak akan menggantung build tanpa jejak, tool ditolak dengan pesan jelas. Desain CI: jangan bergantung pada `ask_user`; tulis prompt yang self-contained.

## Batas runtime

| Kendali | Default | Catatan |
|---|---|---|
| `--max-steps <n>` | 50 | Batas langkah tool per run |
| `--timeout <ms>` | 900000 (15 menit) | Hard deadline per run; `0` = Infinity |
| `--ratelimit <rpm>` | — | Token bucket request LLM per menit |
| `--budget <usd>` | — | Warn 80%; lewat → one-shot `exit(1)`, REPL break loop; `exec` menegakkan sama seperti one-shot |

`MINICODE_TIMEOUT_MS` mengisi default bila `--timeout` tidak diset.

## Contoh pipeline CI

```bash
# gate PR: verify + budget ketat + hasil JSON
minicode exec "perbaiki lint di src/ lalu jalankan bun run lint" --json \
  --verify --budget 0.50 --budget-strict --max-steps 40

# pakai provider tertentu tanpa mengubah config
minicode exec "ringkas diff ini" --json --provider openai --model gpt-4o

# prompt dari file
minicode exec "$(cat task.md)" --json
```

## Catatan keamanan untuk CI

- Config lokal `.minicode/config.json` **diabaikan secara default** (`--allow-local-config` untuk percayai) — repo clone-an tidak bisa men-spawn MCP atau menyedot prompt. Di runner yang Anda kendalikan penuh, boleh diaktifkan.
- `git_commit` dan semua tool MCP **di-gate**: di non-TTY selalu ditolak. CI yang butuh commit harus lewat jalur lain (mis. workflow git, bukan agent).
- Env kredensial di-scrub dari subprocess; `GITHUB_TOKEN` dkk. tidak bocor ke tool `bash`. Detail di [Keamanan](security.md).

## Lanjut

- [CLI](cli.md) — semua flags.
- [Verify & Benchmark](verify-benchmark.md) — `--verify` + self-heal untuk pipeline.
- [Environment Variables](environment.md) — referensi penuh `MINICODE_*`.
