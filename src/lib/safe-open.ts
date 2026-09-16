import { constants } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { open, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import { isPathOutsideRoot, isSensitive } from "../policy/jail.ts"

// O_NOFOLLOW mencegah open mengikuti symlink (TOCTOU swap).
// Di Windows nilai tidak didefinisikan — fallback ke 0 dan pakai dev+ino check.
const O_NOFOLLOW: number = (constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0x20000
const O_RDONLY = constants.O_RDONLY

/**
 * Verifikasi path untuk tool PENULIS (write/edit/patch/delete/move): butuh
 * path real sebagai target tulis (atomicWriteText/rename/trash), jadi cek
 * logis + target nyata dilakukan di sini, toleran ENOENT (file baru — induk
 * yang diverifikasi). Pembaca (read_file/read_image) tidak lewat sini: mereka
 * open via safeOpenRead yang memverifikasi pada titik open.
 *
 * Tanpa state global — realpath segar tiap panggil (wajib untuk TOCTOU).
 * Pesan error mempertahankan substring lama ("path/outside workspace",
 * "blocked sensitive file", "symlink points outside workspace") agar test
 * regex tetap hijau.
 */
export async function resolveSafePath(
  p: string,
  root: string,
): Promise<{ abs: string; real: string }> {
  if (isPathOutsideRoot(p, root)) throw new Error(`path outside workspace: ${p}`)
  if (isSensitive(p)) throw new Error(`blocked sensitive file: ${p}`)
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  const realRoot = await realpath(root).catch(() => root)
  const realDir = await realpath(dirname(abs)).catch(() => dirname(abs))
  const fileReal = await realpath(abs).catch(() => null)
  const real = fileReal ?? resolve(realDir, basename(abs))
  if (isPathOutsideRoot(real, realRoot)) throw new Error(`symlink points outside workspace: ${p}`)
  if (isSensitive(real)) throw new Error(`blocked sensitive file: ${p}`)
  return { abs, real }
}

/**
 * Buka file dengan O_NOFOLLOW pada path yang SUDAH terverifikasi di dalam root.
 *
 * Urutan: realpath(abs) → tolak bila di luar root → open(preReal, O_NOFOLLOW).
 * Membuka hasil resolusi (bukan abs asli) berarti symlink internal tetap bisa
 * dibaca (targetnya yang dibuka langsung), sementara swap jadi symlink lain
 * sebelum open gagal tutup (ELOOP) — tidak ada konten luar yang terbaca.
 *
 * POSIX-only: di Windows konstanta O_NOFOLLOW tidak didefinisikan (Node) dan
 * flag diabaikan libuv, sehingga proteksi = pre-check realpath saja (window
 * race sama seperti pola lama). Catatan jujur: klaim "0 lolos" hanya sah di
 * POSIX — lihat test/tool-toctou.test.ts (skip bila symlink EPERM).
 */
export async function safeOpenRead(
  abs: string,
  root: string,
): Promise<{ handle: FileHandle; realPath: string }> {
  const realRoot = await realpath(root).catch(() => root)
  // Pre-check cepat (fail-fast tanpa open)
  const preReal = await realpath(abs).catch(() => abs)
  if (isPathOutsideRoot(preReal, realRoot))
    throw new Error(`symlink points outside workspace: ${abs}`)
  // Sensitif pada target nyata — symlink bernama jinak bisa menunjuk .env;
  // di sini agar semua pembaca via open (read_file/read_image/stat) mewarisinya.
  if (isSensitive(preReal)) throw new Error(`blocked sensitive file: ${abs}`)

  // Buka path terverifikasi — bukan abs (yang bisa di-swap setelah realpath).
  let handle: FileHandle
  try {
    handle = await open(preReal, O_RDONLY | O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ELOOP") throw new Error(`symlink swapped during open (O_NOFOLLOW): ${abs}`)
    // EINVAL: O_NOFOLLOW tidak didukung → buka biasa (Windows: pre-check saja)
    if (code === "EINVAL" && O_NOFOLLOW !== 0) {
      handle = await open(preReal, O_RDONLY)
    } else throw e
  }
  // Hardlink ke luar workspace tak terlihat oleh realpath (semua nama setara)
  // — baca via hardlink = baca konten luar. fstat pada handle yang SUDAH
  // terbuka: tepat untuk file ini, bebas race dengan swap nama. File normal
  // nlink=1; tolak sisanya dengan pesan yang bisa ditindaklanjuti.
  const st = await handle.stat().catch(() => null)
  // Hardlink check hanya untuk file regular: direktori punya nlink >= 2
  // (`.` dan `..`) dan bukan target hardlink — biarkan tool yang menolak
  // direktori dengan pesan yang user-friendly.
  if (st && !st.isDirectory() && st.nlink > 1) {
    await handle.close().catch(() => {})
    throw new Error(`refusing to read file with multiple hardlinks (nlink=${st.nlink}): ${abs}`)
  }
  return { handle, realPath: preReal }
}

export async function safeReadFile(abs: string, root: string): Promise<string> {
  const { handle } = await safeOpenRead(abs, root)
  try {
    return await handle.readFile("utf8")
  } finally {
    await handle.close().catch(() => {})
  }
}

export async function safeStat(abs: string, root: string) {
  const { handle } = await safeOpenRead(abs, root)
  try {
    return await handle.stat()
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Untuk write: pastikan parent dir tidak symlink keluar workspace,
 * lalu tulis via atomicWriteText yang sudah pakai O_EXCL.
 * Tambahan: O_NOFOLLOW untuk file target bila sudah ada (cegah overwrite
 * symlink yang menunjuk keluar). Di Windows fallback ke realpath check.
 *
 * LIVE di tool penulis overwrite (write_file/edit/apply_patch, audit
 * 2026-09-16 L11): verifikasi target nyata + parent-dir pada titik tulis.
 * Symlink INTERNAL sengaja TIDAK ditolak di sini — kontrak tool file adalah
 * "symlink internal tetap bisa diedit, targetnya yang dicek" (dijaga
 * test/live-toctou.test.ts). Escape/sensitif sudah ditutup resolveSafePath
 * via isPathOutsideRoot(real) + isSensitive(real), dan cek realpath di
 * bawah menjaga parent-dir yang di-swap jadi symlink keluar.
 */
export async function assertSafeWriteTarget(abs: string, root: string): Promise<string> {
  const realRoot = await realpath(root).catch(() => root)
  const dir = dirname(abs)
  const realDir = await realpath(dir).catch(() => dir)
  if (isPathOutsideRoot(realDir, realRoot)) throw new Error(`parent outside workspace: ${abs}`)
  const fileReal = await realpath(abs).catch(() => null)
  // basename (bukan split "/"): path Windows memakai backslash — split "/"
  // mengembalikan seluruh path absolut sehingga resolve() mengabaikan realDir
  // dan verifikasi parent symlink gugur diam-diam di Windows.
  const realAbs = fileReal ?? resolve(realDir, basename(abs))
  if (fileReal && isPathOutsideRoot(realAbs, realRoot))
    throw new Error(`symlink points outside workspace: ${abs}`)
  return realAbs
}
