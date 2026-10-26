# P13.5 — Laporan Implementasi & Validasi (stage-scoped)

**Tanggal:** 2026-10-23
**Workspace:** `D:/Github/minicode`
**Branch / HEAD:** `main` / `2d9e11e9dce9b1f8b4ae14ec67173faf192d5ed4`
**Status perubahan:** seluruh kerja P13 (P13.1–P13.5) **belum di-commit**; `ROADMAP.md` tetap untracked draft milik pemilik dan tidak disentuh.

> **Anotasi konsolidasi 2026-10-25:** pernyataan "`ROADMAP.md` tidak disentuh" berlaku untuk tugas P13.5 ini. Konsolidasi akhir 2026-10-25 kemudian memperbarui `ROADMAP.md` (masih uncommitted); bukti dan angka stage-scoped di laporan ini tidak berubah.

> **Verdict:** P13.5 selesai untuk lingkupnya. Full suite + coverage hijau
> (5023 pass · 19 skip · 0 fail), tipe/lint/pack/bash/bench/audit hijau pada
> kandidat working tree yang sama, dan tidak ada berkas terlacak yang berubah
> selama run penuh (bukti mtime di §5). Suite E2E baru menemukan SATU bug
> produksi nyata (live feed sesi hosted tidak pernah mengirim event) yang
> diperbaiki tanpa perubahan protokol. P13.6 dimulai setelah laporan ini.

---

## 1. Ruang lingkup

Hanya Big Phase **P13.5**: pembuktian end-to-end runtime produksi terintegrasi
lewat daemon yang benar-benar meng-host sesi — startup, readiness, admission,
eksekusi, status/provenance, beberapa konsumen, kegagalan, dan shutdown.
P13.6+ tidak diklaim.

Kebijakan yang dipertahankan:

- Baseline P13.1–P13.4 tidak didesain ulang; tidak ada operasi kontrol,
  endpoint, atau field protokol baru (lihat §8).
- ACP **tetap tidak** menempel ke daemon runtime bersama (§8 butir 1).
- Konsumen tetap non-otoritatif: offset durable per identitas logis,
  langganan live per koneksi, `daemon.status` hanya membaca runtime kanonik.
- Mode legacy `off` tetap inert: tanpa runtime, tanpa jurnal runtime, tanpa
  scheduler; `--runtime owned` eksplisit tetap satu-satunya yang menyalakannya.
- Admission tetap fail-closed; record durable tidak pernah dihapus oleh
  penolakan; telemetri tetap non-autoritatif.

## 2. Temuan utama: bug produksi pada live feed sesi hosted

`cli/commands/daemon.ts` memasang `liveSubscribe` dengan
`session.onPresentationEvent((e) => fn(e as never))` — sebuah **cast yang
berbohong**: `UiPresentationEvent` memakai field `seq` (opsional), sedangkan
kontrak feed (`src/daemon/server.ts#fanout`) membaca `event.eventSeq`.
Akibatnya **setiap event live dari sesi yang di-host diabaikan fanout secara
diam-diam**; hanya replay (yang membaca toko durable) yang bekerja. Ini
terlewat oleh suite P13.4 karena feed sintetisnya memasok `DomainEvent` asli,
dan terlewat oleh suite lifecycle karena tidak ada yang berlangganan live.

Perbaikan (bukan tambahan protokol):

- `cli/setup.ts`: seam baru `onDomainEvent` pada `CliSession` — subscriber
  menerima `DomainEvent` mentah (bentuk yang sama dengan yang dipersist)
  sebelum proyeksi UI; dibersihkan di `close()`.
- `cli/commands/daemon.ts`: feed live hosted memakai `onDomainEvent` dan hanya
  meneruskan event yang `DURABILITY[type].durable`, sehingga bahasa live =
  bahasa replay (delta non-durable tetap milik UI, bukan riwayat sesi).
- `docs/ARCHITECTURE.html`: satu klausul pada modul daemon store/feed.

Bentuk pesan protokol, scope, dan op tidak berubah; konsumen yang sudah ada
tidak melihat perbedaan bentuk — hanya bahwa live feed kini benar-benar hidup.

## 3. Berkas yang berubah

| Berkas | Perubahan |
|---|---|
| `test/p13-e2e-runtime.test.ts` **(baru)** | 5 tes E2E/fault-injection deterministik lewat `startDaemonHostedRuntime`, sesi hosted nyata, `TaskStore`, provider HTTP lokal. |
| `cli/setup.ts` | `onDomainEvent` (subscriber mentah + pembersihan di teardown); tanpa perubahan pada `onPresentationEvent`/proyeksi UI. |
| `cli/commands/daemon.ts` | `liveSubscribe` hosted memakai `DomainEvent` mentah + filter durable (mengganti cast yang rusak). |
| `docs/ARCHITECTURE.html` | Satu klausul: feed hosted memakai DomainEvent mentah; `eventSeq` live = bahasa replay. |
| `scripts/coverage-gate.ts` | Minimum FUNCS 86 → 87 (aturan AGENTS "coverage naik → naikkan minimum"; lihat §7). LINES tetap 86. |

Tidak ada berkas Agent B yang disentuh (`src/lib/keystore.ts`,
`src/lib/session-id.ts`, cleanup bash, config credential,
`test/session-id-portability.test.ts`). `ROADMAP.md` tidak disentuh.

## 4. Suite baru: apa yang dibuktikan

`test/p13-e2e-runtime.test.ts` — 5 tes, semuanya lewat komposisi produksi
nyata (bukan stub runner/status):

1. **Startup → dua konsumen → turn → admission durable → status → shutdown.**
   Runtime ACTIVE/ALLOW/HEALTHY dengan bukti lengkap; scheduler aktif;
   jurnal ada di disk; `startupRecovery` non-null & tidak korup. Dua konsumen
   melihat objek runtime yang IDENTIK (`toEqual`) + incarnation sama. Turn
   nyata (provider lokal) → kedua konsumen menerima event; runner
   `runtimeRuns=1 · admitted=1 · terminals.COMPLETED=1`; history jurnal
   eksekusi turn memuat event COMPLETED. Konsumen ketiga membuktikan REPLAY
   (provenance REPLAY, telemetri `events.replayed` > 0). Ack konsumen B
   tersimpan durable (`readConsumerOffset` === acked). Memutus konsumen A
   tidak menghentikan runtime/scheduler. Kerja `background` lewat runner
   produksi → COMPLETED + history jurnal + ownership scheduler tetap.
   Reconnect B dari `resume` tidak mereplay ≤ acked; turn kedua terlihat
   LIVE. Shutdown: admission tertutup, trackedWork pending 0,
   `outstandingAfter` kosong, jurnal closed, scheduler inactive,
   `shutdownErrors` kosong. **Reopen jurnal pasca-shutdown**: kedua eksekusi
   masih terbaca COMPLETED (durabilitas lintas-shutdown).
2. **Mode `off` tetap legacy.** Tidak ada runtime/jurnal/scheduler
   (`enabled=false`, `constructed=false`, runner `mode=off`, file jurnal
   TIDAK ADA), status kanonik ABSENT/REFUSE lewat `daemon.status`, turn
   legacy tetap berjalan dan terlihat konsumen (`legacyRuns=1`,
   `runtimeRuns=0`), `shutdownResult()` tetap null (handle inert).
3. **Runtime berhenti ⇒ admission fail-closed.** Setelah `stop()`, view
   STOPPED/REFUSE; `admitTaskWork(..., "background")` REFUSE;
   `executionRunner.run` menolak `RUNTIME_NOT_OWNED` **tanpa memanggil
   callback**; task tetap `IN_PROGRESS` dengan lineage/ownership identik;
   jumlah baris jurnal tidak berubah (tidak ada intent/event dari dispatch
   yang ditolak); shutdown daemon setelahnya tetap bersih.
4. **Shutdown menunggu kerja terlacak in-flight.** Kerja `background`
   diblokir di gate; `host.shutdown` dipanggil; setelah scheduler berhenti dan
   host-shutdown selesai (diamati via `lastShutdownDurationMs` + satu giliran
   event loop — metrik host yang sudah ada, bukan seam baru), shutdown masih
   tertahan. Gate dibuka → hasil `registered>=1 · drained>=1 · pending=0`,
   fase `execution-drain` succeeded, jurnal closed, dan reopen jurnal
   memuat COMPLETED untuk eksekusi tersebut.
5. **Degradasi supervisi jujur.** Anak `restartSafety: "unsafe"` gagal →
   escalation: view DEGRADED, admission REFUSE, kapabilitas
   `process-supervision` advertised-tapi-tidak-tersedia; konsumen TETAP
   terhubung dan membaca status yang sama (`connectionCount=1`, host tidak
   closing) — kesehatan koneksi ≠ kesehatan runtime. Kerja `turn` baru
   ditolak `RUNTIME_NOT_ADMITTED` tanpa callback; shutdown memanggil
   `stop()` anak tepat sekali dan fase `process-cleanup` succeeded.

Cakupan P13.5 lain diambil dari suite yang sudah ada (dijalankan ulang, §5):
backpressure/overflow per konsumen + refusal stale-incarnation/unauthorized/
idempotensi (P13.4), lease/incarnation/supersession/UNKNOWN/REQUIRES_VERIFIER
(P13.3), exhausted restart + degradation (P13.2), cleanup failure surfaced
(p13-daemon-lifecycle), crash-after-claim + reconcile aman (P13.3 lifecycle).

## 5. Perintah dan exit code

Semua dijalankan di `D:/Github/minicode`. Run penuh (#8) memakai kandidat T1;
satu-satunya perubahan terlacak SETELAH run #8 adalah ambang
`scripts/coverage-gate.ts` (file gate, tidak dieksekusi `bun test`) — bukti
mtime: dalam 75 menit terakhir hanya `scripts/coverage-gate.ts` @17:19:34
yang berubah, jadi tidak ada berkas terlacak yang berubah selama run penuh.
Gate tipe/lint/pack diulang pada kandidat final T2.

| # | Perintah | Hasil | Exit |
|---|---|---|---|
| 1 | `bun test test/p13-e2e-runtime.test.ts` | 5 pass · 0 fail · 122 expect · 2,31 dtk | **0** |
| 2 | `bun test` 8 berkas P13 (contract, supervision, lifecycle, multi-consumer, admission, continuity, lsp-production, e2e) | 158 pass · 0 fail · 761 expect · 11,43 dtk | **0** |
| 3 | `bun test` 8 berkas daemon/protocol/presentation/setup/ACP (p2-daemon, p2-daemon-guards, phase4a1-protocol-identity, p2-presentation, presentation-bridge, presentation-events, cli-setup-coverage, acp) | 212 pass · 0 fail · 699 expect · 25,02 dtk | **0** |
| 4 | `bun test` 13 berkas runtime/scheduler/task/m15 (runtime-production, runtime-shutdown, runtime-composition, runtime-host, m15-production-integration, phase6c-scheduler, phase4a2-taskstore-transaction, taskstore, task-invariants, task-contract-boundary, task-di, phase5-taskgraph, p2-taskgraph-epoch) | 323 pass · 0 fail · 1.355 expect · 36,80 dtk | **0** |
| 5 | `bun test` 7 berkas permission/work-mode (permission-contract, permission-matrix, permission-adversarial, phase6s, phase6z-m31, resume-permission, work-mode-runtime) | 102 pass · 0 fail · 933 expect · 5,25 dtk | **0** |
| 6 | `bun test test/cli-subcommands.test.ts` | 40 pass · 0 fail · 174 expect · 11,63 dtk | **0** |
| 7 | `bun test test/coverage-gate-decision.test.ts` (pasca-naik ambang) | 7 pass · 0 fail · 29 expect | **0** |
| 8 | `bun test --coverage --reporter dots --timeout 30000` | **5023 pass · 19 skip · 0 fail**; 5.042 tes / 340 berkas; 388.175 expect; 1.169,82 dtk | **0** |
| 9 | `bun scripts/coverage-gate.ts --report <output #8>` | funcs **88,00%** (min 87) · lines **88,94%** (min 86) · lantai per-berkas **19/19** hijau | **0** |
| 10 | `bun x tsc --noEmit` | bersih (T1 dan T2) | **0** |
| 11 | `bun run lint` | 618 berkas; 0 error; 3 info (`test/session-id-portability.test.ts`, milik Agent B, pre-existing) | **0** |
| 12 | `bun run gate:pack` | 23 pass · 0 fail; 283 berkas; **3.356 KB** unpacked (budget 3.584 KiB) | **0** |
| 13 | `bun run gate:bash` | bypass **0/62** · over-block **0/24** (mode auto + allowlist) | **0** |
| 14 | `bun run bench:smoke` | 13/13 PASS; resolve rate 1 | **0** |
| 15 | `bun run audit:harness` | 60 pass · 0 fail · 2 advisory (fake bench results — non-blocking) | **0** |

Catatan provenance: output run #8 ditangkap via PowerShell (artefak UTF-16)
lalu dikonversi ke UTF-8 untuk parsing gate #9 — isi identik. Evaluasi gate #9
adalah mode `--report` resmi skrip itu sendiri ( evaluator yang sama dengan
`gate:coverage`, tanpa menjalankan ulang suite); literal
`bun run gate:coverage` (dengan spawn testnya sendiri) akan dijalankan pada
kandidat final P13.6.

Run yang dibuang (bukan gate): iterasi awal suite E2E `2 pass · 3 fail`, lalu
`3 pass · 2 fail` — kegagalan itulah yang menemukan bug live feed (§2) dan
memaksa perbaikan pengamatan drain tes in-flight; keduanya diatasi sebelum
gate.

## 6. Bukti state/proses (bukan klaim pawai)

| Bukti | Sumber |
|---|---|
| Jurnal pasca-shutdown masih terbaca: kedua eksekusi (turn + background) memuat event `COMPLETED` | Tes 1 & 4, `openExecutionJournal(readonly)` |
| Penolakan admission tidak menulis intent/event (jumlah baris `readAll` tidak berubah) | Tes 3 |
| Task tetap `IN_PROGRESS`, lineage + ownership identik setelah penolakan | Tes 3, baris `tasks`/`executions` via TaskStore |
| Offset konsumen durable: `readConsumerOffset === acked` sebelum reconnect | Tes 1 |
| Telemetri nyata: `connections.opened ≥ 4`, `subscribe.attached ≥ 4`, `events.delivered > 0`, `events.replayed > 0` | Tes 1 |
| Proses anak disupervisi benar-benar dihentikan saat shutdown (`stopCalls === 1`, fase `process-cleanup` succeeded) | Tes 5 |
| Mode `off`: file jurnal runtime TIDAK dibuat | Tes 2, `existsSync(runtimeJournalPath)` false |

## 7. Coverage & keputusan ambang

Run penuh #8: **88,00% funcs / 88,94% lines** (baseline P13.3: 87,83/88,83).
Aturan AGENTS ("coverage naik → naikkan minimum") + preseden keputusan di
`scripts/coverage-gate.ts`: funcs +0,17 pp melewati pemicu preseden P12
(+0,15 pp → naik), jadi **MIN_FUNCS 86 → 87** (margin 1,00 pp). Lines +0,11 pp
identik dengan kelas "noise" yang dipertahankan P12 (+0,11 pp tidak dikunci),
jadi **MIN_LINES tetap 86**. Ambang tidak pernah diturunkan; lantai per-berkas
19/19 hijau.

## 8. Limitasi yang tetap terbuka (jujur, bukan sisa pekerjaan diam-diam)

1. **ACP belum menempel** ke daemon runtime bersama — tidak berubah di P13.5.
2. **Urutan live-vs-durable.** Fanout live terjadi sebelum flush durable
   presentasi (antrean async `setTimeout(0)` yang sudah ada sebelumnya).
   Konsumen bisa meng-ack event yang baris durable-nya belum tertulis; bila
   daemon mati di jendela itu, event absen dari riwayat durable (konsumen
   menyimpan salinannya sendiri; konsumen baru yang replay dari 0 tidak akan
   melihatnya). Bug live-feed lama membuat jalur ini mati total, jadi
   perilakunya baru *terlihat* setelah P13.5. Perbaikan = hanya teruskan event
   yang sudah durable-confirmed (perubahan pemesanan) → item forensik P13.6,
   keputusan pemilik.
3. **Kesehatan per-konsumen hanya in-process** (`connectionCount`, telemetri,
   kedalaman antrean). Keputusan P13.5: TIDAK menambah operasi/field protokol
   — penolakan `QUEUE_OVERFLOW` eksplisit + `daemon.status` kanonik + telemetri
   in-process dianggap cukup untuk lingkup ini; boleh dibuka ulang oleh
   pemilik/P13.6 dengan analisis kebutuhan nyata.
4. **Persetujuan hosted belum diuji P13.5** (turn tes hanya teks). Inventaris
   awal P13.6 sudah menemukan celah integrasi nyata: jalur `ask` sesi hosted
   masih memakai `promptAsk` TTY (non-TTY ⇒ deny) dan `ApprovalBroker`
   (beserta op kontrol `approvals`, UNKNOWN-on-restart, DENY-on-shutdown)
   belum dipasang oleh composition root daemon — `asPermissionAsk` tersedia
   tapi tidak ada yang memasangnya. Ini item kerja pertama P13.6.
5. **Gate literal** `bun run gate:coverage` (spawn sendiri) dijalankan ulang
   pada kandidat final P13.6 (lihat §5 catatan provenance).

## 9. Tumpang tindih kepemilikan berkas

- `cli/setup.ts` + `cli/commands/daemon.ts`: juga membawa kerja P13.2/P13.3
  (gate scheduler, lifecycle sesi hosted) — tambahan P13.5 bersifat aditif
  (seam `onDomainEvent` + filter durable); tidak ada perilaku lama yang
  dihapus.
- `docs/ARCHITECTURE.html`: satu klausul (dokumen ini memang sudah berada di
  working tree yang belum di-commit).
- `scripts/coverage-gate.ts`: perubahan ambang saja.
- Berkas Agent B tidak disentuh; 3 info lint di berkas tesnya pre-existing.
- `test/helpers/fake-provider.ts` dipakai ulang tanpa perubahan.

## 10. Berikutnya: P13.6 (forensic + closure prep)

1. Isolasi + putuskan celah persetujuan hosted (§8 butir 4): wiring
   composition-root daemon → `ApprovalBroker.asPermissionAsk` (tanpa op/field
   protokol baru), tes round-trip allow/deny lewat konsumen nyata, plus
   bukti UNKNOWN-on-restart & DENY-on-shutdown pada jalur hosted.
2. Forensik urutan live-vs-durable (§8 butir 2): uji deterministik perilaku
   saat ini, lalu proposal pemesanan untuk pemilik bila hasilnya dianggap cacat.
3. Pemetaan crash/restart/exhaustion yang tersisa vs suite existing
   (M12 recovery, P13.2 supervisi, P13.3 kontinuitas) — isi celah nyata saja,
   jangan duplikat.
4. Persiapan closure P13: konsolidasi bukti P13.0–P13.6 + daftar limitasi +
   keputusan R1 (backend eksekusi tetap DORMANT), lalu gate final literal pada
   SATU kandidat.
