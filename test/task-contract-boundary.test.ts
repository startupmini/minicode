// R3 — Batas kontrak store-permisif (STORE-PERMISSIVE CONTRACT JUSTIFIED).
//
// File ini mengunci pembagian tanggung jawab, BUKAN menambahi pagar:
// - TaskStore menegakkan: validitas struktural/identitas, alasan BLOCKED,
//   otoritas IN_PROGRESS (mode SCHEDULER), dan predikat atomik primitif
//   eksklusi (claim/reconcile).
// - Penulis terotorisasi menegakkan aturan alur kerja (model: normalizeTodos
//   + gerbang bukti; scheduler: protokol claim; recovery: revert berpagar).
// - Konsumen menurunkan kesiapan dari status yang dideklarasikan apa adanya;
//   penerimaan store TIDAK membuktikan prasyarat terpenuhi.
//
// [Fase 1 / LOOP-INV-02] REVISI KONTRAK — read before changing:
// Store kini PUNYA from-state gate (`TASK_EDGES`). Status non-terminal tetap
// permisif (FAILED→PENDING retry, BLOCKED→PENDING unblock, VERIFYING→PENDING
// revert semuanya sah), tetapi status TERMINAL (`COMPLETED`/`CANCELLED`) tidak
// bisa keluar tanpa permit eksplisit `allowReopen: true`. Reopen tetap
// MUNGKIN — yang berubah adalah ia tidak lagi bisa terjadi sebagai efek
// samping tulisan status biasa, dan setiap pemanggilnya bisa diaudit dengan
// `grep allowReopen`.
//
// Setiap test menyatakan kontrak yang dibuktikannya dan GAGAL bila perilaku
// menyimpang. Status di luar kosakata model (VERIFYING/FAILED/RETRYING —
// tanpa produsen di jalur legacy) diuji sebatas wiring VERIFYING yang kini
// eksplisit.
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskGraph } from "../src/task/graph.ts"
import { TaskError } from "../src/task/model.ts"
import { type NewTaskInput, resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const owned: string[] = []

async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-task-contract-"))
  owned.push(dir)
  return dir
}

afterEach(async () => {
  resetTaskStoreHandles()
  while (owned.length) {
    const dir = owned.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

const prov = { origin: "runtime", source: "test" } as const
const S = "kontrak"

function baru(title: string, over: Partial<NewTaskInput> = {}): NewTaskInput {
  return { title, status: "PENDING", order: 0, provenance: prov, ...over }
}

// Kontrak 1: tak ada gerbang from-state/to-state. Baris "harus ditolak"
// pending→completed di tabel desain TIDAK ditegakkan store; penyelesaian
// hijau/tanpa-bukti memang diizinkan (lih. task-invariants "bukti hijau /
// tak ada bukti tetap mengizinkan completed"). Yang menutup klaim palsu
// adalah gerbang bukti di penulis (normalizeTodos), bukan store.
test("kontrak: store menerima pending→completed (tak ada gerbang transisi)", async () => {
  const s = new TaskStore(await ownedDir())
  const t = s.createTask(S, baru("kerja"))
  const next = s.patchTask(S, t.id, { status: "COMPLETED" })
  expect(next.status).toBe("COMPLETED")
  expect(next.revision).toBe(t.revision + 1)
})

// Kontrak 2: reopen adalah alur yang SAH tetapi kini butuh permit eksplisit
// (`allowReopen`). Ini yang mengubah "terminal bisa hidup lagi" dari efek
// samping menjadi keputusan yang tertulis di pemanggil.
test("kontrak: reopen completed→pending butuh permit eksplisit allowReopen", async () => {
  const s = new TaskStore(await ownedDir())
  const t = s.createTask(S, baru("kerja"))
  s.patchTask(S, t.id, { status: "COMPLETED" })
  // Tanpa permit: fail-closed, bukan diam-diam hidup lagi.
  expect(() => s.patchTask(S, t.id, { status: "PENDING" })).toThrow()
  expect(s.getTask(S, t.id)?.status).toBe("COMPLETED")
  const next = s.patchTask(S, t.id, { status: "PENDING" }, { allowReopen: true })
  expect(next.status).toBe("PENDING")
})

// Kontrak 3: penulisan ulang status terminal juga butuh permit eksplisit.
// Yang "terminal" adalah perlakuan primitif scheduler (tak bisa di-claim, tak
// bisa di-reconcile) PLUS gerbang from-state di store; keluar darinya hanya
// lewat permit operator yang tertulis.
test("kontrak: tulis ulang cancelled→in_progress butuh permit eksplisit allowReopen", async () => {
  const s = new TaskStore(await ownedDir())
  const t = s.createTask(S, baru("kerja"))
  s.patchTask(S, t.id, { status: "CANCELLED" })
  expect(() => s.patchTask(S, t.id, { status: "IN_PROGRESS" })).toThrow()
  expect(s.getTask(S, t.id)?.status).toBe("CANCELLED")
  const next = s.patchTask(S, t.id, { status: "IN_PROGRESS" }, { allowReopen: true })
  expect(next.status).toBe("IN_PROGRESS")
})

// Kontrak 4: satu-satunya aturan status di validate() — BLOCKED wajib
// beralasan (TASK_INVALID_TRANSITION). Selain itu semua status lolos.
test("kontrak: BLOCKED tanpa alasan ditolak; beralasan diterima", async () => {
  const s = new TaskStore(await ownedDir())
  const t = s.createTask(S, baru("kerja"))
  let code: string | null = null
  try {
    s.patchTask(S, t.id, { status: "BLOCKED" })
  } catch (e) {
    code = e instanceof TaskError ? e.code : null
  }
  expect(code).toBe("TASK_INVALID_TRANSITION")
  const next = s.patchTask(S, t.id, { status: "BLOCKED", blockedReason: "butuh input" })
  expect(next.status).toBe("BLOCKED")
  expect(next.blockedReason).toBe("butuh input")
})

// Kontrak 5 (COMPLETED ≠ bukti prasyarat): store menerima completed walau
// dependensi belum terpenuhi, dan graph menurunkannya apa adanya — B yang
// completed memenuhi C walau A masih pending. Penerimaan store bukan bukti
// operasi bisnis selesai; jaminan completion milik alur kerja yang
// membutuhkan (gerbang bukti/verifier), bukan store.
test("kontrak: completed diterima tanpa prasyarat; graph menurunkannya apa adanya", async () => {
  const s = new TaskStore(await ownedDir())
  const a = s.createTask(S, baru("prasyarat"))
  const b = s.createTask(S, baru("tugas", { dependsOn: [a.id] }))
  // Prasyarat A masih PENDING, namun deklarasi completed untuk B tetap tersimpan.
  const nb = s.patchTask(S, b.id, { status: "COMPLETED" })
  expect(nb.status).toBe("COMPLETED")
  const c = s.createTask(S, baru("lanVictor", { dependsOn: [b.id] }))
  const g = new TaskGraph(s.getSnapshot(S))
  expect(g.isReady(a.id)).toBe(true)
  expect(g.isReady(b.id)).toBe(false)
  // C siap karena B completed — diturunkan dari status yang dideklarasikan,
  // bukan dari kebenaran operasi bisnis di baliknya.
  expect(g.isReady(c.id)).toBe(true)
  expect(g.readyTasks()).toEqual([a.id, c.id])
})

// Kontrak 6: pagar primitif eksklusi tetap utuh di samping kebebasan patch.
// Klaim dari non-PENDING dan reconcile atas non-inflight DITOLAK secara
// atomik — inilah "hibrida" yang benar: predikat di mana eksklusi
// dibutuhkan, permisif di keputusan alur kerja.
test("kontrak: claim non-PENDING ditolak; reconcile non-inflight bukan target", async () => {
  const s = new TaskStore(await ownedDir())
  const t = s.createTask(S, baru("kerja"))
  s.patchTask(S, t.id, { status: "COMPLETED" })
  const cur = s.getTask(S, t.id)!
  expect(s.claimTask(S, t.id, cur.revision).outcome).toBe("WRONG_STATE")
  expect(s.reconcileStranded(S, t.id, cur.revision, { ownsSession: true }).outcome).toBe(
    "NOT_STRANDED",
  )
})

// Kontrak 7: otoritas IN_PROGRESS — mode SCHEDULER menutup penulisan model,
// mode LEGACY mempertahankannya. Batas ini milik store dan berpagar error.
test("kontrak: otoritas IN_PROGRESS — SCHEDULER menolak tulis model, LEGACY mengizinkan", async () => {
  const dir = await ownedDir()
  const sch = new TaskStore(dir, { authority: "SCHEDULER" })
  const t = sch.createTask(S, baru("kerja"))
  let code: string | null = null
  try {
    sch.patchTask(S, t.id, { status: "IN_PROGRESS" })
  } catch (e) {
    code = e instanceof TaskError ? e.code : null
  }
  expect(code).toBe("TASK_AUTHORITY_VIOLATION")
  const leg = new TaskStore(dir)
  const next = leg.patchTask(S, t.id, { status: "IN_PROGRESS" })
  expect(next.status).toBe("IN_PROGRESS")
})
