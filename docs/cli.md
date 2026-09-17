# CLI — Mode & Flags

Semua cara menjalankan Minicode: interaktif, sekali jalan, pipe, dan otomasi CI — plus flags dan environment.

## Mode

| Perintah | Fungsi |
|---|---|
| `minicode` | Mode interaktif (REPL) + wizard bila belum ada provider |
| `minicode "prompt"` | Sekali jalan (headless) |
| `echo "prompt" \| minicode` | Via pipe |
| `minicode exec "prompt" [--json]` | Headless CI — event JSONL + baris `{"type":"summary"}` di stdout |
| `minicode --interactive` | Paksa REPL |
| `minicode --provider <id> "prompt"` | Paksa provider agnostik tanpa ubah config (atau `provider::model`) |
| `minicode config add --baseUrl <url> --apiKey <key>` | Tambah provider LLM |
| `minicode config mcp add <id> --command <cmd> --args "<a1,a2>"` | Daftarkan MCP server stdio |
| `minicode config mcp add <id> --url <https://…>` | Daftarkan MCP server HTTP |
| `minicode config lsp add <ext> --command <cmd> --args "<a1,a2>"` | Daftarkan LSP server |
| `minicode auth login [provider]` | Login OAuth device-code |
| `minicode auth status\|logout\|list` | Kelola kredensial OAuth |
| `minicode pricing status\|sync\|show <model>\|clear` | Tabel harga estimasi biaya |
| `minicode skills list` | Daftar skill terpasang |
| `minicode sessions list` | Riwayat sesi |
| `minicode memory status [--json]` | Statistik vector RAG (rows, size, hit-rate) |
| `minicode doctor [--json]` | Diagnosis lokal |
| `minicode mcp serve` | Ekspos minicode sebagai MCP server |

Subcommand di-route di `cli/router.ts` (`stats`, `sessions`, `mcp`, `config`, `skills`, `providers`, `auth`, `pricing`, `exec`, `memory`, `doctor`).

## Flags

| Flag | Deskripsi |
|---|---|
| `--verbose` | Tampilkan reasoning & usage |
| `--verify` | Auto-verify + self-heal (detect: typecheck → test → tsconfig) |
| `--sandbox docker` | Bash di container ephemeral (`--network none`) |
| `--sandbox none` | Matikan sandbox otomatis (opt-out sadar) |
| `--sandbox os` | Paksa OS-native (bwrap/seatbelt). Sudah otomatis bila tersedia |
| `--ratelimit <rpm>` | Batas request LLM per menit |
| `--budget <usd>` | Batas biaya sesi; warn 80%, exit/break bila lewat; cost tak dikenal + pemakaian = over (fail-closed default) |
| `--budget-strict` | Penegasan eksplisit fail-closed di atas (back-compat) |
| `--tool-scope <s>` | `full` (default) \| `explore` = subset read-only 12 tool |
| `--plan` | Read-only plan mode |
| `--allowlist` | Bash hanya perintah aman |
| `--ask` | Tanya persetujuan setiap tool |
| `--allow-all` | Nonaktifkan semua sandbox (path jail tetap aktif) |
| `--model <name>` | Override model (`providerId::model` paksa provider) |
| `--provider <id>` | Paksa provider id agnostik |
| `--resume <id>` | Lanjutkan sesi (full history, bukan dump teks) |
| `--timeout <ms>` | Hard deadline per run (default 900000; 0 = Infinity) |
| `--cwd <path>` | Workspace root untuk tool file & jail |
| `--allow-local-config` | Percayai `.minicode/config.json` + allowlist lokal (default: diabaikan) |
| `--max-steps <n>` | Batas langkah tool (default 50) |
| `--context-window <n>` | Ukuran jendela konteks (token) |
| `--session <id>` | ID sesi (default random, disanitasi) |

Di REPL, **Shift+Tab** memutar permission (`auto` → `ask` → `plan` → `allowlist`) dan benar-benar mengubah keputusan, bukan label. Di baris kosong, **Tab** juga memutar mode (`auto` → `ask` → `plan` → `allowlist`).

## Kapan memakai apa

| Tujuan | Pakai |
|---|---|
| Kerja harian biasa | Default (`auto`) — tulis aman langsung jalan, yang berisiko minta izin |
| Repo asing / perintah belum dipahami | `--ask`, jawab `always` hanya untuk pasangan tool+args yang sudah dinilai |
| Review tanpa eksekusi | `--plan` (+ `--tool-scope explore` bila ingin subset baca 12 tool) |
| CI tanpa manusia | `exec --json` + `--budget`/`--max-steps`; hindari prompt yang butuh klarifikasi |
| Otonom penuh di mesin sendiri | `--allow-all` + `--sandbox docker` (atau OS) + `--budget` |
| Model mahal tak terkendali | `--budget 0.50` + `--budget-strict` + `pricing sync` |

Detail alasan tiap mode di [Memilih Mode](choosing-mode.md).

## Environment variables (ringkas)

Kepala tabel penuh ada di [Environment Variables](environment.md); yang paling sering dipakai:

| Variabel | Fungsi |
|---|---|
| `MINICODE_VERIFY_CMD` | Custom verify command |
| `MINICODE_SANDBOX` | `docker` \| `os` \| `none` |
| `MINICODE_SANDBOX_STRICT=1` | Tak pernah fallback host (default request eksplisit sudah fail-closed) |
| `MINICODE_SANDBOX_ALLOW_FALLBACK=1` | Izinkan fallback host secara eksplisit bila backend tak tersedia |
| `MINICODE_BUDGET_STRICT=1` | Sama dengan `--budget-strict` |
| `MINICODE_ALLOW_LOCAL_CONFIG=1` | Sama dengan `--allow-local-config` |
| `MINICODE_TOOL_SCOPE=explore` | Subset read-only |
| `MINICODE_GREP_ENGINE=js` | Paksa walker internal |
| `MINICODE_MEMORY_SCOPE` | `cwd` \| `global` \| `all` |
| `MINICODE_AUTO_MEMORY=0` | Matikan auto-simpan summary/snippet |
| `MINICODE_TELEMETRY=0` | Matikan `traces.jsonl` |
| `MINICODE_HOME` | Override home untuk DB lokal/global |
| `TAVILY_API_KEY` | Tavily web_search (fallback DDG bila kosong) |
| `NO_COLOR` | Matikan warna (menang atas TTY) |
| `MINICODE_ASCII=1` | Glyph ASCII untuk konsol tanpa UTF-8 |
| `MINICODE_STATUSLINE=rich` | Spinner tampilkan token + biaya sesi |

## Config `.minicode/config.json`

```json
{
  "providers": [{ "id": "my-provider", "baseUrl": "...", "apiKey": "...", "models": ["gpt-4o"] }],
  "mcpServers": [
    { "id": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] },
    { "id": "remote", "url": "https://mcp.example.com/mcp", "headers": { "authorization": "Bearer xxx" } }
  ],
  "lspServers": [{ "ext": ".ts", "command": "typescript-language-server", "args": ["--stdio"] }],
  "verifyCommand": "bun run typecheck",
  "bashAllowlist": ["git status*", "bun test*", "npm run build*"]
}
```

Global (`~/.minicode/config.json`) selalu dibaca. Lokal (`.minicode/config.json`)
adalah input repo tak terpercaya dan DIABAIKAN kecuali operator opt-in per
invokasi (`--allow-local-config` / `MINICODE_ALLOW_LOCAL_CONFIG=1`) — tanpa
itu MCP server lokal tidak di-spawn, endpoint provider lokal tidak dipakai,
`verifyCommand`/`bashAllowlist` lokal tidak berlaku. Tulis eksplisit
(`config add --local`) tak terpengaruh.

## Anti-injeksi flag

`cli/args.ts:53` berhenti di prompt word pertama: prompt `"review --allow-all"` tidak mengaktifkan flag. `--cwd`/value-flag setelah nama subcommand diparse per-subcommand agar tidak menembus boundary prompt.
