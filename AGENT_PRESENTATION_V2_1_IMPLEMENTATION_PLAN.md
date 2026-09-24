# MINICODE — Agent Presentation Architecture V2.1: Implementation Plan
## Blueprint only — DO NOT IMPLEMENT (no source changes in this task)

> Kontrak eksekusi untuk coding agent berikutnya. Keputusan arsitektur sudah final di V2.1;
> dokumen ini menjawab "apa diubah, di mana, mengapa, dan bagaimana tahu tidak rusak".

---

## 1. Executive Summary

Migrasi 8 fase (0–7), aditif-dulu, tanpa flag-day, tanpa rewrite renderer. Inti kerja:

1. **Adaptor semantik** (`src/presentation/adapter.ts` baru) yang mengubah event miskin lama menjadi Domain Events V2.1 — menutup kebisuan deny/abort/finalText/approval tanpa menyentuh `vendor/minicore`.
2. **Identitas diteruskan utuh** (`toolCallId` berhenti dibuang di `UiExecution`; `parentToolCallId` dilampirkan ke forward anak) — dengan **satu temuan data hilang**: `toolCallId` pemanggil `delegate_task` tidak tersedia di `ToolContext` maupun journal intent; Fase 2 menambahkan ke **satu** dari keduanya (rekomendasi: journal intent, app-layer, tanpa seam vendor).
3. **Reducer murni + Presentation State kecil + ContentStore sibling** (6 file baru di `src/presentation/`, tanpa `utils/helpers`).
4. **Tiga proyeksi** (TUI → Linear → ACP) dibungkus dari model dengan paritas string yang dijaga test, di belakang flag `MINICODE_PRESENTATION_V2` pada Fase 4–6.
5. **Cleanup** hanya setelah semua hijau + 1 rilis flag-on.

Satu-satunya perubahan pada file proteksi adalah **aditif dan minimal** (`contract.ts` tambah field; `permission.ts`/`prompt.ts` tambah emit; `transcript.ts`/`simple.ts` dibungkus bukan ditulis ulang) — dirinci di §33. Gate yang harus tetap hijau: `bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage (84.5 lines / 82 funcs + lantai per-berkas) && bun run gate:pack`.

---

## 2. Repository Reconnaissance

### 2.1 Direktori (aktual, diverifikasi)

```text
vendor/minicore/src/core/   loop.ts executor.ts session.ts events.ts provider.ts
                            tool.ts permission.ts snapshot.ts recovery.ts tokens.ts …
src/session/                journal.ts checkpoint.ts persistence.ts shadow-git.ts turn-marker.ts
src/policy/                 permission.ts executor.ts jail.ts bash-guard.ts context.ts
                            compaction.ts pricing.ts usage.ts ratelimit.ts scrub.ts …
src/tools/                  index.ts task.ts ask_user.ts bash.ts read_file.ts edit.ts patch.ts
                            move_file.ts delete_file.ts git.ts glob.ts grep.ts lsp.ts
                            memory.ts todo.ts submit_result.ts mcp_call.ts … (+37 registry)
src/ui/                     contract.ts footer.ts
src/ui/tui/                 app.ts transcript.ts            (2 berkas — bukan "tui/*" jamak)
src/ui/assistant/           simple.ts turn-status.ts        (2 berkas)
src/ui/render/              sanitize.ts width.ts wrap.ts markdown.ts highlight.ts theme.ts
                            format.ts errors.ts diff.ts table.ts collapse.ts detail.ts
                            reasoning.ts money.ts           (14 berkas)
src/ui/runtime/             screen.ts statusline.ts spinner.ts bus-debug.ts motion.ts
src/ui/input/               input.ts prompt-engine.ts
src/ui/screens/             dialog.ts form.ts …             (view murni)
src/ui/approval/            prompt.ts                       (1 berkas)
src/ui/i18n/                en.ts id.ts locale.ts
src/telemetry/              trace.ts
src/app/                    session.ts provider-layer.ts tool-layer.ts rag-layer.ts mentions.ts
src/mcp/ src/lsp/ src/agents/ src/providers/ src/memory/ src/lib/ src/hooks/ …
cli/                        index.ts args.ts setup.ts router.ts tui.ts commands.ts
                            wizard.ts model-manager.ts provider-manager.ts auto-update.ts
cli/commands/               exec.ts acp.ts + 10 subcommand (12 berkas)
test/                       193 berkas *.test.ts (+ helpers/, fixtures/, vcr/)
docs/                       TERMINAL_CONTRACT.md ARCHITECTURE.html architecture.md …
```

Koreksi terhadap asumsi V2/V2.1: `src/ui/turn-status.ts` yang disebut V2 = aktual `src/ui/assistant/turn-status.ts`; `src/input/` = aktual `src/ui/input/`; tidak ada `src/ui/tui/*` selain `app.ts` + `transcript.ts`.

### 2.2 Toolchain & perintah (aktual dari `package.json`, tanpa karangan)

| Keperluan | Perintah |
|---|---|
| Test (runner: **bun:test**, bukan vitest/jest) | `bun test` |
| Typecheck (strict + `noUncheckedIndexedAccess` + `noUnusedLocals/Parameters`, `verbatimModuleSyntax`) | `bun x tsc --noEmit` (alias `bun run typecheck`) |
| Lint/format (biome) | `bun run lint` (`biome check src cli test bench scripts`) |
| Coverage gate (agregat 84.5 lines / 82 funcs + 15 lantai per-berkas kritis) | `bun run gate:coverage` |
| Pack gate (23 pemeriksaan) | `bun run gate:pack` |
| Gate penuh (AGENTS.md, wajib hijau sebelum selesai) | `bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack` |
| CI cepat | `bun run gate:fast` (= gate + `gate:bash` + `bench:smoke` + `audit:harness`) |
| Vendor sync/check (kernel frozen) | `bun run vendor:minicore` / `bun run vendor:check` |
| Import kernel | `#minicore` (satu-satunya pintu, `package.json` imports + `tsconfig` paths) |

### 2.3 Konvensi yang mengikat implementasi (dari test + AGENTS.md)

- `test/ui-boundary.test.ts`: `src/ui/**` dilarang impor relatif keluar `src/ui/` dan dilarang `#minicore`; `src/**` non-ui dilarang impor `src/ui/`. → **File baru `src/presentation/` adalah `src/` non-ui**: boleh impor `#minicore` types, DILARANG impor `src/ui/`; `src/ui` DILARANG impor `src/presentation/` secara relatif keluar? `src/presentation/` bukan `src/ui/`, jadi `src/ui/** → ../presentation/x` **melanggar** boundary. Konsekuensi: proyeksi (TUI/Linear/ACP) TIDAK BOLEH impor presentation langsung — wiring lewat `cli/` (composition root) yang memegang keduanya. Ini keputusan implementasi penting turunan boundary test.
- `test/architecture-map.test.ts`: tiap berkas `src/**` WAJIB muncul di `docs/ARCHITECTURE.html` (per nama berkas) + pin kernel sinkron `VENDOR.md`. → Setiap file baru wajib didaftarkan di peta.
- `test/i18n-hardcode.test.ts` + `test/i18n.test.ts`: string user-visible TUI lewat `t()`; literal Indonesia hardcode di luar kamus dilarang. → Status/label baru wajib entri `en.ts` + `id.ts`.
- `AGENTS.md`: komentar Indonesia (mengapa), UTF-8 tanpa BOM, ubah perilaku rendering → update `TERMINAL_CONTRACT.md` + test peta proteksi; ubah struktur/dependensi → update `ARCHITECTURE.html`; coverage naik → naikkan minimum di `scripts/coverage-gate.ts`; jangan edit `vendor/minicore/**` kecuali seam aditif eksplisit; jangan commit kecuali diminta.
- `tsconfig`: `strict`, `noUncheckedIndexedAccess` (akses indeks/Map harus guard), `noUnusedLocals/Parameters`, `verbatimModuleSyntax` (import type terpisah).

---

## 3. Current Architecture Map

Graf aktual (simbol nyata, diverifikasi):

```text
cli/index.ts:main
  → cli/args.ts:{getArg,promptFromArgs,readPrompt} → cli/router.ts:dispatch
  → cli/setup.ts:createCliSession (COMPOSITION ROOT)
      → src/app/provider-layer.ts:{createProviderLayer,reloadProviders}
      → src/app/tool-layer.ts:setupToolLayer (src/tools/index.ts:{allTools,withMcpTools})
      → src/app/rag-layer.ts, src/app/mentions.ts
      → src/app/session.ts:createMinicodeSession
          → #minicore Session:createSession (vendor/.../session.ts:163)
              → loop.ts:executeTurn (provider.stream → ProviderEvent)
              → executor.ts:runCall (resolve→permission→validate→execute→truncate)
              → events.ts:createEventBus → AgentEvent ×9
      → src/policy/permission.ts:createPermissionHandler ──DI──▶ src/ui/approval/prompt.ts:{promptAsk,promptAskText}
      → src/tools/ask_user.ts:setAskTextFn ◀── promptAskText (DI)
      → src/tools/task.ts:{delegate_task,sessionFactory} ◀── factory dari cli/index.ts (DI)
      → src/session/journal.ts:attachMutationJournal ──subscribe──▶ execution:started/completed
      → checkpoint wiring (cli/setup.ts:424-463) ──subscribe──▶ turn:started/execution:completed/turn:completed
      → src/telemetry/trace.ts:{writeStepTrace,classifyToolResult,denyReasonOf} ◀── step-traces.jsonl
      → attachUI (cli/setup.ts:710-744): attachSimpleLogger(bus,{verbose,quiet}) + attachTurnStatus(bus,…)
  → cli/tui.ts:runTui ──▶ src/ui/tui/transcript.ts:Transcript(bus as UiBus) [cast :121,459]
                      ──▶ src/ui/tui/app.ts:TuiApp (pemilik layar) + ApprovalSink [tui.ts:490-498]
  → cli/commands/exec.ts:130 bus.on("*") → stdout JSONL / ringkasan
  → cli/commands/acp.ts:193 bus.on("*") → notifikasi lossy {text,delta}/{tool,name}
  → src/ui/assistant/simple.ts (linear; quiet menekan paint, state jalan)
  → src/ui/assistant/turn-status.ts (transient stderr; endTurn manual oleh driver)
  → renderer: src/ui/render/* + src/ui/runtime/{screen,statusline} + src/ui/input/input.ts
  → persistensi: src/session/persistence.ts (sqlite) + journal + checkpoint + trace.ts
```

Edge kritis (sumber → data → tujuan):

| # | Sumber (file:symbol) | Data/event | Tujuan (file:symbol) |
|---|---|---|---|
| E1 | `loop.ts:executeTurn` | `provider:text`, `provider:extension`, `step:started/completed` | `events.ts:emit` |
| E2 | `executor.ts:runCall` | `execution:started/completed` (HANYA jalur `tool.execute`; deny/unknown/validate: nol event) | `events.ts:emit` |
| E3 | `session.ts:run` | `turn:completed` (sukses saja; abort/gagal diam) + `TurnResult` | `events.ts:emit` |
| E4 | `permission.ts:promptAskOr` | keputusan allow/deny (via callback `ask`, bukan event) | `executor.ts:runCall` |
| E5 | `prompt.ts:promptAsk/Text` | jawaban user (via `askLine` + `ApprovalSink`) | `promptAskOr` / `ask_user.ts` |
| E6 | `task.ts:delegate_task.execute` | child session + forward `execution:*`+`extension` ber-tag `forwardedChild` via `ctx.emit` | bus parent |
| E7 | bus kernel | `AgentEvent` (cast `as unknown as UiBus`, `tui.ts:121,459`) | `contract.ts:UiBus` |
| E8 | bus | semua event (subscribe per tipe) | `simple.ts:attachSimpleLogger`, `transcript.ts:Transcript`, `turn-status.ts:attachTurnStatus` |
| E9 | bus `"*"` | event mentah | `exec.ts:130`, `acp.ts:193` |
| E10 | bus | `execution:started/completed`, `step:completed`, `turn:*` | journal, checkpoint wiring, step-trace (`setup.ts:414-517`) |
| E11 | `TurnResult/persistence` | history durable | `persistence.ts:saveSession` (sqlite), `finalizeJournal` |

---

## 4. V2.1 → Repository Verification

| Klaim V2.1 | Status file:line | REPO ACTUALLY HAS | IMPACT |
|---|---|---|---|
| Retry sampling internal tak di-emit | `loop.ts:91,97-103` CONFIRMED | `attempt++`, reset `text/reasoning/toolCalls`, tanpa emit | Tanpa `attemptId`: TEPAT, implementasi §10 tanpa ID baru |
| Deny/unknown/validate tanpa event | `executor.ts:44,58-73` CONFIRMED | return `errorResult`, nol emit | Adaptor merekonstruksi dari `step:completed.results` (§8 Fase 1): TEPAT |
| Abort/timeout diam | `session.ts:239-248` CONFIRMED | discard + tanpa emit; `createTimeout` `:291-303` | Adaptor dari `run()` reject + `abortError` category: TEPAT |
| `finish` reason hilang | `loop.ts:129-134` CONFIRMED | `tool_call`→push, `finish`→`completed` lokal saja | Tidak perlu di-emit (length/error/abort sudah jadi `AgentError`/extension error): TETAPKAN, jangan tambah event finish |
| `toolCallId` dibuang di kontrak | `contract.ts:23-26`, `tui.ts:121,459` CONFIRMED | `UiExecution.call:{name,args?}` tanpa id | Fase 2 tambah `id` (aditif): TEPAT |
| 6 jalan approval | `permission.ts:521-538`, `prompt.ts:24-150` CONFIRMED | allow/deny/always/aborted-deny/nonTTY-deny/noAsk-deny + `raceAbort :510-519` | Outcome enum + force-close (§11): TEPAT |
| Child session + forward + tag | `task.ts:227,283,287-316`, `journal.ts:1108,1146` CONFIRMED | `sub_*`, parent intent+`childSessionId`, forward 3 subscript + tag | Tambah `parentToolCallId` eksplisit (§12): TEPAT; **TEMUAN: id call sendiri tak tersedia di execute (lihat §12)** |
| Buffer 200K/500K vs 10×2000 | `collapse.ts:24-25`, `transcript.ts:19-21`, `simple.ts:48-60` CONFIRMED | 3 angka + reset-per-turn + sekali-habis | Store awal 200K/500K (§16): TEPAT sebagai baseline tune-able |
| `pending` TUI tak ber-cap | `transcript.ts:99-104` CONFIRMED | `pending += text` unbounded | Stream buffer ber-cap Fase 3/5: TEPAT, tandai sebagai bug batas (bukan sekadar desain) |
| `includes(".")` tersebar | 5 sites CONFIRMED (§13) | permission, journal ×3, tool-layer (+ test duplikat) | `ToolIdentity` parse-sekali: TEPAT |
| `toolStarts` by call.id | `setup.ts:470-480` CONFIRMED | Map started→duration via `Date.now` | Pindah ke adaptor sebagai data event: TEPAT |
| Coverage 84.5/82 + lantai | `coverage-gate.ts:69-104` CONFIRMED | MIN_LINES 84.5, MIN_FUNCS 82, 15 lantai | File baru wajib test agar lantai agregat tak jatuh: TETAPKAN di tiap fase |
| ui-boundary melarang ui→non-ui relatif | `ui-boundary.test.ts:53-66` CONFIRMED | scan import relatif keluar `src/ui/` | Proyeksi TIDAK impor presentation langsung; wiring via `cli/`:unit; TETAPKAN (§7, §20) |
| peta wajib daftar semua src/** | `architecture-map.test.ts:24-30` CONFIRMED | match per nama berkas + pin kernel | 6 file baru wajib masuk `ARCHITECTURE.html`: TETAPKAN |
| i18n anti-hardcode | `i18n-hardcode.test.ts` (ada) | dilarang literal ID di luar kamus | Label/status baru via `t()` + `en/id.ts`: TETAPKAN (§37) |

Tidak ada klaim V2.1 yang gugur. Satu temuan baru (§12) dan satu penegasan (§18: renderer keeps sanitize calls sebagai defense-in-depth — V2.1 "sekali di ingestion" dibaca sebagai otoritas, bukan penghapusan).

---

## 5. Change Surface Map

| File | Symbol | Current Responsibility | V2.1 Change | Phase | Risk |
|---|---|---|---|---|---|
| `src/presentation/events.ts` | — (BARU) | — | Tipe `DomainEvent` + `ToolIdentity` + `ApprovalOutcome` + konstanta durability | 1 | LOW (baru) |
| `src/presentation/adapter.ts` | — (BARU) | — | `createPresentationAdapter(bus)→{events,onEvent,toolStarts,…}`; deny/abort/finalText/approval emit; `eventSeq/ts`; `parseQualifiedName` | 1 | LOW (baru; dual-subscribe) |
| `src/presentation/model.ts` | — (BARU) | — | `PresentationState`, entry interfaces, `TurnSummary`, `Receipt`, `ContentRef` | 3 | LOW (baru) |
| `src/presentation/reducer.ts` | — (BARU) | — | `createInitialState()`, `reduce(state,event)`, `rebuildFromDurable()`, `supersedes` derivation, force-close | 3 | LOW (baru) |
| `src/presentation/store.ts` | — (BARU) | — | `ContentStore` (put/get/evict/resolve), cap 200K/500K, marker | 4 | LOW (baru) |
| `src/presentation/label.ts` | — (BARU) | — | `labelTool`, `summarizeResult`, `targetOf` (gabung 4 labeler lama) | 3 | LOW (baru) |
| `src/ui/contract.ts` | `UiExecution`, `UiStep` | Kontrak struktural UI | TAMBAH `id` (+ `toolCallId` alias bila perlu), `step.results` ringkas; JANGAN buang field lama s/d Fase 7 | 2 | MEDIUM (batas lapisan; cek `ui-boundary` tetap hijau) |
| `src/policy/permission.ts` | `promptAskOr`, `raceAbort`, `describeDenial` | Gate izin | Emit `approval.requested/settled` di samping callback (try/catch agar observability tak menggagalkan gate); buat `approvalId` | 1 | MEDIUM (jalur keamanan; perilaku gate TAK berubah) |
| `src/ui/approval/prompt.ts` | `promptAsk`, `promptAskText` | View persetujuan | Emit via hook yang di-inject dari `cli/setup` (bukan impor presentation — boundary!); `via:"prompt"` | 1 | LOW (aditif; lifecycle TUI tak berubah) |
| `cli/setup.ts` | `createCliSession`, wiring journal/checkpoint/trace/UI | Composition root | Wire adapter (F1); `file.changed` emit dari journal committed + checkpoint (F4); `ContentStore` + reducer wiring (F3-4); proyeksi wiring (F5-6) | 1–6 | MEDIUM (root; perubahan bertahap, revertibel) |
| `src/tools/task.ts` | `delegate_task.execute`, forward | Sub-agent | Lampirkan `parentToolCallId` ke forward (+ journal intent `toolCallId`, lihat §12); grup display di summary | 2 | MEDIUM (jangan ubah isolasi/amputasi/factory) |
| `src/session/journal.ts` | `appendMutationIntent`, record | Kebenaran komitmen | TAMBAH field opsional `toolCallId` pada intent (bila §12 memilih opsi B); read-only selain itu | 2 | LOW (aditif; `decideRecovery` tak tersentuh) |
| `src/ui/tui/transcript.ts` | `Transcript`, `ApprovalSink`, sections | Kolektor string TUI | BUNGKUS: baca dari `PresentationState` snapshot via cli-wiring; tambah kind/seq/id internal; `view/wrapAll` dipertahankan; `takeBufferedSections` dipertahankan s/d F7 | 5 | MEDIUM (paritas string dijaga test) |
| `src/ui/assistant/simple.ts` | `attachSimpleLogger`, labeler lokal | Printer linier | BUNGKUS: label/preview dari `label.ts`; perilaku string dipertahankan via snapshot test; `quiet` dipertahankan | 6 | MEDIUM (banyak cabang; paritas ketat) |
| `src/ui/tui/app.ts` | `TuiApp`, paint, status | Pemilik layar | SUMBER DATA saja: pinned activity + elapsed + ringkasan dari snapshot (tipe struktural via cli, bukan impor presentation) | 5 | LOW (tidak sentuh mesin paint) |
| `cli/commands.ts` | `/expand`, builtin registry | Slash command | `/expand [id]` query store (kompatibel: tanpa arg = perilaku lama) | 4 | LOW |
| `cli/tui.ts` | `runTui`, sink, popup | Driver TUI | Query store untuk expand; teruskan snapshot ke Transcript/App; cast `as unknown` dipertahankan s/d F7 | 4–5 | LOW |
| `cli/commands/exec.ts` | `on("*")` handler `:130` | Non-interaktif | Konsumsi event V2.1 dari adapter (fallback `"*"` lama s/d F6); envelope JSON tak berubah | 6 | LOW |
| `cli/commands/acp.ts` | `on("*")` `:193`, notifikasi | ACP stdio | Tambah lifecycle (`tool.*`, `approval.*`) terstruktur; deny-headless eksplisit; framing tak berubah | 6 | MEDIUM (protokol; uji `acp.test.ts` + hermetic spawn) |
| `src/telemetry/trace.ts` | `classifyToolResult`, `denyReasonOf` | Klasifikasi string | Tambah `category` terstruktur dari event; fungsi lama dipertahankan sebagai fallback adaptor s/d F7 | 1/7 | LOW |
| `src/ui/render/collapse.ts` | `bufferSection`, `getBufferedSections` | Buffer /expand linier | F7: menjadi view atas store (atau dihapus setelah paritas); F1–6: TAK tersentuh | 7 | LOW |
| `src/ui/render/format.ts` | `formatArgsPreview`, `formatStepCalls` | Preview string | F7: dilebur ke `label.ts`; F1–6: TAK tersentuh | 7 | LOW |
| `docs/ARCHITECTURE.html` | peta struktur | Dokumen hidup | Daftarkan 6 file baru + relasi (wajib `architecture-map.test.ts`) | 1,3 | LOW (dokumen) |
| `docs/TERMINAL_CONTRACT.md` | kontrak I1–I31 | Kontrak frozen | Update HANYA bila perilaku berubah (`/expand(id)`, evict-marker, ledger `denied/cancelled/interrupted`) + test | 4–5 | LOW (dokumen) |
| `scripts/coverage-gate.ts` | `MIN_LINES/MIN_FUNCS` | Gate | NAIKKAN bila coverage naik (aturan AGENTS.md); tambah lantai `src/presentation/*` bila stabil | tiap fase | LOW |

Tidak ada: `delete` file produk pada Fase 0–6; `rename`; perubahan `vendor/minicore/**` (NOL); rewrite renderer.

---

## 6. File Ownership Map (mandatory)

| Responsibility | Current Owner | Final Owner | Migration |
|---|---|---|---|
| Runtime lifecycle | MiniCore (`loop/session/executor`) + app wiring | TETAP MiniCore + app wiring | Tidak pindah; adaptor hanya mengamati |
| Event adaptation (lama→V2.1) | Tidak ada (tiap sink menafsir sendiri) | `src/presentation/adapter.ts` | F1 baru; sink lama dual-subscribe s/d F5–6 |
| Event identity (`toolCallId` terus, `approvalId` buat) | Provider (call id) / tidak ada (approval) | Provider → adaptor teruskan; `permission.ts` buat `approvalId` | F1–2 |
| Event sequencing (`eventSeq`, `ts`) | Tidak ada | `adapter.ts` (tepi, per sesi monotonik) | F1 |
| Tool identity (`ToolIdentity`) | String `name` + `includes(".")` tersebar | `adapter.ts:parseQualifiedName` (sekali) | F1 parse; F7 predicate ganti sites |
| Retry relationship (`supersedes`) | Tidak ada | `reducer.ts` (derived, aturan §10) | F3 |
| Approval lifecycle (keputusan) | `permission.ts:promptAskOr` + `prompt.ts` (runtime owner) | TETAP runtime; event cermin di adapter | F1 emit-samping; F3 force-close di reducer |
| Sub-agent correlation | `task.ts` (tag `forwardedChild`) + journal | `task.ts` (tambah parent-link) + adapter teruskan | F2 |
| Presentation state | `Transcript.lines` + `simple` closure + `collapse` buffer (tersebar) | `src/presentation/model.ts` (satu) | F3 baru; sink jadi proyeksi F5–6 |
| Reducer | Tidak ada | `src/presentation/reducer.ts` (murni) | F3 |
| Content storage | `collapse.ts` buffer + `transcript.sections` (ganda) | `src/presentation/store.ts` (sibling) | F4; hapus ganda di F7 |
| Transcript projection | `transcript.ts` (pemilik string) | `transcript.ts` sebagai view atas snapshot (wiring `cli/`) | F5 bungkus |
| TUI rendering (piksel) | `app.ts` + `runtime/*` + `input/*` | TETAP (sumber data diganti) | F5; mesin tak tersentuh |
| Linear output | `simple.ts` | `simple.ts` sebagai proyeksi (sumber: `label.ts` + snapshot) | F6 bungkus |
| ACP output | `acp.ts` handler `"*"` | `acp.ts` dari event V2.1 (adapter) | F6 |
| Terminal rendering | `render/*` + `runtime/*` | TETAP | Tidak pindah; §33 |
| Persistence (durable) | journal/checkpoint/persistence/trace | TETAP (sumber replay) | Tidak ada sistem persistensi kedua |
| Replay (`replay→reducer→state`) | Tidak ada | `reducer.ts:rebuildFromDurable` + adapter rekonstruksi | F3 unit; F4 restart-fallback |

---

## 7. Final Directory Structure

Diterima: `src/presentation/` 6 file V2.1 — diverifikasi ukurannya wajar (bukan `utils/helpers`; tiap file satu tanggung jawab; penempatan karena `src/ui` dilarang impor non-ui relatif dan non-ui dilarang impor `src/ui` — modul netral di `src/` non-ui dapat diimpor `cli/` dan (via wiring cli) dikonsumsi proyeksi tanpa melanggar boundary):

- `src/presentation/events.ts` — **tujuan**: kosakata V2.1 (event union, `ToolIdentity`, `ApprovalOutcome`, `FailCause`, `CancelReason`, `DenyReason`, `ArgsSummary`, `ResultSummary`, `Receipt`, `TurnSummary`, tabel durability sebagai `const`, `ContentRef` fwd-decl). **API publik**: tipe + `isTerminalEvent()`, `DURABILITY` map. **Dependensi**: tidak ada (murni tipe; boleh `import type` dari `#minicore` bila perlu — hindari, definisikan ulang struktural seperti `contract.ts`). **Dependents**: adapter, reducer, model, store, cli wiring. **Mengapa di sini**: satu sumber bahasa semantik; bukan di `src/ui` (akan dilanggar boundary oleh `cli/setup` + policy) dan bukan di `src/policy` (bukan kebijakan).
- `src/presentation/adapter.ts` — **tujuan**: satu-satunya jembatan lama→baru (subscribe bus kernel, emit V2.1, `eventSeq/ts`, `toolStarts` durasi, stream buffer, deny/abort/finalText/approval rekon, `parseQualifiedName`, `summarizeArgs` reuse dari `trace.ts`). **API**: `createPresentationAdapter(bus: EventBusLike, opts:{sessionId}) → { onEvent(fn), dispose(), getStreamState() }` — `EventBusLike` struktural agar tak impor vendor type secara keras (ikuti pola `UiBus`). **Dependensi**: `events.ts`, `trace.ts` (summarize/classify fallback), `sanitize.ts` (sekali). **Dependents**: `cli/setup.ts` saja. **Mengapa**: isolasi kebisingan migrasi di satu modul yang bisa dilepas (rollback = lepas wiring).
- `src/presentation/model.ts` — **tujuan**: state shapes (§14) + `createInitialState()` + `EntryRef`. **API**: tipe + konstruktor. **Dependensi**: `events.ts`. **Mengapa**: tipe terpisah dari logika (reducer) agar proyeksi bisa impor tipe tanpa logika (dan `cli` bisa structurally-type snapshot).
- `src/presentation/reducer.ts` — **tujuan**: `reduce()`, `rebuildFromDurable()`, `deriveSupersedes()`, force-close, first-terminal-wins, counter diagnostik. **API**: `reduce`, `rebuildFromDurable`, `createInitialState` (re-export). **Dependensi**: `model.ts`, `events.ts`. **Mengapa**: satu-satunya penulis state; murni (tanpa IO/clock/env).
- `src/presentation/store.ts` — **tujuan**: `ContentStore` + `ContentRef` + cap/marker/fallback. **API**: `createContentStore()`, `put/get/evict/resolve`, `isLive()`. **Dependensi**: `events.ts` (tipe ref). **Mengapa sibling**: non-otoritatif, lifecycle (evict) berbeda dari state.
- `src/presentation/label.ts` — **tujuan**: `labelTool/ToolTarget/summarizeResult/targetOf` (gabung `formatArgsPreview` + `toolSummary` + `toolLabel` + `ledgerTarget`). **API**: fungsi murni + `MAX_*` const. **Dependensi**: `events.ts`, `sanitize.ts`. **Mengapa**: satu labeler; dipakai reducer (summary) dan proyeksi (label) — menghilangkan 4 implementasi + 3 angka cap berbeda.

Perkiraan ukuran: `events.ts` ~250 baris (akseptabel — kohesif), lainnya 120–300 baris. Tidak perlu split/merge tambahan.

---

## 8. Final Event API

Format per event: tipe | required | optional | identity | korelasi | producer (runtime) | adapter source | consumer | durability | replay | idempotency.

- `turn.started` | `eventSeq,ts,sessionId,turnId,promptRef` | — | turnId | session | `loop.ts:34` (`turn:started`) | langsung | reducer→TurnEntry{running}; TUI jangkar | D | R | key `(turnId,started)` duplikat abaikan
- `turn.completed` | + `summary{toolsOk,toolsFailed,toolsDenied,toolsCancelled,toolsInterrupted,filesChanged,checkpointId?,durationMs}` | — | turnId | session | `session.ts:248` + `TurnResult` | agregat reducer-helper dari state turn (bukan hitung di adapter) | ringkasan turn; finalize sudah ada | D (sqlite turns) | R | `(turnId,settle)` first-wins vs failed/cancelled
- `turn.failed` | + `error{cause,message}` | — | turnId | session | `run()` reject non-abort (adapter tangkap di `runPromptWithVerify`/driver) | adaptor (baru) | merah turn + ringkasan | D (trace error) | R | sama
- `turn.cancelled` | + `reason{user,timeout,budget,signal}` | — | turnId | session | abort/timeout (`abortError`, `createTimeout`) | adaptor (kategori dari `signal.reason`/error kind) | redup turn + cascade | D | R | sama
- `model.delta` | `turnId,delta` | — | turnId | — | `loop.ts:123` | langsung (live channel, bukan ke reducer) | proyeksi live + adaptor buffer | L | — | n/a (buffer append)
- `model.completed` | `turnId,text,truncated` | `expandRef` | turnId | — | `TurnResult.finalText` (diabaikan UI hari ini) | adaptor dari result + buffer | `ConversationEntry` | D (assistant message) | R | `(turnId,model.completed)` last-wins (satu per turn)
- `reasoning.delta` | `turnId,delta` | — | turnId | — | `loop.ts:126-127` kind reasoning | langsung live | thinking live / buffer | L | — | n/a
- `reasoning.completed` | `turnId,truncated,expandRef` | — | turnId | — | batas turn (adaptor tutup buffer) | adaptor | `ReasoningEntry` (L3) | D(ringkas) | R | seperti model.completed
- `tool.started` | `toolCallId,turnId,stepId,identity,argsSummary` | `parentLink?` (forward anak) | toolCallId | step/turn/session | `executor.ts:86` (+ `step:started` untuk stepId) | langsung + `UiExecution.id` (F2) | `ActivityEntry{running}` | D (step-trace intent) | R | `(toolCallId,started)` duplikat abaikan
- `tool.progress` | `toolCallId,message` | — | toolCallId | — | `ctx.emit` sukarela (SEAM ADITIF bila dibutuhkan; default: tidak ada tool meng-emit — lihat §17/§31) | langsung live | update `ActivityEntry.progress` (live; persist pesan terakhir saja) | L | — (terakhir menempel, best-effort) | last-wins
- `tool.completed` | `toolCallId,durationMs,summary,expandRef` | `receipt?` | toolCallId | approval?/receipt | `executor.ts:102` | + durasi adaptor + summary `label.ts` + konten→store | final hijau + receipt | D (message+journal+trace) | R | first-terminal-wins (§15)
- `tool.failed` | + `cause{invalid,exec,provider,agent},message` | `hint?` | toolCallId | — | `executor.ts:102` isError (kategori dari adaptor: parse `invalid arguments/unknown tool` → invalid; `AgentError` kind → agent; provider category → provider; else exec) | adaptor | final merah + hint | D | R | sama
- `tool.denied` | `toolCallId,reason:DenyReason,message` | — | toolCallId | — | TIDAK ADA (recon dari `step:completed.results[]` berisi `permission denied…` + `describeDenial`) | adaptor (baru; `denyReasonOf` sebagai fallback) | final ⊘ kuning | D (step-trace denied) | R | sama (terminal)
- `tool.cancelled` | `toolCallId,reason` | — | toolCallId | — | TIDAK ADA (recon: `execution:started` tanpa `completed` + turn abort/timeout) | adaptor (baru) | final ○ redup | D | R | sama (terminal)
- (`tool.interrupted`: TIDAK di-emit; ditetapkan rebuild, §23.)
- `approval.requested` | `approvalId,toolCallId,turnId,identity,argsSummary,via` | — | approvalId | tool+turn | `promptAskOr` (`permission.ts:531`) / `promptAsk/Text` | emit-samping (F1) | `ApprovalEntry{requested}` + blok TUI (existing) | D (audit; deny reason di journal) | R | `(approvalId,requested)` abaikan duplikat
- `approval.settled` | `approvalId,toolCallId,turnId,outcome` | — | approvalId | tool+turn | 6 jalan (§5) + force-close reducer | emit-samping + reducer force-close | keputusan tercatat (existing) | D | R | first-settle-wins
- `file.changed` | `toolCallId,paths` | `journalSeq?,checkpointId?` | toolCallId | journal/checkpoint | journal committed + checkpoint record (`setup.ts:414-463`) | adaptor (baru; korelasikan via toolCallId→waktu/urutan + paths) | `receipt` di entry | D | R | `(toolCallId,file.changed,paths-hash)` dedup
- `test.completed` | `toolCallId,passed,failed,summary` | — | toolCallId | — | pola output `bash` (adaptor parse ringan: `x passed`, `y failed`, Jest/Pytest/bun patterns —best-effort; gagal parse = tidak emit) | adaptor derived | badge test | D (ringkas) | R | `(toolCallId,test.completed)` last-wins
- `context.compacted` | `reason` | — | turnId | — | `loop.ts:73-76,185` | langsung | `SystemEntry` | D | R | append (boleh ganda, tiap kompaksi satu baris)

Tidak ada event baru di luar daftar (khususnya: tidak ada `finish`, `heartbeat`, `run.*`, `agent.*`). Penghapusan vs V2.1: tidak ada.

---

## 9. Event Field Ownership

```text
sessionId        kernel-config/app (createCliSession sessionId; anak: task.ts:227 childId)
                   → adapter (teruskan; forward anak bawa sessionId=child + link) → event
turnId           loop turnCount (turn:started.turn) / session.state (step-trace :487 memakai stepCount)
                   → adapter (sumber: turn:started terbaru per sesi) → event
stepId           loop Step.index (step:started/completed) → adapter (tracker step aktif) → event
toolCallId       PROVIDER (tool_call.id) → kernel ToolCall.id → execution.call.id
                   → adapter TERUSKAN (F2: via UiExecution.id; F1: execution.call.id kernel masih ada di bus —
                     adaptor subscribe bus kernel langsung, bukan UiBus!) → event. DILARANG dibuat ulang.
approvalId       permission.ts promptAskOr (buat: `${turnId}:${toolCallId}:${counter}` atau randomUUID —
                   rekomendasi: randomUUID 8 char seperti childId task.ts:227) → event requested+settled
eventSeq         ADAPTER (counter per sesi, saat observasi) → event. Satu-satunya pembuat.
ts               ADAPTER (Date.now di tepi) → event. Reducer DILARANG memanggil jam.
durationMs       ADAPTER (toolStarts map, pola setup.ts:470-480 dipindah) → tool.completed/failed
parentToolCallId task.ts execute — TEMUAN: tidak tersedia (§12) → opsi A (pilih): journal intent + toolCallId
                   (app-layer, tanpa seam vendor). Adapter baca intent → tempel ke forward.
supersedes       REDUCER (derived, aturan §10) → bukan field event, melainkan link di ActivityEntry.
ToolIdentity     ADAPTER parseQualifiedName(qualified) sekali → event.identity. Registry tetap key qualified.
receipt          ADAPTER rakit dari file.changed (journalSeq/checkpointId/paths) + label.ts stats
                   → tool.completed.receipt / entry.receipt.
ContentRef       REDUCER+STORE ({toolCallId, idx}) saat completed/model.completed → entry.expandRef.
```

Aturan: identitas mengalir hilir (provider→kernel→adapter→event); tidak ada lapisan hilir yang membuat ulang ID kecuali `approvalId` (pemilik permission), `eventSeq/ts` (adapter), `ContentRef` (store), `supersedes` (reducer derived).

Catatan implementasi penting: **adapter subscribe bus kernel langsung** (`session.events`), bukan `UiBus`, sehingga `execution.call.id` tetap tersedia walau `UiExecution` membuangnya — perbaikan kontrak F2 tetap dikerjakan agar `cli/tui.ts` cast tidak selamanya buta.

---

## 10. Retry Implementation

- **Diamati di**: `step:completed.results[]` + `execution:started/completed` (keduanya membawa `toolCallId` + nama + args + terminal status) — cukup, tanpa data baru. "Semantically same tool/target": `identity.qualified` sama + `targetOf(args)` sama (label.ts) — `targetOf` = `path ?? from/to ?? cmd/command ?? pattern ?? query ?? prompt-slice`, mengikuti `ledgerTarget` + `formatArgsPreview` yang sudah ada.
- **Status terminal tersedia di**: reducer (penerima `tool.completed/failed/denied/cancelled`) — derivasi MILIK REDUCER (bukan adapter), karena butuh status final lama + ordering event. Adapter hanya menyediakan `eventSeq` + `tsStart/tsEnd`.
- **Predikat** (`deriveSupersedes(newCall, state)`): (1) `newCall.turnId == old.turnId` (sesi sama implisit); (2) `qualified` + `target` sama; (3) `old.status ∈ {failed,denied}` (completed/cancelled/running/interrupted TIDAK ditautkan — sukses lalu panggil lagi = aksi baru; cancel lalu panggil lagi = aksi baru); (4) `old.tsEnd ≤ new.tsStart` via `eventSeq` (old terminal seq < new started seq); (5) paralel tumpang-tindih (old belum terminal saat new started) = TIDAK ditautkan; pilih old dengan terminal-seq terbesar bila >1 kandidat.
- **Edge**: `denied→allow` (retry setelah approve) = rantai paling umum — tampil `↻ retry (approved)`. `failed→failed→completed` = rantai; `supersedes` menunjuk pendahulu langsung (rantai single-linked, agregat via traversal). Beda target = tidak ditautkan. Beda turn = tidak ditautkan (turn boundary memutus rantai — keputusan sadar: retry lintas turn adalah tugas baru).
- **Test**: unit `deriveSupersedes` (5 aturan + 4 edge: paralel, beda target, completed-lalu-panggil, rantai-3) — `test/presentation-reducer.test.ts`; integrasi event-seq → label `↻` di proyeksi.
- **Data hilang**: tidak ada — semua tersedia di event (§8). `argsSummary` harus memuat `target` (pastikan `summarizeArgs` adaptor mempertahankan `path/from/to/cmd/pattern/query` — reuse `trace.ts:summarizeArgs` yang sudah memilih kunci itu).

---

## 11. Approval Implementation

- **Titik integrasi** (tanpa duplikasi logika; runtime tetap pemilik keputusan):
  1. `src/policy/permission.ts:promptAskOr` — buat `approvalId`, panggil hook `emitApproval({requested})` SEBELUM `askUser(call)`, dan `emitApproval({settled})` SETELAH jawaban/deny/aborted (6 cabang dipetakan ke outcome §5). Hook di-inject via `createPermissionHandler` opts (pola DI yang sama dengan `ask`) dari `cli/setup.ts` → adapter. Bungkus try/catch: observability tak boleh menggagalkan gate.
  2. `src/ui/approval/prompt.ts:promptAsk/promptAskText` — TIDAK emit langsung (boundary: ui tak boleh impor presentation). Menerima opsional `onEvent` callback dari pemanggil? Lebih bersih: `promptAskOr` (pemilik lifecycle) yang emit; `prompt.ts` hanya view (tetap). `ask_user` flow: `askUserTool.execute → askTextFn (=promptAskText)` — emit `requested/settled` dari `ask_user.ts` via hook yang sama di-inject `cli/setup.ts` (seperti `setAskTextFn`). `question/options` → `argsSummary{prompt: slice}`.
  3. `session`/turn settle — bukan file session; force-close di **reducer** saat `turn.*` settle (I-A08) + saat `rebuildFromDurable` (crash).
  4. TUI flow — tak berubah (sink+suspend+repaint+askLine, I23). Blok + keputusan tetap dicatat transkrip (existing `pushBlock`).
  5. Headless (`!stdin.isTTY`, stdout-pipe-tanpa-sink, tanpa `ask`) — `promptAskOr` deny + emit `requested{via:system}→settled{deny(headless),system}` (audit, bukan diam).
  6. ACP — `deny-headless` yang sudah ada + event `approval.*` diteruskan ke notifikasi (F6).
- **Lifecycle**: request → {allow | allow-always(+saveAlways efek) | deny(user/system) | cancelled(parent-aborted/timeout/parent-ended/renderer-failure)} → force-close bila turn settle/crash-rebuild dengan approval terbuka.
- **Anti-duplikasi**: satu emitor (permission/ask_user via hook) + satu penutup (reducer). `describeDenial("declined by user")` tetap (observasi model tak berubah).

---

## 12. Sub-Agent Implementation

Nilai yang dibutuhkan V2.1 dan ketersediaannya:

| Nilai | Tersedia di | Cara pasang |
|---|---|---|
| `parentSessionId` | `task.ts:226` (`parentId = todoSession.id`) | sudah ada di journal opts `:283`; adaptor baca intent record |
| `parentTurnId` | turn aktif parent (adapter tahu dari `turn:started` terakhir) | adaptor tempel saat forward tiba (bukan task.ts) |
| `parentToolCallId` | **TIDAK tersedia** — `execute({prompt,mode,maxSteps}, ctx)`: `ToolContext` (vendor `tool.ts`) tidak membawa call id; journal intent (`appendMutationIntent{session,tool,cwd,childSessionId,argsHash}`) tidak membawa call id | **Opsi A (pilih)**: tambah field opsional `toolCallId` ke `appendMutationIntent` (app-layer `journal.ts`, tanpa seam vendor). `task.ts:228-234` mengisi dari… masih butuh id di execute → **maka Opsi A lengkap**: adapter korelasikan `delegate_task execution:started` (call.id, diamati bus) → intent terbaru sesi itu (`childSessionId` match via forward tag) → tulis pasangan `(toolCallId↔childSessionId)` di adapter registry sementara. TANPA ubah journal ATAU ctx. |
| `childSessionId` | `task.ts:227` (`sub_*`) | sudah di intent + `forwardedChild` tag `:293-296` |

- **Link dibuat di**: adapter (registry `childSessionId → parentToolCallId` dari pasangan started/intent). **Ditempel di**: setiap forward anak (`execution:started/completed`, `usage`) sebagai `parentLink` (jangan mutasi event asli — bungkus; tag `forwardedChild` dipertahankan untuk jurnal skip).
- **Disimpan di**: `ActivityEntry{sessionId: child, parentToolCallId}` (model parent; namespace per sessionId di Map — kunci Map = `${sessionId}:${toolCallId}`).
- **TUI**: grup collapse per `childSessionId` di bawah baris `delegate_task` (default collapse; expand per grup). **Linear**: ringkasan anak inline (existing `sub-agent done…[steps N]`) + Aron masuk akal `--verbose` menampilkan tool anak. **ACP**: teruskan sebagai lifecycle dengan `sessionId` anak (konsumen bisa filter).
- **Anti-duplikasi**: jurnal parent skip forward (existing `:1108,1146`); reducer parent TIDAK membuat `ActivityEntry` lifecycle ganda untuk forward `usage` (hanya `execution:*`); `turn.summary` parent menghitung 1 untuk `delegate_task` (bukan N tool anak).
- **Tanpa redesign** `delegate_task`: isolasi, amputasi, forcedExplore, pool, factory DI — tak tersentuh.

---

## 13. MCP Identity Migration

Penciptaan qualified name: `src/tools/index.ts:99-100` (`withMcpTools` append `serverid.toolname` runtime; dedup nama — `test/coverage-gaps.test.ts:23-31`).

| Current Site | Current String Logic | Final Predicate | Phase |
|---|---|---|---|
| `src/policy/permission.ts:204` | `GATED.has(name) \|\| name.includes(".")` | `isGated(identity)` (`origin==mcp → true`, sama makna) | 7 (F1: adaptor sediakan identity; policy baca dua-duanya) |
| `src/session/journal.ts:133` (+`:1113,1165,1187`) | `name.includes(".") ? "mcp_call" : name` (kelas mutasi) | `mutationClass(identity)` | 7 |
| `src/app/tool-layer.ts:42` | `!t.name.includes(".") \|\| EXPLORE…` (filter anak) | `identity.origin==builtin \|\| EXPLORE…` | 7 |
| `test/permission-matrix.test.ts:126,138` | mirror `includes(".")` di test | update mirror → predicate baru | 7 (bersama kode) |
| `src/tools/index.ts:99-100` | kreasi `serverid.toolname` | TETAP (sumber `qualified`); tambah `namespace` saat registrasi bila tersedia dari `mcp/client.ts` (best-effort; fallback parse) | 2 |
| Renderer/labeler (`ledgerTarget`, `toolSummary`, `toolLabel`, `turn-status.toolLabel`) | `args.path/cmd` + nama mentah | `label.ts` atas `ToolIdentity` (`namespace/name` terstruktur) | 3 (baru) → 7 (hapus lama) |

Renderer tidak pernah infer origin — `identity.origin` dibawa event. Fallback parse (`split(".")` sekali di `parseQualifiedName`) hanya di adapter, terdokumentasi sebagai kompatibilitas (nama builtin tak boleh mengandung titik — tegakkan via test bila perlu).

---

## 14. Presentation State Implementation

```ts
// src/presentation/model.ts (final; verifikasi tsconfig: noUncheckedIndexedAccess → akses Map pakai .get+guard)
interface ActivityEntry { kind:"tool"; seq:number; turnId:number; stepId:number; toolCallId:string;
  sessionId:string; parentToolCallId?:string; identity:ToolIdentity; target?:string;
  status:"running"|"completed"|"failed"|"denied"|"cancelled"|"interrupted";
  tsStart:number; tsEnd?:number; durationMs?:number; progress?:string; summary?:string;
  denyReason?:DenyReason; error?:{cause:FailCause; message:string; hint?:string};
  supersedes?:string; approvalId?:string; expandRef?:ContentRef; receipt?:Receipt; }
interface TurnEntry { kind:"turn"; seq:number; turnId:number; sessionId:string;
  status:"running"|"completed"|"failed"|"cancelled"|"interrupted";
  tsStart:number; tsEnd?:number; summary?:TurnSummary; error?:string; }
interface ApprovalEntry { kind:"approval"; seq:number; turnId:number; approvalId:string;
  toolCallId:string; identity:ToolIdentity; state:"requested"|"settled"; outcome?:ApprovalOutcome; }
interface ConversationEntry { kind:"message"; seq:number; turnId:number; role:"user"|"assistant";
  text:string; truncated:boolean; expandRef?:ContentRef; }
interface ReasoningEntry { kind:"reasoning"; seq:number; turnId:number; truncated:boolean; expandRef:ContentRef; }
interface SystemEntry { kind:"system"; seq:number; turnId:number; text:string; }
interface PresentationState { sessionId:string; seq:number; turns:Map<string,TurnEntry>; // key sessionId:turnId (anak numbering sendiri)
  activities:Map<string,ActivityEntry>; approvals:Map<string,ApprovalEntry>;
  conversation:ConversationEntry[]; order:EntryRef[]; }
```

Per field: sumber = event V2.1 (§8); mutasi = reducer pada event terkait (§15); durable = semua kecuali `progress` (live) — replay merekonstruksi sisanya; derived = `supersedes`, `TurnSummary`, counts (`DerivedState` dihitung on-demand, bukan disimpan — kecuali cache dengan invalidasi seq); ephemeral = `LiveState{streams,pinnedTool}` (terpisah dari state, §20 V2.1); tidak ada ANSI/width/cursor/handle/timer/payload (payload hanya `ContentRef`).

Ukuran: state untuk 500 tool ≈ 500 entry kecil (<1 MB) + store bounded 500K — di bawah transcript 5000 baris hari ini secara order.

---

## 15. Reducer Implementation

`reduce(state, event): state` — murni; tanpa IO/clock/env; `Map` dengan guard (`noUncheckedIndexedAccess`).

| Event | State Mutation | Idempotent? | Derived Effects |
|---|---|---|---|
| turn.started | `turns.set(running,tsStart)`; `seq` update | ya (abaikan started kedua) | — |
| tool.started | `activities.set(running)`; `order.push(activity-ref)` | ya | — |
| tool.progress | `entry.progress = message` (bila entry ada & running) | last-wins | — |
| tool.completed/failed/denied/cancelled | terminal: set status/tsEnd/duration/summary/error/receipt/expandRef | **first-terminal-wins** (terminal kedua diabaikan + Diagnostik counter++) | `deriveSupersedes` (utk completed/failed/denied baru); turn counts |
| approval.requested | `approvals.set(requested)`; link `entry.approvalId` | ya | — |
| approval.settled | set outcome; cerminkan ringkas ke activity (`approved/denied` flag display) | first-settle-wins | — |
| file.changed | `entry.receipt = merge(receipt,{paths,journalSeq,checkpointId})` | dedup per (toolCallId+paths) | — |
| test.completed | `entry.receipt.test = …`; `summary` badge | last-wins | — |
| model/reasoning.completed | push `conversation`/`reasoning` + `order` | `(turnId,type)` last-wins | — |
| turn.completed/failed/cancelled | set turn final + summary; **force-close**: approvals terbuka turn itu → `settled{cancelled(parent-ended)}`; activities `running` turn itu → `cancelled(parent-ended)` (turn.cancelled) — untuk turn.failed: running → `cancelled(parent-ended)` juga (bukan failed: kegagalan milik turn, bukan tiap tool) | first-settle-wins | `TurnSummary` agregat |
| context.compacted | push `SystemEntry` | append (boleh ganda) | — |
| rebuild (bukan event) | `rebuildFromDurable(durable)`: terapkan turn/step/tool/approval/file yang durable; activities terbuka tanpa terminal + sesi berakhir → `interrupted`; approvals terbuka → `settled{cancelled(parent-ended)}` | — | — |

Edge handling: `unknown toolCallId` (progress/completed tanpa started — forward race / crash-rebuild) → buat entry minimal `{status per event, incomplete:true}` + counter `orphanTool` (observability §30), JANGAN throw. `unknown approvalId` (settle tanpa request — restart) → buat entry settled langsung + counter. `unknown turnId` → buat TurnEntry lazy. Late event setelah terminal → abaikan + counter `lateEvent`. Semua counter masuk objek diagnostik reducer (bukan state semantik) yang diekspos ke §30.

---

## 16. Content Store Implementation

Verifikasi nilai existing: `collapse.ts:24-25` (`MAX_SECTION_CHARS=200_000`, `MAX_BUFFER_TOTAL=500_000`) — jadikan **baseline awal** (bukan angka magis baru); `transcript.ts:19-21` (10×2000) dihapus di F7 setelah paritas.

- `ContentRef = {toolCallId:string; idx:number}` (idx untuk multi-chunk: output + diff + reasoning terpisah).
- `put/get/evict/resolve`: `put` potong per-entry 200K (surrogate-safe + `splitTrailingEscape`, reuse pola `collapse.ts:66-71`); total >500K → evict FIFO tertua; entry ter-evict DITANDAI (`store.markDead(ref)` → reducer set `expandRef.dead=true` — proyeksi tampilkan "konten di luar retensi — lihat `.minicode/step-traces.jsonl` / sesi sqlite", bukan kosong).
- **Durable fallback**: `resolve(ref)` miss → coba sqlite messages (tool result full — `persistence.ts` menyimpan full `content`) → kembalikan dengan `meta.source:"durable"`; gagal → pesan retensi. Batas: fallback hanya untuk `output`; `reasoning` di luar retensi = hilang dengan penanda (jujur).
- **Restart**: store kosong; `expandRef` lama → fallback durable (§23); entry `interrupted` tanpa konten = tanpa ref.
- **`expand(toolCallId)`**: resolve entry → ref(s) → `store.get` → proyeksi render sesuai stream asal (`stdout` vs `stderr` — pertahankan kontrak Unix yang sudah ada di `BufferedSection.stream`).
- Store TIDAK PERNAH dibaca reducer untuk keputusan (non-otoritatif, I-A04).

---

## 17. Streaming Implementation

```text
provider chunk ──▶ loop.emit provider:text ──▶ adapter ──┬──▶ live channel ──▶ proyeksi (TUI pending-view / linear flushBuf)
                                                      └──▶ stream buffer (cap 200K, sanitasi SEKALI di sini)
finalize (turn settle / started berikutnya) ──▶ model.completed ──▶ reducer ──▶ ConversationEntry
TurnResult.finalText ──▶ (sumber teks final bila buffer terpotong/terbuang)
```

- Buffering di **adapter** (per turn aktif; `message` + `reasoning` terpisah — ganti `textSan/reasoningSan/bashSan` tersebar di `simple.ts:134-136`). Reducer tidak melihat delta (satu `StreamState{length,truncated}` live di `LiveState` untuk viewport, bukan state).
- Sanitization di adapter-ingress (`createStreamSanitizer` + `cleanUntrusted`, pola `simple.ts:336` — pindahkan, bukan duplikat). Renderer keeps sanitize calls (defense-in-depth, §18).
- Cap 200K + marker `… (output truncated, N chars)` (ikuti marker thinking `simple.ts:154` sebagai pola bahasa). Final utuh bila < cap; bila > cap: `model.completed{truncated:true}` + prefix di store.
- Cancel: `turn.cancelled` → buffer dibuang + `ConversationEntry` TIDAK dibuat (atau dibuat dengan `truncated:partial-discarded`? — KEPUTUSAN: tidak dibuat; kekosongan adalah informasi cancel yang benar; proyeksi menampilkan status turn).
- Provider error tengah-turn + fallback sukses: prefix gagal dibuang (preseden `loop.ts:100-103` reset per attempt), `pendingError` consume-once dipertahankan di driver.
- Final persist: sqlite assistant message (existing) = durability; replay baca dari sana, bukan delta.
- `tool.progress` sukarela: default MATI (tidak ada tool meng-emit; tidak wajib). Seam: `ctx.emit({type:"tool.progress"…})` — tipe struktural, kernel teruskan via `ctx.emit` yang sudah ada (`executor.ts:79`). Kandidat pertama (opsional, pasca-stabil): `bash` long-run + `delegate_task` fase anak. BUKAN syarat Fase 1–4.

---

## 18. Sanitization Migration

| Current Site | Why It Sanitizes | Final Location | Remove/Keep |
|---|---|---|---|
| `simple.ts:336,369,386,412` (stream ingress + ~15 render sites) | teks tak terpercaya → scrollback | Ingress pindah ke adapter; render sites KEEP (idempoten) | MOVE authority, KEEP calls |
| `transcript.ts:93,112,149,156,202,248,259,264,269,276` | model/tool/prompt → viewport | Ingress di adapter; viewport KEEP | KEEP calls |
| `turn-status.ts:240-244` (toolLabel) | nama/target dari model → paintWrite | Label dari `label.ts` (sudah sanitize di adapter) + KEEP baris ini | KEEP |
| `prompt.ts:38,43,59,120,126,146` | model/MCP → approval prompt | Ingress: `argsSummary` sudah sanitize; view KEEP | KEEP |
| `footer.ts:51,93-95,103`, `app.ts:813` | model/cwd → status/history | KEEP (data non-adapter: cwd, history) | KEEP |
| `diff.ts:114-115`, `errors.ts:*`, `format.ts:*`, `spinner.ts:*`, `screens/*` | boundary modul masing-masing | KEEP — sanitasi di boundary modul adalah defense-in-depth yang benar | KEEP |
| OSC52 `simple.ts:71-76` (dikecualikan sengaja) | payload buatan sendiri + base64 | TETAP dikecualikan (terdokumentasi) | KEEP + doc |

Keputusan (koreksi V2.1 "sekali di ingestion"): **otoritas = adapter-ingress; calls renderer = dipertahankan** (idempoten, murah, menutup jalur yang melewati adapter — mis. `pushUser`, history, cwd). Yang dihapus di F7 hanyalah **duplikasi state sanitizer** (3 instance per sink → 1 per aliran di adapter), bukan calls. Tidak ada regresi keamanan; `sanitize.test.ts` + `ansi-fragmentation` tetap hijau.

---

## 19. Transcript Migration

- `Transcript` (kelas, `transcript.ts:61-96`) menjadi **view**: konstruktor menerima `getSnapshot: () => PresentationView` (disediakan `cli/tui.ts` wiring, bukan impor presentation — boundary) + tetap subscribe bus lama s/d F7 (dual-source dengan adapter sebagai otoritas; konflik dimenangkan adapter — praktisnya: F5 mengalihkan subscribe ke adapter-event, bus lama dilepas).
- Internal `lines: string[]` dipertahankan sebagai **cache render** (bukan kebenaran) s/d F7; tiap append membawa `{seq,kind,turnId,toolCallId?,approvalId?,status?,expandRef?}` di struktur paralel `meta: TranscriptMeta[]` (bukan hidden string[] kedua tanpa identitas — ini jembatan yang diizinkan karena ber-ID dan sementara).
- 6 kinds dipetakan dari entry (§H V2.1); `view()/wrapAll()` + cap 5000 + `total()` monotonik + kunci-baca App: TAK tersentuh. Evict 5000 → tambah marker satu baris (`… N baris awal di luar viewport — riwayat penuh di model`) — satu-satunya perubahan perilaku viewport (butuh update TERMINAL_CONTRACT + test).
- `takeBufferedSections` dipertahankan (kompat `/expand` tanpa arg) s/d F7; `/expand <id>` (F4) membaca store langsung.
- `ApprovalSink` + `pushBlock` + suspend/resume: TAK tersentuh (I23).

---

## 20. TUI Migration

Hanya sumber data (via snapshot struktural dari `cli/tui.ts`; `app.ts`/`transcript.ts` tidak impor presentation):

- Running tool row: `ActivityEntry{running}` → baris `› name target … running` (menutup lubang compact-tanpa-start); update in-place per repaint (model bermutasi, view me-render ulang — tidak ada protocol khusus, repaint coalesce yang ada sudah cukup).
- Elapsed: `tsStart` + jam proyeksi (bukan reducer); ambang ≥2s mengikuti `turn-status.ts:129-134`.
- Final status: glyph + kata per outcome (`✓/✗/⊘/○`, `denied/cancelled/interrupted` dibedakan — string via `t()` + entri i18n baru).
- Retry: label `↻ retry` dari `supersedes` (derived).
- Child grouping: collapse per `childSessionId` di bawah `delegate_task` (default collapse; toggle expand per grup — reuse pola collapse section yang ada).
- `/expand`: `expand(toolCallId|ref)` → store → paint region (existing `paintRegion`, tanpa clear).
- Completion summary: `TurnSummary` sebagai `SystemEntry` (`turn 7 · 5 ok · 1 denied · 2 files · ckpt t7 · 41s`).
- Larangan: tidak ada perubahan `screen.ts`, `statusline.ts`, `input.ts`, mesin `app.ts paint`, transient, resize, cursor, PTY path.

---

## 21. Linear Migration

- `simple.ts` dibungkus: `toolSummary/formatArgsPreview/ledgerTarget` → delegasi `label.ts` (paritas string dibuktikan snapshot test sebelum/sesudah per cabang: write_file receipt, edit diff-card, todo, bash compact/expanded, CONTENT_TOOLS 6, fallback).
- Konsumsi `PresentationState` untuk: status final (bukan `isError` mentah), duration, denyReason, receipt badge, retry label. Aliran tulis (`wOut/wErr`, `quiet`, `verbose`, fence state, `rememberTurn`, `pendingError`, `finalizeAnswer`) TAK tersentuh.
- Pertahankan: stdout/stderr split (I2), non-TTY determinism (strip SGR, I6), exit codes (I28), pipe safety, `MINICODE_COMPACT`/`MINICODE_MINIMIZE_*` env (getter runtime tetap).
- Snapshot test: golden output skenario A–E sebelum migrasi (jalankan sekali, simpan) → bandingkan pasca-migrasi (bedakan perubahan disengaja: baris `denied/cancelled/interrupted` baru, badge receipt — daftarkan sebagai diff yang diterima).

---

## 22. ACP Migration

- Verifikasi existing: `acp.ts` subset (`initialize/run/cancel/shutdown`), single-flight, `on("*")` `:193`, notifikasi lossy, deny-headless, scrub, budget-check, EPIPE-safe writes, smoke spawn test (`acp.test.ts`).
- Perubahan: handler membaca event V2.1 dari adapter (bukan `"*"` mentah): kirim `tool.started/completed/failed/denied/cancelled` + `approval.requested/settled` + `turn.*` sebagai notifikasi terstruktur (format JSON notifikasi baru, terdokumentasi di `acp.ts` header + test). Lossy tetap untuk `delta` (teks) — lifecycle TIDAK lossy.
- `cancel` → `turn.cancelled{user}` terlihat konsumen (hari ini: run gagal diam?). `approval.requested` di headless → langsung `settled{deny(headless)}` (konsumen IDE melihat mengapa).
- Framing/parser/params/shutdown/EOF-exit-0: TAK tersentuh. Uji hermetic spawn diperluas (lifecycle sequence assertions).

---

## 23. Persistence & Replay

Pemetaan durable (TIDAK ada sistem persistensi kedua):

| Event V2.1 | Sumber durable existing | Rekonstruksi |
|---|---|---|
| turn.started/completed | sqlite `turns` (bila changed) + `turn-marker` liveness | jangkar + status |
| model.completed | sqlite assistant message (full) | conversation |
| reasoning.completed | assistant message `reasoningNote` (full) + ringkas | reasoning entry + ref (konten via fallback §16) |
| tool started/completed/failed | sqlite tool messages (call+result full) + step-trace | activity + summary (recompute via label.ts) + expandRef→fallback |
| tool.denied | step-trace `denied+denyReason` + `step.results` (persisted? messages menyimpan tool result termasuk deny — verifikasi di F3; bila tidak, step-trace + journal) | denied entry |
| tool.cancelled | tidak durable sebagai event → disimpulkan (started tanpa completed + turn cancelled) | cancelled entry |
| approval.* | journal deny reason + (F1+) audit log baru? — KEPUTUSAN: approval durable = journal intent/terminal catatan + step-trace; tidak ada tabel baru | requested/settled |
| file.changed | journal committed (paths, seq) + checkpoint (tree) | receipt |
| test.completed | derived ulang dari sqlite tool result (recompute, deterministik) | badge |
| context.compacted | tidak durable khusus → SystemEntry dari `turn.completed` context? KEPUTUSAN: compacted tidak direkonstruksi sebagai event; rebuild menambahkan SystemEntry hanya bila jejak ada (opsional, best-effort) | best-effort |

Replay sequence: `sqlite messages/turns + journal records + checkpoint pointer + step-traces → adapter.reconstructDurable() → ordered DomainEvent[] (durable saja, eventSeq diurut ulang) → reducer → state (+ rebuild tandai interrupted)`. Crash: intent pending tanpa terminal + turn tak durable → `interrupted` (§12 V2.1). `finalizeJournal`/`persistCurrent` flow existing tak berubah.

---

## 24. Test Architecture

- **Event** (`test/presentation-events.test.ts`, baru): turn ok/failed/cancelled; tool completed/failed(4 cause)/denied(7 reason)/cancelled; unknown+validate→invalid; abort/Ctrl+C/timeout; approval 6 jalan + allowlist-tanpa-emit + headless-requested; sub-agent link; retry bukan event; MCP `ToolIdentity`; `context.compacted` terus. Syarat PLAN.md #3: tiap test GAGAL di kode lama (assert event baru yang belum ada).
- **Reducer** (`test/presentation-reducer.test.ts`, baru): determinisme (seed seq sama → deep-equal), replay==live, idempotensi duplikat terminal, late-event counter, unknown IDs (3), force-close approval, `deriveSupersedes` (5 aturan + 4 edge), interrupted-rebuild.
- **Content** (`test/presentation-store.test.ts`, baru): cap 200K/500K, FIFO+marker, surrogate/escape-safe cut, `expand()` resolve, miss→durable-fallback→retensi-message, restart store-kosong.
- **Streaming** (`test/presentation-stream.test.ts`, baru): stream 1MB → cap+marker; cancel buang buffer; provider-error-prefix dibuang; flush parsial; final==buffer-joined (di bawah cap).
- **Projection** (`test/presentation-projections.test.ts`, baru): satu state → snapshot TUI-linear-ACP; kesetaraan 7 field (§22 V2.1); beda hanya baris/warna.
- **Integration** (`test/presentation-integration.test.ts`, baru): tool nyata (read/write/edit/bash) → receipt paths+checkpoint; approval allow/deny e2e (fake TTY harness pola `tui-harness`); sub-agent e2e (factory fake) coroutine link; undo dari receipt.
- **Terminal regression**: SELURUH peta I1–I31 + `pty.test.ts` + resize + transient + non-TTY + approval-tui + acp + ui-boundary + architecture-map + i18n — tetap hijau tiap fase ( Medieval: `bun test` penuh di akhir tiap fase; fokus per fase saat iterasi).

---

## 25. Test Matrix

Konvensi repo: `test/<area>.test.ts`, `bun:test`, tanpa config khusus. File baru beralasan: tiap area V2.1 belum punya rumah (event/reducer/store/stream/projection/integration presentation).

| Test | Existing? | New? | File | Phase | Acceptance |
|---|---|---|---|---|---|
| deny → `tool.denied{reason}` 7 alasan | — (deny-reason.test.ts uji observasi model, bukan event) | baru | `test/presentation-events.test.ts` | 1 | gagal di lama; hijau pasca-adapter |
| abort/timeout → cancelled cascade | executor-abort.test.ts (level executor) | baru (level event) | sama | 1 | `turn.cancelled` + tool cascade |
| headless approval audit | doctor/approval-tui (perilaku) | baru (event) | sama | 1 | requested+settled by system |
| `toolCallId` terus di kontrak | — | baru | `test/presentation-events.test.ts` | 2 | id sama provider→event |
| parent-link forward anak | journal-child.test.ts (jurnal) | baru (event link) | `test/presentation-subagent.test.ts` (baru; alasannya: korelasi ≠ jurnal) | 2 | link lengkap + tanpa lifecycle ganda |
| `deriveSupersedes` 5+4 | — | baru | `test/presentation-reducer.test.ts` | 3 | deterministik + edge paralel |
| first-terminal-wins + counter | — | baru | sama | 3 | duplikat diabaikan, counter tepat |
| force-close + interrupted rebuild | redo-recovery/turn-marker (mekanisme lama) | baru (semantik) | sama | 3 | tak ada pending yatim |
| store cap/marker/fallback | collapse.test.ts + output-caps.test.ts (perilaku lama) | baru | `test/presentation-store.test.ts` | 4 | paritas batas + marker + fallback |
| `/expand <id>` reopenable | tui-transcript (sekali-habis) | baru | `test/presentation-expand.test.ts` (baru; alasannya: query API ≠ transcript view) | 4 | buka-ulang identik |
| TUI paritas string | tui-*.test.ts, terminal-contract | snapshot baru | `test/presentation-projections.test.ts` | 5 | diff hanya yang didaftarkan |
| PTY byte-nyata | pty.test.ts | perluas (lifecycle) | `test/pty.test.ts` (tambah, bukan file baru) | 5 | boot→turn→abort→restore |
| linear golden A–E | non-tty-output, exec-json-envelope | golden baru | `test/presentation-linear.test.ts` (baru; alasannya: golden skenario ≠ unit non-tty) | 6 | diff terdaftar saja |
| ACP lifecycle | acp.test.ts | perluas | `test/acp.test.ts` (tambah) | 6 | deny/cancel/approval terlihat |
| full gate | gate:fast | — | — | tiap fase akhir | tsc+lint+test+coverage+pack hijau |

---

## 26. Migration Phases

### PHASE 0 — Baseline
- **Objective**: kunci perilaku + metrik sebelum sentuh apa pun.
- **Files**: — (hanya baca). **Symbols**: catat `UiEvent` 9 varian, cap 200K/500K/10×2000/200K-copy, 5 `includes(".")` sites, `/expand` sekali-habis.
- **Changes**: none. Ambil golden: output linear skenario A–E (5 skrip), `bun test` count, coverage numbers, `gate:pack` 23 pass.
- **Dependencies**: none. **Tests**: existing penuh hijau (bukti baseline). **Acceptance**: baseline doc (1 halaman) + golden tersimpan `test/vcr/`-adjacent (pola `vcr/` existing untuk fixture) — putuskan lokasi di eksekusi (rekomendasi: `test/fixtures/presentation-baseline/`).
- **Risk**: LOW. **Rollback**: n/a.

### PHASE 1 — Semantic Event Adapter
- **Objective**: bus V2.1 hidup berdampingan; observability baru tanpa ubah perilaku.
- **Files**: baru `events.ts`, `adapter.ts`; sentuh `cli/setup.ts` (wire+dual-subscribe), `permission.ts` (emit hook + approvalId), `prompt.ts` (via hook — sebenarnya emit di ask_user/permission, prompt tak berubah selain menerima opts? KEPUTUSAN: prompt.ts TAK berubah F1; emit di `promptAskOr` + `ask_user.ts`), `trace.ts` (tambah category helper, lama dipertahankan).
- **Symbols**: `createPresentationAdapter`, `parseQualifiedName`, `DURABILITY`, hook `emitApproval`.
- **Changes**: deny-recon, turn-settle-recon, finalText→model.completed, approval requested/settled emit, eventSeq/ts, toolStarts pindah (baca; tulis tetap ke step-trace lama).
- **Dependencies**: P0. **Tests**: `presentation-events.test.ts` (gagal-di-lama per kasus). **Acceptance**: semua event §8 terobservasi di harness fake; perilaku user NOL berubah (golden identik); `ui-boundary` hijau.
- **Risk**: LOW (aditif; bus lama utuh). **Rollback**: hapus 3 baris wiring setup.ts.

### PHASE 2 — Identity & Correlation
- **Objective**: ID utuh end-to-end + parent-link anak.
- **Files**: `contract.ts` (+`id`, +`results` ringkas — aditif), `task.ts` (registry pasangan via adapter — tak ubah execute selain 2 baris pass-through bila Opsi A; lihat §12: TANPA ubah journal/ctx), `tools/index.ts` (namespace best-effort), `ARCHITECTURE.html` (daftar 2 file bila berubah).
- **Symbols**: `UiExecution.id`, `ChildSessionLink`, adapter registry `child→parentCall`.
- **Changes**: kontrak tambah; forward bungkus dengan parentLink; `ToolIdentity` mengalir di event (policy belum ganti predicate).
- **Dependencies**: P1. **Tests**: korelasi anak→parent, id sama provider→event, paralel-tanpa-taut. **Acceptance**: setiap forward membawa link lengkap; ledger parent tetap 1 baris.
- **Risk**: MEDIUM-LOW (kontrak disentuh; cast `as unknown` menutupi — tambah runtime assert bentuk di adapter: `assertExecutionShape`). **Rollback**: revert kontrak + wiring link.

### PHASE 3 — Presentation State + Reducer (+ label)
- **Objective**: kebenaran kedua (in-memory) yang deterministik; belum dipakai renderer.
- **Files**: baru `model.ts`, `reducer.ts`, `label.ts`; `ARCHITECTURE.html` daftarkan 3 file.
- **Symbols**: `reduce`, `rebuildFromDurable`, `deriveSupersedes`, `createInitialState`, `labelTool/summarizeResult/targetOf`.
- **Changes**: murni baru + shadow-run di setup (reducer berjalan paralel, hasilnya DIBUANG + dibandingkan sampling dengan counter divergensi §30 — dark-launch).
- **Dependencies**: P1–2. **Tests**: reducer + replay + idempotensi + force-close + supersedes. **Acceptance**: shadow divergence = 0 pada suite + skenario A–E; coverage file baru ≥90% (ikuti preseden lantai 90 untuk modul kritis).
- **Risk**: LOW (belum dipakai). **Rollback**: matikan shadow-run.

### PHASE 4 — Content Store + Expand (+ receipt)
- **Objective**: `/expand` queryable; receipt terlihat;第一个 perilaku berubah (di belakang flag).
- **Files**: baru `store.ts`; sentuh `commands.ts` (`/expand [id]`), `tui.ts` (query), `setup.ts` (`file.changed` emit + store wiring), `TERMINAL_CONTRACT.md` (perilaku baru) + test peta.
- **Symbols**: `createContentStore`, `expand()`, receipt badge.
- **Changes**: konten completed→store; expand lama dipertahankan (tanpa arg); evict FIFO+marker; receipt dari journal/checkpoint.
- **Dependencies**: P3. **Tests**: store + expand + receipt-join + restart-fallback. **Acceptance**: expand buka-ulang identik; badge receipt benar (paths+ckpt); flag OFF = perilaku lama bit-identik.
- **Risk**: MEDIUM (perilaku berubah; flag menutup). **Rollback**: flag OFF (default).

### PHASE 5 — TUI Projection
- **Objective**: TUI membaca model; paritas visual kecuali diff terdaftar.
- **Files**: `transcript.ts` (bungkus), `app.ts` (sumber status — tipe struktural), `tui.ts` (snapshot wiring); `TERMINAL_CONTRACT.md` (evict-marker, ledger denied/cancelled/interrupted, running-row) + test.
- **Symbols**: `getSnapshot`, `TranscriptMeta`, pinned activity.
- **Changes**: subscribe beralih ke adapter-event; running-row; elapsed dari model; grup anak collapse; completion summary.
- **Dependencies**: P3–4. **Tests**: proyeksi-paritas + PTY perluasan + viewport lama + i18n (string baru via `t()`). **Acceptance**: golden TUI diff = daftar terdaftar saja; PTY hijau; I1–I31 hijau.
- **Risk**: MEDIUM (mitigasi: paritas + flag). **Rollback**: flag OFF.

### PHASE 6 — Linear + ACP Projection
- **Objective**: linear & ACP dari model; golden linear + lifecycle ACP.
- **Files**: `simple.ts` (bungkus labeler), `exec.ts` (konsumsi V2.1), `acp.ts` (notifikasi lifecycle + deny-headless eksplisit + doc format).
- **Changes**: label via `label.ts`; status/duration/receipt dari state; ACP format baru (versioned? KEPUTUSAN: tambah field, jangan version endpoint — subset klaim "BUKAN ACP penuh" dipertahankan).
- **Dependencies**: P3–5. **Tests**: linear golden + non-TTY + exit codes + ACP hermetic. **Acceptance**: golden diff terdaftar; `minicode|tee`, redirect, CI deterministik; ACP lama-kompatibel (field tambahan diabaikan konsumen lama).
- **Risk**: MEDIUM-LOW. **Rollback**: flag OFF.

### PHASE 7 — Cleanup / Remove Obsolete Paths
- **Objective**: satu sumber semantik; hapus ganda. SYARAT MASUK: P0–6 hijau + 1 rilis flag-ON tanpa laporan regresi.
- **Files**: hapus `takeBufferedSections` path (ganti store query), `bufferSection/getBufferedSections/resetBufferedSections` (collapse.ts → view atau hapus — bila test `collapse.test.ts` masih relevan, migrasikan dulu), labeler lama (`toolSummary`, `toolLabel` turn-status, `ledgerTarget`, `formatArgsPreview` → delegasi `label.ts`), `includes(".")` sites → predicate, klasifikasi-string sebagai kebenaran (fallback dipertahankan di adapter), sanitizer-state ganda (calls dipertahankan, §18).
- **Symbols**: — (penghapusan). **Changes**: hapus + delegasi; `contract.ts` buang field lama yang tak dipakai (cek semua subscriber dulu).
- **Dependencies**: P4–6. **Tests**: suite penuh + `import-convention` (pastikan tak ada sisa impor ke simbol hapus) + coverage naik → naikkan gate. **Acceptance**: grep 0 sisa (`takeBufferedSections|bufferSection|ledgerTarget|toolSummary|includes(".")` di src/) kecuali yang diizinkan; gate hijau.
- **Risk**: LOW (pasca-paritas). **Rollback**: revert commit terisolasi per hapusan.

---

## 27. Phase Dependency Graph

```text
Phase 0 (baseline, golden)
   ↓
Phase 1 (adapter; bus V2.1 hidup, perilaku nol-berubah)
   ↓
Phase 2 (identity; kontrak+link) ──(independen parsial: ToolIdentity parse sudah F1)
   ↓
Phase 3 (state+reducer+label; dark-launch shadow)
   ↓
Phase 4 (store+expand+receipt; FLAG ON pertama untuk perilaku baru)
   ↓
Phase 5 (TUI projection) ──╲
   ↓                         ╲──→ Phase 6 (linear+ACP) boleh paralel setelah P4,
Phase 7 (cleanup) ◀──────────╱    tetapi SEKUENSIAL direkomendasikan (satu diff perilaku
                                   per waktu agar regresi terlokalisasi)
```

Urutan V2.1 dipertahankan (bukti repo: tiap fase hanya butuh output fase sebelumnya; P5/P6 paralel dimungkinkan tetapi tidak disarankan).

---

## 28. Feature Flag / Rollout

- **Nama**: `MINICODE_PRESENTATION_V2` (`"1"` = jalur baru untuk perilaku yang berubah; `"0"`/unset = lama). Pola env existing (`MINICODE_COMPACT`, `MINICODE_MINIMIZE_*`, `MINICODE_STATUSLINE`, `MINICODE_MOTION`) — konsisten repo.
- **Default**: `0` selama Fase 1–3 (adapter+reducer berjalan tetapi tidak mengendalikan output — shadow/observability saja); `0` dengan opt-in di Fase 4–6 (perilaku baru hanya bila flag 1); default → `1` HANYA di Fase 7 setelah syarat masuk terpenuhi; flag DIHAPUS di akhir Fase 7 (bukan dipertahankan — menghindari matriks perilaku ganda permanen).
- **Scope**: proyeksi + expand + ledger-status-baru saja. Event adapter + reducer + store tulis BERJALAN tanpa flag (zero user-visible change) agar data terkumpul untuk perbandingan.
- **Aktivasi**: baca lazy per render dari env (pola getter runtime repo — jangan `const` beku). **Rollback**: unset flag = bit-identik lama (dibuktikan golden). **Removal criteria**: P7 acceptance + 1 rilis.

Flag diperlukan (bukan "safe-sounding"): Fase 4–6 mengubah perilaku user-visible; tanpa flag, tiap regresi memblokir seluruh migrasi.

---

## 29. Compatibility Strategy

```text
bus lama (AgentEvent ×9)
   ↓ dual-subscribe (F1–F6)
   ├──▶ sink lama (simple/transcript/turn-status/exec/acp-"*") — otoritas perilaku s/d flag
   └──▶ adapter ──▶ DomainEvent V2.1 ──▶ reducer/state (shadow F3; otoritas bertahap F4–6)
```

Satu sumber semantik setiap saat: **selama dual-run, adapter adalah cermin (read-only)**, bukan pesaing — tidak ada state yang ditulis dua tempat; keputusan tampil tetap di sink lama hingga flag memindahkan otoritas per proyeksi. `UiBus` cast dipertahankan s/d F7 (kontrak diperpanjang aditif, bukan diganti). Klasifikasi string lama = fallback adapter (bukan kebenaran paralel). Tidak ada "UI lama vs UI baru" yang berbeda makna: beda hanya sumber baris, diverifikasi paritas test.

---

## 30. Migration Observability (sementara, env-gated, dihapus F7)

`MINICODE_PRESENTATION_DEBUG=1` → adapter+reducer menulis counters ke stderr (throttled, non-TTY-safe, tanpa ANSI): `events_in`, `v2_out`, `dropped_unknown`, `duplicate_terminal`, `late_event`, `orphan_tool`, `orphan_approval`, `orphan_child` (forward tanpa pasangan started), `contentref_miss`, `replay_divergence` (shadow F3: state-shadow vs sink-lama checksum per turn — mismatch → dump sekali). Implementasi: objek diagnostik di adapter/reducer (bukan state), diekspos `getDiagnostics()` untuk test. Kriteria penghapusan: 0 anomali selama 1 rilis + F7.

---

## 31. Performance Considerations

Hotspot aktual repo (bukan asumsi): `wrapAll` O(n) per paint + coalesce 30ms (dominan; tak tersentuh); `sanitize` per chunk (tetap 1× di adapter + keeps idempoten — netral); sqlite writes per turn (existing). Tambahan V2.1: adapter O(1)/event (Map ops); reducer O(1)/event + agregat turn O(tools-in-turn) hanya saat turn-settle; store put O(1) amortized + evict scan dari ekor (bounded 500K — scan ≤ detik kecil per put besar; batasi dengan running-total counter, bukan re-scan). Skenario uji: 500 tool calls berurutan (state <1MB; waktu reduce total <100ms — assert di test), 10 tool paralel × 50 step, stream model 1MB (cap+marker, memori datar), sesi 15 mnt (evict marker, tanpa tumbuh). Jangan optimasi prematur: ukur dulu via test ini; optimasi hanya bila gagal.

---

## 32. Failure & Rollback Strategy

Per fase (prinsip: kecil-reversibel, tanpa flag-day):

- P0: tak ada perubahan → n/a.
- P1: lepas wiring (3 baris `setup.ts`) → bus lama utuh; file baru yatim (tak diimpor) → aman.
- P2: revert kontrak-tambahan + link-registry (adapter); `assertExecutionShape` memastikan tak ada crash bentuk di antaranya (fallback: lewati event malformed + counter).
- P3: matikan shadow-run; file baru tak dipakai renderer.
- P4–6: `MINICODE_PRESENTATION_V2=0` (default) → bit-identik lama (golden sebagai bukti).
- P7: revert per-commit hapusan (atomik per simbol); syarat-masuk mencegah rollback besar.
- Global: tiap fase diakhiri gate penuh hijau; bila merah >1 hari kerja, revert fase berjalan (bukan "fix forward" melewati fase berikutnya).

---

## 33. Protected Files

Daftar lindung (aturan V2.1 dipertahankan; diverifikasi tak ada bukti yang menuntut rewrite):

`sanitize.ts width.ts wrap.ts markdown.ts highlight.ts theme.ts format.ts errors.ts diff.ts table.ts money.ts` (render), `runtime/screen.ts runtime/statusline.ts runtime/spinner.ts runtime/motion.ts`, `input/input.ts input/prompt-engine.ts`, `assistant/turn-status.ts`, `approval/prompt.ts` (lifecycle), `vendor/minicore/**` (seluruhnya), `footer.ts`, `screens/*`, `i18n/*`.

Pengecualian MINIMAL yang benar-benar dibutuhkan (aditif, bukan rewrite):

| File | Why | Exact symbol | Minimal change | Risk | Test |
|---|---|---|---|---|---|
| `src/ui/contract.ts` | ID harus lewat batas (I-A02) | `UiExecution` +`id:string`; `UiStep` +`results?:…` ringkas | tambah field opsional/required-tolerant (subscriber lama tak rusak karena cast `any`) | LOW-MED | events F2 + boundary hijau |
| `src/ui/tui/transcript.ts` | proyeksi harus baca model | konstruktor +`getSnapshot?` opsional; internal `meta[]` | bungkus; `view/wrapAll` utuh | MED | paritas + PTY |
| `src/ui/assistant/simple.ts` | label tunggal | `toolSummary` body → delegasi `label.ts` | delegasi; cabang utuh | MED | golden linear |
| `src/policy/permission.ts` | approvalId + emit | `promptAskOr` + hook param | tambah, gate utuh | MED | permission-matrix + events |
| `src/ui/approval/prompt.ts` | `via` audit | TANPA perubahan F1 (emit di permission/ask_user) — hanya F6 bila format blok berubah | — | LOW | approval-tui |
| `src/ui/tui/app.ts` | status dari model | baca snapshot struktural via param | tambah param opsional | LOW | tui-app |

Terlarang: mengubah mesin paint/repaint/transient/resize/cursor, logika sanitize/width/wrap, kernel, gate izin, framing ACP.

---

## 34. Deprecated Paths

| Current location | Replacement | Removal phase | Proof of coverage |
|---|---|---|---|
| `transcript.ts:sections` + `takeBufferedSections` (sekali-habis) | store query `expand(ref)` | 7 (kompat F4–6) | expand test buka-ulang |
| `collapse.ts:bufferSection/getBufferedSections/resetBufferedSections` | store view | 7 | collapse.test dimigrasikan dulu |
| `simple.ts:toolSummary` + `turn-status.ts:toolLabel` + `transcript.ts:ledgerTarget` + `format.ts:formatArgsPreview` | `label.ts` | 7 (delegasi F3–6) | golden + paritas |
| `includes(".")` 5 sites (§13) | predicate `ToolIdentity` | 7 | grep 0 + matrix test |
| `classifyToolResult/denyReasonOf` sebagai kebenaran | `cause/reason` event terstruktur | 7 (fallback di adapter dipertahankan) | events test |
| State sanitizer ganda (3 instance/sink) | 1 per aliran di adapter | 7 (calls dipertahankan) | sanitize + fragmentation hijau |
| Kompensasi driver manual (`endTurn` di tiap driver) | turn-settle event menggerakkan transient via proyeksi | TETAP (safety net; bukan semantik) — TIDAK dihapus, didokumentasikan sebagai net | turn-status hijau |
| `pendingError` consume-once | dipertahankan (keputusan V2.1: benar) | TIDAK deprecated | — |

---

## 35. Acceptance Criteria

Migrasi selesai hanya bila (开 checklist objektif, terverifikasi test):

```text
[ ] satu model event V2.1 (§8) diemisi adapter; bus lama dilepas di F7 (grep on("*") sisa hanya bus-debug)
[ ] satu PresentationState + reducer murni (tanpa IO/clock — grep Date.now/random/fs/net di reducer = 0)
[ ] replay(durable) == live (test, bukan klaim)
[ ] tiap tool visible punya toolCallId stabil (kontrak + event + ledger membawa id)
[ ] tiap tool terminal tepat satu status final (first-terminal-wins test)
[ ] deny terlihat (⊘ + reason) di TUI+linear+ACP
[ ] cancel terlihat (○ + reason); interrupted dibedakan (○ verify, bukan merah)
[ ] approval tak pending pasca-parent (force-close test + rebuild test)
[ ] retry deterministik (supersedes test 5+4)
[ ] korelasi anak (link lengkap; tanpa lifecycle ganda di parent)
[ ] MCP identity terstruktur (grep includes(".") semantik = 0)
[ ] store bounded (cap test) + expand reopenable + evict marker
[ ] streaming bounded (1MB test datar)
[ ] TUI/linear/ACP paritas 7 field (projection test)
[ ] I1–I31 + PTY + resize + transient + non-TTY + approval-tui + acp + boundary + arch-map + i18n hijau
[ ] tanpa logika semantik ganda (grep §34 = 0 kecuali yang diizinkan)
[ ] docs: ARCHITECTURE.html (6 file) + TERMINAL_CONTRACT (perilaku) + CHANGELOG diperbarui
[ ] gate penuh hijau + coverage minimum tidak turun (naikkan bila naik)
```

---

## 36. Definition of Done

- **P0 DONE**: baseline doc + golden tersimpan + suite hijau tercatat (angka).
- **P1 DONE**: semua event §8 terobservasi di harness; golden A–E bit-identik; event test gagal-di-lama terbukti (catat commit-lama check); boundary hijau.
- **P2 DONE**: id provider→event sama (assert test); forward anak ber-link; ledger parent tetap 1 baris/delegasi; kontrak-tambahan + boundary hijau.
- **P3 DONE**: reducer test (determinisme/replay/idempotensi/force-close/supersedes/interrupted) hijau; shadow divergence 0 pada A–E + suite; coverage file baru ≥90%.
- **P4 DONE**: expand buka-ulang identik; evict marker terlihat; receipt benar (paths+ckpt); flag OFF bit-identik; TERMINAL_CONTRACT + test diperbarui.
- **P5 DONE**: golden TUI diff = terdaftar; PTY perluasan hijau; I1–I31 hijau; string i18n baru lengkap en+id.
- **P6 DONE**: golden linear diff = terdaftar; pipe/redirect/CI deterministik; ACP lifecycle terlihat + kompatibel; exit codes hijau.
- **P7 DONE**: grep §34 bersih (kecuali izin); gate penuh hijau; coverage minimum dinaikkan bila naik; flag dihapus; docs final.

Fase tidak selesai hanya karena compile — harus memenuhi behavioral tests-nya.

---

## 37. Execution Rules for Coding Agent

# EXECUTION RULES FOR THE CODING AGENT

1. Read the relevant files before editing (wajib `read` dulu; verifikasi simbol + line masih seperti §4).
2. Never rewrite the renderer to solve semantic problems (mesin paint/repaint/transient/resize/cursor terlarang; ubah sumber data saja).
3. Never introduce a new semantic abstraction without checking V2.1 (§18–§20 adalah kosakata tertutup; butuh baru = STOP + eskalasi, §37.14).
4. Never create an ID unless it answers a real correlation question (`runId/agentId/attemptId/executionId` DITOLAK di §19 V2.1).
5. Never make the reducer depend on IO or clock (grep `Date.now|random|fs|net|process.env` di `reducer.ts`/`model.ts` harus 0; jam hanya di adapter).
6. Never store large payloads directly in Presentation State (hanya `ContentRef`; payload di store).
7. Never silently discard lifecycle events (deny/abort/unknown/validate/cancel WAJIB jadi event; terapkan first-terminal-wins untuk duplikat, bukan discard).
8. Never infer semantics from terminal strings (`includes(".")`, regex ledger, parse warna/glyph — gunakan ID/identity).
9. Preserve existing terminal invariants (I1–I31; ubah perilaku → update TERMINAL_CONTRACT + test peta; ubah struktur → update ARCHITECTURE.html).
10. Run focused tests after each phase (`bun test test/presentation-*.test.ts` + area tersentuh).
11. Run the full regression suite before declaring migration complete (`gate:fast` minimal; `bun test` penuh di akhir tiap fase).
12. Update architecture documentation whenever behavior changes (ARCHITECTURE.html wajib per file baru — `architecture-map.test.ts` akan merah bila lupa; CHANGELOG untuk perilaku user-visible).
13. Stop and report if repository reality contradicts an architectural invariant (§4 adalah verifikasi terakhir yang diketahui; kode menang atas dokumen).
14. Do not "fix" architectural contradictions by inventing a new design (eskalasi; jangan tambah event/ID/flag sendiri).
15. Escalate architectural blockers instead of improvising (format: OBSERVASI / KONTRADIKSI / DAMPAK / OPSI).
16. TypeScript strict: `noUncheckedIndexedAccess` (guard tiap akses indeks/Map), `noUnusedLocals/Parameters`, `verbatimModuleSyntax` (`import type` terpisah) — `tsc` harus 0 error.
17. Komentar Indonesia (menjelaskan mengapa), UTF-8 tanpa BOM; string user-visible baru via `t()` + entri `en.ts`+`id.ts` (`i18n-hardcode` akan merah bila literal).
18. Wiring lintas-lapisan hanya dari `cli/` (composition root); `src/ui` dilarang impor `src/presentation`; `src/presentation` dilarang impor `src/ui` (boundary test akan merah).
19. Coverage: file baru wajib ber-test tebal (target ≥90% per file presentation); bila coverage agregat naik, naikkan minimum di `scripts/coverage-gate.ts` (aturan AGENTS.md).
20. Jangan edit `vendor/minicore/**` (kecuali seam aditif eksplisit yang disetujui — default: TIDAK; `tool.progress` sukarela ditunda pasca-stabil).
21. Jangan commit kecuali diminta; jangan pernah commit rahasia; `git status/diff` dulu bila diminta commit.

---

## 38. Final Implementation Checklist

```text
Architecture:  [ ] §6 ownership dipenuhi  [ ] §7 struktur final  [ ] tanpa utils/helpers
Events:        [ ] 19 event §8 teremit  [ ] durability sesuai  [ ] tanpa finish/heartbeat/run.*
Identity:      [ ] toolCallId utuh  [ ] approvalId dibuat  [ ] parent-link  [ ] tanpa ID baru
Reducer:       [ ] murni  [ ] first-terminal-wins  [ ] force-close  [ ] supersedes  [ ] rebuild-interrupted
Presentation State: [ ] 6 entry kinds  [ ] kecil  [ ] tanpa ANSI/payload/timer
Content Store: [ ] 200K/500K  [ ] FIFO+marker  [ ] fallback durable  [ ] expand reopenable
Streaming:     [ ] cap+marker  [ ] cancel-buang  [ ] final==join  [ ] replay-tanpa-delta
Approval:      [ ] 6 jalan → outcome  [ ] headless-audit  [ ] allowlist-bukan-approval  [ ] force-close
Sub-agent:     [ ] link lengkap  [ ] collapse grup  [ ] tanpa lifecycle ganda  [ ] isolasi utuh
MCP:           [ ] ToolIdentity  [ ] parse-sekali  [ ] predicate ganti 5 sites
TUI:           [ ] running-row  [ ] elapsed  [ ] 5 status  [ ] grup anak  [ ] expand(id)  [ ] summary
Linear:        [ ] golden A–E  [ ] stdout/stderr  [ ] deterministik  [ ] exit codes
ACP:           [ ] lifecycle penuh  [ ] deny-headless eksplisit  [ ] framing utuh
Persistence:   [ ] tanpa sistem kedua  [ ] replay==live  [ ] crash→interrupted
Replay:        [ ] durable-cukup  [ ] idempoten  [ ] tanpa payload
Testing:       [ ] 6 file test baru  [ ] perluasan pty/acp/collapse  [ ] regresi I1–I31 hijau
Cleanup:       [ ] grep §34 bersih  [ ] flag dihapus  [ ] kontrak lama dilepas
Documentation: [ ] ARCHITECTURE.html  [ ] TERMINAL_CONTRACT  [ ] CHANGELOG  [ ] header acp format
```

---

## 39. Final Risk Register

| Risk | Cause | Probability | Impact | Mitigation | Detection | Rollback |
|---|---|---|---|---|---|---|
| Paritas string TUI/linear pecah | bungkus mengubah whitespace/newline/cap | MEDIUM | HIGH (golden merah, user-visible) | snapshot per cabang sebelum ubah; delegasi murni | projection/golden test | flag OFF / revert bungkus |
| Cast `as unknown` menyembunyikan bentuk | kontrak tambah tanpa runtime check | MEDIUM | MEDIUM (event malformed) | `assertExecutionShape` di adapter + counter | diagnostics §30 | revert kontrak |
| `parentToolCallId` salah pasang | korelasi started↔intent balapan | LOW | MEDIUM (atribusi anak salah) | registry pasangan + fallback tanpa-link (jangan tebak) | orphan_child counter | lepas link (degrade ke status quo) |
| `test.completed` parse salah angka | pola output test beragam | MEDIUM | LOW (badge salah, bukan state) | best-effort + tidak-emit-bila-ragu; badge jelas "detected" | review golden | matikan parser (flag parsial env) |
| Store fallback sqlite lambat | expand miss membaca history besar | LOW | LOW (expand sesekali) | fallback hanya output; cap baca (mis. 200K) | timing assert longgar | nonaktifkan fallback → pesan retensi |
| Flag ganda permanen | F7 tertunda | LOW | MEDIUM (matriks perilaku) | removal criteria + syarat-masuk F7 tegas | grep flag di F7 | — (jadwalkan F7) |
| Coverage gate merah | file baru kurang test | MEDIUM | MEDIUM (blokir gate) | ≥90% per file baru sejak F3; lantai presentation | gate:coverage | tambah test (bukan turunkan gate) |
| i18n-hardcode merah | string status baru literal | LOW | LOW | selalu via `t()` + en/id sejak awal | i18n tests | — (fix langsung) |
| ui-boundary merah | impor presentation dari ui | LOW | MEDIUM (blokir) | wiring hanya via cli (aturan §37.18) | boundary test | pindahkan impor |
| Kernel ternyata perlu diubah | `tool.progress`/konteks tak cukup | LOW | MEDIUM | tunda progress pasca-stabil; seam aditif prosedural | vendor:check | — (keputusan eksplisit) |

---

## 40. Final Canonical Implementation Sequence

```text
VERIFY (§4: klaim V2.1 vs repo — SELESAI di dokumen ini)
  ↓
BASELINE (P0: golden + metrik, tanpa ubah kode)
  ↓
ADAPTER (P1: events.ts + adapter.ts + emit approval; dual-subscribe; perilaku nol-berubah)
  ↓
IDENTITY (P2: kontrak +id; parent-link anak; ToolIdentity mengalir)
  ↓
PRESENTATION STATE (P3a: model.ts + label.ts)
  ↓
REDUCER (P3b: reducer.ts; dark-launch shadow; determinisme terbukti)
  ↓
CONTENT STORE (P4: store.ts + /expand(id) + receipt; FLAG ON pertama)
  ↓
TUI PROJECTION (P5: bungkus transcript/app; paritas + PTY)
  ↓
LINEAR PROJECTION (P6a: bungkus simple; golden A–E)
  ↓
ACP PROJECTION (P6b: lifecycle terstruktur; kompatibel)
  ↓
REPLAY / RECOVERY (tertenun P3–P4: rebuild + interrupted + fallback; dibuktikan test)
  ↓
CLEANUP (P7: hapus ganda; flag dihapus; syarat-masuk ketat)
  ↓
REGRESSION (gate penuh + gate:fast + PTY + I1–I31)
  ↓
DOCUMENTATION (ARCHITECTURE.html + TERMINAL_CONTRACT + CHANGELOG + header acp)
```

Urutan V2.1 dipertahankan; satu-satunya penyesuaian repo-grounded: P3 dipecah eksplisit (state+label sebelum reducer) dan replay/recovery dinyatakan sebagai acceptance yang terbukti di P3–P4, bukan fase tersendiri (karena mekanismenya tersebar di reducer+store+adapter, bukan satu modul).

---

## IMPLEMENTATION PLAN STATUS:
READY FOR CODING
```

Catatan kejujuran terakhir: satu-satunya ketidakpastian yang belum bisa ditutup tanpa menyentuh kode adalah isi persis `ToolContext` vendor (apakah membawa call id — menentukan apakah Opsi A §12 semulus yang dirancang). Rencana sudah memuat jalur yang tidak membutuhkannya (korelasi adapter-side via pasangan started↔intent), sehingga ketidakpastian ini adalah risiko implementasi LOW, bukan blocker arsitektur. Semua keputusan arsitektural lain tertutup oleh bukti file:line di §4.
