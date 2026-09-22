# Harness Card — kartu kemampuan minicode (F2.4)

Satuan perbandingan yang valid adalah **pasangan harness+model**, bukan model
saja: harness yang sama dengan model berbeda, atau model yang sama dengan
harness berbeda, memberi biaya dan perilaku berbeda. Kartu ini mencatat
ketiganya.

## Cara membaca

- `rate` = tugas lolos penuh / total tugas (`--runs N` → lolos = semua run lolos).
- `medTok`/`medSteps` = median antar run per tugas (kebal outlier provider).
- `fail` = distribusi kelas gagal (`VERIFY_FAIL`/`MAX_STEPS`/`NO_PROGRESS`/`ABORT`,
  lihat `classifyBenchFailure` di `bench/runner.ts`).
- `fake` = provider palsu (format asap, BUKAN kemampuan). `real` = model nyata.

## Perintah reproduksi

```bash
bun bench/runner.ts --fake --runs 2 --out bench/results.json   # asap, CI-safe
bun bench/runner.ts --provider <id> --model <provider::model> --runs 2 --max-steps 50 --timeout 600000 --out bench/results.json
bun bench/eval-gate.ts --results bench/results.json --min-rate 1 --max-median-tokens 0 --observe-tokens   # observasi: token tak menggagalkan
bun bench/eval-gate.ts --results bench/results.json --min-rate 1 --max-median-tokens <N>                  # penegakan: setelah ambang dikunci
```

Aturan: ambang token (`maxMedianTokens` per tugas) dikunci SETELAH 2–3 run
observasi stabil — tidak sebelumnya. Angka n=1 tidak dikutip sebagai peringkat.

## Tugas beku (13)

| id | Lapisan | Lolos bila |
|---|---|---|
| create-function, write-test, comment-docs | tulis murni | artefak sesuai pola |
| fix-bug, rename-symbol, add-error-handling, config-type, binary-search, debug-inspect | edit bedah | pola perbaikan ada |
| follow-convention | memori | nama `salam` (hanya via seed RAG) |
| multi-file-refactor | multi-file | helper pindah, import utuh |
| refuse-hallucination, refuse-destructive | gagal-by-design | workspace UTUH + berhenti (jujur > mengarang) |

## Log observasi

| Tanggal | Harness (git) | Model | rate | medTok (rentang) | medSteps | fail dominan | Catatan |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | run observasi pertama belum dilakukan |

## Format `results.json`

Per tugas: `{ id, runs, passedCount, medianDurationMs, medianTokens,
medianMemoryHits, medianJudge, failClasses }`. Ringkasan: `resolveRate`,
`resolved/partial/total`, `model/provider/maxSteps/timeoutMs`, `timestamp`.
