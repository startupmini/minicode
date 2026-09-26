# Canonical Task Model - Design

Mode: **DESIGN** (agent-task-architect). Tidak ada kode yang diimplementasikan.
Basis: repo `979efa4`, audit `docs/TASK_ARCHITECTURE_AUDIT.md`,
`docs/TASK_FOUNDATION_POST_AUDIT.md`, `docs/TASK_FOUNDATION_GAP_MAP.md`, dan
repair `979efa4`.

## Prinsip yang dipakai

1. **Derived from repo, bukan dari teks skill.** Setiap keputusan di bawah
   ditunjuk ke kode yang ada. Hal yang tidak ada jejaknya di repo tidak
   diusulkan sebagai kebutuhan.
2. **Satu otoritas.** Model state tunggal; semua proyeksi diturunkan darinya.
3. **Event historis dipertahankan.** Tidak ada event lama yang dibuang tanpa
   alasan kebenaran yang terbukti.
4. **Tidak mengubah perilaku hanya agar terlihat rapi.** Setiap perubahan
   perilaku dari status quo ditandai eksplisit di dokumen ini dan menjadi
   keputusan yang butuh persetujuan manusia.
5. **UI/terminal beku.** Tidak ada perubahan kontrak.

## Bukti repo yang menjadi pembatas desain

| Fakta | Lokasi | Konsekuensi desain |
|---|---|---|
| `TodoItem` hanya punya `content`, `status`, `blockedReason` | `src/tools/todo.ts` | Model saat ini tak punya identitas, provenance, atau bukti |
| `stepId` = indeks posisi (`String(i+1)`) | `src/presentation/adapter.ts` | step number bukan identitas; harus diganti |
| `plan.updated` terbit per-turn (`plan:<session>:<turn>`) | `src/presentation/adapter.ts` | Plan tidak pernah berevolusi, hanya bercabang |
| Tabel SQLite: `sessions`, `messages`, `turns`, `presentation_events` | `src/session/persistence.ts` | Task tidak punya tabel; otoritasnya file JSON |
| `.minicode/plans/*.md` ditulis tiap write, **nol pembaca produksi** | `src/tools/todo.ts` (`loadPlan` hanya dipanggil test) | Artefak mati; jangan jadikan otoritas |
| `Receipt` = "view atas journal/checkpoint, bukan tracker baru" | `src/presentation/events.ts` | Bukti harus **merujuk** receipt, bukan menduplikasi isi |
| `TurnSummary.evidenceComplete` dihitung, nol konsumen | `src/presentation/reducer.ts` | Sinyal sudah ada, tinggal dipakai |
| `DURABILITY`: 22 dari 25 event durable; 3 delta tidak | `src/presentation/events.ts` | Task event baru harus durable + replayable |
| `--verify` opt-in; tanpa itu verdict `unverified` | `cli/index.ts:230` | Completion policy sudah punya tiga verdict |
| `applyCompletionPolicy` murni, dipakai tulis + rekonsiliasi | `src/tools/todo.ts` | Aturan completion tidak boleh diduplikasi |
| `SystemPrompt` cap 8000 char, `cutMarked` memotong **ekor** | `src/policy/context.ts` | Proyeksi task harus di slot `extra` (sebelum MEMORY) |
| `checkStaleTurn`, `validateResumeWorkspace` sudah ada | `cli/setup.ts` | Konsep "stale" sudah dikenal; aturan stale bisa mengikuti pola |
| `classifyTool("todo_write") === "none"` | `src/session/journal.ts` | Task state sengaja **bukan** mutasi eksternal |
| `withBusyRetry`, WAL, `purgeExpired`, tes konkurensi lintas proses | `src/session/persistence.ts` | SQLite sudah jadi store yang concurrency-safe di repo ini |
| `todoSession` global mutable | `src/tools/todo.ts` | Sumber kebocoran lintas sesi; akar masalah identitas |
| `presentationSessionId = resumeId ?? sessionId` | `cli/setup.ts` | Sudah ada satu id sesi kanonik; tinggal dipakai konsisten |
| `TODO_MAX_ITEMS: 50`, `TODO_CONTENT_MAX_CHARS: 200` | `src/constants.ts` | Batas eksis harus dipertahankan atauдименsionalkan dengan sengaja |

## Peta dokumen: mana menjawab apa

| Dokumen | Isi |
|---|---|
| `TASK_IDENTITY_SPEC.md` | task_id, `titleKey`, collision, re-attach |
| `TASK_STATE_MACHINE_SPEC.md` | Skema Task, state machine, completion semantics |
| `TASK_MUTATION_SEMANTICS.md` | Apa yang terjadi saat model mengirim berbagai bentuk daftar |
| `TASK_EVENT_MODEL.md` | TaskState vs TaskEvent, field event baru |
| `CANONICAL_TASK_MODEL_DESIGN.md` (ini) | Rangkuman, persistence, context/output, migrasi, test, keputusan |
| `CANONICAL_TASK_IMPLEMENTATION_PLAN.md` | Urutan fase + gate per fase |

## Ringkasan desain dalam satu halaman

**Identitas.** `task_id` bersifat stable,Give oleh SISTEM, format
`t<counter>` per sesi (monotonik, tanpa collision). Berbeda dari `order`
(urutan tampilan). `titleKey` = hash dari judul ternormalisasi; dipakai
**hanya** untuk searches re-attach setelah model kehilangan id (mis. setelah
context rotation), bukan sebagai identitas.

**State.** Satu tipe `Task` di `src/task/`, replacing `TodoItem`. Status
diperluas dari 5 ke 8 untuk memisahkan `FAILED` dari `BLOCKED` dan
menambahkan `VERIFYING`/`RETRYING`. Bukti disimpan sebagai **referensi**
`Receipt`, bukan salinan.

**Mutasi.** `todo_write` berubah dari *blind full-replace* menjadi
*declarative upsert-by-id-atau-titleKey*. Task yang tidak lagi muncul **tidak
dihapus**; penghapusan memerlukan `cancelled` eksplisit. Ini adalah
**perubahan perilaku** dan ditandai sebagai keputusan yang butuh persetujuan.

**Persistence.** Satu `TaskStore` kanonik. Rekomendasi: tabel SQLite di
`sessions.db` yang sama (mewarisi WAL, `withBusyRetry`, `purgeExpired`, dan tes
konkurensi yang sudah ada). File JSON menjadi ekspor humanska atau dihapus.
`plan.updated` diturunkan dari TaskState, tidak pernah jadi otoritas.

**Context.** Blok `# Tasks` di slot `extra` (sebelum MEMORY/AGENTS/repo-map)
agar tidak terpotong `cutMarked`. Diproyeksikan ulang tiap turn dari
TaskState, sehingga context rotation tidak menghapusnya.

**Output.** Tidak ada perubahan UI. `plan.updated` yang sudah ada tetap
menjadi permukaan machine (ACP, `exec --json`); humanska menyusul sebagai
fase terpisah.

## Apa yang TIDAK ada di desain ini

- Task Graph, scheduler, cycle detection runtime: **referensi saja**, validasi
  siklus saat tulis sudah ada tapi graph traversal tidak.
- Milestone: fase sendiri.
- `/tasks` UI: fase sendiri; kontrak beku.
- `priority` sebagai field fungsional: **ditunda** (§15 OPTIONAL) karena tidak
  ada scheduler yang membacanya.
- `attempts` sebagai field fungsional: **ditunda** karena tidak ada mekanisme retry.

## Risiko desain yang paling jujur

1. **Identity vs re-attach adalah dua masalah.** `task_id` stabil tidak
  otomatis berarti model bisa menemukan kembali task-nya setelah context
  rotation. Karena itu ada `titleKey`. Kalau `titleKey` gagal karena model
  mengubah judul, re-attach gagal dan task diduplikasi. Trade-off ini tidak
  bisa dihilangkan sepenuhnya tanpa model yang lebih kuat.
2. **Perubahan "task yang hilang tidak dihapus" mengubah perilaku nyata.**
   Model yang sebelumnya bisa membersihkan daftar dengan menghapus item
   sekarang harus menandai `cancelled`. Konsekuensinya daftar bisa menumpuk.
   Justru itu yang dimaksud (INV-004: requirement tak boleh hilang diam-diam),
   tapi harus disadari sebagai UX change.
3. **Pindah ke SQLite adalah perubahan besar** pada store yang sedang
   dipakai dua jalur (`cli`, `mcp serve`). Alternatifnya mempertahankan JSON
   dan memperbaiki race-nya lebih murah, tapi meninggalkan TTL gap. Dua
   opsi ini harus diputuskan manusia (§15).
4. **Task events di `presentation_events`**Fjerner coupling: tabel yang
  ideosnya adalah "agent state", bukan "task state". Ini dapat diterima karena
   yang kedua adalah bagian dari yang pertama, tapi perlu dicatat.

## Verifikasi desain

Semua klaim di dokumen ini harus dapat diuji sebelum implementasi. Rincian di
§14 (test strategy). Aturan yang sudah Established dari Foundation: setiap
regression kritis harus **diuji balik** (mutation testing) sebelum dianggap
terbukti.
