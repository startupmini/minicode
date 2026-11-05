# Sub-Agents & Tasks


## Konsep

Sub-agent = instans agent dengan **context terpisah** dari parent: memory, signal, dan budget sendiri. Pool concurrency 3 — maksimum 3 sub-agent hidup sekaligus — dan abort-aware (mewarisi AbortSignal parent; parent batal → anak berhenti).

Approval: `delegate_task` di-gate — TTY meminta persetujuan sekali per delegasi; non-TTY menolak. **Satu approval = delegasi ini saja**, tidak melebar ke delegasi lain.

## Mode anak: `explore` / `plan`

| Mode anak | Kemampuan |
|---|---|
| `explore` | Subset read-only (12 tool) — cari/pahami kode, kembalikan temuan |
| `plan` | Selalu tanpa `todo_write`/mutasi memory/commit/nesting. **Jika parent ber-WorkMode/PM ketat** (`PLAN`/`DISCUSS`/`readonly`/`plan`/`ask`): subset read-only 12 tool, sama seperti `explore`. **Jika parent `EXECUTE`×auto/allow-all**: tool dasar parent (read + file-write + `bash`/`code_run`), minus MCP runtime, `git_commit`, memory-tulis, todo-tulis, dan job background |

Restriksi anak yang **selalu** berlaku: anak **tidak** bisa bersarang (`delegate_task` dibuang), tidak bisa `git_commit`, tidak menulis memory/todo, tidak memakai `bash_output`/`bash_kill` (job milik parent). Tool MCP runtime (`server.tool`) hanya muncul pada anak `plan` di bawah parent `EXECUTE`; pada `explore` maupun parent non-`EXECUTE`, daftar anak dibatasi ke `EXPLORE_TOOL_NAMES`. Plan-parent dipaksa explore saat mendelegasi.

## Kenapa dibatasi

Sub-agent menjalankan task tanpa Anda di depan layar. Kalau anak bisa commit atau memanggil MCP, satu prompt parent bisa menghasilkan efek yang tak Anda persetujui. Dengan membatasi anak ke read-only, efek samping tetap satu: eksekusi di parent — yang ledger-nya selalu Anda lihat.

## Recovery

Turn parent gagal **setelah** anak `committed`: jurnal menandai delegasi; saat resume model diberi warning `[recovery]` agar tidak mendelegasi ulang buta (efek anak sudah terjadi — yang benar adalah verifikasi hasilnya). Lihat [Keamanan](security.md) untuk jurnal recovery lengkap.

## Lanjut

- [Tools](tools.md) — semua tool yang boleh dipakai anak.
- [Policy & Sandbox](policy-sandbox.md) — mode permission parent vs anak.
- [Otomasi & CI](exec.md) — delegasi di non-TTY (ditolak, fail-closed).
