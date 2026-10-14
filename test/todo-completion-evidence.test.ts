// P10.1.1 — Freshness-bound completion evidence.
//
// Kontrak: PASS lama tak boleh mengotorisasi completion setelah mutasi baru.
// `stale` menolak klaim lewat gate yang SUDAH ADA (seperti `failed`, dengan
// label + alasan dipertahankan); TaskStore COMPLETED hanya lewat jalur
// kanonik yang sama. Tanpa runner baru, tanpa writer baru, tanpa retry.
//
// Konvensi: DB + jurnal + TaskStore asli di tmpdir; evidence disuntik via
// seam DI `setCompletionEvidence` (pola P9); turn dibuat deterministik via
// `appendMutationIntent` (tanpa menjalankan runtime).
//
// ── Sweep jurnal vs kesegaran (F2) ──────────────────────────────────────────
// Implementasi saat ini: bukti verify direkam SETELAH turn model terkait
// (baseline pra-turn; pasca-turn memakai `session.state.turnCount` yang sama
// dengan cap `turn` intent mutasi). `finalizeJournal` dipanggil pasca-persist
// tiap turn (cli/setup.ts) dan sweep menghapus pasangan pending/committed
// ≤ finalized head — artinya record mutasi dari turn yang SUDAH tercakup
// bukti (atau lebih lama) boleh hilang dari jurnal. Desain kesegaran bertumpu
// pada urutan turn, bukan pada keberlangsungan record lama:
//  - perbandingan ketat `turn > evidenceTurn` membuat mutasi se-turn bukti
//    tercakup verify itu sendiri, jadi tak perlu bertahan di jurnal;
//  - mutasi yang lebih BARU dari bukti tercatat pada turn klaim itu sendiri
//    dan finalize hanya terjadi di batas turn (pasca-persist), klaim terjadi
//    di tengah turn — sehingga record itu SELALU masih ada saat klaim
//    dinilai dan tetap membatalkan bukti lama;
//  - record mutasi turn-null (legacy) dikecualikan agar sesi lama tidak
//    terkunci permanen (pengecualian kompatibilitas yang disetujui).
// Ini deskripsi implementasi, bukan klaim sifat abstrak; jembatan turn
// lintas-proses dibuktikan end-to-end oleh PF-07b di test/cli-session.test.ts.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendMutationIntent, journalPath } from "../src/session/journal.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import {
  applyCompletionPolicy,
  clearCompletionEvidence,
  loadTodos,
  normalizeTodos,
  reconcileCompletionEvidence,
  resolveFreshEvidence,
  saveTodos,
  setCompletionEvidence,
  todoWriteTool,
} from "../src/tools/todo.ts"

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p1011-"))
  mkdirSync(join(d, ".minicode"), { recursive: true })
  dirs.push(d)
  return d
}

afterEach(async () => {
  clearCompletionEvidence()
  resetTaskStoreHandles()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

const ctxFor = (sessionId: string, cwd: string) =>
  ({
    signal: new AbortController().signal,
    sessionId,
    cwd,
  }) as never

/** Intent mutasi deterministik dengan turn eksplisit (tanpa runtime). */
async function addMutation(
  sessionId: string,
  dir: string,
  tool: string,
  turn?: number,
): Promise<void> {
  await appendMutationIntent({
    session: sessionId,
    tool,
    cwd: dir,
    ...(turn === undefined ? {} : { turn }),
  })
}

/** Seed baris kanonik t1 PENDING via API publik store (pola taskstore.test.ts).
 * todo_write id-less TAK PERNAH membuat baris kanonik (jalur legacy) —
 * memakainya sebagai setup adalah fixture salah. Yang diuji di sini gate
 * klaim + sinkronisasi kanonik, bukan asal baris; baris PENDING awal adalah
 * prasyarat netral, ditegaskan di bawah. */
function seedT1(sessionId: string, dir: string): void {
  const store = new TaskStore(dir)
  const made = store.createTask(sessionId, {
    title: "ship X",
    status: "PENDING",
    order: 0,
    provenance: { origin: "runtime", source: "test" },
  })
  if (made.id !== "t1" || store.getTask(sessionId, "t1")?.status !== "PENDING") {
    throw new Error("fixture t1 PENDING gagal disiapkan")
  }
}

function storeStatus(sessionId: string, dir: string): string | null {
  return new TaskStore(dir).getTask(sessionId, "t1")?.status ?? null
}

// ── A. Stale PASS tak bisa complete (regresi primer) ─────────────────────────
test("A stale PASS + mutasi lebih baru → ditolak; TaskStore bukan COMPLETED", async () => {
  const dir = tmpRoot()
  const sid = "p1011-a"
  await seedT1(sid, dir)
  // Bukti hijau turn 5, lalu mutasi kode turn 6.
  setCompletionEvidence(() => ({ verdict: "passed", detail: "bun test", turn: 5 }))
  await addMutation(sid, dir, "write_file", 6)
  const out = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor(sid, dir),
  )) as string
  // Penolakan menyebut basi (BUKAN gagal uji), file ter-block.
  expect(out).toContain("refused 1 completion claim")
  expect(out).toContain("stale")
  expect(out).not.toContain("verification is failing")
  const items = await loadTodos(sid, dir)
  expect(items).toHaveLength(1)
  expect(items[0]!.status).toBe("blocked")
  expect(items[0]!.blockedReason ?? "").toContain("stale")
  // Jalur kanonik berjalan dengan status terdemote: store BLOCKED, BUKAN COMPLETED.
  expect(storeStatus(sid, dir)).toBe("BLOCKED")
  expect(storeStatus(sid, dir)).not.toBe("COMPLETED")
})

// ── A2. Turn nol numerik (M-1) ─────────────────────────────────────────────
// `turn: 0` adalah angka valid, bukan absen: cek `typeof === "number"`
// (bukan truthiness) harus mengklasifikasikan mutasi turn 1 sebagai stale.
// Menguji jalur resolusi freshness aktual, bukan logika duplikat di test.
test("A2 turn 0 + mutasi turn 1 → stale; TaskStore bukan COMPLETED", async () => {
  const dir = tmpRoot()
  const sid = "p1011-a2"
  await seedT1(sid, dir)
  setCompletionEvidence(() => ({ verdict: "passed", detail: "bun test", turn: 0 }))
  await addMutation(sid, dir, "write_file", 1)
  const out = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor(sid, dir),
  )) as string
  expect(out).toContain("refused 1 completion claim")
  expect(out).toContain("stale")
  expect((await loadTodos(sid, dir))[0]!.status).toBe("blocked")
  expect(storeStatus(sid, dir)).toBe("BLOCKED")
  expect(storeStatus(sid, dir)).not.toBe("COMPLETED")
})

// ── A3. Passed tanpa turn (M-1) ────────────────────────────────────────────
// Bukti lama tanpa ikatan turn → `unverified` (kontrak kompatibilitas
// legacy), BUKAN passed: tak ada ikatan, tak ada klaim kesegaran. Klaim
// completion berjalan seperti perilaku unverified yang sudah ada
// (diizinkan-tanpa-klaim), dan tak ada query jurnal yang terjadi.
test("A3 passed tanpa turn → unverified; completion tak diklaim", async () => {
  const dir = tmpRoot()
  const sid = "p1011-a3"
  await seedT1(sid, dir)
  // Jurnal korup disengaja: resolver turn-less yang benar tak pernah
  // menyentuh jurnal (short-circuit sebelum query) → tetap unverified,
  // bukan failed.
  writeFileSync(journalPath(sid, dir), "not-json{{{", "utf8")
  setCompletionEvidence(() => ({ verdict: "passed", detail: "bun test" }))
  const resolved = await resolveFreshEvidence(sid, dir)
  expect(resolved.verdict).toBe("unverified")
  const out = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor(sid, dir),
  )) as string
  expect(out).not.toContain("refused")
  expect(out).not.toContain("stale")
  expect((await loadTodos(sid, dir))[0]!.status).toBe("completed")
  expect(storeStatus(sid, dir)).toBe("COMPLETED")
})

// ── B. Fresh PASS tetap mengizinkan ──────────────────────────────────────────
test("B PASS segar (mutasi ≤ turn bukti) → completion lewat jalur kanonik", async () => {
  const dir = tmpRoot()
  const sid = "p1011-b"
  await seedT1(sid, dir)
  setCompletionEvidence(() => ({ verdict: "passed", detail: "bun test", turn: 5 }))
  await addMutation(sid, dir, "write_file", 4)
  await addMutation(sid, dir, "edit", 5)
  const out = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor(sid, dir),
  )) as string
  expect(out).not.toContain("refused")
  expect((await loadTodos(sid, dir))[0]!.status).toBe("completed")
  expect(storeStatus(sid, dir)).toBe("COMPLETED")
})

// ── C. Failed tetap memblokir ────────────────────────────────────────────────
test("C verdict failed → tetap ditolak dengan pesan gagal (bukan basi)", async () => {
  const dir = tmpRoot()
  const sid = "p1011-c"
  await seedT1(sid, dir)
  setCompletionEvidence(() => ({ verdict: "failed", detail: "3 failing" }))
  const out = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor(sid, dir),
  )) as string
  expect(out).toContain("refused 1 completion claim")
  expect(out).toContain("verification is failing")
  expect(out).not.toContain("stale")
  expect((await loadTodos(sid, dir))[0]!.status).toBe("blocked")
  expect(storeStatus(sid, dir)).not.toBe("COMPLETED")
})

// ── D. Default unverified tak berubah ────────────────────────────────────────
test("D tanpa bukti → diizinkan-tanpa-klaim seperti dulu", async () => {
  const dir = tmpRoot()
  const sid = "p1011-d"
  await seedT1(sid, dir)
  // Tanpa injeksi: default UNVERIFIED (clear di afterEach memastikan).
  const out = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor(sid, dir),
  )) as string
  expect(out).not.toContain("refused")
  expect((await loadTodos(sid, dir))[0]!.status).toBe("completed")
  expect(storeStatus(sid, dir)).toBe("COMPLETED")
})

// ── E. Mutasi se-turn bukti → segar (operator > ketat) ───────────────────────
test("E mutasi turn == turn bukti → TIDAK basi (verify mencakup turnnya)", async () => {
  const dir = tmpRoot()
  const sid = "p1011-e"
  await seedT1(sid, dir)
  // Bukti turn 5 mencakup mutasi turn 5 (verify jalan SETELAH turn selesai).
  setCompletionEvidence(() => ({ verdict: "passed", detail: "bun test", turn: 5 }))
  await addMutation(sid, dir, "write_file", 5)
  const out = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor(sid, dir),
  )) as string
  expect(out).not.toContain("refused")
  expect(out).not.toContain("stale")
  expect(storeStatus(sid, dir)).toBe("COMPLETED")
})

// ── F. Read-only + unknown-fail-closed ───────────────────────────────────────
test("F turn baca-saja tak membatalkan; tool tak-dikenal fail-closed", async () => {
  const dir = tmpRoot()
  const sid = "p1011-f"
  await seedT1(sid, dir)
  setCompletionEvidence(() => ({ verdict: "passed", detail: "bun test", turn: 5 }))
  await addMutation(sid, dir, "read_file", 6)
  await addMutation(sid, dir, "grep", 7)
  await addMutation(sid, dir, "todo_read", 8)
  const out = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor(sid, dir),
  )) as string
  expect(out).not.toContain("refused")
  expect(storeStatus(sid, dir)).toBe("COMPLETED")
  // Tool masa-depan yang lupa diklasifikasikan = mutasi (F-14) → basi.
  const sid2 = "p1011-f2"
  await seedT1(sid2, dir)
  await addMutation(sid2, dir, "future_tool_xyz", 6)
  const out2 = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor(sid2, dir),
  )) as string
  expect(out2).toContain("stale")
  expect(storeStatus(sid2, dir)).not.toBe("COMPLETED")
})

// ── G. Legacy null-turn ─────────────────────────────────────────────────────
test("G mutasi turn-null legacy tak mengunci sesi lama", async () => {
  const dir = tmpRoot()
  const sid = "p1011-g"
  await seedT1(sid, dir)
  setCompletionEvidence(() => ({ verdict: "passed", detail: "bun test", turn: 5 }))
  await addMutation(sid, dir, "write_file")
  const out = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor(sid, dir),
  )) as string
  expect(out).not.toContain("refused")
  expect(storeStatus(sid, dir)).toBe("COMPLETED")
})

// ── H. Rekonsiliasi konsisten ────────────────────────────────────────────────
test("H reconcile stale: file terdemote, TaskStore tak ditulis", async () => {
  const dir = tmpRoot()
  const sid = "p1011-h"
  await seedT1(sid, dir)
  // File completed (simulasi klaim pra-reconcile, ditulis langsung agar
  // gate tak ikut campur dalam setup), store PENDING.
  await saveTodos(sid, [{ content: "ship X", status: "completed", taskId: "t1" }], dir)
  const before = JSON.stringify(new TaskStore(dir).listTasks(sid))
  const next = await reconcileCompletionEvidence(sid, dir, {
    verdict: "stale",
    detail: "verification stale — 1 mutation(s) since turn 5; re-verify, then re-claim",
  })
  expect(next?.[0]?.status).toBe("blocked")
  expect(next?.[0]?.blockedReason ?? "").toContain("stale")
  // Rekonsiliasi BUKAN writer TaskStore: tak ada baris berubah.
  expect(JSON.stringify(new TaskStore(dir).listTasks(sid))).toBe(before)
})

// ── I. Query gagal fail-closed + isolasi sesi ───────────────────────────────
test("I freshness-query error renders completion unauthorized", async () => {
  const dir = tmpRoot()
  const sid = "p1011-i"
  await seedT1(sid, dir)
  setCompletionEvidence(() => ({ verdict: "passed", detail: "bun test", turn: 5 }))
  // Jurnal korup: status check menolak memakai prefix tak-lengkap.
  writeFileSync(journalPath(sid, dir), "not-json{{{", "utf8")
  const corrupt = await resolveFreshEvidence(sid, dir)
  expect(corrupt.verdict).toBe("failed")
  expect(corrupt.detail ?? "").toContain("freshness")
  // cwd mustahil (byte NUL): resolve melempar di helper.
  const badDir = `${dir + String.fromCharCode(0)}x`
  const unreadable = await resolveFreshEvidence(sid, badDir)
  expect(unreadable.verdict).toBe("failed")
  // Tak ada jalur gagal yang mengizinkan: store tetap PENDING.
  expect(storeStatus(sid, dir)).toBe("PENDING")
})

test("I2 bukti sesi A tak mengotorisasi sesi B", async () => {
  const dir = tmpRoot()
  // Sesi A bermutasi turn 6; sesi B bersih. Bukti turn-5 yang sama:
  // A basi-ditolak, B segar-diizinkan (jurnal dibaca per-sesi).
  for (const sid of ["p1011-i2a", "p1011-i2b"]) await seedT1(sid, dir)
  setCompletionEvidence(() => ({ verdict: "passed", detail: "bun test", turn: 5 }))
  await addMutation("p1011-i2a", dir, "write_file", 6)
  const outA = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor("p1011-i2a", dir),
  )) as string
  const outB = (await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor("p1011-i2b", dir),
  )) as string
  expect(outA).toContain("stale")
  expect(outB).not.toContain("refused")
  expect(storeStatus("p1011-i2a", dir)).not.toBe("COMPLETED")
  expect(storeStatus("p1011-i2b", dir)).toBe("COMPLETED")
})

// ── J. Unit pemetaan + non-otoritas ──────────────────────────────────────────
test("J1 applyCompletionPolicy: stale dipertahankan labelnya", () => {
  const blocked = applyCompletionPolicy([{ content: "x", status: "completed" }], {
    verdict: "stale",
    detail: "stale detail asli",
  })
  expect(blocked?.[0]?.status).toBe("blocked")
  // Alasan asli diteruskan, BUKAN ditulis ulang jadi "verification failed".
  expect(blocked?.[0]?.blockedReason).toBe("stale detail asli")
  const fallback = applyCompletionPolicy([{ content: "x", status: "completed" }], {
    verdict: "stale",
  })
  expect(fallback?.[0]?.blockedReason).toBe("verification stale")
  // Non-completed tak tersentuh; passed/unverified → null (tanpa perubahan).
  expect(
    applyCompletionPolicy([{ content: "x", status: "pending" }], { verdict: "stale" }),
  ).toBeNull()
  expect(
    normalizeTodos([{ content: "x", status: "completed" }], {
      verdict: "passed",
      detail: "ok",
      turn: 1,
    })[0]!.status,
  ).toBe("completed")
})

test("J2 efek store terisolasi: hanya t1 berubah, lewat sync kanonik", async () => {
  const dir = tmpRoot()
  const sid = "p1011-j2"
  await seedT1(sid, dir)
  setCompletionEvidence(() => ({ verdict: "passed", detail: "bun test", turn: 5 }))
  await addMutation(sid, dir, "write_file", 6)
  const before = new TaskStore(dir).listTasks(sid).map((t) => ({ ...t }))
  await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "ship X", status: "completed" }] } as never,
    ctxFor(sid, dir),
  )
  const after = new TaskStore(dir).listTasks(sid)
  // Satu-satunya delta = status t1 via sync (pending→blocked); tak ada baris
  // baru, tak ada tulis langsung TaskStore oleh guard (guard tak mengimpornya).
  expect(after).toHaveLength(before.length)
  expect(after[0]!.status).toBe("BLOCKED")
  expect(after[0]!.revision).toBe(before[0]!.revision + 1)
})
