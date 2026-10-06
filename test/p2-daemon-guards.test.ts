// P2.12 — guard kontrak daemon/Desktop (bagian §35).
//
// Beda dari test perilaku di p2-daemon.test.ts: file ini mengunci STRUKTUR dan
// ARAS KEPUTUSAN supaya refactor yang "kelihatan netral" tak diam-diam
// menggeser salah satu dari invariant beku P2.12. Setiap guard punya alasan
// tersendiri — bukan kebiasaan — dan bila guard ini merah, yang benar adalah
// mengubah kode, bukan menurunkan guard.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasScope } from "../src/daemon/capability.ts"
import {
  CONTROL_OPS,
  type DaemonScope,
  MAX_QUEUE_PER_CONN,
  requiredScope,
} from "../src/daemon/protocol.ts"
import { canTransition, readConsumerOffset, writeConsumerOffset } from "../src/daemon/store.ts"
import { BoundedQueue, Subscription } from "../src/daemon/subscription.ts"

const ROOT = process.cwd()

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8")
}

function daemonFiles(): string[] {
  return readdirSync(join(ROOT, "src/daemon"))
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => `src/daemon/${f}`)
}

function daemonSource(): string {
  return daemonFiles().map(read).join("\n")
}

/** Iris satu fungsi dari sumber — dipakai untuk menguji isi tubuhnya. */
function fnBody(src: string, marker: string): string {
  const at = src.indexOf(marker)
  expect(at).toBeGreaterThan(-1)
  const rest = src.slice(at)
  const end = rest.indexOf("\nexport function ")
  return end > 0 ? rest.slice(0, end) : rest
}

/**
 * Buang direktori sementara.
 *
 * Windows + bun:sqlite sering menyisakan EBUSY sesudah `Database.close()` —
 * handle-nya dilepas saat GC proses, bukan saat close. Itu perilaku runtime,
 * bukan hasil uji, jadi kegagalan bersih-bersih ditelan di sini saja (temp
 * tetap dibuang OS) supaya guard mengukur invariant, bukan jadwal GC.
 */
function discard(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  } catch {
    // Sengaja ditahan — lihat komentar di atas.
  }
}

describe("guard P2.12 — batas lapisan & pintu masuk", () => {
  test("daemon tak mengimpor cli/ atau src/ui/", () => {
    // `src/` non-ui dilarang menyentuh `src/ui/` (ui-boundary). Kalau daemon
    // boleh, satu-satunya pagar antarmuka manusia dan mesin runtuh — dan
    // renderer yang boleh berubah bebas ikut mengubah perilaku daemon.
    const hits: string[] = []
    for (const f of daemonFiles()) {
      const src = read(f)
      const re = /from\s+["']([^"']+)["']/g
      for (const m of src.matchAll(re)) {
        const spec = m[1]!
        if (spec.startsWith("../cli/") || spec.startsWith("../ui/") || spec.includes("src/ui/")) {
          hits.push(`${f} -> ${spec}`)
        }
      }
    }
    expect(hits).toEqual([])
  })

  test("tanpa console di src/daemon; keluaran host hanya lewat kanal warn", () => {
    // Console di lapisan daemon menulis tanpa bisa ditangkap pengendali, dan
    // tanpa inventaris writer. Satu kanal `warn` = satu titik audit.
    expect(daemonSource()).not.toMatch(/console\.(log|error|warn|info|debug)/)
    const host = read("src/daemon/host.ts")
    const direct = host.match(/process\.std(out|err)\.write/g) ?? []
    // Tepat SATU: nilai bawaan `warn`. Dua berarti ada tulis yang lolos audit.
    expect(direct.length).toBe(1)
  })

  test("telemetri tak pernah jadi dasar keputusan", () => {
    // Telemetri non-otoritatif (kontrak P2.11/P2.12). Membaca counter untuk
    // memutuskan = membuat angka observasi jadi wewenang.
    for (const f of ["src/daemon/control.ts", "src/daemon/approvals.ts", "src/daemon/store.ts"]) {
      const src = read(f)
      expect(src).not.toMatch(/telemetry\s*\.\s*get\s*\(/)
      expect(src).not.toMatch(/snapshot\s*\(\s*\)\s*\[/)
    }
  })

  test("sanitasi diterapkan di pintu masuk IPC & komposisi", () => {
    // Teks dari konsumen (dan nama sesi dari jaringan) tak terpercaya. Tanpa
    // sanitasi, satu label membawa ANSI/bel jadi baris terminal yang
    // dimanipulasi.
    expect(read("src/daemon/server.ts")).toMatch(/sanitizeLabel/)
    expect(read("src/daemon/control.ts")).toMatch(/sanitizeLabel/)
    expect(read("src/daemon/host.ts")).toMatch(/sanitizeLabel/)
    expect(read("cli/commands/daemon.ts")).toMatch(/sanitizeLabel/)
  })
})

describe("guard P2.12 — otoritas & identitas", () => {
  test("PID & lease bukan dasar keputusan penemuan", () => {
    // Recency ≠ liveness; PID bisa didaur ulang. Hanya probe koneksi yang
    // boleh menyatakan hidup, jadi `discover()` tak boleh memakai pid sama
    // sekali selain menyalinnya untuk diagnosis.
    const body = fnBody(read("src/daemon/discovery.ts"), "export function discover(")
    expect(body).not.toMatch(/lease\s*\.\s*pid/)
    expect(body).not.toMatch(/endpoint\s*\.\s*pid/)
    expect(body).not.toMatch(/process\s*\.\s*kill/)
    expect(body).not.toMatch(/existsSync\s*\([^)]*pid/)
  })

  test("tak ada kredensial penulis / bootstrap dalam kontrak IPC", () => {
    // Kontrak: "no writer token over IPC". `writer_epoch` adalah pagar angka
    // (bukan rahasia) dan wajar dikirim sebagai frontier; yang dilarang adalah
    // kredensial tahan-lama — bootstrap akar kepercayaan khusus berkas 0600
    // di dalam workspace, tak pernah menyeberangi soket.
    const proto = read("src/daemon/protocol.ts")
    for (const banned of ["bootstrap", "writerToken", "writer_token", "leaseToken", "secret"]) {
      expect(proto.toLowerCase()).not.toContain(banned.toLowerCase())
    }
    // `admin` tak mengandung cakupan lain secara diam-diam.
    const cap = (scopes: DaemonScope[]) =>
      ({ v: 1, inc: "inc", scopes, exp: Date.now() + 60_000, n: "n", who: "w" }) as never
    expect(hasScope(cap(["admin"]), "approve")).toBe(false)
    expect(hasScope(cap(["approve"]), "approve")).toBe(true)
    expect(hasScope(cap(["admin", "approve"]), "approve")).toBe(true)
  })

  test("setiap operasi kontrol punya cakupan minimum yang eksplisit", () => {
    // Sebelum aksi dijalankan, scope dicek lebih dulu — bukan di tengah ketika
    // sebagian efek sudah terjadi.
    expect(CONTROL_OPS.length).toBe(8)
    for (const op of CONTROL_OPS) {
      const scope = requiredScope(op)
      expect(["read:session", "control:session", "approve", "admin"]).toContain(scope)
    }
    expect(requiredScope("approval.decide")).toBe("approve")
    expect(requiredScope("daemon.shutdown")).toBe("admin")
  })

  test("mesin persetujuan: UNKNOWN terminal, keputusan tak bisa ditulis ulang", () => {
    // UNKNOWN berarti "tak pernah diketahui" — menjadikannya jalan kembali ke
    // accepted/denied menulis keputusan yang tak pernah dibuat siapa pun.
    expect(canTransition("UNKNOWN", "accepted")).toBe(false)
    expect(canTransition("UNKNOWN", "denied")).toBe(false)
    expect(canTransition("UNKNOWN", "expired")).toBe(false)
    expect(canTransition("denied", "accepted")).toBe(false)
    expect(canTransition("accepted", "denied")).toBe(false)
    expect(canTransition("pending", "UNKNOWN")).toBe(true)
    expect(canTransition("requested", "pending")).toBe(true)
  })

  test("kegagalan & kadaluarsa persetujuan = deny, bukan keheningan", () => {
    // Guard struktur: jalur yang tak punya bukti wajib menolak secara
    // eksplisit. Perilakunya diuji di p2-daemon.test.ts; di sini yang dikunci
    // adalah keberadaan kedua cabang itu sendiri.
    const src = read("src/daemon/approvals.ts")
    expect(src).toMatch(/approval record failed/)
    expect(src).toMatch(/return "deny"/)
    expect(src).toMatch(/#settle\(\s*approvalId,\s*"deny",\s*"expired"\s*\)/)
    // Gagal mencatat baris "pending" tak boleh dianggap berhasil diam-diam.
    expect(src).toMatch(/approval pending failed/)
  })
})

describe("guard P2.12 — data & antrean", () => {
  test("offset konsumen monoton naik (tak pernah mundur)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-p212-guard-"))
    try {
      expect(writeConsumerOffset("c", "s", 5, dir)).toBe(5)
      expect(writeConsumerOffset("c", "s", 9, dir)).toBe(9)
      expect(writeConsumerOffset("c", "s", 3, dir)).toBe(9)
      expect(readConsumerOffset("c", "s", dir)).toBe(9)
      expect(writeConsumerOffset("c", "s", -1, dir)).toBe(9)
    } finally {
      discard(dir)
    }
  })

  test("antrean per koneksi terbatas dan ack tak melompat di atas cursor", () => {
    // Tanpa batas, satu konsumen lambat mengubah daemon jadi penampung memori;
    // tanpa tolak-ack, progres bisa melompat melewati event yang belum diproses.
    expect(MAX_QUEUE_PER_CONN).toBeGreaterThan(0)
    const q = new BoundedQueue<number>(2)
    expect(q.push(1)).toBe(true)
    expect(q.push(2)).toBe(true)
    expect(q.full).toBe(true)
    expect(q.push(3)).toBe(false)

    const scratch = mkdtempSync(join(tmpdir(), "mc-p212-guard-q-"))
    try {
      const sub = new Subscription({ consumerId: "c", sid: "s", fromSeq: 1, cwd: scratch })
      sub.cursor = 4
      expect(sub.ack(4).ok).toBe(true)
      expect(sub.ack(5)).toEqual({ ok: false, reason: "OUT_OF_RANGE" })
      expect(sub.ack(-1)).toEqual({ ok: false, reason: "OUT_OF_RANGE" })
      expect(sub.cursor).toBe(4)
      expect(readConsumerOffset("c", "s", scratch)).toBe(4)
    } finally {
      discard(scratch)
    }
  })
})

describe("guard P2.12 — hidup-mati & peta", () => {
  test("urutan shutdown ketat dan lengkap", () => {
    // Urutan salah meninggalkan sisa yang mahal: persetujuan menggantung tanpa
    // jawab, lease basi yang menyamar jadi daemon hidup, anak yang diklaim
    // selesai padahal tak ada yang melapor.
    const src = read("src/daemon/host.ts")
    const order = [
      "mark-closing",
      "halt-consumers",
      "settle-approvals",
      "stop-monitors",
      "close-connections",
      "retire-children",
      "clear-discovery",
    ]
    let cursor = -1
    for (const step of order) {
      const at = src.indexOf(`#track("${step}")`)
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeGreaterThan(cursor)
      cursor = at
    }
    // Tipe urutannya sendiri harus sama panjang & sama urutan.
    const union = fnBody(src, "export type ShutdownStep =")
    for (const step of order) expect(union).toContain(`"${step}"`)
  })

  test("anak tak pernah diadopsi dari generasi lain", () => {
    const src = read("src/daemon/children.ts")
    expect(src).not.toMatch(/adopt\s*\(/)
    // Anak yang hilang pelapor = "lost" (tak bisa dikonfirmasi), bukan
    // "finished" (klaim atas hasil).
    expect(src).toContain('"lost"')
    expect(src).toMatch(/shutdown\(\)[\s\S]{0,600}status = "lost"/)
  })

  test("tak ada sistem event kedua & tanpa eksekusi-ulang otomatis", () => {
    // P2.12 membaca dari store yang sudah ada. Menulis tabel event sendiri =
    // dua kebenaran; menambah operasi kontrol yang mengeksekusi ulang = auto
    // re-execute, yang dilarang eksplisit oleh kontrak.
    const src = daemonSource()
    expect(src).not.toMatch(/INSERT\s+INTO\s+(presentation_events|messages|semantic_events)/i)
    // Membaca kosakata presentasi lewat `import type` sah (kontrak: presentasi
    // = observasi). Yang dilarang adalah mengimpor NILAINYA — di situ daemon
    // mulai punya state sendiri di luar store kanonik.
    const valueImports = src
      .split("\n")
      .filter(
        (line) => line.includes("../presentation/") && !line.trimStart().startsWith("import type"),
      )
    expect(valueImports).toEqual([])
    expect(CONTROL_OPS).not.toContain("run.execute" as never)
    expect(CONTROL_OPS).not.toContain("session.replay" as never)
    expect(CONTROL_OPS).not.toContain("run.resume" as never)
    expect(CONTROL_OPS).toHaveLength(8)
  })

  test("peta struktur hidup memuat semua modul daemon", () => {
    // AGENTS.md: struktur berubah → docs/ARCHITECTURE.html ikut berubah.
    const html = read("docs/ARCHITECTURE.html")
    const missing = daemonFiles().filter((f) => !html.includes(f.split("/").pop()!))
    expect(missing).toEqual([])
    expect(daemonFiles().length).toBeGreaterThanOrEqual(16)
  })

  test("vendor/minicore tak tersentuh", () => {
    const r = spawnSync("git", ["status", "--porcelain", "--", "vendor/"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe("")
  })
})
