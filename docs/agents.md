# Sub-Agents & Tasks


## Konsep

Sub-agent = instans agent dengan **context terpisah** dari parent: memory, signal, dan budget sendiri. Pool concurrency 3 — maksimum 3 sub-agent hidup sekaligus — dan abort-aware (mewarisi AbortSignal parent; parent batal → anak berhenti).

`delegate_task` meminta persetujuan di **ASK** (TTY); non-TTY menolak. Di **AUTO**, delegasi berjalan tanpa prompt jika capability telah diotorisasi. Anak mewarisi WorkMode parent; `DISCUSS`/`PLAN` membatasi tool anak ke subset eksplorasi baca-saja. **Satu approval di ASK hanya mencakup satu delegasi.**

## Mode anak: `explore` / `plan`

| Mode anak | Kemampuan |
|---|---|
| `explore` | Subset tool eksplorasi baca-saja untuk mencari dan memahami kode |
| `plan` | Tidak mendapat `todo_write`, mutasi memory, commit, nesting, atau job background. Parent PermissionMode `ASK`, `plan`, atau `readonly` memaksa mode anak menjadi `explore`. WorkMode parent `DISCUSS`/`PLAN` juga membatasi daftar tool anak ke subset eksplorasi; pada `BUILD`, mode `plan` dapat memakai tool dasar yang tersedia, tetap tunduk pada PermissionMode anak |

Restriksi anak yang **selalu** berlaku: `delegate_task`, `git_commit`, memory/todo writes, `submit_result`, `bash_output`, dan `bash_kill` tidak tersedia. Background shell ditolak agar tidak membuat job yatim. Daftar tool dinamis MCP tidak diteruskan ke anak. WorkMode `BUILD` adalah label produk untuk identitas runtime `EXECUTE`.

## Kenapa dibatasi

Sub-agent menjalankan task tanpa Anda di depan layar. Karena itu kemampuan commit dan capability MCP tidak diteruskan; mode `explore` dan WorkMode ketat hanya memberi tool eksplorasi. Mode `plan` di bawah `BUILD` tetap dapat mengubah file atau menjalankan tool dasar, sehingga hasilnya harus ditinjau parent.

## Recovery

Turn parent gagal **setelah** anak `committed`: jurnal menandai delegasi; saat resume model diberi warning `[recovery]` agar tidak mendelegasi ulang buta (efek anak sudah terjadi — yang benar adalah verifikasi hasilnya). Lihat [Keamanan](security.md) untuk jurnal recovery lengkap.

## Lanjut

- [Tools](tools.md) — semua tool yang boleh dipakai anak.
- [Policy & Sandbox](policy-sandbox.md) — mode permission parent vs anak.
- [Otomasi & CI](exec.md) — delegasi di non-TTY (ditolak, fail-closed).
