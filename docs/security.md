\n
## Prinsip

1. **Fail-closed di jalur tak pasti**: tool tanpa backend tersedia menolak (`code_run`), sandbox yang diminta tapi tidak tersedia tidak pura-pura aman (warn + `allowlist`), provider OAuth yang belum login dibuang dari daftar, auth non-TTY fail-fast.
2. **Ukur, bukan klaim**: bash-guard divalidasi korpus manual pola serangan + perintah sah dan fuzz kombinatorial ber-seed — jalankan `bun run gate:bash` dan `bun run extreme:fuzz` untuk angka terkini (exit 0 = 0 bypass / 0 over-block).
3. **Teks eksternal = tidak terpercaya**: output tool, MCP, web, bahkan output verify dibungkus fence; `sanitizeAnsi` menyaring escape ANSI dari teks model/tool sebelum render.
4. **Permission mengontrol pemanggilan, bukan capability**: satu approval = satu pasangan server+tool+args (MCP); capability di balik server tak bisa diketahui statis.

## 6 permission mode

`auto` (default) · `readonly` (18 tool read-only) · `plan` (readonly + todo + delegate read-only) · `allowlist` (bash pola aman) · `ask` (prompt tiap tool) · `allow-all` (semua — tetap tolak bash berbahaya, path jail tetap aktif). Putar via Shift+Tab (siklus 5: `allow-all` dilewati), `/mode`, atau flag `--plan/--allowlist/--ask/--allow-all`. Detail per mode di [Policy & Sandbox](policy-sandbox.md).

## Lapisan perlindungan bash

1. **Bash-guard ternormalisasi** (`src/policy/bash-guard.ts`) — quote pemisah kata dibuang dan assignment sederhana disubstitusi **sebelum** pemeriksaan. Ini menutup kelas bypass, bukan pola individual:

   | Dulu lolos | Kenapa | Sekarang |
   |---|---|---|
   | `cat .e""nv` | regex melihat `.e""nv`, shell membaca `.env` | ditolak |
   | `X=.env; cat $X` | regex tak pernah melihat `.env` | ditolak |
   | `p=python3; $p -c 1` | regex tak melihat `python3 -c` | ditolak |
   | `node --eval "1"` | hanya `-e` yang di-regex | ditolak |
   | `env`, `set`, `export -p` | hanya `printenv` yang diblok | ditolak |
   | `curl -F file=@~/.ssh/id_rsa` | tak ada aturan upload | ditolak |
   | `bash <(curl x)` | tak ada aturan process substitution | ditolak |
   | `rm -rf ..`, `rm --recursive --force /`, `rm -rf /; :` | pola lama hanya kenal `/` dan `~` | ditolak |
   | `command env`, `nice env`, dkk. (wrapper) | deteksi env-dump ter-anchor ke awal | ditolak via `stripCommandWrappers` (buang wrapper berlapis) |
   | `echo x > ..\evil` (redirect keluar workspace) | allowlist `echo *` + guard tanpa aturan redirect | ditolak via `findRedirectTargets` (target di-resolve ke cwd; heredoc/fd/`/dev/null` dikecualikan) |
   | `echo x > "%TEMP%\evil"` (redirect + ekspansi env) | cek statis melihat literal `%TEMP%\…` di dalam cwd; cmd.exe mengekspansi SETELAH cek | ditolak: target berpola `%NAMA%` tak bisa dipastikan aman (red-team eksternal). `%` tunggal (`100%.txt`) tetap lolos |
   | `py -c …`, `python3.14 -c …` (launcher/versi) | regex hanya kenal `python|python2|python3|pypy` | ditolak via `pyw?|python[\d.]*|pypy[\d.]*` |
   | `type ..\..\..\windows\system32\config\sam` (baca hive SAM) | pola kredensial POSIX-sentris (`/etc/shadow` dkk, tanpa padanan Windows) | ditolak: `system32\config\(sam|system|security|software|default)` + `ntds.dit` (anchor segmen, case-insensitive); `reg save|export` hive + `vssadmin create|delete shadow` + `ntdsutil` ditolak eksplisit (`reg query`, `vssadmin list`, `system.txt` biasa tetap lolos) |
   | `write_file .minicode/test-write.txt` (state via nama tak terdaftar) | jail `.minicode/` berbasis daftar-nama | ditolak: kunci penuh segmen `.minicode/` untuk tool tulis (satu-satunya pengecualian: restore `.minicode/.trash/` → workspace) |
   | baca via hardlink ke luar workspace | `realpath` tak melihat hardlink (semua nama setara) | ditolak bila `nlink > 1` pada handle yang dibuka (fstat, bebas race). Tulis aman by-design (atomic replace memutus hardlink) |

2. **Allowlist** (`--allowlist`, dan default bila tanpa sandbox OS): hanya bentuk read/build — `git status/diff/log/branch/show`, `bun test/run/x tsc`, `npm run/exec`, `npx`, `ls dir cat type head tail wc grep rg find which echo pwd`. Tulis via shell ditahan; pakai `write_file`/`edit` yang ter-jail. `npm exec`/`npx`/`bun run`/`bun x` tak boleh ekspansi shell/redirection. `git --no-index/--exec-path/--upload-pack/--receive-pack`, transport `ext::`, dan `GIT_EXTERNAL_DIFF`/`GIT_CONFIG_*` inline ditolak guard (git sebagai pelarian jail).
3. **Path jail** realpath-based + symlink check + TOCTOU `O_NOFOLLOW`; `.env`/`.git/config`/`node_modules`/hive Windows (`system32\config\sam|system|security|software`, `ntds.dit`) deny; berlaku bahkan `--allow-all`.
4. **Env scrub** `sanitizeSpawnEnv`: strip kata-kunci kredensial dari merge final. `GITHUB_WORKSPACE`/`GITHUB_REF`/`GOOGLE_CHROME_PATH`/`REDIS_HOST`/`AWS_REGION` **tetap ada** (pernah terhapus dan memecahkan build CI), sementara `GITHUB_TOKEN`/`AWS_SECRET_ACCESS_KEY`/`DATABASE_URL` di-strip. Bila non-rahasia ikut hilang, itu bug — laporkan nama variabelnya.
5. **web_fetch/web_search**: redirect manual ≤5 hop + DNS pinning 30 dtk + body cap 2 MB. Host privat ditolak (sama untuk MCP HTTP).

## Prompt injection

- Output verify dibungkus fence agar instruksi di error build tidak diikuti model.
- `mcp_read`/`mcp_prompt` di-gate meski read-only — konten pihak ketiga langsung ke konteks = jalur injection; "read-only ≠ aman".
- Secret scrubber meredaksi `sk-`, `ghp-`, `AKIA`, PEM, JWT, Bearer, `api_key=...` sebelum teks ke LLM (read_file/bash/grep), tanpa whitelist kata.
- Bypass korpus + fuzz: `bun run gate:bash`, `bun run extreme:fuzz` (`--seed` untuk reproduksi). Batas jujur: analisis statis atas bahasa Turing-complete; `$(curl …)` dinamis perlu sandbox OS/docker.

## Batas kepercayaan file lokal (trust model)

Agen berjalan SEBAGAI user — tidak ada batas privilege antara agen dan pemilik
mesin. Yang dilindungi guard adalah **niat operator**, bukan capability:
konten yang dibaca agen bisa memengaruhi keputusan dan ikut terkirim ke
provider model pihak ketiga.

- `MEMORY.md` (.minicode/, root, home), `AGENTS.md`, `rules/`, skills: **input
  tepercaya yang boleh diedit manusia** — termasuk edit langsung via file.
  Tulis out-of-band (di luar `write_memory`) ikut termuat apa adanya pada
  retrieval berikutnya. Jangan taruh instruksi dari repo tak dikenal tanpa
  dibaca; `forget_memory` menjangkau vector store + `.minicode/MEMORY.md` di
  scope lokal DAN global (keduanya ikut di-search) — hierarki baca
  `MEMORY.md` root/`CLAUDE.md` tidak ikut terhapus.
- `sessions.db` + jurnal: transkrip sesi tersimpan plaintext di workspace
  (terbaca agen mana pun di workspace itu). Jurnal 0-byte = sesi terpasang
  yang belum bermutasi (by-design, bukan korupsi).
- State milik runtime (`.minicode/` — DB, todos, plans, checkpoints, jurnal,
  traces, allowlist, config, + file APAPUN lain di bawahnya): tulis via file
  tools ditolak fail-closed (pengecualian: restore `.minicode/.trash/` →
  workspace dan skrip hooks `.minicode/hooks/` — eksekusi hook tetap butuh
  registrasi allowlist yang terkunci); baca tetap boleh (observability). Tulis
  catatan sendiri ke workspace, bukan ke `.minicode/`.

## Config lokal & supply chain

- Config lokal `.minicode/config.json` + allowlist **diabaikan secara default** — repo clone-an tidak bisa men-spawn MCP, menyedot prompt, atau memasang hook. Percayai dengan `--allow-local-config`.
- Server MCP terdaftar tidak mendapat wildcard auto-allow; tiap tool bertitik di-gate sekali per pasangan server+tool+args; `[a] Always` persist ke allowlist.
- Config/allowlist/auth ditulis atomik + chmod 600; token OAuth terpisah di `~/.minicode/auth.json` (bukan config yang rawan ter-commit).
- `mcp serve` stdio-only (tanpa mode HTTP → tanpa permukaan jaringan), curated tools, permission aktif; `--all-tools` opt-in operator.

## Checkpoint & recovery

Setiap turn checkpoint shadow-git + recovery journal `.minicode/journal-<sesi>.jsonl` (`pending` → `committed` → `finalized`). Saat resume: `committed` yang turn-nya hilang tidak diulang; `pending`/`failed` → direktif verifikasi, dilarang redo buta; `committed` MCP = external-acknowledged wajib baca-balik. Detail di [Memory & Sessions](memory-sessions.md).

## Lanjut

- [Security Model](security-model.md) — rantai eksekusi, trust boundary, dan limitasi dalam satu halaman.
- [Policy & Sandbox](policy-sandbox.md) — 6 mode + detail guard.
- [Kontrak Terminal](terminal.md) — kenapa warna di-gate TTY.
- [Otomasi & CI](exec.md) — batasan agent di CI (fail-closed non-TTY).
