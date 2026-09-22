# Policy & Sandbox

Siapa boleh apa: enam mode izin, penjaga perintah shell, dan isolasi eksekusi — plus batas jujurnya.

## 6 permission mode

`type PermissionMode = "auto"|"readonly"|"plan"|"allow-all"|"ask"|"allowlist"` (`permission.ts`). Keputusan data-driven per mode.

| Mode | Semantik |
|---|---|
| `auto` | Readonly + gated-prompt + file/internal-write allow; `code_run`/`bash` dengan guard. `delegate_task`/`mcp_call`/semua MCP bertitik di-gate (prompt saat TTY, tolak tanpa TTY) |
| `ask` | Readonly + `NO_PROMPT_TOOLS` auto-allow; sisanya prompt/TTY + allowlist persist |
| `readonly` | Hanya 18 tool `READONLY_TOOLS` |
| `plan` | `readonly` + `todo_write` + `delegate_task` (anak dipaksa explore/read-only) + `submit_result`. Tetap tanpa mutasi file/git/memory |
| `allowlist` | Bash hanya pola `DEFAULT_BASH_ALLOWLIST`/env; file-write/internal-write sesuai set. Diwariskan ke sub-agent (parent allowlist → anak allowlist, bukan auto) |
| `allow-all` | Allow semua; **tetap** tolak bash berbahaya + path jail tetap aktif |

Cycle Tab/Shift+Tab hanya 5 (`auto,ask,plan,allowlist,allow-all` — `allow-all` dilewati agar tak aktif tak sengaja). Mode bisa dioverride: `--plan`, `--allowlist`, `--ask`, `--allow-all`, `MINICODE_PLAN=1`, `MINICODE_PERMISSION=allowlist`, `Shift+Tab` runtime.

Set terkait: `INTERNAL_WRITE_TOOLS`, `FILE_WRITE_TOOLS`, `GATED_TOOLS` (+ `*.*` MCP), `NO_PROMPT_TOOLS`. `move_file`/`delete_file` dijail di permission layer (berlaku semua mode termasuk `--allow-all`).

## Bash-guard ternormalisasi

`src/policy/bash-guard.ts`: quote pemisah kata dibuang dan assignment sederhana disubstitusi **sebelum** pemeriksaan.

| Dulu lolos | Sekarang |
|---|---|
| `cat .e""nv` | ditolak |
| `X=.env; cat $X` | ditolak |
| `p=python3; $p -c 1` | ditolak |
| `node --eval "1"` | ditolak |
| `env`, `set`, `export -p` | ditolak |
| `curl -F file=@~/.ssh/id_rsa` | ditolak |
| `type ..\..\windows\system32\config\sam`, `Get-Content .../ntds.dit` | ditolak (hive Windows + `reg save|export` hive + `vssadmin create|delete shadow` + `ntdsutil`; `reg query`, `vssadmin list`, `system.txt` biasa tetap lolos) |
| `write_file .minicode/<apa-pun>` | ditolak fail-closed (kunci penuh segmen `.minicode/`; kecuali restore `.trash/` → workspace dan skrip `.minicode/hooks/`) |
| `bash <(curl x)` | ditolak |
| `rm -rf ..`, `rm --recursive --force /`, `rm -rf /; :` | ditolak |
| `command env`, `nice env`, dkk. (wrapper) | deteksi env-dump ter-anchor ke awal | ditolak via `stripCommandWrappers` (buang wrapper berlapis) |

Allowlist (juga default bila tanpa sandbox): `git status/diff/log/branch/show`, `bun test/run/x tsc`, `npm run/exec`, `npx`, `ls cat head tail wc grep rg find which echo pwd`. Tulis via shell (`mkdir cp mv rm touch`) ditahan — pakai `write_file`/`edit` yang ter-jail. `npm exec`/`npx`/`bun run`/`bun x` tak boleh ada ekspansi shell (`$`, backtick) atau redirection.

Ukur, bukan klaim — jalankan sendiri untuk angka terkini:

```bash
bun run gate:bash        # korpus manual pola serangan + perintah sah (0 bypass / 0 over-block = lulus)
bun run extreme:fuzz     # mutasi kombinatorial ber-seed
```

Fuzz membangkitkan varian dari transformasi yang shell anggap setara (quote-split, indirection, wrapper, flag panjang, chaining); temuan terkunci sebagai regression test.

> Batas jujur: analisis statis atas bahasa Turing-complete. `$(curl …)` dinamis tak bisa diselesaikan tanpa eksekusi — untuk itu sandbox OS ada.

## Sandbox otomatis

| Kondisi | Yang terjadi |
|---|---|
| bwrap (Linux) / seatbelt (macOS) tersedia | Bash di dalamnya, tanpa flag |
| Tidak tersedia (termasuk semua Windows) | Default turun ke `allowlist` + alasan dicetak sekali |
| `--allow-all` / `--ask` / `--plan` / `--allowlist` diberikan | Pilihan dihormati, tanpa peringatan |
| `--sandbox none` | Opt-out sadar; tanpa downgrade |
| `--sandbox docker` | Container ephemeral (`--network none`, 512m, 1 CPU, `node:22-alpine`) |
| `--sandbox docker` tapi daemon mati | TOLAK sebelum jalan (fail-closed) + cara opt-in fallback eksplisit; tidak pura-pura terisolasi |

`MINICODE_SANDBOX_STRICT=1` = tak pernah fallback host (redundan dengan default fail-closed untuk request eksplisit, tetap dihormati). `MINICODE_SANDBOX_ALLOW_FALLBACK=1` = satu-satunya jalan fallback host yang sadar bila backend tak tersedia. `MINICODE_SANDBOX_IMAGE` ganti image (default `node:22-alpine` hanya bawa node). `code_run` selalu lewat sandbox runner dan menolak bila backend tak tersedia.

## Lapisan lain

- **Path jail** realpath-based + symlink `realpath` di permission layer; `.env`/`.git/config`/`node_modules`/hive Windows deny; `.minicode/` terkunci penuh untuk tool tulis berdasarkan target NYATA (realpath best-effort `isOwnedStateReal` — junction/symlink internal ke `.minicode/` ikut ditahan; kecuali restore `.trash/` + skrip `hooks/`); bash-guard menahan PEMBUATAN link yang operannya sensitif/owned-state; TOCTOU `O_NOFOLLOW` (`src/lib/safe-open.ts`: `resolveSafePath` untuk penulis, `safeOpenRead` untuk pembaca; POSIX-only, Windows pre-check).
- **Env scrub** `sanitizeSpawnEnv`: strip kata-kunci kredensial dari merge final; `GITHUB_WORKSPACE`/`REDIS_HOST`/`AWS_REGION` tetap ada, `GITHUB_TOKEN`/`AWS_SECRET_ACCESS_KEY`/`DATABASE_URL` tetap di-strip.
- **web_fetch/web_search**: redirect manual 5 hop + DNS pinning 30 dtk + body 2 MB.
- **Secret scrubber**: `sk-`, `ghp_`, `AKIA`, PEM, JWT, Bearer, `api_key=...` di-redact sebelum ke LLM (read_file/bash/grep) — tanpa whitelist kata.
- **Config/allowlist**: atomic randomUUID tmp+rename + chmod 600. MCP serve curated tools + permission aktif.
