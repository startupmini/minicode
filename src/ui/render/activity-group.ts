// Klasifikasi tool → keluarga panel aktivitas (Fase 2). Murni & tanpa IO:
// hanya memetakan nama tool ke label keluarga (group) yang dipakai panel
// TUI (transcript.ts) dan blok ringkas linear (simple.ts). Satu sumber
// kebenaran supaya kedua renderer tidak divergen.
//
// Keluarga disandikan sebagai kunci i18n (`panel.group.*`) — modul ini tidak
// menyentuh teks render, hanya kunci. Fallback: tool yang tak dikenal tetap
// tampil dengan nama aslinya (tanpa dikelompokkan).

export type ActivityGroupKind = "explore" | "edit" | "execute" | "feed" | "other"

/** Peta nama tool → keluarga. Kunci nama tool (input tak-terpercaya) — renderer
 * tetap wajib sanitasi sebelum tampil (aturan repo). */
const GROUP_BY_TOOL: Readonly<Record<string, ActivityGroupKind>> = {
  // ── explore: membaca workspace / mencari informasi ──
  read_file: "explore",
  read_image: "explore",
  glob: "explore",
  grep: "explore",
  lsp_diagnostics: "explore",
  lsp_symbols: "explore",
  lsp_workspace_symbols: "explore",
  // ── edit: mengubah file / working tree ──
  edit: "edit",
  apply_patch: "edit",
  write_file: "edit",
  delete_file: "edit",
  move_file: "edit",
  // ── execute: menjalankan proses / perintah ──
  bash: "execute",
  code_run: "execute",
  git_status: "execute",
  git_diff: "execute",
  git_log: "execute",
  git_commit: "execute",
  git_push: "execute",
  mcp_list: "execute",
  mcp_call: "execute",
  mcp_read: "execute",
  mcp_prompt: "execute",
  ask_user: "execute",
  // ── feed: sumber informasi eksternal / memori ──
  web_search: "feed",
  web_fetch: "feed",
  read_memory: "feed",
  write_memory: "feed",
  forget_memory: "feed",
  delegate_task: "feed",
}

/** Keluarga tool (kunci i18n). Kunci `other` untuk yang tak dikenal. */
export function activityGroup(name: string): ActivityGroupKind {
  return GROUP_BY_TOOL[name] ?? "other"
}
