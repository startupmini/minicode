import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homeDir } from "../../src/lib/db-path.ts"
import { deleteJournalFile, findOrphanJournals } from "../../src/session/journal.ts"
import {
  getSessionTtlDays,
  listSessions,
  loadSession,
  purgeExpired,
} from "../../src/session/persistence.ts"
import { renderTable } from "../../src/ui/render/table.ts"
import { c } from "../../src/ui/render/theme.ts"

const SESSIONS_HELP = `minicode sessions — session history

  minicode sessions list                 list recent sessions
  minicode sessions export <id> [--jsonl]  export message history
  minicode sessions purge                remove expired sessions (TTL)`

export async function handleSessions(
  args: string[],
  getArg: (name: string) => string | undefined,
): Promise<never> {
  const sub = args[1]
  if (sub === "list" || !sub) {
    const cwdArg = getArg("--cwd")
    const rows = listSessions(cwdArg)
    // resolveDbPath jatuh ke global ~/.minicode bila workspace tanpa
    // .minicode/ — umumkan scope agar daftar lintas-workspace tak dibaca
    // sebagai isi workspace ini (temuan F-C audit terminal UI/UX).
    const base = cwdArg ?? process.cwd()
    const usesLocal =
      existsSync(resolve(base, ".minicode", "sessions.db")) ||
      existsSync(resolve(base, ".minicode"))
    if (!usesLocal) console.log(c.dim(`(global scope — no local .minicode/sessions.db in ${base})`))
    if (rows.length === 0) console.log(c.dim("(no recorded sessions yet)"))
    else {
      const tableData = rows.map((r) => ({
        id: c.cyan(r.id),
        date: new Date(r.created_at).toLocaleString(),
        cwd: c.dim(r.cwd),
      }))
      console.log(
        `\n${c.bold("Recent Sessions")}\n` +
          renderTable(
            [
              { header: "Session ID", key: "id", width: 14 },
              { header: "Created", key: "date", width: 22 },
              { header: "Workspace", key: "cwd", width: 40 },
            ],
            tableData,
          ) +
          "\n",
      )
    }
    process.exit(0)
  } else if (sub === "export") {
    // args[2] bisa berupa flag bila user lupa id (`sessions export --cwd x`);
    // memperlakukannya sebagai id menghasilkan pesan "sesi --cwd tidak ditemukan".
    const id = args[2] && !args[2]!.startsWith("-") ? args[2] : undefined
    const asJsonl = args.includes("--jsonl")
    if (!id) {
      console.error("usage: minicode sessions export <id> [--jsonl]")
      process.exit(2)
    }
    const sess = loadSession(id, getArg("--cwd"))
    if (!sess) {
      console.error(`session "${id}" not found - see: minicode sessions list`)
      process.exit(1)
    }
    if (asJsonl) for (const m of sess.messages) console.log(JSON.stringify(m))
    else console.log(JSON.stringify(sess, null, 2))
    process.exit(0)
  } else if (sub === "purge") {
    const cwdArg = getArg("--cwd")
    const localPath = resolve(cwdArg ?? process.cwd(), ".minicode", "sessions.db")
    const dbPath = existsSync(localPath)
      ? localPath
      : (() => {
          const g = join(homeDir(), ".minicode")
          mkdirSync(g, { recursive: true })
          return join(g, "sessions.db")
        })()
    const db = new Database(dbPath)
    try {
      // Jurnal mengikuti lifecycle sesi: hapus file jurnal milik sesi yang
      // akan di-purge (best-effort) sebelum baris DB-nya hilang.
      try {
        const days = getSessionTtlDays()
        if (days > 0) {
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
          const stale = db
            .prepare("SELECT id FROM sessions WHERE COALESCE(updated_at, created_at) < ?")
            .all(cutoff) as { id: string }[]
          const journalCwd = existsSync(localPath) ? (cwdArg ?? process.cwd()) : homeDir()
          for (const s of stale) deleteJournalFile(s.id, journalCwd)
        }
      } catch {}
      const removed = purgeExpired(db)
      // Yatim: jurnal milik sesi yang sudah tak ada di tabel (termasuk anak
      // yang tak pernah persist) + tak dirujuk parent hidup + lebih tua dari
      // TTL. Unreadable tak pernah dihapus (tak terbukti yatim).
      let orphans = 0
      try {
        const journalDir = join(dirname(dbPath), "")
        const alive = new Set(
          (
            db.prepare("SELECT id FROM sessions").all() as {
              id: string
            }[]
          ).map((r) => r.id),
        )
        const { unlinkSync } = await import("node:fs")
        for (const f of await findOrphanJournals(journalDir, alive, getSessionTtlDays())) {
          try {
            unlinkSync(f)
            orphans += 1
          } catch {}
        }
      } catch {}
      const ttl = getSessionTtlDays()
      console.log(`[purge] removed ${removed} sessions (older than ${ttl} days)`)
      if (orphans > 0) console.log(`[purge] removed ${orphans} orphan journals`)
    } finally {
      db.close()
    }
    process.exit(0)
  } else {
    const asked = sub === "--help" || sub === "-h"
    if (!asked) console.error(`unknown sessions subcommand: ${sub}\n`)
    console.log(SESSIONS_HELP)
    process.exit(asked ? 0 : 2)
  }
}
