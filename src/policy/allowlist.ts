import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { ToolCall } from "#minicore/core/types.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"

export interface Allowlist {
  allowed: string[] // entries like "bash:echo hi" or "write_file:.tmp/*"
}

const GLOBAL_ALLOW = join(homedir(), ".minicode", "allowlist.json")
const LOCAL_ALLOW = ".minicode/allowlist.json"

export async function loadAllowlist(
  cwd?: string,
  opts: { allowLocal?: boolean } = {},
): Promise<Allowlist> {
  let globalList: Allowlist = { allowed: [] }
  let localList: Allowlist = { allowed: [] }
  try {
    const txt = await readFile(GLOBAL_ALLOW, "utf8")
    const parsed = JSON.parse(txt) as Allowlist
    if (Array.isArray(parsed.allowed)) globalList = parsed
  } catch {}
  // Sama seperti config (audit #07 P0): allowlist lokal adalah input repo —
  // repo yang memberi dirinya sendiri "always" = persetujuan palsu. Hanya
  // dibaca bila operator opt-in; default = global saja.
  if (opts.allowLocal) {
    try {
      const path = resolve(cwd ?? process.cwd(), LOCAL_ALLOW)
      const txt = await readFile(path, "utf8")
      const parsed = JSON.parse(txt) as Allowlist
      if (Array.isArray(parsed.allowed)) localList = parsed
    } catch {}
  }
  // merge global+local, dedup
  const merged = new Set<string>([...globalList.allowed, ...localList.allowed])
  return { allowed: [...merged] }
}

export async function saveAllowlist(entry: string, cwd?: string, opts: { global?: boolean } = {}) {
  const path = opts.global ? GLOBAL_ALLOW : resolve(cwd ?? process.cwd(), LOCAL_ALLOW)
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
  let list: Allowlist = { allowed: [] }
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Allowlist
    if (Array.isArray(parsed.allowed)) list = parsed
  } catch {}
  if (!list.allowed.includes(entry)) list.allowed.push(entry)
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
  await atomicWriteText(path, JSON.stringify(list, null, 2))
}

export function matchAllowlist(call: ToolCall, allowlist: string[]): boolean {
  // Tanpa pemotongan: kunci = nama + JSON ARG PENUH. Versi lama memakai
  // `.slice(0, 200)` sehingga dua panggilan dengan 200-char prefix sama
  // berbagi kunci — entri "always" untuk perintah jinak panjang otomatis
  // me-allow perintah jahat dengan prefix sama (temuan audit #07, reproducer:
  // prefix 'A'x195 + tail jinak vs tail jahat → kunci terpotong identik).
  const key = `${call.name}:${JSON.stringify(call.args)}`
  return allowlist.some((pat) => {
    const safe = pat.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")
    const re = new RegExp(`^${safe}$`)
    if (pat.includes(":")) return re.test(key)
    return re.test(call.name) || re.test(key)
  })
}
