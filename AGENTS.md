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

### Gate coverage — sudah tuntas (2026-11-13)

`bun run gate:coverage` **selesai dan lulus** pada kandidat 2026-11-13 (tree
dengan alur context-window/kompaksi + audit UI/UX, sebelum commit):

```
[coverage-gate] funcs 88.64% (min 87) · lines 90.10% (min 86)
[coverage-gate] lantai per-berkas: 19/19 modul kritis hijau
```

Angka gate lain pada kandidat yang SAMA: `bun x tsc --noEmit` = bersih (0
error), `bun run lint` = 705 file / 0 error, `bun test` = 5746 pass / 26 skip /
0 fail dari 5772 test di 408 file (~1083 dtk), `bun run gate:pack` = 23 pass /
0 fail, 316 file / 4095 KB.

Catatan lama soal "job panjang dihentikan saat sesi berakhir" tidak lagi
berlaku di lingkungan ini: `gate:coverage` diselesaikan dengan proses latar
yang bertahan melewati sesi pemanggil dan log-nya dibaca setelah selesai.

Gejala flake yang sudah teridentifikasi, jangan dikejar sebagai regresi:

- Di bawah beban suite penuh, beberapa test yang menunggu subproses keluar
  dengan batas 5–7,5 dtk bisa timeout (`test/supply-chain.test.ts`,
  `test/work-mode-cli.test.ts`, `test/writer-inventory.test.ts`,
  `test/exit-codes.test.ts`, `test/extreme.test.ts`,
  `test/phase1-tools.test.ts`). Semuanya lulus saat dijalankan sendiri; run
  penuh berikutnya 0 fail.
- `test/concurrency-cross-process.test.ts` (§32 dua proses tulis sesi) adalah
  flake lintas-proses Windows yang sama kelasnya.

Angka di atas adalah hasil pada kandidat tersebut, bukan janji untuk commit
berikutnya: jalankan ulang gate bila ada perubahan setelah kandidat ini.
Jangan menurunkan ambang di `scripts/coverage-gate.ts` atau menaikkan budget di
`scripts/pack-budget.ts` untuk membuat gate hijau.

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
- `vendor/minicore/**` **HOST-EDITABLE** sejak v0.16.0 (keputusan pemilik
  2026-11-10; lihat `vendor/minicore/VENDOR.md`). Tetap utamakan seam aditif
  dan jangan menurunkan kontrak lapisan yang dijaga test.
- Komentar Indonesia, jelaskan **mengapa**. Encoding UTF-8 tanpa BOM.
- Jangan commit kecuali diminta; jangan pernah commit rahasia.
