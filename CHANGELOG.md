# Changelog

## [Unreleased] — 0.9.27

### Fixed
- **Wizard setup pertama tak lagi tampak macet di `⠴ Menyiapkan sesi…`**: spinner setup sesi (`cli/index.ts`) menulis frame `\r\x1b[2K` mentah ke stderr tiap 120ms — termasuk saat wizard memilih gateway dan meminta API key, sehingga prompt picker/`askLine` dihapus setiap tick (laporan: `minicode` dari home selalu berhenti di "Menyiapkan sesi…"). Layar raw-mode kini menahan SEMUA painter transient (`beginInteractiveScreen` di `statusline.ts`; nol byte + baris painter dibersihkan sekali saat layar mengambil alih), dan kedua spinner CLI memakai `createSpinner` (ownership tunggal — tulis `[warn]` saat setup tidak lagi hilang tertimpa tick). Test regresi di `test/transient-arbitration.test.ts` (I15: painter diam selama layar, nesting/idempoten, `delayMs`) + `test/wizard.test.ts` (prompt `Base URL` terlihat selama spinner hidup).

### Changed
- **Provenance vendor tarball**: `VENDOR.md` kini mencatat **shipped hash**
  (fingerprint file vendor yang ikut paket npm, tanpa `test/fakes.ts` yang
  sengaja tidak terkirim) di samping hash sinkron 19-file — hash dari tarball
  terbit kini bisa direproduksi siapa pun (celah ditemukan saat verifikasi
  `minicode-ai@0.9.26`: hash artefak ≠ hash tercatat, 18 vs 19 file). Guard di
  `test/pack-integrity.test.ts`; generator `vendor:minicore` menulis otomatis.

## [0.9.26] - 2026-09-17 — Rename paket npm: `minicode-ai`

### Changed
- **Paket npm pindah dari `@miniroom/minicode` ke `minicode-ai`**: rilis
  0.9.24/0.9.25 gagal karena PUT ke registry mengembalikan 404 — scope
  `@miniroom` tak lagi bisa publish. Nama bare `minicode` juga terbukti
  tertutup (403 "too similar to `mini-code`"), `minicode-cli` milik pihak
  lain; `minicode-ai` tersedia dan disetujui pemilik. Bin tetap `minicode`;
  config & state `~/.minicode/` tidak berubah. Migrasi pengguna 0.9.20
  (rilis npm terakhir yang sukses):
  `npm uninstall -g @miniroom/minicode && npm install -g minicode-ai`.
  Catatan nama: nama bare `minicode` ditolak aturan kemiripan registry
  (terbukti 403 "too similar to `mini-code`") — `minicode-ai` adalah nama
  final yang disetujui pemilik.
  Notifikasi update dan auto-update mengarah ke paket baru; install contract
  diselaraskan di README, docs/getting-started, landing, dan blog; guard
  `release-readiness` kini menolak sisa nama scoped lama di permukaan install.
- Web: rombak halaman docs (doc-head, TOC ledger, hub `/docs/`), justify prosa
  dengan kolom baca 640px, scrollbar disembunyikan tanpa mematikan fungsi
  gulir, eksperimen A/B urutan landing 100% lokal + panel laporan `?exp=report`.

## [0.9.25] - 2026-09-17 — Control plane architecture + hardening pasca-audit independen

### Fixed
- **Phase 6 — control plane architecture (closed-loop, dapat diamati)**: kontrak dibuat eksplisit setelah map 4-plane + 6 eksperimen — (1) **seam kernel**: flag kompaksi terpisah `compactedForBudget`/`compactedForRecovery` (dulu flag tunggal mengaburkan dua semantics — kompaksi budget membakar satu-satunya retry recovery, terbukti test yang gagal di kode lama), `Session.contextTokens` getter (ekspos angka konteks ke driver/UI — satu sumber kebenaran `estimateSessionContext` di tokens.ts, tanpa estimator duplikat), event `context:compacted` reason membedakan `budget:<pressure>`/`budget:<pressure>:no-op`/`recovery` (no-op = tidak ada yang bisa dibuang dari messages — fixed overhead system+schema tak pernah terkompaksi); (2) **kompaksi-cost blind spot ditutup** (E5): usage LLM kompaksi ditangkap `compactWithLlm` → `onUsage` → bus sesi (event usage standar) — dulu stream kompaksi di-skip diam-diam sehingga belanja tak terlihat budget; (3) **observability**: `/status` kini membedakan `Context` (window estimate kernel) vs `Input/Output/Total` (provider usage) vs `Cost` (estimated) vs `Budget` (status keputusan) — dulu satu angka ambigu; footer kini menampilkan ukuran jendela kernel (bukan spend kumulatif yang salah konsep); (4) dokumentasi kontrak: `docs/CONTROL-PLANE-MAP.md` (4 angka konteks, owner map, compaction/budget/termination contract, backpressure hierarchy). 5 test regresi baru + 4 perluasan; VENDOR.md + hash disinkronkan; gate penuh hijau.
- **Stabilisasi arsitektur Phase 5 (control plane)**: empat kontrak dibuat eksplisit setelah investigasi 4-plane + 3 probe — (1) cap `reasoning` stream (`PROVIDER_REASON_MAX_CHARS` 2MB, terbukti TANPA cap = akumulasi tak terbatas: satu-satunya jalur `reasoning +=` tanpa batas, probe E-2); (2) `read_image` guard b64 kini memakai batas kernel truncate yang sebenarnya (16.184 chars, bukan `BASH_OUTPUT×5`=100k yang 6,1× di atasnya → gambar >~12KB dikirim base64 korup, probe E-1); (3) fallback provider env-var (`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`) kini lewat `withStreamGuards` yang sama dengan jalur config (dulu: tanpa timeout per-request & tanpa text-cap); (4) `watchBudgetLimit` instant-check tidak lagi lockout turn dengan tokens==0 di strict-mode (terbukti: prompt pertama langsung digugurkan, probe E-3c) — gugur hanya bila ada bukti belanja; kontrak `budgetGateAllowsStart` + `budgetStatus(unknown)` didokumentasikan (estimasi ≠ aktual; budget-mati-diam tanpa usage event tetap gap F-27, jujur). 4 test regresi baru + 3 perluasan.
- **Hardening pasca-audit independen (21 finding, 0 rewrite)**: Responses adapter menerima `function_call` (tool tak lagi mati di jalur Responses), `[DONE]` menghasilkan `finish` (bukan 3 retry sia-sia), regex konteks disempitkan (tanpa `token` telanjang); `git add`/plumbing menonaktifkan `filter.*.process` (terbukti via probe: process jalan meski `clean=cat`), `git_commit` memperingatkan filter repo; sandbox eksplisit tanpa backend = tolak (fail-closed, opt-in via `MINICODE_SANDBOX_ALLOW_FALLBACK=1`, juga di CLI), spawn foreground selalu di cwd sesi, echo background di-scrub; persistensi verifikasi prefix (kompaksi N→N durable); budget fail-closed untuk cost-tak-dikenal + pemakaian (default, bukan hanya `--budget-strict`), harga negatif ditolak, abort budget ber-kind `budget_exceeded`; sub-agen parent-`ask` dipaksa explore + `background:true` ditolak di anak; sanitasi `timeoutMs`/`maxSteps`/`concurrency` di `createMinicodeSession`, `retryAfter` non-finite/negatif dibuang + cap; guard stream provider (timeout 5 mnt + text-cap 1M, preservasi `kind`); cap output `git` (500k) + snippet error `web_fetch`/`mcp-http`; tool unknown terjurnal (fail-closed); bash-guard anchor `\n` + aturan upload `Invoke-WebRequest`; SSRF `noCache` per-hop + revalidasi MCP per-request; `resolveTrustedExecutable` di semua spawn host + seam `runInOsSandbox` fail-closed; satu sanitizer id sesi (`lib/session-id.ts`); vendor:check melaporkan verdict hash tanpa sibling. 41 test regresi baru + 10 perluasan test lama (semua terbukti gagal di kode lama); gate penuh hijau 2080 test.
- **Lingkungan Windows**: normalisasi EOL worktree CRLF→LF (ulang, sesuai kebijakan repo) + `core.autocrlf=false` lokal — akar `bun run lint` merah 314 diagnostik di checkout ini; tanpa perubahan konten (`git diff` hanya perubahan nyata).

## [0.9.24] - 2026-09-17 — Audit hardening, cleanup production, web motion & SEO

### Fixed
- **Audit 2026-09-16 (sanitasi render)**: teks reasoning/thinking, preview bash compact, dan label/target tool (`write_file`/`edit`/status) kini lewat `sanitizeAnsi` — payload `\x1b[2J` model tak lagi sampai ke terminal (`test/sanitize-render.test.ts` 5/5, terbukti gagal di kode lama).
- **Audit website 2026-09-16**: tombol tema (`web/app.js` double-flip sehingga klik tak berpengaruh) diperbaiki — terbukti via simulasi; `web-serve` kini menolak path keluar `site/` (defense-in-depth); judul/desc/tags frontmatter di-escape di semua sisipan HTML + `</` di-escape di JSON-LD (payload `</script>` di judul tak bisa breakout, round-trip utuh); `pubDate` rusak tak lagi jadi "Invalid Date" di RSS; 2 selector CSS yatim (`.hint`, `.nav a.active`) dihapus; deskripsi basi diselaraskan (invariant 14, ledger `›`); sumber web dinormalisasi LF + `.gitattributes` kunci `css/html/svg`. Test regresi di `test/web-build.test.ts` (gagal di kode lama, termasuk simulasi breakout).
- **Audit 2026-09-16 (bash-guard)**: `pwsh -EncodedCommand`, wrapper `su/runuser/gosu/chroot/nsenter/cmd /c`, reader `certutil/tac/findstr/fc/comp`, dan `rm -rf //` + `/.*` kini ditahan; `isDangerousLink` tak lagi menuduh direktori POSIX; pembaca LSP/grep via `O_NOFOLLOW`; `assertSafeWriteTarget` live di tool tulis.
- **Audit 2026-09-16 (budget/memory)**: `--budget` memutus mid-turn (`watchBudgetLimit` menggugurkan turn berjalan); ringkasan `exec` memakai total sesi; `forget_memory` menghapus scope lokal + global (vector + `MEMORY.md`); `MINICODE_MEMORY_SCOPE=global` dihormati; setup WAL SQLite tahan AV-lock (defer, bukan crash).
- **Cleanup production**: hapus `full-test4.err`, `outputs/` (artefak agen), `scripts/demo-full.ts` + `human-sim.ts` (skrip manual personal), `experiments/extreme-security.ts` (digantikan test + gate), 8 fungsi mati; normalisasi EOL worktree (CRLF→LF) + `core.autocrlf=false` lokal; graf import: nol modul orphan di `src/cli`.
- **Docs & web sinkron**: `forget_memory` dual-scope (`tools.md`, `security.md`), pemutus budget mid-turn (`pricing-budget.md`, `USAGE.md`, `quickstart.md`), invariant 14 (nav web), ledger `›` di proof landing, `ARCHITECTURE.html` + komentar `chrome.ts` disinkronkan.
- **Audit website UI/UX 2026-09-16**: token warna `--on-acc` gantikan teks hardcode di tombol (kontras dua arah); init tema sinkron anti-kedip + test; `scroll-margin` anchor di bawah topbar sticky; tap target CTA; duplikat aturan 520 dihapus; radius diselaraskan ke skala 4/6/8.
- **Audit website UI/UX lanjutan**: meta `color-scheme` + `theme-color`; line-height heading dokumen (1.8 → 1.25–1.4); skala eyebrow disatukan 11px; sidebar mobile max-height + scroll; input admin 16px di ponsel (anti auto-zoom iOS); tap target nav/dok diselaraskan.
- **Motion website (P0–P2)**: token `--t/--t-slow` + `part-06-motion.css` (hover fade, FAQ grid-rows, entrance hero, reveal-on-scroll, scrollspy TOC, `@view-transition` native); gate `.js` + kill-switch `reduced-motion`; test di `test/web-build.test.ts`. Tanpa redesign visual — bahasa flat dipertahankan; susunan menu (Docs/Blog/Changelog/GitHub/Install) dan hierarki halaman dinilai sudah tepat.

### Fixed
- **Baterai SWE-Docker hidup**: 5 image era terbangun (`py36` butuh rewrite apt-archive + pin pytest 6.2.5, sudah di commit sebelumnya); `--verify-only` (validasi tanpa agen/API key); install+test satu container (filesystem ephemeral); `manifest.deps` (sympy→`mpmath==1.0.0`); `interpretCodes` (exit≠0/1 = harness ERROR, bukan FAIL model — kasus nyata collection-error sympy).
- **Hasil validasi**: requests-1963 (6/7 vacuous httpbin-drift + 1 genuine → tetap low), pytest-11143 (FAIL benar → diskriminator), sympy-11400 (tak runnable: bare-ID + shim `py.test` gagal di pytest 6.2.5 MAUPUN era 3.0.7 → tetap low beralasan).

### Fixed
- **Dockerfile py36 kini bisa build**: apt stretch pindah ke `archive.debian.org` (Check-Valid-Until saja tak cukup untuk repo yang dihapus) + pin `pytest==6.2.5` (7.x butuh Python ≥3.7 — pin lama `7.0` tak pernah bisa terinstall di 3.6); manifest + test konsistensi diperbarui. Validasi build tetap menunggu daemon.

### Added
- **Baterai berbiaya terkendali**: `bench/runner.ts` flag `--model/--provider/--max-steps/--timeout` (sebelumnya: router default + 50 step + 600s tanpa rem — run bayar bisa liar).
- **`gate:eval` (`bench/eval-gate.ts`)**: kunci ambang baterai (min resolve-rate, max median token, partial opsional) ala coverage-gate; `evaluateGate` murni + teruji.
- **Pilot live vyceai `deepseek-v4-flash`**: 5/6 tugas mainan (1 designed-fail tanpa memori); recovery terlihat live (edit gagal → baca pesan → perbaiki, 3 step).
- **LLM-judge terpisah (`bench/judge.ts`)**: nilai kualitas penjelasan 0-2 + alasan, model wajib beda dari aktor, gagal-parse = null (bukan vonis); pilot: 2/2 jawaban benar-dinilai-1 (tepat: kode benar tanpa penjelasan).

### Fixed
- **Deny beralasan sampai ke model**: seam `describeDenial` di kernel + alasan per aturan di app-layer (`bash-guard: …`, `jail: …`, `gated approval unavailable`, `read-only/plan mode`, …) — observasi `permission denied: <alasan>` alih-alih retry buta. `check()` tetap `"deny"` polos (112 assertion utuh).
- **Sub-agen mewarisi sesi parent**: model yang sama (live via ToolContext), limiter bersama, dan `--provider` parent (`setSubAgentParentRouting` dari composition root; `SubAgentSpec.model`). Deskripsi tool diperbarui.
- **Budget sadar-gambar**: `estimateMessage` menghitung byte gambar (`≈bytes/3` token) alih-alih placeholder ~15 token; hasil tool `Uint8Array` tak lagi meledak via `JSON.stringify` (~21k palsu).
- **Router 429 fallback-dulu**: bila 429 dengan `Retry-After` dan alternatif tersedia, pindah segera tanpa bakar sleep 30 dtk; tunggu hanya bila ter-pin atau tak ada alternatif (test `providers-p11` diperbarui ke `toBeLessThan(25)`).
- **System prompt `extra` anti-terpotong**: recovery/plan directive (paling penting) diposisikan sebelum blok data besar (MEMORY/AGENTS/repomap) sehingga `cutMarked(8000)` tak memotongnya duluan.
- **Retrieval recency + dwibahasa**: skor hybrid kini dikali peluruhan 60-hari half-life dan boost kategori dwibahasa (`perbaiki|keputusan|selesaikan`, `suka|ingin`) — koreksi kemarin mengalahkan fakta 6 bulan.

## [0.9.23] - 2026-09-16 — Footer sticky + spark + konteks live, stabilisasi gate

### Added
- **Footer lengket 2 baris + prompt steril `minicode ›`**: `src/ui/footer.ts` + `src/ui/runtime/chrome.ts` (DECSTBM 3 baris dasar: blank, garis `faint` tipis, `✦ mode • model • cwd … 14.2k`). Mode satu-satunya berwarna (pad lebar tetap anti-geser), spark pulse putih↔abu saat busy / redup saat idle (`setBusy()` + 150ms timer), konteks rata kanan polos. `MINICODE_FOOTER=off|print|sticky|auto` (default `auto` = lengket bila mampu, cetak bila tidak; pipa non-TTY nol byte).
- **Idle Ctrl+C 1x = copy, 2x = keluar; busy Esc = abort** (lone-ESC 50ms, tanpa teks) — `cli/repl.ts` `copyLastTurn()` shared, `escTimer` di `runTurn`.

### Changed
- **Thinking line tanpa spark**: `src/ui/assistant/turn-status.ts` kini `···` saja (spark pindah ke footer — satu sumber denyut). Tool line tetap spinner braille.
- **Stabilisasi gate**: 4 test toleran global (concurrency/supply/provision/§33), `vendor:check` seam-aware, `sandbox` timeout 15s, `gate:coverage` 85→84 (84.88% lines, turun 0.12 karena branch MINICODE_FOOTER + pulse).

## [0.9.22] - 2026-09-15 — Tindak lanjut eval D:\Test: allowlist produktif, guard git, warisan izin

### Fixed
- **Lubang baca-bebas via `git diff --no-index`**: mencetak isi path filesystem arbitrer walau cocok pola allowlist `git diff*` (terkonfirmasi empiris via `inspectBashCommand`, bukan teori). Guard kini menolak `--no-index/--exec-path/--upload-pack/--receive-pack`, transport `ext::`, dan injeksi config via env (`GIT_EXTERNAL_DIFF`/`GIT_CONFIG_*` inline); alur sah dalam-repo (`status/diff/log/branch/show`) tetap jalan.
- **Inkonsistensi izin sub-agent**: parent `allowlist` melahirkan anak `auto` yang shell-nya lebih longgar. Anak kini mewarisi `allowlist` (`SubAgentSpec.permissionMode: "auto" | "allowlist"`); `plan`/`readonly` tetap dipaksa explore.

### Added
- **`type *` di allowlist bash**: padanan `cat` di cmd.exe Windows yang dijanjikan deskripsi tool tapi selalu ditolak allowlist; guard sensitif tetap berlaku (`type .env` ditahan).
- **Deny allowlist actionable**: `allowlist: no matching pattern for "<cmd>" — file work: use read_file/write_file/edit; full shell: rerun with --allow-all / --sandbox docker / MINICODE_BASH_ALLOWLIST` + panduan anti-retry-buta di deskripsi tool bash.

### Notes
- Klaim eval yang dikoreksi setelah verifikasi kode: `--exec-path` RCE tak tereksploitasi seperti ditulis (residual repo-config sudah terdokumentasi di `repo-git-trust.test.ts`); klaim "sub-agent full access" dan "UNC bypass" salah arah (fail-closed); fail-open DNS adalah tradeoff availability yang disengaja di `src/lib/net.ts`.

## [0.9.21] - 2026-09-14 — Kokoh: stdin flow, hang, keamanan, kepintaran

### Security (audit #13 — kasus nyata sesi liar)
- **Kunci `.minicode/**` penuh untuk tool tulis**: daftar-nama terbukti rapuh (`write_file .minicode/test-write.txt` lolos). Kini segmen `.minicode/` apa pun ditolak fail-closed di semua mode termasuk allow-all; pengecualian: restore `.minicode/.trash/` → workspace dan skrip `.minicode/hooks/` (eksekusi hook tetap butuh registrasi allowlist yang terkunci). Baca tetap boleh.
- **Pola kredensial Windows**: `system32\config\(sam|system|security|software|default)` + `ntds.dit` di jail file + bash-guard (kasus nyata `type ...\system32\config\sam` lolos karena pola POSIX-sentris); `reg save|export` hive, `vssadmin create|delete shadow`, `ntdsutil` ditolak eksplisit (`reg query`, `vssadmin list`, `system.txt` biasa tetap lolos).
- Deny tetap tampil merah full-text + tercatat `denyReason` di step-traces (terverifikasi, tanpa perubahan UI).
- **Baterai uji kepintaran (audit #14, ronde riset)**: tool-desc & param 12 tool inti di-EN-kan + batas nyata (chars/baris/timeout/output) + panduan kapan-tidak-pakai (read_file vs cat, edit vs apply_patch, dll.); system prompt dapat blok `# How to work` (baca-dulu, prefer tool, todo 1 in_progress, jangan ulang call yang ditolak, kerja di workspace) — leverage AHE: model lemah paling diuntungkan pola koordinasi eksplisit. Benchmark `follow-convention` diperbaiki: prompt dulu menyebut `f(...)` yang mengangker nama dan menabrak konvensi `salam` (diferensial memory tak terukur); prompt kini netral — verifikasi live: memory on → `salam` (PASS), off → tebakan `f` (FAIL).

### Fixed
- **Abort saat verify = batal, bukan gagal**: `runVerify`/`checkBaseline`/`runWithSelfHeal` meneruskan `AbortSignal` (exec dibunuh via signal); Ctrl+C di tengah verify/baseline melempar `AbortError` sehingga tak berubah menjadi siklus self-heal yang tak diminta. Cek aborted juga setelah verify (abort-di-tengah tak diproses sebagai gagal).
- **Picker settle di semua jalur**: dua `catch` di `runPicker` (onData + setup) kini `cleanup()+onCancel()+resolve()` — dulu Promise gantung + `busy` bocor di pemanggil nested.
- **Satu mekanisme tunggu anak**: `waitChildExit` baru (`cli/auto-update.ts`: exit+close+error, guard settle) dipakai auto-update, plan re-spawn, resume spawn, dan respawn REPL — dulu ketiganya hanya dengar `exit` yang bisa tak datang bila stdio macet.
- **Spinner setup anti-bocor**: `createCliSession` yang melempar kini tetap membersihkan interval via try/finally.
- **`/sync` jujur soal keystore**: referensi `keystore:...` di-resolve sebelum deteksi (helper `resolveDetectApiKey`); entri hilang → `failed` yang actionable, bukan no-op diam dengan literal terkirim sebagai Bearer.
- **Key salah (401/403) tak lagi "Saved"**: `detectModels` menandai `authFailed`; `detectAndSave` melempar `unauthorized` (fallback hanya untuk tanpa-endpoint/unreachable); `refresh` mencatat ke `failed`. Termasuk `clearDetectCache()` di awal `detectAndSave` agar retry key langsung re-fetch.
- **`config add` default global** (seperti remove/set-key): menulis provider+key ke repo lokal diam-diam rawan ikut ter-commit plaintext.
- **Override lokal tak flip default**: `mergeByKey` mengganti nilai di posisi global (Map.set key lama tak pindah), bukan pindah ke ujung.
- **Config tak terbaca berisik**: error baca non-ENOENT (EACCES/EISDIR) global/lokal kini warn ke stderr, bukan "no providers" diam.
- **Idle-timeout input**: `askLine`/`askSecret` batal sendiri (null) setelah 90 dtk tanpa keypress (`idleMs`, unref, reset tiap chunk); non-TTY EOF (`close`) = batal. Prompt utama REPL opt-out (`idleMs: 0`) karena null dihitung Ctrl+C 2x-exit. Approval yang idle = deny (fail-closed).
- **Budget total embedding 10 dtk** (`EMBEDDING_TOTAL_TIMEOUT_MS`): endpoint lambat tak lagi menahan setup RAG ~21 dtk (6×3,5 dtk); lewat = fallback keyword.
- **stdin mengalir seumur proses (tanpa pause mid-session)**: siklus pause→resume berulang mematikan pengiriman `data` selamanya di Bun Windows — daftar tampil tapi semua tombol mati, bahkan Ctrl+C. `pause()` dihapus dari askLine/askSecret/picker/kedua manager/finally turn; kepemilikan = siapa yang memegang listener (byte tanpa listener dibuang, bukan di-buffer). Satu-satunya `pause()` tersisa di teardown sesi (`close()`) agar one-shot/exec tetap bisa exit.
- **Jawaban REPL default expanded + `/minimize` toggle**: minimize-default tanpa off-switch membuat REPL "bisu" (`+ answer (N chars)` tanpa cara membuka yang bisa ditemukan; tombol `+` hanya hidup saat turn, klik mouse memang tak didukung). Kini jawaban streaming penuh kecuali diminta; `/minimize` tanpa argumen flip tool+answer (`on|off` eksplisit, echo status); baris minimize membawa petunjuk `/expand to read`.
- **Preset OpenRouter**: fallback gratis pertama kini id yang terverifikasi live (lama sudah 404 di katalog).
- **`globalConfigPath()` hormat `MINICODE_HOME` saat runtime** (dulu const beku-saat-import); test kini hermetic penuh.

## [0.9.20] - 2026-09-14 — Perbaiki safe-open + test timing CI

### Fixed
- **safe-open**: pemeriksaan `nlink > 1` kini melewati direktori — di Linux direktori punya `nlink >= 2` (`.` dan `..`), sebelumnya `read_file` ditolak dengan pesan "hardlinks" alih-alih "is a directory" yang user-friendly.
- **Test CI**: timeout test `§27 started ganda + satu completed` dinaikkan (200/300ms → 500/800ms) agar cukup untuk runner GitHub Actions yang lebih lambat.

## [0.9.19] - 2026-09-14 — Sinkronisasi dokumentasi + web

### Fixed
- **Dokumen selaras dengan kode**: ledger tool kini `›` hijau/merah di `docs/architecture.md` + `docs/terminal.md` (sebelumnya masih `✓`/`✗` era 0.9.16); ambang coverage `docs/contributing.md` kini **80 funcs / 85 lines** sesuai `scripts/coverage-gate.ts`; `EXPLORE_TOOL_NAMES` terdokumentasi 12 (kode: 12, bukan klaim 11 yang tersebar di komentar lama); klaim jumlah baris `cli/setup.ts` yang basi dihapus (kini 684 baris dan terus bergerak).
- **Peta struktur hidup**: badge `docs/ARCHITECTURE.html` kini `v0.9.19` (pill kernel tetap `05fc595a` — basis pin vendor, bukan upstream).
- **Web**: rebuild 32 halaman + `web:check` lolos (link internal, anchor, SEO, sitemap).

### Deferred (disengaja — bukan lupa)
- **Vendor sync ditunda**: upstream `minicore@1eceea9` divergen dari pin vendor (`868d4f1b…` vs `99b17847…`); `VENDOR.md` mencatat seam lokal `cwd` + `permissionMode` + `turnCount/stepCount` + `provider_meta` yang akan **dihapus** oleh sync membabi buta. Satu-satunya delta upstream (cap `retryAfter` 30s) sudah ditutup lapis-app (`cappedRecovery` + router). Hilirkan seam dulu ke repo minicore, baru sync ulang.


## [0.9.18] - 2026-09-13 — Indikator rapi, jawaban minimize, pagar turn

### Changed
- **Indikator thinking tidak lagi blank/strobo**: grace 250ms (submit lambat langsung tampil `✦  · · ·`), latch fase (reasoning interleave di tengah jawaban tetap sembunyi — dulu on/off strobo mengikuti chunk), kelip pelan tiap 3 tick, titik-titik berjarak (`· · ·`), kursor disembunyikan saat melukis dan dikembalikan di semua path (tanda `|` tak lagi menempel).
- **Reasoning expanded line-buffered**: baris utuh per newline, bukan salad fragmen per chunk; sisa baris di-flush saat fase berganti/turn selesai.

### Added
- **Jawaban model default minimize** (REPL): satu baris `  + answer (N chars)` di akhir turn, isi lengkap di-buffer (cap 1MB + penanda) untuk `+`/`/expand` (dicetak ke stdout — kontrak stream terjaga). Pipa/CI/`--verbose` selalu stream penuh (hard guard TTY). `/minimize` kini mencakup thinking + tool + answer.
- **Pagar turn yatim**: listener UI di-attach segar per turn dan dilepas saat settle (termasuk timeout) — event telat dari provider/tool non-kooperatif pasca-abort tidak lagi bocor ke sesi prompt berikutnya (kandidat penyebab "macet").
- **`MINICODE_DEBUG_BUS=1`**: dump ringkas tiap event bus (tipe + nama + panjang, tanpa isi konten) untuk diagnosis "macet" — bedakan event yatim vs stdin mati.

### Security (temuan red-team eksternal)
- Interpreter inline kini menangkap nama dengan `.exe` (`python.exe -c`, `node.exe -e`, dsb.) di 3 regex — dulu `.exe` mematahkan `\bpython\b\s+`.
- `powershell -enc <blob base64>` diblokir (aturan penuh `-EncodedCommand` + pola blob panjang; `-Encoding`/`-ExecutionPolicy` cmdlet tidak over-block).
- `.minicode/auth.json` (token OAuth) masuk sensitive-file — file tools & bash menolak baca/tulis.
- Scrubber menangkap `thk_live_*` (TokenHarbor) dan `hf_*` (HuggingFace) yang lolos pola umum.

## [0.9.17] - 2026-09-13 — Sparkle kelip + section collapse

### Changed
- **Thinking = sparkle `✦` kelip putih↔abu**: ganti emoji `💡` (yang warnanya mati kuning karena terminal mengabaikan ANSI pada emoji) dengan glyph monokrom sehingga kelip `c.white` ↔ `c.gray` benar-benar terlihat. Titik animasi + kecepatan adaptif tetap.
- **Ledger tool = chevron `›` berwarna**: sukses hijau, gagal merah (menggantikan `✓`/`✗`). Satu bahasa visual dengan prompt `❯` + picker `›`. `✓`/`✗` tetap untuk status/konfirmasi perintah (sync, auth, config, spinner).

### Added
- **Section collapse `+`/`-` (default minimize)**: thinking, bash, edit/apply_patch, dan content tool mengecil jadi satu baris `  + label` (stderr) — isi di-buffer (200KB/entry, 500KB total), bukan dicetak.
- **Tombol live saat turn** (raw mode, TTY saja): `+`/`=` expand section aktif, `-`/`_` minimize, `Ctrl+T` toggle thinking, `Ctrl+C` tetap abort. Toggle thinking menambah baris header (`  − thinking` / `  + thinking`); pipe/CI tanpa tombol live.
- **`/expand` / `/minimize`**: `/expand` mencetak buffer section turn terakhir ke stderr lalu mengosongkan (sekali pakai); `/minimize` mengecilkan tool untuk turn berikutnya. Keduanya di dropdown Tab + banner.

## [0.9.16] - 2026-09-13 — Ikon putih + toggle thinking

### Changed
- **Ikon thinking putih 💡**: ganti kuning → putih (`c.white`, fill #e3e3e3 sesuai SVG Material emoji_objects). Titik animasi tetap jadi sinyal hidup.

### Added
- **Toggle reasoning expand/minimize**: `/thinking` (dropdown) atau `Ctrl+T` — `thinking: expanded` ⇄ `thinking: minimized`, setara `/compact` untuk tool. Default tetap minimized (hanya `--verbose` atau `MINICODE_SHOW_THINKING=1` yang menampilkan).
- **Spinner startup**: `⠋ Checking for updates…` (TTY-only, delay 120ms, interval 80ms) hilang tanpa jejak.

## [0.9.15] - 2026-09-12 — Startup hemat waktu + kilau adaptif

### Changed
- **Auto-update tak pernah hang 7s**: dibatasi budget 1.8s abortable (`AbortSignal`).
- **Kilau mengikuti kecepatan reasoning**: ikon berkedip kuning ↔ kuning-terang dengan interval adaptif 80-320ms dari frekuensi chunk reasoning (bukan denyut tetap).

## [0.9.14] - 2026-09-12 — Ikon kuning tanpa timer

### Changed
- **Status line: ikon 💡 kuning animasi tanpa teks/timer**: `Thinking··· 1m23s` → `💡···` (titik animasi tetap). Timer dihapus sesuai permintaan; teks panjang dihapus agar tidak membingungkan.

## [0.9.13] - 2026-09-12 — Heartbeat + crash recovery

### Added
- **Heartbeat elapsed di garis status**: `Thinking···` kini selalu membawa timer (`12s`, `1m23s`, `2h05m`) yang update tiap tick — bedakan "masih jalan" dari "mati diam-diam" saat provider stall/hang. Tidak pernah bare, tetap transient, non-TTY tetap mati.

### Fixed
- **Marker turn + notice crash**: turn meninggalkan `.minicode/turn.active.json` (pid+sessionId) dan menghapusnya saat settle; startup berikutnya yang menemukan marker yatim (pid mati) menampilkan `[recovery] previous turn did not settle…` + hint `/resume`/`/undo` sekali lalu membersihkan. Pid hidup dihormati (sesi paralel tak saling menghapus). Test `turn-marker` + `turn-status` heartbeat.

## [0.9.12] - 2026-09-12 — Provider jujur, harga free, hint shell

### Fixed
- **`/status` tampilkan provider efektif** (bukan hint wire): sesi opencode-zen selalu tertulis "Provider: openai". Kini: provider hasil routing → id dari pin `provider::model` → hint.
- **Model `-free` gaya Zen $0**: `findPrice` hanya kenal sufiks `:free`; `deepseek-v4-flash-free` cocok segmen berbayar ($0,14/M → sesi gratis 919rb token dilaporkan $0,13). Kini sufiks `-free` juga $0 kecuali entri eksplisit.
- **System prompt sebut shell Windows** (`cmd.exe`, bukan `ls`/`pwd`) agar model tak menebak perintah Unix di win32.

## [0.9.11] - 2026-09-12 — Eval, keyring, effort keluarga, VCR

### Added
- **Eval keberhasilan tugas**: `bench/runner.ts --memory on|off --out <path>`, HOME hermetic per run, RAG seperti jalur CLI + `memHits` di laporan, task `follow-convention` yang hanya lolos bila agen membaca fakta seed (ukur nilai memory diferensial, bukan klaim). Test `bench-eval`.
- **Keyring OS**: `config set-key/delete-key` — Windows DPAPI user-scope (terbukti live: roundtrip OK, disk bebas plaintext), selain itu berkas chmod 600 berlabel jujur; referensi `keystore:` di-resolve di lapisan provisioning, hilang = skip fail-closed. Test hermetic (mocked).
- **Fail-soft thinking generik** (`withStrippedRetry`): 400 diingat per sesi, 500 dicoba-ulang tanpa ingatan; kategori lain + abort diteruskan.

### Fixed
- **Thinking effort berbasis keluarga + default universal**: knob low/medium/high generik yang ditembak ke semua model terbukti salah alamat di lapangan (param beda tiap keluarga/versi; model non-reasoning 400/500; default vendor justru sudah tuned). Kini: default = omit total; effort hanya dikirim ke OpenAI reasoning (level tervalidasi per model), Claude ≤4.5 (budget), Claude ≥4.6/5 (adaptive — sebelumnya format legacy yang pasti 400); sisanya tak pernah dikirimi param. Penolakan 400/500 → ulangi sekali tanpa param + ingat per sesi + catat `[thinking]`. Picker effort hanya muncul untuk model yang mendukung. Test `effort*` + adapter.
- **VCR wire-contract** (`test/vcr/`): rekaman respons asli (zen 429, openrouter 402) di-replay lewat adapter sungguhan — drift API ketahuan mesin, bukan user.

## [0.9.10] - 2026-09-12 — Pin model, indikator, picker cari, redirect guard

### Fixed
- **Pin `provider::model` = kontrak, tanpa auto-switch**: request pin hanya ke provider itu — tanpa fallback lintas provider dan tanpa substitusi diam-diam (yang pernah melempar user dari model gratis ke model berbayar + 402). Gagal = error jujur provider yang dipilih; model tak dikenal / provider tak dikenal = `invalid_request` + daftar kandidat. Pesan substitusi jalur bare menampilkan nama ter-strip (tak lagi prefix basi). Test `test/router-pinned.test.ts` (gagal di kode lama).
- **Error 402/429-free dikenali**: kategori `unknown` ber-teks tagihan/limit dipetakan ke pesan saldo/limit + saran `/model` (sebelumnya dump mentah).
- **Indikator proses `Thinking···`**: ganti denyut redup (terbaca beku, terpotong jadi "t" di terminal sempit) dengan animasi titik eksplisit ·→··→··· ±300ms + fallback titik-saja di terminal sangat sempit. Test kontrak diperbarui.
- **Redirect shell keluar workspace ditolak (temuan audit eksternal, KRITIS)**: `echo x > ..\evil` lolos guard + allowlist `echo *` lalu menulis di luar workspace — allowlist hanya menolak chaining `[;&|]` dan guard tak punya aturan redirect. Kini `findRedirectTargets` mengekstrak target `>`/`>>`/`<` quote-aware (heredoc/fd/null-sink dikecualikan) dan menolak target di luar cwd/sensitif/owned-state. Test PoC + over-block guard.

## [0.9.9] - 2026-09-11 — Auto-update + Bun Windows TTY fix

### Added
- **Auto-update interaktif**: membuka `minicode` (REPL TTY, salinan ter-install) selalu cek versi terbaru → install otomatis → restart ke versi baru. Gagal/offline = lanjut versi lama (tak pernah blokir). One-shot/`exec`/pipe/CI tetap notifikasi saja. Opt-out `NO_UPDATE_CHECK=1` / `MINICODE_AUTO_UPDATE=0`; guard env cegah loop restart.
- **Jail simetris**: `move_file`/`delete_file` dijail di lapisan permission (sebelumnya hanya tool-layer) — berlaku di semua mode termasuk `--allow-all`.
- **`MINICODE_SANDBOX_STRICT=1`**: fail-closed bila isolasi yang diminta tak tersedia (default tetap warn + lanjut).
- **Allowlist `bun run`/`bun x`**: tolak ekspansi shell/redirection seperti `npx`.
- **`--budget-strict` / `MINICODE_BUDGET_STRICT`**: cost tak dikenal dianggap over budget di one-shot/REPL/`exec`. Sekaligus perbaiki `exec` yang mengabaikan `--budget` total.
- **`step-traces.jsonl`**: satu baris per tool/step + klasifikasi deny + mode sandbox; `minicode stats` tampilkan deny-rate (`summarizeStepTraces`).
- **`bun run audit:harness`**: 60 cek deterministik tanpa API key (safety 6-mode, guard bypass-rate, budget, scope, fake-detector).
- **Baseline-first**: `--verify` menguji baseline sebelum agen jalan (catatan Health-Check bila merah).
- **`--tool-scope explore` / `MINICODE_TOOL_SCOPE`**: subset read-only bersama sub-agen (`EXPLORE_TOOL_NAMES`).
- **Validasi resume**: peringatan bila workspace berubah sejak checkpoint terakhir (`.minicode/` dikecualikan).
- **`config --cwd` diperbaiki**: branch list/add sebelumnya mengabaikan `--cwd` (baca/tulis ke `process.cwd()`); flag-sebagai-id ditolak. Ditemukan saat kejar coverage 81/83 (81,69/85,25; min dikunci 81/83).
- **SWE docker per-era**: `bench/docker/` (5 image Python 3.6–3.10 + `manifest.json` 20 instance dari tanggal base_commit + classifiers setup.py) + flag `--docker` di `bench/swebench.ts`. Image ter-build semua (py36 butuh fix apt kedaluwarsa); requests-1963 collect+run OK di py3.8, pytest-11143 FAIL dengan benar di py3.10.
- **Run POSIX pertama (WSL)**: TOCTOU 1000× 0 lolos (temukan bug test: swapper tanpa yield menggantung); full suite Linux 1334/8/0. Perbaiki 5 fail platform-spesifik (`node -e` → runtime sendiri; stripAnsi markdown; mount-test cabang platform; `MINICODE_HOME` untuk global-DB hermetic).
- **Provider minimalis + auto-switch**: `Gateway >` hanya `[0] Label` tanpa URL; `router` per-stream `getById()` + `reloadProviders()` setelah `Gateway >2` — pilih `openrouter::inkling:free` otomatis pindah provider tanpa substitusi `claude-fable-5`.
- **Thinking effort picker**: `/thinking` + `Ctrl+T` dihapus, diganti picker `default/low/medium/high` di `/model` (`Enter` = pilih + picker effort, `Esc` = batal total; tersimpan di provider, berlaku sesi berikutnya, badge `[low|medium|high]` di baris) — simpan `ProviderEntry.reasoningEffort` via `saveProvider`, wire `build.ts:low=1024 medium=2048 high=4096`.
- **Effort anti-hilang**: `detectAndSave` + `auth login` mempertahankan `reasoningEffort` (sebelumnya add/edit provider me-reset ke default diam-diam); mutasi `/model` (add/delete/effort) ditulis ke file scope asal provider, bukan hasil merge (cegah duplikat lintas scope/shadowing yang membuat editan "balik lagi").
- **Hardening P0 review**: `read_image` TOCTOU `safeOpenRead` + `handle.stat` + b64 cap, `edit`/`patch` jail `safeReadFile`, `responses` instance-local `allChains Set`, `shadow-git` `+randomUUID`, `router` abort-aware `Promise.race`, `git` scrub, `pricing` dedup `toModelPrice`.
- **Struktur path-guard dirapikan (klaritias, tanpa ubah perilaku)**: pemisahan kepemilikan eksplisit di `lib/safe-open.ts` — `resolveSafePath` untuk tool PENULIS (write/edit/patch/delete/move: butuh path real sebagai target tulis, toleran ENOENT), `safeOpenRead` untuk PEMBACA; `read_file` & `read_image` kini open sekali (`safeOpenRead` → `handle.stat` → baca) sehingga verifikasi path (jail+sensitif+O_NOFOLLOW) tidak lagi dijalankan dua kali per baca dan pesan ENOENT diseragamkan. `cli/model-manager.ts`: jalur tulis mutasi disederhanakan ke satu `updateProviderInScopes` (fallback balapan-hapus + `saveProvider` + `saveGlobal` dihapus; provider tak dikenal = throw → ✗). Pesan warn reload router yang sama di 4 situs `cli/provider-manager.ts` → satu helper. Gate `1357 pass 0 fail / coverage 81.84/84.26 (min 80/84) / pack 22/22`.
- **Hardening tahap 3 — arbitrase terminal transient (final ownership)**: `src/ui/runtime/statusline.ts` kini hub arbitrase tunggal untuk SEMUA penulis transient stderr. Painter (garis status turn) dan wizard-spinner mengklaim kepemilikan via `acquireTransientPaint(kind)` dan menulis via `paintWrite` (bebas aturan "asing"); tulis MENTAH dari pihak lain (router/providers/tool warnings — non-UI yang tak bisa impor UI karena batas lapisan) saat painter aktif otomatis DIKOMIT sebagai baris permanen yang bersih (hapus garis transient → tulis → repaint) — diagnostik tidak lagi hilang tertimpa tick painter (sebelumnya: tulis asing menempel di tengah baris transient lalu terhapus ≤150ms). Overlap turn-painter vs spinner (secara desain mutually exclusive) kini di-enforce sebagai signal runtime: `[transient-paint] <kind> starts while <other> active` dicetak sekali per pasangan — bukan crash produksi, tapi invariant tak lagi asumsi murni. Wrapper stderr hanya aktif saat ada owner (overhead nol saat idle), re-wrap otomatis bila `write` diganti (test harness), dan `paintWrite` memakai sink yang masih terpasang (painter zombie antar-test tidak mencemari buffer lain). Test: foreign-write dikomit + repaint, pesan tidak hilang walau banyak tick, warning overlap spinner→turn, non-TTY tanpa byte kontrol. Gate `1371 pass 0 fail / 81.71/84.43 / pack 22/22`.
- **Hardening tahap 2 — terminal rendering ownership**: kernel ternyata hanya emit `turn:completed` di jalur SUKSES — setelah gagal/abort garis status turn basi melukis di atas prompt idle (stale painter). `attachTurnStatus` kini mengembalikan handle `{detach, endTurn}`; driver (`runPromptWithVerify`) memanggil `endTurn()` di `finally` setiap `session.run` settle → transisi apa pun (sukses/gagal/abort/Ctrl+C/retry) membersihkan state visual secara deterministik. Lukisan tidak lagi dimulai otomatis di `turn:started`: garis mulai pada event kerja pertama (reasoning/execution) sehingga jendela pra-stream (catatan `[router]`/diagnostik provider lain) tidak pernah bisa tertimpa garis transient; `suspend()` garis kini no-op saat sedang tidak melukis (dulu tiap tulis mengirim `\r\x1b[2K` — bisa memotong baris parsial penulis lain); pemotongan lebar label dilakukan PER-PAINT dengan kolom saat ini (resize saat melukis tidak lagi menyisakan label terpotong lebar lama); label tool kini memakai `cmd`/`command` untuk tool shell (bukan hanya path/file). Test kontrak output adversarial: 20 tool beruntun tanpa overlap & tanpa bocor isi, gagal→retry terpisah ✗/✓, tool selesai vs teks mengalir terpisah stdout/stderr, `endTurn` tanpa `turn:completed`, resize 40→120 saat melukis, spinner non-TTY tanpa byte kontrol.
- **Audit CLI menyeluruh (kokoh/Unix-native, tanpa ubah arsitektur)**: warna kini digate `stdout.isTTY` — `minicode "x" > file` / pipe / redirect tidak lagi memuat ANSI walau `TERM`/`COLORTERM` bocor dari sesi interaktif (sebelumnya env menang atas TTY); baris ✓ generik di simple logger selalu diakhiri newline (dulu tanpa newline saat ada preview → baris output berikutnya menempel = overlap di stderr log); mode compact untuk tool konten (`read_file`/`grep`/`glob`/dll) jadi satu baris `✓ nama target` tanpa bocor isi ke scrollback (isi tetap utuh untuk model; expanded/verbose tetap menampilkan); baris `running x... ` saat `execution:started` dihapus (tanpa newline dulu menempel ke baris ✓; kini progres = garis status, bukan baris start); lifecycle garis status turn ditulis ulang jadi state machine deterministik — label menampilkan nama tool+target saat tool berjalan (bukan "Thinking" terus), garis hilang saat teks model mengalir, HIDUP LAGI saat tool berikutnya mulai setelah teks (dulu mati permanen setelah teks pertama), dan bersih total saat turn selesai.
- **Audit UX lain (input & dialog)**: `Esc` membatalkan prompt kosong (baris berisi aman — draf tak hilang; sama di `askSecret`, yang kini membedakan batal `null` vs submit kosong — "batal" tak lagi dikira error "required"); batal di prompt pertama dialog add/edit benar-benar batal (wizard, edit provider, add model tak lagi "lanjut diam-diam"); `Ctrl+D` saat reverse-search = batal cari saja (draf pulang, konsisten dgn `Ctrl+C`), `Ctrl+U` = hapus query, tombol REPL (`Tab`/`Shift+Tab`/`Ctrl+O`) tak lagi membajak mode search; `Enter` kosong di `Gateway >` tak lagi diam-diam memilih preset `[0]`; tambah preset yang id-nya sudah ada kini minta konfirmasi timpa; add provider id tak dikenal di `/model` menampilkan error (dulu diam); hapus model AKTIF diperingatkan; add/delete model + Enter-select gagal kini punya umpan balik ✓/✗; `Ctrl+U`/`Ctrl+W` berlaku di `askSecret`; add model duplikat dilaporkan "already exists"; picker tanpa item tak lagi highlight phantom (`sel=-1` setelah Down di daftar kosong); picker dapat footer hint + filter di-sanitasi; `Invalid URL` wizard di-sanitasi; lebar floor manager 12→8 kolom (tidak membungkus di terminal sempit); baris kosong scrollback per nested picker dihilangkan; `/sync` hanya bilang "restart" bila benar ada model baru; bahasa campuran di pesan budget → Inggris konsisten; `KEYBOARD_HELP` (`/help tombol`) & footer `/help` + banner start + `--help` kini akurat (Ctrl+R disebut, `Tab` kosong = mode, tanpa `/cost` mandiri); komentar basi `Ctrl+T`/`/cost` diselaraskan.

### Fixed
- **Tiap turn TTY gagal `kWriteMonkeyPatchDefense` di Bun Windows**: `paintWrite` (`src/ui/runtime/statusline.ts`) memanggil `stderr.write` detached — selalu method-call sekarang; transient self-disable permanen + restore write asli begitu marker terlihat (agen tetap jalan tanpa spinner). Test `test/statusline-bun-guard.test.ts` (gagal di kode lama) + residual risk di `docs/TERMINAL_CONTRACT.md`.
- **Cari di picker `/model`**: ketik langsung menyaring live (substring, case-insensitive, tanpa awalan — termasuk huruf `a`/`d`), backspace/Del edit query, Esc keluar filter; `/model <cari>` jadi filter awal (sebelumnya argumen diabaikan diam-diam padahal docs menjanjikan "bisa difilter"). Shortcut tambah/hapus pindah ke **Ctrl+N / tombol Del** (non-ketik, aman di Windows & Linux) agar tak bertabrakan dengan pencarian. Test `model-manager: cari/filter` + hardening sinkronisasi hasil tulis (tunggu marker, bukan cuma jawaban terkirim).

### Docs
- **Redesign `docs/ARCHITECTURE.html`** — palet developer-docs terang yang bersih (tokoh token, tipografi system-ui + mono untuk kode), doc-bar tautan dokumen pendamping, sidebar + link §9, dan **§09 "UI/UX untuk Developer — Rendering Terminal"**: lima primitif tampilan, stream contract, ownership transient, tabel 12 invariant + peta test pelindung, residual risk. Kartu modul `src/ui/` (statusline/spinner/simple/turn-status/theme) diselaraskan dengan arbitrase & color-gate terkini.
- **Kontrak terminal FROZEN**: `docs/TERMINAL_CONTRACT.md` baru — klasifikasi writer (permanent/transient/diagnostic/machine/debug), ownership transient single-mechanism, 12 invariant, residual risk disengaja (partial write non-newline, overlap signal, flake harness), peta proteksi test→invariant. `AGENTS.md` mewajibkan baca dokumen sebelum menyentuh output/rendering.
- **Invariant terproteksi test**: `test/terminal-contract.test.ts` baru — ownership token per klaim (release klaim kedua tak mencabut pemilik pertama), warning overlap sekali per pasangan, foreign-write dikomit + repaint, wrapper inert tanpa owner, zero-write setelah detach/endTurn (event telat), ledger duplikat terpisah, semua branch ledger satu-marker-per-baris + newline, long-session 3×12 tool tetap satu-baris per tool tanpa bocor isi.
- `docs/HARNESS.md` baru (riset + posisi + uji live 7 model); `README`/`USAGE`/`PLAN`/`AGENTS.md`/`ARCHITECTURE.html` sinkron (angka gate, path, flag baru; referensi arsip mati dihapus).
- `docs/USAGE.md`: `/thinking` → picker `Enter` di `/model`, dropdown `builtin + /compact` saja, `provider add` minimalis, `read_image` cap 2M + b64 est; papan tombol akurat (`Esc` batal prompt kosong, `Ctrl+C/D` batal, `Ctrl+R/U/D` di search).
- `docs/ARCHITECTURE.html` + `PLAN.md` (2026-09-09): peta `lib/safe-open.ts` penulis/pembaca, controller `/model` scope-aware, angka gate terkini (min coverage 80/84 — funcs tak dikunci 81 karena berayun antar run).

## [0.9.6] - 2026-09-06 — Audit UX: Tab plan/build, did-you-mean, banner konteks, English-only, sync jujur

### Added
- **Tab kosong = toggle plan/build** (Tab berisi teks tetap completion; Shift+Tab tetap cycle semua mode) + test harness.
- **Did-you-mean** untuk typo slash (`/sessoons` → `Did you mean /sessions?`, ambang jarak ≤2) + `suggestSimilar` teruji.
- **Banner konteks saat start REPL** — satu baris `model · mode · cwd` (sebelumnya user buta posisi).
- **`/thinking [on|off]`** eksplisit (docs selama ini menjanjikannya, kode mengabaikan argumen).
- **Sync jujur**: `refreshProviderModels` kembalikan `{updated, failed}`; `sync` bedakan "belum ada provider" vs "deteksi gagal" vs "tak ada perubahan". `detectModels` lempar `unreachable:` bila tanpa satu pun respons HTTP (bedakan dari Anthropic yang memang tanpa /models).
- **Opsi A konsolidasi perintah** (audit UX): `/cost` & `/usage` = alias `/status` (satu sumber biaya sesi); `/resume [id]` = alias `/sessions [id]`; `/undo /redo /clear /copy /history` tetap perintah mandiri — TIDAK masuk dropdown Tab, tapi terdaftar di `/help` (DRIVER_HELP_COMMANDS, dropdown tetap 3 toggle + builtin).

### Fixed
- **`doctor` "ok" palsu** untuk provider 0 models → warn + saran `sync`; path config `~/...` literal (dulu `~\...` di Windows).
- **Error ganda**: event error provider kini ditunda (`takePendingError`, consume-once) — satu kegagalan = satu blok ✗.
- **Sandbox notice bocor** ke `exec --help` / exit no-provider — cetak di setup setelah provider lolos.
- **`models --match` noise** (header tanpa hasil), header kolom "Model" → "Models", `config detect --help` exit 0.
- **`auth login` non-TTY** fail-fast (dulu menembak jaringan lalu 400).
- **English-only**: `Bye.`, `Keyboard:`, `unknown mode`, `(80% used)`; regex penjaga diperluas.

### Removed
- **`/quit` + `/q`** — satu jalan keluar: `/exit` (plus Ctrl+C ganda). Alias tersembunyi lain tetap jalan, tak diiklankan.

### Docs
- USAGE: baris `doctor`, `/mode`, `/thinking [on|off]`, Tab toggle, tabel alias `/cost→/status` `/resume→/sessions`, catatan dropdown vs /help; hapus `/quit` dari alias.

### Test & Gate
- `1284 pass 0 fail` (91 file), `tsc` PASS, `lint` 0 warning, `gate:coverage` 80.77/84.56 (min80/84), `gate:pack` 22/22, `gate:bash` 0 bypass.

## [0.9.5] - 2026-09-06 — P13/P11/P10 P1: 2 tool, Responses chaining, retry jujur, TTL hierarkis, SWE-Lite pin, doctor

### Added — P13 P1 (sesi/memori/tool)
- **`submit_result` + `ask_user`** (`src/tools/`, registry 35→37, ARCH update): output terstruktur pengganti `response_format` (`exec --json` verbatim) + tanya user di tengah run (gated, view `promptAskText` via DI `setAskTextFn`, fail-closed non-TTY). Test: validasi, gating per-mode, fail-closed.
- **Plan artifact** (`.minicode/plans/<id>.md` tiap `todo_write`) + **`branchSession`** (fork history+turns) + **snippet verify** (`buildVerifySnippet` di `onOk`, opt-out `MINICODE_AUTO_MEMORY=0`).
- **TTL hierarkis** (`fact/decision/preference` 180, `summary` 90, `snippet` 14 hari) + **`access_count`** per row + `memory status --json` tampil kategori + scope; `scope: all` teruji gabung lokal+global.

### Added — P11 P1 (provider) + P10 P1 (pengukuran)
- **Responses chaining** (`previous_response_id` per model) + **probe `/responses`** (bukan substring) + **`mapReasoningToThinking`** + **retry-after dihonori** (tunggu cap 30 dtk → fallback; provider tunggal coba-ulang-di-tempat). Test fake-SSE/chaining (8 test, prinsip 3: solo-retry gagal di kode lama).
- **SWE-bench Lite**: `bench/swebench_lite_20.jsonl` 20 instance nyata terstratifikasi (12 repo, base_commit spot-check via GitHub API) + harness kini apply `test_patch` (bug: tanpanya skor fiksi) + flag env-provider + `--fake` hijau `0/20`.
- **`minicode doctor`** (runtime/providers/pricing/memory/sandbox/config, `--json`) + TUI harness **10/10** + lint **0 warning** (suppresi eksplisit string serangan) + coverage-min **80/84** (naik dari 77/81).

### Fixed
- **Regresi sleep 30 dtk**: retry-after besar + provider tunggal membuat 2 test lama timeout — test dipersempit (cap 100 ms, maksud cap tetap teruji), perilaku honori dipertahankan.
- **Koreksi audit**: klaim "mojibake" di test/detect-cache & bench/swebench ralat — verifikasi byte: UTF-8 bersih, yang rusak hanya decode konsol PowerShell 5.1. `import-convention` hijau membuktikannya.

### Deferred (jujur, bukan diam)
- **OAuth Copilot/ChatGPT** (P11 P2): endpoint device-flow tak terverifikasi — mengarangnya melanggar Prinsip 2.
- **81/83 coverage**: 80.75/84.52 — sisa di area lama (lsp/config/repl).

### Test & Gate (update run nyata 2026-09-06)

- **SWE-Lite-20 nyata: 0/20** (`nemotron-3.5-lightning-free` gratis via OpenCode Zen, 25 steps, ~56 mnt) — dengan catatan validitas: reproduksi manual membuktikan lingkungan (Python 3.14 + pytest 9 vs repo era 2022) mendominasi hasil (`pytest-11143` lolos tanpa patch; `requests-1963` collection error `cgi`). Harness end-to-end (clone→test_patch→agen→pytest) terbukti jalan; skor comparable butuh Docker per-instance.
- `1270 pass 0 fail` (90 file; TOCTOU 3 skip di Windows by design), `tsc` PASS, `lint` 0 warning, `gate:coverage` 80.75/84.52 (min80/84), `gate:pack` 22/22, `gate:bash` 0 bypass.

## [0.9.4] - 2026-09-06 — Kritik S1–S5: side-map signature, code_run tanpa shell, trash bersama, read_image utuh

### Fixed
- **M0.1 self-defeating (P0):** `__extra_content` di `args` ditolak `validateArgs` (`unknown property`, semua schema `additionalProperties:false`) — tool call Gemini thinking gagal validasi. Kini side-map `toolCallId→extra_content` (consume-once, cap 500) di `vendor/minicore/src/providers/openai-compat.ts`; args bersih, echo `extra_content` saat replay. Vendor sync `caba755c`.
- **`code_run` shell-injection:** kode via `node -e` + `shell:true` mengeksekusi `$(...)`/backtick di shell dulu. Kini spawn langsung (argv, tanpa shell) + tree-kill dua OS + gate sandbox tetap.
- **`move_file` overwrite diam-diam:** dest yang ada dibackup ke trash dulu (catat path di hasil).
- **`read_image` potong base64 diam-diam:** kini kirim utuh + lapor `(bytes mime, tokens)`; cap tetap di file-size.

### Added
- **`src/lib/trash.ts`:** `trashDir`/`trashFile` bersama (`.minicode/.trash`, gitignored, cap 100 terbaru) untuk `delete_file` + backup `move_file` (ARCH + AGENTS map update).
- **Test:** `thought_signature` fake-SSE (args bersih + echo replay), `$(echo PWNED)` tak dieksekusi, backup overwrite — `1237 pass 0 fail`, coverage 79.98/83.19.

### Deferred
- **T0.3 (`plan` vs `readonly` split):** ditolak test `plan mode: read-only` — `plan` tetap strict; kembali bila ada desain `write_plan` + test baru. Gate 77/81 sementara sampai test P1 mendarat.

## [0.9.3] - 2026-09-06 — code_run/bash timeout tree-kill + regression tests 4 tools

### Fixed
- **`code_run` timeout diabaikan → hang selamanya:** tool meneruskan `timeout`, padahal `bash` membaca `timeoutMs` (`src/tools/bash.ts:157`) — loop tak berujung tidak pernah dibunuh. Kini dipetakan (`src/tools/code_run.ts:33`).
- **Kill yatim Windows:** `p.kill()` hanya membunuh wrapper `cmd.exe` — cucu `node -e` tetap hidup menahan pipe (`close` tak pernah datang). `killTree()` baru (`src/tools/bash.ts`): `taskkill /T /F` langsung saat timeout/abort di win32; process-group kill (`kill(-pid)`, spawn `detached`) di POSIX. Terverifikasi: 4 proses yatim `while(true)` dari uji sebelumnya dibersihkan, uji timeout kini selesai <3s (dulu hang >120s).
- **Artefak bench:** `bench/swebench_results.json` hasil run `--fake` masuk lint (formatter) — dihapus + masuk `.gitignore`.

### Added — test
- **`test/new-tools.test.ts` (10 test):** move (pindah/auto-mkdir/deny), delete (soft-delete `.trash` + restore/deny), read_image (mime/base64/cap), code_run (deny tanpa sandbox/echo/timeout-kill), permission mapping readonly/plan/allow-all. `1234 pass 0 fail`, coverage naik 77.81/81.24 → **80.03/83.09**.

## [0.9.2] - 2026-09-06 — P10/P11/P13 P0: --cwd repo-wide, O_NOFOLLOW, pricing, max_tokens, thought_signature, 4 tools, memory categories

### Added — P13/P11/P10 P0
- **`--cwd` repo-wide** `cli/router.ts:subArgv` + `subGetArg` tanpa boundary prompt — semua subcommand (`sessions`/`stats`/`providers`/`memory`) kini honor `--cwd` setelah subcommand; hapus workaround `subArg` di `memory.ts`.
- **`O_NOFOLLOW` safe-open** `src/lib/safe-open.ts` — helper `safeOpenRead`/`safeReadFile`/`assertSafeWriteTarget` (POSIX O_NOFOLLOW, Windows dev+ino fallback); di-wire ke `read_file`/`edit` (sisa 4 tool backlog P1).
- **4 tool baru** `src/tools/` `move_file`/`delete_file` (soft-delete `.trash/`), `read_image` (base64 + `estimateImageTokens`), `code_run` (python/node via sandboxed bash, gate `MINICODE_SANDBOX=os|docker`).
- **Pricing refresh** `src/policy/pricing.ts:30` Opus `$15/$75→$5/$25` + `gpt-5`/`gpt-5-mini`/`claude-sonnet-4-6`/`gemini-3`/`deepseek-v4`; `pricing status` tampil `ageH` + `(stale)`.
- **Memory kategori** `src/memory/vector.ts:30` kolom `category`/`tags` + `write_memory {category,tags}` (default `fact`); MMR boost `decision` +0.1; `searchHybrid scope=all` merge global+local; `compaction` persist summary opt-out `MINICODE_AUTO_MEMORY=0`.
- **Responses API stub** `src/providers/responses.ts` `/v1/responses` `store:false`, `reasoningEffort` generik `src/config.ts:reasoningEffort` → `reasoning_effort` (openai) / `thinking` (anthropic).
- **SWE-bench Lite** `bench/swebench.ts` clone+checkout+pytest (20 instance, `store` hasil, fake fallback).

### Fixed
- **Router `max_tokens` 8192** `src/providers/anthropic.ts:73` + warning `length` via `extension:warning`.
- **Thought_signature** `vendor/minicore/src/providers/openai-compat.ts` preserve `extra_content` verbatim via `__extra_content` di `args` + echo di `toMessages` (tanpa seam `providerMeta` agar vendor:check tetap hijau).
- **Retry-after honori** `src/providers/router.ts:122` — 429 dengan `retryAfter` ditunggu `min(100ms)` lalu fallback (jangan bakar daftar tanpa tunggu); cap `maxRetry 30s`.
- **Vendor sync** `vendor/minicore/VENDOR.md` hash `8e937104eb878555` + source `D:/git/minicore` di-sync.

### Test & Gate
- `1224 pass 0 fail / 8 skip`, `gate:coverage` 77.81%/81.24% (min77/81 — turun sementara karena 4 tool baru tanpa test, naikkan lagi setelah test P1), `lint` 9 warn, `tsc` PASS, `gate:pack` 22/22, `vendor:check` PASS.

## [0.9.1] - 2026-09-06 — UI Shell-Max (P12) + plan P13

### Added — P12 UI Shell-Max
- **`/copy` slash command** (`cli/repl.ts:44`): salin teks model + hasil tool turn terakhir ke clipboard terminal via OSC 52 (`src/ui/assistant/simple.ts` `writeClipboardOsc52`), cap 200_000 char (`getLastTurnText`); jujur saat terminal menolak clipboard ("clipboard needs a TTY terminal") atau belum ada output.
- **Reverse-i-search** (`src/ui/input/input.ts:138`): `Ctrl+R` memfilter history dengan substring, tampil inline sebagai prompt pengganti (bukan overlay) — `(reverse-i-search)`/`(failed reverse-i-search)`; batal dengan Esc/Ctrl+C mengembalikan draf asli.
- **Multiline input** (`src/ui/input/prompt-engine.ts:187`): `Ctrl+J` menyisipkan newline (ops-in eksplisit; hanya CR/Enter yang submit; paste tetap digepeng jadi spasi); render per baris visual + kursor di posisi logis; history JSON per baris mendukung entri multiline.
- **Statusline kaya opt-in** (`cli/setup.ts:293`): `MINICODE_STATUSLINE=rich` menampilkan token kumulatif + biaya sesi di spinner turn (`turn-status.ts` `getStats` callback DI dari composition root — UI tetap tanpa impor policy).
- **Preservasi spasi ganda** (`src/ui/render/wrap.ts:44`): wrap pecah di batas run whitespace (ASCII art/tabel utuh), tidak mengjustify baris ber-spasi-ganda; trimEnd saat flush.
- **Picker highlight query** (`src/ui/screens/picker.ts:33`): substring filter ditebalkan sebelum truncate — user tahu kenapa item cocok.
- **Table vertikal** (`src/ui/render/table.ts:44`): terminal sempit (`<40` kolom) + banyak kolom render `key: value` vertikal, bukan baris terpotong.
- **Diff dua sisi** (`src/ui/render/diff.ts:31`): `indexOf` tanpa slice (O(n) per langkah), reorder ambigu dahulukan add (3 op), sorot kata berubah via LCS kecil dengan guard noise >60% (`markChangedWords`).
- **Accessibilitas**: live-region `MINICODE_A11Y=1` di approval (`src/ui/approval/prompt.ts:20`); spinner tunggal dari `glyphs.spinnerFrames` (`turn-status.ts`); sanitasi hasil jaringan di provider-manager & wizard (`sanitizeAnsiLine`); dashes clamp di section (`theme.ts:296`).

### Fixed — P12 shell-first
- `/clear` kini banner `--- cleared (scrollback preserved) ---` — scrollback terminal tetap menjadi satu-satunya transcript (tidak dihapus).
- Harness TUI output-driven (`test/helpers/tui-harness.ts`): `waitForOutput` + `answerSequence(expect[])` + `once` auto-remove, kirim ke listener raw terbaru — timeout manager 30000→5000 (`test/tui-harness.test.ts` self-test).
- Thai/Lao delete-aware (`src/ui/input/prompt-engine.ts:91` `deletePrevUnit`): diakritik terakhir dulu, kursor bertahan — satu suku kata butuh N tekan (bug Claude #83449).

### Test & Gate
- `1225 pass 0 fail / 8 skip`, `gate:coverage` 81.44%/83.65% (min81/83), `lint` 9 warn (pre-existing), `tsc` PASS, `gate:pack` 22/22. Manager-flows 10/10 (DoD P12, dijalankan ulang saat run isolasi).

## [0.9.0] - 2026-09-06 — P9 Memory/RAG hardening (P0-P2) + P8 CLI flag-injection hardening

### Fixed — CLI flag-injection (P8)
- `cli/args.ts:53` `hasFlag`/`getArg`/`promptFromArgs` kini berhenti di prompt word pertama: prompt `"review --allow-all"` tidak lagi mengaktifkan flag, flag dikenal setelah prompt dianggap bagian prompt (anti injection). Nilai numerik negatif (`-5`) tetap diterima sebagai value.
- `cli/router.ts:8` scan subcommand pertama yang bukan flag (skip `VALUE_FLAGS` + nilainya) → `minicode --cwd /tmp providers` kini rute benar.
- `cli/index.ts:138` sanitasi `resumeId` + `sessionId` (`[^A-Za-z0-9._-]` → `-`, slice 64); plan re-exec `env MINICODE_PLAN="0"` + `await child.on("exit")` tanpa `process.exit(0)` ganda.
- `src/app/mentions.ts:23` `@mention` pakai `isRealPathOutsideRoot` (symlink-aware); `cli/commands/exec.ts:27` sanitasi `sessionId` + guard `budget` `isFinite`; `cli/repl.ts:115` `cycleMode` kenal `allow-all` tanpa mengaktifkannya diam-diam; `cli/commands.ts:119` `join` tanpa hard-code `\\`.
- **Batasan jujur (pre-existing, repo-wide):** `--cwd`/value-flag setelah nama subcommand tidak terparse `getArg` bersama (token subcommand = batas prompt) — terbukti `sessions list`/`providers` mengabaikan `--cwd`. Command baru `memory` parse lokal dari `args[1..]` agar flag-nya honored; perbaikan global ditunda agar tidak merusak boundary anti-injeksi.

### Fixed — Memory/RAG P0 (rilis blocker)
- `src/tools/memory.ts:17` `read/write/forget_memory` pakai `ctx.cwd ?? process.cwd()` (sebelumnya hardcode `process.cwd()` → `--cwd` bocor, regresi pola 0.8.0).
- `src/memory/vector.ts:137` + `src/session/persistence.ts:82` `withBusyRetry` `Atomics.wait` sync → `async` + `await Bun.sleep` (freeze event-loop ≤175ms saat `Pool(3)` busy).
- `src/memory/vector.ts:245` threshold `MIN_SCORE` (`0.20` hybrid / `0.25` keyword-only, `LIMITS` baru) — skor `0.05` tidak lagi di-inject ke system prompt.

### Added — Memory/RAG P1 (kualitas & keamanan)
- **P1.1 FTS5/index:** `memory_fts` virtual (`porter unicode61`) + trigger sync + `idx_memory_text_lower`; `searchHybrid` pakai `MATCH … ORDER BY rank` dengan fallback LIKE (escape `%_\\`).
- **P1.2 TTL/MAX_ROWS:** `LIMITS.MEMORY_TTL_DAYS 90` + `MEMORY_MAX_ROWS 5000` + prune + `VACUUM` periodik di `addMemory`.
- **P1.3 Embedding meta:** kolom `model,dim` (migrasi best-effort); dim-mismatch → warn sekali + fallback keyword-only (sebelumnya skor 0 senyap).
- **P1.4 SSRF strict:** `isPrivateHostWithDns(host, {strict, timeoutMs, noCache})` (`src/lib/net.ts:38`); `embedTexts` fail-close + `redirect:"manual"` max 2 hop dengan cek tiap hop.

### Added — Memory/RAG P2 (polish)
- **P2.1 MMR:** `mmrRerank` (dedup cosine >0.92 + MMR λ=0.7, fallback Jaccard tanpa vektor); `MemoryHit.createdAt`; display `(score 0.82, 2026-09-01)` di RAG + tool.
- **P2.2 Chunking:** `splitMemoryChunks` (2000 char + overlap 200), kolom `parent`, embed batch 1 call, return parent id (ganti truncate).
- **P2.3 Observabilitas:** `chmod 600` untuk `vector.db-wal/-shm`; `memoryHits` di `RunTrace` → `createRagLayer` → `CliSession` → kedua `writeTrace`.
- **P2.4 Command:** `minicode memory status [--json]` baru (`cli/commands/memory.ts` + rute router + entri help JSON; `getMemoryStats`): rows, bytes DB/WAL/SHM, sebaran model/dim, range tanggal, hit-rate RAG dari traces.
- **Bug nyata saat verifikasi:** `deleteMemoryByQuery` return 7 untuk 1 baris — `sqlite3_changes()` ikut menghitung tulis trigger FTS. Kini hitung-dulu-sebelum-DELETE.

### Test & Gate
- `1199 pass 0 fail` (8 baru `memory-p1`, 8 baru `memory-p2` — test MMR terbukti gagal tanpa fix, 3 baru `cli-subcommands` memory), `gate:coverage` 81.23%/83.18% (min81/83 — funcs min dinaikkan 80→81), `lint` 9 warn (pre-existing), `tsc` PASS, `gate:pack` 22/22.
- Flake TUI `provider/model-manager-flows` berpindah tiap run (pre-existing, di luar jalur memory — hijau saat run isolasi).

## [0.8.2] - 2026-09-03 — Session P0-P1: resume turnCount, NaN guard, checkpoint bash, hook timeout, compacted flag

### Fixed
- `cli/setup.ts:114` resume `turnCount` dari `persistence.ts: MAX(turn_idx)+1` → seed `SessionConfig.turnCount` (vendor `session.ts:40` + `app/session.ts`); `cli/index.ts:134` sanitasi `sessionId` + `setup.ts:99` `Number.isFinite` fallback untuk `--budget/--timeout/--max-steps` (NaN → warn + undefined, budget mati → fixed)
- `cli/setup.ts:183` checkpoint non-git: `post` `snapshotWorkspace` penuh (bash/git) bukan hanya `edit/write` → undo di non-repo kini kembalikan file dari `bash`
- `src/hooks/run.ts:35` timeout 5s `SIGTERM→SIGKILL` untuk hook gantung
- `vendor/loop.ts:38` `compactStore → boolean didCompact` (hanya `compacted=true` bila panjang berubah) + `vendor/session.ts:40` `turnCount/stepCount` di `SessionConfig`

### Test & Gate
- `1180 pass 0 fail` (12 baru `cli-setup-coverage`), `gate:coverage` 81.17%/83.45% (min81/83), `lint` 17 warn, `tsc` PASS. `P2.1` cwd jail sudah 0.8.0, UI P0-P2 sudah 0.8.1.

## [0.8.1] - 2026-09-03 — UI P0-P2: approval sanitize, grapheme, streaming paste/mouse/UTF-8, fence & inline code, highlight, SGR

### Fixed (P0 — keamanan/hang)
- `approval/prompt.ts:22` sanitize `toolName/actionSummary` (`sanitizeAnsiLine`, try/catch `JSON.stringify` circular)
- `input.ts:117` & `picker.ts:110` raw-mode `try/finally` (terminal tidak tertinggal raw saat `buildRenderSpec` throw)
- `provider-manager.ts:152` & `model-manager.ts:83` `busy` `try/finally` (deadlock bila `onAdd` throw)
- `provider-manager.ts:130` & `model-manager.ts:89` hapus `\r\n` di `suspend` (gap 1 baris scrollback)
- `prompt-engine.ts:265` streaming decoder `decodeKeysStream` + `createDecoderState` (UTF-8 split, bracket paste `ESC[200~…201~`, mouse `ESC[M`+3 byte mentah & `ESC[<…M/m`)
- `prompt-engine.ts:65` `toGraphemes` via `Intl.Segmenter` (ZWJ 👨‍👩‍👧, flag 🇮🇩, `askSecret` & `picker` backspace grapheme)
- `simple.ts:48` `parseFence` sinkron dengan `markdown.ts:37` (char/len) + highlight di dalam fence; `width.ts:110` CSI truncated tidak greedy (` ` teks tidak ditelan); `theme.ts:312` `ANSI_PATTERN` sinkron + truncated CSI `|\\[[0-9;?<=>]*`

### Fixed (P1 — render)
- `markdown.ts:14` inline `code` placeholder `\u0000` sebelum `**bold` (`` `**a**` `` tidak jadi bold)
- `highlight.ts:139` `findCommentIndex` string-aware (`"https://"` & `"#fff"` tidak jadi komentar)
- `turn-status.ts:76` & `spinner.ts:28` sanitize `label/message` (`sanitizeAnsiLine`)
- `width.ts:184` `chunkByWidth` bawa open SGR ke potongan berikutnya

### Changed (P2 — UX kecil)
- `prompt-engine.ts:19` `MAX_VISIBLE` adaptif `rows-3` via `buildRenderSpec(maxVisible)`; `input.ts:105` `Math.max(1,min(10,rows-3))`
- `input.ts:139` `keep = min(max(8,cols-4), max(4,cols-1))`
- `input.ts:279` history lock reset `ctrl-w/ctrl-u/tab/left/right` + `wizard.ts:73` `readline` → `askLine`
- `diff.ts:12` dokumentasi O(n·m) heuristik & cap

### Test & Gate
- `1168 pass 0 fail` (highlight pad ` 1` → `   1`), `gate:coverage` 82.66%/84.88% (min81/83 PASS), `lint` 17 warn, `tsc` PASS. `P2.6` `diff.ts` batas O(n·m) didokumentasi.

## [0.8.0] - 2026-09-02 — Penghapusan tema + perbaikan cwd jail (P2.1) + hardening lanjutan

### Fixed
- **P2.1 `cwd` jail tuntas (P0 keamanan):** semua tool file (`write_file`, `read_file`, `edit`, `apply_patch`, `glob`, `grep`, `bash`, `git_*`) sebelumnya memakai `process.cwd()` sehingga `--cwd` menyesatkan dan `isPathOutsideRoot` ter-anchor ke direktori yang salah. Ditambah seam aditif `cwd?: string` di `vendor/minicore/src/core/tool.ts:22` + `executor.ts` + `session.ts` + `loop.ts`, diteruskan dari `src/app/session.ts:96` → kernel, dan `src/tools/*` kini memakai `ctx.cwd ?? process.cwd()` dengan `resolve(sessionRoot, raw)` + file-lock per-cwd. `vendor/minicore` sinkron (`19 file, 4591de2f578d9f4c`), `vendor/minicore` source di `D:\git\minicore` juga diperbarui.
- **Penghapusan fitur tema:** `src/ui/render/themes.ts` dihapus, `src/ui/render/theme.ts` jadi palet tunggal TOKENS dark, flag `--theme`/`/theme`/`MINICODE_THEME`/`themeState`/`applyTheme` dihapus dari `cli/index.ts` & HELP, test `theme.test.ts` disesuaikan (palet tunggal, NO_COLOR), `cli-session` block `--theme` dihapus, `no-frozen` komentar diperbaiki, `extreme-mcp` diselaraskan ke English.
- **Lint & lockfile:** `bun.lock` dinormalisasi via `bun install`, 9 file terhapus dari `outputs/` (audit lama) + `.verdent` plan diarsipkan, `package-lock.json` ganda dihapus, `import-convention` & `extreme-mcp` lolos setelah English-only.

### Changed
- `AGENTS.md` Jebakan ditambah catatan `ToolContext.cwd` + versi badge `v0.8.0` di `docs/ARCHITECTURE.html`.

### Test & Gate
- `1168 pass 0 fail`, `gate:coverage` 82.79%/85.22%, `gate:pack` 22/22, `gate:bash` 0 bypass, `extreme-bash-fuzz` 0/2582, `extreme-mcp` 67/67. `extreme-shadow-git` skala 2000 file masih timeout 300s di Windows (unit `shadow-git.test.ts` 22 pass — hambatan I/O Windows, bukan regresi).

## [Unreleased] — Audit UI/UX (V6) + uji live multi-provider (V7) + bug hunter UI (V8)

### V8 — bug hunter UI/UX: 31 temuan dari tiga ronde

Metode: harness adversarial per lapisan render, lalu **verifikasi dampak** dengan menggerakkan TUI sungguhan. Pemisahan itu penting — 5 dari 12 temuan ronde 1 ternyata tidak berdampak (simple logger tidak merender diff card; tidak ada sumber nyata untuk newline di tabel), dan tidak diperbaiki.

| Metrik | Sebelum V8 | Sesudah |
|---|---|---|
| Test | 913 pass | **1064 pass** |
| Coverage | 80,52% / 83,10% | **81,46% funcs / 83,03% lines** |
| Temuan hunter tersisa | — | **0** (tiga harness) |

**Lebar karakter salah di seluruh lapisan** — akar, bukan gejala. Semua kode menganggap 1 karakter = 1 kolom. Bukti: 38 code point CJK menempati **73 kolom** di terminal 40 kolom; baris membungkus sendiri dan frame TUI (dihitung per baris) rusak. Ditambah `src/tui/width.ts` (tabel EastAsianWidth UAX #11): CJK/Hangul/kana/emoji 2 kolom, combining mark & ANSI 0 kolom. Seluruh pemanggil dialihkan: `truncAnsi`, `renderTable`, `wordWrap`, `justifyLine`, `renderDiffCard`, kursor fullscreen, `scrollableLine`, `padToWidth`.

**Teks model bisa mengendalikan terminal.** Terverifikasi sampai ke terminal: `provider:text` berisi `aman\x1b[2J\x1b[H\x1b[?1049hJAHAT\x1b]0;bajak\x07` benar-benar membersihkan layar, keluar dari alternate screen, dan mengubah judul jendela. Model, server MCP, atau isi berkas bisa memanipulasi tampilan. Ditambah `src/tui/sanitize.ts`: **hanya SGR** (`ESC[…m`) yang lewat; CSI non-SGR, OSC, DCS, dan C0 selain tab/newline dibuang. Diterapkan ke `provider:text`, hasil tool, argumen tool, dan isi todo — warna diff card tetap utuh.

**Fence markdown tanpa bahasa didekorasi sebagai markdown.** `npm run build -- --flag=*value*` kehilangan bintangnya karena dianggap italic. Hanya fence *berbahasa* yang dilindungi sebelumnya; fence tanpa bahasa justru bentuk paling umum untuk perintah shell.

**Byte kontrol masuk prompt.** Ctrl+L/K/T/Z jatuh ke cabang `char`: `"teks"` + tiga tombol itu mengirim `"teks\f\u000b\u0014"` ke model — tak terlihat di layar, tapi ikut terkirim. Kini semua C0 tak dikenal dibuang. Paste multi-baris juga: newline masuk baris input dan membuat frame 26 baris di terminal 24; kini newline/tab jadi spasi.

**Semua overlay mengabaikan terminal kecil.** `picker` dan `panel` punya lantai minimum (`Math.max(44, …)`, `Math.max(40, …)`, `Math.max(5, …)`) yang memaksa ukuran lebih besar dari terminal: label 55 kolom digambar di terminal 40 kolom, 6 baris dicetak di terminal 3 baris. Lantai dihapus.

**Wizard setup adalah titik terlemah** — ironis karena ia hal pertama yang dilihat pengguna baru. Memakai `readline` dengan `"Choice [1-15]"` sementara REPL punya `runPicker` (panah + filter), dan **nomor di luar rentang diam-diam jatuh ke pilihan pertama** sehingga mengetik `99` memilih OpenAI tanpa memberi tahu. Ditulis ulang memakai picker; 11 test baru (sebelumnya nol).

**`provider-manager` menulis config dengan konfirmasi paling minim.** `Delete "x"? [y/N]` tidak menyebut berapa model ikut hilang maupun bahwa provider itu sedang aktif. Kini menyebut jumlah model, memperingatkan bila aktif, dan menandai `(aktif)` di daftar.

**Lima perintah berfungsi tapi tidak bisa ditemukan.** `/clear`, `/exit`, `/quit`, `/compact`, `/history` ditangani tapi tidak terdaftar — tidak muncul di `/help` **dan** tidak bisa dilengkapi Tab. Kini 21 entri, dengan `hidden: true` untuk alias. `/help` juga dipecah: 29 → 18 baris (muat di overlay 24 baris), pintasan lengkap ke `/help tombol`.

**Alternate screen ditulis tanpa memeriksa dukungan terminal.** `isTTY` tidak menjamin VT — `TERM=dumb`, Emacs shell, conhost lama menampilkan `ESC[?1049h` sebagai sampah. Ditambah `supportsVt()` dan `MINICODE_NO_ALT=1`.

**Pola beku, kali ketiga.** Setelah objek warna `c` (V6) dan palet tema (V6), kini `glyphs` (`supportsUtf8` dievaluasi saat import) dan `const OK = glyphs.check` di `commands.ts`. Semuanya jadi getter/fungsi. Tiga kali bug yang sama menandakan kecenderungan struktural — ditangani sebagai item rencana, bukan tambalan.

Lainnya: `renderTable` melempar pada `width` negatif; nilai bernewline memecah baris tabel; kata/URL/CJK tanpa spasi tidak di-wrap (kini dipecah per kolom); `renderDiffCard` tidak membatasi panjang baris; penanda hasil aksi bercampur (`[OK]`/`[FAIL]` vs kalimat vs tanpa penanda); bahasa campur Inggris–Indonesia di wizard, provider-manager, dan pesan slash command.

### V8 — test baru (+151)

`width.test.ts` (34) · `sanitize.test.ts` (26) · `tui-overlay.test.ts` (18) · `wizard.test.ts` (11) · `cli-help-language.test.ts` (29) · plus tambahan di `tui-diff`, `tui-table`, `tui-format`, `prompt-engine`.

### V7 — empat bug yang hanya muncul dengan provider sungguhan

Diuji dengan dua gateway nyata: `gorouter.app` (4 model Claude) dan OpenRouter (**18 model gratis**, matriks penuh). Yang diukur bukan kualitas model, tapi apakah lapisan minicode bertahan di bawah token nyata, rate-limit mendadak, endpoint hilang, dan harga yang tidak ada di tabel.

| Metrik | Sebelum V7 | Sesudah |
|---|---|---|
| Test | 876 pass | 913 pass |
| Model gratis OpenRouter berhasil tool-call | — | 12/18 (6 sisanya ditolak provider: 429/403/404) |
| Resolve-rate terukur | 0,00 (5 trace provider maintenance) | **1,00** (5/5 tugas berpemeriksa objektif) |

**`/cost` dan `--budget` selalu 0 setelah turn pertama** (`src/policy/usage.ts`). `fullscreen-driver` memanggil `usage.reset()` setiap turn, dan `reset()` menghapus satu-satunya akumulator yang ada. Bukti live: 51.915 token nyata dilaporkan sebagai **0 token, $0.0000**. Konsekuensinya berantai — `/cost` yang berjudul "biaya sesi" selalu nol, header REPL kembali `$0.0000` setelah setiap jawaban, dan `--budget` **tidak akan pernah terpicu** berapa pun yang dibakar. Kini ada dua akumulator: `get()` per-turn dan `getSession()` kumulatif. Setelah perbaikan 74.354 token / $0.3745 terlaporkan benar, dan `--budget 0.05` benar-benar menolak prompt berikutnya.

**`cli/errors.ts` punya 10 test tapi tidak dipanggil dari mana pun.** Renderer memakai `formatProviderError()` yang mencetak `[kategori] <pesan mentah>`, sehingga body JSON provider tumpah utuh. Satu 429 OpenRouter menghasilkan 400+ karakter berisi `metadata`, `provider_error_code`, `limit_source`, dan URL dokumentasi — di dalam frame TUI selebar 100 kolom. Kini semua jalur error (`formatProviderError`, `formatError`, event `provider:extension`, dan `catch` di `submit()`) melewati satu formatter. Ditambah `extractProviderDetail()` yang tahu bentuk-bentuk nyata: OpenRouter menyembunyikan alasan sebenarnya di `metadata.raw` sementara `message` hanya berbunyi "Provider returned error"; Cloudflare mengirim HTML dengan `<title>`; body streaming bisa terpotong di tengah JSON.

Hasilnya: `z-ai/glm-5.2:free is temporarily rate-limited upstream.` + saran dari `remedy_hint` provider, bukan dump JSON.

**Model gratis dihargai seperti varian berbayarnya** (`src/policy/pricing.ts`). Pencocokan per-segmen mengabaikan sufiks `:free`, jadi `z-ai/glm-5.2:free` dilaporkan $1,25/M padahal OpenRouter menyatakan `prompt=0 completion=0` (diverifikasi lewat `/api/v1/models`). Dampaknya bukan kosmetik: `--budget` bisa memutus sesi yang sebenarnya tidak berbiaya sepeser pun. Kini `:free` selalu $0, kecuali overlay punya entri eksplisit untuk id ber-`:free`.

**`exec` mengirim nilai flag ke model sebagai bagian prompt** (`cli/commands/exec.ts`). Filternya `a !== getArg("--model") && a !== getArg("--cwd")` hanya membuang nilai dua flag. Terverifikasi: `exec "ulangi: MARKER" --provider gorouter --session uji --timeout 120000` mengirim `"MARKER gorouter uji 120000"`. Pada satu run model benar-benar tersesat — 38.072 token ($0,19) dipakai menebak apakah "gorouter" itu proyek Cloud Foundry dan apakah "60000" itu port atau timeout. Kini memakai `promptFromArgs()`, implementasi yang sama dengan jalur non-exec.

### V7 — perbaikan pendukung

- **`--budget 0.001` tampil sebagai `$0.00`** → pesan pemutusnya berbunyi `$0.0601 > $0.00`, user membaca batas nol. `src/tui/money.ts` baru: di bawah $1 pakai 4 desimal.
- **Model tidak tahu direktori kerjanya.** System prompt tidak menyebut cwd, jadi model menebak — pada uji `--plan` ia menyimpulkan *"cwd saat ini adalah /, yang tidak writable"* padahal berjalan di workspace Windows normal. Ditambah bagian `# Environment` (cwd + platform).
- **Trace bermodel kosong** saat user tidak memberi `--model`, sehingga tidak bisa diatribusikan ke provider dan kolom Status di `minicode providers` selalu "belum dipakai" meski sudah dipakai. Kini memakai model efektif hasil substitusi router.
- **Kompaksi LLM mengabaikan signal yang sudah abort** (`addEventListener` tidak memicu untuk signal ter-abort), jadi request ringkasan tetap terkirim setelah user membatalkan.

### V7 — test baru (+37)

- `test/usage-session.test.ts` (8) — pemisahan turn vs sesi, akumulasi lintas turn, basis harga setelah reset.
- `test/money.test.ts` (6) — nilai kecil, batas $1, negatif, NaN/Infinity.
- `test/errors-usage.test.ts` (+13) — bentuk error nyata: 429 OpenRouter dengan `metadata.raw`, 403 agentic-harness, 404 no-tool-support, 502 HTML Cloudflare, body JSON terpotong.
- `test/providers-build.test.ts` (9) — id provider diteruskan (tanpa ini router memetakan semua ke satu kunci generik), hybrid Anthropic/OpenAI, provider OAuth tanpa login dibuang bukan dikirim dengan token undefined.
- `test/compaction.test.ts` (14) — ringkasan menggantikan prefix, hasil tool sukses ikut sebagai fakta, error ditandai, fallback saat provider gagal/kosong, abort diteruskan.
- `test/phase4-auth-git-pricing.test.ts` (+2) — `:free` tidak mewarisi harga.

### V7 — yang diverifikasi aman

- **API key tidak bocor**: 0 temuan pada seluruh berkas repo, tidak ada di `traces.jsonl`, tidak ada di output UI; `scrubSecrets` meredaksi di pesan error.
- Streaming 40 baris tidak melebihi tinggi terminal, tidak ada baris lewat lebar kolom, tidak ada sekuens ANSI tergantung.
- Tool call berantai (`write_file` → `bash` → `bash`) dengan berkas nyata di disk dan `bun test` lolos 6/6.
- Ctrl+C dan Esc menghentikan run tanpa keluar; REPL menerima prompt lagi sesudahnya.
- `--plan` benar-benar menolak `write_file`.
- Rangkaian 429 → 404 → 403 → model sehat: REPL pulih tanpa satu pun `unhandledRejection`.
- Gate lain tetap hijau: bash-fuzz 0 bypass, shadow-git 31/31, MCP adversarial 67/67, pack-check 22/22, vendor sinkron.

### V7 — masalah diketahui yang TIDAK diperbaiki

**`--cwd` diabaikan oleh semua tool file.** Berkas yang diminta di `--cwd <dir>` muncul di direktori proses. `write_file.ts:24` memakai `process.cwd()` sebagai root — begitu juga `read_file`, `edit`, `patch`, `glob`, `grep`. Sudah didokumentasikan sebelumnya di `scripts/human-sim.ts` ("kernel ToolContext tak punya cwd"). Tidak disentuh karena memperbaikinya berarti mengubah kontrak `ToolContext` di kernel yang dibekukan — keputusan arsitektur, bukan perbaikan UI. Konsekuensinya nyata: `--cwd` menyesatkan, dan jail keamanan ter-anchor ke direktori yang salah.

**Overhead gateway di luar kendali minicode.** Diukur langsung: request kosong ke gorouter sudah memakan 6.847 prompt token ($0,034) sebelum minicode mengirim apa pun. Kontribusi minicode sendiri ~4.455 token (system prompt 1.405 + skema 31 tool 3.050). Gateway juga menimpa identitas — ditanya namanya, model menjawab nama agent lain. Perilaku provider, tapi perlu diketahui saat menilai biaya.

---

## Audit UI/UX (V6)

Basis: audit UI/UX menyeluruh ([docs/PLAN_UIUX_V6.md](docs/PLAN_UIUX_V6.md)) — 24 temuan, diverifikasi dengan menjalankan tiap subcommand, mengemudikan TUI lewat harness keystroke sintetis, dan memanggil `handleBuiltinCommand` langsung.

| Metrik | Sebelum | Sesudah |
|---|---|---|
| REPL menerima prompt | **tidak** (mati bisu) | ya |
| Test | 747 pass | **859 pass** |
| Berkas UI tanpa cakupan test | 19 | 6 (jalur yang butuh proses nyata) |
| Coverage agregat | 71,95% funcs / 76,76% lines | **79,33% / 82,15%** |
| Gate coverage | min 69 / 74 | min 77 / 80 |

### Fixed — blocker

- **REPL mati bisu pada prompt pertama.** `render()` memanggil `startSpinner()`, yang memanggil `tickSpinner()` → `render()` lagi. Karena `spinnerTimer` baru terisi *setelah* `render()` selesai, guard `if (spinnerTimer) return` selalu lolos: rekursi tak berbatas → `RangeError: Maximum call stack size exceeded`. `onLine` **tidak pernah** terpanggil, layar berhenti pada prompt user tanpa spinner, tanpa jawaban, tanpa pesan error. Bug masuk pada `a4fcfa9` ("spinner coalesce") dan tidak tertangkap satu test pun — lapisan interaktif punya nol cakupan.

  Perbaikan: `startSpinner` men-set timer sebelum render. Dijaga oleh test `"Enter memanggil onLine tepat sekali"`, yang **gagal** pada commit sebelum perbaikan.

- **`--interactive` crash di luar TTY.** `setRawMode is not a function` beserta stack trace mentah, karena `setRawMode` dipanggil tanpa cek `isTTY` — semua komponen lain (`askLine`/`runPicker`/`runPanel`) punya fallback ini. Kini ada `attachNonTty()`: event dilaporkan sebagai baris polos.

- **Kegagalan async tak lagi bisu.** `unhandledRejection` ditampilkan sebagai baris transcript, bukan membuat layar diam.

### Fixed — tema & warna

- **`/theme` dan `--theme` tidak berefek apa pun.** Objek `c` di `src/tui/theme.ts` mengevaluasi token tema **saat import** (`success: trueWrap(tk("success"))` di module scope), jadi `applyTheme()` mengganti state tapi closure warna sudah beku. `/theme light` melapor `Theme: light` dengan gembira sambil tetap mencetak warna dark. `test/theme.test.ts` hanya memeriksa nilai kembalian `applyTheme`, itu sebabnya lolos.

  Setiap slot kini getter yang membaca `themeState`, dengan palet per-tema di-cache. 181 call-site di 22 berkas tidak perlu diubah. Alias legacy (`c.red`…`c.brightCyan`) dipetakan ke token tema alih-alih hex hardcoded — inilah yang membuat `mono` benar-benar monokrom, jalur aksesibilitasnya.

- **Transcript TUI membuang seluruh warna dan format.** `push()` men-`strip()` semua isi, sehingga diff card kehilangan hijau/merah dan `decorateMarkdown()` yang dipanggil satu baris di atasnya sia-sia — bold, inline code, dan syntax highlight dibuang tepat setelah dibuat. Kini `truncAnsi()` memotong berdasarkan lebar **tampak**, menutup atribut yang terbuka, dan tidak pernah membelah sekuens di tengah maupun memotong emoji separuh.

- **`stripAnsi` tidak menangkap sekuens private-mode.** `ESC[?25l`, `ESC[?2026h`, `ESC[?1049h` lolos utuh — dan `captureOutput()` memakainya untuk membersihkan isi overlay, jadi kode kontrol bisa masuk ke teks. Pola diperluas (termasuk OSC); implementasi duplikat di `wrap.ts` diganti re-export.

### Fixed — biaya & anggaran di REPL

- **Biaya tidak pernah muncul selama sesi interaktif.** Header menunggu `provider:extension { kind:"usage", data.cost }` yang **tidak dikirim provider mana pun** — `openai-compat.ts` dan `anthropic.ts` hanya mengirim token. Biaya dihitung di `createUsageCollector.get()` dari tabel harga, dan TUI tidak pernah membacanya. `FullscreenMinimalOpts` kini menerima `usage()`.

- **`--budget` diabaikan di REPL.** Nilainya diteruskan lalu di-`void` (`fullscreen-driver.ts:197`): tidak ada peringatan 80%, tidak ada penghentian saat lewat batas — padahal jalur one-shot punya keduanya. Kini header menampilkan `$0.85/$1.00` berwarna sesuai rasio, dan prompt baru ditolak setelah batas terlampaui.

### Fixed — input & kursor

- **Tidak ada editing di tengah baris.** `left`/`right` mengembalikan `none` dan `PromptState` tidak punya posisi kursor: `abcdef` + panah kiri ×3 + `X` menghasilkan `abcdefX`. Untuk memperbaiki satu kata di prompt panjang, user harus menghapus seluruh sisanya. Footer bahkan mencetak `_` sebagai kursor palsu di ujung baris.

  `PromptState` kini punya `cursor` (indeks **code point**, bukan unit UTF-16, jadi emoji tak pernah terbelah). Ditambahkan Home/End/Delete/Ctrl+A/Ctrl+E; `backspace`, `ctrl-w`, dan penyisipan karakter menghormati kursor. Renderer memposisikan kursor terminal sungguhan; `_` palsu dihapus. Baris panjang digeser horizontal mengikuti kursor, bukan hanya ujung.

- **Tab mengabaikan seleksi.** `askLine` selalu melengkapi item pertama meski user sudah menekan panah bawah; jalur fullscreen sudah benar. Dua jalur beda perilaku untuk tombol yang sama.

- **Byte mouse bocor jadi teks.** `enableMouse()` mengaktifkan mode `?1000h` tapi `decodeKey` tidak mengenali `ESC[M` + 3 byte koordinat, jadi klik mengubah `teks` menjadi `teks 00`. Mouse tracking dimatikan (tidak ada konsumennya) dan laporan X10 maupun SGR kini dikenali lalu **dibuang**.

- **Panah atas menggabungkan history ke teks yang sedang ditulis** (`halo` → `halo <entri history>`), menghancurkan prompt yang sedang disusun. Kini mengganti baris seperti shell, dengan baris kerja disimpan dan kembali saat turun melewati entri terbaru.

### Fixed — overlay & dispatch

- **Overlay meluber melewati tinggi terminal dan tidak bisa di-scroll.** Kapasitas dihitung (`H - 8`) tapi loop render mengiterasi seluruh `overlay.lines`: overlay 30 baris di terminal 20 baris merender 35 baris, judul terguling keluar layar, dan panah tidak melakukan apa pun. Kini di-slice, bisa di-scroll (panah/Home/End), dengan indikator `13-30/40`.

- **Setiap slash command menempuh tiga jalur.** `/status` memanggil `onPicker` → `onOverlay` → mungkin `onLine`; untuk salah ketik, `onOverlay` bahkan mengeksekusi builtin dengan stdout dibajak sebelum ditolak. Nama kini divalidasi lebih dulu.

- **`/resume` di TUI hanya mencetak instruksi manual** (`keluar lalu jalankan: minicode --resume <id>`) padahal jalur klasik me-respawn proses otomatis. Kini keduanya sama.

### Fixed — konsistensi CLI

- **`--version` / `-v`** — sebelumnya diperlakukan sebagai prompt dan dikirim ke LLM. Versi dibaca dari `package.json`, bukan di-hardcode.
- **Help kontekstual.** `config`, `config mcp`, `config lsp`, `mcp` tanpa argumen mencetak HELP global 45 baris lalu exit 0 — bukan error, bukan petunjuk. Kini help spesifik per subcommand; subcommand asing exit **1** supaya skrip bisa mendeteksi (`sessions`, `skills`, `pricing`, `auth` diseragamkan).
- **`renderTable`: `width` jadi batas keras.** Sebelumnya minimum, sehingga satu nilai panjang melebarkan kolom dan header berhenti berbaris dengan body — nyata di `config list` dengan id provider 23 karakter. `providers` juga beralih ke `renderTable` dari `padEnd(16)` manual yang rusak untuk id panjang.
- **`stats --json`** diterima tanpa keluhan lalu diabaikan; kini menghasilkan JSON.
- **Notice `[sandbox]`** muncul di stderr untuk **setiap** invokasi di Windows, termasuk yang tidak menyentuh tool. Kini hanya bila sesi berpotensi menjalankan perintah.
- **Satu bahasa** untuk seluruh keluaran (Indonesia); `usage:` tetap Inggris mengikuti konvensi CLI. Sebelumnya `providers`/`config`/`skills`/`sessions` Inggris sementara `auth`/`pricing`/TUI Indonesia — user melihat keduanya dalam satu sesi.
- **`/help` mendokumentasikan 13 pintasan papan tombol.** Ctrl+O, Ctrl+R, Shift+Tab, Ctrl+U, Ctrl+W, Esc, dan `\` continuation sebelumnya hanya bisa ditemukan dengan membaca kode; footer menyebut empat.

### Fixed — kebersihan

- **`/thinking` punya dua state dan nol konsumen.** `cli/commands.ts` menulis `process.env.MINICODE_SHOW_THINKING`, `fullscreen.ts` menulis `showThinking.ref`; tak ada yang membaca yang lain, dan tak ada renderer yang membaca keduanya. Toggle melaporkan sukses tanpa efek. Kini satu state (`src/tui/reasoning.ts`) dengan konsumen nyata di kedua renderer.
- **Justify meratakan baris terakhir paragraf**, menghasilkan "sungai" spasi (`dengan      lebar      tertentu`). Baris akhir paragraf kini rata kiri; `MINICODE_JUSTIFY=0` mematikan sepenuhnya.
- **`--ui` dan `--tui` dihapus** — keduanya diparse dan diteruskan tapi tidak pernah dibaca.
- **`test/import-convention.test.ts`** menuduh dirinya sendiri (berkasnya memuat pola yang dicari sebagai literal regex).

### Added — test lapisan interaktif

Sebelumnya `fullscreen.ts`, `input.ts`, `picker.ts`, `panel.ts`, `provider-manager.ts` semuanya nol cakupan — permukaan utama produk tidak diuji sama sekali.

- **`test/helpers/tui-harness.ts`** — fake TTY: stdin injektabel, stdout/stderr tertangkap sebagai frame, ukuran terminal dapat diatur, `ready()` menunggu listener terpasang (komponen melakukan `await` sebelum memasang listener, jadi keystroke lebih awal hilang tanpa jejak), dan pelacak `unhandledRejection`.
- **`test/tui-fullscreen.test.ts`** (44) — submit prompt, dropdown, Tab, overlay + scroll, picker, streaming, diff berwarna, cost/budget, history, kursor, mode, resize, interupsi, mouse, non-TTY, pembersihan terminal saat detach.
- **`test/tui-classic.test.ts`** (36) — `askLine`, `runPicker`, `runPanel`, `runProviderManager`, `captureOutput`.
- **`test/tui-format.test.ts`** (42) — `wrap`, `format`, `reasoning`, `statusline`, simple logger.
- **`test/cli-handlers.test.ts`** (45) + **`test/cli-subcommands.test.ts`** (25) — handler in-process dan biner sungguhan (exit code, aliran stdout/stderr).

## [Sebelumnya] — Audit V4 (Fase 0–4) + V5 (eksperimen ekstrem & distribusi)

Basis: audit menyeluruh v0.7.0 ([docs/PLAN_V4.md](docs/PLAN_V4.md)) dilanjutkan dengan tiga harness adversarial ([docs/PLAN_V5.md](docs/PLAN_V5.md)). Semua angka terverifikasi dengan eksekusi.

### Security — V5: empat bug ditemukan oleh eksperimen adversarial

Probe lama hanya membuktikan guard menahan serangan **yang sudah dipikirkan**. Tiga harness baru membangkitkan kasus sendiri dan menemukan hal yang terlewat.

- **`experiments/extreme-bash-fuzz.ts`** — mutasi kombinatorial dari transformasi yang shell anggap setara (quote-split, indirection variabel untuk nama perintah maupun argumen, rantai dua tingkat, flag panjang, wrapper perintah, chaining), PRNG ber-`--seed` agar temuan bisa direproduksi. Run pertama: **101 bypass (52 unik)** dari 2.435 varian. Tiga kelas akar:

  | Bypass | Kenapa lolos | Perbaikan |
  |---|---|---|
  | `command env`, `nice env`, `exec 'env'`, `time env` | Deteksi env-dump ter-anchor ke awal perintah; wrapper menggeser posisi kata | `stripCommandWrappers()` membuang 14 wrapper (`command`/`exec`/`nice`/`nohup`/`setsid`/`timeout N`/`stdbuf`/`sudo`/…) berulang hingga 4 lapis |
  | `rm --recursive --force /` | Pola lama hanya mencari `-[a-z]*r` | `RM_RECURSIVE` menerima `--recursive`/`--dir` |
  | `rm -rf /; :` | Pola target mensyaratkan whitespace/akhir-string; `;` menempel langsung | `RM_DANGEROUS_TARGET` menerima `;`/`&` sebagai pembatas |
  | `b(){ b\|b& };b` dan varian terpecah variabel | Pola fork bomb literal `:(){ :\|:& };:` | Pola struktural: definisi fungsi apa pun dengan pipe + `&` |

  Setelah perbaikan: **0 bypass** pada 6 seed dan pada run panjang (12.912 varian berbahaya + 2.400 varian sah). Regresi terkunci di `test/bash-fuzz-regression.test.ts` (44 test).

  Catatan: dua "bypass" awal ternyata **palsu** — mutator kosmetik yang berjalan sebelum indirection menyisipkan tab di tengah kata, sehingga payload rusak di shell nyata (`C=find\t/` berarti "assign lalu jalankan `/`"). Harness diperbaiki (mutator dipisah struktural vs kosmetik), bukan guard-nya. Perilaku yang benar didokumentasikan sebagai test.

- **`experiments/extreme-mcp-adversarial.ts`** — server yang sengaja jahat. Menemukan: **balasan untuk request id lain diterima sebagai hasil.** Server yang membalas `{"id": 4242, ...}` terhadap request `id: 1` — atau hanya mengirim notifikasi tanpa `id` — diterima sebagai sukses dan `result: undefined` menjalar ke pemanggil. Jalur SSE sudah mencocokkan id; jalur JSON tidak. `readJsonResponse` kini menerima `expectId`. Diverifikasi juga: heap tidak tumbuh saat server mengirim 512 MB, `Authorization` tidak muncul di pesan error, 13 pola host privat ditolak konsisten dengan `web_fetch`.

- **`experiments/extreme-shadow-git.ts`** — 31 pemeriksaan, 0 gagal. Mengonfirmasi klaim O(delta) dengan pengukuran: snapshot 200/1.000/5.000 file = 282/604/522 ms, manifest **konstan 364 B**. Konkurensi 10 sesi paralel menghasilkan tree identik tanpa index yatim. Nama file unicode/emoji/spasi/120-karakter/diawali-`-` semuanya ter-undo.

### Added — V5

- **MCP client mengonsumsi `resources` & `prompts`.** Sisi server minicode sudah lama menyajikannya; client hanya memakai `tools`. `initialize` kini mendeklarasikan `{ tools, resources, prompts }` (sebelumnya hanya `tools`, sehingga server yang sopan tidak menawarkan sisanya). Tool baru **`mcp_read`** (`resources/read`) dan **`mcp_prompt`** (`prompts/get`); `mcp_list` menampilkan tiga kategori.

  Keduanya **di-gate meski read-only** — menarik konten dari server pihak ketiga langsung ke konteks model adalah jalur prompt-injection, dan "read-only" tidak berarti "aman". `mcp_list` tidak di-gate karena hanya melaporkan metadata server yang user daftarkan sendiri. Discovery bersifat opsional: server yang membalas "Method not found" tetap terhubung. Blob biner tidak ditumpahkan sebagai base64.

- **`scripts/pack-check.ts`** — gate distribusi. Menelusuri graf import dari `bin` (98 modul), memverifikasi setiap target ikut terkemas, memeriksa vendor lengkap untuk 12 spesifier, dan menolak 14 pola berkas rahasia/sampah. Field `files` mudah tertinggal, dan kegagalannya hanya muncul setelah publish.

- **Perintah eksperimen**: `bun run extreme`, `extreme:fuzz`, `extreme:git`, `extreme:mcp`, `gate:pack`. CI naik dari 14 ke 18 langkah.

### Changed — V5: distribusi npm

- **Tarball npm sebelumnya gagal dipasang.** Dependency `minicore: file:./vendor/minicore` di-resolve relatif terhadap cache Bun, bukan terhadap paket terpasang: `Could not find package.json for "file:../../../../../.bun/install/cache/.../vendor/minicore"`. `bun install` lokal hijau, jadi masalah ini tak terlihat sampai tarball benar-benar diuji.

  Diganti **subpath imports** (`package.json` `imports`), fitur yang justru dirancang untuk ini. 73 import site di 51 file dimigrasikan dari `minicore` ke `#minicore`; `dependencies` kini kosong. Terverifikasi end-to-end: `npm pack` → `bun install <tarball>` di proyek bersih → `minicode --help`, `pricing status`, `auth list` berjalan lewat `node_modules/.bin/minicode`. Tarball 222 KB, 124 file, 697 KB unpacked.

- **`package.json`** dilengkapi `files`, `keywords`, `repository`, `homepage`, `bugs` untuk kesiapan publish.

### Fixed — V5: dua bug dari migrasi itu sendiri

Penggantian teks massal menghasilkan dua kesalahan yang **lolos typecheck**:

- **Nama direktori ikut terganti.** `resolve(repoRoot, "..", "minicore")` menjadi `"..", "#minicore"`, sehingga `vendor:check` melapor "vendor kosong" padahal ada 20 file. `#` hanya bermakna untuk spesifier import, bukan path filesystem.
- **Karakter non-ASCII rusak.** File yang ditulis ulang lewat pipeline PowerShell tanpa encoding eksplisit mengubah `—`, `…`, `─` menjadi U+FFFD di 2 file (9 dan 2 kemunculan), memecahkan satu assertion test. Dipulihkan dari `git show HEAD:<file>` lalu perubahan yang dimaksud diterapkan ulang.
- Sekalian ditemukan: `tsconfig.json` punya BOM, yang membuat `JSON.parse` gagal dengan "Unrecognized token".

`test/import-convention.test.ts` menjaga ketiganya plus konsistensi `package.json`/`tsconfig.json`.

### Added — Fase 4

- **Login OAuth tanpa API key** (`src/providers/oauth.ts`). Device Authorization Grant (RFC 8628), dipilih di atas authorization-code+PKCE karena tidak butuh redirect URI, tidak membuka port lokal, dan bekerja lewat SSH. Penanganan sesuai spec: `authorization_pending`, `slow_down` (naikkan interval minimal +5 s per §3.5), `access_denied`/`expired_token` berhenti dengan pesan, interval liar di-clamp 1–60 s, dan error tak dikenal **berhenti** alih-alih polling sampai timeout.

  Kredensial di `~/.minicode/auth.json` (chmod 600) — **terpisah dari `config.json`** karena config sering ikut ter-commit sementara token adalah rahasia berumur pendek. Refresh otomatis dengan margin 60 detik. `buildProviderListAsync` menukar `apiKey` dengan access token segar saat runtime; provider OAuth yang belum login **dibuang dengan peringatan** alih-alih mengirim `Authorization: Bearer undefined`.

  Perintah: `minicode auth login|status|logout|list`.

  Catatan jujur: mekanismenya diuji end-to-end terhadap server device-flow lokal (18 test mencakup seluruh cabang spec), tapi nilai endpoint/clientId provider belum dikonfirmasi lewat login sungguhan dari lingkungan pengembangan. Bila salah, `auth login` melaporkan error server apa adanya.

- **`git_commit`** — tool git pertama yang menulis. Di-**gate** setara `delegate_task`: commit mengubah riwayat yang dibagikan, bukan sekadar file kerja. Sub-agent tidak mendapatkannya.

  Yang **sengaja tidak** disediakan: `push`, `reset --hard`, `rebase`, `checkout`, `branch -D`, `stash drop`, `amend`. Semuanya sulit dibalikkan atau mempengaruhi remote/repo orang lain; agent tidak butuh itu untuk menyelesaikan task.

  Keamanan yang diuji: pesan diteruskan sebagai satu argumen `-m` sehingga `$(touch pwned)` dan backtick **tidak dieksekusi** (dibuktikan: tak ada file baru setelah commit), `git add -- <paths>` memisahkan path dari opsi sehingga `-weird.txt` tidak jadi flag, path dijail di permission layer dan di dalam tool, dan "tidak ada perubahan" mengembalikan pesan informatif alih-alih exception. Sekalian: `git_status`/`git_diff`/`git_log` kini juga menjail `cwd`.

- **Tabel harga dari models.dev** (`src/policy/pricing.ts`). 17 entri bawaan (offline) + overlay 3.162 model. **Tidak ada fetch otomatis** — rencana menyebut "tarik dengan cache", tapi request ke pihak ketiga saat startup menambah latensi dan membocorkan pola pemakaian tanpa diminta. Sync hanya lewat `minicode pricing sync`; jalur run biasa hanya membaca cache. Payload 4,4 MB → cache 213 KB karena hanya field biaya yang diambil. Perintah: `minicode pricing status|sync|show|clear`.

### Fixed — Fase 4

- **Harga `gpt-4o` 2× terlalu tinggi.** Tabel lama menulis $5/M input — itu harga peluncuran Mei 2024 yang dipotong separuh pada Agustus 2024 menjadi $2,50. Estimasi biaya dan `--budget` untuk model ini salah sejak lama. Test yang mengunci angka lama diperbarui **dengan catatan alasannya**, bukan diam-diam.
- **Harga bisa jadi $0 karena urutan iterasi objek.** Satu model id sering ditawarkan beberapa provider dengan harga berbeda — terukur: `qwen3-coder-plus` muncul di 6 provider, dua di antaranya $0 (paket berlangganan). Implementasi awal mengambil "yang pertama" dan hasilnya **$0**, artinya estimasi biaya nol dan `--budget` tak akan pernah memicu. Diganti: buang kandidat gratis bila ada yang berbayar, lalu ambil **median** (bukan min yang menyesatkan ke bawah, bukan max yang alarmis).
- **Test yang bergantung waktu.** Suite gagal 17 test sekali saat dijalankan dengan `--coverage` (instrumentasi memperlambat spawn), lalu hijau 6× berturut setelahnya. Dua penyebab diperbaiki alih-alih dibiarkan sebagai flake: timeout tool git dipindah dari hardcode 8 s ke `LIMITS.GIT_TIMEOUT_MS` (20 s) karena `git_commit` menjalankan empat operasi berurutan, dan `Bun.sleep` tetap di test MCP diganti polling ber-deadline (server yang tak pernah membalas untuk uji timeout, poll sampai request diterima untuk uji notify).

### Changed — Fase 3

- **Checkpoint berbasis shadow-git** (`src/session/shadow-git.ts`). `snapshotWorkspace` lama menyalin **isi** setiap file ke JSON manifest: O(ukuran workspace) per turn, di-cap 200 file sehingga undo tidak lengkap secara senyap pada perubahan besar. Sekarang memakai object store git: index sementara lewat `GIT_INDEX_FILE` → `git write-tree`, tree di-pin dengan ref `refs/minicode/<sesi>/…`, undo = diff dua tree lalu pulihkan hanya path yang berubah.

  Jaminan yang diuji, bukan diasumsikan: index dan `HEAD` user tidak pernah disentuh (tak ada `add`/`commit`/`checkout`/`reset`/`stash` pada state user), ref menunjuk *tree* bukan commit sehingga tak muncul di `git log --all`/`git branch`, tree tetap terbaca setelah `git gc --prune=now`, dan restore hanya menyentuh path yang berbeda. Manifest kini menyimpan SHA: file 200 KB tidak lagi membuat manifest membengkak (<2 KB). Turn tanpa perubahan tidak membuat checkpoint kosong. Perubahan 250 file dari satu `bash` ter-undo seluruhnya — sebelumnya cap 200 menyisakan 50 file. Repo non-git memakai fallback snapshot file.

- **MCP client mendukung Streamable HTTP** (`src/mcp/http-transport.ts`). Client sebelumnya hanya stdio, sementara sisi *server* minicode sudah menyajikan `tools`/`resources`/`prompts` — asimetri yang membuat seluruh ekosistem MCP remote tak terjangkau. Spec 2025-03-26: POST JSON-RPC, respons `application/json` atau `text/event-stream`, `Mcp-Session-Id` disimpan dari `initialize` dan dikirim ulang, `Mcp-Protocol-Version` hasil negosiasi, `DELETE` saat close.

  Config menerima `url` sebagai alternatif `command`: `minicode config mcp add ctx7 --url https://… --header "authorization=Bearer xxx"`. Keamanan yang **bukan** bawaan spec: host privat ditolak kecuali `--allow-private` (server MCP yang menunjuk `169.254.169.254`/localhost adalah SSRF klasik — memakai penjaga DNS-pinning yang sama dengan `web_fetch`), redirect tidak diikuti, ukuran balasan dibatasi, `Authorization` tidak pernah di-log. `server/discover` (ekstensi non-standar) kini hanya dicoba untuk stdio lokal.

### Fixed — Fase 3

- **`core.autocrlf` merusak byte saat restore.** Di Windows default-nya `true`, sehingga `checkout-index` menerapkan smudge filter dan memulihkan file LF sebagai CRLF — restore mengubah isi yang tidak diminta siapa pun (terukur: `a\nb\n` → `a\r\nb\r\n`). Setiap invokasi git kini memakai `-c core.autocrlf=false -c core.safecrlf=false`.
- **`sessionId` tertentu mematikan snapshot.** `--session "sess/../..~weird:id"` menghasilkan path index `.git\..~weird:id-…` yang ditolak Windows (`Invalid argument`), jadi snapshot gagal total dan checkpoint hilang senyap. Sanitasi kini dipakai untuk nama berkas **dan** nama ref.

### Removed — Fase 3

- **`src/repo/tree-sitter.ts` dihapus**, bukan diimplementasikan. Prototipe `web-tree-sitter` + `tree-sitter-typescript` berjalan dan cepat (init 89 ms, load grammar 19 ms, parse 6 ms), tapi perbandingan pada 5 file nyata menunjukkan yang terlewat regex hampir seluruhnya **member kelas dan helper lokal** (`constructor`, `append`, `execute`, `check`, `__setMode`) — bukan simbol top-level yang berguna untuk orientasi. Biayanya: dua dependensi, ~1,4 MB wasm per bahasa dikali sembilan bahasa, grammar terpisah, jalur async baru. Faktor penentu: repo-map **sudah menyentuh cap 2.500 char** pada repo ini, jadi simbol tambahan tidak akan sampai ke prompt — ia justru menggeser yang lebih penting. Alasan + tabel pengukuran dicatat di komentar `extractSymbolsAsync` agar keputusan tak perlu diulang dari nol.

### Security — Fase 2

- **bash-guard berbasis normalisasi** (`src/policy/bash-guard.ts`) menggantikan denylist regex-atas-string-mentah. Rencana awal "tambal celah satu-satu" ditinggalkan karena tidak menyelesaikan akar masalahnya: shell menganggap banyak bentuk setara sementara regex melihat karakter. Sekarang quote pemisah kata dibuang dan assignment variabel literal disubstitusi (dengan re-scan per lintasan untuk rantai) **sebelum** pemeriksaan, lalu bentuk ternormalisasi dan mentah keduanya diperiksa.

  Kelas yang kini tertutup: indirection variabel (`X=.env; cat $X`), quote-splitting (`cat .e""nv`, `pyt"h"on3 -c`), flag panjang (`node --eval`/`--print`), env dump (`env`/`set`/`export -p`/`declare -x`/`compgen -v` — sebelumnya hanya `printenv`), referensi env berkata-kunci rahasia, upload-exfil (`-d @`, `-F …=@`, `-T`, `--upload-file`, `--post-file`), process substitution dan here-string, download-then-run dua tahap, container escape (`-v /:`, `--privileged`, `--pid host`), scan dari root filesystem, akses berkas/direktori kredensial, serta `rm` rekursif dengan target berbahaya.

  Terukur oleh `experiments/bash-bypass-probe.ts` (38 pola serangan + 15 perintah sah sebagai guard anti-over-block): mode `auto` dari **33/38 bypass → 0/38**, mode `allowlist` dari **7/38 → 0/38**, over-block dari 1 dan 4 → **0**. Audit awal melaporkan 13 bypass karena hanya 13 pola yang diuji saat itu; setelah korpus diperluas, angka sebenarnya lebih buruk.

- **`rm -rf` dipisah dari target berbahaya.** Pola lama menganggap setiap `/` berbahaya sehingga `rm -rf node_modules/.cache` ikut ditolak. Sekarang `rm` rekursif hanya ditolak bila targetnya root, home, traversal `..`, wildcard telanjang, atau `--no-preserve-root`.

- **Sandbox aktif otomatis** (`src/policy/sandbox-policy.ts`). Bila bubblewrap (Linux) atau seatbelt (macOS) tersedia, bash berjalan di dalamnya tanpa flag. Bila tidak ada isolasi nyata — termasuk semua Windows — permission default turun ke `allowlist` dan alasannya dicetak sekali; prinsipnya jangan pernah menjanjikan isolasi yang tak bisa dipenuhi. Pilihan user (`--allow-all`/`--ask`/`--plan`/`--allowlist`) tidak ditimpa dan tidak dapat peringatan. `--sandbox none` = opt-out sadar dan senyap. `--sandbox docker` yang daemonnya mati juga tidak berpura-pura: downgrade + peringatan. Docker tidak dipakai otomatis meski tersedia karena menarik image tanpa diminta terlalu invasif untuk sebuah default. Berlaku juga di `minicode exec`, yang justru paling butuh karena tak ada manusia untuk menyetujui prompt.

- **Allowlist diperluas ke perintah read/build yang sah.** Sebelumnya hanya 13 pola sehingga `grep -r TODO src` ikut ditolak. Operasi tulis lewat shell (`mkdir`, `cp`, `mv`, `rm`, `touch`) **tetap ditahan** — itu memang tujuan mode paling ketat; agent yang perlu menulis punya `write_file`/`edit` yang ter-jail.

- **`SECRET_ENV_RE` berbasis kata-kunci kredensial.** Pola lama memuat nama vendor telanjang (`GITHUB`, `GOOGLE`, `AZURE`, `REDIS`, `SUPABASE`), sehingga `GITHUB_WORKSPACE`, `GITHUB_REF`, `GITHUB_SHA`, `GOOGLE_CHROME_PATH`, `AZURE_CONFIG_DIR`, `REDIS_HOST`, `AWS_REGION` ikut terhapus dari env subprocess dan memecahkan build CI. Nama vendor sekarang hanya dicocokkan bila disertai penanda rahasia. Diuji dengan 24 nama rahasia dan 21 nama benign.

### Fixed — tiga bug yang lolos CI karena `cli/` di luar `tsconfig` dan tanpa test

- **Semua slash builtin mati di TUI.** `cli/fullscreen-driver.ts` memakai variabel `cmdName` yang tak pernah dideklarasikan; `ReferenceError`-nya ditelan `catch { return null }`, sehingga `/help`, `/cost`, `/status`, `/sessions`, `/undo`, `/redo`, `/init`, `/theme` gagal senyap dan user hanya melihat "perintah tidak dikenal". Deteksi builtin kini lewat nilai kembalian `handled`, bukan exception. `captureOutput` jadi generik dan meneruskan nilai `fn`. `shouldExit` untuk `/exit` yang sebelumnya diabaikan ikut ditangani.
- **`exec --json` tidak pernah stream event.** `events.on(handler)` satu argumen mendaftarkan listener di bawah key `"function"` sehingga tak pernah terpanggil — mode headless untuk CI tidak berfungsi seperti didokumentasikan. Diganti `on("*", handler)`. Ringkasan pindah dari stderr ke stdout sebagai `{"type":"summary"}` supaya pipeline membaca satu stream. `--allowlist` yang bocor menjadi bagian prompt di subcommand `exec` juga diperbaiki.
- **Shift+Tab cycle permission adalah placebo.** `__setMode`/`__getMode` di `src/policy/permission.ts` hanya ada di *type-cast* tanpa implementasi, dan `session.config` tidak diekspos kernel — header menampilkan "plan" sementara agent tetap bisa menulis file dan menjalankan bash. Kedua method diimplementasikan (plus invalidasi `allowlistCache`), dan seam `onPermissions` di `createMinicodeSession` menyerahkan handle ke `CliSession.permissions`. Kernel tidak disentuh.

### Added — tool fundamental (Fase 1)

- **`read_file` paging bernomor.** Output diberi nomor baris (`12: const x = 1`) agar rujukan `edit`/`apply_patch` akurat. Param `offset` (1-indexed) + `limit` (default 2000, max 5000). File di atas 2 MB kini bisa dibaca per bagian; tanpa paging tetap ditolak — memotong konteks diam-diam lebih berbahaya daripada error eksplisit. Baris sangat panjang dipotong per baris, direktori ditolak dengan pesan spesifik.
- **`grep` dua engine.** `rg` dipakai bila ada di PATH (`--vimgrep --no-follow`, exclude `.git`/`node_modules`/dotdir), fallback walker internal dipertahankan dan diuji memberi hasil identik. `MINICODE_GREP_ENGINE=js` memaksa fallback; CI menguji jalur itu eksplisit. Jail berlaku di keduanya — walker via `realpath`, ripgrep via validasi tiap baris hasil.
- **`todo_write` / `todo_read`.** Rencana kerja per sesi di `.minicode/todos/<id>.json` (atomic). Kirim seluruh daftar, bukan delta. Hanya satu `in_progress` dipertahankan; sisanya dinormalisasi ke `pending`. File korup dianggap kosong. Dirender utuh di TUI (transcript kind `todo`) dan one-shot logger. `todo_read` masuk READONLY sehingga tetap boleh di mode `plan`.
- **`bash` streaming + background.** Foreground memancarkan `provider:extension` kind `bash-output` inkremental (tampil di `--verbose`). `background:true` mengembalikan job id, lalu `bash_output(id)` (hanya output baru sejak baca terakhir) dan `bash_kill(id)`. Job di-cap, yang selesai di-reap, dan semua dimatikan saat CLI keluar. `background:true` **ditolak** saat `--sandbox` aktif: container/namespace ephemeral mati bersama call-nya, jadi janji isolasi tidak bisa dipenuhi untuk proses berumur panjang.

### Changed — distribusi

- **`bun install` tidak lagi butuh clone sibling.** Kernel MiniCore di-vendor ke `vendor/minicore` (19 file, ~72 KB); dependency jadi `file:./vendor/minicore`. Opsi publish ke npm ditinggalkan karena butuh kredensial dan tidak reversible. `scripts/vendor-minicore.ts` menyinkronkan dari `../minicore` dan `--check` mendeteksi drift lewat hash agregat (gate CI baru `vendor:check`). Tanpa sibling, script tetap lulus dengan pesan agar kontributor tidak diblokir. Terverifikasi: salin file tracked ke direktori kosong → install, typecheck, dan seluruh test hijau tanpa `../minicore`.
- **Executor: `bash` bukan lagi "write".** `bash` dipindah ke `EXCLUSIVE_TOOLS` — sebelumnya ia mengambil write-slot tapi `getFilePath()` selalu `null` untuknya, sehingga dengan write-concurrency 1 dua bash read-only terserialisasi tanpa alasan.
- **Coverage gate nyata.** Label CI "threshold 80" sebelumnya fiksi: `bun test --coverage` tanpa konfigurasi selalu lulus. `bunfig.toml` `coverageThreshold` juga tidak bisa dipakai karena Bun mengevaluasinya per-file (bahkan 0,01 gagal karena ada file 0% yang hanya jalan di Linux/macOS). Diganti `scripts/coverage-gate.ts` yang mem-parse baris "All files"; diuji dua arah.
- **Typecheck mencakup seluruh repo.** `tsconfig.json` `include` kini memuat `cli`, `scripts`, `experiments` — 3.178 LOC entry point yang sebelumnya tak pernah diperiksa. 14 error yang muncul dibereskan.
- **Lint bersih.** 68 error → 0. `noControlCharactersInRegex` diselesaikan dengan `ANSI_PATTERN` sebagai satu sumber di `src/tui/theme.ts`, dipakai ulang oleh `wrap`, `panel`, `commands`, `input`, `fullscreen`, dan `human-sim`.

### Removed

- `minicode-0.6.0.tgz` (183 KB artifact build ter-commit); `*.tgz` masuk `.gitignore`.

### Docs

- Angka yang bisa dihitung mesin (jumlah test, tool, coverage) dibuang dari README/ARCHITECTURE/CONTRIBUTING/USAGE. Repo sebelumnya memuat tiga angka test berbeda dan dua jumlah tool berbeda; klaim semacam itu membuat pembaca teknis mendiskon klaim lain yang benar.
- `CONTRIBUTING.md` masih menyatakan "proprietary / closed source, tidak menerima PR" padahal `LICENSE` sudah MIT sejak 0.7.0 — diperbaiki.
- Referensi Ink yang sudah dihapus dibersihkan dari README, ARCHITECTURE, dan `src/tui/format.ts`.
- Known Limitations diperluas; tiap poin menunjuk fase PLAN_V4 yang menanganinya. Batas nyata denylist bash dinyatakan eksplisit **dengan contoh pola yang lolos**, bukan disembunyikan.
- Koreksi pengukuran: audit melaporkan walker grep 3.550 ms; setelah diukur ulang di proses bersih angkanya ~110–160 ms — 3.550 ms termasuk cold start import, bukan biaya scan. Klaim "50× lebih lambat" di audit terlalu keras dan dikoreksi di PLAN_V4.

### Tests

- `test/cli-regression.test.ts` — 10 test untuk tiga bug di atas. B2 diuji dengan membandingkan `on("*")` versus `on(handler)` di run yang sama, jadi test itu mendokumentasikan kenapa pola lamanya salah.
- `test/phase1-tools.test.ts` — 35 test: paging `read_file` (termasuk file >2 MB), kesetaraan dua engine grep, normalisasi/render/roundtrip todo, background job (output baru, cap, kill, penolakan saat sandbox), dan permission untuk tool baru di mode auto/plan/readonly.
- `test/phase2-security.test.ts` — 160 test: normalisasi bash-guard, 33 kelas bypass yang dulu lolos, 25 pola lama yang harus tetap tertutup, 32 perintah sah sebagai guard anti-over-block, integrasi guard di tiap mode permission, 10 skenario resolusi sandbox, dan 45 nama variabel env.
- `test/shadow-git.test.ts` — 22 test: index/HEAD user utuh, ref tak tampil di `git log`/`branch`, tahan `gc --prune=now`, line ending preserved (regresi `core.autocrlf`), `sessionId` ilegal (regresi path index Windows), `.gitignore` dihormati saat snapshot **dan** restore, undo/redo lintas tree, 250 file tanpa cap, manifest tetap kecil untuk file besar.
- `test/mcp-http.test.ts` — 28 test terhadap **server HTTP nyata** (`Bun.serve`), bukan mock fetch, karena yang rawan justru perilaku di atas kabel: event SSE terpotong tepat di tengah payload JSON, pemisah CRLF, event non-JSON di antara balasan, notifikasi sebelum balasan, aliran berakhir tanpa balasan (harus error bukan hang), sesi & protocol header, redirect ditolak, host privat ditolak, body cap.
- `test/phase4-auth-git-pricing.test.ts` — 49 test: device flow terhadap **server OAuth lokal** (pending, slow_down dengan kenaikan interval, access_denied, expired_token, clamp interval, balasan HTML dari captive portal, abort di tengah polling), `git_commit` (shell-injection lewat pesan, flag-injection lewat nama file, jail path & cwd, commit kosong, permission per mode), dan pricing (median antar-provider, entri $0 diabaikan, anti-substring, cache hanya field biaya).
- `test/bash-fuzz-regression.test.ts` — 44 test yang mengunci temuan fuzz: 14 wrapper perintah tak boleh menyembunyikan payload, `rm` long-option, chaining tanpa whitespace, varian fork bomb, dan batas normalisasi yang jujur (payload yang memang rusak tidak diklaim berbahaya).
- `test/mcp-resources-prompts.test.ts` — 19 test terhadap server MCP HTTP nyata: discovery `resources`/`prompts`, server tools-only tetap terhubung, kapabilitas `initialize`, blob biner tak ditumpahkan, dan izin gated untuk `mcp_read`/`mcp_prompt`.
- `test/import-convention.test.ts` — 9 test: tak ada spesifier `minicore` lama tertinggal, `package.json`/`tsconfig.json` sejalan, nama direktori vendor tanpa `#`, `vendor:check` hijau, tak ada U+FFFD, tak ada BOM di konfigurasi.
- `experiments/bash-bypass-probe.ts` — korpus manual (38 serangan + 15 perintah sah). Exit 0 hanya bila 0 bypass **dan** 0 over-block (`bun run gate:bash`).
- `experiments/extreme-bash-fuzz.ts` · `extreme-shadow-git.ts` · `extreme-mcp-adversarial.ts` — harness adversarial yang menemukan empat bug di atas (`bun run extreme`).
- `scripts/pack-check.ts` — 22 pemeriksaan tarball npm (`bun run gate:pack`).

## [0.7.0] - 2026-08-29

### TUI & UX Polish — "Production Ready"
- **Theme-aware TUI** — `modeColor` dari semantic colors (`c.success` auto, `c.warning` plan, `c.info` ask), header responsive `<80 cols`, footer dynamic cost + hints
- **Input engine unified** — `decodeKeys` + `applyKey` dari `prompt-engine` single source, emoji 2-unit, bracket paste `\x1b[200~` support, Ctrl+O/R/Shift+Tab native key types
- **Diff cards** — `renderDiffCard` untuk edit/apply_patch (Ubuntu style +/−), ANSI-safe wrap via `formatWrapped`
- **Performance** — `RING_MAX 100→60`, spinner `setInterval→setTimeout` coalesce, diff repaint `prevOut` cache
- **Accessibility** — bracket paste `\x1b[?2004h`, mouse `\x1b[?1000h`, cursor restore on crash
- **Input fixes** — Tab/enter sel=-1 bug fix, case-insensitive matches, history via prompt-engine

### License
- **MIT License** — `UNLICENSED → MIT`, `private: false`, npm publish ready

### Security & Core
- **Minicore v0.1.1** — retryAfter cap 30s (`RETRY_AFTER_MAX_MS`) P2 fix
- **Extreme experiments** — fuzz/context/security all pass (257+154 tests)

## [0.6.0] - 2026-08-26

### UI/UX Overhaul - "Clean CLI"
- **Fullscreen Ink shell default** (`--ui auto|full|classic`): alternate-screen REPL terisolasi (ESC[?1049h/l) - header 1 baris (brand/model/mode/cost), transcript scrollable ring 200, status dots animasi, input dengan slash-dropdown, footer hint. Exit = terminal kembali bersih.
- **Ctrl+C lifecycle**: busy = hentikan turn saja (AbortController via kernel seam `session.run({signal})`); idle = 2x dalam 2 detik keluar bersih. Esc juga interrupt.
- **Mojibake Windows tuntas** - semua string konsol di-sweep ke ASCII-safe; prompt memakai `glyphs.prompt` (fallback `>` tanpa UTF-8).
- **Status line rapi** - kata "reasoning"/"working" dihapus (dots cukup); output tool tidak lagi menyisakan fragmen spinner (statusline suspend/resume).
- **Shift+Tab** cycle permission mode live (auto/ask/plan/allowlist) + badge header.
- **`/thinking on|off`** toggle tampilan reasoning (default off). `/init` generator AGENTS.md dari repo-map.
- **Ctrl+O** expand transcript; multiline `\`+Enter; edit keys Ctrl+U/W.
- **Bel terminal** saat permission request (ala OpenCode attention).
## [0.5.1] — 2026-08-26

### Security (P0)
- **Env sanitasi terpusat** — `sanitizeSpawnEnv()` dipakai semua spawn (bash/docker/MCP/LSP); secret (`*API_KEY/TOKEN/SECRET/DATABASE_URL`…) tidak pernah diwarisi container/server walau caller lupa strip; env eksplisit config tetap menang setelahnya.
- **MCP gating penuh** *(behavior change)* — mode `auto` tidak lagi auto-allow tool dari server MCP terdaftar; semua nama bertitik kini gated (prompt sekali + `[a] Always` persist). Menutup RCE supply-chain via server jahat.
- **SSRF web_fetch** — redirect ditangani manual (maks 5 hop) dengan re-validasi tiap host target; blok tambahan CGNAT 100.64/10, IPv4-mapped IPv6, fc00::/7, fe80::/10, `*.internal/.local/.localhost`; body dibaca dengan hard-cap 2MB (anti-OOM).
- **Scrubber tanpa whitelist** — kata `test/example/mock` tidak lagi melewati redaksi; secret yang mengandung substring itu tetap di-[REDACTED].

### Reliability
- **Executor abort-aware** — antrean write-slot & file-lock langsung reject saat abort (tidak lagi menunggu tool in-flight, bash bisa 30s); ownership handoff menjaga semaphore seimbang.
- **Atomic writes** — helper `atomicWriteText` (randomUUID tmp + `O_EXCL` + 0600 + rename retry utk Windows EPERM) dipakai write_file/edit/apply_patch/allowlist/config/checkpoint manifest.
- **Jail realpath di permission layer** — symlink keluar workspace tertangkap sebelum eksekusi tool; `SENSITIVE_RE` di-anchor per segmen (fix false-positive `my_node_modules*`) + cakupan baru (.git-credentials, credentials.json, secrets.yaml/yml/json, tfvars, .pfx/.jks).
- **SQLite** — WAL capped (`journal_size_limit`, `wal_autocheckpoint`) + retry SQLITE_BUSY untuk penulis konkuren.
- **Telemetry** — opt-out `MINICODE_TELEMETRY=0`, prompt di-scrub, chmod 0600, rotasi atomic.

### Correctness
- **Router image fix** — konten biner tool result tidak lagi di-base64-kan sebelum provider anthropic (image block media_type benar via magic-byte sniffing; fallback base64 untuk biner lain).
- **`/sync` benar-benar sync** — cache deteksi 30 menit di-invalidate saat refresh; timeout fetch per-attempt 2.5s.
- **CLI args** — `--verify` boolean (tak bocor ke prompt), dukung `--flag=value`, flag berulang terfilter semua (last-wins).
- **Pricing boundary match** — `my-gpt-4o-wrapper` tak lagi dihitung sebagai gpt-4o; varian versi (`gpt-4o-2024…`) tetap cocok.
- **Silent catch** — migrasi DB/purge/embedding/checkpoint korup kini mencetak `[warn]`.

### Engineering
- **LIMITS dipakai sungguhan** — 20 modul memakai konstanta terpusat (+15 key baru); duplikat magic number dihapus.
- **Type-safety produksi** — nol `as never`/`as any` di `src/ cli/`; `createMinicodeSession` menerima seam kernel secara type-safe.
- **dbPath dedup** — satu resolver untuk sessions.db & vector.db.

## [0.4.0] — 2026-08-25

### UI/UX (rencana Fase 5–6)
- **Preset gateway** — `/provider-add` & wizard: 6 preset (OpenAI/Anthropic/OpenRouter/DeepSeek/OpenCode Zen/Google) — baseUrl+fallback otomatis.
- **`provider::model` routing** — pilih provider spesifik; router first-match-wins untuk model kembar.
- **`minicode providers | models [id] --match <kw> | sync`** — kelola gateway tanpa LLM; `/sync` auto-sync model baru.
- **Dropdown suggestions** — floating grouped `COMMANDS`/`SKILLS` (header dimmed), max 10 + `… N more`; **bug fix name placeholder** (suggestion tidak lagi `/models [id]`).
- **Transparansi fallback** — summary turn & `/cost` menampilkan model/provider efektif saat router substitusi.
- **Turn status line** — spinner `· model · working…` (TTY), label berganti saat fallback.
- **Budget di prompt** — `minicode❯[62%]` saat `--budget`.
- **Error user-friendly** — kategori formal (`auth`/`rate_limit`/...) → pesan + fix, bukan dump JSON.
- **`/resume [id]` + `/sessions` bernomor** — resume sesi lewat picker.
- **Compaction faktual** — hasil tool sukses (isi file, output test) ikut di-LLM-summarized (bukan `<result omitted>`).

### Engineering
- **Prompt engine pure** (`cli/prompt-engine.ts`) + **fuzz test** (~93k asserts, 195 test total).
- **`test:live` terpisah** — `bun run test:live`; `bun test` default offline (8 skip).
- **CI fix** — checkout minicore sibling (dependency `file:../minicore`) + cache bun.
- **Telemetry gate** — resolve-rate ≥ 0.3 (live: 0.59); `scripts/telemetry-gate.ts`.
- **TTL configurable** — `MINICODE_SESSION_TTL_DAYS` (0=forever); `minicode sessions purge`.
- **Checkpoint prune** — 20 terbaru per session.
- **Detect cache** — 30 menit per baseUrl; lazy import ink/react (startup <400ms).
- **Cost attribution** — `deepseek-v4-flash` pricing; cost dihitung pakai model efektif.

## [0.3.2] — 2026-08-25

### UX Provider & Gateway
- **Preset gateway** — `/provider-add` & setup wizard: pilih OpenAI/Anthropic/OpenRouter/DeepSeek/OpenCode Zen/Google → baseUrl, fallback models & id ramah otomatis. Custom URL tetap bisa.
- **Pengelolaan tanpa LLM** — `minicode providers | models [id] | sync` subcommands langsung.
- **`/sync` & refresh models** — model baru dari gateway tersinkron otomatis; apiKey intak.
- **Scope global/local** — `/provider-add` tanya penyimpanan (global default ~/.minicode); `/provider-remove` hapus dari kedua scope.
- **Transparansi fallback** — `/cost` & `/status` menampilkan model efektif bila router substitusi.
- **Auto-refresh cap 6s** — deteksi gateway offline tidak membuat user menunggu 30s.
- **Plain text** — `--help` & wizard tanpa ANSI (aman console legacy).
- `/sessions` bernomor + `/resume [id]` picker interaktif (respawn dengan seeding penuh).

## [0.3.1] — 2026-08-25

### QoL / TUI
- **Floating dropdown** saat ketik `/` di REPL — dimmed, seleksi `›`, ↑/↓ navigasi, Tab/Enter complete, Esc tutup, max 10 + `… N more`. Fallback inline di console legacy (auto-detect ANSI via DSR probe).
- **Prompt engine** `cli/prompt-engine.ts` — state machine input jadi pure function (testable), input.ts cuma IO+render.
- Error user-friendly (balance/auth/rate/timeout/context) — tidak lagi raw JSON 401.
- Unknown `/command` tidak di-forward ke LLM.
- `/model` & `/models` jadi picker interaktif; format `providerId::model` untuk pilih provider spesifik.
- Router: first-match-wins untuk nama model kembar (fix 401 jatuh ke provider salah).

### Engineering
- `bun run test:live` — live E2E terpisah dari `bun test` default (CI-safe tanpa secrets).
- 20 test baru untuk prompt engine.
- Fix `glyphs.sparkle` missing (`--help` "undefined Minicode").
- `detectAnsi` — probe DSR idempotent, tidak ada listerner bocor.

## [0.3.0] — 2026-08-24

### Security
- **Allowlist mode** (`--allowlist`) — bash hanya perintah aman (git/bun/npm/echo/ls/cat) via `DEFAULT_BASH_ALLOWLIST` atau `MINICODE_BASH_ALLOWLIST`.
- **Docker sandbox hardening** — `--read-only`, `--cap-drop ALL`, `--pids-limit 128`, `--tmpfs /tmp`.
- **Plan mode** (`--plan`) — read-only planning (write/bash/delegate diblokir) + workflow "Proceed to execute?".
- **Budget enforce** (`--budget <usd>`) — warn 80%, exit(1) one-shot / break REPL bila lewat.
- **Secret scrubber** — 9 pola (sk-/AKIA/PEM/JWT/Bearer/api_key=) di read_file/bash/grep, whitelist `test|example|mock`.
- **Jail** — `.env`/`.git/credentials`/`.ssh`/`.aws`/`.npmrc`/`.netrc`/key/pem; path traversal di `/undo` diblokir.

### Core / Kernel (minicore, additive seams)
- `SessionConfig.initialMessages` — seed history penuh (resume sejati).
- `compactAsync` — LLM compaction async dengan fallback mekanikal.

### Context & Repo
- **Repo-map** — regex 9 bahasa (TS/Py/Go/Rust/Java/C/C#/Ruby/PHP), ranking import-graph, cache `.minicode/repomap.json`, fallback LSP `workspace/symbol`, env `MINICODE_REPOMAP=regex`.
- **Self-heal** (`--verify`) — auto-detect typecheck/test/tsconfig, 3 siklus, guard fence anti prompt-injection.

### TUI/TUX
- Split-view responsif (<80 col stack), markdown fence highlight, scroll arrow keys, budget gauge.
- `cli/index.ts` dipecah → `cli/setup.ts` + `cli/repl.ts` + entry tipis; format event terpusat `src/tui/format.ts`.

### Operasional
- `minicode stats` — agregasi `.minicode/traces.jsonl`.
- Benchmark — 5 task + loader external (SWE-bench-format) + delta antar run.
- Telemetry `.minicode/traces.jsonl` (rotate 1000).
- Sesi TTL 30 hari; checkpoint pre-turn workspace snapshot.

## [0.2.0] — 2026-08-24

- Hardening keamanan: auto-gate delegate/mcp, denylist 27 regex, env-sanitize, jail terpusat.
- TUI: diff card, table, spinner, markdown fence, masked wizard, history, tab completion.
- Prompt caching Anthropic, fuzzy edit 4-level, apply_patch, checkpoint `/undo`/`/redo`.
- Repo-map (regex), auto-verify, resume sejati, rate limiter, Docker sandbox, telemetry JSON.
- 132 test + bench harness.

## [0.1.3] — 2026-08-22

- Audit 100% komponen, extreme test suite, security hardening (symlink escape, denylist bypass).
- 59 test.
