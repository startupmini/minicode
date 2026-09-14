# PLAN.md — Rencana penyempurnaan aktif

**Untuk agent AI yang melanjutkan pekerjaan ini.** Dokumen ini adalah satu-satunya rencana yang harus dieksekusi. Rencana lama (`docs/PLAN_UIUX_V6.md`) adalah **arsip** — semua itemnya sudah selesai; jangan dikerjakan ulang.

Basis: audit UI/UX menyeluruh (V6), uji live dua gateway nyata (V7), dan bug hunter UI tiga ronde (V8). Riwayat lengkap di [CHANGELOG.md](CHANGELOG.md).

---

## Keadaan saat ini — baca ini dulu

Jalankan sendiri, jangan percaya angka di dokumen:

```bash
bun test                  # harapan: semua hijau, 0 fail
bun x tsc --noEmit        # harapan: tanpa keluaran
bun run lint              # harapan: exit 0 (warning boleh ada)
bun run gate:coverage     # harapan: melewati min 80 funcs / 84 lines
bun run gate:pack         # harapan: 22 pemeriksaan lulus
bun run extreme           # harapan: 0 bypass, semua pass
```

Kondisi yang sudah dicapai dan **tidak boleh mundur**:

- REPL bisa dipakai (dulu mati bisu pada prompt pertama).
- Lebar karakter dihitung per KOLOM terminal (`src/ui/render/width.ts`), bukan per karakter.
- Teks model/tool disanitasi (`src/ui/render/sanitize.ts`) — hanya SGR yang lewat.
- Biaya sesi kumulatif benar; `--budget` benar-benar memutus (+ `--budget-strict` untuk model tanpa harga, yang cost-nya tak dikenal).
- Error provider tampil ringkas + saran, bukan dump JSON.
- Semua overlay menghormati ukuran terminal sungguhan.
- Bahasa UI diarahkan ke English-only pada surface UI aktif; glyph tetap punya fallback ASCII.

---

## Status eksekusi terbaru (update 2026-09-09)

- ✅ P0-P9 tuntas dan dihapus dari plan (commit `e143db2` 0.9.0 + `b8b5749` 0.9.1): guardrail, coverage, overlay, English-only, tema, data-at-rest, session, tool-layer, env/command, CLI hardening, memory/RAG P0-P2.
- ✅ P12 UI Shell-Max DIEKSEKUSI `b8b5749` (9.3/10): `/copy` OSC52, Ctrl+R/Ctrl+J, statusline rich, wrap/table/diff/picker, harness output-driven. Gate `tsc PASS / lint 9 warn / 1224 pass 0 fail / coverage 81.44/83.65 / pack 22/22`.
- ✅ P13 P0 + P10 P0 + P11 P0 DIEKSEKUSI (`ff70d65` 0.9.2 + `e1c7839`/`346a932` 0.9.3/0.9.4): `--cwd` repo-wide, O_NOFOLLOW, pricing refresh, max_tokens 8192, thought_signature side-map, 4 tool, memori kategori/scope, code_run tanpa shell, trash bersama.
- ✅ P13 P1 + P11 P1 + P10 P1 DIEKSEKUSI (`ff70d65` 0.9.2 + 0.9.5): submit_result, ask_user (gated+DI), plan artifact, snippet verify, branchSession, TTL hierarkis + accessCount, Responses chaining, reasoningEffort map, retry-after honori + coba-ulang-di-tempat, probe /responses, harness TUI 10/10, SWE-bench Lite (dataset 20 pin + test_patch + fake 0/20), doctor, lint 0 warning, coverage-min 80/84.
- ✅ AUDIT UX DIEKSEKUSI (`d69fbec` 0.9.6): Tab kosong toggle plan/build, did-you-mean (≤2), banner konteks, /thinking on-off, sync jujur {updated,failed}, doctor warn 0-model, error tunggal, sandbox notice tepat, models --match bersih, auth non-TTY fail-fast, English-only + regex penjaga, /quit dihapus, USAGE lengkap. **Opsi A konsolidasi**: /cost & /usage → /status, /resume → /sessions; /undo /redo /clear /copy /history tetap mandiri, tampil di /help tapi TIDAK di dropdown. Gate `1284 pass 0 fail / tsc / lint 0 warn / 80.77/84.56 / pack 22/22 / bash 0`.
- ✅ HARNESS P0–P3 DIEKSEKUSI (uncommitted, 2026-09-07/08 — detail: `docs/HARNESS.md`): P0 jail simetris move/delete, `MINICODE_SANDBOX_STRICT`, allowlist `bun run`/`bun x`, scrub `exec --json` + `overBudget`; P1 `budgetStatus` + `--budget-strict` (sekaligus perbaiki `exec` yang mengabaikan `--budget`), `step-traces.jsonl` + klasifikasi deny, `audit:harness` 60 cek, `--verify`+self-heal terverifikasi existing; P2 baseline-first + `--tool-scope explore`; P3 `stats` deny-rate + validasi resume. Uji live 7 model gateway (21 run, 20/21 execution-verified; multifile ketat 4/7). Gate `1336 pass 0 fail / 81.68/85.37 / pack 22/22 / audit 60/60`. DITOLAK sadar: verify default-on, evaluator inferential.
- ✅ SESI UX MODEL+INPUT (uncommitted, 2026-09-09): alur thinking effort DIKUNCI (`Enter` = pilih + picker effort, Esc = batal total; `t` dihapus; badge effort; berlaku sesi berikutnya); effort anti-hilang (`detectAndSave`/`auth login` preserve `reasoningEffort`; mutasi `/model` ditulis ke scope asal — hapus fallback race + `saveProvider` di controller); audit UX lain: Esc batal prompt kosong + `askSecret` null = batal, search keys diperbaiki (Ctrl+D/Ctrl+U, onKey tak membajak), `Gateway >` kosong = batal, konfirmasi timpa provider, umpan balik ✓/✗ menyeluruh, picker clamp/footer/sanitasi, `/sync` restart kondisional, help/keys akurat. Struktur path-guard: `resolveSafePath` = tool PENULIS, `safeOpenRead` = pembaca (read_file/read_image single-open, tanpa verifikasi ganda). Gate `1357 pass 0 fail / 81.84/84.26 / pack 22/22`; min dikunci **80 funcs / 85 lines** (lines dikunci 85 setelah journal 82.42/85.17 dua run identik; funcs berayun 80.6–81.8 antar run — menaikkan ke 81 membuat gate flaky).
- ✅ SINKRON DOK 0.9.19 (2026-09-14): ledger `›` hijau/merah di `docs/architecture.md` + `docs/terminal.md` (sebelumnya `✓`/`✗` era 0.9.16), ambang coverage `docs/contributing.md` 80/85, badge `ARCHITECTURE.html` v0.9.19, web rebuild 32 halaman + `web:check` lolos. Vendor sync DITUNDA sadar (seam lokal `cwd`/`permissionMode` belum dihilirkan; delta upstream hanya cap retryAfter yang sudah ditutup lapis-app).

Next action — sisa aktif (urut):
1. **SWE-Lite valid** — `bench/docker/` + `manifest.json` 20 instance + `--docker` MENDARAT; 5 image era TER-BUILD (py36 butuh fix apt kedaluwarsa); validasi: requests-1963 collect+run OK di py3.8, pytest-11143 FAIL dengan benar di py3.10. Sisa: run agen penuh + validasi confidence-low (requests/sympy).
2. **OAuth Copilot/ChatGPT** (P11 P2) — hanya `qwen` yang punya spec terdaftar; ChatGPT/Copilot TANPA spec (endpoint tak boleh dikarang). `auth login chatgpt` fail-fast non-TTY terverifikasi live. Login aplikasi ChatGPT Desktop tak bisa dipakai CLI (tanpa API publik; baca tokennya = pencurian kredensial). Butuh: device-flow interaktif oleh pemilik akun (`auth login qwen`), atau API key konvensional.
3. **Coverage 81/83** ✅ TERCAPAI (81,68/85,37; min dikunci 81/83) — via test config in-process + 3 temuan bug nyata (`--cwd` diabaikan list/add branches; flag-sebagai-id; list menulis repo saat test). Sisa per-file rendah di lsp/repl bukan kode baru.
4. **TOCTOU Linux CI** ✅ TERVALIDASI di WSL Ubuntu (swapper 1000× 0 lolos, 293ms) — temukan bug test: swapper tanpa yield menggantung selamanya (klaim lama tak pernah tervalidasi). Full suite Linux 1334/8/0; Windows (dev-mode + daemon) 1336/6/0. 5 fail platform-spesifik diperbaiki + `MINICODE_HOME` baru (global-DB hermetic di POSIX).

---

## Prinsip yang mengatur rencana ini

1. **Verifikasi perilaku, bukan bentuk kode.** Harness yang men-`grep` sumber jadi basi begitu kode diperbaiki — terbukti di ronde 3, di mana harness lama melapor 9 temuan yang sudah tidak ada. Tulis harness yang **menjalankan** kodenya.
2. **Buktikan dampak sebelum memperbaiki.** 5 dari 12 temuan ronde 1 tidak berdampak nyata dan sengaja tidak diperbaiki. Temuan tanpa bukti dampak adalah utang, bukan aset.
3. **Setiap perbaikan meninggalkan test yang gagal di commit sebelumnya.** Kalau test barumu lulus di kode lama, ia tidak menguji apa yang kamu kira.
4. **Jangan menambah permukaan baru sebelum yang ada teruji.** Tidak ada fitur baru di rencana ini kecuali yang sudah disetujui owner.

---

## P10 — Path to 9+: TOCTOU, `--cwd` repo-wide, SWE-bench Lite, flake TUI

Empat pekerjaan rumah terakhir sebelum skor 9+ bisa diklaim (audit 2026-09-06). Detail ada di bagian ini.

**P0 — Rilis blocker (minggu ini):** ✅ SELESAI 0.9.2, refinement 0.9.5.
- **P0.1 `--cwd` repo-wide:** ✅ `cli/router.ts` subArgv + subGetArg; `test/cli-subcommands.test.ts` assert artefak lokal.
- **P0.2 TOCTOU `O_NOFOLLOW`:** ✅ helper `src/lib/safe-open.ts` membuka path **terverifikasi** (`realpath`→cek→`open(preReal, O_NOFOLLOW)`): symlink internal tetap terbaca, swap jadi symlink gagal tutup (ELOOP). **POSIX-only** — Windows mengabaikan flag (pre-check saja); klaim "0 lolos" sah di POSIX. Test `test/tool-toctou.test.ts` (swapper 1000×, skip bila symlink EPERM → jalan penuh di Linux CI).

**P1 — Kepercayaan pengukuran (sprint depan):**
- **P1.1 Flake TUI:** ✅ `test/tui-harness.test.ts` 10/10 hijau beruntun (2026-09-06).
- **P1.2 SWE-bench Lite:** ✅ HARNESS + DATASET + RUN NYATA — `bench/swebench_lite_20.jsonl` 20 instance nyata terstratifikasi (12 repo, base_commit spot-check via GitHub API) + `bench/swebench.ts` apply `test_patch` dulu + flag `--api-key-env/--base-url/--model/--max-steps` (kunci di env, tanpa sentuh config) + diagnosa error per-instance. **Run nyata 2026-09-06: 0/20** (`nemotron-3.5-lightning-free`, 25 steps, `bench/swebench_results.json`) — TAPI angka ini **terkonfoundasi lingkungan**: reproduksi manual membuktikan (a) `pytest-11143` FAIL_TO_PASS lolos TANPA patch + PASS_TO_PASS gagal di base (Python 3.14 vs era 2022), (b) `requests-1963` collection error (`cgi` hilang di 3.13+). Tanpa Docker image per-instance ala SWE-bench resmi, skor tak comparable ke leaderboard. Butuh: `bench/docker/` + pin Python/pytest per era repo.

**P1 — Kepercayaan pengukuran (sprint depan):**
- **P1.1 Flake TUI:** `tui-harness.ts` sleep-based (`settleMs 15`, timeout 2000) + `send` fan-out ke stale listener → `waitForOutput` + `answerSequence` v2 + kirim ke listener raw-terbaru; kembalikan timeout ≤5000; 10/10 hijau + `test/tui-harness.test.ts` baru.
- **P1.2 SWE-bench Lite:** `bench/swebench.ts` baru (clone + checkout `base_commit`, prompt = problem_statement, verify = `FAIL_TO_PASS` via pytest, `PASS_TO_PASS` sampled); 20 instance terstratifikasi di-pin; angka resolve rate TERCETAK (berapa pun) sebelum boleh dikutip — PLAN P3.1 tetap berlaku.

**Selesai bila:** artefak `--cwd` selalu lokal, swapper 3×1000 iterasi 0 lolos, timeout manager ≤5000 + 10/10 hijau, angka SWE-Lite-20 dari run nyata, gate hijau.

## P11 — Provider Hardening: correctness, harga, Responses, retry

Audit 2026-09-06 menemukan provider skor terendah (7.5): shim Gemini drop `thought_signature` (400 diam-diam), harga Opus usang 3× (rusak `--budget`), tanpa Responses API dan `reasoning_effort`, 429 bakar-daftar provider, deteksi via substring URL, OAuth 1 provider belum terverifikasi, tanpa observabilitas, `max_tokens` 4096 sunyi. Detail ada di bagian ini.

**P0 — Kebenaran (minggu ini):**
- **P0.1 `thought_signature` pass-through:** teruskan `extra_content.google` dari delta tool_call → echo verbatim (seam aditif bila perlu). Test: tool loop Gemini thinking 3-turn hijau.
- **P0.2 Refresh harga:** koreksi Opus `$5/$25` + GPT-5.x/Claude 4.6/Gemini 3.x/DeepSeek V4; `pricing status` tampilkan umur cache + peringatan stale (tanpa auto-fetch).
- **P0.3 `max_tokens` 8192 + `length` eksplisit:** stop terpotong jadi peringatan, bukan teks sunyi.

**P1 — Daya saing (sprint depan):** ✅ SELESAI 0.9.5.
- **P1.1 Adapter Responses API** ✅ (`/v1/responses`, `previous_response_id` chaining per model, `store:false` default) + `providerHint: "responses"` + fake-SSE test.
- **P1.2 `reasoning_effort` generik** ✅ (`ProviderEntry`, `mapReasoningToThinking` → per-wire, test).
- **P1.3 Retry-after dihonori** ✅, tunggu (cap 30 dtk) lalu fallback; provider tunggal coba-ulang-di-tempat sekali; test (Prinsip 3: gagal di kode lama).
- **P1.4 Wire dari probe** ✅ (path `/responses` → hint `responses`; substring host hanya fallback) + test.

**P2 — Kematangan:** observabilitas ✅ (trace cost + memoryHits + provider efektif di header — warisan V7); routing policy eksplisit ⏳ (defer: router first-match + `::` override cukup); OAuth Copilot/ChatGPT ⏳ DEFER JUJUR: endpoint device-flow tak terverifikasi dari env ini — mengarangnya melanggar Prinsip 2.

**Selesai bila:** tool loop Gemini 3-turn hijau, Opus ≈⅓ biaya lama, `length` eksplisit, fake Responses SSE benar, 429 tunggu-di-tempat, gate hijau.

**Sengaja ditolak:** proxy universal ala LiteLLM — tiga adapter kecil yang jujur > satu proxy ajaib (postur zero-dep).

## P13 — Raise 3 Dimensi Tertinggal: Model 8.0→8.7, Tool 8.5→9.0, Sesi/Memori 8.5→9.0

Skor saat ini **8.2**. Target **P0 (≤3 hari): 8.4**, **P1 (sprint): 8.6**. Berbasis riset read-only 2026-09-06 (empat fact-sheet: inventaris 37 tools `src/tools/index.ts:59`, 14 preset `src/providers/presets.ts:14`, 6 mode `src/policy/permission.ts:8`, WAL+shadow-git+FTS5/MMR). **Keputusan pemilik dikunci:** P0 dulu; memori **opt-out** (`MINICODE_AUTO_MEMORY=0`); **sandbox tidak disentuh** (skor 8.0 dibiarkan — pemilik menolak kerja sandbox Windows/Linux). Tanpa TUI, tanpa proxy universal LiteLLM, tanpa edit `vendor/minicore/**` kecuali seam aditif.

**P0 — Semua yang menaikkan skor (≤3 hari, tanpa ubah UI/API):**

- **Model (8.0→8.7):**
  - **M0.1 `thought_signature` pass-through:** seam aditif `provider_meta?: unknown` di `vendor/minicore/src/core/tool.ts:22` (+ `VENDOR.md`, `bun run vendor:minicore`); teruskan `extra_content.google.thought_signature` dari delta `vendor/minicore/src/providers/openai-compat.ts:112` → `ToolCall._meta` → echo verbatim. *DoD:* fake SSE 3-turn Gemini thinking → turn-3 tidak 400.
  - **M0.2 Refresh `BUILTIN_PRICING`:** `src/policy/pricing.ts:30` Opus `$15/$75→$5/$25` + GPT-5.x/Claude 4.6/Gemini 3.x/DeepSeek V4; `cli/commands/pricing.ts:42` tampil `ageH` + `(stale)` >30d (tanpa auto-fetch).
  - **M0.3 `max_tokens` 4096→8192:** `src/providers/anthropic.ts:73` + warning `length` eksplisit di `src/ui/render/errors.ts` + `src/ui/assistant/simple.ts`.
- **Tool (8.5→9.0):**
  - **T0.1 `move_file` + `delete_file`** (delete soft ke `.trash/`; jail sama `write_file.ts:30`, atomic, `isSensitive`).
  - **T0.2 `read_image`** — reuse `estimateImageTokens` `src/policy/context.ts:15` → base64 `data:image/...` cap `BASH_OUTPUT_MAX_CHARS`.
  - **T0.3 Pisah `readonly` vs `plan` — DEFERRED:** ditolak, `plan` = `readonly` strict (test `plan mode: read-only` + `permission Fase 1` menuntut todo_write/delegate ditolak). Kembali hanya bila ada desain `write_plan` artifact + test baru.
  - **T0.4 `O_NOFOLLOW` safe-open** `src/lib/safe-open.ts` → `read_file`/`edit` (+ `patch`/`glob`/`grep` backlog P1); POSIX-only, Windows pre-check saja (paralel P10.2).
  - **T0.5 `code_run` tool** — sandboxed sama `bash`, bypass deny `INLINE_INTERPRETER` `bash-guard.ts:135` (hanya bila `MINICODE_SANDBOX=os|docker`).
- **Sesi & Memori — opt-out (8.5→9.0):**
  - **S1 Persist summary:** `src/policy/compaction.ts:187` → `addMemory(summary.slice(0,1200), {category:'summary'})`, guard `if (process.env.MINICODE_AUTO_MEMORY !== "0")`.
  - **S2 Kategori:** `src/memory/vector.ts:30` migration `category` (`fact|decision|preference|snippet|summary`) + `write_memory {category?, tags?}` (default `fact`); boost `score+=0.1` bila query match.
  - **S3 Scope `all`:** `vector.ts:431` `scope: 'cwd'|'global'|'all'` (merge dua DB, perbaiki silent shadowing `src/lib/db-path.ts:16`); default `cwd`.

**P1 — Sprint (8.4→8.6):** ✅ SELESAI 0.9.5.
- **Model:** ✅ adapter Responses API `src/providers/responses.ts` (chaining + test fake-SSE); `reasoningEffort` di `src/config.ts:29` + `mapReasoningToThinking` (test); honori `retry-after` + coba-ulang-di-tempat di `src/providers/router.ts` (test gagal-di-kode-lama); wire dari probe `src/providers/detect.ts` (test).
- **Tool:** ✅ `submit_result` (NO_PROMPT, `exec --json` verbatim); `ask_user` gated `permission.ts` + render via injeksi `promptAskText` `cli/setup.ts` (fail-closed, test).
- **Sesi/Memori:** ✅ plan artifact `.minicode/plans/<id>.md` (`src/tools/todo.ts`, test); auto-extract snippet dari turn verify sukses (`buildVerifySnippet` + `onOk`, opt-out sama, test); branch `branchSession` (`src/session/persistence.ts`, test); TTL hierarkis `fact/decision/preference 180, summary 90, snippet 14` + `accessCount` (test).

**Selesai bila (semua diukur):**
- Gate: `bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack` hijau; `MIN_LINES/MIN_FUNCS` di `scripts/coverage-gate.ts` = **80/84** (funcs sengaja tidak dinaikkan ke 81: hasil terukur berayun 80.62–81.84 antar run, mengunci 81 membuat gate flaky; tercapai 2026-09-09 `1357 pass / 81.84/84.26`).
- `test/tool-toctou.test.ts` swapper 1000 iterasi **0 lolos** di POSIX (skip bila symlink EPERM; Windows CI: 3 skip by design).
- `test/cli-subcommands.test.ts`: tiap subcommand `--cwd tmp` → artefak lokal, bukan repo/global. ✅
- `test/tui-harness.test.ts` 10× hijau. ✅ (2026-09-06)
- Gemini thinking 3-turn hijau ✅ (0.9.4); Opus ≈⅓ biaya lama ✅ (0.9.2); `length` eksplisit ✅; fake Responses SSE benar ✅ + chaining; 429 tunggu-di-tempat ✅.
- `memory status --json`: kategori + scope tampil ✅; summary persist opt-out ✅ (kecuali `MINICODE_AUTO_MEMORY=0`).
- SWE-Lite-20: dataset pin + harness benar + fake hijau + **run nyata 0/20 (terkonfoundasi env — lihat P1.2)** ✅; angka leaderboard-comparable ⏳ (butuh Docker per-instance).

## Yang sengaja TIDAK dikerjakan

Agar cakupan jelas dan tidak melebar diam-diam:

- **Tidak ada framework TUI baru.** Pure ANSI tetap. Ink/blessed akan membuang seluruh `fullscreen.ts` demi masalah yang perbaikannya berukuran satu fungsi.
- **Tidak ada mouse support.** Mouse tracking sudah dimatikan di V6 karena byte koordinatnya bocor ke input dan tidak ada konsumennya.
- **Tidak ada tema baru.** Empat preset sudah bekerja; menambah tema tanpa pengguna yang meminta adalah spekulasi.
- **Tidak ada virtual scroll transcript.** Output append-only ke scrollback terminal; layar interaktif (manager/wizard/picker) transient dan menghapus diri sendiri.
- **Repo-map tetap regex.** Alasan lengkap (dengan tabel pengukuran) ada di komentar `extractSymbolsAsync` di `src/repo/repomap.ts`. Tree-sitter menambah dua dependensi dan ~1,4 MB wasm per bahasa untuk simbol yang hampir seluruhnya member kelas — bukan yang berguna untuk orientasi.

---

## Cara bekerja di repo ini

**Sebelum mulai:** baca `AGENTS.md`, jalankan seluruh gate di bagian "Keadaan saat ini".

**Selama bekerja:**
- Ikuti gaya kode yang ada; jangan memperkenalkan pustaka baru.
- Bahasa komentar: Indonesia, menjelaskan **mengapa** bukan **apa**. Sertakan bukti (angka, nama berkas, perilaku terverifikasi) untuk keputusan non-obvious.
- Encoding: UTF-8 tanpa BOM. Repo ini pernah rusak karena pipeline PowerShell tanpa encoding eksplisit — `test/import-convention.test.ts` menjaganya, jalankan setelah mengedit berkas berisi karakter non-ASCII.
- Jangan mengedit `vendor/minicore/**` tanpa keputusan eksplisit (lihat P2.1).

**Sebelum menyatakan selesai:**
```bash
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```
Semua harus hijau. Bila coverage naik, naikkan juga angka minimum di `scripts/coverage-gate.ts` supaya tidak bisa mundur.

**Jangan commit** kecuali diminta. Bila diminta: periksa `git status` dan `git diff` lebih dulu, stage hanya berkas yang dimaksud, jangan pernah commit rahasia.
