# P14 — Cross-Session Unfinished Work Reconciliation: Laporan Implementasi & Validasi (full-scope)

**Tanggal:** 2026-10-26 (era uncommitted yang sama dengan core/LITE; lihat §7 provenance)
**Workspace:** `D:/Github/minicode`
**Branch / HEAD:** `main` / `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4` (tidak berubah)
**Status perubahan:** seluruh kerja P14 (core + LITE + full-scope) **belum di-commit**.

> **Status akhir: `P14 CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS`.**
> Pemilik menyetujui closure P14.0–P14.6 dan Definition of Done §10 pada
> 2026-10-26, berdasarkan matriks acceptance di §1/§1.1 dan bukti tes §3/§4.
> Persetujuan ini berlaku **hanya** untuk scope bukti-terstruktur yang
> didefinisikan eksplisit; seluruh eksklusi dan limitasi di §5/§6 tetap
> berlaku dan tidak dicabut. **Closure P14 bukan klaim release-ready**: limitasi
> P13 tetap terdokumentasi (§5.12) dan repository masih uncommitted.
>
> **Verdict teknis pass ini (dipertahankan sebagai bukti):**
> **FULL-SCOPE DELIVERIES VERIFIED — OWNER CLOSURE DECISION PENDING**, kini
> ditutup oleh keputusan pemilik di atas.
> P14.0–P14.6 kini diimplementasikan penuh untuk kontrak bukti-terstruktur:
> inventaris lintas sumber (P14.0), kontrak kategori P14.1 lengkap sepuluh
> state dengan aturan komitmen/freshness/konflik (P14.1), ekstraksi kandidat
> dari histori terstruktur berprovenance (P14.2), grup duplikat lintas sesi
> tanpa merge otomatis (P14.3), portofolio dengan prioritas/blocker/
> dependensi/next action + filter + ekspor berkas (P14.4), context pack
> resume tersupervisi (P14.5), dan closure feedback berlabel klaim + matriks
> forensik (P14.6). Kelima kriteria acceptance §10 roadmap dipenuhi dengan
> bukti tes deterministik (§3). Seluruh gate final dijalankan pada SATU
> kandidat (§4). Stempel `P14 CLOSED` diberikan oleh pemilik pada 2026-10-26 —
> implementer tidak menutup fase diam-diam (aturan kerja §11 roadmap).
>
> **Batas yang DIJAGA, bukan disembunyikan:** pemindaian prosa bebas pengguna
> TIDAK dibangun dan memang TIDAK boleh — roadmap P14 melarangnya secara
> eksplisit ("P14 tidak boleh menganggap setiap pesan brainstorming sebagai
> tugas"). Kontrak intent dibangun maksimal ATAS batas itu (lihat §2.1).
> Readout TUI `/openwork` dan lease-merge bukan bagian teks milestone P14 dan
> sudah diklasifikasikan pemilik sebagai optional extension (§6) — keduanya
> TIDAK diimplementasikan dan TIDAK diklaim.

---

## 1. Matriks milestone roadmap → delivery full-scope

Kriteria diambil dari `ROADMAP.md` §4 (teks milestone P14.0–P14.6) dan §10
(Definition of Done P14). Status menilai **teks milestone**, bukan sekadar
ada/tidaknya kode.

| Milestone (teks roadmap) | Status | Bukti |
|---|---|---|
| P14.0 — inventaris penyimpanan sesi, session IDs, workspace/project binding, histories, plans, todos/TaskStore, checkpoint, verification, sub-agent outcomes, artefak progress; batas cakupan pencarian; pembedaan sesi milik proyek | **COMPLETE** | `minicode openwork inventory [--json]`: sesi (in-scope/foreign/unbound/anak + alasan eksklusi per sesi), task (total/open/terminal), event presentasi per tipe, run (aktif/terputus/terminal), manifest checkpoint (termasuk corrupt — dilabel, proyeksi tidak membuat backup), langkah plan, approval, hasil sub-agent. Binding `cwd` menentukan cakupan; sesi anak mewarisi cakupan leluhur termulaiannya; lineage korup gagal-jujur. Tes: P14.0 (3) |
| P14.1 — kategori `OPEN/PARTIAL/BLOCKED/WAITING_FOR_USER/DELEGATED/FAILED_NEEDS_FOLLOWUP/UNKNOWN/COMPLETED/CANCELLED/DECLINED`; bukti yang diperlukan; freshness; kapan intent dianggap komitmen; bagaimana konflik antar-sesi diungkapkan | **COMPLETE** (kontrak bukti-terstruktur) | Sepuluh kategori semua terdefinisi + teruji. Komitmen = hanya artefak durable terstruktur (task/plan-step/delegation/approval); prosa TIDAK PERNAH (larangan eksplisit roadmap). Freshness = ageMs + ambang stale + verification checkedAt. Konflik antar-sesi = grup duplikat UNPROVEN + penanda DIVERGENT + superseded plan claim diungkap di closure. Tes: P14.1 (7) |
| P14.2 — kandidat dari sumber kanonik + artefak; setiap item menunjuk source session/thread/turn atau task/evidence; kutipan/ringkasan seperlunya, bukan duplikasi riwayat | **COMPLETE** | Ekstraksi dari `plan.updated`, `approval.requested/settled`, sesi anak (lineage), run `INTERRUPTED`. Setiap kandidat membawa `provenance` (eventSeq/turnId/planId/stepId/approvalId/childSessionId/runId/taskId) + ringkasan pendek ter-clip. Langkah plan yang menunjuk task kanonik open menempel sebagai bukti di entri task (bukan duplikat). Tes: P14.2 (14: 10 murni + 4 proyeksi) |
| P14.3 — kelompokkan item tujuan sama; bedakan tugas berulang independen; cocokkan dengan TaskStore + verification; portfolio = projection, perubahan tugas lewat jalur authority | **COMPLETE** | Grup duplikat LINTAS SESI (task + intent) di `report.duplicateGroups`: key ternormalisasi, count, daftar sesi, `divergentStates`, SELALU `proven: false`. Nol merge otomatis; tugas berulang tetap baris terpisah; penggabungan tetap HANYA lewat `declareTaskDuplicate` (satu sesi, evidence WAJIB, transaksi tunggal) setelah adopsi eksplisit. Guard no-second-authority + nol-mutasi. Tes: P14.3 (3) |
| P14.4 — tampilkan/ekspor backlog yang bisa difilter menurut proyek, status, prioritas, umur, blocker, dependensi, sesi sumber dan next action; konflik/UNKNOWN eksplisit; jangan diam-diam membuat status selesai | **COMPLETE** | Entri memuat `state/priority(P0-P3)/blockers/dependencies/nextAction/verification/planSteps/duplicate`. Filter: `--session --status --state --priority --min-age-days --blocked --depends-on --stale-days`. Ekspor: `openwork export --out <path> --format json|md [--force]` atomik, menolak menimpa tanpa --force, MD tersanitasi. "Proyek" = workspace tempat CLI berjalan (tasks.db memang per-workspace — batas yang benar). UNKNOWN/konflik DIVERGENT eksplisit; tidak ada fabrikasi status selesai. Tes: P14.4 (3 bidang) + P14.4/P14.5 CLI (7) |
| P14.5 — pilih item, susun ulang context dari bukti relevan, periksa freshness dan permission/WorkMode, delegasikan/lanjutkan lewat TaskStore/Scheduler/P9 yang ada; tanpa auto-execution; budgets/cancellation/checkpointing/stop criteria P12/P13 | **COMPLETE** | `openwork context --session --task [--json]`: pack konteks berprovenance (field kanonik + state + blocker + dependensi + bukti plan + ketersediaan checkpoint termasuk corrupt + provenance transfer/merge + freshness) dan **checklist resume** yang menunjuk jalur PEMAKSAK (ceiling P12, gate continuity P13.3, claim generation, budgets/cancellation). openwork sendiri TIDAK PERNAH mengeksekusi; adopsi tetap eksplisit `--adopt-task`; trigger tetap `/scheduler run` manual. Tes: context (1) + alur E2E LITE tetap hijau |
| P14.6 — rekonsiliasi status ke task kanonik + referensi sumber; uji sesi duplikat, tugas stale, sesi terputus, checkpoint hilang, task selesai di sesi lain, hasil sub-agent, konflik prioritas, pembatalan, permission denial, restart | **COMPLETE** | Closure feedback membaca ulang status kanonik + ledger; kini juga artefak intent terminal dengan **label klaim** verified/unverified/not-applicable (klaim tanpa verifikasi tidak pernah tampil seolah terbukti). Approval deny → DECLINED terminal, tak dihidupkan lagi. Matriks forensik: grup lintas sesi, stale boost, sesi tanpa baris (PROVENANCE-UNKNOWN), checkpoint corrupt + TANPA backup tertulis, task terminal lintas sesi (adopsi→closure TRANSFERRED), hasil sub-agent (COMPLETED/FAILED/DELEGATED), konflik divergent, pembatalan (plan cancelled + duplikat dibuka kembali), permission denial (DECLINED), restart (run INTERRUPTED). Tes: P14.6 (4) + P14.0/P14.2/P14.3 |

### 1.1 Matriks acceptance criteria §10 roadmap → bukti

| Kriteria §10 | Status | Bukti / gap |
|---|---|---|
| Sesi relevan yang masih menyisakan pekerjaan dapat ditemukan dengan provenance yang dapat ditelusuri | **COMPLETE** | Task non-terminal (provenance transfer/merge/UNKNOWN) + kandidat intent terstruktur (provenance eventSeq/turnId/artefak-id). Pencarian dapat diaudit: setiap sumber diinventarisasi, eksklusi diberi alasan, event tak terbaca dihitung (`rejectedEvents`) |
| Kategori open/partial/blocked/waiting/delegated/unknown dibedakan dari completed/cancelled/declined | **COMPLETE** | Sepuluh state terdefinisi + teruji; terminal tidak pernah jadi item open (fail-closed throw untuk task terminal; DECLINED hanya dari approval deny; COMPLETED tidak difabrikasi dari approval allow) |
| Candidate items dideduplikasi tanpa merge salah dan direkonsiliasi dengan TaskStore sebagai authority tunggal | **COMPLETE** | Grup lintas sesi = penanda UNPROVEN + DIVERGENT; merge eksplisit satu-sesi + evidence + transaksi tunggal; adopsi wajib untuk lintas sesi; TaskStore tetap penulis tunggal `tasks` (guard) |
| Portfolio agregat tidak menjadi sumber task state kedua; action/resume selalu tunduk pada permission/WorkMode, budget, cancellation dan verification | **COMPLETE** | Proyeksi murni (guard 12 larangan); nol-mutasi DIPERLUAS ke jalur histori+inventaris (tasks/ledger/lease/sessions.db/presentation_events identik; tak ada backup manifest korup); context pack tidak mengeksekusi dan checklist-nya menunjuk jalur pemaksa P12/P13 |
| Setelah task selesai, portfolio dan referensi sesi tidak lagi menyajikannya sebagai unfinished kecuali ada bukti baru yang sah | **COMPLETE** | Status SELALU dibaca ulang; duplikat dibuka kembali muncul lagi di open; klaim plan basi atas task terminal di-supersede + konflik diungkap; klaim penyelesaian tanpa verifikasi dilabel `unverified`, tidak dianggap terbukti |

---

## 2. Keputusan desain pass full-scope

### 2.1 Kontrak intent = bukti terstruktur, bukan tebakan prosa (P14.1)

Modul baru `src/session/open-work-intent.ts` MURNI (tanpa I/O, tanpa sqlite,
tanpa fs — semua data masuk sebagai parameter; dapat diuji penuh tanpa DB).
Kontraknya menjawab SEMUA tuntutan teks milestone P14.1:

- **Kategori:** sepuluh state roadmap lengkap. TaskStatus → state mekanis
  (PENDING→OPEN, IN_PROGRESS/VERIFYING→PARTIAL, BLOCKED→BLOCKED,
  FAILED/RETRYING→FAILED_NEEDS_FOLLOWUP) dengan dua override berbasis bukti:
  `verification.verdict = failed` → FAILED_NEEDS_FOLLOWUP; dependensi tak
  tuntas → BLOCKED. Terminal = fail-closed throw (tidak ada state open untuk
  task tertutup).
- **Kapan intent dianggap komitmen:** HANYA ketika ada artefak durable
  terstruktur — baris task kanonik, langkah `plan.updated`, sesi anak
  delegasi, permintaan approval. Pesan bebas (`user.message`) TIDAK PERNAH
  dipindai; ini bukan keterbatasan implementasi melainkan LARANGAN roadmap
  ("P14 tidak boleh menganggap setiap pesan brainstorming sebagai tugas,
  ... atau mengeksekusi ulang secara otomatis tanpa otorisasi"). Kebijakan
  prosa masa depan (bila pemilik mau) adalah perubahan scope baru — bukan
  gap P14 hari ini (lihat §6 item #1).
- **Freshness:** `ageMs` vs ambang stale bernama (default 7 hari, `--stale-days`
  menimpa) + `verification.checkedAt`; stale = sinyal prioritas (boost satu
  tingkat), TIDAK PERNAH keputusan otoritas.
- **Bukti yang diperlukan per state:** WAITING_FOR_USER hanya dari
  `approval.requested` tanpa `settled`; DELEGATED hanya dari sesi anak tanpa
  hasil terminal; FAILED_NEEDS_FOLLOWUP dari task FAILED/RETRYING,
  verification failed, `turn.failed` anak, atau run INTERRUPTED; UNKNOWN =
  artefak dengan status tak terbuktikan (mis. langkah plan ber-status asing)
  atau baris task hilang. Tidak ada kategori ditebak dari judul/teks.
- **Konflik antar-sesi:** grup duplikat lintas sesi (§2.3) + klaim plan basi
  atas task terminal di-supersede dengan konflik DITULIS di alasan closure.

### 2.2 Aturan kejujuran ekstraksi (P14.2)

1. **Approval allow ≠ COMPLETED.** Approval yang di-allow hanyalah izin;
   memalsukan penyelesaian melanggar "jangan diam-diam membuat status
   selesai". Allow tidak menghasilkan kandidat; hanya deny yang menghasilkan
   DECLINED (terminal).
2. **Klaim plan vs otoritas:** langkah plan yang menunjuk task kanonik OPEN
   menempel sebagai bukti `planSteps` di entri task (bukan duplikat). Langkah
   yang mengaku aktif atas task TERMINAL tidak dihidupkan; masuk closure
   INTENT dengan alasan "canonical task <status> supersedes plan claim".
3. **Run RUNNING bukan open loop** — runtime hidup kondisi normal; hanya
   INTERRUPTED yang jadi kandidat FAILED_NEEDS_FOLLOWUP.
4. **Ringkasan, bukan salinan:** kandidat membawa ringkasan ter-clip (≤120
   karakter) + provenance eksak; riwayat tidak diduplikasi sebagai fakta baru.
   `plan.updated` adalah snapshot penuh milik SESI, jadi hanya snapshot
   terakhir per sesi yang diekstrak — bukan satu kandidat per turn, dan bukan
   langkah yang sudah dihapus dari daftar (lihat §5.11).

### 2.3 Dedup lintas sesi tanpa otoritas kedua (P14.3)

`duplicateGroups` mengelompokkan task open + kandidat intent lintas sesi
menurut kunci judul ternormalisasi (fungsi murni yang sudah ada), membawa
`count/sessions/divergentStates` dan SELALU `proven: false`. Grup adalah
PENANDA untuk operator, bukan input merge. Tugas berulang yang sengaja
independen boleh berbagi grup — dibiarkan terpisah (dibuktikan tes).
Jalur penyatuan tidak berubah: adopsi eksplisit → merge satu-sesi dengan
evidence WAJIB di ledger append-only (warisan LITE, tetap hijau).

### 2.4 Cakupan pencarian + lineage (P14.0)

Binding `cwd` baris sesi menentukan cakupan: cocok = IN_SCOPE, beda =
FOREIGN_WORKSPACE (dikeluarkan + alasan), kosong/NULL = UNBOUND_WORKSPACE
(dikeluarkan + alasan; baris legacy NULL tidak membuat crash — diperbaiki
di pass ini setelah ditemukan lewat fixture). **Sesi anak sub-agent tidak
punya binding sendiri** (createChildSession menulis `cwd=''`), jadi anak
mewarisi cakupan leluhur TERMULAIKANNYA — tanpa ini seluruh hasil sub-agent,
yang roadmap eksplisit masukkan ke inventaris, tak terlihat. Lineage korup
(siklus) gagal-jujur dari binding sendiri.

### 2.5 Read-only yang dapat DIBUKTIKAN

- Pembaca histori baru (`readSessionInventoryRows`,
  `readAllPresentationEventsReadOnly`, `readRunRowsReadOnly`) di-gate
  `existsSync` — proyeksi tidak pernah membuat sessions.db.
- `readCheckpointInventorySync` TIDAK menulis backup `.corrupt.*` (beda dari
  `loadCheckpointManifest` jalur pemulihan yang memang menulis) — dibuktikan
  tes: direktori manifest tetap berisi manifest.json saja.
- Tes nol-mutasi diperluas: tasks/transfers/merges/lease/sessions.db/
  presentation_events identik sebelum-sesudah proyeksi penuh
  (includeInventory: true).
- Guard arsitektur P14 (12 larangan tulis + 4 sumber baca + penanda UNPROVEN)
  tetap hijau tanpa dilonggarkan.

### 2.6 CLI: dua sink bersama + kontrak I28 utuh (OAP-008)

Seluruh keluaran mengalir lewat `emitJson` (satu objek JSON mesin, satu baris)
dan `printLines` (manusia, dikumpulkan, ditulis SEKALI) + dua writer stderr
(`usageError` exit 2, `exit1` exit 1). Aksi baru (inventory/context/export)
SENGAJA memakai sink yang sama — tidak ada kelas emisi baru; deklarasi
writer-inventory diperbarui dengan justifikasi (4 writer aktual, max 8
dipertahankan). Sanitasi teks tak-terpercaya tetap wajib: render list dan
ekspor MD menyani judul/evidence/id (sekuens ANSI terbukti tak lolos ke
berkas ekspor).

### 2.7 Ekspor + context: keputusan produk dalam batas roadmap

- **Ekspor** dituntut teks milestone P14.4 ("tampilkan/**ekspor** backlog").
  Bentuk: `--format json` (objek portofolio lengkap + inventaris, indentasi 2)
  dan `--format md` (laporan manusia tersanitasi). Atomic via
  `atomicWriteText` (tmp acak + rename), **menolak menimpa tanpa --force**,
  kegagalan menulis = exit 1 tanpa sampah `.tmp.*` (dibuktikan tes dengan
  induk-berkas).
- **Context pack** menjawab "susun ulang context dari bukti yang relevan,
  periksa freshness dan permission/WorkMode": openwork menyusun konteks +
  freshness; **permission/WorkMode TIDAK dipalsukan terperiksa** — checklist
  resume menunjuk subsistem yang MEMAKSAK saat resume (ceiling P12 di start,
  gate continuity P13.3 sebelum claim, claim generation TaskStore, budgets/
  cancellation P12/P13). Read-only CLI tidak bisa dan tidak boleh berpura-pura
  menegakkan runtime sesi lain.

---

## 3. Bukti tes pass ini

### 3.1 Suite baru — `test/p14-full-scope.test.ts` (42 test / 0 fail)

| Seksi | Test | Klaim yang dipegang |
|---|---|---|
| E. P14.1 kontrak murni | 7 | pemetaan mekanis; override verification-failed/dependensi; verification passed TIDAK menurunkan kejujuran state; terminal fail-closed; planStepState penuh; prioritas P0–P3 + stale boost satu tingkat; next action eksplisit per state tanpa janji otomatis; `scopeSession` (match/foreign/unbound) |
| E2. P14.2 ekstraksi murni | 10 | approval tanpa jawaban = WAITING_FOR_USER; deny = DECLINED terminal; **allow TIDAK jadi kandidat apa pun**; delegasi tiga outcome; run INTERRUPTED saja; **pesan bebas TIDAK PERNAH jadi kandidat**; sesi FOREIGN tak diekstrak; batas maxCandidates; **snapshot plan dikolaps ke snapshot terakhir per SESI** (pending→active→completed = satu kandidat terminal; active→pending = satu OPEN terbaru; langkah dihapus tidak dihidupkan; langkah sama di turn berbeda tidak berganda; urutan step bergeser dengan `taskId` kanonik tetap benar) |
| F. P14.2 proyeksi histori | 4 | langkah plan tanpa task = kandidat berprovenance (eventSeq/turnId/planId/stepId); langkah ber-task menempel jadi bukti, bukan duplikat; klaim plan atas task terminal di-supersede (closure INTENT, claim unverified); verification passed → claim verified; approval DECLINED closure not-applicable |
| G. P14.3 grup lintas sesi | 3 | judul sama lintas sesi = satu grup UNPROVEN, state beda = DIVERGENT + counts.conflicts, nol merge lahir; state sama = tanpa konflik; grup mencakup task+intent |
| H. P14.4 bidang portofolio | 3 | blocker TASK_BLOCKED/DEPENDENCY + state BLOCKED + P0 + next action; dependensi COMPLETED = satisfied; verification failed = FAILED_NEEDS_FOLLOWUP + blocker VERIFICATION |
| I. P14.0 inventaris | 3 | hitungan lintas sumber + eksklusi beralasan + anak via lineage; manifest korup dilabel TANPA backup tertulis; checkpoint sehat terhitung |
| J. P14.6 forensik | 4 | restart (INTERRUPTED vs RUNNING); sesi terputus = PROVENANCE-UNKNOWN; pembatalan plan = closure CANCELLED not-applicable; stale boost prioritas |
| K. Zero-mutasi penuh | 1 | tasks/transfers/merges/sessions/presentation_events identik sebelum-sesudah proyeksi includeInventory |
| L. CLI (subprocess hermetic) | 7 | `--help` menampilkan bantuan subcommand + exit 0 (bukan list); list manusia menampilkan state/priority/blocker/dependensi/next; filter --state/--priority/--blocked/--depends-on + misuse exit 2; inventory manusia+JSON (eksklusi beralasan, satu objek); context pack + exit 1/2; export json+md atomik + ANSI tersapu + refuse tanpa --force + --force + format cacat exit 2; export gagal = exit 1 tanpa sampah .tmp |

### 3.2 Regresi lintas-suite pada kandidat yang sama

- `test/p14-open-work.test.ts` **24/24** — LITE tetap hijau penuh (proyeksi
  diperluas tanpa mengubah semantik `open`/`counts` yang dipegang tes lama).
- `test/p14-cross-session-adoption.test.ts` **18/18** — core tak tersentuh.
- `test/p2-architecture-guards.test.ts` + `test/writer-inventory.test.ts` +
  `test/architecture-map.test.ts` **55/55** — guard kemurnian, ledger
  append-only, no-second-authority, deklarasi writer, peta struktur.
- Terarah persistence/checkpoint/taskstore/presentation/session:
  **51/51** + **81/81**.
- **Suite penuh `bun test`: 5115 pass · 19 skip · 0 fail** — 5134 tes /
  345 berkas. Delta vs baseline konsolidasi: +42 pass = tepat suite baru; 19
  skip tetap skip lingkungan baseline (PTY/telemetry/live provider), nol skip
  baru karena P14. Jumlah `expect()` dan durasi berayun antar-run (mesin
  lokal); angka persis run terakhir dicatat di handoff, bukan di tabel dokumen
  ini — supaya dokumen bisa dibekukan SEBELUM gate dijalankan.

### 3.3 Flake

Run suite penuh pass ini **sekali jalan, nol kegagalan** — flake timing
`p2-daemon` yang pernah muncul pada run coverage era LITE tidak terulang di
run ini (lihat §7.3). Coverage gate juga lulus pada run tunggal tanpa
kegagalan tes, tanpa perubahan assertion/ambang.

### 3.4 Verifikasi bahwa kandidat tidak berubah selama gate

Pass ini memakai urutan **bekukan-dulu-baru-gate**: seluruh dokumentasi
closure diselesaikan sebelum gate pertama dijalankan, lalu sidik jari tree
diambil sebelum dan sesudah sebelas gate. Kedua sidik jari **identik**
(tracked diff, hash untracked, jumlah baris `git status`, HEAD, branch, 0
staged, stash kosong) — tree tidak bergerak sedikit pun selama validasi.
Nilai persisnya dicatat di handoff; tabel §4.1 hanya memuat angka stabil
supaya dokumen tidak perlu disunting setelah gate (lihat §4.2).

---

## 4. Gate final — SATU kandidat, tree tidak berubah

> Bagian ini diisi HANYA dari hasil run pada kandidat beku (sidik jari di
> bawah); perubahan dokumen setelahnya dicatat terpisah (§4.2).

### 4.1 Hasil

| Gate | Perintah | Exit | Hasil |
|---|---|---|---|
| TypeScript | `bun x tsc --noEmit` | 0 | 0 diagnostik |
| Lint | `bun run lint` | 0 | 627 berkas; 3 info pre-existing (`test/session-id-portability.test.ts`), 0 error |
| Suite penuh | `bun test` | 0 | 5115 pass · 19 skip · 0 fail (5134 tes / 345 berkas) |
| Coverage | `bun run gate:coverage` | 0 | funcs **88,21%** (min 87) · lines **89,12%** (min 86) · lantai per-berkas **19/19** hijau; run tunggal, nol kegagalan tes |
| Pack | `bun run gate:pack` | 0 | 23 pass · 0 fail; 287 berkas; **3505 KB** (budget 3584 KiB) |
| Bash guard | `bun run gate:bash` | 0 | bypass **0/62** · over-block **0/24** |
| Bench smoke | `bun run bench:smoke` | 0 | resolve rate **13/13**; fail distribution (none); delta 0,0% |
| Audit harness | `bun run audit:harness` | 0 | 60 pass · 0 fail · 2 advisory |
| Telemetry | `bun run gate:telemetry` | 0 | skip resmi (`no traces.jsonl`) |
| Vendor | `bun run vendor:check` | 0 | 20 berkas; `c8d214bb8d5eea86` sinkron |
| Whitespace | `git diff --check` | 0 | bersih |

### 4.2 Batas bukti & urutan pembekuan

Urutan kerja pass ini **dibalik dari pass sebelumnya** supaya tidak ada
dokumen yang disunting setelah gate:

1. Seluruh dokumentasi closure (termasuk §4 ini) **dibekukan lebih dulu**.
   Tabel §4.1 sengaja hanya memuat nilai **stabil** (exit code, jumlah
   pass/skip/fail, persentase coverage, ukuran paket) — bukan jumlah `expect()`
   atau durasi, karena keduanya berayun antar-run dan memaksa penyuntingan
   dokumen setelah gate.
2. Baru setelah itu sebelas gate dijalankan pada tree yang sama.
3. Sidik jari diambil **sebelum dan sesudah** seluruh gate; keduanya harus
   identik.

Identitas kandidat memakai dua hash yang tidak berubah saat laporan dibaca:
tracked diff (isi seluruh perubahan berkas tracked) dan hash 45 berkas
untracked **tanpa** `P14_REPORT.md`/`ROADMAP.md`. Nilai persisnya ada di
handoff, bukan di tabel dokumen ini — supaya dokumen tetap bisa dibekukan
sebelum gate tanpa menciptakan siklus "edit dokumen → gate ulang".

`P14_REPORT.md`/`ROADMAP.md`/`docs/P14_OPEN_WORK.md` tidak menjadi bagian
tarball paket: `package.json#files` memuat `cli`, `src`, `vendor/minicore/*`,
`README.md`, `CHANGELOG.md`, `LICENSE`, dan daftar `docs/*` eksplisit yang
tidak mencakup `docs/P14_OPEN_WORK.md` (terbukti dari 287 berkas di
`gate:pack`).

---

## 5. Limitasi (jujur, tidak dinegasikan)

1. **Intent = bukti terstruktur saja.** Janji/niat dari PROSA tidak
   diekstraksi — larangan eksplisit roadmap. Konsekuensi: pekerjaan yang
   HANYA pernah disebut dalam obrolan (tanpa task/plan/approval/delegasi/
   run) tidak muncul di portofolio. Ini batas desain, bukan bug (lihat §6 item #1).
2. **Kemiripan tetap hanya penanda.** Grup lintas sesi UNPROVEN; tugas
   berulang independen berbagi grup dan TETAP dua baris. Tidak ada yang
   pernah digabung otomatis.
3. **Closure INTENT berbasis artefak**, bukan verifikasi P10 atas konten:
   klaim `result.produced`/langkah plan `completed` dilabel `unverified`
   kecuali task kanoniknya ter-verifikasi passed. Label wajib dibaca
   operator — tidak ada yang dianggap terbukti diam-diam.
4. **Merge tetap satu-sesi tanpa lease** (setara `todo_write`: operator
   eksplisit + ledger audit, dalam SATU transaksi). Lintas-sesi tetap
   wajib adopsi dulu — model otoritas roadmap sendiri.
5. **`PROVENANCE-UNKNOWN` tetap tak terdiferensiasi sebabnya** (sesi tak
   pernah ada vs baris hilang) — dilabel jujur, tidak ditebak.
6. **Lease kedaluwarsa ≠ proses mati** (warisan core): takeover mewarisi
   tradeoff kerja-terbuang vs eksekusi-ganda.
7. **Eksternal-client compatibility tak terverifikasi**: bentuk JSON
   openwork/inventory/context adalah permukaan baru; belum ada konsumen
   eksternal. Skema boleh berkembang.
8. **Inventaris berat** (membaca seluruh event presentasi) hanya dihitung
   saat diminta (`openwork inventory`, `openwork export`, atau
   `includeInventory`); jalur `list` ringan tetap tanpa inventaris.
9. **Checkpoint corrupt dilabel, tidak diperbaiki** — proyeksi read-only
   tidak menulis backup (jalur pemulihan `loadCheckpointManifest` yang
   menulis backup tidak dipakai proyeksi).
10. **19 skip suite penuh** tetap skip lingkungan baseline (PTY/telemetry/
    live provider), bukan P14.
11. **`plan.updated` dikolaps per sesi, bukan per turn.** Daftar todo
    memang milik SESI (`.minicode/todos/<session>.json`), dan adaptor
    menerbitkan snapshot penuh setiap `todo_write` sukses — termasuk di turn
    berikutnya. Karena itu hanya snapshot TERAKHIR sesi yang dibaca: riwayat
    turn tidak dijadikan kandidat terpisah, dan langkah yang dihapus dari
    daftar tidak dihidupkan. Konsekuensi jujur: kalau operator ingin melihat
    evolusi status sebuah langkah, ia harus membaca `presentation_events`
    langsung — portofolio sengaja tidak menyimpannya sebagai fakta baru.
12. **Limitasi P13 tetap berlaku dan TIDAK dicabut oleh closure P14.** P13
    adalah `CLOSED / VERIFIED — DOCUMENTED LIMITATIONS`: ACP tidak dipasang
    sebagai consumer P13 baru, koreografi restart daemon penuh belum diuji
    E2E, retry append event belum diimplementasikan, dan gate telemetry
    memakai jalur skip saat tidak ada `traces.jsonl`. Tidak ada klaim
    kompatibilitas external-client atau jaminan locking network-filesystem.
    P14 memakai jalur runtime P13 apa adanya; ia tidak menambah bukti baru
    untuk limitasi tersebut.
13. **Closure P14 ≠ release-ready.** Repository masih **uncommitted** pada
    kandidat ini; tidak ada commit, push, tag, atau publikasi paket. Gate
    yang lulus membuktikan kandidat working tree, bukan status rilis.

---

## 6. Keputusan pemilik & eksklusi scope (final)

Lima keputusan klasifikasi 2026-10-25 dievaluasi ulang terhadap teks
milestone roadmap — hasilnya DUA berubah status karena ternyata dituntut
teks milestone (bukan optional), TIGA tetap di luar scope P14. **Pemilik
kemudian menyetujui closure pada 2026-10-26**; tabel di bawah tetap menjadi
daftar eksklusi yang mengikat.

| # | Item | Klasifikasi final | Alasan (dengan bukti teks roadmap) |
|---|---|---|---|
| 1 | Kontrak intent P14.1 penuh | **SELESAI untuk scope roadmap; kebijakan prosa = keputusan scope BARU** | Milestone P14.1 menuntut kategori+bukti+freshness+kapan-komitmen+konflik — semua kini terdefinisi. Batas "kapan intent = komitmen" dijawab konservatif: hanya artefak terstruktur. Memindai prosa DILARANG roadmap ("tidak boleh menganggap setiap pesan brainstorming sebagai tugas"); menambah NLP intent = perubahan scope eksplisit pemilik, bukan gap P14 |
| 2 | Ekspor portofolio | **SELESAI (bukan optional — koreksi)** | Milestone P14.4 eksplisit: "tampilkan/**ekspor** backlog yang bisa difilter" — implementasi: `openwork export` json/md atomik + filter lengkap |
| 3 | Readout TUI `/openwork` | **TETAP DI LUAR SCOPE P14** | Teks milestone hanya "tampilkan/ekspor"; tidak ada permintaan TUI. Sudah diklasifikasikan pemilik 2026-10-25: `OPTIONAL EXTENSION / OWNER DECISION`. Membangunnya = perubahan produk + kontrak terminal, menunggu keputusan eksplisit |
| 4 | Dedup lintas sesi langsung (tanpa adopsi) | **SELESAI sampai batas roadmap; merge langsung TETAP DEFERRED pemilik** | Milestone P14.3: "Portfolio lintas sesi tetap **projection**, sedangkan pembuatan/perubahan tugas harus lewat **jalur authority yang ada**" — deteksi/grup/konflik kini lengkap di proyeksi; penggabungan NYATA tetap wajib adopsi dulu (model keamanan roadmap sendiri). Merge lintas-sesi tanpa adopsi = perubahan kontrak, tetap keputusan pemilik |
| 5 | Merge dengan lease/admission eksplisit | **TETAP DI LUAR SCOPE P14** | Tidak ada teks milestone menuntut lease untuk merge; patchTask-dalam-satu-transaksi + ledger sudah melewati "jalur authority yang ada". Tetap `OPTIONAL EXTENSION` per klasifikasi pemilik |

**Keputusan pemilik 2026-10-26:** P14.0–P14.6 dan Definition of Done §10
**disetujui dan ditutup** sebagai `P14 CLOSED / VERIFIED — DOCUMENTED SCOPE
LIMITATIONS`, terbatas pada kontrak bukti-terstruktur. Item #1/#3/#4/#5 di
atas **tetap eksklusi** dan hanya bisa dibuka sebagai scope BARU — bukan
sebagai syarat P14 yang belum terpenuhi, dan bukan sebagai pekerjaan yang
boleh disisipkan diam-diam. Closure ini **tidak** menyatakan repository
release-ready (§5.12–§5.13).

---

## 7. Provenance historis (dipertahankan, tidak ditimpa)

### 7.1 Era core + LITE (2026-10-24/25)

Laporan era itu (matriks LITE/PARTIAL, lima keputusan, gate literal hijau
5073 pass / 0 fail pada kandidat `2d9e11e` + tree 132 modified / 45
untracked) tetap valid SEBAGAI SEJARAH dan kini digantikan oleh pass ini
untuk status. Inti yang masih berlaku: TaskStore otoritas tunggal, ledger
transfer/merge append-only, adopsi eksplisit ber-fence, merge satu-transaksi,
proyeksi murni — semuanya diwarisi utuh dan diregresi hijau (§3.2).

### 7.2 Sidik jari kandidat full-scope

Branch `main`, HEAD `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`, 0 staged,
stash kosong, vendor `c8d214bb8d5eea86` (20 berkas) — tidak berubah dari era
LITE; seluruh kerja tetap uncommitted; tidak ada
reset/checkout/rebase/stage/commit/push. Sidik jari tracked diff
`b53ef0c552ecc1199726527d5254fcf7f8f4ca10` (stabil: tidak ada berkas tracked
yang berubah setelah gate). Hash untracked lengkap sengaja TIDAK ditulis di
sini — dokumen ini sendiri termasuk di dalamnya, sehingga angkanya akan
membatalkan dirinya sendiri setiap kali dibaca; nilai sebelum/sesudah gate
dicatat di handoff (§4.2).

### 7.3 Flake historis

Run coverage era LITE pernah gagal sekali pada `p2-daemon` "ack persist
offset dan reconnect lanjut dari sana" (jendela timing 80 ms di bawah
instrumentasi); terisolasi 3/3 hijau + run kedua hijau, tanpa perubahan
assertion/threshold — detail di laporan era. Run suite penuh pass ini:
sekali jalan, nol kegagalan. Hasil coverage pass ini di §4.

### 7.4 Berkas yang berubah oleh pass full-scope (era uncommitted yang sama)

- `src/session/open-work-intent.ts` — **baru**: kontrak P14.1/P14.2/P14.0
  murni (state/prioritas/next-action/ekstraksi/inventaris/scope-lineage).
  Ekstraksi `plan.updated` mengolaps snapshot terakhir **per sesi** agar
  riwayat turn tidak menjadi kandidat ganda (§2.2 poin 4, §5.11).
- `src/session/open-work.ts` — proyeksi diperluas: intent, state/portofolio
  per entri, grup duplikat lintas sesi, closure INTENT + label klaim,
  inventaris, rejectedEvents.
- `src/session/persistence.ts` — tiga pembaca READ-ONLY berpagar existsSync
  (inventaris sesi, seluruh event didekode, run) + normalisasi NULL legacy.
- `src/session/checkpoint.ts` — `readCheckpointInventorySync` (sync,
  non-menulis, tanpa backup).
- `src/task/store.ts` — `listAllTasks` (baca lintas sesi untuk inventaris).
- `cli/commands/openwork.ts` — lima aksi (list/inventory/context/export/
  merge), filter baru, dua sink bersama (OAP-008), I28 utuh; `--help`
  eksplisit (flag tidak pernah terlihat oleh pemindai aksi), ukuran ekspor
  dilaporkan dalam byte UTF-8.
- `test/p14-full-scope.test.ts` — **baru**: 42 tes (§3.1).
- `test/writer-inventory.test.ts` — deklarasi openwork diperbarui (4 writer
  aktual, justifikasi sink bersama; max 8 dipertahankan).
- `docs/ARCHITECTURE.html` — modul `open-work-intent.ts` + deskripsi
  open-work/openwork diperbarui; src/session 16 → 17 modul.
- `docs/P14_OPEN_WORK.md` — alur operator diperluas (intent, grup lintas
  sesi, inventory, context, export, label klaim closure, peta bukti).
- `P14_REPORT.md`, `ROADMAP.md` — status dari bukti terverifikasi (pass ini).
