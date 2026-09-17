// JS web minicode: tema + copy button + reveal-on-scroll + scrollspy.
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
  // Reveal-on-scroll per-kartu DIHAPUS (arah desain 2026-09-17): entrance
  // bertaburan di tiap section adalah pola default yang membosankan — sisakan
  // SATU momen gerak: entrance hero saat load. Scrollspy TOC tetap: ia
  // menjawab aksi (posisi baca), bukan dekorasi.
  // Desktop: menu docs harus SELALU terbuka (re-envision nav). <details>
  // punya toggle bawaan — paksa kembali `open` tiap kali ditutup di layar
  // lebar; mobile bebas buka-tutup (summary satu tap, sticky di bawah topbar).
  // matchMedia change: menutup path RESIZE (adversarial review) — user tutup
  // menu di mobile lalu lebarkan layar: CSS pindah branch desktop (summary
  // disembunyikan) tanpa event toggle apapun → dulu nav hilang total.
  // Tanpa JS: desktop tetap terbuka dari markup `open` (toggle manual satu
  // klik akan menutup sampai navigasi berikutnya — diterima sebagai degradasi).
  var fold = document.querySelector(".doc-side .ds-fold");
  var desktopNav = window.matchMedia("(min-width: 901px)");
  if (fold) {
    var lockFold = function (e) { if (e.matches) fold.open = true; };
    if (desktopNav.addEventListener) desktopNav.addEventListener("change", lockFold);
    else if (desktopNav.addListener) desktopNav.addListener(lockFold); // Safari lama
    fold.addEventListener("toggle", function () {
      if (desktopNav.matches) fold.open = true;
    });
  }
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
