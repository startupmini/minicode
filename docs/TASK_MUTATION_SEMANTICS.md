# Task Mutation / Merge Semantics

Mode DESIGN. Companion dari `CANONICAL_TASK_MODEL_DESIGN.md`.

## Masalah yang harus diselesaikan

`todo_write` saat ini adalah **blind full-replace**
(`src/tools/todo.ts`):

```ts
await saveTodos(todoSession.id, list, cwd)   // tulis seluruh daftar
```

Konsekuensi yang sudah tercatat di audit (`TASK-012`, P2): bila model
mengirim daftar yang tidak memuat suatu task, task itu **hilang dari keempat
store tanpa jejak**. Tidak ada merge, tidak ada diff, tidak ada tombstone,
tidak ada event. Model bisa diam-diam dropping requirement tanpa ada yang
pernah mengetahuinya.

Skill ini menyebutnya anti-pattern *"Hidden plan mutation"*, dan
`INV-004` (user requirements authoritative) mensyaratkan dekomposisi agent
tak boleh diam-diam menghapus requirement.

## Bentuk API yang dipertimbangkan

| Opsi | Deskripsi | Masalah |
|---|---|---|
| **A. `replace`** (status quo) | Daftar yang dikirim = daftar yang ada | Task hilang diam-diam; tidak ada identitas |
| **B. `patch`** | Model mengirim hanya perubahan | Model saat ini mengirim full list; butuh perubahan perilaku model yang besar dan tidak terbukti akan berhasil |
| **C. `upsert` by id** | Model mengirim `id` | Butuh model mengingat id setelah context rotation; tidak selalu bisa |
| **D. perintah eksplisit** (`task_create`, `task_done`, ...) | Satu operasi per aksi | Terlalu banyak round-trip; `todo_write` ada justru untuk itu |
| **E. Declarative upsert (desain ini)** | Daftar dikirim = *active set*; yang hilang **tidak dihapus**, penghapusan eksplisit | Perlu perubahan perilaku yang nyata (lihat §Perubahan perilakuyang dihasilkan) |

### Keputusan: E - declarative upsert

Model mengirim daftar yang dia yakini sebagai **kondisi yang dia inginkan**.
Sistem memperlakukannya sebagai *deklarasi*, bukan *perintah replace*.

Tiga aturan yang membuatnya bekerja:

1. **Item yang tidak lagi muncul tidak dihapus.** Task hanyaLeave the active
   set kalau model menandainya `cancelled`.
2. **Item dicocokkan** dengan `id` kalau ada; kalau tidak, dengan
   `titleKey`; kalau tetap tidak, task baru dibuat.
3. **Duplikat `id` dalam satu pengiriman ditolak seluruhnya** (bukan
   applied sebagian) - partial apply lebih buruk daripada error.

## Bentuk kiriman yang harus ditangani

### 1. Full task list (kasus paling umum hari ini)

```
[{ content: "A", status: "completed" }, { content: "B", status: "in_progress" }]
```

- Setiap item dicocokkan: tidak ada `id`, tidak ada yang cocok `titleKey` →
  keduanya **task baru** (`t1`, `t2`).
- Item yang sebelumnya ada tapi tidak muncul → **dipertahankan** (tidak
  dihapus).
- Perilaku berubah: `order` dihitung ulang mengikuti urutanKiriman.

### 2. Partial task list (model sedang fokus)

```
[{ content: "B", status: "completed" }]
```

- `B` dicocokkan dengan `titleKey` → task yang sudah ada, di-update.
- `A` **dipertahankan**. Tidak ada penghapusan diam-diam.
- Jika `A` sebelumnya `in_progress` dan `B` menjadi `completed`, `A` tetap
  `in_progress` - sistem **tidak** memindahkan fokus secara otomatis. Exactly
  one `in_progress` masih jadi invarian (dari `normalizeTodos` sekarang).

### 3. Update satu task

```
[{ id: "t3", status: "verifying" }]
```

- `id` adalah kunci tunggal. `title` tidak wajib ada; bila ada dan berbeda,
  `titleKey` di-rehash dan key lama disimpan di `titleKeys`.
- Task lain tidak tersentuh.

### 4. Task baru yang ditemukan

```
[{ content: "Migrasi schema DB", status: "pending", parentId: "t2" }]
```

- Tidak ada `id` → dicocokkan ke `titleKey`; tidak cocok → task baru.
- Bila `parentId` diisi, sistemНОвит `source: "discovery"` dan
  `provenance.reason` diisi dari argumen opsional `reason`.
- `parentId` yang tidak ada → **ditolak**, bukan diam-diam mengabaikan
  (mencegah subtask yatim).

### 5. Reordered tasks

```
[{ id: "t2", ... }, { id: "t1", ... }]
```

- `id` menentukan identitas; urutanKiriman hanya mengubah `order`.
- `task_id` tidak berubah. Inilah alasan `order` ada terpisah dari identitas.

### 6. Missing task

```
model mengirim 2 dari 3 task
```

- Task yang hilang **dipertahankan**. Tidak ada penghapusan.
- **Perubahan perilaku yang harus disetujui** (lihat §15 REQUIRED): sebelum
  ini, task hilang akan terhapus.

### 7. Duplicate `task_id`

```
[{ id: "t1", content: "A" }, { id: "t1", content: "B" }]
```

- **Seluruh pengiriman ditolak** dengan pesan yang menyebut `t1` muncul dua
  kali.
- Alasan: partial apply menyisakan state yang tidak konsisten dengan
keystroke yang dimaksud, dan ini sulit didiagnosis nanti.

### 8. Unknown `id`

```
[{ id: "t999", status: "completed" }]
```

- **Ditolak** dengan pesan yang menyebutkan id tersebut tidak dikenal di
  sesi ini.
- Fungsi-fungsi ini adalah conjugate dengan model yang mengarang id;
  menerima id asing akan memungkinkan model "membuat" task yang tidak pernah
ada, dan memungkinkan dependency menunjuk entitas fiktif.

## Match rules (detail)

Untuk setiap item yang masuk (urutanuthentic):

```
1. item.id ada?
   ya -> id dikenal di store?  ya: update task itu
                          tidak: TOLAK (unknown id)
   tidak -> lanjut

2. normalisasi item.title -> key
   key cocok dengan titleKeys (including key historis) dari task yang
   belum terminal?
   ya -> update task itu (dan kunci key baru ke titleKeys)
   tidak -> lanjut

3. tidak ada yang cocok -> buat task baru dengan id baru
```

**"Belum terminal"** = status di luar `{completed, cancelled}`. Task yang
sudah `completed` tidak akan di-reclaim oleh item dengan judul sama - kalau
model ingin mengerjakan ulang, itu `reopen` (`completed -> in_progress`),
bukan penamaan ulang.

**Judul duplikat dalam satu sesi:** dua task aktif dengan `titleKey` sama
adalah kondisi yang sah. Match selalu mengambil kandidat dengan `updatedAt`
terkecil yang belum terpakai dalam pengiriman ini, supaya item pertama
mengclaimer task yang paling lama (deterministik).

## Bentuk yang NON-acceptable

- Menerima `id` yang tidak dikenal: menutup jalan bagi dependency ke entitas
  fiktif.
- Menghapus task yang hilang: melanggar INV-004.
- Partial apply pada pengiriman invalid: state tidak bisa direkonstruksi.
- Menulis order sebagai identitas: jebakan yang harus dihindari.

## Perubahan perilaku yang dihasilkan

Harus disetujui manusia sebelum implementasi:

| # | Perubahan | Dampak |
|---|---|---|
| 1 | Task yang hilang dari daftar **tidak dihapus** | Daftar bisa menumpuk. Model harus `cancelled` untuk membersihkan |
| 2 | Task `completed` tidak bisa di-reclaim lewat judul | Memaksa `reopen` eksplisit. Lebih Aman, tapi satu langkah tambahan |
| 3 | Pengiriman invalid menolak **seluruh** daftar | Model harus memperbaiki lalu mengirim ulang. Lebih banyak round-trip pada kesalahan |
| 4 | `id` masuk ke schema tool | `additionalProperties: false` sekarang forbid; perlu diperluas |

Nomor 4 khususnya: `todo_write` saat ini punya
`additionalProperties: false` dengan hanya `content` dan `status`. Menambahkan
`id`, `parentId`, `dependsOn`, `reason` berarti mengubah schema yang dilihat
model. Ini keputusan sendiri, terpisah dari semantik merge.

## Apakah `patch` juga perlu?

**Tidak di v1.** Setelah `id` tersedia, menambah mode `patch` (hanya kirim
perubahan) adalah 도로 tambahan tanpa konsumen yang terbukti. Yang perlu
adalah `todo_write` (deklarasi) plus perintah explicit nanti untuk aksi
non-deklaratif seperti `reopen` dan `cancel`.

## Yang harus dibuktikan sebelum dianggap benar

1. Tujuh bentuk kiriman (1-7) + unknown id: hasil deterministik.
2. Reorder 50 item: `task_id` stabil, hanya `order` berubah.
3. Task yang hilang: **tidak** terhapus dari store maupun event log.
4. Duplikat `id`: seluruh pengiriman ditolak, store tidak berubah.
5. Unknown `id`: ditolak, store tidak berubah.
6. Match by `titleKeys` historis: task yang judulnya diubah masih
   ter-attach.
7. Dua task dengan judul identik: tetap dua task, match deterministik.
8. Mutation test: ganti aturan "hapus yang hilang" kembali menjadi delete
  test harus merah. Ini mencegah regresi ke perilaku lama.
9. Mutation test: `titleKey` match dimatikan → test re-attach harus merah.
