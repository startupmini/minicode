import { afterEach, expect, test } from "bun:test"
import type { ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { runInDocker, setDockerSpawnForTest } from "../src/sandbox/docker.ts"

afterEach(() => setDockerSpawnForTest(null))

function fakeDockerSpawn(opts: { cleanupCode?: number; calls: string[][] }) {
  return ((_: string, args: string[]) => {
    opts.calls.push(args)
    const child = new EventEmitter() as unknown as ChildProcess
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    Object.assign(child, {
      stdout,
      stderr,
      kill: () => {
        queueMicrotask(() => child.emit("close", 137, "SIGKILL"))
        return true
      },
    })
    if (args[0] === "rm") {
      queueMicrotask(() => child.emit("close", opts.cleanupCode ?? 0, null))
    }
    return child
  }) as typeof spawn
}

test("Docker timeout asks daemon to force-remove the named container", async () => {
  const calls: string[][] = []
  setDockerSpawnForTest(fakeDockerSpawn({ calls }))

  const result = await runInDocker("sleep 30", process.cwd(), { timeoutMs: 5 })

  expect(calls).toHaveLength(2)
  expect(calls[0]?.[0]).toBe("run")
  const nameIndex = calls[0]?.indexOf("--name") ?? -1
  const containerName = nameIndex >= 0 ? calls[0]?.[nameIndex + 1] : undefined
  const safeContainerName = containerName ?? ""
  expect(safeContainerName).toMatch(/^minicode-[0-9a-f-]{36}$/)
  expect(calls[1]).toEqual(["rm", "--force", safeContainerName])
  expect(result.code).toBeNull()
  expect(result.output).toContain("timed out")
  expect(result.output).toContain("daemon container removal confirmed")
})

test("Docker abort reports when daemon cleanup cannot be confirmed", async () => {
  const calls: string[][] = []
  const controller = new AbortController()
  setDockerSpawnForTest(fakeDockerSpawn({ cleanupCode: 1, calls }))

  const started = runInDocker("sleep 30", process.cwd(), {
    timeoutMs: 30_000,
    signal: controller.signal,
  })
  controller.abort()
  const result = await started

  expect(calls[1]?.slice(0, 2)).toEqual(["rm", "--force"])
  expect(result.code).toBeNull()
  expect(result.output).toContain("aborted")
  expect(result.output).toContain("daemon cleanup unconfirmed")
})
