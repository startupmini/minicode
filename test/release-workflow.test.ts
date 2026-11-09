import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

test("publish workflow requires matching semver tag and runs release gates on checked-out ref", async () => {
  const workflow = await readFile(
    join(import.meta.dir, "..", ".github", "workflows", "publish.yml"),
    "utf8",
  )
  expect(workflow).toContain("GITHUB_REF_TYPE")
  expect(workflow).toMatch(/GITHUB_REF_TYPE.*!=.*tag/)
  expect(workflow).toMatch(/refs\/tags\/v\[0-9\]/)
  expect(workflow).toMatch(/refs\/tags\/v\$\{PKG_VERSION\}/)
  expect(workflow).toContain("bun x tsc --noEmit")
  expect(workflow).toContain("bun run lint")
  expect(workflow).toContain("bun test")
  expect(workflow).toContain("bun run gate:coverage")
  expect(workflow).toContain("bun run gate:pack")
  expect(workflow).toContain("bun run audit:harness")
})
