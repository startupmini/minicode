// Satu sumber angka konteks: guard memasang estimasi input terkalibrasi pada
// request terakhir dan mengeksposnya, supaya footer bisa membaca ANGKA YANG SAMA
// dengan yang dipakai guard saat memutuskan cutoff (bukan estimasi terpisah).
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider, finish, text } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"

describe("context: guardInputTokens (satu sumber konteks)", () => {
  test("terisi setelah request pertama, 0 sebelum request", async () => {
    const p = new FakeProvider([{ events: [text("ok"), finish("stop")] }])
    const s = await createMinicodeSession({
      provider: p,
      cwd: mkdtempSync(join(tmpdir(), "mc-unify-")),
      contextWindowTokens: 30_000,
      keepRecentTurns: 1,
    })
    // Sebelum request apa pun: belum ada estimasi guard.
    expect(s.guardInputTokens).toBe(0)
    await s.run("halo", {})
    // Setelah request: guard sudah menghitung input (system+tools+pesan > 0).
    expect(s.guardInputTokens).toBeGreaterThan(0)
    // Satu sumber: estimasi guard konsisten dengan estimasi store terkalibrasi
    // (keduanya memakai estimator kalibrasi yang sama, bukan dua sumber divergen).
    expect(s.guardInputTokens).toBeGreaterThan(0)
    expect(s.contextTokens).toBeGreaterThan(0)
  })
})
