# Output Event Model

**Status:** Phase 2 core state/replay contract landed; renderer/wire protocol masih target
**Tanggal:** 2026-09-25
**Audit sumber:** `docs/OUTPUT_ARCHITECTURE_AUDIT.md`

## Status implementasi

Phase 1 mengimplementasikan `user.message`, exhaustive bridge payload, dan marker
`PROPOSED_EVENT_TYPES` untuk event yang belum memiliki producer. Phase 2 core kini
menyimpan collection semantic lengkap, menghitung summary dari evidence, lalu
memuat ulang dari `presentation_events`; renderer dan machine protocol belum
dipindahkan penuh.

## 1. Tujuan

Model ini mendefinisikan fakta semantic yang boleh melewati runtime → policy →
renderer. Model ini bukan renderer contract dan bukan terminal output. TTY, linear,
JSONL, ACP, dan consumer masa depan harus membaca event yang sama lalu memilih
proyeksi yang berbeda.

```text
runtime fact
  → semantic event
  → deterministic reducer
  → presentation state
  → policy projection
  → renderer
```

## 2. Envelope kanonik

Implementasi internal dapat memakai nama field yang sudah ada (`eventSeq`, `ts`).
Bentuk wire eksternal harus versioned:

```ts
interface OutputEventEnvelope {
  schema: "minicode.output.v1"
  eventId: string
  type: OutputEventType
  timestamp: string
  sessionId: string
  turnId?: number
  stepId?: number
  correlationId?: string
  parentId?: string
  source: "runtime" | "app" | "derived"
  severity: "info" | "warning" | "error" | "critical"
  status: "started" | "active" | "completed" | "failed" | "denied" | "cancelled" | "interrupted" | "partial" | "recovered"
  visibility: Array<"normal" | "verbose" | "debug" | "machine">
  payload: OutputEventPayload
}
```

### Aturan field

- `eventId` adalah identitas stabil event untuk consumer; bukan renderer-generated
  string. Implementasi awal boleh memakai session/event sequence yang deterministik.
- `eventSeq` internal tetap urutan observasi per sesi, bukan causality.
- `correlationId` menunjuk tool call, approval, atau operasi mayor yang sedang berjalan.
- `parentId` hanya diisi untuk causality eksplisit: retry, child tool, atau turn parent.
- `source` membedakan fakta kernel, app-layer event, dan derived projection.
- `severity` tidak sama dengan `status`: `denied` adalah status, bukan severity.
- `visibility` dapat memiliki lebih dari satu mode; machine projection tidak boleh
  bergantung pada scraping human text.
- `payload` tidak boleh menyimpan secret, credential, raw ANSI yang tidak perlu, atau
  payload besar. Payload besar memakai `ContentRef`.

## 3. Taxonomy

### Session dan user

| Tipe | Producer | Meaning | Durable | Visibility default |
|---|---|---|---|---|
| `session.started` | composition root | sesi aplikasi siap | ya | machine/debug |
| `session.ended` | composition root | sesi ditutup/cleanup | ya | machine/debug |
| `user.message.received` | controller | input user dan prompt sanitized | ya sesuai session | normal |
| `user.approval.requested` | policy | approval harus diputuskan | ya | normal/machine |
| `user.approval.settled` | policy | keputusan allow/deny/cancel | ya | normal/machine |

`user.message.received` adalah semantic event, bukan string yang ditambahkan langsung
ke transcript. TUI boleh tetap melakukan echo visual, tetapi echo tersebut harus
merujuk pada entry yang sama.

### Task dan plan

| Tipe | Producer | Meaning | Durable |
|---|---|---|---|
| `task.started` | adapter/driver | satu `session.run` dimulai | ya |
| `task.progress` | policy/tool/app | perubahan status yang bermakna | tidak; state terakhir tetap durable |
| `task.completed` | adapter/driver | turn selesai normal | ya |
| `task.failed` | adapter/driver | turn gagal dengan cause | ya |
| `task.cancelled` | adapter/driver | user/timeout/budget/parent cancel | ya |
| `plan.created` | planner/tool | rencana kerja yang akan datang | ya bila adopted |
| `plan.updated` | planner/tool | perubahan langkah/urutan | ya |
| `plan.step.started` | planner/tool | langkah aktif | ya |
| `plan.step.completed` | planner/tool | langkah selesai | ya |

`plan.*` tidak boleh merekam “membaca file”, “menjalankan grep”, atau “berpikir”.
Itu adalah activity. Plan hanya menyatakan future work yang sudah diputuskan.

### Model dan reasoning

| Tipe | Producer | Meaning | Durable |
|---|---|---|---|
| `assistant.message.delta` | provider loop | potongan teks live | tidak |
| `assistant.message.completed` | adapter dari final result | assistant final message | ya |
| `assistant.message.truncated` | derived/content policy | final message dipotong oleh cap | ya |
| `assistant.reasoning.delta` | provider loop | potongan reasoning live | tidak |
| `assistant.reasoning.completed` | adapter/provider finalization | reasoning final/ref | ya; full payload best effort |
| `context.compacted` | MiniCore loop | context model dipadatkan | ya sebagai system event |

Delta tidak boleh menjadi satu-satunya bukti completion. Jika proses berhenti setelah
delta, rebuild harus menandai state sebagai `interrupted` atau `partial`, bukan
mengarang final message.

### Tool dan filesystem

| Tipe | Producer | Meaning | Durable |
|---|---|---|---|
| `tool.started` | adapter dari execution | operasi tool dimulai | ya |
| `tool.progress` | tool/app, opsional | status internal berubah | tidak |
| `tool.completed` | adapter | operasi sukses | ya |
| `tool.failed` | adapter | operasi gagal | ya |
| `tool.denied` | adapter/policy | policy/permission menolak | ya |
| `tool.cancelled` | adapter | operasi dibatalkan | ya |
| `file.changed` | journal/checkpoint | ada paths yang committed | ya |
| `test.completed` | adapter/tool evidence | hasil test terstruktur | ya |
| `finding.detected` | `submit_result` terstruktur | temuan/evidence semantic eksplisit | ya bila berasal dari agent |
| `result.produced` | task finalizer | hasil/actionable conclusion | ya |
| `checkpoint.created` | checkpoint adapter | checkpoint evidence dan linkage turn | ya |
| `plan.updated` | planner/tool | rencana dan status langkah | ya bila adopted |
| `diagnostic.raised` | adapter/policy | diagnostic actionable | ya |

Tool `completed` harus membawa `summary`, `durationMs`, `expandRef`, dan bila ada
`receipt`. Tool `failed` harus membawa `cause`, `message`, `hint`, dan `expandRef`.
Tool `denied` harus membawa `reason`; `denied` tidak boleh berubah menjadi generic
`failed` hanya karena satu renderer tidak tahu policy.

### Error, recovery, dan lifecycle

| Tipe | Meaning | Normal | Verbose | Debug/machine |
|---|---|---|---|---|
| `diagnostic.raised` | warning/configuration/recovery | ringkas | kategori + next action | cause/trace |
| `error.raised` | kegagalan yang perlu tindakan | actionable | source + detail | payload scrubbed |
| `recovery.started` | retry/fallback/compaction | “recovering” | strategi | reason/delay |
| `recovery.completed` | berhasil pulih | “recovered” | hasil | result |
| `recovery.failed` | strategi habis | status terminal | cause | full category |

Kategori error yang harus dibedakan:

- `USER_ERROR`
- `CONFIGURATION_ERROR`
- `PERMISSION_ERROR`
- `TOOL_ERROR`
- `FILESYSTEM_ERROR`
- `NETWORK_ERROR`
- `PROVIDER_ERROR`
- `MODEL_ERROR`
- `AGENT_ERROR`
- `INTERNAL_ERROR`

Recoverability adalah field terpisah:

- `RECOVERABLE`
- `RETRYABLE`
- `ACTION_REQUIRED`
- `FATAL`
- `UNKNOWN`

## 4. State machine

### Task

```text
started → active → completed
             ├────→ failed
             ├────→ cancelled
             └────→ partial → active | completed | failed
```

`cancelled`, `failed`, dan `interrupted` tidak boleh saling menggantikan.
`interrupted` hanya boleh muncul dari rebuild ketika durable evidence menunjukkan
proses berhenti sebelum terminal event.

### Tool

```text
started → running → completed
                 ├→ failed
                 ├→ denied
                 └→ cancelled
```

First-terminal-wins: terminal kedua untuk `toolCallId` yang sama diabaikan dan
dicatat sebagai anomaly. Tool yang tidak punya `started` tetap boleh direkonstruksi
sebagai `incomplete`, tetapi harus ditandai di diagnostics.

### Approval

```text
requested → settled { allow | allow-always | deny | cancelled }
```

Saat parent task settle, approval `requested` yang masih terbuka harus di-force-close
menjadi `cancelled(parent-ended)`. Saat rebuild/crash, hal yang sama terjadi dengan
alasan parent-ended; outcome tidak boleh tetap `requested`.

## 5. Ordering, correlation, causality, hierarchy

Empat concept dipisahkan:

1. **Ordering:** urutan observasi event. Adaptor menetapkan `eventSeq`; ini bukan
   urutan penyebab.
2. **Correlation:** ID yang stabil: `toolCallId`, `approvalId`, `correlationId`.
3. **Causality:** link eksplisit `supersedes`, `parentToolCallId`, atau approval link.
4. **Hierarchy:** `sessionId → turnId → stepId → toolCallId`; child session membawa
   parent link.

Tidak boleh menyimpulkan “B menyebabkan A” hanya karena `B.eventSeq > A.eventSeq`.
Tool paralel boleh tiba/selesai dalam urutan berbeda; setiap call tetap punya ID dan
duration sendiri.

## 6. Durable versus live

| Kategori | Contoh | Simpan | Rebuild |
|---|---|---|---|
| Lifecycle | task/tool terminal, approval | ya | ya |
| Final semantic content | message, result, plan, finding | ya | ya |
| Evidence ringkas | receipt, test summary, checkpoint | ya | ya |
| Live stream | model/reasoning delta, progress | tidak | tidak diperlukan |
| Derived heartbeat | spinner, elapsed tick | tidak | dihitung dari timestamp |
| Large content | tool output penuh | ref/store best effort | resolver bila tersedia |

`eventSeq` boleh dipotong pada delta, tetapi harus tetap menghasilkan replay yang
deterministik untuk event durable. Rebuild tidak boleh memerlukan token-by-token history.

## 7. Trust dan sanitasi

- Event internal boleh menyimpan diagnostic context, tetapi payload machine/wire harus
  melalui `scrubSecrets()` dan JSON-safe encoding.
- Nama tool, path, command, provider label, dan output model adalah untrusted display
  data. Sanitasi control sequence dilakukan di boundary ingestion atau projection,
  bukan hanya di satu renderer.
- `NO_COLOR` dan non-TTY berarti SGR tidak boleh menjadi makna. Status tetap punya
  glyph + kata atau struktur teks.
- Selection/copy payload berasal dari source map yang sudah disanitasi; tidak boleh
  menyalin escape, padding, atau border tabel.
- Event diagnostic internal default `debug`; warning yang actionable default
  `normal`; payload mentah default `debug/machine` dengan scrub.

Phase 2 now wires producers for `reasoning.completed`, `plan.updated`,
`finding.detected`, `result.produced`, `diagnostic.raised`, `test.completed`, and
`checkpoint.created`. Only `tool.progress` remains proposed because it is
intentionally live-only.

## 8. Invariant

- I-A01: renderer tidak memiliki kebenaran runtime maupun presentation.
- I-A02: setiap execution user-visible membawa `toolCallId` stabil end-to-end.
- I-A03: setiap tool terminal memiliki tepat satu final status.
- I-A04: state tidak menyimpan terminal geometry, timer, widget, atau payload besar.
- I-A05: reducer murni; event yang sama menghasilkan state yang sama.
- I-A06: payload besar selalu `ContentRef` dan evict selalu ber-marker.
- I-A07: retry adalah call baru dengan link `supersedes`, bukan attempt ID buatan.
- I-A08: approval tidak boleh tetap requested setelah parent settle/rebuild.
- I-A09: causality hanya melalui link eksplisit.
- I-A10: TUI/linear/exec/ACP memakai status, identity, duration, cause, receipt, dan
  lifecycle yang sama.
- I-A11: context compaction tidak menghapus presentation history.
- I-A12: `interrupted`, `failed`, dan `cancelled` eksplisit berbeda.

## 9. Status migrasi dari implementasi sekarang

| Implementasi sekarang | Target event | Migrasi |
|---|---|---|
| `turn:started` | `task.started` | adapter map, pertahankan turn ID |
| `turn:completed` | `task.completed` | tambahkan summary/receipt-derived fields |
| `noteRunSettled` | `task.failed/cancelled` | jadikan satu settlement path |
| `provider:text` | `assistant.message.delta` | stream policy di projection |
| `TurnResult.finalText` | `assistant.message.completed` | event final eksplisit |
| `execution:*` | `tool.*` | normalisasi di adapter |
| permission hooks | `approval.requested/settled` | outcome enum tunggal |
| journal callback | `file.changed` | link ke activity/turn |
| `tool.progress` | `tool.progress` | optional live-only, jangan durable |
| `context:compacted` | `context.compacted` | system entry, bukan compaction history |

Selama migrasi, raw event tetap boleh dibaca untuk diagnostics; setiap surface
user-facing baru harus berasal dari canonical projection.
