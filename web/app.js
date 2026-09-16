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
  // Reveal-on-scroll: kartu landing muncul halus sekali, lalu lepas pantau.
  // Target struktural yang sudah ada (tanpa ubah markup): kartu fitur,
  // item FAQ, dan heading section.
  if (canObserve) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add("in");
        io.unobserve(e.target);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    var rvs = document.querySelectorAll(".feat-list > *, .faq > details, section h2");
    for (var i = 0; i < rvs.length; i++) {
      var el = rvs[i];
      el.classList.add("rv");
      el.style.transitionDelay = (i % 4) * 70 + "ms";
      io.observe(el);
    }
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
