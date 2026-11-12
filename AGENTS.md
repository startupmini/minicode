# AGENTS.md

Petunjuk untuk agent yang bekerja di repo ini. Peta struktur hidup:
[docs/architecture.md](docs/architecture.md).
Kontrak terminal FROZEN: [docs/TERMINAL_CONTRACT.md](docs/TERMINAL_CONTRACT.md) —
baca sebelum menyentuh output/rendering apa pun; perubahan perilaku wajib
update dokumen + test peta proteksinya.

## Otoritas roadmap

Roadmap arsitektur adalah milik pemilik repo. `ROADMAP.md` tidak tersedia di
checkout ini, jadi status Big Phase maupun next action belum dapat dinyatakan.
`PLAN.md` ada di checkout ini tetapi hanyalah ledger legacy, bukan roadmap
aktif; `ROADMAP.md` tidak ada.
Jangan merekonstruksi status dari changelog, kode, atau artefak histori. Jangan
menulis ulang master roadmap sebagai agent. Label Big Phase (`P1`–`P14`),
sub-milestone (`P2.x`), Quality Remediation (`Stage 1`–`10`), dan hotfix
(`P0/UX-001`) adalah namespace berbeda.

## Status checkout

`CHANGELOG.md` dan `package.json` saat ini mencatat v0.21.0. `PLAN.md` adalah
ledger milestone legacy, bukan roadmap aktif. `ROADMAP.md`,
`docs/ARCHITECTURE.html`, dan `docs/audit/` tidak ada; status roadmap belum
tersedia. Gate repository dapat dijalankan, tetapi checkout tidak boleh
disebut hijau atau release-ready sebelum seluruh gate lulus pada kandidat yang
sama.

Peta dokumentasi aktif: [docs/README.md](docs/README.md), navigasi:
[`docs/SUMMARY.md`](docs/SUMMARY.md), arsitektur: [docs/architecture.md](docs/architecture.md),
kontrak terminal: [docs/TERMINAL_CONTRACT.md](docs/TERMINAL_CONTRACT.md).

## Gate (urutan ini, semua hijau sebelum selesai)

```bash
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```

Gate memakai manifest `package.json` yang ada pada checkout ini.

### Catatan eksekusi gate (2026-11-12, working tree audit render)

Terukur pada kandidat yang sama (`bun x tsc --noEmit` = bersih,
`bun run lint` = 692 file / 0 error, `bun test` = 5672 pass / 26 skip / 0 fail
dari 5698 test di 402 file, `bun run gate:pack` = 23 pass / 0 fail, 309 file /
4021 KB).

`bun run gate:coverage` **TIDAK selesai** pada lingkungan ini dan **tidak
boleh dicatat sebagai lulus**: gate itu menjalankan ulang seluruh suite dengan
`--coverage` (~18–20 menit), sedangkan job panjang yang dilepas (background/
detached) dihentikan saat sesi pemanggil berakhir. Tiga percobaan berakhir
tanpa output gate — bukan kegagalan ambang, juga bukan bukti hijau.

Dua gejala flake yang sudah teridentifikasi, jangan dikejar sebagai regresi:

- Di bawah beban suite penuh, tiga test yang menunggu subproses keluar dengan
  batas 5–6,5 dtk bisa timeout: `test/supply-chain.test.ts` (`git_diff`
  textconv), `test/work-mode-cli.test.ts` (`exec --json --verify`), dan
  `test/writer-inventory.test.ts`. Ketiganya lulus saat dijalankan sendiri;
  run penuh berikutnya 0 fail.
- `test/concurrency-cross-process.test.ts` (§32 dua proses tulis sesi) adalah
  flake lintas-proses Windows yang sama kelasnya.

Artinya: laporan status wajib menyebut perintah yang benar-benar dijalankan
dan yang tidak; jangan menyimpulkan "repository hijau" dari run parsial, dan
jangan menurunkan ambang coverage/pack untuk menutupi gate yang belum jalan.

**Ruang lingkup klaim hasil — baca sebelum menulis laporan status.**

- Laporan **stage-scoped** (mis. "Stage 8.1 `FIX VERIFIED`") **hanya boleh
  mengklaim scope yang benar-benar divalidasi** pada scope itu: perintah yang
  dijalankan, commit/working tree yang diuji, angka pass/fail/skip/error, dan
  tes yang **tidak** dijalankan. Hasil stage-scoped **tidak boleh** ditulis
  seolah-olah seluruh repository hijau.
- **Menutup track Quality Remediation penuh** (Stage 1–10) atau **mengumumkan
  release-readiness / quality akhir** tetap **mensyaratkan seluruh gate akhir
  lulus pada satu kandidat final yang sama** — urutan di atas ditambah
  `bun run audit:harness`, smoke build/package, dan pemeriksaan CI yang
  relevan. Ambang gate **tidak boleh** diturunkan untuk membuat hasil terlihat
  hijau.
- Angka hasil historis (laporan sebelumnya) tetap berstatus **historical**:
  sebutkan checkpoint-nya, jangan menyebutnya sebagai hasil sekarang.

Jangan turunkan ambang coverage atau naikkan budget paket untuk membuat gate
hijau. Sumber angkanya `scripts/coverage-gate.ts` dan
`scripts/pack-budget.ts`; perubahan budget memerlukan bukti baru dan
persetujuan pemilik.

## Batas lapisan (dijaga `test/ui-boundary.test.ts`)

- `cli/` boleh impor `src/ui/` dan `src/`; `src/` non-ui DILARANG impor
  `src/ui/`; `src/ui/` DILARANG impor `cli/`, `src/` non-ui, `#minicore`.
- Lintas-lapisan via DI dari composition root (`cli/index.ts`, `cli/setup.ts`):
  `ask`, `setupWhenEmpty`, `setSubAgentSessionFactory`. Tanpa injeksi default
  selalu deny / fail-closed. `providers → config` satu arah (provisioning di
  `src/providers/provision.ts`, `src/config.ts` murni IO).
- Layar `src/ui/screens/` = view murni (props + callback), controller di `cli/`.
- Jalur non-interaktif shell-first (append-only ke scrollback); sesi
  interaktif SELALU TUI alternate-screen (invariant terminal #1, tanpa opsi linear).
- Ubah struktur/dependensi antarlapisan → wajib update `docs/architecture.md`.

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
