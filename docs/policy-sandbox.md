# Policy & Sandbox

WorkMode, persetujuan, tool access policy, penjaga perintah shell, dan isolasi eksekusi adalah kontrol yang berbeda. Hard deny path jail, state milik runtime, dan bash guard tetap berlaku di atasnya.

## Tiga sumbu kontrol

| Sumbu | Nilai | Fungsi |
|---|---|---|
| **WorkMode** | `DISCUSS` / `PLAN` / `BUILD` (`EXECUTE` internal) | Membatasi cara agent bekerja. `DISCUSS` read-only; `PLAN` boleh membuat artefak rencana; `BUILD` tidak menambah ceiling. WorkMode hanya mempersempit akses. |
| **PermissionMode** | `AUTO` / `ASK` | Menentukan pengawasan manusia. `AUTO` menjalankan capability yang diotorisasi tanpa persetujuan rutin; `ASK` meminta persetujuan untuk aksi yang digate. Hard deny tetap berlaku. |
| **Tool Access Policy** | capability read-only, plan, allowlist, profil akses warisan | Menentukan capability yang tersedia. Nilai internal `readonly`, `plan`, `allowlist`, dan `allow-all` masih dipakai untuk kompatibilitas dan batas akses, bukan sebagai pilihan pengawasan. |

`PermissionMode` internal masih berupa union kompatibilitas yang juga memuat profil akses warisan. Untuk pilihan mode, flag, dan kombinasi yang menghadap pengguna, lihat [Memilih Mode](choosing-mode.md) dan [CLI](cli.md). Delegasi juga mewarisi batas parent; lihat [Sub-Agents & Tasks](agents.md).

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
| `echo x > ..\evil` (redirect keluar workspace) | ditolak; target redirect di-resolve ke cwd sebelum lolos allowlist |
| `echo x > "%TEMP%\evil"` | ditolak; target berisi ekspansi `%NAMA%` tak bisa dipastikan aman secara statis |
| `py -c …`, `python3.14 -c …` | ditolak bersama varian launcher dan versi Python |
| `type ..\..\windows\system32\config\sam`, `Get-Content .../ntds.dit` | ditolak (hive Windows + `reg save|export` hive + `vssadmin create|delete shadow` + `ntdsutil`; `reg query`, `vssadmin list`, `system.txt` biasa tetap lolos) |
| `write_file .minicode/<apa-pun>` | ditolak fail-closed (kunci penuh segmen `.minicode/`; kecuali restore `.trash/` → workspace dan skrip `.minicode/hooks/`) |
| `bash <(curl x)` | ditolak |
| `rm -rf ..`, `rm --recursive --force /`, `rm -rf /; :` | ditolak |
| `command env`, `nice env`, dkk. (wrapper) | deteksi env-dump ter-anchor ke awal | ditolak via `stripCommandWrappers` (buang wrapper berlapis) |
| Baca lewat hardlink menuju luar workspace | ditolak jika handle yang dibuka memiliki `nlink > 1`; pengecekan memakai `fstat` |
| `type .e^nv`, `ty^pe .env` (escape caret cmd.exe) | ditolak setelah caret dinormalisasi sebelum aturan nama/jail |
| `type %USERPROFILE%\notes.txt` | ditolak; argumen pembaca berpola `%NAMA%` tak bisa dipastikan aman |
| `for /f %i in (.env) do @echo %i` | ditolak; file set pada loop `for /f` ikut diperiksa |

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

Container mendapat nama acak per-run. Saat batas waktu habis atau tool dibatalkan,
runner meminta daemon menjalankan `docker rm --force` dengan timeout cleanup
5 detik sebelum menghentikan penunggu CLI. Output membedakan cleanup yang
dikonfirmasi daemon dari yang tidak terkonfirmasi. Ini tidak membatalkan efek
workspace yang sudah terjadi sebelum container dihentikan.

`MINICODE_SANDBOX_STRICT=1` = tak pernah fallback host (redundan dengan default fail-closed untuk request eksplisit, tetap dihormati). `MINICODE_SANDBOX_ALLOW_FALLBACK=1` = satu-satunya jalan fallback host yang sadar bila backend tak tersedia. `MINICODE_SANDBOX_IMAGE` ganti image (default `node:22-alpine` hanya bawa node). `code_run` selalu lewat sandbox runner dan menolak bila backend tak tersedia.

## Lapisan lain

- **Path jail** realpath-based + symlink `realpath` di permission layer; `.env`/`.git/config`/`node_modules`/hive Windows deny; `.minicode/` terkunci penuh untuk tool tulis berdasarkan target NYATA (realpath best-effort `isOwnedStateReal` — junction/symlink internal ke `.minicode/` ikut ditahan; kecuali restore `.trash/` + skrip `hooks/`); bash-guard menahan PEMBUATAN link yang operannya sensitif/owned-state. Untuk pembacaan, `safeOpenRead` memeriksa boundary ulang setelah stat dan mencocokkan `dev+ino` dari handle yang terbuka; `O_NOFOLLOW` juga dipakai pada POSIX. Stress test symlink tetap skip bila host tidak memberi privilege membuat symlink.
- **Env scrub** `sanitizeSpawnEnv`: strip kata-kunci kredensial dari merge final; `GITHUB_WORKSPACE`/`GITHUB_REF`/`GOOGLE_CHROME_PATH`/`REDIS_HOST`/`AWS_REGION` tetap ada, `GITHUB_TOKEN`/`AWS_SECRET_ACCESS_KEY`/`DATABASE_URL` tetap di-strip.
- **web_fetch/web_search**: redirect manual 5 hop + DNS pinning 30 dtk + body 2 MB.
- **Secret scrubber**: `sk-`, `ghp_`, `AKIA`, PEM, JWT, Bearer, `api_key=...` di-redact sebelum ke LLM (read_file/bash/grep) — tanpa whitelist kata.
- **Config/allowlist**: atomic randomUUID tmp+rename + chmod 600. MCP serve curated tools + permission aktif.
