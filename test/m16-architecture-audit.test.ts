// M16 — Audit arsitektur final: batas yang TERBUKTI dari kode, bukan dari
// catatan. Tiap test di sini gagal kalau suatu perubahan masa depan mengembalikan
// topologi terlarang (dual authority, siklus import, bypass backend, atau jalur
// efek samping yang tak terdaftar).
//
// Read-only terhadap src/ dan cli/ — M16 tidak menambah semantik apa pun.

import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..")
const runtimeDir = join(repoRoot, "src/runtime")
const runtimeFiles = readdirSync(runtimeDir).filter((f) => f.endsWith(".ts"))

function runtimeSource(file: string): string {
  return readFileSync(join(runtimeDir, file), "utf8")
}

/** Import relatif runtime→runtime (graf yang diaudit). */
function runtimeImports(file: string): string[] {
  const src = runtimeSource(file)
  const deps = new Set<string>()
  for (const m of src.matchAll(/from "\.\/([a-z0-9-]+\.ts)"/g)) deps.add(m[1]!)
  return [...deps].sort()
}

// ── G1: tidak ada siklus import di dalam runtime ───────────────────────────
test("G1: graf import src/runtime/** bebas siklus", () => {
  const graph = new Map(
    runtimeFiles.map((f) => [f, runtimeImports(f).filter((d) => runtimeFiles.includes(d))]),
  )
  const state = new Map<string, "active" | "done">()
  const stack: string[] = []
  const cycles: string[] = []
  const visit = (f: string) => {
    if (state.get(f) === "done") return
    if (state.get(f) === "active") {
      cycles.push([...stack.slice(stack.indexOf(f)), f].join(" -> "))
      return
    }
    state.set(f, "active")
    stack.push(f)
    for (const dep of graph.get(f) ?? []) visit(dep)
    stack.pop()
    state.set(f, "done")
  }
  for (const f of graph.keys()) visit(f)
  expect(cycles).toEqual([])
})

// ── G2: tepi terlarang (dengan justifikasi per tepi) ───────────────────────
test("G2: tak ada tepi authority terlarang", () => {
  const forbidden: Array<[string, string[], string]> = [
    // M12 mengartikan bukti; ia tak pernah ASK/menulis ke kernel maupun dispatch.
    [
      "recovery.ts",
      ["execution-backend.ts", "dispatch.ts", "supervisor.ts", "runtime-host.ts"],
      "M12 → backend/dispatch/supervisor/host",
    ],
    // M13 menerjemahkan; ia tak pernah menyentuh kernel/backend secara langsung
    // (admission lewat port), dan tak menjalankan apa pun.
    ["dispatch.ts", ["execution-backend.ts", "execution-kernel.ts"], "M13 → backend/kernel"],
    // Observasi tak pernah memutasi lifecycle.
    [
      "execution-events.ts",
      ["execution-kernel.ts", "execution-journal.ts", "dispatch.ts"],
      "Event → kernel/journal/dispatch",
    ],
    // Jurnal adalah history, bukan current-state authority.
    [
      "execution-journal.ts",
      ["execution-kernel.ts", "dispatch.ts", "execution-backend.ts"],
      "Journal → kernel/dispatch/backend",
    ],
    // Runtime tak boleh bergantung ke domain aplikasi.
    [
      "composition.ts",
      ["production-execution.ts"],
      "Composition → M15 runner (balik, membentuk siklus)",
    ],
    ["capability.ts", ["execution-kernel.ts", "dispatch.ts"], "M6 → kernel/dispatch"],
    [
      "child-execution.ts",
      ["execution-kernel.ts", "execution-backend.ts", "dispatch.ts"],
      "M7 → kernel/backend/dispatch",
    ],
    // M1/M10/M11/M5/M6/M12 helper tak boleh menarik modul yang bergantung padanya.
    [
      "execution-id.ts",
      ["execution-kernel.ts", "dispatch.ts", "execution-journal.ts"],
      "M1 → consumer",
    ],
    [
      "recovery-safety.ts",
      ["recovery.ts", "supervisor.ts", "dispatch.ts", "composition.ts"],
      "predicate → consumer",
    ],
    ["execution-backend.ts", ["supervisor.ts", "composition.ts", "dispatch.ts"], "M5 → consumer"],
  ]
  const violations: string[] = []
  for (const [file, forbiddenDeps, label] of forbidden) {
    const deps = runtimeImports(file)
    for (const dep of forbiddenDeps)
      if (deps.includes(dep)) violations.push(`${label}: ${file} → ${dep}`)
  }
  expect(violations).toEqual([])
})

test("G2b: M12 hanya mengimpor TIPE dari kernel (bukan API mutasi)", () => {
  const src = runtimeSource("recovery.ts")
  const kernelImports = [...src.matchAll(/from "\.\/execution-kernel\.ts"/g)].length
  expect(kernelImports).toBe(1)
  expect(src).toMatch(/import type \{[^}]*TransitionRequest[^}]*\} from "\.\/execution-kernel\.ts"/)
  // Nilai yang diimpor (bukan tipe) dari kernel: tidak boleh ada.
  expect(src).not.toMatch(/import \{[^}]*(createExecutionKernel|isExecutionTerminalState)/)
  // Dan tak ada panggilan mutasi.
  expect(src).not.toMatch(/\b(createExecutionKernel|requestTransition)\s*\(/)
})

test("G2c: Supervisor hanya MEMinta ke kernel (tak pernah menulis state langsung)", () => {
  const src = runtimeSource("supervisor.ts")
  const kernelCalls = [...src.matchAll(/kernel\.(\w+)\(/g)].map((m) => m[1]!)
  for (const call of kernelCalls) expect(["requestTransition", "get"]).toContain(call)
  // Supervisor boleh memakai backend (M5) untuk eskalasi mekanis — itu desainnya.
  expect(runtimeImports("supervisor.ts")).toContain("execution-backend.ts")
})

// ── G3: SATU allocator untuk tiap identity namespace ────────────────────────
test("G3: tiap prefix identity dicetak di tepat satu berkas", () => {
  // Bentuk M1/M13 memakai konstanta, bukan literal; sisanya literal template.
  const owners: Array<[string, string, RegExp]> = [
    ["exec_", "execution-id.ts", /EXECUTION_ID_PREFIX = "exec_"/],
    ["dsp_", "dispatch.ts", /DISPATCH_ID_PREFIX = "dsp_"/],
    ["evt_", "execution-events.ts", /`evt_\$\{randomUUID\(\)\}`/],
    ["be_", "execution-backend.ts", /`be_\$\{randomUUID\(\)/],
    ["cg_", "capability.ts", /`cg_\$\{randomUUID\(\)/],
  ]
  for (const [prefix, owner, proof] of owners) {
    expect({ prefix, proof: proof.test(runtimeSource(owner)) }).toEqual({ prefix, proof: true })
    // Tidak ada berkas LAIN yang mencetak prefix itu.
    const others: string[] = []
    for (const f of runtimeFiles) {
      if (f === owner) continue
      const src = runtimeSource(f)
      if (new RegExp("`" + prefix + "\\$\\{|`" + prefix + "<|`" + prefix + '"').test(src))
        others.push(f)
    }
    expect({ prefix, others }).toEqual({ prefix, others: [] })
  }
})

test("G3b: kernel tak lagi mencetak exec_ inline (M1 = satu-satunya allocator)", () => {
  expect(runtimeSource("execution-kernel.ts")).toMatch(/allocateUniqueExecutionId\(/)
  expect(runtimeSource("execution-kernel.ts")).not.toMatch(/`exec_\$\{/)
})

// ── G4: taksonomi terminal hidup di M10 saja ───────────────────────────────
test("G4: M12 tak punya daftar tipe event terminal sendiri", async () => {
  expect(runtimeSource("execution-events.ts")).toMatch(/export function isTerminalEventType/)
  const recovery = runtimeSource("recovery.ts")
  expect(recovery).toMatch(/isTerminalEventType/)
  // Tidak ada daftar literal tujuh terminal di luar M10.
  for (const f of runtimeFiles) {
    if (f === "execution-events.ts") continue
    const src = runtimeSource(f)
    const literals = [...src.matchAll(/"execution\.(completed|failed|cancelled|timed-out)"/g)]
    expect({ file: f, literals: literals.length }).toEqual({ file: f, literals: 0 })
  }
  // Perilaku, bukan cuma bentuk kode: predicate harus benar-benar mengenali
  // ketujuh terminal (regresi `Object.hasOwn` pada sebuah Set pernah lolos
  // pemeriksaan bentuk di sini dan baru tertangkap oleh suite M12).
  const events = await import("../src/runtime/execution-events.ts")
  for (const type of [
    "execution.completed",
    "execution.failed",
    "execution.cancelled",
    "execution.timed-out",
    "execution.budget-exceeded",
    "execution.authority-lost",
    "execution.resource-exceeded",
  ]) {
    expect({ type, terminal: events.isTerminalEventType(type) }).toEqual({ type, terminal: true })
  }
  for (const type of [
    "execution.created",
    "execution.state-changed",
    "execution.orphaned",
    "",
    null,
  ]) {
    expect({ type, terminal: events.isTerminalEventType(type) }).toEqual({ type, terminal: false })
  }
})

// ── G5: predicate redispatch punya satu implementasi ───────────────────────
test("G5: ekspresi safety hanya di recovery-safety.ts", () => {
  const canonical = runtimeSource("recovery-safety.ts")
  expect(canonical).toMatch(/export function isRedispatchAllowed/)
  expect(canonical).toMatch(/export function hasDedupeProof/)
  for (const f of runtimeFiles) {
    if (f === "recovery-safety.ts") continue
    const src = runtimeSource(f)
    // Kombinasi tiga syarat tak boleh ditulis ulang di luar predicate.
    expect({
      file: f,
      inline: /idempotent\s*&&\s*[^\n]*dedupeKeyPresent\s*&&\s*[^\n]*dedupeCheckPass/.test(src),
    }).toEqual({
      file: f,
      inline: false,
    })
  }
})

// ── G6: M13 memisahkan safety (M12) dari freshness (M13) ────────────────────
test("G6: M13 memvalidasi freshness via M12, bukanpredicate kedua", () => {
  const dispatch = runtimeSource("dispatch.ts")
  expect(dispatch).toMatch(/isPlanCurrent/)
  // M13 tak boleh punya predicate safety sendiri.
  expect(dispatch).not.toMatch(/idempotent\s*&&\s*dedupeKeyPresent/)
  expect(dispatch).not.toMatch(/verifierConfirmedNotExecuted/)
})

// ── G7: shutdown ownership: composition mengorkestrasi, bukan menduplikasi FSM
test("G7: composition tak membuat FSM kedua (Host = satu-satunya lifecycle authority)", () => {
  const src = runtimeSource("composition.ts")
  // Satu latch monoton + satu promise shutdown; tak ada tabel state paralel.
  expect(src).toMatch(/if \(!shutdownPromise\) shutdownPromise = runShutdown\(\)/)
  expect(src).toMatch(/admissionOpen = false/)
  expect(src).not.toMatch(/type LifecycleState|const LIFECYCLE/)
  // Dan module-level mutable runtime state tetap nol.
  expect(src).not.toMatch(/^(let|var)\s+(runtime|host|kernel|journal|composition)\b/m)
})

// ── G8: tak ada runtime singleton yang tersembunyi ─────────────────────────
test("G8: Composition/production-runtime tanpa singleton module-level", () => {
  for (const f of ["composition.ts", "production-runtime.ts", "production-execution.ts"]) {
    const src = runtimeSource(f)
    expect({
      file: f,
      moduleMap: /^const \w+ = new Map\(\)/m.test(src),
      moduleSet: /^const \w+ = new Set\(\)/m.test(src),
    }).toEqual({ file: f, moduleMap: false, moduleSet: false })
  }
})

// ── G9: domain aplikasi tak memegang authority runtime ────────────────────
test("G9: hanya composition root yang merakit runtime produksi", () => {
  const offenders: string[] = []
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "vendor"].includes(entry.name)) continue
        scan(p)
        continue
      }
      if (!entry.name.endsWith(".ts")) continue
      if (p.startsWith(runtimeDir)) continue
      const rel = p.replace(repoRoot + "\\", "").replace(repoRoot + "/", "")
      if (rel.startsWith("test/")) continue
      const src = readFileSync(p, "utf8")
      for (const ctor of [
        "createRuntimeComposition",
        "createExecutionKernel",
        "createRuntimeHost",
      ]) {
        if (new RegExp(`\\b${ctor}\\s*\\(`).test(src)) offenders.push(`${rel}: ${ctor}`)
      }
    }
  }
  scan(join(repoRoot, "src"))
  scan(join(repoRoot, "cli"))
  expect(offenders).toEqual([])
})

// ── G10: hanya M5 yang menjalankan proses ──────────────────────────────────
test("G10: hanya M5 yang menjalankan proses; tak ada eksekutor lain di runtime", () => {
  const offenders: string[] = []
  for (const f of runtimeFiles) {
    const src = runtimeSource(f)
    if (f === "execution-backend.ts") continue
    // `(?<![.\w])` menjaga `RegExp.exec(...)` agar tak dianggap process execution.
    if (/\bspawn\(|\bspawnSync\(|(?<![.\w])exec\(|\bexecFile\(|Bun\.spawn\(/.test(src))
      offenders.push(f)
  }
  expect(offenders).toEqual([])
})

// ── G11: event/journal identity domains tetap terpisah ─────────────────────
test("G11: sequence/version identity domains terpisah", () => {
  const events = runtimeSource("execution-events.ts")
  const journal = runtimeSource("execution-journal.ts")
  // EventSequence (plane) dicetak di M10; JournalSequence (M11) di SQLite AUTOINCREMENT.
  expect(events).toMatch(/sequence\+\+/)
  expect(journal).toMatch(/journal_sequence INTEGER PRIMARY KEY AUTOINCREMENT/)
  expect(journal).toMatch(/execution_version INTEGER NOT NULL/)
  // Prefix berbeda, tidak pernah saling meniru.
  expect(events).toMatch(/`evt_\$\{randomUUID\(\)\}`/)
  expect(runtimeSource("execution-id.ts")).toMatch(/EXECUTION_ID_PREFIX = "exec_"/)
  expect(runtimeSource("dispatch.ts")).toMatch(/DISPATCH_ID_PREFIX = "dsp_"/)
})
