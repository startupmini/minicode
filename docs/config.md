# Config — File & Lokasi Data

Di mana pengaturan dan data Minicode tinggal, dan bagaimana file lokal yang tak tepercaya diperlakukan.

## Skema `.minicode/config.json`

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

- `providers` — bisa juga diisi lewat wizard/`minicode config add`/`/provider` (15 preset, lihat [Config & Provider](config-providers.md)).
- `mcpServers` — dua bentuk: stdio (`command`+`args`) dan HTTP (`url`+opsional `headers`). Detail transport di [MCP & LSP](mcp-lsp.md).
- `verifyCommand` — dipakai `--verify` bila auto-detect tidak menemukan (urutan deteksi: `typecheck` → `test` → `tsconfig`).
- `bashAllowlist` — pola koma/pola glob perintah bash yang dianggap aman (mode `allowlist`).

## Global vs lokal

| File | Lokasi | Catatan |
|---|---|---|
| Global | `~/.minicode/config.json` | Berlaku semua workspace |
| Lokal | `.minicode/config.json` | Per repo; **diabaikan secara default** — aktif dengan `--allow-local-config` / `MINICODE_ALLOW_LOCAL_CONFIG=1` |

Merge dengan **prioritas lokal menang**. Mutasi (add/update provider, MCP, LSP) ditulis ke file scope asal — bukan hasil merge — agar tidak duplikat/shadowing. Semua tulis file config atomik (tmp+rename randomUUID) + chmod 600.

**Kenapa lokal default-diabaikan:** `.minicode/config.json` sering ikut ter-commit; repo yang Anda clone bisa mendaftarkan MCP server atau menyedot prompt lewat config. Percayai hanya di workspace milik Anda.

## Token OAuth bukan di config

Kredensial OAuth di `~/.minicode/auth.json` (chmod 600) — terpisah dari config karena config lokal rawan ikut ter-commit sedangkan token rahasia berumur pendek. Provider OAuth menyimpan `apiKey: ""` di config dan mengambil token saat runtime. Detail di [Config & Provider](config-providers.md).

## Lokasi data

| Path | Isi |
|---|---|
| `~/.minicode/config.json` | Config global |
| `~/.minicode/auth.json` | Token OAuth (chmod 600) |
| `.minicode/config.json` | Config lokal (default diabaikan) |
| `.minicode/sessions.db` | Sessions SQLite (WAL, capped + busy-retry) |
| `vector.db` | Index memory vector hybrid |
| `.minicode/repomap.json` | Cache repo-map (sig mtime) |
| `.minicode/traces.jsonl` | Telemetry per run (prompt di-scrub) |
| `.minicode/step-traces.jsonl` | Trace keputusan tool (sumber `minicode stats`) |
| `.minicode/checkpoints/` | Manifest checkpoint (cap 20 terbaru) |
| `.minicode/todos/<id>.json` + `.minicode/plans/<id>.md` | Rencana per sesi |
| `.minicode/.trash/` | Soft-delete `delete_file` (cap 100, gitignored) |
| `.minicode/MEMORY.md` + hierarki | File memory (global → lokal → root) |

Override home untuk semua DB lokal/global: `MINICODE_HOME` (terutama agar test hermetic di POSIX, di mana `homedir()` mengabaikan `$HOME`).

## Lanjut

- [Environment Variables](environment.md) — semua `MINICODE_*`.
- [Memory & Sessions](memory-sessions.md) — isi `vector.db`, sesi, checkpoint.
- [Policy & Sandbox](policy-sandbox.md) — kenapa tulis config selalu atomik + chmod 600.
