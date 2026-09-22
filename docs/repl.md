# TUI — Slash & Keyboard (satu tampilan fullscreen)

Ketik `/` di prompt → dropdown berbingkai (max 8 + `… N more`). `↑`/`↓`
navigasi, `Enter` lengkapi + submit, `Esc` tutup. Semua permukaan interaktif
hidup di dalam TUI fullscreen; terminal tanpa ANSI/alt-screen = pesan satu
baris + keluar (interaktif butuh TTY ≥10 baris).

Bahasa UI: `MINICODE_LANG=en|id` > `/lang` (disimpan state.json) > locale OS >
en. `/lang` tanpa argumen = tampilkan aktif. Semua string lewat kamus i18n
(`src/ui/i18n/`); literal Indonesia hardcode di luar kamus dilarang test.

## Slash commands

| Command | Fungsi |
|---|---|
| `/help` | Daftar perintah + tombol penting |
| `/help tombol` | Pintasan papan tombol lengkap |
| `/provider` | Kelola provider: popup — picker preset + form (URL/key/scope/timpa), hapus (`d`, menyebut jumlah model yang ikut hilang), ubah (`e`) |
| `/model [cari]` | Popup semua `provider::model` (argumen = filter awal; di dalam ketik langsung cari live, Ctrl+U clear, Esc keluar filter). Del = hapus (konfirmasi). Enter = pilih + atur thinking effort (`default/low/medium/high`, tersimpan di provider, berlaku sesi berikutnya; Esc = batal total). Effort non-default tampil badge `[low|medium|high]` |
| `/sync` | Segarkan daftar model semua provider (hanya bilang restart bila benar ada model baru) |
| `/undo` | Batalkan perubahan berkas turn terakhir |
| `/redo` | Terapkan ulang yang dibatalkan |
| `/sessions` | Tanpa argumen = popup picker resume; `/sessions <id>` = langsung resume |
| `/status` | Runtime + pemakaian & biaya **kumulatif sesi** |
| `/mode [nama]` | Ganti permission (`auto`, `ask`, `plan`, `allowlist`); tanpa argumen = putar |
| `/lang [en|id]` | Bahasa UI; tanpa argumen = tampilkan aktif |
| `/init` | Buat `AGENTS.md` proyek ini |
| `/copy` | Salin output turn terakhir via OSC 52 |
| `/clear` | Kosongkan transkrip (viewport kembali kosong) |
| `/expand` | Buka isi tool/thinking yang disembunyikan ledger compact (sekali ambil habis) |
| `/history` | 20 entri prompt terakhir |
| `/exit` | Keluar (satu-satunya jalan keluar; `/quit` alias) |

Alias (jalan, tidak diiklankan di `/help`): `/models` → `/model`, `/providers` → `/provider`, `/usage` & `/cost` → `/status`, `/resume [id]` → `/sessions [id]`, `/compact`, `/thinking`, `/minimize`, `/quit`.

Did-you-mean: typo `/sessoons` → `Did you mean /sessions?` (jarak ≤ 2).

## Keyboard

| Tombol | Fungsi |
|---|---|
| `enter` | Kirim prompt (di picker/form: pilih/simpan; kosong = batal di picker) |
| `tab` / `shift+tab` | Putar mode izin (di form: pindah field) |
| `↑` / `↓` | Riwayat prompt, atau navigasi item di picker/manager/form |
| `pgup` / `pgdn` | Gulir transkrip (di picker/manager: gulir daftar) |
| `home` / `end` | Awal/akhir baris (di picker/manager: lompat atas/bawah daftar) |
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
| `ctrl+c` | Sama seperti Esc; busy = batalkan turn |
| `ctrl+d` | Keluar saat baris kosong; busy = abaikan |

## Aturan konsistensi (kontrak I25)

- `Esc` dua-tahap di SEMUA input teks: isi tidak pernah hilang sekali tekan.
- `backspace`/`delete` selalu edit teks; aksi hapus-data selalu dengan
  konfirmasi (dalam popup) dan tercatat di transkrip.
- Navigasi daftar = `↑↓` + `pgup/pgdn` + `home/end` di semua popup ber-daftar.
- Setiap permukaan menampilkan hint footer sesuai tombol yang benar-benar
  berlaku di sana.
