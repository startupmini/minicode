// Temporary Linux diagnostic — print exact process-signal behavior on CI.
import { spawn } from "node:child_process"
import { createHostBackend } from "../src/runtime/execution-backend.ts"

const NODE = JSON.stringify(process.execPath)
const sleeper = (ms: number) => `${NODE} -e "setTimeout(()=>{},${ms})"`
const ignorer = (ms: number) => `${NODE} -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},${ms})"`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const backend = createHostBackend()

  // Case B9: sleeper (no SIGTERM handler) via backend → cancel → wait.
  {
    const s = await backend.start({ cmd: sleeper(30_000) })
    console.log("[B9-sleeper] started=", s.started)
    if (s.started) {
      const c = backend.cancel(s.handle, "diag")
      console.log("[B9-sleeper] cancel=", JSON.stringify(c))
      const t0 = Date.now()
      const w = await backend.wait(s.handle, 3000)
      console.log("[B9-sleeper] waitAfterCancel=", JSON.stringify(w), "elapsed=", Date.now() - t0)
      backend.dispose(s.handle)
    }
  }

  // Case S7 race: ignorer via backend, IMMEDIATE cancel (no settle).
  {
    const s = await backend.start({ cmd: ignorer(20_000) })
    console.log("[S7-immediate] started=", s.started)
    if (s.started) {
      const c = backend.cancel(s.handle, "diag")
      console.log("[S7-immediate] cancel=", JSON.stringify(c))
      const w = await backend.wait(s.handle, 1000)
      console.log("[S7-immediate] waitAfterCancel=", JSON.stringify(w))
      backend.dispose(s.handle)
    }
  }

  // Case S7 de-raced: ignorer via backend, settle 250ms FIRST, then cancel.
  {
    const s = await backend.start({ cmd: ignorer(20_000) })
    console.log("[S7-settled] started=", s.started)
    if (s.started) {
      await sleep(250)
      const c = backend.cancel(s.handle, "diag")
      console.log("[S7-settled] cancel=", JSON.stringify(c))
      const w = await backend.wait(s.handle, 1000)
      console.log("[S7-settled] waitAfterCancel=", JSON.stringify(w))
      backend.dispose(s.handle)
    }
  }

  // Raw spawn (NO shell, NO detached): does sleeper die from SIGTERM?
  await new Promise<void>((resolve) => {
    const p = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" })
    p.once("exit", (code, sig) => { console.log("[raw-sleeper] exit code=", code, "sig=", sig); resolve() })
    setTimeout(() => p.kill("SIGTERM"), 200)
  })

  // Raw spawn with detached:true (NO shell): does sleeper die from SIGTERM?
  await new Promise<void>((resolve) => {
    const p = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore", detached: true })
    p.once("exit", (code, sig) => { console.log("[raw-sleeper-detached] exit code=", code, "sig=", sig); resolve() })
    setTimeout(() => p.kill("SIGTERM"), 200)
  })

  process.exit(0)
}

main()