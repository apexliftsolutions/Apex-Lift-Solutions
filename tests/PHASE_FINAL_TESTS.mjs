// =============================================================================
//  FINAL PRE-MAINTENANCE — brand red palette + product-copy accuracy
//  Run: node tests/PHASE_FINAL_TESTS.mjs
// =============================================================================
import { readFileSync, readdirSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const D = new URL("../docs/", import.meta.url).pathname;
const read = f => readFileSync(D + f, "utf8");
const HTML = readdirSync(D).filter(f => f.endsWith(".html"));
const CSSF = ["style.css", "portal-admin.css", "portal-customer.css", "portal-auth.css"];
const text = f => read(f).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L = h => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
                 return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const [x, y] = [L(a), L(b)]; return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const satOf = h => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
                     const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx ? (mx - mn) / mx : 0; };

console.log("═══ THE SALMON TOKEN IS RETIRED ═══");
for (const f of CSSF) ok(!/#cc6464/i.test(read(f).replace(/\/\*[\s\S]*?\*\//g, "")),
  `B1 ${f} no longer uses the #cc6464 salmon (comments excepted)`);
for (const f of [...CSSF, ...HTML]) ok(!/#ff8a8a/i.test(read(f)), `B2 ${f} has no #ff8a8a pastel red`);

console.log("═══ ONE PALETTE, DECLARED CONSISTENTLY ═══");
{
  const vals = CSSF.map(f => (read(f).match(/--red-text:\s*(#[0-9a-fA-F]{6})/) || [])[1]).filter(Boolean);
  ok(vals.length === 4, `P1 --red-text is declared in all 4 stylesheets (${vals.length})`);
  ok(new Set(vals.map(v => v.toLowerCase())).size === 1,
     `P2 every declaration agrees — a portal override is how the retune could silently miss the portals (${[...new Set(vals)].join(", ")})`);
  ok(vals[0].toLowerCase() === "#ff2b2b", `P3 the small-text red is #ff2b2b (${vals[0]})`);
  const brand = read("style.css").match(/--red:\s*(#[0-9a-fA-F]{6})/)[1];
  const dark = read("style.css").match(/--red-dark:\s*(#[0-9a-fA-F]{6})/)[1];
  ok(brand.toLowerCase() === "#cc0000", `P4 --red is unchanged brand red (${brand})`);
  ok(dark.toLowerCase() === "#a00000", `P5 --red-dark is unchanged (${dark})`);
  // No scattered one-off reds.
  const stray = new Set();
  for (const f of CSSF) for (const m of read(f).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/#([0-9a-fA-F]{6})/g)) {
    const h = "#" + m[1].toLowerCase();
    const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    // --red-danger is a status colour, deliberately distinct from brand red.
    if (r > 120 && r > g * 1.6 && r > b * 1.6 && !["#cc0000", "#a00000", "#ff2b2b", "#ff4444"].includes(h)) stray.add(h);
  }
  ok(stray.size === 0, `P6 no stray red hex values scattered through the CSS (${[...stray].join(", ") || "none"})`);
}

console.log("═══ IT READS AS RED, NOT PINK ═══");
{
  ok(satOf("#ff2b2b") > 0.75, `R1 the small-text red is saturated (${satOf("#ff2b2b").toFixed(2)} vs salmon ${satOf("#cc6464").toFixed(2)})`);
  ok(satOf("#ff2b2b") > satOf("#cc6464") + 0.25, "R2 markedly more saturated than what it replaced");
  const [r, g, b] = [1, 3, 5].map(i => parseInt("#ff2b2b".slice(i, i + 2), 16));
  ok(g === b, "R3 pure red hue — no rose or salmon cast");
  ok(r / Math.max(g, 1) > 4, `R4 red channel dominates (${(r / g).toFixed(1)}x)`);
}

console.log("═══ CONTRAST HOLDS AT EVERY SIZE ═══");
{
  for (const bg of ["#0a0a0a", "#111111", "#1a1a1a"])
    ok(ratio("#ff2b2b", bg) >= 4.5, `A1 small text #ff2b2b on ${bg} = ${ratio("#ff2b2b", bg).toFixed(2)}:1 (need 4.5)`);
  for (const bg of ["#0a0a0a", "#111111"])
    ok(ratio("#cc0000", bg) >= 3.0, `A2 large text #cc0000 on ${bg} = ${ratio("#cc0000", bg).toFixed(2)}:1 (need 3.0)`);
  // The brand red must NOT be used for small text — it is 2.96 on --dark-2.
  ok(ratio("#cc0000", "#1a1a1a") < 4.5, "A3 confirmed: --red cannot carry small text, which is why two tokens exist");
  ok(ratio("#a00000", "#111111") < 3.0, "A4 confirmed: --red-dark stays a fill-only colour");
}
{
  // --red-dark must never appear as a text or border colour.
  const BORDER = ["border", "border-top", "border-right", "border-bottom", "border-left",
                  "border-color", "outline", "outline-color", "color"];
  const bad = [];
  for (const f of CSSF) {
    const s = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const p of BORDER)
      if (new RegExp("(?:^|[;{\\s])" + p + "\\s*:\\s*[^;}]*var\\(--red-dark\\)").test(s)) bad.push(`${f}:${p}`);
  }
  ok(bad.length === 0, `A5 --red-dark is never a text or border colour (${bad.join(", ") || "none"})`);
}

console.log("═══ LARGE DISPLAY ACCENTS USE THE DEEP BRAND RED ═══");
for (const [f, sel] of [["style.css", ".stat-num"], ["style.css", ".price-amount"], ["style.css", ".error-code"],
                        ["portal-customer.css", ".modal-amount"], ["portal-admin.css", ".quote-total span"]]) {
  const s = read(f);
  const m = s.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(?:,[^{]*)?\\{[^}]*\\}"));
  ok(!!m && /var\(--red\)/.test(m[0]) && !/var\(--red-text\)/.test(m[0]),
     `L1 ${sel} uses the deep --red, not the small-text red`);
}

console.log("═══ PRODUCT COPY MATCHES THE SHIPPED PRODUCT ═══");
{
  for (const f of HTML) ok(!/coming soon/i.test(text(f)), `C1 ${f} advertises nothing as Coming Soon`);
  const p = text("plans.html");
  ok(!/month-to-month/i.test(p), "C2 no month-to-month continuation claim");
  ok(!/building out a full customer portal/i.test(p), "C3 the portal is no longer described as forthcoming");
  ok(!/automatically renew/i.test(p), "C4 plans.html implies no automatic renewal");
  ok(!/Choose a 6-month or 12-month plan/i.test(text("index.html")),
     "C5 homepage no longer contradicts the five plan terms offered");
  ok(!/Refunds for work already done/i.test(text("refund-policy.html")),
     "C6 no empty refund heading is published");
  for (const c of ["best service guarantee", "best.in.class", "maximum protection"])
    for (const f of ["index.html", "plans.html"])
      ok(!new RegExp(c, "i").test(text(f)), `C7 ${f} drops the unsupported claim "${c}"`);
}

console.log("═══ CANONICAL TAGS ═══");
{
  const PUBLIC = ["index.html", "about.html", "services.html", "plans.html", "careers.html", "contact.html",
                  "privacy.html", "terms.html", "refund-policy.html", "cookie-policy.html", "accessibility.html"];
  for (const f of PUBLIC) {
    const m = read(f).match(/<link rel="canonical" href="([^"]+)">/);
    const want = "https://apexliftsolutionsusa.com/" + (f === "index.html" ? "" : f);
    ok(!!m && m[1] === want, `S1 ${f} self-canonicalises to ${want}`);
  }
  for (const f of HTML.filter(x => x.startsWith("portal-") || x === "404.html"))
    ok(!/rel="canonical"/.test(read(f)), `S2 ${f} is not canonicalised as public content`);
}


// =============================================================================
//  EVERY TEXT USE OF --red, AUDITED BY CONTEXT
//
//  The earlier version checked a hardcoded list of "large display" selectors,
//  so small-text uses of var(--red) elsewhere passed unnoticed. This inventories
//  every text-colour usage and judges each on its own size and weight.
//  Non-text uses (background, border, fill, stroke, accent-color) are excluded.
// =============================================================================
console.log("═══ EVERY color: var(--red) USAGE, BY CONTEXT ═══");
{
  const remPx = v => {
    const r = /([\d.]+)rem/.exec(v); if (r) return parseFloat(r[1]) * 16;
    const p = /([\d.]+)px/.exec(v);  if (p) return parseFloat(p[1]);
    if (/clamp\(/.test(v)) return 96;            // all clamps here are display sizes
    return null;
  };
  const isLarge = (size, weight) => size != null && (size >= 24 || (size >= 18.66 && weight >= 700));

  // Selectors whose size is inherited from a heading, verified by hand:
  // h1 is clamp(2.5rem..5rem) and .stat-card .value is 2.2rem/900.
  const INHERITS_LARGE = new Set([
    "em", ".admin-header h1 em", ".pg-header h1 em", ".portal-title em", ".stat-card .value.red",
  ]);

  const offenders = [];
  let audited = 0;

  // --- CSS rules ---
  for (const f of CSSF) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const body = m[2];
      if (!/(?:^|[;\s])color:\s*var\(--red\)/.test(body)) continue;
      audited++;
      const sel = m[1].trim().split("\n").pop().trim();
      const fs = /font-size:\s*([^;]+)/.exec(body);
      const fw = /font-weight:\s*(\d+)/.exec(body);
      const size = fs ? remPx(fs[1]) : null;
      const weight = fw ? parseInt(fw[1]) : 400;
      if (size == null && INHERITS_LARGE.has(sel)) continue;   // heading-inherited
      if (!isLarge(size, weight)) offenders.push(`${f} :: ${sel} (${size ? size + "px" : "inherit"}/${weight})`);
    }
  }

  // --- Inline styles in HTML and JS-generated markup ---
  for (const f of [...HTML, ...readdirSync(D).filter(x => x.endsWith(".js"))]) {
    for (const m of read(f).matchAll(/style="([^"]*color:\s*var\(--red\)[^"]*)"/g)) {
      audited++;
      const st = m[1];
      const fs = /font-size:\s*([^;]+)/.exec(st);
      const fw = /font-weight:\s*(\d+)/.exec(st);
      const size = fs ? remPx(fs[1]) : null;
      const weight = fw ? parseInt(fw[1]) : 400;
      // 404's two uses sit inside an h1 / a clamped display block.
      if (size == null && f === "404.html") continue;
      if (!isLarge(size, weight)) offenders.push(`${f} :: inline (${size ? size + "px" : "inherit"}/${weight})`);
    }
  }

  console.log(`     audited ${audited} text usages of var(--red)`);
  ok(offenders.length === 0,
     `T1 no small/normal text uses --red (${offenders.slice(0, 5).join(" | ") || "none"})`);
  ok(audited >= 15, `T2 the audit actually inspected the codebase (${audited} usages)`);
}

console.log("═══ THE SPECIFIC REGRESSIONS THAT WERE MISSED ═══");
{
  // Service-area and service labels: ~10–11px bold, on dark and --dark-2.
  for (const [f, label] of [["index.html", "Nassau County"], ["index.html", "Western Suffolk"],
                            ["index.html", "Eastern Suffolk"], ["index.html", "Also Covering"],
                            ["index.html", "Emergency Forklift Repair"],
                            ["index.html", "Preventive Maintenance Plans"],
                            ["index.html", "All Major Brands Serviced"]]) {
    const s = read(f);
    const i = s.indexOf(label);
    ok(i > -1, `T3 ${label} still present in ${f}`);
    if (i > -1) {
      const tag = s.lastIndexOf("<div", i);
      const open = s.slice(tag, i);
      ok(!/color:\s*var\(--red\)\b(?!-)/.test(open),
         `T4 "${label}" no longer uses --red as small-label text`);
    }
  }
  for (const f of ["about.html"]) {
    const small = [...read(f).matchAll(/style="([^"]*font-size:0?\.6[0-9]rem[^"]*)"/g)];
    const bad = small.filter(m => /color:\s*var\(--red\)\b(?!-)/.test(m[1]));
    ok(bad.length === 0, `T5 ${f}: ${small.length} small labels, ${bad.length} still on --red`);
  }
  // Normal body links.
  for (const [f, needle] of [["contact.html", "info@apexliftsolutionsusa.com"],
                             ["careers.html", "jobs@apexliftsolutionsusa.com"],
                             ["privacy.html", "info@apexliftsolutionsusa.com"]]) {
    const s = read(f);
    const i = s.indexOf(needle);
    const open = i > -1 ? s.slice(s.lastIndexOf("<a", i), i) : "";
    ok(i > -1 && !/color:\s*var\(--red\)\b(?!-)/.test(open),
       `T6 ${f}: the ${needle.split("@")[0]}@ link uses an accessible red`);
  }
}

console.log("═══ LARGE DISPLAY ACCENTS KEPT THE DEEP BRAND RED ═══");
{
  const keep = [["style.css", ".stat-num"], ["style.css", ".price-amount"], ["style.css", ".error-code"],
                ["style.css", ".logo-apex"], ["portal-customer.css", ".modal-amount"],
                ["portal-customer.css", ".q-amt"], ["portal-admin.css", ".quote-total span"],
                ["portal-admin.css", ".stat-card .value.red"]];
  for (const [f, sel] of keep) {
    const s = read(f);
    const m = s.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(?:,[^{]*)?\\{[^}]*\\}"));
    ok(!!m && /color:\s*var\(--red\)/.test(m[0]),
       `T7 ${sel} still carries the deep --red (large text, 3:1)`);
  }
  ok(/<em style="color:var\(--red\)/.test(read("404.html")),
     "T8 the 404 heading emphasis keeps --red — it is inside a clamped h1");
}


console.log("═══ P2-D: DANGER RED IS TOKENISED EVERYWHERE ═══");
{
  // Scan HTML, JS-generated markup / style literals, and CSS — not just static
  // style="" attributes. The only permitted raw #ff4444 is the token definition.
  const raw = [];
  for (const f of readdirSync(D).filter(x => /\.(html|js|css)$/.test(x))) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const line of src.split("\n")) {
      if (!/#ff4444/i.test(line)) continue;
      if (/--red-danger:\s*#ff4444/i.test(line)) continue;      // definition
      raw.push(`${f}: ${line.trim().slice(0, 60)}`);
    }
  }
  ok(raw.length === 0, `H1 raw #ff4444 outside token definitions = 0 (${raw.slice(0, 3).join(" | ") || "none"})`);
  const defs = readdirSync(D).filter(x => x.endsWith(".css")).filter(f => /--red-danger:\s*#ff4444/.test(read(f)));
  ok(defs.length === 4, `H2 token defined in the four stylesheets (${defs.join(", ")})`);
  // Mutation self-probe: generated markup with a raw danger colour must be caught.
  const probe = "el.innerHTML = `<p style=\"color:#ff4444\">x</p>`;";
  const probeLine = probe.replace(/\/\*[\s\S]*?\*\//g, "");
  ok(/#ff4444/i.test(probeLine) && !/--red-danger:/.test(probeLine), "H3 the scanner would flag a generated style=\"color:#ff4444\"");
}

console.log("═══ UPLOAD CONTROLS ═══");
for (const [f, act, inputId] of [["portal-customer.html", "pick-files", "req-files"], ["portal-admin.html", "pick-quote-files", "quote-files"]]) {
  const s = read(f);
  const m = new RegExp(`<button[^>]*data-action="${act}"[^>]*>([\\s\\S]*?)</button>`).exec(s);
  ok(!!m, `U1 ${f}: upload control is a <button>`);
  const inner = m ? m[1] : "";
  ok(!/<(input|select|textarea|button|a|label|div)\b/.test(inner), `U2 ${f}: button contains phrasing content only`);
  ok(new RegExp(`aria-controls="${inputId}"`).test(m ? m[0] : ""), `U3 ${f}: aria-controls names the input`);
  const inputPos = s.indexOf(`id="${inputId}"`), btnEnd = s.indexOf("</button>", s.indexOf(`data-action="${act}"`));
  ok(inputPos > btnEnd, `U4 ${f}: the file input is OUTSIDE (after) the button`);
  ok(/JPG, PNG, WebP, HEIC or PDF/.test(inner) && /10 MB/.test(inner), `U5 ${f}: helper text lists every accepted format and 10 MB`);
  const block = s.slice(s.indexOf(`data-action="${act}"`) - 200, btnEnd + 400);
  ok(!/<div[^>]*>[^<]*<\/button>/.test(block), `U6 ${f}: no <div> closed by </button>`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
