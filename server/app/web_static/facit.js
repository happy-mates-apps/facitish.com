// /w/ front page — "Facit · 246": tap the number, count the toothpicks, show the working, next section.
(function () {
  var num = document.getElementById("facit-num");
  if (!num) return;

  // tap the number: one more line each time
  var tap = document.querySelector(".facit .tap");
  var lines = document.querySelectorAll(".facit .whisper");
  var n = 0;
  num.addEventListener("click", function () {
    if (n >= lines.length) return;
    if (tap) tap.hidden = true;
    if (n > 0) lines[n - 1].hidden = true;
    lines[n].hidden = false;
    n++;
  });

  // "count them" / "show the working": toggle .is-on on the section
  document.querySelectorAll(".facit [data-toggle]").forEach(function (btn) {
    var section = document.getElementById(btn.getAttribute("data-toggle"));
    btn.addEventListener("click", function () {
      var on = section.classList.toggle("is-on");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  });

  // floating button: next section, or back to the top from the last one
  var ids = ["top", "gulvet", "aesken", "facit"];
  var go = document.getElementById("facit-go");
  var sec = 0;
  function where() {
    var mid = innerHeight * 0.4, s = 0;
    ids.forEach(function (id, i) {
      var el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top <= mid) s = i;
    });
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 8) s = ids.length - 1;
    sec = s;
    go.classList.toggle("at-end", s >= ids.length - 1);
  }
  go.hidden = false;
  go.addEventListener("click", function () {
    var el = document.getElementById(sec >= ids.length - 1 ? "top" : ids[sec + 1]);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  addEventListener("scroll", where, { passive: true });
  addEventListener("resize", where);
  where();
})();
