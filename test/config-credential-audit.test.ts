// Audit #07 (config/credential/runtime): allowlist "always" tanpa pemotongan.
//
// Temuan: `matchAllowlist` + `saveAlways` memakai `.slice(0, 200)` sehingga dua
// panggilan dengan 200-char prefix sama berbagi kunci. Entri "always" untuk
// perintah jinak panjang otomatis me-allow perintah jahat berprefix sama —
// dan karena cek allowlist mendahului bash-guard di mode `ask`, guard ikut
// dilewati. Perbaikan: kunci penuh di kedua sisi; arg raksasa (>2KB) tidak
// disimpan (fail-closed).

import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"
import { matchAllowlist } from "../src/policy/allowlist.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"
import { saveProvider } from "../src/providers/provision.ts"

const PREFIX = "A".repeat(195)
const BENIGN_CMD = `echo ${PREFIX}-BENIGN-TAIL-1234567890-EXTRA`
const EVIL_CMD = `echo ${PREFIX}-EVIL-TAIL-9999999999-EXTRA`

function call(cmd: string) {
  return { id: "1", name: "bash", args: { cmd } } as never
}

test("allowlist: perintah jahat berprefix sama tidak mewarisi always jinak", () => {
  const savedFull = `bash:${JSON.stringify({ cmd: BENIGN_CMD })}`
  expect(matchAllowlist(call(BENIGN_CMD), [savedFull])).toBe(true)
  expect(matchAllowlist(call(EVIL_CMD), [savedFull])).toBe(false)
})

test("allowlist: arg pendek + wildcard tidak regresi", () => {
  expect(matchAllowlist(call("echo hi"), ['bash:{"cmd":"echo hi"}'])).toBe(true)
  expect(matchAllowlist(call("echo lain"), ['bash:{"cmd":"echo hi"}'])).toBe(false)
  expect(matchAllowlist(call("apa saja"), ["bash:*"])).toBe(true)
})

test("ask: always jinak panjang tidak membebaskan jahat berprefix sama", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-cred-"))
  try {
    let asks = 0
    const h = createPermissionHandler({
      mode: "ask",
      root,
      ask: async () => {
        asks++
        return "always"
      },
    })
    // Panggilan jinak → ditanya sekali, dijawab always, disimpan penuh.
    expect(await h.check(call(BENIGN_CMD), {} as never)).toBe("allow")
    expect(asks).toBe(1)
    // Panggilan jahat berprefix sama → WAJIB ditanya lagi (tidak auto-allow).
    // Di kode lama (slice 200) asks tetap 1 karena kunci terpotong identik.
    expect(await h.check(call(EVIL_CMD), {} as never)).toBe("allow")
    expect(asks).toBe(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("provision: 8× saveProvider paralel tidak saling menelan", async () => {
  const { mkdirSync } = await import("node:fs")
  const dir = mkdtempSync(join(tmpdir(), "mc-prov-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  try {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        saveProvider(
          { id: `p${i}`, baseUrl: `https://x${i}.example`, apiKey: `k${i}`, models: ["m"] },
          { global: false, cwd: dir },
        ),
      ),
    )
    const cfg = await loadConfig(dir, { allowLocal: true })
    // Tanpa withConfigLock: last-wins, hanya 1 yang selamat (reproducer: "saved 1").
    // Global dirumah dev mungkin berisi ~10 provider, jadi cek kehadiran 8 id
    // lokal, bukan panjang eksak yang rapuh terhadap global.
    for (let i = 0; i < 8; i++) expect(cfg.providers.some((p) => p.id === `p${i}`)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
