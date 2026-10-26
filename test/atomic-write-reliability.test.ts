// Reliability atomic-write (Agent B track independen, 2026-10-22).
//
// Gap yang ditutup: `atomicWriteText` menelan error `mkdir` lewat
// `.catch(() => {})`, sehingga yang sampai ke pemanggil hanyalah gejala
// `open()` berikutnya ("ENOENT: no such file or directory") — bukan akar
// masalahnya. Untuk path yang induknya adalah FILE biasa, `mkdir` gagal
// dengan EEXIST sementara `open()` gagal dengan ENOENT/ENOTDIR. Pemanggil
// lalu diberi tahu "direktori tidak ada" padahal direktori itu ADA dan
// memang tidak bisa dibuat — diagnosis yang menyesatkan, dan hilang
// sepenuhnya.
//
// Uji ini sengaja memakai kegagalan filesystem yang DETERMINISTIK dan
// portabel (bukan permission test): sebuah file biasa menempati path yang
// seharusnya direktori. Tidak bergantung privilege, umask, quota, atau
// filesystem jaringan — dan perilakunya sama di POSIX maupun Windows.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicWriteText } from "../src/lib/atomic-write.ts"

describe("atomicWriteText — kegagalan pembuatan direktori induk", () => {
  test("menyurface akar masalah (mkdir), bukan gejala open() yang menyesatkan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-aw-"))
    try {
      // FILE biasa di tempat yang harusnya direktori → mkdir gagal EEXIST.
      const occupied = join(dir, "occupied")
      await writeFile(occupied, "bukan direktori")
      const target = join(occupied, "child.txt")

      const err = await atomicWriteText(target, "data").then(
        () => undefined,
        (e: unknown) => e,
      )

      // Gagal menulis — dari luar, ini tetap sebuah kegagalan.
      expect(err).toBeInstanceOf(Error)

      // Akar masalah: path itu sudah dipakai FILE, jadi direktori tak bisa
      // dibuat.Pra-sebelumnya yang muncul adalah ENOENT/ENOTDIR dari open()
      // — kode yang tidak pernah terjadi di sini dan menyesatkan.
      expect((err as NodeJS.ErrnoException).code).toBe("EEXIST")

      // Gejala open() tetap tersimpan sebagai `cause` supaya diagnosa
      // lengkap: akar masalah + gejala hilir tidak saling menimpa.
      const cause = (err as { cause?: NodeJS.ErrnoException }).cause
      const causeCode = (cause as NodeJS.ErrnoException | undefined)?.code
      expect(causeCode).toBeDefined()
      expect(["ENOENT", "ENOTDIR"]).toContain(String(causeCode))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("gagal tanpa meninggalkan berkas .tmp. di direktori kerja", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-aw-"))
    try {
      const occupied = join(dir, "occupied")
      await writeFile(occupied, "bukan direktori")
      const target = join(occupied, "child.txt")

      await expect(atomicWriteText(target, "data")).rejects.toBeInstanceOf(Error)

      // open() gagal sebelum sempat membuat berkas tmp, jadi tak ada sisa
      // yang perlu dibersihkan — dan tidak boleh ada.
      const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp."))
      expect(leftovers).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
