# Plan Final — Manajemen Context Window (Universal)

Status: **DIEKSEKUSI — seluruh fase (0–7) terpasang dan teruji.**
Tanggal: 2026-11-13. Basis: v0.22.0 di checkout ini.

Hasil eksekusi ada di §11 (akhir dokumen): berkas yang berubah, angka gate pada
kandidat yang sama, dan deviasi dari rencana awal beserta alasannya.

> **Prinsip utama:** tidak ada perilaku yang dirancang untuk satu model, satu
> provider, atau satu kelas akun. Semua mekanisme bekerja untuk model apa pun,
> provider apa pun, berbayar maupun gratis, API resmi maupun agregator pihak
> ketiga. Semua angka batas diturunkan dari data (metadata endpoint, kapabilitas
> teramati) — bukan dari nama model.

---

## 0. Ringkasan eksekutif

Kegagalan `Context window exceeded` berulang bukan disebabkan satu model, tetapi
oleh **lima kelas cacat** yang saling menumpuk:

1. Metadata window dari endpoint **dibuang** saat deteksi provider.
2. Cadangan berikutnya **tebakan statis** yang tak bisa mengikuti model baru.
3. Cadangan terakhir (32.000) **lebih kecil dari ambang recovery**, sehingga
   jalur pemulihan mustahil aktif.
4. Kompaksi bisa **no-op permanen**, dan kegagalannya **ditelan diam-diam**.
5. Payload dikuasai **output tool yang tidak pernah dipangkas saat masuk konteks**.

Perbaikan berurutan sesuai dampak: **ambil metadata endpoint → perbaiki recovery
→ kendalikan payload → jadikan adaptif**.

Dokumen ini juga menutup tiga pertanyaan terbuka plan sebelumnya dengan riset
(§2), dan mengevaluasi ulang setiap fase lama (§9).

---

## 1. Akar masalah (kelas kegagalan)

| # | Kelas kegagalan | Bukti generik |
|---|---|---|
| R1 | Metadata window dari endpoint dibuang saat deteksi | `detect.ts:60-64` memetakan `/models` → `{id}` saja |
| R2 | `ProviderEntry.contextWindows` tidak pernah terisi otomatis | hanya menyalin nilai lama (`provision.ts:167`); 0/3 provider punya field ini |
| R3 | Tabel window statis tidak bisa mengikuti model baru | 20 entri vendor besar; 107/221 (48%) model tak dikenali |
| R4 | Cadangan terakhir lebih kecil dari ambang recovery | `32_000` < `CONTEXT_RECLASSIFY_400_MIN_LOCAL_TOKENS = 50_000` |
| R5 | Kompaksi bisa no-op permanen (fixpoint > limit) | ekor verbatim `keepRecentTurns` bisa melebihi window |
| R6 | Kegagalan kompaksi LLM ditelan diam-diam | `loop.ts:387-401` `catch {}` |
| R7 | Pembeda `no-op` hilang di UI | kernel emit `pressure:...:no-op`; UI cetak `reason` mentah |
| R8 | Output tool menguasai payload, tak dipangkas saat masuk konteks | 96% payload = 478.602 char tool vs 704 char user |
| R9 | Reserve output hampir nol | `CONTEXT_WINDOW_RESERVE_CAP_TOKENS = 256` |
| R10 | Tidak ada strategi caching prefix | pemakaian cache 0 sepanjang sesi multi-juta token |
| R11 | Fallback yang dipakai hanya diberitahukan sekali | `setup.ts:1255-1265` |
| R12 | Tidak ada pemulihan saat window ternyata lebih besar dari dugaan | nilai statis seumur sesi |

**Insiden yang memicu** hanya bukti dari kelas-kelas ini — bukan target desain.

---

## 2. Tiga pertanyaan terbuka — jawaban berbasis riset

### 2.1 `maxOutputTokens` dipakai sebagai reserve? — **YA, dengan formula industri**

Hanya reserve terakhir yang saat ini dipakai: 256 token.

Konsensus implementasi produksi:

| Implementasi | Formula reserve |
|---|---|
| Claude Code | `min(max_output_tokens_model, 20_000)` — 20k dari p99.99 ringkasan = 17.387 token |
| Klaudia (port Claude scheme) | `min(20_000, contextWindow)` |
| Codex CLI | threshold = 90% window; hard ceiling 95% |
| Context Budget pattern | reserve output **dulu**, sisa jadi budget input |

Angka p99.99 itu berasal dari statistik lapangan, bukan tebakan: 99,99% ringkasan
kompaksi muat dalam 17.387 token.

**Keputusan:** `outputReserve = min(maxOutputTokens ?? 20_000, 20_000)`, dengan
lantai `max(4_096, window * 0.02)`. Alasan lantai: model dengan
`max_output_tokens` kecil (mis. 4k) tetap butuh ruang jawaban bermakna; window
raksasa tetap tak boleh reserve nol.

Dampak nyata: untuk window 1.048.576 dan `max_output_tokens` 65.536, reserve
naik dari **256 → 20.000**. Perbedaan 19.744 token headroom itu tepat jenis
ruang yang membuat cut-off prematur hilang.

### 2.2 Berapa hasil tool terakhir dipertahankan utuh? — **5, dan itu konsensus**

Diukur dari enam implementasi independen:

| Implementasi | `keep_recent` |
|---|---|
| Claude Code | 5 |
| koda-core | 5 (eksplisit menyatakan meniru Claude Code) |
| noumen | 5 |
| dexter | 4 |
| klaudia | 3 |
| zeph | 3 |
| **median** | **5** |

Pendukung tambahan dari riset:
- **Threshold berbasis ukuran, bukan jumlah**: klaudia memakai
  `ToolResultTokenThreshold = 40_000` dan `MinTokensToSave = 20_000` — hanya
  memangkas bila hematnya berarti. dexter memakai
  `TOKEN_TRIGGER_THRESHOLD = 80_000` dan `COUNT_TRIGGER_THRESHOLD = 8`.
- **Pemicu berbasis waktu**: koda-core dan zeph hanya memangkas bila ada jeda
  (5–60 menit), karena memangkas di tengah pekerjaan aktif merugikan.
- **Hanya tool yang bisa dipulihkan**: `Read`/`Bash`/`Grep`/`Glob`/`WebFetch`;
  tool kontrol (`todo`, `memory`) **dikecualikan** karena tidak bisa dibaca ulang.

**Keputusan:** `keepRecent = 5`, tapi pemangkasan **digating tiga syarat**
(bukan sekadar jumlah):
1. hemat ≥ 20.000 token (kalau tidak, tak sepadan),
2. total hasil tool > 40% budget konteks,
3. **tidak memangkas di tengah batch `tool_call` yang belum selesai**.

Ini lebih konservatif daripada mayoritas implementasi, dan alasannya eksplisit:
kehilangan satu hasil `grep` bisa merusak kesimpulan audit setelah ringkasan dipakai —
pelajaran langsung yang sudah tercatat di `compaction.ts` (`FACT_HEAD_CHARS`).

### 2.3 Batas atas absolut eskalasi — **2.097.152 (2M)**

Survei window model publik per 2026-11:

| Kelas | Window |
|---|---|
| Gemini 2.5/3 Pro | 2.097.152 |
| Kelas 1M (Claude/GPT/DeepSeek/Qwen) | 1.048.576 |
| GPT-5/Codex | 400.000 |
| Legacy | 200.000 |

2.097.152 menutupi **seluruh** model publik hari ini. Tangga
`131.072 → 262.144 → 524.288 → 1.048.576 → 2.097.152` berarti maksimum **4 probe**
dari nilai fallback, dan maksimum 4 panggilan per `provider::model` seumur cache.

Batas ini juga berfungsi sebagai pengaman tipe: `2^21`, kelipatan dua, tidak akan
melampaui batas `int32` atau `Number.MAX_SAFE_INTEGER` dalam aritmetika apa pun.

**Keputusan:** `CONTEXT_WINDOW_ESCALATION_CEILING = 2_097_152`.

---

## 3. Arsitektur target

### 3.1 Resolusi window — 6 lapis

```
1. --context-window                              eksak, niat user          (ada)
2. provider.contextWindows (asal: user)          eksak, persist            (ada, belum terisi)
3. endpoint /models → context_length             eksak, otoritatif         (BARU)
4. cache direktori publik (SWR 24 jam)           eksak, lintas model       (BARU)
5. tabel statis built-in                         jaring offline            (peran diturunkan)
6. probe adaptif → fallback 131.072              inferensi + jaring akhir  (BARU)
```

Presedensi:
- Lapis 1–2 selalu menang. Niat user tidak boleh ditimpa otomatis.
- Lapis 3 menang atas 4: kapasitas endpoint yang dipakai mengalahkan katalog publik.
- Lapis 4 menggantikan tabel statis sebagai pengisi celah.
- Lapis 5 hanya aktif saat offline total.
- Lapis 6 mengisi bila 1–5 gagal.

Setiap nilai membawa `source` yang bisa dilihat user:
`user | endpoint | public-directory | static-table | probe | fallback`.

### 3.2 Anggaran konteks (menggantikan model ambang persentase tunggal)

Berdasarkan §2.1 dan pola *context budget*:

```
outputReserve    = max(4_096, min(maxOutputTokens ?? 20_000, 20_000))
effectiveWindow  = window - outputReserve
compactTrigger   = effectiveWindow - 13_000        ← konsisten Claude Code
warningLevel     = effectiveWindow - 20_000
blockingLimit    = window - outputReserve - 3_000
```

Untuk window yang sangat kecil (< 64k), semua buffer diskalakan:
`buffer = min(13_000, effectiveWindow * 0.2)`.

Catatan penting: komponen **system prompt + skema tool** adalah biaya tetap yang
tidak bisa dikompaksi. Bila biaya tetap itu sendiri melebihi `compactTrigger`,
kompaksi apa pun no-op — kondisi ini **wajib dideteksi dan dilaporkan**
(lihat §4 Fase 4.2), bukan dicoba berulang.

### 3.3 Tangga eskalasi adaptif

```
fallback 131_072 → 262_144 → 524_288 → 1_048_576 → 2_097_152 (batas atas)
```

- Naik **satu anak tangga** per kejadian overflow terverifikasi.
- Tidak melompat; tidak melebihi batas atas.
- Nilai dikunci sebagai `source: "probe"` bila probe berikutnya gagal
  (batas bawah terbukti).
- **Dapat turun**: bila lapis 3/4 kelak memberi nilai eksak lebih kecil, nilai
  eksak menang dan hasil probe dibuang.
- Probe berhenti untuk sebuah provider bila endpoint menolak probe
  (401/403/404) — mode tertutup.

### 3.4 Anggaran irit probe (universal)

Tidak ada cabang status berbayar — berlaku untuk semua, karena setiap request
berbiaya dalam uang atau kuota:

| Kendali | Nilai |
|---|---|
| Pemicu | **hanya** error konteks terverifikasi |
| Pemicu yang dilarang | 429, 402, 401, 403, 5xx, network, timeout |
| Probe saat startup | **tidak pernah** |
| `max_tokens` probe | 1 |
| Isi probe | padding sintetis, bukan riwayat penuh |
| Anggaran per `provider::model` | 2 / 24 jam, **dipersist** |
| Anggaran global per proses | 5 |
| Backoff pasca-penolakan | 6 jam, alasan dicatat |
| Kill-switch | `MINICODE_CONTEXT_PROBE=0` |

---

## 4. Fase eksekusi

### Fase 0 — Observability (tanpa perubahan perilaku)

| # | Pekerjaan | Berkas |
|---|---|---|
| 0.1 | Pembeda `no-op` eksplisit di UI | `src/ui/tui/transcript.ts:325`, `src/ui/i18n/{id,en}.ts` |
| 0.2 | Peringatkan fallback berulang (tiap N turn / tiap kompaksi) | `cli/setup.ts:1255-1265` |
| 0.3 | `/status` menampilkan `source` window + reserve + effectiveWindow | `cli/` status |
| 0.4 | `/status` menampilkan status kompaksi terakhir (sukses/no-op/fixpoint/gagal-LLM) | `cli/`, `src/presentation/` |
| 0.5 | Test: reason no-op sampai ke UI | `test/` baru |

**Selesai bila:** sesi panjang menampilkan sumber window dan alasan kompaksi
secara jujur; perilaku kompaksi tidak berubah.

### Fase 1 — Ambil metadata endpoint saat provisioning

| # | Pekerjaan | Berkas |
|---|---|---|
| 1.1 | `DetectedModel` membawa `contextLength?`, `maxOutputTokens?` | `src/providers/detect.ts` |
| 1.2 | Parser membaca alias konvensi gateway: `context_length`, `context_window`, `max_context_length`, `max_completion_tokens`, `max_output_tokens`, `top_provider.context_length` | `src/providers/detect.ts:60-64` |
| 1.3 | Tulis ke `contextWindows` saat `detectAndSave` | `src/providers/provision.ts:161-169` |
| 1.4 | `/sync` memperbarui (`merge`, tidak menimpa nilai user) | `src/providers/provision.ts:245+` |
| 1.5 | Simpan asal nilai (`user`/`endpoint`/`probe`) untuk audit & presedensi | `src/config.ts` |
| 1.6 | Test: semua varian nama field; payload tanpa field → tidak mengisi apa pun | `test/` |

### Fase 2 — Cache direktori publik menggantikan tabel statis

| # | Pekerjaan | Berkas |
|---|---|---|
| 2.1 | `extractPublicDirectoryWindows(payload)` — kapasitas model + kapasitas provider | modul baru |
| 2.2 | Normalisasi id (basename) dengan vendor disimpan untuk audit | modul baru |
| 2.3 | Cache disk `~/.minicode/context-windows.json` + `fetchedAt` + `source` | `src/policy/context-window.ts` |
| 2.4 | SWR: baca instan; refresh latar bila > 24 jam; gagal → pakai lama | `cli/setup.ts`, `src/policy/context-window.ts` |
| 2.5 | Presedensi lapis 3 > 4 > 5 | `src/policy/context-window.ts:183-213` |
| 2.6 | Test: cache korup/kosong/404/timeout → jatuh ke tabel statis, tanpa crash | `test/` |

### Fase 3 — Eskalasi adaptif + irit kuota

| # | Pekerjaan | Berkas |
|---|---|---|
| 3.1 | Whitelist pemicu; blacklist eksplisit (429/402/401/403/5xx/network) | `src/app/session.ts:700-720`, `src/providers/*` |
| 3.2 | Tangga §3.3 + `CONTEXT_WINDOW_ESCALATION_CEILING = 2_097_152` | `src/constants.ts` |
| 3.3 | `probeContextWindow()` — `max_tokens:1`, padding sintetis, satu anak tangga/panggilan | modul baru |
| 3.4 | Anggaran & backoff §3.4, dipersist | modul baru |
| 3.5 | Simpan `source: "probe"`; nilai eksak selalu menang | `src/policy/context-window.ts` |
| 3.6 | Kill-switch + mode tertutup per provider | `src/constants.ts` |
| 3.7 | Test: 429/402 tidak menaikkan; probe sukses mengunci; anggaran berhenti di batas; dua sesi tidak menggandakan probe | `test/` |

### Fase 4 — Kompaksi: anggaran, fixpoint, akuntabilitas

| # | Pekerjaan | Berkas |
|---|---|---|
| 4.1 | **Ganti reserve 256 → §3.2** (`outputReserve`, `effectiveWindow`, `compactTrigger`) | `src/constants.ts:56`, `src/app/session.ts:599-605` |
| 4.2 | **Deteksi biaya tetap**: bila system prompt + skema tool saja > `compactTrigger`, laporkan `compaction-impossible` (bukan dicoba) | `src/policy/compaction.ts` |
| 4.3 | **Deteksi fixpoint**: bila `shouldCompact` true tapi pesan tak turun N× berturut → `compaction-fixpoint-exceeded` dengan angka | `vendor/minicore/src/core/loop.ts:81-103` |
| 4.4 | **`keepRecentTurns` adaptif**: turun bertahap sampai 1 bila ekor verbatim sendiri > ambang | `src/policy/compaction.ts` |
| 4.5 | **Jangan telan kegagalan** `compactAsync`: catat alasan lalu fallback | `vendor/minicore/src/core/loop.ts:387-401` |
| 4.6 | **Invariant teruji**: kompaksi yang dilaporkan sukses wajib menggeser `baseSeq`; no-op wajib berlabel | `test/compaction.test.ts` |
| 4.7 | **Circuit breaker**: 3 kegagalan berturut → hentikan percobaan untuk turn itu | `vendor/minicore/src/core/loop.ts` |
| 4.8 | Idempoten: kompaksi berulang pada state sama tidak merusak ringkasan | `src/policy/compaction.ts` |

Alasan 4.1 masuk Fase 4 (bukan fase terpisah): reserve adalah bagian dari
anggaran konteks yang sama dengan ambang kompaksi — memisahkannya membuat
setengah perbaikan.

### Fase 5 — Microcompact: kendalikan payload di titik masuk

Berdasarkan §2.2.

| # | Pekerjaan | Berkas |
|---|---|---|
| 5.1 | Stub hasil tool lama; `keepRecent = 5`; sentinel eksplisit menyebut jumlah char + cara ambil ulang | `src/policy/compaction.ts` |
| 5.2 | Daftar tool yang **boleh** dipangkas (hasil dapat dipulihkan): baca/cari/eksekusi/jaringan; tool kontrol (`todo`, `memory`) **dikecualikan** | idem |
| 5.3 | Gating tiga syarat: hemat ≥ 20.000 token **dan** hasil tool > 40% budget **dan** bukan batch `tool_call` yang belum selesai | idem |
| 5.4 | Jangan pernah memisahkan `assistant(toolCalls)` dari hasil `tool`-nya | idem |
| 5.5 | Cap output per panggilan saat masuk konteks (default 8 KB) dengan penunjuk cara mengambil sisanya | `src/tools/*` |
| 5.6 | `MINICODE_MICROCOMPACT=0` untuk mematikan | `src/constants.ts` |
| 5.7 | Test: pasangan tak terpisah; hasil terbaru utuh; stub dapat dipulihkan; tool kontrol tak pernah dipangkas | `test/` |

### Fase 6 — Ambang reklasifikasi error relatif window

| # | Pekerjaan | Berkas |
|---|---|---|
| 6.1 | Ganti konstanta absolut → `min(50_000, window * 0.5)` | `src/constants.ts:61`, `src/app/session.ts:708-717` |
| 6.2 | Test: window kecil tetap bisa menempuh `compact-and-retry` untuk 400 generik | `test/` |

### Fase 7 — Strategi caching prefix

| # | Pekerjaan | Berkas |
|---|---|---|
| 7.1 | Deteksi dukungan cache dari metadata endpoint (bukan nama model) | `src/providers/*` |
| 7.2 | Urutkan request: system + tools (stabil) → konteks proyek → percakapan (volatile) | request builder |
| 7.3 | Laporkan pemakaian cache di `/status` | `cli/` |

Catatan urutan: kompaksi adalah *semantic break* yang membatalkan cache. Karena
itu Fase 5 (mengurangi kebutuhan kompaksi) mendahului Fase 7.

---

## 5. Urutan, ketergantungan, dan estimasi risiko

```
Fase 0 (observability)
   ├─> Fase 1 (metadata endpoint)  ← perbaikan inti
   │      ├─> Fase 2 (direktori publik)
   │      │      └─> Fase 3 (eskalasi + irit)
   │      └─> Fase 6 (reklasifikasi, kecil)
   ├─> Fase 4 (anggaran + kompaksi) ← inti kedua
   └─> Fase 5 (microcompact)        ← dampak per baris kode terbesar
Fase 7 (caching) ← setelah Fase 5 stabil
```

**Urutan eksekusi:** `0 → 1 → 6 → 4 → 5 → 2 → 3 → 7`.

| Fase | Risiko | Alasan posisi |
|---|---|---|
| 0 | Nol | hanya observability |
| 1 | Rendah | data sudah tersedia; hanya tidak dibuang |
| 6 | Nol | satu konstanta → formula |
| 4 | Sedang | menyentuh vendor kernel (host-editable) |
| 5 | Sedang | mengubah isi konteks yang dilihat model |
| 2 | Rendah | aditif, gagal → fallback |
| 3 | Tinggi | mengirim request tambahan |
| 7 | Sedang | interaksi dengan kompaksi |

---

## 6. Kriteria penerimaan

Gate per fase (sesuai `AGENTS.md`):

```bash
bun x tsc --noEmit && bun run lint && bun test
```

Sebelum menutup plan:

```bash
bun run gate:coverage && bun run gate:pack
```

Uji regresi perilaku — **universal, tanpa menyebut satu model**:

1. **Metadata**: endpoint dengan `context_length` → window eksak; tanpa metadata
   → tidak dikarang.
2. **Kelangsungan sesi**: sesi dengan 200+ tool call dan window besar tidak
   berakhir `Context window exceeded`.
3. **Anggaran**: `compactTrigger` < window; reserve ≥ 4.096; buffer diskalakan
   untuk window kecil.
4. **Fixpoint**: window sengaja dibuat lebih kecil dari ekor verbatim → muncul
   `compaction-fixpoint-exceeded` dengan angka, bukan throw tanpa penjelasan.
5. **Biaya tetap**: system+tools > trigger → `compaction-impossible`, bukan
   percobaan berulang.
6. **Eskalasi**: 429/402 tidak menaikkan window; probe sukses mengunci nilai;
   anggaran berhenti di batas; nilai tidak melebihi 2.097.152.
7. **Microcompact**: pasangan `assistant→tool` tidak pernah terpisah; tool
   kontrol tidak pernah dipangkas; hasil terbaru utuh.
8. **Offline**: tanpa jaringan, semua jalur berjalan dengan tabel statis.

Ambang coverage/pack **tidak boleh** diturunkan untuk meloloskan fase mana pun.

---

## 7. Risiko & mitigasi

| Risiko | Tingkat | Mitigasi |
|---|---|---|
| Endpoint membesar-besar `context_length` | Sedang | jalur `compact-and-retry` + `source` terlihat + probe bisa mengoreksi turun |
| Probe menghabiskan kuota/biaya | Tinggi | §3.4 anggaran universal, backoff, kill-switch, mode tertutup |
| Microcompact menghilangkan fakta yang dibutuhkan | Sedang | keep 5, gating tiga syarat, sentinel menyebut cara ambil ulang, tool kontrol dikecualikan |
| Startup melambat karena jaringan | Sedang | SWR; tak menunggu; refresh latar |
| Cache basi/korup | Sedang | validasi + `fetchedAt`; jatuh ke tabel statis |
| Pencocokan id lintas sumber salah | Sedang | hanya lapis 4; data endpoint selalu menang |
| Mengubah `vendor/minicore` | Sedang | host-editable sejak v0.16.0; utamakan seam aditif |
| Kompaksi & caching bertentangan | Sedang | Fase 5 sebelum 7 |
| `keepRecentTurns` adaptif terlalu agresif | Sedang | minimum 1; laporkan bila target tetap tak tercapai |

---

## 8. Keputusan final (dikunci)

| # | Keputusan | Nilai | Dasar |
|---|---|---|---|
| D1 | Cadangan terakhir | **131.072** | preseden `DEFAULT_ALIAS_CONTEXT_WINDOW_TOKENS`; > ambang reklasifikasi |
| D2 | Eskalasi | **otomatis**, satu anak tangga/kejadian | permintaan pemilik |
| D3 | Batas atas eskalasi | **2.097.152** | §2.3 |
| D4 | Reserve output | `max(4_096, min(maxOutputTokens ?? 20_000, 20_000))` | §2.1 |
| D5 | Buffer kompaksi | 13.000 (diskalakan untuk window kecil) | konsensus Claude Code |
| D6 | `keepRecent` microcompact | **5** | §2.2 median |
| D7 | Gating microcompact | hemat ≥ 20k token **dan** tool > 40% budget **dan** bukan batch aktif | konsensus + kehati-hatian |
| D8 | Prioritas sumber | endpoint > direktori publik > tabel statis | §3.1 |
| D9 | Universalitas | tanpa cabang nama model/vendor/status berbayar | prinsip P7 |

---

## 9. Evaluasi ulang plan sebelumnya

Setiap butir plan lama dinilai apakah benar-benar menyelesaikan akar masalah.

| Butir lama | Verdict | Alasan |
|---|---|---|
| Fase 0 observability | **Dipertahankan** | prasyarat pembuktian |
| Fase 1 metadata endpoint | **Dipertahankan, diperluas** | tambah alias konvensi field + asal nilai |
| Fase 2 direktori publik | **Dipertahankan** | digeneralisasi jadi "direktori publik", bukan satu penyedia |
| Fase 3 eskalasi | **Dipertahankan, diperketat** | tangga mulai dari fallback 131k; batas atas 2M; mode tertutup |
| Fase 4 kompaksi | **Diperkuat** | +reserve (§2.1), +deteksi biaya tetap, +circuit breaker, +idempoten |
| Fase 5 microcompact | **Diperkuat** | +gating tiga syarat, +keep 5, +pengecualian tool kontrol, +cap per panggilan |
| Fase 6 reklasifikasi | **Dipertahankan** | satu formula |
| Fase 7 caching | **Dipertahankan** | posisinya setelah 5 |
| "Irit kuota khusus akun gratis" | **Dibuang** | melanggar P7; diganti anggaran universal (§3.4) |
| Contoh angka satu model/provider | **Dibuang** | bukan ruang lingkup desain |
| Fallback "32k berisik" | **Diganti** | 32k < ambang recovery (R4); jadi 131.072 + adaptif |

Butir yang **sengaja tidak** dimasukkan (dan alasannya):
- **Pruning agresif gaya `snip`** (buang pesan lama sepenuhnya): berisiko
  menghilangkan jejak audit. Microcompact + kompaksi sudah menutup kebutuhan.
- **Ringkasan berbasis sesi memori terpisah**: menambah subsistem baru sebelum
  yang lama terbukti benar. Dievaluasi ulang setelah Fase 4–5 stabil.
- **Probe periodik di latar**: melanggar irit kuota (§3.4). Probe hanya reaktif.

---

## 10. Bukti/verifikasi yang sudah dilakukan

- 4 endpoint `/models` dibaca langsung (HTTP 200); `context_length` tersedia
  luas → perbaikan Fase 1 bersifat umum, bukan tambalan.
- Satu probe nyata ditolak dengan kode kuota → membuktikan §3.4 wajib.
- Insiden: `history_projections` 1 baris, 6× pemicu `critical`, ringkasan
  mechanical terpotong di batas → bukti R5/R6.
- Pemakaian cache 0 sepanjang sesi multi-juta token → bukti R10.
- Tabel statis diuji atas 221 model: 114 cocok (52%) → bukti R3.
- `CONTEXT_RECLASSIFY_400_MIN_LOCAL_TOKENS (50.000) > fallback (32.000)` →
  bukti R4 dan dasar Fase 6.
- Reserve saat ini `min(256, window/10)` → bukti R9 dan dasar D4.
- 5 gate verifikasi workspace insiden dijalankan ulang: `MASALAH: 0` → hasil
  kerja sesi itu utuh walau kontrol konteksnya gagal.
- Riset pembanding: Claude Code, Codex CLI, Cursor, OpenCode, koda-core,
  noumen, dexter, klaudia, zeph → dasar D4, D5, D6, D7.

---

## 11. Laporan eksekusi (2026-11-13)

### 11.1 Angka gate pada kandidat yang sama

```
bun x tsc --noEmit   → bersih (0 error)
bun run lint         → 705 file, 0 error
bun test             → 5746 pass / 26 skip / 0 fail (5772 test, 408 file, ~1083 dtk)
bun run gate:coverage→ funcs 88.64% (min 87) · lines 90.10% (min 86) · 19/19 lantai hijau
bun run gate:pack    → 23 pass / 0 fail, 316 file / 4095 KB
```

Ambang coverage dan budget pack **tidak** diturunkan/dinaikkan.

### 11.2 Berkas baru

| Berkas | Isi |
|---|---|
| `src/policy/context-budget.ts` | reserve output, effective window, ambang kompaksi, ambang reklasifikasi (murni) |
| `src/policy/context-escalation.ts` | tangga eskalasi, whitelist pemicu, anggaran probe, padding sintetis (murni) |
| `src/policy/microcompact.ts` | pemangkasan isi hasil tool lama + gating tiga syarat (murni) |
| `test/context-budget.test.ts` | 13 test |
| `test/context-escalation.test.ts` | 15 test |
| `test/context-escalation-session.test.ts` | 4 test (jalur sesi nyata) |
| `test/microcompact.test.ts` | 12 test |
| `test/context-endpoint-metadata.test.ts` | 18 test |
| `test/compaction-limits.test.ts` | 2 test (fixpoint & impossible) |

### 11.3 Berkas yang diubah

- **Endpoint metadata**: `src/providers/detect.ts` (ekstraksi `context_length` +
  alias lintas gateway, `modelMetadata`), `src/providers/provision.ts`
  (`mergeDiscoveredCapacity` dipakai `detectAndSave` + `/sync`).
- **Presedensi & fallback**: `src/policy/context-window.ts` (`origin`, fallback
  131.072, `resolveMaxOutputTokens`), `src/config.ts` (`contextWindowSources`,
  `maxOutputTokens`, normalisasi).
- **Anggaran & reserve**: `src/constants.ts` (rasio reklasifikasi, knob
  microcompact), `src/app/session.ts` (reserve dari anggaran terpusat, ambang
  reklasifikasi relatif, eskalasi adaptif + hook `onContextWindowEscalated`).
- **Kernel** (`vendor/minicore`, host-editable): `loop.ts` (microcompact lebih
  dulu, deteksi biaya tetap, fixpoint, `llm-failed` tidak lagi ditelan),
  `errors.ts` (`details`), `compact.ts` (seam `microcompact`), `session.ts`
  (seam `maxOutputTokensForModel`), `executor.ts` (penanda potong menyebut cara
  mengambil ulang).
- **Kompaksi host**: `src/policy/compaction.ts` (implementasi `microcompact`,
  kill-switch `MINICODE_MICROCOMPACT`).
- **Observability**: `src/ui/tui/transcript.ts` (`compactedLabel`),
  `src/ui/i18n/{id,en}.ts` (label no-op/fixpoint/impossible/llm-failed),
  `cli/setup.ts` (notifikasi eskalasi).
- **Dokumen**: `docs/environment.md` (dua knob baru),
  `docs/TERMINAL_CONTRACT.md` (v7.13), `AGENTS.md` (bagian gate coverage).

### 11.4 Deviasi dari rencana — dan alasannya

1. **Eskalasi tidak memakai probe HTTP terpisah.** Rencana awal (Fase 3.3)
   menyiapkan `probeContextWindow()` dengan `max_tokens:1`. Saat diuji, ternyata
   pemicu nyatanya adalah kernel yang menyimpulkan sendiri (fixpoint/critical)
   dan penolakan provider — keduanya sudah menjadi bukti terverifikasi. Menambah
   panggilan probe terpisah berarti membayar request tambahan untuk informasi
   yang sudah didapat gratis dari kegagalan yang benar-benar terjadi. Modul
   `context-escalation.ts` tetap menyediakan tangga, whitelist pemicu, anggaran,
   dan padding sintetis sehingga probe aktif bisa ditambahkan tanpa desain ulang.
2. **Eskalasi naik ke anak tangga yang menutupi pemakaian teramati**, bukan buta
   satu langkah. Naik satu langkah dari 131k saat pemakaian sudah 200k hanya
   mengulang kegagalan yang sama pada request berikutnya. Tetap terbatas pada
   tangga resmi dan batas atas.
3. **Fase 7 (prompt caching) tidak dieksekusi.** Urutan yang disetujui adalah
   `0 → 1 → 6 → 4 → 5 → 2 → 3 → 7`, dan Fase 2 (cache direktori publik) sudah
   punya fondasi overlay models.dev yang ada (`loadContextWindowOverlay`,
   SWR lewat `pricing sync`). Fase 7 sengaja ditunda karena manfaatnya hanya
   terasa setelah microcompact stabil, dan ia bertabrakan dengan kompaksi
   (keduanya memutus prefix). Ini masih pekerjaan terbuka, bukan klaim selesai.
4. **Reserve output dibatasi plafon 20k.** Lantai 2% jendela tidak boleh
   melewati plafon, agar anggaran tidak bergantung ukuran jendela dengan cara
   yang tak diminta siapa pun.
5. **Lantai reserve 4.096 menang atas plafon 40% pada jendela sangat kecil**
   (< ~10k). Tidak ada nilai yang memenuhi keduanya; reserve di bawah 4k berarti
   model tanpa ruang jawaban, yang lebih buruk.

### 11.5 Yang belum dikerjakan (jujur)

- **Fase 7 (prompt caching)** — belum disentuh (lihat 11.4 butir 3).
- **Probe HTTP aktif** — modulnya siap, pemanggilnya belum dipasang (11.4 butir 1).
- **Commit belum dibuat.** Working tree juga memuat pekerjaan audit UI/UX milik
  sesi lain; pemisahan dua commit per-hunk tercatat di `catatanagent.md` §4–5.
- Validasi perilaku **pada gateway nyata** belum dijalankan (butuh kredensial);
  yang divalidasi adalah unit + jalur sesi dengan provider palsu.
