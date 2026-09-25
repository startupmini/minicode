import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Inventaris writer langsung (OAP-008, Phase 7): setiap tulis langsung ke
// console/stdout/stderr di cli/** dan src/ui/** harus terdaftar di sini
// dengan owner kategorinya. Menambah writer baru tanpa mendaftarkan +
// mengkategorikannya = test merah. Angka = batas atas (boleh turun bila
// writer dimigrasi ke kategori terpusat, tidak boleh naik diam-diam).
//
// Kategori owner:
// - screen: pemilik layar/paint (alt-screen, input mentah, transient painter)
// - machine: stdout mesin (exec --json, ACP) — wajib JSON + scrub + tanpa ANSI
// - human-cmd: perintah human (help/status/sessions/...) — ditangkap TUI
// - diagnostic: stderr diagnostik/transient yang diizinkan kontrak
// - debug: guard verbose/env, tidak pernah default

const INVENTORY: Record<string, { max: number; owner: string }> = {
  "cli/auto-update.ts": { max: 4, owner: "human-cmd" },
  "cli/commands.ts": { max: 29, owner: "human-cmd" },
  "cli/index.ts": { max: 25, owner: "human-cmd" },
  "cli/model-manager.ts": { max: 2, owner: "human-cmd" },
  "cli/provider-manager.ts": { max: 3, owner: "human-cmd" },
  "cli/setup.ts": { max: 26, owner: "diagnostic" },
  "cli/tui.ts": { max: 9, owner: "screen" },
  "cli/commands/acp.ts": { max: 3, owner: "machine" },
  "cli/commands/auth.ts": { max: 27, owner: "human-cmd" },
  "cli/commands/config.ts": { max: 34, owner: "human-cmd" },
  "cli/commands/doctor.ts": { max: 4, owner: "human-cmd" },
  "cli/commands/exec.ts": { max: 7, owner: "machine" },
  "cli/commands/mcp.ts": { max: 2, owner: "human-cmd" },
  "cli/commands/memory.ts": { max: 11, owner: "human-cmd" },
  "cli/commands/pricing.ts": { max: 23, owner: "human-cmd" },
  "cli/commands/providers.ts": { max: 17, owner: "human-cmd" },
  "cli/commands/sessions.ts": { max: 11, owner: "human-cmd" },
  "cli/commands/skills.ts": { max: 7, owner: "human-cmd" },
  "cli/commands/stats.ts": { max: 4, owner: "human-cmd" },
  "src/ui/approval/prompt.ts": { max: 4, owner: "diagnostic" },
  "src/ui/assistant/simple.ts": { max: 3, owner: "human-cmd" },
  "src/ui/assistant/turn-status.ts": { max: 1, owner: "diagnostic" },
  "src/ui/input/input.ts": { max: 40, owner: "screen" },
  "src/ui/runtime/bus-debug.ts": { max: 1, owner: "debug" },
  "src/ui/runtime/screen.ts": { max: 15, owner: "screen" },
  "src/ui/runtime/spinner.ts": { max: 4, owner: "diagnostic" },
  "src/ui/runtime/statusline.ts": { max: 13, owner: "diagnostic" },
  "src/ui/screens/dialog.ts": { max: 0, owner: "screen" },
  "src/ui/screens/form.ts": { max: 1, owner: "screen" },
  "src/ui/screens/model-manager.ts": { max: 6, owner: "screen" },
  "src/ui/screens/picker.ts": { max: 10, owner: "screen" },
  "src/ui/screens/provider-manager.ts": { max: 6, owner: "screen" },
  "src/ui/screens/wizard.ts": { max: 1, owner: "screen" },
  "src/ui/tui/app.ts": { max: 3, owner: "screen" },
}

const WRITER_RE = /console\.(log|error|warn)|process\.std(out|err)\.write/g

function trackedSources(): string[] {
  const r = spawnSync(
    "git",
    ["ls-files", "cli/*.ts", "cli/**/*.ts", "src/ui/*.ts", "src/ui/**/*.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    },
  )
  if (r.status !== 0) return []
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".ts"))
}

describe("inventaris writer langsung (OAP-008)", () => {
  test("setiap writer terdaftar + tidak bertambah diam-diam", () => {
    const offenders: string[] = []
    for (const file of trackedSources()) {
      const src = readFileSync(join(process.cwd(), file), "utf8")
      const count = (src.match(WRITER_RE) ?? []).length
      const entry = INVENTORY[file]
      if (count === 0) continue
      if (!entry) {
        offenders.push(`${file}: ${count} writer TANPA owner — daftarkan di test ini`)
        continue
      }
      if (count > entry.max)
        offenders.push(`${file}: ${count} writer > batas ${entry.max} (owner: ${entry.owner})`)
    }
    expect(offenders).toEqual([])
  })
})
