// P2.12 — framing berpalang panjang untuk IPC loopback.
//
// Kenapa bukan newline-JSON: payload snapshot membawa riwayat presentasi yang
// boleh saja berisi `\n` di dalam string ter-escape maupun (bila salah escape)
// newline literal dari output model. Parser berbasis newline akan terpecah di
// tengah frame dan menyambung dua pesan jadi satu — klasik corruption yang
// berujung "event aneh" yang tak pernah bisa direproduksi. Palang 4 byte besar
// + ukuran eksplisit membuat pemisahan deterministik, dan batas `MAX_FRAME_BYTES`
// menutup jalur kehabisan memori dari peer yang mengirim header raksasa.

import { DAEMON_PROTOCOL, MAX_FRAME_BYTES } from "./protocol.ts"

/** Frame = [u32be length][utf8 json]. length = panjang payload, bukan total. */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8")
  if (body.length > MAX_FRAME_BYTES) {
    throw new FrameError("FRAME_TOO_LARGE", `frame ${body.length} > ${MAX_FRAME_BYTES}`)
  }
  const out = Buffer.allocUnsafe(4 + body.length)
  out.writeUInt32BE(body.length, 0)
  body.copy(out, 4)
  return out
}

export class FrameError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    // Kode ikut di pesan: pemanggil (dan pengujian) hanya punya teks error,
    // dan "apa yang ditolak" harus terbaca tanpa harus menyimpan referensi
    // ke instance pengecualian.
    super(`${code}: ${message}`)
    this.name = "FrameError"
    this.code = code
  }
}

/**
 * Dekoder streaming. Satu instance per koneksi; `push()` menerima chunk bebas
 * ukuran dan memuntahkan pesan utuh. Sengaja menyimpan sisa buffer MINIMAL
 * (hanya byte yang belum jadi frame) — antrean terkendali ada di lapisan
 * subscription, bukan di sini.
 */
export class FrameDecoder {
  #buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk])
    const out: unknown[] = []
    for (;;) {
      if (this.#buf.length < 4) break
      const len = this.#buf.readUInt32BE(0)
      if (len > MAX_FRAME_BYTES) {
        this.#buf = Buffer.alloc(0)
        throw new FrameError("FRAME_TOO_LARGE", `declared ${len} > ${MAX_FRAME_BYTES}`)
      }
      if (this.#buf.length < 4 + len) break
      const body = this.#buf.subarray(4, 4 + len)
      this.#buf = this.#buf.subarray(4 + len)
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString("utf8"))
      } catch {
        throw new FrameError("BAD_JSON", "frame payload bukan JSON valid")
      }
      out.push(parsed)
    }
    // Pertahankan memori sekecil mungkin: buffer kosong tidak boleh menahan
    // referensi ke chunk besar dari konsumen yang sudah diproses.
    if (this.#buf.length === 0) this.#buf = Buffer.alloc(0)
    return out
  }

  get pendingBytes(): number {
    return this.#buf.length
  }
}

/** Validasi kasar pesan masuk sebelum disentuh dispatcher. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function assertProtocol(hello: unknown): number {
  if (!isRecord(hello) || typeof hello.protocol !== "number") {
    throw new FrameError("PROTOCOL_ERROR", "hello.protocol wajib number")
  }
  if (hello.protocol !== DAEMON_PROTOCOL) {
    throw new FrameError(
      "PROTOCOL_ERROR",
      `protocol ${hello.protocol} != ${DAEMON_PROTOCOL} (daemon menolak konsumen versi lain)`,
    )
  }
  return hello.protocol
}
