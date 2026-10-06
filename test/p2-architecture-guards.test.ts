// P2.0 — Guard arsitektur: batas vendor, batas scope P2, anti-penghancur
// sumber konteks (ARCHITECTURE-GUARD). Semua machine-checkable kini.

import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = process.cwd()

function tracked(pattern: RegExp): string[] {
  const r = spawnSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 })
  if (r.status !== 0) return []
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => pattern.test(s))
}

function specsOf(src: string): string[] {
  const out: string[] = []
  const re = /(?:\bfrom|\bimport|\brequire)\s*\(?["']([^"']+)["']/g
  for (const m of src.matchAll(re)) out.push(m[1]!)
  return out
}

test("[ARCHITECTURE-GUARD] vendor/minicore bebas kopling persistensi aplikasi", () => {
  // Allowlist terbalik: vendor TIDAK BOLEH menyentuh subsistem milik app.
  const forbidden = [
    "bun:sqlite",
    "session_authority",
    "TaskStore",
    "TaskGraph",
    "sanitizeSession",
    "tasks.db",
    "journal-",
    "migration",
  ]
  const files = tracked(/^vendor\/minicore\/src\/.*\.ts$/)
  expect(files.length).toBeGreaterThan(5)
  const hits: string[] = []
  for (const f of files) {
    const src = readFileSync(f, "utf8")
    for (const spec of specsOf(src)) {
      if (spec.includes("../src/") || spec.includes("src/session") || spec.includes("src/task")) {
        hits.push(`${f} -> ${spec}`)
      }
    }
    for (const token of forbidden) {
      if (src.includes(token)) hits.push(`${f} ~~ ${token}`)
    }
  }
  expect(hits).toEqual([])
})

test("[ARCHITECTURE-GUARD] seam vendor yang diizinkan: hanya callback/info minimal", () => {
  // Kontrak arah: vendor boleh menyediakan info eksekusi; kepemilikan
  // persistensi/otoritas tetap di app. Guard ini mengunci arah tsb agar
  // P2.4 tidak menggeser arsitektur ke dalam vendor.
  const files = tracked(/^vendor\/minicore\/src\/core\/session\.ts$/)
  expect(files.length).toBe(1)
  const src = readFileSync(files[0]!, "utf8")
  expect(src.includes("bun:sqlite")).toBe(false)
  expect(src.includes("session_authority")).toBe(false)
})

test("[ARCHITECTURE-GUARD] scope P2: belum ada artefak P3+ di produksi", () => {
  // P2.1 MENDARAT: `session_aliases` kini artefak sah (dikeluarkan dari
  // daftar larangan via diff ini — bukan edit senyap). P2.2 MENDARAT:
  // `writer_epoch` + `session_takeovers` juga sah. P2.3 MENDARAT:
  // `threads`/`runs`/`history_projections` + kolom dorman juga sah (STORAGE
  // ONLY — guard aktivasi runtime ada di bawah). Sisanya tetap terlarang.
  const forbiddenFiles = tracked(/^src\/(retrieval|multiversion|exactly_once).*\.ts$/)
  expect(forbiddenFiles).toEqual([])
  const sessionFiles = tracked(/^src\/session\/.*\.ts$/)
  const hits: string[] = []
  for (const f of sessionFiles) {
    const src = readFileSync(f, "utf8")
    for (const token of ["thread_migr_"]) {
      if (src.includes(token)) hits.push(`${f} ~~ ${token} (pra-fase: belum boleh ada)`)
    }
  }
  expect(hits).toEqual([])
  // Peta alias P2.1 WAJIB ada tepat satu: tabel di persistence + resolver.
  // (identity.ts baru & belum ter-commit → existsSync, bukan git ls-files.)
  expect(readFileSync("src/session/persistence.ts", "utf8").includes("session_aliases")).toBe(true)
  expect(existsSync(join(repoRoot, "src", "session", "identity.ts"))).toBe(true)
  // Pagar epoch P2.2 WAJIB ada: kolom + CAS + takeover + modul authority.
  const persist = readFileSync("src/session/persistence.ts", "utf8")
  expect(persist.includes("writer_epoch")).toBe(true)
  expect(persist.includes("session_takeovers")).toBe(true)
  expect(persist.includes("REFUSED_STALE_EPOCH")).toBe(true)
  expect(existsSync(join(repoRoot, "src", "session", "authority.ts"))).toBe(true)
  // Kerangka P2.3 WAJIB ada: tiga tabel + kolom dorman (storage only).
  for (const token of [
    "CREATE TABLE IF NOT EXISTS threads",
    "CREATE TABLE IF NOT EXISTS runs",
    "CREATE TABLE IF NOT EXISTS history_projections",
    "default_thread_id",
  ]) {
    expect(persist.includes(token)).toBe(true)
  }
})

test("[ARCHITECTURE-GUARD] P2.3: kerangka tanpa aktivasi runtime", () => {
  // P2.4 MENGAKTIFKAN threads, P2.6 MENGAKTIFKAN runs, P2.7 MENGAKTIFKAN
  // history_projections (satu-satunya prod writer untuk ketiganya =
  // persistence.ts). Guard membedakan writer kanonik dari penulis liar.
  const prodFiles = [...tracked(/^cli\/.*\.ts$/), ...tracked(/^src\/.*\.ts$/)]
  const threadWriters = prodFiles.filter(
    (f) =>
      f !== "src/session/persistence.ts" &&
      /INSERT\s+INTO\s+threads\b/i.test(readFileSync(f, "utf8")),
  )
  expect(threadWriters).toEqual([])
  // P2.6: run TIDAK dorman lagi, tapi tetap satu writer kanonik — tak boleh
  // ada prod file lain yang menyuntik baris run di luar persistence.ts.
  const runWriters = prodFiles.filter(
    (f) =>
      f !== "src/session/persistence.ts" && /INSERT\s+INTO\s+runs\b/i.test(readFileSync(f, "utf8")),
  )
  expect(runWriters).toEqual([])
  // P2.7: proyeksi TIDAK dorman lagi, tapi tetap satu writer kanonik — tak
  // boleh ada prod file lain yang menyuntik baris proyeksi di luar
  // persistence.ts.
  const projectionWriters = prodFiles.filter(
    (f) =>
      f !== "src/session/persistence.ts" &&
      /INSERT\s+INTO\s+history_projections\b/i.test(readFileSync(f, "utf8")),
  )
  expect(projectionWriters).toEqual([])
  // Tak ada rename tabel messages (kontrak: nama fisik dipertahankan).
  const renames = prodFiles.filter((f) =>
    /RENAME\s+(TABLE\s+)?messages|ALTER\s+TABLE\s+messages\s+RENAME/i.test(readFileSync(f, "utf8")),
  )
  expect(renames).toEqual([])
})

test("[ARCHITECTURE-GUARD] P2.4: tulis histori aktif wajib thread-scoped", () => {
  // Setiap INSERT INTO messages di persistence.ts membawa thread_id —
  // tak ada jalur tulis kanonik (session_id, seq) polos yang tersisa.
  // BACA kompatibel (loadSession signature sesi) sengaja dikecualikan:
  // baca ≠ tulis (lihat komentar LEGACY-COMPAT di guard P2.2).
  const src = readFileSync("src/session/persistence.ts", "utf8")
  const inserts = src.split("\n").filter((l) => /INSERT\s+INTO\s+messages\b/i.test(l))
  expect(inserts.length).toBeGreaterThan(0)
  expect(inserts.filter((l) => !/thread_id/i.test(l))).toEqual([])
})

test("[ARCHITECTURE-GUARD] P2.4: tanpa lease Thread, tanpa fork, tanpa traversal", () => {
  // Pagar tetap milik sesi (writer_epoch); Thread tak punya lease sendiri.
  // forkThread/traversal milik P3+ (prasyarat P2.7 belum terpenuhi).
  const bad: string[] = []
  for (const f of [...tracked(/^cli\/.*\.ts$/), ...tracked(/^src\/.*\.ts$/)]) {
    const content = readFileSync(f, "utf8")
    if (/thread_authority|thread_lease|acquireThreadOwnership/i.test(content)) {
      bad.push(`${f}: thread-lease`)
    }
    if (/function forkThread|const forkThread/i.test(content)) bad.push(`${f}: forkThread`)
  }
  expect(bad).toEqual([])
  const unions = readFileSync("src/session/persistence.ts", "utf8")
    .split("\n")
    .filter((l) => /\bUNION\b/i.test(l))
  expect(unions).toEqual([])
})

test("[ARCHITECTURE-GUARD] P2.3: tasks.db tak tersentuh fase sesi", () => {
  // Tak ada DDL tasks baru dari fase P2 (TaskGraphRef milik P2.9): tidak ada
  // tabel baru di store SELAIN tiga yang sudah ada (tasks/task_meta/
  // session_authority — diverifikasi eksplisit di bawah), dan tak ada kolom
  // P2.3 (epoch/thread/run/proyeksi/taskgraph) bocor ke DDL task.
  const bad = tracked(/^src\/task\/.*\.ts$/).filter((f) => {
    const src = readFileSync(f, "utf8")
    if (
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?!tasks\b|task_meta\b|session_authority\b)\w+/i.test(
        src,
      )
    ) {
      return true
    }
    return /writer_epoch|default_thread_id|history_projections|taskgraph_ref/i.test(src)
  })
  expect(bad).toEqual([])
})

test("[ARCHITECTURE-GUARD] P2.1: identitas ganda usang tak boleh kembali", () => {
  // presentationSessionId dihapus dari KODE (komentar riwayat/docs boleh
  // menyebutnya — yang dilarang adalah pemakaian sebagai identitas).
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n")
  const codeFiles = [...tracked(/^cli\/.*\.ts$/), ...tracked(/^src\/.*\.ts$/)]
  const dualId = codeFiles.filter((f) =>
    stripComments(readFileSync(f, "utf8")).includes("presentationSessionId"),
  )
  expect(dualId).toEqual([])
  // Dual-write steady-state: save kedua berdasar resumeId tidak boleh ada.
  const dualWrite = codeFiles.filter((f) =>
    readFileSync(f, "utf8").includes("saveSession(resumeId"),
  )
  expect(dualWrite).toEqual([])
})

test("[ARCHITECTURE-GUARD] P2.1: SATU sanitizer, SATU titik mint identitas", () => {
  // Regex sanitasi sesi hanya boleh hidup di canonical helper.
  const dupes = tracked(/^cli\/.*\.ts$/).filter((f) => {
    const src = readFileSync(f, "utf8")
    return src.includes("[^A-Za-z0-9._-]")
  })
  expect(dupes).toEqual([])
  // Mint id acak sesi hanya via mintSessionId (identity.ts); bootId/fresh
  // lewat sana. Pengecualian sah: nol di cli/ (child sub_ milik domain task).
  const mints = tracked(/^cli\/.*\.ts$/).filter((f) => {
    const src = readFileSync(f, "utf8")
    return src.includes("randomUUID().slice(0, 8)")
  })
  expect(mints).toEqual([])
})

test("[ARCHITECTURE-GUARD] P2.2: epoch hanya berubah di takeover/cabang", () => {
  // UPDATE writer_epoch hanya sah di dua fungsi: takeoverSessionEpoch (CAS
  // +1) dan branchSession (reset 0 garis baru). Verifikasi dengan melihat
  // fungsi pembungkus 80 baris ke atas tiap temuan.
  const files = tracked(/^src\/.*\.ts$/)
  const bad: string[] = []
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n")
    lines.forEach((line, i) => {
      if (!/UPDATE\s+sessions\s+SET\s+writer_epoch/i.test(line)) return
      const context = lines.slice(Math.max(0, i - 80), i + 1).join("\n")
      const okFn =
        /function takeoverSessionEpoch[\s\S]*$/.test(context) ||
        /export async function branchSession[\s\S]*$/.test(context)
      if (!okFn) bad.push(`${f}:${i + 1}`)
    })
  }
  expect(bad).toEqual([])
})

test("[ARCHITECTURE-GUARD] P2.2: nilai epoch tak pernah dari input pemanggil", () => {
  // Epoch di SQL hanya via `?` params (DB read / +1) — tak ada interpolasi
  // `${...epoch...}` yang memungkinkan caller memilih epochnya sendiri.
  const bad: string[] = []
  for (const f of tracked(/^src\/.*\.ts$/)) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/writer_epoch/i.test(line) && /\$\{[^}]*poch/i.test(line)) bad.push(`${f}:${i + 1}`)
      })
  }
  expect(bad).toEqual([])
})

test("[ARCHITECTURE-GUARD] P2.2: baris sessions hanya ditulis persistence.ts", () => {
  const writers = tracked(/^src\/.*\.ts$/).filter(
    (f) =>
      f !== "src/session/persistence.ts" &&
      /INSERT\s+INTO\s+sessions|UPDATE\s+sessions\s+SET/i.test(readFileSync(f, "utf8")),
  )
  expect(writers).toEqual([])
})

test("[ARCHITECTURE-GUARD] P2.2: pemanggil produksi saveSession/append wajib pagar", () => {
  // Setiap saveSession(/appendPresentationEvents(/appendHistoryEvent(
  // /backfillHistoryEventIds( di cli//src/ wajib membawa expectedEpoch —
  // KECUALI situs legacy yang didaftar eksplisit (child sub-agen: namespace
  // tanpa admission; wilayah P9+). Test (bun:test) sengaja di luar cakupan.
  const legacyAllowed = new Set(["cli/index.ts"])
  const bad: string[] = []
  for (const f of [...tracked(/^cli\/.*\.ts$/), ...tracked(/^src\/.*\.ts$/)]) {
    const src = readFileSync(f, "utf8")
    for (const m of src.matchAll(
      /(saveSession|appendPresentationEvents|appendHistoryEvent|backfillHistoryEventIds|shrinkThreadHistory|buildProjection|rebuildProjection)\(/g,
    )) {
      if (legacyAllowed.has(f)) continue
      const stmt = src.slice(m.index, m.index + 600)
      if (!stmt.includes("expectedEpoch")) bad.push(`${f}: ${src.slice(m.index, m.index + 60)}...`)
    }
  }
  expect(bad).toEqual([])
})

test("[ARCHITECTURE-GUARD] P2.5: satu allocator per jenis id, tanpa update event, tanpa exec_", () => {
  // SATU allocator produksi per jenis identitas: randomUUID hanya di
  // allocateHistoryEventId (evt_, P2.5), allocateRunId (run_, P2.6), dan
  // allocateChildSessionId (sub_, P2.9). Semuanya identitas BERBEDA; tak ada
  // id P1 yang dipromosi diam-diam.
  const persist = readFileSync("src/session/persistence.ts", "utf8")
  expect(persist.split("randomUUID()").length - 1).toBe(3)
  expect(persist.includes("export function allocateHistoryEventId")).toBe(true)
  expect(persist.includes("export function allocateRunId")).toBe(true)
  expect(persist.includes("export function allocateChildSessionId")).toBe(true)
  // SATU PRODUKEN eventId: hanya allocateHistoryEventId yang membangun
  // prefiks evt_ (call site banyak, konstruktor id satu).
  expect(persist.split("export function allocateHistoryEventId").length - 1).toBe(1)
  expect(persist.split("evt_${").length - 1).toBe(1)
  // Tak ada reuse identitas P1 (exec_/dsp_) sebagai run_id. Kode saja —
  // komentar قد menjelaskan keputusan "tak ada reuse" tanpa jadi pelanggaran.
  const persistCode = persist
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n")
  expect(persistCode.includes("exec_")).toBe(false)
  expect(persistCode.includes("dsp_")).toBe(false)
  // UPDATE messages HANYA backfill NULL (thread_id/event_id + migrated);
  // tak ada jalur yang menimpa konten/seq/id yang sudah ada.
  const updates = persist
    .split("\n")
    .filter((l) => /UPDATE\s+messages\s+SET/i.test(l))
    .map((l) => l.trim())
  expect(updates.length).toBeGreaterThan(0)
  for (const u of updates) {
    expect(/SET\s+(thread_id|event_id|migrated)\s*=/i.test(u)).toBe(true)
  }
  // EventId conflict error + UNIQUE komposit WAJIB ada (bukan janji lisan).
  expect(persist.includes("REFUSED_EVENT_ID_CONFLICT")).toBe(true)
  expect(persist.includes("udx_messages_event_id")).toBe(true)
})

test("[ARCHITECTURE-GUARD] P2.9: Sub-Agent kanonik, berpagar, dan terisolasi", () => {
  const persist = readFileSync("src/session/persistence.ts", "utf8")
  const setup = readFileSync("cli/setup.ts", "utf8")
  const task = readFileSync("src/tools/task.ts", "utf8")

  // 1. Schema lineage child: dua kolom aditif + indeks (tanpa tabel baru).
  expect(persist).toContain("ADD COLUMN parent_session_id TEXT NULL")
  expect(persist).toContain("ADD COLUMN parent_run_id TEXT NULL")
  expect(persist).toContain("idx_sessions_parent")
  // Tak ada tabel/authority skema baru untuk child (guna model C: pakai
  // sessions/threads/runs yang sudah ada).
  expect(/CREATE TABLE[^;]*\bchild/i.test(persist)).toBe(false)
  expect(persist.includes("sub_agent_runs")).toBe(false)

  // 2. Child Session kanonik: createChildSession menulis baris `sessions`
  //    DAN default Thread DAN Run dalam satu txn (durable causality).
  const cStart = persist.indexOf("export function createChildSession")
  expect(cStart).toBeGreaterThan(-1)
  const cEnd = persist.indexOf("export function getChildSessionLink")
  const cSrc = persist.slice(cStart, cEnd)
  expect(cSrc).toContain("INSERT INTO sessions")
  expect(cSrc).toContain("parent_session_id")
  expect(cSrc).toContain("parent_run_id")
  expect(cSrc).toContain("ensureDefaultThreadInTxn")
  expect(cSrc).toContain("INSERT INTO runs")

  // 3. Child TIDAK boleh RUNNING pada dua anak dalam satu Session: itu sebab
  //    Model C ada. Guard memaksa index single-RUNNING tetap utuh.
  expect(persist).toContain("udx_runs_single_running")
  expect(persist).toContain("ON runs(session_id) WHERE status = 'RUNNING'")

  // 4. Writer epoch anak TERPISAH: tool memakai acquireSessionWriter untuk
  //    sessionId anak, dan melepas dengan token anak.
  expect(task).toContain("acquireSessionWriter")
  expect(task).toContain("releaseSessionWriter")
  expect(task).toContain("childId")
  // Child Run dimutasi dengan epoch ANAK (readWriterEpoch(childId)), bukan parent.
  expect(task).toContain("readWriterEpoch(childId")

  // 5. Orphan/terminalisasi anak: INTERRUPTED + UNKNOWN, TAK PERNAH COMPLETED.
  const oStart = persist.indexOf("export function tombstoneOrphanChildRuns")
  expect(oStart).toBeGreaterThan(-1)
  const oSrc = persist.slice(oStart, persist.indexOf("export function terminalizeChildRuns"))
  expect(oSrc).toContain("recovery_status = 'UNKNOWN'")
  expect(oSrc).toContain("status = 'INTERRUPTED'")
  expect(oSrc).not.toContain("COMPLETED")
  // Dipanggil composition root: resume (orphan) dan close (parent terminal).
  expect(setup).toContain("tombstoneOrphanChildRuns")
  expect(setup).toContain("terminalizeChildRuns")

  // 6. Id anak 128-bit (bukan 32-bit P1 lawas yang dipromosi diam-diam).
  expect(persist).toContain("export function allocateChildSessionId")
  const aStart = persist.indexOf("export function allocateChildSessionId")
  expect(persist.slice(aStart, aStart + 200)).toContain("replace(/-/g")
  expect(task).not.toContain("randomUUID().slice(0, 8)")

  // 7. Lineage parent Run disuntik composition root (tool tak mengarang id).
  expect(setup).toContain("setSubAgentParentRunId")
  expect(task).toContain("export function setSubAgentParentRunId")

  // 8. Context Assembly TIDAK boleh tahu parent_session_id (batas P2.8 utuh).
  const asm = readFileSync("src/session/context-assembly.ts", "utf8")
  expect(asm.includes("parent_session_id")).toBe(false)
  expect(asm.includes("createChildSession")).toBe(false)

  // 9. Capability attenuation tetap satu-satunya derivasi; nested delegation
  //    tetap dilarang pada tool set anak.
  const cap = readFileSync("src/runtime/capability.ts", "utf8")
  expect(cap).toContain("export function attenuateGrant")
  expect(task).toContain("delegate_task")

  // 10. Delete parent membersihkan anak (cascade eksplisit per-sesi).
  const dStart = persist.indexOf("async function deleteSessionCompletely")
  const dSrc = persist.slice(dStart, dStart + 4000)
  expect(dSrc).toContain("parent_session_id = ?")
  expect(dSrc).toContain("DELETE FROM runs WHERE session_id = ?")
})

test("[ARCHITECTURE-GUARD] P2.9: tak ada vendor改动 & writer child di persistence owner", () => {
  const vendorHits = tracked(/^vendor\/.*\.ts$/).filter((f) => f.includes("minicore"))
  expect(vendorHits.length).toBeGreaterThan(0)
  // Penulis sessions/threads/runs tetap SATU owner (persistence.ts).
  const writers = tracked(/^src\/.*\.ts$/).filter(
    (f) =>
      f !== "src/session/persistence.ts" &&
      /INSERT\s+INTO\s+sessions|UPDATE\s+sessions\s+SET|INSERT\s+INTO\s+runs\b/i.test(
        readFileSync(f, "utf8"),
      ),
  )
  // tools/task.ts memanggil API kanonik, bukan SQL langsung.
  expect(writers).toEqual([])
  const task = readFileSync("src/tools/task.ts", "utf8")
  const code = task
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
  expect(/INSERT\s+INTO|UPDATE\s+sessions\s+SET|DELETE\s+FROM/i.test(code)).toBe(false)
})

test("[ARCHITECTURE-GUARD] P2.8F: artefak konteks tak boleh jadi histori kanonik", () => {
  const asm = readFileSync("src/session/context-assembly.ts", "utf8")
  const setup = readFileSync("cli/setup.ts", "utf8")

  // 1. Jalur persist WAJIB menyaring artefak context-only. Tanpa ini ringkasan
  //    proyeksi bocor ke `messages` lewat session.state.history.
  expect(setup.includes("stripContextOnly(")).toBe(true)
  expect(setup.includes("contextOnlyArtifact")).toBe(true)
  // Penyaringan terjadi pada variabel yang BENAR-BENAR ditulis ke persist
  // (bukan pada buffer mentah).
  expect(setup.includes("saveSession(sessionId, cwd, undefined, durableHistory")).toBe(true)
  expect(setup.includes("shrinkThreadHistory(sessionId, thread.thread_id, durableHistory")).toBe(
    true,
  )
  // TIDAK boleh ada jalur persist yang menulis session.state.history mentah.
  expect(setup.includes("saveSession(sessionId, cwd, undefined, session.state.history")).toBe(false)
  expect(
    setup.includes("shrinkThreadHistory(sessionId, thread.thread_id, session.state.history"),
  ).toBe(false)

  // 2. Rekonstruksi baseline: setelah prefix ditutup proyeksi, buffer bukan lagi
  //    superset histori kanonik — persist WAJIB menyusun baseline ++ ekor.
  expect(setup.includes("contextCanonicalBaseline")).toBe(true)
  expect(setup.includes("[...contextCanonicalBaseline, ...tail]")).toBe(true)
  // 2b. Baseline kanonik TIDAK PERNAH disaring: inilah yang guaranteeing pesan
  //     kanonik byte-identik dgn artefak tetap selamat (FOR-8). Penyaringan
  //     hanya berlaku pada buffer RAM.
  expect(/contextCanonicalBaseline\s*\.\s*filter/.test(setup)).toBe(false)
  expect(setup.includes("stripContextOnly(contextCanonicalBaseline")).toBe(false)

  // 3. Penapisan hanya menyentuh indeks 0 dan exige kecocokan identity penuh
  //    (role+content) — bukan "buang yang pertama" dan bukan pola tekstual.
  expect(asm.includes("messages.slice(1)")).toBe(true)
  expect(asm.includes("if (!artifact) return messages as T[]")).toBe(true)
  expect(asm.includes("first.content !== artifact.content")).toBe(true)

  // 4. Artefak context-only TIDAK pernah lahir di persistence: tidak ada writer
  //    proyeksi/message di assembly, dan persistence tak kenal sama sekali.
  const persist = readFileSync("src/session/persistence.ts", "utf8")
  expect(persist.includes("contextOnly")).toBe(false)
  expect(persist.includes("stripContextOnly")).toBe(false)
  expect(persist.includes("assembleContext")).toBe(false)

  // 4b. INVARIAN KLARIFIKASI: artefak sintetis tak pernah menjadi baris
  //     kanonik tak bertanda; informasi yang diserapnya hanya boleh muncul
  //     lewat jalur kompaksi P2.7 yang sets migrated_compacted=1. Tidak ada
  //     kolom provenance BARU — migrated_compacted milik P2.7, tak didefinisikan
  //     ulang di sini. Kode saja (komentar boleh menyebutnya).
  const codeOnly = (s: string): string =>
    s
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n")
  expect(codeOnly(setup).includes("migrated_compacted")).toBe(false)
  expect(codeOnly(asm).includes("migrated_compacted")).toBe(false)

  // 5. Vendor tetap utuh: tak ada field persistence-only / penanda di Message.
  const types = readFileSync("vendor/minicore/src/core/types.ts", "utf8")
  expect(types.includes("contextOnly")).toBe(false)
  expect(types.includes("event_id")).toBe(false)
  expect(types.includes("run_id")).toBe(false)
})

test("[ARCHITECTURE-GUARD] P2.8: perakitan konteks baca-saja, tanpa Run/budget/vendor-persist", () => {
  const src = readFileSync("src/session/context-assembly.ts", "utf8")
  const code = src
    .split("\n")
    .filter(
      (l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"),
    )
    .join("\n")

  // Guard A — satu jalur pembaca proyeksi (API baca P2.7), tanpa SQL mentah.
  expect(src.includes("getProjectionStatus(")).toBe(true)
  expect(src.includes("getProjection(")).toBe(true)
  expect(/FROM\s+history_projections/i.test(src)).toBe(false)
  expect(/SELECT[\s\S]*FROM\s+messages/i.test(src)).toBe(false)

  // Guard B — nol mutasi persistensi (messages/proyeksi/runs/sessions).
  expect(/INSERT\s+INTO\s+messages\b/i.test(code)).toBe(false)
  expect(/UPDATE\s+messages\b/i.test(code)).toBe(false)
  expect(/DELETE\s+FROM\s+messages\b/i.test(code)).toBe(false)
  expect(/INSERT\s+INTO\s+history_projections\b/i.test(code)).toBe(false)
  expect(/UPDATE\s+history_projections\b/i.test(code)).toBe(false)
  expect(/DELETE\s+FROM\s+history_projections\b/i.test(code)).toBe(false)
  expect(/UPDATE\s+runs\b/i.test(code)).toBe(false)
  expect(/UPDATE\s+sessions\b/i.test(code)).toBe(false)
  // Tak ada writer/build/rebuild/repair proyeksi (rebuild = operasi eksplisit P2.7).
  for (const forbidden of [
    "buildProjection",
    "rebuildProjection",
    "advanceRunCursor",
    "saveSession",
    "shrinkThreadHistory",
  ]) {
    expect(code.includes(forbidden)).toBe(false)
  }

  // Guard C — nol dependensi Run/kursor.
  for (const forbidden of ["runs", "run_id", "last_persisted_seq", "cursor"]) {
    expect(code.includes(forbidden)).toBe(false)
  }

  // Guard D — nol kebijakan budget/pemicu kompaksi.
  for (const forbidden of [
    "shouldCompact",
    "PressureLevel",
    "defaultBudgetPolicy",
    "contextWindowTokens",
    "estimateSessionContext",
    "mechanicalCompaction",
    "compactWithLlm",
    "createLlmCompaction",
  ]) {
    expect(code.includes(forbidden)).toBe(false)
  }

  // Guard E — tak ada persistensi objek vendor; hanya tipe yang diimpor.
  expect(src.includes("JSON.stringify(")).toBe(false)
  expect(src.includes("serialize")).toBe(false)
  // Field persistence-only tak boleh ada di kode (msg sintetis).
  for (const field of ["event_id:", "run_id:", "thread_id:", "base_seq:"]) {
    expect(code.includes(field)).toBe(false)
  }

  // Guard F — hanya CURRENT boleh berparticipasi (satu cabang, tak ada blend).
  expect(code.includes('status.state !== "CURRENT"')).toBe(true)
  // Guard G — fallback hidup (bukan "konteks kosong").
  expect(src.includes('source: "messages"')).toBe(true)
  // Guard H — sistem prompt bebas pembacaan proyeksi.
  const sysPrompt = readFileSync("src/policy/context.ts", "utf8")
  expect(sysPrompt.includes("history_projections")).toBe(false)
  expect(sysPrompt.includes("getProjection")).toBe(false)
})

test("[ARCHITECTURE-GUARD] P2.8: persistence tak pernah mengimpor perakitan konteks", () => {
  // Arah dependensi satu-way: context-assembly → persistence. Never bolak-balik.
  const persist = readFileSync("src/session/persistence.ts", "utf8")
  expect(persist.includes("context-assembly")).toBe(false)
  expect(persist.includes("assembleContext")).toBe(false)
  // Dan persistence tetap bebas vendor/context budget (warisan P2.7).
  expect(persist.includes("#minicore")).toBe(false)
})

test("[ARCHITECTURE-GUARD] P2.7: proyeksi terpusat, berpagar, tak-otoritatif", () => {
  const persist = readFileSync("src/session/persistence.ts", "utf8")
  // 1. Pembaca proyeksi selalu terikat (session_id, thread_id) — tak ada baca
  // lintas-thread. Semua SELECT history_projections memakai kedua kolom.
  const selects = persist.match(/SELECT[^\n;]*FROM\s+history_projections\s+WHERE[^\n;]+/gi) ?? []
  expect(selects.length).toBeGreaterThan(0)
  for (const s of selects) {
    expect(s).toMatch(/session_id\s*=\s*\?/i)
    expect(s).toMatch(/thread_id\s*=\s*\?/i)
  }
  // 2. Validitas tak memakai run_id / last_persisted_seq sebagai kepemilikan:
  // potong seksi getProjectionStatus, pastikan nihil.
  const start = persist.indexOf("export function getProjectionStatus")
  const end = persist.indexOf("Inti build DALAM txn pemanggil")
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const validitySrc = persist.slice(start, end)
  expect(validitySrc.includes("run_id")).toBe(false)
  expect(validitySrc.includes("last_persisted_seq")).toBe(false)
  // 3. Builder tak menulis messages (read-only atas sumber).
  const bStart = persist.indexOf("function buildProjectionInTxn")
  const bEnd = persist.indexOf("Jalur build kanonik")
  expect(bStart).toBeGreaterThan(-1)
  expect(bEnd).toBeGreaterThan(bStart)
  const builderSrc = persist.slice(bStart, bEnd)
  expect(/INSERT\s+INTO\s+messages\b/i.test(builderSrc)).toBe(false)
  expect(/UPDATE\s+messages\b/i.test(builderSrc)).toBe(false)
  expect(/DELETE\s+FROM\s+messages\b/i.test(builderSrc)).toBe(false)
  // 4. Tak ada lease proyeksi/thread/run; tak ada impor vendor/konteks/agen
  // baru di persistence.ts (dif uses existing seams only).
  expect(persist.includes("projection lease")).toBe(false)
  expect(persist.includes("ProjectionLease")).toBe(false)
  expect(persist.includes("#minicore")).toBe(false)
  expect(persist.includes("CompactionStrategy")).toBe(false)
  expect(persist.includes("compactWithLlm")).toBe(false)
  expect(persist.includes("mechanicalCompaction")).toBe(false)
  // 5. Tak ada penyimpanan old_head/new_head (kontrak: transien saja).
  const codeOnly = persist
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n")
  expect(codeOnly.includes("old_head")).toBe(false)
  expect(codeOnly.includes("new_head")).toBe(false)
  expect(codeOnly.includes("deleted-prefix")).toBe(false)
})

test("[ARCHITECTURE-GUARD] P2.9-FIX: satu domain otoritatif untuk satu siklus anak", () => {
  // Mixed DB path pernah nyata: createChildSession menulis DB global, lalu
  // acquireSessionWriter membuat <cwd>/.minicode sehingga transitionRun membaca
  // DB lokal → "run not found". Guard ini mengunci urutan pin → anak → lease →
  // transisi Run supaya tak pernah bisa terulang.
  const task = readFileSync("src/tools/task.ts", "utf8")
  const taskCode = task
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n")

  // 1. Domain dipin SEBELUM baris anak pertama; urutan siklus kanonik utuh.
  const pinAt = taskCode.indexOf('resolveLocalDbPath("sessions.db"')
  const createAt = taskCode.indexOf("createChildSession({")
  const acquireAt = taskCode.indexOf("acquireSessionWriter({")
  const transitionAt = taskCode.indexOf('transitionRun(childRunId, "RUNNING"')
  expect(pinAt).toBeGreaterThan(-1)
  expect(createAt).toBeGreaterThan(pinAt)
  expect(acquireAt).toBeGreaterThan(createAt)
  expect(transitionAt).toBeGreaterThan(acquireAt)

  // 2. Pin gagal → tolak SEBELUM satu baris pun ditulis (tak jatuh ke global).
  expect(taskCode).toContain("REFUSED_CHILD_SESSION_PERSISTENCE")
  expect(/if \(!existsSync\(dirname\(pinnedDb\)\)\)/.test(taskCode)).toBe(true)

  // 3. TANPA degradasi: tak ada gerbang parentDurable / jalur jurnal-hantu,
  //    dan createChildSession dipanggil TEPAT SATU kali (tanpa cabang).
  expect(taskCode.includes("parentDurable")).toBe(false)
  expect(taskCode.includes("childSessionCreated")).toBe(false)
  expect(taskCode.split("createChildSession({").length - 1).toBe(1)

  // 4. Seluruh blok siklus anak memakai parentCwd — process.cwd() tak boleh
  //    muncul di dalamnya (bisa memilih domain yang berbeda).
  // P2.10 memakai canonical EffectIntent; urutan domain yang dijaga sama.
  const appendAt = taskCode.indexOf("persistEffectIntent({")
  expect(appendAt).toBeGreaterThan(createAt)
  const block = taskCode.slice(pinAt, appendAt)
  expect(block.includes("process.cwd()")).toBe(false)
  expect(block.split("cwd: parentCwd").length - 1).toBeGreaterThanOrEqual(2)
  // Epoch anak dibaca dari domain yang SAMA (bukan milik parent).
  expect(block).toContain("readWriterEpoch(childId, parentCwd)")
  expect(block).toContain("releaseSessionWriter(childId, childEpoch, parentCwd)")

  // 5. Baris sesi anak sudah ada sebelum factory memasang presentation
  //    adapter (kalau tidak, namespace presentasi bisa tanpa baris sessions).
  const factoryAt = taskCode.indexOf("factory({")
  expect(factoryAt).toBeGreaterThan(createAt)

  // 6. Semua panggilan persistence siklus anak memakai cwd eksplisit yang
  //    sama; tak ada panggilan tanpa cwd (yang akan memakai process.cwd()).
  for (const call of [
    "createChildSession({",
    "acquireSessionWriter({",
    "readWriterEpoch(childId",
  ]) {
    const i = taskCode.indexOf(call)
    expect(i).toBeGreaterThan(-1)
    const stmt = taskCode.slice(i, i + 400)
    expect(stmt).toContain("parentCwd")
  }
})

function readProd(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8")
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const text = line.trim()
      return !text.startsWith("//") && !text.startsWith("*")
    })
    .join("\n")
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function matchesForbidden(code: string, forbidden: RegExp | string): boolean {
  return typeof forbidden === "string" ? code.includes(forbidden) : forbidden.test(code)
}

test("[ARCHITECTURE-GUARD] P2.10: awaited intent precedes execute, receipt follows return", () => {
  const verification = codeOnly(readProd("src/session/verification.ts"))
  const toolLayer = codeOnly(readProd("src/app/tool-layer.ts"))
  const writeIntentAt = verification.indexOf("await writer.writeIntent({")
  const innerExecuteAt = verification.indexOf("await tool.execute(input, ctx)")
  const writeReceiptAt = verification.indexOf("await writer.writeReceipt({")
  expect(writeIntentAt).toBeGreaterThan(-1)
  expect(innerExecuteAt).toBeGreaterThan(writeIntentAt)
  expect(writeReceiptAt).toBeGreaterThan(innerExecuteAt)
  expect(toolLayer).toContain("withEvidence(tool, verification)")
})

test("[ARCHITECTURE-GUARD] P2.10: one invocation writes one canonical intent", () => {
  const verification = codeOnly(readProd("src/session/verification.ts"))
  expect(countOccurrences(verification, "await writer.writeIntent({")).toBe(1)
  expect(countOccurrences(verification, "await tool.execute(input, ctx)")).toBe(1)
  expect(codeOnly(readProd("src/tools/evidence.ts"))).toContain(
    "isCanonicalEvidenceCovered(tool.name)",
  )
  const mcp = codeOnly(readProd("src/mcp/server.ts"))
  expect(countOccurrences(mcp, "persistEffectIntent({")).toBe(1)
  expect(countOccurrences(mcp, "persistEffectReceipt({")).toBe(2)
  const task = codeOnly(readProd("src/tools/task.ts"))
  expect(countOccurrences(task, "persistEffectIntent({")).toBe(1)
  expect(countOccurrences(task, "persistEffectReceipt({")).toBe(1)
})

test("[ARCHITECTURE-GUARD] P2.10: terminal cannot exist without durable intent", () => {
  const verification = codeOnly(readProd("src/session/verification.ts"))
  expect(verification).toContain("verification: refusing execution without durable EffectIntent")
  expect(verification).toContain("verification: refusing terminal without durable intent")
})

test("[ARCHITECTURE-GUARD] P2.10: verification records do not enter conversation history", () => {
  const files = [
    "src/session/verification.ts",
    "src/session/journal.ts",
    "src/tools/evidence.ts",
    "src/app/tool-layer.ts",
  ]
  for (const file of files) {
    const code = codeOnly(readProd(file))
    for (const forbidden of [
      /INSERT\s+INTO\s+messages\b/i,
      /UPDATE\s+messages\b/i,
      /DELETE\s+FROM\s+messages\b/i,
      /saveSession\s*\(/,
      /appendHistoryEvent\s*\(/,
    ]) {
      expect(forbidden.test(code)).toBe(false)
    }
  }
})

test("[ARCHITECTURE-GUARD] P2.10: verification records do not enter projections", () => {
  const files = [
    "src/session/verification.ts",
    "src/session/journal.ts",
    "src/tools/evidence.ts",
    "src/app/tool-layer.ts",
  ]
  for (const file of files) {
    const code = codeOnly(readProd(file))
    expect(code.includes("history_projections")).toBe(false)
    expect(code.includes("ContextView")).toBe(false)
  }
})

test("[ARCHITECTURE-GUARD] P2.10: verification does not read Run status as effect proof", () => {
  const files = ["src/session/verification.ts", "src/tools/evidence.ts"]
  for (const file of files) {
    const code = codeOnly(readProd(file))
    for (const forbidden of [
      "getRun(",
      "transitionRun(",
      "RUN_EDGES",
      "run_id",
      "RunStatus",
      "Run.status",
      "runs.status",
    ]) {
      expect(code.includes(forbidden)).toBe(false)
    }
  }
})

test("[ARCHITECTURE-GUARD] P2.10: verification does not read presentation as effect authority", () => {
  const files = ["src/session/verification.ts", "src/tools/evidence.ts"]
  for (const file of files) {
    const code = codeOnly(readProd(file))
    for (const forbidden of [
      "presentation_events",
      "appendPresentationEvents",
      "toPresentationEvent",
      "createPresentationAdapter",
    ]) {
      expect(code.includes(forbidden)).toBe(false)
    }
  }
})

test("[ARCHITECTURE-GUARD] P2.10: verification does not read cursor as execution proof", () => {
  const files = ["src/session/verification.ts", "src/tools/evidence.ts"]
  for (const file of files) {
    const code = codeOnly(readProd(file))
    for (const forbidden of ["last_persisted_seq", "advanceRunCursor", "RunCursor"]) {
      expect(code.includes(forbidden)).toBe(false)
    }
  }
})

test("[ARCHITECTURE-GUARD] P2.10: child effect verification references lineage and journals", () => {
  const code = codeOnly(readProd("src/session/verification.ts"))
  expect(code).toContain("correlateChildEffect")
  expect(code).toContain("childSessionId")
  expect(code).toContain("childInvocationId")
  expect(code).toContain("parentSessionId")
  expect(code.includes("finalText")).toBe(false)
})

test("[ARCHITECTURE-GUARD] P2.10: vendor remains untouched", () => {
  const status = spawnSync("git", ["status", "--short", "vendor/"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  })
  expect(status.status).toBe(0)
  expect(status.stdout.trim()).toBe("")
})

test("[ARCHITECTURE-GUARD] P2.10: no presentation-phase code is introduced", () => {
  const files = [
    "src/session/verification.ts",
    "src/session/journal.ts",
    "src/tools/evidence.ts",
    "src/app/tool-layer.ts",
  ]
  for (const file of files) {
    expect(codeOnly(readProd(file)).includes("P2.11")).toBe(false)
  }
  const added = ["src/session/verification.ts", "src/tools/evidence.ts", "src/app/tool-layer.ts"]
  for (const file of added) {
    const code = codeOnly(readProd(file))
    for (const forbidden of ["TUI", "ACP", "Desktop"]) {
      expect(code.includes(forbidden)).toBe(false)
    }
  }
})

test("[ARCHITECTURE-GUARD] P2.10: no new completion vocabulary", () => {
  const added = [
    codeOnly(readProd("src/session/verification.ts")),
    codeOnly(readProd("src/tools/evidence.ts")),
    codeOnly(readProd("src/app/tool-layer.ts")),
  ].join("\n")
  expect(added.includes("EffectVerification")).toBe(false)
  expect(added.includes('"verified"')).toBe(false)
  expect(/verified\s*=\s*true/.test(added)).toBe(false)
  expect(/verified:/.test(added)).toBe(false)
  // `unverified-external` is receipt metadata, not a completion claim.
  const withoutUnverified = added.replaceAll('"unverified-external"', "")
  expect(/\bverified\b/.test(withoutUnverified)).toBe(false)
  const journal = codeOnly(readProd("src/session/journal.ts"))
  expect(journal.includes("EffectVerification")).toBe(false)
  expect(journal.includes('"verified"')).toBe(false)
  expect(/verified\s*=\s*true/.test(journal)).toBe(false)
})

test("[ARCHITECTURE-GUARD] P2.10: UNKNOWN cannot be promoted without explicit verification", () => {
  const code = codeOnly(readProd("src/session/verification.ts"))
  expect(code).toContain('childVerification === "present"')
  expect(code).toContain('childVerification === "absent"')
  expect(code).toContain("conclusion =")
  expect(code).toContain('"unknown"')
  expect(code).not.toContain('state: "completed"')
})

test("[ARCHITECTURE-GUARD] P2.10: idempotency bypasses remain explicit", () => {
  const journal = codeOnly(readProd("src/session/journal.ts"))
  expect(journal).toContain("isCanonicalEvidenceCovered")
  expect(codeOnly(readProd("src/tools/evidence.ts"))).toContain(
    "isCanonicalEvidenceCovered(tool.name)",
  )
  expect(codeOnly(readProd("src/app/tool-layer.ts"))).toContain("withEvidence(tool, verification)")
  const attach = codeOnly(readProd("src/session/journal.ts"))
  expect(attach).toContain('evidenceMode?: "events" | "canonical"')
  expect(attach).toContain('opts.evidenceMode === "canonical"')
})

function presentationFiles(): string[] {
  return [
    "src/presentation/events.ts",
    "src/presentation/model.ts",
    "src/presentation/reducer.ts",
    "src/presentation/adapter.ts",
    "src/presentation/projection.ts",
    "src/presentation/store.ts",
    "src/presentation/label.ts",
  ]
}

function uiFiles(): string[] {
  const r = spawnSync("git", ["ls-files", "src/ui/**/*.ts", "src/ui/*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  })
  if (r.status !== 0) return []
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".ts"))
}

function machineProjectors(): string[] {
  return ["cli/commands/acp.ts", "cli/commands/exec.ts"]
}

test("[ARCHITECTURE-GUARD] P2.11: presentation cannot write messages", () => {
  // Lapisan presentasi hanya mengamati: tak ada INSERT/UPDATE/DELETE messages,
  // tak ada saveSession/appendHistoryEvent/shrinkThreadHistory di file-file ini.
  const files = [...presentationFiles(), ...uiFiles()]
  for (const file of files) {
    const code = codeOnly(readProd(file))
    for (const forbidden of [
      /INSERT\s+INTO\s+messages\b/i,
      /UPDATE\s+messages\b/i,
      /DELETE\s+FROM\s+messages\b/i,
      /saveSession\s*\(/,
      /appendHistoryEvent\s*\(/,
      /shrinkThreadHistory\s*\(/,
    ]) {
      expect(forbidden.test(code), file).toBe(false)
    }
  }
})

test("[ARCHITECTURE-GUARD] P2.11: presentation cannot own run lifecycle", () => {
  const files = [...presentationFiles(), ...uiFiles()]
  for (const file of files) {
    const code = codeOnly(readProd(file))
    for (const forbidden of [
      "createRun(",
      "transitionRun(",
      "completeRun(",
      "failRun(",
      "interruptRun(",
      "tombstoneDeadRuns(",
      "advanceRunCursor",
      "RUN_EDGES",
    ]) {
      expect(code.includes(forbidden), `${file} ~~ ${forbidden}`).toBe(false)
    }
  }
})

test("[ARCHITECTURE-GUARD] P2.11: presentation cannot mutate VerificationRecord", () => {
  // Display membaca verdict; penulisannya tetap milik jurnal/verifikasi.
  const files = [...presentationFiles(), ...uiFiles(), ...machineProjectors()]
  for (const file of files) {
    const code = codeOnly(readProd(file))
    for (const forbidden of [
      "appendVerificationRecord(",
      "recordExternalVerification(",
      "recordVerifierOutcome(",
      "verifyFilesystemEffect(",
      "verifyGitCommit(",
      "resolvePending(",
    ]) {
      expect(code.includes(forbidden), `${file} ~~ ${forbidden}`).toBe(false)
    }
  }
})

test("[ARCHITECTURE-GUARD] P2.11: presentation cannot become effect authority", () => {
  // Tak ada klaim penyelesaian efek dari status tampil / receipt / verdict.
  // Satu-satunya gerbang positif yang diizinkan adalah marker [verified]
  // yang mensyaratkan verdict present eksplisit (dijaga test display).
  for (const file of [...presentationFiles(), ...uiFiles(), ...machineProjectors()]) {
    const code = codeOnly(readProd(file))
    expect(code.includes("EffectVerification"), file).toBe(false)
  }
  const journal = codeOnly(readProd("src/session/journal.ts"))
  expect(journal.includes("EffectVerification")).toBe(false)
})

test("[ARCHITECTURE-GUARD] P2.11: UI state cannot become canonical session state", () => {
  // src/ui/ tak boleh mengimpor modul persistensi/evidence sesi — selain
  // melanggar ui-boundary, itu satu-satunya jalan UI state menjadi durable.
  for (const file of uiFiles()) {
    const code = codeOnly(readProd(file))
    for (const forbidden of [
      "session/persistence",
      "session/journal",
      "session/verification",
      "session/checkpoint",
      "bun:sqlite",
    ]) {
      expect(code.includes(forbidden), `${file} ~~ ${forbidden}`).toBe(false)
    }
  }
})

test("[ARCHITECTURE-GUARD] P2.11: history_projections cannot become UI state", () => {
  const files = [...presentationFiles(), ...uiFiles(), ...machineProjectors()]
  for (const file of files) {
    const code = codeOnly(readProd(file))
    for (const forbidden of ["history_projections", "getProjection(", "buildProjection("]) {
      expect(code.includes(forbidden), `${file} ~~ ${forbidden}`).toBe(false)
    }
  }
})

test("[ARCHITECTURE-GUARD] P2.11: ContextView cannot be persisted", () => {
  const files = [...presentationFiles(), ...uiFiles(), ...machineProjectors()]
  for (const file of files) {
    const code = codeOnly(readProd(file))
    expect(code.includes("ContextView"), file).toBe(false)
  }
})

test("[ARCHITECTURE-GUARD] P2.11: verification.observed is minted only by the adapter", () => {
  // Produsen display-verifikasi tunggal = noteVerificationObserved; tak ada
  // fabrikasi event di consumer, projector, atau renderer.
  const adapter = codeOnly(readProd("src/presentation/adapter.ts"))
  expect(adapter).toContain("noteVerificationObserved")
  expect(adapter).toContain('type: "verification.observed"')
  for (const file of [
    ...uiFiles(),
    ...machineProjectors(),
    "src/presentation/reducer.ts",
    "src/presentation/projection.ts",
    "src/presentation/model.ts",
    "cli/setup.ts",
  ]) {
    const code = codeOnly(readProd(file))
    expect(code.includes('type: "verification.observed"'), file).toBe(false)
  }
  // Wiring komposisi: setup membaca jurnal fire-and-forget lalu memanggil
  // note adapter — tak pernah await di jalur turn, tak pernah melempar.
  const setup = codeOnly(readProd("cli/setup.ts"))
  expect(setup).toContain("noteVerificationObserved")
  expect(setup).toContain("pendingVerificationObservation")
  expect(setup).toContain("replayedUpToSeq")
  expect(setup).toContain("verificationEmitted")
})

test("[ARCHITECTURE-GUARD] P2.11: child presentation cannot leak child context", () => {
  // Narasi anak (finalText) tak boleh menjadi bukti efek / tampil sebagai
  // verifikasi di permukaan display mana pun. Satu-satunya pemakaian sah
  // adalah jalur turn:completed → model.completed (teks percakapan model,
  // bukan bukti efek anak) — di sini dibatasi ke blok adapter itu.
  for (const file of [
    "src/presentation/projection.ts",
    "src/presentation/reducer.ts",
    "src/ui/tui/transcript.ts",
    "src/ui/assistant/simple.ts",
    "cli/commands/acp.ts",
    "cli/commands/exec.ts",
    "cli/setup.ts",
  ]) {
    expect(codeOnly(readProd(file)).includes("finalText"), file).toBe(false)
  }
  // Penautan anak eksplisit tetap ada (bukan tebakan): parentLink di jalur display.
  const acp = codeOnly(readProd("cli/commands/acp.ts"))
  expect(acp).toContain("parentToolCallId")
  // Blok verifikasi adaptor + reducer tak menyentuh narasi anak.
  const adapter = codeOnly(readProd("src/presentation/adapter.ts"))
  const noteStart = adapter.indexOf("const noteVerificationObserved")
  expect(noteStart).toBeGreaterThan(-1)
  const noteEnd = adapter.indexOf("const noteCheckpoint", noteStart)
  expect(noteEnd).toBeGreaterThan(noteStart)
  expect(adapter.slice(noteStart, noteEnd).includes("finalText")).toBe(false)
  const reducer = codeOnly(readProd("src/presentation/reducer.ts"))
  const caseStart = reducer.indexOf('case "verification.observed"')
  expect(caseStart).toBeGreaterThan(-1)
  const caseEnd = reducer.indexOf("case \"approval.requested\"", caseStart)
  expect(caseEnd).toBeGreaterThan(caseStart)
  expect(reducer.slice(caseStart, caseEnd).includes("finalText")).toBe(false)
})

test("[ARCHITECTURE-GUARD] P2.11: UNKNOWN cannot render as success", () => {
  // Marker sukses display mensyaratkan verdict present eksplisit; tak ada
  // pemetaan verdict lain (atau absennya verdict) ke status sukses.
  for (const file of ["src/ui/tui/transcript.ts", "src/ui/assistant/simple.ts"]) {
    const code = codeOnly(readProd(file))
    expect(code.includes('verdict === "present"'), file).toBe(true)
  }
  const projection = codeOnly(readProd("src/presentation/projection.ts"))
  expect(projection).toContain('verdict === "present"')
  expect(projection).toContain("unverified:")
})

test("[ARCHITECTURE-GUARD] P2.11: identity collision cannot be silently deduped", () => {
  const persist = codeOnly(readProd("src/session/persistence.ts"))
  expect(persist).toContain("canonicalizePresentationPayload")
  expect(persist).toContain("stats.collisions++")
  expect(persist).toContain("stats.duplicates++")
  expect(persist).toContain("INSERT OR IGNORE INTO presentation_events")
  expect(persist.includes("UPDATE presentation_events")).toBe(false)
})

test("[ARCHITECTURE-GUARD] P2.11: reconstructed terminal cannot appear observed", () => {
  // Provenans ditulis eksplisit hanya untuk non-live; jalur live (bridge)
  // tidak pernah menyetelnya. Ketiadaan = live-atau-tak-ditentukan.
  const projection = codeOnly(readProd("src/presentation/projection.ts"))
  expect(projection).toContain("projectProvenance")
  expect(projection).toContain('"reconstructed"')
  const setup = codeOnly(readProd("cli/setup.ts"))
  const bridgeStart = setup.indexOf("export function toPresentationEvent")
  expect(bridgeStart).toBeGreaterThan(-1)
  const rest = setup.slice(bridgeStart)
  const nextExport = rest.slice(30).search(/\nexport (function|const|async function|interface|type) /)
  const bridge = nextExport === -1 ? rest : rest.slice(0, 30 + nextExport)
  expect(bridge.includes("provenance")).toBe(false)
  for (const file of ["src/ui/tui/transcript.ts", "src/ui/assistant/simple.ts"]) {
    const code = codeOnly(readProd(file))
    expect(code.includes("[reconstructed]") || code.includes('provenance === "reconstructed"'), file).toBe(true)
    expect(code.includes("[replay]") || code.includes('provenance === "replay"'), file).toBe(true)
  }
})

test("[ARCHITECTURE-GUARD] P2.11: no second canonical presentation persistence", () => {
  // Satu-satunya writer durable observasi = appendPresentationEvents.
  // Tak ada CREATE TABLE / INSERT / bun:sqlite di permukaan display/machine.
  for (const file of [
    ...presentationFiles(),
    ...uiFiles(),
    ...machineProjectors(),
  ]) {
    const code = codeOnly(readProd(file))
    for (const forbidden of [
      /CREATE\s+TABLE/i,
      /INSERT\s+INTO/i,
      "bun:sqlite",
      /new\s+Database\s*\(/,
    ]) {
      expect(matchesForbidden(code, forbidden), `${file}`).toBe(false)
    }
  }
  const persist = codeOnly(readProd("src/session/persistence.ts"))
  expect(persist).toContain("appendPresentationEvents")
})

test("[ARCHITECTURE-GUARD] P2.11: vendor remains untouched", () => {
  const status = spawnSync("git", ["status", "--short", "vendor/"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  })
  expect(status.status).toBe(0)
  expect(status.stdout.trim()).toBe("")
})

test("[ARCHITECTURE-GUARD] P2.11: no P2.12 work enters P2.11", () => {
  // Desktop / long-running / reconnect-replay tidak diimplementasikan di sini.
  for (const file of [
    ...presentationFiles(),
    "src/ui/contract.ts",
    "src/ui/tui/transcript.ts",
    "src/ui/assistant/simple.ts",
    ...machineProjectors(),
    "cli/setup.ts",
  ]) {
    const code = codeOnly(readProd(file))
    for (const forbidden of ["Desktop", "desktop", "P2.12", "long-running", "websocket"]) {
      expect(code.includes(forbidden), `${file} ~~ ${forbidden}`).toBe(false)
    }
  }
})
