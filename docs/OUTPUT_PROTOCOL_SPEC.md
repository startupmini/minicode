# Output Protocol Specification

**Status:** landed — `exec --json` memakai envelope `minicode.output.v1`, ACP memakai framing JSON-RPC + mapping semantik yang sama; legacy `type:"tool"` hanya bila lifecycle absen  
**Tanggal:** 2026-09-25  
**Audit sumber:** `docs/OUTPUT_ARCHITECTURE_AUDIT.md`

## 1. Prinsip

Protocol ini mendefinisikan apa yang dikirim ke setiap consumer, bukan bagaimana
terminal menggambar. Satu semantic state dapat memiliki beberapa proyeksi:

```text
PresentationState
  ├─ normal human projection
  ├─ verbose human projection
  ├─ debug diagnostic projection
  └─ machine projection
      ├─ exec JSONL
      └─ ACP JSON-RPC notifications
```

Status, identity, duration, error cause, receipt, dan lifecycle tidak berubah karena
mode berubah. Yang berubah hanya level detail, layout, dan transport.

## 2. Klasifikasi output

### Human permanent

Teks assistant, ringkasan, receipt perubahan, hasil command yang memang diminta user.
Default: stdout pada non-TTY, atau transcript TUI pada interactive TTY.

### Human diagnostic

Warning, recovery, permission notice, verify result, setup failure, provider error.
Default: stderr pada TTY; pada TUI menjadi transcript/system/diagnostic node.

### Machine

`exec --json` dan `acp` stdout. Tidak boleh bercampur dengan teks manusia, ANSI,
spinner, help, atau warning. Error setup tetap harus menghasilkan envelope terminal
supaya CI tidak melihat stream kosong.

### Debug

Raw event/payload yang diminta `MINICODE_DEBUG_BUS=1` atau debug mode. Tidak aktif
secara default dan tidak boleh dianggap machine contract.

## 3. Stream contract

| Stream | TTY interactive | Non-TTY/machine |
|---|---|---|
| stdout | transcript/frame TUI, bukan raw shell | program output hanya |
| stderr | diagnostic/transient yang diizinkan | human error bila mode human; kosong/diatur untuk machine |
| cursor control | hanya owner screen/input | nol |
| alternate screen | hanya TUI | nol |
| SGR | boleh bila color gate | tidak perlu; `NO_COLOR` menang |
| raw OSC/CSI dari untrusted text | Forbidden | Forbidden |

`App` adalah pemilik tunggal frame TUI. Foreign writer ke stdout tidak boleh aktif
saat `TuiApp` memegang layar; diagnostic stderr yang tidak transient harus masuk ke
transcript atau competing-ownership guard.

## 4. Normal projection

Normal menjawab: apa yang terjadi, apakah perlu tindakan, apa hasil akhirnya.

Default tampil:

- task start/current state yang masih berjalan;
- meaningful progress, diaggregat parallel operation;
- tool receipt singkat bila ada efek nyata;
- finding/result/actionable plan;
- terminal error dengan next action;
- cancellation/timeout/partial status.

Default sembunyikan atau ringkas:

- raw args lengkap;
- internal IDs, event sequence, journal paths;
- token counter dan provider trace;
- raw tool stdout/stderr;
- reasoning detail;
- event payload dan checkpoint detail.

## 5. Verbose projection

Verbose menjawab: apa yang sebenarnya dilakukan agen.

Tambahan:

- nama tool dan target;
- duration setiap operation;
- command/file detail yang sudah disanitasi;
- receipt path, test summary, retry chain;
- reasoning expanded;
- recovery attempts dan kategori error;
- delta event aggregate, bukan raw database dump.

Verbose tidak boleh mengubah status terminal. Tool denied tetap denied; output yang
lebih panjang bukan izin untuk mengarang lifecycle.

## 6. Debug projection

Debug menjawab: apa yang terjadi di dalam runtime.

Tambahan:

- `eventId`, `correlationId`, `parentId`;
- event sequence dan timestamp;
- redacted raw payload;
- state transition/anomaly counters;
- checkpoint/journal references;
- renderer/source decision trace.

Debug payload wajib melewati secret scrub. Debug tidak boleh merusak stdout machine
atau menimpa frame TUI; debug human dikirim ke stderr/trace yang di-scope.

## 7. Machine projection

### Envelope

Semua event machine SHOULD menggunakan bentuk:

```json
{
  "schema": "minicode.output.v1",
  "eventId": "s1:1:17",
  "type": "tool.completed",
  "timestamp": "2026-09-25T12:00:00.000Z",
  "sessionId": "s1",
  "turnId": 1,
  "correlationId": "call-1",
  "source": "runtime",
  "severity": "info",
  "status": "completed",
  "visibility": ["machine"],
  "payload": {
    "toolCallId": "call-1",
    "name": "write_file",
    "qualified": "write_file",
    "target": "src/example.ts",
    "durationMs": 42
  }
}
```

`eventId` contoh hanya format contract; implementasi harus memakai generator yang
deterministik untuk test dan stabil untuk consumer. `target` contoh bukan data nyata.

### Exec JSONL

`exec --json` harus:

- menulis satu JSON object per line;
- tidak menulis help, spinner, warning, ANSI, atau human ledger ke stdout;
- menulis setiap event canonical, bukan raw kernel shape;
- menyimpan `type: "summary"` sebagai record terminal dengan `ok: true|false`;
- membersihkan seluruh payload sebelum write;
- setup failure tetap menulis summary `ok:false` pada stdout lalu human error ke
  stderr dan exit 1;
- malformed client/input tidak membuat stdout kosong tanpa penjelasan.

Record terminal `summary` harus membawa:

```json
{
  "schema": "minicode.output.v1",
  "type": "summary",
  "ok": false,
  "error": {
    "category": "CONFIGURATION_ERROR",
    "message": "provider is not configured",
    "action": "configure a provider"
  },
  "prompt": "scrubbed prompt"
}
```

Prompt adalah data user-visible, tetapi harus disanitasi/scrubbed dan tidak boleh
mengandung secret.

### ACP JSON-RPC

ACP memakai transport JSON-RPC, bukan transport lain. Notification semantic
minimum:

- `turn.started`
- `turn.completed`
- `turn.failed`
- `turn.cancelled`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `tool.denied`
- `tool.cancelled`
- `approval.requested`
- `approval.settled`

Text delta tetap dapat dikirim sebagai:

```json
{"type":"text","delta":"..."}
```

Text delta tidak menggantikan lifecycle. `cancel` harus menghasilkan terminal task
state dan/atau JSON-RPC error yang eksplisit; `shutdown` tidak boleh meninggalkan run
aktif. Approval headless harus `deny` dengan reason `headless`, bukan pseudo-sukses.

## 8. Lifecycle wire rules

1. `started` sebelum terminal untuk task/tool/approval.
2. Terminal event tepat satu; duplicate/late event tidak membuat record user-facing
   kedua.
3. `eventId`/correlation ID harus cukup untuk mengaitkan delta, receipt, dan status.
4. Denial bukan `isError:true` tanpa kategori di machine output.
5. Cancellation dan timeout wajib berbeda dari failure.
6. Jika proses berhenti sebelum terminal, client dapat membangun ulang
   `interrupted` dari durable snapshot atau melihat turn incomplete secara eksplisit.
7. Child agent event tidak boleh terlihat sebagai tool root tambahan; scope/parent
   link harus tersedia untuk consumer yang membutuhkan detail.

## 9. Error grammar

Error user-facing harus menjawab secara berurutan:

```text
APA YANG TERJADI
APA YANG SEDANG DILAKUKAN
MENGAPA GAGAL
APA YANG BISA DILAKUKAN NEXT
```

Contoh:

```text
✕ Build failed
  TypeScript reported errors in 2 files.
  → Fix the reported errors, then retry.
```

Kategori internal tampil di verbose/debug; normal tidak boleh membuang actionable
reason. Provider JSON tidak boleh dicetak mentah sebagai pesan utama.

## 10. Copyability

Human output harus tetap berguna tanpa warna:

- status punya glyph + kata;
- path/command dapat disalin tanpa escape;
- tabel TTY boleh terformat rapi, tetapi machine/non-TTY mempertahankan source sanitized;
- selection text mengambil logical source, bukan frame terminal;
- clipboard OSC52 hanya menerima payload sanitized dan memiliki failure fallback;
- `NO_COLOR` tidak mengubah status atau urutan.

## 11. Compatibility dan versioning

- `schema` wajib naik versi bila field mandatory berubah atau event type berubah.
- Field baru bersifat optional selama satu versi major.
- Event lama yang masih dibutuhkan selama migrasi dapat dipetakan, tetapi tidak boleh
  menciptakan semantik yang berbeda antar-surface.
- `exec` dan ACP boleh berbeda transport/framing, tetapi harus memakai event semantic
  yang sama.
- Raw kernel event bukan public machine contract.

## 12. Acceptance tests protocol

- Simple task: summary dan event lifecycle lengkap.
- Tool denied: category `denied`, bukan generic failed.
- Tool failed: cause/hint tersedia di machine projection.
- Cancellation: turn/tool terminal cancelled, tidak ada text event terminal.
- Timeout: reason timeout dan tidak ada duplicate error.
- Partial output: marker truncation dan reference, bukan dump tersembunyi.
- Secret/control bytes: tidak masuk stdout machine atau clipboard.
- Non-TTY: tidak ada ANSI/cursor/alternate screen.
- ACP setup failure: response JSON error, stdout tetap machine-safe.
- Parallel tools: setiap call memiliki correlation ID dan terminal state sendiri.
