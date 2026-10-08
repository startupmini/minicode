# PHASE P1 M0 — BASELINE FREEZE REPORT

Status: **BASELINE AMBER** (gates utama tercatat; 3 pre-existing failure terklasifikasi; full-suite timeout lingkungan).
Tanggal: 2026-10-01. Commit SHA: `9d79ebbb56f64f044e18e223cd2a88fa862a1827` (main, sinkron origin/main).
Environment: win32, Bun 1.4.2, repo `D:\recover\minicode-20260928\reconstruction`, package `minicode-ai@0.12.0`.
Untracked pre-existing (tidak disentuh): `docs/audit/FINAL-RECONSTRUCTION-CLOSURE.md`.

Aturan M0 dipatuhi: tanpa perubahan production behavior, tanpa feature, tanpa RuntimeHost/Kernel,
tanpa sentuh vendor/minicore/FSM/persistence/scheduler, tanpa cleanup/refactor. Satu-satunya file
baru adalah dokumen ini (baseline artifact). `DO NOT FIX` diterapkan pada semua temuan.

## 1. Repository inspection (source of truth)

* Package manager: **bun** (`engines.bun >=1.1.13`; `bun.lock` ada). Scripts di `package.json:58-91`.
* TypeScript: `typescript ^7.0.2`, `bun x tsc --noEmit` (script `typecheck`).
* Lint: `biome check src cli test bench scripts` (script `lint`).
* Test runner: `bun test` (246 file `test/*.test.ts`); coverage via `bun test --coverage` + gate agregat `scripts/coverage-gate.ts` (min 84 funcs / 85 lines + lantai per-berkas); pack via `scripts/pack-check.ts` (23 pemeriksaan).
* CLI entries: `cli/index.ts` (bin `minicode`), `cli/router.ts:3 dispatch`, `cli/setup.ts:511 createCliSession`, `cli/tui.ts:103 runTui`, `cli/commands/exec.ts:33 handleExec`, `cli/commands/acp.ts:511 handleAcp`.
* Modes: interaktif = TUI fullscreen alternate-screen selalu (`cli/index.ts:477-482`); non-interaktif = one-shot / `exec [--json]` / pipe; ACP = JSON-RPC stdio; subcommands = sessions/mcp/config/skills/providers/auth/pricing/memory/doctor/stats.
* Scheduler gate: default OFF (`resolveSchedulerGate`, `src/task/production-scheduler.ts:95`); thunk tidak dipanggil bila off.

## 2. Baseline quality gate (exact)

| Gate | Command | Exit | Hasil |
|---|---|---|---|
| typecheck | `bun x tsc --noEmit` | NONZERO | GAGAL pre-existing: ±24 error TS di file `test/phase3*`, `phase4*` (TS6133 unused, TS7006 implicit any, TS2353/TS2459/TS2769/TS2872). Contoh: `test/phase3a-identity.test.ts:284`, `phase4a4-production-sync.test.ts:442-444`, `phase4a4a-canonical-assignment.test.ts:100`. Nol error di `src/`/`cli/` produksi pada output terlihat. |
| lint | `bun run lint` | 1 | 424 errors (mayoritas `format`: CRLF `␍` vs LF — contoh `cli/commands/skills.ts`, `stats.ts`, `model-manager.ts`, `wizard.ts`, `scripts/build-web-css.ts`, `test/wizard.test.ts`) + 10 warnings + 21 infos; 463 files checked. Pre-existing. |
| full tests | `bun test --timeout 30000 --reporter dots` | TIMEOUT | Suite tidak selesai dalam 600.000 ms (246 file; suite historis ~259 dtk–4 mnt+ di Windows). Progres observasi: ratusan pass, satu `(fail)` terlihat di `test/pack-integrity.test.ts` (hash mismatch, lihat bawah). TIDAK ada kesimpulan pass/fail global — dicatat ENVIRONMENT TIMEOUT, bukan kegagalan kode. |
| subset runtime | `bun test test/journal.test.ts test/turn-marker.test.ts test/executor-abort.test.ts test/exit-codes.test.ts` | 0 | **38 pass / 0 fail** (154 expects, 10.60s). Bukti harness runtime inti hijau. |
| pack | `bun run gate:pack` | 1 | **21 pass / 2 fail** (pre-existing): (a) import-graph edge `src/task/graph.ts → model/graph-validate/readiness`; (b) ukuran unpacked 3308 KB > batas 2.25 MiB. |
| coverage gate | `bun run gate:coverage` | TIDAK DIJALANKAN | Membutuhkan full-suite `--coverage` (~4 mnt+) yang melebihi budget waktu M0; minimum tercatat dari `scripts/coverage-gate.ts:71-72` (84 funcs / 85 lines). Dijadwalkan ulang saat epoch stabil dengan runner terbagi. UNKNOWN terukur (bukan klaim). |

## 3. CLI behavior baseline (observable, tanpa perubahan)

* `--version` → `0.12.0`, exit 0. `--help` → usage interaktif/one-shot/exec/acp/pipe/sync + opsi (termasuk `--enable-scheduler` eksperimental, `--timeout` default 900000, `--budget*`, `--sandbox`, exit codes 0/1/2).
* Interaktif = TUI fullscreen; one-shot = shell-first append-only; `exec --json` envelope mesin; `acp` stdio subset (initialize/run/cancel/shutdown). Tidak ada mode linear REPL.
* Cancellation observable: TUI Esc = abort turn (double-tap = quit); budget mid-turn menggugurkan via `budgetExceededError`; timeout default 15 mnt per run; `--budget-strict` fail-closed.
* Shutdown observable: TUI SIGTERM/SIGHUP restore + exit 128+n; non-interaktif tanpa handler sinyal (default kill) + marker/jurnal sebagai durability; `close()` ordered + drain 200 ms one-shot.

## 4. Runtime baseline snapshot (current behavior, bukan target)

* Session: `createMinicodeSession` (`src/app/session.ts:48-186`) komposisi tipis di atas `createSession` kernel (`vendor/minicore/src/core/session.ts:163`); permission/executor/recovery/estimator diinjeksikan; `timeoutMs 0→Infinity`, sanitasi F-09.
* Context: `ContextStore` kernel + `estimateSessionContext` + compaction mekanikal/LLM + pressure evaluate.
* run()/turn/step/tool: `run()` = satu turn, busy-guard tanpa antre; loop provider→dispatch→append; `runCall` resolve→permission→validate→execute; tool gagal = observasi `isError`, bukan reject; `turn:completed` hanya sukses.
* Cancellation/timeout/budget: fan-in satu AbortSignal (`joinSignals`+`withAbort`+discard turnStore); timeout CLI 900s / kernel 600s / provider 300s / bash 30s; budget watcher mid-turn abort ber-kind.
* Persistence: `sessions.db` WAL 0600 (messages/turns/presentation_events, PK session+seq), `tasks.db` lokal, journal jsonl fsync + lock + nextSeq resume, checkpoints manifest + shadow-git refs, `turn.active.json` marker, traces/step-traces.
* Journal ordering: intent post-gate pre-execute → terminal post-execute → finalize pasca-persist; gagal = degraded-loud warn.
* Scheduler/task/child/background: TaskStore sole allocator `t<n>` + claim revision/generation + lease/incarnation; Scheduler headless DI bukan executor (gate off = inert); `delegate_task` pool-3 warisi sinyal + F-07 paksa explore; autonomous own-ctl readonly matrix; background bash max 8 + cursor-delta + killAll di close.

## 5. Metrics (diukur atau UNKNOWN jujur)

* Test files: 246. Subset runtime: 38/38 hijau (10.60s). Full suite: UNKNOWN (timeout 600s; historis PLAN.md: 2610 pass / 22 skip — tidak diklaim ulang tanpa run).
* Typecheck errors: ±24 (test-only, pre-existing). Lint: 424 errors + 10 warnings (pre-existing, mayoritas CRLF).
* Pack: 287 files, unpacked 3308 KB, 21/23.
* Startup latency / first-turn latency / per-turn overhead / memory / journal-write / shutdown latency: UNKNOWN (belum ada harness ukur reliable di M0; didefinisikan guardrails di plan, diukur mulai M2/M4).
* Package size: 3308 KB unpacked (di atas batas pack 2.25 MiB — pre-existing fail).

## 6. Baseline invariants (CURRENT BEHAVIOR vs TARGET)

* Cancellation: turn-scope kuat (A+B unconditional); tepi container best-effort (TARGET: deklarasi C/D per backend — BELUM).
* Terminal: `turn:completed` hanya sukses; gagal direkonstruksi driver (TARGET: kanon + commit-point tunggal — BELUM).
* Session identity: dual `sessionId/presentationSessionId` + fix PF-05 aktif (TARGET: korelator UUIDv4 — BELUM).
* Task identity: `t<n>` + revision vs generation terpisah di kode (TARGET: kontrak request formal — BELUM).
* Journal ordering: intent→terminal→finalize (TARGET: intent fail-closed gate + commit-vs-flush — BELUM).
* Scheduler authority: lease/incarnation + claim atomik (TARGET: bridge + intensity — BELUM).
* Child lifecycle: dua pola khusus, pairing single-pending (TARGET: satu spec + TTL — BELUM).
* Shutdown: TUI eksplisit, non-interaktif implisit, close tanpa flag idempoten (TARGET: idempoten+bounded 5 mode — BELUM).
* Tidak ada klaim current = target. Semua baris di atas: CURRENT RECORDED, TARGET PENDING.

## 7. Regression reference

```text
M0_BASELINE_SHA: 9d79ebbb56f64f044e18e223cd2a88fa862a1827
M0_TEST_SIGNATURE: full-suite TIMEOUT@600s (no global counts); subset journal+turn-marker+executor-abort+exit-codes = 38 pass / 0 fail (10.60s)
M0_COVERAGE_REFERENCE: NOT MEASURED (gate min 84/85 recorded; run dijadwalkan ulang)
M0_BEHAVIOR_REFERENCE: §3–§4 dokumen ini + CLI --version 0.12.0 exit 0 + pack 21/23
```

## 8. Failures / UNKNOWNs

* PRE-EXISTING FAILURES (tidak diperbaiki, DO NOT FIX): typecheck test-only (±24), lint format CRLF (424), pack 2 item (graph edge + size). Lokasi + repro di §2.
* ENVIRONMENT FAILURES: full-suite timeout 600s (Windows, Bun 1.4.2); coverage-gate tidak dijalankan (bergantung full suite).
* UNKNOWNs: full-suite counts, coverage terukur, latensi/overhead/memory (menunggu harness M2/M4); locator approval/toolCall yatim (U-B1 parsial — hanya memengaruhi M1, bukan M0).

## 9. Files changed / behavior changed

* Files changed: 1 (dokumen ini). Production behavior changed: NO. Test run meninggalkan nol artefak repo (git status bersih kecuali untracked pre-existing).
