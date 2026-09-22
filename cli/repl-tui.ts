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
import {
  createDecoderState,
  type DecoderState,
  decodeKeysStream,
} from "../src/ui/input/prompt-engine.ts"
import { wordWrap } from "../src/ui/render/wrap.ts"
import { runCaptured } from "../src/ui/tui/capture.ts"
import { createTuiInput, type TuiInputBox } from "../src/ui/tui/input.ts"
import { createTuiScreen, TUI_DOC_MAX_LINES, type TuiScreen } from "../src/ui/tui/screen.ts"
import { setTuiSessionUi } from "../src/ui/tui/session.ts"
import {
  buildGroupOf,
  buildSuggestions,
  contPrompt,
  formatContextCount,
  handlePromptKey,
  promptPrefix,
  type ReplShared,
  type ReplUi,
  runReplLoop,
} from "./repl-core.ts"
import type { CliSession } from "./setup.ts"
import { readMiniLine, runTuiApproval, runTuiAskText } from "./tui-dialog.ts"
import { createModalList, type ModalList, type ModalListOptions } from "./tui-modal.ts"

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
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  // Telemetri kegagalan render: paint/present menelan error (fail-safe) —
  // tanpa hitungan, layar basi diam-diam tanpa sinyal. Sekali saja.
  let renderFails = 0
  let warnedRenderFail = false
  // Box input overlay (mini reader pickSession/ask): menggantikan box utama
  // saat render selama terpasang. Tanpa ini prompt susulan tak punya tempat
  // mengetik yang terlihat.
  let overlayBox: TuiInputBox | null = null
  // Stack modal popup (I17): teratas menerima kunci, box utama diam.
  // Mendukung nesting (effort di atas model): resolve pop satu tingkat.
  // Hidup hanya saat idle (dispatch); turn tak pernah membuka modal.
  const modalStack: Array<{ list: ModalList; resolve: (v: number | null) => void }> = []
  // Decoder stdin khusus modal (terpisah dari decoder internal box): chunk
  // yang sama tak boleh dimakan dua konsumen.
  const modalDecoder: DecoderState = createDecoderState()

  const stopPulse = (): void => {
    if (pulseTimer) {
      clearInterval(pulseTimer)
      pulseTimer = undefined
    }
  }

  const render = (): void => {
    if (disposed || !screen.altActive) return
    try {
      // Indikator pin: saat user menggulir (PageUp), baris di atas viewport
      // ditampilkan di status agar tak ada kebingungan "output berhenti".
      const baseCtx = formatContextCount(session.contextTokens)
      const pinned = screen.pinnedAbove()
      const context = pinned > 0 ? (baseCtx ? `${baseCtx} · ↑${pinned}` : `↑${pinned}`) : baseCtx
      const [statusLine] = renderFooter(
        {
          mode: sharedRef.api.getMode(),
          model: modelRef.current ?? cfg.providers[0]?.models[0] ?? "no model",
          cwd: cwd ?? process.cwd(),
          context,
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
        // Modal teratas (bila ada): screen mengomposit + mengambil kursor
        // darinya. Box utama tetap dirender di belakang (tertutup modal).
        ...(modalStack.length > 0 ? { modal: modalStack[modalStack.length - 1]!.list.spec() } : {}),
      })
    } catch {
      // Jangan biarkan satu frame rusak mematikan sesi; hitung + peringatkan
      // sekali (diagnostik cat-3) agar basi-yang-diam tak terjadi.
      renderFails += 1
      if (renderFails >= 3 && !warnedRenderFail) {
        warnedRenderFail = true
        try {
          process.stderr.write(
            "[warn] TUI render gagal 3× beruntun — layar mungkin basi; tekan tombol/resize untuk repaint.\n",
          )
        } catch {}
      }
    }
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

  // Invarian dokumen: satu entri = satu baris visual (TANPA \n). \n mentah
  // di baris dokumen akan mengeksekusi linefeed saat paint (screen menulis
  // baris apa adanya) dan menggeser grid — corrupt. Semua jalur push ke doc
  // yang menerima teks bebas (jejak submit multiline, teks dialog) lewat sini.
  const pushDocLines = (firstPrefix: string, text: string): void => {
    const parts = text.replace(/\r\n?/g, "\n").split("\n")
    parts.forEach((part, i) => {
      doc.push(`${i === 0 ? firstPrefix : contPrompt()}${part}`)
      if (doc.length > TUI_DOC_MAX_LINES) doc.splice(0, doc.length - TUI_DOC_MAX_LINES)
    })
  }
  const flushPending = (): void => {
    // Baris parsial akhir (mis. abort di tengah baris) di-wrap seperti
    // appendWrapped — bukan mentah (yang akan dipotong ellipsis di layar).
    if (pending) {
      appendWrapped(pending)
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
          pushDocLines(currentPrompt, ev.line)
        }
        box.reset()
        // Turn baru = konten baru di ekor: kembali follow agar output turn
        // terlihat (user yang pin lalu submit tak terjebak di pin).
        screen.scrollToEnd()
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
      // Gulir transkrip (PageUp/PageDown): state input utuh, hanya viewport.
      // PageDown di dasar = kembali follow (tanpa kondisi pin-yang-mentok).
      if (ev.type === "scroll") {
        screen.scrollPage(ev.dir === -1)
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

  // Pompa modal: listener stdin khusus saat modal terbuka. Pompa utama
  // (readPrompt) sudah dilepas setelah submit — tanpa ini ketikan tak
  // pernah sampai ke controller modal. Sisa chunk setelah pick/cancel
  // dibuang: ketikan buta milik modal yang sudah tutup.
  let modalPumpOn = false
  const onModalData = (chunk: Buffer): void => {
    if (modalStack.length === 0) return
    const top = modalStack[modalStack.length - 1]!
    let paint = false
    for (const d of decodeKeysStream(chunk, modalDecoder)) {
      const r = top.list.feed(d.key)
      if (r === "pick") {
        const idx = top.list.picked()
        modalStack.pop()
        if (modalStack.length === 0) detachModalPump()
        top.resolve(idx)
        paint = true
        break
      }
      if (r === "cancel") {
        modalStack.pop()
        if (modalStack.length === 0) detachModalPump()
        top.resolve(null)
        paint = true
        break
      }
      if (r === "render") paint = true
    }
    if (paint) render()
  }
  const attachModalPump = (): void => {
    if (modalPumpOn || disposed) return
    modalPumpOn = true
    try {
      process.stdin.setRawMode(true)
    } catch {}
    process.stdin.resume()
    process.stdin.on("data", onModalData)
  }
  const detachModalPump = (): void => {
    if (!modalPumpOn) return
    modalPumpOn = false
    try {
      process.stdin.removeListener("data", onModalData)
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
    // \r (mis. output CRLF dari capture) dihapus dulu: ia mengeksekusi
    // carriage-return saat paint dan menggeser grid — tak terlihat di ukuran
    // kolom tapi merusak baris.
    const lines = text.replace(/\r\n?/g, "\n").split("\n")
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
      // Baris dialog (pertanyaan ask_user, ringkasan approval) bisa multiline
      // (teks model) — pecah seperti jejak submit agar invarian terjaga.
      for (const line of lines) pushDocLines("", line)
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
    // Buka modal popup pilihan di atas frame (I17): resolve indeks item
    // asli atau null bila batal. Tumpuk aman (effort di atas model).
    pickFromList: (opts: ModalListOptions) =>
      new Promise<number | null>((resolve) => {
        if (modalStack.length === 0) attachModalPump()
        modalStack.push({ list: createModalList(opts), resolve })
        render()
      }),
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
      // Transkrip kosong tak punya apa-apa untuk di-pin: kembali follow agar
      // output berikutnya langsung terlihat (bukan pin hantu tanpa indikator).
      screen.scrollToEnd()
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

  // Resize saat idle: tanpa ini frame basi sampai keypress berikutnya
  // (screen membaca geometri live, tapi tak ada yang memicu present).
  // Debounce: drag-resize mengirim badai event; satu repaint cukup.
  const onResize = (): void => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      if (disposed) return
      try {
        screen.invalidate()
        render()
      } catch {}
    }, 50)
  }

  try {
    screen.enter()
    process.stdout.on("resize", onResize)
    await runReplLoop(ctx, (shared) => {
      sharedRef = { api: shared }
      return ui
    })
  } finally {
    stopPulse()
    setUiWriters(null)
    setTuiSessionUi(null)
    detachPump()
    detachModalPump()
    if (resizeTimer) {
      clearTimeout(resizeTimer)
      resizeTimer = undefined
    }
    try {
      process.stdout.removeListener("resize", onResize)
    } catch {}
    disposed = true
    try {
      screen.dispose()
    } catch {}
  }
}
