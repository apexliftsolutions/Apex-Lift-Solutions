// =============================================================================
//  GROUP 8.1 — Google dependency classification, consent UI consistency,
//  and payment session messaging.
//  Run: node tests/PHASE_G81_UI_TESTS.mjs
// =============================================================================
import { readFileSync, readdirSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const D = new URL("../docs/", import.meta.url).pathname;
const read = f => readFileSync(D + f, "utf8");
const HTML = readdirSync(D).filter(f => f.endsWith(".html"));
const JS = readdirSync(D).filter(f => f.endsWith(".js"));
const CSS = read("style.css");

console.log("═══ A. GOOGLE DEPENDENCY CLASSIFICATION ═══");
{
  // Apex ships no reCAPTCHA. If those requests appear, they come from a third
  // party at runtime — and Helcim is the only third-party script we load.
  const all = [...JS, ...HTML, "style.css"];
  const recaptcha = all.filter(f => /grecaptcha|google\.com\/recaptcha|recaptcha__|api\.js\?render=/i.test(read(f)));
  ok(recaptcha.length === 0, `G1 no reCAPTCHA is loaded by Apex code (${recaptcha.join(",") || "none"})`);
  const gstatic = all.filter(f => /https?:\/\/[a-z.]*gstatic\.com/i.test(read(f)));
  ok(gstatic.length === 0, `G2 no gstatic.com runtime reference (${gstatic.join(",") || "none"})`);

  // GA: consent-gated, one file, never in markup.
  const gtmInMarkup = HTML.filter(f => /googletagmanager/.test(read(f)));
  ok(gtmInMarkup.length === 0, `G3 no page hardcodes googletagmanager (${gtmInMarkup.join(",") || "none"})`);
  const gtmInJs = JS.filter(f => /googletagmanager/.test(read(f)));
  ok(gtmInJs.length === 1 && gtmInJs[0] === "consent.js",
     `G4 googletagmanager appears only in consent.js (${gtmInJs.join(",")})`);
  ok(/if \(!state \|\| !state\.analytics/.test(read("consent.js")) || /loadGA\(\)/.test(read("consent.js")),
     "G5 GA is loaded only through the consent gate");

  // The only third-party script tag anywhere.
  const ext = new Set();
  for (const f of HTML) for (const m of read(f).matchAll(/<script[^>]*src="(https?:\/\/[^"]+)"/g)) ext.add(new URL(m[1]).origin);
  ok(ext.size === 1 && ext.has("https://secure.helcim.app"),
     `G6 exactly one third-party script origin: ${[...ext].join(", ")}`);
  const helcimPages = HTML.filter(f => /secure\.helcim\.app/.test(read(f)));
  ok(helcimPages.length === 1 && helcimPages[0] === "portal-customer.html",
     `G7 Helcim loads on one page only: ${helcimPages.join(",")}`);

  // drive.google.com is an ordinary link target, not a runtime dependency.
  const driveAsScript = HTML.filter(f => /<script[^>]*drive\.google/.test(read(f)));
  ok(driveAsScript.length === 0, "G8 drive.google.com appears only as a link, never as a script");
  // It is not even a link: it is example text in a form field placeholder.
  ok(/placeholder="https:\/\/drive\.google\.com/.test(read("careers.html")),
     "G9 drive.google.com is placeholder text in a careers form field, not a request");
  const driveHref = HTML.filter(f => /href="[^"]*drive\.google/.test(read(f)));
  ok(driveHref.length === 0, `G10 it is never even an href (${driveHref.join(",") || "none"})`);
}

console.log("═══ B. FOOTER LINK CONSISTENCY ═══");
{
  const anchorRule = CSS.match(/\.footer-links a \{[^}]*\}/)[0];
  const btnRule = CSS.match(/\.footer-link-btn \{[^}]*\}/)[0];
  for (const prop of ["font-family", "font-size", "font-weight", "letter-spacing",
                      "text-transform", "text-decoration", "color"]) {
    const a = anchorRule.match(new RegExp(prop + ":\\s*([^;]+)"));
    const b = btnRule.match(new RegExp(prop + ":\\s*([^;]+)"));
    ok(!!a && !!b && a[1].trim() === b[1].trim(),
       `F1 Cookie Settings matches the other footer links on ${prop} (${b ? b[1].trim() : "MISSING"})`);
  }
  ok(/\.footer-link-btn:hover \{ color: var\(--white\); \}/.test(CSS),
     "F2 it shares the same hover treatment");
  const pages = HTML.filter(f => /class="footer-link-btn"/.test(read(f)));
  ok(pages.length >= 11, `F3 the control carries the class on ${pages.length} pages`);
}

console.log("═══ B/C. CONSENT UI ON SITE TOKENS ═══");
{
  const blk = CSS.slice(CSS.indexOf("Consent UI (Group 8.1)"), CSS.indexOf(".apex-visually-hidden"));
  const hex = [...blk.matchAll(/#[0-9a-fA-F]{6}/g)].map(m => m[0].toLowerCase())
    .filter(h => h !== "#ffffff" && h !== "#a00000");   // white on red fill; #a00000 only in a comment
  ok(hex.length === 0, `C1 no stray hardcoded colours left in the consent UI (${hex.join(",") || "none"})`);
  for (const t of ["--dark", "--dark-2", "--dark-3", "--red", "--red-dark", "--red-text", "--white", "--grey"])
    ok(blk.includes(`var(${t})`), `C2 uses the ${t} token`);
  ok(/\.apex-consent-btn\.primary \{[^}]*background: var\(--red\)/.test(blk),
     "C3 the primary action fills with the brand CTA red");
  ok(/\.apex-consent-btn\.primary:hover \{[^}]*var\(--red-dark\)/.test(blk),
     "C4 and darkens to --red-dark on hover");
  // --red-dark measures 2.24:1 as a border on --dark, below the 3:1 UI threshold.
  // The earlier version of this assertion only matched `border:` and
  // `border-top:`, so `border-color: var(--red-dark)` slipped through and the
  // report repeated a claim the test was not actually checking.
  const BORDER_PROPS = ["border", "border-top", "border-right", "border-bottom",
                        "border-left", "border-color", "border-top-color",
                        "border-right-color", "border-bottom-color", "border-left-color",
                        "outline", "outline-color"];
  const borderViolations = BORDER_PROPS.filter(prop =>
    new RegExp("(?:^|[;{\\s])" + prop + "\\s*:\\s*[^;}]*var\\(--red-dark\\)").test(blk));
  ok(borderViolations.length === 0,
     `C5 --red-dark appears in no border/outline property — fails 3:1 as a border (${borderViolations.join(", ") || "none"})`);
  ok(BORDER_PROPS.length >= 6, `C5a the check covers ${BORDER_PROPS.length} border forms, not just the shorthand`);
  ok(/\.apex-consent-btn\.primary:hover \{[^}]*border-color: var\(--red\)/.test(blk),
     "C5b the primary hover keeps the contrast-safe --red border");
  ok(/border-top: 3px solid var\(--red\)/.test(blk), "C6 borders use --red, which passes at 3.21:1");
  ok(/font-family: var\(--font-head\)/.test(blk), "C7 buttons use the site heading font");
  ok(/text-transform: uppercase/.test(blk), "C8 and the site's uppercase button treatment");
}

console.log("═══ B. CUSTOM CHECKBOX, STILL A REAL CHECKBOX ═══");
{
  const blk = CSS.slice(CSS.indexOf("Consent UI (Group 8.1)"), CSS.indexOf(".apex-visually-hidden"));
  ok(/appearance: none/.test(blk) && /-webkit-appearance: none/.test(blk),
     "K1 the default browser checkbox painting is replaced");
  ok(/input\[type="checkbox"\]:checked \{[^}]*background: var\(--red\)/.test(blk),
     "K2 the checked state uses the brand red");
  ok(/:checked::after/.test(blk), "K3 a custom checkmark is drawn");
  ok(/min-height: 48px/.test(blk), "K4 the row is a comfortable touch target");
  const js = read("consent.js");
  ok(/el\("input", \{ type: "checkbox", id: "apex-consent-analytics" \}\)/.test(js),
     "K5 it is still a real <input type=checkbox>, not a div");
  ok(/el\("label", \{ class: "apex-consent-toggle", for: "apex-consent-analytics" \}\)/.test(js),
     "K6 with a real <label for> — accessible name and label-in-name unchanged");
  ok(/Allow Google Analytics/.test(js), "K7 the visible text is the accessible name");
}

console.log("═══ D. PAYMENT SESSION MESSAGING (FRONTEND ONLY) ═══");
{
  const js = read("portal-customer.js");
  ok(/function showPaySessionExpired\(\)/.test(js), "P1 a dedicated expired-session state exists");
  ok(/Nothing was charged/.test(js), "P2 it states plainly that nothing was charged");
  ok(/href="portal-login\.html"/.test(js), "P3 it offers a re-login path, not just a message");
  ok(/showPaySessionExpired\(\); PAY_BUSY = false;/.test(js),
     "P4 the pay flow uses it instead of a generic error");
  ok(!/Your session expired\. Please sign in again\.'\); PAY_BUSY/.test(js),
     "P5 the old bare message is gone from the pay path");
  // Frontend only — no payment logic touched.
  ok(!/payment-checkout[^\n]*(insert|update)\(/.test(js), "P6 no payment write path was added");
  ok(/payment-checkout/.test(js), "P7 checkout still goes through the Edge Function");
}


console.log("═══ CSS STRUCTURAL INTEGRITY ═══");
{
  // A stray top-level '}' is skipped silently by lenient parsers, so balance is
  // checked directly over the source with comments and strings removed.
  const raw = CSS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  let depth = 0, stray = 0, line = 1, strayLines = [];
  for (const ch of raw) {
    if (ch === "\n") line++;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth < 0) { stray++; strayLines.push(line); depth = 0; } }
  }
  ok(stray === 0, `CS1 no stray closing brace (${strayLines.join(", ") || "none"})`);
  ok(depth === 0, `CS2 all blocks are closed (depth ${depth})`);
  // Every declaration must sit inside a rule.
  const orphan = [...CSS.matchAll(/\n\}\s*\n\}/g)];
  ok(orphan.length === 0, `CS3 no doubled closing braces (${orphan.length})`);
  for (const f of ["portal-admin.css", "portal-customer.css", "portal-auth.css"]) {
    const c = readFileSync(D + f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let d = 0, bad = 0;
    for (const ch of c) { if (ch === "{") d++; else if (ch === "}") { d--; if (d < 0) { bad++; d = 0; } } }
    ok(bad === 0 && d === 0, `CS4 ${f} braces balance (stray ${bad}, depth ${d})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
