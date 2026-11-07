# MiniCode Electron Dogfooding Report

Tanggal: 2026-11-06 (Asia/Jakarta)
Fixture: MiniChat, aplikasi Electron yang dibuat bertahap oleh MiniCode
Scope: menilai perilaku MiniCode ketika membuat aplikasi; bukan menyelesaikan MiniChat.

## Kesimpulan singkat

MiniChat sudah memberi cakupan dogfood yang cukup untuk berpindah dari pembuatan fitur ke perbaikan MiniCode. Saya tidak mengubah source MiniChat. Hasil akhirnya tetap diperlakukan sebagai fixture tidak lengkap: tes dan build lulus, tetapi tombol Settings yang diminta tidak bekerja saat diuji di runtime.

Temuan ini menunjukkan celah pada cara MiniCode memvalidasi task UI generatif. Lulusnya build dan 83/83 test fixture tidak membuktikan bahwa kontrol interaktif utama bisa dipakai. Finding stabilnya adalah AUDIT-DOGFOOD-UI-001 pada MINICODE_FULL_SYSTEM_DOGFOODING_AND_REMEDIATION_REPORT.md.

## Batas dan arsitektur fixture

Peta jalur yang diamati:

    Renderer UI
      → preload bridge
        → IPC
          → Electron main process
            → provider adapter / mock provider
            → persistence lokal dengan user-data-dir
      Stream response
        → renderer state
          → Markdown rendering / code highlighting / copy interaction

Peta ini merangkum komponen yang menjadi target tahap dogfood. Tidak semua jalur vendor/provider diuji secara independen. MiniChat tidak menjadi bagian dari arsitektur atau deliverable produk MiniCode.

## Hasil dogfooding runtime

### Generation dan iterasi

MiniCode membangun fixture dalam beberapa tahap. Tahapan mencakup alur streaming, terminal/session ownership, persistence queue/hydration, parser Markdown, highlighting, dan copy IPC. Beberapa sesi berhenti karena timeout atau max_steps dan task dilanjutkan melalui replay. Detail session ID dan metrik token disimpan pada laporan dogfood gabungan.

Pada tahap akhir, test MiniChat melaporkan 83/83 pass dan build berhasil. Test fixture sempat gagal karena fixture fenced-code test salah; setelah diperbaiki, suite kembali lulus. Bukti ini memverifikasi kontrak yang ada pada test, bukan seluruh behavior UI.

### Settings interaction

- Settings button terlihat pada renderer.
- Elemen button tidak memiliki handler yang membuka Settings.
- Markup dialog tersembunyi tidak memiliki styling yang membuat dialog dapat ditampilkan.
- Klik button saat UAT tidak menghasilkan interaksi.
- Hasil ini tetap dicatat sebagai defect hasil generator MiniCode; saya tidak menambahkan handler atau CSS ke MiniChat.

Acceptance yang terlewat oleh proses MiniCode adalah interaksi button → dialog terbuka → pengguna dapat mengubah/menyimpan nilai → dialog dapat ditutup. Test/build yang ada tidak mencakup jalur itu.

### Persistence

Persistence lokal diuji menggunakan user-data-dir eksplisit: percakapan dibuat, aplikasi ditutup, lalu dibuka kembali dan state percakapan dipulihkan.

UAT persistence tersebut terjadi saat temporary manual Settings repair masih berada pada working copy fixture. Perubahan sementara itu tidak menyentuh jalur persistence. Setelahnya, repair Settings dihapus dan fixture kembali pada hasil generator. Karena itu persistence UAT menjadi bukti yang terbatas pada penyimpanan/pemulihan percakapan dan tidak menutup defect Settings.

Percobaan awal yang hanya mengatur APPDATA adalah kesalahan setup harness. UAT yang berhasil memakai parameter user-data-dir eksplisit. Percobaan APPDATA itu tidak dicatat sebagai defect MiniCode.

## Finding dan evidence

### AUDIT-DOGFOOD-UI-001 — P2/MEDIUM — OPEN

- Invariant: untuk task UI yang meminta behavior interaktif, indikator selesai harus didukung oleh bukti bahwa kontrol utama bisa dioperasikan.
- Lokasi yang diamati: generated MiniChat renderer, src/renderer/app.js pada checkpoint Stage 7.
- Reproducer: jalankan hasil generated app dan klik Settings. Button tampil, tetapi tidak membuka dialog; markup dialog juga tidak memiliki styling tampilan.
- Bukti yang berlawanan/terbatas: 83/83 test fixture lulus dan build berhasil, tetapi keduanya tidak mengeksekusi interaksi Settings.
- Impact pada penggunaan MiniCode: MiniCode dapat menghasilkan dan menganggap UI siap berdasarkan test/build meskipun kontrol yang diminta no-op.
- Evidence status: defect UI teramati; atribusi sebagai gap validasi MiniCode kuat, sedangkan mekanisme root-cause model tidak bisa dibuktikan dari hasil tunggal.
- Missing tests: Electron smoke test untuk click/open/edit/save/close; trace acceptance scenario yang dapat dibandingkan dengan permintaan awal.
- Acceptance criteria untuk MiniCode: hasil UI dinyatakan terverifikasi hanya setelah smoke interaction memenuhi acceptance behavior atau laporan menyatakan runtime UAT belum dijalankan.
- Dependency: prompt task → model menghasilkan markup/script/style → test yang dibuat → build → runtime UAT.
- Residual risk: generator tidak dapat otomatis mengetahui semua behavior yang dimaksud bila permintaan tidak diubah menjadi acceptance scenario yang dapat diuji.

### Provider attribution — AUDIT-DOGFOOD-PROVIDER-001 — P2/MEDIUM — UNVERIFIED

Request dogfood memilih deepseek-v4.1-flash-1017 melalui TipRouter, sedangkan metadata response mencatat ali/deepseek-v4-pro-0813. Ini tidak cukup untuk menyalahkan MiniCode: router dapat melakukan alias atau mapping. Tanpa identitas wire/vendor yang dapat diverifikasi, hasil kualitas model dan biaya tidak bisa diatribusikan secara pasti.

## Rangkuman tahap MiniCode

| Tahap | Sinyal utama | Relevansi bagi MiniCode |
|---|---|---|
| 1 | Berhasil menghasilkan proyek; beberapa tool gagal/ditolak; 515.190 token | Baseline keberhasilan tidak menutup kualitas acceptance |
| 2–3 | Timeout, tool failure dan denial; default context window 128k | Task recovery dan context behavior memengaruhi kelanjutan task |
| 4 | False cutoff setelah token lintas request terakumulasi | Menemukan dan memicu perbaikan AUDIT-FS-CTX-001 |
| 5 | Satu generation berhasil setelah beberapa percobaan; 1.508.476 token kumulatif | Biaya/ketekunan tinggi; hasil tetap perlu runtime acceptance |
| 6 | max_steps; fokus stream lifecycle, save queue, hydration | Menguji behavior runtime yang lebih dalam daripada build |
| 7 | max_steps/replay; Markdown, highlight, copy IPC; 83/83 tests akhir | Test pass gagal mendeteksi tombol Settings no-op |

Max_steps dan timeout tidak otomatis diklasifikasikan sebagai defect runtime. Hasil dipengaruhi gabungan task scope, provider planning, retry, dan runtime MiniCode. Bukti saat ini cukup untuk menyatakan dogfood mahal dan sebagian tahap membutuhkan replay, tetapi belum cukup untuk mengisolasi akar sebab.

## Keputusan scope

- MiniChat tidak dilanjutkan sampai selesai.
- Source MiniChat tidak diubah untuk memperbaiki Settings.
- Temuan Settings dicatat sebagai evidence terhadap proses MiniCode dalam menghasilkan dan memvalidasi aplikasi.
- Pekerjaan berikutnya tetap pada MiniCode: checkpoint/undo scale, runtime acceptance behavior, diagnostik retry/stop reason, serta provider attribution.
- Dogfood MiniChat dinilai cukup sebagai fixture untuk menemukan gap tersebut; full-system audit MiniCode tetap belum selesai karena risiko pada laporan gabungan masih terbuka.
