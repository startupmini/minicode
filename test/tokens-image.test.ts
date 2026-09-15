// Budget sadar-gambar (audit #14): gambar inline 12_000 byte ≈ 4000 token
// (bukan ~15 via placeholder, bukan ~21000 via JSON-blowup Uint8Array).

import { describe, expect, test } from "bun:test"
import { defaultTokenEstimator, estimateMessage } from "../vendor/minicore/src/core/tokens.ts"

describe("estimateMessage sadar-gambar", () => {
  test("part image dihitung dari byte, bukan placeholder", () => {
    const n = estimateMessage(
      {
        role: "user",
        content: [
          { type: "text", text: "apa ini?" },
          { type: "image", data: new Uint8Array(12_000), mime: "image/png" },
        ],
      },
      defaultTokenEstimator,
    )
    // Kode lama: est("[image:image/png]") ≈ 5 token → budget buta.
    expect(n).toBeGreaterThanOrEqual(3000)
    expect(n).toBeLessThan(6000)
  })

  test("hasil tool Uint8Array tak meledak via JSON.stringify", () => {
    const n = estimateMessage(
      { role: "tool", toolCallId: "c1", name: "read_image", content: new Uint8Array(12_000) },
      defaultTokenEstimator,
    )
    // Kode lama: est('{"0":0,...}' ~84k char) ≈ 21000 → tekanan palsu.
    expect(n).toBeLessThan(5000)
    expect(n).toBeGreaterThan(1000)
  })

  test("teks biasa tak berubah", () => {
    expect(estimateMessage({ role: "user", content: "halo dunia" }, defaultTokenEstimator)).toBe(
      Math.ceil("halo dunia".length / 4),
    )
  })
})
