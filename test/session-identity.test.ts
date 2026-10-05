// P2.1 — Kontrak identitas sesi kanonik (produksi, bukan oracle).
//
// Meliputi: resolver tunggal, sanitizer tunggal, alias eksak + imutabel,
// anti-loop, deteksi tabrakan (separator + over-length), resume tak dikenal
// = error eksplisit, dan single-write path kanonik.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliSession } from "../cli/setup.ts"
import {
  resolveSessionDisplayTarget,
  resolveSessionIdentity,
  SessionAliasError,
  SessionKeyCollisionError,
  SessionNotFoundError,
} from "../src/session/identity.ts"
import {
  lookupSessionAlias,
  saveSession,
  tryRecordSessionAlias,
} from "../src/session/persistence.ts"

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p21-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  writeFileSync(
    join(dir, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl: "http://localhost:9", apiKey: "sk-test", models: ["m"] }],
    }),
    "utf8",
  )
  return dir
}

function baseOpts(cwd: string, extra: Record<string, unknown> = {}) {
  return {
    cwd,
    allowLocalConfig: true,
    sessionId: "",
    prompt: "hi",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
    ...extra,
  }
}

function sessionIds(cwd: string): string[] {
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    return (db.prepare("SELECT id FROM sessions").all() as { id: string }[]).map((r) => r.id)
  } finally {
    db.close()
  }
}

test("P2.1: fresh tanpa flag → sid acak + bootId volatil terpisah", () => {
  const id = resolveSessionIdentity({})
  expect(id.sid).toMatch(/^[0-9a-f]{8}$/)
  expect(id.bootId).toMatch(/^[0-9a-f]{8}$/)
  expect(id.resumed).toBe(false)
  expect(id.alias).toBeUndefined()
})

test("P2.1: --session melewati SATU sanitizer kanonik", () => {
  expect(resolveSessionIdentity({ sessionFlag: "a/b" }).sid).toBe("a-b")
  expect(resolveSessionIdentity({ sessionFlag: "..." }).sid).toBe("x")
  expect(resolveSessionIdentity({ sessionFlag: ".foo" }).sid).toBe("foo")
  expect(resolveSessionIdentity({ sessionFlag: `y${"z".repeat(100)}` }).sid).toHaveLength(60)
})

test("P2.1: --resume baris ada → sid baris, resumed", async () => {
  const cwd = ws()
  await saveSession("lived", cwd, undefined, [{ role: "user", content: "h" }], { turns: 1 })
  const id = resolveSessionIdentity({ resumeFlag: "lived", cwd })
  expect(id.sid).toBe("lived")
  expect(id.resumed).toBe(true)
})

test("P2.1: --resume tak dikenal → SESSION_NOT_FOUND eksplisit", () => {
  const cwd = ws()
  expect(() => resolveSessionIdentity({ resumeFlag: "tak-ada", cwd })).toThrow(SessionNotFoundError)
})

test("P2.1: alias eksak resolve ke kanonik; display-target lenien untuk baca", async () => {
  const cwd = ws()
  await saveSession("canon", cwd, undefined, [{ role: "user", content: "h" }], { turns: 1 })
  const id = resolveSessionIdentity({ sessionFlag: "nama-lama", resumeFlag: "canon", cwd })
  expect(id.sid).toBe("canon")
  expect(id.alias).toBe("nama-lama")
  expect(lookupSessionAlias("nama-lama", cwd)?.canonical).toBe("canon")
  // Resolve ulang via alias mentah (tanpa --session).
  expect(resolveSessionIdentity({ resumeFlag: "nama-lama", cwd }).sid).toBe("canon")
  expect(resolveSessionDisplayTarget("nama-lama", cwd)).toBe("canon")
  expect(resolveSessionDisplayTarget("asing", cwd)).toBe("asing")
})

test("P2.1: target alias imutabel — A→B lalu A→C ditolak", async () => {
  const cwd = ws()
  await saveSession("sB", cwd, undefined, [], undefined)
  await saveSession("sC", cwd, undefined, [], undefined)
  expect(tryRecordSessionAlias("m", "m", "sB", "uji", cwd)).toEqual({ ok: true, created: true })
  expect(tryRecordSessionAlias("m", "m", "sB", "uji", cwd)).toEqual({ ok: true, created: false })
  const out = tryRecordSessionAlias("m", "m", "sC", "uji", cwd)
  expect(out.ok).toBe(false)
  if (!out.ok && out.reason === "alias-conflict") expect(out.existing).toBe("sB")
  else throw new Error("harusnya alias-conflict")
  expect(() => resolveSessionIdentity({ sessionFlag: "m", resumeFlag: "sC", cwd })).toThrow(
    SessionAliasError,
  )
})

test("P2.1: loop A→B→A tak representable (hijack rule)", async () => {
  const cwd = ws()
  await saveSession("sA", cwd, undefined, [], undefined)
  await saveSession("sB", cwd, undefined, [], undefined)
  expect(tryRecordSessionAlias("x", "x", "sB", "uji", cwd).ok).toBe(true)
  // "sB" sebagai alias ke sA: fs_key "sB" adalah baris sesi hidup lain.
  const out = tryRecordSessionAlias("sB", "sB", "sA", "uji", cwd)
  expect(out).toEqual({ ok: false, reason: "key-hijack", existing: "sB" })
})

test("P2.1: tabrakan separator tak pernah auto-merge", async () => {
  const cwd = ws()
  await saveSession("t1", cwd, undefined, [{ role: "user", content: "h" }], { turns: 1 })
  // Provenance lossy tercatat: "w/e" dikenal sebagai nama untuk t1.
  expect(tryRecordSessionAlias("w/e", "w-e", "t1", "sanitizer-lossy", cwd)).toEqual({
    ok: true,
    created: true,
  })
  // Flag "w-e" (kunci sama, sesi berbeda) → tabrakan eksplisit.
  expect(() => resolveSessionIdentity({ sessionFlag: "w-e", cwd })).toThrow(
    SessionKeyCollisionError,
  )
})

test("P2.1: tabrakan over-length tak pernah auto-merge", async () => {
  const cwd = ws()
  const prefix = "k".repeat(60)
  await saveSession("t2", cwd, undefined, [{ role: "user", content: "h" }], { turns: 1 })
  expect(tryRecordSessionAlias(`${prefix}AAA`, prefix, "t2", "sanitizer-lossy", cwd).ok).toBe(true)
  expect(() => resolveSessionIdentity({ sessionFlag: `${prefix}BBB`, cwd })).toThrow(
    SessionKeyCollisionError,
  )
})

test("P2.1: createCliSession --resume tak dikenal menolak (bukan sesi baru diam-diam)", async () => {
  const cwd = ws()
  await expect(createCliSession(baseOpts(cwd, { resumeId: "hantu" }))).rejects.toThrow(
    SessionNotFoundError,
  )
})

test("P2.1: single-write — fresh + resume memakai SATU kunci, restart tak menempa id baru", async () => {
  const cwd = ws()
  const c1 = await createCliSession(baseOpts(cwd, { sessionId: "tunggal" }))
  expect(c1.sessionId).toBe("tunggal")
  expect(c1.bootId).toMatch(/^[0-9a-f]{8}$/)
  expect(c1.bootId).not.toBe(c1.sessionId)
  await c1.persistCurrent({ totalTokens: 5 })
  await c1.close()
  expect(sessionIds(cwd)).toEqual(["tunggal"])
  // Restart via --resume: sid sama, tetap satu baris.
  const c2 = await createCliSession(baseOpts(cwd, { resumeId: "tunggal" }))
  expect(c2.sessionId).toBe("tunggal")
  expect(c2.bootId).not.toBe(c1.bootId)
  await c2.persistCurrent({ totalTokens: 6 })
  await c2.close()
  expect(sessionIds(cwd)).toEqual(["tunggal"])
})

test("P2.1: semua path turunan sesi memakai sid kanonik (bukan bootId)", async () => {
  const cwd = ws()
  const c = await createCliSession(baseOpts(cwd, { sessionId: "jalur" }))
  const { journalPath } = await import("../src/session/journal.ts")
  const { loadCheckpointManifest, recordCheckpointFromSnapshots } = await import(
    "../src/session/checkpoint.ts"
  )
  // Jurnal eager-create terikat sid.
  expect(journalPath(c.sessionId, cwd)).toContain("journal-jalur.jsonl")
  expect(journalPath(c.bootId, cwd)).not.toContain("journal-jalur.jsonl")
  // Checkpoint manifest terikat sid.
  await recordCheckpointFromSnapshots(
    c.sessionId,
    1,
    [{ path: "f.txt", content: null }],
    "uji",
    cwd,
  )
  const man = await loadCheckpointManifest(c.sessionId, cwd)
  expect(man.checkpoints.length).toBe(1)
  const manBoot = await loadCheckpointManifest(c.bootId, cwd)
  expect(manBoot.checkpoints.length).toBe(0)
  await c.close()
})
