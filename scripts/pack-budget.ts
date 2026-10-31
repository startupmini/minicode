// BUDGET UKURAN PAKET — satu-satunya sumber angka ini (dipakai gate
// `scripts/pack-check.ts` DAN tes `test/pack-integrity.test.ts`, supaya
// keduanya tak bisa menyimpang).
//
// SATUAN: KiB (1 KiB = 1024 byte). Gate mengukur `unpackedSize` dari
// `npm pack --dry-run --json` lalu membulatkan ke KiB.
//
// [RE-BASELINE 3,5 MiB — disetujui owner, Quality Remediation Stage 8.1]
// Batas lama 2,25 MiB (2.304 KiB) ditetapkan saat payload runtime repo
// sekitar 1.605 KiB (commit cb633e4). Payload runtime kini 2.788 KiB —
// jadi runtime SAJA sudah melewati batas lama sebelum satu pun dokumen ikut.
// Pertumbuhan itu fitur sah (daemon, scheduler, task graph, persistence
// TUI), bukan modul tak terjangkau atau artefak basi: modul yang dipack
// tapi tak terjangkau dari entry point = 0.
//
// Bukti pengukuran (Stage 8, `git ls-tree` tanpa checkout):
//   e029457 (distribusi npm) : runtime  604 KiB
//   cb633e4 (batas 2,25 MiB): runtime 1.605 KiB
//   2d9e11e (HEAD)          : runtime 2.788 KiB
// Batas 3,5 MiB memberi ruang ~0,8 MiB untuk pertumbuhan runtime berikutnya
// tanpa mengulang re-baseline.
//
// [RE-BASELINE 3,75 MiB — disetujui owner 2026-10-31, Fase 10 penutupan]
// Batas 3,5 MiB (3.584 KiB) terlampaui oleh pertumbuhan fitur PRODUKSI yang
// sah sepanjang Fase 1–10 (LOOP, TOOL, MEMORY, CONTEXT, CONTROL, ACE-Lite).
// Bukti ukuran aktual `unpackedSize` (npm pack --dry-run, worktree bersih):
//   ead3284 (Fase 6A, sebelum Fase 7): 3.753.465 B = 3665,5 KiB (+81,5 over)
//   b173ee4 (Fase 10, HEAD)          : 3.795.794 B = 3706,8 KiB (+122,8 over)
// Rincian pertumbuhan sah Fase 7–10 (delta +42.329 B ≈ +41,3 KiB):
//   ACE-Lite consequence engine, memory provenance & supersession, MCP schema
//   pinning, streaming token delta accounting, storage authority matrix, serta
//   suite uji rilis lintas-dimensi. Modul yang dipack tapi tak terjangkau dari
//   entry point tetap 0; `gate:pack` lolos 22/23 cek (hanya ukuran yang over),
//   dan tidak ada file sampah/test/node_modules yang ikut terkemas.
// Batas baru 3,75 MiB memberi ruang ~30 KiB di atas aktual untuk pertumbuhan
// kecil berikutnya tanpa mengulang re-baseline.
//
// ATURAN: jangan menaikkan lagi tanpa BUKTI BARU + persetujuan owner.
// Batas ini adalah alarm regresi (node_modules/test ikut terbawa), bukan
// target ukuran yang perlu dikejar.
export const PACK_SIZE_BUDGET_KIB = 3840

/**
 * True bila ukuran paket (KiB) masih di dalam budget.
 *
 * Ketat (`<`, bukan `<=`): paket tepat di batas dianggap melimpah, supaya
 * batas berarti "di bawah N" dan tidak ada dua angka yang sama dengan dua
 * makna.
 */
export function withinSizeBudget(
  unpackedKb: number,
  budgetKb: number = PACK_SIZE_BUDGET_KIB,
): boolean {
  return unpackedKb < budgetKb
}
