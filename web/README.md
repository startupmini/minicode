# Web Minicode

Website statis Minicode: landing + docs + blog + admin. Tanpa framework,
tanpa dependensi runtime baru.

## Lokasi file

- `web/` — template + aset sumber (`layout.html`, `part-*.css`, `app.js`,
  `admin.html`, `assets/`). `styles.css` adalah hasil gabungan, jangan edit
  manual — edit `part-*.css` lalu `bun scripts/build-web-css.ts`.
- `content/blog/*.md` — artikel (frontmatter `title/date/tags/desc`).
- `scripts/build-web.ts` + `scripts/web/*.ts` — SSG mini (md ke HTML).
- `site/` — hasil build, gitignored, di-deploy via GitHub Actions.
- `test/web-build.test.ts` — jaga link internal + anti-bocor rahasia.

## Perintah

```bash
bun run web:css     # gabung part-*.css -> styles.css
bun run web:build   # bangun site/
bun run web:serve   # preview http://localhost:3000
bun run web:check   # validasi link + anti-rahasia
```

## Tulis artikel

Tambah `content/blog/2026-09-12-judul.md`, lalu `bun run web:build`.
Atau buka `/admin.html` setelah deploy, login GitHub, tulis, Publish.

## Desain

Konsep "Flat Paper": tanpa border, garis, shadow. Hierarki dari tipografi +
spasi + blok background. Font docs satu tingkat lebih kecil (12.5px).
Ikon Material Symbols Outlined via Google Fonts dengan fallback sembunyi.

## Motion

Satu token durasi (`--t: 0.15s`, `--t-slow: 0.5s`, di `part-01-base.css`);
aturan gerak hidup di `part-06-motion.css`. Hanya opacity/transform (+
color/background 0.15s) — tanpa properti pemicu layout, tanpa shadow.
Entrance hero + reveal-on-scroll + scrollspy digerakkan `app.js` di balik
gate class `.js` (tanpa JS konten tampil utuh); transisi antar-halaman
pakai `@view-transition: navigation auto` (progresif — browser lama abaikan).
Semua mati total di `prefers-reduced-motion`. FAQ memakai grid-rows agar
buka-tutup halus murni CSS.
