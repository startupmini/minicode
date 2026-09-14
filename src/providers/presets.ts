// Gateway presets — satu sumber kebenaran untuk baseUrl umum.
// Dipakai /provider-add (REPL) & wizard setup (cli/wizard.ts).

export interface GatewayPreset {
  id: string
  label: string
  baseUrl: string
  fallbackModels: string[]
  hint?: string
  // beberapa gateway butuh header tambahan (x-api-key vs Bearer) —
  // deteksi hybrid sudah coba keduanya, preset cukup id+baseUrl.
}

export const GATEWAY_PRESETS: GatewayPreset[] = [
  {
    id: "openai",
    label: "OpenAI (gpt, o-series)",
    baseUrl: "https://api.openai.com/v1",
    fallbackModels: ["gpt-4o-mini", "gpt-4o", "o3-mini"],
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com",
    fallbackModels: ["claude-sonnet-4", "claude-opus-4", "claude-haiku-3.5"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (gateway 75+ model)",
    baseUrl: "https://openrouter.ai/api/v1",
    fallbackModels: [
      // ID gratis pertama terverifikasi live 2026-09-14 (pengganti
      // llama-3.1-8b-instruct:free yang sudah tak ada di katalog).
      // Free-tier OpenRouter berputar — bila wizard gagal, cek katalog.
      "nvidia/nemotron-3.5-lightning:free",
      "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o-mini",
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek (deepseek-chat/reasoner)",
    baseUrl: "https://api.deepseek.com/v1",
    fallbackModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "opencode-zen",
    label: "OpenCode Zen (opencode.ai gateway)",
    baseUrl: "https://opencode.ai/zen/v1",
    fallbackModels: [
      "muse-spark-1.2-contributor-free",
      "muse-spark-1.3-contributor-free",
      "nemotron-3.5-lightning:free",
      "nemotron-3-nano-30b-a3b:free",
      "gemini-2.0-flash:free",
      "deepseek-v4-flash:free",
      "claude-sonnet-4",
    ],
  },
  {
    id: "google",
    label: "Google Gemini (konteks 1M)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    fallbackModels: ["gemini-2.0-flash", "gemini-2.5-pro"],
  },
  // Local & open-weight — OpenCode-style BYOK $0
  {
    id: "ollama",
    label: "Ollama (local, free - no API key)",
    baseUrl: "http://localhost:11434/v1",
    fallbackModels: ["llama3.1", "qwen2.5-coder", "deepseek-coder"],
  },
  {
    id: "qwen",
    label: "Qwen (Alibaba Cloud, Qwen3-Coder)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    fallbackModels: ["qwen3-coder-plus", "qwen2.5-coder-32b-instruct"],
  },
  {
    id: "groq",
    label: "Groq (inferensi sangat cepat)",
    baseUrl: "https://api.groq.com/openai/v1",
    fallbackModels: ["llama-3.1-70b-versatile", "mixtral-8x7b-32768"],
  },
  {
    id: "together",
    label: "Together AI (model terbuka)",
    baseUrl: "https://api.together.xyz/v1",
    fallbackModels: ["meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo"],
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    fallbackModels: ["accounts/fireworks/models/llama-v3p1-405b-instruct"],
  },
  {
    id: "mistral",
    label: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    fallbackModels: ["mistral-large-latest", "codestral-latest"],
  },
  {
    id: "cohere",
    label: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    fallbackModels: ["command-r-plus"],
  },
  {
    id: "generic",
    label: "OpenAI-compatible umum (vLLM/LM Studio/lain)",
    baseUrl: "http://localhost:11434/v1",
    fallbackModels: ["llama3"],
  },
]

// id preset → opsi "custom" di ujung daftar
export const CUSTOM_PRESET_ID = "custom"

export function findPreset(id: string): GatewayPreset | undefined {
  return GATEWAY_PRESETS.find((p) => p.id === id)
}
