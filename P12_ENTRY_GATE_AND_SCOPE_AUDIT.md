# MINICODE P12.0 — ENTRY GATE & SCOPE AUDIT

**Sifat dokumen:** audit read-only perencanaan. Tidak ada source, test,
konfigurasi, dependency, atau dokumentasi repo yang diubah; tidak ada
staging/commit/push/fetch/reset/rebase; tidak ada test suite atau gate mahal
yang dijalankan. P12 **belum** dimulai.

## 1. Entry-gate verdict

**`READY WITH OPEN DECISIONS`**

Checkpoint post-P11 terverifikasi, prasyarat penutupan P11 terpenuhi, dan
arsitektur permission/work-mode yang ada dapat dipetakan dengan bukti repo.
Namun istilah **"Work Modes"** yang menjadi judul fase **tidak ada di dalam
repository** (grep `work mode|workmode|work_mode` seluruh `.ts`/`.md` =
nol hasil). Satu-satunya konsep sejenis yang ada adalah `PermissionMode`.
Karena itu fase ini tidak boleh dimulai sebagai implementasi sebelum pemilik
memutuskan taksonomi kerja (lihat §7 keputusan terbuka D-1…D-6).

## 2. Checkpoint Git dan worktree

| Item | Nilai terverifikasi |
|---|---|
| Branch | `main` |
| HEAD | `93f417900493572f5cdc479eb547de01707b28a6` (`docs(p11): add post-integration status note`) — cocok dengan hash yang dilaporkan pemilik |
| `origin/main` (ref lokal remote-tracking) | `93f4179…` — sama dengan HEAD lokal. Push `04c1e1e..93f4179` dieksekusi sesi ini dengan exit 0; **tidak ada `fetch`**, jadi ini bukan verifikasi independen bahwa remote saat ini masih di commit itu |
| Worktree | bersih: 0 tracked, 0 staged, 0 untracked (`git status --porcelain` kosong) |
| Commit `93f4179` | hanya `A P11_POST_INTEGRATION_STATUS.md` (satu file) |
| `P11_POST_INTEGRATION_STATUS.md` | ada di pohon ter-commit (`git cat-file -e HEAD:…`) |
| Dokumen closure P11 | `P11_PHASE_CLOSURE_REPORT.md:3` = `COMPLETE WITH DOCUMENTED LIMITATIONS (OWNER APPROVED 2026-10-18)`; tujuh berkas `P11_*.md` hadir di tree |

## 3. Roadmap & prasyarat closure yang berlaku

- `AGENTS.md` (root; satu-satunya AGENTS.md, diperiksa dengan `find`): aturan
  lapisan (`cli/` boleh impor `src/ui/`+`src/`; `src/` non-ui dilarang impor
  `src/ui/`; `src/ui/` dilarang impor `cli/`/`src/` non-ui/`#minicore`; lintas
  via DI dari composition root), jebakan runtime (getter `c/glyphs`,
  `displayWidth`, `sanitizeAnsi`, `ToolContext.cwd`), larangan edit
  `vendor/minicore/**` kecuali seam aditif eksplisit, kontrak terminal FROZEN
  (`docs/TERMINAL_CONTRACT.md` wajib dibaca sebelum mengubah output).
- `PLAN.md` **tidak** mendefinisikan fase ini: `PLAN.md:734` "P11 — Provider
  Hardening" dan `PLAN.md:690` "P12 UI Shell-Max" adalah program lama yang
  berbeda (sudah didisambiguasi di `P11_PRESENTATION_SCOPE_AND_EVIDENCE.md`
  §A). Definisi P12 "Work Modes & Permission Architecture" hanya berasal dari
  pemilik, bukan dari dokumen repo.
- Prasyarat P12 menurut `P11_PHASE_CLOSURE_REPORT.md:212-220`:
  1. Persetujuan integrasi — **diberikan dan dieksekusi** (fast-forward
     `609a417 → 3d946bc`; review pasca-integrasi `PASS WITH DOCUMENTED FINDINGS`).
  2. Integrasi + verifikasi status pada `main` — **selesai** (dokumen closure
     ada di `main`; status note `93f4179` tercatat).
  3. Persetujuan push — **diberikan dan dieksekusi** sesi ini (`origin/main`
     lokal = `93f4179`).
  Jadi **P12 secara administratif kini boleh dimulai** (subjek keputusan desain
  di §7). Item "wajib sebelum rilis npm" (dua kegagalan `gate:pack` baseline;
  `gate:coverage` tidak dipakai sebagai klaim hijau) **tetap terpisah** dan
  tidak dihapus oleh status P12.
- Kontrak yang membeku dan tidak boleh ditafsir ulang oleh P12:
  `docs/TERMINAL_CONTRACT.md` (I28 exit-code 0/1/2; I34 argv scope P11.2/P11.3),
  `P2_CLOSURE_HANDOFF.md` (presentasi observation-only; daemon ≠ canonical
  truth), `P10_PHASE_CLOSURE_REPORT.md` (kontrak `verify`), klausul layer AGENTS.

## 4. Inventaris aritektur (bukti file/simbol)

### 4.1 Model & handler permission — `src/policy/permission.ts` (657 baris)

| Simbol | Lokasi | Perilaku |
|---|---|---|
| `PermissionMode` | `:18` | union `"auto" \| "readonly" \| "plan" \| "allow-all" \| "ask" \| "allowlist"` |
| `PermissionAsk` | `:26-29` | DI prompt: `Promise<"allow" \| "deny" \| "always">` |
| `READONLY_TOOLS` | `:31-49` | 18 tool baca-only (termasuk `web_fetch`, `web_search`) |
| `GATED_TOOLS` + `isMcpToolName` | `:85`, `:207-212` | semua tool bertik (MCP terdaftar maupun tidak) = gated, auto-allow dilarang |
| `DEFAULT_BASH_ALLOWLIST` / env `MINICODE_BASH_ALLOWLIST` | `:99-160`, `:192-199` | mode `allowlist` paling ketat; operasi tulis shell tidak pernah di dalam |
| `getAllowlist()` + `sessionGrants` | `:180-203` | allowlist = config lokal + jawaban "always" in-memory (tidak persist ke disk) |
| `createPermissionHandler({mode, root, ask, allowLocalConfig, onApprovalEvent})` | `:164-178` | default `"auto"`; state.mode runtime-mutabel |
| `handlers: Record<PermissionMode, …>` | `:276-301` | tiap mode = satu fungsi keputusan; `readonly` = READONLY_TOOLS saja; `plan` = readonly + `todo_write`/`delegate_task`/`submit_result` |
| Urutan: jail → mode | `:434` | "jail mendahului mode" — bahkan `allow-all` tidak lolos jail |
| `allow-all` tetap inspeksi bash | `:482-486` | destructive `rm` tetap diperiksa `inspectBashCommand` |
| `__setMode/__getMode` | `:503-519` | kontrol mode runtime (Shift+Tab TUI) |
| `deny()` + `denyReasons` + `describeDenial()` | `:213-230`, `:510-520` | `check()` tetap `"deny"` polos; alasan actionable dibaca kernel via seam (audit #14); map hapus-saat-baca, cap 500 |

### 4.2 Titik otorisasi tunggal (kernel)

- `vendor/minicore/src/core/executor.ts:52` — `decision = await deps.permissions.check(snapshotToolCall(safeCall), permissionDeps)`.
  Satu-satunya pemanggilan gate di executor kernel.
- `vendor/minicore/src/core/session.ts:35,137,177` — kontrak `PermissionHandler`
  diturunkan ke session config. **Larangan AGENTS:** `vendor/minicore/**` tidak
  boleh diedit tanpa keputusan eksplisit (seam aditif saja).

### 4.3 Composition root & wiring

- `src/app/session.ts:140-179` — membuat handler bila tidak diinjeksi;
  `[DESIGN DECISION 6U]` handler injeksi = **kebijakan, bukan mode**: tanpa
  `__setMode`, `onPermissions` tidak di-wire, `permissionMode` tetap `"readonly"`
  sebagai metadata kernel (`:150-167`); `livePermissionMode()` getter meneruskan
  mode live ke kernel (`:174-179`).
- `cli/setup.ts:817-823` — rantai precedensi: `allowAll → "allow-all"`,
  `ask → "ask"`, `plan → "plan"`, `allowlist → "allowlist"`, else `"auto"`.
- `cli/setup.ts:1394-1405` — `ask: promptAsk` (DI prompt), `onApprovalEvent` →
  adaptor presentasi (observability saja; keputusan tetap handler),
  `onPermissions` → kontrol TUI.
- `cli/setup.ts:1753-1767` — **hooks di luar permission system** (audit #10 P1):
  `shouldRunHooks(permissionMode)`; di mode tanpa izin hook dilewati.
- `cli/setup.ts:2278-2282` (jalur MCP serve / 6S) — injeksi
  `permissionHandler` 6S + `permissionMode: "readonly"` metadata; komentar:
  mode-derived handler bisa dicabut via `__setMode` dan mengizinkan `web_fetch`,
  sehingga untuk run tanpa pengawasan WAJIB handler kebijakan.
- `cli/index.ts:253-257` — flag: `--allow-all`, `--ask`, `--plan`,
  `--allowlist` + env `MINICODE_PLAN`, `MINICODE_PERMISSION=allowlist`.
  `explicitPermission` (`:349`) → `resolveSandbox` (`:359`; `src/policy/sandbox-policy.ts:43`).
  **Tidak ada flag `--readonly`.**
- `cli/tui.ts:57` — `MODES = ["auto","ask","plan","allowlist","allow-all"]`;
  Shift+Tab menyiklus (`:228-233`) dengan `allow-all` dilewati; `/mode` (`:408`).
  `readonly` **tidak** bisa dicapai via siklus runtime.

### 4.4 Tool layer & scope sub-agen

- `src/app/tool-layer.ts:14-61` — `ToolScope "full"|"explore"`; `readonly`/
  `plan` menyaring tool agar model tidak membuang langkah pada tool yang pasti
  ditolak; MCP tools ikut difilter di plan/readonly; bash job tools di-rebind
  ke sid kanonik sesi (F-03).

### 4.5 Sub-agen (`delegate_task`)

- `src/tools/task.ts:61-72` — `SubAgentSpec.permissionMode: "auto" | "allowlist"`
  (subset ketat dari `PermissionMode`).
- `:226-233` — **F-07**: parent `plan`/`readonly`/`ask` memaksa sub-agen
  `explore` (read-only) agar delegasi tidak jadi celah eskalasi izin.
- `:449` — mapping anak: parent `allowlist` → `allowlist`, selain itu `auto`.
- `:236-245` — kontrak budget mode (ADR-25) terpisah dari fallback default.
- `setSubAgentSessionFactory` (`:104`) di-wire di composition root
  `cli/index.ts:139-166` (jurnal anak, `childOf` parent).

### 4.6jalur otonom (scheduler / 6S)

- `src/task/autonomous-policy.ts` — `ToolCapability` (`:44`),
  `TOOL_CAPABILITIES` (`:81`), `classifyTool` (`:331`), `AUTONOMOUS_TOOL_NAMES`
  (`:356`), `AutonomousPolicyLedger` (`:375`),
  `createAutonomousPermissionHandler` (`:438`), `assertAutonomousToolScope` (`:471`).
- `src/task/autonomous-context.ts:343` — handler kebijakan diinjeksi ke sesi
  otonom (deny-by-default, read-only, tanpa `web_fetch`).

### 4.7 Guard pendukung

- `src/policy/jail.ts` — `isPathOutsideRoot:94`, `isRealPathOutsideRoot:111`,
  `isCwdOutsideRoot:133`, `isDangerousLink:170` (+ sensitive/hook/owned-state).
- `src/policy/bash-guard.ts` — `inspectBashCommand:437` → `BashVerdict`
  (normalisasi, redirect targets, multiline fail-closed di allowlist).
- `src/policy/allowlist.ts:54` — `matchAllowlist`.
- `src/policy/sandbox-policy.ts` — `resolveSandbox:43`, `sandboxStrict:119`,
  `sandboxRefusalReason:137`.
- `src/mcp/server.ts:82-95` — **kontrak C3**: `validateArgs` mendahului
  permission/execute di jalur server MCP (urutan berbeda dari kernel REPL,
  disengaja dan setara aman).
- `src/runtime/production-execution.ts:1-27` — M15 satu jalur eksekusi turn
  (mode `owned`/`constructed`/`off`; admission fail-closed).

### 4.8 Persistensi

- Grep `permissionMode` di `src/session/**` = **nol hasil** — mode tidak
  dipersist; `--resume` tidak memulihkan mode (fail-safe secara default: kembali
  `"auto"` kecuali flag/env diulang).

### 4.9 Tes yang ada (inventaris; tidak dijalankan audit ini)

| Berkas | Jumlah tes | Fokus |
|---|---|---|
| `test/permission-matrix.test.ts` | 4 | matriks mode vs registry tool (mengklaim "registry allTools tepat 37 nama" — jangkar rapuh) |
| `test/permission-adversarial.test.ts` | 21 | allow-all tetap menolak tulis di luar root, symlink, dsb. |
| `test/delegate-audit.test.ts` | 17 | delegasi & pemetaan mode sub-agen |
| `test/bash-guard-escaping.test.ts` | 8 | escaping bash guard |
| `test/jail-realpath.test.ts` | 6 | jail realpath |
| `test/phase6s-autonomous-permission-policy.test.ts` | 6 | deny-by-default otonom, gate di boundary kernel |
| `test/phase6z-m31-permission-composition.test.ts` | 2 | reproduksi M31 + rantai produksi end-to-end |
| `test/agent-contract.test.ts`, `test/concurrency-same-process.test.ts`, `test/phase6t-trigger-policy-lifecycle.test.ts` | — | kontrak sub-agen & lifecycle trigger |

Keterbatasan bukti (dari `P11_FINAL_GATE_EXECUTION_REPORT.md`, tidak
dijalankan ulang): 13 test gagal pada gate final (keluarga flaky/jendela
polusi yang sudah dikenal + 2 kegagalan konten dokumen), 28 error TypeScript
kelompok tes Phase 3/4, 603 temuan lint. `src/policy/permission.ts` adalah
salah satu dari **19 modul kritis** dengan lantai liputan per-berkas yang wajib
dipertahankan.

### 4.10 Risiko duplikasi/bypass yang teridentifikasi

Ada **lima lapis kebijakan** yang saling terkait tetapi tidak mewakili satu
sumber kebenaran: (1) handler per-mode di `permission.ts`; (2) penyaringan tool
di `tool-layer.ts`; (3) pemetaan mode sub-agen di `task.ts`; (4) kebijakan
kapabilitas otonom di `autonomous-policy.ts`; (5) gating hooks di
`hooks/run.ts`. Jalur yang melewati handler mode-disetel: hooks (gated
terpisah), MCP serve (handler injeksi 6S), jalur scheduler/6S otonom
(`cli/setup.ts:2278-2282`: handler kebijakan 6S + `permissionMode: "readonly"`
sebagai metadata), sub-agen (F-07), bash
allowlist via env, dan sandbox fallback. ACP (`cli/commands/acp.ts`) tidak
memiliki referensi permission direct (grep nol) — status wiring-nya belum
terbukti dan menjadi target verifikasi, bukan jalur yang boleh diklaim
paksa-readonly. Setiap jalur ini harus diperlakukan
sebagai target pengujian bypass di P12, bukan sebagai tempat menambah kebijakan
baru secara diam-diam.

## 5. Ruang lingkup P12 yang diusulkan + pengecualian

Klasifikasi per butir: **[P]** perilaku eksisting yang wajib dipertahankan,
**[C]** perubahan P12 yang didukung bukti repo, **[O]** desain yang butuh
persetujuan pemilik, **[X]** di luar cakupan P12.

1. **Definisi & lifecycle work-mode.**
   - [P] `PermissionMode` 6 nilai; default `auto`; readonly/plan menyaring
     tool; allow-all tetap kena jail + inspeksi bash.
   - [O] Apakah "work mode" = `PermissionMode` yang sudah ada, atau konsep baru
     di atasnya (mis. goal-oriented mode lintas tool/session)? Repo tidak
     mendefinisikannya — keputusan pemilik (D-1).
   - [O] Persistensi mode saat `--resume` (saatnya tidak ada; D-2).
   - [O] Readonly masuk siklus runtime TUI? (saatnya tidak; D-3).
2. **Model izin & representasi kebijakan.**
   - [P] Deny-by-default; union ketat; `PermissionAsk` allow/deny/always.
   - [C] Konsolidasi sumber kebenaran (mis. registry mode → dipakai handler,
     tool-layer, MODES TUI, pemetaan sub-agen) **tanpa mengubah keputusan
     observable** — didukung bukti duplikasi §4.10.
   - [O] Bentuk representasi kebijakan final (registry/data-driven vs
     tetap function-per-mode; D-4).
3. **Otorisasi & titik enforcement.**
   - [P] Satu gate di `vendor/…/executor.ts:52`; jail mendahului mode;
     C3 validate-first di MCP; admission fail-closed M15.
   - [C] Suite tes bypass yang menutup jalur §4.10 (tidak butuh perubahan
     perilaku).
   - [O] Perubahan apa pun pada `vendor/minicore` = keputusan eksplisit
     (AGENTS); default P12: tanpa edit vendor (D-5).
4. **Interaksi dengan tool, agent loop, task, sub-agen.**
   - [P] F-07 forced-explore, mapping allowlist→allowlist, ADR-25 budget mode,
     `SubAgentSpec` subset, journal anak `childOf`.
   - [C] Pengujian regresi terfokus untuk interaksi ini sebelum refactor.
   - [O] Perubahan observable apa pun (mis. budget, mapping) butuh ADR owner.
5. **Semantik deny/approval/error.**
   - [P] `deny()` polos + `describeDenial` untuk observasi model;
     `onApprovalEvent` hanya melapor; exit code I28 (0/1/2) dibekukan.
   - [O] Apakah P12 menampilkan alasan denial ke operator/UI (saatnya hanya ke
     model/kernel); dampak kontrak (D-6).
6. **Persistensi & restorasi sesi.**
   - [P] Mode tidak dipersist; sessionGrants "always" in-memory.
   - [O] Subbagian dari D-2 bila pemilik menghendangi persistensi.
7. **Strategi tes.**
   - [P] Gaya tes repo: subprocess hermetik, detektor-mutasi, HOME isolasi.
   - [C] Peta tes baru per slice (lihat §6) ditulis **sebelum** implementasi
     (prinsip PLAN: setiap perbaikan meninggalkan tes yang gagal di kode lama).

**Pengecualian tegas [X]:** tanpa edit `vendor/minicore/**` tanpa keputusan;
tanpa perubahan exit code/grammar CLI (I28/I34); tanpa menambah otoritas pada
presentasi/daemon (invarian P2); tanpa kerangka TUI baru; tanpa perubahan
kontrak `verify` P10; tanpa pekerjaan test-health baseline (13 gagal/28 tsc)
kecuali diminta terpisah; tanpa rilis/push baru dalam fase ini.

## 6. Kriteria penerimaan & rencana tes

Label: **[R]** diturunkan dari requirement repo, **[P]** proposal butuh
persetujuan pemilik.

| # | Kriteria | Sumber | Cara diuji (sebelum implementasi ditulis) |
|---|---|---|---|
| A1 | Enforcement tidak dapat dilewati lewat jalur alternatif (hooks, MCP serve, scheduler/6S, sub-agen, bash allowlist env, sandbox fallback; ACP = target verifikasi) | [R] AGENTS (fail-closed, DI composition root), 6S/audit #10 | suite bypass: tiap jalur dijalankan subprocess dengan mode ketat + upaya aksi tulis/exec; harapan deny + alasan actionable; tiap tes punya detektor mutasi |
| A2 | Work mode memiliki semantik eksplisit dan teruji (taksonomi disetujui D-1) | [O] butuh D-1 | matriks mode × tool diperbarui (`permission-matrix`) + replay keputusan identik sebelum/sesudah refactor |
| A3 | Sub-agen dan eksekusi task mempertahankan batas izin (F-07, mapping allowlist, ADR-25) | [R] komentar kontrak `task.ts:226-245`, `delegate-audit.test.ts` | perluasan `delegate-audit` + tes otonom: parent plan/readonly/ask → anak explore-only; parent allowlist → anak allowlist |
| A4 | Operasi yang ditolak gagal secara aman dan dapat diprediksi (deny polos di `check()`, alasan via `describeDenial`, exit code I28) | [R] `permission.ts:213-230`; TERMINAL_CONTRACT I28 | tes unit `describeDenial` + tes CLI exit code pada jalur gagal |
| A5 | Kontrak P1–P11 tetap utuh | [R] AGENTS gate; kontrak frozen | jalankan gate terfokus yang relevan (ui-boundary, import-convention, exec-json-envelope, cli-subcommands, agent-contract) — **penuh hanya bila pemilik menyetujui** |
| A6 | Lantai liputan 19 modul kritis tidak turun (termasuk `src/policy/permission.ts`) | [R] `gate:coverage` floors | `scripts/coverage-gate.ts` setelah slice implementasi |
| A7 | Struktur/lapisan berubah → `docs/ARCHITECTURE.html` diperbarui | [R] AGENTS | checklist review per slice |

Catatan batas: gate penuh mahal (coverage run ±1252 dtk pada bukti P11) dan
baseline repo masih memiliki 13 test gagal/28 tsc/603 lint; keputusan pemilik
apakah P12 dimulai di atas baseline ini atau menuntut test-health dulu adalah
bagian dari §7.

## 7. Risiko, dependensi, keputusan terbuka pemilik

**Risiko/dependensi**
- R1 — Lima lapis kebijakan (§4.10): refactor tunggal berisiko mengubah
  keputusan observable; mitigasi = slice no-behavior-change dengan replay
  matriks.
- R2 — Vendor kernel: gate enforcement berada di `vendor/minicore`; perubahan
  apa pun butuh seam aditif + keputusan eksplisit.
- R3 — Jangkar rapuh: "registry allTools tepat 37 nama"
  (`permission-matrix.test.ts`) patah saat tool bertambah — refactor registry
  harus menanganinya sadar.
- R4 — Baseline kesehatan (13 gagal, 28 tsc, 603 lint) membatasi klaim
  "regresi nol" bila suite dijalankan penuh.
- R5 — Kontrak frozen (TERMINAL_CONTRACT, invarian P2, kontrak `verify` P10)
  membatasi perubahan semantik deny/approval yang tampak ke user.

**Keputusan pemilik yang belum ada (bukan asumsi yang boleh diisi sendiri)**
- **D-1** — Definisi "Work Mode": apakah = `PermissionMode` yang ada, atau
  konsep baru; jika baru, batas otoritasnya.
- **D-2** — Persistensi mode lintas `--resume` (default usulan: tetap tidak
  persist, fail-safe).
- **D-3** — Readonly dapat dicapai via siklus runtime TUI? (default usulan:
  tetap tidak).
- **D-4** — Bentuk representasi kebijakan tunggal (registry data-driven vs
  function-per-mode saat ini).
- **D-5** — Apakah P12 diizinkan menyentuh `vendor/minicore` (default: tidak).
- **D-6** — Menampilkan alasan denial ke operator/UI vs hanya ke model.
- **D-7** — Apakah P12 boleh dimulai di atas baseline health saat ini atau
  menuntut test-health dipisah dulu.

## 8. Urutan implementasi yang direkomendasikan (slice sempit, reviewable)

1. **P12.0** — audit ini (selesai, read-only).
2. **P12.1 — ADR desain** (dokumen + persetujuan pemilik atas D-1…D-6). Tanpa
   kode. Keluaran: taksonomi, representasi kebijakan, keputusan persistensi,
   peta tes baru.
3. **P12.2 — Konsolidasi registry mode tanpa perubahan perilaku**: satu
   sumber kebenaran dipakai handler/tool-layer/MODES/pemetaan sub-agen; tes
   replay matriks identik; jangkar 37-nama diganti dengan mekanisme yang tidak
   rapuh.
4. **P12.3 — Suite bypass-hardening**: tes per jalur (hooks, MCP serve,
   scheduler/6S, ACP-sebagai-target-verifikasi,
   sub-agen, env allowlist, sandbox) dengan detektor mutasi.
5. **P12.4 — Semantik denial observability** (hanya bila D-6 disetujui):
   permukaan `describeDenial` sesuai kontrak I28.
6. **P12.5 — Lifecycle/persistensi mode** (hanya bila D-2/D-3 disetujui).
7. **P12.6 — Dokumen kontrak**: pembaruan `docs/TERMINAL_CONTRACT.md` +
   `docs/ARCHITECTURE.html` bila perilaku berubah (wajib per AGENTS).

Setiap slice berdiri sendiri, berbasis dokumentasi/tes lebih dulu, dan dapat
direview terpisah tanpa membuka slice berikutnya.

## 9. Gap bukti yang harus diselesaikan sebelum menulis kode

1. Definisi "Work Modes" (D-1) — tidak ada sumber repo; tanpa ini scope P12
   tidak dapat diverifikasi.
2. Kebijakan persistensi/switchability (D-2/D-3) — saat ini tidak ada
   perilaku maupun kontrak yang mendokumentasikan maksudnya.
3. Izin vendor (D-5) — AGENTS mensyaratkan keputusan eksplisit untuk seam
   aditif.
4. Dampak terbukti dari duplikasi kebijakan (prinsip PLAN #2: "buktikan dampak
   sebelum memperbaiki") — perlu satu audit bypass empiris (P12.3 kecil)
   sebelum refactor P12.2, agar refactor tidak menambal temuan tanpa bukti.
5. Baseline health untuk klaim regresi (D-7): keputusan apakah menjalankan
   suite penuh sebagai bagian penerimaan P12 atau memakai gate terfokus.
6. ADR historis (ADR-25, 6S, M15, F-07) hanya ada sebagai komentar kode —
   tidak ada file ADR di repo; P12.1 sebaiknya menuliskannya secara eksplisit
   agar keputusan tidak hilang.

---

*Audit read-only: tidak ada perubahan file, commit, push, fetch, staging,
test-suite, atau gate. Laporan disimpan di luar repository
(`…/Temp/opencode/p12-entry-gate/`). P12 belum dimulai.*
