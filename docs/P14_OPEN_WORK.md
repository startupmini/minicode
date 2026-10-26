# P14 — Alur Operator Open-Work Lintas Sesi

Panduan operasi untuk pekerjaan belum selesai lintas sesi (P14). Semua yang
dijelaskan di sini memakai mekanisme otoritas yang SUDAH ADA — TaskStore tetap
satu-satunya otoritas status; tidak ada TaskStore/queue/scheduler kedua.

> **Status: `P14 CLOSED / VERIFIED — DOCUMENTED SCOPE LIMITATIONS` (pemilik,
> 2026-10-26).** Panduan ini mendokumentasikan scope bukti-terstruktur yang
> disetujui. **Eksklusi yang tetap berlaku:** ekstraksi intent dari prosa
> bebas, readout TUI `/openwork`, merge dengan lease/admission, dan merge
> lintas sesi tanpa adopsi eksplisit. Closure P14 bukan klaim release-ready.

## Gambaran alur

```
minicode openwork                        ① TEMUKAN  (read-only, lintas sesi)
minicode openwork inventory              ①b AUDIT   (inventaris P14.0 lintas sumber)
minicode openwork context --session S --task tN
                                         ①c SUSUN KONTEKS (P14.5, tanpa eksekusi)
minicode --session <target> \
  --adopt-task <source>/<taskId> "..."   ② ADOPSI   (eksplisit, otoritas ganda)
/scheduler run                           ③ LANJUTKAN (manual, lewat gate continuity)
(minimum satu turn)                      ④ KERJAKAN (claim = generasi BARU)
minicode openwork --closed               ⑤ TUTUP    (feedback berprovenance)
minicode openwork export --out FILE      ⑤b EKSPOR  (json/md, atomik)
minicode openwork merge ...             ⑥ DEDUP    (eksplisit + evidence)
```

## ① Menemukan: `minicode openwork`

Portofolio read-only seluruh task non-terminal di **workspace ini** (tasks.db
memang per-workspace — sesi proyek lain memang tidak terlihat, itu batas yang
benar, bukan bug), **ditambah** kandidat intent terstruktur dari histori
(lihat "Kandidat intent" di bawah).

```
Open Work — 1 item(s) · 1 intent · 1 stale · 0 unknown-provenance
workspace: D:\proyek · stale after 7d · TaskStore remains the sole status authority

p14ow-source/t1 · IN_PROGRESS · PARTIAL · P2 · 2d old
  title: Fix login bug
  flags: STALE · FROM:p14ow-source · SIMILAR×2(UNPROVEN)
  blockers: TASK_BLOCKED: API key rotated
  depends on: t2 (PENDING, unsatisfied)
  next: resume: rebuild context from provenance, then continue via TaskStore/Scheduler
```

Arti bidang:

| Bidang | Makna |
|---|---|
| `status` | status kanonik TaskStore — **satu-satunya otoritas** |
| state (kolom ke-4) | state P14.1 berbasis bukti: `OPEN/PARTIAL/BLOCKED/WAITING_FOR_USER/DELEGATED/FAILED_NEEDS_FOLLOWUP/UNKNOWN`; verifikasi gagal → FAILED_NEEDS_FOLLOWUP, dependensi tak tuntas → BLOCKED |
| `P0..P3` | prioritas presentasi: BLOCKED/FAILED=P0, WAITING/DELEGATED/UNKNOWN=P1, PARTIAL=P2, OPEN=P3; item STALE dinaikkan satu tingkat — umur sinyal, bukan bukti |
| `blockers:` | blocker eksplisit (TASK_BLOCKED / DEPENDENCY / VERIFICATION); kosong = tidak ada yang diklaim |
| `depends on:` | dependensi kanonik direkonsiliasi ke status saat baca; hanya COMPLETED yang *satisfied* |
| `next:` | tindak lanjut eksplisit — selalu lewat jalur otoritas yang ada; openwork TIDAK PERNAH mengeksekusi |

Arti penanda:

| Penanda | Makna | Tindak lanjut |
|---|---|---|
| `STALE` | baris tak bergerak ≥ ambang (default 7 hari, `--stale-days <n>`) | prioritas, bukan keputusan otoritas |
| `PROVENANCE-UNKNOWN` | tidak ada baris sesi di sessions.db — asal tak bisa ditelusuri | periksa manual; jangan dianggap rusak |
| `FROM:<sesi>` | task ini DIPINDAHKAN dari sesi lain (ledger `task_transfers`) | provenance asal eksplisit |
| `SIMILAR×N(UNPROVEN)` | N task berbagi judul ternormalisasi | **bukan bukti duplikat** — lihat ⑥ |
| `DUP-GROUP×N(UNPROVEN)` | grup duplikat **lintas sesi** (task + intent) beranggota N | lihat seksi "Grup duplikat lintas sesi" |

Filter: `--session <id>`, `--status <S>`, `--state <S>`, `--priority <P0..P3>`,
`--min-age-days <n>`, `--blocked`, `--depends-on <taskId>`, `--closed`,
`--json` (satu objek JSON mesin di stdout). Exit: `0` sukses (termasuk daftar
kosong), `1` gagal runtime/lookup, `2` salah pakai (nilai enum tak dikenal
termasuk).

**Batas kejujuran:** `openwork` tidak pernah menulis apa pun — tidak
mengakuisisi lease, tidak membuat sessions.db, tidak menulis backup manifest
korup, tidak memicu scheduler. Ia indeks, bukan otoritas. (Dijaga guard
arsitektur + tes nol-mutasi, kini termasuk jalur inventaris.)

## Kandidat intent: histori terstruktur, TANPA menebak prosa

Portofolio juga menampilkan **kandidat intent open** dari histori yang
terstruktur dan durable:

| Sumber | Kapan jadi kandidat | State |
|---|---|---|
| `plan.updated` | langkah plan `pending`/`active`/`blocked` **tanpa** task kanonik (atau baris task-nya hilang) | OPEN / PARTIAL / BLOCKED |
| `approval.requested` | belum ada `approval.settled` | WAITING_FOR_USER |
| sesi anak sub-agent | belum ada hasil terminal | DELEGATED |
| sesi anak + `turn.failed` | delegasi gagal | FAILED_NEEDS_FOLLOWUP |
| run `INTERRUPTED` | eksekusi terputus (restart/kill) | FAILED_NEEDS_FOLLOWUP |

Yang SENGAJA tidak dilakukan: memindai isi pesan bebas pengguna. Janji dari
prosa ("nanti kita perbaiki login") TIDAK PERNAH menjadi tugas — roadmap P14
melarang menganggap brainstorming sebagai task, dan menentukan kapan intent
prosa jadi komitmen adalah keputusan produk yang belum diputuskan pemilik.

Aturan kejujuran ekstraksi (dijaga tes):

1. Langkah plan yang menunjuk task kanonik yang masih OPEN **menempel sebagai
   bukti** di entri task (`plan evidence`), bukan item duplikat.
2. Langkah plan yang mengaku `active` atas task yang SUDAH terminal tidak
   dihidupkan kembali — masuk closure dengan alasan "canonical task
   <status> supersedes plan claim", konflik diungkap, bukan disembunyikan.
3. Approval yang di-**allow** bukan bukti pekerjaan selesai — tidak
   menghasilkan kandidat apa pun (hanya deny yang menghasilkan DECLINED).
4. Run `RUNNING` bukan open loop — runtime hidup adalah kondisi normal.
5. Cakupan pencarian dibatasi binding `cwd` baris sesi; **sesi anak mewarisi
   cakupan leluhur termulaiannya** (hasil sub-agent tetap terlihat); sesi
   tanpa binding dilabel UNBOUND dan dikeluarkan — tidak ada yang ditebak.
6. `plan.updated` adalah **snapshot**, bukan delta: adaptor menerbitkannya setiap
   `todo_write` sukses dengan SELURUH daftar langkah. Hanya snapshot TERAKHIR
   per **sesi** yang dibaca (bukan per `planId` — `planId` memuat nomor turn,
   sedangkan daftar todo milik sesi). Akibatnya: versi pending/active lama tidak
   muncul sebagai open loop kedua, langkah yang dihapus dari daftar tidak
   dihidupkan, dan langkah yang masih terbuka tidak berganda di setiap turn.

## Grup duplikat lintas sesi (P14.3 penuh)

Kandidat dengan judul ternormalisasi sama **lintas sesi** (termasuk task vs
langkah plan) dikelompokkan dan diungkapkan:

```
Similar groups — 1 (UNPROVEN, never auto-merged)
  "fix login bug" ×2 across 2 session(s) · DIVERGENT states
  sessions: p14fs-a · p14fs-b
```

Grup dengan state yang saling bertentangan ditandai `DIVERGENT` (jumlahnya
juga di header + `counts.conflicts`). Grup **tidak pernah** menyatukkan apa
pun: perpindahan otoritas tetap wajib adopsi eksplisit (②), merge tetap
satu-sesi (⑥). Tugas berulang yang sengaja independen boleh berbagi grup —
itu penanda untuk diperiksa, bukan vonis.

## ①b Inventaris: `minicode openwork inventory [--json]`

Inventaris P14.0 lintas sumber, read-only: jumlah sesi (in-scope / foreign /
unbound / anak), task (total/open/terminal), event presentasi per tipe, run,
manifest checkpoint (termasuk yang **corrupt** — dilabel, tidak dibackup oleh
proyeksi), langkah plan, approval, dan hasil sub-agent. Sesi yang dikeluarkan
dicantumkan **dengan alasannya**. Event yang gagal didekode dilaporkan sebagai
"unreadable", tidak disembunyikan.

## ①c Konteks: `minicode openwork context --session <id> --task <taskId>`

Context pack P14.5 untuk satu task: field kanonik (status/revisi/verification/
dependsOn/evidence), state + prioritas + blocker + next action, bukti langkah
plan, ketersediaan checkpoint (termasuk corrupt), provenance transfer/merge,
freshness, dan **checklist resume**. Pack ini murni baca — checklist menunjuk
jalur yang MEMAKSAK otoritas saat resume (ceiling P12, gate continuity P13.3,
claim generation TaskStore, budget/cancellation P12/P13); openwork sendiri
tidak memeriksa apalagi mengeksekusi. Exit `1` bila task tak ditemukan,
`2` bila id cacat.

## ② Mengadopsi: `--adopt-task <source>/<taskId>`

Satu task per invokasi, HANYA saat startup sesi tujuan, sebelum turn pertama:

```
minicode --session target --adopt-task p14ow-source/t1 "lanjutkan pekerjaan ini"
```

Yang terjadi (satu transaksi TaskStore, dicek ulang di dalam transaksi):
inkarnasi sumber+tujuan, revisi, **kedua lease** (token sumber dan tujuan),
status non-terminal, konsistensi lineage, tabrakan id target, dan provenance
relasi. Penulis sesi sumber yang **hidup** = `REFUSED_SOURCE_BUSY` (tidak ada
takeover paksa). Lease sumber kedaluwarsa = takeover + **fence epoch** —
proses lama tidak bisa lagi renew/release/menulis/menjadwalkan sesi sumber.

Yang TIDAK terjadi: tidak menyalin task, tidak membuat generasi baru, tidak
menandai selesai, tidak menyentuh jurnal runtime/child run/approval, dan
**tidak memicu scheduler**. Task in-flight hasil adopsi tetap `IN_PROGRESS`
dengan lineage asli — apakah boleh dilanjutkan adalah keputusan gate (③),
bukan adopsi.

Rantai relasi diadopsi **berurutan** (parent/dependency dulu, lalu anak);
penolakan menamai id yang belum diadopsi. Id task tidak pernah direnumber.

## ③ Melanjutkan: `/scheduler run` (manual, tersupervisi)

Adopsi tidak menyalakan scheduler. Lanjutan tetap lewat trigger manual yang
sudah ada (`/scheduler run` di sesi TUJUAN; butuh `--enable-scheduler` atau
`--runtime owned` saat memulai sesi). Reconcilasi menilai task in-flight hasil
adopsi lewat **continuity gate P13.3** — kontraknya tidak berubah:

- `SAFE_TO_RETRY` (bukti resume + admission + **seluruh** scope tool otonom
  read-only) → revert ke PENDING → **claim generasi BARU** → dispatch serial.
- Selain itu → `HOLD` / `REQUIRES_VERIFIER`, baris tidak disentuh, nol
  dispatch. Tanpa gate = HOLD (fail-closed).

**Tidak pernah ada replay instruksi tool jurnal lama** — work item hanya
membawa `(taskId, title, instruction, sessionId)`; eksekusi baru lahir dari
claim baru. Permission ceiling P12, budget, cancellation, dan stop criteria
P13 tetap berlaku persis seperti sesi biasa.

## ④ Menutup: lifecycle biasa

Selesaian lewat jalur kanonik yang sudah ada (verifier / `todo_write` /
operator) — P14 tidak punya jalur penutupan sendiri dan tidak pernah
menulis `COMPLETED` atas nama operator.

## ⑤ Feedback penutupan: `minicode openwork --closed`

Closure feedback adalah **pembacaan ulang status kanonik + ledger**, bukan
kesimpulan: task yang sudah terminal dan punya provenance P14 (transfer
atau merge) muncul dengan `status`, `closed`, `FROM <sesi>`,
`duplicate-of <task>`, dan evidence operator. Duplikat yang dibuka kembali
operator otomatis muncul lagi di seksi open — status saat itulah kebenaran.

Sejak pengiriman full-scope, closure juga mencakup **artefak intent terminal**
(`kind INTENT`) dengan **label klaim** yang wajib dibaca:

| `claim` | Arti |
|---|---|
| `verified` | task kanonik terminal dengan `verification.verdict = passed` |
| `unverified` | klaim penyelesaian oleh artefak (mis. plan step `completed`) **tanpa** verifikasi — ditampilkan apa adanya, BUKAN disembunyikan, BUKAN dianggap terbukti |
| `not-applicable` | DECLINED/CANCELLED — tidak ada klaim penyelesaian untuk diverifikasi |

Termasuk: approval yang ditolak pengguna → `DECLINED` (terminal, tidak pernah
hidup lagi sebagai open loop), dan langkah plan yang mengaku `active` atas task
terminal → closure dengan alasan "canonical task `<status>` supersedes plan
claim" — konflik klaim diungkap, tidak ditelan.

## ⑤b Ekspor: `minicode openwork export --out <path> [--format json|md] [--force]`

- `json` (default) — objek portofolio lengkap (selalu menyertakan inventaris
  P14.0), indentasi 2 spasi.
- `md` — laporan manusia tersanitasi (judul/evidence bebas sekuens ANSI).
- Ditulis **atomik** (`atomicWriteText`); **menolak menimpa** berkas yang ada
  kecuali `--force`; kegagalan tulis = exit `1` tanpa berkas sampah `.tmp.*`.

## ⑥ Dedup eksplisit: `openwork merge`

```
minicode openwork merge --session target --keep t1 --drop t2 \
  --evidence "satu unit kerja yang sama: sama-sama memperbaiki login bug"
```

Aturan (dijaga tes + guard):

1. **Evidence WAJIB** dan direkam utuh di ledger append-only `task_merges`.
   Kemiripan judul TIDAK PERNAH menjadi bukti; `SIMILAR×N(UNPROVEN)` hanyalah
   penanda. Tidak ada merge otomatis dari proyeksi.
2. Duplikat ditutup **`CANCELLED`, bukan `COMPLETED`** — menyatakan "dikerjakan
   di task lain" tidak boleh meng-inferr penyelesaian.
3. Penulisan status lewat `patchTask` (lifecycle biasa: revisi maju, ownership
   in-flight dilepas) + INSERT ledger dalam **SATU transaksi** — gagal ledger =
   status ikut rollback.
4. Duplikat terminal ditolak (pekerjaan tertutup tidak dibuka untuk ditutup
   lagi). Survivor terminal BOLEH (kasus klasik: pending ternyata sudah
   dikerjakan task yang selesai — duplikat tetap CANCELLED).
5. **Antar-sesi ditolak**: merge hanya satu namespace. Duplikat lintas sesi
   harus diadopsi dulu (②), lalu merge di sesi tujuan.
6. Pembalikan = penulisan lifecycle biasa (patch status kembali). Ledger
   append-only tetap mencatat deklarasi — audit sejarah, status = kebenaran.

## Peta bukti

| Klaim | Bukti |
|---|---|
| Proyeksi read-only (nol mutasi) | `test/p14-open-work.test.ts` (proyeksi nol-mutasi) |
| Nol mutasi jalur PENUH (histori + inventaris ikut diuji; tanpa backup manifest korup) | `test/p14-full-scope.test.ts` (zero-mutasi proyeksi penuh) |
| UNKNOWN/stale dilabel jujur | `test/p14-open-work.test.ts` (provenance UNKNOWN tanpa membuat sessions.db; STALE ambang disuntik) |
| Kemiripan bukan identitas | idem (SIMILAR UNPROVEN, ambiguous tetap terpisah) |
| Grup duplikat LINTAS SESI + konflik divergent, tanpa merge otomatis | `test/p14-full-scope.test.ts` (P14.3 grup lintas sesi) |
| Kontrak P14.1: state/prioritas/next action murni + fail-closed | idem (P14.1 kontrak murni) |
| Ekstraksi intent: approval allow ≠ COMPLETED; pesan bebas tak dipindai; cakupan lineage | idem (P14.2 extractIntentCandidates) |
| Klaim plan atas task terminal: tak dihidupkan, konflik diungkap, label claim verified/unverified | idem (P14.2 proyeksi histori) |
| Inventaris P14.0 lintas sumber + sesi dikeluarkan dengan alasan | idem (P14.0 inventaris) |
| Matriks forensik: restart/terputus/pembatalan/stale | idem (P14.6 matriks forensik) |
| Portofolio: blocker/dependensi/verifikasi/next action | idem (P14.4 bidang portofolio) |
| CLI: filter baru, inventory, context, export atomik + sanitasi | idem (CLI full-scope; exit 0/1/2 sesuai I28) |
| Merge aman/auditable/atomic | `test/p14-open-work.test.ts` (DECLARED/refusal/terminal/stale/atomic-rollback/pembalikan) |
| Alur ①→⑤ utuh, generasi baru, tanpa replay | idem (P14.5 alur operator) |
| Adopsi: otoritas ganda, fence, ledger transfer | `test/p14-cross-session-adoption.test.ts` (14 skenario) |
| Guard "bukan TaskStore/scheduler kedua" + proyeksi murni | `test/p2-architecture-guards.test.ts` |
| Kontrak penulis CLI (OAP-008) | `test/writer-inventory.test.ts` (deklarasi per writer) |
| Snapshot `plan.updated` dikolaps per sesi (tanpa duplikasi riwayat) | `test/p14-full-scope.test.ts` (5 tes snapshot plan) |

## Batas scope yang TIDAK diklaim

Dokumen ini sengaja tidak menjanjikan hal-hal berikut; semuanya eksklusi
scope P14 yang disetujui pemilik 2026-10-26, bukan pekerjaan tertunda:

| Tidak ada | Alasan |
|---|---|
| Ekstraksi intent dari prosa bebas | Dilarang eksplisit oleh roadmap ("jangan anggap setiap pesan brainstorming sebagai tugas") |
| Readout TUI `/openwork` | Teks milestone hanya "tampilkan/ekspor"; permukaan TUI baru butuh kontrak terminal sendiri |
| Merge dengan lease/admission | Di luar teks milestone; merge tetap satu transaksi + ledger audit |
| Merge lintas sesi tanpa adopsi eksplisit | Model otoritas roadmap: portfolio = projection, perubahan task lewat jalur authority |
| Klaim release-ready | Closure P14 hanya untuk kontrak bukti-terstruktur; limitasi P13 tetap berlaku dan tree masih uncommitted |
