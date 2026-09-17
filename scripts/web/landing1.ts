// Potongan konten landing (bagian 1): hero + install + proof + cara kerja.
// Rombak total 2026-09-17 — konsep "Bukti, bukan janji": halaman terbaca
// seperti sesi minicode. Transkrip nyata = objek hero; install = CTA primer
// (aksi pertama yang nyata dilakukan developer); klaim menyusul dengan link
// verifikasi ke docs. Semua H1/link/id menjaga guard test narasi landing.
export function landingHero(version: string): string {
  const install = "npm install -g minicode-ai"
  return `<section class="hero">
<p class="kicker">v${version}, MIT, zero-dep, Bun</p>
<h1>Coding agent CLI yang menunjukkan semua kerjanya.</h1>
<p class="lead">Untuk developer yang hidup di terminal: Minicode membaca kode, menjalankan tool, dan melaporkan tiap langkah di scrollback — meminta izin sebelum bertindak, tanpa layar khusus.</p>
<div class="install" id="install">
<code class="install-cmd" translate="no">${install}</code>
<button class="copybtn" data-copy="${install}" aria-label="Salin perintah instalasi"><span class="material-symbols-outlined" aria-hidden="true">content_copy</span></button>
</div>
<p class="hero-links"><a href="/docs/quickstart.html">Mulai dalam 5 menit</a><a href="#cara-kerja">Lihat cara kerja</a></p>
<figure class="shot term" role="img" aria-label="Contoh sesi Minicode: tulis file, jalankan server, tampil ringkasan biaya">
<figcaption class="term-cap"><span class="material-symbols-outlined" aria-hidden="true">terminal</span>Transkrip asli yang dirender: receipt tiap tool, biaya sesi.</figcaption>
<svg viewBox="0 0 640 188" width="100%" role="presentation" aria-hidden="true"><rect width="640" height="188" rx="8" fill="#161618"/><text x="20" y="34" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#e6e8ee">$ minicode &#8220;buat http server di server.ts&#8221;</text><text x="20" y="62" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#7fd1a3">  › write_file server.ts (214 chars)</text><text x="20" y="90" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#7fd1a3">  › $ bun run server.ts</text><text x="36" y="114" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#8b8f98">Hello world di http://localhost:3000</text><text x="20" y="142" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#8b8f98">  128 token · $0.0004 · 2 langkah · 4s</text><text x="20" y="170" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#e6e8ee">Server jalan. Mau saya tambah route /health?</text></svg>
</figure>
</section>`
}

export function landingHow(): string {
  const steps: [string, string][] = [
    [
      "Perintah",
      "Tulis tujuan dalam bahasa Indonesia atau Inggris — sekali jalan, interaktif, atau via pipe.",
    ],
    [
      "Izin",
      "Tiap aksi sensitif lewat mode izin Anda: baca saja, rencanakan dulu, setujui satu-satu, atau otonom penuh.",
    ],
    [
      "Eksekusi",
      "File, shell, git, web, dan memori dijalankan lewat tool terjail di workspace Anda.",
    ],
    ["Hasil", "Receipt tiap langkah menempel di scrollback — bisa di-pipe, di-grep, di-copy."],
    ["Verifikasi", "Uji otomatis memastikan perubahan benar sebelum dianggap selesai."],
  ]
  return `<section id="cara-kerja" class="band"><h2>Cara kerja.</h2><p class="sub">Lima langkah yang sama setiap kali, tanpa kejutan.</p><ol class="how-list">${steps
    .map(([h, p]) => `<li class="feat"><h3>${h}</h3><p>${p}</p></li>`)
    .join("")}</ol></section>`
}

// Riset konten 2026-09-17 (aider/claude code/opencode): semua pemain
// memamerkan CONTOH TUGAS yang bisa disalin — pembaca harus melihat kata
// kerja apa yang diserahkan ke agent. Ini pemuat konversi yang hilang dari
// landing Minicode. Perintah di bawah = nyata (router/exec/verify), masing-
// masing satu klik salin lewat data-copy yang sudah ada di app.js.
export function landingTasks(): string {
  const tasks: [string, string][] = [
    [
      "Perbaiki test yang merah",
      `minicode "jalankan test, perbaiki yang gagal, ulangi sampai hijau"`,
    ],
    [
      "Rapikan dependensi kuno",
      `minicode "upgrade dependensi satu-satu, jalankan test tiap upgrade"`,
    ],
    ["Jelaskan kode orang lain", `minicode --plan "jelaskan arsitektur folder src/ ini"`],
    ["Commit dengan pesan rapi", `minicode "commit perubahan ini dengan pesan konvensional"`],
  ]
  const rows = tasks
    .map(
      ([label, cmd]) =>
        `<div class="task"><p class="task-label">${label}</p><div class="task-cmd"><code translate="no">${cmd}</code><button class="copybtn" data-copy="${cmd.replace(/"/g, "&quot;")}" aria-label="Salin: ${label}"><span class="material-symbols-outlined" aria-hidden="true">content_copy</span></button></div></div>`,
    )
    .join("")
  return `<section id="tugas"><h2>Serahkan tugas.</h2><p class="sub">Perintah nyata yang bisa disalin langsung — bukan mockup. Semua jalan di workspace Anda, dengan izin yang Anda tetapkan.</p><div class="task-list">${rows}</div><p class="task-more"><a href="/docs/exec.html">Lihat semua cara menjalankan</a></p></section>`
}
