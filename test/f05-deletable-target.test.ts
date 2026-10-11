// F-05 (P5 §C3 acceptance #5) — Suite unit kontrak `assertDeletableTarget`.
//
// Menguji ELEVEN check fail-closed yang terdokumentasi di JSDoc
// src/lib/safe-open.ts:187-193 secara berurutan, ditambah kasus diterima yang
// diizinkan kontrak. Keputusan panggilan produksi: cleanup sesi
// (src/session/persistence.ts:3370 — hapus `.minicode/checkpoints/<sid>`,
// recursive, best-effort catch→null).
//
// Catatan Bayangan (dokumentasi, bukan perubahan kontrak): check 9 ( kedalaman
// recursive) dan check 11 (workspace root) tak pernah menyala sendiri —
// syaratnya tercakup lebih dulu oleh check 5/6 (scope root), 8 (di luar
// root), dan 10 (ancestor). Test untuk kelas target itu mengunci JAMINAN
// (penolakan), bukan pesan check yang tertimpa.
//
// Semua fixture di isolated mkdtemp di bawah os.tmpdir(); cleanup hanya
// menyentuh fixture itu sendiri. Setiap penolakan diklasifikasi: Error dengan
// prefiks `delete: ` (taxonomy kontrak) — bukan exception kebetulan.
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, parse, resolve } from "node:path"
import { assertDeletableTarget } from "../src/lib/safe-open.ts"

const OPTS_R = { recursive: true } as const
const OPTS_F = { recursive: false } as const

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "minicode-f05-"))
}

function canSymlink(): boolean {
  const d = makeRoot()
  try {
    writeFileSync(join(d, "t.txt"), "x")
    symlinkSync(join(d, "t.txt"), join(d, "l.txt"))
    return true
  } catch {
    return false
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}

/** Penolakan kontrak: Error + prefiks `delete: ` + memo tertentu. */
async function expectRejected(run: Promise<string>, needle: string): Promise<void> {
  let msg = ""
  let isErr = false
  try {
    await run
  } catch (e) {
    isErr = e instanceof Error
    msg = (e as Error).message ?? String(e)
  }
  expect(isErr).toBe(true)
  expect(msg.startsWith("delete: ")).toBe(true)
  expect(msg).toContain(needle)
}

test("check 1: input bukan string non-kosong → invalid target", async () => {
  const root = makeRoot()
  try {
    const scope = { root }
    await expectRejected(
      assertDeletableTarget(null as never, scope, OPTS_F),
      "delete: invalid target",
    )
    await expectRejected(
      assertDeletableTarget(42 as never, scope, OPTS_F),
      "delete: invalid target",
    )
    await expectRejected(assertDeletableTarget("", scope, OPTS_F), "delete: invalid target")
    await expectRejected(assertDeletableTarget("   ", scope, OPTS_F), "delete: invalid target")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("check 2: '.' dan '..' (termasuk dengan spasi) → ambiguous target", async () => {
  const root = makeRoot()
  try {
    const scope = { root }
    await expectRejected(assertDeletableTarget(".", scope, OPTS_F), "ambiguous target: .")
    await expectRejected(assertDeletableTarget("..", scope, OPTS_F), "ambiguous target: ..")
    await expectRejected(assertDeletableTarget("  ..  ", scope, OPTS_F), "ambiguous target: ..")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("check 3: drive/FS root ditolak (jaminan), pesan check spesifik di POSIX", async () => {
  const root = makeRoot()
  try {
    const fsRoot = parse(resolve("/")).root
    // Bun Windows: realpath() membuang trailing separator dari drive root
    // ("D:\\" → "D:"), lalu resolve("D:") berarti "cwd di drive itu" — jadi
    // check 3 (isRootLike) tak pernah menyala; root DITOLAK oleh check 7
    // (same-drive, accidental) atau check 8 (other-drive, resolve("C:")
    // bahkan menghasilkan garbage "C:\\C" — semuanya tetap ditolak).
    // Jaminan "tak pernah menghapus drive root" terkunci di sini; pesan
    // `refusing filesystem root` hanya dijamin di POSIX. (Tidak diubah di
    // produksi: fail-closed utuh, cacatnya diagnostik/urutan.)
    const expectRefusal = process.platform === "win32" ? undefined : "refusing filesystem root"
    if (expectRefusal) {
      await expectRejected(assertDeletableTarget(fsRoot, { root }, OPTS_R), expectRefusal)
    } else {
      // Windows: cukup klasifikasi kontrak — Error `delete: `, tidak lolos.
      let msg = ""
      try {
        await assertDeletableTarget(fsRoot, { root }, OPTS_R)
      } catch (e) {
        msg = (e as Error).message ?? String(e)
      }
      expect(msg.startsWith("delete: ")).toBe(true)
    }
    // Varian ".." yang dilaundering kembali ke identitas root yang sama
    // (resolve menormalkan, hasilnya fsRoot kembali).
    await expectRejected(
      assertDeletableTarget(resolve(fsRoot, "anak", ".."), { root }, OPTS_R),
      process.platform === "win32" ? "delete: " : "refusing filesystem root",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("check 4: home dan tmpdir sendiri → refusing protected path", async () => {
  const root = makeRoot()
  try {
    await expectRejected(
      assertDeletableTarget(homedir(), { root }, OPTS_R),
      "refusing protected path",
    )
    await expectRejected(
      assertDeletableTarget(tmpdir(), { root }, OPTS_R),
      "refusing protected path",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("check 5/6: target == scope root (recursive & non-recursive) → refusing scope root", async () => {
  const root = makeRoot()
  try {
    await expectRejected(assertDeletableTarget(root, { root }, OPTS_R), "refusing scope root")
    await expectRejected(assertDeletableTarget(root, { root }, OPTS_F), "refusing scope root")
    // Varian symlink menuju root scope yang sama — kanonikalisasi menemukan
    // identitas nyata, check tetap menolak.
    if (canSymlink()) {
      const link = join(root, "ke-root")
      symlinkSync(root, link)
      await expectRejected(assertDeletableTarget(link, { root }, OPTS_R), "refusing scope root")
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("check 7: target == process.cwd() (di dalam scope) → refusing process.cwd()", async () => {
  const root = makeRoot()
  const sub = join(root, "kerja")
  mkdirSync(sub)
  const prev = process.cwd()
  try {
    process.chdir(sub)
    await expectRejected(assertDeletableTarget(sub, { root }, OPTS_R), "refusing process.cwd()")
  } finally {
    process.chdir(prev)
    rmSync(root, { recursive: true, force: true })
  }
})

test("check 8: di luar allowed root — tetangga & target hilang di luar", async () => {
  const root = makeRoot()
  const outside = makeRoot()
  try {
    writeFileSync(join(outside, "korban.txt"), "x")
    await expectRejected(
      assertDeletableTarget(join(outside, "korban.txt"), { root }, OPTS_F),
      "target outside allowed root",
    )
    // Target yang TIDAK ADA di luar root tetap ditolak (tak ada "rm -f aman").
    await expectRejected(
      assertDeletableTarget(join(outside, "belum-ada.txt"), { root }, OPTS_F),
      "target outside allowed root",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("jaminan check 9: recursive tak pernah menghapus root scope (tertimpa check 5)", async () => {
  // Check 9 (kedalaman recursive) tak pernah menyala sendiri: begitu lolos
  // check 5/6/8, target pasti descendant dengan kedalaman lebih dalam.
  // Jaminan yang ia encoding tetap dikunci lewat penolakan root recursive.
  const root = makeRoot()
  try {
    await expectRejected(assertDeletableTarget(root, { root }, OPTS_R), "refusing scope root")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("jaminan check 10: ancestor scope ditolak (tertimpa check 8)", async () => {
  // Leluhur scope SELALU "outside root" bagi isPathOutsideRoot — check 8
  // menyala lebih dulu; jaminan "tak ada hapus leluhur" tetap terkunci.
  const base = makeRoot()
  const root = join(base, "ws")
  mkdirSync(root)
  try {
    await expectRejected(
      assertDeletableTarget(base, { root }, OPTS_R),
      "target outside allowed root",
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("jaminan check 11: workspace root (ber-.git) tetap ditolak (tertimpa check 5)", async () => {
  // Check 11 (real===realRoot || rel==="") tak pernah menyala sendiri —
  // kedua kondisinya sudah dilempar check 5/6 dan 10. Jaminan "tak pernah
  // menghapus workspace root" dikunci lewat penolakan yang sama.
  const root = makeRoot()
  try {
    mkdirSync(join(root, ".git"))
    await expectRejected(assertDeletableTarget(root, { root }, OPTS_R), "refusing scope root")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("symlink escape: link di dalam root menunjuk keluar → ditolak outside root", async () => {
  if (!canSymlink()) return
  const root = makeRoot()
  const outside = makeRoot()
  try {
    writeFileSync(join(outside, "target.txt"), "x")
    const link = join(root, "keluar")
    symlinkSync(join(outside, "target.txt"), link)
    await expectRejected(
      assertDeletableTarget(link, { root }, OPTS_F),
      "target outside allowed root",
    )
    // Link direktori ke luar root: recursive pun ditolak (laundering tertutup).
    const linkDir = join(root, "keluar-dir")
    symlinkSync(outside, linkDir)
    await expectRejected(
      assertDeletableTarget(linkDir, { root }, OPTS_R),
      "target outside allowed root",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("diterima: anak valid recursive (bentuk produksi checkpoints/<sid>) + kanonik", async () => {
  const root = makeRoot()
  try {
    const cp = join(root, ".minicode", "checkpoints", "sid-1")
    mkdirSync(cp, { recursive: true })
    writeFileSync(join(cp, "snap.json"), "{}")
    const got = await assertDeletableTarget(cp, { root }, OPTS_R)
    expect(got).toBe(await realpath(cp))
    // Non-recursive pada file anak juga diterima (kedalaman dicek saat recursive).
    const file = join(cp, "snap.json")
    expect(await assertDeletableTarget(file, { root }, OPTS_F)).toBe(await realpath(file))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("diterima: target hilang DI DALAM root tetap diterima (diserahkan ke rm -f caller)", async () => {
  const root = makeRoot()
  try {
    const missing = join(root, ".minicode", "checkpoints", "tak-ada")
    const got = await assertDeletableTarget(missing, { root }, OPTS_R)
    // Kanonikalisasi jatuh ke realpath ancestor terdekat (root) + sisa ekor.
    expect(got).toBe(join(await realpath(root), ".minicode", "checkpoints", "tak-ada"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("diterima: spasi di ujung di-trim sebelum kanonikalisasi", async () => {
  const root = makeRoot()
  try {
    const dir = join(root, "anak")
    mkdirSync(dir)
    const got = await assertDeletableTarget(`  ${dir}  `, { root }, OPTS_R)
    expect(got).toBe(await realpath(dir))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("batas semantik: path relatif di-resolve terhadap process.cwd(), bukan scope", async () => {
  // Kontrak nyata: target relatif → realpath(relatif) = cwd-relatif. Dengan
  // cwd ≠ scope.root (kondisi test), hasilnya di luar root → ditolak.
  // Pemanggil produksi SELALU mengirim path absolut (join(base, ...)).
  const root = makeRoot()
  try {
    await expectRejected(
      assertDeletableTarget("anak/mana.txt", { root }, OPTS_F),
      "target outside allowed root",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
