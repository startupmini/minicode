# P13.6 — Laporan Forensik & Penutupan Fase P13 (stage-scoped)

**Tanggal:** 2026-10-23/24
**Workspace:** `D:/Github/minicode`
**Branch / HEAD:** `main` / `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4` (tidak berubah sejak preflight P13.5)
**Status perubahan:** seluruh kerja P13 **belum di-commit**; `ROADMAP.md` tetap draft untracked milik pemilik dan tidak disentuh.

> **Anotasi konsolidasi 2026-10-25:** pernyataan "`ROADMAP.md` tidak disentuh" berlaku untuk tugas P13.6 ini. Konsolidasi akhir 2026-10-25 kemudian memperbarui `ROADMAP.md` (masih uncommitted). P14 kemudian diimplementasikan pada scope core + lite dan didokumentasikan di `P14_REPORT.md`; status P13 di roadmap adalah implementation closure `CLOSED / VERIFIED — DOCUMENTED LIMITATIONS`, dengan persetujuan/commit tetap keputusan pemilik. Bukti dan angka stage-scoped di laporan ini tidak berubah.

> **Verdict:** P13.6 selesai. Dua temuan forensik diperbaiki (keduanya diuji
> deterministik, tanpa tidur arbiter), sepuluh gate final literal hijau pada
> SATU kandidat working tree yang tidak berubah selama run (bukti snapshot
> §5), dan seluruh invariant P13.1–P13.5 tetap teruji di run penuh yang sama.
> Rekomendasi: **P13 CLOSED / VERIFIED** (untuk disetujui pemilik).

---

## 1. Temuan urutan live-vs-durable: defect terkonfirmasi + koreksi terkecil

### 1.1 Rantai yang dilacak (dari sumber, bukan asumsi)

1. Adapter presentasi menetapkan `eventSeq` sinkron (`src/presentation/adapter.ts`).
2. `cli/setup.ts` `presentation.onEvent`: **pra-fix** memanggil `publishDomainEvent(e)`
   SINKRON — sebelum append durable apa pun.
3. `publishDomainEvent` → feed hosted `liveSubscribe` → `src/daemon/server.ts#fanout` →
   `#pump` mengirim `{t:"event", provenance:"LIVE"}` dan **memajukan cursor koneksi**.
   Tidak ada satu pun pemeriksaan `seq <= head` di jalur live.
4. Konsumen `ack(seq)` → `Subscription.ack` memvalidasi **`seq <= cursor koneksi`**
   (yang sudah dimajukan live), BUKAN kepala durable → `writeConsumerOffset`
   menulis offset ke **DB sesi yang sama** dengan event presentasi.
5. Sementara itu append durable berjalan BELAKANG: `queuePresentationEvent` →
   `setTimeout(flushPresentationEvents, 0)` → `appendPresentationEvents` async.
   Kegagalan append = warn saja; batch sudah di-splice, **tidak di-retry**.
6. Replay membaca toko (`readRange`); `resume` memulai dari offset+1.

**Jendela yang terekspos:** event live (dan ack-nya) bisa mendahului barisnya di
toko durable. Bila append gagal atau proses mati di jendela itu, offset durable
melampaui sejarah yang benar-benar ada dan konsumen-konsumen melihat sejarah
**divergen** (pemegang live menyimpan seq yang tidak akan pernah bisa
direkonstruksi siapa pun).

### 1.2 Reproduksi deterministik (defect-proof, kode pra-fix)

Berkas uji versi defect-proof (diganti setelah fix) menyuntik kegagalan append
lewat seam `presentationAppend` — tanpa tidur arbiter, tanpa monkey-patch.
`bun test test/p13-live-durable-ordering.test.ts` (versi defect-proof, pra-fix):
**1 pass · 7 expect · 753 ms**. Yang dibuktikan:

- Turn 1 berjalan dengan **100% append gagal** (2 warn "persist failed").
- Konsumen A tetap menerima event live, `ack` **diterima**, dan
  `readConsumerOffset == maxLive` sedangkan `presentationHead == -1 < maxLive`
  — **offset durable melampaui kepala durable**.
- Konsumen B (baru, replay dari 0) menerima **nol** event.
- Setelah gate dilepas dan turn 2 durable, replay konsumen C **hanya** memuat
  seq turn 2; seluruh seq turn 1 yang di-ack A hilang permanen dari toko.

Catatan provenance: dua run pertama versi defect-proof gagal karena kekurangan
di sisi TES (belum menunggu sinyal durable; mode "lolos" gate tidak mendelegasi
ke append asli) — diperbaiki sebelum run bukti; kedua run tersebut tidak dipakai
sebagai bukti.

### 1.3 Koreksi terkecil (tanpa endpoint/antrean/protokol baru)

Diterapkan di **composition root saja** (`cli/setup.ts`):

- Event **durable** tidak lagi diterbitkan live dari jalur `onEvent`; ia
  diterbitkan `flushPresentationEvents` **SETELAH append sukses**, dijaga
  watermark `durableLiveSeq` (urutan terjaga; duplikat seq tidak dikirim ulang;
  batch gagal tidak pernah memajukan watermark ⇒ fail-closed).
- Event **non-durable** (delta) tetap langsung — feed daemon memfilternya dan
  UI butuh delta real-time.
- Pada kegagalan append (termasuk `StaleWriterError`): tidak ada yang
  diterbitkan live; warn tetap (degraded-loud), turn tetap selesai — kegagalan
  persistensi tidak pernah membohongi feed.

Kompatibilitas: bentuk pesan/provenance/protokol **identik**; satu-satunya
pergeseran adalah event durable live tiba setelah satu tick flush (orde ms).
Kontrak konsumen (`tail_marker`: "segala sesudah ini LIVE, perlakukan beda")
kini berlaku lebih ketat: event durable live selalu sudah durable. Tidak ada
operasi kontrol, endpoint, field, atau versi protokol baru.

### 1.4 Bukti pasca-fix — `test/p13-live-durable-ordering.test.ts` (3 test)

1. **Fail-closed**: append gagal ⇒ konsumen menerima **nol** event, head tetap
   `-1`, ack liar (seq 0) **ditolak server**, offset tetap `-1`, turn tetap
   COMPLETED (degraded-loud, bukan crash sesi).
2. **Pemulihan + konsistensi**: setelah gate dilepas, SETIAP event live yang
   diterima A dan B sudah durable **tepat pada saat diterima** (pemeriksaan
   `seq <= presentationHead` dilakukan di dalam collector pada tiap pesan —
   bukan di akhir); ack tersimpan dan `<= head`; konvergensi deterministik
   (`max(seq diterima) == head`) menunggu batch terakhir termasuk event
   pasca-turn; **view A == view B == view C (replay)** — tidak ada sejarah
   privat lagi.
3. **Jalur normal** (tanpa injeksi): invariant yang sama berlaku pada turn
   biasa.

Hasil final: **3 pass · 16 expect · 1,53 dtk**.

## 2. Temuan kedua: persetujuan hosted = kode mati (dilanjutkan dari inventaris awal P13.6)

`ApprovalBroker` + op `approval.decide`/`approval.list` + UNKNOWN-on-restart +
DENY-on-shutdown ada sejak P2.12, tetapi ask sesi hosted masih memakai
`promptAsk` TTY (non-TTY ⇒ deny) — tidak ada composition root yang memasang
`asPermissionAsk` (satu-satunya jembatan resmi). Seluruh bidang persetujuan
daemon tidak tersambung ke satu-satunya sesi yang seharusnya dilayaninya.

**Koreksi:** opsi aditif `permissionAsk?: PermissionAsk` di `CliSessionOptions`
(default `promptAsk` — non-TTY tetap deny, fail-closed), dipasang daemon lewat
`host.approvals.asPermissionAsk(...)`; `startDaemonHostedRuntime` meneruskan
seam uji `presentationAppend`. Tanpa op/endpoint/field protokol baru.

**Bukti — `test/p13-approvals-roundtrip.test.ts` (3 test, 24 expect):**
accept ⇒ tool benar-benar dieksekusi + baris `accepted`; deny ⇒ tool ditolak
tanpa merusak turn + baris `denied`; shutdown dengan persetujuan menggantung ⇒
DENY + baris `cancelled` + shutdown **menunggu** turn selesai.

## 3. Berkas yang berubah (P13.6)

| Berkas | Perubahan |
|---|---|
| `cli/setup.ts` | (1) opsi `permissionAsk` + threading ke `createMinicodeSession`; (2) seam `presentationAppend` (analog seam checkpoint jurnal; produksi tak mengeset); (3) koreksi urutan: publish event durable live hanya SETELAH append sukses + watermark `durableLiveSeq`. |
| `cli/commands/daemon.ts` | (1) memasang `asPermissionAsk` untuk sesi hosted; (2) meneruskan `presentationAppend` (seam uji). |
| `test/p13-approvals-roundtrip.test.ts` **(baru)** | 3 tes round-trip persetujuan hosted (accept/deny/shutdown-settle). |
| `test/p13-live-durable-ordering.test.ts` **(baru)** | 3 tes forensik live-vs-durable (fail-closed, konsistensi lintas konsumen, jalur normal). |
| `docs/ARCHITECTURE.html` | Dua klausul: wiring `asPermissionAsk` pada modul approvals; live = durable-confirmed pada modul feed. |
| `P13_6_REPORT.md` **(baru)** | Berkas ini. |

Pra-P13.6 (sudah dilaporkan di `P13_5_REPORT.md`): `test/p13-e2e-runtime.test.ts`,
seam `onDomainEvent` + perbaikan live feed, naik ambang `scripts/coverage-gate.ts`
(MIN_FUNCS 87). **Tidak ada berkas Agent B yang disentuh** (keystore/credential,
session-ID, SSRF `lib/net.ts`, bash-guard, sanitizer, glob, edit-integrity,
process-cleanup; 3 info lint di `test/session-id-portability.test.ts` tetap
pre-existing). `ROADMAP.md` tidak disentuh.

## 4. Matriks cakupan crash/restart/exhaustion (audit celah)

Legenda: **V** = tes deterministik bermakna; **F** = cacat direproduksi lalu
diperbaiki + regresi; **M** = missing (diperbaiki P13.6); **X** = eksplisit
tidak didukung / butuh verifier (diwariskan, bukan celah P13.6).

| Skenario | Status | Bukti |
|---|---|---|
| Append presentasi gagal ⇒ live/ack/replay | **F** (defect-proof pra-fix → fix + 3 regresi) | `p13-live-durable-ordering` |
| Append/flush jurnal eksekusi gagal ⇒ `durability-uncertain` jujur | V | `execution-journal` (seam checkpoint), `runtime-shutdown` S10, `recovery` |
| Intent dispatch gagal tulis ⇒ dedupe lintas-restart konservatif | V | `production-execution` metrics + `m15`/journal suite |
| Jurnal rusak saat start ⇒ konstruksi ditahan (fail-closed) | V | `runtime-production` (M14) |
| Crash setelah claim ⇒ reconcile aman, generasi baru (bukan replay) | V | `p13-task-continuity` 1/5, `p13-daemon-lifecycle` |
| Kerja berjalan tanpa marker ⇒ HOLD/REQUIRES_VERIFIER | V | `p13-task-continuity` 2, 4a, 4b |
| Balapan authority/incarnation saat reconcile ⇒ tolak mutasi | V | `p13-task-continuity` 6a/6b/6c |
| Anak mati ⇒ restart bounded/backoff; unsafe/percobaan-habis/gagal/intensitas ⇒ eskalasi + degraded | V | `p13-runtime-supervision` (anak nyata `bun -e`) |
| Stop anak gagal ⇒ dihitung; shutdown menunggu anak mati (anti-yatim OS-level) | V | `p13-runtime-supervision`, `p13-daemon-lifecycle` |
| Cleanup shutdown gagal ⇒ dilaporkan, sisa tidak dilewati diam-diam | V | `p13-daemon-lifecycle` |
| Persetujuan: expiry ⇒ deny; storage gagal ⇒ deny; idempoten ganda; UNKNOWN-on-restart + keputusan belakangan ditolak; shutdown ⇒ DENY semua | V | `p2-daemon` (broker/mesin status) |
| Persetujuan hosted: round-trip konsumen nyata (accept/deny/shutdown) | **M→F** (wiring mati ditemukan P13.6) | `p13-approvals-roundtrip` |
| Tekanan penyimpanan ⇒ op mutasi ditahan `STORAGE_PRESSURE`, op baca jalan; monitor edge-trigger | V | `p2-daemon` (control + `checkStorage`/`ResourceMonitor`) |
| Backpressure/overflow per konsumen terisolasi, runtime tetap sehat | V | `p13-multi-consumer` |
| Reconnect offset logical/resume; capability incarnation basi mati; ack di atas cursor ditolak | V | `p13-multi-consumer`, `p2-daemon` |
| Mode `off` legacy inert (tanpa runtime/jurnal/scheduler) | V | `p13-e2e-runtime` #2, `runtime-production` M14 wiring |
| Supervisi degraded ⇒ status jujur + admission REFUSE; kesehatan konsumen ≠ kesehatan runtime | V | `p13-e2e-runtime` #5 |
| ACP menempel ke daemon runtime bersama | **X** | Batas desain P13 (tidak berubah; eksplisit) |
| Event yang gagal append → retry-queue durable | **X** | Kebijakan saat ini: hilang dari sejarah durable + warn keras + **tidak pernah tampil live** (pasca-fix). Menambah retry = permukaan otoritas baru ⇒ keputusan pemilik (lihat §7.1) |
| Koreografi restart PROSES daemon utuh (spawn→kill→respawn→reconnect) | **X** (komponen teruji, koreografi tidak) | Komponen: incarnation (`p2-daemon` discovery + multi-consumer), UNKNOWN-on-restart (unit), offset/presentasi durable (ordering suite), jurnal crash (M12/recovery). Risiko residu rendah; lihat §7.3 |

**Total matriks: 20 baris skenario — 15 V + 2 diperbaiki (1 F + 1 M→F) + 3 X.**
Angka ini adalah hitungan baris tabel di atas; hasil tes historis di §5 tidak
berubah oleh koreksi aritmetika ini.

## 5. Gate final literal — SATU kandidat, tree tidak berubah

Snapshot pre-gate == post-gate: **165 baris status / 37 untracked, HEAD
`2d9e11e9`, 0 berkas terlacak tersentuh selama jendela gate 55 menit**
(difingerprint dengan `git ls-files` + mtime; mencakup kedua run suite penuh).

| Perintah | Hasil | Exit |
|---|---|---|
| `bun test` | **5029 pass · 19 skip · 0 fail**; 5.048 tes / 342 berkas; 388.080 expect; 1.180,78 dtk | **0** |
| `bun run gate:coverage` | funcs **88,10%** (min 87) · lines **89,00%** (min 86) · lantai per-berkas **19/19** hijau; 1.136 dtk | **0** |
| `bun x tsc --noEmit` | bersih | **0** |
| `bun run lint` | 620 berkas; 0 error; 3 info (`test/session-id-portability.test.ts`, milik Agent B, pre-existing) | **0** |
| `bun run gate:pack` | 23 pass · 0 fail; 283 berkas; **3.360 KB** unpacked (budget 3.584 KiB) | **0** |
| `bun run gate:bash` | bypass **0/62** · over-block **0/24** (mode auto + allowlist) | **0** |
| `bun run bench:smoke` | 13/13 PASS; resolve rate 1; fail distribution (none) | **0** |
| `bun run audit:harness` | 60 pass · 0 fail · 2 advisory (fake bench results — non-blocking) | **0** |
| `bun run gate:telemetry` | `no traces.jsonl — skipping telemetry gate` (jalur skip resmi skrip) | **0** |
| `bun run vendor:check` | vendor/minicore 20 berkas, hash `c8d214bb8d5eea86`, sinkron dengan VENDOR.md | **0** |

Regresi terfokus pra-gate (kandidat yang sama): P13/daemon/protocol 109 pass
(7 berkas termasuk 3 berkas uji baru) + presentation/checkpoint/ACP/runtime/
m15 311 pass (14 berkas) — semua exit 0.

**Keputusan ambang coverage:** kenaikan dari run P13.5 (88,00→88,10 funcs;
88,94→89,00 lines) = +0,10/+0,06 pp — kelas noise di bawah preseden pemicu
naik-ambang (+0,15 pp) dan jauh di bawah kelas "signifikan" lines (+0,82 pp).
Minimum tetap **87/86** (tidak pernah diturunkan).

## 6. Invariant P13.1–P13.6 tetap utuh

Dibuktikan ulang oleh run penuh di atas (semua suite P13 hijau di run yang sama):

- SATU runtime kanonik: `daemon.status` = `deriveRuntimeView` lewat seam provider;
  dua konsumen melihat objek identik (`p13-e2e-runtime` #1).
- Admission fail-closed: penolakan tanpa callback, record durable utuh (#3);
  hanya `SAFE_TO_RETRY` yang kembali otomatis (P13.3 suite).
- Konsumen non-otoritatif: offset per identitas logis, live per koneksi,
  `QUEUE_OVERFLOW` halt, baris SQLite persetujuan yang memutuskan.
- Scheduler hanya `--runtime owned`; `off`/`constructed` inert.
- Supervisi: tidak ada anak yatim; degraded dijujurkan di status.
- Tidak ada operasi kontrol/endpoint/field protokol baru di P13.6.
- ACP tetap tidak menempel (batas desain, eksplisit).
- Kerja Agent B utuh (belum di-commit, tak tersentuh, lint info-nya pre-existing).

## 7. Skenario tidak didukung / risiko tersisa (jujur)

1. **Kehilangan event pada kegagalan append** tetap (by design saat ini):
   batch gagal hilang dari sejarah durable + warn keras + tidak tampil live.
   Menambah retry-queue = permukaan otoritas baru — di luar "koreksi terkecil",
   butuh keputusan pemilik.
2. **ACP** belum menempel ke daemon runtime bersama — tidak berubah di P13.
3. **Koreografi restart proses daemon utuh** (spawn→kill→respawn→reconnect
   dalam satu tes) tidak diuji end-to-end; seluruh komponen durability-nya
   teruji (matriks §4 baris terakhir). Risiko residu: rendah.
4. **Gate `gate:telemetry`** melewati jalur skip resminya (tidak ada
   `traces.jsonl` di lingkungan ini) — bukan hasil "rate hijau", hanya exit 0
   sesuai desain skrip.
5. `gate:slow` (extreme fuzz) tidak masuk daftar gate yang diminta dan tidak
   dijalankan di penutupan ini.

## 8. Rekomendasi

- **P13.6 CLOSED / VERIFIED** untuk lingkup yang divalidasi (kandidat
  working-tree ini, bukan klaim repository strict-green yang ter-commit).
- **P13 (P13.0–P13.6) CLOSED / VERIFIED**, menunggu persetujuan pemilik;
  pembaruan status di `ROADMAP.md` tetap otoritas pemilik.
- P14 **tidak dimulai** dalam tugas ini.
