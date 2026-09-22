# REPL — TUI + Slash & Keyboard

Di dalam TUI alternate-screen: ketik `/` di prompt → dropdown (max 10 item + `… N more`). `↑`/`↓` navigasi, `Enter` lengkapi + submit, `Esc` tutup. Status di baris terakhir permanen; input di atasnya tumbuh ke atas.


## Slash commands

| Command | Fungsi |
|---|---|
| `/help` | Daftar perintah + skill + tombol penting |
| `/help tombol` | Pintasan papan tombol lengkap |
| `/provider` | Daftar bernomor + pilih angka (pakai model pertama provider itu). Tambah/hapus/ubah via `minicode config` di luar sesi |
| `/model [cari]` | Daftar bernomor `provider::model` (argumen = filter substring, aktif ditandai). Pilih angka → pilih + atur thinking effort bernomor bila keluarga thinking (`default/low/medium/high`, tersimpan di provider, berlaku sesi berikutnya; kosong = batal/keep). Kosong = batal diam; angka ngawur = usage |
| `/sync` | Segarkan daftar model semua provider (hanya bilang restart bila benar ada model baru) |
| `/undo` | Batalkan perubahan berkas turn terakhir |
| `/redo` | Terapkan ulang yang dibatalkan |
| `/sessions` | Tanpa argumen = picker resume; `/sessions <id>` = langsung resume |
| `/status` | Runtime + pemakaian & biaya **kumulatif sesi** |
| `/mode [nama]` | Ganti permission (`auto`, `ask`, `plan`, `allowlist`); tanpa argumen = putar |
| `/init` | Buat `AGENTS.md` proyek ini |
| `/copy` | Salin output turn terakhir via OSC 52 |
| `/clear` | Banner `--- cleared (scrollback preserved) ---` (scrollback tetap transcript) |
| `/history` | 20 entri prompt terakhir |
| `/exit` | Keluar (satu-satunya jalan keluar; `/quit` dihapus) |

Alias (jalan, tidak diiklankan di `/help`): `/models` → `/model`, `/providers` → `/provider`, `/usage` & `/cost` → `/status`, `/resume [id]` → `/sessions [id]`, `/compact`.

Catatan dropdown: Tab menawarkan builtin + `/compact` `/thinking` `/expand` `/minimize` agar pendek. `/mode` tak masuk dropdown (Tab/Shift+Tab sudah memutar mode). `/undo /redo /clear /copy /history` tidak masuk dropdown tapi ada di `/help`. `/thinking` = toggle tampilan reasoning (expand/minimize); effort via angka di `/model`.

Did-you-mean: typo `/sessoons` → `Did you mean /sessions?` (jarak ≤ 2).

## Keyboard

| Tombol | Fungsi |
|---|---|
| `enter` | Kirim prompt |
| `shift+tab` | Putar permission |
| `tab` | Lengkapi dari dropdown; di baris kosong = putar mode |
| `↑` / `↓` | History, atau pilih item dropdown bila terbuka |
| `PgUp` / `PgDn` | Gulir transkrip (pin); PgDn di dasar = kembali follow (`↑N` di status = pin N baris) |
| `ctrl+o` | Putar tool call compact/expanded (juga `/compact`) |
| `ctrl+t` | Toggle tampilan reasoning expanded/minimized (juga `/thinking`) |
| `+` / `-` | Saat turn berjalan: expand / minimize section aktif (thinking & tool) |
| `ctrl+r` | Reverse-i-search history (substring; Esc/Ctrl+C batal, ketik lain keluar search lalu proses) |
| `ctrl+j` | Newline (multiline opt-in; Enter tetap submit) |
| `←` / `→` | Geser kursor (editing tengah baris) |
| `ctrl+a` / `ctrl+e` | Awal / akhir baris |
| `home` / `end` / `del` | Sama seperti editor |
| `ctrl+w` | Hapus satu kata sebelum kursor |
| `ctrl+u` | Kosongkan baris |
| `esc` | Tutup dropdown/picker; batal prompt kosong (draf berisi aman) |
| `ctrl+c` / `ctrl+d` | Busy = hentikan turn; idle = batalkan prompt (2× beruntun saat idle = keluar) |
| `\` di akhir baris | Sambung ke baris berikutnya |

Banner konteks saat start REPL: satu baris `model · mode · cwd` agar tidak buta posisi.
