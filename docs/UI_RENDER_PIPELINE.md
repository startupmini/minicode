# UI Render Pipeline — peta jalur provider stream → terminal

Dokumen ini hasil audit stabilitas UI/UX terminal 2026-09-18 (baseline v0.9.27).
Sumber kebenaran perilaku tetap `docs/TERMINAL_CONTRACT.md` (FROZEN); dokumen
ini memetakan IMPLEMENTASI aktual per tahap beserta kontrak event dan temuan
audit. Angka test di sini diukur di Windows + Bun 1.4.2, suite penuh hijau.

Konvensi: `file:line` menunjuk simbol yang dimaksud. Aturan repo tetap berlaku:
`cli/` boleh impor `src/ui/` dan `src/`; `src/` non-ui DILARANG impor
`src/ui/`; `src/ui/` DILARANG impor `cli/`, `src/` non-ui, `#minicore`
(dijaga `test/ui-boundary.test.ts`).

## 1. Jalur pipeline (9 tahap)

Tahap A — provider stream mentah: `src/providers/router.ts` (fallback +
`provider:text/extension/tool_call/finish`), `src/providers/guards.ts:32`
(timeout + text-cap + stream-guard tunggal), adapter `anthropic.ts`,
`responses.ts`, `effort.ts`. Dirakit di `src/app/provider-layer.ts`.

Tahap B — kernel emit ke `session.events`: `vendor/minicore/src/core/loop.ts`
(`turn:started`, `provider:text` per chunk, `provider:extension`
reasoning/usage/error, `context:compacted` reason `pressure:*`/`recovery`,
`step:started/completed`), `executor.ts` (`execution:started/completed`),
`session.ts` (`turn:completed` HANYA di jalur sukses).

Tahap C — tidak ada penerjemah `AgentEvent → UiEvent`: `src/ui/contract.ts:33`
`UiEvent` identik struktural dengan `AgentEvent` kernel; `cli/setup.ts`
menyerahkan `session.events` apa adanya ke `attachSimpleLogger` +
`attachTurnStatus` (dipasang segar per turn, dilepas di `finally` agar event
telat hening).

Tahap D — logger utama `src/ui/assistant/simple.ts:104`: append-only
scrollback, tanpa alternate screen. `provider:text` → `sanitizeAnsi` PER CHUNK
→ `streamBuffer` → `flushBuf` (line-buffered) → `flushLine` (fence-state +
`decorateMarkdown` + `formatWrapped`) → `stdout`. Jawaban bisa minimize
(buffer 1MB + marker, dibuka via `/expand`).

Tahap E — garis status transient `src/ui/assistant/turn-status.ts`: satu baris
`stderr` untuk shell/linier, hidup hanya di fase sunyi (latch
`turnOn && !textOn`), hilang saat teks mengalir, hidup lagi saat tool
berikut. `endTurn()` deterministik dari driver `finally` (kernel tak emit
`completed` saat gagal/abort). TUI fullscreen tidak memakai painter transient
ini karena alternate screen dimiliki `TuiApp`.

Tahap F — arbitrator `src/ui/runtime/statusline.ts`: satu pemilik transient
(`turn` vs `spinner`); tulis asing saat painter aktif dikomit
(clear → tulis → repaint) sehingga diagnostik tak hilang; overlap = signal,
bukan crash. `paintWrite` tak pernah melempar (fail-closed Bun Windows).

Tahap G — status bar `src/ui/footer.ts` dirender `src/ui/tui/app.ts` sebagai
baris dasar frame fullscreen. `TuiApp` memiliki clock activity 200ms,
`Working`/`Thinking`/tool status, elapsed, dan konfirmasi `Stopping`
tanpa menunggu event provider. Footer/chrome lama
(`src/ui/runtime/chrome.ts`, DECSTBM scroll-region, `MINICODE_FOOTER`) DIHAPUS
bersama lapisan TUI lama — alternate screen menggantikannya; nol byte di
non-TTY. Footer baca `session.contextTokens` kernel (bukan spend kumulatif).

Tahap H — primitif render `src/ui/render/`: `sanitize.ts` (hanya SGR lolos),
`markdown.ts` + `highlight.ts` (fence-state per baris, konten utuh),
`width.ts` (kolom: CJK/emoji 2, potong aman-SGR), `wrap.ts` (lebar dibaca
per baris → aman resize), `theme.ts` (getter warna/glyph, jangan di-`const`),
`errors.ts` (pesan actionable + redact), `collapse.ts` (buffer `/expand`
200KB/entry, 500KB total), `diff.ts`/`table.ts`/`money.ts`/`format.ts`.

Tahap I — view murni vs controller: `src/ui/screens/` (props + callback,
tanpa IO) digerakkan `cli/` (`repl.ts`, `commands.ts`, `wizard.ts`,
`provider/model-manager.ts`, `approval/prompt.ts` via DI `ask`,
`setupWhenEmpty`, `setSubAgentSessionFactory`).

## 2. Kontrak Event → UI

Kolom: S = bisa di-stream, D = bisa duplikat, O = bisa out-of-order,
I = bisa diinterupsi, L = bisa tiba setelah completion.

| Event | Producer | Representasi UI | S | D | O | I | L |
|---|---|---|---|---|---|---|---|
| assistant text | provider stream | stdout wrap + fence 2-spasi | ya | tidak (E1) | tidak | ya (abort) | tidak (detach flush 1x, E6) |
| tool call | model → kernel | `› nama target` muted (compact: diam) | tidak | tidak | tidak | ya | tidak |
| tool result | tool → executor | ledger hijau/merah; minimize → `+ label` + buffer | tidak | tidak | tidak | ya | tidak |
| reasoning | provider extension | expanded: live per baris; minimized: `+ thinking` + buffer | ya | tidak | tidak | ya | tidak |
| thinking effort | picker `/model` | badge + level per model | tidak | tidak | tidak | tidak | tidak |
| usage | provider extension | verbose saja; masuk budget watcher | ya | tidak | ya (tail pasca-finish) | ya | ya (diabaikan aman) |
| compaction | kernel loop | `── compacted: <reason>` kuning, reason verbatim | tidak | tidak | tidak | tidak | tidak |
| permission request | executor → `ask` DI | header stdout + `askLine y/a/n`, fail-closed non-TTY | tidak | tidak | tidak | ya (deny) | tidak |
| permission denied | executor | error tool penuh, tak pernah minimize + reason | tidak | tidak | tidak | tidak | tidak |
| sub-agent | delegate_task → bus parent | ledger `›` biasa + usage; tanpa view khusus | tidak | tidak (jurnal skip forward) | tidak | ya | tidak |
| error provider | provider extension | `pendingError` consume-once → satu `✗` oleh driver | tidak | tidak (E15) | tidak | ya | tidak |
| warning | budget/recovery/verify | `[budget]`/`[recovery]`/`[verify]` kuning stderr | tidak | tidak (warned80 sekali) | tidak | tidak | tidak |
| completion | kernel loop | flush + `finalizeAnswer` + footer idle | tidak | tidak | tidak | tidak | tidak |
| abort | user/Ctrl+C/Esc | `(stopped)` + cleanup `finally` | tidak | tidak | tidak | — | tidak |
| timeout | kernel `createTimeout` | `✗ timeout` + turn dibuang transaksional | tidak | tidak | tidak | — | ya (late work ke turnStore privat, dibuang) |
| budget exceeded | watcher/driver | `[budget] … stopping turn` + abort ber-kind | tidak | tidak (fire-once) | tidak | — | tidak |
| provider failure | recovery policy | retry/compact/throw deterministik; cap retryAfter 30 dtk | tidak | tidak | tidak | tidak | tidak |

Mismatch yang dicari, hasil: tidak ada event runtime yang diabaikan UI secara
diam-diam (`bus-debug.ts` hanya subscribe 7 tipe untuk debug, bukan render).
Satu-satunya state turunan yang disengaja: footer memakai `contextTokens`
(estimasi jendela) sementara `/status` memisahkan Context/Input/Output/Total/
Cost/Budget — didokumentasikan di `docs/CONTROL-PLANE-MAP.md`, bukan mismatch.

## 3. State machine REPL (tidak eksplisit)

Tidak ada `enum` state; fase disimpulkan: `abort !== null` (busy),
`turnOn/textOn` (painter), `regionOn/detached` (chrome), plus ~14 flag
(`mode`, `escTimer`, `pending`, `nullStreak`, `warned80`, `activeSection`,
minimize toggles, buffer, `pendingError`, raw-mode listener). Invarian dijaga
`finally`/`detachUI`/`endTurn`, bukan type-state. Transisi ilegal yang
terbukti dicegah: painter saat teks mengalir, `endTurn` ganda, error ganda,
`+`/`-` di pipe, decoder bocor antar prompt, Tab membajak search.
Satu lubang nyata: listener approval `askLine` menempel DI ATAS `onBusyKey`
selama busy (byte Ctrl+C diterima keduanya) — aman fail-closed
(`raceAbort` → deny) tetapi observabilitas ganda. Lihat §5 temuan O1.

## 4. Temuan audit 2026-09-18 (eksperimen di /tmp, repo tak diubah)

F1 HIGH — SGR terbelah antar-chunk merusak output model. `sanitizeAnsi`
diterapkan PER CHUNK (`simple.ts:287`): `["\x1b[", "32mHello"]` tampil
literal `32mHello`. Bukti: harness E3 `out="32mHellom\n"`. Kelas sama untuk
OSC tak-terminasi (menelan sisa chunk). Perbaikan terkecil: tahan ekor
escape tak-lengkap di buffer dan sambung ke chunk berikut sebelum sanitasi.

F2 MEDIUM — SGR model bocor mentah ke stdout non-TTY. `"\x1b[31mRed\x1b[0m"`
satu chunk lolos `sanitizeAnsi` (by-design) lalu ditulis ke pipe apa adanya
(`out="\u001b[31mRed\u001b[0m\n"`), melanggar kontrak non-TTY deterministik.
Perbaikan terkecil: strip SGR (atau render via `c.*`) saat `!isTTY`.

F3 LOW — buffer thinking `/expand` membuang kepala diam-diam
(`thinkingBuf.slice(-200_000)` tanpa marker seperti `, capped 1MB` pada
answer). Informasi diagnostik hilang tanpa jejak.

O1 LOW — listener ganda approval vs busy-key (§3). Fail-closed, catat saja.

Status hardening (sesudah audit): F1 diperbaiki via `createStreamSanitizer`
+ `splitTrailingEscape` di `src/ui/render/sanitize.ts` (dipakai jalur teks
model/reasoning/bash di `simple.ts`, flush deterministik saat
completed/detach); F2 via kebijakan `stripSgr` non-TTY di `wOut`/`wErr` +
`rememberTurn` (cerminan `colorLevel` → `stdout.isTTY`); F3 via marker
`… (earlier thinking truncated)`; O1 didokumentasikan di `src/ui/tui/app.ts`
(busy-freeze + abort, tanpa refactor). Snap kiri/kanan: render pertama sesudah
geometri berubah
me-reset jangkar relatif askLine (`lastGeoCols/Rows` di `input.ts`) —
geometri lebar tak dilacak footer karena erase baris-absolut tak sound
pasca-reflow (terbukti model + ConPTY: reflow milik konsumen).
Dijaga `test/ansi-fragmentation.test.ts`
(termasuk properti semua-titik-belah ≡ whole-string),
`test/non-tty-output.test.ts`, `test/thinking-truncation.test.ts`,
`test/ui-combined.test.ts` (satu sistem: stream + tool + resize + footer),
`test/input-resize.test.ts` (gagal di kode lama: CUP ke anchor basi).

Batas yang TERVERIFIKASI BENAR (bukti harness + 178 test UI hijau):
token-by-token tepat-1x (E1), chunk 50KB utuh (E2), fence terbelah benar
termasuk yatim saat abort (E4/E4b), abort flush tepat-1x tanpa bocor ke turn
berikut (E6), urutan teks>tool>hasil (E7), permission fail-closed (E8),
kontrak budget murni vs gate (E9), tiga reason kompaksi tampil beda (E10),
forward sub-agent sebagai ledger biasa (E11), tool 5000-baris dipotong +
ANSI jahat dibuang (E12), decoder UTF-8 per-byte + ESC-split + paste 100KB
(E13), soak 50 turn tepat-1x 38ms +4.6MB tanpa ESC mentah (E14),
error consume-once + format actionable (E15), resize 120→20 mid-stream aman
(E5b), 10k events 151k ev/s tepat-1x (E17), CJK/emoji/wrap/truncate/fence
(E5), emphasis tak-seimbang lewat literal + tabel konten-tetap (fidelitas).

## 5. Residual risk (jujur, belum dibuktikan di audit ini)

Jalur TTY-live (painter denyut, footer sticky DECSTBM, overlay picker,
tombol busy) hanya tercakup harness fake-TTY + 178 test; tidak ada sesi TTY
nyata di audit ini. Chaos kombinasi (stream+resize+abort serentak di TTY)
dan soak 100+ turn multitool belum dijalankan. Sub-agent tanpa view khusus:
indukan dibedakan hanya dari nama tool (cukup untuk 1 level, belum diuji
visual untuk delegasi bertingkat — yang memang dilarang: tanpa nesting).
