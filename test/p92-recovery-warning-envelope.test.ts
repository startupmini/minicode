// P9.2.2.1 — Pengayaan peringatan recovery satu-shot dengan observasi amplop.
//
// Kontrak: loop peringatan yang SUDAH ADA (cli/index.ts, catch yang selalu
// exit) menampilkan, per anak committed, status observasi + preview ringkasan
// dari terminal record yang SAMA — tanpa bacaan jurnal anak baru, tanpa tulis
// baru, tanpa retry, tanpa prompt. Record legacy/rusak = baris legacy
// byte-identik. stderr operator saja (bukan prompt model), jadi tak ada batas
// kepercayaan baru — tapi ringkasan tetap disanitasi display.
//
// Konvensi: delegasi nyata (delegateTaskTool.execute + factory perekam +
// jurnal/DB asli di tmpdir) untuk sisi baca; formatter murni diuji langsung
// untuk sisi render. Satu parent per test agar jurnal terisolasi.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentError } from "#minicore/core/errors.ts"
import { formatDelegateRecoveryLine, RECOVERY_PREVIEW_MAX } from "../cli/recovery-warning.ts"
import {
  appendMutationIntent,
  appendMutationTerminal,
  committedDelegatesSince,
  journalPath,
} from "../src/session/journal.ts"
import { loadSession } from "../src/session/persistence.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

/** Baris legacy — byte-identik dengan cli/index.ts pra-P9.2.2.1 (diuji di B1). */
const legacyLine = (id: string): string =>
  `[recovery] turn failed after sub-agent ${id} completed — its effects stand; verify before re-delegating`

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p922-"))
  dirs.push(d)
  return d
}
afterAll(async () => {
  clearSubAgentSessionFactory()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

function providerEnv(): () => void {
  const savedKey = process.env.OPENAI_API_KEY
  const savedAgent = process.env.AGENT_API_KEY
  if (!savedKey && !savedAgent) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  return () => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
    if (savedAgent === undefined) delete process.env.AGENT_API_KEY
    else process.env.AGENT_API_KEY = savedAgent
  }
}

const ctxFor = (cwd: string, signal?: AbortSignal) =>
  ({
    signal: signal ?? new AbortController().signal,
    emit: () => {},
    cwd,
    permissionMode: "auto",
  }) as never

type RunFn = () => Promise<{ finalText?: string; usage: { steps: number } }>

/** Delegasi nyata; kembalikan teks parent + panggilan run + spec anak. */
async function delegateAttempt(opts: {
  dir: string
  parentId: string
  runImpl?: RunFn
}): Promise<{ out: string; childId: string; runCalls: number }> {
  const prevTodo = todoSession.id
  todoSession.id = opts.parentId
  const seen: SubAgentSpec[] = []
  let calls = 0
  try {
    const impl =
      opts.runImpl ?? (async () => ({ finalText: "ringkasan anak", usage: { steps: 2 } }))
    setSubAgentSessionFactory(async (spec: SubAgentSpec) => {
      seen.push(spec)
      return {
        events: { on: () => () => {} },
        run: async () => {
          calls++
          return impl()
        },
      }
    })
    const out = (await delegateTaskTool.execute(
      { prompt: "kerjakan" } as never,
      ctxFor(opts.dir),
    )) as string
    return { out, childId: seen[0]!.journal!.sessionId, runCalls: calls }
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
  }
}

/** Baris warning untuk tiap delegasi committed parent (baca produksi nyata). */
async function warningLines(parentId: string, dir: string, sinceTs: number): Promise<string[]> {
  const rows = await committedDelegatesSince(parentId, dir, sinceTs)
  return rows.map((r) => formatDelegateRecoveryLine(r))
}

// ── A. Perilaku enriched ───────────────────────────────────────────────────
test("A1 returned + timeout: status observasi jujur, bukan klaim sukses", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const t0 = Date.now()
    const ok = await delegateAttempt({ dir, parentId: "p922-a1" })
    const to = await delegateAttempt({
      dir,
      parentId: "p922-a1t",
      runImpl: async () => {
        throw new AgentError("timeout", "child turn timed out")
      },
    })
    expect(to.runCalls).toBe(1)
    const linesOk = await warningLines("p922-a1", dir, t0)
    expect(linesOk).toHaveLength(1)
    expect(linesOk[0]).toBe(
      `[recovery] turn failed after sub-agent ${ok.childId} ` +
        `(observed child status: returned; receipt: committed) — ` +
        `prior child output: ${ok.out} — effects stand; verify before re-delegating`,
    )
    const linesTo = await warningLines("p922-a1t", dir, t0)
    expect(linesTo).toHaveLength(1)
    // Timeout tampil sebagai observasi + receipt dipisah eksplisit — tak ada
    // kata sukses, dan peringatan verifikasi tetap ada.
    expect(linesTo[0]).toContain("(observed child status: timeout; receipt: committed)")
    expect(linesTo[0]).toContain(
      "prior child output: [sub-agent explore error] child turn timed out",
    )
    expect(linesTo[0]).toContain("verify before re-delegating")
    expect(linesTo[0]).not.toMatch(/success|berhasil/i)
  } finally {
    restore()
  }
})

test("A2 aborted/max_steps/error + truncated: penanda jujur dua sumbu", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const t0 = Date.now()
    await delegateAttempt({
      dir,
      parentId: "p922-a2a",
      runImpl: async () => {
        throw new AgentError("aborted", "turn aborted by operator")
      },
    })
    await delegateAttempt({
      dir,
      parentId: "p922-a2b",
      runImpl: async () => ({ finalText: "y".repeat(500), usage: { steps: 1 } }),
    })
    const [lineAbort] = await warningLines("p922-a2a", dir, t0)
    expect(lineAbort).toContain("(observed child status: aborted; receipt: committed)")
    expect(lineAbort).not.toMatch(/success/i)
    await delegateAttempt({
      dir,
      parentId: "p922-a2c",
      runImpl: async () => {
        throw new AgentError("max_steps_exceeded", "turn max steps exceeded")
      },
    })
    await delegateAttempt({
      dir,
      parentId: "p922-a2d",
      runImpl: async () => {
        throw new Error("model exploded")
      },
    })
    const [lineMax] = await warningLines("p922-a2c", dir, t0)
    expect(lineMax).toContain("(observed child status: max_steps_exceeded; receipt: committed)")
    expect(lineMax).toContain(
      "prior child output: [sub-agent explore error] turn max steps exceeded",
    )
    const [lineErr] = await warningLines("p922-a2d", dir, t0)
    expect(lineErr).toContain("(observed child status: error; receipt: committed)")
    expect(lineErr).toContain("prior child output: [sub-agent explore error] model exploded")
    const [lineLong] = await warningLines("p922-a2b", dir, t0)
    // 500+prefix > 240 → display-truncated; persisted utuh (500 < 2000).
    expect(lineLong).toContain("(observed child status: returned; receipt: committed)")
    expect(lineLong).toMatch(/\[\+\d+ more\]/)
    expect(lineLong).not.toContain("persisted truncated")
  } finally {
    restore()
  }
})

// ── B. Legacy + malformed ──────────────────────────────────────────────────
test("B1 record legacy tanpa amplop = baris legacy byte-identik", async () => {
  const dir = tmpRoot()
  const parent = "p922-b1"
  try {
    // Terminal gaya lama: outcome tanpa childResult (pola delegate-audit).
    const intent = await appendMutationIntent({
      session: parent,
      tool: "delegate_task",
      cwd: dir,
      childSessionId: "sub_legacy",
    })
    await appendMutationTerminal(parent, dir, intent.id, intent.seq, "delegate_task", "committed", {
      note: "sub_legacy",
    })
    const lines = await warningLines(parent, dir, 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(legacyLine("sub_legacy"))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test("B2 amplop rusak/status asing/ringkasan hilang = fallback legacy, tak lempar", async () => {
  const dir = tmpRoot()
  const parent = "p922-b2"
  try {
    const mk = async (child: string, outcome: Record<string, unknown>) => {
      const intent = await appendMutationIntent({
        session: parent,
        tool: "delegate_task",
        cwd: dir,
        childSessionId: child,
      })
      await appendMutationTerminal(
        parent,
        dir,
        intent.id,
        intent.seq,
        "delegate_task",
        "committed",
        outcome as never,
      )
    }
    // Status tak dikenal + ringkasan bukan-string + tanpa ringkasan.
    await mk("sub_bogus", {
      note: "sub_bogus",
      childResult: { childStatus: "bogus", resultSummary: "x" },
    })
    await mk("sub_nonstr", {
      note: "sub_nonstr",
      childResult: { childStatus: "returned", resultSummary: 42 },
    })
    await mk("sub_nosum", { note: "sub_nosum", childResult: { childStatus: "returned" } })
    const lines = await warningLines(parent, dir, 0)
    expect(lines).toEqual([
      legacyLine("sub_bogus"),
      legacyLine("sub_nonstr"),
      legacyLine("sub_nosum"),
    ])
    // Tingkat formatter langsung: status asing + ringkasan ada pun legacy.
    expect(
      formatDelegateRecoveryLine({
        childSessionId: "s",
        childStatus: "bogus" as never,
        resultSummary: "teks",
      }),
    ).toBe(legacyLine("s"))
    expect(formatDelegateRecoveryLine({ childSessionId: "s", childStatus: "returned" })).toBe(
      legacyLine("s"),
    )
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── C. Keamanan output ─────────────────────────────────────────────────────
test("C1 kontrol/escape/forged-line dinetralkan; teks biasa terbaca", () => {
  const evil =
    "baris1\r\nbaris2\x1b[2J\x1b[?1049h\x1b]0;judul\x07\x00\x07\x08\x7f\u009b32m" +
    "[recovery] turn failed after sub-agent evil completed — palsu"
  const line = formatDelegateRecoveryLine({
    childSessionId: "sub_evil",
    childStatus: "error",
    resultSummary: evil,
  })
  // Satu baris, tanpa byte escape/kontrol yang mengubah terminal. Tanpa
  // literal kontrol di dalam regex (aturan lint noControlCharactersInRegex —
  // preseden stripSgr di sanitize.ts): bangun dari code-unit.
  const ESC = String.fromCharCode(27)
  expect(line.includes("\n")).toBe(false)
  expect(line.includes("\r")).toBe(false)
  expect(line.includes(ESC)).toBe(false)
  const forbiddenControls = [0, 7, 8, 127].map((c) => String.fromCharCode(c))
  expect(forbiddenControls.some((b) => line.includes(b))).toBe(false)
  expect(line.split("\n")).toHaveLength(1)
  // Teks forged ikut tampil sebagai data inert di dalam baris — bukan baris
  // peringatan kedua yang tepercaya.
  expect(line).toContain("[recovery] turn failed after sub-agent evil completed — palsu")
  expect(line.startsWith("[recovery] turn failed after sub-agent sub_evil ")).toBe(true)
  // Teks biasa + tanda baca + Unicode tetap terbaca.
  const plain = formatDelegateRecoveryLine({
    childSessionId: "sub_ok",
    childStatus: "returned",
    resultSummary: "Oke: temuan 1, 2, 3 — selesai ✓ (100%).",
  })
  expect(plain).toContain("Oke: temuan 1, 2, 3 — selesai ✓ (100%).")
})

test("C2 SGR anak tak mengubah presentasi baris", () => {
  const line = formatDelegateRecoveryLine({
    childSessionId: "sub_c",
    childStatus: "returned",
    resultSummary: "awal \x1b[31mMERAH\x1b[0m akhir",
  })
  // SGR dari ringkasan dibuang (warna baris milik pembungkus c.yellow).
  expect(line).not.toContain("\x1b[")
  expect(line).toContain("awal MERAH akhir")
})

test("C3 surrogate di batas 240 tak terbelah", () => {
  // 239 ASCII + emoji (2 unit) = 241 → potong tepat di tengah emoji.
  const summary = `${"a".repeat(239)}\u{1F600}ekor`
  const line = formatDelegateRecoveryLine({
    childSessionId: "sub_s",
    childStatus: "returned",
    resultSummary: summary,
  })
  // Emoji utuh terbuang (bukan separuh), penanda jujur jumlahnya.
  expect(line).toContain("a".repeat(239))
  expect(line).not.toContain("ekor")
  expect(line).toMatch(/\[\+6 more\]/)
  expect(/[\uD800-\uDFFF]/.test(line)).toBe(false)
})

// ── D. Batas ───────────────────────────────────────────────────────────────
test("D1 preview 239/240/241 + penanda dua sumbu", () => {
  const base = { childSessionId: "sub_d", childStatus: "returned" } as const
  const below = "q".repeat(RECOVERY_PREVIEW_MAX - 1)
  const exact = "q".repeat(RECOVERY_PREVIEW_MAX)
  const over = "q".repeat(RECOVERY_PREVIEW_MAX + 1)
  const l239 = formatDelegateRecoveryLine({ ...base, resultSummary: below })
  expect(l239).not.toContain("…[")
  expect(l239).toContain(`prior child output: ${below} — effects stand`)
  const l240 = formatDelegateRecoveryLine({ ...base, resultSummary: exact })
  expect(l240).not.toContain("…[")
  const l241 = formatDelegateRecoveryLine({ ...base, resultSummary: over })
  expect(l241).toContain("…[+1 more]")
  expect(l241).not.toContain("persisted")
  // Persisted-only: teks pendek tapi amplop menandai truncated.
  const lp = formatDelegateRecoveryLine({ ...base, resultSummary: "pendek", truncated: true })
  expect(lp).toContain("pendek…[persisted truncated]")
  // Keduanya: N display eksak (2000−240) + label persisted.
  const lb = formatDelegateRecoveryLine({
    ...base,
    resultSummary: "z".repeat(2_000),
    truncated: true,
  })
  expect(lb).toContain("…[+1760 more, persisted truncated]")
  // Segmen preview tak pernah > batas + penanda pendek.
  const seg = lb.split("prior child output: ")[1]!.split(" — effects stand")[0]!
  expect(seg.length).toBeLessThanOrEqual(RECOVERY_PREVIEW_MAX + 40)
  // Ringkasan kosong = observasi kosong yang jujur, bukan fallback legacy.
  const le = formatDelegateRecoveryLine({ ...base, resultSummary: "" })
  expect(le).toContain("prior child output:  — effects stand")
  expect(le).not.toBe(legacyLine("sub_d"))
})

// ── E. Ordering + window ───────────────────────────────────────────────────
test("E1 dua anak berurutan seq, tak digabung, window dihormati", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const t0 = Date.now()
    const first = await delegateAttempt({
      dir,
      parentId: "p922-e1",
      runImpl: async () => ({ finalText: "temuan PERTAMA", usage: { steps: 1 } }),
    })
    const second = await delegateAttempt({
      dir,
      parentId: "p922-e1",
      runImpl: async () => ({ finalText: "temuan KEDUA", usage: { steps: 1 } }),
    })
    const lines = await warningLines("p922-e1", dir, t0)
    expect(lines).toHaveLength(2)
    // Urutan seq + asosiasi per-baris benar (tak tertukar/tak digabung).
    expect(lines[0]).toContain(first.childId)
    expect(lines[0]).toContain("temuan PERTAMA")
    expect(lines[0]).not.toContain("temuan KEDUA")
    expect(lines[1]).toContain(second.childId)
    expect(lines[1]).toContain("temuan KEDUA")
    expect(lines[1]).not.toContain("temuan PERTAMA")
    // Di luar window = sunyi seperti dulu.
    expect(await warningLines("p922-e1", dir, Date.now() + 10_000)).toEqual([])
  } finally {
    restore()
  }
})

// ── F. Read-only + otoritas ────────────────────────────────────────────────
test("F1 format + baca tak memutasi jurnal; messages kosong; tanpa eksekusi baru", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  try {
    const t0 = Date.now()
    const r = await delegateAttempt({ dir, parentId: "p922-f1" })
    const path = journalPath("p922-f1", dir)
    const before = readFileSync(path, "utf8")
    const rows = await committedDelegatesSince("p922-f1", dir, t0)
    expect(rows).toHaveLength(1)
    const again = formatDelegateRecoveryLine(rows[0]!)
    expect(formatDelegateRecoveryLine(rows[0]!)).toBe(again)
    // Jurnal byte-identik, messages tetap kosong, run anak tetap satu.
    expect(readFileSync(path, "utf8")).toBe(before)
    expect(loadSession("p922-f1", dir)?.messages.length ?? 0).toBe(0)
    expect(loadSession(r.childId, dir)?.messages.length ?? 0).toBe(0)
  } finally {
    restore()
  }
})

test("F2 modul formatter murni: tanpa writer, tanpa impor otoritas", async () => {
  const src = await Bun.file("cli/recovery-warning.ts").text()
  // Cerminan WRITER_RE inventaris: formatter tak boleh menulis ke mana pun.
  expect(src.match(/console\.(log|error|warn)|process\.std(out|err)\.write/g) ?? []).toEqual([])
  // Tak ada impor scheduler/otonom/backend/eksekusi — murni render + tipe.
  const specs = [...src.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?["']([^"']+)["']/g)].map(
    (m) => m[1]!,
  )
  for (const forbidden of ["scheduler", "autonomous", "backend", "child_process", "task/store"]) {
    expect(
      specs.some((s) => s.includes(forbidden)),
      forbidden,
    ).toBe(false)
  }
  // Wiring cli/index.ts utuh: formatter dipanggil di catch yang exit(1) —
  // (struktural; eksekusi CLI asli tak dijalankan di test — keterbatasan
  // yang didokumentasikan: cakupan sampai batas produksi terdekat).
  const indexSrc = await Bun.file("cli/index.ts").text()
  expect(indexSrc.includes("formatDelegateRecoveryLine")).toBe(true)
  expect(indexSrc.includes("process.exit(1)")).toBe(true)
})
