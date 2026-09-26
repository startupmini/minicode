# Audit Task Architecture — MiniCode

Audit `agent-task-architect` (FULL) pada commit `5b4b94f`.
Fokus: apakah MiniCode punya *task orchestration* yang durable, atau hanya
sebuah daftar teks yang ditulis model.

Ringkas: **hanya yang kedua.** Yang ada adalah satu tool
(`todo_write`/`todo_read`) dengan model `{content, status}` dan lima status.
Semua yang membuat sebuah task system menjadi durable — identitas stabil,
dependency, verifikasi, bukti, provenance, kontrol manusia — tidak ada. Tapi
dua cacat yang ditemukan **bukan** sekadar fitur yang belum ada: keduanya
pembuktian palsu yang bertahan lintas proses, dan keduanya sudah diperbaiki.

## Invariant

| ID | Invariant | Sebelum | Sesudah |
|---|---|---|---|
| INV-001 | Task state bertahan lintas proses/resume | **GAGAL** (terbukti) | VERIFIED |
| INV-002 | Identitas task stabil | GAGAL (tanpa id; `stepId` = indeks) | GAGAL |
| INV-003 | Completion didukung bukti | **GAGAL** (tanpa jalur penolakan) | VERIFIED |
| INV-004 | Requirement user otoritatif | GAGAL (tak ada konsep constraint) | GAGAL |
| INV-005 | Task state bukan chat text | GAGAL (hanya proyeksi plan) | GAGAL |
| INV-006 | Tool action bukan task | SEBAGIAN (model menentukan granularity) | SEBAGIAN |
| INV-007 | Perubahan task punya provenance | GAGAL | GAGAL |
| INV-008 | Dependency bermakna | GAGAL (nol) | GAGAL |
| INV-009 | Implemented ≠ verified ≠ accepted | GAGAL | SEBAGIAN |
| INV-010 | Graph bisa diinspeksi | GAGAL (TUI tak pernah render plan) | GAGAL |
| INV-011 | Retry menjaga identitas | GAGAL | GAGAL |
| INV-012 | State bertahan rotasi context | GAGAL (tak ada proyeksi ke context) | GAGAL |

## Temuan & status

Format: `ID · Severity · Bukti · Masalah · Root cause · Status`

### TASK-001 · P1 · `cli/setup.ts:913` vs `:500` (dibuktikan eksekusi)

`todo_read` pada sesi yang di-`--resume` mengembalikan `"(no todos yet)"`
padahal `.minicode/todos/<resumeId>.json` ada.

- **Symptom:** task state hilang di batas resume.
- **Local cause:** `todoSession.id = sessionId`.
- **System cause:** dua identitas untuk satu sesi, dan konsumen tidak konsisten.
- **Arsitektural:** identitas sesi tidak didefinisikan sekali di composition root.
- **Status: FIXED** — `todoSession.id = presentationSessionId`. Regresi E2E
  (`test/cli-session.test.ts`, "state task bertahan lintas --resume") terbukti
  gagal tanpa fix dan hijau dengan fix.

### TASK-002 · P0 · `src/tools/todo.ts` + `src/policy/verifier.ts` (P0)

Tidak ada satu pun jalur kode yang mencegah `completed` saat verify merah.
Self-heal 3 siklus gagal → `cli/setup.ts` mencetak "leaving for user" → daftar
todo tetap `3/3 completed`.

- **Root cause:** verifikasi dan task adalah dua subsistem terpisah dengan
  jembatan berupa dua baris prosa di system prompt — komentar di
  `src/policy/context.ts:66` sendiri mengakui pilihan "satu baris instruksi,
  bukan gate kode yang rapuh".
- **Status: FIXED** — `setCompletionEvidence()` + status `blocked` + alasan.
  Test: `test/task-invariants.test.ts` (5 test).

### TASK-003 · P2 · `src/presentation/adapter.ts:596` (vs `executor.ts:86-89`)

`plan.updated` disintesis dari argumen mentah di `execution:started`, yaitu
**sebelum** `tool.execute()`. `saveTodos` yang gagal (ENOSPC/EACCES) meninggalkan
`plan.updated` durable berstatus `completed` tanpa file-nya.
- **Status: FIXED** — terbit di `execution:completed`.

### TASK-004 · P1 · `adapter.ts:333` vs `todo.ts:64-72`

Dua normalizer independen. 2 item `in_progress` → file menyimpan satu
(`normalizeTodos` menurunkan yang kedua), plan mengatakan dua `active`. Cap
juga berbeda: file 50, plan 100 → item 51-100 hanya hidup di event log.
- **Status: FIXED** — `planFromTodos` memakai `normalizeTodos`.

### TASK-005 · P1 · `src/presentation/reducer.ts:217-251`

`evidenceComplete` dihitung sungguhan (mutation tool tanpa receipt) dan **nol
konsumen** — tak ada UI, gate, atau tautan ke task.
- **Status: NOT IMPLEMENTED** (follow-up).

### TASK-006 · P1 · `src/session/checkpoint.ts:46-63` + `.gitignore:28`

`/undo` revert file saja; `.minicode/` ada di luar snapshot, dan di mode
shadow-git `.minicode/` bahkan tak pernah masuk tree. Jadi `/undo` melaporkan
sukses sementara todo turn itu tetap `completed`.
- **Status: NOT IMPLEMENTED** (follow-up) — perlu rekonsiliasi, bukan sekadar
  menyalin file.

### TASK-007 · P1 · `src/tools/todo.ts:137`

`loadPlan` nol pemanggil produksi. Blok plan `.md` ditulis tiap `todo_write`
lalu tak pernah dibaca — persis kebalikan dari tujuan yang tertulis di
docstring-nya. Model juga tak pernah diberi tahu bahwa plan itu ada.
- **Status: NOT IMPLEMENTED** (follow-up).

### TASK-008 · P1 · `src/tools/todo.ts:11-18`

Nol konsep dependency: `depends_on`/`blocked_by`/topological sort/cycle
detection tidak ada. Skema JSON `additionalProperties: false` menutup ruang
tersebut. Tidak ada scheduler; model sendirinya yang memutuskan.
- **Status: NOT IMPLEMENTED** (butuh Fase graph tersendiri).

### TASK-009 · P2 · `src/tools/todo.ts:146`

`todoSession` adalah global mutable. Aman untuk CLI single-sesi dan sub-agen
(`todo_write` di-strip dari anak), **tidak aman** untuk dua sesi dalam satu
proses; `mcp serve` sengaja single-tenant (`mcp-server.json`) dan request
konkuren bisa saling menimpa file (last-writer-wins).
- **Status: NOT IMPLEMENTED** (dokumentasikan batasnya).

### TASK-010 · P2 · `src/session/persistence.ts:436-452`

`purgeExpired` hanya menyapu SQLite. `.minicode/todos/*.json` dan
`plans/*.md` tidak punya TTL/GC; `deleteSession` satu-satunya pengapus dan
tidak punya pemanggil produksi. Satu `minicode exec` yang memakai `todo_write`
bocor dua file selamanya.
- **Status: NOT IMPLEMENTED** (sudah ada di dokumen ini; perbaikan kecil).

### TASK-011 · P2 · `cli/commands.ts:100-118`

Tak ada `/tasks`, `/task`, `/todo`. `/plan` adalah **mode izin**, bukan penampil
plan (`cli/index.ts:228` → `permissionMode = "plan"`). Task state 100%
dimiliki model; manusia tak bisa inspect/mutate selain membaca isi tool.
- **Status: NOT IMPLEMENTED**.

### TASK-012 · P3 · `src/tools/todo.ts:54`

`TODO_MAX_ITEMS = 50` dipangkas diam-diam; model tak diberi tahu berapa item
yang hilang. `todo_write` juga full-replace buta: task yang dihilkannya pada
panggilan berikutnya hilang dari keempat store tanpa jejak.
- **Status: NOT IMPLEMENTED**.

## Root causemapping

```text
Symptom:      "agent bilang selesai, test merah"
Local cause:  status `completed` cuma string
System cause:  verifikasi tidak pernah bertemu dengan domain task
Arsitektural: tak ada boundary "evidence" — completion hanya diklaim

Symptom:      "todo hilang setelah resume"
Local cause:  todoSession.id ≠ id sesi kanonik
System cause:  satu sesi punya dua identitas
Arsitektural: identitas tidak ditetapkan sekali di composition root

Symptom:      "plan bilang selesai padahal file tidak ada"
Local cause:  plan disintesis dari args sebelum tool jalan
System cause:  event presentasi diterbitkan dari refine, bukan dari hasil
Arsitektural: presentasi memperlakukan klaim model sebagai fakta
```

Tiga akar masalah yang sama: **state yang dihasilkan model diperlakukan sebagai
fakta.** Ketiganya sekarang diperbaiki di boundary yang sama — apa yang ditulis
model harus melewati normalizer, dan klaim jadi state hanya setelah ada bukti
yang nyata (tool sukses, atau verify hijau).

## Apa yang TIDAK dikerjakan (dan kenapa)

Skill ini melarang big-bang rewrite (section 40) dan menuntut perubahan
inkremental. Following gap di atas butuh desain tersendiri, bukan perbaikan
sehari:

- **Task graph + scheduler + cycle detection** (TASK-008) — butuh model data
  baru (id stabil, `depends_on`, provenance). Merancang ini di sela perbaikan
  dua store akan menghasilkan sistem yang tidak bisa diuji.
- **`/tasks` + kontrol manusia** (TASK-011) — butuh renderer, bukan hanya
  domain; UI terminal adalah kontrak FROZEN dan layak dikerjakan terpisah.
- **Reconciling `/undo`** (TASK-006) — butuh keputusan semantik ("apa yang
  terjadi pada task yang di-undo?"), bukan sekadar snapshot file.
- **Proyeksi task ke context model** (TASK-007) — kotak SYSTEM pada
  resume; interacts dengan compaction dan perlu pengukuran token.

Semuanya tercatat di sini dengan bukti `file:line` agar tidak hilang.

## Validasi

- `test/task-invariants.test.ts` — 11 test: completion gate, konsistensi
  plan↔file, integritas publish.
- `test/cli-session.test.ts` — E2E resume (dibuktikan gagal tanpa fix).
- `test/presentation-events.test.ts` — kontrak publish plan diperbarui.
- Full gate pada tree yang sama: 2.610 pass / 22 skip / 0 fail; coverage
  84,49% funcs / 85,44% lines; pack 23/23; web check 48 halaman.
