// =============================================================================
//  GROUP 5 — self-hosted Supabase + fonts
//  Run: node tests/PHASE_G5_VENDOR_TESTS.mjs
// =============================================================================
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { createHash } from "crypto";
import vm from "vm";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const D = new URL("../docs/", import.meta.url).pathname;
const html = f => readFileSync(D + f, "utf8");
const pages = readdirSync(D).filter(f => f.endsWith(".html"));

console.log("═══ SUPABASE VENDOR ARTIFACT ═══");
const VP = D + "vendor/supabase-js-2.116.0.umd.js";
const EXPECT = "84ee9bf45695c1dd3ba1595b6bcfb0f09672434631351ffc8ebe9140545d5ff6";
ok(existsSync(VP), "S1 vendored artifact exists");
const bytes = readFileSync(VP);
const sha = createHash("sha256").update(bytes).digest("hex");
ok(sha === EXPECT, `S2 SHA-256 matches the approved value (${sha.slice(0, 16)}…)`);
ok(bytes.length === 218318, `S3 byte length as staged (${bytes.length})`);
{
  const ctx = vm.createContext({
    console, setTimeout: () => {}, setInterval: () => {}, clearInterval: () => {},
    clearTimeout: () => {}, fetch: () => {}, Headers: class {}, TextEncoder, TextDecoder,
    URL, URLSearchParams, crypto: (await import("crypto")).webcrypto, navigator: {},
    // The SDK builds a realtime client during createClient() and needs a
    // WebSocket constructor. Node's VM context has none; a stub is enough to
    // prove the artifact constructs, which is what this test is about.
    WebSocket: class { constructor() {} close() {} send() {} addEventListener() {} }
  });
  vm.runInContext(bytes.toString("utf8"), ctx);
  ok(typeof ctx.supabase === "object", "S4 evaluating the artifact defines the global `supabase`");
  ok(typeof ctx.supabase.createClient === "function", "S5 supabase.createClient is a function");
  const c = ctx.supabase.createClient("https://x.supabase.co", "anon");
  ok(typeof c.auth === "object" && typeof c.from === "function",
     "S6 createClient() returns a client with .auth and .from");
}

console.log("\n═══ NO CDN DEPENDENCY REMAINS ═══");
{
  const offenders = pages.filter(p => /cdn\.jsdelivr\.net|@supabase\/supabase-js@2/.test(html(p)));
  ok(offenders.length === 0, `S7 no page references jsDelivr or a floating @2 (${offenders.join(",") || "none"})`);
  const users = pages.filter(p => /vendor\/supabase-js-2\.116\.0\.umd\.js/.test(html(p)));
  ok(users.length === 5, `S8 the five Supabase-using pages load the local artifact (${users.length})`);
  ok(users.every(p => /portal/.test(p)), `S9 they are all portal/auth pages (${users.join(", ")})`);
}

console.log("\n═══ SCRIPT EXECUTION ORDER ═══");
// Only portal-admin and portal-forgot use portal-data.js; portal-customer.js
// and portal-login.js construct their own client. The invariant that actually
// matters is that the SDK loads before ANY script that consumes it.
for (const p of pages.filter(p => /vendor\/supabase/.test(html(p)))) {
  const s = html(p);
  const order = [...s.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);
  const iSb = order.findIndex(x => x.includes("vendor/supabase"));
  const consumers = order
    .map((x, i) => ({ x, i }))
    .filter(o => /^(portal-data|portal-admin|portal-customer|portal-login|portal-forgot)\.js$/.test(o.x));
  ok(iSb === 0, `O1 ${p}: the SDK is the first script on the page`);
  ok(consumers.every(c => c.i > iSb),
     `O2 ${p}: every consumer loads after it (${consumers.map(c => c.x).join(", ") || "none"})`);
  ok(!/vendor\/supabase[^>]*\basync\b/.test(s), `O3 ${p}: the vendor script is not async`);
  if (/portal-data\.js/.test(s)) {
    const iData = order.findIndex(x => x === "portal-data.js");
    const iApp = order.findIndex(x => /portal-(admin|forgot)\.js/.test(x));
    ok(iApp === -1 || iApp > iData, `O4 ${p}: portal-data.js before the page script`);
  }
}

console.log("\n═══ SELF-HOSTED FONTS ═══");
{
  const css = readFileSync(D + "style.css", "utf8");
  const faces = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map(m => m[0]);
  ok(faces.length === 7, `F1 seven @font-face rules declared (${faces.length})`);
  ok(faces.every(f => /font-display:\s*swap/.test(f)), "F2 every face uses font-display: swap");
  const urls = [...css.matchAll(/url\('(assets\/fonts\/[^']+)'\)/g)].map(m => m[1]);
  ok(urls.length === 7, `F3 seven font URLs referenced (${urls.length})`);
  const missing = urls.filter(u => !existsSync(D + u));
  ok(missing.length === 0, `F4 every referenced font file exists (${missing.join(",") || "none missing"})`);
  ok(/'Barlow',\s*'Helvetica Neue'/.test(css), "F5 Barlow has a real fallback stack");
  ok(/'Barlow Condensed',\s*'Arial Narrow'/.test(css), "F6 Barlow Condensed has a condensed fallback");
  ok(!/font-weight:\s*500;[^}]*barlow/i.test(css), "F7 the unused Barlow 500 was not shipped");
  const total = urls.reduce((n, u) => n + statSync(D + u).size, 0);
  ok(total > 0, `F8 total self-hosted font payload ${total.toLocaleString()} bytes across 7 files`);
}
{
  const offenders = pages.filter(p => /fonts\.(googleapis|gstatic)\.com/.test(html(p)));
  ok(offenders.length === 0, `F9 no page contacts Google Fonts (${offenders.join(",") || "none"})`);
  // portal-reset.html is a bare JS redirect shim: no stylesheet, no rendered
  // text, so it needs no fonts and no preload. Every page that DOES render
  // with the site stylesheet must preload.
  const rendered = pages.filter(p => /rel="stylesheet"/.test(html(p)));
  const preloads = rendered.filter(p => /rel="preload"[^>]*woff2/.test(html(p)));
  ok(preloads.length === rendered.length,
     `F10 all ${rendered.length} rendering pages preload the two hot faces`);
  ok(rendered.every(p => /crossorigin/.test(html(p).match(/<link rel="preload"[^>]*>/)?.[0] ?? "")),
     "F11 font preloads carry crossorigin, without which they are fetched twice");
  const shim = pages.filter(p => !/rel="stylesheet"/.test(html(p)));
  ok(shim.length === 1 && shim[0] === "portal-reset.html",
     `F12 exactly one non-rendering shim page, correctly exempt (${shim.join(",")})`);
  ok(!/font|preload/.test(html("portal-reset.html")),
     "F13 the shim page loads no fonts at all");
}

console.log("\n═══ LICENSING ═══");
{
  const I = new URL("../internal-docs/", import.meta.url).pathname;
  ok(existsSync(I + "OFL-Barlow.txt"), "L1 Barlow OFL retained");
  ok(existsSync(I + "OFL-BarlowCondensed.txt"), "L2 Barlow Condensed OFL retained");
  const t = readFileSync(I + "OFL-Barlow.txt", "utf8");
  ok(/SIL Open Font License, Version 1\.1/.test(t), "L3 licence is SIL OFL 1.1");
  const css = readFileSync(D + "style.css", "utf8");
  ok(/SIL Open Font License 1\.1/.test(css) && /NOT Google's own gstatic build/.test(css),
     "L4 CSS states the licence and that these are Apex-generated derivatives");
  ok(/MIT/.test(readFileSync(new URL("../internal-docs/VENDOR_MANIFEST.md", import.meta.url).pathname, "utf8")),
     "L5 Supabase MIT licence recorded in the vendor manifest");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
