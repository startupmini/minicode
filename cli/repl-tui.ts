// Driver REPL TUI — sesi interaktif di alternate screen (kontrak I16).
//
// Bentuknya mengikuti REPL sebelumnya (prompt `minicode ›`, binding Tab/
// Ctrl+C tetap, ledger/section/error sama) tetapi SEMUA lukisan lewat
// `src/ui/tui/screen.ts`: transkrip milik app + status 1 baris + input.
// Orkestrasi (loop/dispatch/turn) dipakai bersama lewat `cli/repl-core.ts`;
// berkas ini hanya adapter primitif TUI + kebijakan layar.
//
// State machine (§6, §11): IDLE --submit--> BUSY --done--> IDLE --/exit--> LEAVING
//   BUSY --approval--> CONFIRMING --y/a/n--> BUSY, IDLE --select--> SELECTING
//   ANY --resize--> RE-LAYOUT (state utuh), ANY --Ctrl-C--> CANCELLING.
// Focus (§8, §12): input vs modal (approval/ask/mini), Escape kembali ke input.
//
// Aturan layar yang dijaga di sini (bukan di screen):
// - stdin raw + pompa box hidup selama prompt; mati selama turn.
//   Tanpa pause() (Bun Windows: pause→resume membunuh 'data' selamanya).
// - Alur cetak (builtin/help/tabel) berjalan dalam capture() → dokumen.
//   Alur prompt biasa + turn agen tetap di alt-screen (transkrip via
//   setUiWriters). Alur kunci/teks (approval/ask/pick) in-flow via dialog.
//   TIDAK ADA suspend ke buffer utama: nol byte interaktif di luar alt-screen.
// - Baris parsial model (tanpa newline) ikut tampil: mirror doc + pending,
//   digabung saat present. Tanpa ini turn yang berpikir lama tanpa newline
//   terlihat mati (regresi kelincahan vs linier yang stream per chunk).

import { setUiWriters } from "../src/ui/assistant/simple.ts"
import { renderFooter } from "../src/ui/footer.ts"
import { loadHistory } from "../src/ui/input/input.ts"
import { wordWrap } from "../src/ui/render/wrap.ts"
import { runCaptured } from "../src/ui/tui/capture.ts"
import { createTuiInput, type TuiInputBox } from "../src/ui/tui/input.ts"
import { createTuiScreen, TUI_DOC_MAX_LINES, type TuiScreen } from "../src/ui/tui/screen.ts"
import { setTuiSessionUi } from "../src/ui/tui/session.ts"
import {
  buildGroupOf,
  buildSuggestions,
  formatContextCount,
  handlePromptKey,
  promptPrefix,
  type ReplShared,
  type ReplUi,
  runReplLoop,
} from "./repl-core.ts"
import type { CliSession } from "./setup.ts"
import { readMiniLine, runTuiApproval, runTuiAskText } from "./tui-dialog.ts"

export async function runTuiRepl(ctx: CliSession): Promise<void> {
  const { cfg, cwd, sessionId, modelRef } = ctx
  // Kontrak control-plane (Phase 6): sumber kebenaran konteks = kernel.
  const { session } = ctx

  const screen: TuiScreen = createTuiScreen()
  const box: TuiInputBox = createTuiInput({
    prompt: promptPrefix(),
    history: await loadHistory().catch(() => [] as string[]),
    complete: buildSuggestions(ctx),
    groupOf: buildGroupOf(),
  })

  // Cermin dokumen + baris parsial: setDocument screen diganti utuh tiap
  // present (replace-semantics → pin scroll absolut tetap stabil; provisional
  // pending tak pernah terduplikasi karena digabung, bukan di-append).
  let doc: string[] = []
  let pending = ""
  let busy = false
  let spark = 0
  let disposed = false
  let pulseTimer: ReturnType<typeof setInterval> | undefined
  // Box input overlay (mini reader pickSession/ask): menggantikan box utama
  // saat render selama terpasang. Tanpa ini prompt susulan tak punya tempat
  // mengetik yang terlihat.
  let overlayBox: TuiInputBox | null = null

  const stopPulse = (): void => {
    if (pulseTimer) {
      clearInterval(pulseTimer)
      pulseTimer = undefined
    }
  }

  const render = (): void => {
    if (disposed || !screen.altActive) return
    try {
      const [statusLine] = renderFooter(
        {
          mode: sharedRef.api.getMode(),
          model: modelRef.current ?? cfg.providers[0]?.models[0] ?? "no model",
          cwd: cwd ?? process.cwd(),
          context: formatContextCount(session.contextTokens),
          sparkFrame: busy ? spark : 0,
        },
        screen.cols,
      )
      const status = statusLine ?? ""
      const b = (overlayBox ?? box).render(screen.cols)
      screen.setDocument(pending ? [...doc, pending] : doc)
      screen.present({
        status,
        input: b.lines,
        cursor: { line: b.cursorLine, col: b.cursorCol },
        showCursor: !busy,
      })
    } catch {}
  }

  // Tulis mesin → dokumen (dipasang via setUiWriters selama turn; pecah per
  // baris utuh, sisa parsial ditahan di pending agar wrap tepat).
  const writeDoc = (s: string): void => {
    const parts = (pending + s).split("\n")
    pending = parts.pop() ?? ""
    for (const p of parts) {
      doc.push(p)
      if (doc.length > TUI_DOC_MAX_LINES) doc.splice(0, doc.length - TUI_DOC_MAX_LINES)
    }
    render()
  }
  const flushPending = (): void => {
    if (pending) {
      doc.push(pending)
      if (doc.length > TUI_DOC_MAX_LINES) doc.splice(0, doc.length - TUI_DOC_MAX_LINES)
      pending = ""
    }
  }

  // Pompa stdin → box. Hidup hanya saat prompt menunggu (readPrompt);
  // mati selama turn (orkestrasi punya listener busy sendiri).
  let pumpResolver: ((v: string | null) => void) | null = null
  let pumpOn = false
  let currentPrompt = ""
  const pump = (chunk: Buffer): void => {
    if (!pumpResolver) return
    let paint = false
    for (const ev of box.feed(chunk)) {
      if (ev.type === "submit") {
        // Jejak shell: prompt yang di-submit tetap di transkrip seperti
        // `PS> halo` di PowerShell — bukan hilang seperti widget.
        // Reset sinkron SEBELUM render: tanpa ini teks yang sama tampil dua
        // kali (jejak di doc + baris input yang belum dibersihkan).
        if (ev.line.trim()) {
          doc.push(`${currentPrompt}${ev.line}`)
          if (doc.length > TUI_DOC_MAX_LINES) doc.splice(0, doc.length - TUI_DOC_MAX_LINES)
        }
        box.reset()
        render()
        const done = pumpResolver
        pumpResolver = null
        detachPump()
        done(ev.line)
        return
      }
      if (ev.type === "cancel") {
        const done = pumpResolver
        pumpResolver = null
        detachPump()
        done(null)
        return
      }
      if (ev.type === "render") {
        paint = true
        continue
      }
      handlePromptKey(ev.key, {
        shared: sharedRef.api,
        notify: (msg) => writeDoc(`${msg}\n`),
        refresh: () => render(),
      })
      paint = true
    }
    if (paint) render()
  }
  const attachPump = (): void => {
    if (pumpOn || disposed) return
    pumpOn = true
    try {
      process.stdin.setRawMode(true)
    } catch {}
    process.stdin.resume()
    process.stdin.on("data", pump)
  }
  const detachPump = (): void => {
    if (!pumpOn) return
    pumpOn = false
    try {
      process.stdin.removeListener("data", pump)
    } catch {}
    try {
      process.stdin.setRawMode(false)
    } catch {}
  }

  // Handle loop inti (mode live) — diisi factory sebelum loop jalan.
  // Status/footer selalu baca via api.getMode() agar tak pernah basi.
  let sharedRef: { api: ReplShared } = {
    api: { getMode: () => "auto", setMode: () => {}, cycleMode: () => {} },
  }

  const note = (msg: string): void => {
    writeDoc(`${msg}\n`)
  }

  // Teks tangkapan → baris dokumen (wrap per kolom agar tabel panjang utuh;
  // baris kosong interior dipertahankan, satu trailing kosong dibuang).
  const appendWrapped = (text: string): void => {
    if (!text) return
    const lines = text.split("\n")
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    for (const line of lines) {
      for (const w of wordWrap(line, Math.max(10, screen.cols)).split("\n")) {
        doc.push(w)
        if (doc.length > TUI_DOC_MAX_LINES) doc.splice(0, doc.length - TUI_DOC_MAX_LINES)
      }
    }
  }

  // Dependensi dialog in-flow (approval/ask/mini-line): append + repaint +
  // raw + slot box overlay. Didaftarkan ke holder sesi TUI agar wiring
  // `ask` komposisi (setup.ts) menemukannya mid-turn; fail-closed bila absen.
  const dialogDeps = {
    append: (lines: string[]): void => {
      for (const line of lines) {
        doc.push(line)
        if (doc.length > TUI_DOC_MAX_LINES) doc.splice(0, doc.length - TUI_DOC_MAX_LINES)
      }
    },
    render: () => render(),
    ensureRaw: (): void => {
      try {
        process.stdin.setRawMode(true)
      } catch {}
      process.stdin.resume()
    },
    setInputBox: (b: TuiInputBox | null): void => {
      overlayBox = b
    },
  }

  const ui: ReplUi = {
    presentIdle: () => render(),
    readPrompt: (prompt) =>
      new Promise<string | null>((resolve) => {
        void (async () => {
          currentPrompt = prompt
          box.setPrompt(prompt)
          box.reset()
          box.setHistory(await loadHistory().catch(() => [] as string[]))
          render()
          pumpResolver = resolve
          attachPump()
        })()
      }),
    printOut: (msg) => writeDoc(msg.endsWith("\n") ? msg : `${msg}\n`),
    printErr: (msg) => writeDoc(msg.endsWith("\n") ? msg : `${msg}\n`),
    notify: (msg) => note(msg),
    busyFeedback: (msg) => note(msg),
    setBusy: (b: boolean) => {
      busy = b
      if (b) {
        // Selama turn, output logger (simple.ts) dialihkan ke dokumen
        // (bukan stdout/stderr yang kini alt-buffer). Dikembalikan di bawah
        // — runTurn inti SELALU memanggil setBusy(false) di finally.
        setUiWriters({ out: (s) => writeDoc(s), err: (s) => writeDoc(s) })
        if (!pulseTimer) {
          // Denyut spark selama turn (ganti pulse chrome linier): repaint
          // murah via dirty-check (hanya baris status berubah).
          pulseTimer = setInterval(() => {
            try {
              if (disposed || !busy) return
              spark += 1
              render()
            } catch {
              stopPulse()
            }
          }, 150)
        }
      } else {
        stopPulse()
        spark = 0
        flushPending()
        setUiWriters(null)
        render()
      }
    },
    refresh: () => render(),
    suspend: async <T>(fn: () => Promise<T>): Promise<T> => {
      // Tangkap tulisan alur cetak ke dokumen (wrap per kolom agar tabel
      // panjang tak terpotong): TANPA leave alt-screen. Urutan antar-stream
      // aproksimasi (out lalu err) — imperfek, tercatat jujur.
      const r = await runCaptured(fn)
      appendWrapped(r.out)
      appendWrapped(r.err)
      render()
      return r.value
    },
    promptLine: (prompt) => readMiniLine(dialogDeps, prompt),
    detachUi: () => screen.leave(),
    setInputActive: () => {
      // Pompa dimiliki readPrompt (pasang saat mulai, lepas saat selesai):
      // selama turn tak ada pompa yang perlu dimatikan/dinyalakan.
    },
    injectCancel: () => {
      // Idle (pompa hidup): byte ke box = cancel → null → streak logic inti.
      // Tanpa pompa (mini reader/dialog aktif): teruskan ke stdin agar
      // listener dialog yang menerima — sama seperti linier ke askLine.
      if (pumpOn) pump(Buffer.from([0x03]))
      else {
        try {
          process.stdin.emit("data", Buffer.from([0x03]))
        } catch {}
      }
    },
    clearTranscript: () => {
      doc = []
      pending = ""
      screen.setDocument([])
      render()
    },
    finish: () => {
      stopPulse()
      setUiWriters(null)
      setTuiSessionUi(null)
      disposed = true
      screen.dispose()
      // Riwayat layar dibuang (vim-style); yang tinggal info sesi agar
      // user tahu cara kembali (keputusan terkunci Q3).
      console.log(
        `sesi ${sessionId} • ${session.state.turnCount} turn • lanjut: minicode --resume ${sessionId}`,
      )
    },
  }

  setTuiSessionUi({
    approval: (call) => runTuiApproval(dialogDeps, call),
    askText: (question, options) => runTuiAskText(dialogDeps, question, options),
  })
  process.on("exit", () => {
    try {
      screen.leave()
    } catch {}
  })

  try {
    screen.enter()
    await runReplLoop(ctx, (shared) => {
      sharedRef = { api: shared }
      return ui
    })
  } finally {
    stopPulse()
    setUiWriters(null)
    setTuiSessionUi(null)
    detachPump()
    disposed = true
    try {
      screen.dispose()
    } catch {}
  }
}
