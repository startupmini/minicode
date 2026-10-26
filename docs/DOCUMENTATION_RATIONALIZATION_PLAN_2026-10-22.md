# Documentation Rationalization Plan — 2026-10-22

> **JENIS DOKUMEN: PROPOSAL UNTUK REVIEW PEMILIK — TIDAK MEBAKAPKAN APA PUN.**
>
> Laporan ini adalah **analisis dan rencana**, bukan implementasi. Tidak ada
> berkas dokumentasi, kode, tes, skrip, metadata paket, atau konfigurasi yang
> dipindah, diubah, diarsipkan, atau dihapus. **Satu-satunya perubahan file
> di tahap ini adalah berkas proposal ini.**
>
> Dokumen ini **tidak** menetapkan status fase, tidak mengubah definisi Big
> Phase, prioritas, penomoran, dependensi, atau definition of done milik
> pemilik, dan **tidak** mengklaim `ROADMAP.md` sudah committed.

---

## 0. Status, bukti, dan batasan

### 0.1 Status repo saat analisis

| Item | Nilai |
|---|---|
| Branch | `main` |
| HEAD | `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4` (`test: harden PTY SGR end-to-end coverage`) |
| Working tree | Tidak bersih — **95 tracked modified + 4 untracked**, 0 staged |
| Untracked | `ROADMAP.md` · `docs/REPOSITORY_DOCUMENTATION_AUDIT_2026-10-21.md` · `scripts/pack-budget.ts` · `test/checkpoint-lifecycle.test.ts` |
| Corpus dokumen | **210 `.md`** (113 root · 53 `docs/` · 17 `docs/audit/` · 3 `docs/design/` · 15 `docs/design/adr/` · 6 `content/blog/` · 3 di `bench/`+`web/`) + **3 `.html`** |

### 0.2 Prasyarat yang BELUM terpenuhi (dinyatakan, bukan dipalsukan)

Tugas ini menyatakan *"Agent A must first finish its integrated Quality
Remediation validation and provide its final handoff. Start this task only
after that handoff. Do not work concurrently with Agent A's final gate
sequence."*

**Prasyarat itu belum terpenuhi pada saat analisis ini dibuat.** Bukti:

- `Get-CimInstance Win32_Process` menunjukkan **PID 13696 = `bun test`** yang
  mulai **09:03:04** pada 2026-10-22 dan masih berjalan (37,9 s CPU) — itu
  full-suite Agent A. Proses turunan `bun cli/index.ts mcp serve` (PID 15448)
  dan `child.ts xp-d crash` (PID 1048) mengonfirmasi suite sedang berjalan.
- Tidak ada dokumen handoff Stage 10 di repo (tidak ada `*STAGE*10*.md`,
  tidak ada `*HANDOFF*.md` baru).
- `test/cli-session.test.ts` berubah pada 2026-10-22 (pekerjaan Agent A, bukan
  milik saya).

**Yang saya lakukan untuk tidak mengganggu gate Agent A:**

- Analisis 100% **read-only** terhadap repo.
- **Tidak** menjalankan `bun test`, `bun run gate:coverage`, `bun run gate:pack`,
  `bun run web:build`, atau `bun run web:check` (ketiganya menulis ke `site/`
  atau menjalankan suite penuh — akan berebut dengan Agent A).
- Validasi memakai skrip read-only sendiri (§9).
- Penulisan berkas ini **atomik** (tulis → `rename`), sehingga `bun test` Agent
  A tidak mungkin membaca berkas setengah jadi.
- Isi berkas ini **tidak memakai nested list** (indented bullet), karena
  `test/web-build.test.ts:234-247` memindai **seluruh** `docs/*.md` dan gagal
  bila ada baris yang cocok `/^\s+[-*] /`.

**Konsekuensi untukinterpretasi laporan:** ini adalah **snapshot** atas working
tree yang sedang berubah. Angka dan status harus di-revalidasi setelah handoff
Agent A, khususnya §2.1 (jumlah `docs/*.md`), §6 (disposisi), dan §8 (rencana
Migrasi).

### 0.3 Bukti yang dipakai

| Sumber | Kegunaan |
|---|---|
| `docs/REPOSITORY_DOCUMENTATION_AUDIT_2026-10-21.md` | Inventaris + matriks klaim → audit sebelumnya |
| Source aktual (`src/`, `cli/`, `scripts/`, `package.json`, `.github/workflows/`) | Pembuktian staleness (§4) |
| `bun -e "import …"` | Hitung nilai mesin (jumlah tool, event, preset, mode) |
| `npm pack --dry-run --json` | Manifest tarball sebenarnya (§7) |
| Grep seluruh repo (826 berkas terlacak) | Peta dependensi & densitas referensi (§8) |
| Inspect baseline (Agent B) | Laporan `web:check` Stage 10: title 79 char > limit 65 |

---

## 1. Temuan eksploratif yang memengaruhi rencana

### 1.1 Koreksi terhadap audit sebelumnya — dua cacat milik saya sendiri

Audit 2026-10-21 melaporkan C-01 (`Peta HTML mengklaim v6 / I1-I30 → Diperbaiki`)
sebagai **selesai**. Verifikasi ulang pada 2026-10-22 menunjukkan klaim itu
**hanya separuh benar**, dan keduanya harus dicatat terbuka:

| Temuan | Bukti | Konsekuensi |
|---|---|---|
| **§06 env var `docs/ARCHITECTURE.html` rusak** | L984 masih berisi lede lama *"25 variabel `MINICODE_*` + `NO_COLOR`"*; L985 lede baru; L986 hint baru; **L987 `</div>` yatim**; L988 hint lama terduplikasi | Dua lede bertentangan, satu blok HTML tidak balance, satu fakta diduplikasi. Tidak tertangkap test mana pun (§3.3) |
| **§09 tabel invariant `docs/ARCHITECTURE.html` tidak pernah diupdate** | 24 baris (L1069-1095), **byte-identik dengan HEAD**; kontrak punya **35** | Rows 1-24 saja; I25-I35 tidak ada; baris 10/12/13/14/17/18/19 duplikat atau off-by-one; **baris 5 mengklaim I5 dijaga 3 test** sementara kontrak menyatakan I5 = *"Tak terverifikasi"* |

Keduanya berasal dari penggantian blok yang salah batas pada edit sebelumnya
(saya menyisakan blok lama di luar rentang penggantian). **Ini cacat saya, bukan
cacat repo.** Nandakan sebagai Batch M0 (§8) — batch pertama, sebelum yang lain.

### 1.2 Pola berulang: "angka & daftar yang di-copy manual"

Repo punya aturan sendiri ("angka mesin jangan ditulis di markdown" —
`docs/contributing.md:84`), tetapi **18 nilai mesin** masih ditulis manual di
≥2 tempat, dan **6 di antaranya sudah salah**:

| Nilai | Salinan | Nilai sebenarnya | Sumber kebenaran |
|---|---|---|---|
| Jumlah event presentasi | `docs/architecture.md:122` "25 semantic event types" · `docs/CANONICAL_TASK_MODEL_DESIGN.md:32` "22 dari 25" | **26 total, 23 durable** (non-durable: `model.delta`, `reasoning.delta`, `tool.progress`) | `src/presentation/events.ts` `DURABILITY` |
| Prefix token GitHub | `docs/security.md:48` "`ghp-`" · 3 dok lain "`ghp_`" | **`ghp_`** (underscore) | `src/policy/scrub.ts:16` |
| Field `source` envelope | `docs/OUTPUT_PROTOCOL_SPEC.md:133` `"runtime"` | **`"derived"`** — nilai yang tak pernah diemitted | `src/presentation/projection.ts:583,600,799`; `test/presentation-policy.test.ts:243` |
| Lantai Bun | `docs/README.md:41` "Bun 1.0 ke atas" · `docs/glossary.md:32` "Bun ≥ 1.0" | **`>=1.1.13`** (hard-fail di `cli/index.ts:107`) | `package.json:43` |
| Jumlah variabel env | `docs/ARCHITECTURE.html:984` "25 variabel" | **42** dibaca kode | `docs/environment.md` (kanonik) |

Pola yang sama di `{tool count 37, readonly 18, explore 12, preset 14,
harness 60, harga 25, model 3.162, korpus bash 62/24}` — semua **saat ini
benar**, semua **disalin manual**, semua **tanpa penjaga**.

---

## 2. Inventaris kanonik

### 2.1 Klasifikasi corpus

| Kelas | Lokasi | Jumlah | Status |
|---|---|---|---|
| **Instruksi operasional** | `AGENTS.md` | 1 | aktif |
| **Roadmap otoritas** | `ROADMAP.md` | 1 | **draft working-tree, belum di-commit** |
| **Ledger legacy** | `PLAN.md` | 1 | aktif sebagai arsip milestone |
| **Panduan pengguna (dipublikasikan)** | 28 berkas di `docs/` | 28 | aktif, dipublikasi ke situs + npm |
| **Kontrak normatif** | `docs/TERMINAL_CONTRACT.md` | 1 | FROZEN |
| **Referensi arsitektur** | `docs/ARCHITECTURE.html`, `docs/architecture.md` | 2 | aktif |
| **Spesifikasi internal** | `docs/OUTPUT_*.md` (6), `docs/CONTROL-PLANE-MAP.md`, `docs/UI_RENDER_PIPELINE.md`, `docs/HARNESS.md`, `docs/autonomous-scheduler.md` | 10 | aktif, tidak dipublikasikan |
| **Laporan audit (checkpoint-bound)** | `docs/REPOSITORY_DOCUMENTATION_AUDIT_2026-10-21.md`, `docs/audit/**` (17), `docs/design/**` (3), `docs/design/adr/**` (15) | 36 | historis / terikat checkpoint |
| **Laporan fase & QA legacy** | root `P*.md` (52), root `PHASE-*.md` (47) | 99 | historis, terikat checkpoint |
| **Rancangan presentasi lama** | root `AGENT_PRESENTATION_*.md` | 3 | historis, dessen oleh `docs/OUTPUT_*` |
| **Laporan fondasi repo** | root `RECOVERY-*`, `CANONICAL_REPO_*`, `FULL_LEGACY_*`, `FILESYSTEM-SAFETY-DESIGN.md` | 5 | historis |
| **Roadmap legacy** | `P3_ROADMAP.md` | 1 | historis-aktif (scope authority P3) |
| **Spesifikasi task** | `docs/TASK_*.md` (9), `docs/CANONICAL_TASK_*.md` (2) | 11 | historis, tidak dipublikasikan |
| **Stub/arsip** | `docs/USAGE.md`, `docs/PLAN_UIUX_V6.md`, `docs/changelog.md` | 3 | arsip/stub |
| **Sumber generator situs** | `docs/SUMMARY.md`, `content/blog/*.md` (6), `web/*.html` | 9 | generator input |
| **Changelog** | `CHANGELOG.md` | 1 | riwayat rilis |
| **Kontributor** | `CONTRIBUTING.md`, `docs/contributing.md` | 2 | aktif |

### 2.2 Distribusi tinta

| Lokasi | `.md` | Ukuran | Catatan |
|---|---|---|---|
| root (tanpa `docs/`) | 113 | ~2,3 MiB | **99 di antaranya laporan fase/QA legacy** |
| `docs/` (top level) | 53 | ~440 KiB | 18 tidak dipublikasikan |
| `docs/audit/` | 17 | ~290 KiB | |
| `docs/design/` + `adr/` | 18 | ~75 KiB | |
| `content/blog/` | 6 | ~24 KiB | |

---

## 3. Peta sumber kanonik

> Aturan: **satu fakta normatif = satu dokumen.** Dokumen lain boleh
> meringkas pada fidelitas lebih rendah **hanya bila** menunjuk ke kanonik.

| Topik | **Kanonik** | Harus menunjuk ke kanonik |
|---|---|---|
| Terminal/TUI contract | `docs/TERMINAL_CONTRACT.md` (FROZEN) | `docs/terminal.md`, `docs/architecture.md`, `docs/ARCHITECTURE.html` §09, `docs/repl.md` |
| Struktur & ekspor modul | `docs/ARCHITECTURE.html` | `docs/architecture.md`, root `README.md` |
| Env var | `docs/environment.md` | `docs/cli.md`, `docs/terminal.md`, `docs/ARCHITECTURE.html` §06 |
| Permission mode | `docs/policy-sandbox.md` | `docs/security.md`, `docs/security-model.md`, `docs/choosing-mode.md`, `docs/repl.md` |
| Model threat | `docs/security-model.md` | `docs/security.md` |
| Tool & capability | `docs/tools.md` | `docs/agents.md`, `docs/mcp-lsp.md`, `docs/glossary.md` |
| CLI & flag | `docs/cli.md` | `docs/getting-started.md`, `docs/quickstart.md`, `docs/exec.md` |
| Konfigurasi & lokasi data | `docs/config.md` | `docs/getting-started.md`, `docs/ARCHITECTURE.html` §07 |
| Slash command & keybinding | **belum ada kanonik** → `cli/commands.ts` adalah sumber | `docs/repl.md`, `docs/ARCHITECTURE.html` |
| Machine envelope | `docs/OUTPUT_PROTOCOL_SPEC.md` | `docs/exec.md`, `src/presentation/projection.ts` |
| Model presentasi | `docs/OUTPUT_EVENT_MODEL.md` | `docs/architecture.md`, `docs/OUTPUT_ARCHITECTURE_AUDIT.md` |
| Roadmap arsitektur | `ROADMAP.md` (owner) | `AGENTS.md`, `PLAN.md`, `docs/architecture.md` |
| Ledger legacy | `PLAN.md` | `ROADMAP.md` §8 |
| Arsitektur output | `docs/OUTPUT_ARCHITECTURE_AUDIT.md` | 5 dokumen `OUTPUT_*` lain |
| Gate & kontribusi | `AGENTS.md` | `docs/contributing.md`, `docs/ARCHITECTURE.html` §06 |
| Scheduler otonom | `docs/autonomous-scheduler.md` | `docs/cli.md`, `docs/repl.md`, `docs/architecture.md` |

**Temuan arsitektur informasi:** **tidak ada kanonik untuk slash command &
keybinding** — `docs/repl.md` adalah transkripsi manual dari
`cli/commands.ts` (`KEYBOARD_HELP` L164-184, `BUILTIN_COMMANDS` L129-138,
`DRIVER_HELP_COMMANDS` L147-161) tanpa penjaga. Minute, drift, dan tak ada
cara meng Generatesinya.

---

## 4. Matriks redundansi

> **Harmful** = duplikasi yang bisa berbeda antar dua tempat dan akibatnya adalah
> perilaku/dokumen yang salah. **Useful summary** = peringkasan berpelilu
> lebih rendah yang menunjuk ke kanonik.

### 4.1 Redundansi harmful (memang berbeda saat ini)

| # | A | B | Nature | Drift saat ini | Verifikasi |
|---|---|---|---|---|---|
| R-01 | `docs/ARCHITECTURE.html` §09 (L1069-1095) | `docs/TERMINAL_CONTRACT.md` §Invariant + §Peta proteksi + **§Gap proteksi** | Salinan **normatif**, bukan ringkasan | **Ya, 6+ cara**: I1/I3/I13/I14 dobel; I10 salah; I12 ≠ I7; baris 17/18/19 off-by-one; **I25-I35 hilang**; baris 5 klaim I5 dijaga 3 test — kontrak bilang *"Tak terverifikasi"* | `git diff` → tabel byte-identik HEAD |
| R-02 | `docs/security.md:48` | `docs/policy-sandbox.md:71`, `docs/glossary.md:26`, root `README.md:149` | Daftar pola redaksi | **Ya**: `ghp-` vs `ghp_` | `src/policy/scrub.ts:16` |
| R-03 | `docs/OUTPUT_PROTOCOL_SPEC.md:133` | `docs/exec.md:11,73` | Field envelope machine | **Ya**: `source:"runtime"` vs `"derived"`; `exec.md` omit `source`+`visibility` | `src/presentation/projection.ts:583` |
| R-04 | `docs/architecture.md:122` | `docs/CANONICAL_TASK_MODEL_DESIGN.md:32` | Jumlah event presentasi | **Ya**: 25/22 vs **26/23** | `DURABILITY` |
| R-05 | `docs/README.md:41`, `docs/glossary.md:32`, `CONTRIBUTING.md:14` | `docs/getting-started.md:3`, `docs/contributing.md:16`, root `README.md:37` | Lantai runtime | **Ya**: "1.0" vs **">=1.1.13"** | `package.json:43` |
| R-06 | `docs/TASK_IDENTITY_SPEC.md:86-88` | `docs/TASK_MUTATION_SEMANTICS.md:162-165` | Aturan match task | **Ya, saling meniadakan**: "key **terbesar**" vs "`updatedAt` **terkecil**" | — |
| R-07 | `docs/TASK_EVENT_MODEL.md:61-63` | `docs/TASK_EVENT_MODEL.md:82` | Nama event | **Ya**: `task.completion_claimed` (tak ada di repo mana pun) vs `task.claimed` | grep repo |
| R-08 | root `README.md:5`; `content/blog/2026-09-10-kenapa-shell-native.md:8`; `content/blog/2026-09-17-...:24` | `docs/TERMINAL_CONTRACT.md:38-41` (I1), `docs/terminal.md:11-16` | Deskripsi model interaksi | **Ya**: "shell-first / output linier di scrollback" vs kontrak "**satu-satunya** tampilan interaktif = TUI fullscreen" | `CHANGELOG.md:162` menunjukkan `docs/` pernah disinkronkan — **root README & blog tidak** |
| R-09 | `docs/ARCHITECTURE.html` §06 (L984-988) | `docs/environment.md` (kanonik, dijaga `test/env-docs.test.ts`) | Tabel env | **Ya**: "25 variabel" vs 42; plus blok dobel + `</div>` yatim | `test/env-docs.test.ts` |
| R-10 | `docs/security.md` L18-37 (18 baris) | `docs/policy-sandbox.md` L26-38 (11 baris) | Tabel aturan bash-guard | **Ya**: 7 baris hilang di tabel pendek (redirect target, `%NAMA%`, `py -c`, hardlink, caret-escape, reader `%NAMA%`, `for /f`) | `src/policy/bash-guard.ts` |
| R-11 | `docs/security.md:41` | `docs/policy-sandbox.md:69`, `docs/troubleshooting.md:17` | Allowlist env yang di-keep | **Ya**: 5 nama vs 3 nama (`GITHUB_REF`, `GOOGLE_CHROME_PATH` hilang) | `src/policy/scrub.ts:89-90` |
| R-12 | `docs/memory-sessions.md:42`, `docs/security-model.md:24,68` | `docs/security.md:84`, `docs/glossary.md:18` | State machine jurnal | **Ya**: 3 varian; `security.md:84` & `glossary.md:18` **drop state `failed`** lalu kalimat berikutnya menyebut `failed` | — |
| R-13 | `docs/security-model.md:31` | `docs/policy-sandbox.md:12` | Baseline mode `ask` | **Ya**: "Sama seperti `auto`" vs "Readonly + `NO_PROMPT_TOOLS`" | — |
| R-14 | `docs/security-model.md:34` | `docs/policy-sandbox.md:15` | Semantik tulis-file mode `allowlist` | **Ya**: "+ tulis terjail" vs "sesuai set" (vague) | — |
| R-15 | `docs/cli.md:102-113` | `docs/config.md:7-18` | Contoh schema `.minicode/config.json` | Kode blok **byte-identik** | — |
| R-16 | `docs/config.md:40-56` (11 baris) | `docs/ARCHITECTURE.html` §07 (8 baris); `docs/getting-started.md:92-97` | Inventaris path persisten | **Ya**: HTML punya fallback global session-DB, dua dok lain tidak; HTML tidak menyebut `vector.db`, `repomap.json`, `step-traces.jsonl`, `.trash/` | `src/lib/db-path.ts`, `src/session/persistence.ts:14` |
| R-17 | `docs/repl.md:42-62` (19 baris) | `cli/commands.ts` `KEYBOARD_HELP` L164-184 | Tabel keyboard | **Ya**: 2 entri `home/end` digabung; `delete` saja vs `delete/backspace`; `mouse drag` tak ada di `/help` | — |
| R-18 | `docs/repl.md:14-34` | `cli/commands.ts` `BUILTIN_COMMANDS`/`DRIVER_HELP_COMMANDS`; `docs/ARCHITECTURE.html:658` | Registri perintah | **Hampir** sama; `/expand` didokumentasikan tapi tak ada di `/help` | — |
| R-19 | root `README.md:12-33` (tree) | `docs/ARCHITECTURE.html` §03 (dijaga `test/architecture-map.test.ts`); `docs/architecture.md` | Peta struktur | **Ya**: README kehilangan `src/app`, `src/task`, `src/runtime`, `src/presentation`, `src/daemon`, `src/memory`, `src/lib`, `src/repo`, `src/sandbox`, `src/telemetry`, `src/config.ts`, `src/constants.ts` | `git ls-files src` = 21 subdirektori |
| R-20 | `docs/architecture.md:3` | `docs/ARCHITECTURE.html` | Jumlah section peta | **Ya**: "9 section 00→09" vs **10** (Sekilas tanpa nomor + 01-09) | — |
| R-21 | `docs/autonomous-scheduler.md` (141 baris, **English**) | `docs/cli.md:59`, `docs/repl.md:34`, `docs/architecture.md:93` | Kontrak scheduler | Ya: kanonik **orphan** (tak ada di `docs/README.md` Navigasi, tak ada di `docs/SUMMARY.md`, nol markdown-link masuk) | — |
| R-22 | `docs/architecture.md:115` | `docs/terminal.md:35-40` | "Primitif tampilan" | Ya: 5 enumerated vs 6 | — |

### 4.2 Redundansi yang **berguna** (ringkasan berpelilu berbeda, menunjuk kanonik)

| # | Ringkasan | Kanonik | Status |
|---|---|---|---|
| U-01 | `docs/terminal.md`, `docs/architecture.md` §UI/UX | `docs/TERMINAL_CONTRACT.md` | **Sepakat** saat ini; ringkas benar |
| U-02 | Aturan batas lapisan di 5 tempat (`AGENTS.md`, `docs/architecture.md`, `docs/contributing.md`, `docs/UI_RENDER_PIPELINE.md`, `docs/ARCHITECTURE.html` §01) | `AGENTS.md` | **Sepakat**; beda ejaan ("dilarang" vs "DILARANG") |
| U-03 | Subset env var di `docs/cli.md:79-98`, `docs/terminal.md:71` | `docs/environment.md` | **Sepakat**; subset `cli.md` omit `MINICODE_WORK_MODE` padahal flag-nya didokumentasikan |
| U-04 | Tabel stdout/stderr di 3 tempat | `docs/TERMINAL_CONTRACT.md` | **Sepakat** |
| U-05 | Jumlah tool 37 / readonly 18 / explore 12 di 9 tempat | `src/tools/index.ts`, `src/policy/permission.ts:31`, `src/tools/task.ts` | **Sepakat** (9 salinan) |
| U-06 | `PLAN.md` vs `ROADMAP.md` | — | **Bersih**: `ROADMAP.md` §8 hanya tabel rekonsiliasi 4 baris, bukan salinan isi |

---

## 5. Matriks staleness

### 5.1 Obsolet (fungsi sudah selesai/berpindah)

| Path | Bukti obsolet | Catatan |
|---|---|---|
| root `AGENT_PRESENTATION_ARCHITECTURE_V2.md` (50 KiB) |/releases v2 yang digantikan v2.1 (`..._V2_1.md`) lalu digantikan `docs/OUTPUT_EVENT_MODEL.md` + `docs/OUTPUT_RENDERING_SPEC.md` + `docs/architecture.md` §Modul kunci | plans, bukan kontrak |
| root `AGENT_PRESENTATION_ARCHITECTURE_V2_1.md` (60 KiB) | idem | |
| root `AGENT_PRESENTATION_V2_1_IMPLEMENTATION_PLAN.md` (87 KiB) | idem | 3 file = 197 KiB, tak ada inbound link dari `docs/` |
| `docs/USAGE.md` (633 B) | Adalah **pointer**; 6 target masih ada; fungsi routing sudah ditutup `docs/README.md` §Navigasi + `docs/SUMMARY.md` (39 entri) | kandidat DELETE pertama (§10) |
| `docs/PLAN_UIUX_V6.md` | Arsip eksplisit; **dipublikasikan** ke situs + **dipaketkan** npm → URL publik hidup | KEEP AS HISTORICAL, jangan dihapus |
| `docs/changelog.md` (216 B) | Isi tak pernah dirender (`scripts/web/docs.ts:187` skip slug `changelog`); ada **hanya** untuk membuat route `/docs/changelog.html` dari `docs/SUMMARY.md:44` | KEEP — dimakan mesin |

### 5.2 Kontradiktif (terbukti di §4.1)

R-01, R-02, R-03, R-04, R-05, R-06, R-07, R-08, R-09, R-10, R-11, R-12, R-13, R-14, R-15, R-16, R-17, R-19, R-20, R-22 → **20 butir** (R-15 dan R-18 saat ini masih identik; sisanya sudah berbeda).

### 5.3 Tidak lengkap

| Path | Yang hilang | Bukti |
|---|---|---|
| `docs/environment.md` (kanonik) | `NO_UPDATE_CHECK=1`, `MINICODE_AUTO_UPDATE=0` | `src/policy/update-check.ts:20,147,149` — `test/env-docs.test.ts:29` hanya cocok `/process\.env\.(MINICODE_[A-Z0-9_]+)/`, jadi `env.MINICODE_AUTO_UPDATE` (destructured) lolos |
| `docs/OUTPUT_PROTOCOL_SPEC.md` | field `provenance?` | `src/presentation/projection.ts:587-588` |
| `docs/environment.md` | `MINICODE_FOOTER` masih ada di `EXEMPT` `test/env-docs.test.ts:19` padahal **tak lagi dibaca** kode mana pun | grep |
| `docs/ARCHITECTURE.html` | 11 invariant (I25-I35) | §4.1 R-01 |
| root `README.md` | 12 subdirektori `src/` | §4.1 R-19 |
| `docs/repl.md` | mode `allow-all` yang sah untuk `/mode` | `cli/tui.ts:58` |
| `docs/autonomous-scheduler.md` | tak terjangkau dari navigasi | R-21 |

### 5.4 Murni historis (benar pada masanya — **jangan diubah**)

Root `P*.md` (52), root `PHASE-*.md` (47), `docs/audit/**` (17),
`docs/design/**` (3), `docs/design/adr/**` (15), `P3_ROADMAP.md`,
`docs/TASK_*.md` (9), `docs/CANONICAL_TASK_*.md` (2), `CHANGELOG.md`.
Preservasi oleh instruksi pemilik; **jangan pernah ditulis ulang** untuk
"memperbaiki" angka yang sudah usang.

---

## 6. Disposisi

> Legenda: `KEEP` · `KEEP AS HISTORICAL` · `UPDATE` · `MERGE INTO CANONICAL
> SOURCE` · `REPLACE WITH POINTER` · `ARCHIVE CANDIDATE` · `RENAME CANDIDATE` ·
> `DELETE CANDIDATE`

### 6.1 Root

| Path | Disposisi | Alasan & dampak |
|---|---|---|
| `AGENTS.md` | **KEEP** (+UPDATE minor) | Instruksi operasional tunggal; 1 pembaca mekanis (`test/web-build.test.ts:345`). Isi sudah selaras dengan `ROADMAP.md`. Dampak: nol |
| `README.md` | **UPDATE** | R-05 (Bun floor), R-08 (shell-first), R-19 (tree), R-02 (`ghp_`). Wordsmith + konfirmasi `ghp_`; tree → pointer ke `docs/ARCHITECTURE.html`. Dampak: **tinggi** (root README = pintu masuk publik) |
| `ROADMAP.md` | **KEEP** | Otoritas roadmap pemilik; **untracked draft**. Perlu keputusan commit (§7.4). Dampak: nol |
| `PLAN.md` | **KEEP AS HISTORICAL LEDGER** | Diperlukan: `scripts/web/docs.ts:136` + `scripts/web/llms-full.ts:43` membacanya (path hard-coded). Dampak: nol bila path tidak berubah |
| `CHANGELOG.md` | **KEEP** | Riwayat rilis; sumber `site/docs/changelog.html` |
| `CONTRIBUTING.md` (747 B) | **REPLACE WITH POINTER** | Isinya diduplikasi `docs/contributing.md` (6.293 B) yang lebih lengkap & dipaketkan. Ganti isi root dengan 3 baris pointer. Dampak: rendah; **hapus** klaim "Bun ≥ 1.0" yang salah |
| root `P*.md` (52) | **ARCHIVE CANDIDATE** → `docs/archive/phase-reports/` | Fungsi: rekam closure/QA per checkpoint — sudah selesai, **dipakai** sebagai rujukan keputusan. Tidak ada yang "tidak perlu". Dampak: **TINGGI** bila dipindah (ratusan link silang) → lihat Batch M6 (opsional) + Batch M1 (indeks) |
| root `PHASE-*.md` (47) | **ARCHIVE CANDIDATE** → `docs/archive/recovery/` | idem |
| root `AGENT_PRESENTATION_*.md` (3) | **ARCHIVE CANDIDATE** → `docs/archive/presentation-plans/` | Digantikan `docs/OUTPUT_*` + `docs/architecture.md`. Dampak: rendah (nol inbound dari `docs/`) |
| root `RECOVERY-*`, `CANONICAL_REPO_*`, `FULL_LEGACY_*`, `FILESYSTEM-SAFETY-DESIGN.md` (5) | **ARCHIVE CANDIDATE** → `docs/archive/repo-foundation/` | idem |
| `P3_ROADMAP.md` | **KEEP AS HISTORICAL** | `ROADMAP.md` §4 baris P3: *"Pertahankan `P3_ROADMAP.md` … sebagai scope authority"* → **jangan** dipindahkan |

### 6.2 `docs/` — pengguna & kontrak

| Path | Disposisi | Alasan & dampak |
|---|---|---|
| `docs/TERMINAL_CONTRACT.md` | **KEEP** (normatif) | Kontrak FROZEN. **Jangan** diganti ringkasan. 28 inbound refs; `package.json:61` |
| `docs/terminal.md` | **KEEP** | Ringkasan pengguna yang benar → pointer ke kontrak (U-01). Dampak: nol |
| `docs/architecture.md` | **UPDATE** | R-04 (25→26 event), R-20 (section count), §5.3. Ringkasan → pointer. Dampak: sedang |
| `docs/ARCHITECTURE.html` | **UPDATE** | §1.1 (dua cacat), R-01, R-09, R-19. **Machine-bound** (`architecture-map`, `p1-hygiene`, `p2-daemon-guards`) |
| `docs/README.md` | **UPDATE** | R-05 (Bun floor); tambahkan baris audit/rationalization. Machine-bound: `test/web-build.test.ts:1068` |
| `docs/SUMMARY.md` | **KEEP** | Manifes navigasi tunggal. Machine-bound: `scripts/web/nav.ts:174`, `test/web-build.test.ts:30,845`, `.github/workflows/web.yml:10` |
| `docs/security.md` | **UPDATE** | R-02 (`ghp_`), R-11, R-12, R-13/14 |
| `docs/security-model.md` | **MERGE INTO CANONICAL SOURCE** (`docs/policy-sandbox.md`) | R-13, R-14, R-12. Setelah merge: **REPLACE WITH POINTER** |
| `docs/policy-sandbox.md` | **KEEP** (jadi kanonik permission mode) | R-10, R-11, R-13, R-14 — tabelnya harus lengkap (18 baris bash-guard) |
| `docs/cli.md` | **UPDATE** | R-15 (hapus blok schema → pointer `docs/config.md`), §5.3 |
| `docs/config.md` | **KEEP** (kanonik config + path) | R-15, R-16 |
| `docs/getting-started.md` | **KEEP** | Machine-bound `test/release-readiness.test.ts:103-119` |
| `docs/environment.md` | **UPDATE** | §5.3 — tambahkan `NO_UPDATE_CHECK`, `MINICODE_AUTO_UPDATE`; perbaiki guard `test/env-docs.test.ts` (regex) |
| `docs/repl.md` | **UPDATE** | R-17, R-18, §5.3 — atau **MERGE** ke sumber `cli/commands.ts` + generator |
| `docs/choosing-mode.md` | **UPDATE** | R-13 (baseline `ask`) |
| `docs/OUTPUT_PROTOCOL_SPEC.md` | **UPDATE** | R-03 (`source:"derived"`), §5.3 (`provenance?`) — **spec wire-format, konsumen mem-parsingnya** |
| `docs/CANONICAL_TASK_MODEL_DESIGN.md` | **UPDATE** | R-04 (22/25 → 23/26) |
| `docs/TASK_IDENTITY_SPEC.md` + `docs/TASK_MUTATION_SEMANTICS.md` | **UPDATE** (R-06) **atau KEEP AS HISTORICAL** | Dua aturan match saling meniadakan. Bila kanonik = `TASK_MUTATION_SEMANTICS.md` (dirujuk eksplisit), `TASK_IDENTITY_SPEC.md` harus menunjuk. **Perlu keputusan pemilik** (§11.1) |
| `docs/TASK_EVENT_MODEL.md` | **UPDATE** (R-07) **atau KEEP AS HISTORICAL** | `task.completion_claimed` → `task.claimed` |
| `docs/autonomous-scheduler.md` | **UPDATE** | R-21 — masukkan ke `docs/SUMMARY.md` + `docs/README.md` Navigasi. **Machine-bound**: `test/phase6ac-controlled-enablement.test.ts:348` |
| `docs/USAGE.md` | **DELETE CANDIDATE** | §10.1 — satu-satunya kandidat hapus di proposal ini |
| `docs/PLAN_UIUX_V6.md` | **KEEP AS HISTORICAL** | Dipublikasikan + dipaketkan; URL publik hidup |
| `docs/changelog.md` | **KEEP** | Dimakan mesin (route) |
| `docs/CONTROL-PLANE-MAP.md`, `docs/UI_RENDER_PIPELINE.md`, `docs/HARNESS.md`, 6× `docs/OUTPUT_*` | **KEEP** | Spesifikasi internal aktif |
| `docs/REPOSITORY_DOCUMENTATION_AUDIT_2026-10-21.md` | **KEEP AS HISTORICAL** | Snapshot pemeriksaan; **jangan** ditulis ulang |
| `docs/TASK_FOUNDATION_*.md` (4), `docs/TASK_ARCHITECTURE_AUDIT.md`, `docs/CANONICAL_TASK_IMPLEMENTATION_PLAN.md` | **KEEP AS HISTORICAL** | Laporan audit/plan; `TASK_FOUNDATION_TEST_MATRIX.md` near-orphan (1 inbound), `TASK_FOUNDATION_POST_AUDIT.md` orphan (1 inbound) → **indeks** (Batch M1) |

### 6.3 Templates & generator

| Path | Disposisi | Alasan |
|---|---|---|
| `web/layout.html`, `web/admin.html` | **KEEP** | Template situs — bukan dokumentasi |
| `content/blog/*.md` (6) | **UPDATE** (R-08 pada 2 berkas) | Sumber konten; 2 artikel masih mengklaim "REPL/shell-first" |
| `docs/SUMMARY.md` | **KEEP** | Manifes |

---

## 7. Struktur direktori yang diusulkan

### 7.1 Target

```text
/
├── README.md                     KEEP   (UPDATE isi)
├── AGENTS.md                     KEEP
├── ROADMAP.md                    KEEP   (keputusan commit)
├── PLAN.md                       KEEP AS LEGACY LEDGER
├── CHANGELOG.md                  KEEP
├── CONTRIBUTING.md               REPLACE WITH POINTER → docs/contributing.md
├── docs/
│   ├── SUMMARY.md                KEEP   (manifes navigasi)
│   ├── README.md                 KEEP   (hub)
│   ├── ARCHITECTURE.html         KEEP   (UPDATE)
│   ├── architecture.md           KEEP   (UPDATE)
│   ├── TERMINAL_CONTRACT.md      KEEP   (normatif, FROZEN)
│   ├── terminal.md … (25 lainnya) KEEP
│   ├── internal/                 BARU   ← 10 berkas spesifikasi internal
│   │   ├── OUTPUT_ARCHITECTURE_AUDIT.md
│   │   ├── OUTPUT_EVENT_MODEL.md
│   │   ├── OUTPUT_IMPLEMENTATION_PLAN.md
│   │   ├── OUTPUT_PROTOCOL_SPEC.md
│   │   ├── OUTPUT_RENDERING_SPEC.md
│   │   ├── OUTPUT_UX_RULES.md
│   │   ├── CONTROL-PLANE-MAP.md
│   │   ├── UI_RENDER_PIPELINE.md
│   │   ├── HARNESS.md
│   │   └── autonomous-scheduler.md
│   ├── task/                     BARU   ← 11 berkas spesifikasi task
│   │   ├── TASK_EVENT_MODEL.md … (9)
│   │   └── CANONICAL_TASK_*.md (2)
│   ├── audit/                    KEEP   (17)
│   ├── design/ + design/adr/     KEEP   (18)
│   └── archive/                  BARU   ← 107 berkas historis root
│       ├── phase-reports/        (52)  P*.md
│       ├── recovery/             (47)  PHASE-*.md
│       ├── presentation-plans/   (3)   AGENT_PRESENTATION_*.md
│       ├── repo-foundation/      (5)
│       └── legacy-roadmap/       (1)   P3_ROADMAP.md
└── content/blog/                 KEEP   (6)
```

### 7.2 Yang **tidak** berubah (stabilitas tautan publik)

Tidak ada berkas `.md` yang terdaftar di `docs/SUMMARY.md` yang dipindahkan —
karena `scripts/web/nav.ts:186` menurunkan **slug = nama berkas** dan
`scripts/web/docs.ts:249-250` menurunkan **route = `/docs/<slug>.html`**.
Memindahkan = mengganti URL publik. 39 route publik ada sekarang.

Pengecualian: `docs/OUTPUT_*.md` (6), `docs/CONTROL-PLANE-MAP.md`,
`docs/UI_RENDER_PIPELINE.md`, `docs/HARNESS.md` **sudah** SUMMARY dan **sudah**
dipublikasikan — maka memindahkannya ke `docs/internal/` **mengubah 6 URL
publik**. **Rekomendasi: jangan pindahkan yang sudah dipublikasikan.**
`docs/internal/` hanya untuk berkas yang **belum** dipublikasikan
(`docs/autonomous-scheduler.md` + 11 berkas task). Sisa 6 `OUTPUT_*` +
2 internal itu tetap di `docs/` atau dipindah dengan alias route.

### 7.3 Churn yang dihasilkan

| Batch | Berkasdipindah | Path publik berubah | Link silang harus ditulis ulang |
|---|---|---|---|
| M1 (indeks arsip) | 0 | 0 | 0 |
| M2 (`docs/task/`) | 11 | 0 (tak ada di SUMMARY) | ~20 |
| M3 (`docs/internal/`) | 1 | 0 | ~6 |
| M4 (`docs/archive/`) | 107 | 0 | ratusan (link silang antar laporan) |
| M5 (root `AGENT_PRESENTATION_*` + fondasi → arsip) | 8 | 0 | ~10 |

---

## 8. Dampak dependensi & referensi

### 8.1 Test yang membaca berkas dokumentasi (keras — rename/move = gagal)

| Test | Baris | Membaca | Dampak |
|---|---|---|---|
| `test/architecture-map.test.ts` | 25, 36 | `docs/ARCHITECTURE.html` | ENOENT → test error |
| `test/p1-hygiene.test.ts` | 298, 305 | `docs/ARCHITECTURE.html` | ENOENT; count `g-runtime` harus ikut |
| `test/p2-daemon-guards.test.ts` | 279 | `docs/ARCHITECTURE.html` | ENOENT |
| `test/env-docs.test.ts` | 38 | `docs/environment.md` | ENOENT |
| `test/web-build.test.ts` | 30-34, 845 | `docs/SUMMARY.md` (+ `readDocNav`) | ENOENT → semua pemanggil `readDocNav` error |
| `test/web-build.test.ts` | 239-246 | **seluruh** `docs/*.md` | Pindah keluar `docs/` → guard melemah diam-diam |
| `test/web-build.test.ts` | 257-265 | `docs/TERMINAL_CONTRACT.md`, `docs/TASK_EVENT_MODEL.md` | ENOENT |
| `test/web-build.test.ts` | 345-354 | root `AGENTS.md`, `PLAN.md`, `README.md`, `CONTRIBUTING.md` | ENOENT → test error |
| `test/web-build.test.ts` | 393 | `docs/agents.md` | ENOENT |
| `test/web-build.test.ts` | 807-830 | `PLAN.md` (lewat `parsePlanStatus`) | Parse kosong → changelog kosong, **tanpa test gagal** |
| `test/web-build.test.ts` | 844-856 | `docs/SUMMARY.md` + `site/llms-full.txt` | Urutan SUMMARY harus dijaga |
| `test/web-build.test.ts` | 1068 | `docs/README.md` | ENOENT |
| `test/phase6ac-controlled-enablement.test.ts` | 348 | `docs/autonomous-scheduler.md` | ENOENT |
| `test/release-readiness.test.ts` | 33-43 | entri `package.json files` | Rename → gagal |
| `test/release-readiness.test.ts` | 93-119 | `README.md`, `docs/getting-started.md` | ENOENT |

### 8.2 Kode non-tes yang membaca dokumentasi

| Skrip | Baris | Membaca | Konsekuensi rename `PLAN.md` |
|---|---|---|---|
| `scripts/web/nav.ts` | 174 | `docs/SUMMARY.md` | — |
| `scripts/web/docs.ts` | 136 | `PLAN.md` | **web:build gagal keras** → `publish.yml` **npm publish terblokir** |
| `scripts/web/docs.ts` | 188 | `docs/<file>` per SUMMARY | — |
| `scripts/web/llms-full.ts` | 29, 43 | `docs/<file>` + `PLAN.md` | section "Status eksekusi" hilang diam-diam; `test/web-build.test.ts:857` gagal |
| `scripts/web/blog.ts` | 34, 80 | `content/blog/*.md` | — |
| `scripts/build-web-css.ts` | 10, 17 | `web/part-*.css` → tulis `web/styles.css` | — |

**Catatanarchitectural:** `scripts/web/docs.ts:142` memakai **regex**
`/^## Status eksekusi.*$/m` (semua section), sementara
`scripts/web/llms-full.ts:44` memakai **literal split** (section pertama
sampai EOF). Dua permukaan changelog berasal dari **potongan berbeda** dari
berkas yang sama. Belum ada test yang membandingkan keduanya.

### 8.3 `PLAN.md` —-aturan parsing

`docs.ts:142` memotong pada setiap `## Status eksekusi*`; badan tiap section
dipotong di `## ` berikutnya; entri diambil dari bullet
`^- (?:✅|⏳) (.+)$` (`changelog.ts:23`); baris lanjutan = indent ≥2 spasi
(`changelog.ts:56-58`); batas entri = baris kosong/baris tak terindent.
Terdapat **2** heading yang cocok: `PLAN.md:393` dan `PLAN.md:448`.
**Renaming/moving `PLAN.md` = build website gagal keras = publish npm terblokir.**

### 8.4 Root `AGENTS.md` & `ROADMAP.md`

- `AGENTS.md`: **satu** pembaca mekanis (`test/web-build.test.ts:345`). Sisanya
  komentar/metadata string.
- `ROADMAP.md`: **nol** pembaca mesin di seluruh repo (skrip, tes, CI).
  Hanya prosa. Konsekuensi: **tidak dilindungi CI** — dan masih untracked.

### 8.5 CI

| Workflow | Baris | Perintah dokumentasi |
|---|---|---|
| `ci.yml` | 56-58 | `bun test` → semua test §8.1 |
| `ci.yml` | 92-94, 160-161 | `bun run gate:pack` → validasi `package.json files` + closure link `.md` |
| `ci.yml` | 126-129 | `bun run web:build` + `bun run web:check` |
| `web.yml` | 9 | trigger push pada `docs/*.md` (**tidak** mencakup `docs/audit/**`, `docs/design/**`) |
| `publish.yml` | 34-37 | `gate:pack` + `web:build` + `web:check` → **blokir publish** |

### 8.6 Densitas referensi inbound (`docs/*.md`)

Tier atas (≥10 inbound — hard to move): `TERMINAL_CONTRACT.md` (28),
`README.md` (23), `OUTPUT_PROTOCOL_SPEC.md` (13), `security.md` (13),
`environment.md` (12), `OUTPUT_ARCHITECTURE_AUDIT.md` (12),
`TASK_EVENT_MODEL.md` (11), `cli.md` (11), `exec.md` (11),
`policy-sandbox.md` (10), `architecture.md` (10).

Orphan / near-orphan (≤2 inbound, nol markdown-link): `TASK_FOUNDATION_POST_AUDIT.md` (1),
`TASK_FOUNDATION_TEST_MATRIX.md` (1), `TASK_FOUNDATION_GAP_MAP.md` (2),
`TASK_FOUNDATION_REPAIR_REPORT.md` (2), `CANONICAL_TASK_IMPLEMENTATION_PLAN.md` (2),
`TASK_MUTATION_SEMANTICS.md` (3), `autonomous-scheduler.md` (3, tetapi
**machine-bound**).

---

## 9. Daftar keputusan kemasan (product-owner)

> **Tidak ada konfigurasi kemasan yang diubah pada tahap ini.**

### 9.1 Manifest aktual (npm pack --dry-run --json, 2026-10-22)

275 berkas total; **38 `.md`**. `package.json` `files` mendaftarkan 35 `docs/*.md`
+ `README.md` + `CHANGELOG.md` + `LICENSE` + `vendor/minicore/VENDOR.md`.
**`docs/README.md` dan `docs/changelog.md` ikut terpasang secara implisit**
(aturan basename npm `readme*` / `changelog*`) — **tidak** tercantum di `files`,
jadi **tidak ada penjaga** yang memverifikasi keduanya.

### 9.2 Keputusan

| # | Item | Implikasiomit | Implikasi include | Rekomendasi | Status |
|---|---|---|---|---|---|
| P-1 | `ROADMAP.md` | Otoritas roadmap pemilik **tidak** sampai ke pengguna npm; agent yang menjalankan `minicode-ai` dari paket tak punya konteks fase | Ukuran paket naik ~66 KiB; `package.json files` bertambah → `test/release-readiness.test.ts:33-43` perlu sinkron | **OWNER DECISION** — saran: **tak sertakan** (roadmap adalah artefak repo, bukan dokumentasi pengguna); aktifkan `AGENTS.md` di root repo | Keputusan pemilik |
| P-2 | `AGENTS.md` | Instruksi agent untuk kontributor repo tidak tersedia di paket | ~4 KiB; `AGENTS.md` menyebut `ROADMAP.md` + `PLAN.md` yang juga tidak dipaketkan → **link mati** di dalam paket | **OWNER DECISION** — saran: **tak sertakan**; `AGENTS.md` adalah instruksi repo, bukan docs pengguna | Keputusan pemilik |
| P-3 | `docs/README.md` | **Sudah** ikut terpasang secara implisit. Nawyaw file `docs/` sendiri **tidak** ikut → tautan ke direktori `docs/` di root `README.md:9` **mati** bagi konsumen npm | Jika `files` menambah `"docs"` (bukan daftar eksplisit), maka `docs/audit/**` (17), `docs/design/**` (18), `docs/TASK_*` (11) ikut — membengkakkan paket & membocorkan artefak internal | **OWNER DECISION** — saran: **listed eksplisit** seperti sekarang + tambahkan `docs/README.md` eksplisit agar intention terlihat & dijaga | Keputusan pemilik |
| P-4 | `docs/SUMMARY.md` | **Sudah** ikut terpasang implisit (basename `changelog*`? — bukan; `SUMMARY.md` **tidak** ikut; hanya `docs/changelog.md` yang ikut) | `SUMMARY.md` = manifes navigasi; menyertakannya tanpa `docs/*.md` yang dirujuk membuat tautan nav mati | **OWNER DECISION** — saran: **tak sertakan**; ia adalah input generator, bukan dokumen | Keputusan pemilik |
| P-5 | Root `README.md` tautan ke direktori `docs/` dan ke berkas `docs/ARCHITECTURE.html` | Dua tautan **mati** bagi konsumen npm; `scripts/pack-check.ts:205` hanya mencocokkan target `.md`, jadi **tidak tertangkap** | — | **UPDATE** (M3): ubah jadi teks polos + pointer URL situs | Perbaikan teknis |

### 9.3 Aturan yang harus berlaku bila konfigurasi kemasan berubah

1. `scripts/pack-check.ts:198-228` ("tautan dokumen relatif menunjuk berkas yang
   ikut paket") **hanya** cocokkan target `.md`. Tautan ke direktori / `.html`
   **tidak** diperiksa → P-5 lolos. Perlu diperluas **jika** pemilik memutuskan
   menyertakan `docs/ARCHITECTURE.html`.
2. `test/release-readiness.test.ts:33-43` hanya memvalidasi entri `files`;
   file yang ikut **implisit** (npm basename) tidak terlihat.
3. `test/pack-integrity.test.ts:48-55` hanya mengenal
   `package.json`/`README.md`/`LICENSE` sebagai "always covered".

---

## 10. Keamanan penghapusan

### 10.1 `docs/USAGE.md` — satu-satunya kandidat DELETE

| Uji | Bukti |
|---|---|
| Isinya pointer, bukan konten | 633 B; 11 baris; seluruh isi = tabel "Butuh… Baca…" dengan 6 target |
| Target masih hidup | `quickstart.md`, `getting-started.md`, `cli.md`, `environment.md`, `tools.md`, `mcp-lsp.md`, `memory-sessions.md`, `security-model.md`, `policy-sandbox.md` — semua ada |
| Fungsi routing sudah tertutup | `docs/README.md` §Navigasi (7 baris) + `docs/SUMMARY.md` (39 entri) + redirect di `docs/USAGE.md` sendiri |
| Tak ada pembaca mesin | nol baris di `test/**` atau `scripts/**` yang membacanya |
| Tak dipublikasikan | tak ada di `docs/SUMMARY.md` → tak ada route `/docs/usage.html` |
| Tak dipaketkan | tak ada di `package.json files`, dan bukan basename `readme*`/`changelog*` |
| Dampak hapus | 6 referensi teks biasa harus diperbarui (`CHANGELOG.md`, `docs/ARCHITECTURE.html`, `docs/README.md`, `PLAN.md`, `README.md`, `scripts/web/nav.ts:19` metadata). **Nol** breakage mesin |

**Putusan: DELETE CANDIDATE** — tetapi hanya setelah M1 (indeks)Memberi
pengganti penemuan, dan **dengan persetujuan pemilik**. Kalau pemilik lebih
suka barrel, alternatifnya **REPLACE WITH POINTER** (isi 3 baris) — tanpa
menghapus berkas.

### 10.2 Yang **TIDAK** layak dihapus (dan alasannya)

| Kandidat yang mungkin_delete | Mengapa **tidak** |
|---|---|
| Root `P*.md` (52), `PHASE-*.md` (47) | Adalah **sumber keputusan** yang dipakai roadmap (`ROADMAP.md` §12 Evidence index menyebut `P2_FINAL_CLOSURE_FORENSIC_AUDIT.md`, `P12_ENTRY_GATE_AND_SCOPE_AUDIT.md`, `P12_1_*` secara eksplisit). "Tanggal lama" **bukan** bukti. → **ARCHIVE** |
| `docs/TASK_*.md` (9), `docs/CANONICAL_TASK_*.md` (2) | Ditunjuk `ROADMAP.md` §4 baris P3 sebagai scope authority; `TASK_EVENT_MODEL.md` punya 11 inbound. → **KEEP AS HISTORICAL** |
| `docs/PLAN_UIUX_V6.md` | **Dipublikasikan** (`/docs/plan_uiux_v6.html`) + dipaketkan. → **KEEP AS HISTORICAL** |
| `docs/changelog.md` | **Dimakan mesin**: membuat route `/docs/changelog.html`; `test/web-build.test.ts:826-828` — isi stub tak boleh bocor ke halaman. → **KEEP** |
| `docs/audit/**`, `docs/design/**`, `docs/design/adr/**` | Preservasi eksplisit oleh instruksi pemilik. → **KEEP AS HISTORICAL** |
| `P3_ROADMAP.md` | `ROADMAP.md` §4: "Pertahankan `P3_ROADMAP.md` … sebagai scope authority". → **KEEP AS HISTORICAL** |
| `docs/security-model.md` |Contains model threat + baseline mode `ask` yang **tidak** ada di `policy-sandbox.md`. → **MERGE**, bukan hapus |
| `docs/USAGE.md` | → **DELETE CANDIDATE** (satu-satunya) |

**Tidak ada kandidat DELETE lain yang memenuhi standar bukti.**

---

## 11. Rencana migrasi (batch kecil, terverifikasi, reversible)

> Setiap batch = satu commit. Rollback = `git revert <sha>` (tanpa
> `reset`). **Tidak ada batch yang boleh dijalankan sebelum pemilik menyetujui
> daftar disposisi di §6.**

| Batch | Isi | Berkas | Dampak tautan publik | Verifikasi | Rollback |
|---|---|---|---|---|---|
| **M0** | **Perbaiki 2 cacat milik audit sebelumnya** (§1.1): §06 env (duplikat lede + hint + `</div>` yatim) dan §09 tabel invariant (24→35 baris, I25-I35, hapus duplikat/off-by-one, selaraskan baris I5 dengan §Gap proteksi) | `docs/ARCHITECTURE.html` | 0 | `bun test test/architecture-map.test.ts test/p1-hygiene.test.ts test/p2-daemon-guards.test.ts`; `bun run web:build && bun run web:check` | revert |
| **M1** | **Indeks arsip** — `docs/archive/README.md` memetakan 107 berkas root historis (nama → fase → checkpoint → status) + 11 berkas task + 36 laporan audit; tanpa memindahkan berkas | `docs/archive/README.md` (baru) | 0 | `bun test test/web-build.test.ts`; link check | hapus berkas |
| **M2** | Perbaiki **drift harmful** §4.1 yang biayanya rendah: R-02 (`ghp_`), R-03 (`source:"derived"`), R-04 (26/23), R-05 (Bun `>=1.1.13`), R-09 (hapus angka "25 variabel") | `docs/security.md`, `docs/OUTPUT_PROTOCOL_SPEC.md`, `docs/architecture.md`, `docs/CANONICAL_TASK_MODEL_DESIGN.md`, `docs/README.md`, `docs/glossary.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.html` | 0 | `bun test test/web-build.test.ts test/release-readiness.test.ts` | revert |
| **M3** | **Kontrak & mode permission**: `docs/policy-sandbox.md` jadi kanonik — lengkapi tabel bash-guard (18 baris), allowlist env (5 nama), baseline `ask`; `docs/security-model.md` → pointer; `docs/security.md`/`docs/choosing-mode.md`/`docs/repl.md` diselaraskan | 5 berkas | 0 | `bun test test/web-build.test.ts` | revert |
| **M4** | **Lantai/versi**: `docs/environment.md` lengkapi `NO_UPDATE_CHECK` + `MINICODE_AUTO_UPDATE`; perbaiki regex `test/env-docs.test.ts` (destructured env) + buang exemption `MINICODE_FOOTER` | `docs/environment.md`, `test/env-docs.test.ts` | 0 | `bun test test/env-docs.test.ts` | revert |
| **M5** | **Konsolidasi config & path**: hapus blok schema duplikat di `docs/cli.md` → pointer `docs/config.md`; selaraskan inventaris path `docs/config.md` vs `docs/ARCHITECTURE.html` §07 | 3 berkas | 0 | `bun test test/web-build.test.ts` | revert |
| **M6** | **Slash command & keybinding**: jadikan `cli/commands.ts` sumber tunggal; `docs/repl.md` menjadi ringkasan yang dihasilkan atau dijaga | `docs/repl.md`, `docs/ARCHITECTURE.html` | 0 | `bun test test/web-build.test.ts` | revert |
| **M7** | **Public-facing parity**: root `README.md` (tree, Bun floor, shell-first) + 2 artikel blog | 3 berkas | 0 (README bukan halaman situs) | `bun run web:build && bun run web:check`; `bun test test/release-readiness.test.ts` | revert |
| **M8** | **Struktur `docs/task/`** (11 berkas) + `docs/internal/autonomous-scheduler.md` + masukkan `autonomous-scheduler.md` ke SUMMARY/README | 13 berkas + 2 | 0 | `bun test test/web-build.test.ts test/phase6ac-controlled-enablement.test.ts` | revert |
| **M9** | **Archive root historis** → `docs/archive/{phase-reports,recovery,presentation-plans,repo-foundation,legacy-roadmap}` + rewrite link silang | 107 berkas | 0 | `bun test test/web-build.test.ts`; link check; `bun run web:build && bun run web:check` | revert |
| **M10** | **Keputusan kemasan** P-1…P-5 (setelah keputusan pemilik) | `package.json`, `README.md`, `scripts/pack-check.ts` (bila P-5 disetujui) | 0 | `bun run gate:pack`; `bun test test/release-readiness.test.ts test/pack-integrity.test.ts` | revert |
| **M11** | **`docs/USAGE.md`** — hapus atau jadikan pointer (keputusan pemilik) | 1 berkas + 6 referensi | 0 | `bun test test/web-build.test.ts` | revert |

### 11.1 Keputusan pemilik yang dibutuhkan sebelum Migration

| ID | Keputusan |
|---|---|
| OD-1 | **Disposisi `docs/security-model.md`**: MERGE ke `docs/policy-sandbox.md` (M3) atau KEEP sebagai dokumen threat-model terpisah? |
| OD-2 | **Kanoniik aturan match task** (R-06): `docs/TASK_MUTATION_SEMANTICS.md` (dirujuk eksplisit) atau `docs/TASK_IDENTITY_SPEC.md`? |
| OD-3 | **Kanoniik event presentasi** (R-04): hapus angka dari `docs/architecture.md` (-+
pointer ke `docs/OUTPUT_EVENT_MODEL.md`) atau pertahankan + perbaiki? |
| OD-4 | **Kemasan** P-1…P-5 (§9.2) |
| OD-5 | **Commit `ROADMAP.md`**? (saat ini untracked; tanpa itu "roadmap otoritas" tak punya jejak git) |
| OD-6 | **Mass-move arsip** (M9) atau cukup **indeks** (M1)? Churn M9 = ratusan link silang |
| OD-7 | **`docs/USAGE.md`**: DELETE atau REPLACE WITH POINTER (§10.1) |
| OD-8 | Apakah `docs/DOCUMENTATION_RATIONALIZATION_PLAN_2026-10-22.md` (berkas ini) harus **dipublikasikan** ke situs (masuk `docs/SUMMARY.md`)? Saat ini **tidak** — ia repo-internal |

---

## 12. Validasi yang dijalankan pada tahap ini

> Hanya validasi read-only. **Tidak** menjalankan `bun test`, `gate:coverage`,
> `gate:pack`, `web:build`, atau `web:check` — semuanya akan berebut dengan
> final gate sequence Agent A yang sedang berjalan (§0.2).

| # | Validasi | Metode | Hasil |
|---|---|---|---|
| V-1 | Link relatif di dalam berkas ini | skrip read-only (resolusi path) | Lihat §12.1 |
| V-2 | Formasi Markdown berkas ini | simulasi guard `test/web-build.test.ts:234-247` (`/^\s+[-*] /`) | Lihat §12.1 |
| V-3 | Encoding | UTF-8 tanpa BOM, LF, trailing newline | Lihat §12.1 |
| V-4 | Manifest kemasan aktual | `npm pack --dry-run --json` (read-only, tanpa membuat tarball) | 275 berkas; 38 `.md`; 18 `docs/*.md` **tidak** terpasang |
| V-5 | Nilai mesin yang diklaim | `bun -e "import …"` | `DURABILITY` 26/23 · `allTools` 37 · `GATEWAY_PRESETS` 14 · `EXPLORE_TOOL_NAMES` 12 |
| V-6 | Sumber kebenarannya | grep `src/`, `cli/`, `scripts/`, `test/`, `.github/` | `ghp_` di `src/policy/scrub.ts:16` · `source:"derived"` di `src/presentation/projection.ts:583` · `engines.bun` `>=1.1.13` |
| V-7 | Status repo sebelum/sesudah | `git status --short`, `git diff --stat` | §12.1 |

### 12.1 Hasil

| Pemeriksaan | Hasil |
|---|---|
| Link relatif dalam berkas ini | **0 rusak** |
| Baris indented-bullet (`/^\s+[-*] /`) | **0** — guard `test/web-build.test.ts` aman |
| Encoding | UTF-8 tanpa BOM · LF · ends with newline · 0 trailing-whitespace |
| Berkas berubah oleh tahap ini | **1** (berkas proposal ini, untracked) |
| Berkas tracked berubah | **0** |
| Staging / commit / push | **0** |

### 12.2 Status file sebelum & sesudah

| | Sebelum | Sesudah |
|---|---|---|
| Tracked modified | 95 | **95** (tidak berubah) |
| Untracked | 4 | **5** (+ `docs/DOCUMENTATION_RATIONALIZATION_PLAN_2026-10-22.md`) |
| Documentation modified | 27 | **27** |
| HEAD | `2d9e11e9dce9b1f8b4ae14say…` | tidak berubah |
| Branch | `main` | tidak berubah |
| Staged | 0 | 0 |

---

## 13. Ringkasan

- **210 `.md` + 3 `.html`** diinventarisasi dan diklasifikasikan.
- **22 overlap harmful** teridentifikasi dengan bukti; **20 di antaranya sudah
  berbeda saat ini** (bukan risiko someday).
- **1 cacat dari audit sebelumnya** (§1.1) ditemukan: dua blok `docs/ARCHITECTURE.html`
  tertinggal tidak terupdate — harus jadi Batch M0.
- **6 dokumentasi tidak dipublikasikan** (orphan/near-orphan) → diperbaiki lewat
  **indeks** (M1), bukan pemindahan massal.
- **1 kandidat DELETE** saja (`docs/USAGE.md`), dengan buktisuperseded yang
  lengkap (§10.1). 107 berkas historis lain → **ARCHIVE**, bukan hapus.
- **5 keputusan kemasan** untuk pemilik (§9.2); konfigurasi **tidak diubah**.
- **8 keputusan terbuka** untuk pemilik (§11.1).
- **12 batch** migration, masing-masing satu commit, reversible, dengan tes
  dan rollback (§11).

**Belum ada implementasi apa pun.** Menunggu persetujuan pemilik atas daftar
disposisi (§6) dan urutan migrasi (§11).
