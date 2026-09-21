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
const MIN_LINES = getArg("--lines", 84.5)
const MIN_FUNCS = getArg("--funcs", 80)

const res = spawnSync(
  process.execPath,
  ["test", "--coverage", "--reporter", "dots", "--timeout", "30000"],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  },
)
const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`

if (res.status !== 0 && !/\d+ pass/.test(output)) {
  process.stderr.write(output.slice(-4000))
  console.error("[coverage-gate] test run failed")
  process.exit(1)
}

const failCount = Number(/(\d+) fail/.exec(output)?.[1] ?? "0")
if (failCount > 0) {
  console.error(`[coverage-gate] ${failCount} test failing — gate tidak dievaluasi`)
  // Cetak nama test yang gagal — tanpa ini, reporter dots menelan nama dan
  // kegagalan spesifik-coverage jadi mustahil didiagnosis dari log CI.
  for (const line of output.match(/^\(fail\).*$/gm) ?? []) {
    console.error(`  ${line.slice(0, 160)}`)
  }
  process.exit(1)
}

// "All files                     |   71.95 |   76.76 |"
const row = /^\s*All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/m.exec(output)
if (!row) {
  console.error("[coverage-gate] baris 'All files' tidak ditemukan di output coverage")
  process.exit(1)
}
const funcs = Number(row[1])
const lines = Number(row[2])

const okFuncs = funcs >= MIN_FUNCS
const okLines = lines >= MIN_LINES
console.log(
  `[coverage-gate] funcs ${funcs.toFixed(2)}% (min ${MIN_FUNCS}) · lines ${lines.toFixed(2)}% (min ${MIN_LINES})`,
)
if (okFuncs && okLines) process.exit(0)
if (!okFuncs) console.error(`[coverage-gate] FAIL funcs ${funcs.toFixed(2)}% < ${MIN_FUNCS}%`)
if (!okLines) console.error(`[coverage-gate] FAIL lines ${lines.toFixed(2)}% < ${MIN_LINES}%`)
process.exit(1)
