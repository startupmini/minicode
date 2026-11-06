import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startFakeProvider } from "./helpers/fake-provider.ts"
import { cleanEnvForChild } from "./helpers/pty-harness.ts"

const entry = resolve(import.meta.dir, "../cli/index.ts")

describe("interactive TUI startup failure", () => {
  test("--interactive over pipes reports to stderr and exits nonzero", async () => {
    const root = mkdtempSync(join(tmpdir(), "minicode-tui-no-tty-"))
    const home = join(root, "home")
    const cwd = join(root, "workspace")
    mkdirSync(join(home, ".minicode"), { recursive: true })
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    const provider = startFakeProvider([{ kind: "text", text: "unused" }])
    try {
      writeFileSync(
        join(home, ".minicode", "config.json"),
        JSON.stringify({
          providers: [
            {
              id: "fake",
              baseUrl: provider.baseUrl,
              apiKey: "test-key",
              models: ["gpt-4o-mini"],
            },
          ],
        }),
        "utf8",
      )
      const child = Bun.spawn([process.execPath, entry, "--interactive"], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: cleanEnvForChild({
          MINICODE_HOME: home,
          HOME: home,
          USERPROFILE: home,
          MINICODE_AUTO_UPDATE: "0",
          NO_COLOR: "1",
        }),
      })
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(status).toBe(1)
      expect(stdout).toBe("")
      expect(stderr).toContain("fullscreen")
      expect(stderr).toContain("TTY")
      expect(provider.requestCount()).toBe(0)
    } finally {
      provider.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
