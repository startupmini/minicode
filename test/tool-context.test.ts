import { describe, expect, test } from "bun:test"
import { requireToolCwd } from "../src/tools/context.ts"

describe("tool workspace context", () => {
  test("uses only the runtime-provided workspace root", () => {
    expect(requireToolCwd({ cwd: "C:\\workspace\\project" })).toBe("C:\\workspace\\project")
  })

  test("missing or empty root fails closed instead of falling back to process cwd", () => {
    expect(() => requireToolCwd({})).toThrow("ToolContext.cwd is required")
    expect(() => requireToolCwd({ cwd: "" })).toThrow("ToolContext.cwd is required")
  })
})
