// Fase 4 Content Store Presentasi V2.1 (§16 plan).
//
// Kenapa file terpisah: area "presentation store" belum punya rumah; test
// independen dari harness adapter (store murni in-memory).
//
// Yang dijaga:
// · cap 200K per-entry / 500K total (baseline collapse.ts)
// · FIFO evict + tandai dead (penanda retensi, bukan string kosong)
// · surrogate-safe + escape-safe cut
// · expand() resolve — buka-ulang identik (bukan sekali-habis)
// · miss → durable fallback → retensi message
// · restart: store kosong (durability = sqlite, bukan store)

import { describe, expect, test } from "bun:test"
import {
  contentKey,
  createContentStore,
  MAX_BUFFER_TOTAL,
  MAX_SECTION_CHARS,
} from "../src/presentation/store.ts"

const meta = {
  kind: "output" as const,
  stream: "stdout" as const,
  truncated: false,
}

describe("content store: put/get", () => {
  test("put/get roundtrip — text + meta + source store", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "hello", meta)
    const hit = store.get({ toolCallId: "t1", idx: 0 })
    expect(hit?.text).toBe("hello")
    expect(hit?.meta.kind).toBe("output")
    expect(hit?.meta.source).toBe("store")
    expect(hit?.meta.stream).toBe("stdout")
  })

  test("put kosong diabaikan", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "", meta)
    expect(store.get({ toolCallId: "t1", idx: 0 })).toBeUndefined()
    expect(store.stats().entries).toBe(0)
  })

  test("put overwrite ref sama — totalChars tidak ganda", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "aaaa", meta)
    store.put({ toolCallId: "t1", idx: 0 }, "bbbbbb", meta)
    expect(store.stats().entries).toBe(1)
    expect(store.stats().totalChars).toBe(6)
    expect(store.get({ toolCallId: "t1", idx: 0 })?.text).toBe("bbbbbb")
  })

  test("multi-chunk idx terpisah", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "chunk0", meta)
    store.put({ toolCallId: "t1", idx: 1 }, "chunk1", meta)
    expect(store.stats().entries).toBe(2)
    expect(contentKey({ toolCallId: "t1", idx: 1 })).toBe("t1#1")
  })
})

describe("content store: cap per-entry 200K", () => {
  test("teks >200K terpotong aman (tanpa U+FFFD / escape ekor)", () => {
    const store = createContentStore()
    // 200_001 char ASCII + ekor ESC[ yang terpotong di batas.
    const text = `${"x".repeat(MAX_SECTION_CHARS - 2)}\u{1F600}\x1b[3`
    store.put({ toolCallId: "big", idx: 0 }, text, meta)
    const hit = store.get({ toolCallId: "big", idx: 0 })
    expect(hit).toBeTruthy()
    expect(hit!.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS)
    expect(hit!.meta.truncated).toBe(true)
    // Tidak boleh berakhir dengan high-surrogate (U+FFFD di /expand).
    const last = hit!.text.charCodeAt(hit!.text.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    // Tidak boleh berakhir dengan ESC tanpa sekuens lengkap.
    expect(hit!.text.endsWith("\x1b")).toBe(false)
    expect(hit!.text.endsWith("\x1b[")).toBe(false)
  })

  test("teks <=200K utuh (truncated=false)", () => {
    const store = createContentStore()
    store.put({ toolCallId: "ok", idx: 0 }, "y".repeat(1000), meta)
    const hit = store.get({ toolCallId: "ok", idx: 0 })
    expect(hit!.text.length).toBe(1000)
    expect(hit!.meta.truncated).toBe(false)
  })
})

describe("content store: FIFO evict + dead marker", () => {
  test("total >500K → evict tertua, tandai dead, terbaru dipertahankan", () => {
    const store = createContentStore()
    const chunk = "a".repeat(200_000)
    store.put({ toolCallId: "old1", idx: 0 }, chunk, meta)
    store.put({ toolCallId: "old2", idx: 0 }, chunk, meta)
    store.put({ toolCallId: "old3", idx: 0 }, chunk, meta) // total 600K > 500K
    // old1 harus ter-evict (FIFO tertua).
    expect(store.isDead({ toolCallId: "old1", idx: 0 })).toBe(true)
    expect(store.get({ toolCallId: "old1", idx: 0 })).toBeUndefined()
    // Terbaru dipertahankan.
    expect(store.get({ toolCallId: "old3", idx: 0 })).toBeTruthy()
    expect(store.stats().dead).toBe(1)
    expect(store.stats().totalChars).toBeLessThanOrEqual(MAX_BUFFER_TOTAL)
  })

  test("resolve dead ref → penanda retensi (bukan string kosong menyesatkan)", () => {
    const store = createContentStore()
    const chunk = "a".repeat(200_000)
    store.put({ toolCallId: "old1", idx: 0 }, chunk, meta)
    store.put({ toolCallId: "old2", idx: 0 }, chunk, meta)
    store.put({ toolCallId: "old3", idx: 0 }, chunk, meta)
    const hit = store.resolve({ toolCallId: "old1", idx: 0 })
    expect(hit?.meta.source).toBe("retention")
    expect(hit?.text).toBe("")
  })

  test("markDead eksplisit — get undefined, isDead true, resolve retention", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "isi", meta)
    store.markDead({ toolCallId: "t1", idx: 0 })
    expect(store.get({ toolCallId: "t1", idx: 0 })).toBeUndefined()
    expect(store.isDead({ toolCallId: "t1", idx: 0 })).toBe(true)
    expect(store.resolve({ toolCallId: "t1", idx: 0 })?.meta.source).toBe("retention")
  })

  test("put ulang setelah dead — hidup lagi (dead dihapus)", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "isi", meta)
    store.markDead({ toolCallId: "t1", idx: 0 })
    store.put({ toolCallId: "t1", idx: 0 }, "baru", meta)
    expect(store.isDead({ toolCallId: "t1", idx: 0 })).toBe(false)
    expect(store.get({ toolCallId: "t1", idx: 0 })?.text).toBe("baru")
  })
})

describe("content store: expand — buka-ulang identik", () => {
  test("expand tanpa consume — bisa dibuka ulang berkali-kali", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "isi tool", meta)
    const first = store.expand("t1")
    const second = store.expand("t1")
    expect(first).toEqual(second)
    expect(first[0]!.text).toBe("isi tool")
    // Bukan sekali-habis: masih ada setelah expand.
    expect(store.get({ toolCallId: "t1", idx: 0 })).toBeTruthy()
  })

  test("expand multi-idx urut", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 1 }, "b", meta)
    store.put({ toolCallId: "t1", idx: 0 }, "a", meta)
    const out = store.expand("t1")
    expect(out.map((e) => e.text)).toEqual(["a", "b"])
  })

  test("expandAll mengembalikan entry hidup dengan ref", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "satu", meta)
    store.put({ toolCallId: "t2", idx: 0 }, "dua", meta)
    expect(store.expandAll().map((entry) => [entry.ref?.toolCallId, entry.text])).toEqual([
      ["t1", "satu"],
      ["t2", "dua"],
    ])
  })
})

describe("content store: durable fallback", () => {
  test("resolve miss → durable loader (source durable)", () => {
    const store = createContentStore()
    const durable = (id: string) => (id === "t1" ? "dari sqlite" : undefined)
    const hit = store.resolve({ toolCallId: "t1", idx: 0 }, durable)
    expect(hit?.text).toBe("dari sqlite")
    expect(hit?.meta.source).toBe("durable")
    expect(hit?.meta.kind).toBe("output")
  })

  test("expand miss total → durable", () => {
    const store = createContentStore()
    const durable = (id: string) => (id === "gone" ? "persist" : undefined)
    const out = store.expand("gone", durable)
    expect(out).toHaveLength(1)
    expect(out[0]!.meta.source).toBe("durable")
    expect(out[0]!.text).toBe("persist")
  })

  test("hit store menang atas durable", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "lokal", meta)
    const hit = store.resolve({ toolCallId: "t1", idx: 0 }, () => "sqlite")
    expect(hit?.text).toBe("lokal")
    expect(hit?.meta.source).toBe("store")
  })

  test("durable miss + tak pernah dead → undefined", () => {
    const store = createContentStore()
    expect(store.resolve({ toolCallId: "x", idx: 0 }, () => undefined)).toBeUndefined()
    expect(store.expand("x", () => undefined)).toEqual([])
  })

  test("restart: store kosong, expandRef lama → durable (bukan throw)", () => {
    // Simulasi restart: store baru (empty), loader dari sqlite.
    const fresh = createContentStore()
    expect(fresh.stats().entries).toBe(0)
    const out = fresh.expand("t1", () => " hasil durable")
    expect(out[0]!.meta.source).toBe("durable")
    expect(out[0]!.text).toBe(" hasil durable")
  })
})

describe("content store: clear + stats", () => {
  test("clear mengosongkan entries + dead + totalChars", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "isi", meta)
    store.markDead({ toolCallId: "t2", idx: 0 })
    store.clear()
    expect(store.stats()).toEqual({ entries: 0, totalChars: 0, dead: 0 })
  })
})

// Cabang splitTrailingEscape (store lokal, diulang dari sanitize/collapse —
// boundary dilarang impor src/ui). Tanpa ini floor 90% gagal pada path rare.
describe("splitTrailingEscape (via put ≤ cap)", () => {
  test("ESC di ekor string (tanpa byte berikut) — dibuang", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "abc\x1b", meta)
    expect(store.get({ toolCallId: "t1", idx: 0 })?.text).toBe("abc")
  })

  test("CSI lengkap di ekor — dipertahankan utuh", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "ok\x1b[31mred", meta)
    expect(store.get({ toolCallId: "t1", idx: 0 })?.text).toBe("ok\x1b[31mred")
  })

  test("CSI tanpa byte final (habis sebelum 0x40–0x7E) — dipotong", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "ok\x1b[3;1", meta)
    expect(store.get({ toolCallId: "t1", idx: 0 })?.text).toBe("ok")
  })

  test("OSC lengkap dengan BEL — dipertahankan", () => {
    const store = createContentStore()
    const bel = String.fromCharCode(7)
    store.put({ toolCallId: "t1", idx: 0 }, `a\x1b]0;title${bel}b`, meta)
    expect(store.get({ toolCallId: "t1", idx: 0 })?.text).toBe(`a\x1b]0;title${bel}b`)
  })

  test("OSC lengkap dengan ST (ESC \\) — dipertahankan", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "a\x1b]0;t\x1b\\b", meta)
    expect(store.get({ toolCallId: "t1", idx: 0 })?.text).toBe("a\x1b]0;t\x1b\\b")
  })

  test("OSC tanpa terminator — dipotong di ESC", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "a\x1b]0;open-end", meta)
    expect(store.get({ toolCallId: "t1", idx: 0 })?.text).toBe("a")
  })

  test("DCS/APC/PM/SOS tanpa terminator — dipotong", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "a\x1bPhello", meta)
    expect(store.get({ toolCallId: "t1", idx: 0 })?.text).toBe("a")
    store.put({ toolCallId: "t2", idx: 0 }, "b\x1b^apc", meta)
    expect(store.get({ toolCallId: "t2", idx: 0 })?.text).toBe("b")
    store.put({ toolCallId: "t3", idx: 0 }, "c\x1b_pmc", meta)
    expect(store.get({ toolCallId: "t3", idx: 0 })?.text).toBe("c")
    store.put({ toolCallId: "t4", idx: 0 }, "d\x1bXsos", meta)
    expect(store.get({ toolCallId: "t4", idx: 0 })?.text).toBe("d")
  })

  test("ESC + non-CSI/OSC (single-char Fe) — dipertahankan", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "a\x1bAb", meta)
    expect(store.get({ toolCallId: "t1", idx: 0 })?.text).toBe("a\x1bAb")
  })
})

describe("resolve/expand: durable empty → retention / []", () => {
  test("resolve: durable kembalikan '' → jatuh ke retention bila dead", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "isi", meta)
    store.markDead({ toolCallId: "t1", idx: 0 })
    const hit = store.resolve({ toolCallId: "t1", idx: 0 }, () => "")
    expect(hit?.meta.source).toBe("retention")
  })

  test("expand: durable kembalikan '' + dead → retention", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 0 }, "isi", meta)
    store.markDead({ toolCallId: "t1", idx: 0 })
    const out = store.expand("t1", () => "")
    expect(out).toHaveLength(1)
    expect(out[0]!.meta.source).toBe("retention")
  })

  test("expand: durable '' + tak dead → []", () => {
    const store = createContentStore()
    expect(store.expand("x", () => "")).toEqual([])
  })
})

describe("markDead pada ref tak pernah ada", () => {
  test("tanpa entry — isDead true, get undefined", () => {
    const store = createContentStore()
    store.markDead({ toolCallId: "ghost", idx: 0 })
    expect(store.isDead({ toolCallId: "ghost", idx: 0 })).toBe(true)
    expect(store.get({ toolCallId: "ghost", idx: 0 })).toBeUndefined()
    expect(store.resolve({ toolCallId: "ghost", idx: 0 })?.meta.source).toBe("retention")
  })
})

describe("put: truncated flag pada cut < asli", () => {
  test("truncated di-set bila cut lebih pendek dari input", () => {
    const store = createContentStore()
    const text = `${"z".repeat(MAX_SECTION_CHARS + 100)}tail`
    store.put({ toolCallId: "t1", idx: 0 }, text, { ...meta, truncated: false })
    const hit = store.get({ toolCallId: "t1", idx: 0 })
    expect(hit!.meta.truncated).toBe(true)
    expect(hit!.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS)
  })
})

describe("content kind dan urutan numerik", () => {
  test("ref reasoning tidak memakai durable output fallback", () => {
    const store = createContentStore()
    const hit = store.resolve({ toolCallId: "r1", idx: 0, kind: "reasoning" }, () => "durable")
    expect(hit).toBeUndefined()
  })

  test("expand mengurutkan idx numerik", () => {
    const store = createContentStore()
    store.put({ toolCallId: "t1", idx: 10 }, "10", meta)
    store.put({ toolCallId: "t1", idx: 2 }, "2", meta)
    expect(store.expand("t1").map((entry) => entry.text)).toEqual(["2", "10"])
  })
})
