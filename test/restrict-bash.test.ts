// restrictBash: lapis kapabilitas bash TERPISAH dari mode permission (auto/ask).
// Fallback "no-sandbox" (Windows) yang dulu diselipkan sebagai mode "allowlist"
// kini murni flag — permission mode tetap auto, bash tetap dibatasi allow-list.
import { expect, test } from "bun:test"
import type { ToolCall } from "#minicore"
import { createPermissionHandler } from "../src/policy/permission.ts"

function bash(cmd: string): ToolCall {
  return { name: "bash", args: { cmd } } as unknown as ToolCall
}

async function decide(mode: "auto" | "ask", restrictBash: boolean | undefined, cmd: string) {
  const h = createPermissionHandler({ mode, restrictBash, root: "/" })
  return h.check(bash(cmd), {} as never)
}

test("auto + restrictBash: bash diluar allow-list ditolak; dalam allow-list lolos", async () => {
  expect(await decide("auto", true, "git status")).toBe("allow")
  expect(await decide("auto", true, "git push --force origin main")).toBe("deny")
})

test("auto tanpa restrictBash: bash bebas (kecuali bash-guard)", async () => {
  expect(await decide("auto", false, "git push --force origin main")).toBe("allow")
  expect(await decide("auto", undefined, "git push --force origin main")).toBe("allow")
})

test("bash-guard tetap berlaku di kedua kondisi", async () => {
  expect(await decide("auto", true, "rm -rf /")).toBe("deny")
  expect(await decide("auto", false, "rm -rf /")).toBe("deny")
})

test("__getRestrictBash mencerminkan flag", () => {
  const on = createPermissionHandler({ mode: "auto", restrictBash: true }) as never as {
    __getRestrictBash(): boolean
  }
  const off = createPermissionHandler({ mode: "auto" }) as never as {
    __getRestrictBash(): boolean
  }
  expect(on.__getRestrictBash()).toBe(true)
  expect(off.__getRestrictBash()).toBe(false)
})
