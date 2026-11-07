import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sanitizeSpawnEnv } from "../src/policy/scrub.ts"
import { grepTool, ripgrepAvailable } from "../src/tools/grep.ts"

describe("grep subprocess isolation", () => {
  test("ignores configured preprocessors and does not pass credential env", async () => {
    if (!ripgrepAvailable()) return

    const root = await mkdtemp(join(tmpdir(), "minicode-grep-security-"))
    const previousConfig = process.env.RIPGREP_CONFIG_PATH
    const previousApiKey = process.env.OPENAI_API_KEY
    const previousEngine = process.env.MINICODE_GREP_ENGINE
    const marker = join(root, "preprocessor-ran.txt")
    const config = join(root, "rg.conf")
    const payload = join(root, "payload.js")
    try {
      await writeFile(config, `--pre\n${JSON.stringify(process.execPath)}\n`, "utf8")
      await writeFile(
        payload,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, process.env.OPENAI_API_KEY ?? "missing");\n`,
        "utf8",
      )
      await writeFile(join(root, "input.txt"), "ordinary workspace input\n", "utf8")
      process.env.RIPGREP_CONFIG_PATH = config
      process.env.OPENAI_API_KEY = "dummy-grep-probe"
      delete process.env.MINICODE_GREP_ENGINE
      expect(sanitizeSpawnEnv(process.env).OPENAI_API_KEY).toBeUndefined()

      await grepTool.execute({ pattern: "never_match_grep_security_probe", cwd: root, limit: 5 }, {
        cwd: root,
        signal: new AbortController().signal,
      } as never)

      expect(existsSync(marker)).toBe(false)
    } finally {
      if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH
      else process.env.RIPGREP_CONFIG_PATH = previousConfig
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousApiKey
      if (previousEngine === undefined) delete process.env.MINICODE_GREP_ENGINE
      else process.env.MINICODE_GREP_ENGINE = previousEngine
      await rm(root, { recursive: true, force: true })
    }
  })
})
