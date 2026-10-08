# P3_0_CONTEXT_SESSION_CONTRACT.md

**Fase:** P3.0 — Context ↔ Session Authority & Contract Reconciliation
**Status:** DRAFT UNTUK FREEZE (lihat §19 + verdict di akhir)
**Basis bukti:** HEAD `e284298` (`main`), `P3_FORENSIC_AUDIT_REPORT.md`, `P2_CLOSURE_HANDOFF.md`, `P2_FINAL_CLOSURE_FORENSIC_AUDIT.md`, kode + test aktual di repo.
**Aturan fase ini:** tidak ada perubahan kode produksi, skema, migrasi, refactor, atau fitur. Dokumen ini menetapkan **kontrak**, bukan implementasi.

Catatan konvensi istilah (dipakai ketat di seluruh dokumen):

- **Canonical Session State** = baris `sessions/threads/messages/runs` (satu penulis: `src/session/persistence.ts`).
- **Projection** = `history_projections` (turunan/derivatif; **bukan** `src/presentation/projection.ts` yang merupakan proyeksi tampilan).
- **Runtime Context** = `ContextStore` vendor di dalam proses (buffer RAM).
- **ContextView** = nilai RAM hasil `assembleContext()`.
- **Model-visible Context** = yang benar-benar dikirim provider (`buildRequest`).
- **Fold** = tindakan meringkas prefix pesan menjadi satu ringkasan (hasil kompaksi).

---

## 1. Scope

**Dalam scope P3.0:** relasi otoritas antara Canonical Session State → Context Projection → Runtime Context → Model-visible Context; kontrak rekonsiliasi sebelum persistensi; identitas & kesegaran konteks; pemetaan history→context; semantik proyeksi; semantik kompaksi; semantik resume/recovery; batas konteks anak; batas memori/RAG; kontrak model-visible context; semantik kegagalan/UNKNOWN; implikasi keamanan–kapabilitas.

**Di luar scope (dinyatakan tegas):** paging/lazy loading, traversal branch/fork, produsen proyeksi baru, redesign kompaksi, pewarisan konteks anak penuh, orkestrasi multi-agen (P9), perubahan `vendor/minicore/**`, perubahan skema/migrasi, apa pun yang bersifat implementasi.

**Prinsip yang mengikat seluruh dokumen:** *Derived state may observe authority. Derived state must not silently become authority.*

---

## 2. Ownership Map

Klasifikasi tier: **AUTHORITATIVE** · **DERIVED** · **CACHE** · **EXECUTION-LOCAL** · **EVIDENCE** · **PRESENTATION**.
(Kolom "Bukti" = situs kode yang menentukan klasifikasi, bukan asumsi.)

| Objek | Tier | Pemilik tunggal | Bukti | Catatan kontraktual |
| --- | --- | --- | --- | --- |
| Canonical session state (`sessions`) | AUTHORITATIVE | `persistence.ts` (satu pemilik skema, `open()`) | `persistence.ts:904` `saveSession` upsert mempertahankan `writer_epoch`; guard `p2-architecture-guards.test.ts:258` | `system` kolom durable **tidak dipakai** saat resume (lihat §12) |
| Thread (`threads`) | AUTHORITATIVE untuk identitas/lineage; **CACHE** untuk `head_seq` | `persistence.ts` | `createThread:1976` (`parent_thread_id`,`fork_event_seq`); `head_seq` dihitung ulang `recomputeThreadHeadInTxn` | `head_seq` = cache posisi, bukan identitas |
| Run (`runs`) | AUTHORITATIVE untuk siklus hidup eksekusi; **bukan** input konteks | `persistence.ts` | `transitionRun:2480`, `advanceRunCursor` menolak rewind `:2593`; `context-assembly.ts:13` eksplisit tak membaca run | `last_persisted_seq` = watermark, bukan kepemilikan |
| History (`messages`) | AUTHORITATIVE | `persistence.ts` | append-only `saveSession`; `DELETE FROM messages` hanya di `shrinkThreadHistory:3092` & `deleteSessionCompletely:3209`; grep `FROM messages` hanya `persistence.ts` | event_id stabil; `seq` posisional |
| Projection (`history_projections`) | **CACHE** (derivatif) | `persistence.ts` (`buildProjection:2971`) | status 9-aturan `getProjectionStatus:2838`; guard `p2-architecture-guards.test.ts:567`,`:1000` | tanpa pemanggil produksi hari ini (§7) |
| ContextView | DERIVED + EXECUTION-LOCAL | composition root (`cli/setup.ts:904`) | `context-assembly.ts:39` ("tak pernah diserialisasi"); guard `:1010` | ephemeral, RAM-only |
| Runtime Context (`ContextStore`) | **EXECUTION-LOCAL** (membawa EVIDENCE belum-durable) | kernel `loop.ts` | `session.ts:165` seed; `loop.ts:261` `buildRequest`; `loop.ts:342` `compactStore` | **tidak otoritatif atas isi kanonik** (§3) |
| Model-visible context | DERIVED | kernel (`buildRequest`) | `loop.ts:261-270` | wajib dapat direkonstruksi (§12) |
| Ringkasan kompaksi (teks) | DERIVED | `src/policy/compaction.ts` | `compaction.ts:225 compactWithLlm`; header ringkasan `:157` | tidak boleh menjadi AUTHORITY (§8) |
| Artefak kompaksi (fold) | DERIVED + (bila destruktif) EVIDENCE arsip | composition root + persistence | `shrinkThreadHistory:3037` (destruktif, `migrated_compacted=1`) | bentuk saat ini **non-conforming** (§8) |
| Memori/RAG (`memory` table + `MEMORY.md`) | DERIVED (unverified), model-influenced | `src/memory/vector.ts` | `addMemory:338` (tanpa provenance sesi/event); `searchHybrid` menulis `access_count:706` | diinjeksi sebagai DATA tak-terpercaya (§11) |
| Child context | EXECUTION-LOCAL pada domain anak; baris anak AUTHORITATIVE di domainnya | `tools/task.ts` + `persistence.ts` | `createChildSession:1765`; tanpa `initialMessages` (`tools/task.ts:407-460`) | tidak ada roll-up (§10) |
| Branch context | **FUTURE** (belum ada) | — | `createThread`/`branchSession` tanpa pemanggil produksi; guard `:150` menahan fork/traversal | identitas kontrak sudah dicadangkan (§4) |
| Journal | EVIDENCE | `src/session/journal.ts` | `appendMutationIntent:502`, `appendVerificationRecord:623`, `decideRecovery:1066` | bukan status; UNKNOWN-first |
| VerificationRecord | EVIDENCE (otoritas atas klaim efek, bukan atas history) | `src/session/verification.ts` | `persistEffectIntent:220`, `persistEffectReceipt:437`; guard `:730`,`:765` | tidak pernah masuk konteks (guard `:730`) |
| PresentationState + `presentation_events` | PRESENTATION | `src/presentation/*` | identitas `PRIMARY KEY(session_id, event_seq)` (`persistence.ts:96-103`); guard `:915`,`:1119` | observasi; tidak boleh jadi konteks |
| `consumer_offsets` | PRESENTATION | `src/daemon/*` | konsumen ≠ penulis (handoff P2) | posisi baca, bukan otoritas |
| `turns` (`session_id`,`turn_idx`,`usage`,`ts`) | AUTHORITATIVE (biaya/turn) | `persistence.ts` | `CREATE TABLE turns` `:95` | **tidak ada pemetaan turn→message** → batas turn tidak dapat direkonstruksi (§6) |
| Checkpoint/shadow-git | EVIDENCE (domain berkas) | `src/session/checkpoint.ts` | `/undo` mengembalikan berkas tanpa menyentuh DB (`p2-baseline-invariants` test) | domain berbeda dari history pesan |
| Capability grants/approvals | AUTHORITATIVE (domain izin) | `src/runtime/capability.ts` + `src/daemon/approvals.ts` | `isCapabilitySubset:188`, `approvalCovers:276` | konteks **bukan** kanal kapabilitas (§15) |

**Tidak ada shadow authority yang sah.** Satu shadow authority de-facto ditemukan audit (buffer runtime → isi kanonik) dan dinyatakan **DIHAPUS oleh kontrak ini** (§3).

---

## 3. Context Authority Rule (jawaban normatif)

**Pertanyaan:** bolehkah Runtime Context (`ContextStore`) menjadi otoritatif?

**Jawaban kontrak: TIDAK — tidak pernah atas isi kanonik.**

Evaluasi terhadap invariant yang diajukan:

```text
Runtime Context is derived execution state.
Canonical Session State remains authoritative.
```

**Hasil: ACCEPT, dengan dua amandemen yang membuatnya dapat ditegakkan:**

1. Runtime Context **bukan sekadar derivasi**: ia adalah **satu-satunya saksi** pesan-pesan yang belum durable (user prompt, balasan asisten, hasil tool) dalam epoch penulis ini. Karena itu tier-nya **EXECUTION-LOCAL + EVIDENCE-belum-diterbitkan**, bukan "derived murni". Konsekuensi: menolak menulis tidak boleh berarti **menghapus bukti** — tail yang ditolak wajib dikarantina (jurnal/diagnostik eksplisit), bukan dibuang diam-diam.
2. Otoritas yang boleh diklaim buffer hanya **satu bentuk klaim**: *append-extension* atas ekor kanonik (prefix tersimpan harus identik byte, lalu tumbuh). Klaim di luar itu = **REFUSED**, dan **tidak boleh** diselesaikan dengan menulis ulang.

Konsistensi dengan arsitektur saat ini (bukti, bukan asumsi):

| Bukti | Arti |
| --- | --- |
| `saveSession` menolak rewrite (`RefusedHistoryRewriteError` `:1019`) | kanonik sudah append-only; arah invariant sudah benar |
| `context-assembly.ts` read-only + guard `:486` (tanpa INSERT/UPDATE/DELETE) | perakitan tidak menulis |
| UI/daemon tidak membaca buffer (grep `state.history`: hanya `cli/setup.ts:1962`) | tidak ada konsumen yang memaksa buffer jadi otoritas |
| `persistCurrent` memakai buffer sebagai `durableHistory` (`cli/setup.ts:1962-1990`) dan men-`catch` refusals lalu memanggil `shrinkThreadHistory` (`:1983`) | **satu-satunya pelanggaran nyata** — dan itulah yang kontrak ini larang |

**Klaim yang diizinkan vs dilarang:**

| Klaim buffer | Status |
| --- | --- |
| "kanonik = prefix tersimpan; buffer = prefix + tail baru" | ALLOWED (append-extension) |
| "buffer ≠ ekstensi kanonik" (reuse id, penulis lain, cabang, fold tanpa catatan) | **REFUSED — no destructive fallback** |
| "buffer adalah versi ringkas dari prefix, jadi tulis ulang saja" | DILARANG kecuali operasi diklasifikasikan eksplisit (§3.3) |

### 3.1 Transfer otoritas

Tidak ada "transfer otoritas" dari kanonik ke buffer, dan tidak sebaliknya. Yang ada
adalah **transfer bukti**: saat `saveSession` menerima ekstensi, baris baru mendapat
`event_id` kanonik (`allocateHistoryEventId`) dan kursor Run maju dalam txn yang sama
(`persistence.ts:904-1035`). Sebelum itu, isi tail berstatus *evidence pending*, dan
sesudah itu berstatus *authoritative*.

### 3.2 Deteksi divergensi (sebelum persist)

Divergensi dideteksi **secara struktural**, bukan heuristik teks:

1. **Sumber**: `thread_id` aktif (`DEFAULT_THREAD_ID` hari ini) + head kanonik `H = MAX(seq)`.
2. **Identitas**: setiap baris tersimpan punya `event_id` (pasca-backfill P2.5; baris NULL transisional ditolak lewat `PROJECTION_INVALID` untuk proyeksi).
3. **Uji ekstensi**: panjang & urutan baris ke-`i` (role/content/toolCalls/toolCallId/name/reasoning/isError) harus sama persis untuk `i < stored.length` (implementasi saat ini sudah melakukan ini: `persistence.ts:952-1010`).
4. **Uji anchor**: bila buffer mengklaim merupakan *fold* dari prefix, klaim itu harus membawa bukti `(base_seq, anchor_event_id)` yang cocok dengan baris kanonik (aturan proyeksi 6–7 di `getProjectionStatus`).
5. **Hasil klasifikasi**: `APPEND` · `FOLD-RECORDED` · `DIVERGED` · `UNKNOWN` (DB tak terbaca).

### 3.3 Operasi yang diklasifikasikan (dan hanya ini)

| Operasi | Kelas | Bukti yang wajib | Dampak isi kanonik |
| --- | --- | --- | --- |
| append-extension otomatis | authorized (otomatis) | fence epoch + uji ekstensi | +tail |
| fold (kompaksi) | authorized (otomatis) **non-destruktif** | rekaman cakupan `(base_seq, anchor_event_id)` + teks ringkasan + provenance model/waktu | **TIDAK ADA** (kanonik utuh) |
| `deleteSessionCompletely` (purge/TTL/user) | authorized semantic delete | intent eksplisit + penghapusan satu txn (sudah ada `:3209`) | dihapus seluruhnya (domain berakhir) |
| shrink eksplisit (bila tetap dipertahankan) | authorized semantic rewrite | intent operator + arsip + provenance + notifikasi | prefix diganti |
| shrink implisit akibat divergensi | **DILARANG** | — | — |

---

## 4. Reconciliation Contract (lifecycle)

Lifecycle normatif:

```text
canonical state            (messages: prefix tersimpan, head H, anchor A(H))
      ↓  context assembly  (baca-saja, deterministik)
runtime context            (ContextStore: prefix kanonik + [fold label] + tail)
      ↓  model execution
runtime mutation           (append assistant/tool; mungkin fold)
      ↓  reconciliation    (klasifikasi: APPEND | FOLD-RECORDED | DIVERGED | UNKNOWN)
      ↓  canonical persistence (append-extension | rekam fold | REFUSE)
```

Definisi istilah kontrak:

| Istilah | Definisi |
| --- | --- |
| input watermark | `(session_id, thread_id, base_seq B, anchor_event_id A)` yang menyatakan cakupan prefix yang diwakili konteks; `B=0, A=null` = tidak ada cakupan |
| source identity | `(session_id, thread_id)`; bukan `run_id` |
| context identity | `(session_id, thread_id, B, A)` + `projection_id` bila berasal dari proyeksi (§5) |
| context version | tidak disimpan sebagai angka; **versi = konsekuensi identitas + rebuild** — dua konteks dengan identitas sama wajib ekuivalen secara isi |
| canonical head | `H(thread) = MAX(seq)` (posisi; `-1` bila kosong) |
| expected head | `B + |tail| - 1` menurut klaim konteks; ketidakcocokan → divergensi |
| freshness | `A` masih merupakan `event_id` baris pada `seq = B-1`, dan `H >= B-1` |
| stale detection | `A` hilang/berubah, atau baris cakupan berubah identitas ⇒ **coverage invalid** (bukan "histori berubah") |
| divergence detection | uji ekstensi gagal DAN tidak ada rekaman fold yang cocok |
| append-only extension | prefix identik byte + panjang bertambah |
| legitimate compaction | fold yang **merekam cakupan**; tanpa rekaman = bukan fold yang sah (lihat §8) |
| recovery | rekonstruksi konteks dari kanonik + rekaman fold + direktif jurnal (UNKNOWN-first) |
| conflict | klaim buffer tidak dapat dipertemukan dengan kanonik dalam satu txn |
| UNKNOWN state | ketidakmampuan dibuktikan (DB tak terbaca, jurnal tak terbaca, proyeksi tak terbaca) — **wajib mengikat lebih kuat daripada asumsi aman** |

**Larangan eksplisit (rantai yang ditemukan audit):**

```text
runtime buffer diverges  →  append fails  →  blind shrink  →  canonical history replaced
```

Rantai ini **DILARANG**. Pada `DIVERGED`, perilaku wajib:

1. tolak tulis kanonik (fence tetap berlaku);
2. jangan menulis ulang, jangan menghapus, jangan "memperbaiki";
3. karantina tail sebagai bukti + diagnosa eksplisit;
4. naikkan ke operator dengan jalur eksplisit (mis. `--resume`, reset sesi eksplisit) — bukan tebakan;
5. hasilkan state **CONFLICT/UNKNOWN** yang terlihat (tidak boleh dirender sebagai sukses).

---

## 5. Context Identity

Kandidat yang dievaluasi dan keputusannya (minimum yang cukup, bukan "karena audit bilang kurang"):

| Dimensi | Dipakai? | Alasan berbasis bukti |
| --- | --- | --- |
| `session_id` | **YA** | semua baris messages thread-scoped per sesi; menangkap "wrong session" |
| `thread_id` | **YA** | `loadThreadHistoryWithSeq(sessionId, threadId)`; menangkap "wrong thread/branch" |
| `base_seq` (sequence watermark) | **YA — sebagai posisi** | cakupan `[0,B)` sudah kanonik di `history_projections` (`included_ranges`, `base_seq`) |
| `event_id` (anchor) | **YA — sebagai identitas** | `anchor_event_id` sudah menjadi jangkar validasi proyeksi (`getProjectionStatus` aturan 6–7) |
| `projection_id` | **YA (bila konteks dari proyeksi)** | `SUMMARY_PROJECTION_ID` divalidasi (`PROJECTION_IDS`) |
| `run_id` | **TIDAK** | context-assembly eksplisit "tanpa reads atas runs / run_id" (`:13`); run berakhir, konteks harus hidup lintas run (resume) |
| event frontier (multi-thread) | **BELUM** | belum ada traversal; dicadangkan sebagai ekstensi `(parent_thread_id, fork_event_seq)` saat P3.7 |
| projection version (angka) | **TIDAK** | validitas proyeksi sudah dihitung dari data (`base_seq`+`anchor`+`head`), bukan versi |

**Identitas konteks minimum (normatif):**

```text
ContextIdentity = ( session_id, thread_id, coverage: {base_seq, anchor_event_id}, projection_id? )

aturan: B = 0  ⇒  anchor_event_id = null  (cakupan vakum)
        B > 0  ⇒  anchor_event_id = event_id baris (thread, seq = B-1)
```

Dimensi ini cukup untuk mendeteksi seluruh kelas kesalahan yang diminta:

| Kesalahan | Terdeteksi oleh |
| --- | --- |
| stale context | `anchor_event_id` tidak lagi cocok dengan baris `B-1` |
| wrong thread | `thread_id` berbeda dari thread sumber |
| wrong branch | `thread_id` + (nanti) `parent_thread_id`/`fork_event_seq` |
| wrong session | `session_id` |
| wrong projection | `projection_id` + cakupan |
| wrong resume state | `base_seq`/anchor vs head kanonik saat itu |

---

## 6. Context Version / Freshness

Kontrak:

```text
"This context was derived from THIS canonical state."
⇔  ContextIdentity cocok dengan kanonik saat verifikasi dijalankan
```

| Pertanyaan | Jawaban kontrak |
| --- | --- |
| Apa source watermark? | `(B, anchor_event_id)` atas `(session, thread)` — sudah tersedia di skema proyeksi |
| Apa canonical head? | `MAX(seq)` thread tersebut; **dihitung saat verifikasi**, tidak dipercaya dari cache (`head_seq` hanyalah cache) |
| Bisakah konteks basi? | Ya: bila anchor tak lagi cocok / baris cakupan berubah identitas |
| Bolehkah konteks basi dipakai? | **Boleh, hanya sebagai "prefix coverage"**: prefix yang tercakup tetap dipakai sebagai ringkasan/label, **tail wajib dibaca segar dari kanonik**. Basi ≠ invalid (lihat §7 catatan penting) |
| Bagaimana freshness dicek? | tiga langkah deterministik: (1) anchor cocok; (2) boundary aman (tidak memisahkan pasangan tool-call/result — sudah ada `boundaryIsSafe`); (3) tail dibaca ulang dari kanonik |
| Bagaimana konteks dibangun ulang? | selalu dari `messages` kanonik (selalu mungkin); rekaman fold hanya menambah kenyamanan/cost, bukan syarat kebenaran |

**Aturan keras:** konteks **tidak boleh** menyimpan versi sebagai klaim yang dipercaya tanpa verifikasi. Versi = hasil verifikasi saat pakai, bukan field yang dipercaya.

---

## 7. History → Context Mapping (formal)

```text
Canonical Events (messages, thread-scoped, ORDER BY seq)
      ↓ Selection      : seluruh baris thread; TIDAK ada filter role (user/assistant/tool setara)
      ↓ Ordering       : seq menaik (posisi penyimpanan)
      ↓ Projection     : fold opsional atas prefix [0,B) bila rekaman cakupan valid
      ↓ Assembly       : [label fold?] ++ rows[seq >= B]  (baca-saja)
      ↓ Model Input    : { messages, system, tools }  (vendor `buildRequest`)
```

| Aspek | Aturan |
| --- | --- |
| Termasuk | semua baris `messages` thread aktif (user, assistant, assistant+toolCalls, tool result, error result, reasoning (field, bukan baris)) |
| Dikecualikan | `presentation_events`, `VerificationRecord`, jurnal, `tasks.db`/TaskGraph, `consumer_offsets`, capability/approvals, `turns` |
| System instructions | **kanal terpisah**, bukan pesan dalam `messages` (`SessionConfig.system` → `buildRequest.system`); ia DERIVED + tidak kanonik (§12) |
| Summary | satu pesan user sintetis berlabel ("Previous context …") yang **hanya hidup di konteks**; tidak pernah menjadi baris `messages` (guard `p2-architecture-guards.test.ts:423`) |
| Tool results | termasuk; dipangkas `toolResultMaxTokens` oleh kernel, bukan oleh konteks |
| Task/verification | **tidak masuk konteks** (guard `:730` verification vs conversation) |
| Event identity | baris durable mempertahankan `event_id`; **`Message` vendor tidak membawa identitas** (tipe beku) ⇒ setiap artefak konteks wajib mampu menyebut rentang `event_id` yang diwakilinya (via `coverage`), karena array pesan saja bukan bukti |
| Thread boundaries | satu konteks = satu thread; tidak ada gabungan lintas thread dalam satu assembly |
| Branch boundaries | belum ada; saat P3.7, konteks cabang wajib menyebut `(parent_thread_id, fork_event_seq)` |
| Ordering | `seq` menaik dalam thread; **lintas thread tidak ada urutan global** |

**Identity ≠ Sequence (eksplisit):** `seq` adalah **posisi** yang dinomori ulang pada setiap
rewrite (`shrinkThreadHistory` menulis ulang `seq = i`, `:3092-3150`), sementara `event_id`
adalah identitas yang diadopsi/dipertahankan untuk baris identik dan diterbitkan baru untuk
baris yang berubah. Akibatnya:

- `seq` **tidak boleh** dipakai sebagai identitas event (tidak stabil lintas rewrite).
- Fold yang diwujudkan sebagai **rewrite baris** akan **kehilangan identitas** baris yang
  diringkas (baris dapat `event_id` baru). Karena itu fold **tidak boleh** diwujudkan sebagai
  penulisan ulang pesan; ia harus menjadi **rekaman cakupan** (§8).
- Batas turn tidak dapat direkonstruksi: `turns` tidak memetakan `turn_idx` ke `seq` (bukti: skema `turns`). Kontrak menyatakan ini **batasan yang diketahui**, bukan fitur.

---

## 8. Projection Architecture Decision

**Keputusan (satu arah, tidak ambigu):**

> **B — `history_projections` adalah CACHE/derivatif, bukan otoritas; dan sekaligus
> satu-satunya mekanisme proyeksi P3 untuk fold kompaksi serta cakupan prefix
> konteks (peran "A" secara peran, "B" secara otoritas).**

Alasan (berbasis bukti, bukan preferensi):

1. Skemanya **sudah** berbentuk yang dibutuhkan kontrak ini: `base_seq`, `included_ranges`, `anchor_event_id`, `summary_text`, `built_at` (`persistence.ts:279`).
2. Validitasnya **sudah** fail-closed & deterministik (9 aturan `getProjectionStatus`), termasuk menolak cakupan berlubang `event_id` (`buildProjectionInTxn`).
3. Ketidakhadirannya **sudah** berarti "cache miss": `UNKNOWN: no projection row` → fallback histori penuh. Ini persis semantik cache yang kontrak butuhkan.
4. Menolak opsi D (pensiun) karena ia menghapus satu-satunya substrat yang dapat merekam fold **tanpa** menulis ulang kanonik — padahal justru itu yang dibutuhkan §9 untuk menutup CRITICAL-1 tanpa membuat kompaksi destruktif.
5. Menolak opsi C (arsitektur proyeksi baru) karena menambah permukaan tanpa kebutuhan yang terbukti, dan guard sudah menahan penulis liar (`:105`).

Turunan keputusan:

| Aspek | Kontrak |
| --- | --- |
| Otoritas | **tidak pernah**; ringkasan tidak boleh masuk `messages`, tidak boleh dipakai sebagai bukti fakta, tidak boleh menjadi sumber kebenaran |
| Rebuild | selalu mungkin dari `messages` (yang kini **tetap utuh**); rebuild = hitung ulang cakupan + teks ringkasan |
| Invalidation | (a) `anchor_event_id` tidak lagi cocok; (b) thread archived; (c) rewrite historis yang sah (kelas §3.3) menghapus baris dalam txn yang sama; (d) cakupan melebihi `head+1` ⇒ CORRUPT |
| Recovery | proyeksi absen/rusak/basi = **degradasi ke konteks penuh**, bukan kegagalan; UNKNOWN dilaporkan, tidak dipromosikan |
| Yang berubah nanti (P3.2+) | pembaca harus menerima **coverage-valid** (bukan hanya CURRENT) sebagai keadaan dapat dipakai, karena `getProjectionStatus` aturan 8 membuat proyeksi tak berguna setelah satu turn (`head advanced beyond coverage → STALE`) — inilah alasan proyeksi tidak pernah berguna setelah dibuat |
| Kode yang dapat dipakai ulang | `buildProjection`/`rebuildProjection`, `getProjectionStatus`, `getProjection`, `loadThreadHistoryWithSeq`, `boundaryIsSafe`, `stripContextOnly` |
| Kode yang menjadi usang (bila P3.2 mendarat) | pemakaian `shrinkThreadHistory` di `persistCurrent` (`cli/setup.ts:1983`) untuk kompaksi; `stripContextOnly` tetap dipakai selama penyemaian artefak proyeksi masih ada |
| Yang **tidak** diubah sekarang | tidak ada kode; ini murni keputusan kontrak |

---

## 9. Compaction Contract

**Klasifikasi yang dituju: A + C (hybrid).** Kompaksi adalah **transformasi context-only**
(A) yang artefaknya **ringkasan derivatif tersimpan terpisah** (C).
**B (canonical-history rewrite) dinyatakan NON-CONFORMING.**

Klasifikasi implementasi saat ini: **B** — `compactWithLlm` → buffer diganti → `persistCurrent`
men-`catch RefusedHistoryRewriteError` → `shrinkThreadHistory` (`cli/setup.ts:1983`),
menghapus prefix dan menulis ringkasan sebagai baris kanonik dengan `migrated_compacted=1`.
Konsekuensi terukur: prefix asli hilang tanpa arsip (audit §9 HIGH-1).

| Aspek | Kontrak |
| --- | --- |
| Canonical truth | `messages` **utuh**; kompaksi tidak menghapus apa pun |
| Ringkasan | derivatif berlabel; disimpan sebagai rekaman cakupan (proyeksi), dengan provenance: model, `base_seq`, `anchor_event_id`, `built_at` |
| Provenance ringkasan | wajib: identitas model, waktu, cakupan, dan penanda "derived summary"; teks ringkasan **di-scrub** sebelum disimpan (`scrubSecrets`, sudah dipakai di jalur kompaksi & memori) |
| Arsip | tidak diperlukan selama (A+C) dipatuhi; bila suatu saat rewrite destruktif diizinkan (§3.3), **arsip wajib** |
| Recoverability | prefix tetap dapat dibaca ⇒ ringkasan dapat dibangun ulang kapan pun |
| Replay | replay presentasi/history **tidak** ikut memutar ulang fold; fold adalah kebijakan konteks |
| Verifikasi | tidak terpengaruh: `VerificationRecord` bukan bagian histori dan tidak masuk konteks |
| Branch impact | rekaman fold ter-scope `(session, thread)`; cabang tidak mewarisi cakupan thread lain |
| Projection invalidation | fold yang lebih tua dari rewrite historis yang sah = invalid |
| Context rebuild | assembly = `[label fold untuk cakupan valid] ++ tail kanonik`; bila rekaman tidak ada, konteks penuh (lebih banyak konteks, bukan fakta berbeda) |
| Larangan keras | ringkasan **tidak boleh** menjadi lebih kuat dari fakta: (i) tidak masuk `messages`; (ii) selalu berlabel; (iii) tidak pernah menjadi bukti efek/verifikasi; (iv) tidak pernah menutupi baris yang belum pernah ada |

**Aturan transisi (mengikat sampai A+C mendarat):** selama jalur B masih ada,
setiap penulisan ulang destruktif wajib memenuhi tiga syarat sekaligus — intent eksplisit,
arsip prefix, dan notifikasi operator. Bila salah satu tidak tersedia, operasi **ditolak**
(no destructive fallback).

---

## 10. Resume Contract

```text
restart → canonical state → context reconstruction → model-visible state
```

| Skenario | Jawaban kontrak |
| --- | --- |
| Resume normal | konteks = fungsi deterministik dari `messages` (+ rekaman fold); isi fakta **selalu** sama dengan kanonik |
| Proyeksi basi (anchor masih cocok, head maju) | dipakai sebagai **coverage** (ringkasan prefix) + tail kanonik segar; bukan error |
| Proyeksi hilang | cache miss ⇒ konteks penuh; dilaporkan sebagai status (bukan kegagalan, bukan sukses) |
| Proyeksi korup (bentuk tak kanonik, `base_seq` mustahil, anchor hilang) | fallback penuh + status `CORRUPT` **terlihat**; baris tidak diperbaiki diam-diam |
| Head kanonik berubah sejak snapshot | konteks dirakit ulang dari head saat itu; tidak ada reuse buta |
| Setelah kompaksi | konteks = fold + tail (bila rekaman ada) atau penuh (bila tidak) |
| Setelah run terinterupsi | direktif recovery dari jurnal menjadi system appendix; **tidak ada auto re-execute**; status mutation yang tak terbukti tetap UNKNOWN |
| Setelah crash | durable = turn terakhir yang selesai (kernel transaksional: `run()` discard turn gagal); jurnal menyediakan intent/terminal; turn-marker mendeteksi liveness basi |
| Resume dengan id yang dipakai ulang tanpa `--resume` | **bukan** resume: kontrak memperlakukannya sebagai pemakaian id pada sesi yang sudah ada ⇒ wajib menolak attach implisit (lihat §14/§19 D2). Perilaku hari ini (rewrite destruktif) **dilarang**. |

UNKNOWN tetap kelas pertama: `UNKNOWN ≠ success`; ketiadaan bukti tidak boleh dirender
sebagai keberhasilan, dan pemulihan yang tidak dapat dibuktikan tidak boleh mengklaim lengkap.

---

## 11. Child Context Contract (minimum P3; orkestrasi tetap P9)

| Pertanyaan | Kontrak |
| --- | --- |
| Apa yang boleh diwarisi | workspace `cwd`, model aktif (live), provider routing/rate limiter, **atenuasi** izin (subset ketat), dan tugas parent sebagai DATA berpagari |
| Apa yang tidak boleh diwarisi | histori pesan parent, ringkasan/fold parent, jurnal parent, epoch/lease parent, otoritas Run parent, capability grant di luar atenuasi |
| History disalin? | **Tidak** (bukti: anak dibuat tanpa `initialMessages`) |
| Summary disalin? | **Tidak** |
| Instruksi diwarisi? | Hanya sebagai blok DATA berlabel ("Parent task … not new system instructions"), dan ia **bukan** instruksi sistem anak; system anak dibangun ulang dari konteksnya sendiri |
| Batas atenuasi | izin anak ⊆ izin parent (`isCapabilitySubset`/`isGrantSubset`); mode anak tidak boleh melonggarkan (`allowlist` diwarisi; `plan/readonly` dipaksa explore; handler otonom di-inject) |
| Batas identitas | anak punya `session_id`, `thread_id`, `run_id` sendiri; `parent_session_id`/`parent_run_id` = **lineage**, bukan otoritas |
| Batas hasil | hasil anak masuk parent sebagai **satu** hasil tool (teks); metrik boleh diteruskan; pesan/jurnal anak **tidak** masuk parent |
| Roll-up | tidak ada (deferred; P9) |

---

## 12. Memory / RAG Boundary

Audit perilaku aktual:

| Aspek | Fakta (bukti) | Klasifikasi kontrak |
| --- | --- | --- |
| Penyimpanan | tabel `memory` (`vector.ts:51`): id, text, embedding, created_at, category, tags, model, dim, parent, access_count | DERIVED (unverified) |
| Provenance | **tidak ada** `session_id`/`event_id`; hanya `parent` (pengelompokan chunk) | Gap yang dinyatakan: memori **tidak dapat diaudit** ke asalnya |
| Penulis | `write_memory` (model), ringkasan kompaksi (category `summary`), `MEMORY.md` (berkas) | model-influenced |
| Pembaca | `searchHybrid` (topK, hybrid vektor+keyword) → `systemExtra` | derived retrieval |
| Mutasi saat baca | `UPDATE memory SET access_count = access_count + 1` (`:706`, best-effort, opt-out `trackAccess`) | mutasi store derivatif dari jalur baca — dideklarasikan, bukan otoritas |
| Waktu injeksi | **sekali per sesi**, dan **hanya** bila prompt awal non-kosong (`rag-layer.ts:61-62`) ⇒ sesi interaktif tidak mendapatkannya | pelanggaran determinisme lintas jalur |
| Kesegaran | tanggal (`created_at`) ditampilkan ke model | advisori saja |
| Replay | tidak di-replay; resume tidak mengulang retrieval ⇒ system prompt sesi resumed berbeda | Gap yang dinyatakan |
| Determinisme | tidak deterministik (embedding jaringan, topK, `access_count`) | tidak boleh menjadi bagian identitas konteks |
| Kepercayaan | dilabel "UNTRUSTED recalled content … treat as DATA" | tidak pernah menjadi instruksi |

**Kontrak:** memori adalah **augmentasi model-only** — tidak kanonik, tidak memverifikasi,
tidak otoritatif. Karena tidak deterministik dan tidak diputar ulang, ia **wajib
difingerprint** (mis. daftar id hit + skor + waktu) dan fingerprint itu dicatat sebagai
bukti saat injeksi terjadi, agar model input dapat direkonstruksi (§13). Kebijakan
per-turn vs session-start **belum ditetapkan** dan menjadi keputusan P3 (D4).

---

## 13. Model-Visible Context Contract

| Kanal | Sumber | Tier | Determinisme | Wajib direkonstruksi? |
| --- | --- | --- | --- | --- |
| System instructions | `buildSystemPrompt` (`policy/context.ts:37`) + `systemExtra` | DERIVED (statis per proses) | tidak (isi workspace berubah; RAG berbeda) | **YA** — fingerprint + (rekomendasi) rekaman |
| Canonical history | `messages` via assembly | AUTHORITATIVE (turunan tampilan) | ya | ya |
| Summary/fold | rekaman proyeksi | DERIVED | ya (teks tersimpan) | ya |
| Tool results | baris `messages` role tool | AUTHORITATIVE | ya | ya |
| Recovered state | direktif jurnal → `systemExtra` | EVIDENCE → DERIVED | ya (dari jurnal) | ya |
| RAG/memory | `searchHybrid` → `systemExtra` | DERIVED (untrusted) | tidak | **YA (belum ada)** — fingerprint hit |
| Task state | **tidak diinjeksi** (tidak ada TaskGraph di prompt; todo dibaca model via tool) | — | — | — |
| Runtime metadata | cwd, platform, rel-path rule (di dalam system prompt) | DERIVED | ya (kecuali cwd berubah) | ya |

**Tidak pernah model-visible:** `presentation_events`/PresentationState, `consumer_offsets`,
`VerificationRecord`, isi mentah jurnal, `writer_epoch`/lease/token, `run_id`/kursor,
histori sesi lain, histori/cabang lain, histori anak, capability grants/approval mentah,
`.minicode/` dan path sensitif, isi berkas di luar jail.

**Syarat kontrak:** "model input harus dapat direkonstruksi dari explicit state/evidence".
Kesenjangan yang teridentifikasi hari ini (harus ditutup sebelum P3 dinyatakan selesai):

1. `sessions.system` durable **ditulis tetapi tidak dibaca** saat resume ⇒ tidak dapat
   dipakai untuk rekonstruksi; system prompt hanya dapat didekati dengan membangun ulang
   dari workspace.
2. Injeksi RAG tidak dicatat ⇒ sebuah sesi yang sama, di-resume, dapat memiliki system
   prompt yang berbeda tanpa jejak.
3. Tidak ada fingerprint prompt/konteks ⇒ tidak ada cara mendeteksi "konteks ini berbeda".

---

## 14. Failure Semantics

| Kondisi | Perilaku wajib | Dilarang |
| --- | --- | --- |
| DB tak terbaca / baris hilang saat baca konteks | status `UNKNOWN`, fallback aman bila mungkin, operasi ditolak bila tak dapat dibuktikan | mengarang konteks, "memperbaiki" data |
| Divergensi (buffer ⊄ kanonik) | REFUSE + karantina bukti + operator path | shrink/rewrite implisit |
| Fold tanpa rekaman cakupan | diperlakukan sebagai divergensi (bukan fold) | menebak cakupan dari teks |
| Proyeksi korup | fallback penuh + status `CORRUPT` terlihat | normalisasi diam-diam |
| Anchor hilang/berubah | `coverage invalid` → konteks penuh | memakai ringkasan yang tak terbukti |
| Jurnal tak terbaca | no-op + warning; **tidak** memblokir resume | mengklaim pemulihan lengkap |
| Fence epoch gagal | `StaleWriterError` → berhenti, tandai stale, keluar jujur | retry buta, menimpa penulis baru |
| Run live saat shrink diminta | ditolak (`RefusedShrinkLiveRunError`) | terminal-mark implisit |
| Anak gagal admission | anak tidak dijalankan; residu diterminalkan | menjalankan anak tanpa pagar |
| Memori/embedding gagal | retrieval dilewati, sesi tetap jalan | menulis/mengarang memori |

---

## 15. UNKNOWN Semantics

1. UNKNOWN = "tidak dapat dibuktikan", bukan "aman" dan bukan "gagal".
2. UNKNOWN wajib **terlihat** pada permukaan yang mengonsumsi (status, provenance) dan
   tidak boleh dirender sebagai sukses (guard `p2-architecture-guards.test.ts:1078`).
3. UNKNOWN tidak boleh dipromosikan tanpa bukti eksplisit (`:865`).
4. Untuk konteks: konteks absen/rusak ⇒ **konteks penuh** (paling aman) + status jujur;
   yang dilarang adalah **konteks yang lebih sempit dari kebenaran tanpa penanda**.
5. Bila kanonik sendiri UNKNOWN (DB rusak), konteks juga UNKNOWN — bukan konteks kosong.

---

## 16. Security / Capability Implications

| Implikasi | Kontrak |
| --- | --- |
| Konteks bukan kanal kapabilitas | tidak ada keputusan izin yang boleh berasal dari konteks/ringkasan/memori; gate izin tetap di `permission`/`capability`(DI) |
| Ringkasan memuat teks tak-terpercaya | wajib `scrubSecrets` sebelum disimpan; ringkasan tetap DATA, bukan instruksi |
| Proyeksi menyimpan teks sensitif | diperlakukan sebagai data sensitif (masuk DB sesi); tidak boleh disajikan ke UI (guard `:1000`) |
| Memori lintas-sesi = lintas-kepercayaan | memori repo harus lokal (`addMemory` memaksa `.minicode/` lokal); chmod 600; label UNTRUSTED wajib |
| Atenuasi anak | subset ketat (`isCapabilitySubset`), handler otonom di-inject (tanpa mode yang bisa dicabut) |
| Jurnal menyimpan argumen tool | sudah di-hash (`hashArgs`), path diverifikasi (`verifyPaths`) |
| Konteks tidak boleh melonggarkan jail | path relatif tetap diselesaikan di `cwd` sesi; isi di luar jail tidak boleh masuk konteks |
| Fingerprint konteks bukan rahasia | fingerprint hanya identitas (id/urutan), bukan isi; tidak menyimpan token/kunci |

---

## 17. Non-Goals (P3.0)

- Implementasi apa pun (paging, traversal, produsen proyeksi, redesign kompaksi, pewarisan anak).
- Perubahan skema/migrasi.
- Perubahan `vendor/minicore/**`.
- Orkestrasi multi-agen (P9), presentasi/UX (P11), runtime long-running (P12).
- Redesign memori/RAG (hanya batasnya yang didefinisikan).
- Menetapkan kebijakan retensi/TTL konten (keputusan owner; lihat §19 D1).

---

## 18. Explicit Invariants (dapat diuji)

1. **I1** Isi kanonik hanya berubah lewat append-extension atau operasi kelas §3.3 yang eksplisit.
2. **I2** Tidak ada penulisan ulang historis implisit; `RefusedHistoryRewriteError` **tidak pernah** ditangani dengan shrink otomatis.
3. **I3** Runtime Context tidak pernah menjadi autoritas isi kanonik.
4. **I4** Setiap artefak konteks menyebut `(session_id, thread_id, base_seq, anchor_event_id)`.
5. **I5** `event_id` adalah identitas; `seq` adalah posisi; keduanya tidak pernah dipertukarkan.
6. **I6** Ringkasan/fold tidak pernah masuk `messages` dan selalu berlabel.
7. **I7** Projection adalah cache: absen = cache miss, bukan error.
8. **I8** Assembly bersifat read-only dan deterministik untuk `(state kanonik, rekaman fold)` yang sama.
9. **I9** Resume tidak pernah menghasilkan fakta yang berbeda dari kanonik; paling banyak konteks yang berbeda luasnya.
10. **I10** UNKNOWN tidak pernah dirender/dipromosikan sebagai sukses.
11. **I11** Anak tidak mewarisi histori/ringkasan/otoritas parent; hasil anak adalah satu hasil tool.
12. **I12** Memori/RAG tidak pernah kanonik, selalu tak-terpercaya, dan injeksinya dapat direkonstruksi (fingerprint).
13. **I13** Fence `writer_epoch` tetap satu-satunya pagar mutasi; tidak ada penulis kedua.
14. **I14** Presentation tetap observation-only; tidak ada jalur UI/daemon → kanonik.
15. **I15** Tidak ada kapabilitas yang diperoleh melalui konteks.

---

## 19. Open Questions & Architecture Decisions Requiring Freeze

**D1 — Kebijakan rewrite destruktif.** Apakah MiniCode mengizinkan penghapusan permanen
isi kanonik (purge/TTL/reset eksplisit) tanpa arsip? *Rekomendasi: purge/TTL = hapus
domain penuh (sudah ada); rewrite sebagian = wajib arsip.*
**D2 — Semantik pemakaian ulang id sesi (`--session <id>` pada id yang sudah ada).**
*Rekomendasi: tolak attach implisit; sediakan reset eksplisit (mis. flag khusus) yang
menghasilkan operasi kelas §3.3 dengan notifikasi.* Menolak rekomendasi ini memaksa
rekonsiliasi ulang §3/§10.
**D3 — Bentuk rekaman fold.** *Rekomendasi: rekaman cakupan di `history_projections`
(base_seq + anchor + summary_text + provenance), kanonik utuh.* Alternatif (arsip baris
prefix + rewrite) menambah penyimpanan dan menuntut kebijakan retensi → §8.
**D4 — Kebijakan waktu injeksi memori/RAG** (session-start saja vs per turn) dan apakah
fingerprint injeksi disimpan durable. *Rekomendasi: definisikan satu kebijakan yang sama
untuk semua jalur masuk; simpan fingerprint.*
**D5 — Fingerprint system prompt & cakupan rekamannya** (menyimpan hash + input yang
dipakai). *Rekomendasi: ya, sebagai bukti.*
**D6 — Staleness tolerance proyeksi** (menerima `coverage-valid` selain `CURRENT`).
*Rekomendasi: ya — tanpa ini proyeksi tak pernah berguna setelah satu turn.*

**Yang TIDAK perlu diputuskan lagi (sudah dijawab penuh di dokumen ini):** identitas
konteks minimum (§5), definisi freshness (§6), pemetaan history→context (§7),
klasifikasi otoritas seluruh objek (§2), larangan destructive fallback (§3), kontrak
kompaksi yang dituju (§9), kontrak resume termasuk URUTAN crash/interupsi (§10),
batas anak (§11), batas memori (§12), isi model-visible + yang tidak pernah terlihat (§13),
semantik kegagalan/UNKNOWN (§14/§15), implikasi keamanan (§16).

---

## Appendix A — Ownership Graph (hasil modifikasi dari diagram yang diminta)

```text
                         CANONICAL AUTHORITY  (writer tunggal: persistence.ts)
                                     │
        ┌────────────────────┬───────┴────────┬─────────────────────┐
        ↓                    ↓                ↓                     ↓
   Session/Thread          History          Journal            TaskStore
   (AUTHORITATIVE;      (AUTHORITATIVE;   (EVIDENCE;         (AUTHORITATIVE
    head_seq = CACHE)    event_id ≠ seq)   fsync, UNKNOWN)    domain tugas)
        │                    │
        │                    │  (baca-saja, selalu mungkin)
        │                    ↓
        │            Context Projection  ← CACHE (base_seq + anchor_event_id)
        │              [tanpa produsen produksi hari ini]
        │                    │
        │                    ↓
        │            Context Assembly (assembleContext)  ← DERIVED, read-only, RAM
        │                    │
        │                    ↓
        │            Runtime Context (ContextStore)  ← EXECUTION-LOCAL
        │                    │        (membawa EVIDENCE pesan belum-durable)
        │                    ↓
        │            Model-visible Context (buildRequest)  ← DERIVED
        │                    │
        └────────────────────┴──► RECONCILIATION (APPEND | FOLD-RECORDED | REFUSED)
                                     │
                                     └─► kembali ke History (append-extension saja)

Samping (tidak pernah otoritatif atas konteks):
  PresentationState / presentation_events / consumer_offsets  → PRESENTATION
  VerificationRecord                                          → EVIDENCE (efek)
  Memori/RAG (memory DB + MEMORY.md)                           → DERIVED, model-only
  Child session (session/thread/run sendiri)                    → AUTHORITATIVE di domainnya
  Checkpoint/shadow-git                                         → EVIDENCE (domain berkas)
```

Perubahan dari diagram yang diminta: **Projection berada di jalur baca-saja dan
berstatus CACHE (bukan otoritas)**; **Run tidak berada di jalur konteks** (ia bukti
eksekusi, bukan input); **ada simpul Reconciliation** antara runtime context dan
persistensi; **Model tidak membaca kanonik secara langsung** — ia membaca hasil assembly.

---

## Appendix B — Compliance Map (setiap pertanyaan yang diminta → lokasi jawaban)

| Pertanyaan yang diminta | Dijawab di |
| --- | --- |
| 1. Who owns what (klasifikasi tier semua objek) | §2 |
| 2. Context authority rule (boleh/tidak, kondisi, transfer, deteksi divergensi, mekanisme rekonsiliasi) | §3 (+ §3.1–§3.3) |
| 3. Reconciliation contract (seluruh field lifecycle) | §4 |
| 4. Context identity (evaluasi dimensi + minimum) | §5 |
| 5. Context version/freshness | §6 |
| 6. History→context mapping formal | §7 |
| 7. Projection architecture decision (A/B/C/D) | §8 |
| 8. Compaction contract (A/B/C/D + turunan) | §9 |
| 9. Resume contract (stale/missing/corrupt/head berubah/pasca-kompaksi/interupsi/crash) | §10 |
| 10. Child context contract (minimum) | §11 |
| 11. Memory/RAG contract | §12 |
| 12. Model-visible context contract + yang tidak pernah terlihat | §13 |
| 13. Ownership graph | Appendix A |
| 14. Dokumen kontrak P3.0 (19 bagian) | Dokumen ini (§1–§19) |

**Peta daftar isi yang diminta (19 item) → bagian dokumen ini:**
1 Scope→§1 · 2 Ownership map→§2 · 3 Authority model→§3 · 4 Context identity→§5 ·
5 Version/freshness→§6 · 6 History→context mapping→§7 · 7 Projection semantics→§8 ·
8 Compaction semantics→§9 · 9 Resume/recovery semantics→§10 · 10 Child-context
boundary→§11 · 11 Memory/RAG boundary→§12 · 12 Model-visible context contract→§13 ·
13 Failure semantics→§14 · 14 UNKNOWN semantics→§15 · 15 Security/capability
implications→§16 · 16 Non-goals→§17 · 17 Explicit invariants→§18 · 18 Open
questions→§19 · 19 Architecture decisions requiring freeze→§19 (D1–D6).
(§4 Reconciliation Contract adalah bagian tambahan yang menjawab pertanyaan
"3. Reconciliation Contract" dan menjadi rujukan §3/§10.)

---

## VERDICT

```text
CONTRACT READY FOR FREEZE
```

**Alasan:** seluruh pertanyaan yang diminta terjawab dengan bukti kode/test; tidak ada
kontradiksi tersisa antara kontrak dan arsitektur saat ini yang memerlukan rekonsiliasi
lanjutan. Perbedaan yang ada bersifat **terklasifikasi**, bukan terbuka:

- satu pelanggaran invariant yang ditemukan audit (blind shrink) **dinyatakan dilarang**
  dan digantikan mekanisme rekonsiliasi eksplisit (§3/§4);
- proyeksi **diklasifikasikan ulang sebagai CACHE** dengan aturan rebuild/invalidation/
  recovery yang sudah didukung substratnya (§8);
- kompaksi dituju ke **A+C (non-destruktif)** dengan larangan eksplisit ringkasan
  mengalahkan fakta (§9).

**Syarat freeze:** ratifikasi **D1–D6** di §19. Menolak **D2** atau **D3** memaksa
rekonsiliasi ulang §3/§8/§10 sebelum freeze (karena keduanya menentukan apakah
penghapusan isi kanonik pernah sah, dan di mana rekaman fold hidup).

Implementasi P3 **tidak boleh dimulai** sebelum kontrak ini diterima dan dibekukan.
