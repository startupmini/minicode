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

MiniCode **shell-native CLI, bukan TUI**. Tanpa alternate screen/panel/header permanen. Output append-only scrollback; picker/manager transient dan menghapus diri sendiri.

| Stream | Isi |
|---|---|
| stdout | Output program: teks model, receipt perubahan (`› write_file …`), daftar/artefak perintah. Bersih dari cursor-control saat non-TTY |
| stderr | Progress/diagnostik: ledger tool (`› …` hijau/merah), reasoning (verbose), warning, error. Boleh transient bila TTY |
| Keduanya | Warna hanya bila TTY (`stdout.isTTY`); `NO_COLOR` menang; `TERM`/`COLORTERM` tidak menyalakan warna di pipe |

Satu-satunya arbitrator transient: `src/ui/runtime/statusline.ts` (`acquireTransientPaint` + `paintWrite`). Painter aktif (garis status turn vs spinner wizard) mutually exclusive; overlap = signal `[transient-paint]`, bukan crash. Foreign stderr writer (non-UI) boleh mentah — arbitrator mengkomitnya sebagai baris permanen bersih. 12 invariant + peta test (`terminal-contract`, `transient-arbitration`, `turn-status`, `tui-format`, `theme`, `repl-linear`, `ui-boundary`) ada di `TERMINAL_CONTRACT.md`.

Lima primitif tampilan: prompt `minicode ›` (steril — status pindah ke footer), footer status lengket `✦ mode • model • cwd … 14.2k` (spark pulse saat busy/redup saat idle; mode pad anti-geser; konteks rata kanan `14.2k`; garis `faint`; `src/ui/footer.ts` render + `src/ui/runtime/chrome.ts` DECSTBM `setBusy()`; `MINICODE_FOOTER=off|print|sticky|auto`, non-TTY nol byte), activity (garis transient stderr `···` tanpa spark), ledger `  › name target` hijau / `  › name: …` merah (stderr, indent 2), teks model (stdout, wrapped, fence 2-spasi), error `✗ pesan actionable` sekali per kegagalan (`takePendingError`). `✓`/`✗` tetap untuk status/konfirmasi perintah (sync, auth, config, spinner).

## Modul kunci

- `src/ui/render/`: `theme.ts` (getter `c`/`glyphs`), `width.ts` (kolom), `sanitize.ts` (hanya SGR lewat), `markdown.ts highlight.ts diff.ts table.ts wrap.ts money.ts errors.ts`.
- `src/ui/input/`: `askLine`, `prompt-engine` (grapheme `Intl.Segmenter`, streaming decoder, bracket-paste, mouse dibuang).
- `src/ui/screens/`: view murni `picker/overlay/wizard/model-manager/provider-manager`.
- `src/ui/assistant/simple.ts`: printer linier + clipboard OSC52. `turn-status.ts`: garis transient. `approval/prompt.ts`: `promptAsk/promptAskText`.
- Kualitas: `bench/`, `scripts/` (coverage/pack/telemetry/vendor), `experiments/` (adversarial).
