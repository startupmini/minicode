// Anti-regresi I26: literal Indonesia hardcode di luar kamus i18n.
// Komentar Indonesia adalah konvensi repo (boleh) — yang dipindai HANYA isi
// string literal via lexer sadar-state (komentar/backtick/regex aman).
// Kontrol positif: id.ts WAJIB kena (scanner tidak buta); en.ts WAJIB bersih
// (tidak ada kebocoran Indonesia di kamus Inggris).
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Kata Indonesia TANPA kembaran Inggris (bentuk dasar + imbuhan eksplisit).
// SENGAJA tanpa: menu/mode/model/provider/status/lang/filter/error/data/
// info/label/value/title/minimal dan kawan yang identik di dua locale.
const WORDS = [
  "dan",
  "atau",
  "yang",
  "untuk",
  "dari",
  "pada",
  "adalah",
  "ialah",
  "ini",
  "itu",
  "dengan",
  "semua",
  "lain",
  "juga",
  "hanya",
  "sangat",
  "lebih",
  "kurang",
  "antara",
  "setiap",
  "saat",
  "lalu",
  "jika",
  "kalau",
  "oleh",
  "kepada",
  "dalam",
  "tidak",
  "tak",
  "bukan",
  "akan",
  "masih",
  "lagi",
  "belum",
  "sudah",
  "sedang",
  "telah",
  "pernah",
  "bisa",
  "harus",
  "jangan",
  "agar",
  "supaya",
  "karena",
  "tetapi",
  "tapi",
  "sementara",
  "langsung",
  "otomatis",
  "biasa",
  "mungkin",
  "pasti",
  "tentu",
  "benar",
  "salah",
  "saya",
  "kami",
  "kita",
  "anda",
  "kamu",
  "dia",
  "mereka",
  "apa",
  "siapa",
  "kapan",
  "dimana",
  "kemana",
  "mengapa",
  "kenapa",
  "bagaimana",
  "berapa",
  "mana",
  "apakah",
  "masuk",
  "keluar",
  "naik",
  "turun",
  "buka",
  "membuka",
  "dibuka",
  "terbuka",
  "tutup",
  "menutup",
  "ditutup",
  "baca",
  "membaca",
  "dibaca",
  "terbaca",
  "tulis",
  "menulis",
  "ditulis",
  "kirim",
  "mengirim",
  "dikirim",
  "jawab",
  "menjawab",
  "tanya",
  "bertanya",
  "lihat",
  "melihat",
  "dilihat",
  "cari",
  "mencari",
  "dicari",
  "tampil",
  "menampilkan",
  "ditampilkan",
  "sembunyi",
  "menyembunyikan",
  "disembunyikan",
  "pilih",
  "dipilih",
  "memilih",
  "saring",
  "menyaring",
  "disaring",
  "cocok",
  "mencocokkan",
  "ketik",
  "mengetik",
  "diketik",
  "tekan",
  "menekan",
  "ditekan",
  "tahan",
  "menahan",
  "ditahan",
  "simpan",
  "menyimpan",
  "disimpan",
  "tersimpan",
  "hapus",
  "menghapus",
  "dihapus",
  "hapuskan",
  "tambah",
  "menambah",
  "ditambah",
  "mengurangi",
  "dikurangi",
  "buat",
  "membuat",
  "dibuat",
  "pakai",
  "memakai",
  "dipakai",
  "ambil",
  "mengambil",
  "diambil",
  "coba",
  "mencoba",
  "dicoba",
  "kembali",
  "mulai",
  "memulai",
  "dimulai",
  "selesai",
  "menyelesaikan",
  "batal",
  "dibatalkan",
  "membatalkan",
  "batalkan",
  "lanjut",
  "lanjutkan",
  "melanjutkan",
  "dilanjutkan",
  "berhenti",
  "hentikan",
  "menghentikan",
  "dihentikan",
  "tunda",
  "menunda",
  "ditunda",
  "jalan",
  "berjalan",
  "jeda",
  "ulang",
  "ulangi",
  "mengulang",
  "diulang",
  "gagal",
  "wajib",
  "diisi",
  "butuh",
  "dibutuhkan",
  "diperlukan",
  "opsional",
  "izinkan",
  "mengizinkan",
  "diizinkan",
  "tolak",
  "menolak",
  "ditolak",
  "terima",
  "menerima",
  "diterima",
  "blokir",
  "memblokir",
  "diblokir",
  "cabut",
  "mencabut",
  "dicabut",
  "tetapkan",
  "menetapkan",
  "ditetapkan",
  "atur",
  "mengatur",
  "diatur",
  "konfigurasi",
  "mengonfigurasi",
  "dikonfigurasi",
  "sesuaikan",
  "menyesuaikan",
  "disesuaikan",
  "ubah",
  "mengubah",
  "diubah",
  "ganti",
  "mengganti",
  "diganti",
  "bagi",
  "membagi",
  "dibagi",
  "pecah",
  "memecah",
  "dipecah",
  "gabung",
  "menggabung",
  "digabung",
  "bergabung",
  "pisah",
  "memisah",
  "dipisah",
  "terpisah",
  "urut",
  "mengurutkan",
  "diurutkan",
  "salin",
  "menyalin",
  "disalin",
  "bersih",
  "bersihkan",
  "membersihkan",
  "dibersihkan",
  "jalankan",
  "menjalankan",
  "dijalankan",
  "eksekusi",
  "periksa",
  "memeriksa",
  "diperbarui",
  "memperbarui",
  "padatkan",
  "dipadatkan",
  "berpikir",
  "macet",
  "gantung",
  "menggantung",
  "hasil",
  "proses",
  "tugas",
  "langkah",
  "alat",
  "agen",
  "sesi",
  "giliran",
  "pengguna",
  "jaringan",
  "koneksi",
  "unduh",
  "mengunduh",
  "diunduh",
  "unggah",
  "mengunggah",
  "diunggah",
  "sumber",
  "tujuan",
  "layanan",
  "izin",
  "akses",
  "kredensial",
  "kunci",
  "sandi",
  "rahasia",
  "opsi",
  "pilihan",
  "pengaturan",
  "bahasa",
  "tema",
  "perintah",
  "argumen",
  "nilai",
  "kode",
  "alamat",
  "nomor",
  "tanggal",
  "masukan",
  "keluaran",
  "cara",
  "tahap",
  "tipe",
  "jenis",
  "kategori",
  "kelas",
  "bentuk",
  "kondisi",
  "keadaan",
  "posisi",
  "lokasi",
  "tempat",
  "arah",
  "ukuran",
  "panjang",
  "lebar",
  "tinggi",
  "fitur",
  "fungsi",
  "riwayat",
  "catatan",
  "dokumen",
  "versi",
  "contoh",
  "warna",
  "merah",
  "hijau",
  "biru",
  "kuning",
  "hitam",
  "putih",
  "ungu",
  "angka",
  "huruf",
  "teks",
  "berkas",
  "papan",
  "jendela",
  "layar",
  "tombol",
  "daftar",
  "mendaftar",
  "terdaftar",
  "isi",
  "berisi",
  "judul",
  "pesan",
  "bantuan",
  "nama",
  "batas",
  "membatasi",
  "dibatasi",
  "waktu",
  "maksimal",
  "kuota",
  "anggaran",
  "biaya",
  "tarif",
  "harga",
  "saldo",
  "habis",
  "penuh",
  "kosong",
  "utama",
  "dasar",
  "umum",
  "khusus",
  "tertentu",
  "acak",
  "keamanan",
  "pribadi",
  "galat",
  "kesalahan",
  "peringatan",
  "petunjuk",
  "panduan",
  "saran",
  "jumpa",
  "hari",
  "minggu",
  "bulan",
  "tahun",
  "jam",
  "menit",
  "detik",
]

const WORD_RE = new RegExp(`\\b(${WORDS.join("|")})\\b`, "i")

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) tsFiles(p, out)
    else if (e.name.endsWith(".ts")) out.push(p)
  }
  return out
}

interface Lit {
  text: string
  line: number
  tpl: boolean
}

/**
 * Lexer sadar-state: kumpulkan isi string literal beserta baris awal.
 * Menangani // dan block comment, escape, template ${} bersarang (stack),
 * dan comment di dalam ${}. Regex literal /.../ dilewati ala kadarnya
 * (cukup untuk pola tanpa quote di codebase ini).
 */
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "yield",
  "await",
  "throw",
  "case",
  "do",
  "else",
])

/** Karakter non-spasi sebelumnya + kata di depannya (untuk bedakan regex vs divisi). */
function prevSig(src: string, idx: number): { ch: string; word: string } {
  let j = idx - 1
  while (j >= 0 && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j--
  const ch = j >= 0 ? src[j]! : ""
  let word = ""
  if (ch && /[A-Za-z0-9_$]/.test(ch)) {
    let k = j
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k]!)) k--
    word = src.slice(k + 1, j + 1)
  }
  return { ch, word }
}

function looksLikeRegex(src: string, idx: number): boolean {
  const { ch, word } = prevSig(src, idx)
  if (ch === "") return true
  if ("([,=:!&|?{};+-*%^~<>".includes(ch)) return true
  if (word && REGEX_KEYWORDS.has(word)) return true
  return false
}

/** Konsumsi regex literal dari "/" pembuka; kembalikan indeks setelah flag. */
function consumeRegex(src: string, idx: number): number {
  let i = idx + 1
  let inClass = false
  while (i < src.length) {
    const c = src[i]!
    if (c === "\n") return idx + 1 // regex tak boleh multi-baris: anggap divisi
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "[") {
      inClass = true
      i++
      continue
    }
    if (c === "]") {
      inClass = false
      i++
      continue
    }
    if (c === "/" && !inClass) {
      i++
      while (i < src.length && /[a-z]/.test(src[i]!)) i++
      return i
    }
    i++
  }
  return i
}

/** Konsumsi block comment dari "/*" pembuka; kembalikan indeks setelah "*​/". */
function consumeBlock(src: string, idx: number): number {
  const end = src.indexOf("*/", idx + 2)
  return end < 0 ? src.length : end + 2
}

function lexLiterals(src: string): Lit[] {
  const clean = src
  const out: Lit[] = []
  const stack: Array<{ k: "str" | "tpl" | "expr"; q?: string; depth?: number }> = []
  let buf = ""
  let startLine = 1
  let line = 1
  let i = 0
  const top = () => stack[stack.length - 1]
  while (i < clean.length) {
    const ch = clean[i]!
    const nx = clean[i + 1] ?? ""
    if (ch === "\n") line++
    const t = top()
    if (!t) {
      // Kode normal.
      if (ch === "/" && nx === "/") {
        while (i < clean.length && clean[i] !== "\n") i++
        continue
      }
      if (ch === "/" && nx === "*") {
        const ni = consumeBlock(clean, i)
        line += clean.slice(i, ni).split("\n").length - 1
        i = ni
        continue
      }
      if (ch === "/") {
        i = looksLikeRegex(clean, i) ? consumeRegex(clean, i) : i + 1
        continue
      }
      if (ch === "'" || ch === '"') {
        stack.push({ k: "str", q: ch })
        buf = ""
        startLine = line
        i++
        continue
      }
      if (ch === "`") {
        stack.push({ k: "tpl" })
        buf = ""
        startLine = line
        i++
        continue
      }
      i++
      continue
    }
    if (t.k === "str") {
      if (ch === "\\") {
        buf += clean.slice(i, i + 2)
        i += 2
        continue
      }
      if (ch === t.q) {
        out.push({ text: buf, line: startLine, tpl: false })
        stack.pop()
        i++
        continue
      }
      buf += ch
      i++
      continue
    }
    if (t.k === "tpl") {
      if (ch === "\\") {
        buf += clean.slice(i, i + 2)
        i += 2
        continue
      }
      if (ch === "`") {
        out.push({ text: buf, line: startLine, tpl: true })
        stack.pop()
        i++
        continue
      }
      if (ch === "$" && nx === "{") {
        stack.push({ k: "expr", depth: 1 })
        buf += "${"
        i += 2
        continue
      }
      buf += ch
      i++
      continue
    }
    // t.k === "expr": kode di dalam ${...} (interpolasi bukan teks user).
    if (ch === "/" && nx === "/") {
      while (i < clean.length && clean[i] !== "\n") i++
      continue
    }
    if (ch === "/" && nx === "*") {
      const ni = consumeBlock(clean, i)
      line += clean.slice(i, ni).split("\n").length - 1
      i = ni
      continue
    }
    if (ch === "/") {
      i = looksLikeRegex(clean, i) ? consumeRegex(clean, i) : i + 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      // String/template bersarang: lex rekursif via stack.
      if (ch === "`") stack.push({ k: "tpl" })
      else stack.push({ k: "str", q: ch })
      const saved = buf
      buf = ""
      const savedLine = startLine
      startLine = line
      // Kumpulkan isi nested dengan loop mini (kedalaman 1 level cukup).
      i++
      let nested = ""
      const nq = ch
      let closed = false
      while (i < clean.length) {
        const c2 = clean[i]!
        if (c2 === "\n") line++
        if (c2 === "\\") {
          nested += clean.slice(i, i + 2)
          i += 2
          continue
        }
        if (c2 === nq) {
          closed = true
          break
        }
        nested += c2
        i++
      }
      stack.pop()
      if (closed) {
        out.push({ text: nested, line: startLine, tpl: nq === "`" })
        i++
      }
      buf = saved
      startLine = savedLine
      continue
    }
    if (ch === "{") {
      t.depth = (t.depth ?? 1) + 1
      i++
      continue
    }
    if (ch === "}") {
      t.depth = (t.depth ?? 1) - 1
      if ((t.depth ?? 0) <= 0) stack.pop()
      i++
      continue
    }
    i++
  }
  return out
}

/** Buang span ${...} bersarang dari isi template (identifier bukan teks). */
function stripInterp(s: string): string {
  let res = ""
  let i = 0
  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] === "{") {
      let d = 1
      i += 2
      while (i < s.length && d > 0) {
        if (s[i] === "{") d++
        else if (s[i] === "}") d--
        i++
      }
      continue
    }
    res += s[i]
    i++
  }
  return res
}

interface Hit {
  file: string
  line: number
  text: string
}

// Isi DOKUMEN (template AGENTS.md /init) — bukan string UI. Disengaja
// se-Indonesia AGENTS.md repo; daftar eksak agar tak menutupi regresi UI.
const DOC_ALLOW = new Set([
  "Petunjuk untuk agent yang bekerja di repo ini.",
  "(repo-map kosong)",
  "- Ikuti gaya kode existing.",
  "- Jalankan typecheck/test sebelum selesai.",
])

function scanFile(path: string): Hit[] {
  const src = readFileSync(path, "utf8")
  const hits: Hit[] = []
  for (const lit of lexLiterals(src)) {
    const body = lit.tpl ? stripInterp(lit.text) : lit.text
    if (DOC_ALLOW.has(body)) continue
    const hit = WORD_RE.exec(body)
    if (hit) hits.push({ file: path, line: lit.line, text: `${hit[1]} ← ${body.slice(0, 80)}` })
  }
  return hits
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

describe("i18n: tanpa literal Indonesia hardcode di luar kamus", () => {
  test("kontrol positif: id.ts WAJIB kena (scanner tidak buta)", () => {
    const hits = scanFile(join(ROOT, "src/ui/i18n/id.ts"))
    expect(hits.length).toBeGreaterThan(50)
  })

  test("kontrol negatif: en.ts WAJIB bersih (tanpa kebocoran Indonesia)", () => {
    const hits = scanFile(join(ROOT, "src/ui/i18n/en.ts"))
    expect(
      hits.map((h) => `${h.line} ${h.text}`),
      "kata Indonesia bocor di kamus en",
    ).toEqual([] as string[])
  })

  test("src/ui (kecuali i18n) + cli TUI bersih", () => {
    const files = [
      ...tsFiles(join(ROOT, "src/ui")).filter(
        (f) => !f.split("\\").join("/").includes("/ui/i18n/"),
      ),
      ...[
        "cli/tui.ts",
        "cli/commands.ts",
        "cli/model-manager.ts",
        "cli/provider-manager.ts",
        "cli/wizard.ts",
      ].map((f) => join(ROOT, f)),
    ]
    const hits = files.flatMap(scanFile)
    expect(
      hits.map((h) => `${h.file.split("minicode")[1]}:${h.line} ${h.text}`),
      "literal Indonesia di luar kamus",
    ).toEqual([] as string[])
  })
})
