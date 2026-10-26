# MiniCode — Master Roadmap & Working State

**Versi:** 1.11 — P14 ditutup oleh pemilik 2026-10-26 (P12 dan track Quality Remediation Stage 1–10 tetap `CLOSED / VERIFIED`; P13 `CLOSED / VERIFIED — DOCUMENTED LIMITATIONS`; P14 `CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS` untuk kontrak bukti-terstruktur, seluruh gate hijau pada satu kandidat beku, **bukan** klaim release-ready)
**Tanggal pembaruan:** 2026-10-26
**Checkpoint HEAD yang dilaporkan pemilik:** `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`
**Status dokumen:** master roadmap persisten milik pemilik ada di Library. **Berkas ini adalah salinan repository dari master tersebut** — ditulis ke root repo MiniCode sebagai `ROADMAP.md` pada 2026-10-21 dalam bentuk **draft working-tree yang belum di-commit**. Salinan repo tidak menggantikan master Library: bila master diperbarui, salinan ini wajib disinkronkan ulang dan setiap perbedaan harus dilaporkan, bukan ditutup sepihak. Update Stage 8.1 berasal dari laporan Agent A tanggal 2026-10-21 dan belum diverifikasi ulang secara independen dari workspace repository ini. Laporan audit dokumentasi Agent B diterima pada 2026-10-21 dan diringkas pada checkpoint di §2; semua hasil angka/gate yang dikutip tetap berstatus laporan agent, bukan inspeksi independen assistant. Integrasi `ROADMAP.md` ke repository dijalankan sebagai tugas susulan terpisah dengan file master dilampirkan; Agent B pada audit awal memang belum menerimanya sebagai input dan secara tepat mencatat B-1 — temuan itu menjadi dasar usul integrasi, bukan kesalahan audit. P14 ditambahkan berdasarkan koreksi pemilik pada 2026-10-21; pencarian arsip menemukan P13 Desktop tetapi belum menemukan spesifikasi historis P14 yang berdiri sendiri, sehingga detail P14 merupakan konsolidasi terstruktur dari maksud pemilik yang telah dikonfirmasi. **Rekonsiliasi 2026-10-25** mencatat status implementasi P13/P14 dari working tree yang sama (masih belum di-commit), termasuk bukti gate pada satu kandidat dan gap acceptance P14; angka gate dirujuk ke checkpoint §2 dan laporan P13/P14, bukan klaim repository committed/strict-green. **Pass 2026-10-26** menutup gap acceptance P14 untuk kontrak bukti-terstruktur (P14.0–P14.6 full-scope), menjalankan seluruh gate pada satu kandidat beku, dan **menerima closure pemilik** atas P14.0–P14.6 + §10 sebagai `P14 CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS`; angka final ada di checkpoint 2026-10-26 dan §12, tetap bukan klaim repository committed/strict-green maupun release-ready.

---

## 1. Tujuan dan keputusan konsolidasi

MiniCode dikembangkan sebagai **agent runtime / harness yang andal**, bukan sekadar CLI yang dapat memanggil model. Runtime harus menghubungkan model, konteks, tool/capability, eksekusi terkontrol, state kanonik, bukti, verifikasi, recovery, orkestrasi, dan presentation tanpa menciptakan authority kedua.

Roadmap sebelumnya menyimpang karena tiga sistem penomoran/status bercampur:

1. **Big-phase architecture roadmap** — arsitektur runtime P1–P14: P12 Work Modes, P13 Desktop/Long-Running Runtime, dan P14 rekonsiliasi pekerjaan belum tuntas lintas sesi.
2. **Legacy product roadmap `PLAN.md`** — milestone era 0.9.x yang juga memakai label P10/P11/P12/P13 untuk Path to 9+, Provider Hardening, UI Shell-Max, serta Raise 3 Dimensi Tertinggal.
3. **Quality remediation Stage 1–10** — rangkaian hardening lintas-fase yang berjalan berdasarkan masalah nyata pada test, lifecycle, TypeScript, lint, packaging, dan coverage.

Ketiga jalur itu tidak boleh disatukan dengan menghapus sejarah atau memaksa satu nomor mengandung beberapa makna. Mulai dari roadmap ini:

- **Mulai dari salinan repo ini**, `ROADMAP.md` adalah sumber status aktif tunggal untuk fase besar, prioritas, dependensi, dan next action. Aturan itu berlaku penuh setelah salinan repo **di-commit**; selagi masih draft working-tree, master Library `/MiniCode_ROADMAP_MASTER.md` versi terbaru tetap menjadi sumber acuan roadmap, dan perbedaan antara keduanya harus dilaporkan.
- `PLAN.md` dipertahankan sebagai referensi rinci **legacy product roadmap**; ID di sana diberi namespace `LEGACY-0.9/*` saat dirujuk dari roadmap utama.
- **Stage 1–10 adalah track quality remediation**, bukan fase arsitektur baru dan bukan pengganti P1–P14.
- **P0 / UX-001 adalah label prioritas hotfix keamanan TUI, bukan Big Phase P0 dan bukan subfase P12.** Ini merupakan pekerjaan lintas-fase yang membantu menutup risiko keamanan sebelum closure P12.
- Dalam setiap update ke pemilik, status wajib memisahkan (a) posisi Big Phase P1–P14, (b) Quality Remediation Stage 1–10, dan (c) UX/security follow-up lintas-fase. Bila berpindah ke pekerjaan lintas-fase, sebutkan secara eksplisit bahwa itu di luar urutan fase besar dan jelaskan pengaruhnya terhadap prasyarat closure. Status saat ini ditentukan oleh bukti paling baru, bukan dengan mengedit laporan lama agar seolah-olah dibuat pada checkpoint sekarang.

### Governance issue ditemukan — `AGENTS.md` vs master roadmap (2026-10-21)

Sebelum audit, `AGENTS.md` menyatakan: **“Rencana aktif: `PLAN.md`”**, dan menetapkan gate global `bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack`, dengan semua gate hijau sebelum penyelesaian. Agent B melaporkan bahwa pembuka `AGENTS.md` dan `PLAN.md` sudah diubah agar `PLAN.md` tidak lagi disebut roadmap aktif. **Integrasi master roadmap ke repository (tugas susulan 2026-10-21) sudah dieksekusi: `ROADMAP.md` kini ada di root repo sebagai draft working-tree dan pointer `AGENTS.md` sudah diarahkan ke sana.** Dua persoalan yang sebelumnya terbuka dinyatakan eksplisit berikut:

1. **Source-of-truth mismatch — TERPENUHAN SEBAGIAN.** Roadmap master Library ini **sudah** menjadi file di repository (`ROADMAP.md`), dan `AGENTS.md` yang dibaca agent sudah menunjukkannya sebagai otoritas roadmap arsitektur, bukan `PLAN.md`. Namun salinan itu **draft working-tree yang belum di-commit**. Maka, jangan mengklaim roadmap sudah committed, dan jangan mengklaim repository sudah hijau hanya karena `ROADMAP.md` ada. `PLAN.md` tetap dipertahankan sebagai legacy product roadmap (`LEGACY-0.9/*`), tanpa penghapusan atau renumber massal.
2. **Gate-scope mismatch — WORDS DIPERJELASIKAN, SYARAT DIJAGA.** `AGENTS.md` menyebut seluruh gate harus hijau sebelum “selesai”, sedangkan Quality Remediation mengerjakan gate secara bertahap dan menjadwalkan full suite/coverage pada Stage 9–10. Wording `AGENTS.md` kini menyatakan dua hal sekaligus: laporan interim **hanya boleh mengklaim penyelesaian stage-scoped**, dan penutupan track Quality Remediation penuh maupun klaim release-readiness **tetap mensyaratkan seluruh gate akhir lulus pada satu kandidat final yang sama**. Stage 10 tetap wajib menjalankan urutan final gate yang ditetapkan `AGENTS.md`. Ambang gate tidak boleh diturunkan untuk membuat hasil terlihat hijau.

**GOV-01 — Repository roadmap/instruction alignment** (`OPEN`, lintas-fase): Stage 8.1 dilaporkan selesai oleh Agent A. Audit dokumentasi Agent B sudah melaporkan koreksi `AGENTS.md`/`PLAN.md`. **Tugas susulan 2026-10-21 sudah mengeksekusi (a) dan (b): master roadmap v1.8-draft diintegrasikan ke root repo sebagai `ROADMAP.md` — draft working-tree, belum di-commit — dan pointer `AGENTS.md` diperbarui agar menunjuknya sebagai roadmap arsitektur aktif, dengan `PLAN.md` dipertahankan sebagai ledger legacy (`LEGACY-0.9/*`); (c) aturan gate diselaraskan — laporan interim hanya boleh menyatakan status stage-scoped, sedangkan penutupan track Quality Remediation penuh dan klaim release-readiness tetap mensyaratkan seluruh gate akhir lulus pada satu kandidat final yang sama.** GOV-01 **tetap `OPEN`** sampai pemilik meninjau diff integrasi ini; jangan menutupnya atas inisiatif sendiri.
- Agent tidak diberi kewenangan untuk memilih ulang arah roadmap. Pemilik menetapkan tujuan, urutan, batas dan DoD; agent melaksanakan satu slice teknis yang dibatasi.

### Keputusan penomoran fase besar

Roadmap kanonis yang lebih awal menyebut Desktop/Long-Running Runtime sebagai Phase 12 dan menegaskan nomor fase tidak digeser. Setelah Work Modes & Permission Architecture dimasukkan dan implementasinya benar-benar berjalan sebagai P12, roadmap kerja yang lebih baru menetapkan Desktop/Long-Running Runtime sebagai **P13**. Konsolidasi ini mempertahankan penomoran kerja yang sekarang sudah digunakan oleh keputusan dan commit P12; penyebutan “Phase 12 Desktop” pada roadmap lama tetap menjadi referensi historis terhadap **P13 saat ini**, bukan fase aktif kedua.

`P2.12` tetap berarti sub-milestone internal Session Architecture (daemon/desktop substrate); itu bukan Big Phase 12, P13, atau P14. `LEGACY-0.9/P13` juga tetap berarti Raise 3 Dimensi Tertinggal, bukan Desktop Runtime.

---

## 2. Checkpoint dan posisi pekerjaan sekarang

### Checkpoint Git terakhir

- Repository: `D:/Github/minicode`
- Branch: `main`
- HEAD: `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`
- Subject: `test: harden PTY SGR end-to-end coverage`
- Parent: `205e3558696b5f5d7027a283c1c5495699d3c63b`
- Menurut laporan Agent A terbaru (Stage 8.1, 2026-10-21): HEAD awal/akhir tetap `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`; branch `main` dilaporkan sinkron dengan `origin/main` (`0 0`). Tidak ada commit, amend, atau push.
- Working tree **tidak bersih**: laporan terbaru menyebut **70 modified + 2 untracked, 0 staged**. Untracked mencakup `scripts/pack-budget.ts` dan `test/checkpoint-lifecycle.test.ts`. Laporan ini menggantikan hitungan lama 64 modified pada checkpoint Stage 7; jangan anggap count tersebut masih mutakhir bila status berubah saat agent lain bekerja. Semua patch P0/Stage 5B/6/7/8/8.1 harus dipertahankan.
- Ini adalah provenance laporan Agent A, bukan pemeriksaan langsung dari assistant. Laporan Agent B menyatakan 70 perubahan kode/non-dokumen sudah ada sebelum audit dan tidak disentuh; karena pekerjaan berjalan pada kandidat repository yang sama menurut laporan, semua perubahan lintas-agent harus dipertahankan dan direkonsiliasi dengan melihat diff, bukan hanya mengandalkan hitungan file.

Full suite pada kandidat working tree ini **belum dijalankan kembali**, dan coverage belum dijalankan. Tes terarah sudah menghasilkan bukti positif untuk P0 dan Stage 5B/6/7/8/8.1 berdasarkan laporan yang diterima, tetapi tidak boleh disamakan dengan seluruh quality gates hijau.

### Posisi aktif

1. **Big Phase: P12 — Work Modes & Permission Architecture (`CLOSED / VERIFIED`, disetujui pemilik 2026-10-22).** Audit closure P12 selesai tanpa cacat implementasi terkonfirmasi dan tanpa perubahan kode produksi; bukti, residual yang diterima, dan batas bukti ada di `P12_PHASE_CLOSURE_REPORT.md`. P13 dan P14 berjalan setelah closure ini — lihat item 10–12.
2. **Cross-cutting UX/security: P0 / `UX-001` — TUI error sanitization: `FIX VERIFIED`.** Jalur TUI nyata menggunakan formatter kanonis; tes sentinel dan A/B membuktikan kebocoran ditutup untuk pola yang diuji. Full suite tidak dijalankan.
3. **Quality Remediation Stage 5A: `COMPLETE — ROOT CAUSE PROVEN`.** Diagnosis checkpoint race selesai.
4. **Quality Remediation Stage 5B: `FIX VERIFIED`.** Pending checkpoint work kini dilacak, rejection ditangani sejak awal, dan `close()` men-drain pekerjaan yang dimiliki. Tes regresi 4/4, `work-mode-hooks` 10/10, suite terkait 210 dan 336 pass pada batch terpisah.
5. **Quality Remediation Stage 6: `FIX VERIFIED`.** TypeScript turun dari 28 diagnostik ke 0; tes berkas terkait 190 pass / 1 skip / 0 fail. Tidak ada perubahan `tsconfig` atau penurunan strictness.
6. **Quality Remediation Stage 7: `FIX VERIFIED` (laporan pemilik).** `bun run lint` berubah dari 572 error menjadi exit 0; `bun x tsc --noEmit` tetap 0; `git diff --check` lulus; tes terkait dilaporkan 1.345 pass tanpa fail. Kebijakan LF diselaraskan secara eksplisit melalui `biome.json` dan konfigurasi/dokumen repo yang ada. Full suite, coverage, dan package gate belum dijalankan.
7. **Quality Remediation Stage 8.1: `FIX VERIFIED` menurut laporan Agent A (2026-10-21).** Budget 3.584 KiB (3,5 MiB) dilaporkan menjadi satu sumber di `scripts/pack-budget.ts`, dipakai oleh gate dan tes. `bun run gate:pack` dilaporkan exit 0, 23 pass / 0 fail, ukuran paket 3.345 KiB dan headroom 239 KiB. TypeScript, lint, `git diff --check`, serta dua batch tes terkait dilaporkan lulus. Lihat checkpoint baru di bawah; laporan belum diverifikasi ulang secara independen di sini.
8. **Track Quality Remediation Stage 1–10: `CLOSED / VERIFIED`.** 14 gate lulus; full suite dilaporkan **4.792 pass / 19 skip / 0 fail / 0 error**; coverage **87,38% funcs / 88,33% lines**; ukuran paket **3.215 KiB** terhadap batas ketat **3.584 KiB**. Angka-angka ini adalah **laporan track Quality Remediation** pada kandidat audit P12 — **terpisah** dari bukti closure P12, dan **bukan** klaim repository hijau pada working tree saat ini. Track ini adalah lintas-fase, bukan Big Phase P9/Sub-Agent.
9. **Agent B — audit dokumentasi repository: `REPORTED COMPLETE`; Batch M0 rasionalisasi `APPLIED`; proposal M1–M12 `AWAITING OWNER REVIEW`.** Audit menutup 23 kontradiksi utama tanpa perubahan produk. Batch M0 (2026-10-22) memperbaiki dua cacat peta arsitektur di `docs/ARCHITECTURE.html` (§06 env var duplikat + `</div>` yatim; §09 tabel invariant basi 24 baris → 35 baris selaras kontrak v7.4) **tanpa** menyentuh kode, tes, atau kontrak. Proposal `docs/DOCUMENTATION_RATIONALIZATION_PLAN_2026-10-22.md` menunggu review pemilik; **M1–M12 belum diimplementasikan**. `ROADMAP.md` tetap draft working-tree yang belum di-commit; review diff oleh pemilik masih terbuka.
10. **Big Phase P13 — Desktop & Long-Running Runtime: `CLOSED / VERIFIED — DOCUMENTED LIMITATIONS` (implementation closure; seluruh kerja belum di-commit).** P13.1–P13.6 terimplementasi dan divalidasi pada satu kandidat working tree. Bukti: `P13_3_STAGE_C_REPORT.md`, `P13_5_REPORT.md`, `P13_6_REPORT.md`. Limitasi yang **wajib** disebut bersama status ini: ACP tidak dipasang sebagai consumer P13 baru; koreografi restart daemon penuh belum diuji E2E; retry append event belum diimplementasikan; gate telemetry memakai jalur skip saat tidak ada `traces.jsonl`. Jangan mengklaim kompatibilitas external-client atau jaminan locking network-filesystem.
11. **Big Phase P14 — Cross-Session Unfinished Work Reconciliation: `CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS` (pemilik, 2026-10-26).** P14.0–P14.6 lengkap untuk kontrak bukti-terstruktur: inventaris lintas sumber, kontrak kategori P14.1 penuh (prosa bebas tidak dipindai — larangan eksplisit roadmap), ekstraksi histori berprovenance, grup duplikat lintas sesi tanpa merge otomatis, portofolio prioritas/blocker/dependensi/next action + filter + ekspor atomik, context pack P14.5, closure feedback berlabel klaim + matriks forensik. Kelima kriteria acceptance §10 dipenuhi dengan bukti tes (suite baru 42 tes; suite penuh 5115 pass / 0 fail; seluruh gate hijau pada satu kandidat beku). **Eksklusi scope yang tetap berlaku:** ekstraksi intent dari prosa bebas, readout TUI `/openwork`, merge dengan lease/admission, dan merge lintas sesi tanpa adopsi eksplisit. Closure ini **bukan** klaim release-ready (limitasi P13 tetap berlaku). Bukti: `P14_REPORT.md` §1/§1.1/§3/§4/§6; seluruh kerja tetap uncommitted.
12. **Status working tree / commit:** HEAD `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`, branch `main`; **133 modified + 47 untracked, 0 staged**, stash kosong; seluruh kerja P12/P13/P14 dan `ROADMAP.md` **belum di-commit**. Gate akhir dijalankan pada satu kandidat beku; angka dan sidik jari dicatat di checkpoint 2026-10-26 dan §12. Status implementasi **tidak** sama dengan status commit/push.

---

### Aturan komunikasi status roadmap

Setiap respons status proyek harus selalu memakai tiga label terpisah:

1. **Big Phase:** posisi fase arsitektur P1–P14 (P12 `CLOSED / VERIFIED`; P13 `CLOSED / VERIFIED — DOCUMENTED LIMITATIONS`; P14 `CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS`, disetujui pemilik 2026-10-26).
2. **Quality Remediation:** Stage 1–10 `CLOSED / VERIFIED` — 14 gate lulus; full suite 4.792 pass / 19 skip / 0 fail / 0 error; coverage 87,38% funcs / 88,33% lines; paket 3.215 KiB vs batas ketat 3.584 KiB (laporan track pada kandidat audit P12).
3. **Cross-cutting follow-up:** label UX/security seperti P0/UX-001 (P0 TUI security sudah verified; bukan fase besar).

Jangan mengatakan “kita di P7” bila maksudnya Stage 7. Status terkini: “P12 CLOSED / VERIFIED (pemilik, 2026-10-22); Quality Remediation Stage 1–10 CLOSED / VERIFIED (kandidat historis); P13 implementation closure CLOSED / VERIFIED — DOCUMENTED LIMITATIONS; P14 CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS (pemilik, 2026-10-26; terbatas pada kontrak bukti-terstruktur, bukan klaim release-ready); seluruh kerja P13/P14 masih uncommitted.” Sebutkan sumber laporan dan jangan menyamakan hasil track-scoped dengan repository strict-green pada working tree saat ini. Bila suatu pekerjaan keluar dari urutan fase besar, nyatakan itu eksplisit dan jelaskan prasyarat/risiko yang ditanganinya.


### Checkpoint tambahan — Agent B repository documentation audit (laporan diterima 2026-10-21)

**Status: AUDIT DILAPORKAN SELESAI; integrasi roadmap sudah dieksekusi (draft working-tree), review diff pemilik masih terbuka.** Sumber: `docs/REPOSITORY_DOCUMENTATION_AUDIT_2026-10-21.md` yang diunggah pemilik dari hasil Agent B. Angka di bawah merupakan apa yang dilaporkan oleh Agent B dan belum diverifikasi langsung oleh assistant melalui working tree.

- Inventaris: 210 Markdown + 3 HTML ditinjau dan diklasifikasikan; laporan menyebut 206 detail per-path.
- Perubahan dokumentasi: 25 berkas dimodifikasi + satu laporan audit baru. Agent B melaporkan nol perubahan produk, dengan 68 perubahan non-dokumentasi dipertahankan sebagai pre-existing.
- Temuan prioritas: 23 kontradiksi dokumen ditangani; antara lain versi/contract I1–I35, vendor pin, coverage threshold 86/86, hitungan modul, ekspor, CLI, path persistensi, terminologi TUI, dan peta proteksi kontrak. Enam kelompok klaim tanpa assertion dipisahkan menjadi bagian “Gap proteksi”, bukan ditampilkan seolah-olah terlindungi.
- Validasi terarah dilaporkan lulus: `git diff --check` exit 0; 0 tautan relatif rusak dari 161 yang diperiksa; 33 pass arsitektur/boundary; 68 pass web/env/import; 302 pass peta proteksi kontrak; harness audit 60 pass + 2 advisory; generator changelog tetap 33 entri tanpa perubahan hasil.
- Full suite audit Agent B **tidak selesai dalam anggaran 15 menit**. Satu timeout teramati pada `phase6v-adversarial-audit` §28.1 (5.000 ms); dua tes `release-readiness` gagal karena `package.json` `files` berisi glob `docs/*.md` menurut laporan. Agent B menyatakan glob tersebut sudah ada di working tree sebelum audit, tetapi karena tree dipakai bersama oleh beberapa agen, atribusi ini perlu diselaraskan dengan Agent A sebelum patch atau keputusan.
- `gate:coverage`, `gate:pack`, TypeScript, dan lint **tidak dijalankan oleh Agent B** pada audit ini; tidak ada dasar untuk menyebut seluruh gate hijau. Hasil `gate:pack` yang positif dari Stage 8.1 tetap berasal dari laporan Agent A sebelumnya.
- Blocker yang masih memerlukan tindakan pemilik/implementasi: **B-1** sudah tertutup oleh integrasi `ROADMAP.md` ke repo pada 2026-10-21 (draft working-tree, belum di-commit — masih perlu commit + review diff pemilik); **B-2** belum ada formal P12 closure; **B-3** gap proteksi kontrak memerlukan tests; **B-4** gate penuh belum diverifikasi pada revisi audit; **B-5** `package.json files` glob ↔ release-readiness; **B-6** pengecualian `MINICODE_FOOTER` usang; **B-7** publikasi registry npm tidak terbukti dari repo; **B-8** benturan nama `docs/agents.md` vs `docs/AGENTS.md` pada filesystem case-insensitive.

**Langkah tata kelola berikutnya (per 2026-10-21; status historis):** closure P12 dan track Quality Remediation Stage 1–10 sudah ditutup pemilik. Berikutnya: (a) pemilik meninjau diff integrasi `ROADMAP.md` + Batch M0, lalu **GOV-01** dapat ditutup; (b) proposal rasionalisasi dokumentasi M1–M12 ditinjau pemilik sebelum implementasi; (c) **P13.0 entry audit read-only** menjadi langkah arsitektur berikutnya yang layak — **kemudian dieksekusi**: P13.1–P13.6 dan P14 full-scope; lihat checkpoint 2026-10-26. Jangan meminta Agent B mengulang audit. Jangan mengklaim P13/P14 mulai **pada checkpoint 2026-10-21 ini**; jangan menyamakan laporan track-scoped dengan repository strict-green pada working tree saat ini.

---

### Checkpoint — Rekonsiliasi status 2026-10-22 (historical; digantikan checkpoint 2026-10-26)

**Status: dua track ditutup atas dasar bukti terpisah; keduanya terikat pada kandidat audit yang sama.** Angka di bawah adalah **laporan**, bukan eksekusi ulang pada working tree saat ini.

| Item | Nilai |
|---|---|
| Big Phase P12 | **`CLOSED / VERIFIED`** — disetujui pemilik 2026-10-22, atas dasar audit closure P12 (`READY FOR OWNER CLOSURE REVIEW`, tanpa cacat implementasi terkonfirmasi, tanpa perubahan kode produksi) |
| Track Quality Remediation Stage 1–10 | **`CLOSED / VERIFIED`** — atas basisnya sendiri (14 gate lulus) |
| P13 / P14 | **`PENDING — NOT STARTED`** — keduanya belum dimulai; closure P12 **tidak** memulai salah satunya |
| Artefak closure P12 | `P12_PHASE_CLOSURE_REPORT.md` |
| Kandidat yang diaudit | `HEAD=2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`, sidik jari `diff=2c77ab7eeebbd1bfef9707fe222b77092473977b` |
| Working tree saat dokumen ini direkonsiliasi | sidik jari `diff=c1687f9563a37a5befa1cc2abadfa59da6e238bf` — **tidak lagi sama** dengan kandidat audit |

**Bukti track Quality Remediation (laporan, kandidat audit P12):** 14 gate lulus · full suite **4.792 pass / 19 skip / 0 fail / 0 error** · coverage **87,38% funcs / 88,33% lines** · ukuran paket **3.215 KiB** vs batas ketat **3.584 KiB**.

**Batas bukti — baca sebelum mengutip angka.** Sidik jari `diff=2c77ab7e…` menjelaskan **kandidat yang diaudit**, **bukan** setiap byte working tree yang terintegrasi sesudahnya: setelah audit, lapisan dokumentasi berubah (Batch M0 pada `docs/ARCHITECTURE.html`, proposal rasionalisasi, laporan Closure P12). Perbedaan itu **hanya** di lapisan dokumentasi — **tidak ada** perubahan sumber atau tes P12 yang dilaporkan. Jadi angka-angka di atas **bukan** klaim "repository hijau sekarang", dan **bukan** eksekusi ulang pada working tree pasca-Batch-M0.

**Residual yang diterima pada closure P12** (detail + bukti di `P12_PHASE_CLOSURE_REPORT.md`):

1. **Cakupan tes — minor.** Belum ada tes regresi khusus untuk **resume dengan state WorkMode basi**. Audit membuktikan WorkMode tidak pernah dipersistensi dan default selalu resolve ke `EXECUTE`, jadi skenario resume tidak mewarisi WorkMode basi — namun ini tetap **gap cakupan tes**.
2. **`describeDenial` punya owner-map berbatas 500 entri (FIFO).** Perilaku yang sudah ada sebelumnya, **di luar scope P12**, tidak diubah.
3. **`src/lib/atomic-write.ts` menelan error `mkdir`.** **Item backlog rekayasa terpisah**, bukan bagian closure P12; berkasnya tidak dimodifikasi pada fase itu.

**Yang TIDAK diklaim oleh checkpoint 2026-10-22 ini:** P13/P14 belum dimulai · `ROADMAP.md` masih draft working-tree yang belum di-commit · GOV-01 **belum ditutup** (menunggu review diff pemilik) · proposal rasionalisasi M1–M12 **belum diimplementasikan**.

---

### Checkpoint — Konsolidasi akhir & release-readiness 2026-10-25

**Status (HISTORICAL — posisi 2026-10-25, digantikan checkpoint 2026-10-26 di bawah): P13 implementation closure dan P14 core + lite terverifikasi pada satu kandidat working tree; commit/push belum dilakukan dan acceptance penuh P14 saat itu masih terbuka.** Checkpoint 2026-10-22 di atas tetap historical untuk tanggal itu.

| Item | Nilai |
|---|---|
| Branch / HEAD | `main` / `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4` |
| `git status --porcelain` | **177 baris = 132 modified + 45 untracked, 0 staged** |
| `git diff --stat` | **132 files changed, 4951 insertions(+), 932 deletions(-)** |
| Stash | kosong |
| Vendor | `c8d214bb8d5eea86` (20 berkas), sinkron `VENDOR.md` |
| Commit/push | **tidak ada** — seluruh kerja P12/P13/P14 + `ROADMAP.md` uncommitted |
| Artefak P13 | `P13_3_STAGE_C_REPORT.md`, `P13_5_REPORT.md`, `P13_6_REPORT.md` |
| Artefak P14 | `P14_REPORT.md`, `docs/P14_OPEN_WORK.md` |

**P13 — `CLOSED / VERIFIED — DOCUMENTED LIMITATIONS` (implementation closure).** P13.1–P13.6 terimplementasi; P13.6 memverifikasi matriks 20 baris = 15 V + 1 F + 1 M→F + 3 X. Limitasi yang wajib disebut: ACP tidak dipasang sebagai consumer P13 baru, koreografi restart daemon penuh belum diuji E2E, retry append event belum diimplementasikan, dan gate telemetry memakai jalur skip saat tidak ada `traces.jsonl`. Tidak ada klaim kompatibilitas external-client atau jaminan locking network-filesystem.

**P14 — `CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS` (pemilik, 2026-10-26).** Status per milestone:

| Milestone | Status | Catatan |
|---|---|---|
| P14.0 inventory | **COMPLETE** | `openwork inventory`: sesi+binding (foreign/unbound beralasan, anak via lineage), task, event per tipe, run, checkpoint (corrupt dilabel tanpa ditulis), plan, approval, sub-agent |
| P14.1 kontrak unfinished-work | **COMPLETE** | Sepuluh kategori + bukti per state + freshness + aturan komitmen (hanya artefak terstruktur; prosa dilarang roadmap) + pengungkapan konflik |
| P14.2 candidate extraction | **COMPLETE** | plan/approval/delegasi/run terputus berprovenance eksak (eventSeq/turnId/id artefak); ringkasan ter-clip; klaim plan vs task kanonik direkonsiliasi |
| P14.3 dedup/reconciliation | **COMPLETE** | Grup duplikat lintas sesi UNPROVEN + DIVERGENT; nol merge otomatis; TaskStore tetap otoritas tunggal |
| P14.4 portfolio | **COMPLETE** | state/prioritas/blocker/dependensi/next action; filter proyek/status/state/prioritas/umur/blocker/dependensi/sesi; ekspor json/md atomik |
| P14.5 resume/continuation | **COMPLETE** | `openwork context` pack berprovenance + checklist resume yang menunjuk jalur pemaksa P12/P13; adopsi/scheduler manual tidak berubah |
| P14.6 closure/forensic | **COMPLETE** | Closure feedback + label klaim verified/unverified/not-applicable; matriks forensik (restart, terputus, checkpoint korup, sub-agent, konflik, pembatalan, permission denial, stale, lintas sesi) |

**Lima keputusan P14 yang tersisa (klasifikasi eksplisit):**

1. **P14.1 penuh / kontrak intent** — `OWNER DECISION`; prasyarat ekstraksi histori.
2. **Ekspor portofolio** — `OPTIONAL EXTENSION`; `--json` sudah menjadi pratinjau.
3. **TUI readout `/openwork`** — `OPTIONAL EXTENSION / OWNER DECISION`; permukaan TUI baru butuh kontrak terminal.
4. **Dedup lintas sesi langsung** — `DEFERRED / OWNER DECISION`; model otoritas mensyaratkan adopsi eksplisit.
5. **Merge dengan lease/admission** — `OPTIONAL EXTENSION`; pagar lebih tinggi dari `todo_write`.

**Bukti gate final** pada kandidat yang sama (perintah, exit code, hasil, sidik jari) dicatat di §12. Angka itu **hanya** berlaku untuk kandidat yang disebutkan; jangan menggabungkannya dengan angka historical P12/P13/P14 di laporan lain.

### Checkpoint — P14 full-scope gap closure 2026-10-26

**Status: P14.0–P14.6 full-scope terverifikasi pada satu kandidat working tree; seluruh gate dijalankan pada kandidat itu; pemilik menyetujui closure P14 (2026-10-26); commit/push tetap belum dilakukan.** Checkpoint 2026-10-25 di atas tetap historical untuk era LITE; bagian "Status delivery P14" §4 di bawah mencerminkan posisi aktif. Angka gate final kandidat 2026-10-26 ada di §12.

| Item | Nilai |
|---|---|
| Branch / HEAD | `main` / `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4` |
| `git status --porcelain` | **180 baris = 133 modified + 47 untracked, 0 staged** |
| `git diff --stat` | **133 files changed, 5134 insertions(+), 932 deletions(-)** |
| Sidik jari kandidat | tracked diff `b53ef0c552ecc1199726527d5254fcf7f8f4ca10` (stabil); hash untracked lengkap dicatat di handoff — dokumen ini termasuk di dalamnya sehingga angkanya tidak bisa ditulis di sini tanpa membatalkan diri sendiri |
| Stash | kosong |
| Vendor | `c8d214bb8d5eea86` (20 berkas), sinkron `VENDOR.md` |
| Commit/push | **tidak ada** — seluruh kerja P12/P13/P14 + `ROADMAP.md` uncommitted |
| Artefak P14 | `P14_REPORT.md`, `docs/P14_OPEN_WORK.md`, `test/p14-full-scope.test.ts` |

**P14 — `CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS`.** Status per milestone (bukti rinci + matriks acceptance §10 ada di `P14_REPORT.md` §1/§1.1):

| Milestone | Status | Catatan |
|---|---|---|
| P14.0 inventory | **COMPLETE** | `openwork inventory`: sesi+binding (foreign/unbound beralasan), task, event per tipe, run, checkpoint (corrupt dilabel tanpa ditulis), plan, approval, sub-agent; sesi anak di-scope via lineage |
| P14.1 kontrak unfinished-work | **COMPLETE** | Sepuluh kategori + bukti per state + freshness + aturan komitmen (hanya artefak terstruktur; prosa DILARANG roadmap) + pengungkapan konflik |
| P14.2 candidate extraction | **COMPLETE** | plan/approval/delegasi/run terputus, berprovenance eksak (eventSeq/turnId/id artefak); ringkasan ter-clip; klaim plan vs task kanonik direkonsiliasi |
| P14.3 dedup/reconciliation | **COMPLETE** | Grup duplikat lintas sesi UNPROVEN + DIVERGENT; nol merge otomatis; TaskStore tetap otoritas tunggal |
| P14.4 portfolio | **COMPLETE** | state/prioritas/blocker/dependensi/next action; filter proyek/status/state/prioritas/umur/blocker/dependensi/sesi; ekspor json/md atomik |
| P14.5 resume/continuation | **COMPLETE** | `openwork context` pack berprovenance + checklist resume yang menunjuk jalur pemaksa P12/P13; adopsi/scheduler manual tidak berubah |
| P14.6 closure/forensic | **COMPLETE** | Closure feedback + label klaim verified/unverified/not-applicable; matriks forensik (restart, terputus, checkpoint korup, sub-agent, konflik, pembatalan, permission denial, stale, lintas sesi) |

**Evaluasi ulang lima keputusan 2026-10-25** (bukti teks milestone di `P14_REPORT.md` §6): (1) kontrak intent — selesai untuk scope roadmap; kebijakan prosa = scope baru bila pemilik mau, bukan gap P14; (2) ekspor — **koreksi: ternyata dituntut teks milestone ("tampilkan/ekspor"), kini selesai**; (3) TUI `/openwork` — tetap di luar scope P14 (teks milestone tidak memintanya); (4) dedup lintas sesi langsung — deteksi/grup selesai sebagai projection sesuai teks milestone, merge langsung tanpa adopsi tetap deferred pemilik; (5) lease merge — tetap optional extension (tidak dituntut milestone).

**Keputusan pemilik 2026-10-26:** P14.0–P14.6 dan Definition of Done §10 **disetujui dan ditutup** sebagai `P14 CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS`, terbatas pada kontrak bukti-terstruktur. Item #1/#3/#4/#5 di atas tetap **eksklusi scope** (bukan gap yang belum terpenuhi) dan hanya bisa dibuka sebagai scope baru. Closure P14 **bukan** klaim release-ready: limitasi P13 tetap berlaku (`P14_REPORT.md` §5.12) dan repository masih uncommitted (§5.13).

---

## 3. Prinsip arsitektur yang melintasi semua fase

MiniCode dipandang memiliki empat bidang yang saling berhubungan:

- **Control plane / harness:** context, prompt contract, model routing, agent loop, capability/policy, session/state, task/orchestration, verification/recovery, presentation/observability, human control.
- **Execution plane:** sandbox, process, filesystem, network, dan external effects.
- **Evidence plane:** event/journal, intent/receipt, verification records, traces, replay, dan evaluations.
- **Consumer plane:** CLI, TUI, ACP, API, dan kelak Desktop.

Untuk setiap slice, jawab secara eksplisit:

1. Apa yang model lihat?
2. Apa yang model boleh lakukan?
3. Siapa yang memberikan capability?
4. Siapa pemilik state kanonik?
5. Bagaimana eksekusi dilakukan?
6. Bagaimana kegagalan diamati?
7. Bagaimana recovery dipilih?
8. Bagaimana hasil diverifikasi?
9. Bagaimana perilaku direplay?
10. Bagaimana perilaku dievaluasi?

### Kebijakan live integration testing / OpenRouter (ditambahkan 2026-10-21)

Untuk tahap atau pengujian yang benar-benar membutuhkan request ke model/provider nyata, OpenRouter dapat dipakai sebagai opsi live integration test. Penggunaan API nyata harus dibedakan dari unit test hermetic/fake provider; hasil live test tidak boleh menggantikan tes deterministik.

- Nama environment variable yang diharapkan: `OPENROUTER_API_KEY`. Pemilik mengatur variabel ini di environment proses/agent yang menjalankan tes, atau melalui mekanisme secret injection yang tersedia.
- Prompt agent harus menyuruh agent memeriksa apakah `OPENROUTER_API_KEY` tersedia tanpa mencetak nilainya. Jangan memasukkan nilai API key literal ke prompt reusable, dokumen roadmap, source code, test fixture, command-line argument, log, screenshot, atau laporan.
- Jika variabel tersedia dan live test memang diperlukan oleh scope/DoD, jalankan test terbatas dengan model, timeout, dan jumlah request yang dinyatakan eksplisit. Jangan mengirim traffic live secara tidak perlu.
- Jika variabel tidak tersedia, jangan mengarang hasil atau berpura-pura live test dijalankan. Selesaikan tes hermetic yang tetap relevan, lalu tandai live test sebagai `NOT RUN — OPENROUTER_API_KEY unavailable` beserta dampaknya pada DoD.
- Jangan menaruh API key di repository atau artefak persisten. Jangan mencetak environment value ke output. Jangan mengubah unit test agar bergantung pada jaringan/provider nyata.
- Setiap prompt yang membutuhkan pengujian langsung harus menyatakan prasyarat env var, cakupan request, kondisi pass/fail, dan tindakan saat credential tidak tersedia. Pengujian live hanya dijalankan jika sesuai tujuan tahap; package gate atau lint tidak otomatis memerlukan panggilan model.

Nilai credential tidak disimpan di master roadmap. Ini adalah prosedur penggunaan credential untuk live testing, bukan status fase baru.

### Invariant yang tidak boleh dilemahkan

- Canonical session/history tetap memiliki identitas dan writer fencing; writer stale ditolak.
- `saveSession`/canonical persistence tetap menjadi authority sesi; projection, context, presentation, dan trace adalah derived state.
- TaskStore adalah pemilik state/completion task; TaskGraph adalah projection read-only.
- Scheduler melakukan dispatch/koordinasi, bukan mengeksekusi dan bukan memutus completion.
- Eksekusi, observasi, verifikasi, serta completion yang diotorisasi tetap merupakan state berbeda.
- `UNKNOWN` adalah state nyata; tidak boleh diasumsikan sukses.
- Permission enforcement terjadi pada execution boundary. Prompt model atau daftar tool yang tersembunyi bukan security boundary.
- WorkMode tidak boleh menaikkan ceiling PermissionMode atau melemahkan policy yang diinjeksi.
- Presentation bersifat observation-only dan tidak membuat canonical truth kedua.
- Daemon/supervisor menjadi host/lifecycle manager, bukan sumber kebenaran runtime kedua.
- Tidak ada auto-retry/reclaim di luar kontrak self-healing yang disetujui.
- `vendor/minicore/**` tidak diubah tanpa bukti, kontrak interface, tes boundary, dan keputusan khusus.
- `docs/TERMINAL_CONTRACT.md` tetap menjadi kontrak terminal yang dilindungi; perubahan output memerlukan update dokumen dan tes pelindung.

### Feedback loop wajib

`Real run → trace/evidence → evaluate → failure pattern → bounded harness change → regression test/eval → rerun`.

Masalah yang sudah dipahami idealnya berakhir menjadi invariant, test, evaluation, atau architecture contract—bukan sekadar catatan.

---

## 4. Big-phase architecture roadmap P1–P14

Status P1–P8 di bawah mengikuti roadmap kanonis/handoff yang menyatakan fase-fase tersebut selesai; fase-fase itu tidak semuanya diaudit ulang dari nol dalam konsolidasi ini. Buka ulang hanya bila bukti baru menunjukkan pelanggaran invariant yang nyata.

| ID | Fase | Status saat ini | Scope / exit criteria | Next action |
|---|---|---|---|---|
| P1 | Runtime Foundation | `COMPLETE` (status roadmap) | Runtime host, execution kernel, backend dan policy terpisah; lifecycle/resource governance eksplisit. | Pertahankan kontrak; jangan buka ulang tanpa bukti pelanggaran. |
| P2 | Session Architecture | `CLOSED WITH DOCUMENTED / QUALIFIED DEBT` | Canonical identity, writer epochs, storage, event IDs, Run/cursor, projection, context substrate, child-session substrate, verification/presentation, daemon host. | Pertahankan invariant sesi, stale-writer guard, UNKNOWN-first. |
| P3 | Context ↔ Session Reconciliation | `COMPLETE` (status roadmap) | Canonical session state menjadi model-visible context secara derived, bounded, recoverable, provenance-aware; compaction non-destructive, resume deterministik, paging/branch/child context benar. | Pertahankan `P3_ROADMAP.md` dan contract sebagai scope authority. |
| P4 | Agent Loop | `COMPLETE` (status roadmap) | Orkestrasi model/tool/observation/persist/continue/final/recovery tanpa mengambil alih authority Session, TaskStore, Verification atau Scheduler. | Jangan menggandakan authority di agent loop. |
| P5 | Tool Execution | `COMPLETE` (status roadmap) | Registry, ToolContext, permissions/capability, approval, sandbox/process/filesystem/network, resource limits, effect evidence dan idempotency. | Perbaiki hanya berdasarkan temuan aktual; jangan anggap policy prompt sebagai enforcement. |
| P6 | Task System | `COMPLETE` | Task adalah primitive durable; TaskStore adalah sole task-state/completion authority. | Pertahankan jalur completion kanonik. |
| P7 | TaskGraph | `COMPLETE` | Graph merupakan deterministic read-only projection atas TaskStore. | Jangan jadikan graph sebagai authority kedua. |
| P8 | Scheduler | `COMPLETE` | Scheduler memilih/dispatch/observe; TaskStore memutus claim, Agent Loop mengeksekusi, Verification memverifikasi. | Jangan jadikan scheduler executor/completion authority. |
| P9 | Sub-Agent / Execution | `CLOSED` menurut laporan closure | Child spawning/delegation, konteks/authority terpisah, capability attenuation, lifecycle, result return, verification, failure propagation, cancellation dan koordinasi multi-agent. | Fitur baru terkait manager berkelanjutan masuk sebagai follow-up design, bukan reopening otomatis. |
| P10 | Verification & Self-Healing | `CLOSED WITH DOCUMENTED LIMITATIONS` | Execution → evidence → verification → classification → recovery/compensate/redispatch/escalate → verify again. UNKNOWN tetap first-class. | Pertahankan semantics; R1 tetap dormant. |
| P11 | Presentation / UX | `CLOSED WITH DOCUMENTED LIMITATIONS`; follow-up baru terbuka | Presentation observation-first, provenance-aware, replayable, bounded, verification/recovery-aware dan tahan reconnect. | Tangani backlog audit UI/UX sebagai `UX-FOLLOWUP`, tanpa mengubah status historis closure secara retroaktif. |
| P12 | Work Modes & Permission Architecture | `CLOSED / VERIFIED` (pemilik, 2026-10-22) | WorkMode DISCUSS/PLAN/EXECUTE terpisah dari PermissionMode; ceiling efektif merupakan irisan WorkMode, PM, injected policy dan guard; tidak ada eskalasi implisit. | Focused closure review selesai tanpa cacat implementasi terkonfirmasi; bukti + residual yang diterima di `P12_PHASE_CLOSURE_REPORT.md`. |
| P13 | Desktop & Long-Running Runtime | `CLOSED / VERIFIED — DOCUMENTED LIMITATIONS` (implementation closure; uncommitted) | Supervised processes, readiness/health/logs, start/stop/cleanup, background work, durable state, budgets, recovery/resume, multi-client runtime dan integrasi P12. | P13.1–P13.6 terimplementasi dan divalidasi pada satu kandidat; bukti di `P13_6_REPORT.md`. Sebelum commit, pemilik meninjau limitasi: ACP consumer belum dipasang, restart daemon penuh belum E2E, retry append event belum ada, telemetry skip baseline. |
| P14 | Cross-Session Unfinished Work Reconciliation | `CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS` (pemilik, 2026-10-26) | Menginventarisasi seluruh sesi relevan yang masih menyisakan tujuan, komitmen, blocker, atau tugas belum tuntas; merekonsiliasi bukti lintas sesi menjadi satu portfolio open work yang deduplicated dan dapat ditindaklanjuti tanpa membuat task authority kedua. | P14.0–P14.6 full-scope terverifikasi (`P14_REPORT.md`); seluruh gate hijau pada satu kandidat beku. Eksklusi scope tetap: intent dari prosa bebas, TUI `/openwork`, lease-merge, merge lintas sesi tanpa adopsi. Bukan klaim release-ready; uncommitted. |
| R1 | Runtime Execution Backend | `DORMANT` | Kandidat backend execution baru hanya bila ada kebutuhan supervised-process konkret yang tidak terpenuhi oleh jalur yang ada. | Perlu keputusan terpisah; P13 maupun P14 tidak otomatis mengaktifkannya. |

### P12 — apa yang sudah ada dan apa yang belum boleh diasumsikan

Arah WorkMode yang disetujui pemilik:

- WorkMode dan PermissionMode adalah dua dimensi yang terpisah.
- Mode yang dipakai: `DISCUSS`, `PLAN`, `EXECUTE`.
- WorkMode adalah lapisan intent/ceiling tipis, bukan permission engine kedua.
- Tidak ada eskalasi implisit; DISCUSS membatasi ke baca/inspeksi, PLAN mengikuti kontrak planning yang diputuskan, EXECUTE tetap tunduk pada PermissionMode.
- Perilaku keenam PermissionMode yang lama tetap kompatibel.
- State mode tidak otomatis dipersist; semantik `always`/allowlist tidak boleh diganti diam-diam.
- Policy restriktif yang diinjeksi tidak dapat dilemahkan oleh runtime toggle atau pewarisan sub-agent.
- Refactor registry harus menjaga keputusan observable dan didukung replay/regression.
- Vendor changes hanya atas bukti ketidakcukupan application layer dan dengan boundary test.

Commit/artefak P12 yang tercatat termasuk desain P12.1 (`0987018`), contract/regression test (`e6d144e`, `c0b913f`, `4ef2885`), permission ceilings (`32b0dfa`) dan runtime ceilings/controls (`fc456b6`). WorkMode telah terhubung dengan CLI/environment/session/ACP/runtime dan kontrol interaktif menurut laporan implementasi.

**Closure P12 belum boleh diumumkan hanya karena fitur sudah ada.** Minimum syarat closure:
- Keputusan D-1…D-7 dan K-1 konsisten dengan implementasi terkini.
- Replay/regression bukti efektif WorkMode × PermissionMode; sel konflik dilaporkan, tidak diubah berdasar asumsi.
- Tidak ada bypass permission melalui `/mode`, Shift+Tab, sub-agent, tool dispatch atau injected handler.
- Resume/lifecycle dan pewarisan sub-agent teruji; mode tidak dipersist diam-diam.
- Cross-phase regression dan batasan yang belum selesai terdokumentasi.
- Penutupan boleh `CLOSED WITH DOCUMENTED LIMITATIONS`; jangan mengklaim seluruh repository strict-green jika quality gate global masih gagal.

### P13 — Desktop & Long-Running Runtime: urutan yang direncanakan

P13 tidak langsung dimulai dengan coding. Urutannya:

1. **P13.0 Entry audit (read-only):** inventaris kemampuan yang sudah ada di daemon/supervisor, IPC, session, TaskStore, Scheduler, approval, resource budgets, checkpoint/resume, recovery, notifications, CLI/ACP consumers. Tandai mana yang nyata, parsial, duplikat, atau belum ada.
2. **P13.1 Runtime contract:** ownership proses dan tugas, lifecycle state machine, readiness/health, logs, start/stop/cleanup, cancellation/deadline, budget/resource limits, restart/incarnation, failure semantics, durable approval, reconnect/replay, safe resume, permission propagation.
3. **P13.2 Bounded process supervision:** hanya setelah kontrak dibekukan; satu jalur ownership proses, tidak ada child process yang terlepas, cleanup/recovery teruji.
4. **P13.3 Long-running task continuity:** durable progress/checkpoint, state machine, budget, resume dan failure recovery; state authoritative tetap di subsystem yang sudah memiliki ownership.
5. **P13.4 Multi-client presentation:** CLI/TUI/ACP/API menggunakan state/evidence yang sama tanpa menjadikan consumer sebagai authority.
6. **P13.5 End-to-end workflows:** server start/readiness/health/logs/stop; task lanjut setelah disconnect/restart; approval/permission tetap berlaku; failure dan UNKNOWN dilaporkan jujur.
7. **P13.6 Forensic validation & closure:** fault injection, restart/crash, resource exhaustion, reconnect, cross-phase tests, limitations dan keputusan R1.

Kriteria masuk implementasi P13: P12 sudah memiliki kontrak/closure yang cukup; Stage 5B selesai; ownership/lifecycle asynchronous ditetapkan; audit mengidentifikasi gap yang nyata; tidak membangun ulang daemon atau state authority yang sudah ada.

**Status implementasi 2026-10-25:** P13.1–P13.6 sudah diimplementasikan dan divalidasi pada satu kandidat (`P13_5_REPORT.md`, `P13_6_REPORT.md`), dengan closure **`CLOSED / VERIFIED — DOCUMENTED LIMITATIONS`**. Yang **tidak** boleh diklaim: integrasi consumer ACP baru, koreografi restart daemon penuh E2E, retry append event, atau jaminan locking network-filesystem. Seluruh kerja masih uncommitted.

### P14 — Cross-Session Unfinished Work Reconciliation

**Maksud fase:** setelah P13 menyediakan runtime yang dapat bertahan lama dan dipulihkan dengan aman, MiniCode perlu mengumpulkan pekerjaan yang masih terbuka dari seluruh sesi relevan—bukan membiarkan setiap sesi menjadi pulau terpisah yang kehilangan konteks tugas ketika percakapan berhenti, terputus, atau berpindah.

**Masalah yang diselesaikan:** satu sesi dapat memuat tujuan pengguna, janji tindak lanjut, pekerjaan parsial, blocker, eksperimen gagal yang belum ditutup, atau tugas yang diserahkan ke sub-agent. Ketika sesi berakhir, proyek masih dapat memiliki kewajiban yang belum selesai. P14 membuat semua open loops itu dapat ditemukan, dilacak ke bukti asal, dideduplikasi, direkonsiliasi dengan task kanonik, lalu diprioritaskan untuk dilanjutkan.

**Batas penting:** P14 bukan sekadar memory/RAG, bukan rangkuman percakapan massal, dan bukan TaskStore kedua. Hasil agregasi adalah indeks/proyeksi lintas sesi. TaskStore tetap menjadi authority status tugas; history/session tetap menjadi bukti asal; verification menentukan apakah klaim selesai benar-benar didukung. P14 tidak boleh menganggap setiap pesan brainstorming sebagai tugas, menghidupkan kembali tugas yang sudah selesai/dibatalkan/ditolak, atau mengeksekusi ulang secara otomatis tanpa otorisasi yang berlaku.

#### Rencana milestone P14

1. **P14.0 — Cross-session inventory (read-only):** inventaris penyimpanan sesi, session IDs, workspace/project binding, histories, plans, todos/TaskStore, checkpoint, verification, sub-agent outcomes dan artefak progress yang sudah ada. Tentukan batas cakupan pencarian dan bagaimana sesi milik proyek dibedakan dari sesi proyek lain.
2. **P14.1 — Unfinished-work contract:** definisikan kategori seperti `OPEN`, `PARTIAL`, `BLOCKED`, `WAITING_FOR_USER`, `DELEGATED`, `FAILED_NEEDS_FOLLOWUP`, `UNKNOWN`, `COMPLETED`, `CANCELLED`, dan `DECLINED`. Tetapkan bukti yang diperlukan, freshness, kapan intent dianggap komitmen, dan bagaimana konflik antar-sesi diungkapkan.
3. **P14.2 — Candidate extraction with provenance:** ambil kandidat dari sumber kanonik dan artefak yang tersedia; setiap item wajib menunjuk ke source session/thread/turn atau task/evidence yang melandasinya. Simpan kutipan/ringkasan seperlunya, bukan menduplikasi seluruh riwayat sebagai fakta baru.
4. **P14.3 — Deduplication and canonical reconciliation:** kelompokkan item yang merujuk tujuan sama; bedakan tugas berulang yang sengaja independen; cocokkan dengan TaskStore dan status verification. Portfolio lintas sesi tetap projection, sedangkan pembuatan/perubahan tugas harus lewat jalur authority yang ada.
5. **P14.4 — Project-wide open-work portfolio:** tampilkan/ekspor backlog yang bisa difilter menurut proyek, status, prioritas, umur, blocker, dependensi, sesi sumber dan next action. Tampilkan konflik atau item UNKNOWN secara eksplisit; jangan diam-diam membuat status selesai.
6. **P14.5 — Resume and supervised continuation:** pengguna/manager memilih item yang akan diteruskan; susun ulang context dari bukti yang relevan, periksa freshness dan permission/WorkMode, lalu delegasikan atau lanjutkan melalui TaskStore/Scheduler/P9 yang ada jika sesuai. Tidak ada auto-execution tak terbatas. Gunakan budgets, cancellation, checkpointing dan stop criteria dari P12/P13.
7. **P14.6 — Closure feedback and forensic validation:** setelah pekerjaan ditutup, rekonsiliasikan status ke task kanonik dan referensi sumber sehingga pekerjaan tidak terus muncul sebagai open loop. Uji sesi duplikat, tugas stale, sesi terputus, checkpoint hilang, task selesai pada sesi lain, hasil sub-agent, konflik prioritas, pembatalan, permission denial, dan restart.

#### Dependencies dan kriteria selesai P14

- Bergantung pada P3 (identity/context/provenance/resume), P6 (TaskStore authority), P7 (TaskGraph projection), P8 (dispatch ownership), P9 (delegation/result lineage), P10 (verification/recovery), P12 (WorkMode/permission), serta P13 (long-running continuity/supervision).
- P13 perlu cukup matang sebelum P14 mengandalkan durable work/recovery; P14 tidak menjadi prioritas implementasi saat ini.
- P14 selesai hanya jika pencarian sesi relevan dapat diaudit, kandidat unfinished berprovenance, deduplication tidak menyatukan tugas yang berbeda, state kanonik tidak berganda, completion/decline/cancel tidak dihidupkan kembali, stale/UNKNOWN diberi label jujur, dan resume menghormati otorisasi, budget, cancellation serta verification.
- Sumber historis yang ditemukan menetapkan P13 tetapi tidak memuat spesifikasi P14 formal yang berdiri sendiri. Bagian ini ditambahkan untuk merekam arah pemilik yang dikonfirmasi pada 2026-10-21; milestone rinci dapat disesuaikan melalui keputusan pemilik, bukan oleh implementer.

#### Status delivery P14 per 2026-10-26

| Milestone | Status | Bukti / gap |
|---|---|---|
| P14.0 inventory | **COMPLETE** | `openwork inventory` lintas sumber: sesi+binding (foreign/unbound beralasan), task, event per tipe, run, checkpoint (corrupt dilabel tanpa ditulis), plan, approval, sub-agent (anak via lineage) |
| P14.1 unfinished-work contract | **COMPLETE** | Sepuluh kategori (OPEN/PARTIAL/BLOCKED/WAITING_FOR_USER/DELEGATED/FAILED_NEEDS_FOLLOWUP/UNKNOWN/COMPLETED/CANCELLED/DECLINED) + bukti per state + freshness + aturan komitmen (artefak terstruktur saja; prosa dilarang roadmap) + konflik |
| P14.2 candidate extraction | **COMPLETE** | Ekstraksi plan/approval/delegasi/run terputus berprovenance eksak; ringkasan ter-clip; klaim plan vs task kanonik direkonsiliasi |
| P14.3 dedup/reconciliation | **COMPLETE** | Grup duplikat lintas sesi UNPROVEN + DIVERGENT; nol merge otomatis; merge eksplisit + evidence, satu sesi, ledger `task_merges` |
| P14.4 portfolio | **COMPLETE** | state/prioritas/blocker/dependensi/next action; filter proyek/status/state/prioritas/umur/blocker/dependensi/sesi; ekspor json/md atomik |
| P14.5 resume/continuation | **COMPLETE** | `openwork context` pack berprovenance + checklist resume yang menunjuk jalur pemaksa P12/P13; adopsi eksplisit, `/scheduler run` manual |
| P14.6 closure/forensic | **COMPLETE** | Closure feedback + label klaim verified/unverified/not-applicable; matriks forensik (restart, terputus, checkpoint korup, sub-agent, konflik, pembatalan, permission denial, stale, lintas sesi) |

**Kesimpulan:** P14 memenuhi kelima kriteria acceptance §10 untuk kontrak bukti-terstruktur, dan pemilik **menyetujui closure pada 2026-10-26**. Status yang benar adalah `P14 CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS`. Bukti rinci di `P14_REPORT.md` §1/§1.1/§3/§4/§6; readout TUI `/openwork`, lease-merge, merge lintas sesi tanpa adopsi, dan intent dari prosa bebas tetap **eksklusi scope** (klasifikasi pemilik 2026-10-25 dipertahankan). Closure ini bukan klaim release-ready.

---

## 5. Cross-cutting Agent Manager / Continuous Delegation direction

Dari pembahasan pengguna, ada aspirasi agar **main agent menjadi manager/supervisor yang terus memantau pekerjaan, memanggil sub-agent sesuai kebutuhan, mengintegrasikan hasil, dan melanjutkan tugas hingga kondisi berhenti yang jelas terpenuhi**. Ini selaras dengan ambisi long-running agent runtime, tetapi detail kontrak belum boleh dianggap disetujui hanya dari aspirasi ini.

Keputusan roadmap:

- Jangan menyatakan P9 gagal atau membukanya ulang otomatis. P9 sudah memiliki status closure historis.
- Daftarkan `ORCH-FU-01 — Supervisory Agent Operating Model` sebagai **`PENDING DESIGN`** dan masukkan sebagai kebutuhan yang harus dinilai pada P13.0/P13.1, dengan kemungkinan pola eksekusinya dipakai lagi oleh P14 untuk melanjutkan open work lintas sesi.
- Audit apakah primitive P9, TaskStore, TaskGraph, Scheduler, checkpointing, budgets, cancel/deadline dan P12 permission sudah cukup. Tidak langsung membuat scheduler/manager kedua.
- Kontrak desain perlu menjawab: sumber kerja kanonik; kapan supervisor dispatch/menunggu/review; bagaimana hasil sub-agent diverifikasi; deduplication/idempotency; konteks yang diwariskan; capability attenuation; batas depth/fan-out; fairness; budget; cancellation; failure/retry/escalation; termination/stop criteria; observability; safe resume.
- “Terus menerus” tidak berarti loop tanpa batas. Harus ada batas langkah, waktu/resource budget, cancellation, idle/stall detection, dan completion/termination criteria yang eksplisit.
- Perlu riset/desain terpisah sebelum implementasi. Belum ada izin untuk mengubah arsitektur P9 atau membangun orkestrator baru.

---

## 6. UI/UX Follow-up track hasil Mission 00

Audit UI/UX read-only 2026-10-21 menemukan fondasi UI cukup matang; **rewrite besar tidak dibenarkan**. Pertahankan single screen owner, semantic presentation layer, renderer primitives, width/sanitization/input correctness, selection model, i18n, serta wireframe minimal: satu footer, satu prompt, ledger ringkas, dan indikator aktivitas yang tidak berisik.

Temuan audit dilakukan pada Windows/Bun 1.4.3 dan checkpoint `205e355` dengan Stage 4B masih uncommitted. Karena itu sebagian hasil test/gate adalah historis serta berlingkungan khusus. Untuk status item yang tidak disentuh commit setelahnya, gunakan `UNVERIFIED AFTER 2d9e11e` jika belum ada tes baru.

### Urutan prioritas UX

#### UX-P0 — correctness/security/reliability

1. **UX-001 — Redact/format error TUI.** Audit meruntime-reproduksi bahwa provider error dapat merender raw JSON yang memuat bearer token karena `app.ts` memanggil `pushError(e.message)` alih-alih formatter kanonik. Anggap masih terbuka sampai ada diff/test yang membuktikan perbaikan. Acceptance: satu blok error yang ramah, tanpa raw JSON, `Bearer`, atau `sk-` token; tampilkan petunjuk next step; tes unit/transcript dan satu assertion PTY.
2. **UX-002 — Checkpoint promise ownership.** Ini sekarang terkait langsung dengan Stage 5A/5B; jangan duplikasi implementasi atau membuat dua pekerjaan. Gunakan satu fix di `cli/setup.ts` dengan pending-operation tracking/drain barrier dan jalur pelaporan rejection.
3. **UX-003 — Restore terminal on abnormal exit.** Raw mode dilaporkan belum dipulihkan pada uncaught exception. Setelah containment checkpoint ditangani, tambah tes PTY bahwa terminal cooked/echo dipulihkan, kemudian error tetap dinaikkan/dilaporkan—jangan ditelan.
4. **UX-004 — Fake-TTY test isolation.** Audit mengidentifikasi potential leak pada `test/presentation-linear-acp.test.ts` yang membuat suite order-dependent. Status setelah checkpoint `2d9e11e` belum direkonsiliasi langsung; reproduksi ulang pasangan test dalam kedua urutan sebelum mengubahnya. Jika terkonfirmasi, restore exact previous terminal/test handle.

#### UX-P1 — usability/performance yang terlihat pengguna

5. **UX-005 — TUI detail model.** `/compact`, `/minimize`, dan `Ctrl+O` pernah terbukti no-op di TUI meski diiklankan oleh help. Ini membutuhkan keputusan pemilik: implementasi in-TUI disclosure atau hapus eksposur control dari surface/help. Jangan implement sebelum keputusan produk eksplisit.
6. **UX-006 — Keep sub-agent outcomes visible.** Child activity dilaporkan hilang setelah child selesai. Putuskan grammar parent row (jumlah child/status agregat) dan cara menemukan hasil child; orphan/ambiguous relation harus dilaporkan, bukan dipromosikan diam-diam.
7. **UX-007 — Bounded paint path.** Pengukuran audit: sekitar 80,4 ms/frame pada 5.000 baris; sasaran audit <16 ms/frame pada cap tersebut dengan cache/incremental projection. Perubahan high-risk: lindungi selection anchors, resize/table reflow, evict marker, scroll lock, dan satu projection per paint.
8. **UX-008 — Cross-renderer behavior parity.** Tambahkan table-driven parity test lintas TUI, linear output, ACP dan exec pada turn yang sama; bedakan intentional presentation variants dari behavioral disagreement.

#### UX-P2/P3 — capability, consistency dan polish

- Wire or remove `selectNodes` per-mode policy; decision normal/verbose/debug.
- Unify `minicode.output.v1`/machine envelope across exec and ACP only after protocol-compatible design and consumers are assessed.
- Correct secret-scrubbing order (scrub structured object then serialize) and duplicate text-record behavior; preserve machine schema compatibility.
- Route non-transient stderr diagnostics safely while TUI owns alternate screen; needs a real-PTY test, because fake-TTY captures stdout/stderr separately.
- Align wrapping, slim summary counters, help text, ASCII fallback, dead i18n keys, fallback messages, stale architecture docs, and repaint after external transcript mutation.
- Add presentation-event retention only after its durable/replay semantics are explicit.

### UI/UX decision gates still open

- In-TUI disclosure vs remove `/compact`, `/minimize`, `Ctrl+O` from the TUI surface.
- Word-wrap vs hard-wrap behavior (including CJK, URLs and tables) requires rendered experiments.
- Parent-row grammar for sub-agents and persistence of result/outcome.
- `/expand` as transcript block vs in-place disclosure.
- Normal/verbose/debug policy: wire `selectNodes` or remove claims.
- Machine event shape: preserve `type:"text"` or transition to `model.delta` with backward compatibility plan.
- Cross-stream stderr corruption needs real PTY evidence.
- Full-suite stalls/order dependence and Biome rule/version mismatch need current targeted reproduction before remediation decisions.

---

## 7. Quality remediation track — Stage 1–10

Ini track lintas fase untuk membuat hasil teknis dapat dipercaya. Status di bawah berasal dari laporan checkpoint pengguna; angka hasil historis tidak boleh disajikan sebagai hasil dari `2d9e11e` jika tidak dijalankan pada commit itu.

| Stage | Fokus | Status | Evidence / next action |
|---|---|---|---|
| 1–2 | Windows test reliability, docs/encoding/import ordering, PTY harness honesty, hermetic provider fixtures | `COMPLETE` | Commit `25839d9`, dipush. |
| 3 | Statusline writer reset-safe lifecycle; contention fixes; hermetic tests | `COMPLETE` | Commit `205e355`, dipush. Historis: 4,751 pass / 19 skip / 1 fail. |
| 4A | Diagnose SGR PTY | `COMPLETE — DIAGNOSIS CORRECTED` | Diagnosis awal ConPTY filter salah karena probe belum raw mode. Akar sebenarnya koordinat mouse `y=1` hardcoded di test. |
| 4B + 4B.1 | Dynamic mouse coordinates, SGR capability probe, READY parsing hardening, CI Linux guard, docs | `COMPLETE` | Commit `2d9e11e`, dipush. Test terarah pada final review: capability 20 pass; PTY 6 pass / 3 skip; full suite belum diulang pada commit final. |
| 5A | Diagnosis checkpoint manifest `ENOENT` | `COMPLETE — ROOT CAUSE PROVEN` | Async `turn:completed` listener memulai checkpoint write tanpa pemilik promise; close tidak drain; cleanup menghapus temp cwd pada race `mkdir`→`open`. Lihat detail §8. |
| 5B | Fix lifecycle/promise ownership dan shutdown drain | `COMPLETE — FIX VERIFIED (laporan pemilik)` | `cli/setup.ts` menyimpan semua operasi dalam `pendingCheckpointWork`, menangani rejection sejak awal, menguras pada `close()`, dan melaporkan kegagalan. Tes checkpoint 4/4; `work-mode-hooks` 10/10 bersih; suite terkait lulus. Full suite tidak dijalankan. |
| 6 | TypeScript baseline cleanup | `COMPLETE — FIX VERIFIED (laporan pemilik)` | `bun x tsc --noEmit`: 28 diagnostik → 0. Perubahan hanya pada test; tes terarah 190 pass / 1 skip / 0 fail; strictness/configuration dipertahankan. |
| 7 | Lint/line-ending policy | `COMPLETE — FIX VERIFIED (laporan pemilik)` | Baseline aktual: 572 error lint, termasuk 571 format. Root cause dibuktikan: index LF vs working tree CRLF walau `.gitattributes` dan `.editorconfig` menetapkan LF. `biome.json` kini menetapkan `lineEnding: "lf"`; formatter resmi dan fix lint diterapkan terbatas pada diagnostik yang terukur. `bun run lint` exit 0, `tsc` 0, `git diff --check` 0, tes terkait 1.345 pass / 0 fail menurut laporan. Full suite/coverage/package gate tidak dijalankan. |
| 8 | Package gate | `COMPLETE — FIX VERIFIED (Agent A report; 2026-10-21; not independently re-run here)` | Substage 8.1 dilaporkan menerapkan shared budget `3.584 KiB` (`scripts/pack-budget.ts`), mengubah gate dan tes agar memakai sumber yang sama, serta mendokumentasikan alasan re-baseline. `bun run gate:pack`: exit 0, 23 pass / 0 fail; reported package 3.345 KiB, headroom 239 KiB. TypeScript 0, lint exit 0, `git diff --check` exit 0, focused tests reported 307 pass / 0 fail and changed-test batch 807 pass / 4 skip / 0 fail. Full suite/coverage not run; status is stage-scoped only. |
| 9 | Full suite stability + coverage | `CLOSED / VERIFIED` (laporan track Quality Remediation; kandidat audit P12) | Full suite **4.792 pass / 19 skip / 0 fail / 0 error**; coverage **87,38% funcs / 88,33% lines**. Angka ini hasil laporan track pada kandidat audit P12 (`diff=2c77ab7e…`), **bukan** eksekusi ulang pada working tree saat ini. (Konteks historis: Stage 4B melaporkan 4.760 pass / 19 skip / 0 fail / 1 error; error itu dijelaskan Stage 5A.) |
| 10 | Final validation and quality closeout | `CLOSED / VERIFIED` (14 gate lulus) | TypeScript, lint, suite penuh, coverage, pack, audit harness, build/package smoke tests dan CI relevan dijalankan pada satu kandidat final; **14 gate lulus**; ukuran paket **3.215 KiB** vs batas ketat **3.584 KiB**. Laporan track ini **terpisah** dari bukti closure P12. |

### Stage 8 — baseline sebelum Stage 8.1 (historical snapshot)

Laporan Stage 8 pada working tree `2d9e11e` menunjukkan:

- Baseline `bun run gate:pack`: 21 pass / 2 fail, 334 file, 4.115 KiB unpacked, cap 2.304 KiB.
- Perbaikan import graph: 8 relative import specifiers di `src/task/` kini eksplisit ber-ekstensi `.ts`; kontrak dilindungi regression test. Import graph dan doc links lulus.
- Paket dipangkas dari 334 menjadi 292 file dan dari 4.115 KiB menjadi 3.343 KiB dengan membatasi dokumentasi yang dipaketkan sambil mempertahankan enam required audit artifacts.
- Hasil setelah perubahan: 22 pass / 1 fail; satu-satunya kegagalan adalah size cap 2.304 KiB. `tsc` 0, lint exit 0, `git diff --check` 0, dan tes terkait dilaporkan lulus. Full suite/coverage tidak dijalankan.
- Analisis historis dari laporan: runtime payload sekarang sekitar 2.788 KiB; size guard ditetapkan ketika runtime payload sekitar 1.605 KiB. Angka harus dipahami sebagai bukti laporan implementer, bukan pengukuran ulang oleh assistant.
- **Keputusan owner pada 2026-10-21:** setuju re-baseline cap menjadi 3.584 KiB (3,5 MiB) karena payload runtime yang sah telah tumbuh melebihi cap lama. Dokumen paket atau catatan kontribusi harus menjelaskan cap ini berdasarkan hasil ukur dan pertumbuhan runtime. Jangan mengubah cap lagi tanpa bukti baru.
- Pada checkpoint laporan sebelumnya, Stage 8 masih `PARTIAL`: budget belum diterapkan. Status lama ini dipertahankan sebagai riwayat, bukan status terbaru. Status setelah Stage 8.1 tercatat pada bagian berikut.

### Latest checkpoint — Stage 8.1 package budget re-baseline (Agent A report, 2026-10-21)

**Status laporan: `FIX VERIFIED`.** Seluruh angka di bagian ini berasal dari laporan Agent A; belum ada pembacaan ulang source/diff atau eksekusi command oleh assistant di repository tersebut.

- **Preflight yang dilaporkan:** `D:/Github/minicode`, branch `main`, HEAD awal dan akhir `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`; `main` sinkron dengan `origin/main` (`0 0`); working tree `70 modified + 2 untracked`, 0 staged. Untracked termasuk `scripts/pack-budget.ts` dan `test/checkpoint-lifecycle.test.ts`. Tidak ada commit, amend, atau push.
- **Sumber budget:** `scripts/pack-budget.ts` baru mengekspor `PACK_SIZE_BUDGET_KIB = 3584` dan predicate ketat `<`; `scripts/pack-check.ts` menggunakan helper agar tidak mengulang literal threshold. Test packaging mengunci nilai dan memastikan tepat di batas/di atas budget tetap gagal.
- **Alasan re-baseline yang dilaporkan:** runtime payload tumbuh dari 604 KiB (`e029457`) menjadi 1.605 KiB (`cb633e4`) lalu 2.788 KiB pada kandidat HEAD; paket akhir 3.345 KiB dari 292 file, dibanding batas baru 3.584 KiB, sisa 239 KiB. Pastikan satuan yang ditampilkan gate tetap didokumentasikan konsisten sebagai KiB meskipun output console menggunakan label `KB`.
- **Dokumentasi terkait yang dilaporkan berubah:** `docs/contributing.md` menambahkan rationale dan prosedur re-baseline; `docs/OUTPUT_IMPLEMENTATION_PLAN.md` mengoreksi angka lama 2,25 MiB menjadi 3,5 MiB. File lain pada Stage 8.1: `scripts/pack-check.ts`, `test/pack-integrity.test.ts`, dan `scripts/pack-budget.ts`.
- **Hasil yang dilaporkan:** `bun run gate:pack` exit 0 (23 pass / 0 fail); `bun x tsc --noEmit` 0 diagnostik; `bun run lint` exit 0; `git diff --check` exit 0; batch packaging/import graph/task/contract/web 307 pass / 0 fail; changed-test batch 807 pass / 4 skip / 0 fail. Dua batch dapat tumpang tindih dan bukan hitungan unik yang boleh dijumlahkan.
- **Belum dijalankan:** full suite dan coverage. Jangan menafsirkan status `FIX VERIFIED` Stage 8.1 sebagai quality remediation atau repository keseluruhan selesai. Stage 9 **tetap pending pada saat checkpoint ini** (kini `CLOSED / VERIFIED` — lihat tabel Stage 1–10 di atas).
- **Risiko/validasi sisa:** lakukan full suite stability dan coverage pada tahap yang sesuai; pertahankan margin budget dan jangan menaikkan lagi tanpa bukti baru serta persetujuan pemilik.


### Stage 5A — root cause yang tercatat

Call path yang diinvestigasi:

`turn:completed` (synchronous emit) → event bus memanggil listener async tetapi tidak menunggu promise → listener `cli/setup.ts:1558` menjalankan `recordCheckpointFromSnapshots()` → `withCheckpointLock()` → `saveCheckpointManifest()` → `atomicWriteText()`.

Kondisi kegagalan:
- Promise dari async listener tidak dimiliki/di-drain oleh lifecycle shutdown.
- `ctx.close()` tidak menunggu checkpoint work yang tertunda.
- `afterEach` menghapus temporary cwd saat write berlangsung.
- Penghapusan pada jendela antara `mkdir` dan `open` menyebabkan `ENOENT`; rejection menjadi unhandled.
- Laporan mengukur 300/300 ENOENT saat delete benar-benar bersamaan; sweep timing menunjukkan jendela sekitar 2–5 ms.
- Test terarah sendiri gagal 3/5 pada sesi diagnosis; bukan bergantung pada test PTY atau `test.concurrent`.
- `atomic-write.ts` menelan error `mkdir`; catat sebagai diagnostik terpisah, bukan pengganti perbaikan ownership.

### Stage 5B — implemented and verified (laporan pemilik)

- `cli/setup.ts`: listener `turn:completed` menjadi sinkron dan menyerahkan IIFE async ke `trackCheckpointWork`; semua pending operations dilacak dengan `Set<Promise<unknown>>`.
- Rejection ditangani sejak promise dibuat, dicatat pada `checkpointFailures()`, dan dilaporkan melalui `[warn] checkpoint failed` ke stderr.
- `close()` menghentikan penerimaan operasi baru dengan unsubscribe, lalu mengulang drain sampai set kosong sebelum flush/detach UI yang terkait.
- `pendingCheckpointCount()` digunakan untuk membuktikan tidak ada pekerjaan tertinggal.
- `test/checkpoint-lifecycle.test.ts`: 4 tes (manifest sebelum close kembali, barrier deterministik, kegagalan filesystem terlapor tanpa unhandled rejection, beberapa turn ter-drain). A/B menunjukkan tes gagal jika drain dimatikan.
- `bun test test/work-mode-hooks.test.ts` diulang 10 kali: 10/10 bersih. Suite session/checkpoint/cli-session: 210 pass / 0 fail; suite CLI/TUI/contract: 336 pass / 0 fail. TypeScript tetap berada pada baseline saat itu; full suite tidak dijalankan.
- Residual yang dicatat: drain tidak memiliki timeout; kegagalan checkpoint belum ditampilkan di transcript TUI; `src/lib/atomic-write.ts` masih menelan error `mkdir` dan tetap menjadi temuan terpisah, bukan bagian dari Stage 5B.

### Stage 6 — implemented and verified (laporan pemilik)

- Baseline aktual sebelum perubahan: 28 diagnostik TypeScript, seluruhnya di file test dan terkonfirmasi sama dengan laporan sebelumnya.
- Perbaikan mencakup parameter `fakeBus` yang ditipkan, import/variabel mati yang dibuang, import `Task` dari `model.ts`, koreksi tipe payload dan assertion, serta penghapusan ekspresi selalu truthy—tanpa perubahan production code.
- `bun x tsc --noEmit`: 0 diagnostik. Sepuluh file test yang diubah: 110 pass / 1 skip / 0 fail; batch regresi terkait P0/Stage 5B termasuk dalam hasil gabungan 190 pass / 1 skip / 0 fail.
- Tidak ada perubahan compiler config, pengurangan strictness, `@ts-ignore`, `@ts-nocheck`, atau pelemahan assertion.
- Diagnostik format CRLF dan satu `useTemplate` lama dialihkan ke Stage 7. Full suite tidak dijalankan.

---

## 8. Legacy product roadmap — `LEGACY-0.9/*`

`PLAN.md` tidak dihapus, tidak direnumber secara massal, dan tidak menjadi sumber phase status big roadmap. Status berikut adalah rekonsiliasi dari roadmap legacy; periksa ulang bukti untuk pekerjaan baru sebelum menyebut item selesai.

| Namespace legacy | Makna asli di `PLAN.md` | Status rekonsiliasi |
|---|---|---|
| `LEGACY-0.9/P10` | Path to 9+: TOCTOU, repo-wide `--cwd`, SWE-bench Lite, TUI flakes | Sebagian besar hardening dicatat selesai; validasi SWE-bench comparable masih terbuka. |
| `LEGACY-0.9/P11` | Provider Hardening: correctness/pricing/Responses/retry/OAuth | P0/P1 banyak ditandai selesai; OAuth Copilot/ChatGPT dan routing-policy exploration tercatat ditunda/defer. |
| `LEGACY-0.9/P12` | UI Shell-Max | Dinyatakan selesai pada riwayat 0.9.x. Jangan disamakan dengan Big Phase P12 WorkMode. |
| `LEGACY-0.9/P13` | Raise 3 Dimensi Tertinggal: Model, Tool, Sesi/Memori | Implementasi P0/P1 tercatat selesai; benchmark/validasi serta keputusan produk terkait tetap memiliki residual. |

### Residual legacy yang tetap terlihat

1. **Benchmark SWE-bench Lite yang valid** (`LEGACY-0.9/BENCH-01`). Dataset/harness 20 instance tercatat sudah ada, tetapi run 0/20 sebelumnya terkonfoundasi oleh versi Python/pytest dan tidak comparable dengan leaderboard resmi. Lanjutkan validasi per-instance Docker/image yang dipin, full agent run, dan kasus confidence-low (requests/sympy) sebelum mengutip skor.
2. **OAuth Copilot/ChatGPT** (`LEGACY-0.9/AUTH-01`). Endpoint device-flow yang valid tidak terverifikasi pada bukti historis; jangan mengarang endpoint atau membaca token aplikasi desktop. Perlukan sumber resmi terkini dan login/authorization flow yang sah, atau secara eksplisit pertahankan sebagai deferred.
3. **Branch session UX decision** (`LEGACY-0.9/SESSION-UX-01`). `branchSession` implementasi dilaporkan ada, tetapi audit mencatat belum ada CLI/UX path; putuskan apakah perlu di-wire atau dicatat sebagai non-scope.
4. **Coverage legacy**: `PLAN.md` mempunyai angka dan ambang dari tanggal lama. Jangan gunakan angka tersebut sebagai status coverage sekarang; Stage 9/10 adalah bukti terbaru yang harus dipakai.
5. **TOCTOU**: verifikasi POSIX/WSL dilaporkan lulus 1.000 iterasi tanpa bypass; Windows memiliki batasan `O_NOFOLLOW` dan skip yang didesain. Jangan menggeneralisasikan bukti POSIX sebagai jaminan Windows.

Jangan menggabungkan residual legacy ini dengan P13 Desktop. Mereka merupakan backlog produk lama dan hanya masuk critical path bila pemilik memilih prioritasnya.

---

## 9. Prioritas eksekusi terpadu

Urutan berikut mengutamakan keamanan pengguna, keandalan lifecycle, dan kemampuan mengukur hasil. Setiap item tetap satu slice/commit terpisah bila menyentuh domain berbeda.

### Priority 0 — TUI security hotfix (`UX-001`) — COMPLETE

**Status berdasarkan laporan pemilik: `FIX VERIFIED` (patch belum di-commit).**
- Jalur nyata `src/ui/tui/app.ts` kini menggunakan `formatError(e)` dari formatter kanonis.
- Perbaikan `src/ui/render/errors.ts` menutup fallback non-`Error` dan urutan redact-before-extract yang sebelumnya berpotensi membocorkan credential terpotong.
- Tes formatter dan TUI membuktikan sentinel bearer tidak tampil, raw provider JSON diringkas, dan teks aman tetap informatif. A/B pada kode lama gagal seperti yang diharapkan; fix akhir lulus.
- Tes `errors-usage` 36/0 dan `tui-app` 40/0; batch terkait juga lulus. Full suite tidak dijalankan. Label P0 adalah prioritas hotfix lintas-fase, bukan Big Phase P0.

### Priority 1 — Checkpoint lifecycle race (`Stage 5B` / `UX-002`) — COMPLETE

**Status berdasarkan laporan pemilik: `FIX VERIFIED` (patch belum di-commit).**
- Ownership dan drain barrier telah diterapkan di application layer; semua failure yang diuji ditangani dan diamati tanpa unhandled rejection.
- Tes berulang dan suite terkait lulus sesuai bukti pada §7. Jangan mengulang diagnosis kecuali bukti baru muncul.

### Priority 2 — Make regression evidence trustworthy (TRACK CLOSED — see below)

**Track Quality Remediation Stage 1–10 `CLOSED / VERIFIED` (14 gate lulus; full suite 4.792 pass / 19 skip / 0 fail / 0 error; coverage 87,38% / 88,33%; paket 3.215 KiB vs batas ketat 3.584 KiB). Big Phase P12 `CLOSED / VERIFIED` (pemilik, 2026-10-22). Audit dokumentasi Agent B + Batch M0 dilaporkan selesai; proposal rasionalisasi M1–M12 masih menunggu review pemilik.**
- Stage 6 membersihkan 28 diagnostik TypeScript hingga 0 tanpa menurunkan strictness.
- Stage 7 menyelaraskan LF pada formatter, editor config, atribut Git, serta working tree; `bun run lint` sekarang lulus berdasarkan laporan final. Hindari menyatakan full suite lulus karena belum dijalankan.
- **Stage 8.1 — keputusan owner sudah diterapkan menurut laporan Agent A:** re-baseline budget **3.584 KiB (3,5 MiB)** berbasis runtime growth. Gate resmi dilaporkan `23 pass / 0 fail`; angka guard dipusatkan di `scripts/pack-budget.ts`; tes membuktikan batas tetap fail-closed. Ini tidak menghapus alarm regresi dan tidak menaikkan budget di masa mendatang tanpa bukti baru + persetujuan pemilik. Full suite dan coverage belum dijalankan.
- Jangan jalankan OpenRouter/live provider call untuk package gate kecuali temuan aktual menunjukkan itu benar-benar diperlukan; packaging biasanya tidak membutuhkan live model.
- **Track Quality Remediation ditutup** — Stage 9 (full-suite stability + coverage) dan Stage 10 (final closeout) `CLOSED / VERIFIED` atas basis 14 gate yang lulus pada kandidat audit P12. Tidak ada pekerjaan track yang tersisa di sini.
- **Berikutnya di luar track ini**: review diff `ROADMAP.md` + Batch M0 oleh pemilik (GOV-01), dan review proposal rasionalisasi M1–M12. Keduanya **di luar** Quality Remediation — track ini sudah tertutup.
- Pisahkan perubahan berdasarkan slice dan jangan mencampur perbaikan infrastructure dengan feature changes tanpa alasan.

### Priority 3 — Complete P12 and close safety gaps

- Setelah blocker keamanan/reliability utama dan quality remediation yang relevan selesai, lakukan P12 focused closure audit: permission matrix/replay, no-escalation, injection/subagent/resume, kontrak, dan residual debt.
- `UX-003` terminal restore on abnormal exit tetap merupakan UX follow-up lintas-fase; periksa status aktual sebelum menjadwalkannya.
- Targetkan `CLOSED WITH DOCUMENTED LIMITATIONS` bila bukti cukup; tidak perlu berpura-pura seluruh repo strict-green. Jangan menutup P12 tanpa bukti kontrak permission.

### Priority 4 — UI product quality

- Putuskan detail/disclosure model secara eksplisit.
- Incremental/viewport-bounded paint, persistent sub-agent outcome, renderer parity, machine envelope/scrubbing compatibility, TUI-safe diagnostics, help/wrap/ASCII/i18n/docs polish.
- Hindari rewrite TUI; perbaiki wiring dan unifikasi semantic presentation berdasarkan audit.

### Priority 5 — P13 Desktop implementation — CLOSED / VERIFIED (documented limitations)

- P13.1–P13.6 sudah diimplementasikan dan divalidasi pada satu kandidat working tree; status `CLOSED / VERIFIED — DOCUMENTED LIMITATIONS`.
- Limitasi wajib disebut: ACP consumer baru belum dipasang, koreografi restart daemon penuh belum E2E, retry append event belum ada, telemetry memakai jalur skip baseline.
- **Pekerjaan yang tersisa adalah keputusan pemilik atas commit/push**, bukan implementasi fase baru. Jangan memulai ulang P13 atau mengklaim kompatibilitas eksternal yang belum diuji.

### Priority 6 — P14 cross-session unfinished-work reconciliation — CLOSED / VERIFIED (DOCUMENTED SCOPE LIMITATIONS)

- P14.0–P14.6 full-scope terverifikasi pada satu kandidat; TaskStore tetap authority tunggal dan tidak ada scheduler/queue kedua.
- **Selesai (2026-10-26):** kontrak intent P14.1, ekstraksi histori terstruktur, field portofolio penuh (prioritas/blocker/dependensi/next action), dedup lintas sesi (grup UNPROVEN), ekspor json/md atomik, context pack P14.5, matriks forensik penuh.
- **Closure pemilik 2026-10-26:** P14.0–P14.6 + §10 diterima sebagai `P14 CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS`, terbatas pada kontrak bukti-terstruktur.
- Eksklusi scope yang tetap berlaku (bukan pekerjaan tertunda): TUI readout `/openwork` — `OPTIONAL EXTENSION`; dedup lintas sesi langsung tanpa adopsi — `DEFERRED`; lease merge — `OPTIONAL EXTENSION`; kebijakan intent dari prosa bebas — scope BARU bila pemilik menghendaki (roadmap saat ini melarangnya).
- Jangan menyebut repository release-ready karena P14 closed; limitasi P13 tetap berlaku dan seluruh kerja masih uncommitted.

### Parallel legacy backlog

SWE-bench validation, OAuth provider auth, dan branch-session UX tetap tercatat di `LEGACY-0.9/*`; jadwalkan berdasarkan tujuan produk, bukan dengan menyisipkannya diam-diam ke P13 Desktop atau Stage 5B.

---

## 10. Definition of Done per jalur

### Big phase

- Mission dan ownership jelas.
- Contracts/invariants eksplisit.
- Evidence dari implementasi dan test/fault injection ada.
- Cross-phase regression dibuktikan.
- Tidak membuat second authority atau policy bypass.
- Residual debt dipilah dan diterima secara eksplisit.
- Laporan closure independen dari implementer; status `COMPLETE` vs `CLOSED WITH DOCUMENTED LIMITATIONS` akurat.

### UX follow-up

- Perilaku nyata pada TUI/linear/ACP/machine surface cocok dengan UX contract.
- Secret redaction, output safety, terminal restoration, dan transcript/state ownership diverifikasi.
- Test penting menguji runtime behavior, tidak hanya grep source.
- Performance dipatok dengan benchmark terhadap cap 5.000 baris.
- Product decision tidak ditentukan oleh implementer secara diam-diam.

### Quality closeout

Gate yang wajib menurut `AGENTS.md`:

```bash
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```

Tambahkan `bun run audit:harness`, build/package smoke tests, dan pemeriksaan CI relevan pada kandidat akhir. Laporkan perintah aktual, commit tepat, pass/fail/skip/error, dan tes yang tidak dijalankan. Jangan menurunkan threshold untuk sekadar membuat hasil hijau.

### Long-running supervisor

- Bounded lifecycle, stop/cancel, readiness, health, logs, cleanup.
- Resource/deadline/step budgets ditegakkan oleh runtime, bukan hanya instruksi model.
- Restart/resume mempertahankan canonical state dan evidence; unknown outcomes tidak difabrikasi menjadi sukses.
- Permission/WorkMode tetap berlaku terhadap proses background dan sub-agent.
- No leaked child process, no duplicate owner, no second scheduler/task authority.

### Cross-session unfinished-work reconciliation (P14)

- Sesi relevan yang masih menyisakan pekerjaan dapat ditemukan dengan provenance yang dapat ditelusuri.
- Kategori open/partial/blocked/waiting/delegated/unknown dapat dibedakan dari completed/cancelled/declined.
- Candidate items dideduplikasi tanpa merge salah dan direkonsiliasi dengan TaskStore sebagai authority tunggal.
- Portfolio agregat tidak menjadi sumber task state kedua; action/resume selalu tunduk pada permission/WorkMode, budget, cancellation dan verification.
- Setelah task selesai, portfolio dan referensi sesi tidak lagi menyajikannya sebagai unfinished kecuali ada bukti baru yang sah.

---

## 11. Aturan kerja agent

- Pemilik roadmap memutuskan arah, prioritas, scope, dan DoD.
- Implementer hanya mengerjakan satu slice yang eksplisit; tidak diminta membuat/menafsir ulang roadmap global.
- Sebelum coding: preflight checkpoint, baca contract terkait, reproduce baseline, dan nyatakan invariant yang dijaga.
- Sesudah coding: targeted regression, audit diff, evidence report, review independen, baru commit/push dengan gate terpisah.
- QA-agent bersifat read-only pada immutable checkpoint/worktree; jangan mencampur hasil dari hash berbeda.
- Tidak boleh mengklaim test/gate pass yang tidak dijalankan. Status historical tetap diberi label historical.
- Setiap prompt implementasi menyebut: expected HEAD/branch, files in/out of scope, preflight-stop, acceptance criteria, test commands, no-go operations, dan stop condition.

---

## 12. Evidence index

### Big-phase architecture
- `P2_FINAL_CLOSURE_FORENSIC_AUDIT.md`
- `P2_CLOSURE_HANDOFF.md`
- `P3_ROADMAP.md`
- `P3_0_CONTEXT_SESSION_CONTRACT.md`
- `P9_PHASE_CLOSURE_REPORT.md`
- `P10_PHASE_CLOSURE_REPORT.md`
- `P11_PHASE_CLOSURE_REPORT.md`
- `P11_PRESENTATION_SCOPE_AND_EVIDENCE.md`
- `P11_FINAL_GATE_EXECUTION_REPORT.md`
- `P12_ENTRY_GATE_AND_SCOPE_AUDIT.md`
- `P12_1_ARCHITECTURE_DECISION_PACKAGE_REV2.md`
- `P12_1_REV2_OWNER_DECISION_REPORT.md`
- `P12_PHASE_CLOSURE_REPORT.md` (closure P12 `CLOSED / VERIFIED`, pemilik 2026-10-22; residual yang diterima di §5–§6)
- `P13_3_STAGE_C_REPORT.md` (P13.3 continuity evidence)
- `P13_5_REPORT.md` (P13.5 end-to-end runtime evidence; stage-scoped)
- `P13_6_REPORT.md` (P13.6 forensic + closure evidence; 20-row crash/restart matrix; limitations §7)
- `P14_REPORT.md` (P14 `CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS`; matriks milestone + acceptance §1/§1.1; bukti tes §3; gate §4; limitasi §5; eksklusi scope §6)
- `docs/P14_OPEN_WORK.md` (operator workflow: find → adopt → continue → close)

### Legacy product roadmap
- `PLAN.md` (legacy source; not authoritative for Big Phase status)
- `CHANGELOG.md`
- `P3_FORENSIC_AUDIT_REPORT.md` (historical findings; compare with current code)

### UI/UX follow-up
- `docs/TERMINAL_CONTRACT.md`
- `docs/UI_RENDER_PIPELINE.md`
- `docs/OUTPUT_ARCHITECTURE_AUDIT.md`
- `docs/OUTPUT_EVENT_MODEL.md`
- `docs/OUTPUT_PROTOCOL_SPEC.md`
- `docs/OUTPUT_RENDERING_SPEC.md`
- `docs/OUTPUT_UX_RULES.md`
- Audit report from Mission 00 (21 Oct 2026; read-only transcript/attachment)

### Current quality remediation
- Stage 3 checkpoint: `205e3558696b5f5d7027a283c1c5495699d3c63b`
- Stage 4B/4B.1 checkpoint: `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`
- Stage 5A report: latest user-provided diagnostic report in conversation; no code changes.

### Final candidate 2026-10-25 (konsolidasi P13/P14)

**Satu kandidat, tree tidak berubah sebelum/sesudah run.** `HEAD=2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`; status **177 baris** (132 modified + 45 untracked); sidik jari tracked diff `5f484e4b65072227b04d7d316afec22a5ae00c3b`; sidik jari untracked `3337eec4f7cf8c3dfa8211e97a440ae4cb1875a9985dc42f0b7a1558a8e383a9`; stash kosong; vendor `c8d214bb8d5eea86` (20 berkas).

| Gate | Exit | Hasil |
|---|---|---|
| `bun x tsc --noEmit` | **0** | 0 diagnostik |
| `bun run lint` | **0** | 625 berkas; 0 error; 3 info pre-existing |
| `bun test` | **0** | **5073 pass · 19 skip · 0 fail**; 5092 tes / 344 berkas; 387.412 expect; 1191,61 dtk |
| `bun run gate:coverage` | **0** (rerun) | funcs **88,17%** · lines **89,07%** · lantai **19/19**; run pertama gagal 1 flake timing `p2-daemon` (lihat `P14_REPORT.md` §5.1), uji terisolasi 3/3 pass, rerun penuh hijau |
| `bun run gate:pack` | **0** | 23 pass · 0 fail; 286 berkas; **3431 KB** vs budget 3584 KiB |
| `bun run gate:bash` | **0** | bypass **0/62** · over-block **0/24** |
| `bun run bench:smoke` | **0** | resolve rate **13/13**; fail distribution (none) |
| `bun run audit:harness` | **0** | 60 pass · 0 fail · 2 advisory |
| `bun run gate:telemetry` | **0** | skip resmi (`no traces.jsonl`) |
| `bun run vendor:check` | **0** | 20 berkas; `c8d214bb8d5eea86` sinkron |
| `git diff --check` | **0** | bersih |

**Batas bukti:** angka ini hanya untuk kandidat tersebut; bukan klaim repository committed/strict-green. Satu flake coverage adalah residual risk timing yang didokumentasikan, bukan penurunan ambang. Setelah tabel ini ditulis hanya dokumen yang berubah; `git diff --check` + `bun run gate:pack` diulang pada kandidat dokumen final.

### Final candidate 2026-10-26 (P14 full-scope, closure pass)

**Satu kandidat beku, tree tidak berubah selama gate.** `HEAD=2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`; branch `main`; status **180 baris** (133 modified + 47 untracked, 0 staged); diff stat 133 berkas, 5134 insertions / 932 deletions; stash kosong; vendor `c8d214bb8d5eea86` (20 berkas).

Urutan kerja: **dokumentasi closure dibekukan lebih dulu**, lalu sebelas gate dijalankan pada tree itu, lalu sidik jari diambil sebelum dan sesudah — keduanya identik. Karena `P14_REPORT.md`/`ROADMAP.md`/`docs/P14_OPEN_WORK.md` sendiri ikut terhitung di hash untracked, sidik jari untracked lengkap dicatat di handoff (bukan di tabel ini) agar dokumen tidak menyunting dirinya sendiri; hash tracked diff (`b53ef0c5…`) stabil karena tidak ada berkas tracked yang berubah.

| Gate | Exit | Hasil |
|---|---|---|
| `bun x tsc --noEmit` | **0** | 0 diagnostik |
| `bun run lint` | **0** | 627 berkas; 0 error; 3 info pre-existing (`test/session-id-portability.test.ts`) |
| `bun test` | **0** | **5115 pass · 19 skip · 0 fail**; 5134 tes / 345 berkas |
| `bun run gate:coverage` | **0** | funcs **88,21%** (min 87) · lines **89,12%** (min 86) · lantai per-berkas **19/19** hijau; run tunggal, nol kegagalan |
| `bun run gate:pack` | **0** | 23 pass · 0 fail; 287 berkas; **3505 KB** vs budget 3584 KiB |
| `bun run gate:bash` | **0** | bypass **0/62** · over-block **0/24** (mode auto + allowlist) |
| `bun run bench:smoke` | **0** | resolve rate **13/13**; fail distribution (none); delta 0,0% |
| `bun run audit:harness` | **0** | 60 pass · 0 fail · 2 advisory |
| `bun run gate:telemetry` | **0** | skip resmi (`no traces.jsonl`) |
| `bun run vendor:check` | **0** | 20 berkas; `c8d214bb8d5eea86` sinkron |
| `git diff --check` | **0** | bersih |

**Batas bukti:** angka hanya untuk kandidat 2026-10-26 di atas dan **bukan** klaim repository committed/strict-green maupun release-ready. Angka yang berayun antar-run (jumlah `expect()`, durasi) sengaja tidak dimasukkan ke dokumen; nilai run terakhir ada di handoff.

---

## 13. Immediate action at the time of this roadmap

> **Catatan integrasi repo (2026-10-21, diperbarui 2026-10-26 — anotasi integrasi, bukan teks pemilik):** urutan *current* ada di §9 `Prioritas eksekusi terpadu` dan checkpoint §2 2026-10-26. Daftar di bawah adalah snapshot saat roadmap ini disusun. Item 1–4 sudah `COMPLETE`; item 5–6 sudah diimplementasikan dan ditutup (P13 `CLOSED / VERIFIED — DOCUMENTED LIMITATIONS`, P14 `CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS`, pemilik 2026-10-26). Jangan memakai daftar ini sebagai next action aktual.

1. **First:** prepare a tightly scoped implementation task for `UX-001` (TUI error formatter/redaction) because a bearer-token leak is a security priority and was not touched by the Stage 4B test/docs commit.
2. **Next:** implement Stage 5B ownership/drain fix for the proven checkpoint race, as a separate change and commit.
3. Reproduce and resolve test fixture order leakage if still present; then progress through Stage 6–9.
4. Perform P12 focused closure review and document current status without rewriting historical closure documents.
5. ~~Begin P13.0 entry audit only after the safety/reliability preconditions are met.~~ **Selesai:** P13.1–P13.6 implemented; status `CLOSED / VERIFIED — DOCUMENTED LIMITATIONS`; bukti di `P13_6_REPORT.md`.
6. ~~After P13, begin P14.0 read-only inventory to discover and reconcile unfinished work across relevant sessions; do not treat P14 as part of the current implementation queue.~~ **Selesai dan ditutup pemilik 2026-10-26:** P14.0–P14.6 + §10 diterima sebagai `P14 CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS` untuk kontrak bukti-terstruktur (`P14_REPORT.md` §1/§1.1/§3/§4/§6); item di luar scope milestone (TUI `/openwork`, lease-merge, merge lintas sesi tanpa adopsi, intent dari prosa) tetap eksklusi dan hanya bisa dibuka sebagai scope baru.

This roadmap is the combined decision map. It does not itself authorize implementation beyond the next explicitly approved slice.
