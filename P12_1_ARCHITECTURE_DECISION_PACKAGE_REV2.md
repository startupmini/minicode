# MINICODE P12.1 — WORK MODES & PERMISSION ARCHITECTURE DESIGN (REV-2, OWNER DECISION RECORD)

**Sifat dokumen:** pencatatan keputusan arah pemilik (2026-10-18) atas paket
REV-1 + rencana slice implementasi pertama. Design-only — tidak ada source,
test, config, dependency, atau berkas ter-track yang diubah; tidak ada
staging/commit/push/fetch/reset/rebase; tidak ada full suite atau gate mahal
yang dijalankan. Implementasi P12 **belum** dimulai dan tidak ditandai dimulai.

**Basis:** `main = 93f4179` (P11 closed `COMPLETE WITH DOCUMENTED LIMITATIONS,
OWNER APPROVED 2026-10-18`; `609a417..93f4179` murni dokumen — 0 berkas
non-`.md`, seluruh kutipan kode tetap berlaku dan diverifikasi ulang pada HEAD
ini). REV-1 dan laporan diff-nya dipertahankan tanpa overwrite.

**Model status (tiga lapis, dipisah eksplisit):**

1. **OWNER APPROVED — DIRECTION** — arah arsitektur yang disetujui pemilik
   (bukan persetujuan detail implementasi).
2. **PENDING — IMPLEMENTATION DETAIL** — detail yang masih butuh bukti
   teknis atau keputusan tersendiri.
3. **BLOCKED** — pekerjaan yang tidak boleh dimulai karena prasyaratnya
   belum terpenuhi.

## 0. Koreksi yang dipertahankan dari REV-1

- **K-1 (mandat pemilik: wajib dipertahankan):** jawaban approval **"always"
  TIDAK murni in-memory**. `saveAlways` (`src/policy/permission.ts:262-273`)
  mendorong kunci ke `sessionGrants` (in-memory) **dan** menulis persisten ke
  **`.minicode/allowlist.json` repo-lokal** via `saveAllowlist(key, root)`
  (`:272`; `src/policy/allowlist.ts:41-52` — default path = LOCAL;
  satu-satunya caller `saveAllowlist` di repo). File global
  `~/.minicode/allowlist.json` tidak punya penulis kode (hanya edit manual).
  Read-back lokal hanya dengan opt-in `--allow-local-config`
  (`permission.ts:181,199`; `allowlist.ts:25-35`). Dilarang menyatakan bahwa
  seluruh efek `always` hanya in-memory.
- **K-2 (presisi nomor, tetap):** allow-all bash-inspection `:483-496`;
  `__setMode/__getMode` `:503-509`; `describeDenial` impl `:513-515`; objek
  `handlers` `:278-368`; prompt/headless `:553-656`; `READONLY_TOOLS`
  `:31-50` (18 nama); handler plan `:295-301`; F-07 `task.ts:226-236`
  (`forcedExplore` `:235`, parent plan|readonly|ask) + mapping `:449`;
  `EXPLORE_TOOL_NAMES` `task.ts:42`; prompt plan
  `cli/index.ts:627` ("Proceed to execute this plan? [y/N]"); `shouldRunHooks`
  `src/hooks/run.ts:20-22` dipakai `cli/setup.ts:1756`; ACP
  `cli/commands/acp.ts:375-378` (`allowAll:false, ask:false, plan:rp.mode`).
- **K-3 (tetap):** "Work Mode"/"DISCUSS" nol hasil di `src/`+`cli/` — gap D-1
  masih valid pada HEAD.

## 1. Executive

Pemilik menyetujui **arah** seluruh rekomendasi D-1…D-7 REV-1 (2026-10-18).
Artinya: dua lapis WorkMode/PermissionMode, taksonomi DISCUSS/PLAN/EXECUTE,
lapisan intent tipis (tanpa engine baru), tanpa eskalasi implisit, matriks 18
sel sebagai baseline arah, dan Minicore boleh diubah **bila bukti teknis
mengharuskan**. Yang belum disetujui: detail implementasi (bentuk registry,
wiring TUI/flag, perubahan semantik `always`, patch vendor spesifik, perluasan
observability) — semuanya PENDING. Langkah implementasi pertama yang sah:
**S1 contract tests** (desain di §6; file tes TIDAK dibuat dalam tugas ini).

## 2. Tabel keputusan pemilik (format REV-2)

| ID | Arah keputusan | Status arah | Detail tersisa | Menghalangi apa |
|---|---|---|---|---|
| D-1 | WorkMode dan PermissionMode terpisah (dua lapis; DISCUSS/PLAN/EXECUTE; intent tipis; tanpa eskalasi implisit; DISCUSS read-only; PLAN kontrak lama; EXECUTE ikut PM; kompat 6 mode) | **OWNER APPROVED — DIRECTION** | Validasi 18 sel matriks saat implementasi; wiring permukaan (flag/TUI/picker); konflik sel → keputusan | Implementasi WorkMode sebelum kontrak tes (S1) disiapkan |
| D-2 | Pisahkan lifecycle mode (tidak dipersist) dari persistensi grant/allowlist | **OWNER APPROVED — DIRECTION** | Setiap perubahan semantik `always` (masa berlaku/cakupan/lokasi) | Perubahan persistensi apa pun |
| D-3 | Kebijakan read-only yang dipaksakan tidak dapat dilemahkan (readonly di luar picker; injected tak lemah via `/mode`, Shift+Tab, sub-agen, jalur lain; WorkMode tak boleh mencabut restriksi policy) | **OWNER APPROVED — DIRECTION** | Detail implementasi + tes bypass | Perubahan runtime switching |
| D-4 | Registry kanonik dengan kesetaraan perilaku (anti-drift; refactor awal mempertahankan keputusan observable; boundary tetap defense-in-depth; replay + regression membuktikan setara) | **OWNER APPROVED — DIRECTION** | Bentuk registry final + suite replay | Refactor registry (sampai S1 hijau) |
| D-5 | Minicore boleh diubah bila bukti mengharuskan (tanpa larangan absolut; bukan demi kerapian; prasyarat bukti) | **OWNER APPROVED — DIRECTION** | Keputusan patch vendor spesifik | Setiap perubahan vendor |
| D-6 | Pertahankan observability denial/approval saat ini terlebih dahulu | **OWNER APPROVED — DIRECTION** | Perluasan event/UI bila diajukan (keputusan terpisah + tes kompatibilitas) | Perubahan kontrak observability |
| D-7 | Baseline terfokus per slice di atas baseline terdokumentasi (tanpa klaim strict-green; berhenti pada kegagalan baru tak terjelaskan) | **OWNER APPROVED — DIRECTION** | Kriteria konkret "kegagalan baru" per slice | Memulai slice tanpa focused baseline |

Catatan D-1 (aturan konflik): bila pengujian implementasi menunjukkan sel
matriks bertentangan dengan kontrak lama, sel itu dilaporkan sebagai **konflik
yang membutuhkan keputusan** — perilaku lama TIDAK diubah berdasar asumsi
baru.

## 3. Ledger status (tiga lapis, diperinci)

### 3.1 OWNER APPROVED — DIRECTION (2026-10-18)

- D-1: dua konsep terpisah; WorkMode awal `DISCUSS|PLAN|EXECUTE`; lapisan
  intent tipis, bukan engine duplikat; WorkMode tak menaikkan kewenangan PM
  secara implisit; DISCUSS read-only, tanpa mutasi/eksekusi berdampak
  implisit; PLAN mempertahankan kontrak planning eksisting; EXECUTE
  memakai kewenangan PM (bukan izin tak terbatas); keenam PM lama tetap
  kompatibel; matriks REV-1 = baseline arah.
- D-2: state WorkMode & PM tidak otomatis dipersist; refactor tanpa
  perubahan perilaku tak menyentuh semantik persistensi; K-1 wajib.
- D-3: `readonly` tetap di luar pemilih interaktif biasa; policy restriktif
  terinjeksi tak bisa dilemahkan lewat jalur mana pun; WorkMode tak mencabut
  pembatasan policy.
- D-4: evaluasi registry kanonik; refactor awal mempertahankan keputusan
  permission observable; enforcement boundary tetap; replay/regression
  wajib membuktikan kesetaraan.
- D-5: vendor changes diperbolehkan bila bukti menunjukkan interface ada
  tak memadai; prasyarat sebelum patch: (i) bukti kebutuhan tak terpenuhi di
  application layer, (ii) kontrak interface diusulkan, (iii) tes boundary.
- D-6: kontrak observability eksisting dipertahankan pada pekerjaan awal P12.
- D-7: P12 direncanakan di atas baseline health terdokumentasi; focused
  baseline sebelum/sesudah tiap slice; berhenti pada kegagalan baru tak
  terjelaskan; tanpa klaim strict-green; tanpa full suite/gate mahal di tugas
  dokumen.

### 3.2 PENDING — IMPLEMENTATION DETAIL

- Validasi replay 18 sel matriks (design-verified, belum replay-proven).
- Permukaan WorkMode: flag CLI/env/picker TUI, label, transisi eksplisit
  operator (desain §4; pilihan bentuk menunggu keputusan implementasi).
- Semantik `always`: masa berlaku, cakupan, lokasi penyimpanan — setiap
  perubahan = keputusan terpisah (lihat §5).
- Tes bypass D-3 (daftar jalur + kasus) — dirancang di S1/S3, disetujui saat
  implementasi.
- Bentuk final registry (D-4) + suite replay setara.
- Patch vendor spesifik (D-5) — menunggu bundle bukti (prasyarat i-iii).
- Perluasan event denial/UI (D-6) — ADR terpisah bila diajukan.
- Kriteria berhenti konkret per slice (D-7) — ditetapkan per rencana slice.

### 3.3 BLOCKED

- Implementasi WorkMode — sampai kontrak tes (S1) siap dan disetujui.
- Refactor registry — sampai S1 membuktikan baseline memadai + desain
  no-behavior-change.
- Setiap perubahan `vendor/minicore` — sampai bundle bukti D-5 lengkap
  (kandidat pemicu: temuan S3, terutama `src/daemon/**` yang belum
  diverifikasi).
- Setiap perubahan persistensi/`always` — sampai disetujui eksplisit.
- Perubahan kontrak observability — sampai keputusan terpisah.
- Menandai P12 implementation "started" — tugas ini dokumen saja.

## 4. Kontrak kompatibilitas WorkMode (baseline arah — S2)

Status: **OWNER APPROVED — DIRECTION** (matriks REV-1 §3.3). Teks tetap
identik dengan REV-1; diulang ringkas sebagai kontrak yang akan diuji.

### 4.1 Invariant

- **INV-WM1** WorkMode tidak pernah menaikkan ceiling PermissionMode;
  otoritas efektif = irisan (ceiling WorkMode ∧ PermissionMode ∧ policy
  terinjeksi ∧ jail/bash-guard/sandbox).
- **INV-WM2** kombinasi apa pun tetap tercekung: WorkMode hanya memperketat
  (mis. DISCUSS×allow-all tetap baca-saja).
- **INV-WM3** sesi ber-policy terinjeksi (6S, sub-agen F-07) tidak tersentuh
  pemetaan WorkMode (6U: policy bukan mode, tanpa `__setMode` —
  `app/session.ts:148-169`).
- **INV-WM4** transisi yang menambah kapabilitas (DISCUSS→PLAN/EXECUTE,
  pelonggaran PM) wajib aksi eksplisit operator; tidak pernah dipicu
  keluaran model.

### 4.2 Matriks 18 sel (disetujui arahnya; sel = set keputusan efektif)

| WorkMode \ PM | auto | ask | plan | allow-all | allowlist | readonly |
|---|---|---|---|---|---|---|
| DISCUSS | readonly-set, tanpa prompt | readonly-set, tanpa prompt | readonly-set | readonly-set | readonly-set | readonly-set |
| PLAN | set-plan | set-plan | set-plan (=identitas) | set-plan | readonly-set (irisan) | readonly-set |
| EXECUTE | auto (identitas) | ask (identitas) | plan (identitas) | allow-all (identitas; bash-guard tetap) | allowlist (identitas) | readonly (identitas) |

`readonly-set` = `READONLY_TOOLS` (`permission.ts:31-50`); `set-plan` =
readonly + `todo_write` + `delegate_task`(anak forced-explore) +
`submit_result` (`:295-301`). Semua sel tetap tunduk jail/bash-guard/
headless-deny dan pemetaan hooks (`shouldRunHooks`).

**Aturan konflik:** sel yang saat replay implementasi terbentur kontrak lama
tidak diubah diam-diam — dicatat sebagai konflik, diberi bukti, dan
diputuskan pemilik.

## 5. K-1: semantik `always` & pemisahan tiga state (D-2)

Status: arah **OWNER APPROVED — DIRECTION**; perilaku saat ini dikunci
sebagai fakta; setiap perubahan = PENDING.

| Lapis state | Isi | Persistensi |
|---|---|---|
| Mode runtime | `state.mode` di handler; diubah `__setMode` (Shift+Tab) | Tidak — dihitung ulang dari flag/env saat proses/resume |
| Grant/cache runtime | `sessionGrants` (jawaban "always" sesi ini), `allowlistCache`, `denyReasons` map | Tidak — mati bersama proses |
| Penyimpanan persisten | `.minicode/allowlist.json` repo-lokal — **ditulis `saveAlways`** (`permission.ts:272` → `allowlist.ts:41-52`, default LOCAL); `~/.minicode/allowlist.json` global — **tanpa penulis kode** (manual) | Ya — dibaca kembali hanya dengan opt-in `--allow-local-config` |

Kewajiban refactor: pertahankan semantik `always` eksisting (kunci penuh
`name:argsJSON`, cap arg >2 KB tak disimpan, tulis repo-lokal, read-back
opt-in, efek live via sessionGrants). Perubahan masa berlaku/cakupan/lokasi
adalah **perubahan perilaku tersendiri = PENDING** sampai disetujui
eksplisit.

## 6. S1 — Desain contract tests (rencana; TIDAK diimplementasikan di tugas ini)

Tujuan S1: merekam perilaku PermissionMode + enforcement **saat ini** sebagai
kontrak terukur sebelum refactor apa pun (prasyarat BLOCKED di §3.3).

### 6.1 Berkas yang diperluas (eksisting, terverifikasi)

1. **`test/permission-matrix.test.ts`** (9 test: anchor 37-nama + 6 replay
   mode × 37 tool + varian TTY ask/auto + varian sandbox code_run).
   - Kondisi awal: hermetik (tmp root per test), save/restore
     `MINICODE_SANDBOX`/`MINICODE_BASH_ALLOWLIST`, TTY-aware
     (`process.stdin.isTTY`), keputusan via `createPermissionHandler(...).check`
     tanpa eksekusi tool.
   - Perilaku diharapkan (dipertahankan hijau): keputusan headless per mode
     sesuai mirror-set test (duplikasi sadar `READONLY/FILE_WRITE/
     INTERNAL_WRITE/GATED/NO_PROMPT`).
   - Perluasan: kasus tepi jail di dalam matriks (tulis di luar root, berkas
     sensitif, owned-state `.minicode/`, move_file dua ujung, `cwd` di luar
     root untuk bash/glob/grep/git_*) — anchor 37-nama TIDAK disentuh di S1
     (penggantian anchor = pekerjaan S4).
   - Detektor mutasi (harness baru `scripts/p12-mutation.ts`, gaya
     `scripts/phase6z-mutation.ts`: anchor→replacement→tests, verdict
     KILLED/SURVIVED/EQUIVALENT/UNOBSERVABLE/HARNESS GAP): (M1) jail
     mendahului mode dilepas → tulis luar-root di allow-all harus ketahuan;
     (M2) inspeksi bash allow-all dilepas → `rm -rf` lolos harus ketahuan;
     (M3) salah satu ekstra plan dihapus → replay plan merah.
   - Jalankan fokus: `bun test test/permission-matrix.test.ts`
     (filter: `bun test -t "matriks"`).
2. **`test/delegate-audit.test.ts`** (17 test eksisting; F-07 + mapping
   sudah tercakup di `delegate: forced explore…` dan
   `delegate: gate parent per mode…`).
   - Perluasan S1: kunci parent `ask` → anak forced-explore sebagai kasus
     eksplisit (kini implisit dalam test forced-explore) + mapping
     `allowlist→allowlist, selain itu auto` (`task.ts:449`).
   - Detektor mutasi: hapus `parentMode === "ask"` dari `forcedExplore`
     → test baru harus merah.
   - Jalankan fokus: `bun test test/delegate-audit.test.ts`.

### 6.2 Berkas baru yang diusulkan (isi dirancang, belum dibuat)

3. **`test/permission-contract.test.ts`** — kontrak keputusan lintas-kasus:
   headless deny (tanpa `ask` → deny, nol prompt); abort sebelum check →
   deny (`permission.ts:377`); allow-all tetap bash-guard (`:483-496`);
   `describeDenial` baca-sekali + tak pernah gagalkan gate (executor
   `:62-68`); **perekaman K-1**: `saveAlways` menulis
   `<root>/.minicode/allowlist.json`; handler baru tanpa `allowLocal`
   TIDAK menghormatinya; dengan `allowLocal:true` menghormati;
   `matchAllowlist` kunci penuh (tanpa prefix-truncation).
   - Detektor mutasi: (M4) `saveAllowlist` diarahkan ke global → test K-1
     merah (lokasi tulis berubah); (M5) `allowLocal` default `true` → test
     inert merah.
   - Jalankan fokus: `bun test test/permission-contract.test.ts`.
4. **`test/resume-permission.test.ts`** — D-2: mode dihitung ulang saat
   resume (tidak dipersist); grant sesi mati bersama proses; satu-satunya
   sumber lintas-proses = berkas allowlist (global manual + lokal opt-in).
   - Detektor mutasi: (M6) persist `state.mode` (hipotetis) → test merah.
   - Jalankan fokus: `bun test test/resume-permission.test.ts`.

### 6.3 Disiplin eksekusi (D-7)

- Focused baseline sebelum & sesudah S1: empat berkas di atas + `bun x tsc
  --noEmit` pada berkas terdampak. Full suite/gate mahal TIDAK dijalankan.
- Kriteria berhenti: kegagalan baru yang tak terjelaskan pada baseline
  fokus → slice dihentikan, dilaporkan.

## 7. S3 — Rencana investigasi parity enforcement (setelah S1/S2)

Verifikasi jalur per jalur dengan sentinel: REPL, one-shot, ACP
(`acp.ts:375-378` — sudah terverifikasi statis), MCP serve
(`mcp/server.ts:91-92` validate-first), sub-agen (`task.ts:226-236,449`),
scheduler/autonomous (6S), hooks (`run.ts:20-22`), dan **daemon
(`src/daemon/**` — belum diverifikasi baris-per-baris; prioritas pertama,
gerbang evaluasi D-5)**. Deliverable: temuan + usul scaffold tes; bukan
perubahan kode.

## 8. S4 — Usul refactor registry (terjadwal bersyarat)

Baru dijadwalkan **jika** S1 membuktikan baseline memadai dan desain registry
terbukti no-behavior-change (replay setara per mode). Termasuk: penggantian
jangkar rapuh "37 nama" (`permission-matrix.test.ts:98-101`) dengan ekui-
valensi kelas, matriks §4.2 sebagai fixture data, boundary enforcement tetap
sebagai defense-in-depth.

## 9. Risiko & gap bukti

1. Matriks 18 sel design-verified terhadap kode handler, **belum**
   replay-proven (pekerjaan S1/S2) — risiko konflik sel ada; aturan konflik
   §4.2 mengikat.
2. `src/daemon/**` unverified — satu-satunya kandidat jalur sesi di luar
   `app/session.ts`; gerbang keputusan patch vendor D-5.
3. Fakta QA dipertahankan apa adanya: `gate:pack` FAIL (21 pass/2 fail;
   4121 KB vs ambang 2304 KB; 2 kegagalan baseline terjelaskan),
   `gate:coverage` FAIL karena status test (13 gagal; funcs 87,05% ≥ 85;
   lines 88,06% ≥ 86; 19/19 lantai kritis hijau), pemeriksaan NOT RUN,
   serta **selisih 14 vs 13 kegagalan** (QA pasca-integrasi `dbcf836` = 14;
   gate final `609a417` = 13) yang belum direkonsiliasi — tanpa klaim
   strict-green.
4. Niat pemilik untuk "IDE auto tanpa ask" (ACP) masih butuh konfirmasi —
   dulu bagian D-1, kini pertanyaan terbuka.
5. ADR historis (6S/6U/F-07/M15/C3/ADR-25) hanya sebagai komentar kode; S0
   menuliskannya bila diminta.
6. Jumlah test = inventaris terverifikasi parsial (permission-matrix 9,
   delegate-audit 17 — dihitung langsung); sisanya dari audit P12.0.

## 10. Verdict

**`READY FOR NEXT IMPLEMENTATION REVIEW`** — arah D-1…D-7 tercatat
disetujui pemilik (2026-10-18), detail PENDING terpisah eksplisit, BLOCKED
terformalkan (S1 lebih dulu), rencana S1 siap tanpa implementasi, K-1
dipertahankan. Tidak ada temuan yang menggagalkan review implementasi
berikutnya.

---

*REV-2 design-only: repo tidak berubah; tidak ada staging/commit/push/
fetch/reset/rebase; tidak ada full suite/gate mahal; P12 tidak ditandai
dimulai; semantik `always` dan kontrak PermissionMode tidak diubah.
Basis: `main = 93f417900493572f5cdc479eb547de01707b28a6`.*


