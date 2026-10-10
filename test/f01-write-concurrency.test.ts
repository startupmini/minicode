// F-01 / P5 §C1 — kontrak keselamatan write-concurrency.
//
// Invariant: tidak ada konfigurasi atau jalur eksekusi yang mengaktifkan
// overlap operasi tulis di luar kontrak yang didemonstrasikan implementasi.
// writeConcurrency > 1 hanya didukung untuk write tool ber-kunci args.path;
// EXCLUSIVE_TOOLS, move_file (from/to), dan WRITE_TOOL tanpa path valid
// tetap terserialisasi penuh — dengan penolakan abort tetap prompt.
//
// Setiap test diskriminatif: test 1-4 & 6 GAGAL terhadap executor lama
// (semaphore tanpa klasifikasi kunci); test 5 GAGAL terhadap clamp sekuensial
// buta (over-clamping).

import { expect, test } from "bun:test"
import { createEventBus, createToolRegistry } from "#minicore"
import { allowAll } from "#minicore/test/fakes.ts"
import { parallelExecutor } from "../src/policy/executor.ts"

interface Gate {
  entered: Promise<void>
  enter(): void
  release: Promise<void>
  open(): void
}

function makeGate(): Gate {
  let enter!: () => void
  let open!: () => void
  const entered = new Promise<void>((r) => {
    enter = r
  })
  const release = new Promise<void>((r) => {
    open = r
  })
  return { entered, enter, release, open }
}

// Gate per panggilan execute (FIFO): satu tool name bisa dipakai beberapa call
// dalam batch, gate di-shift sesuai urutan masuk worker.
function gatedTool(name: string, gates: Gate[], log: string[]) {
  return {
    name,
    description: "gated",
    parameters: { type: "object" as const, properties: {}, additionalProperties: true },
    async execute() {
      const g = gates.shift()
      if (!g) throw new Error(`gate habis untuk ${name}`)
      log.push(`${name}:enter`)
      g.enter()
      await g.release
      log.push(`${name}:exit`)
      return "ok"
    },
  }
}

function depsOf(tools: unknown[]) {
  return {
    registry: createToolRegistry(tools as never),
    permissions: allowAll,
    events: createEventBus(),
    signal: new AbortController().signal,
    state: { history: [], turnCount: 0, stepCount: 0 },
    maxResultTokens: 4096,
  }
}

// Beri kesempatan macrotask menjalankan call yang sudah diadmit executor.
// Bukan sleep sinkronisasi: kalau call kedua memang diadmit, ia sudah enter
// pada giliran pertama (acquireWrite resolve sinkron).
async function quiesce(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

function enteredCount(log: string[]): number {
  return log.filter((e) => e.endsWith(":enter")).length
}

test("F-01: dua bash tidak overlap pada writeConcurrency > 1", async () => {
  const g1 = makeGate()
  const g2 = makeGate()
  const log: string[] = []
  const exec = parallelExecutor({ concurrency: 6, writeConcurrency: 2 })
  const p = exec.execute(
    [
      { id: "1", name: "bash", args: {} },
      { id: "2", name: "bash", args: {} },
    ],
    depsOf([gatedTool("bash", [g1, g2], log)]),
  )
  await g1.entered
  await quiesce()
  // executor lama: bash kedua ikut masuk slot wc=2 → enter count 2
  expect(enteredCount(log)).toBe(1)
  g1.open()
  await g2.entered
  g2.open()
  await p
  expect(log).toEqual(["bash:enter", "bash:exit", "bash:enter", "bash:exit"])
})

test("F-01: bash tidak overlap dengan write path pada writeConcurrency > 1", async () => {
  const g1 = makeGate()
  const g2 = makeGate()
  const log: string[] = []
  const exec = parallelExecutor({ concurrency: 6, writeConcurrency: 2 })
  const p = exec.execute(
    [
      { id: "1", name: "bash", args: {} },
      { id: "2", name: "write_file", args: { path: "a.ts" } },
    ],
    depsOf([gatedTool("bash", [g1], log), gatedTool("write_file", [g2], log)]),
  )
  await g1.entered
  await quiesce()
  // executor lama: write_file lolos slot wc=2 + lock a.ts (tak berebut dengan bash)
  expect(enteredCount(log)).toBe(1)
  g1.open()
  await g2.entered
  g2.open()
  await p
  expect(log).toEqual(["bash:enter", "bash:exit", "write_file:enter", "write_file:exit"])
})

test("F-01: move_file (from/to) tidak overlap dengan write lain pada writeConcurrency > 1", async () => {
  const g1 = makeGate()
  const g2 = makeGate()
  const g3 = makeGate()
  const log: string[] = []
  const exec = parallelExecutor({ concurrency: 6, writeConcurrency: 3 })
  const p = exec.execute(
    [
      { id: "1", name: "move_file", args: { from: "a.ts", to: "b.ts" } },
      { id: "2", name: "write_file", args: { path: "b.ts" } },
      { id: "3", name: "move_file", args: { from: "c.ts", to: "d.ts" } },
    ],
    depsOf([gatedTool("move_file", [g1, g3], log), gatedTool("write_file", [g2], log)]),
  )
  await g1.entered
  await quiesce()
  // executor lama: move_file tanpa lock → lolos wc=3 bersama write b.ts (race tujuan)
  expect(enteredCount(log)).toBe(1)
  g1.open()
  await g2.entered
  g2.open()
  await g3.entered
  g3.open()
  await p
  expect(log).toEqual([
    "move_file:enter",
    "move_file:exit",
    "write_file:enter",
    "write_file:exit",
    "move_file:enter",
    "move_file:exit",
  ])
})

test("F-01: WRITE_TOOL tanpa args.path valid memaksa serial (fail-closed)", async () => {
  const g1 = makeGate()
  const g2 = makeGate()
  const log: string[] = []
  const exec = parallelExecutor({ concurrency: 6, writeConcurrency: 2 })
  const p = exec.execute(
    [
      { id: "1", name: "write_file", args: {} },
      { id: "2", name: "write_file", args: { path: "a.ts" } },
    ],
    depsOf([gatedTool("write_file", [g1, g2], log)]),
  )
  await g1.entered
  await quiesce()
  // executor lama: args {} → tanpa lock → overlap dengan write ber-path
  expect(enteredCount(log)).toBe(1)
  g1.open()
  await g2.entered
  g2.open()
  await p
  expect(enteredCount(log)).toBe(2)
})

test("F-01-regresi: write path independent tetap paralel pada writeConcurrency = 3", async () => {
  const g1 = makeGate()
  const g2 = makeGate()
  const g3 = makeGate()
  const log: string[] = []
  const exec = parallelExecutor({ concurrency: 6, writeConcurrency: 3 })
  const p = exec.execute(
    [
      { id: "1", name: "write_file", args: { path: "a.ts" } },
      { id: "2", name: "write_file", args: { path: "b.ts" } },
      { id: "3", name: "write_file", args: { path: "c.ts" } },
    ],
    depsOf([gatedTool("write_file", [g1, g2, g3], log)]),
  )
  // ketiga-gate entered sebelum salah satu dibuka = benar-benar paralel.
  // Kalau implementasi salah men-sekuensalkan semua write, test ini menggantung
  // lalu gagal (timeout) — membatasi over-clamping.
  await Promise.all([g1.entered, g2.entered, g3.entered])
  expect(enteredCount(log)).toBe(3)
  g1.open()
  g2.open()
  g3.open()
  await p
  expect(log.filter((e) => e.endsWith(":exit"))).toHaveLength(3)
})

test("F-01: abort menolak prompt untuk batch tanpa kunci pada writeConcurrency > 1", async () => {
  const g1 = makeGate()
  const g2 = makeGate()
  const log: string[] = []
  const ac = new AbortController()
  const exec = parallelExecutor({ concurrency: 6, writeConcurrency: 2 })
  const p = exec.execute(
    [
      { id: "1", name: "bash", args: {} },
      { id: "2", name: "bash", args: {} },
    ],
    { ...depsOf([gatedTool("bash", [g1, g2], log)]), signal: ac.signal },
  )
  await g1.entered
  ac.abort()
  const outcome = await Promise.race([
    p.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise((r) => setTimeout(() => r("pending" as const), 300)),
  ])
  // executor lama wc=2: dua bash in-flight, abort tak punya waiter → tetap pending
  expect(outcome).toBe("rejected")
  // biarkan tool in-flight selesai; rantai sequential berhenti sebelum call 2,
  // penolakan orphan dikonsumsi Promise.race (tanpa unhandled rejection)
  g1.open()
  await p.catch(() => {})
})
