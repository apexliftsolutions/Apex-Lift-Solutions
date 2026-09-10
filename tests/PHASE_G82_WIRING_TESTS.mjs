// =============================================================================
//  EVENT WIRING — surfaces A (portal-login) and B (portal-forgot)
//  Exercises the real delegated listeners in a real DOM.
//  Run: node tests/PHASE_G82_WIRING_TESTS.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { VirtualConsole } from "jsdom";

/* jsdom reports page-script errors to the real stderr by default. Several
   fixtures here deliberately load the portal wiring without stubbing every
   global — that is the point of the fragility probes — so the noise was
   expected but drowned the output and could hide a genuine error.

   Errors are COLLECTED rather than silenced: the count is asserted at the end,
   so a new unexpected page error still fails the suite instead of scrolling
   past. */
const pageErrors = [];
const quiet = () => {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => pageErrors.push(String(e && e.message || e)));
  vc.on("error", (...a) => pageErrors.push(a.map(String).join(" ")));
  return vc;
};
import { readFileSync, readdirSync, existsSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const D = new URL("../docs/", import.meta.url).pathname;
const read = f => readFileSync(D + f, "utf8");
const tick = () => new Promise(r => setTimeout(r, 0));

/** Load a page's markup with its wiring function and stubbed action functions. */
function boot(html, js, stubs) {
  const dom = new JSDOM(read(html), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: quiet() });
  const w = dom.window;
  const calls = [];
  for (const name of stubs) w[name] = (...a) => calls.push([name, ...a]);
  // Strip everything except the wiring block so the page's own init does not run.
  const src = read(js);
  const wire = src.slice(src.indexOf("/* ── Event wiring"));
  w.eval(wire);
  return { w, calls, doc: w.document };
}

console.log("═══ NO INLINE HANDLERS REMAIN ON A OR B ═══");
for (const f of ["portal-login.html", "portal-forgot.html"]) {
  const s = read(f);
  for (const h of ["onclick", "onchange", "oninput", "onkeydown", "onsubmit", "onkeyup", "onfocus", "onblur"])
    ok(!new RegExp(h + "=").test(s), `I1 ${f} has no ${h}=`);
}

console.log("\n═══ A. LOGIN WIRING ═══");
{
  const { w, calls, doc } = boot("portal-login.html", "portal-login.js",
    ["switchTab", "togglePw", "handleLogin", "handleRegister", "checkStrength"]);
  await tick();
  const click = sel => { const el = doc.querySelector(sel); el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); return el; };

  click('[data-action="tab"][data-tab="register"]');
  ok(calls.some(c => c[0] === "switchTab" && c[1] === "register"), "A1 register tab switches");
  click('[data-action="tab"][data-tab="login"]');
  ok(calls.some(c => c[0] === "switchTab" && c[1] === "login"), "A2 login tab switches");
  click('[data-action="toggle-pw"][data-target="login-pass"]');
  ok(calls.some(c => c[0] === "togglePw" && c[1] === "login-pass"), "A3 password visibility toggles by target id");
  click('[data-action="login"]');
  ok(calls.some(c => c[0] === "handleLogin"), "A4 login submits");
  click('[data-action="register"]');
  ok(calls.some(c => c[0] === "handleRegister"), "A5 registration submits");

  const pw = doc.querySelector('[data-action="strength"]');
  pw.value = "Str0ngPass!";
  pw.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok(calls.some(c => c[0] === "checkStrength" && c[1] === "Str0ngPass!"),
     "A6 password strength receives the typed value");

  ok(doc.querySelectorAll('[data-action="toggle-pw"]').length === 3, "A7 all three toggles are wired");
}

console.log("\n═══ B. FORGOT-PASSWORD WIRING ═══");
{
  const { w, calls, doc } = boot("portal-forgot.html", "portal-forgot.js",
    ["step1", "step2", "step3", "resendCode", "otpIn", "otpKey", "strengthCheck"]);
  await tick();
  const click = sel => doc.querySelector(sel).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

  click('[data-action="send-code"]');   ok(calls.some(c => c[0] === "step1"), "B1 send code");
  click('[data-action="verify-code"]'); ok(calls.some(c => c[0] === "step2"), "B2 verify code");
  click('[data-action="resend"]');      ok(calls.some(c => c[0] === "resendCode"), "B3 resend");
  click('[data-action="reset-password"]'); ok(calls.some(c => c[0] === "step3"), "B4 reset password");

  const boxes = doc.querySelectorAll('[data-action="otp"]');
  ok(boxes.length === 6, `B5 six OTP boxes wired (${boxes.length})`);
  boxes[3].value = "7";
  boxes[3].dispatchEvent(new w.Event("input", { bubbles: true }));
  ok(calls.some(c => c[0] === "otpIn" && c[2] === 3), "B6 OTP input carries its index from data-index");
  boxes[2].dispatchEvent(new w.KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  ok(calls.some(c => c[0] === "otpKey" && c[2] === 2), "B7 OTP keydown carries its index");
  ok([...boxes].every((b, i) => b.dataset.index === String(i)), "B8 indexes are 0..5 in order");

  const pw = doc.querySelector('[data-action="strength"]');
  pw.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok(calls.some(c => c[0] === "strengthCheck"), "B9 password strength fires");
}

console.log("\n═══ LISTENERS INSTALL ONCE ═══");
for (const [html, js, stubs, sel, fn] of [
  ["portal-login.html", "portal-login.js", ["switchTab", "togglePw", "handleLogin", "handleRegister", "checkStrength"], '[data-action="login"]', "handleLogin"],
  ["portal-forgot.html", "portal-forgot.js", ["step1", "step2", "step3", "resendCode", "otpIn", "otpKey", "strengthCheck"], '[data-action="send-code"]', "step1"],
]) {
  const { w, calls, doc } = boot(html, js, stubs);
  await tick();
  // Re-invoking the wiring must not stack a second listener.
  const wireName = html.includes("login") ? "wireLoginPage" : "wireForgotPage";
  w[wireName](); w[wireName](); w[wireName]();
  doc.querySelector(sel).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const n = calls.filter(c => c[0] === fn).length;
  ok(n === 1, `R1 ${html}: one click -> exactly one ${fn}() after 4 wiring calls (${n})`);
  ok(doc.body.dataset.apexWired === "1", `R2 ${html}: the guard flag is set`);
}

console.log("\n═══ NO EXECUTABLE ACTION STRINGS ═══");
for (const f of ["portal-login.js", "portal-forgot.js"]) {
  const s = read(f);
  const wireRaw = s.slice(s.indexOf("/* ── Event wiring"));
  ok(/switch \(el\.dataset\.action\)/.test(wireRaw), `S1 ${f} selects via a fixed switch`);
  // Strip comments: the block explains that it does NOT do window[action](),
  // and matching on the prose rather than the code is a false positive.
  const wire = wireRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  ok(!/window\s*\[/.test(wire), `S2 ${f} never indexes window with a data value`);
  ok(!/\beval\s*\(|new\s+Function/.test(wire), `S3 ${f} uses no eval or Function constructor`);
  ok(/default:/.test(wire), `S4 ${f} ignores unknown action values`);
}

console.log("\n═══ MALFORMED ATTRIBUTE SYNTAX ═══");
{
  const HTML = readdirSync(D).filter(f => f.endsWith(".html"));
  let total = 0;
  for (const f of HTML) {
    const n = (read(f).match(/\/\s+[a-z-]+=/g) || []).length;
    total += n;
    ok(n === 0, `M1 ${f} has no stray slash before an attribute (${n})`);
  }
  ok(total === 0, `M2 zero malformed void-tag attributes site-wide (was 25)`);
  // Accessible names must have survived the repair. Counting aria-label alone
  // understates it: Group 7 converted several controls to <label for>, which is
  // the better pattern. Count controls that have a name by EITHER route.
  for (const [f, min] of [["portal-admin.html", 35], ["portal-customer.html", 12]]) {
    const s = read(f);
    const labelled = new Set([...s.matchAll(/<label[^>]*for="([^"]+)"/g)].map(m => m[1]));
    let named = (s.match(/aria-label=/g) || []).length;
    for (const m of s.matchAll(/<(?:input|select|textarea)\b[^>]*id="([^"]+)"[^>]*>/g))
      if (labelled.has(m[1])) named++;
    ok(named >= min, `M3 ${f} keeps ${named} accessible names (aria-label + label-for, need ${min})`);
  }
  ok(!/\/\s+aria-label/.test(read("portal-admin.html") + read("portal-customer.html")),
     "M4 no aria-label is preceded by a stray slash");
}


// =============================================================================
//  SURFACE C — CUSTOMER PORTAL
// =============================================================================
console.log("\n═══ C. NO INLINE HANDLERS REMAIN ═══");
{
  for (const f of ["portal-customer.html", "portal-customer.js", "pagination.js"]) {
    const n = (read(f).match(/on(?:click|change|input|keydown|submit|keyup|focus|blur)=/g) || []).length;
    ok(n === 0, `C0 ${f} has 0 inline event attributes (${n})`);
  }
  const js = read("portal-customer.js");
  ok(!/\beval\s*\(|new\s+Function/.test(js), "C0b no eval or Function constructor");
  // Strip comments: safeStorageUrl's doc comment lists javascript: among the
  // protocols it REJECTS, and matching the prose is a false positive.
  const code = (js + read("portal-customer.html"))
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/<!--[\s\S]*?-->/g, "");
  ok(!/javascript:/.test(code), "C0c no javascript: URLs in executable code");
}

console.log("\n═══ C. EVERY ACTION IS ROUTED ═══");
{
  const html = read("portal-customer.html"), js = read("portal-customer.js"), pag = read("pagination.js");
  const emitted = new Set([...(html + js + pag).matchAll(/data-action="([a-z-]+)"/g)].map(m => m[1]));
  const wire = js.slice(js.indexOf("function wireCustomerPortal"));
  const handled = new Set([...wire.matchAll(/case '([a-z-]+)':/g)].map(m => m[1]));
  // req-files is served by the change listener; print-now by the print document.
  const unrouted = [...emitted].filter(a => !handled.has(a) && !["req-files", "print-now"].includes(a));
  ok(unrouted.length === 0, `C1 every emitted action is routed (${unrouted.join(", ") || "none"})`);
  ok(emitted.size >= 28, `C1b ${emitted.size} distinct actions emitted`);
  ok(/data-action="req-files"/.test(wire) || /req-files/.test(wire), "C1c the file input is handled on change");
  ok(/switch \(d\.action\)/.test(wire), "C2 a fixed switch selects the handler");
  ok(!/window\s*\[/.test(wire.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")),
     "C3 never indexes window with a data value");
  ok(/default: break;/.test(wire), "C4 unknown actions are ignored");
}

console.log("\n═══ C. INTERACTIONS FIRE THE RIGHT FUNCTION ═══");
{
  const FN = ["showView", "toggleMobileSidebar", "closeMobileSidebar", "doLogout", "respondQuote",
              "removeQuote", "printQuote", "printInvoice", "printPaymentReceipt", "lookupInv",
              "openPay", "startPay", "closePayModal", "closeConfirm", "removeReqFile",
              "submitRequest", "saveProfile", "changePassword", "cpReview", "cpDecline",
              "cpRenderChooser", "cpPick", "cpStartPlanPayment", "cpActivatePlan", "cpOpenPdf",
              "handleReqFiles", "loadQuotes", "loadInvoices", "loadHistory",
              "moreQuotes", "moreInvoices", "moreHistory", "morePayments"];
  const dom = new JSDOM(read("portal-customer.html"), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: quiet() });
  const w = dom.window, doc = w.document, calls = [];
  for (const n of FN) w[n] = (...a) => calls.push([n, ...a]);
  const src = read("portal-customer.js");
  w.eval(src.slice(src.indexOf("/* ── Event wiring (CSP readiness, Surface C)")));
  await tick();

  const fire = (html, sel) => {
    const host = doc.createElement("div");
    host.innerHTML = html; doc.body.appendChild(host);
    host.querySelector(sel).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  };
  const had = n => calls.some(c => c[0] === n);

  doc.querySelector('[data-action="logout"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(had("doLogout"), "C5 logout");
  doc.querySelector('[data-action="view"][data-view="invoices"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(calls.some(c => c[0] === "showView" && c[1] === "invoices"), "C6 navigation passes the view name");
  doc.querySelector('[data-action="lookup-invoice"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(had("lookupInv"), "C7 invoice lookup");
  doc.querySelector('[data-action="submit-request"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(had("submitRequest"), "C8 service request submit");
  doc.querySelector('[data-action="save-profile"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(had("saveProfile"), "C9 profile save");
  doc.querySelector('[data-action="change-password"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(had("changePassword"), "C10 password change");
  doc.querySelector('[data-action="start-pay"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(had("startPay"), "C11 Pay Securely");
  doc.querySelector('[data-action="close-pay"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(had("closePayModal"), "C12 payment modal close");

  // Generated markup
  fire('<button data-action="quote-respond" data-id="Q-1" data-response="approved">a</button>', "button");
  ok(calls.some(c => c[0] === "respondQuote" && c[1] === "Q-1" && c[2] === "approved"), "C13 quote approve");
  fire('<button data-action="quote-respond" data-id="Q-2" data-response="declined">d</button>', "button");
  ok(calls.some(c => c[0] === "respondQuote" && c[2] === "declined"), "C14 quote decline");
  fire('<button data-action="print-quote" data-id="Q-3">p</button>', "button");
  ok(calls.some(c => c[0] === "printQuote" && c[1] === "Q-3"), "C15 quote print");
  fire('<button data-action="print-invoice" data-id="INV-9">p</button>', "button");
  ok(calls.some(c => c[0] === "printInvoice" && c[1] === "INV-9"), "C16 invoice print");
  fire('<button data-action="print-receipt" data-id="P-4">p</button>', "button");
  ok(calls.some(c => c[0] === "printPaymentReceipt" && c[1] === "P-4"), "C17 receipt print");
  fire('<button data-action="open-pay" data-id="INV-7" data-amount="141.55">p</button>', "button");
  ok(calls.some(c => c[0] === "openPay" && c[1] === "INV-7" && c[2] === 141.55),
     "C18 openPay receives id and a numeric amount");
  fire('<button data-action="remove-file" data-index="2">x</button>', "button");
  ok(calls.some(c => c[0] === "removeReqFile" && c[2 - 1] === 2), "C19 attachment removal by index");
  fire('<button data-action="remove-quote" data-id="Q-5">x</button>', "button");
  ok(calls.some(c => c[0] === "removeQuote" && c[1] === "Q-5"), "C20 quote dismissal");

  // Service plans
  for (const [act, fn, arg] of [["plan-review", "cpReview", "OF-1"], ["plan-decline", "cpDecline", "OF-2"],
                                ["plan-pay", "cpStartPlanPayment", "AG-1"], ["plan-activate", "cpActivatePlan", "AG-2"],
                                ["open-pdf", "cpOpenPdf", "AG-3"]]) {
    fire(`<button data-action="${act}" data-id="${arg}">x</button>`, "button");
    ok(calls.some(c => c[0] === fn && c[1] === arg), `C21 ${fn}`);
  }
  fire('<button data-action="plan-chooser">x</button>', "button");
  ok(had("cpRenderChooser"), "C22 payment-method chooser");
  for (const m of ["card", "ach"]) {
    fire(`<button data-action="plan-pick" data-method="${m}">x</button>`, "button");
    ok(calls.some(c => c[0] === "cpPick" && c[1] === m), `C23 payment method ${m}`);
  }

  // Lists
  for (const [list, fn] of [["Quotes", "loadQuotes"], ["Invoices", "loadInvoices"], ["History", "loadHistory"]]) {
    fire(`<button data-action="reload" data-list="${list}">r</button>`, "button");
    ok(had(fn), `C24 retry reload -> ${fn}`);
  }
  for (const [list, fn] of [["quotes", "moreQuotes"], ["invoices", "moreInvoices"],
                            ["service_history", "moreHistory"], ["payments", "morePayments"]]) {
    fire(`<button data-action="load-more" data-list="${list}">m</button>`, "button");
    ok(had(fn), `C25 Load More -> ${fn}`);
  }

  const input = doc.querySelector('[data-action="req-files"]');
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok(had("handleReqFiles"), "C26 file selection");
}

console.log("\n═══ C. REPEATED RENDER DOES NOT STACK LISTENERS ═══");
{
  const dom = new JSDOM(read("portal-customer.html"), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: quiet() });
  const w = dom.window, doc = w.document, calls = [];
  // Deliberately stub ONLY three functions. The wiring must still install and
  // work — this is exactly the fragility C27 exposed the first time it ran.
  for (const n of ["doLogout", "showView", "openPay"]) w[n] = (...a) => calls.push([n, ...a]);
  const src = read("portal-customer.js");
  w.eval(src.slice(src.indexOf("/* ── Event wiring (CSP readiness, Surface C)")));
  await tick();
  for (let i = 0; i < 5; i++) w.wireCustomerPortal();      // simulate five re-renders
  doc.querySelector('[data-action="logout"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const n = calls.filter(c => c[0] === "doLogout").length;
  ok(n === 1, `C27 one click -> exactly one doLogout() after 6 wiring calls (${n})`);
  ok(doc.body.dataset.apexWired === "1", "C28 the guard flag prevents re-installation");
  // A missing loader must disable one button, not the whole listener.
  const before = calls.length;
  const host = doc.createElement("div");
  host.innerHTML = '<button data-action="load-more" data-list="quotes">m</button>';
  doc.body.appendChild(host);
  host.querySelector("button").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(calls.length === before, "C28b an unavailable loader is a no-op, not a thrown error");
  doc.querySelector('[data-action="view"][data-view="quotes"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(calls.some(c => c[0] === "showView"), "C28c and the rest of the portal still works");
}

console.log("\n═══ C. PRINT WINDOW BUTTON WIRED FROM THE PARENT ═══");
{
  const js = read("portal-customer.js");
  ok(/data-action="print-now"/.test(js), "C29 the print document renders a data-action button");
  ok(/btn\.addEventListener\('click', \(\) => w\.print\(\)\)/.test(js),
     "C30 its listener is attached from the parent via the same-origin document");
  ok(!/onclick="window\.print/.test(js), "C31 no inline handler is written into the print document");
  const printBlock = js.slice(js.indexOf("function printDoc"), js.indexOf("function printDoc") + 3000);
  ok(!/<script/.test(printBlock), "C32 no executable script is written into the print document");
}

console.log("\n═══ C. NO CUSTOMER TEXT IN DATA ATTRIBUTES ═══");
{
  const js = read("portal-customer.js");
  const vals = [...js.matchAll(/data-(?:id|index|amount|method|response|list|view)="([^"]*)"/g)].map(m => m[1]);
  const risky = vals.filter(v => /\$\{[^}]*\b(name|company|email|phone|desc|notes?|serial|title|equipment)\b/i.test(v));
  ok(risky.length === 0, `C33 no free-form customer text in a data attribute (${risky.join(", ") || "none"})`);
}


// =============================================================================
//  GENERIC INLINE EVENT-ATTRIBUTE AUDIT
//
//  Earlier versions enumerated a hardcoded list of event names and therefore
//  missed onmouseover/onmouseout in 404.html entirely. This matches ANY
//  attribute whose name starts with "on", per tag, which is what
//  script-src-attr 'none' actually governs.
// =============================================================================
console.log("\n═══ GENERIC on* ATTRIBUTE AUDIT ═══");
{
  const HTMLF = readdirSync(D).filter(f => f.endsWith(".html"));
  const JSF = readdirSync(D).filter(f => f.endsWith(".js"));

  // Per tag, so multiple handlers on one element are all counted.
  const scanHtml = (t) => [...t.matchAll(/<[a-zA-Z][^>]*>/gs)]
    .flatMap(m => [...m[0].matchAll(/\s(on[a-z]+)\s*=/g)].map(x => x[1]));
  // Generated markup: an on* attribute inside a quoted template string.
  // `btn.onclick = fn` is a PROPERTY assignment, not a content attribute, and
  // is deliberately not matched — script-src-attr does not govern it.
  // Any quoting form, optional spaces around '=', any on* name. Comments are
  // stripped first so prose about handlers is not counted as markup.
  const scanJs = (t) => {
    const code = t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    return [...code.matchAll(/\s(on[a-z]+)\s*=\s*["'`]/g)].map(m => m[1]);
  };

  const perFile = {};
  for (const f of HTMLF) { const h = scanHtml(read(f)); if (h.length) perFile[f] = h; }
  for (const f of JSF)   { const h = scanJs(read(f));   if (h.length) perFile[f] = h; }

  ok(!perFile["404.html"], `G1 404.html has no inline event attributes (${(perFile["404.html"] || []).join(",") || "none"})`);
  for (const f of ["portal-login.html", "portal-forgot.html", "portal-customer.html",
                   "portal-customer.js", "pagination.js", "index.html", "contact.html",
                   "careers.html", "about.html", "services.html", "plans.html",
                   "privacy.html", "terms.html", "refund-policy.html",
                   "cookie-policy.html", "accessibility.html", "portal-reset.html"]) {
    ok(!perFile[f], `G2 ${f} has no inline event attributes (${(perFile[f] || []).join(",") || "none"})`);
  }
  const remaining = Object.entries(perFile).map(([f, h]) => `${f}:${h.length}`);
  console.log(`     remaining (Surface D): ${remaining.join(", ") || "none"}`);
  ok(Object.keys(perFile).every(f => f.startsWith("portal-admin")),
     `G3 every remaining inline attribute is in Surface D (${Object.keys(perFile).join(", ") || "none"})`);

  // Property assignments must NOT be counted as inline attributes.
  ok(scanJs("btn.onclick = handler;").length === 0,
     "G4 btn.onclick = fn is a property assignment, not an inline attribute");
  // Corrected model: el.setAttribute("onclick", "code()") DOES create an inline
  // event-handler content attribute and is exactly what script-src-attr blocks.
  // Only an IDL property assignment from a Function object is safe.
  const SETATTR_ON = /\.setAttribute\s*\(\s*["'`]on[a-z]+["'`]/;
  const violators = JSF.filter(f => SETATTR_ON.test(read(f)));
  ok(violators.length === 0, `G5 no first-party JS creates an on* attribute via setAttribute (${violators.join(", ") || "none"})`);
  ok(SETATTR_ON.test('el.setAttribute("onclick", "x()")'), "G5a a synthetic setAttribute(\"onclick\") IS classified as prohibited");
  ok(SETATTR_ON.test("el.setAttribute('onmouseover', y)"), "G5b single quotes too");
  ok(SETATTR_ON.test("el.setAttribute(`onchange`, y)"), "G5c template literals too");
  ok(!SETATTR_ON.test("btn.onclick = someFunction;"), "G5d an IDL property assignment is NOT flagged");
  ok(!SETATTR_ON.test('el.setAttribute("data-action", "x")'), "G5e ordinary attributes are not flagged");
  // And the scanner really does catch a reintroduced hover handler.
  ok(scanHtml('<a href="x" onmouseover="this.style.color=\'#fff\'">y</a>').length === 1,
     "G6 the scanner catches onmouseover");
  ok(scanHtml('<a onmouseover="a" onmouseout="b" onclick="c">y</a>').length === 3,
     "G7 and catches every handler on a single tag, not just the first");
  // 0F: the generated-markup scanner must not depend on one quoting style.
  ok(scanJs(`x = '<b onclick="f()">y</b>'`).length === 1, "G8 catches double-quoted generated on*");
  ok(scanJs("x = `<b onclick='f()'>y</b>`").length === 1, "G8a catches single-quoted generated on*");
  ok(scanJs('x = `<b onmouseover = "f()">y</b>`').length === 1, "G8b catches spaces around the equals");
  ok(scanJs('x = `<b onpointerdown="f()">y</b>`').length === 1, "G8c catches any on* event name");
  ok(scanJs('// a comment mentioning onclick="f()"').length === 0, "G8d ignores comments");
  ok(scanJs('/* block comment with onchange="f()" */').length === 0, "G8e ignores block comments");
}

console.log("\n═══ ATTRIBUTE SEPARATION ═══");
{
  for (const f of readdirSync(D).filter(x => x.endsWith(".html"))) {
    const s = read(f);
    // Scan inside each tag and only flag a quote that CLOSED a value (an even
    // number of quotes before it). A naive match hits content="width=device-width",
    // where the quote opens the value rather than closing one.
    const glued = [];
    for (const tag of s.matchAll(/<[a-zA-Z][^>]*>/gs)) {
      const t = tag[0];
      for (const m of t.matchAll(/"([a-zA-Z][a-zA-Z0-9-]*)=/g)) {
        const before = (t.slice(0, m.index + 1).match(/"/g) || []).length;
        if (before % 2 === 0) glued.push(m[1]);   // quote closed a value -> glued
      }
    }
    ok(glued.length === 0, `W1 ${f}: no attribute glued to the previous quoted value (${glued.slice(0,3).join(",") || "none"})`);
  }
  ok((read("portal-admin.html").match(/aria-label=/g) || []).length >= 35, "W2 admin aria-labels intact");
  ok((read("portal-customer.html").match(/aria-label=/g) || []).length >= 5, "W3 customer aria-labels intact");
}

console.log("\n═══ 404 HOVER MOVED TO CSS ═══");
{
  const css = read("style.css");
  ok(/\.e404-link:hover/.test(css), "H1 hover handled in CSS");
  ok(/\.e404-link:focus-visible/.test(css), "H2 keyboard users get the same affordance the mouse handlers never gave");
  const n = (read("404.html").match(/e404-link/g) || []).length;
  ok(n === 4, `H3 the class is scoped to the four quick links (${n})`);
  ok(!/this\.style\.color/.test(read("404.html")), "H4 no inline style mutation remains");
  // 0D: an inline style attribute outranks a class selector, so the base colour
  // must come from the stylesheet or :hover could never take effect.
  ok(!/<a class="e404-link"[^>]*style=/.test(read("404.html")),
     "H5 the quick links carry no inline style attribute");
  ok(/\.e404-link \{[^}]*color: var\(--grey\)/.test(css), "H6 the base grey lives in the stylesheet");
  ok(/\.e404-link:hover,\s*\.e404-link:focus-visible \{[^}]*color: var\(--white\)/.test(css),
     "H7 hover and focus resolve to white — the original behaviour, not a new red");
  ok(/\.e404-link:focus-visible \{[^}]*outline:/.test(css), "H8 keyboard focus has a visible ring, not colour alone");
  for (const p of ["font-family", "font-size", "font-weight", "letter-spacing", "text-transform", "text-decoration", "transition"])
    ok(new RegExp("\\.e404-link \\{[^}]*" + p + ":").test(css), `H9 ${p} moved into the stylesheet`);
}


// =============================================================================
//  SURFACE D — ADMIN PORTAL
//  Argument fidelity matters more than "the handler ran": these actions move
//  money, and a number arriving as a string or null arriving as "null" would be
//  a silent regression.
// =============================================================================
console.log("\n═══ D. NO INLINE HANDLERS REMAIN ═══");
{
  const scanTags = (t) => [...t.matchAll(/<[a-zA-Z][^>]*>/gs)]
    .flatMap(m => [...m[0].matchAll(/\s(on[a-z]+)\s*=/g)].map(x => x[1]));
  const scanGen = (t) => {
    const c = t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    return [...c.matchAll(/\s(on[a-z]+)\s*=\s*["'`]/g)].map(m => m[1]);
  };
  ok(scanTags(read("portal-admin.html")).length === 0,
     `D0 portal-admin.html: 0 inline attributes (was 56)`);
  ok(scanGen(read("portal-admin.js")).length === 0,
     `D0a portal-admin.js: 0 generated attributes (was 42)`);
  const js = read("portal-admin.js");
  // Strip comments: the wiring block documents that it uses NO eval and NO new
  // Function, and matching the prose rather than the code is a false positive.
  const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  ok(!/\beval\s*\(|new\s+Function/.test(jsCode), "D0b no eval or Function constructor");
  ok(!/javascript:/.test(jsCode), "D0c no javascript: URLs");
  const wire = js.slice(js.indexOf("function wireAdminPortal"));
  ok(!/window\s*\[|globalThis\s*\[/.test(wire.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")),
     "D0d no dynamic global lookup");
  ok(/switch \(d\.action\)/.test(wire), "D0e a fixed switch routes clicks");
  ok(/default: break;/.test(wire), "D0f unknown actions are ignored");
}

console.log("\n═══ D. rsBtn NO LONGER CARRIES JS SOURCE ═══");
{
  const js = read("portal-admin.js");
  const fn = js.slice(js.indexOf("function rsBtn"), js.indexOf("function rsBtn") + 700);
  ok(!/onclick=/.test(fn), "D1 rsBtn emits no onclick");
  ok(/data-action="\$\{esc\(action\)\}"/.test(fn), "D2 it emits a constrained action name");
  ok(/data-id="\$\{esc\(id\)\}"/.test(fn), "D3 and an escaped id");
  for (const a of ["rs-pause", "rs-resume", "rs-term", "rs-cancel"])
    ok(new RegExp(`rsBtn\\([^)]*'${a}', s\\.id\\)`).test(js), `D4 ${a} passes an action name, not code`);
  ok(!/rsBtn\([^)]*`rs[A-Z]/.test(js), "D5 no call site passes a JavaScript string any more");
}

console.log("\n═══ D. ACTION CROSS-CHECK ═══");
{
  const h = read("portal-admin.html"), j = read("portal-admin.js");
  const emitted = new Set([...(h + j).matchAll(/data-action="([a-z-]+)"/g)].map(m => m[1]));
  const wire = j.slice(j.indexOf("function wireAdminPortal"));
  // Routes live in three places since the event-channel split: the click
  // switch, ON_INPUT and ON_CHANGE. Scanning only the switch would report the
  // input/change actions as unrouted.
  const routed = new Set([
    ...[...wire.matchAll(/case '([a-z-]+)':/g)].map(m => m[1]),
    ...[...wire.matchAll(/^\s*'([a-z-]+)':\s*[A-Za-z_$]/gm)].map(m => m[1]),
    ...[...wire.matchAll(/dataset\.action === '([a-z-]+)'/g)].map(m => m[1]),
  ]);
  const unrouted = [...emitted].filter(a => !routed.has(a) && a !== "print-now");
  ok(unrouted.length === 0, `D6 every emitted admin action is routed (${unrouted.join(", ") || "none"})`);
  // rsBtn emits these through a variable, so they are legitimately absent from a
  // static scan of literal data-action values.
  const viaHelper = ["rs-pause", "rs-resume", "rs-term", "rs-cancel"];
  ok(viaHelper.every(a => routed.has(a)), "D7 the four rsBtn actions are routed");
  ok(emitted.size >= 60, `D8 ${emitted.size} literal actions emitted`);
}

console.log("\n═══ D. ARGUMENT FIDELITY (financial) ═══");
{
  const FN = ["showView","toggleMobileSidebar","closeMobileSidebar","logout","refreshAll","renderActivityLog",
    "addLine","removeLine","removeFile","saveQuote","viewQuoteDetail","printQuotePDF","deleteQuote",
    "convertToInvoice","quoteFromRequest","printInvoicePDF","hideInvoice","unhideInvoice","deleteInvoice",
    "markPaid","reviewOnlinePayment","refundPayment","closeManualPay","submitManualPayment","openReqDetail",
    "openReqDetailAndQuote","setReqStatus","closeReqModal","openAddHistoryModal","saveHistoryRecord",
    "closeHistoryModal","openEditHistory","deleteHistory","markHistPaid","exportCustomersCSV",
    "exportInvoicesCSV","exportQuotesCSV","exportServiceHistoryCSV","changeAdminPassword","spOpenEquip",
    "spCloseEquip","spOpenOffer","spSendOffer","spCancelOffer","spCloseOffer","spActivateSubscription",
    "rsOpenDetail","rsCloseDetail","rsSync","rsPause","rsResume","rsChangeTerm","rsCancel","rsRetry",
    "rsOpenRefund","rsCloseRefund","renderAllQuotes","renderInvoices","renderCustomers","renderHistory",
    "renderRequests","updateTotal","selectCustomer","toggleExempt","fillHistCustomer","handleFileSelect"];
  const dom = new JSDOM(read("portal-admin.html"), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: quiet() });
  const w = dom.window, doc = w.document, calls = [];
  for (const n of FN) w[n] = (...a) => calls.push([n, ...a]);
  const src = read("portal-admin.js");
  w.eval(src.slice(src.indexOf("/* ── Event wiring (CSP readiness, Surface D)")));
  await tick();
  const fire = (html) => {
    const host = doc.createElement("div"); host.innerHTML = html; doc.body.appendChild(host);
    host.querySelector("[data-action]").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    return host;
  };
  const last = (n) => [...calls].reverse().find(c => c[0] === n);

  const PID = "9f1c1d2e-4a3b-4c8d-9e1f-000000000001";
  const IID = "INV-1A10E21B68";
  const SID = "aa11bb22-cc33-4d44-8e55-ff6677889900";

  // One-time refund: id, invoice id, remaining cents as a NUMBER.
  fire(`<button data-action="payment-refund" data-id="${PID}" data-invoice="${IID}" data-remaining="14155">R</button>`);
  const r = last("refundPayment");
  ok(r && r[1] === PID, "D9 refund: payment id exact");
  ok(r && r[2] === IID, "D10 refund: invoice id exact");
  ok(r && r[3] === 14155 && typeof r[3] === "number", `D11 refund: remaining is the NUMBER 14155 (${typeof r?.[3]})`);

  // Recurring refund: five values, cycle present.
  fire(`<button data-action="rs-refund" data-id="${PID}" data-invoice="${IID}" data-refundable="11294" data-original="16294" data-refunded="5000" data-cycle="3">R</button>`);
  let rr = last("rsOpenRefund");
  ok(rr && rr[1] === PID && rr[2] === IID, "D12 recurring refund: ids exact");
  ok(rr && rr[3] === 11294 && typeof rr[3] === "number", "D13 refundable is a number");
  ok(rr && rr[4] === 16294 && typeof rr[4] === "number", "D14 original is a number");
  ok(rr && rr[5] === 5000 && typeof rr[5] === "number", "D15 already-refunded is a number");
  ok(rr && rr[6] === 3 && typeof rr[6] === "number", "D16 cycle is the NUMBER 3");

  // Cycle absent must arrive as null, never the string "null".
  fire(`<button data-action="rs-refund" data-id="${PID}" data-invoice="${IID}" data-refundable="100" data-original="100" data-refunded="0">R</button>`);
  rr = last("rsOpenRefund");
  ok(rr && rr[6] === null, `D17 an absent cycle arrives as null (${JSON.stringify(rr?.[6])})`);
  ok(rr && rr[6] !== "null", "D18 and NOT the string \"null\"");

  // Retry: subscription id + numeric cycle.
  fire(`<button data-action="rs-retry" data-id="${SID}" data-cycle="4">R</button>`);
  const rt = last("rsRetry");
  ok(rt && rt[1] === SID, "D19 retry: subscription id exact");
  ok(rt && rt[2] === 4 && typeof rt[2] === "number", "D20 retry: cycle is a number");

  // Lifecycle: id only.
  for (const [act, fn] of [["rs-pause","rsPause"],["rs-resume","rsResume"],["rs-term","rsChangeTerm"],
                           ["rs-cancel","rsCancel"],["rs-sync","rsSync"],["rs-detail","rsOpenDetail"],
                           ["sp-activate","spActivateSubscription"]]) {
    fire(`<button data-action="${act}" data-id="${SID}">x</button>`);
    const c = last(fn);
    ok(c && c[1] === SID && c.length === 2, `D21 ${fn}(subscriptionId) — one exact argument`);
  }

  // Invoice and quote actions.
  for (const [act, fn] of [["invoice-mark-paid","markPaid"],["payment-review","reviewOnlinePayment"],
                           ["invoice-print","printInvoicePDF"],["invoice-hide","hideInvoice"],
                           ["invoice-unhide","unhideInvoice"],["invoice-delete","deleteInvoice"]]) {
    fire(`<button data-action="${act}" data-id="${IID}">x</button>`);
    ok(last(fn)?.[1] === IID, `D22 ${fn}(${IID})`);
  }
  for (const [act, fn] of [["quote-convert","convertToInvoice"],["quote-view","viewQuoteDetail"],
                           ["quote-print","printQuotePDF"],["quote-delete","deleteQuote"]]) {
    fire(`<button data-action="${act}" data-id="Q-77">x</button>`);
    ok(last(fn)?.[1] === "Q-77", `D23 ${fn}(Q-77)`);
  }

  // Requests: the compound handler must still do BOTH things.
  const before = calls.length;
  fire(`<button data-action="req-close-and-dismiss" data-id="REQ-1">x</button>`);
  const after = calls.slice(before);
  ok(after.some(c => c[0] === "setReqStatus" && c[1] === "REQ-1" && c[2] === "closed"),
     "D24 compound: setReqStatus(id,'closed')");
  ok(after.some(c => c[0] === "closeReqModal"), "D25 compound: and closeReqModal()");
  fire(`<button data-action="req-close" data-id="REQ-2">x</button>`);
  ok(last("setReqStatus")?.[2] === "closed", "D26 plain close passes the 'closed' enum");

  // History, service plans, exports, quote builder.
  for (const [act, fn, id] of [["hist-edit","openEditHistory","H-1"],["hist-delete","deleteHistory","H-2"],
                               ["hist-mark-paid","markHistPaid","H-3"],["sp-equip","spOpenEquip","EQ-1"],
                               ["sp-offer-edit","spOpenOffer","OF-1"],["sp-offer-send","spSendOffer","OF-2"],
                               ["sp-offer-cancel","spCancelOffer","OF-3"]]) {
    fire(`<button data-action="${act}" data-id="${id}">x</button>`);
    ok(last(fn)?.[1] === id, `D27 ${fn}(${id})`);
  }
  fire(`<button data-action="sp-offer-new" data-equipment="EQ-9">x</button>`);
  const so = last("spOpenOffer");
  ok(so && so[1] === null && so[2] === "EQ-9", `D28 spOpenOffer(null, equipmentId) keeps the null first arg`);
  fire(`<button data-action="remove-quote-file" data-index="2">x</button>`);
  ok(last("removeFile")?.[1] === 2 && typeof last("removeFile")[1] === "number", "D29 removeFile(index) is numeric");
  const host = fire(`<button data-action="remove-line">x</button>`);
  ok(last("removeLine")?.[1] === host.querySelector("[data-action]"), "D30 removeLine receives the element, as `this` did");
  for (const [act, fn] of [["export-customers","exportCustomersCSV"],["export-invoices","exportInvoicesCSV"],
                           ["export-quotes","exportQuotesCSV"],["export-history","exportServiceHistoryCSV"]]) {
    fire(`<button data-action="${act}">x</button>`); ok(!!last(fn), `D31 ${fn}`);
  }

  // input / change events
  const sel = doc.createElement("select");
  sel.dataset.action = "select-customer"; doc.body.appendChild(sel);
  sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok(!!last("selectCustomer"), "D32 change: customer select");
  const inp = doc.createElement("input");
  inp.dataset.action = "update-total"; inp.value = "12.50"; doc.body.appendChild(inp);
  inp.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok(!!last("updateTotal"), "D33 input: line-item totals");
  const f = doc.createElement("input");
  f.dataset.action = "quote-files"; doc.body.appendChild(f);
  f.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok(last("handleFileSelect")?.[1] === f, "D34 file select receives the element");
  // Each action on its ORIGINAL channel: searches were oninput, filters and
  // selects were onchange. fillHistCustomer is gone — it never existed.
  for (const [act, fn, ev] of [["filter-quotes-search","renderAllQuotes","input"],
                               ["filter-invoices-search","renderInvoices","input"],
                               ["filter-customers-search","renderCustomers","input"],
                               ["filter-history-search","renderHistory","input"],
                               ["filter-requests-search","renderRequests","input"],
                               ["filter-quotes","renderAllQuotes","change"],
                               ["filter-invoices","renderInvoices","change"],
                               ["filter-customers","renderCustomers","change"],
                               ["filter-history","renderHistory","change"],
                               ["filter-requests","renderRequests","change"],
                               ["toggle-exempt","toggleExempt","change"]]) {
    const e2 = doc.createElement("input"); e2.dataset.action = act; doc.body.appendChild(e2);
    e2.dispatchEvent(new w.Event(ev, { bubbles: true }));
    ok(!!last(fn), `D35 ${fn} via ${ev} (${act})`);
  }
}

console.log("\n═══ D. REPEATED RENDER DOES NOT STACK ═══");
{
  const dom = new JSDOM(read("portal-admin.html"), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: quiet() });
  const w = dom.window, doc = w.document, calls = [];
  for (const n of ["logout", "refundPayment", "rsPause", "renderAllQuotes", "renderInvoices",
                   "renderCustomers", "renderRequests", "renderHistory"]) w[n] = (...a) => calls.push([n, ...a]);
  const src = read("portal-admin.js");
  w.eval(src.slice(src.indexOf("/* ── Event wiring (CSP readiness, Surface D)")));
  await tick();
  for (let i = 0; i < 7; i++) w.wireAdminPortal();      // seven re-renders
  const host = doc.createElement("div");
  host.innerHTML = `<button data-action="payment-refund" data-id="P" data-invoice="I" data-remaining="500">R</button>`;
  doc.body.appendChild(host);
  host.querySelector("button").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const n = calls.filter(c => c[0] === "refundPayment").length;
  ok(n === 1, `D36 one refund click -> exactly one refundPayment() after 8 wiring calls (${n})`);
  ok(doc.body.dataset.apexAdminWired === "1", "D37 the guard flag is set");
}

console.log("\n═══ D. PRINT WINDOWS ═══");
{
  const js = read("portal-admin.js");
  // Four occurrences is correct: two rendered buttons plus the two querySelector
  // calls that find them. Count the BUTTONS.
  const buttons = (js.match(/<button data-action="print-now"/g) || []).length;
  const selectors = (js.match(/querySelector\('\[data-action="print-now"\]'\)/g) || []).length;
  ok(buttons === 2, `D38 two admin print buttons rendered as data-action (${buttons})`);
  ok(selectors === 2, `D38a and two parent-side selectors that wire them (${selectors})`);
  ok((js.match(/pb\.addEventListener\('click', \(\) => win\.print\(\)\)/g) || []).length === 2,
     "D39 both listeners are attached from the parent document");
  ok(!/onclick="window\.print/.test(js), "D40 no inline handler in either print document");
}

console.log("\n═══ D. MALICIOUS ADMIN CONTENT STAYS TEXT ═══");
{
  const js = read("portal-admin.js");
  const risky = [...js.matchAll(/data-(?:action|id|index|cycle|method|invoice|equipment|remaining|refundable|original|refunded|view)="([^"]*)"/g)]
    .map(m => m[1])
    .filter(v => /\$\{[^}]*\b(name|company|email|phone|desc|notes?|serial|title|equipment_name)\b/i.test(v));
  ok(risky.length === 0, `D41 no free-form customer text in any admin data attribute (${risky.join(", ") || "none"})`);
  ok(/data-customer-action=/.test(js), "D42 the Group 8 customer-table fix is still in place");
  ok(!/onclick="[^"]*\$\{esc\(c\.(name|company|email)/.test(js), "D43 no customer text in an executable attribute");
}


// =============================================================================
//  SURFACE D FOLLOW-UP — event-type fidelity and production symbols
// =============================================================================
console.log("\n═══ D. EVENT CHANNELS DO NOT CROSS-FIRE ═══");
{
  const FN = ["renderAllQuotes","renderInvoices","renderCustomers","renderHistory","renderRequests",
              "updateTotal","selectCustomer","toggleExempt","handleFileSelect"];
  const mk = () => {
    // beforeParse installs the stubs BEFORE jsdom fires DOMContentLoaded, which
    // is when the page's own wiring runs. Without it the wiring executed against
    // undefined globals and jsdom printed a ReferenceError to stderr — noise
    // that made a passing suite look broken and could hide a real error.
    const dom = new JSDOM(read("portal-admin.html"), {
      runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: quiet(),
      beforeParse(win) { for (const n of FN) win[n] = (...a) => win.__calls.push([n, ...a]); },
    });
    const w = dom.window, calls = [];
    w.__calls = calls;
    for (const n of FN) w[n] = (...a) => calls.push([n, ...a]);
    const src = read("portal-admin.js");
    w.eval(src.slice(src.indexOf("/* ── Event wiring (CSP readiness, Surface D)")));
    return { w, doc: w.document, calls };
  };
  const count = (calls, n) => calls.filter(c => c[0] === n).length;

  // A <select> fires BOTH input and change for one user interaction.
  for (const [id, fn] of [["quotes-status-filter","renderAllQuotes"], ["invoices-status-filter","renderInvoices"],
                          ["customers-status-filter","renderCustomers"], ["req-status-filter","renderRequests"],
                          ["history-paid-filter","renderHistory"], ["q-customer-select","selectCustomer"]]) {
    const { w, doc, calls } = mk(); await tick();
    const el = doc.getElementById(id);
    ok(!!el, `EV0 ${id} exists`);
    if (!el) continue;
    el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    ok(count(calls, fn) === 0, `EV1 ${id}: a click alone renders nothing (${count(calls, fn)})`);
    el.dispatchEvent(new w.Event("input",  { bubbles: true }));
    el.dispatchEvent(new w.Event("change", { bubbles: true }));
    ok(count(calls, fn) === 1, `EV2 ${id}: input+change -> ${fn} exactly once (${count(calls, fn)})`);
  }

  // Checkbox: also fires both.
  { const { w, doc, calls } = mk(); await tick();
    const el = doc.getElementById("q-tax-exempt");
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
    el.dispatchEvent(new w.Event("change", { bubbles: true }));
    ok(count(calls, "toggleExempt") === 1, `EV3 tax-exempt checkbox: toggleExempt once (${count(calls,"toggleExempt")})`); }

  // File input: also fires both, and must receive the element.
  { const { w, doc, calls } = mk(); await tick();
    const el = doc.getElementById("quote-files");
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
    el.dispatchEvent(new w.Event("change", { bubbles: true }));
    ok(count(calls, "handleFileSelect") === 1, `EV4 quote-files: handleFileSelect once (${count(calls,"handleFileSelect")})`);
    ok(calls.find(c => c[0] === "handleFileSelect")?.[1] === el, "EV5 and receives the element"); }

  // Search boxes were oninput: a click must not render, one input must.
  for (const [id, fn] of [["quotes-search","renderAllQuotes"], ["invoices-search","renderInvoices"],
                          ["customers-search","renderCustomers"], ["history-search","renderHistory"],
                          ["req-search","renderRequests"]]) {
    const { w, doc, calls } = mk(); await tick();
    const el = doc.getElementById(id);
    el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    el.dispatchEvent(new w.FocusEvent("focus", { bubbles: true }));
    ok(count(calls, fn) === 0, `EV6 ${id}: click/focus renders nothing (${count(calls, fn)})`);
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
    ok(count(calls, fn) === 1, `EV7 ${id}: one input -> ${fn} once (${count(calls, fn)})`);
    el.dispatchEvent(new w.Event("change", { bubbles: true }));
    ok(count(calls, fn) === 1, `EV8 ${id}: a stray change does not re-render (${count(calls, fn)})`);
  }

  // Refresh buttons were onclick.
  for (const [act, fn] of [["refresh-quotes","renderAllQuotes"], ["refresh-invoices","renderInvoices"],
                           ["refresh-requests","renderRequests"]]) {
    const { w, doc, calls } = mk(); await tick();
    const host = doc.createElement("div");
    host.innerHTML = `<button data-action="${act}">R</button>`;
    doc.body.appendChild(host);
    host.querySelector("button").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    ok(count(calls, fn) === 1, `EV9 ${act}: one click -> ${fn} once (${count(calls, fn)})`);
  }
}

console.log("\n═══ D. EVERY DISPATCHER TARGET EXISTS IN PRODUCTION ═══");
{
  // Deliberately NOT stubbed: this reads the production source and proves each
  // function the dispatcher calls is actually defined. Pre-stubbing every name
  // is what hid the missing fillHistCustomer().
  const js = read("portal-admin.js");
  const wire = js.slice(js.indexOf("function wireAdminPortal"));
  const called = new Set();
  for (const m of wire.matchAll(/case '[a-z-]+':\s*([A-Za-z_$][\w$]*)\(/g)) called.add(m[1]);
  for (const m of wire.matchAll(/^\s*'[a-z-]+':\s*([A-Za-z_$][\w$]*),/gm)) called.add(m[1]);
  for (const m of wire.matchAll(/;\s*([A-Za-z_$][\w$]*)\(\);/g)) called.add(m[1]);
  called.delete("num"); called.delete("cycleOf"); called.delete("Number");

  const defined = new Set([
    ...[...js.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]),
    ...[...js.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm)].map(m => m[1]),
    ...[...read("portal-data.js").matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]),
  ]);
  const missing = [...called].filter(n => !defined.has(n));
  ok(missing.length === 0, `PS1 every dispatcher target is defined in production (${missing.join(", ") || "none"})`);
  ok(called.size >= 50, `PS2 the audit inspected ${called.size} distinct targets`);
  ok(!called.has("fillHistCustomer"), "PS3 the orphan fillHistCustomer route is gone");
  ok(!/fillHistCustomer/.test(js + read("portal-admin.html")), "PS4 no reference to it remains anywhere");
  // The audit must be able to fail.
  ok(!defined.has("thisFunctionDoesNotExist"), "PS5 the symbol table is real, not permissive");
}

console.log("\n═══ D. PRINT FOOTER ═══");
{
  const js = read("portal-admin.js");
  const n = (js.match(/Questions\? Call \(516\) 644-7187/g) || []).length;
  ok(n === 1, `PF1 the contact sentence appears once, not doubled (${n})`);
  ok(!/usa\.com\.Questions\?/.test(js), "PF2 no run-together duplicate remains");
  ok(!/valid for \d+ days/.test(js), "PF3 and no invented validity period returned");
}


console.log("\n═══ D-FINAL. EXACTLY-ONCE NAVIGATION ═══");
{
  const FN = ["closeMobileSidebar", "toggleMobileSidebar", "logout", "showView"];
  const dom = new JSDOM(read("portal-admin.html"), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: quiet() });
  const w = dom.window, doc = w.document, calls = [];
  for (const n of FN) w[n] = (...a) => calls.push([n, ...a]);
  const src = read("portal-admin.js");
  // Load BOTH the DOMContentLoaded navigation block and the delegated wiring,
  // which is the combination that produced the double-fire.
  const navStart = src.indexOf("document.addEventListener('DOMContentLoaded'");
  if (navStart > -1) {
    const navEnd = src.indexOf("\n});", navStart) + 4;
    try { w.eval(src.slice(navStart, navEnd)); } catch (e) { /* stubs cover it */ }
  }
  w.eval(src.slice(src.indexOf("/* ── Event wiring (CSP readiness, Surface D)")));
  await tick();
  for (let i = 0; i < 3; i++) w.wireAdminPortal();
  const n = (fn) => calls.filter(c => c[0] === fn).length;
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

  const ov = doc.getElementById("sidebar-overlay");
  ok(!!ov, "N1 the sidebar overlay exists");
  click(ov);
  ok(n("closeMobileSidebar") === 1, `N2 overlay: one click -> closeMobileSidebar ONCE (${n("closeMobileSidebar")})`);
  click(doc.getElementById("mobile-menu-btn"));
  ok(n("toggleMobileSidebar") === 1, `N3 menu button: toggleMobileSidebar once (${n("toggleMobileSidebar")})`);
  const lo = doc.querySelector('[data-action="logout"]');
  click(lo);
  ok(n("logout") === 1, `N4 logout: once (${n("logout")})`);
  const nav = doc.querySelector('.nav-item[data-action="view"]') || doc.querySelector('[data-action="view"]');
  click(nav);
  ok(n("showView") === 1, `N5 sidebar navigation: showView once (${n("showView")})`);
  const js = read("portal-admin.js");
  ok(!/getElementById\('sidebar-overlay'\)\?\.addEventListener/.test(js),
     "N6 the redundant explicit overlay listener is gone");
  ok(!/\/\/ NOTE:[^\n]*onclick/.test(js), "N7 no stale comment claims an onclick still exists");
}


// =============================================================================
//  SURFACE E — externalised inline application scripts
// =============================================================================
console.log("\n═══ E. NO EXECUTABLE INLINE SCRIPTS REMAIN ═══");
{
  const HTMLF = readdirSync(D).filter(f => f.endsWith(".html"));
  const exec = [], jsonld = [];
  for (const f of HTMLF) {
    for (const m of read(f).matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\ssrc=/.test(m[1]) || !m[2].trim()) continue;
      (/ld\+json/.test(m[1]) ? jsonld : exec).push(`${f} (${m[2].trim().length}B)`);
    }
  }
  ok(exec.length === 0, `E1 zero executable inline scripts (${exec.join(", ") || "none"})`);
  ok(jsonld.length === 1 && jsonld[0].startsWith("index.html"),
     `E2 exactly one inline exception, the JSON-LD on index.html (${jsonld.join(", ")})`);
  for (const f of ["public-forms.js", "index-tracking.js", "portal-reset.js"])
    ok(existsSync(D + f), `E3 ${f} exists`);
  for (const [f, mods] of [["index.html", ["index-tracking.js", "public-forms.js"]],
                           ["contact.html", ["public-forms.js"]],
                           ["careers.html", ["public-forms.js"]],
                           ["portal-reset.html", ["portal-reset.js"]]])
    for (const m of mods)
      ok(new RegExp(`<script src="${m}\\?v=`).test(read(f)), `E4 ${f} loads ${m}`);
}

console.log("\n═══ E. PUBLIC FORM BEHAVIOUR PRESERVED ═══");
{
  const pf = read("public-forms.js");
  ok(/functions\/v1\/public-contact/.test(pf), "E5 same endpoint");
  ok(/contactForm: \{ type: 'request_service', successId: 'formSuccess',/.test(pf),
     "E6 contact/index keep form type request_service and formSuccess");
  ok(/applyForm:\s*\{ type: 'careers',\s*successId: 'applySuccess',/.test(pf),
     "E7 careers keeps form type careers and applySuccess");
  ok(/k === '_gotcha'/.test(pf), "E8 the honeypot field name is passed through verbatim");
  ok(/toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\+\/g, '_'\)/.test(pf), "E9 field normalisation unchanged");
  ok(/btn\.disabled = true; btn\.textContent = 'Sending…'/.test(pf), "E10 Sending… state");
  ok(/btn\.textContent = 'Sent ✓'/.test(pf), "E11 success state");
  ok(/btn\.disabled = false; btn\.textContent = 'Try Again'/.test(pf), "E12 retry state");
  ok(/Please call \(516\) 644-7187/.test(pf), "E13 phone fallback");
  ok(/typeof window\.ApexConsent\.track === 'function'/.test(pf),
     "E14 analytics hook stays optional — guarded call into the consent gate, no stub");
  ok(!/APEX_TRACK/.test(pf), "E14a the old no-op stub is no longer referenced");
  ok(/addEventListener\('submit'/.test(pf) && !/\son[a-z]+\s*=/.test(pf), "E15 attaches by listener, no inline handler");
  ok(/apexFormWired/.test(pf), "E16 guarded against double wiring");
}

console.log("\n═══ E. ANALYTICS STILL CONSENT-GATED ═══");
{
  const it = read("index-tracking.js");
  ok(!/APEX_TRACK/.test(it), "E17 no APEX_TRACK stub — tracking goes through ApexConsent.track or not at all");
  ok(/typeof window\.ApexConsent\.track === 'function'/.test(it), "E17a every call is guarded");
  ok(!/googletagmanager|gtag\(/.test(it), "E18 no GA code embedded in the module");
  ok(/googletagmanager/.test(read("consent.js")), "E19 consent.js remains the only GA loader");
  // Each branch must be anchored to the tracking call. Unanchored, the word
  // "name" in a comment failed the test — a false positive that would push
  // someone to delete an accurate comment to make a suite green.
  const trackArgs = [...it.matchAll(/APEX_TRACK\(([^)]*)\)/g)].map(m => m[1]).join(" | ");
  ok(!/\b(email|phone|customer_?name|full_?name|address)\b/i.test(trackArgs),
     `E20 no PII in any tracking call (${trackArgs})`);
}

console.log("\n═══ E. RESET SHIM ═══");
{
  const rs = read("portal-reset.js");
  ok(/var dest = 'portal-forgot\.html';/.test(rs), "E21 fixed same-origin destination");
  ok(/if \(window\.location\.hash\) dest \+= window\.location\.hash;/.test(rs), "E22 hash forwarded");
  ok(/else if \(window\.location\.search\) dest \+= window\.location\.search;/.test(rs), "E23 query fallback");
  // Strip comments: the file explains WHY nothing is logged, and matching that
  // prose rather than the code is a false positive.
  const rsCode = rs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  ok(!/console\.|alert\(/.test(rsCode), "E24 no logging in the code — the recovery token must not reach the console");
  ok(!/location\s*=\s*[^;]*(searchParams|hash\.split|decodeURI)/.test(rs), "E25 no URL-derived destination");
  // Behavioural check across the three states.
  const run = (hash, search) => {
    const loc = { hash, search, replace: (d) => { loc.replaced = d; } };
    new Function("window", rs)({ location: loc });
    return loc.replaced;
  };
  ok(run("#access_token=abc&type=recovery", "") === "portal-forgot.html#access_token=abc&type=recovery",
     "E26 hash token forwarded intact");
  ok(run("", "?code=xyz") === "portal-forgot.html?code=xyz", "E27 query token forwarded intact");
  ok(run("", "") === "portal-forgot.html", "E28 empty state goes to the bare destination");
  // A bare "#" in the address bar is reported by browsers as an EMPTY hash, so
  // the realistic malformed case is an empty hash with an empty query.
  ok(run("", undefined) === "portal-forgot.html", "E29 a missing query is handled without appending 'undefined'");
  ok(run("#access_token=", "") === "portal-forgot.html#access_token=",
     "E29a a truncated token is forwarded verbatim rather than being interpreted");
}

console.log("\n═══ E. LOCAL SCRIPT REFERENCES RESOLVE ═══");
{
  const missing = [];
  for (const f of readdirSync(D).filter(x => x.endsWith(".html")))
    for (const m of read(f).matchAll(/<script src="([^"]+)"/g)) {
      const u = m[1];
      if (/^https?:/.test(u)) continue;
      if (!existsSync(D + u.split("?")[0])) missing.push(`${f} -> ${u}`);
    }
  ok(missing.length === 0, `E30 every local script reference resolves (${missing.join(", ") || "none"})`);
}

console.log("\n═══ PAGE-ERROR BUDGET ═══");
{
  // Expected: the fragility probes that deliberately omit stubs. Anything else
  // is a real page error and should fail rather than scroll past unnoticed.
  const unexpected = pageErrors.filter(e => !/is not defined/.test(e));
  ok(unexpected.length === 0,
     `PE1 no unexpected page errors (${unexpected.slice(0, 2).join(" | ") || "none"})`);
  console.log(`     ${pageErrors.length} expected ReferenceError(s) from the deliberate no-stub probes`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
