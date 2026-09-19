# Arsitektur

Peta struktur hidup yang interaktif ada di `ARCHITECTURE.html` (file pendamping di folder ini — search/filter, 9 section `00 Sekilas` → `09 UI/UX rendering terminal`). Halaman ini ringkasannya agar bisa dibaca GitBook + AI Ask.

Rencana aktif: `PLAN.md` (root). Kontrak terminal FROZEN: `TERMINAL_CONTRACT.md` (folder ini) — baca sebelum menyentuh output/rendering; perubahan perilaku wajib update dokumen + test peta proteksinya. Riset harness: `HARNESS.md` (folder ini). Arsip: `PLAN_UIUX_V6.md` (selesai, jangan dikerjakan ulang).

## Tiga lapisan

```
L1 cli/ + src/ui/   → controller tipis + presentation mandiri
L2 src/ non-ui      → agen: tools, agents, hooks, policy, providers, mcp, lsp, session, skills
L3 vendor/minicore  → kernel STATE/MODEL/ACTION/LOOP (freeze, zero-dep, via #minicore)
```

- `cli/` boleh impor `src/ui/` + `src/`; `src/` non-ui dilarang impor `src/ui/`; `src/ui/` dilarang impor `cli/`, `src/` non-ui, `#minicore`. Dijaga `test/ui-boundary.test.ts`.
- Satu-satunya jendela UI↔luar: `src/ui/contract.ts` (`UiEvent/UiBus/UiStep/UiExecution`).
- DI dari composition root (`cli/index.ts`, `cli/setup.ts`): `createProviderLayer → loadLastModel → createRagLayer → resume + planRecovery + reconcileUndoRedo → setupToolLayer + setAskTextFn → createMinicodeSession → journal + checkpoint + step-trace + runPromptWithVerify (baseline-first + self-heal 3 siklus + hooks) → logger + turn-status + usage/pricing → persist/finalize → close (kill jobs, mcp/lsp close)`. `setSubAgentSessionFactory` sebelum dispatch agar REPL/one-shot/`mcp serve` tercakup.
- `providers → config` satu arah (`src/providers/provision.ts` provisioning, `src/config.ts` murni IO).

## Alur satu prompt

`prompt → permission check → validateArgs (kernel) → executor (order/cap/abort-aware) → tool realpath+atomic → execute → checkpoint shadow-git + journal + step-trace → compaction (mekanikal sinkron; LLM async via seam `compactAsync`) → usage/pricing per-segmen longest-key → trace`.

## UI/UX terminal (kontrak FROZEN)

Sesi interaktif = **TUI alternate-screen** (transkrip milik app + status `✦ mode • model • cwd … 14.2k` di baris terakhir permanen — pad anti-geser, spark pulse, konteks rata kanan via CHA + input di atasnya). Jalur non-interaktif tetap shell-native append-only. 16 invariant + peta test (`terminal-contract`, `transient-arbitration`, `turn-status`, `tui-format`, `theme`, `tui-*`, `ui-boundary`, `footer-render`) ada di `TERMINAL_CONTRACT.md`.

Lima primitif tampilan (di dalam TUI): prompt `minicode ›` steril, status `✦ … 14.2k` di dasar, input dropdown `/` + reverse-search, activity via spark status, ledger `  › name target` hijau / `  › name: …` merah (indent 2), teks model wrapped, fence 2-spasi, error `✗ pesan actionable` sekali per kegagalan (`takePendingError`). `✓`/`✗` tetap untuk status/konfirmasi perintah (sync, auth, config, spinner).

## Modul kunci

- `src/ui/render/`: `theme.ts` (getter `c`/`glyphs`), `width.ts` (kolom), `sanitize.ts` (hanya SGR lewat), `markdown.ts highlight.ts diff.ts table.ts wrap.ts money.ts errors.ts`.
- `src/ui/input/`: `askLine`, `prompt-engine` (grapheme `Intl.Segmenter`, streaming decoder, bracket-paste, mouse dibuang).
- `src/ui/screens/`: view murni `picker/overlay/wizard/model-manager/provider-manager`.
- `src/ui/assistant/simple.ts`: printer linier + clipboard OSC52. `turn-status.ts`: garis transient. `approval/prompt.ts`: `promptAsk/promptAskText`.
- Kualitas: `bench/`, `scripts/` (coverage/pack/telemetry/vendor), `experiments/` (adversarial).
