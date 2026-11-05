# P0 Foundation Hardening Report — MiniCode (2026-11-04)

**Sesi:** SESSION 1 — P0 Foundation Hardening (`P0.1` Baseline Integrity & Provenance + `P0.2` WorkMode Contract)
**Tanggal:** 2026-11-04 (WIB / UTC+7)
**Repository root:** `D:/Github/minicode`
**Branch:** `main` (`ahead 1` dari `origin/main`) · **Package version:** `0.13.1` (`git describe`: `v0.13.1-1-gcb60212`)
**Commit HEAD:** `cb602124571d8e4638bdb47d38400c52d8fba976` (parent: `57c59d363b3f7bafca07c050992f6ffccb227463` = `origin/main` = tag `v0.13.1`)
**Platform verifikasi:** Windows x64 (`Microsoft Windows NT 10.0.26340.0` / `win32`) · Bun `1.4.3` (`c6da4a4d3`)

> **Peringatan ruang lingkup klaim (wajib dibaca).**
> Seluruh klaim verifikasi di laporan ini bersifat **stage-scoped pada P0 (`P0.1` + `P0.2`)** di atas kandidat `HEAD=cb60212` + working tree tidak bersih yang terinventarisasi penuh di §2. Laporan ini **tidak** mengklaim seluruh repository hijau, **tidak** mengklaim P1/P2 selesai, **tidak** mengklaim *release-readiness*, dan **tidak** mengklaim perubahan telah di-*commit*. Sesuai aturan keselamatan sesi, full `bun test`, `bun run gate:coverage`, `bun run gate:pack`, dan live-provider UAT **tidak dijalankan** (membutuhkan otorisasi terpisah dari pemilik proyek).

---

## 1. Executive Verdict

| Sub-misi | Status | Ringkasan Bukti |
|---|---|---|
| **P0.1 — Baseline Integrity & Provenance** | **COMPLETE (VERIFIED)** | `57c59d3` (`v0.13.1`, `origin/main`) dan `cb60212` (`HEAD`, tepat `7` berkas, `+105/-6`) terverifikasi beserta rantai *ancestry*-nya. Seluruh `108` entri *working tree* awal (`0` staged, `64` tracked modified `+3360/-443`, `44` untracked) dipetakan *provenance*-nya tanpa kehilangan satu pun perubahan pengguna. Enam ketidaksinkronan angka/klaim pada laporan audit terdahulu direkonsiliasi secara matematis dari output Git aktual (§3). |
| **P0.2 — WorkMode Contract (`DISCUSS`, `PLAN`, `EXECUTE`)** | **COMPLETE (STAGE-SCOPED VERIFIED)** | Seluruh keputusan pemilik (`Q1=A1`, `Q2=A2`, `Q3=A3`, `Q4=A4`, `Q5=A5`, `Q6=A6`) telah disepakati secara eksplisit dan ditegakkan di kode produksi tanpa membuat `WorkMode` keempat dan tanpa menyentuh `vendor/minicore/**`. Invarian kontrak #1 s.d. #8 serta penutupan celah `G1`, `G5`, `G-PROMPT-RT`, `G-MEM-TRACK`, dan paritas `daemon`/`ACP`/`exec`/`resume`/`sub-agent` dibuktikan oleh `bun x tsc --noEmit` (exit `0`), `bun run lint` (exit `0`, 657 berkas), `bun run vendor:check` (exit `0`), dan `14` suite test terarah (`224 pass / 0 fail`, `2.104` `expect()`, exit `0`). |
| **Status Keseluruhan P0** | **COMPLETE — AWAITING OWNER CHECKPOINT DECISION** | Kontrak, implementasi, provenance, dan bukti test terarah P0 tuntas. Working tree sengaja dibiarkan **uncommitted** (`0` staged) sesuai aturan keselamatan sesi sampai pemilik memilih strategi *checkpoint* (§2.6) dan memberi otorisasi *cleanup* artefak sementara (§8). |

---

## 2. Candidate Snapshot dan Provenance (`P0.1`)

### 2.1 Identitas Repository, Commit Baseline, dan Ancestry

- **Repository root:** `D:/Github/minicode` (satu-satunya Git worktree aktif; `git stash list` = `0`).
- **Proses aktif saat audit dimulai:** tidak ada proses `bun`, `minicode`, atau test runner aktif; hanya 2 proses background sistem `node.exe` milik `9router` (`PID 2392`, `PID 23996`) di luar workspace.
- **Verifikasi `57c59d3` (audit baseline):**
  - Full SHA: `57c59d363b3f7bafca07c050992f6ffccb227463` (`2026-11-01 20:13:59 +0700`)
  - Ref: `tag: v0.13.1`, `origin/main`, `origin/HEAD`
  - Subject: `fix(packaging): add JS bin wrapper and drop ./ prefix so npm keeps the minicode command (0.13.1)`
- **Verifikasi `cb60212` (UAT fix baseline):**
  - Status: **masih menjadi `HEAD` aktif** pada branch `main` (`ahead 1` dari `origin/main`), parent tunggal = `57c59d363b3f7bafca07c050992f6ffccb227463`.
  - Full SHA: `cb602124571d8e4638bdb47d38400c52d8fba976` (`2026-11-02 00:08:56 +0700`)
  - Isi commit (`git diff --numstat 57c59d3 cb60212`): **tepat `7` berkas, `+105` insertions, `-6` deletions**:
    1. `cli/commands/exec.ts` (`+49 / -0`)
    2. `docs/environment.md` (`+1 / -0`)
    3. `src/policy/context.ts` (`+20 / -1`)
    4. `src/tools/todo.ts` (`+14 / -4`)
    5. `src/ui/render/errors.ts` (`+8 / -0`)
    6. `test/errors-usage.test.ts` (`+6 / -0`)
    7. `test/writer-inventory.test.ts` (`+7 / -1`)
- **Rantai ancestry terverifikasi (`git merge-base --is-ancestor` = `True` untuk seluruhnya):**
  `2d9e11e` (2026-10-21) → `677d77d` (2026-10-26, P12/P13/P14 integration) → `54715d6` (2026-10-26, frontier harness baseline) → `1cd3a92` (2026-11-01, `tag: v0.13.0`) → `57c59d3` (2026-11-01, `tag: v0.13.1`, `origin/main`) → `cb60212` (2026-11-02, `HEAD -> main`).

### 2.2 Reproduksi Sidik Jari Snapshot Audit Awal & Akhir

Formula deterministik sidik jari sesi ini menghitung SHA-256 atas:
1. `HEAD` commit SHA,
2. `STATUS_UALL_SHA256`: teks `git status --porcelain=v1 -uall` (`\n`-joined),
3. `STAGED_DIFF_SHA256`: byte mentah `git diff --cached --binary`,
4. `UNSTAGED_DIFF_SHA256`: byte mentah `git diff --binary`,
5. `UNTRACKED_SHA256`: daftar terurut `<sha256_isi_berkas>  <path>` untuk seluruh `git ls-files --others --exclude-standard`,
6. `COMPOSITE_SHA256`: SHA-256 atas gabungan kelima komponen di atas.

| Komponen Sidik Jari | Kondisi Awal Sesi (`t0` — pra-edit) | Kandidat Teruji (`t1` — saat gate test P0.2 lulus, pra-laporan) | Kondisi Akhir Sesi (`t2` — pasca-penulisan laporan ini) |
|---|---|---|---|
| `HEAD` | `cb602124571d8e4638bdb47d38400c52d8fba976` | `cb602124571d8e4638bdb47d38400c52d8fba976` | `cb602124571d8e4638bdb47d38400c52d8fba976` |
| Staged count | `0` | `0` | `0` |
| Tracked modified count | `64` (`+3360 / -443`) | `76` (`50` pra-sesi utuh + `14` pra-sesi diperluas + `12` baru P0.2) | `76` (identik dengan `t1`) |
| Untracked file count | `44` | `44` (`43` pra-sesi byte-identik + `1` test P0.2 diperluas) | `45` (`t1` + `1` laporan baru ini) |
| `STATUS_UALL_SHA256` | `ebf5559e9e3d3da7fa4675fafc221b98959f3257804da9dd6658b8feef3b967f` | `550212ba2a19a97c2c16840380fcf086d44cbf831e3f34934d6ca4650b24dc66` | *(diverifikasi pasca-tulis; `UNSTAGED_DIFF_SHA256` wajib tetap = `t1`)* |
| `STAGED_DIFF_SHA256` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `UNSTAGED_DIFF_SHA256` | `4a422f1da343d67262c1c049f797844602a33873912b36bc6ad1bef874f7ca79` | `7a657379affc6f9da576db3a82ff856ac46cc36d3eacb6cdf3a4a7698fd46eef` | `7a657379affc6f9da576db3a82ff856ac46cc36d3eacb6cdf3a4a7698fd46eef` |
| `UNTRACKED_SHA256` | `6ebfa859b8376fc8a48fa5cbee15faa8df10700ae97297fb26bf8485ee716023` | `0f282104e43e13bc209f17ef3a9eb8b16a2374f29dd7ed129bfa205cf8910e88` | *(berubah semata karena penambahan berkas laporan ini)* |
| `COMPOSITE_SHA256` | `3f02373370353a2885ef9b1c06c837c9fe15a05a5540c2183f53d392fda40978` | `141c81e23f292455c660d82ca228d4a81dcd082d5e157ba744a23274659374de` | *(dicatat pada pengantar penyerahan ke pemilik)* |

**Reproduksi lintas-laporan terhadap `docs/audit/P0_P2_BASELINE_REASSESSMENT_2026-11-04.md` baris 6:**
- Pada `t0`, `git --no-optional-locks diff | git hash-object --no-filters --stdin` (LF murni) menghasilkan **`0d0a98b8ecac1dabc60f78136850cce0ff055103`**, cocok **100% bit-for-bit** dengan `diff_hash=0d0a98b8ecac1dabc60f78136850cce0ff055103` di laporan `P0_P2_BASELINE_REASSESSMENT_2026-11-04.md`! (Catatan teknis Windows: menjalankan `cmd /c git diff | git hash-object --stdin` tanpa `--no-filters` menghasilkan `5644ac70601f272f0aaf569b225abad464503341` karena filter `autocrlf` pada `stdin`; keduanya merujuk ke *diff* `t0` yang sama).
- Demikian pula `git status --porcelain=v2` pada `t0` setelah mengecualikan baris `P0_P2_BASELINE_REASSESSMENT_2026-11-04.md` menghasilkan SHA-256 `6649963db92b1eeb141490b3dead5cbf4192878bcab5f134e7076fae5c9b8339`, membuktikan bahwa **tidak ada satu byte pun yang berubah di antara berakhirnya audit `P0_P2_BASELINE_REASSESSMENT_2026-11-04.md` dan dimulainya Sesi 1 ini (`t0`)**.

---

### 2.3 Manifest Provenance Seluruh Perubahan Tracked (`64` Pra-Sesi + `12` Baru P0.2 = `76` Berkas)

Keterangan kolom **Gelombang Provenance**:
- **`W-PRE-P0` (PROMPT 02)**: Konsolidasi awal WorkMode CLI/prompt/resume (`P0_BASELINE_AND_MODE_ARCHITECTURE_CONSOLIDATION.md`, 2026-11-02).
- **`W-PRE-P1A` (PROMPT 03–05)**: Observabilitas presentasi, reasoning/thinking, collapse/detail, occupancy vs spend, i18n, footer (`P1_*_REPORT.md`, 2026-11-02 s.d. 2026-11-03).
- **`W-PRE-P1B` (PROMPT 06 / Final Integration)**: Approval binding (`argsHash` + `invocationId`), isolasi state TUI per-instans, rekonsiliasi memori & supersession, fase stream daemon `replay→live`, perluasan glob CI (`FINAL_INTEGRATION_RELIABILITY_CLOSURE_REPORT.md`, 2026-11-03 s.d. 2026-11-04).
- **`W-S1-P0.2` (Sesi 1 ini — diotorisasi pemilik `A1`–`A6`)**: Penegakan kontrak final WorkMode `DISCUSS`/`PLAN`/`EXECUTE`.

#### A. Berkas Tracked Pra-Sesi yang TIDAK Disentuh Sesi 1 (`50` berkas — byte-identik dengan `t0`)

| # | Path | Numstat (`t0` = `t1`) | Kategori | Gelombang Provenance |
|---:|---|---:|---|---|
| 1 | `.github/workflows/ci.yml` | `+7 / -2` | CI / Infra | `W-PRE-P1B` (ekspansi glob test Windows/Linux) |
| 2 | `cli/args.ts` | `+50 / -2` | Source (`cli`) | `W-PRE-P0` (`--work-mode`, `resolveWorkModeFlag`, boundary helper) |
| 3 | `cli/commands/memory.ts` | `+43 / -13` | Source (`cli`) | `W-PRE-P1B` (konsistensi `memory rm` vector + `MEMORY.md`) |
| 4 | `docs/cli.md` | `+1 / -0` | Dokumentasi | `W-PRE-P0` (dokumentasi `--work-mode`) |
| 5 | `docs/memory-sessions.md` | `+5 / -0` | Dokumentasi | `W-PRE-P0` / `W-PRE-P1B` (catatan sesi & memori) |
| 6 | `src/daemon/approvals.ts` | `+25 / -1` | Source (`daemon`) | `W-PRE-P1B` (approval binding di broker daemon) |
| 7 | `src/daemon/client.ts` | `+51 / -1` | Source (`daemon`) | `W-PRE-P1B` (`phaseOf()` & pelacakan fase replay→live) |
| 8 | `src/daemon/protocol.ts` | `+47 / -1` | Source (`daemon`) | `W-PRE-P1B` (kontrak `tail_marker.phase` & approval payload) |
| 9 | `src/daemon/server.ts` | `+11 / -1` | Source (`daemon`) | `W-PRE-P1B` (emisi fase `tail_marker`) |
| 10 | `src/daemon/subscription.ts` | `+25 / -1` | Source (`daemon`) | `W-PRE-P1B` (latch transisi `replay` → `live` per consumer) |
| 11 | `src/memory/files.ts` | `+69 / -3` | Source (`memory`) | `W-PRE-P1B` (sinkronisasi hapus/rekonsiliasi `MEMORY.md`) |
| 12 | `src/memory/vector.ts` | `+353 / -132` | Source (`memory`) | `W-PRE-P1B` (supersession dua arah, rekonsiliasi store, pencarian) |
| 13 | `src/presentation/adapter.ts` | `+152 / -7` | Source (`presentation`) | `W-PRE-P1A` (observabilitas tool/turn/occupancy/reasoning) |
| 14 | `src/presentation/events.ts` | `+159 / -1` | Source (`presentation`) | `W-PRE-P1A` (skema event presentasi & durabilitas) |
| 15 | `src/presentation/model.ts` | `+37 / -0` | Source (`presentation`) | `W-PRE-P1A` (model state presentasi) |
| 16 | `src/presentation/projection.ts` | `+83 / -1` | Source (`presentation`) | `W-PRE-P1A` (proyeksi linear/TUI/machine envelope) |
| 17 | `src/presentation/reducer.ts` | `+82 / -0` | Source (`presentation`) | `W-PRE-P1A` (reducer state presentasi) |
| 18 | `src/tools/task.ts` | `+7 / -1` | Source (`tools`) | `W-PRE-P0` (`setSubAgentWorkMode` / `subAgentWorkMode`) |
| 19 | `src/ui/approval/prompt.ts` | `+34 / -1` | Source (`ui`) | `W-PRE-P1B` (konteks preview/hash pada dialog approval TUI) |
| 20 | `src/ui/assistant/simple.ts` | `+118 / -57` | Source (`ui`) | `W-PRE-P1A` + `W-PRE-P1B` (rendering linear & isolasi `SessionUiState`) |
| 21 | `src/ui/contract.ts` | `+39 / -0` | Source (`ui`) | `W-PRE-P1A` (tipe kontrak presentasi UI) |
| 22 | `src/ui/footer.ts` | `+14 / -5` | Source (`ui`) | `W-PRE-P1A` (pemisahan occupancy konteks vs spend sesi + label mode) |
| 23 | `src/ui/i18n/en.ts` | `+7 / -0` | Source (`ui`) | `W-PRE-P1A` (string lokalisasi EN) |
| 24 | `src/ui/i18n/id.ts` | `+7 / -0` | Source (`ui`) | `W-PRE-P1A` (string lokalisasi ID) |
| 25 | `src/ui/render/collapse.ts` | `+24 / -52` | Source (`ui`) | `W-PRE-P1A` + `W-PRE-P1B` (delegasi collapse state ke `session-state.ts`) |
| 26 | `src/ui/render/detail.ts` | `+14 / -9` | Source (`ui`) | `W-PRE-P1A` (rendering detail tool/argumen) |
| 27 | `src/ui/render/reasoning.ts` | `+13 / -8` | Source (`ui`) | `W-PRE-P1A` + `W-PRE-P1B` (isolasi state reasoning per sesi) |
| 28 | `src/ui/tui/app.ts` | `+7 / -3` | Source (`ui`) | `W-PRE-P1B` (injeksi `SessionUiState` ke `TuiApp`) |
| 29 | `src/ui/tui/transcript.ts` | `+116 / -14` | Source (`ui`) | `W-PRE-P1A` (expand/minimize transcript & blok tool) |
| 30 | `test/approval-tui.test.ts` | `+25 / -0` | Test | `W-PRE-P1B` (uji approval TUI & sink) |
| 31 | `test/cli-args.test.ts` | `+37 / -1` | Test | `W-PRE-P0` (uji `flagsAfterPromptBoundary` & `--work-mode`) |
| 32 | `test/cli-session.test.ts` | `+60 / -0` | Test | `W-PRE-P1A` (uji sesi CLI) |
| 33 | `test/collapse.test.ts` | `+6 / -6` | Test | `W-PRE-P1B` (uji collapse per-sesi) |
| 34 | `test/coverage-gaps.test.ts` | `+15 / -0` | Test | `W-PRE-P1B` (penutup celah cakupan) |
| 35 | `test/hardening-boundary.test.ts` | `+30 / -5` | Test | `W-PRE-P1B` (uji batas hardening) |
| 36 | `test/helpers/tui-harness.ts` | `+14 / -4` | Test helper | `W-PRE-P1A` (helper fake TTY) |
| 37 | `test/p15-phase2-contracts-approval-recovery.test.ts` | `+41 / -0` | Test | `W-PRE-P1B` (uji kontrak `TOOL-01` & approval binding) |
| 38 | `test/p2-daemon.test.ts` | `+60 / -0` | Test | `W-PRE-P1B` (uji daemon & stream) |
| 39 | `test/p20-phase8-supersession-mcp-pin-and-tasksync.test.ts` | `+108 / -0` | Test | `W-PRE-P1B` (uji supersession memori) |
| 40 | `test/p21-phase9-ace-ablation-splitbrain-and-ci.test.ts` | `+8 / -5` | Test | `W-PRE-P1B` (penyesuaian test rekonsiliasi split-brain & CI) |
| 41 | `test/p24-phase12-audit3-deep-bugs-and-security.test.ts` | `+1 / -1` | Test | `W-PRE-P1B` (penyesuaian asersi minor keamanan) |
| 42 | `test/presentation-bridge.test.ts` | `+34 / -0` | Test | `W-PRE-P1A` (uji bridge event presentasi) |
| 43 | `test/presentation-events.test.ts` | `+92 / -0` | Test | `W-PRE-P1A` (uji durabilitas & skema event) |
| 44 | `test/presentation-linear-acp.test.ts` | `+79 / -0` | Test | `W-PRE-P1A` (uji paritas linear & ACP) |
| 45 | `test/presentation-policy.test.ts` | `+33 / -0` | Test | `W-PRE-P1A` (uji kebijakan presentasi) |
| 46 | `test/presentation-projections.test.ts` | `+184 / -1` | Test | `W-PRE-P1A` (uji proyeksi observabilitas) |
| 47 | `test/pty.test.ts` | `+14 / -2` | Test (PTY) | `W-PRE-P1A` (penyesuaian ekspektasi PTY TUI) |
| 48 | `test/sanitize-render.test.ts` | `+3 / -2` | Test | `W-PRE-P1B` (uji sanitasi render) |
| 49 | `test/terminal-contract.test.ts` | `+6 / -5` | Test | `W-PRE-P1A` (uji kontrak terminal) |
| 50 | `test/tui-format.test.ts` | `+41 / -8` | Test | `W-PRE-P1A` (uji format ledger TUI) |

#### B. Berkas Tracked Pra-Sesi yang Diperluas oleh Sesi 1 P0.2 (`14` berkas — perubahan pra-sesi dipertahankan utuh)

| # | Path | Numstat `t0` | Numstat `t1` | Provenance Gabungan |
|---:|---|---:|---:|---|
| 51 | `cli/commands/acp.ts` | `+10 / -0` | `+18 / -3` | `W-PRE-P0` + `W-S1-P0.2` (fallback `MINICODE_WORK_MODE` + echo `result.workMode`) |
| 52 | `cli/commands/exec.ts` | `+13 / -0` | `+38 / -7` | `W-PRE-P0` + `W-S1-P0.2` (`VerifyWorkModeConflictError` exit `2` + `flagsAfterPromptBoundary` warn + `ctx.workMode`) |
| 53 | `cli/index.ts` | `+28 / -2` | `+30 / -5` | `W-PRE-P0` + `W-S1-P0.2` (`VerifyWorkModeConflictError` exit `2`, `/work-mode` di `HELP`, live `ctx.workMode`) |
| 54 | `cli/setup.ts` | `+151 / -1` | `+220 / -24` | `W-PRE-P0`/`P1B` + `W-S1-P0.2` (persist/restore `work_mode`, fail-closed `--verify`, runtime skip verify/hooks/RAG `trackAccess`, sinkronisasi `setPermissionMode`) |
| 55 | `cli/tui.ts` | `+49 / -25` | `+57 / -26` | `W-PRE-P1A` + `W-S1-P0.2` (registrasi `/mode` dan `/work-mode` pada `DRIVER_COMMANDS`) |
| 56 | `docs/TERMINAL_CONTRACT.md` | `+59 / -4` | `+91 / -24` | `W-PRE-P0`/`P1A` + `W-S1-P0.2` (pembaruan klausul I35 & peta proteksi test untuk `A1`–`A5`) |
| 57 | `src/app/session.ts` | `+117 / -18` | `+153 / -35` | `W-PRE-P0` + `W-S1-P0.2` (reaktivitas `StreamRequest.system` per-turn via `dynamicProvider` — penutup `G-PROMPT-RT`) |
| 58 | `src/policy/permission.ts` | `+211 / -25` | `+221 / -25` | `W-PRE-P1B` + `W-S1-P0.2` (seam internal `__promptGated` menuju `promptAskOr` kanonik) |
| 59 | `src/policy/tool-contract.ts` | `+57 / -0` | `+77 / -0` | `W-PRE-P1B` + `W-S1-P0.2` (`LOCAL_READONLY_TOOL_NAMES` = 16 tool, `NETWORK_READ_TOOL_NAMES` = 2 tool) |
| 60 | `src/session/persistence.ts` | `+18 / -0` | `+96 / -7` | `W-PRE-P1B` + `W-S1-P0.2` (kolom DDL/migrasi `sessions.work_mode` + helper load/save `workMode`) |
| 61 | `src/tools/memory.ts` | `+53 / -9` | `+57 / -10` | `W-PRE-P1B` + `W-S1-P0.2` (`read_memory` menahan `trackAccess` saat `WorkMode !== "EXECUTE"` — penutup `G-MEM-TRACK`) |
| 62 | `test/cli-setup-coverage.test.ts` | `+58 / -0` | `+88 / -0` | `W-PRE-P0` + `W-S1-P0.2` (uji roundtrip `sessions.work_mode` pada `--resume`, fallback legacy `NULL`, dan override eksplisit) |
| 63 | `test/work-mode-cli.test.ts` | `+15 / -0` | `+352 / -0` | `W-PRE-P0` + `W-S1-P0.2` (uji `Q4=A4` `--verify`, `Q5=A5` ACP env/echo, `daemon` `workMode`, `exec` boundary warn) |
| 64 | `test/writer-inventory.test.ts` | `+30 / -3` | `+31 / -3` | `W-PRE-P1A` + `W-S1-P0.2` (kuota writer `cli/commands/exec.ts` `16 -> 17` untuk peringatan `flagsAfterPromptBoundary`) |

#### C. Berkas Tracked Bersih di `t0` yang Dimodifikasi oleh Sesi 1 P0.2 (`12` berkas)

| # | Path | Numstat `t1` | Peran dalam Kontrak P0.2 |
|---:|---|---:|---|
| 65 | `cli/commands/daemon.ts` | `+44 / -5` | Paritas `--work-mode` / `MINICODE_WORK_MODE`, penolakan `--verify` non-`EXECUTE`, ekspos `workMode` pada `HostedSessionInfo` (`session.list`/`session.status`) dan JSON start (`Q5=A5`). |
| 66 | `src/app/tool-layer.ts` | `+64 / -60` | Penyelarasan `workModeVisible` & `setupToolLayer`: `DISCUSS` = 16 tool baca lokal, `PLAN × {readonly, allowlist}` = 18 (`G5` tertutup), `PLAN × {auto, ask, plan, allow-all}` = 21, plus `setPermissionMode` live. |
| 67 | `src/daemon/control.ts` | `+2 / -0` | Field opsional `workMode?: "DISCUSS" \| "PLAN" \| "EXECUTE"` pada `HostedSessionInfo`. |
| 68 | `src/hooks/run.ts` | `+5 / -1` | `shouldRunHooks(permissionMode, workMode)` memblokir `DISCUSS` **dan** `PLAN` di seluruh `PermissionMode` (`Q3=A3`). |
| 69 | `src/policy/executor.ts` | `+44 / -5` | `liveRegistry` berdasar `registry.list()` dinamis (menutup `G1` tanpa menyentuh `vendor/minicore/**`) + injeksi `permissionMode: "readonly"` pada sesi murni-baca (`explore` child / `DISCUSS` / `PLAN`). |
| 70 | `src/policy/work-mode.ts` | `+49 / -1` | `VerifyWorkModeConflictError`, blokir keras `NETWORK_READ_TOOL_NAMES` di `DISCUSS` (`0` prompt), dan gerbang `ctrl.__promptGated` wajib untuk `NETWORK_READ_TOOL_NAMES` di `PLAN` (`Q2=A2`). |
| 71 | `test/helpers/work-mode-matrix.ts` | `+148 / -27` | Fixture independen 18 sel dengan ekspektasi `ceiling`, `networkRead`, `hooks`, dan `verify`. |
| 72 | `test/work-mode-contract.test.ts` | `+190 / -8` | Bukti 16 local read di `DISCUSS`, blokir network read di `DISCUSS`, wajib prompt network read di `PLAN × 6 PM`, serta invarian monotonisitas 18 sel × 33 tool bawaan. |
| 73 | `test/work-mode-hooks.test.ts` | `+40 / -36` | Bukti pemblokiran hooks di `DISCUSS` & `PLAN` (unit + marker file nyata + transisi produksi `createCliSession`). |
| 74 | `test/work-mode-runtime.test.ts` | `+159 / -18` | Bukti penutupan `G1` (`DISCUSS → EXECUTE` menulis berkas, `EXECUTE → DISCUSS` menolak) & `G-MEM-TRACK` (`access_count = 0` di SQLite pada `DISCUSS`/`PLAN`). |
| 75 | `test/work-mode-subagent.test.ts` | `+40 / -0` | Bukti `explore` sub-agent (`PM=auto`) tidak menaikkan `memory.access_count` saat memanggil `read_memory` (Invarian #5). |
| 76 | `test/work-mode-tool-visibility.test.ts` | `+101 / -74` | Bukti keselarasan `visible === callable` (`16` di `DISCUSS`, `18` di `PLAN × readonly/allowlist`, `21` di `PLAN × lainnya`, sinkronisasi transisi runtime). |

---

### 2.4 Manifest Provenance Seluruh Berkas Untracked (`44` Pra-Sesi + `1` Laporan Baru = `45` Berkas)

#### Kelompok U1 — Modul Source & Test Baru dari Gelombang Pra-Sesi (`9` berkas: `2` `src/` + `7` `test/`)
1. `src/policy/approval-binding.ts` (`7.489 B`, `sha256:a6530a47760e`, `W-PRE-P1B` — kanonikalisasi & verifikasi binding approval).
2. `src/ui/session-state.ts` (`9.183 B`, `sha256:42e526f0566f`, `W-PRE-P1B` — state UI per-sesi).
3. `test/approval-integrity.test.ts` (`12.280 B`, `sha256:264e3d5c9931`, `W-PRE-P1B`).
4. `test/ci-glob-expansion.test.ts` (`2.583 B`, `sha256:1682a14c5aa1`, `W-PRE-P1B`).
5. `test/daemon-stream-phase.test.ts` (`12.401 B`, `sha256:41db050deb6d`, `W-PRE-P1B`).
6. `test/memory-consistency.test.ts` (`11.852 B`, `sha256:ce8eae5db0f2`, `W-PRE-P1B`).
7. `test/presentation-observability.test.ts` (`15.800 B`, `sha256:58a96dd1fde9`, `W-PRE-P1A`).
8. `test/ui-instance-isolation.test.ts` (`9.987 B`, `sha256:60c42a91bc42`, `W-PRE-P1B`).
9. `test/work-mode-prompt.test.ts` (`t0`: `4.147 B` `sha256:15f5608eeaf6` dari `W-PRE-P0` → diperluas di `t1` menjadi `6.251 B` `sha256:15d8dde4617d` oleh `W-S1-P0.2` untuk menutup `G-PROMPT-RT`).

#### Kelompok U2 — Laporan Audit & Handoff Historis (`10` berkas pra-sesi utuh + `1` laporan Sesi 1 ini = `11` berkas)
10. `CODE_QUALITY_AUDIT_2026-11-04.md` (`10.824 B`, `sha256:7ee64010fde1`)
11. `docs/audit/UI_UX_PRESENTATION_AND_DISCUSS_MODE_DEEP_AUDIT.md` (`44.325 B`, `sha256:c71c05991f14`)
12. `docs/audit/LIVE_UAT_HARNESS_0.13.x_REPORT_2026-11-02.md` (`20.322 B`, `sha256:c2eb0759df01`)
13. `docs/audit/P0_BASELINE_AND_MODE_ARCHITECTURE_CONSOLIDATION.md` (`28.315 B`, `sha256:8b9e4e3f901d`)
14. `docs/audit/P1_INTEGRATED_REMEDIATION_REPORT.md` (`14.057 B`, `sha256:37927f940acb`)
15. `docs/audit/P1_COMPLETION_MODE_UX_OBSERVABILITY_REPORT.md` (`11.756 B`, `sha256:6405f6ffd90b`)
16. `docs/audit/P1_OBSERVABILITY_INTERACTION_COMPLETION_REPORT.md` (`13.816 B`, `sha256:cd4c302048b6`)
17. `docs/audit/P1_REMAINING_SURFACE_COMPLETION_REPORT.md` (`16.603 B`, `sha256:4bea013dbc0f`)
18. `docs/audit/FINAL_INTEGRATION_RELIABILITY_CLOSURE_REPORT.md` (`20.947 B`, `sha256:950a8afdc5a2`)
19. `docs/audit/P0_P2_BASELINE_REASSESSMENT_2026-11-04.md` (`74.244 B`, `sha256:075ef60f971d`)
20. `docs/audit/P0_FOUNDATION_HARDENING_REPORT_2026-11-04.md` (**baru — deliverable Sesi 1 ini**).

#### Kelompok U3 — Artefak Sementara Log Test & Skrip Probe di Root (`25` berkas — seluruhnya *provenance* teridentifikasi, TIDAK dihapus tanpa izin pemilik)
- `.tmp-probe.ts` (`867 B`, `sha256:8b26070aff03`, 2026-11-03 06:06 — skrip probe sementara pemeriksaan proyeksi/state sesi dari sesi debugging 2026-11-03; tidak diimpor oleh `src/`, `cli/`, `test/`, atau `scripts/`).
- `a1.txt`..`a6.txt` (`6` berkas, `103–956 B`, 2026-11-03 05:48–06:02 — tangkapan stdout/stderr `bun test` potongan sesi pagi 2026-11-03).
- `b1.txt`..`b5.txt` (`5` berkas, `105–274 B`, 2026-11-03 06:13–06:25 — tangkapan ringkasan `bun test` gelombang kedua).
- `c1.txt` (`494 B`, `sha256:503ad0700f63`, 2026-11-03 06:50 — tangkapan output test).
- `d1.txt`..`d3.txt` (`3` berkas, `102–668 B`, 2026-11-03 08:13–08:33 — tangkapan output test).
- `e1.txt` (`1.088 B`, `sha256:c4c23d08d65c`, 2026-11-03 08:35 — tangkapan output test).
- `f1.txt`, `f2.txt` (`2` berkas, `104 B` & `871 B`, 2026-11-03 14:26–14:28 — tangkapan output test).
- `g1.txt` (`906 B`, `sha256:cb138356306c`, 2026-11-03 16:02 — tangkapan output test).
- `t.log.txt`, `t.log.xml`, `t.xml`, `t2.log.txt`, `t3.log.txt` (`5` berkas, `832–12.162 B`, 2026-11-02 08:59–09:03 — log teks & JUnit XML `bun test` sesi 2026-11-02).

**Kesimpulan provenance P0.1:** **0 perubahan misterius / tanpa provenance.** Seluruh berkas di working tree memiliki asal-usul yang jelas dan dapat dilacak ke gelombang sesi spesifik.

---

### 2.5 Strategi Checkpoint untuk Keputusan Pemilik

Karena working tree kini menampung perubahan lintas gelombang (`P0` + sebagian `P1` dari sesi terdahulu + `25` file log sementara), mencampur semuanya dalam satu commit raksasa akan mengaburkan sejarah Git (`git bisect` & audit regresi). Kami menyajikan **3 opsi strategi checkpoint** untuk dipilih pemilik sebelum masuk ke Sesi 2 (P1):

1. **Opsi C1 (Direkomendasikan) — Pemisahan Commit Atomik Berlapis + Pembersihan Artefak Sementara Terotorisasi:**
   - **Langkah 1 (Cleanup terotorisasi):** Hapus tepat ke-25 berkas sementara Kelompok U3 (`.tmp-probe.ts`, `a1..g1.txt`, `t*.log.txt`, `t*.xml`) setelah pemilik menyetujui daftarnya. Pertahankan seluruh laporan di `docs/audit/` (atau commit terpisah sebagai `docs(audit)`).
   - **Langkah 2 (Commit 1 — `feat(policy): finalize P0 WorkMode contract and session persistence`):** Stage secara selektif hanya himpunan berkas P0 (`cli/args.ts`, `cli/commands/{acp,daemon,exec}.ts`, `cli/{index,setup,tui}.ts` hunk P0, `src/policy/{tool-contract,permission,work-mode,executor}.ts`, `src/app/{session,tool-layer}.ts`, `src/hooks/run.ts`, `src/session/persistence.ts`, `src/tools/{memory,task}.ts`, `src/daemon/control.ts`, `docs/{TERMINAL_CONTRACT,cli}.md`, dan 8 berkas `test/work-mode-*.test.ts` + `test/helpers/work-mode-matrix.ts` + `test/cli-args.test.ts`).
   - **Langkah 3 (Commit 2 — `feat(presentation,security): checkpoint pre-existing P1 observability, approval binding, and memory consistency`):** Stage sisa modul `W-PRE-P1A` & `W-PRE-P1B` setelah diverifikasi pada Sesi P1.
2. **Opsi C2 — Satu Commit Baseline Konsolidasi Pra-P1 (`chore(baseline): checkpoint verified P0 foundation and in-flight P1 work`):**
   - Lebih cepat karena tidak memerlukan `git add -p` pada `cli/setup.ts`, `cli/tui.ts`, `src/policy/permission.ts`, `src/session/persistence.ts`, dan `src/tools/memory.ts` yang memuat hunk gabungan `W-PRE-P1` + `W-S1-P0.2`; namun satu commit menggabungkan cakupan P0 dan P1 awal. Tetap wajib didahului pembersihan ke-25 berkas Kelompok U3.
3. **Opsi C3 — Branch Isolasi (`git switch -c wip/p0-p2-hardening`):**
   - Menjaga `main` lokal tetap menunjuk `cb60212` sementara seluruh commit berlapis (C1/C2) disusun dan diuji penuh di branch kerja sebelum di-*merge* kembali ke `main`.

---

## 3. Inventory Discrepancy Resolution (`P0.1`)

Hasil rekonsiliasi berbasis Git aktual atas seluruh selisih angka pada `docs/audit/P0_P2_BASELINE_REASSESSMENT_2026-11-04.md` dan laporan sebelumnya:

| # | Klaim di Laporan Sebelumnya | Fakta Git Aktual (`t0`) | Penyebab Matematis Selisih |
|---:|---|---|---|
| **D1** | `P0_P2_BASELINE_REASSESSMENT` (§0.1 baris 31 & Lampiran A.2): melaporkan **`43` untracked path** dan mengklaim `status_sha256` awal = akhir. | **`44` untracked file** pada `t0` (`git ls-files --others --exclude-standard` = `44`; `git status -unormal` = `44` karena direktori `docs/audit/` sudah *tracked* lewat berkas lama lain). | Sebelum laporan `P0_P2_BASELINE_REASSESSMENT_2026-11-04.md` ditulis, jumlah untracked memang **`43`**. Penulisan berkas laporan itu sendiri menambah **`+1`** untracked menjadi **`44`**. Sidik jari di baris 6 laporan tersebut dihitung **sebelum** berkas laporan ditulis dan tidak dihitung ulang sesudahnya. |
| **D2** | `P0_P2_BASELINE_REASSESSMENT` (§0.1 baris 31): merinci `43` untracked sebagai **`"14 source/test baru, 8 laporan docs/audit/ + 1 root audit, 20 artefak log/probe"`** (`14+9+20 = 43`). | Rincian sebenarnya dari `43` berkas pra-laporan tersebut adalah: **`9` source/test baru** (`2` `src/` + `7` `test/`), **`9` laporan audit** (`8` di `docs/audit/` + `CODE_QUALITY_AUDIT_2026-11-04.md`), dan **`25` artefak log/probe** (`9+9+25 = 43`, atau `+1` laporan baru = `44`). | Di Lampiran A.2 laporan itu sendiri hanya tertulis `9` path source/test (`2` `src/` + `7` `test/`), dan di Lampiran A.3 tertulis `25` file sampah (`a1..a6`[6] + `b1..b5`[5] + `c1`[1] + `d1..d3`[3] + `e1`[1] + `f1..f2`[2] + `g1`[1] + `t*`[5] + `.tmp-probe.ts`[1] = **25**, tetapi penulis salah menjumlahkannya sebagai `"21 file"` / `"20 artefak"` lalu mengkompensasi selisih `5` ke `"14 source/test"`). |
| **D3** | `P0_P2_BASELINE_REASSESSMENT` (§2.2 baris 200–202): header menulis **`"Source non-test dalam diff (29)"`** sementara §0.1 baris 30 menulis **`35 source + 25 test + 3 docs + 1 CI = 64"`**. | Di bawah header `(29)` tersebut tertulis eksplisit **`34` path** (`cli/*` 7 + `src/app` 1 + `src/policy` 2 + `src/session` 1 + `src/tools` 2 + `src/memory` 2 + `src/daemon` 5 + `src/presentation` 5 + `src/ui` 9 = **34**), atau **35** bila `cli/*` dihitung bersama `.github/workflows/ci.yml`? Tidak: hitung eksak `64` tracked modified di `t0` adalah **`34` source (`7` `cli/` + `27` `src/`) + `26` test (`test/*`) + `3` docs (`docs/*`) + `1` CI (`.github/workflows/ci.yml`) = `64`**. | Salah hitung manual dua arah pada laporan lama: daftar aktual di §2.2 berisi `34` source (bukan `29` dan bukan `35`), sedangkan daftar aktual di Lampiran A.1 berisi `26` berkas `test/*` (bukan `25`). Jumlah total `34 + 26 + 3 + 1` tetap **`64`**. |
| **D4** | `P0_P2_BASELINE_REASSESSMENT` (§0.1 baris 28): menulis **`"Tag: v0.13.0 menunjuk 1cd3a92; tidak ada tag di HEAD"`** (melewatkan tag `v0.13.1`). | Tag **`v0.13.1`** **ada** di repository lokal dan menunjuk tepat ke commit parent **`57c59d363b3f7bafca07c050992f6ffccb227463`** (`origin/main`), itulah sebabnya `git describe` menghasilkan `v0.13.1-1-gcb60212`. | Kekeliruan narasi ringkasan tag pada laporan lama; `HEAD` (`cb60212`) memang 1 commit di atas tag `v0.13.1`. |
| **D5** | `AGENTS.md` (catatan historis 2026-10-21): menyebut `ROADMAP.md` masih *draft working-tree yang belum di-commit*. | `git ls-files ROADMAP.md` menunjukkan `ROADMAP.md` **sudah tracked dan bersih** di `HEAD` (di-commit sejak era pra-`0.13.0`). Selain itu, sesuai instruksi pemilik, **roadmap hybrid P0–P2 adalah satu-satunya roadmap aktif** saat ini. | Catatan status integrasi di `AGENTS.md` berasal dari snapshot 2026-10-21 dan belum diperbarui setelah `ROADMAP.md` di-commit. |
| **D6** | `CODE_QUALITY_AUDIT_2026-11-04.md` (14:11 WIB): melaporkan **`98` untracked entries** (termasuk puluhan direktori `.tmp-audit-*` / `.tmp-*`). | Pada `16:05 WIB` (`P0_P2_BASELINE_REASSESSMENT`) dan `16:21 WIB` (`t0` Sesi 1), tersisa **`44` untracked files** tanpa direktori `.tmp-audit-*`. | Direktori `.tmp-*` transien dibersihkan di sela antara penulisan `CODE_QUALITY_AUDIT_2026-11-04.md` (14:11) dan `FINAL_INTEGRATION_RELIABILITY_CLOSURE_REPORT.md` (14:28). |

---

## 4. WorkMode × PermissionMode Truth Table (`P0.2`)

MiniCode mempertahankan **tepat tiga `WorkMode`** (`DISCUSS`, `PLAN`, `EXECUTE`) sebagai lapisan **intent & ceiling**, terpisah tegas dari enam **`PermissionMode`** (`readonly`, `plan`, `ask`, `auto`, `allowlist`, `allow-all`) sebagai lapisan **otoritas allow/deny/prompt**.

### Definisi Himpunan Tool Kanonik (`src/policy/tool-contract.ts`)
- **`ALL_BUILTIN` (`33` tool):** seluruh tool bawaan di `allTools`.
- **`EXPLORE_TOOL_NAMES` (`12` tool — sub-agent `explore`):** `read_file`, `glob`, `grep`, `list_dir`, `git_status`, `git_log`, `lsp_diagnostics`, `lsp_definition`, `lsp_hover`, `read_memory` *(non-mutating)*, `mcp_list`, `task_output`.
- **`LOCAL_READONLY_TOOL_NAMES` (`16` tool — ceiling `DISCUSS`, `Q1=A1`):** `EXPLORE_TOOL_NAMES` (12) `∪` `{read_image, git_diff, lsp_references, lsp_symbols}`. Seluruhnya `PURE_READ` lokal; `read_memory` dipaksa `trackAccess = false` (nol mutasi SQLite).
- **`NETWORK_READ_TOOL_NAMES` (`2` tool — `Q2=A2`):** `{web_fetch, web_search}`.
- **`READONLY_TOOL_NAMES` (`18` tool):** `LOCAL_READONLY_TOOL_NAMES` (16) `∪` `NETWORK_READ_TOOL_NAMES` (2).
- **`PLAN_EXTRA` (`3` tool):** `{todo_write, delegate_task, submit_result}`.

### Tabel Kebenaran 18 Sel (`WorkMode × PermissionMode`)

| # | WorkMode | PermissionMode | Builtin Visible (`visible === callable`) | Local Read (`16`) | Network Read (`web_fetch`, `web_search`) | Plan Extra (`todo_write`, `submit_result`, `delegate_task`) | Write / Bash / `code_run` / `git_commit` / `write_memory` / `ask_user` / MCP | Hooks (`.minicode/hooks/*`) | `--verify` & Self-Heal | Child Delegation (`delegate_task`) |
|---:|---|---|---:|---|---|---|---|---|---|---|
| 1 | `DISCUSS` | `readonly` | **16** (`LOCAL_READONLY`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | **Hidden & Deny** (`0` prompt) | **Hidden & Deny** | **Hidden & Deny** | **Blocked** | **Refused** (`exit 2` startup; skip saat switch runtime) | **Hidden & Deny** |
| 2 | `DISCUSS` | `plan` | **16** (`LOCAL_READONLY`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | **Hidden & Deny** (`0` prompt) | **Hidden & Deny** | **Hidden & Deny** | **Blocked** | **Refused** | **Hidden & Deny** |
| 3 | `DISCUSS` | `ask` | **16** (`LOCAL_READONLY`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | **Hidden & Deny** (`0` prompt) | **Hidden & Deny** | **Hidden & Deny** | **Blocked** | **Refused** | **Hidden & Deny** |
| 4 | `DISCUSS` | `auto` | **16** (`LOCAL_READONLY`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | **Hidden & Deny** (`0` prompt) | **Hidden & Deny** | **Hidden & Deny** | **Blocked** | **Refused** | **Hidden & Deny** |
| 5 | `DISCUSS` | `allowlist` | **16** (`LOCAL_READONLY`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | **Hidden & Deny** (`0` prompt) | **Hidden & Deny** | **Hidden & Deny** | **Blocked** | **Refused** | **Hidden & Deny** |
| 6 | `DISCUSS` | `allow-all` | **16** (`LOCAL_READONLY`) | Allow (`0` prompt, **jail tetap aktif**, `read_memory` non-mutating) | **Hidden & Deny** (`0` prompt) | **Hidden & Deny** | **Hidden & Deny** | **Blocked** | **Refused** | **Hidden & Deny** |
| 7 | `PLAN` | `readonly` | **18** (`READONLY`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | **Prompt wajib** (TTY+`ask` → allow/deny; headless → **Deny**) | **Hidden & Deny** (`PM=readonly` tidak diperluas) | **Hidden & Deny** | **Blocked** | **Refused** | **Hidden & Deny** |
| 8 | `PLAN` | `plan` | **21** (`READONLY ∪ PLAN_EXTRA`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | **Prompt wajib** (TTY+`ask` → allow/deny; headless → **Deny**) | Allow (`todo_write`, `submit_result`, `delegate_task`) | **Hidden & Deny** | **Blocked** | **Refused** | Child mewarisi `workMode="PLAN"` + forced `explore` (`12` tool baca) |
| 9 | `PLAN` | `ask` | **21** (`READONLY ∪ PLAN_EXTRA`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | **Prompt wajib** (TTY+`ask` → allow/deny; headless → **Deny**) | `todo_write` & `submit_result`: Allow (`0` prompt di `ask`? *Catatan:* di `PM=ask`, tool non-readonly termasuk `todo_write`/`submit_result`/`delegate_task` tetap melewati gerbang `ask`/allowlist base PM; headless = **Deny**) | **Hidden & Deny** | **Blocked** | **Refused** | Setelah lolos prompt `ask`, child mewarisi `workMode="PLAN"` + `12` tool `explore` |
| 10 | `PLAN` | `auto` | **21** (`READONLY ∪ PLAN_EXTRA`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | **Prompt wajib** (TTY+`ask` → allow/deny; headless → **Deny**) | `todo_write` & `submit_result`: Allow; `delegate_task`: **Prompt wajib** via base `auto` (headless → **Deny**) | **Hidden & Deny** | **Blocked** | **Refused** | Setelah lolos prompt, child mewarisi `workMode="PLAN"` + ceiling `12` tool `explore` |
| 11 | `PLAN` | `allowlist` | **18** (`READONLY`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | **Prompt wajib** (TTY+`ask` → allow/deny; headless → **Deny**) | **Hidden & Deny** (ceiling ketat S2.1 + `G5` tertutup) | **Hidden & Deny** | **Blocked** | **Refused** | **Hidden & Deny** |
| 12 | `PLAN` | `allow-all` | **21** (`READONLY ∪ PLAN_EXTRA`) | Allow (`0` prompt, **jail tetap aktif** dari ceiling `plan`, `read_memory` non-mutating) | **Prompt wajib** (TTY+`ask` → allow/deny; headless → **Deny**) | Allow (`todo_write`, `submit_result`, `delegate_task`) | **Hidden & Deny** | **Blocked** | **Refused** | Child mewarisi `workMode="PLAN"` + ceiling `12` tool `explore` |
| 13 | `EXECUTE` | `readonly` | **18** (`READONLY`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | Allow (`0` prompt, SSRF/private-host guard aktif) | **Hidden & Deny** | **Hidden & Deny** | **Blocked** (`PM=readonly`) | Allowed (mengikuti `--verify` CLI) | **Hidden & Deny** |
| 14 | `EXECUTE` | `plan` | **21** (`READONLY ∪ PLAN_EXTRA`) | Allow (`0` prompt, jail aktif, `read_memory` non-mutating) | Allow (`0` prompt) | Allow (`todo_write`, `submit_result`, `delegate_task`) | **Hidden & Deny** | **Blocked** (`PM=plan`) | Allowed (mengikuti `--verify` CLI) | Child forced `explore` (`12` tool baca non-mutating) |
| 15 | `EXECUTE` | `ask` | **33** (+ MCP) | Allow (`0` prompt, jail aktif) | Allow (`0` prompt) | Prompt `ask` (kecuali di-grant allowlist) | Prompt `ask` per panggilan (jail tetap aktif; headless = Deny kecuali allowlisted) | **Allowed** (bila `MINICODE_HOOKS=1`) | Allowed | Prompt `ask`; child forced `explore` |
| 16 | `EXECUTE` | `auto` | **33** (+ MCP) | Allow (`0` prompt, jail aktif) | Allow (`0` prompt) | `todo_write`/`submit_result` Allow; `delegate_task` Prompt | Write dalam workspace & bash aman Allow; `git_commit`/destruktif/MCP/`code_run` Prompt (headless = Deny) | **Allowed** (bila `MINICODE_HOOKS=1`) | Allowed | Prompt pada parent; child `workMode="EXECUTE"` |
| 17 | `EXECUTE` | `allowlist` | **33** (+ MCP) | Allow (`0` prompt, jail aktif) | Allow (`0` prompt) | `todo_write`/`submit_result` Allow; `delegate_task` Deny | Write dalam workspace & bash safelist (`ls`/`git status`/`bun test`/dll.) Allow; lainnya **Deny tanpa prompt** | **Allowed** (bila `MINICODE_HOOKS=1`) | Allowed | `delegate_task` ditolak oleh `PM=allowlist` |
| 18 | `EXECUTE` | `allow-all` | **33** (+ MCP) | Allow (`0` prompt) | Allow (`0` prompt) | Allow | Allow tanpa prompt (catatan: hard safety floor seperti secret scrub & sub-agent background-bash block tetap aktif) | **Allowed** (bila `MINICODE_HOOKS=1`) | Allowed | Allowed; child `workMode="EXECUTE"` |

---

## 5. Keputusan Owner dan Rekomendasi Arsitektural (`Q1`–`Q5`)

Seluruh lima pertanyaan arsitektural diajukan kepada pemilik proyek terlebih dahulu sebelum satu baris pun source code diubah, dan telah diputuskan secara eksplisit oleh pemilik:

### Q1 — Semantik `DISCUSS`
- **Kondisi awal pra-Sesi 1:** `DISCUSS` menampilkan 12 `EXPLORE_TOOL_NAMES` di `tool-layer.ts` tetapi mengizinkan 18 `READONLY_TOOL_NAMES` di `work-mode.ts` (`visible !== callable`), sementara `read_memory` masih menulis `access_count` ke SQLite saat `PM=auto`, dan transisi runtime `DISCUSS → EXECUTE` mengalami bug `G1` (`Unknown tool` karena `executor.ts` membekukan `Map` tool saat start).
- **Opsi yang disajikan:**
  - *Opsi A1 (Rekomendasi):* Read-only local investigation dengan tepat **16 tool baca lokal (`LOCAL_READONLY_TOOL_NAMES`)**, `visible === callable`, nol mutasi workspace/DB, dan perbaikan `G1` + `G-PROMPT-RT`.
  - *Opsi B1:* Read-only terbatas ke 12 `EXPLORE_TOOL_NAMES`.
  - *Opsi C1:* Conversation-only (`0` tool).
- **Keputusan Pemilik:** **`A1` (Disetujui)** — `DISCUSS` menyediakan tepat 16 tool `PURE_READ` lokal dengan `visible === callable` dan nol mutasi DB/workspace.

### Q2 — Network Read (`web_fetch` & `web_search`)
- **Kondisi awal pra-Sesi 1:** `web_fetch` dan `web_search` disembunyikan dari schema di `DISCUSS`/`PLAN`, tetapi jika model tetap memanggilnya, `work-mode.ts` mengizinkannya tanpa prompt (`allow`) karena keduanya anggota `READONLY_TOOLS`.
- **Opsi yang disajikan:**
  - *Opsi A2 (Rekomendasi):* **Deny di `DISCUSS`** (disembunyikan + ditolak di handler tanpa prompt); **Allow dengan wajib approval prompt di `PLAN`** di seluruh 6 `PermissionMode` (terlihat di schema `PLAN`, headless = `deny`); **mengikuti `PermissionMode` di `EXECUTE`**.
  - *Opsi B2:* Allow dengan wajib approval prompt di `DISCUSS` maupun `PLAN`.
  - *Opsi C2:* Allow tanpa prompt di `DISCUSS` dan `PLAN`.
- **Keputusan Pemilik:** **`A2` (Disetujui)** — `DISCUSS` murni lokal tanpa eksfiltrasi URL/query jaringan; `PLAN` dapat meriset dokumentasi eksternal hanya dengan persetujuan eksplisit pengguna.

### Q3 — `PLAN` Hooks (`.minicode/hooks/*`)
- **Kondisi awal pra-Sesi 1:** `shouldRunHooks(pm, wm)` hanya menahan `wm === "DISCUSS"`, sehingga `PLAN × auto` tetap mengeksekusi skrip `.minicode/hooks/post-*.js` yang memiliki akses penuh filesystem/child_process/network di luar sandbox permission.
- **Opsi yang disajikan:**
  - *Opsi A3 (Rekomendasi):* **Blokir seluruh hooks di `PLAN` pada keenam `PermissionMode`** (sama seperti `DISCUSS`; hooks hanya boleh berjalan di `EXECUTE` bila `PermissionMode` mengizinkan).
  - *Opsi B3:* Izinkan hooks di `PLAN` dengan prompt per-eksekusi.
  - *Opsi C3:* Pertahankan perilaku lama (`PLAN` mengikuti `PermissionMode`).
- **Keputusan Pemilik:** **`A3` (Disetujui)** — `PLAN` tidak boleh menjalankan kode arbitrer di luar ceiling perencanaannya (Invarian #3 & #8).

### Q4 — `--verify` dan Self-Heal pada `DISCUSS` / `PLAN`
- **Kondisi awal pra-Sesi 1:** `--verify` mengeksekusi perintah shell verifikasi proyek (`bun test`/`npm test`/dsb.), memicu loop *self-heal* model, dan menulis kandidat pelajaran ke memori (`recordCandidateLesson`) bahkan ketika sesi berada di `DISCUSS` atau `PLAN`.
- **Opsi yang disajikan:**
  - *Opsi A4 (Rekomendasi):* **Fail-closed saat startup (`exit 2`, `USER_ERROR`)** bila `--verify` dikombinasikan dengan `DISCUSS` atau `PLAN` (termasuk saat `--resume` sesi `DISCUSS`/`PLAN` tanpa override ke `EXECUTE`), **serta otomatis melewati (`skip` + 1 baris peringatan stderr)** baseline verify, self-heal, dan auto-memory write apabila operator menurunkan mode ke `DISCUSS`/`PLAN` di tengah sesi TUI.
  - *Opsi B4:* Jangan gagal saat startup; cukup skip otomatis dengan warning.
  - *Opsi C4:* Tetap jalankan baseline verify baca-saja tanpa self-heal.
- **Keputusan Pemilik:** **`A4` (Disetujui)** — menolak kombinasi kontradiktif secara eksplisit sejak startup sekaligus aman terhadap transisi `/work-mode` saat runtime.

### Q5 — Runtime Parity (`daemon`, `ACP`, `exec`, `resume`, `child agent`)
- **Kondisi awal pra-Sesi 1:** `daemon` mengabaikan `--work-mode`/`MINICODE_WORK_MODE` (selalu `EXECUTE`); `ACP` mengabaikan `MINICODE_WORK_MODE` dan tidak menggemakan `workMode` di hasil JSON-RPC; `exec` tidak memperingatkan flag yang diletakkan setelah prompt; `explore` sub-agent ber-`PM=auto` sehingga `read_memory` memutasi `access_count`; dan `--resume` membuang `WorkMode` ke `EXECUTE` (kontrak lama D-2).
- **Opsi yang disajikan:**
  - *Opsi A5 (Rekomendasi):* **Full parity di seluruh surface + persistensi `WorkMode` di `sessions.work_mode` (SQLite) lintas `--resume`** (menggantikan D-2; sesi legacy `NULL` fallback ke `EXECUTE` dengan notice transparan; flag/env eksplisit dapat meng-override).
  - *Opsi B5:* Full parity di seluruh surface tetapi pertahankan D-2 (tidak dipersist, selalu reset ke `EXECUTE` saat `--resume`).
- **Keputusan Pemilik:** **`A5` (Disetujui)** — paritas penuh lintas surface + persistensi `sessions.work_mode` pada SQLite agar `--resume` tidak pernah menaikkan otoritas sesi `DISCUSS`/`PLAN` ke `EXECUTE` secara diam-diam (Invarian #6).

*(Otorisasi implementasi kode & test terarah diberikan eksplisit oleh pemilik melalui **`Q6 = A6`**).*

---

## 6. Perubahan Source & Test yang Diotorisasi (`P0.2`)

Seluruh perubahan dibatasi ketat pada penegakan kontrak P0.2 (`0` perubahan pada `vendor/minicore/**`):

1. **`src/policy/tool-contract.ts`:** Menurunkan `LOCAL_READONLY_TOOL_NAMES` (16 tool `PURE_READ` lokal) dan `NETWORK_READ_TOOL_NAMES` (`web_fetch`, `web_search`) langsung dari sumber tunggal `TOOL_CONTRACTS`.
2. **`src/policy/permission.ts`:** Mengekspos metode kontrol internal `__promptGated(call, _deps)` pada `createPermissionHandler` yang mendelegasikan ke `promptAskOr(...)` kanonik (menghormati TTY, `ask`, session grant, dan persistensi K-1 `"always"`).
3. **`src/policy/work-mode.ts`:**
   - Menambahkan `VerifyWorkModeConflictError` untuk penolakan fail-closed `--verify` pada mode non-`EXECUTE`.
   - Menolak `NETWORK_READ_TOOL_NAMES` pada `DISCUSS` (`"work-mode DISCUSS: network read disabled"`, `0` prompt).
   - Mewajibkan `ctrl.__promptGated` untuk `NETWORK_READ_TOOL_NAMES` pada `PLAN` setelah lolos `opts.base.check` (sehingga `PLAN × allow-all`, `PLAN × plan`, `PLAN × readonly`, `PLAN × allowlist`, `PLAN × auto`, dan `PLAN × ask` semuanya wajib prompt saat TTY dan `deny` saat headless).
4. **`src/policy/executor.ts`:**
   - Membungkus `rawDeps.registry` dalam `liveRegistry` yang me-resolve `get(name)` secara dinamis terhadap `rawDeps.registry.list()` saat eksekusi tool — menutup bug `G1` (*reveal-after-start* `DISCUSS → EXECUTE`) sekaligus memastikan tool yang dihapus saat `EXECUTE → DISCUSS` tidak lagi terlihat oleh executor, tanpa mengubah `vendor/minicore/**`.
   - Memaksa `permissionMode: "readonly"` pada konteks eksekusi tool ketika `WorkMode !== "EXECUTE"` atau ketika seluruh tool di `registry.list()` adalah `PURE_READ` (menjamin sub-agent `explore` tidak pernah memutasi SQLite `read_memory`).
5. **`src/app/tool-layer.ts`:** Menyelaraskan `workModeVisible`, `applyWorkModeFilter`, dan `setupToolLayer` agar `visible === callable` di seluruh 18 sel (`16` di `DISCUSS`, `18` di `PLAN × {readonly, allowlist}` menutup `G5`, `21` di `PLAN × lainnya` dan `EXECUTE × plan`, `18` di `EXECUTE × readonly`), serta mengekspos `setPermissionMode` untuk sinkronisasi live `/mode` + `Shift+Tab`.
6. **`src/app/session.ts`:** Membungkus `ModelProvider` dalam `dynamicProvider` ringan yang menghitung ulang `StreamRequest.system` (`workModeHint` + `planHint`) pada setiap turn berdasarkan `WorkMode` dan `PermissionMode` aktif — menutup `G-PROMPT-RT`.
7. **`src/hooks/run.ts`:** Memperbarui `shouldRunHooks(permissionMode, workMode)` sehingga `workMode !== "EXECUTE"` (`DISCUSS` maupun `PLAN`) selalu mengembalikan `false` (`Q3=A3`).
8. **`src/tools/memory.ts`:** Memperketat `trackAccess` pada `read_memory` agar hanya bernilai `true` bila `pm !== "readonly" && pm !== "plan" && subAgentWorkMode() === "EXECUTE"` (`G-MEM-TRACK`).
9. **`src/session/persistence.ts`:** Menambahkan kolom `work_mode TEXT NULL` pada DDL `sessions` + migrasi idempoten `ALTER TABLE sessions ADD COLUMN work_mode TEXT NULL` + fungsi `loadSessionWorkMode` / `saveSessionWorkMode` serta dukungan `workMode` di `saveSession` & `loadSession`.
10. **`cli/setup.ts`:**
    - Me-resolve `persistedWorkMode` dari `sessions.work_mode` pada `--resume` sebelum pemeriksaan `VerifyWorkModeConflictError` dan sebelum pembuatan RAG layer (`trackAccess` RAG juga dinonaktifkan pada non-`EXECUTE`).
    - Mencetak baris transparansi `[resume] WorkMode ...` yang jujur (restored / legacy default `EXECUTE` / explicit override) tanpa menambah jumlah writer (`42/42`).
    - Menolak `verify && effectiveWorkMode !== "EXECUTE"` dengan `VerifyWorkModeConflictError`.
    - Menyinkronkan `setToolPermissionMode` saat `onPermissions` berubah dan menyimpan `work_mode` ke SQLite saat `onWorkMode` berubah maupun di `persistCurrent`.
    - Menahan `setCompletionEvidence`, `runHooksGated` (memakai `permissions?.getMode()` terbaru), baseline verify, self-heal, dan auto-memory write ketika `WorkMode` berada di `DISCUSS` atau `PLAN`.
    - Mengekspos `workMode` pada `CliSession` sebagai getter live.
11. **`cli/index.ts`, `cli/tui.ts`, `cli/commands/exec.ts`, `cli/commands/acp.ts`, `cli/commands/daemon.ts`, `src/daemon/control.ts`:**
    - `cli/index.ts` & `cli/commands/exec.ts`: menangani `VerifyWorkModeConflictError` dengan exit code `2` (dan JSON `USER_ERROR` + `workMode` pada `exec --json`), menampilkan `/work-mode` di `HELP`, dan mengeluarkan peringatan `[warn] ignored flag(s) after the prompt` di `exec`.
    - `cli/tui.ts`: mendaftarkan `/mode` dan `/work-mode` pada `DRIVER_COMMANDS` untuk autocomplete TUI tanpa melanggar batas `<= 19` baris `/help`.
    - `cli/commands/acp.ts`: menghormati fallback `MINICODE_WORK_MODE` saat `params.workMode` kosong dan menyertakan `workMode` di payload hasil `session.run`.
    - `cli/commands/daemon.ts` & `src/daemon/control.ts`: meneruskan `--work-mode` / `MINICODE_WORK_MODE` dan `--verify` ke `createCliSession`, menolak `--verify` non-`EXECUTE` tanpa meninggalkan zombie socket, serta melaporkan `workMode` live pada `HostedSessionInfo` (`daemon sessions`) dan JSON `daemon start`.
12. **`docs/TERMINAL_CONTRACT.md` & Test Suites (`9` berkas test/helper):** Memperbarui klausul kontrak I35 + peta proteksinya, serta memperbarui/menambahkan bukti pengujian terarah untuk seluruh keputusan `A1`–`A5` dan Invarian #1–#8.

---

## 7. Test Evidence (`P0.2`)

Seluruh perintah dijalankan pada platform **`win32 x64` (`Microsoft Windows NT 10.0.26340.0`), Bun `1.4.3` (`c6da4a4d3`)**, di atas kandidat **`HEAD=cb602124571d8e4638bdb47d38400c52d8fba976`** dengan sidik jari kandidat teruji **`COMPOSITE_SHA256 = 141c81e23f292455c660d82ca228d4a81dcd082d5e157ba744a23274659374de`** (`UNSTAGED_DIFF_SHA256 = 7a657379affc6f9da576db3a82ff856ac46cc36d3eacb6cdf3a4a7698fd46eef`, `STAGED_DIFF_SHA256 = e3b0c442...` [kosong]).

| # | Command | Exit Code | Jenis Pemeriksaan / Test | Hasil |
|---:|---|---:|---|---|
| 1 | `bun x tsc --noEmit` | **`0`** | Static typecheck (seluruh repo) | Lulus bersih (`0` error TypeScript). |
| 2 | `bun run lint` (`biome check src cli test bench scripts`) | **`0`** | Static lint & formatting (657 berkas) | `Checked 657 files in 1153ms. No fixes applied.` |
| 3 | `bun run vendor:check` (`bun scripts/vendor-minicore.ts --check`) | **`0`** | Frozen vendor boundary check | `20 file, c8d214bb8d5eea86 — sinkron dengan VENDOR.md` (`vendor/minicore/**` tidak tersentuh). |
| 4 | `bun test test/work-mode-contract.test.ts test/work-mode-tool-visibility.test.ts test/work-mode-hooks.test.ts test/work-mode-subagent.test.ts test/work-mode-runtime.test.ts test/work-mode-prompt.test.ts test/work-mode-cli.test.ts test/cli-setup-coverage.test.ts test/p15-phase2-contracts-approval-recovery.test.ts test/delegate-audit.test.ts test/writer-inventory.test.ts test/ui-boundary.test.ts test/cli-help-language.test.ts test/p13-daemon-lifecycle.test.ts` | **`0`** | Gabungan **unit + integration + mocked HTTP (`startFakeProvider`) + isolated subprocess (`Bun.spawn` CLI/HOME) + fake-TTY/TUI driver + real TCP/socket daemon** (14 berkas) | **`224 pass`, `0 fail`, `0 skip`, `2.104` `expect()` calls dalam `16.68s`.** |

### Rincian Cakupan Bukti pada Ke-14 Suite Terarah
- `test/work-mode-contract.test.ts` (unit + isolated subprocess): 18 sel `WorkMode × PermissionMode`, 16 local read allow + network read deny di `DISCUSS`, wajib prompt network read di `PLAN × 6 PM` (TTY allow/deny, headless deny), `delegate_task` gate di `PLAN × auto/ask`, K-1 `"always"`, dan bukti monotonisitas 18 sel × 33 tool bawaan (Invarian #1).
- `test/work-mode-tool-visibility.test.ts` (unit + integration): `16` tool di `DISCUSS × 6 PM`, `18` tool di `PLAN × {readonly, allowlist}` (`G5` tertutup), `21` tool di `PLAN × {auto, ask, plan, allow-all}`, MCP bertitik ditolak di `DISCUSS`/`PLAN`, sinkronisasi `setPermissionMode` + `setWorkMode`.
- `test/work-mode-hooks.test.ts` (unit + subprocess hook Node + integration `createCliSession`): `DISCUSS` & `PLAN` memblokir `.minicode/hooks/*` di seluruh 6 `PermissionMode`, transisi live `EXECUTE → PLAN → DISCUSS → EXECUTE` + `EXECUTE × readonly`.
- `test/work-mode-subagent.test.ts` (unit + integration SQLite): pewarisan `WorkMode` induk secara live, anti-eskalasi argumen `mode: "plan"`, serta bukti `explore` child (`PM=auto`) tidak menaikkan `memory.access_count`.
- `test/work-mode-runtime.test.ts` (unit + integration `createCliSession` + fake-TTY TUI `/work-mode` & `/mode`): bukti penutupan `G1` (`DISCUSS → EXECUTE` menulis berkas, `EXECUTE → DISCUSS` menolak), bukti penutupan `G-MEM-TRACK` (`access_count = 0` di `DISCUSS`/`PLAN`, naik di `EXECUTE`), dan end-to-end TUI `/work-mode` + `/mode` + `Shift+Tab`.
- `test/work-mode-prompt.test.ts` (unit + integration `FakeProvider`): konstruksi prompt `DISCUSS`/`PLAN`/`EXECUTE` + penyegaran dinamis `StreamRequest.system` saat transisi runtime `EXECUTE → DISCUSS → PLAN → EXECUTE` (`G-PROMPT-RT`).
- `test/work-mode-cli.test.ts` (unit + integration + subprocess CLI + real daemon socket): resolusi flag/env, penolakan `--verify` di `DISCUSS`/`PLAN` (termasuk saat `--resume` sesi `DISCUSS`) + skip saat transisi runtime, subprocess `exec --json --verify --work-mode PLAN` (`exit 2`, `USER_ERROR`, `workMode: "PLAN"`), peringatan `flagsAfterPromptBoundary` pada `exec`, fallback `MINICODE_WORK_MODE` & echo `result.workMode` di `ACP`, serta paritas `startDaemonHostedRuntime` + `session.list`.
- `test/cli-setup-coverage.test.ts` (integration SQLite): persistensi & pemulihan `sessions.work_mode` pada `--resume`, fallback transparan sesi legacy (`work_mode = NULL` → `EXECUTE`), dan override eksplisit `--work-mode`.
- `test/p15-phase2-contracts-approval-recovery.test.ts`, `test/delegate-audit.test.ts`, `test/writer-inventory.test.ts`, `test/ui-boundary.test.ts`, `test/cli-help-language.test.ts`, `test/p13-daemon-lifecycle.test.ts`: memastikan tidak ada regresi pada kontrak `TOOL-01`, delegasi sub-agent, kuota writer langsung, batas arsitektur `src/ui`, batas 19 baris `/help`, dan siklus hidup daemon.

### Pengujian yang Sengaja TIDAK Dijalankan (Sesuai Aturan Keselamatan Sesi)
- Full repository suite (`bun test` penuh across seluruh berkas `test/*.test.ts`),
- `bun run gate:coverage` & `bun run gate:pack`,
- `bun run audit:harness`, `gate:slow`, dan `test/pty.test.ts` penuh,
- Live-provider UAT (`bun run test:live` / `test:qa`).

---

## 8. Remaining Blockers

Tidak ada *technical/design blocker* yang tersisa pada cakupan P0 (`P0.1` maupun `P0.2`). Satu-satunya hal yang menunggu tindakan/keputusan pemilik sebelum lanjut ke Sesi 2 (P1) adalah **otorisasi tata kelola working tree**:

1. **Keputusan Checkpoint Git (lihat §2.5):** memilih Opsi `C1` (commit berlapis P0 lalu P1), `C2` (satu commit konsolidasi baseline), atau `C3` (branch kerja) karena aturan sesi melarang `git add`/`git commit` tanpa instruksi eksplisit.
2. **Otorisasi Pembersihan 25 Berkas Sementara Kelompok U3 (lihat §2.4):** `.tmp-probe.ts`, `a1..a6.txt`, `b1..b5.txt`, `c1.txt`, `d1..d3.txt`, `e1.txt`, `f1..f2.txt`, `g1.txt`, `t.log.txt`, `t.log.xml`, `t.xml`, `t2.log.txt`, `t3.log.txt` masih dipertahankan utuh sesuai larangan penghapusan berkas tanpa izin eksplisit.
3. **Gate Penuh Lintas-Repository (pada akhir P1/P2):** penutupan akhir roadmap P0–P2 nantinya tetap mensyaratkan otorisasi eksekusi full `bun test`, `gate:coverage`, `gate:pack`, dan `audit:harness` pada satu kandidat bersih yang sama.

---

## 9. Acceptance Gate `P0.1` dan `P0.2`

### 9.1 Gate `P0.1` — Baseline Integrity & Provenance
- [x] Commit baseline `57c59d3` (`v0.13.1`, `origin/main`) dan `cb60212` (`HEAD`, `7` berkas, `+105/-6`) terverifikasi beserta *ancestry*-nya (§2.1).
- [x] Kandidat saat ini diidentifikasi secara presisi dengan sidik jari SHA-256 deterministik pada `t0`, `t1`, dan `t2` (§2.2).
- [x] Seluruh perubahan *existing* (`64` tracked modified + `44` untracked) dan delta P0.2 (`+12` tracked baru dimodifikasi, `14` tracked diperluas, `1` untracked test diperluas, `1` laporan baru) terinventarisasi penuh (§2.3–§2.4).
- [x] Seluruh perbedaan angka/inventaris laporan audit sebelumnya (`D1`–`D6`) dijelaskan secara eksak dari hasil Git aktual (§3).
- [x] Tidak ada satu pun perubahan pengguna atau berkas untracked yang hilang/dihapus (`0` staged, `0` deleted).
- [x] Strategi *checkpoint* (`C1` / `C2` / `C3`) disajikan lengkap untuk keputusan pemilik (§2.5).

### 9.2 Gate `P0.2` — Pemetaan Bukti 8 Invarian Kontrak WorkMode

| # | Invarian Kontrak Wajib | Status | Bukti Kode & Pengujian |
|---:|---|---|---|
| **1** | `WorkMode` tidak dapat memperluas `PermissionMode`. | **PROVEN** | Komposisi ceiling-first di `src/policy/work-mode.ts` + filter irisan di `src/app/tool-layer.ts`; dibuktikan untuk seluruh `18 sel × 33 tool bawaan` pada `test/work-mode-contract.test.ts` (*Invariant #1 monotonicity*) dan `test/work-mode-tool-visibility.test.ts`. |
| **2** | `DISCUSS` tidak menjalankan efek yang dilarang oleh kontraknya. | **PROVEN** | Terbatas pada 16 `LOCAL_READONLY_TOOL_NAMES`; network read ditolak tanpa prompt; tulis/bash/MCP/delegasi ditolak; hooks & `--verify` diblokir; `read_memory` & RAG `trackAccess=false` (`access_count` terbukti tetap `0` di `test/work-mode-runtime.test.ts`). |
| **3** | `PLAN` tidak diam-diam menjalankan operasi di luar ceiling-nya. | **PROVEN** | Tulis/bash/MCP/`code_run`/`git_commit`/`write_memory` ditolak; `web_fetch`/`web_search` wajib approval prompt di seluruh 6 PM (headless = `deny`); hooks `.minicode/hooks/*` diblokir di seluruh 6 PM (`test/work-mode-hooks.test.ts`); `--verify` ditolak fail-closed (`test/work-mode-cli.test.ts`). |
| **4** | `EXECUTE` menggunakan `PermissionMode` secara normal. | **PROVEN** | `composeWorkModePermissionHandler` mengembalikan referensi identik `base` (`composed === base`) pada keenam `PermissionMode` (`test/work-mode-contract.test.ts`). |
| **5** | Child agent tidak dapat meningkatkan otoritas dari parent. | **PROVEN** | `delegate_task` mewarisi `subAgentWorkMode()` live ke `SubAgentSpec.workMode` + memotong daftar tool anak + memaksa `permissionMode: "readonly"` pada sesi murni-baca (`explore` child terbukti tidak menaikkan `memory.access_count` di `test/work-mode-subagent.test.ts`). |
| **6** | Resume dan perpindahan surface tidak mengubah otoritas secara diam-diam. | **PROVEN** | `sessions.work_mode` disimpan di SQLite dan dipulihkan saat `--resume` dengan notice `[resume]` eksplisit (`test/cli-setup-coverage.test.ts`); `daemon`, `ACP`, `exec`, one-shot, dan TUI menghormati `WorkMode` secara konsisten + `exec` memperingatkan flag setelah prompt (`test/work-mode-cli.test.ts`). |
| **7** | Tool yang diiklankan sesuai dengan kemampuan runtime (`visible === callable`). | **PROVEN** | `DISCUSS` = 16 visible/callable; `PLAN × {readonly, allowlist}` = 18 visible/callable (`G5` tertutup); `PLAN × lainnya` = 21 visible/callable; `liveRegistry` di `executor.ts` menutup `G1` pada transisi runtime dua arah (`test/work-mode-tool-visibility.test.ts`, `test/work-mode-runtime.test.ts`). |
| **8** | Semua jalur eksekusi, termasuk hooks dan verify, tunduk pada kebijakan mode yang berlaku. | **PROVEN** | `shouldRunHooks` + `runHooksGated` (memakai `permissions?.getMode()` live) menahan `DISCUSS` & `PLAN` serta `PM ∈ {readonly, plan}`; `--verify` ditolak `exit 2` saat startup di `DISCUSS`/`PLAN` dan otomatis di-skip beserta self-heal & auto-memory saat transisi runtime (`test/work-mode-hooks.test.ts`, `test/work-mode-cli.test.ts`). |

---

## 10. Rekomendasi Kelanjutan ke P1

1. **Putuskan Checkpoint Terlebih Dahulu (Pra-Sesi 2):** Kami merekomendasikan pemilik menyetujui **Opsi C1** (§2.5) — bersihkan 25 file log/probe sementara Kelompok U3, lalu buat commit atomik P0 sebelum memulai Sesi 2 (P1) agar fondasi kontrak `WorkMode` dan `sessions.work_mode` terkunci sebagai baseline Git yang bersih dan mudah diaudit.
2. **Fokus Sesi 2 (P1) Setelah P0 Di-checkpoint:**
   - Memverifikasi secara menyeluruh perubahan `W-PRE-P1A` dan `W-PRE-P1B` yang sudah berada di working tree terhadap sisa gap yang diidentifikasi dalam `docs/audit/P0_P2_BASELINE_REASSESSMENT_2026-11-04.md` (antara lain integrasi produksi *approval binding* pada jalur tool selain broker daemon, kelengkapan rekonsiliasi memori pada startup/CLI, dan *edge cases* observabilitas TUI/PTY), tanpa membuka ulang kontrak dasar tiga `WorkMode` yang telah dikunci pada P0 ini.
