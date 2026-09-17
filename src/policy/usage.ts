import { AgentError } from "#minicore/core/errors.ts"
import type { EventBus } from "#minicore/core/index.ts"
import { findPrice, loadPricingOverlay, type ModelPrice } from "./pricing.ts"

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
}

// Tabel harga pindah ke src/policy/pricing.ts: bawaan (offline) + overlay
// opsional dari models.dev yang HANYA ditarik lewat `minicode pricing sync`.
// Overlay dimuat sekali per proses; sebelum termuat, tabel bawaan tetap dipakai
// sehingga cost tak pernah mendadak jadi undefined.
let overlayLoaded = false
export function primePricing(): Promise<unknown> {
  if (overlayLoaded) return Promise.resolve()
  overlayLoaded = true
  return loadPricingOverlay().catch(() => ({}))
}

// cacheIncluded=true (Anthropic): input_tokens SUDAH termasuk cache_read+cache_write,
// jadi normal input = input - cacheRead - cacheWrite (hindari double-count).
// cacheIncluded=false (provider lain): input_tokens terpisah dari cache → jangan kurangi.
// Pencocokan harga per-segmen ada di findPrice() (kunci terpanjang menang,
// menolak false-positive seperti "my-gpt-4o-wrapper").
// Diekspor untuk test.
export function costFor(
  model: string,
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  cacheIncluded = true,
): number | undefined {
  const p: ModelPrice | undefined = findPrice(model)
  if (!p) return undefined
  // F-06: sanitasi segmen (defense-in-depth di atas toModelPrice): token
  // negatif/non-finite tak boleh menghasilkan biaya negatif.
  const clean = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)
  const normalInput = cacheIncluded ? Math.max(0, input - cacheRead - cacheWrite) : input
  const inputCost = (clean(normalInput) / 1_000_000) * p.input
  const readCost = p.cacheRead ? (clean(cacheRead) / 1_000_000) * p.cacheRead : 0
  const writeCost = p.cacheWrite ? (clean(cacheWrite) / 1_000_000) * p.cacheWrite : 0
  const outputCost = (clean(output) / 1_000_000) * p.output
  return inputCost + readCost + writeCost + outputCost
}

const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

// Harness-P1: keputusan budget terpusat agar one-shot/REPL/exec sepakat.
// F-06: cost tak dikenal (model tanpa harga) + ADA pemakaian (tokens > 0) =
// fail-closed ("unknown-strict") secara DEFAULT, bukan hanya di --budget-strict.
// Perilaku lama (fail-open) membuat --budget diam-diam mati total untuk setiap
// model baru di luar tabel harga. tokens == 0 (belum belanja apa pun, mis.
// pre-check prompt baru) tetap "ok" agar prompt pertama tidak ditolak.
// `strict` dipertahankan sebagai flag eksplisit (back-compat, perilaku sama).
export function budgetStatus(
  budget: number | undefined,
  cost: number | undefined,
  strict: boolean,
  tokens = 0,
): "ok" | "over" | "unknown-strict" {
  if (budget == null) return "ok"
  if (cost != null) return cost > budget ? "over" : "ok"
  if (tokens > 0) return "unknown-strict"
  return strict ? "unknown-strict" : "ok"
}

/**
 * Investigasi Phase 5 (probe E-3b/E-3c) — kontrak estimasi-vs-aktual untuk
 * cost tak dikenal, DIPISAH dari budgetStatus agar keputusan ok/over tetap
 * murni:
 *
 * - `tokens > 0` (ada pemakaian tercatat, harga tak dikenal) = **unknown**
 *   dengan bukti belanja → fail-closed (start ditolak).
 * - `tokens == 0` + cost unknown = dua kemungkinan tak terbedakan: (a) belum
 *   belanja apa pun (sah, pre-check prompt baru), atau (b) provider tak
 *   PERNAH mengirim usage event (telemetri hilang — F-27). strict-mode
 *   instant-check memperlakukannya over → lockout total setiap prompt
 *   pertama; itu lockout yang tidak diminta operator. Karena itu start dengan
 *   tokens==0 SELALU boleh — budget-mati-diam didokumentasikan sebagai gap
 *   F-27, bukan disembunyikan dengan lockout.
 */
export function budgetGateAllowsStart(
  budget: number | undefined,
  strict: boolean,
  tokens: number,
): boolean {
  if (budget == null) return true
  // tokens==0 → belum ada pemakaian tercatat: start SELALU boleh (pre-check
  // prompt baru; lockout strict tidak diminta operator).
  if (tokens === 0) return true
  // Ada pemakaian + cost tak dikenal → unknown-strict (fail-closed) = start
  // ditolak. Ada pemakaian + cost known → putuskan via budgetStatus (over =
  // ditolak).
  const st = budgetStatus(budget, undefined, strict, tokens)
  return st !== "unknown-strict"
}

/** Reason abort budget dengan identitas kind (F-18): kernel abortError
 * mempertahankan AgentError sehingga pemanggil bisa membedakan
 * budget_exceeded dari abort user/timeout. Dibuat di sini (src boleh impor
 * nilai #minicore) agar cli/ tak melanggar batas "hanya tipe" ke #minicore. */
export function budgetExceededError(): Error {
  return new AgentError("budget_exceeded", "budget exceeded")
}

/**
 * Pemutus budget MID-TURN (audit 2026-09-16 M3).
 *
 * Pre-check di driver (REPL/exec) hanya menolak prompt BARU, sehingga turn
 * panjang — tool loop puluhan step, siklus self-heal --verify — bisa belanja
 * tanpa batas dalam satu turn. Watcher ini membaca biaya LIVE (collector yang
 * sama diakumulasi per usage-event) dan memanggil onOver TEPAT SEKALI begitu
 * status bukan "ok". Driver memakai callback itu untuk menggugurkan turn
 * (abort signal) — tanpa ini `--budget` hanya memutus ANTAR prompt.
 *
 * Tanpa budget (undefined) = no-op total: tanpa subscribe, tanpa overhead,
 * perilaku nol-budget identik seperti sebelumnya. Cek langsung sekali saat
 * pasang agar siklus self-heal yang mulai dalam keadaan sudah-over langsung
 * gugur tanpa menunggu usage-event baru.
 */
export function watchBudgetLimit(opts: {
  bus: EventBus
  budget?: number
  strict?: boolean
  getCost: () => number | undefined
  /** Total token sesi (untuk fail-closed unknown-cost, F-06). Default 0. */
  getTokens?: () => number
  onOver: (status: "over" | "unknown-strict", cost: number | undefined) => void
}): () => void {
  if (opts.budget == null) return () => {}
  let fired = false
  const check = () => {
    if (fired) return
    const tokens = opts.getTokens?.() ?? 0
    const st = budgetStatus(opts.budget, opts.getCost(), opts.strict ?? false, tokens)
    if (st !== "ok") {
      fired = true
      opts.onOver(st, opts.getCost())
    }
  }
  const off = opts.bus.on("provider:extension", (e) => {
    if (e.kind === "usage" || e.kind === "effective-model") check()
  })
  // Investigasi Phase 5 (E-3c): instant check saat pasang TIDAK boleh
  // menggugurkan turn yang mulai dengan tokens==0 (belum ada pemakaian
  // tercatat) di strict-mode — itu lockout total setiap prompt pertama.
  // Gugur hanya bila sudah ada bukti belanja (tokens>0 + cost tak dikenal).
  const tokensAtStart = opts.getTokens?.() ?? 0
  if (tokensAtStart > 0) check()
  return () => {
    try {
      off()
    } catch {}
  }
}

export function createUsageCollector(bus: EventBus, model?: string) {
  // DUA akumulator, bukan satu.
  //
  // `turn` di-reset setiap kali pemanggil menyimpan hasil satu turn
  // (REPL memanggil reset() setelah persistCurrent). `session`
  // TIDAK pernah di-reset. Tanpa pemisahan ini, satu-satunya total yang ada
  // ikut terhapus setiap turn, sehingga total yang dilaporkan `/status`
  // (/cost = alias) selalu 0 setelah turn pertama selesai, header REPL kembali ke
  // $0.0000, dan `--budget` tidak akan pernah terpicu berapa pun yang dipakai.
  // Terlihat pada uji live: 51.915 token nyata dilaporkan sebagai 0 token.
  let turn: Usage = emptyUsage()
  // Tidak pernah di-assign ulang: field-nya yang diakumulasi. `turn` sebaliknya
  // diganti objek baru oleh reset() supaya pemanggil yang menyimpan hasil lama
  // tidak ikut ternol.
  const session: Usage = emptyUsage()
  // cacheIncluded bisa beda per provider (Anthropic true, OpenAI false).
  // Simpan per-event, akumulasi cost per segmen, bukan recompute dari total
  // dengan flag global yang terakhir.
  let cacheIncluded = true
  // Cost attribution: kalau router fallback menyubstitusi model, harga harus
  // dihitung pakai model EFEKTIF yang benar-benar dipakai.
  let effectiveModel: string | undefined
  let effectiveProvider: string | undefined
  // Model efektif terakhir yang dipakai dalam sesi — tetap dikenang setelah
  // reset() supaya biaya sesi tidak kehilangan basis harganya.
  let sessionModel: string | undefined
  // Akumulasi biaya per segmen (bukan recompute total dengan model terakhir)
  // untuk sesi multi-model: gpt-4o-mini → claude-opus tidak di-reprice 100×.
  let turnCost = 0
  let sessionCost = 0
  let turnHasCost = false
  let sessionHasCost = false

  bus.on("provider:extension", (e) => {
    if (e.kind === "effective-model") {
      const d = e.data as { requested?: string; effective?: string; provider?: string }
      effectiveModel = d.effective ?? effectiveModel
      effectiveProvider = d.provider ?? effectiveProvider
      sessionModel = effectiveModel ?? sessionModel
      return
    }
    if (e.kind === "usage") {
      const d = e.data as {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
        cacheReadTokens?: number
        cacheWriteTokens?: number
        cacheIncluded?: boolean
      }
      const input =
        Number.isFinite(d.inputTokens) && (d.inputTokens ?? 0) >= 0 ? (d.inputTokens ?? 0) : 0
      const output =
        Number.isFinite(d.outputTokens) && (d.outputTokens ?? 0) >= 0 ? (d.outputTokens ?? 0) : 0
      const cRead =
        Number.isFinite(d.cacheReadTokens) && (d.cacheReadTokens ?? 0) >= 0
          ? (d.cacheReadTokens ?? 0)
          : 0
      const cWrite =
        Number.isFinite(d.cacheWriteTokens) && (d.cacheWriteTokens ?? 0) >= 0
          ? (d.cacheWriteTokens ?? 0)
          : 0
      const segCacheIncluded =
        typeof d.cacheIncluded === "boolean" ? d.cacheIncluded : cacheIncluded
      if (typeof d.cacheIncluded === "boolean") cacheIncluded = d.cacheIncluded

      for (const acc of [turn, session]) {
        acc.inputTokens += input
        acc.outputTokens += output
        acc.totalTokens = acc.inputTokens + acc.outputTokens
        acc.cacheReadTokens = (acc.cacheReadTokens ?? 0) + cRead
        acc.cacheWriteTokens = (acc.cacheWriteTokens ?? 0) + cWrite
      }
      // Akumulasi biaya per segmen dengan model efektif saat itu
      const segModel = effectiveModel ?? model
      if (segModel) {
        const segCost = costFor(segModel, input, output, cRead, cWrite, segCacheIncluded)
        if (segCost !== undefined) {
          turnCost += segCost
          sessionCost += segCost
          turnHasCost = true
          sessionHasCost = true
        }
      }
    }
  })

  const withCost = (base: Usage, priceModel?: string): Usage => {
    // Akumulasi per-segmen akurat untuk multi-model; recompute hanya fallback
    // bila belum ada segmen (mis. test tanpa bus) atau untuk override eksplisit.
    if (base === turn && turnHasCost) return { ...base, cost: turnCost }
    if (base === session && sessionHasCost) return { ...base, cost: sessionCost }
    if (!priceModel) return { ...base }
    return {
      ...base,
      cost: costFor(
        priceModel,
        base.inputTokens,
        base.outputTokens,
        base.cacheReadTokens ?? 0,
        base.cacheWriteTokens ?? 0,
        cacheIncluded,
      ),
    }
  }

  return {
    /** Pemakaian turn saat ini (di-reset oleh reset()). */
    get: (m?: string) => withCost(turn, effectiveModel ?? m ?? model),
    /**
     * Pemakaian KUMULATIF seluruh sesi — dipakai `/status` (/cost = alias),
     * header REPL, dan pemeriksaan `--budget`. Tidak terpengaruh reset().
     */
    getSession: (m?: string) => withCost(session, m ?? effectiveModel ?? sessionModel ?? model),
    modelUsed: () => ({ effective: effectiveModel, provider: effectiveProvider }),
    reset: () => {
      turn = emptyUsage()
      turnCost = 0
      turnHasCost = false
      effectiveModel = undefined
      effectiveProvider = undefined
    },
  }
}
