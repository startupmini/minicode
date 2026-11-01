// Portabilitas nama yang dihasilkan sanitizer identitas sesi.
//
// Defect: `sanitizeSessionPart` memotong id ke 60 karakter SETELAH stripping
// titik/dash di ujung. Pemotongan bisa menyisakan titik di akhir
// ("a"x59 + ".b" → "a"x59 + "."). Nama yang berakhir titik tidak portabel di
// Windows: API path klasik (cmd, .NET, Explorer) menghapus titiknya, sehingga
// nama tersebut tak terlihat dan tak bisa dihapus lewat jalur itu — sementara
// Node/Bun (prefix `\\?\`) tetap membuatnya. Git juga menolak nama ref yang
// berakhir titik.
//
// Kontrak yang dipertahankan: id NORMAL (≤60 karakter, tanpa titik/dash di
// ujung) dipetakan IDENTIK — tidak ada migrasi id yang sudah ada.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sanitizeSessionPart } from "../src/lib/session-id.ts"

describe("portabilitas nama sesi", () => {
  test("hasil sanitasi tak pernah berakhir dengan titik (potong 60 karakter)", () => {
    // Titik jatuh persis di posisi ke-60 → hasil potongannya berakhir titik.
    const id = `${"x".repeat(59)}.y`
    const out = sanitizeSessionPart(id)
    expect(out.endsWith(".")).toBe(false)
    expect(out.endsWith("-")).toBe(false)
    // Panjang tetap ≤ 60 dan isinya tak berubah selain stripping ujung.
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out).toBe("x".repeat(59))
  })

  test("hasil sanitasi tak pernah berakhir dengan titik atau dash untuk banyak id", () => {
    for (let n = 1; n <= 60; n++) {
      for (const tail of [".", "-", ".y", "-y", "..", "--"]) {
        const out = sanitizeSessionPart("x".repeat(n) + tail)
        expect(out.endsWith(".")).toBe(false)
        expect(out.endsWith("-")).toBe(false)
        expect(out.length).toBeGreaterThan(0)
        expect(out.length).toBeLessThanOrEqual(60)
      }
    }
  })

  test("nama yang dihasilkan bisa dibuat & dilihat lewat API path klasik", () => {
    // Nama ending-dot di Windows: Node/Bun (prefix `\\?\`) membuatnya, tapi
    // API klasik (Test-Path/cmd) tak melihatnya dan tak bisa menghapusnya.
    // Setelah fix, nama hasil sanitasi aman untuk kedua jalur.
    const dir = mkdtempSync(join(tmpdir(), "mc-sidname-"))
    try {
      const name = sanitizeSessionPart(`${"x".repeat(59)}.y`)
      mkdirSync(join(dir, name))
      expect(readdirSync(dir)).toEqual([name])
      expect(name.endsWith(".")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("id normal tetap dipetakan identik (tanpa migrasi)", () => {
    for (const id of ["sess-1", "sub_ab12cd34", "a1b2c3d4", "test-cp-sess", "a.b", "x_y-z.9"]) {
      expect(sanitizeSessionPart(id)).toBe(id)
    }
  })

  test("sanitasi tetap idempoten dan stabil", () => {
    for (const raw of ["", "...", ".foo", "a/b", "x".repeat(100), `${"x".repeat(59)}.y`]) {
      const once = sanitizeSessionPart(raw)
      expect(sanitizeSessionPart(once)).toBe(once)
    }
  })

  test("kapasitas 60 karakter tetap berlaku", () => {
    expect(sanitizeSessionPart("x".repeat(100)).length).toBe(60)
  })
})
