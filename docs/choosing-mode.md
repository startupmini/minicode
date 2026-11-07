# Memilih Mode

Tiga sumbu terpisah menentukan apa yang bisa/tidak bisa dilakukan agent:

1. **WorkMode** (operating mode) — *bagaimana* agent bekerja: `DISCUSS` (investigasi read-only), `PLAN` (analisis/plánning), `BUILD` (implementasi).
2. **PermissionMode** (persetujuan) — *apakah* butuh izin manusia: `AUTO` (otonom) atau `ASK` (diawasi).
3. **Tool Access Policy** — *apa* yang tersedia (read-only set, bash allowlist, delegasi, MCP, scope).

Hard security (path jail, sensitive-file, owned-state, bash-guard) selalu berlaku, di atas ketiganya.

## Kalau tujuan Anda X → gunakan Y

| Saya ingin… | Gunakan | Karena |
|---|---|---|
| Memahami repo tanpa mengubah apa pun | `--work-mode DISCUSS` | Ceiling read-only lokal; network read ditolak; tulis/bash/commit/delegasi ditolak di gerbang |
| Minta agen membuat perubahan | `BUILD` + `AUTO` (default) | Tulis terjail + bash + commit + delegasi + MCP authorized jalan otonom; hard-deny tetap berlaku |
| Menyetujui setiap perubahan | `--ask` (`BUILD` + `ASK`) | Tiap tool non-sepele menunggu jawaban; baca/bookkeeping tak ditanya |
| Menyusun rencana tanpa eksekusi | `--work-mode PLAN` | Baca + artefak rencana (`todo_write`) + delegasi read-only; tanpa mutasi file/git/commit |
| Otomasi/CI tanpa manusia | One-shot/`exec` + default | `AUTO` menolak `ask_user` deterministik (BLOCKED) di non-TTY; MCP tak-terkonfigurasi deny; tidak ada prompt yang bisa menggantung |
| Otonom penuh di mesin sendiri | `BUILD`+`AUTO` + `--sandbox docker` (atau OS) + `--budget` | Tanpa prompt, TETAPI jail path + bash-guard tetap aktif; sandbox memberi isolasi nyata |

## Rule of thumb

1. **Default `BUILD`+`AUTO` sudah benar untuk kerja harian.** Pindah mode hanya bila tujuan berubah, bukan karena takut umum.
2. **`DISCUSS` untuk baca, `PLAN` untuk berpikir.** Bedanya: `PLAN` boleh menulis artefak rencana (`todo_write`) dan menelusuri via delegasi read-only; keduanya tak menyentuh file/git/memori Anda.
3. **`ASK` untuk wilayah asing** — repo orang, perintah yang belum Anda pahami. Jawab `always` hanya untuk pasangan tool+args spesifik yang sudah Anda nilai.
4. **AUTO ≠ allow-all.** Kapabilitas yang tidak diotorisasi (mis. MCP tak-terkonfigurasi, `ask_user` di AUTO, code tanpa sandbox) di-*deny* dengan alasan, bukan di-prompt.
5. **Legacy `--allow-all`/`--allowlist`** dipetakan ke profil akses; path jail + bash-guard tetap menolak.

## Tradeoff yang jujur

- Semakin otonom → semakin cepat, semakin besar blast radius bila model salah paham. Tidak ada mode yang membuat model lebih bijak — mode hanya mengatur **apa yang boleh terjadi**.
- `allowlist` (otomatis saat tanpa sandbox OS) paling ketat untuk shell, tetapi model tetap bisa menulis file via tool terjail — pahami beda sumbunya: allowlist membatasi *perintah*, jail membatasi *file*.
- Ganti mode kapan pun: flag saat start, `Tab`/`Shift+Tab` atau `/mode`+`/work-mode` saat TUI berjalan.

## Lanjut

- [Security Model](security-model.md) — apa yang ditegakkan tiap mode.
- [Policy & Sandbox](policy-sandbox.md) — tabel semantik presisi + bukti guard.
- [Otomasi & CI](exec.md) — batasan headless.
- [CLI](cli.md) — referensi flag WorkMode/PermissionMode.
