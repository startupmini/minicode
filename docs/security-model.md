# Security Model

Model ancaman Minicode dalam satu halaman: apa yang dikontrol, apa yang dipercaya, dan apa batasnya. Tanpa kata "aman" absolut — setiap klaim di bawah menunjuk ke mekanisme yang bisa Anda baca dan uji.

## Prinsip

Minicode mengontrol **kemampuan bertingkat** (layered capability control), bukan niat model. Model boleh salah paham; yang menentukan apa yang benar-benar terjadi adalah gerbang deterministik di bawahnya: izin → jail → guard → validasi → eksekusi → bukti.

## Execution Chain

Setiap pemanggilan tool melewati rantai ini, berurutan:

```
Permission → Jail → Bash Guard → Argument Validation → Executor → Journal / Recovery
```

| Tahap | Fungsi |
|---|---|
| **Permission** | Mode izin (`src/policy/permission.ts`) memutuskan allow/deny/ask per pasangan tool+args. Berlaku SEBELUM efek apa pun. |
| **Jail** | Path di luar workspace, symlink keluar, file sensitif (`.env`, `.git/config`), dan state milik minicode (`.minicode/*.db`, todos, jurnal, config) ditolak — **bahkan di `--allow-all`** (kecuali mode `unrestricted`, lihat §Mode dan akses di bawah). |
| **Bash Guard** | Perintah shell dinormalisasi dulu (buang quote/wrapper/variabel sederhana), baru diperiksa polanya. Menolak env-dump, exfiltrasi upload, interpreter inline, destruksi luas. |
| **Argument Validation** | Skema argumen divalidasi kernel sebelum eksekusi; argumen invalid ditolak tanpa efek. |
| **Executor** | Menjalankan yang lolos: read paralel, write dibatasi konkurensinya, abort-aware, output dipotong dengan penanda (tak pernah diam-diam). |
| **Journal / Recovery** | Tiap mutasi dicatat sebagai `pending` lalu `committed`/`failed`/`unknown`; finalisasi menandai cakupan turn durable. Resume tak pernah mengulang buta (lihat [Recovery](#recovery)). |

## Mode dan akses

Pilihan yang terlihat oleh operator dipisah menjadi tiga sumbu:

| Sumbu | Nilai | Dampak |
|---|---|---|
| **WorkMode** | `DISCUSS`, `PLAN`, `BUILD` (`EXECUTE` internal) | Membatasi ruang kerja agent. `DISCUSS` read-only; `PLAN` dapat menulis artefak rencana; `BUILD` tidak menambahkan ceiling. WorkMode hanya mempersempit akses. |
| **PermissionMode** | `AUTO`, `ASK` | `AUTO` menjalankan capability yang sudah diotorisasi tanpa persetujuan rutin; `ASK` meminta persetujuan untuk pemanggilan yang digate. `ask_user` ditolak di `AUTO`. |
| **Tool Access Policy** | kebijakan capability dan profil akses warisan | Menentukan tools yang tersedia. `readonly`, `plan`, `allowlist`, dan `allow-all` tetap menjadi identitas internal/kompatibilitas untuk batas akses, bukan mode persetujuan tambahan. |

**Profil `allow-all` tetap terbatas.** Path jail, penolakan state milik runtime, bash-guard, dan validasi argumen tetap berlaku; profil ini tidak memberi akses host tanpa batas. Detail implementasi dan opsi CLI ada di [Policy & Sandbox](policy-sandbox.md).

**Pengecualian eksplisit: `unrestricted`.** Satu-satunya mode yang melepas seluruh lapisan di atas — tanpa path jail, tanpa bash-guard, tanpa sandbox/allowlist. Diaktifkan eksplisit oleh operator lewat perintah TUI tersembunyi `/unrestric` (bukan flag CLI, sengaja tak muncul di `/help` maupun daftar `/`), berlaku **per-sesi saja** dan tak pernah persist. Gerbang keamanannya adalah kepercayaan operator kepada model — blast radius penuh (file apa pun di host, shell apa pun). Default tetap `DISCUSS`+`AUTO` dengan hard-deny aktif.

## Trust Boundaries

| Sumber | Status | Artinya |
|---|---|---|
| Prompt Anda | Niat tepercaya | Tujuan dijalankan, TETAPI setiap efek tetap lewat rantai di atas |
| Output model | Tak dipercaya untuk klaim | Teks/keputusan model bisa salah; bukti (hasil tool, test, HEAD) yang menentukan |
| Hasil tool | Data | Dibaca model sebagai fakta observasi, bukan instruksi baru |
| Data repository (kode, AGENTS.md, MEMORY, skill) | Data | Bisa berisi instruksi injeksi; system prompt menandainya tak-terpercaya |
| Server MCP | External capability | Efek di sisi server arbitrer dan tak terlihat; persetujuan mengikuti mode dan authorization; pembatalan tak membatalkan efek yang sudah terjadi |
| Provider / network | External | Prompt dan hasil melewati provider yang Anda pilih; tak ada telemetri/analitik dari Minicode sendiri |
| Child agent | Terisolasi | Memori, sinyal, budget, dan jurnal sendiri; tool scope mengikuti kebijakan delegasi dan WorkMode parent (lihat [Sub-Agents & Tasks](agents.md)) |
| Local config (`.minicode/config.json`) | Tak dipercaya default | Diabaikan kecuali `--allow-local-config`; repo clone-an tak bisa men-spawn server |
| Skills / memory tersimpan | Data | Dibaca sebagai konteks, bukan kebijakan |

## Dangerous Capabilities

Minicode **tidak menyediakan tool** untuk (terverifikasi di `src/tools/`):

- `git push`, `fetch`, `pull`, `clone` — tak ada tool git jaringan sama sekali
- `git reset`, `amend`, `rebase`, `checkout`, `branch -D`, `stash drop`
- Eksekusi remote / deploy bawaan

Catatan jujur: operasi itu tetap BISA diketik lewat `bash` (tunduk pada bash-guard + jail, BUKAN larangan). `git` via bash menjalankan konfigurasi repo apa adanya (hook/filter/driver milik repo). Tool baca `git_*` dinetralkan; `git_commit` menolak sebelum staging bila filter Git terkonfigurasi. Di repo tak-terpercaya, utamakan tool baca dan tinjau konfigurasi sebelum memakai Git manual.

## Recovery

Setiap mutasi meninggalkan bukti, bukan janji (disebut *mutation journal* di kode: `src/session/journal.ts`):

```
intent pending → committed/failed/unknown → finalisasi cakupan turn durable
```

- `committed` yang turn-nya hilang → **tidak diulang**; model diberi catatan narasi.
- `pending`/`failed`/`unknown` → direktif verifikasi; **dilarang redo buta**.
- Klaim sukses pihak ketiga (MCP) diperlakukan sebagai "kata server", wajib baca-balik bila penting.

Kejujuran yang disengaja: crash ambiguity TETAP MUNGKIN (filesystem dan database tak bisa commit atomik bersama). Yang dijamin adalah: ambiguitas selalu diperlakukan sebagai ambigu — diverifikasi dulu, tidak diasumsikan sukses maupun gagal.

## Limitations

- **Repo hooks/filter/driver:** `git` via bash mengeksekusinya (semantik stock-git); tool baca `git_*` menetralkan filter, sedangkan `git_commit` menolak bila menemukan filter terkonfigurasi.
- **Bash arbitrer:** guard adalah analisis statis; substitusi dinamis (`$(curl …)`) butuh sandbox OS/docker untuk isolasi nyata.
- **Efek eksternal MCP:** setelah terjadi, tak bisa dibatalkan dari sini.
- **Provider/network:** data melewati provider pilihan Anda; Minicode tak menambahkan transmisi sendiri.
- **Perilaku model:** pemilihan tool, klaim sukses, dan kepatuhan intent adalah sifat model — orkestrasi menjamin bukti dan batas, bukan kebijaksanaan.
- **Server LSP:** di-spawn dari perintah di config Anda; hanya daftarkan server yang Anda percaya.
- **Repo tak-terpercaya:** perlakukan seperti menjalankan `git`/`bash` manual di sana — karena memang itu yang terjadi di balik tool.

## Security Contact

Belum ada kontak keamanan privat. Laporkan masalah via [GitHub Issues](https://github.com/startupmini/minicode/issues) **tanpa menyertakan kredensial, token, atau data sensitif** — cukup langkah reproduksi minimal + output `minicode doctor`.

## Lanjut

- [Policy & Sandbox](policy-sandbox.md) — detail tiap mode + guard.
- [Keamanan](security.md) — threat model + bukti pengukuran.
- [Memory & Sessions](memory-sessions.md) — jurnal, checkpoint, undo.
