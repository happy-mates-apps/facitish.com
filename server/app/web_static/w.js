// /w — consent banner and self-hosted analytics for the public website.
// Shares localStorage keys with the app (web/src/tracker.ts), so one answer covers both.
(function () {
  var CONSENT = "gaer.consent", VISITOR = "gaer.visitor", SESSION = "gaer.session";
  function get(s, k) { try { return JSON.parse(s.getItem(k)); } catch (e) { return null; } }
  function set(s, k, v) { try { v === null ? s.removeItem(k) : s.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function rid(p) { var b = crypto.getRandomValues(new Uint8Array(16)); return p + Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  function consented() { var c = get(localStorage, CONSENT); return !!(c && c.statistics); }
  function ids() {
    if (!consented()) return {};
    var s = get(sessionStorage, SESSION);
    if (!s) { s = rid("s_"); set(sessionStorage, SESSION, s); }
    return { visitor_id: get(localStorage, VISITOR) || undefined, session_id: s };
  }
  function send(e) {
    var o = ids(); for (var k in o) e[k] = o[k];
    var blob = new Blob([JSON.stringify([e])], { type: "text/plain" });
    if (!(navigator.sendBeacon && navigator.sendBeacon("/api/collect", blob))) fetch("/api/collect", { method: "POST", body: JSON.stringify([e]), keepalive: true });
  }
  var path = location.pathname, depth = 0;
  send({ kind: "pageview", path: path, referrer: document.referrer, viewport_w: innerWidth });
  function measure() { var d = document.documentElement; depth = Math.max(depth, Math.min(1, (scrollY + innerHeight) / Math.max(d.scrollHeight, 1))); }
  addEventListener("scroll", measure, { passive: true }); measure();
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden" && consented()) send({ kind: "scroll", path: path, depth: depth }); });
  document.addEventListener("click", function (ev) {
    if (!consented()) return;
    var d = document.documentElement;
    send({ kind: "click", path: path, x: ev.pageX / Math.max(d.scrollWidth, 1), y: ev.pageY / Math.max(d.scrollHeight, 1), viewport_w: innerWidth });
  }, true);

  fetch("/api/public/config").then(function (r) { return r.json(); }).then(function (cfg) {
    var c = get(localStorage, CONSENT);
    if (c && c.version >= cfg.consent_version) return;
    var box = document.createElement("div");
    box.className = "consent"; box.setAttribute("role", "dialog");
    var h = document.createElement("h3"); h.textContent = cfg.consent_title;
    var p = document.createElement("p"); p.textContent = cfg.consent_text + " ";
    var a = document.createElement("a"); a.href = "/privatliv"; a.textContent = document.documentElement.lang === "en" ? "Read more" : "Læs mere"; p.appendChild(a);
    var yes = document.createElement("button"); yes.className = "yes"; yes.textContent = cfg.consent_accept;
    var no = document.createElement("button"); no.textContent = cfg.consent_decline;
    function answer(stat) {
      var v = get(localStorage, VISITOR);
      if (stat && !v) { v = rid("v_"); set(localStorage, VISITOR, v); }
      set(localStorage, CONSENT, { statistics: stat, version: cfg.consent_version });
      fetch("/api/consent", { method: "POST", headers: { "Content-Type": "application/json", "X-Gaer": "1" }, body: JSON.stringify({ statistics: stat, version: cfg.consent_version, visitor_id: v }) });
      if (!stat) { set(localStorage, VISITOR, null); set(sessionStorage, SESSION, null); }
      box.remove();
    }
    yes.onclick = function () { answer(true); }; no.onclick = function () { answer(false); };
    box.append(h, p, yes, no); document.body.appendChild(box);
  });
})();
