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
bun run web:build   # bangun site/ (rasterisasi og-image.png via @resvg/resvg-js)
bun run web:serve   # preview http://localhost:3000
bun run web:check   # validasi link + anti-rahasia
```

`web:build` tidak menjalankan `web:css` — jalankan `web:css` dulu bila
mengubah `part-*.css`.

## Checklist rilis web — verifikasi pasca-deploy

Jalankan berurutan setiap kali deploy Pages selesai. Prinsip: **field p75
(CrUX) adalah kriteria; lab hanya diagnostik** — jangan dicampur.

### Fase 1 — Verifikasi deploy (hari yang sama, ±5 menit)

- [ ] `https://minicode.fun` menyajikan versi baru — cek string versi di footer (`v…` sama dengan `package.json`)
- [ ] `/docs/changelog.html` berisi entri PLAN terbaru (marker terbaru terlihat)
- [ ] `/rss.xml` valid + `lastBuildDate` diperbarui
- [ ] `/admin.html` Publish jalan (fetch `repos/…/contents` tak 404)
- [ ] Spot-check: 1 halaman docs + 1 posting blog + `/og-image.png` (bukan 404)

### Fase 2 — Lab CWV (hari yang sama, ±10 menit)

Chrome DevTools → Performance → reload dengan **cache disabled + 4× CPU
throttle**, atau Lighthouse mobile di PSI: https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fminicode.fun

- [x] LCP < 2,5 s · TBT rendah (proksi INP di lab) · CLS < 0,1
- [x] LCP element = H1 hero (bukan font/aset yang terlambat) — 2026-09-17: awalnya ikon (entrance hero menyembunyikan H1), fixed dengan pengecualian H1
- [x] Ketiga font `200` dari `fonts.gstatic.com` (Network, tanpa 404/redirect) — ≈80 KB total
- [x] Tidak ada error konsol

### Fase 3 — CrUX field p75 (terjadwal: +2, +6, +12 minggu pasca-deploy)

```bash
MINICODE_PSI_KEY=… bun run web:vitals   # tanpa key: kuota publik terbatas
```

CrUX = jendela bergulir **28 hari** + ambang volume: situs Pages kecil sering
"no data" — itu bukan kegagalan, itu sinyal untuk menunggu trafik. Skrip
otomatis menandai sumbernya (`[field]` vs `[lab]`) dan jatuh ke Lighthouse
bila CrUX kosong. Kriteria rilis: LCP p75 < 2,5 s · INP p75 < 200 ms ·
CLS p75 < 0,1 (seluruhnya GOOD).

**Baseline** (isi tabel di bawah pada tiap pengukuran; simpan nilai, bukan
tangkapan layar):

| Tanggal | Sumber | LCP p75 | INP p75 / TBT | CLS p75 | Catatan |
|---|---|---|---|---|---|
| 2026-09-17 | Lab Lighthouse 13.4.1 mobile, minicode.fun, headless Chrome lokal (bukan field) | 1,9 s | TBT 0 ms | 0,002 | Pra-fix: LCP element = glif ikon (entrance hero menyembunyikan H1) → fixed: H1 dikecualikan dari `rise` |
| 2026-09-17 | Lab Lighthouse 13.4.1 mobile, minicode.fun pasca-fix (headless lokal) | 2,4 s | TBT 0 ms | 0,002 | LCP element = **H1** (satu kandidat) ✓ · score 95 · 0 error konsol · variansi run lab ±0,5 s |
| — | — | — | — | — | — |

## Tulis artikel

Tambah `content/blog/2026-09-12-judul.md`, lalu `bun run web:build`.
Atau buka `/admin.html` setelah deploy, login GitHub, tulis, Publish.

## Desain

Konsep "Flat Paper": tanpa border, garis, shadow. Hierarki dari tipografi +
spasi + blok background. Font docs satu tingkat lebih kecil dari body (14px),
kolom baca 640px. **Scrollbar disembunyikan** (2026-09-17): `scrollbar-width:
none` + `::-webkit-scrollbar { display: none }` — trek+thumb native terlihat
tidak flat. Yang dihapus hanya tampilannya; gulir tetap jalan (roda, trackpad,
sentuh, keyboard) karena `overflow` container tidak disentuh. Konsekuensi
sadar: tak ada indikator posisi halaman maupun drag pada bar.
Ikon Material Symbols Outlined via Google Fonts (subset `icon_names`, hanya
yang benar-benar dirender) dengan fallback sembunyi.

Arah 2026-09-17 (audit frontend-design): **JetBrains Mono = suara merek** —
display, judul docs/blog, label data, dan wordmark memakai mono (produk ini
hidup di terminal); body prosa tetap Inter. Nomor hanya untuk urutan nyata
("Cara kerja" 1–5 ala ledger). Tanpa eyebrow tracked-caps di tiap heading,
tanpa panah tempelan di link, tanpa ikon dekoratif di kartu, tanpa pola `·`
antar-meta. Satu momen gerak: entrance hero (reveal-on-scroll per kartu
dihapus sadar).

### Prosa rata kanan-kiri (2026-09-17)

Paragraf prosa dijustify (`part-01-base.css`), **hanya paragraf**: heading,
daftar, tabel, dan blok kode tetap rata kiri agar tetap mudah dipindai.
Baris terakhir rata kiri (`text-align-last`) + `hyphens: auto` (no-op bila
browser tak punya kamus bahasa `id`). Selector sengaja sempit — `.feat p`
(kolom ±280px) dan `.footer p` (34ch) terlalu sempit untuk dijustify.
`text-wrap: pretty` dibuang dari prosa karena diabaikan browser saat teks
dijustify. Lebar kolom baca jadi 640px (dari 720px): justify di baris ±115
karakter menghasilkan "sungai" celah antarkata.

### Halaman docs = bahasa desain landing (2026-09-17)

Semua halaman docs memakai `<header class="doc-head">`: kicker = kelompok
SUMMARY (`readDocNav`), judul mono skala display, lalu isi. Daftar isi halaman
panjang jadi ledger bernomor; prev/next di bawah kini memawa judul halaman
tujuan (dulu hanya "‹ Prev").

`/docs/` (hub) diperlakukan seperti landing kecil: tanpa sidebar — direktori
`<nav class="doc-grid">` digenerate dari SUMMARY (judul + desc kurasi
`DOC_META`) tepat di bawah header, lalu prosa. Section `## Navigasi` README
dibuang dari **web saja** (`stripMdSection`) karena itu tabel yang sama 28
baris; `docs/README.md` tetap utuh untuk pembaca repo. Di ponsel, menu
sidebar `<details>` mulai TERTUTUP (`app.js`) supaya konten tetap pertama;
tanpa JS markup tetap terbuka (degradasi jujur).

## Eksperimen urutan landing (A/B, 100% lokal)

Menguji apakah "Serahkan tugas" lebih baik diletakkan **sebelum** "Cara kerja".

- **Varian**: `a` = Cara kerja dulu (DOM apa adanya), `b` = Tugas dulu.
- **Mekanisme**: keduanya bersebelahan di DOM, dibungkus `.pair` di
  `scripts/build-web.ts`; `order` di `web/part-04-sections.css` menukar posisi
  visualnya dari `data-order` pada `<html>` yang dipasang **pre-paint** oleh
  skrip di `web/layout.html` (tanpa kedip). DOM tetap kanonik → SEO, urutan
  tab, screen reader, dan pengunjung tanpa JS semuanya dapat varian A.
  Catatan: karena `.pair` flex, `section` di dalamnya wajib `width: 100%`
  — `margin: 0 auto` menonaktifkan *stretch* flex, dan dulu `#tugas`
  menyempit 1080→616px di kedua varian (geometri kontrol ikut berubah).
- **Penetapan**: 50/50, `Math.random()`, sticky per browser
  (`localStorage: minicode-exp-order`). Uji manual: `?order=a` / `?order=b`
  (override tidak dipersistenkan dan pengukuran dilewati, agar sampel bersih).
- **Metrik** (disimpan di browser pengunjung, `minicode-exp-v1`): kunjungan per
  varian, kedalaman gulir maksimum, jangkauan tiap section (band tengah
  viewport), aksi di bagian Tugas (klik tombol salin/tautan), waktu aktif.
  Penulisan idempoten per sesi → aman di-flush berkali-kali (milestone 25%,
  ganti tab, `pagehide`).
- **Laporan**: buka `/?exp=report` di browser yang datanya ingin dilihat —
  tabel per varian + jangkauan section + peringatan sampel kecil + tombol
  salin JSON. `?exp=reset` menghapus data + penetapan varian. `?exp=off` /
  `?exp=on` mematikan/menyalakan pengukuran; `navigator.doNotTrack === "1"`
  juga melewati pengukuran.
- **Tanpa analitik keluar**: tidak ada satu pun request jaringan — dijamin
  guard test (app.js dilarang memuat `fetch(`/`XMLHttpRequest`/`sendBeacon`/
  `document.cookie`). Konsekuensinya: agregasi lintas pengunjung TIDAK otomatis;
  pemilik harus mengumpulkan JSON dari tiap penguji. Kalau nanti butuh angka
  lintas pengunjung, itu keputusan sadar yang mengubah janji situs — bukan
  pekerjaan mekanis.

## Motion

Satu token durasi (`--t: 0.15s`, `--t-slow: 0.5s`, di `part-01-base.css`);
aturan gerak hidup di `part-06-motion.css`. Hanya opacity/transform (+
color/background 0.15s) — tanpa properti pemicu layout, tanpa shadow.
Entrance hero + reveal-on-scroll + scrollspy digerakkan `app.js` di balik
gate class `.js` (tanpa JS konten tampil utuh); transisi antar-halaman
pakai `@view-transition: navigation auto` (progresif — browser lama abaikan).
Semua mati total di `prefers-reduced-motion`. FAQ memakai grid-rows agar
buka-tutup halus murni CSS.
