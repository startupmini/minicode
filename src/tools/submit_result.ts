import type { Tool } from "#minicore"

// Hasil terstruktur akhir task — pengganti response_format:json_schema yang
// tidak didukung semua provider. Tanpa tool ini model "menyimpulkan" dalam
// teks bebas dan CLI (exec --json) harus menebak batas JSON dari prosa.
// State per proses cukup: satu run CLI = satu sesi (seperti todoSession).

export interface SubmittedResult {
  result: unknown
  summary?: string
  at: number
}

let last: SubmittedResult | null = null

export function getSubmittedResult(): SubmittedResult | null {
  return last
}

export function clearSubmittedResult(): void {
  last = null
}

export const submitResultTool: Tool = {
  name: "submit_result",
  description:
    "Submit the final structured result of this task as a JSON object (instead of burying it in prose). Call once when done; exec --json surfaces it verbatim. If result.findings is an array of {category, severity, summary, evidence?}, those findings are also surfaced as finding.detected events.",
  parameters: {
    type: "object",
    properties: {
      result: {
        type: "object",
        description: "hasil akhir terstruktur (object JSON, bukan string)",
      },
      summary: { type: "string", description: "ringkasan satu baris untuk log" },
    },
    required: ["result"],
    additionalProperties: false,
  },
  async execute({ result, summary }, ctx) {
    ctx.signal.throwIfAborted()
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("result must be a JSON object")
    const s = typeof summary === "string" ? summary.slice(0, 300) : undefined
    last = { result, ...(s ? { summary: s } : {}), at: Date.now() }
    const bytes = JSON.stringify(result).length
    return `submitted (${bytes} bytes)${s ? `: ${s}` : ""}`
  },
}
