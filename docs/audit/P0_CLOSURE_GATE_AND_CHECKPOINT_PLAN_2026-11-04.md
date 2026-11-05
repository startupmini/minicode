# Laporan Penutupan P0: Hasil Full Repository Gates, Klasifikasi Kegagalan, Manifest Artefak, dan Rencana Checkpoint C1 (2026-11-04)

**Sesi:** SESSION 1 — Penutupan P0 (`P0 Closure: Full Gate Verification & C1 Checkpoint Mapping`)
**Tanggal:** 2026-11-04 (WIB / UTC+7)
**Repository root:** `D:/Github/minicode`
**Branch:** `main` (`ahead 1` dari `origin/main`) · **Package version:** `0.13.1` (`v0.13.1-1-gcb60212`)
**Commit HEAD:** `cb602124571d8e4638bdb47d38400c52d8fba976` (parent: `57c59d363b3f7bafca07c050992f6ffccb227463` = `origin/main` = `tag: v0.13.1`)
**Platform pengujian:** Windows x64 (`Microsoft Windows NT 10.0.26340.0` / `win32`) · Bun `1.4.3` (`c6da4a4d3`)
**Laporan pendahulu:** `docs/audit/P0_FOUNDATION_HARDENING_REPORT_2026-11-04.md`, `docs/audit/P0_P2_BASELINE_REASSESSMENT_2026-11-04.md`

> **Kepatuhan ketat terhadap instruksi pemilik:**
> 1. **Tidak ada `git add`/stage, `git commit`, `git push`, maupun perubahan branch** (Opsi `C1` disiapkan sebagai peta file & hunk diff siap-pakai).
> 2. **Tidak ada penghapusan berkas apa pun** — seluruh `25` artefak log/probe sementara di root dipertahankan utuh (`0` byte berubah) dan didokumentasikan kategorinya di §5.
> 3. **Tidak ada perbaikan source otomatis** saat menemukan kegagalan gate — working tree pasca-gate (`t_gate_post`) **100% bit-for-bit identik** dengan pra-gate (`t_gate_pre`).

---

## 1. Executive Verdict Penutupan P0

| Gate / Deliverable | Perintah | Exit Code | Status | Ringkasan & Klasifikasi Akar Penyebab |
|---|---|---:|---|---|
| **Gate 1 — Full Test Suite** | `bun test` | `1` | **FAIL (`2` fail di `344` berkas; terputus di `tui-signal.test.ts`)** | **1 regresi sejati `Perubahan P0 (W-S1-P0.2)`** di `cli/tui.ts` (`F-GATE-1`: duplikasi `/mode /work-mode` pada `/help` memotong `/lang` di kolom 80 pada `test/tui-lang.test.ts:147`), yang memicu **1 kegagalan kaskade** di `test/tui-signal.test.ts:88` + `process.exit(129)` dini di `:110` (`F-GATE-2`, akibat `TuiApp` bocor dari `tui-lang.test.ts` baseline tanpa `try/finally`). Uji baca-saja terpisah pada `23` berkas sisa (`tui-signal..writer-inventory`) lulus **`345 pass / 0 fail`**. Total seluruh `366` berkas repo: **`5.425 pass`, `20 skip`, `1` regresi akar**. |
| **Gate 2 — Coverage Gate** | `bun run gate:coverage` | `1` | **FAIL (terputus sebelum tabel `'All files'`)** | **Kaskade langsung dari `F-GATE-1` + `F-GATE-2`**: `bun test --coverage` ikut terhenti oleh `process.exit(129)` pada `test/tui-signal.test.ts:110` sebelum Bun mencetak tabel agregat `'All files'`. |
| **Gate 3 — Package Budget & Integrity** | `bun run gate:pack` | `1` | **FAIL (`22 pass · 1 fail`: `3854 KB` vs `< 3840 KiB`)** | **Akumulasi ukuran payload sah lintas-gelombang (`Perubahan sebelumnya W-PRE-P1A/P1B ~+90 KiB` + `Perubahan P0 ~+30 KiB` di atas `HEAD=3736 KB`)** (`F-GATE-3`, selisih `+14 KB`). `0` berkas sampah/test/rahasia bocor ke tarball. **Checkpoint `C1-1 (P0 saja)` berukuran `~3.766 KB` (`74 KB` di bawah batas `3.840 KiB` — LULUS).** |
| **Gate 4 — Deterministic Harness Audit** | `bun run audit:harness` | `0` | **PASS (`60 pass, 0 fail, 2 advisories`)** | Seluruh matriks safety jail `6 PermissionMode`, bash guard (`bypassRate=0.000`), budget matrix, dan `scope/explore` (`12` tool read-only tanpa tool tulis) hijau penuh. |
| **Rencana Checkpoint `C1`** | Pemetaan file + hunk diff (`P0`, `P1`, `Dokumentasi`) | — | **READY (UNSTAGED)** | Seluruh `76` berkas tracked modified + `46` berkas untracked dipetakan habis tanpa celah (§4): `C1-1 (P0)`, `C1-2 (P1)`, `C1-3 (Dokumentasi)`, dan `25` artefak dipertahankan di luar staging. |
| **Status Penutupan P0** | — | — | **HOLD FOR 1-LINE P0 FIX & STAGING APPROVAL** | Sesuai larangan auto-fix, P0 **belum diklaim hijau penuh pada full repo gate** sebelum pemilik mengizinkan perbaikan 1 baris deduplikasi `helpConcise()` di `cli/tui.ts` dan re-verifikasi `bun test` + `bun run gate:coverage`. |

---

## 2. Sidik Jari Pra-Gate (`t_gate_pre`), Pasca-Gate (`t_gate_post`), dan Isolasi Proses

### 2.1 Pemeriksaan Proses Aktif Selama Pengujian
- **Pra-gate (`2026-11-04T17:56:38+07:00`):** `0` proses `bun`, `git`, atau `minicode` aktif. Hanya terdapat 2 proses sistem `node.exe` milik `9router` (`PID 2392`, `PID 23996`) di luar repository.
- **Pasca-gate (`2026-11-04T18:33:42+07:00`):** `0` proses `bun`, `git`, atau `minicode` aktif di `D:/Github/minicode`. Terdapat dev server terpisah `astro dev` di workspace lain (`D:\Github\startupmini`, `PID 16084/28112/2872`) yang tidak menyentuh `D:/Github/minicode`.

### 2.2 Perbandingan Sidik Jari Deterministik SHA-256

| Komponen Sidik Jari | Pra-Gate (`t_gate_pre` — 17:56:38 WIB) | Pasca-Gate (`t_gate_post` — 18:33:42 WIB) | Pasca-Laporan Penutupan (`t_closure`) |
|---|---|---|---|
| `HEAD` | `cb602124571d8e4638bdb47d38400c52d8fba976` | `cb602124571d8e4638bdb47d38400c52d8fba976` | `cb602124571d8e4638bdb47d38400c52d8fba976` |
| Staged count | `0` | `0` | `0` |
| Tracked modified count | `76` | `76` | `76` |
| Untracked file count | `45` | `45` | `46` (`t_gate_post` + laporan ini) |
| `STATUS_UALL_SHA256` | `6ac34d4f8a6d890b4c81255d3803144409f5ca8be1b2f85ad540217100cff1ac` | `6ac34d4f8a6d890b4c81255d3803144409f5ca8be1b2f85ad540217100cff1ac` | *(berubah hanya karena `+1` baris laporan baru ini)* |
| `STAGED_DIFF_SHA256` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `UNSTAGED_DIFF_SHA256` | `7a657379affc6f9da576db3a82ff856ac46cc36d3eacb6cdf3a4a7698fd46eef` | `7a657379affc6f9da576db3a82ff856ac46cc36d3eacb6cdf3a4a7698fd46eef` | `7a657379affc6f9da576db3a82ff856ac46cc36d3eacb6cdf3a4a7698fd46eef` |
| `UNTRACKED_SHA256` | `37fa060728c673028226115310327d975f24726ddc1464113c393add4642e027` | `37fa060728c673028226115310327d975f24726ddc1464113c393add4642e027` | *(dicatat pada pengantar penyerahan ke pemilik)* |
| `COMPOSITE_SHA256` | `c1908ffc96d16192096daf5c8d1afb7f445ab0bc194292b471500bb614d709cc` | `c1908ffc96d16192096daf5c8d1afb7f445ab0bc194292b471500bb614d709cc` | *(dicatat pada pengantar penyerahan ke pemilik)* |

**Penjelasan perubahan selama pengujian (`t_gate_pre` → `t_gate_post`):** **NOL perubahan (`0` byte).** Keempat gate tidak meninggalkan direktori `coverage/`, `.tgz`, `.tmp-*`, ataupun modifikasi berkas di dalam repository. Selisih `t_gate_post` → `t_closure` semata-mata adalah pembuatan satu berkas laporan baru ini (`docs/audit/P0_CLOSURE_GATE_AND_CHECKPOINT_PLAN_2026-11-04.md`).

---

## 3. Bukti Eksekusi Full Repository Gates & Klasifikasi Kegagalan

### 3.1 Ringkasan Eksekusi Perintah Gate

1. **Gate 1 — Full Suite:**
   - **Command:** `bun test`
   - **Exit code:** `1`
   - **Platform:** `win32 x64` (`Microsoft Windows NT 10.0.26340.0`), Bun `1.4.3`
   - **Commit / Fingerprint:** `HEAD=cb60212` / `COMPOSITE_SHA256=c1908ffc96d16192096daf5c8d1afb7f445ab0bc194292b471500bb614d709cc`
   - **Jenis test:** gabungan penuh Unit + Integration + Mocked HTTP Provider + Subprocess CLI + PTY (`344` dari `366` berkas test tercapai sebelum proses runner terputus di `test/tui-signal.test.ts:110`: **`5.082 pass`, `2 fail`, `20 skip`**).
   - **Verifikasi suplemen baca-saja pada `23` berkas sisa (`tui-signal.test.ts` s.d. `writer-inventory.test.ts`):**
     - **Command:** `bun test test/tui-signal.test.ts ... test/writer-inventory.test.ts` (`23` berkas)
     - **Exit code:** `0` — **`345 pass`, `0 fail`, `2.754 expect()`** (`13.14s`). Membuktikan seluruh `22` berkas di belakang `tui-signal.test.ts` bebas error dan `tui-signal.test.ts` sendiri hijau ketika tidak terdampak kebocoran listener dari `tui-lang.test.ts`.

2. **Gate 2 — Coverage Gate:**
   - **Command:** `bun run gate:coverage` (`bun scripts/coverage-gate.ts` → `bun test --coverage --reporter dots --timeout 30000`)
   - **Exit code:** `1`
   - **Platform & Fingerprint:** sama dengan Gate 1 (`c1908ffc...`)
   - **Jenis test:** Full suite ber-instrumentasi cakupan baris/fungsi + pemeriksaan lantai `19` modul kritis.
   - **Hasil:** `0` kegagalan sebelum `test/tui-lang.test.ts:147`, lalu mengalami urutan kegagalan yang persis sama (`tui-lang.test.ts:147` → `tui-signal.test.ts:88` → `process.exit(129)` dini di `tui-signal.test.ts:110`), sehingga tabel `'All files'` tidak sempat tercetak oleh Bun.

3. **Gate 3 — Package Distribution & Size Budget Gate:**
   - **Command:** `bun run gate:pack` (`bun scripts/pack-check.ts` → `npm pack --dry-run --json`)
   - **Exit code:** `1`
   - **Platform & Fingerprint:** sama dengan Gate 1 (`c1908ffc...`)
   - **Jenis pemeriksaan:** Audit graf impor runtime (`295` berkas terkemas), kelengkapan `vendor/minicore`, larangan kebocoran rahasia/DB/test/artefak, validasi tautan relatif `.md`, dan batas `PACK_SIZE_BUDGET_KIB = 3840` (`3,75 MiB`).
   - **Hasil:** **`22 pass · 1 fail`** — gagal tunggal pada cek ukuran unpacked: **`3.854 KB` (`3.946.104 B`) vs batas `< 3.840 KiB` (`+14 KB` di atas ambang)**.

4. **Gate 4 — Deterministic Safety Harness Audit:**
   - **Command:** `bun run audit:harness` (`bun bench/harness-audit.ts`)
   - **Exit code:** `0`
   - **Platform & Fingerprint:** sama dengan Gate 1 (`c1908ffc...`)
   - **Jenis test:** Audit deterministik matriks izin/jail `6 PermissionMode`, korpus `inspectBashCommand`, matriks anggaran `budgetStatus`, dan invarian scope `explore`.
   - **Hasil:** **`60 pass, 0 fail, 2 advisories`** (hijau penuh).

---

### 3.2 Klasifikasi Detail Setiap Kegagalan Gate

| ID | Lokasi / Gate | Kategori Asal Kegagalan | Akar Penyebab Teknis & Bukti | Perbaikan Presisi (Menunggu Izin Pemilik) |
|---|---|---|---|---|
| **F-GATE-1** | `test/tui-lang.test.ts:147` (`bun test` & `gate:coverage`): `/help ringkas memuat semua perintah terdaftar` | **Perubahan P0 (`W-S1-P0.2`)** | Pada Sesi 1, `cli/tui.ts:57-58` menambahkan `"/mode"` dan `"/work-mode"` ke `DRIVER_COMMANDS` agar keduanya muncul di dropdown *slash-completion* (`suggestions()`). Namun `DRIVER_HELP_COMMANDS` di `cli/commands.ts:148-149` **sudah** memuat `mode` dan `work-mode`. Akibatnya `helpConcise()` (`cli/tui.ts:374`: `[...DRIVER_COMMANDS, ...DRIVER_HELP_COMMANDS.map(...)]`) mencetak `/mode /work-mode /mode /work-mode` dua kali, mendorong token `/lang` tepat melewati batas lebar terminal `80` kolom menjadi `/l\r\nang`, sehingga `expect(out, "/lang").toContain("/lang")` gagal. | Deduplikasi satu sumber pada `helpConcise()` di `cli/tui.ts:374`: `[...new Set([...DRIVER_COMMANDS, ...DRIVER_HELP_COMMANDS.map((b) => \`/\${b.name}\`)])].join(" ")`. |
| **F-GATE-2** | `test/tui-signal.test.ts:88` (`exits` `[143, 143]`) + terminasi runner dini di `:110` (`bun test` & `gate:coverage`) | **Kaskade dari `F-GATE-1` (`Perubahan P0`) + Kerapuhan Hygiene Test di `Baseline yang sudah ada` (`HEAD=cb60212`)** | Saat `test/tui-lang.test.ts:147` melempar error sebelum baris `148` (`await tty.send("/exit")`), `afterEach` di `test/tui-lang.test.ts:39` tidak menghentikan `runTui()`, sehingga instance `TuiApp` tetap hidup di proses Bun dengan listener `process.on("SIGTERM")` (`exit 143`) dan `process.on("SIGHUP")` (`exit 129`) masih menempel. Saat `test/tui-signal.test.ts:83` memancarkan `SIGTERM`, **dua** listener menembak (`[143, 143]`). Lalu pada baris `110` (`process.emit("SIGHUP")` sebelum `stubExit()` di baris `115`), listener `TuiApp` bocor memanggil `process.exit(129)` asli dan mematikan proses `bun test` / `gate:coverage`. Terbukti: saat `tui-signal.test.ts` dijalankan tanpa kebocoran `tui-lang.test.ts`, kedua test lulus `100%` (`25.83ms` & `18.80ms`). | Selesai otomatis begitu `F-GATE-1` diperbaiki; sebagai pengerasan opsional test hygiene, bungkus `runTui` di `test/tui-lang.test.ts` dengan `try { ... } finally { ... /exit }` agar kegagalan asersi TUI di masa depan tidak pernah membocorkan handler sinyal proses. |
| **F-GATE-3** | `bun run gate:pack` (`scripts/pack-check.ts:248`): `3854 KB` vs budget `< 3840 KiB` | **Akumulasi Lintas-Gelombang: `Perubahan sebelumnya` (`W-PRE-P1A/P1B` `~+90 KiB`) + `Perubahan P0` (`W-PRE-P0 + W-S1-P0.2` `~+30 KiB`) di atas `HEAD=cb60212` (`~3.736 KB`)** | Pada `HEAD=cb60212`, ukuran unpacked dari `293` berkas terkemas adalah `3.823.751 B` LF (`~3.736 KB` di Windows, masih `104 KB` di bawah `3.840 KiB`). Gelombang pra-sesi `W-PRE-P1A` + `W-PRE-P1B` menambahkan `2` file baru di `src/` (`src/ui/session-state.ts` `+9.183 B`, `src/policy/approval-binding.ts` `+7.489 B`) serta ekspansi besar di `src/memory/vector.ts` (`+9.492 B`), `src/policy/permission.ts` (`~+9.850 B`), `src/presentation/*` (`+19.131 B`), `src/daemon/*` (`+7.035 B`), dan `src/ui/*` (`+10.500 B`) — total `P1` pra-sesi menyumbang **`~+90 KiB`** sehingga pada `t0` ukuran sudah mencapai **`~3.839 KB`** (`<1 KB` dari batas!). Penambahan kontrak P0.2 di Sesi 1 (`~+14,5 KiB` termasuk persistensi `sessions.work_mode`, `work-mode.ts`, `executor.ts`, `daemon.ts`, dan klausul I35 `TERMINAL_CONTRACT.md`) mendorong total gabungan `P0 + P1` menjadi **`3.946.104 B` (`3.854 KB`, `+14 KB` di atas batas)**. Tidak ada file test, log sementara, atau `docs/audit/*` yang terbawa ke tarball. | **Untuk P0 (`Checkpoint C1-1`):** tanpa modul `P1`, ukuran paket P0 hanya **`~3.766 KB` (`< 3.840 KiB`, LULUS `gate:pack`)**. **Saat memasuki P1 (`Checkpoint C1-2`):** pemilik dapat memilih merampingkan komentar/kode duplikat `~15 KiB` di modul P1 atau menyetujui re-baseline terukur di `scripts/pack-budget.ts`. |

---

## 4. Pemetaan File dan Diff untuk Strategi Checkpoint `C1` (Tanpa Stage / Tanpa Commit)

Sesuai keputusan pemilik (**Opsi C1**), seluruh `122` entri perubahan di working tree (`76` tracked modified + `46` untracked termasuk laporan ini) dipetakan ke dalam **3 Checkpoint Git terpisah** ditambah **1 himpunan artefak yang dipertahankan di luar Git (`25` berkas)**.

### Ringkasan Rekonsiliasi Kuantitatif Pemetaan `C1`

| Kelompok Target | Tracked Pure | Tracked Mixed (`git add -p`) | Untracked Baru | Total Berkas Terkait |
|---|---:|---:|---:|---:|
| **Checkpoint `C1-1` — P0 Foundation & WorkMode Contract** | `21` | `8` *(hunk P0 saja)* | `1` | `30` berkas |
| **Checkpoint `C1-2` — P1 Presentation, Approval Binding & Reliability** | `44` | `8` *(sisa hunk P1)* | `8` | `60` berkas |
| **Checkpoint `C1-3` — Dokumentasi & Audit Trail** | `3` | `0` *(seluruh `docs/*` disatukan)* | `12` | `15` berkas |
| **Dipertahankan Unstaged / Uncommitted (Keputusan #2)** | `0` | `0` | `25` | `25` berkas |
| **Total Unik di Working Tree (`76` M + `46` `??`)** | **`68` pure** | **`8` mixed** (`68+8 = 76` M) | **`46` `??`** (`1+8+12+25 = 46`) | **`122` entri unik** |

---

### 4.1 Checkpoint `C1-1` — P0 Foundation & WorkMode Contract
*Kandidat pesan commit kelak (setelah diizinkan):* `feat(policy): enforce P0 WorkMode contract and session work_mode persistence`

#### A. Berkas Tracked Murni P0 (`21` berkas — stage utuh per berkas)
1. `cli/args.ts` (`+50 / -2`) — parser `--work-mode`, `parseWorkModeValue`, `flagsAfterPromptBoundary`.
2. `cli/commands/daemon.ts` (`+44 / -5`) — `--work-mode` / `MINICODE_WORK_MODE`, fail-closed `--verify`, ekspos `HostedSessionInfo.workMode`.
3. `cli/commands/exec.ts` (`+38 / -7`) — `VerifyWorkModeConflictError` exit `2` + JSON `USER_ERROR`, warning `flagsAfterPromptBoundary`, baris stderr `[work-mode]`, `summary.workMode`.
4. `src/app/tool-layer.ts` (`+64 / -60`) — kesetaraan `visible === callable` (`16` di `DISCUSS`, `18` di `PLAN × {readonly,allowlist}`, `21` di `PLAN` lainnya) + `setPermissionMode`.
5. `src/daemon/control.ts` (`+2 / -0`) — field `workMode` pada `HostedSessionInfo`.
6. `src/hooks/run.ts` (`+5 / -1`) — `shouldRunHooks` memblokir `DISCUSS` & `PLAN` di semua `PermissionMode`.
7. `src/policy/executor.ts` (`+44 / -5`) — `liveRegistry` (penutup `G1`) + injeksi `permissionMode: "readonly"` pada sesi murni-baca (`G-MEM-TRACK`).
8. `src/policy/tool-contract.ts` (`+77 / -0`) — `allowedInReadonly`, `READONLY_TOOL_NAMES` (`18`), `LOCAL_READONLY_TOOL_NAMES` (`16`), `NETWORK_READ_TOOL_NAMES` (`2`).
9. `src/policy/work-mode.ts` (`+49 / -1`) — `VerifyWorkModeConflictError`, blokir network read di `DISCUSS`, wajib `__promptGated` di `PLAN`.
10. `src/tools/task.ts` (`+7 / -1`) — propagasi live `setSubAgentWorkMode` / `subAgentWorkMode`.
11. `test/cli-args.test.ts` (`+37 / -1`)
12. `test/cli-setup-coverage.test.ts` (`+88 / -0`)
13. `test/helpers/work-mode-matrix.ts` (`+148 / -27`)
14. `test/p15-phase2-contracts-approval-recovery.test.ts` (`+41 / -0` — uji no-drift `READONLY_TOOL_NAMES`)
15. `test/work-mode-cli.test.ts` (`+352 / -0`)
16. `test/work-mode-contract.test.ts` (`+190 / -8`)
17. `test/work-mode-hooks.test.ts` (`+40 / -36`)
18. `test/work-mode-runtime.test.ts` (`+159 / -18`)
19. `test/work-mode-subagent.test.ts` (`+40 / -0`)
20. `test/work-mode-tool-visibility.test.ts` (`+101 / -74`)
21. `test/writer-inventory.test.ts` (`+31 / -3` — kuota writer P0 untuk `cli/index.ts`, `cli/setup.ts`, `cli/commands/exec.ts`)

#### B. Berkas Untracked Murni P0 (`1` berkas)
22. `test/work-mode-prompt.test.ts` (`6.251 B` — uji `workModeHint` & penyegaran `StreamRequest.system` per-turn `G-PROMPT-RT`).

#### C. Pemetaan Hunk Diff pada `8` Berkas Campuran (`P0` vs `P1`)
Untuk menjaga agar `C1-1` dapat dikompilasi (`tsc --noEmit`), lulus Biome (`bun run lint`), dan lulus seluruh test secara mandiri tanpa bergantung pada file baru `C1-2` (`src/policy/approval-binding.ts` & `src/ui/session-state.ts`), pemisahan hunk (`git add -p`) adalah sebagai berikut:

| # | Berkas Campuran | Hunk untuk `C1-1 (P0)` | Hunk untuk `C1-2 (P1)` | Catatan Keamanan Kompilasi / Lint |
|---:|---|---|---|---|
| 1 | `cli/commands/acp.ts` | `@@ -121,5 +122,9 @@` (fallback `MINICODE_WORK_MODE`), `@@ -459,2 +473,3 @@` (`result.workMode`) | `@@ -37,2 +37,3 @@` (komentar `task.status`), `@@ -260,2 +265,11 @@` (`projectAcpLifecycle` `task.status`) | Independen penuh; tidak ada simbol lintas-hunk. |
| 2 | `cli/index.ts` | `@@ -9,2 +9,3 @@` (`VerifyWorkModeConflictError`), `@@ -24,2 +25,3 @@` (`flagsAfterPromptBoundary`), `@@ -92,3 +94,3 @@` (`/work-mode` di `HELP`), `@@ -290,2 +292,6 @@` (`workModeExplicit`), `@@ -428,2 +434,12 @@` (`ignoredFlags`), `@@ -519,2 +535,4 @@` (`workModeExplicit`), `@@ -540,5 +558,5 @@` (exit `2`), `@@ -555,2 +573,9 @@` (`[work-mode]` stderr) | `@@ -19,3 +20,3 @@` (hapus impor `takePendingError`), `@@ -634,3 +659,3 @@` (`ctx.uiState.takePendingError()`) | Kuota `writer-inventory.test.ts` (`max: 31`) tetap cocok di `C1-1` maupun `C1-2` karena hunk P1 tidak mengubah jumlah writer. |
| 3 | `cli/setup.ts` | `14` hunk WorkMode/verify/resume: `@@ -49` (`VerifyWorkModeConflictError`), `@@ -158` & `@@ -162` (`load/saveSessionWorkMode`), `@@ -268` (`workModeExplicit`), `@@ -768` & `@@ -838` (`effectiveWorkMode` + tolak `--verify`), `@@ -1071` (RAG `trackAccess`), `@@ -1108` (`[resume] WorkMode` stderr), `@@ -1614`..`@@ -1721` (`setPermissionMode`, `effectiveWorkMode`, `saveSessionWorkMode`), `@@ -2160` (`setCompletionEvidence` live guard), `@@ -2323`..`@@ -2328` (`runHooksGated` live guard), `@@ -2518` (`runPromptWithVerify` runtime skip), `@@ -2716` (`saveSession` `workMode`), `@@ -3215` (getter `workMode`) | `13` hunk P1 observability & `UiSessionState`: `@@ -223` (`UiSessionState`), `@@ -363` (`contextWindowTokens`), `@@ -369` (`uiState`), `@@ -577`..`@@ -715` (`toPresentationEvent`), `@@ -775` (`new UiSessionState()`), `@@ -1465`..`@@ -1511` (`childSessionId`/`task.status`), `@@ -2262` (`noteConsequenceDecided`), `@@ -2286`..`@@ -2294` (`noteTaskStatus`), `@@ -2437`..`@@ -2467` (`noteContextCutoff`/`Window`), `@@ -2640` (`uiState`), `@@ -3223` (`contextWindowTokens` & `uiState`) | Pada hunk terakhir (`@@ -3215` vs `@@ -3223`), pastikan `uiState` & `contextWindowTokens` tetap di `C1-2` karena `UiSessionState` berasal dari file baru `src/ui/session-state.ts` milik `C1-2`. |
| 4 | `cli/tui.ts` | `@@ -59,3 +51,10 @@` (`DRIVER_COMMANDS` menambah `"/mode"`, `"/work-mode"` **beserta perbaikan 1-baris `F-GATE-1` pada `helpConcise()` bila diizinkan pemilik**) | `14` hunk lainnya: migrasi `UiSessionState` (`@@ -26`, `@@ -34`, `@@ -125`, `@@ -131`, `@@ -148`, `@@ -364`, `@@ -464`..`@@ -510`, `@@ -617`..`@@ -621`) + `fmtUsageMetrics` (`@@ -69`, `@@ -594`) | Hunk P0 murni mandiri dari `UiSessionState`. |
| 5 | `src/app/session.ts` | `6` hunk P0: `@@ -2` (`ModelProvider`), `@@ -73` (`workModeHint`), `@@ -162` (`PLAN_PM_HINT` + `baseSystem`), `@@ -252` & `@@ -263` (`isAllToolsPureRead`), `@@ -328` & `@@ -356` (`computeLiveSystem`, `dynamicProvider`, `liveToolSchemas`) | `6` hunk P1: `@@ -7` & `@@ -14` (impor `ApprovalBindingStore`, `verifyApprovalBinding`, `canonicalArgsHash`), `@@ -106`, `@@ -191`, `@@ -194`, `@@ -239` (`approvalBindings`), `@@ -280` (`staleDenyReasons` & verifikasi barrier) | Wajib pisah bersih karena hunk P1 mengimpor `../policy/approval-binding.ts` (berkas baru di `C1-2`). |
| 6 | `src/policy/permission.ts` | `4` hunk P0: impor `GATED_TOOLS, READONLY_TOOL_NAMES` dari `./tool-contract.ts` (`@@ -16`, `@@ -86`), penggantian `const READONLY_TOOLS = READONLY_TOOL_NAMES` (`@@ -30..50`), serta metode & tipe `__promptGated` (`@@ -511`, `@@ -516`) | `12` hunk P1: impor `SideEffectTierDisplay`, `ApprovalBinding*`, `scrubSecrets`, `contractForTool` (`@@ -3`, `@@ -16`), `riskTier`/`diffPreview` & `buildDiffPreview` (`@@ -30`, `@@ -159`), serta alur `approvalBindings`/`stale` (`@@ -171`..`@@ -337`, `@@ -557`..`@@ -646`) | Saat edit hunk impor `@@ -16` di `C1-1`, jangan sertakan `contractForTool` agar Biome `noUnusedImports` tetap hijau pada `C1-1`. |
| 7 | `src/session/persistence.ts` | `8` hunk P0: `@@ -36` (cek migrasi `sessions.work_mode`), `@@ -182` & `@@ -216` (DDL & `ALTER TABLE sessions ADD COLUMN work_mode`), `@@ -1034` & `@@ -1050` (`saveSession` `workMode`), `@@ -1370` (`loadSessionWorkMode` / `saveSessionWorkMode`), `@@ -1373`..`@@ -1397` (`loadSession` `workMode`) | `2` hunk P1: `@@ -694` (`TASK_STATUS_DISPLAY`) & `@@ -754` (validasi event `consequence.decided`, `context.cutoff`, `task.status`) | Kolom `daemon_approvals.invocation_id` pada `@@ -36` sudah ada di `HEAD=cb60212`, sehingga hunk `@@ -36` aman penuh di `C1-1`. |
| 8 | `src/tools/memory.ts` | `2` hunk P0: `@@ -9` (`import { subAgentWorkMode } from "./task.ts"`) & `@@ -29` (`trackAccess = ... && subAgentWorkMode() === "EXECUTE"`) | `6` hunk P1: `@@ -1` & `@@ -6` (impor helper rekonsiliasi/supersession), `@@ -36` & `@@ -80` (`[id:...]`), `@@ -172`..`@@ -230` (validasi `supersedes_id`, tag provenance, `deleteMemoryEntry`, `vectorNote`) | Hunk P1 bergantung pada fungsi baru di `src/memory/files.ts` & `src/memory/vector.ts` milik `C1-2`; pemisahan ini membuat `C1-1` mandiri penuh. |

---

### 4.2 Checkpoint `C1-2` — P1 Presentation Observability, Approval Binding & Reliability
*Kandidat pesan commit kelak (setelah P1 dituntaskan & diizinkan):* `feat(presentation,policy,memory): complete P1 observability, approval binding, and memory consistency`

- **`44` Berkas Tracked Murni P1:**
  - **CI (`1`):** `.github/workflows/ci.yml`
  - **CLI (`1`):** `cli/commands/memory.ts`
  - **Daemon (`5`):** `src/daemon/approvals.ts`, `src/daemon/client.ts`, `src/daemon/protocol.ts`, `src/daemon/server.ts`, `src/daemon/subscription.ts`
  - **Memory (`2`):** `src/memory/files.ts`, `src/memory/vector.ts`
  - **Presentation (`5`):** `src/presentation/adapter.ts`, `src/presentation/events.ts`, `src/presentation/model.ts`, `src/presentation/projection.ts`, `src/presentation/reducer.ts`
  - **UI (`11`):** `src/ui/approval/prompt.ts`, `src/ui/assistant/simple.ts`, `src/ui/contract.ts`, `src/ui/footer.ts`, `src/ui/i18n/en.ts`, `src/ui/i18n/id.ts`, `src/ui/render/collapse.ts`, `src/ui/render/detail.ts`, `src/ui/render/reasoning.ts`, `src/ui/tui/app.ts`, `src/ui/tui/transcript.ts`
  - **Test (`19`):** `test/approval-tui.test.ts`, `test/cli-session.test.ts`, `test/collapse.test.ts`, `test/coverage-gaps.test.ts`, `test/hardening-boundary.test.ts`, `test/helpers/tui-harness.ts`, `test/p2-daemon.test.ts`, `test/p20-phase8-supersession-mcp-pin-and-tasksync.test.ts`, `test/p21-phase9-ace-ablation-splitbrain-and-ci.test.ts`, `test/p24-phase12-audit3-deep-bugs-and-security.test.ts`, `test/presentation-bridge.test.ts`, `test/presentation-events.test.ts`, `test/presentation-linear-acp.test.ts`, `test/presentation-policy.test.ts`, `test/presentation-projections.test.ts`, `test/pty.test.ts`, `test/sanitize-render.test.ts`, `test/terminal-contract.test.ts`, `test/tui-format.test.ts`
- **`8` Berkas Campuran (sisa hunk P1 pada tabel §4.1.C):** `cli/commands/acp.ts`, `cli/index.ts`, `cli/setup.ts`, `cli/tui.ts`, `src/app/session.ts`, `src/policy/permission.ts`, `src/session/persistence.ts`, `src/tools/memory.ts`.
- **`8` Berkas Untracked Baru P1:**
  - `src/policy/approval-binding.ts`, `src/ui/session-state.ts`, `test/approval-integrity.test.ts`, `test/ci-glob-expansion.test.ts`, `test/daemon-stream-phase.test.ts`, `test/memory-consistency.test.ts`, `test/presentation-observability.test.ts`, `test/ui-instance-isolation.test.ts`.

---

### 4.3 Checkpoint `C1-3` — Dokumentasi & Laporan Audit
*Kandidat pesan commit kelak (setelah diizinkan):* `docs(contract,audit): update terminal/CLI docs and record P0-P1 audit trail`

- **`3` Berkas Dokumentasi Tracked:**
  1. `docs/TERMINAL_CONTRACT.md` (`+91 / -24` — memuat `3` hunk kontrak P0 I35 & peta test `work-mode-*.test.ts` serta `5` hunk kontrak P1 `F-AGENT-1`/`F-TASK-1`/PROMPT 06; catatan: bila pemilik menghendaki aturan dokumen kontrak ikut dengan kode per-fase, ke-`3` hunk I35 `@@ -321`, `@@ -335`, `@@ -459` juga dapat dimasukkan langsung ke `C1-1`).
  2. `docs/cli.md` (`+1 / -0`)
  3. `docs/memory-sessions.md` (`+5 / -0`)
- **`12` Berkas Laporan Audit Untracked (`1` di root + `11` di `docs/audit/`):**
  1. `CODE_QUALITY_AUDIT_2026-11-04.md`
  2. `docs/audit/UI_UX_PRESENTATION_AND_DISCUSS_MODE_DEEP_AUDIT.md`
  3. `docs/audit/LIVE_UAT_HARNESS_0.13.x_REPORT_2026-11-02.md`
  4. `docs/audit/P0_BASELINE_AND_MODE_ARCHITECTURE_CONSOLIDATION.md`
  5. `docs/audit/P1_INTEGRATED_REMEDIATION_REPORT.md`
  6. `docs/audit/P1_COMPLETION_MODE_UX_OBSERVABILITY_REPORT.md`
  7. `docs/audit/P1_OBSERVABILITY_INTERACTION_COMPLETION_REPORT.md`
  8. `docs/audit/P1_REMAINING_SURFACE_COMPLETION_REPORT.md`
  9. `docs/audit/FINAL_INTEGRATION_RELIABILITY_CLOSURE_REPORT.md`
  10. `docs/audit/P0_P2_BASELINE_REASSESSMENT_2026-11-04.md`
  11. `docs/audit/P0_FOUNDATION_HARDENING_REPORT_2026-11-04.md`
  12. `docs/audit/P0_CLOSURE_GATE_AND_CHECKPOINT_PLAN_2026-11-04.md` *(laporan ini)*

---

## 5. Manifest & Kategorisasi `25` Artefak Sementara yang Dipertahankan (`Kelompok U3`)

Sesuai Keputusan Pemilik #2 (**Pembersihan artefak TIDAK DIIZINKAN**), seluruh `25` berkas di bawah ini **dipertahankan 100% utuh** di root working tree, **tidak dimasukkan** ke dalam `C1-1`, `C1-2`, maupun `C1-3`, dan terbukti **tidak ikut terkemas** ke dalam tarball `npm pack` (`package.json` `"files"` memakai daftar putih eksplisit).

| # | Nama Berkas | Ukuran | Waktu Modifikasi (WIB) | SHA-256 (16 hex awal) | Kategori Artefak | Ringkasan Isi |
|---:|---|---:|---|---|---|---|
| 1 | `.tmp-probe.ts` | `867 B` | `2026-11-03 06:06:13` | `8b26070aff03918c` | **`U3-A` — Skrip Probe Debugging** | Skrip eksperimen satu-kali pembanding objek `before`/`after` proyeksi sesi; tidak diimpor modul mana pun. |
| 2 | `a1.txt` | `131 B` | `2026-11-03 05:48:29` | `4cb9f961167b62aa` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `a`. |
| 3 | `a2.txt` | `956 B` | `2026-11-03 05:49:55` | `2b3dfe47b3c01687` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `a`. |
| 4 | `a3.txt` | `103 B` | `2026-11-03 05:51:32` | `e7a2450544f06c09` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `a`. |
| 5 | `a4.txt` | `787 B` | `2026-11-03 05:52:44` | `360b883ac81caf15` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `a`. |
| 6 | `a5.txt` | `635 B` | `2026-11-03 05:52:45` | `1c96265c8ea364f7` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `a`. |
| 7 | `a6.txt` | `787 B` | `2026-11-03 06:02:23` | `0cfe4a625b03f193` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `a`. |
| 8 | `b1.txt` | `106 B` | `2026-11-03 06:13:34` | `c44d70282d68ccdd` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `b`. |
| 9 | `b2.txt` | `272 B` | `2026-11-03 06:13:34` | `c5ed3aabc84b745d` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `b`. |
| 10 | `b3.txt` | `105 B` | `2026-11-03 06:13:34` | `de45f180677029fe` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `b`. |
| 11 | `b4.txt` | `105 B` | `2026-11-03 06:23:05` | `99349dc4fb48f0e8` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `b`. |
| 12 | `b5.txt` | `274 B` | `2026-11-03 06:25:11` | `ebebc0e66faaa79b` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `b`. |
| 13 | `c1.txt` | `494 B` | `2026-11-03 06:50:20` | `503ad0700f63e2f8` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `c`. |
| 14 | `d1.txt` | `102 B` | `2026-11-03 08:13:38` | `9867e9dad4e91fb8` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `d`. |
| 15 | `d2.txt` | `668 B` | `2026-11-03 08:19:27` | `687e45932cf4cca2` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `d`. |
| 16 | `d3.txt` | `668 B` | `2026-11-03 08:33:11` | `8b9918092252350a` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `d`. |
| 17 | `e1.txt` | `1.088 B` | `2026-11-03 08:35:36` | `c4c23d08d65c6b0a` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `e`. |
| 18 | `f1.txt` | `104 B` | `2026-11-03 14:26:18` | `857fd0458031abe9` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `f`. |
| 19 | `f2.txt` | `871 B` | `2026-11-03 14:28:35` | `dddcb3ee78073e32` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `f`. |
| 20 | `g1.txt` | `906 B` | `2026-11-03 16:02:17` | `cb138356306cd129` | **`U3-B` — Log Ringkas `bun test` (2026-11-03)** | Potongan output `bun test v1.4.3` gelombang `g`. |
| 21 | `t.log.txt` | `2.232 B` | `2026-11-02 08:59:39` | `ead72e602f13c2f1` | **`U3-C` — Log & JUnit XML `bun test` (2026-11-02)** | Log teks eksekusi `bun test` sesi 2026-11-02. |
| 22 | `t.log.xml` | `872 B` | `2026-11-02 09:00:07` | `0286a430d90846fc` | **`U3-C` — Log & JUnit XML `bun test` (2026-11-02)** | Pesan error CLI `--reporter=junit requires --reporter-outfile`. |
| 23 | `t.xml` | `12.162 B` | `2026-11-02 09:00:27` | `165696eca0c239c8` | **`U3-C` — Log & JUnit XML `bun test` (2026-11-02)** | Laporan JUnit XML hasil `bun test` sesi 2026-11-02. |
| 24 | `t2.log.txt` | `832 B` | `2026-11-02 09:03:22` | `f8c61d7e8122e80b` | **`U3-C` — Log & JUnit XML `bun test` (2026-11-02)** | Log teks lanjutan `bun test` sesi 2026-11-02. |
| 25 | `t3.log.txt` | `2.228 B` | `2026-11-02 09:03:43` | `191b742da210ab4c` | **`U3-C` — Log & JUnit XML `bun test` (2026-11-02)** | Log teks lanjutan `bun test` sesi 2026-11-02. |

---

## 6. Keputusan Berikutnya yang Dibutuhkan dari Pemilik (Sebelum P1 Dimulai)

1. **Otorisasi perbaikan 1-baris `F-GATE-1` (`cli/tui.ts:374`) + opsional pengerasan `try/finally` di `test/tui-lang.test.ts`:**
   - Mengubah pembentukan baris perintah driver di `helpConcise()` (`cli/tui.ts:374`) agar memakai `new Set(...)` sehingga `/mode` dan `/work-mode` tidak tercetak ganda di `/help`, lalu menjalankan ulang `bun test` penuh dan `bun run gate:coverage` untuk memverifikasi angka cakupan agregat dan `19/19` lantai modul kritis.
2. **Keputusan atas `F-GATE-3` (`bun run gate:pack` = `3.854 KB` vs batas `3.840 KiB`):**
   - Menentukan apakah ke-`+14 KB` kelebihan ukuran gabungan `P0 + P1` akan diselesaikan dengan merampingkan ~`15–20 KiB` komentar/kode berlebih di modul P1 pada Sesi P1 (tanpa mengubah `PACK_SIZE_BUDGET_KIB = 3840`), atau dengan re-baseline resmi yang disetujui pemilik.
3. **Otorisasi eksekusi staging/commit sesuai peta `C1` (§4):**
   - Menentukan kapan `C1-1 (P0)` boleh di-*stage* dan di-*commit* (disarankan segera setelah poin #1 diverifikasi hijau).
