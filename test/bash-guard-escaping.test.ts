// Regresi audit 2026-09-20 — tiga kelas yang membuat guard menahan bentuk
// KANONIK tapi meloloskan bentuk setara yang benar-benar dieksekusi cmd.exe:
//
//   F1  escape caret `cmd.exe` tidak dinormalisasi (`type .e^nv` = baca .env)
//   F2  argumen PEMBACA berpola %VAR% tak dianggap "tak bisa dipastikan"
//       (padahal target redirect dengan pola sama sudah ditolak)
//   F3  `for /f` — pembaca berkas bawaan cmd.exe, bukan utilitas → tak ada di
//       READERS, jadi targetnya tak diperiksa sama sekali
//
// Gaya: diferensial (kontrol = bentuk kanonik yang HARUS ditahan, treatment =
// satu variabel diubah) + daftar tetangga sah untuk menjaga arah sebaliknya.
// Tanpa pasangan kontrol, test bisa hijau hanya karena polanya ditolak seluruhnya.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  blankQuotedDataArgs,
  expandBraceAlternatives,
  expandIfsRefs,
  inspectBashCommand,
  normalizeCommand,
  stripCaretEscapes,
} from "../src/policy/bash-guard.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"

const deniedIn = (cmd: string, cwd: string) => inspectBashCommand(cmd, cwd).denied

describe("F1: escape caret cmd.exe dinormalisasi sebelum pemeriksaan", () => {
  test("caret di luar kutip hilang, di dalam kutip ganda utuh", () => {
    // cmd.exe tidak memproses caret di dalam kutip ganda — melepasnya di sana
    // akan mengubah arti perintah sah (`echo "a^b"`).
    expect(stripCaretEscapes("type .e^nv")).toBe("type .env")
    expect(stripCaretEscapes("ty^pe .env")).toBe("type .env")
    expect(stripCaretEscapes("echo a^^b")).toBe("echo a^b")
    expect(stripCaretEscapes('echo "a^b"')).toBe('echo "a^b"')
    expect(normalizeCommand("type .e^nv")).toBe("type .env")
  })

  test("diferensial: bentuk kanonik dan ber-caret sama-sama ditahan", () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-"))
    try {
      writeFileSync(join(dir, ".env"), "DUMMY=1\n")
      const pairs: [string, string][] = [
        ["type .env", "type .e^nv"],
        ["cat .env", "cat .e^nv"],
        ["type .env", "ty^pe .env"],
        ["copy .env out.txt", "copy .e^nv out.txt"],
        ["findstr x .env", "findstr x .e^nv"],
        ["echo x > .env", "echo x > .e^nv"],
        ["set /p x=<.env", "set /p x=<.e^nv"],
      ]
      for (const [kontrol, treatment] of pairs) {
        expect(deniedIn(kontrol, dir), `kontrol: ${kontrol}`).toBe(true)
        expect(deniedIn(treatment, dir), `treatment: ${treatment}`).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("tetangga sah tidak ikut terblokir (arah over-block)", () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-ok-"))
    try {
      for (const cmd of ['echo "a^b"', "echo a^^b", "echo 100%.txt", "type 100%.txt"]) {
        expect(deniedIn(cmd, dir), `over-block: ${cmd}`).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("F2: %VAR% pada argumen pembaca ditolak fail-closed", () => {
  test("pasangan terkontrol: token sama, posisi berbeda, keduanya ditahan", () => {
    const dir = mkdtempSync(join(tmpdir(), "var-"))
    try {
      // Sebelum perbaikan: `type %USERPROFILE%\notes.txt` LOLOS karena
      // resolve() melihat `%USERPROFILE%` sebagai nama direktori di dalam cwd,
      // sementara target redirect dengan token identik sudah ditahan.
      expect(deniedIn("type %USERPROFILE%\\notes.txt", dir)).toBe(true)
      expect(deniedIn("echo x > %USERPROFILE%\\notes.txt", dir)).toBe(true)
      expect(deniedIn("type %TEMP%\\x.txt", dir)).toBe(true)
      // Komposisi caret + %VAR% (dulu ALLOW): nama sensitif jadi tak terlihat
      // DAN jalur nyatanya tak bisa di-resolve.
      expect(deniedIn("type %USERPROFILE%\\.ss^h\\config", dir)).toBe(true)
      // `%` tunggal bukan pola ekspansi — tetap lolos.
      expect(deniedIn("echo 100%.txt", dir)).toBe(false)
      expect(deniedIn("echo %PATH%", dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("F3: pembaca berkas bawaan cmd.exe (`for /f`) ikut diperiksa", () => {
  test("set `for /f` diperiksa seperti argumen pembaca", () => {
    const dir = mkdtempSync(join(tmpdir(), "forf-"))
    try {
      writeFileSync(join(dir, ".env"), "DUMMY=1\n")
      expect(deniedIn("for /f %i in (.env) do @echo %i", dir)).toBe(true)
      expect(deniedIn('for /f "delims=" %i in (.e^nv) do @echo %i', dir)).toBe(true)
      // Set jinak (berkas biasa di dalam workspace) tetap lolos.
      expect(deniedIn("for /f %i in (src/list.txt) do @echo %i", dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("integrasi: mode default `auto` menahan ketiga kelas", () => {
  test("check() menolak perintah ber-caret dan ber-%VAR% di mode auto", async () => {
    // Mode `auto` adalah default dan untuk `bash` guard adalah SATU-SATUNYA
    // kontrol (tak ada approval) — jadi perilaku ini yang diuji, bukan hanya
    // fungsi guard-nya.
    const dir = mkdtempSync(join(tmpdir(), "auto-"))
    try {
      writeFileSync(join(dir, ".env"), "DUMMY=1\n")
      const h = createPermissionHandler({ mode: "auto", root: dir })
      const verdict = async (cmd: string) =>
        await h.check({ id: "1", name: "bash", args: { cmd } } as never, {} as never)
      expect(await verdict("type .e^nv")).toBe("deny")
      expect(await verdict("ty^pe .env")).toBe("deny")
      expect(await verdict("type %USERPROFILE%\\notes.txt")).toBe("deny")
      expect(await verdict("for /f %i in (.env) do @echo %i")).toBe("deny")
      expect(await verdict("type src/index.ts")).toBe("allow")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("audit 2026-11-12: pemisah kata, glob, dan brace expansion", () => {
  // Tiga kelas yang membuat guard menahan bentuk kanonik tapi meloloskan
  // bentuk SETARA yang benar-benar dieksekusi bash:
  //   - `$IFS`/`\${IFS…}` adalah pemisah kata (`cat\${IFS}.env` = `cat .env`)
  //   - glob `?`/`[e]` mengembang seperti `*` (`cat .?nv` = `cat .env`)
  //   - brace `{a,b}` diekspansi sebelum eksekusi (`cat .{env,}`)
  // Lint `noTemplateCurlyInString` menolak literal `${` di string, sementara
  // test ini justru harus memuat bentuk shell ASLINYA. Konstanta berikut
  // merakit nilai yang sama tanpa literal terlarang.
  const OPEN = "{"
  const I1 = `$${OPEN}IFS}` // ${IFS}
  const I2 = "$IFS"
  const I3 = `$${OPEN}IFS:0:1}` // ${IFS:0:1}

  test("expandIfsRefs memetakan semua bentuk IFS ke pemisah", () => {
    expect(expandIfsRefs(`cat${I1}.env`)).toBe("cat .env")
    expect(expandIfsRefs(`cat${I2}.env`)).toBe("cat .env")
    expect(expandIfsRefs(`cat${I3}.env`)).toBe("cat .env")
    expect(normalizeCommand(`rm${I1}-rf${I1}/`)).toBe("rm -rf /")
  })

  test("expandBraceAlternatives hanya memecah grup berkoma", () => {
    expect(expandBraceAlternatives("cat .{env,}")).toContain(".env")
    expect(expandBraceAlternatives("cat {.env,x}")).toContain(".env")
    // Pola awk tanpa koma bukan ekspansi — jangan dipecah (anti over-block).
    expect(expandBraceAlternatives("awk '{print $1}' a.ts")).toContain("{print")
  })

  test("blankQuotedDataArgs mengosongkan data, tapi tidak substitusi", () => {
    expect(blankQuotedDataArgs('echo "rm -rf /"')).not.toContain("rm -rf")
    expect(blankQuotedDataArgs('git commit -m "docs: sudo rm"')).not.toContain("sudo rm")
    // Substitusi perintah di dalam kutip BENAR-BENAR dieksekusi → jangan
    // dikosongkan, supaya aturan statis tetap melihat payload-nya.
    expect(blankQuotedDataArgs('echo "$(rm -rf /)"')).toContain("rm -rf")
    expect(blankQuotedDataArgs('bash -c "rm -rf /"')).toContain("rm -rf")
  })

  test("semua varian ditolak di cwd nyata", () => {
    const dir = mkdtempSync(join(tmpdir(), "ifs-"))
    try {
      writeFileSync(join(dir, ".env"), "DUMMY=1\n")
      const attacks = [
        `cat${I1}.env`,
        `cat${I2}.env`,
        `cat${I3}.env`,
        `cat${I1}.e""nv`,
        `c'a't${I1}.env`,
        `type${I1}.env`,
        `type${I1}.e^nv`,
        `rm${I1}-rf${I1}/`,
        `rm${I2}-rf${I2}/`,
        `rm${I1}--recursive${I1}--force${I1}/`,
        `dd${I1}if=/dev/zero${I1}of=/dev/sda`,
        `chmod${I1}-R${I1}777${I1}.`,
        `find${I1}.${I1}-delete`,
        `npm${I1}publish`,
        `cat$(printf${I1}' ').env`,
        "cat .?nv",
        "cat .[e]nv",
        "cat {.env,x}",
        "cat .{env,}",
        'echo "$(rm -rf /)"',
        "bash -c 'rm -rf /'",
      ]
      for (const cmd of attacks) expect(deniedIn(cmd, dir), `bypass: ${cmd}`).toBe(true)
      // Arah sebaliknya: data dalam kutip dan pola pencarian bukan perintah.
      const benign = [
        'echo "rm -rf /"',
        'grep "rm -rf" src/a.ts',
        "awk '{print $1}' src/a.ts",
        "grep -E 'a[0-9]' src/a.ts",
        "cat src/a.ts",
      ]
      for (const cmd of benign) expect(deniedIn(cmd, dir), `over-block: ${cmd}`).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("F-CRIT: pembuatan link ke target sensitif/owned-state ditahan", () => {
  // Regresi audit 2026-09-22: link internal (junction/symlink) ke
  // `.minicode/` menembus kunci owned-state tool tulis yang membaca STRING
  // argumen (`ln -s .minicode linkdir` + `write_file linkdir/config.json`).
  // Kunci utama ada di lapisan permission (isOwnedStateReal — realpath, diuji
  // di deny-reason.test.ts); guard shell ini lapisan kedua: perintah
  // PEMBUATAN link-nya ditahan.
  //
  // Urutan argumen BEDA antar tool (ln: TARGET LINK; mklink/fsutil: LINK
  // dulu; New-Item: parameter bernama urutan bebas + alias -Value + nilai
  // menempel `-Target:x`), jadi guard memeriksa SEMUA operand non-flag.
  // Versi posisi-sensitif sebelumnya lolos untuk `fsutil hardlink create
  // linkx .env`, `ln --symbolic .env x`, dan `New-Item ... -Target:.minicode`
  // — ketiganya wajib ada di daftar ini.
  test("semua bentuk pembuatan link ke .env / .minicode ditolak", () => {
    const dir = mkdtempSync(join(tmpdir(), "linkdeny-"))
    try {
      const attacks = [
        "ln -s .minicode linkdir",
        "ln -s .minicode/config.json lc",
        "ln -sf .env linkx",
        "ln --symbolic .env linkx",
        "ln -s -- .env linkx",
        "ln .env hardlink-x",
        "mklink linkx .env",
        "mklink /D linkdir .minicode",
        "mklink /J linkdir .minicode",
        "fsutil hardlink create linkx .env",
        "New-Item -ItemType Junction -Path linkdir -Target .minicode",
        "New-Item -ItemType SymbolicLink -Target .env -Path linkx",
        "New-Item -ItemType HardLink -Path linkx -Value .env",
        "New-Item -ItemType Junction -Path linkdir -Target:.minicode",
      ]
      for (const cmd of attacks) {
        expect(deniedIn(cmd, dir), `bypass: ${cmd}`).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("link ke target jinak tidak ikut terblokir (arah over-block)", () => {
    const dir = mkdtempSync(join(tmpdir(), "linkok-"))
    try {
      writeFileSync(join(dir, "README.md"), "# x\n")
      const benign = [
        "ln -s src linkdir",
        "ln -s README.md doc-link",
        "mklink /D linkdir src",
        "New-Item -ItemType SymbolicLink -Path linkx -Target README.md",
        "fsutil hardlink create link-ok.txt README.md",
      ]
      for (const cmd of benign) {
        expect(deniedIn(cmd, dir), `over-block: ${cmd}`).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
