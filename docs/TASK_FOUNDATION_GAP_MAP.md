# Task Foundation Gap Map (pasca REPAIR)

Peta kesenjangan setelah repair atas temuan `e4a7b7c`. Rujukan:
`TASK_FOUNDATION_REPAIR_REPORT.md` (apa yang diperbaiki dan buktinya),
`TASK_FOUNDATION_TEST_MATRIX.md` (mutasi), `TASK_ARCHITECTURE_AUDIT.md` (gap
fitur dari audit awal).

Cakupan repair: hanya D.1-D.2. Task Graph / Scheduler / `/tasks` UI /
milestone / task model / `task_id` / dependency **tidak** diimplementasikan.

---

## A. FOUNDATION STATUS

**VERIFIED untuk keenam gap target.** Tidak ada lagi PF-01, PF-02, PF-03,
PF-04, PF-05, PF-07 yang FAILED atau UNTESTED.

Klasifikasi per item:

| Item | Klasifikasi |
|---|---|
| PF-01 `completed` tidak bertahan saat verify merah | **VERIFIED** (E2E + 3 probe proses nyata + mutasi) |
| PF-02 durable = observed | **VERIFIED** (unit + mutasi + probe R4) |
| PF-03 `blockedReason` durable lintas proses | **VERIFIED** (unit + mutasi + probe R5) |
| PF-04 `blocked` terkurung semantik | **VERIFIED** (2 pagar + mutasi) |
| PF-05 identitas presentasi kanonik | **VERIFIED** (E2E + mutasi + probe R6) |
| PF-07 wiring produksi bertes | **VERIFIED** (E2E + mutasi; sebelumnya VACUOUS) |
| Rekonsiliasi pasca-verify | **IMPLEMENTED** dan **VERIFIED** oleh PF-01 |
| `applyCompletionPolicy` tunggal (tulis + rekonsiliasi) | **IMPLEMENTED** |
| PF-06 artefak `.md` gagal diam-diam | **UNTESTED** (tidak diperbaiki, di luar scope) |
| PF-08 `lastVerify` tak diinvalidasi | **UNTESTED** (tidak diperbaiki) |
| PF-09 `completionEvidence` global | **UNTESTED** (tidak diperbaiki) |
| PF-10 `planId` per turn | **UNTESTED** (tidak diperbaiki) |
| PF-11 jendela kill tulis-flush | **UNTESTED** (tidak diperbaiki) |
| ENOSPC asli | **UNCONFIRMED** (hanya ENOTDIR/EACCES diuji) |
| Konkurensi multi-proses pada satu DB | **UNCONFIRMED** |

Tidak ada skor numerik. Penilaian berbasis bukti langsung.

### Batas yang tersisa pada keenam gap target

Enam gap target tertutup, tapi tiga batasan nyata harus dicatat:

1. **Durable event log menyimpan klaim `completed` yang pernah terbit** sebelum
   rekonsiliasi (probe R2: `[{completed}, {open, blocked}]`). Itu sejarah yang
   benar - klaim itu memang terjadi - dan proyeksi akhir benar karena
   `planId` sama sehingga reducer memakai last-write-wins. Yang dijamin adalah
   **state akhir**, bukan bahwa log tidak pernah memuat klaim.
2. **`failed` belum ada.** `blocked` berarti "ada yang menahan dengan bukti".
   Status `failed` (percobaan dijalankan dan tidak berhasil) sengaja tidak
   ditambahkan karena itu lifecycle state - bagian dari Canonical Task Model
   yang ditunda.
3. **Tidak ada status retry.** Tidak ada mekanisme retry pada task, sehingga
   tidak ada yang perlu dibedakan dari `blocked`.

---

## B. BEFORE -> AFTER

| Dimension | `e4a7b7c` (sebelum repair) | Sesudah repair | Evidence |
|---|---|---|---|
| Completion saat verify merah | `completed` bertahan bila baseline hijau | **Selalu non-completed** | MUT-1, probe R1/R2/R3 |
| Rekonsiliasi pasca-verify | Tidak ada | Ada, idempoten, hanya bila berubah | `reconcileCompletionEvidence` |
| Durable vs observed | Durable ≠ observed (baca menerapkan kebijakan) | **Sama** - baca pasif | MUT-3, probe R4 |
| `blockedReason` | Ditulis, dibuang saat baca | **Bertahan** write-baca-renderPlan | MUT-4, probe R5 |
| `blocked` tanpa alasan | Bisa dibuat model | **Mustahil** (dua pagar) | MUT-5 |
| Identitas plan event | Ganda (`payload` ≠ `row`) | **Kanonik** | MUT-6, probe R6 |
| Wiring produksi bertes | VACUOUS (48 test hijau saat dimutasi) | **Terdeteksi** (E2E merah) | MUT-2 |
| Dependency / graph | Tidak ada | Tidak ada | di luar scope |
| User control | Tidak ada | Tidak ada | di luar scope |
| Undo reconciliation | File saja | File saja | di luar scope |
| Context projection | Tidak ada | Tidak ada | di luar scope |

---

## C. Sisa utang arsitektur

### C.1 Utang yang TIDAK tersentuh di pass ini (sesuai scope)

| ID | Utang | Severity | Catatan |
|---|---|---|---|
| PF-06 | `savePlanSnapshot` gagal ditelan `.catch` diam-diam; artefak `.md` bisa usang | P2 | Perlu keputusan: hapus artefak, atau jadikan tercatat |
| PF-08 | `lastVerify` tak pernah diinvalidasi saat repo berubah | P3 | False positive saja (aman, tapi membosankan) |
| PF-09 | `completionEvidence` module-global, parallel dengan `todoSession` | P3 | Laten untuk embedder |
| PF-10 | `planId` per turn; plan tidak berevolusi, dan `stepId` masih indeks posisi | P3 | Butuh identitas task stabil |
| PF-11 | Jendela kill antara tulis file dan flush event | P3 | Arah divergensi benar (event subset file) |
| TASK-005 | `evidenceComplete` dihitung, nol konsumen | P1 | Butuh renderer |
| TASK-006 | `/undo` hanya revert file; todo tetap `completed` | P1 | Butuh keputusan semantik |
| TASK-007 | `.minicode/plans/*.md` write-only; tak ada proyeksi ke context model | P1 | Interaksi dengan compaction |
| TASK-008 | Nol dependency / graph / scheduler | P1 | Butuh Task Model lebih dulu |
| TASK-010 | Tidak ada TTL/GC untuk file todo di luar SQLite | P2 | Perbaikan kecil |
| TASK-011 | Tidak ada `/tasks`; task state 100% milik model | P1 | Butuh renderer |
| TASK-012 | Truncate 50 item diam-diam; full-replace buta | P2 | Butuh keputusan merge semantics |

### C.2 Utang BARU yang muncul dari repair ini

| ID | Utang | Severity | Catatan |
|---|---|---|---|
| R-01 | Durable event log masih memuat klaim `completed` sebelum rekonsiliasi | P3 | Sejarah yang benar; state akhir sudah benar. Butuh `supersedes` atau model event untuk jadi bersih - terkait PF-10. |
| R-02 | `reconcileCompletionEvidence` menulis file + plan snapshot tanpa transaksi | P3 | Sama seperti `todo_write`: kalau gagal di tengah, JSON dan `.md` bisa berbeda. Arahnya file = kebenaran. |
| R-03 | Rekonsiliasi tidak menerbitkan event bila tidak ada perubahan | P3 | Sengaja (idempoten), tapi berarti replay log bisa terlihat "melompat" dari completed ke blocked tanpa event penghubung. |

Tidak ada utang baru yang P0 atau P1.

---

## D. Prasyarat eksak untuk memulai CANONICAL TASK MODEL

Enam gap target sudah tertutup. Prasyarat yang tersisa**bukan** perbaikan -
ini keputusan desain.

### D.1 Sudah terpenuhi (tidak perlu diulang)

- PF-01, PF-02, PF-03, PF-04, PF-05, PF-07: closed dan verified.
- Gerbang completion punya implementasi tunggal (`applyCompletionPolicy`).
- Durable dan observed tidak lagi berbeda.
- Ada jalur rekonsiliasi yang eksplisit dan eksplisit-meny-write.

### D.2 Keputusan desain yang blocking (D.3 dari gap map sebelumnya)

| # | Keputusan | Kenapa blocking |
|---|---|---|
| 1 | **`task_id` stabil** | Graph, retry, dan supersedes (INV-002, INV-011, INV-007) semuanya butuh id yang bertahan lintas edit daftar. `stepId` sekarang indeks posisi. Tanpa ini, graph akan menebak. |
| 2 | **Provenance** | Siapa/mengapa mengubah task. Tanpa ini, dekomposisi adaptif tidak bisa diaudit (INV-007). |
| 3 | **FDD vs BLOCKED** | `blocked` sekarang = "ada yang menahan dengan bukti". `failed` = "percobaan berjalan dan gagal". Keduanya perlu dibedakan sebelum retryable failure punya arti. |
| 4 | **Merge semantics** | `todo_write` masih full-replace buta. Task beridentitas stabil butuh aturan eksplisit saat model mengirim subset. |
| 5 | **`planId` dan `stepId`** | Keduanya diturunkan dari turn/indeks, bukan identitas. Selaraskan dengan keputusan #1 (PF-10). |

### D.3 Boleh ditunda (tidak memblokir)

PF-06, PF-08, PF-09, PF-10, PF-11, TASK-005, TASK-006, TASK-007, TASK-010,
TASK-011, TASK-012. Semuanya butuh renderer, keputusan UI, atau model data
yang belum ada - tidakkasusbanding dengan grafs.

---

## E. Go / No-Go

### GO untuk CANONICAL TASK MODEL - dengan syarat

Alasan GO (berbeda dari pass sebelumnya):

1. Enam gap fondasi tertutup dan **terbukti** - termasuk gap P0 yang dulu
   bocor. Fondasi sekarang tidak bisa menghasilkan `completed` palsu.
2. Durable = observed, sehingga graph dan scheduler membaca state yang sama
   dengan yang dilihat manusia.
3. Ada jalur rekonsiliasi yang eksplisit, jadi Task Model baru bisa
  -that-closing-state tanpa harus membangun mekanisme sendiri.
4. Enam mutasi testing membuktikan test benar-benar menangkap fix - jadi
   regresi di masa depan akan terlihat.

### Syarat yang harus dipenuhi sebelum menulis kode graph

Syarat 1-2 di D.2 harus diputuskan lebih dulu (keputusan desain, bukan
implementasi):

- **task_id stabil**: harus ada strategi. Pilihan paling murah yang cukup:
  id yang diturunkan dari konten task (hash singkat) plus suffiks untuk
  duplikat, sehingga id bertahan saat daftar disisipkan di tengah. Butuh
  keputusan: apakah id dipegang model atau diturunkan sistem?
- **Provenance**: minimal `source` (USER / AGENT / SYSTEM / DISCOVERED) dan
  `reason` untuk task yang dibuat/diubah saat runtime.

Kalau dua ini belum diputuskan, Task Graph akan dibangun di atas `stepId`
indeks posisi - dan setiap fitur turunan akan mewarisi kelemahannya.

### Rekomendasi urutan

```
Langkah 1  Putuskan task_id + provenance (desain, bukan kode)
Langkah 2  Tambah task_id ke TodoItem, backward-compatible (blocked-only reasons)
Langkah 3  Test migrasi: daftar lama tanpa id -> id stable, planId/supercedes konsisten
Langkah 4  Baru THEN Task Graph
```

Langkah 2 harus menjaga kompatibilitas: `TodoItem` yang tidak punya `task_id`
(lama) harus tetap bisa dibaca - pola yang sama seperti migrasi kolom
`reasoning` di `f38e0d1`.

### Catatan risiko

Risiko utama bukan teknis, tapi godanya jelas: Task Graph terasa seperti
pelengkap alami sehingga menggoda untuk menunda repair yang baru saja selesai.
Secara jujur: graph tidak memperbaiki state yang salah; graph hanya
membungkusnya lebih rapi, dan membuat state yang salah terlihat lebih
meyakinkan.
