// P2.1 — Identitas sesi kanonik: SATU-SATUNYA penentu SessionId durable.
//
// Aturan:
//   canonical SessionId = bentuk kanonik (sanitizeSessionPart) yang dipersist.
//   bootId              = id volatil per proses (diagnostik saja, tak pernah
//                         dipakai sebagai kunci persistensi).
//   alias               = input mentah eksak → kanonik (lookup eksak, target
//                         imutabel, tanpa rantai, tanpa auto-merge tabrakan).
//   resume tak dikenal  = error eksplisit (bukan sesi baru diam-diam).
//
// Modul ini murni keputusan + IO alias; fence penulis (writer_epoch) milik P2.2.

import { randomUUID } from "node:crypto"
import { sanitizeSessionPart } from "../lib/session-id.ts"
import {
  findFsKeyConflicts,
  lookupSessionAlias,
  sessionRowExists,
  tryRecordSessionAlias,
} from "./persistence.ts"

export class SessionNotFoundError extends Error {
  readonly code = "SESSION_NOT_FOUND"
  readonly key: string
  constructor(key: string) {
    super(
      `[resume] session "${key}" not found — refusing to start a new session under a resume id (use --session "${key}" to start fresh)`,
    )
    this.name = "SessionNotFoundError"
    this.key = key
  }
}

export class SessionAliasError extends Error {
  readonly code: "SESSION_ALIAS_CONFLICT" | "SESSION_ALIAS_HIJACK" | "SESSION_ALIAS_DANGLING"
  readonly alias: string
  constructor(code: SessionAliasError["code"], alias: string, detail: string) {
    super(`[identity] alias "${alias}" refused (${code}): ${detail}`)
    this.name = "SessionAliasError"
    this.code = code
    this.alias = alias
  }
}

export class SessionKeyCollisionError extends Error {
  readonly code = "SESSION_KEY_COLLISION"
  readonly fsKey: string
  readonly involved: string[]
  constructor(fsKey: string, involved: string[]) {
    super(
      `[identity] canonical key "${fsKey}" is claimed by multiple sessions (${involved.join(", ")}) — refusing auto-merge; disambiguate explicitly`,
    )
    this.name = "SessionKeyCollisionError"
    this.fsKey = fsKey
    this.involved = involved
  }
}

export interface CanonicalSessionIdentity {
  readonly sid: string
  readonly bootId: string
  readonly alias?: string
  readonly resumed: boolean
}

// SATU-SATUNYA generator id sesi di CLI. Hex acak sudah aman-sanitizer
// (sanitize stabil), jadi id fresh tak pernah lossy.
export function mintSessionId(): string {
  return randomUUID().slice(0, 8)
}

// SATU-SATUNYA sanitizer identitas sesi: delegasi ke helper kanonik.
// Jangan tiru regex ini di call-site (drift 64-vs-60 adalah bug P2.1).
export function sanitizeSessionId(s: string): string {
  return sanitizeSessionPart(s)
}

export function formatSessionIdentityLine(id: CanonicalSessionIdentity): string {
  return `[session sid=${id.sid} boot=${id.bootId}${id.alias ? ` alias=${id.alias}` : ""}${id.resumed ? " resumed" : ""}]`
}

function assertNoFsKeyConflict(fsKey: string, resolved: string, cwd?: string): void {
  const conflicts = findFsKeyConflicts(fsKey, resolved, cwd)
  if (conflicts.length > 0) {
    const involved = [resolved, ...conflicts.map((c) => `${c.id}→${c.canonical}`)]
    throw new SessionKeyCollisionError(fsKey, involved)
  }
}

function recordAliasOrThrow(
  rawAlias: string,
  canonical: string,
  reason: string,
  cwd?: string,
): boolean {
  const out = tryRecordSessionAlias(rawAlias, sanitizeSessionPart(rawAlias), canonical, reason, cwd)
  if (out.ok) return out.created
  if (out.reason === "alias-conflict") {
    throw new SessionAliasError(
      "SESSION_ALIAS_CONFLICT",
      rawAlias,
      `already maps to "${out.existing}"; alias targets are immutable`,
    )
  }
  if (out.reason === "key-hijack") {
    throw new SessionAliasError(
      "SESSION_ALIAS_HIJACK",
      rawAlias,
      `filesystem key maps to live session "${out.existing}"`,
    )
  }
  throw new SessionAliasError(
    "SESSION_ALIAS_DANGLING",
    rawAlias,
    `canonical target "${canonical}" has no session row`,
  )
}

// Catat provenance input-lossy hanya bila target sudah ada (sesi fresh
// belum punya baris → tak ada yang perlu didisambiguasi; dicatat saat
// resolve berikutnya setelah baris tercipta).
function noteLossyProvenance(raw: string, canonical: string, cwd?: string): void {
  if (raw === canonical) return
  if (!sessionRowExists(canonical, cwd)) return
  recordAliasOrThrow(raw, canonical, "sanitizer-lossy", cwd)
}

function resolveResumeTarget(rawResume: string, cwd?: string): { sid: string; viaAlias?: string } {
  const exact = lookupSessionAlias(rawResume, cwd)
  if (exact) {
    if (!sessionRowExists(exact.canonical, cwd)) throw new SessionNotFoundError(rawResume)
    assertNoFsKeyConflict(sanitizeSessionPart(rawResume), exact.canonical, cwd)
    return { sid: exact.canonical, viaAlias: rawResume }
  }
  const key = sanitizeSessionPart(rawResume)
  if (!sessionRowExists(key, cwd)) throw new SessionNotFoundError(key)
  assertNoFsKeyConflict(key, key, cwd)
  if (rawResume !== key) noteLossyProvenance(rawResume, key, cwd)
  return { sid: key }
}

// Titik penyelesaian identitas tunggal. Alur:
//   input id → resolveCanonical → canonical path (tak ada jalur khusus alias).
export function resolveSessionIdentity(opts: {
  sessionFlag?: string
  resumeFlag?: string
  cwd?: string
  bootId?: string
}): CanonicalSessionIdentity {
  const bootId = opts.bootId ?? mintSessionId()
  const cwd = opts.cwd
  if (opts.resumeFlag) {
    const { sid, viaAlias } = resolveResumeTarget(opts.resumeFlag, cwd)
    const rawSession = opts.sessionFlag ?? ""
    let alias = viaAlias
    if (rawSession && rawSession !== sid) {
      // Pasangan eksplisit operator (--resume X --session Y): catat Y→X.
      // Konflik/hijack = error eksplisit, bukan merge diam-diam. Khusus
      // hijack (Y adalah sesi hidup lain): arahkan operator melepas --session.
      try {
        recordAliasOrThrow(rawSession, sid, "resume-pair", cwd)
      } catch (e) {
        if (e instanceof SessionAliasError && e.code === "SESSION_ALIAS_HIJACK") {
          throw new SessionAliasError(
            e.code,
            rawSession,
            `"${rawSession}" names its own live session — omit --session when using --resume, or resume that session instead`,
          )
        }
        throw e
      }
      alias = rawSession
    }
    return { sid, bootId, ...(alias ? { alias } : {}), resumed: true }
  }
  const rawSession = opts.sessionFlag ?? ""
  if (rawSession) {
    const sid = sanitizeSessionPart(rawSession)
    if (rawSession !== sid) noteLossyProvenance(rawSession, sid, cwd)
    assertNoFsKeyConflict(sid, sid, cwd)
    return { sid, bootId, resumed: false }
  }
  return { sid: sanitizeSessionPart(mintSessionId()), bootId, resumed: false }
}

// Read-path kompatibel untuk perintah baca (sessions export): alias →
// kanonik, selain itu bentuk kanonik input. Tak melempar; tak mencatat.
export function resolveSessionDisplayTarget(input: string, cwd?: string): string {
  const exact = lookupSessionAlias(input, cwd)
  if (exact && sessionRowExists(exact.canonical, cwd)) return exact.canonical
  return sanitizeSessionPart(input)
}
