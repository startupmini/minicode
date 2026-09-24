// Kontrak presentasi — satu-satunya jendela komunikasi antara lapisan UI dan
// sistem di luarnya.
//
// Aturan arah dependensi (dijaga test/ui-boundary.test.ts):
// - src/ui/ TIDAK BOLEH mengimpor cli/, src/ non-ui, atau #minicore.
// - src/ non-ui TIDAK BOLEH mengimpor src/ui/ — komunikasi lewat kontrak ini
//   dan callback yang di-inject dari cli/ (composition root).
//
// Semua event kernel dipetakan ke tipe STRUKTURAL di sini. EventBus kernel
// (#minicore) kompatibel secara struktural dengan UiBus, jadi cli/ bisa
// menyerahkan bus kernel apa adanya tanpa adapter runtime.

export interface UiToolCallRef {
  /**
   * toolCallId dari provider (ToolCall.id) — diaditif Fase 2 Presentasi V2.1.
   * Opsional agar subscriber lama yang hanya butuh name/args tidak rusak;
   * kernel selalu mengisi ini (snapshotToolCall), cast `as unknown` di
   * cli/tui.ts tidak lagi buta terhadap identitas.
   */
  id?: string
  name: string
  args?: unknown
}

/** Hasil tool ringkas di step (Fase 2) — bukan payload penuh ToolResult. */
export interface UiStepResultRef {
  toolCallId?: string
  isError?: boolean
  content?: unknown
}

export interface UiStep {
  index: number
  toolCalls: readonly UiToolCallRef[]
  /** Opsional: ringkas results (kernel step:completed membawa ini penuh). */
  results?: readonly UiStepResultRef[]
}

export interface UiExecution {
  call: UiToolCallRef
  result: { isError?: boolean; content?: unknown }
}

/**
 * Subset event agen yang dikonsumsi lapisan presentasi. Field meniru bentuk
 * payload kernel (flat, ber-`type`) tetapi didefinisikan ulang di sini supaya
 * UI tidak pernah menyentuh tipe vendor.
 */
export type UiEvent =
  | { type: "turn:started"; turn: number }
  | { type: "turn:completed"; result?: unknown }
  | { type: "step:started"; step: UiStep }
  | { type: "step:completed"; step: UiStep }
  | { type: "execution:started"; execution: UiExecution }
  | { type: "execution:completed"; execution: UiExecution }
  | { type: "provider:text"; text: string }
  | { type: "provider:extension"; kind: string; data: unknown }
  | { type: "context:compacted"; reason: string }

export type UiEventType = UiEvent["type"]

/**
 * Bus event yang dibaca lapisan presentasi. Handler dilonggarkan ke `any`
 * dengan sengaja: `on` milik EventBus kernel bersifat generik-kondisional, dan
 * versi bertipe ketat (`handler: (event: Extract<UiEvent, {type: K}>) => void`)
 * membuat kernel TIDAK assignable karena kontravariansi parameter. Tiap view
 * menganotasi bentuk payload yang ia render sendiri (lihat assistant/*).
 */
export interface UiBus {
  on(type: UiEventType, handler: (event: any) => void): () => void
}
