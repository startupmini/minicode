# TUI — Slash & Keyboard (satu tampilan fullscreen)

Ketik `/` di prompt → dropdown polos (tanpa bingkai; `max 8` baris, daftar panjang dipotong tanpa baris `… N more` — baris itu hanya ada di `askLine`/dialog linear). `↑`/`↓`
navigasi, `Enter` lengkapi + submit, `Esc` tutup. Semua permukaan interaktif
hidup di dalam TUI fullscreen; terminal tanpa ANSI/alt-screen = pesan satu
baris + keluar (interaktif butuh TTY ≥10 baris).

Bahasa UI: `/lang` (sesi, tersimpan state.json) > `MINICODE_LANG` > state.json `lang` >
locale OS > en. `/lang` tanpa argumen = tampilkan aktif. Semua string lewat kamus i18n
(`src/ui/i18n/`); literal Indonesia hardcode di luar kamus dilarang test.

## Slash commands

| Command | Fungsi |
|---|---|
| `/help` | Daftar perintah ringkas, terkelompok per kategori (Session/Model/Mode/View/Task) |
| `/help full` | Daftar lengkap terkelompok dengan deskripsi (alias `/help all`); `/help` kosong dari non-TTY juga menampilkan ini |
| `/help keys` | Pintasan papan tombol lengkap (alias `/help tombol`) |
| `/provider` | Kelola provider: popup — picker preset + form (URL/key/scope/timpa), hapus (`d`, menyebut jumlah model yang ikut hilang), ubah (`e`) |
| `/model [cari]` | Popup semua `provider::model` (argumen = filter awal; di dalam ketik langsung cari live, Ctrl+U clear, Esc keluar filter). Del = hapus (konfirmasi). Enter = pilih + atur thinking effort (`default/low/medium/high`, tersimpan di provider, berlaku sesi berikutnya; Esc = batal total). Effort non-default tampil badge `[low|medium|high]` |
| `/sync` | Segarkan daftar model semua provider (hanya bilang restart bila benar ada model baru) |
| `/undo` | Batalkan perubahan berkas turn terakhir |
| `/redo` | Terapkan ulang yang dibatalkan |
| `/sessions` | Tanpa argumen = popup picker resume; `/sessions <id>` = langsung resume |
| `/status` | Runtime + pemakaian & biaya **kumulatif sesi** |
| `/mode [AUTO\|ASK]` | Ganti pengawasan persetujuan; tanpa argumen = toggle AUTO/ASK |
| `/work-mode [DISCUSS\|PLAN\|BUILD]` | WorkMode membatasi cara agent bekerja. `DISCUSS` read-only, `PLAN` memakai ceiling rencana, `BUILD` tidak menambah ceiling (identitas internal `EXECUTE`). Tanpa argumen = tampilkan mode aktif + usage; nilai invalid ditolak dan mode aktif tidak berubah. Tab dan `/work-mode` mengubah WorkMode; Shift+Tab dan `/mode` mengubah PermissionMode. |
| `/lang [en|id]` | Bahasa UI; tanpa argumen = tampilkan aktif |
| `/init` | Buat `AGENTS.md` proyek ini |
| `/copy [n]` | Salin `n` turn terakhir (default `1`, maksimal `10`) via OSC 52 |
| `/clear` | Kosongkan transkrip (viewport kembali kosong) |
| `/expand` | Buka isi tool/thinking yang disembunyikan ledger compact (sekali ambil habis) |
| `/history` | 20 entri prompt terakhir |
| `/exit` | Keluar (satu-satunya jalan keluar; `/quit` alias). Setelah keluar, tercetak kop ringkasan sesi: wordmark `minicode` + Session/Model/Usage (token, biaya, durasi) |
| `/scheduler [status\|run\|stop]` | Kendali Scheduler produksi. **Nonaktif secara bawaan** di setiap sesi (perlu flag `--enable-scheduler`); tanpa flag, perintahnya menjawab "not enabled". Tetap tampil di `/help` supaya operator yang mengaktifkan flag bisa menemukannya. |

Alias (jalan, tidak diiklankan di `/help`): `/models` → `/model`, `/providers` → `/provider`, `/usage` & `/cost` → `/status`, `/resume [id]` → `/sessions [id]`, `/compact`, `/thinking`, `/minimize`, `/quit`.

Perintah tersembunyi (sengaja tak tampil di `/help`/dropdown, per-sesi): `/unrestric` — jembatan jail luar workspace + bash-guard + allowlist dibuka, kredensial git sempit diteruskan, tetapi file sensitif/state minicode tetap ditolak; gerbang = kepercayaan operator (toggle; footer menampilkan `○` merah). Detail di [Keamanan](security.md).

Did-you-mean: typo `/sessoons` → `Did you mean /sessions?` (jarak ≤ 2).

## Keyboard

| Tombol | Fungsi |
|---|---|
| `enter` | Kirim prompt (di picker/form: pilih/simpan; kosong = batal di picker) |
| `tab` | Putar WorkMode (`DISCUSS` → `PLAN` → `BUILD`) |
| `shift+tab` | Toggle PermissionMode (`AUTO` ↔ `ASK`) |
| `↑` / `↓` | Riwayat prompt, atau navigasi item di picker/manager/form |
| `pgup` / `pgdn` | Gulir transkrip satu halaman; dengan `shift`: setengah halaman (di picker/manager: gulir daftar) |
| `mouse drag` | Select teks transkrip; `Ctrl+C` menyalin selection app-level |
| `mouse wheel` | Gulir transkrip; klik prompt memindahkan kursor |
| `home` / `end` | Awal/akhir baris; saat baris kosong tanpa dropdown: lompat ke atas transkrip / kembali ke ekor (di picker/manager: lompat atas/bawah daftar) |
| `←` / `→` | Geser kursor (di form select/confirm: ganti opsi/nilai) |
| `ctrl+a` / `ctrl+e` | Awal / akhir baris |
| `delete` / `backspace` | Hapus karakter (di filter: pangkas query; di /model browse: Del = hapus model dengan konfirmasi) |
| `ctrl+r` | Cari riwayat prompt (prefix) |
| `ctrl+j` | Baris baru (multiline; Enter tetap submit) |
| `ctrl+w` | Hapus satu kata sebelum kursor |
| `ctrl+u` | Kosongkan baris (di filter: kosongkan query) |
| `ctrl+o` | Putar tool call compact/expanded (juga `/compact`) |
| `ctrl+t` | Toggle tampilan thinking expanded/minimized (juga `/thinking`) |
| `esc` | Tutup dropdown/picker; dua-tahap di form (tekan-1 bersihkan field, tekan-2 batal); busy = batalkan turn |
| `ctrl+c` | Salin selection (TUI); tanpa selection = no-op. Abort turn pakai `Esc` (`Esc` dua kali dalam 1,5 dtk, atau `Ctrl+D` baris-kosong, saat abort macet) |
| `ctrl+d` | Keluar saat baris kosong; saat busy baris-kosong = abort turn lalu keluar |

## Aturan konsistensi (kontrak I25)

- `Esc` dua-tahap di SEMUA input teks: isi tidak pernah hilang sekali tekan.
- `backspace`/`delete` selalu edit teks; aksi hapus-data selalu dengan
  konfirmasi (dalam popup) dan tercatat di transkrip.
- Navigasi daftar = `↑↓` + `pgup/pgdn` + `home/end` di semua popup ber-daftar.
- Setiap permukaan menampilkan hint footer sesuai tombol yang benar-benar
  berlaku di sana.
