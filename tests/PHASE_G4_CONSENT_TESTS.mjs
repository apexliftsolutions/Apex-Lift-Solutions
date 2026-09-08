// =============================================================================
//  GROUP 4 — consent tests (real DOM via jsdom)
//  Run: node tests/PHASE_G4_CONSENT_TESTS.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const tick = () => new Promise(r => setTimeout(r, 0));
const A11Y = readFileSync(new URL("../docs/a11y.js", import.meta.url), "utf8");
const CONSENT = readFileSync(new URL("../docs/consent.js", import.meta.url), "utf8");

function boot(stored) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <footer><a href="privacy.html">Privacy</a>
    <button id="apex-cookie-settings">Cookie Settings</button></footer></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "https://apexliftsolutionsusa.com/" });
  const w = dom.window;
  // Any network request would be a failure of the whole design, so record them.
  w.__requests = [];
  const realCreate = w.document.createElement.bind(w.document);
  w.document.createElement = function (t) {
    const el = realCreate(t);
    if (String(t).toLowerCase() === "script") {
      Object.defineProperty(el, "src", {
        set(v) { w.__requests.push(v); el.setAttribute("src", v); },
        get() { return el.getAttribute("src"); }, configurable: true
      });
    }
    return el;
  };
  if (stored !== undefined) w.localStorage.setItem("apex.consent", stored);
  w.eval(A11Y); w.eval(CONSENT);
  return w;
}
const gaReqs = w => w.__requests.filter(u => /googletagmanager\.com/.test(u));

console.log("═══ NO DECISION YET ═══");
{
  const w = boot(); await tick();
  ok(gaReqs(w).length === 0, "N1 no Google Analytics request is made before a choice");
  ok(!w.document.getElementById("apex-ga"), "N2 the gtag script tag is never injected");
  ok(typeof w.gtag === "undefined", "N3 gtag is not initialised");
  ok(!!w.document.getElementById("apex-consent-banner"), "N4 the banner is shown");
  const btns = [...w.document.querySelectorAll("#apex-consent-banner button")].map(b => b.textContent);
  ok(btns.some(t => /accept/i.test(t)) && btns.some(t => /reject/i.test(t)) && btns.some(t => /manage/i.test(t)),
     `N5 banner offers Accept, Reject and Manage (${btns.join(" / ")})`);
  const acc = [...w.document.querySelectorAll("#apex-consent-banner button")].find(b => /accept/i.test(b.textContent));
  const rej = [...w.document.querySelectorAll("#apex-consent-banner button")].find(b => /reject/i.test(b.textContent));
  ok(acc.tagName === rej.tagName && acc.className.replace(" primary","") === rej.className,
     "N6 Accept and Reject are the same kind of control, differing only by colour");
  ok(w.document.activeElement === w.document.body, "N7 the banner does not steal focus");
}

console.log("\n═══ ACCEPT ═══");
{
  const w = boot(); await tick();
  [...w.document.querySelectorAll("#apex-consent-banner button")].find(b => /accept/i.test(b.textContent)).click();
  await tick();
  ok(gaReqs(w).length === 1, `A1 exactly one GA request after accept (${gaReqs(w).length})`);
  ok(w.document.querySelectorAll("#apex-ga").length === 1, "A2 exactly one gtag script tag");
  const cfg = w.dataLayer.filter(a => a[0] === "config");
  ok(cfg.length === 1 && cfg[0][1] === "G-7YT8GZS3HH", "A3 config called exactly once with the right property");
  ok(!w.document.getElementById("apex-consent-banner"), "A4 the banner is dismissed");
  const st = JSON.parse(w.localStorage.getItem("apex.consent"));
  ok(st.analytics === true && st.version === 1 && !!st.timestamp, "A5 preference persisted with a version and timestamp");
  ok(!/email|ip|user|customer/i.test(Object.keys(st).join(",")), "A6 stored preference holds no identifiers");
}

console.log("\n═══ REJECT ═══");
{
  const w = boot(); await tick();
  [...w.document.querySelectorAll("#apex-consent-banner button")].find(b => /reject/i.test(b.textContent)).click();
  await tick();
  ok(gaReqs(w).length === 0, "R1 no GA request after reject");
  ok(!w.document.getElementById("apex-ga"), "R2 no gtag script tag");
  ok(JSON.parse(w.localStorage.getItem("apex.consent")).analytics === false, "R3 rejection persisted");
  w.ApexConsent.track("quote_request_submitted", { event_category: "lead" });
  ok(gaReqs(w).length === 0, "R4 track() is a no-op after rejection");
  ok(!!w.document.querySelector("footer a[href='privacy.html']"), "R5 the site still renders and works");
}

console.log("\n═══ RETURNING VISITOR ═══");
{
  const w = boot(JSON.stringify({ version: 1, analytics: true, timestamp: "2026-09-01T00:00:00Z" }));
  await tick();
  ok(gaReqs(w).length === 1, "V1 a stored accept loads GA exactly once, with no duplicate config");
  ok(!w.document.getElementById("apex-consent-banner"), "V2 no banner shown again");
  w.ApexConsent.init();
  ok(gaReqs(w).length === 1, "V3 re-initialising does not inject GA a second time");
}
{
  const w = boot(JSON.stringify({ version: 1, analytics: false, timestamp: "2026-09-01T00:00:00Z" }));
  await tick();
  ok(gaReqs(w).length === 0 && !w.document.getElementById("apex-consent-banner"),
     "V4 a stored reject stays rejected and is not re-prompted");
}

console.log("\n═══ CONSENT VERSIONING ═══");
{
  const w = boot(JSON.stringify({ version: 0, analytics: true, timestamp: "2025-01-01T00:00:00Z" }));
  await tick();
  ok(gaReqs(w).length === 0, "S1 a stale consent version does NOT silently authorise analytics");
  ok(!!w.document.getElementById("apex-consent-banner"), "S2 a stale version re-prompts");
}

console.log("\n═══ CHANGING YOUR MIND ═══");
{ // reject -> accept
  const w = boot(JSON.stringify({ version: 1, analytics: false, timestamp: "2026-09-01T00:00:00Z" }));
  await tick();
  w.ApexConsent.set(true); await tick();
  ok(gaReqs(w).length === 1, "C1 reject -> accept loads GA once");
}
{ // accept -> reject, in the same page session
  const w = boot(JSON.stringify({ version: 1, analytics: true, timestamp: "2026-09-01T00:00:00Z" }));
  await tick();
  ok(gaReqs(w).length === 1, "C2 starts with GA loaded");
  w.ApexConsent.set(false); await tick();
  ok(w["ga-disable-G-7YT8GZS3HH"] === true, "C3 accept -> reject sets Google's documented kill switch");
  const before = gaReqs(w).length;
  w.ApexConsent.track("page_view_custom", {});
  ok(gaReqs(w).length === before, "C4 no further Apex analytics calls are made");
  ok(JSON.parse(w.localStorage.getItem("apex.consent")).analytics === false, "C5 the new choice is persisted");
}

console.log("\n═══ PII GUARD ═══");
{
  const w = boot(); await tick();
  w.ApexConsent.set(true); await tick();
  const n = w.dataLayer.length;
  w.ApexConsent.track("quote_request_submitted", {
    event_category: "lead", customer_email: "a@b.com", invoice_id: "INV-1",
    customer_name: "Dana Reyes", serial_number: "X1", transaction_id: "544343",
    signature_hash: "abc", page_path: "/contact.html"
  });
  const ev = w.dataLayer[w.dataLayer.length - 1];
  const sent = JSON.stringify(ev[2] || {});
  ok(w.dataLayer.length === n + 1, "P1 the event was sent");
  ok(!/a@b\.com|Dana|INV-1|544343|abc|X1/.test(sent), `P2 identifying values are stripped (${sent})`);
  ok(/lead/.test(sent) && /contact\.html/.test(sent), "P3 generic parameters survive");
}

console.log("\n═══ FAILURE IS NEVER FATAL ═══");
{
  const w = boot(); await tick();
  const st = w.localStorage.setItem;
  w.localStorage.setItem = () => { throw new Error("storage disabled"); };
  let threw = false;
  try { w.ApexConsent.set(true); } catch (e) { threw = true; }
  ok(!threw, "F1 a storage failure does not throw into the page");
  w.localStorage.setItem = st;
}
{
  const w = boot(JSON.stringify("not-json{")); await tick();
  ok(!!w.document.getElementById("apex-consent-banner"), "F2 corrupt stored consent falls back to asking again");
  ok(gaReqs(w).length === 0, "F3 corrupt stored consent does not load analytics");
}

console.log("\n═══ PREFERENCES DIALOG ACCESSIBILITY ═══");
{
  const w = boot(); await tick();
  const opener = w.document.getElementById("apex-cookie-settings");
  opener.focus(); opener.click(); await tick();
  const dlg = w.document.getElementById("apex-consent-prefs");
  ok(!!dlg, "D1 Cookie Settings opens the preferences dialog");
  ok(dlg.getAttribute("role") === "dialog" && dlg.getAttribute("aria-modal") === "true", "D2 dialog semantics applied");
  ok(dlg.getAttribute("aria-labelledby") === "apex-consent-prefs-title", "D3 dialog has an accessible name");
  ok(dlg.contains(w.document.activeElement), "D4 focus moves into the dialog");
  const items = w.ApexA11y._focusable(dlg);
  items[items.length - 1].focus();
  const e = new w.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  w.document.dispatchEvent(e);
  ok(e.defaultPrevented && w.document.activeElement === items[0], "D5 Tab wraps inside the dialog");
  const esc = new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  w.document.dispatchEvent(esc); await tick();
  ok(dlg.hidden === true, "D6 Escape closes the preferences dialog");
  ok(w.document.activeElement === opener, "D7 focus returns to the Cookie Settings control");
}


console.log("\n═══ GA COOKIE CLEANUP ON ACCEPT -> REJECT ═══");
{
  const w = boot(JSON.stringify({ version: 1, analytics: true, timestamp: "2026-09-01T00:00:00Z" }));
  await tick();
  // Cookies GA would have set on this origin, plus ones that must survive.
  w.document.cookie = "_ga=GA1.1.123.456; path=/";
  w.document.cookie = "_ga_7YT8GZS3HH=GS1.1.999; path=/";
  w.document.cookie = "_gid=GA1.1.5; path=/";
  w.document.cookie = "sb-access-token=must-survive; path=/";
  w.document.cookie = "apex_other=keep; path=/";
  const before = w.document.cookie;
  ok(/_ga=/.test(before) && /sb-access-token/.test(before), "K1 test cookies were set");

  w.ApexConsent.set(false); await tick();
  const after = w.document.cookie;
  ok(!/(^|;\s*)_ga=/.test(after), "K2 _ga removed");
  ok(!/_ga_7YT8GZS3HH=/.test(after), "K3 _ga_<stream> removed");
  ok(!/(^|;\s*)_gid=/.test(after), "K4 _gid removed");
  ok(/sb-access-token=must-survive/.test(after), "K5 Supabase auth cookie UNTOUCHED");
  ok(/apex_other=keep/.test(after), "K6 unrelated first-party cookie untouched");
  ok(w.localStorage.getItem("apex.consent") !== null, "K7 the consent record itself survives");
}
{
  const w = boot(); await tick();
  w.document.cookie = "sb-refresh-token=x; path=/";
  const removed = w.ApexConsent._clearGACookies();
  ok(removed.length === 0, "K8 with no GA cookies present, nothing is removed");
  ok(/sb-refresh-token/.test(w.document.cookie), "K9 non-GA cookies are never candidates");
}
{
  const w = boot(); await tick();
  const orig = Object.getOwnPropertyDescriptor(w.Document.prototype, "cookie");
  Object.defineProperty(w.document, "cookie", { get() { throw new Error("blocked"); }, configurable: true });
  let threw = false;
  try { w.ApexConsent.set(false); } catch (e) { threw = true; }
  ok(!threw, "K10 a cookie-access failure never breaks the page");
  if (orig) Object.defineProperty(w.document, "cookie", orig);
}

console.log("\n═══ 404 CONSENT ACCESS ═══");
{
  const html = readFileSync(new URL("../docs/404.html", import.meta.url), "utf8");
  ok(/consent\.js/.test(html), "Z1 404 participates in the consent architecture");
  ok(/id="apex-cookie-settings"/.test(html), "Z2 404 exposes Cookie Settings");
  ok(/href="privacy\.html"/.test(html) && /href="cookie-policy\.html"/.test(html), "Z3 404 links both policies");
  ok(!/googletagmanager/.test(html), "Z4 404 still loads no analytics unconditionally");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
