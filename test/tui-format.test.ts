// Test helper format/wrap/reasoning/statusline + simple logger.
// Semua ini sebelumnya 0% tercakup padahal murni fungsi data->data (kecuali
// simple logger, yang cukup diuji lewat EventBus tiruan).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { EventBus } from "#minicore/core/index.ts"
import {
  attachSimpleLogger,
  formatError,
  getLastTurnText,
  takePendingError,
  writeClipboardOsc52,
} from "../src/ui/assistant/simple.ts"
import { detail, setCompactMode } from "../src/ui/render/detail.ts"
import {
  formatArgsPreview,
  formatCost,
  formatProviderError,
  formatStepCalls,
  formatUsage,
} from "../src/ui/render/format.ts"
import { decorateMarkdown, renderInline } from "../src/ui/render/markdown.ts"
import { reasoning, setReasoningVisible } from "../src/ui/render/reasoning.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { formatWrapped, justifyLine, visibleLen, wordWrap } from "../src/ui/render/wrap.ts"
import { registerStatusLine, runWithoutStatus } from "../src/ui/runtime/statusline.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

describe("wrap: wordWrap", () => {
  test("baris pendek dibiarkan apa adanya", () => {
    expect(wordWrap("halo dunia", 40)).toBe("halo dunia")
  })

  test("memotong di batas spasi, bukan di tengah kata", () => {
    const out = wordWrap("satu dua tiga empat lima", 10).split("\n")
    for (const l of out) expect(l.length).toBeLessThanOrEqual(10)
    expect(out.join(" ")).toBe("satu dua tiga empat lima")
  })

  test("kata lebih panjang dari width dipecah, tidak hilang", () => {
    // Sebelumnya kata semacam ini dibiarkan utuh sehingga baris membungkus
    // sendiri di terminal dan merusak frame TUI yang menghitung tinggi per baris.
    const out = wordWrap("pendek katayangsangatpanjangsekali", 8)
    expect(out.replace(/\n/g, "")).toBe("pendekkatayangsangatpanjangsekali")
    for (const line of out.split("\n")) expect(visibleLen(line)).toBeLessThanOrEqual(8)
  })

  test("URL panjang dipecah per kolom", () => {
    const url = `https://contoh.example.com/${"a".repeat(120)}`
    const out = wordWrap(url, 40)
    expect(out.split("\n").length).toBeGreaterThan(3)
    for (const line of out.split("\n")) expect(visibleLen(line)).toBeLessThanOrEqual(40)
    expect(out.replace(/\n/g, "")).toBe(url)
  })

  test("CJK tanpa spasi dipecah per kolom terminal", () => {
    const cjk = "这是中文".repeat(10) // 40 char = 80 kolom
    const out = wordWrap(cjk, 20)
    expect(out.split("\n").length).toBeGreaterThan(1)
    for (const line of out.split("\n")) expect(visibleLen(line)).toBeLessThanOrEqual(20)
    expect(out.replace(/\n/g, "")).toBe(cjk)
  })

  test("ANSI tidak dihitung sebagai lebar", () => {
    const colored = "\x1b[36mabcd\x1b[39m \x1b[36mefgh\x1b[39m"
    // Lebar tampak 9; dengan width 12 seharusnya tetap satu baris.
    expect(wordWrap(colored, 12).split("\n").length).toBe(1)
  })

  test("width <= 0 mengembalikan teks apa adanya", () => {
    expect(wordWrap("apa saja", 0)).toBe("apa saja")
  })

  test("newline yang ada dipertahankan", () => {
    expect(wordWrap("a\nb", 40)).toBe("a\nb")
  })
})

describe("wrap: visibleLen & justifyLine", () => {
  test("visibleLen mengabaikan ANSI termasuk private-mode", () => {
    expect(visibleLen("\x1b[36mabc\x1b[39m")).toBe(3)
    expect(visibleLen("\x1b[?25labc\x1b[?25h")).toBe(3)
  })

  test("visibleLen menghitung CJK dua kolom", () => {
    expect(visibleLen("这是中文")).toBe(8)
    expect(visibleLen("ab字")).toBe(4)
  })

  test("justifyLine meratakan ke lebar target", () => {
    const out = justifyLine("a b c", 11)
    expect(out.length).toBe(11)
    expect(out.replace(/\s+/g, " ")).toBe("a b c")
  })

  test("justifyLine dengan CJK memakai lebar kolom", () => {
    const out = justifyLine("字 字", 10)
    expect(visibleLen(out)).toBe(10)
  })

  test("baris dengan satu kata tidak dijustify", () => {
    expect(justifyLine("tunggal", 40)).toBe("tunggal")
  })

  test("baris yang sudah penuh dibiarkan", () => {
    expect(justifyLine("abcde", 5)).toBe("abcde")
    expect(justifyLine("abcdef", 5)).toBe("abcdef")
  })
})

describe("wrap: formatWrapped", () => {
  const origJustify = process.env.MINICODE_JUSTIFY
  afterEach(() => {
    if (origJustify == null) delete process.env.MINICODE_JUSTIFY
    else process.env.MINICODE_JUSTIFY = origJustify
  })

  // Regresi: baris terakhir paragraf dulu ikut dijustify, menghasilkan "sungai"
  // spasi seperti `dengan      lebar      tertentu`.
  test("baris terakhir paragraf TIDAK dijustify", () => {
    const text = "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua belas"
    const lines = formatWrapped(text, 30).split("\n")
    expect(lines.length).toBeGreaterThan(1)
    const last = lines[lines.length - 1]!
    expect(last).not.toMatch(/\s{2,}/)
  })

  test("baris tengah dijustify sampai lebar penuh", () => {
    const text = "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua belas"
    const lines = formatWrapped(text, 30).split("\n")
    expect(lines[0]!.length).toBe(30)
  })

  test("baris sebelum baris kosong dianggap akhir paragraf", () => {
    const text = `${"satu dua tiga empat lima enam tujuh"}\n\nparagraf kedua`
    const lines = formatWrapped(text, 20).split("\n")
    const emptyIdx = lines.findIndex((l) => l.trim() === "")
    expect(emptyIdx).toBeGreaterThan(0)
    expect(lines[emptyIdx - 1]!).not.toMatch(/\s{2,}/)
  })

  test("MINICODE_JUSTIFY=0 mematikan justify", () => {
    process.env.MINICODE_JUSTIFY = "0"
    const text = "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh"
    for (const line of formatWrapped(text, 25).split("\n")) {
      expect(line).not.toMatch(/\s{2,}/)
    }
  })

  test("heading, bullet, code fence tidak dijustify", () => {
    for (const raw of ["# Judul yang cukup panjang", "- butir daftar di sini", "```ts"]) {
      expect(formatWrapped(raw, 60)).toBe(raw)
    }
  })

  test("justify=false melewati justify", () => {
    const text = "satu dua tiga empat lima enam tujuh delapan"
    for (const line of formatWrapped(text, 20, false).split("\n")) {
      expect(line).not.toMatch(/\s{2,}/)
    }
  })
})

describe("markdown: fence & inline", () => {
  // Warna butuh dukungan terminal; test lain di berkas ini memakai fake TTY
  // untuk itu. Sejak warna digate stdout.isTTY (pipe/redirect = polos), di
  // sini env COLORTERM saja tak cukup — stub TTY juga.
  const origColorterm = process.env.COLORTERM
  const origIsTty = (process.stdout as unknown as { isTTY?: unknown }).isTTY
  beforeEach(() => {
    process.env.COLORTERM = "truecolor"
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTty, configurable: true })
    if (origColorterm == null) delete process.env.COLORTERM
    else process.env.COLORTERM = origColorterm
  })

  // Fence TANPA bahasa adalah bentuk paling umum untuk perintah shell, dan dulu
  // jatuh ke renderInline sehingga `--flag=*value*` kehilangan bintangnya.
  test("fence tanpa bahasa: isi kode tidak didekorasi markdown", () => {
    const src = "```\nnpm run build -- --flag=*value*\n```"
    const out = decorateMarkdown(src)
    expect(out).toBe(stripAnsi(out)) // tidak ada ANSI = tidak didekorasi
    expect(out).toContain("*value*")
  })

  test("fence tanpa bahasa: underscore dan backtick tetap literal", () => {
    const src = "```\na_b_c dan `tick`\n```"
    expect(stripAnsi(decorateMarkdown(src))).toContain("a_b_c dan `tick`")
  })

  test("fence berbahasa tetap di-highlight", () => {
    const out = decorateMarkdown("```ts\nconst x = 1\n```")
    expect(out).not.toBe(stripAnsi(out)) // ada warna syntax
    expect(stripAnsi(out)).toContain("const x = 1")
  })

  test("fence tak tertutup tidak menghilangkan isi", () => {
    const out = stripAnsi(decorateMarkdown("teks\n```ts\nconst x = 1"))
    expect(out).toContain("const x = 1")
  })

  test("teks di luar fence tetap didekorasi", () => {
    const out = decorateMarkdown("**tebal**\n```\nkode\n```\n*miring*")
    expect(out).toContain("\x1b[1m") // bold
    expect(stripAnsi(out)).toContain("kode")
  })

  test("renderInline tidak mengubah teks yang bukan markdown", () => {
    for (const src of ["2 * 3 * 4", "a_b_c_d", "path/to/*.ts", "**belum ditutup"]) {
      expect(stripAnsi(renderInline(src)), src).toBe(src)
    }
  })
})

describe("format: preview argumen tool", () => {
  test("mengutamakan path, lalu command, query, prompt", () => {
    expect(formatArgsPreview({ path: "src/a.ts" })).toBe("src/a.ts")
    expect(formatArgsPreview({ command: "bun test" })).toBe("bun test")
    expect(formatArgsPreview({ query: "cari ini" })).toBe("cari ini")
    expect(formatArgsPreview({ prompt: "tolong" })).toBe("tolong")
  })

  test("fallback ke JSON terpotong", () => {
    expect(formatArgsPreview({ lain: 1 })).toBe('{"lain":1}')
  })

  test("command panjang dipotong", () => {
    expect(formatArgsPreview({ command: "x".repeat(200) }).length).toBeLessThanOrEqual(60)
  })

  test("nilai tak bisa di-serialize tidak melempar", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(formatArgsPreview(circular)).toBe("[args]")
  })
})

describe("format: usage, cost, error, step", () => {
  test("formatUsage hanya menampilkan field yang ada", () => {
    expect(formatUsage({ inputTokens: 10 })).toBe("in:10")
    expect(formatUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 })).toBe(
      "in:1 out:2 total:3",
    )
    expect(formatUsage({})).toBe("")
  })

  test("formatCost memberi N/A bila tidak diketahui", () => {
    expect(formatCost(0.1234)).toBe("$0.1234")
    expect(formatCost(undefined)).toBe("N/A")
  })

  test("formatProviderError memetakan kategori ke pesan + saran", () => {
    const out = formatProviderError({ category: "auth", message: "401" })
    expect(out).toContain("rejected authentication")
    expect(out).toContain("→") // saran tindakan
    // Kategori mentah dan kode HTTP tidak dibocorkan ke layar.
    expect(out).not.toContain("[auth]")
    expect(formatProviderError({})).toBeTypeOf("string")
  })

  test("formatProviderError meringkas body JSON provider", () => {
    const or429 =
      'rate limited (429): {"error":{"message":"Provider returned error","metadata":{"raw":"model X is temporarily rate-limited upstream.","remedy_hint":"Retry shortly."}}}'
    const out = formatProviderError({ category: "rate_limit", message: or429 })
    expect(out).toContain("rate-limited upstream")
    expect(out).not.toContain("metadata")
    expect(out.length).toBeLessThanOrEqual(220)
  })

  test("formatStepCalls meringkas nama + argumen", () => {
    const out = formatStepCalls([
      { id: "1", name: "bash", args: { cmd: "ls" } },
      { id: "2", name: "read_file", args: { path: "a.ts" } },
    ] as never)
    expect(out).toContain("bash(")
    expect(out).toContain("read_file(")
  })
})

describe("format: formatError", () => {
  test("AgentError (punya kind) dipetakan ke pesan yang bisa ditindaklanjuti", () => {
    const out = formatError({ kind: "timeout", message: "lewat batas" })
    expect(out.toLowerCase()).toContain("timeout")
    expect(out).not.toContain("timeout:") // nama kode tidak dibocorkan
  })

  test("ProviderError (punya category) memakai pemetaan kategori", () => {
    const out = formatError({ category: "rate_limit", message: "429" })
    expect(out).toContain("rate-limiting")
  })

  test("Error biasa tetap memakai message-nya", () => {
    expect(formatError(new Error("meledak"))).toBe("meledak")
  })

  test("nilai lain di-stringify", () => {
    expect(formatError("teks")).toBe("teks")
    expect(formatError(42)).toBe("42")
  })
})

describe("reasoning: satu state untuk /thinking", () => {
  const orig = reasoning.visible
  afterEach(() => {
    setReasoningVisible(orig)
  })

  test("toggle tanpa argumen membalik nilai", () => {
    setReasoningVisible(false)
    expect(setReasoningVisible()).toBe(true)
    expect(setReasoningVisible()).toBe(false)
  })

  test("set eksplisit menang", () => {
    expect(setReasoningVisible(true)).toBe(true)
    expect(reasoning.visible).toBe(true)
    expect(setReasoningVisible(false)).toBe(false)
  })

  test("env disinkronkan supaya sub-proses mewarisi pilihan", () => {
    setReasoningVisible(true)
    expect(process.env.MINICODE_SHOW_THINKING).toBe("1")
    setReasoningVisible(false)
    expect(process.env.MINICODE_SHOW_THINKING).toBe("0")
  })
})

describe("detail: state compact", () => {
  afterEach(() => {
    setCompactMode(false)
  })

  test("toggle tanpa argumen membalik nilai", () => {
    setCompactMode(false)
    expect(setCompactMode()).toBe(true)
    expect(setCompactMode()).toBe(false)
  })

  test("set eksplisit menang", () => {
    expect(setCompactMode(true)).toBe(true)
    expect(detail.compact).toBe(true)
    expect(setCompactMode(false)).toBe(false)
  })

  test("env disinkronkan supaya sub-proses mewarisi pilihan", () => {
    setCompactMode(true)
    expect(process.env.MINICODE_COMPACT).toBe("1")
    setCompactMode(false)
    expect(process.env.MINICODE_COMPACT).toBe("0")
  })
})

describe("statusline: koordinasi suspend/resume", () => {
  afterEach(() => {
    registerStatusLine(null)
  })

  test("tanpa handle terdaftar, fn tetap dijalankan", () => {
    expect(runWithoutStatus(() => 7)).toBe(7)
  })

  test("handle di-suspend sebelum dan di-resume sesudah", () => {
    const calls: string[] = []
    registerStatusLine({
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
    })
    const out = runWithoutStatus(() => {
      calls.push("tulis")
      return "ok"
    })
    expect(out).toBe("ok")
    expect(calls).toEqual(["suspend", "tulis", "resume"])
  })

  test("resume tetap jalan meski fn melempar", () => {
    const calls: string[] = []
    registerStatusLine({
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
    })
    expect(() =>
      runWithoutStatus(() => {
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(calls).toEqual(["suspend", "resume"])
  })

  test("nested write hanya suspend/resume sekali", () => {
    const calls: string[] = []
    registerStatusLine({
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
    })

    const out = runWithoutStatus(() =>
      runWithoutStatus(() => {
        calls.push("tulis")
        return "ok"
      }),
    )

    expect(out).toBe("ok")
    expect(calls).toEqual(["suspend", "tulis", "resume"])
  })

  test("register handle baru saat nested tidak me-resume handle lama", () => {
    const callsA: string[] = []
    registerStatusLine({
      suspend: () => callsA.push("suspend-a"),
      resume: () => callsA.push("resume-a"),
    })

    runWithoutStatus(() => {
      registerStatusLine({ suspend: () => {}, resume: () => {} })
    })

    expect(callsA).toEqual(["suspend-a"])
  })
})

describe("simple logger (one-shot)", () => {
  let tty: FakeTty | undefined
  afterEach(() => {
    tty?.restore()
    tty = undefined
    setCompactMode(false)
    setReasoningVisible(false)
    delete process.env.MINICODE_MINIMIZE_TOOL
  })

  const attach = (verbose = false, rows = 24) => {
    // Jangan biarkan harness lama tak ter-restore (env COLORTERM/isTTY bocor
    // ke file test berikutnya dalam proses yang sama).
    tty?.restore()
    tty = installFakeTty({ columns: 80, rows })
    const bus = createFakeBus()
    const detach = attachSimpleLogger(bus as unknown as EventBus, { verbose })
    // Renderer memisahkan aliran: teks model ke stdout, ringkasan tool/error ke
    // stderr. Assertion memakai gabungan keduanya.
    return { bus, detach, out: () => stripAnsi(tty!.combined()) }
  }

  test("provider:text distream per baris", () => {
    const { bus, detach, out } = attach()
    bus.emit("provider:text", { text: "baris satu\nbaris dua\n" })
    detach()
    expect(out()).toContain("baris satu")
    expect(out()).toContain("baris dua")
  })

  test("teks model disanitasi sebelum masuk scrollback", () => {
    const { bus, detach, out } = attach()
    bus.emit("provider:text", { text: "halo\x1b[2J\x1b[?1049l dunia\n" })
    detach()
    const o = out()
    expect(o).not.toContain("\x1b[2J")
    expect(o).not.toContain("\x1b[?1049l")
    expect(o).toContain("halo dunia")
  })

  test("sisa buffer di-flush saat turn selesai", () => {
    const { bus, detach, out } = attach()
    bus.emit("provider:text", { text: "tanpa newline" })
    bus.emit("turn:completed", { result: { usage: { turns: 1 } } })
    detach()
    expect(out()).toContain("tanpa newline")
  })

  test("write_file/edit dilaporkan dengan path", () => {
    const { bus, detach, out } = attach()
    bus.emit("execution:completed", {
      execution: {
        call: { name: "write_file", args: { path: "a.ts" } },
        result: { isError: false, content: "xyz" },
      },
    })
    bus.emit("execution:completed", {
      execution: {
        call: { name: "edit", args: { path: "b.ts" } },
        result: { isError: false, content: "" },
      },
    })
    detach()
    expect(out()).toContain("write_file a.ts")
    expect(out()).toContain("edit b.ts")
  })

  test("compact: bash menampilkan perintah + potongan 3 baris keluaran", () => {
    setCompactMode(true)
    const { bus, detach, out } = attach()
    bus.emit("execution:completed", {
      execution: {
        call: { name: "bash", args: { cmd: "bun test" } },
        result: { isError: false, content: "l1\nl2\nl3\nl4\nl5" },
      },
    })
    detach()
    const o = out()
    expect(o).toContain("bun test")
    expect(o).toContain("l1")
    expect(o).not.toContain("l4")
    expect(o).toContain("more")
  })

  test("expanded: execution:started mencetak tool + target", () => {
    const { bus, detach, out } = attach()
    bus.emit("execution:started", {
      execution: { call: { name: "bash", args: { cmd: "ls -la" } } },
    })
    detach()
    expect(out()).toContain("bash ls -la")
  })

  test("expanded: keluaran bash panjang dipangkas dengan penanda sisa", () => {
    // rows=24 → cap max(10, 24-6)=18 baris.
    const { bus, detach, out } = attach()
    const lines = Array.from({ length: 60 }, (_, i) => `baris-${i + 1}`)
    bus.emit("execution:completed", {
      execution: {
        call: { name: "bash", args: { cmd: "urutan" } },
        result: { isError: false, content: lines.join("\n") },
      },
    })
    detach()
    const o = out()
    expect(o).toContain("baris-18")
    expect(o).not.toContain("baris-19")
    expect(o).toContain("42 more lines")
  })

  test("expanded: cap output adaptif terhadap tinggi terminal", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `r${i + 1}`)
    const run = (rows: number) => {
      const { bus, detach, out } = attach(false, rows)
      bus.emit("execution:completed", {
        execution: {
          call: { name: "bash", args: { cmd: "urutan" } },
          result: { isError: false, content: lines.join("\n") },
        },
      })
      detach()
      return out()
    }
    // rows=10 → max(10, 4)=10; rows=60 → 60-6=54.
    expect(run(10)).toContain("r10")
    expect(run(10)).not.toContain("r11")
    expect(run(60)).toContain("r54")
    expect(run(60)).not.toContain("r55")
  })

  test("expanded: edit menampilkan diff card inline", () => {
    const { bus, detach, out } = attach()
    bus.emit("execution:completed", {
      execution: {
        call: {
          name: "edit",
          args: { path: "f.ts", oldString: "lama", newString: "baru" },
        },
        result: { isError: false, content: "" },
      },
    })
    detach()
    const o = out()
    expect(o).toContain("f.ts")
    expect(o).toContain("+ baru")
    expect(o).toContain("- lama")
  })

  test("compact: edit hanya baris ringkasan", () => {
    setCompactMode(true)
    const { bus, detach, out } = attach()
    bus.emit("execution:completed", {
      execution: {
        call: {
          name: "edit",
          args: { path: "f.ts", oldString: "lama", newString: "baru" },
        },
        result: { isError: false, content: "" },
      },
    })
    detach()
    const o = out()
    expect(o).toContain("edit f.ts")
    expect(o).not.toContain("+ baru")
  })

  test("expanded: apply_patch merender blok search/replace sebagai diff", () => {
    const { bus, detach, out } = attach()
    bus.emit("execution:completed", {
      execution: {
        call: {
          name: "apply_patch",
          args: { path: "g.ts", patches: [{ search: "satu", replace: "dua" }] },
        },
        result: { isError: false, content: "" },
      },
    })
    detach()
    const o = out()
    expect(o).toContain("g.ts")
    expect(o).toContain("+ dua")
    expect(o).toContain("- satu")
  })

  test("expanded: read_file preview adaptif + penanda sisa", () => {
    // rows=24 → preview max(6, 8)=8 baris.
    const { bus, detach, out } = attach()
    const lines = Array.from({ length: 30 }, (_, i) => `isi-${i + 1}`)
    bus.emit("execution:completed", {
      execution: {
        call: { name: "read_file", args: { path: "baca.ts" } },
        result: { isError: false, content: lines.join("\n") },
      },
    })
    detach()
    const o = out()
    expect(o).toContain("isi-8")
    expect(o).not.toContain("isi-9")
    expect(o).toContain("22 more lines")
  })

  test("hasil tool disanitasi dari sekuens kontrol", () => {
    const { bus, detach, out } = attach()
    bus.emit("execution:completed", {
      execution: {
        call: { name: "read_file", args: { path: "x.ts" } },
        result: { isError: false, content: "halo\x1b[2Jdunia" },
      },
    })
    detach()
    const o = out()
    expect(o).not.toContain("\x1b[2J")
    expect(o).toContain("halodunia")
  })

  test("tool error ditandai", () => {
    const { bus, detach, out } = attach()
    bus.emit("execution:completed", {
      execution: {
        call: { name: "bash", args: { cmd: "x" } },
        result: { isError: true, content: "gagal" },
      },
    })
    detach()
    expect(out()).toContain("gagal")
  })

  test("provider error ditunda ke driver (tanpa cetak ganda)", () => {
    const { bus, detach, out } = attach()
    bus.emit("provider:extension", { kind: "error", data: { category: "auth", message: "401" } })
    detach()
    // Event live TIDAK langsung mencetak — driver mencetak sekali via
    // takePendingError, jadi satu kegagalan = satu blok ✗ (bukan dua).
    expect(out()).not.toContain("rejected authentication")
    expect(takePendingError()).toContain("rejected authentication")
    expect(takePendingError()).toBeNull() // consume-once
  })

  test("reasoning tampil bila /thinking aktif walau tanpa --verbose", () => {
    setReasoningVisible(true)
    const { bus, detach, out } = attach(false)
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "isi pemikiran" } })
    detach()
    setReasoningVisible(false)
    expect(out()).toContain("isi pemikiran")
  })

  test("reasoning disembunyikan bila /thinking nonaktif dan bukan verbose", () => {
    setReasoningVisible(false)
    const { bus, detach, out } = attach(false)
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "rahasia" } })
    detach()
    expect(out()).not.toContain("rahasia")
  })

  test("detach melepas listener", () => {
    const { bus, detach, out } = attach()
    detach()
    bus.emit("provider:text", { text: "setelah detach" })
    expect(out()).not.toContain("setelah detach")
  })

  test("verbose: header turn + step + usage + bash-output tercetak", () => {
    const { bus, detach, out } = attach(true)
    bus.emit("turn:started", { turn: 3 })
    bus.emit("step:started", {
      step: { index: 2, toolCalls: [{ name: "bash", args: { cmd: "ls" } }] },
    })
    bus.emit("provider:extension", { kind: "usage", data: { inputTokens: 10, outputTokens: 5 } })
    bus.emit("provider:extension", { kind: "bash-output", data: { text: "progres build\n" } })
    bus.emit("turn:completed", {})
    detach()
    const o = out()
    expect(o).toContain("Turn 3")
    expect(o).toContain("Step 2")
    expect(o).toContain("bash")
    expect(o).toContain("progres build")
  })

  test("verbose: usage diringkas lewat formatUsage", () => {
    const { bus, detach, out } = attach(true)
    bus.emit("provider:extension", { kind: "usage", data: { inputTokens: 1234, outputTokens: 56 } })
    detach()
    expect(out()).toMatch(/\d/)
  })

  test("verbose tanpa usage tidak mencetak apa pun", () => {
    const { bus, detach, out } = attach(true)
    bus.emit("provider:extension", { kind: "usage", data: {} })
    detach()
    expect(out()).not.toContain("tok")
  })

  test("content_filter diblokir dilaporkan", () => {
    const { bus, detach, out } = attach()
    bus.emit("provider:extension", { kind: "content_filter", data: {} })
    detach()
    expect(out()).toContain("Content filter")
  })

  test("todo_write menampilkan daftar todo utuh", () => {
    const { bus, detach, out } = attach()
    bus.emit("execution:completed", {
      execution: {
        call: { name: "todo_write", args: {} },
        result: { isError: false, content: "1. satu\n2. dua" },
      },
    })
    detach()
    const o = out()
    expect(o).toContain("todo_write")
    expect(o).toContain("1. satu")
    expect(o).toContain("2. dua")
  })

  test("compact: execution:started SENYAP (progres = garis status, bukan baris)", () => {
    // Baris "running x..." tanpa newline dulu menempel ke baris › berikutnya
    // dan mencemari log non-interaktif; mode compact hanya menampilkan ledger
    // hasil (execution:completed), bukan start tool.
    setCompactMode(true)
    const { bus, detach, out } = attach(true)
    bus.emit("execution:started", { execution: { call: { name: "grep", args: {} } } })
    detach()
    expect(out()).toBe("")
  })

  test("compact: hasil tool konten = satu baris › + target (tanpa bocor isi)", () => {
    setCompactMode(true)
    const { bus, detach, out } = attach()
    bus.emit("execution:completed", {
      execution: {
        call: { name: "read_file", args: { path: "src/auth.ts" } },
        result: { isError: false, content: "1: export const x = 1\n2: // rahasia implementasi" },
      },
    })
    detach()
    const o = out()
    expect(o).toContain("› read_file src/auth.ts")
    expect(o).not.toContain("rahasia implementasi")
    expect(o.endsWith("\n")).toBe(true)
  })

  test("expanded: write_file menampilkan ukuran hasil", () => {
    const { bus, detach, out } = attach()
    bus.emit("execution:completed", {
      execution: {
        call: { name: "write_file", args: { path: "baru.ts", content: "xyz" } },
        result: { isError: false, content: "3 chars" },
      },
    })
    detach()
    expect(out()).toContain("write_file baru.ts")
    // size = panjang string hasil, bukan isi args
    expect(out()).toMatch(/\(\d+ chars\)/)
  })
  test("copy: buffer turn terakhir terakumulasi + reset per turn", () => {
    const { bus, detach } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:text", { text: "jawaban penting\n" })
    bus.emit("execution:completed", {
      execution: { call: { name: "bash", args: { cmd: "echo hi" } }, result: { content: "hi" } },
    })
    expect(getLastTurnText()).toContain("jawaban penting")
    expect(getLastTurnText()).toContain("hi")
    bus.emit("turn:started", { turn: 2 })
    expect(getLastTurnText()).toBe("")
    detach()
  })

  test("copy: OSC52 butuh TTY — non-TTY mengembalikan false", () => {
    const prevTty = process.stdout.isTTY
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
    try {
      expect(writeClipboardOsc52("x")).toBe(false)
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: prevTty, configurable: true })
    }
  })

  test("statusline rich: getStats tampil bila disediakan", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const bus = createFakeBus()
    const { attachTurnStatus } = await import("../src/ui/assistant/turn-status.ts")
    const status = attachTurnStatus(bus as unknown as EventBus, {
      initialModel: "m",
      getStats: () => "5 tok",
    })
    bus.emit("turn:started", { turn: 1 })
    // Lukisan dimulai oleh event kerja pertama (reasoning), bukan turn:started
    // — jendela pra-event dibiarkan polos (lihat komentar lifecycle modul).
    bus.emit("provider:extension", { kind: "reasoning", data: {} })
    await new Promise((r) => setTimeout(r, 350))
    status.detach()
    expect(stripAnsi(tty!.combined())).toContain("5 tok")
  })

  test("statusline: ikon putih + titik animasi, tanpa nama model", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const bus = createFakeBus()
    const { attachTurnStatus } = await import("../src/ui/assistant/turn-status.ts")
    const chunks: string[] = []
    const prevWrite = process.stderr.write.bind(process.stderr)
    ;(process.stderr as unknown as { write: unknown }).write = (c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"))
      return true
    }
    try {
      const status = attachTurnStatus(bus as unknown as EventBus, {
        initialModel: "model-rahasia-xyz",
      })
      bus.emit("turn:started", { turn: 1 })
      bus.emit("provider:extension", { kind: "reasoning", data: {} })
      await new Promise((r) => setTimeout(r, 900))
      status.detach()
      const raw = chunks.join("")
      expect(stripAnsi(raw)).toContain("✦")
      expect(raw).not.toContain("model-rahasia-xyz")
      // Animasi titik spasi "·" → "· ·" → "· · ·" (tiap 3 tick):
      // minimal dua wujud berbeda dalam 900ms, dan tak pernah bare.
      const frames = new Set(stripAnsi(raw).match(/✦  (·( ·){0,2})/g) ?? [])
      expect(frames.size).toBeGreaterThan(1)
      expect(stripAnsi(raw)).not.toMatch(/✦  (?![·])/)
    } finally {
      ;(process.stderr as unknown as { write: unknown }).write = prevWrite
    }
  })

  test("copy: envelope OSC52 benar saat TTY", () => {
    const prevTty = process.stdout.isTTY
    const prevWrite = process.stdout.write.bind(process.stdout)
    const chunks: string[] = []
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    ;(process.stdout as unknown as { write: unknown }).write = (c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"))
      return true
    }
    try {
      expect(writeClipboardOsc52("halo")).toBe(true)
      const seq = chunks.join("")
      // Dibangun dinamis (bukan literal regex) agar bebas control character
      // mentah (noControlCharactersInRegex) sekaligus bukan string statis
      // (useRegexLiterals) — ESC/BEL dari char code seperti pola ANSI theme.ts.
      const ESC = String.fromCharCode(27)
      const BEL = String.fromCharCode(7)
      const m = new RegExp(`^${ESC}\\]52;c;([A-Za-z0-9+/=]+)${BEL}$`).exec(seq)
      expect(m).not.toBeNull()
      expect(Buffer.from(m![1]!, "base64").toString("utf8")).toBe("halo")
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: prevTty, configurable: true })
      ;(process.stdout as unknown as { write: unknown }).write = prevWrite
    }
  })

  describe("simple logger: kontrak output (adversarial)", () => {
    const toolDone = (name: string, p: string, isError = false) => ({
      execution: {
        call: { name, args: { path: p } },
        result: {
          isError,
          content: isError ? `gagal membaca ${p}` : `1: isi ${p}\n2: rahasia-${p}`,
        },
      },
    })

    test("20 tool selesai beruntun: satu baris › per tool, semua diakhiri newline, tanpa overlap", () => {
      setCompactMode(true)
      const { bus, detach, out } = attach()
      for (let i = 0; i < 20; i++)
        bus.emit("execution:completed", toolDone("read_file", `f${i}.ts`))
      detach()
      setCompactMode(false)
      const lines = out().split("\n")
      const nonEmpty = lines.filter((l) => l.length > 0)
      expect(nonEmpty).toHaveLength(20)
      // Setiap baris utuh (bukan hasil tempel/overlap) — overlap lama tampil
      // sebagai dua marker dalam satu baris.
      for (const l of nonEmpty) expect(l.startsWith("  › read_file f"), l).toBe(true)
      // Tanpa bocor isi file ke ledger compact.
      expect(out()).not.toContain("rahasia-")
    })

    test("tool gagal lalu retry sukses: dua baris terpisah, gagal dulu lalu sukses", () => {
      setCompactMode(true)
      const { bus, detach, out } = attach()
      bus.emit("execution:completed", toolDone("read_file", "a.ts", true))
      bus.emit("execution:completed", toolDone("read_file", "a.ts"))
      detach()
      setCompactMode(false)
      const o = out()
      const x = o.indexOf("› read_file: gagal membaca")
      const ok = o.indexOf("› read_file a.ts")
      expect(x).toBeGreaterThanOrEqual(0)
      expect(ok).toBeGreaterThan(x)
    })

    test("tool selesai bersamaan dengan aliran teks: konten tidak menyatu dengan ledger", () => {
      setCompactMode(true)
      const { bus, detach } = attach()
      bus.emit("execution:completed", toolDone("read_file", "a.ts"))
      bus.emit("provider:text", { text: "PESAN-RAHASIA-UNIK\n" })
      detach()
      setCompactMode(false)
      expect(tty!.all()).toContain("PESAN-RAHASIA-UNIK") // stdout = teks model
      expect(tty!.all()).not.toContain("› read_file")
      expect(tty!.allErr()).toContain("› read_file a.ts") // stderr = ledger
      expect(tty!.allErr()).not.toContain("PESAN-RAHASIA-UNIK")
    })

    test("stdout = output program; stderr = ledger/diagnostik (kontrak Unix)", () => {
      const { bus, detach } = attach()
      bus.emit("provider:text", { text: "hasil analisis\n" })
      bus.emit("execution:completed", toolDone("grep", "src", false))
      detach()
      expect(tty!.all()).toContain("hasil analisis")
      expect(tty!.allErr()).toContain("› grep src")
    })
  })
})

test("wrap: spasi ganda ASCII art tidak collapse", () => {
  expect(wordWrap("name    value", 40)).toBe("name    value")
  const narrow = wordWrap("ab  cd  ef", 6).split("\n")
  expect(narrow[0]).toBe("ab  cd")
  expect(narrow.every((l) => displayWidth(l) <= 6)).toBe(true)
})

test("wrap: baris spasi ganda tidak dijustify", () => {
  expect(formatWrapped("kolom1  kolom2  kolom3", 40)).toBe("kolom1  kolom2  kolom3")
})
