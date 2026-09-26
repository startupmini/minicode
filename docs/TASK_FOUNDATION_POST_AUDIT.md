# Post-Fix Foundation Audit — Task System MiniCode

Audit `agent-task-architect` (POST-FIX FOUNDATION) terhadap `f38e0d1`.
Ruang lingkup: **hanya** memverifikasi bahwa fondasi TODO/task yang ada sudah
benar secara semantik dan aman dijadikan dasar fase arsitektur berikutnya.
Task Graph, Scheduler, `/tasks` UI, dan fitur arsitektur lain **tidak**
diimplementasikan di audit ini.

Semua temuan punya bukti eksekusi (proses CLI sungguhan atau mutasi kode yang
disengaja), bukan pembacaan kode saja. Yang tidak bisa dibuktikan ditandai
**unconfirmed**.

## Ringkasan

`f38e0d1` memperbaiki empat cacat nyata dan keempatnya terbukti non-vacuous
(membreak-the-fix membuat test merah). Tapi audit ini menemukan bahwa **dua
dari empat perbaikan itu belum menutup invarian yang diklaim**, dan satu kelas
bug yang sama masih hidup satu lapis di atasnya.

| Klaim di `f38e0d1` | Status setelah audit | Bukti |
|---|---|---|
| INV-001 task state bertahan lintas resume | **VERIFIED** | V-02, V-05 |
| INV-003 `completed` butuh bukti | **PARTIALLY VERIFIED** - bocor saat baseline hijau lalu verify turn merah | PF-01 |
| Plan event hanya terbit setelah tool sukses | **VERIFIED** | V-01 |
| Plan == file (satu normalizer) | **VERIFIED** | V-03 |
| (implisit) identitas sesi tunggal | **GAGAL** - masih ganda di sisi presentasi | PF-05 |

---

## Temuan

### PF-01 - P0 - `cli/setup.ts:1175-1182` + `src/tools/todo.ts:116`

**CURRENT BEHAVIOR.** Gerbang completion membaca `lastVerify`, yang hanya diisi
oleh `runVerifyWithPresentation`. Verify milik sebuah turn berjalan **setelah**
`todo_write` selesai. `baseline-first` menutupi kasus "baseline merah" (verify
pertama jalan sebelum agent), tetapi kasus **baseline hijau lalu verify turn ini
berubah merah** lolos: klaim `completed` tersimpan ke disk, lalu verify berjalan
tiga kali merah, dan file tetap `completed`.

**ROOT CAUSE.** Gerbang dievaluasi saat tulis dari bukti yang berumur satu
turn. Tidak ada rekonsiliasi setelah verify terakhir dijalankan.

**RISK.** P0. Persistensi `completed` palsu yang bertahan lintas proses -
persis invarian yang diklaim sudah tertutup di `f38e0d1`. Pada audit sebelum
gate, kondisi ini selalu berlaku; sekarang hanya berlaku bila baseline hijau.

**EXPECTED INVARIANT.** `completed` tidak boleh bertahan jika verify terakhir
merah.

**REPRODUCTION.** Verify yang hijau pada panggilan pertama lalu merah
(penacak `.vcount`):

```
todos: [{"content":"Refactor modul","status":"completed"}]
verify Jejak: [verify] attempt 1/3 failed | attempt 2/3 failed | still failing after 3 attempts
verify counter (.vcount): 4
```

**RECOMMENDED FIX (terkecil).** Setelah `runWithSelfHeal` selesai, jalankan
sekali rekonsiliasi: bila `lastVerify.ok === false`, turunkan setiap item
`completed` menjadi `blocked` beserta alasannya, tulis ulang file, dan
terbitkan `plan.updated` baru. Tidak perlu konsep baru; event yang sudah ada
cukup.

**TEST REQUIRED.** E2E: `--verify` dengan command "hijau sekali lalu merah",
model menandai `completed`; assert file akhir berisi `blocked` beserta
alasannya.

---

### PF-02 - P1 - `src/tools/todo.ts:136` (`loadTodos` memanggil `normalizeTodos`)

**CURRENT BEHAVIOR.** `loadTodos` memanggil `normalizeTodos(parsed.todos)`
tanpa argumen bukti, sehingga ia memakai `currentCompletionEvidence()` saat
**baca**. Item `completed` menjadi `blocked` di memori, tetapi file tidak
pernah dikoreksi. Durable state dan state yang diamati berbeda.

**ROOT CAUSE.** Satu fungsi dipakai untuk dua keperluan: sanitasi-tulis dan
baca. Kebijakan completion ikut terbawa ke jalur baca.

**RISK.** P1. Dua bentuk berbeda untuk satu file. `todo_read` melaporkan
`[!] ... blocked` sementara file tetap `completed`; agent mengambil
kesimpulan yang salah, dan tidak ada mekanisme apa pun yang menyelaraskan.

**REPRODUCTION.**

```
file di disk : [{"content":"Refactor modul","status":"completed"}]
todo_read     : "todos 0/1 · 1 blocked\n  [!] Refactor modul - last verification failed (...)"
```

Dikonfirmasi juga secara langsung:

```
dibaca tanpa bukti  : [{"content":"Task A","status":"completed"}]
dibaca dengan bukti: [{"content":"Task A","status":"blocked","blockedReason":"verify merah"}]
```

**EXPECTED INVARIANT.** Baca bersifat pasif: apa yang ada di disk adalah apa
yang dilihat. Kebijakan hanya berlaku saat tulis, atau bila ditulis balik.

**RECOMMENDED FIX.** Pisahkan jalur baca dari jalur kebijakan. `loadTodos`
memuat `blockedReason` apa adanya tanpa melewati gate; gate tetap hanya
berlaku di `todo_write`. Alternatif yang juga sah: terapkan gate lalu tulis
balik hasilnya, sehingga file dan bentuknya sinkron.

**TEST REQUIRED.** File `completed` plus bukti merah: `todo_read` harus
konsisten dengan file, atau file harus terkoreksi.

---

### PF-03 - P1 - `src/tools/todo.ts:110`

**CURRENT BEHAVIOR.** `normalizeTodos` membangun `{ content, status }` saja
dan tidak pernah membaca `blockedReason` dari input. `saveTodos` menulis field
itu ke JSON, tetapi `loadTodos` membuangnya. `renderPlan` juga tidak memuatnya.

**ROOT CAUSE.** Field ditambahkan sebagai output runtime, tapi tidak pernah
dimasukkan ke jalur baca.

**RISK.** P1. Blocker kehilangan penjelasan justru setelah restart, saat
operator justru paling butuh. Durable write, non-durable read.

**REPRODUCTION.**

```
file: { "todos": [ { "status": "blocked", "blockedReason": "verify: 3 errors" } ] }
todo_read : "todos 0/1 · 1 blocked\n  [!] Task X"      <- alasan hilang
renderPlan: "- [ ] A (blocked)"                        <- alasan hilang
```

**EXPECTED INVARIANT.** `blocked` tanpa alasan adalah state tak
terjelaskan; alasan harus bertahan lintas proses.

**RECOMMENDED FIX.** Baca `blockedReason` di `normalizeTodos` (bukan hanya
dari `evidence`), dan sertakan di `renderPlan`.

**TEST REQUIRED.** Tulis `blocked` beserta alasan, lalu proses baru:
`todo_read` harus memuat alasannya.

---

### PF-04 - P1 - `src/tools/todo.ts:229` (enum tool) dan `:109`

**CURRENT BEHAVIOR.** Enum schema tool memuat `"blocked"`, dan
`normalizeTodos` menerimanya apa adanya. Model dapat mengirim
`status: "blocked"` dan `blockedReason` menjadi `undefined`.

**ROOT CAUSE.** Status yang ditegakkan sistem dan status yang boleh dipilih
model dicampur dalam satu enum.

**RISK.** P1. `blocked` berubah menjadi generic non-completed state,
tercampur antara "verifikasi merah" (beralasan) dan "agen menyerah" (tanpa
alasan). Skill bagian 12 mensyaratkan blocker punya alasan dan kondisi pemicu.

**REPRODUCTION.**

```
todos: [{"content":"Tugas yang tidak mau dikerjakan","status":"blocked"}, ...]
blocked count=1, punya reason=0
```

**EXPECTED INVARIANT.** `blocked` selalu punya alasan. Status yang ditegakkan
sistem tidak boleh dipilih model tanpa alasan.

**RECOMMENDED FIX.** Keluarkan `blocked` dari enum yang dilihat model
(status runtime-saja), atau terima dari model tetapi wajib menyertakan
`blockedReason`.

**TEST REQUIRED.** `todo_write` dengan `blocked` tanpa alasan: ditolak, atau
dipaksa beralasan.

---

### PF-05 - P1 - `cli/setup.ts:991`

**CURRENT BEHAVIOR.** `createPresentationAdapter` menerima `{ sessionId }`,
yaitu id yang acak saat `--resume` tanpa `--session`, sementara
`appendPresentationEvents` menulis baris dengan `presentationSessionId`, dan
todo (perbaikan `f38e0d1`) juga memakai `presentationSessionId`.

**ROOT CAUSE.** Perbaikan identitas di `f38e0d1` diterapkan ke penyimpanan todo
saja; jalur adapter tidak disentuh, sehingga kelas bug yang sama tetap hidup
satu lapis di atas.

**RISK.** P1. Event plan tere-attach ke identitas fiktif. `planId` masuk
namespace berbeda sehingga plan tidak berkembang melainkan bercabang, dan
`rebuildFromDurable` dapat mengatribusikan state ke session yang salah saat
replay.

**REPRODUCTION.**

```
-- setelah --resume S --
  row.session_id=S  payload.sessionId=b9aeacd3  planId=plan:b9aeacd3:1
  >>> TIDAK COCOK (identitas ganda masih ada di sisi presentasi)
sessions di DB: ["S","b9aeacd3"]
file todo: ["S.json"]        <- todo sudah benar
```

**EXPECTED INVARIANT.** Satu identitas sesi. `row.session_id`,
`payload.sessionId`, nama file todo, dan `planId` berasal dari sumber yang
sama.

**RECOMMENDED FIX.** `createPresentationAdapter(session.events, { sessionId:
presentationSessionId, ... })`.

**TEST REQUIRED.** Setelah `--resume`, dump plan event: `row.session_id`
harus sama dengan `payload.sessionId`, dan `planId` harus memakai id sesi
kanonik.

---

### PF-06 - P2 - `src/tools/todo.ts:255` (`.catch(() => {})`)

**CURRENT BEHAVIOR.** `saveTodos` (JSON, durable) dan `savePlanSnapshot`
(`.md`) adalah dua store terpisah. Kegagalan yang kedua ditelan
`.catch(() => {})` tanpa jejak.

**ROOT CAUSE.** Penulisan dua artefak tidak atomik dan tidak di-outbox-kan.

**RISK.** P2. Artefak `.md` diam-diam usang selamanya sementara JSON dan
event tetap menyatakan kebenaran. Dampaknya saat ini rendah karena `.md` tidak
punya pembaca, tetapi docstring-nya sendiri mengklaim file itu "dibaca model
berikutnya saat resume lintas sesi", jadi klaim itu tidak benar dan artefak
tersebut hanya pemborosan I/O.

**REPRODUCTION.**

```
todos JSON : [{"content":"Task BARU","status":"completed"}]
plan events: [... {"status":"completed","steps":[{"title":"Task BARU","status":"completed"}]}]
plan .md   : null        <- tak pernah ditulis, tanpa warning
```

**EXPECTED INVARIANT.** Tidak ada artefak yang boleh diam-diam usang.

**RECOMMENDED FIX.** Pilih salah satu. (a) Hapus artefak `.md` beserta
`loadPlan` (kode mati, sudah tercatat di audit sebelumnya). (b) Jadikan
penulisan best-effort yang tercatat: plan event tetap terbit, dan kegagalan
laporkan.

**TEST REQUIRED.** `plans/` diblokir: tidak boleh ada klaim bahwa `.md`
tersinkron.

---

### PF-07 - P2 - `cli/setup.ts:1175` (routing bukti tidak bertes)

**CURRENT BEHAVIOR.** Tidak ada test yang menyalakan `--verify` sekaligus
memanggil `todo_write`. Test unit menyuntik bukti secara langsung sehingga
seluruh wiring produksi dilewati.

**ROOT CAUSE.** Test menutupi unit domain, bukan integrasi composition root.

**RISK.** P2. Perbaikan P0 bisa dicabut dari `cli/setup.ts` dan suite tetap
hijau. Ini terbukti, bukan ketakutan.

**REPRODUCTION (mutasi).** Injeksi bukti diganti menjadi
`() => ({ verdict: "unverified" })` (mutasi valid, `tsc` hijau):

```
48 pass / 0 fail   (test/task-invariants.test.ts + test/cli-session.test.ts)
```

Artinya gate INV-003 tidak terverifikasi end-to-end.

**EXPECTED INVARIANT.** Setiap perbaikan yang diklaim diuji lewat jalur
produksi yang memakainya.

**RECOMMENDED FIX.** Tambahkan test E2E: `--verify` dengan verify command
merah dan `todo_write`; hasil tool dan file harus `blocked`.

**TEST REQUIRED.** E2E verify menuju gate lintas proses.

---

### PF-08 - P3 - `cli/setup.ts:1176-1181`

**CURRENT BEHAVIOR.** `lastVerify` tidak pernah diinvalidasi ketika repo
berubah. Bila agen memperbaiki file lalu `todo_write` pada turn yang sama
(sebelum verify ulang), gerbang masih melihat merah.

**ROOT CAUSE.** Bukti tidak punya tingkat kesegaran (timestamp atau nomor
turn).

**RISK.** P3. False positive: aman secara keselamatan, tetapi membosankan.
Agen yang sudah memperbaiki masalah tetap ditolak `completed` selama satu
turn. Bukan kebocoran safety.

**RECOMMENDED FIX.** Catat `verifiedAtTurn` dan perlakukan bukti basi sebagai
`unverified`, atau reset `lastVerify` saat ada mutasi file (bisa memakai
receipt jurnal yang sudah ada).

**TEST REQUIRED.** Turn memperbaiki file lalu `todo_write`: tidak boleh
blocked kalau tidak ada bukti merah yang masih relevan.

---

### PF-09 - P3 - `src/tools/todo.ts:74` (`completionEvidence` global)

**CURRENT BEHAVIOR.** Sumber bukti adalah module-global mutable, sama seperti
`todoSession`. Dua sesi dalam satu proses: sesi terakhir menang.

**ROOT CAUSE.** Pola DI tanpa scoping per sesi.

**RISK.** P3. Tidak terjangkau lewat binary CLI (satu sesi per proses) maupun
sub-agen (`todo_write` di-strip), tetapi laten untuk embedder. Perhatikan
`mcp serve` memakai `createCliSession`, jadi hanya satu injeksi.

**RECOMMENDED FIX.** Ketika TaskStore dibuat, jadikan bukti per sesi
bukan global, seiring dengan identitas sesi yang tunggal.

**TEST REQUIRED.** Dua `createCliSession` dalam satu proses: bukti tidak
tercampur.

---

### PF-10 - P3 - `src/presentation/adapter.ts:602` (`planId` per turn)

**CURRENT BEHAVIOR.** `planId = plan:<session>:<turn>`. Dua `todo_write` pada
turn yang sama saling menimpa di `state.plans` (`reducer.ts:637`). Setelah
`f38e0d1` ini digabung dengan PF-05 sehingga namespace juga berbeda antar
proses.

**ROOT CAUSE.** `planId` tidak diturunkan dari identitas task, tetapi dari
nomor turn.

**RISK.** P3. Sejarah plan tidak dapat direkonstruksi (skill bagian 8:
evidence should remain reconstructable) dan tidak ada relasi `supersedes`.

**EXPECTED INVARIANT.** Plan adalah satu objek yang berevolusi, bukan
kumpulan potongan per turn.

**RECOMMENDED FIX.** Butuh identitas task stabil (INV-002). Ini prasyarat,
bukan perbaikan satu baris. Jangan dikerjakan sebelum Task Model ada.

**TEST REQUIRED.** Menunggu model task: rekonstruksi plan dari event log
seharusnya menghasilkan satu plan yang berevolusi.

---

### PF-11 - P3 - `cli/setup.ts:1473` (jendela antara tulis dan flush event)

**CURRENT BEHAVIOR.** `saveTodos` selesai di dalam tool; `plan.updated` masuk
antrean lalu di-flush lewat `setTimeout(..., 0)` dan `presentationWriteTail`.

**ROOT CAUSE.** Dua store ditulis pada dua momentum berbeda.

**RISK.** P3. Proses dibunuh di antaranya: file ada, event hilang. Arah
divergensinya benar (event adalah subset dari file, dan file adalah
kebenaran), jadi dampaknya kecil. Yang hilang adalah rekonstruksi presentasi,
bukan state.

**RECOMMENDED FIX.** Tidak mendesak. Bila ingin outbox, event plan sebaiknya
ikut transaksi file yang sama.

**TEST REQUIRED.** Kill antara tulis dan flush: file utuh, event boleh hilang.

---

## Yang terbukti benar (VERIFIED)

| ID | Klaim | Metode | Hasil |
|---|---|---|---|
| V-01 | `plan.updated` hanya terbit setelah tool sukses | Fault injection `ENOTDIR` pada direktori todos | `plan events durable: []` - kontrak bertahan |
| V-02 | Todo tidak nyasar ke id acak pada resume berulang dan ganti model | 1 seed + 3 resume + 1 ganti model | `files: ["o1.json"]` - tanpa yatim |
| V-03 | Plan sama dengan file (satu normalizer) | Mutasi bypass `normalizeTodos` | 3 test merah |
| V-04 | Gerbang menolak completion setelah verify merah sebelumnya | `--verify` 3 siklus gagal, lalu turn claim | `refused 1 completion claim(s)` |
| V-05 | Todo terikat ke id sesi kanonik | Mutasi `todoSession.id = sessionId` | E2E merah: `(no todos yet ...)` |
| V-06 | Notifikasi penolakan terlihat oleh model | Mutasi cabut `notice` | 1 test merah |
| V-07 | `atomicWriteText` benar-benar atomik | Pembacaan kode plus ENOTDIR | temp + fsync + rename, tanpa file target parsial |

Ringkasnya: PF-01 sampai PF-05 adalah gap nyata; V-01 sampai V-07 adalah
perbaikan yang terbukti bekerja.

## Batas audit ini

- Tidak menguji ENOSPC asli, hanya `ENOTDIR` dan `EACCES` lewat layout
  direktori. Untuk disk penuh: **unconfirmed**.
- Tidak menguji konkurensi multi-proses pada satu DB di luar yang sudah ada
  di suite. `todoSession` global tetap laten (PF-09).
- PF-03 diverifikasi lewat proses baru untuk `todo_read`, dan lewat
  pemanggilan fungsi murni untuk `renderPlan`.
- Tidak ada temuan yang menyangkut `delegate_task` atau sub-agen pada pass
  ini; audit sebelumnya sudah mengikat `todo_write` sebagai alat terlarang.
