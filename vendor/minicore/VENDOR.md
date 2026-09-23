# vendor/minicore — JANGAN EDIT MANUAL

Salinan kernel MiniCore agar `bun install` tidak membutuhkan clone sibling
`../minicore`. Sumber kebenaran tetap repo minicore.

- source commit: `0d33571047c0ed3778986108fd42e4bde6828bb0`
- files: 20
- hash: `840aa2e9cd70a401`
- shipped hash: `78768e71a45254c3` (18 file) — fingerprint file vendor yang ikut paket npm
  (hash di atas mencakup test/fakes.ts yang sengaja tidak ikut paket;
   verifikasi dari paket terbit: hitung hash vendor/minicore di dalam tarball)

Perbarui dengan `bun run vendor:minicore` (butuh `../minicore`).
CI memverifikasi kesinkronan lewat `bun run vendor:check`.
