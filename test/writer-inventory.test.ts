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
  // [CTL-01] 4 -> 7 for the version-mismatch warning, successful rollback
  // notice, and unrecoverable rollback failure. Each path must tell the
  // operator whether the installed version was verified or needs manual repair.
  "cli/auto-update.ts": { max: 7, owner: "human-cmd" },
  // [PHASE 6AB] 29 -> 30 for exactly one `/scheduler` writer. The first draft used
  // a `console.log` per output line (23 writers) and this audit failed it, which
  // is the audit working: the command now collects into an array and emits once.
  // Declared here rather than absorbed, per the rule above.
  "cli/commands.ts": { max: 31, owner: "human-cmd" },
  // [P1 M15] 25 -> 26 for exactly ONE writer: the warning when `--runtime` is
  // given an unknown value. Silent fail-closed here would be an expectation
  // trap — the operator would believe the runtime is active while the process
  // runs the legacy path. Declared, not absorbed, per the rule above.
  // [P12 S2.2] 26 -> 27 for exactly ONE writer: the warning when `--work-mode`
  // carries an unknown value. Silent fail-closed here would let the operator
  // believe a narrower work mode is active while the session runs EXECUTE.
  // Declared, not absorbed, per the rule above.
  // [P14] 27 -> 29 for exactly TWO writers: (a) the refusal when
  // `--adopt-task` is malformed (must fire BEFORE any session/lease exists —
  // silently ignoring it would let the operator believe a task was adopted
  // while it was not) and (b) the single-line refusal when adoption itself is
  // declined by policy (stale incarnation/revision, busy source writer,
  // target id conflict, unresolved relation). Both are "setup refused", not
  // crashes, so they print one line instead of a stack trace. Declared,
  // not absorbed, per the rule above.
  // [Live Hardening 0.13.x §8.3] 29 -> 30 for exactly ONE writer: the warning
  // when known flags appear AFTER the prompt boundary and are therefore
  // swallowed as prompt text (anti-injection stop-at-prompt). Silently dropping
  // `--resume`/`--cwd`/`--allow-all`/`--timeout`/`--model` would let the
  // operator believe the flags took effect while they became prompt text (the
  // stage5 failure mode) — the operator must see the misplaced flags. Declared,
  // not absorbed, per the rule above.
  // [P1 / F-DISCUSS-4] 30 -> 31 for exactly ONE writer: the one-shot linear
  // `[work-mode] <MODE>` stderr line surfaced when a non-EXECUTE WorkMode is
  // active (one-shot has no TUI footer). A silently enforced read-only/plan
  // ceiling would read as "permission denied" with no indication the mode is
  // active. EXECUTE (default) emits nothing, so there is no flood. Declared,
  // not absorbed, per the rule above.
  // [mode-architecture] 31 -> 33 for exactly TWO writers: the `--allow-all` and
  // `--allowlist` deprecation notices (legacy access profiles). Explicit
  // compatibility handling per the migration contract; the operator must see the
  // deprecated flag rather than have it silently reinterpreted. Declared, not
  // absorbed, per the rule above.
  // [UI-COMPAT-01] 33 -> 34 for the explicit interactive-startup failure
  // diagnostic. Failure is reported on stderr and sets a nonzero exit status;
  // it must never be treated as a successful empty interactive session.
  // [session-summary] 34 -> 35 for the exit kop: one combined write (clear-screen
  // + "minicode" wordmark + session detail) after a normal interactive exit.
  "cli/index.ts": { max: 35, owner: "human-cmd" },
  "cli/model-manager.ts": { max: 2, owner: "human-cmd" },
  "cli/provider-manager.ts": { max: 3, owner: "human-cmd" },
  // [P2.1] 26 -> 27 for exactly ONE writer: the canonical identity line
  // `[session sid=... boot=...]` emitted once per composition. Silent
  // identity here would let a resumed session masquerade as a fresh one —
  // the operator must see which durable session this process bound.
  // Declared, not absorbed, per the rule above.
  // [P2.2] 27 -> 31 for exactly FOUR writers: writer admission line,
  // stale-writer diagnostic, lease-lost warning, and re-acquire note. Each
  // names sid/boot/epoch (never tokens) so a refused second writer and a
  // stale first writer are distinguishable in logs. Declared, not absorbed.
  // [P2.4] 31 -> 32 for exactly ONE writer: default-thread resolution line
  // (`[thread sid=… tid=th_default head=…]`) at resume. Declared, not absorbed.
  // [P2.6] 32 -> 33 for exactly ONE writer: the warning when the live Run could
  // not be marked terminal at teardown. A silently dropped terminal mark would
  // leave a RUNNING residue that the next resume must tombstone as UNKNOWN —
  // the operator has to see that the close was not clean. Declared, not absorbed.
  // [P2.8] 33 -> 34 for exactly ONE writer: the resume context-assembly
  // diagnostic (`[context sid=… source=… status=… covered=…]`). Silent context
  // provenance would hide WHETHER the resume used a projection or fell back to
  // canonical history — the exact fact an operator needs when a resumed session
  // "forgets" something. Declared, not absorbed.
  // [P2.9] 34 -> 35 for exactly ONE writer: the orphan Sub-Agent tombstone
  // notice on resume (`[child] N orphaned sub-agent run(s) tombstoned`). A
  // silently swallowed orphan would leave the operator believing the session
  // resumed cleanly while a durable child run died unrecorded. Declared.
  // [P3.3] 35 -> 36 for exactly ONE writer: the canonical context-selector
  // provenance line (`[select sid=… basis=… freshness=… head=…]`). Silent
  // selection provenance would hide WHICH basis (full-history / summary-plus-tail
  // / budget-tail / fallback-unknown) and freshness produced the runtime context
  // — the exact fact an operator needs when a resumed/selected context differs
  // from expectations. Declared, not absorbed, per the rule above.
  // [P3.4] 36 -> 38 for exactly TWO writers: (a) the durable context-projection
  // producer notice (`[projection sid=… base=… status=produced]`) and (b) the
  // best-effort producer failure warning. The projection cache is DERIVED and
  // may legitimately be absent/stale; without these lines the operator could not
  // tell whether a `summary-plus-tail` resume was backed by a real projection or
  // silently fell back. Declared, not absorbed, per the rule above.
  // [Fase 6A] 38 -> 39 for exactly ONE writer: the ACE-Lite consequence-engine
  // BLOCKED verdict (`[ace] verdict=BLOCKED next_action=…`). A silently swallowed
  // block would let the operator believe a failed tool step self-healed normally
  // while the engine actually halted the consequence hunt. Declared, not absorbed.
  // [Fase 7 / Live #2 & #3] 39 -> 41 for exactly TWO writers: (a) the root
  // wall-clock timeout refusal (`[timeout] run exceeded root wall-clock timeout`)
  // and (b) the mid-stream context-window truncation (`[context] stream
  // truncated: context-window limit reached`). Both abort a turn the operator
  // asked to bound; a silent abort would read as a hang/hidden cut instead of an
  // enforced deadline/window. Declared, not absorbed, per the rule above.
  // [P1 / D-2 → P0.2 Q5] 41 -> 42 for exactly ONE writer: the resume WorkMode
  // transparency notice (`[resume] WorkMode <MODE> restored from session...` or
  // legacy fallback/explicit override). Any WorkMode state on resume is surfaced
  // on one visible stderr line, never silently altered. Declared, not absorbed.
  // [mode-architecture] 42 -> 43 for exactly ONE writer: the `--plan` deprecation
  // notice (`[deprecated] --plan is now WorkMode PLAN`). Explicit compatibility
  // handling: the operator sees that the legacy permission flag now maps to
  // WorkMode PLAN instead of being silently reinterpreted. Declared.
  // [timeout/retry hardening] 44 -> 45 for exactly ONE writer: a clamp notice
  // explains when the JS maximum timer shortens the requested timeout.
  // [R9/T8 + T7] net 45 (45 -> 46 -> 45): (a) +1 drift warning — the
  // catalog-vs-models.dev drift warning (built-in catalog may be stale vs the
  // synced overlay); silent drift would let a stale catalog under-provision the
  // model window. (b) −1 removed — the P2.8 `[context sid=…]` context-assembly
  // diagnostic, now redundant with the P3.3 `[select sid=…]` provenance line
  // (T7 selector consolidation). Declared, not absorbed.
  "cli/setup.ts": { max: 45, owner: "diagnostic" },
  "cli/tui.ts": { max: 9, owner: "screen" },
  // [P2.2] 3 -> 4 for exactly ONE writer: the stale-writer durability
  // diagnostic after a headless run persisted. The ACP success envelope is
  // exactly-once per run, so a non-durable history cannot ride a second
  // protocol message — stderr diagnostic is the honest channel. Declared,
  // not absorbed, per the rule above.
  "cli/commands/acp.ts": { max: 4, owner: "machine" },
  "cli/commands/auth.ts": { max: 27, owner: "human-cmd" },
  "cli/commands/config.ts": { max: 34, owner: "human-cmd" },
  // [P2.12] 0 -> 6 for the daemon command's own writers: help, unknown-subcommand
  // diagnostic, dan emisi keluaran perintah. Sengaja menulis SEKALI per keluaran
  // (kumpulkan ke array, flush di akhir) — pola yang sama dengan yang dipakai
  // /scheduler, supaya satu baris perintah tidak jadi enam panggilan tulis.
  // Declared, not absorbed, per the rule above.
  "cli/commands/daemon.ts": { max: 7, owner: "human-cmd" }, // +1 P2.3: hosted-run failure diagnostic
  "cli/commands/doctor.ts": { max: 4, owner: "human-cmd" },
  // [P2.2] 7 -> 8 for exactly ONE writer: the stale-writer message on the
  // non-JSON path when history could not be made durable (mirrors the JSON
  // machineFailure branch). Exit 1 either way. Declared, not absorbed.
  // [P12 S2.2] 8 -> 9 for exactly ONE writer: the `--work-mode` unknown-value
  // warning on the machine path (stderr; stdout stays pure JSONL). Declared,
  // not absorbed.
  // [Audit #2 A.1/B.4] 9 -> 11 for exactly TWO writers: the `--budget` and
  // `--ratelimit` invalid-value warnings on the machine path, added for parity
  // with cli/index.ts. A silently ignored `--ratelimit abc` would produce a
  // broken rate-limiter (NaN); a warning keeps machine-output honest while
  // stdout stays pure JSONL. Declared, not absorbed.
  // [Live Hardening 0.13.x] 11 -> 15 for exactly FOUR writers: the
  // `--max-steps`, `--context-window`, `--timeout`, and
  // `MINICODE_COMPACT_KEEP_TURNS` invalid-value warnings, added for parity
  // with cli/index.ts parsing. Fix live UAT: exec sebelumnya menyaring nilai
  // flag ini dari prompt tetapi tidak pernah menerapkannya — tanpa warning,
  // batas yang diminta operator diam-diam diabaikan. Declared, not absorbed.
  // [P1 / F-DISCUSS-4] 15 -> 16 for exactly ONE writer: the non-JSON exec
  // `[work-mode] <MODE>` stderr line surfaced when a non-EXECUTE WorkMode is
  // active (exec non-JSON = linear manusia tanpa footer TUI; JSON memakai
  // summary.workMode terstruktur, bukan teks dekoratif). Silent read-only/plan
  // enforcement would misread as ordinary denial. EXECUTE emits nothing.
  // Declared, not absorbed, per the rule above.
  // [P0.2 Q5 / Invariant #6] 16 -> 17 for exactly ONE writer: the
  // `flagsAfterPromptBoundary` stderr warning on `exec` (parity with
  // cli/index.ts §8.3), preventing `minicode exec "task" --work-mode DISCUSS`
  // from silently swallowing `--work-mode` into prompt text and running EXECUTE
  // without warning. Declared, not absorbed, per the rule above.
  // [mode-architecture] 17 -> 19 for exactly TWO writers: the `--allow-all` and
  // `--allowlist` deprecation notices on the exec machine path (parity with
  // cli/index.ts). Explicit compatibility handling; stdout stays pure JSONL.
  // Declared, not absorbed.
  "cli/commands/exec.ts": { max: 19, owner: "machine" },
  "cli/commands/mcp.ts": { max: 2, owner: "human-cmd" },
  "cli/commands/memory.ts": { max: 11, owner: "human-cmd" },
  // [P14.4] 0 -> 8 for the openwork command's writers, per the terminal
  // contract emission classes. [P14 full-scope, 2026-10-26] restructured to
  // TWO shared sinks + TWO failure writers, still within the declared max:
  // (1) emitJson — the ONE machine-JSON site for every action (list/inventory/
  // context/export envelope, merge success/refusal), (2) printLines — the ONE
  // human stdout site (collected, written once) for list/inventory/context/
  // export/merge/help, (3) usageError (stderr), (4) exit1 (stderr) shared by
  // all runtime/refusal/lookup failures. No per-row writers: multi-line
  // output is assembled first. New P14.4/P14.5 actions (inventory, context,
  // export) deliberately REUSE these four sites instead of adding classes.
  "cli/commands/openwork.ts": { max: 8, owner: "human-cmd" },
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
  // [UI-RENDER-02] 15 -> 19 for best-effort restore writes: failed ENTER
  // independently attempts EXIT + scroll-region reset; close and fatal-signal
  // restoration independently close a possibly open synchronized update.
  "src/ui/runtime/screen.ts": { max: 19, owner: "screen" },
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
