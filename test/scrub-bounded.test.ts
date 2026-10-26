// scrubSecrets — batas kerja pola env-dump + kontrak redaksi (Agent B track, 2026-10-22).
//
// Pola "nama env yang mengandung penanda kredensial" (`NAMA=VALUE`) tadinya
// ditulis sebagai dua kuantifier bebas berurutan: `[A-Z0-9_]*` + kata penanda
// + `[A-Z0-9_]*`. Mesin regex lalu mencoba SEMUA cara membagi satu token
// panjang antara keduanya — O(N) titik potong × O(N) titik potong = kuadratik.
//
// Pada satu token uppercase 256 KiB berisi "SECRET" berulang, itu 25,9 detik;
// di batas 2 MiB `read_file` extrapolasinya menit — satu berkas crafted
// cukup untuk menjatuhkan satu turn agen. Bentuk sekarang memakai LOOKAHEAD untuk
// menyatakan "kata penanda ada di dalam token" (satu kali pemindaian, linear),
// sedangkan bagian yang mengonsumsi tinggal satu `[A-Z0-9_]*`.
//
// Catatan: ledakan kuadratik terjadi saat match GAGAL — mesin harus menjelajah
// semua cara membagi satu token panjang antara dua kuantifier bebas. Kalau
// match berhasil pada percobaan pertama (nilai secret yang valid), jalurnya
// linear dan cepat.
//
// Benchmark lokal (Windows/Bun 1.4.3, repo ini):
//   pola LAMA :  32 KiB 489 ms |  64 KiB 2.088 ms | 128 KiB 8.492 ms | 256 KiB 25.856 ms
//   pola BARU : 256 KiB  1,9 ms |   1 MiB  13,0 ms |   2 MiB  29,3 ms
//
// Test ini memakai batas waktu yang SANGAT longgar (10 detik untuk 256 KiB;
// hasil lokal ~2 ms) — jauh dari rapuh, tapi tetap menangkap regresi ke
// perilaku kuadratik (25,9 detik > 10 detik).
import { describe, expect, test } from "bun:test"
import { scrubSecrets } from "../src/policy/scrub.ts"

describe("scrubSecrets — pola env-dump (nama berisi penanda kredensial)", () => {
  test("nama env dengan penanda kredensial diredaksi", () => {
    const mustRedact = [
      "MY_SECRET_KEY=abcdefghij",
      "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345",
      "CLIENT_SECRET=zzzzzzzzzzzzzzzzzzz",
      "SOME_ACCESS_KEY=abcdefghijklmnop",
      "PRIVATE_KEY=abcdefghijklmnopqrst",
      "API_KEY=abcdefghijklmnopqrst",
      "MY_MIDDLE_SECRET_NAME=abcdefghij",
      "SECRET=abcdefghij",
      'SECRET="quotedvalue123"',
      "TOKEN=klmnopqrstuvwx",
    ]
    for (const s of mustRedact) {
      const out = scrubSecrets(s)
      expect(out, s).toContain("[REDACTED]")
      expect(out, s).not.toContain("abcdefghij")
    }
  })

  test("teks biasa dan env non-rahasia TIDAK dirusak", () => {
    const mustSurvive = [
      "hello world",
      "const x = 1",
      "PATTERN=/some/regex/path",
      "TOKENS = {",
      "*_TOKENS = 128_000",
      "export const SECRET_PAT = /x/",
      "my_secret_key=abcdefghij",
      "SECRET=",
      "SECRET=ab",
      "sessionId: string",
      "apiKey: string",
      "MY_ORG_ID=org-123",
    ]
    for (const s of mustSurvive) {
      expect(scrubSecrets(s), s).toBe(s)
    }
  })

  test("secret bersebelahan dan beberapa format tetap benar", () => {
    const out = scrubSecrets(
      "SECRET=abcdefghij TOKEN=klmnopqrstuvwx\nkey sk-abc123XYZ987abc123XYZ987abc123",
    )
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain("abcdefghij")
    expect(out).not.toContain("klmnopqrstuvwx")
    expect(out).not.toContain("sk-abc123XYZ987abc123XYZ987abc123")
  })
})

describe("scrubSecrets — input adversarial tidak boleh berskala patologis", () => {
  // Bentuk yang bikin mesin regex explores SEMUA cara membagi satu token
  // panjang: match-nya GAGAL. Kalau match berhasil pada percobaan pertama
  // (nilai secret yang valid), mesin tak perlu menjelajah kombinasi.
  //
  //   A. satu token 256 KiB berisi "SECRET" berulang, tanpa `=` sama sekali
  //   B. token sama, tapi diakhiri `=ab` — kelihatannya assignment, nilainya
  //      terlalu pendek sehingga BUKAN secret → match gagal
  //
  // Keduanya dulu 20–26 detik (pola LAMA); pola BARU ~2 ms.

  test("satu token panjang tanpa assignment: bounded time + tak berubah", () => {
    const input = "SECRET".repeat(42_000) // ~252 KiB, satu token
    const t0 = Date.now()
    const out = scrubSecrets(input)
    const ms = Date.now() - t0
    // Batas longgar: hasil lokal ~2 ms, perilaku lama ~25.900 ms.
    expect(ms, `butuh ${ms} ms`).toBeLessThan(10_000)
    // Tanpa `=` tidak ada assignment → tak ada yang boleh diredaksi.
    expect(out).toBe(input)
  }, 60_000)

  test("satu token panjang + nilai terlalu pendek: bounded time + tak berubah", () => {
    const input = `${"SECRET".repeat(42_000)}=ab`
    const t0 = Date.now()
    const out = scrubSecrets(input)
    const ms = Date.now() - t0
    expect(ms, `butuh ${ms} ms`).toBeLessThan(10_000)
    // Nilai 2 huruf bukan secret → isi tak boleh berubah.
    expect(out).toBe(input)
  }, 60_000)

  test("near-match panjang tanpa penanda: cepat dan tidak berubah", () => {
    const input = `${"A".repeat(200_000)}=abcdefghij`
    const t0 = Date.now()
    const out = scrubSecrets(input)
    const ms = Date.now() - t0
    expect(ms, `butuh ${ms} ms`).toBeLessThan(10_000)
    expect(out).toBe(input)
  }, 60_000)

  test("fragmen mirip-penanda yang dipisah spasi: aman dan cepat", () => {
    const input = `${"SECRET ".repeat(40_000)}=abcdefghij`
    const t0 = Date.now()
    const out = scrubSecrets(input)
    const ms = Date.now() - t0
    expect(ms, `butuh ${ms} ms`).toBeLessThan(10_000)
    // Assignment terakhir ("SECRET =abcdefghij") teredaksi; fragmen lain
    // bukan assignment sehingga tak tersentuh.
    expect(out.endsWith("[REDACTED]")).toBe(true)
    expect(out).not.toContain("abcdefghij")
  }, 60_000)

  test("satu token panjang + nilai secret valid: tetap diredaksi", () => {
    const input = `${"SECRET".repeat(42_000)}=abcdefghij`
    const t0 = Date.now()
    const out = scrubSecrets(input)
    const ms = Date.now() - t0
    expect(ms, `butuh ${ms} ms`).toBeLessThan(10_000)
    expect(out).toBe("[REDACTED]")
  }, 60_000)
})
