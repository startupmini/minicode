# PLAN.md — Rencana penyempurnaan aktif

**Untuk agent AI yang melanjutkan pekerjaan ini.** Dokumen ini adalah satu-satunya rencana yang harus dieksekusi. Rencana lama (`docs/PLAN_UIUX_V6.md`) adalah **arsip** — semua itemnya sudah selesai; jangan dikerjakan ulang.

Basis: audit UI/UX menyeluruh (V6), uji live dua gateway nyata (V7), dan bug hunter UI tiga ronde (V8). Riwayat lengkap di [CHANGELOG.md](CHANGELOG.md).

---

## Keadaan saat ini — baca ini dulu

Jalankan sendiri, jangan percaya angka di dokumen:

```bash
bun test                  # harapan: semua hijau, 0 fail
bun x tsc --noEmit        # harapan: tanpa keluaran
bun run lint              # harapan: exit 0 (warning boleh ada)
bun run gate:coverage     # harapan: melewati min 80 funcs / 84 lines
bun run gate:pack         # harapan: 22 pemeriksaan lulus
bun run extreme           # harapan: 0 bypass, semua pass
bun run gate:fast         # gabungan per-commit/CI: tsc+lint+test+coverage+pack+bash+bench smoke+audit harness
bun run gate:slow         # extreme fuzz+shadow-git+MCP adversarial (nightly/manual, workflow slow.yml)
```

Kondisi yang sudah dicapai dan **tidak boleh mundur**:

- REPL bisa dipakai (dulu mati bisu pada prompt pertama).
- Lebar karakter dihitung per KOLOM terminal (`src/ui/render/width.ts`), bukan per karakter.
- Teks model/tool disanitasi (`src/ui/render/sanitize.ts`) — hanya SGR yang lewat.
- Biaya sesi kumulatif benar; `--budget` benar-benar memutus (+ `--budget-strict` untuk model tanpa harga, yang cost-nya tak dikenal).
- Error provider tampil ringkas + saran, bukan dump JSON.
- Semua overlay menghormati ukuran terminal sungguhan.
- Bahasa UI diarahkan ke English-only pada surface UI aktif; glyph tetap punya fallback ASCII.

---

## Status eksekusi terbaru (update 2026-09-22)

- ✅ AUDIT KEAMANAN 2026-09-22 — F-CRIT (bypass kunci owned-state via link
  internal) DIPERBAIKI: `write_file linkdir/config.json` menembus `.minicode/`
  lewat junction/symlink karena cek owned-state membaca STRING argumen, bukan
  target nyata. Kunci kini ganda: (1) `isOwnedStateReal` di
  `src/policy/jail.ts` (realpath sinkron ke induk terdekat yang ADA +
  rekonstruksi ekor) dipakai semua tool tulis di `src/policy/permission.ts`,
  dengan carve-out string lebih dulu (restore `.trash/`, skrip `hooks/`) dan
  symlink internal SAH ke berkas biasa tetap bisa ditulis; (2) bash-guard
  menahan PEMBUATAN link yang operannya sensitif/owned-state — SEMUA operand
  non-flag dicek (bukan satu slot posisi), sehingga urutan terbalik
  `fsutil hardlink create LINK TARGET`, reshuffle flag (`ln --symbolic`,
  `ln -s --`), dan nilai menempel `New-Item ... -Target:.minicode` ikut
  tertahan. Regresi permanen: `test/deny-reason.test.ts` (tulis via junction
  deny / link jinak & hooks allow), `test/bash-guard-escaping.test.ts`
  (14 bentuk serangan + 5 tetangga jinak), korpus gate:bash 62 pola serangan
  + 24 perintah sah (0 bypass / 0 over-block).


- ✅ INTEGRASI `fix/setup-wizard-spinner` → main (2026-09-22): branch dibubarkan,
  kerja terbaiknya dipindah selektif ke main 0.10.0 (TUI branch sudah digantikan
  fullscreen+popup+i18n): fix bash-guard caret/%VAR%/`for` (security), hold
  layar interaktif + spinner `createSpinner` (wizard tak lagi macet di
  "Menyiapkan sesi…"), `minicode acp` (JSON-RPC stdio), kontrak exit 0/1/2 +
  envelope `exec --json`, F1 token (`Turn:` + `totalTokens` per baris trace),
  F2 bench harness beku + taksonomi gagal, F3 `MINICODE_COMPACT_KEEP_TURNS` +
  anti-thrash kompaksi, F4.1 skills `disable-model-invocation` + aset sibling,
  F4.2 `gate:fast`/`gate:slow` + `slow.yml`, vendor shipped hash, dan
  invalidasi jangkar render `askLine` saat geometri berubah (I30,
  `test/input-resize.test.ts`).

- ✅ SATU FOKUS DI `main` (2026-09-22): seluruh branch pengembangan
  dibubarkan setelah kerja terbaiknya diadopsi — `fix/setup-wizard-spinner`,
  `fix/input-resize-invalidation` (adopsi terakhir: `7ec12b3`), dan
  `fix/uiux-audit-findings` (sudah jadi bagian main 0.10.0) dihapus di lokal
  DAN origin; tag `backup/*` dihapus setelah tiap perubahan terverifikasi ada
  di main. Pembersihan lanjutan: 12 branch remote sisa
  (`blog/query-gratis`, `docs-sync`, `docs/sitemap-attributes-review`,
  `docs/solution-explorer-decisions`, `feat/indexnow-weekly`,
  `feat/seo-audit-fixes`, `feat/sitemap-lastmod`,
  `feat/url-integrity-guard`, `release/0.9.29`, `release/0.10.0`,
  `freebuff/…`, `fix/input-resize-invalidation`) diverifikasi dulu
  (`git merge-base --is-ancestor` → semuanya bagian main; satu-satunya branch
  ber-commit unik sudah diadopsi sebagai `d4133ef`) lalu dihapus. Sekarang
  `git ls-remote --heads origin` hanya `refs/heads/main` dan lokal hanya
  `main` + `origin/main`: tak ada branch paralel yang bisa saling tindih lagi.

## Status eksekusi sebelumnya (2026-09-17)

- ✅ SCRIPT `web:indexnow` + CHECKLIST GSC (2026-09-17): submit indeks tidak
  lagi curl manual di sesi — `bun run web:indexnow` baca site/sitemap.xml,
  validasi host (CNAME), tolak URL asing, cek key file LIVE di produksi
  (syarat protokol), POST urlList; `--dry-run` utk QA. Checklist Search
  Console manual (submit sitemap, request indexing, pantau Pages/Performance)
  terdokumentasi di web/README.md — langkah browser-only pemilik.
  Otomatis (2026-09-18): workflow web.yml menambah job `indexnow` (needs:
  deploy) — tiap deploy sukses langsung submit sitemap ke IndexNow tanpa
  langkah manual; jalur manual jadi fallback ad-hoc.
  Guard integritas URL (2026-09-18): web:check + test web-build kini
  memvalidasi SEMUA URL absolut minicode.fun di llms.txt/llms-full.txt/
  rss.xml menunjuk file site/ yang ada (±160 kemunculan) — lahir dari
  audit yang menemukan ](../PLAN.md) lolos mapper (404 konteks root).
  Jadwal mingguan (2026-09-18): web.yml cron Senin 03:17 UTC — tanpa
  deploy pun sitemap tetap dikirim (build/deploy di-skip saat schedule,
  indexnow jalan utk deploy sukses ATAU skipped); concurrency grup pages
  dipindah ke job deploy agar run terjadwal tak bisa membatalkan deploy
  push yang sedang berjalan.
  Sitemap lastmod (2026-09-18): tiap URL kini bawa <lastmod> — post blog
  dari frontmatter (sumber sama via blogLastmod, tak maju tiap deploy),
  halaman lain stempel waktu build; guard test mengunci 34 entri +
  silang-cek tanggal post vs sumber. Atribut lain DITINJAU & DITOLAK
  (2026-09-18): priority/changefreq diabaikan Google (docs Search Central
  dicek langsung), hreflang tak relevan utk situs satu bahasa — keputusan
  dicatat web/README.md.
  Audit UI/UX (2026-09-18): 6 temuan terukur diperbaiki — (1) caption
  panel gelap memakai token tetap --term-dim (7,1:1/7,9:1; dulu --mut
  ikut tema = 3,12:1 di light); (2) tap target hero-links & link kartu
  29–30px (dulu 16–22px); (3) nav ≤520px wrap, NOL display:none — sistem
  .keep lama menyembunyikan Blog/Changelog dan menambah keep terbukti
  overflow 360px (terukur ±374px); (4) aria-current nav utama via skrip
  layout (exact > prefix, satu mark); (5) intro paragraf di bawah h2
  'Kapan cocok'; (6) badge hero: MIT→LICENSE, Bun→bun.sh. Guard test
  navigasi mobile direvisi ke strategi wrap.
  Solution Explorer pasca-audit (2026-09-18): mekanisme perbaikan
  dipertahankan setelah eksplorasi alternatif-material dgn gate
  terukur — (F-1) token tetap dipilih atas override spesifisitas,
  !important, dan duplikasi selector (gate: kegagalan baru harus lebih
  spesifik & eksplisit); (F-2) padding dipilih atas min-height, wrapper,
  dan pseudo-element besar (gate: tanpa box baru, layout konten tak
  geser); (F-3) wrap dipilih atas keep-plus (overflow 360px terukur),
  menu sheet (butuh JS+state utk 5 link), dan sticky-secondary (nol
  bukti scroll depth); (F-4) skrip exact>prefix dipilih atas build-time
  attr (butuh plumb baru) dan CSS-only (tak bisa exact-match). Upgrade
  path tercatat: media pointer:coarse & validasi user nyata.
- ✅ AUDIT SEO + EKSEKUSI TEMUAN (2026-09-18): full crawl 36 URL + 3 SERP +
  probe authority — fondasi teknis sehat (nol orphan, canonical↔sitemap
  34/34 konsisten, 404 benar, BreadcrumbList 32/32); risiko utama di
  observabilitas Bing & authority nol (brand SERP "minicode" tak muncul —
  normal utk domain 3 hari). Diperbaiki dari sisi repo: (1) plumb
  BingSiteAuth.xml — file hasil download bing.com/webmasters diletakkan di
  web/, build menyalinnya utuh (pola key IndexNow) + guard test; klik
  verifikasi BWT tetap tanggung jawab browser pemilik; (2) 3 judul post
  dipangkas <=65 char TERMASUK sufiks " — Minicode" dari layout — web:check
  kini menjaga (title kepanjangan = FAIL deploy); (3) blok "Postingan
  terkait" di tiap permalink via relatedPosts() (tag-share dulu, fallback
  post terbaru, max 3; dulu 4 post hanya 1 inbound dari index); (4) Article
  JSON-LD + author Organization + inLanguage id-ID; (5) homepage npm ->
  https://minicode.fun (kanal authority; field repository tetap ke repo).
  Temuan terkoreksi saat eksekusi: post ternyata SUDAH ber-JSON-LD Article
  + FAQPage SUDAH ada — crawl extractor awal melewati @graph. Peluang  tercatat (belum dieksekusi): SERP query kategori berbahasa Indonesia
  100% berbahasa Inggris = celah konten ID (Wave 2–3).
- ✅ AUDIT DOKUMENTASI (2026-09-18, skill docs-cleanup — audit dulu, bukti sebelum mutasi):
  inventaris 38 file md + cek link relatif (semua resolve) + ref lama (bersih;
  sisa nama lama hanya di dokumen historis — tempat yang benar) + deteksi
  orphan. TEMUAN utama: 5 dokumen internal kontributor (TERMINAL_CONTRACT,
  CONTROL-PLANE-MAP, UI_RENDER_PIPELINE, HARNESS, PLAN_UIUX_V6) TAK TERJANGKAU
  dari navigasi mana pun (SUMMARY/docs index/sidebar web/llms) — semuanya
  aktif dirawat (2 di-update hari ini), jadi KEEP + integrasi nav, BUKAN hapus.
  Eksekusi: grup baru "Internal & Arsitektur (untuk kontributor)" di SUMMARY
  (sidebar web + llms-full ikut otomatis — satu sumber), DOC_META desc web per
  dokumen (dari isi sebenarnya), baris nav di docs/README.md. KASKADE yang
  ditangkap guard: (a) mapper link md diperluas menerima nama kapital/
  underscore + bentuk ../CHANGELOG (baris 1 PLAN_UIUX_V6 memuat
  ](../CHANGELOG.md) yang dulu lolos TANPA rewrite — kelas bug ../PLAN.md);
  (b) guard rahasia web:check false-positive pada id heading "risiko-
  disengaja" (kata Indonesia kebetulan pola sk-...) → scan kini konten tanpa
  atribut id/href (teks nyata tetap penuh); (c) test count sitemap 34 →
  floor >=34 (halaman tumbuh; invariant lastmod tetap dijaga).
  Gate: tsc OK, biome bersih, 2166 test 0 fail, web:check lolos (39 halaman).
- ✅ ARTIKEL #2 QUERY GRATIS (2026-09-18): "Apakah ada alternatif Claude Code
  yang gratis?" — target kueri ID dari celah SERP audit SEO (10/10 hasil
  berbahasa Inggris). Angle beda dr artikel #1 (open source): bedah 3 lapis
  "gratis" (tool MIT / bayar-per-pakai API / nol rupiah via Ollama lokal) +
  trade-off model lokal ditulis terbuka; pengalaman first-hand (/undo,
  --budget fail-closed, biaya tampil per langkah, doctor); anti-kanibal via
  cross-link dua arah dgn artikel #1. Title 57 char (guard 65), desc 156.
  Post ke-6 → build 40 halaman; RSS/sitemap/Article LD+inLanguage otomatis
  dari builder. Gate: web:check lolos, tsc OK, web test 52/52.
- ✅ FIX relatedPosts slice (2026-09-18): verifikasi produksi menemukan bug
  desain — slice(-max) mengambil kandidat PALING TUA; post tag-share paling
  relevan terbuang begitu kandidat >3 (terbukti: post baru tak muncul di blok
  artikel #1). Kini slice(0, max) — relevan didahulukan, fallback mengisi
  sisa. Guard unit test relatedPosts tetap hijau (premisnya tidak menyentuh
  urutan).
- ✅ DISCOVERABILITY AI/AGENT (2026-09-17): situs mudah ditemukan & dipelajari
  AI-assistant/agent yang browsing: (1) `llms-full.txt` — korpus seluruh docs
  dalam satu markdown (±140 KB) digenerate dari SUMBER sama dgn sitemap
  (SUMMARY) + status PLAN; komplemen `llms.txt` (peta, sudah ada); (2)
  `robots.txt` menyebut 14 crawler AI eksplisit (GPTBot, ClaudeBot,
  PerplexityBot, OAI-SearchBot, Google-Extended, dst) semua di-ALLOW —
  kebijakan situs terbaca sendiri oleh tiap bot; (3) FAQPage JSON-LD di
  landing dari SATU sumber FAQ (diekspor `FAQS`, HTML & JSON-LD tak bisa
  saling stale) — jawaban FAQ = konten paling sering dikutip assistant;
  (4) metadata GitHub: description + homepage minicode.fun + 10 topics;
  (5) keywords npm diperluas (terminal, llm-agent, openai, anthropic,
  ollama). Guard test menjaga llms-full urut vs SUMMARY, robots AI, dan
  @graph FAQPage+SoftwareApplication.
- ✅ RENAME PAKET NPM 0.9.26 — `@miniroom/minicode` → `minicode-ai`
  (2026-09-17): akar gagal rilis 0.9.24/0.9.25 = PUT ke registry → 404 (scope
  `@miniroom` tak lagi bisa publish); `minicode-cli` sudah diambil pihak lain;
  nama bare `minicode` ditolak aturan kemiripan registry (403 "too similar to
  `mini-code`") — terbukti saat publish, bukan asumsi. Kontrak instalasi:
  `npm install -g minicode-ai` (bin tetap `minicode`, config/state
  `~/.minicode/` tak berubah). Referensi diganti di package.json,
  update-check/auto-update (notifikasi + auto-update), README,
  docs/getting-started, landing, blog; guard release-readiness kini
  MENYEGAL nama scoped lama di permukaan install. Tag `v0.9.26` → Publish →
  `minicode-ai@0.9.26` TERBIT (workflow hijau, tarball terverifikasi dari
  registry). Pengumuman publik: blog `rename-paket-npm-minicode-ai` +
  changelog.
- ✅ UJI A/B URUTAN LANDING + ANALITIK LOKAL (2026-09-17): varian A = "Cara
  kerja" dulu, B = "Serahkan tugas" dulu. Ditukar lewat CSS `order` dari
  `data-order` di `<html>` yang dipasang pre-paint di `web/layout.html` — DOM
  tetap kanonik (SEO, urutan tab, screen reader, tanpa-JS = A), tanpa kedip.
  Dua section bersebelahan dibungkus `.pair` (`build-web.ts`). **Bug ditemukan
  saat verifikasi preview:** percobaan pertama memakai `main { display: flex }`
  + `main > * { order: 10 }` dan MENGANGKAT semua section lain ke atas (nilai
  order sama menang atas posisi dokumen) — sudah diganti dan dijaga test
  ("body.home main {" dilarang). Penetapan 50/50 sticky per browser + override
  `?order=a|b` (tidak dipersistenkan; pengukuran dilewati agar sampel bersih).
  Metrik lokal (`minicode-exp-v1`): kunjungan, kedalaman gulir maks, jangkauan
  section (band tengah viewport), aksi di bagian Tugas, waktu aktif; flush
  idempoten per sesi (milestone 25%, ganti-tab, pagehide) sehingga bacaan
  panjang tidak hilang. Laporan `/?exp=report` (tabel per varian + jangkauan +
  peringatan n<30 + salin JSON), `?exp=reset`, opt-out `?exp=off`/DNT=1.
  NOL request keluar — dijaga test (fetch/XHR/sendBeacon/cookie dilarang di
  app.js), sesuai janji "tanpa analitik keluar". Konsekuensi jujur: agregasi
  lintas pengunjung manual (salin JSON per penguji), bukan otomatis. Section
  landing `#cocok`/`#batasan`/`#faq` diberi id agar jangkauan bisa dilaporkan.
  Guard: 3 test baru. Gate `46 pass 0 fail / tsc / lint 0 warn / web:check
  12/12`.

- ✅ SCROLLBAR DISEMBUNYIKAN (2026-09-17): permintaan desain — trek+thumb
  native (termasuk versi "tipis" lama) tidak flat. `* { scrollbar-width:
  none; -ms-overflow-style: none }` + `*::-webkit-scrollbar { width:0;
  height:0; display:none }` di `part-01-base.css`; aturan lama
  (`thin` + `scrollbar-color` + thumb/track) dihapus, bukan ditumpuk.
  Fungsi TIDAK dikorbankan: `overflow` container tak disentuh, jadi roda
  mouse, trackpad, sentuh, keyboard (PageUp/Down, spasi, Home/End),
  drag-select, dan gulir internal `pre`/tabel/menu docs tetap jalan —
  diverifikasi di preview: `scrollbar-width` computed `none`, dokumen
  `scrollTop=700` terpasang, `pre` mencapai batas gulir (26/26px).
  Konsekuensi sadar: indikator posisi halaman & drag bar hilang.
  Guard: 1 test baru (aturan ada + aturan lama absen + container gulir
  tak dimatikan) + test lama "design language flat" disinkronkan dari
  `scrollbar-width: thin` → `none`. Gate `43 pass 0 fail / tsc / lint
  0 warn / web:check 12/12`.

- ✅ ROMBAK HALAMAN DOCS + PROSA JUSTIFY (2026-09-17): seluruh halaman docs
  kini memakai bahasa desain landing — `<header class="doc-head">` dengan
  kicker kelompok SUMMARY + judul mono skala display; daftar isi halaman
  panjang jadi ledger bernomor (nomor bawaan heading di-strip dari label agar
  tak dobel); prev/next di bawah memawa judul halaman tujuan. Hub `/docs/`
  jadi "landing dokumentasi": tanpa sidebar, direktori `<nav class="doc-grid">`
  digenerate dari SUMMARY (judul + desc DOC_META) di bawah header, dan section
  `## Navigasi` README dibuang DI WEB saja (`stripMdSection`; README tetap utuh
  untuk repo). Paragraf prosa dijustify site-wide (hanya paragraf — heading,
  daftar, tabel, kode tetap rata kiri) + `hyphens: auto` + baris terakhir rata
  kiri; `--w-doc` 720→640px dan `--fs-doc` 12.5→14px karena baris ±115 karakter
  bikin celah antarkata menganga; `text-wrap: pretty` dibuang (diabaikan saat
  justify). Bug nyata yang ketemu saat verifikasi preview: menu docs ponsel
  terbuka di ATAS konten (kini ditutup app.js hanya di layar kecil), scrollbar
  horizontal di dalam menu, dan prev/next bertajuk yang tidak muat berdampingan
  di kolom ±342px (kini ditumpuk di ≤900px). Guard baru: header docs, TOC tanpa
  nomor dobel, hub (grid ⊇ SUMMARY, tanpa sidebar, tabel Navigasi absen),
  justifier base CSS, menu ponsel tertutup. Gate `2039 pass 0 fail / tsc / lint
  0 warn / web:check 12/12`.

- ✅ SEO Riset+Eval+Fix (2026-09-17): audit live minicode.fun (robots+sitemap
  ok, www/http 301 ke apex-https, 404 code benar) + riset gallery rich-result
  Google 2026 (SoftwareApp butuh rating — TIDAK difabrikasi; Article/
  Breadcrumb masih hidup). Fix: llms.txt digenerate dari SUMMARY (404 →
  peta AI-crawler), BreadcrumbList JSON-LD di docs/blog/changelog, dedup
  judul "Minicode — X — Minicode". Search API mati saat riset — kompetitor
  SERP belum diverifikasi; lainnya dari dokumen Google langsung.
- ✅ CHECKLIST RILIS WEB (2026-09-17): checklist pasca-deploy 3 fase di
  `web/README.md` (verifikasi deploy → lab CWV → CrUX field p75 pada +2/6/12
  minggu) + skrip `web:vitals` (PSI API, nol dependensi; tandai [field] vs
  [lab], jatuh ke Lighthouse bila CrUX "no data", pesan 429 actionable).
  Baseline CWV dibiarkan kosong-jujur: butuh Chrome/trafik, diisi di tabel
  README saat pengukuran pertama.
- ✅ CHANGELOG WEB (2026-09-17): halaman /docs/changelog.html kini
  digenerate otomatis dari section ini saat build (marker guard test:
  GUARD-CHLOG-SATU); docs/changelog.md jadi stub anchor SUMMARY.
- ✅ AUDIT LAB CWV FASE 2 (2026-09-17): Lighthouse 13.4.1 mobile vs
  minicode.fun — score 98, LCP 1,9 s, TBT 0 ms, CLS 0,002, 0 error konsol.
  Satu kriteria gagal lalu diperbaiki: entrance hero menyembunyikan H1 sehingga
  LCP element = glif ikon, bukan H1 — H1 kini dikecualikan dari `rise`
  (part-06-motion.css), terverifikasi LCP = H1 di lab ulang DAN di produksi
  pasca-deploy (2,4 s, satu kandidat H1, score 95). Baseline tercatat
  di web/README.md. Field CrUX tetap menunggu fase 3 (+2/6/12 minggu).
- ✅ ARTIKEL #1 RISET KEYWORD (2026-09-17): "Alternatif Claude Code yang
  open source: Minicode di terminal" — perbandingan jujur (tabel 8 baris
  berkait ke docs), sisi yang belum dimiliki ditulis terbuka, migrasi
  kebiasaan CLAUDE.md → AGENTS.md, target kueri "claude code alternative
  open source". Tabel markdown kini ikut distyle di .article.
- ✅ KONTEN LANDING "SERAHKAN TUGAS" (2026-09-17): riset inventaris konten
  landing kompetitor (aider, Claude Code docs, OpenCode, Codex CLI) menemukan
  pemuat konversi yang hilang: contoh tugas nyata yang bisa disalin. Section
  baru: 4 perintah nyata (fix test, upgrade deps, --plan, commit) + tombol
  salin per baris (data-copy), link ke docs/exec. Angka skala ala kompetitor
  sengaja TIDAK dipalsukan — kejujuran tetap pembeda.
- ✅ ROMBAK LANDING (2026-09-17): konsep "Bukti, bukan janji" — hero kini
  klaim → install-bar (CTA primer, blok gelap prompt) → transkrip nyata
  sebagai objek hero; section "Kenapa berbeda" dihapus (duplikat janji hero
  + safety); "Cara kerja" jadi strip 5 kolom bernomor di band --soft;
  guard test proof disinkronkan (class boleh bertambah, tetap tepat satu).
- ✅ AUDIT WEB + FIX P0–P2 (uncommitted, 2026-09-17): hanya lapisan web
  (`web/`, `scripts/web*`, workflow, test web) — runtime minicode tak disentuh.
  P0: token GitHub admin tak lagi dipersist ke sessionStorage (+
  `autocomplete=new-password`, publish disabled saat request, beforeunload
  draf); RSS `&` di link/guid ter-escape + `lastBuildDate` + `id-ID`.
  P1: ordered list md dirender `<ol>` sungguhan (dulu `<p>`); delay reveal
  via custom property `--d` (bukan inline transitionDelay); reset CSS
  selektif (list/table/details tak lagi dipatuhin `*{margin:0}`); job CI
  `web-check` untuk PR (dulu hanya push main).
  P2: subset ikon Material Symbols via `icon_names` (verifikasi curl:
  1 @font-face); og:image dirasterisasi ke PNG 1200×630 via
  `@resvg/resvg-js` (dev-dep; gagal render → SVG fallback, build tak
  gagal); `text-wrap: balance/pretty`, `tabular-nums`, `…` tipografis
  text-node-only; `web:build` tak lagi double-run CSS assembler;
  `layoutCache` per-path. Guard baru: `<ol>`, ellipsis href-utuh, RSS
  escape, admin bebas-storage-token, subset ikon, og PNG, docs-tanpa-
  nested-list. Gate: `web:check` 12/12, `test/web-build.test.ts` 29/29,
  `bun test` 2025 pass 0 fail, tsc + lint 0 warn.
  PERF (skill performance, static — tanpa trace di env ini): Inter statis
  5 instance → variable `wght@400..700` (1 file/subset); ikon axis variable
  → pin statis `@24,400,0,0` (1 @font-face); JBM admin cukup 600;700;
  `font-weight` 650 → 600 (cakup rentang variabel, tanpa sintesis);
  Speculation Rules prerender `/docs/*` eagerness moderate (progresif).
  DITOLAK sadar: inline critical CSS (total CSS ±4–5 KB gzip — satu request
  render-blocking lebih murah daripada dobel HTML); preload URL kit gstatic
  (URL kit berubah per subset — rapuh); Cache-Control custom (GitHub Pages
  tidak mengizinkan header custom).
- ✅ RE-ENVISION NAV DOCS (2026-09-17): subsistem terlemah = nav docs mobile
  (27 link men-stack di atas konten). Dibangun ulang ke `<details>` collapsible
  sticky di bawah topbar: konten selalu pertama, menu satu tap; desktop
  selalu-terbuka (sinkron `toggle` di app.js, summary disembunyikan CSS);
  no-JS mobile = terdegradasi terbuka (dulu), desktop utuh dari markup.
  Scroll-margin anchor mobile naik ke 116px (topbar+summary). Link, highlight
  aktif, kelompok SUMMARY, sticky — semua dari draft lama dipertahankan.
  Verifikasi permukaan nyata: harness inline css+js hasil build dieksekusi
  preview (desktopLock=true, 27 entri, active="Tools (37)", mobile rules 8),
  bukan hanya grep. Harness dihapus setelah uji.
- ✅ ADVERSARIAL REVIEW (2026-09-17): 4 bug hasil review ditemukan + diperbaiki
  (a) nav hilang di desktop: user tutup menu di mobile → lebarkan layar, CSS
  pindah branch tanpa event toggle → kini matchMedia('change') membuka ulang
  (+ fallback addListener Safari lama); (b) sticky no-op mobile: aside = grid
  item satu baris → containing block setinggi dirinya → .doc-layout mobile
  jadi display:block; (c) pemecah <ol>: baris indentasi lanjutan item jatuh ke
  <p> → list pecah, penomoran restart (75 lokasi di docs, security.md dst.) →
  renderer menyambung ke <li> sebelumnya; blank TETAP memutus (kontrak lama);
  (d) tanggal blog tanpa timeZone UTC → geser mundur sehari di mesin TZ
  negatif → timeZone:'UTC'. Ketiganya diverifikasi live (harness inline css
  +js build asli): matchMedia path, sticky posisi, <ol> utuh, fonts 200 dari
  gstatic (Inter variable, JBM, ikon subset).
- ✅ GUARD ADVERSARIAL (2026-09-17): 4 test baru di web-build.test.ts menjaga
  bug adversarial agar tak kembali — masing-masing TERBUKTI GAGAL via mutasi
  kode lama (hapus listener change / blok lanjutan / timeZone non-UTC / CSS
  grid+top:0), lalu sumber dipulihkan: (1) lock nav docs di DUA jalur
  (matchMedia change + toggle, addListener fallback); (2) baris lanjutan list
  menyambung <li>, <ol> tak pecah (blank tetap memutus); (3) blogDateFmt
  diekspor (pola diekspor-untuk-test), timeZone UTC + format "5 Jan 2026";
  (4) mobile display:block + sticky top:60px, desktop grid + summary:none.
  Gate `2045 pass 0 fail / tsc / lint 0 warn / web:check 12/12`.
- ✅ P0-P9 tuntas dan dihapus dari plan (commit `e143db2` 0.9.0 + `b8b5749` 0.9.1): guardrail, coverage, overlay, English-only, tema, data-at-rest, session, tool-layer, env/command, CLI hardening, memory/RAG P0-P2.
- ✅ P12 UI Shell-Max DIEKSEKUSI `b8b5749` (9.3/10): `/copy` OSC52, Ctrl+R/Ctrl+J, statusline rich, wrap/table/diff/picker, harness output-driven. Gate `tsc PASS / lint 9 warn / 1224 pass 0 fail / coverage 81.44/83.65 / pack 22/22`.
- ✅ P13 P0 + P10 P0 + P11 P0 DIEKSEKUSI (`ff70d65` 0.9.2 + `e1c7839`/`346a932` 0.9.3/0.9.4): `--cwd` repo-wide, O_NOFOLLOW, pricing refresh, max_tokens 8192, thought_signature side-map, 4 tool, memori kategori/scope, code_run tanpa shell, trash bersama.
- ✅ P13 P1 + P11 P1 + P10 P1 DIEKSEKUSI (`ff70d65` 0.9.2 + 0.9.5): submit_result, ask_user (gated+DI), plan artifact, snippet verify, branchSession, TTL hierarkis + accessCount, Responses chaining, reasoningEffort map, retry-after honori + coba-ulang-di-tempat, probe /responses, harness TUI 10/10, SWE-bench Lite (dataset 20 pin + test_patch + fake 0/20), doctor, lint 0 warning, coverage-min 80/84.
- ✅ AUDIT UX DIEKSEKUSI (`d69fbec` 0.9.6): Tab kosong toggle plan/build, did-you-mean (≤2), banner konteks, /thinking on-off, sync jujur {updated,failed}, doctor warn 0-model, error tunggal, sandbox notice tepat, models --match bersih, auth non-TTY fail-fast, English-only + regex penjaga, /quit dihapus, USAGE lengkap. **Opsi A konsolidasi**: /cost & /usage → /status, /resume → /sessions; /undo /redo /clear /copy /history tetap mandiri, tampil di /help tapi TIDAK di dropdown. Gate `1284 pass 0 fail / tsc / lint 0 warn / 80.77/84.56 / pack 22/22 / bash 0`.
- ✅ HARNESS P0–P3 DIEKSEKUSI (uncommitted, 2026-09-07/08 — detail: `docs/HARNESS.md`): P0 jail simetris move/delete, `MINICODE_SANDBOX_STRICT`, allowlist `bun run`/`bun x`, scrub `exec --json` + `overBudget`; P1 `budgetStatus` + `--budget-strict` (sekaligus perbaiki `exec` yang mengabaikan `--budget`), `step-traces.jsonl` + klasifikasi deny, `audit:harness` 60 cek, `--verify`+self-heal terverifikasi existing; P2 baseline-first + `--tool-scope explore`; P3 `stats` deny-rate + validasi resume. Uji live 7 model gateway (21 run, 20/21 execution-verified; multifile ketat 4/7). Gate `1336 pass 0 fail / 81.68/85.37 / pack 22/22 / audit 60/60`. DITOLAK sadar: verify default-on, evaluator inferential.
- ✅ SESI UX MODEL+INPUT (uncommitted, 2026-09-09): alur thinking effort DIKUNCI (`Enter` = pilih + picker effort, Esc = batal total; `t` dihapus; badge effort; berlaku sesi berikutnya); effort anti-hilang (`detectAndSave`/`auth login` preserve `reasoningEffort`; mutasi `/model` ditulis ke scope asal — hapus fallback race + `saveProvider` di controller); audit UX lain: Esc batal prompt kosong + `askSecret` null = batal, search keys diperbaiki (Ctrl+D/Ctrl+U, onKey tak membajak), `Gateway >` kosong = batal, konfirmasi timpa provider, umpan balik ✓/✗ menyeluruh, picker clamp/footer/sanitasi, `/sync` restart kondisional, help/keys akurat. Struktur path-guard: `resolveSafePath` = tool PENULIS, `safeOpenRead` = pembaca (read_file/read_image single-open, tanpa verifikasi ganda). Gate `1357 pass 0 fail / 81.84/84.26 / pack 22/22`; min dikunci **80 funcs / 85 lines** (lines dikunci 85 setelah journal 82.42/85.17 dua run identik; funcs berayun 80.6–81.8 antar run — menaikkan ke 81 membuat gate flaky).
- ✅ SINKRON DOK 0.9.19 (2026-09-14): ledger `›` hijau/merah di `docs/architecture.md` + `docs/terminal.md` (sebelumnya `✓`/`✗` era 0.9.16), ambang coverage `docs/contributing.md` 80/85, badge `ARCHITECTURE.html` v0.9.19, web rebuild 32 halaman + `web:check` lolos. Vendor sync DITUNDA sadar (seam lokal `cwd`/`permissionMode` belum dihilirkan; delta upstream hanya cap retryAfter yang sudah ditutup lapis-app).
- ✅ AUDIT-FIX + CLEANUP + WEB (2026-09-16, uncommitted): sanitasi ANSI reasoning/thinking/preview-bash/label-tool, bash-guard (`pwsh`, wrapper `su/runuser/cmd`, reader baru, `rm //`), `isDangerousLink` sadar-direktori, pembaca `O_NOFOLLOW`, budget mid-turn, forget dual-scope, `assertSafeWriteTarget` live, ekspektasi footer disinkronkan, guard BOM diperluas, EOL worktree dinormalisasi LF, 5 berkas + 8 fungsi mati dihapus, docs distrukturkan ulang (`USAGE.md` jadi pointer, angka mesin dibuang dari markdown), website direbuild (ledger `›`, invariant 14). Gate `2014 pass 0 fail / tsc / lint 0 warn / coverage 82.48/84.37 (min tetap 80/84) / pack 22/22`.

Next action — sisa aktif (urut):
1. **SWE-Lite valid** — `bench/docker/` + `manifest.json` 20 instance + `--docker` MENDARAT; 5 image era TER-BUILD (py36 butuh fix apt kedaluwarsa); validasi: requests-1963 collect+run OK di py3.8, pytest-11143 FAIL dengan benar di py3.10. Sisa: run agen penuh + validasi confidence-low (requests/sympy).
2. **OAuth Copilot/ChatGPT** (P11 P2) — hanya `qwen` yang punya spec terdaftar; ChatGPT/Copilot TANPA spec (endpoint tak boleh dikarang). `auth login chatgpt` fail-fast non-TTY terverifikasi live. Login aplikasi ChatGPT Desktop tak bisa dipakai CLI (tanpa API publik; baca tokennya = pencurian kredensial). Butuh: device-flow interaktif oleh pemilik akun (`auth login qwen`), atau API key konvensional.
3. **Coverage 81/83** ✅ TERCAPAI (81,68/85,37; min dikunci 81/83) — via test config in-process + 3 temuan bug nyata (`--cwd` diabaikan list/add branches; flag-sebagai-id; list menulis repo saat test). Sisa per-file rendah di lsp/repl bukan kode baru.
4. **TOCTOU Linux CI** ✅ TERVALIDASI di WSL Ubuntu (swapper 1000× 0 lolos, 293ms) — temukan bug test: swapper tanpa yield menggantung selamanya (klaim lama tak pernah tervalidasi). Full suite Linux 1334/8/0; Windows (dev-mode + daemon) 1336/6/0. 5 fail platform-spesifik diperbaiki + `MINICODE_HOME` baru (global-DB hermetic di POSIX).

---

## Prinsip yang mengatur rencana ini

1. **Verifikasi perilaku, bukan bentuk kode.** Harness yang men-`grep` sumber jadi basi begitu kode diperbaiki — terbukti di ronde 3, di mana harness lama melapor 9 temuan yang sudah tidak ada. Tulis harness yang **menjalankan** kodenya.
2. **Buktikan dampak sebelum memperbaiki.** 5 dari 12 temuan ronde 1 tidak berdampak nyata dan sengaja tidak diperbaiki. Temuan tanpa bukti dampak adalah utang, bukan aset.
3. **Setiap perbaikan meninggalkan test yang gagal di commit sebelumnya.** Kalau test barumu lulus di kode lama, ia tidak menguji apa yang kamu kira.
4. **Jangan menambah permukaan baru sebelum yang ada teruji.** Tidak ada fitur baru di rencana ini kecuali yang sudah disetujui owner.

---

## P10 — Path to 9+: TOCTOU, `--cwd` repo-wide, SWE-bench Lite, flake TUI

Empat pekerjaan rumah terakhir sebelum skor 9+ bisa diklaim (audit 2026-09-06). Detail ada di bagian ini.

**P0 — Rilis blocker (minggu ini):** ✅ SELESAI 0.9.2, refinement 0.9.5.
- **P0.1 `--cwd` repo-wide:** ✅ `cli/router.ts` subArgv + subGetArg; `test/cli-subcommands.test.ts` assert artefak lokal.
- **P0.2 TOCTOU `O_NOFOLLOW`:** ✅ helper `src/lib/safe-open.ts` membuka path **terverifikasi** (`realpath`→cek→`open(preReal, O_NOFOLLOW)`): symlink internal tetap terbaca, swap jadi symlink gagal tutup (ELOOP). **POSIX-only** — Windows mengabaikan flag (pre-check saja); klaim "0 lolos" sah di POSIX. Test `test/tool-toctou.test.ts` (swapper 1000×, skip bila symlink EPERM → jalan penuh di Linux CI).

**P1 — Kepercayaan pengukuran (sprint depan):**
- **P1.1 Flake TUI:** ✅ `test/tui-harness.test.ts` 10/10 hijau beruntun (2026-09-06).
- **P1.2 SWE-bench Lite:** ✅ HARNESS + DATASET + RUN NYATA — `bench/swebench_lite_20.jsonl` 20 instance nyata terstratifikasi (12 repo, base_commit spot-check via GitHub API) + `bench/swebench.ts` apply `test_patch` dulu + flag `--api-key-env/--base-url/--model/--max-steps` (kunci di env, tanpa sentuh config) + diagnosa error per-instance. **Run nyata 2026-09-06: 0/20** (`nemotron-3.5-lightning-free`, 25 steps, `bench/swebench_results.json`) — TAPI angka ini **terkonfoundasi lingkungan**: reproduksi manual membuktikan (a) `pytest-11143` FAIL_TO_PASS lolos TANPA patch + PASS_TO_PASS gagal di base (Python 3.14 vs era 2022), (b) `requests-1963` collection error (`cgi` hilang di 3.13+). Tanpa Docker image per-instance ala SWE-bench resmi, skor tak comparable ke leaderboard. Butuh: `bench/docker/` + pin Python/pytest per era repo.

**P1 — Kepercayaan pengukuran (sprint depan):**
- **P1.1 Flake TUI:** `tui-harness.ts` sleep-based (`settleMs 15`, timeout 2000) + `send` fan-out ke stale listener → `waitForOutput` + `answerSequence` v2 + kirim ke listener raw-terbaru; kembalikan timeout ≤5000; 10/10 hijau + `test/tui-harness.test.ts` baru.
- **P1.2 SWE-bench Lite:** `bench/swebench.ts` baru (clone + checkout `base_commit`, prompt = problem_statement, verify = `FAIL_TO_PASS` via pytest, `PASS_TO_PASS` sampled); 20 instance terstratifikasi di-pin; angka resolve rate TERCETAK (berapa pun) sebelum boleh dikutip — PLAN P3.1 tetap berlaku.

**Selesai bila:** artefak `--cwd` selalu lokal, swapper 3×1000 iterasi 0 lolos, timeout manager ≤5000 + 10/10 hijau, angka SWE-Lite-20 dari run nyata, gate hijau.

## P11 — Provider Hardening: correctness, harga, Responses, retry

Audit 2026-09-06 menemukan provider skor terendah (7.5): shim Gemini drop `thought_signature` (400 diam-diam), harga Opus usang 3× (rusak `--budget`), tanpa Responses API dan `reasoning_effort`, 429 bakar-daftar provider, deteksi via substring URL, OAuth 1 provider belum terverifikasi, tanpa observabilitas, `max_tokens` 4096 sunyi. Detail ada di bagian ini.

**P0 — Kebenaran (minggu ini):**
- **P0.1 `thought_signature` pass-through:** teruskan `extra_content.google` dari delta tool_call → echo verbatim (seam aditif bila perlu). Test: tool loop Gemini thinking 3-turn hijau.
- **P0.2 Refresh harga:** koreksi Opus `$5/$25` + GPT-5.x/Claude 4.6/Gemini 3.x/DeepSeek V4; `pricing status` tampilkan umur cache + peringatan stale (tanpa auto-fetch).
- **P0.3 `max_tokens` 8192 + `length` eksplisit:** stop terpotong jadi peringatan, bukan teks sunyi.

**P1 — Daya saing (sprint depan):** ✅ SELESAI 0.9.5.
- **P1.1 Adapter Responses API** ✅ (`/v1/responses`, `previous_response_id` chaining per model, `store:false` default) + `providerHint: "responses"` + fake-SSE test.
- **P1.2 `reasoning_effort` generik** ✅ (`ProviderEntry`, `mapReasoningToThinking` → per-wire, test).
- **P1.3 Retry-after dihonori** ✅, tunggu (cap 30 dtk) lalu fallback; provider tunggal coba-ulang-di-tempat sekali; test (Prinsip 3: gagal di kode lama).
- **P1.4 Wire dari probe** ✅ (path `/responses` → hint `responses`; substring host hanya fallback) + test.

**P2 — Kematangan:** observabilitas ✅ (trace cost + memoryHits + provider efektif di header — warisan V7); routing policy eksplisit ⏳ (defer: router first-match + `::` override cukup); OAuth Copilot/ChatGPT ⏳ DEFER JUJUR: endpoint device-flow tak terverifikasi dari env ini — mengarangnya melanggar Prinsip 2.

**Selesai bila:** tool loop Gemini 3-turn hijau, Opus ≈⅓ biaya lama, `length` eksplisit, fake Responses SSE benar, 429 tunggu-di-tempat, gate hijau.

**Sengaja ditolak:** proxy universal ala LiteLLM — tiga adapter kecil yang jujur > satu proxy ajaib (postur zero-dep).

## P13 — Raise 3 Dimensi Tertinggal: Model 8.0→8.7, Tool 8.5→9.0, Sesi/Memori 8.5→9.0

Skor saat ini **8.2**. Target **P0 (≤3 hari): 8.4**, **P1 (sprint): 8.6**. Berbasis riset read-only 2026-09-06 (empat fact-sheet: inventaris 37 tools `src/tools/index.ts:59`, 14 preset `src/providers/presets.ts:14`, 6 mode `src/policy/permission.ts:8`, WAL+shadow-git+FTS5/MMR). **Keputusan pemilik dikunci:** P0 dulu; memori **opt-out** (`MINICODE_AUTO_MEMORY=0`); **sandbox tidak disentuh** (skor 8.0 dibiarkan — pemilik menolak kerja sandbox Windows/Linux). Tanpa TUI, tanpa proxy universal LiteLLM, tanpa edit `vendor/minicore/**` kecuali seam aditif.

**P0 — Semua yang menaikkan skor (≤3 hari, tanpa ubah UI/API):**

- **Model (8.0→8.7):**
  - **M0.1 `thought_signature` pass-through:** seam aditif `provider_meta?: unknown` di `vendor/minicore/src/core/tool.ts:22` (+ `VENDOR.md`, `bun run vendor:minicore`); teruskan `extra_content.google.thought_signature` dari delta `vendor/minicore/src/providers/openai-compat.ts:112` → `ToolCall._meta` → echo verbatim. *DoD:* fake SSE 3-turn Gemini thinking → turn-3 tidak 400.
  - **M0.2 Refresh `BUILTIN_PRICING`:** `src/policy/pricing.ts:30` Opus `$15/$75→$5/$25` + GPT-5.x/Claude 4.6/Gemini 3.x/DeepSeek V4; `cli/commands/pricing.ts:42` tampil `ageH` + `(stale)` >30d (tanpa auto-fetch).
  - **M0.3 `max_tokens` 4096→8192:** `src/providers/anthropic.ts:73` + warning `length` eksplisit di `src/ui/render/errors.ts` + `src/ui/assistant/simple.ts`.
- **Tool (8.5→9.0):**
  - **T0.1 `move_file` + `delete_file`** (delete soft ke `.trash/`; jail sama `write_file.ts:30`, atomic, `isSensitive`).
  - **T0.2 `read_image`** — reuse `estimateImageTokens` `src/policy/context.ts:15` → base64 `data:image/...` cap `BASH_OUTPUT_MAX_CHARS`.
  - **T0.3 Pisah `readonly` vs `plan` — DEFERRED:** ditolak, `plan` = `readonly` strict (test `plan mode: read-only` + `permission Fase 1` menuntut todo_write/delegate ditolak). Kembali hanya bila ada desain `write_plan` artifact + test baru.
  - **T0.4 `O_NOFOLLOW` safe-open** `src/lib/safe-open.ts` → `read_file`/`edit` (+ `patch`/`glob`/`grep` backlog P1); POSIX-only, Windows pre-check saja (paralel P10.2).
  - **T0.5 `code_run` tool** — sandboxed sama `bash`, bypass deny `INLINE_INTERPRETER` `bash-guard.ts:135` (hanya bila `MINICODE_SANDBOX=os|docker`).
- **Sesi & Memori — opt-out (8.5→9.0):**
  - **S1 Persist summary:** `src/policy/compaction.ts:187` → `addMemory(summary.slice(0,1200), {category:'summary'})`, guard `if (process.env.MINICODE_AUTO_MEMORY !== "0")`.
  - **S2 Kategori:** `src/memory/vector.ts:30` migration `category` (`fact|decision|preference|snippet|summary`) + `write_memory {category?, tags?}` (default `fact`); boost `score+=0.1` bila query match.
  - **S3 Scope `all`:** `vector.ts:431` `scope: 'cwd'|'global'|'all'` (merge dua DB, perbaiki silent shadowing `src/lib/db-path.ts:16`); default `cwd`.

**P1 — Sprint (8.4→8.6):** ✅ SELESAI 0.9.5.
- **Model:** ✅ adapter Responses API `src/providers/responses.ts` (chaining + test fake-SSE); `reasoningEffort` di `src/config.ts:29` + `mapReasoningToThinking` (test); honori `retry-after` + coba-ulang-di-tempat di `src/providers/router.ts` (test gagal-di-kode-lama); wire dari probe `src/providers/detect.ts` (test).
- **Tool:** ✅ `submit_result` (NO_PROMPT, `exec --json` verbatim); `ask_user` gated `permission.ts` + render via injeksi `promptAskText` `cli/setup.ts` (fail-closed, test).
- **Sesi/Memori:** ✅ plan artifact `.minicode/plans/<id>.md` (`src/tools/todo.ts`, test); auto-extract snippet dari turn verify sukses (`buildVerifySnippet` + `onOk`, opt-out sama, test); branch `branchSession` (`src/session/persistence.ts`, test); TTL hierarkis `fact/decision/preference 180, summary 90, snippet 14` + `accessCount` (test).

**Selesai bila (semua diukur):**
- Gate: `bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack` hijau; `MIN_LINES/MIN_FUNCS` di `scripts/coverage-gate.ts` = **80/84** (funcs sengaja tidak dinaikkan ke 81: hasil terukur berayun 80.62–81.84 antar run, mengunci 81 membuat gate flaky; tercapai 2026-09-09 `1357 pass / 81.84/84.26`).
- `test/tool-toctou.test.ts` swapper 1000 iterasi **0 lolos** di POSIX (skip bila symlink EPERM; Windows CI: 3 skip by design).
- `test/cli-subcommands.test.ts`: tiap subcommand `--cwd tmp` → artefak lokal, bukan repo/global. ✅
- `test/tui-harness.test.ts` 10× hijau. ✅ (2026-09-06)
- Gemini thinking 3-turn hijau ✅ (0.9.4); Opus ≈⅓ biaya lama ✅ (0.9.2); `length` eksplisit ✅; fake Responses SSE benar ✅ + chaining; 429 tunggu-di-tempat ✅.
- `memory status --json`: kategori + scope tampil ✅; summary persist opt-out ✅ (kecuali `MINICODE_AUTO_MEMORY=0`).
- SWE-Lite-20: dataset pin + harness benar + fake hijau + **run nyata 0/20 (terkonfoundasi env — lihat P1.2)** ✅; angka leaderboard-comparable ⏳ (butuh Docker per-instance).

## Yang sengaja TIDAK dikerjakan

Agar cakupan jelas dan tidak melebar diam-diam:

- **Tidak ada framework TUI baru.** Pure ANSI tetap. Ink/blessed akan membuang seluruh `fullscreen.ts` demi masalah yang perbaikannya berukuran satu fungsi.
- **Tidak ada mouse support.** Mouse tracking sudah dimatikan di V6 karena byte koordinatnya bocor ke input dan tidak ada konsumennya.
- **Tidak ada tema baru.** Empat preset sudah bekerja; menambah tema tanpa pengguna yang meminta adalah spekulasi.
- **Tidak ada virtual scroll transcript.** Output append-only ke scrollback terminal; layar interaktif (manager/wizard/picker) transient dan menghapus diri sendiri.
- **Repo-map tetap regex.** Alasan lengkap (dengan tabel pengukuran) ada di komentar `extractSymbolsAsync` di `src/repo/repomap.ts`. Tree-sitter menambah dua dependensi dan ~1,4 MB wasm per bahasa untuk simbol yang hampir seluruhnya member kelas — bukan yang berguna untuk orientasi.

---

## Cara bekerja di repo ini

**Sebelum mulai:** baca `AGENTS.md`, jalankan seluruh gate di bagian "Keadaan saat ini".

**Selama bekerja:**
- Ikuti gaya kode yang ada; jangan memperkenalkan pustaka baru.
- Bahasa komentar: Indonesia, menjelaskan **mengapa** bukan **apa**. Sertakan bukti (angka, nama berkas, perilaku terverifikasi) untuk keputusan non-obvious.
- Encoding: UTF-8 tanpa BOM. Repo ini pernah rusak karena pipeline PowerShell tanpa encoding eksplisit — `test/import-convention.test.ts` menjaganya, jalankan setelah mengedit berkas berisi karakter non-ASCII.
- Jangan mengedit `vendor/minicore/**` tanpa keputusan eksplisit (lihat P2.1).

**Sebelum menyatakan selesai:**
```bash
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```
Semua harus hijau. Bila coverage naik, naikkan juga angka minimum di `scripts/coverage-gate.ts` supaya tidak bisa mundur.

**Jangan commit** kecuali diminta. Bila diminta: periksa `git status` dan `git diff` lebih dulu, stage hanya berkas yang dimaksud, jangan pernah commit rahasia.
