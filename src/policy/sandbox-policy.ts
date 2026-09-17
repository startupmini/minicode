// Resolusi mode sandbox untuk eksekusi bash.
//
// Sebelum ini: default = tanpa sandbox, `--sandbox` murni opt-in. Konsekuensinya
// pengguna yang tidak tahu harus mengetik flag berjalan dengan blocklist regex
// sebagai satu-satunya pertahanan. Blocklist menaikkan biaya serangan tapi tidak
// menutupnya (lihat experiments/bash-bypass-probe.ts).
//
// Sekarang: bila OS sandbox tersedia (bubblewrap di Linux, seatbelt di macOS),
// pakai secara default. Bila tidak — termasuk SEMUA Windows, di mana keduanya
// tidak ada — jangan berpura-pura terisolasi: turunkan permission default ke
// mode `allowlist` dan katakan alasannya sekali.
//
// Prinsip: jangan pernah menjanjikan isolasi yang tidak bisa dipenuhi. Lebih
// baik membatasi perintah (allowlist) daripada menjalankan apa pun sambil
// menampilkan label "sandboxed".

import { dockerAvailable } from "../sandbox/docker.ts"
import { osSandboxAvailable, osSandboxTypeName } from "../sandbox/os.ts"

export type SandboxMode = "docker" | "os" | "none"

export interface SandboxResolution {
  /** Mode yang benar-benar dipakai bash. */
  mode: SandboxMode
  /** true bila user menyebut --sandbox / MINICODE_SANDBOX secara eksplisit. */
  explicit: boolean
  /** Downgrade permission yang disarankan bila tak ada isolasi nyata. */
  fallbackPermission?: "allowlist"
  /** Pesan sekali-jalan untuk stderr; kosong = tak perlu bicara. */
  notice?: string
}

/**
 * Tentukan sandbox efektif.
 *
 * `requested` berasal dari `--sandbox` atau `MINICODE_SANDBOX`.
 * `explicitPermission` = user sudah memilih mode permission sendiri (mis.
 * `--allow-all`, `--ask`, `--plan`), sehingga kita tidak menimpanya.
 *
 * Fungsi ini pure terhadap argumen; deteksi lingkungan disuntik lewat `probes`
 * agar bisa diuji tanpa Docker/bwrap.
 */
export function resolveSandbox(
  requested: string | undefined,
  explicitPermission: boolean,
  probes: { os?: () => boolean; docker?: () => boolean; platform?: string } = {},
): SandboxResolution {
  const hasOs = probes.os ?? osSandboxAvailable
  const hasDocker = probes.docker ?? dockerAvailable
  const platform = probes.platform ?? process.platform

  const req = (requested ?? "").trim().toLowerCase()

  // ── permintaan eksplisit: hormati, tapi jangan diam bila tak tersedia ──
  if (req === "docker") {
    if (hasDocker()) return { mode: "docker", explicit: true }
    return {
      mode: "none",
      explicit: true,
      fallbackPermission: explicitPermission ? undefined : "allowlist",
      notice:
        "[sandbox] docker requested but the daemon is unavailable — running without isolation" +
        (explicitPermission ? "" : "; permission lowered to allowlist"),
    }
  }
  if (req === "os" || req === "bwrap" || req === "seatbelt") {
    if (hasOs()) return { mode: "os", explicit: true }
    return {
      mode: "none",
      explicit: true,
      fallbackPermission: explicitPermission ? undefined : "allowlist",
      notice:
        `[sandbox] no OS sandbox available on ${platform}` +
        (platform === "win32" ? " (bubblewrap/seatbelt are Linux/macOS only)" : "") +
        (explicitPermission
          ? " — running without isolation"
          : " — permission diturunkan ke allowlist"),
    }
  }
  if (req === "none" || req === "off" || req === "0") {
    // Opt-out sadar. Tidak ada downgrade, tidak ada ceramah.
    return { mode: "none", explicit: true }
  }
  if (req) {
    return {
      mode: "none",
      explicit: false,
      notice: `[sandbox] unknown mode "${requested}" — use docker|os|none`,
    }
  }

  // ── tanpa permintaan: pilih yang paling aman yang tersedia ──
  if (hasOs()) {
    return {
      mode: "os",
      explicit: false,
      notice: `[sandbox] enabled automatically: ${osSandboxTypeName()} (--sandbox none to disable)`,
    }
  }
  // Docker TIDAK dipakai otomatis: menarik image dan menjalankan container
  // tanpa diminta terlalu invasif untuk sebuah default.
  return {
    mode: "none",
    explicit: false,
    fallbackPermission: explicitPermission ? undefined : "allowlist",
    notice: explicitPermission
      ? undefined
      : `[sandbox] no OS sandbox on ${platform} — default permission = allowlist. ` +
        "Use --allow-all / --ask to choose yourself, or --sandbox docker for isolation.",
  }
}

function flagOn(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase()
  return s === "1" || s === "true" || s === "yes" || s === "on"
}

/** STRICT: tak pernah fallback host bila isolasi yang diminta tak tersedia. */
export function sandboxStrict(): boolean {
  return flagOn(process.env.MINICODE_SANDBOX_STRICT)
}

/** Fallback host eksplisit: satu-satunya jalan downgrade yang sadar. */
export function sandboxExplicitFallbackAllowed(): boolean {
  return flagOn(process.env.MINICODE_SANDBOX_ALLOW_FALLBACK)
}

/**
 * F-03: permintaan sandbox EKSPLISIT (`--sandbox docker|os` / env) tanpa
 * backend = tolak (fail-closed), kecuali fallback diizinkan eksplisit via
 * MINICODE_SANDBOX_ALLOW_FALLBACK=1 (dan tidak STRICT).
 *
 * Kembalikan pesan penolakan, atau null bila boleh jalan. Pure terhadap
 * argumen + probes agar teruji; flag env dibaca langsung (keputusan operator,
 * bukan state yang bisa di-inject repo).
 */
export function sandboxRefusalReason(
  requested: string | undefined,
  probes: { os?: () => boolean; docker?: () => boolean } = {},
): string | null {
  const req = (requested ?? "").trim().toLowerCase()
  const needDocker = req === "docker"
  const needOs = req === "os" || req === "bwrap" || req === "seatbelt"
  if (!needDocker && !needOs) return null
  const hasOs = probes.os ?? osSandboxAvailable
  const hasDocker = probes.docker ?? dockerAvailable
  if (needDocker ? hasDocker() : hasOs()) return null
  if (sandboxExplicitFallbackAllowed() && !sandboxStrict()) return null
  const what = needDocker
    ? "MINICODE_SANDBOX=docker but docker is unavailable"
    : "OS sandbox is unavailable on this machine"
  return (
    `[sandbox] ${what} — refusing to run without isolation ` +
    `(explicit sandbox request must not silently downgrade; ` +
    `set MINICODE_SANDBOX_ALLOW_FALLBACK=1 to allow host fallback explicitly)`
  )
}
