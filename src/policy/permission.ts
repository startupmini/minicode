import { resolve } from "node:path"
import { cwd } from "node:process"
import type { PermissionHandler, ToolCall } from "#minicore"
import type {
  ApprovalEventHook,
  ApprovalHookEvent,
  SideEffectTierDisplay,
} from "../presentation/events.ts"
import { isMcpToolName } from "../presentation/label.ts"
import { loadAllowlist, matchAllowlist, saveAllowlist } from "./allowlist.ts"
// [Area B · PROMPT 06] Binding persetujuan ↔ operasi yang dieksekusi.
import {
  type ApprovalBinding,
  type ApprovalBindingStore,
  captureApprovalBinding,
  verifyApprovalBinding,
} from "./approval-binding.ts"
import { inspectBashCommand } from "./bash-guard.ts"
import {
  isCwdOutsideRoot,
  isHookScript,
  isOwnedState,
  isOwnedStateReal,
  isRealPathOutsideRoot,
  isSensitive,
  isTrashRestore,
} from "./jail.ts"
import { scrubSecrets } from "./scrub.ts"
// [Fase 2 / TOOL-01] Diimpor dari registry kontrak tool (satu sumber).
import {
  contractForTool,
  GATED_TOOLS,
  PLAN_EXTRA_TOOL_NAMES,
  READONLY_TOOL_NAMES,
} from "./tool-contract.ts"

/**
 * Approval policy — DUA nilai yang berhadapan dengan pengguna.
 *
 * `auto` (AUTO) = eksekusi otonom penuh: selama capability & scope diizinkan,
 *     aksi berjalan TANPA henti persetujuan rutin. Bukan "izinkan semuanya" —
 *     hard-deny (jail/owned-state/bash-guard) tetap berlaku di atasnya.
 * `ask` (ASK)  = pengawasan manusia: aksi yang dicakup kebijakan persetujuan
 *     meminta izin sebelum jalan. Hard-deny tetap tak bisa di-override.
 *
 * Ejaan lowercase dipertahankan sebagai identitas internal/kompatibilitas
 * untuk AUTO/ASK (persistence & ToolContext memakai nilai ini).
 */
export type ApprovalMode = "auto" | "ask"

/**
 * Union kompatibilitas selama migrasi arsitektur mode.
 *
 * HANYA `"auto"`/`"ask"` adalah kebijakan persetujuan. Sisanya adalah profil
 * capability WARISAN yang kini menjadi tanggung jawab Tool Access Policy:
 *   - `"readonly"`   → capability read-only internal (bukan permukaan; batas
 *                      scheduler adalah injected AutonomousPermissionHandler,
 *                      BUKAN nilai ini).
 *   - `"plan"`       → ceiling WorkMode PLAN (perencanaan user-facing = PLAN).
 *   - `"allowlist"`  → kebijakan akses bash/tool (flag warisan --allowlist).
 *   - `"allow-all"`  → profil akses privileged (flag warisan --allow-all).
 */
export type PermissionMode = ApprovalMode | "readonly" | "plan" | "allow-all" | "allowlist"

/**
 * View persetujuan yang di-inject dari composition root (cli/setup.ts memakai
 * src/ui/approval/prompt.ts). Policy layer tidak pernah mengimpor UI langsung;
 * tanpa injeksi jawabannya selalu deny (headless), sama dengan perilaku
 * non-TTY sebelumnya.
 */
export type PermissionAsk = (call: {
  name: string
  args?: unknown
  /** [Fase 2 / LOOP-INV-08] Identitas pemanggilan untuk pengikatan approval. */
  id?: string
  /** F-APPROVAL-1: tier risiko efek samping (dari kontrak tool). */
  riskTier?: SideEffectTierDisplay
  /** F-APPROVAL-1: pratinjau diff ringkas (sudah di-scrub secret). */
  diffPreview?: string
  /** P1.2: `always` tersedia hanya bila args dapat dipersist (≤ 2 KB JSON). */
  canAlways?: boolean
}) => Promise<"allow" | "deny" | "always">

/** Batas args yang boleh dipersist sebagai grant `always` (fail-closed). */
const MAX_ALWAYS_ARGS_JSON = 2000

/** P1.2: satu sumber kebenaran untuk ketersediaan opsi `always`. */
export function canPersistAlways(args: unknown): boolean {
  try {
    return JSON.stringify(args).length <= MAX_ALWAYS_ARGS_JSON
  } catch {
    return false
  }
}

// [Fase 2 / TOOL-01] Satu sumber kebenaran: `READONLY_TOOLS` kini diturunkan
// dari registry kontrak tool (`allowedInReadonly`) — bukan lagi daftar manual
// yang bisa menyimpang dari `tool-contract.ts`. Menambah/mengganti tool read
// berarti mengubah `allowedInReadonly` di registry; tidak ada daftar kedua
// untuk lupa. Membership (termasuk in/out `web_fetch`/`web_search`) dipegang
// test no-drift di p15-phase2-contracts-approval-recovery.test.ts.
const READONLY_TOOLS: ReadonlySet<string> = READONLY_TOOL_NAMES
// Tool yang menulis state internal minicode (bukan file workspace) — aman
// di semua mode kecuali readonly/plan. `bash_kill` menghentikan proses yang
// dimulai agent sendiri, jadi tidak menambah permukaan serangan.
const INTERNAL_WRITE_TOOLS = new Set([
  "write_memory",
  "forget_memory",
  "todo_write",
  "submit_result",
  "bash_output",
  "bash_kill",
])

const FILE_WRITE_TOOLS = new Set(["write_file", "edit", "apply_patch", "move_file", "delete_file"])

// Subset INTERNAL_WRITE_TOOLS yang juga tidak perlu prompt di mode `ask`.
// `write_memory`/`forget_memory` TIDAK termasuk: itu menulis MEMORY.md yang
// persisten lintas sesi, jadi user berhak menyetujuinya. `submit_result`
// termasuk: ia hanya menyerahkan jawaban akhir, tanpa efek samping.
const NO_PROMPT_TOOLS = new Set(["todo_write", "submit_result", "bash_output", "bash_kill"])

// Tool yang memperbesar serangan / menembus dunia luar: tidak auto-allowed.
//
// `git_commit` ada di sini karena commit mengubah riwayat yang dibagikan —
// bukan sekadar file kerja. Di mode `auto` ia meminta persetujuan sekali
// (jawab `[a] Always` untuk persist), dan ditolak di readonly/plan/allowlist.
//
// `mcp_read`/`mcp_prompt` juga di-gate meski read-only: keduanya menarik konten
// dari server pihak ketiga langsung ke konteks model, yang merupakan jalur
// prompt-injection. `mcp_list` TIDAK di-gate karena hanya melaporkan metadata
// server yang sudah user daftarkan sendiri.
//
// `ask_user` di-gate: model yang bisa bertanya tanpa batas bisa membanjiri
// user (atau memancing jawaban kredensial) — persetujuan sekali per sesi
// via `[a] Always` tetap tersedia.

// Denylist bash kini di src/policy/bash-guard.ts — pemeriksaan dilakukan pada
// bentuk TERNORMALISASI (quote dibuang, variabel sederhana disubstitusi), bukan
// string mentah. Regex-atas-string-mentah yang lama trivially dilewati oleh
// `cat .e""nv`, `X=.env; cat $X`, `p=python3; $p -c 1`, dan `node --eval`.

// Perintah yang dianggap aman di mode `allowlist` — mode paling ketat, dipakai
// saat menjalankan task tak terpercaya. Isinya sengaja **read-only + build**:
// operasi tulis (`rm`, `mv`, `cp`, `mkdir`) TIDAK di sini, karena tujuan mode
// ini memang menahan efek samping. Agent yang butuh menulis file punya
// `write_file`/`edit` yang ter-jail, bukan shell.
//
// Perhatikan: allowlist diperiksa SETELAH bash-guard, jadi `cat *` di sini
// tidak berarti `cat .env` lolos — guard menolaknya lebih dulu. Pola di sini
// soal "bentuk perintah apa yang boleh", bukan "target apa yang boleh".
const DEFAULT_BASH_ALLOWLIST = [
  "git status*",
  "git diff*",
  "git log*",
  "git branch*",
  "git show*",
  "bun test*",
  "bun x tsc*",
  "bun run *",
  "npm run *",
  "npm exec *",
  "npx *",
  "echo *",
  "ls*",
  "dir*",
  "pwd",
  "cat *",
  // `type` = padanan `cat` di cmd.exe Windows (deskripsi tool bash menyuruh
  // model memakainya) — tanpanya tiap baca berkas via shell di Windows
  // gagal allowlist walau guard sudah menganggapnya reader aman.
  "type *",
  "head *",
  "tail *",
  "wc *",
  "grep *",
  "rg *",
  "find *",
  "which *",
  "node --version",
  "bun --version",
]

// 6.4 — npm exec / npx hanya di-allow bila arg "known-good": tak ada
// ekspansi shell ($/backtick) atau redirection (< >). Chaining ;|& sudah
// diblokir oleh matchBashAllowlist (pattern tak mengandungnya).
// Berlaku juga untuk `bun run`/`bun x`: keduanya menjalankan script/paket
// arbitrer dari package.json repo — tanpa cek ini `bun run test` di repo
// jahat lolos dengan ekspansi shell di argumennya.
function npmNpxSafe(cmd: string): boolean {
  return !/[`$<>]/.test(cmd)
}

function matchBashAllowlist(cmd: string, pattern: string): boolean {
  // prevent shell chaining bypass: if cmd contains ; & | and pattern does not explicitly allow them, deny.
  // F-20: newline adalah chaining juga (`echo hi\nenv`) — pola allowlist tak
  // pernah mengandung newline sehingga multiline selalu deny di mode ini
  // (fail-closed untuk mode paling ketat; skrip multiline sah milik auto).
  const trimmed = cmd.trim()
  if (/[;&|\n]/.test(trimmed) && !/[;&|]/.test(pattern)) return false
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    "i",
  )
  return re.test(trimmed)
}

// F-APPROVAL-1: pratinjau diff ringkas + representatif (satu baris) untuk kartu
// approval. Dikomputasi di policy — satu-satunya lapisan yang BOLEH memakai
// scrubSecrets (view tidak boleh impor src/policy). Bentuknya dipilih per-tool
// agar menggambarkan operasi NYATA (bash → perintah, tulis/edit → path + isi
// baru, hapus/pindah → tujuan, commit → pesan), bukan "ringkasan pendek" fiktif.
// Semua teks dibasuh secret; kegagalan apa pun = undefined (preview hanyalah
// informasi tambahan, bukan jalur keputusan gate).
function buildDiffPreview(name: string, args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined
  const a = typeof args === "object" ? (args as Record<string, unknown>) : {}
  const str = (v: unknown): string => (typeof v === "string" ? v : "")
  const line = (v: unknown, max = 120): string => {
    const s = typeof v === "string" ? v : String(v ?? "")
    const first = s.split(/\r?\n/)[0] ?? ""
    return first.length > max ? `${first.slice(0, max)}…` : first
  }
  const text = (content: unknown): string => {
    if (typeof content === "string") return content
    if (Array.isArray(content))
      return content
        .map((c) =>
          typeof c === "string"
            ? c
            : c && typeof c === "object" && "text" in c
              ? String((c as { text?: unknown }).text ?? "")
              : "",
        )
        .filter(Boolean)
        .join("\n")
    if (content && typeof content === "object" && "text" in content)
      return String((content as { text?: unknown }).text ?? "")
    return ""
  }
  // Basuh secret SEKALI di jalur keluar — path pun bisa memuat token; preview
  // tak pernah boleh membocorkannya ke kartu UI.
  const out = (raw: string): string | undefined => {
    const s = scrubSecrets(raw.trim()).trim()
    return s ? s.slice(0, 300) : undefined
  }
  try {
    switch (name) {
      case "bash": {
        const cmd = (str(a.cmd) || str(a.command)).trim()
        return cmd ? out(`$ ${cmd}`) : undefined
      }
      case "write_file": {
        const p = str(a.path)
        const head = line(text(a.content))
        return p ? out(`→ ${p}${head ? ` · ${head}` : ""}`) : undefined
      }
      case "edit": {
        const p = str(a.path)
        // Skema NYATA tool `edit` = `oldString`/`newString` (src/tools/edit.ts:133-142).
        // `old_string`/`new_string` dipakai sebagai fallback legacy — bukan
        // sebagai nama utama: memakai yang salah membuat preview kosong
        // (menampilkan "hanya path") untuk operasi yang sebenarnya mengganti
        // blok kode tertentu.
        const oldv = line(str(a.oldString ?? a.old_string), 80)
        const newv = line(str(a.newString ?? a.new_string), 80)
        const delta = `${oldv ? ` -${oldv}` : ""}${newv ? ` +${newv}` : ""}`
        return p ? out(`→ ${p}${delta}`) : undefined
      }
      case "apply_patch": {
        const p = str(a.path)
        // Skema NYATA tool `apply_patch` = `patches: [{search, replace}]`
        // (src/tools/patch.ts:18-35) — BUKAN `patch`/`diff`.
        const patches = Array.isArray(a.patches)
          ? (a.patches as { search?: unknown; replace?: unknown }[])
          : []
        if (patches.length > 0) {
          const first = patches[0] ?? {}
          const oldv = line(str(first.search), 80)
          const newv = line(str(first.replace), 80)
          const more = patches.length > 1 ? ` (+${patches.length - 1} blok)` : ""
          const delta = `${oldv ? ` -${oldv}` : ""}${newv ? ` +${newv}` : ""}`
          return p ? out(`→ ${p}${delta}${more}`) : undefined
        }
        const head = line(text(a.patch ?? a.diff))
        return p ? out(`→ ${p}${head ? ` · ${head}` : ""}`) : undefined
      }
      case "delete_file":
        return str(a.path) ? out(`- ${str(a.path)}`) : undefined
      case "move_file":
        return str(a.from) || str(a.to) ? out(`${str(a.from)} → ${str(a.to)}`) : undefined
      case "git_commit": {
        const m = line(str(a.message), 160)
        return m ? out(`commit ${m}`) : undefined
      }
      default: {
        // Generic: name + ringkasan key=value yang dibasuh — jangan JSON mentah
        // (struktur/token yang tak dikenal scrub bisa bocor).
        const keys = ["path", "file", "query", "pattern", "prompt", "url", "dir", "id", "name"]
        const parts: string[] = []
        for (const k of keys) {
          const v = a[k]
          if (typeof v === "string" && v) parts.push(`${k}=${line(v, 80)}`)
          else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`)
        }
        return parts.length ? out(`${name} ${parts.join(" ")}`) : undefined
      }
    }
  } catch {
    return undefined
  }
}

export function createPermissionHandler(
  opts: {
    mode?: PermissionMode
    root?: string
    ask?: PermissionAsk
    /** Teruskan flag --allow-local-config: allowlist lokal hanya dibaca bila
     * operator opt-in (default deny — repo tak bisa memberi dirinya always). */
    allowLocalConfig?: boolean
    /** Hook observability persetujuan (Fase 1 presentasi): dipanggil di
     * samping callback keputusan, bukan sebagai pengganti. Tanpa hook =
     * perilaku gate identik seperti dulu. Hook tak boleh melempar ke gate. */
    onApprovalEvent?: ApprovalEventHook
    /**
     * [Area B · PROMPT 06] Penyimpanan binding persetujuan milik SESI.
     *
     * Dipakai untuk dua hal: (1) menyimpan sidik jari args + file target
     * SAAT preview dibuat (sebelum prompt), lalu (2) mengikatkannya ke
     * keputusan "allow". Batas eksekusi (tool wrapper) memverifikasi ulang
     * sidik jari file target dan menolak operasi yang basi.
     *
     * Tanpa store = perilaku lama persis (tanpa verifikasi tambahan).
     */
    approvalBindings?: ApprovalBindingStore
    /**
     * Tool Access Policy — set nama tool yang DIOTORISASI sesi ini (tool yang
     * terlihat/terdaftar, termasuk MCP runtime `server.tool` yang servernya
     * terkonfigurasi). Dipakai `auto` untuk membedakan MCP terotorisasi dari
     * MCP tak-dikenal/tak-terkonfigurasi: hanya nama bertitik yang ADA di set
     * ini yang boleh auto-allow. Absen = fail-closed (semua MCP bertitik deny).
     */
    authorizedTools?: ReadonlySet<string> | null
    /**
     * [mode-architecture] Pembatas bash TERPISAH dari sumbu persetujuan.
     * Bila true, mode `auto` juga membatasi `bash` ke allow-list
     * (DEFAULT_BASH_ALLOWLIST / MINICODE_BASH_ALLOWLIST) — pola "no-sandbox"
     * (Windows) yang dulu diselipkan sebagai `mode: "allowlist"`. Mode
     * permission tetap `auto`/`ask`; ini hanya lapis kapabilitas bash.
     */
    restrictBash?: boolean
  } = {},
): PermissionHandler {
  const state = { mode: (opts.mode ?? "auto") as PermissionMode }
  const restrictBash = opts.restrictBash === true
  const root = resolve(opts.root ?? cwd())
  const approvalBindings = opts.approvalBindings
  const askUser = opts.ask
  const allowLocal = opts.allowLocalConfig === true
  const authorizedTools = opts.authorizedTools
  let allowlistCache: string[] | null = null
  // Persetujuan "always" sesi ini — in-memory, bukan dari disk. Tanpa ini,
  // jawaban always yang baru disimpan ke berkas lokal tak terlihat saat local
  // config nonaktif, dan user ditanya berulang untuk call yang sama.
  const sessionGrants: string[] = []
  // bash allowlist di-cache sekali (bukan baca env tiap panggilan)
  const envRaw = process.env.MINICODE_BASH_ALLOWLIST
  const bashAllowlist = envRaw
    ? envRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_BASH_ALLOWLIST

  async function getAllowlist(): Promise<string[]> {
    if (allowlistCache) return allowlistCache
    try {
      const l = await loadAllowlist(root, { allowLocal: allowLocal })
      allowlistCache = [...l.allowed, ...sessionGrants]
      return allowlistCache
    } catch {
      return [...sessionGrants]
    }
  }

  function isGated(name: string): boolean {
    // Semua tool bertitik (MCP — terdaftar maupun tidak) = gated. Server jahat
    // tidak boleh mendapat auto-allow hanya karena namanya terdaftar.
    return GATED_TOOLS.has(name) || isMcpToolName(name)
  }

  // Alasan deny per-call untuk seam kernel describeDenial (audit #14):
  // check() TETAP mengembalikan "deny" polos (kontrak Decision + semua
  // assertion tak berubah); alasannya dibaca kernel tepat setelah deny via
  // describeDenial(call) sehingga observasi model menjadi actionable
  // ("permission denied: bash-guard: destructive rm") alih-alih retry buta.
  // Map dibatasi + hapus-saat-baca agar abort di tengah tak bocor memori.
  const denyReasons = new Map<string, string>()
  function noteDeny(call: ToolCall, reason: string): void {
    try {
      const id = (call as { id?: string } | null)?.id
      if (!id) return
      if (denyReasons.size > 500) denyReasons.delete(denyReasons.keys().next().value as string)
      denyReasons.set(id, reason.slice(0, 160))
    } catch {}
  }
  function deny(call: ToolCall, reason: string): "deny" {
    noteDeny(call, reason)
    return "deny"
  }
  function takeDenyReason(call: ToolCall): string | undefined {
    try {
      const id = (call as { id?: string } | null)?.id
      if (!id) return undefined
      const r = denyReasons.get(id)
      denyReasons.delete(id)
      return r
    } catch {
      return undefined
    }
  }
  function bashDenyReason(cmd: string): string | null {
    if (!cmd.trim()) return "empty command"
    try {
      const v = inspectBashCommand(cmd, root)
      return v.denied ? (v.reason ?? "blocked command") : null
    } catch {
      return null
    }
  }

  // Jawaban prompt yang dilaporkan ke observability. "headless" = jalur
  // tanpa prompt (mantan early-return noTty): pemanggil memetakan ke
  // keputusan deny-nya sendiri agar alasan deny tak berubah.
  // "stale" = user menyetujui, tapi target berubah selama prompt → fail-closed.
  type GatedAnswer = "allow" | "deny" | "always" | "aborted" | "headless" | "stale"

  // Counter id persetujuan per handler (= per sesi): deterministik dan
  // test-friendly (tak perlu randomUUID untuk observability).
  let approvalCounter = 0

  function saveAlways(call: ToolCall): Promise<void> {
    // Simpan kunci PENUH (tanpa slice) agar simetris dengan matchAllowlist.
    // Arg raksasa (>2KB JSON, mis. write_file 1MB) tidak disimpan sama sekali
    // (fail-closed, minta persetujuan tiap kali) — kalau tidak allowlist.json
    // membengkak dan "always" menjadi blanket-allow untuk konten apa pun.
    if (!canPersistAlways(call.args)) return Promise.resolve()
    const argsJson = JSON.stringify(call.args)
    const key = `${call.name}:${argsJson}`
    if (!sessionGrants.includes(key)) sessionGrants.push(key)
    allowlistCache = null
    return saveAllowlist(key, root).catch(() => {})
  }

  // data-driven: tiap mode = satu fungsi keputusan (tanpa cabang saling tumpang tindih).
  // Param ketiga = signal turn (opsional): prompt yang belum terjawab saat
  // sesi dibatalkan harus kalah oleh abort (deny), bukan menunggu jawaban.
  const handlers: Record<
    PermissionMode,
    (
      call: ToolCall,
      args: Record<string, unknown> | null,
      signal?: AbortSignal,
    ) => Promise<"allow" | "deny">
  > = {
    "allow-all": async () => "allow",
    readonly: async (call) =>
      READONLY_TOOLS.has(call.name) ? "allow" : deny(call, "read-only mode"),
    // Plan = readonly + tiga perkecualian aman (PLAN_EXTRA_TOOL_NAMES):
    // todo_write (artefak rencana .minicode/plans, bukan file workspace),
    // delegate_task (penelahan rencana, bukan eksekusi — dipaksa explore/
    // read-only di task.ts bila parent plan/readonly, permission hanya membuka
    // gerbangnya), dan submit_result (singleton memori-proses untuk exec --json).
    plan: async (call) =>
      READONLY_TOOLS.has(call.name) || PLAN_EXTRA_TOOL_NAMES.has(call.name)
        ? "allow"
        : deny(call, "plan mode"),
    allowlist: async (call, args) => {
      if (call.name === "bash") {
        const cmd = (args?.cmd as string) ?? ""
        const br = bashDenyReason(cmd)
        if (br) return deny(call, `bash-guard: ${br}`)
        const matched = bashAllowlist.filter((pat) => matchBashAllowlist(cmd, pat))
        // Alasan actionable (keluhan eval: "no matching pattern" tanpa jalan
        // keluar membuat model retry buta): tulis/baca file = pakai tool file
        // terjail; shell penuh = operator pilih --allow-all/--sandbox docker.
        if (matched.length === 0)
          return deny(
            call,
            `allowlist: no matching pattern for "${cmd.slice(0, 80)}" — file work: use read_file/write_file/edit; full shell: rerun with --allow-all / --sandbox docker / MINICODE_BASH_ALLOWLIST`,
          )
        if (matched.some((p) => /^(npx|npm exec|bun x|bun run)\b/i.test(p)) && !npmNpxSafe(cmd))
          return deny(call, "allowlist: npm/npx unsafe")
        return "allow"
      }
      if (isGated(call.name)) return deny(call, "allowlist: gated tool")
      if (FILE_WRITE_TOOLS.has(call.name)) return "allow"
      if (INTERNAL_WRITE_TOOLS.has(call.name)) return "allow"
      return READONLY_TOOLS.has(call.name) ? "allow" : deny(call, "allowlist: not allowed here")
    },
    ask: async (call, args, signal) => {
      if (READONLY_TOOLS.has(call.name)) return "allow"
      // Bookkeeping internal tidak menyentuh workspace: todo list dan kontrol
      // job yang izinnya sudah diberikan saat `bash` dijalankan. Meminta
      // konfirmasi untuk ini hanya melelahkan tanpa menambah keamanan.
      if (NO_PROMPT_TOOLS.has(call.name)) return "allow"
      const list = await getAllowlist()
      if (matchAllowlist(call, list)) return "allow"
      if (call.name === "bash") {
        const cmd = (args?.cmd as string) ?? ""
        const br = bashDenyReason(cmd)
        if (br) return deny(call, `bash-guard: ${br}`)
      } else if (isGated(call.name)) {
        return await promptAskOr(call, () => deny(call, "gated approval unavailable"), signal)
      }
      const ans = await gatedPrompt(call, signal, askUser, false)
      if (ans === "headless") return "deny"
      // [Area B] "stale" = target berubah saat prompt → deny; alasan sudah
      // dicatat di `deny()` (jangan timpa dengan "declined by user").
      if (ans === "stale") return "deny"
      if (ans === "always") {
        await saveAlways(call)
        return "allow"
      }
      return ans === "allow" ? "allow" : "deny"
    },
    // AUTO = otonomi penuh. Selama tool diotorisasi oleh Tool Access Policy dan
    // scope mengizinkan, jalankan TANPA prompt persetujuan rutin. Ini berbeda
    // dari `ask` (di bawah) yang menahan tulis/eksekusi untuk izin manusia.
    //
    // Keputusan desain (mode-architecture recon): `gatedByDefault` TIDAK lagi
    // berarti "auto wajib prompt". Tool gated (git_commit, delegate_task,
    // mcp_call/read/prompt) adalah capability yang WAJIB Otorisasi — di ASK
    // mereka butuh izin manusia, tetapi di AUTO mereka jalan bila authorized.
    // Hard-deny (jail/owned-state/bash-guard) tetap berlaku di semua jalur.
    auto: async (call, args, _signal) => {
      if (READONLY_TOOLS.has(call.name)) return "allow"
      // ask_user = interaksi-user, bukan eksekusi. Di AUTO dilarang deterministik
      // (BLOCKED) supaya model memakai asumsi default sendiri — jangan biarkan
      // pergantian tanya-jawab rutin mengubah AUTO jadi ASK.
      if (call.name === "ask_user")
        return deny(call, "ask_user unavailable in AUTO (autonomous mode)")
      // Tool MCP bertitik: hanya diotorisasi bila terdaftar di sesi (server
      // terkonfigurasi). Tak dikenal/tak terkonfigurasi = deny, bukan prompt
      // (AUTO tak boleh bertanya sebagai jalan pintas hard-restriction).
      if (isMcpToolName(call.name)) {
        if (authorizedTools?.has(call.name)) return "allow"
        return deny(call, "MCP tool not configured/authorized")
      }
      // Capability gated (git_commit, delegate_task, mcp_call/read/prompt):
      // otonom di AUTO bila authorized. Scope dijaga tool-nya sendiri + jail
      // (git_commit: path/staged dijail; delegate: anak ter-ceiling WorkMode).
      if (GATED_TOOLS.has(call.name)) return "allow"
      if (FILE_WRITE_TOOLS.has(call.name)) return "allow"
      if (INTERNAL_WRITE_TOOLS.has(call.name)) return "allow"
      if (call.name === "code_run") {
        const sb = process.env.MINICODE_SANDBOX ?? ""
        if (sb !== "os" && sb !== "docker" && sb !== "bwrap" && sb !== "seatbelt")
          return deny(call, "code_run needs sandbox (os|docker)")
        return "allow"
      }
      if (call.name === "bash") {
        const cmd = (args?.cmd as string) ?? ""
        const br = bashDenyReason(cmd)
        if (br) return deny(call, `bash-guard: ${br}`)
        // restrictBash: bash hanya boleh pola allow-list (fallback no-sandbox).
        if (restrictBash) {
          const matched = bashAllowlist.filter((pat) => matchBashAllowlist(cmd, pat))
          if (matched.length === 0)
            return deny(
              call,
              `allowlist: no matching pattern for "${cmd.slice(0, 80)}" — file work: use read_file/write_file/edit; full shell: rerun with --allow-all / --sandbox docker / MINICODE_BASH_ALLOWLIST`,
            )
          if (matched.some((p) => /^(npx|npm exec|bun x|bun run)\b/i.test(p)) && !npmNpxSafe(cmd))
            return deny(call, "allowlist: npm/npx unsafe")
        }
        return "allow"
      }
      return deny(call, "not authorized in AUTO mode")
    },
  }

  const returned = {
    async check(call: ToolCall, _deps?: unknown): Promise<"allow" | "deny"> {
      const earlyArgs = call.args as Record<string, unknown> | null
      // Cancellation sebelum eksekusi mengalahkan segalanya: approval yang
      // datang terlambat (atau sesi yang sudah detach) tidak boleh membuka
      // gerbang. Kernel meneruskan signal turn di deps (executor kernel).
      const signal = (_deps as { signal?: AbortSignal } | null | undefined)?.signal
      if (signal?.aborted) return "deny"

      // universal file-path jail — harus sebelum allow-all (defense-in-depth)
      // realpath-based: symlink keluar workspace tetap tertangkap walau --allow-all
      if (
        call.name === "write_file" ||
        call.name === "edit" ||
        call.name === "apply_patch" ||
        call.name === "read_file" ||
        call.name === "read_image" ||
        call.name === "delete_file"
      ) {
        const p = (earlyArgs?.path as string) ?? ""
        if (!p) return "deny"
        if (isRealPathOutsideRoot(p, root)) return deny(call, "jail: outside workspace")
        if (isSensitive(p)) return deny(call, "jail: sensitive file")
      }
      // move_file punya dua ujung (from+to): keduanya dijail. `to` yang belum
      // ada jatuh ke cek logis di isRealPathOutsideRoot (fallback ENOENT).
      if (call.name === "move_file") {
        const f = (earlyArgs?.from as string) ?? ""
        const t = (earlyArgs?.to as string) ?? ""
        if (!f || !t) return "deny"
        if (isRealPathOutsideRoot(f, root) || isRealPathOutsideRoot(t, root))
          return deny(call, "jail: outside workspace")
        if (isSensitive(f) || isSensitive(t)) return deny(call, "jail: sensitive file")
      }
      if (call.name.startsWith("lsp_")) {
        const f = (earlyArgs?.file as string) ?? ""
        if (f && isRealPathOutsideRoot(f, root)) return deny(call, "jail: outside workspace")
        if (f && isSensitive(f)) return deny(call, "jail: sensitive file")
      }
      const cwdArg = (earlyArgs?.cwd as string) ?? ""
      if (
        cwdArg &&
        (call.name === "bash" ||
          call.name === "glob" ||
          call.name === "grep" ||
          call.name.startsWith("git_"))
      ) {
        if (isCwdOutsideRoot(cwdArg, root) || isRealPathOutsideRoot(cwdArg, root))
          return deny(call, "jail: cwd outside workspace")
      }
      // git_commit: path yang di-stage juga dijail, bukan hanya cwd.
      if (call.name === "git_commit" && Array.isArray(earlyArgs?.paths)) {
        for (const p of earlyArgs.paths as unknown[]) {
          if (typeof p !== "string") continue
          if (isRealPathOutsideRoot(p, root)) return deny(call, "jail: outside workspace")
          if (isSensitive(p)) return deny(call, "jail: sensitive file")
        }
      }
      // State milik minicode (temuan audit #04, dikeraskan audit #13):
      // tool TULIS file dilarang menyentuh apa pun di bawah `.minicode/`
      // (dulu daftar-nama: `test-write.txt` lolos). Tanpa ini sub-agen (atau
      // call ter-injeksi) bisa menanam file, menimpa todos/rencana,
      // menanam allowlist "always", mendaftarkan server MCP via config,
      // atau membutakan recovery (jurnal/checkpoint) lewat jalur jinak.
      // Berlaku di SEMUA mode termasuk allow-all (jail mendahului mode).
      // BACA tetap boleh; tool khusus (todo/memory/config/undo) tak lewat
      // gerbang ini sehingga alur legit tetap jalan. Pengecualian:
      // restore `.minicode/.trash/` → workspace (isTrashRestore) dan skrip
      // hooks `.minicode/hooks/` (HOOKS_RE di jail.ts — registrasi eksekusi
      // tetap dikunci via allowlist.json yang owned).
      // KUNCI GANDA (audit 2026-09-22 F-CRIT): batas string di atas dilewati
      // link internal (junction/symlink → `.minicode/`), jadi target NYATA
      // ikut dicek — pola yang sama dengan proteksi workspace
      // (isRealPathOutsideRoot) dan TOCTOU pembaca. `resolveOwnedReal`
      // memakai best-effort realpath agar symlink INTERNAL SAH (mis. tautan
      // repositori ke berkas biasa di luar `.minicode/`) tetap bisa ditulis,
      // sesuai kontrak "targetnya yang dicek" di safe-open.ts.
      if (
        call.name === "write_file" ||
        call.name === "edit" ||
        call.name === "apply_patch" ||
        call.name === "delete_file" ||
        call.name === "move_file"
      ) {
        const rawTargets =
          call.name === "move_file"
            ? ([(earlyArgs?.from as string) ?? "", (earlyArgs?.to as string) ?? ""] as const)
            : ([(earlyArgs?.path as string) ?? ""] as const)
        // Carve-out sah (string mentah): restore `.minicode/.trash/` →
        // workspace dan skrip `.minicode/hooks/` — satu-satunya gerak sah
        // yang menyentuh state. Cek string dulu supaya jalur sah (yang target
        // nyatanya justru `.minicode/`) tidak ikut ditahan kunci realpath.
        if (call.name === "move_file") {
          const f = rawTargets[0] ?? ""
          const t = rawTargets[1] ?? ""
          if (isTrashRestore(f, t)) {
            // lanjut ke mode check di bawah (ask/auto tetap berlaku)
          } else if (
            (f !== "" && isOwnedState(f)) ||
            (t !== "" && isOwnedState(t)) ||
            rawTargets.some((p) => p !== "" && isOwnedStateReal(p, root))
          ) {
            return deny(call, "jail: owned state")
          }
        } else {
          const p = rawTargets[0] ?? ""
          if (p !== "" && (isOwnedState(p) || (!isHookScript(p) && isOwnedStateReal(p, root)))) {
            return deny(call, "jail: owned state")
          }
        }
      }

      const mode = state.mode
      if (mode === "allow-all") {
        // allow-all tetap menolak bash berbahaya — izin penuh bukan berarti
        // mengizinkan `rm -rf /` atau fork bomb. Yang dicek di sini FULL
        // inspectBashCommand (bukan sebagian), sama seperti mode lain.
        if (call.name === "bash") {
          const cmd = (earlyArgs?.cmd as string) ?? ""
          // allow-all + cmd kosong = allow (perilaku lama dipertahankan).
          if (cmd.trim()) {
            const br = bashDenyReason(cmd)
            if (br) return deny(call, `bash-guard: ${br}`)
          }
        }
        return "allow"
      }

      return handlers[state.mode](call, earlyArgs, signal)
    },
    // Kontrol mode saat runtime (Shift+Tab di TUI). Sebelumnya kedua method ini
    // hanya ada di type-cast tanpa implementasi, sehingga pemanggilnya no-op /
    // TypeError dan mode permission tidak pernah benar-benar berubah.
    __setMode(m: PermissionMode): void {
      state.mode = m
      allowlistCache = null
    },
    __getMode(): PermissionMode {
      return state.mode
    },
    __getRestrictBash(): boolean {
      return restrictBash
    },
    // Seam kernel describeDenial: alasan deny terakhir call ini (dicatat
    // check() via deny()). Hapus-saat-baca; tak ada catatan = undefined =
    // pesan deny polos seperti dulu.
    describeDenial(call: ToolCall): string | undefined {
      return takeDenyReason(call)
    },
    // Seam P0.2 (Q2): gerbang approval paksaan untuk network read (`web_fetch`,
    // `web_search`) saat WorkMode PLAN aktif. Memakai jalur gated yang SAMA
    // (`promptAskOr`: TTY + ask wajib, allowlist grant berlaku, headless = deny)
    // sehingga observability persetujuan & alasan deny tetap kanonik.
    async __promptGated(call: ToolCall, _deps?: unknown): Promise<"allow" | "deny"> {
      const signal = (_deps as { signal?: AbortSignal } | null | undefined)?.signal
      if (signal?.aborted) return "deny"
      return promptAskOr(call, () => deny(call, "gated approval unavailable"), signal)
    },
  }
  return returned as unknown as PermissionHandler & {
    __setMode(m: PermissionMode): void
    __getMode(): PermissionMode
    __getRestrictBash(): boolean
    describeDenial(call: ToolCall): string | undefined
    __promptGated(call: ToolCall, deps?: unknown): Promise<"allow" | "deny">
  }

  // Balapan prompt melawan abort: jawaban yang tiba SETELAH sesi dibatalkan
  // tidak boleh membuka gerbang (late approval = deny). Tanpa ini, user yang
  // menekan [y] sepersekian detik setelah Ctrl+C tetap mengeksekusi tool.
  function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | "aborted"> {
    if (!signal) return p
    if (signal.aborted) return Promise.resolve("aborted")
    return Promise.race([
      p,
      new Promise<"aborted">((res) =>
        signal.addEventListener("abort", () => res("aborted"), { once: true }),
      ),
    ])
  }

  function emitApprovalSafe(e: ApprovalHookEvent): void {
    try {
      opts.onApprovalEvent?.(e)
    } catch {
      // Observability tak boleh menggagalkan gate.
    }
  }

  // Satu-satunya pembungkus prompt: emit requested sebelum + settled sesudah
  // untuk SEMUA jalur prompt (gated via promptAskOr maupun inline mode ask).
  // Allowlist-hit TIDAK lewat sini (keputusan policy, bukan persetujuan).
  //
  // `requireTTY`: hanya jalur GATED (promptAskOr) yang dulu menolak non-TTY
  // sebelum prompt — mode `ask` non-gated tidak pernah mengecek isTTY (lihat
  // kode lama: `askUser ? raceAbort(...) : "deny"`). Memaksa TTY di kedua
  // jalur akan membalik keputusan headless-injected-ask (regresi test matrix).
  async function gatedPrompt(
    call: ToolCall,
    signal: AbortSignal | undefined,
    ask: PermissionAsk | undefined,
    requireTTY: boolean,
  ): Promise<GatedAnswer> {
    const headless = signal?.aborted === true || !ask || (requireTTY && !process.stdin.isTTY)
    const approvalId = `ap_${++approvalCounter}`
    const callInfo = { id: call.id, name: call.name, args: call.args }
    // F-APPROVAL-1: tier risiko efek samping dari kontrak tool — absen/kontrak
    // tak dikenal = UNKNOWN (jelas, bukan tebakan). Tidak mengubah keputusan gate.
    const riskTier = contractForTool(call.name)?.sideEffectTier ?? "UNKNOWN"
    // F-APPROVAL-1: pratinjau diff yang REPRESENTATIF (per-tool) + sudah
    // di-scrub secret — dihitung di policy karena hanya policy yang boleh
    // memanggil scrubSecrets. Absen = tidak ada preview yang layak, kartu UI
    // tetap menampilkan ringkasan args yang ada (fallback tak berubah).
    const diffPreview = buildDiffPreview(call.name, call.args)
    // [Area B · PROMPT 06] TANGKAP sidik jari operasi SEBELUM prompt. Ini
    // "apa yang dilihat user": argumen + isi file target pada saat preview
    // dibuat. Diambil sebelum `ask` karena `ask` bisa mengubah dunia (user
    // sendiri atau proses lain bisa menulis file sementara prompt terbuka) —
    // kalau sidik jari diambil SETELAH prompt, kita memverifikasi state yang
    // tidak pernah dilihat user.
    const capturedBinding: ApprovalBinding | null = approvalBindings
      ? captureApprovalBinding(call.name, call.args, root)
      : null
    emitApprovalSafe({
      kind: "requested",
      approvalId,
      call: callInfo,
      via: headless ? "system" : "prompt",
      riskTier,
      ...(diffPreview ? { diffPreview } : {}),
    })
    let ans: "allow" | "deny" | "always" | "aborted"
    try {
      // Headless = tanpa prompt (ask tak tersedia / [gated: bukan TTY] / sudah
      // abort): jawaban "deny" tanpa memanggil view — pemanggil memetakan ke
      // keputusan deny-nya sendiri agar alasan deny tak berubah.
      // F-APPROVAL-1: tier + diff diteruskan ke view agar kartu approval
      // menunjukkan bukti yang SAMA dengan yang user setujui (bukan ringkasan
      // terpisah yang bisa menyimpang dari operasi yang benar dieksekusi).
      ans =
        headless || !ask
          ? "deny"
          : await raceAbort(
              ask({
                id: call.id,
                name: call.name,
                args: call.args,
                riskTier,
                diffPreview,
                canAlways: canPersistAlways(call.args),
              }),
              signal,
            )
    } catch (e) {
      emitApprovalSafe({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "deny", by: "system", reason: "prompt-error" },
      })
      throw e
    }
    if (ans === "aborted") {
      emitApprovalSafe({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "cancelled", by: "system", reason: "parent-aborted" },
      })
      return ans
    }
    if (headless) {
      emitApprovalSafe({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: {
          decision: "deny",
          by: "system",
          reason: signal?.aborted
            ? "parent-aborted"
            : !ask
              ? "no-ask"
              : requireTTY && !process.stdin.isTTY
                ? "headless"
                : "no-ask",
        },
      })
      return "headless"
    }
    if (ans === "always" || ans === "allow") {
      // [Area B · PROMPT 06] Verifikasi lapis-1: persetujuan diberikan user
      // untuk state file TERTENTU. Bila target berubah selama prompt
      // terbuka, operasi yang disetujui ≠ operasi yang akan dieksekusi →
      // FAIL-CLOSED: tolak, jangan jalankan.
      //
      // Verifikasi ini terjadi SEBELUM intent jurnal ditulis (barrier efek
      // ada di lapisan app), jadi jurnal tak pernah memuat intent untuk
      // operasi yang memang ditolak.
      if (capturedBinding) {
        const verdict = verifyApprovalBinding(capturedBinding)
        if (verdict.kind === "stale") {
          emitApprovalSafe({
            kind: "settled",
            approvalId,
            call: callInfo,
            outcome: { decision: "deny", by: "system", reason: "approval-stale" },
          })
          deny(call, `approval stale: ${verdict.reason}`)
          return "stale"
        }
      }
    }
    if (ans === "always") {
      emitApprovalSafe({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "allow-always", by: "user" },
      })
      // [Area B] Grant dibuat untuk call yang SEDANG berjalan: allowlist
      // membuat call berikutnya lolos tanpa prompt, jadi tak ada bukti baru
      // yang bisa diverifikasi — call ini masih terikat ke bukti yang user
      // benar-benar setujui.
      if (capturedBinding) approvalBindings?.grant(capturedBinding)
      return ans
    }
    emitApprovalSafe({
      kind: "settled",
      approvalId,
      call: callInfo,
      outcome:
        ans === "allow"
          ? { decision: "allow", by: "user" }
          : { decision: "deny", by: "user", reason: "declined" },
    })
    // [Area B] Izin berlaku untuk operasi yang disetujui saja.
    if (ans === "allow" && capturedBinding) approvalBindings?.grant(capturedBinding)
    return ans
  }

  async function promptAskOr(
    call: ToolCall,
    noTty: () => "deny",
    signal?: AbortSignal,
  ): Promise<"allow" | "deny"> {
    if (signal?.aborted) return noTty()
    // Headless (tanpa ask / non-TTY) TETAP lewat gatedPrompt agar
    // requested+settled ter-emit (observability Fase 1); keputusan deny
    // dipetakan pemanggil seperti early-return noTty lama. TTY wajib di
    // jalur GATED (requireTTY=true) — pola lama promptAskOr.
    if (!askUser || !process.stdin.isTTY) {
      await gatedPrompt(call, signal, askUser, true)
      return noTty()
    }
    const list = await getAllowlist()
    if (matchAllowlist(call, list)) return "allow"
    const ans = await gatedPrompt(call, signal, askUser, true)
    if (ans === "headless") return noTty()
    if (ans === "aborted") return "deny"
    // [Area B] "stale" = target berubah saat prompt → deny; alasan sudah
    // dicatat di `deny()` (jangan timpa dengan "declined by user").
    if (ans === "stale") return "deny"
    if (ans === "always") {
      await saveAlways(call)
      return "allow"
    }
    return ans === "allow" ? "allow" : deny(call, "declined by user")
  }
}
