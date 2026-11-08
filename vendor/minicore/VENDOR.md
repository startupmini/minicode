# vendor/minicore — JANGAN EDIT MANUAL

Salinan MiniCore dari source commit yang dipin, ditambah overlay host yang
diperiksa dari patch di `scripts/vendor-overlays/minicode-context.patch`.
Overlay memberi admission context per model dan system prompt dinamis;
simpan seam ini saat menyinkronkan source upstream.

- source commit: `0d33571047c0ed3778986108fd42e4bde6828bb0`
- source hash: `c8d214bb8d5eea86`
- overlay sha256: `fa3e3a789982523c3de99c2d31c173789a7fee2bf0f8087267c222ce9b4eebcf`
- files: 20
- hash: `4cee16b60d65d18f`
- shipped hash: `b714c2adc59ea720` (18 file) — fingerprint file vendor yang ikut paket npm
  (hash di atas mencakup test/fakes.ts yang sengaja tidak ikut paket;
   verifikasi dari paket terbit: hitung hash vendor/minicore di dalam tarball)

Perbarui dengan `bun run vendor:minicore` (butuh `../minicore`).
`bun run vendor:check` memverifikasi source, overlay, dan fingerprint final.
