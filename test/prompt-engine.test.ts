import { expect, test } from "bun:test"
import {
  applyKey,
  buildRenderSpec,
  createDecoderState,
  createState,
  decodeKeys,
  decodeKeysStream,
  MAX_VISIBLE,
  type PromptKey,
  pointLength,
} from "../src/ui/input/prompt-engine.ts"

const cmds = [
  "/help",
  "/providers",
  "/provider-add",
  "/provider-remove",
  "/models",
  "/model",
  "/undo",
  "/redo",
  "/cost",
  "/sessions",
]
const hints = (l: string): string[] =>
  l.startsWith("/") ? cmds.filter((c) => c.startsWith(l)) : []

test("createState: empty defaults", () => {
  const s = createState()
  expect(s).toEqual({ line: "", cursor: 0, sel: -1, menuOpen: false })
})

test("char '/' opens menu, other chars don't", () => {
  let r = applyKey(createState(), { type: "char", ch: "/" }, hints)
  expect(r.state.menuOpen).toBe(true)
  expect(r.state.sel).toBe(-1)
  expect(r.action).toBe("render")

  r = applyKey(createState(), { type: "char", ch: "h" }, hints)
  expect(r.state.menuOpen).toBe(false)
})

test("backspace closes menu when line no longer starts with /", () => {
  let s = createState()
  s = applyKey(s, { type: "char", ch: "/" }, hints).state
  s = applyKey(s, { type: "char", ch: "h" }, hints).state
  s = applyKey(s, { type: "backspace" }, hints).state
  expect(s.line).toBe("/")
  expect(s.menuOpen).toBe(true)
  // backspace remaining '/' closes
  s = applyKey(s, { type: "backspace" }, hints).state
  expect(s.line).toBe("")
  expect(s.menuOpen).toBe(false)
})

test("up/down wraps selection", () => {
  let s = createState()
  s = applyKey(s, { type: "char", ch: "/" }, hints).state
  s = applyKey(s, { type: "down" }, hints).state
  expect(s.sel).toBe(0)
  s = applyKey(s, { type: "down" }, hints).state
  expect(s.sel).toBe(1)
  s = applyKey(s, { type: "down" }, hints).state
  expect(s.sel).toBe(2)
  // wrap to end
  s = applyKey(s, { type: "up" }, hints).state
  expect(s.sel).toBe(1)
  // up from 0 wraps to last
  s = applyKey(s, { type: "up" }, hints).state
  s = applyKey(s, { type: "up" }, hints).state
  expect(s.sel).toBe(cmds.length - 1)
  s = applyKey(s, { type: "down" }, hints).state
  expect(s.sel).toBe(0)
})

test("tab picks selected item and closes menu", () => {
  let s = createState()
  s = applyKey(s, { type: "char", ch: "/" }, hints).state
  s = applyKey(s, { type: "char", ch: "m" }, hints).state
  expect(s.menuOpen).toBe(true)
  // Tab kini HANYA putar mode (cycle `auto→ask→plan→allowlist`) via `onKey`
  // di REPL, bukan melengkapi. Completion via ↑/↓ + Enter. Tanpa ini Tab
  // saat mengetik tidak bisa ganti mode (keluhan nyata).
  const r = applyKey(s, { type: "tab" }, hints)
  expect(r.state.line).toBe("/m")
  expect(r.state.menuOpen).toBe(true)
})

test("enter picks selected item, submits", () => {
  let s = createState()
  s = applyKey(s, { type: "char", ch: "/" }, hints).state
  s = applyKey(s, { type: "down" }, hints).state // sel=0 → /help
  const r = applyKey(s, { type: "enter" }, hints)
  expect(r.action).toBe("submit")
  expect(r.state.line).toBe("/help")
})

test("enter on plain text submits as-is", () => {
  let s = createState()
  s = applyKey(s, { type: "char", ch: "h" }, hints).state
  s = applyKey(s, { type: "char", ch: "i" }, hints).state
  const r = applyKey(s, { type: "enter" }, hints)
  expect(r.action).toBe("submit")
  expect(r.state.line).toBe("hi")
})

test("enter with menu open but no matching row → keeps line but submits", () => {
  let s = createState()
  s = applyKey(s, { type: "char", ch: "/" }, hints).state
  s = applyKey(s, { type: "char", ch: "z" }, hints).state // no match
  const r = applyKey(s, { type: "enter" }, hints)
  expect(r.action).toBe("submit")
  expect(r.state.line).toBe("/z")
})

test("esc closes menu without changing line", () => {
  let s = createState()
  s = applyKey(s, { type: "char", ch: "/" }, hints).state
  s = applyKey(s, { type: "down" }, hints).state
  const r = applyKey(s, { type: "esc" }, hints)
  expect(r.state.menuOpen).toBe(false)
  expect(r.state.line).toBe("/")
  expect(r.state.sel).toBe(-1)
})

test("esc on closed menu → no-op", () => {
  const r = applyKey(createState(), { type: "esc" }, hints)
  expect(r.action).toBe("none")
})

test("ctrl-c and ctrl-d cancel", () => {
  expect(applyKey(createState(), { type: "ctrl-c" }, hints).action).toBe("cancel")
  expect(applyKey(createState(), { type: "ctrl-d" }, hints).action).toBe("cancel")
})

test("char on empty line keeps menu closed for normal text", () => {
  let s = applyKey(createState(), { type: "char", ch: "a" }, hints).state
  expect(s.menuOpen).toBe(false)
  s = applyKey(s, { type: "char", ch: "/" }, hints).state
  expect(s.menuOpen).toBe(false) // "a/" does not open menu
})

test("buildRenderSpec: cap at MAX_VISIBLE with moreCount", () => {
  const s = { line: "/", cursor: 1, sel: -1, menuOpen: true }
  const spec = buildRenderSpec(s, "minicode❯ ", hints("/"))
  expect(spec.rows.length).toBeLessThanOrEqual(MAX_VISIBLE)
  expect(spec.moreCount).toBe(
    spec.rows.length > MAX_VISIBLE ? 0 : Math.max(0, hints("/").length - MAX_VISIBLE),
  )
  expect(spec.inputLine).toBe("minicode❯ /")
})

test("buildRenderSpec: more hint list than visible → moreCount > 0", () => {
  const many = new Array(25).fill("/cmd").map((_, i) => `/cmd${i}`)
  const s = { line: "/", cursor: 1, sel: -1, menuOpen: true }
  const spec = buildRenderSpec(s, "p", many)
  expect(spec.rows.length).toBe(MAX_VISIBLE)
  expect(spec.moreCount).toBe(15)
  expect(spec.totalRows).toBe(MAX_VISIBLE + 1)
})

test("buildRenderSpec: selection row marked picked", () => {
  const s = { line: "/", cursor: 1, sel: 3, menuOpen: true }
  const spec = buildRenderSpec(s, "p", cmds)
  const picked = spec.rows.filter((r) => r.picked)
  expect(picked.length).toBe(1)
  expect(picked[0]?.text).toBe(cmds[3]!)
})

test("buildRenderSpec: grouped hints → header rows dinamis", () => {
  const s = { line: "/", cursor: 1, sel: 0, menuOpen: true }
  const spec = buildRenderSpec(s, "p", ["/help", "/my-skill"], (t) =>
    t.startsWith("/help") ? "commands" : "skills",
  )
  expect(spec.rows[0]).toEqual({ kind: "header", text: "COMMANDS", picked: false })
  expect(spec.rows[1]).toMatchObject({ kind: "item", text: "/help" })
  expect(spec.rows[2]).toEqual({ kind: "header", text: "SKILLS", picked: false })
  expect(spec.rows[3]).toMatchObject({ kind: "item", text: "/my-skill" })
  // totalRows menghitung header juga
  expect(spec.totalRows).toBe(4)
})

test("decodeKeys: plain text + LF adalah ctrl-j (multiline), CR enter", () => {
  const keys = decodeKeys(new TextEncoder().encode("ok\n"))
  expect(keys.map((k) => k.key.type)).toEqual(["char", "char", "ctrl-j"])
  expect(keys[0]?.key).toEqual({ type: "char", ch: "o" })
  expect(decodeKeys(new TextEncoder().encode("ok\r")).map((k) => k.key.type)).toEqual([
    "char",
    "char",
    "enter",
  ])
})

test("decodeKeys: arrows & escape", () => {
  const keys = decodeKeys(new TextEncoder().encode("\x1b[A\x1b[B\x1b[C\x1b[D"))
  expect(keys.map((k) => k.key.type)).toEqual(["up", "down", "right", "left"])
})

test("decodeKeys: backspace, tab, ctrl-c", () => {
  const keys = decodeKeys(new TextEncoder().encode("\x7f\t\u0003\u0004"))
  expect(keys.map((k) => k.key.type)).toEqual(["backspace", "tab", "ctrl-c", "ctrl-d"])
})

test("decodeKeys: multi-byte UTF-8 emoji decoded correctly", () => {
  const emoji = new TextEncoder().encode("✓")
  const keys = decodeKeys(emoji)
  expect(keys.length).toBe(1)
  expect(keys[0]?.key).toEqual({ type: "char", ch: "✓" })
})

test("decodeKeys: 4-byte emoji char", () => {
  const keys = decodeKeys(new TextEncoder().encode("✅"))
  expect(keys.length).toBe(1)
  expect(keys[0]?.key).toEqual({ type: "char", ch: "✅" })
})

test("decodeKeys: 2-unit surrogate pair emoji (4-byte UTF-8)", () => {
  const keys = decodeKeys(new TextEncoder().encode("😀"))
  expect(keys.length).toBe(1)
  expect(keys[0]?.key).toEqual({ type: "char", ch: "😀" })
})

test("decodeKeys: mixed emoji + text stays intact", () => {
  const keys = decodeKeys(new TextEncoder().encode("halo😀ok\n"))
  const chars = keys.map((k) => (k.key.type === "char" ? k.key.ch : null)).filter(Boolean)
  expect(chars.join("")).toBe("halo😀ok")
  expect(keys[keys.length - 1]?.key.type).toBe("ctrl-j")
})

test("applyKey: backspace removes full surrogate pair", () => {
  let s = createState()
  s = applyKey(s, { type: "char", ch: "a" }, hints).state
  s = applyKey(s, { type: "char", ch: "😀" }, hints).state
  expect(s.line).toBe("a😀")
  s = applyKey(s, { type: "backspace" }, hints).state
  expect(s.line).toBe("a")
  // backspace below the emoji: line stays valid UTF-16 (no lone surrogate)
  s = applyKey(s, { type: "char", ch: "😀" }, hints).state
  const bytes = new TextEncoder().encode(s.line)
  const back = decodeKeys(bytes)
  expect(back.length).toBe(2) // a + 😀
})

test("applyKey: emoji in non-slash line does not open menu", () => {
  const s = applyKey(createState(), { type: "char", ch: "\u{1F600}" }, hints)
  expect(s.state.menuOpen).toBe(false)
})

// -- Kursor --
// Sebelumnya left/right no-op dan PromptState tidak punya posisi kursor, jadi
// tidak ada editing di tengah baris sama sekali: untuk memperbaiki satu kata
// user harus menghapus seluruh sisa prompt.

function typeAll(text: string, start = createState()) {
  let s = start
  for (const ch of Array.from(text)) s = applyKey(s, { type: "char", ch }, hints).state
  return s
}

test("kursor: mengetik memajukan kursor", () => {
  const s = typeAll("abc")
  expect(s.line).toBe("abc")
  expect(s.cursor).toBe(3)
})

test("kursor: left/right bergerak dan dijepit di batas", () => {
  let s = typeAll("abc")
  s = applyKey(s, { type: "left" }, hints).state
  expect(s.cursor).toBe(2)
  s = applyKey(s, { type: "left" }, hints).state
  s = applyKey(s, { type: "left" }, hints).state
  expect(s.cursor).toBe(0)
  const atStart = applyKey(s, { type: "left" }, hints)
  expect(atStart.action).toBe("none")
  expect(atStart.state.cursor).toBe(0)

  s = applyKey(s, { type: "right" }, hints).state
  expect(s.cursor).toBe(1)
  s = applyKey(s, { type: "end" }, hints).state
  const atEnd = applyKey(s, { type: "right" }, hints)
  expect(atEnd.action).toBe("none")
  expect(atEnd.state.cursor).toBe(3)
})

test("kursor: karakter disisipkan di posisi kursor", () => {
  let s = typeAll("abcdef")
  s = applyKey(s, { type: "left" }, hints).state
  s = applyKey(s, { type: "left" }, hints).state
  s = applyKey(s, { type: "left" }, hints).state
  s = applyKey(s, { type: "char", ch: "X" }, hints).state
  expect(s.line).toBe("abcXdef")
  expect(s.cursor).toBe(4)
})

test("kursor: home/end", () => {
  let s = typeAll("dunia")
  s = applyKey(s, { type: "home" }, hints).state
  expect(s.cursor).toBe(0)
  s = typeAll("halo ", s)
  expect(s.line).toBe("halo dunia")
  expect(s.cursor).toBe(5)
  s = applyKey(s, { type: "end" }, hints).state
  expect(s.cursor).toBe(10)
})

test("kursor: backspace menghapus sebelum kursor, bukan di ujung", () => {
  let s = typeAll("abcd")
  s = applyKey(s, { type: "left" }, hints).state
  s = applyKey(s, { type: "backspace" }, hints).state
  expect(s.line).toBe("abd")
  expect(s.cursor).toBe(2)
})

test("kursor: backspace di posisi 0 = no-op", () => {
  let s = typeAll("abc")
  s = applyKey(s, { type: "home" }, hints).state
  const r = applyKey(s, { type: "backspace" }, hints)
  expect(r.action).toBe("none")
  expect(r.state.line).toBe("abc")
})

test("kursor: delete menghapus karakter DI kursor", () => {
  let s = typeAll("abc")
  s = applyKey(s, { type: "home" }, hints).state
  s = applyKey(s, { type: "delete" }, hints).state
  expect(s.line).toBe("bc")
  expect(s.cursor).toBe(0)
  s = applyKey(s, { type: "end" }, hints).state
  expect(applyKey(s, { type: "delete" }, hints).action).toBe("none")
})

test("kursor: emoji tidak terbelah oleh gerakan maupun hapus", () => {
  let s = typeAll("a\u{1F600}b")
  expect(s.cursor).toBe(3) // 3 code point, bukan 4 unit UTF-16
  s = applyKey(s, { type: "left" }, hints).state
  s = applyKey(s, { type: "backspace" }, hints).state
  expect(s.line).toBe("ab")
  const back = decodeKeys(new TextEncoder().encode(s.line))
  expect(back.length).toBe(2)
})

test("kursor: emoji disisipkan di tengah tetap utuh", () => {
  let s = typeAll("ab")
  s = applyKey(s, { type: "left" }, hints).state
  s = applyKey(s, { type: "char", ch: "\u{1F600}" }, hints).state
  expect(s.line).toBe("a\u{1F600}b")
  expect(s.cursor).toBe(2)
})

test("kursor: ctrl-w menghapus kata sebelum kursor, sisa kanan utuh", () => {
  let s = typeAll("satu dua tiga")
  for (let i = 0; i < 5; i++) s = applyKey(s, { type: "left" }, hints).state
  s = applyKey(s, { type: "ctrl-w" }, hints).state
  // Sejajar bash unix-word-rubout: kata dibuang, spasi pemisah kiri tetap.
  expect(s.line).toBe("satu  tiga")
  expect(s.cursor).toBe(5)
})

test("kursor: ctrl-u mengosongkan baris dan kursor", () => {
  let s = typeAll("teks panjang")
  s = applyKey(s, { type: "ctrl-u" }, hints).state
  expect(s.line).toBe("")
  expect(s.cursor).toBe(0)
  expect(s.menuOpen).toBe(false)
})

test("kursor: tab melengkapi lalu memindah kursor ke ujung", () => {
  let s = createState()
  s = applyKey(s, { type: "char", ch: "/" }, hints).state
  s = applyKey(s, { type: "char", ch: "m" }, hints).state
  // Tab kini putar mode via onKey, bukan melengkapi di engine.
  const tabbed = applyKey(s, { type: "tab" }, hints)
  expect(tabbed.state.line).toBe("/m")
  expect(tabbed.state.cursor).toBe("/m".length)
})

test("tab menghormati seleksi, bukan selalu item pertama", () => {
  let s = createState()
  s = applyKey(s, { type: "char", ch: "/" }, hints).state
  s = applyKey(s, { type: "char", ch: "m" }, hints).state
  s = applyKey(s, { type: "down" }, hints).state // sel=0 -> /models
  s = applyKey(s, { type: "down" }, hints).state // sel=1 -> /model
  // Tab kini putar mode, bukan melengkapi — baris tetap "/m".
  const r = applyKey(s, { type: "tab" }, hints)
  expect(r.state.line).toBe("/m")
})

test("decodeKey: home/end/delete dalam bentuk CSI dan VT", () => {
  const seqs: [string, PromptKey["type"]][] = [
    ["\x1b[H", "home"],
    ["\x1b[F", "end"],
    ["\x1b[1~", "home"],
    ["\x1b[7~", "home"],
    ["\x1b[4~", "end"],
    ["\x1b[8~", "end"],
    ["\x1b[3~", "delete"],
    ["\x1b[5~", "pageup"],
    ["\x1b[6~", "pagedown"],
    ["\x01", "home"],
    ["\x05", "end"],
  ]
  for (const [seq, type] of seqs) {
    const keys = decodeKeys(new TextEncoder().encode(seq))
    expect(keys.length).toBe(1)
    expect(keys[0]?.key.type).toBe(type)
  }
})

test("decodeKey: byte mouse dibuang, tidak jadi teks", () => {
  // X10: ESC [ M + 3 byte. Tanpa penanganan, "00" bocor sebagai karakter biasa.
  const x10 = decodeKeys(new TextEncoder().encode("\x1b[M\x20\x30\x30"))
  expect(x10.map((k) => k.key.type)).toEqual(["ignore"])

  const sgr = decodeKeys(new TextEncoder().encode("\x1b[<0;12;34M"))
  expect(sgr.map((k) => k.key.type)).toEqual(["ignore"])

  const mixed = decodeKeys(new TextEncoder().encode("ab\x1b[M\x20\x30\x30cd"))
  const chars = mixed.map((k) => (k.key.type === "char" ? k.key.ch : "")).join("")
  expect(chars).toBe("abcd")
})

test("applyKey: ignore tidak mengubah state", () => {
  const s = typeAll("teks")
  const r = applyKey(s, { type: "ignore" }, hints)
  expect(r.action).toBe("none")
  expect(r.state).toEqual(s)
})

test("applyKey: pageup/pagedown diabaikan engine (milik driver TUI)", () => {
  // Tanpa cabang ini applyKey me-return undefined → `r.state` melempar di
  // pemanggil. Linier: abaikan; TUI box mengintersepsi sebelum applyKey.
  const s = typeAll("teks")
  for (const t of ["pageup", "pagedown"] as const) {
    const r = applyKey(s, { type: t }, hints)
    expect(r.action).toBe("none")
    expect(r.state).toEqual(s)
  }
})

// ── Temuan bug-hunter UI: byte kontrol & newline dari paste ─────────────────

// Ctrl+L/K/T/Z dulu jatuh ke cabang "char" dan masuk baris input sebagai byte
// tak tampak — "teks" + tiga tombol itu mengirim "teks\f\u000b\u0014" ke model.
test("decodeKey: kontrol C0 tak dikenal dibuang, bukan jadi karakter", () => {
  const kontrol: [number, string][] = [
    [0x0c, "ctrl+l"],
    [0x0b, "ctrl+k"],
    // Ctrl+T di-decode sebagai tipe sendiri (toggle expand/minimize
    // reasoning di REPL) — tidak boleh jatuh ke "char" atau "ignore".
    [0x14, "ctrl+t"],
    [0x1a, "ctrl+z"],
    [0x02, "ctrl+b"],
    [0x06, "ctrl+f"],
    [0x10, "ctrl+p"],
  ]
  for (const [code, nama] of kontrol) {
    const keys = decodeKeys(new Uint8Array([code]))
    expect(keys.length, nama).toBe(1)
    expect(keys[0]?.key.type, nama).toBe(nama === "ctrl+t" ? "ctrl-t" : "ignore")
  }
})

test("decodeKey: Ctrl+N punya tipe sendiri (tambah model)", () => {
  const keys = decodeKeys(new Uint8Array([0x0e]))
  expect(keys.length).toBe(1)
  expect(keys[0]?.key.type).toBe("ctrl-n")
  // Jalur streaming (dipakai view sungguhan) harus sama — dulu 0x0e jatuh
  // ke "ignore" di asciiKey walau decodeKeys sudah benar.
  const streamed = decodeKeysStream(new Uint8Array([0x0e]), createDecoderState())
  expect(streamed.length).toBe(1)
  expect(streamed[0]?.key.type).toBe("ctrl-n")
  // Di prompt teks biasa ia no-op (tak masuk baris input).
  let s = typeAll("teks")
  s = applyKey(s, keys[0]!.key, hints).state
  expect(s.line).toBe("teks")
})

test("decodeKey: kontrol yang PUNYA arti tetap dipetakan", () => {
  const dikenal: [number, PromptKey["type"]][] = [
    [0x01, "home"],
    [0x03, "ctrl-c"],
    [0x04, "ctrl-d"],
    [0x05, "end"],
    [0x08, "backspace"],
    [0x09, "tab"],
    [0x0a, "ctrl-j"],
    [0x0d, "enter"],
    [0x0f, "ctrl-o"],
    [0x12, "ctrl-r"],
    [0x15, "ctrl-u"],
    [0x17, "ctrl-w"],
    [0x7f, "backspace"],
  ]
  for (const [code, type] of dikenal) {
    const keys = decodeKeys(new Uint8Array([code]))
    expect(keys[0]?.key.type, `0x${code.toString(16)}`).toBe(type)
  }
})

test("byte kontrol tidak sampai ke baris input", () => {
  let s = typeAll("teks")
  for (const code of [0x0c, 0x0b, 0x14]) {
    const key = decodeKeys(new Uint8Array([code]))[0]!.key
    s = applyKey(s, key, hints).state
  }
  expect(s.line).toBe("teks")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: memastikan tidak ada byte kontrol
  expect(/[\u0000-\u001f\u007f]/.test(s.line)).toBe(false)
})

// Baris input adalah SATU baris. Newline di dalamnya membuat renderer menulis
// lebih banyak baris daripada yang dihitung — frame melebihi tinggi terminal.
test("paste multi-baris: newline jadi spasi, bukan masuk apa adanya", () => {
  const s = applyKey(createState(), { type: "char", ch: "baris1\nbaris2\r\nbaris3" }, hints).state
  // Newline dipertahankan sebagai baris baru agar copas code utuh (keluhan
  // nyata: paste code dengan enter cuma baris pertama). Renderer multiline
  // sudah memperhitungkan tinggi terminal + footer.
  expect(s.line).toBe("baris1\nbaris2\nbaris3")
  expect(s.cursor).toBe(s.line.length)
})

test("paste dengan tab jadi spasi, byte kontrol lain dibuang", () => {
  const s = applyKey(createState(), { type: "char", ch: "a\tb\u0007c\u001bd" }, hints).state
  expect(s.line).toBe("a bcd")
})

test("paste yang isinya HANYA kontrol tidak mengubah state", () => {
  const before = typeAll("tetap")
  const r = applyKey(before, { type: "char", ch: "\u0000\u0007\u001f" }, hints)
  expect(r.action).toBe("none")
  expect(r.state.line).toBe("tetap")
})

test("paste multi-baris menyisip di posisi kursor", () => {
  let s = typeAll("ab")
  s = applyKey(s, { type: "left" }, hints).state
  s = applyKey(s, { type: "char", ch: "X\nY" }, hints).state
  expect(s.line).toBe("aX\nYb")
})

test("buildRenderSpec: cursorCol memperhitungkan lebar prompt", () => {
  let s = typeAll("abc")
  s = applyKey(s, { type: "left" }, hints).state
  const spec = buildRenderSpec(s, "> ", [])
  expect(spec.cursorCol).toBe(2 + 2)
})

// Kursor diukur dalam KOLOM terminal, bukan jumlah karakter: emoji dan CJK
// memakan dua kolom. Menghitung per code point membuat kursor terminal salah
// posisi begitu baris memuat karakter lebar.
test("buildRenderSpec: cursorCol untuk emoji dihitung per kolom (2)", () => {
  const s = typeAll("a\u{1F600}")
  const spec = buildRenderSpec(s, "> ", [])
  expect(spec.cursorCol).toBe(2 + 1 + 2) // prompt + "a" + emoji 2 kolom
})

test("buildRenderSpec: cursorCol untuk CJK dihitung per kolom", () => {
  const s = typeAll("字字")
  const spec = buildRenderSpec(s, "> ", [])
  expect(spec.cursorCol).toBe(2 + 4)
})

test("buildRenderSpec: sekuens ANSI pada prompt tidak menambah kolom", () => {
  const s = typeAll("abc")
  const plain = buildRenderSpec(s, "> ", [])
  const colored = buildRenderSpec(s, "\x1b[36m> \x1b[39m", [])
  expect(colored.cursorCol).toBe(plain.cursorCol)
})

test("backspace Thai: hapus per code point, bukan per suku kata", () => {
  // U+0E19 U+0E49 U+0E33 = satu grapheme, tiga code point (dibangun via
  // fromCharCode agar source tetap ASCII murni).
  const syllable = String.fromCharCode(0x0e19, 0x0e49, 0x0e33)
  expect(pointLength(syllable)).toBe(1)
  let s = createState()
  for (const ch of Array.from(syllable)) s = applyKey(s, { type: "char", ch }, hints).state
  expect(s.line).toBe(syllable)
  // Kode lama: satu backspace menelan seluruh suku kata (line === "").
  s = applyKey(s, { type: "backspace" }, hints).state
  expect(s.line).toBe(String.fromCharCode(0x0e19, 0x0e49))
  s = applyKey(s, { type: "backspace" }, hints).state
  expect(s.line).toBe(String.fromCharCode(0x0e19))
  s = applyKey(s, { type: "backspace" }, hints).state
  expect(s.line).toBe("")
})

test("backspace emoji VS16: tetap satu tekan", () => {
  // U+2764 U+FE0F = satu grapheme, tanpa diakritik Thai (terukur di runtime ini;
  // ZWJ family/flag dipecah ICU setempat jadi bukan contoh yang tepat).
  const heart = String.fromCharCode(0x2764, 0xfe0f)
  expect(pointLength(heart)).toBe(1)
  let s = createState()
  s = applyKey(s, { type: "char", ch: heart }, hints).state
  expect(s.line).toBe(heart)
  s = applyKey(s, { type: "backspace" }, hints).state
  expect(s.line).toBe("")
})
