# Control Plane Map — kontrak context/usage/cost/budget/compaction/termination

Dokumen ini membekukan kontrak control-plane MiniCode (Phase 6, 2026-09-17).
Tujuannya: satu sumber kebenaran per konsep, hubungan antar-konsep eksplisit,
dan setiap keputusan (kompaksi, abort, termination) dapat dijelaskan.

Prinsip: **Context ≠ Cost. Cost ≠ Usage. Usage ≠ Budget. Budget ≠ Termination.
Compaction ≠ Retry. Tool cap ≠ Context cap.** — semua konsep berbeda dan
punya owner sendiri; yang disatukan di sini hanya *hubungannya*.

## 1. Empat angka konteks (dua konsep, dua ukuran)

| Konsep | Ukuran | Owner | Sumber kebenaran | Dipakai |
|---|---|---|---|---|
| Logical context | token ESTIMASI (chars/4, sadar-gambar) | Kernel loop + `Session.contextTokens` | `estimateSessionContext` (`vendor tokens.ts`) — messages+system+tools | pressure evaluation, footer, `/status` |
| Serialized context | chars wire (JSON/base64 +overhead) | Adapter provider | `buildRequest` per adapter | dikirim, tidak diukur tersendiri |
| Provider usage | token yang dilaporkan provider | `createUsageCollector` | event `provider:extension{kind:"usage"}` — **boleh hilang** | akumulasi turn/session, cost |
| Economic usage | USD estimated dari harga tabel | `costFor`/`findPrice` | harga × usage; `undefined` = unknown | `--budget`, `/status` |

Relationship eksplisit:
- `logical` ≠ `serialized` (JSON overhead, base64 +33% — konsisten undercount).
- `provider usage` boleh tak ada → **unknown tetap unknown, bukan zero**
  (collector tidak pernah memalsukan angka).
- `economic` selalu estimasi (tabel harga basi/stale) — bukan tagihan riil.

## 2. Owner map (siapa tahu / siapa memutuskan)

| Konsep | TAHU | MEMUTUSKAN |
|---|---|---|
| Context size | Kernel loop (`contextTokens`) + `Session.contextTokens` getter (ekspos ke driver/UI) | Kernel: kompaksi + gagal-bila-critical |
| Compaction | Kernel (pressure + flag) | Kernel: KAPAN + fallback; LLM: ISI ringkasan |
| Termination | maxSteps/timeout (kernel), budget (driver), abort (user) | Kernel: maxSteps, timeout, post-kompaksi critical; Driver: budget abort; User: Ctrl+C/Esc |
| Budget | Collector (usage live) + `budgetStatus` | `budgetStatus` (terpusat, seragam REPL/one-shot/exec) + watcher abort |
| Backpressure | Producer caps + kernel truncate | Cap di producer (sudah benar); kernel truncate terakhir |

## 3. Compaction Contract (Phase 6 — seam kernel)

**Dua semantics terpisah, tidak lagi satu flag:**

- `compactedForBudget` — kompaksi budget-pressure (`shouldCompact(pressure)`).
  Set saat dicoba (anti berulang tiap step O(n)). Kritis setelahnya →
  `AgentError("budget_exceeded")` (bukan retry provider sia-sia).
- `compactedForRecovery` — kompaksi recovery (`force_compact_and_retry` /
  `onLength`). Set SETELAH compact (anti loop abadi: jalur ini tidak dihitung
  `maxProviderRetries`). Kedua kalinya → `budget_exceeded`.

**Reason event** (`context:compacted`, `reason` — nama generik kernel,
diselaraskan 0.9.27 saat seam dihilirkan; sebelumnya `budget:<…>`):
- `pressure:<pressure>` — kompaksi policy-path yang benar-benar mengurangi messages.
- `pressure:<pressure>:no-op` — kompaksi policy-path yang TIDAK mengurangi (tidak ada
  yang bisa dibuang dari messages — operator harus tahu bedanya dari fixed
  overhead: system+tool schema, yang tidak pernah terkompaksi).
- `recovery` — kompaksi dari recovery (`context_length_exceeded` / `length`).

**Contract wajib menjawab:**
- *Who requested?* — budget path (kernel, pressure ≥ 75%) atau recovery path
  (kernel, error konteks). Manual `/compact` tak menyentuh kernel (view saja).
- *Why?* — reason event di atas.
- *What is eligible?* — hanya messages; system prompt di-cap di hulu
  (`SYSTEM_PROMPT_MAX_CHARS` 8000), tool schema TIDAK pernah terkompaksi.
- *What must be preserved?* — pasangan assistant(toolCalls)→tool results tidak
  pernah dipecah (`compact.ts`); summary LLM terpin verbatim (anti-drift).
- *What may be removed?* — hasil tool sukses (ditinggal `<result omitted>` di
  mechanical; LLM menulis ringkasan fakta), reasoning, tail lama.
- *What if compaction fails?* — LLM gagal/timeout (10s) → fallback sync
  mekanis; async compactor tak pernah bisa crash loop.
- *Can it retry?* — budget: tidak (flag); recovery: sekali per turn (flag).
- *Can another occur in the same turn?* — budget + recovery boleh co-exist
  (flag terpisah); sesama kind tidak.
- *What does compaction itself consume?* — LLM kompaksi berbiaya; usage-nya
  ditangkap `compactWithLlm` → callback `onUsage` → bus sesi (event usage
  standar) — **bukan blind spot lagi** (Phase 6, E5).

## 4. Budget Contract

Status (`budgetStatus`, terpusat): `ok | over | unknown-strict`.

| Fase | Semantics |
|---|---|
| Preflight (prompt baru) | `tokens == 0` (belum ada pemakaian tercatat) → **start selalu boleh** (lockout strict tidak diminta — Phase 5 E-3c); `tokens > 0` + cost unknown → ditolak (fail-closed, F-06); cost known + over → ditolak |
| In-flight | `watchBudgetLimit` membaca biaya LIVE per usage event; fire-once → `ctl.abort(budgetExceededError())` — kind `budget_exceeded` dipertahankan (terbedakan dari abort user) |
| Post-usage | cost = estimated dari harga tabel (bukan tagihan riil); cost unknown → status `unknown-strict`, angka palsu tidak dibuat |

**Context vs budget adalah dua dimensi independen**: pressure HIGH + cost LOW
valid (tool result raksasa, model gratis); pressure LOW + cost HIGH valid
(konteks kecil, model mahal). Tidak ada asumsi `high context = high cost`.

## 5. Termination Contract

| Reason | Owner | Mekanisme |
|---|---|---|
| `completed` | kernel loop | tidak ada tool call → `finalText` |
| `max_steps_exceeded` | kernel loop | `stepIndex >= maxSteps` |
| `timeout` | kernel `createTimeout` | `AgentError("timeout")` — dipertahankan |
| `budget_exceeded` | kernel (post-kompaksi) / driver (watcher abort) | `AgentError("budget_exceeded")` — dipertahankan |
| `aborted` | user (Ctrl+C/Esc) / `session.abort()` | sinyal tanpa kind AgentError |
| `provider` | kernel loop | provider error setelah retry habis |
| busy | kernel | `run()` saat `running` |

Satu terminal reason per sinyal (`abortError` mempertahankan kind
`AgentError`); pemutus lain dapat REQUEST, tidak ada competing owners —
`joinSignals` + `withAbort` = satu titik settle.

## 6. Producer/Backpressure hierarchy

```
producer-side cap (bash 20k, git 500k, mcp 100k, read_file paging, ...)
  ↓
kernel truncate (toolResultMaxTokens 4096 tok = 16.384 chars, head 70%+tail 30%)
  ↓
context insertion (store append — cap by truncation di atas)
  ↓
compaction (messages; system/schema = fixed overhead, tidak pernah terkompaksi)
  ↓
termination (budget_exceeded bila critical setelah kompaksi)
```

Aturan: **jangan double-truncate tanpa semantics** — raw output cap ≠ context
insertion cap ≠ stored result cap ≠ display cap. Keempatnya boleh berbeda,
tetapi setiap lapisan harus tahu apa yang hilang di situ (marker truncation
wajib). Guard `read_image` memakai angka kernel (16.184 chars) — bukan angka
sendiri (bug E-1 sudah ditutup).

## 7. Observability contract

Operator harus bisa membedakan (tanpa ambigu):
- `/status`: `Context` (window estimate, kernel) vs `Input/Output/Total`
  (provider usage) vs `Cost` (estimated) vs `Budget` (status keputusan).
- Footer: angka = ukuran jendela saat ini (kernel) — bukan spend kumulatif.
- `context:compacted` event: reason membedakan policy-pressure/recovery/no-op.

## Proteksi (test → kontrak)

- `test/control-plane.test.ts` — compaction budget≠recovery (F-10), anti-loop,
  contextTokens getter + konsistensi estimator, termination reason.
- `test/cli-help-language.test.ts` — /status membedakan Context/Usage/Budget.
- `test/repl-linear.test.ts` — footer membaca kernel contextTokens.
- `test/usage-session.test.ts` / `budget-unknown.test.ts` — budget contract.
- `test/pack-integrity.test.ts` — vendor hash + VENDOR.md sinkron.
