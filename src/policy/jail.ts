import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"

// Satu sumber untuk aturan sandbox path — dipakai permission layer + setiap tool
// (defense-in-depth). File kredensial / direktori toolchain dianggap sensitif.
//
// Semua alternatif ter-anchor ke batas segmen (awal string atau setelah / \)
// dan bila relevan akhir path. Ini menutup bug operator-precedence lama di mana
// `node_modules` dan ekstensi `.pem/.key/.p12` match di mana saja tanpa anchor.
export const SENSITIVE_RE =
  /(?:^|[/\\])(?:\.env(?:\.[a-z0-9_.-]+)?(?:[/\\]|$)|\.git[/\\](?:config|credentials)(?:[/\\]|$)|\.git-credentials$|\.npmrc(?:\.[a-z0-9_-]+)?(?:[/\\]|$)|\.netrc(?:\.[a-z0-9_-]+)?(?:[/\\]|$)|\.ssh(?:[/\\]|$)|\.aws(?:[/\\]|$)|\.kube(?:[/\\]|$)|\.docker[/\\]config\.json$|id_(?:rsa|ecdsa|ed25519|dsa)(?:\.(?:pub|ppk))?$|credentials\.json$|\.minicode[/\\]auth\.json$|secrets?\.(?:yaml|yml|json)$|terraform(?:\.[a-z0-9_-]+)*\.tfvars$|node_modules(?:[/\\]|$)|system32[/\\]config[/\\](?:sam|system|security|software|default)(?:[/\\]|$)|ntds\.dit$)|\.(?:pem|key|p12|pfx|jks|keystore)$/i

export function isSensitive(p: string): boolean {
  return SENSITIVE_RE.test(p)
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
// Pengecualian: skrip hooks milik user (.minicode/hooks/, lihat HOOKS_RE)
// dan restore dari `.minicode/.trash/` (ditangani di permission.ts, bukan
// di sini, agar arahnya eksplisit).
const OWNED_STATE_RE = /(?:^|[/\\])\.minicode(?:[/\\]|$)/i

// Skrip hooks milik user (.minicode/hooks/): BUKAN state runtime — alur
// legit "buatkan hook" menulis lewat tool (dikunci test delegate-audit).
// Registrasi eksekusi tetap dikunci (allowlist.json owned), jadi file
// titipan tak jalan sendiri. skills//steering/MEMORY tetap terkunci:
// isinya ikut ke konteks (persistensi prompt-injection), user kelola via shell.
const HOOKS_RE = /(?:^|[/\\])\.minicode[/\\]hooks(?:[/\\]|$)/i

export function isOwnedState(p: string): boolean {
  return OWNED_STATE_RE.test(p) && !HOOKS_RE.test(p)
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
  try {
    const real = realpathSync(abs)
    const realRoot = realpathSync(resolve(root))
    return isPathOutsideRoot(real, realRoot)
  } catch {
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
