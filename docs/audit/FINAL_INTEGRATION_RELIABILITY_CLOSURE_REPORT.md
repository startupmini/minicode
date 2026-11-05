# Laporan Penutupan Integrasi & Keandalan Lintas-Fitur — PROMPT 06

Tanggal: 2026-11-04 · Platform: Windows (win32 x64) · Runtime: Bun 1.4.3
Tree yang diuji: `HEAD = cb602124571d8e4638bdb47d38400c52d8fba976`, branch `main`,
**seluruh pekerjaan PROMPT 02–06 belum di-commit** (working tree).

Dokumen ini adalah laporan audit integrasi akhir untuk enam area temuan
(PROMPT 06 A–F) di atas change set PROMPT 02–05. Ia memisahkan tegas:
diimplementasikan, diuji, terbukti secara integrasi, **belum** diuji, dan
butuh keputusan pemilik.

---

## A. Ringkasan eksekutif

Status: **INTEGRATION CLOSED untuk enam area PROMPT 06**, dengan tiga item
yang sengaja tetap terbuka dan wajib terlihat oleh pemilik (lihat §F/§G):
keputusan titik emisi `task.status` (tampilan lease/incarnation belum ada),
verifikasi PTY Linux yang hanya bisa dibuktikan lewat konfigurasi CI (bukan
eksekusi lokal), dan kegagalan `gate:slow` opsional di harness stress
`extreme-shadow-git` (di luar rangkaian gate wajib dan di luar enam area).

Rangkaian gate wajib lulus pada satu tree yang sama:

| Gate | Hasil |
|---|---|
| `bun x tsc --noEmit` | lulus (tanpa output) |
| `bun run lint` | lulus (657 berkas, 0 error) |
| `bun test` | **5411 pass · 19 skip · 0 fail** (5430 test, 366 berkas, 1068,97 s) |
| `bun run gate:coverage` | funcs **88,10%** (min 87) · lines **88,92%** (min 86) · lantai 19/19 |
| `bun run gate:pack` | pass 23 · fail 0 · 295 berkas · **3839 KB** (budget 3840 KiB) |
| `bun run gate:bash` | bypass **0/62** · over-block **0/24** |
| `bun run bench:smoke` | resolve 13/13 (rate 1), delta 0,0% |
| `bun run audit:harness` | 60 pass · 0 fail · 2 advisory |

Temuan yang **tidak** lolos:

| Perintah | Status | Penyebab |
|---|---|---|
| `bun run gate:slow` | **FAILED** | `experiments/extreme-shadow-git.ts:99` — snapshot 2000 berkas mengembalikan `null` (398 390 ms) lalu `TypeError: null is not an object (evaluating 'base.tree')`. Fuzz bash-nya sendiri lulus (7773 varian berbahaya, 0 bypass). Opsional, di luar rantai gate wajib AGENTS.md. |

Ringkasan enam area: A (isolasi state per-instance), B (integritas approval /
TOCTOU), C (observability replay→live), D (lifecycle task & visibilitas anak),
E (konsistensi DB vektor ↔ MEMORY.md), F (paritas PTY/CI) — semuanya
diimplementasikan dan punya bukti test. Satu sub-temuan E (D4: tidak ada call
site produksi untuk reconcile) ditemukan **baru** saat audit ini dan ditutup
dengan subcommand CLI nyata.

---

## B. Integritas repository

| Item | Nilai |
|---|---|
| HEAD | `cb602124571d8e4638bdb47d38400c52d8fba976` |
| Branch | `main` |
| Commit/push/tag/reset/clean | **tidak ada** (semua perubahan tetap di working tree) |
| `vendor/minicore/**` | tidak disentuh (`git status` bersih untuk vendor) |
| Berkas pengguna | `t.log.txt`, `t.log.xml`, `t.xml`, `t2.log.txt`, `t3.log.txt` dipertahankan apa adanya |
| Artefak untracked lama | `a1.txt`..`g1.txt`, `.tmp-probe.ts`, `CODE_QUALITY_AUDIT_2026-11-04.md` dibiarkan (bukan milik perubahan ini) |
| `bun run vendor:check` | **NOT RUN** lokal (butuh checkout sibling `startupmini/minicore`); dijalankan CI. Vendor tidak berubah sehingga risiko drift tidak berasal dari change set ini |

Skala perubahan (tracked): **64 berkas** (`git diff --shortstat`: 3360 baris
ditambah, 443 dihapus; 43 berkas untracked termasuk 9 berkas baru milik change
set ini). Berkas baru yang menjadi bagian change set:

| Berkas baru | Peran |
|---|---|
| `src/ui/session-state.ts` | state UI per-sesi (Area A) |
| `src/policy/approval-binding.ts` | capture/verify/grant approval (Area B) |
| `test/ui-instance-isolation.test.ts` | bukti isolasi instance (A) |
| `test/approval-integrity.test.ts` | bukti binding + TOCTOU (B) |
| `test/daemon-stream-phase.test.ts` | bukti fase stream/badge (C) |
| `test/presentation-linear-acp.test.ts` (diubah) | bukti `task.status` linear/ACP (D) |
| `test/memory-consistency.test.ts` | bukti konsistensi memori (E) |
| `test/ci-glob-expansion.test.ts` | bukti paritas CI (F) |

Catatan urutan kerja: laporan ini ditulis **setelah** gate wajib lulus. Satu-
satunya perubahan pasca-gate adalah berkas laporan ini sendiri (tidak termasuk
`files` paket npm, tidak dipindai guard dokumentasi level atas); validasi ulang
pasca-tulis dijalankan dan dicatat di §E.

---

## C. Matriks penutupan

| Area | Temuan awal | Perubahan | Test/evidence | Status |
|---|---|---|---|---|
| **A-1** | State renderer hidup di modul singleton → dua sesi satu proses saling menimpa | `UiSessionState` per sesi; dibuat di `cli/setup.ts` (`createCliSession`), diteruskan eksplisit via `opts.uiState` ke `Transcript` dan `attachSimpleLogger`; modul `render/collapse|detail|reasoning` jadi delegator ke `defaultUiState` (kompatibilitas) | `test/ui-instance-isolation.test.ts` — dua `createCliSession` nyata + dua attachment nyata; mutasi A tidak menyentuh B; default modul dibandingkan sebelum/sesudah | VERIFIED |
| **A-2** | Buffer `/copy` + `pendingError` dihapus saat re-attach → `/copy [n]` untuk n>1 hanya satu turn | Buffer pindah ke `UiSessionState`; attach tidak lagi mengosongkan; `resetCopyBuffer()` eksplisit | `test/ui-instance-isolation.test.ts`, `test/tui-format.test.ts` (dipanggil `resetCopyBuffer`) | VERIFIED |
| **A-3** | Harness test merusak `process.stdout.isTTY` global (restore nilai saat install, bukan pristine) | `installFakeTty` menyimpan `PRISTINE_*_IS_TTY` sekali di module load | `test/helpers/tui-harness.ts`; suite TUI lulus berurutan | RESOLVED |
| **B-1** | Preview approval bisa basi: file dibaca ulang saat eksekusi; skema argumen preview salah untuk `edit/apply_patch` | `captureApprovalBinding` (hash args kanonis + fingerprint isi file) SEBELUM prompt; `verifyApprovalBinding` sesudah jawaban user; grant per-call | `test/approval-integrity.test.ts` (10 test, termasuk perubahan file selama prompt) | VERIFIED |
| **B-2** | Verifikasi lapis-1 saja masih menyisakan jendela antara "allow" dan eksekusi | Barrier efek di `src/app/session.ts` (selalu dipasang) memverifikasi ulang setelah seluruh await jurnal/no-progress, tepat sebelum kernel sinkron; deny reason additive `"approval-stale"` + `describeDenial` | `test/approval-integrity.test.ts` jalur kernel nyata; `test/approval-tui.test.ts`, `test/p15-phase2-*` regresi | VERIFIED |
| **B-3** | Pendekatan membungkus tool merusak identitas array tool live (WorkMode) | Wrapping dibatalkan; verifikasi di barrier | `test/work-mode-runtime.test.ts` lulus (124 test batch targeted) | RESOLVED |
| **C-1** | Klien tidak bisa membedakan replay vs live (badge F-DAEMON-1 tidak ada datanya) | `subscribed` membawa `phase` (additive) dari latch per-`Subscription`; `tail_marker` flip latch SEBELUM kirim | `test/daemon-stream-phase.test.ts` (8 test; host + klien loopback nyata) | VERIFIED |
| **C-2** | Fase tidak terekspos ke konsumen | `DaemonClient.phaseOf(sid)` + `streamProvenance(sid)`, clear saat close; badge memakai `provenanceMark` | `test/daemon-stream-phase.test.ts` | VERIFIED (level wire/API; tak ada renderer stream daemon in-repo — lihat §F) |
| **D-1** | `task.status` diproduksi tapi tidak dikonsumsi renderer linear | Cabang `task.status` di `src/ui/assistant/simple.ts` + dedup per turn + sanitasi id/parent/deps/revision | `test/presentation-linear-acp.test.ts` (render, dedup, event rusak diabaikan) | VERIFIED |
| **D-2** | ACP tidak memproyeksikan lifecycle task | `projectAcpLifecycle` menangani `task.status` + header protokol didokumentasikan | `test/presentation-linear-acp.test.ts` | VERIFIED |
| **D-3** | Notice task hilang di mode proyeksi `normal`; field task tidak terstruktur | `SystemEntry`/`UiPresentationSystem` membawa `taskId/taskStatus/parentId/dependsOn/revision`; reducer mengisi; `selectNodes` mempertahankan notice task | `test/presentation-policy.test.ts`, `test/presentation-projections.test.ts` | VERIFIED |
| **D-4** | Emisi `task.status` hanya di verify-settle; tampilan lease/incarnation/executionOwner belum ada | **Keputusan sadar**: emisi tetap di settle (lifecycle per-step sudah lewat `plan.updated`); duplikasi tiap transisi TaskStore akan double-report. Item tampilan lebih dalam tetap deferred | Tidak ada test untuk tampilan yang belum ada | NEEDS-OWNER-DECISION |
| **E-1** | `revokeByProvenance` memakai OR + regex tag salah → revoke satu kriteria menghapus baris tanpa tag (fakta sesi lain); baris bertag malah tak terhapus | Semantik **AND** (cermin query vektor), baris tanpa tag fail-closed dipertahankan, regex greedy sampai `]` akhir baris | `test/memory-consistency.test.ts` (D2) | VERIFIED |
| **E-2** | Reconcile MENGHAPUS entri vector-only (kehilangan fakta saat crash after-vector-before-file) | Reconcile mengadopsi ke `MEMORY.md` (gabung chunk), tidak menghapus; hasil `{reconciled, vectorOnlyAdopted, fileOnlyAdded}` | `test/memory-consistency.test.ts` (D3), `test/p21-*`, `test/p24-*` | VERIFIED |
| **E-3** | `appendMemory` memotong entri 1000 char → chunk vektor dianggap vector-only lalu dihapus | Entri ditulis utuh (guard ukuran total berkas tetap) | `test/memory-consistency.test.ts` (D5) | VERIFIED |
| **E-4** | Supersession hanya menambah catatan; fakta lama tetap disajikan jalur file | `supersedeMemory` menghapus baris lama dari `MEMORY.md` (hanya bila supersession vektor berhasil) | `test/memory-consistency.test.ts` (D6) | VERIFIED |
| **E-5** | `forget`/cap/TTL menghapus per baris → chunk yatim (`parent` menggantung) | Hapus per ENTRI (`COALESCE(parent,id)`), `pruneMemoryCap` per entri | `test/memory-consistency.test.ts` (D8, D9) | VERIFIED |
| **E-6** | Respons embedding rusak (`data: []`, `embedding: null`, dim tak konsisten) diterima → vektor sampah | Validasi jumlah/dimensi/finite sebelum dipakai; bentuk salah → fallback keyword (`null`) | `test/memory-consistency.test.ts` (D12) | VERIFIED |
| **E-7** | Kegagalan indeks vektor dilaporkan sebagai sukses penuh | Hasil tool menandai `vector index unavailable … run memory reconcile` | `test/memory-consistency.test.ts` (D1) | VERIFIED |
| **E-8** | **Ditemukan saat audit**: pesan menyuruh `minicode memory reconcile`, subcommand itu tidak ada; `reconcileMemoryStores` tanpa call site produksi | Subcommand `memory reconcile [--json] [--cwd]` ditambahkan (satu writer stdout, stderr bersama, exit 1 fail-closed) | `test/memory-consistency.test.ts` (D4, spawn CLI nyata); `test/writer-inventory.test.ts` | RESOLVED |
| **F-1** | Job `ci-windows` memakai pwsh → glob tidak diekspansi; suite `p15..p24` lolos diam-diam. Pola mati `test/test/*.test.ts`, `test/bench/eval-gate.test.ts` | `shell: bash` pada step test Windows; pola mati dihapus | `test/ci-glob-expansion.test.ts` (3 test, assertions di-*derive* dari `ci.yml` nyata) | VERIFIED (konfigurasi) |
| **F-2** | Verifikasi exit code PTY (I28) flaky: probe sekali-jalan "ok", run sesungguhnya `exitCode: undefined` | Gate platform: POSIX assert penuh; Windows ConPTY = SKIP beralasan (didokumentasikan di kontrak) | `test/pty.test.ts` (lokal: 6 pass / 3 skip / 0 fail) | RESOLVED |
| **F-3** | Tidak ada test PTY yang meng-assert "stdout kosong selama alt-screen" (I3) | **Gap diakui**: PTY menyatukan stdout/stderr ke satu device, jadi tidak bisa membedakan stream; bukti I3 tetap fake-TTY + split-stream | Dicatat di `docs/TERMINAL_CONTRACT.md` §Gap proteksi | PARTIALLY RESOLVED |
| **F-4** | `delegate_task meneruskan abort ke child` flaky di suite penuh (abort 100 ms bisa jatuh saat `persistEffectIntent`, sebelum `pool.run`) | Test menunggu anak benar-benar mulai (dengan batas atas 5 dtk) sebelum abort; assertion tidak diubah | `test/hardening-boundary.test.ts`; 10× run ber-instrumentasi + 8× run biasa hijau | RESOLVED |

---

## D. Perubahan teknis (ringkas per area)

**A — isolasi state.** `src/ui/session-state.ts` (baru) memegang collapse,
compact, reasoning, detail/section buffer, buffer `/copy`, dan `pendingError`.
`cli/setup.ts` membuat satu instance per `createCliSession` dan meneruskannya
ke `Transcript` (`src/ui/tui/transcript.ts`) serta `attachSimpleLogger`
(`src/ui/assistant/simple.ts`). Modul lama tetap mengekspor API delegasi ke
`defaultUiState` supaya call-site one-shot/legacy tidak patah. Env hanya nilai
awal; setter tidak pernah menulis `process.env`. Harness test memakai
`isTTY` pristine agar tidak mewarisi mutasi test sebelumnya.

**B — integritas approval.** `src/policy/approval-binding.ts` (baru):
`canonicalArgsHash` + fingerprint isi berkas target; `capture` sebelum prompt,
`verify` setelah jawaban, `grant` hanya untuk call itu. `src/policy/permission.ts`
memanggil capture/verify/grant dan memancarkan deny `"approval-stale"`.
`src/app/session.ts` memasang barrier efek secara **selalu** (bukan hanya saat
detektor/jurnal ada) dan memverifikasi ulang setelah semua await, tepat sebelum
kernel mengeksekusi. `src/presentation/events.ts` menambah reason additive.

**C — observability daemon.** `src/daemon/subscription.ts` menyimpan latch fase;
`server.ts` mengirim `phase` pada `subscribed` dan pada `tail_marker`; `protocol.ts`
menambah field opsional; `client.ts` menyimpan latch per-sid, mengekspos
`phaseOf`/`streamProvenance`, dan membersihkannya saat close. Semua additive —
klien lama tetap sah.

**D — lifecycle task.** `task.status` (durable + replayable, sudah ada di
persistence) kini dikonsumsi di tiga permukaan: printer linear (`simple.ts`),
proyeksi ACP (`cli/commands/acp.ts`), dan state TUI (`transcript.ts`). Model
presentasi membawa field task terstruktur (`presentation/model.ts`,
`reducer.ts`, `ui/contract.ts`, `cli/setup.ts`); mode `normal` tidak lagi
membuang notice task.

**E — konsistensi memori.** `src/memory/vector.ts`: revoke AND + fail-closed,
adopsi non-destruktif saat reconcile, hapus per-entri, cap per-entri,
validasi respons embedding, supersession per-entri. `src/memory/files.ts`:
entri utuh (tanpa potong 1000 char), `memoryLineText`, `deleteMemoryEntry`.
`src/tools/memory.ts`: tag provenance ditulis ke berkas **sebelum** append,
baris lama dihapus saat supersession, pesan degradasi jujur.
`cli/commands/memory.ts`: subcommand `reconcile` (call site produksi pertama
untuk `reconcileMemoryStores`).

**F — PTY/CI.** `.github/workflows/ci.yml`: step test Windows memakai
`shell: bash`, pola mati dihapus. `test/pty.test.ts`: gate exit-code per
platform. `test/hardening-boundary.test.ts`: abort menunggu anak mulai.
`docs/TERMINAL_CONTRACT.md`: klausa I28 per platform + gap I3 eksplisit.

---

## E. Bukti pengujian

Tree identitas: `cb60212` + 64 berkas tracked termodifikasi + 9 berkas baru
(2 `src`, 7 `test`). Semua angka di bawah berasal dari **satu** eksekusi
rangkaian pada tree itu, kecuali yang ditandai.

Perintah dan hasil:

```text
bun x tsc --noEmit          → exit 0
bun run lint                → exit 0 (657 berkas)
bun test                    → 5411 pass / 19 skip / 0 fail (5430 test, 366 berkas, 1068.97 s)
bun run gate:coverage       → funcs 88.10% (min 87) · lines 88.92% (min 86) · 19/19 lantai
bun run gate:pack           → pass 23 · fail 0 · 295 file · 3839 KB (budget 3840 KiB)
bun run gate:bash           → bypass 0/62 · over-block 0/24
bun run bench:smoke         → 13/13 resolve (rate 1), delta 0.0%
bun run audit:harness       → 60 pass · 0 fail · 2 advisory
```

Suite PTY dijalankan di dalam `bun test` (Windows/ConPTY): 6 pass, 3 skip,
0 fail. Skip PTY memuat alasan eksplisit di nama test (antara lain exit code
I28: "Windows ConPTY tak menjamin `exitCode` anak").

Test targeted lintas-area (bukti bahwa perubahan saling terintegrasi, bukan
hanya hijau per modul): 124 pass / 0 fail pada 11 berkas — work-mode runtime,
work-mode CLI/prompt, approval-integrity, daemon-stream-phase,
ui-instance-isolation, presentation-observability/linear-ACP/policy,
memory-consistency, ci-glob-expansion.

Tidak dijalankan / tidak tersedia:

| Item | Status | Alasan |
|---|---|---|
| `bun run gate:slow` | **FAILED** (opsional) | Fuzz bash lulus (0 bypass / 0 over-block dari 7773 varian); `extreme-shadow-git` gagal: snapshot 2000 berkas `null` (398 s) → `TypeError` di `experiments/extreme-shadow-git.ts:99`. Tidak termasuk rantai gate wajib AGENTS.md dan tidak menyentuh kode enam area; **tidak terbukti** pre-existing (baseline tidak bisa dijalankan tanpa mengubah tree) |
| `bun run vendor:check` | NOT RUN | Butuh checkout sibling `startupmini/minicore`; vendor tidak berubah |
| PTY Linux (openpty) | NOT RUN lokal | Tidak ada runner Linux; jalur ini hanya terbukti lewat konfigurasi CI (job ubuntu, glob `test/p*.test.ts` diekspansi bash). Windows ConPTY yang teruji lokal |
| ConPTY CI Windows | NOT RUN | Job Windows kini memakai `shell: bash` (diperbaiki), tetapi eksekusi runner tidak dapat dilakukan dari mesin ini |
| `bun run gate:eval` (swebench) | NOT RUN | Butuh dataset/anggaran eksternal; `audit:harness` menandainya advisory |

Validasi pasca-tulis laporan: `test/web-build.test.ts` (guard dokumentasi) dan
`gate:pack` dijalankan ulang setelah berkas laporan ini ditambahkan; keduanya
tetap hijau (laporan tidak ikut paket dan tidak dipindai guard level atas).

Catatan kejujuran pengukuran: `bench:smoke` memakai provider fake
(`--fake`), jadi angka resolve rate **bukan** klaim kemampuan model — harness
audit mencetaknya sebagai advisory.

---

## F. Risiko tersisa

- **Tidak ada consumer stream daemon in-repo.** `phaseOf`/`streamProvenance`
  tersedia di `DaemonClient`, tetapi repo ini tidak punya layar/CLI yang
  men-stream event daemon (konsumennya eksternal). Badge karena itu terbukti
  di level wire + helper proyeksi, bukan di layar pengguna.
- **Tampilan lease/incarnation/`executionOwner` task belum ada.** Emisi
  `task.status` sengaja di verify-settle; duplikasi setiap transisi TaskStore
  akan double-report dan menginstrumentasi banyak penulis. Ini keputusan
  produk yang butuh persetujuan pemilik (`F-TASK-1` lanjutan).
- **I3 (tidak ada byte stdout selama alt-screen) tidak bisa di-assert lewat
  PTY**: PTY menyatukan stdout/stderr ke satu device. Bukti yang ada tetap
  fake-TTY + split-stream. Gap didokumentasikan, bukan diklaim tertutup.
- **Windows ConPTY tidak memverifikasi exit code I28.** Di POSIX assertion
  penuh; di Windows statusnya "tak dapat diverifikasi" (SKIP beralasan).
  Regresi yang hanya muncul sebagai "kode tak dilaporkan" tidak akan tertangkap
  di Windows — dinyatakan terbuka.
- **`gate:slow` merah di `extreme-shadow-git`** (2000 berkas, snapshot 398 s,
  hasil `null`). Kinerja snapshot pada repo sintetis besar belum memenuhi
  asumsi harness stress. Tidak memblokir gate wajib, tetapi merah secara
  observable.
- **Batas fingerprint approval**: `bash` hanya terikat pada argumen perintah,
  bukan efek file yang disentuh (tidak dapat difingerprint). Mode
  `always`/allowlist tidak punya grant untuk call berikutnya (tidak ada prompt
  = tidak ada bukti baru) — perilaku ini disengaja dan terdokumentasi.
- **Budget paket sangat ketat**: 3839 KB dari 3840 KiB (margin ≈ 1 KB).
  Penambahan kode/dokumen berikutnya akan langsung menyentuh batas; keputusan
  menaikkan budget tetap milik pemilik (tidak dinaikkan di sini).

---

## G. Penilaian akhir

**INTEGRATION CLOSED** untuk lingkup PROMPT 06 (area A–F) pada tree yang
diuji, dengan tiga item needs-owner-decision dan satu gate opsional merah yang
dinyatakan terbuka.

Sudah diimplementasikan:

- State UI per-sesi (A), binding approval dua lapis (B), fase stream daemon (C),
  konsumsi `task.status` di linear/ACP/TUI/normal (D), konsistensi memori dua
  arah (E), paritas CI/PTY + determinisme test abort (F). Ditambah subcommand
  `memory reconcile` sebagai jalur pemulihan nyata.

Sudah diuji (bukti otomatis):

- 5411 pass / 0 fail pada suite penuh; 124 test targeted lintas-area; 10 test
  konsistensi memori; 10 test integritas approval; 8 test fase daemon; 5 test
  isolasi instance; 3 test paritas CI.

Terbukti secara integrasi:

- Perubahan bertahan pada suite penuh dan pada dua eksekusi independen
  (gate test + gate coverage yang menjalankan ulang seluruh suite), termasuk
  interaksi lintas lapisan (kernel → policy → event → reducer → proyeksi → UI),
  tanpa menurunkan ambang coverage/pack dan tanpa melebarkan skip.

Belum diuji:

- PTY Linux/ConPTY CI di runner sebenarnya (hanya konfigurasi + jalur Windows
  lokal), `vendor:check` (butuh sibling), `gate:eval` (dataset eksternal).

Butuh keputusan pemilik:

- Emisi `task.status` per-transisi vs verify-settle, dan tampilan
  lease/incarnation/`executionOwner`.
- Apakah `gate:slow` (khususnya `extreme-shadow-git`) dijadikan gate wajib
  atau tetap stress opsional; kegagalannya perlu perbaikan kinerja snapshot
  atau penyesuaian skala harness.
- Apakah budget paket 3840 KiB dinaikkan (margin saat ini ≈ 1 KB) atau
  dokumentasi/kode dipadatkan lagi pada perubahan berikutnya.

Tidak ada klaim "repository hijau" di luar scope di atas: `gate:slow` merah,
tiga item terbuka, dan keterbatasan platform dinyatakan eksplisit.
