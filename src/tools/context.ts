/** Workspace root wajib datang dari context eksekusi yang dirakit runtime. */
export function requireToolCwd(context: unknown): string {
  const cwd = (context as { cwd?: unknown } | null)?.cwd
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("ToolContext.cwd is required; refusing to use process.cwd()")
  }
  return cwd
}

/**
 * True hanya di mode `unrestricted`. Sumber: `ToolContext.permissionMode`,
 * di-resolve LIVE per-turn oleh kernel — `/unrestric` saat runtime langsung
 * tercermin tanpa patch vendor. Fail-closed: selain string "unrestricted"
 * (termasuk undefined pada pemanggil library/test) = false.
 */
export function contextUnrestricted(context: unknown): boolean {
  return (context as { permissionMode?: unknown } | null)?.permissionMode === "unrestricted"
}
