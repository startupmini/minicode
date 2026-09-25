// Audit berbasis BYTE STREAM NYATA (temuan audit skill `audit-tui`):
// sebelumnya seluruh bagian adversarial runtime audit berstatus INFERRED
// karena tidak ada harness PTY. File ini menjalankan CLI minicode di
// pseudo-terminal sungguhan, mengirim byte dari sisi keyboard, dan
// meng-assert terhadap output mentah — bukan mock stdin/stdout.
//
// Test yang butuh terminal hidup di-SKIP lewat runner (bun mencetak `(skip)`)
// bila platform tak mampu (lib tak terpasang, ConPTY rusak di sebagian mesin
// Windows). Audit TUI-008: sebelumnya skip ditulis `console.warn` + `return`,
// dan runner menghitungnya PASS — terbukti `5 pass / 0 fail` padahal empat
// test tidak mengeksekusi satu byte pun, jadi klaim "BUKAN hijau palsu" di
// komentar ini tidak terpenuhi. Skip kini TERLIHAT di ringkasan runner, dan di
// CI Linux ketiadaan PTY = kegagalan (audit runtime tak boleh jadi no-op di
// lingkungan yang seharusnya mendukungnya).

import { describe, expect, test } from "bun:test"
import {
  cleanEnvForChild,
  ptyAvailable,
  spawnTui,
  type TuiPtyHandle,
} from "./helpers/pty-harness.ts"

const pty = await ptyAvailable()
const runsPty = pty.ok
const skipReason = pty.reason

/** Nama test yang membawa alasan skip — ringkasan runner cukup untuk diagnosis. */
function skipped(name: string, reason: string): string {
  return `${name} [skip: ${reason}]`
}

// Wrapper skip NYATA: `test.skipIf` (bun melaporkan `(skip)`, bukan `(pass)`).
function ptyTest(name: string, fn: () => Promise<void>) {
  test.skipIf(!runsPty)(runsPty ? name : skipped(name, skipReason), fn)
}

async function withTui(
  opts: Parameters<typeof spawnTui>[0],
  fn: (tui: TuiPtyHandle) => Promise<void>,
): Promise<void> {
  const tui = await spawnTui(opts)
  try {
    await fn(tui)
  } finally {
    try {
      tui.kill()
    } catch {}
    await Promise.race([tui.exit(), new Promise((r) => setTimeout(r, 3000))])
    tui.dispose()
  }
}

describe("PTY: boot & kontrak layar", () => {
  ptyTest("boot TUI → alt-screen enter + timer idle terlihat", async () => {
    await withTui({}, async (tui) => {
      await tui.waitFor(
        (raw) =>
          raw.includes("00.00.00") && raw.includes("\x1b[?1049h") && raw.includes("\x1b[?1002h"),
      )
      tui.send("\x04")
      await tui.waitFor((raw) => raw.includes("\x1b[?1049l"), 10000)
      const { exitCode } = await tui.exit()
      // Kontrak exit code I28: 0 sukses.
      expect(exitCode).toBe(0)
    })
  })

  ptyTest("turn penuh: submit → jawaban model → idle timer", async () => {
    await withTui({}, async (tui) => {
      await tui.waitFor((raw) => raw.includes("00.00.00"))
      tui.send("halo\r")
      // Jawaban provider fake (seed PTJ-TURN-OK) harus mengalir ke layar.
      await tui.waitFor((raw) => raw.includes("PTJ-TURN-OK"), 30000)
      tui.send("\x04")
      await tui.waitFor((raw) => raw.includes("\x1b[?1049l"), 10000)
      expect((await tui.exit()).exitCode).toBe(0)
    })
  })

  ptyTest("SGR drag selection + Ctrl+C OSC52 melewati byte stream nyata", async () => {
    await withTui({ reply: { kind: "text", text: "selected line\n" } }, async (tui) => {
      await tui.waitFor((raw) => raw.includes("00.00.00"))
      tui.send("copy\r")
      await tui.waitFor((raw) => raw.includes("selected line"), 30000)
      tui.send("\x1b[<0;1;1M\x1b[<32;14;1M\x1b[<0;14;1m\x03")
      await tui.waitFor((raw) => raw.includes("\x1b]52;c;"), 10000)
      expect(tui.raw()).toContain(Buffer.from("selected line", "utf8").toString("base64"))
      tui.send("\x04")
      await tui.waitFor((raw) => raw.includes("\x1b[?1049l"), 10000)
      expect((await tui.exit()).exitCode).toBe(0)
    })
  })

  ptyTest("pipe-table model tampil sebagai grid, bukan Markdown mentah", async () => {
    const table = ["| Name | Value |", "| :--- | ---: |", "| alpha | 01 |"].join("\n")
    await withTui({ reply: { kind: "text", text: table } }, async (tui) => {
      await tui.waitFor((raw) => raw.includes("00.00.00"))
      tui.send("tabel\r")
      await tui.waitFor((raw) => raw.includes("Name") && raw.includes("Value"), 30000)
      expect(tui.raw()).not.toContain("| :--- |")
      tui.send("\x04")
      await tui.waitFor((raw) => raw.includes("\x1b[?1049l"), 10000)
      expect((await tui.exit()).exitCode).toBe(0)
    })
  })
})

describe("PTY: exec --json tetap bersih di TTY", () => {
  test("stdout JSON one-line, tanpa cursor-control", async () => {
    const { execFile } = await import("node:child_process")
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join, resolve } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "minicode-pty-exec-"))
    const home = join(dir, "home")
    mkdirSync(join(home, ".minicode"), { recursive: true })
    // Hermetic: env provider host (OPENAI_*, ANTHROPIC_*, TOKENHARBOR_*, …)
    // TIDAK diwarisi. Sebelum ini anak sempat mencoba jaringan dengan kunci host
    // dan envelope stdout-nya berbeda → hijau sendirian, merah di suite penuh.
    const env = cleanEnvForChild({
      NO_COLOR: "1",
      MINICODE_HOME: home,
      HOME: home,
      USERPROFILE: home,
    })
    const res = await new Promise<{ stdout: string; stderr: string; code: number }>((r) => {
      execFile(
        process.execPath,
        [resolve(import.meta.dir, "..", "cli", "index.ts"), "exec", "--json", "--cwd", dir, "halo"],
        // Exec = non-interaktif; PTY TIDAK diperlukan. Assert di sini menjaga
        // kontrak "stdout bersih" dari jalur TTY yang bisa bocor ke stream.
        { encoding: "utf8", env, timeout: 30000 },
        (err, stdout, stderr) => {
          const code = (err as { code?: number } | null)?.code
          r({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: typeof code === "number" ? code : 0,
          })
        },
      )
    })
    // Gagal setup (tanpa provider) SAH — yang diuji: ENVELOPE di stdout.
    const lines = res.stdout.split("\n").filter(Boolean)
    const diag = `exit=${res.code} stderr=${JSON.stringify(res.stderr.slice(-300))}`
    expect(lines.length, `stdout kosong — ${diag}`).toBeGreaterThanOrEqual(1)
    for (const l of lines) {
      // Satu-satunya baris JSON di stdout; tanpa ANSI apapun.
      expect(() => JSON.parse(l), `baris bukan JSON: ${l.slice(0, 120)}`).not.toThrow()
      expect(l).not.toContain("\x1b")
    }
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("PTY: sinyal & resize", () => {
  // Sinyal POSIX tak disampaikan ConPTY — skip eksplisit, bukan pass palsu.
  const sigName = "SIGTERM → terminal dipulihkan (alt-screen exit + exit 128+15)"
  const winSkip = process.platform === "win32" && runsPty
  test.skipIf(!runsPty || process.platform === "win32")(
    winSkip ? skipped(sigName, "win32: ConPTY tak menyampaikan sinyal POSIX") : sigName,
    async () => {
      await withTui({}, async (tui) => {
        await tui.waitFor((raw) => raw.includes("\x1b[?1049h"))
        tui.kill("SIGTERM")
        const { exitCode } = await tui.exit()
        expect(exitCode).toBe(128 + 15)
        // Restore di dalam byte stream NYATA: alt-screen exit tercatat.
        expect(tui.raw()).toContain("\x1b[?1049l")
      })
    },
  )

  ptyTest("resize → layar menggambar ulang tanpa merusak state", async () => {
    await withTui({ cols: 100, rows: 30 }, async (tui) => {
      await tui.waitFor((raw) => raw.includes("00.00.00"))
      tui.resize(70, 20)
      // Setelah resize, App repaint (listener resize) — timer idle tetap ada.
      await tui.waitFor((raw) => raw.includes("00.00.00"), 10000)
      tui.send("\x04")
      await tui.waitFor((raw) => raw.includes("\x1b[?1049l"), 10000)
      expect((await tui.exit()).exitCode).toBe(0)
    })
  })
})

// CI Linux WAJIB punya PTY: tanpa itu seluruh audit runtime (byte stream
// nyata) jadi no-op tanpa suara — persis kelas "hijau palsu" yang ditutup
// audit TUI-008. Di mesin dev tanpa ConPTY test ini hanya SKIP.
const ciLinux = process.env.CI === "true" && process.platform === "linux"
test.skipIf(!ciLinux)("PTY tersedia di CI Linux (audit runtime bukan no-op)", () => {
  expect(runsPty, `pty tidak tersedia: ${skipReason}`).toBe(true)
})
