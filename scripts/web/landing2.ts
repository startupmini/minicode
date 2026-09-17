// Potongan konten landing (bagian 2): kapabilitas, kecocokan, FAQ.
// Ikon kartu dihapus (arah desain 2026-09-17): hierarki dari tipografi, bukan
// dekorasi; elemen datar tanpa background — kartu berfungsi sebagai blok teks.
export function landingFeatures(): string {
  const feats = [
    [
      "Semua operasi lewat satu gerbang",
      "File, shell, git, web, dan memori dijalankan sebagai tool terjail — 37 tool bawaan plus MCP/LSP bila Anda daftarkan.",
      "/docs/tools.html",
      "Referensi tools",
    ],
    [
      "Otonomi sesuai selera",
      "Baca saja, rencanakan dulu, setujui satu-satu, atau otonom penuh dengan sandbox dan budget. Ganti kapan pun.",
      "/docs/choosing-mode.html",
      "Pilih mode",
    ],
    [
      "Ingat dan bisa kembali",
      "Memori lintas sesi yang bisa dilupakan; checkpoint tiap turn dengan /undo; sesi bisa dilanjutkan.",
      "/docs/memory-sessions.html",
      "Memory & sessions",
    ],
    [
      "Ganti model tanpa pindah alat",
      "14 gateway termasuk lokal via Ollama; router fallback saat rate-limit; OAuth tanpa API key untuk provider yang mendukung.",
      "/docs/config-providers.html",
      "Config & provider",
    ],
    [
      "Hasil yang diperiksa",
      "--verify menguji baseline dulu lalu self-heal; JSONL deterministik untuk CI.",
      "/docs/verify-benchmark.html",
      "Verify & benchmark",
    ],
    [
      "Otomasi yang jujur",
      "Headless dengan event JSON terstruktur; gagal dilaporkan apa adanya, bukan disamarkan.",
      "/docs/exec.html",
      "Otomasi & CI",
    ],
  ]
  const cards = feats
    .map(
      ([h, p, href, more]) =>
        `<div class="feat"><h3>${h}</h3><p>${p}</p><a class="more" href="${href}">${more}</a></div>`,
    )
    .join("")
  return `<section id="fitur"><h2>Kemampuan.</h2><p class="sub">Apa yang bisa dilakukan — tiap klaim bisa diverifikasi di dokumentasi dan source.</p><div class="feat-list">${cards}</div></section>`
}

export function landingFit(): string {
  const yes = [
    "Bekerja seharian di terminal dan ingin agen yang transparan",
    "Ingin kontrol izin: baca dulu, setujui yang penting, otonom bila aman",
    "Menjalankan agen di CI/headless yang deterministik",
    "Mengevaluasi keamanan dan membaca source sebelum percaya",
  ]
  const no = [
    "Butuh agen visual di dalam IDE",
    "Tidak nyaman dengan CLI atau menginstal Bun",
    "Mencari hosted environment / ekosistem plugin raksasa",
  ]
  const list = (items: string[]) => `<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>`
  // id dipakai dua hal: deep-link (/#cocok) dan pengukuran jangkauan section
  // eksperimen urutan — section tanpa id tak bisa dibedakan saat dilaporkan.
  return `<section id="cocok"><h2>Kapan Minicode cocok?</h2><div class="feat-list"><div class="feat"><h3>Cocok bila Anda…</h3>${list(yes)}</div><div class="feat"><h3>Bukan pilihan tepat bila…</h3>${list(no)}</div></div></section>`
}

export function landingSafety(): string {
  return `<section id="batasan"><h2>Batasan yang jujur.</h2><p class="sub">Model bisa salah paham — karena itu efek penting butuh izin, variabel kredensial di-strip dari subprocess, dan repo asing tidak dipercaya secara default. Yang belum bisa dijamin juga ditulis terbuka.</p><p class="flow">Izin → Jail → Guard → Validasi → Eksekusi → Jurnal</p><div class="cta"><a class="btn btn-s" href="/docs/security-model.html">Baca Security Model</a></div></section>`
}

// Satu sumber FAQ (2026-09-17): HTML landing dan JSON-LD FAQPage dibangun
// dari array yang sama — dulu duplikat dua tempat bisa saling stale.
// Jawaban berformat HTML ringan (<code>, &amp;) — di JSON-LD di-strip
// menjadi teks polos (schema.org text tidak mem-parse HTML).
export const FAQS: [string, string][] = [
  [
    "Apakah Minicode butuh API key?",
    "Tergantung provider. Yang mendukung OAuth (mis. Qwen): <code>minicode auth login qwen</code> memakai device-code, tanpa API key. Provider lain tetap memakai API key — detail di Config &amp; Provider.",
  ],
  [
    "Apakah Minicode jalan di Windows?",
    "Ya, via Bun. Isolasi OS-native tidak ada di Windows — default turun ke allowlist, atau <code>--sandbox docker</code>.",
  ],
  [
    "Kenapa biaya model tampil N/A?",
    "<code>minicode pricing sync</code> lalu <code>pricing show &lt;model&gt;</code>.",
  ],
  ["Apa yang dipulihkan /undo?", "Perubahan file turn terakhir yang dilacak git."],
  [
    "Kenapa MCP localhost ditolak?",
    "Anti-SSRF. Usulkan <code>--allow-private</code> saat <code>config mcp add</code>.",
  ],
  ["Apakah Minicode butuh Node.js?", "Tidak. Wajib Bun ≥ 1.0 karena <code>bun:sqlite</code>."],
  [
    "Siapa yang membayar biaya model?",
    "Anda, ke provider pilihan Anda. Minicode gratis (MIT) tanpa analitik keluar; telemetri lokal bisa dimatikan. <code>--budget</code> + <code>pricing sync</code> mengontrol biaya.",
  ],
]

export function faqPageJsonld(base: string): string {
  const strip = (s: string): string =>
    s
      .replaceAll("<code>", "")
      .replaceAll("</code>", "")
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    url: `${base}/#faq`,
    mainEntity: FAQS.map(([q, a]) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: strip(a) },
    })),
  }).replaceAll("</", "<\\/")
}

export function landingFaq(): string {
  const faqs = FAQS.map(([q, a]) => [q, a] as [string, string])
  const items = faqs
    .map(
      ([q, a]) => `<details><summary>${q}</summary><div class="faq-a"><p>${a}</p></div></details>`,
    )
    .join("")
  return `<section id="faq"><h2>FAQ</h2><div class="faq">${items}</div><div class="cta"><a class="btn btn-s" href="/docs/troubleshooting.html">Troubleshooting</a></div></section>`
}
