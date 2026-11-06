/** Workspace root wajib datang dari context eksekusi yang dirakit runtime. */
export function requireToolCwd(context: unknown): string {
  const cwd = (context as { cwd?: unknown } | null)?.cwd
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("ToolContext.cwd is required; refusing to use process.cwd()")
  }
  return cwd
}
