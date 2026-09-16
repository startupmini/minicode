import { expect, test } from "bun:test"
import { dockerAvailable, runInDocker } from "../src/sandbox/docker.ts"

const hasDocker = dockerAvailable()

test("docker: availability check returns boolean", () => {
  expect(typeof hasDocker).toBe("boolean")
})

test.skipIf(!hasDocker)(
  "docker: echo command in container returns output",
  async () => {
    const res = await runInDocker("echo sandbox-hello", process.cwd(), { timeoutMs: 30_000 })
    expect(res.output).toContain("sandbox-hello")
    expect(res.code).toBe(0)
  },
  15000,
)

test.skipIf(!hasDocker)(
  "docker: fails gracefully on unknown command",
  async () => {
    const res = await runInDocker("nonexistent_cmd_xyz", process.cwd(), { timeoutMs: 10_000 })
    expect(res.code).not.toBe(0)
  },
  15000,
)
