// JS web minicode: tema + copy button + nav docs + scrollspy TOC.
// Tanpa dependensi, tanpa framework. Semua enhancement progresif: tanpa JS
// (atau reduced-motion) halaman tampil utuh — gate class .js di bawah.
(function () {
  var root = document.documentElement;
  root.classList.add("js");
  var reduceMotion = false;
  try {
    reduceMotion =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (_) {}
  var canObserve = !reduceMotion && "IntersectionObserver" in window;
  try {
    var saved = localStorage.getItem("minicode-theme");
    if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved);
  } catch (_) {}
  function checkMi() {
    try {
      if (!document.fonts || !document.fonts.check) return;
      if (!document.fonts.check('20px "Material Symbols Outlined"')) document.body.classList.add("no-mi");
    } catch (_) {}
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(checkMi);
  else window.addEventListener("load", checkMi);
  var themeBtn = document.getElementById("themebtn");
  if (themeBtn) themeBtn.setAttribute("aria-pressed", root.getAttribute("data-theme") === "dark" ? "true" : "false");
  if (themeBtn) themeBtn.addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    themeBtn.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
    try { localStorage.setItem("minicode-theme", next); } catch (_) {}
    // Ikon saja: bulan (dark_mode) saat light, matahari (light_mode) saat dark.
    themeBtn.querySelector(".material-symbols-outlined").textContent = next === "dark" ? "light_mode" : "dark_mode";
  });
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      function done() {
        var ic = btn.querySelector(".material-symbols-outlined");
        if (ic) { var old = ic.textContent; ic.textContent = "check"; setTimeout(function () { ic.textContent = old; }, 1200); }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    });
  });
  // Desktop: nav docs SELALU terbuka (re-envision nav). Lock dua jalur:
  // matchMedia "change" menutup path resize (user tutup menu di mobile lalu
  // lebarkan layar — CSS pindah branch tanpa event toggle; dulu nav hilang),
  // "toggle" menutup path klik user. Tanpa JS: tetap terbuka dari markup.
  var fold = document.querySelector(".doc-side .ds-fold");
  var desktopNav = window.matchMedia("(min-width: 901px)");
  if (fold) {
    var lockFold = function (e) { if (e.matches) fold.open = true; };
    if (desktopNav.addEventListener) desktopNav.addEventListener("change", lockFold);
    else if (desktopNav.addListener) desktopNav.addListener(lockFold); // Safari lama
    fold.addEventListener("toggle", function () {
      if (desktopNav.matches) fold.open = true;
    });
    // Mobile: menu mulai TERTUTUP (konten dulu, menu satu tap). Markup memakai
    // `open` agar tanpa JS desktop utuh dan mobile terdegradasi terbuka; JS
    // yang menghormati niat "konten pertama" menutupnya hanya di layar kecil.
    if (!desktopNav.matches) fold.open = false;
  }
  // ── Eksperimen urutan landing + analitik LOKAL ──
  // A/B: "Serahkan tugas" sebelum vs sesudah "Cara kerja". Urutan visual
  // ditukar CSS `order` dari `data-order` yang dipasang pre-paint di <head>
  // (tanpa kedip; DOM tetap kanonik). SEMUA angka disimpan di localStorage
  // browser ini — tidak ada satu pun request keluar, sesuai janji situs
  // "tanpa analitik keluar". Opt-out: DNT=1 atau ?exp=off. Laporan lokal:
  // ?exp=report (hanya menampilkan data browser ini), hapus: ?exp=reset.
  (function () {
    var KEY = "minicode-exp-v1";
    var OFF = "minicode-exp-off";
    // Nama laporan = id section; .hero tak punya id, jadi diberi nama tetap.
    var SECTIONS = [
      [".hero", "hero"],
      ["#cara-kerja", "cara-kerja"],
      ["#tugas", "tugas"],
      ["#fitur", "fitur"],
      ["#cocok", "cocok"],
      ["#batasan", "batasan"],
      ["#faq", "faq"],
    ];
    var land = document.body.classList.contains("home") && !!document.querySelector("#tugas");
    var cmd = (/[?&]exp=([a-z]+)(?:&|$)/.exec(location.search) || [])[1] || "";
    var forced = /[?&]order=[ab](?:&|$)/.test(location.search);
    var variant = document.documentElement.getAttribute("data-order") === "b" ? "b" : "a";

    function read() {
      try {
        var db = JSON.parse(localStorage.getItem(KEY)) || {};
        return db.sessions ? db : { v: 1, sessions: [] };
      } catch (e) {
        return { v: 1, sessions: [] };
      }
    }
    function store(json) {
      try { localStorage.setItem(KEY, json); } catch (e) {}
    }

    // Opt-out: DNT browser, atau pilihan pemilik/penguji lewat ?exp=off|on.
    var off = false;
    try { off = localStorage.getItem(OFF) === "1"; } catch (e) {}
    if (cmd === "off") { try { localStorage.setItem(OFF, "1"); } catch (e) {} off = true; }
    if (cmd === "on") { try { localStorage.removeItem(OFF); } catch (e) {} off = false; }
    // Reset = hapus SEMUA data lokal eksperimen (pengukuran + penetapan varian),
    // bukan hanya pengukuran: pemilik/penguji yang minta "hapus data" harus
    // benar-benar kembali ke keadaan tanpa data. Flag opt-out TIDAK dihapus —
    // itu saklar terpisah (?exp=off / ?exp=on).
    if (cmd === "reset") {
      try { localStorage.removeItem(KEY); } catch (e) {}
      try { localStorage.removeItem("minicode-exp-order"); } catch (e) {}
    }
    var dnt = false;
    try { dnt = navigator.doNotTrack === "1" || window.doNotTrack === "1"; } catch (e) {}

    // Session diidentifikasi supaya penulisan ULANG idempoten: flush berkali-kali
    // tidak menghitung kunjungan ganda (dulu flush hanya di pagehide → bacaan
    // panjang setelah ganti-tab hilang).
    var sid = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 7);
    var depth = 0;
    var nextMark = 25;
    var reached = [];
    var actions = 0;
    var ms = 0;
    var t0 = document.visibilityState === "visible" ? Date.now() : 0;

    function flush() {
      if (t0) { ms += Date.now() - t0; t0 = Date.now(); }
      if (!land || off || dnt || cmd || forced) return;
      var db = read();
      var s = { id: sid, ts: Date.now(), variant: variant, depth: depth, reach: reached.slice(), act: actions, ms: ms };
      var at = -1;
      for (var i = 0; i < db.sessions.length; i++) if (db.sessions[i].id === sid) at = i;
      if (at >= 0) db.sessions[at] = s; else db.sessions.push(s);
      if (db.sessions.length > 400) db.sessions = db.sessions.slice(-400);
      store(JSON.stringify(db));
    }

    if (land && !off && !dnt && !cmd && !forced) {
      var onScroll = function () {
        var h = document.documentElement.scrollHeight - window.innerHeight;
        var p = h > 0 ? Math.round((window.scrollY / h) * 100) : 100;
        if (p > depth) depth = p;
        if (depth >= nextMark) { nextMark += 25; flush(); }
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
      if ("IntersectionObserver" in window) {
        var io = new IntersectionObserver(
          function (es) {
            es.forEach(function (e) {
              if (!e.isIntersecting) return;
              var name = e.target.id || "hero";
              if (reached.indexOf(name) < 0) { reached.push(name); flush(); }
            });
          },
          // Band tengah viewport: section dianggap "dijangkau" saat benar-benar
          // sampai mata pembaca, bukan saat tepinya menyentuh layar.
          { rootMargin: "-40% 0px -40% 0px" }
        );
        SECTIONS.forEach(function (p) {
          var el = document.querySelector(p[0]);
          if (el) io.observe(el);
        });
      }
      var tugas = document.querySelector("#tugas");
      if (tugas) tugas.addEventListener("click", function (e) {
        if (e.target.closest("a, button")) { actions++; flush(); }
      });
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") t0 = Date.now();
        else flush();
      });
      window.addEventListener("pagehide", flush);
    }

    // Laporan lokal: agregasi dihitung saat diminta, tidak disimpan.
    if (cmd === "report") {
      var rec = function (db) {
        var out = { a: { n: 0, d: [], act: 0, ms: 0, reach: {} }, b: { n: 0, d: [], act: 0, ms: 0, reach: {} } };
        db.sessions.forEach(function (s) {
          var o = out[s.variant === "b" ? "b" : "a"];
          o.n++;
          o.d.push(s.depth || 0);
          o.act += s.act || 0;
          o.ms += s.ms || 0;
          (s.reach || []).forEach(function (id) { o.reach[id] = (o.reach[id] || 0) + 1; });
        });
        ["a", "b"].forEach(function (k) {
          var o = out[k];
          o.d.sort(function (x, y) { return x - y; });
          o.mean = o.n ? Math.round(o.d.reduce(function (x, y) { return x + y; }, 0) / o.n) : 0;
          o.p50 = o.n ? o.d[Math.floor((o.n - 1) * 0.5)] : 0;
          o.p75 = o.n ? o.d[Math.floor((o.n - 1) * 0.75)] : 0;
        });
        return out;
      };
      var db = read();
      var r = rec(db);
      var row = function (label, k) {
        var o = r[k];
        var secs = o.n ? Math.round(o.ms / o.n / 1000) : 0;
        return "<tr><td>" + label + "</td><td>" + o.n + "</td><td>" + o.mean + "%</td><td>" + o.p50 + "%</td><td>" + o.p75 + "%</td><td>" + o.act + "</td><td>" + secs + " s</td></tr>";
      };
      var reachLine = SECTIONS.map(function (p) {
        var of = function (k) { return r[k].n ? Math.round((r[k].reach[p[1]] || 0) / r[k].n * 100) : 0; };
        return "<tr><td>" + p[1] + "</td><td>" + of("a") + "%</td><td>" + of("b") + "%</td></tr>";
      }).join("");
      // n kecil = belum bisa disimpulkan. Ditulis apa adanya (pola repo: angka
      // tak difabrikasi); ambang 30 hanya penanda kasar, bukan uji signifikansi.
      var warn = Math.min(r.a.n, r.b.n) < 30 ? "Sampel masih kecil (n<30 per varian) — belum bisa disimpulkan." : "";
      var box = document.createElement("div");
      box.className = "exp";
      box.innerHTML =
        '<div class="exp-in"><h2>Eksperimen urutan landing — laporan lokal</h2>' +
        '<p class="exp-sub">Varian aktif di browser ini: <strong>' + variant + '</strong> (' +
        (variant === "b" ? "Tugas dulu" : "Cara kerja dulu") + "). Data dari <strong>browser ini sendiri</strong>, " +
        "tanpa kirim ke mana pun (" + db.sessions.length + " sesi tersimpan).</p>" +
        '<table><caption>Per varian</caption><thead><tr><th>Varian</th><th>Kunjungan</th><th>Kedalaman rata²</th><th>p50</th><th>p75</th><th>Aksi di Tugas</th><th>Waktu aktif</th></tr></thead>' +
        "<tbody>" + row("A — Cara kerja dulu", "a") + row("B — Tugas dulu", "b") + "</tbody></table>" +
        '<table style="margin-top:16px"><caption>Jangkauan section</caption><thead><tr><th>Section</th><th>A</th><th>B</th></tr></thead><tbody>' + reachLine + "</tbody></table>" +
        (warn ? '<p class="exp-warn">' + warn + "</p>" : "") +
        '<p class="exp-warn">Agregasi lintas pengunjung tidak dilakukan otomatis: situs ini tanpa analitik keluar. Salin JSON di bawah dari tiap penguji lalu gabungkan manual. `?order=a|b` memaksa varian (pengukuran dilewati saat dipaksa).</p>' +
        '<div class="exp-actions"><button class="copybtn" id="expcopy">Salin JSON</button>' +
        '<a href="?exp=reset">Hapus data &amp; reset varian</a><a href="?exp=off">Matikan pengukuran</a></div></div>';
      document.querySelector("main").insertBefore(box, document.querySelector("main").firstChild);
      var btn = box.querySelector("#expcopy");
      btn.addEventListener("click", function () {
        var json = JSON.stringify(db);
        var done = function () { btn.textContent = "Tersalin"; setTimeout(function () { btn.textContent = "Salin JSON"; }, 1200); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json).then(done, done);
        else done();
      });
    }
  })();

  // Scrollspy TOC dokumen: tandai link section yang sedang terlihat.
  var tocAs = Array.prototype.slice.call(document.querySelectorAll(".toc a[href^='#']"));
  if (tocAs.length && canObserve) {
    var byId = {};
    tocAs.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
    var spy = new IntersectionObserver(
      function (es) {
        es.forEach(function (e) {
          if (!e.isIntersecting) return;
          tocAs.forEach(function (a) { a.classList.remove("on"); });
          var t = byId[e.target.id];
          if (t) t.classList.add("on");
        });
      },
      { rootMargin: "-20% 0px -70% 0px" }
    );
    document.querySelectorAll(".doc-body h2[id]").forEach(function (h) { spy.observe(h); });
  }
})();
