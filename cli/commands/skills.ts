import { findSkill, loadSkills } from "../../src/skills/loader.ts"
import { renderTable } from "../../src/ui/render/table.ts"
import { c } from "../../src/ui/render/theme.ts"

const SKILLS_HELP = `minicode skills — markdown skills in .minicode/skills/*.md

  minicode skills list           list installed skills
  minicode skills show <name>    show one skill

  In interactive mode, run a skill with /name [arguments].`

export async function handleSkills(
  args: string[],
  getArg: (name: string) => string | undefined,
): Promise<never> {
  const cwdArg = getArg("--cwd")
  const sub = args[1]
  if (sub === "list" || sub === undefined) {
    const all = await loadSkills(cwdArg)
    if (all.length === 0) {
      console.log(c.dim("(no skills yet - add markdown files in .minicode/skills/*.md)"))
      process.exit(0)
    }
    const tableData = all.map((s) => ({
      skill: c.yellow(`/${s.name}`),
      desc: s.description || "(no description)",
    }))
    console.log(
      `\n${c.bold("Installed Skills")}\n` +
        renderTable(
          [
            { header: "Command", key: "skill", width: 18 },
            { header: "Description", key: "desc", width: 56 },
          ],
          tableData,
        ) +
        "\n",
    )
    process.exit(0)
  }
  if (sub === "show") {
    // Tolak flag sebagai nama: `skills show --cwd x` adalah lupa argumen,
    // bukan permintaan skill bernama "--cwd".
    const name = args[2] && !args[2]!.startsWith("-") ? args[2] : undefined
    if (!name) {
      console.error("usage: minicode skills show <name>")
      process.exit(2)
    }
    const s = await findSkill(name, cwdArg)
    if (!s) {
      console.error(`skill "${name}" not found - see: minicode skills list`)
      process.exit(1)
    }
    console.log(`${c.bold(c.cyan(`/${s.name}`))} ${c.dim(`- ${s.description}`)}\n\n${s.body}`)
    process.exit(0)
  }
  const asked = sub === "--help" || sub === "-h"
  if (!asked) console.error(`unknown skills subcommand: ${sub}\n`)
  console.log(SKILLS_HELP)
  process.exit(asked ? 0 : 2)
}
