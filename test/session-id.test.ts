// Hardening F-17: satu sanitizer identitas sesi untuk checkpoint,
// shadow-git ref, dan journal file — tidak ada lagi tiga pemetaan.
import { expect, test } from "bun:test"
import { basename } from "node:path"
import { sanitizeSessionPart } from "../src/lib/session-id.ts"
import { sanitizeSessionId } from "../src/session/checkpoint.ts"
import { journalPath } from "../src/session/journal.ts"

test("F-17: id normal stabil (migrasi tak mengubah sesi yang ada)", () => {
  for (const id of ["sess-1", "sub_ab12cd34", "a1b2c3d4", "test-cp-sess", "a.b", "x_y-z.9"]) {
    expect(sanitizeSessionPart(id)).toBe(id)
    expect(sanitizeSessionId(id)).toBe(id)
  }
})

test("F-17: id adversarial terpetakan aman + konsisten antar subsistem", () => {
  expect(sanitizeSessionPart("...")).toBe("x")
  expect(sanitizeSessionPart("")).toBe("x")
  expect(sanitizeSessionPart(".foo")).toBe("foo") // bukan direktori hidden
  expect(sanitizeSessionPart("a/b")).toBe("a-b")
  // Id traversal: yang penting SIFATNYA (tanpa /, tanpa .., tanpa leading
  // dot/dash), bukan ejaan tepatnya.
  const adv = sanitizeSessionPart("sess/../..~weird:id")
  expect(adv).not.toContain("/")
  expect(adv).not.toContain("..")
  expect(adv).not.toMatch(/^[.-]/)
  expect(sanitizeSessionPart("x".repeat(100)).length).toBe(60)
  // Konsistensi: checkpoint alias + journal memakai pemetaan yang sama.
  expect(sanitizeSessionId("...")).toBe(sanitizeSessionPart("..."))
  expect(basename(journalPath(".../..", "/tmp/wd"))).toBe(
    `journal-${sanitizeSessionPart(".../..")}.jsonl`,
  )
})
