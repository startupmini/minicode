# Arsitektur

Peta struktur hidup yang interaktif ada di `ARCHITECTURE.html` (file pendamping di folder ini — search/filter, 9 section `00 Sekilas` → `09 UI/UX rendering terminal`). Halaman ini ringkasannya agar bisa dibaca GitBook + AI Ask.

Rencana aktif: `PLAN.md` (root). Kontrak terminal FROZEN: `TERMINAL_CONTRACT.md` (folder ini) — baca sebelum menyentuh output/rendering; perubahan perilaku wajib update dokumen + test peta proteksinya. Audit dan target output architecture: [OUTPUT_ARCHITECTURE_AUDIT.md](OUTPUT_ARCHITECTURE_AUDIT.md) beserta [event model](OUTPUT_EVENT_MODEL.md), [protocol](OUTPUT_PROTOCOL_SPEC.md), [rendering](OUTPUT_RENDERING_SPEC.md), [UX](OUTPUT_UX_RULES.md), dan [implementation plan](OUTPUT_IMPLEMENTATION_PLAN.md). Riset harness: `HARNESS.md` (folder ini). Arsip: `PLAN_UIUX_V6.md` (selesai, jangan dikerjakan ulang).

## Tiga lapisan

```
L1 cli/ + src/ui/   → controller tipis + presentation mandiri
L2 src/ non-ui      → agen: tools, agents, hooks, policy, providers, mcp, lsp, session, skills
L3 vendor/minicore  → kernel STATE/MODEL/ACTION/LOOP (freeze, zero-dep, via #minicore)
```

- `cli/` boleh impor `src/ui/` + `src/`; `src/` non-ui dilarang impor `src/ui/`; `src/ui/` dilarang impor `cli/`, `src/` non-ui, `#minicore`. Dijaga `test/ui-boundary.test.ts`.
- Satu-satunya jendela UI↔luar: `src/ui/contract.ts` (`UiEvent/UiBus/UiStep/UiExecution`).
- DI dari composition root (`cli/index.ts`, `cli/setup.ts`): `createProviderLayer → loadLastModel → createRagLayer → resume presentation-events + planRecovery + reconcileUndoRedo → setupToolLayer + setAskTextFn → createMinicodeSession → journal + checkpoint + semantic event sink + step-trace + runPromptWithVerify (baseline-first + self-heal 3 siklus + hooks) → logger + turn-status + usage/pricing → persist/finalize → close (kill jobs, mcp/lsp close)`. `setSubAgentSessionFactory` sebelum dispatch agar REPL/one-shot/`mcp serve` tercakup.
- `providers → config` satu arah (`src/providers/provision.ts` provisioning, `src/config.ts` murni IO).

## Alur satu prompt

`prompt → permission check → validateArgs (kernel) → executor (order/cap/abort-aware) → tool realpath+atomic → execute → checkpoint shadow-git + journal + step-trace → compaction (mekanikal sinkron; LLM async via seam `compactAsync`) → usage/pricing per-segmen longest-key → trace`.

## UI/UX terminal (kontrak FROZEN)

Sesi interaktif (`minicode` di TTY mampu) SELALU membuka TUI **fullscreen alternate screen**: transkrip ala shell + status bar satu baris + popup komposit di atas transkrip yang tetap terlihat (redup). Jalur non-interaktif (one-shot prompt, `exec`, pipe/redirect/CI, `TERM=dumb`, layar < 10 baris) tetap shell-first: cetak polos append-only ke scrollback tanpa cursor control.

| Stream | Isi |
|---|---|
| stdout | Output program: teks model, receipt perubahan (`› write_file …`), daftar/artefak perintah. Bersih dari cursor-control saat non-TTY |
| stderr | Progress/diagnostik: ledger tool (`› …` hijau/merah), reasoning (verbose), warning, error. Boleh transient bila TTY |
| Keduanya | Warna hanya bila TTY (`stdout.isTTY`); `NO_COLOR` menang; `TERM`/`COLORTERM` tidak menyalakan warna di pipe |

Satu-satunya arbitrator transient: `src/ui/runtime/statusline.ts` (`acquireTransientPaint` + `paintWrite`). Painter aktif (garis status turn vs spinner wizard) mutually exclusive; overlap = signal `[transient-paint]`, bukan crash. Foreign stderr writer (non-UI) boleh mentah — arbitrator mengkomitnya sebagai baris permanen bersih. `beginInteractiveScreen` menahan semua painter itu selama layar interaktif memegang terminal. 30 invariant (I1–I30) + peta test (`tui-app`, `screen-buffer`, `tui-popup`, `transient-arbitration`, `input-resize`, `exit-codes`, `acp`, `ui-boundary`) ada di `TERMINAL_CONTRACT.md`.

Enam primitif tampilan (semuanya di dalam TUI fullscreen saat interaktif): transkrip `minicode ›` tampil saat boot/idle dan kembali otomatis setelah turn selesai + jawaban model + ledger `  › name target` hijau / `  › name: …` merah; status bar satu baris `✦ 00.00.00 mode  model  cwd` (timer redup idle; saat aktif hanya detik putih, menit ikut terang setelah 60 dtk, jam setelah 1 jam; sparkle proses; konteks rata kanan; tanpa bullet separator; `src/ui/tui/app.ts` merender composer dots dan satu spacer di atas footer per frame); popup komposit satu kotak (`/model`, `/provider`, `/sessions`, form, approval) via `openAltScreen`/`paintRegion`; thinking redup tanpa marker transcript (composer dots; isi via `/expand`); error `✗ pesan actionable` sekali per kegagalan (`takePendingError`). `✓`/`✗` tetap untuk status/konfirmasi perintah (sync, auth, config, spinner).

## Modul kunci

- `src/ui/render/`: `theme.ts` (getter `c`/`glyphs`), `width.ts` (kolom), `sanitize.ts` (hanya SGR lewat), `markdown.ts`, `markdown-table.ts` (parser pipe-table streaming), `table-grid.ts` (grid budget terminal), `highlight.ts diff.ts table.ts wrap.ts money.ts errors.ts`.
- `src/presentation/`: `events.ts` (25 semantic event types + proposed marker), `adapter.ts` (runtime → DomainEvent), `reducer.ts`/`model.ts` (replayable bounded state + derived summary), `store.ts` (content refs), `projection.ts` (policy node/mode + envelope `minicode.output.v1` + kategori error machine, murni), dan `src/session/persistence.ts` (`presentation_events` durable log). `cli/setup.ts` memiliki exhaustive `toPresentationEvent()` bridge; renderer TUI/linear/machine memakai keputusan policy via injeksi `PresentationPolicy`; jalur raw legacy hanya untuk rollback flag.
- `src/ui/input/`: `askLine`, `prompt-engine` (grapheme `Intl.Segmenter`, streaming decoder, bracket-paste, mouse X10/SGR press/drag/release + wheel dinormalisasi; selection app-level di TUI).
- `src/ui/screens/`: view murni `picker/overlay/wizard/model-manager/provider-manager`.
- `src/ui/assistant/simple.ts`: printer linier + clipboard OSC52. `turn-status.ts`: garis transient. `approval/prompt.ts`: `promptAsk/promptAskText`.
- Kualitas: `bench/`, `scripts/` (coverage/pack/telemetry/vendor), `experiments/` (adversarial).
