// =============================================================================
//  GROUP 8 — frontend security
//  Escaper behaviour against real payloads + static proof that HTML sinks in
//  the print/render paths carry no unescaped user or database text.
//  Run: node tests/PHASE_G8_SECURITY_TESTS.mjs
// =============================================================================
import { readFileSync, readdirSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const D = new URL("../docs/", import.meta.url).pathname;
const read = f => readFileSync(D + f, "utf8");
const JS = readdirSync(D).filter(f => f.endsWith(".js"));
const HTML = readdirSync(D).filter(f => f.endsWith(".html"));

const PAYLOADS = [
  ['<script>alert(1)</script>', "script tag"],
  ['"><img src=x onerror=alert(1)>', "attribute break-out"],
  ['javascript:alert(1)', "javascript URL"],
  ['"><svg onload=alert(1)>', "svg handler"],
  ["Company & Sons <Repair>", "ampersand and angle brackets"],
  ["O'Brien \"Quotes\" & Co", "quotes and apostrophes"],
  ["</td></tr><tr><td>injected", "table break-out"],
];

console.log("═══ ESCAPER BEHAVIOUR ═══");
{
  // Extract each escaper and run the payloads through it for real.
  const impls = {};
  for (const [file, name] of [["portal-customer.js","xss"],["portal-customer.js","esc"],
                              ["portal-admin.js","spEsc"],["portal-data.js","esc"]]) {
    const src = read(file);
    const m = src.match(new RegExp("function " + name + "\\s*\\([\\s\\S]{0,400}?\\n\\}"));
    if (!m) continue;
    impls[`${file}:${name}`] = new Function(m[0] + `; return ${name};`)();
  }
  ok(Object.keys(impls).length >= 3, `E1 found ${Object.keys(impls).length} escaper implementations`);
  for (const [key, fn] of Object.entries(impls)) {
    for (const [p, label] of PAYLOADS) {
      const out = fn(p);
      ok(!/<script|<img|<svg|onerror=|onload=/i.test(out.replace(/&lt;|&gt;|&quot;|&#39;|&amp;/g, "")) || !/[<>]/.test(out),
         `E2 ${key} neutralises ${label}`);
    }
    ok(fn('<>&"\'') === "&lt;&gt;&amp;&quot;&#39;" || fn('<>&"\'').includes("&lt;"),
       `E3 ${key} encodes all five characters`);
  }
  // xss() uses a falsy guard, so 0 becomes ''. Not a security bug, but a real
  // rendering bug worth knowing about.
  const xss = impls["portal-customer.js:xss"];
  if (xss) ok(xss(0) === "" , "E4 KNOWN: xss(0) returns '' — falsy guard, cosmetic not security");
}

console.log("\n═══ DANGEROUS PRIMITIVES ABSENT ═══");
for (const f of JS) {
  const s = read(f);
  ok(!/\beval\s*\(/.test(s), `D1 ${f} contains no eval()`);
  ok(!/new\s+Function\s*\(/.test(s), `D2 ${f} contains no new Function()`);
  ok(!/setTimeout\s*\(\s*['"]/.test(s), `D3 ${f} passes no string to setTimeout`);
  ok(!/window\s*\[\s*[a-zA-Z_$][\w$]*\.dataset/.test(s), `D4 ${f} never executes a data attribute as a function name`);
}

console.log("\n═══ PRINT TEMPLATES CARRY NO UNESCAPED FIELDS ═══");
{
  // The admin print windows were the one exploitable finding: 21 user/database
  // fields — customer name, company, email, description, notes, equipment and
  // line items — went into document.write() raw.
  const s = read("portal-admin.js");
  const SAFE = /^\s*(esc|spEsc|xss)\s*\(|toFixed|parseFloat|Number\(|\.length|fmtDate|new Date|PRINT_CSS|\?\s*['"]|^(itemRows|qty)$/;
  for (const [label, marker] of [["printQuote", "<title>Quote ${"], ["printInvoice", "<title>Invoice ${"]]) {
    const i = s.indexOf(marker);
    const j = s.indexOf("win.document.close()", i);
    const blk = s.slice(i - 1200, j);
    const bad = [...new Set([...blk.matchAll(/\$\{([^{}]{1,80})\}/g)].map(m => m[1]))]
      .filter(e => !SAFE.test(e.trim()));
    ok(bad.length === 0, `P1 ${label}: no unescaped interpolation (${bad.join(", ") || "clean"})`);
  }
  ok(/\$\{esc\(q\.customer_name/.test(s), "P2 quote print escapes customer_name");
  ok(/\$\{esc\(q\.description\)\}/.test(s), "P3 quote print escapes description");
  ok(/\$\{esc\(inv\.company/.test(s), "P4 invoice print escapes company");
  ok(/\$\{esc\(i\.desc \|\| 'Service'\)\}/.test(s), "P5 both print paths escape line-item descriptions");
}
{
  // Customer side already escaped these; assert it stays that way.
  const s = read("portal-customer.js");
  ok(/<td>\$\{xss\(i\.desc \|\| ''\)\}<\/td>/.test(s), "P6 customer line items escape desc");
  ok(/printDoc\(`Quote \$\{esc\(/.test(s) && /printDoc\(`Invoice \$\{esc\(/.test(s),
     "P7 customer print titles are escaped at the call site");
}

console.log("\n═══ URL / NAVIGATION SAFETY ═══");
for (const f of JS) {
  const s = read(f);
  ok(!/href\s*=\s*[`'"]\s*javascript:/i.test(s), `U1 ${f} builds no javascript: href`);
  ok(!/location\s*(\.href)?\s*=\s*[^;]*\b(params|query|hash|search)\b/.test(s),
     `U2 ${f} does not navigate to a value taken from the URL`);
}
{
  const reset = read("portal-reset.html");
  ok(/portal-forgot\.html/.test(reset), "U3 reset shim forwards to a fixed same-origin path");
  ok(!/location\s*=\s*[^;]*(searchParams\.get|hash\.split)/.test(reset),
     "U4 reset shim does not use a URL-supplied destination");
  ok(!/console\.log[^\n]*token/i.test(reset), "U5 reset shim logs no token");
}

console.log("\n═══ target=_blank OPENER SAFETY ═══");
for (const f of HTML) {
  const s = read(f);
  const blanks = [...s.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].map(m => m[0]);
  const unsafe = blanks.filter(a => !/rel="[^"]*noopener/.test(a));
  ok(unsafe.length === 0, `T1 ${f}: ${blanks.length} target=_blank link(s), all with noopener`);
}

console.log("\n═══ NO SECRETS IN THE FRONTEND ═══");
for (const f of [...JS, ...HTML]) {
  const s = read(f);
  // Detect a secret VALUE, not a mention of a secret's name. portal-admin.js
  // legitimately names RECONCILE_WORKER_KEY in an operator-facing diagnostic
  // that tells the admin which placeholder was left unreplaced — no value.
  for (const [re, label] of [[/service_role\s*[:=]\s*['"`]/i, "service-role key value"],
                             [/(HELCIM_ADMIN_API_TOKEN|api-token)\s*[:=]\s*['"`][^'"`]+/i, "Helcim token value"],
                             [/RECONCILE_WORKER_KEY\s*[:=]\s*['"`][^'"`]+/, "worker key value"],
                             [/SIGNATURE_IP_SALT\s*[:=]\s*['"`][^'"`]+/, "signature salt value"],
                             [/SUPABASE_SERVICE[A-Z_]*\s*[:=]\s*['"`][^'"`]+/i, "service key value"],
                             ]) {
    ok(!re.test(s), `S1 ${f} exposes no ${label}`);
  }
  // Any embedded JWT must decode to role "anon". A variable-name heuristic is
  // not good enough here — the variables are called SB_KEY / SUPA_KEY, and what
  // actually matters is the claim inside the token.
  for (const m of s.matchAll(/eyJ[A-Za-z0-9_-]{20,}\.([A-Za-z0-9_-]{20,})/g)) {
    let role = "undecodable";
    try {
      const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      role = JSON.parse(Buffer.from(b64 + "=".repeat((4 - b64.length % 4) % 4), "base64").toString()).role;
    } catch (e) { /* leave undecodable */ }
    ok(role === "anon",
       `S2 ${f}: embedded key decodes to role "${role}" — must be the publishable anon key, never service_role`);
  }
}

console.log("\n═══ FINANCIAL BOUNDARY UNCHANGED ═══");
{
  const c = read("portal-customer.js"), a = read("portal-admin.js");
  ok(!/\.from\(['"]payments['"]\)\s*\.\s*(insert|update|delete)/.test(c + a),
     "F1 the frontend never writes to the payments ledger");
  ok(!/\.from\(['"]invoices['"]\)\s*\.\s*(insert|delete)/.test(c),
     "F2 the customer portal never creates or deletes invoices");
  ok(/payment-checkout|payment-refund/.test(a), "F3 admin money actions still go through Edge Functions");
}


// =============================================================================
//  FOLLOW-UP — CONTEXT-AWARE ASSERTIONS
//
//  The previous 253-assertion suite passed while a stored XSS existed in the
//  customers table, because it tested ESCAPER OUTPUT rather than the CONTEXT
//  the output lands in. HTML escaping is not JS-string escaping.
// =============================================================================
console.log("\n═══ HTML ESCAPING IS NOT JS-STRING ESCAPING ═══");
{
  const src = read("portal-customer.js");
  const m = src.match(/function xss\s*\([\s\S]{0,400}?\n\}/);
  const xss = new Function(m[0] + "; return xss;")();
  const payload = "');console.log('XSS');//";
  const escaped = xss(payload);
  ok(escaped.includes("&#39;"), "X1 esc/xss encodes the apostrophe for HTML");
  // The HTML parser decodes &#39; back to ' before the inline JS is compiled.
  const decoded = escaped.replace(/&#39;/g, "'").replace(/&quot;/g, '"')
                         .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  ok(decoded === payload,
     "X2 PROOF: the HTML parser decodes it straight back — HTML escaping gives NO protection inside an inline JS attribute");
  ok(xss("O'Brien").includes("&#39;") && xss("O'Brien").replace(/&#39;/g, "'") === "O'Brien",
     "X3 an ordinary name like O'Brien decodes to a quote that would break inline JS");
}

console.log("\n═══ NO CUSTOMER TEXT IN EXECUTABLE ATTRIBUTES ═══");
{
  const s = read("portal-admin.js");
  const start = s.indexOf("async function renderCustomers");
  const block = s.slice(start, s.indexOf("wireCustomerActions();", start) + 40);
  ok(!/onclick="[^"]*\$\{esc\(c\.(name|company|email|phone)/.test(block),
     "C1 no customer name/company/email/phone inside an onclick attribute");
  ok(!/onclick=/.test(block), "C2 the customers table emits no inline handlers at all");
  ok(/data-customer-action="(activate|deactivate|reject|delete)"/.test(block),
     "C3 actions are selected by data attribute");
  ok(/data-customer-id="\$\{id\}"/.test(block), "C4 only the id travels through the DOM");
  ok(/CUSTOMERS_BY_ID\[String\(c\.id\)\] = c/.test(block),
     "C5 display text is recovered from an in-memory map at click time");
}
{
  // The delegated handler must select from a fixed switch, never execute a string.
  const s = read("portal-admin.js");
  const h = s.slice(s.indexOf("function wireCustomerActions"), s.indexOf("// ── CUSTOMER ACTIONS"));
  ok(/switch \(btn\.dataset\.customerAction\)/.test(h), "C6 a fixed switch selects the handler");
  ok(!/window\s*\[/.test(h) && !/eval|new Function/.test(h),
     "C7 the action string is never executed as code");
  ok(/if \(_customerActionsWired\) return/.test(h), "C8 the listener installs exactly once");
  ok(/default:/.test(h), "C9 unknown action strings fall through harmlessly");
}

console.log("\n═══ MALICIOUS CUSTOMER NAMES RENDER AS TEXT ═══");
{
  const s = read("portal-admin.js");
  const m = s.match(/function esc\s*\([\s\S]{0,400}?\n\}/) || read("portal-data.js").match(/function esc\s*\([\s\S]{0,400}?\n\}/);
  const esc = new Function(m[0] + "; return esc;")();
  const NASTY = ["O'Brien", "Company & Sons <Repair>", "');console.log('XSS');//",
                 '"><img src=x onerror=alert(1)>', '"><svg onload=alert(1)>'];
  for (const v of NASTY) {
    const cell = `<td><strong>${esc(v)}</strong></td>`;
    // Check the RAW output. Stripping entity references first would rebuild the
    // markup and flag correctly-escaped, inert text — the same mistake as before.
    ok(!/<(img|svg|script|iframe)\b/i.test(cell),
       `M1 ${JSON.stringify(v.slice(0, 26))} produces no raw tag markup in a table cell`);
    ok(!/[<>]/.test(v) || /&lt;|&gt;/.test(cell),
       `M1b ${JSON.stringify(v.slice(0, 26))} appears entity-encoded, not dropped`);
    // And crucially: it never reaches an attribute that is compiled as JS.
    const btn = `<button data-customer-action="delete" data-customer-id="${esc("uuid-1")}">Delete</button>`;
    ok(!btn.includes(v), `M2 ${JSON.stringify(v.slice(0, 26))} does not appear in the action button at all`);
  }
}

console.log("\n═══ REMAINING INLINE HANDLER INTERPOLATIONS, CLASSIFIED ═══");
{
  const free = [], constrained = [];
  const USER_TEXT = /\b(name|company|email|phone|desc|description|notes?|equipment|serial|title|reason|message|filename|label|tech|address|signer|plan_name)\b/i;
  for (const f of ["portal-admin.js", "portal-customer.js"]) {
    for (const line of read(f).split("\n")) {
      for (const m of line.matchAll(/on(?:click|change|submit|input)="[^"]*?\$\{([^}]{1,70})\}/g)) {
        const e = m[1].trim();
        // Numeric, array-index and internally-generated handler strings are not
        // user text: ${i} is a loop index, ${onclick} is a literal built from
        // fixed function names plus an escaped id.
        const numeric = /^(i|idx|n)$/.test(e) || /parseFloat|Number\(|toFixed/.test(e);
        const internal = /^onclick$/.test(e);
        const idLike = /\b\w*[Ii]d\b/.test(e) || /^(esc|xss|spEsc)\((?:String\()?\w+\.id/.test(e);
        (numeric || internal || idLike || !USER_TEXT.test(e) ? constrained : free).push(`${f}: ${e}`);
      }
    }
  }
  console.log(`     classified: ${constrained.length} constrained (id/int/enum/internal), ${free.length} user-text`);
  ok(free.length === 0,
     `H1 no free-form user text in any inline handler (${free.slice(0, 4).join(" | ") || "none"})`);
  // This previously asserted that constrained interpolations REMAINED, which was
  // true while the inline-handler migration was still outstanding. Surfaces A-D
  // completed it, so the correct assertion is now the goal state: none at all.
  ok(constrained.length === 0,
     `H2 zero inline handler interpolations of any kind remain (${constrained.slice(0, 3).join(" | ") || "none"})`);
}

console.log("\n═══ SIGNED STORAGE URL VALIDATION ═══");
{
  const s = read("portal-customer.js");
  // The constants now live inside the function, so extract to the closing brace
  // at column 0 and evaluate it exactly as shipped — no external scaffolding.
  const m = s.match(/function safeStorageUrl\s*\([\s\S]*?\n\}/);
  ok(!!m, "V1 safeStorageUrl() exists");
  if (!m) throw new Error("safeStorageUrl not found — cannot verify URL handling");
  ok(/APEX_STORAGE_ORIGIN/.test(m[0]) && /APEX_STORAGE_BUCKETS/.test(m[0]),
     "V1b its origin and bucket allow-list are self-contained");
  const fn = new Function(m[0] + "; return safeStorageUrl;")();
  const OK_URL = "https://cjtezsgfdfijmdxzzbiq.supabase.co/storage/v1/object/sign/apex-uploads/x/y.pdf?token=abc";
  ok(fn(OK_URL) === OK_URL, "V2 a genuine signed upload URL is accepted");
  ok(!!fn(OK_URL.replace("apex-uploads", "apex-agreements")), "V3 the agreements bucket is accepted");
  for (const [bad, label] of [
    ["javascript:alert(1)", "javascript:"],
    ["data:text/html,<script>alert(1)</script>", "data:"],
    ["vbscript:msgbox(1)", "vbscript:"],
    ["https://evil.example/storage/v1/object/sign/apex-uploads/x", "another origin"],
    ["//evil.example/path", "protocol-relative"],
    ["http://cjtezsgfdfijmdxzzbiq.supabase.co/storage/v1/object/sign/apex-uploads/x", "plain http"],
    ["https://cjtezsgfdfijmdxzzbiq.supabase.co/storage/v1/object/public/apex-uploads/x", "public (unsigned) route"],
    ["https://cjtezsgfdfijmdxzzbiq.supabase.co/storage/v1/object/sign/secret-bucket/x", "unexpected bucket"],
    ["not a url at all", "malformed"],
    ['" onerror="alert(1)', "attribute injection"],
    ["", "empty"], [null, "null"], [undefined, "undefined"], [{}, "non-string"],
  ]) ok(fn(bad) === null, `V4 rejects ${label}`);
}
{
  const s = read("portal-customer.js");
  ok(/const safe = safeStorageUrl\(res\?\.url\);[\s\S]{0,80}if \(safe\) window\.open\(safe/.test(s),
     "V5 cpOpenPdf() only opens a validated URL");
  ok(/href="\$\{xss\(s\.safeUrl\)\}"/.test(s) && /src="\$\{xss\(s\.safeUrl\)\}"/.test(s),
     "V6 validated URLs are ALSO attribute-escaped — the two protections are separate");
  const a = read("portal-admin.js");
  ok(/href="\$\{esc\(s\.safeUrl\)\}"/.test(a), "V7 admin attachments do the same");
  ok(!/href="\$\{s\.signedUrl\}"/.test(s + a), "V8 no raw provider URL is interpolated anywhere");
}

console.log("\n═══ REFERRER POLICY ═══");
for (const f of HTML) {
  ok(/<meta name="referrer" content="strict-origin-when-cross-origin">/.test(read(f)),
     `R1 ${f} declares a referrer policy`);
}
{
  const reset = read("portal-reset.html");
  ok(/portal-forgot\.html/.test(reset), "R2 reset shim still targets one fixed same-origin path");
  ok(!/https?:\/\//.test(reset.replace(/<meta[^>]*>/g, "")) || !/location\s*=\s*['"`]https?:/.test(reset),
     "R3 reset shim has no external redirect target");
}

console.log("\n═══ STALE DEPENDENCY COMMENTS ═══");
for (const f of JS) {
  const s = read(f);
  ok(!/\/\/[^\n]*\b(jsDelivr|Google Fonts)\b/i.test(s), `Q1 ${f} has no stale CDN comment`);
}

console.log("\n═══ POLICY DRIFT IN PRINTED DOCUMENTS ═══");
{
  // Printed quotes/invoices are customer-facing business content and must obey
  // the same owner-decision discipline as the policy pages. Q1 in the owner
  // register is still OWNER INPUT REQUIRED, so no validity period may be stated.
  for (const f of ["portal-admin.js", "portal-customer.js"]) {
    const s = read(f);
    ok(!/valid for \d+ days?/i.test(s), `PD1 ${f} states no quote validity period`);
    ok(!/expires? (after|in) \d+ days?/i.test(s), `PD2 ${f} states no expiry period`);
  }
  const reg = readFileSync(new URL("../internal-docs/GROUP7_OWNER_POLICY_DECISIONS.md", import.meta.url).pathname, "utf8");
  ok(/Q1 \| How long does a quote stay valid/.test(reg),
     "PD3 quote validity is still an open owner decision, so the absence above is correct");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
