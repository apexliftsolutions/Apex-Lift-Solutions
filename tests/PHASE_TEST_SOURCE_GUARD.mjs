// =============================================================================
//  Test source-of-truth guard
//
//  docs/ is the GitHub Pages publishing root and the only frontend that ships.
//  Two suites were reading portal JS from the repository root — the frozen
//  legacy copies — so they asserted against files nobody deploys. That is how a
//  stale DELETE expectation survived a full contract change.
//
//  This makes the rule enforceable instead of remembered.
// =============================================================================
import { readdirSync, readFileSync, existsSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const ROOT = new URL("../", import.meta.url).pathname;

const FRONTEND = /(portal-[a-z]+|main|pagination|consent|a11y|public-forms|index-tracking)\.(js|css)|(index|about|services|plans|contact|careers|privacy|terms|refund-policy|cookie-policy|accessibility|404|portal-[a-z]+)\.html/;

// Canonical frontend inventory. Any of these names resolved against the repo
// root instead of docs/ is a root-frontend read, whatever syntax is used.
const NAME = String.raw`(?:portal-(?:admin|customer|login|forgot|reset|data|auth)|main|pagination|consent|a11y|public-forms|index-tracking|style|index|about|services|plans|contact|careers|privacy|terms|refund-policy|cookie-policy|accessibility|404)\.(?:js|css|html)`;
const Q = String.raw`['"\x60]`;   // quote or backtick

/**
 * Classify one source expression: "root" for a root-frontend read, "docs" for a
 * docs/-based read, null otherwise. Directly testable — the guard probes itself
 * with representative expressions, so a scanner gap cannot pass silently.
 */
export function classifyRead(expr) {
  if (new RegExp(String.raw`docs[/'"\x60, ]+[^'"\x60]*?` + NAME).test(expr)) return "docs";
  if (new RegExp(Q + String.raw`\.\./docs/[^'"\x60]*` + NAME).test(expr)) return "docs";
  const forms = [
    String.raw`\b(?:ROOT|root|BASE|REPO)\s*\+\s*` + Q + NAME + Q,                                   // ROOT + 'x.js'
    String.raw`\b(?:join|resolve)\(\s*(?:ROOT|root|BASE|REPO|__dirname)\s*,\s*` + Q + NAME + Q,       // join(ROOT,'x.js')
    String.raw`new URL\(\s*` + Q + String.raw`\.\./` + NAME + Q,                                       // new URL('../x.js')
    String.raw`readFileSync\(\s*` + Q + NAME + Q,                                                        // readFileSync('x.js')
  ];
  for (const f of forms) if (new RegExp(f).test(expr)) return "root";
  return null;
}

console.log("═══ GUARD SELF-PROBES (the classifier must catch each form) ═══");
{
  const mustReject = [
    "readFileSync(ROOT + 'portal-admin.js', 'utf8')",
    "readFileSync(root + 'portal-customer.js')",
    "join(ROOT, 'portal-login.js')",
    "resolve(ROOT, 'style.css')",
    "new URL('../portal-admin.js', import.meta.url)",
    "readFileSync('index.html')",
    "ROOT + `main.js`",
  ];
  const mustAllow = [
    "readFileSync(ROOT + 'docs/portal-admin.js', 'utf8')",
    "join(ROOT, 'docs', 'portal-admin.js')",
    "new URL('../docs/portal-admin.js', import.meta.url)",
    "readFileSync(D + 'portal-admin.js')   // D = ../docs/",
    "readFileSync(ROOT + 'supabase/functions/x/index.ts')",
  ];
  for (const e of mustReject) ok(classifyRead(e) === "root", `SP-reject ${e}`);
  for (const e of mustAllow)  ok(classifyRead(e) !== "root", `SP-allow  ${e}`);
}

console.log("\n═══ EVERY SUITE READS FRONTEND FROM docs/ ═══");
{
  const suites = readdirSync(ROOT + "tests").filter(f => /\.(mjs|cjs)$/.test(f) && f !== "PHASE_TEST_SOURCE_GUARD.mjs");
  const offenders = [];
  for (const f of suites) {
    const src = readFileSync(ROOT + "tests/" + f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");   // strip comments
    // A helper like `const D = new URL("../docs/", …)` makes bare names docs-based.
    const docsHelper = /new URL\(["'`]\.\.\/docs\/["'`]/.test(src);
    for (const line of src.split("\n")) {
      const c = classifyRead(line);
      if (c === "root") {
        // Bare `read('x.js')` through a docs helper is fine; a literal root form never is.
        if (docsHelper && /^\s*(?:const|let|var|ok\(|for\b|\}|\)|\/)/.test(line) && !/ROOT|root\b|\.\.\//.test(line)) continue;
        offenders.push(`${f}: ${line.trim().slice(0, 70)}`);
      }
    }
  }
  ok(offenders.length === 0, `G1 no suite reads a frontend file from the repository root (${offenders.slice(0, 3).join(" | ") || "none"})`);
  ok(suites.length >= 15, `G2 the guard inspected ${suites.length} suites`);
}

console.log("\n═══ NO MACHINE-SPECIFIC PATHS ═══");
{
  const hits = [];
  for (const d of ["tests", "tools", ".github"]) {
    for (const f of readdirSync(ROOT + d, { recursive: true })) {
      const p = ROOT + d + "/" + f;
      if (!/\.(mjs|cjs|js|yml|yaml|json)$/.test(String(f))) continue;
      try { if (/\/home\/[a-z]+\//.test(readFileSync(p, "utf8"))) hits.push(d + "/" + f); } catch {}
    }
  }
  if (/\/home\/[a-z]+\//.test(readFileSync(ROOT + "package.json", "utf8"))) hits.push("package.json");
  ok(hits.length === 0, `G0 no absolute /home/<user>/ path in tests, tools, CI or package.json (${hits.join(", ") || "none"})`);
}

console.log("\n═══ docs/ IS CLEAN AS A PUBLISHING ROOT ═══");
{
  const bad = [];
  const walk = (d, rel = "") => {
    for (const e of readdirSync(ROOT + d, { withFileTypes: true })) {
      const p = rel + e.name;
      if (e.isDirectory()) { walk(d + e.name + "/", p + "/"); continue; }
      if (/\.(sql|md|mjs|cjs|ts|env|key|pem|log)$/.test(e.name)) bad.push(p);
    }
  };
  walk("docs/");
  ok(bad.length === 0, `G3 docs/ contains no source, test or doc artefacts (${bad.slice(0, 3).join(", ") || "none"})`);
  ok(!existsSync(ROOT + "docs/.build"), "G4 no build output inside the publishing root");
  ok(existsSync(ROOT + "docs/CNAME") && existsSync(ROOT + "docs/.nojekyll"),
     "G5 docs/ still carries the files GitHub Pages needs");
  const gi = existsSync(ROOT + ".gitignore") ? readFileSync(ROOT + ".gitignore", "utf8") : "";
  ok(/tests\/\.build/.test(gi), "G6 the derived build directory is gitignored");
  ok(/node_modules/.test(gi), "G7 node_modules is gitignored");
}

console.log("\n═══ CONVERSION EVENTS ARE DISTINCT AND CENTRALISED ═══");
{
  const pf = readFileSync(ROOT + "docs/public-forms.js", "utf8");
  const it = readFileSync(ROOT + "docs/index-tracking.js", "utf8");
  const mj = readFileSync(ROOT + "docs/main.js", "utf8");
  ok(/attemptEvent: 'request_submit_attempt', successEvent: 'request_submit'/.test(pf), "C1 request_service: attempt + success declared in public-forms.js");
  ok(/attemptEvent: 'job_application_submit_attempt', successEvent: 'job_application_submit'/.test(pf), "C2 careers: its own attempt + success");
  ok(!/track\('request_submit/.test(it) && !/addEventListener\('submit'/.test(it), "C3 index-tracking.js no longer hooks form submit");
  ok(!/quote_request_submit|job_application_submit/.test(mj), "C4 main.js no longer emits submit-time conversion events");
  ok(!/APEX_TRACK/.test(pf + it + mj), "C5 no APEX_TRACK stub anywhere");
  const idx = readFileSync(ROOT + "docs/index.html", "utf8");
  ok(!/<form[^>]*data-track=/.test(idx), "C6 no form element carries data-track");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
