// Byte-level BPE tokenizer murni TS (tanpa dependensi) — kompatibel dengan
// `tokenizer.json` HuggingFace (keluarga GPT-2/llama/deepseek/qwen/mistral).
//
// Ini replikasi algoritma tiktoken/HF `tokenizers`: byte-to-unicode mapping,
// regex pre-tokenizer, dan greedy pair merge. Dipakai sebagai pengukur token
// AKURAT (bukan chars/4) untuk model open yang mempublikasikan vocab-nya —
// menutup celah under-count yang membuat konteks meledak tanpa disadari.

export interface BpeData {
  vocab: Record<string, number>
  merges: string[]
}

/** Map byte -> unicode (sama dengan tiktoken/HF): printable = dirinya, non-
 * printable -> ␀..ÿ (256+n). Byte 32 (spasi) -> Ġ, byte 10 -> Ċ, dst. */
function byteEncoder(): Map<number, string> {
  const bs: number[] = []
  for (let i = 33; i <= 126; i++) bs.push(i) // !..~
  for (let i = 161; i <= 172; i++) bs.push(i) // ¡..¬
  for (let i = 174; i <= 255; i++) bs.push(i) // ®..ÿ
  const cs: number[] = bs.slice()
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b)
      cs.push(256 + n)
      n++
    }
  }
  const map = new Map<number, string>()
  for (let i = 0; i < bs.length; i++) map.set(bs[i]!, String.fromCodePoint(cs[i]!))
  return map
}

const BYTE_TO_UNICODE = byteEncoder()

// Regex pre-tokenizer persis tiktoken (keluarga GPT-2 BPE).
const PAT =
  /(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu

function byteEncode(text: string): string[] {
  const bytes = new TextEncoder().encode(text)
  return [...bytes].map((b) => BYTE_TO_UNICODE.get(b) ?? "")
}

/** Terapkan BPE merge pada satu "kata" (string unicode) memakai rank merge. */
function bpeMerge(token: string[], mergeRanks: Map<string, number>): string[] {
  let parts = token.slice()
  // Greedy: gabungkan pasangan ber-rank terendah (tertinggi) selama ada.
  for (;;) {
    let bestIdx = -1
    let bestRank = Infinity
    for (let i = 0; i + 1 < parts.length; i++) {
      const rank = mergeRanks.get(parts[i]! + parts[i + 1]!)
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank
        bestIdx = i
      }
    }
    if (bestIdx < 0) break
    parts = [
      ...parts.slice(0, bestIdx),
      parts[bestIdx]! + parts[bestIdx + 1]!,
      ...parts.slice(bestIdx + 2),
    ]
  }
  return parts
}

export class BpeTokenizer {
  private mergeRanks: Map<string, number>

  constructor(data: BpeData) {
    // merges = urutan rank (indeks pertama = prioritas tertinggi).
    this.mergeRanks = new Map()
    data.merges.forEach((pair, index) => {
      // pair = "a b" (dua token dipisah spasi)
      this.mergeRanks.set(pair.replace(" ", ""), index)
    })
  }

  /** Jumlah token (ID unik) dalam teks. */
  countTokens(text: string): number {
    if (!text) return 0
    let total = 0
    for (const piece of text.match(PAT) ?? []) {
      if (!piece) continue
      const token = byteEncode(piece)
      const parts = bpeMerge(token, this.mergeRanks)
      // Setiap bagian jadi satu token; vocab lookup (>0 selalu ada di BPE terlatih).
      total += parts.length
    }
    return total
  }
}

/** Bangun tokenizer dari objek tokenizer.json (model.vocab + model.merges). */
export function loadBpeTokenizer(model: {
  vocab: Record<string, number>
  merges: string[]
}): BpeTokenizer {
  return new BpeTokenizer({ vocab: model.vocab, merges: model.merges })
}
