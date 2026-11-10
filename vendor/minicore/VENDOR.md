# vendor/minicore — HOST-EDITABLE (unfrozen)

Salinan MiniCore yang kini **dapat diedit langsung di host** sejak v0.16.0
(keputusan pemilik 2026-11-10: "vendor beku" DIHAPUS agar pengembangan seam
host tidak terhambat di tengah banyak perubahan/upgrade).

Nilai pin di bawah adalah **referensi historis** (provenance sumber asal),
**bukan invarian keras**. `bun run vendor:check` tidak lagi dipakai sebagai
gate; test verifikasi fingerprint dinyatakan nonaktif bersamaan keputusan
unfreeze ini (lihat `test/import-convention.test.ts`,
`test/pack-integrity.test.ts`, `test/phase6ae-vendor-eol.test.ts` yang di-skip).
Bila suatu saat vendor dibekukan kembali, jalankan `bun run vendor:minicore`
lalu pulihkan test tersebut.

- source commit: `0d33571047c0ed3778986108fd42e4bde6828bb0`
- source hash: `c8d214bb8d5eea86`
- overlay sha256: `fa3e3a789782523c3de99c2d31c173789a7fee2bf0f8087267c222ce9b4eebcf`
- files: 20
- hash: `4cee16b60d65d18f`
- shipped hash: `b714c2adc59ea720` (18 file)

Perbarui referensi dengan `bun run vendor:minicore` (butuh `../minicore`).