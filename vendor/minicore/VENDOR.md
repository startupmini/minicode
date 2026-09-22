# vendor/minicore — JANGAN EDIT MANUAL

Salinan kernel MiniCore agar `bun install` tidak membutuhkan clone sibling
`../minicore`. Sumber kebenaran tetap repo minicore.

- source commit: `ae9d1be362d24b685f83858f65ee12cbfa3ca75a`
- files: 19
- hash: `96bcd6f7b8b62a4e`
- shipped hash: `824f509e6506c4b3` (18 file) — fingerprint file vendor yang ikut paket npm
  (hash di atas mencakup test/fakes.ts yang sengaja tidak ikut paket;
   verifikasi dari paket terbit: hitung hash vendor/minicore di dalam tarball)

Perbarui dengan `bun run vendor:minicore` (butuh `../minicore`).
CI memverifikasi kesinkronan lewat `bun run vendor:check`.
