# Contributing to Minicode

Minicode dilisensikan **MIT** (lihat [LICENSE](LICENSE)) — kontribusi publik diterima.

Semua aturan ada di **[docs/contributing.md](docs/contributing.md)**: setup dev, gate yang wajib hijau, batas lapisan, dan aturan kode (komentar Indonesia yang menjelaskan *mengapa*, UTF-8 tanpa BOM, tanpa magic number tersebar).

```bash
git clone https://github.com/startupmini/minicode && cd minicode
bun install
bun test              # offline/hermetic; live & docker di-skip otomatis
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```

Repo self-contained (kernel di-vendor, tanpa sibling clone); butuh `bun >= 1.0`. Jangan commit kecuali diminta; jangan pernah commit rahasia.
