// Koordinasi status-line vs output lain + arbitrase SEMUA penulis transient
// stderr (garis status turn & spinner wizard) terhadap penulis asing.
//
// Dua masalah yang diselesaikan:
// 1. Sebelum menulis baris biasa, status spinner di-suspend agar tidak
//    tertinggal fragmen \r di scrollback (mekanisme lama, tetap di bawah).
// 2. Penulis asing (non-UI: router/providers/tool warnings, dsb.) yang menulis
//    MENTAH ke stderr saat painter transient sedang melukis akan (a) menempel
//    di tengah baris transient lalu (b) terhapus oleh tick berikutnya — pesan
//    diagnostik HILANG. Arbitrase: saat ada owner transient aktif, tulis asing
//    dikomit sebagai baris permanen yang bersih (hapus garis transient →
//    tulis → repaint), jadi tidak ada pesan yang hilang dan tidak ada fragmen.
//
// Lapisan: modul ini hanya UI (src/ui). Penulis non-UI tidak bisa impor ke
// sini (batas dependensi), jadi mereka tidak diubah — justru MEKANISME di sini
// yang membuat tulis mentah mereka aman tanpa mereka sadari.

type PaintOwner = { kind: string; paintNow(): void }
let owner: PaintOwner | null = null
let ownerWriting = false
let bound: RawWrite | null = null
let ourWrite: ((chunk: string | Uint8Array, ...rest: never[]) => boolean) | null = null
/** Write asli sebelum wrapper dipasang — untuk restore saat self-disable. */
let origWrite: typeof process.stderr.write | null = null
const warnedOverlap = new Set<string>()

// Bun Windows (1.4.x): `stderr.write` yang dilepas dari method (bound/detached)
// melempar `TypeError: undefined is not an object (evaluating
// 'kWriteMonkeyPatchDefense')` dari internal writeFast — reproduksi nyata:
// setiap turn REPL di TTY Windows gagal di `paintWrite` padahal one-shot
// non-TTY hijau. Transient adalah best-effort (kontrak I4: scrollback tak
// bergantung painter), jadi begitu marker ini terlihat matikan painting
// permanen untuk proses ini agar turn TETAP jalan tanpa spinner.
let transientBroken = false

function isBunWriteBug(e: unknown): boolean {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "")
  return msg.includes("kWriteMonkeyPatchDefense") || msg.includes("kWrite")
}

/** Matikan transient permanen + kembalikan write asli. Tak pernah melempar. */
function disableTransient(): void {
  if (transientBroken) return
  transientBroken = true
  owner = null
  try {
    if (origWrite && (process.stderr.write as unknown) === ourWrite) {
      process.stderr.write = origWrite
    }
  } catch {}
  ourWrite = null
  bound = null
  origWrite = null
}

/** True bila painting sudah dimatikan paksa (runtime stderr rusak). */
export function isTransientDisabled(): boolean {
  return transientBroken
}

/** Reset state transient untuk test (pristine lagi). Jangan dipakai produksi. */
export function __resetTransientForTest(): void {
  try {
    if (ourWrite && (process.stderr.write as unknown) === ourWrite && origWrite) {
      process.stderr.write = origWrite
    }
  } catch {}
  owner = null
  ownerWriting = false
  bound = null
  ourWrite = null
  origWrite = null
  transientBroken = false
  warnedOverlap.clear()
  screenDepth = 0
}

// Pasang wrapper stderr HANYA bila owner transient pertama muncul. Wrapper
// inert (forward apa adanya) saat tidak ada owner — overhead nol untuk semua
// tulis biasa, dan identitas write yang di-patch harness test tetap dihormati
// (re-wrap bila property sudah diganti di antara dua acquire).
type RawWrite = (chunk: string | Uint8Array, ...rest: never[]) => boolean
function ensureWrap(): void {
  if (transientBroken) return
  const cur = process.stderr.write
  if (ourWrite && (cur as unknown) === ourWrite) return
  origWrite = process.stderr.write
  bound = process.stderr.write.bind(process.stderr) as RawWrite
  ourWrite = ((chunk: string | Uint8Array, ...rest: never[]) => {
    if (ownerWriting || !owner) {
      try {
        return bound!(chunk, ...rest)
      } catch (e) {
        // Runtime stderr rusak (bug Bun di atas): jangan gagalkan tulis
        // diagnostik — matikan transient lalu coba sekali via method-call.
        if (isBunWriteBug(e)) {
          disableTransient()
          try {
            return process.stderr.write(chunk, ...rest)
          } catch {
            return false
          }
        }
        throw e
      }
    }
    // Tulis ASING saat garis transient aktif: komit sebagai baris permanen.
    ownerWriting = true
    try {
      bound!("\r\x1b[2K")
    } finally {
      ownerWriting = false
    }
    let r: boolean
    try {
      r = bound!(chunk, ...rest)
    } catch (e) {
      if (isBunWriteBug(e)) {
        disableTransient()
        return false
      }
      throw e
    }
    try {
      owner?.paintNow()
    } catch {
      // Painter yang error tidak boleh menggagalkan tulis asing.
    }
    return r
  }) as unknown as typeof process.stderr.write
  process.stderr.write = ourWrite
}

// ── Kepemilikan layar interaktif (raw-mode) ──
// Picker/askLine/askSecret memegang raw mode DAN melukis overlay-nya di stdout
// dengan cursor addressing. Selama itu painter transient stderr (garis status
// turn, spinner setup) TIDAK boleh menulis satu byte pun: satu tick
// `\r\x1b[2K` dari stderr menghapus baris tempat layar baru menulis prompt —
// di Windows bahkan menghapus sebagian overlay. Tanpa aturan ini wizard setup
// pertama (picker gateway + prompt API key) tak terlihat, dan CLI tampak macet
// di `Menyiapkan sesi…` padahal sedang menunggu input user.
//
// Ditegakkan di SATU tempat (paintWrite) supaya SETIAP painter patuh tanpa
// harus tahu soal layar — termasuk painter baru di masa depan.
let screenDepth = 0

/**
 * Tandai layar raw-mode mengambil alih terminal. Kembalikan fungsi release
 * IDEMPOTEN — panggil di cleanup SEMUA jalur (sukses, batal, error, timeout).
 *
 * Nesting aman (depth dihitung): picker yang dibuka dari dalam manager hanya
 * melepas kepemilikannya sendiri saat selesai.
 */
export function beginInteractiveScreen(): () => void {
  // Baris painter terakhir dibersihkan SEKARANG (kursor masih persis di sana),
  // sebelum layar menulis byte pertamanya — dan SEBELUM depth naik, karena
  // paintWrite menolak menulis saat layar sudah aktif. Tanpa ini teks spinner
  // basi tertinggal tepat di atas overlay layar. Kursor juga dikembalikan:
  // painter menyembunyikannya selama melukis, sedangkan prompt butuh kursor
  // terlihat saat user mengetik.
  if (screenDepth === 0 && owner) {
    try {
      paintWrite("\r\x1b[2K\x1b[?25h")
    } catch {}
  }
  screenDepth++
  let released = false
  return () => {
    if (released) return
    released = true
    screenDepth = Math.max(0, screenDepth - 1)
  }
}

/** Tulis internal milik painter aktif (tanpa aturan "asing" di atas). */
export function paintWrite(s: string): void {
  if (transientBroken || screenDepth > 0) return
  ownerWriting = true
  try {
    // Pakai sink yang MASIH terpasang: bila wrapper sudah diganti/di-restore
    // (mis. antar test), painter zombie tidak boleh menulis ke buffer milik
    // sesi/harness lain.
    const cur = process.stderr.write
    try {
      if (ourWrite && (cur as unknown) === ourWrite && bound) bound(s)
      // JANGAN `cur(s)` detached: Bun Windows butuh `this` = stream
      // (writeFast baca `this[kWriteMonkeyPatchDefense]` → TypeError bila
      // detached). Selalu method-call.
      else process.stderr.write(s)
    } catch (e) {
      // Transient tak boleh menggagalkan turn: matikan bila runtime rusak,
      // telan bila error IO lain (spinner mati, agen tetap jalan).
      if (isBunWriteBug(e)) disableTransient()
    }
  } finally {
    ownerWriting = false
  }
}
export interface TransientPaint {
  kind: string
  release(): void
}

// Token per klaim: release hanya membatalkan klaim MILIKNYA. Tanpa token,
// klaim kedua ber-kind sama lalu release akan mencabut klaim pemilik pertama
// (owner global null padahal pemilik asli masih hidup).
let seq = 0
type Claim = PaintOwner & { token: number }

/**
 * Klaim kepemilikan transient stderr. Satu owner pada satu waktu; owner kedua
 * dengan kind berbeda TIDAK ditolak (fail-safe: rendering tetap jalan) tapi
 * dicatat sekali lewat paintWrite — invariant mutual exclusion turn-painter vs
 * wizard-spinner di-enforce sebagai signal, bukan crash produksi.
 */
export function acquireTransientPaint(kind: string, paintNow: () => void): TransientPaint {
  // Runtime stderr rusak (self-disable di atas): klaim jadi no-op agar
  // painter (turn-status/spinner) tetap "jalan" tanpa byte apa pun.
  if (transientBroken) return { kind, release() {} }
  ensureWrap()
  if (transientBroken) return { kind, release() {} }
  if (owner && owner.kind !== kind) {
    const key = `${owner.kind}->${kind}`
    if (!warnedOverlap.has(key)) {
      warnedOverlap.add(key)
      paintWrite(`[transient-paint] ${kind} starts while ${owner.kind} active (overlap)\n`)
    }
  }
  const claim: Claim = { kind, token: ++seq, paintNow }
  owner = claim
  return {
    kind,
    release() {
      if (owner === claim) owner = null
    },
  }
}

/** Sedang ada garis transient yang melukis? (dipakai guard/test) */
export function isTransientPainting(): boolean {
  return owner !== null
}

// ── Mekanisme lama: koordinasi suspend/resume status-line vs output UI ──
type StatusHandle = { suspend(): void; resume(): void }

let active: StatusHandle | null = null
let suspendDepth = 0

export function registerStatusLine(h: StatusHandle | null): void {
  active = h
  // Handle baru berarti lifecycle lama selesai — depth lama tidak relevan.
  suspendDepth = 0
}

export function runWithoutStatus<T>(fn: () => T): T {
  const handle = active
  if (!handle) return fn()

  // Waktu nested write terjadi, suspend/resume cukup sekali di level terluar
  // agar status line tidak flicker dan tidak melakukan repaint berulang.
  if (suspendDepth === 0) handle.suspend()
  suspendDepth++
  try {
    return fn()
  } finally {
    suspendDepth = Math.max(0, suspendDepth - 1)
    if (suspendDepth === 0 && active === handle) handle.resume()
  }
}
