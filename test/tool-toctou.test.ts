import { expect, test } from "bun:test"
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileTool } from "../src/tools/read_file.ts"

// DoD P10 P0.2: swapper latar membalik symlink inside↔outside; tidak satu pun
// baca boleh mengembalikan konten luar. Di Windows pembuatan symlink butuh
// privilege (EPERM) — seluruh file ini skip di sana; klaim "0 lolos" sah di
// POSIX (lihat safe-open.ts). Tanpa O_NOFOLLOW pola lama
// (realpath→readFile terpisah) kalah race ≥1× di 3000 iterasi.

function symlinkPrivilege(): boolean {
  const d = mkdtempSync(join(tmpdir(), "toctou-priv-"))
  try {
    writeFileSync(join(d, "t.txt"), "x")
    symlinkSync(join(d, "t.txt"), join(d, "l.txt"))
    unlinkSync(join(d, "l.txt"))
    return true
  } catch {
    return false
  } finally {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
}

const canSymlink = symlinkPrivilege()
const it = canSymlink ? test : test.skip

const mkctx = (cwd: string) => ({ cwd, signal: new AbortController().signal }) as never

it("toctou: symlink internal tetap terbaca (target terverifikasi yang dibuka)", async () => {
  const w = mkdtempSync(join(tmpdir(), "toctou-in-"))
  try {
    mkdirSync(join(w, ".minicode"), { recursive: true })
    writeFileSync(join(w, "target.txt"), "SAFE-CONTENT")
    symlinkSync(join(w, "target.txt"), join(w, "link.txt"))
    const r = (await readFileTool.execute({ path: "link.txt" }, mkctx(w))) as string
    expect(r).toContain("SAFE-CONTENT")
  } finally {
    try {
      rmSync(w, { recursive: true, force: true })
    } catch {}
  }
})

it("toctou: symlink ke luar workspace ditolak, tak pernah bocor", async () => {
  const w = mkdtempSync(join(tmpdir(), "toctou-out-"))
  const o = mkdtempSync(join(tmpdir(), "toctou-sec-"))
  try {
    mkdirSync(join(w, ".minicode"), { recursive: true })
    writeFileSync(join(w, "target.txt"), "SAFE-CONTENT")
    writeFileSync(join(o, "secret.txt"), "SECRET-CONTENT")
    symlinkSync(join(o, "secret.txt"), join(w, "link.txt"))
    let leaked = false
    try {
      const r = (await readFileTool.execute({ path: "link.txt" }, mkctx(w))) as string
      if (r.includes("SECRET-CONTENT")) leaked = true
    } catch {
      // ditolak = benar
    }
    expect(leaked).toBe(false)
  } finally {
    try {
      rmSync(w, { recursive: true, force: true })
      rmSync(o, { recursive: true, force: true })
    } catch {}
  }
})

it("toctou: swapper 1000× inside↔outside, 0 lolos", async () => {
  const w = mkdtempSync(join(tmpdir(), "toctou-swap-"))
  const o = mkdtempSync(join(tmpdir(), "toctou-swapout-"))
  const link = join(w, "link.txt")
  try {
    mkdirSync(join(w, ".minicode"), { recursive: true })
    writeFileSync(join(w, "target.txt"), "SAFE-CONTENT")
    writeFileSync(join(o, "secret.txt"), "SECRET-CONTENT")
    let stop = false
    let toInside = true
    const swapper = (async () => {
      while (!stop) {
        try {
          unlinkSync(link)
        } catch {}
        try {
          symlinkSync(toInside ? join(w, "target.txt") : join(o, "secret.txt"), link)
        } catch {}
        toInside = !toInside
        // WAJIB yield: tanpa ini loop sinkron tak pernah melepas event loop
        // sehingga pembaca tak pernah jalan dan test gantung selamanya
        // (ditemukan saat run POSIX nyata pertama di WSL — klaim "0 lolos"
        // sebelumnya tak pernah tervalidasi karena hang, bukan pass).
        await new Promise<void>((r) => setImmediate(r))
      }
    })()
    let leaks = 0
    const N = 1000
    for (let i = 0; i < N; i++) {
      try {
        const r = (await readFileTool.execute({ path: "link.txt" }, mkctx(w))) as string
        if (r.includes("SECRET-CONTENT")) leaks++
      } catch {
        // deny/not-found/ELOOP semua sah — yang dilarang hanya bocor
      }
    }
    stop = true
    await swapper.catch(() => {})
    expect(leaks).toBe(0)
  } finally {
    try {
      rmSync(w, { recursive: true, force: true })
      rmSync(o, { recursive: true, force: true })
    } catch {}
  }
})

// Hardlink tak terlihat oleh realpath (semua nama setara) — baca via hardlink
// = baca konten luar. Berbeda dari symlink, mklink /H jalan di Windows TANPA
// privilege, jadi test ini TIDAK di-skip di sana. Skip anggun hanya bila FS
// tak mendukung hardlink (beda volume/FAT).

function hardlinkSupport(): boolean {
  const d = mkdtempSync(join(tmpdir(), "hl-priv-"))
  try {
    writeFileSync(join(d, "t.txt"), "x")
    linkSync(join(d, "t.txt"), join(d, "l.txt"))
    unlinkSync(join(d, "l.txt"))
    return true
  } catch {
    return false
  } finally {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
}

const canHardlink = hardlinkSupport()
const hit = canHardlink ? test : test.skip

hit("hardlink: baca via hardlink ke luar workspace ditolak (nlink>1)", async () => {
  const w = mkdtempSync(join(tmpdir(), "hl-w-"))
  const o = mkdtempSync(join(tmpdir(), "hl-o-"))
  try {
    mkdirSync(join(w, ".minicode"), { recursive: true })
    writeFileSync(join(o, "secret.txt"), "SECRET-CONTENT")
    linkSync(join(o, "secret.txt"), join(w, "link.txt"))
    let leaked = false
    try {
      const r = (await readFileTool.execute({ path: "link.txt" }, mkctx(w))) as string
      if (r.includes("SECRET-CONTENT")) leaked = true
    } catch (e) {
      expect(String(e)).toMatch(/hardlink/)
    }
    expect(leaked).toBe(false)
  } finally {
    try {
      rmSync(w, { recursive: true, force: true })
      rmSync(o, { recursive: true, force: true })
    } catch {}
  }
})

hit("hardlink: berkas normal (nlink=1) tetap terbaca", async () => {
  const w = mkdtempSync(join(tmpdir(), "hl-ok-"))
  try {
    mkdirSync(join(w, ".minicode"), { recursive: true })
    writeFileSync(join(w, "a.txt"), "SAFE-CONTENT")
    const r = (await readFileTool.execute({ path: "a.txt" }, mkctx(w))) as string
    expect(r).toContain("SAFE-CONTENT")
  } finally {
    try {
      rmSync(w, { recursive: true, force: true })
    } catch {}
  }
})
