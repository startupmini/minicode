# Autonomous Scheduler (eksperimental)

> **Eksperimental.** Opt-in per invokasi, nonaktif secara bawaan, dan dipicu manual.
> Tidak ada timer latar (no background timer). Tidak ada yang berjalan kecuali Anda memintanya.

Scheduler mengevaluasi task graph Anda dan, bila ada task yang siap, menyerahkannya
ke sesi MiniCode otonom yang mengerjakannya tanpa Anda.

## 1. Aktifkan

Tambahkan flag ke sembarang invokasi:

```bash
minicode --enable-scheduler
```

Itu satu-satunya cara menyalakannya. Tidak ada kunci config, tidak ada variabel
environment, dan tidak ada cara mewarisinya dari proses induk — flag yang diketik
di baris perintah adalah satu-satunya mekanismenya. `--enable-scheduler=false`
**tidak** mengaktifkannya; flag tidak punya bentuk nilai, dan bare flag adalah
satu-satunya bentuk yang dihitung.

Saat startup dengan flag, proses mengakuisisi lease eksklusif pada sesi Anda.
Bila proses lain sudah memegang lease itu, startup gagal dengan jelas alih-alih
menjalankan scheduler kedua di atas sesi yang sama.

## 2. Picu

Penjadwalan bersifat **manual**. Tidak ada yang berjalan sendiri:

```text
/scheduler run
```

Ini menjalankan tepat satu siklus penjadwalan:

- baca ulang task graph,
- pilih satu task yang siap (bila ada),
- klaim secara durable,
- jalankan satu turn otonom di atasnya,
- laporkan hasilnya.

Bila tidak ada yang siap, siklus berakhir dengan `no task was ready` dan tidak ada
pekerjaan yang dibuat. Jika sebuah task menjadi siap *setelah* itu, ia tetap
pending sampai Anda menjalankan `/scheduler run` lagi. Tidak ada polling, tidak
ada timer, dan tidak ada perulangan latar — ini kontrak saat ini, bukan kelalaian.

Perintah menunggu siklus selesai, lalu mencetak hasilnya.

## 3. Amati

```text
/scheduler status
```

Melaporkan state saat ini, sesi yang dimilikinya, apakah lease dipegang, counter
untuk proses ini, dan lima event lifecycle terakhir.

Anda akan melihat satu dari lima state:

| State | Artinya |
| --- | --- |
| `scheduler OFF` | Flag tidak diberikan. Tidak ada scheduler. |
| `scheduler ON, idle` | Aktif, memegang lease, menunggu `/scheduler run`. |
| `scheduler ON, executing` | Sebuah siklus sedang berjalan. |
| `scheduler ON but STOPPED` | Dihentikan, dimatikan, atau lease-nya hilang. Tidak akan menjadwalkan lagi di proses ini. |
| `scheduler ON, last cycle failed` | Siklus gagal. Alasannya ada di baris berikutnya. |

Event lifecycle juga muncul inline di transkrip sebagai baris `[scheduler] ...`.
Itu entri sistem, bukan percakapan — tidak pernah dikirim ke model dan tidak
pernah muncul sebagai output tool.

Aktivitas bersifat in-memory dan reset saat proses keluar. State task yang
durable bertahan; diagnostik tidak.

## 4. Hentikan

```text
/scheduler stop
```

Ini mencegah trigger berikutnya, mencegah klaim baru, membatalkan turn otonom
yang masih berjalan, dan melepas lease sesi agar proses lain bisa mengambilnya.

Menghentikan dua kali tidak masalah — panggilan kedua menyatakannya dan tidak
melakukan apa-apa.

Sekali dihentikan, scheduler tidak bisa di-start ulang. **Keluar dan mulai proses
baru** dengan flag untuk menjadwalkan lagi. Tidak ada toggle in-app karena alasan
yang sama `/scheduler stop` satu arah: menghentikan turn yang berjalan adalah
shutdown, bukan pengaturan.

## 5. Pulihkan

Bila sebuah proses mati sambil memegang lease, lease tidak dilepas. Penggantinya
cukup menunggu:

- durasi lease 5 menit
- diperbarui tiap menit selama proses hidup

Jadi scheduler yang crash membebaskan sesinya otomatis dalam 5 menit. Untuk
memulihkan segera, hapus sesinya (`/sessions`), yang membatalkannya langsung.

Bila lease hilang saat berjalan (proses lain mengambil alih, atau sesi dihapus),
scheduler **self-dispose**. Ia tidak akan mengklaim atau mengeksekusi apa pun
lagi, dan alasannya muncul di `/scheduler status`. Ini disengaja: scheduler yang
tidak bisa membuktikan kepemilikan sesi lebih baik tidak berbuat apa-apa daripada
balapan dengan proses yang bisa.

## 6. Nonaktifkan

Tidak ada yang perlu dimatikan. Hapus flag dan proses berikutnya tidak punya
scheduler sama sekali — tanpa lease, tanpa store handle, tanpa resource latar.
Menghentikan yang sedang berjalan: `/scheduler stop`, atau cukup keluar.

## Yang boleh dilakukan sesi otonom

Turn otonom berjalan di bawah kebijakan **read-only**. Set tool adalah allow-list
tetap berisi kapabilitas read-only — baca file, search, inspeksi git, query LSP.
Tulis, edit, eksekusi, dan apa pun yang mengambil network ditolak, dan tidak ada
yang bisa memperlebar di jalur trigger: allow-list ditegakkan saat executor
dibangun, sehingga konfigurasi yang mencoba memperlebar gagal di startup alih-alih
berjalan dengan lebih banyak kekuatan.

Turn otonom tidak meminta persetujuan. Tidak ada operator di loop, itulah sebabnya
kebijakannya sempit, bukan permisif.

## Batasan

- Satu siklus per `/scheduler run`; tanpa penjadwalan berulang.
- Tanpa langkah persetujuan antara klaim dan eksekusi. Kebijakan readonly adalah
  batasnya.
- Diagnostik per-proses dan hilang saat keluar.
- Dua proses tidak bisa menjadwalkan sesi yang sama sekaligus; yang kedua gagal
  tertutup.
- Eksperimental. Antarmukanya bisa berubah.

## Terkait

- [CLI](cli.md) — referensi lengkap flag.
- [Arsitektur](architecture.md) — di mana scheduler berada.
- [Open Work](P14_OPEN_WORK.md) — pekerjaan lintas sesi yang diteruskan scheduler.