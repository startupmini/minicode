#!/usr/bin/env bun
import { spawnSync } from "node:child_process"
// Kampanye mutasi FASE 6AE untuk kontrak integritas vendor.
//
// [FASE 6AE] Apa yang sebenarnya diuji di sini.
//
// Perbaikan 6AE membuat verifikasi vendor lebih toleran terhadap line ending -
// dan itu persis jenis perubahan yang bisa dibeli dengan boolean: sebuah
// normalisasi yang terlalu longgar membuat hash selalu cocok, lalu `vendor:check`
// hijau pada tree yang benar-benar bocor. Kampanye ini membuktikan bahwa toleransi
// itu PERSIS sebatas yang dijanjikan, dan tidak satu karakter lebih.
//
// Kontrak hash tinggal di SATU tempat (test/helpers/vendor-hash.ts). Semua mutan
// di bawah men-target implementasi itu atau pemanggilnya - bukan salinan, karena
// menguji salinan tidak membuktikan apa pun tentang yang dipanggil.
//
// Status:
//   KILLED       test yang menangkap mutan
//   EQUIVALENT   mutan tidak mengubah apa pun yang diamankan
//   UNEXECUTED   anchor tidak resolve TEPAT SATU kali = KEGAGALAN KAMPANYE
//
// KEAMANAN (brief 6AE bagian 12): tidak memakai `git checkout` sebagai pemulihan.
// Setiap file dicadangkan ke memori, ditulis ulang, lalu diverifikasi dengan hash
// setelah pulih. Kalau verifikasi gagal, kampanye BERHENTI.
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

type Status = "KILLED" | "EQUIVALENT" | "UNEXECUTED"

interface Mut {
  id: string
  target: string
  file: string
  anchor: string
  replacement: string
  test: string
  expect: Status
  note?: string
}

const HELPER = "test/helpers/vendor-hash.ts"
const SCRIPT = "scripts/vendor-minicore.ts"
const PACK = "test/pack-integrity.test.ts"
const T_VENDOR = "test/phase6ae-vendor-eol.test.ts"
const T_PACK = "test/pack-integrity.test.ts"
const T_HASH = "test/phase6ae-vendor-hash.test.ts"

const MUTATIONS: Mut[] = [
  {
    id: "M1",
    target: "normalisasi EOL dihapus dari helper kanonik",
    file: HELPER,
    anchor:
      '  return Buffer.from(buf.toString("utf8").replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n"), "utf8")',
    replacement: "  return buf",
    test: T_VENDOR,
    expect: "KILLED",
    note: "Membuktikan perbaikannya ada di helper, bukan di test. Tanpa normalisasi, source LF vs vendor CRLF kembali dilaporkan TIDAK sinkron - kegagalan 9d79ebb yang asli.",
  },
  {
    id: "M2",
    target: "satu karakter konten nyata diabaikan (byte terakhir tiap file dibuang)",
    file: HELPER,
    anchor: "    h.update(existsSync(p) ? semanticBytes(readFileSync(p)) : Buffer.alloc(0))",
    replacement:
      "    const b = existsSync(p) ? semanticBytes(readFileSync(p)) : Buffer.alloc(0)\n    h.update(b.length > 0 ? b.subarray(0, b.length - 1) : b)",
    // [FASE 6AE] Test yang tepat adalah test KONTRAK helper, bukan test EOL.
    // Percobaan pertama menunjuk T_VENDOR dan hasilnya EQUIVALENT - dan itu
    // tidak salah: test EOL hanya menguji steady state vendor yang sudah
    // sinkron, jadi tidak ada karakter terakhir yang bisa hilang.
    test: T_HASH,
    expect: "KILLED",
    note: "Test yang membunuh ini adalah `a change in the LAST character changes the hash` di test kontrak helper. Mutan ini tidak ada hubungan dengan EOL - kalau hanya test EOL yang ada, mutan seperti ini akan lolos tanpa pernah terlihat.",
  },
  {
    id: "M3",
    target: "file biner ikut dinormalkan (gerbang NUL dimatikan)",
    file: HELPER,
    anchor:
      "export function looksBinary(buf: Buffer): boolean {\n  return buf.subarray(0, 8000).includes(0)\n}",
    replacement: "export function looksBinary(_buf: Buffer): boolean {\n  return false\n}",
    test: T_HASH,
    expect: "KILLED",
    note: "Menormalkan biner sebagai UTF-8 = kehilangan byte dan merusak payload. Test biner harus menangkapnya; kalau tidak, gerbang NUL tidak menjalankan apa pun.",
  },
  {
    id: "M4",
    target: "perbandingan hash jadi selalu dianggap sama",
    file: SCRIPT,
    anchor: "  if (sameSet && sourceHash === vendorHash) {",
    replacement: "  if (sameSet) {",
    test: T_VENDOR,
    expect: "KILLED",
    note: "Mutan paling berbahaya dari semua: ia membuat `vendor:check` hijau pada vendor yang bocor. WAJIB dibunuh - inilah pembuktian bahwa perbaikan EOL tidak dibeli dengan integrity check.",
  },
  {
    id: "M5",
    target: "jalur sync menormalkan EOL saat menyalin (bukan byte mentah)",
    file: SCRIPT,
    anchor: "  writeFileSync(to, next)",
    replacement:
      "  writeFileSync(to, Buffer.from(next.toString('utf8').replace(/\\r\\n/g, '\\n'), 'utf8'))",
    test: T_VENDOR,
    expect: "EQUIVALENT",
    note: "EQUIVALENT adalah jawaban jujur, bukan kelemahan yang disembunyikan. Selisih EOL pada jalur sync tidak terlihat oleh gate hash - hash memang dinormalkan. Dan itu memang perilaku yang diminta brief: 'sync path tetap menyalin byte mentah'. Test ini tidak membedakan jalur sync, jadi ia tidak bisa membunuh mutan ini; pemulangan byte mentah diverifikasi terpisah lewat fingerprint, bukan lewat test hash.",
  },
  {
    id: "M6",
    target: "pack-integrity kembali memakai hash byte mentah (duplikat kontrak)",
    file: PACK,
    anchor:
      "  function hashOf(files: string[]): string {\n    return vendorFileHash(vendorDir, files)\n  }",
    replacement:
      "  function hashOf(files: string[]): string {\n    const h = createHash('sha256')\n    for (const f of files) {\n      h.update(f)\n      h.update('\\0')\n      h.update(readFileSync(join(vendorDir, f)))\n      h.update('\\0')\n    }\n    return h.digest('hex').slice(0, 16)\n  }",
    test: T_PACK,
    expect: "KILLED",
    note: "Mutan ini mengembalikan duplikasi yang baru saja dihapus. Di checkout CRLF test pack-integrity harus kembali gagal - membuktikan audit #11 benar-benar bergantung pada kontrak helper, bukan kebetulan.",
  },
]

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16)

let killed = 0
let equivalent = 0
let unexecuted = 0
let failures = 0

console.log(`  PHASE 6AE canonical-hash mutation campaign (${MUTATIONS.length} planned)\n`)

const preCampaign = new Map<string, string>()
for (const m of MUTATIONS) {
  if (!preCampaign.has(m.file)) preCampaign.set(m.file, readFileSync(m.file, "utf8"))
}

for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8")
  const occurrences = original.split(m.anchor).length - 1
  if (occurrences !== 1) {
    console.log(`  ${m.id.padEnd(4)} UNEXECUTED  ${m.target}`)
    console.log(`         anchor resolved ${occurrences}x (need exactly 1) in ${m.file}`)
    unexecuted++
    failures++
    continue
  }
  writeFileSync(m.file, original.replace(m.anchor, m.replacement), "utf8")
  if (readFileSync(m.file, "utf8") === original) {
    console.log(`  ${m.id.padEnd(4)} UNEXECUTED  ${m.target}\n         mutation was a no-op`)
    unexecuted++
    failures++
    continue
  }

  // typecheck lebih dulu: mutasi yang tidak compile tidak menguji kode sama sekali.
  const ts = spawnSync("bunx", ["tsc", "--noEmit"], { encoding: "utf8", timeout: 900_000 })
  const base = m.file.split("/").pop() ?? ""
  const tsBroke =
    ts.status !== 0 && `${ts.stdout}${ts.stderr}`.split("\n").some((l) => l.includes(base))

  const r = spawnSync("bun", ["test", m.test], { encoding: "utf8", timeout: 1_800_000 })
  const output = `${r.stdout}${r.stderr}`
  const failed = Number(/^\s*(\d+) fail/m.exec(output)?.[1] ?? -1)

  writeFileSync(m.file, original, "utf8")
  const restored = readFileSync(m.file, "utf8")
  if (restored !== original || sha(restored) !== sha(original)) {
    console.log(
      `  ${m.id.padEnd(4)} ABORTED     restoration failed for ${m.file} - campaign halted`,
    )
    failures++
    break
  }

  const status: Status =
    tsBroke || failed > 0 ? "KILLED" : failed === 0 ? "EQUIVALENT" : "UNEXECUTED"
  const ok = status === m.expect
  if (status === "KILLED") killed++
  else if (status === "EQUIVALENT") equivalent++
  else unexecuted++
  if (!ok) failures++

  console.log(
    `  ${m.id.padEnd(4)} ${status.padEnd(9)}  ${m.target}\n         ${failed} test(s) failed; typecheck=${tsBroke ? "broken (counts as killed)" : "clean"}; expected ${m.expect}${ok ? "" : "   <-- UNEXPECTED"}`,
  )
  if (m.note) console.log(`         ${m.note}`)
  console.log("")
}

console.log("  restoration audit:")
const dirty: string[] = []
for (const [f, pre] of preCampaign) {
  if (sha(readFileSync(f, "utf8")) !== sha(pre)) dirty.push(f)
}
if (dirty.length === 0) {
  console.log(`    all ${preCampaign.size} file(s) byte-identical to pre-campaign content`)
} else {
  console.log(`    LEFTOVER MUTATION: ${dirty.join(", ")}`)
  failures++
}

console.log(
  `\n  accumulated=${MUTATIONS.length}/${MUTATIONS.length} killed=${killed} equivalent=${equivalent} unexecuted=${unexecuted}`,
)
console.log(
  failures > 0 ? `  campaign_failure: ${failures} problem(s)` : "  campaign_failure: none",
)
if (failures > 0) process.exit(1)
