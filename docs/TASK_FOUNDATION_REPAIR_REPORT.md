# Task Foundation Repair Report

Audit `agent-task-architect`, tahap REPAIR atas temuan POST-FIX FOUNDATION
AUDIT (`e4a7b7c`). Cakupan: **hanya** D.1-D.2 (enam gap fondasi). Task Graph,
Scheduler, `/tasks` UI, milestone, task model, `task_id`, dan dependency
sistem **tidak** diimplementasikan.

Semua perbaikan punya dua bukti: (1) regression ditulis lebih dulu dan
dibuktikan merah sebelum fix, (2) mutation test membuktikan test tersebut
menangkap fix yang dibalik.

## Ringkasan

| Gap | Severity | Status akhir | Bukti |
|---|---|---|---|
| PF-01 | P0 | **IMPLEMENTED + VERIFIED** | E2E PF-01, mutasi MUT-1, probe R1/R2/R3 |
| PF-07 | P2 | **IMPLEMENTED + VERIFIED** | E2E PF-07, mutasi MUT-2 |
| PF-02 | P1 | **IMPLEMENTED + VERIFIED** | unit PF-02 + probe R4, mutasi MUT-3 |
| PF-03 | P1 | **IMPLEMENTED + VERIFIED** | unit PF-03 + probe R5, mutasi MUT-4 |
| PF-04 | P1 | **IMPLEMENTED + VERIFIED** | 4 unit PF-04, mutasi MUT-5 |
| PF-05 | P1 | **IMPLEMENTED + VERIFIED** | E2E PF-05 + probe R6, mutasi MUT-6 |

Tidak ada gap yang tersisa FAILED atau UNTESTED. Tidak ada skor numerik.

---

## PF-01 (P0) - `completed` tidak boleh bertahan saat verify turn merah

**MASALAH.** Gerbang completion hanya membaca `lastVerify`, yang diisi verify
SEBELUM turn. `baseline-first` menutupi "baseline merah", tetapi "baseline
hijau lalu verify turn ini merah" lolos: klaim `completed` tersimpan, verify
tiga kali merah, file tetap `completed`.

**REGRESSION DULU (bukti gagal tanpa fix).** E2E dengan verify "hijau sekali
lalu merah", di `test/cli-session.test.ts` ("PF-01: baseline hijau lalu verify
turn merah"). Sebelum fix:
```
error: expect(received).not.toBe(expected)
Expected: not "completed"
(fail) ... 0 pass / 1 fail
```

**FIX.** `reconcileCompletionEvidence()` di `src/tools/todo.ts` - operasi TULIS
eksplisit yang memuat daftar secara pasif, menerapkan `applyCompletionPolicy`,
lalu menulis balik JSON + plan snapshot. Dipanggil di `cli/setup.ts` tepat
SETELAH `runWithSelfHeal` resolve, jadi verdict final itulah yang membentuk
state durable. Bila ada perubahan, `presentation.notePlanReconciled()`
menerbitkan `plan.updated` baru dari daftar yang sudah dinormalisasi, sehingga
durable log tidak lagi berbunyi `completed`.

AturanCompletionPolicy diekstrak menjadi fungsi murni agar gerbang tulis dan
rekonsiliasi memakai **satu** implementasi.

**MUTASI MUT-1.** Blok rekonsiliasi dimatikan (`if (false && ...)`):
```
(fail) PF-01: baseline hijau lalu verify turn merah - completed tak boleh bertahan
0 pass / 1 fail
```

**PROBE R1/R2/R3 (proses nyata).**
```
R1 baseline MERAH           -> blocked           PASS
R2 baseline HIJAU, turn MERAH -> blocked + alasan  PASS
   plan events: [{completed}, {open, blocked}]  (event terakhir = blocked)
R3 self-heal 3x gagal lalu klaim -> refused + blocked  PASS
```

**CATATAN JUJUR.** Durable event log tetap **menyimpan** event `completed` yang
pernah terbit sebelum rekonsiliasi. Itu memang sejarah yang benar (klaim itu
sungguh terjadi), dan proyeksi akhirnya benar karena `planId` sama sehingga
reducer memakai last-write-wins. Yang dijamin: **state akhir** tidak pernah
`completed` saat verify merah.

---

## PF-07 (P2) - wiring produksi punya test

**MASALAH.** Tidak ada test yang menyalakan `--verify` sekaligus memanggil
`todo_write`. Test unit menyuntik bukti manual, jadi seluruh wiring composition
root dilewati. Terbukti: mutasi yang mematikan injeksi bukti di `setup.ts`
menluidkan 48 test.

**FIX (test, bukan kode produksi).** E2E "PF-07: jalur produksi verify merah ->
todo_write ditolak gerbang" di `test/cli-session.test.ts`. Menyalakan
`--verify` dengan verify command merah sungguhan, lalu mengobservasi **hasil
tool yang benar-benar diterima model**, dikorelasikan lewat `tool_call_id`
unik (`claim_pf07`).

**MUTASI MUT-2.** Injeksi bukti diganti `() => ({ verdict: "unverified" })`
(mutasi valid, `tsc` hijau):
```
Expected to contain: "refused 1 completion claim"
Received: "todos 1/1\n  [x] Klaim selesai"
(fail) PF-07: jalur produksi verify merah -> todo_write ditolak gerbang
0 pass / 1 fail
```
Sebelum repair: 48 test hijau. Sesudah: test merah. Celah tertutup.

---

## PF-02 (P1) - durable = observed

**MASALAH.** `loadTodos` melewati `normalizeTodos` tanpa bukti, sehingga
kebijakan completion ikut berlaku saat BACA. `todo_read` melaporkan `blocked`
sementara file tetap `completed`; tidak ada yang menyelaraskan.

**FIX.** `loadTodos` kini PASIF: ia menormalisasi dengan bukti `unverified`
sehingga tidak ada kebijakan yang diam-diam berlaku. Bentuk di disk menjadi
satu-satunya kebenaran. Kebijakan hanya berlaku di dua jalur tulis eksplisit:
`todo_write` dan `reconcileCompletionEvidence`.

**Tidak ada second source of truth** - `reconcileCompletionEvidence` menulis
balik ke file yang sama, lalu `todo_read` membaca file yang sama.

**MUTASI MUT-3.** `loadTodos` dikembalikan ke `normalizeTodos(parsed.todos)`:
```
(fail) PF-02: disk `completed` + bukti merah -> loadTetap `completed`
(fail) PF-02: reconcileCompletionEvidence adalah operasi TULIS yang eksplisit
17 pass / 2 fail
```

**PROBE R4.** File `completed` + verify merah, `todo_read` di proses baru:
```
todo_read: "todos 1/1\n  [x] Selesai"
PASS (completed, sesuai disk)
```

---

## PF-03 (P1) - `blockedReason` durable

**MASALAH.** `normalizeTodos` membangun `{content, status}` dan tidak pernah
membaca `blockedReason`. Ditulis ke JSON, dibuang saat baca, dan tidak ikut
`renderPlan`. Blocker kehilangan penjelasan tepat setelah restart.

**FIX.** `normalizeTodos` membaca `blockedReason` dari input (terbatas 300
karakter). `renderPlan` memakai kotak `[!]` dan menyertakan alasannya.

**MUTASI MUT-4.** Pembacaan `blockedReason` dihapus:
```
(fail) blocked DENGAN alasan dari file dipertahankan
(fail) tool memberi tahu model saat completion ditolak
(fail) reconcileCompletionEvidence adalah operasi TULIS yang eksplisit
(fail) PF-03: alasan blocker bertahan: write -> baca ulang -> renderPlan
15 pass / 4 fail
```

**PROBE R5.** `todo_write` dengan verify merah, lalu `todo_read` di proses
baru:
```
file:      [{"status":"blocked","blockedReason":"last verification failed (...)"}]
todo_read: "todos 0/1 · 1 blocked\n  [!] Gagal - last verification failed (...)"
plan .md memuat alasan? PASS
```

---

## PF-04 (P1) - `blocked` terkurung semantik

**MASALAH.** `blocked` ada di enum tool, jadi model dapat memilihnya tanpa
alasan. `blocked` berubah menjadi generic non-completed state, tercampur
"verify merah" dengan "agen menyerah".

**FIX (dua pagar).**
1. `blocked` **dihapus dari enum model**. Status itu ditegakkan runtime.
2. Pagar kedua di `normalizeTodos`: `blocked` tanpa `blockedReason` turun ke
   `pending`. Ini menangkap file yang ditulis tangan dan jalur argumen lain.

**FAILED != BLOCKED dipelihara.** `blocked` berarti "ada yang menahan dengan
bukti" (verifikasi merah) dan selalu membawa alasan. Status `failed` -
yang berarti "percobaan sudah dijalankan dan tidak berhasil" - **sengaja
tidak ditambahkan** di pass ini karena itu lifecycle state, yaitu bagian dari
Canonical Task Model yang sedang ditunda. Test mengunci bahwa verifikasi
merah menghasilkan `blocked`, bukan `failed`.

Retryable failure: **tidak berlaku** di fondasi saat ini - belum ada mekanisme
retry pada task, jadi tidak ada yang perlu dibedakan.

**MUTASI MUT-5.** `blocked` dikembalikan ke enum dan pagar kedua dihapus:
```
(fail) blocked tanpa alasan tidak boleh ada (PF-04)
(fail) enum model tidak menawarkan `blocked` (PF-04)
17 pass / 2 fail
```

---

## PF-05 (P1) - identitas presentasi kanonik

**MASALAH.** `createPresentationAdapter` menerima `{sessionId}` yang acak saat
`--resume`, sementara writer baris dan todo memakai `presentationSessionId`.
`row.session_id`, `payload.sessionId`, dan `planId` berasal dari sumber
berbeda.

**FIX.** `cli/setup.ts` mengoper `sessionId: presentationSessionId` ke
adapter. Sekarang `row.session_id`, `payload.sessionId`, `planId`, dan nama
file todo semuanya dari `presentationSessionId` yang sama.

**MUTASI MUT-6.** Adapter dikembalikan ke `sessionId`:
```
(fail) PF-05: identitas plan event kanonik setelah --resume
0 pass / 1 fail
```

**PROBE R6.**
```
row=idc payload=idc planId=plan:idc:0 PASS
row=idc payload=idc planId=plan:idc:1 PASS
file todo: ["idc.json"]
```

---

## Catatan proses

Satu kesalahan proses terjadi dan dampaknya nyata: saat mutation testing, saya
memakai `git checkout -- <file>` untuk memulihkan, yang mengembalikan file ke
**commit terakhir**, bukan ke state kerja. Itu menghapus seluruh implementasi
PF-01/PF-02/PF-03/PF-04 dari `src/tools/todo.ts` dan `cli/setup.ts`. Saya
mendeteksi lewat `git status` dan memulihkannya, lalu menerapkan ulang seluruh
perubahan dan memakai backup file (bukan `git checkout`) untuk mutasi
selanjutnya. Semua mutasi di laporan ini dilakukan setelah pemulihan, dan
hanya `src/presentation/adapter.ts` yang selamat (tidak pernah di-checkout).

Selain itu, `test/writer-inventory.test.ts` (OAP-008) menangkap
`process.stderr.write` ke-27 yang saya tambahkan di `setup.ts`. Perbaikannya
sama seperti yang dipakai sebelumnya: diagnostik dipindahkan ke modul pemilik
kegagalan (`reconcileCompletionEvidence`), sehingga pagu writer tidak naik.

## Gate

`2.621 pass / 22 skip / 0 fail`; coverage 84,49% funcs / 85,43% lines (minimum
84/85 tidak dinaikkan karena coverage tidak naik); pack 23/23; `tsc` bersih;
`biome` bersih.
