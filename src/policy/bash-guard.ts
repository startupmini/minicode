// Analisis perintah shell untuk keputusan permission.
//
// Kenapa modul terpisah? Denylist regex lama diterapkan ke string MENTAH,
// sehingga trivially dilewati oleh hal-hal yang shell anggap setara:
//
//   cat .e""nv          → shell membaca .env, regex melihat `.e""nv`
//   X=.env; cat $X      → shell membaca .env, regex tak pernah melihat ".env"
//   p=python3; $p -c 1  → interpreter jalan, regex tak melihat "python3 -c"
//   node --eval "1"     → sama dengan -e, tapi hanya `-e` yang di-regex
//
// Pendekatan di sini: NORMALISASI dulu (buang quote pemisah kata, substitusi
// assignment variabel sederhana), lalu periksa. Ini menutup seluruh kelas
// bypass, bukan satu-satu polanya.
//
// Batasan yang harus jujur: ini tetap analisis statis atas bahasa yang
// Turing-complete. Command substitution dinamis (`$(curl ...)`), aritmetika,
// dan indirection berlapis tak bisa diselesaikan tanpa mengeksekusi. Untuk
// isolasi sungguhan tetap perlu sandbox OS/container — modul ini menaikkan
// biaya serangan, bukan menghilangkannya.

import { isAbsolute, resolve } from "node:path"
import { isOwnedState, isRealPathOutsideRoot, isSensitive } from "./jail.ts"

export interface BashVerdict {
  /** true = tolak */
  denied: boolean
  /** alasan singkat untuk pesan ke model/user */
  reason?: string
}

// ── Normalisasi ──

/**
 * Buang quote yang dipakai untuk memecah kata tanpa mengubah arti bagi shell.
 * `.e""nv` → `.env`, `pyt"h"on3` → `python3`, `'.env'` → `.env`.
 *
 * Kita tidak mencoba meniru quoting shell sepenuhnya; tujuannya membuat
 * bentuk-terpecah dan bentuk-utuh menghasilkan string pemeriksaan yang sama.
 * Diekspor untuk test.
 */
export function stripQuotes(cmd: string): string {
  return cmd.replace(/["']/g, "")
}

/**
 * Substitusi assignment variabel sederhana dalam satu perintah.
 * `X=.env; cat $X` → `X=.env; cat .env`
 * `p=python3 && $p -c 1` → `p=python3 && python3 -c 1`
 *
 * Hanya nilai literal tanpa spasi/ekspansi yang disubstitusi — cukup untuk
 * menutup indirection yang dipakai untuk lolos filter, tanpa berpura-pura
 * mengevaluasi shell. Assignment di-scan ulang tiap lintasan agar rantai
 * (`a=.env; b=$a; cat $b`) juga terselesaikan. Diekspor untuk test.
 */
export function inlineSimpleVars(cmd: string): string {
  const ASSIGN = /(?:^|[;&|]\s*|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s;&|"'`$()]+)/g
  let out = cmd
  for (let pass = 0; pass < 3; pass++) {
    // scan ulang: substitusi lintasan sebelumnya bisa memunculkan
    // assignment literal baru (b=$a → b=.env)
    const vars = new Map<string, string>()
    ASSIGN.lastIndex = 0
    let m: RegExpExecArray | null = ASSIGN.exec(out)
    while (m !== null) {
      vars.set(m[1]!, m[2]!)
      m = ASSIGN.exec(out)
    }
    if (vars.size === 0) break
    let changed = false
    for (const [name, value] of vars) {
      const ref = new RegExp(`\\$\\{${name}\\}|\\$${name}\\b`, "g")
      const next = out.replace(ref, value)
      if (next !== out) {
        out = next
        changed = true
      }
    }
    if (!changed) break
  }
  return out
}

/**
 * Buang wrapper perintah yang tidak mengubah apa yang dijalankan.
 *
 * `command env`, `nice env`, `time env`, `exec env` semuanya menjalankan `env`,
 * tapi wrapper-nya menggeser posisi kata sehingga pola yang ter-anchor ke awal
 * perintah (mis. deteksi env-dump) tidak lagi cocok. Ditemukan oleh
 * experiments/extreme-bash-fuzz.ts: `command env` lolos sementara `env` ditolak.
 *
 * Wrapper dibuang berulang karena bisa berlapis (`time nice env`).
 * Diekspor untuk test.
 */
export function stripCommandWrappers(cmd: string): string {
  const WRAPPER =
    /(^|[;&|]\s*)(?:command|exec|builtin|eval|nice(?:\s+-n\s*-?\d+)?|nohup|time|timeout\s+[\d.]+[smhd]?|stdbuf(?:\s+-\S+)*|env(?=\s+[A-Za-z_][A-Za-z0-9_]*=)|setsid|ionice(?:\s+-\S+)*|xargs(?:\s+-\S+)*|sudo(?:\s+-\S+)*|doas)\s+/gi
  let out = cmd
  for (let pass = 0; pass < 4; pass++) {
    const next = out.replace(WRAPPER, "$1")
    if (next === out) break
    out = next
  }
  return out
}

/** Bentuk kanonik untuk pemeriksaan: quote dibuang + variabel disubstitusi. */
export function normalizeCommand(cmd: string): string {
  return stripCommandWrappers(inlineSimpleVars(stripQuotes(cmd)))
}

// ── Aturan ──

/** Path/berkas kredensial, dicek pada bentuk ternormalisasi. */
const SENSITIVE_TARGET =
  /(?:^|[\s/\\=@"'([:])(?:\.env(?:\.[\w.-]+)?|\.git-credentials|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|\.pem|\.p12|\.pfx|shadow|master\.key|config[/\\](?:sam|system|security|software|default)(?=[/\\]|$|[\s;"'&|])|ntds\.dit\b|hklm[/\\](?:sam|system|security)(?=[/\\]|$|[\s;"'&|]))\b/i

/** Direktori kredensial: ~/.ssh, $HOME/.aws, /etc/shadow, dst. */
const SENSITIVE_DIR = /(?:~|\$HOME|\$\{HOME\}|\/etc|\/root|\/proc\/self)[/\\](?:\.?[\w.-]+)/i

/** Export registry hive / salin shadow-copy — satu-satunya pemakaian di
 * konteks agen adalah eksfiltrasi hive terkunci (SAM butuh SYSTEM/VSS).
 * `reg query` diagnostik TIDAK kena (butuh kata kerja save|export). */
const REG_HIVE_EXPORT = /\breg(?:\.exe)?\s+(?:save|export)\b/i

/** Path hive dalam bentuk apa pun (file maupun key registry). Jaga sinkron
 * dengan cabang config[/\\]…|ntds|hklm di SENSITIVE_TARGET di atas. */
const HIVE_PATH =
  /config[/\\](?:sam|system|security|software|default)(?=[/\\]|$|[\s;"'&|])|ntds\.dit\b|hklm[/\\](?:sam|system|security)(?=[/\\]|$|[\s;"'&|])/i

/** Pembuatan/mount shadow copy + utilitas DS — di tangan agen hanya untuk
 * membaca hive terkunci (kasus nyata: `type ...\system32\config\sam`).
 * `vssadmin list` diagnostik tetap lolos (hanya create/delete yang ditahan). */
const VSS_SHADOW = /\bvssadmin\b[^\n]*\b(?:create\s+shadow|delete\s+shadows?)\b/i
const NTDSUTIL = /\bntdsutil\b/i

/** Perintah yang membaca/menyalin isi berkas. */
const READERS =
  /\b(?:cat|bat|less|more|head|tail|nl|od|xxd|strings|type|Get-Content|cp|copy|mv|move|scp|rsync|tar|zip|gzip|base64|openssl|awk|sed|grep|egrep|fgrep|rg|cut|sort|uniq|tee|dd|install)\b/i

/** Dump environment — `printenv` sudah lama diblok, sisanya belum. */
const ENV_DUMP =
  /(?:^|[;&|]\s*)(?:printenv|env|set|export\s+-p|declare\s+-[xp]|compgen\s+-v)\s*(?:$|[;&|]|\|)/i

/** Referensi eksplisit ke variabel env yang berbau kredensial. */
const ENV_SECRET_REF =
  /\$\{?[A-Z_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY)[A-Z_]*\}?/

/** Flag upload berkas pada klien HTTP — jalur exfiltrasi paling langsung. */
const UPLOAD_FLAG =
  /\b(?:curl|wget|http|httpie|nc|ncat|socat)\b[^\n]*(?:-F\s*\S*=@|--form\s*\S*=@|-d\s*@|--data(?:-binary|-raw)?\s*@|-T\s+|--upload-file|--post-file=|-b\s*@)/i

/** Interpreter dijalankan dengan kode inline (semua bentuk flag). */
const INLINE_INTERPRETER =
  /\b(?:pyw?|python[\d.]*|pypy[\d.]*|sh|bash|dash|zsh|ksh|node|deno|bun|perl|ruby|php|Rscript)(?:\.exe)?\b\s+(?:-\w*\s+)*(?:-c|-e|-E|--eval|--print|-p|--command|-r|--execute)\b/i

/** Process substitution / here-string yang memasukkan output perintah lain. */
const PROCESS_SUB = /<\s*\(|>\s*\(|<<<|\bsource\s+<|\.\s+<\(/

/** Pipe ke shell/interpreter — bentuk apa pun sumbernya. */
const PIPE_TO_SHELL =
  /\|\s*(?:sudo\s+)?(?:sh|bash|dash|zsh|ksh|python|python2|python3|pyw?|node|deno|bun|perl|ruby|php|iex|Invoke-Expression)(?:\.exe)?\b/i

/** Unduh ke berkas lalu jalankan berkas itu dalam satu baris. */
const DOWNLOAD_THEN_RUN =
  /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n]*?(?:-o|-O|--output|-OutFile)\s*(\S+)[^\n]*[;&|][^\n]*\b(?:sh|bash|dash|zsh|node|pyw?|python3?|perl|ruby|php|\.\/)(?:\.exe)?\b/i

/** Container escape: mount host root / privileged. */
const CONTAINER_ESCAPE =
  /\b(?:docker|podman|nerdctl)\b[^\n]*(?:--privileged|--pid[= ]host|--net(?:work)?[= ]host|-v\s*\/:|--volume\s*\/:|-v\s*\/etc|--cap-add[= ](?:ALL|SYS_ADMIN))/i

/**
 * Target redirect shell (`>`, `>>`, `<`) di luar quote. Heredoc `<<`/`<<-`
 * dilewati (kata berikutnya delimiter, bukan path); target fd (`>&2`, `&-`)
 * dilewati (bukan path). Diekspor untuk test.
 *
 * Kenapa scan RAW quote-aware, bukan bentuk ternormalisasi: stripQuotes
 * membuat `echo "a > b"` (aman — shell tak me-redirect isi quote) terlihat
 * persis seperti `echo a > b` (redirect nyata).
 */
export function findRedirectTargets(rawCmd: string): string[] {
  const out: string[] = []
  let sq = false
  let dq = false
  let i = 0
  const n = rawCmd.length
  const isTerm = (c: string): boolean => /[\s;|&<>()]/.test(c)
  while (i < n) {
    const c = rawCmd[i]!
    if (c === "\\" && i + 1 < n) {
      i += 2
      continue
    }
    if (c === "'" && !dq) {
      sq = !sq
      i++
      continue
    }
    if (c === '"' && !sq) {
      dq = !dq
      i++
      continue
    }
    if (sq || dq || (c !== ">" && c !== "<")) {
      i++
      continue
    }
    // Operator: serakah makan [<>|] (>, >>, >|, <>, <). `<<` = heredoc.
    let j = i
    let heredoc = false
    while (j < n && (rawCmd[j] === ">" || rawCmd[j] === "<" || rawCmd[j] === "|")) {
      j++
      if (j - i > 3) break
    }
    const op = rawCmd.slice(i, j)
    if (op.includes("<<")) heredoc = true
    // Lewati spasi, baca satu kata target.
    let k = j
    while (k < n && /\s/.test(rawCmd[k]!)) k++
    if (heredoc || (k < n && rawCmd[k] === "&")) {
      // Delimiter heredoc / target fd (`>&2`, `&-`): bukan path.
      while (k < n && !isTerm(rawCmd[k]!)) k++
      i = k
      continue
    }
    let e = k
    while (e < n && !isTerm(rawCmd[e]!)) e++
    if (e > k) out.push(rawCmd.slice(k, e))
    i = e
  }
  return out
}

/** Null sink lintas-OS — redirect ke sini selalu aman, jangan dihitung. */
function isNullSink(t: string): boolean {
  return t === "/dev/null" || t.toUpperCase() === "NUL"
}

/** Pencarian rekursif dari root filesystem. */
const ROOT_SCAN = /\b(?:find|fd|ls|dir|du|tree|grep|rg)\b[^\n]*\s\/(?:\s|$)/i

/**
 * `rm` rekursif dengan target berbahaya.
 *
 * Dipisah dari denylist lama yang menganggap SETIAP `/` berbahaya — itu
 * memblokir `rm -rf node_modules/.cache` yang sah. Yang berbahaya: target root,
 * home, parent traversal, atau wildcard telanjang.
 *
 * Bentuk flag panjang (`--recursive`) ikut dikenali: fuzz menemukan
 * `rm --recursive --force /` lolos karena pola lama hanya mencari `-[a-z]*r`.
 *
 * Traversal dicek di mana pun dalam argumen, bukan hanya di awal kata: target
 * bisa dibungkus command substitution (`rm -rf $(pwd)/../..`) yang tidak bisa
 * kita evaluasi, tapi `..` yang menaik tetap terlihat.
 */
const RM_RECURSIVE = /\brm\b[^\n]*(?:\s-[a-z]*[rR]|\s--recursive\b|\s--dir\b)/i
const RM_DANGEROUS_TARGET =
  /(?:\s\/(?:\s|$|\*|;|&)|\s~(?:[/\\]\s*)?(?:\s|$|;|&)|\$\{?HOME\}?|\.\.(?:[/\\]|\s|$|;|&)|\s\*\s*(?:$|;|&)|--no-preserve-root)/

const STATIC_DENY: [RegExp, string][] = [
  // Fork bomb: definisi fungsi rekursif yang memanggil dirinya lewat pipe.
  // Pola longgar (bukan hanya `:(){ :|:& };:` literal) karena nama fungsi bisa
  // apa saja dan spasi bebas — fuzz menemukan varian yang terpecah oleh
  // substitusi variabel masih lolos bentuk ketat. `\}` opsional karena
  // normalisasi bisa menghilangkan bagian setelah pipe.
  [/(?:^|[;&|=]\s*)[\w:]+\s*\(\)\s*\{[^}]*\|[^}]*&/, "fork bomb"],
  [/\bmkfs\b/i, "format filesystem"],
  [/\bdd\s+if=/i, "raw disk write"],
  [/\bchmod\s+(-R\s+)?777\b/i, "permission 777"],
  [/\bshred\b/i, "secure delete"],
  [/\btruncate\b/i, "truncate file"],
  [/\bmv\s+[^;|]*\s+\/(?:etc|boot|usr|lib)\b/i, "overwrite system dir"],
  [/\bsudo\b[^\n]*\brm\b/i, "sudo rm"],
  [/\bpowershell\b[^\n]*-EncodedCommand/i, "encoded powershell"],
  // Bentuk pendek -enc/-enco/... + blob base64 panjang. Aturan penuh di atas
  // tak menangkap prefix; pola ini mensyaratkan blob (60+ byte, hitung padding
  // `==`) sehingga -Encoding milik cmdlet dalam (-Command "... -Encoding
  // utf8 ...") lolos: -enc* + blob panjang praktis hanya payload terenkode.
  // -Command arbitrer tetap residual jujur (butuh sandbox OS/docker).
  [/\bpowershell(\.exe)?\b[^\n]*\s-e\w*\s+[A-Za-z0-9+/]{60,}={0,2}/i, "encoded powershell payload"],
  [/>\s*\/dev\/(?:sda|nvme|hd[a-z])/i, "raw device write"],
  [/\b(?:del|erase)\b[^\n]*\/[sfaq]/i, "windows recursive delete"],
  [/\brmdir\b[^\n]*\/s/i, "windows recursive rmdir"],
  [/\bRemove-Item\b[^\n]*-Recurse/i, "powershell recursive delete"],
  [/\[System\.IO\.File\]::ReadAllText/i, "powershell file read"],
  [/\b(?:Invoke-Expression|iex)\b/i, "powershell dynamic eval"],
  [/\bawk\b[^\n]*\bsystem\s*\(/i, "awk system()"],
  // git sebagai pelarian jail: `git diff --no-index A B` mencetak isi path
  // filesystem ARBITRER (di luar workspace, abaikan file-jail — terkonfirmasi
  // via inspectBashCommand, bukan teori); --exec-path/--upload-pack/
  // --receive-pack/ext:: mengeksekusi helper eksternal. Bentuk global
  // `git -c k=v <sub>` sebelum subcommand sudah gugur di allowlist (tak cocok
  // pola ^git <sub>), tapi mode auto hanya dijaga guard ini. Alur sah agen
  // (status/diff/log/branch/show dalam repo) tak memakai flag ini.
  [/\bgit\b[^\n]*?--(?:no-index|exec-path|upload-pack|receive-pack)\b/, "git dangerous flag"],
  [/\bext::/, "git ext transport"],
  // Injeksi konfigurasi git via environment (`GIT_EXTERNAL_DIFF=x git diff`
  // setara diff.external repo — repo-side adalah residual terdokumentasi, tapi
  // env datang dari perintah model sendiri sehingga ditahan di sini).
  [
    /\bGIT_(?:EXTERNAL_DIFF|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)\s*=/,
    "git config injection via env",
  ],
  [
    /(?:^|[;&|]\s*)(?:base64|xxd)[^\n]*\|\s*(?:sh|bash|python|python3|node|perl)\b/i,
    "decode|shell",
  ],
]

/**
 * Evaluasi satu perintah bash. Return alasan bila ditolak.
 *
 * Pemeriksaan dilakukan pada bentuk ternormalisasi DAN mentah: normalisasi
 * menutup bypass, sementara bentuk mentah menangkap pola yang justru hilang
 * saat quote dibuang (mis. `--upload-file "x"`).
 */
export function inspectBashCommand(rawCmd: string, cwd?: string): BashVerdict {
  const raw = rawCmd
  const norm = normalizeCommand(rawCmd)
  const both = (re: RegExp): boolean => re.test(norm) || re.test(raw)

  for (const [re, reason] of STATIC_DENY) {
    if (both(re)) return { denied: true, reason }
  }
  if (both(RM_RECURSIVE) && both(RM_DANGEROUS_TARGET)) {
    return { denied: true, reason: "destructive rm" }
  }
  if (both(PROCESS_SUB)) return { denied: true, reason: "process substitution" }
  if (both(PIPE_TO_SHELL)) return { denied: true, reason: "pipe to interpreter" }
  if (both(DOWNLOAD_THEN_RUN)) return { denied: true, reason: "download then execute" }
  if (both(INLINE_INTERPRETER)) return { denied: true, reason: "inline interpreter code" }
  if (both(CONTAINER_ESCAPE)) return { denied: true, reason: "container escape" }
  if (both(ENV_DUMP)) return { denied: true, reason: "environment dump" }
  if (both(ENV_SECRET_REF)) return { denied: true, reason: "credential env reference" }
  if (both(UPLOAD_FLAG)) return { denied: true, reason: "file upload to network" }
  // Hive Windows: `reg save HKLM\SAM` / `reg export ...\config\system` —
  // `reg query` diagnostik tetap lolos (tanpa kata kerja destruktif).
  if (both(REG_HIVE_EXPORT) && (HIVE_PATH.test(norm) || HIVE_PATH.test(raw)))
    return { denied: true, reason: "registry hive export" }
  if (both(VSS_SHADOW)) return { denied: true, reason: "shadow copy credential access" }
  if (both(NTDSUTIL)) return { denied: true, reason: "directory services tool" }
  if (both(ROOT_SCAN)) return { denied: true, reason: "filesystem-root scan" }

  // Redirect keluar workspace (temuan audit eksternal: `echo x > ..\evil`
  // lolos karena allowlist hanya menolak chaining `[;&|]` dan guard tak
  // punya aturan redirect). Target di-resolve terhadap cwd pemanggil agar
  // presisi (`> local.txt` dan `> /dev/null` tetap jalan); tanpa cwd,
  // heuristik konservatif (`..`/absolut/sensitif) berlaku.
  for (const t of findRedirectTargets(raw)) {
    if (isNullSink(t)) continue
    // Ekspansi %VAR% terjadi di cmd.exe SETELAH cek statis: `> "%TEMP%\x"`
    // terlihat di dalam cwd secara literal lalu menulis ke luar. Target dengan
    // pola %NAMA% tak bisa dipastikan aman → tolak; tulis ulang tanpa env var
    // atau pakai path relatif. `%` tunggal (mis. `100%.txt`) tetap lolos
    // karena bukan pola ekspansi.
    if (/%[^%\s]+%/.test(t))
      return { denied: true, reason: "redirect target with env expansion (%VAR%)" }
    if (cwd != null) {
      const abs = isAbsolute(t) ? resolve(t) : resolve(cwd, t)
      // Owned-state (.minicode/config dkk) simetris dengan jail file tools:
      // tulis lewat shell tak boleh lebih longgar dari write_file.
      if (
        isRealPathOutsideRoot(abs, cwd) ||
        isSensitive(t) ||
        isSensitive(abs) ||
        isOwnedState(t) ||
        isOwnedState(abs)
      )
        return { denied: true, reason: "redirect outside workspace" }
    } else if (
      /(^|[\\/])\.\.(?:[\\/]|$)|\b[a-zA-Z]:[\\/]|^\/(?!dev\/null$)|^~(?:[\\/]|$)/.test(t) ||
      isSensitive(t) ||
      isOwnedState(t)
    ) {
      return { denied: true, reason: "redirect outside workspace" }
    }
  }

  // Berkas sensitif: berbahaya bila dibaca/disalin ATAU dijadikan argumen
  // perintah jaringan. Menyebut `.env` dalam `echo` saja tidak diblokir.
  const touchesSensitive = both(SENSITIVE_TARGET) || both(SENSITIVE_DIR)
  if (touchesSensitive && (both(READERS) || /\b(?:curl|wget|nc|ncat|socat|scp)\b/i.test(norm))) {
    return { denied: true, reason: "sensitive file access" }
  }

  // P0-2: READER tanpa filter path (cat * / type *) = bisa baca file sensitif
  // atau di luar workspace walau cocok allowlist. Ekstrak argumen path untuk
  // READER dan cek jail/sensitive. Wildcard `*` ditolak bila cwd tersedia
  // (bisa mengembang ke .env / .minicode).
  if (both(READERS)) {
    const readerTargets = (() => {
      const out: string[] = []
      const re =
        /\b(?:cat|bat|less|more|head|tail|nl|od|xxd|strings|type|Get-Content|cp|copy|mv|move|scp|rsync|tar|zip|gzip|base64|openssl|awk|sed|grep|egrep|fgrep|rg|cut|sort|uniq|tee|dd|install)\b\s+([^\n;&|]+)/gi
      for (const m of norm.matchAll(re)) {
        const args = m[1]!.split(/\s+/)
        for (const a of args) {
          if (!a) continue
          if (a.startsWith("-")) continue
          const t = a.trim()
          if (!t) continue
          out.push(t)
        }
      }
      return out
    })()
    for (const t of readerTargets) {
      if (t.includes("*")) {
        // Wildcard di READER bisa mengembang ke .env/.minicode — tolak bila
        // cwd tersedia (butuh path eksplisit). Tanpa cwd, heuristik sensitif.
        if (cwd != null) return { denied: true, reason: "reader wildcard" }
        if (isSensitive(t) || isOwnedState(t)) return { denied: true, reason: "reader wildcard" }
      }
      if (isSensitive(t) || isSensitive(resolve(cwd ?? ".", t))) {
        return { denied: true, reason: "sensitive file access" }
      }
      if (isOwnedState(t) || isOwnedState(resolve(cwd ?? ".", t))) {
        return { denied: true, reason: "owned state access" }
      }
      if (cwd != null) {
        const abs = isAbsolute(t) ? resolve(t) : resolve(cwd, t)
        if (isRealPathOutsideRoot(abs, cwd)) return { denied: true, reason: "outside workspace" }
      } else if (/^\.\.(?:[\\/]|$)|\b[a-zA-Z]:[\\/]|^\/(?!dev\/null$)|^~(?:[\\/]|$)/.test(t)) {
        return { denied: true, reason: "outside workspace" }
      }
    }
  }

  return { denied: false }
}
