import type { Tool } from "#minicore"
import type { ApprovalEventHook, ApprovalHookEvent } from "../presentation/events.ts"

// Tanya user di tengah run — untuk pilihan yang tidak bisa diputuskan model
// sendiri (ambiguitas kebutuhan, kredensial, "lanjut/tidak").
//
// DI seperti delegate_task: view pertanyaan di-inject dari composition root
// (cli/setup.ts), lapisan tool tidak mengimpor src/ui. Tanpa injeksi atau di
// luar TTY tool MENOLAK jalan (fail-closed) — model harus memilih default
// yang aman sendiri, bukan mengarang jawaban user.

export type AskTextFn = (question: string, options?: string[]) => Promise<string | null>

let askTextFn: AskTextFn | undefined

export function setAskTextFn(fn: AskTextFn | undefined): void {
  askTextFn = fn
}

// Hook observability Fase 1 (pola sama seperti setAskTextFn): pertanyaan dan
// hasilnya dilaporkan sebagai approval.requested/settled TANPA mengubah
// perilaku fail-closed tool. toolCallId absen di sini — ToolContext kernel
// tidak membawa id call sendiri, dan pertanyaan ini memang ditujukan ke user
// langsung, bukan gate atas tool lain.
let askApprovalHook: ApprovalEventHook | undefined
let askApprovalCounter = 0

export function setAskApprovalHook(fn: ApprovalEventHook | undefined): void {
  askApprovalHook = fn
}

function emitAskApproval(e: ApprovalHookEvent): void {
  try {
    askApprovalHook?.(e)
  } catch {
    // Observability tak boleh menggagalkan tool.
  }
}

export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "Ask the user a clarifying question mid-run and wait for their answer. Use sparingly — only when blocked on a decision you cannot safely make alone. Fails outside an interactive terminal.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "single, clear question (max 2000 chars)" },
      options: {
        type: "array",
        items: { type: "string" },
        description: "suggested choices (may be empty); empty answer cancels",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  async execute({ question, options }, ctx) {
    ctx.signal.throwIfAborted()
    const q = String(question ?? "")
      .trim()
      .slice(0, 2000)
    if (!q) throw new Error("question empty")
    const opts = Array.isArray(options)
      ? (options as unknown[]).map((o) => String(o).slice(0, 200)).slice(0, 8)
      : undefined
    // Tanpa view ter-inject atau di luar TTY: tolak, jangan gantung.
    // Model harus melanjutkan dengan asumsi paling aman, bukan menunggu.
    const approvalId = `ap_${++askApprovalCounter}`
    const callInfo = { name: "ask_user", args: { question: q, options: opts } }
    if (!askTextFn) {
      emitAskApproval({ kind: "requested", approvalId, call: callInfo, via: "system" })
      emitAskApproval({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "deny", by: "system", reason: "no-view" },
      })
      throw new Error("ask_user unavailable: no question view injected (headless run?)")
    }
    if (!process.stdin.isTTY) {
      emitAskApproval({ kind: "requested", approvalId, call: callInfo, via: "system" })
      emitAskApproval({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "deny", by: "system", reason: "headless" },
      })
      throw new Error("ask_user unavailable: needs an interactive terminal")
    }
    emitAskApproval({ kind: "requested", approvalId, call: callInfo, via: "prompt" })
    let answer: string | null
    try {
      answer = await askTextFn(q, opts)
    } catch (e) {
      const aborted = (e instanceof Error && e.name === "AbortError") || ctx.signal.aborted
      emitAskApproval({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: aborted
          ? { decision: "cancelled", by: "system", reason: "parent-aborted" }
          : { decision: "deny", by: "system", reason: "prompt-error" },
      })
      throw e
    }
    if (answer == null || !answer.trim()) {
      emitAskApproval({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "deny", by: "user", reason: "declined" },
      })
      throw new Error("ask_user cancelled (empty answer)")
    }
    emitAskApproval({
      kind: "settled",
      approvalId,
      call: callInfo,
      outcome: { decision: "allow", by: "user" },
    })
    return answer.trim().slice(0, 4000)
  },
}
