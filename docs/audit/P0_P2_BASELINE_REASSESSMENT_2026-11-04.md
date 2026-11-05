# P0–P2 Baseline Reassessment — MiniCode (2026-11-04)

**Jenis:** audit ulang menyeluruh, read-only, berbasis bukti
**Kandidat audit:** `HEAD=cb602124571d8e4638bdb47d38400c52d8fba976` + **working tree kotor**
**Branch:** `main` · **Versi package:** `0.13.1` · `git describe`: `v0.13.1-1-gcb60212`
**Sidik jari kandidat:** `diff_hash=0d0a98b8ecac1dabc60f78136850cce0ff055103` · `status_sha256=6649963DB92B1EEB141490B3DEAD5CBF4192878BCAB5F134E7076FAE5C9B8339`
**Status stabilitas tree:** **STABIL SELAMA AUDIT** (sidik jari awal = akhir; tidak ada perubahan tracked/untracked yang terdeteksi)
**Laporan baru ini adalah satu-satunya tulisan di dalam repository.**

> **Peringatan ruang lingkup.** Seluruh status di laporan ini **stage-scoped** pada kandidat
> `cb60212` + working tree tersebut. Tidak ada klaim “repository hijau”, “P0/P1 selesai”,
> “release-ready”, atau penutupan track Quality Remediation. Full `bun test`, full coverage,
> `gate:pack`, `tsc`, lint, PTY, dan live-provider **tidak dijalankan** dalam audit ini
> (dilarang brief tanpa otorisasi terpisah). Angka suite penuh dari laporan lama tetap
> **historical**, bukan hasil audit ini.

---

## 0. Kandidat, referensi, dan batas bukti

### 0.1 Apa yang benar-benar diaudit

| Dimensi | Nilai |
|---|---|
| Commit HEAD | `cb602124571d8e4638bdb47d38400c52d8fba976` |
| Parent HEAD | `57c59d363b3f7bafca07c050992f6ffccb227463` (= `origin/main`) |
| Remote tracking | `origin/main = 57c59d3`; `main` **ahead 1** dari remote-tracking lokal |
| Tag | `v0.13.0` menunjuk `1cd3a92`; tidak ada tag di HEAD |
| Staged | **0** |
| Tracked modified | **64 file**, `+3360 / −443` |
| Untracked | **43 path** (14 source/test baru, 8 laporan audit, 21 debris/artefak) |
| Stash | kosong |
| Worktree lain | tidak ada (`git worktree list` hanya `D:/Github/minicode`) |
| Proses agent/test aktif | tidak ada `bun.exe`/`minicode.exe`; hanya dua proses `node.exe` milik router lokal (9router), bukan agent repo |

**Kesimpulan kandidat:** kondisi sekarang **bukan satu commit** dan **bukan** “`cb60212` bersih”.
Yang diuji adalah **gabungan `cb60212` + 64 file modified + 14 file source/test untracked**.
Semua nomor baris di laporan ini merujuk ke snapshot working tree tersebut.

### 0.2 Referensi yang ditemukan (dan lokasi aktual)

| Referensi brief | Lokasi aktual | Status |
|---|---|---|
| `LIVE_UAT_HARNESS_0.13.x_REPORT_2026-11-02.md` | `docs/audit/LIVE_UAT_HARNESS_0.13.x_REPORT_2026-11-02.md` | ada, 20.322 byte |
| UI/UX deep audit | `docs/audit/UI_UX_PRESENTATION_AND_DISCUSS_MODE_DEEP_AUDIT.md` | ada, 44.325 byte |
| `docs/FRONTIER_HARNESS_BASELINE_AND_HANDOFF.md` | `docs/FRONTIER_HARNESS_BASELINE_AND_HANDOFF.md` | ada; registry **25 ID** (LOOP 5 + TOOL 5 + MEM 4 + CTX 5 + CTL 6) |
| Laporan P0/P1/P2 yang lebih baru | `docs/audit/P0_BASELINE…`, `P1_INTEGRATED…`, `P1_COMPLETION…`, `P1_OBSERVABILITY…`, `P1_REMAINING…`, `FINAL_INTEGRATION…`; `CODE_QUALITY_AUDIT_2026-11-04.md` di root | ada, semuanya **untracked** |
| `677d77d`, `54715d6`, `57c59d3`, `cb60212` | semuanya ancestor HEAD | terverifikasi via `git merge-base --is-ancestor` |

Tidak ada dokumen referensi yang hilang. `54715d6` adalah commit dokumen di branch
`refs/remotes/origin/research/frontier-harness-baseline`; ia tidak boleh dicampur dengan
baseline kode `57c59d3`/`cb60212`.

### 0.3 Klasifikasi bukti yang dipakai

| Label | Arti |
|---|---|
| **STATIC** | Dibaca langsung dari source + call path produksi |
| **UNIT-TARGETED** | Test terarah dijalankan pada audit ini; assertion dikutip |
| **PROBE** | Reproduksi read-only di luar repo dengan mengimpor modul repo |
| **HISTORICAL-UAT** | Angka/perilaku dari laporan UAT lama; **tidak dijalankan ulang** |
| **HISTORICAL-GATE** | Angka gate dari laporan lama; bukan hasil audit ini |
| **UNVERIFIED** | Belum cukup bukti; tidak boleh diklaim benar/salah |

Status finding hanya memakai himpunan brief: `FIXED_VERIFIED`, `FIXED_CODE_ONLY`,
`PARTIAL`, `NOT_FIXED`, `REGRESSION`, `UNVERIFIED`, `BLOCKED`, `NOT_APPLICABLE`.

---

## 1. Executive verdict (§6.1)

### 1.1 Ringkasan satu paragraf

Baseline `cb60212` **terverifikasi persis** sebagai commit UAT 7 file `+105/−6`, tetapi
**seluruh pekerjaan remediasi P0/P1/P2 setelah UAT masih uncommitted** (64 file tracked,
`+3360/−443`, plus 14 file source/test baru). Pekerjaan itu nyata dan sebagian sudah
terverifikasi: hint DISCUSS/PLAN, derivasi `READONLY_TOOLS` dari registry, validasi
`supersedes_id`, tombstone seluruh chunk, approval binding dua lapis, `task.status` ledger,
fase replay→live daemon, dan state UI per-sesi semuanya ada di source dan lulus test terarah.
Namun **tidak ada satu pun dari 11 item induk yang tertutup penuh**. Sepuluh item berstatus
`PARTIAL`; P2.2 berstatus `NOT_FIXED` (monolith tidak dipecah, performa tidak terukur).
Tiga gap paling berbahaya yang **masih terbuka dan dapat direproduksi**: (a) sesi yang mulai
di DISCUSS/PLAN lalu naik ke EXECUTE mengiklankan 37 tool tetapi hanya 12/15 yang bisa
dipanggil (`unknown tool`); (b) `memory reconcile` mengadopsi ulang fakta yang sudah
di-supersede ke `MEMORY.md` sehingga masuk lagi ke system prompt; (c) PLAN masih dapat
melakukan mutasi lewat hooks, dan `--verify`/self-heal berjalan di luar ceiling WorkMode.

### 1.2 Tally status

**Item induk (11, sesuai brief):**

| Status | Jumlah | Item |
|---|---:|---|
| `FIXED_VERIFIED` | 0 | — |
| `FIXED_CODE_ONLY` | 0 | — |
| `PARTIAL` | **10** | P0.1, P0.2, P1.1, P1.2, P1.3, P1.4, P1.5, P1.6, P2.1, P2.3 |
| `NOT_FIXED` | **1** | P2.2 |
| `REGRESSION` | 0 | — |
| `UNVERIFIED` | 0 | — |
| `BLOCKED` | 0 | — |
| `NOT_APPLICABLE` | 0 | — |

**Subfinding (40 kartu di §3):**

| Status | Jumlah |
|---|---:|
| `FIXED_VERIFIED` | 13 |
| `FIXED_CODE_ONLY` | 0 (empat fix UAT dihitung terpisah di §6) |
| `PARTIAL` | 7 |
| `NOT_FIXED` | 19 |
| `UNVERIFIED` | 1 |
| `REGRESSION` | 0 |
| `BLOCKED` | 0 |

### 1.3 Lima risiko paling penting

1. **Seluruh remediasi belum di-commit dan laporan saling bertentangan.** `ROADMAP.md`
   masih menyebut checkpoint `2d9e11e` dan “133 modified”; laporan di repo menyebut
   5.315, 5.333, 5.372, 5.411, dan 5.409 pass (yang terakhir dengan 2 fail). Tidak ada
   kandidat final yang sama. Risiko: pekerjaan 3.360 baris bisa hilang/tercampur, dan
   klaim “hijau” tidak dapat direproduksi dari commit mana pun.
2. **Reveal-after-start mematahkan eskalasi WorkMode runtime (G1).** `registry.get()`
   memakai map yang dibekukan saat konstruksi (`vendor/minicore/src/core/tool.ts:110-115`),
   sedangkan daftar yang diiklankan memakai array live (`src/app/tool-layer.ts:132-138`).
   Probe audit: mulai DISCUSS (12 tool) → `setWorkMode("EXECUTE")` → `list=37` tetapi
   `get("write_file")=false`. Model melihat tool yang pasti gagal dengan “unknown tool”.
3. **Supersession memori bisa dibatalkan oleh `memory reconcile`.** `reconcileMemoryStores`
   membaca **semua** baris tanpa filter `superseded_by` (`src/memory/vector.ts:1539`) lalu
   menambahkan kembali entri “vector-only” ke `MEMORY.md` (`:1602-1624`). Karena supersession
   menghapus baris lama dari file, reconcile berikutnya menghidupkan fakta lama kembali ke
   `read_memory` kosong, `file hits:`, dan system prompt (`src/policy/context.ts:241-246`).
4. **PLAN bukan read-only penuh secara efek.** Hooks berjalan untuk PLAN (hanya DISCUSS yang
   diblokir: `src/hooks/run.ts:27-33`), dan hooks adalah Node arbitrer dengan FS/network
   (`:75-79`). `--verify`/self-heal juga dijalankan di luar ceiling WorkMode
   (`cli/setup.ts:2233-2236`, `2280-2282`, `2676`, `2687-2725`). Ini bertentangan dengan
   hint “Do NOT modify files” (`src/app/session.ts:100-105`).
5. **Daemon tidak dapat menghentikan turn yang berjalan.** `run.interrupt` dan `run.cancel`
   di composition root produksi selalu mengembalikan `RUN_TERMINAL`
   (`cli/commands/daemon.ts:245-256`), dan hosted session didaftarkan dengan
   `runId:null, runStatus:null` (`:354-361`). Operator tidak punya jalur protokol untuk
   stop/cancel. (Risiko setara: pin skema MCP hanya in-memory dan tidak pernah dipersist —
   lihat P2.3.)

### 1.4 Yang belum boleh diklaim

- **Jangan** klaim “P0/P1/P2 selesai”, “repository hijau”, “release-ready”, atau
  “Quality Remediation Stage 1–10 tertutup”.
- **Jangan** klaim UI “teruji” berdasarkan `exec --json`/headless. Audit ini **tidak**
  menjalankan PTY maupun UAT terminal nyata; bukti UI di sini adalah **STATIC** +
  **UNIT-TARGETED** saja.
- **Jangan** klaim performa rendering. Tidak ada harness benchmark UI; semua angka
  performa berstatus **UNKNOWN**.
- **Jangan** klaim remote terkini. Tidak ada `fetch/pull`; hanya remote-tracking lokal.
- **Jangan** mengutip angka suite penuh audit ini. Angka 5.3k–5.4k di laporan lama adalah
  **HISTORICAL-GATE** pada checkpoint masing-masing.

---

## 2. Master P0–P2 matrix (§6.2)

Legenda status: `FV`=FIXED_VERIFIED · `FCO`=FIXED_CODE_ONLY · `P`=PARTIAL · `NF`=NOT_FIXED ·
`REG`=REGRESSION · `UNV`=UNVERIFIED · `BLK`=BLOCKED · `NA`=NOT_APPLICABLE.

| Priority | Item | Original acceptance criteria (ringkas) | Current implementation | Evidence/tests | Status | Residual gap/risk | Dependencies | Recommended next decision |
|---|---|---|---|---|---|---|---|---|
| **P0.1** | Verifikasi baseline & provenance | `cb60212` ada, isi persis 7 file +105/−6; relasi dengan `57c59d3`/HEAD; inventaris working tree; tidak ada perubahan tak terjelaskan | HEAD memang `cb60212`; parent `57c59d3`; commit persis 7 file `+105/−6`. Namun 64 file `+3360/−443` + 14 source/test baru **uncommitted**; 8 laporan + 21 debris untracked; tidak ada commit setelah UAT | `git show --stat cb60212`; `git diff --numstat 57c59d3..cb60212`; `git status --porcelain=v2`; fingerprint | **P** | Provenance tiap perubahan tak bisa dibuktikan dari commit (tidak ada commit); 5 angka suite berbeda; `ROADMAP.md` stale (`2d9e11e`, 133 modified) | — | Tetapkan strategi commit/checkpoint kandidat tunggal sebelum klaim apa pun |
| **P0.2** | Kontrak WorkMode DISCUSS/PLAN/EXECUTE | Tiga mode, bukan mode ke-4; terpisah dari PermissionMode; prompt, visibility, dispatch, approval, subagent, resume, surface parity terdokumentasi & ditegakkan | Enum 3 mode + ceiling (`work-mode.ts`); hint DISCUSS/PLAN ada (`session.ts:91-105`); default EXECUTE; resume tidak persist. Gap: hooks PLAN, PLAN×allowlist, reveal bug, daemon selalu EXECUTE, ACP tak menggemakan | `test/work-mode-prompt` (lulus), `work-mode-contract` (36), `work-mode-runtime`; probe | **P** | PLAN tidak benar-benar read-only (hooks/verify); visibility≠dispatch; daemon/ACP parity | P1.1, P1.2 | Putuskan Q1 (DISCUSS read-only vs conversation-only), Q3 (web read), Q4 (label), lalu kunci kontrak |
| **P1.1** | Tool visibility & enforcement | Setiap tool punya efek terklasifikasi; tool terlihat = dapat dipanggil atau sengaja ditolak dengan jelas; tidak ada mutasi lewat jalur tak langsung | Registry kontrak tunggal (`tool-contract.ts`); `READONLY_TOOLS` kini diturunkan (`permission.ts:30,57`); ceiling menolak write/exec. Gap: reveal-after-start, 6 tool hidden-but-allowed, PLAN×allowlist, read_memory network/DB, verify/hook | `test/work-mode-tool-visibility` (19), `work-mode-contract`; probe registry; `p15` contract | **P** | G1 fungsional; network read tersembunyi; hooks/verify di luar ceiling | P0.2 | Kunci invarian “visible ⊆ callable atau sengaja denied”; tambah drift test |
| **P1.2** | UI WorkMode, approval, status | Mode terlihat & mudah diubah; status agent lengkap; approval menampilkan target/risiko/efek/pilihan; preview terikat operasi; UI menampilkan state backend | Approval risk+diff+binding dua lapis (`permission.ts`, `approval-binding.ts`); footer WorkMode non-default; `/work-mode`; task ledger; child run marker. Gap: TUI drops ACE/cutoff/verification, deny reason hilang, `/work-mode` tak discoverable, default EXECUTE invisible, `always` no-op >2KB, stderr saat alt-screen | `test/approval-integrity` (10), `approval-tui`, `work-mode-runtime`, `writer-inventory`; 52 pass | **P** | Presentasi tidak konsisten antarsurface; TUI kehilangan diagnostik | P1.5, P1.6 | Putuskan apakah TUI wajib merender diagnostics; perbaiki occupancy meter |
| **P1.3** | Memory supersession integrity | ID stabil diekspos; `supersedes_id` divalidasi; dua sisi konsisten & atomik; invalid/foreign/stale/cycle/concurrent ditangani; retrieval mengecualikan superseded; tidak ada no-op diam | Validasi pra-tulis + dalam transaksi (`tools/memory.ts:183-193`, `vector.ts:616-627`); id diekspos `[id:…]`; tombstone `id OR parent` di 3 jalur. Gap: reconcile resurrection, chunk-id target, stale overwrite, concurrency, provenance UI | `p20` + `memory-consistency` (31 pass); `coverage-gaps:107-120`; probe baca | **P** | Reconcile menghidupkan fakta lama; target chunk hanya menombstone 1 chunk | P2.3 (reconcile) | Putuskan semantik reconcile terhadap baris superseded; tambah test dua-sisi + retrieval |
| **P1.4** | Context & token observability | Usage kumulatif vs delta; gate anti-sampel; actual vs estimate vs capacity vs compaction vs cost terbedakan; tidak mengarang biaya | Gate in-flight ada (`context.ts:101-112`, cap 64); collector delta (`usage.ts`); biaya `undefined` bila tarif tak dikenal. Gap: footer `%` = total sesi/window; `context.window` = output token saat cutoff; cache tokens diabaikan adapter OpenAI-compat; `exec --json` tanpa context/capacity | Probe gate (factor stabil); `p19` delta & cap; `p15` 1.8×; `errors-usage`; probe friendlyError | **P** | Meter occupancy salah; cache/cost telemetry hilang; gate tanpa test repo | — | Putuskan metrik resmi “context occupancy” vs “session spend”; probe gateway cache |
| **P1.5** | ACE & verification visibility | Producer→event→adapter→projection→surface konsisten; operator tahu tindakan; tidak ada UI PASS saat backend UNKNOWN | Event `consequence.decided`/`verification.observed` ada; machine envelope lengkap; severity FAIL/BLOCKED=error. Gap: TUI membuang ketiganya; `task.status` hanya saat verify; `machineStatus(consequence)=completed` | `presentation-observability`, `presentation-policy`, `p18`; static transcript | **P** | TUI buta ACE/verification; semantic status mismatch | P1.2 | Putuskan apakah `consequence.decided` harus `interrupted`/`failed` di machine status |
| **P1.6** | Task & subagent observability | ID kanonik, DAG, lease, status, parent-child, progress, result, cancel, orphan, machine output | TaskStore kanonik + `task.status` ledger + `childRunId`/run marker. Gap: machine envelope memakai sessionId induk & tanpa childRunId → potensi eventId collision; `FAILED/RETRYING` tak punya writer; child result hanya di receipt induk | `presentation-projections`, `presentation-observability`, `test/presentation-subagent`, `phase6b` | **P** | Identitas anak hilang di machine stream; lifecycle task tidak terlihat kecuali verify | P1.5, P2.1 | Kunci kontrak identitas event machine (childSessionId/runId) |
| **P2.1** | State isolation & type safety | Inventaris env-write/module singleton; ownership/lifecycle; unsafe any di boundary; version drift; test konkurensi | UI state pindah ke `UiSessionState` per sesi (`session-state.ts`); setter tak menulis env; test dua instance nyata. Gap: `todoSession`, `askTextFn`, `submit_result`, `pending-tools`, MCP global, locale global; test tidak benar-benar konkuren; durable event tanpa versi | `test/ui-instance-isolation` (5), `tui-format`; grep env-write | **P** | Dua sesi satu proses masih cross-wire tool/ask/locale; bukan bug teramati di CLI single-session | P2.3 | Putuskan apakah multi-session in-process adalah jalur produksi |
| **P2.2** | Monolith & rendering performance | Ukuran/responsibility; call graph; frame scheduling; backpressure; CPU/memory; writer ownership; Unicode/ANSI | `TuiApp` 1.349 baris, transcript 961, simple 865, adapter 1.319, setup 3.384; repaint 30 ms tapi **per-key paint sinkron**; projection+snapshot penuh per frame. Tidak ada harness perf | Static + `test/writer-inventory` (batas writer); tidak ada benchmark | **NF** | Risiko input-latency/paste freeze; angka FPS/memori **UNKNOWN**; writer inventory tak menangkap timing | — | Setujui eksperimen perf minimum sebelum refactor; jangan pecah file hanya karena LOC |
| **P2.3** | MCP & daemon UX | Lifecycle, visibility, schema drift, reconnect, error, supervision, subscription, replay, backpressure, shutdown, operator action | Daemon: protokol+replay+live phase+backpressure queue+approval durable terbukti. MCP: connect/SSRF/secret scrub. Gap: pin in-memory, no reconnect/pagination/subscription, session kedua tanpa tool, `closeAll` lintas sesi, interrupt stub, replay backpressure, no restart/ACP | `p2-daemon`, `p13-multi-consumer`, `daemon-stream-phase`, `mcp-*`, `p20` pin | **P** | Supply-chain drift tak terlindungi antar-restart; turn daemon tak bisa dihentikan | P2.1 | Putuskan persist pin + jalur interrupt + status ACP/daemon |

---

## 3. Detailed evidence cards (§6.3)

Format tiap kartu: **klaim → source of truth → production path → before→after → test/assertion →
hasil/jenis → dampak → batas → status**. Nomor baris merujuk snapshot working tree.

### 3.1 P0.1 — Baseline & provenance

#### P0.1-a — Isi commit `cb60212` cocok dengan klaim UAT
- **Klaim awal:** UAT §6 menyatakan 7 file, `+105/−6`.
- **Source of truth:** `git show --stat cb60212`.
- **Hasil:** `cli/commands/exec.ts +49`, `docs/environment.md +1`, `src/policy/context.ts +20/−1`,
  `src/tools/todo.ts +14/−4`, `src/ui/render/errors.ts +8`, `test/errors-usage.test.ts +6`,
  `test/writer-inventory.test.ts +7/−1`. **Persis 7 file, 105 insertions, 6 deletions.**
- **Relasi:** parent `cb60212^ = 57c59d3`; `57c59d3` adalah `origin/main`; tidak ada commit lain
  di antara. `54715d6` dan `677d77d` adalah ancestor HEAD.
- **Jenis bukti:** STATIC (git).
- **Dampak:** baseline UAT dapat dipercaya sebagai titik awal.
- **Status:** **FIXED_VERIFIED**.

#### P0.1-b — Kandidat sekarang & provenance seluruh perubahan
- **Fakta:** 64 file tracked modified (`+3360/−443`), 43 untracked. Yang untracked mencakup
  2 source baru (`src/policy/approval-binding.ts`, `src/ui/session-state.ts`), 7 test baru,
  8 laporan audit, dan 21 artefak/debris (`.tmp-probe.ts`, `a1..g1.txt`, `t.log.*`, `t.xml`,
  `CODE_QUALITY_AUDIT_2026-11-04.md`).
- **Before→after yang dapat dibuktikan:** laporan-laporan P1/FINAL menjelaskan pekerjaan
  PROMPT 02–06; diff memang berisi perubahan yang sesuai (hint WorkMode, approval binding,
  `task.status`, `context.window`, memory reconcile). Namun **tidak ada commit** yang
  mengikat perubahan ke track/tanggal/agent tertentu.
- **Kontradiksi angka:** `P1_INTEGRATED` 5.315 pass; `P1_COMPLETION` 5.333; `P1_REMAINING`
  5.372; `FINAL_INTEGRATION` 5.411/0 fail; `CODE_QUALITY_AUDIT` 5.409/2 fail; `ROADMAP`
  4.792. Semua pada klaim “kandidat yang sama” tetapi waktu/isi berbeda.
- **`ROADMAP.md` stale:** menyebut HEAD `2d9e11e` dan “133 modified + 47 untracked”
  (`ROADMAP.md:5,52,74`), padahal HEAD `cb60212` dan 64 modified. `ROADMAP.md` juga masih
  draft uncommitted.
- **Kesimpulan:** provenance per-file **tidak dapat diputuskan** dari Git; hanya dapat
  dikaitkan ke laporan naratif. Kandidat bukan satu commit.
- **Status:** **PARTIAL**.

#### P0.1-c — Konsistensi checkpoint & kebersihan tree
- **Fakta:** 21 debris untracked di root (bukan bagian produk) + 8 laporan audit. Tidak ada
  `.gitignore` yang menutup debris ini.
- **Dampak:** `git status` tidak lagi menjadi sinyal bersih/kotor yang dapat dipercaya;
  `gate:pack`/review commit berisiko memasukkan artefak.
- **Status:** **NOT_FIXED**.

---

### 3.2 P0.2 — Kontrak WorkMode

#### P0.2-a — Tiga mode, pemisahan dari PermissionMode, prompt hint, default/resume
- **Source of truth:** `src/policy/work-mode.ts:16` (`WorkMode = DISCUSS|PLAN|EXECUTE`),
  `:56-59` (`ceilingFor`), `:117-141` (ceiling dulu, base PM kemudian).
- **Prompt:** `src/app/session.ts:91-105` — `workModeHint` DISCUSS (“read-only investigation
  and discussion mode… Read, search, and reason”) dan PLAN (“planning mode… produce a concrete
  implementation plan”). Ditambahkan setelah `planHint` PM (`:208-218`).
- **Default/resume:** `cli/args.ts:125-141` flag > env > EXECUTE; tidak dipersist (D-2);
  resume tanpa sinyal eksplisit → EXECUTE + baris stderr transparan (`docs/TERMINAL_CONTRACT.md`
  diff).
- **Before→after:** F-DISCUSS-1 (tidak ada hint) → hint ada di working tree (uncommitted).
- **Test:** `test/work-mode-prompt.test.ts` (lulus dalam batch 140) meng-assert teks hint
  mencapai system prompt; `test/work-mode-cli.test.ts` meng-assert precedence flag/env.
- **Jenis:** STATIC + UNIT-TARGETED.
- **Status:** **FIXED_VERIFIED**.

#### P0.2-b — Visibility vs dispatch vs ceiling (termasuk PLAN×allowlist)
- **Source:** `src/app/tool-layer.ts:16,27-32,64-70,121-138`; `src/policy/work-mode.ts:56-59`;
  `src/policy/permission.ts:404-419`.
- **Probe audit (read-only, di luar repo):**
  - `DISCUSS start: list=12 get(write_file)=false`
  - `setWorkMode("EXECUTE"): list=37 get(write_file)=false` ← **G1**
  - `EXECUTE→DISCUSS: list=12 get(write_file)=true get(web_fetch)=true` ← hidden-but-callable
  - `PLAN × allowlist: visible=15` termasuk `todo_write, delegate_task, submit_result`,
    padahal ceiling `allowlist`→readonly hanya mengizinkan 12. ← **G5**
- **Mekanisme G1:** `createToolRegistry` membekukan `Map` saat konstruksi
  (`vendor/minicore/src/core/tool.ts:110-115`), sedangkan `list()` mengembalikan array live.
  `src/app/session.ts:435-437` menyerahkan array live; `loop.ts:261-266` membangun schema dari
  `list()`; `executor.ts:43-44` mencari via `get()` → `unknown tool`.
- **Test gap:** `test/work-mode-runtime.test.ts:168-214` hanya meng-assert panjang array dan
  `contextTokens`, tidak pernah mendispatch tool yang baru muncul.
- **Status:** **NOT_FIXED**.

#### P0.2-c — Enforcement tak langsung (hooks/verify) & parity surface
- **Hooks:** `src/hooks/run.ts:27-33` hanya memblokir DISCUSS; PLAN×auto/ask/allow-all tetap
  menjalankan hook. Hook = Node arbitrer (`:75-79`) yang berjalan post-turn
  (`cli/setup.ts:2665,2747-2754`). `test/work-mode-hooks.test.ts:106-114` justru
  **meng-assert PLAN menjalankan hook**.
- **Verify/self-heal:** tidak digerbangi WorkMode (`cli/setup.ts:2233-2236,2280-2282,2676,
  2687-2725`); sukses verify menulis auto-memory (`:2716-2721`). `--work-mode DISCUSS --verify`
  tetap mengeksekusi shell host.
- **Parity:** daemon tidak punya `--work-mode` dan memanggil `createCliSession` tanpa
  `workMode` (`cli/commands/daemon.ts:89-103,289-318`) → selalu EXECUTE. ACP menerima
  `params.workMode` tetapi success envelope tidak menggemakannya (`cli/commands/acp.ts:465-479`).
- **Status:** **NOT_FIXED**.

---

### 3.3 P1.1 — Tool visibility & enforcement

#### P1.1-a — Registry kontrak sebagai satu sumber `READONLY_TOOLS`
- **Before:** `permission.ts` punya daftar manual 18 tool (dikutip audit lama
  `P0_BASELINE…:198`).
- **After:** `permission.ts:30,57` mengimpor `READONLY_TOOL_NAMES` dari
  `tool-contract.ts:554-556`, yang diturunkan dari `allowedInReadonly`.
- **Test:** `test/p15-phase2-contracts-approval-recovery.test.ts` meng-assert membership
  `READONLY_TOOL_NAMES` dan mirror `AUTONOMOUS_TOOL_NAMES`; lulus.
- **Status:** **FIXED_VERIFIED**.

#### P1.1-b — Tidak ada eskalasi write/exec langsung melalui ceiling
- **Bukti:** `composeWorkModePermissionHandler` mengecek ceiling lebih dulu
  (`work-mode.ts:128-135`); ceiling readonly/plan tidak pernah prompt; write/bash/commit
  ditolak sebelum base. Probe: DISCUSS×allow-all tetap tidak mengeksekusi `write_file`.
- **Subagent:** child PLAN/DISCUSS difilter ke `EXPLORE_TOOL_NAMES` dan mewarisi ceiling
  (`src/tools/task.ts:266-268,326-329,500-510`), test `work-mode-subagent` meng-assert.
- **Batas:** temuan G1/G3/G4 adalah kegagalan *visibilitas/indirect path*, bukan eskalasi
  langsung. Tidak ada REGRESSION keamanan langsung yang terbukti.
- **Status:** **FIXED_VERIFIED** (untuk invarian “ceiling tidak memperluas”).

#### P1.1-c — Reveal-after-start & hidden-but-allowed
- **Reveal-after-start:** lihat P0.2-b (G1).
- **Hidden-but-allowed (6 tool):** `web_fetch`, `web_search`, `read_image`, `git_diff`,
  `lsp_references`, `lsp_symbols` ada di `READONLY_TOOL_NAMES` tetapi tidak di
  `EXPLORE_TOOL_NAMES` (`tool-contract.ts:554-556` vs `:538-541`). Probe: DISCUSS
  `get(web_fetch)=true` tetapi `list` tidak memuatnya. Model yang menebak nama bisa
  melakukan network read tanpa approval.
- **Klasifikasi efek:** `web_*` = network read; `mcp_read/mcp_prompt` justru di-gate dan
  `allowedInReadonly=false` — perlakuan network read tidak konsisten.
- **Status:** **NOT_FIXED**.

#### P1.1-d — Efek samping `read_memory` & klasifikasi
- **Source:** `read_memory` dideklarasikan `PURE_READ`/`allowedInReadonly`
  (`tool-contract.ts:160-170`), tetapi dengan query non-kosong memanggil `searchHybrid`
  (`src/tools/memory.ts:52-57`) → embedding network (`vector.ts:1180,336`) dan update
  `access_count` (`vector.ts:1257-1264`). `trackAccess` dikunci ke PermissionMode, bukan
  WorkMode (`memory.ts:36-37`), sehingga DISCUSS×auto tetap menulis DB internal.
- **Dampak:** DISCUSS bukan “no internal state change” seperti yang diklaim kontrak.
- **Status:** **NOT_FIXED**.

---

### 3.4 P1.2 — UI WorkMode, approval, status

#### P1.2-a — Approval card, risk tier, diff preview, TOCTOU binding
- **Source:** `src/policy/permission.ts:196-201,690,769-781`; `src/policy/approval-binding.ts`
  (baru); `src/app/session.ts:357-397`; `src/ui/approval/prompt.ts:85-118`.
- **Mekanisme:** hash args kanonis + fingerprint isi file diambil **sebelum** prompt,
  diverifikasi setelah jawaban dan sekali lagi di effect barrier; grant sekali pakai.
- **Test:** `test/approval-integrity.test.ts` (10 test; perubahan file saat prompt → deny
  `"stale"`), `test/approval-tui.test.ts` (kartu menampilkan tier+diff). Batch 140 lulus.
- **Batas:** bash hanya mem-fingerprint args (efek eksternal tak bisa); `always` melewati
  binding. ACP menghilangkan `riskTier`/`diffPreview` (`cli/commands/acp.ts:170-179`).
- **Status:** **FIXED_VERIFIED** untuk core TUI/one-shot; parity ACP tetap gap.

#### P1.2-b — Label & discoverability WorkMode
- **Ada:** footer `<WorkMode>·<PM>` hanya saat non-EXECUTE (`src/ui/footer.ts:69-79`);
  one-shot/exec menulis satu baris stderr saat non-EXECUTE (`cli/index.ts:573-581`,
  `cli/commands/exec.ts:114-122`); `exec --json` selalu punya `summary.workMode`
  (`exec.ts:305-308`); `/work-mode` di TUI (`cli/tui.ts:443-464`).
- **Gap:** `/work-mode` tidak ada di help, `DRIVER_COMMANDS`, atau saran slash
  (`cli/index.ts:94`, `cli/tui.ts:52,239-247`); default EXECUTE tidak terlihat; daemon
  selalu EXECUTE; ACP tidak menggemakan.
- **Status:** **PARTIAL**.

#### P1.2-c — Status/task/agent rendering
- **Ada:** ledger `t<n> <status> parent=… dependsOn=[…] r<rev>` (`transcript.ts:842-867`);
  baris anak `↳ run_<8>`/`sub_<8>` (`transcript.ts:789-810`); linear memproyeksikan hal sama
  (`simple.ts:428-478`).
- **Gap:** `task.status` hanya diproduksi setelah verify-settle (`cli/setup.ts:2402`), jadi
  lifecycle todo biasa tidak muncul; `FAILED`/`RETRYING` tak punya writer produksi.
- **Status:** **PARTIAL**.

#### P1.2-d — Diagnostik TUI, deny reason, `always`, ownership stderr
- **Diagnostik:** `presentationEvent` membuang semua non-`tool.*` kecuali `task.status`
  (`transcript.ts:663-667`), sehingga `verification.observed` (yang ditangani di
  `:708-710`) **tidak pernah tercapai**; `consequence.decided`/`context.cutoff`/
  `context.window` juga dibuang. Reducer menyimpannya di `diagnostics`, tetapi tidak ada
  consumer UI.
- **Deny reason:** TUI mencetak `denied` tanpa `denyReason` (`transcript.ts:739-764`),
  sedangkan linear menampilkannya (`simple.ts:382-411,490-507`) dan machine punya
  `payload.reason`.
- **`always`:** `saveAlways` no-op untuk args JSON >2000 char (`permission.ts:385-386`),
  tetapi UI tetap menawarkan “always” (`prompt.ts:112`).
- **Ownership:** penulisan stderr saat alt-screen (`ace BLOCKED` `setup.ts:2367-2373`,
  verify notice `2427-2429`, hook notice `2445-2451`, timeout `2462-2465`) tidak melalui
  `App`/statusline owner.
- **Status:** **NOT_FIXED**.

---

### 3.5 P1.3 — Memory supersession

#### P1.3-a — Validasi `supersedes_id` + ekspos ID
- **Before (UAT stage9):** string apa pun diterima; `read_memory` tidak mengekspos id;
  down-link `superseded_by` NULL karena `UPDATE … WHERE id=<teks>` no-op.
- **After:** validasi sebelum tulis (`src/tools/memory.ts:183-193`) dan di dalam transaksi
  (`vector.ts:616-627`); `read_memory` menampilkan `[id:<row-id>]` (`memory.ts:88-91`).
- **Test:** `test/coverage-gaps.test.ts:107-120` (string acak ditolak); `p20:143-158`
  (`memoryRowExists`, rollback); `p20:134-136` (id terekspos). Lulus.
- **Batas:** error untuk id dari store global berbunyi “not found”, bukan “wrong store”;
  id yang diekspos bisa id chunk, bukan head.
- **Status:** **FIXED_VERIFIED**.

#### P1.3-b — Tombstone dua sisi & seluruh chunk
- **Source:** `addMemory` `UPDATE memory SET superseded_by=? WHERE id=? OR parent=?`
  (`vector.ts:660-665`), transaksi menyeluruh (`:616-669`).
- **Test:** `p20:188-208` meng-assert `superseded_by=newId` untuk semua chunk dan live count 0;
  `p20:222-232` untuk `supersedeMemory`; rollback `:151-158`. Lulus.
- **Batas:** test lama hanya memberi **head id**; tidak ada test untuk id chunk, target yang
  sudah superseded, atau concurrency.
- **Status:** **FIXED_VERIFIED** untuk jalur head-id.

#### P1.3-c — Reconcile resurrection, chunk-id, stale, concurrency, provenance UI
- **Reconcile:** `reconcileMemoryStores` memilih semua baris tanpa filter
  (`vector.ts:1539`), lalu untuk grup yang tidak lengkap di `MEMORY.md` memanggil
  `appendMemory(full)` (`:1602-1624`). Supersession menghapus baris lama dari file
  (`tools/memory.ts:262-267`). Jadi reconcile berikutnya **mengadopsi ulang fakta
  superseded** ke file → `loadMemoryFiles` → system prompt (`context.ts:241-246`).
- **Chunk-id:** bila `supersedesId` adalah id chunk, `WHERE id=? OR parent=?` hanya
  menombstone chunk itu; head tetap hidup, sementara file menghapus seluruh baris → split-brain.
- **Stale/already-superseded:** `superseded_by` ditimpa tanpa cek; concurrent supersession
  bisa meninggalkan dua “new” live dan link asimetris; tidak ada unique constraint.
- **UI:** `memory status` tidak melaporkan jumlah superseded/relasi; `MemoryHit` tidak
  membawa `supersedes/superseded_by`.
- **Status:** **NOT_FIXED**.

---

### 3.6 P1.4 — Context & token observability

#### P1.4-a — Gate anti-sampel in-flight
- **Source:** `src/policy/context.ts:101-112`; cap `DEFAULT_MAX_CALIBRATION_FACTOR=64` (`:64`).
- **Kondisi:** buang sampel hanya bila `lastLocal !== null && local === lastLocal &&
  actual > lastLocal*3`; hanya update `factor` yang dilewati, `lastActual/drift` tetap diisi.
- **PROBE audit:** `(5026,6413)` → factor `1.275964982…`; lalu `(5026,28024)` → factor
  **tetap** `1.275964982…`; drift nyata `(100,180)` → `1.8`; sampel pertama `(100,12000)` →
  `64` (cap). Perilaku yang dimaksud UAT **tereproduksi**.
- **Batas penting:** `effectiveContextTokens(100)` setelah sampel kedua = **28024** karena
  `lastActual` tetap diisi (`:152-159`); `snapshot().effectiveTokens` juga. Jalur ini
  **hanya dipakai test/telemetri**, bukan produksi (satu-satunya call site produksi adalah
  `observeProviderUsage`, `src/app/session.ts:459`), jadi bukan bug live — tetapi merupakan
  jebakan API.
- **Test:** **tidak ada test repo** untuk gate ini (grep `inFlightSample`/`6413`/`28024` = 0).
  Verifikasi audit ini adalah PROBE, bukan regression test.
- **Status:** **FIXED_VERIFIED** (faktor produksi), dengan residual test gap.

#### P1.4-b — Usage kumulatif vs delta
- **Source:** `src/policy/usage.ts:372-420,494-523`; `openai-compat.ts:128-135`.
- **Perilaku:** chunk kumulatif dihitung sebagai delta terhadap snapshot sebelumnya; net =
  snapshot terakhir, bukan penjumlahan. Retry dengan total menurun dianggap request baru.
- **Test:** `p19:162-193` — `totalTokens=200`, bukan 1550. Lulus.
- **Status:** **FIXED_VERIFIED**.

#### P1.4-c — Meter occupancy & `context.window`
- **Footer:** `fmtUsageMetrics` memakai `getSession().totalTokens` (spend kumulatif) dibagi
  `contextWindowTokens` (`cli/tui.ts:67-83`), bukan `session.contextTokens` (occupancy).
  Setelah 13–26 step, angka bisa mentok 100% padahal konteks jauh di bawah window.
- **`context.window`:** hanya dikirim dari callback cutoff (`cli/setup.ts:2590-2604`), dengan
  `usedTokens=actual` = **token output** saat cutoff, bukan occupancy. Tidak ada meter periodik.
- **Test:** tidak ada yang meng-assert semantik footer/`context.window` (hanya shape).
- **Status:** **NOT_FIXED**.

#### P1.4-d — Cache tokens, atribusi biaya, summary mesin
- **Cache:** adapter OpenAI-compat hanya membaca `prompt_tokens/completion_tokens/total_tokens`
  (`vendor/minicore/src/providers/openai-compat.ts:128-135`); `cached_tokens` diabaikan →
  `cacheRead=0` bahkan bila gateway mendukung cache. Anthropic adapter sudah mengirim cache.
- **Atribusi compaction:** usage compaction dipancarkan tanpa `model` (`cli/setup.ts:1694-1698`)
  → dihargai dengan model utama (`usage.ts:508-511`).
- **Summary:** `exec --json` summary berisi usage/cost tetapi **tidak** `contextTokens`,
  `windowTokens`, atau jumlah compaction (`exec.ts:288-323`).
- **Biaya unknown:** tidak dikarang; `costFor` mengembalikan `undefined`, surface menampilkan
  `N/A`/menghilangkan `$`. Ini **benar**.
- **Status:** **NOT_FIXED**.

---

### 3.7 P1.5 — ACE & verification visibility

#### P1.5-a — Event & machine envelope
- **Source:** `consequence.decided` (`src/presentation/events.ts:475-483`), `verification.observed`
  (`:458-467`), producer `cli/setup.ts:2341-2366`/`2155-2204`, adapter
  `presentation/adapter.ts:1149-1183`, machine payload `projection.ts:802-825`.
- **Test:** `p18` (tamper override → BLOCKED), `presentation-observability` (severity/nextAction),
  `presentation-policy` (envelope). Lulus/terverifikasi.
- **Status:** **FIXED_VERIFIED** untuk machine/exec.

#### P1.5-b — Visibilitas TUI
- **Fakta:** `transcript.ts:667` `if (!event.type.startsWith("tool.")) return` membuang
  `consequence.decided`, `context.cutoff`, `verification.observed`; `verificationLedger`
  (`:812-836`) tak pernah dipanggil. Hanya `task.status` yang di-special-case.
- **Dampak:** pengguna TUI tidak melihat verdict ACE/`nextAction`/tamper, kecuali baris
  stderr `[ace]` untuk BLOCKED. Ini **visibility gap**, bukan bypass enforcement.
- **Status:** **NOT_FIXED**.

#### P1.5-c — Emisi `task.status` & semantik machine
- **Emisi:** satu call site `noteTaskStatus` (`cli/setup.ts:2402`) setelah verify-settle;
  transisi claim/verify-start/merge/cancel tidak dipancarkan. Tanpa `--verify`, status task
  kanonik tidak terlihat di `exec --json`.
- **Semantik:** `machineStatus(consequence.decided)` selalu `completed` (`projection.ts:717`),
  bahkan FAIL/BLOCKED (severity tetap `error`). `COMPLETED` task bisa `unverified` bila
  `--verify` tidak aktif (`src/tools/todo.ts:54-63`; `setup.ts:2253-2254`).
- **Status:** **PARTIAL**.

---

### 3.8 P1.6 — Task & subagent observability

#### P1.6-a — Identitas run anak
- **Source:** `src/tools/task.ts:553-563` (`childRunId`), `presentation/events.ts:131-142`,
  adapter `presentation/adapter.ts:593-629`, reducer/model `ActivityEntry.runId`,
  render `transcript.ts:789-810`/`simple.ts:419-427`.
- **Test:** `presentation-observability` (childRunId→parentLink.runId), `presentation-projections`
  (tiga anak = tiga baris). Lulus.
- **Batas:** marker dipotong 8 char (label tampilan); anak tanpa identitas run tetap roll-up
  (disengaja).
- **Status:** **PARTIAL** karena identitas hilang di machine stream (P1.6-c).

#### P1.6-b — Ledger task & reachability status
- **Ada:** ledger kanonik + DAG (`transcript.ts:842-867`), `task.status` durable.
- **Gap:** `FAILED`/`RETRYING` tidak punya writer produksi (verification failure → `BLOCKED`,
  `src/task/store.ts:1378-1387`); `queued/registered/running/waiting` bukan status TaskStore;
  `stale` adalah flag turunan 7 hari (`src/session/open-work.ts:71`).
- **Status:** **PARTIAL**.

#### P1.6-c — Machine envelope & hasil anak
- **Fakta:** `toPresentationEvent` membuang `sessionId` (`cli/setup.ts:471-499`);
  `toMachineEnvelope` menstempel sessionId **induk** (`exec.ts:246-249`;
  `projection.ts:864-877`); payload hanya punya `parentToolCallId` (`projection.ts:839`);
  `machineEventId` memakai `${parentSessionId}:${turnId}:${seq}` (`:666-672`) sementara
  adapter anak punya `seq`/`turnId` sendiri → potensi **eventId collision**.
- **Hasil anak:** hanya ringkasan string di receipt induk (`task.ts:611-666,721-751`), bukan
  event terstruktur; model/mode/permission anak tidak tercatat.
- **Status:** **NOT_FIXED**.

---

### 3.9 P2.1 — State isolation & type safety

#### P2.1-a — `process.env` write sebagai state
- **Before:** `collapse.ts`, `detail.ts`, `reasoning.ts` menulis env.
- **After:** setter tidak menulis env (`src/ui/session-state.ts:15-16`); grep produksi
  menemukan write env hanya `MINICODE_SANDBOX` (`cli/index.ts:404`, `cli/commands/exec.ts:88`)
  dan bench.
- **Test:** `test/tui-format.test.ts` (tidak menulis env), `ui-instance-isolation.test.ts`
  (`process.env.MINICODE_MINIMIZE_TOOL` tetap `"1"` setelah setter). Lulus.
- **Status:** **FIXED_VERIFIED**.

#### P2.1-b — State UI per-sesi
- **Source:** `src/ui/session-state.ts:51-243`; dibuat per `createCliSession`
  (`cli/setup.ts:847-851`), diteruskan eksplisit (`:2787`; `cli/tui.ts:143,168`).
- **Test:** dua `createCliSession` nyata; mutasi A tidak menyentuh B; `defaultUiState` tetap
  (test `ui-instance-isolation`). Lulus.
- **Batas:** test membuat sesi **berurutan**, bukan `run()` konkuren; modul render legacy
  masih delegasi ke `defaultUiState` bila `uiState` tidak diberikan.
- **Status:** **FIXED_VERIFIED** untuk scope yang diuji.

#### P2.1-c — Singleton proses & DI global
- **Daftar:** `todoSession` (`todo.ts:546`), `askTextFn`/`askApprovalHook` (`ask_user.ts:14`),
  `submit_result.last` (`submit_result.ts:14`), `pending-tools` (`pending-tools.ts:31-33`),
  `currentRouter` (`provider-layer.ts:9`), MCP `activeConnections` (`mcp/client.ts:146`),
  LSP `activeServers` (`lsp/client.ts:31,420`), locale (`i18n/locale.ts:18-20`),
  transcript `approvalSink` (`transcript.ts:47`), statusline/screen depth.
- **Bukti cross-wire:** `todoSession` di-rebind di setiap `createCliSession`
  (`setup.ts:1728-1729`); kernel `ToolContext` tidak punya `sessionId`
  (`vendor/minicore/src/core/tool.ts:22-34`), jadi jalur CLI selalu jatuh ke global.
- **Test:** `test/ui-instance-isolation` hanya menguji UI state; `phase4a4b` memakai ctx
  sintetis `{signal,cwd,sessionId}` yang hanya dibangun MCP server.
- **Status:** **NOT_FIXED** (latent; bukan bug teramati pada CLI satu-sesi).

#### P2.1-d — Type boundary & event versioning
- **Ada:** `strict` + `noUncheckedIndexedAccess`; hanya tiga `: any` sengaja
  (`presentation/events.ts:600`, `ui/contract.ts:70`, `mcp/client.ts:327`).
- **Gap:** decoder durable melakukan shallow check lalu cast (`session/persistence.ts:708-800`);
  `DomainEvent` tidak punya schema version (hanya `plan.updated.payloadVersion`); penambahan
  field wajib akan membuat event lama gagal decode dan dihitung `snapshotRejected`.
- **Status:** **PARTIAL**.

---

### 3.10 P2.2 — Monolith & rendering performance

#### P2.2-a — Konsentrasi responsibility
- **Ukuran aktual:** `src/ui/tui/app.ts` 1.349 baris (alt-screen, sinyal, stdin, key, mouse,
  history, scroll, composer, layout, footer, paint, cursor); `transcript.ts` 961;
  `simple.ts` 865; `presentation/adapter.ts` 1.319; `cli/setup.ts` 3.384.
- **Penilaian:** monolith by responsibility, bukan hanya LOC. Tidak ada layer violation
  (`ui-boundary` 5 lulus) dan tidak ada import cycle yang ditemukan.
- **Status:** **NOT_FIXED** (belum ada refactor; jangan pecah hanya karena LOC).

#### P2.2-b — Harness/measurement
- **Fakta:** tidak ada benchmark UI/terminal di `test/`/`scripts/`; `bench/` mengukur kualitas
  task LLM, bukan render latency. `docs/audit/P1-P8_PERF_BASELINE.md` menyatakan hal sama.
- **Status:** **UNVERIFIED** (angka FPS/latency/memori = UNKNOWN).

#### P2.2-c — Hot path & writer ownership
- **Per-key paint:** setiap char → `paintCurrent()` → `projectAll()` (full transcript);
  tidak ada batching seperti `askLine` (`src/ui/input/input.ts:728-735`). Bracketed paste
  tidak diaktifkan di TuiApp, jadi paste besar = banyak repaint.
- **Per-frame cost:** `transcript.viewport()` memproyeksikan ulang seluruh transkrip;
  `getPresentationSnapshot()` mematerialisasi ulang semua koleksi (`cli/setup.ts:1515-1651`).
- **Writer:** `test/writer-inventory.test.ts` hanya menghitung batas atas penulis di `cli/**`
  dan `src/ui/**`, tidak mendeteksi timing/ownership dan tidak memindai `src/app/**`.
- **Status:** **NOT_FIXED**.

---

### 3.11 P2.3 — MCP & daemon UX

#### P2.3-a — Pin skema MCP & drift
- **Source:** `src/mcp/client.ts:52-94,334-367,410-418`.
- **Fakta:** `mcpSchemaPinRegistry` adalah `Map` in-memory (`:88`), tidak ada persistensi/DDL;
  `verify()` tanpa pin akan **mem-pin** hash saat itu (`:68-75`), jadi setelah restart skema
  yang berubah diterima diam-diam. `approveMcpSchemaUpdate` tidak punya call site produksi.
  `wrapTools` menghitung hash dari `t` yang ditangkap saat discovery (`:334-367`); tidak ada
  refresh `tools/list`.
- **Test:** `p20:261-274` hanya menguji registry unit (`pinned→ok→drift→approve→ok`), bukan
  integrasi connect/refresh.
- **Status:** **NOT_FIXED**.

#### P2.3-b — Multi-sesi & close
- **Fakta:** `connectAll` mengembalikan `{conn:null}` untuk server yang sudah aktif
  (`client.ts:416`) lalu `continue` **sebelum** `wrapTools` (`:431-434`) → sesi kedua
  mendapat **nol tool MCP** walau koneksi hidup. `closeAll()` menutup map global
  (`:511-518`) dan dipanggil setiap `CliSession.close()` (`cli/setup.ts:3293`), sehingga
  menutup satu sesi mematikan MCP sesi lain. `killAllBackgroundJobs()` juga global.
- **Status:** **NOT_FIXED**.

#### P2.3-c — Reconnect, pagination, subscription
- **Fakta:** stdio exit hanya reject pending, tidak reconnect (`transport.ts:34-37`);
  `connect()` menolak bila `proc` ada; HTTP terminal setelah close. `tools/list`/
  `resources/list`/`prompts/list` mengabaikan `nextCursor` (`client.ts:228-250`). Tidak ada
  `resources/subscribe`/`notifications/*`. Server-side resources/prompts adalah stub (`[]`).
- **Status:** **NOT_FIXED**.

#### P2.3-d — Operator action daemon
- **Status/list/shutdown/issue** nyata (`daemon/control.ts:226-267`; `cli/commands/daemon.ts:64-103`).
- **Interrupt/cancel:** produksi selalu `RUN_TERMINAL` (`daemon.ts:245-256`), hosted session
  `runId:null,runStatus:null` (`:354-361`) → runaway turn tak bisa dihentikan.
- **Approval CLI:** tidak ada verb approval di `DAEMON_HELP` (`:89-103`); hanya lewat
  protokol `approval.decide/list`.
- **Status:** **NOT_FIXED**.

#### P2.3-e — Backpressure, restart, ACP
- **Backpressure live:** `BoundedQueue` 512 + tutup subscription lambat
  (`daemon/protocol.ts:12-15`, `subscription.ts:23-53`), test `p13-multi-consumer:487-540`.
- **Backpressure replay:** `#send` mengembalikan `true` walau `socket.write()===false`
  (`server.ts:221-231`), jadi replay dari seq 0 dapat membuffer tanpa batas (`:424-444`).
- **Restart:** offset/approval durable, tetapi hosted run/session tidak di-resume/direkonstruksi;
  `RECONSTRUCTED` dideklarasikan tetapi tidak pernah dipancarkan (`protocol.ts:178`,
  `feed.ts:132,145`). ACP bukan consumer daemon (`p13-e2e-runtime.test.ts:18-20`).
- **Status:** **NOT_FIXED**.

#### P2.3-f — Fase replay→live
- **Source:** `daemon/subscription.ts` latch per subscription; `tail_marker.phase:"live"`;
  `DaemonClient.phaseOf()`.
- **Test:** `test/daemon-stream-phase.test.ts` (8 test; dua consumer independen) dan
  `p2-daemon` — lulus.
- **Status:** **FIXED_VERIFIED**.

---

## 4. Kontrak DISCUSS / PLAN / EXECUTE (§6.4)

### 4.1 Truth table WorkMode × PermissionMode

Notasi: **R** = ceiling read-only (18 tool, `READONLY_TOOL_NAMES`); **R+3** = R +
`todo_write`/`delegate_task`/`submit_result`; **PM** = base PermissionMode menentukan.
“Visible” = daftar yang diiklankan ke model; “callable” = lolos `registry.get()` + `check()`.

| WorkMode | PermissionMode | Ceiling efektif | Tool visible | Prompt hint | Approval | Fallback/catatan |
|---|---|---|---|---|---|---|
| DISCUSS | `readonly` | R | 12 | DISCUSS hint | tidak ada prompt (ceiling deny) | write/exec **deny** |
| DISCUSS | `plan` | R | 12 | DISCUSS hint + planHint | tidak ada | write/exec deny |
| DISCUSS | `ask` | R | 12 | DISCUSS hint | tidak ada | write/exec deny |
| DISCUSS | `auto` | R | 12 | DISCUSS hint | tidak ada | `read_memory` tetap menulis `access_count` + network |
| DISCUSS | `allowlist` | R | 12 | DISCUSS hint | tidak ada | write/exec deny |
| DISCUSS | `allow-all` | R | 12 | DISCUSS hint | tidak ada | **allow-all tidak memperluas** (INV-WM1) |
| PLAN | `readonly` | R | 12 | PLAN hint | tidak ada | ceiling collapse ke readonly |
| PLAN | `allowlist` | R | **15** | PLAN hint | tidak ada | **G5: 3 tool terlihat tapi selalu deny** |
| PLAN | `plan` | R+3 | 15 | PLAN hint | tidak ada | `todo_write`/`submit_result` allow |
| PLAN | `ask` | R+3 | 15 | PLAN hint | `delegate_task` prompt (gated) | headless → deny |
| PLAN | `auto` | R+3 | 15 | PLAN hint | `delegate_task` prompt (gated) | headless → deny |
| PLAN | `allow-all` | R+3 | 15 | PLAN hint | tidak ada | `delegate_task` boleh (tanpa prompt) |
| EXECUTE | `readonly` | PM = R | 12 | — | tidak ada | identitas PM |
| EXECUTE | `plan` | PM = R+3 | 15 | planHint (PM) | tidak ada | identitas PM |
| EXECUTE | `ask` | PM = ask | 37 | — | prompt per tool non-readonly | headless → deny |
| EXECUTE | `auto` | PM = auto | 37 | — | gated tool prompt | write/exec allow setelah guard |
| EXECUTE | `allowlist` | PM = allowlist | 37 | — | bash pattern; gated deny | file write allow, shell terbatas |
| EXECUTE | `allow-all` | PM = allow-all | 37 | — | tidak ada | jail/bash-guard tetap |

**Catatan penting:** `planHint` milik PermissionMode `plan` adalah dimensi berbeda dari
WorkMode PLAN. Di `PLAN × plan`, model menerima **dua** hint (`planHint` + `workModeHint`).

### 4.2 Tool class × WorkMode (effective dispatch)

| Kelas tool | Contoh | DISCUSS | PLAN (auto/ask) | PLAN (allowlist) | EXECUTE auto | EXECUTE readonly |
|---|---|---|---|---|---|---|
| Local read | `read_file`, `glob`, `grep`, `git_status/log`, `todo_read`, `lsp_*`, `read_image`, `git_diff` | 12 visible; **6 hidden but allowed** | 15 visible; 6 hidden allowed | 15 visible; 6 hidden allowed | 37 visible | 12 |
| Network read | `web_fetch`, `web_search` | **hidden, allowed, no prompt** | hidden, allowed | hidden, allowed | visible, allowed | hidden, allowed |
| MCP read/call | `mcp_read`, `mcp_prompt`, `mcp_call`, `server.tool` | hidden, **deny** (ceiling) | hidden, deny | hidden, deny | gated prompt/deny | deny |
| Workspace write | `write_file`, `edit`, `apply_patch`, `move_file`, `delete_file` | hidden, **deny** | hidden, deny | hidden, deny | allow (auto) | deny |
| Execute/process | `bash`, `code_run`, `bash_kill` | hidden, **deny** | hidden, deny | hidden, deny | bash allow after guard; code_run needs sandbox | deny |
| Memory write | `write_memory`, `forget_memory` | hidden, deny | hidden, deny | hidden, deny | allow | deny |
| Plan artifact | `todo_write` | hidden, deny | visible, **allow** | **visible, deny** | allow | deny |
| Delegation | `delegate_task` | hidden, deny | visible, **prompt** (headless deny) | visible, deny | gated prompt | deny |
| Submit | `submit_result` | hidden, deny | visible, allow | visible, deny | allow | deny |
| Git history | `git_commit` | hidden, deny | hidden, deny | hidden, deny | gated prompt | deny |
| User interaction | `ask_user` | hidden, deny | hidden, deny | hidden, deny | gated prompt | deny |

### 4.3 Prompt, side-effect ceiling, approval, inheritance, resume

| Aspek | DISCUSS | PLAN | EXECUTE |
|---|---|---|---|
| **Prompt** | hint read-only investigation + diskusi (`session.ts:91-99`) | hint planning (`:100-105`); `planHint` PM bisa menambah | tidak ada hint WorkMode |
| **Side-effect ceiling** | read-only; **kecuali** `read_memory` (network+DB), hooks (tidak jalan), `--verify` (tidak digerbangi) | read + plan artifact + delegation read-only; **kecuali hooks** dan `--verify` | PM + approval + jail + bash-guard |
| **Approval** | tidak ada prompt; ceiling deny | `delegate_task` di-gate di auto/ask; plan/allow-all tanpa prompt | sesuai PM |
| **Child inheritance** | child dipaksa `explore`; WorkMode diwarisi; tidak bisa escalate | child `explore` bila parent plan/readonly/ask; selain itu inherit | child `plan` (bila diminta) mendapat `base` penuh — **G8**, bertentangan docs/AGENTS.md |
| **Resume/default** | tidak dipersist → EXECUTE; baris stderr transparan | sama | default |
| **Surface parity** | TUI footer; one-shot/exec stderr; `exec --json` summary; ACP input-only | sama | sama; daemon **tidak punya** WorkMode |

### 4.4 Unknowns yang membutuhkan keputusan owner

| # | Pertanyaan | Mengunci apa |
|---|---|---|
| Q1 | DISCUSS = **read-only investigation** (18 tool, network read) atau **conversation-only** (tanpa tool)? Kode saat ini = read-only investigation; conversation-only tidak ada | Semua perilaku DISCUSS, docs, label |
| Q2 | Apakah `web_fetch`/`web_search` masuk DISCUSS dan boleh tanpa approval? Saat ini **hidden tapi allowed** | P1.1-c, keamanan network egress |
| Q3 | Apakah PLAN boleh menjalankan **hooks** (Node arbitrer)? Saat ini ya | P0.2-c, janji read-only |
| Q4 | Apakah `--verify`/self-heal boleh dijalankan di DISCUSS/PLAN? Saat ini ya | P1.1-f |
| Q5 | Apakah daemon harus mendukung WorkMode dan `run.interrupt`? Saat ini tidak | P0.2-c, P2.3-d |
| Q6 | Apakah `memory reconcile` harus **melewati** baris superseded? | P1.3-c |
| Q7 | Apakah multi-session in-process adalah jalur produksi? | P2.1-c, P2.3-b |
| Q8 | Apakah pin skema MCP harus persisten lintas restart? | P2.3-a |

---

## 5. UI/UX evidence matrix (§6.5)

Legenda: **FULL** / **PARTIAL** / **RAW** (hanya stderr/log) / **HIDDEN** / **INCONSISTENT** /
**N/A** / **UNKNOWN**. Kolom “Bukti” = STATIC / MOCKED-TEST / PTY / MANUAL / LIVE-UAT.

| Capability | One-shot/pipe | `exec` human | `exec --json` | TUI | Daemon | ACP | Bukti |
|---|---|---|---|---|---|---|---|
| WorkMode terlihat | PARTIAL (stderr non-EXECUTE) | PARTIAL (stderr) | FULL (`summary.workMode`) | PARTIAL (footer non-EXECUTE) | N/A (selalu EXECUTE) | HIDDEN | STATIC + MOCKED-TEST |
| WorkMode ≠ PermissionMode | PARTIAL | PARTIAL | PARTIAL | FULL non-default | N/A | HIDDEN | STATIC |
| Ubah WorkMode runtime | N/A | N/A | N/A | FULL via `/work-mode` (tak discoverable) | N/A | N/A | STATIC + MOCKED-TEST |
| Status turn/tool | FULL/PARTIAL | FULL/PARTIAL | FULL | FULL | PARTIAL (event) | PARTIAL | STATIC + MOCKED-TEST |
| Status task/plan | PARTIAL (task ada; plan tidak) | PARTIAL | FULL | PARTIAL (task ada; plan tidak) | PARTIAL | PARTIAL | STATIC + MOCKED-TEST |
| Thinking/waiting-approval | PARTIAL | PARTIAL | FULL event | FULL (dots/modal) | PARTIAL | PARTIAL | STATIC + MOCKED-TEST |
| Approval: target/risk/diff | PARTIAL | PARTIAL | PARTIAL (field ada) | PARTIAL (tier+diff) | PARTIAL (summary string) | HIDDEN (risk/diff dibuang) | STATIC + MOCKED-TEST |
| Approval options | FULL (allow/always/deny) | FULL bila TTY | N/A | FULL (`always` no-op >2KB) | PARTIAL (accept/deny) | N/A | STATIC + MOCKED-TEST |
| Deny reason | PARTIAL (linear) | PARTIAL | FULL (`payload.reason`) | **HIDDEN** | FULL event | FULL | STATIC |
| ACE verdict/nextAction | **RAW** (BLOCKED stderr) | RAW | FULL | **HIDDEN** | N/A (`verify:false`) | N/A | STATIC |
| Verification/tamper | PARTIAL | PARTIAL | FULL | PARTIAL (event dibuang) | FULL event | FULL | STATIC |
| Context occupancy/capacity | PARTIAL (/status estimate) | PARTIAL | **HIDDEN** (summary tanpa context) | **INCONSISTENT** (% = spend) | PARTIAL | HIDDEN | STATIC |
| Biaya | PARTIAL (`/status`) | PARTIAL | FULL bila tarif dikenal | PARTIAL (footer `$`) | PARTIAL | PARTIAL | STATIC + MOCKED-TEST |
| NoProgress/timeout/recovery | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | STATIC |
| Keyboard/a11y/resize/scroll/Unicode/ANSI | PARTIAL | PARTIAL | N/A | PARTIAL (mekanik kuat; discoverability lemah) | N/A | N/A | STATIC + PTY (historical) |
| Authoritative vs recomputed state | PARTIAL | PARTIAL | FULL | MIXED | PARTIAL | PARTIAL | STATIC |
| REPL linear | N/A (dihapus) | N/A | N/A | N/A | N/A | N/A | STATIC |

**Bukti UI yang benar-benar dijalankan audit ini:** hanya unit/mocked test (batch 140 pass +
73 pass). **Tidak ada** PTY, terminal manual, atau live provider. Karena itu klaim “TUI
tervalidasi” tetap **tidak boleh** dibuat.

---

## 6. Rekonsiliasi UAT & runtime (§6.6)

Label `HISTORICAL-UAT` berarti angka/perilaku dari laporan 2026-11-02 dan **tidak dijalankan
ulang**. “Verifikasi sekarang” adalah hasil audit ini (PROBE/STATIC/UNIT-TARGETED).

### 6.1 Empat fix utama UAT

| ID | Fix | Status sekarang | Bukti audit | Residual |
|---|---|---|---|---|
| F1 | Gate anti-sampel kalibrasi token | **FIXED_VERIFIED** | PROBE: factor tetap 1.27596 setelah sampel 28024; drift 1.8× tetap terkalibrasi; cap 64 | Tidak ada test repo; `effectiveContextTokens` masih memakai `lastActual` (test-only); ambang 3× heuristik |
| F2 | Pesan `todo_write` actionable | **FIXED_CODE_ONLY** | Diff `cb60212` menambahkan instruksi “re-send WITHOUT taskId… reuse id from todo_read” (`src/tools/todo.ts:741-760`) | Tidak ada test yang meng-assert teks baru; UAT live adalah bukti historis |
| F3 | `exec` meneruskan `--max-steps/--context-window/--timeout/MINICODE_COMPACT_KEEP_TURNS` | **FIXED_CODE_ONLY** | Diff `cli/commands/exec.ts:124-166,201-211`; nilai diteruskan ke `createCliSession` | Tidak ada test saat ini yang men-spawn `exec` dengan flag ini; bukti live = HISTORICAL-UAT (stage12) |
| F4 | `friendlyError` memetakan context-window | **FIXED_VERIFIED** | PROBE: `"Context window exceeded"` + fix “Start a new session…”; `test/errors-usage.test.ts:74-79` lulus | — |

### 6.2 Lima rekomendasi UAT §8

| ID | Rekomendasi | Status sekarang | Bukti | Residual |
|---|---|---|---|---|
| R1 | Machine projection `raise --budget` → selaras `friendlyError` | **FIXED_VERIFIED** | `src/presentation/projection.ts:919-927` branch context-window → action “start a new session…”; `test/presentation-policy.test.ts:338` | — |
| R2 | Validasi `supersedes_id` + ekspos id | **FIXED_VERIFIED** | `tools/memory.ts:183-193`, `vector.ts:616-627`, `memory.ts:88-91`; test `p20` + `coverage-gaps` | Reconcile resurrection (P1.3-c) |
| R3 | Peringatan flag setelah prompt boundary | **PARTIAL** | `cli/args.ts:234` + `cli/index.ts:434-442` + test `cli-args.test.ts:121-153` | Hanya jalur one-shot; `exec` tidak memperingatkan (flag setelah prompt tetap menjadi teks) |
| R4 | Log monitoring di luar workspace | **NOT_FIXED** | Tidak ada perubahan kode/docs; artefak `stageN-*.log` masih bisa mencemari heuristik todo | Tidak ada heuristik yang diubah |
| R5 | Biaya gateway tanpa prompt cache | **NOT_FIXED** | `openai-compat.ts:128-135` mengabaikan `cached_tokens`; tidak ada metrik cache di summary | Butuh probe gateway untuk memastikan cache didukung |

### 6.3 Temuan UAT §7/§2 lain yang masih relevan

| Temuan | Status sekarang | Bukti |
|---|---|---|
| §7.5 Supersession setengah jalan (down-link NULL) | **FIXED_VERIFIED** untuk head-id | `vector.ts:660-665`; test `p20:188-208` |
| §7.1 Resume tidak mengikat (posisi flag) | **FIXED_VERIFIED** (kontrak) + R3 warning parsial | `args.ts` precedence test; UAT §7.1 HISTORICAL |
| §7.2 “Session budget exceeded” masker | **FIXED_VERIFIED** | F4 |
| §7.3 Poisoning kalibrasi | **FIXED_VERIFIED** | F1 |
| §7.4 Lease after hard-kill | **FIXED_VERIFIED** (desain fail-closed) | UAT HISTORICAL; tidak diuji ulang |
| §2 usage kumulatif per-chunk | **FIXED_VERIFIED** (collector delta) | `usage.ts`; `p19:162-193` |
| §2 cacheRead=0 | **NOT_FIXED** | R5 |
| Stage12 `--context-window 2500` fail-closed | **FIXED_CODE_ONLY** (current) | F3 code; HISTORICAL-UAT live |
| Stage13 `delegate_task` tanpa consent ditolak | **FIXED_VERIFIED** | `work-mode-contract:398-434`; UAT HISTORICAL |

### 6.4 Perubahan terbaru yang ditemukan (setelah `cb60212`)

| Area | Perubahan | Status bukti |
|---|---|---|
| WorkMode | `workModeHint`, label one-shot/exec, resume transparency, `/work-mode` | UNIT-TARGETED (prompt/cli/runtime) |
| Tool | `READONLY_TOOLS` diturunkan; `allowedInReadonly` di registry; drift test p15 | UNIT-TARGETED |
| Approval | `approval-binding.ts` (baru), riskTier+diffPreview, barrier ganda | UNIT-TARGETED (10 test) |
| Memory | ID exposure, validasi supersedes, tombstone chunk, `memory reconcile` CLI | UNIT-TARGETED (31 test) |
| Context | `context.window`, `context.cutoff`, footer metrics | STATIC; semantik salah |
| Task | `task.status` event + ledger linear/TUI/ACP | UNIT-TARGETED |
| Daemon | phase latch replay→live, `phaseOf` | UNIT-TARGETED (8 test) |
| State | `session-state.ts` per sesi, env-write dihapus | UNIT-TARGETED (5 test) |
| CI | `shell: bash` untuk job Windows | STATIC + `ci-glob-expansion.test.ts` |
| Laporan | 8 laporan audit + `CODE_QUALITY_AUDIT` | Dokumen; tidak diuji |

---

## 7. Draft workflow proposal — hanya alternatif (§6.7)

> Ini **bukan** roadmap baru dan **bukan** urutan final. Owner yang memutuskan. Tidak ada
> implementasi yang dimulai.

### Opsi A — Kontrak & enforcement lebih dulu (critical-path-first)

**Urutan:** (A1) commit/checkpoint kandidat → (A2) putuskan Q1–Q4 → (A3) perbaiki G1
(reveal registry) + satukan visibility/ceiling + drift test → (A4) tegakkan PLAN hooks/verify
→ (A5) kunci kontrak event identitas (childSessionId/runId, version) → (A6) baru UI.

- **Alasan:** semua UI membaca state yang ditentukan kontrak; membangun UI di atas kontrak
  yang belum stabil akan menghasilkan rework. G1 adalah bug fungsional yang memblokir
  eskalasi WorkMode.
- **Risiko jika ditunda:** UI makin dalam terikat pada semantics yang berubah; bug G1
  makin mahal.
- **Paralel aman:** memory integrity (vector/files/tools) dan MCP pin persistence tidak
  menyentuh file kontrak WorkMode/UI → bisa berjalan paralel (Agent B).
- **Gate sebelum pindah:** test drift visibility↔ceiling; test dispatch setelah runtime
  switch; keputusan owner Q1–Q4 tertulis.
- **Jangan diparalelkan:** `presentation/events.ts`/`adapter.ts` dengan perubahan task/subagent
  identity; `tool-contract.ts` dengan `permission.ts` (satu PR).
- **Kompleksitas:** A3–A5 = **M**; A1–A2 = **S**.

### Opsi B — Correctness & data integrity lebih dulu

**Urutan:** (B1) reconcile vs superseded → (B2) chunk-id/stale/concurrent supersession →
(B3) PLAN hooks/verify → (B4) MCP pin persist + multi-session → (B5) daemon interrupt →
(B6) baru kontrak/UI.

- **Alasan:** memori yang dihidupkan kembali dan PLAN yang bisa menulis adalah risiko
  correctness/keamanan yang tidak terlihat di UI; memperbaikinya lebih dulu mengurangi
  risiko data.
- **Risiko jika ditunda:** fakta superseded masuk kembali ke prompt; drift MCP tidak
  terdeteksi setelah restart; runaway daemon tidak bisa dihentikan.
- **Paralel aman:** UI diagnostics (TUI drops) bisa dikerjakan paralel karena tidak
  menyentuh memory/daemon.
- **Gate:** test reconcile-after-supersede (retrieval + file + prompt); test chunk-id;
  test pin restart; test daemon interrupt nyata.
- **Jangan diparalelkan:** `vector.ts` dengan `tools/memory.ts` (satu PR); `daemon/server.ts`
  dengan `subscription.ts`.
- **Kompleksitas:** B1–B2 = **M**; B3 = **S–M**; B4–B5 = **L**.

### Opsi C — Operator visibility/UI lebih dulu

**Urutan:** (C1) TUI diagnostics (ACE/cutoff/verification/deny) → (C2) occupancy meter +
cache telemetry → (C3) `/work-mode` discoverability + default label → (C4) approval ACP
parity → (C5) baru kontrak/enforcement.

- **Alasan:** operator butuh melihat apa yang terjadi untuk mempercayai sistem; visibility
  murah dan tidak mengubah semantics.
- **Risiko jika ditunda:** operator salah menyimpulkan PASS/COMPLETE; debugging lambat.
- **Bahaya:** membangun UI di atas event yang belum punya identitas anak/versi → rework.
  Karena itu C1 harus dibatasi pada event yang sudah stabil.
- **Paralel aman:** C1–C2 (UI) vs B1–B2 (memory) vs A3 (tool) — file disjoint.
- **Gate:** test render diagnostics di TUI; test footer occupancy memakai `contextTokens`.
- **Jangan diparalelkan:** `transcript.ts` dengan `simple.ts` bila mengubah kontrak baris;
  `projection.ts` dengan `adapter.ts` (satu PR).
- **Kompleksitas:** C1–C4 = **S–M**.

### 7.1 Critical path & titik keputusan owner

**Critical path yang paling aman (rekomendasi audit, bukan keputusan):**
`commit/checkpoint` → `Q1–Q4` → `G1 + visibility/ceiling` → `identitas event machine` →
`UI diagnostics` → `memory reconcile + MCP/daemon`.

**Titik keputusan owner sebelum UI dibangun di atasnya:**

1. Q1 DISCUSS semantics (read-only investigation vs conversation-only).
2. Q2 network read di DISCUSS (in/out, approval).
3. Q3 PLAN hooks (boleh/tidak).
4. Q4 `--verify` di DISCUSS/PLAN.
5. Q6 reconcile vs superseded (lewati atau adopsi dengan status).
6. Q7 multi-session in-process (produksi atau bukan).
7. Q8 pin MCP persisten.

**Pembagian Agent A/B yang tidak tumpang tindih file/kontrak:**

| Agent | Scope file | Tidak boleh menyentuh |
|---|---|---|
| **Agent A** | `src/policy/work-mode.ts`, `src/app/tool-layer.ts`, `src/policy/permission.ts`, `src/hooks/run.ts`, `src/tools/task.ts`, `test/work-mode-*` | `src/presentation/*`, `src/ui/*`, memory/daemon |
| **Agent B** | `src/memory/vector.ts`, `src/memory/files.ts`, `src/tools/memory.ts`, `src/mcp/client.ts`, `src/daemon/*`, test terkait | `src/policy/*`, `src/ui/*`, `cli/tui.ts` |
| **Agent C (setelah A)** | `src/presentation/*`, `src/ui/*`, `cli/tui.ts`, `cli/setup.ts` | `src/policy/*`, memory/daemon |

`cli/setup.ts` adalah titik temu: A dan C sama-sama membutuhkannya. Urutkan, jangan paralel.

---

## Appendix A — File/path inventory

### A.1 Tracked modified (64)

`.github/workflows/ci.yml`, `cli/args.ts`, `cli/commands/acp.ts`, `cli/commands/exec.ts`,
`cli/commands/memory.ts`, `cli/index.ts`, `cli/setup.ts`, `cli/tui.ts`,
`docs/TERMINAL_CONTRACT.md`, `docs/cli.md`, `docs/memory-sessions.md`, `src/app/session.ts`,
`src/daemon/approvals.ts`, `src/daemon/client.ts`, `src/daemon/protocol.ts`,
`src/daemon/server.ts`, `src/daemon/subscription.ts`, `src/memory/files.ts`,
`src/memory/vector.ts`, `src/policy/permission.ts`, `src/policy/tool-contract.ts`,
`src/presentation/adapter.ts`, `src/presentation/events.ts`, `src/presentation/model.ts`,
`src/presentation/projection.ts`, `src/presentation/reducer.ts`, `src/session/persistence.ts`,
`src/tools/memory.ts`, `src/tools/task.ts`, `src/ui/approval/prompt.ts`,
`src/ui/assistant/simple.ts`, `src/ui/contract.ts`, `src/ui/footer.ts`,
`src/ui/i18n/en.ts`, `src/ui/i18n/id.ts`, `src/ui/render/collapse.ts`,
`src/ui/render/detail.ts`, `src/ui/render/reasoning.ts`, `src/ui/tui/app.ts`,
`src/ui/tui/transcript.ts`, serta 24 file `test/*.test.ts`/helper yang terlihat di
`git diff --stat` (total 64).

### A.2 Untracked source/test baru (14)

`src/policy/approval-binding.ts`, `src/ui/session-state.ts`,
`test/approval-integrity.test.ts`, `test/ci-glob-expansion.test.ts`,
`test/daemon-stream-phase.test.ts`, `test/memory-consistency.test.ts`,
`test/presentation-observability.test.ts`, `test/ui-instance-isolation.test.ts`,
`test/work-mode-prompt.test.ts` (9) — plus 5 test yang sudah ada namun berubah dihitung di
tracked. (Total source/test baru = 2 + 7 = 9; 5 test lain adalah modifikasi.)

### A.3 Untracked dokumentasi & artefak (29)

8 laporan di `docs/audit/` (FINAL, LIVE_UAT, P0_BASELINE, P1_COMPLETION, P1_INTEGRATED,
P1_OBSERVABILITY, P1_REMAINING, UI_UX) + `CODE_QUALITY_AUDIT_2026-11-04.md` (root) +
21 debris (`a1..a6`, `b1..b5`, `c1`, `d1..d3`, `e1`, `f1..f2`, `g1`, `t.log.txt`, `t.log.xml`,
`t.xml`, `t2.log.txt`, `t3.log.txt`, `.tmp-probe.ts`).

---

## Appendix B — Commands & exit codes

| # | Command | Exit | Hasil |
|---|---|---:|---|
| 1 | `git rev-parse HEAD` | 0 | `cb60212…` |
| 2 | `git status --porcelain=v2` | 0 | 64 tracked modified, 0 staged, 43 untracked |
| 3 | `git show --stat --format=… cb60212` | 0 | 7 file, +105/−6 |
| 4 | `git diff --numstat 57c59d3..cb60212` | 0 | 7 file persis |
| 5 | `git merge-base --is-ancestor <sha> HEAD` | 0 | 4 SHA ancestor |
| 6 | `git worktree list` / `git stash list` | 0 | satu worktree; stash kosong |
| 7 | `bun test` (9 file: work-mode-tool-visibility, work-mode-contract, work-mode-prompt, work-mode-hooks, memory-consistency, p20, presentation-observability, approval-integrity, ui-instance-isolation) | **0** | **140 pass / 0 fail**, 908 expect, 4.28 s |
| 8 | `bun test` (4 file: errors-usage, usage-session, p15, p19) | **0** | **73 pass / 0 fail**, 359 expect, 1.55 s |
| 9 | `bun <temp>/minicode-audit-probe.ts` (registry/visibility) | **0** | output G1/G5 terlihat |
| 10 | `bun <temp>/minicode-audit-probe2.ts` (calibration/friendlyError) | **0** | factor stabil, cap 64, context mapping |
| 11 | `bun x tsc --noEmit` | — | **TIDAK DIJALANKAN** (di luar izin audit) |
| 12 | `bun run lint` | — | **TIDAK DIJALANKAN** |
| 13 | `bun test` full suite | — | **TIDAK DIJALANKAN** (dilarang brief) |
| 14 | `bun run gate:coverage` / `gate:pack` | — | **TIDAK DIJALANKAN** |
| 15 | PTY / live provider UAT | — | **TIDAK DIJALANKAN** |

Platform: Windows, Bun `1.4.3`. Probe ditulis di
`C:\Users\zo\AppData\Local\Temp\opencode\` (di luar repository) dan dihapus setelah audit;
repository hanya menerima laporan ini.

---

## Appendix C — Commit ancestry & fingerprint

```
HEAD            cb602124571d8e4638bdb47d38400c52d8fba976
parent         57c59d363b3f7bafca07c050992f6ffccb227463
origin/main    57c59d363b3f7bafca07c050992f6ffccb227463
tag v0.13.0    1cd3a92ceb9316a1eeb3b2020262aac086569049
677d77d…       ancestor HEAD (true)
54715d6…       ancestor HEAD (true) — docs branch refs/remotes/origin/research/frontier-harness-baseline
57c59d3…       ancestor HEAD (true)
cb60212…       ancestor HEAD (true) — HEAD itu sendiri
```

```
git diff | git hash-object --stdin
0d0a98b8ecac1dabc60f78136850cce0ff055103

sha256(git status --porcelain=v2)
6649963DB92B1EEB141490B3DEAD5CBF4192878BCAB5F134E7076FAE5C9B8339
```

Sidik jari diambil di awal dan di akhir audit: **identik**. Tidak ada mutation selama audit.

---

## Appendix D — Test & assertion yang relevan

| File | Assertion kunci | Jenis | Hasil audit |
|---|---|---|---|
| `test/work-mode-tool-visibility.test.ts` | `workModeVisible` untuk DISCUSS/PLAN/EXECUTE; MCP bertitik difilter | unit/visibility | lulus (bagian 140) |
| `test/work-mode-contract.test.ts` | handler nyata + ceiling; PLAN×allowlist ceiling; `delegate_task` deny/prompt | unit/dispatch-decision | lulus |
| `test/work-mode-prompt.test.ts` | `workModeHint` DISCUSS/PLAN sampai system prompt | unit | lulus |
| `test/work-mode-hooks.test.ts` | DISCUSS hook tidak jalan; **PLAN×auto hook jalan** | unit/real hook | lulus (gap terkonfirmasi) |
| `test/work-mode-runtime.test.ts` | `registry.list()` berubah; footer; `/work-mode` | unit/mocked; **tidak dispatch** | tidak dijalankan penuh di audit; dibaca |
| `test/p15-phase2-contracts-approval-recovery.test.ts` | `READONLY_TOOL_NAMES`/`GATED_TOOLS` membership; autonomous mirror | contract | tidak dijalankan di audit |
| `test/memory-consistency.test.ts` | reconcile adopt; revoke AND; supersession tarik baris lama | unit/integration | lulus (bagian 140) |
| `test/p20-phase8-…` | id ekspos; unknown id rollback; semua chunk tombstone; pin registry | unit/integration | lulus |
| `test/coverage-gaps.test.ts:107-120` | string id acak ditolak | unit | tidak dijalankan; dibaca |
| `test/presentation-observability.test.ts` | consequence severity; task status; context.window non-durable; machine status | unit | lulus |
| `test/presentation-policy.test.ts:338` | action context-window | unit | lulus |
| `test/presentation-projections.test.ts` | run marker anak; task ledger; rollup legacy | unit | tidak dijalankan di audit |
| `test/approval-integrity.test.ts` | stale approval; args hash; file fingerprint; grant sekali | integration | lulus (bagian 140) |
| `test/approval-tui.test.ts` | kartu approval tier+diff; Esc deny | mocked TTY | tidak dijalankan di audit |
| `test/ui-instance-isolation.test.ts` | dua sesi; mutasi A tidak menyentuh B; env tidak ditulis | integration | lulus |
| `test/errors-usage.test.ts:74-79` | context-window → “Context window exceeded” | unit | lulus (bagian 73) |
| `test/p19-phase7…:162-193,216-229` | chunk kumulatif tidak dijumlah; factor ≤64 | unit | lulus (bagian 73) |
| `test/p15-phase3…:433-452` | drift 1.8×; `effectiveContextTokens>=180` | unit | lulus (bagian 73) |
| `test/daemon-stream-phase.test.ts` | phase per langganan; tail_marker live | integration | tidak dijalankan di audit |
| `test/p2-daemon.test.ts` | framing; replay; approval; subscription | integration | tidak dijalankan di audit |
| `test/p13-multi-consumer.test.ts:487-540` | slow consumer putus, fast tetap hidup | integration | tidak dijalankan di audit |
| `test/mcp-resources-prompts.test.ts` | discovery; partial failure | integration | tidak dijalankan di audit |
| `test/mcp-http.test.ts` | SSRF/redirect/body cap | integration | tidak dijalankan di audit |
| `test/ci-glob-expansion.test.ts` | `shell: bash` di job Windows | config | tidak dijalankan di audit |

**Test gap yang dikonfirmasi:** tidak ada test untuk (a) gate in-flight calibration,
(b) dispatch setelah runtime WorkMode switch, (c) reconcile-after-supersede,
(d) footer occupancy, (e) `context.window` producer semantics, (f) machine child identity,
(g) PLAN hooks sebagai pelanggaran, (h) MCP pin lintas restart, (i) replay backpressure,
(j) daemon interrupt nyata.

---

## Appendix E — Tabel keputusan owner

| # | Keputusan | Opsi | Konsekuensi | Blocking |
|---|---|---|---|---|
| D1 | Strategi commit kandidat | (a) satu commit remediasi; (b) pecah per track; (c) tetap uncommitted | (a) mudah direproduksi; (b) review lebih jelas; (c) risiko hilang/tercampur | Semua klaim release |
| D2 | DISCUSS semantics | (a) read-only investigation (kode sekarang); (b) conversation-only | (a) 18 tool + network; (b) butuh mode/ceiling baru | P1.1, docs |
| D3 | Network read di DISCUSS | (a) izinkan dengan approval; (b) izinkan tanpa approval (sekarang); (c) larang | (a) aman; (b) risiko exfiltration; (c) DISCUSS lebih sempit | P1.1-c |
| D4 | PLAN hooks | (a) larang; (b) izinkan (sekarang) | (a) PLAN benar-benar read-only; (b) janji prompt tidak benar | P0.2-c |
| D5 | `--verify` di DISCUSS/PLAN | (a) larang; (b) izinkan (sekarang) | (a) konsisten; (b) shell eksekusi di mode read-only | P1.1-f |
| D6 | Reconcile vs superseded | (a) lewati baris superseded; (b) adopsi dengan status; (c) hapus | (a) benar; (b) butuh metadata; (c) kehilangan fakta | P1.3-c |
| D7 | Multi-session in-process | (a) jadikan produksi; (b) deklarasikan tidak didukung | (a) harus DI penuh; (b) batasi klaim | P2.1-c, P2.3-b |
| D8 | Pin MCP persisten | (a) persist + approve CLI; (b) biarkan in-memory | (a) supply-chain protection; (b) drift tak terdeteksi | P2.3-a |
| D9 | Daemon interrupt | (a) implementasi jalur stop; (b) dokumentasikan tidak ada | (a) operator bisa recovery; (b) runaway tak bisa dihentikan | P2.3-d |
| D10 | UI diagnostics | (a) TUI merender ACE/cutoff/verification; (b) tetap machine-only | (a) operator paham; (b) TUI buta | P1.5-b |

---

## Appendix F — Glossary & definisi klasifikasi

| Istilah | Definisi operasional |
|---|---|
| **WorkMode** | Lapis intent `DISCUSS/PLAN/EXECUTE`; hanya mempersempit, tidak pernah memperluas (`src/policy/work-mode.ts`) |
| **PermissionMode** | Otoritas allow/deny/prompt: `auto`, `readonly`, `plan`, `ask`, `allowlist`, `allow-all` (`src/policy/permission.ts`) |
| **Ceiling** | Handler `readonly`/`plan` yang dicek **sebelum** PM; deny tidak memicu prompt |
| **Visible** | Nama tool yang diiklankan ke model via `registry.list()`/schema |
| **Callable** | Lolos `registry.get()` (map konstruksi) dan `permission.check()` |
| **G1** | Bug reveal-after-start: visible naik, callable tidak |
| **G5** | PLAN×allowlist: visible 15, callable 12 |
| **TOCTOU** | Time-of-check-to-time-of-use; di sini approval preview vs operasi final |
| **Supersession** | Relasi dua arah `supersedes`/`superseded_by`; retrieval harus mengecualikan baris lama |
| **Occupancy** | Ukuran konteks saat ini (`session.contextTokens`), bukan total token yang dibelanjakan |
| **Spend** | Akumulasi `usage.getSession().totalTokens` sepanjang sesi |
| **FIXED_VERIFIED** | Perubahan ada + test/reproduksi audit memverifikasi perilaku |
| **FIXED_CODE_ONLY** | Perubahan terlihat di source; bukti eksekusi tidak memadai |
| **PARTIAL** | Sebagian kriteria terpenuhi; gap tersisa disebut |
| **NOT_FIXED** | Gap masih ada dan terbukti |
| **REGRESSION** | Perilaku yang sebelumnya benar kini rusak |
| **UNVERIFIED** | Belum cukup bukti |
| **BLOCKED** | Audit/test terhalang kondisi yang dijelaskan |
| **NOT_APPLICABLE** | Tidak berlaku, dengan alasan |

---

## Penutup — batas klaim

Audit ini berhenti di sini. Ia **tidak** menyusun roadmap final, **tidak** mengubah
`ROADMAP.md`/`PLAN.md`/`AGENTS.md`/source/test/config, dan **tidak** mengklaim seluruh
repository hijau. Satu-satunya artefak baru adalah laporan ini. Keputusan workflow dan
prioritas berikutnya berada pada pemilik.
