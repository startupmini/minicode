# MCP & LSP

Sambungkan Minicode ke tool server eksternal (MCP) dan language server (LSP) untuk kemampuan di luar bawaan.

## MCP — dua transport

```bash
# stdio — server lokal yang di-spawn minicode
minicode config mcp add fs --command npx --args "-y,@modelcontextprotocol/server-filesystem,."

# Streamable HTTP — server remote (spec 2025-03-26, SSE juga ditangani)
minicode config mcp add ctx7 --url https://mcp.example.com/mcp --header "authorization=Bearer xxx"

# localhost butuh opt-in eksplisit (anti-SSRF)
minicode config mcp add lokal --url http://127.0.0.1:3000/mcp --allow-private
```

Setelah terdaftar, `mcp_list` menampilkan **tools, resources, prompts** sekaligus:

| Tool | Spec | Catatan |
|---|---|---|
| `mcp_list` | `tools/list` + `resources/list` + `prompts/list` | read-only, tidak di-gate |
| `mcp_call` | `tools/call` | di-gate |
| `mcp_read` | `resources/read` | di-gate (konten pihak ketiga = jalur prompt-injection). Biner diganti penanda ukuran |
| `mcp_prompt` | `prompts/get` | di-gate, server merender argumen |

Tool dinamis `serverId.toolName` otomatis muncul. `resources`/`prompts` opsional di spec: server "Method not found" tetap terhubung dengan tool utuh.

Keamanan HTTP: host privat ditolak kecuali `--allow-private` (penjaga sama dengan `web_fetch`: DNS pinning). Redirect tidak diikuti. Ukuran dibatasi. Balasan dicocokkan per request id. Header `Authorization` tidak masuk log.

Izin: semua MCP bertitik selalu di-gate — `auto` minta konfirmasi sekali per tool (`[a] Always` persist ke allowlist); `readonly`/`plan`/`allowlist` menolak. Tanpa wildcard auto-allow (proteksi supply-chain).

Model kepercayaan: permission hanya kontrol *pemanggilan*. Capability di balik server (filesystem, network, proses, API) tak bisa diketahui statis — anggap setiap `mcp_call` external capability arbitrer. Pembatalan hentikan penungguan, tapi tidak bunuh proses stdio maupun batalkan efek yang sudah terjadi.

Ekspos balik (stdio saja — tanpa mode HTTP, jadi tak ada permukaan jaringan):

```bash
minicode mcp serve                            # curated tools + permission aktif
minicode mcp serve --cwd <dir>                # workspace root (jail + eksekusi + jurnal memakai root yang sama)
minicode mcp serve --allow-all                # tanpa prompt, tetapi jail + bash-guard tetap enforced
minicode mcp serve --all-tools                # termasuk delegate/memory/MCP internal (opt-in operator)
```

Semantik server mode: tiap `tools/call` lewat validateArgs kernel → permission (mode `auto`, atau `allow-all` bila flag) → eksekusi → jurnal mutasi (`mcp-server`) → respons. Argumen invalid ditolak sebelum eksekusi; error di-scrub; output di-cap + ditandai bila dipotong. ID request JSON-RPC dipakai untuk idempotency: duplikat konkuren dieksekusi sekali, retry id sama me-replay hasil (proses hidup) atau error eksplisit `already executed`/`failed`/`unknown` (lintas restart, dari bukti jurnal) — tak pernah eksekusi ulang buta. `notifications/cancelled` membatalkan request individual; maksimal 32 in-flight. Tanpa turn/session kernel: tak ada persistensi percakapan, checkpoint, atau undo untuk operasi server.

## LSP

```bash
minicode config lsp add .ts --command typescript-language-server --args --stdio
```

Setelah terdaftar: `lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols`, `lsp_workspace_symbols`. Diagnostics otomatis di `edit`/`write_file` bila server terkonfigurasi. `didClose` cleanup.

Bila LSP tidak jalan: pastikan server terinstall dan command benar. Repo-map regex tetap jalan sebagai fallback (`MINICODE_REPOMAP=regex`).
