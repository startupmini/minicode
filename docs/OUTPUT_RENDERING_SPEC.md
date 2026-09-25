# Output Rendering Specification

**Status:** implemented renderer boundary; canonical policy active, with streaming content transport and one ACP compatibility window.
**Tanggal:** 2026-09-25  
**Audit sumber:** `docs/OUTPUT_ARCHITECTURE_AUDIT.md`

## 1. Prinsip boundary

Renderer berubah dari string consumer menjadi consumer dari semantic projection:

```text
PresentationState + ContentStore
        ↓
ProjectionPolicy(mode, viewport, locale)
        ↓
RendererInput (nodes + source refs + interaction state)
        ↓
TUI / linear / machine renderer
```

Renderer boleh:

- menghitung layout kolom, wrap, tinggi baris, dan posisi cursor;
- memilih warna, glyph fallback, dan density;
- menangani hover, selection, scroll, popup, dan keyboard;
- memakai `sanitizeAnsi` sebagai defense-in-depth.

Renderer tidak boleh:

- menentukan status dengan `includes("denied")`, regex, atau warna;
- membangun turn summary sendiri;
- menyimpan truth runtime/approval/durasi;
- meng-clip source text berdasarkan pixel/frame yang sudah dirender;
- menentukan bahwa machine consumer boleh membaca human string.

## 2. Inventaris renderer aktual

| Module | Tanggung jawab sekarang | Keterkaitan | Target |
|---|---|---|---|
| `src/ui/tui/transcript.ts` | Streaming content buffer, source map, markdown table, canonical tool ledger, evict, selection | Raw content bus + presentation snapshot/events + policy DI | View adapter; no semantic status parsing |
| `src/ui/tui/app.ts` | Input, viewport, layout, screen ownership, popup lifecycle, clipboard | Controller + painter | Controller/painter boundary unchanged |
| `src/ui/assistant/simple.ts` | Stream sanitizer, answer/tool state, collapse, table, copy, stdout/stderr | Presentation events + policy DI + streaming text | Normal/verbose projection writer |
| `src/ui/assistant/turn-status.ts` | Infer active phase dan heartbeat | Policy-derived activity label | Transient view only |
| `src/ui/runtime/screen.ts` | Alternate screen, atomic paint, region | Terminal primitive | Tetap dipertahankan |
| `src/ui/runtime/statusline.ts` | Arbitrasi transient stderr | Transport owner | Tetap, plus writer policy |
| `cli/commands/exec.ts` | Canonical lifecycle JSONL, text delta, versioned summary | Presentation events + text transport | Canonical machine projection |
| `cli/commands/acp.ts` | Canonical lifecycle ACP, sanitized text delta | Presentation events + compatibility fallback | Canonical lifecycle projection |
| `src/ui/approval/prompt.ts` | Human prompt/decision | DI/sink + policy-compatible fallback | Same decision event |

## 3. Kontrak input renderer

```ts
interface RendererInput {
  snapshot: PresentationSnapshot
  mode: "normal" | "verbose" | "debug" | "machine"
  viewport: { columns: number; rows: number; locale: "en" | "id" }
  content: ContentResolver
  clock: RendererClock
}
```

`PresentationSnapshot` harus read-only. `ContentResolver` mengembalikan `ContentEntry`
dengan marker retention; tidak mengembalikan seluruh raw database tanpa batas.
`RendererClock` adalah satu-satunya sumber waktu visual; `Date.now()` tidak boleh
dipanggil dari node builder atau state reducer.

### Projection node

```ts
type ProjectionNode =
  | { kind: "user"; text: string; source: SourceRef }
  | { kind: "message"; text: string; source: SourceRef; streaming: boolean }
  | { kind: "activity"; activity: ActivityEntry }
  | { kind: "finding"; finding: FindingEntry; evidence: EvidenceRef[] }
  | { kind: "plan"; plan: PlanEntry }
  | { kind: "result"; result: ResultEntry }
  | { kind: "warning" | "error" | "diagnostic"; error: SemanticError }
  | { kind: "system"; text: string; source: SourceRef }
```

Node membawa semantic payload. `priority`, `collapse`, `visibility`, dan
`groupKey` menentukan policy; node tidak membawa keputusan terminal.

## 4. Projection policy

| Node/status | Normal | Verbose | Debug | Machine |
|---|---|---|---|---|
| Task running | satu activity/current state | duration + target | event IDs | typed lifecycle |
| Tool completed | receipt singkat | receipt + duration | full metadata | typed completed |
| Tool denied | warning + reason | policy path | raw category redacted | typed denied |
| Reasoning | collapsed/dots | expanded | raw redacted chunks | structured ref/status |
| Plan | upcoming steps | step status | internal links | typed plan |
| Finding | finding + evidence ringkas | evidence detail | full evidence | typed finding |
| Diagnostic | actionable only | category + next step | trace/counter | typed diagnostic |
| Context compacted | system warning | reason detail | trace | typed event |

Policy tidak boleh mengubah final status. `machine` boleh lebih ringkas secara visual,
tetapi tidak boleh kehilangan terminal state atau category.

## 5. TUI renderer

### Ownership

`TuiApp` tetap memiliki:

- alternate-screen lifecycle;
- keyboard/mouse decoder;
- viewport scroll dan selection;
- popup suspend/resume;
- full-frame paint dan cursor parking.

`TuiApp` tidak lagi menjadi sumber status tool. Ia menerima status dari snapshot/
projection melalui `TuiHost`, dengan fallback deny bila DI tidak tersedia.

### Frame

Frame terdiri dari:

1. transcript viewport;
2. optional inline `/` dropdown;
3. composer/prompt atau activity row;
4. satu spacer;
5. status bar.

`screen.ts` tetap satu-satunya alt-screen owner. `paintRegion()` hanya untuk popup;
popup tidak boleh membuat listener stdin kedua.

### TUI semantic projection

- User message: satu entry user dengan source range.
- Assistant stream: live buffer yang di-cap; final node dipisah dari stream.
- Activity: started → running → terminal, dengan glyph + status word.
- Tool child: default dikelompokkan ke parent `delegate_task`; child detail tersedia
  pada verbose/debug.
- Context compaction: system entry, tidak menghapus history.
- Summary: system node dari canonical turn summary, bukan hasil hitung ulang widget.
- Error: node dengan category/cause/hint; tidak hanya string merah.

### Selection dan clipboard

Selection adalah view concern, tetapi sumbernya adalah `SourceRef` semantic:

- anchor/focus menyimpan source ID + logical offset;
- row visual menyimpan source range + display columns;
- wrap, CJK/emoji, SGR, table border, dan evict diuji;
- click prompt hanya memindahkan cursor;
- `Ctrl+C` copy hanya jika selection valid; tanpa selection no-op;
- `Esc` clear selection dulu, lalu abort/batal;
- OSC52 menerima plain sanitized payload dan failure state eksplisit.

Selection tidak boleh menyalin terminal control sequence atau table padding. Terminal
native selection bukan acceptance contract karena mouse tracking aktif.

## 6. Linear renderer

Linear renderer menerima `ProjectionNode[]`/snapshot yang sama:

- stdout: permanent output dan answer/result;
- stderr: activity, reasoning (verbose), warning, error;
- non-TTY: `stripSgr`, no cursor control, no alternate screen;
- TTY: satu compact ledger per operation, parallel child group;
- markdown table: semantic table hanya di TTY; non-TTY mempertahankan source sanitized;
- copy buffer: isi yang benar-benar terlihat, dengan cap dan marker.

`simple.ts` tidak lagi menentukan status dari raw result. Ia menerima activity
snapshot/event canonical, lalu hanya memilih glyph, stream, dan disclosure level.

## 7. Machine renderers

### Exec

Exec tidak memakai human renderer. Mapper canonical:

- canonical event → JSON object;
- terminal summary → object `type:summary`;
- scrub sebelum serialize/write;
- setup failure → summary `ok:false` pada stdout + human error stderr;
- tidak ada `console.log` dari builtin selama machine mode.

### ACP

ACP juga tidak mengurai terminal text. Lifecycle projection menggunakan event
canonical, sedangkan `text` delta tetap transport-compatible. Jika lifecycle
subscription tidak tersedia dalam compatibility window, hanya `tool.started`
diemit sebagai `type:"tool"` legacy; consumer harus menandainya sebagai
fallback dan tidak boleh menyusun status terminal dari raw text.

## 8. Diagnostics dan direct writes

Direct write bukan otomatis salah; ia harus diklasifikasi:

| Writer | Kategori | Route target |
|---|---|---|
| `TuiApp`/screen | TUI frame | stdout owner screen |
| `simple` permanent | human | stdout |
| `turn-status`/spinner | transient | statusline owner |
| approval/askLine | human input | prompt/overlay owner |
| CLI setup/recovery/verify | diagnostic | stderr atau transcript |
| exec/ACP | machine | protocol sink |
| debug bus | debug | stderr/trace |

Writer baru harus mendaftarkan category dan owner. `statusline.ts` tetap menjadi
arbitrator untuk transient, tetapi bukan pengganti semantic routing.

## 9. Geometry, text, dan fallback

- `displayWidth()` menghitung terminal columns; CJK/emoji = dua kolom.
- Sanitasi control bytes dilakukan sebelum output; SGR boleh hanya bila color gate.
- Resize dibaca saat paint, bukan saat event.
- `NO_COLOR`/legacy Windows memakai glyph ASCII atau status word.
- Narrow terminal memakai truncation/wrap yang menjaga path/target penting.
- TTY table boleh aligned; machine/non-TTY tidak boleh berubah makna.
- Copy/paste tidak bergantung pada warna.

## 10. Parity matrix

| Semantic | TUI | Linear | Exec | ACP |
|---|---|---|---|---|
| tool completed | ledger success | ledger success | `tool.completed` | `tool.completed` |
| tool denied | deny glyph/word | warning + reason | `tool.denied` | `tool.denied` |
| turn cancelled | stopped/abort state | stopped/error | `turn.cancelled` + summary | `turn.cancelled`/error |
| file receipt | activity/source | receipt line | typed receipt | typed receipt |
| context compacted | system entry | warning | typed system event | typed system event |
| duration | pinned/summary | suffix | field | field |
| parent/child | grouped | grouped | IDs/link | IDs/link |

Parity diuji pada semantic object sebelum snapshot string. Test output tetap diperlukan
untuk regressions visual dan protocol.

## 11. Migration seams

1. `PresentationAdapter` dapat tetap emit raw-compatible events.
2. `ProjectionBridge` aktif untuk semua surface; flag `MINICODE_PRESENTATION_V2` dihapus di Phase 8.
3. TUI/linear dapat membandingkan canonical projection dengan legacy output pada test.
4. Exec/ACP memakai canonical projection lebih dulu karena machine parity paling mudah
   diukur.
5. After one release and green golden tests, raw semantic subscriptions were
   removed from user-facing TUI. Raw EventBus remains for streaming content and
   diagnostics/trace only.

## 12. Definition of done renderer

- Tidak ada renderer yang meng-status-kan teks.
- TUI/linear/exec/ACP menghasilkan semantic fields yang sama.
- Sanitasi, width, lifecycle, machine stream, dan clipboard invariants tetap hijau.
- Tidak ada direct write baru yang tidak terkategori.
- Legacy path removal tidak mengubah exit code atau terminal contract tanpa update
  `docs/TERMINAL_CONTRACT.md` dan peta test.
