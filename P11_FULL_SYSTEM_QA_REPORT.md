# P11 — Full-System QA Report

**Status dokumen: laporan full-system QA. BUKAN deklarasi penutupan administratif P11.**
Verdict asli Agent C dipertahankan apa adanya: **`ACCEPT WITH NON-BLOCKING FINDINGS`**.
Dokumen ini merekam QA pada `04c1e1e`; bukti gate final pada `609a417` dicatat
di addendum §I dan **tidak** mengubah angka historis di §B–§F. Status penutupan
P11 (pengecualian terdokumentasi) ada di `P11_PHASE_CLOSURE_REPORT.md` dan
`P11_OWNER_DECISION_MEMO.md`.

**Provenance.** Dokumen ini disusun oleh Agent D dengan menyalin angka dan
klasifikasi dari **laporan final + addendum full-system QA Agent C** yang
diserahkan pemilik. Tidak ada pengujian baru yang dijalankan untuk menyusun
dokumen ini, tidak ada hasil yang disimpulkan ulang, dan tidak ada angka yang
dikarang. Full suite **tidak** dijalankan ulang oleh Agent D.

**Batas verifikasi.** Laporan final + addendum Agent C itu sendiri **tidak
terdapat sebagai file di repository ini** dan **tidak tersedia untuk diperiksa
langsung** oleh penyusun dokumen. Yang dapat diverifikasi di repo hanyalah
identitas commit, keberadaan file/tes yang disebut, dan konsistensi aritmetika.
Karena itu setiap angka di §B–§F berstatus **transkripsi yang diatribusikan ke
Agent C**, bukan hasil pengukuran Agent D; bila ada perbedaan antara dokumen ini
dan laporan Agent C, laporan Agent C yang berlaku.

## A. Identitas checkpoint

| Item | Nilai |
|---|---|
| Target | `04c1e1e093af4d2e3c46ab2d063c1e38424b3b1d` |
| Subject target | `fix(p11): use scoped argv for daemon dispatch` |
| Parent target | `9e1e55086de1a86bb954e918d2cac8e53b65f755` |
| Baseline pembanding | `9e1e55086de1a86bb954e918d2cac8e53b65f755` |
| P11.1 | `8cbda02` |
| Runtime | bun 1.4.2 |
| Node.js | v22.23.2 |
| Sistem | Windows 10.0.26300 |
| Metode checkout | worktree terpisah untuk target dan baseline (tidak saling mengganggu) |

Path worktree sengaja tidak dicantumkan: identitas checkpoint di atas sudah
cukup untuk mereproduksi audit, dan path itu tidak diperlukan pembaca.

## B. Hasil full test suite

Angka baseline dan target dicatat **terpisah** — keduanya berasal dari eksekusi
yang berbeda, bukan dari satu run.

| Metrik    | Baseline `9e1e550` | Target `04c1e1e` | Delta |
| --------- | -----------------: | ---------------: | ----: |
| Total tes |               4645 |             4649 |    +4 |
| Pass      |               4609 |             4612 |    +3 |
| Fail      |                 13 |               14 |    +1 |
| Skip      |                 23 |               23 |     0 |

Kolom Total konsisten dengan komponennya: 4609 + 13 + 23 = 4645 (baseline) dan
4612 + 14 + 23 = 4649 (target).

Durasi: baseline **1175,0 detik**, target **1170,6 detik**.

**Koreksi laporan awal Agent C.** Laporan awal menyebut kenaikan pass **+4**.
Delta bersih yang benar adalah **+3**: empat tes baru P11.3 lulus seluruhnya
(+4 pass), tetapi satu tes **LAMA** yang sebelumnya lulus — **PF-05** — timeout
pada full suite target (+1 fail), sehingga pass bersih hanya +3 (+4 − 1). PF-05
**bukan** salah satu dari empat tes baru itu. Angka pada tabel di atas adalah
angka yang sudah dikoreksi.

## C. Rekonsiliasi empat tes baru dan PF-05

- Empat tes baru pada describe `cli: daemon scoped argv (P11.3)`
  (`test/cli-subcommands.test.ts`) **seluruhnya lulus** pada full suite target.
- Empat tes itu adalah **tambahan cakupan P11.3**, bukan empat tes yang
  sebelumnya gagal. Kenaikan Total +4 berasal dari sini, bukan dari perbaikan
  kegagalan lama.
- **PF-05** adalah **satu tes lama** yang gagal pada full suite target karena
  **timeout 5001 ms** — tes self-heal dan identitas plan event setelah resume.
- PF-05 lulus pada pengujian **terisolasi target sebanyak dua kali**, dan juga
  lulus pada full suite **baseline**.
- Berdasarkan bukti yang tersedia, PF-05 diklasifikasikan sebagai **flake
  sensitif-beban** (bukan regresi produk, bukan kegagalan deterministik).
- **Full suite target TIDAK boleh disebut hijau**: runner berakhir dengan
  kegagalan (14 fail).
- Verdict asli Agent C dipertahankan: **`ACCEPT WITH NON-BLOCKING FINDINGS`**.
  Kesimpulan yang tepat adalah **tidak ada regresi yang terkonfirmasi**, bukan
  "seluruh sistem bebas kegagalan".

## D. Klasifikasi kegagalan target (14 kegagalan)

| Kelompok | Jumlah | Isi |
|---|---:|---|
| Kegagalan deterministik baseline | 2 | Karakter U+FFFD pada dokumen (`test/import-convention.test.ts`, tes "tidak ada U+FFFD (replacement char) di berkas terlacak"); nested list pada `docs/TASK_EVENT_MODEL.md` (`test/web-build.test.ts`, tes "docs tanpa nested list") |
| Kontaminasi antar-tes (cross-test contamination) | 11 | `TypeError: bound is not a function`, pada pengujian session dan TUI **ketika dijalankan dalam full suite**; pengujian terkait lulus secara terisolasi pada kedua checkpoint |
| Flake sensitif-beban | 1 | PF-05 (self-heal + identitas plan event setelah resume), timeout 5001 ms |

**Atribusi kolom Isi.** Deskripsi ketiga kelompok kegagalan berasal dari laporan
Agent C. Pemetaan ke nama file/tes konkret pada baris pertama tabel adalah
**penelusuran Agent D di repo ini** — tes yang benar-benar menjaga properti itu:
`test/import-convention.test.ts` (U+FFFD) dan `test/web-build.test.ts`
(dokumentasi tanpa nested list). Itu bukan pengukuran baru dan bukan klaim bahwa
Agent C menamai tesnya persis seperti itu.

Dua kegagalan deterministik itu **sudah ada di baseline** — bukan akibat P11.3.
Sebelas kegagalan kontaminasi hilang saat tes dijalankan terisolasi, sehingga
tidak dapat diatribusikan ke perubahan `04c1e1e`. Ketiga kelompok juga bukan
kegagalan yang diperbaiki oleh P11.1–P11.3.

Catatan tambahan: **23 tes dilewati** (skip) karena keterbatasan lingkungan,
termasuk kebutuhan Docker/privilege.

Kegagalan di atas **tidak diperbaiki** dalam pekerjaan dokumentasi ini dan tidak
diperbaiki pada P11.3.

## E. Catatan EPIPE lintas-run

Laporan baseline **Agent B** menyebut satu `EPIPE` tambahan. Pada eksekusi
baseline milik **Agent C**, pola EPIPE **tidak ditemukan**, baik pada log
baseline maupun target.

Dicatat sebagai **ketidaksesuaian lintas-run yang belum terjelaskan**, tanpa
dampak terhadap verdict. Kedua eksekusi itu **tidak boleh disatukan** seolah-olah
berasal dari run yang sama: keduanya runtime, lingkungan, dan cakupan
pengujiannya berbeda.

## F. Static checks dan gate

| Pemeriksaan | Hasil menurut Agent C | Catatan atribusi |
|---|---|---|
| `bun x tsc --noEmit` | **28 error** pada target **dan** baseline; file-set identik dalam kelompok tes Phase 3/4; **tidak ada error yang teridentifikasi pada file P11** | Hasil Agent C untuk audit ini |
| `bun run lint` | **603 temuan** pada target **dan** baseline; hasil identik | Hasil Agent C untuk audit ini |
| Gate `coverage` | **tidak dijalankan** dalam audit ini | Bukan klaim lulus |
| Gate `pack` | **tidak dijalankan** dalam audit ini | Bukan klaim lulus |
| Gate `bash` | **tidak dijalankan** dalam audit ini | Bukan klaim lulus |
| Gate `bench:smoke` | **tidak dijalankan** dalam audit ini | Bukan klaim lulus |
| Gate `audit:harness` | **tidak dijalankan** dalam audit ini | Bukan klaim lulus |

Gate yang tidak dijalankan **tidak boleh dinyatakan lulus**, dan laporan ini
tidak menyatakannya demikian.

**Bukti dari audit Agent B (bukan hasil pengujian target Agent C):** Agent B
pernah melaporkan **dua kegagalan `gate:pack` pada baseline**. Informasi itu
disertakan di sini semata sebagai catatan provenance audit Agent B; ia bukan
hasil pengujian yang dijalankan Agent C pada target `04c1e1e`, dan status gate
`pack` untuk target tetap **tidak dijalankan** dalam audit ini.

## G. Temuan di luar scope P11.3

**Double-encoding JSON daemon.** Dikonfirmasi pada jalur kegagalan `fail()`:
konsumen JSON memperoleh **string yang membungkus JSON**, bukan objek JSON
langsung. Jalur sukses memakai encoding tunggal dan sudah diuji. Temuan ini
tetap **terpisah dan tidak diperbaiki** pada P11.3; routing argv tidak
bergantung padanya.

**`daemon start --prompt`.** **Belum diverifikasi secara dinamis** —
dikecualikan karena perilaku blocking dan kebutuhan cleanup. Tidak dinyatakan
sebagai bug yang sudah terbukti.

**Probe exec dan jaringan.** Salah satu probe mewarisi kredensial provider dari
environment, mencoba mengakses jaringan, lalu menerima respons **401**. Tidak
ada efek samping yang dilaporkan. Probe itu **tidak sepenuhnya hermetik**, dan
harness audit ini tidak boleh disebut hermetik hanya karena bagian lain memakai
provider tiruan. Dicatat sebagai **temuan hygiene pengujian**, bukan bug produk.
Rekomendasi untuk pengujian berikutnya: hapus kredensial provider dari
environment turunan dan paksa penggunaan fake provider/offline.

## H. Kesimpulan

- **P11.1, P11.2, P11.3 diterima** pada tingkat kontrak slice.
- **Full-system QA selesai** dengan verdict **`ACCEPT WITH NON-BLOCKING FINDINGS`**.
- **Tidak ada regresi yang terkonfirmasi** pada target `04c1e1e`.
- Beberapa **kegagalan baseline**, keterbatasan pengujian, dan temuan
  non-blocking **tetap ada** (2 kegagalan deterministik baseline, 11 kegagalan
  kontaminasi antar-tes saat full suite, 1 flake sensitif-beban, 23 skip, error
  `tsc`/`lint` warisan, gate yang tidak dijalankan, plus temuan di §G).
- **Laporan ini bukan deklarasi penutupan administratif P11.** Penutupan masih
  menuntut keputusan pemilik atas temuan tertunda dan laporan penutupan
  tersendiri.

## I. Addendum — bukti gate final pada `609a417` (2026-10-18)

Addendum ini **tidak mengubah** angka §B–§F. Gate resmi dijalankan setelah
checkpoint bergerak ke `609a417` (memuat D-1 `dbcf836` dan N-1 `609a417`):

| Gate | Hasil | Angka |
|---|---|---|
| `bun run gate:pack` | **FAIL (exit 1)** | 21 pass · 2 fail; 333 berkas; 4121 KB vs ambang 2304 KB |
| `bun run gate:coverage` | **FAIL (exit 1)** | 13 test gagal; funcs 87,05% (min 85); lines 88,06% (min 86); 19/19 lantai kritis hijau |

Dua kegagalan `gate:pack` diklasifikasikan baseline: `src/task/graph.ts` tidak
berubah sejak `04c1e1e`, dan ukuran baseline `04c1e1e` terukur 333 berkas /
4118 KB (sudah di atas ambang). `gate:coverage` merah karena status test, bukan
karena ambang liputan; 13 kegagalan = 2 konten dokumen lama + 11 keluarga
flaky/jendela polusi yang sudah dikenal. Total/pass/skip suite final **tidak
dilaporkan gate** dan tidak direkonstruksi. QA sebelumnya mencatat 14 kegagalan;
selisih 14 vs 13 **belum direkonsiliasi penuh**.

`gate:bash`, `bench:smoke`, `audit:harness`, full typecheck, dan full lint
**tidak dijalankan** pada eksekusi gate final. Rincian dan batas bukti:
`P11_FINAL_GATE_EXECUTION_REPORT.md`. Status penutupan P11 beserta pengecualian
strict-green dicatat di `P11_PHASE_CLOSURE_REPORT.md` dan
`P11_OWNER_DECISION_MEMO.md`.

**Perkembangan 2026-10-18:** pemilik menyetujui status penutupan P11
`COMPLETE WITH DOCUMENTED LIMITATIONS`. Catatan ini **tidak** mengubah angka
§B–§I: `gate:pack` dan `gate:coverage` tetap FAIL, dan pemeriksaan yang tidak
dijalankan tetap NOT RUN.
