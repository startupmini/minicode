# AGENTS.md

Petunjuk untuk agent yang bekerja di repo ini. Rencana aktif: [PLAN.md](PLAN.md).
Peta struktur hidup: [docs/ARCHITECTURE.html](docs/ARCHITECTURE.html).
Kontrak terminal FROZEN: [docs/TERMINAL_CONTRACT.md](docs/TERMINAL_CONTRACT.md) —
baca sebelum menyentuh output/rendering apa pun; perubahan perilaku wajib
update dokumen + test peta proteksinya.

## Gate (urutan ini, semua hijau sebelum selesai)

```bash
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```

Coverage naik → naikkan juga minimum di `scripts/coverage-gate.ts`.

## Batas lapisan (dijaga `test/ui-boundary.test.ts`)

- `cli/` boleh impor `src/ui/` dan `src/`; `src/` non-ui DILARANG impor
  `src/ui/`; `src/ui/` DILARANG impor `cli/`, `src/` non-ui, `#minicore`.
- Lintas-lapisan via DI dari composition root (`cli/index.ts`, `cli/setup.ts`):
  `ask`, `setupWhenEmpty`, `setSubAgentSessionFactory`. Tanpa injeksi default
  selalu deny / fail-closed. `providers → config` satu arah (provisioning di
  `src/providers/provision.ts`, `src/config.ts` murni IO).
- Layar `src/ui/screens/` = view murni (props + callback), controller di `cli/`.
- Jalur non-interaktif shell-first (append-only ke scrollback); sesi
  interaktif SELALU TUI alternate-screen (kontrak I16, tanpa opsi linear).
- Ubah struktur/dependensi antarlapisan → wajib update `docs/ARCHITECTURE.html`.

## Jebakan (semua pernah jadi bug nyata)

- `c`/`glyphs` di `src/ui/render/theme.ts` adalah **getter** runtime — jangan
  simpan ke `const` di module scope (nilai membeku saat import).
- Lebar terminal = **kolom**, bukan karakter: pakai `displayWidth` dkk. dari
  `src/ui/render/width.ts` (CJK/emoji = 2 kolom).
- Teks model/tool/berkas = input tak terpercaya: lewatkan `sanitizeAnsi`
  (`src/ui/render/sanitize.ts`) sebelum tampil — termasuk label picker &
  daftar manager (nama model/provider dari jaringan/config lokal repo), dan
  gema dialognya. Sanitasi adalah satu-satunya gerbangnya: modul geometri
  (`width.ts`) SENGAJA mempertahankan sekuens utuh karena footer memakai CHA
  non-SGR untuk merapatkan konteks.
- `cwd` tool file **wajib** dari `ToolContext.cwd`, bukan `process.cwd()`.
- Jangan edit `vendor/minicore/**` kecuali seam aditif eksplisit.
- Komentar Indonesia, jelaskan **mengapa**. Encoding UTF-8 tanpa BOM.
- Jangan commit kecuali diminta; jangan pernah commit rahasia.
