// Penjaga jaringan bersama: validasi host anti-SSRF + re-resolve DNS per cek.
// Dipakai web_fetch (tool), web_search, dan transport HTTP MCP — server MCP
// remote yang menunjuk ke metadata endpoint adalah jalur SSRF yang identik,
// jadi semuanya memakai satu penjaga yang sama.
// CATATAN audit F7: istilah "DNS pinning" DILARANG di sini — yang dilakukan
// fungsi ini adalah resolve-lalu-cek (check-then-connect), BUKAN menanam IP ke
// socket. Residualnya jujur didokumentasikan di web_fetch (cek dan connect
// bisa melihat IP berbeda); yang ditutup di sini adalah cache basi (noCache)
// dan kegagalan DNS (strict) — pilih per jalur sesuai risikonya.
//
// RESIDUAL anti-SSRF yang SENGAJA TIDAK ditutup (dokumentasi jujur, bukan
// kelalaian): prefix IPv6 lain yang juga memuat alamat IPv4 tapi tidak
// menaruhnya di 32 bit terakhir — NAT64 well-known (64:ff9b::/96), 6to4
// (2002::/16), dan Teredo (2001:0000::/32, IPv4-nya di-obfuscate). Bentuk itu
// hanya terjangkau bila mesin punya translator/relay NAT64 atau 6to4 — dan
// memblokir 64:ff9b::/96 sepenuhnya akan mematikan host IPv6-only yang sah di
// lingkungan NAT64. Yang ditutup: IPv4-mapped (::ffff:0:0/96),
// IPv4-translated (::ffff:0:0:0/96), dan IPv4-compatible (::/96).
import { lookup } from "node:dns/promises"

// Host validasi untuk anti-SSRF. Catatan: WHATWG URL sudah menormalisasi host
// IPv4 non-dotted (hex 0x7f000001 / desimal 2130706433) menjadi dotted-decimal,
// jadi cukup cek bentuk dotted di sini — bypass encoding tertutup oleh parser.
// CATATAN PENTING: normalisasi itu HANYA berlaku untuk IPv4 telanjang.
// IPv4-mapped IPv6 (::ffff:a.b.c.d) ditulis parser sebagai HEKSADESIMAL
// ("::ffff:a9fe:a9fe"), bukan dotted — jadi bentuk dotted SAJA tidak cukup,
// dan tanpa penanganan extra guard ini lolos ke metadata endpoint IMDS.
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 127 || a === 10 || a === 0) return true // loopback / priv10 / this-network
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true // link-local (cloud metadata IMDS)
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  return false
}

// Ambil alamat IPv4 yang tertanam di 32 bit TERAKHIR sebuah literal IPv6.
// Dua bentuk: dotted ("169.254.169.254") atau hextet ("a9fe:a9fe", atau
// "0:a9fe:a9fe" untuk IPv4-translated). Bentuk hextet inilah yang dipakai
// parser WHATWG, jadi bentuk dotted saja tidak cukup.
function low32IPv4(tail: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail
  const parts = tail.split(":").filter((p) => p.length > 0)
  if (parts.length === 0) return null
  const lo = parts[parts.length - 1]!
  const hi = parts.length >= 2 ? parts[parts.length - 2]! : "0"
  if (!/^[0-9a-f]{1,4}$/.test(hi) || !/^[0-9a-f]{1,4}$/.test(lo)) return null
  const hiN = Number.parseInt(hi, 16)
  const loN = Number.parseInt(lo, 16)
  if (!Number.isFinite(hiN) || !Number.isFinite(loN)) return null
  return [hiN >>> 8, hiN & 0xff, loN >>> 8, loN & 0xff].join(".")
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (!h) return true
  if (h === "localhost" || h.endsWith(".localhost")) return true
  if (h.endsWith(".internal") || h.endsWith(".local")) return true
  if (h === "::1" || h === "::") return true
  // IPv4-mapped (::ffff:0:0/96) dan IPv4-translated (::ffff:0:0:0/96): alamat
  // IPv4 ada di 32 bit terakhir. Parser menuliskan ini sebagai heksadesimal,
  // jadi bentuk dotted yang tadinya ditangani TIDAK menangkapnya.
  if (h.startsWith("::ffff:")) {
    const v4 = low32IPv4(h.slice(7))
    return v4 ? isPrivateIPv4(v4) : true
  }
  // IPv4-compatible (::/96, mis. "::a9fe:a9fe"): 32 bit terakhir juga IPv4.
  // Rentang ini tidak dipakai untuk host sungguhan → fail-closed.
  if (h.startsWith("::")) {
    const v4 = low32IPv4(h.slice(2))
    if (v4) return isPrivateIPv4(v4)
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]{0,1}:/.test(h)) return true // fe80::/10 link-local
  return isPrivateIPv4(h)
}

// DNS pinning untuk tutup DNS rebinding: resolve hostname → cek IP private
// default timeout 400ms fail-open (web_fetch butuh availability); mode strict
// fail-close untuk embedding/MCP (P1.4) agar DNS timeout tidak jadi SSRF bypass.
const dnsCache = new Map<string, { addrs: string[]; at: number }>()
export async function isPrivateHostWithDns(
  hostname: string,
  opts: { strict?: boolean; timeoutMs?: number; noCache?: boolean } = {},
): Promise<boolean> {
  if (isPrivateHost(hostname)) return true
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return false
  const timeoutMs = opts.timeoutMs ?? (opts.strict ? 1000 : 400)
  if (!opts.noCache) {
    const cached = dnsCache.get(hostname)
    if (cached && Date.now() - cached.at < 30_000) {
      for (const a of cached.addrs) if (isPrivateHost(a) || isPrivateIPv4(a)) return true
      return false
    }
  }
  try {
    const addrs = (await Promise.race([
      lookup(hostname, { all: true } as never).then((r) => {
        if (Array.isArray(r)) return (r as { address: string }[]).map((x) => x.address)
        return [(r as { address: string }).address]
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs)),
    ])) as string[]
    if (!opts.noCache) dnsCache.set(hostname, { addrs, at: Date.now() })
    for (const a of addrs) if (isPrivateHost(a) || isPrivateIPv4(a)) return true
  } catch {
    // lookup gagal/timeout → strict fail-close (embedding/MCP), default fail-open
    // agar web_fetch tidak block availability bila DNS lambat
    if (!opts.noCache) dnsCache.set(hostname, { addrs: [], at: Date.now() })
    if (opts.strict) return true
  }
  return false
}
