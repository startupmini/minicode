import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { LIMITS } from "../constants.ts"
import { GIT_NO_DIFF_DRIVERS, GIT_SAFE_BASE, gitFilterNeutralizers } from "../lib/git-hardening.ts"
import { sanitizeSessionPart } from "../lib/session-id.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"

// Checkpoint berbasis objek git ("shadow git").
//
// Pendekatan lama (`snapshotWorkspace`) menyalin ISI setiap file ke JSON
// manifest: O(ukuran workspace) per turn, di-cap 200 file, dan memuat
// `spawnSync git status` di jalur async. Untuk repo menengah saja manifestnya
// sudah puluhan MB dan cap-nya membuat undo tidak lengkap secara senyap.
//
// Di sini kita memakai object store git yang sudah ada:
//   1. index sementara (GIT_INDEX_FILE) → `git add -A` → `git write-tree`
//   2. tree di-pin dengan ref di namespace `refs/minicode/` supaya `gc` tidak
//      membuangnya
//   3. undo = diff dua tree, lalu pulihkan hanya path yang berubah
//
// Yang penting: index dan HEAD milik user TIDAK PERNAH disentuh. Tidak ada
// `git add`, `commit`, `checkout`, `reset`, atau `stash` pada state user. Ref
// menunjuk langsung ke *tree*, bukan commit, sehingga tidak muncul di
// `git log --all` maupun `git branch`.
//
// Batas yang harus jujur: `git add -A` menghormati `.gitignore`, jadi file yang
// di-ignore tidak ter-snapshot dan perubahan padanya tidak bisa di-undo. Itu
// disengaja — kita tidak ingin menyimpan `node_modules` atau `.minicode/*.db` —
// tapi berarti undo bukan "seluruh disk", melainkan "seluruh yang dilacak git".

export interface ShadowSnapshot {
  /** SHA tree git. */
  tree: string
  /** Nama ref yang mem-pin tree agar aman dari gc. */
  ref: string
}

export interface ShadowChange {
  /** A=added, M=modified, D=deleted, R=renamed (dari sudut pandang "sesudah"). */
  status: "A" | "M" | "D" | "R"
  path: string
  /** Untuk rename: path lama. */
  from?: string
}

const REF_NAMESPACE = "refs/minicode"

function git(
  args: string[],
  cwd: string,
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveOut) => {
    // `core.autocrlf=false` WAJIB: di Windows default-nya `true`, sehingga
    // checkout-index menerapkan smudge filter dan memulihkan file LF sebagai
    // CRLF — restore mengubah byte yang tidak diminta siapa pun. Terukur:
    // `a\nb\n` menjadi `a\r\nb\r\n`. Dengan flag ini LF tetap LF, CRLF tetap
    // CRLF, dan file biner utuh.
    // `core.safecrlf=false` mematikan peringatan yang menyertainya.
    // Audit #10 P0: GIT_SAFE_BASE mematikan hooks/fsmonitor/pager repo di
    // semua pemanggilan (bahkan read-only seperti status/diff menjalankan
    // fsmonitor repo tanpa ini).
    const hardened = [
      ...GIT_SAFE_BASE,
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      ...args,
    ]
    const p = spawn(resolveTrustedExecutable("git"), hardened, {
      cwd,
      // Env git dikendalikan penuh: GIT_INDEX_FILE mengarahkan operasi index ke
      // berkas sementara kita, dan GIT_OPTIONAL_LOCKS=0 mencegah git menulis
      // lock pada repo user hanya untuk membaca. Kredensial di-strip (audit
      // #10): filter/hook yang lolos hardening tak boleh memanen secret env.
      env: {
        ...sanitizeSpawnEnv(process.env),
        GIT_OPTIONAL_LOCKS: "0",
        ...(opts.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    p.stdout.on("data", (d: Buffer) => {
      if (stdout.length < 4_000_000) stdout += d.toString()
    })
    p.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 100_000) stderr += d.toString()
    })
    const timer = setTimeout(
      () => p.kill("SIGKILL"),
      opts.timeoutMs ?? LIMITS.SHADOW_GIT_TIMEOUT_MS,
    )
    p.on("error", () => {
      clearTimeout(timer)
      resolveOut({ code: -1, stdout: "", stderr: "git not available" })
    })
    p.on("close", (code) => {
      clearTimeout(timer)
      resolveOut({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Direktori `.git` (absolut) atau null bila bukan repo. */
export async function gitDir(cwd: string): Promise<string | null> {
  const r = await git(["rev-parse", "--absolute-git-dir"], cwd)
  if (r.code !== 0) return null
  const dir = r.stdout.trim()
  return dir || null
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await gitDir(cwd)) !== null
}

/**
 * Ambil snapshot state kerja saat ini sebagai tree git.
 *
 * `scope` membatasi ke subdirektori (`cwd` relatif terhadap toplevel repo) agar
 * menjalankan minicode di dalam subfolder tidak menarik seluruh monorepo.
 */
export async function snapshotTree(
  cwd: string,
  sessionId: string,
  label: string,
): Promise<ShadowSnapshot | null> {
  const dir = await gitDir(cwd)
  if (!dir) return null
  // Index sementara per-snapshot: unik agar dua sesi paralel tidak saling
  // menimpa, dan dibuang setelah dipakai. Nama disanitasi karena sessionId
  // datang dari `--session` dan bisa memuat karakter yang ilegal sebagai nama
  // berkas (mis. `:` atau `..` di Windows → git gagal membuat file .lock).
  const safeId = sanitizeRefPart(sessionId)
  const idx = join(dir, `minicode-idx-${safeId}-${Date.now()}-${randomUUID().slice(0, 6)}`)
  const env = { GIT_INDEX_FILE: idx }
  try {
    // Audit #10 P0: `git add` menjalankan clean filter repo (RCE tiap turn
    // di repo jahat!). Netralkan driver terkonfigurasi → cat (identitas
    // byte): snapshot butuh byte worktree apa adanya, bukan hasil konversi.
    // Index user tak tersentuh (temp), jadi semantik clean milik user aman.
    const neutral = await gitFilterNeutralizers(cwd)
    // `-- .` membatasi ke cwd; tanpa ini `add -A` memakai toplevel repo.
    // Flag -c harus sebelum subcommand: helper git() menaruh hardened base
    // di depan, neutral di sini tepat setelahnya, sebelum "add".
    const add = await git([...neutral, "add", "-A", "--", "."], cwd, { env })
    if (add.code !== 0) return null
    // Audit #10 P0: `git write-tree` MENERAPKAN ULANG clean filter pada
    // entri index (trace: run_command node setelah write-tree). Override
    // `-c filter.*.clean=cat` WAJIB ikut ke write-tree juga — bukan hanya add.
    const write = await git([...neutral, "write-tree"], cwd, { env })
    if (write.code !== 0) return null
    const tree = write.stdout.trim()
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return null

    // Pin tree dengan ref supaya `git gc` tidak membuang objectnya. Ref
    // menunjuk ke tree (bukan commit) sehingga tak pernah tampil di git log.
    const ref = `${REF_NAMESPACE}/${safeId}/${sanitizeRefPart(label)}-${tree.slice(0, 8)}`
    await git(["update-ref", ref, tree], cwd)
    return { tree, ref }
  } finally {
    await rm(idx, { force: true }).catch(() => {})
  }
}

/**
 * Nama aman untuk dipakai di ref git **dan** sebagai nama berkas.
 *
 * Dipakai untuk keduanya karena `sessionId` datang dari luar (`--session`) dan
 * pernah membuat operasi gagal total: `sess/../..~weird:id` menghasilkan path
 * index `\.git\..~weird:id-...` yang ditolak Windows (`Invalid argument`), dan
 * `..`/`~`/`:` juga ilegal di nama ref.
 *
 * F-17: delegasi ke sanitizer bersama (lib/session-id.ts) — dulu varian lokal
 * dengan pemetaan `..` berbeda dari checkpoint/journal.
 */
function sanitizeRefPart(s: string): string {
  return sanitizeSessionPart(s)
}

/** Perubahan antara dua tree, dibatasi ke path di dalam workspace. */
export async function diffTrees(cwd: string, from: string, to: string): Promise<ShadowChange[]> {
  // --no-ext-diff/--no-textconv: diff tak menjalankan driver konten repo.
  // (Flag diff harus sebelum revisi `from`/`to`, bukan di ekor.)
  const r = await git(
    ["diff", ...GIT_NO_DIFF_DRIVERS, "--name-status", "-z", "--find-renames", from, to],
    cwd,
  )
  if (r.code !== 0) return []
  const parts = r.stdout.split("\0").filter((s) => s.length > 0)
  const out: ShadowChange[] = []
  for (let i = 0; i < parts.length; ) {
    const raw = parts[i]!
    const code = raw[0] as string
    if (code === "R") {
      // rename: status, old, new
      const oldPath = parts[i + 1]
      const newPath = parts[i + 2]
      i += 3
      if (oldPath && newPath) out.push({ status: "R", path: newPath, from: oldPath })
      continue
    }
    const p = parts[i + 1]
    i += 2
    if (!p) continue
    if (code === "A" || code === "M" || code === "D") out.push({ status: code, path: p })
  }
  return out
}

/** Snapshot "sekarang" tanpa mem-pin ref — untuk membandingkan saja. */
export async function ephemeralTree(cwd: string): Promise<string | null> {
  const dir = await gitDir(cwd)
  if (!dir) return null
  const idx = join(dir, `minicode-cmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const env = { GIT_INDEX_FILE: idx }
  try {
    // Netralisasi sama seperti snapshotTree (lihat di atas): write-tree juga
    // menerapkan ulang clean filter — override wajib ikut ke kedua subcommand.
    const neutral = await gitFilterNeutralizers(cwd)
    if ((await git([...neutral, "add", "-A", "--", "."], cwd, { env })).code !== 0) return null
    const w = await git([...neutral, "write-tree"], cwd, { env })
    if (w.code !== 0) return null
    const tree = w.stdout.trim()
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : null
  } finally {
    await rm(idx, { force: true }).catch(() => {})
  }
}

export interface RestoreResult {
  applied: string[]
  skipped: string[]
}

/**
 * Pulihkan workspace ke `tree`, menyentuh HANYA path yang berbeda dari kondisi
 * sekarang. File yang muncul setelah snapshot dihapus; yang berubah/terhapus
 * ditulis ulang dari object store.
 *
 * Semua path dijail: apa pun yang keluar dari `cwd` dilewati dan dilaporkan.
 * Ini penting karena diff tree bisa memuat path dari toplevel repo bila
 * snapshot diambil dengan scope berbeda.
 */
export async function restoreTree(cwd: string, tree: string): Promise<RestoreResult> {
  const root = resolve(cwd)
  const applied: string[] = []
  const skipped: string[] = []

  const now = await ephemeralTree(cwd)
  if (!now) return { applied, skipped: ["(failed to read current state)"] }
  if (now === tree) return { applied, skipped: [] } // sudah identik

  const changes = await diffTrees(cwd, tree, now)
  if (changes.length === 0) return { applied, skipped: [] }

  const inside = (p: string): boolean => {
    const abs = resolve(root, p)
    return abs === root || abs.startsWith(root + (process.platform === "win32" ? "\\" : "/"))
  }

  // Path yang harus DIAMBIL dari tree lama (berubah di tree lama → sekarang
  // sebagai M, atau hilang sekarang sebagai D dari sudut pandang diff).
  const toCheckout: string[] = []
  // Path yang tidak ada di tree lama (A) → harus dihapus.
  const toDelete: string[] = []

  for (const c of changes) {
    if (!inside(c.path)) {
      skipped.push(`${c.path} (di luar workspace)`)
      continue
    }
    if (c.status === "A") toDelete.push(c.path)
    else if (c.status === "M" || c.status === "D") toCheckout.push(c.path)
    else if (c.status === "R") {
      // rename: nama baru dihapus, nama lama dipulihkan
      toDelete.push(c.path)
      if (c.from && inside(c.from)) toCheckout.push(c.from)
    }
  }

  if (toCheckout.length > 0) {
    const dir = await gitDir(cwd)
    if (!dir) return { applied, skipped: ["(not a git repository)"] }
    const idx = join(dir, `minicode-restore-${Date.now()}-${randomUUID().slice(0, 6)}`)
    const env = { GIT_INDEX_FILE: idx }
    try {
      const rt = await git(["read-tree", tree], cwd, { env })
      if (rt.code !== 0) {
        skipped.push(`(read-tree failed: ${rt.stderr.trim().slice(0, 120)})`)
      } else {
        // checkout-index per batch: daftar path bisa panjang, dan Windows
        // punya batas panjang command line. Netralisasi smudge (audit #10):
        // restore wajib byte-exact + tanpa eksekusi filter repo. Pasangan -c
        // WAJIB sebelum subcommand (git berhenti parsing global di sana).
        const neutral = await gitFilterNeutralizers(cwd)
        for (let i = 0; i < toCheckout.length; i += LIMITS.SHADOW_GIT_PATH_BATCH) {
          const batch = toCheckout.slice(i, i + LIMITS.SHADOW_GIT_PATH_BATCH)
          const co = await git([...neutral, "checkout-index", "-f", "--", ...batch], cwd, { env })
          if (co.code === 0) applied.push(...batch.map((p) => `${p} (restored)`))
          else skipped.push(...batch.map((p) => `${p} (checkout failed)`))
        }
      }
    } finally {
      await rm(idx, { force: true }).catch(() => {})
    }
  }

  for (const p of toDelete) {
    await rm(resolve(root, p), { force: true, recursive: false }).catch(() => {})
    applied.push(`${p} (removed)`)
  }

  return { applied, skipped }
}

/** Hapus semua ref shadow untuk satu sesi (dipanggil saat purge). */
export async function pruneSessionRefs(cwd: string, sessionId: string): Promise<number> {
  const prefix = `${REF_NAMESPACE}/${sanitizeRefPart(sessionId)}/`
  const r = await git(["for-each-ref", "--format=%(refname)", prefix], cwd)
  if (r.code !== 0) return 0
  const refs = r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
  let n = 0
  for (const ref of refs) {
    if ((await git(["update-ref", "-d", ref], cwd)).code === 0) n++
  }
  return n
}

/** Semua ref shadow (untuk diagnostik / `minicode sessions`). */
export async function listShadowRefs(cwd: string): Promise<{ ref: string; tree: string }[]> {
  const r = await git(["for-each-ref", "--format=%(refname) %(objectname)", REF_NAMESPACE], cwd)
  if (r.code !== 0) return []
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [ref, tree] = l.split(" ")
      return { ref: ref ?? "", tree: tree ?? "" }
    })
    .filter((x) => x.ref && x.tree)
}
