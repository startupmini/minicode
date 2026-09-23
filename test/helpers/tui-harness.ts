// Harness TUI — fake TTY untuk menguji lapisan interaktif tanpa terminal nyata.
//
// Kenapa ada: `askLine`, `runPicker`, dan `runProviderManager` semuanya
// menulis langsung ke process.stdout dan membaca process.stdin dalam raw mode.
// Tanpa harness, satu-satunya cara mengujinya adalah manual — dan itulah
// sebabnya bug rekursi spinner (REPL mati bisu pada prompt pertama) lolos ke
// main tanpa satu test pun menangkapnya.
//
// Cara pakai:
//   const tty = installFakeTty({ columns: 100, rows: 30 })
//   const p = askLine({ prompt: "> " })
//   await tty.ready()                  // tunggu listener stdin terpasang
//   await tty.send("halo")             // suntik keystroke
//   await tty.send(KEY.enter, 30)      // submit
//   tty.all()                          // seluruh output stdout terkumpul
//   tty.restore()                      // WAJIB di afterEach
//
// Catatan: setiap fungsi UI memanggil setRawMode/resume/pause pada stdin, jadi
// stub harus menyediakannya. `on("data")` mengumpulkan listener supaya send()
// bisa memanggilnya persis seperti Node memanggil saat ada input.

export interface FakeTtyOptions {
  columns?: number
  rows?: number
  /** Simulasi non-TTY (untuk menguji fallback pipe/CI). */
  isTTY?: boolean
  /** Set false untuk membiarkan deteksi warna apa adanya (default: paksa truecolor). */
  color?: boolean
  /** Set false untuk mensimulasikan terminal TANPA dukungan VT (TERM=dumb). */
  vt?: boolean
  /** Set true untuk memaksa glyph ASCII (konsol Windows legacy). */
  ascii?: boolean
}

export interface FakeTty {
  /**
   * Tunggu sampai komponen memasang listener stdin.
   *
   * `askLine` dan `runProviderManager` melakukan `await` (dynamic import,
   * loadHistory, loadConfig) sebelum memasang listener. Mengirim keystroke
   * sebelum itu membuat input hilang tanpa jejak — test lolos/gagal tergantung
   * timing mesin. Selalu `await tty.ready()` setelah memanggil komponen async.
   */
  ready(timeoutMs?: number): Promise<void>
  /**
   * Berapa kali listener stdin sudah dipasang sejak harness dibuat.
   *
   * Dipakai untuk mendeteksi siklus suspend→resume: `runProviderManager`
   * melepas listener-nya, membiarkan `askLine`/`askSecret` memasang listener
   * sendiri, lalu memasangnya kembali. Setiap pemasangan menaikkan angka ini,
   * jadi ia berfungsi sebagai "prompt ke-berapa".
   */
  listenerEpoch(): number
  /**
   * Jumlah listener stdin yang dipasang saat raw mode aktif.
   *
   * Membedakan prompt `askLine` (pasang listener sambil raw) dari listener
   * non-raw berumur pendek — mis. penangkap Ctrl+C REPL saat turn berjalan.
   * `ready()` saja tidak cukup: listener busy membuat ready() pulang terlalu
   * cepat dan keystroke berikutnya hilang.
   */
  promptListeners(): number
  /** Tunggu sampai listener stdin BARU terpasang (epoch melewati `since`). */
  waitForNewListener(since: number, timeoutMs?: number): Promise<number>
  /**
   * Tunggu sampai MINIMAL SATU listener stdin ada.
   *
   * Pasangan `close()` manager: suspend melepas listener utama dan resume
   * memasangnya lagi — Esc yang dikirim di jendela tanpa-listener hilang
   * tanpa jejak dan `await done` gantung selamanya (flake timeout 5000ms
   * yang berpindah tiap run). Tunggu dulu; bila tak kunjung ada, gagal
   * cepat dengan pesan jelas, bukan gantung sampai timeout test.
   */
  waitForListener(timeoutMs?: number): Promise<void>
  /**
   * Tunggu sampai output stdout cocok predikat.
   *
   * Listener terpasang ≠ komponen siap dibaca: ada jeda antara `on("data")`
   * dan prompt pertama digambar (dynamic import/config). Menunggu marker
   * OUTPUT (teks prompt terlihat) menghilangkan seluruh kelas flake timing —
   * jawaban hanya dikirim setelah bukti visual prompt ada di scrollback.
   */
  waitForOutput(pred: (out: string) => boolean, timeoutMs?: number): Promise<string>
  /**
   * Jawab prompt berurutan.
   *
   * Setiap kali komponen memasang listener stdin baru, jawaban berikutnya
   * dikirim (diakhiri Enter). Panggil SEBELUM keystroke yang memicu rangkaian
   * prompt, lalu `await` hasilnya:
   *
   *   const seq = tty.answerSequence(["0", "sk-key", "n"])
   *   await tty.send("a")
   *   await seq
   *
   * Tanpa ini, alur a/d/e di `provider-manager` tidak bisa diuji sama sekali:
   * `send()` hanya mengirim ke listener yang ada SEKARANG, sementara prompt
   * berikutnya baru memasang listener setelah yang sebelumnya selesai.
   */
  answerSequence(
    answers: string[],
    opts?: {
      timeoutMs?: number
      settleMs?: number
      /**
       * Predikat output per langkah: jawaban[i] baru dikirim setelah
       * `expect[i](tty.all())` benar (prompt langkah itu sudah digambar).
       * Hilangkan flake "jawaban masuk ke prompt yang salah" saat dua prompt
       * berurutan memasang listener dalam tick yang sama.
       */
      expect?: ((out: string) => boolean)[]
    },
  ): Promise<void>
  /** Kirim byte ke semua listener stdin, lalu beri kesempatan microtask jalan. */
  send(data: string | Uint8Array, settleMs?: number): Promise<void>
  /** Semua chunk yang ditulis ke stdout, apa adanya. */
  chunks(): string[]
  /** Semua output stdout digabung. */
  all(): string
  /**
   * Output stderr digabung. Renderer one-shot menulis ringkasan tool, error, dan
   * reasoning ke stderr (supaya stdout tetap bersih untuk pipe), jadi assertion
   * atasnya butuh aliran terpisah.
   */
  allErr(): string
  /** stdout + stderr digabung, urut sesuai penulisan. */
  combined(): string
  /** Buang riwayat output — dipakai untuk mengisolasi output per langkah. */
  clear(): void
  /** Ubah ukuran terminal dan picu event resize. */
  resize(columns: number, rows: number): void
  /**
   * Frame layar terakhir sebagai grid teks polos (satu string per baris).
   *
   * Parser menafsirkan urutan yang dipakai App/painter: HOME, ED, EL, kursor
   * naik/turun, CR/LF, dan SGR (dibuang — sel menyimpan karakter polos).
   * Alternatif masuk (`?1049h`) mengosongkan grid (semantik buffer alt);
   * alternatif keluar (`?1049l`) membiarkan frame terakhir (untuk assertion
   * pasca-quit pakai byte pairing, bukan parser). CJK/emoji dihitung 2 kolom
   * via `displayWidth` supaya kursor tidak meleset setelah glyph lebar.
   */
  /** Status raw mode saat ini (untuk assertion restore TUI-001). */
  isRaw(): boolean
  screen(): string[]
  /** Rejection/exception yang tertangkap selama test. Harus kosong. */
  failures(): string[]
  restore(): void
}

export function installFakeTty(opts: FakeTtyOptions = {}): FakeTty {
  let columns = opts.columns ?? 100
  let rows = opts.rows ?? 30
  const isTTY = opts.isTTY ?? true

  const chunks: string[] = []
  const errChunks: string[] = []
  const combinedChunks: string[] = []
  // raw menandai APAKAH raw mode aktif saat listener dipasang — dipakai
  // promptListeners() membedakan prompt askLine dari listener non-raw.
  const dataListeners: { fn: (chunk: Buffer) => void; raw: boolean }[] = []
  const resizeListeners: (() => void)[] = []
  const failures: string[] = []
  // Naik setiap kali listener "data" dipasang. Tidak pernah turun — dipakai
  // sebagai jam logis untuk mendeteksi prompt berikutnya (lihat answerSequence).
  let listenerEpoch = 0
  let rawMode = false

  const origStdin = process.stdin
  const origWrite = process.stdout.write.bind(process.stdout)
  const origErrWrite = process.stderr.write.bind(process.stderr)
  const origLog = console.log
  const origError = console.error
  const origColumns = process.stdout.columns
  const origRows = process.stdout.rows
  const origStdoutIsTty = process.stdout.isTTY
  const origStderrIsTty = process.stderr.isTTY
  const origColorterm = process.env.COLORTERM
  const origNoColor = process.env.NO_COLOR
  const origTerm = process.env.TERM
  const origWtSession = process.env.WT_SESSION
  const origAscii = process.env.MINICODE_ASCII
  const origStdoutOn = process.stdout.on.bind(process.stdout)
  const origStdoutOff = process.stdout.off.bind(process.stdout)
  const origStdoutRemove = process.stdout.removeListener.bind(process.stdout)

  const onFailure = (e: unknown) => {
    const err = e as { message?: string } | undefined
    failures.push(String(err?.message ?? e))
  }
  process.on("unhandledRejection", onFailure)
  process.on("uncaughtException", onFailure)

  const fakeStdin = {
    isTTY,
    setRawMode(v: boolean) {
      rawMode = v
      return fakeStdin
    },
    resume() {
      return fakeStdin
    },
    pause() {
      return fakeStdin
    },
    setEncoding() {
      return fakeStdin
    },
    setMaxListeners() {
      return fakeStdin
    },
    getMaxListeners() {
      // Cermin default Node (10): kode produksi menyimpan & mengembalikan
      // batas ini di sekitar sesi modal (setMaxListeners(0) sementara).
      return 10
    },
    listenerCount(_event: string) {
      // `readline.emitKeypressEvents()` checks this before wiring internals.
      // Fake stdin does not model keypress listeners, but returning 0 keeps
      // the path compatible with Node/Bun expectations.
      return 0
    },
    on(event: string, fn: (chunk: Buffer) => void) {
      if (event === "data") {
        dataListeners.push({ fn, raw: rawMode })
        listenerEpoch++
      }
      return fakeStdin
    },
    addListener(event: string, fn: (chunk: Buffer) => void) {
      return fakeStdin.on(event, fn)
    },
    once(event: string, fn: (chunk: Buffer) => void) {
      // `once` Node melepas listener setelah satu panggilan — tanpa ini
      // listener menumpuk dan send() fan-out ganda ke prompt yang sudah tutup.
      const wrapped = (chunk: Buffer) => {
        fakeStdin.off(event, wrapped)
        fn(chunk)
      }
      return fakeStdin.on(event, wrapped)
    },
    off(event: string, fn: (chunk: Buffer) => void) {
      if (event === "data") {
        const i = dataListeners.findIndex((l) => l.fn === fn)
        if (i >= 0) dataListeners.splice(i, 1)
      }
      return fakeStdin
    },
    removeListener(event: string, fn: (chunk: Buffer) => void) {
      return fakeStdin.off(event, fn)
    },
    removeAllListeners() {
      dataListeners.length = 0
      return fakeStdin
    },
  }

  Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true })
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true })
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true })
  // Renderer memakai deteksi warna dari env + isTTY. Runner test biasanya bukan
  // TTY, jadi tanpa ini semua warna dimatikan dan assertion warna jadi tak ada
  // artinya. Paksa truecolor supaya yang diuji adalah keluaran terminal nyata.
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true })
  Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true })
  if (opts.color !== false) {
    process.env.COLORTERM = "truecolor"
    delete process.env.NO_COLOR
  }
  // src/ui/render/theme.ts memeriksa TERM/WT_SESSION untuk memilih glyph dan
  // warna. Fake TTY harus tampak seperti terminal modern, kalau tidak assertion
  // gagal karena alasan yang salah (glyph jadi ASCII).
  if (opts.vt !== false && isTTY) {
    process.env.TERM = process.env.TERM || "xterm-256color"
    process.env.WT_SESSION = process.env.WT_SESSION || "fake-tty"
  }
  if (opts.vt === false) {
    // Simulasi terminal TANPA dukungan VT: openAltScreen menolak TERM=dumb.
    // DITULIS di sini (setelah origTerm ditangkap) supaya restore()
    // mengembalikan nilai ambient — mutasi manual di test lalu install
    // membuat restore() menghidupkan lagi nilai transient (bug nyata:
    // TERM=dumb bocor ke file test berikutnya).
    process.env.TERM = "dumb"
  }
  if (opts.ascii === true) process.env.MINICODE_ASCII = "1"
  // Locale UI dipin ke en selama fake TTY aktif (paritas COLORTERM/TERM di
  // atas): assertion string user-visible deterministik apa pun locale OS
  // mesin CI. Test yang butuh locale lain memanggil setSessionLocale
  // sendiri SETELAH install (setter menang atas pin ini).
  setSessionLocale("en")
  ;(process.stdout as unknown as { write: unknown }).write = (chunk: string | Uint8Array) => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
    chunks.push(s)
    combinedChunks.push(s)
    return true
  }
  ;(process.stderr as unknown as { write: unknown }).write = (chunk: string | Uint8Array) => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
    errChunks.push(s)
    combinedChunks.push(s)
    return true
  }
  // Di Bun, console.log TIDAK melewati process.stdout.write — ia menulis ke fd 1
  // langsung. Jadi menambal write saja membuat jalur fallback non-TTY (yang
  // memakai console.log) tampak tidak menghasilkan apa-apa.
  console.log = (...args: unknown[]) => {
    const s = `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`
    chunks.push(s)
    combinedChunks.push(s)
  }
  console.error = (...args: unknown[]) => {
    const s = `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`
    errChunks.push(s)
    combinedChunks.push(s)
  }
  // Beberapa komponen mendengarkan "resize" pada stdout; tangkap tanpa
  // mengganggu listener asli milik test runner.
  ;(process.stdout as unknown as { on: unknown }).on = (event: string, fn: () => void) => {
    if (event === "resize") {
      resizeListeners.push(fn)
      return process.stdout
    }
    return origStdoutOn(event as never, fn as never)
  }
  const dropResize = (event: string, fn: () => void) => {
    if (event === "resize") {
      const i = resizeListeners.indexOf(fn)
      if (i >= 0) resizeListeners.splice(i, 1)
      return process.stdout
    }
    return origStdoutOff(event as never, fn as never)
  }
  ;(process.stdout as unknown as { off: unknown }).off = dropResize
  ;(process.stdout as unknown as { removeListener: unknown }).removeListener = dropResize

  const tty: FakeTty = {
    async ready(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (dataListeners.length === 0) {
        if (Date.now() > deadline) {
          throw new Error("fake tty: tidak ada listener stdin terpasang dalam batas waktu")
        }
        await new Promise((r) => setTimeout(r, 5))
      }
      // Satu tick ekstra: komponen umumnya render() setelah memasang listener.
      await new Promise((r) => setTimeout(r, 5))
    },
    async send(data, settleMs = 15) {
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)
      for (const l of [...dataListeners]) l.fn(buf)
      await new Promise((r) => setTimeout(r, settleMs))
    },
    listenerEpoch: () => listenerEpoch,
    promptListeners: () => dataListeners.filter((l) => l.raw).length,
    async waitForNewListener(since, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (listenerEpoch <= since) {
        if (Date.now() > deadline) {
          throw new Error(
            `fake tty: tidak ada listener stdin baru dalam ${timeoutMs}ms (epoch tetap ${listenerEpoch})`,
          )
        }
        await new Promise((r) => setTimeout(r, 5))
      }
      // Satu tick: komponen menulis prompt-nya setelah memasang listener.
      await new Promise((r) => setTimeout(r, 5))
      return listenerEpoch
    },
    async waitForListener(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (dataListeners.length === 0) {
        if (Date.now() > deadline) {
          throw new Error("fake tty: tidak ada listener stdin dalam batas waktu")
        }
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    async waitForOutput(pred, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const out = chunks.join("")
        if (pred(out)) return out
        if (Date.now() > deadline) {
          throw new Error("fake tty: output yang ditunggu tidak muncul dalam batas waktu")
        }
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    async answerSequence(answers, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 2000
      const settleMs = opts.settleMs ?? 15
      let epoch = listenerEpoch
      for (let i = 0; i < answers.length; i++) {
        epoch = await tty.waitForNewListener(epoch, timeoutMs)
        const want = opts.expect?.[i]
        if (want) await tty.waitForOutput(want, timeoutMs)
        // Kirim hanya ke listener raw TERBARU: listener lama yang bocor
        // (lupa removeListener) tidak boleh menerima jawaban prompt baru.
        const raws = dataListeners.filter((l) => l.raw)
        const target = raws.length > 0 ? [raws[raws.length - 1]!] : [...dataListeners]
        const buf = Buffer.from(`${answers[i]}\r`, "utf8")
        for (const l of target) l.fn(buf)
        await new Promise((r) => setTimeout(r, settleMs))
      }
    },
    chunks: () => [...chunks],
    all: () => chunks.join(""),
    allErr: () => errChunks.join(""),
    combined: () => combinedChunks.join(""),
    clear() {
      chunks.length = 0
      errChunks.length = 0
      combinedChunks.length = 0
    },
    resize(nextColumns, nextRows) {
      columns = nextColumns
      rows = nextRows
      Object.defineProperty(process.stdout, "columns", {
        value: nextColumns,
        configurable: true,
      })
      Object.defineProperty(process.stdout, "rows", { value: nextRows, configurable: true })
      for (const fn of [...resizeListeners]) fn()
    },
    screen: () => parseScreenBuffer(chunks.join(""), columns, rows),
    /** Status raw mode saat ini (untuk assertion restore TUI-001). */
    isRaw: () => rawMode,
    failures: () => [...failures],
    restore() {
      process.off("unhandledRejection", onFailure)
      process.off("uncaughtException", onFailure)
      Object.defineProperty(process, "stdin", { value: origStdin, configurable: true })
      Object.defineProperty(process.stdout, "columns", {
        value: origColumns,
        configurable: true,
      })
      Object.defineProperty(process.stdout, "rows", { value: origRows, configurable: true })
      Object.defineProperty(process.stdout, "isTTY", {
        value: origStdoutIsTty,
        configurable: true,
      })
      Object.defineProperty(process.stderr, "isTTY", {
        value: origStderrIsTty,
        configurable: true,
      })
      if (origColorterm == null) delete process.env.COLORTERM
      else process.env.COLORTERM = origColorterm
      if (origNoColor == null) delete process.env.NO_COLOR
      else process.env.NO_COLOR = origNoColor
      if (origTerm == null) delete process.env.TERM
      else process.env.TERM = origTerm
      if (origWtSession == null) delete process.env.WT_SESSION
      else process.env.WT_SESSION = origWtSession
      if (origAscii == null) delete process.env.MINICODE_ASCII
      else process.env.MINICODE_ASCII = origAscii
      ;(process.stdout as unknown as { write: unknown }).write = origWrite
      ;(process.stderr as unknown as { write: unknown }).write = origErrWrite
      console.log = origLog
      console.error = origError
      ;(process.stdout as unknown as { on: unknown }).on = origStdoutOn
      ;(process.stdout as unknown as { off: unknown }).off = origStdoutOff
      ;(process.stdout as unknown as { removeListener: unknown }).removeListener = origStdoutRemove
      dataListeners.length = 0
      resizeListeners.length = 0
      listenerEpoch = 0
      rawMode = false
      resetLocaleState()
    },
  }
  return tty
}

// ── EventBus tiruan ──
// Kernel EventBus punya API on(type, handler) -> unsubscribe. Renderer hanya
// memakai itu, jadi stub ini cukup dan tidak menarik seluruh kernel ke test.
export interface FakeBus {
  on(type: string, fn: (e: unknown) => void): () => void
  emit(type: string, event: unknown): void
  listenerCount(type: string): number
}

export function createFakeBus(): FakeBus {
  const handlers = new Map<string, ((e: unknown) => void)[]>()
  return {
    on(type, fn) {
      const arr = handlers.get(type) ?? []
      arr.push(fn)
      handlers.set(type, arr)
      return () => {
        const cur = handlers.get(type)
        if (!cur) return
        const i = cur.indexOf(fn)
        if (i >= 0) cur.splice(i, 1)
      }
    },
    emit(type, event) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(event)
    },
    listenerCount: (type) => (handlers.get(type) ?? []).length,
  }
}

// ── Parser screen-buffer ──
// Menafsirkan ulang byte VT menjadi grid teks agar test TUI bisa menegaskan
// posisi/isi frame tanpa terminal nyata. Hanya yang dipakai painter minicode:
// HOME, ED (2J), EL (2K/0K/1K), kursor naik/turun (A/B), CR, LF, SGR (dibuang).
// Sisa CSI/OSC dikonsumsi tanpa efek supaya koordinat tak meleset.
import { resetLocaleState, setSessionLocale } from "../../src/ui/i18n/locale.ts"
import { displayWidth } from "../../src/ui/render/width"

export function parseScreenBuffer(out: string, columns: number, rows: number): string[] {
  const grid: string[][] = Array.from({ length: rows }, () => [])
  let x = 0
  let y = 0
  const clamp = () => {
    if (x < 0) x = 0
    if (x > columns) x = columns
    if (y < 0) y = 0
    if (y >= rows) y = rows - 1
  }
  const eraseLine = (mode: number) => {
    const row = grid[y]!
    if (mode === 2) {
      grid[y] = []
      return
    }
    if (mode === 1) {
      for (let i = 0; i <= x && i < row.length; i++) row[i] = " "
      return
    }
    for (let i = x; i < columns; i++) row[i] = " "
  }
  let i = 0
  while (i < out.length) {
    const ch = out[i]!
    if (ch === "\x1b") {
      const nxt = out[i + 1]
      if (nxt === "[") {
        let j = i + 2
        while (j < out.length && !/[a-zA-Z]/.test(out[j]!)) j++
        const body = out.slice(i + 2, j)
        const fin = out[j]
        i = j + 1
        if (fin === "H" || fin === "f") {
          // CUP: ESC[H atau ESC[row;colH. Tanpa param = home.
          if (body === "") {
            x = 0
            y = 0
          } else {
            const parts = body.split(";").map((p) => parseInt(p, 10))
            const r = Number.isNaN(parts[0]) ? 1 : (parts[0] ?? 1)
            const c = Number.isNaN(parts[1]) ? 1 : (parts[1] ?? 1)
            y = r - 1
            x = c - 1
          }
          clamp()
          continue
        }
        if (fin === "A" || fin === "B") {
          const n = parseInt(body, 10)
          const d = Number.isNaN(n) ? 1 : n
          y += fin === "A" ? -d : d
          clamp()
          continue
        }
        if (fin === "C" || fin === "D") {
          const n = parseInt(body, 10)
          const d = Number.isNaN(n) ? 1 : n
          x += fin === "C" ? d : -d
          clamp()
          continue
        }
        if (fin === "J") {
          // ED: 2J = seluruh grid (dipakai repaint penuh App).
          if (body === "" || body === "2") {
            for (const row of grid) row.length = 0
            x = 0
            y = 0
          }
          continue
        }
        if (fin === "K") {
          const n = parseInt(body, 10)
          eraseLine(Number.isNaN(n) ? 0 : n)
          continue
        }
        // SGR (m), mode privat (h/l — termasuk ?1049h/l, ?2026h/l),
        // DECSTBM (r), save/restore (s/u), dst: konsumsi tanpa efek.
        // ?1049h = masuk buffer alt -> grid baru (kosongkan).
        if ((fin === "h" || fin === "l") && body.includes("1049")) {
          if (fin === "h") {
            for (const row of grid) row.length = 0
            x = 0
            y = 0
          }
        }
        continue
      }
      if (nxt === "]") {
        // OSC ... BEL — lewati sampai BEL.
        const bel = out.indexOf("\x07", i + 2)
        i = bel === -1 ? out.length : bel + 1
        continue
      }
      // ESC tunggal (lone-Esc key di aliran output tak terjadi; aman lewati).
      i += nxt === undefined ? 1 : 2
      continue
    }
    if (ch === "\r") {
      x = 0
      i++
      continue
    }
    if (ch === "\n") {
      y++
      x = 0
      clamp()
      i++
      continue
    }
    // Karakter tampil (termasuk emoji/CJK 2 kolom — placeholder kolom kedua).
    const w = Math.max(1, displayWidth(ch))
    clamp()
    const row = grid[y]!
    row[x] = ch
    if (w >= 2 && x + 1 < columns) row[x + 1] = ""
    x += w
    i++
  }
  return grid.map((row) => {
    let s = ""
    for (let cxi = 0; cxi < columns; cxi++) s += row[cxi] ?? " "
    return s.replace(/ +$/, "")
  })
}
// ── Keystroke: nama simbolis supaya test terbaca ──
export const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  homeVt: "\x1b[1~",
  endVt: "\x1b[4~",
  pgUp: "\x1b[5~",
  pgDown: "\x1b[6~",
  enter: "\r",
  tab: "\t",
  shiftTab: "\x1b[Z",
  esc: "\x1b",
  backspace: "\x7f",
  del: "\x1b[3~",
  ctrlA: "\x01",
  ctrlC: "\x03",
  ctrlD: "\x04",
  ctrlE: "\x05",
  ctrlN: "\x0e",
  ctrlO: "\x0f",
  ctrlR: "\x12",
  ctrlT: "\x14",
  ctrlU: "\x15",
  ctrlW: "\x17",
  /** Klik mouse mode X10: ESC [ M + tombol + kolom + baris. */
  mouseClick: "\x1b[M\x20\x30\x30",
  paste: (text: string) => `\x1b[200~${text}\x1b[201~`,
} as const
