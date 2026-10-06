// M15 — Inventaris jalur eksekusi produksi (registry, bukan hiasan).
//
// Kenapa berkas ini ada: M15 mengklaim "tak ada jalur produksi yangkilko bypass
// runtime". Klaim seperti itu hanya berarti apa pun bila dip mechanically: kalau
// daftar ini bisa lolos tanpa.register caller efek samping baru, ia bukan
// inventaris — ia hiasan.
//
// Yang diEGISTRIKAN di sini adalah TITIK EFEK SAMPING (process spawn / network),
// bukan "fitur". Alasannya: dua daftar terpisah (spawn dan fetch) menutup setiap
// jalan keluar dari proses, dan setiap titik punya SATU jawaban tegas:
//   runtime-owned : milik Runtime (hanya src/runtime/**)
//   external-tool : efek yang DIBUTUHKAN user/model lewat tool (bash, git, grep)
//   external-integ: integrasi proses (MCP, LSP, hook, self-update, re-exec)
//   legacy-durable: durable state lama (mutation journal, checkpoint, shadow git,
//                   sessions DB, TaskStore, trace) — bukan authority eksekusi
//   runtime-adapter: adapter yang DIPAKAI Runtime (M5 backend, M11 journal)
//
// Aturan yang dikunci: berkas baru yang spawn/fetch dan tak terdaftar = test merah.
// Itu satu-satunya cara "tak ada jalur tak dikenal" bisa tetap benar.

import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..")

type ExecutionClass =
  | "runtime-owned"
  | "runtime-adapter"
  | "external-tool"
  | "external-integration"
  | "legacy-durable"

interface RegisteredPath {
  readonly cls: ExecutionClass
  /** Titik masuk yang membuat efek samping (untuk audit manual). */
  readonly entry: string
  /** Literal yang HARUS ada di berkas: bukti entri ini masih hidup. */
  readonly proof?: string
  /** Mengapa kelas ini, dan kenapa TIDAK Runtime yang memilikinya. */
  readonly note: string
}

/**
 * [M15 §4] Inventaris produksi. Satu baris = satu titik efek samping.
 * DELIBERATELY EKSTENSIF: lebih baik satu baris berlebihan daripada satu jalur
 * bypass yang tak tercatat.
 */
export const EXECUTION_PATHS: Readonly<Record<string, RegisteredPath>> = {
  // ── Runtime (satu-satunya pemilik lifecycle/physical execution) ──────────
  "src/runtime/execution-backend.ts": {
    cls: "runtime-adapter",
    entry: "createHostBackend/createDockerBackend/createBwrapBackend/createSeatbeltBackend",
    note: "M5 boundary: satu-satunya tempat runtime mengeksekusi proses; tool tak pernah memakainya langsung.",
  },
  "src/runtime/execution-journal.ts": {
    cls: "runtime-adapter",
    entry: "openExecutionJournal",
    proof: "bun:sqlite",
    note: "M11 durable evidence (SQLite lokal). Bukan efek samping ke dunia luar.",
  },

  // ── Efek yang DIMINTA model/user lewat tool (bukan authority runtime) ─────
  "src/tools/bash.ts": {
    cls: "external-tool",
    entry: "bashTool/bashOutputTool/bashKillTool execute",
    note: "Shell tool. Admission = permission handler (produk); runtime MENCATAT turn-nya (M15 owned).",
  },
  "src/tools/git.ts": {
    cls: "external-tool",
    entry: "runGit",
    proof: "spawn(",
    note: "git_* tools. Admission = permission handler + path jail.",
  },
  "src/tools/grep.ts": {
    cls: "external-tool",
    entry: "ripgrepAvailable/spawn rg",
    note: "grep tool (ripgrep + JS fallback).",
  },
  "src/tools/task.ts": {
    cls: "external-tool",
    entry: "delegateTaskTool.execute → child session.run",
    proof: "session.run",
    note: "Sub-agent execution. M15: turn anak lewat M13 → Kernel; authority tetap composition root.",
  },
  "src/sandbox/docker.ts": {
    cls: "external-tool",
    entry: "runInDocker/dockerAvailable",
    note: "Backend sandbox untuk bash/code_run (sebelum M5). Produksi memilih lewat MINICODE_SANDBOX.",
  },
  "src/sandbox/os.ts": {
    cls: "external-tool",
    entry: "runInOsSandbox/osSandboxAvailable",
    note: "Backend sandbox OS (seatbelt/bwrap) untuk bash/code_run.",
  },
  "src/policy/verifier.ts": {
    cls: "external-tool",
    entry: "runVerify/runWithSelfHeal",
    proof: "execAsync",
    note: "--verify: menjalankan perintah verifikasi + self-heal. Remote ke authority eksekusi.",
  },
  "src/tools/web_fetch.ts": {
    cls: "external-tool",
    entry: "webFetchTool.execute (fetch)",
    note: "Network tool (SSRF guard). Admission = permission handler.",
  },
  "src/tools/web_search.ts": {
    cls: "external-tool",
    entry: "webSearchTool.execute (fetch)",
    note: "Network tool (Tavily/Brave/DDG). Admission = permission handler.",
  },

  // ── Integrasi proses (bukan work milik runtime) ──────────────────────────
  "src/mcp/transport.ts": {
    cls: "external-integration",
    entry: "McpHttpTransport/McpStdioTransport connect (spawn)",
    note: "Proses MCP. Integrasi, bukan execution turn: tool MCP adalah tool biasa.",
  },
  "src/mcp/http-transport.ts": {
    cls: "external-integration",
    entry: "fetch (MCP HTTP)",
    note: "Integrasi MCP jarak jauh.",
  },
  "src/lsp/client.ts": {
    cls: "external-integration",
    entry: "ServerConnection.doStart (spawn)",
    note: "Language server. Lazy, tanpa lifecycle eksekusi.",
  },
  "src/hooks/run.ts": {
    cls: "external-integration",
    entry: "runRunHooks (spawn bun)",
    note: "Hook `post` yang dikonfigurasi user (MINICODE_HOOKS=1). Extern dari permission sistem.",
  },
  "src/policy/update-check.ts": {
    cls: "external-integration",
    entry: "checkForUpdate/installUpdate (fetch + npm -g)",
    note: "Self-update. Terpisah dari session/execution lifecycle.",
  },
  "src/lib/keystore.ts": {
    cls: "external-integration",
    entry: "dpapiProtect/dpapiUnprotect (spawnSync)",
    note: "DPAPI Windows untuk secret provider.",
  },
  "src/policy/context.ts": {
    cls: "external-integration",
    entry: "buildSystemPrompt → git ls-files (execFile)",
    proof: "execFileAsync",
    note: "Baca daftar repo saat startup (konteks prompt). Tanpa efek samping.",
  },
  "src/repo/repomap.ts": {
    cls: "external-integration",
    entry: "listSourceFiles (execFile git ls-files) + cache",
    proof: "execFileAsync",
    note: "Peta repo (cache ~/.minicode). Baca saja.",
  },
  "src/providers/anthropic.ts": {
    cls: "external-integration",
    entry: "stream (fetch)",
    note: "Adapter provider. Retry milik router/kernel (transport level), bukan re-dispatch.",
  },
  "src/providers/responses.ts": {
    cls: "external-integration",
    entry: "stream (fetch)",
    note: "Adapter provider OpenAI Responses.",
  },
  "src/providers/oauth.ts": {
    cls: "external-integration",
    entry: "getValidAccessToken (fetch)",
    note: "Refresh token; retry transport, bukan eksekusi ulang.",
  },
  "src/providers/detect.ts": {
    cls: "external-integration",
    entry: "detectModels (fetch)",
    note: "Probe /models saat konfigurasi.",
  },
  "src/policy/pricing.ts": {
    cls: "external-integration",
    entry: "syncPricing (fetch models.dev)",
    note: "Cache harga. Tanpa efek ke workspace.",
  },
  "src/memory/vector.ts": {
    cls: "external-integration",
    entry: "fetchEmbeddingsOnce (fetch)",
    note: "Embedding RAG. Bystroke, bukan execution lifecycle.",
  },

  // ── Durable state LAMA (history/mutation, BUKAN authority eksekusi) ──────
  "src/session/checkpoint.ts": {
    cls: "legacy-durable",
    entry: "beginTurnSnapshot/recordCheckpoint* (git plumbing)",
    proof: "spawnSync",
    note: "Undo/redo workspace snapshots. Bridge ke runtime journal = M16+ (debt tercatat).",
  },
  "src/session/shadow-git.ts": {
    cls: "legacy-durable",
    entry: "snapshotTree/restoreTree (git)",
    note: "Backing store checkpoint (GIT_INDEX_FILE sementara).",
  },
  "src/session/persistence.ts": {
    cls: "legacy-durable",
    entry: "saveSession/appendPresentationEvents (SQLite)",
    proof: "new Database",
    note: "History sesi + presentasi. Berdampingan dengan runtime journal, bukan menggantikannya.",
  },
  "src/session/turn-marker.ts": {
    cls: "legacy-durable",
    entry: "markTurnActive/checkStaleTurn",
    proof: "writeFileSync",
    note: "Marker crash lama. Dengan mode owned, journal runtime adalah bukti lifecycle yang kaya.",
  },
  "src/task/store.ts": {
    cls: "legacy-durable",
    entry: "claimTask/acquireSessionAuthority (SQLite)",
    proof: "new Database",
    note: "TaskStore: domain claim/lease. BUKAN execution lifecycle (tetap begitu di M15).",
  },
  "src/telemetry/trace.ts": {
    cls: "legacy-durable",
    entry: "writeStepTrace (file)",
    proof: "appendFile",
    note: "Telemetri tool call. Berdampingan dengan M10 event (observasi berbeda).",
  },
  "src/lib/git-hardening.ts": {
    cls: "external-integration",
    entry: "discoverFilterDrivers (spawnSync git config)",
    note: "Hardening git: probing konfigurasi.",
  },
  "src/session/verification.ts": {
    cls: "external-integration",
    entry: "observeGitCommit (spawnSync git cat-file -e)",
    proof: "spawnSync",
    note: "P2.10: observasi read-only keberadaan commit untuk bukti verifikasi. Tanpa mutasi, tanpa network; via GIT_SAFE_BASE + trusted executable.",
  },
  "src/lib/net.ts": {
    cls: "external-integration",
    entry: "fetchWithTimeout/fetchWithRetry (fetch)",
    proof: "export async function",
    note: "Utilitas network; dipakai provider + web tools.",
  },
  "src/lib/trusted-exec.ts": {
    cls: "external-integration",
    entry: "resolveTrustedExecutable",
    proof: "resolveTrustedExecutable",
    note: "Resolusi path executable (bukan spawn). Tetap terdaftar karena di situlah spawn diarahkan.",
  },
  // ── Re-exec proses CLI (ditemukan audit P1 F1a; pola glob lama melewatkannya)
  "cli/index.ts": {
    cls: "external-integration",
    entry: "plan-mode re-exec (spawn process.execPath, argv dipertahankan)",
    proof: "waitChildExit",
    note: "Re-exec diri sendiri untuk keluar dari mode plan. Mewarisi argv pemanggil (termasuk --runtime bila ada). Bukan eksekusi user work.",
  },
  "cli/commands.ts": {
    cls: "external-integration",
    entry: "popup-resume re-exec (spawn process.execPath --resume)",
    proof: "waitChildExit",
    note: "Re-exec diri sendiri untuk resume sesi. Meneruskan --resume/--cwd/--runtime (F1b). Bukan eksekusi user work.",
  },
  "cli/auto-update.ts": {
    cls: "external-integration",
    entry: "self-update restart (spawn process.execPath, argv dipertahankan)",
    proof: "waitChildExit",
    note: "Restart setelah update. Mewarisi argv pemanggil. Bukan eksekusi user work.",
  },
}

/** Penanda efek samping yang harus ter-cover inventaris ini. */
const EFFECT_MARKERS = [
  /\bspawn\(/,
  /\bspawnSync\(/,
  /\bexecFile\(/,
  /\bexecFileSync\(/,
  // `(?<![.\w])` menjaga `RegExp.exec(...)` (regex parsing) agar tak dianggap
  // process execution — bedanya nyata dan mahal kalau terlewat.
  /(?<![.\w])exec\(/,
  /(?<![.\w])execSync\(/,
  /\bBun\.spawn\(/,
  /\bfetch\(/,
]

function trackedSource(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8")
}

function trackedFiles(): string[] {
  // [P1 Hygiene F1a] Pola single-star + double-star eksplisit (sama seperti
  // writer-inventory.test.ts): `dir/**/*.ts` SAJA tidak mencakup `dir/*.ts`
  // pada Git ini, sehingga 12 berkas top-level lolos tanpa dipindai.
  const r = spawnSync("git", ["ls-files", "src/*.ts", "src/**/*.ts", "cli/*.ts", "cli/**/*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  })
  if (r.status !== 0) return []
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".ts"))
}

// ── T0: discovery generik mencakup berkas top-level (anti regresi glob F1a) ──
test("M15 T0: trackedFiles() mencakup cli/*.ts dan src/*.ts top-level", () => {
  const scanned = new Set(trackedFiles())
  // Generik: WAJIB ada berkas top-level (tepat satu segmen direktori) dari
  // kedua direktori — bukan hard-code tiga nama berkas tertentu.
  const topCli = [...scanned].filter((f) => /^cli\/[^/]+\.ts$/.test(f))
  const topSrc = [...scanned].filter((f) => /^src\/[^/]+\.ts$/.test(f))
  expect(topCli.length).toBeGreaterThan(0)
  expect(topSrc.length).toBeGreaterThan(0)
  // Dan tiga situs yang pernah lolos harus tercakup sekarang.
  for (const f of ["cli/index.ts", "cli/commands.ts", "cli/auto-update.ts"]) {
    expect(scanned.has(f)).toBe(true)
  }
})

// ── T1: setiap titik efek samping terdaftar ────────────────────────────────
test("M15 T1: tak ada titik efek samping produksi yang tak terdaftar", () => {
  const unregistered: string[] = []
  for (const rel of trackedFiles()) {
    // Hanya yang benar-benar MEMANGGIL (bukan komentar/typeof).
    const src = trackedSource(rel)
    const hits = EFFECT_MARKERS.some((re) => re.test(src))
    if (hits && !EXECUTION_PATHS[rel]) unregistered.push(rel)
  }
  expect(unregistered).toEqual([])
})

// ── T2: entri tak menunjuk ke berkas yang sudah hilang ─────────────────────
test("M15 T2: entri inventaris menunjuk berkas nyata dengan penanda yang masih ada", () => {
  const stale: string[] = []
  for (const [rel, entry] of Object.entries(EXECUTION_PATHS)) {
    if (!existsSync(join(repoRoot, rel))) {
      stale.push(`${rel}: berkas tidak ada`)
      continue
    }
    const src = trackedSource(rel)
    // Entri boleh membuktikan diri dengan literal khusus (mis. `execFileAsync`
    // dari promisify), kalau tak ada cukup dengan salah satu penanda generik.
    const proven = entry.proof
      ? src.includes(entry.proof)
      : EFFECT_MARKERS.some((re) => re.test(src))
    if (!proven)
      stale.push(
        `${rel}: bukti "${entry.proof ?? "penanda efek samping"}" tak ada lagi (perbarui inventaris)`,
      )
  }
  expect(stale).toEqual([])
})

// ── T3: hanya src/runtime boleh jadi runtime-owned ─────────────────────────
test("M15 T3: runtime-owned hanya di src/runtime/**", () => {
  const wrong: string[] = []
  for (const [rel, entry] of Object.entries(EXECUTION_PATHS)) {
    if (entry.cls === "runtime-owned" && !rel.startsWith("src/runtime/")) wrong.push(rel)
  }
  expect(wrong).toEqual([])
})

// ── T4: tak ada spawn langsung di luar Runtime M5 + alat yang terdaftar ────
test("M15 T4: process creation hanya lewat M5 backend atau tool/integrasi terdaftar", () => {
  // Tidak ada "runtime-owned" spawn di luar src/runtime; dan tidak ada berkas
  // runtime lain yang spawn (M11 SQLite, bukan child process).
  const runtimeSpawners = Object.entries(EXECUTION_PATHS)
    .filter(([rel]) => rel.startsWith("src/runtime/") && /\bspawn\(/.test(trackedSource(rel)))
    .map(([rel]) => rel)
  expect(runtimeSpawners).toEqual(["src/runtime/execution-backend.ts"])
})

// ── T5: kelas "legacy-durable" bukan execution authority ──────────────────
test("M15 T5: durable legacy tak pernah meng-execute (hanya IO state)", () => {
  for (const [rel, entry] of Object.entries(EXECUTION_PATHS)) {
    if (entry.cls !== "legacy-durable") continue
    const src = trackedSource(rel)
    // Durable legacy boleh memanggil git plumbing (checkpoint/shadow-git) dan
    // SQLite; TIDAK boleh menjalankan tool/session/backend.
    // Type-only import dari ../tools/ bukan eksekusi (mis. CompletionEvidence);
    // yang dilarang adalah pemanggilan runtime tool/session/backend.
    expect(/import \{[^}]*\} from "\.\.\/tools\//.test(src)).toBe(false)
    expect(/from "\.\.\/app\//.test(src)).toBe(false)
    expect(/from "\.\.\/app\//.test(src)).toBe(false)
    expect(/runtime\/execution-backend/.test(src)).toBe(false)
  }
})
