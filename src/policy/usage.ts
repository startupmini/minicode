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

/**
 * [Fase 3 / LOOP-INV-11] Seed akumulasi pemakaian dari turn/run sebelumnya pada
 * sesi yang sama (mis. saat `--resume`), sehingga restart tidak me-reset budget
 * sesi kembali ke nol.
 */
export interface UsageInitialSnapshot {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalCostUsd?: number
  turnCount?: number
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
 * [Fase 3 / LOOP-INV-11] Error batas keras `maxTurns` lintas resume.
 * Memakai `AgentError("budget_exceeded", ...)` agar kernel frozen mempertahankan
 * `kind: "budget_exceeded"` melewati `abortError`, ditambah properti `code`
 * deterministik `"max_turns_exceeded"`.
 */
export function maxTurnsExceededError(
  maxTurns: number,
  turnCount?: number,
): AgentError & {
  readonly code: "max_turns_exceeded"
} {
  const err = new AgentError(
    "budget_exceeded",
    `max_turns_exceeded: turn count ${turnCount ?? maxTurns} reached limit ${maxTurns}`,
  )
  return Object.assign(err, { code: "max_turns_exceeded" as const })
}

export function turnBudgetStatus(
  maxTurns: number | undefined,
  turnCount: number,
): "ok" | "max-turns" {
  if (maxTurns == null || !Number.isFinite(maxTurns) || maxTurns < 1) return "ok"
  return turnCount >= Math.floor(maxTurns) ? "max-turns" : "ok"
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
  /** [Fase 3 / LOOP-INV-11] Batas keras jumlah turn lintas resume. */
  maxTurns?: number
  getCost: () => number | undefined
  /** Total token sesi (untuk fail-closed unknown-cost, F-06). Default 0. */
  getTokens?: () => number
  /** Jumlah turn sesi saat ini (termasuk carry-forward resume). */
  getTurns?: () => number
  onOver: (status: "over" | "unknown-strict" | "max-turns", cost: number | undefined) => void
}): () => void {
  const hasBudget = opts.budget != null
  const hasMaxTurns = opts.maxTurns != null && Number.isFinite(opts.maxTurns) && opts.maxTurns >= 1
  if (!hasBudget && !hasMaxTurns) return () => {}
  let fired = false
  const checkTurns = () => {
    if (fired || !hasMaxTurns) return
    const turns = opts.getTurns?.() ?? 0
    if (turnBudgetStatus(opts.maxTurns, turns) !== "ok") {
      fired = true
      opts.onOver("max-turns", opts.getCost())
    }
  }
  const check = () => {
    if (fired) return
    checkTurns()
    if (fired || !hasBudget) return
    const tokens = opts.getTokens?.() ?? 0
    const st = budgetStatus(opts.budget, opts.getCost(), opts.strict ?? false, tokens)
    if (st !== "ok") {
      fired = true
      opts.onOver(st, opts.getCost())
    }
  }
  const offExt = opts.bus.on("provider:extension", (e) => {
    if (e.kind === "usage" || e.kind === "effective-model") check()
  })
  const offTurn = hasMaxTurns
    ? opts.bus.on("turn:completed", () => {
        checkTurns()
      })
    : null
  checkTurns()
  // Investigasi Phase 5 (E-3c): instant check saat pasang TIDAK boleh
  // menggugurkan turn yang mulai dengan tokens==0 (belum ada pemakaian
  // tercatat) di strict-mode — itu lockout total setiap prompt pertama.
  // Gugur hanya bila sudah ada bukti belanja (tokens>0 + cost tak dikenal).
  const tokensAtStart = opts.getTokens?.() ?? 0
  if (!fired && hasBudget && tokensAtStart > 0) check()
  return () => {
    try {
      offExt()
    } catch {}
    try {
      offTurn?.()
    } catch {}
  }
}

export function watchContextWindowLimit(opts: {
  bus: EventBus
  /** Batas window konteks (W). Bila 0/undefined → no-op. */
  windowTokens: number
  /** Estimasi token INPUT (pesan) pada sesi; output allowance = max(256, W - input). */
  getInputTokens: () => number
  /** Token output turn berjalan (dari usage collector). */
  getOutputTokens: () => number
  onOver: (allowed: number, actual: number) => void
}): () => void {
  const W = opts.windowTokens
  if (!Number.isFinite(W) || W <= 0) return () => {}
  let fired = false
  const check = () => {
    if (fired) return
    const input = opts.getInputTokens()
    const allowedOutput = Math.max(256, Math.floor(W - input))
    const output = opts.getOutputTokens()
    if (output > allowedOutput) {
      fired = true
      opts.onOver(allowedOutput, output)
    }
  }
  const offExt = opts.bus.on("provider:extension", (e) => {
    if (e.kind === "usage") check()
  })
  check()
  return () => {
    try {
      offExt()
    } catch {}
  }
}

export function createUsageCollector(
  bus: EventBus,
  model?: string,
  initialSnapshot?: UsageInitialSnapshot,
) {
  const cleanNonNeg = (n: number | undefined): number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0
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
  // [Fase 3 / LOOP-INV-11] Seed dengan pemakaian sesi sebelumnya bila ada.
  const seedInput = cleanNonNeg(initialSnapshot?.inputTokens)
  const seedOutput = cleanNonNeg(initialSnapshot?.outputTokens)
  const seedTotal =
    initialSnapshot?.totalTokens !== undefined
      ? Math.max(seedInput + seedOutput, cleanNonNeg(initialSnapshot.totalTokens))
      : seedInput + seedOutput
  const session: Usage = {
    inputTokens: seedInput,
    outputTokens: seedOutput,
    totalTokens: seedTotal,
    cacheReadTokens: cleanNonNeg(initialSnapshot?.cacheReadTokens),
    cacheWriteTokens: cleanNonNeg(initialSnapshot?.cacheWriteTokens),
  }
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
  let sessionCost =
    typeof initialSnapshot?.totalCostUsd === "number" &&
    Number.isFinite(initialSnapshot.totalCostUsd) &&
    initialSnapshot.totalCostUsd >= 0
      ? initialSnapshot.totalCostUsd
      : 0
  let turnHasCost = false
  let sessionHasCost =
    typeof initialSnapshot?.totalCostUsd === "number" &&
    Number.isFinite(initialSnapshot.totalCostUsd) &&
    initialSnapshot.totalCostUsd >= 0
  let sessionTurns = Math.floor(cleanNonNeg(initialSnapshot?.turnCount))
  let lastProviderUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null =
    seedTotal > 0
      ? { inputTokens: seedInput, outputTokens: seedOutput, totalTokens: seedTotal }
      : null

  // [Fase 7 / Live #2] Batas-permintaan (request boundary) untuk akuntansi
  // token streaming. Provider OpenAI-compat mengirim objek `usage` pada
  // SETIAP chunk SSE yang membawa total kumulatif untuk permintaan itu
  // (satu panggilan model = satu "step" kernel = satu `provider.complete()`).
  // Sebelumnya `usage.ts` MENJUMLAHKAN (`+=`) setiap chunk → token inflasi
  // ekstrem (uji live: balasan 1 kata "OK" tercatat tokens=142530; padahal
  // token nyata ~50k).
  //
  // DESAIN (delta + overwrite): dalam SATU permintaan, snapshot usage tiap
  // chunk bersifat KUMULATIF (chunk k punya total utuh permintaan itu, bukan
  // tambahan per-chunk). Agar (a) nilai turn/session langsung terlihat oleh
  // watcher budget tanpa menunggu batas step, dan (b) chunk berturut-turut
  // TIDAK menjumlah, kita terapkan DELTA dari snapshot terakhir per-permintaan:
  //   - event usage PERTAMA untuk suatu permintaan: terapkan snapshot penuh
  //   - event usage BERIKUTNYA: terapkan selisih (snapshot_baru − snapshot_lama)
  // Total bersih = snapshot TERAKHIR (overwrite), bukan penjumlahan chunk.
  // Pada batas permintaan berikutnya (step:started/turn:started), baseline
  // di-reset ke snapshot terakhir (yang sudah penuh terlihat).
  let pendingRequestTokens: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number | undefined
    segModel: string | undefined
  } | null = null
  let requestBoundary = 0
  // totalTokens permintaan yang sedang berjalan. Digunakan untuk mendeteksi
  // MULAI permintaan BARU dalam satu step yang sama (mis. retry recovery
  // kernel): total kumulatif streaming hanya bertambah dalam satu permintaan,
  // jadi nilai yang MENURUN menandakan permintaan baru (bukan chunk lagi).
  let lastRequestTotal = 0

  // Terapkan snapshot ke turn+session. `prev` = snapshot permintaan yang sama
  // sebelumnya (null untuk event pertama) — bila ada, hanya SELISIH yang
  // diterapkan (delta), sehingga chunk kumulatif tidak menjumlah.
  const applyPending = (p: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number | undefined
    segModel: string | undefined
  }, prev: typeof p | null): void => {
    const dInput = prev ? p.inputTokens - prev.inputTokens : p.inputTokens
    const dOutput = prev ? p.outputTokens - prev.outputTokens : p.outputTokens
    const dTotal = prev ? p.totalTokens - prev.totalTokens : p.totalTokens
    const dRead = prev ? p.cacheReadTokens - prev.cacheReadTokens : p.cacheReadTokens
    const dWrite = prev ? p.cacheWriteTokens - prev.cacheWriteTokens : p.cacheWriteTokens
    turn.inputTokens += dInput
    turn.outputTokens += dOutput
    turn.totalTokens += dTotal
    turn.cacheReadTokens = (turn.cacheReadTokens ?? 0) + dRead
    turn.cacheWriteTokens = (turn.cacheWriteTokens ?? 0) + dWrite
    session.inputTokens += dInput
    session.outputTokens += dOutput
    session.totalTokens += dTotal
    session.cacheReadTokens = (session.cacheReadTokens ?? 0) + dRead
    session.cacheWriteTokens = (session.cacheWriteTokens ?? 0) + dWrite
    // Cost: hitung ulang dari snapshot TERAKHIR (delta cost = costBaru − costLama).
    // costFor dipanggil per snapshot di handler; di sini cukup tambahkan delta
    // cost bila keduanya terdefinisi. Untuk keandalan, kita simpan cost terakhir
    // dan terapkan delta terhadap prev.cost.
    const prevCost = prev?.cost
    if (prevCost !== undefined && p.cost !== undefined) {
      turnCost += p.cost - prevCost
      sessionCost += p.cost - prevCost
      turnHasCost = true
      sessionHasCost = true
    } else if (prevCost === undefined && p.cost !== undefined) {
      turnCost += p.cost
      sessionCost += p.cost
      turnHasCost = true
      sessionHasCost = true
    }
  }

  // Komit permintaan yang sedang berjalan (baseline tetap pada snapshot
  // terakhir yang sudah penuh terlihat — tidak ada tambahan lagi).
  const flushPendingRequest = (): void => {
    pendingRequestTokens = null
  }

  // Batas permintaan baru → komit snapshot lama, mulai baseline baru.
  const beginRequest = (): void => {
    flushPendingRequest()
    requestBoundary += 1
  }

  try {
    bus.on("turn:completed", () => {
      sessionTurns += 1
      // Selesaikan snapshot permintaan terakhir di turn ini.
      flushPendingRequest()
    })
  } catch {}

  try {
    bus.on("turn:started", () => {
      beginRequest()
    })
  } catch {}

  try {
    bus.on("step:started", () => {
      // Setiap step kernel = satu panggilan provider = satu batas permintaan.
      beginRequest()
    })
  } catch {}

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

      const reportedTotal =
        typeof d.totalTokens === "number" && Number.isFinite(d.totalTokens) && d.totalTokens >= 0
          ? Math.max(input + output, d.totalTokens)
          : input + output
      lastProviderUsage = { inputTokens: input, outputTokens: output, totalTokens: reportedTotal }

      // [Fase 7 / Live #2] JANGAN `+=` langsung ke turn+session per chunk SSE.
      // Simpan ke snapshot permintaan yang sedang berjalan dan terapkan DELTA
      // terhadap snapshot sebelumnya — chunk kumulatif berikutnya MENGGANTI
      // (overwrite) kontribusi, bukan menjumlah. Nilai turn/session langsung
      // terlihat oleh watcher budget (delta diterapkan seketika).
      //
      // Deteksi batas permintaan dalam step yang sama (recovery/retry kernel):
      // total kumulatif streaming hanya bertambah dalam satu permintaan, jadi
      // nilai yang menurun menandakan permintaan baru → komit snapshot lama dulu.
      if (pendingRequestTokens && reportedTotal < lastRequestTotal) {
        flushPendingRequest()
        requestBoundary += 1
      }
      lastRequestTotal = reportedTotal
      const segModel = effectiveModel ?? model
      const segCost = segModel ? costFor(segModel, input, output, cRead, cWrite, segCacheIncluded) : undefined
      const newSnapshot = {
        inputTokens: input,
        outputTokens: output,
        totalTokens: reportedTotal,
        cacheReadTokens: cRead,
        cacheWriteTokens: cWrite,
        cost: segCost,
        segModel,
      }
      applyPending(newSnapshot, pendingRequestTokens)
      pendingRequestTokens = newSnapshot
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
    /** [Fase 3 / LOOP-INV-11] Jumlah turn sesi (termasuk carry-forward resume). */
    getTurnCount: () => sessionTurns,
    /** [Fase 3 / CTX-03] Laporan token terakhir dari provider untuk kalibrasi. */
    lastProviderTokens: () => lastProviderUsage,
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
