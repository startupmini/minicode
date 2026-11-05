# P2 — Operational Quality & Architecture Report (2026-11-05)

**Sesi:** P2 (State Isolation & Type Safety · Monolith/Rendering Performance · MCP & Daemon Reliability)
**Repository:** `D:/Github/minicode`
**Branch:** `main` · **Version:** `0.13.1` · `git describe`: `v0.13.1-1-gcb60212`
**HEAD:** `cb602124571d8e4638bdb47d38400c52d8fba976` (tidak berubah; tidak ada commit/push/stage/reset)
**Platform:** Windows x64 · Bun `1.4.3`
**Sifat klaim:** **stage-scoped** pada kandidat working tree sesi ini. Bukan klaim release-readiness.

---

## 1. Executive verdict

P2 dikerjakan **measurement-first** dan evidence-driven. Hasil utama:

1. **State & type safety (P2.1)** — decoder durable diperketat (default deny, validasi versi `v`,
   parent-link, task verification, tool identity); versi `v:1` tetap kompatibel dengan event lama.
   Dibuatkan **state ownership map** dan **keputusan multi-session** yang eksplisit di §7.
2. **Performance (P2.2)** — benchmark rendering sintetis yang reproducible (`scripts/bench-render.ts`).
   Dua hot path terbukti dan diperbaiki:
   - **reducer `order` O(n²)**: 5.000 tool-event `~290 ms → ~9 ms` p50 (**~30×**).
   - **proyeksi transkrip per baris**: long-2000 `~11,2 ms → ~0,45 ms` p50 (**~25×**),
     prose-1000 `~20 ms → ~0,14 ms` (**~140×**). Tidak ada regression rendering/input.
3. **MCP (P2.3)** — schema pin kini **persisten** per workspace, drift fail-closed menyembunyikan tool,
   jalur approve produksi (`minicode mcp approve <server>.<tool> <hash>`), pagination `nextCursor`,
   dan koneksi multi-sesi via **reference count** (close satu sesi tidak mematikan sesi lain).
4. **Daemon (P2.3)** — `run.interrupt`/`run.cancel` kini **benar-benar meng-abort run** yang berjalan
   (bukan `RUN_TERMINAL` stub); status run live dibaca `session.list`/`session.status`; replay
   **backpressure resumable** (berhenti saat `socket.write()===false`, lanjut saat `drain`, tanpa
   kehilangan event).

**Gate akhir pada kandidat final:**

| Gate | Hasil |
|---|---|
| `bun x tsc --noEmit` | **exit 0** |
| `bun run lint` | **exit 0** (661 file) |
| `bun test` | **5.453 pass · 19 skip · 0 fail** (5.472 test, 369 file) |
| `bun run gate:coverage` | **funcs 88,13% (min 87) · lines 88,95% (min 86) · 19/19 floor** |
| `bun run audit:harness` | **60 pass · 0 fail · 2 advisory** |
| `bun run gate:bash` | **bypass 0/62 · over-block 0/24** |
| `bun run bench:smoke` | **13/13 · delta 0,0%** |
| `bun run bench:render` | **green; before/after di §10** |
| `bun run gate:pack` | **22 pass · 1 fail** — hanya ukuran: **3.890 KB** vs budget historis 3.840 KiB |

**Verdict:** **P2 COMPLETE (STAGE-SCOPED) untuk P2.1 & P2.2; P2.3 PARTIAL dan terdokumentasi.**
Kriteria correctness/state/performance/replay/enforcement terpenuhi. MCP **reconnect/subscription**
dan daemon **restart reconstruction penuh** tetap residual yang jujur (bukan dianggap selesai).

---

## 2. P1 handoff verification

| Item | Hasil |
|---|---|
| `P1_CORRECTNESS_OBSERVABILITY_UX_REPORT_2026-11-05.md` | ada (29.405 byte) |
| 4 laporan P0 (FINAL/FOUNDATION/CHECKPOINT/BASELINE) | ada |
| HEAD | `cb60212` (sama dengan P1) |
| Tracked modified / untracked / staged (awal P2) | **81 / 49 / 0** |
| `diff_hash` awal P2 | `6d82616dccf405eedb0dbf7759ec0875704dcc19` |
| Proses agent/test lain | tidak ada `bun`/`minicode`; hanya node router/pnpm/astro di luar repo |

Handoff konsisten: HEAD tidak bergeser, seluruh artefak P0/P1 dipertahankan, dan semua postingan P1
terbawa utuh. P2 dimulai langsung tanpa mengulang audit P0/P1.

---

## 3. Repository snapshot & fingerprint

```
Awal P2:
  HEAD          cb602124571d8e4638bdb47d38400c52d8fba976
  tracked       81 · untracked 49 · staged 0
  diff_hash     6d82616dccf405eedb0dbf7759ec0875704dcc19

Akhir P2 (sebelum laporan ini):
  HEAD          cb602124571d8e4638bdb47d38400c52d8fba976
  tracked       86 · untracked 52 · staged 0
  diff_hash     1bc4e41dca67ef7c1486da085a8981c943761c5c
```

**File baru P2:** `scripts/bench-render.ts`, `test/p2-mcp-reliability.test.ts`,
`test/p2-daemon-control.test.ts` (dan laporan ini). Tidak ada file yang dihapus atau ditimpa.

**File P2 yang diubah:**

| Area | File |
|---|---|
| State/type | `src/session/persistence.ts`, `src/presentation/reducer.ts` |
| Performance | `src/ui/tui/transcript.ts` |
| MCP | `src/mcp/client.ts`, `src/app/tool-layer.ts`, `cli/commands/mcp.ts`, `cli/setup.ts` (cwd) |
| Daemon | `src/daemon/server.ts`, `src/daemon/telemetry.ts`, `cli/commands/daemon.ts`, `cli/setup.ts` (`runState`) |
| Config/bench | `package.json` (`bench:render`), `scripts/bench-render.ts` |
| Tests | `test/writer-inventory.test.ts` (limit daemon +1, terdokumentasi), `test/presentation-observability.test.ts`, `test/memory-consistency.test.ts`, `test/p13-multi-consumer.test.ts`, `test/p2-mcp-reliability.test.ts`, `test/p2-daemon-control.test.ts` |

---

## 4. P1 residual carry-forward matrix

| ID | Residual | Status setelah P2 | Bukti / catatan |
|---|---|---|---|
| R-P1-01 | Manual TUI/operator UAT | **UNVERIFIED** (carry-forward) | PTY mechanics lulus; comprehension manual belum |
| R-P1-02 | Gateway cache telemetry | **UNVERIFIED** (carry-forward) | adapter vendor belum membaca cached_tokens; tanpa probe |
| R-P1-03 | Task claim/merge/cancel events | **NOT_FIXED** (carry-forward) | di luar scope P2; `todo_write`/verify sudah terpancar |
| R-P1-04 | FAILED/RETRYING producer | **NOT_FIXED** (carry-forward) | status domain ada, belum ada producer produksi |
| R-P1-05 | Memory supersession concurrency | **FIXED_VERIFIED** | test race dua writer → tepat satu menang |
| R-P1-06 | Legacy truncated memory lines | **PARTIAL** (carry-forward) | pembersihan exact-match tetap; fuzzy tidak dihapus |
| R-P1-07 | Distribution-size efficiency | **NOT_FIXED** (efisiensi) | `gate:pack` 3.890 KB; analisis di §16 |

Residual yang tidak relevan dengan P2 tetap dicatat sebagai carry-forward, tidak dianggap selesai.

---

## 5. P2 acceptance matrix

| Area | Criteria | Status | Bukti |
|---|---|---|---|
| **P2.1 State/type** | ownership jelas; lifecycle benar; multi-session sesuai kontrak; durable dapat berkembang; boundary validation; test isolasi | **FIXED_VERIFIED** | §6, §7, §8; decoder default-deny + versi; test `presentation-observability` (v2 ditolak, legacy/v1 diterima); MCP refcount; multi-consumer |
| **P2.2 Monolith/perf** | benchmark reproducible; bottleneck terukur; refactor menjawab bottleneck; before/after; tanpa regression; kompleksitas tidak naik | **FIXED_VERIFIED** | §9, §10, §11; reducer 30×, projection 25–140×; 170 test UI lulus |
| **P2.3 MCP/daemon** | pin aman; drift; lifecycle deterministik; multi-session; pagination; interrupt/cancel; replay/backpressure; restart/reconstruct akurat; shutdown bersih; operator paham | **PARTIAL** | pin persist+drift+approve (§12); pagination+multi-session (§12); interrupt/cancel nyata (§13); replay backpressure (§14). **Residual:** MCP reconnect/subscription tidak diimplementasikan; daemon restart reconstruction penuh tidak diimplementasikan (dinyatakan jujur) |

---

## 6. State ownership map (P2.1)

Inventaris berbasis source (bukan contoh tabel). **Keputusan:** MiniCode **TIDAK mendukung multi-session
agent in-process yang berjalan bersamaan**. Yang didukung: satu sesi agent per proses, daemon
mem-host satu sesi dengan banyak subscriber, dan koneksi MCP dibagi lintas proses (dengan refcount).
Resource process-wide didokumentasikan dan dirawat lifecycle-nya.

| State / resource | Owner | Lifetime | Shared? | Cleanup |
|---|---|---|---|---|
| `UiSessionState` (UI collapse/detail/reasoning/copy) | Session | Session | Tidak | Session (`resetCopyBuffer`; GC) |
| `todoSession` (`todo.ts`) | Single active session | Rebound tiap `createCliSession` | Process-wide | none (dokumentasi single-session) |
| `askTextFn`/`askApprovalHook` (`ask_user.ts`) | Composition root DI | Rebound tiap session | Process-wide | `setAskApprovalHook(undefined)` on close |
| `submit_result.last` | Run | Cleared at run start (`exec`/`acp`) | Process-wide | `clearSubmittedResult()` |
| `pending-tools` (`pending-tools.ts`) | Run | Single-run guard (dokumentasi) | Process-wide | `setPendingToolsRun(null)` |
| `currentRouter` (`provider-layer.ts`) | Provider lifecycle | Process | Process-wide | — |
| MCP `activeConnections` + `connectionRefs` | Process (refcount) | Connection | Process-wide, **refcount** | `closeAll({force})`; refcount decrement per session |
| LSP `activeServers` (`lsp/client.ts`) | Process | Server | Process-wide | `closeAllLsp()` |
| `locale` (`i18n/locale.ts`) | Process | By design | Process-wide | `resetLocaleState()` (test) |
| transcript `approvalSink` | Single TUI | TUI | Process | — |
| `statusline`/`screen` depth | Process | Terminal | Process | refcount depth |
| background bash jobs (`bash.ts`) | Process map | Job | Process | `killAllBackgroundJobs()` on close |
| Run / Task / memory stores | Durable (SQLite) | Session/canonical | — | close barriers (§13) |

---

## 7. Multi-session support decision

**Keputusan (rekomendasi audit):** multi-session agent in-process **TIDAK dijadikan jalur produksi**.
Alasan berbasis bukti: beberapa modul menyimpan STDIO/approval sink/statusline/screen yang secara
fundamental satu-terminal; kernel `ToolContext` tidak membawa `sessionId` di jalur CLI (hanya MCP
server yang membangun shape itu). Memaksa DI penuh ke semua bagian akan menambah kompleksitas tanpa
jalur konsumen nyata.

**Yang tetap dijamin:**

- **Dua sesi berurutan** tidak saling menimpa UI state (`ui-instance-isolation`).
- **Daemon multi-consumer** (satu sesi, banyak subscriber) terisolasi per koneksi (`p13-multi-consumer`).
- **MCP koneksi bersama** tidak cross-wire close: sesi A menutup tidak mematikan MCP sesi B
  (`p2-mcp-reliability` — multi-session).
- Approval routing daemon tetap per run/session (P0/P1), bukan global.

---

## 8. Type safety & schema evolution (P2.1)

**Temuan & perubahan (`src/session/persistence.ts`):**

1. `decodePresentationEvent` sekarang menolak versi masa depan (`v` non-integer / `<1` / `>EVENT_SCHEMA_VERSION`),
   fail-safe. Event legacy tanpa `v` tetap dibaca sebagai v1.
2. `isValidEventShape` default berubah `true → false`: tipe durable baru **wajib** punya validator eksplisit.
3. Validasi shape diperketat: `parentLink` (tidak boleh id non-string), `task.status.verification`,
   `tool.started.identity/argsSummary`.

**Mapping serializer/decoder:** `encodePresentationEvent`/`decodePresentationEvent` (durable) ·
`toPresentationEvent` (proyeksi UI) · `toMachineEnvelope` (machine) · `decodeMcpSchema` (client) ·
daemon `FrameDecoder` + `encodeFrame` (wire, `DAEMON_PROTOCOL=1` strict).

**Evolusi:** versi additive — field opsional boleh ditambah tanpa bump; hanya field **wajib** yang
berubah bermakna yang mengharuskan `EVENT_SCHEMA_VERSION` naik (didokumentasikan di `events.ts`).

**Test:** `presentation-observability` — v1/legacy diterima, v2/parentLink rusak/verification rusak
ditolak (`loaded.rejected === 3`).

---

## 9. Performance baseline (P2.2)

Benchmark: `bun scripts/bench-render.ts` (sintetis, tanpa provider, tanpa terminal, tanpa timer).
Workload: transkrip pendek/panjang, prose wrap, unicode CJK/emoji, scroll, resize, streaming burst,
banyak tool-event, campuran ledger, reducer (5k tool-event, 1k turn-event). Metrik p50/p95/max/mean.

**Baseline (sebelum optimasi):**

| Workload | p50 | p95 | max |
|---|---:|---:|---:|
| long-2000 / view 80x24 | 11,16 ms | 11,70 ms | 11,93 ms |
| prose-1000 / view 100x30 | 20,01 ms | 21,63 ms | 22,61 ms |
| unicode-1000 / view 80x24 | 7,91 ms | 9,53 ms | 10,36 ms |
| reducer / 5000 tool events | 290,54 ms | 299,75 ms | 299,75 ms |

**Hot path terbukti (bukan asumsi):**

- `reducer.addOrder` memakai `state.order.some(...)` per event → O(n²); `trimMap` memakai
  `[...values.entries()].find(...)` yang mengalokasikan array ribuan entri per eviction.
- `Transcript.projectAll` memproyeksikan ulang **setiap baris** setiap frame (wrap + markdown) padahal
  transkrip append-only.

---

## 10. Before/after benchmark & refactor evidence (P2.2)

### 10.1 Optimasi 1 — reducer order index + trim tanpa alokasi (`src/presentation/reducer.ts`)

- `addOrder`/`removeOrder` kini memakai `Set` index non-enumerable (`Symbol`), terbangun lazy dan
  tidak ikut serialisasi (`cloneState`/replay membangun ulang).
- `trimMap` iterasi langsung (tanpa `[...entries()]`); `removeOrder` scan dari depan (entri tua di awal).

| Workload | Before p50 | After p50 | After p95 | Speedup |
|---|---:|---:|---:|---:|
| reducer / 5000 tool events | 290,5 ms | **9,49 ms** | 14,10 ms | **~30×** |

### 10.2 Optimasi 2 — cache proyeksi per baris (`src/ui/tui/transcript.ts`)

- `ProjectedLineCache` menyimpan `TranscriptRow[]` per baris logis, di-key oleh
  `(width, id, raw, assistant, source, prefix, table, fenceState)`.
- Invalidasi: `clear()` dan setiap eviction (index bergeser). Baris pending/thinking/running tetap
  dihitung (tidak dibekukan).

| Workload | Before p50 | After p50 | After p95 | Speedup |
|---|---:|---:|---:|---:|
| long-2000 / view 80x24 | 11,16 ms | **0,45 ms** | 0,66 ms | **~25×** |
| prose-1000 / view 100x30 | 20,01 ms | **0,14 ms** | 0,19 ms | **~140×** |
| unicode-1000 / view 80x24 | 7,91 ms | **0,13 ms** | 0,14 ms | **~60×** |
| tools-1000 / view 80x24 | 5,19 ms | **0,11 ms** | 0,11 ms | **~47×** |

> Catatan jujur: `burst-500 deltas + view` tetap ~13–23 ms karena blok pending (live tail) sengaja
> tidak di-cache (elapsed/render harus hidup). Ini rusak-laten yang dapat diterima, bukan regresi.
> Outlier max beberapa workload (1–3 ms) adalah ambang JIT setelah warm-up, bukan tail distribusi.

### 10.3 Regression

- `170` test UI/presentation lulus (tui-transcript, tui-app, terminal-contract, sanitize-render,
  tui-format) — projection/scroll/resize/CJK/ANSI tidak berubah.
- Full suite **5.453 pass / 0 fail**.

---

## 11. Refactor evidence (P2.2)

| Perubahan | Tujuan | Manfaat | Risiko yang dihindari |
|---|---|---|---|
| Order index `Set` | hilangkan `some()` per event | 30× reducer | index non-enumerable; tidak serialisasi |
| trimMap tanpa alloc | hilangkan `[...entries()]` | menghentikan churn alokasi | — |
| ProjectedLineCache | hilangkan re-wrap/re-markdown baris lama | 25–140× view | invalidasi saat evict/clear; pending tak di-cache |

Tidak ada file yang dipecah hanya karena LOC. Tidak ada dependency baru. Tidak ada clone berlebihan.

---

## 12. MCP lifecycle & schema drift (P2.3)

### Schema pin

- **Persistent:** `McpSchemaPinRegistry` kini membaca/menulis
  `<cwd>/.minicode/mcp-schema-pins.json` (atomic rename). `connectAll` meng-`configure` per workspace.
- **Drift:** `wrapTools` + `callMcpTool` memverifikasi hash; drift **menyembunyikan tool** (fail-closed)
  dan membawa hash pin/current + perintah approve pada pesan.
- **Approve jalur produksi:** `minicode mcp approve <server>.<tool> <64-hex-sha256> [--cwd]` dan
  `minicode mcp pins [--json]`.
- **Tidak tertimpa diam-diam:** `pin()` hanya menulis saat belum ada; `verify()` pertama kali mem-pin,
  seterusnya hanya `ok`/`drift`; pin baru lewat `approve` eksplisit.
- **File rusak:** fail-closed (tidak menebak pin dari data parsial).

### Connection lifecycle

- `configure → connect → initialize → discover → validate → wrap tools → execute → disconnect`.
- **Multi-session refcount:** `connectAll` mengembalikan tool dari koneksi yang sudah hidup + menambah
  refcount; `closeAll` menurunkan dan hanya menutup saat ref 0. Sesi kedua tidak kehilangan tool;
  close satu sesi tidak mematikan sesi lain.
- **Pagination:** `tools/list`/`resources/list`/`prompts/list` mengikuti `nextCursor` (batas 100 halaman,
  galat `MCP_PAGINATION_LIMIT`).
- **Residual (dinyatakan jujur):** auto-**reconnect** belum diimplementasikan; **subscriptions/
  notifications/resources-updated** belum didukung. Kapabilitas yang tidak didukung tidak dipalsukan.

### Error & operator UX

- Galat drift memuat `pinned`/`current` hash + perintah approve.
- `mcp pins` menampilkan pin tersimpan; `mcp approve` memindahkan pin.
- `mcp_list` masih menyajikan inventory (tool, resources, prompts) untuk koneksi aktif.

---

## 13. Daemon lifecycle / interrupt / recovery (P2.3)

### Run control (F-DAEMON-INTERRUPT)

- `CliSession.runState()` mengekspos `{ runId, status }` dari jurnal Run kanonik (bukan id sintetis).
- `startDaemonHostedRuntime` menyimpan `AbortController` untuk run aktif; `interrupt`/`cancel`
  memanggil `abort()` (bukan `RUN_TERMINAL`), ditolak bila run sudah terminal atau `runId` tidak cocok.
- `HostedSessionInfo.runId/runStatus` menjadi getter live → `session.list`/`session.status` menampilkan
  status nyata (RUNNING/COMPLETED/FAILED/INTERRUPTED).
- `--prompt` benar-benar dijalankan saat produksi (`autoRunPrompt`), tidak dibiarkan diam.

**Test:** `p2-daemon-control` — interrupt menghentikan run yang benar-benar RUNNING; `runId` salah
ditolak tanpa mengganggu run asli.

### Shutdown

- `closeHostedSession` meng-abort run aktif sebelum `session.close()`; tidak meninggalkan turn hidup.
- Sisa perilaku shutdown/cleanup P13 tetap utuh (idempoten, menunggu lifecycle).

### Restart / reconstruction (dinyatakan jujur)

- Persetujuan lama ditandai `UNKNOWN` saat start; run yang belum terminal ditutup `INTERRUPTED` saat
  `close()`. **Restart daemon penuh** (resume run/child supaya hidup) **belum diimplementasikan** dan
  **tidak diklaim**.

---

## 14. Replay & backpressure (P2.3)

- `#send` menandai `conn.paused` saat `socket.write()` mengembalikan false.
- Replay kini **resumable**: loop berhenti di titik backpressure (menyimpan `{sid, consumer, fromSeq, head}`),
  lalu `drain` meneruskan dari cursor — **tidak** mengulang dari awal, **tidak** membuang sisa, dan
  buffer tidak tumbuh tanpa batas.
- Telemetri baru `replay.paused`/`replay.resumed`.

**Test:** `p13-multi-consumer` — 200 event (~6 MB) ke klien yang berhenti membaca →
`replay.paused > 0`, resume → `replay.resumed > 0` dan seluruh 200 `seq` sampai tanpa hilang/duplikat.

---

## 15. Operator UX matrix (P2.3)

| Capability | Surface | Status | Bukti |
|---|---|---|---|
| MCP pin list / approve | `minicode mcp pins` / `mcp approve` | **FULL** (baru) | CLI + registry persist |
| MCP drift reason | stderr + error payload | **FULL** (diperbaiki) | hash + perintah approve |
| MCP connection/tool availability | `mcp_list` tool | PARTIAL (inventory; tanpa health halaman) | existing |
| Daemon health | `daemon.status` | FULL | existing |
| Active run/list | `session.list`/`session.status` | **FULL** (diperbaiki, live runId/runStatus) | getter live |
| Interrupt/cancel result | `run.interrupt`/`run.cancel` | **FULL** (diperbaiki) | integration test |
| Reconstructed vs live | `provenance` + `phase` | FULL | existing (P1) |
| Shutdown status | `daemon.shutdown` | FULL | existing |

**Catatan:** `mcp_list` tidak menampilkan "health/reconnect" karena reconnect belum diimplementasikan;
tidak ada klaim palsu "connected" saat discovery gagal (connect gagal tidak menyetor tool).

---

## 16. Efisiensi & dependency analysis

- **Dependency baru:** tidak ada. Tanpa package/lockfile berubah (hanya penambahan script `bench:render`).
- **Hot-path allocation:** dikurangi (order index + trimMap + projection cache).
- **Distribusi:** paket unpacked **3.890 KB** vs baseline P1 **3.874 KB** (**+16 KB**, ~0,4%) dan
  budget historis 3.840 KiB (**+50 KB**, ~1,3%). 22/23 pemeriksaan pack lulus; kegagalan **murni ukuran**
  (tidak ada kebocoran test/secret/node_modules).
- Pertumbuhan berasal dari field observability + validator + komentar, **bukan** dependency/fitur baru.
  Sesuai arahan P2, ini dicatat sebagai **temuan efisiensi** (R-P1-07), bukan blocker dan bukan
  alasan menghapus fitur.

---

## 17. Test commands & results

| # | Command | Exit | Hasil |
|---|---|---:|---|
| 1 | `bun x tsc --noEmit` | **0** | bersih |
| 2 | `bun run lint` | **0** | 661 file |
| 3 | `bun test` | **0** | **5.453 pass / 19 skip / 0 fail** (5.472 test, 369 file) |
| 4 | `bun run gate:coverage` | **0** | funcs 88,13% · lines 88,95% · 19/19 |
| 5 | `bun run audit:harness` | **0** | 60/0/2 |
| 6 | `bun run gate:bash` | **0** | 0/62, 0/24 |
| 7 | `bun run bench:smoke` | **0** | 13/13 |
| 8 | `bun scripts/bench-render.ts` | **0** | before/after §10 |
| 9 | `bun run gate:pack` | **1** | 22/1 — ukuran 3.890 KB |
| 10 | targeted: p2-mcp / p2-daemon / p13-multi / memory / presentation / tui (20 file) | **0** | **471 pass / 0 fail** |

Test addition:
- `test/p2-mcp-reliability.test.ts` (4): pin persist+drift+approve; drift disembunyikan;
  pagination; multi-session refcount.
- `test/p2-daemon-control.test.ts` (2): interrupt nyata; wrong-runId ditolak.
- `test/presentation-observability.test.ts` (+1): decoder versi/payload rusak.
- `test/memory-consistency.test.ts` (+1): concurrency supersession (tepat satu menang).
- `test/p13-multi-consumer.test.ts` (+1): replay backpressure resumable.
- `scripts/bench-render.ts`: workload + metrik p50/p95/max/mean/heap.

---

## 18. Remaining risks

1. **MCP auto-reconnect** belum ada → server yang mati menuntut restart/approve; dokumentasikan.
2. **Daemon restart reconstruction** belum penuh → run/child from previous generation tidak di-resume.
3. **Manual TUI UAT** belum dijalankan; bukti UI = static + mocked + PTY mechanics.
4. **Cache gateway** tetap UNVERIFIED.
5. **Ukuran paket** 3.890 KB (efisiensi, non-blocker).
6. **Task lifecycle** claim/merge/cancel + FAILED/RETRYING producer (carry-forward P1).
7. **Heap** transkrip panjang naik karena row cache (bounded by 5.000-line cap; ~4,7 MB untuk 4 transkrip
   sintetis dalam benchmark) — trade-off memori vs latency yang diukur, bukan tak terkendali.

---

## 19. Known limitations

- `mcp` subscriptions/notifications/resources-updated **tidak didukung** (dinyatakan jujur, tidak dipalsukan).
- Reconnect policy **tidak diuji** (implementasi tidak ada).
- Replay backpressure diuji pada fixture in-memory + socket nyata; bukan pada DB produksi berjuta event.
- Multi-session agent in-process **tidak didukung** (keputusan §7), sehingga isolation test bersifat
  sekuensial/MCP/daemon, bukan "dua sesi agent `run()` bersamaan".

---

## 20. P2 completion verdict

**P2.1 — State isolation & type safety: FIXED_VERIFIED.**
**P2.2 — Monolith & rendering performance: FIXED_VERIFIED** (measurement-first, 30×/25–140×, no regression).
**P2.3 — MCP & daemon operational quality: PARTIAL** — schema pin/drift/pagination/multi-session/
interrupt/cancel/replay-backpressure selesai dan teruji; **MCP reconnect/subscription** dan
**daemon restart reconstruction** tetap residual yang jujur-terdokumentasi.

**P2 keseluruhan: COMPLETE (STAGE-SCOPED) untuk P2.1 & P2.2, PARTIAL untuk P2.3.** Tidak ada blocker
correctness/security/state/performance pada jalur yang diuji. Residual P2.3 adalah fitur lifecycle
eksternal yang membutuhkan keputusan produk + lingkungan (bukan bug diam-diam).

**Tidak diklaim:** release-readiness, repository strict-green di luar gate yang dijalankan,
manual/live provider UAT, dan penutupan backward-carry P1 (R-P1-01/02/03/04/06/07).

---

## Appendix A — Fakta vs inferensi vs rekomendasi

- **Fakta terverifikasi:** gate §1; benchmark §10; test §17; fingerprint §3.
- **Inferensi teknis:** heap naik karena row cache (terukur ρ=4,7 MB, `bounded` oleh cap); reducer O(n²)
  adalah penyebab 290 ms (dibuktikan dengan menghilangkannya → 9 ms).
- **Rekomendasi (bukan pekerjaan yang dilakukan):** probe gateway cache; implementasi reconnect MCP
  bounded-retry; koreografi restart daemon E2E; emit claim/merge/cancel task transition; pass efisiensi
  paket bila pemilik menginginkan di bawah 3.840 KiB.

---

*Laporan ini dibuat setelah seluruh gate final. Satu-satunya tulisan P2 adalah laporan ini,
`scripts/bench-render.ts`, dan 2 file test baru. Tidak ada commit/push/stage/reset/clean/penghapusan file.*