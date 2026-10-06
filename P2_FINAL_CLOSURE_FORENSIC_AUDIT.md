# P2 FINAL CLOSURE FORENSIC AUDIT

MiniCode — Big Roadmap Phase 2 (Session Architecture)
Auditor: independen, tidak pernah terlibat implementasi P2.
Tanggal audit: 6 Oktober 2026 · HEAD = `9b75c7c` (`feat(p2.12): daemon host + cross-process Desktop consumer substrate`) · Working tree: **bersih** (`git status --porcelain` = 0 baris; `vendor/` = kosong).

---

## 1. Executive conclusion

```text
P2 FINAL AUDIT: COMPLETE WITH QUALIFIED DEBT
```

MiniCode kini memiliki Session Architecture yang **koheren, tahan-crash, dapat dipulihkan, dan aman-otoritas**: satu identitas sesi kanonik, satu pagar penulis (`writer_epoch` CAS in-txn), satu pemilik skema (`open()` di `src/session/persistence.ts`), Run dengan state machine berpagar + first-terminal-wins, event identity dengan UNIQUE index dan pembedaan duplicate-vs-collision, proyeksi turunan yang tidak pernah otoritatif, ContextView RAM-only yang terbukti tidak bocor ke histori kanonik, Sub-Agent dengan identitas kanonik independen (Model C), bukti eksekusi intent→receipt→verification yang UNKNOWN-first, presentasi observation-only dengan provenance, dan daemon yang benar-benar host (bukan kebenaran kedua).

Tidak ditemukan: shadow authority yang reachable, jalur kebenaran ganda, jalur recovery yang memfabrikasi COMPLETED/sukses, atau penulis kedua yang lolos pagar.

Yang menahan verdict dari "COMPLETE" murni (tanpa menggugat arsitektur):
gates yang merah karena baseline/flake (`gate:coverage` menolak evaluasi, `gate:pack` 3960KB vs 2.25MiB), baseline `tsc` 28 error, keluarga flake session-identity, dependensi lingkungan pada test 6AB P3/P5, dan beberapa qualified debt terdokumentasi (late-verification trigger, approvals-snapshot). Tidak ada satupun yang menuntut pembukaan ulang P2. **P2 aman dibekukan; Phase 3 boleh mulai.**

## 2. Roadmap clarification

- Big Roadmap Phase 1–12 (Runtime Foundation … Desktop) adalah level luar. Saat ini Big Phase 1 (kernel/runtime P1 m1–m16, commit `e66d212`…`04134b9`) dan Big Phase 2 (Session Architecture) yang sudah mendarat.
- Sub-milestone internal P2.1–P2.12 ≠ Big Phase. Diverifikasi di kode: komentar header modul (`src/session/identity.ts` "P2.1", `src/session/authority.ts` "P2.2", `src/session/context-assembly.ts` "P2.8", `src/session/verification.ts` "P2.10"), guard `test/p2-architecture-guards.test.ts` (P2.1–P2.10), test `test/p2-presentation.test.ts` (P2.11), `test/p2-daemon-guards.test.ts` (P2.12), dan `docs/ARCHITECTURE.html` (tag P2.1/P2.2/P2.8/P2.10/P2.11/P2.12).
- **Konflik penomoran terdeteksi (dokumentasi saja):** `CHANGELOG.md` memakai label "P2.1 cwd jail" (0.8.0) dan "P2.1–P2.4" untuk memory/RAG (0.9.x) — kampanye berbeda yang meminjam prefiks yang sama. Tidak memengaruhi kode; terklasifikasi debt-F (dokumentasi).
- Big Phase 9–12 **tidak** dinyatakan selesai oleh infrastruktur P2: scheduler masih `--enable-scheduler` opt-in + default OFF (`cli/setup.ts:2080-2083`), TaskGraph/Scheduler dari Phase 6 lama tetap pada batasnya, Desktop UI interaktif tidak ada (hanya client library + CLI, P2.12 report §13).

## 3. Repository scope

- Source: `src/session/` (9 modul), `src/presentation/`, `src/daemon/` (16 modul, 3534 baris, satu commit `9b75c7c`), `src/tools/task.ts` (Sub-Agent), `src/tools/evidence.ts`, `src/mcp/server.ts`, `src/app/` (tool-layer, provider-layer), `src/task/` (store dengan `session_authority`), `cli/` (composition root `cli/setup.ts` 2200+ baris, `cli/commands/daemon.ts`).
- Persistence: `sessions.db` (sessions, messages, turns, threads, runs, history_projections, presentation_events, session_aliases, session_takeovers, consumer_offsets, daemon_approvals) + `tasks.db` (tasks, task_meta, session_authority).
- Tests: 294 file / 4327 test. Khusus P2: `p2-architecture-guards` (50), `p2-presentation` (48), `p2-daemon` (62), `p2-daemon-guards` (16), `p2-verification` (36), `p2-durability-forensic` (4 SIGKILL), `session-identity` (12), `session-epoch` (13), `p2-identity/thread/run-cursor/history-projection/lifecycle-workspace/migration/failure-injection/taskgraph-epoch/baseline-invariants` (kontrak P2.0–P2.9), journal×3 (59), concurrency×2.
- Laporan fase: `P2.11_IMPLEMENTATION_REPORT.md`, `P2.11_FINAL_CONTRACT_AUDIT.md`, `P2.12_IMPLEMENTATION_REPORT.md`, `P2.12_FINAL_CONTRACT_AUDIT.md`, + `docs/audit/` (Phase 6 lama). **Tidak ada** laporan berdiri untuk P2.1–P2.9 (lihat §5).

## 4. Evidence methodology

- Verifikasi langsung kode (path:line), guard test, dan test perilaku; bukan dari laporan.
- Full suite dijalankan ulang oleh auditor: `bun test` = **4295 pass / 23 skip / 9 fail / 4327 tests / 294 files** (1184.6s).
- Setiap kegagalan diklasifikasi ulang dengan rerun terisolasi berulang (bukan mewarisi label).
- `bun x tsc --noEmit`: 33 baris output / 28 error, seluruhnya di `test/phase3*/phase4*` yang tak tersentuh P2 — identik baseline P2.10–P2.12.
- Chronology diverifikasi via `git log -S` / `--diff-filter=A` / worktree checkout commit lama.
- Zero-mutation dijaga: tidak ada file repo yang diubah/dibuat di dalam repo; semua probe di `$TEMP`.

## 5. Kronologi implementasi (temuan forensik penting)

`git log -S` membuktikan: seluruh fondasi P2.1–P2.9 (`sessions.writer_epoch`, `session_takeovers`, `threads`, `runs`, `history_projections`, `session_aliases`, `src/session/identity.ts` (192 baris), `src/session/authority.ts` (168), `src/session/context-assembly.ts` (180), seluruh oracle test P2.0–P2.9) **mendarat sekaligus dalam satu commit `c0fa908 feat(p2.10)`** — tidak ada commit terpisah P2.1–P2.9, dan tidak ada laporan implementasi P2.1–P2.10 sebagai berkas (verdict P2.10 hanya di commit message). Laporan+audit berdiri baru ada untuk P2.11 dan P2.12.

Implikasi: klaim "P2.1–P2.9 ✅ per sub-fase" tidak punya jejak forensik per-fase; buktinya kini bersifat arsitektural (kode + guard yang mengunci tiap sub-fase, lihat §5.x di bawah). Ini **debt-F**: riwayat proses tipis, tetapi hasil akhirnya diverifiable dari tree. Semua audit per sub-fase di bawah tetap dilakukan terhadap kode aktual.

## 6. P2.1 — Canonical Identity — OBSERVED + TEST-PROVEN

- Satu-satunya generator/sanitizer: `src/session/identity.ts:64-76` (`mintSessionId`, `sanitizeSessionId` delegasi ke `sanitizeSessionPart`; komentar "drift 64-vs-60 adalah bug P2.1"). `bootId` volatil tidak pernah kunci persistensi.
- Resume tak dikenal = `SESSION_NOT_FOUND` eksplisit (identity.ts:23-32; test `cli-session.test.ts:602`, `cli-setup-coverage.test.ts:198`).
- Alias imutabel tanpa rantai/hijack: `SESSION_ALIAS_CONFLICT/HIJACK/DANGLING` (identity.ts:35-49); test `session-identity.test.ts:93-129`.
- Kolisi kunci menolak auto-merge: `SessionKeyCollisionError` (identity.ts:52-63); guard `p2-architecture-guards.test.ts:187-222` ("identitas ganda usang tak boleh kembali", "SATU sanitizer, SATU titik mint"); tabel `session_aliases` (persistence.ts:163).
- Jawaban: **ya, tepat satu model identitas kanonik.**

## 7. P2.2 — Writer Epoch — OBSERVED + TEST-PROVEN

- Lease (admission, `tasks.db::session_authority`, `src/task/store.ts:290`) dipisah dari pagar mutasi (`sessions.db::writer_epoch`, CAS di dalam txn) — `src/session/authority.ts:1-14` menolak transaksi lintas-berkas secara eksplisit.
- `assertWriterEpochInTxn` dipanggil di setiap jalur tulis: saveSession, createRun (:2413), transitionRun (:2490), appendPresentationEvents (:820), shrinkThreadHistory, tombstoneDeadRuns (:2677), tombstoneOrphanChildRuns (:1909), archiveThread, createThread, backfill. Guard `p2-architecture-guards.test.ts:258-266` ("baris sessions hanya ditulis persistence.ts") + `:267` ("pemanggil produksi saveSession/append wajib pagar") + `:244` ("nilai epoch tak pernah dari input pemanggil").
- Takeover: `takeoverSessionEpoch` (persistence.ts:1445) menulis `session_takeovers` satu baris per (sesi, prior_epoch) → takeover simultan tepat satu pemenang; admission `acquireSessionWriter` (authority.ts:83-118) membaca epoch SETELAH bump; token `cli:<bootId>:<pid>:<rand>` tidak pernah dicetak.
- Stale writer ditolak dengan `REFUSED_STALE_EPOCH` (persistence.ts:347-355) — riwayat TIDAK durable, exit jujur (`markWriterStale`, cli/setup.ts:665-676, tidak retry buta).
- Bypass: tidak ditemukan. Semua INSERT/UPDATE pada `sessions`/`messages`/`runs` lewat `open()` milik persistence.ts (guard memindai seluruh prod files).

## 8. P2.3 — Storage Skeleton — OBSERVED + TEST-PROVEN

- SQLite WAL, `synchronous=NORMAL`, `busy_timeout`, `journal_size_limit`, `wal_autocheckpoint` (persistence.ts:63-77 — WAL tidak tumbuh tak terbatas); retry sinkron untuk schema setup (ditemukan Phase 0, persistence.ts:37-59).
- Single schema owner: semua 11 tabel dideklarasikan di `open()` (persistence.ts:93-306); guard melarang INSERT dari file lain untuk threads/runs/history_projections (:105-138) dan melarang DDL tasks bocor (:168-172).
- Migrasi kolom via `PRAGMA table_info` idempoten (writer_epoch :177-180, event_id :188, UNIQUE event index :221-229, anchor_event_id :202-210, parent_session_id :121-127).
- Kompatibel dengan semua fitur P2 selanjutnya: terbukti oleh kenyataan bahwa P2.4–P2.12 dibangun di atasnya tanpa revisi skema frozen (guard "scope P2" :57-101).

## 9. P2.4 — Thread — OBSERVED (guard-enforced)

- Tabel `threads` (persistence.ts:271) dengan `head_seq` CHECK ≥ -1, `status active/archived`, `read_only`; `ensureDefaultThread` (:1957) + in-txn variant (:1690); `createThread` (:1976); `archiveThread` berpagar (:2070); head_seq = cache MAX(seq) (:1602, recompute :1026).
- Setiap INSERT messages membawa thread_id (guard :139-148); namespace seq per thread; tanpa lease Thread, tanpa fork, tanpa traversal (guard :150-166 — forkThread milik P3+; SQL UNION dilarang).
- Thread tidak pernah menjadi Run/Session state: Run punya tabel sendiri (§10); thread hanya namespace + cache. Catatan: aktifasi multi-thread runtime masih minim (default `th_default` dipakai produksi, `persistence.ts:1605`), fork ditunda P3 — sesuai kontrak internal P2.

## 10. P2.5 — Event Identity — OBSERVED + TEST-PROVEN

- `messages.event_id` + `UNIQUE(session_id, thread_id, event_id)` (persistence.ts:229); alokator `allocateHistoryEventId` (`evt_`), `allocateRunId` (`run_`), `allocateChildSessionId` (`sub_`) satu per jenis, guard :287-300.
- Duplicate vs collision: id sama + payload sama = idempoten; id sama + payload beda = `REFUSED_EVENT_ID_CONFLICT` — asli otoritatif (:1576-1600, :2153).
- `event_seq ≠ runtime truth` dan `event identity ≠ causal identity` ditegaskan: seq = ordering dalam thread, event_id = identitas stabil, keduanya tidak saling menurunkan (:1532-1541); backfill legacy deterministik `evt_migr_<digest>` idempoten (:2098-2120).
- Test oracle `p2-history-projection.test.ts:37-47` (duplikat/konflik/namespace thread) + guard produksi.

## 11. P2.6 — Run + Cursor — OBSERVED + TEST-PROVEN

- State machine `RUN_EDGES` + `RUN_TERMINAL` (persistence.ts:2261-2500): CREATED→RUNNING→{COMPLETED,INTERRUPTED,FAILED}; terminal→beda = `RUN_TERMINAL_CONFLICT` (**first-terminal-wins**, :2300-2306); terminal→non-terminal = tepi ilegal.
- **Single-running DB-enforced**: `udx_runs_single_running` partial unique index per session (:278) → `RUN_RUNNING_EXISTS` terstruktur (:2479, :2509).
- **`last_persisted_seq` = watermark, ≠ ownership**: `advanceRunCursorInTxn` (:2555-2615) menolak maju ke seq milik run lain (`RUN_CURSOR_FOREIGN`), mundur (`RUN_CURSOR_BACKWARD`), di luar head (`RUN_CURSOR_BEYOND_HEAD`), CAS `UPDATE … WHERE last_persisted_seq = ?`; proyeksi dilarang memakai run_id untuk validitas (:2687-2690).
- Kursor maju ATOMIK dengan histori dalam txn saveSession yang sama (:2241-2246, :1035-1047).
- Recovery: `tombstoneDeadRuns` (:2671-2687, RUNNING→INTERRUPTED/UNKNOWN saat admission membuktikan tak ada penulis hidup), `tombstoneOrphanChildRuns` (:1905-1938, termasuk CREATED), `terminalizeChildRuns` saat parent terminal — **tidak pernah COMPLETED**. Wired di `cli/setup.ts:674-696` (startup) dan `:2248-2268` (teardown).
- Run lifecycle wired produksi: createRun→RUNNING per turn (cli/setup.ts:1660-1670), terminalisasi dari outcome (:2248-2260).

## 12. P2.7 — Projection — OBSERVED (guard-enforced)

- `history_projections` (persistence.ts:279) satu jenis (`SUMMARY_PROJECTION_ID`, :2702-2704); `buildProjection` satu-t-satunya jalur tulis (:2955), di dalam persistence.ts, berpagar, dengan **validasi fail-closed**: jangkar `anchor_event_id` wajib ada, cakupan dengan event_id NULL ditolak `PROJECTION_INVALID` (:2930-2952).
- Proyeksi = turunan murni: "Proyeksi = representasi TURUNAN dari messages (read-only build, rebuildable, tak pernah otoritatif)" (:2686-2693); replay dari sumber selalu memulihkan semuanya (oracle `p2-history-projection.test.ts:99-108`).
- **Tidak ada prod writer proyeksi di luar persistence.ts** (guard :567; dan grep `buildProjection` hanya dipanggil test). Pembaca produksi tunggal: `context-assembly.ts` (P2.8).
- Riwayat menyusut dilarang lewat jalur implisit: `RefusedHistoryRewriteError` (:2717-2735); penggantinya `shrinkThreadHistory` eksplisit (berpagar, menolak run live `REFUSED_SHRINK_LIVE_RUN` :2730, provenance `migrated_compacted`, invalidasi proyeksi, satu txn); guard mengunci hilangnya pola DELETE+reinsert (test :81-121, tepat 4 bentuk DELETE sah).

## 13. P2.8 — Context Architecture — OBSERVED + TEST-PROVEN

- `src/session/context-assembly.ts`: "BACA SAJA. Nol tulis ke messages / history_projections / runs / sessions … tanpa state durable: ContextView hidup hanya di RAM" (:7-19). Hanya proyeksi **CURRENT** yang boleh dipakai; STALE/INCOMPLETE/CORRUPT/UNKNOWN/absen → fallback histori kanonik penuh (:10-15, :2858).
- **Synthetic context tidak bisa bocor ke kanonik**: artefak context-only difingerprint (`stripContextOnly`) dan `persistCurrent` di composition root membuang artefak dari depan buffer lalu menyusun ulang `baseline kanonik ++ ekor baru` sebelum save (cli/setup.ts:1952-1998) — bukan sekadar membuang (prefix-shift akan menghapus histori lewat jalur shrink). Guard `p2-architecture-guards.test.ts:423-484` ("artefak konteks tak boleh jadi histori kanonik") + `:486-510` (baca-saja, tanpa Run/budget) + `:558-563` (persistence tak mengimpor context-assembly).
- ContextView tidak bisa durable (tanpa serialisasi, tanpa persist); ContextStore vendor tetap murni buffer kernel; proyeksi tidak bisa jadi histori tanpa tanda (provenance `migrated_compacted` + `projection_note`).
- Test: `context-assembly.test.ts` 33 test (FOR-1/FOR-2 stripContextOnly, fallback, status).

## 14. P2.9 — Sub-Agent — OBSERVED + TEST-PROVEN

- Model C: anak = **Session + Thread + Run kanonik** dengan lineage durable `parent_session_id`/`parent_run_id` (src/tools/task.ts:283-330; persistence.ts:1743-1860). `createChildSession` idempoten-by-id, menolak kepemilikan ganda (:1804-1807), materialisasi baris parent bila perlu (menutup cacat phantom-namespace :1757-1760).
- Domain DB dipin (`resolveLocalDbPath`) SEBELUM satu baris pun ditulis; gagal pin = `REFUSED_CHILD_SESSION_PERSISTENCE`, tanpa degradasi ke DB global (task.ts:300-322; guard `p2-architecture-guards.test.ts:613-680` mengunci urutan pin→create→lease→RUNNING→EffectIntent dan melarang `process.cwd()` di blok).
- Writer isolation: epoch anak dibaca dari domain yang sama, lease anak dipegang terpisah (`acquireSessionWriter` child), dilepas hanya SETELAH Run anak diterminalisasi secara durable — "durable causality" (task.ts:527-550). Run anak: CREATED→RUNNING (P2.6), gagal/jatuh → INTERRUPTED+UNKNOWN, **tidak pernah COMPLETED diam-diam** (:532-545).
- Tool attenuation: anak selalu auto-mode tanpa ask/MCP/commit/memory/todo/nesting; parent plan/readonly dipaksa explore (docs/ARCHITECTURE.html:706).
- Bukti anak: EffectIntent durable wajib sebelum eksekusi (`REFUSED_VERIFICATION_EVIDENCE` task.ts:397); receipt dengan `childSessionId` (:570-590); korelasi efek anak di verification.ts (`correlateChildEffect`); presentation anak namespaced di child session (p2-presentation E1-E9; guard phantom-namespace purge persistence.ts:1757).
- `child execution ≠ parent execution` / `child context ≠ parent context`: anak ContextStore kosong sendiri (`task/autonomous-context.ts:357`), event forward ditandai `forwardedChild` agar jurnal parent tak mencatat ganda (task.ts:446-460).
- **Carry-over debt (jujur)**: (a) histori percakapan anak tetap di namespace anak sendiri — tidak ada jalur roll-up ke konteks parent (by design: "text/history tetap terisolasi", task.ts:452); roll-up/inspeksi histori anak adalah pekerjaan fase mendatang (D, bukan blocker — ground truth anak tetap durable dan terbaca). (b) instrumentasi delegasi parent tetap eksplisit di luar wrapper kanonik (test 21) — qualified.

## 15. P2.10 — Verification — OBSERVED + TEST-PROVEN

- Wrapper kanonik di tool layer: `withEvidence` (src/tools/evidence.ts) membungkus semua tool ter-cover; `executeCanonicalInvocation` (src/session/verification.ts:680-800): **durable EffectIntent WAJIB ada sebelum inner execute** (gagal tulis = `EvidenceIncompleteError`, refuse execute — bukan jalan terus), receipt setelah return/throw, tanpa fabrikasi terminal ("Receipt failure after an observed return preserves the tool outcome and leaves the intent pending/unknown").
- `intent ≠ effect`, `receipt ≠ proof`: terminal mencatat observed return + `ackAuthority: "application-observed"`; outcome punya `uncertainty`/`loss` (journal.ts:38-58). `UNKNOWN ≠ success`: pending tetap UNKNOWN; recovery `decideRecovery`/`planRecoveryForSession` menghasilkan directive verify-first, tanpa auto-redo (journal.ts:9-13).
- Idempotency session-scoped: kunci `buildIdempotencyKey(sessionId, …)`, in-flight dedup + cek pasca-restart → `IdempotentDuplicateError` tanpa eksekusi ulang buta (verification.ts:790-800); terminal `dedup:true` selamat dari sweep (journal.ts:796-804; reproducer audit #08).
- Crash windows diuji nyata: `p2-durability-forensic.test.ts` — 4 test SIGKILL proses anak SETELAH await selesai, lalu baca jurnal dari proses "restart": intent/receipt/verification selamat; ekor robek (torn tail) tak pernah jadi record. Test 27-30 (crash antara intent↔execute, setelah efek sebelum receipt, efek anak belum terobservasi) semuanya berakhir UNKNOWN, tidak pernah verified/completed.
- Verifikasi metode eksplisit: 6 metode enum + verdict present/absent/inconclusive (journal.ts:24-53); read-back filesystem/git nyata; prose model dan Run status TIDAK bisa membuat verification (test 13, 14, 15); evidenceReference tidak keluar journal (guard).
- Durability bukan klaim fsync kosong: jurnal append + `h.sync()` per baris (journal.ts:424-442) + test restart nyata (bukan mock). Batas diakui: SQLite `synchronous=NORMAL` = durability kuat untuk process crash, bukan jaminan power-loss penuh — terdokumentasi jujur (§20).

## 16. P2.11 — Presentation — OBSERVED + TEST-PROVEN

- `presentation_events` = observasi-only, satu penulis `appendPresentationEvents` (persistence.ts:805-860) dengan pembedaan **duplicate (idempoten) vs collision (tolak, jangan pernah overwrite)** (:832-850); filter `DURABILITY` — live-only types (model.delta dll) tak pernah durable (test G4, D4).
- Reducer satu untuk live & replay; state bounded (`trimState`, reducer.ts:291); rebuild deterministik dari baris durable (test D1-D3).
- **Provenance live/replay/reconstructed** via replay watershed (`cli/setup.ts:996-1016`, `projectProvenance`); reconstructed hanya dari rebuild inference/orphan; live bridge tidak pernah set provenance (p2-presentation B1-B6, D5; audit kontrak P2.11 "Can reconstructed state be mistaken for observed state? No, by construction plus tests").
- Verification display attach-only: `verification.observed` tidak pernah mengubah status/summary/turn (reducer); UNKNOWN tak pernah tampil sebagai sukses (3 lapis: mark kosong, gate renderer `verdict === "present"`, ACP omit key) (A1-A8, H1, F1-F6).
- Backpressure/kegagalan: persist gagal → throw keluar tanpa korupsi baris tersimpan (G1); renderer toleran payload rusak (G2); consumer disconnect aman (G3); out-of-order deterministik (G5); helpers sinkron non-blocking (G6).
- ACP/TUI/CLI hanya konsumen snapshot/event; guard melarang `src/ui` menulis kanonik dan melarang renderer mengimpor keputusan semantik.

## 17. P2.12 — Desktop / Long-running — OBSERVED + TEST-PROVEN

- Daemon = **host, bukan runtime kedua**: sesi yang di-host adalah objek sesi durable yang sama yang hidup di proses lain (`cli/commands/daemon.ts:218-249`); feed `hosted:false` sengaja no-op live agar tidak berpura-pura melihat sumber yang salah (`src/daemon/feed.ts:63-88`).
- **Guard struktural** (`p2-daemon-guards.test.ts` 16 guard): daemon TIDAK boleh `INSERT INTO presentation_events|messages|semantic_events` (tanpa sistem event kedua); tanpa impor NILAI presentasi (import type sah); tanpa `adopt(` (anak lintas generasi tak diadopsi); tanpa `run.execute/session.replay/run.resume` (tanpa auto-re-execute); PID/lease age bukan input keputusan discovery; tanpa kredensial/bootstrap di protocol.ts; `admin` bukan wildcard; offset konsumen monoton (ack mundur ditolak); antrean per koneksi bounded; urutan shutdown 7 langkah `mark-closing→halt-consumers→settle-approvals→stop-monitors→close-connections→retire-children→clear-discovery` dipatok per-posisi; semua 16 modul ada di `docs/ARCHITECTURE.html`; vendor bersih.
- Perilaku nyata di atas TCP loopback (`p2-daemon.test.ts` 62 test): framing 4-byte + MAX_FRAME 8MB + tolak frame raksasa; capability HMAC-SHA256 + timingSafeEqual, TTL, **incarnation basi = mati** (`STALE_INCARNATION`, capability.ts:112), cakupan tak dikenal dibuang, token dimanipulasi/payload disusupi ditolak; handshake `auth→frontiers→snapshot→cursor→replay→replay_done→tail_marker→LIVE`; snapshot SENGAJA non-atomik (kontrak: tidak menyajikan cursor beku sebagai point-in-time).
- Approval machine durable (`daemon_approvals`): `requested→pending→{accepted|denied|expired|cancelled}|UNKNOWN`; terminal tak reversibel (`canTransition` UNKNOWN→accepted = false); **restart saat pending → UNKNOWN, bukan denied** (`markPendingApprovalsUnknown`, host.ts:157); kegagalan tulis/expiry = deny eksplisit, bukan sukses karangan; UI mengusulkan, otoritas di jalur `approval.decide` scope-checked (`requiredScope("approval.decide") === "approve"`).
- Konsumen: offset di `consumer_offsets` (workspace-local via `openWorkspaceSessionDb`, yang **tidak bisa** jatuh ke global — bug nyata ditemukan dan diperbaiki); consumer ≠ writer (writer epoch tetap penentu); Desktop ≠ runtime authority (client library + CLI saja, tanpa layar UI).
- Storage pressure: `MIN_FREE_BYTES = 64MB` (resource.ts:19) edge-triggered → telemetry `storage.pressure`; telemetry counters tidak pernah dibaca sebagai otoritas.
- IPC trust boundary: loopback saja, endpoint file 0600 di dalam `.minicode/`, bootstrap trust root tidak pernah menyeberang soket, label/masukan disanitasi milik daemon sendiri (sanitize.ts) termasuk pesan refusal yang di-echo.

## 18. Cross-phase integration audit

Rantai `Identity → Writer Authority → Storage → Thread → Event Identity → Run → Projection → Context → Sub-Agent → Verification → Presentation → Daemon` dilacak per batas; untuk setiap batas: input, otoritas, yang persist, yang derived, kegagalan, dan yang selamat restart tercantum di §6-§17. Kepemilikan lintas batas kunci:

| Batas | Otoritas | Selamat restart |
|---|---|---|
| identity → lease | `resolveSessionIdentity` → `acquireSessionWriter` | ya (alias+row) |
| admission → mutasi | CAS epoch di dalam txn tulis | ya (epoch tak berubah saat save biasa) |
| histori → kursor Run | advance in-txn + ownership check | ya |
| histori → proyeksi | build fail-closed berjangkar event_id | rebuildable dari messages |
| histori → ContextView | read-only, RAM | tidak (by design; re-assemble saat resume) |
| efek → bukti | intent→receipt→verification di jurnal | ya (fsync + SIGKILL test) |
| bukti → display | attach-only, tanpa otoritas | ya (event durable + replay) |
| store → daemon | baca via schema owner; live hanya bila hosted | ya (offsets/approvals durable) |

Tidak ditemukan batas di mana konsumen bisa memutasi otoritas atau di mana derived state bisa jadi input keputusan runtime.

## 19. Full authority graph

| Entitas | Kanonik? | Durable? | Mutable oleh | Rebuildable | Otoritatif untuk |
|---|---|---|---|---|---|
| Session (row) | ya | ya (sessions.db) | writer via persistence.ts | tidak | identitas sesi |
| session_alias | ya | ya | writer | tidak | resolusi nama |
| writer_epoch | ya | ya | takeover/cabang SAJA | tidak | keabsahan tulisan |
| session_takeovers | ya | ya | takeover | tidak | riwayat takeover |
| Thread | ya | ya | writer | tidak | namespace histori |
| messages | **ya (kanonik histori)** | ya | saveSession/append (+shrink eksplisit) | tidak | percakapan |
| turns | ya | ya | saveSession | tidak | usage per turn |
| runs | ya | ya | createRun/transitionRun | tidak | lifecycle eksekusi |
| runs.last_persisted_seq | ya | ya | advance (ownership-checked) | tidak | watermark durability |
| journal (file JSONL) | ya (bukti) | ya (fsync) | writer per sesi (file-lock) | tidak | status komitmen mutasi |
| EffectIntent/Receipt | ya | ya (journal) | wrapper kanonik | tidak | bukti intent/terminal |
| VerificationRecord | ya | ya (journal) | verifikator eksplisit | tidak | observasi efek |
| history_projections | tidak (derived) | ya (cache) | buildProjection | **ya dari messages** | tidak apa-apa (context-only) |
| ContextView | tidak | tidak (RAM) | — | ya | tidak |
| presentation_events | tidak (observasi) | ya | appendPresentationEvents | tidak (tak perlu) | tidak |
| PresentationState | tidak | tidak (RAM, replayable) | reducer | ya | tidak |
| consumer_offsets | tidak | ya | daemon (monoton) | tidak | posisi resume konsumen |
| daemon_approvals | ya (mesin keputusan) | ya | broker scope-checked | tidak | keputusan approval |
| daemon/supervisor | tidak | endpoint file 0600 | host | — | process/lifetime SAJA |
| CLI/TUI/ACP/Desktop | tidak | tidak | — | — | tidak |
| telemetry | tidak | tidak | counters | — | tidak |
| child Session/Run | ya (independen) | ya | writer anak | tidak | eksekusi anak |

**Jawaban: ya — tepat satu otoritas per kategori kebenaran.** Satu-satunya tulis ganda yang berpotensi (checkpoint shadow-git vs SQLite) sudah dipisah domainnya (checkpoint = file workspace, jurnal = status komitmen; reconcileUndoRedoPointer metadata-only). Tidak ditemukan shadow-authority reachable.

## 20. Canonical data flow

`canonical runtime truth (messages/journal/runs) → derived (proyeksi, PresentationState, snapshot) → consumers (TUI/ACP/daemon consumer/Desktop)` — diverifikasi NONE dari daftar prompt menjadi kebenaran kanonik: PresentationState (replayable, bukan otoritas), ContextView (RAM), TUI/ACP state, consumer cursor (posisi baca), telemetry (counters, dikecualikan dari semua decision file oleh guard), supervisor state, snapshot (non-atomik, dilarang disimpulkan sebagai state), daemon. Guard+test mematok arah ini (§16-§17).

## 21. Durability audit (integrated)

Rantai `tool invocation → intent → execution → receipt → verification → run terminal → messages/history → presentation observation → restart → recovery`:

- **Guaranteed (process crash)**: intent/receipt/verification (fsync + SIGKILL test); messages (WAL + txn atomik histori+kursor); run status/kursor (txn sama); epoch/takeover (CAS); approvals/offsets (SQLite).
- **Guaranteed dengan kualifikasi**: presentation events (durable tapi observasi-only; flush best-effort berpagar — StaleWriter → markWriterStale, tak retry buta); checkpoint (metadata + shadow-git refs, reconcile pointer saat start).
- **Best-effort / reconstructable**: ContextView (re-assemble), PresentationState (rebuild dari durable rows), snapshot daemon (replay dari store).
- **Lossy-by-design**: delta live-only (model.delta) — tak pernah durable (kontrak D4/G4).
- **Batas diakui**: `synchronous=NORMAL` — kuat untuk process crash (didukung bukti restart nyata), klaim power-loss/lying-storage penuh TIDAK dibuat dan TIDAK diuji; jurnal fail-open degraded-loud (gagal append tidak menggagalkan turn, tapi menandai sesi degraded dan recovery memperlakukannya advisory — pilihan paling aman yang tersedia, dijelaskan journal.ts:15-19).

## 22. Recovery audit

Pipeline startup (cli/setup.ts:660-990): admission → tombstoneDeadRuns (RUNNING yatim → INTERRUPTED/UNKNOWN) → tombstoneOrphanChildRuns → lease heartbeat → ensureDefaultThread + backfill event_id → loadSession → assembleContext (CURRENT-only) → recovery plan dari jurnal (`planRecoveryForSession`; pending = ambigu → SYSTEM appendix "verify before re-executing") → presentation rebuild + watershed → reconcileUndoRedoPointer (metadata-only).

**Tidak ada jalur yang memfabrikasi completion / resume kerja tak aman / double-execute / adopt orphan / accept stale control**: auto-redo dilarang (journal.ts:12-13), UNKNOWN-first di semua mesin status (Run, approval, journal), orphan child selalu INTERRUPTED+UNKNOWN, stale writer/consumer fail-closed dengan kode eksplisit. Satu-satunya "kegagalan" yang dibiarkan adalah lease yang tertinggal saat compose gagal setelah admission (teramati di probe test 6AB) — ditutup oleh TTL lease + takeover berpagar; qualified, bukan blocker.

## 23. Concurrency audit

- Dua penulis: ditolak lease (`REFUSED_LEASE_HELD`) + epoch CAS di txn (double fence; TOCTOU lintas-berkas ditutup dengan CAS in-txn — authority.ts:5-8).
- Takeover simultan: satu pemenang per (sesi, prior_epoch) (session_takeovers PK); diuji deterministik dengan waktu disuntik (session-epoch.test.ts).
- Two-process nyata: `concurrency-cross-process.test.ts` (spawn proses bun kedua: seq jurnal berlanjut, baris JSON utuh, config selalu parse, sesi beda utuh, baca sama identik); `p2-failure-injection.test.ts:37` (A jeda → B takeover → A commit `REFUSED_STALE_EPOCH`).
- Same-process: 100 intent konkuren seq unik, pasangan intent+terminal benar, file-lock serial, undo/redo race tepat satu pemenang.
- Run: single-running DB-enforced; double terminalization = first-wins; cursor race = CAS + ownership.
- Presentation: duplicate/collision konkuren tanpa overwrite (C1-C5, "collision never overwrites across retransmission storms").
- Tidak ditemukan: lost update pada jalur berpagar, split brain (lease+epoch ganda), cursor regression, stale state acceptance.

## 24. Security audit

- Isolasi sesi/anak/konsumen: namespace (session_id, thread_id) + child namespacing + offset per consumer; cross-session command ditolak (run ownership check advanceRunCursorInTxn; createChildSession ownership).
- Stale actor: token/epoch/incarnation lama ditolak (`REFUSED_STALE_EPOCH`, `STALE_INCARNATION`, capability expired); replayed command dengan payload beda = `IDEMPOTENT_REPLAY`; duplicate = replayed outcome; approval UNKNOWN terminal.
- IPC: loopback, framing bounded, scope minimum eksplisit untuk 8 op (guard), tanpa kredensial di kontrak (guard), endpoint 0600, sanitasi label di entry (daemon sanitize.ts sendiri — konsekuensi aturan `src/ui` tak boleh diimpor dari `src/`).
- Redaction: `scrubSecrets` di jurnal dan ringkasan; evidenceReference tak keluar journal (guard); terminal sanitization milik renderer (di luar scope P2, kontrak FROZEN).
- Tidak ditemukan jalur old-token/old-epoch/old-cursor/old-approval/old-child-id yang masih bermutasi.

## 25. Resource / retention audit

- Terbatas eksplisit: WAL (`journal_size_limit`+autocheckpoint), antrean daemon (512/conn, tolak tanpa buang diam-diam), frame 8MB, snapshot 400 event / replay page 200, checkpoint manifest maks 20, storage monitor 64MB free, pending tool ids tervalidasi.
- Terikat sesi + TTL: presentation_events/messages/journal dihapus lewat `deleteSessionCompletely`/`purgeExpired` (TTL default 30 hari, satu arsitektur penghapusan, tasks-first, cascade anak + yatim alias/takeover/proyeksi/presentasi — persistence.ts:1092-1160, 3209+); jurnal yatim punya TTL tersendiri (`findOrphanJournals`, unreadable = jangan sentuh); verification record bertahan sepanjang umur file sesi (bounded by per-session files + orphan TTL — journal.ts:798-810).
- Tumbuh tanpa batas per sesi (messages, presentation_events, verification records) — **eksplisit dan kebijakan, bukan kebocoran**: ditutup oleh TTL sesi dan penghapusan; aman untuk penutupan P2, pencatatan sebagai batas yang diketahui.
- Timer: lease heartbeat unref + dibersihkan; writer inventory guard mencegah penulis stdout liar bertambah.

## 26. Cross-phase invariant matrix

| Invariant | Diperkenalkan | Dipakai oleh | Dijaga oleh | Status |
|---|---|---|---|---|
| Session ≠ Thread ≠ Run | P2.3/P2.4/P2.6 | semua | skema PK + guard :105-138 | ✅ |
| writer epoch = mutation fence | P2.2 | semua penulis | assertWriterEpochInTxn + guard :258-267 | ✅ |
| last_persisted_seq ≠ ownership | P2.6 | P2.7, daemon | advance ownership-checked; proyeksi dilarang pakai run_id | ✅ |
| messages = canonical history | P2.0 (baseline) | P2.7/P2.8 | single-writer + append-only + guard DELETE :81-121 | ✅ |
| journal = intent/terminal evidence | pra-P2 (P0) | P2.10 | satu semantik mutasi, sweep | ✅ |
| VerificationRecord = effect authority | P2.10 | P2.11, MCP | guard :730-798 | ✅ |
| presentation_events = observation-only | P2.11 | daemon, UI | attach-only + guard daemon INSERT | ✅ |
| ContextView = ephemeral | P2.8 | composition root | guard :423-510, :558 | ✅ |
| history_projections = context-only | P2.7 | P2.8 | guard :567; prod reader tunggal | ✅ |
| child Session = independent execution | P2.9 | runtime P1, presentation | guard :613-680, Model C | ✅ |
| UNKNOWN = first-class | P2.6/P2.10/P2.12 | recovery, approvals, journal | state machines + test | ✅ |
| receipt ≠ proof | P2.10 | display, recovery | ack application-observed; test 6/13-15 | ✅ |
| reconstructed ≠ observed | P2.11 | renderer, ACP | provenance watershed B3-B6/D5 | ✅ |
| consumer ≠ writer; cursor ≠ ownership | P2.12 | Desktop | guard INSERT + monotonic offsets | ✅ |
| daemon ≠ canonical truth | P2.12 | Desktop | baca via schema owner; guard no-second-event | ✅ |
| approval UI ≠ authority | P2.12 | Desktop/CLI | scope-checked decide; UNKNOWN terminal | ✅ |
| no second canonical event system | P2.11/P2.12 | semua | guard scan | ✅ |
| vendor untouched | P2.0 | semua | `git status vendor/` kosong + guard spawnSync | ✅ |

Invariants berlaku simultan (matriks diuji satu file guard + dipelihara lintas commit P2.10→P2.12 tanpa dilonggarkan).

## 27. Architectural debt classification

- **A (blocker): tidak ada.**
- **B (qualified, tidak blokir):**
  - B1. Late verification lintas-turn: emisi ulang otomatis belum ada (jurnal tetap source of truth; refresh path mekanisme ada, trigger future work — P2.11 report §12; wiring `turn:completed` sweep menutup kasus dalam turn, cli/setup.ts:1585-1592).
  - B2. Approval entries tidak masuk snapshot (P2.11 report §12).
  - B3. Coverage/pack gates merah di atas baseline/flake yang sama (sejak P2.10); pack 3960KB vs 2.25MiB (docs-dominated, +136KB daemon) — E juga.
  - B4. Keluarga flake session-identity (5-6 test) merah di full suite, hijau terisolasi ×3 (dibuktikan §28) — perlu perbaikan akar (urutan/temp DB) suatu saat, tapi bukan kontradiksi arsitektur.
- **C (intentional limitation):** snapshot daemon non-atomik; ambiguous parallel children = orphan by design; `unknown` provenance terdefinisi tak pernah terbit (absence covers it); histori anak tak di-roll-up ke parent context; compose-gagal setelah admission meninggalkan lease sampai TTL.
- **D (future Big Phase):** failure-injection hook produksi `MINICODE_FAIL_AT` (P2.13/P2.14 — test menyatakan eksplisit); fork/traversal thread (P3+); Desktop UI interaktif (Big Phase 12); scheduler default-on (Stage D, NO_GO).
- **E (test/environment):** 6AB P3/P5 bergantung provider global/env untuk compose anak (dibuktikan child pra-P2 juga gagal identik — bukan regresi); tsc 28-error baseline di test/phase3*/4*; keluarga flake (juga B4).
- **F (docs/process):** konflik label "P2.x" antara kampanye (CHANGELOG memory RAG vs Session Architecture); tidak ada laporan/commit terpisah P2.1-P2.9 (seluruh fondasi mendarat di commit p2.10); direktori sisa tak-terlacak (`.tmp-extreme-*`, `nonexistent-dir-xyz` berisi DB live) — housekeeping workspace, diabaikan git, bukan jalur arsitektur.

## 28. Regression classification (full suite 9 fail, diklasifikasi ulang independen)

| # | Test | Klasifikasi | Bukti |
|---|---|---|---|
| 1 | `P3: konstruktor authority runtime hanya di src/runtime` (m15) | PRE-EXISTING BASELINE | offender `src/runtime/dispatch.ts:35` sejak `57b1ca7` (p1-m13); test dibuat `04134b9`; **berjalan di worktree 04134b9: fail identik** |
| 2 | `web ssg > docs tanpa nested list` | PRE-EXISTING BASELINE | offender `docs/TASK_EVENT_MODEL.md:58/62/143` (commit `aa76dfb` 2026-09-26, ancestor c0fa908) |
| 3 | `MCP: one context is stable across requests` (phase4b-isolation-lifecycle) | PROVEN FLAKE (load) | isolated 2×: 8/8 pass; hanya gagal di full suite |
| 4 | `6AB S19 P3 second process excluded by lease` | ENVIRONMENTAL | isolated rerun: "first child never armed" (60s); akar: anak tanpa `withProvider` → compose `no provider configured` (exit 4); **child versi pra-P2 (61a28e7) gagal identik**; dulu lulus karena env operator punya provider global |
| 5 | `6AB S19 P5 restarted process cannot continue` | ENVIRONMENTAL | sama dengan #4 (probe manual: putaran 2 justru membuktikan lease berfungsi — `REFUSED_LEASE_HELD`); tidak gagal di full-suite run ini |
| 6 | `audit: manifes korup dibackup…` | PROVEN FLAKE | isolated: 9/9 pass (×2) |
| 7-8 | `P2.2: komposisi`, `P2.2: alias memakai pagar` | PROVEN FLAKE | `session-epoch.test.ts` isolated: 13/13 (×3) |
| 9 | `P2.1: single-write`, `P2.1: semua path turunan` | PROVEN FLAKE | `session-identity.test.ts` isolated: 12/12 (×3) |
| — | gates | B3/E | `gate:coverage` menolak evaluasi (7 fail di run-nya); `gate:pack` 2 kegagalan pre-existing (graf import extensionless `src/task/graph.ts`; 3960KB vs 2.25MiB) |

**NEW REGRESSION: 0.** Tidak ada kegagalan yang berasal dari file P2.10-12. Klaim flake tidak diwarisi — masing-masing dibuktikan dengan rerun.

## 29. Coverage vs architecture (test gap assessment)

Sangat kuat: happy/negative/crash/restart/recovery/race/cross-process/stale/UNKNOWN/orphan/duplicate/collision/retention semuanya punya test langsung (lihat §6-§25). Celah yang diakui: (a) power-loss/lying-storage tidak diuji (klaim durability sengaja dibatasi); (b) MINICODE_FAIL_AT hooks nyata belum ada (scaffold 11 titik injeksi sebagai kontrak); (c) multi-thread runtime nyata (bukan default thread) belum punya jalur produksi — kontraknya saja yang dikunci; (d) kombinasi konkuren approval+writer takeover lintas proses diuji per-mekanisme, bukan satu skenario gabungan panjang. Semua gap di atas terdokumentasi atau bertipe kontrak-future; tidak meniadakan invarian yang diklaim.

## 30. Vendor / boundary audit

- `git status --porcelain -- vendor/` = kosong; guard `p2-daemon-guards.test.ts` menjalankan git status saat test; guard vendor-seam (authority minimal di `vendor/minicore/src/core/session.ts` tanpa bun:sqlite/session_authority).
- Batas lapisan: `src/ui` tidak mengimpor keluar dirinya / `#minicore` (ui-boundary.test.ts); `src/` non-ui tidak mengimpor `src/ui` (daemon punya sanitizer sendiri — dokumentasi menyatakan alasannya); `src/daemon` tidak mengimpor `cli/` maupun nilai presentation; composition root tetap di `cli/` (setup.ts, commands/daemon.ts) dengan DI (`setSubAgentSessionFactory` cli/index.ts:139, `ask`/`setupWhenEmpty` di-inject, tanpa injeksi default deny).

## 31. Migration / residue audit

- Jalur lama yang diuji HILANG dan dipatok guard: dual-ID identity (P2.1 guard), DELETE+rewrite implisit saveSession (tepat-4-DELETE guard), dual-write persistCurrent (P2.1), `exec_<n>` prefix, field korelasi jurnal deprecated, ACP legacy `type:"tool"` (satu jendela kompat terdokumentasi).
- Tak ditemukan jalur konflik reachable: tidak ada dual writer, shadow persistence, event bus lama di jalur TUI (raw ledger dihapus di Output Phase 8), deprecated cursor semantics, phantom child paths (diburu dan ditutup via createChildSession materialisasi).
- Residue fisik: `.tmp-extreme-*` (workspace experiment), `nonexistent-dir-xyz/.minicode` (DB hasil run live `--cwd`), `.tmp-phase1-test/` — semua tak-terlacak/diabaikan git, bukan bagian arsitektur; sarankan housekeeping.

## 32. Architectural completeness (jawaban per pertanyaan §23 prompt)

Identity singular & collision-safe ✅ · Setiap mutable truth satu otoritas ✅ · Required truth durable ✅ (dengan batas power-loss diakui) · Recovery tanpa fabrikasi ✅ · Writer/execution races fenced ✅ · Context tidak bocor ke kanonik ✅ (strip + rebuild + guard) · Child executions isolated ✅ · Effects dapat uncertain dengan aman ✅ (UNKNOWN-first + verify-first) · UI gagal tanpa korupsi runtime ✅ (fail-open observasi, G1-G6) · Consumer disconnect tanpa ownership ✅ · Future consumers tanpa jadi otoritas ✅ · Stale actors tidak bisa mutasi ✅ · Unbounded areas eksplisit + terkecuali kebijakan ✅.

## 33. Phase 2 exit criteria (22 butir prompt)

1-11 ✅ (bukti §6-§17). 12 UNKNOWN first-class ✅. 13 presentation derived/observation-only ✅. 14 consumers bukan owner ✅. 15 long-running ownership eksplisit ✅. 16 recovery tidak fabrikasi sukses ✅. 17 stale writers/consumers fail-closed ✅. 18 duplicate vs collision terbedakan ✅ (messages, presentation, idempotency, control API). 19 tanpa sistem event kanonik kedua ✅. 20 vendor untouched ✅. 21 invariants simultan ✅. 22 debt terklasifikasi ✅ (§27).

## 34. Final integrated architecture diagram

```text
                         PHASE 2 — SESSION ARCHITECTURE

                              Session (sessions.db, canonical sid)
                                 │
                 ┌───────────────┴────────────────┐
               Thread (th_*, head_seq)          Run (run_*, state machine,
                 │                                first-terminal-wins,
             messages (kanonik, event_id           single-running, cursor)
             UNIQUE(session,thread,event))          │
                 │                        EffectIntent → Receipt →
                 │                        VerificationRecord (journal,
                 │                        fsync, UNKNOWN-first)
                 │                                │
           history_projections (summary,          │
           anchor fail-closed, context-only)      │
                 │                                │
            ContextView (RAM, read-only)          │
                 │                                │
           Agent / execution (tool wrapper)       │
                 │                                │
           Child Session (Model C: Session+Thread+Run, epoch sendiri)──┘
                 │
           Presentation Layer (presentation_events observasi-only,
           reducer bounded, provenance live/replay/reconstructed)
                 │
        ┌────────┼──────────┐
      CLI       TUI        ACP ── Desktop (daemon client)
                             │
                        Daemon (host: 7-step shutdown, capability+incarnation,
                        bounded queue, consumer offsets, durable approvals)

        writer_epoch / lease / incarnation
                        │
            MUTATION AUTHORITY FENCE (CAS in-txn)

        Daemon / Supervisor = process + lifetime + supervision
                             ≠ canonical truth
        Semua penulisan kanonik hanya lewat persistence.ts (+ epoch fence);
        semua konsumen membaca; UNKNOWN tidak pernah menjadi COMPLETED/sukses.
```

## 35. Phase 3 handoff contract

**Phase 3 (Context ↔ Session Reconciliation) BOLEH mengasumsikan:** identitas kanonik tunggal + alias imutabel; pagar epoch bekerja dan diuji; histori append-only dengan event_id stabil dan UNIQUE per (session, thread); proyeksi summary berjangkar `anchor_event_id` dengan validasi fail-closed; ContextView read-only dengan fallback aman; recovery UNKNOWN-first; bukti jurnal fsync-durable; presentasi replayable; daemon substrate siap dikonsumsi.

**Phase 3 TIDAK BOLEH mengubah:** `vendor/minicore/**` (kecuali seam aditif eksplisit); single schema owner (`open()` di persistence.ts); semantik `writer_epoch` (hanya takeover/cabang memajukan); first-terminal-wins dan `RUN_EDGES`; append-only messages + jalur shrink eksplisit; identitas presentasi `(session_id, event_seq)`; UNKNOWN-first di semua mesin status; guard tests (yang benar adalah mengubah kode, bukan menurunkan guard); satu arsitektur penghapusan (deleteSessionCompletely).

**Invariant yang diwarisi:** seluruh matriks §26.

**Debt yang harus dihormati:** B1 (late-verification trigger — jurnal tetap sumber kebenaran sampai refresh path dibangun), B2 (approvals absent from snapshot), B3/E (gates & flake family — jangan jadikan alasan menurunkan minimum tanpa bukti), C (non-atomic snapshot contract; orphan rule parallel children), D (fork/traversal adalah wilayah P3 — dipersilakan dibangun DI ATAS Thread, tanpa lease Thread terpisah).

**Yang sengaja ditunda:** hook `MINICODE_FAIL_AT` (P2.13/P2.14), Desktop UI interaktif (Big Phase 12), multi-thread aktivasi penuh, roll-up konteks anak.

**P2 complete ≠ P2 perfect:** yang dituntut adalah *architecturally safe and frozen* — dan itu tercapai.

## 36. Final verdict

```text
P2 FINAL AUDIT: COMPLETE WITH QUALIFIED DEBT
```

Semua invarian kritis terbukti dari implementasi (bukan dari laporan), tidak ada kontradiksi arsitektur yang tak terselesaikan, tidak ada shadow authority reachable, seluruh kegagalan sisa terklasifikasi independen sebagai baseline/flake/environmental (0 new regression), dan seluruh debt terdaftar dengan klasifikasi. **Phase 3 boleh dimulai tanpa membuka kembali kontrak P2.**
