# Instalasi

Prasyarat tunggal: **`bun >= 1.0`** — runtime Minicode, bukan Node.js. `npm` hanya dipakai untuk distribusi, bukan untuk menjalankan.

> Kernel MiniCore ikut repo di `vendor/minicore`, jadi **tanpa clone tambahan**. Clone sibling `../minicore` hanya dibutuhkan bila kamu mau sync ulang kernel via `bun run vendor:minicore`.

## Install (untuk awam — tanpa Node/Bun sekalipun)

**Langkah 1 — Pasang Bun** (sekali saja, tutup-buka terminal lagi setelahnya):

```powershell
# Windows PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
# kalau gagal karena ExecutionPolicy, coba:
npm install -g bun
```

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
```

Cek: `bun --version` harus keluar `1.4.x`. Kalau masih `command not found`, tutup-buka terminal dulu (PATH baru ke-load setelah restart).

**Langkah 2 — Pasang Minicode:**

```bash
npm install -g minicode-ai
# bin: minicode
minicode --version  # harus 0.9.x
```

Kenapa butuh keduanya? `npm` = toko distribusi, `Bun` = mesin yang menjalankan. Tanpa Bun, `minicode` gagal dengan `'bun' is not recognized`.

Untuk kontributor (kerja dari source):

```bash
git clone https://github.com/startupmini/minicode && cd minicode
bun install && bun link
```

Opsional tapi disarankan: `rg` (ripgrep) di PATH mempercepat tool `grep`. Tanpa `rg`, walker internal dipakai dengan hasil identik (paksa jalur itu untuk uji dengan `MINICODE_GREP_ENGINE=js`).

Verifikasi:

```bash
minicode doctor        # runtime, provider, pricing, memory, sandbox, config
bun test               # offline/hermetic; live & docker di-skip otomatis
```

Setup wizard berjalan otomatis saat `minicode` pertama kali bila belum ada provider.

## Matriks OS

| OS | Sandbox otomatis | Default permission | Catatan |
|---|---|---|---|
| Linux + bubblewrap | Ya, tanpa flag | `auto` | Paling terisolasi untuk `bash` |
| macOS + seatbelt | Ya, tanpa flag | `auto` | Sama, via seatbelt |
| Windows (semua) / tanpa bwrap-seatbelt | Tidak tersedia | Turun ke `allowlist` + alasan dicetak sekali | Lebih baik membatasi perintah daripada label aman palsu. Pilih sendiri dengan `--allow-all` / `--ask`, matikan dengan `--sandbox none`, atau pakai `--sandbox docker` |

Docker **tidak** dipakai otomatis meski tersedia — menarik image tanpa diminta terlalu invasif untuk default.

## Update & uninstall

Membuka `minicode` interaktif (TTY) selalu cek versi terbaru ke registry:
bila ada, paket di-install (`npm install -g minicode-ai@latest`) lalu
minicode restart sendiri ke versi baru — tanpa update manual. Berlaku hanya
untuk salinan ter-install (checkout source tidak disentuh) dan tidak pernah
memblokir: install gagal/offline = lanjut versi lama + pesan manual.
One-shot, `exec`, pipe, dan CI hanya menampilkan notifikasi (tanpa install).

> Model ancaman yang jujur: auto-update mengeksekusi kode dari registry
> tanpa verifikasi tanda tangan client-side (attestasi Sigstore npm butuh
> infrastruktur verifikasi di luar jangkauan CLI zero-dep — sudah diteliti,
> bundelnya tak membawa identitas repo yang bisa dicek offline). Percayakan
> TLS registry + rilis hanya dari CI repo ini; yang butuh jaminan lebih,
> matikan auto-update (`MINICODE_AUTO_UPDATE=0`) dan update manual setelah
> memeriksa rilis di GitHub.

```bash
npm update -g minicode-ai   # manual, bila auto-update dimatikan
minicode sync          # refresh model baru dari semua provider
minicode pricing sync  # refresh cache harga (3.162 model, ~213 KB)
```

Opt-out: `NO_UPDATE_CHECK=1` atau `MINICODE_AUTO_UPDATE=0`.

Clone contributor: `cd minicode && git pull && bun install`.

Uninstall = `npm uninstall -g minicode-ai` (atau hapus clone + `bun unlink` bila memakai link). Config global tetap di `~/.minicode/` sampai kamu hapus manual; config lokal di `.minicode/` per repo. Uninstall tidak pernah menghapus state, sesi, memori, atau file proyekmu.

## Lokasi data

- Config global `~/.minicode/config.json` + lokal `.minicode/config.json` (merge, lokal menang, tulis atomik + chmod 600).
- Token OAuth di `~/.minicode/auth.json` (chmod 600) — **bukan** di `config.json`, karena config lokal sering ikut ter-commit.
- Sessions `.minicode/sessions.db` (WAL), vector memory `vector.db`, repo-map `.minicode/repomap.json`, traces `.minicode/traces.jsonl`, checkpoint `.minicode/checkpoints/`, trash `.minicode/.trash/`.
- Override home untuk DB dengan `MINICODE_HOME` (berguna agar test hermetic di POSIX).

## Berikutnya

- [Quickstart 5 menit](quickstart.md) — wizard → prompt pertama → verify.
- [Troubleshooting](troubleshooting.md) — bila `doctor` merah atau sandbox tidak jalan.
