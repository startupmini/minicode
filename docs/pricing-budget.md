# Pricing & Budget


## Harga offline + sync

25 harga bawaan tersedia offline. Untuk cakupan luas, tarik sendiri — **tidak ada fetch otomatis** di jalur run (jalur run hanya baca cache lokal agar tidak menambah latensi/bocor pola pemakaian):

```bash
minicode pricing sync                 # 3.162 model dari models.dev (~213 KB cache)
minicode pricing status               # sumber aktif + umur cache + tanda (stale) >30 hari
minicode pricing show claude-sonnet-4-5
minicode pricing clear                # kembali ke bawaan
```

Pencocokan per-segmen (pemisah `/` dan `:`), kunci terpanjang menang. `deepseek/deepseek-chat:free` cocok, `claude-sonnet-4-5` menang atas `claude-sonnet-4`, `my-gpt-4o-wrapper` tidak cocok `gpt-4o`. Sufiks `:free` selalu $0 kecuali ada entri eksplisit.

Satu id sering beda harga antar provider (`qwen3-coder-plus` ada di 6 provider, dua $0 karena langganan). Overlay membuang kandidat gratis bila ada yang berbayar lalu ambil **median**, supaya `--budget` tidak menganggap semuanya gratis. Opus dikoreksi `$15/$75 → $5/$25` (sebelumnya 3× lipat merusak budget).

Semua angka **estimasi**: biaya riil tergantung provider, paket, diskon.

## Budget

```bash
minicode --budget 0.50 "task besar"
minicode --budget 0.05 --budget-strict "task ketat"
```

- Peringatan kuning 80%.
- Lewat budget: one-shot `exit(1)`, REPL `break` loop, `exec` menegakkan sama seperti one-shot (pernah ada bug `exec` mengabaikan `--budget`, sudah diperbaiki).
- Pagu juga diputus MID-TURN: watcher biaya live (`watchBudgetLimit` di `cli/setup.ts`) menggugurkan turn yang sedang berjalan begitu lewat — dulu tool loop / siklus self-heal bisa belanja tanpa batas dalam satu turn. Abort budget membawa identitas kind `budget_exceeded` (bukan `aborted` generik) agar terbedakan dari Ctrl+C user.
- Cost tak dikenal (model tanpa harga) + ADA pemakaian = fail-closed secara DEFAULT: dianggap over budget, bukan diabaikan (dulu hanya di `--budget-strict`; perilaku lama membuat `--budget` diam-diam mati untuk model baru). Nol token (belum belanja, mis. pre-check prompt baru) tetap lolos.
- `--budget-strict` / `MINICODE_BUDGET_STRICT=1` = penegasan eksplisit perilaku fail-closed di atas (back-compat; perilaku sama dengan default).
- Harga negatif/NaN/Infinity dari overlay lokal ditolak saat ekstraksi (bukan biaya negatif yang mengurangi total).
- Tampil di bawah $1 memakai 4 desimal (`$0.0601 > $0.0500`), bukan `$0.00` yang menyesatkan.
- `/status` dan (opt-in `MINICODE_STATUSLINE=rich`) spinner menampilkan token kumulatif + biaya sesi. Kumulatif sesi dipisah dari per-turn (`get()` vs `getSession()`) — bug lama membuat `/cost` selalu 0 setelah turn pertama.

## Membaca angka token

`/status` menampilkan LIMA angka dengan arti berbeda — jangan dicampur:

| Baris | Sumber | Arti |
|---|---|---|
| `Context` | kernel (`estimateSessionContext`) | Estimasi ukuran jendela SAAT INI (yang masih muat diproses) |
| `Turn` | `usage.get()` | Token turn TERAKHIR saja (di-reset tiap turn) |
| `Input`/`Output` | event usage provider | Pemakaian kumulatif sesi per arah |
| `Total` | `usage.getSession()` | Kumulatif sesi = Input + Output (tak pernah di-reset) |
| `Cost` | tabel harga offline | Estimasi, atau `N/A` bila model tak dikenal — **tanpa fetch** |

Aturan praktis: `Turn` besar + `Context` kecil = turn ini boros di jendela sempit (saatnya `/compact` atau `/clear`); `Total` besar + `Cost: N/A` = model tanpa harga, `--budget` fail-closed (dianggap over). Kurva token per sesi bisa direplay dari `.minicode/step-traces.jsonl` (kolom `totalTokens` per baris, monoton naik); `minicode stats` menampilkan peak-nya (`Peak tok`).
