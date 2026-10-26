// Bash guard — bypass jail via target redirect BERKUTIP (Agent B track, 2026-10-22).
//
// Akar masalah: `findRedirectTargets` memindai perintah RAW dan mengekstrak
// kata target apa adanya — tanda kutip ikut terbawa (mis. `"../evil.txt"`).
// Semua pemeriksaan path (isAbsolute / resolve / isSensitive / isOwnedState /
// isRealPathOutsideRoot) lalu dijalankan atas string BERKUTIP itu, padahal
// shell MELARANG kutip sebelum memakai path-nya. Akibatnya ".." di dalam
// kutip bukan segmen path (ia bagian dari satu nama berkas) sehingga jail
// check lolos, sementara shell menulis ke luar workspace.
//
// Bentuk yang bocor: kutip ganda, kutip tunggal, `>>` (append), path absolut,
// path UNC, dan `..` bergaya Windows — plus ekspansi yang tak bisa
// dievaluasi statis ($VAR / ${VAR} / $(...) / backtick / ~).
//
// Semua fixture di sini berada di direktori sementara; tidak ada penulisan
// di luar workspace sintetis itu.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectBashCommand } from "../src/policy/bash-guard.ts"

const created: string[] = []

/** Workspace sintetis: <tmp>/root/ws — target "../x" berarti keluar dari ws. */
function makeWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mc-redirect-")))
  const ws = join(root, "ws")
  mkdirSync(ws, { recursive: true })
  created.push(root)
  return ws
}

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

const ESCAPES: [string, string][] = [
  // [perintah, keterangan]
  ['echo x >"../evil.txt"', "parent, kutip ganda"],
  ["echo x >'../evil.txt'", "parent, kutip tunggal"],
  ['echo x >>"../evil.txt"', "append parent, kutip ganda"],
  ['echo x >"../../evil.txt"', "parent dua tingkat, kutip ganda"],
  ['echo x >"..\\evil.txt"', "parent gaya Windows, kutip ganda"],
  ['echo x >"/etc/passwd"', "path absolut, kutip ganda"],
  ['echo x >"C:\\Windows\\evil.txt"', "path absolut Windows, kutip ganda"],
  ['cat <"../secret.txt"', "redirect baca parent, kutip ganda"],
  // Target BERKUTIP dengan spasi: path shell adalah satu kata, dan ".."
  // di dalamnya tetap di luar workspace.
  ['echo x >"a b/../../x"', "kutip + spasi + parent"],
  // Ekspansi yang tak bisa dievaluasi statis → fail-closed.
  ['echo x >"$HOME/evil.txt"', "ekspansi $VAR"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: string serangan yang diuji guard, bukan template
  ['echo x >"${HOME}/evil.txt"', "ekspansi dollar-brace VAR"],
  ['echo x >"$(pwd)/evil.txt"', "command substitution $() berkutip"],
  ["echo x >$(pwd)/../x", "command substitution $() tanpa kutip"],
  ['echo x >"`pwd`/evil.txt"', "command substitution backtick"],
  ['echo x >"~/evil.txt"', "ekspansi home ~"],
]

const SAFE: [string, string][] = [
  ["echo x > out.txt", "relatif dalam workspace"],
  ['echo x >"out.txt"', "relatif dalam workspace, berkutip"],
  ['echo x >"sub/out.txt"', "subdir dalam workspace"],
  ["echo x >/dev/null", "null sink POSIX"],
  ["echo x >NUL", "null sink Windows"],
  ['echo "a > b"', "operator > DI DALAM kutip — bukan redirect"],
  ["cat << EOF", "heredoc — bukan path"],
  ["cmd 2>&1", "redirect ke fd — bukan path"],
  ["echo done", "tanpa redirect"],
]

describe("bash-guard: target redirect berkutip tak boleh melewati jail", () => {
  test("target kutip yang keluar workspace DITOLAK (dengan cwd)", () => {
    const ws = makeWorkspace()
    for (const [cmd, label] of ESCAPES) {
      const v = inspectBashCommand(cmd, ws)
      expect(v.denied, `${label}: ${cmd} → ${v.reason ?? "ALLOW"}`).toBe(true)
    }
  })

  test("target kutip yang keluar workspace DITOLAK (tanpa cwd, heuristik)", () => {
    for (const [cmd, label] of ESCAPES) {
      const v = inspectBashCommand(cmd)
      expect(v.denied, `${label}: ${cmd} → ${v.reason ?? "ALLOW"}`).toBe(true)
    }
  })

  test("redirect SAH di dalam workspace tetap LOLOS (tanpa over-block)", () => {
    const ws = makeWorkspace()
    for (const [cmd, label] of SAFE) {
      const v = inspectBashCommand(cmd, ws)
      expect(v.denied, `${label}: ${cmd} → ${v.reason ?? "ALLOW"}`).toBe(false)
    }
  })

  test("redirect SAH tetap LOLOS tanpa cwd juga", () => {
    for (const [cmd, label] of SAFE) {
      const v = inspectBashCommand(cmd)
      expect(v.denied, `${label}: ${cmd} → ${v.reason ?? "ALLOW"}`).toBe(false)
    }
  })

  test("bentuk tanpa kutip tetap ditolak seperti sebelumnya (tanpa regresi)", () => {
    const ws = makeWorkspace()
    for (const cmd of [
      "echo test > ..\\escape_probe.txt",
      "echo test > ../escape_probe.txt",
      "cat < ..\\secret.txt",
      "echo x > .env",
    ]) {
      expect(inspectBashCommand(cmd, ws).denied, cmd).toBe(true)
    }
  })

  test("kutip yang TIDAK menutupi path relatif tetap aman (tidak over-block)", () => {
    const ws = makeWorkspace()
    // `..` sebagai AWAL kata yang-di-kutip-pedia tetap di luar → ditolak.
    expect(inspectBashCommand('echo x >".."/evil.txt', ws).denied).toBe(true)
    // Kutip di tengah nama berkas tidak mengubah lokasi path.
    expect(inspectBashCommand('echo x >out"".txt', ws).denied).toBe(false)
  })

  test("path UNC ditolak (tanpa menguji timeout jaringan)", () => {
    // CATATAN: kasus UNC TIDAK diuji di sini dengan cwd. `isRealPathOutsideRoot`
    // memanggil `realpathSync` atas path jaringan (\\server\share\...), yang
    // pada Windows bisa memblokir sampai timeout SMB — durasinya bergantung
    // jaringan, bukan deterministik. Tanpa cwd (heuristik) jalurnya deterministik
    // dan tetap menutup kasus ini.
    expect(inspectBashCommand('echo x >"//server/share/evil.txt"').denied).toBe(true)
  })
})
