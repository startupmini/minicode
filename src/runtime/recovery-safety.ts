// Recovery safety contract: SATU definisi kanonis predicate redispatch aman.
//
// Kenapa berkas ini ada (P1 M9→M12, §36): predicate awalnya diimplementasikan
// di supervisor.ts (konsumen mekanis). M12 membutuhkannya sebagai konsumen
// semantik. Dua copy = dua kebenaran yang dapat divergen — maka SATU modul
// netral ini memilikinya; supervisor mengimpor ulang (re-export compat).
// Isi dipindahkan VERBATIM dari supervisor.ts (tanpa perubahan semantik).

export interface RedispatchSafety {
  readonly authorityHeld: boolean
  readonly budgetRemaining: number | null
  readonly deadlineRemainingMs: number | null
  readonly effectDefinitelyNotStarted: boolean
  readonly idempotent: boolean
  readonly dedupeKeyPresent: boolean
  readonly dedupeCheckPass: boolean
  readonly verifierConfirmedNotExecuted: boolean
  readonly evidenceRecorded: boolean
}

/**
 * Predicate formal tunggal:
 * re_dispatch ⟺ authority && budget && deadline &&
 *   (not-started || (idempotent && key && check) || (verifier-confirm && evidence)).
 * Selain itu = NO automatic re-dispatch (UNKNOWN default aman).
 */
export function isRedispatchAllowed(safety: RedispatchSafety): boolean {
  if (!safety.authorityHeld) return false
  // [P1 Hygiene F2] Non-finite = invalid, bukan "available": `NaN <= 0` adalah
  // false (lolos diam-diam) dan +Infinity bukan bukti pagu. null tetap berarti
  // unbounded (kontrak yang sudah ada); <= 0 tetap berarti exhausted.
  if (
    safety.budgetRemaining !== null &&
    (!Number.isFinite(safety.budgetRemaining) || safety.budgetRemaining <= 0)
  )
    return false
  if (
    safety.deadlineRemainingMs !== null &&
    (!Number.isFinite(safety.deadlineRemainingMs) || safety.deadlineRemainingMs <= 0)
  )
    return false
  if (safety.effectDefinitelyNotStarted) return true
  if (hasDedupeProof(safety)) return true
  if (safety.verifierConfirmedNotExecuted && safety.evidenceRecorded) return true
  return false
}

/**
 * [P1 M16] Salah satu disjunct di atas, diekstrak karena M12 sering butuh penilaian yang sama dengan framing
 * TERBALIK ("belum ada bukti bahwa efek tidak terjadi?"). Tanpa helper ini, tiga
 * syarat itu ditulis ulang inline di M12 — salinan yang bisa melenceng diam-diam
 * dari predicate.
 */
export function hasDedupeProof(
  safety: Pick<RedispatchSafety, "idempotent" | "dedupeKeyPresent" | "dedupeCheckPass">,
): boolean {
  return safety.idempotent && safety.dedupeKeyPresent && safety.dedupeCheckPass
}
