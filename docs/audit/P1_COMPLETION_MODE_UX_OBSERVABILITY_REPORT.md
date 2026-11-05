# P1 — Completion Report: Mode UX & Observability (PROMPT 03)

**Branch:** `main` · **Baseline:** `cb60212` (verified `HEAD` before edits)
**Version:** `0.13.1`
**Date:** 2026-11-02
**Scope:** Menutup sisa P1 untuk WorkMode (intent layer) — `discussHint` + prompt
PLAN mandiri, permukaan lintas-surface (`F-DISCUSS-4`), transparansi resume
(`D-2`), verifikasi isolasi state UI & rekonsiliasi memory/vector — dan
**mendokumentasikan secara eksplisit** item observability yang di-defer lewat
`D-6` (tidak di-drop diam-diam).

> **Status integrasi.** `ROADMAP.md` tidak tersentuh. Seluruh perubahan P1 ini
> adalah **working-tree yang belum di-commit** (tidak ada commit/push/tag).
> Baseline `cb60212` tetap `HEAD`. Klaim hasil di bawah **stage-scoped** — hanya
> scope yang benar-benar dieksekusi; bukan klaim "seluruh repository hijau".

---

## 1. Executive summary

PROMPT 02 (`P1_INTEGRATED_REMEDIATION_REPORT.md`) menutup tema cross-cutting
(memory supersession §7.5, list-drift `F-DISCUSS-3`, `F-TYPE-1`, `F-ENV-1`,
`§8.1`, `§8.3`) dan meng-escalate **Q1–Q5** ke owner. PROMPT 03 ini menutup
sisa yang sudah **dijawab owner** dan menegaskan status item yang **di-defer**:

| Deliverable PROMPT 03 | Status | Bukti |
|---|---|---|
| `discussHint` untuk DISCUSS (mirror `planHint`) | ✅ diimplementasi | `workModeHint` di `src/app/session.ts` |
| Prompt PLAN **mandiri** (independen `planHint` PermissionMode) | ✅ diimplementasi | branch `PLAN` di `workModeHint` |
| Permukaan WorkMode one-shot/exec (`F-DISCUSS-4`) | ✅ diimplementasi | `cli/index.ts` + `cli/commands/exec.ts` + I35 |
| Transparansi resume (`D-2`, satu baris, tanpa flood) | ✅ diimplementasi | `cli/setup.ts` + I35 |
| Isolasi state UI (`F-ENV-1`) & event-boundary `any` (`F-TYPE-1`) | ✅ diverifikasi utuh | PROMPT 02 §3.5/§3.6 + test |
| Rekonsiliasi memory/vector (`F-MEM-1`, supersession atomik) | ✅ diverifikasi utuh | PROMPT 02 §3.1 + test |
| Observability HUD (F-CTRL/CTX/TASK/AGENT/TOOL/DAEMON/APPROVAL) | ⏸ **defer** (keputusan `D-6`) | §6 — bukan diimplementasi |

Tidak ada **mode ke-4**, tidak ada perubahan persistence, tidak ada pelemahan
test proteksi, tidak ada penurunan gate coverage, dan PROMPT 02 tidak diulang.

---

## 2. Keputusan owner (Q1–Q5) — binding, tidak di-re-ask

| ID | Pertanyaan | Jawaban owner | Implementasi |
|---|---|---|---|
| Q1 | Semantik DISCUSS | DISCUSS = investigasi **read-only berorientasi diskusi** (baca/cari/nalar lalu sajikan temuan/opsi/trade-off) | `workModeHint("DISCUSS")` |
| Q2 | Tambah `discussHint`? | Ya — dan **PLAN** dapat prompt sendiri, **independen** `planHint` PermissionMode | `workModeHint("PLAN")` terpisah |
| Q3 | In/out `web_fetch`/`web_search` readonly | Dipertahankan apa adanya (konservatif) | sudah di PROMPT 02 §3.2, tidak diubah |
| Q4 | Permukaan WorkMode one-shot/exec | Implementasikan `F-DISCUSS-4` | §3.2 |
| Q5 | `D-2` non-persistence vs sticky resume | **Pertahankan `D-2`**; resume → EXECUTE kecuali diberi ulang; transisi transparan (satu baris stderr) | §3.3 |

**Formula pemilik otoritas** yang dipegang: *effective permission = WorkMode
ceiling ∧ PermissionMode ∧ injected policy ∧ runtime guards*. WorkMode tidak
pernah memperluas kewenangan — hanya mempersempit (INV-WM1).

---

## 3. Perubahan per deliverable

### 3.1 `workModeHint` — guidance DISCUSS/PLAN/EXECUTE (`Q1`+`Q2`)

**Berkas:** `src/app/session.ts` (diekspor agar teruji langsung).

- `workModeHint("DISCUSS")` = read-only investigation & discussion: "Do NOT
  modify files, run bash, or use write/edit tools … investigate … discuss
  findings, options, and trade-offs … Do not implement or execute any change."
- `workModeHint("PLAN")` = planning **mandiri** (bukan `planHint` milik
  PermissionMode): "… investigate thoroughly, then produce a concrete
  implementation plan." — lapisan intent ≠ lapisan permission.
- `workModeHint("EXECUTE")` = `""` (identity, tidak menambah apa pun).
- Ini **guidance** (behavior), bukan enforcement — enforcement tetap milik
  ceiling handler `work-mode.ts`. Prompt bukan batas keamanan; tidak mengubah
  ceiling, tidak menambah kapabilitas.

### 3.2 Permukaan lintas-surface (`F-DISCUSS-4` / `Q4`)

**Berkas:** `cli/index.ts`, `cli/commands/exec.ts`, `docs/TERMINAL_CONTRACT.md` (I35).

| Surface | Representasi WorkMode | Kanon |
|---|---|---|
| TUI (sudah ada) | footer `<WorkMode>·<permission mode>` | tidak berubah |
| One-shot / pipe | SATU baris stderr `[work-mode] <MODE> (<hint>)` — hanya NON-EXECUTE; EXECUTE tanpa baris | `cli/index.ts` cabang `else` |
| exec (non-JSON) | idem (linear manusia, tanpa footer TUI) | `cli/commands/exec.ts` |
| exec `--json` | field terstruktur `summary.workMode` — **selalu hadir, termasuk EXECUTE** | `machineSummary` |
| ACP | `params.workMode` (terstruktur) — tidak berubah, tidak ada teks dekoratif | — |

Prinsip: **JSON/ACP = terstruktur, tanpa teks dekoratif**; kanal manusia
(one-shot/exec non-JSON) = satu baris stderr yang **membedakan tegas** ini dari
PermissionMode (`[work-mode]` vs `/mode`/`--plan`) dan dari status sesi.

### 3.3 Transparansi resume (`D-2` / `Q5`)

**Berkas:** `cli/setup.ts` (~1126) + `docs/TERMINAL_CONTRACT.md` I35 (klausa "Resume (D-2)").

- WorkMode tetap **tidak dipersist**. Saat resume **tanpa sinyal eksplisit**
  (`--work-mode` / `MINICODE_WORK_MODE`), `workModeExplicit=false` → satu baris:
  `[resume] WorkMode default EXECUTE (not persisted across sessions); pass --work-mode DISCUSS|PLAN to change`
- Baris itu **stderr human-facing**, BUKAN proyeksi mesin/JSON/ACP — kanal
  machine tetap terstruktur. Satu baris, nol flood.
- Bila resume **memang** diberi sinyal eksplisit (atau invalid/warning), tidak
  ada baris duplikat — jalur warning terpisah sudah menangani.

### 3.4 Diverifikasi utuh (dari PROMPT 02 — tidak diulang, tidak dilonggarkan)

- **`F-ENV-1`** isolasi state UI: `collapse/detail/reasoning` memakai
  getter/setter **module-local**, tidak ada tulis `process.env` (PROMPT 02 §3.5).
- **`F-TYPE-1`** batas event: `sub` generik, satu cast `unknown → E` di tepi
  (PROMPT 02 §3.6).
- **`F-MEM-1`** memory/vector: `addMemory` validasi `supersedesId` + transaksi
  atomik + `memoryRowExists` + ekspos `id` (`searchHybrid`/`read_memory
  [id:…]`) + retrieval mengecualikan baris tertombstone (PROMPT 02 §3.1).

---

## 4. Invariant yang dijaga (tidak diubah / tidak dilanggar)

- **WorkMode ⊥ PermissionMode** tetap independen; tidak ada self-escalation.
- **`D-2` non-persistence** utuh; resume → EXECUTE kecuali diberi ulang.
- **`D-1..D-7`, `K-1`, I35/kontrak terminal, `INV-WM1/4`** utuh. Perubahan
  rendering/output hanya pada kanal YANG DISETUJUI `F-DISCUSS-4` (one-shot/exec
  stderr + `summary.workMode`), dan kontrak I35 sudah di-update menyesuaikan.
- **D-6** dipatuhi: ekspansi observability **tidak** diimplementasi (defer + wait
  keputusan terpisah + compat test) — bukan dilonggarkan diam-diam.
- **Lapisan** (`ui-boundary`) tak dilanggar; tidak ada mode ke-4; tidak ada
  perubahan persistence; tidak ada penurunan ambang coverage.

---

## 5. Test yang ditambah / diperbarui

- `test/cli-session.test.ts` — 6 test baru F-DISCUSS-4:
  - one-shot `--work-mode DISCUSS` → stderr `[work-mode] DISCUSS (read-only)`
  - one-shot `--work-mode PLAN` → stderr `[work-mode] PLAN (read-only planning)`
  - one-shot tanpa flag → **tanpa** baris `[work-mode]` (default EXECUTE)
  - exec non-JSON `--work-mode DISCUSS` → stderr `[work-mode] DISCUSS (read-only)`
  - exec `--json --work-mode PLAN` → `summary.workMode === "PLAN"`
  - exec `--json` default → `summary.workMode === "EXECUTE"` (selalu hadir)
- `test/writer-inventory.test.ts` — deklarasi writer P1 lanjutan (aturan
  "declare, not absorb" / OAP-008):
  - `cli/index.ts` `30 → 31` (tepat SATU writer: `[work-mode]` one-shot non-EXECUTE)
  - `cli/commands/exec.ts` `15 → 16` (tepat SATU writer: `[work-mode]` exec non-JSON)
  - `cli/setup.ts` `41 → 42` (tepat SATU writer: `[resume] WorkMode default EXECUTE …`)
- Kontrak terminal I35 klausa "Resume (D-2)" + "Surfacing lintas-surface
  (F-DISCUSS-4)" — proyeksi machine **tidak** menambahkan teks dekoratif; JSON
  hanya `summary.workMode` terstruktur.

---

## 6. Defer pile (`D-6`) — didokumentasikan, BUKAN diimplementasi

Owner decision `D-6` (binding): "observability dipreserve lebih dulu; ekspansi =
keputusan terpisah + compat test". Item berikut **defer**, masing-masing butuh
event additive gaya `consequence.detected` + update kontrak + compat test
sebelum boleh diimplementasi:

| ID | Temuan (status) | Alasan defer |
|---|---|---|
| `F-CTRL-1` | ACE verdict tersembunyi (stderr only) | butuh event verifikasi + kontrak |
| `F-CTRL-2` | VERIFYING/tamper reason tersembunyi | idem |
| `F-CTX-1` | context meter/cost footer parsial; provider usage vs estimate | idem |
| `F-CTX-2` | mid-stream cutoff raw (`[context] stream truncated`) | idem |
| `F-TASK-1` | canonical `taskId`/DAG/lease tidak dirender | idem |
| `F-AGENT-1` | sub-agent pool slot tidak keyed `runId` | idem |
| `F-TOOL-1` | MCP schema-drift = raw tool error, tanpa approval card | idem |
| `F-DAEMON-1` | REPLAY→LIVE badge tidak ada | idem |
| `F-APPROVAL-1` | approval card tanpa risk tier + diff preview | idem |

Tidak ada HUD card yang ditambahkan (F-CTRL-1/2, F-CTX-1/2, F-TASK-1,
F-AGENT-1, F-TOOL-1, F-DAEMON-1, F-APPROVAL-1) — `D-6` mewajibkan keputusan
terpisah sebelum implementasi.

---

## 7. Hasil gate (stage-scoped)

> **Klaim hasil hanya untuk scope yang dieksekusi.** Angka di bawah untuk
> working-tree P1 saat laporan ini ditulis; bukan klaim "seluruh repository hijau".

| Gate | Perintah | Hasil |
|---|---|---|
| Typecheck | `bun x tsc --noEmit` | ✅ lulus (0 error) |
| Lint | `bun run lint` (biome) | ✅ no fixes applied |
| Test (full suite) | `bun test` | ✅ 5333 pass / 19 skip / 0 fail (5352 tests, 360 files, exit 0) |
| Coverage | `bun run gate:coverage` | ✅ funcs 88,45% (min 87) · lines 89,14% (min 86) · 19/19 modul kritis hijau |
| Pack | `bun run gate:pack` | ✅ 23 pass / 0 fail (unpacked 3751 KB, dalam budget 3,5 MiB) |
| Bash probe | `bun run gate:bash` | ✅ bypass 0/62 · over-block 0/24 |
| Bench smoke | `bun run bench:smoke` | ✅ resolve 13/13 |
| Harness audit | `bun run audit:harness` | ✅ 60 pass / 0 fail (2 advisories) |

Coverage minimum saat ini (per `scripts/coverage-gate.ts`): **FUNCS 87 /
LINES 86** + 19 lantai per-berkas modul kritis. Hasil terukur PROMPT 03 =
**funcs 88,45% / lines 89,14%** — identik dengan baseline PROMPT 02 (88,45/89,14):
penambahan `workModeHint`, permukaan `F-DISCUSS-4`, dan transparansi resume
tidak menggeser agregat coverage (kenaikan bersih ~0, berada di kelas "noise"
yang secara historis repo tahan). Karena coverage **tidak naik**, minimum
**tidak** dinaikkan (aturan AGENTS.md "naikkan bila coverage naik"), dan tidak
diturunkan.

---

## 8. Tidak dijalankan / out of scope (jujur)

- **`gate:slow`** / `experiments/extreme-*` tidak dijalankan pada working-tree
  ini (bukan bagian scope P1). Hasil gate lengkap akhir (smoke build/package,
  CI) **belum** diklaim sebagai green penuh.
- Item observability HUD (§6) di-defer lewat `D-6` — bukan diimplementasi.
- PROMPT 02 tidak diulang; temuan §3.4 dinyatakan **diverifikasi utuh**, bukan
  diubah ulang.

---

## 9. Artefak & kebersihan

| Item | Status |
|---|---|
| Git | ✅ tidak ada commit/push/tag/reset; perubahan = working-tree |
| `HEAD` | `cb60212` (baseline; tidak digeser) |
| Rahasia | ✅ tidak ada tulis rahasia |
| Dump root (`t.log.txt` dkk.) | ✅ tidak dihapus/di-debug (proteksi P1) |
| File repo baru | hanya `docs/audit/P1_COMPLETION_MODE_UX_OBSERVABILITY_REPORT.md` (laporan ini) |