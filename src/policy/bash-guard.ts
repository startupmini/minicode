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
 * Lepas escape caret command-line cmd.exe: `^` di luar kutip ganda
 * menghilangkan dirinya dan membuat karakter berikutnya harfiah.
 *
 *   type .e^nv   → cmd.exe membuka `.env` (guard membaca `.e^nv`)
 *   ty^pe .env   → cmd.exe menjalankan `type` (READERS tak pernah cocok)
 *   echo x > .e^nv → menulis `.env` (target redirect tak terlihat sensitif)
 *
 * Mengapa wajib: SELURUH aturan berkas di modul ini (SENSITIVE_TARGET,
 * SENSITIVE_DIR, isSensitive/isOwnedState, cek jail) mencocokkan nama
 * LITERAL, jadi satu caret memindahkan perintah dari "ditahan" ke "lolos" —
 * kelas yang sama dengan `.e""nv` yang jadi alasan modul ini ada. Temuan F1
 * audit 2026-09-20: `type .e^nv` ALLOW padahal `type .env` DENY.
 *
 * Quote-aware karena cmd.exe TIDAK memproses caret di dalam kutip ganda:
 * melepas buta akan mengubah arti `echo "a^b"` (aman) menjadi `echo "ab"`.
 * `^^` → `^` benar dengan sendirinya (caret pertama meng-escape yang kedua).
 *
 * Backtick PowerShell SENGAJA tidak diperlakukan sama: di sana backtick
 * sebelum huruf adalah escape KONTROL (`n`=newline, `t`=tab), sehingga
 * `.e\`nv` bukan `.env` melainkan dua baris — melepasnya akan memblokir
 * perintah sah (over-block) tanpa menutup jalur serangan nyata, karena
 * membaca `.env` di PowerShell tidak butuh escape sama sekali.
 *
 * Diekspor untuk test.
 */
export function stripCaretEscapes(cmd: string): string {
  let out = ""
  let inDouble = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (ch === '"') inDouble = !inDouble
    if (ch === "^" && !inDouble && i + 1 < cmd.length) {
      out += cmd[++i]!
      continue
    }
    out += ch
  }
  return out
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
  // Wrapper privilese/konteks (audit 2026-09-16 B2): `su -c 'env'`,
  // `runuser -u x -- printenv`, `cmd /c set` menyembunyikan perintah
  // sebenarnya dari aturan konten yang ter-anchor ke awal (ENV_DUMP dkk).
  // Dibuang BESERTA flag/argumen konteksnya (user/host/path, introducer
  // -c/--//c) sehingga perintah DALAM dievaluasi aturan biasa — `su -c
  // 'cat /etc/shadow'` tetap kena SENSITIVE_TARGET. Jangkar awal mencegah
  // strip di tengah perintah (`echo su -c env` tak tersentuh).
  const WRAPPER_SHELL =
    /(^|[;&|]\s*)(?:(?:su|runuser|gosu|chroot|nsenter)(?:\s+(?:-[^\s;|]+|--[^\s;|]*|\/[^\s;|]*|[^-;\s|/][^;\s|]*))*\s+|cmd(?:\.exe)?(?:\s+\/[a-zA-Z]+)*\s+\/c\s+)/gi
  let out = cmd
  for (let pass = 0; pass < 4; pass++) {
    const next = out.replace(WRAPPER, "$1").replace(WRAPPER_SHELL, "$1")
    if (next === out) break
    out = next
  }
  return out
}

/**
 * Bentuk kanonik untuk pemeriksaan: escape caret dilepas, quote dibuang,
 * variabel disubstitusi, wrapper perintah dibuang.
 *
 * Urutan penting: `stripCaretEscapes` berjalan SEBELUM quote dibuang karena
 * ia butuh melihat kutip ganda asli untuk tahu apakah caret harfiah.
 */
export function normalizeCommand(cmd: string): string {
  return stripCommandWrappers(inlineSimpleVars(stripQuotes(stripCaretEscapes(cmd))))
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

/** Perintah yang membaca/menyalin/menulis isi berkas. Daftar ini + ekstraktor argumen
 * di inspectBashCommand WAJIB sinkron (audit 2026-09-16 B4: certutil/tac/
 * findstr lolos karena hanya ada di satu sisi; bug-hunt 2026-09-19 F1:
 * Out-File/Set-Content/xcopy/robocopy/Copy-Item lolos karena tak ada di
 * dua sisi). Pembaca yang BUKAN utilitas — `for /f` (loop bawaan cmd.exe) —
 * diekstrak terpisah di blok `forFileSets`; menambah pembaca baru berarti
 * menyentuh salah satu dari keduanya. Denylist takkan pernah komplet
 * (residual arsitektural, lihat kepala berkas) — tiap entri di sini adalah
 * kasus konkret terverifikasi, bukan tebakan. */
const READERS =
  /\b(?:cat|bat|less|more|head|tail|nl|od|xxd|strings|type|Get-Content|certutil|tac|findstr|fc|comp|cp|copy|mv|move|scp|rsync|tar|zip|gzip|base64|openssl|awk|sed|grep|egrep|fgrep|rg|cut|sort|uniq|tee|dd|install|xcopy|robocopy|Out-File|Set-Content|Add-Content|New-Item|Copy-Item|Move-Item)\b/i

/** Dump environment — `printenv` sudah lama diblok, sisanya belum. */
const ENV_DUMP =
  // F-20: `\n` adalah pemisah perintah setara `;` — tanpa ini `echo hi\nenv`
  // lolos (anchor lama hanya [;&|]). Berlaku untuk semua aturan ber-anchor
  // awal-perintah di berkas ini.
  /(?:^|[;&|\n]\s*)(?:printenv|env|set|export\s+-p|declare\s+-[xp]|compgen\s+-v)\s*(?:$|[;&|\n]|\|)/i

/** Referensi eksplisit ke variabel env yang berbau kredensial. */
const ENV_SECRET_REF =
  /\$\{?[A-Z_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY)[A-Z_]*\}?/

/** Flag upload berkas pada klien HTTP — jalur exfiltrasi paling langsung. */
const UPLOAD_FLAG =
  /\b(?:curl|wget|http|httpie|nc|ncat|socat)\b[^\n]*(?:-F\s*\S*=@|--form\s*\S*=@|-d\s*@|--data(?:-binary|-raw)?\s*@|-T\s+|--upload-file|--post-file=|-b\s*@)/i

/** Upload DATA dari variabel bare (`-d $X`, bukan `@file` yang sudah ditahan
 * UPLOAD_FLAG): bentuk exfiltrasi terakhir yang lolos — nama var arbitrer
 * (mis. $TH_NGODING) tak cocok ENV_SECRET_REF dan tak butuh file sensitif
 * literal. Literal `-d '{"a":1}'` tetap lolos (payload terlihat di review).
 * Divalidasi e2e: canary odd-name terkirim ke listener loopback (bug-hunt
 * 2026-09-19 F3). */
const VAR_UPLOAD =
  /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n]*(?:-d|--data(?:-binary|-raw-data|-urlencode)?|--body)\s+["']?[^;&|\n]*[$%][\w{(]/i

/** Konfigurasi git berbahaya via `-c key=val`: eksekusi kode (pager/hook/
 * helper) atau repo-confusion. Kunci jinak (`-c core.quotepath=false`) tetap
 * lolos — hanya kunci eksekusi + helper eksternal yang ditahan. Divalidasi:
 * `core.fsmonitor` mengeksekusi pipe-independent (bug-hunt 2026-09-19 F2);
 * `core.pager` mati-di-pipe pada git-windows (negatif terdokumentasi). */
const GIT_DANGEROUS_CONFIG =
  /-c\s+["']?(?:core\.(?:pager|fsmonitor|sshCommand|askpass|editor)|protocol\.ext\.allow|core\.hooksPath)\s*=/i

/** git keluar workspace: `-C dir` / `--git-dir=` / `--work-tree=` menunjuk
 * repo/pohon lain (baca objek repo korban = jail-bypass READ, validasi e2e
 * bug-hunt 2026-09-19 F2: `--git-dir=victim/.git log -p` bocor isi repo lain).
 * Nilai dicek di bawah terhadap cwd (resolve+outside/sensitive/owned). */
const GIT_DIR_OVERRIDE = /(?:^|\s)(?:-C|--git-dir=|--work-tree=)\s*(\S+)/i

/** Env git eksekusi (`GIT_PAGER=id ...`, `GIT_SSH=...`): efek sama dengan
 * `-c` di atas, lewat assignment env. */
const GIT_EXEC_ENV = /(?:^|[;&|\n]\s*)GIT_(?:PAGER|SSH|ASKPASS|EDITOR)\s*=/i

/** Interpreter dijalankan dengan kode inline (semua bentuk flag). */
const INLINE_INTERPRETER =
  /\b(?:pyw?|python[\d.]*|pypy[\d.]*|sh|bash|dash|zsh|ksh|node|deno|bun|perl|ruby|php|Rscript)(?:\.exe)?\b\s+(?:-\w*\s+)*(?:-c|-e|-E|--eval|--print|-p|--command|-r|--execute)\b/i
// Residual jujur (audit 2026-09-16 B3): eksekusi via stdin/redirect TANPA
// flag inline (`bash -s < skrip`, `python3 < prog`, `... | python3 -`) tidak
// ditahan — menahan `| python3 -` mematahkan pipeline sah, dan `bash berkas`
// telanjang memang diizinkan (skrip workspace dieksekusi setara user
// menjalankannya; penanaman skrip dijaga permission write). Isolasi penuh
// tetap tugas sandbox OS/docker, bukan analisis statis.

/** Process substitution / here-string yang memasukkan output perintah lain. */
const PROCESS_SUB = /<\s*\(|>\s*\(|<<<|\bsource\s+<|\.\s+<\(/

/** Pipe ke shell/interpreter — bentuk apa pun sumbernya. */
const PIPE_TO_SHELL =
  /\|\s*(?:sudo\s+)?(?:sh|bash|dash|zsh|ksh|python|python2|python3|pyw?|node|deno|bun|perl|ruby|php|iex|Invoke-Expression)(?:\.exe)?\b/i

/** Unduh ke berkas lalu jalankan berkas itu dalam satu baris. Catatan pola:
 * - `certutil -urlcache` ikut (downloader Windows di luar curl/wget/iwr).
 * - `\./` tanpa `\b` (bug-hunt 2026-09-19: `\b` sebelum `.` tak pernah cocok
 *   setelah spasi — alternatif `./` mati total, `IWR ...; ./a.ps1` lolos). */
const DOWNLOAD_THEN_RUN =
  /\b(?:curl|wget|Invoke-WebRequest|iwr|certutil)\b[^\n]*?(?:-o|-O|--output|-OutFile|-urlcache)\s*(\S+)[^\n]*[;&|][^\n]*(?:\b(?:sh|bash|dash|zsh|node|pyw?|python3?|perl|ruby|php)(?:\.exe)?\b|\.\/)/i

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
 *
 * Target `//` dan `/.X` ikut berbahaya (audit 2026-09-16 B5): slash ganda
 * collapse ke root di POSIX (`rm -rf //` ≡ `rm -rf /`), dan `/.[!.]*` dengan
 * -r menghapus isi dotfile root.
 */
const RM_RECURSIVE = /\brm\b[^\n]*(?:\s-[a-z]*[rR]|\s--recursive\b|\s--dir\b)/i
const RM_DANGEROUS_TARGET =
  /(?:\s\/(?:\s|$|\*|;|&|\/|\.)|\s~(?:[/\\]\s*)?(?:\s|$|;|&)|\$\{?HOME\}?|\.\.(?:[/\\]|\s|$|;|&)|\s\*\s*(?:$|;|&)|--no-preserve-root)/

const STATIC_DENY: [RegExp, string][] = [
  // Fork bomb: definisi fungsi rekursif yang memanggil dirinya lewat pipe.
  // Pola longgar (bukan hanya `:(){ :|:& };:` literal) karena nama fungsi bisa
  // apa saja dan spasi bebas — fuzz menemukan varian yang terpecah oleh
  // substitusi variabel masih lolos bentuk ketat. `\}` opsional karena
  // normalisasi bisa menghilangkan bagian setelah pipe.
  [/(?:^|[;&|=\n]\s*)[\w:]+\s*\(\)\s*\{[^}]*\|[^}]*&/, "fork bomb"],
  [/\bmkfs\b/i, "format filesystem"],
  [/\bdd\s+if=/i, "raw disk write"],
  [/\bchmod\s+(-R\s+)?777\b/i, "permission 777"],
  [/\bshred\b/i, "secure delete"],
  [/\btruncate\b/i, "truncate file"],
  [/\bmv\s+[^;|]*\s+\/(?:etc|boot|usr|lib)\b/i, "overwrite system dir"],
  [/\bsudo\b[^\n]*\brm\b/i, "sudo rm"],
  // `pwsh`/`pwsh.exe` = nama biner PowerShell modern lintas-OS (audit
  // 2026-09-16: varian encoded lolos karena aturan hanya kenal `powershell`).
  [/\b(?:powershell|pwsh)\b[^\n]*-EncodedCommand/i, "encoded powershell"],
  // Bentuk pendek -enc/-enco/... + blob base64 panjang. Aturan penuh di atas
  // tak menangkap prefix; pola ini mensyaratkan blob (60+ byte, hitung padding
  // `==`) sehingga -Encoding milik cmdlet dalam (-Command "... -Encoding
  // utf8 ...") lolos: -enc* + blob panjang praktis hanya payload terenkode.
  // -Command arbitrer tetap residual jujur (butuh sandbox OS/docker).
  [
    /\b(?:powershell|pwsh)(\.exe)?\b[^\n]*\s-e\w*\s+[A-Za-z0-9+/]{60,}={0,2}/i,
    "encoded powershell payload",
  ],
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
    /(?:^|[;&|\n]\s*)(?:base64|xxd)[^\n]*\|\s*(?:sh|bash|python|python3|node|perl)\b/i,
    "decode|shell",
  ],
  // F-20: upload berkas via PowerShell — UPLOAD_FLAG hanya kenal
  // curl/wget/nc. Bentuk eksfiltrasi: Invoke-WebRequest -Method POST -Body
  // (Get-Content rahasia) atau -InFile <berkas>. Download polos (-OutFile)
  // TETAP lolos (seperti curl tanpa -d @file): bukan upload.
  [/\b(?:Invoke-WebRequest|iwr)\b[^\n]*?(?:-InFile\b|Get-Content)/i, "file upload to network"],
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
  if (both(VAR_UPLOAD)) return { denied: true, reason: "variable data upload to network" }
  if (both(GIT_DANGEROUS_CONFIG)) return { denied: true, reason: "git exec config override" }
  if (both(GIT_EXEC_ENV)) return { denied: true, reason: "git exec env override" }
  // -C/--git-dir/--work-tree: resolve nilai terhadap cwd seperti redirect —
  // di luar workspace/sensitif/owned = deny (baca repo lain = jail-bypass).
  {
    const m = norm.match(GIT_DIR_OVERRIDE) ?? raw.match(GIT_DIR_OVERRIDE)
    if (m?.[1]) {
      const t = m[1]!.replace(/^["']|["']$/g, "")
      if (cwd != null) {
        const abs = isAbsolute(t) ? resolve(t) : resolve(cwd, t)
        if (
          isRealPathOutsideRoot(abs, cwd) ||
          isSensitive(t) ||
          isSensitive(abs) ||
          isOwnedState(t) ||
          isOwnedState(abs)
        )
          return { denied: true, reason: "git directory outside workspace" }
      } else if (/^\.\.(?:[\\/]|$)|\b[a-zA-Z]:[\\/]|^\/(?!dev\/null$)|^~(?:[\\/]|$)/.test(t)) {
        return { denied: true, reason: "git directory outside workspace" }
      }
    }
  }
  // Hive Windows: `reg save HKLM\SAM` / `reg export ...\config\system` —
  // `reg query` diagnostik tetap lolos (tanpa kata kerja destruktif).
  if (both(REG_HIVE_EXPORT) && (HIVE_PATH.test(norm) || HIVE_PATH.test(raw)))
    return { denied: true, reason: "registry hive export" }
  if (both(VSS_SHADOW)) return { denied: true, reason: "shadow copy credential access" }
  if (both(NTDSUTIL)) return { denied: true, reason: "directory services tool" }
  if (both(ROOT_SCAN)) return { denied: true, reason: "filesystem-root scan" }

  // Pembuatan link (symlink/junction/hardlink) yang operannya sensitif /
  // owned-state: link internal ke `.minicode/` dipakai menembus kunci
  // owned-state tool tulis (temuan audit 2026-09-22 F-CRIT — `ln -s .minicode
  // linkdir` + `write_file linkdir/config.json` lolos karena cek owned-state
  // membaca string argumen, bukan target nyata; pola yang sama menembus
  // perlindungan berkas sensitif). Kunci UTAMA ada di lapisan permission
  // (isOwnedStateReal — realpath); blok ini lapisan kedua di sisi shell.
  //
  // Urutan argumen BEDA antar tool — `ln`: TARGET LINK; `mklink`/`fsutil`:
  // LINK dulu; `New-Item`: parameter bernama (urutan bebas, `-Target` alias
  // `-Value`). Alih-alih mempercayai posisi, SEMUA operand non-flag dicek:
  // link yang kebetulan DINAMAI seperti path sensitif/owned sama
  // mencurigakannya (shadowing), jadi tanpa false positive berarti. Ini
  // sekaligus menutup reshuffle flag (`ln --symbolic`, `ln -s --`, fsutil
  // terbalik) yang lolos dari pencocokan posisi.
  {
    const denyLinkOperand = (op: string | undefined): BashVerdict | null => {
      if (!op) return null
      const t = op.replace(/^["']+|["']+$/g, "")
      if (!t || t.startsWith("-")) return null // flag / `--`, bukan path
      if (isSensitive(t) || isSensitive(resolve(cwd ?? ".", t))) {
        return { denied: true, reason: "link to sensitive file" }
      }
      if (isOwnedState(t) || isOwnedState(resolve(cwd ?? ".", t))) {
        return { denied: true, reason: "link to owned state" }
      }
      return null
    }
    // `&`/`<`/`>` mengakhiri segmen operand. Switch cmd `/D` `/J` `/H`
    // dilewati eksplisit agar path yang kebetulan berawalan `/` tak hilang.
    const LINK_CMD =
      /(?:^|[;&|\n]\s*)(?:sudo\s+)?(?:ln|mklink|fsutil\s+hardlink\s+create)\s+([^\n;|&<>]+)/gi
    const linkSegs = [...norm.matchAll(LINK_CMD)]
    if (linkSegs.length === 0) linkSegs.push(...raw.matchAll(LINK_CMD))
    for (const m of linkSegs) {
      for (const tok of m[1]!.trim().split(/\s+/)) {
        if (/^\/[djh]$/i.test(tok)) continue
        const v = denyLinkOperand(tok)
        if (v) return v
      }
    }
    // New-Item bentuk nilai-menempel (`-Target:.minicode`): token berawalan
    // `-` luput dari ekstraksi target READER di bawah (bentuk spasi sudah
    // ditahan di sana — New-Item ∈ READERS). `-Target` alias `-Value`.
    const NI_CMD = /(?:^|[;&|\n]\s*)New-Item\b([^\n;|]*)/gi
    const niSegs = [...norm.matchAll(NI_CMD)]
    if (niSegs.length === 0) niSegs.push(...raw.matchAll(NI_CMD))
    for (const m of niSegs) {
      const args = m[1]!
      if (!/-ItemType:?\s*"?(?:SymbolicLink|HardLink|Junction)"?(?:\s|$)/i.test(args)) continue
      for (const pm of args.matchAll(/-(?:Path|Target|Value):(\S+)/gi)) {
        const v = denyLinkOperand(pm[1])
        if (v) return v
      }
    }
  }

  // Redirect keluar workspace (temuan audit eksternal: `echo x > ..\evil`
  // lolos karena allowlist hanya menolak chaining `[;&|]` dan guard tak
  // punya aturan redirect). Target di-resolve terhadap cwd pemanggil agar
  // presisi (`> local.txt` dan `> /dev/null` tetap jalan); tanpa cwd,
  // heuristik konservatif (`..`/absolut/sensitif) berlaku.
  for (const tRaw of findRedirectTargets(raw)) {
    // cmd.exe melepas caret SEBELUM membuka berkas: `echo x > .e^nv` menulis
    // `.env`, jadi target diperiksa dalam bentuk kanoniknya, bukan mentah
    // (temuan F1 audit 2026-09-20). Scan tetap dari `raw` supaya target di
    // dalam kutip tetap tak terhitung sebagai redirect.
    const t = stripCaretEscapes(tRaw)
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
  // `for /f ... in (<set>) do ...` = pembaca berkas bawaan cmd.exe, tanpa
  // utilitas apa pun. Ia loop, bukan pembaca, jadi namanya tidak ada di
  // READERS — ekstraksi terpisah ini yang membuat `for /f %i in (.env) do
  // @echo %i` ikut diperiksa (temuan F3 audit 2026-09-20: `type .env` ditahan
  // tapi `for /f` terhadap berkas yang sama lolos).
  const forFileSets = (() => {
    const out: string[] = []
    const re = /\bfor\s+\/[a-z]*f[a-z]*\s+[^(\n]*\(\s*([^)\n]*)\)/gi
    for (const m of norm.matchAll(re)) {
      for (const rawTok of m[1]!.split(/[\s,]+/)) {
        const tok = rawTok.trim()
        if (tok && !tok.startsWith("-")) out.push(tok)
      }
    }
    return out
  })()

  if (both(READERS) || forFileSets.length > 0) {
    const readerTargets = (() => {
      const out: string[] = []
      const re =
        /\b(?:cat|bat|less|more|head|tail|nl|od|xxd|strings|type|Get-Content|certutil|tac|findstr|fc|comp|cp|copy|mv|move|scp|rsync|tar|zip|gzip|base64|openssl|awk|sed|grep|egrep|fgrep|rg|cut|sort|uniq|tee|dd|install|xcopy|robocopy|Out-File|Set-Content|Add-Content|New-Item|Copy-Item|Move-Item)\b\s+([^\n;&|]+)/gi
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
    for (const t of [...readerTargets, ...forFileSets]) {
      // Argumen berpola %VAR% tak bisa dipastikan menunjuk ke mana: cmd.exe
      // mengekspansi SETELAH cek statis, sementara resolve() melihatnya
      // sebagai jalur relatif DI DALAM cwd — `type %USERPROFILE%\notes.txt`
      // lolos padahal target redirect berpola sama ditahan di blok di atas
      // (temuan F2 audit 2026-09-20). Fail-closed: minta path eksplisit.
      // `%` tunggal (`100%.txt`) tetap lolos karena bukan pola ekspansi.
      if (/%[^%\s]+%/.test(t))
        return { denied: true, reason: "reader target with env expansion (%VAR%)" }
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
