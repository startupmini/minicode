// Menangkap tulisan stdout/stderr/console selama fn → teks.
//
// Dipakai driver TUI untuk alur cetak (builtin/help/tabel): output mengalir
// ke dokumen transkrip (di-wrap pemanggil), BUKAN ke alt-buffer (merusak
// grid) maupun buffer utama (flicker suspend — pola lama yang dihapus).
// Selalu restore di finally, bahkan bila fn melempar.
//
// Keamanan pemanggilan (pelajaran statusline `writeFast` di Bun Windows):
// pemanggilan asli disimpan TER-BIND (method-call, `this` utuh) — tak pernah
// detached. Tanpa itu TypeError dari internal writeFast.
export async function runCaptured<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; out: string; err: string }> {
  const outChunks: string[] = []
  const errChunks: string[] = []
  const origLog = console.log
  const origError = console.error
  const origOutWrite = process.stdout.write.bind(process.stdout)
  const origErrWrite = process.stderr.write.bind(process.stderr)
  const pushChunk = (arr: string[], chunk: unknown): void => {
    arr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array))
  }
  const toText = (args: unknown[]): string => `${args.map((a) => String(a)).join(" ")}\n`
  console.log = (...args: unknown[]): void => {
    outChunks.push(toText(args))
  }
  console.error = (...args: unknown[]): void => {
    errChunks.push(toText(args))
  }
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    pushChunk(outChunks, chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    pushChunk(errChunks, chunk)
    return true
  }) as typeof process.stderr.write
  try {
    const value = await fn()
    return { value, out: outChunks.join(""), err: errChunks.join("") }
  } finally {
    console.log = origLog
    console.error = origError
    process.stdout.write = origOutWrite as typeof process.stdout.write
    process.stderr.write = origErrWrite as typeof process.stderr.write
  }
}
