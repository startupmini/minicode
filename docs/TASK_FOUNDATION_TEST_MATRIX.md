# Task Foundation Test Matrix

Audit `agent-task-architect` terhadap `f38e0d1`. Tujuan dokumen ini: setiap
test yang mengklaim sesuatu soal fondasi task harus bisa dibuktikan **tidak
vacuous** - yaitu benar-benar observing the execution under test.

Metode: **mutation testing**. Setiap fix sengaja dibalik, lalu test dijalankan.
Test yang tetap hijau saat fix-nya dibalik adalah **vacuous** dan tidak boleh
dihitung sebagai bukti.

## Legenda

- **NON-VACUOUS** - test gagal saat fix dibalik (terbukti menangkap regresi)
- **VACUOUS** - test tetap hijau saat fix dibalik (tidak menangkap apa pun)
- **UNTESTED** - jalur produksi tidak punya test sama sekali
- **VERIFIED** - diuji passing pada tree saat ini

## Matriks test yang sudah ada

| Test | File:line | Klaim yang diTes | Mutasi | Hasil mutasi | Status |
|---|---|---|---|---|---|
| state task bertahan lintas --resume | `test/cli-session.test.ts:508` | Todo terikat ke id sesi kanonik | `todoSession.id = sessionId` | RED: `Expected "TUGAS ASLI" / Received "(no todos yet ...)"` | **NON-VACUOUS** |
| bukti merah menolak completed | `test/task-invariants.test.ts:85` | Gate menolak `completed` | `if (false as boolean)` | RED | **NON-VACUOUS** |
| sumber bukti melempar tidak menuntaskan | `test/task-invariants.test.ts:104` | Fail-closed saat evidence error | `if (false as boolean)` | RED | **NON-VACUOUS** |
| render menampilkan blocked + alasan | `test/task-invariants.test.ts:112` | Alasan tampil | `if (false as boolean)` | RED | **NON-VACUOUS** |
| tool memberi tahu model saat ditolak | `test/task-invariants.test.ts:123` | Notifikasi ke model | `if (false as boolean)` | RED | **NON-VACUOUS** |
| satu in_progress = satu active di plan | `test/task-invariants.test.ts:151` | Plan pakai normalizer sama | `list = raw as ...` (bypass) | RED | **NON-VACUOUS** |
| cap plan = cap file | `test/task-invariants.test.ts:170` | Cap konsisten 50/50 | bypass `normalizeTodos` | RED | **NON-VACUOUS** |
| plan mencerminkan blocked | `test/task-invariants.test.ts:185` | Plan ikut keputusan gate | bypass `normalizeTodos` | RED | **NON-VACUOUS** |
| todo_write GAGAL tidak tinggalkan plan | `test/task-invariants.test.ts:213` | Publish hanya setelah sukses | matikan plan-on-completed | RED | **NON-VACUOUS** |
| todo_write dipanggil saja tidak terbit plan | `test/task-invariants.test.ts:227` | Tidak terbit di started | matikan plan-on-completed | RED | **NON-VACUOUS** |
| tool lain tidak hasilkan plan | `test/task-invariants.test.ts:240` | Isolation per tool | - | - | VERIFIED |
| plan event terbit SETELAH sukses | `test/presentation-events.test.ts:462` | Kontrak publish berubah | - | - | VERIFIED |
| bukti hijau/tak ada bukti izinkan completed | `test/task-invariants.test.ts:97` | Default `unverified` tidak memblokir | - | - | VERIFIED |

## Mutasi yang TIDAK tertangkap (temuan audit)

| Mutasi | Test terkait | Hasil | Arti |
|---|---|---|---|
| `cli/setup.ts` - `setCompletionEvidence(() => ({ verdict: "unverified" }))` (selalu unverified) | `test/task-invariants.test.ts` + `test/cli-session.test.ts` | **48 pass / 0 fail** | **PF-07 (P2): seluruh wiring verify-ke-gate di composition root TIDAK punya test.** Fix P0 bisa dihapus dari produksi dan suite tetap hijau. |

Mutasi di atas adalah yang paling penting di dokumen ini: ia membuktikan bahwa
unit test yang ada hanya menguji `normalizeTodos` dengan bukti yang disuntik
manual, bukan alur produksi `verify -> setCompletionEvidence -> gate`.

## Matriks area yang diuji lewat probe (belum jadi test)

| Area | Probe | Temuan | Test required |
|---|---|---|---|
| Completion - baseline merah | PROBE 1 (probe1) | Aman: 0 completed, 2 blocked | Jadi test E2E |
| Completion - 3x self-heal gagal | PROBE 2 (probe1) | Turn berikutnya ditolak | Jadi test E2E |
| Completion - baseline hijau, turn merah | PROBE 3 (probe2) | **BOCOR**: completed tetap | PF-01, P0 |
| Completion - blockedReason reload | PROBE 7 (probe3) | **HILANG** | PF-03, P1 |
| Completion - blocked tanpa alasan | PROBE 4 (probe2) | **BISA** | PF-04, P1 |
| Atomicity - saveTodos gagal | PROBE 5 (probe3) | Aman: 0 plan event | Jadi test E2E |
| Atomicity - savePlanSnapshot gagal | PROBE 6 (probe3) | **DIVERGEN** (`.md` null) | PF-06, P2 |
| Continuity - 3 resume + ganti model | PROBE 8 (probe3) | Aman: tanpa yatim | Sudah ada test parsial |
| Continuity - payload session drift | PROBE 9 (probe4) | **GAGAL** | PF-05, P1 |

## Test yang SUDAH ada tapi berisiko vacuous (audit)

| Test | Risiko | Alasan |
|---|---|---|
| `cli-session.test.ts:508` state task bertahan | Rendah | Sudah dikorelasikan dengan `tool_call_id` unik (`read_now`) karena fake provider default memakai `call_1` untuk semua reply. Kalau id tidak dibedakan, test akan membaca tool message yang di-replay dari history dan **selalu hijau** (sudah pernah terjadi saat penyusunan audit ini). |
| `cli-session.test.ts:459` memuat riwayat sesi sebelumnya | **Tinggi** | `expect(second.stderr).toContain("(2 messages)")` - rely on label string, bukan data. Tidak observes task state. |
| `presentation-events.test.ts` (umumnya) | Sedang | Memakai `fakeBus` + `emit` langsung, bukan eksekusi nyata. Sah untuk adapter (murni), TIDAK sah untuk wiring composition root. |

## Rekomendasi test (prioritas)

1. **P0 / wajib sebelum fase berikutnya** - E2E `--verify` (merah) + `todo_write`
   di `test/cli-session.test.ts`. Menutup PF-07.
2. **P0 / wajib** - E2E "baseline hijau lalu verify turn merah" +
   `todo_write` completed. Menutup PF-01.
3. **P1** - E2E `blockedReason` bertahan lintas proses baru. Menutup PF-03.
4. **P1** - `todo_write` dengan `blocked` tanpa alasan. Menutup PF-04.
5. **P1** - Plan event identity check (`row.session_id` == `payload.sessionId`)
   setelah `--resume`. Menutup PF-05.
6. **P2** - Fault injection `ENOTDIR` pada `todos/` dan `plans/`. Menutup
   V-01 (supaya tidak regresi) dan PF-06.

Semua test E2E wajib memakai `tool_call_id` unik per run agar tidak
terbaca ulang dari history yang di-replay.
