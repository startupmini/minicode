// glob — pola rekursif `**/` (Agent B track, 2026-10-22).
//
// Bug: `globToRegExp` menyuntik fragmen rekursif `(.*/)?` ke dalam string
// regex, lalu Subtstitusi berikutnya (`*`→`[^/]*`, `?`→`.`) menulis ULANG
// fragmen itu. Hasilnya `(.[^/]*\/)` — grup WAJIB yang butuh satu karakter
// tambahan. Akibatnya `**/*.ts` tak lagi cocok file di root maupun direktori
// depth >= 2, dan `src/**/*.ts` tak lagi cocok file yang langsung di `src/`.
// Pola `**/*.ts` justru contoh yang tertulis di deskripsi tool.
//
// Test lama (`test/tools.test.ts`) hanya membuat file satu tingkat (`sub/x.ts`)
// — persis kedalaman yang masih cocok dengan regex rusak — sehingga cacat ini
// tak pernah terlihat. Test ini menutup kedua celah: unit `globToRegExp` dan
// end-to-end tool dengan fixture bersarang.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { globTool, globToRegExp } from "../src/tools/glob.ts"

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "mc-glob-"))
  roots.push(root)
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(join(root, "src", "deep"), { recursive: true })
  mkdirSync(join(root, "src", "deep", "deeper"), { recursive: true })
  writeFileSync(join(root, "root.ts"), "x")
  writeFileSync(join(root, "src", "one.ts"), "x")
  writeFileSync(join(root, "src", "deep", "two.ts"), "x")
  writeFileSync(join(root, "src", "deep", "deeper", "three.ts"), "x")
  writeFileSync(join(root, "src", "skip.js"), "x")
  return root
}

describe("globToRegExp — pola rekursif", () => {
  test("**/ cocok file di root dan di semua kedalaman", () => {
    const re = globToRegExp("**/*.ts")
    for (const p of ["root.ts", "src/one.ts", "src/deep/two.ts", "src/deep/deeper/three.ts"]) {
      expect(re.test(p), p).toBe(true)
    }
    expect(re.test("src/skip.js")).toBe(false)
    // `**/` = nol atau lebih direktori: `src/deep/../x` bukan hasil glob.
    expect(re.test("src/one.js")).toBe(false)
  })

  test("prefix + **/ tetap cocok file langsung di prefix", () => {
    const re = globToRegExp("src/**/*.ts")
    expect(re.test("src/one.ts")).toBe(true)
    expect(re.test("src/deep/two.ts")).toBe(true)
    expect(re.test("src/deep/deeper/three.ts")).toBe(true)
    // Di luar prefix tetap tidak cocok.
    expect(re.test("root.ts")).toBe(false)
    expect(re.test("other/one.ts")).toBe(false)
  })

  test("** tanpa garis miring cocok seluruh kedalaman", () => {
    const re = globToRegExp("**")
    expect(re.test("a")).toBe(true)
    expect(re.test("a/b/c.txt")).toBe(true)
  })

  test("pola biasa tidak berubah: * dan ? tetap satu tingkat", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true)
    expect(globToRegExp("*.ts").test("x/a.ts")).toBe(false)
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true)
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false)
    expect(globToRegExp("?.ts").test("a.ts")).toBe(true)
    expect(globToRegExp("?.ts").test("ab.ts")).toBe(false)
  })

  test("brace expansion tetap bekerja dan tak dirusak fragmen rekursif", () => {
    const re = globToRegExp("src/{a,b}/*.ts")
    expect(re.test("src/a/x.ts")).toBe(true)
    expect(re.test("src/b/x.ts")).toBe(true)
    expect(re.test("src/c/x.ts")).toBe(false)
  })

  test("fragmen rekursif tak dimakan substitusi * dan ? (guard regresi)", () => {
    // Fragmen yang benar adalah grup OPSIONAL. Kalau terpasang sebelum
    // substitusi `*`/`?`, hasilnya jadi grup WAJIB — bug yang dikembalikan.
    // Catatan: `.source` meng-escape `/` jadi `\/`.
    const src = globToRegExp("**/*.ts").source
    expect(src).toContain("(?:.*\\/)")
    expect(src).not.toContain("(.[^/]*\\/)")
  })
})

describe("glob tool — hasil rekursif", () => {
  // Sesi di-root-kan ke fixture sendiri: parameter `cwd` tool relatif
  // terhadap cwd sesi, dan jail tool menolak path di luar workspace sesi.
  // Bentuk ctx mengikuti pemakaian tool di repo (lihat test/tools.test.ts).
  function session(root: string): any {
    return { signal: new AbortController().signal, cwd: root }
  }

  test("**/*.ts menemukan file di root DAN semua kedalaman", async () => {
    const root = makeTree()
    const out = String(await globTool.execute({ pattern: "**/*.ts" }, session(root)))
    const lines = out.split("\n").filter(Boolean)
    expect(lines).toContain("root.ts")
    expect(lines).toContain("src/one.ts")
    expect(lines).toContain("src/deep/two.ts")
    expect(lines).toContain("src/deep/deeper/three.ts")
    expect(lines).not.toContain("src/skip.js")
    expect(lines.length).toBe(4)
  })

  test("src/**/*.ts menemukan file di src dan di bawahnya", async () => {
    const root = makeTree()
    const out = String(await globTool.execute({ pattern: "src/**/*.ts" }, session(root)))
    const lines = out.split("\n").filter(Boolean)
    expect(lines).toContain("src/one.ts")
    expect(lines).toContain("src/deep/two.ts")
    expect(lines).toContain("src/deep/deeper/three.ts")
    expect(lines).not.toContain("root.ts")
    expect(lines.length).toBe(3)
  })
})
