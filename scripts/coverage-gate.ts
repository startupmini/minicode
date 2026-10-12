#!/usr/bin/env bun
// Coverage gate agregat.
//
// Kenapa tidak `bunfig.toml` `coverageThreshold`? Bun mengevaluasi threshold
// itu PER FILE, bukan agregat — dengan 0.01 pun run tetap gagal karena ada file
// 0% (mis. src/sandbox/os.ts yang hanya jalan di Linux/macOS). Gate agregat
// harus dihitung dari baris "All files" pada tabel coverage.
//
// Sebelumnya CI memberi label "Test with coverage (threshold 80)" padahal
// `bun test --coverage` tanpa konfigurasi apa pun selalu lulus — gate-nya fiksi.
// Script ini menjadikannya nyata.
//
// Usage: bun scripts/coverage-gate.ts [--lines N] [--funcs N]

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { evaluateGate, gateExitCode } from "./coverage-decision.ts"

function getArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) ? v : fallback
}

// Baseline terukur setelah penambahan test lapisan UI (harness fake-TTY untuk
// askLine/picker + handler subcommand): 79,26% funcs /
// 82,13% lines. Ambil sedikit di bawah supaya CI tidak flaky, lalu naikkan
// bertahap. Riwayat: 0.7.0 = 71,95%/76,76%.
// Baseline baru setelah test anti-frozen runtime, highlight adversarial,
// provider-manager flows, dan CLI subprocess: 82,36% funcs / 84,16% lines.
// P13 P0 menambah 4 tool + safe-open + responses + swebench tanpa test yet
// → turun ke 77,82/81,24. Turunkan sementara, naikkan lagi setelah test P1.
// P13/P11/P10 P1 mendarat (TTL hierarkis, 2 tool, Responses, branch, doctor,
// safe-open/trash tests): 80,75/84,52. Kunci di 80/84 — sisa ke 81/83 ada di
// area lama yang belum tersentuh (lsp 18%, config 42%, repl), bukan kode baru.
// Harness P0-P3 + test config in-process (list/add/remove lokal, positional
// flag ditolak): 81,69/85,25. Kunci di 81/83.
// Pasca-fix HIGH (read_image TOCTOU, edit/patch jail, responses instance-local + 6 MEDIUM):
// 80,85/84,47 — funcs turun 0,84 karena branch defensif baru belum tercakup test
// (provider instance-local, safeOpenRead ENOENT mapping, pricing redirect check).
// Turunkan sementara ke 80/83 agar gate tidak flaky, naikkan lagi setelah test P1 tambahan.
// Enter→picker thinking + effort anti-hilang (preserve detectAndSave, scope-aware
// model-manager, 6 test baru): 81,83/84,32. Kunci lines di 84 (stabil di
// 84,12–84,32); funcs tetap 80 karena berayun 80,62–81,83 antar run (flaky bila 81).
// Mutation journal (AUDIT #01C: journal.ts 92,31/93,91 + 24 test, delegate
// wiring, resume/finalize): 82,42/85,17 dua run identik. Kunci lines di 85;
// funcs tetap 80 (aturan lama: jangan kunci funcs — berayun antar run flaky).
// Footer lengket (chrome sticky + faint + spark pulse + konteks live): 84,88
// lines (turun 0,12 karena branch MINICODE_FOOTER/off/print + pulse timer
// belum 100% tercakup). Turunkan sementara ke 84, naikkan lagi setelah test
// pulse/esc/context lebih komplit. Funcs tetap 80.
// TUI single-tampilan (hapus repl/chrome/overlay/info-window + form popup +
// thinking + approval tercatat + live repaint): 83,10/84,53 dua run identik.
// Kunci lines di 84,5; funcs tetap 80.
// Bug-hunt TUI deep + fix semua (sanitize C1/bidi, truncate/chunk SGR-only,
// boundary diff/format/table/section/markdown/highlight, locale LC_ALL,
// tooSmall abort, stale-handle, clear/scroll, approval pipe-deny, form
// revert, i18n label + 30 test baru): 83,28/84,58 satu run. Lines +0,05
// (noise) — kunci tetap 84,5; funcs tetap 80 (aturan lama anti-flaky).
// Audit TUI (sinyal SIGTERM/SIGHUP, Home/End jump, Shift+Pg half-page,
// abort hint, MINICODE_MOTION, kursor sync-update, form idle + 13 test
// baru): 83,42–83,45/84,64–84,65. Lines +0,14 — margin terlalu tipis untuk
// dikunci 84,6 (berisiko flaky); kunci tetap 84,5; funcs tetap 80.
// Audit menyeluruh 2026-09-23 (F1 skip PTY nyata, F5 lantai per-berkas, F9
// env docs, F13 batas lapisan): 83,42 funcs / 84,64 lines, 2350 pass / 20 skip
// (run penuh 259 dtk). Funcs NAIK dikunci 83 (margin 1,2 pp — sebelumnya 80
// dibiarkan 3,4 pp di bawah hasil terukur, jadi tak pernah menangkap regresi);
// lines tetap 84,5 (margin 0,14 pp sudah disengaja anti-flaky sejak 0.10.x).
// Phase 2 parity: 84,46 funcs / 85,46 lines, 2559 pass / 22 skip. Kunci di
// 84/85 sesuai aturan repo (naikkan minimum bila coverage naik).
// P2.10 Verification (ToolInvocationId + EffectIntent/Receipt + VerificationRecord
// + idempotency + read-back verifier + 50 test baru, verification.ts 97,01/99,66,
// evidence.ts 100/100): 86,65 funcs / 87,54 lines satu run. Kunci di 85/86
// (margin ~1,6/1,5 pp anti-flaky, konsisten praktik repo).
const MIN_LINES = getArg("--lines", 86)
const MIN_FUNCS = getArg("--funcs", 85)

// ── lantai per-berkas modul kritis (audit F5) ──
// Gate agregat BUTA terhadap modul tunggal yang jatuh: policy/jail 97% → 5%
// tak terlihat selama total tertahan. Daftar ini SENGAJA per-berkas, bukan
// per-direktori — modul ber-lantai rendah karena batas proses/jaringan
// (mcp/server.ts dijalankan test-nya sebagai subprocess sehingga tak
// terinstrumentasi; update-check/web_search/lsp butuh server nyata) tak boleh
// memaksa exemption global.
// Angka = hasil terukur 2026-09-23 dikurangi margin ≥5 pp. Bila berkas
// dipindah/di-rename, gate GAGAL ("tidak ada di laporan") supaya lantai tak
// pernah jadi zombie yang diam-diam tak memeriksa apa pun.
// Blind spot yang DICATAT (belum dilantai, alasan diverifikasi):
//   src/mcp/server.ts 5,06% lines — test-nya spawn server (proses lain);
//   cli/auto-update.ts 18,18% — butuh rilis npm nyata;
//   src/lib/atomic-write.ts 53,73% — cabang retry Windows EPERM/EBUSY;
//   src/policy/pricing.ts 68,78% / src/tools/web_search.ts 48,87% — jaringan.
const CRITICAL_FILES: [string, number, number][] = [
  // [path, min funcs, min lines]
  ["src/policy/permission.ts", 90, 90],
  ["src/policy/jail.ts", 92, 92],
  ["src/policy/bash-guard.ts", 92, 92],
  ["src/policy/executor.ts", 92, 92],
  ["src/policy/scrub.ts", 95, 95],
  ["src/lib/net.ts", 90, 90],
  ["src/lib/trusted-exec.ts", 90, 90],
  ["src/lib/safe-open.ts", 58, 90],
  ["src/session/journal.ts", 85, 90],
  ["src/session/checkpoint.ts", 80, 85],
  ["src/providers/router.ts", 78, 90],
  ["src/ui/render/sanitize.ts", 90, 90],
  ["src/ui/render/width.ts", 90, 90],
  ["src/ui/tui/app.ts", 85, 90],
  ["src/tools/bash.ts", 72, 78],
  // Fase 3 Presentasi V2.1 — lantai 90 untuk modul kritis baru (plan §26 P3).
  ["src/presentation/model.ts", 90, 90],
  ["src/presentation/reducer.ts", 90, 90],
  ["src/presentation/label.ts", 90, 90],
  // Fase 4 Content Store (plan §26 P4) — lantai 90.
  ["src/presentation/store.ts", 90, 90],
]

// Uraian baris per-berkas tinggal di ./coverage-decision.ts (fileCoverage),
// dipakai bersama test gate-nya. Status test dan liputan dievaluasi
// independen: kegagalan test TERCATAT tetapi tak lagi menghentikan evaluasi
// liputan — keduanya dilaporkan dan keduanya menggagalkan gate.

// Opsi `--report <file>`: evaluasi ulang laporan yang SUDAH ada tanpa
// menjalankan suite (4 menit). Dipakai saat CI merah untuk tahu modul mana yang
// jatuh, dan untuk menguji gate ini sendiri tanpa membayar satu run penuh.
const reportIdx = process.argv.indexOf("--report")
const savedReport = reportIdx !== -1 ? process.argv[reportIdx + 1] : undefined

let output: string
let runFailure: string | null = null
if (savedReport) {
  output = readFileSync(savedReport, "utf8")
} else {
  const res = spawnSync(
    process.execPath,
    ["test", "--coverage", "--reporter", "dots", "--timeout", "30000"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    },
  )
  output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`
  if (res.status !== 0 && !/\d+ pass/.test(output)) {
    process.stderr.write(output.slice(-4000))
    runFailure = "[coverage-gate] test run failed"
  }
}

const ev = evaluateGate(
  output,
  { minFuncs: MIN_FUNCS, minLines: MIN_LINES },
  CRITICAL_FILES,
  runFailure,
)
if (ev.runFailure) console.error(ev.runFailure)
if (ev.failCount > 0) {
  console.error(`[coverage-gate] ${ev.failCount} test failing`)
  // Cetak nama test yang gagal — tanpa ini, reporter dots menelan nama dan
  // kegagalan spesifik-coverage jadi mustahil didiagnosis dari log CI.
  for (const name of ev.failNames) {
    console.error(`  ${name}`)
  }
}

// "All files                     |   71.95 |   76.76 |"
if (ev.parseError) {
  console.error(ev.parseError)
} else if (ev.aggregate) {
  console.log(
    `[coverage-gate] funcs ${ev.aggregate.funcs.toFixed(2)}% (min ${MIN_FUNCS}) · lines ${ev.aggregate.lines.toFixed(2)}% (min ${MIN_LINES})`,
  )
}

// Lantai per-berkas modul kritis — dijalankan SEBELUM keputusan agregat agar
// modul yang jatuh sendiri selalu terlihat, walau total masih di atas ambang.
for (const msg of ev.criticalFailures) {
  console.error(msg)
}
console.log(
  `[coverage-gate] lantai per-berkas: ${CRITICAL_FILES.length - ev.criticalFailures.length}/${CRITICAL_FILES.length} modul kritis hijau`,
)
for (const msg of ev.aggregateFailures) {
  console.error(msg)
}
process.exit(gateExitCode(ev))
