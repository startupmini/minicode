# MINICODE — Agent Presentation Architecture V2.1
## Stress-Test Correction & Final Architecture Review (architecture only — no implementation)

> Sumber: repo aktual + `AGENT_PRESENTATION_ARCHITECTURE_V2.md` (diperlakukan sebagai hipotesis).
> Setiap koreksi diverifikasi terhadap kode; status `CONFIRMED / PARTIALLY CONFIRMED / INCORRECT / REFINED` eksplisit di §2.

---

## 1. Executive Verdict

**V2 arahnya benar (satu `reduce`, banyak proyeksi; renderer jangan disentuh), tetapi belum bisa menjadi kontrak implementasi.** Lima lubang yang terbukti dari kode:

1. **Retry tak terdefinisi.** Kernel tidak punya retry tool-level sama sekali: retry hanya ada di sampling provider (`loop.ts:96-192`: `text/toolCalls` di-reset per attempt, counter `attempt` internal, tidak di-emit). Retry tool oleh model = `toolCall` baru dengan id baru dari provider. V2 memberi `toolCallId` tanpa menjawab "attempt apa", sehingga durasi/receipt/replay untuk retry tak terdefinisi.
2. **Approval bisa macet semantik.** V2 punya `requested/resolved` tetapi kode membuktikan 6 jalan keluar approval (`permission.ts:521-538` + `prompt.ts:89-107`): allow / deny / always / aborted→deny / no-TTY→deny / no-ask→deny — plus pembatalan turn saat prompt menggantung (`raceAbort`, `permission.ts:510-519`). Tanpa terminal state `cancelled/expired` + aturan force-close, reducer bisa selamanya melihat `approval = pending` setelah parent selesai.
3. **Sub-agent sudah ada tetapi tak termodelkan.** `delegate_task` (`task.ts:164-352`) sudah: child session `sub_xxxxxxxx` (`:227`), journal parent↔anak (`:228-234`, `{sessionId: childId, parentSessionId}` di `:283`), forward event anak→parent dengan tag `forwardedChild` (`:287-316`), pool 3, amputasi kapabilitas. V2 tidak menjawab bagaimana event anak dikorelasikan ke parent — implementasi tanpa ini akan menggandakan ledger atau kehilangan atribusi.
4. **`eventSeq` dicampuradukkan dengan kausalitas; durable vs live tidak dipisah.** V2 menaruh semua event di satu bus tanpa kebijakan mana yang durable. Fakta kode: durable sudah ada (sqlite messages/turns, journal intent/terminal, checkpoint tree, `step-traces.jsonl`, `turn-marker` liveness) dan live sudah ada (delta teks, spinner, buffer). Tanpa pemisahan, restart tak bisa merekonstruksi state bermakna tanpa replay token-per-token, dan `ContentStore` berisiko jadi memory dump (dua buffer global divergen sudah ada buktinya: `collapse.ts:24-25` 200K/500K vs `transcript.ts:19-21` 10×2000).
5. **Identitas tool rapuh.** Origin MCP disimpulkan dengan `name.includes(".")` di 4+ tempat (`permission.ts:204`, `journal.ts:133,1113,1165,1187`, `tool-layer.ts:42`). V2 tidak memperbaikinya — renderer masa depan akan kembali mem-parse string.

**V2.1 di bawah menutup kelimanya dengan mekanisme minimal** (tanpa ID berlebihan, tanpa framework): retry = `toolCall` baru + link `supersedes` (tanpa `attemptId`); approval = `requested/settled{outcome}` + force-close; sub-agent = `sessionId` chain + `parentToolCallId` eksplisit (tanpa `runId/agentId`); event dibagi durable/live dengan tabel kebijakan; `ContentStore` dipisah dari model sebagai sibling non-otoritatif; `ToolIdentity{origin,namespace,name}` di-parse sekali di adaptor.

---

## 2. V2 Review / Corrections

| Klaim V2 | Status | Alasan / bukti |
|---|---|---|
| Masalah utama di presentation/event, bukan renderer | CONFIRMED | Diverifikasi ulang: deny diam (`executor.ts:44,58-73`), abort diam (`session.ts:240-248`), `finish` hilang (`loop.ts:129-134`), ID dibuang (`contract.ts:23-26`), `extension` dibuang TUI (`transcript.ts:109`). Renderer hijau di semua race + PTY. |
| `turn:completed` hanya sukses | CONFIRMED | `session.ts:248` pasca-`withAbort`; kompensasi driver (`turn-status.ts:25-28`, `simple.ts:609-626`) adalah bukti, bukan solusi. |
| Deny/validate/unknown tanpa event | CONFIRMED | Tetapi REFINED: `step:completed` membawa `results` penuh (`loop.ts:241-248`) → adaptor bisa merekonstruksi `tool.denied` dari `permission denied` **tanpa ubah kernel**. |
| `turn.result` diabaikan | CONFIRMED | `simple.ts:305-319`, `transcript.ts:82-85`, `contract.ts:35`. Sumber `model.completed` V2.1. |
| Sanitasi dua waktu | CONFIRMED | `simple.ts:336` (saat stream) vs `transcript.ts:99-105,244-249` (pending mentah). V2.1: sekali di ingestion. |
| Cap thinking divergen | CONFIRMED | `simple.ts:153-154,387-399` vs `transcript.ts:121` vs `collapse.ts:24-25`. V2.1: store tunggal + §14. |
| Transkrip campur 3 konsep | PARTIALLY CONFIRMED | Split stdout/stderr (I2) masih dijaga di linear (`wOut/wErr`), hanya hilang di viewport TUI. V2.1 pertahankan asal-stream di model. |
| Compact-only = akar masalah | INCORRECT (sebagai akar) | Compact sah sebagai proyeksi; akarnya: tidak ada store queryable. Dikoreksi di §14. |
| `toolCallId` cukup untuk identitas | REFINED → §4 | Tidak menjawab retry, sub-agent, MCP origin. V2.1: `toolCallId` tetap stabil per call; tambah `supersedes`, `parentToolCallId`, `ToolIdentity`. Tanpa `attemptId/executionId/runId/agentId` (ditolak eksplisit, §4–§6). |
| `approval.requested/resolved` cukup | REFINED → §5 | Kurang `cancelled/expired`, force-close, headless-audit. V2.1: `requested/settled{outcome}`. |
| Satu PresentationModel berisi ContentStore | REFINED → §7/§14 | Store di dalam model menjadikannya God Object + memory dump. V2.1: sibling terpisah, non-otoritatif. |
| `eventSeq` monotonik per sesi | REFINED → §8 | Benar sebagai ordering observasi, tetapi V2 tidak memisahkan ordering/korelasi/kausalitas/hierarki. V2.1 mendefinisikan keempatnya terpisah. |
| 9 kelas failure | REFINED → §16 | Diganti: 5 status outcome + cause enum (lebih sedikit, mencakup `interrupted` yang hilang di V2). |
| Receipt dari journal/checkpoint cukup | CONFIRMED | `journal.ts:29-80` (seq, paths, argsHash, childSessionId) + `setup.ts:439-463` (checkpoint) + `turn-marker.ts` (liveness) memang cukup — tanpa FS tracking baru. V2.1 jadikan derived view + ref (§17). |
| Adaptor tanpa ubah kernel cukup Fase 1–5 | CONFIRMED | Diperkuat temuan: semua data yang dibutuhkan sudah di wire/file. Seam kernel hanya bila `tool.progress` sukarela dibutuhkan (aditif). |

---

## 3. Stress-Test Findings (ringkas — detail di §4–§14)

1. **Retry:** tidak ada retry tool di kernel (hanya retry sampling provider, internal, tak di-emit). Retry model-level = call baru. Keputusan: tanpa ID baru; link `supersedes`.
2. **Approval:** 6 jalan keluar di kode, 2 di V2. Keputusan: outcome enum + force-close invariant (I-A08).
3. **Sub-agent:** mekanisme ada (child session + forward + tag), model tidak ada. Keputusan: chain `sessionId/parentSessionId` + `parentToolCallId` eksplisit di event forward.
4. **Durable/live:** keduanya sudah ada sebagai file vs buffer, tetapi tanpa kebijakan. Keputusan: tabel §7; restart tanpa delta.
5. **Store:** dua buffer global divergen + reset-per-turn + sekali-habis. Keputusan: sibling store, ref-based, replay tanpa payload.
6. **Sequencing:** paralel executor (`policy/executor.ts:70-85,87+`: campuran write+read → sekuensial; murni → worker-pool + write-slot + per-file lock, hasil di `results[i]` terurut) membuktikan arrival ≠ completion order. Keputusan: `eventSeq` = observasi; korelasi = ID; kausalitas = link eksplisit.
7. **MCP:** `includes(".")` tersebar. Keputusan: `ToolIdentity` di-parse sekali.
8. **Streaming:** `pending` TUI tak ber-cap (`transcript.ts:99-104`) vs `/copy` cap 200K (`simple.ts:48-60`). Keputusan: stream buffer ber-cap + `ConversationEntry` final-only.
9. **Compaction:** `compactStore` (`loop.ts:342-355`) hanya menyentuh `ContextStore`; transkrip tak tersentuh — boundary sudah benar secara de facto, belum dinyatakan. Keputusan: invariant eksplisit.
10. **Crash:** journal `pending`-tanpa-terminal + `decideRecovery` (`journal.ts:812-1021`) + `turn-marker` liveness + checkpoint reconcile sudah ada. Yang hilang: status `interrupted` di presentasi (sekarang hanya direktif teks `[recovery]`). Keputusan: §12.

---

## 4. Retry / Attempt Model

**Keputusan: TIDAK ada `attemptId`, TIDAK ada `executionId`.** Alasan dari kode:

- Attempt yang ada (counter `attempt`, `loop.ts:91,97-103`) adalah **sampling provider** (retry stream / compact-and-retry), internal satu step, me-reset `text/toolCalls`, **tidak menghasilkan observasi tool**. Mengeksposnya sebagai event = noise tanpa konsumen (tidak ada proyeksi butuh "sampling ke-2 gagal").
- Retry yang bermakna (model memanggil tool yang sama lagi setelah gagal) selalu lahir sebagai `tool_call` baru dari provider dengan **`id` baru** (`loop.ts:129-131` push per event; `pairToolResults` match by id). Identitas stabil = per call; yang berubah = id baru.
- Durasi per attempt terukur dari `started→completed` masing-masing call (pola `toolStarts` map by `call.id` sudah ada di `setup.ts:470-480` — dipindah ke adaptor sebagai data event, bukan `Date.now` di reducer).

```ts
// Retry = hubungan, bukan identitas baru.
interface ToolStarted {
  type: "tool.started";
  toolCallId: string;            // stabil PER CALL (dari provider, diteruskan — dilarang dibuang)
  turnId: number; stepId: number;
  identity: ToolIdentity;        // §9
  argsSummary: ArgsSummary;
  supersedes?: string;           // toolCallId sebelumnya yang digantikan (diisi reducer bila
                                 // call ini: nama+target sama + call lama terminal-failed
                                 // dalam turn yang sama). DERIVED, bukan dari runtime.
}
```

| Pertanyaan | Jawaban |
|---|---|
| Retry = call baru? | Ya. Setiap `tool_call` provider = `toolCallId` baru, lifecycle penuh sendiri. |
| Retry = attempt lain? | Sampling-retry provider = internal, bukan event. Tidak dimodelkan. |
| Identitas stabil? | `toolCallId` per call; rantai retry dibaca via `supersedes`. |
| Identitas berubah? | Hanya id baru per call; tidak ada counter attempt. |
| Event attempt? | Tidak ada. |
| Tampil retry? | Baris baru per call + label `↻ retry of › name target` (derived, proyeksi). Call lama tetap (status finalnya tidak diubah). |
| Replay retry? | Urutan `eventSeq`; tiap call direduksi independen; `supersedes` dihitung ulang deterministik → identik. |
| Durasi? | Per call (`tsEnd-tsStart` dari event). Agregat retry = derived (jumlahkan rantai). |
| Receipt sukses? | `tool.completed` call pemenang membawa `receipt` + `supersedes` menunjuk yang gagal. |

Edge: dua call paralel nama+target sama lalu satu gagal satu sukses → `supersedes` ambigu. Aturan: hanya tautkan bila call lama sudah terminal **sebelum** call baru `started` (berdasarkan `eventSeq`), dan pilih yang terminal terakhir. Paralel yang tumpang-tindih = tidak ditautkan (keduanya mandiri). Aturan ini murni dari event → replay-safe.

---

## 5. Approval Lifecycle

Verifikasi kode — 6 jalan keluar, V2 hanya 2:

| Jalan di kode | Lokasi | Outcome V2.1 |
|---|---|---|
| user `y` | `prompt.ts:89-95` allow | `settled{allow, user}` |
| user `a` → saveAlways | `prompt.ts:91-94`, `permission.ts:533-536` | `settled{allow-always, user}` (+ efek allowlist, di luar event) |
| user `n`/lain/Esc/Ctrl+C→null | `prompt.ts:95,143`, `permission.ts:537` (`deny(call,"declined by user")`) | `settled{deny, user}` |
| abort saat prompt menggantung | `raceAbort` → `"aborted"` → deny (`permission.ts:510-538`) | `settled{cancelled(parent-aborted), system}` |
| non-TTY / tanpa `ask` | `promptAsk:25,30`, `promptAskOr:527-528`, fail-closed | `requested{via:system} → settled{deny(headless), system}` — TETAP di-emit (audit, bukan diam) |
| allowlist-hit (tanpa prompt) | `permission.ts:530` return allow | **Bukan approval** — tidak emit (keputusan policy, bukan persetujuan). Tercatat di trace bila perlu. |

```ts
type ApprovalOutcome =
  | { decision: "allow"; by: "user" | "system" }
  | { decision: "allow-always"; by: "user" }       // + efek samping allowlist (di luar model)
  | { decision: "deny"; by: "user" | "system"; reason?: "declined" | "headless" | "no-ask" }
  | { decision: "cancelled"; by: "system"; reason: "parent-aborted" | "parent-ended" | "timeout" | "renderer-failure" };

interface ApprovalRequested { type: "approval.requested"; approvalId: string;
  toolCallId: string; turnId: number; identity: ToolIdentity; argsSummary: ArgsSummary;
  via: "prompt" | "system"; }                      // via:system = headless auto-deny (audit)
interface ApprovalSettled { type: "approval.settled"; approvalId: string;
  toolCallId: string; turnId: number; outcome: ApprovalOutcome; }
```

- **Satu event terminal** (`settled`), bukan `resolved` + `cancelled` terpisah — outcome enum cukup (status transition dalam satu tipe terminal).
- **Stale approval:** `raceAbort` sudah menutup balapan late-`[y]`-setelah-Ctrl+C di runtime. Di model: invariant **I-A08** — saat turn settle (`completed/failed/cancelled`), reducer menutup semua approval terbuka turn itu sebagai `settled{cancelled(parent-ended)}`. Runtime tak pernah macet; model tak pernah macet.
- **Renderer failure saat pending:** `askLine` menggantung → turn tak settle → approval tetap `requested` (benar: operasi memang belum berakhir). Bila proses crash → §12 (`interrupted`). Bila ACP/TUI disconnect tetapi proses hidup → approval tetap menunggu user di kanal lain atau dibatalkan operator via abort (→ `cancelled(parent-aborted)`). Tidak ada auto-deny diam-diam selain `headless` yang eksplisit.
- **Timeout:** turn timeout (`session.ts:31,291-303`, default 10 mnt) meng-abort signal → jalur `raceAbort` → `cancelled(timeout)`. Tidak perlu timer khusus approval.
- Relasi: `approvalId` dibuat `promptAskOr` (pemilik: permission/app-layer, hidup: request→settle, tak dipakai ulang); `toolCallId` = call yang digate; `turnId` = turn pemilik. `always` tidak memperpanjang hidup approval — efeknya di allowlist store, di luar model.

---

## 6. Agent / Sub-Agent Hierarchy

Fakta kode: hierarki de facto sudah ada — parent intent `delegate_task{childSessionId}` (`task.ts:228-234`), child journal `{sessionId: childId, parentSessionId}` (`:283`), forward `provider:extension` mentah + `execution:*` ber-tag (`:298-316`), efek anak = jurnal anak (`:236-237,330-336`), isolasi (tanpa nesting/MCP/commit/memory/job, `:189-221`), `forcedExplore` (`:174-175`), pool 3. Yang hilang hanya **korelasi eksplisit di event**.

```text
Session (sessionId; root: "main"/todoSession.id; child: "sub_xxxxxxxx")
 └── Turn (turnId; scope satu session.run — "run" = turn, TIDAK perlu runId)
      └── Step (stepId = index; grup paralel)
           └── ToolCall (toolCallId; untuk delegate_task → menunjuk child Session)
                    └── Child Session (sessionId, parentSessionId, parentToolCallId, parentTurnId)
                         └── Turn… (milik anak; numbering sendiri per session)
```

**Ditolak eksplisit:** `runId` (redundan dengan `(sessionId, turnId)` — satu `run()` = satu turn, `session.ts:215-256`), `agentId` (redundan dengan `sessionId` — sesi anak = agen anak).

```ts
interface ChildSessionLink { parentSessionId: string; parentTurnId: number;
  parentToolCallId: string;      // call delegate_task di parent — EKSPLISIT di event forward
  childSessionId: string; mode: "explore" | "plan"; }
// Setiap event forward anak membawa: { ..., sessionId: childId, link: ChildSessionLink }
```

Aturan forward (koreksi V2 + bug yang ditemukan): teruskan `execution:started/completed` + `usage` (seperti sekarang) **dengan `parentToolCallId` eksplisit** (hari ini hanya `forwardedChild: childId` di `task.ts:293-296` — parent tahu *sesi* anak tetapi harus menyimpulkan *call* penyebabnya; untuk satu delegasi per waktu ini cukup, untuk konkurensi tidak). Ledger parent menampilkan SATU baris `delegate_task` (lifecycle milik parent) + ringkasan anak (`finalText.slice(0,2000)`, `[steps N]` — `task.ts:320` dipertahankan sebagai `summary`), BUKAN N baris tool anak yang membanjiri parent. Tool anak masuk model parent sebagai `ActivityEntry` ter-namespaced (`sessionId: child`) yang bisa di-filter/collapse per proyeksi — TUI default: collapse ke satu grup. Jurnal parent tetap skip forward (`journal.ts:1108,1146` dipertahankan — ground truth di anak). `systemExtra` 200-char fence (`task.ts:270-281`, bug PI-H4) adalah masalah audit-log teks, diselesaikan oleh model: prompt penuh jadi `argsSummary` + `expandRef`, bukan pagar 200 char.

---

## 7. Durable vs Live Event Model

Kebijakan dari kebutuhan MiniCode (bukan klasifikasi generik): **restart harus merekonstruksi presentasi bermakna tanpa delta.**

| Event (V2.1) | Durable? | Replayable? | Live-only? | Rekonstruksi tanpa ini? | Butuh presentasi? | Butuh runtime? |
|---|---|---|---|---|---|---|
| `turn.started` | ya (sqlite seed + marker) | ya | tidak | ya (jangkar) | ya | ya |
| `turn.completed/failed/cancelled` | ya (sqlite turns bila changed, `persistence.ts:268-303`) | ya | tidak | ringkasan turn | ya | ya (finalize, checkpoint) |
| `model.completed` (final text) | ya (assistant message, termasuk `reasoningNote` `loop.ts:198-206`) | ya | tidak | ya (conversation) | ya | ya (history) |
| `model.delta` | **tidak** | tidak (diterapkan ke stream buffer, dibuang) | ya | ya, dari completed | progresif saja | tidak |
| `reasoning.completed` (ringkas + ref) | ya (ringkas; full di store bila bounded) | ya | tidak | ya | L3/expand | ya (history thinking-mode) |
| `reasoning.delta` | **tidak** | tidak | ya | ya | progresif saja | tidak |
| `tool.started/completed/failed/denied/cancelled` | ya (messages tool result + journal intent/terminal + step-trace) | ya | tidak | ya (activity) | ya (inti) | ya |
| `tool.progress` | **tidak** (pesan terakhir boleh menempel di entry sebagai `progress`, bukan event log) | tidak | ya | ya (status final cukup) | progresif saja | tidak |
| `approval.requested/settled` | ya (audit; journal `declined by user` via deny reason) | ya | tidak | ya (jejak keputusan) | ya | ya (gate) |
| `file.changed` | ya (journal committed + checkpoint) | ya | tidak | ya (receipt) | ya | ya (undo/redo) |
| `test.completed` | ya (derived dari hasil, disimpan sebagai ringkasan) | ya | tidak | ya | ya | tidak |
| `context.compacted` | ya (ditampilkan; konteks model sudah terlanjur berubah) | ya | tidak | penanda sistem | ya | ya |
| heartbeat/spinner/elapsed | **tidak** | tidak | ya (proyeksi) | ya | tidak (derived dari `tsStart` + jam proyeksi) | tidak |

Konsekuensi: **yang durable = lifecycle + hasil final + ringkasan; yang live = delta + progres + denyut.** Stream buffer & progres boleh hilang saat restart — status final tidak. `ContentStore` payload besar = durability best-effort (§14), bukan kebenaran.

---

## 8. Event Sequencing / Correlation (definisi final)

Empat konsep yang DILARANG dicampur:

- **Ordering — `eventSeq`**: "event apa yang diobservasi lebih dulu (oleh adaptor, per sesi, monotonik)". Penetapan di ingestion (adaptor), bukan di kernel. Dua event konkuren (tool paralel selesai bersamaan) mendapat seq berbeda sesuai kedatangan — **urutan kedatangan, bukan urutan kebenaran**. Replay = urut `eventSeq`, terapkan idempoten (§15).
- **Correlation — ID**: "milik eksekusi apa" (`toolCallId`), "milik turn apa" (`turnId`), "milik step apa" (`stepId`), "persetujuan apa" (`approvalId`). ID stabil, tak bermakna urutan.
- **Causality — link eksplisit**: "operasi apa yang menyebabkan ini" — hanya via field link: `supersedes` (retry, §4), `parentToolCallId` + `ChildSessionLink` (delegasi, §6), `approvalId` di tool (gate). **Tidak ada kausalitas implisit dari `eventSeq`** (anti-pattern).
- **Hierarchy — path**: `(sessionId → turnId → stepId → toolCallId)`; anak: `(childSessionId → turnId…)` + link ke parent.

Aturan konkuren/retry/recovery/duplikat:

- Tool paralel: satu `stepId`, `toolCallId` berbeda, durasi independen; `execution:started` boleh tiba dalam urutan apa pun; ledger diurutkan `eventSeq` tetapi tiap baris membawa ID — tidak ada inferensi "A menyebabkan B".
- Campuran write+read: kernel mengeksekusi sekuensial (`policy/executor.ts:79-85`) — ordering dijamin runtime; model hanya mencatat.
- Retry provider internal: tak ber-event; tak ada seq.
- Recovery (`force_compact_and_retry`, `loop.ts:177-186`): `context.compacted{recovery}` terlebih dulu, lalu sampling ulang — seq mencatat apa adanya; idempoten karena delta tak persist.
- Duplikat (forward ganda / late settle pasca-abort — preseden `loop.ts:231-237` "late result dibuang"): reducer **first-terminal-wins** — event terminal kedua untuk `toolCallId` yang sama diabaikan (dengan counter diagnostik, bukan error). Late `execution:completed` setelah `tool.cancelled` = dibuang. Ini satu-satunya semantik duplikat yang konsisten dengan kernel transaksional (`session.ts:240-245` discard).
- Idempotency key = `(toolCallId, type)` untuk terminal; `(approvalId, type)` untuk settle; `(turnId, type)` untuk turn-settle.

---

## 9. MCP / Tool Identity

Fakta: `serverid.toolname` digabung runtime (`tools/index.ts:99-100`), dedup nama (`withMcpTools`), gate via `includes(".")` (`permission.ts:204`), klasifikasi jurnal via parse string (`journal.ts:133,1113,1165,1187`), filter explore anak via string (`tool-layer.ts:42`, `task.ts`).

```ts
interface ToolIdentity {
  origin: "builtin" | "mcp";
  namespace?: string;      // serverId utk MCP; undefined utk builtin
  name: string;            // nama lokal ("search", BUKAN "srv.search")
  qualified: string;       // "search" | "srv.search" — SATU-SATUNYA bentuk string yang beredar
}
// Parser tunggal di adaptor (ingestion): parseQualifiedName().
// Renderer/permission-view/journal-view TIDAK BOLEH mem-parse string (anti-pattern).
// Kernel & registry tetap memakai `qualified` sebagai key (tak berubah).
// Kebijakan (gated/mutation/readonly) menerima ToolIdentity, bukan string.
```

`ledgerTarget`/label memakai `name` + `namespace` terstruktur (mis. `› srv/search query`), bukan split string di view. Aturan klasifikasi (`GATED`, `MUTATION_TOOLS`, `EXPLORE_TOOL_NAMES`) dimigrasikan ke predicate atas `ToolIdentity` (fase 6; selama migrasi adaptor menyediakan keduanya).

---

## 10. Streaming Model

Keputusan V2 ("delta streaming, entry final") BENAR, diperketat bound-nya (bukti: `pending` TUI tak ber-cap vs `/copy` 200K):

```ts
interface StreamState {           // EPHEMERAL, per turn aktif, BUKAN entry per token
  turnId: number; kind: "message" | "reasoning";
  length: number;                 // pertumbuhan monotonik — proyeksi pakai untuk viewport
  truncated: boolean;             // true bila cap stream tercapai (marker, bukan diam)
}
// Reducer pada delta: StreamState.length += delta.length (buffer teks dipegang adaptor,
// BUKAN reducer — reducer tetap murni tanpa alokasi besar; teks mengalir ke proyeksi
// via kanal live terpisah + didarasikan ke ContentStore chunk bila > cap).
```

- **Data streaming** (delta → proyeksi live + adaptor buffer) vs **presentation streaming** (proyeksi me-render StreamState + buffer). Reducer tidak melihat delta.
- **Cap**: stream buffer per turn (mis. 200K mengikuti `LAST_TURN_MAX_CHARS`, dengan marker `… truncated`) — respons panjang tak menumbuhkan memori tak terkendali; final tetap utuh bila di bawah cap; di atas cap: `model.completed{truncated:true}` + prefix di store.
- **Backpressure**: reducer sinkron + coalesce paint 30ms (aset, dipertahankan); delta yang tiba lebih cepat dari paint = digabung di buffer adaptor (bukan antrean event). Tidak ada unbounded queue.
- **Flush**: batas turn (`started` berikutnya / settle) memfinalkan buffer → `ConversationEntry`/`ReasoningEntry` + `expandRef`; sisa parsial di-flush (preseden `simple.ts:609-626` detach-flush dipertahankan sebagai perilaku, dipindah ke adaptor).
- **Cancel**: `turn.cancelled` membuang buffer dengan penanda (`partial, discarded`) — tak bocor ke turn berikut.
- **Partial failure** (provider error tengah stream lalu fallback sukses — `pendingError` consume-once dipertahankan): prefix gagal dibuang, stream sukses ditulis; satu `model.completed` final.

---

## 11. Context Boundary

Fakta: `compactStore` mengganti `ContextStore.messages` (`loop.ts:342-355`); `Transcript` tidak membaca store itu — de facto terpisah. V2.1 menjadikannya kontrak:

- **Agent Context** = jendela input model (mutable, boleh dipadatkan: policy budget + recovery; `pressure:…`, `recovery`, `:no-op` dipertahankan sebagai `context.compacted`).
- **Presentation History** = catatan user-visible (append-only; **TIDAK PERNAH** dipadatkan oleh kebijakan konteks; satu-satunya pengurangan = evict viewport ber-marker I12 + bounds store §14).
- Kompaksi tampil sebagai `SystemEntry` ("context compacted: pressure:high") di urutan yang benar — user melihat `Turn 1, Tool A ✓, Tool B ✓, Turn 2, Compaction, Turn 3, Tool C ✓` walau konteks model Turn 1 sudah hilang. Ringkasan LLM hasil kompaksi (yang di-pin verbatim + pagar anti-injeksi, per `compaction.ts`) adalah data konteks, bukan entry presentasi — tidak ditampilkan sebagai pesan.
- Invariant: **I-A11** — kebijakan konteks tidak boleh menghapus atau mengubah history presentasi.

---

## 12. Crash / Restart / Resume

Fakta: `appendMutationIntent/Terminal` (journal), `decideRecovery` murni (journal + `persistedTurns`), `turn-marker` liveness proses, checkpoint pointer reconcile, resume seed `initialMessages`. Yang hilang: status presentasi untuk yang tergantung.

```text
tool started (durable: journal intent pending)
  ↓ crash
  ↓ restart → replay durable:
     - intent tanpa terminal + turn tak durable → ActivityEntry{status:interrupted,
       note:"process ended before terminal — verify before retry"}
     - turn terbuka tanpa turn-settle → TurnEntry{interrupted}
     - checkpoint pointer terakhir = dasar /undo; journal seq = dasar verifikasi
  ↓ resume → model diberi direktif [recovery] (mekanisme teks yang sudah ada dipertahankan)
  ↓ retry user = toolCallId BARU (+ supersedes menunjuk yang interrupted) —
     TIDAK PERNAH melanjutkan id lama (id lama sudah terminal-interrupted, first-terminal-wins)
```

- Empat status final dibedakan: `completed | failed | cancelled (disengaja: user abort/timeout-parent) | interrupted (tak diketahui: crash/kill -9/proses mati)`. `interrupted` bukan error dan bukan cancel — ia menuntut verifikasi (`verify-first`, preseden jurnal). Proyeksi: glyph + kata berbeda (`○ interrupted — verify`, bukan merah gagal).
- Turn yang sama: `completed/failed/cancelled/interrupted` — `interrupted` bila proses mati di tengah turn (turn-marker basi + tanpa `turn.completed` durable).
- Approval terbuka saat crash → `settled{cancelled(parent-ended)}` pada rebuild (I-A08 mencakup crash).
- Stream buffer/progres hilang (live-only, §7) — benar dan diharapkan.

---

## 13. Renderer Failure Isolation

Fakta pendukung: `emit` mengisolasi crash listener (`events.ts:52-73`); `registerStatusLine/suspend-resume`; pemilik layar tunggal; ACP single-flight; fail-closed non-TTY.

- Arah aliran satu arah: `Runtime → (adaptor) → Reducer → Model → Proyeksi → Renderer`. Proyeksi **read-only**: menerima snapshot/immutable view; tidak ada callback dari proyeksi ke reducer kecuali aksi user yang dimodelkan sebagai event (`expand` = query, bukan mutasi; jawaban approval = `ApprovalSettled` via runtime, bukan tulis proyeksi).
- TUI crash → proses biasanya ikut mati → §12. TUI render-error parsial (exception di paint) → ditangkap di batas paint, frame berikutnya dari model yang utuh (model tak tersentuh). Resize gagal → `tooSmall` guard (aset). stdout tak tersedia → vektor fail-closed yang sudah ada (deny/null, I23/I28). ACP/Web disconnect → run dibatalkan via signal (→ `cancelled`, bukan gantung) atau dibiarkan selesai tanpa konsumen (keputusan proyeksi, bukan model).
- Invariant: **I-A01** — tidak ada state runtime/presentasi yang hanya hidup di renderer (menutup `pending` + `thinkingBuf` + `bufferedSections` module-level hari ini).

---

## 14. Presentation Model Boundary (kepemilikan eksplisit)

| Concern | Pemilik | Catatan |
|---|---|---|
| activity/turn/approval status + duration + ID + ringkasan + receipt ref + error category | Presentation Model (reducer) | YES — inti semantik |
| ordering refs (`order[]`), seq | Model | YES |
| label semantik tool + ringkasan hasil per jenis | `label.ts` (dipakai reducer) | YES |
| konten penuh (output, diff, reasoning, diagnostik) | **ContentStore (SIBLING, bukan di model)** | NO di model; model hanya `ContentRef` |
| stream buffer / progres terakhir | Adaptor + StreamState ephemeral | NO di model (hanya panjang + flag) |
| usage/token/biaya | Kolektor usage (ada: `setup.ts:706`) → ringkasan di `TurnSummary` | MAYBE (ringkasan saja) |
| checkpoint summary/checkpointId | Ref di receipt/entry | MAYBE (ref saja, data di checkpoint store) |
| test receipt angka | `TestReceipt` ringkas di entry | MAYBE |
| terminal width/cursor/ANSI/spinner timer/renderer objects | Renderer/proyeksi | NO (I-A04) |
| filesystem/network access | Runtime/tools | NO |
| sanitasi keputusan | Ingestion adaptor (sekali) | NO di renderer selain pemakaian `sanitize.ts` sebagai fungsi |

Struktur final: **`Presentation State` (kecil, replayable) + `Content Store` (bounded, ref'd) — sibling di lapisan presentasi, bukan nested.** Model tak pernah mengakses store; proyeksi join via `ContentRef` saat `expand`.

---

## 15. Reducer Determinism

- Tanda tangan: `reduce(model, event: DomainEvent) -> model` (immutable-update atau mutable-terkurung — keputusan implementasi, bukan arsitektur; syarat: tanpa IO).
- Dilarang di dalam reducer: `Date.now/random/fs/net/terminal/env/renderer`. Semua waktu (`ts`, `durationMs`) tiba sebagai **data event** dari adaptor (jam di tepi, bukan di inti — pola `toolStarts` dipindah ke adaptor).
- Invariant:
  - `reduce(m0, [e1..en]) == reduce(m0, [e1..en])` (deterministik).
  - `replay(recordedDurableEvents) == liveModel` (setelah mengabaikan live-only — delta/progres/heartbeat — yang memang tak direkam).
  - Re-apply idempoten: `reduce(reduce(m,e),e) == reduce(m,e)` untuk event terminal duplikat (first-terminal-wins, §8).
- `supersedes`, agregat turn, `TurnSummary` = derived di reducer dari event yang sama → otomatis replay-identik.

---

## 16. Failure Taxonomy (final — minimal)

V2 punya 9 kelas; V2.1: **5 status outcome + 2 enum kecil.** `interrupted` ditambahkan (hilang di V2); `unknown/validate` digabung; timeout menjadi reason cancel, bukan kelas sendiri.

```ts
type ToolOutcome = "completed" | "failed" | "denied" | "cancelled" | "interrupted";
type FailCause = "invalid"      // unknown tool + invalid args (keduanya: kontrak salah)
               | "exec"         // tool throw / exit≠0 / executor error
               | "provider"     // kategori provider (auth/rate_limit/network/length/…)
               | "agent";       // max_steps / budget_exceeded / recovery-habis
type CancelReason = "user" | "timeout" | "parent-ended" | "parent-aborted";
type DenyReason = "jail" | "sensitive" | "allowlist" | "bash-guard" | "mode"
                | "no-approval" | "user" | string;   // string terbuka utk reason mentah ≤80 char
// denied = KEBIJAKAN (bukan error): selalu entry terlihat ⊘, tak pernah merah "gagal".
// invalid = SALAH KONTRAK (model salah panggil): ✗ + skema harapan (L3).
// failed{cause} = EKSEKUSI/PROVIDER/AGEN: ✗ + hint bila ada.
// cancelled{reason} = SENGAJA dihentikan: ○ redup (bukan error).
// interrupted = TAK DIKETAHUI (crash): ○ + "verify" (bukan error, bukan cancel).
```

Turn: `completed | failed{error} | cancelled{reason} | interrupted`. Provider tengah-turn yang pulih via fallback: tetap tak tampil (preseden `pendingError` benar). `max_steps/budget` = `agent` (bukan "system") — dapat ditindaklanjuti user (kecilkan langkah/konteks). System/persistence failure (journal fs gagal) = `SystemEntry` warning degraded-loud (preseden `journal.ts:18-21`), bukan status tool.

---

## 17. Consequence / Receipt (verifikasi: tanpa tracking baru)

```ts
interface Receipt {
  toolCallId: string;
  journalSeq?: number;       // dari journal committed (mutasi) — durable
  checkpointId?: string;     // dari recordCheckpoint turn — durable
  paths?: string[];          // dari journal paths — durable
  stats?: { added?: number; removed?: number };   // DERIVED dari diff (sudah dirender hari ini)
  test?: { passed: number; failed: number; summary: string };  // DERIVED adaptor pola test
  cmd?: { exit?: number };   // DERIVED bila diketahui
}
```

- Semantik (durable, survive replay): `journalSeq/checkpointId/paths` — semua sudah ada di store durable; receipt = **derived view** yang dihitung adaptor/reducer dari event `file.changed` (yang di-emit dari kebenaran journal+checkpoint). Tidak ada FS watcher/tracker baru.
- Derived (presentation): `stats/test/cmd` — dihitung sekali di adaptor, disimpan sebagai data event → replay-safe.
- Presentation-only: format badge (`+14 -6 · ckpt t12`) — di proyeksi.
- Korelasi: `file.changed{toolCallId, journalSeq, checkpointId}` → reducer menempelkan ke `ActivityEntry.receipt`. `/undo` dari receipt = `expand(checkpointId)` + perintah yang sudah ada.

---

## 18. Final Event Model

Setiap event: `type + identity + parent/correlation + sequence + timestamp + payload + durability + replay`. `ts` = jam adaptor (tepi); `eventSeq` = ordering observasi (adaptor, per sesi).

```ts
type Base = { eventSeq: number; ts: number; sessionId: string; turnId: number };

// TURN
{ type:"turn.started";   turnId:number; promptRef:string }                          // D/R
{ type:"turn.completed"; turnId:number; summary:TurnSummary }                       // D/R
{ type:"turn.failed";    turnId:number; error:{cause:FailCause|"provider"|"system"; message:string} } // D/R
{ type:"turn.cancelled"; turnId:number; reason:CancelReason }                       // D/R

// MODEL (delta live-only; completed durable)
{ type:"model.delta";      turnId:number; delta:string }                            // L/–
{ type:"model.completed";  turnId:number; text:string; truncated:boolean; expandRef?:ContentRef } // D/R
{ type:"reasoning.delta";  turnId:number; delta:string }                            // L/–
{ type:"reasoning.completed"; turnId:number; truncated:boolean; expandRef:ContentRef } // D(ringkas)/R

// TOOL
{ type:"tool.started";   toolCallId:string; turnId:number; stepId:number;
  identity:ToolIdentity; argsSummary:ArgsSummary }                                  // D/R
{ type:"tool.progress";  toolCallId:string; message:string }                        // L/–
{ type:"tool.completed"; toolCallId:string; durationMs:number;
  summary:string; expandRef:ContentRef; receipt?:Receipt }                          // D/R
{ type:"tool.failed";    toolCallId:string; durationMs:number; cause:FailCause;
  message:string; hint?:string; expandRef:ContentRef }                              // D/R
{ type:"tool.denied";    toolCallId:string; reason:DenyReason; message:string }     // D/R
{ type:"tool.cancelled"; toolCallId:string; reason:CancelReason }                   // D/R
// (interrupted TIDAK di-emit runtime — ditetapkan reducer/rebuild saat replay:
//  activity terbuka + tanpa terminal + sesi berakhir/crash → interrupted. Satu-satunya
//  status yang boleh disimpulkan, karena faktanya = ketiadaan event.)

// APPROVAL
{ type:"approval.requested"; approvalId:string; toolCallId:string; turnId:number;
  identity:ToolIdentity; argsSummary:ArgsSummary; via:"prompt"|"system" }           // D/R
{ type:"approval.settled";   approvalId:string; toolCallId:string; turnId:number;
  outcome:ApprovalOutcome }                                                         // D/R

// CONSEQUENCE & CONTEXT
{ type:"file.changed";   toolCallId:string; paths:string[]; journalSeq?:number;
  checkpointId?:string }                                                            // D/R
{ type:"test.completed"; toolCallId:string; passed:number; failed:number; summary:string } // D/R
{ type:"context.compacted"; reason:string }                                         // D/R
// D = durable, R = replayable, L = live-only.
```

Contoh sukses + approval (urutan = emisi; kausalitas via link):

```text
turn.started(t7)
tool.started(tc1, edit, step0)
approval.requested(ap1 ← tc1, via:prompt)
approval.settled(ap1, allow/user)
tool.progress(tc1, "patched 2 hunks")        # live, boleh tak ada
tool.completed(tc1, 800ms, "+14 -6", ref#41, receipt{seq:88, ckpt:t7})
file.changed(tc1, [src/x.ts], seq:88, ckpt:t7)
turn.completed(t7, {ok:1, files:1, ckpt:t7, 4.2s})
```

Contoh gagal:

```text
turn.started(t8)
tool.started(tc2, bash, step0)
tool.failed(tc2, exec, "exit 1: …", hint:"…", ref#42)
turn.failed(t8, {exec, "…"})
```

Contoh batal saat approval menggantung (urutan semantik — yang benar):

```text
turn.started(t9)
tool.started(tc3, bash(delegate?), step0)
approval.requested(ap2 ← tc3, via:prompt)
turn.cancelled(t9, user)                  # Ctrl+C: signal menang
approval.settled(ap2, cancelled/parent-aborted)   # force-close (I-A08), BUKAN deny-user
tool.cancelled(tc3, parent-aborted)       # call tak pernah dieksekusi
```

(Alasan urutan: pembatalan milik turn; approval & tool adalah anak yang ditutup karenanya. Kausalitas dibaca dari link, bukan dari urutan baris — §8.)

---

## 19. Final Identity Model

| ID | Dibuat oleh | Dimiliki oleh | Mengidentifikasi | Hidup | Reuse? | Korelasi |
|---|---|---|---|---|---|---|
| `sessionId` | app-layer (`createCliSession`; anak: `task.ts:227`) | sesi | satu agen (utama/anak) | hidup sesi | tidak | rantai parent↔child |
| `turnId` | session wrapper (per `run()`) | turn | satu eksekusi prompt | hidup sesi (monotonik per session) | tidak | semua event turn itu |
| `stepId` | loop (`index`) | step | grup tool paralel | hidup turn | per-turn (0..n, scoped `(sessionId,turnId)`) | grup konkurensi |
| `toolCallId` | provider (diteruskan; dilarang dibuang) | tool call | satu pemanggilan tool | hidup sesi (terminal sekali) | tidak | hasil/approval/receipt/retry-link |
| `approvalId` | permission (`promptAskOr`) | approval | satu permintaan persetujuan | request→settle | tidak | requested↔settled, tool, turn |
| `checkpointId` | checkpoint (`recordCheckpoint…`, per turn) | snapshot FS | keadaan file per turn | TTL/repo (di luar model) | tidak | receipt→restore |
| `journalSeq` | journal (monotonik per sesi) | komitmen mutasi | urutan komitmen | hidup jurnal | tidak | receipt→verifikasi, ordering komitmen |
| `eventSeq` | adaptor (monotonik per sesi) | observasi | urutan kedatangan | hidup sesi (replay) | tidak | ordering replay; BUKAN kausalitas |
| `ContentRef` | reducer/store (`{toolCallId, idx}`) | payload besar | isi yang bisa di-expand | selama dalam bounds store | tidak | entry→isi |

Redundan yang ditolak: `runId` (=(sessionId,turnId)), `agentId` (=sessionId), `attemptId/executionId` (§4), timer approval khusus (§5).

---

## 20. Final Presentation Model

```ts
// — Core semantic state (replayable, kecil) —
interface ActivityEntry {
  kind:"tool"; seq:number; turnId:number; stepId:number; toolCallId:string;
  sessionId:string; parentToolCallId?:string;      // sub-agent: penyebab di parent
  identity:ToolIdentity; target?:string;
  status:"running"|ToolOutcome;                    // running = live; sisanya final
  tsStart:number; tsEnd?:number; durationMs?:number;
  progress?:string;                                // terakhir (live, boleh hilang saat restart)
  summary?:string; denyReason?:DenyReason;
  error?:{ cause:FailCause; message:string; hint?:string };
  supersedes?:string;                              // retry-link (derived)
  approvalId?:string; expandRef?:ContentRef; receipt?:Receipt;
}
interface TurnEntry { kind:"turn"; seq:number; turnId:number; sessionId:string;
  status:"running"|"completed"|"failed"|"cancelled"|"interrupted";
  tsStart:number; tsEnd?:number; summary?:TurnSummary; error?:string; }
interface ApprovalEntry { kind:"approval"; seq:number; turnId:number;
  approvalId:string; toolCallId:string; identity:ToolIdentity;
  state:"requested"|"settled"; outcome?:ApprovalOutcome; }
interface ConversationEntry { kind:"message"; seq:number; turnId:number;
  role:"user"|"assistant"; text:string; truncated:boolean; expandRef?:ContentRef; }
interface ReasoningEntry { kind:"reasoning"; seq:number; turnId:number;
  truncated:boolean; expandRef:ContentRef; }       // isi selalu via ref
interface SystemEntry { kind:"system"; seq:number; turnId:number; text:string; }

interface PresentationState {                       // CORE — kecil, replayable
  sessionId:string; seq:number;
  turns:Map<number,TurnEntry>;
  activities:Map<string,ActivityEntry>;             // key toolCallId (+ sessionId utk anak)
  approvals:Map<string,ApprovalEntry>;
  conversation:ConversationEntry[];                 // final-only (bukan delta)
  order:EntryRef[];                                 // urutan tampil
}
// — Derived (dihitung ulang dari core; tidak direkam terpisah) —
interface DerivedState { turnSummaries:Map<number,TurnSummary>; retryChains:Map<string,string[]>;
  counts:{ok:number; failed:number; denied:number; cancelled:number; interrupted:number}; }
// — Ephemeral live (tidak direkam, tidak di-replay) —
interface LiveState { streams:Map<number,StreamState>; pinnedTool?:string; }
// — Durable refs (pointer ke store durable, bukan data) —
interface DurableRefs { journalUpto?:number; checkpointId?:string; persistedTurns:number[]; }
```

---

## 21. Final Content Store Model

```ts
interface ContentRef { toolCallId:string; idx:number }   // idx: chunk/entry dalam store
interface ContentStore {                                  // SIBLING model, non-otoritatif
  put(ref:ContentRef, text:string, meta:{kind:"output"|"diff"|"reasoning"|"diagnostic";
    stream:"stdout"|"stderr"; truncated:boolean}): void;
  get(ref:ContentRef): { text:string; meta:... } | undefined;
  // Retention: per-entry ≤200K, total ≤500K (angka teruji collapse.ts — dipertahankan
  // sebagai awal, dapat di-tune tanpa mengubah arsitektur). Evict: FIFO tertua +
  // entry yang di-evict DITANDAI di model (expandRef.dead=true → proyeksi tampilkan
  // "konten di luar retensi — lihat file log", bukan string kosong yang menyesatkan).
  // Persistence boundary: store = in-memory best-effort; durability = file log
  // (step-traces ringkas + sqlite full) — expand pasca-restart dilayani dari
  // durable (sqlite/tool result) bila ref mati, dengan penanda sumber.
  // Replay: TIDAK butuh payload — cukup ref + summary (semantik utuh tanpa isi).
}
// expand(toolCallId) = resolve entry → expandRef → store.get() → proyeksi render.
// BUKAN buffer terminal transien; bisa dibuka ulang; tidak reset per turn;
// reset per turn diganti retensi FIFO global (lebih adil untuk sesi panjang).
```

Bukti kebutuhan: `/expand` hari ini sekali-habis + reset-per-turn (`transcript.ts:177-181`, `simple.ts:297`) dan dua cap divergen — V2.1 mengganti ketiganya dengan satu store + ref + penanda evict.

---

## 22. Final Projection Model

Kesetaraan semantik yang dijamin test (satu state → semua proyeksi): `status, identity(qualified), durationMs, error category/cause, denyReason, receipt refs, correlation IDs, lifecycle stage`. Yang boleh beda: layout, verbosity (compact vs expanded), warna, jumlah baris, interaksi (`/expand(id)` vs cetak penuh vs JSON).

| Proyeksi | Boleh | Dilarang |
|---|---|---|
| TUI | compact 1-baris/activity, collapse grup anak, pinned running + elapsed, viewport cap ber-marker, `/expand(id)` interaktif | mengubah status; mem-parse string; menyimpan kebenaran di widget |
| Linear/CLI | expanded (preview + receipt + diff), deterministik non-TTY (I6), stdout/stderr split (I2) | ANSI tak perlu di pipe; baris tanpa newline (preseden overlap) |
| ACP | lossy TERSTRUKTUR: text delta + lifecycle (`tool.*`, `approval.*`) + deny-headless eksplisit | menyembunyikan deny/cancel (IDE harus melihat lifecycle) |
| Web/API (masa depan) | JSON langsung dari state + store; replay endpoint | mem-parse output terminal untuk semantik |

---

## 23. Terminal Preservation (jangan ditulis ulang)

Dipertahankan apa adanya (hanya diberi makan data lebih baik): `sanitize.ts` (gerbang, dipanggil sekali di ingestion), `width.ts` (kolom), `wrap.ts`, `markdown.ts`, `highlight.ts`, `theme.ts` (`colorLevel`, getter `c/glyphs`), `screen.ts` (ownership, paintRegion, union-clear), `statusline.ts` (transient arbitration, `beginInteractiveScreen`), `app.ts` paint/coalesce-30ms/suspend-resume/kunci-baca/indikator, `input.ts` (I30 jangkar), `turn-status.ts` (mesin transient + grace + latch + `endTurn`), approval TUI lifecycle (`prompt.ts` + sink + suspend + fail-closed I23), non-TTY determinism (I6), exit codes (I28), ACP framing (I29), sinyal (I31), seluruh peta proteksi + PTY. Satu-satunya perubahan di sisi ini: **titik panggil** (label dari `label.ts`, status dari model, expand dari store) — bukan logika.

---

## 24. Migration Plan (V2.1 — tetap incremental, tanpa flag-day)

**Fase 0 — Baseline.** Kunci gate + metrik (test count, cap, `/expand` behavior, `includes(".")` sites). File: —. Tes: —. Risiko: nol. Rollback: n/a.

**Fase 1 — Semantic event adapter.** Baru `src/presentation/{events.ts,adapter.ts}`: lama→V2.1 (deny dari `step.results`, turn-settle dari `run()` reject/abort/timeout, `model.completed` dari `TurnResult.finalText`, `approval.*` emit di `promptAskOr`/`promptAsk/Text`, `ToolIdentity` parse sekali, `eventSeq/ts` assignment, durasi via `toolStarts`-moved-to-adapter). Sentuh: `cli/setup.ts` (wiring), `prompt.ts` + `permission.ts` (emit samping callback). Tes: event test (deny/validate/unknown/abort/timeout/headless/allowlist-tanpa-emit). Risiko: rendah (aditif). Rollback: lepas wiring.

**Fase 2 — Identity/correlation.** `toolCallId` diteruskan utuh di kontrak (perbaikan `UiExecution`), `parentToolCallId` di forward anak (`task.ts:303-316` + journal skip dipertahankan), `ChildSessionLink`, `supersedes` derived (dokumentasikan aturannya sebagai test). Sentuh: `contract.ts` (tambah, jangan buang), `task.ts`, `journal.ts` (baca, bukan ubah). Tes: korelasi (anak→parent, retry-chain, paralel-tanpa-taut). Risiko: rendah-sedang. Rollback: revert kontrak-tambahan.

**Fase 3 — Reducer/model (+ determinism).** Baru `model.ts/reducer.ts/label.ts`; `store.ts` sebagai sibling. Murni, tanpa IO; `Date.now` hanya di adaptor. Tes: reducer + replay + idempotensi duplikat + force-close approval + interrupted-on-rebuild. Risiko: rendah (belum dipakai renderer). Rollback: hapus wiring.

**Fase 4 — Content store / expand.** `store.ts` aktif (200K/500K awal), `expand(id)` queryable di `commands.ts`/`tui.ts`, evict ber-marker, receipt `file.changed/test.completed` dari journal/checkpoint. Tes: expand deterministik + evict-marker + receipt join + restart-dari-durable. Risiko: sedang. Rollback: flag `MINICODE_PRESENTATION_V2=0`.

**Fase 5 — TUI projection.** `Transcript` bungkus model (kind/seq/id di belakang; `view/wrapAll`/cap dipertahankan agar test lama hijau), pinned activity + elapsed dari model, grup anak collapse. Tes: proyeksi-paritas + PTY + viewport lama. Risiko: sedang (mitigasi: paritas string). Rollback: flag.

**Fase 6 — Linear/ACP projection.** Linear dari model (perilaku string dipertahankan via snapshot), ACP tambah lifecycle terstruktur (tetap deny-headless). Tes: non-TTY deterministik + ACP lifecycle + exit codes. Risiko: rendah-sedang. Rollback: flag.

**Fase 7 — Hapus usang.** Hapus `takeBufferedSections` sekali-habis, labeler ganda, `includes(".")` sites (ganti predicate `ToolIdentity`), klasifikasi-string sebagai kebenaran, sanitasi ganda waktu. Syarat: semua test hijau + PTY + 1 rilis flag-on. Risiko: rendah. Rollback: revert terisolasi. Wajib: update `ARCHITECTURE.html` + `TERMINAL_CONTRACT.md` bila perilaku berubah (aturan repo).

### Files To Change (ringkas)

Baru: `src/presentation/{events.ts,adapter.ts,model.ts,reducer.ts,store.ts,label.ts}`. Sentuh: `cli/setup.ts` (wiring), `src/ui/approval/prompt.ts` + `src/policy/permission.ts` (emit samping callback), `src/ui/contract.ts` (tambah ID; jangan buang), `src/tools/task.ts` (parent-link eksplisit), `src/ui/tui/transcript.ts` + `src/ui/assistant/simple.ts` (bungkus → proyeksi), `src/ui/tui/app.ts` (pinned/status), `cli/{commands,tui}.ts` + `cli/commands/{exec,acp}.ts` (expand/proyeksi), `src/telemetry/trace.ts` (category terstruktur; string-fallback sementara), `src/ui/render/collapse.ts` (→ view store, Fase 7), `docs/ARCHITECTURE.html` + `TERMINAL_CONTRACT.md` (wajib tiap perubahan perilaku).

### Files NOT To Rewrite

`render/{sanitize,width,wrap,markdown,highlight,theme,format,errors,diff,table}`, `runtime/{statusline,screen}`, `input/input.ts`, `assistant/turn-status.ts`, approval TUI lifecycle, `vendor/minicore/**` (frozen; seam aditif hanya untuk `tool.progress` sukarela bila dibutuhkan), `session/journal.ts` + checkpoint wiring + trace writer (tambah emit, bukan ubah), seluruh test proteksi I1–I31 + PTY + `ui-boundary`.

---

## 25. Architectural Invariants (final, non-negotiable)

- **I-A01** Renderer/proyeksi tidak pernah memiliki kebenaran runtime maupun presentasi (read-only snapshot).
- **I-A02** Setiap eksekusi tool user-visible punya `toolCallId` stabil end-to-end (dilarang dibuang di batas mana pun).
- **I-A03** Setiap eksekusi terminal mencapai tepat satu status final (`completed|failed|denied|cancelled|interrupted`); first-terminal-wins untuk duplikat/late-settle.
- **I-A04** Model presentasi tidak menyimpan state terminal (width/cursor/ANSI/timer/widget) maupun payload besar (hanya ref).
- **I-A05** Reducer murni & deterministik: event sama → model sama; replay == live (minus live-only).
- **I-A06** Payload besar di-ref, bukan di-embed; evict selalu ber-marker; replay tak butuh payload.
- **I-A07** Retry = call baru + link `supersedes` derived; tanpa ID attempt; aturan tautan deterministik.
- **I-A08** Approval tak boleh pending setelah parent settle/crash — force-close `cancelled(parent-ended)` (+ `interrupted` path via rebuild).
- **I-A09** `eventSeq` = ordering observasi; kausalitas hanya via link eksplisit; hierarki via path ID.
- **I-A10** TUI/Linear/ACP identik dalam status, identitas, durasi, kategori error, receipt, korelasi, lifecycle.
- **I-A11** Kompaksi konteks tidak mengubah history presentasi; tampil sebagai `SystemEntry`.
- **I-A12** `interrupted` ≠ `failed` ≠ `cancelled`; tak ada eksekusi yang dinyatakan selesai tanpa terminal event-nya (kecuali inferensi `interrupted` saat rebuild, yang eksplisit menandai ketidaktahuan).

---

## 26. Architectural Anti-Patterns (jangan — dengan alasan)

- Parse string terminal/nama tool untuk semantik (`includes(".")`, regex ledger) — gunakan `ToolIdentity`/ID. *(Sudah 4+ sites; sumber divergensi.)*
- Logika lifecycle di renderer (started/completed versi TUI vs linear) — milik reducer.
- Transkrip `string[]` baru — wajib kind/seq/id.
- `ContentStore` sebagai sumber status/keputusan — ia non-otoritatif; kebenaran = state + durable.
- `eventSeq` sebagai kausalitas ("B setelah A maka disebabkan A") — gunakan link.
- ID baru tanpa pertanyaan korelasi (`runId/agentId/attemptId/executionId` ditolak di §4/§6/§19).
- Persist delta token/progres — durable = final + ringkasan.
- Progress palsu per tool ("memaksa setiap tool emit progress") — `progress` sukarela; heartbeat = elapsed + spinner.
- State TUI mengendalikan runtime (prompt answer menulis model langsung) — jawaban lewat runtime sebagai event.
- Membuang lifecycle gagal/ditolak/batal secara diam-diam (deny tanpa event, abort tanpa settle) — akar seluruh audit.
- Sanitasi/truncation yang menghancurkan makna di hulu (cap tanpa marker; potong berbasis `rows` saat event).
- `expand` sekali-habis / reset-per-turn / buffer tanpa ref.
- Allowlist-hit dihitung sebagai approval (ia keputusan policy — jangan mengotori audit persetujuan).

---

## 27. Final Stress-Test Matrix

| Scenario | V2 (lama) | V2.1 | Required mechanism | Verdict |
|---|---|---|---|---|
| concurrent tools | baris campur, tanpa grup | satu `stepId`, ID berbeda, ledger per ID | step grouping + per-call duration | PASS WITH CONDITION (proyeksi wajib grup, bukan interleave acak) |
| retry | tak terdefinisi | call baru + `supersedes` derived | aturan tautan deterministik (§4) | PASS WITH CONDITION (aturan edge paralel didokumentasikan di test) |
| approval cancel | `resolved` tak menutup batal | `settled{cancelled}` + force-close I-A08 | outcome enum + turn-settle hook | PASS |
| timeout | diam (abort tanpa event) | `turn/tool.cancelled{timeout}` | adaptor dari timeout signal | PASS |
| Ctrl+C | diam di bus; 3 strategi driver | `turn.cancelled{user}` + cascade settle | adaptor + cascade (§18) | PASS |
| crash | direktif teks `[recovery]` saja | `interrupted` + rebuild dari durable | journal pending + marker + checkpoint (§12) | PASS |
| restart | tak ada rekonstruksi model | replay durable tanpa delta (§7) | sqlite + journal + checkpoint | PASS |
| replay | tak terdefinisi | `replay == live`, idempoten | reducer murni + first-terminal-wins | PASS |
| MCP | `includes(".")` tersebar | `ToolIdentity` parse-sekali | parser adaptor + predicate (§9) | PASS |
| nested agent | forward mentah + tag sesi | `ChildSessionLink` + collapse grup | `parentToolCallId` eksplisit (§6) | PASS WITH CONDITION (satu delegasi per waktu aman hari ini; konkurensi butuh call-link) |
| long-running tool | spinner transient saja | activity persisten + elapsed + progress sukarela | `ActivityEntry{running}` + `tool.progress` | PASS |
| huge output | 3 cap divergen + potong diam | store 200K/500K + marker + ref | ContentStore sibling (§21) | PASS WITH CONDITION (angka awal dari collapse.ts; tune tanpa ubah arsitektur) |
| model streaming | `pending` tak ber-cap (TUI) | stream buffer ber-cap + final-only entry | adaptor buffer + truncate marker (§10) | PASS |
| context compaction | de facto terpisah, tak dinyatakan | invariant I-A11 + `SystemEntry` | boundary kontrak (§11) | PASS |
| renderer crash | terisolasi per-handler (ada) | + model tak tersentuh (invariant) | I-A01 + paint-boundary try/catch (§13) | PASS |
| ACP disconnect | single-flight (ada) | + cancel-eksplisit atau selesai-tanpa-konsumen | kebijakan disconnect (§13) | PASS WITH CONDITION (pilih kebijakan per disconnect; keduanya valid) |

---

## 28. Final Canonical Architecture

```text
                    ┌──────────────────────┐
                    │    Agent Runtime     │
                    │ MiniCore (frozen) +  │
                    │ app-layer (policy,   │
                    │ journal, checkpoint) │
                    └──────────┬───────────┘
                               │ Domain Events v2.1 (§18)
                               │ ID + link + seq + ts (§19, §8)
                               ▼
                 ┌─────────────────────────┐
                 │   Semantic Event Layer  │  (adaptor: parse-sekali,
                 │   (adapter, di tepi)    │   jam di tepi, deny/abort/
                 │                         │   finalText/approval emit)
                 └─────────────┬───────────┘
                 ┌─────────────┴──────────────┐
                 ▼                            ▼
        ┌────────────────┐          ┌──────────────────┐
        │ Durable Events │          │ Live Stream      │
        │ journal/sqli-  │          │ delta/progress/  │
        │ te/checkpoint/ │          │ heartbeat (tak   │
        │ trace (replay) │          │ direkam)         │
        └───────┬────────┘          └────────┬─────────┘
                │                   ┌────────┴────────┐
                │                   ▼                 ▼
                │         ┌─────────────────┐  ┌─────────────┐
                │         │ Presentation    │  │ Proyeksi    │
                └────────►│ Reducer (murni) │  │ live (TUI   │
                 replay   └────────┬────────┘  │ stream)     │
                                   ▼           └─────────────┘
                          ┌─────────────────┐
                          │ Presentation    │── refs ──► Content Store
                          │ State (§20)     │◄── refs ── (sibling, §21)
                          └────────┬────────┘
                  ┌────────────────┼────────────────┐
                  ▼                ▼                ▼
                 TUI             Linear            ACP → Web/API
              (compact)        (expanded)        (lossy terstruktur)
```

Mengapa risiko sisa adalah risiko implementasi, bukan blokir arsitektur: setiap keputusan kontroversial (tanpa attemptId; settled-bukan-dua-event; store-sebagai-sibling; `interrupted`-disimpulkan) diturunkan dari perilaku kode yang sudah ada (retry internal tak berobservasi; 6 jalan approval; 2 buffer global; journal pending; `first-terminal` preseden kernel) dan masing-masing punya test penentu di §24. Yang tersisa (tuning cap store, format badge, kebijakan disconnect) tidak mengubah bentuk — hanya angka dan teks.

---

## 29. READY / NOT READY Verdict

```text
READY
```

V2.1 siap menjadi kontrak implementasi: lifecycle eksplisit (§18), identitas minimal-terbukti (§19), model + store terpisah (§20–§21), proyeksi terikat kesetaraan semantik (§22), migrasi 8 fase dengan rollback per fase (§24), 12 invariant non-negotiable (§25), anti-pattern eksplisit (§26), dan matriks stress-test tanpa `NEEDS CHANGE` terbuka (terburuk = `PASS WITH CONDITION` yang kondisinya berupa test/aturan yang sudah dirumuskan, bukan pertanyaan arsitektur yang belum terjawab).

---

### Evidence index (file:line kunci)

- Retry sampling internal: `vendor/minicore/src/core/loop.ts:91,96-103,129-131,177-186,198-206,231-248,275-290,342-355`
- Executor tanpa retry tool: `vendor/minicore/src/core/executor.ts:40-104`; paralel: `src/policy/executor.ts:64-199` (campuran write+read sekuensial `:79-85`, worker-pool + write-slot + per-file lock)
- Session transaksional + timeout: `vendor/minicore/src/core/session.ts:31,215-256,291-327`
- Approval 6 jalan: `src/policy/permission.ts:204,510-538`; view: `src/ui/approval/prompt.ts:24-150`; sink: `src/ui/tui/transcript.ts:39-47`; wiring: `cli/setup.ts:362,390`
- Sub-agent: `src/tools/task.ts:164-352` (child id `:227`, intent `:228-234`, forward+tag `:287-316`, ringkasan `:320`, journal anak `:283`); skip jurnal parent: `src/session/journal.ts:1108,1146`; pool 3 (AGENTS.md)
- Kontrak degradatif: `src/ui/contract.ts:13-55`; cast: `cli/tui.ts:121,459`
- Dua presenter + buffer: `src/ui/assistant/simple.ts:48-60,83-93,100-102,122-126,153-154,387-399,442-447,490-500,609-626`; `src/ui/tui/transcript.ts:19-21,62,86-109,121,177-181,287-289`; `src/ui/render/collapse.ts:24-25,60-90`
- Durable: `src/session/journal.ts:29-80,812-1021,1235-1342`, `src/session/persistence.ts:115-303`, `src/session/turn-marker.ts`, `src/session/checkpoint.ts`, `cli/setup.ts:407-463,465-517`, `src/telemetry/trace.ts:29-52,98-126`
- MCP origin string: `src/tools/index.ts:99-100`, `src/policy/permission.ts:204`, `src/session/journal.ts:133,1113,1165,1187`, `src/app/tool-layer.ts:39-42`
- Transient/streaming: `src/ui/assistant/turn-status.ts:25-28,84-134,196-313`, `src/ui/runtime/statusline.ts`, `src/ui/tui/app.ts`
- Terminal preservation: `docs/TERMINAL_CONTRACT.md` I1–I31, `test/pty.test.ts`, peta proteksi
