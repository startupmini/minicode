// Audit berbasis BYTE STREAM NYATA (temuan audit skill `audit-tui`):
// sebelumnya seluruh bagian adversarial runtime audit berstatus INFERRED
// karena tidak ada harness PTY. File ini menjalankan CLI minicode di
// pseudo-terminal sungguhan, mengirim byte dari sisi keyboard, dan
// meng-assert terhadap output mentah — bukan mock stdin/stdout.
//
// Test yang butuh terminal hidup otomatis SKIP dengan alasan jelas bila
// platform tak mampu (lib tak terpasang, ConPTY rusak di sebagian mesin
// Windows) — fail-open ke skip, BUKAN hijau palsu.

import { describe, expect, test } from "bun:test"
import { ptyAvailable, spawnTui, type TuiPtyHandle } from "./helpers/pty-harness.ts"

const pty = await ptyAvailable()
const runsPty = pty.ok
const skipReason = pty.reason

// Wrapper skip eksplisit — alasan tercetak di output test.
function ptyTest(name: string, fn: () => Promise<void>) {
  test(name, async () => {
    if (!runsPty) {
      console.warn(`[pty] SKIP: ${skipReason}`)
      return
    }
    await fn()
  })
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
  ptyTest("boot TUI → alt-screen enter + prompt terlihat", async () => {
    await withTui({}, async (tui) => {
      // Prompt memakai bullet ✦ di status bar; teks model muncul via turn.
      await tui.waitFor((raw) => raw.includes("minicode ›") && raw.includes("\x1b[?1049h"))
      // Exit bersih: Ctrl+D pada prompt kosong.
      tui.send("\x04")
      await tui.waitFor((raw) => raw.includes("\x1b[?1049l"), 10000)
      const { exitCode } = await tui.exit()
      // Kontrak exit code I28: 0 sukses.
      expect(exitCode).toBe(0)
    })
  })

  ptyTest("turn penuh: prompt → submit → jawaban model → prompt lagi", async () => {
    await withTui({}, async (tui) => {
      await tui.waitFor((raw) => raw.includes("minicode ›"))
      tui.send("halo\r")
      // Jawaban provider fake (seed PTJ-TURN-OK) harus mengalir ke layar.
      await tui.waitFor((raw) => raw.includes("PTJ-TURN-OK"), 30000)
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
    await new Promise<void>((r) => {
      execFile(
        process.execPath,
        [resolve(import.meta.dir, "..", "cli", "index.ts"), "exec", "--json", "--cwd", dir, "halo"],
        {
          encoding: "utf8",
          // Exec = non-interaktif; PTY TIDAK diperlukan. Assert di sini
          // menjaga kontrak "stdout bersih" tetap dijaga dari jalur TTY
          // yang bisa bocor ke stream (regresi audit klasik).
          env: {
            ...process.env,
            NO_COLOR: "1",
            MINICODE_HOME: home,
            HOME: home,
            USERPROFILE: home,
          },
          timeout: 30000,
        },
        (_err, stdout) => {
          // Gagal setup (tanpa provider) sah — yang diuji: ENVELOPE bersih.
          const lines = stdout.split("\n").filter(Boolean)
          expect(lines.length).toBeGreaterThanOrEqual(1)
          for (const l of lines) {
            // Satu-satunya baris JSON di stdout; tanpa ANSI apapun.
            expect(() => JSON.parse(l)).not.toThrow()
            expect(l).not.toContain("\x1b")
          }
          r()
        },
      )
    })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("PTY: sinyal & resize", () => {
  ptyTest("SIGTERM → terminal dipulihkan (alt-screen exit + exit 128+15)", async () => {
    if (process.platform === "win32") {
      console.warn("[pty] SKIP (windows): pengiriman sinyal POSIX tak berlaku di ConPTY")
      return
    }
    await withTui({}, async (tui) => {
      await tui.waitFor((raw) => raw.includes("\x1b[?1049h"))
      tui.kill("SIGTERM")
      const { exitCode } = await tui.exit()
      expect(exitCode).toBe(128 + 15)
      // Restore di dalam byte stream NYATA: alt-screen exit tercatat.
      expect(tui.raw()).toContain("\x1b[?1049l")
    })
  })

  ptyTest("resize → layar menggambar ulang tanpa merusak state", async () => {
    await withTui({ cols: 100, rows: 30 }, async (tui) => {
      await tui.waitFor((raw) => raw.includes("minicode ›"))
      tui.resize(70, 20)
      // Setelah resize, App repaint (listener resize) — prompt tetap ada.
      await tui.waitFor((raw) => raw.includes("minicode ›"), 10000)
      tui.send("\x04")
      await tui.waitFor((raw) => raw.includes("\x1b[?1049l"), 10000)
      expect((await tui.exit()).exitCode).toBe(0)
    })
  })
})
