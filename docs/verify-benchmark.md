# Verify & Benchmark

## Auto-verify & self-heal

`--verify` auto-detect perintah (`typecheck` → `test` → `tsconfig`) atau `MINICODE_VERIFY_CMD` / `verifyCommand` di config.

Alur: baseline diuji dulu (bila merah, Health-Check ditempel ke prompt awal) → run utama → verify → bila gagal, agen perbaiki (maks 3 siklus). Output error dibungkus fence agar tidak jadi prompt injection.

Checkpoint shadow-git: snapshot per turn sebagai SHA tree (O(delta), tanpa cap file, `HEAD`/index tak tersentuh, ref menunjuk *tree* sehingga tak muncul di `git log`). `.gitignore` dihormati. Non-repo fallback snapshot file.

Repo-map: simbol per file (regex, 9 bahasa) di-cache `.minicode/repomap.json`, disuntik ke system prompt. Tree-sitter tidak dipakai — alasan terukur di `extractSymbolsAsync` (`src/repo/repomap.ts`).

Secret scrubber meredaksi `sk-`, `ghp_`, `AKIA`, PEM, JWT, Bearer, `api_key=...` sebelum ke LLM.

## Benchmark

```bash
bun run bench                            # butuh provider (resolve rate nyata)
bun run bench:smoke                      # --fake, untuk CI
bun run bench --tasks path/to/tasks.json # external tasks (SWE-bench-format)
bun run audit:harness                    # 60 cek deterministik, tanpa API key
bun run bench --runs 2                   # median 2 runs
bun bench/runner.ts --fake --memory off  # tanpa RAG/auto-memory
bun bench/runner.ts --fake --memory on   # dengan RAG + seed memory
bun bench/runner.ts --provider vyceai-com --model 'vyceai-com::deepseek-v4-flash' --max-steps 6 --timeout 90000  # live berbiaya: pin provider+model+rem
bun bench/runner.ts --judge-model 'vyceai-com::deepseek-v4-flash-lr'  # nilai penjelasan (model HARUS beda dari aktor)
bun run gate:eval                        # kunci ambang baterai (min resolve-rate, max median token)
bun run gate:eval --results bench/live.json --min-rate 0.8 --max-median-tokens 8000 --allow-partial
bun bench/eval-gate.ts --results bench/results.json --min-rate 1 --max-median-tokens 5000 --observe-tokens  # observasi: token tak menggagalkan (2–3 run pertama sebelum ambang dikunci)
```

CI menjalankan `test/eval-gate.test.ts` untuk menguji evaluator secara
deterministik tanpa provider, lalu menjalankan CLI `gate:eval` terhadap output
`bench:smoke` dan memastikan hasil palsu ditolak. `bench:smoke` hanya menguji
wiring harness; hanya hasil yang secara eksplisit berlabel `fake: false` dapat
dinilai, sehingga hasil fake atau artefak lama tanpa asal provider dinyatakan
bukan bukti kualitas. Evaluasi
kualitas live tetap harus memakai hasil provider nyata yang tersimpan, serta
anggaran/provider yang dipilih operator. CI PR dan publish tidak menjalankan
provider berbayar atau memakai rahasia model; evaluasi live tetap manual karena
hasil, model, dan anggaran harus dipilih operator secara eksplisit.

Skor deterministik menggunakan total langkah aktual seluruh run dibanding
total batas langkah yang disediakan. Nilai ini berasal dari `usage.steps` saat
run selesai, atau event `step:started` jika run berakhir dengan error; batas
konfigurasi tidak lagi dipakai sebagai pengganti langkah aktual.

Metrik: resolve rate, steps, token, cost, durasi, memoryHits + delta vs run sebelumnya. Hasil `bench/results.json` (`--out` untuk path lain). Tiap run gagal membawa kelas (`VERIFY_FAIL`/`MAX_STEPS`/`NO_PROGRESS`/`ABORT`) + distribusi global di akhir run; kartu metodologi + log observasi di `bench/HARNESS-CARD.md`.

Setiap run memakai `MINICODE_HOME` hermetic sendiri (DB/memory/sesi global tak bocor antar run dan tak menyentuh `~/.minicode` operator). Task boleh membawa `seedMemory`: fakta yang di-seed ke memory run itu — task `follow-convention` hanya lolos bila agen membaca fakta tersebut, sehingga `bun bench/runner.ts --memory on` vs `--memory off` mengukur nilai memory secara diferensial (bukan klaim).

Format `tasks.json`:

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

SWE-bench Lite: `bench/swebench.ts` + `bench/swebench_lite_20.jsonl` (20 instance nyata, 12 repo, base_commit spot-check) + `bench/docker/` (5 image Python 3.6–3.10 + `manifest.json` + `--docker`). Harness apply `test_patch` dulu (tanpanya skor fiksi). Run nyata tercatat 0/20 (`nemotron-3.5-lightning-free`, 25 steps) dengan catatan validitas lingkungan (Python 3.14 vs era 2022) — skor comparable butuh Docker per-instance.

Eksperimen adversarial (terpisah dari gate default):

```bash
bun run extreme:fuzz        # fuzz bash-guard (--seed N reproduksi)
bun run extreme:git         # stress shadow-git (--files N --sessions N)
bun run extreme:mcp         # server MCP jahat (hang, flood, redirect, SSRF)
bun experiments/bash-bypass-probe.ts  # postur denylist (0 bypass = lulus)
```
