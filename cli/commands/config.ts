import {
  loadConfig,
  removeLspServer,
  removeMcpServer,
  saveLspServer,
  saveMcpServer,
} from "../../src/config.ts"
import { detectAndSave, removeProvider } from "../../src/providers/provision.ts"
import { renderTable } from "../../src/ui/render/table.ts"
import { c, glyphs } from "../../src/ui/render/theme.ts"

// Help kontekstual per subcommand. Sebelumnya ketiga cabang ini mencetak HELP
// global 45 baris dan exit 0 — user tidak tahu apa yang salah dan skrip tidak
// bisa mendeteksi kegagalan.
const CONFIG_HELP = `minicode config — provider, MCP, and LSP

  minicode config add --baseUrl <url> --apiKey <key> [--id <id>] [--global|--local]
  minicode config list
  minicode config remove <id> [--global|--local]
  minicode config detect --baseUrl <url> --apiKey <key>
  minicode config set-key <id> [--global|--local]      move API key to OS store (DPAPI on Windows)
  minicode config delete-key <id>                      forget stored key (provider stays disabled)

  minicode config mcp <add|list|remove>    MCP servers used by minicode
  minicode config lsp <add|list|remove>    language servers per extension

  [--allow-local-config] baca .minicode/config.json lokal (default: abaikan)`

const MCP_HELP = `minicode config mcp — MCP servers used by minicode

  minicode config mcp add <id> --command <cmd> --args "<a1,a2>" [--env K=V]
  minicode config mcp add <id> --url <https://…> [--header K=V] [--allow-private]
  minicode config mcp list
  minicode config mcp remove <id>

  [--global|--local]   save to ~/.minicode (default) or local .minicode/`

const LSP_HELP = `minicode config lsp — language servers per file extension

  minicode config lsp add <ext> --command <cmd> [--args "<a1,a2>"] [--env K=V]
  minicode config lsp list
  minicode config lsp remove <ext>

  [--global|--local]   save to ~/.minicode (default) or local .minicode/`

/** Cetak help lalu keluar: 0 bila user memang meminta, 1 bila salah pakai. */
function showHelp(text: string, asked: boolean, unknown?: string): never {
  if (!asked) console.error(`unknown subcommand: ${unknown}\n`)
  console.log(text)
  process.exit(asked ? 0 : 1)
}

const isHelpFlag = (s: string | undefined): boolean =>
  s === undefined || s === "--help" || s === "-h"

// Subcommand argv selalu diawali positional ("config", …) sehingga hasFlag
// yang boundary-aware tak cocok di sini; pakai includes + env operator
// (gaya yang sama dengan --local/--global di berkas ini).
function allowLocalHere(args: string[]): boolean {
  return args.includes("--allow-local-config") || process.env.MINICODE_ALLOW_LOCAL_CONFIG === "1"
}

/** Positional yang diawali `-` hampir pasti flag yang salah tempat
 * (mis. `config lsp remove --cwd X` menghapus server bernama "--cwd").
 * Tolak dengan usage, jangan anggap sebagai id/ext. */
function positionalArg(args: string[], i: number): string | undefined {
  const v = args[i]
  return v && !v.startsWith("-") ? v : undefined
}

export async function handleConfig(
  args: string[],
  getArg: (name: string) => string | undefined,
  _help: string,
): Promise<never> {
  const sub = args[1]
  if (sub === "add") {
    const baseUrl = getArg("--baseUrl")
    const apiKey = getArg("--apiKey")
    const id = getArg("--id")
    if (!baseUrl || !apiKey) {
      console.error("usage: minicode config add --baseUrl <url> --apiKey <key> [--id <id>]")
      process.exit(1)
    }
    const entry = await detectAndSave(baseUrl, apiKey, id, {
      // Default GLOBAL seperti remove/set-key: menulis provider+key ke
      // .minicode/ repo diam-diam rawan ikut ter-commit plaintext.
      // Eksplisit --local bila memang mau per-repo.
      global: !args.includes("--local"),
      cwd: getArg("--cwd"),
    })
    console.log(
      `${c.green(glyphs.check)} Saved provider "${c.bold(entry.id)}" (${entry.providerHint}) models: ${entry.models.slice(0, 5).join(", ")}${entry.models.length > 5 ? " ..." : ""} (${entry.models.length} total)`,
    )
    process.exit(0)
  } else if (sub === "list") {
    // P10: list branch WAJIB menghormati --cwd seperti branch tulis —
    // sebelumnya membaca process.cwd() diam-diam (config yang salah).
    // Audit #07: local hanya bila operator opt-in (aturan universal).
    const cfg = await loadConfig(getArg("--cwd"), { allowLocal: allowLocalHere(args) })
    if (cfg.providers.length === 0)
      console.log(c.dim("(no providers yet - add one via `minicode config add` or the wizard)"))
    else {
      const tableData = cfg.providers.map((p) => ({
        id: c.cyan(p.id),
        url: p.baseUrl,
        models: String(p.models.length),
        hint: c.dim(p.providerHint ?? "?"),
      }))
      console.log(
        `\n${c.bold("Configured LLM Providers")}\n` +
          renderTable(
            [
              { header: "ID", key: "id", width: 24 },
              { header: "Base URL", key: "url", width: 34 },
              { header: "Models", key: "models", width: 6, align: "right" },
              { header: "Type", key: "hint", width: 12 },
            ],
            tableData,
          ) +
          "\n",
      )
    }
    process.exit(0)
  } else if (sub === "remove") {
    const id = positionalArg(args, 2)
    if (!id) {
      console.error("usage: minicode config remove <id> [--global|--local] [--cwd <dir>]")
      process.exit(1)
    }
    await removeProvider(id, { global: !args.includes("--local"), cwd: getArg("--cwd") })
    console.log(
      `${c.green(glyphs.check)} Removed provider ${id} (${!args.includes("--local") ? "global" : "local"})`,
    )
    process.exit(0)
  } else if (sub === "set-key" || sub === "delete-key") {
    // Pindahkan API key provider dari config plaintext ke penyimpanan OS
    // (Windows: DPAPI user-scope; selain itu: berkas chmod 600 + peringatan
    // jujur). Config hanya menyimpan referensi `keystore:provider:<id>`.
    const id = positionalArg(args, 2)
    if (!id) {
      console.error("usage: minicode config set-key <id> [--global|--local] [--cwd <dir>]")
      process.exit(1)
    }
    const { deleteSecret, setSecret } = await import("../../src/lib/keystore.ts")
    const key = `provider:${id}`
    if (sub === "delete-key") {
      await deleteSecret(key)
      console.log(
        `${c.green(glyphs.check)} Removed stored key for ${c.bold(id)} — update config apiKey manually (provider stays disabled until re-set)`,
      )
      process.exit(0)
    }
    if (!process.stdin.isTTY) {
      console.error(
        "config set-key needs an interactive terminal (refusing to read secret from pipe)",
      )
      process.exit(1)
    }
    const { askSecret } = await import("../../src/ui/input/input.ts")
    const secret = await askSecret(`API key for ${id} (hidden, empty = cancel) > `)
    if (!secret) {
      console.log(c.yellow("canceled"))
      process.exit(1)
    }
    const backend = await setSecret(key, secret)
    if (!backend) {
      console.error("could not store secret (keystore unavailable and file unwritable)")
      process.exit(1)
    }
    const { loadConfig } = await import("../../src/config.ts")
    const { saveProvider } = await import("../../src/providers/provision.ts")
    const global = !args.includes("--local")
    const cfg = await loadConfig(getArg("--cwd"), { allowLocal: allowLocalHere(args) })
    const entry = cfg.providers.find((p) => p.id === id)
    if (!entry) {
      console.error(`provider "${id}" not found - secret stored, but no provider points at it yet`)
      process.exit(1)
    }
    await saveProvider({ ...entry, apiKey: `keystore:${key}` }, { global, cwd: getArg("--cwd") })
    console.log(
      `${c.green(glyphs.check)} Stored key for ${c.bold(id)} via ${backend} (${global ? "global" : "local"} config now references it)`,
    )
    process.exit(0)
  } else if (sub === "detect") {
    if (args.includes("--help") || args.includes("-h")) {
      console.log("usage: minicode config detect --baseUrl <url> --apiKey <key>")
      process.exit(0)
    }
    const baseUrl = getArg("--baseUrl")
    const apiKey = getArg("--apiKey")
    if (!baseUrl || !apiKey) {
      console.error("usage: minicode config detect --baseUrl <url> --apiKey <key>")
      process.exit(1)
    }
    const { detectModels } = await import("../../src/providers/detect.ts")
    const res = await detectModels(baseUrl, apiKey).catch((e) => {
      // Host mati total (bukan sekadar tanpa /models) — katakan begitu,
      // jangan "Detected 0 models" yang menyalahkan kredensial.
      console.error(`${c.red(glyphs.cross)} ${(e as Error).message} — check network and URL`)
      process.exit(1)
    })
    console.log(
      `${c.green(glyphs.check)} Detected ${res.models.length} models (${res.providerHint}):\n${res.models.map((m) => `  ${glyphs.dot} ${m}`).join("\n")}`,
    )
    process.exit(0)
  } else if (sub === "mcp") {
    const mcpSub = args[2]
    if (mcpSub === "add") {
      const id = positionalArg(args, 3)
      const command = getArg("--command")
      const cmdArgsRaw = getArg("--args")
      const url = getArg("--url")
      // Dua bentuk transport: stdio (--command) atau Streamable HTTP (--url).
      if (!id || (!command && !url)) {
        console.error(
          'usage: minicode config mcp add <id> --command <cmd> --args "<a1,a2>" [--env K=V]\n' +
            "       minicode config mcp add <id> --url <https://…> [--header K=V] [--allow-private]\n" +
            "       [--global|--local]",
        )
        process.exit(1)
      }
      const env: Record<string, string> = {}
      for (const kv of (getArg("--env") ?? "").split(",")) {
        const [k, ...rest] = kv.split("=")
        if (k && rest.length) env[k.trim()] = rest.join("=").trim()
      }

      if (url) {
        const headers: Record<string, string> = {}
        for (const kv of (getArg("--header") ?? "").split(",")) {
          const [k, ...rest] = kv.split("=")
          if (k && rest.length) headers[k.trim()] = rest.join("=").trim()
        }
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            console.error(`URL must use http/https, not ${parsed.protocol}`)
            process.exit(1)
          }
        } catch {
          console.error(`Invalid URL: ${url}`)
          process.exit(1)
        }
        // P10: add branch WAJIB menghormati --cwd seperti remove —
        // sebelumnya menulis ke process.cwd() diam-diam (salah direktori).
        await saveMcpServer(
          {
            id,
            url,
            ...(Object.keys(headers).length ? { headers } : {}),
            ...(args.includes("--allow-private") ? { allowPrivateHost: true } : {}),
          },
          { global: !args.includes("--local"), cwd: getArg("--cwd") },
        )
        console.log(`${c.green(glyphs.check)} Saved MCP server "${c.bold(id)}" (http): ${url}`)
        process.exit(0)
      }

      const cmdArgs = (cmdArgsRaw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      await saveMcpServer(
        { id, command, args: cmdArgs, ...(Object.keys(env).length ? { env } : {}) },
        { global: !args.includes("--local"), cwd: getArg("--cwd") },
      )
      console.log(
        `${c.green(glyphs.check)} Saved MCP server "${c.bold(id)}": ${command} ${cmdArgs.join(" ")}`,
      )
      process.exit(0)
    } else if (mcpSub === "list") {
      const cfg = await loadConfig(getArg("--cwd"), { allowLocal: allowLocalHere(args) })
      if (!cfg.mcpServers?.length)
        console.log(c.dim("(no MCP servers configured - add via minicode config mcp add)"))
      else {
        // Server bisa stdio (command+args) atau HTTP (url). Tampilkan keduanya
        // di kolom yang sama supaya tabel tetap ringkas.
        const tableData = cfg.mcpServers.map((m) => ({
          id: c.cyan(m.id),
          command: m.url ? c.dim("(http)") : (m.command ?? ""),
          args: c.dim(m.url ?? (m.args ?? []).join(" ")),
        }))
        console.log(
          `\n${c.bold("Configured MCP Servers")}\n` +
            renderTable(
              [
                { header: "Server ID", key: "id", width: 14 },
                { header: "Command", key: "command", width: 20 },
                { header: "Args / URL", key: "args", width: 36 },
              ],
              tableData,
            ) +
            "\n",
        )
      }
      process.exit(0)
    } else if (mcpSub === "remove") {
      const id = positionalArg(args, 3)
      if (!id) {
        console.error("usage: minicode config mcp remove <id> [--global|--local]")
        process.exit(1)
      }
      await removeMcpServer(id, { global: !args.includes("--local"), cwd: getArg("--cwd") })
      console.log(
        `${c.green(glyphs.check)} Removed MCP server ${id} (${!args.includes("--local") ? "global" : "local"})`,
      )
      process.exit(0)
    } else {
      showHelp(MCP_HELP, isHelpFlag(mcpSub), mcpSub)
    }
  } else if (sub === "lsp") {
    const lspSub = args[2]
    if (lspSub === "add") {
      const ext = positionalArg(args, 3)
      const command = getArg("--command")
      const cmdArgsRaw = getArg("--args") ?? ""
      if (!ext || !command) {
        console.error(
          'usage: minicode config lsp add <ext> --command <cmd> [--args "<arg1,arg2>"] [--env K=V] [--global|--local]',
        )
        process.exit(1)
      }
      const cmdArgs = cmdArgsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const env: Record<string, string> = {}
      for (const kv of (getArg("--env") ?? "").split(",")) {
        const [k, ...rest] = kv.split("=")
        if (k && rest.length) env[k.trim()] = rest.join("=").trim()
      }
      await saveLspServer(
        { ext, command, args: cmdArgs, ...(Object.keys(env).length ? { env } : {}) },
        { global: !args.includes("--local"), cwd: getArg("--cwd") },
      )
      console.log(
        `${c.green(glyphs.check)} Saved LSP server for ${c.bold(ext)}: ${command} ${cmdArgs.join(" ")}`,
      )
      process.exit(0)
    } else if (lspSub === "list") {
      const cfg = await loadConfig(getArg("--cwd"), { allowLocal: allowLocalHere(args) })
      if (!cfg.lspServers?.length)
        console.log(c.dim("(no LSP servers configured - add via minicode config lsp add)"))
      else {
        const tableData = cfg.lspServers.map((l) => ({
          ext: c.cyan(l.ext),
          command: l.command,
          args: c.dim(l.args.join(" ")),
        }))
        console.log(
          `\n${c.bold("Configured LSP Language Servers")}\n` +
            renderTable(
              [
                { header: "Extension", key: "ext", width: 12 },
                { header: "Command", key: "command", width: 22 },
                { header: "Arguments", key: "args", width: 36 },
              ],
              tableData,
            ) +
            "\n",
        )
      }
      process.exit(0)
    } else if (lspSub === "remove") {
      const ext = positionalArg(args, 3)
      if (!ext) {
        console.error("usage: minicode config lsp remove <ext> [--global|--local]")
        process.exit(1)
      }
      await removeLspServer(ext, { global: !args.includes("--local"), cwd: getArg("--cwd") })
      console.log(
        `${c.green(glyphs.check)} Removed LSP server for ${ext} (${!args.includes("--local") ? "global" : "local"})`,
      )
      process.exit(0)
    } else {
      showHelp(LSP_HELP, isHelpFlag(lspSub), lspSub)
    }
  } else {
    showHelp(CONFIG_HELP, isHelpFlag(sub), sub)
  }
}
