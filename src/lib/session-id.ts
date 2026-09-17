// SATU-SATUNYA sanitizer identitas sesi (F-17).
//
// Tiga subsistem (checkpoint dir, shadow-git ref, journal file) dulu punya
// pemetaan sendiri-sendiri: `...` → `-` vs `x`, leading-dot di-strip vs tidak
// (checkpoint bisa membuat direktori HIDDEN `.foo`), default `default` vs `x`.
// Akibatnya satu session id dipetakan ke tiga nama berbeda antar subsistem,
// dan `pruneSessionRefs`/pembersih bisa salah sasaran untuk id adversarial
// (`--session` dikendalikan user).
//
// Aturan gabungan (paling ketat dari ketiganya): aman untuk path file, ref
// git, dan nama berkas di semua OS. Id normal (alnum, `-`, `_`, titik tunggal
// di tengah) dipetakan IDENTIK dengan ketiga fungsi lama — migrasi hanya
// mengubah id adversarial yang memang sudah rusak (direktori hidden / ref
// ilegal). Kolisi `a/b` ↔ `a-b` tetap ada di SEMUA varian (tanpa escaping tak
// terhindarkan) — didokumentasikan, bukan diperbaiki di sini.
export function sanitizeSessionPart(s: string): string {
  const cleaned = s
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 60)
  return cleaned || "x"
}
