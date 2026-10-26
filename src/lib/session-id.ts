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
//
// Batas yang diketahui (sifat pemetaan lossy, bukan bug baru):
// - Pemotongan 60 karakter bisa menyatukan dua id panjang berawalan sama.
// - Huruf besar-kecil TIDAK dileburkan: di filesystem case-insensitive
//   (Windows/macOS) `ABC` dan `abc` menunjuk direktori yang SAMA, di Linux
//   tidak. Menyasakan berarti mengubah pemetaan id normal (checkpoint lama
//   jadi tak terjangkau) — keputusan pemilik, bukan perbaikan sepihak.
export function sanitizeSessionPart(s: string): string {
  const cleaned = s
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 60)
    // Potong bisa menyisakan titik di akhir ("a"x59 + ".b" → "a"x59 + ".").
    // Nama yang berakhir titik TIDAK portabel di Windows: API path klasik
    // (cmd, .NET, Explorer) menghapus titiknya → nama itu tak terlihat dan
    // tak bisa dihapus lewat jalur itu, sementara Node/Bun (prefix `\\?\`)
    // tetap membuatnya. Git juga menolak nama ref yang berakhir titik.
    // Strip ulang SESUDAH potong: id >60 karakter memang id adversarial
    // yang pemetaannya boleh berubah.
    .replace(/[.-]+$/g, "")
  return cleaned || "x"
}
