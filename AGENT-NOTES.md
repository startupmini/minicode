# AGENT NOTES — scratch koordinasi antar-agent (BUKAN kontrak/roadmap)

> Dibuat 2026-11-11 oleh satu sesi agent. Bukan kontrak produk, bukan roadmap
> (lihat `AGENTS.md` untuk otoritas). Hapus bila sudah tak relevan.

## Status working tree — ADA KERJA PARALEL yang belum di-commit

Branch `main` ada di `36f83ac` (rilis v0.17.0). Saat catatan ini ditulis,
working tree memuat **dua set perubahan yang belum di-commit** dan saling
tumpang-tindih di beberapa berkas:

1. **Kerja perf ketikan TUI (dari sesi/agent LAIN):** `scripts/bench-typing.ts`
   (baru) + `"bench:typing"` di `package.json`; `src/runtime/*`, `src/task/*`,
   `src/ui/tui/app.ts`, `src/ui/input/prompt-engine.ts`, `AGENTS.md`, dsb.
2. **Fix A2 (ikon status) di dokumentasi (dari sesi ini):** `docs/terminal.md`,
   `docs/UI_RENDER_PIPELINE.md`, `docs/OUTPUT_PROTOCOL_SPEC.md`,
   `docs/OUTPUT_UX_RULES.md`, + 2 komentar di `cli/index.ts` & `cli/model-manager.ts`.

## ATURAN untuk agent berikutnya

- **JANGAN `git add -A` / commit borongan.** Berkas saling tercampur
  (mis. `cli/index.ts` punya edit A2 DAN edit help `--sandbox … os` dari kerja
  paralel). Isolasi per-hunk (`git add -p`) atau per-baris sebelum commit.
- Jangan menimpa berkas yang sedang dipegang agent lain tanpa memeriksa diff
  (`git diff 36f83ac -- <file>`).
- Runtime `glyphs.check/cross/denied/circle` = `""` sejak rilis **v0.17.0**
  (commit `3e71cbb`). Bila Anda melihat `✓`/`✗` di RUNTIME, binary yang
  dijalankan lebih tua dari v0.17.0.

## Pending (belum di-commit, per catatan ini)

- **Perluasan allowlist developer** (banyak bahasa/ekosistem) di
  `src/policy/permission.ts`:
  - `DEFAULT_BASH_ALLOWLIST` (narrow): + `bun/pnpm/yarn install|add`.
  - `DEFAULT_DEV_BASH_ALLOWLIST`: diperluas besar (JS framework/bundler,
    Python/Ruby/PHP/Rust/Go/JVM/.NET/C-C++/Swift/Dart/Flutter/Elixir,
    DB CLI, container).
- **Zirah bash-guard** (`src/policy/bash-guard.ts`):
  - `INLINE_INTERPRETER` + `PIPE_TO_SHELL` diperluas (lua/julia/elixir/groovy/
    scala/tclsh/dotnet/swift/dart/java) — eval-inline interpreter baru ditolak.
  - `STATIC_DENY` baru: **verba rilis-registry** (`npm publish`, `cargo publish`/
    `login`, `docker push`/`login`, `mvn deploy`, `dart pub publish`, …) ditolak
    di SEMUA mode (tanpa over-block; `npm run deploy` lolos).
- **Test**: `test/allowlist-dev-breadth.test.ts` (baru).
- **Docs**: `docs/security.md` + `docs/policy-sandbox.md` (allowlist baru).
- Fix A2 dokumentasi (`docs/terminal.md`, `docs/UI_RENDER_PIPELINE.md`,
  `docs/OUTPUT_PROTOCOL_SPEC.md`, `docs/OUTPUT_UX_RULES.md`, 2 komentar `cli/`).

VERIFIKASI lokal (bukan gate penuh): `tsc` 0, `lint` 0, test guard/allowlist
hijau. Gate penuh BELUM dijalankan (working tree masih tercampur).
