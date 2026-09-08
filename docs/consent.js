/* ============================================================================
   Apex — consent (Group 4)
   2026-09-08.v24.9-hardening

   Optional analytics is OPT-IN. Nothing analytics-related touches the network
   until someone chooses it.

   DESIGN NOTES
   ---------------------------------------------------------------------------
   * No Google "advanced" consent mode. That still sends cookieless pings before
     a choice is made, which is not what "no consent means no request" means.
     Here, no consent means gtag.js is never injected at all.
   * Storage is localStorage, not a cookie. The site is static, so a cookie
     would be transmitted to the host on every request for no benefit;
     localStorage stays on the device. This IS application-created storage and
     is documented as such in the Cookie Policy.
   * Nothing here is required for the site to work. Every path is wrapped so a
     failure in this file cannot stop rendering, forms, login, Supabase or
     Helcim. Analytics is never a dependency.
   ============================================================================ */
(function () {
  "use strict";

  var GA_ID          = "G-7YT8GZS3HH";
  var STORAGE_KEY    = "apex.consent";
  // Bump only when categories or tracking practices materially change, so a
  // stale choice is not treated as covering something new. Ordinary deploys
  // must not re-prompt.
  var CONSENT_VERSION = 1;

  var loaded = false;   // gtag.js injected this page load
  var state  = null;

  /* ── storage ─────────────────────────────────────────────────────────── */
  function read() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || v.version !== CONSENT_VERSION) return null;   // re-ask
      return v;
    } catch (e) { return null; }   // private mode / storage disabled
  }
  function write(analytics) {
    state = { version: CONSENT_VERSION, analytics: !!analytics, timestamp: new Date().toISOString() };
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* session-only */ }
    return state;
  }

  /* ── analytics ───────────────────────────────────────────────────────── */
  function loadGA() {
    if (loaded || document.getElementById("apex-ga")) return;
    loaded = true;
    try {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      var s = document.createElement("script");
      s.id = "apex-ga";
      s.async = true;
      s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
      // A blocked or unreachable tag must be a no-op, never an error the user sees.
      s.onerror = function () { loaded = false; };
      document.head.appendChild(s);
      window.gtag("js", new Date());
      window.gtag("config", GA_ID, { anonymize_ip: true });
    } catch (e) { loaded = false; }
  }

  /**
   * Best-effort removal of Google Analytics cookies on THIS origin.
   *
   * Deliberately narrow. It only deletes cookies whose names match the GA
   * first-party pattern and that are actually present — no blind list, no
   * guessing. Everything else on the origin, including the Supabase auth
   * session, Helcim state and this module's own consent record, is untouched.
   *
   * Limits worth being straight about: a cookie can only be deleted by
   * matching its original path and domain, and those are not readable from
   * JavaScript, so each candidate is attempted across the plausible
   * combinations. Anything set HttpOnly, or held on another domain such as
   * google.com, cannot be removed from here by anyone. And none of this
   * retracts data already transmitted — no website can do that.
   */
  function clearGACookies() {
    var removed = [];
    try {
      if (!document.cookie) return removed;
      var names = document.cookie.split(";").map(function (c) {
        return c.split("=")[0].trim();
      }).filter(Boolean);

      // _ga, _ga_<STREAM>, _gid, _gat, _gac_* — GA's documented first-party
      // cookie names. Nothing else is considered.
      var GA_COOKIE = /^(_ga(_[A-Z0-9]+)?|_gid|_gat(_.+)?|_gac_.+)$/;
      var host = location.hostname;
      var domains = [null, host];
      var parts = host.split(".");
      if (parts.length > 2) domains.push("." + parts.slice(-2).join("."));
      else if (parts.length === 2) domains.push("." + host);

      names.forEach(function (name) {
        if (!GA_COOKIE.test(name)) return;              // not ours to touch
        domains.forEach(function (d) {
          ["/", location.pathname].forEach(function (path) {
            var c = encodeURIComponent(name) + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=" + path;
            if (d) c += "; domain=" + d;
            try { document.cookie = c; } catch (e) {}
          });
        });
        removed.push(name);
      });
    } catch (e) { /* clearing an optional cookie must never break the page */ }
    return removed;
  }

  function disableGA() {
    // Once a page has loaded gtag.js it cannot be unloaded, and data already
    // sent cannot be recalled. What CAN be done: set Google's documented
    // per-property kill switch so the tag stops collecting, stop making any
    // further Apex calls, and clear the GA cookies this origin holds. A reload
    // starts clean because nothing injects.
    try { window["ga-disable-" + GA_ID] = true; } catch (e) {}
    clearGACookies();
    loaded = false;
  }

  /* Event helper. Silently does nothing without consent, and refuses to carry
     anything that looks like customer data. */
  var BANNED = /email|phone|name|address|customer|invoice|quote|serial|transaction|payment_id|signature|hash|token|uuid|user/i;
  function track(event, params) {
    try {
      if (!state || !state.analytics || !window.gtag) return;
      var clean = {};
      if (params) {
        for (var k in params) {
          if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
          if (BANNED.test(k)) continue;                          // never send identifiers
          var v = params[k];
          if (typeof v === "number" || typeof v === "boolean") { clean[k] = v; continue; }
          if (typeof v === "string" && v.length <= 40 && !/[@]/.test(v)) clean[k] = v;
        }
      }
      window.gtag("event", String(event).slice(0, 40), clean);
    } catch (e) { /* analytics must never break a form */ }
  }

  /* ── UI ──────────────────────────────────────────────────────────────── */
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  function removeBanner() {
    var b = document.getElementById("apex-consent-banner");
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  function showBanner() {
    if (document.getElementById("apex-consent-banner")) return;
    // role="region" rather than a dialog: it must not steal focus or block the
    // page. A visitor who ignores it can still read and use the whole site.
    var bar = el("div", {
      id: "apex-consent-banner", class: "apex-consent",
      role: "region", "aria-label": "Cookie and analytics choices"
    });
    var txt = el("p", { class: "apex-consent-text" });
    txt.appendChild(document.createTextNode(
      "We'd like to use Google Analytics to see which pages are useful. It's optional. " +
      "Signing in, requesting service and paying invoices all work either way. "));
    var link = el("a", { href: "cookie-policy.html" }, "Cookie & Tracking Policy");
    txt.appendChild(link);
    bar.appendChild(txt);

    var row = el("div", { class: "apex-consent-actions" });
    // Equal prominence on purpose. No "Accept All" next to a hidden decline.
    var acc = el("button", { type: "button", class: "apex-consent-btn primary" }, "Accept analytics");
    var rej = el("button", { type: "button", class: "apex-consent-btn" }, "Reject non-essential");
    var man = el("button", { type: "button", class: "apex-consent-btn link" }, "Manage preferences");
    acc.addEventListener("click", function () { setConsent(true); });
    rej.addEventListener("click", function () { setConsent(false); });
    man.addEventListener("click", function () { openPrefs(man); });
    row.appendChild(acc); row.appendChild(rej); row.appendChild(man);
    bar.appendChild(row);
    document.body.appendChild(bar);
  }

  function openPrefs(opener) {
    var existing = document.getElementById("apex-consent-prefs");
    if (existing) { existing.hidden = false; return; }

    var dlg = el("div", {
      id: "apex-consent-prefs", class: "apex-consent-modal",
      role: "dialog", "aria-modal": "true", "aria-labelledby": "apex-consent-prefs-title"
    });
    var card = el("div", { class: "apex-consent-card" });
    card.appendChild(el("h2", { id: "apex-consent-prefs-title", tabindex: "-1" }, "Cookie & analytics preferences"));

    var nec = el("div", { class: "apex-consent-cat" });
    nec.appendChild(el("h3", null, "Strictly necessary"));
    nec.appendChild(el("p", null,
      "Always on. Keeps you signed in and lets invoices and service plans be paid. " +
      "Turning this off would stop the portal working, so it is not optional."));
    card.appendChild(nec);

    var ana = el("div", { class: "apex-consent-cat" });
    ana.appendChild(el("h3", null, "Analytics"));
    ana.appendChild(el("p", null,
      "Google Analytics, so we can see which pages people find useful. " +
      "Off by default. Nothing is sent until you turn it on."));
    var lab = el("label", { class: "apex-consent-toggle", for: "apex-consent-analytics" });
    var box = el("input", { type: "checkbox", id: "apex-consent-analytics" });
    box.checked = !!(state && state.analytics);
    lab.appendChild(box);
    lab.appendChild(document.createTextNode(" Allow Google Analytics"));
    ana.appendChild(lab);
    card.appendChild(ana);

    var act = el("div", { class: "apex-consent-actions" });
    var save = el("button", { type: "button", class: "apex-consent-btn primary" }, "Save preferences");
    var close = el("button", { type: "button", class: "apex-consent-btn", "data-a11y-close": "" }, "Cancel");
    save.addEventListener("click", function () { setConsent(box.checked); dlg.hidden = true; });
    close.addEventListener("click", function () { dlg.hidden = true; });
    act.appendChild(save); act.appendChild(close);
    card.appendChild(act);
    dlg.appendChild(card);
    document.body.appendChild(dlg);

    // a11y.js watches [data-a11y-dialog] and handles focus, trap, Escape and
    // focus return, so the consent dialog behaves like every other dialog.
    dlg.setAttribute("data-a11y-dialog", "");
    if (window.ApexA11y && window.ApexA11y.init) window.ApexA11y.init();
    dlg.hidden = false;
    if (opener) dlg.__apexOpener = opener;
  }

  function setConsent(analytics) {
    var prev = state && state.analytics;
    write(analytics);
    if (analytics) loadGA();
    else if (prev) disableGA();
    removeBanner();
    announce(analytics
      ? "Analytics enabled. You can change this any time from Cookie Settings in the footer."
      : "Analytics rejected. Only strictly necessary storage is used.");
  }

  function announce(msg) {
    var live = document.getElementById("apex-consent-live");
    if (!live) {
      live = el("div", { id: "apex-consent-live", role: "status", "aria-live": "polite", class: "apex-visually-hidden" });
      document.body.appendChild(live);
    }
    live.textContent = msg;
  }

  /* ── boot ────────────────────────────────────────────────────────────── */
  function init() {
    try {
      state = read();
      if (state && state.analytics) loadGA();
      else if (!state) showBanner();          // no decision yet, or version bumped

      var t = document.getElementById("apex-cookie-settings");
      if (t) t.addEventListener("click", function (e) { e.preventDefault(); openPrefs(t); });
    } catch (e) { /* consent must never break the page */ }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.ApexConsent = {
    init: init,
    track: track,
    open: openPrefs,
    get: function () { return state ? JSON.parse(JSON.stringify(state)) : null; },
    set: setConsent,
    _gaLoaded: function () { return !!document.getElementById("apex-ga"); },
    _version: CONSENT_VERSION,
    _key: STORAGE_KEY,
    _gaId: GA_ID,
    _clearGACookies: clearGACookies
  };
})();
