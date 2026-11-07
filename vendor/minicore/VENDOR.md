# vendor/minicore — JANGAN EDIT MANUAL

Salinan MiniCore dari source commit yang dipin, ditambah overlay host yang
diperiksa dari patch di `scripts/vendor-overlays/minicode-context.patch`.
Overlay memberi admission context per model dan system prompt dinamis;
simpan seam ini saat menyinkronkan source upstream.

- source commit: `0d33571047c0ed3778986108fd42e4bde6828bb0`
- source hash: `c8d214bb8d5eea86`
- overlay sha256: `7545ff914e4f83745634ee106c9a2e774dfea3bf4541e58ea98eba216902d432`
- files: 20
- hash: `b5e27f72d08afb98`
- shipped hash: `4998979304b3c6e2` (18 file) — fingerprint file vendor yang ikut paket npm
  (hash di atas mencakup test/fakes.ts yang sengaja tidak ikut paket;
   verifikasi dari paket terbit: hitung hash vendor/minicore di dalam tarball)

Perbarui dengan `bun run vendor:minicore` (butuh `../minicore`).
`bun run vendor:check` memverifikasi source, overlay, dan fingerprint final.
