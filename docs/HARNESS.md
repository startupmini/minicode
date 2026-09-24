# Harness Agent — Riset Fondasi & Acuan Minicode

Hasil riset mendalam 2026-09-06 (Harness-Engineering, Anthropic, OpenAI,
Fowler/Böckeler, Harness-Bench, studi source-code 11 harness
arXiv:2609.00006, ReAct/Toolformer). Dokumen hidup: perbarui bila temuan
baru mengubah keputusan di bawah.

## 1. Definisi

`Agent = Model + Harness`. Model menghasilkan teks; harness memutuskan apa
yang model lihat, apa yang boleh dilakukan, kapan berhenti, dan apa yang
terjadi saat gagal. Framework = blueprint/pustaka; harness = runtime yang
jalan di produksi. Dua tim bermodel identik bisa berbeda 40 poin completion
hanya karena harness.

Inti eksekusi = **loop ReAct** (`Thought → Action → Observation → …`)
sampai jawaban final atau batas tercapai. Terminasi harus berlapis:
tanpa tool-call, `maxSteps`, budget habis, guardrail tripwire, interupsi
user, safety refusal.

## 2. Model kontrol Fowler (guides × sensors)

| | Computational (CPU, deterministik, murah) | Inferential (GPU, probabilistik, mahal) |
|---|---|---|
| Guide (sebelum aksi) | permission filter, allowlist, schema validator | planning agent, AGENTS.md, Skills |
| Sensor (sesudah aksi) | test, compiler, typechecker, CI | self-reflection, evaluator/judge |

Aturan: yang bisa jadi aturan deterministik → computational; yang butuh
judgment → inferential. Tiga kategori regulasi: maintainability (termudah),
architecture fitness (fitness function), behaviour (belum terpecahkan —
jangan percaya buta pada test buatan AI). Operasi: steering loop (isu
berulang → perbaiki guide/sensor) + keep quality left (cek cepat
pra-commit, cek mahal pasca-integrasi).

## 3. Anatomi 7 subsistem (dari studi 11 harness)

Loop, integrasi LLM, tools, memori/konteks, safety/permission,
orkestrasi multi-agent, ekstensibilitas. Temuan keras:

- Kerumitan loop tidak memprediksi benchmark; scaffold ~90 baris sah.
- Tool scoping > tool count (Vercel: -80% tools = hasil naik).
- Harness produksi tidak memakai embedding retrieval (deterministik:
  ripgrep/tree-sitter/glob).
- Safety 4 lapis komposisional: policy deklaratif → hooks → reviewer LLM
  → OS sandbox; audit tiap lapis independen.
- Skills (`SKILL.md`) > MCP untuk adopsi lintas-harness.
- Batasan pindah dari prompt ke config terstruktur.

## 4. Long-running (Anthropic + OpenAI)

Anthropic: compaction saja tidak cukup. Initializer (sekali: `init.sh`,
`feature_list.json` `"passes": false`, progress file, commit awal) +
coding agent (tiap sesi: baca progress+git → pilih SATU fitur → smoke test
dulu → implement → verifikasi end-to-end → commit). JSON > Markdown.
Health-check awal iterasi wajib. Evolusi: split planner/generator/evaluator
(atasi self-praise bias).

OpenAI (1M LOC, 1500 PR): beri peta bukan manual — `AGENTS.md` ~100 baris
sebagai daftar isi; enforce invariant bukan micromanage (linter custom
yang pesannya berisi instruksi remediasi); garbage collection terjadwal;
pensiunkan scaffolding tiap model baru.

## 5. Bukti kuantitatif (Harness-Bench, 5194 trajektori)

Skor = `Security × Completion × Process`. Gap antar-harness 23,8 poin.
Lima gejala gagal: contract/format 36,4%, tool-tanpa-recovery 24,6%,
evidence/grounding 14,6%, artefak-tak-dicommit 11,1%, state 9,3%.
Yang membedakan = **execution alignment** (reasoning ↔ workspace ↔ aksi
tool ↔ kontrak evaluator tetap legibel).

## 6. Pola terbaik (ringkas)

Done machine-readable dulu; verifikasi computational tiap aksi +
inferential selektif; tool minimum per fase; state eksternal
path-addressable & compaction-stable; health-check awal; satu fitur per
sesi + clean-state commit; generator≠evaluator; budget/timeout berlapis +
fail-closed; observability per-step; GC debt kecil-kecil; mulai dari
harness tertipis yang lolos evaluasi.

## 7. Matriks kematangan

L1 demo (jalan, tanpa batas) → L2 terkendali (budget/abort/trace) →
L3 terverifikasi (sensor tiap aksi, evaluator terpisah) → L4 lintas-sesi
(progress+feature-list+git, resume tervalidasi) → L5 mengatur-diri
(GC, pensiun scaffolding, template per topologi).

## 8. Posisi minicode (2026-09-07)

> Kejujuran metodologi: tidak ada skor absolut di sini. Estimasi internal
> penulis ("~8.5") berasal dari judgement + 21 run toy n=1 — itu *arah*,
> bukan *fakta*. Jangan dikutip tanpa embel-embel ini. Yang terukur dan boleh
> dikutip: gate hijau, audit 60/60, bypass-rate 0, dan run live 20/21
> execution-verified (metodologi di §9).

Kuat L2–L3 di loop/state/safety-dasar. Mendarat:
- P0: jail simetris move/delete (`permission.ts`), strict sandbox
  (`bash.ts` + `MINICODE_SANDBOX_STRICT`), allowlist `bun run`/`bun x`,
  scrub `exec --json` + flag `overBudget`.
- P1.3: `budgetStatus` satu predikat (`usage.ts`) + `--budget-strict` /
  `MINICODE_BUDGET_STRICT` di one-shot/sesi interaktif/`exec` (`exec` sebelumnya
  mengabaikan `--budget` total — diperbaiki).
- P1.2: `step-traces.jsonl` per tool/step + klasifikasi deny + mode sandbox
  (`trace.ts`, wiring `cli/setup.ts`).
- P1.4: `bun run audit:harness` — 60 cek deterministik tanpa API key
  (safety 6-mode, guard bypass-rate, budget, scope read-only, fake-detector).
- P1.1: terverifikasi sudah ada (`--verify` + self-heal ≤3).
- P2.1: baseline-first — bila baseline merah sebelum agen jalan, catatan
  Health-Check ditempel ke prompt awal (perbaiki dulu).
- P2.2: `--tool-scope explore` / `MINICODE_TOOL_SCOPE` — sesi utama dibatasi
  subset read-only bersama sub-agen (`EXPLORE_TOOL_NAMES`).
- P3.1: `minicode stats` membaca `step-traces.jsonl` — deny-rate, top tool
  ditolak/gagal, mode sandbox (`summarizeStepTraces`).
- P3.2: validasi resume — workspace dibandingkan ke checkpoint terakhir
  (pembukuan `.minicode/` dikecualikan); divergen → peringatan + `/undo`.
- DITOLAK sadar: verify default-on (biaya/latensi semua run + memecahkan
  test existing), evaluator inferential terpisah (butuh LLM call per run).
- `bench/docker/` MENDARAT + TERVALIDASI SEBAGIAN (2026-09-08, daemon
  Docker Desktop ditemukan + Ubuntu diregistrasi di WSL): 5 image era
  ter-build (py36 butuh fix apt kedaluwarsa); requests-1963 collect+run OK
  di py3.8; pytest-11143 FAIL dengan benar di py3.10. Sisa: run agen penuh.
- Run POSIX pertama (WSL Ubuntu): TOCTOU 1000× 0 lolos (293ms) + full
  suite 1334/8/0. Temuan: (a) swapper tanpa yield menggantung selamanya —
  klaim lama tak pernah tervalidasi; (b) 5 fail platform-spesifik diperbaiki
  (`node -e` → runtime sendiri; stripAnsi; mount-test cabang platform;
  `MINICODE_HOME` agar global-DB hermetic di POSIX; TOCTOU yield);
  (c) polusi `/root/.minicode` oleh test dibersihkan.

## 9. Uji live 7 model (2026-09-07, gateway OpenAI-compat)

Metodologi: 3 task bench × 7 model gratis, `maxSteps` 12, 2 task dengan
execution-check (import + panggil fungsi) + 1 regex-only, n=1 per sel.
Hasil ketat: 5 model 3/3 (gpt-5.6-luna paling efisien ~16k tok; muse-spark
seimbang; gemini benar semua tapi 0 token tercatat + paling lambat;
deepseek-flash boros token; glm lambat), qwen 2/3 (contract-miss:
regex lolos tapi `greet()` tak bisa di-import — pelajaran: regex saja
menipu), deepseek-pro 2/3 ketat / 3/3 longgar (file benar, jebol cap
12 steps — artefak batas, bukan kapabilitas). Stabilitas harness 21/21
tanpa crash/hang/escape. Batasan jujur: n=1 (noise sampling), task mudah
(tak membedakan model kuat), Windows-only. Pengulangan yang berarti:
n≥3 + task multi-file + Linux CI.

Uji live 2 (2026-09-07, task multi-file-refactor + execution-check):
ketat 4/7 — luna (4 steps, 23k tok, 51 dtk, terbaik), glm (5 steps, 27k,
34 dtk, tercepat), muse-spark (11 steps, 68k, verbose tapi benar),
deepseek-flash (6 steps, 32k, 91 dtk). Konten-benar-tapi-gagal-aturan 2/7:
pro-0813 (file benar, jebol timeout 180 dtk — provider lambat), qwen
(file benar, jebol 15 steps — pola boros langkah berulang). Gagal nyata
1/7: gemini menjawab final dalam 851ms TANPA tool call (0 steps) —
kegagalan agentic murni, bukan kapabilitas. Task sulit MAMPU membedakan;
skor run-1 perlu n≥3 sebelum dikutip sebagai peringkat.
