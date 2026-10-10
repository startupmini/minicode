import { resolve } from "node:path"
import { abortError } from "#minicore/core/errors.ts"
import { runCall } from "#minicore/core/executor.ts"
import type { ExecutorDeps, ToolExecutor } from "#minicore/core/index.ts"
import type { ToolCall, ToolResult } from "#minicore/core/types.ts"
import { LIMITS } from "../constants.ts"

// Tool yang mengubah file workspace — butuh write-slot DAN file-lock per path.
const WRITE_TOOLS = new Set(["write_file", "edit", "apply_patch", "move_file", "delete_file"])

// Tool yang harus eksklusif tapi tidak punya path tunggal untuk di-lock.
// `bash` bisa menulis apa pun, jadi tidak boleh paralel dengan write lain;
// tapi memasukkannya ke WRITE_TOOLS membuat dua bash read-only
// (`bun test` + `git log`) ikut terserialisasi tanpa alasan karena
// getLockPath() selalu null untuk bash. Dipisah supaya klasifikasinya jelas —
// F-01 (P5 §C1) memperlakukannya sebagai "write tanpa kunci" (lihat di bawah).
const EXCLUSIVE_TOOLS = new Set(["bash", "write_memory", "forget_memory", "todo_write"])

function isWrite(call: ToolCall): boolean {
  return WRITE_TOOLS.has(call.name) || EXCLUSIVE_TOOLS.has(call.name)
}

// Kunci file-lock: hanya WRITE_TOOLS dengan args.path string valid.
// EXCLUSIVE_TOOLS (tanpa path) dan move_file (memakai from/to) sengaja tidak
// punya kunci — inilah yang membuat writeConcurrency > 1 tidak aman untuk
// mereka (F-01). Klasifikasi batch memakai fungsi ini; jangan diganti dengan
// cek `isWrite` saja.
function getLockPath(call: ToolCall, cwd: string | undefined): string | null {
  if (!WRITE_TOOLS.has(call.name)) return null
  const p = (call.args as Record<string, unknown>)?.path
  if (typeof p !== "string" || !p) return null
  // normalisasi: resolve abs + lowerCase di Windows agar ./a.ts vs a.ts tidak miss lock
  try {
    const base = cwd ?? process.cwd()
    const abs = resolve(base, p)
    return process.platform === "win32" ? abs.toLowerCase() : abs
  } catch {
    return process.platform === "win32" ? p.toLowerCase() : p
  }
}

// Antrean abort-aware: saat signal abort, entry dibuang dari antrean dan
// promise langsung reject — worker tidak menunggu tool in-flight selesai.
interface Waiter {
  resolve(): void
  reject(reason: unknown): void
  onAbort?: () => void
}

function detach(w: Waiter, signal: AbortSignal | undefined): void {
  if (w.onAbort && signal) signal.removeEventListener("abort", w.onAbort)
  w.onAbort = undefined
}

function makeWaiter(
  signal: AbortSignal,
  removeFromQueue: (w: Waiter) => void,
): { promise: Promise<void>; waiter: Waiter } {
  let settle!: () => void
  let rejectFn!: (reason: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    settle = res
    rejectFn = rej
  })
  const waiter: Waiter = {
    resolve: () => {
      detach(waiter, signal)
      settle()
    },
    reject: (reason) => {
      detach(waiter, signal)
      rejectFn(reason)
    },
  }
  waiter.onAbort = () => {
    removeFromQueue(waiter)
    waiter.reject(abortError(signal))
  }
  if (signal.aborted) waiter.onAbort()
  else signal.addEventListener("abort", waiter.onAbort, { once: true })
  return { promise, waiter }
}

export function parallelExecutor(
  opts: { concurrency?: number; writeConcurrency?: number } = {},
): ToolExecutor {
  const concurrency = opts.concurrency ?? LIMITS.EXECUTOR_CONCURRENCY
  const writeConcurrency = opts.writeConcurrency ?? LIMITS.EXECUTOR_WRITE_CONCURRENCY

  return {
    async execute(calls: readonly ToolCall[], deps: ExecutorDeps): Promise<readonly ToolResult[]> {
      if (calls.length === 0) return []
      const results: (ToolResult | undefined)[] = new Array(calls.length)

      // write+baca campur → sekuensial urut input: read setelah write pada file
      // sama harus melihat konten baru (paralel akan balapan). Perilaku P4 yang
      // dibekukan.
      const anyWrite = calls.some(isWrite)
      const anyRead = calls.some((c) => !isWrite(c))
      if (anyWrite && anyRead) {
        for (let i = 0; i < calls.length; i++) {
          if (deps.signal.aborted) throw abortError(deps.signal)
          results[i] = await runCall(calls[i]!, deps)
        }
        return results as ToolResult[]
      }

      // F-01 (P5 §C1): slot tulis (writeConcurrency > 1) hanya didemonstrasikan
      // aman untuk write tool ber-kunci args.path. Batch yang mengandung write
      // tanpa kunci — EXCLUSIVE_TOOLS (bash dsb.), move_file (from/to), atau
      // WRITE_TOOL tanpa path valid — dijalankan sekuensial penuh. Ini menutup
      // overlap dua bash, bash vs write path, dan dua move_file yang dulu lolos
      // pada wc > 1 tanpa bukti keselamatan; batch murni write ber-path tetap
      // memakai semaphore + file-lock di bawah. Race terhadap signal
      // mempertahankan penolakan prompt saat abort (setara antrean writeWaiter):
      // tool in-flight boleh mengabaikan signal, tetapi execute() reject begitu
      // abort datang, tanpa menunggu tool selesai.
      const anyUnkeyedWrite = calls.some((c) => isWrite(c) && getLockPath(c, deps.cwd) === null)
      if (anyWrite && anyUnkeyedWrite) {
        const signal = deps.signal
        let onAbort: (() => void) | undefined
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(abortError(signal))
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        })
        try {
          await Promise.race([
            (async () => {
              for (let i = 0; i < calls.length; i++) {
                if (signal.aborted) throw abortError(signal)
                results[i] = await runCall(calls[i]!, deps)
              }
            })(),
            aborted,
          ])
        } finally {
          // lepas listener agar signal jangka panjang tidak menumpuk listener
          if (onAbort) signal.removeEventListener("abort", onAbort)
        }
        return results as ToolResult[]
      }

      let cursor = 0
      let activeWrites = 0
      // per-file lock to prevent same-file write race (e.g. two edits to same path)
      const fileLocks = new Map<string, number>()
      const fileWaiters = new Map<string, Waiter[]>()
      const writeWaiters: Waiter[] = []
      const signal = deps.signal

      function acquireWrite(): Promise<void> {
        if (signal.aborted) return Promise.reject(abortError(signal))
        if (activeWrites < writeConcurrency) {
          activeWrites++
          return Promise.resolve()
        }
        const { promise, waiter } = makeWaiter(signal, (w) => {
          const i = writeWaiters.indexOf(w)
          if (i !== -1) writeWaiters.splice(i, 1)
        })
        writeWaiters.push(waiter)
        return promise
      }
      function releaseWrite(): void {
        const next = writeWaiters.shift()
        if (next) {
          // ownership berpindah — counter tetap (setara decrement+increment lama)
          next.resolve()
        } else {
          activeWrites--
        }
      }

      function acquireFileLock(path: string | null): Promise<void> {
        if (!path) return Promise.resolve()
        if (signal.aborted) return Promise.reject(abortError(signal))
        if ((fileLocks.get(path) ?? 0) === 0) {
          fileLocks.set(path, 1)
          return Promise.resolve()
        }
        const { promise, waiter } = makeWaiter(signal, (w) => {
          const q = fileWaiters.get(path)
          if (!q) return
          const i = q.indexOf(w)
          if (i !== -1) q.splice(i, 1)
          if (q.length === 0) fileWaiters.delete(path)
        })
        const q = fileWaiters.get(path) ?? []
        q.push(waiter)
        fileWaiters.set(path, q)
        return promise
      }
      function releaseFileLock(path: string | null): void {
        if (!path) return
        const q = fileWaiters.get(path)
        const next = q?.shift()
        if (next) {
          if (q && q.length === 0) fileWaiters.delete(path)
          next.resolve() // ownership berpindah ke waiter berikutnya
        } else {
          fileLocks.delete(path)
        }
      }

      const workers = Array(Math.min(concurrency, calls.length))
        .fill(0)
        .map(async () => {
          while (true) {
            if (deps.signal.aborted) throw abortError(deps.signal)
            const idx = cursor++
            if (idx >= calls.length) break
            const call = calls[idx]!
            const needWrite = isWrite(call)
            const filePath = needWrite ? getLockPath(call, deps.cwd) : null
            let held = false
            try {
              if (needWrite) {
                await acquireWrite() // nothing held yet — safe to throw
                try {
                  await acquireFileLock(filePath)
                  held = true
                } catch (e) {
                  releaseWrite()
                  throw e
                }
              }
              const res = await runCall(call, deps)
              results[idx] = res
            } finally {
              if (held) {
                releaseFileLock(filePath)
                releaseWrite()
              }
            }
          }
        })
      await Promise.all(workers)
      return results as ToolResult[]
    },
  }
}
