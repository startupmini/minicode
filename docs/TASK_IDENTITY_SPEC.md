# Task Identity Spec

Mode DESIGN. Companion dari `CANONICAL_TASK_MODEL_DESIGN.md`.

## Masalah yang harus diselesaikan

Model task sekarang tidak punya identitas. `TodoItem` =
`{content, status, blockedReason}`; satu-satunya "identitas" adalah posisi
dalam array. Bukti di `src/presentation/adapter.ts`: `stepId: String(i + 1)`
dihitung dari indeks argumen model, dan berubah begitu daftar disisipkan di
tengah. Akibatnya `stepId` tidak bisa dipakai untuk:

- mengaitkan satu task yang sama di dua `plan.updated`
- menyatakan dependency (`T3 depends_on T1`)
- mencatat percobaan ulang (retry) sebagai task yang sama
- Goals yang harus bertahan setelah context rotation

## Persyaratan yang harus dipenuhi `task_id`

| # | Persyaratan | Kenapa |
|---|---|---|
| R1 | Bertahan saat **retry** | Percobaan ulang bukan task baru (INV-011) |
| R2 | Bertahan saat **turn baru** | Turn bukan identitas |
| R3 | Bertahan saat **process restart** | State durable, bukan state proses |
| R4 | Bertahan saat **context rotation** | Working memory boleh hilang, task tidak |
| R5 | Bertahan saat **reorder** | Urutan tampilan bukan identitas |
| R6 | Bertahan saat **decomposition** | Induk dan anak punya identitas sendiri |
| R7 | **Berbeda** dari display index / step number | `order` adalah presentasi |

## Keputusan: `task_id`

**Bentuk:** `t<n>` di dalam satu sesi, dengan `<n>` monotonik mulai dari 1.

Contoh: `t1`, `t2`, `t17`.

**Alasan bentuk ini (bukan UUID, bukan content-hash):**

1. **Tanpa collision.** Counter per sesi dijamin unik selama tidak ada dua
   writer bersamaan. Ini yang paling sulit dibuktikan dari hash.
2. **Murah.** Prefix sudah terfilter `sanitizeTodoId` di
   `src/tools/todo.ts` (huruf, angka, `.`, `_`, `-`; maks 64 char), jadi
   `t17` aman sebagai nama file bila TaskStore berbasis file.
3. **Bisa diurutkan.** urutan pembuatan = urutan id, berguna saat rekonstruksi.
4. **Restart-safe tanpa state tambahan.** `nextId = max(id) + 1` dihitung saat
   memuat store. Tidak perlu counter terpisah yang bisa tidak sinkron.
5. **Contoh yang sudah ada di repo.** `childId = sub_${randomUUID().slice(0, 8)}`
   (`src/tools/task.ts`) memakai pola "prefix + suffix" yang sama; `checkpointId`,
   `journalSeq`, `eventSeq` juga id yangVqeta dipelihara repo.

**Kenapa bukan UUID?** UUID memberi toleransi tabrakan, tapi tidak sortable, dan
biaya 36 char per task. Dengan TODO_MAX_ITEMS 50, daftar berisi paling banyak
sesi; `t17` jauh lebih ringkas dan lebih mudah dibaca manusia saat debugging.

**Kenapa bukan content-hash sebagai id?** Karena hash ikut berubah saat judul
diubah. Model * routinely me-rename task (menyempurnakan judulnya), dan itu
tidak boleh memecahkan identitas. Lihat `titleKey` di bawah.

## Keputusan: `titleKey`

**Bentuk:** `k<8 hex>` = 4 byte pertama dari `sha256(normalize(title))`,
dengan prefix `sessionTaskKey` agar tidak bentrok dengan nama file.

Normalisasi: `title.trim().toLowerCase()`, whitespace berulang dirapatkan jadi
satu, maksimal 200 char (mengikuti `LIMITS.TODO_CONTENT_MAX_CHARS`).

**Fungsinya hanya satu: re-attach.**

Skenario yang memaksakan adanya `titleKey`:

1. Turn 1: model menulis task "Refactor modul auth" → `t1`,
   `titleKey = k3f2a91bc`.
2. Context compaction terjadi. Ringkasan mungkin tidak membawa `t1`.
3. Turn 2: model menulis ulang "Refactor modul auth" **tanpa id**, karena ia
   tidak ingat pernah punya id.
4. Tanpa `titleKey`, sistem akan membuat `t2` — task duplikat, dan `t1`
   menggantung selamanya.
5. Dengan `titleKey`, sistem mencocokkan ke `t1` dan **memperbarui** task
   itu, bukan membuat yang baru.

**Batas `titleKey` yang harus diakui:**

- Kalau model **mengubah judul**, `titleKey` berubah, dan re-attach gagal →
  task duplikat. Untuk mengurangi ini, TaskStore menyimpan
  `titleKeys: string[]` (key lama dikunci, bukan diganti), sehingga perubahan
  judul tetap bisa dicocokkan sampai key ke-2.
- Dua task dengan judul identik di sesi yang sama: keduanya memakai
  `titleKey` yang sama. Match Rules harus pakai key **terbesar yang belum
  dipakai** (lihat `TASK_MUTATION_SEMANTICS.md` §match).

**Kenapa tidak menyimpan `titleKey` lama selamanya?** unbounded. Dua key per
task sudah cukup untuk kasus umum (kRgambar judul, lalu ketik ulang).

## Match order (preview; detail di `TASK_MUTATION_SEMANTICS.md`)

Ketika model mengirim item tanpa `id`:

```
1. cocok titleKey (termasuk titleKeys historis)  -> task yang sudah ada
2. tidak cocok                                  -> task baru, id baru
```

Ketika model mengirim item **dengan** `id`: `id` adalah satu-satunya kunci.
Judul yang berbeda tidak memengaruhi identitas.

## Yang bukan identitas

| Field | Kenapa bukan identitas |
|---|---|
| `order` | Urutan tampilan. Berubah saat reorder; `stepId` sekarang salah karena memakainya sebagai identitas |
| `stepId` di `plan.updated` | constitutionally projection, berubah tiap turn (`plan:<session>:<turn>`) |
| `eventSeq` | Urutan event dalam satu log, bukan identitas task |
| `titleKey` | Berubah saat judul berubah; hanya petunjuk |
| posisi array | Berubah saat reorder |

## Dampak pada `plan.updated`

`PlanStep.stepId` sekarang harus **diisi `task_id`, bukan indeks**:

```ts
// sebelum
steps.push({ stepId: String(index + 1), title, status })
// sesudah
steps.push({ stepId: task.id, title: task.title, status: mapStatus(task.status) })
```

Konsekuensi yang harus disadari:

- ACP dan `exec --json` yang meneruskan `steps` apa adanya akan melihat
  perubahan bentuk `stepId` dari `"1"` menjadi `"t1"`. Ini perubahan kontrak
  machine-output yang **tidak** boleh adhered tanpa persetujuan manusia
  (§15 REQUIRED).
- Klien yang menyusun `stepId` sendiri perlu tahu bahwa ia kini stabil.

## Migrasi field legacy

Saat membaca `.minicode/todos/<id>.json` versi lama:

- field `content` → `title`
- field `status` → `status` (dengan mapping `blocked` tetap `blocked`)
- field `blockedReason` → `blocker.reason`
- `task_id` dibuat dari posisi (1..n), `titleKey` dihitung
- `source` = `LEGACY`, `provenance.actor` = `system`

Tidak ada data yang hilang, karena field legacy hanya tiga. Rincian di
`CANONICAL_TASK_MODEL_DESIGN.md` §G.

## Yang harus dibuktikan sebelum dianggap benar

1. Urutan 50 item, reorder di tengah: `task_id` tidak berubah.
2. Process restart: `nextId` dilanjutkan, tidak mulai dari 1.
3. Duplikasi judul di satu sesi: dua task tetap punya id berbeda.
4. Re-attach setelah judul diubah: `titleKeys` historis masih cocok.
5. `t<n>` diuji terhadap `sanitizeTodoId` (aman sebagai nama file).
6. Mutation test: `stepId` kembali ke indeks → test harus merah.
