# Contributing

Lisensi **MIT** (lihat `LICENSE`). Kontribusi publik diterima. Praktik aktif: **komentar Indonesia** yang menjelaskan *mengapa* (bukan *apa*), istilah teknis tetap English.

## Setup dev

```bash
git clone https://github.com/startupmini/minicode && cd minicode
bun install
bun test              # offline/hermetic; live & docker di-skip otomatis
bun x tsc --noEmit
bun run lint
bun run gate:coverage
```

Butuh `bun >= 1.0` (`bun:sqlite` tidak jalan di Node).

## Gate (urutan ini, semua hijau sebelum selesai)

```bash
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```

Coverage naik → naikkan minimum di `scripts/coverage-gate.ts` (saat ini **80 funcs / 84 lines** — funcs sengaja tidak dikunci 81 karena berayun antar run dan membuat gate flaky). Ambang coverage dikunci ke suite CEPAT (`bun test` di CI); gerbang lambat/stokastik tak boleh menaikkan ambang.

## Gate cepat vs lambat (F4.2)

```bash
bun run gate:fast   # tsc + lint + test + coverage + pack + bash + bench:smoke + audit:harness (per-commit/CI)
bun run gate:slow   # extreme fuzz + shadow-git stress + MCP adversarial (nightly slow.yml + manual)
```

Lambat/stokastik (fuzz multi-seed, stress, docker) tinggal di `slow.yml` — kegagalannya sinyal investigasi, bukan penolakan PR. CI per-commit (`ci.yml`) hanya menjalankan yang deterministik.

Gerbang lain:

```bash
bun run gate:bash      # 62 pola serangan + 24 perintah sah → 0 bypass / 0 over-block
bun run extreme        # fuzz + shadow-git + MCP jahat
bun run bench:smoke    # fake, CI-safe
bun run vendor:check   # vendor/minicore sinkron dengan ../minicore
```

## Batas lapisan (dijaga `test/ui-boundary.test.ts`)

- `cli/` boleh impor `src/ui/` dan `src/`; `src/` non-ui **dilarang** impor `src/ui/`; `src/ui/` **dilarang** impor `cli/`, `src/` non-ui, `#minicore`.
- Lintas-lapisan via DI dari composition root (`cli/index.ts`, `cli/setup.ts`): `ask`, `setupWhenEmpty`, `setSubAgentSessionFactory`. Tanpa injeksi default selalu deny / fail-closed.
- `providers → config` satu arah (provisioning di `src/providers/provision.ts`, `src/config.ts` murni IO).
- Layar `src/ui/screens/` = view murni (props + callback), controller di `cli/`.
- Jalur non-interaktif shell-first (append-only scrollback); sesi interaktif SELALU TUI alternate-screen (kontrak I16, tanpa opsi linear).
- Ubah struktur/dependensi antarlapisan → wajib update `docs/ARCHITECTURE.html`.

## Aturan kode

- Kernel `vendor/minicore/src/core/*` beku. Hanya seam aditif backward-compatible (`compactAsync`, `initialMessages`, `cwd`). Butuh primitif baru? Buktikan dulu tidak bisa sebagai Tool/Provider/Policy.
- Limit terpusat di `src/constants.ts` (`LIMITS`) — tanpa magic number tersebar.
- Semua spawn via `sanitizeSpawnEnv`; semua tulis file via `atomicWriteText`.
- Satu sumber pola ANSI: `ANSI_PATTERN`/`stripAnsi` di `src/ui/render/theme.ts`.
- Production code zero `as any` / `as never`.
- `c`/`glyphs` di `src/ui/render/theme.ts` adalah **getter** runtime — jangan simpan ke `const` module scope.
- Lebar terminal = kolom, bukan karakter: pakai `displayWidth` dkk. dari `src/ui/render/width.ts` (CJK/emoji = 2 kolom).
- Teks model/tool/berkas = input tak tepercaya: `sanitizeAnsi` dulu.
- `cwd` tool dari `ToolContext.cwd`, bukan `process.cwd()`.
- Line ending LF, encoding UTF-8 tanpa BOM, format `biome` (2 spasi, 100 kolom, double quotes). `bun run lint:fix` sebelum commit.
- Angka mesin jangan ditulis di markdown (biarkan CI/perintah yang menghasilkannya). Bila temukan angka usang, koreksi + sebutkan koreksinya.
- Test: tiap fix security/correctness bawa regression test yang **gagal di kode lama**. Tool dua jalur (mis. `grep`) diuji kedua jalurnya. Fuzz `prompt-engine` via `test/fuzz-prompt.test.ts`.
- Jangan commit kecuali diminta; jangan pernah commit rahasia. Sebelum commit: `git status`, `git diff`, `git log --oneline -10`; stage hanya yang dimaksud.
