// Validasi CAPABILITY DETECTION mouse SGR (helper: test/helpers/pty-harness.ts).
//
// Dipisah dari test/pty.test.ts karena yang diuji adalah KEPUTUSAN probe,
// bukan perilaku TUI. Klasifikasi dipisah dari transport (fungsi murni
// `classifySgrProbe`) supaya kedua kemungkinan — SGR diterima dan SGR tak
// diterima — bisa diuji tanpa bergantung pada platform.
//
// PENTING: tak ada test di sini yang AZAKAN SGR selalu gagal. SGR bisa
// saja didukung (dan di lingkungan yang mendukung, jalur SGR diverifikasi
// lewat test/pty.test.ts). Yang dijaga: verdict harus SELALU cocok dengan
// byte yang benar-benar diterima anak, dan hasil yang tak dapat disimpulkan
// tak boleh dilaporkan sebagai "SGR tak didukung".

import { describe, expect, test } from "bun:test"
import {
  classifySgrProbe,
  decideSgrGate,
  parseSgrReadyRawMode,
  ptySgrMouseDelivered,
  type SgrProbeObservation,
} from "./helpers/pty-harness.ts"

// Nilai yang sama dengan probe di pty-harness.ts (dikode ulang di sini
// supaya test tak bergantung pada konstanta internal helper).
const SGR = "\x1b[<0;1;1M"
const TRAILER = "MINICODE-PTY-SGR-TRAILER"
const CONTROL = "MINICODE-PTY-SGR-CONTROL"

function observation(overrides: Partial<SgrProbeObservation> = {}): SgrProbeObservation {
  return {
    rawMode: true,
    received: null,
    sgrSequence: SGR,
    trailer: TRAILER,
    controlMarker: CONTROL,
    ...overrides,
  }
}

describe("klasifikasi probe SGR mouse (murni, tanpa IO)", () => {
  test("byte SGR diterima anak → supported", () => {
    const res = classifySgrProbe(observation({ received: `${CONTROL}\r${SGR}${TRAILER}\r` }))
    expect(res.verdict).toBe("supported")
    expect(res.ok).toBe(true)
  })

  test("SGR hilang tapi byte lain pada write yang sama sampai → unsupported (terbukti)", () => {
    const res = classifySgrProbe(observation({ received: `${CONTROL}\r${TRAILER}\r` }))
    expect(res.verdict).toBe("unsupported")
    expect(res.ok).toBe(false)
  })

  test("tak ada byte yang sampai → inconclusive, BUKAN 'tak didukung'", () => {
    const res = classifySgrProbe(observation({ received: null }))
    expect(res.verdict).toBe("inconclusive")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("BUKAN bukti SGR tak didukung")
  })

  test("kontrol sampai tapi write kedua hilang → inconclusive (tak dapat disimpulkan)", () => {
    const res = classifySgrProbe(observation({ received: `${CONTROL}\r` }))
    expect(res.verdict).toBe("inconclusive")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("BUKAN bukti SGR tak didukung")
  })

  test("tanpa raw mode → inconclusive (line buffering bukan keterbatasan transport)", () => {
    const res = classifySgrProbe(
      observation({ rawMode: false, received: `${CONTROL}\r${TRAILER}\r` }),
    )
    expect(res.verdict).toBe("inconclusive")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("raw mode")
  })

  test("alasan selalu terisi dan menyebut statusnya (tak ada verdict tanpa penjelasan)", () => {
    for (const res of [
      classifySgrProbe(observation({ received: `${SGR}${TRAILER}\r` })),
      classifySgrProbe(observation({ received: `${TRAILER}\r` })),
      classifySgrProbe(observation({ received: null })),
    ]) {
      expect(res.reason.trim().length).toBeGreaterThan(0)
    }
  })
})

describe("parsing baris READY probe (raw mode)", () => {
  const READY = "MINICODE-PTY-SGR-READY"

  test("baris READY utuh → raw mode aktif terdeteksi", () => {
    expect(parseSgrReadyRawMode(`${READY} raw=1\r\n`)).toBe(true)
  })

  test("baris READY terpecah antar-chunk → tetap terdeteksi setelah fragmen lengkap", () => {
    // Chunk 1: separuh baris. Chunk 2: sisanya. Akumulasi = output utuh.
    const chunk1 = `${READY} ra`
    const chunk2 = "w=1\r\n"
    // Akumulasi output = gabungan chunk.
    expect(parseSgrReadyRawMode(chunk1)).toBeNull() // belum lengkap → tak boleh disimpulkan
    expect(parseSgrReadyRawMode(chunk1 + chunk2)).toBe(true)
  })

  test("baris READY tanpa newline → belum siap (tak ada inferensi)", () => {
    expect(parseSgrReadyRawMode(`${READY} raw=1`)).toBeNull()
    expect(parseSgrReadyRawMode(`${READY} raw=`)).toBeNull()
  })

  test("raw=0 → raw mode MATI (bukan 'SGR tak didukung')", () => {
    expect(parseSgrReadyRawMode(`${READY} raw=0\r\n`)).toBe(false)
    // Dan klasifikasi dari observasi itu = inconclusive, bukan unsupported.
    const res = classifySgrProbe(
      observation({ rawMode: false, received: `${CONTROL}\r${TRAILER}\r` }),
    )
    expect(res.verdict).toBe("inconclusive")
    expect(res.ok).toBe(false)
  })

  test("output tanpa READY sama sekali → belum siap", () => {
    expect(parseSgrReadyRawMode("")).toBeNull()
    expect(parseSgrReadyRawMode("MINICODE-PTY-SGR-GOT:YWJj\r\n")).toBeNull()
  })
})

describe("keputusan gate SGR end-to-end", () => {
  test("transport menyokong SGR → run", () => {
    const g = decideSgrGate({
      ptyAvailable: true,
      verdict: "supported",
      reason: "ok",
      ciLinux: false,
    })
    expect(g.decision).toBe("run")
  })

  test("PTY tak tersedia → skip beralasan", () => {
    const g = decideSgrGate({
      ptyAvailable: false,
      verdict: "inconclusive",
      reason: "PTY tidak tersedia",
      ciLinux: false,
    })
    expect(g.decision).toBe("skip")
    expect(g.reason).toBe("PTY tidak tersedia")
  })

  test("unsupported (terbukti) di luar CI → skip: satu-satunya dasar sah", () => {
    const g = decideSgrGate({
      ptyAvailable: true,
      verdict: "unsupported",
      reason: "byte SGR hilang",
      ciLinux: false,
    })
    expect(g.decision).toBe("skip")
  })

  test("inconclusive di luar CI → skip, TIDAK pernah 'unsupported'", () => {
    const g = decideSgrGate({
      ptyAvailable: true,
      verdict: "inconclusive",
      reason: "probe tidak konfirmasi",
      ciLinux: false,
    })
    expect(g.decision).toBe("skip")
    expect(g.reason).toContain("konfirmasi")
  })

  test("CI Linux + unsupported → FAIL dengan diagnosa (bukan skip)", () => {
    const g = decideSgrGate({
      ptyAvailable: true,
      verdict: "unsupported",
      reason: "byte SGR hilang",
      ciLinux: true,
    })
    expect(g.decision).toBe("fail")
    expect(g.reason).toContain('verdict="unsupported"')
    expect(g.reason).toContain("byte SGR hilang")
  })

  test("CI Linux + inconclusive → FAIL dengan diagnosa (bukan skip)", () => {
    const g = decideSgrGate({
      ptyAvailable: true,
      verdict: "inconclusive",
      reason: "probe tidak konfirmasi",
      ciLinux: true,
    })
    expect(g.decision).toBe("fail")
    expect(g.reason).toContain('verdict="inconclusive"')
  })

  test("CI Linux + supported → run", () => {
    const g = decideSgrGate({
      ptyAvailable: true,
      verdict: "supported",
      reason: "ok",
      ciLinux: true,
    })
    expect(g.decision).toBe("run")
  })
})

describe("probe SGR mouse nyata (transport sungguhan)", () => {
  test("verdict konsisten dengan byte yang benar-benar diterima anak", async () => {
    const res = await ptySgrMouseDelivered()
    expect(["supported", "unsupported", "inconclusive"]).toContain(res.verdict)
    expect(res.reason.trim().length).toBeGreaterThan(0)

    if (res.verdict === "supported") {
      // Bukti positif: byte SGR benar-benar ada di laporan anak.
      const received = res.observation?.received ?? ""
      expect(received).toContain(res.observation?.sgrSequence ?? SGR)
    }
    if (res.verdict === "unsupported") {
      // Bukti negatif: SGR TIDAK ada, tapi marker lain pada write yang sama
      // sampai → jadi yang hilang memang byte SGR, bukan seluruh write.
      const received = res.observation?.received ?? ""
      expect(received).not.toContain(res.observation?.sgrSequence ?? SGR)
      expect(received).toContain(res.observation?.trailer ?? TRAILER)
    }
    if (res.verdict === "inconclusive") {
      // Tak konklusif ≠ SGR tak didukung: alasannya harus jujur menyebutnya.
      expect(res.reason).toContain("konklusif")
    }
  })

  test("hasil di-cache per proses (probe tak diulang tiap pemanggilan)", async () => {
    const a = await ptySgrMouseDelivered()
    const b = await ptySgrMouseDelivered()
    expect(b).toBe(a)
  })
})
