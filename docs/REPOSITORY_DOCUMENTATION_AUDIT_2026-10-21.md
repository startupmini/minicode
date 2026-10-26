# Audit Dokumentasi Repository MiniCode — 2026-10-21

> **JENIS DOKUMEN: SNAPSHOT PEMERIKSAAN — BUKAN SUMBER ROADMAP AKTIF.**
>
> Laporan ini adalah hasil satu kali audit dokumentasi pada revision yang
> disebut di bawah. Laporan ini **tidak** menetapkan status fase roadmap,
> **tidak** ratified roadmap, dan **tidak** menggantikan dokumen Closure/Handoff
> yang sudah ada. Sumber otoritas roadmap arsitektur (Big Phase P1–P14) tetap
> pada pemilik; dokumen master-nya belum diintegrasikan ke repository ini
> (lihat §7, Blocker B-1).
>
> Nama berkas dipisah dengan tanggal pemeriksaan (`2026-10-21`) agar tidak
> menabrak laporan Closure/Handoff yang berbasis checkpoint.
>
> **Catatan lanjutan (post-audit, 2026-10-21 — anotasi status, bukan perubahan
> isi audit):** pemilik kemudian menyertakan master roadmap-nya, dan roadmap itu
> diintegrasikan ke root repo sebagai `ROADMAP.md` (draft working-tree, belum
> di-commit) pada tugas susulan yang sama. **B-1 karena itu tertutup** dan
> pointer `AGENTS.md` diarahkan ke `ROADMAP.md`. **Badan audit di bawah tidak
> ditulis ulang** — temuan, angka, dan status saat itu tetap berlaku sebagai
> catatan pemeriksaan pada 2026-10-21 dan tidak diubah.

---

## 1. Revision, branch, dan kondisi repository saat audit

| Item | Nilai terverifikasi |
|---|---|
| Branch | `main` |
| HEAD | `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4` (`test: harden PTY SGR end-to-end coverage`) |
| Commit terakhir yang relevan | `205e355` (fix statusline lifecycle), `25839d9` (chore: Windows test reliability), `fc456b6` + `32b0dfa` (feat(p12): WorkMode permission/runtime ceilings) |
| Tag rilis terakhir | 28 tag total; tag rilis tertinggi `v0.12.0` → commit `cb633e4` ("release: MiniCode 0.12.0 (output architecture Phase 3-7)", 2026-09-25), **ancestor** dari HEAD; **166 commit** setelah tag itu. (Tag `p3.1-canonical-2026-10-08` = checkpoint non-rilis.) |
| Versi paket | `package.json` → `0.12.0` (`minicode-ai`) |
| Working tree saat audit | **Tidak bersih.** 70 berkas tracked termodifikasi + 2 berkas untracked, **sebelum** pekerjaan audit ini dimulai |
| Untracked (pre-existing) | `scripts/pack-budget.ts`, `test/checkpoint-lifecycle.test.ts` |
| Diff summary sebelum pengerjaan | `70 files changed, 1320 insertions(+), 566 deletions(-)` |

**Perubahan yang sudah ada di working tree TIDAK dihapus, di-reset, di-stash,
di-rebase, di-commit, atau di-push.** Non-destruktif sepanjang audit; verifikasi
di §8.

---

## 2. Inventaris dokumen lengkap

### 2.1 Ringkasan

| Lokasi | Jumlah `.md` | Peran |
|---|---|---|
| Root repo (`*.md`) | 112 | Campuran: instruksi operasional, roadmap/ledger, laporan Closure/Handoff/QA historis, ADR/decision package |
| `docs/` | 53 (52 + laporan audit ini) | Dokumentasi pengguna + internal kontributor + kontrak normatif |
| `docs/audit/` | 17 | Laporan audit fase (historis, terikat checkpoint) |
| `docs/design/` | 3 | Design lock fase (historis) |
| `docs/design/adr/` | 15 | ADR (historis, tidak pernah diubah) |
| `content/blog/` | 6 | Sumber konten blog (input generator situs) |
| `bench/` | 2 (`bench/docker/README.md`, `bench/HARNESS-CARD.md`) | Panduan harness benchmark — diverifikasi, tidak diubah |
| `web/README.md` | 1 | Panduan operasional situs (SEO/IndexNow/CWV) — diverifikasi, tidak diubah |
| `.minicode/MEMORY.md` | 1 | State lokal agen (0 byte, diabaikan git) — bukan dokumentasi repo |
| HTML arsitektur | 1 (`docs/ARCHITECTURE.html`) | Peta struktur hidup, hand-maintained |
| HTML lain | 2 (`web/layout.html`, `web/admin.html`) | Template situs, bukan dokumentasi produk |

**Total file markdown inventaris: 210.** Semua diperiksa terhadap bukti
implementasi; tidak ada yang diinventarisasi lalu diabaikan.

### 2.2 Klasifikasi + tindakan

| Klasifikasi | Path / pola | Tindakan pada audit ini |
|---|---|---|
| **Instruksi operasional aktif** | `AGENTS.md`; `docs/agents.md` (= `docs/AGENTS.md`, nama kapital — dokumentasi sub-agent, bukan instruksi agent) | `AGENTS.md` diperbarui (otoritas roadmap + disambiguasi nomor P). `docs/agents.md` diverifikasi, tidak diubah |
| **Kontrak normatif** | `docs/TERMINAL_CONTRACT.md` | Diperbarui: peta proteksi dikoreksi + **bagian "Gap proteksi" baru** (I1–I35, v7.4) |
| **Panduan pengguna** | `docs/README.md`, `SUMMARY.md`, `getting-started.md`, `quickstart.md`, `concepts.md`, `glossary.md`, `cli.md`, `choosing-mode.md`, `repl.md`, `exec.md`, `config.md`, `config-providers.md`, `pricing-budget.md`, `environment.md`, `skills.md`, `tools.md`, `agents.md`, `mcp-lsp.md`, `memory-sessions.md`, `verify-benchmark.md`, `security-model.md`, `policy-sandbox.md`, `security.md`, `troubleshooting.md`, `terminal.md`, `architecture.md`, `USAGE.md` (pointer arsip) | Diperbarui yang memuat klaim basi (lihat §5). `tools.md`, `glossary.md`, `troubleshooting.md`, `mcp-lsp.md`, `memory-sessions.md`, `verify-benchmark.md`, `config.md`, `config-providers.md`, `getting-started.md` **diverifikasi tanpa perubahan** |
| **Referensi arsitektur** | `docs/ARCHITECTURE.html` (hand-maintained; dijaga `test/architecture-map.test.ts` + `test/p1-hygiene.test.ts` + `test/p2-daemon-guards.test.ts`) | Diperbarui luas (lihat §5.3). **Tidak** dibuat sumber duplikat baru |
| **Roadmap/status aktif** | **Tidak ada.** Master roadmap owner tidak ada di repo | Tidak dibuat. Blocker dicatat (§7) |
| **Ledger milestone internal/legacy** | `PLAN.md` | Diperbarui: dipisahkan dari "rencana aktif"; nomor legacy diberi label |
| **Laporan historis terikat checkpoint** | `P*_PHASE_CLOSURE_REPORT.md`, `P*_QA_REPORT.md`, `P*_AUDIT*.md`, `PHASE-*.md`, `docs/audit/**`, `docs/design/**`, `docs/design/adr/**`, `P3_ROADMAP.md` | **Tidak diubah** (lihat §6) |
| **Arsip / sudah digantikan** | `docs/PLAN_UIUX_V6.md` (arsip eksplisit), `docs/USAGE.md` (pointer ke arsip) | Tidak diubah |
| **Sumber generator situs** | `docs/SUMMARY.md` → `scripts/web/*` (nav, llms.txt, llms-full.txt, sitemap, breadcrumbs); `PLAN.md` → `scripts/web/changelog.ts` → halaman changelog situs; `content/blog/*.md` → `scripts/web/blog.ts` | `docs/SUMMARY.md` diperbarui (label REPL→TUI, 30→35 invariant). `PLAN.md` diperbarui tanpa merusak marker generator changelog. `content/blog/**` diverifikasi, tidak diubah |
| **Dokumentasi status otoritas belum jelas** | `docs/OUTPUT_IMPLEMENTATION_PLAN.md`, `docs/OUTPUT_ARCHITECTURE_AUDIT.md`, `docs/OUTPUT_EVENT_MODEL.md`, `docs/OUTPUT_PROTOCOL_SPEC.md`, `docs/OUTPUT_RENDERING_SPEC.md`, `docs/OUTPUT_UX_RULES.md`, `docs/UI_RENDER_PIPELINE.md`, `docs/CONTROL-PLANE-MAP.md`, `docs/HARNESS.md`, `docs/TASK_*.md` (9 berkas) | Diverifikasi. `OUTPUT_IMPLEMENTATION_PLAN.md` (in-flight) sudah menyebut budget 3,5 MiB — **cocok** dengan implementasi. `UI_RENDER_PIPELINE.md` & `CONTROL-PLANE-MAP.md` diperbarui (terminologi REPL→TUI). `docs/TASK_*.md` = laporan audit historis → tidak diubah |

### 2.3 Instruksi agent di direktori turunan

Hanya **satu** berkas `AGENTS.md` di luar root: `docs/agents.md` (filesystem
Windows/HFS mengcase-insensitive: `docs/AGENTS.md` ≡ `docs/agents.md`). Isinya
dokumentasi **sub-agent produk**, bukan instruksi untuk agent — klasifikasi sudah
benar, tapi nama berkasnya bisa disalahbaca. Dokumentasi produk itu sendiri
benar (12 tool read-only, approval sekali per delegasi, tanpa MCP/commit/
memory-tulis/todo-tulis/job background/nesting) — **diverifikasi terhadap
`src/tools/task.ts` + `test/work-mode-subagent.test.ts`**.

---

## 3. Matriks klaim penting → sumber bukti → status verifikasi

Status: `CONFIRMED` · `STALE` · `CONTRADICTORY` · `UNVERIFIED` · `HISTORICAL` ·
`OWNER_DECISION_REQUIRED`

### 3.1 Versi, provenance, gate

| Klaim | Sumber bukti | Status |
|---|---|---|
| Versi paket `0.12.0` | `package.json:3` | **CONFIRMED** |
| `docs/ARCHITECTURE.html` badge `v0.11.1` (2 tempat) | `package.json:3` = `0.12.0` | **STALE** → diperbaiki |
| Pin kernel `0d33571` | `vendor/minicore/VENDOR.md` (`source commit: 0d33571047c…`) | **CONFIRMED** |
| `docs/ARCHITECTURE.html` pin `ae9d1be` (lokasi kedua) | `ae9d1be` tak ada di `vendor/minicore/VENDOR.md`; hanya tersisa di `CHANGELOG.md:192` (historis) | **CONTRADICTORY** → diperbaiki |
| Ambang coverage `MIN_LINES/MIN_FUNCS = 86/86` | `scripts/coverage-gate.ts:92-93` | **CONFIRMED** |
| `docs/ARCHITECTURE.html` ambang `84/80` (2 tempat) | idem | **STALE** → diperbaiki |
| `docs/contributing.md` ambang `82 funcs / 84,5 lines` + 15 lantai | idem (86/86 + **19** lantai) | **STALE** → diperbaiki |
| `PLAN.md` ambang `min 83 funcs / 84,5 lines` | idem | **STALE** → diperbaiki |
| 19 lantai per-berkas kritis | `scripts/coverage-gate.ts:110-133` (19 entri `CRITICAL_FILES`) | **CONFIRMED** |
| Budget paket 3.584 KiB (3,5 MiB) | `scripts/pack-budget.ts:26` (`PACK_SIZE_BUDGET_KIB = 3584`), dipakai `scripts/pack-check.ts:29` | **CONFIRMED (implementasi ada di working tree, belum di-commit)** |
| `docs/OUTPUT_IMPLEMENTATION_PLAN.md` "pack size guard is 3.5 MiB" | idem | **CONFIRMED** |
| `gate:pack` = 23 pemeriksaan | `scripts/pack-check.ts`: 1 (bin def) + 1 (bin packed) + 1 (graf import) + 1 (vendor kernel) + 1 (vendor pkg.json) + 14 (forbidden) + 2 (README/LICENSE) + 1 (doc-links) + 1 (ukuran) = **23** | **CONFIRMED** |
| `bench/harness-audit.ts` "60 cek harness" | Dijalankan: `60 pass, 0 fail, 2 advisories` → **62 entri total** | **STALE** (frasa) → diperbaiki menjadi "60 pass + 2 advisory" |
| Jumlah tool 37 | `bun -e` → `allTools.length = 37` | **CONFIRMED** |
| Preset gateway 14 | `src/providers/presets.ts` → `GATEWAY_PRESETS.length = 14` | **CONFIRMED** |
| Permission mode 6 | `src/policy/permission.ts` → `auto\|readonly\|plan\|allow-all\|ask\|allowlist` | **CONFIRMED** |
| `readonly` = 18 tool | `src/policy/permission.ts:31` `READONLY_TOOLS` = **18 entri** (gerbang izin) | **CONFIRMED**, tapi **tidak lengkap**: model hanya melihat **12** (`EXPLORE_TOOL_NAMES` = 12, dipakai filter visibilitas `readonly`/`plan` di `src/app/tool-layer.ts:64-71`) → 4 dokumen diperbaiki |

### 3.2 Struktur & arsitektur

| Klaim | Sumber bukti | Status |
|---|---|---|
| Entry point `cli/index.ts` | `package.json:36` `"bin": {"minicode": "./cli/index.ts"}` | **CONFIRMED** |
| `cli/commands/` = 12 berkas | `cli/commands/` berisi **13** `.ts` (`daemon.ts` tidak tercatat di peta) | **CONTRADICTORY** → diperbaiki |
| `daemon` = subcommand | `cli/router.ts:131-143`, `cli/index.ts:49,198` | **CONFIRMED** → ditambahkan ke peta + `docs/cli.md` |
| Subcommand list di peta HTML | `cli/router.ts:73-154` mendispatch 15 token (termasuk `daemon` + alias `models`/`sync`) | **CONTRADICTORY** → diperbaiki |
| `cli/` = 8 modul | 11 root `.ts` + 13 `commands/` = **24** | **CONTRADICTORY** → diperbaiki |
| `src/policy/` = 12 modul | **15** | **CONTRADICTORY** → diperbaiki |
| `src/providers/` = 8 modul | **11** | **CONTRADICTORY** → diperbaiki |
| `src/session/` = 10 modul | **14** (label peta bertentangan dengan kartunya sendiri) | **CONTRADICTORY** → diperbaiki |
| `src/task/` = 10 modul | **19** (label vs kartu) | **CONTRADICTORY** → diperbaiki |
| `src/ui/` = 22 modul | **39** | **CONTRADICTORY** → diperbaiki |
| `src/` lainnya = 19 modul | **49** | **CONTRADICTORY** → diperbaiki |
| `vendor/minicore/` = 7 modul | **20 berkas** (metric `VENDOR.md`: `src/core` + `src/providers` + `package.json` + `LICENSE` + `test/fakes.ts`) | **CONTRADICTORY** → diperbaiki |
| `cli/recovery-warning.ts` ada di peta | Berkas ada (`RECOVERY_PREVIEW_MAX`, `boundRecoveryPreview`, `formatDelegateRecoveryLine`), impor `cli/index.ts:607`; **tidak** ada di peta | **STALE** → kartu ditambahkan |
| `vendor/minicore/src/core/errors.ts` + `types.ts` ada di peta | Ada di `vendor/minicore/src/core/`; tidak di peta | **STALE** → kartu ditambahkan |
| Ekspor `WorkModeControl` milik `src/policy/work-mode.ts` | `WorkModeControl` ada di `src/app/session.ts:56,88`; `work-mode.ts` mengekspor `WorkModePermissionHandler` | **CONTRADICTORY** → diperbaiki |
| Ekspor `updateProviders` milik `src/providers/router.ts` | `router.ts` mengekspor `RouterConfig`, `createRouterProvider`; `updateProviders` = **method** objek router (`router.ts:86-91`) | **CONTRADICTORY** → diperbaiki |
| Ekspor `LspConnection` milik `src/lsp/client.ts` | `class LspConnection` **tanpa** `export` | **CONTRADICTORY** → diperbaiki |
| Ekspor `GLOBAL` milik `src/config.ts` | Tidak ada simbol `GLOBAL`; yang ada `globalConfigPath()` (`config.ts:85`) | **CONTRADICTORY** → diperbaiki |
| `formatError` milik `assistant/simple.ts` | Definisi kanonik di `src/ui/render/errors.ts:282`; `simple.ts:831` hanya re-export | **CONTRADICTORY** → diperbaiki (selaras dengan kontrak) |
| `approval/prompt.ts` punya dua kartu dengan ekspor berbeda | Satu berkas, satu set ekspor | **CONTRADICTORY** → digabung jadi satu kartu |
| `/compact` = builtin `cli/commands.ts` | `BUILTIN_COMMANDS` = 8 (`cli/commands.ts:129-138`), `/compact` = perintah driver TUI (`cli/tui.ts`) | **CONTRADICTORY** → diperbaiki |
| `DRIVER_HELP_COMMANDS` = mode/work-mode/undo/redo/clear/copy/history | `cli/commands.ts:147-161` = 9 entri (ada `lang` + `scheduler`) | **STALE** → diperbaiki |
| `/status` = "jendela info" | Jendela info **dihapus** (kontrak I15); `/status` = readout transkrip (`cli/tui.ts`, `docs/terminal.md`) | **CONTRADICTORY** → diperbaiki |
| "REPL linier" sebagai tampilan interaktif | REPL linier dihapus; satu-satunya tampilan interaktif = TUI fullscreen (`cli/index.ts:516`) | **CONTRADICTORY** → diperbaiki (peta HTML, `docs/cli.md`, `docs/architecture.md`, `docs/choosing-mode.md`, `docs/environment.md`, `docs/exec.md`, `docs/pricing-budget.md`, `docs/quickstart.md`, `docs/skills.md`, `docs/CONTROL-PLANE-MAP.md`, `docs/HARNESS.md`, `docs/UI_RENDER_PIPELINE.md`, `README.md`) |
| `~/.minicode/sessions.sqlite` | `src/session/persistence.ts:14` → `resolveDbPath("sessions.db", cwd)`; lokal dulu (`src/lib/db-path.ts:18-31`) | **CONTRADICTORY** → diperbaiki |
| `~/.minicode/traces/` (direktori global) | `src/telemetry/trace.ts:157-159` → `<cwd>/.minicode/traces.jsonl` | **CONTRADICTORY** → diperbaiki |
| `.minicode/checkpoints/` | `src/session/checkpoint.ts:66` → `.minicode/checkpoints/<sessionId>/` | **STALE** → diperbaiki |
| "Semua sel DILARANG dijaga otomatis oleh `test/ui-boundary.test.ts`" | Test itu memanggil 5 aturan; **baris `vendor/minicore/` tidak dijaga assertion apa pun** (`test/ui-boundary.test.ts:45-46` hanya memindai `src/**`) | **OVERCLAIM** → dikualifikasi |
| `src/task/` ada di sidebar + TOC peta | Group terbesar (19 kartu) **tidak** tertaut di nav kiri maupun TOC kanan | **STALE** → ditambahkan |
| Tabel env var di HTML = "25 variabel" | Kode membaca **42** `MINICODE_*` berbeda di `src/`+`cli/` (`process.env.MINICODE_*`), + `MINICODE_THINKING` (vendor) + `NO_COLOR`; tabel HTML cuma 27 baris dan basi | **CONTRADICTORY** → tabel duplikat **dihapus**, diganti pointer ke kanonik `docs/environment.md` |
| "vendor kernel 20 file, ~81 KB" (README) / "19 file, ~72 KB" (concepts.md) | `vendor/minicore` = 21 berkas / 89,6 KiB total; metric `VENDOR.md` = 20 berkas | **STALE** → angka mesin dihapus, diganti pointer ke `VENDOR.md` (mengikuti aturan repo "angka mesin jangan ditulis di markdown") |
| `docs/cli.md` rujukan `cli/args.ts:53` | `args.ts:53` = `])` penutup `VALUE_FLAGS`; mekanikanya `flagNameOf()` di `args.ts:59-67` | **STALE** → diperbaiki (peta HTML + `docs/cli.md`) |
| `docs/UI_RENDER_PIPELINE.md` "digerakkan `cli/` (`repl.ts`, …)" | `repl.ts` tidak ada; driver's `cli/tui.ts` | **STALE** → diperbaiki |

### 3.3 Kontrak terminal & TUI

| Klaim | Sumber bukti | Status |
|---|---|---|
| Kontrak versi | `docs/TERMINAL_CONTRACT.md:1` → `v7.4, 2026-10-20` | **CONFIRMED** |
| Invarian I1–I35 lengkap | Bagian Invariant memuat nomor 1–35 (I10 & I15 = nomor mati yang dipertahankan) | **CONFIRMED** |
| Peta proteksi: semua test bernama ada | 60 path `test/*.ts` disebut; **semua ada**. 4 di antaranya adalah **tombstone eksplisit** (`test/ui-combined.test.ts`, `test/repl-linear.test.ts`, `test/footer-chrome.test.ts`, `test/info-window.test.ts` — tiga dihapus di `420631a`, satu tak pernah ada) | **CONFIRMED** (dengan catatan tombstone) |
| I10 & I15 punya test mapped | Keduanya **pensiun** (I10 "Dilebur ke I3", I15 "Dihapus bersama jendela info") | **CONFIRMED** |
| Klaim `/copy [n]` diproteksi `test/tui-app.test.ts` | Assertion OSC52 ada di `test/tui-format.test.ts` ("copy: envelope OSC52 benar saat TTY") + `test/tui-lang.test.ts` ("/copy 2 menyalin dua turn terakhir") + `test/pty.test.ts` (byte nyata). `tui-app.test.ts` **tidak** punya assertion OSC52 | **CONTRADICTORY** → peta dikoreksi |
| Klaim I24 (`/expand` Content Store) diproteksi `test/tui-transcript.test.ts` | `tui-transcript.test.ts` tak punya assertion `/expand`; yang ada di `test/collapse.test.ts`, `test/presentation-expand.test.ts`, `test/presentation-store.test.ts` (`expand("c1")` dua kali → identik; `expandAll()`; `expand("gone", durable)`; marker retensi) | **CONTRADICTORY** → peta dikoreksi |
| Klaim "I14: abort/scroll/selection lolos saat menciut" diproteksi `test/tui-app.test.ts` | Implementasi ada (`src/ui/tui/app.ts:511-513, 547`); test yang ada ("terminal menciut tengah sesi") **hanya** assert ketikan diabaikan + `Ctrl+D` keluar | **UNVERIFIED** → dipindah ke **Gap proteksi** |
| Klaim "spacer" diproteksi | Kata `spacer` **tidak muncul** di berkas test mana pun | **UNVERIFIED** → Gap proteksi |
| Label `(I20)` di `test/tui-app.test.ts:219` | Test itu status bar = **I13**; I20 = lebar popup tetap (terverifikasi di `test/tui-geometry.test.ts` + `test/dialog.test.ts`) | **CONTRADICTORY** → dicatat di Gap proteksi |
| Klaim I5 diproteksi `test/turn-status.test.ts` / `test/statusline-bun-guard.test.ts` | Keduanya tak assert popup yatim / kebocoran input | **UNVERIFIED** → Gap proteksi |
| Klaim I26 diproteksi `test/presentation-projections.test.ts` | File mengunci locale `en` di semua test; tak ada assertion i18n | **UNVERIFIED** → Gap proteksi |
| Klaim I2/I6/I28 diproteksi `test/presentation-linear-acp.test.ts` | Hanya I33 yang benar-benar di-assert | **UNVERIFIED** → Gap proteksi |
| `formatError` = formatter kanonik (redaksi credential) | `src/ui/render/errors.ts:282`; dijaga `test/errors-usage.test.ts` | **CONFIRMED** |
| Checkpoint = milik lifecycle sesi (`close()` = barrier) | `test/checkpoint-lifecycle.test.ts` (untracked, in-flight) — 4 skenario | **CONFIRMED** (baru, in-flight) |
| WorkMode I35 terimplementasi | `src/policy/work-mode.ts`, `src/app/tool-layer.ts`; 6 berkas test (`work-mode-{contract,tool-visibility,cli,subagent,hooks,runtime}.test.ts`, total **86 test**) | **CONFIRMED (implementasi)** |
| P12 closure formal | **Tidak ada** `P12_PHASE_CLOSURE_REPORT.md`. Yang ada: `P12_ENTRY_GATE_AND_SCOPE_AUDIT.md` + `P12_1_*` (design/decision) + `P12_1_REV2_OWNER_DECISION_REPORT.md` (verdict `READY FOR NEXT IMPLEMENTATION REVIEW`, 2026-10-18) | **UNVERIFIED / OWNER_DECISION_REQUIRED** — lihat §7 B-2 |

---

## 4. Kontradiksi & masalah usang (prioritas)

| # | Prioritas | Temuan | Lokasi | Penyelesaian |
|---|---|---|---|---|
| C-01 | **P0** | Peta HTML mengklaim v6 / I1–I30 sementara kontrak = v7.4 / I35 | `docs/ARCHITECTURE.html:1067,1077` | Diperbaiki → v7.4 / 35 invariant |
| C-02 | **P0** | Peta HTML dua hash kernel berbeda (`0d33571` vs `ae9d1be`) | `docs/ARCHITECTURE.html:547,582` | Diperbaiki → satu pin `0d33571` (cocok `VENDOR.md`) |
| C-03 | **P0** | Versi `v0.11.1` di peta vs `0.12.0` di `package.json` | `docs/ARCHITECTURE.html:467,1138` | Diperbaiki |
| C-04 | **P0** | Ambang gate HTML `84/80` vs `scripts/coverage-gate.ts` `86/86` | `docs/ARCHITECTURE.html:873,1024` | Diperbaiki |
| C-05 | **P0** | `docs/TERMINAL_CONTRACT.md` (dan `terminal.md`, `architecture.md`, `README.md`, `SUMMARY.md`) mengklaim I1–I30 | 5 berkas | Diperbaiki → I1–I35 |
| C-06 | **P0** | Roadmap: `AGENTS.md` + `PLAN.md` + `docs/architecture.md` menyebut `PLAN.md` sebagai "rencana aktif"/sumber tunggal, padahal otoritas = Big Phase P1–P14 pemilik dan master roadmap **tidak ada di repo** | `AGENTS.md:3`, `PLAN.md:1-3`, `docs/architecture.md:5` | Diperbaiki: status dokumen + tabel disambiguasi nomor P + blocker dicatat |
| C-07 | **P1** | Konflik nomor "Big Phase 12": `P2_CLOSURE_HANDOFF.md:100` = *Desktop UI interaktif* (Big Roadmap legacy) vs P12 pemilik = *Work Modes* | `P2_CLOSURE_HANDOFF.md` (arsip, tidak diubah) | Disambiguate di `AGENTS.md` + `PLAN.md` (arsip tak disentuh) |
| C-08 | **P1** | Peta HTML menuduh `daemon` tak ada, dan `cli/commands/` "12 berkas" (padahal 13, `exec.ts` dobel) | `docs/ARCHITECTURE.html:610,659` | Diperbaiki |
| C-09 | **P1** | 6 ekspor salah tempat / salah nama (`WorkModeControl`, `updateProviders`, `LspConnection`, `GLOBAL`, `formatError`, duplikat `approval/prompt.ts`) | `docs/ARCHITECTURE.html:688,716,814,815,821,838,846` | Diperbaiki |
| C-10 | **P1** | 7 label jumlah modul salah (cli/policy/providers/session/task/ui/lainnya/kernel) | `docs/ARCHITECTURE.html` §03 | Diperbaiki (diverifikasi ke working tree) |
| C-11 | **P1** | Tabel env var HTML = 27 baris basi, padahal kode baca 42 `MINICODE_*`; kanonik = `docs/environment.md` (dijaga `test/env-docs.test.ts`) | `docs/ARCHITECTURE.html` §06 | Tabel duplikat dihapus → pointer ke kanonik |
| C-12 | **P1** | "Semua sel DILARANG dijaga otomatis" — baris `vendor/minicore/` tak dijaga assertion | `docs/ARCHITECTURE.html:562,593` | Dikualifikasi + label di matriks |
| C-13 | **P1** | Peta proteksi kontrak menautkan test yang tidak meng-assert klaimnya (`/copy`, `/expand`/I24, spacer, I5, I26, I2/I6/I28, I12 di `terminal-contract.test.ts`, label I20) | `docs/TERMINAL_CONTRACT.md` §Peta proteksi | Peta dikoreksi ke test yang benar + **bagian "Gap proteksi" baru** |
| C-14 | **P1** | Istilah REPL dipakai sebagai tampilan aktif padahal REPL linier dihapus | 13 berkas (lihat §3.2) | Diperbaiki → "TUI"; nama berkas `repl.md` **dipertahankan** (menghindari patahnya link) |
| C-15 | **P1** | `/status` = "jendela info" (Peta HTML) vs "readout transkrip" (kontrak I15 + `cli/tui.ts`) | `docs/ARCHITECTURE.html:657` | Diperbaiki |
| C-16 | **P1** | `readonly` = "18 tool" tanpa menyebut model hanya melihat 12 | `choosing-mode.md`, `policy-sandbox.md`, `security-model.md`, `security.md` | Diperbaiki (gate 18 vs visibilitas 12) |
| C-17 | **P2** | Path persistensi salah: `sessions.sqlite`, `~/.minicode/traces/` | `docs/ARCHITECTURE.html` §07 | Diperbaiki |
| C-18 | **P2** | `src/task/` orphan di nav/TOC peta | `docs/ARCHITECTURE.html` | Diperbaiki |
| C-19 | **P2** | `--work-mode`, `--enable-scheduler`, `--runtime`, `minicode daemon`, alias `models`/`sync` tidak ada di `docs/cli.md` | `docs/cli.md` | Diperbaiki |
| C-20 | **P2** | `/work-mode` & `/scheduler` tidak ada di tabel slash command pengguna | `docs/repl.md` | Diperbaiki |
| C-21 | **P2** | Angka ukuran vendor basi ("20 file, ~81 KB" / "19 file, ~72 KB") | `README.md:55`, `docs/concepts.md:9` | Angka mesin dihapus → pointer `VENDOR.md` |
| C-22 | **P2** | Rujukan baris salah (`cli/args.ts:53` / `args.ts:62`) | `docs/cli.md:120`, `docs/ARCHITECTURE.html` §08 | Diperbaiki → `args.ts:59-67` |
| C-23 | **P2** | `repl.ts` disebut sebagai driver di `docs/UI_RENDER_PIPELINE.md` | `docs/UI_RENDER_PIPELINE.md:95` | Diperbaiki → `tui.ts` |

**Total kontradiksi teridentifikasi: 23.** Semua diperbaiki kecuali yang
dinyatakan eksplisit di §7.

---

## 5. Daftar berkas yang diperbarui + alasannya

### 5.1 Instruksi & roadmap

| Berkas | Perubahan | Alasan |
|---|---|---|
| `AGENTS.md` | Tambah bagian "Otoritas roadmap" + tabel disambiguasi nomor P (Big Phase vs legacy-0.9 vs sub-milestone vs Stage vs UX-001); ubah "Rencana aktif: PLAN.md" → blokir; tambahkan ambang coverage & budget paket yang terverifikasi; pointer ke laporan audit | C-06, C-07; otoritas roadmap harus eksplisit agar agent berikutnya tak salah baca `PLAN.md` sebagai roadmap arsitektur |
| `PLAN.md` | Header → "Buku besar milestone internal & legacy" + blok status (bukan roadmap aktif) + tabel scope; 3 judul "Rencana aktif berikutnya" → "Rencana (SELESAI)"; "Status eksekusi terbaru" → historis + label; "Next action — sisa aktif" → "Sisa program legacy v0.9 (HISTORIS)"; label §P10/§P11/§P13 → `LEGACY-0.9/…` + disclaimer; ambang coverage 82/84,5 → 86/86 | C-06, C-07; §7.2 memisahkan rencana aktif / selesai / tertunda / historis tanpa menghapus sejarah |

### 5.2 Kontrak & arsitektur

| Berkas | Perubahan | Alasan |
|---|---|---|
| `docs/TERMINAL_CONTRACT.md` | Peta proteksi dikoreksi (test yang benar untuk `/copy`, `/expand`, I12, I26, I2/I6/I28, I4/I5); tambah bagian **"Gap proteksi (terbukti, belum ditutup)"** dengan tabel 6 klaim + status implementasi + yang hilang; koreksi klausul `pty.test.ts` soal "exec --json bersih tanpa ANSI"; koreksi bullet `tui-app`/`tui-popup` soal spacer | C-13; §7.3: klaim tak boleh aman "karena tes bernama sesuai" — gap dicatat, bukan dipoles |
| `docs/ARCHITECTURE.html` | Versi (2), tanggal footer, pin kernel, 8 label jumlah modul, daftar subcommand, kartu `cli/commands/` (13 berkas + `daemon.ts` + `handleDaemon`), kartu baru `cli/recovery-warning.ts`, kartu baru vendor `core/errors.ts`+`types.ts`, 6 koreksi ekspor, gabung duplikat `approval/prompt.ts`, 2× ambang coverage, harness "60 pass + 2 advisory", kontrak v7.4/35, path persistensi, rujukan `args.ts`, kualifikasi klaim boundary + label baris vendor, hapus tabel env duplikat → pointer kanonik, nav+TOC `src/task/`, "REPL"→"TUI" (3 tempat) | C-01…C-05, C-08…C-12, C-14, C-15, C-17, C-18, C-22 |

### 5.3 Panduan pengguna & dokumen lain

| Berkas | Perubahan | Alasan |
|---|---|---|
| `docs/architecture.md` | Pointer roadmap → otoritas Big Phase + blokir; "30 invariant (I1–I30)" → 35 (I1–I35) + pointer Gap proteksi; "REPL/one-shot" → "TUI/one-shot" | C-05, C-06, C-14 |
| `docs/terminal.md` | "Invariant I1–I30" → I1–I35 + 35 invariant + versi v7.4 + pointer Gap proteksi | C-05 |
| `docs/README.md` | "invariant I1-I30" → I1–I35; label nav "REPL" → "TUI" (2 tempat) | C-05, C-14 |
| `docs/SUMMARY.md` | "Terminal Contract (FROZEN) — 30 invariant" → "35 invariant, v7.4"; "REPL — Slash & Keyboard" → "TUI — Slash & Keyboard" | C-05, C-14 |
| `docs/cli.md` | "REPL" → "TUI" (2); tambah baris `minicode daemon …`; perbarui daftar subcommand (13 + alias); tambah flag `--work-mode`, `--enable-scheduler`, `--runtime`; Shift+Tab ≠ WorkMode; `args.ts:53` → `args.ts:59-67` | C-14, C-19, C-22 |
| `docs/repl.md` | Tambah baris `/work-mode` + `/scheduler` | C-20 |
| `docs/choosing-mode.md` | "REPL" → "TUI"; `readonly` 18→(gerbang 18 / terlihat 12) | C-14, C-16 |
| `docs/policy-sandbox.md` | Baris `readonly`: 18 tool + keterangan visibilitas 12 | C-16 |
| `docs/security-model.md` | Baris `readonly`: "18 tool baca" → "18 tool baca di gerbang (model melihat 12)" | C-16 |
| `docs/security.md` | `readonly` (18 tool) → (18 di gerbang; model melihat 12) | C-16 |
| `docs/environment.md` | "compact di REPL" → "di TUI" | C-14 |
| `docs/exec.md` | "REPL break loop" → "TUI break loop" | C-14 |
| `docs/pricing-budget.md` | "REPL `break` loop" → "TUI `break` loop" | C-14 |
| `docs/quickstart.md` | "[REPL](repl.md)" → "[TUI](repl.md)" | C-14 |
| `docs/skills.md` | "Panggil dari REPL" → "TUI"; nav "REPL" → "TUI" | C-14 |
| `docs/concepts.md` | Angka ukuran vendor → pointer `VENDOR.md` | C-21 |
| `docs/CONTROL-PLANE-MAP.md` | "seragam REPL/one-shot/exec" → "TUI/…" | C-14 |
| `docs/HARNESS.md` | "di one-shot/REPL/`exec`" → "TUI/…" | C-14 |
| `docs/UI_RENDER_PIPELINE.md` | `repl.ts` → `tui.ts`; "State machine REPL" → "TUI" | C-14, C-23 |
| `docs/contributing.md` | Ambang coverage → 86 funcs / 86 lines + 19 lantai | C-04 |
| `README.md` | "REPL (tab completion…)" → "TUI fullscreen (…)"; `--interactive` = TUI fullscreen; angka ukuran vendor → pointer `VENDOR.md` | C-14, C-21 |

---

## 6. Dokumen historis/arsip yang **sengaja tidak diubah**

Semuanya sudah benar pada masanya; mengubahnya berarti memalsukan catatan
historis.

| Dokumen/kelompok | Alasan |
|---|---|
| `P2_CLOSURE_HANDOFF.md`, `P3_ROADMAP.md`, `P*_PHASE_CLOSURE_REPORT.md`, `P*_QA_REPORT.md`, `P11_*.md` (7 berkas), `P12_*.md` (6 berkas) | Laporan terikat checkpoint + revisi + tanggal pemeriksaan. Angka `2304 KB`/`2,25 MiB`/`4121 KB` di dalamnya **benar pada saat itu**; status paket kini sudah berbeda dan itu harus dibedakan lewat label, bukan dengan mengoreksi angka historis. Konflik nomor "Big Phase 12" disambiguate di `AGENTS.md`, bukan di arsip |
| `docs/audit/**` (17), `docs/design/**` (3), `docs/design/adr/**` (15) | Artefak QA/audit/design-lock historis. Tidak ada klaim "sekarang" di dalamnya |
| `PHASE-*.md` (47 berkas di root) | Rekam jejak pemulihan legacy |
| `docs/PLAN_UIUX_V6.md` | Arsip eksplisit (dinyatakan arsip di `PLAN.md`) |
| `docs/USAGE.md` | Sudah pointer ke halaman terpisah |
| `CHANGELOG.md` | Riwayat rilis. Entri `## [Unreleased]` yang menjelaskan P12 S2.2 sudah jujur (menyatakan gate belum hijau pada saat itu) — **tidak diubah** |
| `P12_ENTRY_GATE_AND_SCOPE_AUDIT.md` | Audit entry-gate 2026-10-18. Klaim "18 tool baca-only" benar untuk `READONLY_TOOLS` (gerbang) pada saat itu |
| `content/blog/*.md` (6) | Sumber konten blog; link `/docs/*.html` adalah URL situs (bukan path filesystem) — valid |
| `docs/OUTPUT_*.md`, `docs/TASK_*.md` | Audit + spesifikasi fase. `OUTPUT_IMPLEMENTATION_PLAN.md` sudah menyebut budget 3,5 MiB (cocok implementasi) |
| `vendor/minicore/**` | Kernel beku — di luar ruang lingkup (AGENTS.md) |
| `site/**` | Tidak dilacak git; dibangun ulang oleh pipeline web |

---

## 7. Gap belum terverifikasi & keputusan pemilik yang masih diperlukan

| ID | Jenis | Isi | Yang dibutuhkan |
|---|---|---|---|
| **B-1** | **OWNER_DECISION_REQUIRED** | **Master roadmap arsitektur (Big Phase P1–P14) tidak ada di repository.** Konfirmasi independen: `P12_ENTRY_GATE_AND_SCOPE_AUDIT.md` §3 menyatakan "Definisi P12 'Work Modes & Permission Architecture' hanya berasal dari pemilik, bukan dari dokumen repo". Tidak ada `ROADMAP.md` (hanya `P3_ROADMAP.md` = Big Roadmap *legacy* Phase 3) | Naskah master roadmap pemilik (atau file yang meng-integrasikannya ke repo). Sampai itu masuk, **status fase tidak boleh diklaim dari dokumen mana pun** |
| **B-2** | **OWNER_DECISION_REQUIRED** | **P12 closure formal belum ada.** Implementasi WorkMode mendarat (`fc456b6`, `32b0dfa`, +4 commit regresi), kontrak v7.4/I35 ada, 6 berkas test (86 test) ada — **tapi tidak ada `P12_PHASE_CLOSURE_REPORT.md`**. Artefak terakhir = `P12_1_REV2_OWNER_DECISION_REPORT.md` (verdict `READY FOR NEXT IMPLEMENTATION REVIEW`, 2026-10-18) | Keputusan pemilik: tetapkan/tidak P12 closed, dan bentuk dokumen penutupan yang dikehendaki. **Audit ini tidak menulis dokumen closure** |
| B-3 | UNVERIFIED | **Peta proteksi kontrak punya 6 klaim tanpa assertion** (lihat tabel Gap proteksi di `docs/TERMINAL_CONTRACT.md` §"Gap proteksi") — I14-saat-menciut, spacer, I5 popup-yatim, I20 label, I26 di proyeksi, I2/I6/I28 di linear/ACP | Menutup gap = menambah test (pekerjaan implementasi, di luar ruang lingkup audit dokumentasi) |
| B-4 | UNVERIFIED | **Gate penuh belum dijalankan pada revisi ini.** Lihat §8 — hanya targetted + satu `bun test` penuh. Status `gate:coverage`/`gate:pack` **tidak diklaim hijau** | Menjalankan `bun run gate:coverage` + `bun run gate:pack` pada working tree bersih |
| B-5 | UNVERIFIED (pre-existing, **di luar ruang lingkup**) | **`package.json` `files` = `"docs/*.md"` (globs) merusak `test/release-readiness.test.ts`** (2 gagal: entri `files` dengan glob tak bisa di-resolve sebagai path literal). Ini perubahan *in-flight* yang sudah ada sebelum audit dimulai — bukan hasil pekerjaan dokumentasi ini. Paket npm juga tak lagi menyertakan `PLAN.md`/`AGENTS.md` ( disengaja; `docs/changelog.md` sudah disesuaikan) | Keputusan pemilik: dukung glob di `files` (ubah test) atau ganti `files` dengan daftar eksplisit. **Audit ini tidak mengubah skrip packaging, `package.json`, atau test tersebut** (§8 batas perubahan) |
| B-6 | UNVERIFIED | `test/env-docs.test.ts` mengecualikan `MINICODE_FOOTER` dari daftar — tetapi `MINICODE_FOOTER` **tak lagi dibaca kode mana pun** (hanya disebut di komentar `scripts/coverage-gate.ts:50`). Exemption itu usang | Perbarui `EXEMPT` (pekerjaan test, di luar ruang lingkup dokumentasi) |
| B-7 | UNVERIFIED | **Publikasi npm `minicode-ai@0.12.0` tak dapat diverifikasi dari repo.** Tag `v0.12.0` **ada** (commit `cb633e4`, 2026-09-25, ancestor HEAD) — jadi rilis *ditandai*, tapi apakah tarball-nya benar-benar terbit ke registry tak terbukti dari isi repo | Cek registry npm (`npm view minicode-ai@0.12.0`) — di luar repo, tidak dijalankan audit ini |
| B-8 | OWNER_DECISION_REQUIRED | **`docs/agents.md` = `docs/AGENTS.md`** (filesystem case-insensitive). Nama berkas bisa disalahbaca sebagai instruksi agent | Rename (mengubah ~20 link) atau catatan konvensi. Tidak dikerjakan: di luar ruang lingkup dan berisiko merusak link |

---

## 8. Validasi yang dijalankan

Semua perintah dijalankan dari root repo (`D:\Github\minicode`) pada
`2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4` + working tree in-flight.

| # | Perintah | Exit code | Hasil |
|---|---|---|---|
| V-1 | `bun test test/architecture-map.test.ts test/p1-hygiene.test.ts test/p2-daemon-guards.test.ts test/ui-boundary.test.ts` | **0** | 33 pass / 0 fail — peta HTML tetap memenuhi penjaga mesin (nama berkas `src/**`, pin kernel, count `g-runtime`, peta daemon, batas lapisan) |
| V-2 | `bun test test/web-build.test.ts test/env-docs.test.ts test/import-convention.test.ts` | **0** | 68 pass / 0 fail — SUMMARY/nav situs utuh, kelengkapan env docs utuh, BOM/EOL utuh |
| V-3 | Pemeriksa tautan relatif (skrip audit, 213 berkas `.md`/`.html`, 161 tautan relatif) | **1 → 0** | Run awal (212 berkas): **24** tautan "rusak" = **2** tautan ke laporan audit ini yang belum ada (`AGENTS.md`, `PLAN.md`) + **22** URL absolut-situs (`/docs/*.html`, `/blog/*.html` di `content/blog/` + `web/layout.html`) yang memang path situs, bukan path filesystem. Setelah laporan dibuat + tautan absolut-situs dikecualikan: **0 tautan rusak / 161 diperiksa** |
| V-4 | `bun bench/harness-audit.ts --json` | 0 | `passed: 60, failed: 0, advisories: 2` — dasar koreksi "60 pass + 2 advisory" |
| V-5 | `bun -e` import `src/tools/index.ts` | 0 | `allTools.length = 37` |
| V-6 | `bun -e` import `src/providers/presets.ts` | 0 | `GATEWAY_PRESETS.length = 14` |
| V-7 | `bun -e` import `src/tools/task.ts` | 0 | `EXPLORE_TOOL_NAMES.length = 12` |
| V-8 | Hitung `READONLY_TOOLS` di `src/policy/permission.ts:31` | — | **18** entri (gerbang izin) |
| V-9 | Hitung `CRITICAL_FILES` di `scripts/coverage-gate.ts` | — | **19** entri |
| V-10 | Hitung baris env table HTML sebelum koreksi | — | 27 baris (vs 42 `MINICODE_*` dibaca kode) |
| V-11 | `bun test` (full suite, working tree) | lihat §8.1 | Dijalankan untuk memotret status gerbang saat ini — **bukan** untuk menyatakan dokumentasi selesai |
| V-12 | `git diff --check` | **0** | Tidak ada whitespace error (warning CRLF `TERMINAL_CONTRACT.md` ikut hilang setelah normalisasi EOL — lihat §9.1) |
| V-13 | `git diff --stat` / `git diff --name-status` / `git status --short` | 0 | Lihat §9 |
| V-14 | `bun test` terarah 14 berkas peta proteksi kontrak (terminal-contract, errors-usage, checkpoint-lifecycle, 6× work-mode, collapse, presentation-expand, presentation-store, tui-format, tui-lang) | **0** | **302 pass / 0 fail** — setiap test yang disebut di peta proteksi yang diperbarui dijalankan dan hijau |
| V-15 | Bandingkan output generator changelog situs (`parsePlanStatus` dari `scripts/web/changelog.ts`) atas `PLAN.md` HEAD vs `PLAN.md` sekarang | 0 | **33 entri → 33 entri; 0 ditambah, 0 dihapus, 0 prosa berubah.** Perubahan `PLAN.md` **tidak merusak** pipeline changelog situs |

**Tidak dijalankan (dan tidak diklaim):** `bun x tsc --noEmit`, `bun run lint`,
`bun run gate:coverage`, `bun run gate:pack`, `bun run gate:bash`, `bun run extreme`,
`bun run gate:slow`, `bun run test:live`, `bun run test:qa`. Alasan: (a) instruksi
audit melarang menjalankan ulang suite/coverage mahal "hanya demi menyatakan
dokumentasi selesai"; (b) `gate:coverage` menjalankan `bun test --coverage`
 penuh (menit, bukan detik) dan `gate:pack` memanggil `npm pack --dry-run`;
(c) `test:live`/`test:qa` memanggil provider eksternal — dilarang; (d) working
tree berisi 70 berkas perubahan kode in-flight yang **bukan** milik audit ini,
sehingga hasil gate tidak dapat diatribusikan ke perubahan dokumentasi.

### 8.1 Status full-suite (V-11) — **belum tuntas, tidak diklaim hijau**

`bun test` penuh dijalankan di background dengan anggaran waktu 15 menit dan
**tidak selesai dalam anggaran itu** (proses dihentikan oleh batas waktu, bukan
oleh kegagalan). Yang teramati sampai saat itu:

- **1 kegagalan** yang tercatat:
  `test/phase6v-adversarial-audit.test.ts` → "§28.1 500 trigger/cycle iterations:
  no drift, no growth, no wedge" — **timeout 5000 ms** (test stabilitas
  jangka-panjang; bukan terkait dokumentasi).
- **2 kegagalan terpisah**, terverifikasi via run terarah:
  `test/release-readiness.test.ts` → "setiap entri `files` ada di repo
  (case-sensitive)" + "tanpa skrip lifecycle install". Penyebab: `package.json`
  `files` = `"docs/*.md"` (glob) — **perubahan in-flight yang sudah ada sebelum
  audit dimulai**, bukan hasil pekerjaan ini (lihat B-5).
- Angka total pass/fail **tidak dapat dicatat** karena run tidak selesai.

**Kesimpulan jujur: status gerbang penuh pada revisi ini TIDAK terverifikasi
hijau.** `gate:coverage` dan `gate:pack` tidak dijalankan (§8). Semua kegagalan
yang teramati dapat ditelusuri ke working tree in-flight, **bukan** ke perubahan
dokumentasi ini.

### 8.2 Verifikasi silang peta proteksi kontrak (V-14)

| Perintah | Exit | Hasil |
|---|---|---|
| `bun test test/terminal-contract.test.ts test/errors-usage.test.ts test/checkpoint-lifecycle.test.ts test/work-mode-{runtime,contract,tool-visibility,cli,hooks,subagent}.test.ts test/collapse.test.ts test/presentation-expand.test.ts test/presentation-store.test.ts test/tui-format.test.ts test/tui-lang.test.ts` | **0** | **302 pass / 0 fail / 1436 expect()** — seluruh test yang disebut di peta proteksi yang diperbarui dijalankan dan hijau |

---

## 9. Status Git akhir & ringkasan diff

### 9.1 Ringkasan diff

Tidak ada commit, amend, push, reset, clean, stash, checkout, atau rebase.
Branch tetap `main`, HEAD tetap `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`.

**Perubahan dokumentasi yang dibuat oleh audit ini — 25 berkas modifikasi + 1
berkas baru:**

```
 AGENTS.md                          |  44 ++++++++++++++-
 PLAN.md                            |  90 ++++++++++++++++------
 README.md                          |   6 +-
 docs/ARCHITECTURE.html             | 111 ++++++++++++++-----------------------
 docs/CONTROL-PLANE-MAP.md          |   2 +-
 docs/HARNESS.md                    |   2 +-
 docs/README.md                     |   6 +-
 docs/SUMMARY.md                    |   5 +-
 docs/TERMINAL_CONTRACT.md          | 106 ++++++++++++++++++++++++++---------
 docs/UI_RENDER_PIPELINE.md         |   4 +-
 docs/architecture.md               |   6 +-
 docs/choosing-mode.md              |   4 +-
 docs/cli.md                        |  14 +++--
 docs/concepts.md                   |   2 +-
 docs/contributing.md               |  11 +++-
 docs/environment.md                |   2 +-
 docs/exec.md                       |   2 +-
 docs/policy-sandbox.md             |   2 +-
 docs/pricing-budget.md             |   2 +-
 docs/quickstart.md                 |   2 +-
 docs/repl.md                       |   2 +
 docs/security-model.md             |   2 +-
 docs/security.md                   |   2 +-
 docs/skills.md                     |   4 +-
 docs/terminal.md                   |   8 ++-
```
(+ `docs/REPOSITORY_DOCUMENTATION_AUDIT_2026-10-21.md` — baru, untracked)

**Perubahan produk di luar ruang lingkup: 0.** `git status --short` akhir
menampilkan berkas non-dokumentasi yang termodifikasi
(`biome.json`, `cli/**`, `src/**`, `test/**`, `scripts/**`, `package.json`) —
**semuanya sudah termodifikasi sebelum audit ini dimulai** (terlihat di
preflight §1) dan **tidak satu pun disentuh oleh pekerjaan dokumentasi ini**.
Tidak ada ambang gate yang diturunkan, tidak ada assertion test yang
didelemahkan, tidak ada kode runtime/CLI/TUI/kebijakan keamanan/skema DB/
konfigurasi produk/dependency/lockfile yang diubah.

Dua berkas dokumentasi **tidak** disentuh audit ini meski muncul di diff:
`docs/OUTPUT_IMPLEMENTATION_PLAN.md` dan `docs/changelog.md` — keduanya sudah
termodifikasi in-flight sebelum audit dimulai (§1) dan perubahannya justru
konsisten dengan implementasi (budget 3,5 MiB).

**Normalisasi EOL:** `docs/TERMINAL_CONTRACT.md` sebelumnya masih CRLF di
working tree (warisan in-flight; `.gitattributes` mensyaratkan LF). Dinormalkan
ke LF — **isi diff tidak berubah** (git menormalkan kedua sisi saat
perbandingan), dan `git diff --check` kini bersih tanpa warning.

### 9.2 Status akhir

| Aspek | Status |
|---|---|
| Branch | `main` (tidak berubah) |
| HEAD | `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4` (tidak berubah) |
| Commit / amend / push | **Tidak ada** |
| Reset / clean / stash / checkout / rebase | **Tidak ada** |
| `git diff --check` | **exit 0**, tanpa whitespace error |
| Tautan relatif rusak (213 berkas `.md`/`.html`) | **0** |
| Penjaga mesin peta arsitektur | 33 pass / 0 fail |
| Penjaga situs + env docs + konvensi_import | 68 pass / 0 fail |
| Test peta proteksi kontrak (14 berkas) | 302 pass / 0 fail |
| Gerbang penuh | **TIDAK diklaim hijau** — `bun test` penuh tidak selesai dalam anggaran 15 menit; `gate:coverage`/`gate:pack` tidak dijalankan (§8.1, B-4) |
| Blocker pemilik | B-1 (master roadmap belum masuk repo) · B-2 (P12 closure formal belum ada) |
