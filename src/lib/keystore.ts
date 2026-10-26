import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readlinkSync } from "node:fs"
import { chmod, mkdir, open, readdir, readFile, unlink } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { basename, join } from "node:path"
import { atomicWriteText } from "./atomic-write.ts"

// Penyimpanan rahasia berlapis (tanpa dependensi):
// - Windows: DPAPI user-scope via powershell bawaan (hanya user ini yang
//   bisa dekripsi, bahkan bila berkas dibaca pihak lain).
// - Selain itu: berkas chmod 600 (status quo — didokumentasikan, bukan
//   diklaim setara keyring).
//
// Desain: envelope — yang disimpan di disk SELALU `{enc, alg}`; `alg`
// `"dpapi"` berarti base64 blob DPAPI, `"plain"` berarti teks biasa.
// Fallback ke plain OTOMATIS bila backend OS tak tersedia (bukan error),
// supaya CLI tetap jalan di CI/container. Tak pernah melempar.
//
// Fail-closed pada jalur TULIS: credential yang ada tak boleh hilang.
// Store yang tak bisa dibaca (EACCES/EISDIR) atau tak bisa di-parse (JSON
// rusak) TIDAK boleh diperlakukan sebagai "store kosong" lalu ditimpa —
// itu menghapus seluruh credential lama tanpa jejak. Jalur tulis membeda-
// kan "store belum ada" (boleh dibuat) dari "store ada tapi rusak" (tolak
// menulis, laporkan, biarkan berkasnya apa adanya).
//
// Jalur tulis juga DISERIALISASI (kunci lintas proses, lihat acquireStoreLock):
// store dibaca-modifikasi-ditulis, jadi dua penulis konkuren tanpa kunci
// berarti credential yang baru ditulis lenyap diam-diam (lost update).

export type SecretRunner = (
  cmd: string,
  args: string[],
  input?: string,
) => { status: number | null; stdout: string }

/** Penulis store (seam uji: mensimulasikan "gagal tulis"). */
export type StoreWriter = (path: string, data: string) => Promise<void>

let runnerOverride: SecretRunner | null = null
let writerOverride: StoreWriter | null = null

/** Seam uji: ganti eksekutor powershell. */
export function __setKeystoreRunnerForTest(r: SecretRunner | null): void {
  runnerOverride = r
}

/**
 * Seam uji: ganti penulis store. Dipakai untuk mensimulasikan kegagalan
 * tulis secara deterministik (tanpa bergantung permission/filesystem spesifik
 * OS). Default = tulis atomik sungguhan.
 */
export function __setKeystoreWriterForTest(w: StoreWriter | null): void {
  writerOverride = w
}

const secretCache = new Map<string, string | null>()

/** Reset cache + runner + writer + timing kunci (test saja). */
export function __resetKeystoreForTest(): void {
  secretCache.clear()
  runnerOverride = null
  writerOverride = null
  lockTimingOverride = null
}

function defaultRunner(
  cmd: string,
  args: string[],
  input?: string,
): { status: number | null; stdout: string } {
  try {
    const r = spawnSync(cmd, args, {
      input,
      encoding: "utf8",
      timeout: 15000,
      shell: process.platform === "win32",
      windowsHide: true,
    })
    return { status: typeof r.status === "number" ? r.status : null, stdout: r.stdout ?? "" }
  } catch {
    return { status: null, stdout: "" }
  }
}

function storePath(): string {
  const home = process.env.MINICODE_HOME || homedir()
  return join(home, ".minicode", "secrets.json")
}

/** File kunci — satu folder dengan store (filesystem sama). */
function lockPath(): string {
  return `${storePath()}.lock`
}

// ── Serialisasi penulis store ─────────────────────────────────────────────
// Store dibaca-modifikasi-tulis. Dua penulis pada store yang sama =
// lost update: credential yang baru ditulis lenyap diam-diam (reproducer:
// dua set-key konkuren → hanya satu credential tersisa, keduanya melaporkan
// "sukses"). atomicWriteText mencegah TORN write, bukan lost update.
//
// Kunci: file "wx" (O_EXCL — atomik di POSIX dan Windows) di folder yang sama
// dengan store.
//
// ATURAN PEMILIKAN (hasil design review + koreksi akhir):
// - Kunci HANYA boleh dilepas oleh PEMILIKNYA SENDIRI (token cocok). Kunci
//   milik orang lain TAK PERNAH diambil alih otomatis — bukan karena umurnya,
//   dan bukan karena pemiliknya terlihat mati.
//
// Kenapa tidak ada reclaim otomatis: "baca payload → nilai → hapus path kunci"
// adalah TOCTOU/ABA. Antara baca dan hapus, path yang sama bisa sudah menunjuk
// objek LAIN — kunci milik penulis lain yang HIDUP. Primitive yang tersedia
// tak bisa menutup itu: open("wx") (O_EXCL) atomik untuk MEMBUAT, tapi
// rename()/unlink() bekerja pada NAMA PATH tanpa syarat identitas (tak ada
// flock/LockFileEx/renameat2/unlinkat-by-fd di Node/Bun). Tanpa fencing,
// penulis yang tergeser tetap menulis store dan menimpa credential milik
// penulis baru — kehilangan diam-diam. Karena itu jalur reclaim dihapus:
// kunci yang tertinggal dari proses yang crash diselesaikan MANUAL (pesan
// di stderr menyebut path kunci + apakah pemiliknya tampak hidup).
//
// Identitas pemilik tetap disimpan (payload v2: pid, token, ts, host, ns)
// untuk DIAGNOSTIK — membantu operator memutuskan boleh atau tidak menghapus
// file kunci yang tersisa.
//
// - Ambil : buat file kunci O_EXCL + tulis payload v2. Kalau sudah ada →
//   tunggu (poll) sampai batas tunggu habis → fail-closed (tak ada yang
//   ditulis, cache tak disentuh, pesan pemulihan menyebut path kunci).
// - Lepas : unlink HANYA kalau token di file kunci masih milik kita. Balapan
//   release (cek-lalu-unlink tak atomik) tak terjangkau: selama lock dipegang
//   pemiliknya, path kunci terisi terus (hanya owner's release yang menghapus),
//   jadi path tak pernah di-rebind di antara cek dan unlink.
// - Crash : file kunci tertinggal → semua penulis lain fail-closed sampai
//   operator menghapusnya (fail-closed, bukan diam-diam).
// - Gagal : kunci tak bisa dibuat (folder tak writable) → fail-closed; tak ada
//   yang ditulis dan tak ada credential hilang diam-diam.
//
// JAMINAN YANG DIDOKUMENTASIKAN (bukan klaim kriptografis):
// - Filesystem lokal (NTFS/ext4/APFS/XFS): O_EXCL create atomik → paling
//   banyak satu pemegang kunci sepanjang waktu; tidak ada jalur yang menghapus
//   kunci milik orang lain → EKSLUSIVITAS MUTLAK (strict mutual exclusion)
//   untuk bagian kritis.
// - Windows/macOS: ruang PID milik SELURUH host → (host, pid) cukup untuk
//   menentukan pemiliknya. Identitas host = hostname OS; dua mesin dengan
//   hostname sama melemahkan jaminan ini (jarang, tak diklaim aman).
// - Linux: identitas namespace PID (/proc/self/ns/pid) membedakan container
//   yang berbagi home; pid check hanya valid bila namespace cocok.
// - NFS/SMB: O_EXCL/rename umumnya atomik di sisi server, TAPI metadata
//   (payload) bisa basi karena attribute caching. Karena tak ada reclaim,
//   metadata basi hanya memengaruhi DIAGNOSTIK pesan — bukan keputusan
//   penulisan. Jaminan lintas-host tetap TIDAK diklaim.
const LOCK_POLL_MS = 25
const LOCK_WAIT_MS = 10_000
const LOCK_PAYLOAD_VERSION = 2

/**
 * Seam uji: batasi waktu tunggu/poll kunci. Default = nilai produksi; test
 * boleh memendekkannya supaya kasus "kunci tak bisa didapat" selesai cepat.
 * BUKAN env toggle produksi — hanya lewat API eksplisit.
 */
let lockTimingOverride: { waitMs?: number; pollMs?: number } | null = null

export function __setKeystoreLockTimingForTest(
  t: { waitMs?: number; pollMs?: number } | null,
): void {
  lockTimingOverride = t
}

function lockWaitMs(): number {
  return lockTimingOverride?.waitMs ?? LOCK_WAIT_MS
}

function lockPollMs(): number {
  return lockTimingOverride?.pollMs ?? LOCK_POLL_MS
}

interface LockPayload {
  v: number
  pid: number
  token: string
  ts: number
  host: string
  ns: string
}

/** Identitas host — stabil per proses, di-cache. */
let hostIdCache: string | null = null
function hostIdentity(): string {
  if (hostIdCache !== null) return hostIdCache
  try {
    hostIdCache = hostname()
  } catch {
    hostIdCache = "unknown-host"
  }
  return hostIdCache
}

/**
 * Identitas namespace PID. Linux: inode namespace dari /proc/self/ns/pid —
 * inilah yang membuat pid check bermakna (dua container bisa punya pid sama).
 * Platform tanpa namespace PID: "none" (ruang pid = satu host).
 * "pidns:unknown" = /proc tak terbaca → identitas tak bisa dipastikan →
 * TIDAK BOLEH dipakai untuk reclaim.
 */
let nsIdCache: string | null = null
function pidNamespaceIdentity(): string {
  if (nsIdCache !== null) return nsIdCache
  if (process.platform !== "linux") {
    nsIdCache = "none"
    return nsIdCache
  }
  try {
    nsIdCache = `pidns:${readlinkSync("/proc/self/ns/pid")}`
  } catch {
    nsIdCache = "pidns:unknown"
  }
  return nsIdCache
}

/** Parse payload kunci. null = tak terbaca / tak valid / format lama. */
function parseLockPayload(raw: string): LockPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const p = parsed as Partial<LockPayload>
  if (p.v !== LOCK_PAYLOAD_VERSION) return null
  if (typeof p.pid !== "number" || !Number.isInteger(p.pid) || p.pid <= 0) return null
  if (typeof p.token !== "string" || !p.token) return null
  if (typeof p.ts !== "number") return null
  if (typeof p.host !== "string" || !p.host) return null
  if (typeof p.ns !== "string" || !p.ns) return null
  return { v: p.v, pid: p.pid, token: p.token, ts: p.ts, host: p.host, ns: p.ns }
}

async function readLockPayload(path: string): Promise<LockPayload | null> {
  try {
    return parseLockPayload(await readFile(path, "utf8"))
  } catch {
    return null
  }
}

/**
 * Kepemilikan: true HANYA kalau pid benar-benar tidak ada (ESRCH). EPERM =
 * proses hidup tapi hak akses berbeda → anggap hidup (konservatif).
 */
function pidAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ESRCH"
  }
}

/**
 * TRUE hanya kalau pemilik kunci terbukti mati di konteks yang sama.
 * Semua kondisi lain (host beda, namespace beda, namespace tak diketahui,
 * payload tak valid) → ownership UNKNOWN → JANGAN ambil alih.
 *
 * CATATAN: dipakai untuk DIAGNOSTIK saja (pesan fail-closed memberi tahu
 * apakah pemilik kunci tampaknya masih hidup). Otomatik reclaim sudah
 * DIHAPUS: validate-and-remove pada nama path punya celah ABA (lihat
 * acquireStoreLock).
 */

interface StoreLock {
  release: () => Promise<void>
}

async function acquireStoreLock(): Promise<StoreLock | null> {
  const path = lockPath()
  const token = randomUUID()
  const host = hostIdentity()
  const ns = pidNamespaceIdentity()
  const waitMs = lockWaitMs()
  const pollMs = lockPollMs()
  const deadline = Date.now() + waitMs
  // Folder store harus ada sebelum kunci dibuat (kunci duduk di folder yang
  // sama). Best-effort: kalau gagal, open() di bawah yang melaporkan.
  await mkdir(join(storePath(), ".."), { recursive: true, mode: 0o700 }).catch(() => {})
  for (;;) {
    try {
      const fh = await open(path, "wx", 0o600)
      try {
        const payload: LockPayload = {
          v: LOCK_PAYLOAD_VERSION,
          pid: process.pid,
          token,
          ts: Date.now(),
          host,
          ns,
        }
        await fh.writeFile(JSON.stringify(payload), "utf8")
      } finally {
        await fh.close().catch(() => {})
      }
      // Sisa reclaim dari implementasi SEBELUMNYA (yang memakai jalur
      // rename+unlink) bisa tertinggal sebagai "<nama>.lock.stale.*". Sekarang
      // reclaim sudah dihapus, jadi tak ada lagi file baru seperti itu; sweep
      // ini hanya membersihkan sisa versi lama. Yang boleh dihapus HANYA
      // prefix PERSIS "<nama>.stale." — path kunci aktif tak pernah disentuh.
      await sweepStaleLockResidue(path)
      return {
        release: async () => {
          // Hanya lepas kalau file kunci masih milik kita. Kalau kita sudah
          // "dicuri" dan orang lain membuat ulang, unlink kita akan melepas
          // kunci orang itu. Payload tak terbaca = kunci sedang dibuat orang
          // lain (jendela sepersekian detik) ATAU file rusak → JANGAN unlink
          // (kehilangan mutual exclusion lebih buruk daripada kunci nyasar).
          const cur = await readLockPayload(path)
          if (!cur || cur.token !== token) return
          await unlink(path).catch(() => {})
        },
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code !== "EEXIST") return null // tak bisa mengunci → fail-closed
      // Kunci milik orang lain. TIDAK PERNAH diambil alih otomatis.
      //
      // Kenapa tidak: "baca payload → nilai → hapus path" adalah TOCTOU/ABA.
      // Antara baca dan hapus, path kunci bisa sudah menunjuk objek LAIN —
      // filepath kunci yang sama dibuat ulang oleh penulis lain yang hidup.
      // validate-and-remove pada nama path tidak bisa dibuktikan aman di
      // filesystem yang didukung: hanya ada open("wx") (atomik) untuk
      // membuat, sedangkan rename()/unlink() tidak punya syarat identitas
      // (tak ada flock/LockFileEx/renameat2/unlinkat-by-fd di Node/Bun).
      // Tanpa fencing, penulis yang tergeser tetap akan menulis store dan
      // menimpa credential milik penulis baru — kehilangan diam-diam, tepat
      // hal yang lock ini harus cegah.
      //
      // Jadi: tunggu sampai batas waktu, lalu fail-closed dengan pesan yang
      // menyebut path kunci dan memberi petunjuk pemulihan.
      if (Date.now() >= deadline) {
        await reportLockHeld(path, waitMs)
        return null
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }
}

/**
 * Pesan fail-closed saat kunci tak diperoleh: menyebut PATH KUNCI (bukan
 * nilai rahasia) + apakah pemiliknya tampaknya masih hidup + langkah pemulihan
 * yang bisa dikerjakan user.
 *
 * Yang dicetak HANYA: path (milik kita), pid (integer yang sudah divalidasi)
 * dan status "tampaknya tak berjalan". String bebas dari payload (host/ns)
 * TIDAK dicetak — file kunci bisa berisi apa saja bila attacker bisa menulis
 * ke home user, dan stderr tak boleh jadi vektor injeksi.
 */
async function reportLockHeld(path: string, waitMs: number): Promise<void> {
  const cur = await readLockPayload(path)
  const host = hostIdentity()
  const ns = pidNamespaceIdentity()
  let owner = "owner unknown"
  if (cur) {
    // Hanya pid integer yang dicetak; string bebas dari payload (host/ns)
    // tidak pernah ikut ke stderr.
    if (cur.host !== host || cur.ns !== ns || ns === "pidns:unknown")
      owner = `owner pid=${cur.pid} (another host or pid namespace — liveness not verifiable here)`
    else if (pidAbsent(cur.pid)) owner = `owner pid=${cur.pid} (appears not to be running)`
    else owner = `owner pid=${cur.pid} (still running)`
  }
  process.stderr.write(
    `[keystore] keystore is locked by another process (${path}); ${owner}; waited ${waitMs}ms and refused to write. ` +
      `If no other minicode process is running, delete that file and retry.\n`,
  )
}

/**
 * Sisa reclaim yang tertinggal. Hanya file dengan prefix PERSIS
 * "<nama-kunci>.stale." yang boleh dihapus; path kunci aktif dan berkas lain
 * di folder store tak pernah disentuh.
 */
async function sweepStaleLockResidue(path: string): Promise<void> {
  const dir = join(path, "..")
  const prefix = `${basename(path)}.stale.`
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    await unlink(join(dir, name)).catch(() => {})
  }
}

/**
 * Seam uji: bangun payload kunci yang sah (identitas host + namespace ikut
 * proses ini). Dipakai untuk menguji jalur reclaim (pemilik mati) dan varian
 * yang TAK dikenal (host/namespace berbeda, format lama, payload korup).
 */
export function __keystoreLockPayloadForTest(
  over: { pid?: number; token?: string; host?: string; ns?: string } = {},
): Record<string, unknown> {
  return {
    v: LOCK_PAYLOAD_VERSION,
    pid: over.pid ?? process.pid,
    token: over.token ?? randomUUID(),
    ts: Date.now(),
    host: over.host ?? hostIdentity(),
    ns: over.ns ?? pidNamespaceIdentity(),
  }
}

/**
 * Jalankan bagian kritis baca-modifikasi-tulis di bawah kunci. null = kunci
 * tak diperoleh dalam batas waktu → pemanggil harus fail-closed (tak menulis).
 */
async function withStoreLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const lock = await acquireStoreLock()
  if (!lock) {
    // acquireStoreLock sudah mencetak pesan pemulihan yang menyebut path kunci.
    return null
  }
  try {
    return await fn()
  } finally {
    await lock.release()
  }
}

interface SecretStore {
  version: 1
  entries: Record<string, { enc: string; alg: "dpapi" | "plain" }>
}

/**
 * Hasil baca store. Kegagalan baca TIDAK pernah disamakan dengan "store
 * kosong": dulu semua kegagalan (ENOENT, EACCES, EISDIR, JSON rusak) lanjut
 * sebagai `{entries:{}}`, sehingga setSecret menimpa store yang tak bisa
 * dibaca dan seluruh credential lama hilang permanen.
 */
type StoreLoad =
  | { ok: true; store: SecretStore }
  /** Store belum pernah dibuat (first use) — boleh dibuat. */
  | { ok: false; reason: "absent" }
  /** Store ada tapi tak bisa dibaca (EACCES, EISDIR, …). */
  | { ok: false; reason: "unreadable"; code: string }
  /** Store ada tapi isinya bukan bentuk store yang valid. */
  | { ok: false; reason: "corrupt" }

async function loadStore(): Promise<StoreLoad> {
  let raw: string
  try {
    raw = await readFile(storePath(), "utf8")
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    // ENOENT = belum ada → ini satu-satunya kondisi yang legitimately
    // berarti "store kosong". Error lain (EACCES/EISDIR/EPERM) berarti store
    // ADA tapi tak bisa dibaca — tidak boleh diasumsikan kosong.
    if (code === "ENOENT") return { ok: false, reason: "absent" }
    return { ok: false, reason: "unreadable", code: code ?? "error" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: "corrupt" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, reason: "corrupt" }
  const entries = (parsed as { entries?: unknown }).entries
  // Array lolos cek lama (`typeof [] === "object"`), lalu `entries[key] = …`
  // menempelkan properti non-indeks yang `JSON.stringify` BUANG → secret baru
  // hilang diam-diam padahal setSecret melaporkan sukses. Tolak array.
  if (!entries || typeof entries !== "object" || Array.isArray(entries))
    return { ok: false, reason: "corrupt" }
  return { ok: true, store: { version: 1, entries: entries as SecretStore["entries"] } }
}

/**
 * Baca saja (getSecret). Kontrak lama: "tak ada / tak bisa dibuka" → null.
 * Jalur ini tidak pernah menulis, jadi kegagalan load tak merusak apa pun.
 */
async function loadStoreForRead(): Promise<SecretStore> {
  const loaded = await loadStore()
  return loaded.ok ? loaded.store : { version: 1, entries: {} }
}

/**
 * Laporkan masalah store ke stderr. Hanya path + kode/penyebab — TIDAK
 * pernah nilai rahasia maupun cuplikan isi berkas (cuplikan JSON bisa
 * memuat secret dalam bentuk base64/teks).
 */
function reportStoreProblem(loaded: { reason: "corrupt" | "unreadable"; code?: string }): void {
  if (loaded.reason === "corrupt")
    process.stderr.write(
      `[keystore] store ${storePath()} is corrupt (invalid JSON) — refusing to write; repair or remove it manually\n`,
    )
  else
    process.stderr.write(
      `[keystore] cannot read store ${storePath()} (${loaded.code ?? "error"}) — refusing to write\n`,
    )
}

async function saveStore(store: SecretStore): Promise<void> {
  await mkdir(join(storePath(), ".."), { recursive: true, mode: 0o700 }).catch(() => {})
  const data = JSON.stringify(store)
  // Seam uji: penulis yang gagal mensimulasikan "tulis gagal" tanpa
  // bergantung pada permission/filesystem spesifik OS.
  if (writerOverride) {
    await writerOverride(storePath(), data)
    return
  }
  // Kegagalan tulis HARUS keluar ke pemanggil. Dulu error ditelan di sini,
  // sehingga setSecret melaporkan "sukses" + men-cache nilai padahal tak ada
  // yang tersimpan — user mengira API key aman, nyatanya hilang saat restart.
  await atomicWriteText(storePath(), data)
  await chmod(storePath(), 0o600).catch(() => {})
}

/** Tulis store. false = gagal (pesan dicetak, tanpa nilai rahasia). */
async function persistStore(store: SecretStore): Promise<boolean> {
  try {
    await saveStore(store)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    process.stderr.write(
      `[keystore] cannot write store ${storePath()} (${code ?? "error"}) — secret NOT stored\n`,
    )
    return false
  }
}

// DPAPI user-scope roundtrip via powershell bawaan (5.1 maupun 7.x).
// stdin: teks biasa (protect) / base64 blob (unprotect); stdout: hasilnya.
// Scope CurrentUser = hanya user Windows ini yang bisa membuka.
// `Add-Type System.Security` WAJIB eksplisit: assembly ProtectedData tidak
// di-load default oleh powershell (terbukti gagal tanpanya di Win 10/11).
const DPAPI_PRELUDE = "Add-Type -AssemblyName System.Security; "
const DPAPI_PROTECT = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  DPAPI_PRELUDE +
    "$t = [Console]::In.ReadToEnd(); " +
    "$b = [Text.Encoding]::UTF8.GetBytes($t); " +
    "$p = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser'); " +
    "[Convert]::ToBase64String($p)",
].join(" ")

const DPAPI_UNPROTECT = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  DPAPI_PRELUDE +
    "$t = [Console]::In.ReadToEnd(); " +
    "$p = [Convert]::FromBase64String($t.Trim()); " +
    "$b = [Security.Cryptography.ProtectedData]::Unprotect($p, $null, 'CurrentUser'); " +
    "[Text.Encoding]::UTF8.GetString($b)",
].join(" ")

function dpapiAvailable(): boolean {
  if (process.env.MINICODE_KEYSTORE_DISABLE === "1") return false
  if (process.platform !== "win32" && !process.env.MINICODE_KEYSTORE_FORCE_DPAPI) return false
  return true
}

function dpapiProtect(plaintext: string): string | null {
  const run = runnerOverride ?? defaultRunner
  const exe = process.platform === "win32" ? "powershell" : "pwsh"
  const r = run(exe, DPAPI_PROTECT.split(" ").filter(Boolean), plaintext)
  if (r.status !== 0) return null
  const out = r.stdout.trim()
  return out ? out : null
}

function dpapiUnprotect(blob: string): string | null {
  const run = runnerOverride ?? defaultRunner
  const shell = process.platform === "win32" ? "powershell" : "pwsh"
  const r = run(shell, DPAPI_UNPROTECT.split(" ").filter(Boolean), blob)
  if (r.status !== 0) return null
  // powershell mengakhiri output dengan newline — hanya itu yang dibuang,
  // isi secret utuh (bisa mengandung newline di tengah).
  return r.stdout.replace(/\r?\n$/, "")
}

/**
 * Simpan rahasia. Return backend yang dipakai ("dpapi"|"plain"), null bila
 * gagal total. null juga dipakai saat store tak bisa dibaca/di-parse:
 * menimpanya dengan store kosong = menghapus semua credential lama.
 *
 * Proteksi DPAPI dijalankan DI LUAR kunci: powershell bisa berjalan sampai
 * 15 detik dan tidak menyentuh store sama sekali — menahannya di dalam kunci
 * hanya memperlebar jendela di mana penulis lain menunggu (atau, pada
 * implementasi lama, salah dinilai "basi" lalu digeser). Kalau proteksi
 * gagal: tak ada yang ditulis dan cache tak disentuh.
 *
 * Seluruh baca-modifikasi-tulis dijalankan di bawah kunci store: dua
 * penulis konkuren (proses berbeda ATAU dua panggilan dalam satu proses)
 * tak boleh saling menimpa credential.
 */
export async function setSecret(key: string, value: string): Promise<"dpapi" | "plain" | null> {
  if (!key || !value) return null
  const useDpapi = dpapiAvailable()
  // Platform ber-DPAPI tapi proteksi GAGAL = jangan turun diam-diam ke
  // plaintext (user mengira secret-nya terproteksi OS). Tanpa backend
  // (non-Windows) = plain jujur berlabel.
  let blob: string | null = null
  if (useDpapi) {
    blob = dpapiProtect(value)
    if (!blob) return null
  }
  return await withStoreLock(async (): Promise<"dpapi" | "plain" | null> => {
    const loaded = await loadStore()
    let store: SecretStore
    if (loaded.ok) store = loaded.store
    else if (loaded.reason === "absent") store = { version: 1, entries: {} }
    else {
      // Fail-closed: store ada tapi tak bisa dibaca/di-parse. Menulis di sini
      // berarti menimpa store itu dengan isi baru — credential lama lenyap
      // tanpa jejak dan tanpa backup.
      reportStoreProblem(loaded)
      return null
    }
    if (useDpapi) {
      store.entries[key] = { enc: blob as string, alg: "dpapi" }
      if (!(await persistStore(store))) return null
      secretCache.set(key, value)
      return "dpapi"
    }
    store.entries[key] = { enc: value, alg: "plain" }
    if (!(await persistStore(store))) return null
    secretCache.set(key, value)
    return "plain"
  })
}

/** Baca rahasia. null = tak ada / tak bisa dibuka. Tak pernah melempar. */
export async function getSecret(key: string): Promise<string | null> {
  if (!key) return null
  if (secretCache.has(key)) return secretCache.get(key) ?? null
  let value: string | null = null
  try {
    const store = await loadStoreForRead()
    const entry = store.entries[key]
    if (entry) {
      if (entry.alg === "dpapi") {
        if (dpapiAvailable()) value = dpapiUnprotect(entry.enc)
      } else {
        value = entry.enc
      }
    }
  } catch {
    value = null
  }
  secretCache.set(key, value)
  return value
}

/**
 * Hapus rahasia.
 * - true  = key tidak ada lagi di store (dihapus, atau memang tak ada).
 * - false = store tak bisa dibaca/di-parse/tak bisa ditulis, ATAU kunci store
 *   tak diperoleh dalam batas waktu → TIDAK ADA yang berubah dan key masih
 *   ada di berkas (fail-closed).
 *
 * Cache tak disentuh saat gagal: dulu cache dihapus lebih dulu sehingga sesi
 * mengira key terhapus padahal berkasnya masih memegangnya.
 */
export async function deleteSecret(key: string): Promise<boolean> {
  // null = kunci tak diperoleh (fail-closed) → false, bukan "sukses semu".
  return (
    (await withStoreLock(async (): Promise<boolean> => {
      const loaded = await loadStore()
      let store: SecretStore
      if (loaded.ok) store = loaded.store
      else if (loaded.reason === "absent") store = { version: 1, entries: {} }
      else {
        // Fail-closed: jangan tulis apa pun, jangan pretend key terhapus.
        reportStoreProblem(loaded)
        return false
      }
      if (!store.entries[key]) {
        secretCache.delete(key)
        return true
      }
      delete store.entries[key]
      if (!(await persistStore(store))) return false
      secretCache.delete(key)
      return true
    })) === true
  )
}

/** Backend aktif untuk pesan/diagnostik (bukan rahasia). */
export function keystoreBackend(): "dpapi" | "plain-file" {
  return dpapiAvailable() ? "dpapi" : "plain-file"
}
