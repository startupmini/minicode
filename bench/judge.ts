// LLM-judge terpisah untuk kualitas penjelasan (audit #14 fase 2).
//
// Aturan main: judge BUKAN aktor (model berbeda, tanpa tools, tanpa konteks
// sesi) — menilai teks final saja. Skor 0-2 + alasan satu baris, format
// mesin `SCORE: <0|1|2>` agar bisa diparse deterministik. Gagal parse =
// null (bukan 0) — jangan menghukum jawaban karena judge ngelantur.

import type { ModelProvider } from "#minicore"

export interface JudgeInput {
  taskDescription: string
  taskPrompt: string
  answer: string
  verifyPassed: boolean
  verifyDetail?: string
}

/** Murni + diekspor agar teruji tanpa API. */
export function buildJudgePrompt(input: JudgeInput): string {
  const answer = input.answer.slice(0, 1500)
  return [
    "You are an impartial judge of a coding agent's final answer.",
    "Score ONLY the answer text below against the task. Ignore how it was produced.",
    "Rubric:",
    "0 = wrong outcome, empty, or refusal disguised as completion.",
    "1 = correct outcome but no explanation (bare code/diff with no reasoning).",
    "2 = correct outcome AND explains root cause/fix AND mentions how it was verified.",
    `Task: ${input.taskDescription}`,
    `Request: ${input.taskPrompt.slice(0, 500)}`,
    `Automated check: ${input.verifyPassed ? "PASSED" : "FAILED"}${input.verifyDetail ? ` (${input.verifyDetail.slice(0, 300)})` : ""}`,
    "Answer to judge:",
    "```",
    answer || "(empty)",
    "```",
    'Reply with exactly two lines: "SCORE: <0, 1, or 2>" then "REASON: <one line>".',
  ].join("\n")
}

/** Murni + diekspor agar teruji. null = tak terparse (bukan vonis). */
export function parseJudgeScore(text: string): { score: 0 | 1 | 2; reason: string } | null {
  const m = /SCORE:\s*([012])\b/.exec(text)
  if (!m) return null
  const reason = /REASON:\s*(.+)/.exec(text)?.[1]?.trim().slice(0, 200) ?? ""
  return { score: Number(m[1]) as 0 | 1 | 2, reason }
}

export interface JudgeResult {
  score: 0 | 1 | 2 | null
  reason: string
  model: string
}

/** Satu request tanpa tools, timeout diketatkan. Kegagalan judge = null, tak pernah melempar. */
export async function judgeAnswer(
  provider: ModelProvider,
  input: JudgeInput,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<JudgeResult> {
  const model = opts.model ?? "judge"
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000)
  try {
    let text = ""
    for await (const ev of provider.stream(
      {
        messages: [{ role: "user", content: buildJudgePrompt(input) }],
        ...(model ? { model } : {}),
      },
      ctrl.signal,
    )) {
      const t = ev as { type?: string; text?: unknown }
      if (t.type === "text" && typeof t.text === "string") text += t.text
    }
    const parsed = parseJudgeScore(text)
    if (!parsed) return { score: null, reason: text.slice(0, 200), model }
    return { ...parsed, model }
  } catch (e) {
    return { score: null, reason: `judge error: ${(e as Error).message.slice(0, 120)}`, model }
  } finally {
    clearTimeout(timer)
  }
}
