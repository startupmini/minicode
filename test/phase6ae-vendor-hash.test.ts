// Test kontrak hash vendor - helper kanonik itu sendiri.
//
// [FASE 6AE] Helper ini diuji langsung, bukan hanya lewat pemanggil. Kalau ia
// diam-diam salah, setiap assertion semantic yang memakainya ikut salah serempak
// dan suite tetap hijau - persis kelas kegagalan yang berulang di fase-fase
// sebelumnya.
//
// Binary diguji dengan SANGAT sengaja: kontrak iniotero umum Promise "semua
// file adalah teks". Byte NUL harus membuat hashing jatuh ke byte mentah.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  looksBinary,
  SHIPPED_EXCLUDE,
  semanticBytes,
  vendorFileHash,
  vendorShippedHash,
} from "./helpers/vendor-hash.ts"

function tree(
  name: string,
  files: Record<string, Buffer | string>,
): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), `6ae-hash-${name}-`))
  for (const [f, body] of Object.entries(files)) {
    const p = join(root, f)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, typeof body === "string" ? Buffer.from(body, "utf8") : body)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe("6AE vendor hash contract - canonical helper", () => {
  // ── EOL: satu-satunya normalisasi yang diizinkan ───────────────────────────
  test("LF and CRLF text hash identically", () => {
    const lf = tree("lf", { "a.ts": "const a = 1\nconst b = 2\n" })
    const crlf = tree("crlf", { "a.ts": "const a = 1\r\nconst b = 2\r\n" })
    try {
      expect(vendorFileHash(crlf.root, ["a.ts"])).toBe(vendorFileHash(lf.root, ["a.ts"]))
    } finally {
      lf.cleanup()
      crlf.cleanup()
    }
  })

  test("a bare-CR source matches its LF twin", () => {
    const lf = tree("lf2", { "a.ts": "x\ny\n" })
    const cr = tree("cr", { "a.ts": "x\ry\r" })
    try {
      expect(vendorFileHash(cr.root, ["a.ts"])).toBe(vendorFileHash(lf.root, ["a.ts"]))
    } finally {
      lf.cleanup()
      cr.cleanup()
    }
  })

  // ── KONTEN: satu karakter pun harus mengubah hash ─────────────────────────
  test("one changed character changes the hash", () => {
    const a = tree("k1", { "a.ts": 'const v = "1.0.0"\n' })
    const b = tree("k2", { "a.ts": 'const v = "1.0.1"\n' })
    try {
      expect(vendorFileHash(b.root, ["a.ts"])).not.toBe(vendorFileHash(a.root, ["a.ts"]))
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  // [DESIGN DECISION] Perubahan pada karakter TERAKHIR. Mutan M2 membuang byte
  // terakhir tiap file, jadi kasus ini yang membunuhnya - dan kasusnya harus
  // eksplisit, karena trim-di-akhir adalahcls trim yang paling mudah luput.
  test("a change in the LAST character changes the hash", () => {
    const a = tree("l1", { "a.ts": "const v = 1" })
    const b = tree("l2", { "a.ts": "const v = 2" })
    try {
      expect(vendorFileHash(b.root, ["a.ts"])).not.toBe(vendorFileHash(a.root, ["a.ts"]))
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  test("indentation is significant", () => {
    const a = tree("i1", { "a.ts": "  const v = 1\n" })
    const b = tree("i2", { "a.ts": "      const v = 1\n" })
    try {
      expect(vendorFileHash(b.root, ["a.ts"])).not.toBe(vendorFileHash(a.root, ["a.ts"]))
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  test("trailing whitespace is significant", () => {
    const a = tree("w1", { "a.ts": "const v = 1\n" })
    const b = tree("w2", { "a.ts": "const v = 1   \n" })
    try {
      expect(vendorFileHash(b.root, ["a.ts"])).not.toBe(vendorFileHash(a.root, ["a.ts"]))
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  test("non-ASCII content is significant and not normalized", () => {
    const a = tree("u1", { "a.ts": 'const s = "nilai"\n' })
    const b = tree("u2", { "a.ts": 'const s = "nilai!"\n' })
    try {
      expect(vendorFileHash(b.root, ["a.ts"])).not.toBe(vendorFileHash(a.root, ["a.ts"]))
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  test("file order and file identity participate in the hash", () => {
    const t = tree("o1", { "a.ts": "a\n", "b.ts": "b\n" })
    try {
      // same bytes, different order -> different hash
      expect(vendorFileHash(t.root, ["a.ts", "b.ts"])).not.toBe(
        vendorFileHash(t.root, ["b.ts", "a.ts"]),
      )
      // and a split name list cannot collide with a single name
      const t2 = tree("o2", { ab: "x\n" })
      const t3 = tree("o3", { a: "x\n", b: "" })
      try {
        expect(vendorFileHash(t2.root, ["ab"])).not.toBe(vendorFileHash(t3.root, ["a", "b"]))
      } finally {
        t2.cleanup()
        t3.cleanup()
      }
    } finally {
      t.cleanup()
    }
  })

  // ── BINER: byte mentah, tanpa normalisasi ─────────────────────────────────
  //
  // [DESIGN DECISION] Dua test, satu untuk deteksi, satu untuk memastikan
  // konsekuensinya. Normalkan biner sebagai UTF-8 = mengganti byte 0x00 jadi
  // U+FFFD dan byte tinggi jadi urutan replacement - hash berubah untuk reasons
  // yang sama sekali tidak ada hubungannya dengan line ending.
  test("NUL bytes mark a payload as binary", () => {
    expect(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))).toBe(true)
    expect(looksBinary(Buffer.from("const a = 1\n", "utf8"))).toBe(false)
    expect(looksBinary(Buffer.from("日本語のテキスト\r\n", "utf8"))).toBe(false)
  })

  test("binary payloads are hashed byte-exactly (CR and NUL preserved)", () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
    expect(looksBinary(bin)).toBe(true)
    const out = semanticBytes(bin)
    expect(out.equals(bin)).toBe(true)
    expect(out.length).toBe(bin.length)
  })

  // [DESIGN DECISION] Dua payload biner dengan satu byte berbeda harus punya
  // hash berbeda. Kalau ini gagal, "normalisasi" sudah merusak data biner.
  test("binary payloads differing in one byte hash differently", () => {
    const a = tree("b1", { "x.bin": Buffer.from([0x00, 0x01, 0x02, 0x0d, 0x0a]) })
    const b = tree("b2", { "x.bin": Buffer.from([0x00, 0x01, 0x02, 0x0d, 0x0a, 0xff]) })
    try {
      expect(vendorFileHash(b.root, ["x.bin"])).not.toBe(vendorFileHash(a.root, ["x.bin"]))
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  // [DESIGN DECISION] NUL di 8000 byte pertama, TIDAK setelahnya - ini batas
  // yang disengaja dari heuristik git, dan ditulis eksplisit supaya tidak
  // diam-diam berubah nanti.
  test("the NUL scan window is the first 8000 bytes, by design", () => {
    const late = Buffer.concat([Buffer.from("a".repeat(8000), "utf8"), Buffer.from([0x00])])
    expect(looksBinary(late)).toBe(false)
    const early = Buffer.concat([Buffer.from("a".repeat(10), "utf8"), Buffer.from([0x00])])
    expect(looksBinary(early)).toBe(true)
  })

  // ── SHIPPED EXCLUDE ───────────────────────────────────────────────────────
  test("the shipped exclude set is exactly the two documented files", () => {
    expect([...SHIPPED_EXCLUDE].sort()).toEqual(["LICENSE", "test/fakes.ts"])
  })

  test("vendorShippedHash excludes exactly those files", () => {
    const t = tree("s1", { "a.ts": "a\n", "test/fakes.ts": "f\n", LICENSE: "l\n" })
    try {
      const all = ["LICENSE", "a.ts", "test/fakes.ts"]
      expect(vendorShippedHash(t.root, all)).toBe(vendorFileHash(t.root, ["a.ts"]))
    } finally {
      t.cleanup()
    }
  })
})
