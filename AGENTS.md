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

> **Status integrasi (2026-11-07):** `ROADMAP.md` terlacak di Git; commit
> terakhir yang mengubahnya adalah `677d77d` (2026-10-26), sedangkan teks di
> dalamnya masih menyebut draft working-tree dan checkpoint HEAD lama
> `2d9e11e…`. Master Library milik pemilik tidak tersedia untuk dibandingkan,
> jadi kesamaan salinan tidak terverifikasi. Jangan menulis ulang roadmap
> sebagai agent; laporkan drift metadata ini dan jangan menganggap keberadaan
> atau status Git-nya sebagai bukti repository hijau.

**`PLAN.md` = ledger produk/milestone legacy.** **Tetap ada, tidak dihapus,
tidak direnumber.** Isinya riwayat implementasi + status historis era 0.9.x,
dirujuk sebagai `LEGACY-0.9/*`. Ia **bukan** sumber status Big Phase P1–P14
dan tidak pernah menjadi "rencana aktif" lagi.

Laporan audit Closure/Handoff/QA di root adalah **artefak historis yang
terikat checkpoint** — pakai untuk memahami keputusan, jangan pakai sebagai
klaim "status sekarang".

### Status terkini (2026-11-07) — Final Integration & Repository Consolidation

Fase aktif proyek adalah **Final Integration & Repository Consolidation**
(bukan fase produk baru; **tidak ada P3**). P0, P1, P2, dan penutupan P2.3
telah mencapai **stage-scoped closure** dengan bukti di `docs/audit/`:

- `P0_FOUNDATION_HARDENING_REPORT_2026-11-04.md`, `P0_FINAL_CLOSURE_VERIFICATION_REPORT_2026-11-04.md`
- `P1_CORRECTNESS_OBSERVABILITY_UX_REPORT_2026-11-05.md`
- `P2_OPERATIONAL_QUALITY_ARCHITECTURE_REPORT_2026-11-05.md`
- `P2_3_OPERATIONAL_CLOSURE_AND_FINAL_INTEGRATION_REPORT_2026-11-05.md`
- `FINAL_INTEGRATION_AND_REPOSITORY_CONSOLIDATION_REPORT_2026-11-05.md`

`CHANGELOG.md` mencatat v0.14.2 pada 2026-11-07. Rilis tersebut tidak
memperbarui bukti closure P0–P2.3: jangan menganggap gate lulus pada HEAD
sekarang tanpa menjalankannya pada kandidat yang sama. Dogfooding MiniChat
tetap fixture evaluasi dan tidak membuktikan audit sistem penuh.

**Peta dokumen kanonik:**

| Subjek | Dokumen kanonik |
|---|---|
| Aturan agent & status fase | `AGENTS.md` (ini) |
| Peta arsitektur/stuktur | `docs/ARCHITECTURE.html` |
| Kontrak terminal/output (FROZEN) | `docs/TERMINAL_CONTRACT.md` |
| Roadmap arsitektur (master pemilik) | `ROADMAP.md` (salinan terlacak dengan metadata checkpoint lama; master Library belum diverifikasi, bukan untuk ditulis ulang agent) |
| Ledger legacy 0.9.x | `PLAN.md` |
| Panduan operasional | `docs/*.md` (cli, tools, memory-sessions, mcp-lsp, exec, security, dll.) |
| Audit & verifikasi historis | `docs/audit/**`, root `P*_*.md`, `PHASE-*.md` |

**Limitasi produk yang masih berlaku (jangan diklaim selesai):** MCP
subscriptions/notifications belum didukung; producer `FAILED`/`RETRYING` belum
ada (keputusan produk); daemon tidak auto-resume setelah restart; manual TUI
UAT dan gateway cache **UNVERIFIED**; snapshot repository besar dapat gagal
atau lambat. Pengukuran `gate:pack` 3.902,6 KiB berasal dari checkpoint
v0.14.0; v0.14.2 mengubah isi tarball, sehingga hasil gate terkini belum
terverifikasi di sini. Selalu bedakan klaim stage-scoped dari klaim
release-ready.

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
dinaikkan 86 → 87 pada P13.5). Budget ukuran paket = **3.920 KiB (3,83 MiB)**,
satu sumber di `scripts/pack-budget.ts` (`PACK_SIZE_BUDGET_KIB`) — jangan
menaikkan tanpa bukti baru + persetujuan pemilik. (Re-baseline 3.840 → 3.920
KiB disetujui owner 2026-11-05 untuk rilis v0.14.0; ukuran aktual 3.902,6 KiB.)

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
