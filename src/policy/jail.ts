import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

// Satu sumber untuk aturan sandbox path — dipakai permission layer + setiap tool
// (defense-in-depth). File kredensial / direktori toolchain dianggap sensitif.
//
// Semua alternatif ter-anchor ke batas segmen (awal string atau setelah / \)
// dan bila relevan akhir path. Ini menutup bug operator-precedence lama di mana
// `node_modules` dan ekstensi `.pem/.key/.p12` match di mana saja tanpa anchor.
export const SENSITIVE_RE =
  /(?:^|[/\\])(?:\.env(?:\.[a-z0-9_.-]+)?(?:[/\\]|$)|\.git[/\\](?:config|credentials)(?:[/\\]|$)|\.git-credentials$|\.npmrc(?:\.[a-z0-9_-]+)?(?:[/\\]|$)|\.netrc(?:\.[a-z0-9_-]+)?(?:[/\\]|$)|\.ssh(?:[/\\]|$)|\.aws(?:[/\\]|$)|\.kube(?:[/\\]|$)|\.docker[/\\]config\.json$|id_(?:rsa|ecdsa|ed25519|dsa)(?:\.(?:pub|ppk))?$|credentials\.json$|\.minicode[/\\]auth\.json$|secrets?\.(?:yaml|yml|json)$|terraform(?:\.[a-z0-9_-]+)*\.tfvars$|node_modules(?:[/\\]|$)|system32[/\\]config[/\\](?:sam|system|security|software|default)(?:[/\\]|$)|ntds\.dit$)|\.(?:pem|key|p12|pfx|jks|keystore)$/i

const DOTDOT_SEG_RE = /(?:^|[/\\])\.\.(?:[/\\]|$)/

/**
 * Normalisasi nama segmen untuk pencocokan sensitif/owned-state lintas-OS:
 * kupas NTFS Alternate Data Stream (`:$DATA` dkk.) dan titik/spasi ekor yang
 * diabaikan Win32 pada tiap segmen non-traversal (`.` dan `..` dipertahankan).
 */
function cleanPathForMatch(p: string): string {
  if (!p) return ""
  const withoutAds = p.replace(/(:[a-zA-Z0-9_.$-]+)+$/, (m, _g, offset) => {
    // Jangan kupas drive letter Windows seperti "C:" di awal path
    if (offset === 1 && /^[a-zA-Z]:$/.test(p.slice(0, 2))) return m
    return ""
  })
  return withoutAds
    .split(/([/\\]+)/)
    .map((seg) => {
      if (!seg || /^[/\\]+$/.test(seg) || seg === "." || seg === "..") return seg
      return seg.replace(/[.\s]+$/, "")
    })
    .join("")
}

export function isSensitive(p: string): boolean {
  return SENSITIVE_RE.test(p) || SENSITIVE_RE.test(cleanPathForMatch(p))
}

// State milik minicode sendiri (temuan audit #04, dikeraskan audit #13):
// sesi/DB/jejak/checkpoint/jurnal/todo/rencana/allowlist/config yang dikelola
// tool khusus (bukan file tools). File tool (write/edit/patch/delete/move)
// DILARANG menyentuh apa pun di bawah `.minicode/` — daftar-nama terbukti
// rapuh (kasus nyata: `write_file .minicode/test-write.txt` lolos karena
// namanya tak terdaftar). Kalau tidak, sub-agen (atau prompt-injected call)
// bisa menanam file eksport-mimikri, menimpa todos/rencana, allowlist
// ("always" palsu!), config (server MCP jahat!), atau membutakan recovery.
// BACA tetap boleh (observability/debug). Pola di-anchor ke segmen
// `.minicode/` agar file user bernama mirip di tempat lain tak kena.
// Pengecualian: restore dari `.minicode/.trash/` (ditangani di permission.ts,
// bukan di sini, agar arahnya eksplisit).
//
// `.minicode/hooks/` TIDAK lagi dikecualikan (audit 2026-11-12): hook
// dieksekusi otomatis lewat scan direktori begitu `MINICODE_HOOKS=1`, jadi
// carve-out tulis = model/prompt-injection bisa menanam kode lalu menjalankannya
// di sesi yang sama, di luar permission/jail/sandbox. Skrip hook sekarang
// dibuat operator di luar sesi (shell manual), bukan lewat file tool.
const OWNED_STATE_RE = /(?:^|[/\\])\.minicode(?:[/\\]|$)/i

export function isOwnedState(p: string): boolean {
  if (!p) return false
  const cleaned = cleanPathForMatch(p)
  return OWNED_STATE_RE.test(p) || OWNED_STATE_RE.test(cleaned)
}
/**
 * Kunci realpath untuk owned-state (temuan audit 2026-09-22 F-CRIT): cek
 * string `isOwnedState` dilewati link internal (junction/symlink →
 * `.minicode/`), jadi TARGET NYATA ikut dicek — pola yang sama dengan
 * `isRealPathOutsideRoot` dan TOCTOU pembaca. Best-effort & sinkron (dipakai
 * lapisan permission): kegagalan realpath (mis. target belum ada) jatuh ke
 * bentuk logis (cek string) agar penulisan file baru tetap presisi dan
 * carve-out hooks/trash (yang dicek string di pemanggil) tak berubah arti.
 */
export function isOwnedStateReal(p: string, root: string): boolean {
  if (!p) return false
  // Mundur ke induk terdekat yang ada: realpath penuh bila target ada,
  // realpath induk + sisa-ekor bila berkasnya baru (`.`/`..` ikut
  // ternormalisasi oleh resolve — verifikasi logis tanpa mengandalkan
  // string mentah).
  let probe = isAbsolute(p) ? resolve(p) : resolve(root, p)
  let tail = ""
  for (let i = 0; i < 64; i++) {
    try {
      return isOwnedState(resolve(realpathSync(probe), tail))
    } catch {
      const parent = dirname(probe)
      if (parent === probe) break
      tail = tail ? join(basename(probe), tail) : basename(probe)
      probe = parent
    }
  }
  return isOwnedState(p)
}

/**
 * Restore sah dari soft-delete: sumber di `.minicode/.trash/`, tujuan di
 * luar `.minicode/` (workspace). Satu-satunya arah gerak file tool yang
 * boleh menyentuh state minicode — dipakai carve-out move_file di
 * permission.ts. Tanpa ini kunci penuh mematahkan restore (atau sebaliknya
 * celah bila arahnya dibalik: menanam ke trash = menulis state).
 */
const TRASH_RE = /(?:^|[/\\])\.minicode[/\\]\.trash(?:[/\\]|$)/i

export function isTrashRestore(from: string, to: string): boolean {
  if (!from || !to) return false
  if (DOTDOT_SEG_RE.test(from) || DOTDOT_SEG_RE.test(to)) return false
  return TRASH_RE.test(from) && !isOwnedState(to)
}

export function isPathOutsideRoot(p: string, root: string): boolean {
  if (!p) return false
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  const rel = relative(root, abs)
  if (!rel) return false // same directory
  if (isAbsolute(rel)) return true // different drive on Windows
  return (
    rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel.startsWith("..\\")
  )
}

/**
 * Cek jail berbasis REALPATH — symlink yang menunjuk keluar workspace
 * terdeteksi di sini, bukan hanya di dalam tiap tool (defense-in-depth tetap).
 * Bila path belum ada (ENOENT — mis. write_file file baru), fallback ke cek
 * logis agar kasus penulisan file baru tetap diizinkan.
 */
export function isRealPathOutsideRoot(p: string, root: string): boolean {
  if (!p) return false
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  if (isHardlink(abs)) return true
  if (isSymlink(abs)) {
    try {
      const real = realpathSync(abs)
      const realRoot = realpathSync(resolve(root))
      return isPathOutsideRoot(real, realRoot)
    } catch {
      return true
    }
  }
  try {
    const real = realpathSync(abs)
    const realRoot = realpathSync(resolve(root))
    return isPathOutsideRoot(real, realRoot)
  } catch {
    // Bila berkas/subdirektori belum ada (ENOENT), mundur ke ancestor terdekat
    // yang ada agar symlink pada direktori induk tetap terdeteksi sebelum tulis.
    let probe = dirname(abs)
    let tail = basename(abs)
    for (let i = 0; i < 64; i++) {
      try {
        const realAncestor = realpathSync(probe)
        const realRoot = realpathSync(resolve(root))
        const real = resolve(realAncestor, tail)
        return isPathOutsideRoot(real, realRoot)
      } catch {
        const parent = dirname(probe)
        if (parent === probe) break
        tail = join(basename(probe), tail)
        probe = parent
      }
    }
    return isPathOutsideRoot(p, root)
  }
}

export function isCwdOutsideRoot(cwd: string, root: string): boolean {
  try {
    const realCwd = realpathSync(resolve(root, cwd))
    const realRoot = realpathSync(resolve(root))
    return isPathOutsideRoot(realCwd, realRoot)
  } catch {
    // if realpath fails (ENOENT), fallback to logical check (treated as outside to be safe if non-existent)
    return isPathOutsideRoot(cwd, root)
  }
}

// P0-3: Windows tidak punya O_NOFOLLOW — TOCTOU symlink di Windows hanya
// bisa ditahan via lstat pre-check. Hardlink (nlink>1) juga berbahaya karena
// realpath tak melihatnya (hardlink = nama lain file yang sama).
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

export function isHardlink(p: string): boolean {
  try {
    const s = lstatSync(p)
    // Direktori punya nlink >= 2 di POSIX (entri `.` + tiap subdir) — itu
    // BUKAN hardlink (hardlink direktori tak bisa dibuat user). Tanpa
    // pengecualian ini tiap argumen cwd direktori yang sah ditolak
    // isRealPathOutsideRoot di Linux/macOS, sementara Windows (nlink dir
    // biasanya 1) lolos — bug hanya terlihat di POSIX.
    if (s.isDirectory()) return false
    return ((s as unknown as { nlink?: number }).nlink ?? 1) > 1
  } catch {
    return false
  }
}

export function isDangerousLink(p: string): boolean {
  return isSymlink(p) || isHardlink(p)
}
