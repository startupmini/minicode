import type { Tool } from "#minicore"

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
    if (!askTextFn)
      throw new Error("ask_user unavailable: no question view injected (headless run?)")
    if (!process.stdin.isTTY) throw new Error("ask_user unavailable: needs an interactive terminal")
    const answer = await askTextFn(q, opts)
    if (answer == null || !answer.trim()) throw new Error("ask_user cancelled (empty answer)")
    return answer.trim().slice(0, 4000)
  },
}
