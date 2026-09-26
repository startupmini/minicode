# Task Foundation Gap Map

Peta kesenjangan antara apa yang diklaim `f38e0d1` dengan apa yang terbukti,
lalu apa yang masih perlu dibereskan sebelum Task Model bisa dimulai.

Rujukan: `TASK_FOUNDATION_POST_AUDIT.md` (temuan), `TASK_ARCHITECTURE_AUDIT.md`
(audit sebelumnya, gap fitur), `TASK_FOUNDATION_TEST_MATRIX.md` (mutasi).

---

## A. FOUNDATION STATUS

**PARTIALLY VERIFIED.**

Empat cacat yang diklaim diperbaiki di `f38e0d1` **memang diperbaiki** dan
regresinya **terbukti non-vacuous**. Namun satu dari empat itu - yang paling
penting, INV-003 - **belum menutup invariansnya**, dan audit ini menemukan
empat cacat baru yang tidak ada di audit sebelumnya.

 Yang terbukti benar:
- INV-001 task state bertahan lintas resume (V-02, V-05)
- Plan event hanya terbit setelah tool sukses (V-01)
- Plan == file, satu normalizer (V-03)
- `atomicWriteText` atomik (V-07)
- Gerbang menolak completion bila bukti merah SUDAH ada sebelum turn (V-04)

 Yang terbukti **belum** benar:
- INV-003 bocor saat baseline hijau lalu verify turn berubah merah (PF-01, P0)
- Durable state != state yang diamati (PF-02, P1)
- `blockedReason` hilang saat baca (PF-03, P1)
- `blocked` bisa dipilih model tanpa alasan (PF-04, P1)
- Identitas ganda masih ada di sisi presentasi (PF-05, P1)
- Wiring verify-ke-gate tidak punya test (PF-07, P2)

Tidak ada angka skor. Penilaian di atas berbasis bukti langsung, bukan
skoring.

---

## B. BEFORE -> AFTER

Dimensions following the skill section 39 format.

| Dimension | Sebelum (sebelum `f38e0d1`) | Sesudah (`f38e0d1`) | Status sesudah `f38e0d1` | Evidence |
|---|---|---|---|---|
| Task persistence | Hilang di batas resume (id acak) | Bertahan | **VERIFIED** | V-02, V-05, PROBE 8 |
| Completion verification | Tidak ada jalur penolakan | Ada gerbang, tapi bocor bila baseline hijau | **PARTIALLY VERIFIED** | PF-01, PROBE 1-3 |
| Evidence attached to task | Tidak ada | Ada `blocked` + alasan, tapi alasan tidak bertahan | **PARTIALLY VERIFIED** | PF-03 |
| Plan/file consistency | Dua normalizer, dua kebenaran | Satu normalizer | **VERIFIED** | V-03, mutasi bypass |
| Publish integrity | Plan terbit sebelum tool (bisa durable tanpa file) | Terbit setelah tool sukses | **VERIFIED** | V-01, PROBE 5 |
| Identity | Ganda di sisi todo | Tetap ganda di sisi presentasi | **PARTIALLY VERIFIED** | PF-05, PROBE 9 |
| Dependency / graph | Tidak ada | Tidak ada | **NOT IMPLEMENTED** | audit sebelumnya |
| User control | Tidak ada | Tidak ada | **NOT IMPLEMENTED** | audit sebelumnya |
| Undo reconciliation | File saja | File saja | **NOT IMPLEMENTED** | audit sebelumnya |
| Context projection | Tidak ada | Tidak ada | **NOT IMPLEMENTED** | audit sebelumnya |

---

## C. Sisa utang arsitektur

### C.1 Utang dari audit sebelumnya (belum disentuh, sesuai scope)

| ID | Utang | Severity | Kenapa belum dikerjakan di pass ini |
|---|---|---|---|
| TASK-005 | `evidenceComplete` dihitung, nol konsumen | P1 | Butuh renderer/gate; UI kontrak FROZEN |
| TASK-006 | `/undo` hanya revert file; todo tetap `completed` | P1 | Butuh keputusan semantik (apa yang terjadi pada task yang di-undo?) |
| TASK-007 | `.minicode/plans/*.md` write-only; tak ada proyeksi ke context | P1 | Interaksi dengan compaction; perlu ukur token |
| TASK-008 | Nol dependency/graph/scheduler | P1 | Butuh Task Model lebih dulu |
| TASK-010 | Tidak ada TTL/GC untuk file todo di luar SQLite | P2 | Perbaikan kecil tapi di luar scope pass ini |
| TASK-011 | Tidak ada `/tasks`; task state 100% milik model | P1 | Butuh renderer |
| TASK-012 | Truncate 50 item diam-diam; full-replace buta | P2 | Butuh keputusan merge semantics |

### C.2 Utang baru dari audit ini

| ID | Utang | Severity | Catatan |
|---|---|---|---|
| PF-01 | Gate bocor saat baseline hijau lalu turn merah | **P0** | Perbaikan terkecil: rekonsiliasi setelah `runWithSelfHeal` |
| PF-02 | Gate diterapkan saat baca; durable != observed | P1 | Pisahkan jalur baca dari jalur kebijakan |
| PF-03 | `blockedReason` hilang saat baca dan di `.md` | P1 | Baca `blockedReason` di `normalizeTodos` |
| PF-04 | `blocked` bisa dipilih model tanpa alasan | P1 | Keluarkan dari enum model, atau wajibkan alasan |
| PF-05 | Adapter presentasi masih pakai id acak | P1 | Pakai `presentationSessionId` |
| PF-06 | `savePlanSnapshot` gagal diam-diam | P2 | Hapus artefak, atau jadikan tercatat |
| PF-07 | Wiring verify-ke-gate tanpa test | P2 | E2E test; fix P0 bisa dicabut tanpa terdeteksi |
| PF-08 | `lastVerify` tak pernah diinvalidasi | P3 | Timestamp/turn; false positive saja |
| PF-09 | `completionEvidence` global, parallel dengan `todoSession` | P3 | Laten untuk embedder |
| PF-10 | `planId` per-turn; plan tidak berevolusi | P3 | Butuh identitas task stabil (prasyarat) |
| PF-11 | Jendela kill antara tulis file dan flush event | P3 | Arah divergensi benar; tidak mendesak |

---

## D. Prasyarat eksak untuk memulai CANONICAL TASK MODEL

Sebelum Task Graph / Scheduler dimulai, prasyarat berikut harus beres. Urut
dari yang paling mengunci:

### D.1 Wajib - correctness (harus hijau sebelum model baru)

1. **PF-01 ditutup** - `completed` tidak boleh bertahan saat verify merah.
   Tanpa ini, Task Model baru akan dibangun di atas state yang bisa
   false-complete - dan setiap fitur berikutnya (dependency, scheduler)
   mewarisi kebohongan itu.
2. **PF-02 ditutup** - Durable harus sama dengan observed. Tanpa ini, satu sumber
   kebenaran" tidak ada; yang ada dua bentuk.
3. **PF-03 ditutup** - `blockedReason` harus bertahan. Blocker tanpa alasan
   tidak bisa dipakai sebagai input dependency.
4. **PF-04 ditutup** - `blocked` harus selalu beralasan. Status tanpa alasan
   tidak bisa dibedakan "verify merah" dari "agen menyerah".
5. **PF-05 ditutup** - Satu identitas sesi. Tanpa ini, rekonstruksi state pada
  resume salah attribut.

### D.2 Wajib - testability (agar perbaikan berikutnya bisa diverifikasi)

6. **PF-07 ditutup** - Test E2E verify-ke-gate. Tanpa ini, perbaikan D.1 tidak
   bisa dibuktikan tidak vacuous.
7. Korelasi `tool_call_id` unik di semua test E2E task (sudah jadi prinsip di
   test matrix; yang tersisa `cli-session.test.ts:459` masih rely on string).

### D.3 Wajib - design decisions (blocking, perlu diputuskan)

8. **Model data task stabil** - `task_id` yang bertahan lintas retry, turn,
   dan proses. Ini prasyarat mutlak untuk graph (PF-10 tidak bisa diperbaiki
   tanpa ini). Syarat minimum: id yang diturunkan dari isi/konteks, bukan
   indeks posisi.
9. **Provenance** - siapa/apa yang mengubah task dan mengapa (INV-007).
   Tanpa ini, dekomposisi adaptif tidak bisa diaudit.
10. **Semantik `blocked` dan `failed` dibedakan** - `blocked` = ada yang
    menahan (dependency/permission/input user); `failed` = percobaan sudah
    dijalankan dan unsuccessful. Sekarang keduanya tidak ada.
11. **Merge semantics untuk full-replace** - sekarang `todo_write`
    full-replace buta (TASK-012). Task Model yang punya identitas stabil
    harus punya aturan yang jelas saat model mengirim subset.

### D.4 Boleh ditunda (tidak memblokir Task Model)

- PF-06 (artefak `.md`), PF-08 (invalidation bukti), PF-09 (global),
  PF-11 (jendela kill).
- TASK-005, TASK-010, TASK-011, TASK-006 (tetap butuh renderer / keputusan
  UI terpisah).

---

## E. Go / No-Go

### NO-GO untuk Task Graph / Scheduler sekarang.

Alasannya spesifik, bukan umum:

1. **PF-01 adalah P0 pada fondasi yang diklaim sudah diperbaiki.** graph dan
   scheduler dibangun di atas "task mana yang selesai". Kalau jawaban itu
   bisa salah secara struktural (bukan karena model salah, tapi karena tidak
   ada rekonsiliasi), setiap fitur turunan - prioritas, dependency, progress -
   akan mewarisi ketidakakuratan itu dan menambah lapisan yang lebih sulit
   diaudit.
2. **Belum ada identitas task stabil (INV-002).** graph butuh `task_id`.
   `stepId` sekarang adalah indeks posisi yang berubah setiap daftar
   diedit. Tanpa identitas, "retry" dan "supersedes" (INV-011, INV-007)
   tidak bisa diekspresikan - dan tanpa itu, graph akan menebak.
3. **Belum ada test yang bisa membuktikan perbaikan D.1 (PF-07).** Kalau
   perbaikan D.1 dibuat tanpa test E2E, kita tidak akan tahu apakah
   benar-benar bekerja.
4. **Durable != observed (PF-02).** Scheduler yang membaca "blocked" dari
   `todo_read` bisa bertindak berdasarkan state yang tidak ada di disk.

### GO untuk pekerjaan prasyarat (D.1 - D.2).

Rekomendasi urutan kerja:

```
Langkah 1  PF-01  rekonsiliasi setelah self-heal (P0, terkecil)
Langkah 2  PF-07  test E2E verify-ke-gate (sebelum/sesudah langkah 1)
Langkah 3  PF-02  pisahkan jalur baca dari gate
Langkah 4  PF-03  blockedReason bertahan
Langkah 5  PF-04  blocked wajib beralasan
Langkah 6  PF-05  identitas presentasi
Langkah 7  D.3.8  desain task_id stabil (belum implementasi graph)
```

Langkah 1-6 adalah perbaikan terlokalisasi pada `src/tools/todo.ts`,
`cli/setup.ts`, dan `src/presentation/adapter.ts` - tidak menyentuh
presentasi/UI, jadi tidak berisiko pada kontrak FROZEN terminal.

Langkah 7 adalah titik di mana Task Model benar-benar dimulai, dan itu
memang keputusan desain, bukan perbaikan.

### Catatan risiko

Tidak ada blocker eksternal. Semua temuan reproducible di repo ini tanpa
layanan eksternal. Risiko utama adalah temptation untuk memulai graph lebih
dini karena "graph akan compléter semuanya" - tapi graph tidak memperbaiki
state yang salah, hanya membungkusnya lebih rapi.
