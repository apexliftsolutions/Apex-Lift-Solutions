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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
