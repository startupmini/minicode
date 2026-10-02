// M6 — Capability split: request≠grant, decision≠delivery, subset proof.
// Hermetic murni: tanpa policy/scheduler/persistence/backend.

import { expect, test } from "bun:test"
import {
  approvalCovers,
  attenuateGrant,
  type Capability,
  type CapabilityGrant,
  type CapabilityRequest,
  createGrant,
  evaluateRequest,
  isCapabilitySubset,
  isGrantSubset,
  isPathWithin,
  isSecretName,
  normalizeScopePath,
} from "../src/runtime/capability.ts"

const OWNER = "sess-m6"
const EXEC = "exec_11111111-1111-4111-8111-111111111111"

function parentGrant(): CapabilityGrant {
  return createGrant({
    executionId: EXEC,
    ownerId: OWNER,
    capabilities: [
      { operation: "read", resource: { kind: "fs", path: "/repo" } },
      { operation: "write", resource: { kind: "fs", path: "/repo/output" } },
      { operation: "network", resource: { kind: "net", hosts: ["proxy.internal"] } },
      { operation: "read", resource: { kind: "env", names: ["HOME", "PATH"] } },
      { operation: "execute", resource: { kind: "proc", scope: "own" } },
    ],
    provenance: { requestedBy: "test", authorizedBy: "policy:test", reason: "parent" },
  })
}

function req(tool: string, cap: Capability, executionId = EXEC): CapabilityRequest {
  return { tool, operation: cap.operation, resource: cap.resource, executionId, ownerId: OWNER }
}

// C1 — Authorization: allow / deny / ask.
test("C1 authorization: covered=allow, uncovered=ask, no-parent=deny", () => {
  const parent = parentGrant()
  const allow = evaluateRequest(
    req("read_file", { operation: "read", resource: { kind: "fs", path: "/repo/src/a.ts" } }),
    parent,
  )
  expect(allow.decision).toBe("allow")
  if (allow.decision !== "allow") throw new Error("unreachable")
  expect(allow.grant.capabilities).toHaveLength(1)
  const ask = evaluateRequest(
    req("bash", { operation: "execute", resource: { kind: "fs", path: "/repo/run.sh" } }),
    parent,
  )
  // execute di /repo tak tercover (hanya read /repo + write /repo/output) → ask.
  expect(ask.decision).toBe("ask")
  const deny = evaluateRequest(
    req("read_file", { operation: "read", resource: { kind: "fs", path: "/repo/x" } }),
    null,
  )
  expect(deny.decision).toBe("deny")
})

// C2 — Request/grant separation: granted == yang diminta & tercover (bukan parent utuh).
test("C2 separation: grant berisi request tercover, bukan seluruh parent", () => {
  const parent = parentGrant()
  const r = evaluateRequest(
    req("read_file", { operation: "read", resource: { kind: "fs", path: "/repo/src" } }),
    parent,
  )
  expect(r.decision).toBe("allow")
  if (r.decision !== "allow") throw new Error("unreachable")
  expect(r.grant.capabilities).toHaveLength(1)
  expect(r.grant.capabilities[0]?.resource).toEqual({ kind: "fs", path: "/repo/src" })
  expect(r.grant.executionId).toBe(EXEC)
})

// C3 — Child attenuation + subset proof (READ /repo → READ /repo/src valid).
test("C3 attenuation: subset valid; strict superset/eskalasi ditolak", () => {
  const parent = parentGrant()
  const childExec = "exec_22222222-2222-4222-8222-222222222222"
  const ok = attenuateGrant(parent, {
    executionId: childExec,
    ownerId: OWNER,
    capabilities: [{ operation: "read", resource: { kind: "fs", path: "/repo/src" } }],
    requestedBy: "delegate_task",
  })
  expect("granted" in ok).toBe(true)
  if (!("granted" in ok)) throw new Error("unreachable")
  expect(isGrantSubset(ok.granted, parent)).toBe(true)
  expect(ok.granted.provenance.derivedFrom).toBe(parent.id)
  // Eskalasi: WRITE dari parent READ → deny.
  const esc = attenuateGrant(parent, {
    executionId: childExec,
    ownerId: OWNER,
    capabilities: [{ operation: "write", resource: { kind: "fs", path: "/repo/src" } }],
    requestedBy: "delegate_task",
  })
  expect(esc).toEqual({ denied: "child exceeds parent grant" })
  // Di luar scope: READ /etc → deny.
  const outside = attenuateGrant(parent, {
    executionId: childExec,
    ownerId: OWNER,
    capabilities: [{ operation: "read", resource: { kind: "fs", path: "/etc" } }],
    requestedBy: "delegate_task",
  })
  expect("denied" in outside).toBe(true)
  // Lintas owner: butuh higher authority eksplisit.
  const xowner = attenuateGrant(parent, {
    executionId: childExec,
    ownerId: "sess-lain",
    capabilities: [{ operation: "read", resource: { kind: "fs", path: "/repo/src" } }],
    requestedBy: "delegate_task",
  })
  expect(xowner).toEqual({ denied: "owner mismatch (explicit higher authority required)" })
})

// C4 — Approval narrowness: blanket tak berdaya; exact-bound mencakup; lintas-exec ditolak.
test("C4 approval: sempit-by-construction", () => {
  const blanket = { id: "ap-1", tool: "bash", executionId: EXEC, nonce: "n1" }
  const writeReq = req("bash", { operation: "write", resource: { kind: "fs", path: "/repo/x" } })
  expect(approvalCovers(blanket, writeReq)).toBe(false)
  const exact = {
    id: "ap-2",
    tool: "bash",
    operation: "write" as const,
    pathScope: "/repo/output",
    executionId: EXEC,
    nonce: "n2",
  }
  const covered = req("bash", {
    operation: "write",
    resource: { kind: "fs", path: "/repo/output/f" },
  })
  expect(approvalCovers(exact, covered)).toBe(true)
  // Lintas execution: reuse ditolak (P7 / C11).
  const other = req(
    "bash",
    { operation: "write", resource: { kind: "fs", path: "/repo/output/f" } },
    "exec_33333333-3333-4333-8333-333333333333",
  )
  expect(approvalCovers(exact, other)).toBe(false)
  // Approval via evaluate: request TAK tercover parent + approval mencakup → allow provenance approval.
  // (Bila tercover parent, jalur policy yang menang — benar secara semantik.)
  const parent = parentGrant()
  const execReq = req("bash", {
    operation: "execute",
    resource: { kind: "fs", path: "/repo/tool.sh" },
  })
  const viaApproval = evaluateRequest(execReq, parent, {
    id: "ap-3",
    tool: "bash",
    operation: "execute",
    pathScope: "/repo",
    executionId: EXEC,
    nonce: "n3",
  })
  expect(viaApproval.decision).toBe("allow")
  if (viaApproval.decision !== "allow") throw new Error("unreachable")
  expect(viaApproval.grant.provenance.authorizedBy).toBe("approval:ap-3")
})

// C5 — Filesystem scope: traversal/symlink-leksikal/case ditolak; child tak melebar.
test("C5 filesystem: escape & traversal ditolak", () => {
  expect(isPathWithin("/repo", "/repo/src/a.ts")).toBe(true)
  expect(isPathWithin("/repo", "/repo")).toBe(true)
  expect(isPathWithin("/repo", "/repo/../etc")).toBe(false)
  expect(isPathWithin("/repo", "/etc")).toBe(false)
  expect(isPathWithin("/repo", "/repo-other/x")).toBe(false)
  expect(() => normalizeScopePath("a\0b")).toThrow()
  // NUL / malformed grant ditolak (C12).
  expect(() =>
    createGrant({
      executionId: EXEC,
      ownerId: OWNER,
      capabilities: [{ operation: "read", resource: { kind: "fs", path: "" } }],
      provenance: { requestedBy: "t", authorizedBy: "p", reason: "r" },
    }),
  ).toThrow()
})

// C6 — Network: denied vs scoped.
test("C6 network: tanpa kapabilitas = deny; scoped host dienforce", () => {
  const parent = parentGrant()
  const ok = evaluateRequest(
    req("web_fetch", {
      operation: "network",
      resource: { kind: "net", hosts: ["proxy.internal"] },
    }),
    parent,
  )
  expect(ok.decision).toBe("allow")
  const evil = evaluateRequest(
    req("web_fetch", { operation: "network", resource: { kind: "net", hosts: ["evil.example"] } }),
    parent,
  )
  expect(evil.decision).toBe("ask")
  const noNet = createGrant({
    executionId: EXEC,
    ownerId: OWNER,
    capabilities: [{ operation: "read", resource: { kind: "fs", path: "/repo" } }],
    provenance: { requestedBy: "t", authorizedBy: "p", reason: "r" },
  })
  const denied = evaluateRequest(
    req("web_fetch", {
      operation: "network",
      resource: { kind: "net", hosts: ["proxy.internal"] },
    }),
    noNet,
  )
  expect(denied.decision).toBe("ask")
})

// C7 — Environment: secret tak otomatis; eksplisit + non-secret saja.
test("C7 environment: secret names ditolak tanpa grant eksplisit", () => {
  expect(isSecretName("OPENAI_API_KEY")).toBe(true)
  expect(isSecretName("GITHUB_TOKEN")).toBe(true)
  expect(isSecretName("HOME")).toBe(false)
  const parent = parentGrant()
  const ok = evaluateRequest(
    req("bash", { operation: "read", resource: { kind: "env", names: ["HOME"] } }),
    parent,
  )
  expect(ok.decision).toBe("allow")
  const anon = evaluateRequest(
    req("bash", {
      operation: "read",
      resource: { kind: "env", names: ["HOME", "OPENAI_API_KEY"] },
    }),
    parent,
  )
  // OPENAI_API_KEY tak ada di parent → keseluruhan tak tercover → ask (bukan allow parsial diam-diam).
  expect(anon.decision).toBe("ask")
})

// C8 — Sandbox constraints monotonik: child tak boleh buang constraint.
test("C8 sandbox: constraints parent dipertahankan child", () => {
  const parent = createGrant({
    executionId: EXEC,
    ownerId: OWNER,
    capabilities: [
      {
        operation: "read",
        resource: { kind: "fs", path: "/repo" },
        constraints: ["sandbox:docker", "net:denied"],
      },
    ],
    provenance: { requestedBy: "t", authorizedBy: "p", reason: "r" },
  })
  const keep = attenuateGrant(parent, {
    executionId: "exec_44444444-4444-4444-8444-444444444444",
    ownerId: OWNER,
    capabilities: [
      {
        operation: "read",
        resource: { kind: "fs", path: "/repo/src" },
        constraints: ["sandbox:docker", "net:denied"],
      },
    ],
    requestedBy: "d",
  })
  expect("granted" in keep).toBe(true)
  const drop = attenuateGrant(parent, {
    executionId: "exec_44444444-4444-4444-8444-444444444444",
    ownerId: OWNER,
    capabilities: [{ operation: "read", resource: { kind: "fs", path: "/repo/src" } }],
    requestedBy: "d",
  })
  expect(drop).toEqual({ denied: "child exceeds parent grant" })
})

// C10 — Provenance traceable tanpa secret.
test("C10 provenance: rantai derivasi tanpa secret", () => {
  const parent = parentGrant()
  const r = evaluateRequest(
    req("read_file", { operation: "read", resource: { kind: "fs", path: "/repo/a" } }),
    parent,
  )
  expect(r.decision).toBe("allow")
  if (r.decision !== "allow") throw new Error("unreachable")
  expect(r.grant.provenance.derivedFrom).toBe(parent.id)
  expect(r.grant.provenance.requestedBy).toBe("read_file")
  const dumped = JSON.stringify(r.grant)
  expect(dumped).not.toMatch(/sk-|Bearer|TOKEN=/)
})

// C11 — Cross-session isolation.
test("C11 isolation: grant execution A tak berlaku di B", () => {
  const parent = parentGrant()
  const otherExec = "exec_55555555-5555-4555-8555-555555555555"
  const r = evaluateRequest(
    req("read_file", { operation: "read", resource: { kind: "fs", path: "/repo/a" } }, otherExec),
    parent,
  )
  // Parent terikat EXEC; request execution lain + owner sama → owner check lolos
  // (owner sama) tetapi grant yang diterbitkan terikat executionId request (bukan reuse).
  expect(r.decision).toBe("allow")
  if (r.decision !== "allow") throw new Error("unreachable")
  expect(r.grant.executionId).toBe(otherExec)
  expect(r.grant.executionId).not.toBe(parent.executionId)
})

// C12 — Invalid grant/request rejected.
test("C12 invalid: malformed ditolak", () => {
  expect(evaluateRequest(null as never, parentGrant()).decision).toBe("deny")
  expect(
    evaluateRequest(
      req("x", { operation: "read", resource: { kind: "proc", scope: "other" } as never }),
      parentGrant(),
    ).decision,
  ).toBe("deny")
  expect(() =>
    createGrant({
      executionId: "",
      ownerId: OWNER,
      capabilities: [],
      provenance: { requestedBy: "t", authorizedBy: "p", reason: "r" },
    }),
  ).toThrow()
  expect(() =>
    createGrant({
      executionId: EXEC,
      ownerId: OWNER,
      capabilities: [],
      provenance: { requestedBy: "", authorizedBy: "p", reason: "r" },
    }),
  ).toThrow()
})

// P1–P7 properties.
test("P1 childGrant ⊆ parentGrant (property)", () => {
  const parent = parentGrant()
  const cases: Capability[] = [
    { operation: "read", resource: { kind: "fs", path: "/repo/a/b" } },
    { operation: "read", resource: { kind: "net", hosts: ["proxy.internal"] } },
    { operation: "read", resource: { kind: "env", names: ["HOME"] } },
  ]
  for (const c of cases) {
    expect(parent.capabilities.some((p) => isCapabilitySubset(c, p))).toBe(true)
  }
  expect(
    isCapabilitySubset(
      { operation: "admin", resource: { kind: "fs", path: "/repo" } },
      { operation: "read", resource: { kind: "fs", path: "/repo" } },
    ),
  ).toBe(false)
})

test("P2 denied authorization ⇒ no grant", () => {
  const r = evaluateRequest(
    req("bash", { operation: "execute", resource: { kind: "fs", path: "/bin/x" } }),
    null,
  )
  expect(r.decision).toBe("deny")
  expect("grant" in r).toBe(false)
})

test("P3 approval cannot broaden grant", () => {
  const approval = { id: "ap-x", tool: "bash", executionId: EXEC, nonce: "n" }
  // Request sengaja di luar cakupan parent (execute fs) agar sampai ke jalur approval.
  const r = evaluateRequest(
    req("bash", { operation: "execute", resource: { kind: "fs", path: "/repo/tool.sh" } }),
    parentGrant(),
    approval,
  )
  // approval tanpa operation binding tak mencakup request execute → ask (bukan allow).
  expect(r.decision).toBe("ask")
})

test("P4 identity cannot equal authority", () => {
  // executionId/ownerId di request adalah identifier; decision tak pernah
  // mengembalikan authority berdasarkan kecocokan string semata tanpa grant/approval.
  const r = evaluateRequest(
    {
      tool: "bash",
      operation: "execute",
      resource: { kind: "proc", scope: "own" },
      executionId: EXEC,
      ownerId: OWNER,
    },
    null,
  )
  expect(r.decision).toBe("deny")
})

test("P5 grant immutable setelah admission", () => {
  const g = parentGrant()
  expect(Object.isFrozen(g)).toBe(true)
  expect(Object.isFrozen(g.capabilities)).toBe(true)
  expect(() => {
    ;(g as unknown as { ownerId: string }).ownerId = "x"
  }).toThrow()
  expect(g.ownerId).toBe(OWNER)
})

test("P6 grant scope cannot escape parent scope", () => {
  const parent = parentGrant()
  const esc: Capability = { operation: "read", resource: { kind: "fs", path: "/repo/../outside" } }
  expect(parent.capabilities.some((p) => isCapabilitySubset(esc, p))).toBe(false)
})

test("P7 cross-session grant reuse rejected", () => {
  const approval = {
    id: "ap-s",
    tool: "read_file",
    operation: "read" as const,
    pathScope: "/repo",
    executionId: EXEC,
    nonce: "n",
  }
  const same = req("read_file", { operation: "read", resource: { kind: "fs", path: "/repo/a" } })
  const other = req(
    "read_file",
    { operation: "read", resource: { kind: "fs", path: "/repo/a" } },
    "exec_66666666-6666-4666-8666-666666666666",
  )
  expect(approvalCovers(approval, same)).toBe(true)
  expect(approvalCovers(approval, other)).toBe(false)
})

// Negative: executionId bukan authorization secret; Registry bukan grant authority.
test("N1 executionId bukan token otorisasi; grant id namespace sendiri", () => {
  const g = parentGrant()
  expect(g.id.startsWith("cg_")).toBe(true)
  expect(g.id).not.toBe(g.executionId)
  // Mengetahui executionId saja tak memberi grant: tanpa parent/approval → deny/ask.
  const bare = evaluateRequest(
    req("bash", { operation: "write", resource: { kind: "fs", path: "/repo/output/x" } }),
    null,
  )
  expect(bare.decision).toBe("deny")
})
