# Minicode User Guide

> **Status: arsip legacy.** Dokumen ini monolit panduan lama yang isinya kini terpelihara di halaman docs terpisah (lihat tabel di bawah). Jangan tambah konten baru di sini; perbaiki di halaman tujuannya. Beberapa angka di bawah bisa basi — sumber kebenaran adalah halaman docs + `bun test`.
>
> | Butuh… | Baca… |
> |---|---|
> | Mulai cepat | [Quickstart](quickstart.md), [Instalasi](getting-started.md) |
> | Flag & env | [CLI](cli.md), [Environment Variables](environment.md) |
> | Tool & MCP/LSP | [Tools](tools.md), [MCP & LSP](mcp-lsp.md) |
> | Memory, sesi, recovery | [Memory & Sessions](memory-sessions.md) |
> | Keamanan & policy | [Security Model](security-model.md), [Policy & Sandbox](policy-sandbox.md) |

## Instalasi

```bash
git clone https://github.com/startupmini/minicode && cd minicode
bun install && bun link
```

**Prasyarat:** `bun >= 1.0`. Tidak perlu clone repo lain — kernel MiniCore di-vendor ke `vendor/minicore`. Setup wizard otomatis saat pertama `minicode`.

Opsional: `rg` (ripgrep) di PATH mempercepat tool `grep`. Tanpa `rg`, walker internal dipakai dengan hasil identik.

## Mode CLI

| Perintah | Fungsi |
|---|---|
| `minicode` | Mode interaktif (REPL) + wizard bila belum ada provider |
| `minicode "prompt"` | Sekali jalan (headless) |
| `echo "prompt" \| minicode` | Via pipe |
| `minicode exec "prompt" [--json]` | Headless CI — event JSONL + baris `{"type":"summary"}` di stdout |
| `minicode --interactive` | REPL linier — agentic Unix shell, output mengalir ke scrollback |
| `minicode --provider <id> "prompt"` | Paksa provider agnostik tanpa ubah config (atau `provider::model`) |
| `minicode config add --baseUrl <url> --apiKey <key>` | Tambah provider LLM |
| `minicode config mcp add <id> --command <cmd> --args "<a1,a2>"` | Daftarkan MCP server stdio |
| `minicode config mcp add <id> --url <https://…>` | Daftarkan MCP server HTTP (Streamable HTTP/SSE) |
| `minicode config lsp add <ext> --command <cmd> --args "<a1,a2>"` | Daftarkan LSP server |
| `minicode auth login [provider]` | Login OAuth device-code (tanpa API key) |
| `minicode auth status\|logout\|list` | Kelola kredensial OAuth |
| `minicode pricing status\|sync\|show <model>\|clear` | Tabel harga untuk estimasi biaya |
| `minicode skills list` | Daftar skill terpasang |
| `minicode sessions list` | Riwayat sesi |
| `minicode memory status [--json]` | Statistik vector RAG store (rows, size, hit-rate) |
| `minicode doctor [--json]` | Diagnosis lokal: runtime, provider, pricing, memory, sandbox, config |
| `minicode mcp serve` | Ekspos minicode sebagai MCP server |

## Flags

| Flag | Deskripsi |
|---|---|
| `--verbose` | Tampilkan reasoning & usage |
| `--verify` | Auto-verify + self-heal (detect: typecheck → test → tsconfig) |
| `--sandbox docker` | Eksekusi bash dalam container ephemeral (`--network none`) |
| `--sandbox none` | Matikan sandbox otomatis (opt-out sadar, tanpa downgrade permission) |
| `--sandbox os` | Paksa OS-native: bubblewrap (Linux) / seatbelt (macOS). Sudah otomatis bila tersedia |
| `--ratelimit <rpm>` | Batas request LLM per menit (token bucket) |
| `--budget <usd>` | Batas biaya sesi; warn 80%, exit/break bila lewat |
| `--budget-strict` | Fail-closed: cost tak dikenal (model tanpa harga) dianggap over budget |
| `--tool-scope <s>` | `full` (default) \| `explore` = subset read-only (12 tool) |
| `--plan` | Read-only plan mode (tidak bisa edit file / bash) |
| `--allowlist` | Bash hanya perintah aman (git/bun test/bun run/npm run) |
| `--ask` | Tanya persetujuan setiap tool |
| `--allow-all` | Nonaktifkan semua sandbox (path jail tetap aktif) |
| `--model <name>` | Override model LLM (atau `providerId::model` paksa provider) |
| `--provider <id>` | Paksa provider id agnostik (tanpa ubah config; filter single) |
| `--resume <id>` | Lanjutkan sesi sebelumnya (full history, bukan teks dump) |
| `--timeout <ms>` | Hard deadline per run (default 900000 = 15 min; 0 = Infinity) |
| `--cwd <path>` | Workspace root untuk tool file & jail (diperbaiki 0.8.0 via ToolContext.cwd) |
| `--allow-local-config` | Percayai `.minicode/config.json` + allowlist lokal (default: diabaikan — repo clone-an tak bisa men-spawn MCP / menyedot prompt) |
| `--interactive` | Paksa mode REPL |
| `--max-steps <n>` | Batas langkah tool (default 50) |
| `--context-window <n>` | Ukuran jendela konteks (token) |
| `--session <id>` | ID sesi (default random, disanitasi) |

Di TUI, **Shift+Tab** memutar mode permission (`auto` → `ask` → `plan` → `allowlist`) dan benar-benar mengubah keputusan permission, bukan cuma label header.

## Environment Variables

| Variabel | Fungsi |
|---|---|
| `MINICODE_VERIFY_CMD` | Custom verify command (ganti `detectVerifyCommand`) |
| `MINICODE_BASH_ALLOWLIST` | Kustom allowlist bash (koma-pisah, ganti DEFAULT) |
| `MINICODE_SANDBOX` | Sandbox mode: `docker` \| `os` (alias `bwrap`/`seatbelt`) \| `none` |
| `MINICODE_SANDBOX_STRICT` | `1` → fail-closed: tolak bash bila isolasi yang diminta tak tersedia (default: warn + eksekusi langsung) |
| `MINICODE_BUDGET_STRICT` | `1` → sama dengan `--budget-strict`: cost tak dikenal dianggap over budget |
| `MINICODE_ALLOW_LOCAL_CONFIG` | `1` → sama dengan `--allow-local-config`: percayai config lokal workspace |
| `MINICODE_TOOL_SCOPE` | `explore` → sesi hanya dapat subset read-only (sama dengan `--tool-scope explore`) |
| `MINICODE_SANDBOX_IMAGE` | Image Docker (default `node:22-alpine`) |
| `MINICODE_SANDBOX_MEMORY` | Memory cap (default `512m`) |
| `MINICODE_GREP_ENGINE` | `js` → paksa walker internal, jangan pakai ripgrep |
| `MINICODE_TIMEOUT_MS` | Default timeout (ms) bila `--timeout` tidak diset; `0` = Infinity |
| `MINICODE_REPOMAP` | `regex` → paksa repo-map regex (skip LSP) |
| `MINICODE_PLAN` | `1` → mode plan (tanpa `--plan`) |
| `MINICODE_PERMISSION` | `allowlist` → mode allowlist |
| `MINICODE_SESSION_TTL_DAYS` | TTL sesi (default 30; `0` = selamanya) |
| `MINICODE_HOME` | Override home untuk DB lokal/global (sessions + vector); default `~`. Berguna agar test hermetic di POSIX (di sana `homedir()` mengabaikan `$HOME`) |
| `MINICODE_TELEMETRY` | `0`/`false`/`off` → matikan penulisan traces.jsonl |
| `MINICODE_PROVIDER_ORDER` | Urutkan provider agnostik tanpa edit config: `openai,anthropic,deepseek` |
| `MINICODE_HOOKS` | `1` → jalankan hook global `pre/post-run` dari `~/.minicode/hooks/*.js` & `.minicode/hooks/*.js` (konteks di env `MINICODE_HOOK_CTX`; env hook disanitasi tanpa secret; hook dilewati bila sesi dibatalkan) |
| `NO_COLOR` | Set apa pun selain `0` → matikan seluruh warna |
| `MINICODE_ASCII` | `1` → paksa glyph ASCII (`[OK]`, `>`, `.`) untuk konsol tanpa UTF-8 |
| `MINICODE_COMPACT` | `1` → tool call ringkas, `0` → expanded. Default: compact di REPL, expanded di one-shot/exec (juga `/compact`, Ctrl+O) |
| `MINICODE_JUSTIFY` | `0` → matikan rata kanan-kiri pada keluaran teks model |
| `MINICODE_DROPDOWN` | `0` → matikan floating dropdown, pakai hint inline (konsol legacy) |
| `MINICODE_BELL` | `0` → matikan bell `\x07` saat approval (aksesibilitas) |
| `MINICODE_STATUSLINE` | `rich` → statusline turn menampilkan token kumulatif + biaya sesi (default hemat) |
| `MINICODE_A11Y` | `1` → live-region approval untuk screen reader (baris polos tanpa ANSI) |
| `MINICODE_SHOW_THINKING` | `1` → tampilkan reasoning model (`--verbose` atau env) |
| `MINICODE_THINKING` | `off` → kirim `enable_thinking:false` ke OpenAI-compat (DeepSeek) |
| `MINICODE_EMBED_MODEL` | Model embedding untuk memory/vector (default `text-embedding-3-small`) |
| `MINICODE_MEMORY_SCOPE` | Scope baca memory: `cwd` (default) \| `global` \| `all` (gabung, tanpa silent shadowing) |
| `MINICODE_AUTO_MEMORY` | `0` → matikan auto-simpan summary/snippet ke memory (opt-out) |
| `TAVILY_API_KEY` | API key untuk Tavily web_search (fallback DuckDuckGo bila kosong) |
| `AGENT_API_KEY`, `AGENT_BASE_URL`, `AGENT_MODEL` | Fallback generik OpenAI-compat (dipakai provider-layer, memory, task) |
| `DEEPSEEK_BASE_URL` | Base URL DeepSeek (default `https://api.deepseek.com/v1`, untuk compaction) |
| `ANTHROPIC_MODEL` | Model Anthropic default (`claude-sonnet-4`) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` | Fallback API key |

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

Config global (`~/.minicode/config.json`) + local (`.minicode/config.json`) — merge dengan prioritas local.

## Slash Commands (REPL)

Ketik `/` di prompt → floating dropdown (max 10 item + `… N more`), ter-lookup grouped `COMMANDS` / `SKILLS` saat keduanya match. `↑`/`↓` navigasi, `Tab` melengkapi, `Enter` melengkapi + submit, `Esc` tutup. Terminal lama tanpa ANSI: fallback inline hint.

| Command | Fungsi |
|---|---|
| `/help` | Daftar perintah + skill + tombol penting |
| `/help tombol` | Daftar pintasan papan tombol lengkap |
| `/provider` | Kelola provider: tambah (`a`), hapus (`d`), ubah (`e`). Provider aktif ditandai `(aktif)`; konfirmasi hapus menyebut jumlah model yang ikut hilang |
| `/model [cari]` | Picker semua provider·model (argumen = filter awal; di dalam ketik langsung untuk cari live, Esc keluar filter). Tambah = Ctrl+N, hapus = tombol Del. Format `providerId::modelName` memaksa provider. Enter = pilih model + atur thinking effort (`default`/`low`/`medium`/`high` via picker, tersimpan di provider, berlaku sesi berikutnya; Esc = batal total). Effort non-default tampil sebagai badge `[low|medium|high]` di baris model |
| `/sync` | Segarkan daftar model dari semua provider |
| `/undo` | Batalkan perubahan berkas dari turn terakhir |
| `/redo` | Terapkan ulang perubahan yang dibatalkan |
| `/sessions` | Daftar sesi terbaru; tanpa argumen = pilih untuk di-resume (picker); `/sessions <id>` = langsung resume |
| `/status` | Info runtime + pemakaian & biaya **kumulatif sesi** (ID sesi, model, provider, token, cost) |
| `/mode [nama]` | Ganti mode permission (`auto`, `ask`, `plan`, `allowlist`); tanpa argumen = putar |
| `/init` | Buat `AGENTS.md` untuk proyek ini |
| `/copy` | Salin output turn terakhir ke clipboard (OSC 52) |
| `/clear` | Tandai batas layar: banner `--- cleared (scrollback preserved) ---` (scrollback tetap jadi transcript) |
| `/history` | Tampilkan 20 entri riwayat prompt terakhir |
| `/exit` | Keluar |

Alias yang juga dikenali (tidak muncul di `/help`): `/models` → `/model`, `/providers` → `/provider`, `/usage` & `/cost` → `/status`, `/resume [id]` → `/sessions [id]`, `/compact`.

Catatan dropdown: Tab (dropdown) hanya menawarkan perintah **builtin + `/compact` `/thinking` `/expand` `/minimize`** — tetap pendek dan minimalis. `/mode` tak masuk dropdown (Tab/Shift+Tab sudah memutar mode). `/thinking` = toggle tampilan reasoning; effort via picker `Enter` di `/model`. Perintah lain (`/undo`, `/redo`, `/clear`, `/copy`, `/history`) sengaja tidak masuk dropdown; semuanya terdaftar di `/help` (termasuk `/mode`).

### Papan tombol (REPL)

| Tombol | Fungsi |
|---|---|
| `enter` | Kirim prompt |
| `shift+tab` | Putar mode permission (`auto` → `ask` → `plan` → `allowlist`) |
| `tab` | Lengkapi perintah dari dropdown (menghormati item yang sedang dipilih); di baris kosong = putar mode (`auto` → `ask` → `plan` → `allowlist`, tanpa baris baru) |
| `↑` / `↓` | Jelajahi history, atau pilih item dropdown bila terbuka |
| `ctrl+o` | Putar tool call compact/expanded (juga `/compact`) |
| `ctrl+t` | Toggle tampilan reasoning expanded/minimized (juga `/thinking`) |
| `+` / `-` | Saat turn berjalan: expand / minimize section aktif (thinking & tool) |
| `ctrl+r` | Reverse-i-search history (substring; Esc/Ctrl+C/Ctrl+D batal, Ctrl+U hapus query) |
| `ctrl+j` | Sisipkan newline (multiline opt-in; Enter tetap submit) |
| `←` / `→` | Geser kursor (editing di tengah baris) |
| `ctrl+a` / `ctrl+e` | Ke awal / akhir baris |
| `home` / `end` / `del` | Sama seperti di editor |
| `ctrl+w` | Hapus satu kata sebelum kursor |
| `ctrl+u` | Kosongkan baris |
| `esc` | Tutup dropdown/picker; batal prompt yang masih kosong (di baris berisi: tidak batal — draf aman) |
| `ctrl+c` / `ctrl+d` | Saat busy: hentikan turn; saat idle: batalkan prompt (dua kali beruntun saat idle = keluar) |
| `\` di akhir baris | Sambung ke baris berikutnya |

## Skills

`.minicode/skills/*.md` dengan frontmatter `name` + `description`:

```markdown
---
name: review
description: Review code changes
---
Review this diff: {{args}}
```

Panggil: `/review src/a.ts` atau `minicode "/review src/a.ts"`.

## Tool Penting

### `read_file` — paging bernomor

Output selalu diberi nomor baris (`12: const x = 1`) supaya rujukan ke `edit`/`apply_patch` akurat.

```
read_file({ path: "src/big.ts" })                    # 2000 baris pertama
read_file({ path: "src/big.ts", offset: 2001 })      # lanjutkan
read_file({ path: "src/big.ts", offset: 500, limit: 50 })
```

File di atas `READ_FILE_MAX_BYTES` (2 MB) **hanya** bisa dibaca dengan `offset`/`limit` — tanpa itu tool menolak alih-alih diam-diam memotong konteks yang model kira utuh. Footer memberi `offset` berikutnya bila masih ada sisa.

### `grep` — dua engine, hasil sama

`rg` dipakai bila ada di PATH (`--vimgrep --no-follow`, exclude `.git`/`node_modules`/dotdir), jika tidak walker internal. Keduanya menerapkan jail path dan secret-scrub yang sama, dan diuji memberi hasil identik. Paksa fallback dengan `MINICODE_GREP_ENGINE=js` (dipakai CI untuk menguji jalur itu).

Bila `rg` gagal (regex flavour beda, binary rusak), tool otomatis jatuh ke walker dan mencetak peringatan — bukan gagal total.

Hasil yang mencapai batas **selalu ditandai** (`… [truncated: …]`) — berlaku untuk `grep`, `bash`, `code_run`, LSP, MCP, `web_search`, dan memori. Tanpa penanda, output dianggap utuh. Bila melihat penanda, persempit pola/path sebelum menyimpulkan.

### `todo_write` / `todo_read` — rencana per sesi

Untuk task 3+ langkah. Kirim **seluruh daftar** setiap kali, bukan delta. Disimpan di `.minicode/todos/<sessionId>.json`.

```
todo_write({ todos: [
  { content: "baca schema", status: "completed" },
  { content: "tulis migrasi", status: "in_progress" },
  { content: "jalankan test", status: "pending" }
]})
```

Status: `pending` | `in_progress` | `completed` | `cancelled`. Hanya satu `in_progress` yang dipertahankan — sisanya dinormalisasi ke `pending` agar daftar punya satu fokus. Daftar dirender utuh di TUI dan output one-shot.

### `bash` — streaming & background

Foreground memancarkan progres inkremental (`provider:extension` kind `bash-output`), terlihat di `--verbose`. Untuk proses yang hidup melewati satu turn:

```
bash({ cmd: "bun run dev", background: true })   # → job id bg_xxxxxxxx
bash_output({ id: "bg_xxxxxxxx" })               # output BARU sejak baca terakhir
bash_kill({ id: "bg_xxxxxxxx" })                 # SIGTERM lalu SIGKILL
```

Batas: `BASH_BACKGROUND_MAX_JOBS` job hidup sekaligus; semua job dimatikan saat CLI keluar (tidak ada proses yatim). `background:true` **ditolak** saat `--sandbox` aktif — container/namespace ephemeral mati bersama call-nya, jadi janji isolasi tidak bisa dipenuhi untuk proses berumur panjang.

### `git_commit` — satu-satunya tool git yang menulis

```
git_commit({ message: "fix: null check", paths: ["src/a.ts"] })
git_commit({ message: "wip", all: true })   # semua file yang SUDAH dilacak git
```

**Di-gate** seperti `delegate_task`: mode `auto` meminta persetujuan sekali (TTY) atau menolak (non-TTY); `readonly`/`plan`/`allowlist` menolak. Sub-agent tidak mendapatkannya — commit adalah keputusan tingkat-task.

Yang **sengaja tidak** ada: `push`, `amend`, `reset`, `rebase`, `checkout`, `branch -D`, `stash drop`. Semuanya sulit dibalikkan atau mempengaruhi remote/repo orang lain.

Keamanan: pesan diteruskan sebagai satu argumen `-m` sehingga `$(...)` dan backtick di dalamnya **tidak dieksekusi**; `git add -- <paths>` memisahkan path dari opsi sehingga file bernama `-weird.txt` tidak jadi flag; path dan `cwd` dijail seperti tool lain. Bila tak ada perubahan, hasilnya pesan informatif — bukan exception.

## Autentikasi

Dua jalur, bisa dipakai bersamaan:

### API key

```bash
minicode config add --baseUrl https://api.openai.com/v1 --apiKey sk-…
```

### OAuth device-code (tanpa API key)

```bash
minicode auth list            # provider yang mendukung
minicode auth login qwen      # tampilkan kode → buka URL → tunggu persetujuan
minicode auth status          # kredensial + kapan kedaluwarsa
minicode auth logout qwen
```

Alurnya RFC 8628: minicode menampilkan kode singkat dan URL, Anda menyetujui di browser, minicode menyelesaikan sisanya. Tidak butuh redirect URI dan tidak membuka port lokal, jadi berfungsi lewat SSH.

**Di mana token disimpan:** `~/.minicode/auth.json` (chmod 600) — **bukan** `config.json`. Alasannya: `.minicode/config.json` lokal sering ikut ter-commit, sementara token adalah rahasia berumur pendek. Provider OAuth menyimpan `apiKey: ""` di config dan token diambil saat runtime.

Refresh otomatis dengan margin 60 detik sebelum kedaluwarsa, jadi login sekali cukup. Bila provider OAuth belum login (atau refresh gagal), provider itu **dibuang dari daftar dengan peringatan** alih-alih mengirim header kosong yang gagal dengan pesan membingungkan.

> **Catatan kejujuran:** mekanisme device flow diuji lengkap terhadap server OAuth lokal (18 test mencakup pending/slow_down/denied/expired/clamp), tapi nilai endpoint dan clientId provider belum dikonfirmasi lewat login sungguhan. Bila salah, `auth login` melaporkan error dari server apa adanya.

## Biaya & harga model

25 harga bawaan selalu tersedia offline. Untuk cakupan lebih luas:

```bash
minicode pricing sync                       # tarik models.dev (3.162 model, ~213 KB)
minicode pricing status                     # sumber aktif + umur cache
minicode pricing show claude-sonnet-4-5     # harga satu model + sumbernya
minicode pricing clear                      # hapus cache, kembali ke bawaan
```

**Tidak ada fetch otomatis.** Jalur run biasa hanya membaca cache lokal; request ke pihak ketiga saat startup menambah latensi dan membocorkan pola pemakaian (IP + waktu) tanpa diminta. Cache kedaluwarsa tetap dipakai dengan tanda — harga lama lebih berguna daripada "N/A".

Cara pencocokan: per-segmen (pemisah `/` dan `:`), kunci terpanjang menang. Jadi `deepseek/deepseek-chat:free` cocok, `claude-sonnet-4-5` menang atas `claude-sonnet-4`, dan `my-gpt-4o-wrapper` **tidak** cocok dengan `gpt-4o`.

Satu model id sering ditawarkan beberapa provider dengan harga berbeda — `qwen3-coder-plus` ada di 6 provider, dua di antaranya $0 karena paket berlangganan. Overlay membuang kandidat gratis bila ada yang berbayar, lalu mengambil **median**, supaya `--budget` tidak diam-diam menganggap semuanya gratis.

Semua angka tetap **estimasi**: biaya riil tergantung provider, paket, dan diskon.

## MCP & LSP

**MCP:** dua transport didukung.

```bash
# stdio — server lokal yang di-spawn minicode
minicode config mcp add fs --command npx --args "-y,@modelcontextprotocol/server-filesystem,."

# Streamable HTTP — server remote (spec 2025-03-26, SSE juga ditangani)
minicode config mcp add ctx7 --url https://mcp.example.com/mcp --header "authorization=Bearer xxx"

# server HTTP di localhost butuh opt-in eksplisit (anti-SSRF)
minicode config mcp add lokal --url http://127.0.0.1:3000/mcp --allow-private
```

Setelah terdaftar, `mcp_list` menampilkan **tools, resources, dan prompts** sekaligus, dan tersedia empat tool:

| Tool | Spec | Catatan |
|---|---|---|
| `mcp_list` | `tools/list` + `resources/list` + `prompts/list` | read-only, tidak di-gate |
| `mcp_call` | `tools/call` | di-gate |
| `mcp_read` | `resources/read` | di-gate — lihat alasan di bawah |
| `mcp_prompt` | `prompts/get` (server merender argumen) | di-gate |

Tool dinamis `serverId.toolName` juga otomatis muncul.

`resources` dan `prompts` bersifat **opsional di spec**: server yang membalas "Method not found" (mayoritas ekosistem) tetap terhubung dengan tool-nya utuh. Blob biner dari `resources/read` tidak ditumpahkan sebagai base64 — diganti penanda ukuran, karena 2.000 karakter base64 memakan konteks tanpa memberi informasi.

**Keamanan transport HTTP:** host privat **ditolak** kecuali `--allow-private` — server MCP yang menunjuk `169.254.169.254` atau `localhost` adalah jalur SSRF, dan penjaganya sama dengan `web_fetch` (DNS pinning). Redirect tidak diikuti. Ukuran balasan dibatasi. Balasan dicocokkan per request id, jadi server yang membalas id lain tidak diterima sebagai hasil. Header `Authorization` diteruskan tapi tidak pernah masuk log.

**Catatan izin:** semua tool MCP bertitik **selalu di-gate** — mode `auto` meminta konfirmasi sekali per tool (jawab `[a] Always` untuk persist ke allowlist); mode `readonly`/`plan`/`allowlist` menolaknya. Server terdaftar tidak mendapat wildcard auto-allow (proteksi supply-chain).

`mcp_read` dan `mcp_prompt` di-gate **meski read-only**: keduanya menarik konten dari server pihak ketiga langsung ke konteks model, yang merupakan jalur prompt-injection. "Read-only" tidak berarti "aman". `mcp_list` tidak di-gate karena hanya melaporkan metadata server yang Anda daftarkan sendiri.

**Model kepercayaan:** permission hanya mengontrol *pemanggilan* — satu approval berlaku untuk satu pasangan server+tool+args, tidak melebar ke tool/server lain. Capability di balik server (filesystem, network, proses, API eksternal) tidak dapat diketahui secara statis: anggap setiap `mcp_call` sebagai external capability tak-terklasifikasi dengan efek arbitrer di sisi server. Pembatalan menghentikan penungguan (dan membatalkan request HTTP), tetapi tidak membunuh proses server stdio maupun membatalkan efek yang sudah terjadi.

**LSP:** `minicode config lsp add` untuk daftarkan language server. Setelah terdaftar: `lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols`, `lsp_workspace_symbols`. LSP diagnostics juga otomatis di tool `edit`/`write_file` bila server terkonfigurasi.

## Verify & Self-Healing

`--verify` auto-detect perintah (typecheck → test → tsconfig). Sebelum run, baseline diuji dulu: bila sudah merah, catatan Health-Check ditempel ke prompt awal agar agen memperbaiki dulu, bukan menumpuk di atas kerusakan. Setelah run utama, verify dijalankan. Bila gagal, agen diperintahkan memperbaiki (maks 3 siklus). Output error dibungkus dalam fence agar tidak terpengaruh prompt injection.

## Sandbox

**Aktif otomatis.** Sejak Fase 2, sandbox tidak lagi murni opt-in:

| Kondisi | Yang terjadi |
|---|---|
| bubblewrap (Linux) / seatbelt (macOS) tersedia | bash berjalan di dalamnya, tanpa perlu flag |
| tidak tersedia (termasuk **semua Windows**) | permission default turun ke `allowlist` + alasannya dicetak sekali |
| `--allow-all` / `--ask` / `--plan` / `--allowlist` diberikan | pilihan Anda dihormati, tidak ditimpa dan tidak ada peringatan |
| `--sandbox none` | opt-out sadar; tanpa downgrade, tanpa peringatan |
| `--sandbox docker` | container ephemeral (`--network none`, 512m, 1 CPU, `node:22-alpine`) |
| `--sandbox docker` tapi daemon mati | tidak berpura-pura terisolasi: turun ke `allowlist` + peringatan |

Docker **tidak** dipakai otomatis meski tersedia — menarik image dan menjalankan container tanpa diminta terlalu invasif untuk sebuah default.

**`code_run`** selalu lewat sandbox runner (docker bila `--sandbox docker`, OS sandbox bila `os`): network-isolated, cwd = session root, env tersanitasi. Bila backend yang diminta tidak tersedia, tool **menolak** (fail-closed) — tidak ada fallback diam-diam ke eksekusi host. Image docker default (`node:22-alpine`) membawa node, bukan python3: python butuh `MINICODE_SANDBOX_IMAGE` yang menyediakannya.

### Lapisan perlindungan bash

1. **bash-guard ternormalisasi** (`src/policy/bash-guard.ts`) — quote pemisah kata dibuang dan assignment variabel sederhana disubstitusi **sebelum** pemeriksaan. Ini menutup kelas bypass, bukan pola individual:

   | Dulu lolos | Kenapa | Sekarang |
   |---|---|---|
   | `cat .e""nv` | regex melihat `.e""nv`, shell membaca `.env` | ditolak |
   | `X=.env; cat $X` | regex tak pernah melihat `.env` | ditolak |
   | `p=python3; $p -c 1` | regex tak melihat `python3 -c` | ditolak |
   | `node --eval "1"` | hanya `-e` yang di-regex | ditolak |
   | `env`, `set`, `export -p` | hanya `printenv` yang diblok | ditolak |
   | `curl -F file=@~/.ssh/id_rsa` | tak ada aturan upload | ditolak |
   | `bash <(curl x)` | tak ada aturan process substitution | ditolak |
   | `rm -rf ..` | pola lama hanya kenal `/` dan `~` | ditolak |

2. **Allowlist** (`--allowlist`, dan default bila tak ada sandbox) — hanya bentuk perintah read/build: `git status/diff/log/branch/show`, `bun test/run/x tsc`, `npm run/exec`, `npx`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `which`, `echo`, `pwd`. Operasi tulis lewat shell (`mkdir`, `cp`, `mv`, `rm`, `touch`) **ditahan** — agent yang perlu menulis file punya `write_file`/`edit` yang ter-jail. Untuk `npm exec`/`npx`/`bun run`/`bun x`, arg tak boleh memuat ekspansi shell (`$`, backtick) atau redirection.

3. **Path jail** — realpath-based, berlaku bahkan saat `--allow-all`.

4. **Env scrub** — `sanitizeSpawnEnv` menghapus variabel berkata-kunci kredensial dari hasil merge final. Nama vendor telanjang tidak lagi ikut: `GITHUB_WORKSPACE`, `GITHUB_REF`, `GOOGLE_CHROME_PATH`, `REDIS_HOST`, `AWS_REGION` **tetap ada** (sebelumnya terhapus dan memecahkan build CI), sementara `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `DATABASE_URL` tetap di-strip.

5. **web_fetch / web_search** — redirect manual 5 hop + DNS pinning 30s + body 2MB.

### Mengukur, bukan mengklaim

Dua lapis, keduanya bisa Anda jalankan sendiri:

```bash
bun run gate:bash            # korpus manual: 38 pola serangan + 15 perintah sah
bun run extreme:fuzz         # mutasi kombinatorial ber-seed (~13.000 varian)
bun experiments/extreme-bash-fuzz.ts --seed 999 --rounds 3   # reproduksi spesifik
```

Probe manual menguji serangan yang sudah dipikirkan. Fuzz membangkitkan varian sendiri dari transformasi yang shell anggap setara — quote-split, indirection variabel (nama perintah maupun argumen), rantai dua tingkat, flag panjang, wrapper perintah, chaining — dan **menemukan 3 kelas bypass yang korpus manual lewatkan**:

| Yang lolos | Kenapa |
|---|---|
| `command env`, `nice env`, `exec 'env'` | Deteksi env-dump ter-anchor ke awal perintah; wrapper menggeser posisi kata |
| `rm --recursive --force /` | Pola lama hanya mencari `-[a-z]*r` |
| `rm -rf /; :` | Pola target mensyaratkan whitespace; `;` menempel langsung |

Semuanya kini tertutup (`stripCommandWrappers` membuang 14 wrapper hingga 4 lapis) dan terkunci sebagai regresi. Exit 0 hanya bila **0 bypass dan 0 over-block** di kedua lapis.

> **Batas yang tetap jujur.** bash-guard adalah analisis statis atas bahasa Turing-complete. Command substitution dinamis (`$(curl ...)`), aritmetika shell, dan indirection berlapis tidak bisa diselesaikan tanpa mengeksekusi. Guard menaikkan biaya serangan; **sandbox OS/container yang memberi isolasi**. Untuk task benar-benar tak terpercaya, jalankan di Linux/macOS (bwrap/seatbelt otomatis) atau `--sandbox docker`.

## Plan Mode

`--plan` → read-only. Agen bisa membaca, mencari, merencanakan (`todo_read` tetap boleh), tetapi tidak bisa menulis file, menjalankan bash, atau `todo_write`. Sub-agent boleh dipanggil tetapi dipaksa mode explore/read-only (tak bisa menulis). Berguna untuk review dan planning sebelum eksekusi. Di TUI, Shift+Tab bisa memutar ke mode ini saat sesi berjalan.

## Budget

`--budget <usd>` → lacak biaya LLM. Peringatan 80% → kuning. Bila lewat budget: one-shot `exit(1)`, REPL `break` loop. `--budget-strict` (atau `MINICODE_BUDGET_STRICT=1`) = fail-closed: cost tak dikenal karena model tanpa harga dianggap over budget, bukan diabaikan. `exec` menegakkan `--budget` sama seperti one-shot.

## Checkpoint & Undo

Setiap turn otomatis membuat checkpoint. Ada dua mode, dipilih otomatis:

**Repo git (utama).** Snapshot disimpan sebagai **SHA tree git**, bukan salinan isi file. Biayanya O(delta) bukan O(ukuran workspace), dan tidak ada batas jumlah file — perubahan 250 file dari satu `bash` ter-undo seluruhnya.

Jaminannya:
- Index dan `HEAD` Anda **tidak pernah** disentuh. Tidak ada `git add`, `commit`, `checkout`, `reset`, atau `stash` pada state Anda.
- Ref disimpan di `refs/minicode/<sesi>/…` dan menunjuk *tree*, bukan commit — jadi tidak muncul di `git log --all` maupun `git branch`.
- Aman dari `git gc`: ref mem-pin object-nya.
- Line ending tidak diubah (`core.autocrlf=false` dipaksa di setiap operasi).
- Restore hanya menyentuh path yang berbeda; file lain tak tersentuh.

**Batas yang perlu diketahui:** snapshot memakai `git add -A`, jadi **file ber-`.gitignore` tidak ikut** dan perubahan padanya tidak bisa di-undo. Ini disengaja (kami tidak ingin menyimpan `node_modules`), tapi berarti undo mencakup "yang dilacak git", bukan "seluruh disk".

**Non-repo (fallback).** Snapshot isi file seperti sebelumnya, dengan cap `WORKSPACE_SNAPSHOT_LIMIT`.

`/undo` kembali ke kondisi sebelum turn, `/redo` ke kondisi sesudahnya. Manifest di `.minicode/checkpoints/` dengan cap **20** terbaru (`LIMITS.CHECKPOINT_MAX_COUNT`). Turn yang tidak mengubah apa pun tidak membuat checkpoint.

Pointer undo/redo adalah metadata turunan, bukan kebenaran: setiap operasi menulis marker jurnal (`newIndex`) *setelah* apply files dan *sebelum* save pointer. Crash di antara keduanya membuat pointer basi — saat start berikutnya MiniCode mengadopsi pointer dari marker terbaru yang valid (indeks dalam batas + turn cocok), tanpa mengeksekusi ulang, tanpa menyentuh file. Marker basi/foreign (indeks di luar batas, turn tak cocok) diabaikan dengan peringatan. Menghapus sesi ikut menghapus manifest-nya agar id yang dipakai ulang tak mewarisi pointer basi.

## Recovery Journal

Setiap mutasi tool (tulis/edit/hapus file, `bash`, `git_commit`, `mcp_call`, `code_run`, `delegate_task`, memori tulis/hapus) dicatat di `.minicode/journal-<sesi>.jsonl` — satu baris per status: `pending` saat eksekusi dimulai, `committed`/`failed` saat selesai, `finalized` setelah riwayat turn durable di SQLite. Saat resume (atau sesi baru dengan jurnal tertinggal), MiniCode membaca jurnal **sebelum** seed kernel:

- `committed` yang turn-nya hilang dari DB → **tidak diulang**; model diberi catatan narasi sistem.
- `pending`/`failed` → model diberi direktif verifikasi (satu blok sistem, bukan pesan palsu); **dilarang redo buta**, ulangi hanya lewat gate normal setelah verifikasi.
- `committed` dari MCP = *external-acknowledged* (klaim server), bukan komit lokal → wajib baca-balik.

Kejujuran yang disengaja: jurnal **bukan transaksi** (tak ada atomic lintas FS+DB), `pending` **bukan** gagal (melainkan ambigu — efek mungkin sudah terjadi), dan `committed` **bukan** berarti seluruh turn durable. Jurnal tak menyimpan isi argumen/file/kredensial — hanya hash + path relatif. `sessions purge` ikut menghapus jurnal sesi basi.

File jurnal dibuat **eager** saat sesi terpasang (kosong = sesi ada, belum bermutasi — berbeda dari file yang hilang = bukti hilang). Jurnal anak (`delegate_task`) terpisah per sesi anak: anak yang selesai normal tanpa mutasi = sunyi; anak hilang padahal delegasi committed = warning degraded; turn anak tak pernah dicocokkan dengan turn parent (namespace terpisah — anak ter-cover bila delegasinya committed + finalized). Jurnal yatim (sesi tak dikenal, tak dirujuk, lebih tua dari TTL) ikut ter-purge; yang tak terbaca tak pernah dihapus.

## Sessions

Sesi disimpan di `.minicode/sessions.db` (WAL). `minicode sessions list` untuk daftar. `--resume <id>` untuk melanjutkan dengan history penuh (termasuk `toolCallId`/`name`) — saat resume, workspace dibandingkan ke checkpoint terakhir dan divergensi dilaporkan (bukan replay buta). Sesi basi dihapus otomatis setelah **30 hari** (`MINICODE_SESSION_TTL_DAYS=0` = simpan selamanya; nilai lain dalam hari). `minicode sessions purge` untuk menghapus manually.

## Memory

Memori lintas sesi dua lapis: `MEMORY.md` (hierarki global → lokal → root → `CLAUDE.md` → `.minicode/rules/*.md`) selalu dimuat ke system prompt, plus index vektor hybrid (`vector.db`, cosine 0.7 + keyword 0.3) yang di-inject sebagai `# Relevant memory` bila skor ≥ ambang (0.20 hybrid / 0.25 keyword-only). Ranking memakai MMR (λ 0.7) agar prompt tidak dipenuhi parafrase yang sama; entri >2000 char dipecah jadi chunk overlap 200. Retensi hierarkis: `fact`/`decision`/`preference` 180 hari, `summary` 90 hari, `snippet` 14 hari; maks 5000 baris, prune otomatis tiap tulis. `minicode memory status [--json]` untuk rows, ukuran DB/WAL, sebaran model/dim, dan hit-rate RAG dari traces.

## Repo Intelligence

System prompt otomatis memuat repo-map berbasis **regex** (9 bahasa) dengan fallback LSP `workspace/symbol`. Cache di `.minicode/repomap.json` (sig mtime). File diurutkan import-graph (60 files, 2.5k chars). `MINICODE_REPOMAP=regex` untuk skip LSP. Hashline edit `src/tools/hashline.ts` deterministik.

Tree-sitter **tidak** dipakai. Prototipe `web-tree-sitter` berjalan dan cepat, tapi perbandingan pada file nyata menunjukkan yang terlewat regex hampir seluruhnya member kelas dan helper lokal — bukan simbol top-level. Sementara repo-map sudah menyentuh cap 2.500 char, jadi simbol tambahan justru menggeser yang lebih penting. Alasan lengkap + tabel pengukuran ada di komentar `extractSymbolsAsync` (`src/repo/repomap.ts`).

## Benchmark

```bash
bun run bench                            # butuh provider (resolve rate nyata)
bun run bench:smoke                      # --fake, untuk CI
bun run bench --tasks path/to/tasks.json # external tasks (SWE-bench-format)
bun run audit:harness                    # 60 cek harness deterministik, tanpa API key
```

Metrik: resolve rate, steps, token, cost, durasi. Delta terhadap run sebelumnya ditampilkan.

Format `tasks.json` (SWE-bench-format):

```json
[
  {
    "id": "fix-issue-1",
    "prompt": "Fix the bug in buggy.ts",
    "files": [{ "path": "buggy.ts", "content": "export function f(){ return 1 }" }],
    "verify": ["export function f()", "!return 1"]
  }
]
```

## Telemetry

`.minicode/traces.jsonl` — satu baris JSON per run (sessionId, timestamp, prompt, steps, tokens, cost, ok/error, memoryHits). Rotate keep 1000 baris (atomic tmp+rename). Prompt di-redact via secret scrubber sebelum disimpan; file chmod 600. **Opt-out:** set `MINICODE_TELEMETRY=0` — tidak ada file yang ditulis.

## Pengujian

```bash
bun install            # sekali (butuh bun >=1.0; tanpa clone tambahan)
bun test               # offline/hermetic; live & docker di-skip otomatis
bun x tsc --noEmit     # tsc strict, mencakup src cli test bench scripts
bun run lint           # biome check
bun run gate:coverage  # gate coverage agregat (baris "All files")
bun run gate:bash      # korpus serangan bash
bun run gate:pack      # gate tarball npm (graf import, rahasia, ukuran)
bun run vendor:check   # vendor/minicore sinkron dengan ../minicore
bun run extreme        # tiga harness adversarial (fuzz + stress + server jahat)
bun run bench:smoke    # fake tasks, CI-safe
bun run bench --runs 2 # median 2 runs
minicode exec "prompt" --json       # headless CI (JSONL + summary di stdout)
MINICODE_GREP_ENGINE=js bun test test/phase1-tools.test.ts   # jalur grep fallback
MINICODE_LIVE=1 bun run test:live   # live E2E (butuh provider + API key)
```

Eksperimen adversarial terpisah:

```bash
bun run extreme:fuzz                                   # fuzz bash-guard
bun experiments/extreme-bash-fuzz.ts --seed 42 --rounds 5
bun run extreme:git                                    # stress shadow-git
bun experiments/extreme-shadow-git.ts --files 5000 --sessions 10
bun run extreme:mcp                                    # server MCP jahat
```

Semua test hermetic (fetch di-mock, DB tmpdir) dan aman dijalankan berulang tanpa jaringan. Jumlah test tidak dicantumkan di sini — jalankan `bun test` untuk angka terkini.

## Troubleshooting

- **LSP tidak jalan:** `minicode config lsp add .ts --command typescript-language-server --args --stdio`. Pastikan server terinstall.
- **Docker sandbox:** `docker pull node:22-alpine`. Bila daemon mati, permission turun ke `allowlist` (bukan diam-diam tanpa isolasi).
- **Kenapa perintah saya ditolak padahal aman?** Kemungkinan mode default `allowlist` aktif karena tak ada OS sandbox. Pesan `[sandbox]` di awal run menjelaskannya. Pilih sendiri dengan `--allow-all` atau `--ask`, atau jalankan `bun experiments/bash-bypass-probe.ts` untuk melihat apa yang dianggap sah.
- **`--sandbox os` tidak berefek:** bubblewrap/seatbelt tidak ada di Windows. Pakai `--sandbox docker`, atau terima default `allowlist`.
- **Variabel env hilang di subprocess:** hanya yang berkata-kunci kredensial di-strip. `GITHUB_WORKSPACE`/`REDIS_HOST`/`AWS_REGION` seharusnya tetap ada sejak Fase 2; kalau variabel non-rahasia Anda ikut hilang, itu bug — laporkan nama variabelnya.
- **`grep` terasa lambat:** install `rg` (ripgrep). Cek jalur aktif dengan `MINICODE_GREP_ENGINE=js` untuk membandingkan.
- **`/undo` tidak memulihkan file tertentu:** kemungkinan file itu ada di `.gitignore`. Mode shadow-git hanya men-snapshot yang dilacak git (disengaja, agar `node_modules` tak ikut).
- **MCP HTTP ditolak "host privat":** server di localhost/LAN butuh `--allow-private` saat `config mcp add`. Ini penjaga SSRF, bukan bug.
- **MCP HTTP gagal "redirect tidak diikuti":** URL server salah atau server mengarahkan ke host lain. Perbaiki URL-nya; redirect sengaja tidak diikuti.
- **`auth login` gagal / kode tak diterima:** endpoint provider mungkin berubah. Pesan error dari server ditampilkan apa adanya — cek `minicode auth list` untuk spec yang dipakai.
- **Provider OAuth hilang dari daftar:** belum login atau refresh gagal. `minicode auth status` menunjukkan mana yang kedaluwarsa; `minicode auth login <id>` untuk memulihkan.
- **`git_commit` ditolak:** tool ini di-gate. Di non-TTY (CI) ia selalu ditolak — itu memang perilaku yang diinginkan. Pakai `--allow-all` bila commit otomatis benar-benar dibutuhkan.
- **Biaya tampil N/A:** model tak ada di tabel. `minicode pricing sync` menambah 3.162 model; `pricing show <model>` memastikan apakah sudah dikenali.
- **File besar tak bisa dibaca:** pakai `offset`/`limit` di `read_file` — file >2 MB memang ditolak tanpa itu.
- **Background job tak jalan:** `background:true` ditolak saat `--sandbox` aktif; jalankan tanpa sandbox atau pakai foreground.
- **Verify tidak jalan:** set `MINICODE_VERIFY_CMD` atau `verifyCommand` di config.
- **Budget tidak akurat:** harga di `usage.ts` adalah estimasi rata-rata; biaya riil tergantung provider.
- **`bun install` gagal cari minicore:** pastikan `vendor/minicore` ada (ikut repo). Untuk sync ulang dari sumber butuh clone `../minicore` lalu `bun run vendor:minicore`.
