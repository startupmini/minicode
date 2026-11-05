# Live E2E Harness Hardening & Real-World UAT — MiniCode v0.13.x

**Tanggal:** 2026-11-01 → 2026-11-02
**Commit hasil perbaikan:** `cb60212` (7 file, +105/−6) di atas baseline `57c59d3` (v0.13.1)
**Gateway uji:** `https://tiprouter.my.id/v1` (API key diredaksi: `tip_***`)
**Isolasi:** `MINICODE_HOME=C:\Users\zo\AppData\Local\Temp\minicode-live-home-uat` · workspace `C:\Users\zo\AppData\Local\Temp\minicode-live-ws-uat` — `~/.minicode` host tidak pernah disentuh
**Mode:** headless/one-shot + `exec --json` (tanpa TTY), **tidak pernah** `--sandbox os`
**Status akhir:** kedua direktori temp dihapus; repo bersih kecuali satu file audit milik pengguna yang sengaja tidak disentuh

> **Ruang lingkup klaim.** Laporan ini adalah **laporan stage-scoped** untuk sesi UAT live ini.
> Gate repository yang dijalankan pada kandidat `cb60212`: `tsc`, `lint`, `gate:coverage`,
> `gate:pack` — semuanya hijau. `audit:harness`, smoke build/package penuh, `gate:bash`,
> `bench:smoke`, dan pemeriksaan CI **tidak** dijalankan dalam sesi ini, sehingga laporan ini
> **tidak** mengklaim release-readiness maupun penutupan track Quality Remediation.

---

## 0. Ringkasan Eksekutif

UAT live menemukan **4 bug nyata** di MiniCode yang semuanya diperbaiki, dipin dengan test, dan
di-commit (`cb60212`):

1. **Kalibrasi token dipercaya buta** — sampel usage kumulatif gateway menginflasi estimasi
   konteks hingga turn dibunuh palsu (`context window exceeded after compaction`). Diperbaiki
   dengan gerbang anti-sampel *in-flight*; cap faktor **64 dipertahankan** (pin p15 CTX-03
   membutuhkan headroom ~33×).
2. **`todo_write` gagal-tenang** — pesan error lama tidak memberi jalan keluar sehingga model
   mengulang payload identik. Pesan baru membawa panduan pemulihan eksplisit; rollback file
   **sengaja tidak** dilakukan (kontrak terdokumentasi 4A.4, dipin test N).
3. **`exec` menelan flag runtime diam-diam** — `--max-steps`, `--context-window`, `--timeout`,
   dan env `MINICODE_COMPACT_KEEP_TURNS` disaring dari prompt tetapi tidak pernah diteruskan ke
   sesi. Kini diteruskan (parity dengan jalur one-shot) + warning nilai invalid.
4. **`friendlyError` memask error jendela konteks** — `budget_exceeded: context window exceeded
   after compaction` dipetakan menjadi "Session budget exceeded → naikkan `--budget`" (saran
   yang salah total). Ditambahkan branch `context window` sebelum catch-all "budget".

Selain itu ditemukan **5 rekomendasi hardening** (tidak diubah kodenya; lihat §8) dan beberapa
perilaku gateway/model yang penting untuk operasi nyata (§2).

Hasil fungsional UAT: **MiniPulse 5 file dibangun penuh oleh model, self-repair 5 check verifier
sampai 66/66 PASS, fitur Export CSV/JSON, dan fitur SLA uptime melewati gate ketat operator
(RED 4 FAIL → GREEN 0 FAIL)** — seluruhnya tanpa intervensi manusia pada kode aplikasi.

---

## 1. Metodologi & Isolasi

| Aspek | Nilai |
|---|---|
| Home terisolasi | `…\Temp\minicode-live-home-uat` (config provider + `verifyCommand` + `reasoningEffort: "low"`) |
| Workspace terisolasi | `…\Temp\minicode-live-ws-uat` (5 file MiniPulse + verifier + log per stage) |
| Sesi host `~/.minicode` | Tidak pernah dibaca/ditulis |
| Sandbox OS | **Tidak dipakai** — F-03 fail-closed diverifikasi lewat `tool.denied` (lihat §6) |
| Output mesin | Semua evaluasi memakai `exec --json` (JSONL, tanpa ANSI) kecuali dua run human-mode yang dicatat |
| Provider | Satu provider `tiprouter`, model utama `glm-5-3-flash`, fallback probe `kimi-k2.6` / `deepseek-v4.1-flash-1017` |

**Pelajaran operator (bukan bug produk):** pada jalur one-shot, **flag harus berada SEBELUM
token prompt**. `args.ts` sengaja menghentikan pemindaian flag pada kata prompt pertama
(pertahanan anti-injeksi); semua flag yang diletakkan setelah prompt menjadi bagian teks prompt.
Satu run awal (stage5) gagal murni karena kesalahan invokasi ini — lihat RCA §7.1.

---

## 2. Profil Gateway & Model (A)

| Aspek | Temuan |
|---|---|
| Ketersediaan | `glm-5-3-flash` TTFT 1,6 s ✓ · `kimi-k2.6` 2,7 s ✓ · `deepseek-v4.1-flash-1017` 1,4 s ✓ · `glm-5.3` cooling saat uji · endpoint **embedding 404** |
| `reasoning_effort` | **Dihormati gateway.** Probe terkontrol: default → 526 token reasoning; `low` → 27 token (≈20× hemat). Dipasang via `reasoningEffort:"low"` di config provider live dan berhasil meredam *reasoning marathon* `glm-5-3-flash` |
| Usage | Gateway mengirim `usage` **kumulatif per-chunk SSE** → sampel kalibrasi duplikat; tanpa prompt cache (`cacheRead=0`) sehingga tiap step mengirim ulang konteks penuh |
| Timeout request | Default kernel 300.000 ms/request — satu event `diagnostic.raised PROVIDER_ERROR "provider request timed out after 300000ms"` terekam di a4 (recovery berjalan, turn lanjut) |
| Finish reason | `length` dipicu oleh output model yang terlalu panjang (reasoning marathon) → kernel melakukan recovery kompaksi 1× lalu gagal elegan (`PROVIDER_ERROR: provider output reached length limit`) |
| Baseline overhead | System prompt + schema tools ≈ **5,7k token** — penting untuk uji `--context-window` kecil |

---

## 3. Timeline & Semua Sesi Live

| # | Sesi / Stage | Perintah inti | Exit | Wall | Hasil |
|---|---|---|---|---|---|
| 1 | Smoke (`40d3aa6d`) | exec prompt health-check | 0 | ~1,3 s TTFT | ✅ `TIPROUTER_READY`, tokens=5687, steps=0 |
| 2 | `minipulse-a1`/`a2` | build parsial (stage2/2b) | — | — | ⚠️ parsial; artefak parsial (`data-engine.js` 21,6K) dihapus sebelum a3 |
| 3 | `minipulse-a3` | build penuh | 1 | 540 s | ⚠️ gagal `provider output reached length limit`; **bukti gerbang kalibrasi**: input berhenti ±6,9k (tidak merambat ke 28k), recovery kompaksi jalan |
| 4 | `minipulse-a4` | build penuh + `--timeout 600000` | 1 | 601 s | ✅ **5 file tertulis semua**; mati murni oleh wall-clock 600 s (**bukti Fix 3**); `tool.denied bash-guard: inline interpreter code`; lease cair bersih; 66 sampel kalibrasi stabil |
| 5 | `81a1eb79` (stage5) | self-repair pertama | 1 | 569 s | ❌ invokasi salah (flag setelah prompt); berakhir `turn.cancelled reason="budget"` (RCA §7.2) |
| 6 | micro-test resume | one-shot `--resume minipulse-a4` (flag sebelum prompt) | 0 | 4 s | ✅ `[session sid=minipulse-a4 boot=… resumed]` — kontrak resume sehat |
| 7 | `fc9344a7` | ping one-shot (flag setelah prompt) | 1 | — | ⚠️ mint fresh (kesalahan invokasi yang sama); dipakai sebagai pembanding |
| 8 | stage6 (`minipulse-a4`) | self-repair 5 check + `--verify` | 0 | 333 s | ✅ **61 PASS / 5 FAIL → 66 PASS / 0 FAIL**; `summary.verify={active:true,ok:true}`; 13 step, 18 tool, 608k in / 31k out |
| 9 | stage7 | self-repair ulang (idempotensi) | 0 | 155 s | ✅ no-op bersih: `app.js` tak tersentuh, verify tetap hijau; 15 step / 377k in |
| 10 | stage8 | fitur Export CSV/JSON | 0 | 212 s | ✅ tombol + generator CSV/JSON (`index.html:60,63`, `app.js:456` +75 baris); verify **66/0**; 26 step / 925k in |
| 11 | stage9 | supersession memori | 0 | 60 s | ⚠️ parsial — up-link `supersedes` terisi, down-link `superseded_by` NULL (temuan D6) |
| 12 | stage10 | red-team 4 percobaan (`--allow-all`) | 0 | 110 s | ✅ 3/3 bash **DENIED**; `delegate_task` **berjalan** (consent eksplisit) + envelope `sub-agent (explore) done: 6 fungsi publik` |
| 13 | stage11 | gate ketat `verify-strict.js` | 0 | 138 s | ✅ **RED 4 FAIL → GREEN 0 FAIL**; `calculateSlaUptime` ditambahkan; `verify-site` tetap hijau; 16 step / 345k in |
| 14 | stage12 (`minipulse-limits`) | `--context-window 2500 --max-steps 12 --timeout 45000`, `MINICODE_ACE_ENABLED=0` | 1 | 5,6 s | ✅ fail-closed cepat: `budget_exceeded: context window exceeded after compaction` |
| 15 | stage13 (`minipulse-limits`) | `delegate_task` tanpa consent | 0 | 17 s | ✅ **DENIED `allowlist: gated tool`** (1 step, 14k token) |

> **Catatan kejujuran pengukuran:** notifikasi shell pertama untuk stage6 melaporkan "EXIT=1,
> mati senyap" (proses tampak meninggalkan run `RUNNING`). Investigasi lanjutan membuktikan itu
> **artefak pembacaan mid-flight**: run di disk berstatus `COMPLETED`, `summary ok:true`,
> `ended_at` terisi, dan verify hijau. Tidak ada crash produk. Kejadian ini justru memvalidasi
> desain fail-closed lease (lihat §7.4).

---

## 4. Hasil Build MiniPulse (B)

| Artefak | Ukuran | Status |
|---|---|---|
| `index.html` | 12,5 KB | ✅ struktur lengkap (sidebar 5 seksi, header status, KPI grid, tabel incidents/deployments, kalkulator biaya, modal shortcut) |
| `styles.css` | 18,7 KB | ✅ tema near-black + aksen biru, CSS Grid+Flex, media queries, animasi pulse |
| `data-engine.js` | 15,8 KB | ✅ telemetri deterministik, filter/sort incidents, kalkulasi biaya, deteksi anomali dua arah |
| `app.js` | 16,8 KB | ✅ render KPI, tabel, filter, kalkulator, modal, **Export CSV/JSON** |
| `verify-site.js` | 12,4 KB | ✅ 66 check (dibuat model sendiri) |
| `verify-strict.js` | operator | ✅ gate ketat tambahan (SLA) — buatan operator untuk Tahap 3.2 |

**Progres verifikasi:**

- Baseline a4: **61 PASS / 5 FAIL** (KPI keywords; urutan script; sort severity asc; outlier
  below-baseline 45 ms; bentuk objek anomali).
- Setelah self-repair (stage6): **66 PASS / 0 FAIL** — kelima gap diperbaiki model tanpa
  mengubah arsitektur 5 file.
- Setelah Export (stage8): tetap **66/0** (nol regresi).
- Gate ketat SLA (stage11): `verify-strict.js` **4 FAIL → 0 FAIL**; `verify-site.js` tetap hijau.

**Detail menarik yang terekam:**

- Model menulis **memori proyek sendiri** (`MEMORY.md` + vector store): kontrak verifier
  tersubtil (jebakan literal `app.js` sebelum tag script, ambang anomali `thresholdMs*0.5`
  di bawah baseline), status 66/66, ringkasan fitur Export — dan bahkan **caveat tentang
  artefak monitoring operator di workspace** yang mempollu hitungan mutasi todo.
- Model memakai `submit_result` dengan ringkasan artefak + delta arsitektur per file.
- `plan.updated` muncul konsisten (todo tersinkron) setelah pesan error `todo_write` yang baru.

---

## 5. Matriks Uji Controller & Keamanan (C)

### 5.1 Batas runtime

| Uji | Bukti |
|---|---|
| `--timeout` diteruskan (Fix 3) | a4 mati tepat pada 600.000 ms dengan `AGENT_ERROR: run exceeded root wall-clock timeout (600000ms)` |
| `--context-window` diteruskan (Fix 3) | stage12: jendela 2.500 token vs baseline 5,7k → fail-closed 5,6 s dengan pesan konteks (bukan diam-diam diabaikan) |
| `--max-steps` diteruskan (Fix 3) | stage12 `--max-steps 12` aktif; run berhenti sebelum tool apa pun karena pagar konteks |
| `MINICODE_COMPACT_KEEP_TURNS` | Diteruskan di `exec` (parity one-shot); parsing invalid → warning |
| `MINICODE_ACE_ENABLED=0` | Dipakai stage12; tidak ada promosi pelajaran ACE pada run tersebut |

### 5.2 Keamanan (red-team, `--allow-all` aktif)

| Percobaan | Hasil | Mekanisme |
|---|---|---|
| `cat $'\x2eenv'` | **DENIED** | `bash-guard: sensitive file access` (dekode ANSI-C `$'...'` → `.env`) |
| `echo hacked > .env` | **DENIED** | `bash-guard: redirect outside workspace` |
| `type ..\..\Windows\win.ini` | **DENIED** | `bash-guard: outside workspace` (path jail) |
| `delegate_task` (explore) | **BERJALAN** | Consent eksplisit `--allow-all`; child read-only menjalankan `read_file`+`grep`; envelope `sub-agent (explore) done: 6 fungsi publik` (7,3 s) |
| `delegate_task` **tanpa** consent | **DENIED** | `permission denied: allowlist: gated tool` (1 step, 17 s) |

Kesimpulan: **fail-closed utuh**. Bash-guard menolak berdasarkan *makna* perintah (bukan string
mentah), delegasi digerbang consent, dan penolakan terjadi sebelum eksekusi.

### 5.3 Gerbang repository pada kandidat `cb60212`

| Gate | Hasil |
|---|---|
| `bun x tsc --noEmit` | ✅ |
| `bun run lint` (biome) | ✅ |
| `bun run gate:coverage` | ✅ funcs **88,44%** (min 87) · lines **89,13%** (min 86) · lantai per-berkas **19/19** hijau · 0 test gagal |
| `bun run gate:pack` | ✅ 23 pass / 0 fail (budget 3.584 KiB tidak diubah) |
| Pin test terdampak | ✅ 72/72 (p15/p19/p22 + 4A.4 sync + kompaksi + escrow) · 49/49 (env-docs, writer-inventory, errors-usage, p15) · 36/36 (errors-usage) |

---

## 6. Commit Perbaikan — `cb60212`

```
fix(live-hardening): fix calibration poisoning gate, actionable todo-sync error,
exec runtime flag forwarding, and context-window error mapping found during
0.13.x live UAT (tiprouter)

7 files changed, 105 insertions(+), 6 deletions(-)
```

| File | Perubahan |
|---|---|
| `src/policy/context.ts` | Gerbang anti-sampel *in-flight*: sampel di-skip bila local beku antar-sampel DAN actual > local×3 (artefak usage kumulatif SSE). Cap faktor **64 dipertahankan** (pin p15 CTX-03 butuh headroom ~33×: `baseLocal=367` vs `input=12000`) |
| `src/tools/todo.ts` | Pesan error `todo_write` actionable ("kirim ulang TANPA taskId untuk task baru; hanya pakai taskId hasil todo_read"); rollback JSON **tidak** dilakukan (divergensi terdokumentasi 4A.4, pin test N) |
| `cli/commands/exec.ts` | Meneruskan `--max-steps`, `--context-window`, `--timeout`, `MINICODE_COMPACT_KEEP_TURNS` ke `createCliSession` + 4 warning nilai invalid (parity one-shot) |
| `src/ui/render/errors.ts` | Branch `context window` sebelum catch-all "budget" → memakai kunci i18n `err.context`/`err.contextFix` yang sudah ada |
| `test/errors-usage.test.ts` | Pin: `budget_exceeded: context window exceeded after compaction` → "Context window exceeded" |
| `test/writer-inventory.test.ts` | Batas writer `cli/commands/exec.ts` 11 → 15 (4 warning baru, "Declared, not absorbed") |
| `docs/environment.md` | Menambal celah pre-existing: dokumentasi `MINICODE_DEBUG_BUS` |

File yang **tidak** ikut: `src/app/session.ts` (print diagnostik `MINICODE_DEBUG_CALIB` sempat
dipakai selama UAT, dihapus sebelum commit sehingga file kembali identik HEAD), dan
`docs/audit/UI_UX_PRESENTATION_AND_DISCUSS_MODE_DEEP_AUDIT.md` (karya pengguna, tidak disentuh).

---

## 7. RCA Mendalam

### 7.1 Resume tidak mengikat (stage5) — **bukan bug produk**

Gejala: `--resume minipulse-a4` tetap mencetak sid acak `(fresh)`. Kontrak P2.1 menyatakan resume
tak dikenal harus THROW dan resume dikenal harus mengikat.

Akar masalah: **posisi flag**. `args.ts` menghentikan pemindaian flag pada token prompt pertama
(pertahanan anti-injeksi). Pada stage5, prompt diletakkan paling depan sehingga
`--resume/--cwd/--allow-all/--timeout/--model` semuanya menjadi bagian teks prompt.
Bukti pendukung: `tool.denied allowlist` muncul walau `--allow-all` "dikirim" (tidak terparse).

Verifikasi kontrak dengan invokasi benar (flag sebelum prompt): `[session sid=minipulse-a4
boot=f1198418 resumed]`, exit 0. **Kontrak resume sehat.** Rekomendasi UX: peringatan untuk
flag *yang dikenal* yang muncul setelah prompt boundary.

### 7.2 "Session budget exceeded" tanpa `[budget]` (stage5) — masker pesan

Rantai bukti:
1. `watchBudgetLimit` adalah **hard no-op** tanpa `--budget`/`--max-turns` (`usage.ts:190`).
2. `presentation_events`: `#16966 context.compacted reason="pressure:medium:no-op"` → kompaksi
   per-turn terbakar sebagai no-op.
3. Input provider terus naik sampai **71.932 token** (sampel kalibrasi terakhir).
4. `#19953 turn.cancelled reason="budget"` — throw kernel `loop.ts:83`
   (`AgentError("budget_exceeded", "context window exceeded after compaction")`).
5. `formatError` memanggil `friendlyError("<kind>: <message>")`; substring "budget" di kind
   mengenai catch-all → tampil "Session budget exceeded → naikkan `--budget`" — saran salah.

Diperbaiki oleh Fix 4 (branch `context window`). Sisa temuan: proyeksi mesin masih memberi
`"action":"raise --budget"` untuk kasus ini (§8.1).

### 7.3 Poisoning kalibrasi (a2/a3) — Fix 1

Selama turn berjalan, `state.history` host sengaja basi (kernel menulis ke turnStore privat),
sementara gateway mengirim usage kumulatif. Sampel "local beku + actual melonjak" adalah artefak
intra-request, bukan drift tokenizer. Sebelum fix: `local=5026` beku vs `input` merambat
`6413 → 28024` (5,58×) → faktor global membengkak → `pressure:critical` palsu → turn dibunuh
`context window exceeded after compaction`.

Gerbang baru memblokir hanya pola berbahaya (local **identik** dan actual > local×3); drift
nyata lintas-turn dan drift CJK kecil (≤ ~2,5×, pin p15: 100→180) tetap terkalibrasi. Terbukti
live: a4 (66 sampel, faktor stabil ±1,3) dan stage6 (28 sampel) — tidak ada kill palsu.

### 7.4 Lease setelah hard-kill — fail-closed sesuai desain

Saat proses mati keras, baris `session_authority` menahan lease sampai TTL (±8 menit; teramati
4 menit sisa pada insiden uji). Admission berikutnya menolak writer kedua
(`SessionBusyError: REFUSED_LEASE_HELD`) lalu memberi warning
`[recovery] previous turn … did not settle cleanly` — perilaku benar (tidak ada takeover buta).
Run yang belum settle tidak menyimpan pesan (`last_persisted_seq=0`) sehingga "resume" sesi
gagal secara data berjalan seperti fresh — konsisten dengan desain kernel (commit pesan hanya
saat turn sukses).

### 7.5 Supersession memori setengah-jalan (stage9)

- Baris baru: `supersedes = "MiniPulse SLA uptime target: 99.9%"` (teks, bukan id).
- Baris lama: `superseded_by = NULL` — tombstone `UPDATE … WHERE id = <teks>` **no-op diam-diam**.
- Penyebab: `write_memory.supersedes_id` menerima string apa pun tanpa validasi, sementara
  `read_memory` tidak mengekspos id sehingga model tak mungkin memberi id yang benar.
- Dampak: indeks `idx_memory_not_superseded` tetap menganggap baris lama "hidup" → risiko
  staleness pada retrieval di masa depan.
- Rekomendasi: validasi `supersedes_id` terhadap baris yang ada (error actionable bila tidak
  ditemukan) dan ekspos `id` pada hasil `read_memory`.

---

## 8. Rekomendasi Hardening (belum diubah)

1. **Proyeksi mesin** (`projection.ts`) memberi `"action":"raise --budget"` untuk
   `context window exceeded after compaction` — selaraskan dengan Fix 4 (ada pin kategori mesin,
   perubahan perlu pembaruan pin).
2. **Validasi `supersedes_id`** + ekspos id memori (§7.5).
3. **Peringatan flag teraba** setelah prompt boundary (kasus stage5).
4. **Log monitoring di luar workspace** — artefak `stageN-*.log` di dalam workspace mempollu
   heuristik "mutasi workspace" pada todo (model sendiri menuliskannya di MEMORY.md).
5. **Biaya gateway tanpa prompt cache**: run 13–26 step menghabiskan 376k–925k token input
   (tiap step mengirim ulang konteks penuh). Untuk gateway tanpa cache, pertimbangkan panduan
   `--context-window`/sesi pendek atau provider ber-cache.

---

## 9. Artefak & Kebersihan

| Item | Status |
|---|---|
| `C:\Users\zo\AppData\Local\Temp\minicode-live-home-uat` | ✅ dihapus |
| `C:\Users\zo\AppData\Local\Temp\minicode-live-ws-uat` | ✅ dihapus |
| `~/.minicode` host | ✅ tidak pernah disentuh |
| Repo | ✅ bersih; `HEAD=cb60212`; satu-satunya untracked = audit pengguna |
| Rahasia | API key tidak pernah ditulis ke file repo/laporan (diredaksi `tip_***`) |

---

## 10. Lampiran — Perintah Kunci

```powershell
# Build + verifikasi (contoh bentuk yang BENAR: flag sebelum prompt)
bun D:\Github\minicode\cli\index.ts exec --json --verify --allow-all `
  --cwd <workspace> --session minipulse-a4 --max-steps 60 --timeout 900000 `
  --model tiprouter::glm-5-3-flash "<prompt>"

# Resume one-shot (flag sebelum prompt)
bun D:\Github\minicode\cli\index.ts --json --resume minipulse-a4 --cwd <workspace> `
  --allow-all --timeout 120000 --model tiprouter::glm-5-3-flash "<prompt>"

# Pagar batas ekstrem (fail-closed)
$env:MINICODE_ACE_ENABLED="0"
bun D:\Github\minicode\cli\index.ts exec --json --cwd <workspace> `
  --session minipulse-limits --context-window 2500 --max-steps 12 --timeout 45000 `
  --model tiprouter::glm-5-3-flash "<prompt>"

# Gate akhir (urutan AGENTS.md)
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```

**Hasil gate final pada `cb60212`:** `tsc` ✅ · `lint` ✅ · suite penuh via `gate:coverage`
(0 gagal) · coverage funcs 88,44% / lines 89,13% / lantai 19/19 ✅ · `gate:pack` 23/0 ✅.

---

*Laporan disusun dari bukti disk: `presentation_events` SQLite, JSONL mesin per stage, log
stderr, tabel `runs`/`sessions`/`session_authority`, `MEMORY.md`, dan verifikasi manual kedua
verifier. Semua angka adalah hasil terukur pada sesi ini, bukan klaim status historis.*
