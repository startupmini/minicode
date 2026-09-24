// Navigasi docs: baca docs/SUMMARY.md agar sidebar web selalu 1:1.
// Mengapa parse SUMMARY, bukan hardcode: satu sumber navigasi — tambah
// halaman docs cukup edit SUMMARY.md + file md, sidebar web ikut.
import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface DocEntry {
  group: string
  title: string
  file: string
  slug: string
}

const DOC_META: Record<string, { desc: string; src: string }> = {
  // Key = slug (readDocNav selalu lowercase) — key "README" dulu tak pernah
  // kena lookup dan halaman docs/index jatuh ke desc fallback 29 char.
  // desc = meta description (juga dipakai grid docs & llms.txt): pasangan
  // terminal/terminal_contract dan trio keamanan sengaja dibedakan intent-nya
  // (audit CANNIB-01/02 2026-09-24) — desc 85% sama membuat halaman saling
  // berebut cuplikan SERP yang sama. Jaga: 50–160 char, akhiri tanda kalimat.
  readme: {
    desc: "Dokumentasi Minicode: coding agent CLI shell-native di atas MiniCore.",
    src: "docs/README.md",
  },
  "getting-started": {
    desc: "Instalasi Minicode: Bun, matriks OS, update, lokasi data.",
    src: "src/config.ts",
  },
  concepts: {
    desc: "Konsep Minicode: kernel MiniCore, loop ReAct, shell-native, kejujuran.",
    src: "docs/ARCHITECTURE.html",
  },
  glossary: {
    desc: "Glosarium istilah Minicode: kernel, jail, checkpoint, ledger, RAG.",
    src: "docs/USAGE.md",
  },
  exec: {
    desc: "Otomasi & CI: one-shot, pipe, exec --json, submit_result, budget.",
    src: "cli/commands/exec.ts",
  },
  config: {
    desc: "Skema config.json, merge global/lokal, dan lokasi data Minicode.",
    src: "src/config.ts",
  },
  environment: {
    desc: "Referensi penuh MINICODE_*: sandbox, memory, terminal, aksesibilitas.",
    src: "docs/USAGE.md",
  },
  skills: {
    desc: "Skills markdown, hooks pre/post-run, dan AGENTS.md proyek.",
    src: "src/skills/",
  },
  agents: {
    desc: "Sub-agent delegate_task: pool 3, mode explore/plan, recovery.",
    src: "src/agents/",
  },
  security: {
    desc: "Prinsip keamanan Minicode: fail-closed, bash-guard yang diukur, dan teks eksternal yang tak dipercaya.",
    src: "src/policy/bash-guard.ts",
  },
  "security-model": {
    desc: "Model ancaman Minicode dalam satu halaman: execution chain, trust boundary, dan limitasi yang diakui.",
    src: "src/policy/permission.ts",
  },
  terminal: {
    desc: "Ringkasan kontrak terminal untuk pengguna: satu tampilan TUI fullscreen, stdout/stderr yang jelas, dan status FROZEN-nya.",
    src: "docs/TERMINAL_CONTRACT.md",
  },
  quickstart: {
    desc: "Quickstart Minicode: dari nol ke prompt pertama yang ter-verify dalam 5 menit.",
    src: "cli/router.ts",
  },
  cli: {
    desc: "Referensi CLI Minicode: mode, flags, dan environment variables.",
    src: "cli/router.ts",
  },
  "choosing-mode": {
    desc: "Pilih permission mode dari tujuan: baca, ubah, approve, plan, CI, otonom.",
    src: "src/policy/permission.ts",
  },
  repl: {
    desc: "Slash command dan pintasan keyboard TUI fullscreen Minicode.",
    src: "src/ui/tui/app.ts",
  },
  "config-providers": {
    desc: "14 preset gateway, OAuth device-code, model dan effort.",
    src: "src/providers/build.ts",
  },
  "pricing-budget": {
    desc: "Harga offline, sync 3.162 model, dan --budget fail-closed.",
    src: "src/policy/pricing.ts",
  },
  tools: {
    desc: "Referensi 37 tool: filesystem, exec, git, web, memory, MCP, LSP.",
    src: "src/tools/index.ts",
  },
  "policy-sandbox": {
    desc: "Referensi 6 permission mode, bash-guard, sandbox, dan path jail — beserta batas jujurnya.",
    src: "src/policy/permission.ts",
  },
  "memory-sessions": {
    desc: "Memory RAG hybrid, sessions sqlite, checkpoint shadow-git.",
    src: "src/memory/vector.ts",
  },
  "mcp-lsp": {
    desc: "MCP dan LSP di Minicode: stdio, Streamable HTTP, dan LSP diagnostics.",
    src: "src/mcp/client.ts",
  },
  "verify-benchmark": {
    desc: "Auto-verify self-heal, benchmark, dan SWE-bench Lite.",
    src: "bench/runner.ts",
  },
  troubleshooting: {
    desc: "Solusi error umum Minicode: minicode doctor, koneksi gagal, dan path Windows.",
    src: "cli/commands/doctor.ts",
  },
  contributing: {
    desc: "Kontribusi ke Minicode: setup dev, gate test, batas lapisan, dan aturan kode.",
    src: "AGENTS.md",
  },
  architecture: {
    desc: "Arsitektur Minicode: tiga lapisan, alur satu prompt, dan kontrak terminal.",
    src: "docs/ARCHITECTURE.html",
  },
  changelog: {
    desc: "Changelog Minicode: perubahan per versi, dari rencana eksekusi.",
    src: "CHANGELOG.md",
  },
  // Dokumen internal kontributor (SUMMARY grup "Internal & Arsitektur",
  // audit docs 2026-09-18: sebelumnya orphan dari nav web/llms).
  terminal_contract: {
    desc: "Referensi kontributor: 31 invariant (I1–I31), peta test proteksinya, dan residual risk yang disengaja.",
    src: "docs/TERMINAL_CONTRACT.md",
  },
  "control-plane-map": {
    desc: "Kontrak FROZEN context/usage/cost/budget/compaction/termination.",
    src: "docs/CONTROL-PLANE-MAP.md",
  },
  ui_render_pipeline: {
    desc: "Peta implementasi jalur provider stream ke terminal, per tahap.",
    src: "docs/UI_RENDER_PIPELINE.md",
  },
  harness: {
    desc: "Riset fondasi harness: studi 11 codebase, keputusan desain Minicode.",
    src: "docs/HARNESS.md",
  },
  plan_uiux_v6: {
    desc: "Arsip plan UI/UX V6 (0.7 ke 0.8): target vs hasil terukur.",
    src: "docs/PLAN_UIUX_V6.md",
  },
}

export function readDocNav(repoRoot: string): DocEntry[] {
  const raw = readFileSync(join(repoRoot, "docs", "SUMMARY.md"), "utf8")
  const out: DocEntry[] = []
  let group = "Docs"
  for (const line of raw.split("\n")) {
    const g = /^##\s+(.*)$/.exec(line.trim())
    if (g) {
      group = g[1]!.trim()
      continue
    }
    const e = /^\*\s+\[([^\]]+)\]\(([^)]+)\)/.exec(line.trim())
    if (e) {
      const file = e[2]!.trim()
      const slug = file.replace(/\.md$/, "").toLowerCase()
      out.push({ group, title: e[1]!.trim(), file, slug })
    }
  }
  return out
}

export function docMeta(slug: string): { desc: string; src: string } {
  return DOC_META[slug] ?? { desc: `Dokumentasi Minicode: ${slug}.`, src: `docs/${slug}.md` }
}
