// Benchmark TUI lewat PTY produksi, bukan renderer sintetis saja.
// Profil memakai provider palsu lokal; tidak menghubungi provider eksternal.

import { ptyAvailable, spawnTui } from "../test/helpers/pty-harness.ts"

const pty = await ptyAvailable()
if (!pty.ok) throw new Error(`PTY tidak tersedia: ${pty.reason}`)

const cols = 100
const rows = 30
const markerCount = 12
const largeReply = Array.from(
  { length: 80 },
  (_, i) => `render benchmark row ${i}: 漢字 👨‍👩‍👧‍👦 🇮🇩`,
).join("\n")
const tui = await spawnTui({
  cols,
  rows,
  reply: { kind: "text", text: largeReply },
})

async function waitUntil(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const started = performance.now()
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) {
      throw new Error(`benchmark timed out; pty=${JSON.stringify(tui.raw().slice(-500))}`)
    }
    await Bun.sleep(2)
  }
}

function quantile(values: number[], q: number): number {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * q) - 1)] ?? 0
}

let terminalRestoreObserved = false
let benchmarkCompleted = false

try {
  await waitUntil(() => tui.raw().includes("00.00.00"))
  const samples: number[] = []
  const measuredStart = tui.raw().length
  const runStarted = performance.now()

  for (let i = 0; i < markerCount; i++) {
    const marker = `bench-input-${String(i).padStart(2, "0")}`
    const writeStart = tui.raw().length
    const start = performance.now()
    tui.send(marker)
    await waitUntil(() => tui.raw().slice(writeStart).includes(marker))
    samples.push(performance.now() - start)

    const submitStart = tui.raw().length
    tui.send("\r")
    await waitUntil(() =>
      tui
        .raw()
        .slice(submitStart)
        .split("\r\n")
        .some((line) => line === "minicode ›\x1b[K" || line === "minicode › "),
    )
  }

  const elapsedMs = performance.now() - runStarted
  const measuredOutput = tui.raw().slice(measuredStart)
  const frames = measuredOutput.split("\x1b[?2026h").length - 1
  const result = {
    profile: {
      cols,
      rows,
      measuredInputs: samples.length,
      completedTurns: markerCount,
      replyCharsPerTurn: largeReply.length,
      replyLinesPerTurn: largeReply.split("\n").length,
      inputMethod: "unique prompt text sent through PTY; first visible composer frame",
    },
    inputToFrameMs: {
      p50: Number(quantile(samples, 0.5).toFixed(2)),
      p95: Number(quantile(samples, 0.95).toFixed(2)),
      max: Number(Math.max(...samples).toFixed(2)),
    },
    render: {
      fullFrameCount: frames,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      fullFrameWritesPerSecond: Number((frames / (elapsedMs / 1000)).toFixed(2)),
      bytesWritten: Buffer.byteLength(measuredOutput, "utf8"),
    },
    limits: [
      "synthetic local provider; not a real model or user dataset",
      "no child-process CPU, idle CPU, or child heap sampling",
      "timings are host/PTY dependent and are not a CI performance threshold",
    ],
  }
  tui.send("\x04")
  try {
    await waitUntil(() => tui.raw().includes("\x1b[?1049l"), 3000)
    terminalRestoreObserved = true
  } catch {}
  Object.assign(result, { terminalRestoreObserved })
  await Bun.write(Bun.stdout, `${JSON.stringify(result, null, 2)}\n`)
  benchmarkCompleted = true
} finally {
  try {
    tui.kill()
  } catch {}
  await Promise.race([tui.exit(), Bun.sleep(3000)])
  tui.dispose()
}
process.exit(benchmarkCompleted && terminalRestoreObserved ? 0 : 1)
