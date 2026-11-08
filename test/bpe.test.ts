import { describe, expect, test } from "bun:test"
import { BpeTokenizer, loadBpeTokenizer } from "../src/policy/bpe.ts"

describe("BPE tokenizer (murni TS)", () => {
  const tiny = {
    vocab: { t: 0, h: 1, e: 2, the: 3 },
    merges: ["t h", "th e"],
  }

  test("menggabungkan pasangan sesuai rank merge", () => {
    const tok = new BpeTokenizer(tiny)
    expect(tok.countTokens("the")).toBe(1) // t+h -> th, th+e -> the
    expect(tok.countTokens("he")).toBe(2) // h+e tak menyatu
    expect(tok.countTokens("t")).toBe(1)
  })

  test("teks kosong = 0 token", () => {
    expect(new BpeTokenizer(tiny).countTokens("")).toBe(0)
  })

  test("loadBpeTokenizer membangun dari objek tokenizer.json", () => {
    const tok = loadBpeTokenizer({ vocab: tiny.vocab, merges: tiny.merges })
    expect(tok.countTokens("the")).toBe(1)
  })

  test("teks dengan spasi dan baris baru tidak melempar", () => {
    const tok = new BpeTokenizer({
      vocab: { Ġ: 0, the: 1, "\n": 2 },
      merges: [],
    })
    expect(tok.countTokens("the quick\nbrown")).toBeGreaterThan(0)
  })
})
