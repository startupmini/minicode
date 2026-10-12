# Task State Machine Spec

Mode DESIGN. Companion dari `CANONICAL_TASK_MODEL_DESIGN.md`.

> **Status penegakan (R3).** Dokumen ini tetap DESIGN — tabel di bawah adalah
> rancangan, bukan semuanya kontrak runtime. Pembagian yang dipaksa kode
> (STORE-PERMISSIVE, diratifikasi R3): store menegakkan validitas
> struktural/identitas/otoritas/atomicitas; penulis terotorisasi menegakkan
> aturan alur kerja; konsumen menurunkan kesiapan dari status apa adanya.
> Lihat §Status penegakan di akhir dokumen sebelum mengutip tabel sebagai
> aturan yang berlaku.

## Skema Task (v1)

Diturunkan dari `TodoItem` yang ada, ditambah hanya field yang punya konsumen
nyata di repo. Field tanpa konsumen sengaja tidak dimasukkan (lihat §"Yang
sengaja tidak ada").

```ts
export type TaskStatus =
  | "pending"        // belum dimulai
  | "in_progress"    // sedang dikerjakan
  | "verifying"      // dikerjakan, sedang diperiksa buktinya   (BARU)
  | "blocked"        // ada yang menahan, dengan alasan           (sudah ada)
  | "failed"         // percobaan jalan, hasilnya tidak berhasil (BARU)
  | "retrying"       // transien: failed -> in_progress          (BARU)
  | "completed"      // selesai, terverifikasi                    (sudah ada)
  | "cancelled"      // dibatalkan, eksplisit                    (sudah ada)

export type TaskSource =
  | "user"           // requirement eksplisit dari user
  | "agent"          // usulan model
  | "system"         // dibuat runtime (setup, verify, scaffold)
  | "discovery"      // ditemukan saat eksekusi (dependency conflict dll)
  | "recovery"       // hasil rekonsiliasi (completed -> blocked dll)
  | "legacy"         // hasil migrasi dari format lama          (BARU)

export interface TaskBlocker {
  /** WAJIB terisi. Tanpa alasan, `blocked` ditolak (invariant PF-04). */
  reason: string
  since: number            // ts
  /** Syarat yang harus terpenuhi agar task bisa jalan lagi. */
  unblocksWhen?: string
  /** Task lain yang menahan, bila Penyebabnya dependency. */
  blockedByTaskId?: string
}

export interface TaskVerification {
  verdict: "passed" | "failed" | "unverified"
  at: number                // ts
  /** Perintah yang dijalankan, mis. "bun test". */
  command?: string
  /** Ringkasan hasil, dipotong. */
  detail?: string
  /** Turn tempat verifikasi ini terjadi (untuk staleness). */
  turnId?: number
  /** Rekaman bukti yang mendasari verdict ini. */
  evidenceRefs?: string[]
}

export type EvidenceKind = "receipt" | "test" | "verify" | "checkpoint" | "file"

export interface TaskEvidenceRef {
  kind: EvidenceKind
  /** Untuk `receipt`: toolCallId. Untuk `test`/`verify`: id alat. */
  ref: string
  /** ts bukti; dipakai untuk staleness. */
  at: number
  /** Ringkasan satu baris supaya humanska tak perlu membuka detail. */
  summary?: string
}

export interface TaskProvenance {
  source: TaskSource
  actor: "user" | "agent" | "system"
  /** Alasan perubahan; wajib saat source=discovery atau recovery. */
  reason?: string
  at: number
  /** Event yang menyebabkan perubahan ini (untuk rekonsiliasi). */
  causedByEventSeq?: number
}

export interface Task {
  id: string               // stable, "t<n>"  (TASK_IDENTITY_SPEC.md)
  title: string            // maks 200 char (LIMITS.TODO_CONTENT_MAX_CHARS)
  status: TaskStatus
  order: number            // urutan tampilan SAJA, bukan identitas
  titleKey: string         // hash judul ternormalisasi, untuk re-attach
  /** Key judul sebelumnya, maksimum 1, agar re-attach tahan rename. */
  titleKeys?: string[]
  parentId?: string        // dekomposisi
  dependsOn: string[]      // v1: disimpan + divalidasi, graph belum
  source: TaskSource
  blocker?: TaskBlocker    // wajib kalau status=blocked
  verification?: TaskVerification
  evidence: TaskEvidenceRef[]
  acceptance?: string[]    // opsional; lihat §Completion
  provenance: TaskProvenance
  createdAt: number
  updatedAt: number
  completedAt?: number
}
```

### Hubungan dengan `Receipt` yang sudah ada

`src/presentation/events.ts` sudah mendefinisikan `Receipt` dengan
keterangan: *"Bukti konsekuensi (receipt) - view atas journal/checkpoint,
bukan tracker baru."* Karena itu `TaskEvidenceRef` **tidak** menduplikasi
isi bukti. Ia hanya menyimpan `ref` + `summary`. Isi lengkapnya tetap
diambil dari `presentation_events` / journal saat dibutuhkan. Ini mencegah
store bukti kedua yang pasti akan menyimpang.

## Yang SENGAJA tidak ada di v1

| Field | Alasan tidak dimasukkan |
|---|---|
| `description` | `TODO_CONTENT_MAX_CHARS: 200` sudah memaksa judul pendek; tidak ada konsumen panjang. `detail` masuk sebagai fase berikutnya bila ada yang benar-benar panjang |
| `priority` | Tidak ada scheduler yang membacanya. Field yang tak dibaca hanya memancing model untuk mengisinya tanpa alasan. Dianjurkan masuk **bersama** scheduler |
| `attempts` | Tidak ada mekanisme retry. Menyimpanattempt history tanpa retry hanya menambah field mati. Bentuknya sudah disisakan di `TaskEvent` (`task.retried`) |
| `milestoneId` | Milestone adalah fase sendiri |
| `userNotes` | Tidak ada surface humanska |

## State machine

```
                    ┌──────────────────────────────┐
                    │                              │
  (create) ──▶ PENDING ──▶ IN_PROGRESS ──▶ VERIFYING ──▶ COMPLETED
                 │  ▲          │  ▲           │  │            │
                 │  │          │  │           │  │            │
                 │  │       (retry) │           │  │            │
                 │  │          ▼  │           │  │            │
                 │  │        FAILED │          │  │            │
                 │  │          │     │          │  │            │
                 │  │       RETRYING ──────────▶┘  │            │
                 │  │                             │            │
                 └──┴─────── BLOCKED ◀──────────┴────────────┘
                                │
                                └──▶ CANCELLED  (dari status mana pun)
```

### Transisi valid

| Dari | Ke | Pemicu | Catatan |
|---|---|---|---|
| - | `pending` | task dibuat | satu-satunya jalan masuk |
| `pending` | `in_progress` | model mulai mengerjakan | harus ada deps terpenuhi bila `dependsOn` terisi |
| `in_progress` | `verifying` | model mengklaim selesai | klaim **bukan** penyelesaian |
| `verifying` | `completed` | verifikasi lolos | §Completion |
| `verifying` | `failed` | verifikasi merah | |
| `verifying` | `blocked` | blocker non-verifikasi (permission, input user) | |
| `verifying` | `pending` | verifikasi basi | §Stale |
| `in_progress` | `failed` | tool gagal fatal | |
| `in_progress` | `blocked` | butuh keputusan user | |
| `failed` | `retrying` | sistem memutuskan mencoba lagi | |
| `retrying` | `in_progress` | percobaan berikutnya | **id tetap sama** (INV-011) |
| `failed` | `blocked` | attempts habis / perlu input | |
| `blocked` | `pending` | kondisi pemicu terpenuhi | |
| `completed` | `in_progress` | reopen (verify basi, atau user) | `completedAt` di-nolkan |
| mana pun | `cancelled` | model atau user | terminal |

### Transisi yang harus DITOLAK

| Dari | Ke | Alasan penolakan |
|---|---|---|
| `pending` | `completed` | harus lewat `verifying`; ini pagar false-completion |
| `failed` | `completed` | klaim setelah gagal tidak pernah langsung selesai |
| `blocked` | `completed` | ada yang menahan; harus `pending` dulu |
| `cancelled` | mana pun | terminal; perlu `reopen` eksplisit (membuat task baru atau reset) |
| `verifying` | `in_progress` | harus `failed` dulu (mencatat kegagalan), lalu `retrying` |
| `completed` | `completed` | no-op, bukan error, tapi **tidak** menerbitkan event |

Penolakan harus **menerbit kan error yang bisa ditindaklanjuti** ke model,
bukan diam-diam. Pola yang sudah dipakai repo: `normalizeTodos` melempar
`"todos is empty - provide at least one item with content"`, dan kernel
menjadi `errorResult`. Pola yang sama dipakai.

## FAILED vs BLOCKED — definisi tegas

Ini adalah pembedaan yang paling penting, karena sebelumnya keduanya tidak
ada dan `blocked` sempat menjadi generic non-completed state.

| | FAILED | BLOCKED |
|---|---|---|
| Apa terjadi | Sistem mencoba, hasilnya tidak berhasil | Sistem **tidak bisa** mencoba |
| Pemicu | tool error fatal, verifikasi merah setelah retry | permission ditolak, butuh input user, dependency terblokir, tidak ada kredensial |
| 정보 yang ada | bukti kegagalan (error, output verifikasi) | alasan + `unblocksWhen` |
| Who unblocks | sistem (retry) atau user (koreksi) | user atau task lain |
| Boleh auto-retry | ya, lewat `retrying` | tidak; retry tidak akan mengubah apa pun |
| Today's reality | **belum ada** (PF-04 menunda `failed`) | dipakai untuk verifikasi merah |

**Catatan penting soal implementasi saat ini.** `blocked` sekarang dipakai
 exclusively untuk "verifikasi merah" (lihat `applyCompletionPolicy` di
`src/tools/todo.ts`). Di bawah state machine yang dirancang, verifikasi merah
seharusnya menjadi `failed`, dan `blocked` untuk hal non-verifikasi. Memindahkan
itu adalah **perubahan perilaku** yang harus disetujui manusia (§15).

Alternatif yang lebih konservatif: biarkan `failed` baru, dan tetap użyj
`blocked` untuk verifikasi merah sampai ada mekanisme retry. Itu **RECOMMENDED**
karena tidak mengubah apa yang sudah diverifikasi.

## Semantics completion

Empat syarat, semuanya wajib:

1. **Verifikasi lolos.** `verification.verdict === "passed"`.
2. **Verifikasi tidak basi.** `verification.at >= updatedAt terakhir dari
   perubahan yang relevan` (lihat §Stale).
3. **Bukti ada.** `evidence.length > 0` bila task menyentuh workspace.
4. **Acceptance terpenuhi.** Bila `acceptance` diisi, semua item harus
   terpenuhi. Bila kosong,vzdyn verify yang menjadi kriteria.

`applyCompletionPolicy` yang sekarang (pure, sudah di-mutation-test) tetap
menjadi satu-satunya implementation gate. Ia diperluas dari
`completed -> blocked` menjadi **menolak** transisi `verifying -> completed`
bila syarat di atas tidak terpenuhi.

### Invariant yang wajib dipertahankan

> `completed` tidak boleh bertahan jika verifikasi final gagal.

Rekonsiliasi pasca-verify (`reconcileCompletionEvidence`) yang sudah ada
harus diperluas: bukan hanya `completed -> blocked`, tapi juga
`completed -> failed` bila verdict `failed`, dan `completed -> verifying`
bila verdict `unverified` (bukti tak cukup). Jalur rekonsiliasi ini sudah
ada di `979efa4`; yang baru adalah perlakuan terhadap `failed` dan
`unverified`.

### Stale verification

**Dasar repo:** `checkStaleTurn` (`cli/setup.ts`) dan
`validateResumeWorkspace` sudah membedakan "terakhir diketahui baik" dari
"terbaru saat ini". Pola yang sama dipakai.

Aturan: sebuah `verification` basi bila ada salah satu:

- ada mutasi file (receipt baru) dengan `ts > verification.at`
- ada perubahan status task setelah `verification.at`
- `verification.turnId` lebih tua dari turn berjalan saat ini

Task dengan verifikasi basi **tidak** boleh di-backfill ke `completed` tanpa
re-run verifikasi. Bentukillisikan: `verifying -> pending` supaya workanya
diulang, bukan dianggap selesai.

### Reconciliation

Rekonsiliasi adalah **satu-satunya** jalur yang boleh membatalkan `completed`
tanpa model. Aturannya:

```
verdict failed      -> completed menjadi failed
verdict unverified  -> completed menjadi verifying (bukti tak cukup)
verdict passed      -> completed TETAP completed
```

Rekonsiliasi menulis event (`task.reconciled`) dengan `causedByEventSeq` yang
menunjuk verdict yang menyiksanya, sehingga jejak tetap ada.

## Yang harus dibuktikan sebelum dianggap benar

1. Seluruh transisi valid lolos; seluruh transisi yang tercatat di "harus
   ditolak" benar-benar ditolak dengan pesan yang bisa ditindaklanjuti.
2. `pending -> completed` ditolak walau model mengirim `status: "completed"`
   untuk task yang belum pernah `in_progress`.
3. `cancelled` tidak bisa dihidupkan tanpa reopen.
4. `failed -> retrying -> in_progress` mempertahankan `task_id`.
5. Verifikasi basi tidak bisa di-backfill menjadi `completed`.
6. Rekonsiliasi `verdict: failed` mengubah `completed` menjadi non-completed,
   dan **tidak** break yang mutation-tested (seperti 6 mutasi di `979efa4`).

## Status penegakan (R3 — kontrak store-permisif, diratifikasi)

Keputusan R3: `STORE-PERMISSIVE CONTRACT JUSTIFIED`. Daftar "harus dibuktikan"
di atas adalah target desain yang belum semuanya berlaku; yang berlaku saat
ini adalah pembagian di bawah. Jangan mengutip tabel transisi sebagai aturan
runtime tanpa memeriksa kolom status di seksi ini.

### Yang DIPAKSA kode produksi

| Aturan | Lokasi implementasi | Test pengunci |
|---|---|---|
| `blocked` wajib beralasan | `src/task/store.ts:774-777` (`validate`), `src/tools/todo.ts:201-208` (normalizeTodos) | `taskstore.test.ts` "validation: BLOCKED needs a reason", `task-invariants.test.ts` PF-04 |
| `IN_PROGRESS` hanya via `claimTask` (mode SCHEDULER) | `src/task/store.ts:882-887` (`TASK_AUTHORITY_VIOLATION`) | `phase6b-prerequisites.test.ts:241,549`, `task-contract-boundary.test.ts` kontrak 7 |
| Klaim atomik hanya dari `PENDING` (+ revisi + kapasitas) | `src/task/store.ts:1065-1087` | suite 6B/6C, `task-contract-boundary.test.ts` kontrak 6 |
| Reconcile hanya in-flight milik-sendiri (`IN_PROGRESS`/`VERIFYING` → `PENDING`) | `src/task/store.ts:1166-1210` (`REFUSED_NO_OWNERSHIP`, predikat milik) | suite 6P/6F, `task-contract-boundary.test.ts` kontrak 6 |
| Bentuk identitas/dependensi (id kanonis, tanpa duplikat, dep ada, bukan diri sendiri, ≤32) | `src/task/store.ts:778-803`, `src/task/identity.ts:160,199` | `taskstore.test.ts` L, phase3a/4a2/4a4 |
| Bukti merah menolak `completed` (→ `blocked` + alasan) | `src/tools/todo.ts:159-169,209-213` | `task-invariants.test.ts` INV-003 |
| Satu payload = satu transaksi atomik; id tak dikenal/duplikat = tolak seluruhnya | `src/task/sync.ts:115-207` | phase4a2/4a4/4b2 |
| Terminalitas di primitif scheduler (tak bisa di-claim/di-reconcile dari terminal) | `src/task/store.ts:694,704`, predikat claim/reconcile | suite 6B/6P |

### Yang DIUSULKAN tapi TIDAK dipaksa (permisif, disengaja)

| Baris tabel | Status runtime aktual |
|---|---|
| `pending → completed` harus ditolak | **Diizinkan** bila bukti tak merah (penyelesaian hijau/tanpa-bukti memang boleh — `task-invariants.test.ts:98-102`). Pagar false-completion adalah gerbang bukti di penulis, bukan store. |
| `failed → completed`, `blocked → completed` harus ditolak | **Diizinkan** bila bukti tak merah; `normalizeTodos`/`patchTask` tak memeriksa status asal. |
| `cancelled → mana pun` harus ditolak | **Diizinkan** di tingkat store (reopen didukung); "terminal" adalah perlakuan primitif turunan, bukan larangan tulis. |
| `verifying → in_progress` harus ditolak | Tak ada produsen dan tak ada pagar; `patchTask` menerimanya. |
| `completed → completed` no-op tanpa event | Ditulis (revision +1); patch tak pernah menerbitkan event apa pun. |
| Seluruh lifecycle `failed → retrying → in_progress` | `RETRYING`/`VERIFYING`/`FAILED` tanpa produsen (kosakata model hanya 5 status: `identity.ts:43-56`). Requeue setara ada via reconcile→`PENDING`→claim. |

### Semantik COMPLETED yang berlaku (eksplisit)

TaskStore **tidak** menjamin task boleh `completed` hanya setelah prasyarat
terpenuhi, dan **tidak** memverifikasi kebenaran penyelesaian:

- Lapisan yang menerima status: `patchTask`/`synchronizeCanonicalTasks`
  menulis status yang dideklarasikan penulis tanpa memeriksa status
  dependensi (`src/task/sync.ts:161-175`).
- Konsumen: readiness menganggap `COMPLETED` memenuhi dependensi
  (`src/task/readiness.ts:82-92`); scheduler mengeksekusi dependen atas
  dasar itu. `task-contract-boundary.test.ts` kontrak 5 mengunci kedua sisi.
- Penerimaan store bukan bukti operasi bisnis selesai. Jaminan completion
  (bukti merah→`blocked`, verifier eksternal) milik gerbang bukti di alur
  kerja yang membutuhkan (`normalizeTodos`, `reconcileCompletionEvidence`,
  otoritas scheduler) — bukan store.

### Batas kontrak untuk perancang Phase 9

Jangan berasumsi TaskStore menyediakan otomatis: matriks transisi global;
bukti prasyarat terpenuhi sebelum completion; lifecycle verifikasi untuk
status tanpa produsen terkonfirmasi (`verifying`/`failed`/`retrying`);
kebenaran bisnis hanya karena pembaruan status terpersist. Ini batas
kontrak, bukan cacat. Perubahan perilaku di area ini butuh
persetujuan manusia (seperti §FAILED vs BLOCKED di atas) dan test pengunci
baru, bukan reinterpretasi tabel desain.
