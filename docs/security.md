# Keamanan

## Prinsip

1. **Fail-closed di jalur tak pasti**: tool tanpa backend tersedia menolak (`code_run`), sandbox yang diminta tapi tidak tersedia ditolak (fail-closed; fallback host hanya via `MINICODE_SANDBOX_ALLOW_FALLBACK=1`), provider OAuth yang belum login dibuang dari daftar, auth non-TTY fail-fast.
2. **Ukur, bukan klaim**: bash-guard divalidasi korpus manual pola serangan + perintah sah — jalankan `bun run gate:bash` untuk angka terkini (exit 0 = 0 bypass / 0 over-block).
3. **Teks eksternal = tidak terpercaya**: output tool, MCP, web, bahkan output verify dibungkus fence; `sanitizeAnsi` menyaring escape ANSI dari teks model/tool sebelum render.
4. **Permission mengontrol pemanggilan, bukan capability**: di ASK, satu approval hanya mencakup pasangan server+tool+args (MCP); capability di balik server tak bisa diketahui statis.

## Mode dan akses

Kontrol mode punya tiga sumbu: **WorkMode** (`DISCUSS`/`PLAN`/`BUILD`) membatasi cara kerja agent; **PermissionMode** (`AUTO`/`ASK`) menentukan kapan dibutuhkan persetujuan manusia; **Tool Access Policy** menentukan capability yang tersedia. Nilai internal `readonly`, `plan`, `allowlist`, dan `allow-all` masih ada untuk batas akses dan kompatibilitas, tetapi bukan empat mode pengawasan tambahan. Hard deny path jail, owned-state, dan bash-guard tetap berlaku. Detail kombinasi dan interface ada di [Memilih Mode](choosing-mode.md) dan [Policy & Sandbox](policy-sandbox.md).

## Lapisan perlindungan bash

1. **Bash-guard ternormalisasi** (`src/policy/bash-guard.ts`) menormalisasi command sebelum aturan diterapkan. Tabel bypass termasuk redirect, ekspansi env Windows, hardlink, escape caret, dan pembaca `for /f` ada di [Policy & Sandbox](policy-sandbox.md), satu sumber contoh. `bun run gate:bash` mengukur regresi.

2. **Allowlist** — bentuk perintah yang boleh; diperiksa SETELAH bash-guard. Dua daftar: **narrow** (`--allowlist`, task tak-terpercaya): `git status/diff/log/branch/show`, `bun test/run/x tsc`, `npm/bun/pnpm/yarn install|add`, `npm run/exec/install/ci/test/start`, `node`, `npx`, `ls dir cat type head tail wc grep rg find which echo pwd` — tulis via shell ditahan (pakai `write_file`/`edit`). **Developer** (fallback tanpa sandbox OS, `restrictBash` — sesi trusted di mesin sendiri): narrow + runtime/interpreter luas (`python`/`node`/`ruby`/`php`/`perl`/`lua`/`julia`/`elixir`/`groovy`/`scala`/`java`/`dotnet`/`swift`/`dart`…), package manager (`pip`/`uv`/`poetry`/`pipenv`/`composer`/`gem`/`bundle`/`cargo`/`go`/`nuget`…), framework/bundler (`vite`/`next`/`nuxt`/`webpack`/`esbuild`/`rollup`…), test/lint/build (`pytest`/`ruff`/`mypy`/`jest`/`vitest`/`eslint`/`tsc`/`mvn`/`gradle`/`dotnet`/`make`/`cmake`/`gcc`…), DB CLI (`psql`/`mysql`/`sqlite3`/`prisma`…), container (`docker`/`podman`). `npm exec`/`npx`/`bun run`/`bun x` tak boleh ekspansi shell/redirection. Runtime hanya menjalankan berkas skrip — **eval inline** (`-e`/`--eval`/`-c`/`-r`/`--require`) ditolak guard untuk SEMUA interpreter, termasuk yang baru (`lua -e`, `julia -e`, `elixir -e`, …). **Verba rilis-registry** (`npm publish`, `cargo publish`/`login`, `gem push`, `dotnet nuget push`, `docker push`/`login`, `mvn deploy`, `gradle publish`, `dart pub publish`, `twine upload`…) ditolak guard di SEMUA mode (aksi ireversibel butuh kredensial) — sehingga daftar developer boleh luas tanpa membuka jalur terbit diam-diam. Package manager menjalankan lifecycle script (postinstall/setup.py = kode arbitrer dari registry), jadi keduanya "trusted project", bukan pengganti isolasi — isolasi sungguhan tetap `--sandbox docker`. `git --no-index/--exec-path/--upload-pack/--receive-pack`, transport `ext::`, dan `GIT_EXTERNAL_DIFF`/`GIT_CONFIG_*` inline ditolak guard (git sebagai pelarian jail).
3. **Path jail** realpath-based + symlink check; pembaca membuka target canonical, memakai `O_NOFOLLOW` pada POSIX, lalu mencocokkan `dev+ino` antara stat sebelum open dan handle setelah open (termasuk Windows). `.env`/`.git/config`/`node_modules`/hive Windows (`system32\config\sam|system|security|software`, `ntds.dit`) deny; berlaku bahkan `--allow-all`.
4. **Env scrub** `sanitizeSpawnEnv`: strip kata-kunci kredensial dari merge final. `GITHUB_WORKSPACE`/`GITHUB_REF`/`GOOGLE_CHROME_PATH`/`REDIS_HOST`/`AWS_REGION` **tetap ada** (pernah terhapus dan memecahkan build CI), sementara `GITHUB_TOKEN`/`AWS_SECRET_ACCESS_KEY`/`DATABASE_URL` di-strip. Bila non-rahasia ikut hilang, itu bug — laporkan nama variabelnya.
5. **web_fetch/web_search**: redirect manual ≤5 hop + resolve DNS tanpa cache per hop (anti-rebinding) + body cap 2 MB. Host privat ditolak (sama untuk MCP HTTP).

`grep` memakai ripgrep bila tersedia. Biner di-resolve dari PATH absolut yang
tepercaya, environment child disanitasi, dan config eksternal dinonaktifkan
(`--no-config`, tanpa `RIPGREP_CONFIG_PATH`). Config ripgrep mendukung
preprocessor yang mengeksekusi program per berkas; karena itu tool pencarian
tidak mewarisi konfigurasi tersebut.

## Prompt injection

- Output verify dibungkus fence agar instruksi di error build tidak diikuti model.
- `mcp_read`/`mcp_prompt` di-gate meski read-only — konten pihak ketiga langsung ke konteks = jalur injection; "read-only ≠ aman".
- Secret scrubber meredaksi `sk-`, `ghp_`, `AKIA`, PEM, JWT, Bearer, `api_key=...` sebelum teks ke LLM (read_file/bash/grep), tanpa whitelist kata.
- Bypass korpus: `bun run gate:bash`. Batas jujur: analisis statis atas bahasa Turing-complete; `$(curl …)` dinamis perlu sandbox OS/docker.

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
  workspace dan skrip hooks `.minicode/hooks/` — hook adalah kode arbitrer di
  luar permission system, aktif hanya via opt-in `MINICODE_HOOKS=1` dan
  dilarang di WorkMode non-`EXECUTE`); baca tetap boleh (observability). Tulis
  catatan sendiri ke workspace, bukan ke `.minicode/`.

## Config lokal & supply chain

- Config lokal `.minicode/config.json` + allowlist **diabaikan secara default** — repo clone-an tidak bisa men-spawn MCP, menyedot prompt, atau memasang hook. Percayai dengan `--allow-local-config`.
- Server MCP terdaftar tidak mendapat wildcard auto-allow. Capability tetap harus diotorisasi; di ASK pemanggilan yang digate meminta persetujuan per pasangan server+tool+args, sedangkan AUTO menjalankan capability authorized tanpa prompt rutin. `[a] Always` menyimpan cakupan yang disetujui ke allowlist.
- Config/allowlist/auth ditulis atomik + chmod 600; token OAuth terpisah di `~/.minicode/auth.json` (bukan config yang rawan ter-commit).
- `mcp serve` stdio-only (tanpa mode HTTP → tanpa permukaan jaringan), curated tools, permission aktif; `--all-tools` opt-in operator.

## Checkpoint & recovery

Setiap turn checkpoint shadow-git + recovery journal `.minicode/journal-<sesi>.jsonl` (`pending` → `committed`/`failed`/`unknown`; finalisasi menandai cakupan turn durable). Saat resume: `committed` yang turn-nya hilang tidak diulang; `pending`/`failed`/`unknown` → direktif verifikasi, dilarang redo buta; `committed` MCP = external-acknowledged wajib baca-balik. Detail di [Memory & Sessions](memory-sessions.md).

## Lanjut

- [Security Model](security-model.md) — rantai eksekusi, trust boundary, dan limitasi dalam satu halaman.
- [Policy & Sandbox](policy-sandbox.md) — mode, tool access policy, dan detail guard.
- [Kontrak Terminal](terminal.md) — kenapa warna di-gate TTY.
- [Otomasi & CI](exec.md) — batasan agent di CI (fail-closed non-TTY).
