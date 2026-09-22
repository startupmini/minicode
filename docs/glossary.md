# Glosarium

Istilah Minicode yang punya makna spesifik. Dokumentasi berbahasa Indonesia dengan istilah teknis English — halaman ini mengunci maknanya.

| Istilah | Makna |
|---|---|
| **MiniCore** | Kernel runtime `STATE / MODEL / ACTION / LOOP` di-vendor ke `vendor/minicore`; inti beku, zero-dep, di-resolve via `#minicore` |
| **Minicode** | Layer agencode di atas MiniCore: tools, agents, policy, providers, memory, sessions, CLI |
| **Tool** | Kemampuan yang dipilih model dalam loop ReAct (37 bawaan + MCP dinamis `serverId.toolName`) |
| **Tool scope** | `full` (semua 37) atau `explore` (subset read-only 12 tool) — flag `--tool-scope` |
| **Permission mode** | Keputusan siapa yang memutuskan aksi: `auto / readonly / plan / allowlist / ask / allow-all` |
| **Gate** | Tool wajib persetujuan manusia saat TTY; non-TTY selalu tolak (mis. `git_commit`, MCP, `delegate_task`) |
| **Path jail** | Pembatasan akses file ke workspace (realpath + symlink + TOCTOU `O_NOFOLLOW`); aktif bahkan `--allow-all` |
| **Bash-guard** | Normalisasi + blokir pola bash berbahaya sebelum eksekusi (quote-split, indirection, wrapper) |
| **Sandbox OS** | bubblewrap (Linux) / seatbelt (macOS) — otomatis bila tersedia |
| **Sandbox Docker** | Container ephemeral `--network none`, 512m, 1 CPU, `node:22-alpine` |
| **Checkpoint** | Snapshot per turn via shadow-git: SHA tree di `refs/minicode/…` (O(delta), HEAD/index tak tersentuh) |
| **Recovery journal** | `journal-<sesi>.jsonl`: `pending` → `committed` → `finalized`; sumber direktif verifikasi saat resume |
| **Session** | Riwayat percakapan di `.minicode/sessions.db` (SQLite WAL); `--resume` lanjut full history |
| **Memory dua lapis** | `MEMORY.md` hierarki (selalu ke system prompt) + vector RAG hybrid (injeksi bila skor ≥ ambang) |
| **RAG hybrid** | Pencarian memory cosine 0.7 + keyword 0.3, ranking MMR (λ 0.7), dedup >0.92 |
| **Repo-map** | Simbol per file (regex 9 bahasa, fallback LSP) disuntik ke system prompt |
| **Skill** | Prompt terpaket `.minicode/skills/*.md` dengan frontmatter `name`/`description` |
| **Hook** | Skrip `pre/post-run` dari `~/.minicode/hooks` + `.minicode/hooks`; mati default, `MINICODE_HOOKS=1` |
| **Env scrub** | `sanitizeSpawnEnv` menghapus kata-kunci kredensial dari env subprocess |
| **Secret scrubber** | Redaksi `sk-`/`ghp_`/`AKIA`/PEM/JWT/Bearer sebelum teks ke LLM |
| **Ledger** | Baris `  › name target` / `  › name: …` di stderr — jejak aksi agent |
| **Scrollback** | Riwayat layar terminal; jalur non-interaktif minicode append-only di sana (interaktif pakai alternate screen) |
| **Transient** | UI muncul-sekali yang menghapus dirinya (spinner, garis status turn) — vs transkrip yang menetap |
| **Composition root** | `cli/index.ts` + `cli/setup.ts`: satu tempat wiring DI (provider, RAG, session, tools) |
| **Seam aditif** | Satu-satunya patch yang dibolehkan ke kernel beku: `compactAsync`, `initialMessages`, `cwd` |
| **Self-contained** | Tanpa clone repo lain — kernel di-vendor, runtime zero-dep, butuh Bun ≥ 1.0 |

## Lanjut

- [Konsep & Desain](concepts.md) — narasi di balik istilah.
- [Arsitektur](architecture.md) — bagaimana lapisan-lapisan itu tersusun.
