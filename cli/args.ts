// Pure arg-parsing helpers - dipisah dari cli/index.ts agar mudah diuji.
const BOOLEAN_FLAGS = new Set([
  "--verbose",
  "--allow-all",
  "--ask",
  "--plan",
  "--interactive",
  "--verify",
  "--allowlist",
  "--json", // dipakai `exec --json` dan `--help --json`
  "--budget-strict", // penegasan eksplisit fail-closed (kini juga default --budget)
  "--allow-local-config", // opt-in: baca .minicode/config.json + allowlist lokal (default mati)
])
const VALUE_FLAGS = new Set([
  "--cwd",
  "--resume",
  "--model",
  "--provider",
  "--session",
  "--max-steps",
  "--context-window",
  "--timeout",
  "--sandbox",
  "--ratelimit",
  "--budget",
  "--tool-scope", // full | explore (read-only) — tanpa ini jadi kata prompt!
  "--output-format", // `exec --output-format=json`
  "--prompt",
  // subcommand flags — harus dikenal agar tidak bocor ke prompt one-shot
  "--baseUrl",
  "--apiKey",
  "--id",
  "--command",
  "--args",
  "--env",
  "--header",
  "--allow-private",
  "--url",
  "--match",
  "--jsonl",
  "--all-tools",
  "--global",
  "--local",
])
export const valueFlags = VALUE_FLAGS
const KNOWN_FLAGS = new Set([...BOOLEAN_FLAGS, ...VALUE_FLAGS, "-h", "--help", "-v", "--version"])

/** `--flag` atau `--flag=value` -> normalisasi ke nama flag murni. */
export function flagNameOf(token: string): string | null {
  if (!token.startsWith("-")) return null
  const eq = token.indexOf("=")
  const name = eq === -1 ? token : token.slice(0, eq)
  return KNOWN_FLAGS.has(name) ? name : null
}

export function hasFlag(argv: string[], name: string): boolean {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token) continue
    if (token === "--") return false
    const flag = flagNameOf(token)
    if (flag) {
      if (token === name || token.startsWith(`${name}=`)) return true
      if (valueFlags.has(flag) && !token.includes("=")) i++
      continue
    }
    if (token.startsWith("-")) {
      // unknown flag seperti "-5" untuk nilai numerik sudah di-skip sebagai value di atas
      // bila sampai sini, itu prompt atau flag tak dikenal -> hentikan scan
      if (/^-?\d+(\.\d+)?$/.test(token)) {
        // "-5" tanpa flag sebelumnya bukan flag, anggap prompt
        return false
      }
      // unknown flag -> prompt boundary, bukan flag global
      return false
    }
    // prompt word pertama -> sisa argv adalah prompt, bukan flag
    return false
  }
  return false
}

/** Opt-in config lokal untuk alur sesi utama (index/exec): flag eksplisit
 * operator ATAU env (keduanya default mati). Memakai hasFlag yang
 * boundary-aware: flag di DALAM teks prompt tidak dihitung (anti-injeksi).
 * Handler subcommand (config/providers/…) memakai args.includes langsung
 * karena argv-nya selalu diawali positional subcommand. */
export function allowLocalConfig(argv: string[]): boolean {
  return hasFlag(argv, "--allow-local-config") || process.env.MINICODE_ALLOW_LOCAL_CONFIG === "1"
}

export function getArg(argv: string[], name: string): string | undefined {
  // dukung bentuk --name value DAN --name=value; ambil kemunculan terakhir
  // (flag berulang -> yang terakhir menang, konsisten dengan CLI umum)
  let found: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) break
    if (a === "--") break
    const flag = flagNameOf(a)
    if (flag) {
      if (a === name) {
        const v = argv[i + 1]
        if (v !== undefined && (v === "-" || !v.startsWith("-") || /^-?\d+(\.\d+)?$/.test(v)))
          found = v
        if (valueFlags.has(flag) && !a.includes("=")) i++
        continue
      } else if (a.startsWith(`${name}=`)) {
        const v = a.slice(name.length + 1)
        if (v !== "") found = v
        continue
      }
      if (valueFlags.has(flag) && !a.includes("=")) i++
      continue
    }
    if (a.startsWith("-")) {
      if (/^-?\d+(\.\d+)?$/.test(a)) return found
      return found
    }
    // prompt word pertama -> hentikan scan, sisa adalah prompt
    return found
  }
  return found
}

export function promptFromArgs(argv: string[]): string {
  const out: string[] = []
  let afterSeparator = false
  let seenPrompt = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) break
    if (a === "--") {
      afterSeparator = true
      continue
    }
    if (afterSeparator) {
      out.push(a)
      continue
    }
    const fname = flagNameOf(a)
    if (fname === null) {
      // bukan flag dikenal -> prompt word; setelah ini semua token jadi prompt
      seenPrompt = true
      out.push(a)
      continue
    }
    if (seenPrompt) {
      // flag dikenal setelah prompt pertama -> anggap bagian prompt (anti injection)
      out.push(a)
      // untuk value flag dengan "=" sudah push sebagai satu token prompt
      // untuk bentuk terpisah, nilai berikutnya juga prompt jika ada
      if (valueFlags.has(fname) && !a.includes("=")) {
        const v = argv[i + 1]
        if (v !== undefined) {
          out.push(v)
          i++
        }
      }
      continue
    }
    if (BOOLEAN_FLAGS.has(fname)) continue
    // value flag sebelum prompt: lewati flag + nilainya
    if (!a.includes("=")) i++
  }
  return out.join(" ")
}

export function readPrompt(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("")
  return new Promise((resolve) => {
    let data = ""
    let done = false
    const t = setTimeout(() => {
      if (!done) {
        done = true
        resolve("")
      }
    }, 500)
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (c) => (data += c))
    process.stdin.on("end", () => {
      if (!done) {
        done = true
        clearTimeout(t)
        resolve(data.trim())
      }
    })
    // if stdin already ended
    if (process.stdin.readableEnded) {
      clearTimeout(t)
      resolve("")
    }
  })
}
