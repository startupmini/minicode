// [Fase 2 / LOOP-INV-04, TOOL-01] SATU sumber kebenaran kontrak tool.
//
// Masalah yang ditutup: sebelum modul ini, klasifikasi efek samping tersebar di
// lima daftar manual yang bisa (dan pernah) menyimpang satu sama lain:
//
//   1. `WRITE_TOOLS` + `EXCLUSIVE_TOOLS`      (src/policy/executor.ts)
//   2. `GATED_TOOLS`                          (src/policy/permission.ts)
//   3. `MUTATION_TOOLS` + `NON_MUTATION_TOOLS`(src/session/journal.ts)
//   4. `EXPLORE_TOOL_NAMES`                   (src/tools/task.ts)
//   5. `TOOL_CAPABILITIES[].autonomous`       (src/task/autonomous-policy.ts)
//
// Semua daftar itu sekarang DITURUNKAN dari registry di bawah. Menambah tool
// baru berarti menambah satu entri di sini; tidak ada tempat lain untuk lupa.
//
// KEPUTUSAN PENTING — kenapa ada `journalMutation`:
//
// `sideEffectTier` menjawab "apakah tool ini mengubah sesuatu", sedangkan
// jurnal mutasi menjawab pertanyaan yang BERBEDA: "apakah efek ini perlu
// pasangan intent/terminal di jurnal mutasi?". `todo_write` mengubah plan
// (tier LOCAL_ENV_MUTATION) tetapi TIDAK dijurnal sebagai mutasi workspace,
// dan `web_fetch` punya efek eksternal tetapi tidak dijurnal. Menggabungkan
// keduanya akan mengubah perilaku recovery yang sudah teruji. Karena itu
// `journalMutation` dieksplisitkan, bukan disimpulkan.
//
// KEPUTUSAN PENTING — `code_run` sengaja `parallel-read`:
//
// Executor hari ini memperlakukan `code_run` sebagai non-write (bukan anggota
// WRITE_TOOLS/EXCLUSIVE_TOOLS), sehingga batch membacanya paralel. Mengubahnya
// menjadi `exclusive` di sini akan mengubah penjadwalan yang sudah teruji, yang
// bukan tujuan Fase 2. Klasifikasi disamakan dengan perilaku nyata; perbaikan
// penjadwalan (bila diinginkan) harus menjadi perubahan terpisah dengan bukti.

/** Kelas efek samping yang dideklarasikan sebuah tool. */
export type SideEffectTier =
  | "PURE_READ"
  | "WORKSPACE_MUTATION"
  | "LOCAL_ENV_MUTATION"
  | "EXTERNAL_IRREVERSIBLE"

/**
 * Kelas konkurensi untuk eksekutor batch.
 *
 * - `parallel-read`        boleh berjalan paralel dengan tool lain.
 * - `path-serialized-write` menulis workspace; butuh slot tulis + file-lock.
 * - `exclusive`            tidak punya path tunggal untuk dikunci; batch yang
 *                          memuatnya dijalankan sekuensial penuh.
 */
export type ConcurrencyClass = "parallel-read" | "path-serialized-write" | "exclusive"

export interface ToolContractMetadata {
  readonly name: string
  readonly sideEffectTier: SideEffectTier
  readonly concurrencyClass: ConcurrencyClass
  /** Di-gate approval secara default (izin generik tidak cukup). */
  readonly gatedByDefault: boolean
  /** Boleh terlihat oleh sub-agen mode `explore`. */
  readonly allowedInExplore: boolean
  /** Boleh dijalankan pada eksekusi otonom/background. */
  readonly allowedInAutonomous: boolean
  /** Efek yang diulang dengan input sama tidak menggandakan hasil. */
  readonly idempotent: boolean
  /** Butuh pasangan intent/terminal di jurnal mutasi (lihat catatan di atas). */
  readonly journalMutation: boolean
}

const C = (m: ToolContractMetadata): ToolContractMetadata => m

/**
 * Registry 37 tool bawaan. Urutan di sini adalah urutan tampilan/derivasi;
 * tidak ada konsumen yang boleh mengandalkan urutan selain derivasi daftar.
 */
export const TOOL_CONTRACTS: readonly ToolContractMetadata[] = [
  // ── PURE_READ ────────────────────────────────────────────────────────────
  C({
    name: "read_file",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "read_image",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "glob",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "grep",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "git_status",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "git_diff",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "git_log",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "read_memory",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "todo_read",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "mcp_list",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "lsp_diagnostics",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "lsp_definition",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "lsp_references",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "lsp_hover",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "lsp_symbols",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "lsp_workspace_symbols",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: true,
    allowedInAutonomous: true,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "bash_output",
    sideEffectTier: "PURE_READ",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: true,
    journalMutation: false,
  }),

  // ── WORKSPACE_MUTATION (path tunggal → slot tulis + file-lock) ───────────
  C({
    name: "write_file",
    sideEffectTier: "WORKSPACE_MUTATION",
    concurrencyClass: "path-serialized-write",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: true,
    journalMutation: true,
  }),
  C({
    name: "edit",
    sideEffectTier: "WORKSPACE_MUTATION",
    concurrencyClass: "path-serialized-write",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: true,
  }),
  C({
    name: "apply_patch",
    sideEffectTier: "WORKSPACE_MUTATION",
    concurrencyClass: "path-serialized-write",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: true,
  }),
  C({
    name: "move_file",
    sideEffectTier: "WORKSPACE_MUTATION",
    concurrencyClass: "path-serialized-write",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: true,
  }),
  C({
    name: "delete_file",
    sideEffectTier: "WORKSPACE_MUTATION",
    concurrencyClass: "path-serialized-write",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: true,
    journalMutation: true,
  }),

  // ── LOCAL_ENV_MUTATION ──────────────────────────────────────────────────
  C({
    name: "bash",
    sideEffectTier: "LOCAL_ENV_MUTATION",
    concurrencyClass: "exclusive",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: true,
  }),
  C({
    name: "bash_kill",
    sideEffectTier: "LOCAL_ENV_MUTATION",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: false,
  }),
  // Lihat catatan modul: perilaku paralel `code_run` dipertahankan apa adanya.
  C({
    name: "code_run",
    sideEffectTier: "LOCAL_ENV_MUTATION",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: true,
  }),
  C({
    name: "write_memory",
    sideEffectTier: "LOCAL_ENV_MUTATION",
    concurrencyClass: "exclusive",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: true,
  }),
  C({
    name: "forget_memory",
    sideEffectTier: "LOCAL_ENV_MUTATION",
    concurrencyClass: "exclusive",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: true,
    journalMutation: true,
  }),
  C({
    name: "todo_write",
    sideEffectTier: "LOCAL_ENV_MUTATION",
    concurrencyClass: "exclusive",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "submit_result",
    sideEffectTier: "LOCAL_ENV_MUTATION",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: false,
  }),
  C({
    name: "ask_user",
    sideEffectTier: "LOCAL_ENV_MUTATION",
    concurrencyClass: "parallel-read",
    gatedByDefault: true,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: false,
  }),

  // ── EXTERNAL_IRREVERSIBLE ───────────────────────────────────────────────
  C({
    name: "git_commit",
    sideEffectTier: "EXTERNAL_IRREVERSIBLE",
    concurrencyClass: "parallel-read",
    gatedByDefault: true,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: true,
  }),
  C({
    name: "delegate_task",
    sideEffectTier: "EXTERNAL_IRREVERSIBLE",
    concurrencyClass: "parallel-read",
    gatedByDefault: true,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: true,
  }),
  C({
    name: "mcp_call",
    sideEffectTier: "EXTERNAL_IRREVERSIBLE",
    concurrencyClass: "parallel-read",
    gatedByDefault: true,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: false,
    journalMutation: true,
  }),
  C({
    name: "mcp_read",
    sideEffectTier: "EXTERNAL_IRREVERSIBLE",
    concurrencyClass: "parallel-read",
    gatedByDefault: true,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "mcp_prompt",
    sideEffectTier: "EXTERNAL_IRREVERSIBLE",
    concurrencyClass: "parallel-read",
    gatedByDefault: true,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "web_fetch",
    sideEffectTier: "EXTERNAL_IRREVERSIBLE",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: true,
    journalMutation: false,
  }),
  C({
    name: "web_search",
    sideEffectTier: "EXTERNAL_IRREVERSIBLE",
    concurrencyClass: "parallel-read",
    gatedByDefault: false,
    allowedInExplore: false,
    allowedInAutonomous: false,
    idempotent: true,
    journalMutation: false,
  }),
]

const BY_NAME: ReadonlyMap<string, ToolContractMetadata> = new Map(
  TOOL_CONTRACTS.map((c) => [c.name, c]),
)

/** Nama tool yang dikenal registry ini (bukan tool MCP bertitik). */
export const TOOL_CONTRACT_NAMES: readonly string[] = TOOL_CONTRACTS.map((c) => c.name)

/**
 * Kontrak efektif untuk satu nama tool.
 *
 * Tool MCP runtime (`server.tool`) mewarisi kelas `mcp_call`: efek arbitrer di
 * server eksternal. Nama tak dikenal mengembalikan `undefined` supaya pemanggil
 * bisa fail-closed sendiri (jurnal memutuskan "unknown" = mutation).
 */
export function contractForTool(name: string): ToolContractMetadata | undefined {
  const direct = BY_NAME.get(name)
  if (direct !== undefined) return direct
  // Nama bertitik = tool MCP runtime. `includes(".")` sama dengan isMcpToolName
  // tanpa mengimpor lapisan presentasi dari policy (batas lapisan).
  if (name.includes(".")) return BY_NAME.get("mcp_call")
  return undefined
}

/** Derivasi: tool yang mengubah workspace dengan path tunggal. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.concurrencyClass === "path-serialized-write").map((c) => c.name),
)

/** Derivasi: tool yang harus eksklusif (tanpa path tunggal untuk dikunci). */
export const EXCLUSIVE_TOOLS: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.concurrencyClass === "exclusive").map((c) => c.name),
)

/** Derivasi: tool yang di-gate approval secara default. */
export const GATED_TOOLS: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.gatedByDefault).map((c) => c.name),
)

/** Derivasi: subset read-only untuk sub-agen `explore`. */
export const EXPLORE_TOOL_NAMES: readonly string[] = TOOL_CONTRACTS.filter(
  (c) => c.allowedInExplore,
).map((c) => c.name)

/** Derivasi: subset yang boleh dijalankan eksekusi otonom. */
export const AUTONOMOUS_TOOL_NAMES: readonly string[] = TOOL_CONTRACTS.filter(
  (c) => c.allowedInAutonomous,
).map((c) => c.name)

/**
 * Derivasi klasifikasi jurnal. Tool tak dikenal = "unknown", dan pemanggil
 * (`isMutationTool`) memperlakukannya sebagai mutasi (fail-closed).
 */
export function classifyContractTool(name: string): "mutation" | "none" | "unknown" {
  const c = contractForTool(name)
  if (c === undefined) return "unknown"
  return c.journalMutation ? "mutation" : "none"
}

/** True bila tool mengubah apa pun (bukan PURE_READ). */
export function isSideEffectingTool(name: string): boolean {
  const c = contractForTool(name)
  return c === undefined ? true : c.sideEffectTier !== "PURE_READ"
}
