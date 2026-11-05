// Satu sumber state "section collapse" untuk output besar saat turn
// (thinking, bash, edit/apply_patch, content tool).
//
// [F-ENV-1] State module-local di-bootstrap SATU KALI dari env saat import; setter
// TIDAK lagi menulis `process.env` (pilihan UI bukan konfigurasi yang boleh
// diwarisi sub-proses). Sebelumnya `MINICODE_MINIMIZE_ANSWER/_TOOL` ditulis ulang.
//
// [Area A · PROMPT 06] API modul ini kini HANYA delegator ke instance default
// `UiSessionState`. State sebenarnya tinggal di `src/ui/session-state.ts` dan
// dimiliki SESI (composition root membuat satu instance per sesi lalu
// meneruskannya ke Transcript + printer linier). Delegator di sini dipertahankan
// agar call-site lama (one-shot, export test) tetap jalan tanpa DI besar.
//
// Semantik tombol: `+` = expand (lihat isi), `-` = minimize (satu baris).
// Minimized = isi TIDAK dicetak, hanya `  + label` — isi di-buffer untuk
// /expand. Thinking memakai reasoning.visible sebagai invers dari minimize
// (expanded = visible), jadi /thinking/Ctrl+T lama tetap satu arti.
import {
  type CollapsedSectionView,
  type CollapseSection,
  defaultUiState,
} from "../session-state.ts"

export type { CollapsedSectionView, CollapseSection }

export const collapse = {
  /** Section yang sedang aktif — keputusan tombol + / - saat turn berjalan. */
  get activeSection(): CollapseSection | null {
    return defaultUiState.activeSection
  },
  setActiveSection(k: CollapseSection | null): void {
    defaultUiState.setActiveSection(k)
  },
}

/** Section sedang dikecilkan? Thinking = invers reasoning.visible. */
export function sectionMinimized(section: CollapseSection): boolean {
  return defaultUiState.sectionMinimized(section)
}

/** Set eksplisit (nilai minimize) atau toggle bila `next` tidak diberikan.
 * Return nilai minimize terbaru. */
export function setSectionMinimized(section: CollapseSection, next?: boolean): boolean {
  return defaultUiState.setSectionMinimized(section, next)
}

/** Simpan isi section yang dikecilkan (cap per-entry + total). */
export function rememberCollapsedSection(
  label: string,
  text: string,
  stream: CollapsedSectionView["stream"] = "stderr",
): void {
  defaultUiState.rememberCollapsedSection(label, text, stream)
}

export function clearCollapsedSections(): void {
  defaultUiState.clearCollapsedSections()
}

/** Konten section yang dikecilkan pada turn terakhir (untuk /expand). */
export function collapsedSectionsSnapshot(): CollapsedSectionView[] {
  return defaultUiState.collapsedSectionsSnapshot()
}
