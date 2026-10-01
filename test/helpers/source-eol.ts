// Normalisasi EOL untuk assertion SEMANTIK atas teks sumber.
//
// [FASE 6AE] Alasan helper ini ada.
//
// Di repo ini, blob yang di-commit SELALU LF-only (lihat .gitattributes:
// `*.ts text eol=lf`). Tapi `core.autocrlf=true` di mesin Windows menimpa
// .gitattributes saat checkout, sehingga working tree berisi CRLF. Git
// (`git diff`) tetap melaporkan CLEAN karena perbandingan menormalisasi file
// bertipe `text` - jadi git sendiri tidak bisa melihat perbedaan ini.
//
// Yang bisa melihat: test yang membaca file sumber sebagai teks mentah lalu
// mencocokkan pola yang mengasumsikan `\n`. Assertion semantic seperti itu
// semestinya menilai SEMANTIK sumber, bukan representasi checkout di mesin
// mana test itu kebetulan dijalankan. Assertion yang bergantung pada
// core.autocrlf milik developer adalah pengukuran environment, bukan kode.
//
// Dua kegagalan nyata yang menjadi pemicu helper ini, keduanya di commit
// 9d79ebb pada clone segar dengan autocrlf=true:
//
//   1. test/phase6ab-production-trigger.test.ts - S13 mencocokkan
//      /createCliSession\(\{[\s\S]{0,400}?\n {4}resumeId,\n/ pada
//      cli/index.ts mentah. Dengan CRLF, `\n` tidak pernah muncul setelah
//      `{`, jadi regex gagal meski penilaian sebenarnya benar.
//   2. test/import-convention.test.ts - vendor:check membaca file vendor
//      mentah; hash/parse-nya berubah bentuk saat EOL berubah.
//
// [BATAS YANG SENGAJA] Helper ini HANYA untuk teks yang di-parse secara
// semantic. Ia sengaja TIDAK dipakai untuk:
//
//   - pemeriksaan BOM / encoding
//   - hash SHA-256 dan perbandingan byte
//   - fixture biner dan payload mentah
//   - test yang memang sengaja memverifikasi representasi byte
//
// Test byte-sensitive harus tetap byte-sensitive. Menormalkan semuanya
// membiarkan test byte-sensitive lulus tanpa pernah memeriksa byte-nya, dan
// test semantic gagal pada mesin yang berbeda. Keduanya adalah kebohongan.
//
// [SEMANTIKA] Dua langkah, dan hanya itu:
//
//   CRLF -> LF, lalu CR telanjang -> LF
//
// Tidak memangkas whitespace, tidak mengubah indentasi, tidak menormalkan tab
// atau spasi, tidak menormalkan Unicode, tidak menyentuh isi lain. Baris
// terisolasi `\r` (MAC klasik) ikut ditangani karena gagal dengan cara yang
// sama persis.
//
// [INVARIAN YANG DIPERCAYAKAN]
//
//   normalizeSourceEol(lfVersion(S)) === normalizeSourceEol(crlfVersion(S))
//
// Kalau ini tidak berlaku, helper-nya salah dan test helper ini akan gagal.
export function normalizeSourceEol(text: string): string {
  // CRLF dulu. Kalau urutannya dibalik, CR dari CRLF akan jadi LF sendiri dan
  // LF asli tertinggal sebagai LF kedua - jadi urutan ini bukan gaya, itu
  // kebenaran.
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}
