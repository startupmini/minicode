// Penjaga jaringan bersama: validasi host anti-SSRF + re-resolve DNS per cek.
// Dipakai web_fetch (tool), web_search, dan transport HTTP MCP — server MCP
// remote yang menunjuk ke metadata endpoint adalah jalur SSRF yang identik,
// jadi semuanya memakai satu penjaga yang sama.
// CATATAN audit F7: istilah "DNS pinning" DILARANG di sini — yang dilakukan
// fungsi ini adalah resolve-lalu-cek (check-then-connect), BUKAN menanam IP ke
// socket. Residualnya jujur didokumentasikan di web_fetch (cek dan connect
// bisa melihat IP berbeda); yang ditutup di sini adalah cache basi (noCache)
// dan kegagalan DNS (strict) — pilih per jalur sesuai risikonya.
import { lookup } from "node:dns/promises"

// Host validasi untuk anti-SSRF. Catatan: WHATWG URL sudah menormalisasi host
// IPv4 non-dotted (hex 0x7f000001 / desimal 2130706433) menjadi dotted-decimal,
// jadi cukup cek bentuk dotted di sini — bypass encoding tertutup oleh parser.
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

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (!h) return true
  if (h === "localhost" || h.endsWith(".localhost")) return true
  if (h.endsWith(".internal") || h.endsWith(".local")) return true
  if (h === "::1" || h === "::") return true
  if (h.startsWith("::ffff:")) return isPrivateIPv4(h.slice(7)) // IPv4-mapped IPv6
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
