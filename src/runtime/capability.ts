// M6 — Capability split: request ≠ grant; decision ≠ delivery.
//
// Kenapa berkas ini ada (P1 ADR-007): repo memiliki authorization (permission
// handler allow/deny/ask), enforcement (jail/guard/scrub/sandbox), dan klasifikasi
// tool (autonomous matrix) — tetapi tak ada representasi eksplisit yang membedakan
// "boleh diminta" dari "apa yang diberikan", sehingga subset child⊆parent dan
// approval-narrowness tak dapat dibuktikan. Modul ini adalah representasi +
// proof engine, BUKAN rewrite policy.
//
// BUKAN: Execution FSM (M8), supervisor (M9), recovery (M12), scheduler bridge
// (M13), persistence redesign, capability enforcement (tetap jail/guard/scrub/
// sandbox/M5-backend), production wiring (itu M7/M14). Aturan yang dikunci:
// - childGrant ⊆ parentGrant SELALU (proof, bukan konvensi). Eskalasi = deny.
// - Grant immutable (frozen) + bound ke executionId + ownerId (bukan token:
//   executionId/ownerId = identifier, BUKAN authority/secret).
// - Approval sempit-by-construction: tanpa tool+operation+execution binding,
//   approval tak mencakup apa pun (blanket "approve bash" = tak berdaya).
// - Perbandingan scope LEKSIKAL murni (tanpa FS): symlink/TOCTOU enforcement
//   tetap milik jail.ts/safe-open (M6 comparison ≠ enforcement).
// - Secret heuristic di sini LEKSIKAL (cermin scrub.ts); penyamaran tetap
//   milik scrub. Env bukan sumber authority.
// - Tak ada import policy/scheduler/persistence/backend — modul murni agar
//   dapat diuji tanpa infra dan tak menyeret domain.

import { randomUUID } from "node:crypto"

/** Operasi capability. Rank: read < write < execute < admin; network = dimensi sendiri. */
export type CapabilityOperation = "read" | "write" | "execute" | "network" | "admin"

const OP_RANK: Record<Exclude<CapabilityOperation, "network">, number> = {
  read: 1,
  write: 2,
  execute: 3,
  admin: 4,
}

export interface FsScope {
  readonly kind: "fs"
  /** Scope path (workspace-absolut ternormalisasi leksikal; lihat normalizeScopePath). */
  readonly path: string
}
export interface NetScope {
  readonly kind: "net"
  /** Host yang diizinkan. Absent = unrestricted (hanya valid bila parent unrestricted). */
  readonly hosts?: readonly string[]
}
export interface EnvScope {
  readonly kind: "env"
  /** Nama variabel eksplisit. Kosong = tanpa akses env. */
  readonly names: readonly string[]
}
export interface ProcScope {
  readonly kind: "proc"
  /** Hanya proses anak sendiri. Nilai lain = masa depan, kini ditolak. */
  readonly scope: "own"
}
export type CapabilityResource = FsScope | NetScope | EnvScope | ProcScope

export interface Capability {
  readonly operation: CapabilityOperation
  readonly resource: CapabilityResource
  /** Tag constraint monotonik (mis. "sandbox:docker", "net:denied"): child ∩ ⊇ parent. */
  readonly constraints?: readonly string[]
}

/** "Butuh X" — klaim kebutuhan, bukan pemberian. */
export interface CapabilityRequest {
  readonly tool: string
  readonly operation: CapabilityOperation
  readonly resource: CapabilityResource
  readonly executionId: string
  readonly ownerId: string
}

export type AuthorizationOutcome = "allow" | "deny" | "ask"

export interface AuthorizationDecision {
  readonly outcome: AuthorizationOutcome
  readonly reason: string
}

/** Provenance grant — traceable tanpa secret/prompt (auditability M6). */
export interface GrantProvenance {
  readonly requestedBy: string
  readonly authorizedBy: string
  readonly derivedFrom?: string
  readonly reason: string
}

export interface CapabilityGrant {
  /** Trace id (`cg_*`, namespace sendiri — BUKAN executionId, BUKAN secret). */
  readonly id: string
  readonly executionId: string
  readonly ownerId: string
  readonly capabilities: readonly Capability[]
  readonly provenance: GrantProvenance
}

/** Approval sempit: tanpa binding tool+operation+execution = tak mencakup apa pun. */
export interface ApprovalScope {
  readonly id: string
  readonly tool: string
  readonly operation?: CapabilityOperation
  readonly pathScope?: string
  readonly executionId: string
  readonly nonce: string
}

// ── Normalisasi path leksikal (TANPA FS — enforcement milik jail/safe-open) ──

/**
 * Normalisasi scope path: separator → `/`, collapse `.`/`..` leksikal,
 * trailing slash dibuang, win32 case-insensitive (lowercase).
 * Menolak NUL. TIDAK me-resolve symlink (itu jail); scope `..` yang lolos
 * di atas root leksikal dipertahankan apa adanya agar containment menolaknya.
 */
export function normalizeScopePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) throw new Error("capability: empty path")
  if (path.includes("\0")) throw new Error("capability: NUL byte in path")
  const isWin = process.platform === "win32"
  let p = path.replace(/\\/g, "/")
  const parts: string[] = []
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop()
      else parts.push("..")
      continue
    }
    parts.push(seg)
  }
  p = (path.startsWith("/") ? "/" : "") + parts.join("/")
  if (p === "") p = "."
  return isWin ? p.toLowerCase() : p
}

/** True bila childPath di dalam/di parentPath (bentuk ternormalisasi). */
export function isPathWithin(parentPath: string, childPath: string): boolean {
  const parent = normalizeScopePath(parentPath)
  const child = normalizeScopePath(childPath)
  if (child === parent) return true
  if (parent === ".") return !child.startsWith("..")
  return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`)
}

// ── Perbandingan kapabilitas (proof child ⊆ parent) ──

function operationCovers(parentOp: CapabilityOperation, childOp: CapabilityOperation): boolean {
  // Dimensi network: child "network" butuh parent "network" persis; parent
  // "network" mencakup child "read" (fetch = network read), bukan write/execute.
  if (childOp === "network") return parentOp === "network"
  if (parentOp === "network") return childOp === "read"
  return OP_RANK[childOp] <= OP_RANK[parentOp]
}

function resourceCovers(parent: CapabilityResource, child: CapabilityResource): boolean {
  if (parent.kind !== child.kind) return false
  switch (parent.kind) {
    case "fs":
      return isPathWithin(parent.path, (child as FsScope).path)
    case "net": {
      const childHosts = (child as NetScope).hosts
      // Parent unrestricted (hosts absent) mencakup semua; child unrestricted
      // hanya bila parent unrestricted. Daftar eksplisit harus subset.
      if (parent.hosts === undefined) return true
      if (childHosts === undefined) return false
      return childHosts.every((h) => (parent.hosts as readonly string[]).includes(h))
    }
    case "env": {
      const childNames = (child as EnvScope).names
      return childNames.every((n) => (parent as EnvScope).names.includes(n))
    }
    case "proc":
      return (child as ProcScope).scope === (parent as ProcScope).scope
  }
}

function constraintsCover(
  parent: readonly string[] | undefined,
  child: readonly string[] | undefined,
): boolean {
  const p = parent ?? []
  const c = new Set(child ?? [])
  return p.every((t) => c.has(t))
}

/** True bila setiap kapabilitas child dicover ≥1 kapabilitas parent. */
export function isCapabilitySubset(child: Capability, parent: Capability): boolean {
  return (
    operationCovers(parent.operation, child.operation) &&
    resourceCovers(parent.resource, child.resource) &&
    constraintsCover(parent.constraints, child.constraints)
  )
}

/** True bila setiap kapabilitas grant-child dicover grant-parent. */
export function isGrantSubset(child: CapabilityGrant, parent: CapabilityGrant): boolean {
  if (child.ownerId !== parent.ownerId) return false
  return child.capabilities.every((c) => parent.capabilities.some((p) => isCapabilitySubset(c, p)))
}

// ── Secret heuristic leksikal (cermin scrub.ts; enforcement milik scrub) ──

const SECRET_NAME_RE =
  /(?:API[_-]?KEYS?|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH|BEARER)/i

export function isSecretName(name: unknown): boolean {
  return typeof name === "string" && SECRET_NAME_RE.test(name)
}

// ── Konstruksi grant (frozen; validasi bentuk) ──

function freezeGrant(g: CapabilityGrant): CapabilityGrant {
  return Object.freeze({
    ...g,
    capabilities: Object.freeze([...g.capabilities]),
    provenance: Object.freeze({ ...g.provenance }),
  })
}

function assertCapability(cap: Capability): void {
  if (!cap || typeof cap.operation !== "string") throw new Error("capability: invalid operation")
  const res = cap.resource as CapabilityResource | undefined
  if (!res || typeof res.kind !== "string") throw new Error("capability: invalid resource")
  if (res.kind === "fs") {
    normalizeScopePath((res as FsScope).path)
  } else if (res.kind === "net") {
    for (const h of (res as NetScope).hosts ?? []) {
      if (typeof h !== "string" || h.length === 0) throw new Error("capability: invalid net host")
    }
  } else if (res.kind === "env") {
    for (const n of (res as EnvScope).names) {
      if (typeof n !== "string" || n.length === 0) throw new Error("capability: invalid env name")
    }
  } else if (res.kind === "proc") {
    if ((res as ProcScope).scope !== "own") throw new Error("capability: proc scope must be 'own'")
  } else {
    throw new Error("capability: unknown resource kind")
  }
}

export function createGrant(input: {
  executionId: string
  ownerId: string
  capabilities: readonly Capability[]
  provenance: GrantProvenance
}): CapabilityGrant {
  if (!input.executionId || !input.ownerId)
    throw new Error("capability: grant needs executionId + ownerId")
  if (
    !input.provenance?.requestedBy ||
    !input.provenance?.authorizedBy ||
    !input.provenance?.reason
  )
    throw new Error("capability: grant needs provenance (requestedBy/authorizedBy/reason)")
  for (const cap of input.capabilities) assertCapability(cap)
  return freezeGrant({
    id: `cg_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    executionId: input.executionId,
    ownerId: input.ownerId,
    capabilities: [...input.capabilities],
    provenance: { ...input.provenance },
  })
}

// ── Approval narrowness (sempit-by-construction) ──

/**
 * Approval mencakup request bila: tool sama + execution SAMA (tanpa reuse
 * lintas execution/sesi — P7) + operation SAMA (absent = tak mencakup apa pun
 * selain... tidak: absent operation = tak mencakup request ber-op apa pun) +
 * path (bila request ber-path fs): approval.pathScope harus contain, atau
 * approval tanpa pathScope hanya mencakup request tanpa path.
 * Blanket {tool} tanpa operation/execution-binding = tak berdaya (by design).
 */
export function approvalCovers(approval: ApprovalScope, request: CapabilityRequest): boolean {
  if (!approval || !request) return false
  if (approval.tool !== request.tool) return false
  if (approval.executionId !== request.executionId) return false
  if (approval.operation === undefined || approval.operation !== request.operation) return false
  if (request.resource.kind === "fs") {
    if (approval.pathScope === undefined) return false
    try {
      return isPathWithin(approval.pathScope, request.resource.path)
    } catch {
      return false
    }
  }
  return true
}

// ── Decision: allow / deny / ask (NILAI keputusan; prompting tetap permission handler) ──

export type CapabilityEvaluation =
  | { readonly decision: "allow"; readonly grant: CapabilityGrant; readonly reason: string }
  | { readonly decision: "deny"; readonly reason: string }
  | { readonly decision: "ask"; readonly reason: string }

/**
 * Evaluasi request terhadap parent grant (+ approval opsional):
 * - tanpa parent = deny (deny-by-default, cermin autonomous UNKNOWN→DENY);
 * - request tercover parent = allow + grant sesuai request (provenance policy);
 * - approval mencakup = allow + grant (provenance approval);
 * - selain itu = ask (butuh manusia — DIREPRESENTASIKAN, tak dieksekusi di sini).
 * Grant yang dihasilkan terikat executionId request (tanpa reuse lintas execution).
 */
export function evaluateRequest(
  request: CapabilityRequest,
  parent: CapabilityGrant | null,
  approval?: ApprovalScope,
): CapabilityEvaluation {
  if (!request?.tool || !request.executionId || !request.ownerId)
    return { decision: "deny", reason: "malformed request" }
  try {
    assertCapability({ operation: request.operation, resource: request.resource })
  } catch {
    return { decision: "deny", reason: "malformed capability" }
  }
  if (parent) {
    if (parent.ownerId !== request.ownerId)
      return { decision: "deny", reason: "owner mismatch (explicit higher authority required)" }
    const covered = parent.capabilities.some((p) =>
      isCapabilitySubset({ operation: request.operation, resource: request.resource }, p),
    )
    if (covered) {
      return {
        decision: "allow",
        reason: "covered by parent grant",
        grant: createGrant({
          executionId: request.executionId,
          ownerId: request.ownerId,
          capabilities: [{ operation: request.operation, resource: request.resource }],
          provenance: {
            requestedBy: request.tool,
            authorizedBy: `policy:parent-grant:${parent.id}`,
            derivedFrom: parent.id,
            reason: "subset of parent",
          },
        }),
      }
    }
  } else {
    return { decision: "deny", reason: "no parent grant (deny by default)" }
  }
  if (approval && approvalCovers(approval, request)) {
    return {
      decision: "allow",
      reason: `covered by approval ${approval.id}`,
      grant: createGrant({
        executionId: request.executionId,
        ownerId: request.ownerId,
        capabilities: [{ operation: request.operation, resource: request.resource }],
        provenance: {
          requestedBy: request.tool,
          authorizedBy: `approval:${approval.id}`,
          reason: "narrow approval match",
        },
      }),
    }
  }
  return { decision: "ask", reason: "requires human approval (represented, not executed here)" }
}

// ── Attenuasi parent → child (M7 memakai; M6 menyediakan proof) ──

/**
 * Turunkan grant child dari parent: child capabilities HARUS subset parent,
 * owner SAMA (lintas owner = butuh higher authority eksplisit = masa depan),
 * constraints child ⊇ parent (tak boleh buang sandbox/net-denied).
 * Gagal = deny + reason (tak pernah upgrade diam-diam).
 */
export function attenuateGrant(
  parent: CapabilityGrant,
  childSpec: {
    executionId: string
    ownerId: string
    capabilities: readonly Capability[]
    requestedBy: string
  },
): { granted: CapabilityGrant } | { denied: string } {
  if (childSpec.ownerId !== parent.ownerId)
    return { denied: "owner mismatch (explicit higher authority required)" }
  try {
    for (const cap of childSpec.capabilities) assertCapability(cap)
  } catch {
    return { denied: "malformed child capability" }
  }
  const childProbe: CapabilityGrant = {
    id: "probe",
    executionId: childSpec.executionId,
    ownerId: childSpec.ownerId,
    capabilities: childSpec.capabilities,
    provenance: { requestedBy: childSpec.requestedBy, authorizedBy: "probe", reason: "probe" },
  }
  if (!isGrantSubset(childProbe, parent)) return { denied: "child exceeds parent grant" }
  return {
    granted: createGrant({
      executionId: childSpec.executionId,
      ownerId: childSpec.ownerId,
      capabilities: childSpec.capabilities,
      provenance: {
        requestedBy: childSpec.requestedBy,
        authorizedBy: `policy:parent-grant:${parent.id}`,
        derivedFrom: parent.id,
        reason: "attenuated subset",
      },
    }),
  }
}
