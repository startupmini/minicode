// Potongan konten landing (bagian 1): hero + install + proof + cara kerja.
export function landingHero(version: string): string {
  const install = "npm install -g @miniroom/minicode"
  const installRaw = "npm install -g @miniroom/minicode"
  return `<section class="hero">
<div class="kicker">v${version}, MIT, zero-dep</div>
<h1>Coding agent CLI yang menunjukkan semua kerjanya.</h1>
<p class="lead">Untuk developer yang hidup di terminal: Minicode membaca kode, menjalankan tool, dan melaporkan tiap langkah di scrollback — meminta izin sebelum bertindak, tanpa layar khusus.</p>
<div class="cta">
<a class="btn btn-p" href="/docs/quickstart.html">Mulai dalam 5 menit</a>
<a class="btn btn-s" href="#cara-kerja">Lihat cara kerja</a>
</div>
<div class="term" id="install"><div class="term-cap"><span class="material-symbols-outlined" aria-hidden="true">terminal</span>instalasi<span class="sp"><button class="copybtn" data-copy="${installRaw}" aria-label="Salin perintah instalasi"><span class="material-symbols-outlined" aria-hidden="true">content_copy</span></button></span></div><pre><code translate="no">${install}</code></pre></div>
<p class="sub"><strong>Belum punya Bun?</strong> Pasang dulu (sekali): <code>powershell -c "irm bun.sh/install.ps1 | iex"</code> di Windows, atau <code>curl -fsSL https://bun.sh/install | bash</code> di macOS/Linux — lalu tutup-buka terminal dan cek <code>bun --version</code>. Tanpa Bun, <code>minicode</code> gagal dengan <code>'bun' is not recognized</code> — lihat <a href="/docs/getting-started.html">Instalasi lengkap</a> bila mentok. Setelah itu: <code>minicode doctor</code> untuk cek kondisi, <code>minicode "tugas pertama"</code> untuk mulai.</p>
<figure class="shot" role="img" aria-label="Contoh sesi Minicode: tulis file, jalankan server, tampil ringkasan biaya">
<svg viewBox="0 0 640 188" width="100%" role="presentation" aria-hidden="true"><rect width="640" height="188" rx="8" fill="#161618"/><text x="20" y="34" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#e6e8ee">$ minicode &#8220;buat http server di server.ts&#8221;</text><text x="20" y="62" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#7fd1a3">  › write_file server.ts (214 chars)</text><text x="20" y="90" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#7fd1a3">  › $ bun run server.ts</text><text x="36" y="114" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#8b8f98">Hello world di http://localhost:3000</text><text x="20" y="142" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#8b8f98">  128 token · $0.0004 · 2 langkah · 4s</text><text x="20" y="170" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="13" fill="#e6e8ee">Server jalan. Mau saya tambah route /health?</text></svg>
<figcaption>Transkrip asli yang dirender: receipt tiap tool, biaya sesi, tanpa layar khusus.</figcaption>
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
  return `<section id="cara-kerja"><h2>Cara kerja.</h2><p class="sub">Lima langkah yang sama setiap kali, tanpa kejutan.</p><ol class="feat-list how-list">${steps
    .map(([h, p]) => `<li class="feat"><h3>${h}</h3><p>${p}</p></li>`)
    .join("")}</ol></section>`
}

export function landingWhy(): string {
  const items = [
    [
      "Semuanya terlihat",
      "Tanpa layar khusus yang menutupi terminal. Yang Anda lihat di scrollback = yang benar-benar terjadi.",
    ],
    [
      "Izin bertingkat",
      "Enam mode dari read-only sampai otonom. Bahkan mode paling bebas tetap dijail ke workspace.",
    ],
    [
      "Tak mengulang yang belum pasti",
      "Efek yang statusnya ambigu setelah gangguan diverifikasi dulu — tidak dieksekusi ulang buta.",
    ],
  ]
  const cards = items.map(([h, p]) => `<div class="feat"><h3>${h}</h3><p>${p}</p></div>`).join("")
  return `<section><h2>Kenapa berbeda.</h2><p class="sub">Tiga janji yang bisa diverifikasi langsung di source code open source-nya. <a href="/docs/security-model.html">Model keamanan</a> menjelaskan batasnya dengan jujur.</p><div class="feat-list">${cards}</div></section>`
}
