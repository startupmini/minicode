// P13.1 — Ring buffer diagnostik runtime: TERBATAS + truncation TERLIHAT.
//
// Kenapa buffer, kenapa berbatas: runtime long-running menghasilkan banyak
// kejadian diagnostik, dan "simpan semua" = memori tak terbatas (kelas yang
// sudah dikejar di daemon: MAX_QUEUE_PER_CONN). Batas keras di sini: paling
// banyak 512 rekaman ATAU 1 MiB, mana yang tercapai lebih dulu.
//
// Kenapa truncation WAJIB observable: buffer yang diam-diam memotong history
// membuat konsumen menyimpulkan "tidak terjadi apa-apa" saat sebenarnya terjadi
// 10.000 kejadian yang hilang. Jadi jumlah rekaman yang dibuang ikut dilaporkan
// dan nomor urut rekaman tertua yang masih tersimpan ikut terlihat — celah
// history bisa dibaca, bukan sekadar perform.
//
// INI BUKAN antrean durable dan BUKAN task store: buffer in-memory untuk
// diagnosis, hilang saat proses mati — itu memang yang dimaksudkan. Tidak ada
// state baru yang bertahan lintas restart.

/** Batas jumlah rekaman (keputusan pemilik). */
export const MAX_DIAGNOSTIC_RECORDS = 512

/** Batas ukuran total (keputusan pemilik): 1 MiB, mana yang tercapai lebih dulu. */
export const MAX_DIAGNOSTIC_BYTES = 1024 * 1024

/** Satu rekaman diagnostik. */
export interface DiagnosticRecord {
  /** Nomor urut monoton dalam buffer (mulai dari 1). */
  readonly seq: number
  /** Waktu pencatatan (ms epoch, dari sumber jam yang disuntikkan). */
  readonly at: number
  /** Jenis kejadian (label pendek, tanpa data sensitif). */
  readonly kind: string
  /** Keterangan ringkas (tanpa rahasia). */
  readonly message: string
}

/** Potret buffer pada satu saat. */
export interface DiagnosticBufferSnapshot {
  /** Rekaman yang masih tersimpan, urut lama→baru. */
  readonly records: readonly DiagnosticRecord[]
  /** Berapa rekaman yang dibuang karena batas terlampaui. */
  readonly dropped: number
  /** True bila ada rekaman yang dibuang (truncation terlihat). */
  readonly truncated: boolean
  /** Perkiraan ukuran byte yang sedang disimpan. */
  readonly bytes: number
  /** Seq rekaman tertua yang masih tersimpan (1 = tak ada yang dibuang). */
  readonly sinceSeq: number
}

/** Antarmuka buffer diagnostik. */
export interface DiagnosticBuffer {
  /** Catat satu kejadian. Melebihi batas → rekaman tertua dibuang (dan dilaporkan). */
  record(kind: string, message?: string): void
  /** Potret saat ini (salinan — tak bisa dimutasi dari luar). */
  snapshot(): DiagnosticBufferSnapshot
  /** Kosongkan buffer (dan reset penanda truncation). */
  clear(): void
}

/** Perkiraan overhead per rekaman (kunci objek + penanda), agar hitungan byte realistis. */
const RECORD_OVERHEAD_BYTES = 64

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).length
}

export interface DiagnosticBufferOptions {
  /** Batas rekaman (default MAX_DIAGNOSTIC_RECORDS). */
  readonly maxRecords?: number
  /** Batas byte (default MAX_DIAGNOSTIC_BYTES). */
  readonly maxBytes?: number
  /** Sumber jam (default Date.now) — disuntik agar tes deterministik. */
  readonly now?: () => number
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  const n = Math.floor(value)
  return n > 0 ? n : fallback
}

/**
 * Buat buffer diagnostik berbatas.
 *
 * Pembuangan terjadi dari YANG LAMA (FIFO) sehingga history terbaru selalu
 * ada. Batas byte ditegakkan ketat: satu rekaman yang lebih besar dari batas
 * pun ikut dibuang (dan dihitung sebagai `dropped`) — memeliharanya berarti
 * melanggar batas memori yang justru dilindungi di sini.
 */
export function createDiagnosticBuffer(opts: DiagnosticBufferOptions = {}): DiagnosticBuffer {
  const maxRecords = positiveInt(opts.maxRecords, MAX_DIAGNOSTIC_RECORDS)
  const maxBytes = positiveInt(opts.maxBytes, MAX_DIAGNOSTIC_BYTES)
  const now = opts.now ?? Date.now

  const records: DiagnosticRecord[] = []
  let bytes = 0
  let dropped = 0
  let nextSeq = 1

  const sizeOf = (kind: string, message: string): number =>
    RECORD_OVERHEAD_BYTES + byteLength(kind) + byteLength(message)

  const evict = (): void => {
    while (records.length > 0 && (records.length > maxRecords || bytes > maxBytes)) {
      const oldest = records.shift()
      if (!oldest) break
      bytes -= sizeOf(oldest.kind, oldest.message)
      dropped += 1
    }
    if (bytes < 0) bytes = 0
  }

  return {
    record(kind: string, message = ""): void {
      const safeKind = typeof kind === "string" ? kind : ""
      const safeMessage = typeof message === "string" ? message : ""
      records.push({ seq: nextSeq, at: now(), kind: safeKind, message: safeMessage })
      nextSeq += 1
      bytes += sizeOf(safeKind, safeMessage)
      evict()
    },
    snapshot(): DiagnosticBufferSnapshot {
      const first = records[0]
      return {
        records: records.map((r) => ({ ...r })),
        dropped,
        truncated: dropped > 0,
        bytes,
        sinceSeq: first ? first.seq : nextSeq,
      }
    },
    clear(): void {
      records.length = 0
      bytes = 0
      dropped = 0
      nextSeq = 1
    },
  }
}
