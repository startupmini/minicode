// Temporary Linux diagnostic — print exact process-signal behavior on CI.
import { spawn } from "node:child_process"
import { createHostBackend } from "../src/runtime/execution-backend.ts"

const NODE = JSON.stringify(process.execPath)
console.log("execPath=", JSON.stringify(process.execPath))
console.log("platform=", process.platform, "version=", process.version)

// 1) Direct spawn (NO shell): does bun -e 'process.on SIGTERM' survive SIGTERM?
function probe(label: string, script: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["-e", script], { stdio: "ignore" })
    let alive = true
    p.once("exit", (code, sig) => {
      console.log(`[${label}] process exited after SIGTERM: code=${code} sig=${sig}`)
      alive = false
      resolve()
    })
    setTimeout(() => {
      p.kill("SIGTERM")
      setTimeout(() => {
        console.log(`[${label}] alive-after-SIGTERM=${alive}`)
        if (alive) {
          p.kill("SIGKILL")
        }
        resolve()
      }, 800)
    }, 300)
  })
}

async function main() {
  await probe("bun-ignore-sigterm-direct", "process.on('SIGTERM',()=>{});setTimeout(()=>{},30000)")
  await probe("bun-sleeper-direct", "setTimeout(()=>{},30000)")

  // 2) Via createHostBackend (shell:true + detached) on Linux.
  const backend = createHostBackend()
  const started = await backend.start({ cmd: `${NODE} -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},30000)"` })
  console.log("backend.start.started=", started.started, started.started ? "" : started.reason)
  if (started.started) {
    const c = backend.cancel(started.handle, "diag")
    console.log("cancel=", JSON.stringify(c))
    const afterCancel = await backend.wait(started.handle, 4000)
    console.log("waitAfterCancel=", JSON.stringify(afterCancel))
    const obs = backend.observe(started.handle)
    console.log("observe-after-cancel=", JSON.stringify(obs))
    const t = backend.terminate(started.handle, "diag")
    console.log("terminate=", JSON.stringify(t))
    const afterTerm = await backend.wait(started.handle, 4000)
    console.log("waitAfterTerminate=", JSON.stringify(afterTerm))
    backend.dispose(started.handle)
  }
  process.exit(0)
}

main()