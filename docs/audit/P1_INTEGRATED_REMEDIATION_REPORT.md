# P1 — Integrated Remediation Report (PROMPT 02)

**Branch:** `main` · **Baseline:** `cb60212` (verified `HEAD` before edits)
**Version:** `0.13.1`
**Date:** 2026-11-02
**Scope:** Cross-module remediation unified by root cause, with tests.

> **Status integrasi.** `ROADMAP.md` tidak tersentuh. Seluruh perubahan P1 ini
> adalah **working-tree yang belum di-commit** (tidak ada commit/push/tag).
> Baseline `cb60212` tetap `HEAD`; tidak ada perubahan perilaku arsitektur fase
> (Big Phase P1–P14) yang diklaim dari laporan ini. Status fase dirujuk hanya
> dari `ROADMAP.md` (otoritas owner), bukan dari laporan ini.

---

## 1. Executive summary

Laporan ini menutup temuan P1 dari tiga audit yang tumpang tindih — deep audit
UI/UX/presentation/DISCUSS (`UI_UX_PRESENTATION_AND_DISCUSS_MODE_DEEP_AUDIT.md`),
live UAT harness 0.13.x (`LIVE_UAT_HARNESS_0.13.x_REPORT_2026-11-02.md`), dan
baseline mode architecture consolidation (`P0_BASELINE_AND_MODE_ARCHITECTURE_CONSOLIDATION.md`)
— melalui **satu akar masalah per tema**, bukan per-berkas tambal-sulam.

Akar masalah yang ditutup:

| Tema | Akar masalah | Perbaikan |
|---|---|---|
| Supersession memori setengah-jalan (§7.5) | `supersedes_id` menerima string bebas; id baris tidak pernah diekspos; tombstone `UPDATE … WHERE id=<teks>` no-op diam-diam | validasi + atomik + ekspos id + retrieval mengecualikan baris tertombstone |
| List drift enforcement vs visibility (`F-DISCUSS-3`) | `READONLY_TOOLS` daftar manual 18 nama, terpisah dari registry `allowedInExplore`/tier | `READONLY_TOOLS` **diturunkan** dari `tool-contract.ts` (`allowedInReadonly`) + test no-drift |
| `any` di batas event (`F-TYPE-1`) | `sub(type, (e: any))` melunturkan anotasi call-site | `sub` generik (E diinfer dari handler), satu cast `unknown → E` di tepi |
| UI state menulis `process.env` (`F-ENV-1`) | getter`c`/`glyphs` membeku; state collapse/detail/reasoning menulis `process.env` | getter/setter module-local + bootstrap-from-env; tidak ada tulis env |
| `budget_exceeded`+"context window" → saran `--budget` salah (§8.1) | `projection.ts` mengenai catch-all `budget` | pemetaan `USER_ERROR` + saran sesi-baru/model-jendela-besar sebelum branch `--budget` |
| Flag teraba setelah prompt (§8.3) | `args.ts` stop-pemindaian di token prompt pertama (anti-injeksi) → flag jadi teks diam-diam | peringatan `[warn]` actionable untuk flag dikenal setelah boundary |

**Dijaga (invariant tidak dilanggar):** WorkMode ⊥ PermissionMode tetap
independen; tidak ada self-escalation (perubahan kapabilitas hanya lewat aksi
operator eksplisit); `D-2` non-persistence tidak disentuh; `D-1..D-7`, `K-1`,
I35/kontrak terminal, `INV-WM1/4` utuh (lihat §4).

**Escalated (tidak diputuskan sendiri):** lima keputusan owner (Q1–Q5) tetap
terbuka (§5).

---

## 2. Metode & urutan verifikasi

Perubahan dibuat setelah memverifikasi jangkar kode nyata (bukan asumsi), tiap
tema diverifikasi dengan test nyata (bukan mock `any`), dan gate dijalankan
secara **stage-scoped** — klaim hasil hanya untuk scope yang benar-benar
dieksekusi.

Perintah verifikasi (urutan gate per `AGENTS.md`):

```bash
bun x tsc --noEmit
bun run lint                      # biome check src cli test bench scripts
bun test                          # per-file isolated (bukan gabungan manual)
bun run gate:coverage
bun run gate:pack
```

---

## 3. Perubahan per akar masalah

### 3.1 Supersession memori — integritas (§7.5)

**Berkas:** `src/memory/vector.ts`, `src/tools/memory.ts`.

- `addMemory` kini **memvalidasi `supersedesId`** sebelum menyentuh file/vector:
  id tak dikenal melempar `supersedesId not found in memory store: <id>` dan
  **tidak menyisipkan apa pun** (sebelumnya no-op diam-diam).
- Insert + tombstone dilakukan **atomik** dalam `db.transaction`:
  baris baru `supersedes = oldId`, baris lama `superseded_by = newId` pada
  transaksi yang sama (pola `db.transaction(fn)` yang sama dengan
  `daemon/store.ts` / `task/store.ts`).
- `memoryRowExists(id, cwd?)`: memeriksa keberadaan baris lokal (mirror
  `addMemory` dalam meratakan `.minicode`) agar `write_memory` bisa memvalidasi
  sebelum ada efek.
- **Ekspos id**: `MemoryHit.id` / `MemoryRow.id` kini diisi/dikembalikan;
  `read_memory` mencetak `[id:…]` pada tiap hit sehingga model bisa menyasar id
  nyata (sebelumnya model memakai teks karena id tak pernah muncul).
- `write_memory` memvalidasi `supersedes_id` **up-front** dengan error
  actionable: *"Use `read_memory` to get a real `[id:...]`, or omit
  `supersedes_id`"*.
- Retrieval (`searchHybrid`/keyword) kini **mengecualikan baris dengan
  `superseded_by`** secara default (hanya `includeSuperseded: true` yang
  memunculkannya) — menutup risiko staleness indeks `idx_memory_not_superseded`.

### 3.2 Konsolidasi registry tool + visibility vs enforcement (`F-DISCUSS-3`)

**Berkas:** `src/policy/tool-contract.ts`, `src/policy/permission.ts`.

- Registry `tool-contract.ts` menambah field **`allowedInReadonly`** (baca saja,
  tanpa mutasi workspace/internal state). `bash_output` sengaja `false` (hanya
  bermakna dengan job `bash` yang dilarang readonly); `web_fetch`/`web_search`
  `true` walau bertier `EXTERNAL_IRREVERSIBLE` karena efeknya baca-jaringan,
  bukan mutasi lokal — **mengikuti daftar `READONLY_TOOLS` lama apa adanya
  (konservatif, tanpa mengubah membership)**.
- **`READONLY_TOOLS` di `permission.ts` kini diturunkan** dari
  `READONLY_TOOL_NAMES` (derivasi dari registry) — bukan daftar manual 18 nama
  yang bisa menyimpang. Menambah/mengganti tool read berarti mengubah satu
  tempat (`allowedInReadonly` di registry).
- **Visibility vs enforcement tetap dua hal berbeda**: enforcement (ceiling
  `readonly`/`plan`) = `READONLY_TOOL_NAMES`; visibility sub-agen `explore` =
  `EXPLORE_TOOL_NAMES` (⊂ `allowedInExplore`, 12 tool). Keduanya tidak lagi bisa
  menyimpang secara manual tapi tetap disengaja-tak-sama.

**Evaluasi 6 tool "allowed-but-hidden"** (dalam `READONLY_TOOL_NAMES` tapi
bukan `EXPLORE_TOOL_NAMES`):

| Tool | Tier | Explore? | Readonly? | Evaluasi |
|---|---|---|---|---|
| `read_image` | PURE_READ | ✗ | ✓ | read lokal; disembunyikan dari explore = subset minimal 12 yang konservatif |
| `git_diff` | PURE_READ | ✗ | ✓ | idem |
| `lsp_references` | PURE_READ | ✗ | ✓ | idem |
| `lsp_symbols` | PURE_READ | ✗ | ✓ | idem |
| `web_fetch` | EXTERNAL_IRREVERSIBLE | ✗ | ✓ | baca jaringan; **in/out readonly = milik owner (Q3)** — tidak diubah |
| `web_search` | EXTERNAL_IRREVERSIBLE | ✗ | ✓ | idem |

Membership dipegang test no-drift (§3.7); perubahan ke-6 tool di atas dianggap
**deliberate**, bukan efek samping edit registry.

### 3.3 Proyeksi mesin — pemetaan error konteks (§8.1)

**Berkas:** `src/presentation/projection.ts`.

- `machineError({ kind: "budget_exceeded", message: "…context window exceeded…" })`
  kini memetakan ke `USER_ERROR` dengan action
  `"start a new session or use a model with a larger context window"` —
  **sebelum** branch catch-all `budget` yang menyarankan `--budget`. Meluruskan
  §7.2 (throw `AgentError("budget_exceeded", "context window exceeded after
  compaction")` tidak lagi menyarankan `--budget` yang keliru).

### 3.4 Peringatan flag setelah prompt (§8.3)

**Berkas:** `cli/args.ts`, `cli/index.ts`.

- `flagsAfterPromptBoundary(argv)`: mengembalikan flag *yang dikenal* yang muncul
  setelah token prompt pertama (pertahanan anti-injeksi stop-pemindaian itu
  sendiri tidak diubah — sengaja).
- `cli/index.ts` menulis `[warn] ignored flag(s) after the prompt: …` setelah
  `prompt` ter-resolusi — penting karena stage5 meletakkan prompt paling depan
  sehingga `--resume/--cwd/--allow-all/--timeout/--model` diam-diam jadi teks.

### 3.5 State UI ber-instance, tanpa tulis env (`F-ENV-1`)

**Berkas:** `src/ui/render/collapse.ts`, `detail.ts`, `reasoning.ts`.

- Opsi A (paling kecil): ketiga berkas kini memakai **getter/setter module-local**
  (`setSectionMinimized` / `setCompactMode` / `setReasoningVisible`) + nilai awal
  di-bootstrap dari env sekali saat import; **tidak ada tulis `process.env`**.
- `c`/`glyphs` di `theme.ts` tetap getter runtime (tidak disimpan ke `const`
  module-scope). `cli/tui.ts:132-133` yang membaca env untuk default REPL tetap
  valid karena tulis env sudah dihapus.

### 3.6 Sempitkan `any` di batas event (`F-TYPE-1`)

**Berkas:** `src/presentation/adapter.ts:632`, `src/ui/tui/app.ts:371`.

- `sub` kini **generik** (`<E = unknown>`) dengan anotasi payload tiap call-site
  dipertahankan (diinfer, bukan dilunturkan). Satu-satunya cast adalah
  `event as E` di tepi (perpindahan `unknown` dari `EventBusLike.on`/`UiBus.on`
  → bentuk yang dideklarasikan call-site).
- Satu-satunya erosi yang **dipertahankan sengaja** tetap `ui/contract.ts:70`
  (kontravariansi vendor, didokumentasikan `:62-71`) dan `events.ts:446`
  (mirror terdokumentasi) — keduanya dibiarkan.

---

## 4. Invariant yang dijaga (tidak diubah / tidak dilanggar)

- **WorkMode ⊥ PermissionMode** tetap independen: `READONLY_TOOLS` hanya
  derivasi enforcement; tidak menyentuh `work-mode.ts`, ceiling, atau transisi
  mode. Tidak ada self-escalation — perubahan kapabilitas hanya via aksi operator
  eksplisit (flag/env/perintah), pola yang sudah ada tidak diubah.
- **`D-2` non-persistence** tidak disentuh: mode tidak dipersist; resume tetap
  revert ke EXECUTE kecuali di-pass ulang.
- **`D-1..D-7`, `K-1`, I35/kontrak terminal, `INV-WM1/4`** utuh: tidak ada
  perubahan pada rendering/output, kontrak terminal, lapisan, atau kapabilitas
  ceiling. Perubahan hanya di policy-derivasi, adaptor event, state UI, dan
  tools memori.
- **Lapisan** (`ui-boundary`) tidak dilanggar: `tool-contract.ts`/`permission.ts`
  di layer policy; imports hanya antar-layer yang diizinkan.

---

## 5. Keputusan owner yang di-escalate (tidak diputuskan sendiri)

| ID | Pertanyaan | Status |
|---|---|---|
| Q1 | Semantik DISCUSS (Options A/B/C deep audit §12) | terbuka |
| Q2 | Tambah `discussHint` prompt (Option A, mirror `planHint`) | terbuka |
| Q3 | Rekonsiliasi visibility/enforcement + in/out `web_fetch`/`web_search` untuk readonly | terbuka (laporan ini **mempertahankan** membership lama tanpa memutuskan) |
| Q4 | Tampilkan WorkMode pada one-shot/`exec` (menyentuh I35) | terbuka |
| Q5 | Pertahankan `D-2` non-persistence vs sticky resume | terbuka |

---

## 6. Test yang ditambah / diperbarui

- `test/p20-phase8-supersession-mcp-pin-and-tasksync.test.ts` — supersession
  `supersedes`/`superseded_by`, tombstones dalam transaksi yang sama,
  `addMemory(supersedesId)` validasi + throw untuk id tak dikenal,
  `memoryRowExists`, `searchHybrid` mengekspos id.
- `test/coverage-gaps.test.ts` — `write_memory` menolak `supersedes_id` tak
  dikenal dengan error actionable; jalur `web_fetch`/`web_search` validasi argumen.
- `test/cli-args.test.ts` — `flagsAfterPromptBoundary` (17 kasus).
- `test/presentation-policy.test.ts` — `machineError` pemetaan
  `budget_exceeded`+"context window" → `USER_ERROR` + saran sesi-baru.
- `test/p15-phase2-contracts-approval-recovery.test.ts` — test **no-drift**
  `READONLY_TOOL_NAMES` vs daftar izin read-only permission (membership persis
  18 nama; konsistensi `allowedInReadonly` ↔ derivasi).
- `test/tui-format.test.ts`, `test/collapse.test.ts`, `test/sanitize-render.test.ts`,
  `test/terminal-contract.test.ts` — reset via setter; assertion env **tidak**
  dimutasi (F-ENV-1).
- `test/writer-inventory.test.ts` — deklarasi writer P1. `cli/index.ts` `29 → 30`
  untuk tepat SATU writer baru: peringatan `[warn] ignored flag(s) after the
  prompt` (§3.4). Mengikuti aturan "declare, not absorb" (OAP-008).

> Perhatian isolasi antar-file: menjalankan beberapa file UI/TTY secara manual
> dalam satu proses (`bun test fileA fileB`) dapat memicu artefak warna lintas-file
> yang **sudah ada sebelumnya** (bukan regresi). Gate seluler memakai `bun test`
> tanpa argumen (per-file terisolasi).

---

## 7. Hasil gate (stage-scoped)

> **Klaim hasil hanya untuk scope yang dieksekusi.** Angka di bawah adalah untuk
> working-tree P1 saat laporan ini ditulis; bukan klaim "seluruh repository hijau".

| Gate | Perintah | Hasil |
|---|---|---|
| Typecheck | `bun x tsc --noEmit` | ✅ lulus (0 error) |
| Lint | `bun run lint` (biome) | ✅ 648 file, no fixes applied |
| Test (targeted) | `bun test` subset (lihat §6) | ✅ lihat tabel (63 + 71 pass) |
| Test (full suite) | `bun test` | ✅ 5315 pass / 19 skip / 0 fail (5334 tests, 359 files) |
| Coverage | `bun run gate:coverage` | ✅ funcs 88,45% (min 87) · lines 89,14% (min 86) · 19/19 modul kritis hijau |
| Pack | `bun run gate:pack` | ✅ 23 pass / 0 fail (unpacked 3746 KB, dalam budget) |

Hasil targeted yang sudah dieksekusi (per-file):

- `bun test test/cli-args.test.ts …` (cli-args): 17 pass / 0 fail.
- `bun test test/p15-phase2-contracts-approval-recovery.test.ts test/permission-matrix.test.ts test/phase6s-autonomous-permission-policy.test.ts`: 63 pass / 0 fail.
- `bun test test/cli-args.test.ts test/p15-… test/permission-matrix.test.ts test/presentation-policy.test.ts test/presentation-linear-acp.test.ts`: 71 pass / 0 fail.

---

## 8. Tidak dijalankan / out of scope (jujur)

- **`gate:slow`** / `experiments/extreme-*` dan **`gate:bash`** tidak dijalankan
  pada writing-tree ini (bukan bagian scope P1); hasil gate lengkap akhir
  (`audit:harness`, smoke build/package, CI) **belum** diklaim.
- Perilaku **diskursus** (Q1/Q2), **surface WorkMode di one-shot** (Q4), dan
  **sticky resume** (Q5) adalah keputusan owner — tidak diimplementasikan.
- Membership in/out `web_fetch`/`web_search` pada readonly (Q3) dipertahankan
  sesuai daftar lama; keputusan perubahan tetap milik owner.

---

## 9. Artefak & kebersihan

| Item | Status |
|---|---|
| Git | ✅ tidak ada commit/push/tag; perubahan = working-tree |
| `HEAD` | `cb60212` (baseline; tidak digeser) |
| Rahasia | ✅ tidak ada tulis rahasia |
| File repo baru | hanya `docs/audit/P1_INTEGRATED_REMEDIATION_REPORT.md` (laporan ini) |