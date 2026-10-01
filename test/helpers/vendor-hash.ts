// Kontrak hash integritas vendor - SATU-SATUNYA definisi.
//
// [FASE 6AE] Kenapa file ini ada.
//
// Hash integritas vendor dihitung DUA kali di repo ini:
//
//   1. scripts/vendor-minicore.ts  -> menulis & memverifikasi pin VENDOR.md
//   2. test/pack-integrity.test.ts  -> menghitung ULANG pin itu dari tree
//
// Sebelumnya keduanya menduplikasi algoritma yang sama, dan keduanya
// meng-hash byte mentah. Konsekuensinya nyata: pada checkout CRLF, gate (1)
// melaporkan "TIDAK sinkron" sementara gate (2) melaporkan hash tidak cocok -
// dua jawaban berbeda untuk satu kontrak, keduanya salah, dan tidak ada yang
// saling merusak karena tidak ada yang memanggil yang lain.
//
// Dua implementasi dari satu aturan akan menyimpang. Jadi aturannya hidup di
// sini, dan kedua pemanggil membacanya dari sini. Root script, bukan test,
// yang mengimpor ini.
//
// KONTRAK, persis:
//   TEKS  : normalisasi CRLF -> LF lalu CR telanjang -> LF, lalu hash
//   BINER : byte mentah, tanpa normalisasi apa pun
//
// Yang SENGAJA tidak dilakukan: trim whitespace, ubah indentasi, normalkan
// Unicode, sentuh semantik BOM, atau menormalkan biner sebagai UTF-8. Hanya
// representasi line ending.
//
// Invariant:
//   isi identik, beda hanya EOL -> hash SAMA
//   isi beda satu karakter   -> hash BERBEDA
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** NUL di 8000 byte pertama = heuristik git sendiri untuk "ini bukan teks". */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}

/**
 * Byte yang di-hash untuk satu file: representasi semantik untuk teks,
 * byte mentah untuk biner.
 */
export function semanticBytes(buf: Buffer): Buffer {
  if (looksBinary(buf)) return buf
  // CRLF dulu, baru CR telanjang. Urutan ini bukan gaya: kalau dibalik, CR
  // dari CRLF jadi LF sendiri dan LF asli tertinggal sebagai LF kedua.
  return Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8")
}

/**
 * Hash vendor di bawah `root`, untuk `files` yang sudah terurut.
 *
 * Nama file ikut di-hash dengan pemisah NUL, supaya `["ab"]` dan `["a","b"]`
 * tidak bisa menghasilkan hash sama.
 */
export function vendorFileHash(root: string, files: string[]): string {
  const h = createHash("sha256")
  for (const f of files) {
    h.update(f)
    h.update("\0")
    const p = join(root, f)
    h.update(existsSync(p) ? semanticBytes(readFileSync(p)) : Buffer.alloc(0))
    h.update("\0")
  }
  return h.digest("hex").slice(0, 16)
}

/**
 * File yang SENGAJA tidak ikut paket npm (field `files` di package.json).
 *
 * - test/fakes.ts : fixture test, tidak tercantum di `files`
 * - LICENSE       : LICENSE-nya minicode, bukan milik vendor/minicore
 *
 * Karena itu hash N-file tidak bisa direproduksi dari tarball terbit, dan
 * verifikator paket butuh angka kedua yang hanya menghitung file yang benar-
 * benar ikut. Set ini harus SAMA dengan yang dipakai generator.
 */
export const SHIPPED_EXCLUDE: ReadonlySet<string> = new Set(["test/fakes.ts", "LICENSE"])

/** Hash hanya file yang ikut paket - inilah angka "shipped hash" di VENDOR.md. */
export function vendorShippedHash(root: string, files: string[]): string {
  return vendorFileHash(
    root,
    files.filter((f) => !SHIPPED_EXCLUDE.has(f)),
  )
}
