\n
## Memory dua lapis

1. `MEMORY.md` hierarki (global → lokal → root → `CLAUDE.md` → `.minicode/rules/*.md`) selalu dimuat ke system prompt.
2. Index vektor hybrid (`vector.db`, cosine 0.7 + keyword 0.3) di-inject sebagai `# Relevant memory` bila skor ≥ ambang (0.20 hybrid / 0.25 keyword-only). Ranking MMR (λ 0.7) + dedup cosine >0.92 agar prompt tidak penuh parafrase. Entri >2000 char dipecah chunk overlap 200.

Kategori: `fact|decision|preference|snippet|summary` + `tags`. Default `fact`; boost `decision` +0.1 bila query match. `write_memory {category?, tags?}`.

Scope baca: `cwd` (default) | `global` | `all` (gabung, tanpa silent shadowing). Atur via `MINICODE_MEMORY_SCOPE`.

Retensi hierarkis per kategori: `fact`/`decision`/`preference` 180 hari, `summary` 90 hari, `snippet` 14 hari; maks 5000 baris, prune + `VACUUM` periodik tiap tulis. `access_count` per row.

```bash
minicode memory status [--json]   # rows, bytes DB/WAL/SHM, sebaran model/dim, hit-rate RAG
```

Auto-simpan: summary persist (`compaction.ts:187` → `addMemory(summary.slice(0,1200))`) + snippet verify sukses. Opt-out `MINICODE_AUTO_MEMORY=0`.

Embedding: default `text-embedding-3-small` (`MINICODE_EMBED_MODEL`). Dim-mismatch → warn sekali + fallback keyword-only. FTS5 (`porter unicode61`) + trigger sync; fallback LIKE bila MATCH gagal.

## Sessions

Sesi di `.minicode/sessions.db` (WAL, capped + busy-retry async). `--resume <id>` melanjutkan full history (termasuk `toolCallId`/`name`); workspace dibandingkan ke checkpoint terakhir dan divergensi dilaporkan (bukan replay buta). TTL 30 hari (`MINICODE_SESSION_TTL_DAYS=0` = selamanya). `minicode sessions purge` hapus manual. Branch via `branchSession` (fork history+turns).

## Checkpoint & Undo

Setiap turn otomatis checkpoint. Dua mode otomatis:

**Repo git (utama).** Snapshot sebagai **SHA tree git** — O(delta), tanpa cap jumlah file. Index/`HEAD` tak pernah disentuh (tanpa add/commit/checkout/reset/stash pada state user). Ref di `refs/minicode/<sesi>/…` menunjuk *tree* sehingga tak muncul di `git log`. Aman dari `gc` (ref mem-pin object). `core.autocrlf=false` dipaksa. Restore hanya sentuh path berbeda.

Batas: snapshot memakai `git add -A`, jadi file ber-`.gitignore` tidak ikut (disengaja agar `node_modules` tak ikut).

**Non-repo (fallback).** Snapshot isi file dengan cap `WORKSPACE_SNAPSHOT_LIMIT`.

`/undo` ke sebelum turn, `/redo` ke sesudahnya. Manifest `.minicode/checkpoints/` cap 20 terbaru. Turn tanpa perubahan tidak membuat checkpoint. Pointer dari marker jurnal (bukan kebenaran mutlak) — crash di tengah diadopsi dari marker valid berikutnya.

## Recovery journal

Setiap mutasi (tulis/edit/hapus, `bash`, `git_commit`, `mcp_call`, `code_run`, `delegate_task`, memory tulis/hapus) dicatat di `.minicode/journal-<sesi>.jsonl` — di kode disebut *mutation journal*: `pending` → `committed`/`failed` → `finalized` (setelah turn durable di SQLite). Saat resume, dibaca **sebelum** seed kernel:

- `committed` yang turn-nya hilang → tidak diulang; model diberi catatan narasi.
- `pending`/`failed` → direktif verifikasi; dilarang redo buta.
- `committed` MCP = *external-acknowledged*, wajib baca-balik.

Jurnal bukan transaksi atomik; `pending` = ambigu (efek mungkin sudah terjadi). Hanya hash + path relatif (tanpa isi/kredensial). File dibuat eager saat sesi terpasang. Jurnal anak terpisah per sesi anak. `sessions purge` ikut hapus jurnal basi.

## Konteks & compaction

Model hanya melihat jendela riwayat terbatas (**konteks**). Saat percakapan menekan jendela itu, MiniCode **memadatkan** (compaction): turn lama diganti satu ringkasan, turn terbaru dipertahankan utuh. Anda melihatnya sebagai baris `── compacted: …` di output.

- **Kapan terjadi:** otomatis saat tekanan konteks, sebelum batas jendela tercapai. Bila sesudah padat masih kurang, run gagal eksplisit (`context window exceeded`) — bukan sunyi.
- **Yang dipertahankan:** ringkasan fakta — path file, signature, snippet penting, hasil tool, error, next steps. Ringkasan sebelumnya dibawa verbatim (tidak diringkas ulang) agar makna tak melenceng tiap siklus.
- **Yang mungkin hilang:** teks lengkap turn lama (dipotong ~250 char/baris saat diringkas), detail output tool, urutan persis percakapan.
- **Riwayat asli tidak disimpan ganda:** sesi berjalan dan sesi tersimpan mengikuti state terbaru (ringkasan + turn baru). Yang perlu durable lintas sesi, tulis eksplisit via `write_memory`.
- **Ringkasan lebih cerdas bila ada kunci DeepSeek** (`DEEPSEEK_API_KEY`): ringkasan dibuat LLM (timeout 10 dtk); tanpanya dipakai ringkasan mekanikal. Keduanya memagar konten tak-terpercaya sebagai data + secret-scrub sebelum diringkas.
- **Beda dengan memory:** ringkasan konteks hidup di sesi berjalan; `write_memory`/vector hidup lintas sesi dan bisa di-retrieval. Ringkasan juga disimpan sebagai memori kategori `summary` — matikan via `MINICODE_AUTO_MEMORY=0` bila tak diinginkan.

## Repo intelligence & telemetry

System prompt memuat repo-map regex (9 bahasa) + fallback LSP `workspace/symbol`. Cache `.minicode/repomap.json` (sig mtime). File diurut import-graph (60 files, 2.5k chars). `MINICODE_REPOMAP=regex` skip LSP. Tree-sitter sengaja tidak dipakai (alasan terukur di `extractSymbolsAsync`).

Telemetry `.minicode/traces.jsonl` — satu baris per run (tokens, steps, cost, durasi); prompt di-scrub; chmod 600; rotate 1000 baris. Opt-out `MINICODE_TELEMETRY=0`. `minicode stats` tampilkan deny-rate dari `step-traces.jsonl`.
