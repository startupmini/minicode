# Task Event Model

Mode DESIGN. Companion dari `CANONICAL_TASK_MODEL_DESIGN.md`.

## Prinsip: state dan history adalah dua hal berbeda

| | TaskState | TaskEvent |
|---|---|---|
| Bentuk | satu rekaman per task (current) | append-only, satu per perubahan |
| Ukuran | O(task) | O(perubahan) |
| Sumber kebenaran | ya | bukan; dipakai untuk rekonstruksi dan audit |
| Sudah ada? | `.minicode/todos/*.json` | `presentation_events` (tabel SQLite) |

Hari ini keduanya belum terpisah rapi: `plan.updated` ditulis per-turn dengan
`planId = plan:<session>:<turn>`, sehingga plan **bercabang**, bukan berevolusi
(`docs/TASK_FOUNDATION_GAP_MAP.md`, R-01/PF-10). Desain ini menutupnya.

## Di mana event hidup

**Keputusan: task event masuk `presentation_events` yang sudah ada.**

Alasannya berbasis bukti:

- Tabel sudah punya `(session_id, event_seq)` sebagai PK dan `eventSeq`
  sudah jadi urutan total (`src/presentation/events.ts`, `interface Base`).
- Sudah durable + replayable + direplay `rebuildFromDurable` saat start.
- Sudah ada `Durability` table dan `rebasePresentationPayload` untuk branch.
- Membuat log kedua berarti **dua otoritas** - persis yang skill larang dan
  yang sudah bitten di repo (dual store todo/plan).

Kekhawatiran yang harus dicatat: tabel itu bernama "presentation", jadi
menaruh task event di sana menambah coupling. Saya menilai itu dapat diterima
karena TaskState adalah bagian dari agent state dan presentation adalah proyeksi
dari agent state - bukan domain terpisah. Bila tim lebih suka pemisahan nama,
`task_events` sebagai tabel terpisah dengan `eventSeq` sendiri bisa dipilih
tanpa mengubah semantik. **Ini keputusan yang butuh persetujuan (§15).**

## Field bersama

Semua task event memakai `Base` yang sudah ada:

```ts
interface Base {
  eventSeq: number
  ts: number
  sessionId: string
  turnId: number
}
```

Ditambah tiga field baru yang tidak ada di event lain:

```ts
/** Siapa yang menyebabkan perubahan. */
actor: "user" | "agent" | "system"

/** Mengaitkan perubahan dengan sebabnya (verifikasi, mutasi file, event lain).
 *  Untuk `task.reconciled`, ini menunjuk verdict yang menyiksanya. */
correlationId?: string

/** Event yang dioxide oleh event ini. Untuk `task.reconciled`, ini event
 *  `task.completion_claimed` yang dibatalkan. */
supersedes?: number
```

`supersedes` menjawab temuan R-01: log menyimpan klaim `completed` yang kemudian
dibatalkan rekonsiliasi. Dengan `supersedes`, rekonstruksi bisa membedakan
" Events ini masih berlaku" dari "sudah dibatalkan" tanpa menghapus sejarah.

`correlationId` menjawab kebutuhan menyatukan beberapa task yang muncul dari
verifikasi yang sama.

## Daftar event

### Lifecycle

| Event | Kapan | Field tambahan |
|---|---|---|
| `task.created` | task baru dibuat | `task: Task` |
| `task.updated` | field non-status berubah (title, order, parent) | `taskId, patch: {title?, order?, parentId?}` |
| `task.status_changed` | perubahan status | `taskId, from, to, reason?` |
| `task.claimed` | model mengklaim sebuah task selesai | `taskId, title` |
| `task.dependency_changed` | `dependsOn` berubah | `taskId, added[], removed[]` |
| `task.decomposed` | anak ditambahkan | `taskId (induk), childIds[]` |
| `task.retried` | `failed -> retrying` | `taskId, attemptNo` |
| `task.reopened` | `completed -> in_progress` | `taskId, reason` |

### Verification & evidence

| Event | Kapan | Field tambahan |
|---|---|---|
| `task.verification_recorded` | verify jalan | `taskId, verdict, command?, detail?` |
| `task.evidence_attached` | bukti ditautkan | `taskId, evidence: TaskEvidenceRef` |
| `task.reconciled` | rekonsiliasi pasca-verify | `taskId, from, to, verdict, causedByEventSeq` |

### Human

| Event | Kapan | Field tambahan |
|---|---|---|
| `task.cancelled` | pembatalan | `taskId, by, reason?` |

## Event yang perlu Durable?

Semua task event: `durable: true, replayable: true`. Alasannya: status task
adalah state, bukan streaming. Tidak ada task event yang seperti
`model.delta` - yang live-only.

## Reducer

PresentationState sudah punya plans: Map<string, PlanEntry>.
Dengan `task_id` stabil, `PlanEntry` menjadi:

```ts
{ kind: "plan", taskId, status, steps }   // plans di-key by taskId, bukan planId
```

`plan.updated` tetap diterbitkan untuk konsumen machine (ACP, `exec --json`),
tapi kini **keyed by `taskId`**, bukan `plan:<session>:<turn>`. Akibatnya plan
berkembang: satu entri per task yang bisa di-replay, bukan N fragmen per turn.

Reducer harus menolak event dengan `supersedes` yang refers ke event yang
sudah tidak berlaku - jadi urutan replay stabil.

## Rekonstruksi

`rebuildFromDurable` saat ini sudah menyaring `DURABILITY[event.type]?.durable`
dan mengurutkan `eventSeq`. Task state dapat dibangun dengan aturan sama:

```
1. main events (semua task.*) -> sort by eventSeq
2. terapkan sesuai tipe
3. lewati event yang di-supersede
```

Aturan ini harus diuji: log yang sama harus menghasilkan TaskState yang sama
dengan `loadTodoStore` langsung. Kalau tidak, persistent dan observed akan
berpisah - persis kelas bug yang sudah diperbaiki di PF-02.

## Event historis

**Tidak ada event lama yang dibuang.** `plan.updated` yang sudah terbit dengan
`planId` per-turn tetap bisa dibaca. Reducer harus bisa menangani keduanya:
  - `planId` per-turn (lama) → dipetakan ke task lewat `stepId` yang lama
  (yaitu indeks posisi), sehingga tidak bisa dipetakan dengan benar, jadi
  **diabaikan untuk rekonstruksi TaskState**.
- Task event baru (dengan `taskId`) → sumber TaskState.

Artinya: TaskState yang direplay dari log **mulai berlaku sejak task events
pertama**, dan sebelum itu state diambil dari `loadTodoStore`. Ini bukan
pembersihan - log lama tetap utuh dan bisa diaudit.

## Yang tidakMoved

| Field | Status |
|---|---|
| `eventSeq` | dipakai |
| `ts` | dipakai |
| `sessionId`, `turnId` | dipakai |
| `actor` | BARU |
| `correlationId` | BARU |
| `supersedes` | BARU |
| `parentLink` (sub-agent) | dipertahankan; task dari sub-agent tidak terjadi karena `todo_write` di-strip dari anak |

## Yang harus dibuktikan sebelum dianggap benar

1. Log task yang sama menghasilkan TaskState yang sama dengan `loadTodoStore`
   (property replay).
2. Event dengan `supersedes` diabaikan saat rekonstruksi.
3. Event yang tidak durable tidak pernah muncul di TaskState.
4. `task.status_changed` yang tidak valid ditolak **dan** tidak merusak state
   saat rekonstruksi (replay resilience: satu event rusak tidak boleh
   membatalkan seluruh log).
5. `plan.updated` versi lama masih terbaca tanpa error.
6. Mutation test: `supersedes` diabaikan di reducer → test harus merah.
