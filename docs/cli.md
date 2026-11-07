# CLI — Mode & Flags

Semua cara menjalankan Minicode: interaktif, sekali jalan, pipe, dan otomasi CI — plus flags dan environment.

## Mode

| Perintah | Fungsi |
|---|---|
| `minicode` | Mode interaktif (TUI fullscreen) + wizard bila belum ada provider |
| `minicode "prompt"` | Sekali jalan (headless) |
| `echo "prompt" \| minicode` | Via pipe |
| `minicode exec "prompt" [--json]` | Headless CI — event JSONL + baris `{"type":"summary"}` di stdout |
| `minicode acp` | Server JSON-RPC stdio untuk IDE (subset minimal: initialize/run/cancel/shutdown) |
| `minicode daemon <start\|status\|stop\|issue\|sessions>` | Daemon lokal: host proses, status, hentikan, terbitkan perintah, daftar sesi anak |
| `minicode --interactive` | Paksa TUI interaktif |
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
| `minicode memory reconcile [--json] [--cwd PATH]` | Samakan `vector.db` ↔ `.minicode/MEMORY.md` (adopsi entri vector-only, tambah baris file-only; tidak menghapus) |
| `minicode doctor [--json]` | Diagnosis lokal |
| `minicode mcp serve` | Ekspos minicode sebagai MCP server |
| `minicode openwork [inventory\|context\|export\|merge]` | Baca, susun konteks, ekspor, atau deduplikasi pekerjaan lintas sesi; aksi tidak menjalankan task |

Subcommand di-route di `cli/router.ts` (`stats`, `sessions`, `mcp`, `config`, `skills`, `providers`/`models`/`sync`, `auth`, `pricing`, `exec`, `daemon`, `memory`, `doctor`, `acp`, `openwork`).

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
| `--plan` | **Deprecated** — alias untuk `--work-mode PLAN` (read-only planning) |
| `--allowlist` | Bash hanya perintah aman (tool-access policy warisan) |
| `--ask` | Minta persetujuan untuk pemanggilan yang digate (human-supervised) |
| `--allow-all` | Profil akses privileged (path jail + bash-guard tetap aktif) |
| `--model <name>` | Override model (`providerId::model` paksa provider) |
| `--provider <id>` | Paksa provider id agnostik |
| `--resume <id>` | Lanjutkan history yang tersimpan; setelah kompaksi, bagian lama dapat berupa ringkasan + tail |
| `--timeout <ms>` | Hard deadline per prompt (default 900000; 0 = Infinity). Sesi yang idle tidak menghabiskan deadline prompt berikutnya. |
| `--cwd <path>` | Workspace root untuk tool file & jail |
| `--allow-local-config` | Percayai `.minicode/config.json` + allowlist lokal (default: diabaikan) |
| `--max-steps <n>` | Batas langkah tool (default 50) |
| `--context-window <n>` | Ukuran jendela konteks (token) |
| `--session <id>` | ID sesi (default random, disanitasi) |
| `--work-mode <m>` | `DISCUSS` \| `PLAN` \| `BUILD` (default). **Operating mode**: `DISCUSS` = investigasi read-only, `PLAN` = analisis/planning, `BUILD` = implementasi (identitas internal `EXECUTE`). Persetujuan (`AUTO`/`ASK`) dipisah; tool availability mengikuti ceiling WorkMode. Lihat [TUI](repl.md) untuk `/work-mode` |
| `--enable-scheduler` | Opt-in scheduler otonom (default **off**). Tanpa flag ini, scheduler tidak dibangun sama sekali dan `/scheduler` menjawab "not enabled". Eksekusi manual saja lewat `/scheduler run` — tidak ada timer; turn otonom bersifat read-only. Lihat `/scheduler status` dan `/scheduler stop` |
| `--runtime <mode>` | `off` (default) \| `constructed` \| `owned`. Arsitektur eksekusi: `off` = perilaku sekarang, tak berubah; `constructed` = runtime + jurnal durable dibangun, turn masih jalan jalur lama; `owned` = setiap turn di-admit lewat runtime (kernel + jurnal durable) dan admission yang ditolak menjalankan tak apa pun. Nilai tak dikenal = `off` |

Tanpa flag, MiniCode memakai `providers[].contextWindows` dari konfigurasi.
Jika model/gateway tidak punya metadata itu, MiniCode memakai fallback
32.000 token dan memberi peringatan saat sesi mulai. Gunakan batas model yang
tepat pada config atau flag; batas yang terlalu kecil memicu kompaksi dini,
sedangkan batas yang terlalu besar berisiko ditolak provider. Batas berubah
otomatis saat `/model` mengganti model. MiniCode juga membatasi keluaran stream
berdasarkan ruang tersisa setelah system prompt, tools, dan riwayat dihitung.

Di TUI, **Tab** memutar Work Mode (`Discuss` → `Plan` → `Build`) dan **Shift+Tab** meng-toggle Permission Mode (`Auto` ↔ `Ask`). `/mode <AUTO|ASK>` mengubah persetujuan; `/work-mode <DISCUSS|PLAN|BUILD>` mengubah operating mode. Footer menampilkan Work Mode di kiri dan Permission Mode berwarna cyan di kanan, dekat penggunaan konteks; pada terminal sempit label dipadatkan.

## Kapan memakai apa

| Tujuan | Pakai |
|---|---|
| Kerja harian biasa | Default (`BUILD` + `AUTO`) — tulis/eksekusi/commit/delegasi jalan otonom bila authorized |
| Repo asing / perintah belum dipahami | `--ask` (`BUILD` + `ASK`), jawab `always` hanya untuk pasangan tool+args yang sudah dinilai |
| Review/analisis tanpa eksekusi | `--work-mode PLAN` (atau `--work-mode DISCUSS` untuk investigasi read-only murni) |
| CI tanpa manusia | `exec --json` + `--budget`/`--max-steps`; `AUTO` menolak `ask_user` deterministik |
| Otonom penuh di mesin sendiri | Default `BUILD`+`AUTO`; isolasi tambahan `--sandbox docker` (atau OS) + `--budget` |
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
| `MINICODE_WORK_MODE` | `DISCUSS` / `PLAN` / `BUILD` — WorkMode default; precedence ada di [Environment Variables](environment.md) |
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

## Config

Skema, contoh, scope global/lokal, dan lokasi seluruh data ada di [Config — File & Lokasi Data](config.md). Config lokal tetap diabaikan kecuali operator memilih `--allow-local-config` atau `MINICODE_ALLOW_LOCAL_CONFIG=1`.

## Anti-injeksi flag

`cli/args.ts:59-67` berhenti di prompt word pertama: prompt `"review --allow-all"` tidak mengaktifkan flag. `--cwd`/value-flag setelah nama subcommand diparse per-subcommand agar tidak menembus boundary prompt.

## Exit codes

| Kode | Arti |
|---|---|
| `0` | Sukses, atau help yang memang diminta |
| `1` | Gagal runtime: provider error, budget lewat, turn gagal, setup gagal |
| `2` | Salah pakai: argumen hilang/malformed, subcommand asing |

Lookup yang gagal (provider/skill/sesi tak dikenal) = `1`: itu kegagalan operasi, bukan pemakaian. Skrip cukup cek `!= 0` untuk gagal; cek `== 2` untuk spesifik salah pakai.
