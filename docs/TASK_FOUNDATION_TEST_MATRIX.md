# Task Foundation Test Matrix

Audit `agent-task-architect`, diperbarui setelah REPAIR atas temuan
`e4a7b7c`. Prinsip: sebuah test hanya boleh dihitung sebagai bukti kalau
**non-vacuous** - ia harus gagal saat fix yang diklaimnya dibalik.

Metode: **mutation testing**. Enam fix sengaja dibalik satu per satu
(`MUT-1` sampai `MUT-6`) dan observing test yang menyala.

## Legenda

- **NON-VACUOUS** - test merah saat fix dibalik
- **VACUOUS** - test tetap hijau saat fix dibalik (tidak menangkap apa pun)
- **UNCAUGHT** - mutasi fixing-nya tidak membuat test merah

## Mutasi yang dilakukan (repair pass)

| Mutasi | Apa yang dibalik | Test yang menyala | Hasil |
|---|---|---|---|
| MUT-1 | Blok rekonsiliasi setelah `runWithSelfHeal` dimatikan | E2E PF-01 | **RED** - 0 pass / 1 fail |
| MUT-2 | Injeksi bukti di `setup.ts` jadi `unverified` | E2E PF-07 | **RED** - `Received: todos 1/1 [x] Klaim selesai` |
| MUT-3 | `loadTodos` kembali menerapkan kebijakan | unit PF-02 x2 | **RED** - 17 pass / 2 fail |
| MUT-4 | Pembacaan `blockedReason` dihapus | unit PF-03 (+3 terkait) | **RED** - 15 pass / 4 fail |
| MUT-5 | `blocked` balik ke enum model + pagar kedua dihapus | unit PF-04 x2 | **RED** - 17 pass / 2 fail |
| MUT-6 | Adapter presentasi balik ke `sessionId` acak | E2E PF-05 | **RED** - 0 pass / 1 fail |

Semua enam **RED**. Tidak ada mutasi yang lolos tanpa terdeteksi.

## Perbandingan dengan pass sebelumnya

| Mutasi | Sebelum repair | Sesudah repair |
|---|---|---|
| Wiring produksi dibunuh (`unverified`) | 48 test hijau (**VACUOUS**) | E2E PF-07 merah (**terdeteksi**) |
| Regresi PF-01 (baseline hijau, turn merah) | Test tidak ada; `completed` bertahan | E2E PF-01: merah sebelum fix, hijau sesudah |
| Baca menerapkan kebijakan | Test tidak ada | 2 unit PF-02 merah saat dimutasi |
| `blockedReason` tidak dibaca | Test tidak ada | 4 unit merah saat dimutasi |
| `blocked` tanpa alasan | Test tidak ada | 2 unit merah saat dimutasi |
| Identitas adapter ganda | Test tidak ada | E2E PF-05 merah saat dimutasi |

## Test repair pass

| Test | File | Klaim | Mutasi | Status |
|---|---|---|---|---|
| PF-01 baseline hijau, turn merah | `test/cli-session.test.ts` | `completed` tak bertahan saat verify turn merah | MUT-1 | **NON-VACUOUS** |
| PF-07 jalur produksi verify-ke-gate | `test/cli-session.test.ts` | wiring composition root bekerja | MUT-2 | **NON-VACUOUS** |
| PF-05 identitas plan event kanonik | `test/cli-session.test.ts` | row = payload = planId dari sumber sama | MUT-6 | **NON-VACUOUS** |
| state task bertahan lintas resume (dari `f38e0d1`) | `test/cli-session.test.ts` | todo terikat id kanonik | `todoSession.id = sessionId` | **NON-VACUOUS** |
| PF-02 disk completed -> load completed | `test/task-invariants.test.ts` | baca pasif | MUT-3 | **NON-VACUOUS** |
| PF-02 reconcile adalah operasi tulis | `test/task-invariants.test.ts` | rekonsiliasi menulis balik | MUT-3 | **NON-VACUOUS** |
| PF-02 reconcile non-failed = no-op | `test/task-invariants.test.ts` | idempoten | - | VERIFIED |
| PF-03 alasan bertahan write-baca-renderPlan | `test/task-invariants.test.ts` | `blockedReason` durable | MUT-4 | **NON-VACUOUS** |
| PF-04 blocked tanpa alasan ditolak | `test/task-invariants.test.ts` | tak ada blocker tak terjelaskan | MUT-5 | **NON-VACUOUS** |
| PF-04 enum model tanpa `blocked` | `test/task-invariants.test.ts` | status runtime tak bisa dipilih model | MUT-5 | **NON-VACUOUS** |
| PF-04 blocked dengan alasan dipertahankan | `test/task-invariants.test.ts` | alasan dari file dihormati | MUT-4 | **NON-VACUOUS** |
| FAILED != BLOCKED | `test/task-invariants.test.ts` | verify merah -> `blocked`, bukan `failed` | - | VERIFIED |
| Gerbang tolak completed (4 test, dari `f38e0d1`) | `test/task-invariants.test.ts` | bukti merah menolak | gate dimatikan | **NON-VACUOUS** |
| Plan == file (3 test, dari `f38e0d1`) | `test/task-invariants.test.ts` | satu normalizer | bypass `normalizeTodos` | **NON-VACUOUS** |
| Publish hanya setelah sukses (2 test, dari `f38e0d1`) | `test/task-invariants.test.ts` | tak ada plan event untuk tool gagal | plan-on-completed dimatikan | **NON-VACUOUS** |

## Validasi observasi (anti-vacuous dari history replay)

Aturan yang ditegakkan: setiap E2E task memakai `tool_call_id` **unik per run**
dan observasi dikorelasikan ke call id itu, bukan mengambil pesan `tool`
pertama.

| Test | tool_call_id | Cara korelasi |
|---|---|---|
| PF-01 | `claim_pf01` | file todo di disk dibaca langsung setelah proses selesai |
| PF-07 | `claim_pf07` | `messages.find(m => m.tool_call_id === callId)` dengan call id diassert `=== "claim_pf07"` |
| PF-05 | `seed_write`, `resume_write` | dump SQLite `presentation_events`, korelasi lewat `session_id` + `planId` |
| resume (f38e0d1) | `read_now` | korelasi `tool_call_id` (fake provider default `call_1` untuk semua reply - itu sebabnya id unik wajib) |

**Test yang masih berisiko** (dicatat, tidak diperbaiki karena di luar scope):

| Test | Risiko | Alasan |
|---|---|---|
| `cli-session.test.ts` "memuat riwayat sesi sebelumnya" |Sedang | `expect(stderr).toContain("(2 messages)")` - rely on label string, bukan data task. Tidak observes task state. |
| `presentation-events.test.ts` (umumnya) | Sedang | Memakai `fakeBus` + `emit` langsung. Sah untuk adapter (murni), tidak sah untuk wiring composition root - itulah kenapa PF-07 butuh E2E tersendiri. |

## Cakupan yang TIDAK diuji

| Area | Status | Alasan |
|---|---|---|
| ENOSPC asli | **UNCONFIRMED** | Hanya `ENOTDIR` dan `EACCES` lewat layout direktori yang diuji. Disk penuh tidak direproduksi. |
| Multi-proses concurrent pada satu DB | **UNCONFIRMED** | Di luar scope repair ini; `todoSession` global tetap laten (PF-09, tidak diperbaiki). |
| PF-06 / PF-08 / PF-09 / PF-10 / PF-11 | **UNTESTED (disengaja)** | Tidak diperbaiki pada pass ini; tidak ada perubahan yang bergantung padanya. |
