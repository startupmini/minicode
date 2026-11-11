# Contributing

Lisensi **MIT** (lihat `LICENSE`). Kontribusi publik diterima. Praktik aktif: **komentar Indonesia** yang menjelaskan *mengapa* (bukan *apa*), istilah teknis tetap English.

## Setup dev

```bash
git clone https://github.com/minilabs-id/minicode && cd minicode
bun install
bun test              # offline/hermetic; live & docker di-skip otomatis
bun x tsc --noEmit
bun run lint
bun run gate:coverage
```

Butuh `bun >= 1.1.13` (`bun:sqlite` tidak jalan di Node; kode juga memakai
`AbortSignal.any()` yang absen di Bun 1.0.x — `minicode` gagal cepat dengan
pesan versi bila runtime terlalu lama).

Catatan instalasi dev:

- `@lydell/node-pty` DIPIN EKSAK di `bun.lock` (bukan caret): modul native
  berprebuild per platform, khusus test PTY; upgrade beta berikutnya wajib
  validasi probe PTY ulang di Linux + Windows. Sengaja devDependency agar
  instalasi user `npm install -g` tidak ikut mengunduh biner native test-only.
- PTY tidak tersedia di sebagian mesin Windows (ConPTY) — test PTY di-SKIP
  nyata via `test.skipIf` (bukan pass palsu, lihat F1 di CHANGELOG); CI Linux
  justru GAGAL bila PTY tersedia-di-harapkan tapi tak bisa dibuka.

## Gate (urutan ini, semua hijau sebelum selesai)

```bash
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```

Coverage naik → naikkan minimum di `scripts/coverage-gate.ts` (per 2026-10-25: **87 funcs / 86 lines** + 19 lantai per-berkas modul kritis; funcs dinaikkan 86 → 87 pada P13.5). Ambang coverage dikunci ke suite CEPAT (`bun test` di CI); gerbang lambat/stokastik tak boleh menaikkan ambang.

## Gate cepat vs lambat (F4.2)

```bash
bun run gate:fast   # tsc + lint + test + coverage + pack + bash + bench:smoke + audit:harness (per-commit/CI)
```

Gerbang lambat/stokastik (docker sandbox) tinggal di `slow.yml` — kegagalannya sinyal investigasi, bukan penolakan PR. CI per-commit (`ci.yml`) hanya menjalankan yang deterministik.

### Budget ukuran paket (3.968 KiB)

`bun run gate:pack` mengukur ukuran tarball (`npm pack --dry-run`, KiB) dan menolak bila **melebihi 4.096 KiB (4,0 MiB)**. Angka tunggalnya ada di `scripts/pack-budget.ts` — satu sumber untuk gate dan tes, jadi keduanya tak bisa menyimpang. Batas ini **alarm regresi** (menangkap `node_modules`/`test` ikut terbawa), bukan target ukuran yang perlu dikejar.

Batas 4.096 KiB disetujui pemilik pada 2026-11-11 untuk rilis v0.21.0. Jangan menaikkan anggaran tanpa bukti baru dan persetujuan pemilik; ukur dulu runtime serta berkas non-runtime yang dapat dipangkas.

Gerbang lain:

```bash
bun run gate:bash      # 62 pola serangan + 24 perintah sah → 0 bypass / 0 over-block
bun run bench:smoke    # fake, CI-safe
bun run vendor:check   # provenance MiniCore (soft; vendor host-editable sejak v0.16.0)
```

## Batas lapisan (dijaga `test/ui-boundary.test.ts`)

- `cli/` boleh impor `src/ui/` dan `src/`; `src/` non-ui **dilarang** impor `src/ui/`; `src/ui/` **dilarang** impor `cli/`, `src/` non-ui, `#minicore`.
- Lintas-lapisan via DI dari composition root (`cli/index.ts`, `cli/setup.ts`): `ask`, `setupWhenEmpty`, `setSubAgentSessionFactory`. Tanpa injeksi default selalu deny / fail-closed.
- `providers → config` satu arah (provisioning di `src/providers/provision.ts`, `src/config.ts` murni IO).
- Layar `src/ui/screens/` = view murni (props + callback), controller di `cli/`.
- Jalur non-interaktif shell-first (append-only scrollback); sesi interaktif SELALU TUI alternate-screen (invariant terminal #1, tanpa opsi linear).
- Ubah struktur/dependensi antarlapisan → wajib update `docs/architecture.md`.

## Aturan kode

- Kernel upstream `vendor/minicore/src/core/*` beku. Overlay host yang disetujui tersimpan di `scripts/vendor-overlays/` dan diterapkan oleh `bun run vendor:minicore`; jangan edit tree vendor atau `VENDOR.md` manual. Butuh seam baru? Buktikan dulu tidak bisa sebagai Tool/Provider/Policy, tambahkan test, lalu pin melalui generator.
- Limit terpusat di `src/constants.ts` (`LIMITS`) — tanpa magic number tersebar.
- Semua spawn via `sanitizeSpawnEnv`; semua tulis file via `atomicWriteText`.
- Satu sumber pola ANSI: `ANSI_PATTERN`/`stripAnsi` di `src/ui/render/theme.ts`.
- Production code zero `as any` / `as never`.
- `c`/`glyphs` di `src/ui/render/theme.ts` adalah **getter** runtime — jangan simpan ke `const` module scope.
- Lebar terminal = kolom, bukan karakter: pakai `displayWidth` dkk. dari `src/ui/render/width.ts` (CJK/emoji = 2 kolom).
- Teks model/tool/berkas = input tak tepercaya: `sanitizeAnsi` dulu.
- `cwd` tool dari `ToolContext.cwd`, bukan `process.cwd()`.
- Line ending LF, encoding UTF-8 tanpa BOM, format `biome` (2 spasi, 100 kolom, double quotes). `bun run format` lalu `bun run lint` sebelum commit.
- **Line ending = LF di seluruh lapisan**: blob yang di-commit selalu LF (`.gitattributes`: `*.ts text eol=lf`), formatter meminta LF (`biome.json`: `lineEnding: "lf"`), dan editor menulis LF (`.editorconfig`: `end_of_line = lf`). Working tree pun harus LF: di Windows dengan `core.autocrlf=true`, checkout lama bisa meninggalkan CRLF yang **tidak terlihat oleh `git diff`** (perbandingan git menormalisasi) tapi **terlihat oleh `biome check`** sebagai hundreds of diagnostic format. `git checkout-index -f`/`git clone` baru mengembalikan working tree LF. `test/helpers/source-eol.ts` menormalkan EOL untuk assertion semantik, bukan untuk menutupi masalah git.
- Angka mesin jangan ditulis di markdown (biarkan CI/perintah yang menghasilkannya). Bila temukan angka usang, koreksi + sebutkan koreksinya.
- Test: tiap fix security/correctness bawa regression test yang **gagal di kode lama**. Tool dua jalur (mis. `grep`) diuji kedua jalurnya. Fuzz `prompt-engine` via `test/fuzz-prompt.test.ts`.
- Jangan commit kecuali diminta; jangan pernah commit rahasia. Sebelum commit: `git status`, `git diff`, `git log --oneline -10`; stage hanya yang dimaksud.
