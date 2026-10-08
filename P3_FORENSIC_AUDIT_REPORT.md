# P3_FORENSIC_AUDIT_REPORT

**Step 0 — Forensic audit (Context ↔ Session Reconciliation)**
Basis: HEAD `e284298` (`main`), 7 Oktober 2026, working tree bersih.
Metode: rekonsiliasi dokumen (P2 handoff/audit) ↔ kode ↔ test; setiap klaim di
bawah punya situs kode atau perintah yang dijalankan. Tidak ada perubahan
produksi yang dilakukan selama audit; dua probe sementara dibuat lalu dihapus
(tree kembali bersih).

Status kosakata yang dipakai: `IMPLEMENTED` · `PARTIAL` · `FOUNDATION ONLY` ·
`MISSING` · `INCORRECT` · `CONFLICT` · `DEBT` · `BLOCKED` · `UNKNOWN`.

---

## 1. Executive Verdict

**Apakah MiniCode P3-ready?** **Tidak.** Bukan karena kekosongan, tetapi karena
(a) satu jalur destruktif ke histori kanonik **terjangkau hari ini lewat CLI
normal** (terbukti end-to-end, §9 CRITICAL-1), dan (b) kemampuan proyeksi
konteks P2.7/P2.8 yang diasumsikan sebagai fondasi P3 **tidak pernah dihasilkan
di produksi** (tanpa pemanggil produksi untuk `buildProjection`), sehingga
"ContextView dari proyeksi" adalah kapabilitas mati.

**Berapa banyak P3 yang sudah ada?** Substrat ada dan kuat (identitas sesi,
epoch fence, messages kanonik, jurnal, presentasi, anak kanonik), tetapi
**kapabilitas P3 hampir seluruhnya belum ada**: tidak ada identitas/versi/
kesegaran konteks, tidak ada paging/lazy loading, tidak ada traversal
branch/fork, tidak ada kebijakan proyeksi produksi, tidak ada rekonsiliasi
buffer↔kanonik, tidak ada kontrak child-context.

**Apakah sudah ada arsitektur konteks?** Ada **dua** yang berbeda dan keduanya
tidak lengkap: (1) konteks **runtime** = buffer vendor `ContextStore` yang
di-seed sekali dari `messages` lalu menjadi satu-satunya input model; (2)
"context projection" P2.7 (`history_projections`) yang read-only, fail-closed,
tetapi tak pernah ditulis produksi. Yang ada bukan satu arsitektur konteks,
melainkan dua representasi tanpa kontrak rekonsiliasi.

**Koheren dengan P2?** Sebagian besar invariant P2 **PASS** (epoch fence,
identitas, presentasi observasi, UNKNOWN-first, anak independen). Satu invariant
**FAIL**: "messages = canonical history (append-only; shrink eksplisit
berprovenance)" — jalur shrink kini dapat dipicu **implisit** oleh turn biasa.

**Risiko arsitektural terbesar:** buffer RAM vendor diperlakukan sebagai
**otoritas de-facto** (satu-satunya input model + sumber tulis balik kanonik),
tanpa identitas, versi, atau rekonsiliasi. Semua jalur destruktif yang
ditemukan adalah gejala dari akar ini.

**Kapabilitas terbesar yang hilang:** rekonsiliasi konteks↔sesi itu sendiri —
tidak ada objek/parameter kontrak yang menyatakan "konteks ini adalah proyeksi
dari (session, thread, watermark ini)" sehingga "konteks yang basi" maupun
"buffer yang bukan superset kanonik" tidak dapat dideteksi.

---

## 2. Repository Snapshot

| Item | Nilai |
| --- | --- |
| Branch | `main` |
| HEAD | `e284298` — `chore(p2): close session architecture and handoff to phase 3` |
| Working tree | bersih (`git status --porcelain` kosong) |
| Riwayat dekat | `9b75c7c` P2.12 daemon · `03ed162` P2.11 · `c0fa908` P2.10 (fondasi P2.1–P2.9 mendarat di sini) |
| Bahasa runtime | TypeScript + Bun; kernel vendor `vendor/minicore` (beku, seam aditif: `compactAsync`, `initialMessages`, `cwd`) |
| Test | 297 berkas di `test/` |
| DB | `sessions.db` (sessions, messages, turns, threads, runs, history_projections, presentation_events, session_aliases, session_takeovers, consumer_offsets, daemon_approvals) + `tasks.db` (tasks, task_meta, session_authority) |

Modul relevan:

| Modul | Peran |
| --- | --- |
| `src/session/persistence.ts` (3.494 baris) | satu-satunya pemilik skema & writer kanonik (`open()`, `saveSession`, `shrinkThreadHistory`, `buildProjection`, `createThread`, `branchSession`, `createChildSession`) |
| `src/session/identity.ts` | resolusi SessionId kanonik + alias; `resumed` flag |
| `src/session/authority.ts` | admission lease + `writer_epoch` |
| `src/session/context-assembly.ts` | `assembleContext` / `ContextView` / `stripContextOnly` (P2.8) |
| `src/policy/context.ts` | `buildSystemPrompt` (seeding system, sekali per proses) |
| `src/policy/compaction.ts` | kompaksi LLM (`createLlmCompaction`, `compactWithLlm`) |
| `src/app/session.ts` | `createMinicodeSession` → kernel `createSession` |
| `src/app/rag-layer.ts` | RAG memori → `systemExtra` |
| `vendor/minicore/src/core/{session,loop,history,compact,budget,tokens}.ts` | buffer konteks kernel, `buildRequest`, kompaksi, budget |
| `cli/setup.ts` (2.361 baris) | composition root: resume → assembly → seed → persist |
| `src/presentation/*` | proyeksi **presentasi** (bukan konteks) — nama bertabrakan |

---

## 3. Current Architecture Map

Arsitektur **nyata** (bukan diagram kanonik):

```text
cli/setup.ts  (composition root)
  identity.resolveSessionIdentity()            <- sid kanonik (+ alias)
  authority.acquireSessionWriter()             <- lease + writer_epoch
        │
        ├─ if (identity.resumed) ──► assembleContext()  ← ContextView (RAM)
        │                              └─ history_projections (P2.7)
        │                                 status != CURRENT → fallback messages
        │                                 [TIDAK ADA PENULIS PROYEKSI DI PRODUKSI]
        │
        ├─ buildSystemPrompt()  (SEKALI; MEMORY.md, AGENTS.md, repomap, RAG hits)
        └─ createMinicodeSession({ initialMessages, system, tools })
                 │
                 └─ kernel createSession() → ContextStore (BUFFER RAM)
                          │  seed: initialMessages (atau kosong)
                          │
                          └─ per turn: loop.executeTurn()
                                 model input = buildRequest(store.messages, system, tools)
                                 append assistant/tool hasil
                                 compaction bila pressure (LLM → mechanical) → store.replace
                 │
        after each turn: persistCurrent()
                 ├─ stripContextOnly(buffer) → durableHistory
                 ├─ saveSession(...)                (append-only, fenced)  ✔ jalur normal
                 └─ catch RefusedHistoryRewriteError → shrinkThreadHistory()  ⚠ destruktif
        │
        └─ presentation adapter (paralel, observation-only) → presentation_events → TUI/daemon

Thread  : hanya DEFAULT_THREAD_ID yang aktif; createThread/branchSession tidak dipakai produksi
Run     : hidup (state machine, kursor last_persisted_seq) tapi BUKAN input konteks
Journal : bukti intent/terminal → dipakai sebagai system appendix saat resume
```

Perbedaan penting dari diagram kanonik:
`Session → Thread → History → Projection → Context → Model` **tidak terjadi**.
Yang nyata: `Session → Thread(default) → messages → [ContextStore RAM] → Model`,
dengan `Projection` sebagai cabang mati dan `Run/cursor` di luar jalur konteks.

---

## 4. P3 Capability Matrix

| P3 Area | Current Status | Evidence | Owner | Risk | Reuse? | Required Work |
| --- | --- | --- | --- | --- | --- | --- |
| Context identity | MISSING | `ContextView` (`context-assembly.ts:39`) tanpa id/versi/fingerprint; grep `contextId/contextVersion/freshness` kosong di `src` (hanya `src/mcp/server.ts` tak terkait) | composition root | Tinggi (tak bisa deteksi basi) | Tidak | Definisikan identitas konteks (session, thread, watermark, event_id) |
| Context ownership (create) | IMPLEMENTED | satu pencipta: `cli/setup.ts:904` | composition root | Rendah | Ya | Pertahankan |
| Context mutation | INCORRECT | buffer kernel dimutasi `loop.ts:342 compactStore` + append; ditulis balik **bulk** `cli/setup.ts:1952-1990` | kernel + composition root | Kritis | Sebagian | Kontrak rekonsiliasi; buffer tak boleh jadi otoritas |
| Context version/freshness | MISSING | tidak ada watermark pada view; `coveredSeq` hanya cakupan ringkasan | — | Tinggi | Tidak | Versi + kesegaran eksplisit |
| History → context mapping | IMPLEMENTED (deterministik) | `assembleContext` `:133-176`: fallback = seluruh rows default thread; CURRENT = ringkasan + ekor ≥ `base_seq` | context-assembly | Sedang | Ya | Pertahankan semantik; tambah watermark & event_id |
| — event_id dalam mapping | MISSING | `ContextView.messages` bertipe vendor `Message` (tanpa `event_id`); identitas hanya di baris DB & `anchor_event_id` proyeksi | context-assembly | Sedang | — | Peta identity-preserving (paralel, bukan di tipe vendor) |
| Thread boundaries | FOUNDATION ONLY | `threads` + `createThread` (`persistence.ts:1976`) **tanpa pemanggil produksi**; guard `p2-architecture-guards.test.ts:150` melarang fork/traversal | persistence | Sedang | Ya (API) | Aktivasi + semantik baca |
| Branch read | MISSING | tidak ada API traversal; `loadThreadHistory` (`:1247`) hanya dipakai test | — | Sedang | Ya | Definisi + implementasi |
| Fork read / traversal | MISSING | `createThread(parentThreadId, forkEventSeq)` ada, tak dipakai; guard :150 menahan | — | Sedang | Ya | Semantik fork read (P3) |
| Session-level branch | FOUNDATION ONLY | `branchSession` (`:3367`) menyalin messages+turns, **tanpa pemanggil produksi** (hanya `test/session-branch.test.ts`) | persistence | Sedang | Ya | Wire atau nyatakan non-scope |
| — kompaksi vs proyeksi | MISSING | `shrinkThreadHistory` menghapus `history_projections` (`:3155`) dan tak ada yang membangun ulang | persistence | Tinggi | — | Kebijakan rebuild |
| Projection (P2.7) | FOUNDATION ONLY | `buildProjection` (`:2971`) / `rebuildProjection` (`:3003`) **tanpa pemanggil produksi**; pembaca tunggal `context-assembly.ts` | persistence | **Tinggi** | Ya | Produsen proyeksi nyata, atau pensiunkan resmi |
| Projection anchoring/validity | IMPLEMENTED | `getProjectionStatus` (`:2838`) 9 langkah; `anchor_event_id` wajib; `PROJECTION_INVALID` fail-closed | persistence | Rendah | Ya | Pertahankan |
| Lazy loading | MISSING | `loadSession`/`loadThreadHistoryWithSeq` `SELECT * ... ORDER BY seq` tanpa LIMIT (`:1212`,`:1263`) | persistence | Tinggi (sesi panjang) | — | Paging + watermark |
| Paging | MISSING | tak ada LIMIT/OFFSET/cursor baca di jalur konteks | — | Tinggi | — | API baca berjendela |
| Compaction | PARTIAL + INCORRECT | produksi aktif: `cli/setup.ts:1229` (LLM) / mechanical default (`session.ts`); hasil = `shrinkThreadHistory` (`:3037`) | composition root + kernel | Kritis | Sebagian | Kontrak kompaksi (otoritas ringkasan, provenance, arsip) |
| Budget management | PARTIAL | `budget.ts` ambang 0.75/0.9/1.0; estimator `length/4` (`policy/context.ts:16`); `--context-window` manual (`cli/index.ts:316`); **tidak ada metadata jendela per model** (grep di `src/providers` kosong) | kernel + CLI | Sedang | Ya | Resolusi limit per model + kebijakan prioritas |
| Resume | IMPLEMENTED (dengan cacat kritis) | `cli/setup.ts:887-940` + `assembleContext`; baseline kanonik disusun ulang `:1952-1990` | composition root | **Kritis** | Ya | Perbaikan rekonsiliasi (CRITICAL-1) |
| Recovery | IMPLEMENTED | `planRecoveryForSession` → system appendix (`cli/setup.ts:951-962`); UNKNOWN-first; bukti fsync (test lulus) | journal + composition root | Rendah | Ya | Tambahkan rekonsiliasi konteks pasca-crash |
| Child context | FOUNDATION ONLY | anak = Session+Thread+Run sendiri (`createChildSession :1765`), **tanpa** `initialMessages` (`tools/task.ts:407-460`, `cli/setup.ts:2123`) | tools/task + persistence | Sedang | Ya (isolasi) | Kontrak pewarisan/atenuasi/roll-up |
| Model seeding | PARTIAL | `buildSystemPrompt` sekali (`app/session.ts:93`); RAG hanya saat `prompt` non-kosong (`rag-layer.ts:61-62`) → **REPL tidak mendapat RAG** | app layer | Sedang | Sebagian | Kontrak seeding per-turn + versi prompt |
| Child result → parent | IMPLEMENTED (sempit) | hasil anak = teks tool result; tidak ada roll-up konteks (memang deferred) | tools/task | Rendah | Ya | Nyatakan eksplisit di kontrak |

---

## 5. Authority Map

**Canonical authority** (writer tunggal = `src/session/persistence.ts`; diverifikasi
oleh guard `p2-architecture-guards.test.ts:105`,`:258`,`:567`):

- `sessions` / `threads` / `messages` / `runs` — status & histori sesi
- `history_projections` — **turunan** (cache), tidak otoritatif, fail-closed
- `tasks.db` (`tasks`, `task_meta`, `session_authority`) — TaskGraph/scheduler
- `journal` (file, fsync) — bukti intent/terminal (bukan status)
- `VerificationRecord` — otoritas efek

**Derived state** (may observe, must not become authority):

| Derived | Lokasi | Konsumen | Risiko |
| --- | --- | --- | --- |
| `ContextStore` (buffer RAM) | vendor kernel | `buildRequest` → provider; sumber tulis balik kanonik | **Shadow authority de-facto** (HIGH) |
| `ContextView` | `context-assembly.ts` | seed resume | Aman (RAM, ephemeral) tapi tanpa versi |
| `history_projections` | DB | hanya `assembleContext` | Tak pernah diproduksi → mati |
| `PresentationState` | `src/presentation/*` | TUI, linear, exec, ACP, daemon | Guard memisahkan dari kanonik (P2.11) |
| `presentation_events` | DB | replay presentasi, snapshot daemon | Observasi saja |
| Ringkasan kompaksi | ditulis **ke dalam** `messages` | model | **Ringkasan menjadi kanonik** (HIGH) |
| Memori vektor (`memory` table) | `src/memory/vector.ts` | RAG → `systemExtra` | Turunan; label UNTRUSTED ada |

**Shadow authority / dual truth yang ditemukan:**

1. **Buffer RAM kernel** sebagai penentu isi kanonik (lihat CRITICAL-1). Tidak
   ada objek yang menyatakan "buffer ini turunan dari watermark W".
2. **Ringkasan kompaksi sebagai kanonik**: setelah `shrinkThreadHistory`, prefix
   asli hilang tanpa arsip; yang tersisa adalah teks ringkasan model dengan flag
   `migrated_compacted=1`. "Summary treated as canonical" — bukan hanya risiko,
   tetapi perilaku saat ini.
3. Nama **"projection"** dipakai dua arti (`history_projections` vs
   `src/presentation/projection.ts`) — bukan dual truth runtime, tetapi hazard
   kontrak (MEDIUM).

---

## 6. Data Flow Trace (level kode)

### 6.1 history → context → model

```text
cli/setup.ts:887  if (identity.resumed)
cli/setup.ts:904    view = assembleContext(sessionId, defaultThread, cwd)
                      context-assembly.ts:134 getProjectionStatus(...)
                      context-assembly.ts:135 loadThreadHistoryWithSeq(...)  (SELURUH rows)
                      status !== "CURRENT" → fallback: messages = semua rows
                      CURRENT → [syntheticSummaryMessage, ...rows seq>=base_seq]
                      boundaryIsSafe() menolak potongan yang memisahkan tool-call/result
cli/setup.ts:905    initialMessages = view.messages
cli/setup.ts:1309   createMinicodeSession({ ...initialMessages })
app/session.ts:100  system = buildSystemPrompt(...)   ← sekali, statis
vendor/session.ts:165 store.appendAll(initialMessages)
vendor/loop.ts:261  buildRequest(): messages = snapshotMessages(store.messages), system, tools
```

Konsekuensi: **isi konteks = buffer RAM**, bukan hasil query kanonik per turn.
Tidak ada jalur yang membaca ulang kanonik di tengah sesi.

### 6.2 thread/branch → context

Tidak ada jalur. `assembleContext` selalu `defaultThread.thread_id`
(`cli/setup.ts:904`), dan tidak ada pembaca traversal. `createThread`,
`parent_thread_id`, `fork_event_seq` hanya ada di skema + test
(`test/thread-activation.test.ts`).

### 6.3 resume → context

```text
admission (authority.ts) → tombstone run yatim → ensureDefaultThread + backfill event_id
→ prev = loadSession(sessionId)            (SELECT * seluruh messages, :1212)
→ view = assembleContext(...)              (SELECT * seluruh messages LAGI, :1263)
→ recovery plan dari jurnal → system appendix
→ presentation rebuild (presentation_events) → watershed provenance
→ seed kernel
→ turn...
→ persistCurrent: stripContextOnly → saveSession | shrinkThreadHistory
```

Dua pembacaan penuh per resume (baseline + assembly) — inefisiensi, bukan
inkorrektsi.

### 6.4 parent → child context

```text
tools/task.ts:333  createChildSession({ parentSessionId, parentRunId, childSessionId })
tools/task.ts:407  factory({ provider, tools, cwd, permissionMode, maxSteps,
                              timeoutMs, systemExtra: [sub-agent rule, "Parent task (DATA)"], journal })
tools/task.ts:488  runChild = () => session.run(prompt, { signal })
```

Anak **tidak menerima `initialMessages`** → konteks anak = prompt tugas saja;
system anak dibangun ulang dari cwd (MEMORY.md/AGENTS.md/repomap ikut terbaca
ulang). Tidak ada pewarisan konteks, tidak ada atenuasi terstruktur (hanya teks
systemExtra), tidak ada roll-up hasil selain teks tool result.

---

## 7. Existing Context Components

| Komponen | Lokasi | Tanggung jawab | Owner | Siklus hidup | Otoritas | Persistensi | Dependensi | Rekomendasi |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ContextStore` (buffer) | `vendor/.../history.ts` | buffer pesan kernel | kernel | per proses; turnStore transaksional | de-facto otoritas | tidak | — | **Pertahankan, kurangi wewenang** (jangan jadi sumber tulis kanonik) |
| `buildRequest` | `vendor/.../loop.ts:261` | perakitan input model | kernel | per step | konsumen | tidak | buffer+system+tools | Pertahankan |
| `ContextView` / `assembleContext` | `src/session/context-assembly.ts` | perakitan baca-saja saat resume | composition root | per resume | turunan | tidak (RAM) | persistence (API baca) | **Reuse**, perluas (watermark, identitas, paging) |
| `stripContextOnly` | sama `:115` | mencegah artefak turunan masuk kanonik | composition root | per persist | pencegah | — | — | Pertahankan |
| `history_projections` + `buildProjection`/`getProjectionStatus` | `persistence.ts:2702-3030` | proyeksi ringkasan berjangkar | persistence | durable | turunan, fail-closed | ya (cache) | messages | **Perlu produsen atau pensiun resmi** |
| `buildSystemPrompt` | `src/policy/context.ts:37` | seeding system (MEMORY, AGENTS, repomap, extra) | app layer | sekali per sesi | turunan statis | tidak | fs repo + git | Reuse + beri versi/fingerprint |
| `createRagLayer` | `src/app/rag-layer.ts:36` | retrieval memori → `systemExtra` | app layer | sekali per sesi (butuh prompt) | turunan | tulis `access_count` | provider embedding, `memory` DB | **Perbaiki**: kebijakan per-turn eksplisit |
| `createLlmCompaction`/`compactWithLlm` | `src/policy/compaction.ts:42,225` | ringkasan prefix → menggantikan buffer | composition root | per pressure/length | **menulis kanonik** (via shrink) | ya (ke messages) | provider, memori vektor | **Rancang ulang kontraknya** |
| Memori (`addMemory`, `searchHybrid`) | `src/memory/vector.ts` | memori persisten lintas sesi | memory layer | durable | turunan | ya (`memory` DB) | embedding | Pertahankan, nyatakan relasi ke konteks |
| `PresentationState` + `projection.ts` | `src/presentation/*` | proyeksi tampilan | presentation | durable-replayable | observasi | ya (`presentation_events`) | events | Pertahankan (jangan dicampur dengan konteks) |
| `expandMentions` | `src/app/mentions.ts` | `@file` → isi prompt user | TUI | per prompt | kanonik (bagian pesan user) | ya (ikut messages) | fs | Pertahankan; catat bahwa hanya jalur TUI |
| `autonomous-context` instruction | `src/task/autonomous-context.ts:369` | seeding prompt anak otonom | scheduler | per eksekusi | kanonik anak | ya (anak) | task store | Pertahankan |

---

## 8. P2 Invariant Validation

| Invariant | Status | Bukti |
| --- | --- | --- |
| Session ≠ Thread ≠ Run | PASS | kolom & API terpisah (`persistence.ts:271-273`); `p2-identity.test.ts`, `p2-baseline-invariants.test.ts` lulus |
| writer_epoch = mutation fence (CAS in-txn) | PASS | `assertWriterEpochInTxn` dipakai di `saveSession`/`shrinkThreadHistory`/`buildProjection`; guard `:224`,`:244`,`:267` lulus |
| last_persisted_seq = watermark ≠ ownership | PASS | `advanceRunCursor` menolak rewind (`:2593`); konteks eksplisit **tidak** membacanya (`context-assembly.ts:13`); test kursor A/B/C lulus |
| messages = canonical history, append-only + shrink eksplisit berprovenance | **FAIL** | `saveSession` menolak rewrite (`:1005`) — benar; tetapi `persistCurrent` men-`catch` lalu memanggil `shrinkThreadHistory` untuk **kesalahan apa pun** dari kelas itu (`cli/setup.ts:1976-1990`), dan jalur itu **terjangkau tanpa niat shrink** (CRITICAL-1) |
| journal = intent/terminal evidence (fsync, UNKNOWN-first) | PASS | `p2-durability-forensic.test.ts` 4/4 lulus (SIGKILL, torn tail) |
| VerificationRecord = otoritas efek (intent ≠ effect) | PASS | guard `p2-architecture-guards.test.ts:697-874` lulus |
| history_projections = turunan, fail-closed, tak otoritatif | PASS (invariant) / FOUNDATION ONLY (kapabilitas) | `getProjectionStatus` 9 aturan; pembaca tunggal; **tanpa penulis produksi** |
| ContextView = ephemeral (RAM, fallback kanonik) | PASS | guard `:1010` ("cannot be persisted"), `:486` (baca-saja); 33 test di `context-assembly.test.ts` lulus |
| child Session = entitas independen | PASS | `createChildSession :1765`; guard `:324`,`:613` lulus |
| presentation_events = observation-only | PASS | guard `:915`,`:934`,`:953`,`:983`,`:1000`,`:1119` lulus |
| UNKNOWN ≠ success | PASS | guard `:865`,`:1078`; `run/recovery_status` |
| consumer ≠ writer; cursor ≠ ownership | PASS | `consumer_offsets` + `p2-daemon-guards.test.ts` (tidak dijalankan sesi ini — lihat §11) |
| daemon ≠ canonical truth | PASS (kode) | snapshot = presentation + frontiers saja (`daemon/protocol.ts:155`) |
| satu arsitektur penghapusan | UNPROVEN (sesi ini) | `deleteSessionCompletely` (`persistence.ts:3209`, satu-satunya jalur; `deleteSession :3281`); test tidak dijalankan di audit ini |

---

## 9. Architectural Debt

### Blocking P3

- **CRITICAL-1 — Penghancuran histori kanonik implisit (terbukti end-to-end).**
  `--session <id>` untuk id yang sudah punya histori (tanpa `--resume`) memulai
  buffer kosong; `persistCurrent` lalu men-`catch RefusedHistoryRewriteError`
  dan meng-`shrinkThreadHistory` buffer baru sehingga **seluruh histori lama
  diganti**. Probe CLI nyata (provider fake, workspace temp):
  sebelum = 6 baris (TURN-ONE…), sesudah turn berikutnya = 2 baris
  (`TURN-TWO`, `balasan`), baris 0 bertanda `migrated_compacted=1`; **tanpa
  arsip, tanpa peringatan**. Situs:  `cli/setup.ts:1944-1990`,
  `persistence.ts:1019`, `:3037-3160`.
  Nuansa jujur: "mulai bersih di bawah id lama" bisa jadi **maksud** flag
  `--session` (pesan `SessionNotFoundError` menyebut "start fresh") — tetapi
  mekanismenya adalah shrink implisit yang menghapus histori lama secara senyap,
  jadi kontrak yang harus diputuskan bukan "apakah fitur ini ada" melainkan
  "apakah reuse id boleh berarti penghapusan, dan dengan bukti apa".
- **CRITICAL-2 — Proyeksi konteks tidak pernah diproduksi.** `buildProjection`
  hanya dipanggil test; `shrinkThreadHistory` menghapus proyeksi dan tak ada
  yang membangun ulang. Semua asumsi "proyeksi CURRENT tersedia" (termasuk di
  `P2_CLOSURE_HANDOFF.md`) **tidak berlaku di produksi**; yang berjalan hanyalah
  fallback histori penuh.
- **HIGH-1 — Ringkasan kompaksi menjadi kanonik tanpa arsip.** `migrated_compacted=1`
  adalah satu-satunya provenance; teks asli hilang permanen. Melanggar semangat
  "derived tidak boleh menjadi otoritas": ringkasan model kini **satu-satunya**
  representasi prefix itu.
- **HIGH-2 — Buffer RAM = otoritas de-facto.** Tak ada identitas/watermark; tak
  ada rekonsiliasi dengan kanonik sebelum tulis.
- **HIGH-3 — Baseline gate merah** (lihat §11): `tsc --noEmit` 28 error (10
  berkas test `phase3*`/`phase4*`), `gate:pack` 21/23. AGENTS.md mensyaratkan
  gate hijau; P3 tidak bisa "menutup" pekerjaan di atas baseline merah.

### Non-blocking P3

- MEDIUM-1: Nama "projection" ganda (`history_projections` vs
  `src/presentation/projection.ts`) dan nama "context" ganda
  (`src/policy/context.ts` = system prompt; `src/session/context-assembly.ts` =
  konteks).
- MEDIUM-2: RAG hanya aktif bila `prompt` awal non-kosong (`rag-layer.ts:61-62`)
  → sesi interaktif tidak pernah mendapat injeksi memori; jalur one-shot
  mendapatkannya. Konteks model berbeda untuk state yang sama.
- MEDIUM-3: `loadSession` + `assembleContext` membaca seluruh `messages` dua
  kali per resume; tidak ada paging.
- MEDIUM-4: Batas jendela konteks tidak berasal dari model (hanya
  `--context-window`, default 128k) → budget bisa salah untuk model berjendela
  kecil/besar.
- LOW-1: Komentar rusak (encoding) di `src/session/context-assembly.ts:50`
  (`dipROID`) dan `:93` (`di的和ismegasikan`) — melanggar kebijakan komentar
  bersih repo.
- LOW-2: `loadThreadHistory` (`:1247`) tidak punya pemanggil produksi (hanya
  test) — API mati.

### Future cleanup

- `branchSession` tanpa CLI/UX (P13 P1) — perlu keputusan produk (wire atau
  nyatakan non-scope).
- `.tmp-extreme-*`/`nonexistent-dir-xyz` di root (sudah tercatat di handoff P2).
- Label "P2.x" ganda di CHANGELOG; tidak ada laporan P2.1–P2.9 berdiri sendiri.

---

## 10. Missing Contracts (yang harus didefinisikan P3)

1. **Kontrak identitas konteks**: `(session_id, thread_id, watermark)` +
   provenance sumber (messages vs proyeksi), dan aturan bahwa dua konteks
   dengan identitas sama wajib ekuivalen.
2. **Kontrak otoritas buffer**: buffer RAM tidak pernah menjadi sumber kebenaran
   isi kanonik; tulis kanonik hanya boleh append dari watermark, dan
   ketidakcocokan = **refuse + reconcile**, bukan shrink.
3. **Kontrak rekonsiliasi** (inti P3): apa yang terjadi bila buffer ⊄ kanonik
   (reuse id, penulis lain, cabang, kompaksi): pilih ulang sumber, jangan
   menimpa.
4. **Kontrak kompaksi**: siapa yang boleh meringkas, apakah ringkasan boleh
   kanonik, apa yang diarsipkan, bagaimana provenance dibaca konsumen.
5. **Kontrak proyeksi**: produsen, pemicu, kebijakan rebuild, dan hubungan
   eksplisit dengan `history_projections` (atau pensiun resmi).
6. **Kontrak thread/branch read**: arti `fork_event_seq`, batas isolasi, dan
   bagaimana konteks direkonstruksi setelah fork.
7. **Kontrak paging/lazy**: jendela baca + cursor, dan perilaku fallback.
8. **Kontrak seeding model**: versi system prompt, kebijakan RAG per turn,
   determinisme lintas jalur (one-shot vs REPL vs exec vs ACP).
9. **Kontrak child context**: pewarisan, atenuasi, dan jalur hasil (roll-up
   dinyatakan defer atau masuk scope).
10. **Kontrak UNKNOWN konteks**: definisi "konteks basi/tak dapat dibuktikan"
    dan representasinya (tidak boleh dirender sebagai sukses).

---

## 11. Tests / Evidence

| Perintah | Hasil |
| --- | --- |
| `bun test test/context-assembly.test.ts test/projection-foundation.test.ts test/p2-history-projection.test.ts test/p2-thread.test.ts test/thread-activation.test.ts test/session-branch.test.ts test/context-audit.test.ts` | **90 pass / 0 fail** (7 berkas, 5,92 s, 347 expect) |
| `bun test test/p2-architecture-guards.test.ts test/p2-baseline-invariants.test.ts test/p2-durability-forensic.test.ts test/p2-run-cursor.test.ts test/p2-identity.test.ts test/p2-presentation.test.ts` | **120 pass / 0 fail** (3,55 s, 2.186 expect) |
| `bun x tsc --noEmit` | **exit 1**, 28 error, 10 berkas — semuanya di `test/phase4a1|4a3|4a4|4a4a|4a5|4b|4b1`, `test/phase3a|3b|3c` |
| `bun run gate:pack` | **exit 1**, `pass 21 · fail 2` (graf import `src/task/graph.ts` extensionless; ukuran 3960 KB > 2,25 MiB) |
| `bun test` (seluruh suite) | **TIDAK SELESAI** — dihentikan pada batas 600 s (masih hijau pada titik itu; ada test scheduler berdurasi ~62 s). Bukan bukti hijau penuh. |
| Probe A (persistence, sementara) | `saveSession` → `RefusedHistoryRewriteError`; `shrinkThreadHistory` → `oldHead=5 → newHead=1`, histori 6 → 2 baris |
| Probe B (CLI nyata + `test/helpers/fake-provider.ts`, dua run, `--session` sama tanpa `--resume`) | run1 `code 0`; run2 `code 0`; baris kanonik akhir = 2 (`TURN-TWO`, `balasan`), baris 0 `migrated_compacted=1` → **TURN-ONE hilang** |
| Grep kepemilikan (bukti "tanpa pemanggil produksi") | `buildProjection`/`rebuildProjection`, `createThread(`, `branchSession`, `loadThreadHistory(`, `FROM messages` → hanya `persistence.ts` + test |

Klasifikasi bukti per klaim penting:

| Klaim | Penilaian |
| --- | --- |
| Konteks dirakit baca-saja & fail-closed saat resume | PROVEN BY TEST (`context-assembly.test.ts`) |
| Artefak context-only tak bocor ke kanonik | PROVEN BY TEST (`context-assembly.test.ts` FOR-1/FOR-2 + guard `:423`) |
| Proyeksi berjangkar & validitas deterministik | PROVEN BY TEST (`projection-foundation.test.ts` 21 test + migrasi) |
| Proyeksi dipakai produksi | **CONTRADICTED BY EVIDENCE** (tanpa penulis produksi) |
| Kompaksi mempertahankan histori asli | **CONTRADICTED** (probe: prefix hilang, tanpa arsip) |
| Jalur `--session` reuse aman | **CONTRADICTED** (probe B) |
| Thread/branch traversal tersedia | CONTRADICTED (API ada, kapabilitas tidak) |
| Scheduler tidak terkoppel ke konteks | PARTIALLY PROVEN (grep: tak ada referensi konteks di `src/task`,`src/runtime`,`src/agents`) |
| UNKNOWN-first pada semua mesin status | PROVEN BY TEST (subset P2 yang dijalankan) |

---

## 12. Recommended P3 Work Breakdown

Hanya milestone yang didukung temuan di atas. Urutan ini mengikat: P3.0–P3.2
adalah **perbaikan**, bukan fitur baru.

- **P3.0 — Contract Definition (identitas, otoritas, rekonsiliasi).**
  Tetapkan §10 butir 1–4 sebagai kontrak tertulis + test peta. Tanpa ini
  milestone berikutnya tak punya definisi benar/salah.
- **P3.1 — Reconciliation Guard (perbaikan CRITICAL-1/2, HIGH-1/2).**
  Buffer tidak boleh ditulis sebagai kanonik bila bukan ekstensi-append dari
  watermark; `--session` reuse harus eksplisit (tolak atau nyatakan "mulai
  bersih" + arsipkan), dan ringkasan kompaksi tidak boleh menghancurkan prefix
  tanpa arsip. Bukti: probe A/B dijadikan test regresi yang gagal di HEAD.
- **P3.2 — Context Identity + Freshness.**
  Watermark/versi pada `ContextView` dan pada setiap hasil perakitan; deteksi
  basi eksplisit; UNKNOWN sebagai kelas pertama.
- **P3.3 — History → Context Projection (produksi).**
  Putuskan: (a) bangun produsen proyeksi (`buildProjection`) dengan pemicu &
  kebijakan rebuild, atau (b) pensiunkan P2.7 sebagai kapabilitas dan jadikan
  perakitan resume satu-satunya jalur. Salah satu wajib dipilih; "dua-duanya
  setengah" adalah status sekarang.
- **P3.4 — Resume/Recovery Reconciliation.**
  Determinisme resume (termasuk jalur id yang dipakai ulang), urutan
  assembly → recovery appendix → seed, dan test crash/restart yang mengukur
  isi konteks, bukan hanya exit code.
- **P3.5 — Compaction Contract.**
  Otoritas ringkasan, provenance yang dapat dibaca, kebijakan arsip/rebuild,
  hubungan ke proyeksi.
- **P3.6 — Bounded Reads (Paging/Lazy).**
  API baca berjendela + cursor; hilangkan dua pembacaan penuh per resume.
- **P3.7 — Branch/Fork Read Semantics.**
  Definisi traversal (`parent_thread_id`, `fork_event_seq`), isolasi, dan
  rekonstruksi konteks setelah fork; guard `:150` harus diperbarui **karena
  kode berubah**, bukan dilonggarkan.
- **P3.8 — Child Context Contract.**
  Pewarisan/atenuasi/isolasi eksplisit + jalur hasil; roll-up tetap defer
  kecuali diminta.
- **P3.9 — Model Seeding Determinism.**
  Versi/fingerprint system prompt; kebijakan RAG per turn yang berlaku sama di
  semua jalur masuk; resolusi jendela konteks per model.
- **P3.10 — Gate Hygiene (prasyarat penutupan).**
  Kembalikan `tsc` + `gate:pack` hijau sebelum P3 dinyatakan selesai (debt
  HIGH-3 hari ini akan menutupi regresi P3).

---

## 13. P3 Entry Verdict

**NOT READY — ARCHITECTURAL REPAIR REQUIRED**

Alasannya, dengan urutan kepentingan:

1. Ada **pelanggaran invariant P2 yang nyata dan terukur** (bukan dokumentasi):
   histori kanonik dapat dihancurkan oleh turn biasa lewat `--session` reuse,
   tanpa niat shrink, tanpa arsip, tanpa pemberitahuan (probe B). Ini satu-
   satunya alasan yang cukup untuk menahan implementasi fitur P3.
2. Fondasi yang diasumsikan P3 ("history_projections = context projection")
   **tidak berjalan di produksi**; membangun di atasnya tanpa koreksi akan
   menghasilkan P3 yang hijau di test dan mati di runtime.
3. Ringkasan kompaksi sudah menjadi kanonik tanpa arsip — aturan "derived tidak
   boleh menjadi otoritas" sudah dilanggar pada satu jalur.

Perbaikan yang diperlukan **sempit dan terlokalisasi** (satu batas rekonsiliasi
+ kebijakan proyeksi/kompaksi), sehingga **kontrak P3.0 boleh mulai paralel**.
Yang tidak boleh dilakukan: memulai P3.3+ (proyeksi, paging, branch traversal)
sebelum P3.1 selesai, karena setiap milestone itu menulis/membaca batas yang
saat ini belum aman.
