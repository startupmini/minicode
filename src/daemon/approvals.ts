// P2.12 — otoritas persetujuan durable.
//
// Kenapa modul ini, bukan UI: kontrak memisahkan "UI menyetujui" dari
// "otoritas persetujuan". Di sini baris SQLite-lah yang memutuskan; konsumen
// Desktop hanya MENGUSULKAN. Persetujuan tetap ada dan bisa diaudit setelah
// prosesnya mati — bedanya dengan prompt layar yang hilang begitu jendela
// ditutup.
//
// Sifat yang dijaga:
//   - expiry/denied = DENY. Tak ada jalur "habis waktu lalu diizinkan".
//   - kegagalan penyimpanan = DENY (storage failure tak boleh menghasilkan
//     sukses yang dikarang).
//   - pending/requested pada saat daemon start -> UNKNOWN (lihat store.ts).

import { randomUUID } from "node:crypto"
import type { PermissionAsk } from "../policy/permission.ts"
import { hashArgs } from "../session/journal.ts"
import type { ApprovalView, RefusalBody } from "./protocol.ts"
import { sanitizeLabel } from "./sanitize.ts"
import {
  type ApprovalRow,
  createApproval,
  getApproval,
  listApprovals,
  listOpenApprovals,
  transitionApproval,
} from "./store.ts"

export type ApprovalDecision = "allow" | "deny"

export interface ApprovalRequestInput {
  sid: string
  runId?: string | null
  tool: string
  summary?: string
  ttlMs?: number
  /**
   * [Fase 2 / LOOP-INV-08] Hash argumen kanonis. Bila diberikan, keputusan
   * "allow" hanya berlaku untuk argumen yang hash-nya sama persis.
   */
  argsHash?: string | null
  /** Identitas pemanggilan (tool call id) yang di-approve. */
  invocationId?: string | null
}

interface Waiter {
  resolve: (d: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_TTL_MS = 60_000

/**
 * [Fase 2 / LOOP-INV-08] Validasi pengikatan approval terhadap pemanggilan
 * AKTUAL. Satu definisi, dipakai broker sebelum mengembalikan "allow" dan
 * tersedia bagi konsumen yang mengonsumsi baris approval secara terpisah.
 *
 * Fail-closed: ketiadaan pengikat (`null`) TIDAK berarti "cocok dengan apa
 * pun". Baris legacy hanya cocok bila sisi eksekusi juga tidak membawa hash/id.
 */
export function verifyApprovalBinding(
  row: Pick<ApprovalRow, "tool" | "argsHash" | "invocationId">,
  actual: { tool: string; argsHash?: string | null; invocationId?: string | null },
):
  | { ok: true }
  | { ok: false; reason: "tool-mismatch" | "args-hash-mismatch" | "invocation-mismatch" } {
  if (row.tool !== actual.tool) return { ok: false, reason: "tool-mismatch" }
  if ((row.argsHash ?? null) !== (actual.argsHash ?? null)) {
    return { ok: false, reason: "args-hash-mismatch" }
  }
  if ((row.invocationId ?? null) !== (actual.invocationId ?? null)) {
    return { ok: false, reason: "invocation-mismatch" }
  }
  return { ok: true }
}

function toView(row: ApprovalRow): ApprovalView {
  return {
    approvalId: row.approvalId,
    sid: row.sid,
    state: row.state,
    tool: row.tool,
    summary: row.summary,
    createdAt: row.requestedAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
  }
}

export interface ApprovalBrokerDeps {
  /** Incarnation daemon — melekat pada baris untuk melacak restart. */
  incarnation: string
  cwd?: string
  /** Kirim usulan ke konsumen terhubung (bisa no-op bila tak ada siapa pun). */
  propose: (view: ApprovalView) => void
  /** Diagnostik non-fatal (storage gagal, dsb.). */
  warn?: (msg: string) => void
}

export class ApprovalBroker {
  readonly #deps: ApprovalBrokerDeps
  readonly #waiters = new Map<string, Waiter>()

  constructor(deps: ApprovalBrokerDeps) {
    this.#deps = deps
  }

  /**
   * Catat permintaan + tunggu keputusan. Mengembalikan keputusan, atau "deny"
   * bila kedaluwarsa / tak ada yang menjawab / penyimpanan gagal.
   *
   * Sengaja TIDAK melempar: pemanggil adalah jalur permission — satu exception
   * tak tertangkap di sana mengubah "ditolak" jadi "crash sesi".
   */
  async request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    const ttl = Math.max(1_000, input.ttlMs ?? DEFAULT_TTL_MS)
    const approvalId = `apr_${randomUUID()}`
    const now = Date.now()
    const tool = sanitizeLabel(input.tool, 64)
    const argsHash = input.argsHash ?? null
    const invocationId = input.invocationId ?? null
    let view: ApprovalView
    try {
      const row = createApproval(
        {
          approvalId,
          sid: input.sid,
          runId: input.runId ?? null,
          tool,
          summary: sanitizeLabel(input.summary ?? "", 500),
          state: "requested",
          requestedAt: now,
          expiresAt: now + ttl,
          incarnation: this.#deps.incarnation,
          argsHash,
          invocationId,
        },
        this.#deps.cwd,
      )
      view = toView(row)
    } catch (e) {
      // Gagal mencatat = tak ada bukti yang bisa diaudit. Tolak, jangan lanjut
      // seolah ada yang menyetujui.
      this.#deps.warn?.(`[daemon] approval record failed: ${String((e as Error).message ?? e)}`)
      return "deny"
    }

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      const waiter: Waiter = { resolve, timer: null }
      this.#waiters.set(approvalId, waiter)
      waiter.timer = setTimeout(() => {
        this.#settle(approvalId, "deny", "expired")
      }, ttl)
      // Timer tak boleh menahan proses tetap hidup setelah selesai.
      waiter.timer.unref?.()
      try {
        transitionApproval(approvalId, "pending", {}, this.#deps.cwd)
      } catch (e) {
        this.#deps.warn?.(`[daemon] approval pending failed: ${String((e as Error).message ?? e)}`)
      }
      // Usulkan SETELAH state = pending, supaya konsumen yang menjawab cepat
      // tidak melihat status lama yang membuatnya menolak transisi sendiri.
      this.#deps.propose({
        ...view,
        state: "pending",
      })
    })

    // Konsumen mengirim "accept"; kita laporkan sebagai "allow" ke kernel.
    if (decision === "allow") {
      // [Fase 2 / LOOP-INV-08] Verifikasi pengikatan SEBELUM mengizinkan efek.
      // Baris yang di-approve harus cocok pada tool + hash argumen + identitas
      // pemanggilan. Baris hilang / legacy tanpa hash = tolak (fail-closed):
      // keputusan yang tak dapat dicocokkan bukan izin untuk argumen apa pun.
      const approved = getApproval(approvalId, this.#deps.cwd)
      const binding = approved
        ? verifyApprovalBinding(approved, { tool, argsHash, invocationId })
        : { ok: false as const, reason: "approval-row-missing" }
      if (!binding.ok) {
        this.#deps.warn?.(
          `[daemon] approval binding rejected (${binding.reason}) for ${tool}; denying`,
        )
        return "deny"
      }
    }
    return decision
  }

  /**
   * Keputusan dari konsumen. Idempoten: keputusan kedua untuk approval yang
   * sudah terminal mengembalikan hasil yang sama, bukan error — konsumen yang
   * retry setelah koneksi putus tidak boleh dihukum dengan penolakan palsu.
   */
  decide(
    approvalId: string,
    decision: "accept" | "deny",
    now = Date.now(),
  ): { ok: true; row: ApprovalRow } | { ok: false; refusal: RefusalBody } {
    const row = getApproval(approvalId, this.#deps.cwd)
    if (!row) {
      return {
        ok: false,
        refusal: { code: "NOT_FOUND", message: `approval ${approvalId} tidak ditemukan` },
      }
    }
    if (row.state === "accepted" || row.state === "denied") {
      const matches =
        (decision === "accept" && row.state === "accepted") ||
        (decision === "deny" && row.state === "denied")
      if (matches) return { ok: true, row }
      return {
        ok: false,
        refusal: {
          code: "APPROVAL_INVALID_STATE",
          message: `approval sudah ${row.state}; keputusan berbeda ditolak`,
        },
      }
    }
    if (row.state === "UNKNOWN") {
      // Hasil lama tak pernah diketahui — mengklaim "diterima/ditolak" sekarang
      // akan menulis keputusan yang tak pernah dibuat siapa pun.
      return {
        ok: false,
        refusal: {
          code: "APPROVAL_UNKNOWN",
          message: `approval ${approvalId} berstatus UNKNOWN (daemon restart)`,
        },
      }
    }
    if (row.state === "expired" || row.state === "cancelled") {
      return {
        ok: false,
        refusal: {
          code: "APPROVAL_EXPIRED",
          message: `approval ${approvalId} sudah ${row.state}`,
        },
      }
    }
    if (row.expiresAt !== null && row.expiresAt <= now) {
      // Lewat tenggat: tetap catat expired (bukan keputusan konsumen).
      const expired = this.#settle(approvalId, "deny", "expired")
      return {
        ok: false,
        refusal: {
          code: "APPROVAL_EXPIRED",
          message: `approval ${approvalId} kedaluwarsa pada ${row.expiresAt}`,
          detail: { expiredBy: now - row.expiresAt, ...(expired ? {} : {}) },
        },
      }
    }

    const target = decision === "accept" ? "accepted" : "denied"
    let updated: ApprovalRow
    try {
      updated = transitionApproval(approvalId, target, { decision, decidedAt: now }, this.#deps.cwd)
    } catch (e) {
      // Transisi tak sah = permintaan ganda yang saling bertabrakan; bukan
      // error protokol — laporkan apa adanya.
      return {
        ok: false,
        refusal: {
          code: "APPROVAL_INVALID_STATE",
          message: String((e as Error).message ?? e),
        },
      }
    }
    this.#settleWaiter(approvalId, decision === "accept" ? "allow" : "deny")
    return { ok: true, row: updated }
  }

  /** Selesaikan waiter dengan hasil tertentu tanpa mengubah state DB. */
  #settleWaiter(approvalId: string, decision: ApprovalDecision): void {
    const w = this.#waiters.get(approvalId)
    if (!w) return
    this.#waiters.delete(approvalId)
    if (w.timer) clearTimeout(w.timer)
    w.resolve(decision)
  }

  /** Pindahkan ke terminal lalu selesaikan waiter (dipakai timer expiry). */
  #settle(approvalId: string, decision: ApprovalDecision, state: "expired" | "cancelled"): boolean {
    try {
      transitionApproval(approvalId, state, { decision: state }, this.#deps.cwd)
    } catch {
      // [RC-6] Transisi gagal: settle waiter HANYA bila baris benar-benar sudah
      // terminal (perorangan decide/kadaluwarsa lain menang). Baris hilang atau
      // masih non-terminal = error nyata → jangan settle diam-diam.
      const row = getApproval(approvalId, this.#deps.cwd)
      if (!row) return false
      if (row.state === "requested" || row.state === "pending") return false
    }
    this.#settleWaiter(approvalId, decision)
    return true
  }

  list(sid: string): ApprovalView[] {
    try {
      return listApprovals(sid, this.#deps.cwd).map(toView)
    } catch {
      return []
    }
  }

  listOpen(sid: string): ApprovalView[] {
    try {
      return listOpenApprovals(sid, this.#deps.cwd).map(toView)
    } catch {
      return []
    }
  }

  /** Baca baris approval tanpa mutasi — untuk cek otoritas SEBELUM decide (RC-2). */
  read(approvalId: string): ApprovalRow | null {
    try {
      return getApproval(approvalId, this.#deps.cwd)
    } catch {
      return null
    }
  }

  /** Tutup semua waiter (daemon shutdown): keputusan tak pernah = izin. */
  shutdownAll(): number {
    const ids = [...this.#waiters.keys()]
    for (const id of ids) this.#settle(id, "deny", "cancelled")
    return ids.length
  }

  /**
   * Pasang jalur ask permission. Ini SATU-SATUNYA jembatan dari kernel ke
   * broker — composition root yang memasangnya (fail-closed tanpa injeksi).
   */
  asPermissionAsk(opts: { sid: () => string; runId?: () => string | null }): PermissionAsk {
    return async (call) => {
      const sid = opts.sid()
      if (!sid) return "deny"
      const tool = String(call?.name ?? "unknown")
      const decision = await this.request({
        sid,
        runId: opts.runId ? opts.runId() : null,
        tool,
        summary: summarizeArgs(call?.args),
        // [Fase 2 / LOOP-INV-08] Ikat keputusan ke argumen kanonis + id call.
        argsHash: hashArgs(call?.args ?? {}),
        invocationId: typeof call?.id === "string" && call.id !== "" ? call.id : null,
      })
      return decision === "allow" ? "allow" : "deny"
    }
  }
}

/** Ringkasan args untuk ditampilkan konsumen — dipangkas, dibasuh, dibatasi. */
function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return ""
  let text: string
  try {
    text = typeof args === "string" ? args : JSON.stringify(args)
  } catch {
    return ""
  }
  return sanitizeLabel(text, 300)
}
