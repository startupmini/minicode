# MiniCode Full-System Dogfooding & Remediation Report

Tanggal: 2026-11-06 (Asia/Jakarta)
Target evaluasi: MiniCode saat menghasilkan aplikasi Electron MiniChat
Keputusan scope: MiniChat hanya fixture; tidak ada source MiniChat yang diubah.

## Ringkasan

Dogfooding MiniChat sudah cukup untuk menguji alur pembuatan lintas tahap MiniCode. Saya berhenti mengejar kelengkapan fitur MiniChat dan memusatkan pekerjaan pada masalah MiniCode yang tampak selama generation, persistence, tool execution, dan stress test.

Tiga temuan P1 baru telah diperbaiki pada working tree: konfigurasi ripgrep yang dapat menjalankan preprocessor, salah hitung context-window lintas request, dan crash host akibat EPIPE pada transport MCP. Full suite dan coverage lulus pada kandidat ini. Package gate masih merah khusus ukuran, dan stress shadow-git gagal pada snapshot awal repositori 2.000 file. Karena itu audit belum dapat disebut selesai atau release-ready.

Kandidat yang diuji: branch main, HEAD 3e4af248e87d73497b770129f565843d5f5040ef. Perubahan pada laporan ini adalah perubahan working tree setelah HEAD; tidak termasuk dalam commit tersebut. Origin/main menunjuk HEAD yang sama ketika diperiksa. Tidak ada klaim bahwa working tree sudah dipush.

## Cakupan audit

| Area | Bukti yang diperiksa | Status |
|---|---|---|
| Agent loop dan execution lifecycle | Dogfood tahap 1–7, tool start/completion/deny, checkpoint dan shutdown paths, full test suite | Diuji pada alur nyata; edge provider dan scale tertentu masih terbuka |
| Main agent, sub-agent, orchestration | Task/session traces dari dogfood, lifecycle dan ownership tests, audit P2/P2.3 terdahulu | Cakupan kode memadai untuk jalur teruji; semantik producer FAILED/RETRYING tetap keputusan produk |
| TaskGraph, scheduler, concurrency | Unit/integration suite dan laporan P2/P2.3; beberapa sesi dogfood | Tidak ada claim stress concurrency penuh untuk daemon nyata |
| Session lifecycle dan persistence | SQLite/session tests; Electron restart UAT dengan user-data-dir eksplisit | Jalur lokal teruji; auto-resume daemon setelah restart memang tidak didukung |
| Context, compaction, token | Usage collector, watcher, request berulang dengan usage provider, dogfood token traces | False cutoff diperbaiki; cache gateway dan provider tanpa telemetry belum diverifikasi |
| Provider abstraction, switching, retry, streaming | Live TipRouter dogfood dan fake benchmark | Streaming/runtime terpakai; identitas alias provider belum terverifikasi independen |
| Tool dispatch dan permission | Full suite, live tool traces, approval/work-mode tests | Jalur utama diuji; tidak semua platform/process boundary nyata |
| Filesystem, shell, process, network, MCP | bash fuzz, grep security probe, MCP adversarial HTTP, MCP stdio regression | Temuan diperbaiki; Docker nyata, race symlink Windows, dan post-accept stdio disconnect tetap terbuka |
| UI/TUI dan runtime | Generated Electron MiniChat, 83/83 test proyek fixture, persistence UAT; UI/TUI tests | MiniChat Settings menunjukkan celah validasi runtime; manual TUI UAT MiniCode belum dilakukan |
| Performance, resource, observability | Long-running dogfood traces, audit:harness, fake benchmark, shadow-git 2.000 file | Shadow snapshot gagal pada skala tersebut; tidak cukup bukti untuk menyimpulkan sebab tepat |
| Build, packaging, compatibility | typecheck, lint, full test, coverage, Bun build, pack gate | Build/test/coverage lulus; pack gate gagal size-only; variasi OS tidak seluruhnya diuji |

Area yang tidak dianggap tertutup: Windows symlink/junction race, Docker daemon nyata, MCP stdio disconnect setelah request diterima, global updater installation/rollback, kualitas provider live, manual TUI UAT MiniCode, gateway cache, serta semua jalur daemon restart yang sengaja tidak auto-resume.

## Peta arsitektur runtime yang diperbarui

    cli/index.ts + cli/setup.ts
      composition root: konfigurasi, dependency injection, lifecycle session
      |
      +--> MiniCore agent loop
      |      context assembly / compaction / usage / provider stream
      |      step + tool-call lifecycle / abort / completion
      |
      +--> policy + tool dispatch
      |      work mode + permission ceiling + approval barrier
      |      filesystem / shell / git / grep / network / MCP / sub-agent tools
      |
      +--> session ownership
      |      TaskStore / TaskGraph / scheduler / daemon adapters
      |      checkpoint + shadow-git / journal / SQLite persistence
      |
      +--> event flow
             events + traces + usage
             reducer / presentation
               +--> alternate-screen TUI
               +--> shell-first non-interactive output
               +--> JSON / ACP consumers

Sub-agent session factory dan interaksi UI masuk melalui injection composition root. Session/persistence dan checkpoint bukan bagian dari provider; keduanya mengikuti event lifecycle runtime. MiniChat berada di luar arsitektur MiniCode dan hanya menjadi hasil uji.

## Dogfood MiniChat: bukti MiniCode, bukan pekerjaan MiniChat

| Tahap | Session | Hasil MiniCode | Catatan evaluasi |
|---|---|---|---|
| 1 | 052fa7c360304e1d90e3453735ca11ef | Exit 0; 401 dtk; 515.190 token; 32 tool start, 28 complete, 4 failed, 1 denied | Proyek dapat dihasilkan, tetapi tool retry/failure menambah biaya |
| 2 | b1a58a3d85014ce5bf052b3f7986d082 | Gagal setelah 546 dtk; 46 start, 2 failure, 2 denial | Default window 128k dan no-op compaction/budget stop menjadi temuan historis dogfood |
| 3 | 123e012fc6e34c60a486098d0f9a2678 | Gagal setelah 623 dtk; 43 start, 2 failure, 2 denial | Pola timeout dan pemulihan belum efisien |
| 4 | ea453972166b4f12a29c184c6de857dd | Gagal setelah 362 dtk; false context cutoff | Cutoff berasal dari akumulasi lintas request; diperbaiki sebagai AUDIT-FS-CTX-001 |
| 4 replay | a44d3003fecd4e269200556e7287c3ec | max_steps setelah 846 dtk; 74 start, 73 complete | Tidak ada cutoff context pada replay |
| 5 | ba9d244a3aac4fb787e4327c6af449d8 | Selesai setelah 395 dtk; 1.508.476 token; 41 start, 40 complete, 1 fail, 1 deny; durable seq 74 | Keberhasilan generation tidak berarti semua acceptance behavior teruji |
| 6 | e0b862c27db2417fa958cf84e215e239; cbb9fa88af934e7e821d306fddd46542 | max_steps; satu replay menguji stream ownership, terminal gate, save queue, hydration | App fixture 63/63 test pada checkpoint terkait |
| 7 | 5889d7ad95534edf928cb60120468cba; ee1733301cb34c46ac7fb2063c0e8f42; e25ee660bf9c4bd38f760768b33d75ee | max_steps; revisi Markdown/highlight/copy IPC; test fixture sempat salah lalu diperbaiki | Pada final fixture 83/83 test lulus, tetapi runtime Settings tetap tidak berfungsi |

Dogfood menghabiskan banyak token dan beberapa sesi berakhir karena max_steps/timeout. Ini adalah observasi efisiensi, bukan bukti tunggal bahwa runtime MiniCode salah: task besar, provider planning, dan durasi model juga berkontribusi. Klaim performa produksi lintas provider tidak dibuat.

## Hasil verifikasi kandidat

| Pemeriksaan | Hasil |
|---|---|
| bun x tsc --noEmit | Lulus, exit 0 |
| bun run lint | Lulus, exit 0 |
| bun test | 5.526 pass, 19 skip, 0 fail; 389.893 expectations; 385 file |
| bun run gate:coverage | Lulus; funcs 88,28% (minimum 87), lines 89,61% (minimum 86), modul kritis 19/19 |
| bun run gate:pack | Gagal size-only: 3.972 KiB terhadap budget 3.920 KiB |
| bun run audit:harness | 60 pass, 0 fail, 2 advisory |
| bun build --target=bun cli/index.ts | Lulus, exit 0 |
| bun run gate:slow | Gagal pada extreme-shadow-git setelah bash fuzz lulus; lihat AUDIT-CHECKPOINT-SCALE-001 |
| bun run extreme:mcp | 67 pass, 0 fail |

Paket HEAD sebelum perubahan ini sudah terukur 3.967,40 KiB, sekitar 47,40 KiB di atas budget. Perubahan kandidat menambah sekitar 4,33 KiB; gate saat ini tetap gagal ukuran, bukan correctness. Budget tidak dinaikkan.

### Stress test terinci

- bash fuzz: 7.773 varian berbahaya, 0 bypass; 1.443 varian benign, 0 overblock.
- extreme-shadow-git: repo uji 2.000 file. snapshot penuh mengembalikan null setelah 423.812 ms; snapshot berikutnya setelah satu perubahan terukur 2.518 ms. Harness kemudian fatal saat mengakses base.tree tanpa guard. Script menghapus root uji miliknya sendiri. Bagian mixed changes, concurrency, restore race, nama ekstrem, ignore, cap manifest dan integritas Git tidak tercapai pada run ini.
- extreme MCP adversarial: 67 pass, 0 fail pada server diam, SSE flood, body besar, redirect metadata, host privat, protocol, secret redaction, malformed response, dan status HTTP.

Angka shadow-git adalah hasil pada Windows di lingkungan ini. Sebab tepat mengapa snapshot mengembalikan null belum teridentifikasi; durasi yang jauh lebih panjang dari batas yang diharapkan juga membuat observability timeout subprocess perlu diperiksa. Dampak production fallback dijelaskan sebagai risiko dengan bukti parsial, bukan sebagai reproducer end-to-end.

## Finding registry gabungan

Status dan checkpoint finding lama dipertahankan. Tabel berikut adalah roll-up, bukan pengganti bukti lengkap pada laporan kanonik yang dirujuk.

### Finding lama

| ID stabil | Status checkpoint yang dipertahankan | Sumber kanonik |
|---|---|---|
| F-GATE-1, F-GATE-2 | CLOSED / VERIFIED | P0 closure verification report |
| F-GATE-3 | DEFERRED pada checkpoint lama; isu lama 3.840 KiB kemudian dicatat sebagai carry-forward size-only | P0 closure dan final integration reports |
| F-AGENT-1, F-TASK-1, F-DAEMON-1, F-APPROVAL-1, F-ENV-1, F-MEM-1 | Resolved/verified menurut laporan penutupan yang lebih baru; status historis masing-masing tetap terikat checkpoint | P0/P1 closure reports |
| F-P1-HANDOFF-1 | FIXED_VERIFIED | P1 correctness report |
| F-P1-MEM-1, F-P1-MEM-2 | FIXED_VERIFIED | P1 correctness report |
| F-P1-MEM-3 | PARTIAL | P1 correctness report |
| F-P1-OBS-1 sampai F-P1-OBS-4 | FIXED_VERIFIED | P1 correctness report |
| F-P1-UI-1 sampai F-P1-UI-6 | FIXED_VERIFIED | P1 correctness report |
| F-P1-CTX-1 sampai F-P1-CTX-3 | FIXED_VERIFIED | P1 correctness report |
| F-P1-CTX-4 | UNVERIFIED: gateway cached_tokens | P1 correctness report |
| F-P1-TASK-1, F-P1-TASK-2 | PARTIAL pada checkpoint P1; dibedakan dari pembaruan R-OP-06 yang lebih baru | P1 correctness + P2.3 reports |
| F-P1-PACK-1 | NOT_FIXED, efisiensi size-only | P1 correctness report |
| R-OP-01 | FIXED_VERIFIED | P2.3 report |
| R-OP-02 | NOT_FIXED; MCP subscriptions/notifications unsupported | P2.3 report |
| R-OP-03 | Hosted reconstruction FIXED_VERIFIED; auto-resume NOT_APPLICABLE/by design | P2.3 report |
| R-OP-04, R-OP-05 | UNVERIFIED: manual TUI UAT dan gateway cache | P2.3 report |
| R-OP-06 | FIXED_VERIFIED | P2.3 report |
| R-OP-07 | NOT_FIXED, keputusan produk; belum ada producer FAILED/RETRYING | P2.3 report |
| R-OP-08 | FIXED_VERIFIED melalui quarantine memory legacy | P2.3 report |
| R-OP-09 | PARTIAL, size-only | P2.3 report |
| R-OP-10 | FIXED_VERIFIED | P2.3 report |
| R-P1-01, R-P1-02 | UNVERIFIED: manual TUI UAT, gateway cache | P2 report |
| R-P1-03, R-P1-04 | NOT_FIXED pada checkpoint P2; claim/merge/cancel events dan producer FAILED/RETRYING | P2 report |
| R-P1-05 | FIXED_VERIFIED: memory supersession concurrency | P2 report |
| R-P1-06 | PARTIAL: fuzzy cleanup legacy memory | P2 report |
| R-P1-07 | NOT_FIXED, efisiensi size-only | P2 report |
| F-INT-01 sampai F-INT-05, F-INT-09 | FIXED_VERIFIED | Final integration report |
| F-INT-06 | ACCEPTED_LIMITATION | Final integration report |
| F-INT-07 | UNRESOLVED, skrip fase tidak terpakai | Final integration report |
| F-INT-08 | NOT_APPLICABLE; konten benar | Final integration report |
| F-INT-10 | ACCEPTED_LIMITATION pada budget lama; ukuran adalah efisiensi | Final integration report |
| F-INT-11 | CARRIED residuals | Final integration report |
| UI-RENDER-01, UI-RENDER-02, UI-COMPAT-01, UI-ARCH-01, UI-HARNESS-01 | Remediated/verified | UI/UX remediation report |
| UI-TEST-01, UI-PERF-01 | PARTIAL | UI/UX remediation report |
| UI-VISUAL-01 | PARTIAL; screen-reader UAT belum diverifikasi | UI/UX remediation report |
| VER-01 sampai VER-06 | DEFERRED / UNCHANGED | UI/UX remediation report |

Rujukan penuh dan checkpoint: docs/audit/P0_FINAL_CLOSURE_VERIFICATION_REPORT_2026-11-04.md, docs/audit/P1_CORRECTNESS_OBSERVABILITY_UX_REPORT_2026-11-05.md, docs/audit/P2_OPERATIONAL_QUALITY_ARCHITECTURE_REPORT_2026-11-05.md, docs/audit/P2_3_OPERATIONAL_CLOSURE_AND_FINAL_INTEGRATION_REPORT_2026-11-05.md, docs/audit/FINAL_INTEGRATION_AND_REPOSITORY_CONSOLIDATION_REPORT_2026-11-05.md, dan docs/audit/UI_UX_REMEDIATION_FINAL_REPORT.md. Jangan menafsirkan roll-up ini sebagai perubahan status historis.

### Temuan baru pada kandidat ini

| ID stabil | Severity | Status kandidat | Ringkasan |
|---|---|---|---|
| AUDIT-FS-TOOL-001 | P1 / HIGH | FIXED_VERIFIED | ripgrep config dan credential env dapat memicu command preprocessor saat grep |
| AUDIT-FS-CTX-001 | P1 / HIGH | FIXED_VERIFIED | watcher membandingkan usage kumulatif dengan batas window per request |
| AUDIT-MCP-TRANSPORT-001 | P1 / HIGH | FIXED_VERIFIED | EPIPE dari child MCP dapat menjadi uncaught host exception |
| AUDIT-DOC-ARCHMAP-001 | LOW | FIXED_VERIFIED | architecture map kehilangan sse-bounds.ts |
| AUDIT-HARNESS-CLEANUP-001 | LOW | FIXED_VERIFIED | cleanup fixture Windows sesekali gagal EBUSY |
| AUDIT-HARNESS-TIMEOUT-001 | LOW | FIXED_VERIFIED | timeout test subprocess terlalu pendek pada full-suite run |
| AUDIT-CHECKPOINT-SCALE-001 | P2 / MEDIUM | OPEN, evidence parsial | snapshot shadow-git gagal pada run awal 2.000 file; turn dapat berjalan tanpa checkpoint |
| AUDIT-CHECKPOINT-FALLBACK-001 | P2 / MEDIUM | FIXED_VERIFIED | kegagalan snapshot repo Git tidak lagi diam-diam turun ke fallback terbatas 200 file |
| AUDIT-DOGFOOD-UI-001 | P2 / MEDIUM | OPEN | generated Settings control tidak memiliki handler; test/build tidak menemukan masalah runtime ini |
| AUDIT-DOGFOOD-PROVIDER-001 | P2 / MEDIUM | UNVERIFIED | nama model yang diminta dan alias provider yang dilaporkan berbeda |
| AUDIT-DOGFOOD-EFFICIENCY-001 | P2 / MEDIUM | OBSERVATION, bukan defect terkonfirmasi | beberapa sesi task panjang berakhir max_steps/timeout dan memakai token sangat besar |
| AUDIT-HARNESS-STRESS-001 | LOW | OPEN | extreme-shadow-git tidak menjaga hasil null dan berhenti sebelum sebagian besar skenario |

#### AUDIT-FS-TOOL-001 — P1/HIGH — FIXED_VERIFIED

- Lokasi: src/tools/grep.ts, probe regresi test/grep-security.test.ts.
- Invariant: workspace tidak boleh mengendalikan executable/preprocessor grep atau mewarisi credential proses agent.
- Bukti: reproducer sebelum fix menggunakan RIPGREP_CONFIG_PATH dengan --pre untuk menulis marker dan membaca dummy OPENAI_API_KEY. Sesudah fix, grep memakai executable tepercaya, --no-config, menghapus RIPGREP_CONFIG_PATH dan memakai sanitizeSpawnEnv. Regression test memastikan marker tidak dibuat dan credential tidak dipasok.
- Dampak: pencarian workspace dapat mengeksekusi preprocessor yang dikonfigurasi pengguna/repo serta mengekspos credential ke child process.
- Evidence status: reproducer dan regresi lokal terverifikasi; full suite kandidat lulus.
- Missing tests: binary integrity/PATH TOCTOU lintas platform, fallback tanpa ripgrep pada POSIX.
- Acceptance criteria: konfigurasi ripgrep tidak memicu perintah saat tool grep dipanggil; child environment tidak membawa secret; resolved executable tepercaya.
- Dependency: tool dispatch → executable resolution → child environment/config.
- Residual risk: integritas file binary di host dan semua variasi platform belum diuji.

#### AUDIT-FS-CTX-001 — P1/HIGH — FIXED_VERIFIED

- Lokasi: src/policy/usage.ts dan cli/setup.ts; regresi test/context-window-request-accounting.test.ts.
- Invariant: context window berlaku untuk satu request provider, bukan jumlah token seluruh sesi/turn.
- Bukti: request pertama 990.000 input + 5.000 output; request kedua 10.000 input + 18.058 output. Total lintas request mencapai 1 juta, sedangkan request kedua memakai 28.058 token. Watcher lama melakukan cutoff palsu. Implementasi kini membaca snapshot request aktif dan mengabaikan state saat belum ada telemetry request.
- Dampak: turn valid dapat dihentikan sebelum selesai ketika ada beberapa request/kompaksi dalam satu turn.
- Evidence status: regression test dan full suite lulus.
- Missing tests: provider tanpa usage telemetry dan variasi batas request/stream yang tidak mengirim event usage.
- Acceptance criteria: tidak ada cutoff berdasar kumulatif; request aktif yang melampaui window tetap memicu stop sekali.
- Dependency: provider usage events → usage collector → context watcher → agent cancellation.
- Residual risk: provider yang tidak melaporkan usage tidak dapat diukur akurat oleh watcher ini.

#### AUDIT-MCP-TRANSPORT-001 — P1/HIGH — FIXED_VERIFIED

- Lokasi: src/mcp/transport.ts dan test/coverage-gaps.test.ts.
- Invariant: request ke child MCP yang sudah keluar harus ditolak sebagai error terkelola; EPIPE tidak boleh menjadi uncaught exception host.
- Bukti: full-suite run sebelumnya gagal dengan EPIPE saat test mengirim request setelah child process.exit(0). Transport kini menangani stdin error, menolak write setelah closed/exit/destroyed, membersihkan antrean dan pending request, dan tidak menunggu timeout close jika child sudah keluar. Full-suite kandidat sekarang 5.525 pass, 0 fail.
- Dampak: crash seluruh proses MiniCode pada race normal antara server MCP berhenti dan request berikutnya.
- Evidence status: failure lama direproduksi pada suite; regression dan full suite kandidat lulus.
- Missing tests: disconnect tepat setelah server menerima request pada stdio nyata dan semua versi Windows/macOS/Linux.
- Acceptance criteria: disconnect selalu settle semua pending request dan tidak menghasilkan uncaught error; shutdown tidak menunggu timeout yang tidak perlu.
- Dependency: child process stdin/stdout → MCP request ownership → session shutdown.
- Residual risk: disconnect post-accept stdio tetap belum diverifikasi pada kondisi vendor/OS nyata.

#### AUDIT-CHECKPOINT-SCALE-001 — P2/MEDIUM — OPEN, EVIDENCE PARSIAL

- Lokasi: src/session/shadow-git.ts snapshotTree; src/session/checkpoint.ts beginTurnSnapshot dan snapshotWorkspace; cli/setup.ts turn:started/turn:completed.
- Invariant: sesi di Git repository harus mempunyai checkpoint pre-turn yang lengkap atau menyatakan checkpoint gagal dengan jelas.
- Bukti runtime: extreme-shadow-git pada Windows membuat 2.000 file, lalu snapshotTree mengembalikan null setelah 423.812 ms. Snapshot berikutnya setelah satu perubahan memerlukan 2.518 ms. Harness gagal saat dereference base.tree. Tidak ada bukti yang cukup untuk menentukan apakah add, write-tree, filter discovery, timeout, antivirus, atau faktor lain menyebabkan null.
- Bukti jalur produksi: snapshotTree tetap mengembalikan null pada stress run. Perbaikan sesudahnya memeriksa apakah cwd masih repo Git; jika ya, beginTurnSnapshot mengembalikan mode unavailable dan cli/setup.ts mengeluarkan warning saat turn selesai. Fallback snapshotWorkspace 200 file hanya tetap berlaku untuk workspace non-Git.
- Dampak: pada repo besar, undo/redo untuk turn masih dapat tidak tersedia dan turn tetap berjalan; penyebab snapshot lambat/gagal belum diketahui.
- Evidence status: snapshot null dan durasi terkonfirmasi; fallback parsial kini dicegah dengan regression test dan full suite. Tidak ada klaim bahwa penyebab performa sudah diperbaiki.
- Missing tests: reproducer lewat beginTurnSnapshot + turn completion yang membuktikan checkpoint kosong/partial; diagnostik subcommand git yang gagal; variasi cold/warm filesystem; skenario lebih dari 200 dirty files.
- Acceptance criteria tersisa: cold start 2.000 file memiliki batas waktu terukur dan diagnosa spesifik; kegagalan yang dapat dipulihkan tidak membuat task berjalan tanpa kemampuan undo tanpa pemberitahuan; rollback test membuktikan seluruh touched paths tercakup.
- Dependency: Git process/config → shadow snapshot → fallback snapshot → turn completion → undo/redo.
- Residual risk: performa sensitif pada host, filesystem, antivirus, jumlah file, dan konfigurasi Git; akar sebab masih belum terisolasi. Jika isGitRepo sendiri gagal mengenali repo yang rusak/tidak dapat diakses, jalur klasifikasi tersebut belum dibuktikan.

#### AUDIT-CHECKPOINT-FALLBACK-001 — P2/MEDIUM — FIXED_VERIFIED

- Lokasi: src/session/checkpoint.ts beginTurnSnapshot; cli/setup.ts turn:completed; test/shadow-git.test.ts.
- Invariant: repo Git yang gagal dibuatkan shadow snapshot tidak boleh diam-diam menerima snapshot manual yang dibatasi 200 path dan tampak seperti checkpoint normal.
- Bukti: test mengubah repo fixture menjadi core.bare, sehingga Git tetap mengenali repo tetapi git add gagal. beginTurnSnapshot kini menghasilkan mode unavailable dengan reason git-snapshot-failed, bukan mode files parsial. Test shadow-git 23/23 pass dan full suite kandidat 5.526 pass, 0 fail. Production turn completion menulis warning bahwa undo/redo tidak mencakup turn tersebut.
- Dampak yang dicegah: checkpoint parsial atau kosong yang tampak valid dan memberi keyakinan undo palsu.
- Evidence status: jalur helper dan hasil discriminated status terverifikasi; warning production diperiksa pada jalur source, belum ada UAT terminal khusus pesan warning.
- Missing tests: integration test yang mengirim turn:completed dan menangkap warning; kegagalan rev-parse saat direktori .git ada tetapi rusak.
- Acceptance criteria: kegagalan snapshot pada repo Git dinyatakan unavailable; workspace non-Git tetap menggunakan snapshot manual; pengguna mendapat warning ketika undo/redo tak tersedia.
- Dependency: snapshotTree → beginTurnSnapshot → turn lifecycle → warning/output.
- Residual risk: warning muncul pada akhir turn, bukan sebelum model mulai; deteksi repo yang rusak/tidak terbaca belum sepenuhnya dibuktikan.

#### AUDIT-DOGFOOD-UI-001 — P2/MEDIUM — OPEN

- Lokasi fixture MiniChat: src/renderer/app.js pada checkpoint dogfood Stage 7.
- Invariant evaluasi MiniCode: lulus build dan unit test tidak cukup untuk menyatakan behavior UI yang diminta selesai bila acceptance criteria mencakup interaksi.
- Bukti: Settings button tampak di UI tetapi tidak punya handler/reference; markup dialog tersembunyi tidak punya styling yang membuatnya tampil. Project fixture melaporkan 83/83 test lulus.
- Dampak: MiniCode dapat menyatakan task UI selesai walau interaksi utama no-op. Ini gap validasi/runtime acceptance MiniCode; bukan permintaan untuk memperbaiki MiniChat.
- Evidence status: perilaku diamati pada generated app; file fixture tidak diubah oleh audit ini.
- Missing tests: smoke interaction Electron yang membuka dialog, validasi persistence/close, dan acceptance check yang mengikat tombol ke handler.
- Acceptance criteria: pada task UI behavior, hasil MiniCode harus diuji lewat runtime smoke yang mengaktifkan kontrol utama atau menyatakan UAT belum dilakukan.
- Dependency: instruksi pengguna → model menghasilkan UI → project tests/build → runtime acceptance.
- Residual risk: static analyzer tidak dapat menyimpulkan semua maksud UI dari source tanpa acceptance scenario terstruktur.

#### AUDIT-DOGFOOD-PROVIDER-001 — P2/MEDIUM — UNVERIFIED

- Lokasi: provider alias/routing di luar kontrol MiniCode; terlihat di completion metadata sesi Stage 1.
- Invariant evaluasi provider: model yang dijalankan harus dapat diidentifikasi sebelum hasil dogfood diatribusikan ke MiniCode atau model tertentu.
- Bukti: request meminta deepseek-v4.1-flash-1017 melalui TipRouter; response metadata mencatat ali/deepseek-v4-pro-0813.
- Dampak: kualitas planning, streaming, latency dan biaya tidak bisa diatribusikan secara pasti.
- Evidence status: mismatch metadata teramati; vendor/wire mapping belum diverifikasi.
- Missing tests: capture model identity dari wire/vendor telemetry yang terotorisasi.
- Acceptance criteria: catat model efektif dan sumber identitasnya; bedakan request alias dari backend model aktual.
- Dependency: konfigurasi provider → gateway routing/cache → response metadata.
- Residual risk: aliasing mungkin keputusan gateway dan bukan bug MiniCode.

#### AUDIT-DOGFOOD-EFFICIENCY-001 — P2/MEDIUM — OBSERVATION

- Lokasi: session metrics dogfood Stage 1–7 pada tabel di atas.
- Invariant evaluasi: timeout, max_steps, denial, dan retry harus dapat dibedakan dari kegagalan kualitas model.
- Bukti: beberapa tahap memakan 546–901+ detik atau max_steps; sesi sukses Stage 5 mencatat 1.508.476 token. Ada sesi yang memerlukan replay.
- Dampak: eksperimen pembuatan proyek mahal dan hasilnya tidak selalu selesai dalam satu run.
- Evidence status: angka session teramati; penyebab campuran runtime/model/task scope belum dipisahkan.
- Missing tests: benchmark task identik lintas provider yang terverifikasi, batas biaya/token, dan kurva retry yang terkontrol.
- Acceptance criteria: simpan stop reason, effective model, current-request tokens, cumulative tokens, tool retries, dan durasi agar sebab bisa diatribusikan.
- Dependency: provider routing + context/budget + scheduler + task decomposition.
- Residual risk: bukan defect runtime yang terkonfirmasi; jangan mengubah limit tanpa bukti penyebab.

#### AUDIT-HARNESS-STRESS-001 — LOW — OPEN

- Lokasi: experiments/extreme-shadow-git.ts, pemeriksaan pertama pada base.tree.
- Invariant harness: hasil helper yang boleh null harus menghasilkan failure diagnostik dan membiarkan eksperimen independen berjalan atau berhenti dengan jelas.
- Bukti: snapshot null memicu TypeError saat membaca base.tree; skenario setelah skala tidak dijalankan.
- Dampak: stress run tidak memberi data concurrency/restore race saat tahap awal gagal.
- Evidence status: terkonfirmasi pada stress run.
- Missing tests: harness check untuk setup failure dan status per skenario.
- Acceptance criteria: null snapshot dilaporkan tanpa TypeError; bagian independen bisa dipilih/dijalankan; root uji tetap dibersihkan.
- Dependency: stress harness → helper shadow-git.
- Residual risk: ini masalah kelengkapan alat audit, bukan bug produk MiniCode secara langsung.

Finding kecil yang diperbaiki:

- AUDIT-DOC-ARCHMAP-001: docs/ARCHITECTURE.html tidak mencatat src/providers/sse-bounds.ts; map kini mencatatnya dan jumlah modul diperbaiki dari 11 ke 12.
- AUDIT-HARNESS-CLEANUP-001: cleanup fixture SQLite/WAL pada Windows sesekali EBUSY; test/coverage-gaps.test.ts kini memakai retry terbatas dan tetap gagal jika cleanup terus gagal.
- AUDIT-HARNESS-TIMEOUT-001: test/exec-json-envelope.test.ts menjalankan dua subprocess dengan default 5 detik; satu run memerlukan 5,924 ms dan timeout. Timeout kasus itu menjadi 15 detik. Full suite kandidat lulus.

## Dependency lintas dimensi

1. Provider routing → usage events → request occupancy → context watcher → agent cancellation. Salah agregasi request sebelumnya menyebabkan cutoff palsu; perbaikan memutus dependensi dari total kumulatif.
2. Tool dispatcher → inherited environment/config → ripgrep child. Perbaikan grep menutup jalur config/preprocessor dan credential leakage.
3. MCP child lifecycle → stdin write queue → pending request settlement → session shutdown. EPIPE tanpa listener dapat mematikan host; perbaikan menyelaraskan child exit dengan error propagation.
4. Shadow-git snapshot → checkpoint pre/post → rollback/redo → kepercayaan agent loop. Kegagalan skala kini dilaporkan sebagai unavailable dan tidak memakai fallback parsial; penyebab performa serta kebijakan turn tanpa undo masih terbuka.
5. Generator → build/unit test → runtime UI. MiniChat Settings membuktikan unit-test pass tidak menutup acceptance behavior; MiniCode perlu runtime validation yang sejalan dengan permintaan pengguna.
6. Pack file list/budget → distribusi. Ukuran adalah efisiensi dan status pack gate harus dilaporkan terpisah dari correctness gate.

## Risiko dan verifikasi yang masih terbuka

- MiniChat Settings yang dihasilkan tetap cacat; fixture tidak diperbaiki sesuai scope.
- Performa dan kelengkapan checkpoint pada repo Windows 2.000 file belum selesai dianalisis.
- Harness extreme-shadow-git berhenti dini; stress concurrency, restore race, nama ekstrem, ignore, manifest cap dan integritas Git tidak dieksekusi pada run ini.
- Manual MiniCode TUI UAT dan gateway cached token telemetry masih UNVERIFIED.
- Identitas backend provider yang dipakai saat dogfood masih UNVERIFIED.
- Windows symlink/junction race, Docker daemon nyata, MCP stdio disconnect setelah accept, global updater install/rollback, dan live provider quality tetap deferred.
- MCP subscriptions/notifications tetap unsupported; producer FAILED/RETRYING belum ada sesuai keputusan produk; daemon tidak auto-resume setelah restart.
- gate:pack gagal size-only pada 3.972 KiB vs 3.920 KiB. Tidak ada perubahan budget.
- Tidak ada bukti bahwa semua platform kompatibel; full gate ini berasal dari Windows.

## Kesimpulan

MiniChat sudah memenuhi tujuan sebagai fixture dogfooding dan tidak perlu diselesaikan untuk melanjutkan pekerjaan MiniCode. Tiga bug P1 pada grep, context accounting, dan MCP child lifecycle telah diperbaiki serta dilewati full suite. Fallback checkpoint parsial juga ditutup; MiniCode masih memiliki risiko checkpoint-scale, validasi runtime hasil UI generatif, dan efisiensi task besar yang belum selesai.

Full-system audit belum benar-benar selesai. Ini bukan klaim release-ready: pack gate masih size-only merah, stress shadow-git tidak lengkap, dan daftar verifikasi eksternal/platform di atas masih terbuka.
