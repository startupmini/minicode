# Canonical Task Model - Implementation Plan

Mode DESIGN. Dokumen ini **rencana**, bukan implementasi. Tidak ada kode yang
ditulis untuk isi-phase ini.

## Prinsip Sequencing

1. **Otoritas lebih dulu, fitur kemudian.** TaskStore kanonik harus ada
   sebelum task event, dan task event harus ada sebelum graph.
2. **Setiap fase punya gate.** Gate wajib hijau sebelum fase berikutnya; kalau
   merah, berhenti dan perbaiki - jangan menumpuk perubahan yang tidak
   terverifikasi.
3. **Mutation test wajib untuk tiap fix.** Aturan yang sudah Established dari
   `979efa4`: regression yang tidak diuji balik tidak dihitung terbukti.
4. **Tidak ada UI.** Kontrak terminal beku; humanska surface adalah fase
   terpisah setelah domain stabil.

## Fase

### Fase 0 - Keputusan desain (BLOCKING, tanpa kode)

Tidak ada kode sampai manusia menyetujui:

| # | Keputusan | Pilihan | Rekomendasi |
|---|---|---|---|
| D1 | Bentuk `task_id` | `t<n>` monotonik / UUID / content-hash | `t<n>` (lihat `TASK_IDENTITY_SPEC.md`) |
| D2 | Otoritas TaskStore | SQLite / JSON | SQLite (lihat §Persistence) |
| D3 | Mutasi semantik | replace / patch / declarative upsert | declarative upsert |
| D4 | `blocked` untuk verifikasi merah | pertahankan / pindahkan ke `failed` | pertahankan dulu (RECOMMENDED) |
| D5 | Bentuk `stepId` di `plan.updated` | indeks / `task_id` | `task_id` (perubahan kontrak machine-output) |
| D6 | Task event di `presentation_events` / tabel baru | satu / dua | satu (hemat satu otoritas) |
| D7 | Task hilang dari daftar | hapus / pertahankan | pertahankan (perubahan perilaku) |

**Gate 0:** keputusan tercatat di dokumen ini dengan alasan, dan tidak ada
ketidaksetujuan yang tersisa.

### Fase 1 - TaskStore kanonik

**Tidak mengubah perilaku eksternal.** Hanya memindahkan otoritas.

- Tabel `tasks` di `sessions.db` (migrasi additive, pola sama seperti
  `reasoning`/`is_error` di `src/session/persistence.ts`).
- `TaskStore` di `src/task/store.ts`: `load`, `save`, `nextId`.
- `saveTodoStore` dipanggil dari `cli/setup.ts` dengan
  `presentationSessionId` (pola yang sudah benar sejak PF-05).
- **Catatan:** file .minicode/todos/*.json menjadi **ekspor humanska** yang
  ditulis dari TaskStore, bukan sumber. `loadTodos` membaca TaskStore.
- purgeExpired ditambah penghapusan tabel 	asks (memperbaiki TASK-010 sekaligus).

**Gate 1:** seluruh test `979efa4` tetap hijau; plus test baru: restart →
TaskState identik; `nextId` tidak mulai dari 1; tidak ada file todo yatim
lagi setelah TTL.

### Fase 2 - Identitas

- `task_id` masuk `TodoItem` (menjadi `Task`).
- `titleKey` + `titleKeys` historis.
- `order` dipisah dari identitas.
- `stepId` di `plan.updated` diisi `task_id` (D5).

**Gate 2:** test reorder 50 item (id stabil); test restart; test judul
duplikat; test re-attach setelah rename. Mutation test: `stepId` kembali
ke indeks → merah.

### Fase 3 - Semantik mutasi

- Match rules (`TASK_MUTATION_SEMANTICS.md`).
- Task hilang dipertahankan (D7).
- Duplikat `id` dan unknown `id` ditolak seluruh pengiriman.
- `parentId` divalidasi (tidak ada anak yatim).

**Gate 3:** tujuh bentuk kiriman + unknown id; determinisme; task hilang
terbukti bertahan. Mutation test: kembalikan aturan delete → merah.

### Fase 4 - Lifecycle & completion

- `TaskStatus` diperluas (`verifying`, `failed`, `retrying`).
- State machine ditegakkan; transisi invalid ditolak dengan pesan yang bisa
  ditindaklanjuti.
- `applyCompletionPolicy` diperluas: menolak `verifying -> completed` bila
  syarat completion tidak terpenuhi; menambahkan penanganan ailed dan unverified.
- `reconcileCompletionEvidence` memakai aturan yang sama.

**Gate 4:** matriks transisi (valid lolos, invalid ditolak); completion
gate 4 semantics (baseline merah, baseline hijau + turn merah, self-heal
gagal, stale); `completed` tidak bertahan setelah verdict final gagal.
Mutation test: gate dimatikan → merah.

### Fase 5 - Task events

- Event task baru di `presentation_events` dengan `actor`,
  `correlationId`, `supersedes` (D6).
- Reducer: `plans` di-key `taskId`; `supersedes` dihormati saat rekonstruksi.
- `plan.updated` tetap terbit untuk ACP/`exec --json`.

**Gate 5:** property replay (log == store); event usang diabaikan; event
rusak tidak membatalkan seluruh log; `plan.updated` lama masih terbaca.
Mutation test: `supersedes` diabaikan → merah.

### Fase 6 - Evidence & provenance

- `TaskEvidenceRef` merujuk `Receipt` (tanpa menduplikasi isi).
- `evidenceComplete` yang sekarang orphan (TASK-005) dipakai: task yang
  mutasinya tidak punya receipt ditandai.
- `provenance` di setiap task; `source=discovery` wajib `reason`.
- Stale verification (mutasi file / perubahan status setelah `verification.at`).

**Gate 6:** bukti bertahan lintas restart; stale verification tidak bisa
di-backfill menjadi `completed`; provenance ada di setiap task.

### Fase 7 - Migrasi legacy

- `schemaVersion` di state.
- Legacy `{content, status, blockedReason}` → `Task` dengan id berurutan,
  `titleKey` dihitung, `source: "legacy"`.
- Tulisan balik dalam format baru; pembaca lama (file lama) tetap bisa
  dibaca (dua arah).
- Event `task.migrated`.

**Gate 7:** file legacy dibaca tanpa kehilangan field; setelah migrasi,
proses baru membaca hasil migrasi; file yang ditulis tangan tetap aman.

### Fase 8 - Context projection

- Blok `# Tasks` di slot `extra` (`src/app/session.ts:80`), sebelum MEMORY,
  agar tidak terpotong `cutMarked`.
- Diproyeksikan ulang tiap turn dari TaskState (menyelesaikan TASK-007).
- Budget kecil (±1200 char): jumlah, task aktif, task siap berikutnya,
  blocker beserta alasan, state verifikasi.
- **Tidak** menyertakan sejarah.

**Gate 8:** prompt memuat blok; kompresi tidak menghilangkan blok; ukuran
terukur; context rotation menyisakan state yang sama.

### Fase 9 - Dependency (referensi saja)

- `dependsOn` disimpan dan divalidasi (siklus ditolak saat tulis).
- Status READY dihitung tapi **tidak dipakai** untuk menjadwalkan apa pun.
- Belum ada scheduler, belum ada traversal graph.

**Gate 9:** siklus ditolak; referensi ke `id` tak dikenal ditolak;Task
dengan dependency tak terpenuhi dapat di-`blocked` dengan `blockedByTaskId`.

### Fase 10+ - Di luar desain ini

| Fase | Isi | Catatan |
|---|---|---|
| Task Graph | graph penuh, traversal | setelah Fase 9 |
| Scheduler | pemilihan task berikutnya | butuh `priority` (§15 OPTIONAL) |
| Milestone | pengelompokan | model terpisah |
| `/tasks` UI | humanska inspect + mutate | kontrak beku; fase sendiri |
| Retry | `attempts`, `retrying` loop | butuh scheduler dulu |

## Risiko per fase

| Fase | Risiko utama | Mitigasi |
|---|---|---|
| 1 | Kehilangan state kalau migrasi salah | Gate 1 menjalankan test `979efa4` utuh; file JSON tetap ada sebagai cadangan |
| 2 | `stepId` berubah → konsumer machine pecah | D5 harus disetujui; `exec --json` dan ACP punya test kontrak |
| 3 | Daftar menumpuk karena task tak terhapus | D7 disetujui eksplisit; sediakan `cancelled` yang mudah |
| 4 | Terlalu ketat → model terjebak | Pesan penolakan harus bisa ditindaklanjuti; ukur jumlah penolakan |
| 5 | Replay tidak cocok dengan store | Property replay jadi gate, bukan nanti |
| 6 | Bukti duplikat | `TaskEvidenceRef` hanya merujuk; tidak menyimpan isi |
| 8 | Prompt membengkak | Budget keras; ukur `SYSTEM_PROMPT_MAX_CHARS` |

## Gate global (setiap fase)

```bash
bun x tsc --noEmit
bun run lint
bun test
bun run gate:coverage
bun run gate:pack
```

Ditambah: mutation test untuk setiap fix fase tersebut, dan
`git diff --check` bersih. `docs/TERMINAL_CONTRACT.md` hanya diubah bila ada
perubahan output yang nyata - dan itu **tidak** terjadi di Fase 1-9.
