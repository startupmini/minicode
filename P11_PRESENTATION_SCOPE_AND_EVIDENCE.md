# P11 — Presentation & UX: Scope & Evidence

**Status dokumen: artefak scope + bukti, BUKAN laporan penutupan.**
Full-system QA (Agent C) pada checkpoint `04c1e1e` sudah dilaksanakan dengan
verdict `ACCEPT WITH NON-BLOCKING FINDINGS`, dan laporannya tersimpan di
`P11_FULL_SYSTEM_QA_REPORT.md`. Gate final pada `609a417` sudah dijalankan:
**`gate:pack` FAIL dan `gate:coverage` FAIL** (bukti:
`P11_FINAL_GATE_EXECUTION_REPORT.md`). Penutupan P11 disiapkan sebagai
`COMPLETE WITH DOCUMENTED LIMITATIONS` dan **menunggu review pemilik**
(`P11_PHASE_CLOSURE_REPORT.md`, `P11_OWNER_DECISION_MEMO.md`). Dokumen ini disusun SETELAH implementasi
P11.1–P11.3 mendarat, berdasarkan bukti yang tersedia di repo — tidak ada
artefak scope P11 yang ditulis sebelumnya.

**Baseline implementasi:** `04c1e1e` (P11.3). Dokumen ini tidak mengubah
perilaku produksi apa pun.

---

## A. Tujuan yang dapat ditelusuri

**Disambiguasi penomoran (penting).** `PLAN.md` §"P11 — Provider Hardening:
correctness, harga, Responses, retry" merujuk program lama berlabel P11 yang
TIDAK berhubungan. **P11 dalam dokumen ini adalah fase Presentation & UX pada
roadmap besar MiniCode yang sedang berjalan** — melanjutkan fase presentation
sesudah P10 (Verification & Self-Healing) ditutup di `518b072`.

Scope presentation yang digarap pada fase ini, seluruhnya diturunkan dari
kontrak yang dapat ditelusuri (kode + komentar kontrak + tes), bukan dari
kebutuhan karangan:

1. **Observability hasil verifikasi pada mesin summary** — hasil verifikasi
   operator-terotorisasi harus terlihat oleh konsumen CI tanpa mengubah makna
   top-level `ok` maupun exit code. Sumber kontrak yang SUDAH ADA sebelum
   dokumentasi ini: komentar kontrak implementasi P11.1 di `cli/commands/exec.ts`
   ("ok top-level dan exit code SENGAJA tak berubah") + kontrak accessor
   `getLastVerifyResult` di `cli/setup.ts` + tes P11.1
   (`test/cli-session.test.ts`, describe `cli: exec --json verify summary`),
   serta aturan versioning yang sudah ada lebih dulu di
   `docs/OUTPUT_PROTOCOL_SPEC.md` §11 ("Field baru bersifat optional selama
   satu versi major"). Enumerasi field `verify` di `docs/exec.md` dan
   `docs/OUTPUT_PROTOCOL_SPEC.md` §7 baru ditulis pada pekerjaan dokumentasi
   ini — MENDOKUMENTASIKAN keputusan yang sudah diterima, bukan bukti
   historis independen bagi keputusan implementasinya.
2. **Integritas prompt exec** — prompt yang sampai ke model dan yang dilaporkan
   summary mesin harus teks user, bukan metadata routing. Cacat konkret yang
   diperbaiki (dapat ditelusuri lewat tes P11.2 di
   `test/exec-json-envelope.test.ts` dan `test/cli-session.test.ts`): dengan
   flag global mendahului subcommand (`minicode --json exec "tugas"`), guard
   lama `args[0] === "exec"` tidak membuang token routing sehingga prompt
   menjadi `"exec tugas"` (bahkan nilai flag ikut bocor) — kebalikan dari
   bentuk `exec`-pertama yang sudah benar.
3. **Konsistensi routing dispatch** — bentuk invokasi bersokong flag global
   harus mencapai aksi yang benar, bukan salah baca token routing. Cacat
   konkret P11.3 (terbuktikan saat penerimaan dan kini dijaga tes di
   `test/cli-subcommands.test.ts`, describe `cli: daemon scoped argv (P11.3)`):
   `minicode --json daemon status` menghasilkan `unknown daemon subcommand:
   daemon` + exit 2 palsu, padahal bentuk `daemon --json status` mencapai
   aksi `status`.

Catatan provenance ID: kode temuan singkat (N-1, F2, F3, F5) yang dipakai di
§C–§D berasal dari laporan audit/misi penerimaan P11 yang TIDAK di-commit ke
repo. ID itu bukan rujukan yang dapat ditelusuri dari repository; isi yang
dimaksud selalu diringkas lengkap di selnya masing-masing dan dapat diverifikasi
langsung lewat kode/komentar kontrak/tes yang disebut di sel tersebut.

Batas tegas: presentasi bukan otoritas eksekusi/verifikasi/completion
(`P2_CLOSURE_HANDOFF.md`: presentation_events observation-only; UNKNOWN ≠
success; daemon ≠ canonical truth). Tidak ada slice P11 yang menambah penulis
TaskStore, otoritas verifikasi, atau penerbit session.

## B. Referensi historis

Sumber yang benar-benar ada di repo saat audit ini (semua terverifikasi ada di
`04c1e1e`):

| Sumber | Peran |
|---|---|
| `P3_0_CONTEXT_SESSION_CONTRACT.md` | Prinsip pengikat: *derived state may observe authority, must not silently become authority* — dipakai sebagai batas semua slice presentasi |
| `P2_CLOSURE_HANDOFF.md` | Invarian beku presentasi/jurnal/daemon (observation-only, daemon ≠ canonical truth) |
| `P10_PHASE_CLOSURE_REPORT.md` | Kontrak verifikasi yang tidak boleh ditafsir ulang presentasi (P10 `COMPLETE WITH DOCUMENTED LIMITATIONS`) |
| Commit `8cbda02` `feat(p11): expose verification outcome in exec summary` | Implementasi P11.1 |
| Commit `9e1e550` `fix(p11): use scoped argv for exec prompt` | Implementasi P11.2 |
| Commit `04c1e1e` `fix(p11): use scoped argv for daemon dispatch` | Implementasi P11.3 |

Transparansi: tidak ditemukan design doc/scope doc P11 (Presentation) sebelum
dokumen ini. Audit P11 pasca-P10 dan slice berikutnya dijalankan sebagai misi
berkontrak dengan laporan inline (bukan file artefak terpisah). Dokumen ini
menyusuli celah artefak itu, bukan mengklaim pernah ada.

## C. Matriks bukti per slice

### P11.1 — Machine-Summary Verification Outcome (`8cbda02`)

- **Tujuan:** hasil verifikasi final (pasca self-heal) terlihat di summary
  mesin `exec --json` tanpa otoritas baru.
- **Produksi:** accessor read-only `getLastVerifyResult()` di `cli/setup.ts`
  (salinan `{ ok, command }`, null bila verify belum jalan); field aditif
  `verify: { active: true, ok, command }` di success path
  `cli/commands/exec.ts`. `ok` top-level dan exit code SENGAJA tidak berubah.
- **Tes pelindung:** `test/cli-session.test.ts` describe `cli: exec --json
  verify summary` (A hijau / B merah-exit-tetap-0 / C absen-total / D
  final-menang pasca self-heal).
- **Batasan diketahui:** failure-path summary (budget habis, writer basi,
  catch/error) tidak menyertakan `verify` — lihat N-1 di §D baris 4. Render TUI
  khusus untuk hasil verify tidak ada (stderr `[verify]` tetap jalur manusia).

### P11.2 — Correct Exec Prompt Extraction (`9e1e550`)

- **Tujuan:** token routing `exec` tidak bocor ke prompt model maupun summary
  ketika flag global mendahului subcommand.
- **Produksi:** router mencatat `cmdTokenPos` saat membangun `subArgv` dan
  meneruskan `cmdArgv` scoped (flag global dikenal + token sesudah subcommand,
  TANPA token `exec`) ke `handleExec`; guard lokal `args[0] === "exec"`
  dihapus dari handler.
- **Tes pelindung:** `test/exec-json-envelope.test.ts` describe `exec: prompt
  scoping (P11.2)` (A/B exec-first vs flag-first identik; D kata `exec` milik
  user utuh); `test/cli-session.test.ts` describe `cli: exec prompt scoping
  (P11.2)` (prompt yang benar-benar diterima provider tiruan + summary + field
  `verify` P11.1 tetap benar). Kedua set diverifikasi sebagai detektor
  regresi: merah pada kode pra-fix (bukti mutasi via stash saat penerimaan).
- **Batasan diketahui:** flag tak dikenal sebelum subcommand kini di-drop dari
  argv handler (konsisten perlakuan `subArgv` P10 P0.1; sebelumnya bocor ke
  prompt sebagai teks).

### P11.3 — Scoped argv for Daemon Dispatch (`04c1e1e`)

- **Tujuan:** `minicode --json daemon status` mencapai aksi `status`, bukan
  `unknown daemon subcommand: daemon` (exit 2 palsu).
- **Produksi:** cabang daemon di `cli/router.ts` meneruskan `cmdArgv` scoped
  (pola P11.2); guard lokal `args[0] === "daemon"` dihapus dari
  `cli/commands/daemon.ts`. Aksi/opsi/skema JSON/exit code daemon tidak berubah.
- **Tes pelindung:** `test/cli-subcommands.test.ts` describe `cli: daemon
  scoped argv (P11.3)` (A flag global sebelum subcommand — boolean dan
  value-flag; B/C bentuk daemon-first & biasa; D aksi asing tetap exit 2; E
  `issue`/`stop`/`help` lewat kontrak argv sama). Juga terbukti detektor:
  4/4 merah pada kode pra-fix saat penerimaan.
- **Batasan diketahui:** `daemon start --prompt` (blocking) tidak tercakup tes
  routing; quirk pra-ada double-encode JSON pada refusal `stop`/`sessions`
  (`fail()` men-stringify ulang string yang sudah JSON) TIDAK diubah di slice
  ini — temuan terpisah, lihat §D baris 4.

Catatan matriks: klaim tes di atas adalah hasil run berfokus pada saat
penerimaan masing-masing slice (dilaporkan di misi penerimaannya), bukan klaim
full-suite.

## D. Kriteria kesiapan penutupan

| # | Kriteria | Status | Bukti / alasan |
|---|---|---|---|
| 1 | Kontrak + tes di tingkat slice (P11.1, P11.2, P11.3) | **PASS** | Setiap slice punya kontrak tertulis di kode + tes regresi subprocess berdetektor-mutasi (lihat §C); suite berfokus hijau saat penerimaan; `bun x tsc --noEmit` pada checkpoint melaporkan 28 error — seluruhnya berada pada kelompok file tes Phase 3/4 dan tidak ada yang berasal dari file yang diubah P11.1–P11.3 dalam pemeriksaan tersebut (dokumen historis mencatat kondisi berbeda untuk kelompok error ini, jadi penyebab historisnya tidak disimpulkan dari angka ini) |
| 2 | Dokumentasi + CHANGELOG | **PASS** (lewat artefak ini) | Field `verify` terdokumentasi di `docs/exec.md` dan `docs/OUTPUT_PROTOCOL_SPEC.md` §7; entri `[Unreleased]` di `CHANGELOG.md` menutup P11.1–P11.3 |
| 3 | Full-system QA | **COMPLETED** (verdict `ACCEPT WITH NON-BLOCKING FINDINGS`) | QA sistem penuh Agent C pada checkpoint `04c1e1e` **sudah dilaksanakan dan laporannya tersedia** di `P11_FULL_SYSTEM_QA_REPORT.md`: baseline `9e1e550` 4645 tes (4609 pass / 13 fail / 23 skip) vs target `04c1e1e` 4649 tes (4612 pass / 14 fail / 23 skip); **tidak ada regresi yang terkonfirmasi** (PF-05 flake sensitif-beban, 11 kegagalan kontaminasi antar-tes, 2 kegagalan deterministik baseline). Status `PASS` di sini berarti **QA terlaksana + laporan tersedia**, BUKAN berarti full suite hijau — runner target berakhir dengan kegagalan (14 fail), dan gate `coverage`/`pack`/`bash`/`bench:smoke`/`audit:harness` tidak dijalankan Agent C dalam audit ini |
| 4 | Keputusan pemilik | **DECIDED (2026-10-18)** — pengecualian strict-green diterima; rincian di `P11_OWNER_DECISION_MEMO.md` | **(N-1)** memperluas field `verify` ke failure-path summary (budget/stale-writer/catch) = perubahan permukaan envelope error → **diputuskan Opsi A** (diterima sebagai keterbatasan terdokumentasi; klarifikasi `609a417`), tidak diperluas. **(F3)** anchor kode `src/presentation/projection.ts:682` memproyeksikan `diagnostic.raised` sebagai status `active` tanpa cabang severity; remap severity-error → status non-`active` = machine-visible → butuh pertimbangan kompat. Kode TIDAK diubah dan perilakunya tidak diklaim sudah diperbaiki. **Temuan daemon:** double-encode JSON pada `stop`/`sessions` refusal — **diperbaiki di D-1** (`dbcf836`) sebagai slice terpisah, dengan tes regresi. **Temuan lain non-blocking:** F2 fallback `??"completed"` di `src/ui/tui/transcript.ts` (latent, tanpa jalur produksi terbukti), F5 U+2028/2029 lolos `sanitizeAnsiLine` (low) |
| 5 | Penutupan administratif fase | **PREPARED — menunggu review pemilik** | Paket closure disusun (`P11_PHASE_CLOSURE_REPORT.md`); integrasi ke `main` dan push belum dilakukan |
| 6 | Gate final pada `609a417` | **`gate:pack` FAIL · `gate:coverage` FAIL · tiga gate lain NOT RUN** | Pack: 21 pass/2 fail, 4121 KB vs 2304 KB (keduanya baseline). Coverage: 13 test gagal, funcs 87,05%/lines 88,06%, 19/19 lantai kritis hijau — merah karena test, bukan ambang. `gate:bash`/`bench:smoke`/`audit:harness`, full typecheck, dan full lint tidak dijalankan. Bukti: `P11_FINAL_GATE_EXECUTION_REPORT.md` |

Status di atas sengaja memakai bukti apa adanya: tidak ada temuan speculative
yang dinaikkan menjadi "bug terbukti", dan tidak ada QA yang belum jalan yang
dilaporkan lulus. Baris #3 sengaja **tidak** memakai `PASS` agar tidak terbaca
sebagai "sistem lulus/sehat" — labelnya `COMPLETED` dalam makna sempit "QA
sudah dilaksanakan + laporan tersedia", dengan verdict
`ACCEPT WITH NON-BLOCKING FINDINGS` dan bukan klaim full suite hijau: full suite
target `04c1e1e` berakhir dengan 14 kegagalan terklasifikasi (lihat
`P11_FULL_SYSTEM_QA_REPORT.md`). Kosakata status dokumen ini: `PASS` = kriteria
terpenuhi di tingkat slice/dokumentasi, `COMPLETED` = aktivitas QA terlaksana
dengan verdict non-blocking, `PENDING` = menunggu keputusan pemilik,
`NOT APPLICABLE (belum)` = belum berlaku. Tiga tingkat bukti tetap
dibedakan: (i) pengujian berfokus per slice hijau saat penerimaan, (ii)
full-system QA selesai tanpa regresi terkonfirmasi, (iii) full suite masih
memiliki kegagalan.

## E. Status fase

**Paket penutupan P11 sudah disiapkan dan menunggu review pemilik; P11 belum
terintegrasi ke `main` dan push belum dilakukan.**

- Slice P11.1, P11.2, P11.3: diterima secara individual dengan validasi
  berfokus (lihat §C). D-1 (`dbcf836`) dan N-1 (`609a417`) selesai.
- (a) Full-system QA `04c1e1e` — **TERPENUHI**
  (`P11_FULL_SYSTEM_QA_REPORT.md`, verdict `ACCEPT WITH NON-BLOCKING FINDINGS`;
  full suite tetap 14 kegagalan terklasifikasi).
- (b) Keputusan pemilik — **TERCATAT**: pengecualian strict-green diterima,
  status target `COMPLETE WITH DOCUMENTED LIMITATIONS`
  (`P11_OWNER_DECISION_MEMO.md`).
- (c) Gate final `609a417` — **DILAKSANAKAN**: `gate:pack` FAIL,
  `gate:coverage` FAIL; tiga gate lain NOT RUN
  (`P11_FINAL_GATE_EXECUTION_REPORT.md`).
- (d) Laporan penutupan tersendiri — **TERSEDIA**:
  `P11_PHASE_CLOSURE_REPORT.md`.
- Persetujuan akhir, integrasi ke `main`, dan push tetap menunggu review pemilik;
  dokumen ini tidak memberi persetujuan tersebut.
