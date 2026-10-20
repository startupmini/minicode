// WorkMode (S2.1) — lapis intent tipis di ATAS PermissionMode, bukan pengganti.
//
// Kenapa bukan sekadar projection mode: `PLAN × auto/ask` TIDAK boleh berubah
// menjadi `plan` polos, karena handler `plan` melewatkan gerbang approval
// `delegate_task` yang dimiliki `auto`/`ask` (owner decision S2.1). Jadi lapis
// ini memasang CEILING lebih dulu, lalu menyerahkan keputusan DI DALAM ceiling
// ke handler PermissionMode asli — allow/deny/prompt-nya utuh.
//
// Ceiling memakai handler `readonly`/`plan` yang sudah ada sebagai primitif:
// satu-satunya sumber daftar tool (18 nama read-only + 3 ekstra plan), tanpa
// menduplikasi READONLY_TOOLS atau membangun engine kedua.

import type { PermissionHandler, ToolCall } from "#minicore"
import { createPermissionHandler, type PermissionMode } from "./permission.ts"

export type WorkMode = "DISCUSS" | "PLAN" | "EXECUTE"

/** WorkMode yang memasang ceiling. EXECUTE = identitas (base dipakai apa adanya). */
export type RestrictiveWorkMode = Exclude<WorkMode, "EXECUTE">

type ModeControl = {
  __setMode(m: PermissionMode): void
  __getMode(): PermissionMode
}

export type WorkModePermissionHandler = PermissionHandler &
  ModeControl & {
    // P12 S2.2 Slice 5 — kontrol WorkMode runtime (setWorkMode/getWorkMode).
    // Mirip __setMode/__getMode milik PM: kernel mengkonsultasi handler per
    // tool call, jadi __setWorkMode menggeser ceiling tanpa meng-ganti handler.
    __setWorkMode(m: WorkMode): void
    __getWorkMode(): WorkMode
    // Sinkronis dengan kontrak PermissionHandler vendor (dapat sinkron ATAU
    // Promise): deskripsi deny diharapkan sinkron oleh semua handler produksi,
    // tetapi executor kernel meng-await hasilnya — mengetik hanya string akan
    // memicu TS2322 dan mengabaikan kemungkinan handler asinkron.
    describeDenial(call: ToolCall): Promise<string | undefined> | string | undefined
  }

function requireModeControl(base: PermissionHandler): ModeControl {
  const ctrl = base as Partial<ModeControl>
  if (typeof ctrl.__getMode !== "function" || typeof ctrl.__setMode !== "function") {
    // Fail-closed: tanpa kontrol mode, ceiling PLAN tak bisa mengikuti mode PM
    // saat runtime — lebih baik menolak konstruksi daripada memakai snapshot
    // basi yang bisa mencabut ceiling setelah `__setMode`.
    throw new Error(
      "createWorkModePermissionHandler: base handler wajib mengekspos __getMode/__setMode (fail-closed)",
    )
  }
  return ctrl as ModeControl
}

// Seleksi ceiling per mode PM SAAT INI (bukan snapshot konstruksi):
// DISCUSS selalu read-only; PLAN memakai ceiling read-only saat PM sudah lebih
// ketat (`allowlist`/`readonly`), selain itu ceiling plan.
function ceilingFor(
  workMode: RestrictiveWorkMode,
  baseMode: PermissionMode,
): "readonly" | "plan" {
  if (workMode === "DISCUSS") return "readonly"
  return baseMode === "allowlist" || baseMode === "readonly" ? "readonly" : "plan"
}

export function createWorkModePermissionHandler(opts: {
  workMode: WorkMode
  base: PermissionHandler
  root?: string
}): WorkModePermissionHandler {
  const ctrl = requireModeControl(opts.base)
  // P12 S2.2 Slice 5 — WorkMode MUTABLE (bukan snapshot konstruksi). Kernel
  // mengkonsultasi handler per tool call, jadi __setWorkMode runtime menggeser
  // ceiling tanpa mengganti handler. EXECUTE = delegasi base (perilaku identik).
  let wm: WorkMode = opts.workMode
  const ceilings = {
    readonly: createPermissionHandler({
      mode: "readonly",
      root: opts.root,
    }) as unknown as PermissionHandler,
    plan: createPermissionHandler({ mode: "plan", root: opts.root }) as unknown as PermissionHandler,
  }

  // Pemilik keputusan deny per-call, supaya `describeDenial` membaca seam
  // handler yang benar (ceiling vs base) dengan semantik hapus-saat-baca.
  const ownerById = new Map<string, PermissionHandler>()
  const ownerByRef = new WeakMap<object, PermissionHandler>()

  function rememberDeny(call: ToolCall, owner: PermissionHandler): void {
    try {
      const id = (call as { id?: unknown } | null)?.id
      if (typeof id === "string" && id) {
        if (ownerById.size > 500) ownerById.delete(ownerById.keys().next().value as string)
        ownerById.set(id, owner)
        return
      }
      if (call && typeof call === "object") ownerByRef.set(call as object, owner)
    } catch {}
  }

  function takeDenyOwner(call: ToolCall): PermissionHandler | undefined {
    try {
      const id = (call as { id?: unknown } | null)?.id
      if (typeof id === "string" && id) {
        const owner = ownerById.get(id)
        ownerById.delete(id)
        return owner
      }
      if (call && typeof call === "object") {
        const key = call as object
        const owner = ownerByRef.get(key)
        ownerByRef.delete(key)
        return owner
      }
    } catch {}
    return undefined
  }

  const handler = {
    async check(call: ToolCall, _deps?: unknown): Promise<"allow" | "deny"> {
      // EXECUTE = identitas: delegasi penuh ke base tanpa ceiling (perilaku
      // lama). Memungkinkan upgrade runtime EXECUTE→DISCUSS/PLAN walau komposisi
      // awal EXECUTE (compose mengembalikan base) TIDAK menyediakan __setWorkMode —
      // jalur ini dipakai createMinicodeSession yang SELALU membungkus.
      if (wm === "EXECUTE") return opts.base.check(call, _deps as never)
      // Baca mode PM sekarang: `__setMode` runtime menggeser seleksi ceiling
      // (PLAN × allowlist/readonly = read-only), bukan membekukan yang lama.
      // Baca WorkMode sekarang (`wm` mutable) — __setWorkMode runtime menggeser
      // ceiling DISCUSS↔PLAN.
      const ceiling = ceilings[ceilingFor(wm, ctrl.__getMode())]
      // Ceiling DULU: operasi di luar ceiling tak boleh memicu prompt base
      // (requirement S2.1 #1) — ceiling readonly/plan tak pernah prompt.
      const ceilingDecision = await ceiling.check(call, _deps as never)
      if (ceilingDecision !== "allow") {
        rememberDeny(call, ceiling)
        return "deny"
      }
      // Di dalam ceiling: keputusan mutlak handler PM asli (termasuk prompt
      // gated `delegate_task` untuk PLAN × auto/ask — owner decision S2.1).
      const decision = await opts.base.check(call, _deps as never)
      if (decision !== "allow") rememberDeny(call, opts.base)
      return decision
    },
    __setMode(m: PermissionMode): void {
      ctrl.__setMode(m)
    },
    __getMode(): PermissionMode {
      // Metadata yang dilaporkan tetap mode PM asli; WorkMode tidak bocor.
      return ctrl.__getMode()
    },
    __setWorkMode(m: WorkMode): void {
      wm = m
    },
    __getWorkMode(): WorkMode {
      return wm
    },
    describeDenial(call: ToolCall): Promise<string | undefined> | string | undefined {
      // EXECUTE: base mengambil keputusan langsung (check delegasi), jadi alasan
      // deny ada di base.describeDenial sendiri — bukan di owner map wrapper.
      if (wm === "EXECUTE") {
        const baseSeam = opts.base.describeDenial
        return typeof baseSeam === "function" ? baseSeam.call(opts.base, call) : undefined
      }
      const owner = takeDenyOwner(call)
      const seam = owner?.describeDenial
      return typeof seam === "function" ? seam.call(owner, call) : undefined
    },
  }
  return handler as WorkModePermissionHandler
}

/** Titik komposisi produksi: EXECUTE = base identitas, sisanya dibungkus ceiling. */
export function composeWorkModePermissionHandler(opts: {
  workMode: WorkMode
  base: PermissionHandler
  root?: string
}): PermissionHandler {
  if (opts.workMode === "EXECUTE") return opts.base
  return createWorkModePermissionHandler({
    workMode: opts.workMode,
    base: opts.base,
    root: opts.root,
  })
}
