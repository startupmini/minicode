# P12 PHASE CLOSURE REPORT — Work Modes & Permission Architecture

**BIG PHASE P12 — `CLOSED / VERIFIED` (OWNER APPROVED 2026-10-22).**

Dasar keputusan: owner menyetujui penutupan resmi Big Phase **P12 — Work Modes &
Permission Architecture** atas dasar audit closure P12 yang selesai
(`READY FOR OWNER CLOSURE REVIEW`, tanpa cacat implementasi terkonfirmasi, tanpa
perubahan kode produksi). Dokumen ini **bukan** pernyataan bahwa repository
sehat, dan **bukan** closure fase lain: **P13 dan P14 belum dimulai**, dan track
**Quality Remediation Stage 1–10** punya bukti penutupan tersendiri yang **tetap
terpisah** dari bukti P12 ini (lihat §7).

---

## 1. Keputusan dan scope

| Aspek | Nilai |
|---|---|
| Fase | Big Phase **P12** — Work Modes & Permission Architecture (bukan `LEGACY-0.9/P12` "UI Shell-Max", bukan sub-milestone internal `P2.12`/`P12.x`, bukan label hotfix `P0/UX-001`, dan bukan track Quality Remediation) |
| Disposisi | **`CLOSED / VERIFIED`** (disetujui pemilik 2026-10-22) |
| Tanggal laporan | 2026-10-22 |
| Kandidat yang diaudit | `HEAD=2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`, sidik jari `diff=2c77ab7eeebbd1bfef9707fe222b77092473977b` |
| Bentuk closure | Artefak closure formal ini + bukti audit; **tanpa** perubahan kode produksi P12 |

**Batas keputusan.** Penutupan ini spesifik pada P12. Dokumen ini **tidak**
menutup P13, **tidak** menutup P14, dan **tidak** menutup pekerjaan lain yang
masih terbuka (mis. backlog `src/lib/atomic-write.ts` pada §6, dan pembaruan
`ROADMAP.md` yang menjadi tugas pemilik sendiri).

**Kandidat yang diaudit vs. working tree saat ini.** Bukti audit diikat pada
kandidat `diff=2c77ab7eeebbd1bfef9707fe222b77092473977b`. **Working tree
sekarang tidak lagi byte-identical** dengan kandidat audit: setelah audit
selesai, Agent B menjalankan Batch M0 rasionalisasi dokumentasi (termasuk
perubahan pada `docs/ARCHITECTURE.html`), sehingga sidik jari `diff` sekarang
`c1687f9563a37a5befa1cc2abadfa59da6e238bf`. **Tidak ada** perubahan sumber
atau tes P12 yang dilaporkan dalam batch dokumentasi tersebut; seluruh
perbedaan itu berada di lapisan dokumentasi. Angka hasil di §4 adalah hasil
**audit**, bukan eksekusi ulang pada working tree pasca-Batch-M0.

---

## 2. Matriks requirement → bukti

| # | Requirement P12 | Perilaku yang dimaksud | Titik penyeragan | Bukti regresi | Hasil |
|---|---|---|---|---|---|
| A1 | WorkMode terpisah dari 6 PermissionMode | `DISCUSS`/`PLAN`/`EXECUTE` bukan nilai PermissionMode; tak ada kebocoran ke metadata mode | `src/policy/work-mode.ts:16` · `src/policy/permission.ts:18` (tanpa `workMode`) | `test/work-mode-cli.test.ts` — "mode tetap permission mode terpisah dari workMode" | ✅ |
| A2 | Otoritas efektif = **irisan** | WorkMode = ceiling; keputusan akhir milik base PermissionMode + policy terinjeksi + guard (jail/allowlist) | `src/policy/work-mode.ts:56-59` (`ceilingFor`), `:118-141` (ceiling **AND** base) · `src/app/tool-layer.ts:27-38, 116-127` (irisan visibilitas) | `test/work-mode-contract.test.ts` (deny tanpa prompt, jail tetap berlaku) · `test/work-mode-tool-visibility.test.ts` ("PLAN × readonly: TIDAK memperluas visibilitas readonly (irisan)") | ✅ |
| A3 | WorkMode **bukan** otoritas kedua & tak menaikkan izin | EXECUTE = identitas base; tak ada jalur implisit ke izin lebih longgar | `src/policy/work-mode.ts:123, 176` · `src/app/session.ts:146-147` | `test/work-mode-contract.test.ts:176-182` (`composed).toBe(base)`), "onPermissions melaporkan 'auto', bukan WorkMode" | ✅ |
| B1 | No-escalation via kontrol mode | `/mode` & Shift+Tab hanya permission mode; WorkMode punya kontrol terpisah | `cli/tui.ts:229` (`cycleMode`), `:420-440` (`/work-mode`) | `test/work-mode-cli.test.ts` | ✅ |
| B2 | No-escalation via CLI/env | flag > env > default EXECUTE; nilai invalid → EXECUTE + peringatan (ACP: error, bukan default diam) | `cli/args.ts:125-134` · `cli/index.ts:276-278` · `cli/commands/exec.ts:105-108` · `cli/commands/acp.ts:124-135` | `test/work-mode-cli.test.ts` (flag vs env vs default, invalid) | ✅ |
| B3 | No-escalation via dispatch & visibilitas tool | ceiling menolak di luar ceiling; daftar tool = irisan; tool MCP bertitik ditolak di non-EXECUTE | `src/policy/work-mode.ts:131-140` · `src/app/tool-layer.ts:27-38, 116-127` | `test/work-mode-contract.test.ts` · `test/work-mode-tool-visibility.test.ts` | ✅ |
| B4 | No-escalation via handler terinjeksi / policy ketat | WorkMode non-EXECUTE + handler terinjeksi → fail-closed; base tanpa kontrol mode → fail-closed | `src/app/session.ts:112-118` · `src/policy/work-mode.ts:40-49` | `test/work-mode-contract.test.ts` ("factory menolak base tanpa __getMode/__setMode (fail-closed)", "workMode non-EXECUTE + permissionHandler terinjeksi → fail-closed") | ✅ |
| B5 | No-escalation via delegasi sub-agent | WorkMode induk disuntik ke anak secara LIVE; tak ada snapshot basi | `src/tools/task.ts:178-194, 271-278, 509` | `test/work-mode-subagent.test.ts` | ✅ |
| B6 | No-escalation via hook & runtime | Hook mengikuti WorkMode LIVE; sesi non-EXECUTE memasang ceiling handler | `src/hooks/run.ts:29-31` · `cli/setup.ts:1918-1919` · `src/app/session.ts:173-182` | `test/work-mode-hooks.test.ts` · `test/work-mode-runtime.test.ts` | ✅ |
| C1 | Attenuasi parent → child | Child mewarisi WorkMode induk; tool list dipersempit; tanpa WorkMode induk → perilaku lama | `src/tools/task.ts:509` | `test/work-mode-subagent.test.ts` ("parent PLAN × auto + mode 'plan' → child workMode PLAN, tools explore (bukan 29)") | ✅ |
| C2 | Pewarisan & transisi WorkMode | State WorkMode dibaca LIVE per delegate (dua parent interleaving) | `cli/setup.ts:1419-1426` · `src/policy/work-mode.ts:149-154` | `test/work-mode-runtime.test.ts` ("4. delegasi mewarisi WorkMode parent yang AKTIF"; "interleaving dua parent") | ✅ |
| C3 | **Tanpa persistensi** WorkMode (K-1) | WorkMode tak pernah ditulis ke store; resume/restart mewarisi default/flag/env, bukan state basi | grep `workMode` di `src/session/persistence.ts`, `src/session/journal.ts`, `src/task/store.ts`, `src/policy/allowlist.ts` → **kosong** | `test/work-mode-cli.test.ts` (default EXECUTE) | ✅ |
| C4 | Hook/checkpoint/runtime tak melebarkan otoritas | Checkpoint lifecycle (Stage 5B) tak menyentuh jalur otoritas; hook tunduk ceiling | `src/hooks/run.ts:29-31` · `cli/setup.ts:1918-1919` | `test/work-mode-hooks.test.ts` | ✅ |
| D1 | Kompatibilitas & replay 6 PM | EXECUTE × 6 PermissionMode × 9 tool memberi keputusan identik dengan handler referensi | `src/policy/work-mode.ts:123` | `test/work-mode-contract.test.ts:186-229` → `expect(mismatches).toEqual([])` | ✅ |
| D2 | Assertion menguji **keputusan efektif**, bukan mode yang ditampilkan | Tes memeriksa `check()` (allow/deny) + jumlah prompt + alasan deny | `src/policy/work-mode.ts:118-165` | `test/work-mode-contract.test.ts` (`prompts).toBe(0)`, `describeDenial` = "read-only mode"/"gated approval unavailable"/"plan mode") | ✅ |
| E1 | Integrasi lintas-fase | TaskStore, sub-agent lifecycle, verification, scheduler, session/resume, kontrak terminal FROZEN tak dilanggar | WorkMode hanya menyentuh jalur permission/tool/hook/footer | `test/phase6c-scheduler.test.ts`, `test/phase4a4b-session-isolation.test.ts`, `test/phase6q-session-execution-lifetime.test.ts`, `test/phase6z-m31-permission-composition.test.ts`, `test/resume-permission.test.ts`, `test/verifier.test.ts`, `test/p2-verification.test.ts`, `test/subagent-inherit.test.ts`, `test/delegate-audit.test.ts` + `docs/TERMINAL_CONTRACT.md` | ✅ |

**Tidak ada cacat implementasi P12 yang terkonfirmasi** pada audit ini, sehingga
**tidak ada perubahan kode produksi maupun tes** yang dilakukan untuk P12.

---

## 3. Invariant terkonfirmasi & lokasi penyeragan

- **WorkMode = lapisan intent di atas PermissionMode, bukan pengganti** —
  `src/policy/work-mode.ts` (ceiling `readonly`/`plan` via primitif PermissionMode
  yang sudah ada; tak ada engine kedua, tak ada duplikasi daftar tool).
- **Ceiling tidak pernah mencabut hak** — `src/policy/work-mode.ts:131-140`;
  pada EXECUTE handler mendelegasikan penuh ke base.
- **Ceiling ikut mengetat saat base lebih ketat** —
  `src/policy/work-mode.ts:56-59` (PLAN × allowlist/readonly → read-only).
- **Satu pemilik state WorkMode** — kontrol pada handler WorkMode
  (`src/app/session.ts:211-221`, `cli/setup.ts:1419-1426, 1464-1473`); sumber
  kebenaranruntime = handler, dibaca LIVE di mana pun WorkMode dibutuhkan.
- **Jail/allowlist base tetap berlaku di bawah ceiling** —
  `src/policy/permission.ts:302-323` + `src/policy/work-mode.ts:131-140`.
- **Label TUI hanya menampilkan WorkMode saat restrictive** —
  `src/ui/footer.ts:59-65` (`<WorkMode>·<permission mode>`), konsisten dengan
  `docs/TERMINAL_CONTRACT.md`.

---

## 4. Bukti verifikasi (atribusi: audit closure P12)

Angka berikut **hasil audit closure P12** — bukan eksekusi ulang pada working
tree pasca-Batch-M0 Agent B, dan bukan klaim baru atas full suite.

| Pemeriksaan | Perintah | Hasil |
|---|---|---|
| Matriks WorkMode terfokus (6 berkas) | `bun test test/work-mode-contract.test.ts test/work-mode-tool-visibility.test.ts test/work-mode-cli.test.ts test/work-mode-hooks.test.ts test/work-mode-subagent.test.ts test/work-mode-runtime.test.ts` | **101 pass / 0 fail** |
| Keputusan izin & boundary tugas (5 berkas) | `bun test test/permission-matrix.test.ts test/permission-contract.test.ts test/permission-adversarial.test.ts test/task-contract-boundary.test.ts test/agent-contract.test.ts` | **80 pass / 0 fail** |
| Delegasi, sub-agent, verifikasi, scheduler, resume, sesi (12 berkas) | `bun test test/delegate-audit.test.ts test/subagent-inherit.test.ts test/p2-verification.test.ts test/verifier.test.ts test/phase6c-scheduler.test.ts test/phase6s-autonomous-permission-policy.test.ts test/phase6z-m31-permission-composition.test.ts test/resume-permission.test.ts test/phase4a4b-session-isolation.test.ts test/presentation-subagent.test.ts test/phase6q-session-execution-lifetime.test.ts test/tool-toctou.test.ts` | **207 pass / 3 skip / 0 fail** |
| Probe no-escalation independen (di luar repo) | 12 skenario: base injeksi ketat, allowlist bash, PM switch, WorkMode switch, jail, ceiling read-only | **12/12 ok** (exit 0) |
| TypeScript | `bun x tsc --noEmit` | **exit 0** |
| Lint | `bun run lint` | **exit 0** |

**Assertion benar-benar menguji keputusan otoritas, bukan mode yang ditampilkan.**
Bukti inti: replay 6 PermissionMode × 9 tool dibandingkan dengan handler referensi
(`expect(mismatches).toEqual([])`), jumlah prompt saat ceiling menolak
(`expect(prompts).toBe(0)`), alasan deny dari handler yang benar-benar memutuskan
(`"read-only mode"` / `"plan mode"` / `"gated approval unavailable"` /
`"jail: outside workspace"`), dan `describeDenial` bersifat baca-sekali.

---

## 5. Residual yang diterima

1. **Cakupan tes — Minor (diterima pemilik).** Belum ada tes regresi khusus
   untuk **resume dengan state WorkMode basi**. Audit menemukan WorkMode **tidak
   pernah dipersistensi** (tak ada `workMode` di store/journal/allowlist) dan
   default selalu resolve ke `EXECUTE` (flag > env). Jadi scenario resume
   **tidak** mewarisi WorkMode basi. Namun ini adalah **gap cakupan tes** —
   **bukan** bukti bahwa setiap skenario resume sudah teruji.
2. **`describeDenial` punya owner-map berbatas 500 entri (FIFO)** — perilaku
   yang sudah ada sebelumnya, di luar scope P12, tidak diubah pada fase ini.

---

## 6. Backlog terpisah (bukan bagian closure P12)

- **`src/lib/atomic-write.ts`** menelan error dari `mkdir` (`.catch(() => {})`),
  sehingga penyebab sebenarnya ("direktori dihapus") dapat tersamar menjadi
  `ENOENT` dari `open`. Ini **item backlog rekayasa terpisah** — **bukan** bagian
  closure P12, dan berkas ini **tidak** dimodifikasi pada fase ini. Perbaikannya
  perlu tes tersendiri di luar closure ini.

---

## 7. Batas bukti & pemisahan track

- Bukti P12 (dokumen ini) **terpisah** dari bukti track **Quality Remediation
  Stage 1–10** yang dilaporkan `CLOSED / VERIFIED` atas basisnya sendiri
  (full suite + coverage gate + pack gate + gate lain pada kandidat
  `diff=2c77ab7eeebbd1bfef9707fe222b77092473977b`). Status satu track **tidak**
  mengesahkan track lain.
- Artefak closure ini **tidak** menyatakan bahwa repository hijau: working tree
  masih berisi banyak perubahan belum di-commit (Agent A + Agent B + owner), dan
  `ROADMAP.md` masih berupa draft working-tree yang belum di-commit. Pembaruan
  `ROADMAP.md` adalah **tugas pemilik** setelah artefak ini dan pekerjaan
  dokumentasi Agent B direview.
- Audit P12 bersifat **read-only** terhadap kode: nol perubahan kode produksi
  maupun tes P12; tidak ada temuan cacat yang perlu diperbaiki.
- Pemisahan nomor P: `P12` di dokumen ini = Big Phase Work Modes &
  Permission Architecture — **bukan** `LEGACY-0.9/P12` (UI Shell-Max), **bukan**
  sub-milestone internal `P2.12`/`P12.x`, dan **bukan** label hotfix
  `P0/UX-001`. Lihat `AGENTS.md` untuk tabel disambiguasi.

### Artefak terkait

- [P12_ENTRY_GATE_AND_SCOPE_AUDIT.md](P12_ENTRY_GATE_AND_SCOPE_AUDIT.md) — audit
  entry gate & scope P12.
- [P12_1_REV2_OWNER_DECISION_REPORT.md](P12_1_REV2_OWNER_DECISION_REPORT.md) —
  paket keputusan owner P12 (D-1…D-7, K-1).
- [P12_1_REV1_DIFF_AND_REPORT.md](P12_1_REV1_DIFF_AND_REPORT.md) — revisi 1 diff.
- [docs/TERMINAL_CONTRACT.md](docs/TERMINAL_CONTRACT.md) — kontrak terminal
  (label footer `<WorkMode>·<permission mode>`).
- [P11_PHASE_CLOSURE_REPORT.md](P11_PHASE_CLOSURE_REPORT.md) — closure fase
  sebelumnya (bukti track terpisah).

---

## 8. Pernyataan closure

- Pemilik **menyetujui penutupan resmi Big Phase P12 — Work Modes & Permission
  Architecture** dengan disposisi **`CLOSED / VERIFIED`** pada 2026-10-22,
  atas dasar audit closure P12 yang dilakukan pada kandidat
  `diff=2c77ab7eeebbd1bfef9707fe222b77092473977b`
  (`HEAD=2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`).
- **Tidak ada perubahan kode produksi P12 yang diperlukan**: audit tidak
  menemukan cacat implementasi yang terkonfirmasi, dan seluruh requirement
  terpetakan ke titik penyeragan konkret plus assertion yang menguji keputusan
  otoritas efektif.
- Setelah audit, Agent B mengubah lapisan dokumentasi (Batch M0, termasuk
  `docs/ARCHITECTURE.html`); **working tree tidak lagi byte-identical** dengan
  kandidat audit dan **tidak ada** perubahan sumber/tes P12 yang dilaporkan
  dalam batch tersebut.
- P13 dan P14 **belum dimulai**; Penutupan P12 ini tidak-started-kan keduanya.
- Artefak closure ini dibuat sebagai satu-satunya berkas baru pada tugas ini
  (`P12_PHASE_CLOSURE_REPORT.md`); pembaruan `ROADMAP.md` adalah langkah
  terpisah milik pemilik.
