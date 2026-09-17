# Tools (37)

Referensi lengkap tool Minicode: filesystem, search, exec, git, web, memory, plan, agents, MCP, LSP.

Pilih tool ini ketika: **file** untuk baca/tulis presisi (bukan `cat` via bash); **search** untuk menemukan kode (bukan `grep` via bash); **bash** untuk perintah yang memang butuh shell; **git tool** untuk status/diff/log/commit (bukan `git` mentah — tool dinetralkan dari hook/filter repo); **web** untuk sumber publik; **memory** untuk fakta lintas sesi (bukan tempelan prompt); **delegate** untuk penelahan paralel yang hasilnya diverifikasi parent.

Daftar pasti kapan pun:

```bash
bun -e "import {allTools} from './src/tools/index.ts'; console.log(allTools.map(t=>t.name))"
```


`cwd` tool file **wajib** dari `ToolContext.cwd`, bukan `process.cwd()` (seam `cwd?: string` di kernel + `resolve(sessionRoot, raw)` + file-lock per-cwd).

## Filesystem

| Tool | Fungsi | Catatan |
|---|---|---|
| `read_file` | Baca teks + nomor baris, chunk `offset/limit` | Footer beri offset berikutnya. >2 MB wajib `offset/limit`, bukan potong diam-diam. Realpath jail + secret-scrub. Output `12: const x = 1` agar rujukan `edit` akurat |
| `write_file` | Buat/overwrite, auto-buat parent | Atomic tmp→rename + mkdir. LSP diagnostics otomatis bila server terkonfigurasi |
| `edit` | Ganti string (harus tepat 1×) | Unique+atomic, fuzzy CRLF/spasi + hashline deterministik (`src/tools/hashline.ts`) |
| `apply_patch` | Blok SEARCH/REPLACE multi-hunk ala Aider | Satu call banyak patch |
| `move_file` | Pindah/rename atomik | Dest yang ada dibackup ke trash dulu (catat path). Dijail di permission layer juga |
| `delete_file` | Soft-delete ke `.minicode/.trash/` | Undo via `move_file`. Cap 100 terbaru, gitignored. Shared helper `src/lib/trash.ts` |
| `read_image` | Gambar → konteks model | Base64 utuh + lapor `(bytes mime, tokens)` via `estimateImageTokens`. Cap file-size 2 MB. TOCTOU-safe (`safeOpenRead` + `handle.stat`) |

Contoh paging:

```
read_file({ path: "src/big.ts" })
read_file({ path: "src/big.ts", offset: 2001 })
read_file({ path: "src/big.ts", offset: 500, limit: 50 })
```

## Search

| Tool | Fungsi | Catatan |
|---|---|---|
| `glob` | Cari pola `**/*.ts` | Mendukung `{a,b}`, cwd jail |
| `grep` | Regex lintas file | `rg --vimgrep --no-follow` bila ada di PATH, fallback walker internal. Keduanya jail + secret-scrub sama, hasil identik. `MINICODE_GREP_ENGINE=js` paksa fallback. Bila `rg` gagal (flavour regex beda), otomatis fallback + warning |

## Exec

| Tool | Fungsi | Catatan |
|---|---|---|
| `bash` | Shell 30 dtk SIGTERM→SIGKILL | Tanpa `MINICODE_SANDBOX`: jalan di HOST (network tidak diisolasi, teraudit di step-traces). cwd jail (= cwd eksekusi, bukan process.cwd), env kredensial di-strip (`sanitizeSpawnEnv`), progres streaming, `background:true` + `bash_output`/`bash_kill`, sandbox docker/os optional. Request sandbox eksplisit tanpa backend = TOLAK (fail-closed); fallback host hanya via `MINICODE_SANDBOX_ALLOW_FALLBACK=1`. `background:true` ditolak saat `--sandbox` aktif dan di sub-agen |
| `bash_output` | Output BARU job sejak baca terakhir | + exit status |
| `bash_kill` | Stop job | SIGTERM lalu SIGKILL; tree-kill (`taskkill /T /F` di Windows, process-group di POSIX) |
| `code_run` | Snippet python/node tanpa shell | Spawn langsung argv (tanpa shell agar `$(...)` tidak dieksekusi shell dulu). Wajib sandbox `os|docker`, network-isolated, cwd = session root. Fail-closed bila backend tak tersedia. Image default `node:22-alpine` hanya bawa node — python butuh `MINICODE_SANDBOX_IMAGE` yang menyediakannya |

Background:

```
bash({ cmd: "bun run dev", background: true })  # → bg_xxxxxxxx
bash_output({ id: "bg_xxxxxxxx" })
bash_kill({ id: "bg_xxxxxxxx" })
```

Batas `BASH_BACKGROUND_MAX_JOBS`; semua job mati saat CLI keluar.

## Git (read + satu penulis)

| Tool | Fungsi | Catatan |
|---|---|---|
| `git_status` | `status --porcelain + diff --stat + log -10` | cwd jail |
| `git_diff` | `diff` unstaged atau `--staged` | — |
| `git_log` | `log --oneline -n` | — |
| `git_commit` | Commit saja | **Di-gate** seperti `delegate_task` (TTY = minta sekali, non-TTY = tolak; `readonly/plan/allowlist` = tolak). Sub-agent tidak mendapatkannya. Yang sengaja tidak ada: push/amend/reset/rebase/checkout/branch -D/stash drop. Pesan via `-m` tunggal agar `$()`/backtick tidak dieksekusi; `git add -- <paths>` agar file `-weird.txt` tidak jadi flag |

## Web

| Tool | Fungsi | Catatan |
|---|---|---|
| `web_fetch` | GET URL publik, 10 dtk, max 50k char | SSRF guard + DNS pinning, redirect manual ≤5 hop, body hard-cap 2 MB |
| `web_search` | Search via DuckDuckGo/Tavily | Butuh `TAVILY_API_KEY` untuk Tavily; fallback DDG bila kosong |

## Memory & plan

| Tool | Fungsi | Catatan |
|---|---|---|
| `read_memory` | Baca `MEMORY.md` + vector RAG hybrid | — |
| `write_memory` | Tulis + vector store | `{category?, tags?}`, default `fact`. Kategori `fact|decision|preference|snippet|summary`, boost `decision` +0.1 |
| `forget_memory` | Hapus cocok query | Menghapus vector + baris file di scope lokal DAN global (keduanya di-search; `MEMORY.md` root/`CLAUDE.md` tak ikut). Hitung-dulu-sebelum-DELETE (trigger FTS mengacaukan `sqlite3_changes`) |
| `todo_write` / `todo_read` | Rencana per sesi (3+ langkah) | Kirim **seluruh daftar** tiap kali. Status `pending|in_progress|completed|cancelled`, satu `in_progress` dipertahankan. Disimpan `.minicode/todos/<session>.json` + artifact `.minicode/plans/<id>.md` |
| `submit_result` | Hasil akhir JSON terstruktur 1× | NO_PROMPT, `exec --json` verbatim. Pengganti `response_format` |
| `ask_user` | Tanya klarifikasi mid-run | Gated + render via injeksi `promptAskText` (fail-closed non-TTY) |

## Agents

| Tool | Fungsi | Catatan |
|---|---|---|
| `delegate_task` | Sub-agen isolasi `explore`/`plan` | Pool 3, isolasi context/memory/signal/budget, abort-aware. Di-gate (TTY prompt, non-TTY tolak). Anak SELALU mode `auto` tanpa ask: tanpa MCP/commit/memory-tulis/todo-tulis/job/nesting; plan-parent dipaksa explore. Satu approval = delegasi ini saja; turn gagal setelah anak committed → warning `[recovery]` anti re-delegasi buta |

## MCP

| Tool | Spec | Catatan |
|---|---|---|
| `mcp_list` | `tools/list` + `resources/list` + `prompts/list` | Read-only, tidak di-gate. Panggil dulu |
| `mcp_call` | `tools/call` | Di-gate. 1 approval = 1 call. Jalan di luar policy minicode |
| `mcp_read` | `resources/read` | Di-gate **meski read-only** (konten pihak ketiga = jalur prompt-injection). Biner diganti penanda ukuran |
| `mcp_prompt` | `prompts/get` | Di-gate, server merender argumen |

Plus tool dinamis `serverId.toolName`. Semua bertitik selalu di-gate (tanpa wildcard auto-allow). Detail transport di [MCP & LSP](mcp-lsp.md).

## LSP

Butuh `minicode config lsp add` dulu. Setelah terdaftar:

| Tool | Fungsi |
|---|---|
| `lsp_diagnostics` | Diagnostik 1 file |
| `lsp_definition` | Lokasi definisi (`file+symbol` atau `line/character`) |
| `lsp_references` | Semua referensi se-repo |
| `lsp_hover` | Info tipe |
| `lsp_symbols` | Outline dokumen |
| `lsp_workspace_symbols` | Cari se-workspace; query kosong = populer |

`didClose` cleanup otomatis.

## Rantai pemeriksaan

`PermissionHandler → validateArgs (kernel) → executor (order/cap/abort-aware) → tool realpath+atomic(O_EXCL) → execute`. Executor order-preserving: mixed step sequential, pure-read paralel, write di-cap, antrean abort-aware.
