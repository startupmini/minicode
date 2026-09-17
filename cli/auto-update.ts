// Orkestrasi auto-update interaktif: cek → install → restart.
// Dipanggil dari cli/index.ts HANYA saat masuk REPL (enterRepl). One-shot,
// exec, pipe, dan CI tidak tersentuh (notifikasi async biasa) — restart di
// tengah pipeline akan merusak output machine dan perilaku skrip.

import { type ChildProcess, spawn } from "node:child_process"
import {
  checkForUpdateFresh,
  formatUpdateMessage,
  installUpdate,
  isInstalledCopy,
  shouldAutoUpdate,
  UPDATE_GUARD_ENV,
} from "../src/policy/update-check.ts"
import { c } from "../src/ui/render/theme.ts"

/**
 * Tunggu proses anak sampai benar-benar selesai — SATU-SATUNYA cara menunggu
 * spawn di repo ini. Dengarkan `exit` DAN `close` DAN `error`: `exit` saja
 * tak datang bila anak menahan stdio (pipe inherit macet) sehingga induk
 * menunggu selamanya tanpa umpan balik = terlihat hang. Guard `settled`
 * karena exit+close bisa datang berurutan untuk anak yang sama.
 */
export function waitChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((res) => {
    let settled = false
    const done = (c2: number | null) => {
      if (settled) return
      settled = true
      res(c2)
    }
    child.on("exit", (c2) => done(c2))
    child.on("close", (c2) => done(c2))
    child.on("error", () => done(1))
  })
}

/**
 * Bila layak: cek registry (fresh), install bila ada versi baru, lalu
 * respawn argv yang sama dan JANGAN kembali (process.exit di dalam).
 * Return bila tidak ada update / tak layak / install gagal — REPL lanjut
 * dengan versi lama. Tak pernah melempar.
 */
export async function maybeAutoUpdate(
  version: string,
  signal?: AbortSignal,
  opts?: { onLongOp?: () => void },
): Promise<void> {
  let decision: ReturnType<typeof shouldAutoUpdate>
  try {
    decision = shouldAutoUpdate(process.argv.slice(2), {
      stdinTTY: process.stdin.isTTY,
      installed: isInstalledCopy(),
    })
  } catch {
    return
  }
  if (!decision.run) return
  if (signal?.aborted) return
  let latest: string | null
  try {
    latest = await checkForUpdateFresh(version, signal)
  } catch {
    return
  }
  if (signal?.aborted) return
  if (!latest) return
  // Fase panjang dimulai (install + restart): minta pemanggil mematikan
  // spinner transient-nya DULU. Tanpa ini interval induk (80ms di
  // cli/index.ts) terus menulis `\r\x1b[2K` ke stderr yang sama dengan anak
  // (`stdio: inherit`) selama SELURUH sesi anak — output hancur/flicker dan
  // terlihat hang di Windows Terminal.
  try {
    opts?.onLongOp?.()
  } catch {}
  process.stderr.write(`\n${c.yellow(formatUpdateMessage(version, latest))}\n`)
  process.stderr.write(c.dim("Menginstall pembaruan otomatis…\n"))
  let ok = false
  try {
    ok = installUpdate()
  } catch {
    ok = false
  }
  if (!ok) {
    process.stderr.write(
      c.yellow(
        `Auto-update gagal — lanjut versi ${version}. Update manual: npm update -g minicode-ai\n`,
      ),
    )
    return
  }
  // Restart ke kode baru dengan argv identik; guard env cegah loop bila
  // versi ter-install ternyata masih dilaporkan lebih tua.
  process.stderr.write(c.dim(`Restart ke versi ${latest}…\n`))
  // Pastikan spinner induk mati sebelum anak hidup (idempoten — onLongOp
  // sudah dipanggil sebelum install, tapi install bisa gagal-skip jalur ini
  // bila dipanggil ulang di masa depan).
  try {
    opts?.onLongOp?.()
  } catch {}
  const entry = process.argv[1] ?? ""
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [UPDATE_GUARD_ENV]: "1" },
  })
  const code = await waitChildExit(child)
  process.exit(code ?? 0)
}
