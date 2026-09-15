# vendor/minicore — JANGAN EDIT MANUAL

Salinan kernel MiniCore agar `bun install` tidak membutuhkan clone sibling
`../minicore`. Sumber kebenaran tetap repo minicore.

- source commit: `05fc595ad07ccbf3c85d9645948a0621bdce0353`
- files: 19
- hash: `d9ae46c977a96271`
- seam aditif lokal (belum ada di upstream — JANGAN sync membabi buta,
  `bun run vendor:minicore` akan MENGHAPUSnya): `cwd` + `permissionMode`
  (session→loop→executor→ToolContext), `turnCount`/`stepCount` seed,
  `provider_meta`/`thought_signature` side-map + `reasoningEffort` knob di
  openai-compat, `describeDenial` opsional di PermissionHandler + alasan
  deny di executor (`permission denied: <reason>`; tanpa method = pesan
  polos seperti dulu), estimasi token sadar-gambar di tokens.ts
  (`estimateImageTokens` + `estimateMessage` hitung byte gambar alih-alih
  placeholder/JSON-blowup). Berkas tersentuh: `src/core/{session,loop,executor,tool,permission,tokens}.ts`,
  `src/providers/openai-compat.ts`. (Kernel upstream 1eceea9 punya cap
  retryAfter sendiri; vendor ini belum mengambilnya — cap ditutup lapis-app
  minicode.) Hilirkan dulu ke repo minicore, baru sync ulang.

Perbarui dengan `bun run vendor:minicore` (butuh `../minicore`).
CI memverifikasi kesinkronan lewat `bun run vendor:check`.
