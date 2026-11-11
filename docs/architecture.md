# Arsitektur

Dokumen ini adalah peta struktur dan alur runtime yang aktif untuk kontributor.

Roadmap fase pemilik tidak tersedia di checkout ini; jangan simpulkan status fase atau next action dari changelog maupun kode. `TERMINAL_CONTRACT.md` adalah kontrak terminal FROZEN — baca sebelum mengubah output; perubahan perilaku memerlukan pembaruan kontrak dan peta test. Kontrak output aktif ada di [event model](OUTPUT_EVENT_MODEL.md), [protocol](OUTPUT_PROTOCOL_SPEC.md), [rendering](OUTPUT_RENDERING_SPEC.md), dan [UX rules](OUTPUT_UX_RULES.md). Peta alur rendering ada di [UI Render Pipeline](UI_RENDER_PIPELINE.md).

## Tiga lapisan

```
L1 cli/ + src/ui/   → controller tipis + presentation mandiri
L2 src/ non-ui      → agen: tools, agents, hooks, policy, providers, mcp, lsp, session, skills
L3 vendor/minicore  → kernel STATE/MODEL/ACTION/LOOP (freeze, zero-dep, via #minicore)
```

Pin source kernel ada di [catatan vendor MiniCore](https://github.com/startupmini/minicode/blob/main/vendor/minicore/VENDOR.md):
`0d33571`. Impor kernel aplikasi hanya melalui `#minicore`.

Patch host yang diperlukan runtime tersimpan di `scripts/vendor-overlays/` dan
diterapkan saat sinkronisasi vendor; `VENDOR.md` mem-pin source, overlay, dan
fingerprint hasil akhirnya.

- `cli/` boleh impor `src/ui/` + `src/`; `src/` non-ui dilarang impor `src/ui/`; `src/ui/` dilarang impor `cli/`, `src/` non-ui, `#minicore`. Dijaga `test/ui-boundary.test.ts`.
- Satu-satunya jendela UI↔luar: `src/ui/contract.ts` (`UiEvent/UiBus/UiStep/UiExecution`).
- DI dari composition root (`cli/index.ts`, `cli/setup.ts`): `createProviderLayer → loadLastModel → createRagLayer → resume presentation-events + planRecovery + reconcileUndoRedo → setupToolLayer + setAskTextFn → createMinicodeSession → journal + checkpoint + semantic event sink + step-trace + runPromptWithVerify (baseline-first + self-heal 3 siklus + hooks) → logger + turn-status + usage/pricing → persist/finalize → close (kill jobs, mcp/lsp close)`. `setSubAgentSessionFactory` sebelum dispatch agar TUI/one-shot/`mcp serve` tercakup.
- `providers → config` satu arah (`src/providers/provision.ts` provisioning, `src/config.ts` murni IO).

## Alur satu prompt

`prompt → permission check → validateArgs (kernel) → executor (order/cap/abort-aware) → P2.10 canonical tool wrapper (await EffectIntent → execute → await EffectReceipt) → tool realpath+atomic → checkpoint shadow-git + journal + step-trace → compaction (mekanikal sinkron; LLM async via seam `compactAsync`) → usage/pricing per-segmen longest-key → trace`.

## Konteks & state durable

Konteks model adalah **working memory**, bukan state. Tiga lapis yang berbeda
dutinya:

| Lapis | Isi | Authoritatif untuk |
|---|---|---|
| Kernel `ContextStore` | history yang dikirim ke model, bisa lossy saat kompaksi | window berjalan |
| Tabel `messages` (durable) | `role, content, toolCalls, toolCallId, name, reasoning, is_error`; dapat diganti saat shrink kompaksi | continuity/resume dari bentuk tersimpan saat ini |
| Vektor memory + `presentation_events` | ringkasan memory best-effort dan event semantik terpilih | RAG & audit UI; bukan salinan lengkap percakapan |

Kompaksi bersifat lossy, termasuk setelah restart. `persistCurrent` mengirim
history yang sudah dipadatkan ke `shrinkThreadHistory`, yang menghapus lalu
menulis ulang baris `messages`; fold mekanis meringkas pesan lama sambil
**mempertahankan** hasil tool (head-terpotong per peran) — bukan membuangnya.
Ringkasan ke vector memory hanya dibuat di jalur LLM, dibatasi, opt-out, dan
best-effort. Karena itu jangan menganggap
semua fakta lama tetap dapat dipulihkan dari sesi atau vector store; state
penting harus dicatat di task, file, atau artefak verifikasi yang otoritatif.

Fidelity resume: `reasoning` (thinking) dan `is_error` (tool gagal) adalah
field kernel `Message` yang ikut dibawa ke history. Semula keduanya tidak punya
kolom, sehingga resume menghasilkan konteks buta. Keduanya kini jadi kolom
`messages` dan **wajib ikut prefix comparison** di `saveSession` — kalau tidak,
perubahan hanya pada `reasoning`/`is_error` dianggap "tak berubah" dan
incremental append melewatkannya (kelas bug F-05). Kolom ditambahkan additive,
jadi DB lama tetap terbaca dan turn lama resume dengan field absen.

Penulisan tetap incremental: `saveSession` hanya insert baris baru saat prefix
sama, bukan menulis ulang seluruh history. Ini alasannya sidecar JSON per-turn
pernah ditolak — history 400 pesan terukur 62 ms encode + 53 ms blob write tiap
turn (O(history)), jadi ~115 ms per turn, sementara jalur `messages` bersama
prefix-compare 10 ms.

## Task system (state kerja durable)

Task state **bukan** chat history dan **bukan** tool trace. Owner semantiknya
`src/tools/todo.ts`; `.minicode/todos/<id>.json` adalah satu-satunya sumber
kebenaran, dan `plan.updated` (event durable untuk ACP/`exec --json`) hanyalah
**proyeksi** dari file itu.

```text
todo_write (model) ─► normalizeTodos ─► .minicode/todos/<id>.json   (state)
                            │                    ▲
                            │                    │ setCompletionEvidence
                            │            bukti verify terakhir
                            ▼
                     plan.updated (proyeksi, terbit SETELAH tool sukses)
```

Tiga aturan yang menjaga domain ini:

1. **Identitas sesi kanonik (P2.1).** Todo terikat ke `sid` kanonik dari
    `resolveSessionIdentity` (`src/session/identity.ts`), bukan id volatil
    proses (`bootId`). `--resume` tanpa `--session` tidak lagi menempa id
    acak; `--resume` tak dikenal gagal eksplisit (`SESSION_NOT_FOUND`).
2. **Completion butuh bukti.** `setCompletionEvidence()` menyuntikkan verdict   (`unverified` | `passed` | `failed`) dari composition root. `failed` menolak
   `completed` → task jadi `blocked` + alasannya, dan hasilnya dilaporkan ke
   model. Default `unverified` menjaga pemakaian tanpa `--verify` tetap
   POSSIBLE; yang dilarang adalah completion diam-diam tanpa jejak.
3. **Satu normalizer, dua store.** `planFromTodos` ( adaptor) memanggil
   `normalizeTodos` yang sama dengan file, sehingga status/cap/`blocked` tidak
   bisa berbeda arah — dan plan event terbit di `execution:completed`, bukan
   dari argumen sebelum tool jalan.

Batas subsystem **todo**: file todo tetap datar — tanpa field dependency di
`TodoItem`, tanpa surface user (`/tasks`), `/undo` hanya revert file (todo
tetap `completed`), dan tanpa TTL/GC untuk file todo di luar SQLite.
Dependency/graph dan scheduler **sudah ada**, tetapi pada subsystem terpisah:
TaskGraph + Scheduler di `src/task/` beroperasi di atas TaskStore
(`.minicode/tasks.db`), bukan di atas file todo; `todo_write` hanya boleh
menyentuhnya lewat `taskId` kanonik (`src/tools/todo.ts`), dan control
surface-nya `/scheduler` (off by default).

## Bukti verifikasi (P2.10)

`src/session/verification.ts` + `src/tools/evidence.ts` menulis identitas
invokasi, intent pra-efek, receipt pasca-eksekusi, dan observasi eksplisit ke
jurnal mutasi yang sama (`src/session/journal.ts`). `committed` berarti return
tool terobservasi, bukan efek eksternal terbukti; `pending` tetap UNKNOWN.
Verifikasi tak menulis `messages`, proyeksi, presentasi, Run, atau kursor.

## UI/UX terminal (kontrak FROZEN)

Sesi interaktif (`minicode` di TTY mampu) SELALU membuka TUI **fullscreen alternate screen**: transkrip ala shell + status bar satu baris + popup komposit di atas transkrip yang tetap terlihat (redup). Jalur non-interaktif (one-shot prompt, `exec`, pipe/redirect/CI, `TERM=dumb`, layar < 10 baris) tetap shell-first: cetak polos append-only ke scrollback tanpa cursor control.

| Stream | Isi |
|---|---|
| stdout | Output program: teks model, receipt perubahan (`› write_file …`), daftar/artefak perintah. Bersih dari cursor-control saat non-TTY |
| stderr | Progress/diagnostik: ledger tool (`› …` hijau/merah), reasoning (verbose), warning, error. Boleh transient bila TTY |
| Keduanya | Warna hanya bila TTY (`stdout.isTTY`); `NO_COLOR` menang; `TERM`/`COLORTERM` tidak menyalakan warna di pipe |

Satu-satunya arbitrator transient: `src/ui/runtime/statusline.ts` (`acquireTransientPaint` + `paintWrite`). Painter aktif (garis status turn vs spinner wizard) mutually exclusive; overlap = signal `[transient-paint]`, bukan crash. Foreign stderr writer (non-UI) boleh mentah — arbitrator mengkomitnya sebagai baris permanen bersih. `beginInteractiveScreen` menahan semua painter itu selama layar interaktif memegang terminal. 35 invariant (I1–I35) + peta test (`tui-app`, `screen-buffer`, `tui-popup`, `transient-arbitration`, `input-resize`, `exit-codes`, `acp`, `ui-boundary`) ada di `TERMINAL_CONTRACT.md`. Kontrak itu juga memuat **peta gap proteksi** — klaim yang implementasinya benar tetapi belum punya assertion penjaga; itu daftar pekerjaan, bukan daftargreens.

Enam primitif tampilan (semuanya di dalam TUI fullscreen saat interaktif): transkrip `minicode ›` tampil saat boot/idle dan kembali otomatis setelah turn selesai + jawaban model + ledger `  › name target` hijau / `  › name: …` merah; status bar satu baris (`✦ 00.00.00 Work Mode: Discuss  model  cwd … context  Permission Mode: Auto`) dengan sesi baru `DISCUSS`+`AUTO`, pilihan Work Mode hanya Discuss/Plan/Build dan Permission Mode hanya Auto/Ask; Work Mode di kiri dan Permission Mode cyan rata kanan dekat konteks (label dipadatkan pada terminal sempit; timer redup idle, saat aktif hanya detik putih, menit ikut terang setelah 60 dtk, jam setelah 1 jam; sparkle proses; tanpa bullet separator; `src/ui/tui/app.ts` merender composer dots dan satu spacer di atas footer per frame); popup komposit satu kotak (`/model`, `/provider`, `/sessions`, form, approval) via `openAltScreen`/`paintRegion`; thinking redup tanpa marker transcript (composer dots; isi via `/expand`); error `pesan actionable` berwarna merah sekali per kegagalan (`takePendingError`). Status/konfirmasi perintah (sync, auth, config, spinner) memakai warna saja tanpa icon.

## Modul kunci

- `src/session/verification.ts` + `src/tools/evidence.ts`: identitas invokasi milik aplikasi, intent/receipt yang di-await, observasi eksplisit, idempotency, dan korelasi efek anak — semuanya di jurnal mutasi yang sama.

- `src/ui/render/`: `theme.ts` (getter `c`/`glyphs`), `width.ts` (kolom), `sanitize.ts` (hanya SGR lewat), `ledger.ts` (status word/glyph/paint + run-marker bersama untuk TUI & linear), `markdown.ts`, `markdown-table.ts` (parser pipe-table streaming), `table-grid.ts` (grid budget terminal), `highlight.ts diff.ts table.ts wrap.ts money.ts errors.ts`.
- `src/presentation/`: `events.ts` mendefinisikan event presentasi dan registry durability; `adapter.ts` memetakan runtime ke `DomainEvent`; `reducer.ts`/`model.ts` membangun state replayable dan ringkasan turunan; `store.ts` menyimpan referensi konten; `projection.ts` membentuk envelope `minicode.output.v1` dan kategori error machine. `src/session/persistence.ts` menyimpan log `presentation_events` dan `messages` dengan fidelity `reasoning`/`is_error`. `cli/setup.ts` memiliki bridge exhaustive `toPresentationEvent()`; renderer TUI/linear/machine memakai keputusan policy via injeksi `PresentationPolicy`.
- `src/policy/`: `context.ts` (estimator sadar-densitas kode/JSON + kalibrasi usage), `context-window.ts` + `context-window-catalog.ts` (resolve window: config → katalog → models.dev → default 128K alias → 32K), `bpe.ts` + `tokenizer-registry.ts` (tokenizer BPE presisi on-demand dari HuggingFace, cache lokal, fallback densitas), `compaction.ts` (kompaksi LLM + mekanikal, anti-drift/anti-thrash, prefer provider sesi), `usage.ts`/`pricing.ts` (estimas biaya + models.dev).
- `src/ui/input/`: `askLine`, `prompt-engine` (grapheme `Intl.Segmenter`, streaming decoder, bracket-paste, mouse X10/SGR press/drag/release + wheel dinormalisasi; selection app-level di TUI).
- `src/ui/screens/`: view murni `picker/wizard/model-manager/provider-manager`.
- `src/ui/assistant/simple.ts`: printer linier + clipboard OSC52. `turn-status.ts`: garis transient. `approval/prompt.ts`: `promptAsk/promptAskText`.
- `src/daemon/`: hosted-session runtime, discovery, framed IPC/capabilities, replay, approval brokerage, child supervision, dan ordered shutdown; composition melalui `cli/commands/daemon.ts`.
- `src/runtime/`: admission dan execution kernel aplikasi (`dispatch.ts`, `execution-kernel.ts`, `production-execution.ts`) serta recovery (`recovery.ts`).
- Kualitas: `bench/`, `scripts/` (coverage/pack/telemetry/vendor), `experiments/` (adversarial).
