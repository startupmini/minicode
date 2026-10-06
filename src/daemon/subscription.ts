// P2.12 — langganan konsumen: kursor + antrean TERBATAS.
//
// Kenapa antrean terbatas adalah keputusan keamanan, bukan detail: kontrak
// melarang daemon menahan memori tak terbatas atas nama konsumen yang lambat.
// Satu konsumen Desktop yang jeda (window minimized, suspend, lag) akan
// menumpuk delta stream — kalau antrean bebas, daemon OOM karena klien yang
// tak bisa dipegang. Batas + overflow eksplisit menjadikannya penolakan yang
// terlihat (QUEUE_OVERFLOW) alih-alih memori yang meledak.

import { MAX_QUEUE_PER_CONN } from "./protocol.ts"
import { readConsumerOffset, resetConsumerOffset, writeConsumerOffset } from "./store.ts"

export interface PendingEvent {
  seq: number
  provenance: "LIVE" | "REPLAY" | "RECONSTRUCTED" | "UNKNOWN"
  event: unknown
}

/**
 * Antrean berkapasitas tetap. push mengembalikan false saat penuh — pemanggil
 * yang memutuskan (kirim halte), bukan antrean yang membuang diam-diam.
 */
export class BoundedQueue<T> {
  #items: T[] = []
  readonly max: number

  constructor(max: number = MAX_QUEUE_PER_CONN) {
    this.max = Math.max(1, max)
  }

  push(item: T): boolean {
    if (this.#items.length >= this.max) return false
    this.#items.push(item)
    return true
  }

  /** Ambil semua isi (urut sisipan) dan kosongkan. */
  drain(): T[] {
    const out = this.#items
    this.#items = []
    return out
  }

  get size(): number {
    return this.#items.length
  }

  get full(): boolean {
    return this.#items.length >= this.max
  }
}

export interface SubscriptionInit {
  consumerId: string
  sid: string
  /** Seq pertama yang AKAN dikirim. Lebih besar dari head = tak ada yang dikirim. */
  fromSeq: number
  maxQueue?: number
  /**
   * Workspace pemilik offset. TANPA ini ack jatuh ke `process.cwd()` daemon —
   * padahal offset adalah milik SATU workspace; menulisnya ke tempat lain
   * membuat reconnect "berhasil" tapi melanjutkan dari nol.
   */
  cwd?: string
}

/**
 * Satu langganan (konsumen x sesi).
 *
 * cursor = seq TERAKHIR yang sudah DIKIRIM — bukan yang di-ack, bukan yang ada
 * di disk. Tiga angka itu sengaja terpisah: mencampurnya membuat klaim
 * "sudah terkirim" tak lagi bisa diverifikasi oleh pihak manapun.
 */
export class Subscription {
  readonly consumerId: string
  readonly sid: string
  readonly startSeq: number
  cursor: number
  /** true saat antrean pernah penuh — konsumen wajib reconnect + mulai ulang. */
  overflowed = false
  closed = false
  readonly queue: BoundedQueue<PendingEvent>
  readonly cwd: string | undefined

  constructor(init: SubscriptionInit) {
    this.consumerId = init.consumerId
    this.sid = init.sid
    this.startSeq = init.fromSeq
    this.cwd = init.cwd
    // Cursor awal = satu sebelum seq pertama yang akan dikirim.
    this.cursor = init.fromSeq - 1
    this.queue = new BoundedQueue<PendingEvent>(init.maxQueue ?? MAX_QUEUE_PER_CONN)
  }

  /** Antre event. false = overflow (pemanggil mengirim halte + memutus). */
  enqueue(p: PendingEvent): boolean {
    if (this.closed) return false
    if (!this.queue.push(p)) {
      this.overflowed = true
      return false
    }
    return true
  }

  drain(): PendingEvent[] {
    return this.queue.drain()
  }

  /**
   * Ambil SATU item terdepan tanpa mengorbankan sisanya.
   *
   * Ini penting: `drain()` mengosongkan seluruh antrean, sehingga bila tulisan
   * socket tertahan di tengah loop, sisa item ikut hilang — event yang sudah
   * "diproses" dari sisi daemon tapi tak pernah sampai. Dengan mengambil
   * satu-satu, hanya yang benar-benar terkirim yang dikeluarkan dari antrean.
   */
  takeFirst(): PendingEvent | undefined {
    const items = this.queue.drain()
    if (items.length === 0) return undefined
    const first = items[0]!
    for (let i = 1; i < items.length; i++) this.queue.push(items[i]!)
    return first
  }

  /**
   * Konsumen mengonfirmasi pemrosesan sampai seq.
   *
   * Menolak ack di atas cursor: konsumen tak bisa memproses sesuatu yang belum
   * pernah dikirim — ack begitu berarti kursor salah baca, dan mencatatnya
   * akan melompatkan offset ke depan sehingga event yang BELUM diproses
   * dianggap selesai selamanya. Itu kehilangan data yang tak bisa diperbaiki.
   */
  ack(
    seq: number,
  ): { ok: true; persisted: number } | { ok: false; reason: "OUT_OF_RANGE" | "CLOSED" } {
    if (this.closed) return { ok: false, reason: "CLOSED" }
    if (!Number.isInteger(seq) || seq < 0 || seq > this.cursor)
      return { ok: false, reason: "OUT_OF_RANGE" }
    const persisted = writeConsumerOffset(this.consumerId, this.sid, seq, this.cwd)
    return { ok: true, persisted }
  }

  close(): void {
    this.closed = true
    this.queue.drain()
  }
}

// Pemisah yang mustahil muncul di identitas manusiawi: dibangkitkan lewat
// charCode, bukan literal, supaya berkas ini tak pernah memuat byte kontrol
// mentah (yang merusak formatter dan tooling teks). Tanpa pemisah yang tak
// mungkin, consumerId "a b" + sid "c" menghasilkan kunci sama dengan
// consumerId "a" + sid "b c" — satu konsumen membaca sesi milik lain.
const KEY_SEP = String.fromCharCode(1)

export class SubscriptionRegistry {
  readonly #byKey = new Map<string, Subscription>()

  static key(consumerId: string, sid: string): string {
    return consumerId + KEY_SEP + sid
  }

  /**
   * Buat langganan. from:
   *  - "tail"   -> hanya event BARU (head+1), tanpa replay
   *  - "resume" -> lanjut dari offset ack terakhir; belum pernah = tail
   *  - angka    -> mulai dari sana (replay eksplisit; 0 = dari awal)
   *
   * Mengganti langganan lama untuk kunci yang sama: dua pump pada sesi yang
   * sama mengirim ganda dan membuat kursor saling melompat.
   */
  attach(
    init: SubscriptionInit & { from: number | "tail" | "resume"; head: number },
    resolveResume: (consumerId: string, sid: string) => number,
  ): { sub: Subscription; fromSeq: number } {
    const key = SubscriptionRegistry.key(init.consumerId, init.sid)
    this.#byKey.get(key)?.close()
    let fromSeq: number
    if (init.from === "tail") {
      fromSeq = init.head + 1
    } else if (init.from === "resume") {
      const offset = resolveResume(init.consumerId, init.sid)
      fromSeq = offset < 0 ? init.head + 1 : offset + 1
    } else {
      // Angka = permintaan replay eksplisit. `0` berarti "dari awal", bukan
      // "resume" — menggabungkan dua makna pada satu nilai membuat konsumen
      // yang minta replay penuh diam-diam mendapat potongan offset-nya sendiri.
      fromSeq = Number.isFinite(init.from) && init.from > 0 ? Math.floor(init.from) : 0
    }
    const sub = new Subscription({
      consumerId: init.consumerId,
      sid: init.sid,
      fromSeq,
      maxQueue: init.maxQueue,
      cwd: init.cwd,
    })
    this.#byKey.set(key, sub)
    return { sub, fromSeq }
  }

  get(consumerId: string, sid: string): Subscription | undefined {
    return this.#byKey.get(SubscriptionRegistry.key(consumerId, sid))
  }

  list(consumerId?: string): Subscription[] {
    const all = [...this.#byKey.values()]
    return consumerId ? all.filter((s) => s.consumerId === consumerId) : all
  }

  /** Tutup semua langganan milik satu konsumen (putusnya socket). */
  dropConsumer(consumerId: string): number {
    let n = 0
    for (const [k, s] of [...this.#byKey]) {
      if (s.consumerId === consumerId) {
        s.close()
        this.#byKey.delete(k)
        n++
      }
    }
    return n
  }

  drop(sid: string, consumerId: string): void {
    this.#byKey.delete(SubscriptionRegistry.key(consumerId, sid))
  }

  clear(): void {
    for (const s of this.#byKey.values()) s.close()
    this.#byKey.clear()
  }

  get size(): number {
    return this.#byKey.size
  }
}

/** Offset durable konsumen — TERPISAH dari cursor langganan. */
export function persistedOffset(consumerId: string, sid: string, cwd?: string): number {
  return readConsumerOffset(consumerId, sid, cwd)
}

export function resetOffset(consumerId: string, sid: string, cwd?: string): void {
  resetConsumerOffset(consumerId, sid, -1, cwd)
}
