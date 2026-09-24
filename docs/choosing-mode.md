# Memilih Mode

Satu pertanyaan, satu jawaban: **mode mana untuk tujuan saya?**

## Kalau tujuan Anda X → gunakan Y

| Saya ingin… | Gunakan | Karena |
|---|---|---|
|Memahami repo tanpa mengubah apa pun | `readonly` (atau `--tool-scope explore`) | Hanya 18 tool baca yang lolos; tulis/bash/commit/deligasi ditolak di gerbang |
| Minta agen membuat perubahan | `auto` (default) | Tulis terjail + bash aman langsung jalan; yang berisiko (commit, MCP, delegasi) tetap minta izin sekali |
| Menyetujui setiap perubahan | `ask` | Tiap tool non-sepele menunggu jawaban; `todo`/`bash_output` tak ditanya (bookkeeping sendiri) |
| Menyusun rencana tanpa eksekusi | `plan` | Baca + tulis rencana (`todo_write`) + delegasi yang dipaksa read-only; tanpa mutasi file/git/memori |
| Otomasi/CI tanpa manusia | One-shot/`exec` + mode default | `ask_user`/gated otomatis ditolak di non-TTY (fail-closed, bukan gantung); hindari prompt yang butuh klarifikasi |
| Otonom penuh di mesin sendiri | `allow-all` + `--sandbox docker` (atau OS) + `--budget` | Tanpa prompt, TETAPI jail path + bash-guard tetap aktif; sandbox memberi isolasi nyata |

## Rule of thumb

1. **Default `auto` sudah benar untuk kerja harian.** Pindah mode hanya bila tujuan berubah, bukan karena takut umum.
2. **`readonly` untuk baca, `plan` untuk berpikir.** Bedanya: `plan` boleh menulis rencana dan mendelegasikan penelahan; keduanya tak menyentuh file/git/memori Anda.
3. **`ask` untuk wilayah asing** — repo orang, perintah yang belum Anda pahami. Jawab `always` hanya untuk pasangan tool+args spesifik yang sudah Anda nilai.
4. **CI = non-interaktif = tanpa approval.** Jangan desain pipeline yang bergantung pada `ask_user` atau commit oleh agent; commit tetap keputusan manusia/Workflow.
5. **`allow-all` mematikan prompt, bukan batas.** Path jail dan pola bash berbahaya tetap menolak. Pasangkan dengan sandbox + budget bila otonom.

## Tradeoff yang jujur

- Semakin otonom → semakin cepat, semakin besar blast radius bila model salah paham. Tidak ada mode yang membuat model lebih bijak — mode hanya mengatur **apa yang boleh terjadi**.
- `allowlist` (otomatis saat tanpa sandbox OS) paling ketat untuk shell, tetapi model tetap bisa menulis file via tool terjail — pahami beda sumbunya: allowlist membatasi *perintah*, jail membatasi *file*.
- Ganti mode kapan pun: flag saat start, `/mode` atau Shift+Tab saat sesi interaktif berjalan.

## Lanjut

- [Security Model](security-model.md) — apa yang ditegakkan tiap mode.
- [Policy & Sandbox](policy-sandbox.md) — tabel semantik presisi + bukti guard.
- [Otomasi & CI](exec.md) — batasan headless.
