# AGENTS.md

Petunjuk untuk agent yang bekerja di repo ini. Peta struktur hidup:
[docs/ARCHITECTURE.html](docs/ARCHITECTURE.html).
Kontrak terminal FROZEN: [docs/TERMINAL_CONTRACT.md](docs/TERMINAL_CONTRACT.md) —
baca sebelum menyentuh output/rendering apa pun; perubahan perilaku wajib
update dokumen + test peta proteksinya.

## Otoritas roadmap (baca dulu)

**Roadmap arsitektur = [ROADMAP.md](ROADMAP.md).** Master roadmap milik
pemilik, disalin ke root repository pada 2026-10-21 (v1.8-draft). Dokumen itu
adalah **otoritas** untuk:

- posisi **Big Phase P1–P14** dan status masing-masing fase,
- **next action arsitektur** serta urutan prioritasnya,
- status track **Quality Remediation Stage 1–10**,
- status follow-up lintas-fase berlabel **P0/UX-001**.

`ROADMAP.md` **menggantikan** peran `PLAN.md` sebagai sumber status fase.
Jangan mengarang status fase; kalau status fase tidak tertulis eksplisit di
`ROADMAP.md`, nyatakan belum tersedia.

> **Status integrasi (2026-10-21):** `ROADMAP.md` saat ini masih **draft
> working-tree yang belum di-commit**. Master aslinya tetap milik pemilik di
> Library; bila master diperbarui, salinan repo wajib disinkronkan ulang dan
> setiap perbedaan harus dilaporkan. **Jangan mengklaim roadmap sudah
> committed**, dan jangan mengklaim repository hijau hanya karena `ROADMAP.md`
> ada.

**`PLAN.md` = ledger produk/milestone legacy.** **Tetap ada, tidak dihapus,
tidak direnumber.** Isinya riwayat implementasi + status historis era 0.9.x,
dirujuk sebagai `LEGACY-0.9/*`. Ia **bukan** sumber status Big Phase P1–P14
dan tidak pernah menjadi "rencana aktif" lagi.

Laporan audit Closure/Handoff/QA di root adalah **artefak historis yang
terikat checkpoint** — pakai untuk memahami keputusan, jangan pakai sebagai
klaim "status sekarang".

### Disambiguasi nomor P (baca sebelum menyebut "P12"/"P13")

| Prefix | Arti | Contoh |
|---|---|---|
| `P1`–`P14` | **Big Phase** roadmap arsitektur (otoritas pemilik, di `ROADMAP.md`) | P12 = Work Modes & Permission Architecture · P13 = Desktop & Long-Running Runtime · P14 = Cross-Session Unfinished Work Reconciliation |
| `LEGACY-0.9/P10`, `/P11`, `/P12`, `/P13` | Program/milestone era v0.9 di `PLAN.md` — **bukan** Big Phase | `LEGACY-0.9/P12` = UI Shell-Max · `LEGACY-0.9/P13` = Raise 3 Dimensi Tertinggal · `P11_*_REPORT.md` |
| `P2.x`, `P3.x`, `P12.x` | Sub-milestone **internal** satu fase | P2.1–P2.12 (Session Architecture) · P3.1–P3.7 · P12.0/P12.1 (Work Modes) |
| `Stage 1`–`Stage 10` | Quality Remediation — jalur hardening lintas-fase, **bukan** Big Phase | Stage 8.1 = re-baseline budget paket 3,5 MiB |
| `UX-001` / `P0` | Label prioritas hotfix keamanan TUI — **bukan** Big Phase P0 | — |

**Big Phase P12 (Work Modes) bukan**: `LEGACY-0.9/P12` (UI Shell-Max),
`P2.12` (sub-milestone internal Session Architecture), "Stage 12" (track
Quality Remediation hanya Stage 1–10, tidak ada Stage 12), maupun
`P0/UX-001` (label prioritas hotfix lintas-fase). Kempat hal itu terpisah
dan tidak boleh dicampur.

Konflik nomor yang nyata: "Big Phase 12" di
[P2_CLOSURE_HANDOFF.md](P2_CLOSURE_HANDOFF.md) = *Desktop UI interaktif* pada
Big Roadmap legacy — **bukan** Big Phase P12 (Work Modes). Desktop kini
bernomor **P13**.

## Gate (urutan ini, semua hijau sebelum selesai)

```bash
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```

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

Coverage naik → naikkan juga minimum di `scripts/coverage-gate.ts` (per 2026-10-25:
`MIN_FUNCS` 87 / `MIN_LINES` 86 + 19 lantai per-berkas modul kritis; funcs
dinaikkan 86 → 87 pada P13.5). Budget ukuran paket = **3.584 KiB (3,5 MiB)**,
satu sumber di `scripts/pack-budget.ts` — jangan menaikkan tanpa bukti baru +
persetujuan pemilik.

Status roadmap & next action arsitektur: [ROADMAP.md](ROADMAP.md).
Audit dokumentasi terakhir (snapshot, bukan sumber roadmap):
[docs/REPOSITORY_DOCUMENTATION_AUDIT_2026-10-21.md](docs/REPOSITORY_DOCUMENTATION_AUDIT_2026-10-21.md).

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
