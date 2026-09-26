# Task State Machine Spec

Mode DESIGN. Companion dari `CANONICAL_TASK_MODEL_DESIGN.md`.

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
3. `cancelled` tidak bisaWalker dihidupkan tanpa reopen.
4. `failed -> retrying -> in_progress` mempertahankan `task_id`.
5. Verifikasi basi tidak bisa di-backfill menjadi `completed`.
6. Rekonsiliasi `verdict: failed` mengubah `completed` menjadi non-completed,
   dan **tidak**_break yang mutation-tested (seperti 6 mutasi di `979efa4`).
