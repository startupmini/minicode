# Output UX Rules

**Status:** contract grammar untuk normal/verbose/debug/machine output  
**Tanggal:** 2026-09-25  
**Audit sumber:** `docs/OUTPUT_ARCHITECTURE_AUDIT.md`

## 1. North star

Output harus membuat tiga pertanyaan user mudah dijawab:

1. Apa yang sedang dikerjakan?
2. Apa yang sudah terjadi dan bukti apa yang tersedia?
3. Apa yang harus saya lakukan berikutnya?

Output bukan tempat menaruh seluruh kompleksitas internal. Runtime boleh berkembang,
tetapi menambah kompleksitas tidak boleh otomatis menambah noise, warna, atau dump.

## 2. Grammar blok

Urutan default:

```text
USER INTENT
    ↓
TASK
    ↓
PROGRESS
    ↓
ACTIVITY / EVIDENCE
    ↓
FINDINGS
    ↓
PLAN
    ↓
RESULT
```

Tidak semua task membutuhkan semua section. Short task boleh:

```text
✓ Updated src/router.ts
✓ Tests passed

Done.
```

Task audit boleh:

```text
AUDIT
──────────────
Workspace
Progress
Findings
Plan
Result
```

### Section

```text
AUDIT
────────────────────
```

### Activity

```text
✓ Analyzed 18 files
```

### Active operation

```text
◌ Analyzing source files…
```

### Warning

```text
⚠ Dependencies are not installed
  Run the project install command, then retry.
```

### Error

```text
✕ Build failed
  TypeScript compilation failed in src/app.ts.
  → Fix the reported errors and retry.
```

### Finding

```text
⚠ Missing dependency installation

  package.json exists, but node_modules/ is absent.
```

### Plan

```text
PLAN
────────────────────
01  Install dependencies
02  Run tests
03  Review failing modules
```

Plan hanya future work. “Read file”, “run grep”, dan “think” adalah activity, bukan plan.

### Completion

```text
✓ Audit complete · 18 files · 42s
```

## 3. Status vocabulary

| Status | Glyph | Teks default | Arti |
|---|---|---|---|
| active | `◌` / `›` | `running` atau `active` | operasi masih berjalan |
| completed | `✓` | `completed` | sukses terminal |
| warning | `⚠` | `warning` | perlu perhatian, belum terminal failure |
| failed | `✗` | `failed` | operasi/turn gagal |
| denied | `⊘` | `denied` | policy/permission menolak |
| cancelled | `⊘` | `cancelled` | dibatalkan user/system |
| interrupted | `!` | `interrupted` | proses berhenti sebelum terminal |
| retrying | `↻` | `retrying` | recovery sedang berjalan |
| transition | `→` | `next` | tindakan berikutnya |
| info | `ℹ` | `info` | informasi non-actionable |

Glyph tidak pernah menjadi satu-satunya makna. ASCII fallback memakai kata atau struktur
yang setara. Warna hanya membantu hierarki, bukan encode status.

## 4. Progressive disclosure

### Normal

Tampilkan:

- task/intent aktif;
- progress yang bermakna;
- important finding dan result;
- actionable error;
- receipt singkat untuk efek yang penting;
- cancellation/partial state.

Sembunyikan:

- raw args lengkap;
- internal event/tool IDs;
- provider implementation details;
- raw tool output;
- repetitive file lists;
- token counters tanpa relasi dengan task;
- event trace.

### Verbose

Tambahkan:

- tool name, target, duration;
- important file/command details;
- reasoning jika user meminta;
- retry chain;
- test/result detail;
- recovery strategy dan next action.

### Debug

Tambahkan:

- event ID/correlation/parent;
- timestamps dan transition;
- redacted payload;
- anomaly counters;
- checkpoint/journal references;
- renderer/source trace.

### Machine

Tidak bergantung pada human text. Memberikan typed event, final summary, dan correlation
fields. Tidak mengirim raw kernel shape sebagai public contract.

## 5. Tool dan parallel operations

Activity menjelaskan apa yang sedang dikerjakan, bukan internal implementation dump.
Satu baris ledger default:

```text
› read_file src/config.ts
```

Completion:

```text
✓ read_file src/config.ts
```

Failure:

```text
✗ read_file src/config.ts
  File does not exist.
```

Denial:

```text
⊘ bash
  Permission denied by mode=plan.
```

Receipt:

```text
✓ write_file src/router.ts · 1 file · 34ms
```

### Parallel

Jangan interleave raw output. Kelompokkan:

```text
◌ Analyzing 11 source files…

  ✓ app.ts
  ✓ config.ts
  ✓ index.ts
  ✓ router.ts
  …
✓ Source analysis complete · 11 files
```

Untuk batch besar:

```text
✓ Analyzed 11 files
```

### Retry

Retry adalah call baru. Tampilkan hubungannya, bukan attempt number buatan:

```text
↻ read_file src/config.ts
  retry after ENOENT
```

Normal tidak menampilkan tool ID. Debug dapat menampilkan `correlationId`.

## 6. Progress

Progress harus menunjukkan perubahan state, bukan heartbeat spam:

```text
Processing…
Processing…
Processing…
```

Dihindari. Gunakan:

```text
◌ Reading 18 files…
◌ Running tests…
◌ Applying migration…
```

Untuk long-running tool:

```text
◌ Running integration tests… (2m 14s)
```

Progress yang tidak berubah setelah stall dapat menjadi warning/timeout sesuai policy;
renderer tidak mengarang fake progress. TUI memakai sparkle/dots pada composer/status,
linear memakai transient heartbeat, dan machine memakai duration/status field.

## 7. Findings, activity, dan evidence

Activity:

```text
✓ Read src/app.ts
```

Finding:

```text
⚠ Router initialization has no error boundary
```

Evidence:

```text
  src/app.ts:42
```

Recommendation:

```text
→ Add explicit initialization failure handling
```

Keempat konsep tersebut adalah node semantic yang berbeda. Node boleh ditampilkan
bersama, tetapi tidak boleh digabung menjadi satu string generik.

## 8. Error UX

Setiap error attempt menjawab:

- apa yang terjadi?
- apa yang sedang dilakukan?
- mengapa gagal?
- apa next step?
- apakah user perlu bertindak?

Kategori minimum:

- `WARNING`: perlu perhatian, operasi masih dapat berjalan.
- `ERROR`: operasi gagal, tindakan atau retry dapat membantu.
- `DENIED`: policy sengaja memblokir tindakan.
- `CANCELLED`: user/system sengaja menghentikan operasi.
- `TIMEOUT`: deadline terlampaui.
- `PARTIAL`: sebagian pekerjaan selesai, belum semuanya.
- `RECOVERED`: fallback/retry berhasil.
- `UNAVAILABLE`: informasi/backend tidak dapat dijangkau.

Error example:

```text
✕ Provider request failed
  Rate limit reached while running the model.
  → Retry after the provider cooldown, or choose another provider.
```

Jangan mencetak objek JSON/error provider sebagai pesan utama. Letakkan detail mentah
yang sudah disanitasi di verbose/debug dan pertahankan kategori/next action yang stabil.

## 9. Cancellation, timeout, partial, recovery

Cancellation harus punya state, bukan hanya hilang:

```text
↻ Cancelling…

✓ Task cancelled
```

Timeout:

```text
✕ Operation timed out after 15m
  → Retry with a smaller scope or increase the timeout.
```

Partial:

```text
⚠ Completed 3 of 5 files
  Two files failed; review the errors before retrying.
```

Recovery:

```text
↻ Provider unavailable; retrying with fallback…
✓ Recovered using fallback provider.
```

TUI harus mencegah live stream/foreign painter menimpa state terminal. Linear harus
flush buffer secara deterministic once pada settle/abort. Machine harus mengirim
terminal task event dan summary tepat satu kali.

## 10. Terminal geometry

- Target lebar 80, 100, dan 120+ columns.
- Semua ukuran memakai display columns; CJK/emoji dua kolom.
- Long path/command wrap atau truncate dengan marker, tidak pernah dipotong tanpa
  petunjuk.
- Resize terjadi saat paint; cursor selalu diparkir di input/overlay aktif.
- TUI frame selalu memiliki tinggi valid; terminal kecil menolak layar interaktif
  secara fail-closed, bukan menampilkan frame setengah.
- TTY dapat memakai aligned table; non-TTY dan machine mempertahankan source sanitized.
- Border/padding adalah chrome, bukan evidence/data.

## 11. Windows, PowerShell, dan ANSI

- ANSI/Cursor control tidak diasumsikan selalu tersedia.
- `NO_COLOR` dan pipe/redirect menang atas `TERM`/`COLORTERM`.
- Windows legacy memakai ASCII glyph dan no-color-friendly words.
- ConPTY limitation harus diuji atau di-skip transparan; tidak boleh dianggap hijau
  palsu.
- CRLF dan paste bracketed harus aman.
- Ctrl+C/EOF harus menghasilkan state yang koheren dan mengembalikan raw mode.
- Alternate-screen harus paired pada quit, error, fatal signal, dan child release.

## 12. Copy/paste dan selection

Output harus berguna bila disalin ke issue, log, chat, atau docs:

- status tidak bergantung pada warna saja;
- status word dan path tetap terlihat;
- source text, bukan terminal escape, masuk ke clipboard;
- app-level selection dipetakan ke source melalui wrap/CJK/SGR/table;
- prompt/popup/footer tidak selectable kecuali dirancang eksplisit;
- `Ctrl+C` menyalin selection jika ada, tanpa selection no-op;
- `Esc` membersihkan selection sebelum behavior cancel apa pun;
- kegagalan OSC52 terlihat dan `/copy` tetap menjadi fallback.

Native terminal drag selection is not promised while the app owns mouse tracking.

## 13. Accessibility dan i18n

- Semua user-visible UI text memakai dictionary `t()` pada TUI/linear surface yang
  aktif.
- UI tidak bergantung pada warna atau glyph saja.
- A11y live-region/terminal bell harus opsional dan tidak mencemari machine stdout.
- Prioritas locale: session command > environment > persisted state > OS locale
  > English fallback.
- Translation key yang hilang fallback ke English, bukan mencetak key secara diam-diam.

## 14. Anti-patterns

- `if (text.includes("denied"))` menentukan status.
- Raw tool stdout langsung menjadi normal UI.
- Normal mode == debug mode.
- Semua detail disembunyikan sampai final dump.
- Model narration dipakai menggantikan runtime state.
- Renderer menyimpan state kedua yang berbeda dengan reducer.
- `eventSeq` dianggap causality.
- Context compaction menghapus presentation history.
- Selection menyalin frame bytes/ANSI/padding.
- Direct stdout/stderr write baru tanpa owner dan category.

## 15. UX acceptance checklist

- [ ] User dapat melihat task, status, dan next action tanpa membaca debug.
- [ ] Tool denied/failed/cancelled/interrupted berbeda secara tekstual.
- [ ] Parallel work aggregated, tidak raw interleaved.
- [ ] Progress menunjukkan perubahan state, bukan spam.
- [ ] Plan bukan replay activity.
- [ ] Finding dan evidence terpisah secara semantic.
- [ ] Copy/paste tetap berguna tanpa color.
- [ ] 80-column/narrow/Unicode/resize/Windows fallback teruji.
- [ ] Machine output tidak bergantung pada scraping human text.
