// P2.12 — capability bercakupan untuk IPC loopback.
//
// Kenapa capability, bukan "PID + kepercayaan": kontrak melarang PID jadi
// otoritas (PID dapat didaur ulang/dipalsukan lintas sesi OS) dan melarang
// token penulis lewat IPC. Yang dibutuhkan konsumen hanya SATU hal: izin
// menjalankan kelas operasi tertentu selama masa berlaku tertentu — itu persis
// definisi capability.
//
// Tiga jaminan yang diuji:
//   1. Cakupan sempit dan eksplisit — tak ada "admin diam-diam".
//   2. Kedaluwarsa waktu nyata (TTL) — kebocoran tak abadi.
//   3. Terikat `incarnation` daemon — restart memutar secret → capability lama
//      mati → konsumen lama menerima STALE_INCARNATION, bukan akses senyap ke
//      daemon baru.
//
// Secret TIDAK PERNAH dikirim lewat IPC; hanya dipakai menandatangani.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { DAEMON_SCOPES, type DaemonScope } from "./protocol.ts"
import { sanitizeLabel } from "./sanitize.ts"

export interface CapabilityPayload {
  v: 1
  /** Incarnation daemon yang menandatangani. */
  inc: string
  /** Cakupan diberikan (subset terurut, unik). */
  scopes: DaemonScope[]
  /** Epoch millis kedaluwarsa. */
  exp: number
  /** Nonce acak — tiap mint unik. */
  n: string
  /** Nama konsumen (label, dibasuh) — diagnosis, bukan otoritas. */
  who: string
}

export type CapabilityFailure =
  | "MALFORMED"
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "STALE_INCARNATION"
  | "BAD_SCOPE"

export type CapabilityCheck =
  | { ok: true; payload: CapabilityPayload }
  | { ok: false; reason: CapabilityFailure }

function sign(secret: Buffer, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url")
}

// Serialisasi deterministik: urutan kunci tetap agar signature stabil lintas
// proses (JSON.stringify mengikuti urutan inisialisasi objek).
function canon(p: CapabilityPayload): string {
  return JSON.stringify({
    v: p.v,
    inc: p.inc,
    scopes: [...p.scopes].sort(),
    exp: p.exp,
    n: p.n,
    who: p.who,
  })
}

export function mintCapability(
  secret: Buffer,
  opts: { incarnation: string; scopes: DaemonScope[]; ttlMs: number; who: string; now?: number },
): string {
  const now = opts.now ?? Date.now()
  const scopes = [...new Set(opts.scopes)].filter((s) => DAEMON_SCOPES.includes(s)).sort()
  if (scopes.length === 0) throw new Error("mintCapability: minimal satu cakupan valid")
  const p: CapabilityPayload = {
    v: 1,
    inc: sanitizeLabel(opts.incarnation, 64),
    scopes,
    exp: now + Math.max(1_000, opts.ttlMs),
    n: randomBytes(9).toString("base64url"),
    who: sanitizeLabel(opts.who, 120),
  }
  const body = canon(p)
  return `${Buffer.from(body, "utf8").toString("base64url")}.${sign(secret, body)}`
}

export function verifyCapability(
  secret: Buffer,
  token: string,
  opts: { incarnation: string; now?: number },
): CapabilityCheck {
  if (typeof token !== "string" || token.length === 0 || token.length > 8192)
    return { ok: false, reason: "MALFORMED" }
  const dot = token.lastIndexOf(".")
  if (dot <= 0) return { ok: false, reason: "MALFORMED" }
  let body: string
  try {
    body = Buffer.from(token.slice(0, dot), "base64url").toString("utf8")
  } catch {
    return { ok: false, reason: "MALFORMED" }
  }
  const sig = Buffer.from(token.slice(dot + 1), "utf8")
  const expect = Buffer.from(sign(secret, body), "utf8")
  // timingSafeEqual menuntut panjang sama; beda panjang = sudah pasti gagal.
  if (sig.length !== expect.length || !timingSafeEqual(sig, expect))
    return { ok: false, reason: "BAD_SIGNATURE" }

  let payload: CapabilityPayload
  try {
    payload = JSON.parse(body) as CapabilityPayload
  } catch {
    return { ok: false, reason: "MALFORMED" }
  }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.scopes))
    return { ok: false, reason: "MALFORMED" }
  if (payload.inc !== opts.incarnation) return { ok: false, reason: "STALE_INCARNATION" }
  const now = opts.now ?? Date.now()
  if (typeof payload.exp !== "number" || payload.exp <= now) return { ok: false, reason: "EXPIRED" }
  if (!payload.scopes.every((s) => DAEMON_SCOPES.includes(s)))
    return { ok: false, reason: "BAD_SCOPE" }
  return { ok: true, payload }
}

export function hasScope(p: CapabilityPayload, need: DaemonScope): boolean {
  // `admin` TIDAK otomatis mengandung cakupan lain: cakupan diberikan eksplisit
  // agar "operator daemon" tak berubah diam-diam jadi "penyetuju persetujuan".
  return p.scopes.includes(need)
}

/**
 * Terbitkan capability dari berkas endpoint (dipakai klien/CLI di proses lain).
 *
 * `who` dan `scopes` selalu datang dari PEMANGGIL — tak ada default admin.
 * Kegagalan membaca berkas dilempar sebagai error: menghasilkan capability
 * kosong yang "sepertinya sah" akan menipu pemanggil sendiri.
 */
export function issueCapabilityFromEndpoint(
  ep: { bootstrap: string; incarnation: string },
  opts: { scopes: DaemonScope[]; who: string; ttlMs?: number; now?: number },
): string {
  const secret = Buffer.from(ep.bootstrap, "base64url")
  if (secret.length < 16) throw new Error("endpoint bootstrap tidak valid (terlalu pendek)")
  return mintCapability(secret, {
    incarnation: ep.incarnation,
    scopes: opts.scopes,
    ttlMs: opts.ttlMs ?? 10 * 60_000,
    who: opts.who,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
}
