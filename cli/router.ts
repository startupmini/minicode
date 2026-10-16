import { flagNameOf, valueFlags } from "./args.ts"

export async function dispatch(
  args: string[],
  _getArg: (name: string) => string | undefined,
  HELP: string,
): Promise<boolean> {
  let cmdIndex = -1
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (!token) continue
    if (token === "--") break
    const flag = flagNameOf(token)
    if (flag) {
      if (valueFlags.has(flag) && !token.includes("=")) i++
      continue
    }
    if (!token.startsWith("-")) {
      cmdIndex = i
      break
    }
  }
  const cmd = cmdIndex >= 0 ? args[cmdIndex] : undefined
  if (!cmd) return false

  // P10 P0.1 — scoped argv agar --cwd/--json setelah subcommand tetap terbaca.
  // getArg global berhenti di token subcommand (boundary anti-injeksi P8),
  // sehingga `minicode sessions list --cwd /tmp` mengembalikan undefined.
  // Bangun subArgv = [flag global sebelum cmd + args dari cmd] dan getArg
  // yang beroperasi di atasnya; teruskan sebagai getArg kedua ke handler.
  const subArgv: string[] = []
  for (let i = 0; i < cmdIndex; i++) {
    const t = args[i]
    if (!t) continue
    const flag = flagNameOf(t)
    if (flag) {
      subArgv.push(t)
      if (valueFlags.has(flag) && !t.includes("=") && i + 1 < cmdIndex) {
        const v = args[i + 1]
        if (v !== undefined) {
          subArgv.push(v)
          i++
        }
      }
    }
  }
  // P11.2 — posisi token subcommand di subArgv. Semua flag global sudah
  // ter-push di titik ini; catat sebelum cmd+rest bergabung agar handler
  // exec bisa menerima argv scoped TANPA token routing (cmd tetap ikut di
  // subArgv demi subGetArg dan kompatibilitas handler lain).
  const cmdTokenPos = subArgv.length
  subArgv.push(...args.slice(cmdIndex))
  // subGetArg untuk handler: cari flag di subArgv TANPA boundary prompt,
  // karena token subcommand ("sessions") sendiri akan memicu early-return di
  // getArg global. Scan sederhana last-wins.
  const subGetArg = (name: string): string | undefined => {
    let found: string | undefined
    for (let i = 0; i < subArgv.length; i++) {
      const a = subArgv[i]
      if (a === undefined) continue
      if (a === name) {
        const v = subArgv[i + 1]
        if (v !== undefined && (v === "-" || !v.startsWith("-") || /^-?\d+(\.\d+)?$/.test(v)))
          found = v
      } else if (a.startsWith(`${name}=`)) {
        const v = a.slice(name.length + 1)
        if (v !== "") found = v
      }
    }
    return found
  }

  if (cmd === "stats") {
    const { handleStats } = await import("./commands/stats.ts")
    await handleStats(subGetArg)
    return true
  }
  if (cmd === "sessions") {
    const { handleSessions } = await import("./commands/sessions.ts")
    await handleSessions(args, subGetArg)
    return true
  }
  if (cmd === "mcp") {
    const { handleMcp } = await import("./commands/mcp.ts")
    await handleMcp(args, subGetArg, HELP)
    return true
  }
  if (cmd === "config") {
    const { handleConfig } = await import("./commands/config.ts")
    await handleConfig(args, subGetArg, HELP)
    return true
  }
  if (cmd === "skills") {
    const { handleSkills } = await import("./commands/skills.ts")
    await handleSkills(args, subGetArg)
    return true
  }
  if (cmd === "providers" || cmd === "models" || cmd === "sync") {
    const { handleProviders } = await import("./commands/providers.ts")
    await handleProviders(args, subGetArg)
    return true
  }
  if (cmd === "auth") {
    const { handleAuth } = await import("./commands/auth.ts")
    await handleAuth(args)
    return true
  }
  if (cmd === "pricing") {
    const { handlePricing } = await import("./commands/pricing.ts")
    await handlePricing(args)
    return true
  }
  if (cmd === "exec") {
    const { handleExec } = await import("./commands/exec.ts")
    // P11.2 — argv scoped TANPA token "exec": guard lokal `args[0] === "exec"`
    // di handler hanya benar bila exec token pertama; dengan flag global
    // mendahului ("--json exec ...") token routing bocor ke prompt + summary
    // mesin. cmdArgv = flag global yang dikenal + semua token setelah
    // subcommand. subGetArg tak berubah (tetap di atas subArgv penuh).
    const cmdArgv = [...subArgv.slice(0, cmdTokenPos), ...args.slice(cmdIndex + 1)]
    await handleExec(cmdArgv, subGetArg)
    return true
  }
  if (cmd === "acp") {
    // Fase 5: server JSON-RPC stdio minimal untuk IDE (subset, bukan ACP penuh).
    // Handler memblokir sampai stdin EOF/shutdown; tak ada sesi CLI yang dibuat.
    const { handleAcp } = await import("./commands/acp.ts")
    await handleAcp()
    return true
  }
  if (cmd === "daemon") {
    // P2.12 — host daemon lintas-platform (loopback + capability bercakupan).
    // Terpisah dari exec/acp: daemon adalah proses panjang yang melayani
    // konsumen, bukan pelaksana satu prompt.
    // P11.3 — argv scoped TANPA token "daemon" (cermin pola exec P11.2):
    // guard lokal `args[0] === "daemon"` di handler salah saat flag global
    // mendahului ("--json daemon status" dibaca sebagai aksi "daemon" →
    // exit 2 palsu). subGetArg tak berubah (tetap di atas subArgv penuh).
    const { handleDaemon } = await import("./commands/daemon.ts")
    const cmdArgv = [...subArgv.slice(0, cmdTokenPos), ...args.slice(cmdIndex + 1)]
    await handleDaemon(cmdArgv, subGetArg, HELP)
    return true
  }
  if (cmd === "memory") {
    const { handleMemory } = await import("./commands/memory.ts")
    await handleMemory(args, subGetArg)
    return true
  }
  if (cmd === "doctor") {
    const { handleDoctor } = await import("./commands/doctor.ts")
    await handleDoctor(args, subGetArg)
    return true
  }
  return false
}
